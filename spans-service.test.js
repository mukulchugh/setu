import { Database } from 'bun:sqlite';
import { afterEach, expect, test } from 'bun:test';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSpansArtifacts } from './spans-artifacts.js';
import { createSpansService, SPANS_SERVICE_LIMITS } from './spans-service.js';
import { openSpansStore, SPANS_STORE_DATABASE_FILE } from './spans-store.js';

// Synthetic fixtures only: temp roots, fake secrets, no real transcripts.
const SECRET = `sk-proj-${'Ab1'.repeat(8)}`;
const PASSWORD = 'hunter2-synthetic';
const FIXED = {
  busy: {
    code: 'SPANS_SERVICE_BUSY',
    error: 'Spans history is busy; try again.',
    ok: false,
  },
  corrupt: {
    code: 'SPANS_SERVICE_CORRUPT',
    error: 'Spans history failed an integrity check.',
    ok: false,
  },
  invalid: {
    code: 'SPANS_SERVICE_INVALID',
    error: 'Invalid spans request.',
    ok: false,
  },
  notFound: {
    code: 'SPANS_SERVICE_NOT_FOUND',
    error: 'Spans record was not found.',
    ok: false,
  },
  unavailable: {
    code: 'SPANS_SERVICE_UNAVAILABLE',
    error: 'Spans history is unavailable.',
    ok: false,
  },
};

const roots = [];
const stores = [];

afterEach(() => {
  for (const store of stores.splice(0)) {
    store.close();
  }
  for (const root of roots.splice(0)) {
    rmSync(root, { force: true, recursive: true });
  }
});

function openFixture() {
  const root = mkdtempSync(join(tmpdir(), 'spans-service-'));
  chmodSync(root, 0o700);
  roots.push(root);
  const store = openSpansStore({ root });
  stores.push(store);
  return { artifacts: createSpansArtifacts({ root }), root, store };
}

function seedRun(store, runId, view = {}, events = [], expected = {}) {
  const { generation = 0, revision = 0 } = expected;
  const result = store.commitRun({
    events: events.map(([name, type, payload]) => ({
      eventId: `${runId}-${name}`,
      payload,
      runId,
      type,
    })),
    expectedGeneration: generation,
    expectedRevision: revision,
    runId,
    view: { generation, ...view },
  });
  expect(result.ok).toBe(true);
}

function seedPage(store) {
  for (const n of [1, 2, 3, 4, 5]) {
    const runId = `run-0${n}`;
    const view =
      n === 3
        ? {
            goal: `Goal 3 with token ${SECRET}`,
            nested: { authorization: 'Bearer synthetic-token' },
            note: `token ${SECRET}`,
            owner: 'owner-3',
            password: PASSWORD,
            title: 'Run 3',
          }
        : { goal: `Goal ${n}`, state: 'complete', title: `Run ${n}` };
    seedRun(store, runId, view);
  }
}

// Artifact ids are exactly sha256: plus 64 lowercase hex characters.
const ARTIFACT_PREFIX = 'sha256:';
const ARTIFACT_ID_PATTERN = /^sha256:[a-f0-9]{64}$/;
const RUN_TITLE_PATTERN = /^Run \d$/;
const idLike = (character) => `${ARTIFACT_PREFIX}${character.repeat(64)}`;
const digestOf = (artifactId) => artifactId.slice(ARTIFACT_PREFIX.length);

// Counts every call so tests can prove what was (not) touched.
function tracked(store) {
  const calls = [];
  const wrap = (name) => (arg) => {
    calls.push([name, arg]);
    return store[name](arg);
  };
  return {
    calls,
    store: {
      listRuns: wrap('listRuns'),
      readEvents: wrap('readEvents'),
      readRun: wrap('readRun'),
    },
  };
}

function artifactSpy(artifacts) {
  const calls = [];
  return {
    calls,
    read: (arg) => {
      calls.push(arg);
      return artifacts.read(arg);
    },
  };
}

function references(entries) {
  const calls = [];
  return {
    calls,
    getArtifactReference: (arg) => {
      calls.push(arg);
      return Promise.resolve({
        eventId: null,
        found: entries.some(
          ([runId, artifactId]) =>
            runId === arg.runId && artifactId === arg.artifactId
        ),
        ok: true,
      });
    },
  };
}

const stubStore = (overrides = {}) => ({
  listRuns: () => ({ hasMore: false, nextRunId: null, ok: true, runs: [] }),
  readEvents: () => ({ events: [], hasMore: false, nextSequence: 0, ok: true }),
  readRun: () => ({ generation: 0, ok: true, revision: 1, view: {} }),
  ...overrides,
});

const stubArtifacts = (result) => ({ read: () => result });

test('construction needs an injected store and artifact reader and does no I/O', () => {
  expect(() => createSpansService()).toThrow(TypeError);
  expect(() => createSpansService({})).toThrow(TypeError);
  expect(() => createSpansService({ store: stubStore() })).toThrow(TypeError);
  expect(() =>
    createSpansService({ artifacts: stubArtifacts({}), store: {} })
  ).toThrow(TypeError);
  expect(() =>
    createSpansService({
      artifacts: stubArtifacts({}),
      root: '/tmp/x',
      store: stubStore(),
    })
  ).toThrow(TypeError);
  expect(() =>
    createSpansService({
      artifacts: stubArtifacts({}),
      getArtifactReference: 'yes',
      store: stubStore(),
    })
  ).toThrow(TypeError);

  const spy = tracked(stubStore());
  const reads = artifactSpy(stubArtifacts({}));
  const service = createSpansService({ artifacts: reads, store: spy.store });
  expect(Object.keys(service).sort()).toEqual([
    'getArtifact',
    'getEvents',
    'getRun',
    'listRuns',
  ]);
  expect('search' in service).toBe(false);
  expect(Object.isFrozen(service)).toBe(true);
  expect(spy.calls).toEqual([]);
  expect(reads.calls).toEqual([]);
  expect(SPANS_SERVICE_LIMITS.pageLimit).toBe(200);
});

