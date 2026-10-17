import { afterEach, expect, test } from 'bun:test';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSpansPlanningRuntime } from './spans-planning-runtime.js';
import { openSpansStore } from './spans-store.js';

const roots = new Set();
const runtimes = new Set();

afterEach(() => {
  for (const instance of runtimes) {
    instance.close();
    runtimes.delete(instance);
  }
  for (const root of roots) {
    fs.rmSync(root, { force: true, recursive: true });
    roots.delete(root);
  }
});

function tempRoot() {
  const root = fs.mkdtempSync(join(tmpdir(), 'spans-planning-runtime-'));
  roots.add(root);
  return root;
}

function createRuntime(root = tempRoot()) {
  const instance = createSpansPlanningRuntime({ root });
  runtimes.add(instance);
  return instance;
}

function draft(runId = 'runtime-run') {
  return {
    goal: 'Prepare a reviewed offline plan',
    owner: 'codex',
    runId,
    spans: [
      { dependencies: [], spanId: 'plan', title: 'Plan the change' },
      { dependencies: ['plan'], spanId: 'review', title: 'Review the change' },
    ],
  };
}

function workflowInput(runId = 'workflow-run') {
  return {
    owner: 'codex',
    runId,
    substitutions: {
      behavior: 'a reviewed offline plan',
      change: 'planning runtime',
      scope: 'the planning runtime module',
    },
    templateId: 'engineering.feature',
    templateVersion: 1,
  };
}

test('construction, workflow listing and preview do not touch the archive root', () => {
  const parent = tempRoot();
  const root = join(parent, 'archive');
  const instance = createRuntime(root);
  expect(instance.spansWorkflows().ok).toBe(true);
  const preview = instance.spansWorkflowPreview(workflowInput());
  expect(preview.ok).toBe(true);
  expect(fs.existsSync(root)).toBe(false);
});

test('invalid creates, hostile getters and digest mismatch perform no filesystem writes', () => {
  const root = join(tempRoot(), 'archive');
  const instance = createRuntime(root);
  expect(instance.spansDraftCreate({ ...draft(), runId: '../bad' }).ok).toBe(
    false
  );
  const hostile = {};
  Object.defineProperty(hostile, 'goal', {
    enumerable: true,
    get() {
      throw new Error('private getter detail');
    },
  });
  expect(instance.spansDraftCreate(hostile).ok).toBe(false);
  const preview = instance.spansWorkflowPreview(workflowInput());
  const changedDigest = `sha256:${preview.digest.slice(7, 8) === '0' ? '1' : '0'}${preview.digest.slice(8)}`;
  expect(
    instance.spansWorkflowCreate({ ...workflowInput(), digest: changedDigest })
  ).toMatchObject({ code: 'SPANS_WORKFLOW_DIGEST_MISMATCH', ok: false });
  expect(fs.existsSync(root)).toBe(false);
});

test('valid preview creates a draft that survives close and readonly reopen', () => {
  const root = tempRoot();
  const instance = createRuntime(root);
  const input = workflowInput();
  const preview = instance.spansWorkflowPreview(input);
  expect(preview.ok).toBe(true);
  const created = instance.spansWorkflowCreate({
    ...input,
    digest: preview.digest,
  });
  expect(created).toMatchObject({ generation: 0, ok: true, replayed: false });
  expect(instance.close()).toEqual({ ok: true });
  const store = openSpansStore({ readonly: true, root });
  expect(store.readRun({ runId: input.runId })).toMatchObject({
    ok: true,
    view: { goal: preview.draft.goal, runId: input.runId },
  });
  expect(store.close()).toEqual({ ok: true });
});

