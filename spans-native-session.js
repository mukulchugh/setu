import { redactSpansValue } from './spans-redaction.js';

// Keep the observer's retained line small even when a provider emits one very
// large record. An oversized line is discarded through its newline; later
// records can still be observed.
export const MAX_NATIVE_SESSION_LINE_BYTES = 64 * 1024;

const MAX_NATIVE_SESSION_ID_LENGTH = 256;
// biome-ignore lint/suspicious/noControlCharactersInRegex: Native IDs must exclude ASCII control characters.
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;

function hasSecretShape(value) {
  return (
    redactSpansValue(value) !== value ||
    redactSpansValue({ [value]: 0 })[value] !== 0
  );
}

function isSupportedSessionId(value) {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > MAX_NATIVE_SESSION_ID_LENGTH ||
    value.trim() !== value ||
    value === '__proto__' ||
    CONTROL_CHARACTERS.test(value)
  ) {
    return false;
  }
  try {
    return !hasSecretShape(value);
  } catch {
    return false;
  }
}

function sessionIdFromLine(line) {
  try {
    const event = JSON.parse(line);
    if (
      event === null ||
      typeof event !== 'object' ||
      Array.isArray(event) ||
      !Object.hasOwn(event, 'session_id') ||
      !isSupportedSessionId(event.session_id)
    ) {
      return null;
    }
    return event.session_id;
  } catch {
    return null;
  }
}

/**
 * Observe decoded provider stdout without changing or delaying its archived
 * text. `push(text)` returns the first safe Claude-style `session_id` found in
 * that text, and `finish()` checks the final unterminated JSON line. Each
 * method returns `null` after the first ID; stderr should not use this parser.
 *
 * Callers must keep archiving the original text regardless of the result.
 * The returned ID is only an observation candidate: callers must await their
 * `sink.native(id)` persistence result and treat a refusal as unbound. This
 * synchronous interface has no callback or internal work queue.
 */
export function createNativeSessionObserver() {
  let pending = '';
  let pendingBytes = 0;
  let discardingLine = false;
  let foundId = null;
  let finished = false;
  let available = true;

  const clearPending = () => {
    pending = '';
    pendingBytes = 0;
  };

  const appendSegment = (segment) => {
    if (!segment || discardingLine) {
      return;
    }
    const segmentBytes = Buffer.byteLength(segment, 'utf8');
    if (pendingBytes + segmentBytes > MAX_NATIVE_SESSION_LINE_BYTES) {
      clearPending();
      discardingLine = true;
      return;
    }
    pending += segment;
    pendingBytes += segmentBytes;
  };

  const observeCompleteLine = (segment) => {
    if (discardingLine) {
      discardingLine = false;
      clearPending();
      return null;
    }
    appendSegment(segment);
    if (discardingLine) {
      // This line already ended, so do not carry its overflow state into the
      // next newline-delimited record.
      discardingLine = false;
      clearPending();
      return null;
    }
    const line = pending;
    clearPending();
    const id = sessionIdFromLine(line);
    if (id !== null) {
      foundId = id;
      return id;
    }
    return null;
  };

  const disable = () => {
    available = false;
    clearPending();
    discardingLine = false;
    return null;
  };

  const push = (text) => {
    if (!available || finished || foundId !== null) {
      return null;
    }
    if (typeof text !== 'string') {
      return disable();
    }
    try {
      let start = 0;
      for (;;) {
        const newline = text.indexOf('\n', start);
        if (newline < 0) {
          appendSegment(text.slice(start));
          return null;
        }
        const id = observeCompleteLine(text.slice(start, newline));
        if (id !== null) {
          return id;
        }
        start = newline + 1;
      }
    } catch {
      return disable();
    }
  };

  const finish = () => {
    if (!available || finished || foundId !== null) {
      finished = true;
      return null;
    }
    finished = true;
    try {
      if (discardingLine) {
        clearPending();
        return null;
      }
      const id = sessionIdFromLine(pending);
      clearPending();
      if (id !== null) {
        foundId = id;
        return id;
      }
      return null;
    } catch {
      return disable();
    }
  };

  return Object.freeze({
    get available() {
      return available;
    },
    finish,
    push,
  });
}
