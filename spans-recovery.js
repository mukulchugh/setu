import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { isAbsolute, resolve } from 'node:path';
import { redactSpansValue } from './spans-redaction.js';

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const OUTCOMES = new Set(['completed', 'failed', 'unknown']);
const PROCESS_STATES = new Set(['alive', 'absent', 'unknown']);
const HEX_DIGEST = /^[0-9a-f]{64}$/;
const MAX_JSON_DEPTH = 16;
const MAX_JSON_NODES = 2048;
const MAX_STRING_LENGTH = 4096;
const MAX_JSON_BYTES = 16 * 1024;
// Reject terminal and C0 control bytes in persisted process identities and paths.
// biome-ignore lint/suspicious/noControlCharactersInRegex: rejecting controls is a recovery identity security boundary
const CONTROL_CHARACTER = /[\x00-\x1f\x7f]/;
const DECIMAL_NONNEGATIVE = /^(?:0|[1-9][0-9]*)$/;
const DECIMAL_POSITIVE = /^[1-9][0-9]*$/;

const ERRORS = Object.freeze({
  ATTEMPT_GENERATION_AHEAD:
    'The attempt generation is ahead of the current durable run generation.',
  INPUT_INVALID: 'Recovery input is malformed or exceeds its bounds.',
  RECEIPT_CONFLICT: 'The persisted and observed terminal receipts contradict.',
});

const fail = (code) => ({ code, error: ERRORS[code], ok: false });
const isRecord = (value) =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const isGeneration = (value) => Number.isSafeInteger(value) && value >= 0;
const isTime = (value) => Number.isSafeInteger(value) && value >= 0;

function accountJsonBytes(state, text) {
  state.bytes += Buffer.byteLength(text, 'utf8');
  if (state.bytes > MAX_JSON_BYTES) {
    throw new TypeError('bounded JSON byte limit exceeded');
  }
}

function safeRecord(value, allowed, required = []) {
  if (!isRecord(value)) {
    return null;
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    return null;
  }
  const keys = Reflect.ownKeys(value);
  if (
    keys.some((key) => typeof key !== 'string' || !allowed.has(key)) ||
    required.some((key) => !keys.includes(key))
  ) {
    return null;
  }
  const result = Object.create(null);
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!(descriptor?.enumerable && 'value' in descriptor)) {
      return null;
    }
    result[key] = descriptor.value;
  }
  return result;
}

function boundedJsonArray(value, state, depth) {
  if (
    Object.getPrototypeOf(value) !== Array.prototype ||
    Reflect.ownKeys(value).length !== value.length + 1
  ) {
    throw new TypeError('non-plain array');
  }
  const result = [];
  accountJsonBytes(state, '[');
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!(descriptor?.enumerable && 'value' in descriptor)) {
      throw new TypeError('array accessor or hole');
    }
    if (index > 0) {
      accountJsonBytes(state, ',');
    }
    result.push(boundedJson(descriptor.value, state, depth + 1));
  }
  accountJsonBytes(state, ']');
  return result;
}

function boundedJsonObject(value, state, depth) {
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError('non-plain object');
  }
  const keys = Reflect.ownKeys(value);
  if (keys.some((key) => typeof key !== 'string')) {
    throw new TypeError('symbol key');
  }
  const result = Object.create(null);
  accountJsonBytes(state, '{');
  for (const [index, key] of keys.entries()) {
    if (key.length > MAX_STRING_LENGTH) {
      throw new TypeError('bounded property name limit exceeded');
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!(descriptor?.enumerable && 'value' in descriptor)) {
      throw new TypeError('object accessor');
    }
    if (index > 0) {
      accountJsonBytes(state, ',');
    }
    accountJsonBytes(state, `${JSON.stringify(key)}:`);
    result[key] = boundedJson(descriptor.value, state, depth + 1);
  }
  accountJsonBytes(state, '}');
  return result;
}

