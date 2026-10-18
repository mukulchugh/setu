// Thin client for the Setu Links engine's operation protocol. The engine is the only holder of mailbox
// state: this module starts one engine process per operation, bounds how long it waits, and accepts a
// reply only if it has exactly the protocol's shape. It never opens the engine's database, and it never
// repeats a mutation on its own.

const PROTOCOL = 'setu-links/1';
const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_REPLY_BYTES = 2 * 1024 * 1024;
// What to do when a mutation's outcome is not known. Only a send has an idempotency key to repeat; the
// others are resolved by looking at the message, and none of them ever requeues anything by itself.
const RECOVERY = {
  acknowledge: 'Check the message status; acknowledging again is safe.',
  cancel: 'Check the message status; cancelling again is safe.',
  claim:
    'Anything it claimed is now handoff-unknown and is not delivered again unless redelivery is explicitly requested. Check the message status.',
  confirm:
    'Mail stays handoff-unknown until a confirmation for the exact attempt is accepted; repeating that same confirmation is safe.',
  reconcile: 'Repeating it is safe.',
  redeliver:
    'Check the message status before deciding whether to redeliver again.',
  send: 'Check the inbox, or repeat the send with the same idempotency key.',
  sweep: 'Repeating it is safe.',
};
const REPLY_KEYS = new Set(['error', 'id', 'ok', 'protocol', 'result']);
const ERROR_KEYS = new Set(['code', 'details', 'message', 'retryable']);
const codePattern = /^[A-Z][A-Z0-9_]{0,63}$/;

const isObject = (value) =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const failure = (code, error, extra = {}) => ({
  code,
  error,
  ok: false,
  ...extra,
});

// A mutation whose reply was lost may or may not have committed. It is reported as unknown, with the
// way to resolve it, and is never retried here.
function unavailable(op, reason) {
  return RECOVERY[op]
    ? failure(
        'LINKS_OUTCOME_UNKNOWN',
        `The Links engine did not confirm this ${op} (${reason}). ${RECOVERY[op]}`
      )
    : failure(
        'LINKS_ENGINE_UNAVAILABLE',
        `The Links engine is unavailable (${reason}).`
      );
}

// The shape of every successful result the service reads. A reply whose envelope is right but whose
// result is not is as untrustworthy as one with a wrong envelope.
const isText = (value) => typeof value === 'string';
const count = (value) => Number.isSafeInteger(value) && value >= 0;
const flag = (value) => typeof value === 'boolean';
const maybe = (check) => (value) => value === null || check(value);
const listOf = (check) => (value) => Array.isArray(value) && value.every(check);
const either =
  (...checks) =>
  (value) =>
    checks.some((check) => check(value));
const exactly = (spec) => (value) =>
  isObject(value) &&
  Object.keys(value).every((key) => Object.hasOwn(spec, key)) &&
  Object.entries(spec).every(([key, check]) => check(value[key]));
const DELIVERY_STATES = new Set([
  'acknowledged',
  'cancelled',
  'expired',
  'handed-off',
  'handoff-unknown',
  'held',
  'queued',
  // A message the sender's own outbox could not hand to the peer. It is a
  // failure to deliver and is never shown as delivered.
  'rejected',
]);
const messageFields = {
  attempt_id: maybe(isText),
  attempts: count,
  created_at: count,
  expires_at: count,
  kind: isText,
  message_id: isText,
  reason: maybe(isText),
  recipient: exactly({
    checkout: isText,
    native_id: isText,
    provider: isText,
    session_hint: isText,
  }),
  redeliveries: count,
  reply_to: maybe(isText),
  run_hint: maybe(isText),
  sender: exactly({ kind: isText }),
  size: count,
  span_hint: maybe(isText),
  state: (value) => DELIVERY_STATES.has(value),
  stored_state: (value) => DELIVERY_STATES.has(value),
  updated_at: count,
};
// One persisted change of a message, from the engine's append-only event log.
// Nullable fields are present as null, and an unknown field is refused like
// everywhere else. `origin` is 'local' or the authenticated peer key and never
// a display label; the recipient carries no checkout.
const eventMessage = exactly({
  body: isText,
  created_at: count,
  kind: isText,
  origin: isText,
  recipient: exactly({ provider: isText, session_hint: isText }),
  reply_to: maybe(isText),
  run_hint: maybe(isText),
  sender: exactly({ kind: isText }),
  size: count,
  span_hint: maybe(isText),
});
const eventFields = {
  at: count,
  attempt_id: maybe(isText),
  attempts: count,
  backfill: flag,
  cancel: isText,
  expires_at: count,
  first: flag,
  message: eventMessage,
  message_id: isText,
  reason: maybe(isText),
  redeliveries: count,
  remote_state: maybe(isText),
  seq: count,
  stage: maybe(isText),
  state: (value) => DELIVERY_STATES.has(value),
};
const statusOf = { message_id: isText, state: isText };
const RESULT_SHAPES = {
  acknowledge: exactly(statusOf),
  cancel: exactly(statusOf),
  claim: exactly({
    attempt_id: maybe(isText),
    messages: listOf(
      exactly({
        attempt: count,
        body: isText,
        created_at: count,
        message_id: isText,
        reply_to: maybe(isText),
        sender: exactly({ kind: isText }),
      })
    ),
    text: isText,
  }),
  confirm: exactly({ confirmed: listOf(isText), superseded: listOf(isText) }),
  events: exactly({
    events: listOf(exactly(eventFields)),
    has_more: flag,
    head: count,
    next: count,
    store_id: maybe(isText),
  }),
  health: exactly({
    engine_version: isText,
    protocol: isText,
    schema_version: count,
    store: isText,
  }),
  // The baseline listing, or the run-linked one: each message may also carry
  // its origin, and a page may say where the next one starts.
  list: either(
    exactly({ messages: listOf(exactly(messageFields)) }),
    exactly({
      has_more: flag,
      messages: listOf(exactly({ ...messageFields, origin: isText })),
      next_after: maybe(isText),
    })
  ),
  // Read loosely: the roster's own fields are the transport's to define.
  peer_list: (value) =>
    isObject(value) &&
    Array.isArray(value.peers) &&
    value.peers.every((peer) => isObject(peer) && isText(peer.peer_id)),
  reconcile: exactly({ held: listOf(isText), released: listOf(isText) }),
  redeliver: exactly(statusOf),
  send: exactly({ message_id: isText, replayed: flag, state: isText }),
  show: exactly({ ...messageFields, body: isText }),
  status: exactly(messageFields),
  sweep: exactly({ expired: listOf(isText) }),
};

