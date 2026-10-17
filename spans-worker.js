import { createHash } from 'node:crypto';
import { redactSpansValue as redactValue } from './spans-redaction.js';

// Owned capture worker engine. It launches nothing itself: launch, stop, spool
// and clock are injected, and every durable change goes through the existing
// run-view compare-and-set (readRun/commitRun) with its events. There is no
// timer, queue of work or scheduler here; callers drive every step, and the
// admission, claim and lease decisions stay with Setu.
//
// Durable shape: view.attempts[attemptId], a plain JSON record. It adds no
// table or column. The record is written as `launching` BEFORE the launch
// adapter is called, so a crash can never hide an effect.

const MAX_ID_LENGTH = 256;
const MAX_COMMIT_TRIES = 4;
const ARTIFACT_ID_PATTERN = /^sha256:[0-9a-f]{64}$/;
const ADAPTER_CODE_PATTERN = /^[A-Z][A-Z0-9_]{0,63}$/;
const SIGNAL_PATTERN = /^[A-Z][A-Z0-9]{1,15}$/;
const MAX_EXIT_CODE = 2_147_483_647;
// spans-model-store.js answers with the SPANS_MODEL_STALE_* codes; the
// *_CONFLICT spellings are accepted as aliases, as in spans-actions.js.
const STALE_REVISION_CODES = new Set([
  'SPANS_MODEL_REVISION_CONFLICT',
  'SPANS_MODEL_STALE_REVISION',
]);
const STALE_GENERATION_CODES = new Set([
  'SPANS_MODEL_GENERATION_CONFLICT',
  'SPANS_MODEL_STALE_GENERATION',
]);

const BINDING_FIELDS = Object.freeze([
  'actionId',
  'attemptId',
  'generation',
  'runId',
  'spanId',
  'workerId',
]);
const LIMIT_NAMES = Object.freeze([
  'maxActiveAttempts',
  'maxAttemptBytes',
  'maxAttemptChunks',
  'maxChunkBytes',
  'maxDeadlineMs',
  'maxQueueBytes',
]);

export const SPANS_WORKER_EVENT_TYPES = Object.freeze({
  cancelDelivered: 'spans.worker.cancel.delivered',
  cancelRequested: 'spans.worker.cancel.requested',
  cancelUnknown: 'spans.worker.cancel.unknown',
  exited: 'spans.worker.exited',
  finalizing: 'spans.worker.finalizing',
  held: 'spans.worker.held',
  intent: 'spans.worker.intent',
  launched: 'spans.worker.launched',
  native: 'spans.worker.native',
  refused: 'spans.worker.refused',
});
const EVENT_TYPES = SPANS_WORKER_EVENT_TYPES;

const OPEN_STATUSES = new Set(['finalizing', 'launching', 'running']);
const LAUNCHING = new Set(['launching']);
// A fence that fails with one of these means another coordinator owns the
// attempt now; anything else (an unreadable store) writes nothing either.
const FENCED_CODES = new Set(['ATTEMPT_CLOSED', 'STALE_GENERATION']);
const OUTCOMES = Object.freeze({
  exited: 'process-exited',
  held: 'unknown',
  refused: 'not-launched',
});
const RECOVERY_REASONS = Object.freeze({
  finalizing: 'finalize-interrupted',
  launching: 'launch-unknown',
  running: 'worker-lost',
});

// Fixed text only. Adapter, store and request strings are never reflected.
const REFUSALS = {
  ACTION_BINDING_MISMATCH:
    'The action is bound to a different attempt or span.',
  ACTION_NOT_PENDING: 'The action is not waiting for its first attempt.',
  ACTION_NOT_PREPARED: 'The action intent was not saved for this run.',
  ATTEMPT_ACTIVE: 'A live worker still owns this attempt.',
  ATTEMPT_CLOSED: 'The attempt no longer accepts this callback.',
  ATTEMPT_CONFLICT: 'The attempt is already bound to different input.',
  ATTEMPT_IN_PROGRESS: 'The attempt is still being recorded; retry later.',
  ATTEMPT_NOT_ACTIVE: 'No live worker owns this attempt.',
  ATTEMPT_NOT_FOUND: 'The attempt does not exist in this run.',
  ATTEMPT_NOT_TERMINAL: 'The attempt has no terminal receipt yet.',
  BACKPRESSURE: 'Capture is full; nothing was dropped, retry the same chunk.',
  BINDING_MISMATCH: 'The callback does not match the attempt binding.',
  CANCEL_RECORD_UNCONFIRMED:
    'The cancel result was not confirmed; its effect is unknown.',
  CANCEL_UNKNOWN:
    'The cancel request was not confirmed; its effect is unknown.',
  CANCEL_UNSUPPORTED: 'The launcher cannot stop an attempt.',
  CAPTURE_FAILED: 'Capture failed; the attempt is held with a capture gap.',
  CHUNK_CONFLICT: 'The chunk sequence was already captured with other bytes.',
  CHUNK_INVALID: 'A chunk must be a non-empty string with a valid sequence.',
  CHUNK_OUT_OF_ORDER: 'The chunk sequence is not the next expected one.',
  CHUNK_TOO_LARGE: 'The chunk exceeds the chunk limit and was not captured.',
  CLOCK_INVALID: 'The clock did not return a nonnegative safe integer.',
  COMMIT_FAILED: 'The run update was not confirmed; reread before retrying.',
  DEADLINE_INVALID: 'deadlineMs must be a positive integer within the limit.',
  EXIT_CONFLICT: 'A different exit was already observed for this attempt.',
  EXIT_INVALID: 'exit must hold an integer code or a signal name.',
  FINALIZE_UNCONFIRMED:
    'The exit was not recorded; the attempt stays unresolved.',
  GENERATION_INVALID:
    'Coordinator generations must be nonnegative safe integers.',
  HOLD_UNCONFIRMED: 'The hold was not confirmed; the attempt stays unresolved.',
  ID_INVALID: 'IDs must be explicit non-empty strings.',
  LAUNCH_RECORD_UNCONFIRMED:
    'The launch was not recorded; the attempt stays unresolved.',
  LAUNCH_REFUSED: 'The launcher reported that nothing was started.',
  LAUNCH_UNKNOWN: 'The launch outcome is unknown; the attempt is held.',
  NATIVE_ID_CONFLICT: 'A different native session ID was already recorded.',
  NATIVE_ID_INVALID: 'The native session ID is not a safe explicit ID.',
  PREFLIGHT_REFUSED: 'Launch preconditions were not met; nothing started.',
  RECORD_TOO_LONG:
    'A record has no safe end within the chunk limit; the attempt is held.',
  RUN_READ_FAILED: 'The run could not be read.',
  RUN_VIEW_INVALID: 'The run view does not use the expected format.',
  SENSITIVE_VALUE: 'A value that looks like a secret was not stored.',
  SPOOL_LIMIT: 'The attempt capture limit was reached; it is held.',
  STALE_GENERATION: 'The coordinator generation is stale.',
  STALE_REVISION: 'The run changed; reread and retry explicitly.',
  TERMINAL_UNCONFIRMED:
    'The terminal receipt was not confirmed; the attempt stays unresolved.',
  WORKER_FAILED: 'The worker failed unexpectedly; the outcome is unknown.',
  WORKER_FULL: 'The worker already owns its maximum number of attempts.',
};

const isRecord = (value) =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

function refuse(code, extra = {}) {
  return { code, error: REFUSALS[code], ok: false, ...extra };
}

// Also true for an ID that redaction would treat as a secret field name, since
// attempt IDs are object keys in the stored view.
const holdsSecret = (value) =>
  typeof value === 'string' &&
  (redactValue(value) !== value || redactValue({ [value]: 0 })[value] !== 0);

const sha256 = (text) => createHash('sha256').update(text).digest('hex');

const isCount = (value) => Number.isSafeInteger(value) && value >= 0;
const isPositive = (value) => Number.isSafeInteger(value) && value > 0;

function isExplicitId(value) {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > MAX_ID_LENGTH ||
    value.trim() !== value ||
    value === '__proto__'
  ) {
    return false;
  }
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 32 || code === 127) {
      return false;
    }
  }
  return true;
}

// Adapter-supplied codes are shown only when they look like a plain constant.
const safeCode = (value) =>
  typeof value === 'string' && ADAPTER_CODE_PATTERN.test(value) ? value : null;

