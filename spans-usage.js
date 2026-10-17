import { createHash } from 'node:crypto';
import {
  isSpansRedactionSafeKey,
  redactSpansValue,
} from './spans-redaction.js';

const RETRIES = 5;
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const STALE = new Set([
  'SPANS_MODEL_REVISION_CONFLICT',
  'SPANS_MODEL_STALE_REVISION',
]);
const STALE_GENERATION = new Set([
  'SPANS_MODEL_GENERATION_CONFLICT',
  'SPANS_MODEL_STALE_GENERATION',
]);
const MESSAGES = Object.freeze({
  BUSY: 'Usage state changed repeatedly; retry the request.',
  CAP: 'The requested reservation exceeds an explicit spend bound.',
  COMMIT: 'Usage update was not confirmed; reread before retrying.',
  CONFLICT: 'Reservation ID is already bound to different input.',
  CONTRADICTION: 'Usage receipt contradicts the recorded outcome.',
  HELD: 'Reservation is held because pricing or enforcement is unknown.',
  INVALID: 'Invalid usage request.',
  NOT_FOUND: 'Reservation was not found.',
  READ: 'Usage state could not be read.',
  REGRESSION: 'Observed usage cannot decrease.',
  STALE: 'Coordinator generation is stale.',
});

const fail = (code, extra = {}) => ({
  code: `SPANS_USAGE_${code}`,
  error: MESSAGES[code],
  ok: false,
  ...extra,
});
const record = (value) =>
  value !== null &&
  typeof value === 'object' &&
  !Array.isArray(value) &&
  (Object.getPrototypeOf(value) === Object.prototype ||
    Object.getPrototypeOf(value) === null);
const id = (value) =>
  typeof value === 'string' &&
  ID_PATTERN.test(value) &&
  isSpansRedactionSafeKey(value);
const amount = (value) => Number.isSafeInteger(value) && value >= 0;
const keysOnly = (value, allowed) =>
  record(value) &&
  Reflect.ownKeys(value).every(
    (key) =>
      typeof key === 'string' &&
      allowed.has(key) &&
      Object.hasOwn(Object.getOwnPropertyDescriptor(value, key) ?? {}, 'value')
  );

function validObservation(value) {
  return (
    value === undefined ||
    (record(value) &&
      (value.actualMicro === null || amount(value.actualMicro)) &&
      ['completed', 'failed', 'unknown'].includes(value.outcome) &&
      typeof value.terminalPolicy === 'boolean' &&
      typeof value.verifiedNoEffect === 'boolean')
  );
}

function validPolicy(policy) {
  return (
    record(policy) &&
    amount(policy.aggregateLimitMicro) &&
    amount(policy.attemptLimitMicro) &&
    typeof policy.hardCap === 'boolean'
  );
}

function validReservationShape(row) {
  return (
    record(row) &&
    ['held', 'reserved', 'released'].includes(row.state) &&
    id(row.actionId) &&
    id(row.attemptId) &&
    typeof row.held === 'boolean' &&
    (row.reservationMicro === null || amount(row.reservationMicro)) &&
    (row.actualMicro === null || amount(row.actualMicro)) &&
    Array.isArray(row.fingerprint) &&
    row.fingerprint.length === 9 &&
    validObservation(row.observation)
  );
}

function validReservationFingerprint(row, policy, expectedRunId) {
  const [
    runId,
    actionId,
    attemptId,
    fingerprintReservation,
    aggregateLimitMicro,
    attemptLimitMicro,
    priceKnown,
    hardCap,
    enforcementAvailable,
  ] = row.fingerprint;
  return (
    id(runId) &&
    runId === expectedRunId &&
    actionId === row.actionId &&
    attemptId === row.attemptId &&
    fingerprintReservation === row.reservationMicro &&
    amount(aggregateLimitMicro) &&
    amount(attemptLimitMicro) &&
    typeof priceKnown === 'boolean' &&
    typeof hardCap === 'boolean' &&
    typeof enforcementAvailable === 'boolean' &&
    aggregateLimitMicro === policy.aggregateLimitMicro &&
    attemptLimitMicro === policy.attemptLimitMicro &&
    hardCap === policy.hardCap
  );
}

