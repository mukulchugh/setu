import { Buffer } from 'node:buffer';
import { isAbsolute, resolve } from 'node:path';
import { types } from 'node:util';
import { SPANS_ARCHIVE_BUDGET_BYTES } from './resource-admission.js';
import { sha256 } from './spans-execution-core.js';
import { SPANS_MODEL_LIMITS } from './spans-model-store.js';
import { SPANS_STORE_LIMITS } from './spans-store.js';

const WORKER_LIMIT_CEILINGS = Object.freeze({
  maxActiveAttempts: 2,
  maxAttemptBytes: 4 * 1024 * 1024,
  maxAttemptChunks: 65_536,
  maxChunkBytes: 64 * 1024,
  maxDeadlineMs: 60 * 60 * 1000,
  maxQueueBytes: 1024 * 1024,
});
const LIMIT_KEYS = Object.freeze(Object.keys(WORKER_LIMIT_CEILINGS).sort());
const MAIN_ARCHIVE_WRITE_OVERHEAD_BYTES = 2 * 1024 * 1024;
const WRITE_ENVELOPE_BYTES = 4096;
const JSON_ESCAPE_BYTES_PER_INPUT_BYTE = 6;
const CONTROL_EVENT_TYPES = new Set([
  'spans.worker.cancel.delivered',
  'spans.worker.cancel.requested',
  'spans.worker.cancel.unknown',
  'spans.worker.held',
]);

const isRecord = (value) =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

function dataRecord(value, keys) {
  if (types.isProxy(value) || !isRecord(value)) {
    return;
  }
  try {
    if (
      ![Object.prototype, null].includes(Object.getPrototypeOf(value)) ||
      Reflect.ownKeys(value).length !== keys.length
    ) {
      return;
    }
    const copy = {};
    for (const key of keys) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (
        descriptor?.enumerable !== true ||
        !Object.hasOwn(descriptor, 'value')
      ) {
        return;
      }
      copy[key] = descriptor.value;
    }
    return copy;
  } catch {
    // A hostile object cannot supply trusted policy input.
  }
}

function copyLimits(value) {
  const limits = dataRecord(value, LIMIT_KEYS);
  if (!limits) {
    return;
  }
  if (
    !LIMIT_KEYS.every(
      (key) => Number.isSafeInteger(limits[key]) && limits[key] > 0
    ) ||
    limits.maxActiveAttempts > WORKER_LIMIT_CEILINGS.maxActiveAttempts ||
    limits.maxAttemptBytes > WORKER_LIMIT_CEILINGS.maxAttemptBytes ||
    limits.maxAttemptChunks > WORKER_LIMIT_CEILINGS.maxAttemptChunks ||
    limits.maxChunkBytes > WORKER_LIMIT_CEILINGS.maxChunkBytes ||
    limits.maxDeadlineMs > WORKER_LIMIT_CEILINGS.maxDeadlineMs ||
    limits.maxDeadlineMs < 1000 ||
    limits.maxQueueBytes > WORKER_LIMIT_CEILINGS.maxQueueBytes ||
    limits.maxChunkBytes > limits.maxAttemptBytes ||
    limits.maxChunkBytes > limits.maxQueueBytes
  ) {
    return;
  }
  return Object.freeze(limits);
}

const sum = (values) => {
  let total = 0;
  for (const value of values) {
    total += value;
    if (!Number.isSafeInteger(total)) {
      return;
    }
  }
  return total;
};

function completedSequence(bounds) {
  return [
    bounds.ordinaryCommit, // finalizing receipt
    bounds.workerFinalize, // spool manifest and content-addressed artifact
    bounds.ordinaryCommit, // exited receipt
    bounds.archiveEvent, // spans.execution.captured
    bounds.ordinaryCommit, // completion view
    bounds.ordinaryCommit, // action outcome: completed or failed
    bounds.ordinaryCommit, // usage settlement after the exact exit
  ];
}

