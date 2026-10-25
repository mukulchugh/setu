export interface SpansHistoryImportInput {
  existingRunId?: string;
  maxBytes?: number;
  path: string;
  provider: 'codex' | 'claude';
}

export interface SpansHistoryImportSuccess {
  eof: boolean;
  expectedOffset: number;
  gapCount: number;
  hasMore: boolean;
  importedCount: number;
  kind: 'success';
  nextOffset: number;
  pendingByteCount: number;
  runId: string;
  search: SpansHistorySearchStatus;
  sourceId: string;
  state: 'importing' | 'imported';
}

export type SpansHistorySearchStatus =
  | { kind: 'complete'; indexed: number; pages: number; targetSequence: number }
  | { kind: 'pending' }
  | { kind: 'unknown' }
  | { kind: 'unverified' };

export type SpansHistoryImportResult =
  | SpansHistoryImportSuccess
  | { kind: 'refused'; message: string }
  | { kind: 'unknown'; message: string };

const MAX_REQUEST_BYTES = 16 * 1024;
const MAX_RESPONSE_BYTES = 64 * 1024;
const MAX_SOURCE_BYTES = 4 * 1024 * 1024;
const MAX_PATH_LENGTH = 4096;
const MAX_BATCH_COUNT = 200;
const MAX_SEARCH_PAGES = 4;
const MAX_SEARCH_INDEXED = MAX_BATCH_COUNT * MAX_SEARCH_PAGES;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SOURCE_ID = /^[a-f0-9]{64}$/;
const CONTENT_LENGTH = /^\d+$/;
const VALIDATION_MESSAGE =
  'Enter an absolute file path on the Mac running Setu.';
const UNKNOWN_MESSAGE =
  'The import outcome is unknown. Inspect retained history before retrying; Setu will not send another request in this view.';

const SAFE_ERRORS: Record<string, string> = {
  ADMISSION_CLOSED: 'Setu is updating. Wait for the update to finish.',
  SOURCE_CHECKPOINT_INVALID: 'The saved import checkpoint is invalid.',
  SOURCE_CHECKPOINT_MISSING: 'The saved import checkpoint is unavailable.',
  SOURCE_CURSOR_INVALID: 'The saved import position is invalid.',
  SOURCE_CURSOR_READ_FAILED: 'The saved import position could not be read.',
  SOURCE_DESTINATION_CONFLICT: 'This history destination is already in use.',
  SOURCE_DESTINATION_NOT_FOUND: 'The selected destination run was not found.',
  SOURCE_IDENTITY_UNKNOWN: 'The source identity could not be confirmed.',
  SOURCE_IMPORT_BATCH_LIMIT: 'The source contains an unsupported import batch.',
  SOURCE_IMPORT_COMMIT_FAILED: 'The imported history could not be saved.',
  SOURCE_IMPORT_INVALID:
    'The selected source is not a supported conversation file.',
  SOURCE_REPLACED:
    'The selected source file changed. Review the current file before importing again.',
  SOURCE_RUN_CONFLICT: 'The saved source belongs to a different run.',
  SOURCE_TRUNCATED: 'The selected source file became shorter during import.',
  SOURCE_UNAVAILABLE: 'The selected source file is unavailable or unsafe.',
  SPANS_ARCHIVE_CAPACITY_REACHED:
    'The Spans archive has no available capacity.',
  SPANS_ARCHIVE_CORRUPT: 'The Spans archive failed an integrity check.',
  SPANS_ARCHIVE_UNAVAILABLE: 'The Spans archive is unavailable.',
  SPANS_ARCHIVE_WRITE_UNAVAILABLE: 'The Spans archive is unavailable.',
  SPANS_IMPORT_BUSY: 'Another Spans import is already active.',
  SPANS_IMPORT_RUNTIME_CLOSED: 'Spans history import is unavailable.',
  SPANS_MODEL_BUSY: 'The Spans archive is busy. Try again later.',
  SPANS_SERVICE_BUSY: 'The Spans archive is busy. Try again later.',
  SPANS_SERVICE_CAPACITY: 'The Spans archive has no available capacity.',
  SPANS_SERVICE_CORRUPT: 'The Spans archive failed an integrity check.',
  SPANS_SERVICE_UNAVAILABLE: 'The Spans archive is unavailable.',
  SPANS_STORE_BUSY: 'The Spans archive is busy. Try again later.',
  SPANS_STORE_CORRUPT: 'The Spans archive failed an integrity check.',
  SPANS_STORE_UNAVAILABLE: 'The Spans archive is unavailable.',
  SPANS_UPDATE_REFUSED: 'The import was refused while Setu is updating.',
};

interface SnapshotResult {
  input?: SpansHistoryImportInput;
  valid: boolean;
}