function boundedJson(value, state = { bytes: 0, nodes: 0 }, depth = 0) {
  state.nodes += 1;
  if (state.nodes > MAX_JSON_NODES || depth > MAX_JSON_DEPTH) {
    throw new TypeError('bounded JSON limit exceeded');
  }
  if (value === null || typeof value === 'boolean') {
    accountJsonBytes(state, JSON.stringify(value));
    return value;
  }
  if (typeof value === 'string') {
    if (value.length > MAX_STRING_LENGTH) {
      throw new TypeError('bounded string limit exceeded');
    }
    accountJsonBytes(state, JSON.stringify(value));
    return value;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new TypeError('non-finite number');
    }
    accountJsonBytes(state, JSON.stringify(value));
    return value;
  }
  if (Array.isArray(value)) {
    return boundedJsonArray(value, state, depth);
  }
  if (!isRecord(value)) {
    throw new TypeError('non-plain object');
  }
  return boundedJsonObject(value, state, depth);
}

function canonical(value) {
  if (Array.isArray(value)) {
    return `[${value.map(canonical).join(',')}]`;
  }
  if (isRecord(value)) {
    const keys = Object.keys(value).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

const digest = (value) =>
  createHash('sha256').update(canonical(value)).digest('hex');

function validId(value) {
  return (
    typeof value === 'string' &&
    ID_PATTERN.test(value) &&
    redactSpansValue(value) === value
  );
}

function validStartIdentity(value) {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 200 &&
    value.trim() === value &&
    !CONTROL_CHARACTER.test(value) &&
    redactSpansValue(value) === value
  );
}

function validFingerprint(value) {
  const fingerprint = safeRecord(
    value,
    new Set(['birthtimeNs', 'dev', 'ino']),
    ['birthtimeNs', 'dev', 'ino']
  );
  return Boolean(
    fingerprint &&
      Object.keys(fingerprint).length === 3 &&
      typeof fingerprint.dev === 'string' &&
      DECIMAL_NONNEGATIVE.test(fingerprint.dev) &&
      typeof fingerprint.ino === 'string' &&
      DECIMAL_POSITIVE.test(fingerprint.ino) &&
      typeof fingerprint.birthtimeNs === 'string' &&
      DECIMAL_POSITIVE.test(fingerprint.birthtimeNs)
  );
}

function validCanonicalPath(value) {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= MAX_STRING_LENGTH &&
    !CONTROL_CHARACTER.test(value) &&
    isAbsolute(value) &&
    resolve(value) === value
  );
}

function checkoutInfo(value, expectedRunId) {
  try {
    const copy = boundedJson(value);
    if (!isRecord(copy)) {
      return { digest: null, valid: false };
    }
    if (copy.kind === 'non-code') {
      const identity = safeRecord(copy, new Set(['kind', 'runId', 'scopeId']), [
        'kind',
        'runId',
        'scopeId',
      ]);
      const valid = Boolean(
        identity &&
          Object.keys(identity).length === 3 &&
          identity.kind === 'non-code' &&
          validId(identity.runId) &&
          identity.runId === expectedRunId &&
          validId(identity.scopeId)
      );
      return valid
        ? { digest: digest(identity), valid: true }
        : { digest: null, valid: false };
    }
    if (copy.known === false) {
      const unknown = safeRecord(copy, new Set(['known', 'reason']), [
        'known',
        'reason',
      ]);
      return unknown &&
        Object.keys(unknown).length === 2 &&
        unknown.known === false &&
        typeof unknown.reason === 'string' &&
        unknown.reason.length > 0 &&
        unknown.reason.length <= 256
        ? { digest: null, valid: true }
        : { digest: null, valid: false };
    }
    const identity = safeRecord(
      copy,
      new Set([
        'admin',
        'adminPath',
        'checkout',
        'checkoutPath',
        'known',
        'repository',
        'repositoryPath',
      ]),
      [
        'admin',
        'adminPath',
        'checkout',
        'checkoutPath',
        'known',
        'repository',
        'repositoryPath',
      ]
    );
    if (
      !identity ||
      Object.keys(identity).length !== 7 ||
      identity.known !== true ||
      !validFingerprint(identity.admin) ||
      !validFingerprint(identity.checkout) ||
      !validFingerprint(identity.repository) ||
      !validCanonicalPath(identity.adminPath) ||
      !validCanonicalPath(identity.checkoutPath) ||
      !validCanonicalPath(identity.repositoryPath)
    ) {
      return { digest: null, valid: false };
    }
    return { digest: digest(identity), valid: true };
  } catch {
    return { digest: null, valid: false };
  }
}