function ownEntry(table, key) {
  return Object.hasOwn(table, key) && isRecord(table[key]) ? table[key] : null;
}

// ---------------------------------------------------------------------------
// Request parsing
// ---------------------------------------------------------------------------

function parseIds(input, names) {
  if (!isRecord(input)) {
    return refuse('ID_INVALID');
  }
  for (const name of names) {
    if (!isExplicitId(input[name])) {
      return refuse('ID_INVALID');
    }
  }
  if (!isCount(input.generation)) {
    return refuse('GENERATION_INVALID');
  }
  if (names.some((name) => holdsSecret(input[name]))) {
    return refuse('SENSITIVE_VALUE');
  }
  return null;
}

function bindingOf(input) {
  return {
    actionId: input.actionId,
    attemptId: input.attemptId,
    generation: input.generation,
    runId: input.runId,
    spanId: input.spanId,
    workerId: input.workerId,
  };
}

const digestOf = (binding) =>
  sha256(
    JSON.stringify([
      'spans.worker.attempt',
      ...BINDING_FIELDS.map((field) => binding[field]),
    ])
  );

const BASE_NAMES = ['runId', 'spanId', 'actionId', 'attemptId', 'workerId'];

// A ref is the full immutable binding; callbacks and cancel must present it.
// `generation` is the attempt's own immutable one. A newer coordinator that
// recovers or cancels it also names `coordinatorGeneration`, which is the one
// fenced against the store; it defaults to the attempt's generation.
function parseRef(input, { process }) {
  const names = process ? [...BASE_NAMES, 'processStartId'] : BASE_NAMES;
  const refusal = parseIds(input, names);
  if (refusal) {
    return refusal;
  }
  const fence = input.coordinatorGeneration ?? input.generation;
  if (!isCount(fence)) {
    return refuse('GENERATION_INVALID');
  }
  return {
    binding: bindingOf(input),
    fence,
    ok: true,
    processStartId: process ? input.processStartId : null,
  };
}

function parseStart(input, workerId, limits) {
  const refusal = parseIds(input, BASE_NAMES.slice(0, 4));
  if (refusal) {
    return refusal;
  }
  if (
    !(isPositive(input.deadlineMs) && input.deadlineMs <= limits.maxDeadlineMs)
  ) {
    return refuse('DEADLINE_INVALID');
  }
  return {
    binding: bindingOf({ ...input, workerId }),
    deadlineMs: input.deadlineMs,
    ok: true,
  };
}

function parseExit(value) {
  if (!isRecord(value)) {
    return refuse('EXIT_INVALID');
  }
  const { code = null, signal = null } = value;
  const codeValid =
    code === null ||
    (Number.isSafeInteger(code) && Math.abs(code) <= MAX_EXIT_CODE);
  const signalValid =
    signal === null ||
    (typeof signal === 'string' && SIGNAL_PATTERN.test(signal));
  if (!(codeValid && signalValid) || (code === null && signal === null)) {
    return refuse('EXIT_INVALID');
  }
  return { exit: { code, signal }, ok: true };
}

const sameExit = (left, right) =>
  left.code === right.code && left.signal === right.signal;

function parseNativeId(value) {
  if (!isExplicitId(value) || holdsSecret(value)) {
    return refuse('NATIVE_ID_INVALID');
  }
  return { nativeId: value, ok: true };
}

function parseProcessStart(value) {
  if (
    !(
      isRecord(value) &&
      isExplicitId(value.id) &&
      !holdsSecret(value.id) &&
      (value.pid === undefined || isPositive(value.pid))
    )
  ) {
    return null;
  }
  return { id: value.id, pid: value.pid ?? null };
}

// ---------------------------------------------------------------------------
// Records, receipts and events
// ---------------------------------------------------------------------------

function newRecord(binding, deadlineAt, at) {
  return {
    ...binding,
    attemptDigest: digestOf(binding),
    cancel: null,
    capture: {
      artifactId: null,
      bytes: 0,
      chunks: 0,
      complete: false,
      countsConfirmed: true,
      gap: null,
    },
    deadlineAt,
    exit: null,
    intentAt: at,
    launchedAt: null,
    nativeId: null,
    processStart: null,
    reasonCode: null,
    receipt: null,
    recoveredAtGeneration: null,
    status: 'launching',
    updatedAt: at,
  };
}

function sameBinding(record, binding) {
  return (
    BINDING_FIELDS.every((field) => record[field] === binding[field]) &&
    record.attemptDigest === digestOf(binding)
  );
}

// Adapter-independent: plain JSON only, so recovery can read it without the
// launcher or spool that produced it. It never claims work was accepted, that
// ownership was released, or that a native resume is possible.
function buildReceipt(record, { at, reason }) {
  return {
    actionId: record.actionId,
    at,
    attemptDigest: record.attemptDigest,
    attemptId: record.attemptId,
    cancel: record.cancel,
    capture: { ...record.capture },
    deadlineAt: record.deadlineAt,
    exit: record.exit,
    generation: record.generation,
    kind: 'spans.worker.receipt',
    nativeId: record.nativeId,
    nativeIdState: record.nativeId === null ? 'missing' : 'recorded',
    outcome: OUTCOMES[record.status],
    ownershipReleased: false,
    processStart: record.processStart,
    reason,
    reasonCode: record.reasonCode,
    recoveredAtGeneration: record.recoveredAtGeneration,
    resumeAvailable: false,
    retryEligible: record.status === 'refused',
    runId: record.runId,
    spanId: record.spanId,
    status: record.status,
    version: 1,
    workAccepted: false,
    workerId: record.workerId,
  };
}

// One event per kind per attempt, so the identity holds no caller text and a
// repeated transition can only ever rebuild the same event ID.
function buildEvent(type, record, payload) {
  return {
    eventId: `${type}:${sha256(JSON.stringify([type, record.runId, record.attemptId]))}`,
    payload: redactValue({
      actionId: record.actionId,
      attemptId: record.attemptId,
      generation: record.generation,
      runId: record.runId,
      spanId: record.spanId,
      workerId: record.workerId,
      ...payload,
    }),
    runId: record.runId,
    type,
  };
}

function attemptsOf(view) {
  if (view.attempts === undefined) {
    view.attempts = {};
  }
  return isRecord(view.attempts) ? view.attempts : null;
}

// Finds the attempt record a mutation may act on, bound exactly.
function findRecord(view, binding) {
  const attempts = attemptsOf(view);
  if (!attempts) {
    return { refusal: refuse('RUN_VIEW_INVALID') };
  }
  const record = ownEntry(attempts, binding.attemptId);
  if (!record) {
    return { refusal: refuse('ATTEMPT_NOT_FOUND') };
  }
  if (!sameBinding(record, binding)) {
    return { refusal: refuse('BINDING_MISMATCH') };
  }
  return { attempts, record };
}

function write(view, next, type, payload, result) {
  view.attempts[next.attemptId] = next;
  return { events: [buildEvent(type, next, payload)], ok: true, result };
}

const unchanged = (result) => ({ events: [], noop: true, ok: true, result });

// ---------------------------------------------------------------------------
// Record framing
// ---------------------------------------------------------------------------

// Redaction only sees what it is given, so a secret split across two chunks
// ('sk-' + suffix, 'Authorization: Bear' + 'er ...', a key block) would be
// stored raw. Text is held, raw and in memory only, until a line boundary where
// the existing redaction appears stable under a finite set of probes:
// appending each probe must leave the redacted prefix unchanged. These probes
// are conservative checks, not a proof that every continuation is safe. They
// continue a token, a key/value separator, a quoted value and a private key
// block. Nothing held is persisted before it is redacted whole, and held text
// is bounded.
const CONTINUATION_PROBES = Object.freeze([
  'zZ0"\'\n-----END PRIVATE KEY-----',
  '=zZ0',
  ':zZ0',
]);
// At the end of the stream nothing can continue a token, so only a construct
// that stays open across whitespace (a quote, a key block) can still hide a
// secret. A quote probe must follow whitespace or it joins an unquoted token.
const STREAM_END_PROBES = Object.freeze([
  '\n-----END PRIVATE KEY-----',
  ' "',
  " '",
]);
const MAX_CUT_TRIES = 8;

function redactRecord(text) {
  try {
    return redactValue(text);
  } catch {
    return null;
  }
}

// Buffer.byteLength miscounts an unpaired surrogate in some Bun versions.
// Measuring the encoded bytes matches what Buffer/UTF-8 storage will receive,
// including the replacement byte sequence for an unpaired half.
function utf8ByteLength(text) {
  return Buffer.from(text, 'utf8').byteLength;
}

