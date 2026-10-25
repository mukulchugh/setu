import { afterEach, expect, test } from 'bun:test';
import {
  existsSync,
  mkdtempSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openSpansStore, SPANS_STORE_DATABASE_FILE } from './spans-store.js';

const roots = [];
const stores = [];
afterEach(() => {
  for (const store of stores.splice(0)) {
    expect(store.close().ok).toBe(true);
  }
  for (const root of roots.splice(0)) {
    rmSync(root, { force: true, recursive: true });
  }
});
function open(root = mkdtempSync(join(tmpdir(), 'spans-integrated-'))) {
  if (!roots.includes(root)) {
    roots.push(root);
  }
  const store = openSpansStore({ root });
  stores.push(store);
  return { root, store };
}
const event = (eventId, payload = {}) => ({
  eventId,
  payload,
  runId: 'run-1',
  type: 'test',
});
const commit = (store, events, expectedRevision = 0) =>
  store.commitRun({
    events,
    expectedGeneration: 0,
    expectedRevision,
    runId: 'run-1',
    view: { checkpoint: expectedRevision + 1, generation: 0 },
  });

test('real run transaction commits events and view and survives close/reopen', () => {
  const { root, store } = open();
  expect(commit(store, [event('e1')]).ok).toBe(true);
  expect(store.readRun({ runId: 'run-1' }).revision).toBe(1);
  expect(store.readEvents({ runId: 'run-1' }).events).toHaveLength(1);
  expect(store.close().ok).toBe(true);
  const next = open(root).store;
  expect(next.readRun({ runId: 'run-1' }).view.checkpoint).toBe(1);
  expect(next.readEvents({ runId: 'run-1' }).events[0].eventId).toBe('e1');
});

test('real append refusal rolls back preceding events and leaves the view unchanged', () => {
  const { store } = open();
  expect(commit(store, [event('e1')]).ok).toBe(true);
  expect(
    commit(store, [event('e2'), event('e1', { changed: true })], 1).ok
  ).toBe(false);
  expect(store.readRun({ runId: 'run-1' }).revision).toBe(1);
  expect(
    store.readEvents({ runId: 'run-1' }).events.map((e) => e.eventId)
  ).toEqual(['e1']);
});

test('two real connections fence stale revisions without adding history', () => {
  const { root, store } = open();
  const other = open(root).store;
  expect(commit(store, [event('winner')]).ok).toBe(true);
  expect(commit(other, [event('loser')]).ok).toBe(false);
  expect(
    other.readEvents({ runId: 'run-1' }).events.map((e) => e.eventId)
  ).toEqual(['winner']);
});

test('import cursor advances atomically, duplicate replay is inert and refusal rolls back', () => {
  const { store } = open();
  const source = {
    parserVersion: 'v1',
    sourceGeneration: 1,
    sourceId: 'source-1',
  };
  const batch = {
    ...source,
    events: [event('import-1')],
    expectedOffset: 0,
    nextOffset: 10,
  };
  expect(store.commitImport(batch)).toMatchObject({
    duplicate: false,
    ok: true,
  });
  expect(store.commitImport(batch)).toMatchObject({
    duplicate: true,
    ok: true,
  });
  expect(
    store.commitImport({
      ...batch,
      events: [event('import-2'), event('import-1', { changed: true })],
      expectedOffset: 10,
      nextOffset: 20,
    }).ok
  ).toBe(false);
  expect(store.readSourceCursor(source).offset).toBe(10);
  expect(store.readEvents({ runId: 'run-1' }).events).toHaveLength(1);
});

