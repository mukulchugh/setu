const APPEND_ONLY_ERROR = /append-only/;

import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  openSpansStore,
  SPANS_STORE_DATABASE_FILE,
  SPANS_STORE_LIMITS,
  SpansStoreError,
} from './spans-store.js';

// Every payload below is synthetic and already "redacted": redaction is the
// caller's boundary, so this store is only ever handed safe fixtures.
const BUSY_MS = 50;
const STAMP = 1_700_000_000_000;
const ROOT_INVALID = 'SPANS_STORE_ROOT_INVALID';
const OPTIONS_INVALID = 'SPANS_STORE_OPTIONS_INVALID';
const UNSAFE_PATH = 'SPANS_STORE_UNSAFE_PATH';
const UNSAFE_PERMISSIONS = 'SPANS_STORE_UNSAFE_PERMISSIONS';
const UNSUPPORTED = 'SPANS_STORE_SCHEMA_UNSUPPORTED';

function scenario(run) {
  const root = fs.mkdtempSync(join(tmpdir(), 'setu-spans-store-test-'));
  const stores = [];
  const open = (options = {}) => {
    const store = openSpansStore({ busyTimeoutMs: BUSY_MS, root, ...options });
    stores.push(store);
    return store;
  };
  try {
    return run({ open, root });
  } finally {
    for (const store of stores) {
      store.close();
    }
    fs.rmSync(root, { force: true, recursive: true });
  }
}

const databasePath = (root) => join(root, SPANS_STORE_DATABASE_FILE);
const modeOf = (path) => fs.lstatSync(path).mode % 0o1000;

function sample(number, overrides = {}) {
  return {
    eventId: `event-${number}`,
    payload: { at: STAMP, number },
    runId: 'run-a',
    type: 'span.recorded',
    ...overrides,
  };
}

function openError(options) {
  try {
    openSpansStore(options);
  } catch (error) {
    return error;
  }
}

function expectRefused(root, code, options = {}) {
  const error = openError({ busyTimeoutMs: BUSY_MS, root, ...options });
  expect(error).toBeInstanceOf(SpansStoreError);
  expect(error.code).toBe(code);
  // Errors carry codes and phases only, never raw paths.
  expect(error.message).not.toContain(root);
  return error;
}

function fileState(root) {
  return {
    database: createHash('sha256')
      .update(fs.readFileSync(databasePath(root)))
      .digest('hex'),
    names: fs.readdirSync(root).sort(),
  };
}

// Builds a database with raw SQL so schema refusals are tested against bytes
// this module did not write. The file starts private (0600) so the refusal
// under test is the schema one, not the permission one.
function seedDatabase(root, statements, { wal = false } = {}) {
  const path = databasePath(root);
  fs.writeFileSync(path, '', { mode: 0o600 });
  fs.chmodSync(path, 0o600);
  const raw = new Database(path, { readwrite: true, strict: true });
  try {
    raw.run(`PRAGMA journal_mode = ${wal ? 'WAL' : 'DELETE'}`);
    for (const statement of statements) {
      raw.run(statement);
    }
    if (wal) {
      raw.run('PRAGMA wal_checkpoint(TRUNCATE)');
    }
  } finally {
    raw.close(true);
  }
  return path;
}

// Edits a closed store's database and leaves it in rollback-journal mode, so a
// refused open has no WAL traffic that could legitimately touch any bytes.
function tamperDatabase(root, statements) {
  const raw = new Database(databasePath(root), {
    readwrite: true,
    strict: true,
  });
  try {
    for (const statement of statements) {
      raw.run(statement);
    }
    raw.run('PRAGMA journal_mode = DELETE');
  } finally {
    raw.close(true);
  }
}

const sequencesOf = (page) => page.events.map((item) => item.sequence);

// Wraps a leaf in `depth` arrays, so containers occupy depths 0..depth-1.
function nest(depth) {
  let value = 'leaf';
  for (let level = 0; level < depth; level += 1) {
    value = [value];
  }
  return value;
}

test('persists events across close and reopen with continuing sequences', () => {
  scenario(({ open }) => {
    const first = open();
    expect(first.appendEvent(sample(1))).toEqual({
      event: {
        eventId: 'event-1',
        payload: { at: STAMP, number: 1 },
        runId: 'run-a',
        sequence: 1,
        type: 'span.recorded',
      },
      ok: true,
    });
    expect(
      first.appendEvent(sample(2, { runId: 'run-b' })).event.sequence
    ).toBe(2);
    expect(first.close()).toEqual({ ok: true });

    const second = open();
    expect(second.readEvents({ runId: 'run-a' })).toEqual({
      events: [
        {
          eventId: 'event-1',
          payload: { at: STAMP, number: 1 },
          runId: 'run-a',
          sequence: 1,
          type: 'span.recorded',
        },
      ],
      hasMore: false,
      nextSequence: 1,
      ok: true,
    });
    expect(second.appendEvent(sample(3)).event.sequence).toBe(3);
    expect(sequencesOf(second.readEvents({ runId: 'run-a' }))).toEqual([1, 3]);
  });
});

