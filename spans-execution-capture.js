import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';
import { isDeepStrictEqual, types as utilTypes } from 'node:util';

const BINDING_FIELDS = [
  'runId',
  'spanId',
  'actionId',
  'attemptId',
  'generation',
  'workerId',
];
const REQUEST_FIELDS = BINDING_FIELDS.filter((key) => key !== 'workerId');
const PRE_EFFECT_CODES = new Set([
  'ACTION_INTENT_NOT_CONFIRMED',
  'ARCHIVE_ADMISSION_REFUSED',
  'ATTEMPT_AUTHORIZATION_REFUSED',
  'ATTEMPT_AUTHORITY_UNKNOWN',
  'CAPTURE_ROOT_UNSAFE',
  'CAPTURE_START_INVALID',
]);
const OPEN_STATUSES = new Set(['launching', 'running', 'finalizing']);
const LIVE_PROVIDER_STATES = new Set(['running']);
const HELD_PROVIDER_STATES = new Set(['capture-full', 'stopping']);
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const DIGEST = /^(?:sha256:)?[0-9a-f]{64}$/;
const ATTEMPT_DIGEST = /^[0-9a-f]{64}$/;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const record = (value) =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const fail = (code, extra = {}) => ({ code, ok: false, ...extra });
const unknown = (code, extra = {}) => fail(code, { unknown: true, ...extra });
const keyOf = (binding) => JSON.stringify([binding.runId, binding.attemptId]);
const sha256 = (value) => createHash('sha256').update(value).digest('hex');

function snapshotBinding(input, workerId) {
  if (!record(input) || utilTypes.isProxy(input)) {
    return null;
  }
  let descriptors;
  try {
    descriptors = Object.getOwnPropertyDescriptors(input);
  } catch {
    return null;
  }
  const binding = { workerId };
  for (const key of REQUEST_FIELDS) {
    const property = descriptors[key];
    const value = property?.value;
    if (
      !(property && Object.hasOwn(property, 'value') && property.enumerable) ||
      (key === 'generation'
        ? !Number.isSafeInteger(value) || value < 0
        : typeof value !== 'string' || !ID.test(value))
    ) {
      return null;
    }
    binding[key] = value;
  }
  return Object.freeze(binding);
}

function sameBinding(left, right) {
  return (
    record(left) &&
    record(right) &&
    BINDING_FIELDS.every((key) => left[key] === right[key])
  );
}

function reviewReference(execution, binding) {
  const reference = execution?.reviewRef;
  if (
    !record(reference) ||
    reference.runId !== binding.runId ||
    !DIGEST.test(reference.reviewDigest ?? '') ||
    !DIGEST.test(execution.approvalDigest ?? '')
  ) {
    return null;
  }
  return Object.freeze({
    approvalDigest: execution.approvalDigest,
    reviewDigest: reference.reviewDigest,
    runId: reference.runId,
  });
}

function sourceForProcess(resolved) {
  if (
    !record(resolved) ||
    resolved.ok === false ||
    !Array.isArray(resolved.argv) ||
    resolved.argv.length === 0 ||
    !resolved.argv.every((value) => typeof value === 'string') ||
    typeof resolved.cwd !== 'string' ||
    typeof resolved.stdin !== 'string' ||
    !record(resolved.env) ||
    Object.entries(resolved.env).some(
      ([key, value]) => !ENV_NAME.test(key) || typeof value !== 'string'
    )
  ) {
    return null;
  }
  return Object.freeze({
    args: Object.freeze(resolved.argv.slice(1)),
    command: resolved.argv[0],
    cwd: resolved.cwd,
    env: Object.freeze({ ...resolved.env }),
    stdin: resolved.stdin,
  });
}

function validProcessStart(value) {
  return (
    record(value) &&
    Number.isSafeInteger(value.pid) &&
    value.pid > 0 &&
    typeof value.id === 'string' &&
    value.id.length > 0
  );
}

// Native and legacy hosts record the same lstart as `lstart` and
// `pid:lstart`. Normalize only for this comparison; receipts remain untouched.
function comparableProcessIdentity(value) {
  if (!validProcessStart(value)) {
    return null;
  }
  const prefix = `${value.pid}:`;
  const identity = value.id.startsWith(prefix)
    ? value.id.slice(prefix.length)
    : value.id;
  return `${value.pid}:${identity}`;
}

function exactAttempt(attempt, binding) {
  return (
    record(attempt) &&
    sameBinding(attempt, binding) &&
    typeof attempt.status === 'string' &&
    (attempt.nativeId === null || typeof attempt.nativeId === 'string')
  );
}