function terminalBranches(bounds) {
  const completed = completedSequence(bounds);
  return [
    // A user cancel commits its request before calling stop. The exact exit
    // can finish either side of the stop result while that call is in flight.
    [bounds.controlCommit, bounds.controlCommit, ...completed],
    [bounds.controlCommit, ...completed, bounds.controlCommit],
    // Capture exhaustion stops first, then finalizes a partial artifact, holds
    // the attempt, and can record the exact exit. A later recovery may also
    // mark the action unknown and append one recovery decision.
    [
      bounds.controlCommit,
      bounds.controlCommit,
      bounds.workerFinalize,
      bounds.controlCommit,
      bounds.ordinaryCommit,
      bounds.archiveEvent,
      bounds.ordinaryCommit,
      bounds.archiveEvent,
    ],
    // Deadline enforcement holds first. Its owner then records UNKNOWN and
    // attempts cancellation; confirmStoppedCaptureExit deliberately refuses
    // a deadline hold, so this branch has no confirmed-exit write.
    [
      bounds.workerFinalize,
      bounds.controlCommit,
      bounds.ordinaryCommit,
      bounds.controlCommit,
      bounds.controlCommit,
    ],
    // Restart reconciliation holds, records UNKNOWN, then appends one
    // recovery decision. That order differs from deadline settlement.
    [
      bounds.workerFinalize,
      bounds.controlCommit,
      bounds.ordinaryCommit,
      bounds.archiveEvent,
    ],
    // Finalization can fail after a user cancel starts. The worker holds first;
    // stop delivery is recorded after the launcher call, then recovery can add
    // UNKNOWN and its decision event.
    [
      bounds.controlCommit,
      bounds.ordinaryCommit,
      bounds.workerFinalize,
      bounds.controlCommit,
      bounds.controlCommit,
      bounds.ordinaryCommit,
      bounds.archiveEvent,
    ],
  ];
}

function maxSequenceBytes(sequences) {
  const sizes = sequences.map(sum);
  return sizes.some((size) => size === undefined)
    ? undefined
    : Math.max(...sizes);
}

function maxBytes(values) {
  return values.some((value) => !Number.isSafeInteger(value) || value < 0)
    ? undefined
    : Math.max(...values);
}

function ownValue(value, key) {
  if (types.isProxy(value) || !isRecord(value)) {
    return;
  }
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor && Object.hasOwn(descriptor, 'value')
      ? descriptor.value
      : undefined;
  } catch {
    // Policy inputs never need to invoke getters or proxy traps.
  }
}

function eventInfo(payload) {
  const events = ownValue(payload, 'events');
  if (!Array.isArray(events)) {
    return;
  }
  const result = [];
  for (const event of events) {
    const type = ownValue(event, 'type');
    const eventPayload = ownValue(event, 'payload');
    if (typeof type !== 'string' || !isRecord(eventPayload)) {
      return;
    }
    result.push({ eventPayload, type });
  }
  return result;
}

function commitContext(payload, eventPayload) {
  const view = ownValue(payload, 'view');
  const attemptId = ownValue(eventPayload, 'attemptId');
  const actionId = ownValue(eventPayload, 'actionId');
  const attempts = ownValue(view, 'attempts');
  const actions = ownValue(view, 'actions');
  const completions = ownValue(view, 'completions');
  const usage = ownValue(view, 'usage');
  const reservations = ownValue(usage, 'reservations');
  const attempt =
    typeof attemptId === 'string' ? ownValue(attempts, attemptId) : undefined;
  const action =
    typeof actionId === 'string' ? ownValue(actions, actionId) : undefined;
  const completion =
    typeof actionId === 'string' ? ownValue(completions, actionId) : undefined;
  let usageReservation;
  if (isRecord(reservations)) {
    try {
      for (const key of Object.keys(reservations)) {
        const row = ownValue(reservations, key);
        if (ownValue(row, 'attemptId') === attemptId) {
          usageReservation = row;
          break;
        }
      }
    } catch {
      usageReservation = undefined;
    }
  }
  return {
    action,
    attempt,
    completion,
    history: ownValue(payload, 'history'),
    usageReservation,
    view,
  };
}

const terminalAction = (action) =>
  ['completed', 'failed'].includes(ownValue(action, 'state'));

const usageSettled = (reservation) => {
  const state = ownValue(reservation, 'state');
  return state === 'released' || state === 'held';
};