function validReservationState(row) {
  return (
    (row.state === 'held') === row.held &&
    !(row.state === 'reserved' && row.reservationMicro === null) &&
    !(row.state === 'reserved' && row.observation !== undefined) &&
    !(row.state === 'released' && row.held)
  );
}

function validReservation(reservationId, row, policy, expectedRunId) {
  return (
    id(reservationId) &&
    validReservationShape(row) &&
    validReservationFingerprint(row, policy, expectedRunId) &&
    validReservationState(row)
  );
}

function validUsageShape(usage) {
  return (
    record(usage) &&
    Object.hasOwn(usage, 'reservations') &&
    record(usage.reservations)
  );
}

function validUsage(usage, expectedRunId) {
  if (!validUsageShape(usage)) {
    return false;
  }
  const { policy, reservations } = usage;
  const hasPolicy = Object.hasOwn(usage, 'policy');
  if (hasPolicy ? !validPolicy(policy) : Object.keys(reservations).length > 0) {
    return false;
  }
  return Object.entries(reservations).every(([reservationId, row]) =>
    validReservation(reservationId, row, policy, expectedRunId)
  );
}

function event(runId, actionId, attemptId, operation, payload) {
  const digest = createHash('sha256')
    .update(JSON.stringify([runId, actionId, attemptId, operation, payload]))
    .digest('hex');
  return {
    eventId: `spans.usage.${operation}:${digest}`,
    payload: redactSpansValue(payload),
    runId,
    type: `spans.usage.${operation}`,
  };
}

function validRead(read, runId) {
  return (
    record(read) &&
    read.ok === true &&
    Number.isSafeInteger(read.revision) &&
    read.revision >= 0 &&
    Number.isSafeInteger(read.generation) &&
    record(read.view) &&
    read.view.runId === runId &&
    read.view.generation === read.generation
  );
}

function validBase(input, extra) {
  const allowed = new Set([
    'runId',
    'generation',
    'actionId',
    'attemptId',
    ...extra,
  ]);
  return (
    keysOnly(input, allowed) &&
    id(input.runId) &&
    id(input.actionId) &&
    id(input.attemptId) &&
    Number.isSafeInteger(input.generation) &&
    input.generation >= 0
  );
}

function snapshotInput(input) {
  return Object.fromEntries(
    Reflect.ownKeys(input).map((key) => [
      key,
      Object.getOwnPropertyDescriptor(input, key).value,
    ])
  );
}

function operationResult(output) {
  return output?.held ? fail('HELD', output) : { ...output, ok: true };
}

async function readUpdateState(store, input) {
  let read;
  try {
    read = await store.readRun({ runId: input.runId });
  } catch {
    return { failure: 'READ' };
  }
  if (!validRead(read, input.runId)) {
    return { failure: 'READ' };
  }
  if (read.generation !== input.generation) {
    return { failure: 'STALE' };
  }
  let view;
  try {
    view = structuredClone(read.view);
  } catch {
    return { failure: 'READ' };
  }
  if (!Object.hasOwn(view, 'usage')) {
    view.usage = { reservations: {} };
  }
  if (!validUsage(view.usage, input.runId)) {
    return { failure: 'READ' };
  }
  return { failure: null, read, view };
}