function normalizeWorker(value) {
  const worker = safeRecord(
    value,
    new Set(['processId', 'processStartIdentity']),
    ['processId', 'processStartIdentity']
  );
  if (!worker) {
    return null;
  }
  if (worker.processId === null && worker.processStartIdentity === null) {
    return { processId: null, processStartIdentity: null };
  }
  if (
    !Number.isSafeInteger(worker.processId) ||
    worker.processId <= 0 ||
    !validStartIdentity(worker.processStartIdentity)
  ) {
    return null;
  }
  return worker;
}

function normalizeBase(value) {
  const base = safeRecord(
    value,
    new Set([
      'actionId',
      'attemptId',
      'checkoutIdentity',
      'generation',
      'nativeSessionId',
      'runId',
      'spanId',
      'worker',
    ]),
    [
      'actionId',
      'attemptId',
      'checkoutIdentity',
      'generation',
      'nativeSessionId',
      'runId',
      'spanId',
      'worker',
    ]
  );
  if (
    !(
      base &&
      ['actionId', 'attemptId', 'runId', 'spanId'].every((key) =>
        validId(base[key])
      ) &&
      isGeneration(base.generation) &&
      (base.nativeSessionId === null || validId(base.nativeSessionId))
    )
  ) {
    return null;
  }
  const worker = normalizeWorker(base.worker);
  const checkout = checkoutInfo(base.checkoutIdentity, base.runId);
  if (!(worker && checkout.valid)) {
    return null;
  }
  return {
    ...base,
    checkout: checkout.digest,
    nativeSessionId: base.nativeSessionId ?? null,
    worker,
  };
}

function normalizeReceipt(value) {
  const receipt = safeRecord(
    value,
    new Set([
      'actionId',
      'attemptId',
      'checkoutIdentity',
      'generation',
      'nativeSessionId',
      'outcome',
      'receiptId',
      'runId',
      'spanId',
      'worker',
    ]),
    [
      'actionId',
      'attemptId',
      'checkoutIdentity',
      'generation',
      'nativeSessionId',
      'outcome',
      'receiptId',
      'runId',
      'spanId',
      'worker',
    ]
  );
  if (
    !(receipt && validId(receipt.receiptId) && OUTCOMES.has(receipt.outcome))
  ) {
    return null;
  }
  const base = normalizeBase({
    actionId: receipt.actionId,
    attemptId: receipt.attemptId,
    checkoutIdentity: receipt.checkoutIdentity,
    generation: receipt.generation,
    nativeSessionId: receipt.nativeSessionId,
    runId: receipt.runId,
    spanId: receipt.spanId,
    worker: receipt.worker,
  });
  if (!base || base.worker.processId === null) {
    return null;
  }
  return {
    actionId: base.actionId,
    attemptId: base.attemptId,
    checkout: base.checkout,
    generation: base.generation,
    nativeSessionId: base.nativeSessionId,
    outcome: receipt.outcome,
    receiptId: receipt.receiptId,
    runId: base.runId,
    spanId: base.spanId,
    worker: base.worker,
  };
}

function normalizeVerification(value) {
  const verification = safeRecord(
    value,
    new Set(['evidenceId', 'receiptDigest', 'verified']),
    ['evidenceId', 'receiptDigest', 'verified']
  );
  if (
    verification?.verified !== true ||
    !validId(verification.evidenceId) ||
    typeof verification.receiptDigest !== 'string' ||
    !HEX_DIGEST.test(verification.receiptDigest)
  ) {
    return null;
  }
  return verification;
}

