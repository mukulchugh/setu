import { createHash } from 'node:crypto';
import { redactSpansValue } from './spans-redaction.js';
import { parseSpansSourceRecord } from './spans-source-parsers.js';

const utf8 = new TextDecoder('utf-8', { fatal: true });
const MAX_SOURCE_BATCH_BYTES = 4 * 1024 * 1024;
const DEFAULT_MAX_RECORDS = 200;
const SAFE_ERROR_CODE = /^[A-Z][A-Z0-9_]{0,63}$/;
const inputKeys = [
  'artifacts',
  'bytes',
  'maxRecords',
  'offset',
  'parserVersion',
  'provider',
  'runId',
  'sourceGeneration',
  'sourceId',
  'store',
];

function resultError(code, error, extra = {}) {
  return { code, error, ok: false, ...extra };
}

function adapterErrorCode(code, fallback) {
  return typeof code === 'string' && SAFE_ERROR_CODE.test(code)
    ? code
    : fallback;
}

function validInput(input) {
  return (
    input !== null &&
    typeof input === 'object' &&
    input.store !== null &&
    typeof input.store === 'object' &&
    input.artifacts !== null &&
    typeof input.artifacts === 'object' &&
    typeof input.provider === 'string' &&
    typeof input.sourceId === 'string' &&
    input.sourceId.length > 0 &&
    Number.isSafeInteger(input.sourceGeneration) &&
    input.sourceGeneration >= 0 &&
    typeof input.parserVersion === 'string' &&
    input.parserVersion.length > 0 &&
    Number.isSafeInteger(input.offset) &&
    input.offset >= 0 &&
    input.bytes instanceof Uint8Array &&
    typeof input.runId === 'string' &&
    input.runId.length > 0 &&
    (input.maxRecords === undefined ||
      (Number.isSafeInteger(input.maxRecords) &&
        input.maxRecords >= 1 &&
        input.maxRecords <= 200))
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
    if (!validInput(normalized)) {
      return;
    }
    if (
      !ArrayBuffer.isView(normalized.bytes) ||
      (Object.getPrototypeOf(normalized.bytes) !== Uint8Array.prototype &&
        Object.getPrototypeOf(normalized.bytes) !== Buffer.prototype)
    ) {
      return;
    }
    if (
      Object.hasOwn(normalized.bytes, 'byteLength') ||
      Object.hasOwn(normalized.bytes, 'length')
    ) {
      return;
    }
    if (normalized.bytes.byteLength <= MAX_SOURCE_BATCH_BYTES) {
      normalized.bytes = Uint8Array.prototype.slice.call(normalized.bytes);
    }
    return normalized;
  } catch {
    // Throwing accessors and proxy traps are invalid public input.
  }
}

function validAdapters(input) {
  try {
    return (
      typeof input.store.readSourceCursor === 'function' &&
      typeof input.store.commitImport === 'function' &&
      typeof input.artifacts.put === 'function'
    );
  } catch {
    return false;
  }
}

function stableEventId(
  sourceId,
  sourceGeneration,
  parserVersion,
  startByte,
  nativeId,
  kind
) {
  // JSON tuple encoding avoids ambiguous delimiter collisions in caller values.
  const identity = JSON.stringify([
    sourceId,
    sourceGeneration,
    parserVersion,
    startByte,
    nativeId,
    kind,
  ]);
  return createHash('sha256').update(identity, 'utf8').digest('hex');
}

function sourceFields(input, byteStart, byteEnd) {
  return {
    byteEnd,
    byteStart,
    parserVersion: input.parserVersion,
    provider: input.provider,
    sourceGeneration: input.sourceGeneration,
    sourceId: input.sourceId,
  };
}

function gapEvent(
  input,
  runId,
  startByte,
  endByte,
  reason,
  nativeId = null,
  state = 'partial'
) {
  const kind = `gap:${reason}`;
  return {
    eventId: stableEventId(
      input.sourceId,
      input.sourceGeneration,
      input.parserVersion,
      startByte,
      nativeId,
      kind
    ),
    payload: {
      ...sourceFields(input, startByte, endByte),
      coverage: { reason, state },
      summary: reason,
    },
    runId,
    type: 'source.gap',
  };
}

function messageSummary(event) {
  const text = event.text.trim();
  const summary = text.length > 240 ? `${text.slice(0, 237)}...` : text;
  return summary || `${event.role} ${event.kind}`;
}

function messageEvent(
  input,
  runId,
  { nativeId, ...parsed },
  startByte,
  endByte,
  artifactId
) {
  return {
    eventId: stableEventId(
      input.sourceId,
      input.sourceGeneration,
      input.parserVersion,
      startByte,
      nativeId,
      parsed.kind
    ),
    payload: {
      ...sourceFields(input, startByte, endByte),
      artifactId,
      coverage: parsed.coverage,
      nativeId,
      summary: messageSummary(parsed),
    },
    runId,
    type: 'source.message',
  };
}

function findLine(bytes, start) {
  let newline = start;
  while (newline < bytes.length && bytes[newline] !== 0x0a) {
    newline += 1;
  }
  if (newline === bytes.length) {
    return null;
  }
  return { end: newline + 1, newline };
}

