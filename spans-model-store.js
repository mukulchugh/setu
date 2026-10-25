// Transactional run-view, import-cursor and derived-cache persistence for Setu
// Spans. It never opens a database: it is handed the SAME connection that
// openSpansStore owns, plus that store's appendEvent, and so adds no second
// owner. Construction touches only the supplemental spans_* tables and the
// model_schema_version metadata key. It never deletes, migrates or commits
// provider work. Redaction is a caller boundary: every document stored here
// must already be redacted, JSON-compatible data.
//
// The only db members used are prepare, query and run. db.transaction is never
// used: on Bun 1.3.4 its internal statements keep db.close(true) BUSY.

import { createHash } from 'node:crypto';

export const SPANS_MODEL_SCHEMA_VERSION = 1;
export const SPANS_MODEL_LIMITS = Object.freeze({
  batchBytes: 4_194_304,
  depth: 64,
  documentBytes: 1_048_576,
  eventsPerBatch: 200,
  pageLimit: 200,
});

const DEFAULT_PAGE_LIMIT = 50;
const MODEL_VERSION_KEY = 'model_schema_version';
const SQLITE_BUSY = 5;
const identifierPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const cacheKeyPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const versionPattern = /^[1-9]\d{0,8}$/;
const eventCodePattern = /^SPANS_[A-Z0-9_]{1,60}$/;
const lockedMessagePattern = /database is locked/i;
const listKeys = ['afterRunId', 'limit', 'phase', 'query'];
// A zero-progress batch (nextOffset === expectedOffset) may carry only these.
const zeroProgressEventTypes = new Set(['source.gap', 'source.checkpoint']);
// Marks a stored digest that belongs to a zero-progress batch. It is stripped
// before a digest is returned, so callers only ever see the 64-hex digest.
const ZERO_PROGRESS_SUFFIX = ':zero';

const tableStatements = [
  `CREATE TABLE IF NOT EXISTS spans_views (
    run_id TEXT PRIMARY KEY,
    revision INTEGER NOT NULL,
    generation INTEGER NOT NULL,
    view_json TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS spans_sources (
    source_id TEXT,
    source_generation INTEGER,
    parser_version TEXT,
    byte_offset INTEGER,
    last_batch_digest TEXT NOT NULL,
    PRIMARY KEY (source_id, source_generation, parser_version)
  )`,
  `CREATE TABLE IF NOT EXISTS spans_cache (
    cache_key TEXT PRIMARY KEY,
    entry_json TEXT NOT NULL
  )`,
];
const expectedColumns = {
  spans_cache: ['cache_key:TEXT:0:1', 'entry_json:TEXT:1:0'],
  spans_sources: [
    'source_id:TEXT:0:1',
    'source_generation:INTEGER:0:2',
    'parser_version:TEXT:0:3',
    'byte_offset:INTEGER:0:0',
    'last_batch_digest:TEXT:1:0',
  ],
  spans_views: [
    'run_id:TEXT:0:1',
    'revision:INTEGER:1:0',
    'generation:INTEGER:1:0',
    'view_json:TEXT:1:0',
  ],
};
const messages = Object.freeze({
  SPANS_MODEL_BUSY: 'Spans model store is busy; try again.',
  SPANS_MODEL_CLOSED: 'Spans model store is closed.',
  SPANS_MODEL_CORRUPT: 'Spans model store failed an integrity check.',
  SPANS_MODEL_EVENT_REFUSED: 'Spans event was refused; nothing was committed.',
  SPANS_MODEL_FENCE_STALE:
    'Spans run fence is stale; the run or its approval changed.',
  SPANS_MODEL_GENERATION_INVALID:
    'Spans view generation must equal the expected generation or advance it by one.',
  SPANS_MODEL_INVALID: 'Invalid spans model request.',
  SPANS_MODEL_NOT_FOUND: 'Spans model record was not found.',
  SPANS_MODEL_OFFSET_CONFLICT:
    'Spans import offset conflicts with the stored cursor.',
  SPANS_MODEL_STALE_GENERATION: 'Spans run generation is stale.',
  SPANS_MODEL_STALE_REVISION: 'Spans run revision is stale.',
  SPANS_MODEL_UNAVAILABLE: 'Spans model store is unavailable.',
});

