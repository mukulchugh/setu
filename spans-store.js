// Durable, append-only event log that anchors Setu Spans history and recovery.
// Import and construction perform no I/O. Opening touches only the explicit
// private root it is given and never falls back to a live Setu path. Redaction
// is a caller boundary: payloads must already be redacted before they get here.
// biome-ignore-all lint/style/useErrorCause: filesystem errors are reduced to an allowlisted causeCode to keep paths and raw messages out of the public error contract.

import { Database } from 'bun:sqlite';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { createSpansArtifacts } from './spans-artifacts.js';
import {
  createSpansModelStore,
  inspectSpansModelSchema,
} from './spans-model-store.js';
import {
  createSpansSearch,
  initializeSpansSearchSchema,
  inspectSpansSearchSchema,
  spansSearchFailure,
} from './spans-search.js';
import {
  createSpansSearchText,
  SPANS_SEARCH_TEXT_LIMITS,
} from './spans-search-text.js';

export const SPANS_STORE_SCHEMA_VERSION = 1;
export const SPANS_STORE_DATABASE_FILE = 'spans.sqlite3';
export const SPANS_STORE_LIMITS = Object.freeze({
  busyTimeoutMs: 30_000,
  pageLimit: 200,
  payloadBytes: 262_144,
  payloadDepth: 64,
});

const DEFAULT_BUSY_TIMEOUT_MS = 5000;
const DEFAULT_PAGE_LIMIT = 50;
const SQLITE_BUSY = 5;
const SQLITE_CORRUPT = 11;
const SQLITE_NOTADB = 26;
const SYNCHRONOUS_FULL = 2;
const sidecarSuffixes = ['-wal', '-shm', '-journal'];
const openKeys = new Set(['busyTimeoutMs', 'readonly', 'root']);
const queryKeys = new Set(['afterSequence', 'limit', 'runId']);
const eventKeys = ['eventId', 'payload', 'runId', 'type'];
const artifactIdPattern = /^sha256:[0-9a-f]{64}$/;
const identifierPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const schemaVersionPattern = /^[1-9]\d{0,8}$/;
const causeCodePattern = /^(?:SQLITE_[A-Z0-9_]{1,40}|E[A-Z0-9]{1,15})$/;
const lockedMessagePattern = /database is locked/i;
const corruptMessagePattern = /file is not a database|malformed/i;
const pathSeparatorPattern = /[\\/]/;
const autoincrementPattern = /\bAUTOINCREMENT\b/i;

const schemaStatements = [
  'CREATE TABLE metadata (key TEXT NOT NULL PRIMARY KEY, value TEXT NOT NULL)',
  `CREATE TABLE events (
    sequence INTEGER PRIMARY KEY AUTOINCREMENT,
    event_id TEXT NOT NULL UNIQUE,
    run_id TEXT NOT NULL,
    type TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    input_digest TEXT NOT NULL
  )`,
  'CREATE INDEX events_run_sequence ON events (run_id, sequence)',
  `CREATE TRIGGER events_reject_update BEFORE UPDATE ON events
    BEGIN SELECT RAISE(ABORT, 'spans events are append-only'); END`,
  `CREATE TRIGGER events_reject_delete BEFORE DELETE ON events
    BEGIN SELECT RAISE(ABORT, 'spans events are append-only'); END`,
];
const triggerNames = ['events_reject_delete', 'events_reject_update'];
const expectedColumns = {
  events: [
    'sequence:INTEGER:0:1',
    'event_id:TEXT:1:0',
    'run_id:TEXT:1:0',
    'type:TEXT:1:0',
    'payload_json:TEXT:1:0',
    'input_digest:TEXT:1:0',
  ],
  metadata: ['key:TEXT:1:1', 'value:TEXT:1:0'],
};
const unavailableMessages = {
  append: 'Spans event could not be stored.',
  close: 'Spans store could not be closed cleanly.',
  read: 'Spans events could not be read.',
};

// Open failures throw this; append/read failures are returned as results.
// Never copy exception messages: SQLite and the filesystem put paths in them.
export class SpansStoreError extends Error {
  constructor(code, phase, causeCode) {
    super(`${code}: ${phase}`);
    this.name = 'SpansStoreError';
    this.code = code;
    this.phase = phase;
    if (typeof causeCode === 'string' && causeCodePattern.test(causeCode)) {
      this.causeCode = causeCode;
    }
  }
}