function pendingCancelResult(context, bounds) {
  return ownValue(ownValue(context.attempt, 'cancel'), 'state') === 'requested'
    ? bounds.controlCommit
    : 0;
}

function hasHistoryEvent(context, type) {
  const attemptId = ownValue(context.attempt, 'attemptId');
  if (!Array.isArray(context.history)) {
    return false;
  }
  for (const event of context.history) {
    if (
      ownValue(event, 'type') === type &&
      ownValue(ownValue(event, 'payload'), 'attemptId') === attemptId
    ) {
      return true;
    }
  }
  return false;
}

function parentAfterExit(
  context,
  bounds,
  { artifactAvailable = false, capturedAlready = false, complete } = {}
) {
  const writes = [];
  const capture = ownValue(context.attempt, 'capture');
  const isComplete = complete ?? ownValue(capture, 'complete') === true;
  const artifactId = ownValue(capture, 'artifactId');
  const captureEventExists =
    capturedAlready || hasHistoryEvent(context, 'spans.execution.captured');
  if (!captureEventExists && (artifactId || artifactAvailable)) {
    writes.push(bounds.archiveEvent);
  }
  if (isComplete && !context.completion) {
    writes.push(bounds.ordinaryCommit);
  }
  if (isComplete && !terminalAction(context.action)) {
    // An UNKNOWN action may be resolved to FAILED only after this exact exit.
    writes.push(bounds.ordinaryCommit);
  }
  if (isComplete && !usageSettled(context.usageReservation)) {
    writes.push(bounds.ordinaryCommit);
  }
  const cancellationResult = pendingCancelResult(context, bounds);
  if (cancellationResult > 0) {
    writes.push(cancellationResult);
  }
  return sum(writes);
}

function remainingTailAppend(context, bounds) {
  const capture = ownValue(context.attempt, 'capture');
  const bytes = ownValue(capture, 'bytes');
  const chunks = ownValue(capture, 'chunks');
  if (
    !Number.isSafeInteger(bytes) ||
    bytes < 0 ||
    !Number.isSafeInteger(chunks) ||
    chunks < 0
  ) {
    return bounds.append;
  }
  const remainingBytes = Math.max(0, bounds.maxAttemptBytes - bytes);
  const remainingChunks = Math.max(0, bounds.maxAttemptChunks - chunks);
  if (remainingBytes === 0 || remainingChunks === 0) {
    return 0;
  }
  const remaining = sum([
    JSON_ESCAPE_BYTES_PER_INPUT_BYTE * remainingBytes,
    remainingChunks * bounds.chunkEnvelopeBytes,
  ]);
  return remaining === undefined
    ? undefined
    : Math.min(bounds.append, remaining);
}

function appendWriteBytes(payload, fallback) {
  const bytes = ownValue(payload, 'bytes');
  const digest = ownValue(payload, 'digest');
  const seq = ownValue(payload, 'seq');
  const text = ownValue(payload, 'text');
  if (
    !Number.isSafeInteger(bytes) ||
    bytes < 1 ||
    !Number.isSafeInteger(seq) ||
    seq < 0 ||
    typeof digest !== 'string' ||
    typeof text !== 'string' ||
    Buffer.byteLength(text, 'utf8') !== bytes
  ) {
    return fallback;
  }
  return Buffer.byteLength(
    JSON.stringify({ bytes, digest, seq, text, version: 1 })
  );
}

function heldExitTail(context, bounds, { artifactAvailable = false } = {}) {
  const { attempt } = context;
  const capture = ownValue(attempt, 'capture');
  const artifactId = ownValue(capture, 'artifactId');
  const actionUnknown =
    ownValue(context.action, 'state') === 'intent' ? bounds.ordinaryCommit : 0;
  const captureNote =
    (artifactId || artifactAvailable) &&
    !hasHistoryEvent(context, 'spans.execution.captured')
      ? bounds.archiveEvent
      : 0;
  return sum([actionUnknown, captureNote, bounds.archiveEvent]);
}