async function parseAndStoreRecord(
  input,
  runId,
  lineBytes,
  startByte,
  endByte
) {
  let recordText;
  try {
    recordText = utf8.decode(lineBytes);
  } catch {
    return {
      code: 'SOURCE_RECORD_INVALID',
      error: 'Source contains an invalid UTF-8 record.',
      gap: 'invalid UTF-8 record',
    };
  }

  let record;
  try {
    record = JSON.parse(recordText);
  } catch {
    return {
      code: 'SOURCE_RECORD_INVALID',
      error: 'Source contains a malformed JSON record.',
      gap: 'malformed JSON record',
    };
  }

  const parsedResult = parseSpansSourceRecord({
    parserVersion: input.parserVersion,
    provider: input.provider,
    record,
    sourceGeneration: input.sourceGeneration,
    sourceId: input.sourceId,
  });
  if (!parsedResult.ok) {
    return {
      code: parsedResult.code,
      error:
        parsedResult.code === 'SOURCE_RECORD_UNSUPPORTED'
          ? 'Source record is unsupported.'
          : 'Source record is invalid.',
      gap: parsedResult.error,
      state:
        parsedResult.code === 'SOURCE_RECORD_UNSUPPORTED'
          ? 'unsupported'
          : 'partial',
    };
  }

  let redactedEvent;
  let artifact;
  try {
    redactedEvent = redactSpansValue(parsedResult.event);
    artifact = await input.artifacts.put({
      mediaType: 'application/json',
      text: JSON.stringify(redactedEvent),
    });
  } catch {
    return { code: 'SOURCE_ARTIFACT_WRITE_FAILED' };
  }
  if (
    artifact?.ok !== true ||
    typeof artifact.artifactId !== 'string' ||
    artifact.artifactId.length === 0
  ) {
    return { code: 'SOURCE_ARTIFACT_WRITE_FAILED' };
  }

  try {
    return {
      event: redactSpansValue(
        messageEvent(
          input,
          runId,
          redactedEvent,
          startByte,
          endByte,
          artifact.artifactId
        )
      ),
    };
  } catch {
    return { code: 'SOURCE_RECORD_INVALID' };
  }
}

async function collectEvents(
  input,
  runId,
  offset,
  position,
  events,
  maxRecords,
  count = 0
) {
  let lineStart = position;
  let line;
  let lineBytes;
  while (count < maxRecords) {
    line = findLine(input.bytes, lineStart);
    if (line === null) {
      return {
        consumed: lineStart,
        events,
        stopAt: null,
        stopCode: null,
        stopError: null,
      };
    }
    lineBytes = input.bytes.subarray(lineStart, line.newline);
    if (lineBytes.at(-1) === 0x0d) {
      lineBytes = lineBytes.subarray(0, lineBytes.length - 1);
    }
    if (lineBytes.length > 0) {
      break;
    }
    lineStart = line.end;
  }

  if (count === maxRecords || line === null) {
    return {
      consumed: lineStart,
      events,
      stopAt: null,
      stopCode: null,
      stopError: null,
    };
  }

  const startByte = offset + lineStart;
  const endByte = offset + line.end;
  const parsed = await parseAndStoreRecord(
    input,
    runId,
    lineBytes,
    startByte,
    endByte
  );
  if (parsed.gap) {
    events.push(
      gapEvent(
        input,
        runId,
        startByte,
        endByte,
        parsed.gap,
        null,
        'state' in parsed ? parsed.state : 'partial'
      )
    );
    return {
      consumed: lineStart,
      events,
      stopAt: lineStart,
      stopCode: parsed.code,
      stopError: parsed.error,
    };
  }
  if ('code' in parsed) {
    return { code: parsed.code, consumed: lineStart, events };
  }

  events.push(parsed.event);
  return collectEvents(
    input,
    runId,
    offset,
    line.end,
    events,
    maxRecords,
    count + 1
  );
}

async function commitEvents(
  input,
  expectedOffset,
  offset,
  nextOffset,
  pendingBytes,
  safeEvents,
  stopAt,
  stopCode,
  stopError
) {
  let committed;
  try {
    committed = await input.store.commitImport({
      events: safeEvents,
      expectedOffset: offset,
      nextOffset,
      parserVersion: input.parserVersion,
      sourceGeneration: input.sourceGeneration,
      sourceId: input.sourceId,
    });
  } catch {
    return resultError(
      'SOURCE_IMPORT_COMMIT_FAILED',
      'Could not commit the imported source batch.',
      {
        expectedOffset,
        nextOffset: expectedOffset,
        pendingBytes: input.bytes.slice(),
      }
    );
  }
  if (committed?.ok !== true) {
    return resultError(
      adapterErrorCode(committed?.code, 'SOURCE_IMPORT_COMMIT_FAILED'),
      'Could not commit the imported source batch.',
      {
        expectedOffset,
        nextOffset: expectedOffset,
        pendingBytes: input.bytes.slice(),
      }
    );
  }

  if (stopAt !== null) {
    return resultError(stopCode, stopError, {
      events: safeEvents,
      expectedOffset,
      gap:
        safeEvents.find(
          (event) =>
            event.type === 'source.gap' &&
            event.payload.byteStart === nextOffset
        ) ?? null,
      nextOffset,
      pendingBytes,
    });
  }
  return {
    events: safeEvents,
    expectedOffset,
    nextOffset,
    ok: true,
    pendingBytes,
  };
}