test('listRuns pages the real archive and hydrates only the requested page', async () => {
  const { artifacts, store } = openFixture();
  seedPage(store);
  const spy = tracked(store);
  const service = createSpansService({ artifacts, store: spy.store });

  const first = await service.listRuns({ limit: 2 });
  expect(first.ok).toBe(true);
  expect(first.records.map((record) => record.runId)).toEqual([
    'run-01',
    'run-02',
  ]);
  expect(first.hasMore).toBe(true);
  expect(first.nextRunId).toBe('run-02');
  expect(Object.keys(first.records[0]).sort()).toEqual([
    'generation',
    'revision',
    'runId',
    'view',
  ]);
  expect(first.records[0]).toEqual({
    generation: 0,
    revision: 1,
    runId: 'run-01',
    view: { goal: 'Goal 1', state: 'complete' },
  });
  expect(spy.calls.map(([name]) => name)).toEqual([
    'listRuns',
    'readRun',
    'readRun',
  ]);
  expect(spy.calls[0][1]).toEqual({ limit: 2 });

  const second = await service.listRuns({
    afterRunId: first.nextRunId,
    limit: 2,
  });
  expect(second.records.map((record) => record.runId)).toEqual([
    'run-03',
    'run-04',
  ]);
  expect(second.hasMore).toBe(true);

  const third = await service.listRuns({
    afterRunId: second.nextRunId,
    limit: 2,
  });
  expect(third.records.map((record) => record.runId)).toEqual(['run-05']);
  expect(third.hasMore).toBe(false);
  expect(third.nextRunId).toBe('run-05');
  expect(
    [...first.records, ...second.records, ...third.records].every(
      (record) => record.revision === 1
    )
  ).toBe(true);
});

test('listRuns defaults, empty archive and page bounds', async () => {
  const { artifacts, store } = openFixture();
  const spy = tracked(store);
  const service = createSpansService({ artifacts, store: spy.store });

  expect(await service.listRuns()).toEqual({
    hasMore: false,
    nextRunId: null,
    ok: true,
    records: [],
  });
  expect(await service.listRuns({ afterRunId: null })).toEqual({
    hasMore: false,
    nextRunId: null,
    ok: true,
    records: [],
  });
  expect((await service.listRuns({ limit: 200 })).ok).toBe(true);
  expect(spy.calls.at(-1)[1]).toEqual({ limit: 200 });

  const before = spy.calls.length;
  const hostile = new Proxy(
    {},
    {
      ownKeys() {
        throw new Error('/Users/someone/private');
      },
    }
  );
  const throwing = {
    get limit() {
      throw new Error('/Users/someone/private');
    },
  };
  const invalidInputs = [
    { limit: 201 },
    { limit: 0 },
    { limit: -1 },
    { limit: 1.5 },
    { limit: '5' },
    { limit: Number.NaN },
    { afterRunId: '../x' },
    { afterRunId: '' },
    { afterRunId: 5 },
    { afterRunId: 'run-01\n' },
    { afterRunId: 'a'.repeat(129) },
    { cursor: 'run-01' },
    null,
    [],
    'run-01',
    hostile,
    throwing,
  ];
  const results = await Promise.all(
    invalidInputs.map((input) => service.listRuns(input))
  );
  for (const result of results) {
    expect(result).toEqual(FIXED.invalid);
  }
  expect(spy.calls.length).toBe(before);
});

// Mixed phases and goals, so a filter applied after paging would shorten pages.
function seedPhases(store) {
  const rows = [
    ['run-01', 'completed', 'Alpha archive'],
    ['run-02', 'running', 'Beta build'],
    ['run-03', 'completed', 'alpha follow-up'],
    ['run-04', 'planned', 'Gamma plan'],
    ['run-05', 'failed', 'Alpha retry'],
    ['run-06', 'running', 'Alpha live'],
  ];
  for (const [runId, state, goal] of rows) {
    seedRun(store, runId, { goal, state });
  }
}

const idsOf = (page) => page.records.map((record) => record.runId);

test('listRuns passes phase to the real store and filters before paging', async () => {
  const { artifacts, store } = openFixture();
  seedPhases(store);
  const spy = tracked(store);
  const service = createSpansService({ artifacts, store: spy.store });

  const first = await service.listRuns({ limit: 2, phase: 'past' });
  expect(first.ok).toBe(true);
  // Run-02 is live, yet the page is still full: filtering came first.
  expect(idsOf(first)).toEqual(['run-01', 'run-03']);
  expect(first.hasMore).toBe(true);
  expect(first.nextRunId).toBe('run-03');
  expect(spy.calls[0]).toEqual(['listRuns', { limit: 2, phase: 'past' }]);
  expect(spy.calls.map(([name]) => name)).toEqual([
    'listRuns',
    'readRun',
    'readRun',
  ]);

  const second = await service.listRuns({
    afterRunId: first.nextRunId,
    limit: 2,
    phase: 'past',
  });
  expect(idsOf(second)).toEqual(['run-05']);
  expect(second.hasMore).toBe(false);
  expect(second.nextRunId).toBe('run-05');

  const [live, planned, everything] = await Promise.all([
    service.listRuns({ phase: 'live' }),
    service.listRuns({ phase: 'planned' }),
    service.listRuns({ limit: 3, phase: 'all' }),
  ]);
  expect(idsOf(live)).toEqual(['run-02', 'run-06']);
  expect(idsOf(planned)).toEqual(['run-04']);
  expect(idsOf(everything)).toEqual(['run-01', 'run-02', 'run-03']);
  expect(everything.hasMore).toBe(true);
  expect(
    spy.calls.some(
      ([name, arg]) =>
        name === 'listRuns' && arg.phase === 'all' && arg.limit === 3
    )
  ).toBe(true);
});