const failure = (code, error, causeCode) => ({
  ...(causeCode ? { causeCode } : {}),
  code,
  error,
  ok: false,
});

function compareText(left, right) {
  if (left < right) {
    return -1;
  }
  if (left > right) {
    return 1;
  }
  return 0;
}

function attempt(work) {
  try {
    return work();
  } catch {
    // Hostile or odd caller input (throwing getters, proxies) is simply invalid.
  }
}

const isIdentifier = (value) =>
  typeof value === 'string' && identifierPattern.test(value);

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

// ---------------------------------------------------------------------------
// Canonical JSON: strict, bounded, key-sorted. Anything JSON.stringify would
// silently coerce or drop (undefined, NaN, holes, symbols, getters, class
// instances) is rejected instead, so equal input always means equal bytes.
// ---------------------------------------------------------------------------

function reject() {
  throw new TypeError('invalid spans payload');
}

function spend(context, count) {
  context.remaining -= count;
  if (context.remaining < 0) {
    reject();
  }
}

function emit(context, text) {
  spend(context, text.length);
  return text;
}

function ownDataValue(target, key) {
  const descriptor = Object.getOwnPropertyDescriptor(target, key);
  if (!(descriptor?.enumerable && 'value' in descriptor)) {
    reject();
  }
  return descriptor.value;
}

function canonicalArray(array, context, depth) {
  if (
    Object.getPrototypeOf(array) !== Array.prototype ||
    Reflect.ownKeys(array).length !== array.length + 1
  ) {
    return reject();
  }
  const items = [];
  for (let index = 0; index < array.length; index += 1) {
    items.push(canonicalValue(ownDataValue(array, index), context, depth + 1));
  }
  spend(context, items.length + 1);
  return `[${items.join(',')}]`;
}

function canonicalObject(object, context, depth) {
  const keys = Reflect.ownKeys(object);
  if (!isPlainObject(object) || keys.some((key) => typeof key !== 'string')) {
    return reject();
  }
  const members = keys
    .sort(compareText)
    .map(
      (key) =>
        `${emit(context, JSON.stringify(key))}:${canonicalValue(
          ownDataValue(object, key),
          context,
          depth + 1
        )}`
    );
  spend(context, members.length * 2 + 1);
  return `{${members.join(',')}}`;
}

function canonicalContainer(value, context, depth) {
  if (depth >= SPANS_STORE_LIMITS.payloadDepth || context.active.has(value)) {
    return reject();
  }
  context.active.add(value);
  try {
    return Array.isArray(value)
      ? canonicalArray(value, context, depth)
      : canonicalObject(value, context, depth);
  } finally {
    context.active.delete(value);
  }
}

function canonicalValue(value, context, depth) {
  if (value === null) {
    return emit(context, 'null');
  }
  switch (typeof value) {
    case 'boolean':
      return emit(context, String(value));
    case 'number':
      return Number.isFinite(value)
        ? emit(context, JSON.stringify(value))
        : reject();
    case 'string':
      return emit(context, JSON.stringify(value));
    case 'object':
      return canonicalContainer(value, context, depth);
    default:
      return reject();
  }
}

function canonicalPayload(value) {
  const json = canonicalValue(
    value,
    { active: new Set(), remaining: SPANS_STORE_LIMITS.payloadBytes },
    0
  );
  // The running budget counts UTF-16 units; the stored limit is in bytes.
  if (Buffer.byteLength(json, 'utf8') > SPANS_STORE_LIMITS.payloadBytes) {
    reject();
  }
  return json;
}

// Key order is the canonical (sorted) order, so payloadJson can be spliced in.
function inputDigest({ eventId, payloadJson, runId, type }) {
  return createHash('sha256')
    .update(
      `{"eventId":${JSON.stringify(eventId)},"payload":${payloadJson},"runId":${JSON.stringify(runId)},"type":${JSON.stringify(type)}}`
    )
    .digest('hex');
}