function heldSpoolLimitTail(context, bounds) {
  const needsUnknown = ownValue(context.action, 'state') === 'intent';
  return sum([
    bounds.ordinaryCommit, // exact exit receipt
    bounds.archiveEvent, // parent note for the captured partial artifact
    needsUnknown ? bounds.ordinaryCommit : 0,
    bounds.archiveEvent, // recovery decision after the held attempt
  ]);
}

function heldRequestedTail(context, bounds) {
  const { attempt } = context;
  const capture = ownValue(attempt, 'capture');
  const reason = ownValue(ownValue(capture, 'gap'), 'reason');
  const needsUnknown = ownValue(context.action, 'state') === 'intent';
  const unresolved = [
    bounds.controlCommit, // stop-delivery result
    needsUnknown ? bounds.ordinaryCommit : 0,
    bounds.archiveEvent, // recovery decision
  ];
  if (reason !== 'spool-limit') {
    return sum(unresolved);
  }
  return maxSequenceBytes([
    unresolved,
    [
      bounds.controlCommit, // stop-delivery result
      bounds.ordinaryCommit, // exact exit receipt
      bounds.archiveEvent, // parent note for the partial artifact
      needsUnknown ? bounds.ordinaryCommit : 0,
      bounds.archiveEvent, // recovery decision
    ],
  ]);
}

function heldUnrequestedTail(context, bounds) {
  const needsUnknown = ownValue(context.action, 'state') === 'intent';
  return maxSequenceBytes([
    // Deadline settlement writes UNKNOWN before the stop request/result.
    [
      needsUnknown ? bounds.ordinaryCommit : 0,
      bounds.controlCommit,
      bounds.controlCommit,
    ],
    // Restart or ordinary held reconciliation writes UNKNOWN then its event.
    [needsUnknown ? bounds.ordinaryCommit : 0, bounds.archiveEvent],
  ]);
}

function heldTail(context, bounds, { artifactAvailable = false } = {}) {
  const { attempt } = context;
  const cancelState = ownValue(ownValue(attempt, 'cancel'), 'state');
  const capture = ownValue(attempt, 'capture');
  const reason = ownValue(ownValue(capture, 'gap'), 'reason');
  const hasExit =
    ownValue(attempt, 'exit') !== null &&
    ownValue(attempt, 'exit') !== undefined;
  if (hasExit) {
    return heldExitTail(context, bounds, { artifactAvailable });
  }
  if (cancelState === 'delivered' && reason === 'spool-limit') {
    return heldSpoolLimitTail(context, bounds);
  }
  if (cancelState === 'requested') {
    return heldRequestedTail(context, bounds);
  }
  if (cancelState === undefined || cancelState === null) {
    return heldUnrequestedTail(context, bounds);
  }
  return sum([
    ownValue(context.action, 'state') === 'intent' ? bounds.ordinaryCommit : 0,
    bounds.archiveEvent,
  ]);
}

function afterHeldFinalize(bounds) {
  return maxSequenceBytes([
    // Deadline hold, followed by UNKNOWN and the stop request/result.
    [
      bounds.controlCommit,
      bounds.ordinaryCommit,
      bounds.controlCommit,
      bounds.controlCommit,
    ],
    // Restart reconciliation: UNKNOWN and one recovery event.
    [bounds.controlCommit, bounds.ordinaryCommit, bounds.archiveEvent],
    // Capture exhaustion may be confirmed after the hold; later recovery may
    // still record one action outcome and one decision event.
    [
      bounds.controlCommit,
      bounds.ordinaryCommit, // exact exit
      bounds.archiveEvent, // captured partial artifact
      bounds.ordinaryCommit, // later UNKNOWN if still unresolved
      bounds.archiveEvent, // recovery decision
    ],
  ]);
}