test('listRuns passes a literal query to the real store and filters before paging', async () => {
  const { artifacts, store } = openFixture();
  seedPhases(store);
  const spy = tracked(store);
  const service = createSpansService({ artifacts, store: spy.store });

  const first = await service.listRuns({ limit: 2, query: 'ALPHA' });
  expect(idsOf(first)).toEqual(['run-01', 'run-03']);
  expect(first.hasMore).toBe(true);
  expect(first.nextRunId).toBe('run-03');
  expect(spy.calls[0]).toEqual(['listRuns', { limit: 2, query: 'ALPHA' }]);

  const second = await service.listRuns({
    afterRunId: first.nextRunId,
    limit: 2,
    query: 'ALPHA',
  });
  expect(idsOf(second)).toEqual(['run-05', 'run-06']);
  expect(second.hasMore).toBe(false);

  const [both, byId, wildcard, quote] = await Promise.all([
    service.listRuns({ limit: 1, phase: 'live', query: 'alpha' }),
    service.listRuns({ query: 'run-04' }),
    service.listRuns({ query: '%' }),
    service.listRuns({ query: "'" }),
  ]);
  expect(idsOf(both)).toEqual(['run-06']);
  expect(both.hasMore).toBe(false);
  expect(idsOf(byId)).toEqual(['run-04']);
  // The query is literal text, never a pattern.
  expect(wildcard.records).toEqual([]);
  expect(quote.records).toEqual([]);
  expect(wildcard.nextRunId).toBeNull();
});

test('listRuns refuses unknown phases and oversized queries before the store', async () => {
  const spy = tracked(stubStore());
  const service = createSpansService({
    artifacts: stubArtifacts({}),
    store: spy.store,
  });
  const invalidInputs = [
    { phase: 'archived' },
    { phase: 'ALL' },
    { phase: '' },
    { phase: 5 },
    { phase: null },
    { query: 5 },
    { query: null },
    { query: {} },
    { query: 'a'.repeat(257) },
  ];
  const results = await Promise.all(
    invalidInputs.map((input) => service.listRuns(input))
  );
  for (const result of results) {
    expect(result).toEqual(FIXED.invalid);
  }
  expect(spy.calls).toEqual([]);

  const longest = 'a'.repeat(256);
  expect((await service.listRuns({ query: longest })).ok).toBe(true);
  expect(spy.calls).toEqual([['listRuns', { limit: 50, query: longest }]]);
});

test('listRuns carries only the view summary, redacted outbound only', async () => {
  const { artifacts, store } = openFixture();
  seedPage(store);
  const service = createSpansService({ artifacts, store });

  const page = await service.listRuns({ limit: 5 });
  const secretRecord = page.records.find((record) => record.runId === 'run-03');
  expect(secretRecord.view).toEqual({
    goal: 'Goal 3 with token [REDACTED]',
    owner: 'owner-3',
  });
  const serialized = JSON.stringify(page);
  expect(serialized.includes(SECRET)).toBe(false);
  expect(serialized.includes(PASSWORD)).toBe(false);
  // Missing summary fields stay omitted rather than defaulted, and
  // non-summary fields never ride along.
  expect(page.records[0].view).toEqual({ goal: 'Goal 1', state: 'complete' });
  for (const record of page.records) {
    expect('title' in record.view).toBe(false);
    expect('generation' in record.view).toBe(false);
  }
  // The archive itself is untouched by outbound redaction.
  expect(JSON.stringify(store.readRun({ runId: 'run-03' }))).toContain(SECRET);
});

test('listRuns excludes enormous actions and history while getRun retains them', async () => {
  const { artifacts, store } = openFixture();
  // Large, but under the model store's 1 MiB document bound.
  const actions = Array.from({ length: 1500 }, (_, n) => ({
    actionId: `action-${n}`,
    note: 'x'.repeat(150),
  }));
  const history = Array.from({ length: 1500 }, (_, n) => ({
    at: n,
    entry: 'y'.repeat(150),
  }));
  seedRun(store, 'run-01', {
    actions,
    checkpoint: 'cp-7',
    checkpointBody: { big: 'z'.repeat(5000) },
    goal: 'Ship it',
    history,
    nested: { goal: 'not a top-level goal' },
    owner: { name: 'objects are not scalars' },
    planVersion: 3,
    project: 'proj',
    state: 'running',
    worktree: '/tmp/synthetic-worktree',
  });
  const service = createSpansService({ artifacts, store });

  const page = await service.listRuns({});
  expect(page.records.length).toBe(1);
  expect(page.records[0]).toEqual({
    generation: 0,
    revision: 1,
    runId: 'run-01',
    view: {
      checkpoint: 'cp-7',
      goal: 'Ship it',
      planVersion: 3,
      project: 'proj',
      state: 'running',
      worktree: '/tmp/synthetic-worktree',
    },
  });
  const listed = JSON.stringify(page);
  expect(listed.length).toBeLessThan(1000);
  expect(listed.includes('action-1499')).toBe(false);
  expect(listed.includes('yyyy')).toBe(false);

  const detail = await service.getRun({ runId: 'run-01' });
  expect(detail.record.view.actions).toEqual(actions);
  expect(detail.record.view.history).toEqual(history);
  expect(detail.record.view.checkpointBody.big.length).toBe(5000);
});

