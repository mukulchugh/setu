import { Database } from 'bun:sqlite';
import { afterEach, expect, test } from 'bun:test';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createSpansSearch,
  initializeSpansSearchSchema,
  inspectSpansSearchSchema,
  SPANS_SEARCH_LIMITS,
  SpansSearchError,
} from './spans-search.js';
import { openSpansStore, SPANS_STORE_DATABASE_FILE } from './spans-store.js';

const databases = [];
const services = [];
const roots = [];
const databaseRoots = new WeakMap();

afterEach(() => {
  while (services.length > 0) {
    services.pop().close();
  }
  while (databases.length > 0) {
    try {
      databases.pop().close(true);
    } catch {
      // A failed close must not hide the assertion that caused the test to fail.
    }
  }
  while (roots.length > 0) {
    fs.rmSync(roots.pop(), { force: true, recursive: true });
  }
});

function database() {
  const root = fs.mkdtempSync(join(tmpdir(), 'setu-spans-search-test-'));
  roots.push(root);
  const store = openSpansStore({ root });
  expect(store.close()).toEqual({ ok: true });
  const db = new Database(join(root, SPANS_STORE_DATABASE_FILE), {
    readwrite: true,
    strict: true,
  });
  databases.push(db);
  databaseRoots.set(db, root);
  return db;
}

function append(db, eventId, payload, { runId = 'run-a', type = 'note' } = {}) {
  appendMany(db, [{ eventId, payload, runId, type }]);
}

function appendMany(db, events) {
  const store = openSpansStore({ root: databaseRoots.get(db) });
  try {
    for (const event of events) {
      expect(store.appendEvent(event)).toMatchObject({ ok: true });
    }
  } finally {
    expect(store.close()).toEqual({ ok: true });
  }
}

function openSearch(db, textForEvent = (event) => event.payload.text ?? '') {
  const service = createSpansSearch({ db, textForEvent });
  services.push(service);
  return service;
}

const canonicalText = (event) =>
  [event.payload.summary, event.payload.artifactText]
    .filter((value) => typeof value === 'string')
    .join('\n');

function searchCount(db) {
  return db.query('SELECT COUNT(*) AS count FROM spans_search').get().count;
}

test('schema inspection is read-only and initialization creates the approved FTS5 shape', () => {
  const db = database();
  expect(inspectSpansSearchSchema(db)).toBe('empty');
  expect(initializeSpansSearchSchema(db)).toEqual({ ok: true, version: 1 });
  expect(inspectSpansSearchSchema(db)).toBe('current');
  expect(
    db
      .query('SELECT value FROM metadata WHERE key = ?')
      .get('search_schema_version').value
  ).toBe('1');
  expect(
    db
      .query('SELECT name FROM pragma_table_info(?) ORDER BY cid')
      .all('spans_search')
      .map((row) => row.name)
  ).toEqual(['run_id', 'event_id', 'body']);
  const before = db
    .query(
      "SELECT name, sql FROM sqlite_master WHERE name LIKE 'spans_search%' ORDER BY name"
    )
    .all();
  expect(initializeSpansSearchSchema(db)).toEqual({ ok: true, version: 1 });
  expect(
    db
      .query(
        "SELECT name, sql FROM sqlite_master WHERE name LIKE 'spans_search%' ORDER BY name"
      )
      .all()
  ).toEqual(before);
});

