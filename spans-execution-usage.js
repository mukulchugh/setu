import { derivedId } from './spans-dispatch.js';
import { isRecord, toMicro } from './spans-execution-core.js';
import {
  isSubscription,
  summarizeProviderOutput,
} from './spans-execution-provider.js';

// Maps the dispatch coordinator's usage contract (reserve, release, settle) onto
// the Spans usage ledger (reserve, reconcile, read). The ledger is the only
// owner of reservations; this module only translates, so a launch reserves
// exactly once. An answer the ledger cannot give is a failure here, never a
// success: a reservation that cannot be released or settled stays held.

const CAUSES = Object.freeze({
  SPANS_USAGE_CAP: 'BUDGET_EXCEEDED',
  SPANS_USAGE_CONFLICT: 'RESERVATION_CONFLICT',
  SPANS_USAGE_HELD: 'PRICE_UNKNOWN',
});

export const SPANS_EXEC_USAGE_METHODS = Object.freeze([
  'release',
  'reserve',
  'settle',
]);

export const usageReservationId = (runId, actionId) =>
  derivedId('spans-usage', runId, actionId);

// A ledger that throws or answers nothing has not recorded anything.
async function answerOf(work) {
  try {
    return await work();
  } catch {
    return null;
  }
}

function failure(ledgerCode) {
  return { code: CAUSES[ledgerCode] ?? 'USAGE_UNAVAILABLE', ok: false };
}

export function createSpansExecutionUsage({
  artifacts,
  executionOf,
  facts,
  ledger,
  limits,
  store,
}) {
  function generationOf(runId) {
    const read = store.readRun({ runId });
    return read?.ok === true ? read.generation : null;
  }

  // The exact cost the provider reported, read back from the attempt's
  // captured artifact. It is the only source of an actual amount, and it is the
  // provider's own figure, checked only against its own per-model figures. It
  // is not independent billing evidence.
  function observedMicro({ attemptId, runId }) {
    const read = store.readRun({ runId });
    const recorded =
      read?.ok === true ? read.view?.attempts?.[attemptId] : null;
    const artifactId = recorded?.receipt?.capture?.artifactId;
    if (!artifactId) {
      return null;
    }
    const artifact = artifacts.read({ artifactId });
    if (artifact?.ok !== true) {
      return null;
    }
    const { cost, costCheck } = summarizeProviderOutput(artifact.text);
    // Figures that disagree with each other settle nothing.
    return cost === null || costCheck === 'mismatch' ? null : toMicro(cost);
  }

  async function reserve(input) {
    const generation = generationOf(input.runId);
    const execution = executionOf(input.runId, input.actionId);
    const known = facts(input.profile);
    // The billing mode was reviewed with the dispatch; a profile that now
    // says something else is a different profile, and nothing is reserved.
    if (
      generation === null ||
      !execution ||
      !known ||
      known.billing !== execution.billing
    ) {
      return { code: 'USAGE_UNAVAILABLE', ok: false };
    }
    const reservationId = usageReservationId(input.runId, input.actionId);
    // A subscription run reserves no money: no limit, no amount, no hard cap.
    // The ledger records that nothing monetary is bounded; it does not claim a
    // cap that does not exist.
    const subscription = isSubscription(execution);
    const result = await answerOf(() =>
      ledger.reserve({
        actionId: input.actionId,
        aggregateLimitMicro: subscription ? null : limits.aggregateLimitMicro,
        attemptId: input.attemptId,
        attemptLimitMicro: subscription ? null : limits.attemptLimitMicro,
        enforcementAvailable: known.enforcementAvailable,
        generation,
        hardCap: !subscription,
        priceKnown: known.priceKnown,
        reservationId,
        reservationMicro: subscription ? null : execution.budgetMicro,
        runId: input.runId,
      })
    );
    if (!(isRecord(result) && result.ok === true)) {
      return failure(result?.code);
    }
    // A released reservation is finished accounting. Answering "reserved" for
    // it would let a launch run with nothing held, so it is a conflict.
    if (result.duplicate === true && result.reservation?.state === 'released') {
      return { code: 'RESERVATION_CONFLICT', ok: false };
    }
    let cap = 'unavailable';
    if (!subscription && known.enforcementAvailable) {
      cap = 'enforced';
    } else if (!subscription && known.priceKnown) {
      cap = 'estimated';
    }
    return {
      cap,
      existing: result.duplicate === true,
      ok: true,
      reservationId,
    };
  }

  // A launch that never happened has no effect to measure, so its reservation
  // is released as a verified no-effect. Dispatch calls this only then.
  async function release(input) {
    const generation = generationOf(input.runId);
    if (generation === null) {
      return { ok: false };
    }
    const result = await answerOf(() =>
      ledger.reconcile({
        actionId: input.actionId,
        actualMicro: 0,
        attemptId: input.attemptId,
        generation,
        outcome: 'failed',
        reservationId: usageReservationId(input.runId, input.actionId),
        runId: input.runId,
        terminalPolicy: true,
        verifiedNoEffect: true,
      })
    );
    return result?.ok === true && result.released === true
      ? { ok: true }
      : { ok: false };
  }

  // A verified terminal outcome settles against the reported cost. Without a
  // verifiable cost the reservation stays held and this reports a failure. A
  // subscription run has no amount to settle: a known terminal outcome releases
  // it, and what the provider reported stays an estimate in the completion
  // record rather than becoming a recorded charge.
  async function settle(input) {
    const generation = generationOf(input.runId);
    if (generation === null) {
      return { ok: false };
    }
    const subscription = isSubscription(
      executionOf(input.runId, input.actionId)
    );
    const actualMicro = subscription ? null : observedMicro(input);
    const result = await answerOf(() =>
      ledger.reconcile({
        actionId: input.actionId,
        actualMicro,
        attemptId: input.attemptId,
        generation,
        outcome: input.outcome,
        reservationId: usageReservationId(input.runId, input.actionId),
        runId: input.runId,
        terminalPolicy: true,
        verifiedNoEffect: false,
      })
    );
    return result?.ok === true && result.released === true
      ? { actualMicro, ok: true }
      : { ok: false };
  }

  return Object.freeze({
    read: (runId) => ledger.readAggregate({ runId }),
    release,
    reserve,
    settle,
  });
}