async function loadExpectedOffset({
  store,
  sourceId,
  sourceGeneration,
  parserVersion,
  offset,
  bytes,
}) {
  let cursor;
  try {
    cursor = await store.readSourceCursor({
      parserVersion,
      sourceGeneration,
      sourceId,
    });
  } catch {
    return resultError(
      'SOURCE_CURSOR_READ_FAILED',
      'Could not read the source cursor.'
    );
  }
  if (!cursor || (cursor.ok !== true && cursor.code !== 'NOT_FOUND')) {
    return resultError(
      adapterErrorCode(cursor?.code, 'SOURCE_CURSOR_READ_FAILED'),
      'Could not read the source cursor.'
    );
  }
  const cursorNotFound = cursor.ok !== true;
  const expectedOffset = cursorNotFound ? 0 : cursor.offset;
  if (!Number.isSafeInteger(expectedOffset) || expectedOffset < 0) {
    return resultError(
      'SOURCE_CURSOR_INVALID',
      'Stored source cursor is invalid.'
    );
  }
  if (cursorNotFound && offset !== 0) {
    return resultError(
      'SOURCE_OFFSET_CONFLICT',
      'A new source must start at byte zero.',
      {
        expectedOffset,
        nextOffset: expectedOffset,
        pendingBytes: bytes.slice(),
      }
    );
  }
  // Let older offsets reach the atomic store, which can recognize an exact
  // replay from its stable event IDs. A forward jump cannot be a replay.
  if (offset > expectedOffset) {
    return resultError(
      'SOURCE_OFFSET_CONFLICT',
      'Requested offset does not match the committed cursor.',
      {
        expectedOffset,
        nextOffset: expectedOffset,
        pendingBytes: bytes.slice(),
      }
    );
  }
  return { expectedOffset, ok: true };
}

/**
 * Import complete newline-terminated JSONL records from caller-selected bytes.
 * This function never opens a source path or modifies the native input.
 */
export async function importSpansSource(raw) {
  const input = normalizedInput(raw);
  if (!input) {
    return resultError(
      'SOURCE_IMPORT_INVALID',
      'Invalid source import arguments.'
    );
  }
  const { offset, bytes, runId } = input;
  if (bytes.length > MAX_SOURCE_BATCH_BYTES) {
    return resultError(
      'SOURCE_BATCH_TOO_LARGE',
      'Source import batch exceeds the 4 MiB limit.'
    );
  }
  if (!Number.isSafeInteger(offset + bytes.length)) {
    return resultError(
      'SOURCE_OFFSET_INVALID',
      'Source import byte range exceeds the safe integer limit.'
    );
  }
  if (!validAdapters(input)) {
    return resultError(
      'SOURCE_IMPORT_ADAPTER_INVALID',
      'Source import adapters are incomplete.'
    );
  }
  const cursorResult = await loadExpectedOffset(input);
  if (cursorResult.ok !== true) {
    return cursorResult;
  }
  const { expectedOffset } = cursorResult;

  let collected;
  try {
    collected = await collectEvents(
      input,
      runId,
      offset,
      0,
      [],
      input.maxRecords ?? DEFAULT_MAX_RECORDS
    );
  } catch {
    return resultError(
      'SOURCE_RECORD_INVALID',
      'Could not prepare a safe source event.',
      {
        expectedOffset,
        nextOffset: expectedOffset,
        pendingBytes: bytes.slice(),
      }
    );
  }
  if (collected.code) {
    const error =
      collected.code === 'SOURCE_ARTIFACT_WRITE_FAILED'
        ? 'Could not store the redacted source artifact.'
        : 'Could not prepare a safe source event.';
    return resultError(collected.code, error, {
      expectedOffset,
      nextOffset: expectedOffset,
      pendingBytes: bytes.slice(),
    });
  }
  const { events, stopAt, stopCode, stopError } = collected;

  // The unconsumed suffix starts at the first incomplete line or first bad line.
  const nextOffset = offset + (stopAt === null ? collected.consumed : stopAt);
  const pendingBytes = bytes.slice(
    stopAt === null ? collected.consumed : stopAt
  );
  let safeEvents;
  try {
    safeEvents = redactSpansValue(events);
  } catch {
    return resultError(
      'SOURCE_RECORD_INVALID',
      'Could not prepare safe source events.',
      {
        expectedOffset,
        nextOffset: expectedOffset,
        pendingBytes: bytes.slice(),
      }
    );
  }

  return commitEvents(
    input,
    expectedOffset,
    offset,
    nextOffset,
    pendingBytes,
    safeEvents,
    stopAt,
    stopCode,
    stopError
  );
}
