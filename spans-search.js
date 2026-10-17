// Rebuildable full-text search for the append-only Spans archive. The caller
// owns the database connection and supplies only text selected from canonical
// events and approved artifacts. This module never opens a database, reads a
// source path, indexes during construction, or changes canonical event rows.
// biome-ignore-all lint/style/useErrorCause: the custom error preserves a cause in Error options while exposing only its sanitized code and phase.

import { createHash } from 'node:crypto';
import { redactSpansValue } from './spans-redaction.js';
import { SPANS_SEARCH_TEXT_LIMITS } from './spans-search-text.js';

const MAX_EVENT_PAYLOAD_BYTES = 262_144;

export const SPANS_SEARCH_SCHEMA_VERSION = 1;
export const SPANS_SEARCH_LIMITS = Object.freeze({
  documentBytes: SPANS_SEARCH_TEXT_LIMITS.textBytes + MAX_EVENT_PAYLOAD_BYTES,
  eventPayloadBytes: MAX_EVENT_PAYLOAD_BYTES,
  indexPage: 200,
  indexPageBytes: 8_388_608,
  queryChars: 512,
  queryPage: 100,
  queryTerms: 32,
});

const SEARCH_VERSION_KEY = 'search_schema_version';
const versionPattern = /^[1-9]\d{0,8}$/;
const identifierPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const metadataColumns = ['key:TEXT:1:1', 'value:TEXT:1:0'];
const eventColumns = [
  'sequence:INTEGER:0:1',
  'event_id:TEXT:1:0',
  'run_id:TEXT:1:0',
  'type:TEXT:1:0',
  'payload_json:TEXT:1:0',
  'input_digest:TEXT:1:0',
];
const progressColumns = [
  'singleton:INTEGER:0:1',
  'indexed_sequence:INTEGER:1:0',
  'generation:INTEGER:1:0',
];
const digestPattern = /^[a-f0-9]{64}$/;
const ftsSchemaPattern =
  /^create virtual table spans_search using fts5\(\s*run_id unindexed\s*,\s*event_id unindexed\s*,\s*body\s*,\s*tokenize='unicode61'\s*\)$/;
const lockedMessagePattern = /database is locked/i;
const searchObjectPattern = /^spans_search(?:_|$)/;
const tokenPattern = /[\p{L}\p{N}]+/gu;
const utf8ByteLength = (text) => Buffer.from(text, 'utf8').byteLength;

const schemaStatements = [
  `CREATE VIRTUAL TABLE spans_search USING fts5(
    run_id UNINDEXED,
    event_id UNINDEXED,
    body,
    tokenize='unicode61'
  )`,
  `CREATE TABLE spans_search_progress (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    indexed_sequence INTEGER NOT NULL CHECK (indexed_sequence >= 0),
    generation INTEGER NOT NULL CHECK (generation >= 0)
  )`,
  'INSERT INTO spans_search_progress (singleton, indexed_sequence, generation) VALUES (1, 0, 0)',
];

const messages = Object.freeze({
  SPANS_SEARCH_BUSY: 'Spans search is busy; try again.',
  SPANS_SEARCH_CLOSED: 'Spans search is closed.',
  SPANS_SEARCH_CORRUPT: 'Spans search progress or index is inconsistent.',
  SPANS_SEARCH_EVENT_INVALID: 'A canonical event could not be indexed.',
  SPANS_SEARCH_INVALID: 'Invalid Spans search request.',
  SPANS_SEARCH_OUTCOME_UNKNOWN:
    'The search update was not confirmed; reread before retrying.',
  SPANS_SEARCH_QUERY_INVALID: 'Search text or cursor is invalid.',
  SPANS_SEARCH_READONLY:
    'Spans search cannot be changed on a read-only archive.',
  SPANS_SEARCH_SCHEMA_UNAVAILABLE:
    'Spans search schema could not be initialized.',
  SPANS_SEARCH_SOURCE_FAILED:
    'Searchable text could not be read; the page was not committed.',
  SPANS_SEARCH_STALE_GENERATION:
    'Search results changed; restart pagination from the current generation.',
  SPANS_SEARCH_TEXT_INVALID: 'Searchable text was refused.',
  SPANS_SEARCH_UNAVAILABLE: 'Spans search is unavailable.',
  SPANS_STORE_SCHEMA_NEWER: 'The Spans search schema is newer than this code.',
  SPANS_STORE_SCHEMA_UNSUPPORTED: 'The Spans search schema is unsupported.',
});

