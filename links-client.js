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
  binding_invalidate:
    'Repeating it is safe: an invalidation at the same generation changes nothing more.',
  binding_publish:
    'Repeating it is safe: a publish at an unchanged generation only refreshes its validity.',
  attention_send:
    'Check the attention list, or repeat the request with the same idempotency key.',
  cancel: 'Check the message status; cancelling again is safe.',
  claim:
    'Anything it claimed is now handoff-unknown and is not delivered again unless redelivery is explicitly requested. Check the message status.',
  confirm:
    'Mail stays handoff-unknown until a confirmation for the exact attempt is accepted; repeating that same confirmation is safe.',
  identity:
    'Repeating it is safe: the key is made once, whole, and kept; if it is refused the reply names the file to move aside.',
  peer_add: 'Repeating it is safe.',
  peer_grant: 'Repeating it is safe.',
  peer_grant_remove: 'Repeating it is safe.',
  peer_remove: 'Repeating it is safe.',
  presence_publish:
    'Repeating it is safe; the next presence round publishes it again.',
  reconcile: 'Repeating it is safe.',
  redeliver:
    'Check the message status before deciding whether to redeliver again.',
  resume: 'Repeating it is safe.',
  send: 'Check the inbox, or repeat the send with the same idempotency key.',
  share_attention:
    'Check the sharing status before confirming again; attention requests are admitted only if the status says so.',
  share_disable:
    'Check the sharing status; disabling again is safe, and sharing stays on until it is confirmed disabled.',
  share_enable:
    'Check the sharing status before confirming again; nothing is shared unless the status says it is.',
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
const anyOf =
  (...checks) =>
  (value) =>
    checks.some((check) => check(value));
const exactly =
  (spec, optional = {}) =>
  (value) =>
    isObject(value) &&
    Object.keys(value).every(
      (key) => Object.hasOwn(spec, key) || Object.hasOwn(optional, key)
    ) &&
    Object.entries(spec).every(([key, check]) => check(value[key])) &&
    Object.entries(optional).every(
      ([key, check]) => value[key] === undefined || check(value[key])
    );