function copyOwnDataProperties(value: object): Record<string, unknown> | null {
  const allowed = new Set(['path', 'provider', 'existingRunId', 'maxBytes']);
  const copied: Record<string, unknown> = Object.create(null);
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string' || !allowed.has(key)) {
      return null;
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!(descriptor?.enumerable && Object.hasOwn(descriptor, 'value'))) {
      return null;
    }
    copied[key] = descriptor.value;
  }
  return copied;
}

function snapshotInput(value: unknown): SnapshotResult {
  try {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      return { valid: false };
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      return { valid: false };
    }
    const copied = copyOwnDataProperties(value);
    if (!copied) {
      return { valid: false };
    }
    const { path, provider, existingRunId, maxBytes } = copied;
    if (
      typeof path !== 'string' ||
      path.length < 1 ||
      path.length > MAX_PATH_LENGTH ||
      path.trim() !== path ||
      !path.startsWith('/') ||
      path.includes('\0') ||
      path.split('/').some((part) => part === '.' || part === '..') ||
      (provider !== 'codex' && provider !== 'claude') ||
      (existingRunId !== undefined &&
        !(
          typeof existingRunId === 'string' && IDENTIFIER.test(existingRunId)
        )) ||
      (maxBytes !== undefined &&
        !(
          typeof maxBytes === 'number' &&
          Number.isSafeInteger(maxBytes) &&
          maxBytes >= 1 &&
          maxBytes <= MAX_SOURCE_BYTES
        ))
    ) {
      return { valid: false };
    }
    return {
      input: {
        path,
        provider,
        ...(existingRunId === undefined ? {} : { existingRunId }),
        ...(maxBytes === undefined ? {} : { maxBytes }),
      },
      valid: true,
    };
  } catch {
    return { valid: false };
  }
}

export function validateSpansHistoryImportInput(input: unknown): string | null {
  const snapshot = snapshotInput(input);
  if (!(snapshot.valid && snapshot.input)) {
    return VALIDATION_MESSAGE;
  }
  try {
    const encodedLength = new TextEncoder().encode(
      JSON.stringify(snapshot.input)
    ).byteLength;
    return encodedLength > MAX_REQUEST_BYTES ? VALIDATION_MESSAGE : null;
  } catch {
    return VALIDATION_MESSAGE;
  }
}

