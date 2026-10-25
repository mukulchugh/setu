import { createHash } from 'node:crypto';
import { isAbsolute, resolve } from 'node:path';
import { importSpansSource } from './spans-import.js';
import { SPANS_MODEL_LIMITS } from './spans-model-store.js';
import { redactSpansValue } from './spans-redaction.js';
import {
  checkpointSpansSource,
  readSpansSourcePage,
} from './spans-source-file.js';

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SAFE_ERROR_CODE = /^[A-Z][A-Z0-9_]{0,63}$/;
const BYTE_IMPORT_MAX_RECORDS = 199;
const MAX_PENDING_BYTE_COUNT = 4 * 1024 * 1024;
const inputKeys = [
  'artifacts',
  'maxBytes',
  'parserVersion',
  'path',
  'provider',
  'runId',
  'sourceGeneration',
  'sourceId',
  'store',
];
const checkpointPayloadKeys = [
  'identity',
  'offset',
  'parserVersion',
  'provider',
  'sourceGeneration',
  'sourceId',
];
const identityKeys = [
  'birthtimeNs',
  'device',
  'inode',
  'offset',
  'prefixSha256',
];

function resultError(code, error, extra = {}) {
  return { code, error, ok: false, ...extra };
}

function safeCode(code, fallback) {
  return typeof code === 'string' && SAFE_ERROR_CODE.test(code)
    ? code
    : fallback;
}

function exactKeys(value, keys) {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.keys(value).sort().join(',') === [...keys].sort().join(',')
  );
}

function checkpointEventId(sourceId, sourceGeneration, parserVersion, offset) {
  return createHash('sha256')
    .update(
      JSON.stringify([sourceId, sourceGeneration, parserVersion, offset]),
      'utf8'
    )
    .digest('hex');
}

function validInput(input) {
  return (
    input !== null &&
    typeof input === 'object' &&
    typeof input.path === 'string' &&
    isAbsolute(input.path) &&
    input.store !== null &&
    typeof input.store === 'object' &&
    input.artifacts !== null &&
    typeof input.artifacts === 'object' &&
    ['codex', 'claude'].includes(input.provider) &&
    typeof input.sourceId === 'string' &&
    IDENTIFIER.test(input.sourceId) &&
    Number.isSafeInteger(input.sourceGeneration) &&
    input.sourceGeneration >= 0 &&
    typeof input.parserVersion === 'string' &&
    IDENTIFIER.test(input.parserVersion) &&
    typeof input.runId === 'string' &&
    IDENTIFIER.test(input.runId) &&
    (input.maxBytes === undefined ||
      (Number.isSafeInteger(input.maxBytes) &&
        input.maxBytes >= 1 &&
        input.maxBytes <= 4 * 1024 * 1024))
  );
}

function normalizedInput(input) {
  try {
    if (input === null || typeof input !== 'object' || Array.isArray(input)) {
      return;
    }
    const normalized = {};
    for (const key of inputKeys) {
      const descriptor = Object.getOwnPropertyDescriptor(input, key);
      if (descriptor && !Object.hasOwn(descriptor, 'value')) {
        return;
      }
      normalized[key] = descriptor?.value;
    }
    if (
      !validInput(normalized) ||
      typeof normalized.store.readSourceCursor !== 'function' ||
      typeof normalized.store.getEventById !== 'function' ||
      typeof normalized.store.commitImport !== 'function' ||
      typeof normalized.artifacts.put !== 'function'
    ) {
      return;
    }
    return normalized;
  } catch {
    // Throwing accessors and proxy traps are invalid public input.
  }
}

function identityFromCheckpoint(event, input, offset) {
  if (
    event?.type !== 'source.checkpoint' ||
    event.eventId !==
      checkpointEventId(
        input.sourceId,
        input.sourceGeneration,
        input.parserVersion,
        offset
      )
  ) {
    return resultError(
      'SOURCE_CHECKPOINT_INVALID',
      'Stored source checkpoint is invalid.'
    );
  }
  if (event.runId !== input.runId) {
    return resultError(
      'SOURCE_RUN_CONFLICT',
      'Source checkpoint belongs to a different run.'
    );
  }
  const { payload } = event;
  if (
    !exactKeys(payload, checkpointPayloadKeys) ||
    payload.sourceId !== input.sourceId ||
    payload.sourceGeneration !== input.sourceGeneration ||
    payload.parserVersion !== input.parserVersion ||
    payload.provider !== input.provider ||
    payload.offset !== offset ||
    !exactKeys(payload.identity, identityKeys) ||
    payload.identity.offset !== offset
  ) {
    return resultError(
      'SOURCE_CHECKPOINT_INVALID',
      'Stored source checkpoint is invalid.'
    );
  }
  return { identity: payload.identity, ok: true };
}