test('listRuns hydrates a page concurrently and a missing summary stays empty', async () => {
  const { artifacts, store } = openFixture();
  seedRun(store, 'run-01', { title: 'no summary fields' });
  seedRun(store, 'run-02', { goal: 'g' });
  let inFlight = 0;
  let peak = 0;
  const service = createSpansService({
    artifacts,
    store: {
      listRuns: (arg) => store.listRuns(arg),
      readEvents: (arg) => store.readEvents(arg),
      readRun: async (arg) => {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await Promise.resolve();
        inFlight -= 1;
        return store.readRun(arg);
      },
    },
  });
  const page = await service.listRuns({});
  expect(page.records.map((record) => record.view)).toEqual([
    {},
    { goal: 'g' },
  ]);
  expect(peak).toBe(2);
});

test('getRun returns the full record, consistent with the list summary, and fixed failures otherwise', async () => {
  const { artifacts, store } = openFixture();
  seedPage(store);
  seedRun(
    store,
    'run-02',
    { goal: 'Goal 2', state: 'running', title: 'Run 2' },
    [],
    { generation: 0, revision: 1 }
  );
  const service = createSpansService({ artifacts, store });

  const page = await service.listRuns({ limit: 5 });
  const details = await Promise.all(
    page.records.map((record) => service.getRun({ runId: record.runId }))
  );
  for (const [index, record] of page.records.entries()) {
    const detail = details[index];
    expect(detail.ok).toBe(true);
    expect(detail.record.runId).toBe(record.runId);
    expect(detail.record.revision).toBe(record.revision);
    expect(detail.record.generation).toBe(record.generation);
    expect(detail.record.view.title).toMatch(RUN_TITLE_PATTERN);
    for (const [field, value] of Object.entries(record.view)) {
      expect(detail.record.view[field]).toEqual(value);
    }
  }
  const updated = await service.getRun({ runId: 'run-02' });
  expect(updated.record.revision).toBe(2);
  expect(updated.record.view.state).toBe('running');
  expect(
    page.records.find((record) => record.runId === 'run-02').view.state
  ).toBe('running');

  const redacted = await service.getRun({ runId: 'run-03' });
  expect(JSON.stringify(redacted).includes(SECRET)).toBe(false);
  expect(redacted.record.view.password).toBe('[REDACTED]');
  expect(redacted.record.view.nested.authorization).toBe('[REDACTED]');
  expect(redacted.record.view.note).toBe('token [REDACTED]');
  expect(redacted.record.view.generation).toBe(0);

  expect(await service.getRun({ runId: 'run-99' })).toEqual(FIXED.notFound);
  const invalidInputs = [
    undefined,
    {},
    { runId: '' },
    { runId: '../run-01' },
    { runId: 7 },
    { extra: true, runId: 'run-01' },
  ];
  const invalid = await Promise.all(
    invalidInputs.map((input) => service.getRun(input))
  );
  for (const result of invalid) {
    expect(result).toEqual(FIXED.invalid);
  }
});

test('getEvents pages the seeded shape per run and redacts payloads', async () => {
  const { artifacts, store } = openFixture();
  seedRun(store, 'run-01', { title: 'one' }, [
    ['e1', 'run.started', { step: 1 }],
    ['e2', 'message.added', { password: PASSWORD, text: `uses ${SECRET}` }],
    ['e3', 'run.finished', { step: 3 }],
  ]);
  seedRun(store, 'run-02', { title: 'two' }, [
    ['e1', 'run.started', { other: true }],
  ]);
  const service = createSpansService({ artifacts, store });
  const raw = store.readEvents({ runId: 'run-01' });

  const first = await service.getEvents({ limit: 2, runId: 'run-01' });
  expect(first.ok).toBe(true);
  expect(first.events.length).toBe(2);
  expect(first.hasMore).toBe(true);
  expect(first.nextSequence).toBe(raw.events[1].sequence);
  expect(Object.keys(first.events[0]).sort()).toEqual([
    'eventId',
    'payload',
    'runId',
    'sequence',
    'type',
  ]);
  expect(first.events[0]).toEqual(raw.events[0]);
  expect(first.events[1].payload).toEqual({
    password: '[REDACTED]',
    text: 'uses [REDACTED]',
  });
  expect(JSON.stringify(first).includes(SECRET)).toBe(false);
  expect(JSON.stringify(first).includes(PASSWORD)).toBe(false);

  const second = await service.getEvents({
    afterSequence: first.nextSequence,
    limit: 2,
    runId: 'run-01',
  });
  expect(second.events).toEqual([raw.events[2]]);
  expect(second.hasMore).toBe(false);
  expect(second.nextSequence).toBe(raw.events[2].sequence);

  const all = await service.getEvents({ runId: 'run-01' });
  expect(all.events.map((event) => event.eventId)).toEqual([
    'run-01-e1',
    'run-01-e2',
    'run-01-e3',
  ]);
  expect(all.events.every((event) => event.runId === 'run-01')).toBe(true);

  // Unknown runs follow the store's shape; no not-found state is invented.
  expect(await service.getEvents({ runId: 'run-99' })).toEqual({
    events: [],
    hasMore: false,
    nextSequence: 0,
    ok: true,
  });
  expect(
    await service.getEvents({ afterSequence: 9999, runId: 'run-01' })
  ).toEqual({ events: [], hasMore: false, nextSequence: 9999, ok: true });
});