test('real importer stores redacted artifacts, resumes bounded pages and replays gaps', async () => {
  const { createSpansArtifacts } = await import('./spans-artifacts.js');
  const { importSpansSource } = await import('./spans-import.js');
  const { root, store } = open();
  const artifacts = createSpansArtifacts({ root });
  const records = Array.from({ length: 205 }, (_, i) =>
    JSON.stringify({
      payload: {
        content: [
          {
            text: `Record ${i} api_key=sk_private_test_value`,
            type: 'output_text',
          },
        ],
        id: `native-${i}`,
        role: 'assistant',
        type: 'message',
      },
      type: 'response_item',
    })
  );
  const bytes = new TextEncoder().encode(`${records.join('\n')}\n`);
  const args = {
    artifacts,
    parserVersion: 'v1',
    provider: 'codex',
    runId: 'run-1',
    sourceGeneration: 1,
    sourceId: 'source-1',
    store,
  };
  const first = await importSpansSource({ ...args, bytes, offset: 0 });
  expect(first.ok).toBe(true);
  expect(first.events).toHaveLength(200);
  expect(first.pendingBytes.length).toBeGreaterThan(0);
  const saved = await artifacts.read({
    artifactId: first.events[0].payload.artifactId,
  });
  expect(saved.ok).toBe(true);
  expect(
    store.getArtifactReference({
      artifactId: first.events[0].payload.artifactId,
      runId: 'run-1',
    }).found
  ).toBe(true);
  expect(saved.text).not.toContain('sk_private_test_value');
  const second = await importSpansSource({
    ...args,
    bytes: first.pendingBytes,
    offset: first.nextOffset,
  });
  expect(second.ok).toBe(true);
  expect(second.events).toHaveLength(5);
  expect(second.nextOffset).toBe(bytes.length);
  const bad = new TextEncoder().encode('{broken}\n');
  const gap = await importSpansSource({
    ...args,
    bytes: bad,
    offset: second.nextOffset,
  });
  expect(gap.ok).toBe(false);
  expect(gap.gap.type).toBe('source.gap');
  const replay = await importSpansSource({
    ...args,
    bytes: bad,
    offset: second.nextOffset,
  });
  expect(replay.gap.eventId).toBe(gap.gap.eventId);
  expect(
    store.readEvents({ afterSequence: 200, runId: 'run-1' }).events
  ).toHaveLength(6);
});

test('artifact references are scoped to the requesting run and survive retained history', () => {
  const { store } = open();
  const artifactId = `sha256:${'a'.repeat(64)}`;
  expect(store.appendEvent(event('artifact', { artifactId })).ok).toBe(true);
  expect(
    store.getArtifactReference({ artifactId, runId: 'run-1' })
  ).toMatchObject({ found: true, ok: true });
  expect(
    store.getArtifactReference({ artifactId, runId: 'other-run' })
  ).toMatchObject({ found: false, ok: true });
  expect(
    store.getArtifactReference({ artifactId: '../private', runId: 'run-1' }).ok
  ).toBe(false);
});

test('shared service authorizes the actual writer artifact only through its run history', async () => {
  const { createSpansArtifacts } = await import('./spans-artifacts.js');
  const { createSpansService } = await import('./spans-service.js');
  const { root, store } = open();
  const artifacts = createSpansArtifacts({ root });
  const stored = artifacts.put({
    mediaType: 'application/json',
    text: JSON.stringify({ note: 'fixture', token: 'private-value' }),
  });
  expect(stored.ok).toBe(true);
  expect(
    store.appendEvent(
      event('artifact-service', { artifactId: stored.artifactId })
    ).ok
  ).toBe(true);
  const service = createSpansService({
    artifacts,
    getArtifactReference: store.getArtifactReference,
    store,
  });
  const result = await service.getArtifact({
    artifactId: stored.artifactId,
    runId: 'run-1',
  });
  expect(result.ok).toBe(true);
  expect(JSON.parse(result.text)).toEqual({
    note: 'fixture',
    token: '[REDACTED]',
  });
  expect(
    (
      await service.getArtifact({
        artifactId: stored.artifactId,
        runId: 'other-run',
      })
    ).code
  ).toBe('SPANS_SERVICE_NOT_FOUND');
});

test('phase and literal summary search filter before cursor pagination', () => {
  const { store } = open();
  for (const [runId, state, goal] of [
    ['a', 'completed', 'old'],
    ['b', 'planned', '100% ready'],
    ['c', 'ready', '100% ready'],
    ['d', 'running', 'live'],
    ['e', 'unexpected', 'unknown'],
  ]) {
    expect(
      store.commitRun({
        events: [],
        expectedGeneration: 0,
        expectedRevision: 0,
        runId,
        view: { generation: 0, goal, state },
      }).ok
    ).toBe(true);
  }
  const first = store.listRuns({ limit: 1, phase: 'planned', query: '100%' });
  expect(first.runs.map((row) => row.runId)).toEqual(['b']);
  expect(first.hasMore).toBe(true);
  const next = store.listRuns({
    afterRunId: first.nextRunId,
    limit: 1,
    phase: 'planned',
    query: '100%',
  });
  expect(next.runs.map((row) => row.runId)).toEqual(['c']);
  expect(next.hasMore).toBe(false);
  expect(
    store.listRuns({ phase: 'live' }).runs.map((row) => row.runId)
  ).toEqual(['d']);
  expect(
    store.listRuns({ phase: 'past' }).runs.map((row) => row.runId)
  ).toEqual(['a']);
  expect(store.listRuns({ query: '%' }).runs).toHaveLength(2);
  expect(store.listRuns({ phase: 'invalid' }).ok).toBe(false);
});