async function updateAttempt(store, input, operation, mutate) {
  const state = await readUpdateState(store, input);
  if (state.failure) {
    return { finished: true, result: fail(state.failure) };
  }
  const { read, view } = state;
  const result = mutate(view.usage);
  if (result?.failure) {
    return { finished: true, result: fail(result.failure, result.extra) };
  }
  if (result?.unchanged) {
    return { finished: true, result: operationResult(result.output) };
  }
  let committed;
  try {
    committed = await store.commitRun({
      events: [
        event(
          input.runId,
          input.actionId,
          input.attemptId,
          operation,
          result.event
        ),
      ],
      expectedGeneration: read.generation,
      expectedRevision: read.revision,
      runId: input.runId,
      view: redactSpansValue(view),
    });
  } catch {
    return { finished: true, result: fail('COMMIT') };
  }
  if (record(committed) && committed.ok === true) {
    return { finished: true, result: operationResult(result.output) };
  }
  if (STALE_GENERATION.has(committed?.code)) {
    return { finished: true, result: fail('STALE') };
  }
  if (!STALE.has(committed?.code)) {
    return { finished: true, result: fail('COMMIT') };
  }
  return { finished: false, retry: true };
}

function createUpdater(store, maxRetries) {
  return async function update(input, operation, mutate) {
    for (let retry = 0; retry < maxRetries; retry += 1) {
      // biome-ignore lint/performance/noAwaitInLoops: each CAS retry must await its read and commit result before rereading.
      const outcome = await updateAttempt(store, input, operation, mutate);
      if (outcome.finished) {
        return outcome.result;
      }
    }
    return fail('BUSY');
  };
}

function validReserveInput(input) {
  const extra = [
    'reservationId',
    'reservationMicro',
    'aggregateLimitMicro',
    'attemptLimitMicro',
    'priceKnown',
    'hardCap',
    'enforcementAvailable',
  ];
  return (
    validBase(input, extra) &&
    id(input.reservationId) &&
    (input.reservationMicro === null || amount(input.reservationMicro)) &&
    amount(input.aggregateLimitMicro) &&
    amount(input.attemptLimitMicro) &&
    typeof input.priceKnown === 'boolean' &&
    typeof input.hardCap === 'boolean' &&
    typeof input.enforcementAvailable === 'boolean'
  );
}

function reservationFingerprint(input) {
  return [
    input.runId,
    input.actionId,
    input.attemptId,
    input.reservationMicro,
    input.aggregateLimitMicro,
    input.attemptLimitMicro,
    input.priceKnown,
    input.hardCap,
    input.enforcementAvailable,
  ];
}

function priorReservationResult(prior, fingerprint, input) {
  if (JSON.stringify(prior.fingerprint) !== JSON.stringify(fingerprint)) {
    return { failure: 'CONFLICT' };
  }
  return {
    output: {
      dispatchAuthorized: false,
      duplicate: true,
      held: prior.held,
      reservation: structuredClone(prior),
      reservationId: input.reservationId,
    },
    unchanged: true,
  };
}

function bindPolicy(usage, input) {
  if (Object.hasOwn(usage, 'policy')) {
    if (
      usage.policy.aggregateLimitMicro !== input.aggregateLimitMicro ||
      usage.policy.attemptLimitMicro !== input.attemptLimitMicro ||
      usage.policy.hardCap !== input.hardCap
    ) {
      return { failure: 'CONFLICT' };
    }
  } else {
    usage.policy = {
      aggregateLimitMicro: input.aggregateLimitMicro,
      attemptLimitMicro: input.attemptLimitMicro,
      hardCap: input.hardCap,
    };
  }
  return null;
}

function alreadyHasAttempt(reservations, attemptId) {
  return Object.values(reservations).some((row) => row.attemptId === attemptId);
}

function shouldHoldReservation(input) {
  return (
    !input.priceKnown ||
    (input.hardCap &&
      (!input.enforcementAvailable || input.reservationMicro === null))
  );
}

function heldReservationMutation(input, fingerprint, reservations) {
  reservations[input.reservationId] = {
    actionId: input.actionId,
    actualMicro: null,
    attemptId: input.attemptId,
    fingerprint,
    held: true,
    reservationMicro: input.reservationMicro,
    state: 'held',
  };
  return {
    event: {
      actionId: input.actionId,
      attemptId: input.attemptId,
      held: true,
      reservationId: input.reservationId,
      reservationMicro: input.reservationMicro,
    },
    output: { held: true, reservationId: input.reservationId },
  };
}