function matchesBase(candidate, base) {
  return (
    candidate.runId === base.runId &&
    candidate.spanId === base.spanId &&
    candidate.actionId === base.actionId &&
    candidate.attemptId === base.attemptId &&
    candidate.generation === base.generation &&
    candidate.checkout === base.checkout &&
    candidate.nativeSessionId === base.nativeSessionId &&
    candidate.worker.processId === base.worker.processId &&
    candidate.worker.processStartIdentity === base.worker.processStartIdentity
  );
}

function normalizeObservation(value) {
  const observation = safeRecord(
    value,
    new Set([
      'ownerIdentity',
      'processId',
      'processStartIdentity',
      'state',
      'terminalReceipt',
      'terminalVerification',
    ]),
    ['state']
  );
  if (!(observation && PROCESS_STATES.has(observation.state))) {
    return null;
  }
  let worker = null;
  if (
    (observation.processId !== undefined ||
      observation.processStartIdentity !== undefined) &&
    observation.processId !== undefined &&
    observation.processStartIdentity !== undefined
  ) {
    worker = normalizeWorker({
      processId: observation.processId,
      processStartIdentity: observation.processStartIdentity,
    });
    if (!worker) {
      return null;
    }
    if (worker.processId === null) {
      worker = null;
    }
  }
  const ownerIdentity =
    observation.ownerIdentity === undefined
      ? null
      : normalizeBase(observation.ownerIdentity);
  if (observation.ownerIdentity !== undefined && !ownerIdentity) {
    return null;
  }
  const terminalReceipt =
    observation.terminalReceipt === undefined
      ? null
      : normalizeReceipt(observation.terminalReceipt);
  if (observation.terminalReceipt !== undefined && !terminalReceipt) {
    return null;
  }
  const terminalVerification =
    observation.terminalVerification === undefined
      ? null
      : normalizeVerification(observation.terminalVerification);
  if (observation.terminalVerification !== undefined && !terminalVerification) {
    return null;
  }
  return {
    ownerIdentity,
    state: observation.state,
    terminalReceipt,
    terminalVerification,
    worker,
  };
}

function normalizeClock(value) {
  const clock = safeRecord(value, new Set(['sleepWakeGap', 'wallTimeMs']), [
    'sleepWakeGap',
    'wallTimeMs',
  ]);
  if (
    !(
      clock &&
      (clock.wallTimeMs === null || isTime(clock.wallTimeMs)) &&
      [true, false, null].includes(clock.sleepWakeGap)
    )
  ) {
    return null;
  }
  return clock;
}

function normalizeAttemptReceipt(value) {
  const receipt = safeRecord(
    value,
    new Set([
      'actionId',
      'attemptId',
      'checkoutIdentity',
      'deadlineAtMs',
      'generation',
      'lastObservedWallTimeMs',
      'nativeSessionId',
      'runId',
      'spanId',
      'terminalReceipt',
      'terminalVerification',
      'worker',
    ]),
    [
      'actionId',
      'attemptId',
      'checkoutIdentity',
      'deadlineAtMs',
      'generation',
      'lastObservedWallTimeMs',
      'nativeSessionId',
      'runId',
      'spanId',
      'worker',
    ]
  );
  if (
    !(
      receipt &&
      (receipt.deadlineAtMs === null || isTime(receipt.deadlineAtMs)) &&
      (receipt.lastObservedWallTimeMs === null ||
        isTime(receipt.lastObservedWallTimeMs))
    )
  ) {
    return null;
  }
  const base = normalizeBase({
    actionId: receipt.actionId,
    attemptId: receipt.attemptId,
    checkoutIdentity: receipt.checkoutIdentity,
    generation: receipt.generation,
    nativeSessionId: receipt.nativeSessionId,
    runId: receipt.runId,
    spanId: receipt.spanId,
    worker: receipt.worker,
  });
  if (!base) {
    return null;
  }
  const terminalReceipt =
    receipt.terminalReceipt === undefined || receipt.terminalReceipt === null
      ? null
      : normalizeReceipt(receipt.terminalReceipt);
  const terminalVerification =
    receipt.terminalVerification === undefined ||
    receipt.terminalVerification === null
      ? null
      : normalizeVerification(receipt.terminalVerification);
  if (
    (receipt.terminalReceipt !== undefined &&
      receipt.terminalReceipt !== null &&
      !terminalReceipt) ||
    (receipt.terminalVerification !== undefined &&
      receipt.terminalVerification !== null &&
      !terminalVerification)
  ) {
    return null;
  }
  return {
    ...base,
    deadlineAtMs: receipt.deadlineAtMs ?? null,
    lastObservedWallTimeMs: receipt.lastObservedWallTimeMs ?? null,
    terminalReceipt,
    terminalVerification,
  };
}