// Construction failures throw this. The schema codes deliberately reuse the
// event store's SPANS_STORE_SCHEMA_* values so openSpansStore can surface them.
export class SpansModelError extends Error {
  constructor(code, phase) {
    super(`${code}: ${phase}`);
    this.name = 'SpansModelError';
    this.code = code;
    this.phase = phase;
  }
}

const refusal = (code, extra) => ({
  ...extra,
  code,
  error: messages[code],
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
const isCount = (value) => Number.isSafeInteger(value) && value >= 0;

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

// ---------------------------------------------------------------------------
// Canonical JSON: strict, bounded, key-sorted, so equal input is equal bytes.
// Anything JSON.stringify would coerce or drop (undefined, NaN, holes, symbols,
// getters, class instances) is rejected. Cycles hit the depth bound.
// ---------------------------------------------------------------------------

function reject() {
  throw new TypeError('invalid spans model document');
}

function spend(state, count) {
  state.remaining -= count;
  if (state.remaining < 0) {
    reject();
  }
}

function emit(state, text) {
  spend(state, text.length);
  return text;
}

function ownDataValue(target, key) {
  const descriptor = Object.getOwnPropertyDescriptor(target, key);
  if (!(descriptor?.enumerable && 'value' in descriptor)) {
    reject();
  }
  return descriptor.value;
}

function canonicalArray(array, state, depth) {
  if (
    Object.getPrototypeOf(array) !== Array.prototype ||
    Reflect.ownKeys(array).length !== array.length + 1
  ) {
    reject();
  }
  const items = [];
  for (let index = 0; index < array.length; index += 1) {
    items.push(canonicalValue(ownDataValue(array, index), state, depth + 1));
  }
  spend(state, items.length + 1);
  return `[${items.join(',')}]`;
}

function canonicalObject(object, state, depth) {
  const keys = Reflect.ownKeys(object);
  if (!isPlainObject(object) || keys.some((key) => typeof key !== 'string')) {
    reject();
  }
  const members = keys
    .sort(compareText)
    .map(
      (key) =>
        `${emit(state, JSON.stringify(key))}:${canonicalValue(
          ownDataValue(object, key),
          state,
          depth + 1
        )}`
    );
  spend(state, members.length * 2 + 1);
  return `{${members.join(',')}}`;
}

function canonicalValue(value, state, depth) {
  if (depth > SPANS_MODEL_LIMITS.depth) {
    reject();
  }
  if (value === null) {
    return emit(state, 'null');
  }
  switch (typeof value) {
    case 'boolean':
      return emit(state, String(value));
    case 'number':
      return Number.isFinite(value)
        ? emit(state, JSON.stringify(value))
        : reject();
    case 'string':
      return emit(state, JSON.stringify(value));
    case 'object':
      return Array.isArray(value)
        ? canonicalArray(value, state, depth)
        : canonicalObject(value, state, depth);
    default:
      return reject();
  }
}

function canonicalJson(value, maxBytes) {
  const json = canonicalValue(value, { remaining: maxBytes }, 0);
  // The running budget counts UTF-16 units; the limit is in bytes.
  if (Buffer.byteLength(json, 'utf8') > maxBytes) {
    reject();
  }
  return json;
}

// Round-trips through canonical JSON, so the validated bytes are exactly what
// is stored and what later code reads: a getter cannot answer twice.
function documentCopy(value, maxBytes) {
  const json = canonicalJson(value, maxBytes);
  return { copy: JSON.parse(json), json };
}

// ---------------------------------------------------------------------------
// Request normalization. Each returns a frozen-shape copy or undefined.
// ---------------------------------------------------------------------------

function pick(input, required, optional = []) {
  if (!isPlainObject(input)) {
    return;
  }
  const keys = Reflect.ownKeys(input);
  const allowed = new Set([...required, ...optional]);
  if (
    !(
      keys.every((key) => allowed.has(key)) &&
      required.every((key) => keys.includes(key))
    )
  ) {
    return;
  }
  return Object.fromEntries(keys.map((key) => [key, input[key]]));
}

function normalizeBatch(events, runId) {
  if (
    !Array.isArray(events) ||
    events.length > SPANS_MODEL_LIMITS.eventsPerBatch
  ) {
    return;
  }
  const { copy, json } = documentCopy(events, SPANS_MODEL_LIMITS.batchBytes);
  const valid = copy.every(
    (event) =>
      isPlainObject(event) && (runId === undefined || event.runId === runId)
  );
  return valid ? { copies: copy, json } : undefined;
}

function normalizeRunRef(input) {
  const request = pick(input, ['runId']);
  return request && isIdentifier(request.runId) ? request : undefined;
}

function normalizeCommit(input) {
  const request = pick(input, [
    'events',
    'expectedGeneration',
    'expectedRevision',
    'runId',
    'view',
  ]);
  if (
    !(
      request &&
      isIdentifier(request.runId) &&
      isCount(request.expectedRevision) &&
      isCount(request.expectedGeneration) &&
      isPlainObject(request.view)
    )
  ) {
    return;
  }
  const batch = normalizeBatch(request.events, request.runId);
  const view = documentCopy(request.view, SPANS_MODEL_LIMITS.documentBytes);
  if (!(batch && isCount(view.copy.generation))) {
    return;
  }
  return {
    events: batch.copies,
    expectedGeneration: request.expectedGeneration,
    expectedRevision: request.expectedRevision,
    generation: view.copy.generation,
    runId: request.runId,
    viewJson: view.json,
  };
}

const isSourceKey = ({ parserVersion, sourceGeneration, sourceId }) =>
  isIdentifier(sourceId) &&
  isCount(sourceGeneration) &&
  isIdentifier(parserVersion);

function normalizeCursorKey(input) {
  const request = pick(input, [
    'parserVersion',
    'sourceGeneration',
    'sourceId',
  ]);
  return request && isSourceKey(request) ? request : undefined;
}

// An import may be fenced to one run: it commits only while that run is at this
// plan generation and its view still holds this association as approved for it.
// Exactly these three fields; nothing generic.
function normalizeFence(input) {
  const fence = pick(input, ['associationId', 'generation', 'runId']);
  return fence &&
    isIdentifier(fence.associationId) &&
    isIdentifier(fence.runId) &&
    isCount(fence.generation)
    ? fence
    : undefined;
}

// The digest binds both offsets and the exact events, so only a byte-identical
// retry of the same batch can be recognised as a duplicate.
function batchDigest(json, expectedOffset, nextOffset) {
  return createHash('sha256')
    .update(
      `{"events":${json},"expectedOffset":${expectedOffset},"nextOffset":${nextOffset}}`
    )
    .digest('hex');
}

// nextOffset may equal expectedOffset only for an empty batch or one holding
// source gaps and their identity checkpoint. Other events require advancing bytes.
function normalizeImport(input) {
  const request = pick(
    input,
    [
      'events',
      'expectedOffset',
      'nextOffset',
      'parserVersion',
      'sourceGeneration',
      'sourceId',
    ],
    ['fence']
  );
  if (
    !(
      request &&
      isSourceKey(request) &&
      isCount(request.expectedOffset) &&
      isCount(request.nextOffset) &&
      request.nextOffset >= request.expectedOffset
    )
  ) {
    return;
  }
  const fence =
    request.fence === undefined ? undefined : normalizeFence(request.fence);
  if (request.fence !== undefined && !fence) {
    return;
  }
  // A fenced batch may only write to the run it is fenced to.
  const batch = normalizeBatch(request.events, fence?.runId);
  if (!batch) {
    return;
  }
  const { expectedOffset, nextOffset, parserVersion } = request;
  const zeroProgress = nextOffset === expectedOffset;
  if (
    zeroProgress &&
    (!batch.copies.every((event) => zeroProgressEventTypes.has(event.type)) ||
      (batch.copies.some((event) => event.type === 'source.checkpoint') &&
        !batch.copies.some((event) => event.type === 'source.gap')))
  ) {
    return;
  }
  return {
    digest: batchDigest(batch.json, expectedOffset, nextOffset),
    events: batch.copies,
    expectedOffset,
    fence,
    nextOffset,
    parserVersion,
    sourceGeneration: request.sourceGeneration,
    sourceId: request.sourceId,
    zeroProgress,
  };
}

function normalizeFencedEvents(input) {
  const request = pick(input, ['events', 'fence']);
  const fence = request ? normalizeFence(request.fence) : undefined;
  if (!(fence && Array.isArray(request.events) && request.events.length > 0)) {
    return;
  }
  const batch = normalizeBatch(request.events, fence.runId);
  return batch ? { events: batch.copies, fence } : undefined;
}

function normalizeList(input) {
  const request = pick(input, [], listKeys);
  if (!request) {
    return;
  }
  const {
    afterRunId,
    limit = DEFAULT_PAGE_LIMIT,
    phase = 'all',
    query = '',
  } = request;
  if (
    (afterRunId !== undefined && !isIdentifier(afterRunId)) ||
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > SPANS_MODEL_LIMITS.pageLimit ||
    !['all', 'past', 'live', 'planned'].includes(phase) ||
    typeof query !== 'string' ||
    query.length > 256
  ) {
    return;
  }
  return { afterRunId, limit, phase, query };
}

function normalizeCacheWrite(key, entry) {
  if (!(typeof key === 'string' && cacheKeyPattern.test(key))) {
    return;
  }
  if (!isPlainObject(entry)) {
    return;
  }
  return {
    entryJson: canonicalJson(entry, SPANS_MODEL_LIMITS.documentBytes),
    key,
  };
}

// ---------------------------------------------------------------------------
// Failure mapping. Exception messages are never copied: SQLite and the
// filesystem put paths in them.
// ---------------------------------------------------------------------------

function isBusy(error) {
  return (
    (Number.isInteger(error?.errno) && error.errno % 256 === SQLITE_BUSY) ||
    (typeof error?.code === 'string' && error.code.startsWith('SQLITE_BUSY')) ||
    lockedMessagePattern.test(String(error?.message))
  );
}

function storageFailure(error) {
  if (error instanceof SpansModelError && error.code in messages) {
    return refusal(error.code);
  }
  return refusal(
    isBusy(error) ? 'SPANS_MODEL_BUSY' : 'SPANS_MODEL_UNAVAILABLE'
  );
}

function corrupt(phase) {
  return new SpansModelError('SPANS_MODEL_CORRUPT', phase);
}

function decodeDocument(text, phase) {
  try {
    const value = JSON.parse(text);
    if (isPlainObject(value)) {
      return value;
    }
  } catch {
    // Reported as corruption below; the parser message is never kept.
  }
  throw corrupt(phase);
}

// ---------------------------------------------------------------------------
// Schema. Everything before the write transaction is read-only; nothing may
// mutate the file until model_schema_version is absent or exactly 1.
// ---------------------------------------------------------------------------

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

function metadataColumns(db) {
  return db
    .query('SELECT name FROM pragma_table_info(?)')
    .all('metadata')
    .map((column) => column.name);
}

const hasMetadataShape = (columns) =>
  columns.includes('key') && columns.includes('value');

function existingModelTables(db) {
  return db
    .query("SELECT name FROM sqlite_master WHERE type = 'table'")
    .all()
    .map((row) => row.name)
    .filter((name) => name in expectedColumns);
}

// Returns 0 when the key is absent; throws for newer, malformed or no metadata.
function storedModelVersion(db) {
  if (!hasMetadataShape(metadataColumns(db))) {
    throw new SpansModelError('SPANS_STORE_SCHEMA_UNSUPPORTED', 'metadata');
  }
  const row = db
    .query('SELECT value FROM metadata WHERE key = ?')
    .get(MODEL_VERSION_KEY);
  if (!row) {
    return 0;
  }
  const text = String(row.value);
  if (!versionPattern.test(text)) {
    throw new SpansModelError(
      'SPANS_STORE_SCHEMA_UNSUPPORTED',
      'model-version'
    );
  }
  const version = Number(text);
  if (version > SPANS_MODEL_SCHEMA_VERSION) {
    throw new SpansModelError('SPANS_STORE_SCHEMA_NEWER', 'model-version');
  }
  return version;
}

function verifyModelTables(db) {
  const intact = Object.entries(expectedColumns).every(
    ([table, expected]) => columnSignature(db, table).join() === expected.join()
  );
  if (!intact) {
    throw new SpansModelError('SPANS_STORE_SCHEMA_UNSUPPORTED', 'model-shape');
  }
}

// READ-ONLY. Returns 'empty' (no model version and no model tables, so a
// creator may add them) or 'current' (version 1 with intact tables). A newer,
// malformed or drifted schema throws a SpansModelError with a fixed code. It
// issues only SELECTs, so a refusal has not touched the file. A database with
// no metadata table at all is 'empty' only while it holds no model table; the
// store still refuses to build on it (see requireMetadata).
export function inspectSpansModelSchema(db) {
  const columns = metadataColumns(db);
  const tables = existingModelTables(db);
  if (columns.length === 0) {
    if (tables.length === 0) {
      return 'empty';
    }
    throw new SpansModelError('SPANS_STORE_SCHEMA_UNSUPPORTED', 'metadata');
  }
  // Throws for malformed or newer versions before the tables are examined.
  if (storedModelVersion(db) === 0) {
    if (tables.length === 0) {
      return 'empty';
    }
    throw new SpansModelError('SPANS_STORE_SCHEMA_UNSUPPORTED', 'model-shape');
  }
  verifyModelTables(db);
  return 'current';
}

// Model tables hang off the event store's metadata table; never create it here.
function requireMetadata(db) {
  if (!hasMetadataShape(metadataColumns(db))) {
    throw new SpansModelError('SPANS_STORE_SCHEMA_UNSUPPORTED', 'metadata');
  }
}

function createModelTables(db) {
  // Another opener may have finished since the pre-check.
  if (inspectSpansModelSchema(db) === 'current') {
    return;
  }
  requireMetadata(db);
  for (const statement of tableStatements) {
    db.run(statement);
  }
  db.query('INSERT INTO metadata (key, value) VALUES (?, ?)').run(
    MODEL_VERSION_KEY,
    String(SPANS_MODEL_SCHEMA_VERSION)
  );
  if (inspectSpansModelSchema(db) !== 'current') {
    throw new SpansModelError('SPANS_STORE_SCHEMA_UNSUPPORTED', 'model-create');
  }
}

// BEGIN IMMEDIATE takes the write lock before any read inside `work`, which is
// what makes every compare-and-set here atomic. Plain statements stand in for
// db.transaction(): on Bun 1.3.4 its internal BEGIN/COMMIT/ROLLBACK statements
// outlive db.close(true), which then fails with SQLITE_BUSY. A failed COMMIT
// throws, so it is never reported as success; the failure that led to the
// rollback is the one rethrown even if the rollback itself also fails.
function immediate(db, work) {
  db.run('BEGIN IMMEDIATE');
  try {
    const result = work();
    db.run('COMMIT');
    return result;
  } catch (error) {
    try {
      db.run('ROLLBACK');
    } catch {
      // The original failure is the one worth reporting.
    }
    throw error;
  }
}

function initializeModelSchema(db) {
  if (inspectSpansModelSchema(db) === 'current') {
    return;
  }
  requireMetadata(db);
  immediate(db, () => createModelTables(db));
}

// ---------------------------------------------------------------------------
// Statements. Uncached and owned here; closeStatements() finalizes them before
// the parent releases the connection so none can keep the file locked.
// ---------------------------------------------------------------------------

function finalizeAll(statements) {
  let clean = true;
  for (const statement of statements) {
    try {
      // finalize() is safe to repeat, so a retried close after a failure works.
      statement.finalize();
    } catch {
      clean = false;
    }
  }
  return clean;
}

function prepareStatements(db) {
  const owned = [];
  const prepare = (sql) => {
    const statement = db.prepare(sql);
    owned.push(statement);
    return statement;
  };
  try {
    return {
      insertView: prepare(
        'INSERT INTO spans_views (run_id, revision, generation, view_json) VALUES (?, ?, ?, ?)'
      ),
      listRuns: prepare(
        `SELECT run_id, revision, generation FROM spans_views WHERE run_id > ?
        AND (? = 'all' OR CASE WHEN (CASE WHEN json_valid(view_json) THEN json_extract(view_json, '$.kind') END) = 'imported' THEN 'past'
          ELSE CASE lower(replace((CASE WHEN json_valid(view_json) THEN json_extract(view_json, '$.state') END), '_', ' '))
          WHEN 'planned' THEN 'planned' WHEN 'ready' THEN 'planned'
          WHEN 'imported' THEN 'past' WHEN 'completed' THEN 'past' WHEN 'failed' THEN 'past' WHEN 'cancelled' THEN 'past'
          WHEN 'running' THEN 'live' WHEN 'waiting for you' THEN 'live' WHEN 'paused' THEN 'live'
          WHEN 'recovery required' THEN 'live' WHEN 'blocked' THEN 'live' ELSE 'unknown' END END = ?)
        AND instr(lower(run_id || ' ' || coalesce((CASE WHEN json_valid(view_json) THEN json_extract(view_json, '$.goal') END), '') || ' ' ||
          coalesce((CASE WHEN json_valid(view_json) THEN json_extract(view_json, '$.owner') END), '') || ' ' || coalesce((CASE WHEN json_valid(view_json) THEN json_extract(view_json, '$.project') END), '')), lower(?)) > 0
        ORDER BY run_id ASC LIMIT ?`
      ),
      owned,
      selectCache: prepare(
        'SELECT entry_json FROM spans_cache WHERE cache_key = ?'
      ),
      selectSource: prepare(
        'SELECT byte_offset, last_batch_digest FROM spans_sources WHERE source_id = ? AND source_generation = ? AND parser_version = ?'
      ),
      selectView: prepare(
        'SELECT revision, generation, view_json FROM spans_views WHERE run_id = ?'
      ),
      updateView: prepare(
        'UPDATE spans_views SET revision = ?, generation = ?, view_json = ? WHERE run_id = ? AND revision = ? AND generation = ?'
      ),
      upsertCache: prepare(
        'INSERT INTO spans_cache (cache_key, entry_json) VALUES (?, ?) ON CONFLICT(cache_key) DO UPDATE SET entry_json = excluded.entry_json'
      ),
      upsertSource: prepare(
        'INSERT INTO spans_sources (source_id, source_generation, parser_version, byte_offset, last_batch_digest) VALUES (?, ?, ?, ?, ?) ON CONFLICT(source_id, source_generation, parser_version) DO UPDATE SET byte_offset = excluded.byte_offset, last_batch_digest = excluded.last_batch_digest'
      ),
    };
  } catch (error) {
    finalizeAll(owned);
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Row checks. Every row is re-verified on the way out.
// ---------------------------------------------------------------------------

function viewState(row) {
  if (!row) {
    return { exists: false, generation: 0, revision: 0 };
  }
  if (
    !(
      isCount(row.revision) &&
      isCount(row.generation) &&
      typeof row.view_json === 'string'
    )
  ) {
    throw corrupt('view-row');
  }
  return {
    exists: true,
    generation: row.generation,
    revision: row.revision,
    viewJson: row.view_json,
  };
}

function cursorState(row) {
  if (!row) {
    return { digest: null, exists: false, offset: 0, zeroProgress: false };
  }
  if (
    !(isCount(row.byte_offset) && typeof row.last_batch_digest === 'string')
  ) {
    throw corrupt('cursor-row');
  }
  const stored = row.last_batch_digest;
  const zeroProgress = stored.endsWith(ZERO_PROGRESS_SUFFIX);
  return {
    digest: zeroProgress
      ? stored.slice(0, -ZERO_PROGRESS_SUFFIX.length)
      : stored,
    exists: true,
    offset: row.byte_offset,
    zeroProgress,
  };
}

function summaryOf(row) {
  if (
    !(
      typeof row.run_id === 'string' &&
      isCount(row.revision) &&
      isCount(row.generation)
    )
  ) {
    throw corrupt('list-row');
  }
  return {
    generation: row.generation,
    revision: row.revision,
    runId: row.run_id,
  };
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

function eventCodeOf(outcome) {
  const code = attempt(() => outcome?.code);
  return typeof code === 'string' && eventCodePattern.test(code)
    ? { eventCode: code }
    : undefined;
}

// refuse() records the result before throwing: if rolling back a transaction
// that appendEvent already disturbed raises its own error, the recorded
// refusal is still what the caller sees.
function refuse(box, result) {
  box.refusal = result;
  throw new Error('spans model transaction refused');
}

export function createSpansModelStore(options) {
  const input = pick(options, ['appendEvent', 'db']);
  if (
    !(
      input &&
      typeof input.appendEvent === 'function' &&
      typeof input.db?.prepare === 'function' &&
      typeof input.db?.query === 'function' &&
      typeof input.db?.run === 'function'
    )
  ) {
    throw new SpansModelError('SPANS_MODEL_OPTIONS_INVALID', 'options');
  }
  const { appendEvent, db } = input;
  initializeModelSchema(db);
  const { owned, ...statements } = prepareStatements(db);
  let closed = false;

  const atomic = (job) => {
    if (closed) {
      return refusal('SPANS_MODEL_CLOSED');
    }
    const box = {};
    try {
      return immediate(db, () => job(box));
    } catch (error) {
      return box.refusal ?? storageFailure(error);
    }
  };
  const read = (work) => {
    if (closed) {
      return refusal('SPANS_MODEL_CLOSED');
    }
    try {
      return work();
    } catch (error) {
      return storageFailure(error);
    }
  };

  // Runs inside the caller's transaction; the first refusal aborts it whole.
  function appendAll(box, events) {
    for (const event of events) {
      const outcome = appendEvent(event);
      if (outcome?.ok !== true) {
        refuse(box, refusal('SPANS_MODEL_EVENT_REFUSED', eventCodeOf(outcome)));
      }
    }
  }

  function writeView(request, current) {
    const revision = current.revision + 1;
    const result = current.exists
      ? statements.updateView.run(
          revision,
          request.generation,
          request.viewJson,
          request.runId,
          current.revision,
          current.generation
        )
      : statements.insertView.run(
          request.runId,
          revision,
          request.generation,
          request.viewJson
        );
    if (!Number.isSafeInteger(revision) || result.changes !== 1) {
      throw new SpansModelError('SPANS_MODEL_UNAVAILABLE', 'view-write');
    }
    return revision;
  }

  function commitRun(raw) {
    const request = attempt(() => normalizeCommit(raw));
    if (!request) {
      return refusal('SPANS_MODEL_INVALID');
    }
    const step = request.generation - request.expectedGeneration;
    if (step !== 0 && step !== 1) {
      return refusal('SPANS_MODEL_GENERATION_INVALID');
    }
    return atomic((box) => {
      const current = viewState(statements.selectView.get(request.runId));
      if (current.revision !== request.expectedRevision) {
        refuse(box, refusal('SPANS_MODEL_STALE_REVISION'));
      }
      if (current.generation !== request.expectedGeneration) {
        refuse(box, refusal('SPANS_MODEL_STALE_GENERATION'));
      }
      appendAll(box, request.events);
      const revision = writeView(request, current);
      return { generation: request.generation, ok: true, revision };
    });
  }

  // Runs in whatever transaction (or read) the caller is in, so the answer
  // cannot change between this check and the commit that follows it.
  const fenceHolds = (fence) => {
    const state = viewState(statements.selectView.get(fence.runId));
    if (!state.exists || state.generation !== fence.generation) {
      return false;
    }
    const view = decodeDocument(state.viewJson, 'view-json');
    const all = Object.hasOwn(view, 'linksAssociations')
      ? view.linksAssociations
      : undefined;
    const association =
      isPlainObject(all) && Object.hasOwn(all, fence.associationId)
        ? all[fence.associationId]
        : undefined;
    return (
      isPlainObject(association) &&
      association.status === 'approved' &&
      association.generation === fence.generation
    );
  };
  function commitImport(raw) {
    const request = attempt(() => normalizeImport(raw));
    if (!request) {
      return refusal('SPANS_MODEL_INVALID');
    }
    const selectCursor = () =>
      cursorState(
        statements.selectSource.get(
          request.sourceId,
          request.sourceGeneration,
          request.parserVersion
        )
      );
    // Empty bytes: nothing to record. This is a plain read, so it takes no
    // write lock and leaves the cursor and the events exactly as they were.
    if (request.zeroProgress && request.events.length === 0) {
      return read(() => {
        if (request.fence && !fenceHolds(request.fence)) {
          return refusal('SPANS_MODEL_FENCE_STALE');
        }
        const cursor = selectCursor();
        return cursor.offset === request.expectedOffset
          ? { duplicate: false, offset: cursor.offset, ok: true }
          : refusal('SPANS_MODEL_OFFSET_CONFLICT');
      });
    }
    return atomic((box) => {
      // Before the replay check too: a stale fence never reports success.
      if (request.fence && !fenceHolds(request.fence)) {
        refuse(box, refusal('SPANS_MODEL_FENCE_STALE'));
      }
      const cursor = selectCursor();
      // Only the most recent batch can be recognised; anything earlier is
      // unknown history and may not advance the cursor.
      if (
        cursor.exists &&
        cursor.offset === request.nextOffset &&
        cursor.digest === request.digest
      ) {
        return { duplicate: true, offset: cursor.offset, ok: true };
      }
      if (cursor.offset !== request.expectedOffset) {
        refuse(box, refusal('SPANS_MODEL_OFFSET_CONFLICT'));
      }
      // A different gap batch where a zero-progress batch is already recorded
      // would replace evidence that was accepted at this exact position.
      if (request.zeroProgress && cursor.exists && cursor.zeroProgress) {
        refuse(box, refusal('SPANS_MODEL_OFFSET_CONFLICT'));
      }
      appendAll(box, request.events);
      statements.upsertSource.run(
        request.sourceId,
        request.sourceGeneration,
        request.parserVersion,
        request.nextOffset,
        request.zeroProgress
          ? `${request.digest}${ZERO_PROGRESS_SUFFIX}`
          : request.digest
      );
      return { duplicate: false, offset: request.nextOffset, ok: true };
    });
  }

  // Events only, under the same fence an import uses, in one write
  // transaction: the run view, its revision and its generation are not
  // touched, and an approval withdrawn or a plan revised first stops it.
  function commitFencedEvents(raw) {
    const request = attempt(() => normalizeFencedEvents(raw));
    if (!request) {
      return refusal('SPANS_MODEL_INVALID');
    }
    return atomic((box) => {
      if (!fenceHolds(request.fence)) {
        refuse(box, refusal('SPANS_MODEL_FENCE_STALE'));
      }
      appendAll(box, request.events);
      return { appended: request.events.length, ok: true };
    });
  }

  function readRun(raw) {
    const request = attempt(() => normalizeRunRef(raw));
    if (!request) {
      return refusal('SPANS_MODEL_INVALID');
    }
    return read(() => {
      const row = statements.selectView.get(request.runId);
      if (!row) {
        return refusal('SPANS_MODEL_NOT_FOUND');
      }
      const state = viewState(row);
      const view = decodeDocument(state.viewJson, 'view-json');
      if (view.generation !== state.generation) {
        throw corrupt('view-generation');
      }
      return {
        generation: state.generation,
        ok: true,
        revision: state.revision,
        view,
      };
    });
  }

  function listRuns(raw = {}) {
    const request = attempt(() => normalizeList(raw));
    if (!request) {
      return refusal('SPANS_MODEL_INVALID');
    }
    return read(() => {
      // One extra row tells hasMore without a second query.
      const rows = statements.listRuns.all(
        request.afterRunId ?? '',
        request.phase,
        request.phase,
        request.query,
        request.limit + 1
      );
      const runs = rows.slice(0, request.limit).map(summaryOf);
      return {
        hasMore: rows.length > request.limit,
        nextRunId: runs.at(-1)?.runId ?? request.afterRunId ?? null,
        ok: true,
        runs,
      };
    });
  }

  function readCache(key) {
    if (!(typeof key === 'string' && cacheKeyPattern.test(key))) {
      return refusal('SPANS_MODEL_INVALID');
    }
    return read(() => {
      const row = statements.selectCache.get(key);
      if (!row) {
        return refusal('SPANS_MODEL_NOT_FOUND');
      }
      if (typeof row.entry_json !== 'string') {
        throw corrupt('cache-row');
      }
      return { entry: decodeDocument(row.entry_json, 'cache-json'), ok: true };
    });
  }

  // A single statement is atomic, and the entry is replaced whole, so a reader
  // sees the old complete entry or the new one, never a mixture.
  function writeCache(key, entry) {
    const request = attempt(() => normalizeCacheWrite(key, entry));
    if (!request) {
      return refusal('SPANS_MODEL_INVALID');
    }
    return read(() => {
      statements.upsertCache.run(request.key, request.entryJson);
      return { ok: true };
    });
  }

  function readSourceCursor(raw) {
    const request = attempt(() => normalizeCursorKey(raw));
    if (!request) {
      return refusal('SPANS_MODEL_INVALID');
    }
    return read(() => {
      const cursor = cursorState(
        statements.selectSource.get(
          request.sourceId,
          request.sourceGeneration,
          request.parserVersion
        )
      );
      return {
        batchDigest: cursor.digest,
        found: cursor.exists,
        offset: cursor.offset,
        ok: true,
      };
    });
  }

  return Object.freeze({
    closeStatements() {
      closed = true;
      return finalizeAll(owned)
        ? { ok: true }
        : refusal('SPANS_MODEL_UNAVAILABLE');
    },
    commitFencedEvents,
    commitImport,
    commitRun,
    listRuns,
    readCache,
    readRun,
    readSourceCursor,
    writeCache,
  });
}