const either = anyOf;
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
// Who sent a message: the local user, a local session by its id, or a peer machine by its authenticated key.
const senderShape = anyOf(
  exactly({ kind: (value) => value === 'user' }),
  exactly({ id: isText, kind: (value) => value === 'session' }),
  exactly({ id: isText, kind: (value) => value === 'peer' })
);
const policyShape = exactly({
  attention: flag,
  interrupt: flag,
  owner: isText,
  receive: flag,
  scope: isText,
  version: count,
  visibility: flag,
});
const projectStanding = anyOf(
  exactly({ project: isText, state: (value) => value === 'absent' }),
  exactly({
    policy: policyShape,
    project: isText,
    state: (value) => value === 'enabled',
    updated_at: count,
  }),
  exactly({
    error: exactly({ code: isText, reason: isText }),
    project: isText,
    state: (value) => value === 'invalid',
  })
);
// The sender's view of a message sent to a peer. `outbox` says whether the peer has durably taken it;
// `cancel` says whether a retraction is still waiting on the peer's answer.
const transport = exactly({
  attempts: count,
  cancel: isText,
  last_error: maybe(isText),
  outbox: isText,
  peer_id: isText,
  remote_reason: maybe(isText),
  remote_state: maybe(isText),
  remote_updated_at: maybe(count),
});
const messageFields = {
  attempt_id: maybe(isText),
  attempts: count,
  created_at: count,
  expires_at: count,
  kind: isText,
  locator: isText,
  message_id: isText,
  project: maybe(isText),
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
  sender: senderShape,
  size: count,
  span_hint: maybe(isText),
  state: (value) => DELIVERY_STATES.has(value),
  stored_state: (value) => DELIVERY_STATES.has(value),
  updated_at: count,
};
// `observed_match` is the engine's own answer to "is this message addressed to the conversation I passed as
// `observed`", true or false, or null when none was passed. Callers must ask the engine rather than compare tuples:
// mail from a peer is stored under an opaque address the engine alone can match.
const optionalMessageFields = { observed_match: maybe(flag), transport };
// Who raised an attention request: a local session by its id. A user or a peer is not a sender here.
const attentionSender = exactly({
  id: isText,
  kind: (value) => value === 'session',
});
const attentionFields = {
  admitted: flag,
  attention_id: isText,
  body: isText,
  created_at: count,
  project: maybe(isText),
  recipient: exactly({
    checkout: isText,
    native_id: isText,
    provider: isText,
    session_hint: isText,
  }),
  sender: attentionSender,
};
// One request on its own carries no notification state; a listed one names its counted chain (none when it
// is older than the window) and says whether that chain is shown as notifying.
const attentionItem = exactly(attentionFields);
const listedAttentionItem = exactly({
  ...attentionFields,
  group_key: maybe(isText),
  notifying: flag,
});
const attentionGroup = exactly({
  count,
  count_complete: flag,
  first_at: count,
  group_key: isText,
  item_ids: listOf(isText),
  last_at: count,
  latest_attention_id: isText,
  project: maybe(isText),
  recipient_session_hint: isText,
  sender: attentionSender,
});
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
  attention_list: exactly({
    has_more: flag,
    items: listOf(listedAttentionItem),
    next_before: maybe(isText),
    notifications: exactly({
      groups: listOf(attentionGroup),
      suppressed: count,
    }),
  }),
  attention_send: exactly({ attention_id: isText, replayed: flag }),
  attention_show: attentionItem,
  binding_invalidate: exactly({ held: listOf(isText), stored: flag }),
  binding_publish: exactly({
    held: listOf(isText),
    released: listOf(isText),
    stored: flag,
    valid_until: count,
  }),
  binding_show: exactly(
    { state: isText },
    {
      generation: count,
      invalid_reason: maybe(isText),
      project: maybe(isText),
      recipient: maybe(isObject),
      valid_until: count,
    }
  ),
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
        sender: senderShape,
      })
    ),
    text: isText,
  }),
  confirm: exactly({ confirmed: listOf(isText), superseded: listOf(isText) }),
  directory: exactly({
    entries: listOf(
      exactly({
        activity_at: maybe(count),
        observed_at: count,
        owner: isText,
        project: isText,
        reachability: exactly({ reason: maybe(isText), state: isText }),
        session_id: isText,
        stale: flag,
        task: maybe(isText),
        task_at: maybe(count),
        task_stale: flag,
      })
    ),
    problems: listOf(
      exactly({ code: isText, project: isText, reason: isText })
    ),
    stale_after_ms: count,
  }),
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
  identity: exactly({ peer_id: isText }),
  list: either(
    exactly({ messages: listOf(exactly(messageFields, optionalMessageFields)) }),
    exactly({
      has_more: flag,
      messages: listOf(exactly({ ...messageFields, origin: isText }, optionalMessageFields)),
      next_after: maybe(isText),
    })
  ),
  peer_add: exactly({ peer_id: isText }),
  peer_grant: exactly({ peer_id: isText }),
  peer_grant_remove: exactly({ peer_id: isText }),
  peer_list: exactly({
    peers: listOf(
      exactly({
        addresses: listOf(isText),
        created_at: count,
        grants: listOf(
          exactly({
            capability: isText,
            scope: exactly({ kind: isText }, { id: isText }),
          })
        ),
        label: isText,
        peer_id: isText,
        published: listOf(
          exactly({
            recipient: exactly({
              checkout: isText,
              native_id: isText,
              provider: isText,
              session_hint: isText,
            }),
            scope: isText,
            session_hint: isText,
          })
        ),
      })
    ),
  }),
  peer_remove: exactly({ peer_id: isText }),
  presence_publish: exactly({ project: isText, published: count }),
  reconcile: exactly({ held: listOf(isText), released: listOf(isText) }),
  redeliver: exactly(statusOf),
  resume: exactly({ moved: listOf(isText), released: listOf(isText) }),
  send: exactly({ message_id: isText, replayed: flag, state: isText }),
  share_attention: exactly({
    changed: flag,
    policy: policyShape,
    project: isText,
  }),
  share_disable: exactly({
    held: listOf(isText),
    project: isText,
    removed: flag,
  }),
  share_enable: exactly({
    changed: flag,
    policy: policyShape,
    project: isText,
    released: listOf(isText),
  }),
  share_status: exactly({ projects: listOf(projectStanding) }),
  show: exactly({ ...messageFields, body: isText }, optionalMessageFields),
  status: exactly(messageFields, optionalMessageFields),
  sweep: exactly({ expired: listOf(isText) }),
  transport_status: exactly(
    { running: flag },
    {
      engine_version: isText,
      links: listOf(
        exactly({ peer_id: isText, state: isText }, { code: isText })
      ),
      listen: listOf(isText),
      peer_id: isText,
      pid: count,
      protocol_versions: listOf(count),
      started_at: count,
    }
  ),
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

// The engine's one database file inside its data directory (store.rs `DATABASE`). A mailbox exists exactly when this
// file does: the directory alone says nothing, because the engine also keeps its identity and transport state there.
export const MAILBOX_FILE = 'mailbox.sqlite3';

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