function receiptState(receipt, verification) {
  if (!(receipt && verification)) {
    return null;
  }
  const receiptDigest = digest(receipt);
  if (verification.receiptDigest !== receiptDigest) {
    return null;
  }
  return { evidenceId: verification.evidenceId, receiptDigest };
}

/** Return the stable digest a trusted verifier must bind its receipt evidence to. */
export function digestSpansRecoveryReceipt(value) {
  try {
    const receipt = normalizeReceipt(boundedJson(value));
    return receipt
      ? { ok: true, receiptDigest: digest(receipt) }
      : fail('INPUT_INVALID');
  } catch {
    return fail('INPUT_INVALID');
  }
}

function eventFor({
  actionId,
  attemptGeneration,
  attemptId,
  checkout,
  currentGeneration,
  decision,
  historical,
  nativeSessionId,
  outcome,
  reason,
  receiptDigest,
  runId,
  status,
  workerState,
  deadlineElapsed,
}) {
  const payload = {
    actionId,
    attemptGeneration,
    attemptId,
    checkoutDigest: checkout,
    currentGeneration,
    ...(deadlineElapsed === undefined ? {} : { deadlineElapsed }),
    decision,
    ...(historical ? { historical: true } : {}),
    nativeSessionDigest: digest(nativeSessionId),
    status,
    ...(reason ? { reason } : {}),
    ...(workerState ? { workerState } : {}),
    ...(outcome ? { outcome } : {}),
    ...(receiptDigest ? { receiptDigest } : {}),
  };
  const type = historical
    ? 'spans.recovery.stale'
    : 'spans.recovery.reconciled';
  const eventId = `${type}:${digest([runId, payload])}`;
  return redactSpansValue({
    eventId,
    payload,
    runId,
    type,
  });
}

function success(base, currentGeneration, status, decision, details = {}) {
  const event = eventFor({
    actionId: base.actionId,
    attemptGeneration: base.generation,
    attemptId: base.attemptId,
    checkout: base.checkout,
    currentGeneration,
    deadlineElapsed: details.deadlineElapsed,
    decision,
    historical: status === 'stale',
    nativeSessionId: base.nativeSessionId,
    outcome: details.outcome,
    reason: details.reason,
    receiptDigest: details.receiptDigest,
    runId: base.runId,
    status,
    workerState: details.workerState,
  });
  return {
    commitMode: status === 'stale' ? 'historical' : 'cas',
    decision,
    events: [event],
    ok: true,
    status,
    ...(details.outcome ? { outcome: details.outcome } : {}),
    ...(details.reason ? { reason: details.reason } : {}),
    ...(details.workerState ? { workerState: details.workerState } : {}),
    ...(details.deadlineElapsed === undefined
      ? {}
      : { deadlineElapsed: details.deadlineElapsed }),
    ...(details.proposal ? { proposal: details.proposal } : {}),
    ...(details.duplicate ? { duplicate: true } : {}),
  };
}