test('getEvents validates run ids, cursors and limits before the store', async () => {
  const spy = tracked(stubStore());
  const service = createSpansService({
    artifacts: stubArtifacts({}),
    store: spy.store,
  });
  const invalidInputs = [
    undefined,
    {},
    { runId: '../x' },
    { afterSequence: -1, runId: 'run-01' },
    { afterSequence: 1.5, runId: 'run-01' },
    { afterSequence: '1', runId: 'run-01' },
    { afterSequence: Number.MAX_SAFE_INTEGER + 1, runId: 'run-01' },
    { limit: 201, runId: 'run-01' },
    { limit: 0, runId: 'run-01' },
    { cursor: 1, runId: 'run-01' },
  ];
  const results = await Promise.all(
    invalidInputs.map((input) => service.getEvents(input))
  );
  for (const result of results) {
    expect(result).toEqual(FIXED.invalid);
  }
  expect(spy.calls).toEqual([]);
  expect((await service.getEvents({ limit: 200, runId: 'run-01' })).ok).toBe(
    true
  );
  expect(spy.calls[0][1]).toEqual({
    afterSequence: 0,
    limit: 200,
    runId: 'run-01',
  });
});

test('getArtifact needs an explicit run reference and denies other runs identically', async () => {
  const { artifacts, store } = openFixture();
  const plain = artifacts.put({ mediaType: 'text/plain', text: 'plain notes' });
  const json = artifacts.put({
    mediaType: 'application/json',
    text: JSON.stringify({ a: 1, b: [true] }),
  });
  const missing = idLike('0');
  const reads = artifactSpy(artifacts);
  const refs = references([
    ['run-01', plain.artifactId],
    ['run-01', json.artifactId],
    ['run-01', missing],
  ]);
  const service = createSpansService({
    artifacts: reads,
    getArtifactReference: refs.getArtifactReference,
    store,
  });

  expect(
    await service.getArtifact({ artifactId: plain.artifactId, runId: 'run-01' })
  ).toEqual({
    artifactId: plain.artifactId,
    mediaType: 'text/plain',
    ok: true,
    runId: 'run-01',
    text: 'plain notes',
  });
  expect(refs.calls).toEqual([
    { artifactId: plain.artifactId, runId: 'run-01' },
  ]);
  expect(
    await service.getArtifact({ artifactId: json.artifactId, runId: 'run-01' })
  ).toEqual({
    artifactId: json.artifactId,
    mediaType: 'application/json',
    ok: true,
    runId: 'run-01',
    text: JSON.stringify({ a: 1, b: [true] }),
  });

  const readsBefore = reads.calls.length;
  const crossRun = await service.getArtifact({
    artifactId: plain.artifactId,
    runId: 'run-02',
  });
  expect(crossRun).toEqual(FIXED.notFound);
  expect(reads.calls.length).toBe(readsBefore);
  // A denied artifact looks exactly like one that does not exist.
  const absent = await service.getArtifact({
    artifactId: missing,
    runId: 'run-01',
  });
  expect(absent).toEqual(crossRun);
  expect(JSON.stringify(crossRun).includes(plain.artifactId)).toBe(false);
});

test('getArtifact is unavailable, never globally authorized, without a reference callback', async () => {
  const { artifacts, store } = openFixture();
  const put = artifacts.put({ mediaType: 'text/plain', text: 'plain notes' });
  const setups = [{}, { getArtifactReference: null }].map((extra) => {
    const reads = artifactSpy(artifacts);
    return {
      reads,
      service: createSpansService({ artifacts: reads, store, ...extra }),
    };
  });
  const results = await Promise.all(
    setups.map(({ service }) =>
      service.getArtifact({ artifactId: put.artifactId, runId: 'run-01' })
    )
  );
  for (const result of results) {
    expect(result).toEqual(FIXED.unavailable);
  }
  for (const { reads } of setups) {
    expect(reads.calls).toEqual([]);
  }
});

test('getArtifact treats any non-boolean or failing reference answer as unavailable', async () => {
  const { artifacts, store } = openFixture();
  const put = artifacts.put({ mediaType: 'text/plain', text: 'plain notes' });
  const request = { artifactId: put.artifactId, runId: 'run-01' };
  const answers = [
    () => true,
    () => undefined,
    () => null,
    () => ({ ok: true }),
    () => ({ eventId: null, found: 'yes', ok: true }),
    () => ({ found: 1, ok: true }),
    () => ({ eventId: null, found: true, ok: false }),
    () => ({ found: true }),
    // The invented field is not an authority.
    () => ({ ok: true, referenced: true }),
    () => {
      throw new Error(`/Users/someone/private ${SECRET}`);
    },
    () => Promise.reject(new Error(`/Users/someone/private ${SECRET}`)),
  ];
  const setups = answers.map((answer) => {
    const reads = artifactSpy(artifacts);
    return {
      reads,
      service: createSpansService({
        artifacts: reads,
        getArtifactReference: answer,
        store,
      }),
    };
  });
  const results = await Promise.all(
    setups.map(({ service }) => service.getArtifact(request))
  );
  for (const result of results) {
    expect(result).toEqual(FIXED.unavailable);
    expect(JSON.stringify(result).includes('Users')).toBe(false);
    expect(JSON.stringify(result).includes(SECRET)).toBe(false);
  }
  for (const { reads } of setups) {
    expect(reads.calls).toEqual([]);
  }
});