test('stores canonical payloads and never aliases caller or returned objects', () => {
  scenario(({ open }) => {
    const store = open();
    const payload = JSON.parse('{"z":1,"a":{"y":[1,{"b":2,"a":1}],"x":null}}');
    const canonical = '{"a":{"x":null,"y":[1,{"a":1,"b":2}]},"z":1}';
    const appended = store.appendEvent(sample(1, { payload }));
    expect(JSON.stringify(appended.event.payload)).toBe(canonical);

    payload.z = 99;
    appended.event.payload.a = 'changed after append';
    const read = store.readEvents({ runId: 'run-a' });
    expect(JSON.stringify(read.events[0].payload)).toBe(canonical);
    read.events[0].payload.z = 100;
    expect(
      JSON.stringify(store.readEvents({ runId: 'run-a' }).events[0].payload)
    ).toBe(canonical);
  });
});

test('accepts every JSON value shape and the documented size and depth limits', () => {
  scenario(({ open }) => {
    const store = open();
    // Line separator, an astral character, NUL and a lone surrogate must all
    // round-trip; they are built from code units to keep the source plain ASCII.
    const awkward = `line\nbreak ${String.fromCodePoint(0x20_28, 0x1_f6_00)} nul\0 lone${String.fromCharCode(0xd8_00)}`;
    const payloads = [
      null,
      true,
      false,
      0,
      1.5,
      -7,
      '',
      'text',
      awkward,
      [],
      {},
      [1, 'a', null, [true]],
      { nested: { list: [{}] } },
      'x'.repeat(SPANS_STORE_LIMITS.payloadBytes - 2),
      nest(SPANS_STORE_LIMITS.payloadDepth),
    ];
    const results = payloads.map((payload, index) =>
      store.appendEvent(sample(index, { payload }))
    );
    expect(results.map((result) => result.ok)).toEqual(
      payloads.map(() => true)
    );
    expect(
      store
        .readEvents({ limit: SPANS_STORE_LIMITS.pageLimit, runId: 'run-a' })
        .events.map((item) => item.payload)
    ).toEqual(payloads);

    const boundaries = [
      { eventId: 'a'.repeat(128) },
      { runId: 'a'.repeat(128) },
      { type: 'A.b_c:d-e' },
    ];
    for (const [index, overrides] of boundaries.entries()) {
      expect(store.appendEvent(sample(100 + index, overrides)).ok).toBe(true);
    }
  });
});

test('repeating an event id with identical canonical input returns the existing event', () => {
  scenario(({ open }) => {
    const store = open();
    const original = store.appendEvent(
      sample(1, { payload: JSON.parse('{"b":2,"a":1}') })
    );
    const replay = store.appendEvent(
      sample(1, { payload: JSON.parse('{"a":1,"b":2}') })
    );
    expect(replay).toEqual(original);
    // A replay consumes no sequence number and adds no row.
    expect(store.appendEvent(sample(2)).event.sequence).toBe(2);
    expect(
      store.readEvents({ runId: 'run-a' }).events.map((item) => item.eventId)
    ).toEqual(['event-1', 'event-2']);

    store.close();
    expect(open().appendEvent(sample(1, { payload: { a: 1, b: 2 } }))).toEqual(
      original
    );
  });
});

test('reusing an event id with changed input conflicts and keeps the original', () => {
  scenario(({ open }) => {
    const store = open();
    const original = store.appendEvent(sample(1));
    const changes = [
      { payload: { at: STAMP, number: 999 } },
      { runId: 'run-b' },
      { type: 'span.changed' },
      { payload: { secret: 'synthetic-sentinel' } },
    ];
    for (const change of changes) {
      const result = store.appendEvent(sample(1, change));
      expect(result).toMatchObject({ code: 'SPANS_EVENT_CONFLICT', ok: false });
      expect(typeof result.error).toBe('string');
      expect(JSON.stringify(result)).not.toContain('synthetic-sentinel');
    }
    expect(store.readEvents({ runId: 'run-a' }).events).toEqual([
      original.event,
    ]);
    expect(store.readEvents({ runId: 'run-b' }).events).toEqual([]);
    expect(store.appendEvent(sample(2)).event.sequence).toBe(2);
  });
});