function verifiedTerminalResult(
  attempt,
  currentGeneration,
  receipt,
  proof,
  { duplicate = false, includeReceiptDigest = true, record, workerState } = {}
) {
  if (receipt.outcome === 'unknown') {
    return success(attempt, currentGeneration, 'unknown', 'hold-pending', {
      ...(duplicate ? { duplicate: true } : {}),
      outcome: 'unknown',
      reason: 'terminal-receipt-reports-unknown',
      ...(includeReceiptDigest ? { receiptDigest: proof.receiptDigest } : {}),
      workerState,
    });
  }
  return success(
    attempt,
    currentGeneration,
    'terminal-recorded',
    record ? 'record-terminal' : 'replay-terminal',
    {
      ...(duplicate ? { duplicate: true } : {}),
      outcome: receipt.outcome,
      receiptDigest: proof.receiptDigest,
      ...(record
        ? {
            proposal: {
              actionId: attempt.actionId,
              attemptId: attempt.attemptId,
              evidenceId: proof.evidenceId,
              outcome: receipt.outcome,
              receiptDigest: proof.receiptDigest,
            },
          }
        : {}),
    }
  );
}

function parseRecoveryInput(input) {
  const inputCopy = boundedJson(input);
  const request = safeRecord(
    inputCopy,
    new Set([
      'attemptReceipt',
      'clock',
      'currentCheckoutIdentity',
      'currentGeneration',
      'processObservation',
    ]),
    [
      'attemptReceipt',
      'clock',
      'currentCheckoutIdentity',
      'currentGeneration',
      'processObservation',
    ]
  );
  if (!(request && isGeneration(request.currentGeneration))) {
    return { result: fail('INPUT_INVALID') };
  }
  const attempt = normalizeAttemptReceipt(request.attemptReceipt);
  return attempt
    ? { attempt, request, result: null }
    : { result: fail('INPUT_INVALID') };
}

function identityGate(attempt, generation, currentCheckout, observation) {
  if (attempt.checkout === null || currentCheckout.digest === null) {
    return success(attempt, generation, 'unknown', 'hold-pending', {
      reason: 'checkout-identity-missing',
      workerState: observation.state,
    });
  }
  if (!attempt.nativeSessionId) {
    return success(attempt, generation, 'unknown', 'hold-pending', {
      reason: 'native-session-identity-missing',
      workerState: observation.state,
    });
  }
  if (
    attempt.worker.processId === null ||
    !validStartIdentity(attempt.worker.processStartIdentity)
  ) {
    return success(attempt, generation, 'unknown', 'hold-pending', {
      reason: 'persisted-process-identity-missing',
      workerState: observation.state,
    });
  }
  if (currentCheckout.digest !== attempt.checkout) {
    return success(attempt, generation, 'orphaned', 'manual-review', {
      reason: 'checkout-mismatch',
    });
  }
  return null;
}

function reconcilePairedReceipts(attempt, generation, observation, receipts) {
  const { observedProof, observedReceipt, persistedProof, persistedReceipt } =
    receipts;
  if (digest(persistedReceipt) !== digest(observedReceipt)) {
    return fail('RECEIPT_CONFLICT');
  }
  if (!(persistedProof || observedProof)) {
    return success(attempt, generation, 'unknown', 'hold-pending', {
      reason: 'terminal-receipt-unverified',
      workerState: observation.state,
    });
  }
  if (!persistedProof && observedReceipt.outcome !== 'unknown') {
    return verifiedTerminalResult(
      attempt,
      generation,
      observedReceipt,
      observedProof,
      { record: true }
    );
  }
  const selectedReceipt = persistedProof ? persistedReceipt : observedReceipt;
  const selectedProof = persistedProof || observedProof;
  return verifiedTerminalResult(
    attempt,
    generation,
    selectedReceipt,
    selectedProof,
    {
      duplicate: true,
      record: false,
      ...(selectedReceipt.outcome === 'unknown'
        ? { workerState: observation.state }
        : {}),
    }
  );
}