test('same draft replays, conflicting content and stale revisions are refused', () => {
  const root = tempRoot();
  const instance = createRuntime(root);
  const original = draft();
  expect(instance.spansDraftCreate(original)).toMatchObject({
    ok: true,
    replayed: false,
  });
  expect(instance.spansDraftCreate(original)).toMatchObject({
    ok: true,
    replayed: true,
  });
  expect(
    instance.spansDraftCreate({ ...original, goal: 'Different goal' })
  ).toMatchObject({ code: 'SPANS_DRAFT_CONFLICT', ok: false });
  const revised = instance.spansPlanRevise({
    expectedGeneration: 0,
    expectedRevision: 1,
    goal: 'Revised goal',
    runId: original.runId,
    spans: original.spans,
  });
  expect(revised).toMatchObject({ generation: 1, ok: true, planVersion: 2 });
  expect(
    instance.spansPlanRevise({
      expectedGeneration: 0,
      expectedRevision: 1,
      goal: 'Stale goal',
      runId: original.runId,
      spans: original.spans,
    })
  ).toMatchObject({ code: 'SPANS_DRAFT_STALE', ok: false });
});

test('revision on a missing archive is unavailable and creates nothing', () => {
  const root = join(tempRoot(), 'missing-archive');
  const instance = createRuntime(root);
  expect(
    instance.spansPlanRevise({
      expectedGeneration: 0,
      expectedRevision: 1,
      goal: 'Change',
      runId: 'missing-run',
      spans: [],
    })
  ).toMatchObject({ code: 'SPANS_DRAFT_STORAGE', ok: false });
  expect(fs.existsSync(root)).toBe(false);
});

test('readonly filesystem failures are sanitized and do not initialize an archive', () => {
  const root = tempRoot();
  try {
    fs.chmodSync(root, 0o500);
    const instance = createRuntime(root);
    expect(instance.spansDraftCreate(draft('permission-run'))).toMatchObject({
      code: 'SPANS_DRAFT_STORAGE',
      ok: false,
    });
    expect(fs.readdirSync(root)).toEqual([]);
  } finally {
    fs.chmodSync(root, 0o700);
  }
});

const closeFaultFixture = (scenario) => `
import { mock } from 'bun:test';
const scenario = ${JSON.stringify(scenario)};
const closeCalls = { reader: 0, writer: 0 };
mock.module('./spans-store.js', () => ({
  openSpansStore({ readonly = false } = {}) {
    const role = readonly ? 'reader' : 'writer';
    return {
      close() {
        closeCalls[role] += 1;
        if (role === scenario && closeCalls[role] === 1) return { ok: false };
        return { ok: true };
      },
      commitRun() { return { ok: true, revision: 1 }; },
      readEvents() { return { events: [], hasMore: false, ok: true }; },
      readRun() { return { code: 'SPANS_MODEL_NOT_FOUND', ok: false }; },
    };
  },
}));
const { createSpansPlanningRuntime } = await import('./spans-planning-runtime.js');
const instance = createSpansPlanningRuntime({ root: '/tmp/spans-close-fault' });
const created = instance.spansDraftCreate({
  goal: 'Fault test', owner: 'codex', runId: 'fault-run',
  spans: [{ dependencies: [], spanId: 'plan', title: 'Plan' }],
});
if (scenario === 'reader') {
  if (created.ok !== false || created.code !== 'SPANS_DRAFT_STORAGE') throw new Error('reader close failure was not returned');
  const blocked = instance.spansWorkflows();
  if (blocked.ok !== false || closeCalls.reader !== 1 || closeCalls.writer !== 0) throw new Error('operations continued after reader close failure');
} else if (created.ok !== true) {
  throw new Error('writer setup failed');
}
const firstClose = instance.close();
if (scenario === 'writer' && (firstClose.ok !== false || firstClose.code !== 'SPANS_DRAFT_STORAGE')) throw new Error('first close failure was not retained');
if (scenario === 'reader' && firstClose.ok !== true) throw new Error('reader handle could not be retried by close');
const blockedAfterClose = instance.spansDraftCreate({});
const blockedCode = scenario === 'reader' ? 'SPANS_PLANNING_CLOSED' : 'SPANS_DRAFT_STORAGE';
if (blockedAfterClose.ok !== false || blockedAfterClose.code !== blockedCode) throw new Error('operation was not refused after close failure');
const retryClose = instance.close();
if (retryClose.ok !== true) throw new Error('retry close did not confirm closure');
if (closeCalls[scenario] !== 2) throw new Error('failed handle was not retried');
console.log(JSON.stringify({ closeCalls, created, firstClose, retryClose }));
`;