test('rejects malformed identities, non-JSON payloads and malformed records', () => {
  scenario(({ open }) => {
    const store = open();
    const cyclic = {};
    cyclic.self = cyclic;
    const sparse = [];
    sparse[2] = 'x';
    const tagged = [1];
    tagged.extra = true;
    class Custom {
      constructor() {
        this.a = 1;
      }
    }
    const accessor = Object.defineProperty({}, 'a', {
      enumerable: true,
      get: () => 1,
    });
    const hidden = Object.defineProperty({}, 'a', {
      enumerable: false,
      value: 1,
    });
    // 87,382 euro signs fit the unit budget but not the 256 KiB byte budget.
    const multibyte = String.fromCharCode(0x20_ac).repeat(
      Math.ceil(SPANS_STORE_LIMITS.payloadBytes / 3)
    );
    const payloadCases = [
      ['undefined', undefined],
      ['function', () => 1],
      ['symbol', Symbol('s')],
      ['bigint', 1n],
      ['NaN', Number.NaN],
      ['Infinity', Number.POSITIVE_INFINITY],
      ['-Infinity', Number.NEGATIVE_INFINITY],
      ['undefined member', { a: undefined }],
      ['undefined element', [undefined]],
      ['date', new Date(0)],
      ['map', new Map()],
      ['set', new Set()],
      ['bytes', new Uint8Array(1)],
      ['class instance', new Custom()],
      ['cycle', cyclic],
      ['sparse array', sparse],
      ['array property', tagged],
      ['accessor', accessor],
      ['hidden member', hidden],
      ['symbol key', { [Symbol('k')]: 1 }],
      ['too deep', nest(SPANS_STORE_LIMITS.payloadDepth + 1)],
      ['too large', 'x'.repeat(SPANS_STORE_LIMITS.payloadBytes - 1)],
      ['too many bytes', multibyte],
    ];
    const badIdentities = [
      '',
      ' ',
      'a b',
      'a/b',
      'a\\b',
      '..',
      '.hidden',
      '-flag',
      '_leading',
      'new\nline',
      'nul\0',
      `caf${String.fromCharCode(0xe9)}`,
      'x'.repeat(129),
      1,
      null,
      undefined,
      {},
      [],
    ];
    const { payload: _omitted, ...withoutPayload } = sample(1);
    const shapeCases = [
      ['null', null],
      ['undefined', undefined],
      ['string', 'event'],
      ['number', 1],
      ['array', []],
      ['empty object', {}],
      ['missing payload', withoutPayload],
      ['caller-chosen sequence', { ...sample(1), sequence: 99 }],
      ['unknown key', { ...sample(1), at: STAMP }],
      ['class instance', new Custom()],
    ];
    const cases = [
      ...payloadCases.map(([label, payload]) => [
        `payload: ${label}`,
        sample(1, { payload }),
      ]),
      ...['eventId', 'runId', 'type'].flatMap((field) =>
        badIdentities.map((value) => [
          `${field}: ${String(value)}`,
          sample(1, { [field]: value }),
        ])
      ),
      ...shapeCases.map(([label, input]) => [`shape: ${label}`, input]),
    ];
    const outcomes = cases.map(([label, input]) => {
      const result = store.appendEvent(input);
      return [label, result.ok, result.code];
    });
    expect(outcomes).toEqual(
      cases.map(([label]) => [label, false, 'SPANS_EVENT_INVALID'])
    );
    expect(store.appendEvent(cases[0][1]).error).toBeString();

    // Nothing was stored and no sequence number was consumed.
    expect(store.readEvents({ runId: 'run-a' }).events).toEqual([]);
    expect(store.appendEvent(sample(1)).event.sequence).toBe(1);
  });
});

test('equal timestamps keep strictly increasing sequences and read in commit order', () => {
  scenario(({ open }) => {
    const store = open();
    // Event ids deliberately sort differently from commit order.
    const ids = ['zulu', 'alpha', 'mike', 'bravo', 'yankee'];
    const sequences = ids.map(
      (eventId, index) =>
        store.appendEvent(
          sample(index, {
            eventId,
            payload: { at: STAMP },
            runId: index % 2 === 0 ? 'run-a' : 'run-b',
          })
        ).event.sequence
    );
    expect(sequences).toEqual([1, 2, 3, 4, 5]);

    const idsOf = (runId) =>
      store.readEvents({ runId }).events.map((item) => item.eventId);
    expect(idsOf('run-a')).toEqual(['zulu', 'mike', 'yankee']);
    expect(idsOf('run-b')).toEqual(['alpha', 'bravo']);
    expect(
      store.readEvents({ runId: 'run-a' }).events.map((item) => item.payload.at)
    ).toEqual([STAMP, STAMP, STAMP]);
  });
});