function terminalReceipt(attempt, binding, { status, outcome, complete }) {
  const receipt = attempt?.receipt;
  if (
    !exactAttempt(attempt, binding) ||
    attempt.status !== status ||
    !record(attempt.exit) ||
    !ATTEMPT_DIGEST.test(attempt.attemptDigest ?? '') ||
    !record(receipt) ||
    receipt.kind !== 'spans.worker.receipt' ||
    receipt.status !== status ||
    receipt.outcome !== outcome ||
    receipt.ownershipReleased !== false ||
    receipt.workAccepted !== false ||
    receipt.resumeAvailable !== false ||
    receipt.retryEligible !== false ||
    !sameBinding(receipt, binding) ||
    receipt.attemptDigest !== attempt.attemptDigest ||
    !isDeepStrictEqual(receipt.cancel, attempt.cancel) ||
    !isDeepStrictEqual(receipt.exit, attempt.exit) ||
    !isDeepStrictEqual(receipt.processStart, attempt.processStart) ||
    !isDeepStrictEqual(receipt.capture, attempt.capture) ||
    receipt.nativeId !== attempt.nativeId ||
    receipt.nativeIdState !==
      (attempt.nativeId === null ? 'missing' : 'recorded') ||
    !validProcessStart(attempt.processStart) ||
    !record(receipt.capture) ||
    receipt.capture.complete !== complete ||
    receipt.capture.countsConfirmed !== true ||
    !Number.isSafeInteger(receipt.capture.bytes) ||
    receipt.capture.bytes < 0 ||
    !Number.isSafeInteger(receipt.capture.chunks) ||
    receipt.capture.chunks < 0 ||
    typeof receipt.capture.artifactId !== 'string' ||
    !DIGEST.test(receipt.capture.artifactId)
  ) {
    return null;
  }
  if (
    complete &&
    (receipt.reason !== 'process-exited' ||
      receipt.capture.gap !== null ||
      attempt.capture.complete !== true ||
      attempt.capture.countsConfirmed !== true ||
      !Number.isSafeInteger(attempt.capture.bytes) ||
      !Number.isSafeInteger(attempt.capture.chunks) ||
      typeof attempt.capture.artifactId !== 'string' ||
      !DIGEST.test(attempt.capture.artifactId))
  ) {
    return null;
  }
  if (
    !complete &&
    (attempt.status !== 'held' ||
      !['spool-limit', 'capture-failed'].includes(receipt.reason) ||
      attempt.cancel?.state !== 'delivered' ||
      !record(receipt.capture.gap) ||
      receipt.capture.gap.reason !== receipt.reason ||
      !Number.isSafeInteger(receipt.capture.gap.fromSeq) ||
      receipt.capture.gap.fromSeq !== receipt.capture.chunks ||
      attempt.capture.complete !== false ||
      attempt.capture.countsConfirmed !== true ||
      !Number.isSafeInteger(attempt.capture.bytes) ||
      attempt.capture.bytes < 0 ||
      !Number.isSafeInteger(attempt.capture.chunks) ||
      attempt.capture.chunks < 0 ||
      typeof attempt.capture.artifactId !== 'string' ||
      !DIGEST.test(attempt.capture.artifactId))
  ) {
    return null;
  }
  return receipt;
}

function terminalEvidence(attempt, binding) {
  const complete = terminalReceipt(attempt, binding, {
    complete: true,
    outcome: 'process-exited',
    status: 'exited',
  });
  if (complete) {
    return { receipt: complete, status: 'exited', type: 'complete' };
  }
  const held = terminalReceipt(attempt, binding, {
    complete: false,
    outcome: 'unknown',
    status: 'held',
  });
  return held ? { receipt: held, status: 'held', type: 'held' } : null;
}

function sameAttempt(left, right) {
  return (
    exactAttempt(left, left) &&
    exactAttempt(right, right) &&
    BINDING_FIELDS.every((key) => left[key] === right[key]) &&
    // The two archive reads can straddle the child's finalizing commit.
    (left.status === right.status ||
      (left.status === 'running' && right.status === 'finalizing')) &&
    isDeepStrictEqual(left.processStart, right.processStart) &&
    isDeepStrictEqual(left.receipt, right.receipt)
  );
}

function reconnectEnvelopeMatches(result, binding, descriptorPath) {
  const capture = result?.captureProcess;
  return (
    result?.ok === true &&
    sameBinding(result.binding, binding) &&
    result.descriptorPath === descriptorPath &&
    record(capture) &&
    Number.isSafeInteger(capture.pid) &&
    capture.pid > 0 &&
    typeof capture.processStartIdentity === 'string' &&
    capture.processStartIdentity.length > 0 &&
    result.archive?.ok === true &&
    result.archive.generation === binding.generation &&
    result.archive.view?.generation === binding.generation
  );
}

function reconnectProviderMatches(
  result,
  binding,
  savedAttempt,
  allowHeldControl
) {
  const attempt = result.archive.view.attempts?.[binding.attemptId];
  const provider = result.observation?.provider;
  const heldControl =
    allowHeldControl && attempt?.status === 'held' && attempt.exit === null;
  return (
    exactAttempt(attempt, binding) &&
    sameAttempt(attempt, savedAttempt) &&
    (OPEN_STATUSES.has(attempt.status) || heldControl) &&
    record(provider) &&
    (LIVE_PROVIDER_STATES.has(provider.state) ||
      provider.state === 'draining' ||
      ['exited', 'signaled', 'capture-full'].includes(provider.captureState) ||
      (heldControl && HELD_PROVIDER_STATES.has(provider.state))) &&
    validProcessStart(provider.processStart) &&
    comparableProcessIdentity(provider.processStart) ===
      comparableProcessIdentity(attempt.processStart)
  );
}