function normalizeEvent(input) {
  const keys = isPlainObject(input) ? Reflect.ownKeys(input) : [];
  if (
    keys.length !== eventKeys.length ||
    !eventKeys.every((key) => keys.includes(key))
  ) {
    return;
  }
  const { eventId, payload, runId, type } = input;
  if (![eventId, runId, type].every(isIdentifier)) {
    return;
  }
  const payloadJson = canonicalPayload(payload);
  return {
    digest: inputDigest({ eventId, payloadJson, runId, type }),
    eventId,
    payloadJson,
    runId,
    type,
  };
}

function normalizeQuery(query) {
  if (
    !(
      isPlainObject(query) &&
      Reflect.ownKeys(query).every((key) => queryKeys.has(key))
    )
  ) {
    return;
  }
  const { afterSequence = 0, limit = DEFAULT_PAGE_LIMIT, runId } = query;
  if (
    !(
      isIdentifier(runId) &&
      Number.isSafeInteger(afterSequence) &&
      afterSequence >= 0 &&
      Number.isInteger(limit) &&
      limit >= 1 &&
      limit <= SPANS_STORE_LIMITS.pageLimit
    )
  ) {
    return;
  }
  return { afterSequence, limit, runId };
}

// ---------------------------------------------------------------------------
// Failure mapping
// ---------------------------------------------------------------------------

// The message is only matched here as a fallback; it is never copied anywhere.
function storageSignals(error) {
  return {
    causeCode:
      typeof error?.code === 'string' && causeCodePattern.test(error.code)
        ? error.code
        : undefined,
    message: String(error?.message),
    // Extended result codes keep the primary code in the low byte.
    primary: Number.isInteger(error?.errno) ? error.errno % 256 : -1,
  };
}

const isBusy = ({ causeCode, message, primary }) =>
  primary === SQLITE_BUSY ||
  causeCode?.startsWith('SQLITE_BUSY') === true ||
  lockedMessagePattern.test(message);

const isCorrupt = ({ causeCode, message, primary }) =>
  primary === SQLITE_CORRUPT ||
  primary === SQLITE_NOTADB ||
  causeCode?.startsWith('SQLITE_CORRUPT') === true ||
  causeCode === 'SQLITE_NOTADB' ||
  corruptMessagePattern.test(message);

function classifyStorageError(error) {
  const signals = storageSignals(error);
  const { causeCode } = signals;
  if (isBusy(signals)) {
    return { causeCode, code: 'SPANS_STORE_BUSY' };
  }
  if (isCorrupt(signals)) {
    return { causeCode, code: 'SPANS_STORE_CORRUPT' };
  }
  return { causeCode, code: 'SPANS_STORE_UNAVAILABLE' };
}

function failureMessage(code, operation) {
  if (code === 'SPANS_STORE_BUSY') {
    return 'Spans store is busy; try again.';
  }
  if (code === 'SPANS_STORE_CORRUPT') {
    return 'Spans store failed an integrity check.';
  }
  return unavailableMessages[operation];
}

function storageFailure(error, operation) {
  const { causeCode, code } =
    error instanceof SpansStoreError
      ? { causeCode: error.causeCode, code: error.code }
      : classifyStorageError(error);
  return failure(code, failureMessage(code, operation), causeCode);
}

function openFailure(error) {
  if (error instanceof SpansStoreError) {
    return error;
  }
  const { causeCode, code } = classifyStorageError(error);
  return new SpansStoreError(code, 'open', causeCode);
}

// ---------------------------------------------------------------------------
// Private filesystem preparation. Only the explicit root, its database file and
// that file's SQLite sidecars are ever inspected or created.
// ---------------------------------------------------------------------------

function inspectPath(path, phase) {
  try {
    return fs.lstatSync(path);
  } catch (error) {
    if (error.code === 'ENOENT') {
      return;
    }
    throw new SpansStoreError(
      'SPANS_STORE_UNAVAILABLE',
      `${phase}-inspect`,
      error.code
    );
  }
}