// The redacted prefix when no probe changes it, otherwise null.
function stableRedaction(prefix, probes) {
  const redacted = redactRecord(prefix);
  if (redacted === null) {
    return null;
  }
  return probes.every(
    (probe) => redactRecord(prefix + probe) === redacted + probe
  )
    ? redacted
    : null;
}

// Splits raw text into the redacted part that may be stored now and the raw
// rest that must wait. Cuts only follow a newline; a handful of earlier cuts
// are tried when the last one is inside a multi-line construct.
function frameText(text, final) {
  if (final) {
    const redacted = stableRedaction(text, STREAM_END_PROBES);
    return redacted === null
      ? { redacted: '', rest: text }
      : { redacted, rest: '' };
  }
  let end = text.lastIndexOf('\n') + 1;
  for (let tries = 0; end > 0 && tries < MAX_CUT_TRIES; tries += 1) {
    const redacted = stableRedaction(text.slice(0, end), CONTINUATION_PROBES);
    if (redacted !== null) {
      return { redacted, rest: text.slice(end) };
    }
    end = end > 1 ? text.lastIndexOf('\n', end - 2) + 1 : 0;
  }
  return { redacted: '', rest: text };
}

// Redacted text may be split anywhere on a code point, so a multibyte
// character or surrogate pair is never cut. Null when one character alone
// exceeds the limit.
function splitPieces(text, maxBytes) {
  const pieces = [];
  let piece = '';
  let size = 0;
  for (const char of text) {
    const width = utf8ByteLength(char);
    if (width > maxBytes) {
      return null;
    }
    if (size + width > maxBytes) {
      pieces.push(piece);
      piece = '';
      size = 0;
    }
    piece += char;
    size += width;
  }
  if (piece !== '') {
    pieces.push(piece);
  }
  return pieces;
}

// Pre-ready callbacks are acknowledged, not completed: the work is queued and
// runs once the launch is recorded.
const accepted = () => ({ accepted: true, ok: true, pending: true });