function reconnectNativeState(
  result,
  binding,
  savedAttempt,
  previousAttempt,
  allowHeldControl
) {
  if (
    !(record(previousAttempt) && Object.hasOwn(result.observation, 'nativeId'))
  ) {
    return false;
  }
  const { nativeId } = savedAttempt;
  if (
    previousAttempt.nativeId !== null &&
    previousAttempt.nativeId !== nativeId
  ) {
    return false;
  }
  const attempt = result.archive.view.attempts[binding.attemptId];
  const nativeValues = [attempt.nativeId, result.observation.nativeId];
  if (
    nativeValues.some(
      (value) =>
        value !== nativeId &&
        !(previousAttempt.nativeId === null && value === null)
    )
  ) {
    return false;
  }
  const { provider } = result.observation;
  const ownedState =
    LIVE_PROVIDER_STATES.has(provider.state) ||
    (allowHeldControl &&
      attempt.status === 'held' &&
      HELD_PROVIDER_STATES.has(provider.state));
  // The first session ID may be committed between the control and archive reads.
  return nativeValues.every((value) => value === nativeId) &&
    ownedState &&
    attempt.status === savedAttempt.status
    ? 'running'
    : 'observing';
}

function sameAction(action, binding) {
  return (
    record(action) &&
    action.actionId === binding.actionId &&
    action.attemptId === binding.attemptId &&
    action.spanId === binding.spanId
  );
}

function sameObservedProcess(current, previous, binding) {
  return (
    exactAttempt(current, binding) &&
    comparableProcessIdentity(current.processStart) ===
      comparableProcessIdentity(previous.processStart) &&
    (previous.nativeId === null || current.nativeId === previous.nativeId)
  );
}

function provenPreEffectRefusal(started, attempt, descriptorPresent) {
  return (
    started?.ok === false &&
    started.unknown !== true &&
    PRE_EFFECT_CODES.has(started.code) &&
    !record(attempt) &&
    !descriptorPresent
  );
}

function provenProviderRefusal(started, binding, descriptorPath, attempt) {
  return (
    started?.code === 'CAPTURE_PROVIDER_REFUSED' &&
    started.noProviderEffect === true &&
    started.dispatched === false &&
    sameBinding(started.binding, binding) &&
    started.descriptorPath === descriptorPath &&
    Number.isSafeInteger(started.captureProcess?.pid) &&
    started.captureProcess.pid > 0 &&
    typeof started.captureProcess.processStartIdentity === 'string' &&
    started.captureProcess.processStartIdentity.length > 0 &&
    (!record(attempt) ||
      (exactAttempt(attempt, binding) &&
        ['failed', 'refused'].includes(attempt.status) &&
        attempt.processStart === null))
  );
}

function validateFactoryProcess(process) {
  if (
    !record(process) ||
    typeof process.start !== 'function' ||
    typeof process.reconnect !== 'function' ||
    typeof process.cancel !== 'function'
  ) {
    throw new TypeError(
      'createProcess must return start, reconnect, and cancel.'
    );
  }
  return process;
}