test('getArtifact validates ids before the callback or the artifact reader', async () => {
  const reads = artifactSpy(stubArtifacts({ ok: true }));
  const refs = references([]);
  const service = createSpansService({
    artifacts: reads,
    getArtifactReference: refs.getArtifactReference,
    store: stubStore(),
  });
  const good = `sha256:${'a'.repeat(64)}`;
  const invalidInputs = [
    undefined,
    {},
    { runId: 'run-01' },
    { artifactId: good },
    { artifactId: good, runId: '../x' },
    { artifactId: 'A'.repeat(64), runId: 'run-01' },
    { artifactId: `sha256:${'A'.repeat(64)}`, runId: 'run-01' },
    { artifactId: 'a'.repeat(63), runId: 'run-01' },
    { artifactId: 'a'.repeat(65), runId: 'run-01' },
    { artifactId: `sha256:${'a'.repeat(63)}`, runId: 'run-01' },
    { artifactId: `sha256:${'a'.repeat(65)}`, runId: 'run-01' },
    { artifactId: `md5:${good}`, runId: 'run-01' },
    { artifactId: `sha256:sha256:${good}`, runId: 'run-01' },
    { artifactId: '', runId: 'run-01' },
    { artifactId: `${good}\n`, runId: 'run-01' },
    { artifactId: `../${good}`, runId: 'run-01' },
    { artifactId: 5, runId: 'run-01' },
    { artifactId: good, path: '/etc/passwd', runId: 'run-01' },
  ];
  const results = await Promise.all(
    invalidInputs.map((input) => service.getArtifact(input))
  );
  for (const result of results) {
    expect(result).toEqual(FIXED.invalid);
  }
  expect(refs.calls).toEqual([]);
  expect(reads.calls).toEqual([]);
});

test('getArtifact refuses active or malformed content and redacts outbound text', async () => {
  const good = `sha256:${'a'.repeat(64)}`;
  const request = { artifactId: good, runId: 'run-01' };
  const serviceFor = (result) =>
    createSpansService({
      artifacts: stubArtifacts(result),
      getArtifactReference: () =>
        Promise.resolve({ eventId: null, found: true, ok: true }),
      store: stubStore(),
    });

  const activeMediaTypes = [
    'text/html',
    'image/svg+xml',
    'application/javascript',
    'application/xhtml+xml',
    'text/plain; charset=utf-8',
    undefined,
  ];
  const active = await Promise.all(
    activeMediaTypes.map((mediaType) =>
      serviceFor({
        mediaType,
        ok: true,
        text: '<script>alert(1)</script>',
      }).getArtifact(request)
    )
  );
  for (const result of active) {
    expect(result).toEqual(FIXED.corrupt);
    expect(JSON.stringify(result).includes('<script>')).toBe(false);
  }
  const malformedResults = await Promise.all(
    [
      { mediaType: 'text/plain', ok: true, text: 5 },
      { mediaType: 'text/plain', ok: true },
      { mediaType: 'application/json', ok: true, text: '{not json' },
      undefined,
      'text',
      { text: 'no ok flag' },
    ].map((malformed) => serviceFor(malformed).getArtifact(request))
  );
  for (const result of malformedResults) {
    expect(result).toEqual(FIXED.corrupt);
  }

  const plain = await serviceFor({
    mediaType: 'text/plain',
    ok: true,
    text: `password=${PASSWORD} and ${SECRET}`,
  }).getArtifact(request);
  expect(plain.ok).toBe(true);
  expect(plain.mediaType).toBe('text/plain');
  expect(plain.text.includes(SECRET)).toBe(false);
  expect(plain.text.includes(PASSWORD)).toBe(false);

  const structured = await serviceFor({
    mediaType: 'application/json',
    ok: true,
    text: JSON.stringify({ n: 1, note: SECRET, password: PASSWORD }),
  }).getArtifact(request);
  expect(JSON.parse(structured.text)).toEqual({
    n: 1,
    note: '[REDACTED]',
    password: '[REDACTED]',
  });
  expect(Object.keys(structured).sort()).toEqual([
    'artifactId',
    'mediaType',
    'ok',
    'runId',
    'text',
  ]);
});

test('getArtifact maps artifact reader failures to fixed codes', async () => {
  const good = `sha256:${'a'.repeat(64)}`;
  const request = { artifactId: good, runId: 'run-01' };
  const serviceFor = (artifacts) =>
    createSpansService({
      artifacts,
      getArtifactReference: () =>
        Promise.resolve({ eventId: null, found: true, ok: true }),
      store: stubStore(),
    });
  const refused = (code) =>
    serviceFor(
      stubArtifacts({
        code,
        error: `/Users/someone/private ${SECRET}`,
        ok: false,
      })
    ).getArtifact(request);

  expect(await refused('ARTIFACT_NOT_FOUND')).toEqual(FIXED.notFound);
  expect(await refused('ARTIFACT_DIRECTORY_MISSING')).toEqual(FIXED.notFound);
  expect(await refused('ARTIFACT_CORRUPT')).toEqual(FIXED.corrupt);
  expect(await refused('ARTIFACT_INVALID')).toEqual(FIXED.corrupt);
  expect(await refused('ARTIFACT_READ_FAILED')).toEqual(FIXED.unavailable);
  expect(await refused('ARTIFACT_ROOT_INVALID')).toEqual(FIXED.unavailable);
  expect(await refused('SOMETHING_ELSE /Users/x')).toEqual(FIXED.unavailable);
  const adapters = [
    {
      read: () => {
        throw new Error(`/Users/someone/private ${SECRET}`);
      },
    },
    { read: () => Promise.reject(new Error('/Users/someone/private')) },
  ];
  const results = await Promise.all(
    adapters.map((adapter) => serviceFor(adapter).getArtifact(request))
  );
  for (const result of results) {
    expect(result).toEqual(FIXED.unavailable);
    expect(JSON.stringify(result).includes('Users')).toBe(false);
  }
});