function boundsFor(limits) {
  // These match the existing parent and worker-host allowances. The shared
  // bound takes the larger allowance where their current call sites differ.
  const parentWrite =
    SPANS_MODEL_LIMITS.documentBytes +
    SPANS_STORE_LIMITS.payloadBytes * 8 +
    MAIN_ARCHIVE_WRITE_OVERHEAD_BYTES;
  const modelBatchBytes = Math.min(
    SPANS_MODEL_LIMITS.batchBytes,
    SPANS_MODEL_LIMITS.eventsPerBatch * SPANS_STORE_LIMITS.payloadBytes
  );
  const workerCommit =
    SPANS_MODEL_LIMITS.documentBytes +
    modelBatchBytes +
    SPANS_STORE_LIMITS.payloadBytes +
    WRITE_ENVELOPE_BYTES;
  const workerControl =
    SPANS_MODEL_LIMITS.documentBytes +
    SPANS_STORE_LIMITS.payloadBytes +
    WRITE_ENVELOPE_BYTES;
  const controlCommit = Math.max(parentWrite, workerControl);
  const ordinaryCommit = Math.max(parentWrite, workerCommit);
  const archiveEvent = Math.max(
    parentWrite,
    SPANS_STORE_LIMITS.payloadBytes + WRITE_ENVELOPE_BYTES
  );
  const append = Math.max(
    parentWrite,
    limits.maxChunkBytes * 8 + WRITE_ENVELOPE_BYTES
  );
  const finalize = Math.max(
    parentWrite + 2 * limits.maxAttemptBytes,
    JSON_ESCAPE_BYTES_PER_INPUT_BYTE * limits.maxAttemptBytes + 8192
  );
  const checkpoint = ordinaryCommit;

  // Terminal branches use the actual writer order in spans-worker.js and
  // spans-execution.js. In particular, normal user cancellation can finish
  // the entire captured/FAILED/usage path before cancel() records delivery.
  const pathBounds = {
    archiveEvent,
    controlCommit,
    ordinaryCommit,
    workerFinalize: finalize,
  };
  const terminal = maxSequenceBytes(terminalBranches(pathBounds));
  const fullFinalizeTail = maxSequenceBytes([
    [
      ordinaryCommit, // exited receipt
      archiveEvent, // captured
      ordinaryCommit, // completion view
      ordinaryCommit, // completed or failed outcome
      ordinaryCommit, // usage reconciliation
      controlCommit, // cancel result may follow the provider exit
    ],
    [
      controlCommit, // held after a failed finalization
      controlCommit, // cancel result after stop returns
      ordinaryCommit, // later UNKNOWN
      archiveEvent, // recovery decision
    ],
  ]);
  const fullFinalize =
    fullFinalizeTail === undefined
      ? undefined
      : sum([finalize, fullFinalizeTail]);
  const heldFinalizeTail = afterHeldFinalize(pathBounds);
  const heldFinalize =
    heldFinalizeTail === undefined
      ? undefined
      : sum([finalize, heldFinalizeTail]);
  if (
    terminal === undefined ||
    fullFinalize === undefined ||
    heldFinalize === undefined
  ) {
    return;
  }

  // The host spool stores one JSON file per chunk; the parent spool stores
  // JSONL records. For either format, sum of escaped text is <= 6x the bounded
  // UTF-8 capture bytes. Derive fixed record overhead from their exact shapes.
  const lastSequence = limits.maxAttemptChunks - 1;
  const hostChunkEnvelope = Buffer.byteLength(
    JSON.stringify({
      bytes: limits.maxChunkBytes,
      digest: '0'.repeat(64),
      seq: lastSequence,
      text: '',
      version: 1,
    })
  );
  const parentChunkEnvelope = Buffer.byteLength(
    `${JSON.stringify({
      digest: '0'.repeat(64),
      seq: lastSequence,
      text: '',
    })}\n`
  );
  const chunkEnvelopeBytes = Math.max(hostChunkEnvelope, parentChunkEnvelope);
  const chunkRecords = sum([
    JSON_ESCAPE_BYTES_PER_INPUT_BYTE * limits.maxAttemptBytes,
    limits.maxAttemptChunks * chunkEnvelopeBytes,
    8192, // worker-host binding.json plus finalized.json write ceilings
  ]);

  // These are the bounded post-admission writes before capture: usage reserve,
  // action intent, worker intent, worker launched, and at most one native ID.
  const setupWrites = 5 * ordinaryCommit;
  const appendAndCheckpoint = sum([append, checkpoint, terminal]);
  const fullCapture =
    chunkRecords === undefined
      ? undefined
      : sum([chunkRecords, setupWrites, checkpoint, terminal]);
  if (fullCapture === undefined || appendAndCheckpoint === undefined) {
    return;
  }
  const perAttempt = Math.max(fullCapture, appendAndCheckpoint);
  // Each lease reserves the exact capacity of one attempt. ResourceAdmission
  // already sums all live leases and enforces the worker's two-attempt cap.
  const reservedBytes = perAttempt;
  if (
    !Number.isSafeInteger(reservedBytes) ||
    reservedBytes <= 0 ||
    reservedBytes > SPANS_ARCHIVE_BUDGET_BYTES
  ) {
    return;
  }
  return Object.freeze({
    append,
    archiveEvent,
    checkpoint,
    chunkEnvelopeBytes,
    chunkRecords,
    controlCommit,
    fullFinalize,
    heldFinalize,
    maxAttemptBytes: limits.maxAttemptBytes,
    maxAttemptChunks: limits.maxAttemptChunks,
    ordinaryCommit,
    reservedBytes,
    terminal,
    workerFinalize: finalize,
  });
}

