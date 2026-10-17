import { afterEach, describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSpansPlanning } from './spans-planning.js';
import { openSpansStore } from './spans-store.js';
import { evaluateDependencyReadiness } from './spans-transitions.js';
import {
  listSpansWorkflows,
  previewSpansWorkflow,
  SPANS_WORKFLOW_CATALOG,
} from './spans-workflows.js';

const roots = new Set();

afterEach(() => {
  for (const root of roots) {
    fs.rmSync(root, { force: true, recursive: true });
    roots.delete(root);
  }
});

function fixture() {
  const root = fs.mkdtempSync(join(tmpdir(), 'setu-spans-planning-'));
  roots.add(root);
  const store = openSpansStore({ root });
  return { planning: createSpansPlanning({ store }), root, store };
}

function template(id) {
  return SPANS_WORKFLOW_CATALOG.find((item) => item.id === id);
}

function requestFor(item, overrides = {}) {
  return {
    owner: 'codex',
    runId: `run-${item.id}`,
    substitutions: Object.fromEntries(
      item.placeholders.map((slot) => [slot.name, `Sample ${slot.name} value`])
    ),
    templateId: item.id,
    templateVersion: item.version,
    ...overrides,
  };
}

// The exact request a caller sends back with the digest it was shown.
function verifiedRequest(input) {
  return { ...input, digest: previewSpansWorkflow(input).digest };
}

function eventTypes(store, runId) {
  return store.readEvents({ runId }).events.map((event) => event.type);
}