function refusal(code: unknown): SpansHistoryImportResult {
  const key = typeof code === 'string' ? code : '';
  return {
    kind: 'refused',
    message: Object.hasOwn(SAFE_ERRORS, key)
      ? SAFE_ERRORS[key]
      : 'The import was refused. Check the selected file and destination.',
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function boundedInteger(
  value: unknown,
  max = Number.MAX_SAFE_INTEGER
): value is number {
  return (
    Number.isSafeInteger(value) && Number(value) >= 0 && Number(value) <= max
  );
}

function decodeSearchStatus(value: unknown): SpansHistorySearchStatus {
  if (!isRecord(value)) {
    return { kind: 'unverified' };
  }
  if (value.ok === true) {
    return decodeSearchSuccess(value);
  }
  return decodeSearchFailure(value);
}

function decodeSearchSuccess(
  value: Record<string, unknown>
): SpansHistorySearchStatus {
  const { coverage } = value;
  if (!isRecord(coverage)) {
    return { kind: 'unverified' };
  }
  if (!boundedInteger(value.indexed, MAX_SEARCH_INDEXED)) {
    return { kind: 'unverified' };
  }
  if (!boundedInteger(value.pages, MAX_SEARCH_PAGES)) {
    return { kind: 'unverified' };
  }
  if (!boundedInteger(value.targetSequence)) {
    return { kind: 'unverified' };
  }
  if (!boundedInteger(coverage.latestSequence)) {
    return { kind: 'unverified' };
  }
  if (!boundedInteger(coverage.indexedSequence)) {
    return { kind: 'unverified' };
  }
  if (!validSearchSuccessConsistency(value, coverage)) {
    return { kind: 'unverified' };
  }
  if (typeof value.complete !== 'boolean') {
    return { kind: 'unverified' };
  }
  if (typeof value.hasMore !== 'boolean') {
    return { kind: 'unverified' };
  }
  const complete =
    Number(coverage.indexedSequence) >= Number(value.targetSequence);
  if (value.complete !== complete || value.hasMore === complete) {
    return { kind: 'unverified' };
  }
  return complete
    ? {
        indexed: value.indexed,
        kind: 'complete',
        pages: value.pages,
        targetSequence: value.targetSequence,
      }
    : { kind: 'pending' };
}

function decodeSearchFailure(
  value: Record<string, unknown>
): SpansHistorySearchStatus {
  if (value.ok !== false || value.complete !== false) {
    return { kind: 'unverified' };
  }
  if (
    (value.unknown === undefined || typeof value.unknown === 'boolean') &&
    (value.indexed === undefined ||
      boundedInteger(value.indexed, MAX_SEARCH_INDEXED))
  ) {
    return value.unknown === true ? { kind: 'unknown' } : { kind: 'pending' };
  }
  return { kind: 'unverified' };
}

function validSearchSuccessConsistency(
  value: Record<string, unknown>,
  coverage: Record<string, unknown>
): boolean {
  return (
    Number(coverage.indexedSequence) <= Number(coverage.latestSequence) &&
    Number(value.targetSequence) <= Number(coverage.latestSequence) &&
    Number(value.indexed) <= Number(value.pages) * MAX_BATCH_COUNT &&
    !(value.pages === 0 && value.indexed !== 0)
  );
}

function decode(body: unknown): SpansHistoryImportResult | null {
  if (!isRecord(body)) {
    return null;
  }
  if (Object.hasOwn(body, 'unknown') && body.unknown === true) {
    return { kind: 'unknown', message: UNKNOWN_MESSAGE };
  }
  if (Object.hasOwn(body, 'ok') && body.ok === false) {
    if (typeof body.code !== 'string') {
      return null;
    }
    return Object.hasOwn(SAFE_ERRORS, body.code) ? refusal(body.code) : null;
  }
  if (body.ok !== true) {
    return null;
  }
  const required = [
    'runId',
    'sourceId',
    'state',
    'importedCount',
    'hasMore',
    'expectedOffset',
    'nextOffset',
    'pendingByteCount',
    'gapCount',
    'eof',
  ];
  if (!required.every((key) => Object.hasOwn(body, key))) {
    return null;
  }
  if (
    typeof body.runId !== 'string' ||
    !IDENTIFIER.test(body.runId) ||
    typeof body.sourceId !== 'string' ||
    !SOURCE_ID.test(body.sourceId) ||
    (body.state !== 'importing' && body.state !== 'imported') ||
    !boundedInteger(body.importedCount, MAX_BATCH_COUNT) ||
    !boundedInteger(body.gapCount, MAX_BATCH_COUNT) ||
    !boundedInteger(body.expectedOffset) ||
    !boundedInteger(body.nextOffset) ||
    Number(body.nextOffset) < Number(body.expectedOffset) ||
    !boundedInteger(body.pendingByteCount, MAX_SOURCE_BYTES) ||
    typeof body.hasMore !== 'boolean' ||
    typeof body.eof !== 'boolean'
  ) {
    return null;
  }
  const search = decodeSearchStatus(body.search);
  const hasPendingLine = body.pendingByteCount > 0;
  if (
    body.state !==
      (body.hasMore || hasPendingLine ? 'importing' : 'imported') ||
    (body.hasMore && body.nextOffset === body.expectedOffset)
  ) {
    return null;
  }
  return {
    eof: body.eof,
    expectedOffset: body.expectedOffset,
    gapCount: body.gapCount,
    hasMore: body.hasMore,
    importedCount: body.importedCount,
    kind: 'success',
    nextOffset: body.nextOffset,
    pendingByteCount: body.pendingByteCount,
    runId: body.runId,
    search,
    sourceId: body.sourceId,
    state: body.state,
  };
}

async function readBounded(response: Response): Promise<unknown | null> {
  const contentLength = response.headers.get('content-length');
  if (
    contentLength &&
    CONTENT_LENGTH.test(contentLength) &&
    Number(contentLength) > MAX_RESPONSE_BYTES
  ) {
    await response.body?.cancel();
    return null;
  }
  if (!response.body) {
    return null;
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      // biome-ignore lint/performance/noAwaitInLoops: Stream chunks must be bounded before decoding.
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      length += value.byteLength;
      if (length > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        return null;
      }
      chunks.push(value);
    }
    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return null;
  } finally {
    reader.releaseLock();
  }
}

export async function submitSpansHistoryImport(
  input: SpansHistoryImportInput
): Promise<SpansHistoryImportResult> {
  const snapshot = snapshotInput(input);
  if (!(snapshot.valid && snapshot.input)) {
    return { kind: 'refused', message: VALIDATION_MESSAGE };
  }
  let serialized: string;
  try {
    serialized = JSON.stringify(snapshot.input);
    if (new TextEncoder().encode(serialized).byteLength > MAX_REQUEST_BYTES) {
      return { kind: 'refused', message: VALIDATION_MESSAGE };
    }
  } catch {
    return { kind: 'refused', message: VALIDATION_MESSAGE };
  }
  try {
    const response = await fetch('/api/spans/history/import', {
      body: serialized,
      headers: { 'content-type': 'application/json' },
      method: 'POST',
    });
    const decoded = decode(await readBounded(response));
    if (!response.ok) {
      return decoded?.kind === 'refused'
        ? decoded
        : { kind: 'unknown', message: UNKNOWN_MESSAGE };
    }
    return decoded ?? { kind: 'unknown', message: UNKNOWN_MESSAGE };
  } catch {
    return { kind: 'unknown', message: UNKNOWN_MESSAGE };
  }
}