function normalizedRoot(root) {
  return (
    typeof root === 'string' &&
    root.length > 0 &&
    isAbsolute(root) &&
    resolve(root) === root &&
    ![...root].some(
      (character) =>
        character.codePointAt(0) <= 31 || character.codePointAt(0) === 127
    )
  );
}

/** Build the archive reservation from trusted, already-resolved worker limits. */
export function spansExecutionArchiveReservation(input = {}) {
  const request = dataRecord(input, ['root', 'limits']);
  if (!request) {
    return;
  }
  const { root, limits } = request;
  if (!normalizedRoot(root)) {
    return;
  }
  const checkedLimits = copyLimits(limits);
  const bounds = checkedLimits && boundsFor(checkedLimits);
  if (!bounds) {
    return;
  }
  return Object.freeze({
    budgetBytes: SPANS_ARCHIVE_BUDGET_BYTES,
    reservedBytes: bounds.reservedBytes,
    root,
  });
}

function suffixAfterCompletion(context, bounds) {
  const writes = [];
  if (!terminalAction(context.action)) {
    writes.push(bounds.ordinaryCommit);
  }
  if (!usageSettled(context.usageReservation)) {
    writes.push(bounds.ordinaryCommit);
  }
  const cancellationResult = pendingCancelResult(context, bounds);
  if (cancellationResult > 0) {
    writes.push(cancellationResult);
  }
  return sum(writes);
}

function actionUnknownTail(context, bounds) {
  if (ownValue(context.attempt, 'status') === 'held') {
    return heldTail(context, bounds);
  }
  if (ownValue(context.attempt, 'status') === 'exited') {
    return ownValue(ownValue(context.attempt, 'capture'), 'complete') === true
      ? parentAfterExit(context, bounds)
      : pendingCancelResult(context, bounds);
  }
  return bounds.terminal;
}

function finalizeFailureTail(context, bounds) {
  return sum([
    bounds.controlCommit, // hold receipt after the failed finalizer
    pendingCancelResult(context, bounds), // stop result may follow the hold
    ownValue(context.action, 'state') === 'intent' ? bounds.ordinaryCommit : 0,
    bounds.archiveEvent, // later recovery decision
  ]);
}

function finalizingTail(context, bounds) {
  const tailAppend = remainingTailAppend(context, bounds);
  if (!Number.isSafeInteger(tailAppend)) {
    return;
  }
  const successfulExit = sum([
    tailAppend, // flushTail can persist the remaining unterminated record
    bounds.workerFinalize,
    bounds.ordinaryCommit, // exited receipt
    parentAfterExit(context, bounds, {
      artifactAvailable: true,
      complete: true,
    }),
  ]);
  const incompleteExit = sum([
    tailAppend,
    bounds.workerFinalize,
    bounds.ordinaryCommit,
    parentAfterExit(context, bounds, {
      artifactAvailable: true,
      complete: false,
    }),
  ]);
  const failedFinalize = sum([
    tailAppend,
    bounds.workerFinalize,
    finalizeFailureTail(context, bounds),
  ]);
  const exhaustedDuringTail = sum([
    tailAppend,
    bounds.controlCommit, // owned stop request
    bounds.controlCommit, // stop result
    bounds.workerFinalize, // partial artifact
    bounds.controlCommit, // held receipt
    bounds.ordinaryCommit, // exact confirmed exit
    bounds.archiveEvent, // captured partial artifact
    ownValue(context.action, 'state') === 'intent' ? bounds.ordinaryCommit : 0,
    bounds.archiveEvent, // recovery decision
  ]);
  return maxBytes([
    successfulExit,
    incompleteExit,
    failedFinalize,
    exhaustedDuringTail,
  ]);
}

