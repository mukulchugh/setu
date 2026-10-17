import { afterEach, describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSpansDrafts } from './spans-drafts.js';
import { openSpansStore } from './spans-store.js';
import {
  listSpansWorkflows,
  previewSpansWorkflow,
  SPANS_WORKFLOW_CATALOG,
  SPANS_WORKFLOW_LIMITS,
  verifySpansWorkflowPreview,
} from './spans-workflows.js';

const slotNamePattern = /^[a-z][a-z0-9_]{0,31}$/;
const shellCharacters = /[`$|&;<>]/;
const shellCommands =
  /\b(bash|bun|chmod|curl|git|npm|pnpm|rm|sh|ssh|sudo|wget)\b/i;
const engineeringWords = /\b(build|staging|tests?)\b/i;
const digestPattern = /^sha256:[0-9a-f]{64}$/;
const sideEffectApis = /child_process|Bun\.spawn|process\.env|fetch\(/;

const roots = new Set();

afterEach(() => {
  for (const root of roots) {
    fs.rmSync(root, { force: true, recursive: true });
    roots.delete(root);
  }
});

function fixture() {
  const root = fs.mkdtempSync(join(tmpdir(), 'setu-spans-workflows-'));
  roots.add(root);
  const store = openSpansStore({ root });
  return { drafts: createSpansDrafts({ store }), root, store };
}

function template(id) {
  return SPANS_WORKFLOW_CATALOG.find((item) => item.id === id);
}

function sampleValues(item) {
  return Object.fromEntries(
    item.placeholders.map((slot) => [slot.name, `Sample ${slot.name} value`])
  );
}

function requestFor(item, overrides = {}) {
  return {
    owner: 'codex',
    runId: `run-${item.id}`,
    substitutions: sampleValues(item),
    templateId: item.id,
    templateVersion: item.version,
    ...overrides,
  };
}

function snapshotRoot(root) {
  return fs
    .readdirSync(root)
    .sort()
    .map((name) => `${name}:${fs.statSync(join(root, name)).size}`);
}

const INVALID = 'SPANS_WORKFLOW_INVALID';

describe('workflow catalog', () => {
  test('is frozen, versioned, and covers engineering and non-code kinds', () => {
    expect(Object.isFrozen(SPANS_WORKFLOW_CATALOG)).toBe(true);
    const ids = SPANS_WORKFLOW_CATALOG.map((item) => item.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(
      [...new Set(SPANS_WORKFLOW_CATALOG.map((item) => item.kind))].sort()
    ).toEqual(['business', 'engineering', 'research', 'triage']);
    for (const item of SPANS_WORKFLOW_CATALOG) {
      expect(Number.isSafeInteger(item.version) && item.version >= 1).toBe(
        true
      );
      expect(item.spans.length).toBeGreaterThan(0);
    }
    expect(() => {
      SPANS_WORKFLOW_CATALOG[0].goal = 'changed';
    }).toThrow();
  });

  test('declares every placeholder exactly once, uses each one, and bounds its length', () => {
    for (const item of SPANS_WORKFLOW_CATALOG) {
      const names = item.placeholders.map((slot) => slot.name);
      expect(new Set(names).size).toBe(names.length);
      for (const slot of item.placeholders) {
        expect(slot.name).toMatch(slotNamePattern);
        expect(slot.maxLength).toBeGreaterThanOrEqual(1);
        expect(slot.maxLength).toBeLessThanOrEqual(
          SPANS_WORKFLOW_LIMITS.placeholderLength
        );
      }
      const text = [item.goal, ...item.spans.map((span) => span.title)];
      const used = text.flatMap((value) =>
        [...value.matchAll(/\{\{([a-z][a-z0-9_]{0,31})\}\}/g)].map(
          (match) => match[1]
        )
      );
      expect([...new Set(used)].sort()).toEqual([...names].sort());
      expect(text.join('\n').split('{{').length - 1).toBe(used.length);
      expect(
        JSON.stringify(item.spans.map((span) => span.acceptance))
      ).not.toContain('{{');
    }
  });

  test('keeps template text free of ambient commands and non-code checks', () => {
    const text = JSON.stringify(SPANS_WORKFLOW_CATALOG);
    expect(text).not.toMatch(shellCharacters);
    expect(text).not.toMatch(shellCommands);
    const nonCode = SPANS_WORKFLOW_CATALOG.filter(
      (item) => item.kind !== 'engineering'
    );
    expect(nonCode.length).toBeGreaterThan(0);
    expect(JSON.stringify(nonCode)).not.toMatch(engineeringWords);
  });

  test('lists fresh metadata that cannot change the catalog', () => {
    const list = listSpansWorkflows();
    expect(list.map((item) => item.id)).toEqual(
      SPANS_WORKFLOW_CATALOG.map((item) => item.id)
    );
    list[0].title = 'Changed';
    list[0].placeholders[0].name = 'changed';
    expect(SPANS_WORKFLOW_CATALOG[0].title).not.toBe('Changed');
    expect(SPANS_WORKFLOW_CATALOG[0].placeholders[0].name).not.toBe('changed');
  });
});

describe('workflow previews in the real draft store', () => {
  test('accepts every template preview, replays it, and verifies its digest', () => {
    const { drafts, store } = fixture();
    try {
      for (const item of SPANS_WORKFLOW_CATALOG) {
        const input = requestFor(item);
        const preview = previewSpansWorkflow(input);
        expect(preview.ok).toBe(true);
        expect(preview.previewOnly).toBe(true);
        expect(
          verifySpansWorkflowPreview({ ...input, digest: preview.digest }).ok
        ).toBe(true);

        const result = drafts.createRun(preview.draft);
        expect(result).toMatchObject({
          generation: 0,
          ok: true,
          replayed: false,
        });
        expect(result.run.goal).toBe(preview.draft.goal);
        expect(Object.keys(result.run.spans).sort()).toEqual(
          preview.draft.spans.map((span) => span.spanId).sort()
        );
        expect(drafts.createRun(preview.draft)).toMatchObject({
          ok: true,
          replayed: true,
        });
        expect(
          store
            .readEvents({ runId: preview.draft.runId })
            .events.map((event) => event.type)
        ).toEqual(['spans.plan.created']);
      }
      expect(store.listRuns().runs).toHaveLength(SPANS_WORKFLOW_CATALOG.length);
    } finally {
      store.close();
    }
  });

  test('stores redacted substitutions and never the raw secret', () => {
    const { drafts, store } = fixture();
    try {
      const item = template('engineering.feature');
      const input = requestFor(item, {
        runId: 'run-secret-check',
        substitutions: {
          ...sampleValues(item),
          change: 'password=hunter2-plaintext',
        },
      });
      const preview = previewSpansWorkflow(input);
      expect(preview.ok).toBe(true);
      expect(drafts.createRun(preview.draft).ok).toBe(true);
      const stored = JSON.stringify(
        store.readEvents({ runId: 'run-secret-check' }).events
      );
      expect(stored).not.toContain('hunter2');
      expect(stored).toContain('[REDACTED]');
    } finally {
      store.close();
    }
  });

  test('keeps non-code previews without a repository target by default', () => {
    const preview = previewSpansWorkflow(
      requestFor(template('business.decision-brief'))
    );
    expect(preview.ok).toBe(true);
    expect(preview.draft.worktree).toBeNull();
    expect(preview.draft.project).toBeNull();
  });

  test('accepts maximum bounded substitutions and refuses one character more', () => {
    const { drafts, store } = fixture();
    try {
      for (const item of SPANS_WORKFLOW_CATALOG) {
        const maximal = Object.fromEntries(
          item.placeholders.map((slot) => [
            slot.name,
            'x'.repeat(slot.maxLength),
          ])
        );
        const preview = previewSpansWorkflow(
          requestFor(item, { substitutions: maximal })
        );
        expect(preview.ok).toBe(true);
        expect(drafts.createRun(preview.draft).ok).toBe(true);
        for (const slot of item.placeholders) {
          expect(
            previewSpansWorkflow(
              requestFor(item, {
                substitutions: {
                  ...maximal,
                  [slot.name]: 'x'.repeat(slot.maxLength + 1),
                },
              })
            )
          ).toMatchObject({ code: INVALID, field: slot.name, ok: false });
        }
      }
    } finally {
      store.close();
    }
  });
});

describe('workflow refusals', () => {
  test('refuses unknown template ids and unknown or malformed versions', () => {
    const base = requestFor(template('engineering.feature'));
    for (const templateId of [
      '',
      'Engineering.Feature',
      'engineering.feature/../../escape',
      '__proto__',
      'constructor',
      'toString',
      'missing.template',
    ]) {
      expect(previewSpansWorkflow({ ...base, templateId })).toMatchObject({
        code: 'SPANS_WORKFLOW_UNKNOWN',
        ok: false,
      });
    }
    expect(previewSpansWorkflow({ ...base, templateVersion: 2 })).toMatchObject(
      {
        code: 'SPANS_WORKFLOW_VERSION_UNKNOWN',
        ok: false,
      }
    );
    for (const templateVersion of [
      '1',
      0,
      -1,
      1.5,
      Number.MAX_SAFE_INTEGER + 1,
      null,
    ]) {
      expect(previewSpansWorkflow({ ...base, templateVersion })).toMatchObject({
        code: INVALID,
        ok: false,
      });
    }
  });

  test('refuses unsupported top-level fields, including preview-only digests', () => {
    const base = requestFor(template('triage.issue-queue'));
    for (const key of ['install', 'start', 'spans', 'approval', 'digest']) {
      expect(previewSpansWorkflow({ ...base, [key]: true })).toMatchObject({
        code: 'SPANS_WORKFLOW_FIELD_UNSUPPORTED',
        ok: false,
      });
    }
  });

  test('refuses unknown placeholders and names missing required ones', () => {
    const item = template('research.source-review');
    const base = requestFor(item);
    expect(
      previewSpansWorkflow({
        ...base,
        substitutions: { ...base.substitutions, shell: 'run this' },
      })
    ).toMatchObject({ code: 'SPANS_WORKFLOW_PLACEHOLDER_UNKNOWN', ok: false });

    const withoutAudience = Object.fromEntries(
      Object.entries(base.substitutions).filter(([key]) => key !== 'audience')
    );
    expect(
      previewSpansWorkflow({ ...base, substitutions: withoutAudience })
    ).toMatchObject({
      code: 'SPANS_WORKFLOW_PLACEHOLDER_MISSING',
      missing: ['audience'],
      ok: false,
    });
  });

  test('refuses malicious substitutions as plain data only', () => {
    const base = requestFor(template('engineering.feature'));
    const withValue = (name, value) => ({
      ...base,
      substitutions: { ...base.substitutions, [name]: value },
    });

    for (const value of [
      42,
      null,
      true,
      ['a'],
      { nested: 'x' },
      '',
      'line\nbreak',
      'nul\u0000byte',
      'del\u007f',
    ]) {
      expect(previewSpansWorkflow(withValue('change', value))).toMatchObject({
        code: INVALID,
        field: 'change',
        ok: false,
      });
    }

    const getter = { ...base.substitutions };
    Object.defineProperty(getter, 'change', {
      enumerable: true,
      get: () => 'Injected',
    });
    expect(
      previewSpansWorkflow({ ...base, substitutions: getter })
    ).toMatchObject({
      code: INVALID,
      ok: false,
    });

    const withSymbol = { ...base.substitutions, [Symbol('hidden')]: 'x' };
    expect(
      previewSpansWorkflow({ ...base, substitutions: withSymbol })
    ).toMatchObject({
      code: INVALID,
      ok: false,
    });

    const prototypeKey = JSON.parse(JSON.stringify(base.substitutions));
    Object.defineProperty(prototypeKey, '__proto__', {
      configurable: true,
      enumerable: true,
      value: 'x',
      writable: true,
    });
    expect(
      previewSpansWorkflow({ ...base, substitutions: prototypeKey })
    ).toMatchObject({ code: 'SPANS_WORKFLOW_PLACEHOLDER_UNKNOWN', ok: false });
  });

  test('keeps placeholder-looking and replacement-pattern values literal', () => {
    const base = requestFor(template('engineering.feature'));
    const injected = previewSpansWorkflow({
      ...base,
      substitutions: {
        ...base.substitutions,
        change: '{{behavior}} and $& and $1 literal',
      },
    });
    expect(injected.ok).toBe(true);
    expect(injected.draft.spans[0].title).toContain(
      '{{behavior}} and $& and $1 literal'
    );
    expect(injected.draft.goal).toContain(
      '{{behavior}} and $& and $1 literal so that Sample behavior value'
    );
  });

  test('refuses unsafe identity fields and non-plain requests', () => {
    const base = requestFor(template('engineering.feature'));
    // Redaction would rewrite this run ID, so the store would refuse it too.
    expect(previewSpansWorkflow({ ...base, runId: 'token:abc' })).toMatchObject(
      {
        code: INVALID,
        field: 'runId',
        ok: false,
      }
    );
    expect(previewSpansWorkflow({ ...base, owner: '' })).toMatchObject({
      code: INVALID,
      field: 'owner',
    });
    expect(
      previewSpansWorkflow({ ...base, owner: 'codex\nclaude' })
    ).toMatchObject({
      code: INVALID,
      field: 'owner',
    });
    expect(
      previewSpansWorkflow({
        ...base,
        owner: 'x'.repeat(SPANS_WORKFLOW_LIMITS.ownerLength + 1),
      })
    ).toMatchObject({ code: INVALID, field: 'owner' });
    expect(previewSpansWorkflow({ ...base, project: 42 })).toMatchObject({
      code: INVALID,
      field: 'project',
    });
    expect(
      previewSpansWorkflow({
        ...base,
        worktree: 'x'.repeat(SPANS_WORKFLOW_LIMITS.worktreeLength + 1),
      })
    ).toMatchObject({ code: INVALID, field: 'worktree' });

    class Carrier {
      constructor() {
        this.templateId = base.templateId;
      }
    }
    for (const raw of [
      null,
      undefined,
      'engineering.feature',
      [base],
      new Carrier(),
    ]) {
      expect(previewSpansWorkflow(raw)).toMatchObject({
        code: INVALID,
        ok: false,
      });
    }
  });
});

describe('workflow digests and side effects', () => {
  test('repeats the exact preview and digest for identical input', () => {
    const input = requestFor(template('research.source-review'));
    const first = previewSpansWorkflow(input);
    expect(previewSpansWorkflow(structuredClone(input))).toEqual(first);
    expect(first.digest).toMatch(digestPattern);
  });

  test('changes the digest when any reviewed input changes, not key order', () => {
    const input = requestFor(template('research.source-review'));
    const { digest } = previewSpansWorkflow(input);
    const variants = [
      { ...input, owner: 'claude' },
      { ...input, runId: 'run-other' },
      { ...input, project: 'example-app' },
      { ...input, worktree: '/unused/inert/descriptor' },
      {
        ...input,
        substitutions: {
          ...input.substitutions,
          question: 'A different question',
        },
      },
    ];
    for (const variant of variants) {
      expect(previewSpansWorkflow(variant).digest).not.toBe(digest);
    }
    const reordered = Object.fromEntries(
      Object.entries(input.substitutions).reverse()
    );
    expect(
      previewSpansWorkflow({ ...input, substitutions: reordered }).digest
    ).toBe(digest);
  });

  test('verifies a preview digest and refuses stale or malformed ones', () => {
    const input = requestFor(template('business.decision-brief'));
    const { digest } = previewSpansWorkflow(input);
    expect(verifySpansWorkflowPreview({ ...input, digest })).toMatchObject({
      digest,
      ok: true,
    });
    expect(
      verifySpansWorkflowPreview({
        ...input,
        digest: `sha256:${'0'.repeat(64)}`,
      })
    ).toMatchObject({ code: 'SPANS_WORKFLOW_DIGEST_MISMATCH', ok: false });
    expect(
      verifySpansWorkflowPreview({ ...input, digest: digest.toUpperCase() })
    ).toMatchObject({ code: 'SPANS_WORKFLOW_DIGEST_INVALID', ok: false });
    expect(
      verifySpansWorkflowPreview({ ...input, digest: 'sha256:abc' })
    ).toMatchObject({ code: 'SPANS_WORKFLOW_DIGEST_INVALID', ok: false });
    expect(verifySpansWorkflowPreview(input)).toMatchObject({
      code: 'SPANS_WORKFLOW_DIGEST_INVALID',
      ok: false,
    });
    expect(
      verifySpansWorkflowPreview({
        ...input,
        digest,
        substitutions: { ...input.substitutions, decision: 'Changed decision' },
      })
    ).toMatchObject({ code: 'SPANS_WORKFLOW_DIGEST_MISMATCH', ok: false });
  });

  test('performs no storage, input, or catalog side effects', () => {
    const { root, store } = fixture();
    try {
      const before = snapshotRoot(root);
      const input = requestFor(template('engineering.feature'));
      const originalInput = structuredClone(input);
      const originalCatalog = structuredClone(SPANS_WORKFLOW_CATALOG);
      for (let index = 0; index < 3; index += 1) {
        previewSpansWorkflow(input);
        verifySpansWorkflowPreview({
          ...input,
          digest: `sha256:${'0'.repeat(64)}`,
        });
      }
      listSpansWorkflows();
      expect(input).toEqual(originalInput);
      expect(SPANS_WORKFLOW_CATALOG).toEqual(originalCatalog);
      expect(snapshotRoot(root)).toEqual(before);
      expect(store.listRuns().runs).toEqual([]);
    } finally {
      store.close();
    }
  });

  test('imports only pure helpers and no process, network or filesystem APIs', () => {
    const source = fs.readFileSync(
      new URL('./spans-workflows.js', import.meta.url),
      'utf8'
    );
    const specifiers = [...source.matchAll(/from '([^']+)'/g)].map(
      (match) => match[1]
    );
    expect(specifiers).toEqual(['node:crypto', './spans-redaction.js']);
    expect(source).not.toMatch(sideEffectApis);
  });
});