test('pages with exact cursor, hasMore and empty-page boundaries', () => {
  scenario(({ open }) => {
    const store = open();
    // run-a lands on sequences 1, 2, 4, 5, 7; run-b fills the gaps.
    const layout = ['a', 'a', 'b', 'a', 'a', 'b', 'a'];
    for (const [index, tag] of layout.entries()) {
      store.appendEvent(sample(index + 1, { runId: `run-${tag}` }));
    }

    const first = store.readEvents({ limit: 2, runId: 'run-a' });
    expect(sequencesOf(first)).toEqual([1, 2]);
    expect(first).toMatchObject({ hasMore: true, nextSequence: 2, ok: true });

    const second = store.readEvents({
      afterSequence: first.nextSequence,
      limit: 2,
      runId: 'run-a',
    });
    expect(sequencesOf(second)).toEqual([4, 5]);
    expect(second).toMatchObject({ hasMore: true, nextSequence: 5, ok: true });

    const third = store.readEvents({
      afterSequence: second.nextSequence,
      limit: 2,
      runId: 'run-a',
    });
    expect(sequencesOf(third)).toEqual([7]);
    expect(third).toMatchObject({ hasMore: false, nextSequence: 7, ok: true });

    // An empty page keeps the incoming cursor instead of moving it.
    expect(
      store.readEvents({ afterSequence: 7, limit: 2, runId: 'run-a' })
    ).toEqual({ events: [], hasMore: false, nextSequence: 7, ok: true });
    expect(store.readEvents({ afterSequence: 1000, runId: 'run-a' })).toEqual({
      events: [],
      hasMore: false,
      nextSequence: 1000,
      ok: true,
    });
    expect(
      store.readEvents({ afterSequence: 3, runId: 'run-missing' })
    ).toEqual({ events: [], hasMore: false, nextSequence: 3, ok: true });

    // A page that exactly fits reports no more; one short of fitting does.
    expect(store.readEvents({ limit: 5, runId: 'run-a' })).toMatchObject({
      hasMore: false,
      nextSequence: 7,
    });
    expect(store.readEvents({ limit: 4, runId: 'run-a' })).toMatchObject({
      hasMore: true,
      nextSequence: 5,
    });

    // A cursor sitting on another run's sequence resumes at the next own event.
    expect(
      sequencesOf(store.readEvents({ afterSequence: 3, runId: 'run-a' }))
    ).toEqual([4, 5, 7]);
    expect(
      sequencesOf(store.readEvents({ afterSequence: 6, runId: 'run-a' }))
    ).toEqual([7]);

    // Walking one event at a time visits everything exactly once.
    const visited = [];
    let cursor = 0;
    for (;;) {
      const page = store.readEvents({
        afterSequence: cursor,
        limit: 1,
        runId: 'run-a',
      });
      visited.push(...sequencesOf(page));
      cursor = page.nextSequence;
      if (!page.hasMore) {
        break;
      }
    }
    expect(visited).toEqual([1, 2, 4, 5, 7]);
  });
});

test('defaults to 50 events per page and caps the limit at 200', () => {
  scenario(({ open }) => {
    const store = open();
    for (let number = 1; number <= 52; number += 1) {
      store.appendEvent(sample(number));
    }
    const defaulted = store.readEvents({ runId: 'run-a' });
    expect(defaulted.events).toHaveLength(50);
    expect(defaulted).toMatchObject({ hasMore: true, nextSequence: 50 });

    const widest = store.readEvents({
      limit: SPANS_STORE_LIMITS.pageLimit,
      runId: 'run-a',
    });
    expect(widest.events).toHaveLength(52);
    expect(widest.hasMore).toBe(false);
    expect(store.readEvents({ limit: 1, runId: 'run-a' }).events).toHaveLength(
      1
    );
  });
});

test('rejects invalid queries without reading', () => {
  scenario(({ open }) => {
    const store = open();
    store.appendEvent(sample(1));
    const query = (extra) => ({ runId: 'run-a', ...extra });
    const cases = [
      ['undefined', undefined],
      ['null', null],
      ['array', []],
      ['missing run', {}],
      ['bad run', { runId: 'a b' }],
      ['numeric run', { runId: 7 }],
      ['unknown key', query({ since: 1 })],
      ['negative cursor', query({ afterSequence: -1 })],
      ['fractional cursor', query({ afterSequence: 1.5 })],
      ['string cursor', query({ afterSequence: '1' })],
      ['null cursor', query({ afterSequence: null })],
      ['NaN cursor', query({ afterSequence: Number.NaN })],
      ['unsafe cursor', query({ afterSequence: Number.MAX_SAFE_INTEGER + 1 })],
      ['zero limit', query({ limit: 0 })],
      ['negative limit', query({ limit: -1 })],
      ['limit above cap', query({ limit: SPANS_STORE_LIMITS.pageLimit + 1 })],
      ['fractional limit', query({ limit: 1.5 })],
      ['string limit', query({ limit: '10' })],
      ['null limit', query({ limit: null })],
      ['NaN limit', query({ limit: Number.NaN })],
      ['infinite limit', query({ limit: Number.POSITIVE_INFINITY })],
    ];
    const outcomes = cases.map(([label, input]) => {
      const result = store.readEvents(input);
      return [label, result.ok, result.code];
    });
    expect(outcomes).toEqual(
      cases.map(([label]) => [label, false, 'SPANS_QUERY_INVALID'])
    );
  });
});