// lstat results: a symlink is neither a file nor a directory, so it is refused.
function assertPrivate(stat, { directory, phase }) {
  if (!stat) {
    throw new SpansStoreError('SPANS_STORE_UNAVAILABLE', `${phase}-missing`);
  }
  if (
    !(directory ? stat.isDirectory() : stat.isFile()) ||
    (!directory && stat.nlink > 1)
  ) {
    throw new SpansStoreError('SPANS_STORE_UNSAFE_PATH', phase);
  }
  const bits = stat.mode % 0o1000;
  const owner = Math.floor(bits / 0o100);
  const foreign =
    typeof process.getuid === 'function' && stat.uid !== process.getuid();
  if (foreign || bits % 0o100 !== 0 || owner < (directory ? 7 : 6)) {
    throw new SpansStoreError('SPANS_STORE_UNSAFE_PERMISSIONS', phase);
  }
}

function existingSidecars(path) {
  return sidecarSuffixes.flatMap((suffix) => {
    const stat = inspectPath(`${path}${suffix}`, 'sidecar');
    return stat ? [stat] : [];
  });
}

function assertSidecarsPrivate(path) {
  for (const stat of existingSidecars(path)) {
    assertPrivate(stat, { directory: false, phase: 'sidecar' });
  }
}

function prepareRoot(root, readonly) {
  let stat = inspectPath(root, 'root');
  if (!stat && readonly) {
    throw new SpansStoreError('SPANS_STORE_UNAVAILABLE', 'root-missing');
  }
  if (!stat) {
    try {
      // Not recursive: a missing parent is a caller error, not something to create.
      fs.mkdirSync(root, { mode: 0o700 });
    } catch (error) {
      throw new SpansStoreError(
        'SPANS_STORE_UNAVAILABLE',
        'root-create',
        error.code
      );
    }
    stat = inspectPath(root, 'root');
  }
  assertPrivate(stat, { directory: true, phase: 'root' });
}

function createPrivateFile(path) {
  // A sidecar without its database would be replayed into the new file.
  if (existingSidecars(path).length > 0) {
    throw new SpansStoreError('SPANS_STORE_UNSAFE_PATH', 'orphaned-sidecar');
  }
  let fd;
  try {
    fd = fs.openSync(path, 'wx', 0o600);
    fs.fchmodSync(fd, 0o600);
  } catch (error) {
    throw new SpansStoreError(
      'SPANS_STORE_UNAVAILABLE',
      'database-create',
      error.code
    );
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        /* The new file is empty; a failed close cannot lose data. */
      }
    }
  }
}

function prepareDatabaseFile(path, readonly) {
  let stat = inspectPath(path, 'database');
  if (!stat && readonly) {
    throw new SpansStoreError('SPANS_STORE_UNAVAILABLE', 'database-missing');
  }
  if (!stat) {
    createPrivateFile(path);
    stat = inspectPath(path, 'database');
  }
  assertPrivate(stat, { directory: false, phase: 'database' });
  assertSidecarsPrivate(path);
  return { dev: stat.dev, ino: stat.ino };
}

// Closes the window between the checks above and SQLite's own open().
function assertSameFile(path, identity) {
  const stat = inspectPath(path, 'database');
  assertPrivate(stat, { directory: false, phase: 'database' });
  if (stat.dev !== identity.dev || stat.ino !== identity.ino) {
    throw new SpansStoreError('SPANS_STORE_UNSAFE_PATH', 'database-changed');
  }
  assertSidecarsPrivate(path);
}

// ---------------------------------------------------------------------------
// Schema inspection. Everything here is read-only; nothing may mutate the file
// until the schema is known to be empty or exactly version 1.
// ---------------------------------------------------------------------------

function schemaObjects(db) {
  return db
    .query('SELECT name, sql, tbl_name, type FROM sqlite_master')
    .all()
    .filter((row) => !row.name.startsWith('sqlite_'));
}

function columnSignature(db, table) {
  return db
    .query(
      'SELECT name, type, "notnull", pk FROM pragma_table_info(?) ORDER BY cid'
    )
    .all(table)
    .map(
      (column) => `${column.name}:${column.type}:${column.notnull}:${column.pk}`
    );
}

function hasUniqueEventIdIndex(db) {
  return db
    .query('SELECT name FROM pragma_index_list(?) WHERE "unique" = 1')
    .all('events')
    .some(({ name }) => {
      const columns = db
        .query('SELECT name FROM pragma_index_info(?)')
        .all(name);
      return columns.length === 1 && columns[0].name === 'event_id';
    });
}