async function readCursor(store, input) {
  let cursor;
  try {
    cursor = await store.readSourceCursor({
      parserVersion: input.parserVersion,
      sourceGeneration: input.sourceGeneration,
      sourceId: input.sourceId,
    });
  } catch {
    return resultError(
      'SOURCE_CURSOR_READ_FAILED',
      'Could not read the source cursor.'
    );
  }
  if (cursor?.ok !== true) {
    return resultError(
      safeCode(cursor?.code, 'SOURCE_CURSOR_READ_FAILED'),
      'Could not read the source cursor.'
    );
  }
  if (
    typeof cursor.found !== 'boolean' ||
    !Number.isSafeInteger(cursor.offset) ||
    cursor.offset < 0 ||
    (!cursor.found && cursor.offset !== 0)
  ) {
    return resultError(
      'SOURCE_CURSOR_INVALID',
      'Stored source cursor is invalid.'
    );
  }
  return { cursor, ok: true };
}

async function readCheckpoint(store, input, offset) {
  const eventId = checkpointEventId(
    input.sourceId,
    input.sourceGeneration,
    input.parserVersion,
    offset
  );
  let found;
  try {
    found = await store.getEventById({ eventId });
  } catch {
    return resultError(
      'SOURCE_CHECKPOINT_READ_FAILED',
      'Could not read the source checkpoint.'
    );
  }
  if (found?.ok !== true) {
    return resultError(
      safeCode(found?.code, 'SOURCE_CHECKPOINT_READ_FAILED'),
      'Could not read the source checkpoint.'
    );
  }
  if (typeof found.found !== 'boolean') {
    return resultError(
      'SOURCE_CHECKPOINT_INVALID',
      'Stored source checkpoint is invalid.'
    );
  }
  if (!found.found) {
    return { found: false, ok: true };
  }
  const checkpoint = identityFromCheckpoint(found.event, input, offset);
  return checkpoint.ok ? { ...checkpoint, found: true } : checkpoint;
}

function publicResult({
  code,
  committed,
  eof,
  error,
  events = [],
  expectedOffset,
  hasMore,
  nextOffset,
  ok,
  pendingByteCount = null,
}) {
  return {
    ...(code ? { code } : {}),
    eof,
    ...(error ? { error } : {}),
    expectedOffset,
    gapCount: committed
      ? events.filter((event) => event.type === 'source.gap').length
      : 0,
    hasMore,
    importedCount: committed
      ? events.filter((event) => event.type === 'source.message').length
      : 0,
    nextOffset,
    ok,
    pendingByteCount,
  };
}

/** Import one bounded page from an explicitly selected local source file. */
export async function importSpansSourceFile(raw, admission) {
  if (
    admission !== undefined &&
    (!admission ||
      typeof admission.archiveWrite !== 'function' ||
      typeof admission.root !== 'string' ||
      !isAbsolute(admission.root) ||
      resolve(admission.root) !== admission.root)
  ) {
    return resultError(
      'SPANS_ARCHIVE_WRITE_INVALID',
      'Invalid archive write authority.'
    );
  }
  const input = normalizedInput(raw);
  if (!input) {
    return publicResult({
      code: 'SOURCE_IMPORT_INVALID',
      committed: false,
      eof: null,
      error: 'Invalid source file import arguments.',
      expectedOffset: null,
      hasMore: false,
      nextOffset: null,
      ok: false,
    });
  }

  const cursorResult = await readCursor(input.store, input);
  if (!cursorResult.ok) {
    return publicResult({
      code: cursorResult.code,
      committed: false,
      eof: null,
      error: cursorResult.error,
      expectedOffset: null,
      hasMore: false,
      nextOffset: null,
      ok: false,
    });
  }
  const { cursor } = cursorResult;
  const { offset } = cursor;
  const checkpoint = await readCheckpoint(input.store, input, offset);
  if (!checkpoint.ok) {
    return publicResult({
      code: checkpoint.code,
      committed: false,
      eof: null,
      error: checkpoint.error,
      expectedOffset: offset,
      hasMore: false,
      nextOffset: offset,
      ok: false,
    });
  }
  if (offset > 0 && !checkpoint.found) {
    return publicResult({
      code: 'SOURCE_CHECKPOINT_MISSING',
      committed: false,
      eof: null,
      error: 'A source checkpoint is required to resume.',
      expectedOffset: offset,
      hasMore: false,
      nextOffset: offset,
      ok: false,
    });
  }

  const page = await readSpansSourcePage({
    ...(checkpoint.found ? { expectedIdentity: checkpoint.identity } : {}),
    ...(input.maxBytes === undefined ? {} : { maxBytes: input.maxBytes }),
    offset,
    path: input.path,
  });
  if (!page.ok) {
    return publicResult({
      code: safeCode(page.code, 'SOURCE_READ_FAILED'),
      committed: false,
      eof: null,
      error: page.error,
      expectedOffset: offset,
      hasMore: false,
      nextOffset: offset,
      ok: false,
    });
  }

  const effect = () => commitSourcePage(input, cursor, page);
  if (admission === undefined) {
    return effect();
  }
  // JSON escaping can expand source text sixfold; include the bounded event
  // batch and SQLite bookkeeping. The shared gate also checks actual growth.
  const maxBytes =
    MAX_PENDING_BYTE_COUNT * 6 +
    SPANS_MODEL_LIMITS.batchBytes +
    2 * 1024 * 1024;
  let started = false;
  let result;
  try {
    result = await admission.archiveWrite(
      { maxBytes, root: admission.root },
      () => {
        started = true;
        return effect();
      }
    );
  } catch {
    result = null;
  }
  if (result?.ok === true && Object.hasOwn(result, 'value')) {
    return result.value;
  }
  return {
    ...publicResult({
      code: started
        ? 'SPANS_ARCHIVE_WRITE_UNKNOWN'
        : safeCode(result?.code, 'SPANS_ARCHIVE_WRITE_UNAVAILABLE'),
      committed: false,
      eof: page.eof,
      error: started
        ? 'Import outcome is unknown; inspect the archived cursor before retrying.'
        : 'Archive capacity did not admit the import.',
      expectedOffset: offset,
      hasMore: false,
      nextOffset: started ? null : offset,
      ok: false,
    }),
    ...(started ? { unknown: true } : {}),
  };
}