test('closed stores report SPANS_STORE_CLOSED and leave data intact', () => {
  scenario(({ open }) => {
    const store = open();
    expect(Object.isFrozen(store)).toBe(true);
    store.appendEvent(sample(1));
    expect(store.close()).toEqual({ ok: true });
    expect(store.close()).toEqual({ ok: true });

    for (const result of [
      store.appendEvent(sample(2)),
      store.appendEvent(null),
      store.readEvents({ runId: 'run-a' }),
      store.readEvents(),
    ]) {
      expect(result).toMatchObject({ code: 'SPANS_STORE_CLOSED', ok: false });
      expect(typeof result.error).toBe('string');
    }

    const reopened = open();
    expect(sequencesOf(reopened.readEvents({ runId: 'run-a' }))).toEqual([1]);
  });
});

test('repeated open, append, read and close retain no lock on the database', () => {
  scenario(({ root }) => {
    const options = { busyTimeoutMs: BUSY_MS, root };
    for (let round = 1; round <= 5; round += 1) {
      const store = openSpansStore(options);
      expect(store.appendEvent(sample(round)).event.sequence).toBe(round);
      // A replay and a conflict exercise the commit and no-write paths.
      expect(store.appendEvent(sample(round)).ok).toBe(true);
      expect(
        store.appendEvent(sample(round, { type: 'span.changed' })).code
      ).toBe('SPANS_EVENT_CONFLICT');
      expect(sequencesOf(store.readEvents({ runId: 'run-a' }))).toEqual(
        Array.from({ length: round }, (_, index) => index + 1)
      );
      expect(store.close()).toEqual({ ok: true });
      expect(store.close()).toEqual({ ok: true });
    }

    // Leaving WAL needs the only connection; a leaked statement would keep the
    // closed store's connection alive and make this fail as busy.
    const raw = new Database(databasePath(root), { readwrite: true });
    try {
      expect(raw.query('PRAGMA journal_mode = DELETE').values()).toEqual([
        ['delete'],
      ]);
    } finally {
      raw.close(true);
    }
  });
});

test('refuses a newer schema without changing the database file', () => {
  for (const wal of [false, true]) {
    scenario(({ root }) => {
      const path = seedDatabase(
        root,
        [
          'CREATE TABLE metadata (key TEXT NOT NULL PRIMARY KEY, value TEXT NOT NULL)',
          "INSERT INTO metadata (key, value) VALUES ('schema_version', '2')",
          // Deliberately not the version 1 shape: the version check comes first.
          'CREATE TABLE events (id INTEGER PRIMARY KEY, future TEXT)',
          "INSERT INTO events (future) VALUES ('kept')",
        ],
        { wal }
      );
      const before = fileState(root);
      expectRefused(root, 'SPANS_STORE_SCHEMA_NEWER');
      const after = fileState(root);
      expect(after.database).toBe(before.database);
      if (!wal) {
        // No journal, WAL or shm file appeared either.
        expect(after.names).toEqual(before.names);
      }
      const raw = new Database(path, { readwrite: true });
      try {
        expect(raw.query('SELECT future FROM events').all()).toEqual([
          { future: 'kept' },
        ]);
      } finally {
        raw.close(true);
      }
    });
  }
});

test('refuses foreign and non-database files without changing them', () => {
  scenario(({ root }) => {
    seedDatabase(root, [
      'CREATE TABLE notes (id INTEGER PRIMARY KEY, body TEXT)',
      "INSERT INTO notes (body) VALUES ('mine')",
    ]);
    const before = fileState(root);
    expectRefused(root, UNSUPPORTED);
    expect(fileState(root)).toEqual(before);
  });

  scenario(({ root }) => {
    const path = databasePath(root);
    fs.writeFileSync(path, Buffer.alloc(8192, 0x78), { mode: 0o600 });
    fs.chmodSync(path, 0o600);
    const before = fileState(root);
    expectRefused(root, 'SPANS_STORE_CORRUPT');
    expect(fileState(root)).toEqual(before);
  });
});

