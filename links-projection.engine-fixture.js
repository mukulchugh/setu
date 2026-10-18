// A stand-in for the Setu Links engine's passive `events` operation, for
// projection tests only. It follows the accepted protocol shape (store id,
// unfiltered head, a scan that passes events which did not match) but it is
// NOT the engine: a result that depends on it is a contract test of the
// projection, never evidence that the real engine behaves this way.
export const STORE_ID = 'st_0123456789abcdef0123456789abcdef';

export function engineMessage(patch = {}) {
  return {
    body: 'Which migration should run first?',
    created_at: 1_700_000_000_000,
    kind: 'message',
    origin: 'local',
    recipient: {
      provider: 'claude-code',
      session_hint: 'sess-1',
    },
    reply_to: null,
    run_hint: 'run-1',
    sender: { kind: 'user' },
    size: 33,
    span_hint: null,
    ...patch,
  };
}

// The `events` operation's result over a log, with the wire argument names.
// Pure, so a child process standing in for the engine can use it too.
export function readEngineLog({ args, log, storeId }) {
  const { after = 0, limit = 100, origin, run_hint: runHint } = args;
  const head = log.at(-1)?.seq ?? 0;
  const matching = [];
  let hasMore = false;
  for (const event of log) {
    if (event.seq <= after) {
      continue;
    }
    const wanted =
      (origin === undefined || event.message.origin === origin) &&
      (runHint === undefined || event.message.run_hint === runHint);
    if (!wanted) {
      continue;
    }
    if (matching.length === limit) {
      hasMore = true;
      break;
    }
    matching.push(event);
  }
  // The scan passes events that did not match, up to what was observed.
  const next = hasMore ? matching.at(-1).seq : Math.max(head, after);
  return {
    events: structuredClone(matching),
    has_more: hasMore,
    head,
    next,
    store_id: storeId,
  };
}

export function createFakeEngine({
  absent = false,
  delayMs = 1,
  storeId = STORE_ID,
} = {}) {
  const log = [];
  let nextSeq = 1;
  const seen = new Set();
  const calls = [];
  // One-shot callbacks that run while a reply is in flight: after the engine
  // has read its log and before the caller gets the answer, as a revocation or
  // a plan revision would land across a real child process's round trip.
  const inFlight = [];

  // One delivery-state change of a message, as the engine's trigger would log it.
  function record(messageId, message, state, patch = {}) {
    const first = !seen.has(messageId);
    seen.add(messageId);
    const event = {
      at: 1_700_000_000_000 + nextSeq,
      attempt_id: null,
      attempts: 0,
      backfill: false,
      cancel: 'none',
      expires_at: 1_700_600_000_000,
      first,
      message,
      message_id: messageId,
      reason: null,
      redeliveries: 0,
      remote_state: null,
      seq: nextSeq,
      stage: null,
      state,
      ...patch,
    };
    nextSeq += 1;
    log.push(event);
    return event;
  }

  function read({ after, limit, origin, runHint } = {}) {
    calls.push({ after, limit, origin, runHint });
    return {
      ok: true,
      ...(absent
        ? { events: [], has_more: false, head: 0, next: 0, store_id: null }
        : readEngineLog({
            args: { after, limit, origin, run_hint: runHint },
            log,
            storeId,
          })),
    };
  }

  // Like the production client, the answer arrives later, as a promise.
  async function events(args) {
    const reply = read(args);
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    const hook = inFlight.shift();
    if (hook) {
      await hook();
    }
    return reply;
  }

  return {
    calls,
    duringNextReply: (hook) => inFlight.push(hook),
    events,
    log,
    read,
    record,
  };
}