function exitAllocation(context, eventPayload, current, bounds) {
  if (ownValue(context.attempt, 'status') !== 'held') {
    return sum([current, parentAfterExit(context, bounds)]);
  }
  const capture = ownValue(context.attempt, 'capture');
  const receipt = ownValue(eventPayload, 'receipt');
  const artifactId =
    ownValue(capture, 'artifactId') ??
    ownValue(ownValue(receipt, 'capture'), 'artifactId');
  return sum([
    current,
    heldTail(context, bounds, { artifactAvailable: Boolean(artifactId) }),
  ]);
}

function cancelAllocation(context, type, current, bounds) {
  const status = ownValue(context.attempt, 'status');
  if (status === 'held') {
    return sum([current, heldTail(context, bounds)]);
  }
  if (status === 'finalizing') {
    return sum([current, finalizingTail(context, bounds)]);
  }
  if (status === 'exited') {
    return sum([current, parentAfterExit(context, bounds)]);
  }
  if (type === 'spans.worker.cancel.requested') {
    return sum([
      current,
      maxBytes([
        sum([bounds.controlCommit, ...completedSequence(bounds)]),
        sum([
          bounds.controlCommit, // stop result
          bounds.workerFinalize, // partial artifact after capture exhaustion
          bounds.controlCommit, // held receipt
          bounds.ordinaryCommit, // exact confirmed exit
          bounds.archiveEvent, // captured partial artifact
          bounds.ordinaryCommit, // action UNKNOWN
          bounds.archiveEvent, // recovery decision
        ]),
      ]),
    ]);
  }
  return sum([current, ...completedSequence(bounds)]);
}

function actionOutcomeAllocation(context, eventPayload, current, bounds) {
  if (ownValue(eventPayload, 'outcome') === 'unknown') {
    return sum([current, actionUnknownTail(context, bounds)]);
  }
  if (['completed', 'failed'].includes(ownValue(eventPayload, 'outcome'))) {
    return sum([current, suffixAfterCompletion(context, bounds)]);
  }
  return sum([current, bounds.terminal]);
}

function allocateCommitEvent(context, eventPayload, type, bounds) {
  const current = CONTROL_EVENT_TYPES.has(type)
    ? bounds.controlCommit
    : bounds.ordinaryCommit;
  if (type === 'spans.worker.finalizing') {
    return sum([current, finalizingTail(context, bounds)]);
  }
  if (type === 'spans.worker.exited') {
    return exitAllocation(context, eventPayload, current, bounds);
  }
  if (
    type === 'spans.worker.cancel.requested' ||
    type === 'spans.worker.cancel.delivered' ||
    type === 'spans.worker.cancel.unknown'
  ) {
    return cancelAllocation(context, type, current, bounds);
  }
  if (type === 'spans.worker.held') {
    return sum([current, heldTail(context, bounds)]);
  }
  if (type === 'spans.action.outcome') {
    return actionOutcomeAllocation(context, eventPayload, current, bounds);
  }
  if (type === 'spans.execution.completion') {
    return sum([current, suffixAfterCompletion(context, bounds)]);
  }
  if (type === 'spans.usage.reconcile') {
    return sum([current, pendingCancelResult(context, bounds)]);
  }
  return sum([current, bounds.terminal]);
}

function commitAllocation(payload, bounds) {
  const events = eventInfo(payload);
  if (events?.length !== 1) {
    return sum([bounds.ordinaryCommit, bounds.terminal]);
  }
  const [{ eventPayload, type }] = events;
  return allocateCommitEvent(
    commitContext(payload, eventPayload),
    eventPayload,
    type,
    bounds
  );
}