test('refuses schema drift and bad versions instead of repairing them', () => {
  const drift = [
    ['missing delete trigger', ['DROP TRIGGER events_reject_delete']],
    ['missing update trigger', ['DROP TRIGGER events_reject_update']],
    ['extra events column', ['ALTER TABLE events ADD COLUMN extra TEXT']],
    ['missing events table', ['DROP TABLE events']],
    ['version zero', ["UPDATE metadata SET value = '0'"]],
    ['version text', ["UPDATE metadata SET value = 'one'"]],
    ['version missing', ['DELETE FROM metadata']],
  ];
  for (const [label, statements] of drift) {
    scenario(({ open, root }) => {
      const store = open();
      store.appendEvent(sample(1));
      store.close();
      tamperDatabase(root, statements);
      const before = fileState(root);
      const error = expectRefused(root, UNSUPPORTED);
      expect([label, error.name]).toEqual([label, 'SpansStoreError']);
      expect([label, fileState(root)]).toEqual([label, before]);
    });
  }
});

test('busy database returns SPANS_STORE_BUSY and preserves earlier records', () => {
  scenario(({ open, root }) => {
    const store = open();
    const first = store.appendEvent(sample(1));
    const blocker = new Database(databasePath(root), { readwrite: true });
    try {
      blocker.run('BEGIN IMMEDIATE');
      const blocked = store.appendEvent(sample(2));
      expect(blocked).toMatchObject({ code: 'SPANS_STORE_BUSY', ok: false });
      expect(typeof blocked.error).toBe('string');
      expect(blocked.error).not.toContain(root);
      // WAL readers are not blocked by a pending writer and see committed rows only.
      expect(store.readEvents({ runId: 'run-a' }).events).toEqual([
        first.event,
      ]);
    } finally {
      blocker.close(true);
    }

    // The failed attempt stored nothing and consumed no sequence number.
    expect(store.appendEvent(sample(2)).event.sequence).toBe(2);
    store.close();
    expect(
      open()
        .readEvents({ runId: 'run-a' })
        .events.map((item) => item.eventId)
    ).toEqual(['event-1', 'event-2']);
  });
});

test('opening while another connection holds the only write lock reports SPANS_STORE_BUSY', () => {
  scenario(({ open, root }) => {
    const path = databasePath(root);
    fs.writeFileSync(path, '', { mode: 0o600 });
    fs.chmodSync(path, 0o600);
    const blocker = new Database(path, { readwrite: true });
    try {
      blocker.run('BEGIN IMMEDIATE');
      expectRefused(root, 'SPANS_STORE_BUSY');
    } finally {
      blocker.close(true);
    }
    // Nothing half-initialized was left behind: a later open succeeds cleanly.
    expect(open().appendEvent(sample(1)).event.sequence).toBe(1);
  });
});

test('independent connections share one monotonic sequence and see each other', () => {
  scenario(({ open }) => {
    const left = open();
    const right = open();
    const first = left.appendEvent(sample(1));
    const second = right.appendEvent(sample(2));
    const third = left.appendEvent(sample(3));
    expect(
      [first, second, third].map((result) => result.event.sequence)
    ).toEqual([1, 2, 3]);
    expect(right.appendEvent(sample(1))).toEqual(first);
    expect(left.appendEvent(sample(2, { runId: 'run-b' }))).toMatchObject({
      code: 'SPANS_EVENT_CONFLICT',
      ok: false,
    });
    expect(sequencesOf(right.readEvents({ runId: 'run-a' }))).toEqual([
      1, 2, 3,
    ]);
  });
});

test('creates a private root and database in WAL mode with the version 1 schema', () => {
  scenario(({ open, root }) => {
    const created = join(root, 'created');
    const store = open({ root: created });
    store.appendEvent(sample(1));

    expect(modeOf(created)).toBe(0o700);
    expect(modeOf(databasePath(created))).toBe(0o600);
    for (const name of fs.readdirSync(created)) {
      // No group or other permission bits on the database or any sidecar.
      expect([name, modeOf(join(created, name)) % 0o100]).toEqual([name, 0]);
    }

    const raw = new Database(databasePath(created), { readonly: true });
    try {
      expect(raw.query('PRAGMA journal_mode').values()).toEqual([['wal']]);
      expect(
        raw
          .query('SELECT value FROM metadata WHERE key = ?')
          .values('schema_version')
      ).toEqual([['1']]);
      expect(
        raw
          .query(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
          )
          .values()
      ).toEqual([
        ['events'],
        ['metadata'],
        ['spans_cache'],
        ['spans_sources'],
        ['spans_views'],
      ]);
    } finally {
      raw.close(true);
    }
  });
});