function validExposureRow(row) {
  return (
    record(row) &&
    ['held', 'reserved', 'released'].includes(row.state) &&
    (row.actualMicro === null || amount(row.actualMicro))
  );
}

function reservationExposure(reservations) {
  let exposure = 0;
  for (const row of Object.values(reservations)) {
    if (!validExposureRow(row)) {
      return { failure: 'READ' };
    }
    if (row.held) {
      return { failure: 'HELD' };
    }
    const actual = row.actualMicro ?? 0;
    const remaining =
      row.state === 'released' || row.reservationMicro === null
        ? 0
        : Math.max(0, row.reservationMicro - actual);
    if (
      !(
        Number.isSafeInteger(exposure + actual) &&
        Number.isSafeInteger(exposure + actual + remaining)
      )
    ) {
      return { failure: 'HELD' };
    }
    exposure += actual + remaining;
  }
  return { exposure, failure: null };
}

function reservedReservationMutation(input, fingerprint, reservations) {
  const row = {
    actionId: input.actionId,
    actualMicro: null,
    attemptId: input.attemptId,
    fingerprint,
    held: false,
    reservationMicro: input.reservationMicro,
    state: 'reserved',
  };
  reservations[input.reservationId] = row;
  return {
    event: {
      actionId: input.actionId,
      attemptId: input.attemptId,
      reservationId: input.reservationId,
      reservationMicro: input.reservationMicro,
    },
    output: {
      dispatchAuthorized: true,
      held: false,
      reservation: structuredClone(row),
      reservationId: input.reservationId,
    },
  };
}

function reserveUsage(usage, input) {
  const { reservations } = usage;
  const prior = reservations[input.reservationId];
  const fingerprint = reservationFingerprint(input);
  if (prior) {
    return priorReservationResult(prior, fingerprint, input);
  }
  const policyFailure = bindPolicy(usage, input);
  if (policyFailure) {
    return policyFailure;
  }
  if (alreadyHasAttempt(reservations, input.attemptId)) {
    return { failure: 'CONFLICT' };
  }
  if (shouldHoldReservation(input)) {
    return heldReservationMutation(input, fingerprint, reservations);
  }
  if (
    input.reservationMicro === null ||
    input.reservationMicro > input.attemptLimitMicro
  ) {
    return { failure: 'CAP' };
  }
  const exposure = reservationExposure(reservations);
  if (exposure.failure) {
    return { failure: exposure.failure };
  }
  if (
    exposure.exposure > input.aggregateLimitMicro ||
    input.reservationMicro > input.aggregateLimitMicro - exposure.exposure
  ) {
    return { failure: 'CAP' };
  }
  return reservedReservationMutation(input, fingerprint, reservations);
}

function validReconcileInput(input) {
  const extra = [
    'reservationId',
    'actualMicro',
    'outcome',
    'verifiedNoEffect',
    'terminalPolicy',
  ];
  return (
    validBase(input, extra) &&
    id(input.reservationId) &&
    (input.actualMicro === null || amount(input.actualMicro)) &&
    ['completed', 'failed', 'unknown'].includes(input.outcome) &&
    typeof input.verifiedNoEffect === 'boolean' &&
    typeof input.terminalPolicy === 'boolean'
  );
}

function reconcileObservation(input) {
  return {
    actualMicro: input.actualMicro,
    outcome: input.outcome,
    terminalPolicy: input.terminalPolicy,
    verifiedNoEffect: input.verifiedNoEffect,
  };
}

function observationMatchesTerminalFacts(observation, input) {
  return (
    record(observation) &&
    observation.outcome === input.outcome &&
    observation.terminalPolicy === input.terminalPolicy &&
    observation.verifiedNoEffect === input.verifiedNoEffect
  );
}