function existingResult(record) {
  const result = {
    attemptId: record.attemptId,
    created: false,
    ok: true,
    status: record.status,
  };
  if (OPEN_STATUSES.has(record.status)) {
    // No live worker is attached in this call: the effect keeps its owner and
    // is never a fresh intent.
    return { ...result, retryAllowed: false, unresolved: true };
  }
  return { ...result, receipt: record.receipt };
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

function requireFunctions(owner, name, required, optional = []) {
  if (!isRecord(owner)) {
    throw new TypeError(`${name} must be an object.`);
  }
  for (const method of required) {
    if (typeof owner[method] !== 'function') {
      throw new TypeError(`${name}.${method} must be a function.`);
    }
  }
  for (const method of optional) {
    if (owner[method] !== undefined && typeof owner[method] !== 'function') {
      throw new TypeError(`${name}.${method} must be a function.`);
    }
  }
}

function parseLimits(limits) {
  if (!isRecord(limits)) {
    throw new TypeError('limits must be supplied explicitly by the caller.');
  }
  const parsed = {};
  for (const name of LIMIT_NAMES) {
    if (!isPositive(limits[name])) {
      throw new TypeError(`limits.${name} must be a positive safe integer.`);
    }
    parsed[name] = limits[name];
  }
  if (
    parsed.maxChunkBytes > parsed.maxQueueBytes ||
    parsed.maxChunkBytes > parsed.maxAttemptBytes
  ) {
    throw new TypeError('limits.maxChunkBytes must fit the queue and attempt.');
  }
  return Object.freeze(parsed);
}

function parseConfig({
  clock,
  launcher,
  limits,
  preflight,
  spool,
  store,
  workerId,
}) {
  requireFunctions(store, 'store', ['readRun', 'commitRun']);
  requireFunctions(launcher, 'launcher', ['launch'], ['stop']);
  requireFunctions(spool, 'spool', ['append', 'finalize'], ['stat']);
  requireFunctions(clock, 'clock', ['now']);
  if (preflight !== undefined && typeof preflight !== 'function') {
    throw new TypeError('preflight must be a function.');
  }
  if (!isExplicitId(workerId) || holdsSecret(workerId)) {
    throw new TypeError('workerId must be an explicit ID.');
  }
  return { limits: parseLimits(limits) };
}

// ---------------------------------------------------------------------------
// Worker
// ---------------------------------------------------------------------------

export function createSpansWorker(options = {}) {
  const { clock, launcher, preflight, spool, store, workerId } = options;
  const { limits } = parseConfig(options);
  const contexts = new Map();
  let queuedBytes = 0;

  const contextKey = (binding) =>
    JSON.stringify([binding.runId, binding.attemptId]);

  // Null when the clock is unusable; callers refuse before mutating anything.
  function stamp() {
    try {
      const at = clock.now();
      return Number.isSafeInteger(at) && at >= 0 ? at : null;
    } catch {
      return null;
    }
  }

  // -------------------------------------------------------------------------
  // Store access
  // -------------------------------------------------------------------------

  async function loadRun(runId) {
    let read;
    try {
      read = await store.readRun({ runId });
    } catch {
      return refuse('RUN_READ_FAILED');
    }
    if (!(isRecord(read) && read.ok === true)) {
      return refuse('RUN_READ_FAILED');
    }
    let view;
    try {
      view = structuredClone(read.view);
    } catch {
      return refuse('RUN_VIEW_INVALID');
    }
    if (
      !(
        isRecord(view) &&
        view.runId === runId &&
        view.generation === read.generation &&
        isCount(read.revision) &&
        isRecord(view.actions)
      )
    ) {
      return refuse('RUN_VIEW_INVALID');
    }
    return {
      generation: read.generation,
      ok: true,
      revision: read.revision,
      view,
    };
  }

  async function commitRun(runId, loaded, events) {
    let result;
    try {
      result = await store.commitRun({
        events,
        expectedGeneration: loaded.generation,
        expectedRevision: loaded.revision,
        runId,
        view: redactValue(loaded.view),
      });
    } catch {
      return refuse('COMMIT_FAILED');
    }
    if (isRecord(result) && result.ok === true) {
      return { ok: true };
    }
    if (isRecord(result) && STALE_REVISION_CODES.has(result.code)) {
      return refuse('STALE_REVISION');
    }
    if (isRecord(result) && STALE_GENERATION_CODES.has(result.code)) {
      return refuse('STALE_GENERATION');
    }
    return refuse('COMMIT_FAILED');
  }

  // Reads, fences the coordinator generation, lets `build` mutate the clone,
  // and commits view and events together. Only a revision conflict rereads: the
  // build then runs again against the newer view. `build` returns a refusal, a
  // no-op, or {events, ok, result}.
  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Keep the read, fence, build, and compare-and-set retry in one transaction boundary.
  async function transact(binding, build, fence = binding.generation) {
    for (let tries = 0; tries < MAX_COMMIT_TRIES; tries += 1) {
      const loaded =
        // biome-ignore lint/performance/noAwaitInLoops: A stale revision requires a fresh read and a sequential rebuild before retrying.
        await loadRun(binding.runId);
      if (!loaded.ok) {
        return loaded;
      }
      if (loaded.generation !== fence) {
        return refuse('STALE_GENERATION');
      }
      const at = stamp();
      if (at === null) {
        return refuse('CLOCK_INVALID');
      }
      const built = build(loaded.view, at);
      if (!built.ok) {
        return built;
      }
      if (built.noop) {
        return { ok: true, ...built.result };
      }
      const committed = await commitRun(binding.runId, loaded, built.events);
      if (committed.code === 'STALE_REVISION') {
        continue;
      }
      return committed.ok ? { ok: true, ...built.result } : committed;
    }
    return refuse('STALE_REVISION');
  }

  // A stale generation fences the whole attempt: this worker stops capturing
  // and committing, and the newer coordinator reconciles it from the record.
  function fenceOut(ctx) {
    ctx.closed = true;
    ctx.holding = true;
    release(ctx);
  }

  async function transactFor(ctx, build) {
    const result = await transact(ctx.binding, build);
    if (!result.ok && result.code === 'STALE_GENERATION') {
      fenceOut(ctx);
    }
    return result;
  }

  // Rereads the durable run right before an effect: the generation must still
  // be the attempt's own and the record still bound to it in an allowed
  // status (a successor that recovered it has held it). This narrows the race
  // but cannot close it; the effect adapters get the same fence to enforce it.
  async function fenceAttempt(ctx, statuses) {
    const loaded = await loadRun(ctx.binding.runId);
    if (!loaded.ok) {
      return loaded;
    }
    if (loaded.generation !== ctx.binding.generation) {
      return refuse('STALE_GENERATION');
    }
    const attempts = attemptsOf(loaded.view);
    const record = attempts ? ownEntry(attempts, ctx.binding.attemptId) : null;
    return record &&
      sameBinding(record, ctx.binding) &&
      statuses.has(record.status)
      ? { ok: true }
      : refuse('ATTEMPT_CLOSED');
  }

  // -------------------------------------------------------------------------
  // Context
  // -------------------------------------------------------------------------

  function makeContext(binding, deadlineAt) {
    let markReady;
    const ready = new Promise((resolve) => {
      markReady = resolve;
    });
    return {
      attemptDigest: digestOf(binding),
      binding,
      bytes: 0,
      chain: ready,
      chunks: 0,
      closed: false,
      deadlineAt,
      // Spooled records (redacted) by sequence; `inputs` are the digests of
      // the raw chunks the caller sent, which is what a retry is matched on.
      digests: [],
      // Callbacks accepted before the launch was recorded; they drain after.
      early: { bytes: 0, chunks: 0, touched: false },
      exit: null,
      exitResult: null,
      finished: null,
      holding: false,
      holdResult: null,
      inputs: [],
      markReady,
      nativeClaim: null,
      // First native ID observed, kept even if it could not be recorded.
      nativeSeen: null,
      nextSeq: 0,
      // Spool progress of a chunk interrupted by a retryable answer.
      partial: null,
      // Raw text waiting for a safe record end. Memory only, never persisted.
      pending: '',
      processStartId: null,
      ready,
      status: 'intent',
    };
  }

  function release(ctx) {
    if (contexts.get(contextKey(ctx.binding)) === ctx) {
      contexts.delete(contextKey(ctx.binding));
    }
  }

  // Jobs on one chain run strictly in call order; every spool call and counter
  // update for an attempt goes through it.
  function serial(ctx, job) {
    const run = ctx.chain
      .then(job)
      .catch(() => refuse('WORKER_FAILED', { unknown: true }));
    ctx.chain = run;
    return run;
  }

  function authorize(ctx, ref) {
    const matches =
      BINDING_FIELDS.filter((field) => field !== 'generation').every(
        (field) => ref.binding[field] === ctx.binding[field]
      ) && ref.processStartId === ctx.processStartId;
    if (!matches) {
      return refuse('BINDING_MISMATCH');
    }
    if (ref.binding.generation !== ctx.binding.generation) {
      return refuse('STALE_GENERATION');
    }
    return null;
  }

  // -------------------------------------------------------------------------
  // Spool access: an exception or a malformed answer is never success.
  // -------------------------------------------------------------------------

  async function callSpool(method, payload) {
    try {
      const result = await spool[method](payload);
      return isRecord(result) ? result : { ok: false };
    } catch {
      return { ok: false };
    }
  }

  async function spoolStat(attemptDigest) {
    if (typeof spool.stat !== 'function') {
      return null;
    }
    const stat = await callSpool('stat', { attemptDigest });
    return stat.ok === true && isCount(stat.bytes) && isCount(stat.chunks)
      ? { bytes: stat.bytes, chunks: stat.chunks }
      : null;
  }

  const finalizePayload = (ctx, complete) => ({
    attemptDigest: ctx.attemptDigest,
    bytes: ctx.bytes,
    chainDigest: sha256(ctx.digests.join('\n')),
    chunks: ctx.chunks,
    complete,
  });

  // The effect boundary. The attempt is fenced against the durable record
  // right before the spool is called, and the spool receives the immutable
  // binding and generation so it can refuse a superseded writer itself. A
  // fenced-out attempt stops here and writes nothing; an unreadable store is
  // reported as a retryable spool answer because nothing was written.
  async function spoolEffect(ctx, method, payload) {
    const fenced = await fenceAttempt(ctx, OPEN_STATUSES);
    if (!fenced.ok) {
      if (FENCED_CODES.has(fenced.code)) {
        fenceOut(ctx);
        return { refusal: fenced };
      }
      return { refusal: null, result: { ok: false, retryable: true } };
    }
    return {
      refusal: null,
      result: await callSpool(method, {
        ...payload,
        attemptDigest: ctx.attemptDigest,
        binding: { ...ctx.binding },
        generation: ctx.binding.generation,
      }),
    };
  }

  // {artifactId}, {refusal} when fenced out, or null when the flush failed.
  async function finalizeSpool(ctx, complete) {
    const effect = await spoolEffect(
      ctx,
      'finalize',
      finalizePayload(ctx, complete)
    );
    if (effect.refusal) {
      return effect;
    }
    const { result } = effect;
    return result.ok === true && ARTIFACT_ID_PATTERN.test(result.artifactId)
      ? { artifactId: result.artifactId }
      : null;
  }

  // -------------------------------------------------------------------------
  // Hold: explicit unknown outcome with a receipt. Nothing is inferred and the
  // process is not touched; no stop policy is approved.
  // -------------------------------------------------------------------------

  // `known` carries identity already observed but not yet durable, such as the
  // process start of a launch whose record write was not confirmed.
  async function holdJob(ctx, reason, known = {}) {
    if (ctx.finished) {
      return ctx.finished;
    }
    ctx.holding = true;
    ctx.closed = true;
    let artifactId = null;
    if (ctx.chunks > 0 && reason !== 'finalize-failed') {
      artifactId = (await finalizeSpool(ctx, false))?.artifactId ?? null;
    }
    // Whatever was never persisted is named in the gap: raw text still waiting
    // for a safe record end, and callbacks accepted before a launch that was
    // never recorded. Holding capture is not enforcement; the process is not
    // touched and may still be running.
    const gap = { fromSeq: ctx.nextSeq, reason };
    const pendingBytes = utf8ByteLength(ctx.pending);
    if (pendingBytes > 0) {
      gap.pendingBytes = pendingBytes;
    }
    if (ctx.status === 'launching' && ctx.early.chunks > 0) {
      gap.unpersistedBytes = ctx.early.bytes;
      gap.unpersistedChunks = ctx.early.chunks;
    }
    // The ID the launch answer contradicted is kept beside the first one, which
    // stays the recorded identity.
    if (known.conflictNativeId) {
      gap.conflictingNativeId = known.conflictNativeId;
    }
    ctx.pending = '';
    const result = await transactFor(ctx, (view, at) => {
      const found = findRecord(view, ctx.binding);
      if (!found.record) {
        return found.refusal;
      }
      const { record } = found;
      if (!OPEN_STATUSES.has(record.status)) {
        return unchanged({
          duplicate: true,
          held: record.status === 'held',
          receipt: record.receipt,
          status: record.status,
        });
      }
      const next = {
        ...record,
        capture: {
          artifactId: artifactId ?? record.capture.artifactId,
          bytes: ctx.bytes,
          chunks: ctx.chunks,
          complete: false,
          countsConfirmed: true,
          gap,
        },
        launchedAt: record.launchedAt ?? known.launchedAt ?? null,
        nativeId: record.nativeId ?? known.nativeId ?? ctx.nativeSeen ?? null,
        processStart: record.processStart ?? known.processStart ?? null,
        status: 'held',
        updatedAt: at,
      };
      next.receipt = buildReceipt(next, { at, reason });
      return write(
        view,
        next,
        EVENT_TYPES.held,
        { receipt: next.receipt },
        { held: true, receipt: next.receipt, status: 'held' }
      );
    });
    ctx.finished = result.ok
      ? result
      : refuse('HOLD_UNCONFIRMED', {
          cause: result.code,
          reason,
          unknown: true,
        });
    release(ctx);
    return ctx.finished;
  }

  function holdFor(ctx, reason) {
    if (ctx.holdResult) {
      return ctx.holdResult;
    }
    ctx.holding = true;
    ctx.holdResult = serial(ctx, () => holdJob(ctx, reason));
    return ctx.holdResult;
  }

  // -------------------------------------------------------------------------
  // Start
  // -------------------------------------------------------------------------

  function intentBuild(binding, deadlineMs) {
    // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Intent validation and its durable record must stay together in the transaction builder.
    return (view, at) => {
      const attempts = attemptsOf(view);
      if (!attempts) {
        return refuse('RUN_VIEW_INVALID');
      }
      const existing = ownEntry(attempts, binding.attemptId);
      if (existing) {
        return sameBinding(existing, binding)
          ? unchanged(existingResult(existing))
          : refuse('ATTEMPT_CONFLICT');
      }
      const action = ownEntry(view.actions, binding.actionId);
      if (!action) {
        return refuse('ACTION_NOT_PREPARED');
      }
      if (
        action.attemptId !== binding.attemptId ||
        action.spanId !== binding.spanId
      ) {
        return refuse('ACTION_BINDING_MISMATCH');
      }
      if (action.state !== 'intent') {
        return refuse('ACTION_NOT_PENDING');
      }
      const deadlineAt = at + deadlineMs;
      if (!Number.isSafeInteger(deadlineAt)) {
        return refuse('DEADLINE_INVALID');
      }
      const record = newRecord(binding, deadlineAt, at);
      return write(
        view,
        record,
        EVENT_TYPES.intent,
        { attemptDigest: record.attemptDigest, deadlineAt },
        { created: true, deadlineAt, status: 'launching' }
      );
    };
  }

  async function runPreflight(binding) {
    if (!preflight) {
      return true;
    }
    try {
      const result = await preflight({ binding: { ...binding } });
      return isRecord(result) && result.ok === true;
    } catch {
      return false;
    }
  }

  // While the launch is unrecorded a chunk or exit is validated and bounded,
  // queued behind the launch, and acknowledged at once, so a launcher that
  // awaits the sink before returning cannot wait on the very launch it is in.
  // A native ID is the exception: it is written to the open `launching` record
  // before it is acknowledged (see earlyNative). Anything that cannot be
  // accepted is refused at once (BACKPRESSURE is retryable); nothing accepted
  // is dropped silently before the launch outcome is known.
  function makeSink(ctx) {
    const early = () => ctx.status === 'launching' && !ctx.closed;
    return Object.freeze({
      chunk: (text) => acceptChunk(ctx, undefined, text, early()),
      exit: (exit) => exitFor(ctx, exit, early()),
      native: (nativeId) =>
        early() ? earlyNative(ctx, nativeId) : nativeFor(ctx, nativeId),
    });
  }

  async function callLauncher(ctx) {
    try {
      return await launcher.launch({
        attemptDigest: ctx.attemptDigest,
        binding: { ...ctx.binding },
        deadlineAt: ctx.deadlineAt,
        // The coordinator generation this call was fenced at. The adapter
        // should present it to its own effect boundary: the worker's recheck
        // right before the call cannot close the race alone.
        fence: Object.freeze({
          attemptDigest: ctx.attemptDigest,
          generation: ctx.binding.generation,
        }),
        generation: ctx.binding.generation,
        idempotencyKey: ctx.attemptDigest,
        sink: makeSink(ctx),
      });
    } catch {
      // A thrown launch is an unknown outcome; the caller classifies the
      // missing answer and nothing the adapter threw is reflected.
    }
  }

  function classifyLaunch(result) {
    if (!isRecord(result)) {
      return { kind: 'unknown' };
    }
    if (result.ok === false && result.launched === false) {
      return { adapterCode: safeCode(result.code), kind: 'refused' };
    }
    const processStart =
      result.ok === true ? parseProcessStart(result.processStart) : null;
    if (!processStart) {
      return { kind: 'unknown' };
    }
    const native =
      result.nativeId === undefined ? null : parseNativeId(result.nativeId);
    return {
      kind: 'running',
      nativeId: native?.ok ? native.nativeId : null,
      processStart,
    };
  }

  // The adapter was called, so every path out of here that is not a proven
  // refusal keeps the attempt open or held; none is a clean failure.
  function endLaunch(ctx) {
    ctx.closed = true;
    ctx.holding = true;
    ctx.markReady();
  }

  async function recordRefusal(ctx, adapterCode) {
    endLaunch(ctx);
    const result = await transactFor(ctx, (view, at) => {
      const found = findRecord(view, ctx.binding);
      if (!found.record) {
        return found.refusal;
      }
      if (found.record.status !== 'launching') {
        return refuse('ATTEMPT_CLOSED');
      }
      const next = {
        ...found.record,
        reasonCode: adapterCode,
        status: 'refused',
        updatedAt: at,
      };
      next.receipt = buildReceipt(next, { at, reason: 'launch-refused' });
      return write(
        view,
        next,
        EVENT_TYPES.refused,
        { receipt: next.receipt },
        { receipt: next.receipt }
      );
    });
    release(ctx);
    return refuse('LAUNCH_REFUSED', {
      launched: false,
      receipt: result.ok ? result.receipt : null,
      recorded: result.ok,
    });
  }

  function runningBuild(ctx, launch) {
    return (view, at) => {
      const found = findRecord(view, ctx.binding);
      if (!found.record) {
        return found.refusal;
      }
      if (found.record.status !== 'launching') {
        return refuse('ATTEMPT_CLOSED');
      }
      // The first identity wins: the durable one, else the one already seen
      // (possibly not yet durable). A launch answer that contradicts it is never
      // written over it and never ignored; the caller holds the attempt.
      const first = found.record.nativeId ?? ctx.nativeSeen;
      if (
        launch.nativeId !== null &&
        first !== null &&
        first !== launch.nativeId
      ) {
        return refuse('NATIVE_ID_CONFLICT');
      }
      const next = {
        ...found.record,
        launchedAt: at,
        nativeId: found.record.nativeId ?? launch.nativeId,
        processStart: launch.processStart,
        status: 'running',
        updatedAt: at,
      };
      return write(
        view,
        next,
        EVENT_TYPES.launched,
        { nativeId: next.nativeId, processStart: next.processStart },
        { nativeId: next.nativeId }
      );
    };
  }

  // The process was started but the launch cannot be recorded as running, so
  // the attempt is held with the identity observed so far.
  async function holdLaunched(ctx, launch, code, reason, known) {
    endLaunch(ctx);
    const held = await holdJob(ctx, reason, {
      launchedAt: stamp(),
      processStart: launch.processStart,
      ...known,
    });
    return refuse(code, {
      held: held.ok === true,
      launched: true,
      receipt: held.ok ? held.receipt : null,
      unknown: true,
    });
  }

  async function recordRunning(ctx, launch) {
    const result = await transactFor(ctx, runningBuild(ctx, launch));
    if (!result.ok && result.code === 'NATIVE_ID_CONFLICT') {
      return holdLaunched(
        ctx,
        launch,
        'NATIVE_ID_CONFLICT',
        'native-id-conflict',
        { conflictNativeId: launch.nativeId, nativeId: ctx.nativeSeen }
      );
    }
    if (!result.ok) {
      return holdLaunched(
        ctx,
        launch,
        'LAUNCH_RECORD_UNCONFIRMED',
        'launch-record-unconfirmed',
        { nativeId: launch.nativeId }
      );
    }
    ctx.processStartId = launch.processStart.id;
    ctx.status = 'running';
    // An ID the provider reported during launch keeps its earlier claim. The
    // durable ID is reported, which is the first one recorded.
    const { nativeId } = result;
    if (nativeId !== null && ctx.nativeClaim === null) {
      ctx.nativeClaim = {
        id: nativeId,
        promise: Promise.resolve({ nativeId, ok: true }),
      };
    }
    ctx.markReady();
    return {
      attemptId: ctx.binding.attemptId,
      created: true,
      nativeId,
      ok: true,
      processStart: launch.processStart,
      ref: {
        ...ctx.binding,
        processStartId: launch.processStart.id,
      },
      status: 'running',
    };
  }

  async function launchAttempt(ctx) {
    ctx.status = 'launching';
    // Takeover after the saved intent: recheck the durable generation and
    // record right before the effect. A fenced-out worker never calls the
    // launcher; the record stays `launching` for the owner to reconcile.
    const fenced = await fenceAttempt(ctx, LAUNCHING);
    if (!fenced.ok) {
      endLaunch(ctx);
      release(ctx);
      return refuse(fenced.code, { launched: false });
    }
    const launch = classifyLaunch(await callLauncher(ctx));
    // A refusal that came with sink activity contradicts itself: something
    // ran, so it is unknown, not a retry-eligible non-launch.
    if (launch.kind === 'refused' && !ctx.early.touched) {
      return recordRefusal(ctx, launch.adapterCode);
    }
    if (launch.kind === 'running') {
      return recordRunning(ctx, launch);
    }
    // Thrown, malformed or ambiguous: the process may exist.
    endLaunch(ctx);
    const held = await holdJob(ctx, 'launch-unknown');
    return refuse('LAUNCH_UNKNOWN', {
      held: held.ok === true,
      launched: 'unknown',
      receipt: held.ok ? held.receipt : null,
      unknown: true,
    });
  }

  async function start(input) {
    const request = parseStart(input, workerId, limits);
    if (!request.ok) {
      return request;
    }
    const { binding } = request;
    const existingContext = contexts.get(contextKey(binding));
    if (existingContext) {
      if (existingContext.attemptDigest !== digestOf(binding)) {
        return refuse('ATTEMPT_CONFLICT');
      }
      return existingContext.status === 'intent'
        ? refuse('ATTEMPT_IN_PROGRESS')
        : {
            attemptId: binding.attemptId,
            created: false,
            ok: true,
            status: existingContext.status,
          };
    }
    if (contexts.size >= limits.maxActiveAttempts) {
      return refuse('WORKER_FULL');
    }
    const ctx = makeContext(binding, null);
    contexts.set(contextKey(binding), ctx);
    try {
      if (!(await runPreflight(binding))) {
        release(ctx);
        return refuse('PREFLIGHT_REFUSED');
      }
      // The exact intent is durable before the launcher is ever called.
      const intent = await transactFor(
        ctx,
        intentBuild(binding, request.deadlineMs)
      );
      if (!intent.ok || intent.created !== true) {
        release(ctx);
        return intent;
      }
      ctx.deadlineAt = intent.deadlineAt;
      return await launchAttempt(ctx);
    } catch {
      // Whatever happened, the launcher may have been reached: keep it unknown.
      endLaunch(ctx);
      release(ctx);
      return refuse('WORKER_FAILED', { unknown: true });
    }
  }

  // -------------------------------------------------------------------------
  // Capture
  // -------------------------------------------------------------------------

  async function recordTooLong(ctx) {
    const held = await holdJob(ctx, 'record-too-long');
    return refuse('RECORD_TOO_LONG', { held: held.ok === true });
  }

  // Stores one redacted record. `retryable` says whether a caller is waiting on
  // the answer and can resend: only then is a retryable spool answer passed
  // back; an accepted-and-gone chunk has nobody to retry it, so it is held.
  async function appendPiece(ctx, seq, text, retryable) {
    const digest = sha256(text);
    const bytes = utf8ByteLength(text);
    if (seq < ctx.nextSeq) {
      return ctx.digests[seq] === digest
        ? { ok: true }
        : refuse('CHUNK_CONFLICT');
    }
    if (
      ctx.chunks + 1 > limits.maxAttemptChunks ||
      ctx.bytes + bytes > limits.maxAttemptBytes
    ) {
      const held = await holdJob(ctx, 'spool-limit');
      return refuse('SPOOL_LIMIT', { held: held.ok === true });
    }
    const effect = await spoolEffect(ctx, 'append', {
      bytes,
      digest,
      seq,
      text,
    });
    if (effect.refusal) {
      return effect.refusal;
    }
    if (effect.result.ok === true) {
      ctx.digests.push(digest);
      ctx.nextSeq += 1;
      ctx.chunks += 1;
      ctx.bytes += bytes;
      return { ok: true };
    }
    if (
      retryable &&
      effect.result.ok === false &&
      effect.result.retryable === true
    ) {
      return refuse('BACKPRESSURE', { retryable: true });
    }
    const held = await holdJob(ctx, 'capture-failed');
    return refuse('CAPTURE_FAILED', { held: held.ok === true });
  }

  // One caller chunk, framed on the attempt's chain so a retry sees exactly the
  // state the failed call saw. `seq` numbers the caller's chunks; the spool
  // sequence numbers the redacted records they produced, and a retry after a
  // partial write resumes at the same spool sequences, which the spool must
  // treat as idempotent on (attempt, seq, digest).
  async function appendJob(ctx, input) {
    if (ctx.closed) {
      return refuse('ATTEMPT_CLOSED');
    }
    const seq = input.seq ?? ctx.inputs.length;
    if (seq < ctx.inputs.length) {
      return ctx.inputs[seq] === input.digest
        ? { duplicate: true, ok: true, seq }
        : refuse('CHUNK_CONFLICT');
    }
    if (seq > ctx.inputs.length) {
      return refuse('CHUNK_OUT_OF_ORDER', { expectedSeq: ctx.inputs.length });
    }
    const text = ctx.pending + input.text;
    const framed = frameText(text, false);
    const pieces = splitPieces(framed.redacted, limits.maxChunkBytes);
    if (pieces === null || utf8ByteLength(framed.rest) > limits.maxChunkBytes) {
      // No safe record end within the bound. Nothing is truncated or stored.
      ctx.pending = text;
      return recordTooLong(ctx);
    }
    const base = ctx.partial?.seq === seq ? ctx.partial.base : ctx.nextSeq;
    ctx.partial = { base, seq };
    for (const [index, piece] of pieces.entries()) {
      const outcome =
        // biome-ignore lint/performance/noAwaitInLoops: Spool records must commit in their assigned sequence, and each failure decides whether the next piece can proceed.
        await appendPiece(ctx, base + index, piece, input.retryable);
      if (!outcome.ok) {
        return outcome;
      }
    }
    ctx.partial = null;
    ctx.pending = framed.rest;
    ctx.inputs.push(input.digest);
    return {
      duplicate: false,
      ok: true,
      pendingBytes: utf8ByteLength(ctx.pending),
      seq,
    };
  }

  // After the process exit nothing can follow, so the remaining text is
  // redacted whole. Only an unterminated quote or key block is withheld, never
  // stored raw, and the capture is then marked incomplete with the gap named.
  async function flushTail(ctx) {
    if (ctx.pending === '') {
      return { complete: true, gap: null, ok: true };
    }
    const framed = frameText(ctx.pending, true);
    const pieces = splitPieces(framed.redacted, limits.maxChunkBytes);
    if (pieces === null) {
      return { ok: false, refusal: await recordTooLong(ctx) };
    }
    for (const piece of pieces) {
      const outcome =
        // biome-ignore lint/performance/noAwaitInLoops: The terminal flush must persist records in sequence before finalizing.
        await appendPiece(ctx, ctx.nextSeq, piece, false);
      if (!outcome.ok) {
        return { ok: false, refusal: outcome };
      }
    }
    const withheld = framed.rest !== '';
    const gap = withheld
      ? {
          fromSeq: ctx.nextSeq,
          pendingBytes: utf8ByteLength(framed.rest),
          reason: 'unterminated-record',
        }
      : null;
    ctx.pending = '';
    return { complete: !withheld, gap, ok: true };
  }

  // The caller's chunk is bounded raw (maxChunkBytes) before anything scans it,
  // and the raw bytes in flight are bounded by maxQueueBytes; a full queue
  // refuses with a retryable BACKPRESSURE and consumes nothing. Held raw text
  // is at most maxChunkBytes per attempt. `early` acknowledges instead of
  // waiting for the result (see makeSink).
  // biome-ignore lint/suspicious/useAwait: This boundary always returns a Promise, including immediate early acknowledgments.
  async function acceptChunk(ctx, seq, text, early = false) {
    if (ctx.closed || ctx.holding || ctx.exit) {
      return refuse('ATTEMPT_CLOSED');
    }
    if (
      typeof text !== 'string' ||
      text.length === 0 ||
      (seq !== undefined && !isCount(seq))
    ) {
      return refuse('CHUNK_INVALID');
    }
    const bytes = utf8ByteLength(text);
    if (bytes > limits.maxChunkBytes) {
      return refuse('CHUNK_TOO_LARGE');
    }
    if (queuedBytes + bytes > limits.maxQueueBytes) {
      return refuse('BACKPRESSURE', { retryable: true });
    }
    queuedBytes += bytes;
    if (early) {
      ctx.early.bytes += bytes;
      ctx.early.chunks += 1;
      ctx.early.touched = true;
    }
    const done = serial(ctx, () =>
      appendJob(ctx, { digest: sha256(text), retryable: !early, seq, text })
    ).finally(() => {
      queuedBytes -= bytes;
    });
    return early ? accepted() : done;
  }

  // -------------------------------------------------------------------------
  // Native session identity: persisted as soon as first observed.
  // -------------------------------------------------------------------------

  async function persistNative(ctx, nativeId) {
    const result = await transactFor(ctx, (view, at) => {
      const found = findRecord(view, ctx.binding);
      if (!found.record) {
        return found.refusal;
      }
      const { record } = found;
      if (!OPEN_STATUSES.has(record.status)) {
        return refuse('ATTEMPT_CLOSED');
      }
      if (record.nativeId !== null) {
        return record.nativeId === nativeId
          ? unchanged({ duplicate: true, nativeId })
          : refuse('NATIVE_ID_CONFLICT');
      }
      const next = { ...record, nativeId, updatedAt: at };
      return write(
        view,
        next,
        EVENT_TYPES.native,
        { nativeId },
        { duplicate: false, nativeId }
      );
    });
    return result;
  }

  async function nativeFor(ctx, value) {
    const parsed = parseNativeId(value);
    if (!parsed.ok) {
      return parsed;
    }
    const { nativeId } = parsed;
    if (ctx.nativeClaim) {
      if (ctx.nativeClaim.id !== nativeId) {
        return refuse('NATIVE_ID_CONFLICT');
      }
      const settled = await ctx.nativeClaim.promise;
      return settled.ok ? { ...settled, duplicate: true } : settled;
    }
    ctx.nativeSeen ??= nativeId;
    // Never waits for the launch to finish: the write goes through the same
    // fenced read/compare-and-set as every other record change, against the
    // `launching` record while the launch is still open. The claim is taken
    // before the first await, so a repeat of the ID joins this write.
    const promise = ctx.closed
      ? Promise.resolve(refuse('ATTEMPT_CLOSED'))
      : persistNative(ctx, nativeId);
    ctx.nativeClaim = { id: nativeId, promise };
    const result = await promise;
    if (!result.ok && ctx.nativeClaim?.promise === promise) {
      // Nothing was recorded, so the provider may report it again.
      ctx.nativeClaim = null;
    }
    return result;
  }

  // Before the launch is recorded: claim the ID synchronously (a different one
  // is refused at once) and answer only once it is durable on the `launching`
  // record, or with the refusal if the write was not confirmed (the provider
  // may report it again). Unlike chunk and exit this is not a queued
  // acknowledgment, yet it cannot deadlock a launcher that awaits it: it needs
  // the store only, never the launch result. The ID stays in nativeSeen, so a
  // launch that ends held still carries it.
  async function earlyNative(ctx, value) {
    const parsed = parseNativeId(value);
    if (!parsed.ok) {
      return parsed;
    }
    if (ctx.nativeClaim && ctx.nativeClaim.id !== parsed.nativeId) {
      return refuse('NATIVE_ID_CONFLICT');
    }
    ctx.early.touched = true;
    try {
      return await nativeFor(ctx, parsed.nativeId);
    } catch {
      return refuse('WORKER_FAILED', { unknown: true });
    }
  }

  // -------------------------------------------------------------------------
  // Exit and terminal flush
  // -------------------------------------------------------------------------

  // The record could not be advanced, so it stays at its last durable status
  // for recovery. A record that was already closed (for example held by a newer
  // coordinator) is not unresolved: the late callback is simply inert.
  function unresolved(ctx, code, cause) {
    ctx.closed = true;
    ctx.finished =
      cause.code === 'ATTEMPT_CLOSED'
        ? cause
        : refuse(code, { cause: cause.code, unknown: true });
    release(ctx);
    return ctx.finished;
  }

  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Keep the terminal flush, finalizing event, artifact, and outcome commit in one ordered transition.
  async function finalizeJob(ctx) {
    if (ctx.finished) {
      return ctx.finished;
    }
    if (ctx.closed) {
      return refuse('ATTEMPT_CLOSED');
    }
    const { exit } = ctx;
    // An ID reported just before the exit is recorded before the terminal write.
    if (ctx.nativeClaim) {
      await ctx.nativeClaim.promise;
    }
    const finalizing = await transactFor(ctx, (view, at) => {
      const found = findRecord(view, ctx.binding);
      if (!found.record) {
        return found.refusal;
      }
      if (found.record.status !== 'running') {
        return refuse('ATTEMPT_CLOSED');
      }
      const next = {
        ...found.record,
        capture: {
          ...found.record.capture,
          bytes: ctx.bytes,
          chunks: ctx.chunks,
        },
        exit,
        nativeId: found.record.nativeId ?? ctx.nativeSeen,
        status: 'finalizing',
        updatedAt: at,
      };
      return write(view, next, EVENT_TYPES.finalizing, { exit }, {});
    });
    if (!finalizing.ok) {
      return unresolved(ctx, 'FINALIZE_UNCONFIRMED', finalizing);
    }
    // The exit is durable. The text still waiting for a record end is flushed
    // (or withheld and named), then every captured record is flushed into the
    // artifact before the receipt.
    const tail = await flushTail(ctx);
    if (!tail.ok) {
      return FENCED_CODES.has(tail.refusal.code)
        ? unresolved(ctx, 'FINALIZE_UNCONFIRMED', tail.refusal)
        : tail.refusal;
    }
    const flushed = await finalizeSpool(ctx, tail.complete);
    if (flushed?.refusal) {
      return unresolved(ctx, 'FINALIZE_UNCONFIRMED', flushed.refusal);
    }
    if (flushed === null) {
      const held = await holdJob(ctx, 'finalize-failed');
      return refuse('CAPTURE_FAILED', {
        held: held.ok === true,
        receipt: held.ok ? held.receipt : null,
      });
    }
    const { artifactId } = flushed;
    const exited = await transactFor(ctx, (view, at) => {
      const found = findRecord(view, ctx.binding);
      if (!found.record) {
        return found.refusal;
      }
      if (found.record.status !== 'finalizing') {
        return refuse('ATTEMPT_CLOSED');
      }
      const next = {
        ...found.record,
        capture: {
          artifactId,
          bytes: ctx.bytes,
          chunks: ctx.chunks,
          complete: tail.complete,
          countsConfirmed: true,
          gap: tail.gap,
        },
        status: 'exited',
        updatedAt: at,
      };
      next.receipt = buildReceipt(next, { at, reason: 'process-exited' });
      return write(
        view,
        next,
        EVENT_TYPES.exited,
        { receipt: next.receipt },
        { receipt: next.receipt, status: 'exited' }
      );
    });
    if (!exited.ok) {
      return unresolved(ctx, 'TERMINAL_UNCONFIRMED', exited);
    }
    ctx.closed = true;
    ctx.finished = exited;
    release(ctx);
    return exited;
  }

  function exitFor(ctx, value, early = false) {
    const parsed = parseExit(value);
    if (!parsed.ok) {
      return Promise.resolve(parsed);
    }
    if (ctx.exit) {
      if (!sameExit(ctx.exit, parsed.exit)) {
        return Promise.resolve(refuse('EXIT_CONFLICT'));
      }
      return early
        ? Promise.resolve(accepted())
        : ctx.exitResult.then((result) =>
            result.ok ? { ...result, duplicate: true } : result
          );
    }
    if (ctx.closed || ctx.holding) {
      return Promise.resolve(refuse('ATTEMPT_CLOSED'));
    }
    ctx.exit = parsed.exit;
    ctx.exitResult = serial(ctx, () => finalizeJob(ctx)).then((result) =>
      result.ok ? { ...result, duplicate: false } : result
    );
    if (early) {
      ctx.early.touched = true;
      return Promise.resolve(accepted());
    }
    return ctx.exitResult;
  }

  // A callback that finds no live worker may still be a duplicate of what the
  // record already holds; anything else is inert.
  async function storedDuplicate(ref, matches) {
    const loaded = await loadRun(ref.binding.runId);
    if (!loaded.ok) {
      return refuse('ATTEMPT_NOT_ACTIVE');
    }
    const attempts = attemptsOf(loaded.view);
    const record = attempts ? ownEntry(attempts, ref.binding.attemptId) : null;
    if (
      record &&
      sameBinding(record, ref.binding) &&
      record.processStart?.id === ref.processStartId &&
      matches(record)
    ) {
      return { duplicate: true, ok: true, status: record.status };
    }
    return refuse('ATTEMPT_NOT_ACTIVE');
  }

  // Resolves the live worker for a direct callback, or says why it is inert.
  async function resolveCallback(input) {
    const ref = parseRef(input, { process: true });
    if (!ref.ok) {
      return { refusal: ref };
    }
    const ctx = contexts.get(contextKey(ref.binding));
    if (!ctx) {
      return { ref };
    }
    await ctx.ready;
    const denied = authorize(ctx, ref);
    return denied ? { refusal: denied } : { ctx, ref };
  }

  async function captureChunk(input) {
    const { ctx, refusal } = await resolveCallback(input);
    if (refusal) {
      return refusal;
    }
    return ctx
      ? acceptChunk(ctx, input.seq, input.text)
      : refuse('ATTEMPT_NOT_ACTIVE');
  }

  async function observeNative(input) {
    const { ctx, ref, refusal } = await resolveCallback(input);
    if (refusal) {
      return refusal;
    }
    if (ctx) {
      return nativeFor(ctx, input.nativeId);
    }
    const parsed = parseNativeId(input.nativeId);
    return parsed.ok
      ? storedDuplicate(ref, (record) => record.nativeId === parsed.nativeId)
      : parsed;
  }

  async function observeExit(input) {
    const { ctx, ref, refusal } = await resolveCallback(input);
    if (refusal) {
      return refusal;
    }
    if (ctx) {
      return exitFor(ctx, input.exit);
    }
    const parsed = parseExit(input.exit);
    return parsed.ok
      ? storedDuplicate(
          ref,
          (record) => record.exit !== null && sameExit(record.exit, parsed.exit)
        )
      : parsed;
  }

  // -------------------------------------------------------------------------
  // Deadline
  // -------------------------------------------------------------------------

  async function enforceCtxDeadline(ctx) {
    const now = stamp();
    if (now === null) {
      return refuse('CLOCK_INVALID');
    }
    if (now < ctx.deadlineAt) {
      return { expired: false, ok: true, remainingMs: ctx.deadlineAt - now };
    }
    return { ...(await holdFor(ctx, 'deadline')), expired: true };
  }

  async function enforceDeadline(input) {
    const { ctx, refusal } = await resolveCallback(input);
    if (refusal) {
      return refusal;
    }
    return ctx ? enforceCtxDeadline(ctx) : refuse('ATTEMPT_NOT_ACTIVE');
  }

  async function enforceDeadlines() {
    const held = [];
    const failed = [];
    for (const ctx of [...contexts.values()]) {
      if (ctx.status !== 'running' || ctx.closed || ctx.holding || ctx.exit) {
        continue;
      }
      const result =
        // biome-ignore lint/performance/noAwaitInLoops: Each deadline hold changes ownership before the next active context is examined.
        await enforceCtxDeadline(ctx);
      if (result.expired === true) {
        (result.ok ? held : failed).push(ctx.binding.attemptId);
      } else if (!result.ok) {
        failed.push(ctx.binding.attemptId);
      }
    }
    return { failed, held, ok: failed.length === 0 };
  }

  // -------------------------------------------------------------------------
  // Cancel: exact ownership against the durable record, intent before effect.
  // -------------------------------------------------------------------------

  function cancelRequestBuild(ref) {
    return (view, at) => {
      const found = findRecord(view, ref.binding);
      if (!found.record) {
        return found.refusal;
      }
      const { record } = found;
      if (record.processStart?.id !== ref.processStartId) {
        return refuse('BINDING_MISMATCH');
      }
      if (!(OPEN_STATUSES.has(record.status) || record.status === 'held')) {
        return refuse('ATTEMPT_CLOSED');
      }
      if (record.cancel) {
        return unchanged({ cancel: record.cancel.state, duplicate: true });
      }
      const next = {
        ...record,
        cancel: { at, state: 'requested' },
        updatedAt: at,
      };
      return write(
        view,
        next,
        EVENT_TYPES.cancelRequested,
        {},
        { cancel: 'requested', duplicate: false }
      );
    };
  }

  function cancelResultBuild(ref, state) {
    const type =
      state === 'delivered'
        ? EVENT_TYPES.cancelDelivered
        : EVENT_TYPES.cancelUnknown;
    return (view, at) => {
      const found = findRecord(view, ref.binding);
      if (!found.record) {
        return found.refusal;
      }
      const next = {
        ...found.record,
        cancel: { at, state },
        updatedAt: at,
      };
      return write(view, next, type, {}, { cancel: state });
    };
  }

  async function callStop(ref, attemptDigest) {
    try {
      const result = await launcher.stop({
        attemptDigest,
        binding: { ...ref.binding },
        processStartId: ref.processStartId,
      });
      return isRecord(result) && result.ok === true;
    } catch {
      return false;
    }
  }

  async function cancel(input) {
    const ref = parseRef(input, { process: true });
    if (!ref.ok) {
      return ref;
    }
    if (typeof launcher.stop !== 'function') {
      return refuse('CANCEL_UNSUPPORTED');
    }
    const requested = await transact(
      ref.binding,
      cancelRequestBuild(ref),
      ref.fence
    );
    if (!requested.ok || requested.duplicate) {
      return requested;
    }
    // The request is durable; a delivered stop is still not an exit.
    const delivered = await callStop(ref, digestOf(ref.binding));
    const state = delivered ? 'delivered' : 'unknown';
    const recorded = await transact(
      ref.binding,
      cancelResultBuild(ref, state),
      ref.fence
    );
    if (!recorded.ok) {
      return refuse('CANCEL_RECORD_UNCONFIRMED', { unknown: true });
    }
    return delivered
      ? { cancel: 'delivered', ok: true, terminal: false }
      : refuse('CANCEL_UNKNOWN', { cancel: 'unknown', unknown: true });
  }

  // -------------------------------------------------------------------------
  // Recovery and receipts
  // -------------------------------------------------------------------------

  async function recover(input) {
    const ref = parseRef(input, { process: false });
    if (!ref.ok) {
      return ref;
    }
    if (contexts.has(contextKey(ref.binding))) {
      return refuse('ATTEMPT_ACTIVE');
    }
    // Counts come from the spool when it can say; otherwise last known, flagged.
    const stat = await spoolStat(digestOf(ref.binding));
    const build = (view, at) => {
      const found = findRecord(view, ref.binding);
      if (!found.record) {
        return found.refusal;
      }
      const { record } = found;
      if (!OPEN_STATUSES.has(record.status)) {
        return unchanged({
          duplicate: true,
          receipt: record.receipt,
          status: record.status,
        });
      }
      const reason = RECOVERY_REASONS[record.status];
      const next = {
        ...record,
        capture: {
          ...record.capture,
          bytes: stat?.bytes ?? record.capture.bytes,
          chunks: stat?.chunks ?? record.capture.chunks,
          complete: false,
          countsConfirmed: stat !== null,
          gap: { fromSeq: stat?.chunks ?? null, reason },
        },
        recoveredAtGeneration: ref.fence,
        status: 'held',
        updatedAt: at,
      };
      next.receipt = buildReceipt(next, { at, reason });
      return write(
        view,
        next,
        EVENT_TYPES.held,
        { receipt: next.receipt },
        { duplicate: false, held: true, receipt: next.receipt, status: 'held' }
      );
    };
    return transact(ref.binding, build, ref.fence);
  }

  async function getReceipt(input) {
    if (
      !(
        isRecord(input) &&
        isExplicitId(input.runId) &&
        isExplicitId(input.attemptId)
      )
    ) {
      return refuse('ID_INVALID');
    }
    const loaded = await loadRun(input.runId);
    if (!loaded.ok) {
      return loaded;
    }
    const attempts = attemptsOf(loaded.view);
    const record = attempts ? ownEntry(attempts, input.attemptId) : null;
    if (!record) {
      return refuse('ATTEMPT_NOT_FOUND');
    }
    return record.receipt
      ? { ok: true, receipt: record.receipt }
      : refuse('ATTEMPT_NOT_TERMINAL', { status: record.status });
  }

  function inspect() {
    return { activeAttempts: contexts.size, ok: true, queuedBytes };
  }

  const guarded = (work) => async (input) => {
    try {
      return await work(input);
    } catch {
      return refuse('WORKER_FAILED', { unknown: true });
    }
  };

  return Object.freeze({
    cancel: guarded(cancel),
    captureChunk: guarded(captureChunk),
    enforceDeadline: guarded(enforceDeadline),
    enforceDeadlines: guarded(enforceDeadlines),
    getReceipt: guarded(getReceipt),
    inspect,
    observeExit: guarded(observeExit),
    observeNative: guarded(observeNative),
    recover: guarded(recover),
    start: guarded(start),
  });
}