function reconcileSingleReceipt(attempt, generation, observation, receipts) {
  const { observedProof, observedReceipt, persistedProof, persistedReceipt } =
    receipts;
  if (persistedProof) {
    return verifiedTerminalResult(
      attempt,
      generation,
      persistedReceipt,
      persistedProof,
      { record: false, workerState: observation.state }
    );
  }
  if (persistedReceipt) {
    return success(attempt, generation, 'unknown', 'hold-pending', {
      reason: 'terminal-receipt-unverified',
      workerState: observation.state,
    });
  }
  if (!observedReceipt) {
    return null;
  }
  if (observedProof && observedReceipt.outcome !== 'unknown') {
    return verifiedTerminalResult(
      attempt,
      generation,
      observedReceipt,
      observedProof,
      { record: true }
    );
  }
  if (observedProof) {
    return verifiedTerminalResult(
      attempt,
      generation,
      observedReceipt,
      observedProof,
      {
        includeReceiptDigest: false,
        record: false,
        workerState: observation.state,
      }
    );
  }
  const unknownOutcome = observedReceipt.outcome === 'unknown';
  return success(attempt, generation, 'unknown', 'hold-pending', {
    ...(unknownOutcome ? { outcome: 'unknown' } : {}),
    reason: unknownOutcome
      ? 'terminal-receipt-reports-unknown'
      : 'terminal-receipt-unverified',
    workerState: observation.state,
  });
}

function reconcileTerminalReceipts(attempt, generation, observation) {
  const persistedReceipt = attempt.terminalReceipt;
  const persistedProof = receiptState(
    persistedReceipt,
    attempt.terminalVerification
  );
  const observedReceipt = observation.terminalReceipt;
  const observedProof = receiptState(
    observedReceipt,
    observation.terminalVerification
  );
  if (persistedReceipt && !matchesBase(persistedReceipt, attempt)) {
    return success(attempt, generation, 'orphaned', 'manual-review', {
      reason: 'persisted-receipt-identity-mismatch',
    });
  }
  if (observedReceipt && !matchesBase(observedReceipt, attempt)) {
    return success(attempt, generation, 'orphaned', 'manual-review', {
      reason: 'observed-receipt-identity-mismatch',
    });
  }
  const receipts = {
    observedProof,
    observedReceipt,
    persistedProof,
    persistedReceipt,
  };
  if (persistedReceipt && observedReceipt) {
    return reconcilePairedReceipts(attempt, generation, observation, receipts);
  }
  return reconcileSingleReceipt(attempt, generation, observation, receipts);
}

function aliveWorkerGate(attempt, generation, observation) {
  if (!observation.worker) {
    return success(attempt, generation, 'unknown', 'hold-pending', {
      reason: 'process-observation-identity-missing',
      workerState: 'alive',
    });
  }
  if (
    observation.worker.processId !== attempt.worker.processId ||
    observation.worker.processStartIdentity !==
      attempt.worker.processStartIdentity
  ) {
    return success(attempt, generation, 'orphaned', 'manual-review', {
      reason: 'pid-reused-or-process-replaced',
      workerState: 'alive',
    });
  }
  if (!observation.ownerIdentity) {
    return success(attempt, generation, 'unknown', 'hold-pending', {
      reason: 'process-owner-evidence-missing',
      workerState: 'alive',
    });
  }
  if (!matchesBase(observation.ownerIdentity, attempt)) {
    return success(attempt, generation, 'orphaned', 'manual-review', {
      reason: 'process-owner-identity-mismatch',
      workerState: 'alive',
    });
  }
  return null;
}