function sameObservation(previous, observation) {
  return JSON.stringify(previous) === JSON.stringify(observation);
}

function receiptMutation(row, input, released, releasedOnly = false) {
  const output = releasedOnly
    ? {
        actualMicro: row.actualMicro,
        released: true,
        reservationId: input.reservationId,
      }
    : {
        actualMicro: row.actualMicro,
        held: !released,
        released,
        reservationId: input.reservationId,
      };
  return {
    event: {
      actionId: input.actionId,
      actualMicro: row.actualMicro,
      attemptId: input.attemptId,
      outcome: input.outcome,
      released,
      reservationId: input.reservationId,
      verifiedNoEffect: input.verifiedNoEffect,
    },
    output,
  };
}

function releasedReservationMutation(row, input, observation) {
  if (!observationMatchesTerminalFacts(row.observation, input)) {
    return { failure: 'CONTRADICTION' };
  }
  if (sameObservation(row.observation, observation)) {
    return {
      output: {
        actualMicro: row.actualMicro,
        released: true,
        reservationId: input.reservationId,
      },
      unchanged: true,
    };
  }
  row.actualMicro =
    input.actualMicro === null ? row.actualMicro : input.actualMicro;
  row.observation = observation;
  return receiptMutation(row, input, true, true);
}

function validReceiptProgress(row, input) {
  const noEffectContradiction =
    input.verifiedNoEffect &&
    ((input.actualMicro !== null && input.actualMicro > 0) ||
      (row.actualMicro !== null && row.actualMicro > 0));
  if (noEffectContradiction) {
    return { failure: 'CONTRADICTION' };
  }
  const usageRegression =
    input.actualMicro !== null &&
    row.actualMicro !== null &&
    input.actualMicro < row.actualMicro;
  return usageRegression ? { failure: 'REGRESSION' } : null;
}

function pendingReservationMutation(row, input, observation) {
  if (sameObservation(row.observation, observation)) {
    return {
      output: {
        actualMicro: row.actualMicro,
        held: row.held,
        released: row.state === 'released',
        reservationId: input.reservationId,
      },
      unchanged: true,
    };
  }
  const knownTerminal =
    input.outcome !== 'unknown' &&
    (input.actualMicro !== null || input.verifiedNoEffect);
  const released =
    input.verifiedNoEffect || (input.terminalPolicy && knownTerminal);
  row.actualMicro =
    input.actualMicro === null ? row.actualMicro : input.actualMicro;
  row.observation = observation;
  row.state = released ? 'released' : 'held';
  row.held = !released;
  return receiptMutation(row, input, released);
}

function reconcileUsage(usage, input) {
  const row = usage.reservations[input.reservationId];
  if (
    !row ||
    row.actionId !== input.actionId ||
    row.attemptId !== input.attemptId
  ) {
    return { failure: 'NOT_FOUND' };
  }
  const progressFailure = validReceiptProgress(row, input);
  if (progressFailure) {
    return progressFailure;
  }
  const observation = reconcileObservation(input);
  if (row.state === 'released') {
    return releasedReservationMutation(row, input, observation);
  }
  return pendingReservationMutation(row, input, observation);
}

function validAggregateInput(input) {
  return keysOnly(input, new Set(['runId'])) && id(input.runId);
}

function emptyAggregate(read, runId) {
  return {
    actualComplete: true,
    generation: read.generation,
    heldCount: 0,
    knownActualCount: 0,
    ok: true,
    outstandingReservationMicro: 0,
    revision: read.revision,
    runActualMicro: 0,
    runExposureMicro: 0,
    runId,
    scope: 'run',
    unknownActualCount: 0,
  };
}