function appendEventAllocation(payload, bounds) {
  const nestedEvent = ownValue(payload, 'event');
  const event = isRecord(nestedEvent) ? nestedEvent : payload;
  const type = ownValue(event, 'type') ?? ownValue(payload, 'type');
  const eventPayload = ownValue(event, 'payload');
  if (type !== 'spans.execution.captured') {
    return sum([
      bounds.archiveEvent,
      actionUnknownTail(commitContext(payload, eventPayload), bounds),
    ]);
  }
  if (!isRecord(eventPayload)) {
    return sum([
      bounds.archiveEvent,
      3 * bounds.ordinaryCommit,
      bounds.controlCommit, // result of an in-flight user cancellation
    ]);
  }
  const context = commitContext(payload, eventPayload);
  const complete = ownValue(eventPayload, 'complete') === true;
  if (complete && context.attempt) {
    return sum([
      bounds.archiveEvent,
      parentAfterExit(context, bounds, { capturedAlready: true }),
    ]);
  }
  if (ownValue(context.attempt, 'status') === 'held') {
    return sum([
      bounds.archiveEvent,
      ownValue(context.action, 'state') === 'intent'
        ? bounds.ordinaryCommit
        : 0,
      bounds.archiveEvent, // held recovery decision
    ]);
  }
  return sum([bounds.archiveEvent, pendingCancelResult(context, bounds)]);
}

/** Return the conservative allocation for one capture write and its remaining terminal path. */
export function spansExecutionArchiveWriteBytes(input = {}) {
  if (types.isProxy(input)) {
    return;
  }
  const keys = isRecord(input) ? Reflect.ownKeys(input) : [];
  const request =
    keys.length === 2
      ? dataRecord(input, ['method', 'limits'])
      : dataRecord(input, ['method', 'limits', 'payload']);
  if (!request) {
    return;
  }
  const { method, limits, payload } = request;
  const checkedLimits = copyLimits(limits);
  const bounds = checkedLimits && boundsFor(checkedLimits);
  if (!bounds) {
    return;
  }
  if (method === 'append') {
    return sum([
      appendWriteBytes(payload, bounds.append),
      bounds.checkpoint,
      bounds.terminal,
    ]);
  }
  if (method === 'checkpoint') {
    return sum([bounds.checkpoint, bounds.terminal]);
  }
  if (method === 'authority') {
    return sum([1, bounds.terminal]);
  }
  if (method === 'finalize') {
    return bounds.fullFinalize;
  }
  if (method === 'heldFinalize') {
    return bounds.heldFinalize;
  }
  if (method === 'commitRun') {
    return commitAllocation(payload, bounds);
  }
  if (method === 'appendEvent') {
    return appendEventAllocation(payload, bounds);
  }
}

// Read only the exact capture event needed for a remaining-write allowance.
// Callers supply the proposed view for CAS writes, never request assertions.
export function spansExecutionArchiveWriteContext(store, method, payload) {
  if (!['appendEvent', 'commitRun'].includes(method)) {
    return payload;
  }
  try {
    const event = method === 'commitRun' ? payload.events?.[0] : payload;
    const { runId } = payload;
    const { attemptId, actionId } = event?.payload ?? {};
    const read = store.readRun({ runId });
    if (read?.ok !== true) {
      return null;
    }
    let history = [];
    if (typeof attemptId === 'string' && typeof actionId === 'string') {
      const eventId = `spans.execution.captured:${sha256(
        JSON.stringify([runId, attemptId])
      )}`;
      const found = store.getEventById({ eventId });
      if (found?.ok !== true) {
        return null;
      }
      if (found.found) {
        const captured = found.event;
        if (
          captured?.eventId !== eventId ||
          captured.type !== 'spans.execution.captured' ||
          captured.runId !== runId ||
          captured.payload?.attemptId !== attemptId ||
          captured.payload?.actionId !== actionId
        ) {
          return null;
        }
        history = [captured];
      }
    }
    return { ...payload, history, view: payload.view ?? read.view };
  } catch {
    return null;
  }
}