async function commitSourcePage(input, cursor, page) {
  const { offset } = cursor;
  let checkpointFailure;
  const coordinatorStore = {
    async commitImport(batch) {
      let checkpointEvent;
      let identity;
      const hasGap = batch.events.some((event) => event.type === 'source.gap');
      if (batch.nextOffset > batch.expectedOffset || hasGap) {
        const saved = await checkpointSpansSource({
          expectedIdentity: page.observedIdentity,
          offset: batch.nextOffset,
          path: input.path,
        });
        if (!saved.ok) {
          checkpointFailure = saved;
          return {
            code: safeCode(saved.code, 'SOURCE_CHECKPOINT_FAILED'),
            ok: false,
          };
        }
        ({ identity } = saved);
        checkpointEvent = redactSpansValue({
          eventId: checkpointEventId(
            input.sourceId,
            input.sourceGeneration,
            input.parserVersion,
            batch.nextOffset
          ),
          payload: {
            identity,
            offset: batch.nextOffset,
            parserVersion: input.parserVersion,
            provider: input.provider,
            sourceGeneration: input.sourceGeneration,
            sourceId: input.sourceId,
          },
          runId: input.runId,
          type: 'source.checkpoint',
        });
        if (batch.events.length >= 200) {
          return { code: 'SOURCE_IMPORT_BATCH_LIMIT', ok: false };
        }
      }
      let result;
      try {
        result = await input.store.commitImport({
          ...batch,
          ...(checkpointEvent
            ? { events: [...batch.events, checkpointEvent] }
            : {}),
        });
      } catch {
        return { code: 'SOURCE_IMPORT_COMMIT_FAILED', ok: false };
      }
      return result;
    },
    readSourceCursor() {
      // The transaction CAS uses the same cursor snapshot as the file read.
      return { found: cursor.found, offset, ok: true };
    },
  };

  const imported = await importSpansSource({
    artifacts: input.artifacts,
    bytes: page.bytes,
    maxRecords: BYTE_IMPORT_MAX_RECORDS,
    offset,
    parserVersion: input.parserVersion,
    provider: input.provider,
    runId: input.runId,
    sourceGeneration: input.sourceGeneration,
    sourceId: input.sourceId,
    store: coordinatorStore,
  });
  return importResult(imported, page, offset, checkpointFailure);
}

function importResult(imported, page, offset, checkpointFailure) {
  const committed =
    imported.ok === true ||
    (imported.gap?.type === 'source.gap' &&
      Number.isSafeInteger(imported.nextOffset));
  const events = committed ? (imported.events ?? []) : [];
  const nextOffset = committed ? imported.nextOffset : offset;
  const pendingByteCount = Math.min(
    imported.pendingBytes?.length ?? 0,
    MAX_PENDING_BYTE_COUNT
  );
  const madeProgress = nextOffset > offset;
  const recordLimitReached =
    imported.ok === true &&
    imported.events?.length >= BYTE_IMPORT_MAX_RECORDS &&
    pendingByteCount > 0;
  const hasMore = madeProgress && (!page.eof || recordLimitReached);
  const failure = checkpointFailure;
  const code = imported.ok
    ? undefined
    : safeCode(failure?.code ?? imported.code, 'SOURCE_IMPORT_FAILED');
  const error = imported.ok
    ? undefined
    : (failure?.error ?? imported.error ?? 'Source import failed.');
  return publicResult({
    code,
    committed,
    eof: page.eof,
    error,
    events,
    expectedOffset: offset,
    hasMore,
    nextOffset,
    ok: imported.ok === true,
    pendingByteCount,
  });
}