function storedSchemaVersion(db) {
  const columns = db
    .query('SELECT name FROM pragma_table_info(?)')
    .all('metadata')
    .map((column) => column.name);
  if (!(columns.includes('key') && columns.includes('value'))) {
    throw new SpansStoreError('SPANS_STORE_SCHEMA_UNSUPPORTED', 'metadata');
  }
  const row = db
    .query('SELECT value FROM metadata WHERE key = ?')
    .get('schema_version');
  const text = row ? String(row.value) : '';
  if (!schemaVersionPattern.test(text)) {
    throw new SpansStoreError('SPANS_STORE_SCHEMA_UNSUPPORTED', 'version');
  }
  return Number(text);
}

function verifyCurrentSchema(db, objects) {
  const events = objects.find(
    (row) => row.type === 'table' && row.name === 'events'
  );
  const intact =
    events &&
    autoincrementPattern.test(events.sql) &&
    triggerNames.every((name) =>
      objects.some(
        (row) =>
          row.type === 'trigger' &&
          row.name === name &&
          row.tbl_name === 'events'
      )
    ) &&
    Object.entries(expectedColumns).every(
      ([table, expected]) =>
        columnSignature(db, table).join() === expected.join()
    ) &&
    hasUniqueEventIdIndex(db);
  if (!intact) {
    throw new SpansStoreError('SPANS_STORE_SCHEMA_UNSUPPORTED', 'shape');
  }
}

// Returns 'empty' or 'current'; refuses anything else without writing.
function inspectSchema(db) {
  const objects = schemaObjects(db);
  if (objects.length === 0) {
    return 'empty';
  }
  if (!objects.some((row) => row.type === 'table' && row.name === 'metadata')) {
    throw new SpansStoreError('SPANS_STORE_SCHEMA_UNSUPPORTED', 'unknown');
  }
  const version = storedSchemaVersion(db);
  if (version > SPANS_STORE_SCHEMA_VERSION) {
    throw new SpansStoreError('SPANS_STORE_SCHEMA_NEWER', 'version');
  }
  if (version !== SPANS_STORE_SCHEMA_VERSION) {
    throw new SpansStoreError('SPANS_STORE_SCHEMA_UNSUPPORTED', 'version');
  }
  verifyCurrentSchema(db, objects);
  return 'current';
}

const pragmaValue = (db, name) => db.query(`PRAGMA ${name}`).values()[0]?.[0];

// Connection-level settings only; none of these change the file.
function configureConnection(db, busyTimeoutMs) {
  db.run(`PRAGMA busy_timeout = ${busyTimeoutMs}`);
  db.run('PRAGMA foreign_keys = ON');
  db.run('PRAGMA synchronous = FULL');
  if (
    pragmaValue(db, 'busy_timeout') !== busyTimeoutMs ||
    pragmaValue(db, 'foreign_keys') !== 1 ||
    pragmaValue(db, 'synchronous') !== SYNCHRONOUS_FULL
  ) {
    throw new SpansStoreError('SPANS_STORE_UNAVAILABLE', 'connection-settings');
  }
}

// Persistent file-format change: only after the schema was accepted.
function enableWal(db) {
  const mode = db.query('PRAGMA journal_mode = WAL').values()[0]?.[0];
  if (String(mode).toLowerCase() !== 'wal') {
    throw new SpansStoreError('SPANS_STORE_UNAVAILABLE', 'wal-unavailable');
  }
}

// BEGIN IMMEDIATE takes the write lock before any read inside `work`. Plain
// statements stand in for db.transaction(): on Bun 1.3.4 its internal
// BEGIN/COMMIT/ROLLBACK statements outlive db.close(true), which then fails
// with SQLITE_BUSY and keeps the file locked.
function immediate(db, work) {
  // The model transaction owns rollback when appending its atomic event batch.
  if (db.inTransaction) {
    return work();
  }
  db.run('BEGIN IMMEDIATE');
  try {
    const result = work();
    db.run('COMMIT');
    return result;
  } catch (error) {
    try {
      db.run('ROLLBACK');
    } catch {
      /* The failure that led here is the one worth reporting. */
    }
    throw error;
  }
}