function parseReply(text, id) {
  let reply;
  try {
    reply = JSON.parse(text);
  } catch {
    return null;
  }
  if (
    !(
      isObject(reply) &&
      Object.keys(reply).every((key) => REPLY_KEYS.has(key)) &&
      reply.protocol === PROTOCOL &&
      reply.id === id &&
      typeof reply.ok === 'boolean'
    )
  ) {
    return null;
  }
  if (reply.ok) {
    return isObject(reply.result) && reply.error === undefined ? reply : null;
  }
  const { error } = reply;
  return reply.result === undefined &&
    isObject(error) &&
    Object.keys(error).every((key) => ERROR_KEYS.has(key)) &&
    codePattern.test(error.code) &&
    typeof error.message === 'string' &&
    error.message.length <= 500 &&
    (error.retryable === undefined || typeof error.retryable === 'boolean') &&
    (error.details === undefined || isObject(error.details))
    ? reply
    : null;
}

async function readBounded(stream) {
  const chunks = [];
  let length = 0;
  for await (const chunk of stream) {
    length += chunk.byteLength;
    if (length > MAX_REPLY_BYTES) {
      return null;
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function interpret(op, finished, id) {
  if (!finished) {
    return unavailable(op, 'it timed out');
  }
  const [text, exitCode] = finished;
  const reply = exitCode === 0 && text !== null ? parseReply(text, id) : null;
  if (!reply) {
    return unavailable(op, 'it returned an unusable reply');
  }
  if (reply.ok) {
    // Only an operation with a known shape is believed, and only by its own keys.
    const shape = Object.hasOwn(RESULT_SHAPES, op) ? RESULT_SHAPES[op] : null;
    return shape?.(reply.result)
      ? { ok: true, result: reply.result }
      : unavailable(op, 'it returned an unusable reply');
  }
  const { code, details, message, retryable } = reply.error;
  return failure(`LINKS_${code}`, message, {
    ...(details === undefined ? {} : { details }),
    ...(retryable ? { retryable: true } : {}),
  });
}

export function createLinksClient({
  enginePath,
  dataDir,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  spawn = Bun.spawn,
  newId = () => crypto.randomUUID(),
} = {}) {
  if (!(typeof enginePath === 'string' && typeof dataDir === 'string')) {
    throw new TypeError(
      'The Links client needs an engine path and data directory'
    );
  }

  // Resolves with the engine's output and exit code, or null if the deadline came first.
  async function exchange(child, request) {
    let timer;
    const deadline = new Promise((resolve) => {
      timer = setTimeout(() => {
        child.kill('SIGKILL');
        resolve(null);
      }, timeoutMs);
    });
    try {
      child.stdin.write(JSON.stringify(request));
      await child.stdin.end();
      // The deadline wins even if something the engine started keeps its output open.
      return await Promise.race([
        Promise.all([readBounded(child.stdout), child.exited]),
        deadline,
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  async function call(op, args = {}) {
    const id = newId();
    let child;
    try {
      child = spawn([enginePath, '--data-dir', dataDir], {
        stderr: 'ignore',
        stdin: 'pipe',
        stdout: 'pipe',
      });
    } catch {
      return unavailable(op, 'it could not be started');
    }
    try {
      return interpret(
        op,
        await exchange(child, { args, id, op, protocol: PROTOCOL }),
        id
      );
    } catch {
      return unavailable(op, 'it could not be reached');
    }
  }

  return Object.freeze({ call });
}