// A parent-side observer only. The detached child owns provider startup,
// capture, cancellation delivery, and deadlines; this adapter never resumes
// or starts a generic worker in the parent.
export function createSpansExecutionCapture({
  archiveRoot,
  authorize,
  createProcess,
  executionFor,
  exists = existsSync,
  limits,
  onExit,
  onHold = async () => undefined,
  pollIntervalMs = 250,
  resolveArchiveAdmission,
  resolveCapturePath,
  resolveSource,
  store,
  tempRoot,
  workerId,
} = {}) {
  if (
    typeof archiveRoot !== 'string' ||
    resolvePath(archiveRoot) !== archiveRoot ||
    typeof tempRoot !== 'string' ||
    resolvePath(tempRoot) !== tempRoot ||
    typeof workerId !== 'string' ||
    !ID.test(workerId) ||
    !record(limits) ||
    !Number.isSafeInteger(limits.maxDeadlineMs) ||
    limits.maxDeadlineMs <= 0 ||
    !record(store) ||
    typeof store.readRun !== 'function' ||
    typeof store.getEventById !== 'function' ||
    typeof authorize !== 'function' ||
    typeof resolveArchiveAdmission !== 'function' ||
    typeof executionFor !== 'function' ||
    typeof resolveSource !== 'function' ||
    typeof resolveCapturePath !== 'function' ||
    typeof createProcess !== 'function' ||
    typeof exists !== 'function' ||
    typeof onExit !== 'function' ||
    typeof onHold !== 'function' ||
    !Number.isSafeInteger(pollIntervalMs) ||
    pollIntervalMs < 10
  ) {
    throw new TypeError(
      'A trusted archive, capture process seam, and resolvers are required.'
    );
  }

  const starts = new Map();
  const awaitingLaunchAck = new Set();
  const recovered = new Set();
  const finalized = new Set();
  const incompleteRecorded = new Set();
  const watched = new Map();
  const unproven = new Map();
  const observing = new Map();
  const finalizing = new Map();
  const permits = new Set();
  const operations = new Set();
  function trackOperation(work) {
    const pending = Promise.resolve().then(work);
    operations.add(pending);
    pending.then(
      () => operations.delete(pending),
      () => operations.delete(pending)
    );
    return pending;
  }

  const processAuthorize = async ({ operation, binding } = {}) => {
    const key = record(binding) ? keyOf(binding) : null;
    if (operation === 'start' && key && permits.has(key)) {
      return { currentAttempt: true, ok: true };
    }
    try {
      return await authorize({ binding, operation });
    } catch {
      return { ok: false };
    }
  };

  const process = validateFactoryProcess(
    createProcess({
      archiveRoot,
      authorize: processAuthorize,
      limits,
      resolveArchiveAdmission,
      tempRoot,
      workerId,
    })
  );

  let closed = false;
  let timer = null;
  let timerWork = null;
  let shutdownWork = null;

  function descriptorFor(binding) {
    let path;
    try {
      path = resolveCapturePath({ archiveRoot, binding, tempRoot });
    } catch {
      return null;
    }
    return typeof path === 'string' &&
      resolvePath(path) === path &&
      path.startsWith(`${tempRoot}/`)
      ? path
      : null;
  }

  function readRun(binding) {
    try {
      const read = store.readRun({ runId: binding.runId });
      if (
        read?.ok !== true ||
        read.generation !== binding.generation ||
        read.view?.generation !== binding.generation
      ) {
        return null;
      }
      return read;
    } catch {
      return null;
    }
  }

  async function savedExecution(binding, read) {
    let execution;
    try {
      execution = await executionFor(binding);
    } catch {
      return null;
    }
    const saved = read?.view?.executions?.[binding.actionId];
    return record(execution) &&
      record(saved) &&
      isDeepStrictEqual(execution, saved) &&
      execution.runId === binding.runId &&
      execution.actionId === binding.actionId &&
      execution.attemptId === binding.attemptId &&
      execution.spanId === binding.spanId &&
      Number.isSafeInteger(execution.wallClockMs) &&
      execution.wallClockMs > 0 &&
      execution.wallClockMs <= limits.maxDeadlineMs &&
      reviewReference(execution, binding)
      ? execution
      : null;
  }

  function exactAction(read, binding) {
    const action = read?.view?.actions?.[binding.actionId];
    return sameAction(action, binding) && action.state === 'intent';
  }

  function parentCaptureEvent(binding, receipt) {
    const eventId = `spans.execution.captured:${sha256(
      JSON.stringify([binding.runId, binding.attemptId])
    )}`;
    try {
      const found = store.getEventById({ eventId });
      const event = found?.event;
      return (
        found?.ok === true &&
        found.found === true &&
        event?.eventId === eventId &&
        event.type === 'spans.execution.captured' &&
        event.runId === binding.runId &&
        event.payload?.actionId === binding.actionId &&
        event.payload?.attemptId === binding.attemptId &&
        event.payload?.spanId === binding.spanId &&
        event.payload?.artifactId === receipt.capture.artifactId &&
        isDeepStrictEqual(event.payload?.artifactIds, [
          receipt.capture.artifactId,
        ]) &&
        event.payload?.bytes === receipt.capture.bytes &&
        event.payload?.chunks === receipt.capture.chunks &&
        event.payload?.complete === receipt.capture.complete &&
        isDeepStrictEqual(event.payload?.exit, receipt.exit)
      );
    } catch {
      return false;
    }
  }

  function addWatch(binding) {
    const key = keyOf(binding);
    watched.set(key, binding);
    schedulePoll();
  }

  function markUnproven(binding, reason) {
    unproven.set(keyOf(binding), { binding, reason });
  }

  function clearUnproven(binding) {
    unproven.delete(keyOf(binding));
  }

  async function deliverTerminalEvidence(binding, attempt) {
    const evidence = terminalEvidence(attempt, binding);
    if (!evidence) {
      markUnproven(binding, 'terminal-receipt-unproven');
      return null;
    }
    const key = keyOf(binding);
    addWatch(binding);
    const { receipt, status, type } = evidence;
    if (type === 'complete' && finalized.has(key)) {
      watched.delete(key);
      clearUnproven(binding);
      return { parentFinalized: true, receipt, status };
    }
    if (type === 'held' && incompleteRecorded.has(key)) {
      if (!parentCaptureEvent(binding, receipt)) {
        markUnproven(binding, 'parent-capture-event-mismatch');
        return null;
      }
      watched.delete(key);
      markUnproven(binding, 'capture-held');
      return { evidenceRecorded: true, receipt, settled: false, status };
    }
    const pending = finalizing.get(key);
    if (pending) {
      return await pending;
    }
    const work = (async () => {
      let parentResult;
      try {
        parentResult = await onExit({
          binding,
          result: { ok: true, receipt, status },
        });
      } catch {
        markUnproven(binding, 'parent-finalization-unknown');
        return null;
      }
      const parentAcknowledged =
        type === 'complete'
          ? parentResult?.ok === true &&
            ['recorded', 'released'].includes(parentResult.status)
          : parentResult?.ok === true && parentResult.settled === false;
      if (!(parentAcknowledged && parentCaptureEvent(binding, receipt))) {
        markUnproven(binding, 'parent-finalization-unconfirmed');
        return null;
      }
      if (type === 'held') {
        incompleteRecorded.add(key);
        watched.delete(key);
        markUnproven(binding, 'capture-held');
        return { evidenceRecorded: true, receipt, settled: false, status };
      }
      finalized.add(key);
      watched.delete(key);
      clearUnproven(binding);
      return { parentFinalized: true, receipt, status };
    })();
    finalizing.set(key, work);
    try {
      return await work;
    } finally {
      if (finalizing.get(key) === work) {
        finalizing.delete(key);
      }
    }
  }

  function validReconnect(
    result,
    binding,
    descriptorPath,
    savedAttempt,
    allowHeldControl = false,
    previousAttempt = savedAttempt
  ) {
    if (
      !(
        reconnectEnvelopeMatches(result, binding, descriptorPath) &&
        reconnectProviderMatches(
          result,
          binding,
          savedAttempt,
          allowHeldControl
        )
      )
    ) {
      return false;
    }
    return reconnectNativeState(
      result,
      binding,
      savedAttempt,
      previousAttempt,
      allowHeldControl
    );
  }

  async function terminalResponse(binding, attempt) {
    const evidence = terminalEvidence(attempt, binding);
    if (!evidence) {
      return null;
    }
    if (awaitingLaunchAck.has(keyOf(binding))) {
      // Launch acknowledgment must not wait for parent outcome processing.
      addWatch(binding);
      return {
        ok: true,
        receipt: evidence.receipt,
        status: evidence.status,
        terminal: true,
      };
    }
    const delivered = await deliverTerminalEvidence(binding, attempt);
    return delivered
      ? { ...delivered, ok: true, terminal: true }
      : unknown('PARENT_FINALIZATION_UNKNOWN', {
          status: evidence.status,
          terminal: true,
        });
  }

  function captureDescriptorExists(path) {
    try {
      return Boolean(path && exists(path));
    } catch {
      // An unreadable descriptor observation cannot prove absence or ownership.
      return false;
    }
  }

  async function reconnectCaptureProcess(binding, descriptorPath) {
    let authorization;
    try {
      authorization = await authorize({ binding, operation: 'reconnect' });
    } catch {
      authorization = null;
    }
    if (
      !(authorization?.ok === true && authorization.currentAttempt === true)
    ) {
      return { code: 'ATTEMPT_AUTHORIZATION_UNKNOWN', ok: false };
    }
    try {
      return await process.reconnect({ binding, descriptorPath });
    } catch {
      return null;
    }
  }

  async function latestTerminalResponse(binding) {
    const latest = readRun(binding);
    return await terminalResponse(
      binding,
      latest?.view?.attempts?.[binding.attemptId]
    );
  }

  async function recordObservedHold(binding, attempt) {
    if (
      !awaitingLaunchAck.has(keyOf(binding)) &&
      exactAttempt(attempt, binding) &&
      attempt.status === 'held'
    ) {
      await onHold({ binding });
    }
  }

  async function observeCaptureProcess(binding, attempt, allowHeldControl) {
    const descriptorPath = descriptorFor(binding);
    if (!captureDescriptorExists(descriptorPath)) {
      markUnproven(binding, 'capture-descriptor-missing');
      return unknown('CAPTURE_DESCRIPTOR_UNKNOWN');
    }
    const result = await reconnectCaptureProcess(binding, descriptorPath);
    if (
      result?.ok === false &&
      result.code === 'ATTEMPT_AUTHORIZATION_UNKNOWN'
    ) {
      markUnproven(binding, 'owned-reconnect-not-authorized');
      return unknown('ATTEMPT_AUTHORIZATION_UNKNOWN');
    }
    const latest = readRun(binding);
    const latestAttempt = latest?.view?.attempts?.[binding.attemptId];
    await recordObservedHold(binding, latestAttempt);
    const terminal = await terminalResponse(binding, latestAttempt);
    if (terminal) {
      return terminal;
    }
    const proof = validReconnect(
      result,
      binding,
      descriptorPath,
      latestAttempt,
      allowHeldControl,
      attempt
    );
    if (!proof) {
      const ended = await latestTerminalResponse(binding);
      if (ended) {
        return ended;
      }
      markUnproven(binding, 'capture-process-proof-mismatch');
      return unknown('CAPTURE_PROCESS_PROOF_UNKNOWN');
    }
    if (!sameObservedProcess(latestAttempt, attempt, binding)) {
      markUnproven(binding, 'attempt-changed-during-observation');
      return unknown('ATTEMPT_CHANGED_DURING_OBSERVATION');
    }
    if (proof === 'observing') {
      clearUnproven(binding);
      return { ok: true, status: 'observing' };
    }
    if (allowHeldControl && latestAttempt.status === 'held') {
      markUnproven(binding, 'attempt-held-awaiting-exit');
      return { attempt: latestAttempt, ok: true, owned: true, status: 'held' };
    }
    clearUnproven(binding);
    return { attempt: latestAttempt, ok: true, status: 'running' };
  }

  async function observeBinding(binding, allowHeldControl = false) {
    if (closed) {
      return unknown('CAPTURE_ADAPTER_CLOSED');
    }
    const key = keyOf(binding);
    const current = readRun(binding);
    if (!current) {
      markUnproven(binding, 'archive-observation-unknown');
      return unknown('ARCHIVE_OBSERVATION_UNKNOWN');
    }
    const action = current.view.actions?.[binding.actionId];
    const attempt = current.view.attempts?.[binding.attemptId];
    if (!record(attempt)) {
      markUnproven(binding, 'attempt-not-durable');
      return unknown('ATTEMPT_NOT_DURABLE');
    }
    if (!(exactAttempt(attempt, binding) && sameAction(action, binding))) {
      markUnproven(binding, 'saved-binding-mismatch');
      return unknown('SAVED_BINDING_MISMATCH');
    }
    const terminal = await terminalResponse(binding, attempt);
    if (terminal) {
      return terminal;
    }
    const heldControl =
      allowHeldControl && attempt.status === 'held' && attempt.exit === null;
    if (!(OPEN_STATUSES.has(attempt.status) || heldControl)) {
      await recordObservedHold(binding, attempt);
      markUnproven(binding, 'attempt-held-or-nonterminal');
      watched.delete(key);
      return unknown('ATTEMPT_HELD', { status: attempt.status });
    }
    if (!validProcessStart(attempt.processStart)) {
      markUnproven(binding, 'provider-process-identity-missing');
      return unknown('PROCESS_IDENTITY_UNKNOWN');
    }
    return await observeCaptureProcess(binding, attempt, allowHeldControl);
  }

  function coalescedObserve(binding, allowHeldControl = false) {
    const key = `${keyOf(binding)}:${allowHeldControl ? 'held-control' : 'normal'}`;
    const current = observing.get(key);
    if (current) {
      return current;
    }
    const work = observeBinding(binding, allowHeldControl);
    observing.set(key, work);
    const clear = () => {
      if (observing.get(key) === work) {
        observing.delete(key);
      }
    };
    work.then(clear, clear);
    return work;
  }

  function schedulePoll() {
    if (closed || timer || watched.size === 0) {
      return;
    }
    timer = setTimeout(() => {
      timer = null;
      timerWork = Promise.allSettled(
        [...watched.values()].map((binding) => coalescedObserve(binding))
      ).finally(() => {
        timerWork = null;
        schedulePoll();
      });
    }, pollIntervalMs);
    timer.unref?.();
  }

  async function resolveFreshExecution(binding) {
    const read = readRun(binding);
    if (!(read && exactAction(read, binding))) {
      return null;
    }
    const execution = await savedExecution(binding, read);
    if (!execution) {
      return null;
    }
    return { execution, read };
  }

  async function resolveLaunchSource(binding, execution) {
    let resolved;
    try {
      resolved = await resolveSource({ binding, execution });
    } catch {
      return null;
    }
    const source = sourceForProcess(resolved);
    return source;
  }

  function descriptorPresence(path) {
    try {
      return Boolean(path && exists(path));
    } catch {
      return null;
    }
  }

  async function observeExistingStart(binding, fallbackCode) {
    const key = keyOf(binding);
    recovered.add(key);
    addWatch(binding);
    const observed = await coalescedObserve(binding);
    return observed.ok === true
      ? { ...observed, created: false, existing: true }
      : unknown(observed.code ?? fallbackCode, { existing: true });
  }

  async function prepareFreshDispatch(binding) {
    const inputs = await resolveFreshExecution(binding);
    if (!inputs) {
      return unknown('EXECUTION_RECORD_UNAVAILABLE');
    }

    let authorization;
    try {
      authorization = await authorize({
        binding,
        execution: inputs.execution,
        operation: 'start',
      });
    } catch {
      authorization = null;
    }
    if (authorization?.ok !== true) {
      return authorization?.noEffect === true
        ? fail('ATTEMPT_AUTHORIZATION_REFUSED', { dispatched: false })
        : unknown('ATTEMPT_AUTHORIZATION_UNKNOWN');
    }
    // This in-memory permit cannot be reconstructed from a saved intent.
    if (authorization.freshDispatch !== true) {
      return unknown('FRESH_DISPATCH_NOT_PROVEN');
    }

    const source = await resolveLaunchSource(binding, inputs.execution);
    if (!source) {
      return fail('LAUNCH_SOURCE_UNAVAILABLE', { dispatched: false });
    }
    const current = readRun(binding);
    if (
      !(
        current &&
        current.generation === inputs.read.generation &&
        exactAction(current, binding) &&
        !record(current.view.attempts?.[binding.attemptId])
      )
    ) {
      return unknown('ATTEMPT_AUTHORITY_CHANGED');
    }

    return { inputs, ok: true, source };
  }

  async function launchFreshCapture(binding, prepared) {
    const key = keyOf(binding);
    const { inputs, source } = prepared;
    permits.add(key);
    try {
      return await process.start({
        binding,
        executionReview: reviewReference(inputs.execution, binding),
        limits,
        source,
        start: { ...binding, deadlineMs: inputs.execution.wallClockMs },
      });
    } catch {
      return null;
    } finally {
      permits.delete(key);
    }
  }

  async function confirmFreshCaptureStart(binding, descriptorPath, started) {
    if (closed) {
      return unknown('CAPTURE_ADAPTER_CLOSED');
    }
    const key = keyOf(binding);
    const after = readRun(binding);
    const attempt = after?.view?.attempts?.[binding.attemptId];
    const descriptorPresent = descriptorPresence(descriptorPath) !== false;
    if (provenProviderRefusal(started, binding, descriptorPath, attempt)) {
      return fail('CAPTURE_PROVIDER_REFUSED', { dispatched: false });
    }
    if (provenPreEffectRefusal(started, attempt, descriptorPresent)) {
      return fail(started.code, { dispatched: false });
    }
    if (!record(attempt)) {
      addWatch(binding);
      markUnproven(binding, 'start-effect-may-have-occurred');
      return unknown(started?.code ?? 'CAPTURE_START_UNKNOWN');
    }
    if (terminalEvidence(attempt, binding)) {
      addWatch(binding);
      return {
        actionId: binding.actionId,
        attemptId: binding.attemptId,
        created: true,
        dispatched: true,
        ok: true,
        status: 'captured',
        workerId,
      };
    }
    if (
      !(
        exactAttempt(attempt, binding) &&
        OPEN_STATUSES.has(attempt.status) &&
        validProcessStart(attempt.processStart)
      )
    ) {
      recovered.add(key);
      addWatch(binding);
      markUnproven(binding, 'started-attempt-not-running');
      return unknown('CAPTURE_START_UNCONFIRMED', { existing: true });
    }
    return await confirmRunningCaptureStart(binding);
  }

  async function confirmRunningCaptureStart(binding) {
    recovered.add(keyOf(binding));
    addWatch(binding);
    let observed = await coalescedObserve(binding);
    if (observed.ok === true && observed.status === 'observing') {
      observed = await coalescedObserve(binding);
    }
    // The worker may finish while the running observation is in flight.
    const current = readRun(binding)?.view?.attempts?.[binding.attemptId];
    if (terminalEvidence(current, binding)) {
      return {
        actionId: binding.actionId,
        attemptId: binding.attemptId,
        created: true,
        dispatched: true,
        ok: true,
        status: 'captured',
        workerId,
      };
    }
    if (
      !(
        observed.ok === true &&
        ['running', 'observing'].includes(observed.status)
      )
    ) {
      return unknown(observed.code ?? 'CAPTURE_START_UNCONFIRMED', {
        existing: true,
      });
    }
    return {
      actionId: binding.actionId,
      attemptId: binding.attemptId,
      created: true,
      dispatched: true,
      ok: true,
      status: observed.status,
      workerId,
    };
  }

  async function startOnce(binding) {
    const initial = readRun(binding);
    if (!(initial && exactAction(initial, binding))) {
      return unknown('ACTION_INTENT_NOT_CONFIRMED');
    }
    const priorAttempt = initial.view.attempts?.[binding.attemptId];
    const descriptorPath = descriptorFor(binding);
    if (record(priorAttempt) || !descriptorPath) {
      return await observeExistingStart(binding, 'ATTEMPT_ALREADY_STARTED');
    }
    const hasDescriptor = descriptorPresence(descriptorPath);
    if (hasDescriptor === null) {
      return unknown('CAPTURE_DESCRIPTOR_UNKNOWN');
    }
    if (hasDescriptor) {
      return await observeExistingStart(binding, 'CAPTURE_DESCRIPTOR_EXISTS');
    }

    const prepared = await prepareFreshDispatch(binding);
    if (prepared.ok !== true) {
      return prepared;
    }
    const key = keyOf(binding);
    awaitingLaunchAck.add(key);
    try {
      const started = await launchFreshCapture(binding, prepared);
      return await confirmFreshCaptureStart(binding, descriptorPath, started);
    } finally {
      awaitingLaunchAck.delete(key);
    }
  }

  async function start(input) {
    const binding = snapshotBinding(input, workerId);
    if (!binding) {
      return fail('CAPTURE_BINDING_INVALID');
    }
    const key = keyOf(binding);
    const current = starts.get(key);
    if (current instanceof Promise) {
      return await current;
    }
    if (current || recovered.has(key)) {
      return await observeExistingStart(binding, 'ATTEMPT_RECOVERY_UNKNOWN');
    }
    const pending = startOnce(binding);
    starts.set(key, pending);
    const result = await pending;
    if (result.dispatched === false) {
      starts.delete(key);
    } else if (starts.get(key) === pending) {
      starts.set(key, result);
    }
    return result;
  }

  async function recover(input) {
    const binding = snapshotBinding(input, workerId);
    if (!binding) {
      return fail('CAPTURE_BINDING_INVALID');
    }
    if (closed) {
      return unknown('CAPTURE_ADAPTER_CLOSED');
    }
    const key = keyOf(binding);
    recovered.add(key);
    const read = readRun(binding);
    const attempt = read?.view?.attempts?.[binding.attemptId];
    if (!record(attempt)) {
      markUnproven(binding, 'attempt-not-durable');
      return unknown('ATTEMPT_NOT_DURABLE');
    }
    if (!exactAttempt(attempt, binding)) {
      markUnproven(binding, 'saved-binding-mismatch');
      return unknown('SAVED_BINDING_MISMATCH');
    }
    const evidence = terminalEvidence(attempt, binding);
    if (evidence) {
      addWatch(binding);
      const delivered = await deliverTerminalEvidence(binding, attempt);
      return delivered
        ? { ...delivered, ok: true, terminal: true }
        : unknown('PARENT_FINALIZATION_UNKNOWN', {
            status: evidence.status,
            terminal: true,
          });
    }
    if (!OPEN_STATUSES.has(attempt.status)) {
      markUnproven(binding, 'attempt-held-or-nonterminal');
      return unknown('ATTEMPT_HELD', { status: attempt.status });
    }
    addWatch(binding);
    return await coalescedObserve(binding);
  }

  function requestedProcessStartId(input) {
    if (!record(input) || utilTypes.isProxy(input)) {
      return null;
    }
    try {
      const property = Object.getOwnPropertyDescriptor(input, 'processStartId');
      return property && Object.hasOwn(property, 'value')
        ? property.value
        : null;
    } catch {
      return null;
    }
  }

  function cancellationProof(attempt, processStartId) {
    const heldAwaitingExit = attempt.status === 'held' && attempt.exit === null;
    const ownedAttemptCanStop =
      (OPEN_STATUSES.has(attempt.status) || heldAwaitingExit) &&
      validProcessStart(attempt.processStart) &&
      processStartId === attempt.processStart.id;
    return { heldAwaitingExit, ownedAttemptCanStop };
  }

  async function authorizeOwnedCancellation(binding) {
    let authorization;
    try {
      authorization = await authorize({ binding, operation: 'cancel' });
    } catch {
      authorization = null;
    }
    return authorization?.ok === true && authorization.currentAttempt === true;
  }

  async function observeOwnedCaptureForCancellation(binding, heldAwaitingExit) {
    let observed = await coalescedObserve(binding, heldAwaitingExit);
    if (observed.ok === true && observed.status === 'observing') {
      observed = await coalescedObserve(binding, heldAwaitingExit);
    }
    return observed.ok === true &&
      (observed.status === 'running' ||
        (heldAwaitingExit &&
          observed.status === 'held' &&
          observed.owned === true))
      ? observed
      : unknown(observed.code ?? 'CAPTURE_PROCESS_PROOF_UNKNOWN');
  }

  async function sendOwnedCancellation(binding, descriptorPath) {
    let result;
    try {
      result = await process.cancel({ binding, descriptorPath });
    } catch {
      result = null;
    }
    return result?.ok === true &&
      ['requested', 'delivered', 'unknown', 'none'].includes(result.cancel)
      ? result
      : unknown('CAPTURE_CANCEL_UNKNOWN', { cancel: 'unknown' });
  }

  function resolveCancellationTarget(input) {
    const binding = snapshotBinding(input, workerId);
    if (!binding || closed) {
      return {
        response: unknown(
          closed ? 'CAPTURE_ADAPTER_CLOSED' : 'CAPTURE_BINDING_INVALID',
          { cancel: 'unknown' }
        ),
      };
    }
    const read = readRun(binding);
    const attempt = read?.view?.attempts?.[binding.attemptId];
    if (!exactAttempt(attempt, binding)) {
      return {
        response: unknown('SAVED_BINDING_MISMATCH', { cancel: 'unknown' }),
      };
    }
    const evidence = terminalEvidence(attempt, binding);
    if (evidence) {
      return {
        response: {
          cancel: 'none',
          ok: true,
          status: evidence.status,
          terminal: true,
        },
      };
    }
    return { attempt, binding };
  }

  async function cancel(input) {
    const target = resolveCancellationTarget(input);
    if (Object.hasOwn(target, 'response')) {
      return target.response;
    }
    const { binding, attempt } = target;
    const { heldAwaitingExit, ownedAttemptCanStop } = cancellationProof(
      attempt,
      requestedProcessStartId(input)
    );
    if (!ownedAttemptCanStop) {
      return unknown('PROCESS_IDENTITY_UNKNOWN', { cancel: 'unknown' });
    }
    if (heldAwaitingExit && attempt.cancel?.state === 'delivered') {
      return {
        cancel: 'delivered',
        duplicate: true,
        ok: true,
        terminal: false,
      };
    }
    const descriptorPath = descriptorFor(binding);
    if (!captureDescriptorExists(descriptorPath)) {
      return unknown('CAPTURE_DESCRIPTOR_UNKNOWN', { cancel: 'unknown' });
    }
    if (!(await authorizeOwnedCancellation(binding))) {
      return unknown('ATTEMPT_AUTHORIZATION_UNKNOWN', { cancel: 'unknown' });
    }
    const observed = await observeOwnedCaptureForCancellation(
      binding,
      heldAwaitingExit
    );
    if (observed.ok !== true) {
      return unknown(observed.code ?? 'CAPTURE_PROCESS_PROOF_UNKNOWN', {
        cancel: 'unknown',
      });
    }
    return await sendOwnedCancellation(binding, descriptorPath);
  }

  async function observe(input) {
    const binding = snapshotBinding(input, workerId);
    if (!binding) {
      return fail('CAPTURE_BINDING_INVALID');
    }
    return await coalescedObserve(binding);
  }

  async function idle() {
    if (closed) {
      return {
        closed: true,
        ok: unproven.size === 0,
        unproven: [...unproven.values()],
      };
    }
    for (;;) {
      if (closed) {
        return {
          closed: true,
          ok: unproven.size === 0,
          unproven: [...unproven.values()],
        };
      }
      // Each idle pass waits for its current observation batch before deciding
      // whether another pass is needed; don't overlap polling iterations.
      // biome-ignore lint/performance/noAwaitInLoops: Polling waits for this pass to settle before starting the next one.
      await Promise.allSettled(
        [...watched.values()].map((binding) => coalescedObserve(binding))
      );
      await Promise.allSettled([...finalizing.values()]);
      if (unproven.size > 0) {
        return { ok: false, unproven: [...unproven.values()] };
      }
      if (watched.size === 0) {
        return { ok: true, unproven: [] };
      }
      await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
    }
  }

  async function shutdown() {
    if (shutdownWork) {
      return await shutdownWork;
    }
    closed = true;
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    shutdownWork = (async () => {
      for (;;) {
        const active = [
          ...operations,
          ...observing.values(),
          ...(timerWork ? [timerWork] : []),
          ...finalizing.values(),
          ...[...starts.values()].filter(
            (promise) => promise instanceof Promise
          ),
        ];
        if (active.length === 0) {
          break;
        }
        // These are already active operations; rebuild the drain set only after
        // every operation in this snapshot has settled.
        // biome-ignore lint/performance/noAwaitInLoops: Shutdown drains one stable snapshot before checking for newly tracked work.
        await Promise.allSettled(active);
      }
      try {
        await process.close?.();
      } catch {
        // Closing the parent control object never changes child ownership.
      }
      return { ok: true };
    })();
    return await shutdownWork;
  }

  return Object.freeze({
    cancel: (input) => trackOperation(() => cancel(input)),
    idle: () => trackOperation(idle),
    observe: (input) => trackOperation(() => observe(input)),
    recover: (input) => trackOperation(() => recover(input)),
    shutdown,
    start: (input) => trackOperation(() => start(input)),
  });
}