test('events table is append-only at the database level', () => {
  scenario(({ open, root }) => {
    const store = open();
    store.appendEvent(sample(1));
    const raw = new Database(databasePath(root), { readwrite: true });
    try {
      expect(() => raw.run("UPDATE events SET type = 'changed'")).toThrow(
        APPEND_ONLY_ERROR
      );
      expect(() => raw.run('DELETE FROM events')).toThrow(APPEND_ONLY_ERROR);
      expect(raw.query('SELECT COUNT(*) AS total FROM events').get()).toEqual({
        total: 1,
      });
    } finally {
      raw.close(true);
    }
    expect(sequencesOf(store.readEvents({ runId: 'run-a' }))).toEqual([1]);
  });
});

test('reports tampered rows as SPANS_STORE_CORRUPT instead of skipping them', () => {
  scenario(({ open, root }) => {
    const store = open();
    store.appendEvent(sample(1));
    store.appendEvent(sample(2));
    const raw = new Database(databasePath(root), { readwrite: true });
    try {
      // Dropping the guard is the only way to damage a row from SQL.
      raw.run('DROP TRIGGER events_reject_update');
      const damage = raw.query(
        'UPDATE events SET payload_json = ? WHERE sequence = ?'
      );
      damage.run('not json', 1);
      damage.run('{"tampered":true}', 2);
    } finally {
      raw.close(true);
    }
    expect(store.readEvents({ limit: 1, runId: 'run-a' })).toMatchObject({
      code: 'SPANS_STORE_CORRUPT',
      ok: false,
    });
    expect(
      store.readEvents({ afterSequence: 1, runId: 'run-a' })
    ).toMatchObject({ code: 'SPANS_STORE_CORRUPT', ok: false });
    expect(store.getEventById({ eventId: 'event-2' })).toMatchObject({
      code: 'SPANS_STORE_CORRUPT',
      ok: false,
    });
    // A replay of a damaged event is not silently accepted either.
    expect(store.appendEvent(sample(2))).toMatchObject({
      code: 'SPANS_STORE_CORRUPT',
      ok: false,
    });
  });
});

test('requires an explicit absolute root and bounded options before touching disk', () => {
  scenario(({ root }) => {
    const stray = `spans-store-relative-${randomUUID()}`;
    const cases = [
      ['no options', undefined, ROOT_INVALID],
      ['empty options', {}, ROOT_INVALID],
      ['undefined root', { root: undefined }, ROOT_INVALID],
      ['empty root', { root: '' }, ROOT_INVALID],
      ['relative root', { root: stray }, ROOT_INVALID],
      ['home shorthand', { root: '~/spans' }, ROOT_INVALID],
      ['numeric root', { root: 42 }, ROOT_INVALID],
      ['dotted root', { root: `${root}/sub/../other` }, ROOT_INVALID],
      ['nul in root', { root: `${root}/a\0b` }, ROOT_INVALID],
      ['null options', null, OPTIONS_INVALID],
      ['array options', [], OPTIONS_INVALID],
      ['unknown option', { path: root, root }, OPTIONS_INVALID],
      ['zero timeout', { busyTimeoutMs: 0, root }, OPTIONS_INVALID],
      [
        'timeout above bound',
        { busyTimeoutMs: SPANS_STORE_LIMITS.busyTimeoutMs + 1, root },
        OPTIONS_INVALID,
      ],
      ['fractional timeout', { busyTimeoutMs: 1.5, root }, OPTIONS_INVALID],
      ['string timeout', { busyTimeoutMs: '50', root }, OPTIONS_INVALID],
    ];
    const outcomes = cases.map(([label, options]) => {
      const error = openError(options);
      return [label, error instanceof SpansStoreError, error.code];
    });
    expect(outcomes).toEqual(
      cases.map(([label, , code]) => [label, true, code])
    );
    expect(fs.existsSync(stray)).toBe(false);
    expect(fs.readdirSync(root)).toEqual([]);
  });
});

test('creates only the final root directory and never its parents', () => {
  scenario(({ root }) => {
    expectRefused(
      join(root, 'missing-parent', 'store'),
      'SPANS_STORE_UNAVAILABLE'
    );
    expect(fs.readdirSync(root)).toEqual([]);
  });
});

