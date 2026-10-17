import { Database } from 'bun:sqlite';
import { afterEach, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import { dirname, join } from 'node:path';
import {
  createSpansModelStore,
  inspectSpansModelSchema,
  SPANS_MODEL_LIMITS,
  SpansModelError,
} from './spans-model-store.js';

// Standalone databases only: a temp file holding the event store's metadata and
// events tables, with a stand-in appendEvent that really inserts on the SAME
// connection. Nothing here touches a live Setu path.

const digestPattern = /^[0-9a-f]{64}$/;
const selectPattern = /^\s*SELECT/i;
const cleanups = [];

afterEach(() => {
  while (cleanups.length > 0) {
    cleanups.pop()();
  }
});

const eventSchema = [
  'CREATE TABLE IF NOT EXISTS metadata (key TEXT NOT NULL PRIMARY KEY, value TEXT NOT NULL)',
  `CREATE TABLE IF NOT EXISTS events (
    sequence INTEGER PRIMARY KEY AUTOINCREMENT,
    event_id TEXT NOT NULL UNIQUE,
    run_id TEXT NOT NULL,
    type TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    input_digest TEXT NOT NULL
  )`,
  `CREATE TRIGGER IF NOT EXISTS events_reject_update BEFORE UPDATE ON events
    BEGIN SELECT RAISE(ABORT, 'spans events are append-only'); END`,
  `CREATE TRIGGER IF NOT EXISTS events_reject_delete BEFORE DELETE ON events
    BEGIN SELECT RAISE(ABORT, 'spans events are append-only'); END`,
  "INSERT OR IGNORE INTO metadata (key, value) VALUES ('schema_version', '1')",
];

// Closing is cleanup only. Bun 1.3.4 can refuse close(true) while its internal
// transaction statements are alive, so fall back rather than fail the test.
function release(db, model, statements = []) {
  model?.closeStatements();
  for (const statement of statements) {
    statement.finalize();
  }
  try {
    db.close(true);
  } catch {
    db.close(false);
  }
}

function tempDb() {
  const root = fs.mkdtempSync(join(os.tmpdir(), 'spans-model-'));
  cleanups.push(() => fs.rmSync(root, { force: true, recursive: true }));
  return join(root, 'spans.sqlite3');
}

function connect(path) {
  const db = new Database(path, { create: true, strict: true });
  cleanups.push(() => release(db));
  db.run('PRAGMA journal_mode = WAL');
  db.run('PRAGMA busy_timeout = 2000');
  // Test speed only; atomicity does not depend on the sync level.
  db.run('PRAGMA synchronous = NORMAL');
  return db;
}

function openDatabase(path) {
  const db = connect(path);
  for (const statement of eventSchema) {
    db.run(statement);
  }
  return db;
}

// A real insert into events on the shared connection. It refuses an existing
// event id with different content, like the real store, and records its calls.
function makeAppend(db) {
  const select = db.prepare(
    'SELECT input_digest FROM events WHERE event_id = ?'
  );
  const insert = db.prepare(
    'INSERT INTO events (event_id, run_id, type, payload_json, input_digest) VALUES (?, ?, ?, ?, ?)'
  );
  const append = (input) => {
    append.calls.push(input.eventId);
    const payloadJson = JSON.stringify(input.payload);
    const digest = createHash('sha256')
      .update(`${input.eventId}|${input.runId}|${input.type}|${payloadJson}`)
      .digest('hex');
    const existing = select.get(input.eventId);
    if (existing) {
      return existing.input_digest === digest
        ? { event: { eventId: input.eventId }, ok: true }
        : {
            code: 'SPANS_EVENT_CONFLICT',
            error: 'Spans event id already exists with different content.',
            ok: false,
          };
    }
    insert.run(input.eventId, input.runId, input.type, payloadJson, digest);
    return { event: { eventId: input.eventId }, ok: true };
  };
  append.calls = [];
  append.statements = [select, insert];
  return append;
}

function open({ append, path = tempDb() } = {}) {
  const db = openDatabase(path);
  const base = makeAppend(db);
  const model = createSpansModelStore({
    appendEvent: append ? append(base) : base,
    db,
  });
  cleanups.push(() => release(db, model, base.statements));
  return { append: base, db, model, path };
}

const ev = (runId, eventId, payload = {}) => ({
  eventId,
  payload,
  runId,
  type: 'note',
});

const eventIds = (db) =>
  db
    .query('SELECT event_id FROM events ORDER BY sequence')
    .all()
    .map((row) => row.event_id);

const count = (db, table) =>
  db.query(`SELECT COUNT(*) AS n FROM ${table}`).get().n;

const snapshot = (db) => ({
  metadata: db.query('SELECT key, value FROM metadata ORDER BY key').all(),
  objects: db
    .query('SELECT type, name, sql FROM sqlite_master ORDER BY type, name')
    .all(),
});

const spansTables = (db) =>
  db
    .query(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'spans_%' ORDER BY name"
    )
    .all()
    .map((row) => row.name);

function commit(model, runId, revision, generation, view, events = []) {
  return model.commitRun({
    events,
    expectedGeneration: generation,
    expectedRevision: revision,
    runId,
    view,
  });
}

function constructionError(db, appendEvent = () => ({ ok: true })) {
  try {
    createSpansModelStore({ appendEvent, db });
  } catch (error) {
    return error;
  }
}

test('first construction creates the supplemental tables once and records the model version', () => {
  const { append, db } = open();
  expect(spansTables(db)).toEqual([
    'spans_cache',
    'spans_sources',
    'spans_views',
  ]);
  expect(
    db
      .query('SELECT value FROM metadata WHERE key = ?')
      .get('model_schema_version').value
  ).toBe('1');
  expect(
    db.query('SELECT value FROM metadata WHERE key = ?').get('schema_version')
      .value
  ).toBe('1');
  const before = snapshot(db);
  const again = createSpansModelStore({ appendEvent: append, db });
  cleanups.push(() => again.closeStatements());
  expect(snapshot(db)).toEqual(before);
});

test('newer or malformed model schema versions refuse before any write', () => {
  const cases = [
    ['2', 'SPANS_STORE_SCHEMA_NEWER'],
    ['41', 'SPANS_STORE_SCHEMA_NEWER'],
    ['999999999', 'SPANS_STORE_SCHEMA_NEWER'],
    ['abc', 'SPANS_STORE_SCHEMA_UNSUPPORTED'],
    ['0', 'SPANS_STORE_SCHEMA_UNSUPPORTED'],
    ['01', 'SPANS_STORE_SCHEMA_UNSUPPORTED'],
    ['1.5', 'SPANS_STORE_SCHEMA_UNSUPPORTED'],
    ['-1', 'SPANS_STORE_SCHEMA_UNSUPPORTED'],
    [' 1', 'SPANS_STORE_SCHEMA_UNSUPPORTED'],
    ['', 'SPANS_STORE_SCHEMA_UNSUPPORTED'],
    ['1000000000', 'SPANS_STORE_SCHEMA_UNSUPPORTED'],
  ];
  for (const [value, code] of cases) {
    const db = openDatabase(tempDb());
    db.query('INSERT INTO metadata (key, value) VALUES (?, ?)').run(
      'model_schema_version',
      value
    );
    const before = snapshot(db);
    const error = constructionError(db);
    expect(error).toBeInstanceOf(SpansModelError);
    expect(error.code).toBe(code);
    expect(snapshot(db)).toEqual(before);
    expect(spansTables(db)).toEqual([]);
  }
});

test('a database without metadata or with a tampered model table is refused untouched', () => {
  const bare = connect(tempDb());
  const bareError = constructionError(bare);
  expect(bareError).toBeInstanceOf(SpansModelError);
  expect(bareError.code).toBe('SPANS_STORE_SCHEMA_UNSUPPORTED');
  expect(count(bare, 'sqlite_master')).toBe(0);

  const { db } = open();
  db.run('ALTER TABLE spans_cache ADD COLUMN extra TEXT');
  const before = snapshot(db);
  const tampered = constructionError(db);
  expect(tampered.code).toBe('SPANS_STORE_SCHEMA_UNSUPPORTED');
  expect(snapshot(db)).toEqual(before);
});

test('factory options are checked before anything is prepared', () => {
  const { append, db } = open();
  for (const options of [
    undefined,
    null,
    {},
    { db },
    { appendEvent: append },
  ]) {
    let error;
    try {
      createSpansModelStore(options);
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(SpansModelError);
    expect(error.code).toBe('SPANS_MODEL_OPTIONS_INVALID');
  }
});

test('a new run starts at revision 0 and commits its view, revision and events together', () => {
  const { db, model } = open();
  expect(model.readRun({ runId: 'run-1' })).toMatchObject({
    code: 'SPANS_MODEL_NOT_FOUND',
    ok: false,
  });
  const view = { generation: 0, state: 'planned' };
  expect(
    commit(model, 'run-1', 0, 0, view, [ev('run-1', 'e1'), ev('run-1', 'e2')])
  ).toEqual({ generation: 0, ok: true, revision: 1 });
  expect(model.readRun({ runId: 'run-1' })).toEqual({
    generation: 0,
    ok: true,
    revision: 1,
    view,
  });
  expect(eventIds(db)).toEqual(['e1', 'e2']);
});

test('replaying an accepted commit is stale and never duplicates events or revisions', () => {
  const { db, model } = open();
  const events = [ev('run-1', 'e1')];
  expect(commit(model, 'run-1', 0, 0, { generation: 0 }, events).ok).toBe(true);
  expect(commit(model, 'run-1', 0, 0, { generation: 0 }, events)).toMatchObject(
    {
      code: 'SPANS_MODEL_STALE_REVISION',
      ok: false,
    }
  );
  expect(model.readRun({ runId: 'run-1' }).revision).toBe(1);
  expect(eventIds(db)).toEqual(['e1']);
  expect(
    commit(model, 'run-1', 1, 0, { generation: 1 }, [ev('run-1', 'e2')])
  ).toEqual({ generation: 1, ok: true, revision: 2 });
});

test('stale generations and invalid generation steps are refused without effect', () => {
  const { db, model } = open();
  commit(model, 'run-1', 0, 0, { generation: 0 });
  commit(model, 'run-1', 1, 0, { generation: 1 });
  const stale = commit(model, 'run-1', 2, 0, { generation: 0 }, [
    ev('run-1', 'late'),
  ]);
  expect(stale).toMatchObject({
    code: 'SPANS_MODEL_STALE_GENERATION',
    ok: false,
  });
  for (const generation of [0, 3]) {
    expect(
      commit(model, 'run-1', 2, 1, { generation }, [ev('run-1', 'jump')])
    ).toMatchObject({ code: 'SPANS_MODEL_GENERATION_INVALID', ok: false });
  }
  expect(model.readRun({ runId: 'run-1' })).toMatchObject({
    generation: 1,
    revision: 2,
  });
  expect(eventIds(db)).toEqual([]);
  expect(commit(model, 'run-1', 2, 1, { generation: 2 })).toEqual({
    generation: 2,
    ok: true,
    revision: 3,
  });
});

test('a refused event rolls back earlier inserted events, the view and the revision', () => {
  const { append, db, model } = open();
  commit(model, 'run-1', 0, 0, { generation: 0 }, [
    ev('run-1', 'dup', { a: 1 }),
  ]);

  const refused = commit(model, 'run-2', 0, 0, { generation: 0 }, [
    ev('run-2', 'fresh'),
    ev('run-2', 'dup', { a: 2 }),
  ]);
  expect(refused).toMatchObject({
    code: 'SPANS_MODEL_EVENT_REFUSED',
    eventCode: 'SPANS_EVENT_CONFLICT',
    ok: false,
  });
  // 'fresh' really reached the events table before the refusal.
  expect(append.calls).toEqual(['dup', 'fresh', 'dup']);
  expect(eventIds(db)).toEqual(['dup']);
  expect(model.readRun({ runId: 'run-2' }).code).toBe('SPANS_MODEL_NOT_FOUND');

  const existing = commit(model, 'run-1', 1, 0, { generation: 1 }, [
    ev('run-1', 'later'),
    ev('run-1', 'dup', { a: 3 }),
  ]);
  expect(existing.code).toBe('SPANS_MODEL_EVENT_REFUSED');
  expect(model.readRun({ runId: 'run-1' })).toMatchObject({
    generation: 0,
    revision: 1,
    view: { generation: 0 },
  });
  expect(eventIds(db)).toEqual(['dup']);
});

test('an appendEvent that throws rolls everything back and leaks no message', () => {
  const { db, model } = open({
    append: (base) => (input) => {
      if (input.eventId === 'boom') {
        throw new Error('/private/secret/path exploded');
      }
      return base(input);
    },
  });
  const result = commit(model, 'run-1', 0, 0, { generation: 0 }, [
    ev('run-1', 'before'),
    ev('run-1', 'boom'),
  ]);
  expect(result).toEqual({
    code: 'SPANS_MODEL_UNAVAILABLE',
    error: 'Spans model store is unavailable.',
    ok: false,
  });
  expect(eventIds(db)).toEqual([]);
  expect(count(db, 'spans_views')).toBe(0);
});

test('a failure after the events were inserted rolls the events back and the store stays usable', () => {
  const { db, model } = open();
  db.run(
    "CREATE TRIGGER block_view BEFORE INSERT ON spans_views WHEN NEW.run_id = 'run-blocked' BEGIN SELECT RAISE(ABORT, 'blocked'); END"
  );
  const result = commit(model, 'run-blocked', 0, 0, { generation: 0 }, [
    ev('run-blocked', 'inserted-first'),
  ]);
  expect(result).toMatchObject({ code: 'SPANS_MODEL_UNAVAILABLE', ok: false });
  expect(JSON.stringify(result)).not.toContain('blocked');
  expect(eventIds(db)).toEqual([]);
  expect(count(db, 'spans_views')).toBe(0);
  expect(
    commit(model, 'run-ok', 0, 0, { generation: 0 }, [ev('run-ok', 'kept')]).ok
  ).toBe(true);
  expect(eventIds(db)).toEqual(['kept']);
});

test('malformed commit requests are invalid and write nothing', () => {
  const { db, model } = open();
  const cyclic = { generation: 0 };
  cyclic.self = cyclic;
  const valid = {
    events: [],
    expectedGeneration: 0,
    expectedRevision: 0,
    runId: 'run-v',
    view: { generation: 0 },
  };
  const patches = [
    { events: 'nope' },
    { events: [ev('run-other', 'x')] },
    { events: [ev('run-v', 'x'), 'text'] },
    {
      events: Array.from(
        { length: SPANS_MODEL_LIMITS.eventsPerBatch + 1 },
        (_, index) => ev('run-v', `e-${index}`)
      ),
    },
    { expectedRevision: -1 },
    { expectedRevision: 1.5 },
    { expectedGeneration: '0' },
    { runId: 'bad id' },
    { runId: undefined },
    { view: [] },
    { view: { state: 'no generation' } },
    { view: { generation: 0, gone: undefined } },
    { view: { generation: 0, nan: Number.NaN } },
    {
      view: {
        blob: 'x'.repeat(SPANS_MODEL_LIMITS.documentBytes),
        generation: 0,
      },
    },
    { view: cyclic },
    {
      view: {
        get generation() {
          throw new Error('hostile');
        },
      },
    },
    { extra: 1 },
  ];
  for (const patch of patches) {
    expect(model.commitRun({ ...valid, ...patch })).toMatchObject({
      code: 'SPANS_MODEL_INVALID',
      ok: false,
    });
  }
  const { events: _events, ...withoutEvents } = valid;
  for (const input of [withoutEvents, null, 'text', []]) {
    expect(model.commitRun(input).code).toBe('SPANS_MODEL_INVALID');
  }
  expect(count(db, 'spans_views')).toBe(0);
  expect(count(db, 'events')).toBe(0);
  expect(model.readRun({ runId: 'bad id' }).code).toBe('SPANS_MODEL_INVALID');
  expect(model.readRun({ extra: true, runId: 'run-1' }).code).toBe(
    'SPANS_MODEL_INVALID'
  );
});

test('two connections racing a new run produce exactly one winner', () => {
  const first = open();
  const second = open({ path: first.path });
  const request = (id) => ({
    events: [ev('run-race', id)],
    expectedGeneration: 0,
    expectedRevision: 0,
    runId: 'run-race',
    view: { generation: 0, owner: id },
  });
  expect(first.model.commitRun(request('from-a')).ok).toBe(true);
  expect(second.model.commitRun(request('from-b'))).toMatchObject({
    code: 'SPANS_MODEL_STALE_REVISION',
    ok: false,
  });
  expect(eventIds(second.db)).toEqual(['from-a']);
  expect(second.model.readRun({ runId: 'run-race' }).view.owner).toBe('from-a');
});

test('a sibling update based on an old read cannot overwrite an accepted sibling', () => {
  const a = open();
  const b = open({ path: a.path });
  const run = 'run-sib';
  const pending = { generation: 0, siblings: { s1: 'pending', s2: 'pending' } };
  expect(commit(a.model, run, 0, 0, pending, [ev(run, 'start')]).ok).toBe(true);

  const seenByA = a.model.readRun({ runId: run });
  const seenByB = b.model.readRun({ runId: run });
  const finish = (seen, sibling, eventId) => ({
    events: [ev(run, eventId)],
    expectedGeneration: seen.generation,
    expectedRevision: seen.revision,
    runId: run,
    view: {
      ...seen.view,
      siblings: { ...seen.view.siblings, [sibling]: 'done' },
    },
  });

  expect(a.model.commitRun(finish(seenByA, 's1', 's1-done'))).toEqual({
    generation: 0,
    ok: true,
    revision: 2,
  });
  expect(b.model.commitRun(finish(seenByB, 's2', 's2-lost'))).toMatchObject({
    code: 'SPANS_MODEL_STALE_REVISION',
    ok: false,
  });
  expect(eventIds(b.db)).toEqual(['start', 's1-done']);

  const fresh = b.model.readRun({ runId: run });
  expect(fresh.view.siblings).toEqual({ s1: 'done', s2: 'pending' });
  expect(b.model.commitRun(finish(fresh, 's2', 's2-done')).revision).toBe(3);
  expect(a.model.readRun({ runId: run }).view.siblings).toEqual({
    s1: 'done',
    s2: 'done',
  });
  expect(eventIds(a.db)).toEqual(['start', 's1-done', 's2-done']);
});

test('imports advance the cursor only with their events and recognise only the exact last batch', () => {
  const { db, model } = open();
  const key = {
    parserVersion: 'parser-1',
    sourceGeneration: 1,
    sourceId: 'src-1',
  };
  const batch = (events, expectedOffset, nextOffset, patch = {}) => ({
    ...key,
    events,
    expectedOffset,
    nextOffset,
    ...patch,
  });
  const first = batch([ev('run-1', 'i1'), ev('run-2', 'i2')], 0, 100);

  expect(model.readSourceCursor(key)).toEqual({
    batchDigest: null,
    found: false,
    offset: 0,
    ok: true,
  });
  expect(model.commitImport(first)).toEqual({
    duplicate: false,
    offset: 100,
    ok: true,
  });
  const stored = model.readSourceCursor(key);
  expect(stored).toMatchObject({ found: true, offset: 100, ok: true });
  expect(stored.batchDigest).toMatch(digestPattern);

  // Exact replay: prior status, nothing new.
  expect(model.commitImport(first)).toEqual({
    duplicate: true,
    offset: 100,
    ok: true,
  });
  expect(eventIds(db)).toEqual(['i1', 'i2']);

  // Changed batch under the same offsets conflicts.
  const changed = batch(
    [ev('run-1', 'i1', { changed: true }), ev('run-2', 'i2')],
    0,
    100
  );
  expect(model.commitImport(changed)).toMatchObject({
    code: 'SPANS_MODEL_OFFSET_CONFLICT',
    ok: false,
  });
  expect(model.readSourceCursor(key)).toEqual(stored);

  // Unknown earlier offsets cannot silently advance, nor can a wrong expectation.
  const unknown = batch([ev('run-1', 'x1')], 50, 90, { sourceId: 'src-2' });
  expect(model.commitImport(unknown).code).toBe('SPANS_MODEL_OFFSET_CONFLICT');
  expect(model.readSourceCursor({ ...key, sourceId: 'src-2' }).found).toBe(
    false
  );
  expect(model.commitImport(batch([ev('run-1', 'x2')], 40, 90)).code).toBe(
    'SPANS_MODEL_OFFSET_CONFLICT'
  );

  // A later batch advances; the earlier one is then unknown history.
  const second = batch([ev('run-1', 'i3')], 100, 180);
  expect(model.commitImport(second)).toEqual({
    duplicate: false,
    offset: 180,
    ok: true,
  });
  expect(model.commitImport(first).code).toBe('SPANS_MODEL_OFFSET_CONFLICT');
  expect(model.commitImport(second).duplicate).toBe(true);

  // A refused event leaves the cursor and every earlier insert behind.
  const refused = batch(
    [ev('run-1', 'i4'), ev('run-1', 'i1', { changed: true })],
    180,
    250
  );
  expect(model.commitImport(refused)).toMatchObject({
    code: 'SPANS_MODEL_EVENT_REFUSED',
    ok: false,
  });
  expect(model.readSourceCursor(key).offset).toBe(180);
  expect(eventIds(db)).toEqual(['i1', 'i2', 'i3']);

  // An empty batch may still move the cursor forward.
  expect(model.commitImport(batch([], 180, 200)).offset).toBe(200);

  // Cursors are independent per generation and parser version.
  expect(
    model.commitImport(
      batch([ev('run-3', 'g2')], 0, 10, { sourceGeneration: 2 })
    ).ok
  ).toBe(true);
  expect(
    model.commitImport(
      batch([ev('run-3', 'p2')], 0, 10, { parserVersion: 'parser-2' })
    ).ok
  ).toBe(true);
  expect(model.readSourceCursor(key).offset).toBe(200);
  expect(model.readSourceCursor({ ...key, sourceGeneration: 2 }).offset).toBe(
    10
  );
  expect(
    model.readSourceCursor({ ...key, parserVersion: 'parser-2' }).offset
  ).toBe(10);
});

test('malformed import requests are invalid and write nothing', () => {
  const { db, model } = open();
  const valid = {
    events: [],
    expectedOffset: 0,
    nextOffset: 10,
    parserVersion: 'parser-1',
    sourceGeneration: 1,
    sourceId: 'src-1',
  };
  const patches = [
    // Equal offsets are only for empty or gap-only batches.
    { events: [ev('run-1', 'stuck')], nextOffset: 0 },
    {
      events: [{ ...ev('run-1', 'stuck'), type: 'source.message' }],
      nextOffset: 0,
    },
    {
      events: [
        { ...ev('run-1', 'gap-1'), type: 'source.gap' },
        { ...ev('run-1', 'stuck'), type: 'source.message' },
      ],
      nextOffset: 0,
    },
    { expectedOffset: 20 },
    { expectedOffset: -1 },
    { nextOffset: 10.5 },
    { sourceGeneration: -1 },
    { parserVersion: 'bad version' },
    { sourceId: '' },
    { events: 'x' },
    { events: [{ not: 'an event but still plain' }, 5] },
    { extra: true },
  ];
  for (const patch of patches) {
    expect(model.commitImport({ ...valid, ...patch })).toMatchObject({
      code: 'SPANS_MODEL_INVALID',
      ok: false,
    });
  }
  expect(model.readSourceCursor({ sourceId: 'src-1' }).code).toBe(
    'SPANS_MODEL_INVALID'
  );
  expect(count(db, 'spans_sources')).toBe(0);
  expect(count(db, 'events')).toBe(0);
});

test('a failure after import events were inserted leaves no events and no cursor', () => {
  const { db, model } = open();
  db.run(
    "CREATE TRIGGER block_cursor BEFORE INSERT ON spans_sources WHEN NEW.source_id = 'src-blocked' BEGIN SELECT RAISE(ABORT, 'blocked'); END"
  );
  const key = {
    parserVersion: 'parser-1',
    sourceGeneration: 1,
    sourceId: 'src-blocked',
  };
  const result = model.commitImport({
    ...key,
    events: [ev('run-1', 'inserted-first')],
    expectedOffset: 0,
    nextOffset: 10,
  });
  expect(result).toMatchObject({ code: 'SPANS_MODEL_UNAVAILABLE', ok: false });
  expect(eventIds(db)).toEqual([]);
  expect(model.readSourceCursor(key).found).toBe(false);
  expect(
    model.commitImport({
      ...key,
      events: [ev('run-1', 'kept')],
      expectedOffset: 0,
      nextOffset: 10,
      sourceId: 'src-fine',
    }).ok
  ).toBe(true);
  expect(eventIds(db)).toEqual(['kept']);
});

test('runs, cursors and cache entries survive a restart on a fresh connection', () => {
  const first = open();
  const view = { generation: 1, state: 'running' };
  commit(first.model, 'run-1', 0, 0, { generation: 0 }, [ev('run-1', 'e1')]);
  commit(first.model, 'run-1', 1, 0, view, [ev('run-1', 'e2')]);
  const key = {
    parserVersion: 'parser-1',
    sourceGeneration: 3,
    sourceId: 'src-1',
  };
  first.model.commitImport({
    ...key,
    events: [ev('run-9', 'i1')],
    expectedOffset: 0,
    nextOffset: 64,
  });
  first.model.writeCache('derived:one', { complete: true, items: [1, 2] });
  const digest = first.model.readSourceCursor(key).batchDigest;
  release(first.db, first.model, first.append.statements);

  const second = open({ path: first.path });
  expect(second.model.readRun({ runId: 'run-1' })).toEqual({
    generation: 1,
    ok: true,
    revision: 2,
    view,
  });
  expect(second.model.readSourceCursor(key)).toEqual({
    batchDigest: digest,
    found: true,
    offset: 64,
    ok: true,
  });
  expect(second.model.readCache('derived:one')).toEqual({
    entry: { complete: true, items: [1, 2] },
    ok: true,
  });
  expect(eventIds(second.db)).toEqual(['e1', 'e2', 'i1']);
  // The restarted model continues from the stored revision.
  expect(commit(second.model, 'run-1', 2, 1, { generation: 1 }).revision).toBe(
    3
  );
});

test('listRuns pages in stable id order with a bounded page size', () => {
  const { model } = open();
  for (const id of ['run-c', 'run-a', 'run-e', 'run-b', 'run-d']) {
    commit(model, id, 0, 0, { generation: 0, secret: 'not listed' });
  }
  const summary = (runId) => ({ generation: 0, revision: 1, runId });

  expect(model.listRuns({ limit: 2 })).toEqual({
    hasMore: true,
    nextRunId: 'run-b',
    ok: true,
    runs: [summary('run-a'), summary('run-b')],
  });
  expect(model.listRuns({ afterRunId: 'run-b', limit: 2 })).toEqual({
    hasMore: true,
    nextRunId: 'run-d',
    ok: true,
    runs: [summary('run-c'), summary('run-d')],
  });
  expect(model.listRuns({ afterRunId: 'run-d', limit: 2 })).toEqual({
    hasMore: false,
    nextRunId: 'run-e',
    ok: true,
    runs: [summary('run-e')],
  });
  expect(model.listRuns({ afterRunId: 'run-e' })).toEqual({
    hasMore: false,
    nextRunId: 'run-e',
    ok: true,
    runs: [],
  });
  expect(model.listRuns().runs).toHaveLength(5);

  for (const query of [
    { limit: 0 },
    { limit: 201 },
    { limit: 1.5 },
    { limit: '2' },
    { afterRunId: '' },
    { afterRunId: 'bad id' },
    { extra: 1 },
    null,
  ]) {
    expect(model.listRuns(query)).toMatchObject({
      code: 'SPANS_MODEL_INVALID',
      ok: false,
    });
  }
});

test('a page never exceeds the 200 run limit even with more runs stored', () => {
  const { model } = open();
  for (let index = 0; index < 205; index += 1) {
    commit(model, `run-${String(index).padStart(3, '0')}`, 0, 0, {
      generation: 0,
    });
  }
  const page = model.listRuns({ limit: SPANS_MODEL_LIMITS.pageLimit });
  expect(page.runs).toHaveLength(200);
  expect(page).toMatchObject({ hasMore: true, nextRunId: 'run-199' });
  const rest = model.listRuns({ afterRunId: page.nextRunId, limit: 200 });
  expect(rest.runs.map((run) => run.runId)).toEqual([
    'run-200',
    'run-201',
    'run-202',
    'run-203',
    'run-204',
  ]);
  expect(rest.hasMore).toBe(false);
}, 20_000);

test('cache entries are replaced whole and invalid keys or entries are refused', () => {
  const { db, model } = open();
  expect(model.readCache('derived:k1')).toMatchObject({
    code: 'SPANS_MODEL_NOT_FOUND',
    ok: false,
  });
  expect(
    model.writeCache('derived:k1', { complete: true, items: [1, 2, 3] })
  ).toEqual({
    ok: true,
  });
  expect(model.readCache('derived:k1')).toEqual({
    entry: { complete: true, items: [1, 2, 3] },
    ok: true,
  });
  model.writeCache('derived:k1', { complete: true, replaced: true });
  expect(model.readCache('derived:k1').entry).toEqual({
    complete: true,
    replaced: true,
  });
  expect(count(db, 'spans_cache')).toBe(1);

  for (const [key, entry] of [
    ['bad key', {}],
    ['', {}],
    ['derived:k2', []],
    ['derived:k2', 'text'],
    ['derived:k2', null],
    ['derived:k2', { bad: undefined }],
    ['derived:k2', { blob: 'x'.repeat(SPANS_MODEL_LIMITS.documentBytes) }],
  ]) {
    expect(model.writeCache(key, entry).code).toBe('SPANS_MODEL_INVALID');
  }
  expect(model.readCache(5).code).toBe('SPANS_MODEL_INVALID');
  expect(model.readCache('').code).toBe('SPANS_MODEL_INVALID');
  expect(count(db, 'spans_cache')).toBe(1);
});

test('db.close(true) succeeds right after mutations and the journal mode can change at once', () => {
  const path = tempDb();
  const db = new Database(path, { create: true, strict: true });
  // Only reached as a safety net if an assertion fails before close(true).
  cleanups.push(() => db.close(false));
  db.run('PRAGMA journal_mode = WAL');
  for (const statement of eventSchema) {
    db.run(statement);
  }
  const append = makeAppend(db);
  const model = createSpansModelStore({ appendEvent: append, db });

  // A committed run, a committed import, a rolled-back refusal and a cache write.
  expect(
    commit(model, 'run-1', 0, 0, { generation: 0 }, [ev('run-1', 'e1')]).ok
  ).toBe(true);
  expect(
    model.commitImport({
      events: [ev('run-1', 'i1')],
      expectedOffset: 0,
      nextOffset: 10,
      parserVersion: 'parser-1',
      sourceGeneration: 1,
      sourceId: 'src-1',
    }).ok
  ).toBe(true);
  expect(
    commit(model, 'run-2', 0, 0, { generation: 0 }, [
      ev('run-2', 'fresh'),
      ev('run-2', 'e1', { different: true }),
    ]).code
  ).toBe('SPANS_MODEL_EVENT_REFUSED');
  expect(model.writeCache('derived:one', { complete: true }).ok).toBe(true);

  // Each owner releases its statements before the shared connection closes.
  expect(model.closeStatements()).toEqual({ ok: true });
  for (const statement of append.statements) {
    statement.finalize();
  }
  expect(() => db.close(true)).not.toThrow();

  const next = new Database(path, { strict: true });
  try {
    expect(next.query('PRAGMA journal_mode = DELETE').values()[0][0]).toBe(
      'delete'
    );
    expect(next.query('PRAGMA journal_mode = WAL').values()[0][0]).toBe('wal');
  } finally {
    next.close(true);
  }
});

test('a failed COMMIT is reported as a failure, never as success, and persists nothing', () => {
  const db = openDatabase(tempDb());
  const append = makeAppend(db);
  cleanups.push(() => release(db, null, append.statements));
  const log = [];
  const failing = new Set();
  const busy = () =>
    Object.assign(new Error('/private/path database is locked'), {
      code: 'SQLITE_BUSY',
    });
  const wrapped = {
    prepare: (sql) => db.prepare(sql),
    query: (sql) => db.query(sql),
    run(sql, ...args) {
      log.push(sql);
      if (failing.has(sql)) {
        throw busy();
      }
      return db.run(sql, ...args);
    },
    transaction() {
      throw new Error('db.transaction must not be used');
    },
  };
  const model = createSpansModelStore({ appendEvent: append, db: wrapped });
  const busyResult = {
    code: 'SPANS_MODEL_BUSY',
    error: 'Spans model store is busy; try again.',
    ok: false,
  };

  // COMMIT fails: a ROLLBACK follows and nothing was stored.
  failing.add('COMMIT');
  log.length = 0;
  expect(
    commit(model, 'run-1', 0, 0, { generation: 0 }, [ev('run-1', 'e1')])
  ).toEqual(busyResult);
  expect(log).toEqual(['BEGIN IMMEDIATE', 'COMMIT', 'ROLLBACK']);
  expect(eventIds(db)).toEqual([]);
  expect(count(db, 'spans_views')).toBe(0);

  // COMMIT and ROLLBACK both fail: still a failure, never a swallowed success.
  failing.add('ROLLBACK');
  expect(
    commit(model, 'run-1', 0, 0, { generation: 0 }, [ev('run-1', 'e1')])
  ).toEqual(busyResult);
  failing.clear();
  // The test's own cleanup of the transaction the failing ROLLBACK left open.
  db.run('ROLLBACK');
  expect(eventIds(db)).toEqual([]);
  expect(count(db, 'spans_views')).toBe(0);

  expect(
    commit(model, 'run-1', 0, 0, { generation: 0 }, [ev('run-1', 'e1')])
  ).toEqual({ generation: 0, ok: true, revision: 1 });
  expect(eventIds(db)).toEqual(['e1']);
});

test('zero-progress imports: empty bytes write nothing and gap-only batches keep the cursor', () => {
  const { db, model } = open();
  const key = {
    parserVersion: 'parser-1',
    sourceGeneration: 1,
    sourceId: 'src-1',
  };
  const batch = (events, expectedOffset, nextOffset) => ({
    ...key,
    events,
    expectedOffset,
    nextOffset,
  });
  const gap = (eventId, payload = { reason: 'invalid-line' }) => ({
    ...ev('run-1', eventId, payload),
    type: 'source.gap',
  });
  const message = (eventId) => ({
    ...ev('run-1', eventId),
    type: 'source.message',
  });
  const changes = () => db.query('SELECT total_changes() AS n').get().n;
  const unseen = { batchDigest: null, found: false, offset: 0, ok: true };

  // Empty bytes on a never-seen source: success, no cursor row, no event.
  const base = changes();
  expect(model.commitImport(batch([], 0, 0))).toEqual({
    duplicate: false,
    offset: 0,
    ok: true,
  });
  expect(changes()).toBe(base);
  expect(count(db, 'spans_sources')).toBe(0);
  expect(count(db, 'events')).toBe(0);
  expect(model.readSourceCursor(key)).toEqual(unseen);
  // A wrong expectation is still a conflict, still without any write.
  expect(model.commitImport(batch([], 10, 10)).code).toBe(
    'SPANS_MODEL_OFFSET_CONFLICT'
  );
  expect(changes()).toBe(base);

  // A message may not claim to make no progress, alone or beside a gap.
  for (const events of [
    [message('m0')],
    [gap('g0'), message('m0')],
    [ev('run-1', 'n0')],
  ]) {
    expect(model.commitImport(batch(events, 0, 0)).code).toBe(
      'SPANS_MODEL_INVALID'
    );
  }
  expect(changes()).toBe(base);

  // The invalid first line becomes a gap event; the cursor stays at 0 but exists.
  expect(model.commitImport(batch([gap('g1')], 0, 0))).toEqual({
    duplicate: false,
    offset: 0,
    ok: true,
  });
  const recorded = model.readSourceCursor(key);
  expect(recorded).toMatchObject({ found: true, offset: 0, ok: true });
  expect(recorded.batchDigest).toMatch(digestPattern);
  expect(eventIds(db)).toEqual(['g1']);

  // Exact retry: duplicate, nothing new, digest preserved.
  const afterGap = changes();
  expect(model.commitImport(batch([gap('g1')], 0, 0))).toEqual({
    duplicate: true,
    offset: 0,
    ok: true,
  });
  expect(changes()).toBe(afterGap);
  expect(model.readSourceCursor(key)).toEqual(recorded);

  // A changed zero-progress batch conflicts with the recorded zero cursor.
  for (const changed of [gap('g1', { reason: 'different' }), gap('g1-again')]) {
    expect(model.commitImport(batch([changed], 0, 0))).toMatchObject({
      code: 'SPANS_MODEL_OFFSET_CONFLICT',
      ok: false,
    });
  }
  expect(model.readSourceCursor(key)).toEqual(recorded);
  expect(eventIds(db)).toEqual(['g1']);

  // Empty bytes after a recorded gap leave the digest and events alone.
  expect(model.commitImport(batch([], 0, 0)).ok).toBe(true);
  expect(changes()).toBe(afterGap);
  expect(model.readSourceCursor(key)).toEqual(recorded);

  // The corrected input advances normally from the retained offset.
  expect(model.commitImport(batch([message('m1')], 0, 40))).toEqual({
    duplicate: false,
    offset: 40,
    ok: true,
  });
  const advanced = model.readSourceCursor(key);
  expect(advanced).toMatchObject({ found: true, offset: 40, ok: true });
  expect(advanced.batchDigest).toMatch(digestPattern);
  expect(advanced.batchDigest).not.toBe(recorded.batchDigest);
  expect(eventIds(db)).toEqual(['g1', 'm1']);
  // The earlier zero-progress batch is now unknown history.
  expect(model.commitImport(batch([gap('g1')], 0, 0)).code).toBe(
    'SPANS_MODEL_OFFSET_CONFLICT'
  );

  // A gap after real progress is new evidence, not a conflict; then it is zero.
  expect(model.commitImport(batch([gap('g2')], 40, 40)).duplicate).toBe(false);
  expect(model.readSourceCursor(key).offset).toBe(40);
  expect(model.commitImport(batch([gap('g2')], 40, 40)).duplicate).toBe(true);
  expect(model.commitImport(batch([gap('g3')], 40, 40)).code).toBe(
    'SPANS_MODEL_OFFSET_CONFLICT'
  );
  expect(model.commitImport(batch([message('m2')], 40, 90)).offset).toBe(90);
  expect(eventIds(db)).toEqual(['g1', 'm1', 'g2', 'm2']);
});

// A database file prepared and closed so its bytes are final, then inspected on
// an ordinary read-write connection: inspect must not change a single byte or
// leave any sidecar file behind.
function inspectOnDisk(setup) {
  const path = tempDb();
  const prepared = new Database(path, { create: true, strict: true });
  for (const statement of eventSchema) {
    prepared.run(statement);
  }
  setup(prepared);
  prepared.close(true);
  const state = () => ({
    bytes: fs.readFileSync(path),
    files: fs.readdirSync(dirname(path)).sort(),
  });
  const before = state();
  const db = new Database(path, { strict: true });
  let outcome;
  try {
    outcome = inspectSpansModelSchema(db);
  } catch (error) {
    outcome = error;
  }
  db.close(true);
  const after = state();
  expect(after.bytes.equals(before.bytes)).toBe(true);
  expect(after.files).toEqual(before.files);
  return outcome;
}

const withModel =
  (
    mutate = () => {
      /* Intentionally leave the fixture unchanged. */
    }
  ) =>
  (db) => {
    createSpansModelStore({
      appendEvent: () => ({ ok: true }),
      db,
    }).closeStatements();
    mutate(db);
  };
const setVersion = (value) => (db) =>
  db
    .query('UPDATE metadata SET value = ? WHERE key = ?')
    .run(value, 'model_schema_version');

test('inspectSpansModelSchema is read-only and classifies empty, current, newer and drifted files', () => {
  expect(
    inspectOnDisk(() => {
      /* Intentionally leave the fixture unchanged. */
    })
  ).toBe('empty');
  expect(inspectOnDisk(withModel())).toBe('current');

  const expectCode = (setup, code) => {
    const outcome = inspectOnDisk(setup);
    expect(outcome).toBeInstanceOf(SpansModelError);
    expect(outcome.code).toBe(code);
  };
  // Newer or malformed versions, with and without the model tables present.
  expectCode(withModel(setVersion('2')), 'SPANS_STORE_SCHEMA_NEWER');
  expectCode(withModel(setVersion('999999999')), 'SPANS_STORE_SCHEMA_NEWER');
  expectCode(
    (db) =>
      db
        .query('INSERT INTO metadata (key, value) VALUES (?, ?)')
        .run('model_schema_version', '7'),
    'SPANS_STORE_SCHEMA_NEWER'
  );
  expectCode(withModel(setVersion('abc')), 'SPANS_STORE_SCHEMA_UNSUPPORTED');
  expectCode(withModel(setVersion('0')), 'SPANS_STORE_SCHEMA_UNSUPPORTED');
  // Drift: altered, missing or unversioned model tables.
  expectCode(
    withModel((db) => db.run('ALTER TABLE spans_cache ADD COLUMN extra TEXT')),
    'SPANS_STORE_SCHEMA_UNSUPPORTED'
  );
  expectCode(
    withModel((db) => db.run('DROP TABLE spans_views')),
    'SPANS_STORE_SCHEMA_UNSUPPORTED'
  );
  expectCode(
    withModel((db) =>
      db.run("DELETE FROM metadata WHERE key = 'model_schema_version'")
    ),
    'SPANS_STORE_SCHEMA_UNSUPPORTED'
  );
  expectCode(
    (db) =>
      db.run('CREATE TABLE spans_cache (cache_key TEXT, entry_json TEXT)'),
    'SPANS_STORE_SCHEMA_UNSUPPORTED'
  );
});

test('inspectSpansModelSchema issues only SELECTs and treats a bare database as empty', () => {
  const { db } = open();
  const sql = [];
  const view = {
    prepare() {
      throw new Error('inspect must not prepare');
    },
    query(text) {
      sql.push(text);
      return db.query(text);
    },
    run() {
      throw new Error('inspect must not run');
    },
    transaction() {
      throw new Error('inspect must not open a transaction');
    },
  };
  expect(inspectSpansModelSchema(view)).toBe('current');
  expect(sql.length).toBeGreaterThan(0);
  expect(sql.every((text) => selectPattern.test(text))).toBe(true);

  const bare = new Database(':memory:', { strict: true });
  try {
    expect(inspectSpansModelSchema(bare)).toBe('empty');
    // Empty is not permission to build: the store still needs event metadata.
    expect(constructionError(bare).code).toBe('SPANS_STORE_SCHEMA_UNSUPPORTED');
    expect(count(bare, 'sqlite_master')).toBe(0);
  } finally {
    bare.close(true);
  }
});

test('closeStatements finalizes every owned statement, repeats safely and closes the model', () => {
  const db = openDatabase(tempDb());
  const append = makeAppend(db);
  cleanups.push(() => release(db, null, append.statements));
  const prepared = [];
  const finalized = new Set();
  const spyDb = {
    prepare(sql) {
      const statement = db.prepare(sql);
      const proxy = new Proxy(statement, {
        get(target, property) {
          const value = Reflect.get(target, property, target);
          if (typeof value !== 'function') {
            return value;
          }
          return (...args) => {
            if (property === 'finalize') {
              finalized.add(proxy);
            }
            return value.apply(target, args);
          };
        },
      });
      prepared.push(proxy);
      return proxy;
    },
    query: (sql) => db.query(sql),
    run: (...args) => db.run(...args),
    transaction() {
      throw new Error('db.transaction must not be used');
    },
  };
  const model = createSpansModelStore({ appendEvent: append, db: spyDb });

  expect(prepared.length).toBeGreaterThan(0);
  expect(finalized.size).toBe(0);
  expect(commit(model, 'run-1', 0, 0, { generation: 0 }).ok).toBe(true);
  expect(model.closeStatements()).toEqual({ ok: true });
  expect(finalized.size).toBe(prepared.length);
  expect(model.closeStatements()).toEqual({ ok: true });

  expect(model.readRun({ runId: 'run-1' }).code).toBe('SPANS_MODEL_CLOSED');
  expect(commit(model, 'run-1', 1, 0, { generation: 0 }).code).toBe(
    'SPANS_MODEL_CLOSED'
  );
  expect(model.listRuns().code).toBe('SPANS_MODEL_CLOSED');
  expect(model.readCache('derived:k1').code).toBe('SPANS_MODEL_CLOSED');
  expect(
    model.readSourceCursor({
      parserVersion: 'parser-1',
      sourceGeneration: 1,
      sourceId: 'src-1',
    }).code
  ).toBe('SPANS_MODEL_CLOSED');
});