describe('offline Spans planning facade', () => {
  test('lists and previews exactly what the workflow module returns', () => {
    const { planning, store } = fixture();
    try {
      const input = requestFor(template('research.source-review'));
      expect(planning.listWorkflows()).toEqual({
        ok: true,
        templates: listSpansWorkflows(),
      });
      expect(planning.previewWorkflow(input)).toEqual(
        previewSpansWorkflow(input)
      );
      expect(Object.isFrozen(planning)).toBe(true);
      expect(store.listRuns().runs).toEqual([]);
    } finally {
      store.close();
    }
  });

  test('refuses construction without exactly one store', () => {
    const { store } = fixture();
    try {
      expect(() => createSpansPlanning({})).toThrow(
        'Invalid Spans draft store.'
      );
      expect(() => createSpansPlanning({ root: '/unused', store })).toThrow(
        'Invalid Spans draft store.'
      );
    } finally {
      store.close();
    }
  });

  test('creates from an exact verified preview and replays after reopen', () => {
    const { planning, root, store } = fixture();
    let reopened;
    try {
      const request = requestFor(template('engineering.feature'), {
        runId: 'run-reopen',
      });
      const preview = previewSpansWorkflow(request);
      expect(preview.ok).toBe(true);
      const input = { ...request, digest: preview.digest };
      expect(planning.createFromWorkflow(input)).toMatchObject({
        generation: 0,
        ok: true,
        replayed: false,
      });
      store.close();

      reopened = openSpansStore({ root });
      const reopenedPlanning = createSpansPlanning({ store: reopened });
      expect(reopenedPlanning.createFromWorkflow(input)).toMatchObject({
        ok: true,
        replayed: true,
      });
      expect(reopened.readRun({ runId: 'run-reopen' }).view.goal).toBe(
        preview.draft.goal
      );
      expect(eventTypes(reopened, 'run-reopen')).toEqual([
        'spans.plan.created',
      ]);
    } finally {
      store.close();
      reopened?.close();
    }
  });

  test('replays an exact duplicate and conflicts when changed input reuses the run', () => {
    const { planning, store } = fixture();
    try {
      const base = requestFor(template('engineering.bugfix'), {
        runId: 'run-duplicate',
      });
      const input = verifiedRequest(base);
      const first = planning.createFromWorkflow(input);
      expect(first).toMatchObject({ ok: true, replayed: false });
      expect(planning.createFromWorkflow(input)).toMatchObject({
        ok: true,
        replayed: true,
        revision: first.revision,
      });

      const changed = verifiedRequest({
        ...base,
        substitutions: {
          ...base.substitutions,
          symptom: 'A different symptom',
        },
      });
      expect(planning.createFromWorkflow(changed)).toMatchObject({
        code: 'SPANS_DRAFT_CONFLICT',
        ok: false,
      });
      expect(eventTypes(store, 'run-duplicate')).toEqual([
        'spans.plan.created',
      ]);
    } finally {
      store.close();
    }
  });

  test('refuses missing, malformed, or edited digests without writing events', () => {
    const { planning, store } = fixture();
    try {
      const input = requestFor(template('engineering.feature'), {
        runId: 'run-digest',
      });
      const { digest } = previewSpansWorkflow(input);
      expect(planning.createFromWorkflow(input)).toMatchObject({
        code: 'SPANS_WORKFLOW_DIGEST_INVALID',
        ok: false,
      });
      expect(
        planning.createFromWorkflow({ ...input, digest: 'sha256:abc' })
      ).toMatchObject({ code: 'SPANS_WORKFLOW_DIGEST_INVALID', ok: false });
      expect(
        planning.createFromWorkflow({
          ...input,
          digest,
          substitutions: {
            ...input.substitutions,
            change: 'A different change',
          },
        })
      ).toMatchObject({ code: 'SPANS_WORKFLOW_DIGEST_MISMATCH', ok: false });
      expect(store.listRuns().runs).toEqual([]);
      expect(store.readEvents({ runId: 'run-digest' }).events).toEqual([]);
    } finally {
      store.close();
    }
  });

  test('refuses a stale revision, then accepts the current one', () => {
    const { planning, store } = fixture();
    try {
      planning.createFromWorkflow(
        verifiedRequest(
          requestFor(template('engineering.feature'), { runId: 'run-stale' })
        )
      );
      const spans = [{ dependencies: [], spanId: 'only', title: 'Only span' }];
      expect(
        planning.revisePlan({
          expectedGeneration: 0,
          expectedRevision: 2,
          goal: 'Stale goal',
          runId: 'run-stale',
          spans,
        })
      ).toMatchObject({ code: 'SPANS_DRAFT_STALE', ok: false });
      expect(
        planning.revisePlan({
          expectedGeneration: 0,
          expectedRevision: 1,
          goal: 'Current goal',
          runId: 'run-stale',
          spans,
        })
      ).toMatchObject({ ok: true, planVersion: 2 });
      expect(eventTypes(store, 'run-stale')).toEqual([
        'spans.plan.created',
        'spans.plan.revised',
      ]);
    } finally {
      store.close();
    }
  });

  test('creates a no-code run with no project or repository target', () => {
    const { planning, store } = fixture();
    try {
      const created = planning.createFromWorkflow(
        verifiedRequest(
          requestFor(template('business.decision-brief'), {
            runId: 'run-no-code',
          })
        )
      );
      expect(created).toMatchObject({ ok: true, replayed: false });
      expect(created.run).toMatchObject({
        project: null,
        state: 'planned',
        worktree: null,
      });
      expect(eventTypes(store, 'run-no-code')).toEqual(['spans.plan.created']);
    } finally {
      store.close();
    }
  });

  test('leaves the DAG ready for dispatch while dispatching nothing', () => {
    const { planning, store } = fixture();
    try {
      const { run } = planning.createFromWorkflow(
        verifiedRequest(
          requestFor(template('engineering.feature'), { runId: 'run-dag' })
        )
      );
      const ready = Object.values(run.spans)
        .filter(
          (span) =>
            evaluateDependencyReadiness({
              acceptedCompletions: [],
              dependencies: span.dependencies,
            }).ready
        )
        .map((span) => span.spanId);
      expect(ready).toEqual(['plan']);
      expect(run.actions).toEqual({});
      expect(
        Object.values(run.spans).every((span) => span.state === 'planned')
      ).toBe(true);
      expect(eventTypes(store, 'run-dag')).toEqual(['spans.plan.created']);
    } finally {
      store.close();
    }
  });

  test('stores redacted substitutions and never the raw secret', () => {
    const { planning, store } = fixture();
    try {
      const base = requestFor(template('engineering.feature'), {
        runId: 'run-secret',
      });
      const input = verifiedRequest({
        ...base,
        substitutions: {
          ...base.substitutions,
          change: 'password=hunter2-plaintext',
        },
      });
      expect(planning.createFromWorkflow(input).ok).toBe(true);
      const stored = JSON.stringify(
        store.readEvents({ runId: 'run-secret' }).events
      );
      expect(stored).not.toContain('hunter2');
      expect(stored).toContain('[REDACTED]');
    } finally {
      store.close();
    }
  });

  test('passes strict draft inputs through and refuses unsupported fields', () => {
    const { planning, store } = fixture();
    try {
      const draftInput = {
        goal: 'Plan the offline change',
        owner: 'codex',
        runId: 'run-draft',
        spans: [{ dependencies: [], spanId: 'plan', title: 'Plan it' }],
      };
      expect(planning.createDraft({ ...draftInput, approved: true })).toEqual({
        code: 'SPANS_DRAFT_INVALID',
        error: 'Invalid Spans draft request.',
        ok: false,
      });
      expect(
        planning.revisePlan({
          ...draftInput,
          expectedGeneration: 0,
          expectedRevision: 1,
        })
      ).toMatchObject({ code: 'SPANS_DRAFT_INVALID', ok: false });
      expect(planning.createDraft(draftInput)).toMatchObject({
        ok: true,
        replayed: false,
      });
      expect(eventTypes(store, 'run-draft')).toEqual(['spans.plan.created']);
    } finally {
      store.close();
    }
  });

  test('refuses accessor-backed requests without invoking their getters', () => {
    const { planning, store } = fixture();
    try {
      let reads = 0;
      const withGetter = (source, key, value) =>
        Object.defineProperty(source, key, {
          enumerable: true,
          get() {
            reads += 1;
            return value;
          },
        });

      const input = verifiedRequest(
        requestFor(template('engineering.feature'), { runId: 'run-getter' })
      );
      expect(
        planning.createFromWorkflow(withGetter({ ...input }, 'owner', 'codex'))
      ).toMatchObject({ code: 'SPANS_WORKFLOW_INVALID', ok: false });

      const draftInput = {
        goal: 'Plan the offline change',
        owner: 'codex',
        runId: 'run-getter',
        spans: [{ dependencies: [], spanId: 'plan', title: 'Plan it' }],
      };
      expect(
        planning.createDraft(withGetter({ ...draftInput }, 'goal', 'Plan'))
      ).toMatchObject({ code: 'SPANS_DRAFT_INVALID', ok: false });

      expect(reads).toBe(0);
      expect(store.listRuns().runs).toEqual([]);
    } finally {
      store.close();
    }
  });

  test('turns an adapter exception into one fixed refusal without its details', () => {
    const store = {
      commitRun() {
        throw new Error('/private/root/spans.sqlite3 is locked');
      },
      readEvents: () => ({
        events: [],
        hasMore: false,
        nextSequence: 0,
        ok: true,
      }),
      // A run record without its view makes the draft layer throw internally.
      readRun: () => ({ generation: 0, ok: true, revision: 1 }),
    };
    const planning = createSpansPlanning({ store });
    const result = planning.revisePlan({
      expectedGeneration: 0,
      expectedRevision: 1,
      goal: 'Revised goal',
      runId: 'run-fake',
      spans: [{ dependencies: [], spanId: 'one', title: 'One' }],
    });
    expect(result).toEqual({
      code: 'SPANS_PLANNING_FAILED',
      error: 'Spans planning could not complete.',
      ok: false,
    });
    expect(JSON.stringify(result)).not.toContain('/private/root');
  });
});
