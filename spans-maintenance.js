// Offline backup and restore for the Setu Spans archive. Import and
// construction perform no I/O. Both operations take explicit absolute roots,
// write only into a NEW private directory they create themselves, and never
// overwrite, delete or clean up anything. The source archive and any backup are
// opened read-only; neither function touches a live Setu path or registry.
//
// Backup: a read-only SQLite connection runs VACUUM INTO (a consistent snapshot
// of the committed WAL state, not a file copy), the copy is verified through the
// real store (event digests and every model row), settled into one rollback-
// journal file and flushed, every artifact it references is streamed across and
// re-verified with the existing artifact helper, and only then is the
// completion receipt published.
// Restore verifies that receipt and every byte before publishing its own.
// A destination that fails part way is kept, reported incomplete, and has no
// receipt. If the receipt was renamed into place but its directory could not be
// flushed, the result is outcomeUnknown instead: the receipt may exist, and a
// receipt never approves or applies anything. Errors are fixed messages: paths
// and content are never copied.

import { Database } from 'bun:sqlite';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readSync,
  realpathSync,
  renameSync,
  writeSync,
} from 'node:fs';
import { dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { createSpansArtifacts } from './spans-artifacts.js';
import {
  inspectSpansModelSchema,
  SPANS_MODEL_SCHEMA_VERSION,
  SpansModelError,
} from './spans-model-store.js';
import {
  inspectSpansStoreFiles,
  openSpansStore,
  SPANS_STORE_DATABASE_FILE,
  SPANS_STORE_SCHEMA_VERSION,
} from './spans-store.js';

export const SPANS_BACKUP_RECEIPT_FILE = 'spans-backup.json';
export const SPANS_RESTORE_RECEIPT_FILE = 'spans-restore.json';
// Conservative implementation bounds, not a user-approved retention policy and
// not the archive history budget. Exceeding one fails the backup loudly; nothing
// is skipped or truncated. This module does not enforce the full-archive budget.
export const SPANS_BACKUP_LIMITS = Object.freeze({
  artifactBytes: 64 * 1024 * 1024,
  artifacts: 50_000,
  receiptBytes: 16 * 1024 * 1024,
});

const ARTIFACTS_DIRECTORY = 'artifacts';
const BACKUP_KIND = 'setu-spans-backup';
const RESTORE_KIND = 'setu-spans-restore';
const RECEIPT_VERSION = 1;
const DIRECTORY_MODE = 0o700;
const FILE_MODE = 0o600;
const NOFOLLOW = constants.O_NOFOLLOW ?? 0;
const CHUNK_BYTES = 65_536;
const PAGE_LIMIT = 200;
const BUSY_TIMEOUT_MS = 5000;
const ID_PREFIX = 'sha256:';
const idPattern = /^sha256:[0-9a-f]{64}$/;
const hashPattern = /^[0-9a-f]{64}$/;
const versionPattern = /^[1-9]\d{0,8}$/;
const causeCodePattern = /^(?:SQLITE_[A-Z0-9_]{1,40}|E[A-Z0-9]{1,15})$/;
const lockedMessagePattern = /database is locked/i;
const corruptMessagePattern = /file is not a database|malformed/i;
const SQLITE_BUSY = 5;
const SQLITE_CORRUPT = 11;
const SQLITE_NOTADB = 26;

const REQUIRED_TABLES = [
  'events',
  'metadata',
  'spans_cache',
  'spans_sources',
  'spans_views',
];
const EVENT_COLUMNS = [
  'sequence',
  'event_id',
  'run_id',
  'type',
  'payload_json',
  'input_digest',
].join();
// Artifact references use the event store's own convention: a top-level
// artifactId string or artifactIds array inside a stored JSON document.
const REFERENCE_SOURCES = [
  { column: 'payload_json', table: 'events' },
  { column: 'view_json', table: 'spans_views' },
  { column: 'entry_json', table: 'spans_cache' },
];
const COUNT_KEYS = [
  'artifactBytes',
  'artifacts',
  'cacheEntries',
  'events',
  'sources',
  'views',
];

const MESSAGES = Object.freeze({
  SPANS_BACKUP_ARTIFACT_INVALID:
    'A referenced artifact is not a valid private artifact envelope.',
  SPANS_BACKUP_ARTIFACT_MISSING: 'A referenced artifact is missing.',
  SPANS_BACKUP_ARTIFACT_TOO_LARGE:
    'A referenced artifact exceeds the backup size limit (an implementation limit, not a retention policy); the backup is not complete.',
  SPANS_BACKUP_BUSY: 'The archive is busy; try again.',
  SPANS_BACKUP_CORRUPT: 'The archive database failed an integrity check.',
  SPANS_BACKUP_DESTINATION_EXISTS:
    'The destination already exists; nothing was written.',
  SPANS_BACKUP_FAILED: 'The backup operation could not be completed.',
  SPANS_BACKUP_INCOMPLETE: 'The backup has no completion receipt.',
  SPANS_BACKUP_MANIFEST_INVALID: 'The backup completion receipt is invalid.',
  SPANS_BACKUP_MISMATCH:
    'Backup content does not match its completion receipt.',
  SPANS_BACKUP_OPTIONS_INVALID:
    'Options must be exactly the required absolute root paths.',
  SPANS_BACKUP_OUTCOME_UNKNOWN:
    'The completion receipt was renamed into place but could not be confirmed durable. It may exist; the outcome is unknown and the destination was kept.',
  SPANS_BACKUP_PATH_UNSAFE:
    'A path is a symlink, overlaps another root, or is not a private directory.',
  SPANS_BACKUP_SCHEMA_NEWER:
    'The archive was written by a newer schema; nothing was copied.',
  SPANS_BACKUP_SCHEMA_UNSUPPORTED:
    'The archive schema is not supported; nothing was copied.',
  SPANS_BACKUP_SOURCE_UNAVAILABLE: 'The source archive was not found.',
  SPANS_BACKUP_STORAGE_FULL: 'There is not enough storage space.',
  SPANS_BACKUP_TOO_LARGE:
    'The archive references more artifacts than the backup count limit (an implementation limit, not a retention policy); the backup is not complete.',
});
const STORE_CODES = new Map([
  ['SPANS_STORE_BUSY', 'SPANS_BACKUP_BUSY'],
  ['SPANS_MODEL_BUSY', 'SPANS_BACKUP_BUSY'],
  ['SPANS_MODEL_CORRUPT', 'SPANS_BACKUP_CORRUPT'],
  ['SPANS_STORE_CORRUPT', 'SPANS_BACKUP_CORRUPT'],
  ['SPANS_STORE_SCHEMA_NEWER', 'SPANS_BACKUP_SCHEMA_NEWER'],
  ['SPANS_STORE_SCHEMA_UNSUPPORTED', 'SPANS_BACKUP_SCHEMA_UNSUPPORTED'],
  ['SPANS_STORE_UNSAFE_PATH', 'SPANS_BACKUP_PATH_UNSAFE'],
  ['SPANS_STORE_UNSAFE_PERMISSIONS', 'SPANS_BACKUP_PATH_UNSAFE'],
]);
const ARTIFACT_FILE = {
  artifact: true,
  invalid: 'SPANS_BACKUP_ARTIFACT_INVALID',
  missing: 'SPANS_BACKUP_ARTIFACT_MISSING',
  tooLarge: 'SPANS_BACKUP_ARTIFACT_TOO_LARGE',
};
const SOURCE_DATABASE_FILE = {
  invalid: 'SPANS_BACKUP_PATH_UNSAFE',
  missing: 'SPANS_BACKUP_SOURCE_UNAVAILABLE',
};
const BACKUP_DATABASE_FILE = {
  invalid: 'SPANS_BACKUP_MISMATCH',
  missing: 'SPANS_BACKUP_INCOMPLETE',
};
const RECEIPT_FILE = {
  invalid: 'SPANS_BACKUP_MANIFEST_INVALID',
  missing: 'SPANS_BACKUP_INCOMPLETE',
};
const SNAPSHOT_FILE = {
  invalid: 'SPANS_BACKUP_FAILED',
  missing: 'SPANS_BACKUP_FAILED',
};

// Thrown internally with a fixed code; the public functions turn it into a result.
class MaintenanceError extends Error {
  constructor(code, causeCode) {
    super(code);
    this.name = 'SpansMaintenanceError';
    this.code = code;
    this.causeCode = causeCode;
  }
}

const refuse = (code) => new MaintenanceError(code);

function compareText(left, right) {
  if (left < right) {
    return -1;
  }
  if (left > right) {
    return 1;
  }
  return 0;
}

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

const isCount = (value) => Number.isSafeInteger(value) && value >= 0;
const sameKeys = (value, names) =>
  Object.keys(value).sort().join() === [...names].sort().join();

// ---------------------------------------------------------------------------
// Failure mapping. Exception messages are only matched, never copied.
// ---------------------------------------------------------------------------

function sqliteSignals(error) {
  return {
    code: typeof error?.code === 'string' ? error.code : '',
    message: String(error?.message),
    primary: Number.isInteger(error?.errno) ? error.errno % 256 : -1,
  };
}

function classify(error) {
  if (error instanceof MaintenanceError) {
    return error.code;
  }
  const { code, message, primary } = sqliteSignals(error);
  if (STORE_CODES.has(code)) {
    return STORE_CODES.get(code);
  }
  if (code === 'ENOSPC' || code === 'EDQUOT') {
    return 'SPANS_BACKUP_STORAGE_FULL';
  }
  if (
    primary === SQLITE_BUSY ||
    code.startsWith('SQLITE_BUSY') ||
    lockedMessagePattern.test(message)
  ) {
    return 'SPANS_BACKUP_BUSY';
  }
  if (
    primary === SQLITE_CORRUPT ||
    primary === SQLITE_NOTADB ||
    code.startsWith('SQLITE_CORRUPT') ||
    code === 'SQLITE_NOTADB' ||
    corruptMessagePattern.test(message)
  ) {
    return 'SPANS_BACKUP_CORRUPT';
  }
  return 'SPANS_BACKUP_FAILED';
}

function failure(error, incomplete) {
  const code = classify(error);
  const raw = error?.causeCode ?? error?.code;
  const causeCode =
    typeof raw === 'string' && causeCodePattern.test(raw) ? raw : undefined;
  // The receipt rename already happened: do not claim it is absent or present.
  if (code === 'SPANS_BACKUP_OUTCOME_UNKNOWN') {
    return {
      ...(causeCode ? { causeCode } : {}),
      code,
      error: MESSAGES[code],
      ok: false,
      outcomeUnknown: true,
    };
  }
  return {
    ...(causeCode ? { causeCode } : {}),
    code,
    error: incomplete
      ? `${MESSAGES[code]} The destination was kept and is incomplete.`
      : MESSAGES[code],
    ...(incomplete ? { incomplete: true } : {}),
    ok: false,
  };
}

function closeQuietly(db) {
  try {
    db?.close(true);
  } catch {
    /* The failure that led here is the one worth reporting. */
  }
}

// ---------------------------------------------------------------------------
// Paths. Roots must be canonical absolute paths: no symlink anywhere in the
// chain, no `..`, no trailing slash, so overlap can be decided textually.
// ---------------------------------------------------------------------------

function readRoots(options, names) {
  try {
    const keys = isPlainObject(options) ? Reflect.ownKeys(options) : [];
    if (keys.length !== names.length || !names.every((n) => keys.includes(n))) {
      throw refuse('SPANS_BACKUP_OPTIONS_INVALID');
    }
    return names.map((name) => {
      const value = options[name];
      if (
        !(
          typeof value === 'string' &&
          value.length > 0 &&
          !value.includes('\0') &&
          isAbsolute(value) &&
          resolve(value) === value
        )
      ) {
        throw refuse('SPANS_BACKUP_OPTIONS_INVALID');
      }
      return value;
    });
  } catch {
    // Hostile input (throwing getters, proxies) is simply invalid.
    // biome-ignore lint/style/useErrorCause: Public failures deliberately omit private paths and content.
    throw refuse('SPANS_BACKUP_OPTIONS_INVALID');
  }
}

const within = (parent, child) =>
  child.startsWith(parent.endsWith(sep) ? parent : `${parent}${sep}`);

function assertDisjoint(input, destination) {
  if (
    input === destination ||
    within(input, destination) ||
    within(destination, input)
  ) {
    throw refuse('SPANS_BACKUP_PATH_UNSAFE');
  }
}

const ownedByCaller = (stat) =>
  typeof process.getuid !== 'function' || stat.uid === process.getuid();

const isPrivateDirectory = (stat) =>
  stat.isDirectory() &&
  ownedByCaller(stat) &&
  stat.mode % 0o1000 === DIRECTORY_MODE;

const isPrivateFile = (stat, artifact = false) =>
  stat.isFile() &&
  (artifact ? stat.nlink >= 1 : stat.nlink === 1) &&
  ownedByCaller(stat) &&
  (artifact
    ? stat.mode % 0o1000 === FILE_MODE
    : [FILE_MODE, 0o700].includes(stat.mode % 0o1000));

// lstat plus realpath: a symlink in any component makes the two disagree.
function assertExistingRoot(path, missingCode) {
  let stat;
  try {
    stat = lstatSync(path);
  } catch (error) {
    throw refuse(
      error.code === 'ENOENT' ? missingCode : 'SPANS_BACKUP_PATH_UNSAFE'
    );
  }
  let canonical;
  try {
    canonical = realpathSync(path);
  } catch {
    // biome-ignore lint/style/useErrorCause: Public failures deliberately omit private paths and content.
    throw refuse('SPANS_BACKUP_PATH_UNSAFE');
  }
  if (canonical !== path || !isPrivateDirectory(stat)) {
    throw refuse('SPANS_BACKUP_PATH_UNSAFE');
  }
}

function assertNewDestination(destination) {
  assertExistingRoot(dirname(destination), 'SPANS_BACKUP_PATH_UNSAFE');
  try {
    lstatSync(destination);
  } catch (error) {
    if (error.code === 'ENOENT') {
      return;
    }
    throw error;
  }
  // Anything already there, including a dangling symlink, is left alone.
  throw refuse('SPANS_BACKUP_DESTINATION_EXISTS');
}

function makePrivateDirectory(path) {
  mkdirSync(path, { mode: DIRECTORY_MODE });
  chmodSync(path, DIRECTORY_MODE);
}

// From the mkdir on, a failure leaves a kept, incomplete destination.
function createDestination(destination, progress) {
  try {
    mkdirSync(destination, { mode: DIRECTORY_MODE });
  } catch (error) {
    if (error.code === 'EEXIST') {
      throw refuse('SPANS_BACKUP_DESTINATION_EXISTS');
    }
    throw error;
  }
  progress.created = true;
  chmodSync(destination, DIRECTORY_MODE);
  if (!isPrivateDirectory(lstatSync(destination))) {
    throw refuse('SPANS_BACKUP_PATH_UNSAFE');
  }
  syncDirectory(dirname(destination));
  makePrivateDirectory(join(destination, ARTIFACTS_DIRECTORY));
}

// ---------------------------------------------------------------------------
// Bounded file I/O. Files are opened without following symlinks, checked again
// after open, and streamed in fixed chunks.
// ---------------------------------------------------------------------------

function openRegularFile(path, codes) {
  let stat;
  try {
    stat = lstatSync(path);
  } catch (error) {
    throw error.code === 'ENOENT' || error.code === 'ENOTDIR'
      ? refuse(codes.missing)
      : error;
  }
  if (!isPrivateFile(stat, codes.artifact)) {
    throw refuse(codes.invalid);
  }
  const fd = openSync(path, constants.O_RDONLY + NOFOLLOW);
  try {
    const opened = fstatSync(fd);
    if (
      !isPrivateFile(opened, codes.artifact) ||
      opened.ino !== stat.ino ||
      opened.dev !== stat.dev
    ) {
      throw refuse(codes.invalid);
    }
    return { fd, stat: opened };
  } catch (error) {
    closeSync(fd);
    throw error;
  }
}

function streamChunks(
  fd,
  maxBytes,
  each,
  tooLargeCode = 'SPANS_BACKUP_ARTIFACT_TOO_LARGE'
) {
  const buffer = Buffer.allocUnsafe(CHUNK_BYTES);
  let total = 0;
  for (;;) {
    const count = readSync(fd, buffer, 0, CHUNK_BYTES, null);
    if (count === 0) {
      return total;
    }
    total += count;
    if (total > maxBytes) {
      throw refuse(tooLargeCode);
    }
    each(buffer, count);
  }
}

function writeAll(fd, buffer, length) {
  let offset = 0;
  while (offset < length) {
    offset += writeSync(fd, buffer, offset, length - offset);
  }
}

function hashFile(path, codes) {
  const input = openRegularFile(path, codes);
  try {
    const hash = createHash('sha256');
    const bytes = streamChunks(
      input.fd,
      Number.MAX_SAFE_INTEGER,
      (buffer, count) => hash.update(buffer.subarray(0, count))
    );
    if (bytes !== input.stat.size) {
      throw refuse(codes.invalid);
    }
    return { bytes, sha256: hash.digest('hex') };
  } finally {
    closeSync(input.fd);
  }
}

// The target must not exist; it is created private and flushed before return.
function copyFile(from, to, codes, maxBytes) {
  const input = openRegularFile(from, codes);
  let output;
  try {
    if (input.stat.size > maxBytes) {
      throw refuse(codes.tooLarge ?? codes.invalid);
    }
    output = openSync(
      to,
      constants.O_WRONLY + constants.O_CREAT + constants.O_EXCL + NOFOLLOW,
      FILE_MODE
    );
    fchmodSync(output, FILE_MODE);
    const hash = createHash('sha256');
    const bytes = streamChunks(
      input.fd,
      maxBytes,
      (buffer, count) => {
        hash.update(buffer.subarray(0, count));
        writeAll(output, buffer, count);
      },
      codes.tooLarge ?? codes.invalid
    );
    if (bytes !== input.stat.size) {
      throw refuse(codes.invalid);
    }
    fsyncSync(output);
    return { bytes, sha256: hash.digest('hex') };
  } finally {
    closeSync(input.fd);
    if (output !== undefined) {
      closeSync(output);
    }
  }
}

// SQLite creates the VACUUM INTO file itself (it refuses an existing one), so
// this runs on the finished snapshot inside the private destination directory:
// tighten the mode, then flush the file itself (a directory fsync is not enough).
function sealSnapshotFile(path) {
  const fd = openSync(path, constants.O_RDWR + NOFOLLOW);
  try {
    fchmodSync(fd, FILE_MODE);
    if (!isPrivateFile(fstatSync(fd))) {
      throw refuse('SPANS_BACKUP_PATH_UNSAFE');
    }
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function readSmallFile(path, codes, maxBytes) {
  const input = openRegularFile(path, codes);
  try {
    const { size } = input.stat;
    if (size > maxBytes) {
      throw refuse(codes.invalid);
    }
    const buffer = Buffer.alloc(size);
    let offset = 0;
    while (offset < size) {
      const count = readSync(input.fd, buffer, offset, size - offset, null);
      if (count === 0) {
        break;
      }
      offset += count;
    }
    if (offset !== size) {
      throw refuse(codes.invalid);
    }
    return buffer;
  } finally {
    closeSync(input.fd);
  }
}

function syncDirectory(path) {
  const fd = openSync(path, constants.O_RDONLY);
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

// Written beside the final name and renamed, so a receipt is whole or absent.
function publishReceipt(directory, fileName, value) {
  const bytes = Buffer.from(`${JSON.stringify(value)}\n`, 'utf8');
  if (bytes.length > SPANS_BACKUP_LIMITS.receiptBytes) {
    throw refuse('SPANS_BACKUP_TOO_LARGE');
  }
  const partial = join(directory, `${fileName}.partial`);
  const fd = openSync(
    partial,
    constants.O_WRONLY + constants.O_CREAT + constants.O_EXCL + NOFOLLOW,
    FILE_MODE
  );
  try {
    fchmodSync(fd, FILE_MODE);
    writeAll(fd, bytes, bytes.length);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(partial, join(directory, fileName));
  // From here the receipt may already be visible, so a failure to make the
  // rename durable is an unknown outcome, never "no receipt".
  try {
    syncDirectory(directory);
  } catch (error) {
    // biome-ignore lint/style/useErrorCause: Public failures deliberately omit private paths and content.
    throw new MaintenanceError('SPANS_BACKUP_OUTCOME_UNKNOWN', error.code);
  }
}

function assertNames(directory, expected, code) {
  const actual = readdirSync(directory).sort(compareText);
  const wanted = [...expected].sort(compareText);
  if (actual.length !== wanted.length || actual.join() !== wanted.join()) {
    throw refuse(code);
  }
}

// ---------------------------------------------------------------------------
// Database inspection. Every query is a SELECT or a read-only PRAGMA.
// ---------------------------------------------------------------------------

const columnNames = (db, table) =>
  db
    .query('SELECT name FROM pragma_table_info(?) ORDER BY cid')
    .all(table)
    .map((column) => column.name);

// Event-store version first, then the shape the model store requires.
function assertSupportedSchema(db) {
  const unsupported = refuse('SPANS_BACKUP_SCHEMA_UNSUPPORTED');
  const tables = new Set(
    db
      .query("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all()
      .map((table) => table.name)
  );
  if (
    !tables.has('metadata') ||
    columnNames(db, 'metadata').join() !== 'key,value'
  ) {
    throw unsupported;
  }
  const row = db
    .query('SELECT value FROM metadata WHERE key = ?')
    .get('schema_version');
  const text = row ? String(row.value) : '';
  if (!versionPattern.test(text)) {
    throw unsupported;
  }
  if (Number(text) > SPANS_STORE_SCHEMA_VERSION) {
    throw refuse('SPANS_BACKUP_SCHEMA_NEWER');
  }
  if (
    Number(text) !== SPANS_STORE_SCHEMA_VERSION ||
    !REQUIRED_TABLES.every((name) => tables.has(name)) ||
    columnNames(db, 'events').join() !== EVENT_COLUMNS
  ) {
    throw unsupported;
  }
  let state;
  try {
    state = inspectSpansModelSchema(db);
  } catch (error) {
    if (error instanceof SpansModelError) {
      throw refuse(
        error.code === 'SPANS_STORE_SCHEMA_NEWER'
          ? 'SPANS_BACKUP_SCHEMA_NEWER'
          : 'SPANS_BACKUP_SCHEMA_UNSUPPORTED'
      );
    }
    throw error;
  }
  if (state !== 'current') {
    throw unsupported;
  }
}

function assertIntegrity(db) {
  const rows = db.query('PRAGMA integrity_check').values();
  if (!(rows.length === 1 && rows[0][0] === 'ok')) {
    throw refuse('SPANS_BACKUP_CORRUPT');
  }
}

function countRows(db) {
  const total = (table) =>
    db.query(`SELECT count(*) AS total FROM ${table}`).get().total;
  return {
    cacheEntries: total('spans_cache'),
    events: total('events'),
    sources: total('spans_sources'),
    views: total('spans_views'),
  };
}

function addReferences(ids, row) {
  const found = [];
  if (typeof row.one === 'string') {
    found.push(row.one);
  }
  if (typeof row.many === 'string') {
    const list = JSON.parse(row.many);
    found.push(...list.filter((value) => typeof value === 'string'));
  }
  for (const id of found) {
    if (idPattern.test(id)) {
      ids.add(id);
    }
  }
  if (ids.size > SPANS_BACKUP_LIMITS.artifacts) {
    throw refuse('SPANS_BACKUP_TOO_LARGE');
  }
}

// Keyset pages over rowid; only artifact ids are held, never documents.
function collectReferences(db) {
  const ids = new Set();
  for (const { column, table } of REFERENCE_SOURCES) {
    const page = db.query(
      `SELECT rowid AS position,
        json_extract(${column}, '$.artifactId') AS one,
        (SELECT json_group_array(value) FROM json_each(${column}, '$.artifactIds')) AS many
        FROM ${table} WHERE rowid > ? ORDER BY rowid LIMIT ${PAGE_LIMIT}`
    );
    let position = 0;
    for (;;) {
      const rows = page.all(position);
      for (const row of rows) {
        addReferences(ids, row);
      }
      if (rows.length < PAGE_LIMIT) {
        break;
      }
      ({ position } = rows.at(-1));
    }
  }
  return [...ids].sort(compareText);
}

// The backup's own fresh copy is kept a single rollback-journal file: opening it
// through the store turns WAL on, so this runs again after that store closes.
function useRollbackJournal(path) {
  let db;
  try {
    db = new Database(path, { readwrite: true, strict: true });
    db.run(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
    const mode = db.query('PRAGMA journal_mode = DELETE').values()[0]?.[0];
    if (String(mode).toLowerCase() !== 'delete') {
      throw refuse('SPANS_BACKUP_FAILED');
    }
  } finally {
    closeQuietly(db);
  }
}

function inspectSnapshot(path) {
  let db;
  try {
    db = new Database(path, { readonly: true, strict: true });
    db.run(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
    assertSupportedSchema(db);
    assertIntegrity(db);
    return { counts: countRows(db), references: collectReferences(db) };
  } finally {
    closeQuietly(db);
  }
}

// ---------------------------------------------------------------------------
// Artifacts
// ---------------------------------------------------------------------------

function assertSourceArtifacts(root) {
  let stat;
  try {
    stat = lstatSync(join(root, ARTIFACTS_DIRECTORY));
  } catch (error) {
    throw refuse(
      error.code === 'ENOENT'
        ? ARTIFACT_FILE.missing
        : 'SPANS_BACKUP_ARTIFACT_INVALID'
    );
  }
  if (!isPrivateDirectory(stat)) {
    throw refuse(ARTIFACT_FILE.invalid);
  }
}

// Streams one envelope across, then lets the existing helper re-verify the
// COPY (envelope shape, redaction-time hash). The helper reads one whole
// artifact into memory, so artifacts are capped at SPANS_BACKUP_LIMITS.
function copyArtifact({ from, id, to, verifier }) {
  const name = id.slice(ID_PREFIX.length);
  const copied = copyFile(
    join(from, ARTIFACTS_DIRECTORY, name),
    join(to, ARTIFACTS_DIRECTORY, name),
    ARTIFACT_FILE,
    SPANS_BACKUP_LIMITS.artifactBytes
  );
  const checked = verifier.read({ artifactId: id });
  if (!checked.ok) {
    throw refuse(
      checked.code === 'ARTIFACT_NOT_FOUND'
        ? ARTIFACT_FILE.missing
        : ARTIFACT_FILE.invalid
    );
  }
  return { bytes: copied.bytes, id, sha256: copied.sha256 };
}

// ---------------------------------------------------------------------------
// Backup
// ---------------------------------------------------------------------------

function openSource(root) {
  const path = join(root, SPANS_STORE_DATABASE_FILE);
  closeSync(openRegularFile(path, SOURCE_DATABASE_FILE).fd);
  const identity = inspectSpansStoreFiles({ root });
  const db = new Database(path, { readonly: true, strict: true });
  try {
    const after = inspectSpansStoreFiles({ root });
    if (identity.dev !== after.dev || identity.ino !== after.ino) {
      throw refuse('SPANS_BACKUP_PATH_UNSAFE');
    }
    db.run(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
  } catch (error) {
    closeQuietly(db);
    throw error;
  }
  return db;
}

// SQLite refuses an existing INTO file, so it creates the target itself inside
// the private destination directory; sealSnapshotFile then makes it 0600.
function snapshotDatabase(source, target) {
  source.run('VACUUM INTO ?', [target]);
  sealSnapshotFile(target);
}

function backupReceipt({ artifacts, database, schemaCounts }) {
  return {
    artifacts,
    counts: {
      artifactBytes: artifacts.reduce((sum, entry) => sum + entry.bytes, 0),
      artifacts: artifacts.length,
      ...schemaCounts,
    },
    database,
    kind: BACKUP_KIND,
    schema: {
      model: SPANS_MODEL_SCHEMA_VERSION,
      store: SPANS_STORE_SCHEMA_VERSION,
    },
    version: RECEIPT_VERSION,
  };
}

function runBackup(root, destination, progress) {
  assertExistingRoot(root, 'SPANS_BACKUP_SOURCE_UNAVAILABLE');
  assertNewDestination(destination);
  const target = join(destination, SPANS_STORE_DATABASE_FILE);
  const source = openSource(root);
  try {
    // Refuse before creating anything when the source is newer or unknown.
    assertSupportedSchema(source);
    createDestination(destination, progress);
    snapshotDatabase(source, target);
  } finally {
    closeQuietly(source);
  }
  // Source artifacts are immutable, so copying after the snapshot is safe.
  useRollbackJournal(target);
  const snapshot = inspectSnapshot(target);
  // The same verification a restore applies: a snapshot the store would reject,
  // or whose rows fail their checks, never gets a completion receipt.
  verifyOpenedStore(destination, snapshot.counts);
  // Read-only validation leaves the settled snapshot unchanged.
  sealSnapshotFile(target);
  const database = hashFile(target, SNAPSHOT_FILE);
  const verifier = createSpansArtifacts({ root: destination });
  if (snapshot.references.length > 0) {
    assertSourceArtifacts(root);
  }
  const artifacts = snapshot.references.map((id) =>
    copyArtifact({ from: root, id, to: destination, verifier })
  );
  assertNames(
    destination,
    [ARTIFACTS_DIRECTORY, SPANS_STORE_DATABASE_FILE],
    'SPANS_BACKUP_FAILED'
  );
  syncDirectory(join(destination, ARTIFACTS_DIRECTORY));
  syncDirectory(destination);
  const receipt = backupReceipt({
    artifacts,
    database,
    schemaCounts: snapshot.counts,
  });
  publishReceipt(destination, SPANS_BACKUP_RECEIPT_FILE, receipt);
  return { ...receipt.counts, databaseBytes: database.bytes };
}

/**
 * Snapshot the archive at `root` into the NEW private directory `destination`.
 * Synchronous. Returns { ok: true, artifactBytes, artifacts, cacheEntries,
 * databaseBytes, events, sources, views } or { ok: false, code, error } plus
 * `incomplete: true` when a destination was created and has been kept, or
 * `outcomeUnknown: true` (code SPANS_BACKUP_OUTCOME_UNKNOWN) when the completion
 * receipt was renamed into place but could not be confirmed durable.
 */
export function createSpansBackup(options) {
  const progress = { created: false };
  try {
    const [root, destination] = readRoots(options, ['root', 'destination']);
    assertDisjoint(root, destination);
    return { ok: true, ...runBackup(root, destination, progress) };
  } catch (error) {
    return failure(error, progress.created);
  }
}

// ---------------------------------------------------------------------------
// Restore
// ---------------------------------------------------------------------------

function parseArtifactEntries(entries) {
  if (
    !(Array.isArray(entries) && entries.length <= SPANS_BACKUP_LIMITS.artifacts)
  ) {
    return false;
  }
  return entries.every(
    (entry, index) =>
      isPlainObject(entry) &&
      sameKeys(entry, ['bytes', 'id', 'sha256']) &&
      isCount(entry.bytes) &&
      idPattern.test(entry.id) &&
      hashPattern.test(entry.sha256) &&
      (index === 0 || compareText(entries[index - 1].id, entry.id) < 0)
  );
}

function assertReceiptSchema(schema) {
  if (
    !(
      isPlainObject(schema) &&
      sameKeys(schema, ['model', 'store']) &&
      Number.isSafeInteger(schema.model) &&
      Number.isSafeInteger(schema.store)
    )
  ) {
    throw refuse('SPANS_BACKUP_MANIFEST_INVALID');
  }
  if (
    schema.store > SPANS_STORE_SCHEMA_VERSION ||
    schema.model > SPANS_MODEL_SCHEMA_VERSION
  ) {
    throw refuse('SPANS_BACKUP_SCHEMA_NEWER');
  }
  if (
    schema.store !== SPANS_STORE_SCHEMA_VERSION ||
    schema.model !== SPANS_MODEL_SCHEMA_VERSION
  ) {
    throw refuse('SPANS_BACKUP_SCHEMA_UNSUPPORTED');
  }
}

function parseReceipt(buffer) {
  const invalid = refuse('SPANS_BACKUP_MANIFEST_INVALID');
  let value;
  try {
    value = JSON.parse(buffer.toString('utf8'));
  } catch {
    // biome-ignore lint/style/useErrorCause: Public failures deliberately omit private paths and content.
    throw invalid;
  }
  if (
    !(
      isPlainObject(value) &&
      sameKeys(value, [
        'artifacts',
        'counts',
        'database',
        'kind',
        'schema',
        'version',
      ]) &&
      value.kind === BACKUP_KIND &&
      value.version === RECEIPT_VERSION &&
      isPlainObject(value.counts) &&
      sameKeys(value.counts, COUNT_KEYS) &&
      COUNT_KEYS.every((key) => isCount(value.counts[key])) &&
      isPlainObject(value.database) &&
      sameKeys(value.database, ['bytes', 'sha256']) &&
      isCount(value.database.bytes) &&
      hashPattern.test(value.database.sha256) &&
      parseArtifactEntries(value.artifacts) &&
      value.counts.artifacts === value.artifacts.length &&
      value.counts.artifactBytes ===
        value.artifacts.reduce((sum, entry) => sum + entry.bytes, 0)
    )
  ) {
    throw invalid;
  }
  assertReceiptSchema(value.schema);
  return value;
}

// Everything checkable without writing: receipt present and valid, only the
// expected files, and exactly the artifact files the receipt lists.
function loadBackup(backupRoot) {
  assertExistingRoot(backupRoot, 'SPANS_BACKUP_SOURCE_UNAVAILABLE');
  const names = readdirSync(backupRoot);
  if (!names.includes(SPANS_BACKUP_RECEIPT_FILE)) {
    throw refuse('SPANS_BACKUP_INCOMPLETE');
  }
  assertNames(
    backupRoot,
    [ARTIFACTS_DIRECTORY, SPANS_BACKUP_RECEIPT_FILE, SPANS_STORE_DATABASE_FILE],
    'SPANS_BACKUP_MISMATCH'
  );
  const receipt = parseReceipt(
    readSmallFile(
      join(backupRoot, SPANS_BACKUP_RECEIPT_FILE),
      RECEIPT_FILE,
      SPANS_BACKUP_LIMITS.receiptBytes
    )
  );
  const artifactsPath = join(backupRoot, ARTIFACTS_DIRECTORY);
  if (!isPrivateDirectory(lstatSync(artifactsPath))) {
    throw refuse('SPANS_BACKUP_MISMATCH');
  }
  assertNames(
    artifactsPath,
    receipt.artifacts.map((entry) => entry.id.slice(ID_PREFIX.length)),
    'SPANS_BACKUP_MISMATCH'
  );
  return receipt;
}

function assertSnapshotMatchesReceipt(snapshot, receipt) {
  const matches = Object.entries(snapshot.counts).every(
    ([key, value]) => receipt.counts[key] === value
  );
  const ids = receipt.artifacts.map((entry) => entry.id);
  if (!matches || snapshot.references.join() !== ids.join()) {
    throw refuse('SPANS_BACKUP_MISMATCH');
  }
}

function storeFailure(result) {
  return refuse(STORE_CODES.get(result?.code) ?? 'SPANS_BACKUP_FAILED');
}

const accepted = (result) => {
  if (!result.ok) {
    throw storeFailure(result);
  }
  return result;
};

// Reads every event through the store, which re-verifies each row's digest.
function countStoreEvents(store, runId) {
  let afterSequence = 0;
  let total = 0;
  for (;;) {
    const page = accepted(
      store.readEvents({ afterSequence, limit: PAGE_LIMIT, runId })
    );
    total += page.events.length;
    if (!page.hasMore) {
      return total;
    }
    afterSequence = page.nextSequence;
  }
}

// Walks one table by rowid, one key at a time, and counts the rows `read` accepts.
function countModelRows(reader, sql, read) {
  const next = reader.query(sql);
  let position = 0;
  let total = 0;
  for (let row = next.get(position); row; row = next.get(position)) {
    ({ position } = row);
    accepted(read(row));
    total += 1;
  }
  return total;
}

// The copy must be accepted by the real store and every supported row must read
// back whole through its existing read method (events re-verify their digest).
function verifyOpenedStore(destination, expected) {
  const store = openSpansStore({ readonly: true, root: destination });
  let reader;
  let failureCause;
  const found = { cacheEntries: 0, events: 0, sources: 0, views: 0 };
  try {
    reader = new Database(join(destination, SPANS_STORE_DATABASE_FILE), {
      readonly: true,
      strict: true,
    });
    const nextRun = reader.query(
      'SELECT run_id FROM events WHERE run_id > ? ORDER BY run_id LIMIT 1'
    );
    let runId = '';
    for (let row = nextRun.get(runId); row; row = nextRun.get(runId)) {
      runId = row.run_id;
      found.events += countStoreEvents(store, runId);
    }
    found.views = countModelRows(
      reader,
      'SELECT rowid AS position, run_id FROM spans_views WHERE rowid > ? ORDER BY rowid LIMIT 1',
      (row) => store.readRun({ runId: row.run_id })
    );
    found.sources = countModelRows(
      reader,
      'SELECT rowid AS position, source_id, source_generation, parser_version FROM spans_sources WHERE rowid > ? ORDER BY rowid LIMIT 1',
      (row) =>
        store.readSourceCursor({
          parserVersion: row.parser_version,
          sourceGeneration: row.source_generation,
          sourceId: row.source_id,
        })
    );
    found.cacheEntries = countModelRows(
      reader,
      'SELECT rowid AS position, cache_key FROM spans_cache WHERE rowid > ? ORDER BY rowid LIMIT 1',
      (row) => store.readCache(row.cache_key)
    );
  } catch (error) {
    failureCause = error;
  } finally {
    closeQuietly(reader);
  }
  // Read-only verification must not change the snapshot.
  const closed = store.close();
  if (failureCause) {
    throw failureCause;
  }
  accepted(closed);
  if (Object.keys(found).some((key) => found[key] !== expected[key])) {
    throw refuse('SPANS_BACKUP_MISMATCH');
  }
}

function runRestore(backupRoot, destination, progress) {
  const receipt = loadBackup(backupRoot);
  assertNewDestination(destination);
  createDestination(destination, progress);
  const target = join(destination, SPANS_STORE_DATABASE_FILE);
  const database = copyFile(
    join(backupRoot, SPANS_STORE_DATABASE_FILE),
    target,
    BACKUP_DATABASE_FILE,
    receipt.database.bytes
  );
  if (
    database.bytes !== receipt.database.bytes ||
    database.sha256 !== receipt.database.sha256
  ) {
    throw refuse('SPANS_BACKUP_MISMATCH');
  }
  assertSnapshotMatchesReceipt(inspectSnapshot(target), receipt);
  const verifier = createSpansArtifacts({ root: destination });
  for (const entry of receipt.artifacts) {
    const copied = copyArtifact({
      from: backupRoot,
      id: entry.id,
      to: destination,
      verifier,
    });
    if (copied.bytes !== entry.bytes || copied.sha256 !== entry.sha256) {
      throw refuse('SPANS_BACKUP_MISMATCH');
    }
  }
  assertNames(
    destination,
    [ARTIFACTS_DIRECTORY, SPANS_STORE_DATABASE_FILE],
    'SPANS_BACKUP_FAILED'
  );
  syncDirectory(join(destination, ARTIFACTS_DIRECTORY));
  syncDirectory(destination);
  verifyOpenedStore(destination, receipt.counts);
  publishReceipt(destination, SPANS_RESTORE_RECEIPT_FILE, {
    counts: receipt.counts,
    kind: RESTORE_KIND,
    sourceDatabaseSha256: receipt.database.sha256,
    version: RECEIPT_VERSION,
  });
  return { ...receipt.counts, databaseBytes: receipt.database.bytes };
}

/**
 * Verify the completed backup at `backupRoot` and rebuild it as a NEW archive
 * directory `destination`. Synchronous. It never touches the backup's source
 * archive or any live location and does not activate the restored archive.
 * Same result shape as createSpansBackup.
 */
export function restoreSpansBackup(options) {
  const progress = { created: false };
  try {
    const [backupRoot, destination] = readRoots(options, [
      'backupRoot',
      'destination',
    ]);
    assertDisjoint(backupRoot, destination);
    return { ok: true, ...runRestore(backupRoot, destination, progress) };
  } catch (error) {
    return failure(error, progress.created);
  }
}