test.each(['reader', 'writer'])(
  'failed %s close retains its handle and blocks operations until close retry',
  (scenario) => {
    // Keep Bun's module mock local to this subprocess and out of suite state.
    const child = Bun.spawnSync({
      cmd: [process.execPath, '--eval', closeFaultFixture(scenario)],
      cwd: import.meta.dir,
    });
    expect(child.stderr.toString()).toBe('');
    expect(child.exitCode).toBe(0);
    const result = JSON.parse(child.stdout.toString());
    expect(result.closeCalls[scenario]).toBe(2);
    if (scenario === 'writer') {
      expect(result.firstClose).toMatchObject({
        code: 'SPANS_DRAFT_STORAGE',
        ok: false,
      });
    } else {
      expect(result.firstClose).toEqual({ ok: true });
    }
    expect(result.retryClose).toEqual({ ok: true });
  }
);

test('symlink roots and database paths are rejected by the store boundary', () => {
  const parent = tempRoot();
  const target = join(parent, 'target');
  fs.mkdirSync(target);
  const rootLink = join(parent, 'root-link');
  fs.symlinkSync(target, rootLink);
  const linkedRootRuntime = createRuntime(rootLink);
  expect(
    linkedRootRuntime.spansDraftCreate(draft('root-link-run'))
  ).toMatchObject({
    code: 'SPANS_DRAFT_STORAGE',
    ok: false,
  });

  const databaseRoot = join(parent, 'database-link');
  fs.mkdirSync(databaseRoot);
  fs.writeFileSync(join(parent, 'outside.sqlite3'), '');
  fs.symlinkSync(
    join(parent, 'outside.sqlite3'),
    join(databaseRoot, 'spans.sqlite3')
  );
  const linkedDatabaseRuntime = createRuntime(databaseRoot);
  expect(
    linkedDatabaseRuntime.spansDraftCreate(draft('database-link-run'))
  ).toMatchObject({
    code: 'SPANS_DRAFT_STORAGE',
    ok: false,
  });
});

test('close is idempotent and every method refuses after close', () => {
  const instance = createRuntime();
  expect(instance.close()).toEqual({ ok: true });
  expect(instance.close()).toEqual({ ok: true });
  expect(instance.spansWorkflows()).toMatchObject({
    code: 'SPANS_PLANNING_CLOSED',
    ok: false,
  });
  expect(instance.spansWorkflowPreview({})).toMatchObject({
    code: 'SPANS_PLANNING_CLOSED',
    ok: false,
  });
  expect(instance.spansDraftCreate(draft())).toMatchObject({
    code: 'SPANS_PLANNING_CLOSED',
    ok: false,
  });
  expect(instance.spansWorkflowCreate({})).toMatchObject({
    code: 'SPANS_PLANNING_CLOSED',
    ok: false,
  });
  expect(instance.spansPlanRevise({})).toMatchObject({
    code: 'SPANS_PLANNING_CLOSED',
    ok: false,
  });
});

test('runtime requires one explicit absolute root data property', () => {
  expect(() => createSpansPlanningRuntime()).toThrow(
    'Spans planning runtime requires an absolute root.'
  );
  expect(() => createSpansPlanningRuntime({ root: 'relative' })).toThrow(
    'Spans planning runtime requires an absolute root.'
  );
  const input = {};
  Object.defineProperty(input, 'root', {
    enumerable: true,
    get() {
      throw new Error('secret');
    },
  });
  expect(() => createSpansPlanningRuntime(input)).toThrow(
    'Spans planning runtime requires an absolute root.'
  );
});