test('getArtifact against the real artifact store: absent directory and damaged blob', async () => {
  const { artifacts, root, store } = openFixture();
  const allow = () => Promise.resolve({ eventId: null, found: true, ok: true });
  const service = createSpansService({
    artifacts,
    getArtifactReference: allow,
    store,
  });
  const unknown = `sha256:${'b'.repeat(64)}`;
  // Nothing has been stored yet, so the artifacts directory does not exist.
  expect(
    await service.getArtifact({ artifactId: unknown, runId: 'run-01' })
  ).toEqual(FIXED.notFound);

  const put = artifacts.put({ mediaType: 'text/plain', text: 'plain notes' });
  expect(put.ok).toBe(true);
  // The id is exactly what the seeded writer made: sha256: plus its digest.
  expect(put.artifactId).toMatch(ARTIFACT_ID_PATTERN);
  expect(
    (await service.getArtifact({ artifactId: put.artifactId, runId: 'run-01' }))
      .text
  ).toBe('plain notes');
  expect(
    await service.getArtifact({ artifactId: unknown, runId: 'run-01' })
  ).toEqual(FIXED.notFound);

  writeFileSync(
    join(root, 'artifacts', digestOf(put.artifactId)),
    '{"tampered":true}'
  );
  expect(
    await service.getArtifact({ artifactId: put.artifactId, runId: 'run-01' })
  ).toEqual(FIXED.corrupt);
});

test('throwing or rejecting store adapters return fixed non-leaking errors', async () => {
  const boom = () => {
    throw new Error(`ENOENT /Users/someone/private ${SECRET}`);
  };
  const rejects = () =>
    Promise.reject(new Error(`ENOENT /Users/someone/private ${SECRET}`));
  const services = [boom, rejects].map((fail) =>
    createSpansService({
      artifacts: stubArtifacts({}),
      store: stubStore({ listRuns: fail, readEvents: fail, readRun: fail }),
    })
  );
  const results = await Promise.all(
    services.flatMap((service) => [
      service.listRuns({}),
      service.getRun({ runId: 'run-01' }),
      service.getEvents({ runId: 'run-01' }),
    ])
  );
  expect(results.length).toBe(6);
  for (const result of results) {
    expect(result).toEqual(FIXED.unavailable);
    expect(JSON.stringify(result).includes('Users')).toBe(false);
    expect(JSON.stringify(result).includes(SECRET)).toBe(false);
  }
});

test('store refusals map to fixed codes without causes or messages', async () => {
  const refusal = (code) => ({
    causeCode: 'SQLITE_BUSY',
    code,
    error: `/Users/someone/private ${SECRET}`,
    ok: false,
  });
  const cases = [
    ['SPANS_MODEL_BUSY', FIXED.busy],
    ['SPANS_STORE_BUSY', FIXED.busy],
    ['SPANS_MODEL_CORRUPT', FIXED.corrupt],
    ['SPANS_STORE_CORRUPT', FIXED.corrupt],
    ['SPANS_MODEL_NOT_FOUND', FIXED.notFound],
    ['SPANS_MODEL_INVALID', FIXED.invalid],
    ['SPANS_QUERY_INVALID', FIXED.invalid],
    ['SPANS_STORE_CLOSED', FIXED.unavailable],
    ['SPANS_MODEL_CLOSED', FIXED.unavailable],
    ['SPANS_MODEL_UNAVAILABLE', FIXED.unavailable],
    ['SOMETHING /Users/x', FIXED.unavailable],
  ];
  const entries = cases.map(([code, expected]) => ({
    expected,
    service: createSpansService({
      artifacts: stubArtifacts({}),
      store: stubStore({
        listRuns: () => refusal(code),
        readEvents: () => refusal(code),
        readRun: () => refusal(code),
      }),
    }),
  }));
  const batches = await Promise.all(
    entries.map(({ service }) =>
      Promise.all([
        service.listRuns({}),
        service.getRun({ runId: 'run-01' }),
        service.getEvents({ runId: 'run-01' }),
      ])
    )
  );
  for (const [index, results] of batches.entries()) {
    for (const result of results) {
      expect(result).toEqual(entries[index].expected);
      expect(Object.keys(result).sort()).toEqual(['code', 'error', 'ok']);
    }
  }
});

