// Pure mapping from Setu Links engine events to Spans archive events. It opens
// nothing and keeps no state. The engine is the only owner of delivery state:
// what leaves here is a derived, redacted, bounded record built from named
// fields only, so a peer's text can never add a field, an approval or a state
// of its own. Every id is a hash of structured identity, never of caller text.
import { createHash } from 'node:crypto';
import { redactSpansValue } from './spans-redaction.js';

export const LINKS_HISTORY_LIMITS = Object.freeze({
  // Two archive events per engine event keeps a batch inside the model
  // store's 200-event bound.
  batchEvents: 100,
  inputChars: 65_536,
  lineChars: 120,
  textBytes: 4096,
});
export const LINKS_PROJECTION_VERSION = 1;
const PARSER_VERSION = `links-projection-${LINKS_PROJECTION_VERSION}`;

const identifier = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const word = /^[a-z][a-z0-9-]{0,31}$/;
// Built from a string: outside a project with a tsconfig, Bun rewrites a \u2028
// escape inside a regex literal into a raw line terminator (a syntax error).
// biome-ignore lint/complexity/useRegexLiterals: a literal is not portable under Bun.
const CONTROLS = new RegExp(
  '[\\u0000-\\u0008\\u000B\\u000C\\u000E-\\u001F\\u007F-\\u009F\\u200B-\\u200F\\u2028\\u2029\\u202A-\\u202E\\u2060-\\u2069\\uFEFF]',
  'g'
);
// redactSpansValue needs the END line to see a key block. A body cut short, or
// a block never closed, would otherwise keep its key material.
const OPEN_KEY_BLOCK = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*$/i;
const MAX_SAFE = Number.MAX_SAFE_INTEGER;

const sha256 = (value) =>
  createHash('sha256').update(JSON.stringify(value), 'utf8').digest('hex');
const invalid = () => ({
  code: 'LINKS_EVENT_INVALID',
  error: 'The Links engine event is not in the expected shape.',
  ok: false,
});

class Bad extends Error {}
const bad = () => {
  throw new Bad('invalid');
};

const isRecord = (value) =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const count = (value) =>
  Number.isSafeInteger(value) && value >= 0 ? value : bad();
const idOf = (value) =>
  typeof value === 'string' && identifier.test(value) ? value : bad();
const wordOf = (value) =>
  typeof value === 'string' && word.test(value) ? value : bad();
// Absent means a plain event: only the engine's one-time backfill sets it.
const bool = (value) => {
  if (value === undefined || value === false) {
    return false;
  }
  return value === true ? true : bad();
};
const maybe = (value, check) =>
  value === undefined || value === null ? null : check(value);

function cleanText(text) {
  return text
    .replace(/\r\n?/g, '\n')
    .replace(CONTROLS, '')
    .replace(OPEN_KEY_BLOCK, '[REDACTED]');
}

function cutBytes(text, maxBytes) {
  let bytes = 0;
  let end = 0;
  for (const character of text) {
    const size = Buffer.byteLength(character, 'utf8');
    if (bytes + size > maxBytes) {
      return { cut: true, text: text.slice(0, end) };
    }
    bytes += size;
    end += character.length;
  }
  return { cut: false, text };
}

/**
 * Peer text as inert archive text: bounded before processing, control and
 * bidi characters removed, secrets redacted, then cut to the byte bound at a
 * character boundary. Markup is kept literally; it is only ever rendered as
 * text. `truncated` says the archive copy is not the whole message.
 */
export function sanitizeMessageText(body) {
  if (typeof body !== 'string') {
    return bad();
  }
  const sliced = body.length > LINKS_HISTORY_LIMITS.inputChars;
  const bounded = sliced
    ? body.slice(0, LINKS_HISTORY_LIMITS.inputChars)
    : body;
  const redacted = redactSpansValue(cleanText(bounded));
  const { cut, text } = cutBytes(redacted, LINKS_HISTORY_LIMITS.textBytes);
  return { text, truncated: sliced || cut };
}

// One printable redacted line, for ids and labels a peer or the engine supplies.
function line(value, max = LINKS_HISTORY_LIMITS.lineChars) {
  if (typeof value !== 'string') {
    return bad();
  }
  const flat = cleanText(value.slice(0, max * 4))
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
  return redactSpansValue(flat);
}

export function associationIdOf({ hint, origin, runId }) {
  return `links-assoc-${sha256([runId, origin, hint])}`;
}