function clockGate(attempt, generation, observation, clock) {
  const observedWall = clock.wallTimeMs;
  const deadlineKnown = attempt.deadlineAtMs !== null;
  if (
    observedWall !== null &&
    attempt.lastObservedWallTimeMs !== null &&
    observedWall < attempt.lastObservedWallTimeMs
  ) {
    return success(attempt, generation, 'unknown', 'hold-pending', {
      reason: 'wall-clock-rollback',
      workerState: observation.state,
    });
  }
  if (deadlineKnown && attempt.lastObservedWallTimeMs === null) {
    return success(attempt, generation, 'unknown', 'hold-pending', {
      reason: 'clock-baseline-missing',
      workerState: observation.state,
    });
  }
  if (clock.sleepWakeGap === true) {
    const deadlineElapsed =
      deadlineKnown &&
      observedWall !== null &&
      observedWall >= attempt.deadlineAtMs;
    return success(attempt, generation, 'sleep-wake-gap', 'hold-pending', {
      deadlineElapsed,
      reason: 'sleep-wake-gap',
      workerState: observation.state,
    });
  }
  if (deadlineKnown && clock.sleepWakeGap === null) {
    return success(attempt, generation, 'unknown', 'hold-pending', {
      reason: 'sleep-state-unknown',
      workerState: observation.state,
    });
  }
  if (deadlineKnown && observedWall === null) {
    return success(attempt, generation, 'unknown', 'hold-pending', {
      reason: 'clock-evidence-missing',
      workerState: observation.state,
    });
  }
  return null;
}

function reconcileProcessObservation(attempt, generation, observation, clock) {
  if (observation.state === 'alive') {
    const identityResult = aliveWorkerGate(attempt, generation, observation);
    if (identityResult) {
      return identityResult;
    }
  }
  const clockResult = clockGate(attempt, generation, observation, clock);
  if (clockResult) {
    return clockResult;
  }
  const deadlineElapsed =
    attempt.deadlineAtMs !== null &&
    clock.wallTimeMs !== null &&
    clock.wallTimeMs >= attempt.deadlineAtMs;
  if (observation.state === 'absent') {
    return success(
      attempt,
      generation,
      deadlineElapsed ? 'deadline-elapsed' : 'worker-dead',
      'hold-pending',
      {
        deadlineElapsed,
        reason: 'worker-absent-without-terminal-receipt',
        workerState: 'absent',
      }
    );
  }
  if (observation.state === 'unknown') {
    return success(attempt, generation, 'unknown', 'hold-pending', {
      deadlineElapsed,
      reason: 'process-observation-unknown',
      workerState: 'unknown',
    });
  }
  if (deadlineElapsed) {
    return success(attempt, generation, 'deadline-elapsed', 'hold-pending', {
      deadlineElapsed: true,
      reason: 'deadline-elapsed-worker-still-owned',
      workerState: 'alive',
    });
  }
  return success(attempt, generation, 'worker-alive', 'reattach-worker', {
    deadlineElapsed: false,
    workerState: 'alive',
  });
}

function reconcileCurrentAttempt(attempt, request) {
  const generation = request.currentGeneration;
  const currentCheckout = checkoutInfo(
    request.currentCheckoutIdentity,
    attempt.runId
  );
  const observation = normalizeObservation(request.processObservation);
  const clock = normalizeClock(request.clock);
  if (!(currentCheckout.valid && observation && clock)) {
    return fail('INPUT_INVALID');
  }
  const identityResult = identityGate(
    attempt,
    generation,
    currentCheckout,
    observation
  );
  if (identityResult) {
    return identityResult;
  }
  const terminalResult = reconcileTerminalReceipts(
    attempt,
    generation,
    observation
  );
  return (
    terminalResult ||
    reconcileProcessObservation(attempt, generation, observation, clock)
  );
}

/**
 * Reconcile one persisted attempt without performing IO, signaling, launching,
 * retrying, or committing. See REPORT.md for the exact input and output seam.
 */
export function reconcileSpansRecovery(input) {
  try {
    const parsed = parseRecoveryInput(input);
    if (parsed.result) {
      return parsed.result;
    }
    const { attempt, request } = parsed;
    if (attempt.generation < request.currentGeneration) {
      return success(
        attempt,
        request.currentGeneration,
        'stale',
        'retain-historical'
      );
    }
    if (attempt.generation > request.currentGeneration) {
      return fail('ATTEMPT_GENERATION_AHEAD');
    }
    return reconcileCurrentAttempt(attempt, request);
  } catch {
    return fail('INPUT_INVALID');
  }
}