test('newer, malformed and partial search schemas are refused without mutation', () => {
  for (const value of ['2', '0', '01', 'unknown']) {
    const db = database();
    db.query('INSERT INTO metadata (key, value) VALUES (?, ?)').run(
      'search_schema_version',
      value
    );
    const before = db
      .query('SELECT name, sql FROM sqlite_master ORDER BY name')
      .all();
    let error;
    try {
      initializeSpansSearchSchema(db);
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(SpansSearchError);
    expect(error.code).toBe(
      value === '2'
        ? 'SPANS_STORE_SCHEMA_NEWER'
        : 'SPANS_STORE_SCHEMA_UNSUPPORTED'
    );
    expect(
      db.query('SELECT name, sql FROM sqlite_master ORDER BY name').all()
    ).toEqual(before);
  }

  const partial = database();
  partial.run(
    'CREATE TABLE spans_search_progress (singleton INTEGER PRIMARY KEY)'
  );
  const before = partial
    .query('SELECT name, sql FROM sqlite_master ORDER BY name')
    .all();
  expect(() => initializeSpansSearchSchema(partial)).toThrow(SpansSearchError);
  expect(
    partial.query('SELECT name, sql FROM sqlite_master ORDER BY name').all()
  ).toEqual(before);
});

test('construction is explicit and does not automatically index canonical history', () => {
  const db = database();
  append(db, 'event-1', { text: 'fixture words' });
  expect(() => createSpansSearch({ db, textForEvent: canonicalText })).toThrow(
    SpansSearchError
  );
  initializeSpansSearchSchema(db);
  const search = openSearch(db, canonicalText);
  expect(searchCount(db)).toBe(0);
  expect(search.status()).toMatchObject({
    coverage: {
      complete: false,
      indexedSequence: 0,
      latestSequence: 1,
      stale: true,
    },
    ok: true,
  });
});

test('bounded pages index redacted selected text and resume after close/reopen', () => {
  const db = database();
  append(db, 'event-1', {
    artifactText: 'artifact uses Bearer abcdefghijklmnop',
    rawTranscript: 'private imported transcript',
    sourcePath: '/Users/example/private/session.jsonl',
    summary: 'Build note sk-proj-abcdefghijklmnop',
  });
  append(db, 'event-2', { summary: 'second build note' }, { runId: 'run-b' });
  initializeSpansSearchSchema(db);
  let search = openSearch(db, canonicalText);

  expect(search.indexPage({ limit: 1 })).toMatchObject({
    coverage: {
      complete: false,
      indexedSequence: 1,
      latestSequence: 2,
      stale: true,
    },
    hasMore: true,
    indexed: 1,
    nextSequence: 1,
    ok: true,
  });
  expect(searchCount(db)).toBe(1);
  const stored = db.query('SELECT body FROM spans_search').get().body;
  expect(stored).toContain('[REDACTED]');
  expect(stored).not.toContain('abcdefghijklmnop');
  expect(stored).not.toContain('private imported transcript');
  expect(stored).not.toContain('/Users/example');
  expect(search.indexPage({ limit: 1 })).toMatchObject({
    coverage: {
      complete: true,
      indexedSequence: 2,
      latestSequence: 2,
      stale: false,
    },
    hasMore: false,
    indexed: 1,
    nextSequence: 2,
    ok: true,
  });

  search.close();
  const root = databaseRoots.get(db);
  db.close(true);
  const reopenedDb = new Database(join(root, SPANS_STORE_DATABASE_FILE), {
    readwrite: true,
    strict: true,
  });
  databases.push(reopenedDb);
  databaseRoots.set(reopenedDb, root);
  search = openSearch(reopenedDb, canonicalText);
  expect(search.status()).toMatchObject({
    coverage: {
      complete: true,
      indexedSequence: 2,
      latestSequence: 2,
      stale: false,
    },
    generation: 0,
    ok: true,
  });
  expect(search.query({ limit: 10, query: 'build note' })).toMatchObject({
    generation: 0,
    hits: [
      { eventId: 'event-1', historical: true, runId: 'run-a', sequence: 1 },
      { eventId: 'event-2', historical: true, runId: 'run-b', sequence: 2 },
    ],
    ok: true,
    throughSequence: 2,
  });
  expect(search.query({ limit: 10, query: 'artifact' }).hits).toEqual([
    expect.objectContaining({ eventId: 'event-1', sequence: 1 }),
  ]);
  expect(search.query({ limit: 10, query: 'abcdefghijklmnop' }).hits).toEqual(
    []
  );
  // A replay from an already-complete cursor is a no-op, not a duplicate row.
  expect(search.indexPage({ limit: 2 })).toMatchObject({
    indexed: 0,
    ok: true,
  });
  expect(searchCount(reopenedDb)).toBe(2);
});

test('a maximum supported document advances within the page budget and resumes', () => {
  const db = database();
  append(db, 'event-1', { text: 'first' });
  append(db, 'event-2', { text: 'second' });
  initializeSpansSearchSchema(db);
  const document = 'boundary '.repeat(
    Math.floor(SPANS_SEARCH_LIMITS.documentBytes / 9)
  );
  const search = openSearch(db, () => document);

  const first = search.indexPage({ limit: 2 });
  expect(first).toMatchObject({
    hasMore: true,
    indexed: 1,
    nextSequence: 1,
    ok: true,
  });
  expect(search.status()).toMatchObject({
    coverage: { indexedSequence: 1, latestSequence: 2, stale: true },
    ok: true,
  });

  expect(search.indexPage({ limit: 2 })).toMatchObject({
    coverage: { complete: true, indexedSequence: 2, latestSequence: 2 },
    hasMore: false,
    indexed: 1,
    nextSequence: 2,
    ok: true,
  });
});

test('search document bounds count actual UTF-8 bytes for lone surrogates', () => {
  const db = database();
  append(db, 'event-1', { text: 'fixture' });
  initializeSpansSearchSchema(db);
  const oversized = `${'x'.repeat(SPANS_SEARCH_LIMITS.documentBytes - 2)}\ud800`;
  const search = openSearch(db, () => oversized);

  expect(search.indexPage({ limit: 1 })).toMatchObject({
    code: 'SPANS_SEARCH_TEXT_INVALID',
    ok: false,
  });
  expect(search.status()).toMatchObject({
    coverage: { indexedSequence: 0, latestSequence: 1, stale: true },
    ok: true,
  });
});

test('literal query parsing blocks FTS operators and validates bounded cursors', () => {
  const db = database();
  append(db, 'event-1', { text: 'alpha beta gamma' });
  initializeSpansSearchSchema(db);
  const search = openSearch(db);
  search.indexPage({ limit: 10 });

  expect(search.query({ limit: 10, query: 'alpha" OR *:* --' })).toMatchObject({
    hits: [],
    ok: true,
  });
  expect(
    search.query({ limit: SPANS_SEARCH_LIMITS.queryPage + 1, query: 'alpha' })
  ).toMatchObject({
    code: 'SPANS_SEARCH_QUERY_INVALID',
    ok: false,
  });
  expect(
    search.indexPage({ limit: SPANS_SEARCH_LIMITS.indexPage + 1 })
  ).toMatchObject({
    code: 'SPANS_SEARCH_INVALID',
    ok: false,
  });
  expect(
    search.query({ limit: 1, query: 'alpha', throughSequence: 99 })
  ).toMatchObject({
    code: 'SPANS_SEARCH_QUERY_INVALID',
    ok: false,
  });
  expect(search.query({ limit: 1, query: '*** ---' })).toMatchObject({
    code: 'SPANS_SEARCH_QUERY_INVALID',
    ok: false,
  });
});

test('sequence pagination stays stable when later matching events arrive', () => {
  const db = database();
  append(db, 'event-1', { text: 'shared term one' });
  append(db, 'event-2', { text: 'shared term two' });
  append(db, 'event-3', { text: 'shared term three' });
  initializeSpansSearchSchema(db);
  const search = openSearch(db);
  search.indexPage({ limit: 10 });

  const first = search.query({ afterSequence: 0, limit: 1, query: 'shared' });
  expect(first).toMatchObject({
    generation: 0,
    hasMore: true,
    throughSequence: 3,
  });
  append(db, 'event-4', { text: 'shared term four' });
  search.indexPage({ limit: 10 });
  const second = search.query({
    afterSequence: first.nextSequence,
    expectedGeneration: first.generation,
    limit: 1,
    query: 'shared',
    throughSequence: first.throughSequence,
  });
  const third = search.query({
    afterSequence: second.nextSequence,
    expectedGeneration: second.generation,
    limit: 1,
    query: 'shared',
    throughSequence: first.throughSequence,
  });
  expect([first, second, third].map((page) => page.hits[0].sequence)).toEqual([
    1, 2, 3,
  ]);
  expect(third.hasMore).toBe(false);
});

test('continuations require and enforce the generation from their first page', () => {
  const db = database();
  append(db, 'event-1', { text: 'shared first' });
  append(db, 'event-2', { text: 'shared second' });
  initializeSpansSearchSchema(db);
  const search = openSearch(db);
  search.indexPage({ limit: 10 });

  const first = search.query({ limit: 1, query: 'shared' });
  expect(first.hasMore).toBe(true);
  expect(
    search.query({
      afterSequence: first.nextSequence,
      limit: 1,
      query: 'shared',
    })
  ).toMatchObject({ code: 'SPANS_SEARCH_QUERY_INVALID', ok: false });

  search.invalidate();
  expect(
    search.query({
      afterSequence: first.nextSequence,
      expectedGeneration: first.generation,
      limit: 1,
      query: 'shared',
      throughSequence: first.throughSequence,
    })
  ).toMatchObject({ code: 'SPANS_SEARCH_STALE_GENERATION', ok: false });
});

test('index pages cap aggregate payload bytes and advance only through indexed rows', () => {
  const db = database();
  appendMany(
    db,
    Array.from({ length: 17 }, (_, index) => ({
      eventId: `event-${index + 1}`,
      payload: { text: 'x'.repeat(250_000) },
      runId: 'run-a',
      type: 'note',
    }))
  );
  initializeSpansSearchSchema(db);
  const search = openSearch(db);

  expect(search.indexPage({ limit: 17 })).toMatchObject({
    coverage: { indexedSequence: 16, latestSequence: 17, stale: true },
    hasMore: true,
    indexed: 16,
    nextSequence: 16,
    ok: true,
  });
  expect(searchCount(db)).toBe(16);
  expect(search.indexPage({ limit: 17 })).toMatchObject({
    coverage: { indexedSequence: 17, latestSequence: 17, stale: false },
    hasMore: false,
    indexed: 1,
    nextSequence: 17,
    ok: true,
  });
});

test('tampered canonical payloads or digests roll back index rows and cursor progress', () => {
  for (const tamper of ['payload', 'digest']) {
    const db = database();
    append(db, 'event-1', { text: 'valid fixture' });
    initializeSpansSearchSchema(db);
    db.run('DROP TRIGGER events_reject_update');
    if (tamper === 'payload') {
      db.query('UPDATE events SET payload_json = ? WHERE event_id = ?').run(
        '{"text":"tampered fixture"}',
        'event-1'
      );
    } else {
      db.query('UPDATE events SET input_digest = ? WHERE event_id = ?').run(
        '0'.repeat(64),
        'event-1'
      );
    }
    const search = openSearch(db);

    expect(search.indexPage({ limit: 1 })).toMatchObject({
      code: 'SPANS_SEARCH_EVENT_INVALID',
      ok: false,
    });
    expect(searchCount(db)).toBe(0);
    expect(search.status()).toMatchObject({
      coverage: { indexedSequence: 0, latestSequence: 1, stale: true },
      ok: true,
    });
  }
});

test('query snippets are redacted again after derived index corruption', () => {
  const db = database();
  append(db, 'event-1', { text: 'safe fixture' });
  initializeSpansSearchSchema(db);
  const search = openSearch(db);
  search.indexPage({ limit: 1 });
  db.query('UPDATE spans_search SET body = ? WHERE event_id = ?').run(
    'Bearer abcdefghijklmnop',
    'event-1'
  );

  const response = search.query({ limit: 1, query: 'Bearer' });
  expect(response.hits[0].snippet).toContain('Bearer [REDACTED]');
  expect(response.hits[0].snippet).not.toContain('abcdefghijklmnop');
});

test('an interrupted index page rolls back both FTS rows and its cursor', () => {
  const db = database();
  append(db, 'event-1', { text: 'first fixture' });
  append(db, 'event-2', { text: 'second fixture' });
  initializeSpansSearchSchema(db);
  let calls = 0;
  const failing = openSearch(db, () => {
    calls += 1;
    if (calls === 2) {
      throw new Error('sensitive adapter detail');
    }
    return `indexed text ${calls}`;
  });
  expect(failing.indexPage({ limit: 2 })).toMatchObject({
    code: 'SPANS_SEARCH_SOURCE_FAILED',
    error: 'Searchable text could not be read; the page was not committed.',
    ok: false,
  });
  expect(searchCount(db)).toBe(0);
  expect(failing.status()).toMatchObject({
    coverage: { indexedSequence: 0, latestSequence: 2, stale: true },
    ok: true,
  });

  failing.close();
  const retry = openSearch(db, () => 'recovered fixture');
  expect(retry.indexPage({ limit: 2 })).toMatchObject({ indexed: 2, ok: true });
  expect(searchCount(db)).toBe(2);
});

test('a failed replacement page rolls back its range delete, inserts and cursor', () => {
  const db = database();
  appendMany(db, [
    {
      eventId: 'event-1',
      payload: { text: 'old first' },
      runId: 'run-a',
      type: 'note',
    },
    {
      eventId: 'event-2',
      payload: { text: 'old second' },
      runId: 'run-a',
      type: 'note',
    },
  ]);
  initializeSpansSearchSchema(db);
  const search = openSearch(db);
  expect(search.indexPage({ limit: 2 })).toMatchObject({
    indexed: 2,
    ok: true,
  });
  search.invalidate();
  const failingDb = {
    prepare(sql) {
      const statement = db.prepare(sql);
      if (sql.startsWith('INSERT INTO spans_search')) {
        return {
          finalize: () => statement.finalize(),
          run() {
            throw new Error('fixture insert failure');
          },
        };
      }
      return statement;
    },
    run: (sql) => db.run(sql),
  };

  expect(
    openSearch(
      failingDb,
      (event) => `replacement ${event.payload.text}`
    ).indexPage({ limit: 2 })
  ).toMatchObject({ ok: false });
  expect(
    db.query('SELECT event_id, body FROM spans_search ORDER BY event_id').all()
  ).toEqual([
    { body: 'old first', event_id: 'event-1' },
    { body: 'old second', event_id: 'event-2' },
  ]);
  expect(search.status()).toMatchObject({
    coverage: { indexedSequence: 0, latestSequence: 2, stale: true },
    ok: true,
  });
});

test('a byte-limited replacement page preserves old rows beyond its prepared range', () => {
  const db = database();
  appendMany(
    db,
    Array.from({ length: 3 }, (_, index) => ({
      eventId: `event-${index + 1}`,
      payload: { text: `old-${index + 1}` },
      runId: 'run-a',
      type: 'note',
    }))
  );
  initializeSpansSearchSchema(db);
  const search = openSearch(db);
  expect(search.indexPage({ limit: 3 })).toMatchObject({
    indexed: 3,
    ok: true,
  });
  search.invalidate();
  const largeText = 'x'.repeat(4_194_300);

  expect(
    openSearch(db, (event) =>
      event.sequence < 3 ? largeText : 'new-third'
    ).indexPage({ limit: 3 })
  ).toMatchObject({ hasMore: true, indexed: 1, nextSequence: 1, ok: true });
  expect(
    db.query('SELECT event_id, body FROM spans_search ORDER BY event_id').all()
  ).toEqual([
    { body: largeText, event_id: 'event-1' },
    { body: 'old-2', event_id: 'event-2' },
    { body: 'old-3', event_id: 'event-3' },
  ]);
  expect(search.status()).toMatchObject({
    coverage: { indexedSequence: 1, latestSequence: 3, stale: true },
    ok: true,
  });
});

test('an empty replacement removes the prior derived row', () => {
  const db = database();
  append(db, 'event-1', { text: 'old searchable text' });
  initializeSpansSearchSchema(db);
  const search = openSearch(db);
  search.indexPage({ limit: 1 });
  search.invalidate();

  expect(openSearch(db, () => '').indexPage({ limit: 1 })).toMatchObject({
    indexed: 1,
    ok: true,
  });
  expect(searchCount(db)).toBe(0);
});

test('correction invalidation preserves old evidence and exposes stale generation until rebuilt', () => {
  const db = database();
  append(db, 'event-1', { text: 'original finding' });
  append(db, 'event-2', { text: 'retained old result' });
  initializeSpansSearchSchema(db);
  const search = openSearch(db);
  search.indexPage({ limit: 10 });
  append(
    db,
    'event-3',
    { text: 'corrected finding' },
    { type: 'source.corrected' }
  );

  const invalidated = search.invalidate();
  expect(invalidated).toMatchObject({ generation: 1, ok: true });
  expect(searchCount(db)).toBe(2);
  expect(search.status()).toMatchObject({
    coverage: {
      complete: false,
      generation: 1,
      indexedSequence: 0,
      stale: true,
    },
    ok: true,
  });
  expect(search.query({ limit: 10, query: 'original' })).toMatchObject({
    hits: [],
    throughSequence: 0,
  });

  expect(search.indexPage({ limit: 1 })).toMatchObject({
    coverage: {
      complete: false,
      generation: 1,
      indexedSequence: 1,
      stale: true,
    },
    indexed: 1,
    ok: true,
  });
  expect(search.query({ limit: 10, query: 'retained' })).toMatchObject({
    hits: [],
    throughSequence: 1,
  });
  expect(search.indexPage({ limit: 1 })).toMatchObject({
    coverage: {
      complete: false,
      generation: 1,
      indexedSequence: 2,
      stale: true,
    },
    indexed: 1,
    ok: true,
  });
  expect(search.query({ limit: 10, query: 'retained' }).hits).toEqual([
    expect.objectContaining({ eventId: 'event-2', sequence: 2 }),
  ]);
  expect(search.indexPage({ limit: 1 })).toMatchObject({
    coverage: {
      complete: true,
      generation: 1,
      indexedSequence: 3,
      stale: false,
    },
    indexed: 1,
    ok: true,
  });
  expect(searchCount(db)).toBe(3);
  expect(db.query('SELECT COUNT(*) AS count FROM events').get().count).toBe(3);
  expect(search.query({ limit: 10, query: 'original' }).hits).toEqual([
    expect.objectContaining({ eventId: 'event-1', historical: true }),
  ]);
});

test('adapter failures, invalid requests and closed lifetime return bounded failures', () => {
  const db = database();
  append(db, 'event-1', { text: 'fixture' });
  initializeSpansSearchSchema(db);
  const search = openSearch(db, () => {
    throw new Error('/private/path and secret=do-not-return');
  });
  expect(search.indexPage({ limit: 1 })).toMatchObject({
    code: 'SPANS_SEARCH_SOURCE_FAILED',
    ok: false,
  });
  expect(search.indexPage({ limit: 0 })).toMatchObject({
    code: 'SPANS_SEARCH_INVALID',
    ok: false,
  });
  expect(search.close()).toEqual({ ok: true });
  expect(search.indexPage({ limit: 1 })).toMatchObject({
    code: 'SPANS_SEARCH_CLOSED',
    ok: false,
  });
});

test('a commit exception is reported as unknown and is resolved by rereading progress', () => {
  const db = database();
  append(db, 'event-1', { text: 'committed fixture' });
  initializeSpansSearchSchema(db);
  let failCommit = true;
  const uncertainDb = {
    prepare: (sql) => db.prepare(sql),
    run(sql) {
      const result = db.run(sql);
      if (sql === 'COMMIT' && failCommit) {
        failCommit = false;
        throw new Error('response lost after commit');
      }
      return result;
    },
  };
  const search = openSearch(uncertainDb);
  expect(search.indexPage({ limit: 1 })).toMatchObject({
    code: 'SPANS_SEARCH_OUTCOME_UNKNOWN',
    ok: false,
  });
  expect(search.status()).toMatchObject({
    coverage: {
      complete: true,
      indexedSequence: 1,
      latestSequence: 1,
      stale: false,
    },
    ok: true,
  });
  expect(searchCount(db)).toBe(1);
});