/** The archive cursor identity. A replaced engine store gets a clean cursor. */
export function projectionKeyOf({ associationId, storeId }) {
  return {
    parserVersion: PARSER_VERSION,
    sourceGeneration: 0,
    sourceId: `links-proj-${sha256([storeId, associationId])}`,
  };
}

function eventId(type, ...identity) {
  return `${type}:${sha256([type, ...identity])}`;
}

function messageFields(message) {
  if (!(isRecord(message) && isRecord(message.recipient))) {
    return bad();
  }
  const { text, truncated } = sanitizeMessageText(message.body ?? '');
  return {
    createdAt: count(message.created_at),
    kind: line(message.kind, 32),
    origin: idOf(message.origin),
    projectionVersion: LINKS_PROJECTION_VERSION,
    recipient: {
      provider: line(message.recipient.provider, 64),
      sessionId: line(message.recipient.session_hint, 128),
    },
    replyTo: maybe(message.reply_to, (value) => line(value, 128)),
    runHint: maybe(message.run_hint, (value) => line(value, 128)),
    size: count(message.size),
    spanHint: maybe(message.span_hint, (value) => line(value, 128)),
    text,
    truncated,
  };
}

/**
 * The sanitized record of one engine message, as the history stores it.
 * Evidence stores this same record, so what a user reviews is what is kept.
 */
export function messageRecordOf(message) {
  try {
    if (!isRecord(message)) {
      return bad();
    }
    return {
      ok: true,
      record: {
        messageId: idOf(message.message_id),
        ...messageFields(message),
      },
    };
  } catch (error) {
    if (error instanceof Bad) {
      return invalid();
    }
    throw error;
  }
}

function statusFields(event) {
  return {
    at: count(event.at),
    attempts: count(event.attempts),
    backfill: bool(event.backfill),
    cancel: event.cancel === undefined ? 'none' : wordOf(event.cancel),
    expiresAt: count(event.expires_at),
    projectionVersion: LINKS_PROJECTION_VERSION,
    reason: maybe(event.reason, (value) => line(value)),
    redeliveries: count(event.redeliveries),
    remoteState: maybe(event.remote_state, wordOf),
    seq: count(event.seq),
    stage: maybe(event.stage, wordOf),
    state: wordOf(event.state),
  };
}

function mapOne(storeId, runId, event) {
  if (!isRecord(event) || typeof event.first !== 'boolean') {
    return bad();
  }
  const messageId = idOf(event.message_id);
  const mapped = [];
  if (event.first) {
    mapped.push({
      eventId: eventId('links.message', storeId, runId, messageId),
      payload: { messageId, ...messageFields(event.message) },
      runId,
      type: 'links.message',
    });
  }
  const status = statusFields(event);
  mapped.push({
    eventId: eventId('links.status', storeId, runId, messageId, status.seq),
    payload: { messageId, ...status },
    runId,
    type: 'links.status',
  });
  return mapped;
}

/**
 * One engine page for one run as archive events. `next` is how far the engine
 * scanned, which may pass events that did not match: a scan that found nothing
 * still advances the cursor. All or nothing: a malformed event rejects the
 * whole batch, so a cursor never moves over something that was not mapped.
 */
export function mapEngineBatch({
  events,
  expectedOffset,
  expectedOrigin,
  expectedRunHint,
  next,
  runId,
  storeId,
}) {
  try {
    idOf(runId);
    idOf(storeId);
    count(expectedOffset);
    count(next);
    if (
      !Array.isArray(events) ||
      events.length > LINKS_HISTORY_LIMITS.batchEvents
    ) {
      return bad();
    }
    const mapped = [];
    let previous = expectedOffset;
    for (const event of events) {
      if (
        (expectedOrigin !== undefined || expectedRunHint !== undefined) &&
        (typeof expectedOrigin !== 'string' ||
          typeof expectedRunHint !== 'string' ||
          event?.message?.origin !== expectedOrigin ||
          event?.message?.run_hint !== expectedRunHint)
      ) {
        return bad();
      }
      const seq = count(event?.seq);
      if (seq <= previous || seq > MAX_SAFE) {
        return bad();
      }
      previous = seq;
      mapped.push(...mapOne(storeId, runId, event));
    }
    if (next < previous) {
      return bad();
    }
    return { events: mapped, nextOffset: next, ok: true };
  } catch (error) {
    if (error instanceof Bad) {
      return invalid();
    }
    throw error;
  }
}