/** A sanitized schema/lifecycle failure. Never carries SQLite paths or input. */
export class SpansSearchError extends Error {
  constructor(code, phase, options) {
    super(`${code}: ${phase}`, options);
    this.name = 'SpansSearchError';
    this.code = code;
    this.phase = phase;
  }
}

function tableColumns(db, table) {
  const statement = db.prepare(
    'SELECT name, type, "notnull", pk FROM pragma_table_info(?) ORDER BY cid'
  );
  try {
    return statement
      .all(table)
      .map(
        (column) =>
          `${column.name}:${column.type}:${column.notnull}:${column.pk}`
      );
  } finally {
    statement.finalize();
  }
}

function objectRows(db) {
  const statement = db.prepare(
    "SELECT name, type, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'"
  );
  try {
    return statement.all();
  } finally {
    statement.finalize();
  }
}

function metadataVersion(db) {
  const statement = db.prepare('SELECT value FROM metadata WHERE key = ?');
  try {
    return statement.get(SEARCH_VERSION_KEY)?.value;
  } finally {
    statement.finalize();
  }
}

function normalizeSql(sql) {
  return String(sql ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function validateBaseSchema(db, objects) {
  const metadata = objects.find((row) => row.name === 'metadata');
  const events = objects.find((row) => row.name === 'events');
  if (
    metadata?.type !== 'table' ||
    events?.type !== 'table' ||
    tableColumns(db, 'metadata').join() !== metadataColumns.join() ||
    tableColumns(db, 'events').join() !== eventColumns.join()
  ) {
    throw new SpansSearchError('SPANS_STORE_SCHEMA_UNSUPPORTED', 'base-shape');
  }
}

function progressShapeIsCurrent(row, db) {
  const normalized = normalizeSql(row?.sql);
  const expected = normalizeSql(schemaStatements[1]);
  return (
    row?.type === 'table' &&
    tableColumns(db, 'spans_search_progress').join() ===
      progressColumns.join() &&
    normalized === expected
  );
}

function ftsShapeIsCurrent(row, db) {
  const sql = normalizeSql(row?.sql);
  return (
    row?.type === 'table' &&
    tableColumns(db, 'spans_search')
      .map((column) => column.split(':', 1)[0])
      .join() === 'run_id,event_id,body' &&
    ftsSchemaPattern.test(sql)
  );
}

function unsupported(phase) {
  throw new SpansSearchError('SPANS_STORE_SCHEMA_UNSUPPORTED', phase);
}

/** Read-only schema check: returns `empty` or `current`, and never repairs drift. */
export function inspectSpansSearchSchema(db) {
  try {
    if (!db || typeof db.prepare !== 'function') {
      unsupported('database');
    }
    const objects = objectRows(db);
    const metadataExists = objects.some(
      (row) => row.name === 'metadata' && row.type === 'table'
    );
    const related = objects.filter((row) => searchObjectPattern.test(row.name));
    if (!metadataExists) {
      if (related.length === 0) {
        return 'empty';
      }
      unsupported('metadata-missing');
    }
    if (tableColumns(db, 'metadata').join() !== metadataColumns.join()) {
      unsupported('metadata-shape');
    }
    const value = metadataVersion(db);
    const main = objects.find((row) => row.name === 'spans_search');
    const progress = objects.find(
      (row) => row.name === 'spans_search_progress'
    );
    if (value === undefined) {
      if (related.length === 0) {
        return 'empty';
      }
      unsupported('objects-without-version');
    }
    const text = String(value);
    if (!versionPattern.test(text)) {
      unsupported('version');
    }
    const version = Number(text);
    if (version > SPANS_SEARCH_SCHEMA_VERSION) {
      throw new SpansSearchError('SPANS_STORE_SCHEMA_NEWER', 'version');
    }
    if (
      version !== SPANS_SEARCH_SCHEMA_VERSION ||
      !ftsShapeIsCurrent(main, db) ||
      !progressShapeIsCurrent(progress, db)
    ) {
      unsupported('shape');
    }
    validateBaseSchema(db, objects);
    return 'current';
  } catch (error) {
    if (error instanceof SpansSearchError) {
      throw error;
    }
    throw new SpansSearchError('SPANS_SEARCH_UNAVAILABLE', 'schema-inspect', {
      cause: error,
    });
  }
}

function immediate(db, work) {
  db.run('BEGIN IMMEDIATE');
  let committed = false;
  try {
    const result = work();
    try {
      db.run('COMMIT');
      committed = true;
    } catch (error) {
      throw new SpansSearchError('SPANS_SEARCH_OUTCOME_UNKNOWN', 'commit', {
        cause: error,
      });
    }
    return result;
  } catch (error) {
    if (!committed) {
      try {
        db.run('ROLLBACK');
      } catch (rollbackError) {
        throw new SpansSearchError('SPANS_SEARCH_OUTCOME_UNKNOWN', 'rollback', {
          cause: rollbackError,
        });
      }
    }
    throw error;
  }
}

/**
 * Initialize only the approved derived objects on an existing event-store DB.
 * Newer, malformed or partial schemas are refused before any write.
 */
export function initializeSpansSearchSchema(db) {
  const state = inspectSpansSearchSchema(db);
  if (state === 'current') {
    return { ok: true, version: SPANS_SEARCH_SCHEMA_VERSION };
  }
  try {
    const objects = objectRows(db);
    validateBaseSchema(db, objects);
    immediate(db, () => {
      // The immediate lock closes the check/create race with another opener.
      if (inspectSpansSearchSchema(db) === 'current') {
        return;
      }
      const currentObjects = objectRows(db);
      const related = currentObjects.filter((row) =>
        searchObjectPattern.test(row.name)
      );
      if (related.length > 0) {
        unsupported('partial-schema');
      }
      for (const statement of schemaStatements) {
        db.run(statement);
      }
      const insertVersion = db.prepare(
        'INSERT INTO metadata (key, value) VALUES (?, ?)'
      );
      try {
        insertVersion.run(
          SEARCH_VERSION_KEY,
          String(SPANS_SEARCH_SCHEMA_VERSION)
        );
      } finally {
        insertVersion.finalize();
      }
      if (inspectSpansSearchSchema(db) !== 'current') {
        unsupported('create');
      }
    });
    return { ok: true, version: SPANS_SEARCH_SCHEMA_VERSION };
  } catch (error) {
    if (error instanceof SpansSearchError) {
      throw error;
    }
    throw new SpansSearchError(
      'SPANS_SEARCH_SCHEMA_UNAVAILABLE',
      'schema-init',
      { cause: error }
    );
  }
}

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function readRequest(input, allowed, required) {
  if (!isPlainObject(input)) {
    return;
  }
  const keys = Reflect.ownKeys(input);
  if (
    keys.some((key) => typeof key !== 'string' || !allowed.includes(key)) ||
    required.some((key) => !keys.includes(key))
  ) {
    return;
  }
  const result = {};
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(input, key);
    if (!(descriptor?.enumerable && Object.hasOwn(descriptor, 'value'))) {
      return;
    }
    result[key] = descriptor.value;
  }
  return result;
}

function validCount(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function validIdentifier(value) {
  return typeof value === 'string' && identifierPattern.test(value);
}

function classifyFailure(error, fallback = 'SPANS_SEARCH_UNAVAILABLE') {
  if (error instanceof SpansSearchError && error.code in messages) {
    return error.code;
  }
  try {
    if (
      error?.errno === 5 ||
      lockedMessagePattern.test(String(error?.message))
    ) {
      return 'SPANS_SEARCH_BUSY';
    }
  } catch {
    // Do not inspect or echo odd adapter exceptions.
  }
  return fallback;
}

function failure(code) {
  return { code, error: messages[code], ok: false };
}

/**
 * Bounded `{ ok: false, code, error }` for a thrown SpansSearchError or a known
 * code string. Anything else is the fixed unavailable result, so callers never
 * forward adapter messages, paths or SQLite detail.
 */
export function spansSearchFailure(reason) {
  const code = typeof reason === 'string' ? reason : reason?.code;
  const known =
    reason instanceof SpansSearchError || typeof reason === 'string';
  return failure(
    known && typeof code === 'string' && Object.hasOwn(messages, code)
      ? code
      : 'SPANS_SEARCH_UNAVAILABLE'
  );
}

function progressRow(selectProgress) {
  const row = selectProgress.get();
  if (
    !(row && validCount(row.indexed_sequence) && validCount(row.generation))
  ) {
    throw new SpansSearchError('SPANS_SEARCH_CORRUPT', 'progress');
  }
  return row;
}

function sequenceHead(selectHead) {
  const row = selectHead.get();
  if (!(row && validCount(row.sequence))) {
    throw new SpansSearchError('SPANS_SEARCH_CORRUPT', 'head');
  }
  return row.sequence;
}

function validateCoverageCursor(progress, latestSequence) {
  if (progress.indexed_sequence > latestSequence) {
    throw new SpansSearchError('SPANS_SEARCH_CORRUPT', 'cursor-ahead-of-head');
  }
}

function coverage(progress, latestSequence) {
  return {
    complete: progress.indexed_sequence >= latestSequence,
    generation: progress.generation,
    indexedSequence: progress.indexed_sequence,
    latestSequence,
    stale: progress.indexed_sequence < latestSequence,
  };
}

function normalizeSearchText(text) {
  if (text === null || text === '') {
    return '';
  }
  if (typeof text !== 'string') {
    throw new SpansSearchError('SPANS_SEARCH_TEXT_INVALID', 'adapter-shape');
  }
  let redacted;
  try {
    redacted = redactSpansValue(text);
  } catch (error) {
    throw new SpansSearchError('SPANS_SEARCH_TEXT_INVALID', 'redaction', {
      cause: error,
    });
  }
  if (utf8ByteLength(redacted) > SPANS_SEARCH_LIMITS.documentBytes) {
    throw new SpansSearchError('SPANS_SEARCH_TEXT_INVALID', 'document-size');
  }
  return redacted;
}

function readCanonicalPayload(row) {
  try {
    if (
      typeof row.input_digest !== 'string' ||
      !digestPattern.test(row.input_digest) ||
      createHash('sha256')
        .update(
          `{"eventId":${JSON.stringify(row.event_id)},"payload":${row.payload_json},"runId":${JSON.stringify(row.run_id)},"type":${JSON.stringify(row.type)}}`
        )
        .digest('hex') !== row.input_digest
    ) {
      throw new Error('event digest mismatch');
    }
    return redactSpansValue(JSON.parse(row.payload_json));
  } catch (error) {
    throw new SpansSearchError('SPANS_SEARCH_EVENT_INVALID', 'integrity', {
      cause: error,
    });
  }
}

function redactedSnippet(value) {
  try {
    const snippet = redactSpansValue(value);
    if (
      typeof snippet !== 'string' ||
      utf8ByteLength(snippet) > SPANS_SEARCH_LIMITS.documentBytes
    ) {
      throw new TypeError('invalid snippet');
    }
    return snippet;
  } catch (error) {
    throw new SpansSearchError('SPANS_SEARCH_CORRUPT', 'snippet', {
      cause: error,
    });
  }
}

function parseTerms(value) {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > SPANS_SEARCH_LIMITS.queryChars
  ) {
    return;
  }
  const terms = [...new Set(value.match(tokenPattern) ?? [])];
  if (terms.length === 0 || terms.length > SPANS_SEARCH_LIMITS.queryTerms) {
    return;
  }
  // FTS syntax is built only from quoted Unicode alphanumeric tokens. User
  // punctuation and operators never reach MATCH as syntax.
  return terms.map((term) => `"${term.replaceAll('"', '""')}"`).join(' AND ');
}

function finalizeAll(statements) {
  let clean = true;
  for (const statement of statements) {
    try {
      statement.finalize();
    } catch {
      clean = false;
    }
  }
  return clean;
}

function validateIndexMetadata(metadata, previousSequence) {
  if (
    !validCount(metadata.sequence) ||
    metadata.sequence <= previousSequence ||
    !validIdentifier(metadata.run_id) ||
    !validIdentifier(metadata.event_id) ||
    redactSpansValue(metadata.run_id) !== metadata.run_id ||
    redactSpansValue(metadata.event_id) !== metadata.event_id ||
    !validIdentifier(metadata.type) ||
    redactSpansValue(metadata.type) !== metadata.type ||
    typeof metadata.input_digest !== 'string' ||
    !digestPattern.test(metadata.input_digest) ||
    !validCount(metadata.payload_bytes) ||
    metadata.payload_bytes < 1 ||
    metadata.payload_bytes > SPANS_SEARCH_LIMITS.eventPayloadBytes
  ) {
    throw new SpansSearchError('SPANS_SEARCH_EVENT_INVALID', 'metadata');
  }
}

function prepareIndexEvent(metadata, context) {
  const { state } = context;
  validateIndexMetadata(metadata, state.previousSequence);
  if (
    state.pageBytes + metadata.payload_bytes >
    SPANS_SEARCH_LIMITS.indexPageBytes
  ) {
    return false;
  }
  const row = context.selectIndexedEvent.get(
    metadata.sequence,
    metadata.event_id
  );
  if (
    !row ||
    row.sequence !== metadata.sequence ||
    row.event_id !== metadata.event_id ||
    row.run_id !== metadata.run_id ||
    row.type !== metadata.type ||
    row.input_digest !== metadata.input_digest ||
    row.payload_bytes !== metadata.payload_bytes ||
    row.sequence <= state.previousSequence ||
    state.seenIds.has(row.event_id) ||
    typeof row.payload_json !== 'string'
  ) {
    throw new SpansSearchError('SPANS_SEARCH_EVENT_INVALID', 'row');
  }
  state.seenIds.add(row.event_id);
  const event = {
    eventId: row.event_id,
    payload: readCanonicalPayload(row),
    runId: row.run_id,
    sequence: row.sequence,
    type: row.type,
  };
  let text;
  try {
    text = normalizeSearchText(context.textForEvent(event));
  } catch (error) {
    if (error instanceof SpansSearchError) {
      throw error;
    }
    throw new SpansSearchError('SPANS_SEARCH_SOURCE_FAILED', 'adapter', {
      cause: error,
    });
  }
  const textBytes = utf8ByteLength(text);
  if (
    state.pageBytes + metadata.payload_bytes + textBytes >
    SPANS_SEARCH_LIMITS.indexPageBytes
  ) {
    return false;
  }
  return { row, text };
}

function indexPageRows(pageRows, progress, statements, textForEvent) {
  const state = {
    indexed: 0,
    pageBytes: 0,
    previousSequence: progress.indexed_sequence,
    seenIds: new Set(),
  };
  const context = { ...statements, state, textForEvent };
  const documents = [];
  for (const metadata of pageRows) {
    const prepared = prepareIndexEvent(metadata, context);
    if (!prepared) {
      break;
    }
    documents.push(prepared);
    state.pageBytes += metadata.payload_bytes + utf8ByteLength(prepared.text);
    state.indexed += 1;
    state.previousSequence = prepared.row.sequence;
  }
  if (documents.length > 0) {
    statements.deletePage.run(
      progress.indexed_sequence,
      state.previousSequence
    );
    for (const { row, text } of documents) {
      if (text.length > 0) {
        statements.insertSearch.run(row.run_id, row.event_id, text);
      }
    }
  }
  return state;
}

function normalizeQueryRequest(input) {
  let request;
  try {
    request = readRequest(
      input,
      [
        'afterSequence',
        'expectedGeneration',
        'limit',
        'query',
        'runId',
        'throughSequence',
      ],
      ['limit', 'query']
    );
  } catch {
    return;
  }
  const expression = request && parseTerms(request.query);
  if (
    !(request?.limit && expression && Number.isSafeInteger(request.limit)) ||
    request.limit < 1 ||
    request.limit > SPANS_SEARCH_LIMITS.queryPage ||
    (request.afterSequence !== undefined &&
      !validCount(request.afterSequence)) ||
    (request.throughSequence !== undefined &&
      !validCount(request.throughSequence)) ||
    (request.expectedGeneration !== undefined &&
      !validCount(request.expectedGeneration)) ||
    ((request.afterSequence ?? 0) > 0 &&
      request.expectedGeneration === undefined) ||
    (request.runId !== undefined && !validIdentifier(request.runId))
  ) {
    return;
  }
  return { ...request, expression };
}

function queryHits(rows, limit) {
  return rows.slice(0, limit).map((row) => {
    if (
      !(
        validCount(row.sequence) &&
        validIdentifier(row.run_id) &&
        validIdentifier(row.event_id)
      ) ||
      typeof row.excerpt !== 'string'
    ) {
      throw new SpansSearchError('SPANS_SEARCH_CORRUPT', 'hit');
    }
    return {
      eventId: row.event_id,
      historical: true,
      runId: row.run_id,
      sequence: row.sequence,
      snippet: redactedSnippet(row.excerpt),
    };
  });
}

function querySnapshot(db, request, statements) {
  db.run('BEGIN');
  let committed = false;
  try {
    const progress = progressRow(statements.selectProgress);
    const latestSequence = sequenceHead(statements.selectHead);
    validateCoverageCursor(progress, latestSequence);
    const afterSequence = request.afterSequence ?? 0;
    if (
      request.expectedGeneration !== undefined &&
      request.expectedGeneration !== progress.generation
    ) {
      throw new SpansSearchError(
        'SPANS_SEARCH_STALE_GENERATION',
        'query-generation'
      );
    }
    const throughSequence =
      request.throughSequence ?? progress.indexed_sequence;
    if (
      afterSequence > throughSequence ||
      throughSequence > progress.indexed_sequence
    ) {
      throw new SpansSearchError('SPANS_SEARCH_QUERY_INVALID', 'cursor');
    }
    const rows = statements.selectMatches.all(
      request.expression,
      afterSequence,
      throughSequence,
      request.runId ?? null,
      request.runId ?? null,
      request.limit + 1
    );
    const hits = queryHits(rows, request.limit);
    try {
      db.run('COMMIT');
      committed = true;
    } catch (error) {
      throw new SpansSearchError(
        'SPANS_SEARCH_OUTCOME_UNKNOWN',
        'query-commit',
        { cause: error }
      );
    }
    return {
      coverage: coverage(progress, latestSequence),
      generation: progress.generation,
      hasMore: rows.length > request.limit,
      hits,
      nextSequence: hits.at(-1)?.sequence ?? afterSequence,
      ok: true,
      throughSequence,
    };
  } catch (error) {
    if (!committed) {
      try {
        db.run('ROLLBACK');
      } catch (rollbackError) {
        throw new SpansSearchError(
          'SPANS_SEARCH_OUTCOME_UNKNOWN',
          'query-rollback',
          { cause: rollbackError }
        );
      }
    }
    throw error;
  }
}

/**
 * Build a search service over the same connection that owns canonical events.
 * `textForEvent` receives a redacted event and returns only approved searchable
 * prose, including artifact text when the caller has safely resolved it. It
 * must omit source paths and raw transcript blobs. Construction prepares local
 * statements but does not index anything; call close() to finalize them.
 */
export function createSpansSearch(options) {
  let optionsRequest;
  try {
    optionsRequest = readRequest(
      options,
      ['db', 'textForEvent'],
      ['db', 'textForEvent']
    );
  } catch {
    optionsRequest = undefined;
  }
  if (
    !optionsRequest?.db ||
    typeof optionsRequest.db.prepare !== 'function' ||
    typeof optionsRequest.db.run !== 'function' ||
    typeof optionsRequest.textForEvent !== 'function'
  ) {
    throw new SpansSearchError('SPANS_SEARCH_INVALID', 'options');
  }
  if (inspectSpansSearchSchema(optionsRequest.db) !== 'current') {
    throw new SpansSearchError(
      'SPANS_STORE_SCHEMA_UNSUPPORTED',
      'not-initialized'
    );
  }

  const { db, textForEvent } = optionsRequest;
  const owned = [];
  const prepare = (sql) => {
    const statement = db.prepare(sql);
    owned.push(statement);
    return statement;
  };
  let prepared;
  try {
    prepared = {
      deletePage: prepare(
        `DELETE FROM spans_search WHERE event_id IN (
          SELECT event_id FROM events WHERE sequence > ? AND sequence <= ?
        )`
      ),
      insertSearch: prepare(
        'INSERT INTO spans_search (run_id, event_id, body) VALUES (?, ?, ?)'
      ),
      selectHead: prepare(
        'SELECT COALESCE(MAX(sequence), 0) AS sequence FROM events'
      ),
      selectIndexedEvent: prepare(
        `SELECT sequence, event_id, run_id, type, payload_json, input_digest,
          length(CAST(payload_json AS BLOB)) AS payload_bytes
        FROM events WHERE sequence = ? AND event_id = ?`
      ),
      selectMatches: prepare(
        `SELECT e.sequence, spans_search.run_id, spans_search.event_id,
          snippet(spans_search, 2, '', '', ' … ', 14) AS excerpt
        FROM spans_search
        JOIN events AS e ON e.event_id = spans_search.event_id
        WHERE spans_search MATCH ?
          AND e.sequence > ? AND e.sequence <= ?
          AND (? IS NULL OR spans_search.run_id = ?)
        ORDER BY e.sequence ASC
        LIMIT ?`
      ),
      selectPage: prepare(
        `SELECT sequence, event_id, run_id, type, input_digest,
          length(CAST(payload_json AS BLOB)) AS payload_bytes
        FROM events WHERE sequence > ? ORDER BY sequence ASC LIMIT ?`
      ),
      selectProgress: prepare(
        'SELECT indexed_sequence, generation FROM spans_search_progress WHERE singleton = 1'
      ),
      selectStatus: prepare(
        `SELECT indexed_sequence, generation,
          COALESCE((SELECT MAX(sequence) FROM events), 0) AS latest_sequence
        FROM spans_search_progress WHERE singleton = 1`
      ),
      updateProgress: prepare(
        'UPDATE spans_search_progress SET indexed_sequence = ?, generation = ? WHERE singleton = 1'
      ),
    };
  } catch (error) {
    finalizeAll(owned);
    throw new SpansSearchError('SPANS_SEARCH_UNAVAILABLE', 'prepare', {
      cause: error,
    });
  }
  let closed = false;
  let finalized = false;
  const {
    deletePage,
    insertSearch,
    selectHead,
    selectIndexedEvent,
    selectMatches,
    selectPage,
    selectProgress,
    selectStatus,
    updateProgress,
  } = prepared;

  function finalizeStatements() {
    if (finalized) {
      return { ok: true };
    }
    finalized = true;
    closed = true;
    return finalizeAll(owned)
      ? { ok: true }
      : failure('SPANS_SEARCH_UNAVAILABLE');
  }

  const service = {
    close: finalizeStatements,
    closeStatements: finalizeStatements,

    indexPage(input) {
      if (closed) {
        return failure('SPANS_SEARCH_CLOSED');
      }
      let page;
      try {
        page = readRequest(input, ['limit'], ['limit']);
      } catch {
        page = undefined;
      }
      if (
        !(page && Number.isSafeInteger(page.limit)) ||
        page.limit < 1 ||
        page.limit > SPANS_SEARCH_LIMITS.indexPage
      ) {
        return failure('SPANS_SEARCH_INVALID');
      }
      try {
        return immediate(db, () => {
          const progress = progressRow(selectProgress);
          const latestAtStart = sequenceHead(selectHead);
          validateCoverageCursor(progress, latestAtStart);
          const rows = selectPage.all(
            progress.indexed_sequence,
            page.limit + 1
          );
          const pageRows = rows.slice(0, page.limit);
          const state = indexPageRows(
            pageRows,
            progress,
            { deletePage, insertSearch, selectIndexedEvent },
            textForEvent
          );
          if (state.indexed > 0) {
            const update = updateProgress.run(
              state.previousSequence,
              progress.generation
            );
            if (update.changes !== 1) {
              throw new SpansSearchError(
                'SPANS_SEARCH_CORRUPT',
                'progress-update'
              );
            }
          }
          const latestSequence = sequenceHead(selectHead);
          const updated =
            state.indexed > 0
              ? {
                  generation: progress.generation,
                  indexed_sequence: state.previousSequence,
                }
              : progress;
          return {
            coverage: coverage(updated, latestSequence),
            generation: progress.generation,
            hasMore: rows.length > state.indexed,
            indexed: state.indexed,
            nextSequence: state.previousSequence,
            ok: true,
          };
        });
      } catch (error) {
        return failure(classifyFailure(error));
      }
    },

    invalidate() {
      if (closed) {
        return failure('SPANS_SEARCH_CLOSED');
      }
      try {
        return immediate(db, () => {
          const progress = progressRow(selectProgress);
          if (progress.generation >= Number.MAX_SAFE_INTEGER) {
            throw new SpansSearchError(
              'SPANS_SEARCH_CORRUPT',
              'generation-overflow'
            );
          }
          const generation = progress.generation + 1;
          // Keep historical FTS rows. A fresh full pass replaces derived rows
          // idempotently; canonical events and artifacts are never removed.
          const update = updateProgress.run(0, generation);
          if (update.changes !== 1) {
            throw new SpansSearchError(
              'SPANS_SEARCH_CORRUPT',
              'progress-update'
            );
          }
          return {
            coverage: {
              complete: false,
              generation,
              indexedSequence: 0,
              stale: true,
            },
            generation,
            ok: true,
          };
        });
      } catch (error) {
        return failure(classifyFailure(error));
      }
    },

    query(input) {
      if (closed) {
        return failure('SPANS_SEARCH_CLOSED');
      }
      const request = normalizeQueryRequest(input);
      if (!request) {
        return failure('SPANS_SEARCH_QUERY_INVALID');
      }
      try {
        return querySnapshot(db, request, {
          selectHead,
          selectMatches,
          selectProgress,
        });
      } catch (error) {
        return failure(classifyFailure(error));
      }
    },

    status() {
      if (closed) {
        return failure('SPANS_SEARCH_CLOSED');
      }
      try {
        const row = selectStatus.get();
        if (
          !(
            row &&
            validCount(row.indexed_sequence) &&
            validCount(row.generation) &&
            validCount(row.latest_sequence)
          )
        ) {
          throw new SpansSearchError('SPANS_SEARCH_CORRUPT', 'status');
        }
        const progress = row;
        const latestSequence = row.latest_sequence;
        validateCoverageCursor(progress, latestSequence);
        return {
          coverage: coverage(progress, latestSequence),
          generation: progress.generation,
          ok: true,
        };
      } catch (error) {
        return failure(classifyFailure(error));
      }
    },
  };

  return Object.freeze(service);
}