function initializeSchema(db) {
  immediate(db, () => {
    // Another opener may have created the schema since the pre-check.
    if (inspectSchema(db) === 'current') {
      return;
    }
    for (const statement of schemaStatements) {
      db.run(statement);
    }
    db.query('INSERT INTO metadata (key, value) VALUES (?, ?)').run(
      'schema_version',
      String(SPANS_STORE_SCHEMA_VERSION)
    );
    if (inspectSchema(db) !== 'current') {
      throw new SpansStoreError('SPANS_STORE_UNAVAILABLE', 'schema-create');
    }
  });
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

function parseJson(text) {
  try {
    return { value: JSON.parse(text) };
  } catch {
    // Reported as corruption by the caller; the parser message is never kept.
  }
}

// Every row is re-verified on the way out so damaged history is reported, not skipped.
function rowToEvent(row) {
  const parsed =
    row && typeof row.payload_json === 'string'
      ? parseJson(row.payload_json)
      : undefined;
  if (
    !(
      parsed &&
      Number.isSafeInteger(row.sequence) &&
      [row.event_id, row.run_id, row.type, row.input_digest].every(
        (value) => typeof value === 'string'
      )
    ) ||
    inputDigest({
      eventId: row.event_id,
      payloadJson: row.payload_json,
      runId: row.run_id,
      type: row.type,
    }) !== row.input_digest
  ) {
    throw new SpansStoreError('SPANS_STORE_CORRUPT', 'event-integrity');
  }
  return {
    eventId: row.event_id,
    payload: parsed.value,
    runId: row.run_id,
    sequence: row.sequence,
    type: row.type,
  };
}

const eventColumns =
  'sequence, event_id, run_id, type, payload_json, input_digest';

// Reads one artifact under the explicit archive root for search text. The file
// size is bounded before the artifact helper reads it whole, and a missing or
// oversized file is a refusal, never empty text.
function boundedArtifactReader(root) {
  const artifacts = createSpansArtifacts({ root });
  return ({ artifactId }) => {
    if (typeof artifactId === 'string' && artifactIdPattern.test(artifactId)) {
      try {
        const stat = fs.lstatSync(
          join(root, 'artifacts', artifactId.slice('sha256:'.length))
        );
        if (stat.size > SPANS_SEARCH_TEXT_LIMITS.artifactBytes) {
          return { code: 'ARTIFACT_INVALID', ok: false };
        }
      } catch {
        // A missing or unreadable file is reported by the artifact reader.
      }
    }
    return artifacts.read({ artifactId });
  };
}

function createStore(db, { readonly, root }) {
  // Uncached statements owned by this store; close() finalizes them before the
  // connection is released so no statement can keep the file locked.
  const selectByEventId = db.prepare(
    `SELECT ${eventColumns} FROM events WHERE event_id = ?`
  );
  const insertEvent = db.prepare(
    'INSERT INTO events (event_id, run_id, type, payload_json, input_digest) VALUES (?, ?, ?, ?, ?)'
  );
  const selectPage = db.prepare(
    `SELECT ${eventColumns} FROM events WHERE run_id = ? AND sequence > ? ORDER BY sequence ASC LIMIT ?`
  );
  const selectArtifactReference = db.prepare(
    `SELECT event_id FROM events WHERE run_id = ? AND (
      json_extract(payload_json, '$.artifactId') = ? OR
      EXISTS (SELECT 1 FROM json_each(payload_json, '$.artifactIds') WHERE value = ?)
    ) ORDER BY sequence LIMIT 1`
  );
  // The write lock is taken before the duplicate check, so the check and the
  // insert are one atomic step even across processes.
  const write = (record) =>
    immediate(db, () => {
      const existing = selectByEventId.get(record.eventId);
      if (existing) {
        return existing.input_digest === record.digest
          ? { event: rowToEvent(existing) }
          : { conflict: true };
      }
      insertEvent.run(
        record.eventId,
        record.runId,
        record.type,
        record.payloadJson,
        record.digest
      );
      return { event: rowToEvent(selectByEventId.get(record.eventId)) };
    });
  let closed = false;
  let released = false;
  const closedResult = () =>
    failure('SPANS_STORE_CLOSED', 'Spans store is closed.');

  // Search is derived and lazy: nothing is created, prepared or indexed until a
  // caller asks, and an absent schema is reported rather than created.
  let searchService;
  const searchText = createSpansSearchText({
    readArtifact: boundedArtifactReader(root),
  });
  const readonlyRefusal = () => spansSearchFailure('SPANS_SEARCH_READONLY');
  const withSearch = (work) => {
    if (closed) {
      return closedResult();
    }
    try {
      if (!searchService) {
        if (inspectSpansSearchSchema(db) !== 'current') {
          return spansSearchFailure('SPANS_SEARCH_UNAVAILABLE');
        }
        searchService = createSpansSearch({ db, textForEvent: searchText });
      }
      return work(searchService);
    } catch (error) {
      return spansSearchFailure(error);
    }
  };

  let models;
  const store = {
    appendEvent(input) {
      if (closed) {
        return closedResult();
      }
      const record = attempt(() => normalizeEvent(input));
      if (!record) {
        return failure('SPANS_EVENT_INVALID', 'Invalid spans event.');
      }
      try {
        const outcome = write(record);
        return outcome.conflict
          ? failure(
              'SPANS_EVENT_CONFLICT',
              'Spans event id already exists with different content.'
            )
          : { event: outcome.event, ok: true };
      } catch (error) {
        return storageFailure(error, 'append');
      }
    },
    close() {
      closed = true;
      if (released) {
        return { ok: true };
      }
      try {
        const modelClose = models.closeStatements();
        if (!modelClose.ok) {
          return modelClose;
        }
        // Derived search statements are finalized before the connection closes.
        const searchClose = searchService?.close();
        if (searchClose && searchClose.ok !== true) {
          return failure('SPANS_STORE_UNAVAILABLE', unavailableMessages.close);
        }
        // finalize() is safe to repeat, so a retried close after a failure works.
        for (const statement of [
          selectByEventId,
          insertEvent,
          selectPage,
          selectArtifactReference,
        ]) {
          statement.finalize();
        }
        db.close(true);
        released = true;
        return { ok: true };
      } catch (error) {
        return storageFailure(error, 'close');
      }
    },
    getArtifactReference(query) {
      if (closed) {
        return closedResult();
      }
      if (
        !(
          isPlainObject(query) &&
          typeof query.runId === 'string' &&
          identifierPattern.test(query.runId) &&
          typeof query.artifactId === 'string' &&
          artifactIdPattern.test(query.artifactId)
        )
      ) {
        return failure(
          'SPANS_QUERY_INVALID',
          'Invalid artifact reference query.'
        );
      }
      try {
        const row = selectArtifactReference.get(
          query.runId,
          query.artifactId,
          query.artifactId
        );
        return {
          eventId: row?.event_id ?? null,
          found: Boolean(row),
          ok: true,
        };
      } catch (error) {
        return storageFailure(error, 'read');
      }
    },
    getEventById(query) {
      if (closed) {
        return closedResult();
      }
      const eventId = attempt(() => {
        if (!isPlainObject(query) || Reflect.ownKeys(query).length !== 1) {
          return;
        }
        const value = ownDataValue(query, 'eventId');
        return isIdentifier(value) ? value : undefined;
      });
      if (!eventId) {
        return failure('SPANS_QUERY_INVALID', 'Invalid spans event query.');
      }
      try {
        const row = selectByEventId.get(eventId);
        return {
          event: row ? rowToEvent(row) : null,
          found: Boolean(row),
          ok: true,
        };
      } catch (error) {
        return storageFailure(error, 'read');
      }
    },
    // Search. Only initializeSearch creates the derived schema, and only on a
    // writable store. Reads and writes report fixed { ok: false, code, error }.
    indexSearchPage(input) {
      if (readonly) {
        return closed ? closedResult() : readonlyRefusal();
      }
      return withSearch((search) => search.indexPage(input));
    },
    initializeSearch() {
      if (closed) {
        return closedResult();
      }
      if (readonly) {
        return readonlyRefusal();
      }
      try {
        return initializeSpansSearchSchema(db);
      } catch (error) {
        return spansSearchFailure(error);
      }
    },
    invalidateSearch() {
      if (readonly) {
        return closed ? closedResult() : readonlyRefusal();
      }
      return withSearch((search) => search.invalidate());
    },
    readEvents(query) {
      if (closed) {
        return closedResult();
      }
      const request = attempt(() => normalizeQuery(query));
      if (!request) {
        return failure('SPANS_QUERY_INVALID', 'Invalid spans event query.');
      }
      try {
        // One extra row tells hasMore without a second query.
        const rows = selectPage.all(
          request.runId,
          request.afterSequence,
          request.limit + 1
        );
        const events = rows.slice(0, request.limit).map(rowToEvent);
        return {
          events,
          hasMore: rows.length > request.limit,
          nextSequence: events.at(-1)?.sequence ?? request.afterSequence,
          ok: true,
        };
      } catch (error) {
        return storageFailure(error, 'read');
      }
    },
    search: (input) => withSearch((search) => search.query(input)),
    searchStatus: () => withSearch((search) => search.status()),
  };
  models = createSpansModelStore({ appendEvent: store.appendEvent, db });
  const { closeStatements, ...modelMethods } = models;
  return Object.freeze({ ...store, ...modelMethods });
}

function openSettings(options) {
  if (
    !(
      isPlainObject(options) &&
      Reflect.ownKeys(options).every((key) => openKeys.has(key))
    )
  ) {
    throw new SpansStoreError('SPANS_STORE_OPTIONS_INVALID', 'options');
  }
  const {
    busyTimeoutMs = DEFAULT_BUSY_TIMEOUT_MS,
    readonly = false,
    root,
  } = options;
  if (typeof readonly !== 'boolean') {
    throw new SpansStoreError('SPANS_STORE_OPTIONS_INVALID', 'readonly');
  }
  if (
    !(
      Number.isInteger(busyTimeoutMs) &&
      busyTimeoutMs >= 1 &&
      busyTimeoutMs <= SPANS_STORE_LIMITS.busyTimeoutMs
    )
  ) {
    throw new SpansStoreError('SPANS_STORE_OPTIONS_INVALID', 'busy-timeout');
  }
  if (
    !(
      typeof root === 'string' &&
      root.length > 0 &&
      !root.includes('\0') &&
      isAbsolute(root) &&
      !root.split(pathSeparatorPattern).includes('..')
    )
  ) {
    throw new SpansStoreError('SPANS_STORE_ROOT_INVALID', 'root');
  }
  return { busyTimeoutMs, readonly, root };
}

function closeQuietly(db) {
  try {
    db?.close(true);
  } catch {
    /* The failure that led here is the one worth reporting. */
  }
}

// Shared read-only path guard for snapshot readers opening their own connection.
export function inspectSpansStoreFiles({ root } = {}) {
  const settings = openSettings({ readonly: true, root });
  prepareRoot(settings.root, true);
  return prepareDatabaseFile(
    join(settings.root, SPANS_STORE_DATABASE_FILE),
    true
  );
}

// root is mandatory and must be an absolute directory path chosen by the
// caller; there is deliberately no default location. busyTimeoutMs is bounded
// to SPANS_STORE_LIMITS.busyTimeoutMs.
export function openSpansStore(options = {}) {
  const { busyTimeoutMs, readonly, root } = openSettings(options);
  prepareRoot(root, readonly);
  const path = join(root, SPANS_STORE_DATABASE_FILE);
  const identity = prepareDatabaseFile(path, readonly);
  let db;
  try {
    db = new Database(
      path,
      readonly
        ? { readonly: true, strict: true }
        : { readwrite: true, strict: true }
    );
    configureConnection(db, busyTimeoutMs);
    const state = inspectSchema(db);
    const modelState = inspectSpansModelSchema(db);
    if (readonly && (state !== 'current' || modelState !== 'current')) {
      throw new SpansStoreError(
        'SPANS_STORE_SCHEMA_UNSUPPORTED',
        'readonly-schema'
      );
    }
    if (!readonly) {
      enableWal(db);
    }
    if (state === 'empty') {
      initializeSchema(db);
    }
    assertSameFile(path, identity);
    return createStore(db, { readonly, root });
  } catch (error) {
    closeQuietly(db);
    throw openFailure(error);
  }
}