test('refuses symlinked, non-directory, aliased and orphaned paths without touching them', () => {
  scenario(({ open, root }) => {
    const real = join(root, 'real');
    fs.mkdirSync(real, { mode: 0o700 });
    const link = join(root, 'link');
    fs.symlinkSync(real, link);
    expectRefused(link, UNSAFE_PATH);
    expect(fs.readdirSync(real)).toEqual([]);

    const plain = join(root, 'plain-file');
    fs.writeFileSync(plain, 'keep', { mode: 0o600 });
    expectRefused(plain, UNSAFE_PATH);
    expect(fs.readFileSync(plain, 'utf8')).toBe('keep');

    const decoy = join(root, 'decoy');
    fs.writeFileSync(decoy, 'decoy-bytes', { mode: 0o600 });

    const linkedDatabase = join(root, 'linked-database');
    fs.mkdirSync(linkedDatabase, { mode: 0o700 });
    fs.symlinkSync(decoy, databasePath(linkedDatabase));
    expectRefused(linkedDatabase, UNSAFE_PATH);

    const linkedSidecar = join(root, 'linked-sidecar');
    open({ root: linkedSidecar }).appendEvent(sample(1));
    fs.symlinkSync(decoy, `${databasePath(linkedSidecar)}-journal`);
    expectRefused(linkedSidecar, UNSAFE_PATH);

    const aliased = join(root, 'aliased');
    open({ root: aliased }).appendEvent(sample(1));
    fs.linkSync(databasePath(aliased), join(root, 'alias'));
    expectRefused(aliased, UNSAFE_PATH);

    const orphaned = join(root, 'orphaned');
    fs.mkdirSync(orphaned, { mode: 0o700 });
    fs.writeFileSync(`${databasePath(orphaned)}-wal`, 'stale', { mode: 0o600 });
    expectRefused(orphaned, UNSAFE_PATH);
    expect(fs.existsSync(databasePath(orphaned))).toBe(false);

    expect(fs.readFileSync(decoy, 'utf8')).toBe('decoy-bytes');
  });
});

test('refuses unsafe permissions and does not repair them', () => {
  scenario(({ open, root }) => {
    fs.chmodSync(root, 0o755);
    expectRefused(root, UNSAFE_PERMISSIONS);
    expect(fs.readdirSync(root)).toEqual([]);
    expect(modeOf(root)).toBe(0o755);
    fs.chmodSync(root, 0o700);

    const store = open();
    store.appendEvent(sample(1));
    store.close();

    const path = databasePath(root);
    for (const mode of [0o644, 0o640, 0o604, 0o660]) {
      fs.chmodSync(path, mode);
      const before = fileState(root);
      expectRefused(root, UNSAFE_PERMISSIONS);
      expect([mode, modeOf(path)]).toEqual([mode, mode]);
      expect(fileState(root)).toEqual(before);
    }

    fs.chmodSync(path, 0o600);
    expect(sequencesOf(open().readEvents({ runId: 'run-a' }))).toEqual([1]);
  });
});

test('never defaults to a live path or ambient configuration', () => {
  const source = fs.readFileSync(
    new URL('./spans-store.js', import.meta.url),
    'utf8'
  );
  for (const forbidden of [
    'homedir',
    'process.env',
    '.setu',
    'XDG',
    'tmpdir',
  ]) {
    expect([forbidden, source.includes(forbidden)]).toEqual([forbidden, false]);
  }
});

test('event identity lookup is bounded, validated and survives reopen', () => {
  scenario(({ open }) => {
    const first = open();
    const appended = first.appendEvent(sample(1));
    expect(first.getEventById({ eventId: 'event-1' })).toEqual({
      event: appended.event,
      found: true,
      ok: true,
    });
    expect(first.getEventById({ eventId: 'absent' })).toEqual({
      event: null,
      found: false,
      ok: true,
    });
    for (const query of [
      null,
      {},
      { eventId: '../secret' },
      { eventId: 'event-1', extra: true },
      Object.defineProperty({}, 'eventId', {
        get() {
          throw new Error('private');
        },
      }),
    ]) {
      expect(first.getEventById(query).code).toBe('SPANS_QUERY_INVALID');
    }
    expect(first.close().ok).toBe(true);
    expect(first.getEventById({ eventId: 'event-1' }).code).toBe(
      'SPANS_STORE_CLOSED'
    );
    expect(open().getEventById({ eventId: 'event-1' }).event).toEqual(
      appended.event
    );
  });
});

test('read-only opens validate existing snapshots without creating or changing files', () => {
  scenario(({ open, root }) => {
    const writer = open();
    expect(writer.appendEvent(sample(1)).ok).toBe(true);
    expect(writer.close().ok).toBe(true);
    tamperDatabase(root, []);
    const before = fileState(root);
    const reader = open({ readonly: true });
    expect(reader.readEvents({ runId: 'run-a' }).events).toHaveLength(1);
    expect(reader.appendEvent(sample(2)).ok).toBe(false);
    expect(reader.close().ok).toBe(true);
    expect(fileState(root)).toEqual(before);
    const missing = join(root, 'missing');
    expect(openError({ readonly: true, root: missing }).code).toBe(
      'SPANS_STORE_UNAVAILABLE'
    );
    expect(fs.existsSync(missing)).toBe(false);
    expect(openError({ readonly: 'yes', root }).code).toBe(
      'SPANS_STORE_OPTIONS_INVALID'
    );
  });
});