test('existing-only writable open refuses missing and empty archives without initialization', () => {
  const parent = mkdtempSync(join(tmpdir(), 'spans-existing-only-'));
  roots.push(parent);
  const missing = join(parent, 'missing');
  expect(() => openSpansStore({ create: false, root: missing })).toThrow();
  expect(existsSync(missing)).toBe(false);
  expect(() => openSpansStore({ create: false, root: parent })).toThrow();
  const database = join(parent, SPANS_STORE_DATABASE_FILE);
  expect(existsSync(database)).toBe(false);
  writeFileSync(database, '', { mode: 0o600 });
  expect(() => openSpansStore({ create: false, root: parent })).toThrow();
  expect(statSync(database).size).toBe(0);
  const created = openSpansStore({ root: parent });
  expect(created.close().ok).toBe(true);
  const existing = openSpansStore({ create: false, root: parent });
  expect(commit(existing, [event('existing-event')]).ok).toBe(true);
  expect(existing.close().ok).toBe(true);
});

test('attempt effects hold the archive writer fence and reject stale or closed attempts', () => {
  const { root, store } = open();
  const other = openSpansStore({ busyTimeoutMs: 1, root });
  stores.push(other);
  const binding = {
    actionId: 'action',
    attemptId: 'attempt',
    generation: 0,
    runId: 'run-1',
    spanId: 'span',
    workerId: 'worker',
  };
  const record = { ...binding, status: 'running' };
  const view = { attempts: { attempt: record }, generation: 0 };
  expect(
    store.commitRun({
      events: [],
      expectedGeneration: 0,
      expectedRevision: 0,
      runId: 'run-1',
      view,
    }).ok
  ).toBe(true);
  let effects = 0;
  const effect = () => {
    effects += 1;
    expect(
      other.commitRun({
        events: [],
        expectedGeneration: 0,
        expectedRevision: 1,
        runId: 'run-1',
        view: { ...view, generation: 1 },
      }).code
    ).toBe('SPANS_MODEL_BUSY');
    return { ok: true };
  };
  expect(store.withCurrentAttempt(binding, effect)).toEqual({ ok: true });
  expect(effects).toBe(1);
  expect(
    other.commitRun({
      events: [],
      expectedGeneration: 0,
      expectedRevision: 1,
      runId: 'run-1',
      view: { ...view, generation: 1 },
    }).ok
  ).toBe(true);
  expect(store.withCurrentAttempt(binding, effect).code).toBe(
    'STALE_GENERATION'
  );
  expect(effects).toBe(1);
  expect(
    store.withCurrentAttempt({ ...binding, generation: 1 }, effect).code
  ).toBe('ATTEMPT_CLOSED');
});

test('attempt fence refuses invalid and readonly callers and releases its lock on failure', () => {
  const { root, store } = open();
  const binding = {
    actionId: 'action',
    attemptId: 'attempt',
    generation: 0,
    runId: 'run-1',
    spanId: 'span',
    workerId: 'worker',
  };
  const view = {
    attempts: { attempt: { ...binding, status: 'running' } },
    generation: 0,
  };
  expect(
    store.commitRun({
      events: [],
      expectedGeneration: 0,
      expectedRevision: 0,
      runId: 'run-1',
      view,
    }).ok
  ).toBe(true);
  const reader = openSpansStore({ readonly: true, root });
  stores.push(reader);
  let effects = 0;
  const effect = () => {
    effects += 1;
    return { ok: true };
  };
  expect(reader.withCurrentAttempt(binding, effect).ok).toBe(false);
  expect(
    store.withCurrentAttempt({ ...binding, workerId: 'foreign' }, effect).ok
  ).toBe(false);
  expect(store.withCurrentAttempt({ ...binding, extra: true }, effect).ok).toBe(
    false
  );
  expect(effects).toBe(0);
  expect(
    store.withCurrentAttempt(binding, () => {
      throw new Error('private detail');
    }).ok
  ).toBe(false);
  expect(store.withCurrentAttempt(binding, effect).ok).toBe(true);
  expect(effects).toBe(1);
  store.close();
  expect(store.withCurrentAttempt(binding, effect).ok).toBe(false);
  expect(effects).toBe(1);
});