test('malformed run records and pages fail closed', async () => {
  const serviceWith = (overrides) =>
    createSpansService({
      artifacts: stubArtifacts({}),
      store: stubStore(overrides),
    });
  const goodPage = (runs, extra = {}) => ({
    hasMore: false,
    nextRunId: null,
    ok: true,
    runs,
    ...extra,
  });
  const summary = (runId) => ({ generation: 0, revision: 1, runId });

  const damagedRuns = await Promise.all(
    [
      () => ({ generation: 0, ok: true, revision: 1, view: [] }),
      () => ({ generation: 0, ok: true, revision: 1, view: 'x' }),
      () => ({ generation: 0, ok: true, revision: 1 }),
      () => ({ generation: 0, ok: true, revision: -1, view: {} }),
      () => ({ generation: 0.5, ok: true, revision: 1, view: {} }),
      // Not JSON-compatible, so the seeded redactor refuses it.
      () => ({ generation: 0, ok: true, revision: 1, view: { a: undefined } }),
      () => undefined,
      () => 'ok',
      () => ({}),
    ].map((readRun) => serviceWith({ readRun }).getRun({ runId: 'run-01' }))
  );
  for (const result of damagedRuns) {
    expect(result).toEqual(FIXED.corrupt);
  }

  const damagedPages = await Promise.all(
    [
      () => goodPage([summary('run-02'), summary('run-01')]),
      () => goodPage([summary('run-01'), summary('run-01')]),
      () => goodPage([summary('../x')]),
      () => goodPage([summary(`${SECRET}`)]),
      () => goodPage([{ revision: 1 }]),
      () => goodPage([summary('run-01')], { hasMore: 'no' }),
      () => goodPage('run-01'),
      () => ({ ok: true }),
      () => null,
    ].map((listRuns) => serviceWith({ listRuns }).listRuns({ limit: 5 }))
  );
  for (const result of damagedPages) {
    expect(result).toEqual(FIXED.corrupt);
  }
  // More rows than the requested page is damage, not a longer page.
  expect(
    await serviceWith({
      listRuns: () =>
        goodPage([summary('run-01'), summary('run-02')], { hasMore: true }),
    }).listRuns({ limit: 1 })
  ).toEqual(FIXED.corrupt);
  // A cursor must move forward: a page starting at or before afterRunId is damaged.
  expect(
    await serviceWith({
      listRuns: () => goodPage([summary('run-01')]),
    }).listRuns({ afterRunId: 'run-02' })
  ).toEqual(FIXED.corrupt);

  // A listed run that cannot be hydrated fails the whole page, but a direct
  // lookup of the same missing run is an ordinary not-found.
  const dangling = serviceWith({
    listRuns: () => goodPage([summary('run-01')]),
    readRun: () => ({
      code: 'SPANS_MODEL_NOT_FOUND',
      error: 'Spans model record was not found.',
      ok: false,
    }),
  });
  expect(await dangling.listRuns({})).toEqual(FIXED.corrupt);
  expect(await dangling.getRun({ runId: 'run-01' })).toEqual(FIXED.notFound);
});

test('malformed event pages fail closed', async () => {
  const event = (overrides = {}) => ({
    eventId: 'run-01-e1',
    payload: {},
    runId: 'run-01',
    sequence: 1,
    type: 'run.started',
    ...overrides,
  });
  const page = (events, extra = {}) => ({
    events,
    hasMore: false,
    nextSequence: 0,
    ok: true,
    ...extra,
  });
  const check = (result, input = {}) =>
    createSpansService({
      artifacts: stubArtifacts({}),
      store: stubStore({ readEvents: () => result }),
    }).getEvents({ limit: 5, runId: 'run-01', ...input });

  const damaged = [
    page([event({ runId: 'run-02' })]),
    page([event({ sequence: undefined })]),
    page([event({ sequence: -1 })]),
    page([event({ sequence: 1.5 })]),
    page([event({ eventId: '../x' })]),
    page([event({ type: 5 })]),
    page([event(), event({ eventId: 'run-01-e2', sequence: 1 })]),
    page([
      event({ sequence: 2 }),
      event({ eventId: 'run-01-e2', sequence: 1 }),
    ]),
    page([{ eventId: 'run-01-e1', runId: 'run-01', sequence: 1, type: 'x' }]),
    page([event({ payload: { a: undefined } })]),
    page('events'),
    page([], { hasMore: 'no' }),
    undefined,
  ];
  const damagedResults = await Promise.all(
    damaged.map((result) => check(result))
  );
  for (const result of damagedResults) {
    expect(result).toEqual(FIXED.corrupt);
  }
  // More rows than the requested page is damage, not a longer page.
  expect(
    await check(page([event(), event({ eventId: 'run-01-e2', sequence: 2 })]), {
      limit: 1,
    })
  ).toEqual(FIXED.corrupt);
  expect(
    await check(page([event({ sequence: 3 })]), { afterSequence: 3 })
  ).toEqual(FIXED.corrupt);
  expect((await check(page([event()]), { limit: 1 })).ok).toBe(true);
});

test('damaged archive rows surface as fixed corruption, not as data or details', async () => {
  const { artifacts, root, store } = openFixture();
  seedPage(store);
  const service = createSpansService({ artifacts, store });
  expect((await service.getRun({ runId: 'run-01' })).ok).toBe(true);

  const db = new Database(join(root, SPANS_STORE_DATABASE_FILE), {
    readwrite: true,
    strict: true,
  });
  try {
    db.run("UPDATE spans_views SET view_json = '[1]' WHERE run_id = 'run-02'");
  } finally {
    db.close(true);
  }

  expect(await service.getRun({ runId: 'run-01' })).toEqual(
    expect.objectContaining({ ok: true })
  );
  expect(await service.getRun({ runId: 'run-02' })).toEqual(FIXED.corrupt);
  expect(await service.listRuns({ limit: 3 })).toEqual(FIXED.corrupt);
  expect((await service.listRuns({ afterRunId: 'run-02', limit: 3 })).ok).toBe(
    true
  );
});

test('a closed store reports unavailable and the service performs no writes', async () => {
  const { artifacts, store } = openFixture();
  seedPage(store);
  const service = createSpansService({ artifacts, store });
  const before = store.readEvents({ runId: 'run-01' });
  await service.listRuns({});
  await service.getRun({ runId: 'run-01' });
  await service.getEvents({ runId: 'run-01' });
  expect(store.readEvents({ runId: 'run-01' })).toEqual(before);
  expect(
    (await service.listRuns({ limit: 5 })).records.map((r) => r.revision)
  ).toEqual([1, 1, 1, 1, 1]);

  expect(store.close()).toEqual({ ok: true });
  expect(await service.listRuns({})).toEqual(FIXED.unavailable);
  expect(await service.getRun({ runId: 'run-01' })).toEqual(FIXED.unavailable);
  expect(await service.getEvents({ runId: 'run-01' })).toEqual(
    FIXED.unavailable
  );
});