function summarizeReservations(reservations) {
  let outstandingReservationMicro = 0;
  let runExposureMicro = 0;
  let actualMicro = 0;
  let knownActualCount = 0;
  let unknownActualCount = 0;
  let heldCount = 0;
  for (const row of Object.values(reservations)) {
    if (row.actualMicro === null) {
      if (row.state !== 'released') {
        unknownActualCount += 1;
        heldCount += 1;
      }
    } else if (
      amount(row.actualMicro) &&
      Number.isSafeInteger(actualMicro + row.actualMicro)
    ) {
      actualMicro += row.actualMicro;
      knownActualCount += 1;
    } else {
      return { failure: 'READ' };
    }
    if (row.held && row.actualMicro !== null) {
      heldCount += 1;
    }
    const observed = row.actualMicro ?? 0;
    const remaining =
      row.state === 'released' || row.reservationMicro === null
        ? 0
        : Math.max(0, row.reservationMicro - observed);
    if (row.state !== 'released') {
      if (!Number.isSafeInteger(outstandingReservationMicro + remaining)) {
        return { failure: 'READ' };
      }
      outstandingReservationMicro += remaining;
    }
    if (!Number.isSafeInteger(runExposureMicro + observed + remaining)) {
      return { failure: 'READ' };
    }
    runExposureMicro += observed + remaining;
  }
  return {
    actualMicro,
    failure: null,
    heldCount,
    knownActualCount,
    outstandingReservationMicro,
    runExposureMicro,
    unknownActualCount,
  };
}

function aggregateResult(read, runId, totals) {
  return {
    actualComplete: totals.unknownActualCount === 0,
    generation: read.generation,
    heldCount: totals.heldCount,
    knownActualCount: totals.knownActualCount,
    ok: true,
    outstandingReservationMicro: totals.outstandingReservationMicro,
    revision: read.revision,
    runActualMicro: totals.actualMicro,
    runExposureMicro:
      totals.unknownActualCount > 0 ? null : totals.runExposureMicro,
    runId,
    scope: 'run',
    unknownActualCount: totals.unknownActualCount,
  };
}

export function createSpansUsage({ store, maxRetries = RETRIES } = {}) {
  if (
    !record(store) ||
    typeof store.readRun !== 'function' ||
    typeof store.commitRun !== 'function' ||
    !Number.isInteger(maxRetries) ||
    maxRetries < 1 ||
    maxRetries > 10
  ) {
    throw new TypeError(
      'store with readRun/commitRun and bounded maxRetries required'
    );
  }

  const update = createUpdater(store, maxRetries);

  function reserve(input) {
    if (!validReserveInput(input)) {
      return fail('INVALID');
    }
    const request = snapshotInput(input);
    return update(request, 'reserve', (usage) => reserveUsage(usage, request));
  }

  function reconcile(input) {
    if (!validReconcileInput(input)) {
      return fail('INVALID');
    }
    const request = snapshotInput(input);
    return update(request, 'reconcile', (usage) =>
      reconcileUsage(usage, request)
    );
  }

  async function readAggregate(input) {
    if (!validAggregateInput(input)) {
      return fail('INVALID');
    }
    const { runId } = input;
    try {
      const read = await store.readRun({ runId });
      if (!validRead(read, runId)) {
        return fail('READ');
      }
      const { view } = read;
      if (!Object.hasOwn(view, 'usage')) {
        return emptyAggregate(read, runId);
      }
      if (!validUsage(view.usage, runId)) {
        return fail('READ');
      }
      const totals = summarizeReservations(view.usage.reservations);
      if (totals.failure) {
        return fail(totals.failure);
      }
      return aggregateResult(read, runId, totals);
    } catch {
      return fail('READ');
    }
  }

  const bounded = (work) => async (input) => {
    try {
      return await work(input);
    } catch {
      return fail('INVALID');
    }
  };
  return Object.freeze({
    readAggregate: bounded(readAggregate),
    reconcile: bounded(reconcile),
    reserve: bounded(reserve),
  });
}
