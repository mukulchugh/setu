import { randomUUID } from 'node:crypto';
import { dirname } from 'node:path';
import { observeProcessIdentity } from './process-observation.js';
import { createSpansActions } from './spans-actions.js';
import {
  admissionOperationId,
  authorizationBinding,
  createSpansDispatch,
  derivedId,
  targetDigestFor,
  writerSession,
} from './spans-dispatch.js';
import {
  createArchiveAdapter,
  createCheckoutAdapter,
  createDependencyAdapter,
  createRunStateAdapter,
  createSetupAdapter,
  createWriterAdapter,
} from './spans-execution-adapters.js';
import { readSpansExecutionRequest } from './spans-execution-binding.js';
import { createSpansCapability } from './spans-execution-capability.js';
import { createSpansExecutionCapture } from './spans-execution-capture.js';
import {
  digestOf,
  exactRequest,
  holdsSecret,
  spansExecutionInputDigest as inputDigestOf,
  isExplicitId,
  isRecord,
  PROFILE_PATTERN,
  refusal,
  sha256,
  toMicro,
} from './spans-execution-core.js';
import { createExecutionOwner } from './spans-execution-owner.js';
import {
  isSubscription,
  launchModeOf,
  providerArguments,
  providerEnvironment,
  SPANS_EXEC_DEFAULT_PROFILES,
} from './spans-execution-provider.js';
import { createSpansExecutionResources } from './spans-execution-resources.js';
import { createSpansExecutionReviewFlow } from './spans-execution-review-flow.js';
import {
  createSpansExecutionUsage,
  usageReservationId,
} from './spans-execution-usage.js';
import {
  changedPathsSince,
  classifyTerminal,
  describeChange,
  observeTree,
} from './spans-execution-verifier.js';
import { SPANS_MODEL_LIMITS } from './spans-model-store.js';
import { reconcileSpansRecovery } from './spans-recovery.js';
import { redactSpansValue } from './spans-redaction.js';
import { SPANS_STORE_LIMITS } from './spans-store.js';
import { evaluateDependencyReadiness } from './spans-transitions.js';
import { createSpansUsage } from './spans-usage.js';
import {
  createSpansWorkerProcess,
  spansWorkerCapturePath,
} from './spans-worker-process.js';
import { releaseWriter } from './writer-claims.js';

// Live Spans execution: one composition that dispatches a reviewed span to one
// owned local worker. It sits beside the offline runtime. Reads and planning
// never reach it, and nothing here starts work unless a caller asks for it
// through an operation that names its effect.

// Same ceilings as the bounded headless run: one hour, and for a metered
// profile two dollars. A subscription profile has no dollar ceiling.
export const SPANS_EXEC_LIMITS = Object.freeze({
  instructionChars: 8000,
  maxBudgetUsd: 2,
  maxWallClockMs: 60 * 60 * 1000,
  minWallClockMs: 1000,
});
const WORKER_ID = 'spans-worker-local';
const WORKER_LIMITS = Object.freeze({
  maxActiveAttempts: 2,
  maxAttemptBytes: 4 * 1024 * 1024,
  maxAttemptChunks: 65_536,
  maxChunkBytes: 64 * 1024,
  maxDeadlineMs: SPANS_EXEC_LIMITS.maxWallClockMs,
  maxQueueBytes: 1024 * 1024,
});
const ARCHIVE_WRITE_MAX_BYTES =
  SPANS_MODEL_LIMITS.documentBytes +
  SPANS_STORE_LIMITS.payloadBytes * 8 +
  2 * 1024 * 1024;
const DEFAULT_RUN_BUDGET_USD = 10;
const CONFIRMATION_PREFIX = 'spans-dispatch:';
const ACCEPT_PREFIX = 'spans-accept:';
const RESOLVE_PREFIX = 'spans-resolve:';
const ADMISSION_KIND = 'headless-run';
const REVIEW_DIGEST = /^[a-f0-9]{64}$/;
const TARGET_PART = /^[^/\\\s:]+$/;
const METERED_CAPABILITIES = Object.freeze([
  'effort',
  'hardCostCap',
  'launch',
  'model',
  'permissions',
]);
// A subscription dispatch needs no cost cap and does not claim a verified
// effort: the profile accepts the requested effort unverified, and the review
// says so. Model, permission mode and toolset are still checked.
const requiredCapabilitiesOf = (definition) =>
  isSubscription(definition)
    ? [
        'launch',
        'model',
        'permissions',
        ...(definition.tools ? ['tools'] : []),
      ].sort()
    : [...METERED_CAPABILITIES];
const STALE_REVISION_CODES = new Set([
  'SPANS_MODEL_REVISION_CONFLICT',
  'SPANS_MODEL_STALE_REVISION',
]);
const MAX_COMMIT_TRIES = 4;
// Worker answers that prove nothing was started. Anything else is unknown.
const NOT_LAUNCHED_CODES = new Set([
  'ACTION_BINDING_MISMATCH',
  'ACTION_NOT_PENDING',
  'ACTION_NOT_PREPARED',
  'ATTEMPT_CONFLICT',
  'CAPTURE_PROVIDER_REFUSED',
  'CLOCK_INVALID',
  'DEADLINE_INVALID',
  'GENERATION_INVALID',
  'ID_INVALID',
  'LAUNCH_REFUSED',
  'PREFLIGHT_REFUSED',
  'RUN_READ_FAILED',
  'RUN_VIEW_INVALID',
  'STALE_GENERATION',
  'STALE_REVISION',
  'WORKER_FULL',
]);
const WORKER_REASONS = new Set([
  'CAPTURE_UNAVAILABLE',
  'PROFILE_UNSUPPORTED',
  'WORKER_REFUSED',
  'WORKER_UNAVAILABLE',
]);

const MESSAGES = Object.freeze({
  SPANS_EXEC_ACCEPTANCE_CONFIRMATION_REQUIRED:
    'Review what would be accepted, then submit its exact confirmation.',
  SPANS_EXEC_ACCEPTANCE_REFUSED:
    'The completion evidence was not verified; nothing was accepted.',
  SPANS_EXEC_ACTION_NOT_FOUND: 'No such action exists in this run.',
  SPANS_EXEC_ACTION_OPEN: 'Another action on this span is not finished.',
  SPANS_EXEC_ATTEMPT_NOT_FOUND: 'No attempt of this run has that ID.',
  SPANS_EXEC_AUTHORIZATION_NOT_RECORDED:
    'The reviewed authorization could not be recorded; nothing was started.',
  SPANS_EXEC_BUDGET_NOT_APPLICABLE:
    'This profile runs on a subscription and has no dollar budget; none can be set.',
  SPANS_EXEC_BUDGET_REQUIRED:
    'This profile is metered and needs a dollar budget.',
  SPANS_EXEC_CANCEL_REFUSED: 'The cancel request was refused.',
  SPANS_EXEC_CANCEL_UNKNOWN:
    'The cancel request was not confirmed; its effect is unknown.',
  SPANS_EXEC_CAPABILITY_UNVERIFIED:
    'The profile has no fresh local probe that allows a launch.',
  SPANS_EXEC_CHECKOUT_UNKNOWN: 'The checkout could not be observed exactly.',
  SPANS_EXEC_CONFIRMATION_REQUIRED:
    'Review the dispatch, then submit its exact confirmation.',
  SPANS_EXEC_DEPENDENCIES_INCOMPLETE:
    'Every dependency of the span must be accepted complete first.',
  SPANS_EXEC_DEPENDENCY_UNKNOWN:
    'The checkout dependency identity could not be observed.',
  SPANS_EXEC_EVIDENCE_INVALID:
    'The stored completion evidence does not match itself; nothing was accepted.',
  SPANS_EXEC_GENERATION_AHEAD:
    'The reported generation is newer than the run; the report was ignored.',
  SPANS_EXEC_NOT_COMPLETED:
    'The action has no verified completed outcome to accept.',
  SPANS_EXEC_NOT_RESOLVABLE:
    'This dispatch has an intent, an attempt or a live dispatch; it is not resolved here.',
  SPANS_EXEC_OWNED_ELSEWHERE:
    'Another service supervises this archive; nothing was started.',
  SPANS_EXEC_PROBE_NOT_RECORDED:
    'Probe evidence could not be recorded. Inspect the archive before another probe.',
  SPANS_EXEC_PROFILE_UNKNOWN: 'That model profile is not configured.',
  SPANS_EXEC_RELEASE_INCOMPLETE:
    'Not everything could be released; the dispatch stays held and can be resolved again.',
  SPANS_EXEC_REPORT_NOT_RECORDED: 'The report could not be recorded.',
  SPANS_EXEC_REQUEST_INVALID: 'The request does not use the expected format.',
  SPANS_EXEC_REVIEW_CHANGED:
    'What would be dispatched changed since the review; review it again.',
  SPANS_EXEC_RUN_READ_ONLY: 'Imported history cannot execute actions.',
  SPANS_EXEC_RUN_UNAVAILABLE: 'The run could not be read.',
  SPANS_EXEC_SETUP_NOT_READY:
    'Setup has not completed for this checkout; nothing was started.',
  SPANS_EXEC_SPAN_BUSY:
    'Another dispatch or resolve of this span is in progress; nothing was started.',
  SPANS_EXEC_SPAN_COMPLETED: 'The span is already complete.',
  SPANS_EXEC_SPAN_NOT_FOUND: 'The span does not exist in this run.',
  SPANS_EXEC_TARGET_UNKNOWN: 'The target is not a registered checkout.',
  SPANS_EXEC_TREE_CHANGED:
    'The checkout is no longer exactly the tree the worker completed.',
  SPANS_EXEC_TREE_UNREADABLE: 'The checkout tree could not be read exactly.',
});

const fail = (code, extra) =>
  refusal(code, MESSAGES[code] ?? 'The request failed.', extra);
const invalid = () => fail('SPANS_EXEC_REQUEST_INVALID');

function isTargetPart(value) {
  return (
    typeof value === 'string' &&
    TARGET_PART.test(value) &&
    value !== '.' &&
    value !== '..' &&
    !value.startsWith('-') &&
    !holdsSecret(value) &&
    ![...value].some((character) => character.codePointAt(0) <= 0x20)
  );
}

function parseTarget(value) {
  const target = exactRequest(value, ['name', 'repo']);
  return target &&
    isTargetPart(target.repo) &&
    typeof target.name === 'string' &&
    target.name.split('/').every(isTargetPart)
    ? { name: target.name, repo: target.repo }
    : null;
}

// A stored record that no longer hashes to what was authorized is not run.
const inputsIntact = (execution) =>
  execution.inputDigest === inputDigestOf(execution);

const OPTIONAL_REVIEW_FIELDS = ['budgetUsd', 'criteria', 'requireChange'];
const MAX_CRITERIA = 10;
const MAX_CRITERION_CHARS = 300;

// Acceptance criteria are the reviewer's own words. Setu shows them again at
// acceptance and binds them to the dispatch; it does not run or judge them.
const validCriteria = (value) =>
  value === undefined ||
  (Array.isArray(value) &&
    value.length <= MAX_CRITERIA &&
    value.every(
      (item) =>
        typeof item === 'string' &&
        item.trim().length > 0 &&
        item.length <= MAX_CRITERION_CHARS &&
        !item.includes('\0') &&
        !holdsSecret(item)
    ));

// A dollar budget is optional here and decided per profile: a metered profile
// needs one, a subscription profile must not have one.
const validBudget = (value) =>
  value === undefined ||
  (typeof value === 'number' &&
    value > 0 &&
    value <= SPANS_EXEC_LIMITS.maxBudgetUsd &&
    toMicro(value) / 1_000_000 === value);

// The refusal for a budget that does not fit the profile's billing, or null.
function budgetRefusal(request, definition) {
  if (isSubscription(definition)) {
    return request.budgetUsd === undefined
      ? null
      : fail('SPANS_EXEC_BUDGET_NOT_APPLICABLE');
  }
  return request.budgetUsd === undefined
    ? fail('SPANS_EXEC_BUDGET_REQUIRED')
    : null;
}

const REVIEW_FIELDS = [
  'instructions',
  'profile',
  'runId',
  'spanId',
  'target',
  'wallClockMs',
];

function parseReview(input, { confirmation = false } = {}) {
  const request = exactRequest(
    input,
    REVIEW_FIELDS,
    confirmation
      ? ['confirmation', 'reviewDigest', ...OPTIONAL_REVIEW_FIELDS]
      : OPTIONAL_REVIEW_FIELDS
  );
  const target = request && parseTarget(request.target);
  if (
    !(
      request &&
      target &&
      PROFILE_PATTERN.test(request.profile) &&
      isExplicitId(request.runId) &&
      isExplicitId(request.spanId) &&
      typeof request.instructions === 'string' &&
      request.instructions.trim().length > 0 &&
      request.instructions.length <= SPANS_EXEC_LIMITS.instructionChars &&
      !request.instructions.includes('\0') &&
      !holdsSecret(request.instructions) &&
      validBudget(request.budgetUsd) &&
      Number.isSafeInteger(request.wallClockMs) &&
      request.wallClockMs >= SPANS_EXEC_LIMITS.minWallClockMs &&
      request.wallClockMs <= SPANS_EXEC_LIMITS.maxWallClockMs &&
      validCriteria(request.criteria) &&
      (request.requireChange === undefined ||
        typeof request.requireChange === 'boolean') &&
      (request.confirmation === undefined ||
        typeof request.confirmation === 'string') &&
      (request.reviewDigest === undefined ||
        (typeof request.reviewDigest === 'string' &&
          REVIEW_DIGEST.test(request.reviewDigest)))
    )
  ) {
    return null;
  }
  return {
    ...request,
    criteria: request.criteria ?? [],
    requireChange: request.requireChange === true,
    target,
  };
}

// Stated in every subscription review, so no one reads a missing budget as a
// limit that exists.
const SUBSCRIPTION_COST = Object.freeze({
  billing: 'subscription',
  enforcement: 'none',
  monetaryCap: null,
  note: 'Runs on the owner subscription. No dollar budget is set or enforced; usage is reported afterwards as a provider estimate, not a bill. The wall clock and cancellation are the bounds.',
});

// What a subscription session reported about its own use. The dollar figure is
// the provider's estimate of API-equivalent cost; it is not a charge, and
// whether anything was billed is unknown here.
const usageEstimate = (verdict) => ({
  // Figures that contradict each other are shown as such, not as an amount.
  apiEquivalentMicro:
    verdict.costCheck === 'mismatch' ? null : verdict.costMicro,
  basis: 'provider-reported estimate',
  billed: 'unknown',
  costCheck: verdict.costCheck,
  tokens: verdict.tokens,
});

// What the worker's own session said it ran with. A report, shown beside the
// reviewed plan, never promoted to a verified effort.
const sessionReport = (init) => ({
  effort: init?.effort ?? null,
  model: init?.model ?? null,
  permissionMode: init?.permissionMode ?? null,
  tools: init ? [...init.tools].sort() : null,
});

// The worker's session must have run as reviewed: same model, permission mode
// and tools, and no effort other than the requested one if it reported any. A
// profile without a reviewed toolset has nothing to compare.
function sessionState(execution, init) {
  const mode = execution.launchMode;
  if (!mode?.tools) {
    return 'not-required';
  }
  if (!init) {
    return 'unobserved';
  }
  const tools = [...init.tools].sort();
  const same =
    init.model === mode.model &&
    init.permissionMode === mode.permissionMode &&
    tools.length === mode.tools.length &&
    tools.every((tool, index) => tool === mode.tools[index]) &&
    (init.effort === null || init.effort === mode.effort.requested);
  return same ? 'match' : 'mismatch';
}

const UNRELEASED = new Set(['failed', 'held', 'release-failed', 'unknown']);

// The coordinator says so itself: a plain refusal, nothing launched, no effect,
// and no resource of its own left held. A hold, a duplicate, a dispatch that is
// still in flight and an unconfirmed intent are never this.
function startedNothing(result) {
  return (
    result?.ok === false &&
    result.effect === 'none' &&
    result.launched === false &&
    result.status === 'refused' &&
    result.code !== 'DISPATCH_IN_FLIGHT' &&
    result.code !== 'INTENT_NOT_CONFIRMED' &&
    !UNRELEASED.has(result.resources?.usage) &&
    !UNRELEASED.has(result.resources?.admission)
  );
}

function plannedSpan(view, spanId) {
  const span = view.spans?.[spanId];
  return isRecord(span) ? span : null;
}

// What the plan itself says about running this span now.
function checkSpan(view, runId, spanId, selector) {
  if (
    view.readOnly === true ||
    view.kind === 'imported' ||
    view.state === 'imported'
  ) {
    return { ok: false, refusal: fail('SPANS_EXEC_RUN_READ_ONLY') };
  }
  const span = plannedSpan(view, spanId);
  if (!span) {
    return { ok: false, refusal: fail('SPANS_EXEC_SPAN_NOT_FOUND') };
  }
  if (span.state === 'completed') {
    return { ok: false, refusal: fail('SPANS_EXEC_SPAN_COMPLETED') };
  }
  const accepted = Object.entries(view.spans)
    .filter(([, other]) => isRecord(other) && other.state === 'completed')
    .map(([id]) => ({ spanId: id, verified: true }));
  const readiness = evaluateDependencyReadiness({
    acceptedCompletions: accepted,
    dependencies: span.dependencies ?? [],
  });
  if (!(readiness.ok && readiness.ready)) {
    return {
      ok: false,
      refusal: fail('SPANS_EXEC_DEPENDENCIES_INCOMPLETE', {
        waitingFor: readiness.waitingFor,
      }),
    };
  }
  const actions = Object.values(view.actions ?? {}).filter(
    (action) => isRecord(action) && action.spanId === spanId
  );
  const ownAction =
    selector && actions.find((action) => action.actionId === selector.actionId);
  if (
    ownAction &&
    (ownAction.attemptId !== selector.attemptId || ownAction.state !== 'intent')
  ) {
    return { ok: false, refusal: fail('SPANS_EXEC_ACTION_OPEN') };
  }
  if (
    actions.some((action) => action.state !== 'failed' && action !== ownAction)
  ) {
    return { ok: false, refusal: fail('SPANS_EXEC_ACTION_OPEN') };
  }
  return {
    ok: true,
    ordinal: freshOrdinal(view, runId, spanId, actions.length + 1),
    ownSelector: ownAction ? selector : null,
    span,
  };
}

function plannedExecutionIds(planned, request) {
  if (planned.ownSelector) {
    const { actionId, attemptId } = planned.ownSelector;
    return { actionId, attemptId };
  }
  return {
    actionId: derivedId(
      'spans-act',
      request.runId,
      request.spanId,
      planned.ordinal
    ),
    attemptId: derivedId(
      'spans-att',
      request.runId,
      request.spanId,
      planned.ordinal
    ),
  };
}

// Identities (action, attempt, ledger reservation, admission) are derived from
// an ordinal. A ledger row that was released is accounting history that carries
// nothing new, so its identity is never used again: the next dispatch of the
// span takes the next ordinal and reserves afresh. An authorization that still
// holds its reservation keeps its ordinal, so the same binding stays idempotent.
function freshOrdinal(view, runId, spanId, first) {
  let ordinal = first;
  while (
    view.usage?.reservations?.[
      usageReservationId(runId, derivedId('spans-act', runId, spanId, ordinal))
    ]?.state === 'released'
  ) {
    ordinal += 1;
  }
  return ordinal;
}

// The binding the dispatch coordinator asks its authorization adapter to
// verify, built by the coordinator's own function from the flat request shape.
const dispatchBinding = (request, profileDigest) =>
  authorizationBinding(
    {
      ...request,
      repoDir: request.checkout.repoDir,
      wtDir: request.checkout.wtDir,
    },
    profileDigest
  );

export function createSpansExecution({
  admission,
  archive,
  captureTempRoot,
  createCaptureProcess = createSpansWorkerProcess,
  command = ['claude'],
  now = Date.now,
  observeProcess,
  profiles = SPANS_EXEC_DEFAULT_PROFILES,
  provider = {},
  resourcePaths,
  resolveTarget: resolveRegisteredTarget,
  runBudgetUsd = DEFAULT_RUN_BUDGET_USD,
  setupProgress,
  spawn,
  workerLimits = {},
} = {}) {
  const providerCommand = provider.command ?? command;
  const { artifacts, root, store } = archive;
  const limitsInUse = { ...WORKER_LIMITS, ...workerLimits };
  const resources = createSpansExecutionResources({
    admission,
    limits: limitsInUse,
    resourcePaths,
    root,
    store,
  });
  const pendingWrites = new Set();
  let writesClosed = false;

  async function archiveWrite(
    effect,
    maxBytes = ARCHIVE_WRITE_MAX_BYTES,
    request = { maxBytes, root }
  ) {
    if (
      writesClosed ||
      typeof admission?.withSpansArchiveWrite !== 'function'
    ) {
      return { code: 'SPANS_ARCHIVE_WRITE_UNAVAILABLE', ok: false };
    }
    let started = false;
    let completed;
    let effectPromise;
    let settled = false;
    let duplicate = false;
    let admitted;
    try {
      admitted = await admission.withSpansArchiveWrite(request, () => {
        if (started || settled) {
          duplicate = true;
          return { code: 'SPANS_ARCHIVE_WRITE_UNKNOWN', ok: false };
        }
        started = true;
        effectPromise = Promise.resolve().then(() => {
          archive.prepareWrite?.();
          return effect();
        });
        return effectPromise.then((value) => {
          completed = value;
          return value;
        });
      });
    } catch {
      admitted = undefined;
    } finally {
      settled = true;
    }
    if (effectPromise) {
      try {
        await effectPromise;
      } catch {
        return {
          code: 'SPANS_ARCHIVE_WRITE_UNKNOWN',
          ok: false,
          unknown: true,
        };
      }
    }
    if (
      started &&
      !duplicate &&
      admitted?.ok === true &&
      admitted.value === completed
    ) {
      return completed;
    }
    if (started) {
      return { code: 'SPANS_ARCHIVE_WRITE_UNKNOWN', ok: false, unknown: true };
    }
    return admitted?.ok === false
      ? admitted
      : { code: 'SPANS_ARCHIVE_WRITE_UNAVAILABLE', ok: false };
  }

  function trackWrite(promise) {
    pendingWrites.add(promise);
    promise.finally(() => pendingWrites.delete(promise)).catch(() => undefined);
    return promise;
  }

  const writeArchive = (effect, maxBytes) =>
    trackWrite(archiveWrite(effect, maxBytes));

  function writeMutation(method, payload) {
    return trackWrite(
      resources
        .writeRequest({ method, payload })
        .then((admitted) =>
          admitted.ok
            ? archiveWrite(
                () => store[method](payload),
                admitted.request.maxBytes,
                admitted.request
              )
            : admitted
        )
    );
  }

  // Async consumers await these writes; the real store retains its synchronous
  // SQLite contract for readers and effect fences.
  const writeStore = {
    ...store,
    appendEvent: (event) => writeMutation('appendEvent', event),
    commitRun: (input) => writeMutation('commitRun', input),
  };
  // A resolver that fails is an unknown target, never an exception.
  const resolveTarget = async (target) => {
    try {
      return await resolveRegisteredTarget(target);
    } catch {
      return null;
    }
  };
  const capability = createSpansCapability({
    command: providerCommand,
    env: provider.env,
    now,
    profiles,
    spawn,
    store,
    writeArchive,
  });
  const checkout = createCheckoutAdapter();
  const dependencies = createDependencyAdapter({
    resourcePaths,
    setupProgress,
  });
  const setup = createSetupAdapter({
    dependencyAdapter: dependencies,
    resourcePaths,
    setupProgress,
  });
  const runState = createRunStateAdapter({ store });
  const writer = createWriterAdapter({ store });
  const owner = createExecutionOwner({ root });
  // Attempts this service supervises right now, by attempt ID.
  const supervised = new Map();
  // The one in-flight guard of this service. A confirmed dispatch or a resolve
  // of a span holds it across every await it makes, and neither starts while
  // the other holds it, so a resolve can never release what a dispatch of the
  // same span has just taken, nor the reverse. It is a refusal, not a queue.
  const inFlight = new Set();
  function enter(runId, spanId) {
    const key = JSON.stringify([runId, spanId]);
    if (inFlight.has(key)) {
      return null;
    }
    inFlight.add(key);
    return () => inFlight.delete(key);
  }

  // -------------------------------------------------------------------------
  // The run view: authorizations and their frozen inputs live beside the
  // plan, committed with the same compare-and-set as every other change.
  // -------------------------------------------------------------------------

  const executionOf = (runId, actionId) => {
    const read = store.readRun({ runId });
    const record =
      read?.ok === true ? read.view?.executions?.[actionId] : undefined;
    return isRecord(record) ? record : null;
  };

  function executionFor(binding) {
    const record = executionOf(binding.runId, binding.actionId);
    return record && record.attemptId === binding.attemptId ? record : null;
  }

  async function commitView(runId, mutate) {
    for (let tries = 0; tries < MAX_COMMIT_TRIES; tries += 1) {
      const read = store.readRun({ runId });
      if (read?.ok !== true) {
        return { ok: false };
      }
      const view = structuredClone(read.view);
      const changed = mutate(view);
      if (!changed.ok) {
        return changed;
      }
      // biome-ignore lint/performance/noAwaitInLoops: Each admitted CAS retry must finish before rereading the current revision.
      const committed = await writeStore.commitRun({
        events: changed.events,
        expectedGeneration: read.generation,
        expectedRevision: read.revision,
        runId,
        view: redactSpansValue(view),
      });
      if (committed?.ok === true) {
        return { ok: true };
      }
      if (!STALE_REVISION_CODES.has(committed?.code)) {
        return { ok: false };
      }
    }
    return { ok: false };
  }

  function recordAuthorization(execution) {
    return commitView(execution.runId, (view) => {
      const existing = view.executions?.[execution.actionId];
      if (existing) {
        return existing.bindingDigest === execution.bindingDigest
          ? { events: [], ok: true }
          : { ok: false };
      }
      view.executions = { ...view.executions, [execution.actionId]: execution };
      return {
        events: [
          {
            eventId: `spans.execution.authorized:${sha256(
              JSON.stringify([
                execution.runId,
                execution.actionId,
                execution.bindingDigest,
              ])
            )}`,
            payload: {
              actionId: execution.actionId,
              attemptId: execution.attemptId,
              authorizationId: execution.authorizationId,
              bindingDigest: execution.bindingDigest,
              budgetMicro: execution.budgetMicro,
              profile: execution.profile,
              spanId: execution.spanId,
              wallClockMs: execution.wallClockMs,
            },
            runId: execution.runId,
            type: 'spans.execution.authorized',
          },
        ],
        ok: true,
      };
    });
  }

  // A refusal that provably started and held nothing takes its authorization
  // back, so a newly reviewed dispatch of the same span is not locked out by a
  // record nobody can use. Anything that reached intent, an attempt or a ledger
  // reservation is left exactly as it is: it is evidence or an unresolved hold.
  function withdrawAuthorization(execution) {
    return commitView(execution.runId, (view) => {
      const { actionId, attemptId } = execution;
      const reservation =
        view.usage?.reservations?.[
          usageReservationId(execution.runId, actionId)
        ];
      if (
        !(
          view.executions?.[actionId]?.bindingDigest ===
            execution.bindingDigest &&
          !view.actions?.[actionId] &&
          !view.attempts?.[attemptId] &&
          (!reservation || reservation.state === 'released')
        )
      ) {
        return { events: [], ok: true };
      }
      const { [actionId]: _withdrawn, ...rest } = view.executions;
      view.executions = rest;
      return {
        events: [
          {
            eventId: `spans.execution.authorization-withdrawn:${randomUUID()}`,
            payload: {
              actionId,
              attemptId,
              bindingDigest: execution.bindingDigest,
              spanId: execution.spanId,
            },
            runId: execution.runId,
            type: 'spans.execution.authorization-withdrawn',
          },
        ],
        ok: true,
      };
    });
  }

  const reviewFlow = createSpansExecutionReviewFlow({
    admission,
    artifacts,
    buildReview,
    now,
    parseReview,
    profiles,
    store,
    writeArchive,
  });

  // -------------------------------------------------------------------------
  // Adapters for the dispatch coordinator
  // -------------------------------------------------------------------------

  // Authorization exists only for a dispatch that was reviewed and confirmed
  // and recorded above. A request field can never stand in for it.
  const authorization = {
    async verify({ authorizationId, binding }) {
      const record = executionOf(binding.runId, binding.actionId);
      if (
        !(
          record &&
          record.authorizationId === authorizationId &&
          record.bindingDigest === digestOf(binding)
        )
      ) {
        return { ok: true, verified: false };
      }
      const approved = await reviewFlow.authorize(record.reviewRef);
      if (
        !(approved.ok && digestOf(approved.approval) === record.approvalDigest)
      ) {
        return { ok: true, verified: false };
      }
      return { authorizationId, binding, ok: true, verified: true };
    },
  };

  async function resolveLaunch(binding) {
    const execution = executionFor(binding);
    const definition = execution && profiles[execution.profile];
    // The session starts exactly as it was reviewed: the same mode and tools.
    if (
      !(
        execution &&
        definition &&
        inputsIntact(execution) &&
        digestOf(launchModeOf(definition)) === digestOf(execution.launchMode)
      )
    ) {
      return { code: 'WORKER_REFUSED', ok: false };
    }
    const approved = await reviewFlow.authorize(execution.reviewRef);
    if (
      !(approved.ok && digestOf(approved.approval) === execution.approvalDigest)
    ) {
      return { code: 'WORKER_REFUSED', ok: false };
    }
    const retainedInput = artifacts.read({
      artifactId: execution.inputArtifact?.id,
    });
    const retainedRequest = readSpansExecutionRequest({
      artifact: retainedInput,
      binding: approved.review.binding,
    });
    if (!retainedRequest.ok) {
      return { code: 'WORKER_REFUSED', ok: false };
    }
    const resolved = await resolveTarget(execution.target);
    const observed = isRecord(resolved)
      ? await checkout.observe({
          repoDir: resolved.repoDir,
          wtDir: resolved.wtDir,
        })
      : { ok: false };
    // The checkout must still be the incarnation that was reviewed.
    if (
      !(
        observed.ok &&
        JSON.stringify(observed.identity) ===
          JSON.stringify(execution.checkoutIdentity)
      )
    ) {
      return { code: 'WORKER_REFUSED', ok: false };
    }
    // The worker starts from exactly the tree that was reviewed.
    const tree = await observeTree(observed.identity.checkoutPath);
    if (!(tree.ok && tree.digest === execution.baselineTree)) {
      return { code: 'WORKER_REFUSED', ok: false };
    }
    return {
      argv: providerArguments(providerCommand, {
        effort: definition.effort,
        maxBudgetUsd:
          execution.budgetMicro === null
            ? undefined
            : execution.budgetMicro / 1_000_000,
        model: definition.model,
        permissionMode: definition.permissionMode,
        tools: definition.tools,
      }),
      cwd: observed.identity.checkoutPath,
      env: providerEnvironment(provider.env),
      ok: true,
      stdin: retainedInput.text,
    };
  }

  // The captured artifact is the first durable trace of what the process did.
  async function recordCaptured({ binding, result }) {
    const receipt = result?.receipt;
    const artifactId = receipt?.capture?.artifactId;
    if (!(result?.ok === true && artifactId)) {
      return;
    }
    return await writeStore.appendEvent({
      eventId: `spans.execution.captured:${sha256(
        JSON.stringify([binding.runId, binding.attemptId])
      )}`,
      payload: {
        actionId: binding.actionId,
        artifactId,
        artifactIds: [artifactId],
        attemptId: binding.attemptId,
        bytes: receipt.capture.bytes,
        chunks: receipt.capture.chunks,
        complete: receipt.capture.complete,
        exit: receipt.exit,
        spanId: binding.spanId,
      },
      runId: binding.runId,
      type: 'spans.execution.captured',
    });
  }

  const freshDispatches = new Set();
  const captureKey = (binding) =>
    JSON.stringify([binding.runId, binding.attemptId]);
  function authorizeCapture({ binding, operation }) {
    const execution = executionFor(binding);
    const read = store.readRun({ runId: binding.runId });
    const action = read?.view?.actions?.[binding.actionId];
    const exact = Boolean(
      execution &&
        read?.ok === true &&
        read.generation === binding.generation &&
        execution.reviewSelector?.generation === binding.generation &&
        execution.spanId === binding.spanId &&
        binding.workerId === WORKER_ID &&
        action?.actionId === binding.actionId &&
        action.attemptId === binding.attemptId &&
        action.spanId === binding.spanId
    );
    if (!exact) {
      return { currentAttempt: false, noEffect: true, ok: false };
    }
    if (operation === 'start') {
      const freshDispatch = freshDispatches.has(captureKey(binding));
      return {
        currentAttempt: true,
        freshDispatch,
        noEffect: true,
        ok: freshDispatch && reviewFlow.current(execution).ok === true,
      };
    }
    return { currentAttempt: true, ok: true };
  }
  const worker = createSpansExecutionCapture({
    archiveRoot: root,
    authorize: authorizeCapture,
    createProcess: ({
      archiveRoot,
      authorize,
      resolveArchiveAdmission,
      tempRoot,
    }) =>
      createCaptureProcess({
        authorize,
        observeProcess,
        resolveArchiveAdmission,
        root: archiveRoot,
        tempRoot,
        transportTimeoutMs: 5000,
      }),
    executionFor,
    limits: limitsInUse,
    onExit: handleExit,
    onHold: async ({ binding }) => {
      const read = store.readRun({ runId: binding.runId });
      if (
        read?.ok === true &&
        read.generation === binding.generation &&
        read.view.attempts?.[binding.attemptId]?.status === 'held' &&
        read.view.actions?.[binding.actionId]?.state === 'intent'
      ) {
        await recordUnknown(
          binding.runId,
          binding.actionId,
          binding.generation
        );
      }
    },
    resolveArchiveAdmission: ({ binding }) =>
      resources.captureContext({
        ...binding,
        target: executionFor(binding)?.target,
      }),
    resolveCapturePath: ({ archiveRoot, binding, tempRoot }) =>
      spansWorkerCapturePath({
        binding,
        root: archiveRoot,
        tempRoot,
      }),
    resolveSource: ({ binding }) => resolveLaunch(binding),
    store,
    tempRoot: captureTempRoot ?? dirname(root),
    workerId: WORKER_ID,
  });

  async function workerLaunch(request) {
    const execution = executionFor(request);
    const notLaunched = (code) => ({ code, dispatched: false, ok: false });
    if (
      !(
        execution &&
        execution.inputDigest === request.inputDigest &&
        inputsIntact(execution)
      )
    ) {
      return notLaunched('WORKER_REFUSED');
    }
    // The coordinator's checks are done; the worker's own effect boundary
    // looks again, so a change since then stops the launch here.
    const state = runState.read({
      actionId: request.actionId,
      runId: request.runId,
    });
    const claim = writer.check({
      checkoutPath: request.wtDir,
      session: request.writerSession,
    });
    if (
      !(
        state.ok &&
        state.generation === request.fence.generation &&
        state.planVersion === request.fence.planVersion &&
        state.action?.state === 'intent' &&
        claim.ok === true &&
        claim.claim?.session === request.writerSession
      )
    ) {
      return notLaunched('FENCE_STALE');
    }
    const key = captureKey(request);
    freshDispatches.add(key);
    let started;
    try {
      started = await worker.start({
        actionId: request.actionId,
        attemptId: request.attemptId,
        generation: request.generation,
        runId: request.runId,
        spanId: request.spanId,
      });
    } finally {
      freshDispatches.delete(key);
    }
    if (
      started.ok === true &&
      started.created === true &&
      ['running', 'observing', 'captured'].includes(started.status)
    ) {
      supervised.set(request.attemptId, {
        actionId: request.actionId,
        runId: request.runId,
        spanId: request.spanId,
      });
      return {
        dispatched: true,
        fence: request.fence,
        ok: true,
        workerId: WORKER_ID,
      };
    }
    if (started.ok === false && NOT_LAUNCHED_CODES.has(started.code)) {
      const reason = started.receipt?.reasonCode;
      return notLaunched(
        WORKER_REASONS.has(reason) ? reason : 'WORKER_REFUSED'
      );
    }
    // Anything else may have started a process.
    return { ok: false };
  }

  const usageLedger = createSpansUsage({ store: writeStore });
  const usage = createSpansExecutionUsage({
    artifacts,
    executionOf,
    facts: (profileId) => capability.usageFacts(profileId),
    ledger: usageLedger,
    limits: {
      aggregateLimitMicro: toMicro(runBudgetUsd),
      attemptLimitMicro: toMicro(SPANS_EXEC_LIMITS.maxBudgetUsd),
    },
    store,
  });

  const actions = createSpansActions({
    now,
    store: writeStore,
    verifyEvidence,
  });
  const coordinator = createSpansDispatch({
    adapters: {
      actions,
      admission: resources.admission,
      archive: createArchiveAdapter({ root }),
      authorization,
      capabilities: { verify: (request) => capability.verify(request) },
      checkout,
      dependencies,
      runState,
      setup,
      usage,
      worker: {
        launch: workerLaunch,
        verifyCompletion,
      },
      writer,
    },
  });

  // -------------------------------------------------------------------------
  // Completion: what a finished attempt durably shows, and nothing more
  // -------------------------------------------------------------------------

  const completionOf = (runId, actionId) => {
    const read = store.readRun({ runId });
    const record =
      read?.ok === true ? read.view?.completions?.[actionId] : undefined;
    return isRecord(record) ? record : null;
  };

  // A stored completion carries a digest of its own content, so a record edited
  // after it was written no longer verifies.
  const completionDigest = ({ recordDigest: _ignored, ...content }) =>
    digestOf(content);
  const completionIntact = (completion) =>
    completion.recordDigest === completionDigest(completion);

  function recordCompletion(unsealed) {
    const completion = {
      ...unsealed,
      recordDigest: completionDigest(unsealed),
    };
    return commitView(completion.runId, (view) => {
      if (view.completions?.[completion.actionId]) {
        return { events: [], ok: true };
      }
      view.completions = {
        ...view.completions,
        [completion.actionId]: completion,
      };
      return {
        events: [
          {
            eventId: `spans.execution.completion:${sha256(
              JSON.stringify([completion.runId, completion.actionId])
            )}`,
            payload: {
              actionId: completion.actionId,
              artifactIds: completion.artifactIds,
              attemptId: completion.attemptId,
              baselineTree: completion.baseline.digest,
              changed: completion.change.treeChanged,
              evidenceId: completion.evidenceId,
              outcome: completion.outcome,
              recordDigest: completion.recordDigest,
              spanId: completion.spanId,
              treeDigest: completion.tree.digest,
            },
            runId: completion.runId,
            type: 'spans.execution.completion',
          },
        ],
        ok: true,
      };
    });
  }

  // A reviewed requirement that the run change the tree is checked here, from
  // the two exact observations. Without it a run that changes nothing is a
  // legitimate result, for example a verification span.
  const outcomeOf = (verdict, execution, change) => {
    if (verdict.outcome !== 'completed') {
      return verdict.outcome;
    }
    const unmetChange = execution.requireChange && !change.treeChanged;
    // A session that did not run as reviewed is not the reviewed work.
    const wrongSession = ['mismatch', 'unobserved'].includes(
      sessionState(execution, verdict.init)
    );
    return unmetChange || wrongSession ? 'failed' : 'completed';
  };

  // What the finished attempt left behind, set against what was reviewed. The
  // first verified observation fixes it, so later calls cannot move it.
  async function observeCompletion({ execution, record, request, verdict }) {
    const tree = await observeTree(execution.checkoutIdentity.checkoutPath);
    if (!tree.ok) {
      return null;
    }
    const change = describeChange(execution.baseline, tree);
    const outcome = outcomeOf(verdict, execution, change);
    const { artifactId } = record.capture;
    const observedAt = now();
    return {
      actionId: request.actionId,
      artifactIds: [artifactId],
      attemptId: request.attemptId,
      baseline: execution.baseline,
      change,
      changedPaths: await changedPathsSince(
        execution.checkoutIdentity.checkoutPath,
        execution.baseline.head
      ),
      checks: {
        cancel: verdict.cancelled ? 'cancelled' : 'none',
        capture: 'complete',
        exit: verdict.clean ? 'clean' : 'not-clean',
        requireChange: requireChangeState(execution, change),
        session: sessionState(execution, verdict.init),
        tree: 'observed',
      },
      costCheck: verdict.costCheck,
      // A subscription run has no charge to record; its figure is an estimate
      // kept apart, under `reported.usage`.
      costMicro: isSubscription(execution) ? null : verdict.costMicro,
      criteria: execution.criteria,
      evidenceId: derivedId(
        'spans-evidence',
        request.runId,
        request.actionId,
        request.attemptId,
        artifactId,
        outcome
      ),
      exit: record.exit,
      exitRecordedAt: record.receipt?.at ?? null,
      independentValidation: false,
      launchMode: execution.launchMode,
      observedAt,
      outcome,
      reported: {
        providerResult: verdict.providerResult,
        ...(isSubscription(execution) ? { usage: usageEstimate(verdict) } : {}),
        ...(execution.launchMode.tools
          ? { session: sessionReport(verdict.init) }
          : {}),
      },
      runId: request.runId,
      spanId: request.spanId,
      tree: {
        bytes: tree.bytes,
        digest: tree.digest,
        files: tree.files,
        head: tree.head,
      },
    };
  }

  function requireChangeState(execution, change) {
    if (!execution.requireChange) {
      return 'not-required';
    }
    // Content decides. An empty commit moves HEAD without changing any file.
    return change.treeChanged ? 'met' : 'unmet';
  }

  // The coordinator's completion contract. The verdict comes from the durable
  // attempt record and its captured artifact. The first verified observation
  // fixes the tree, so later calls cannot move it.
  async function verifyCompletion(request) {
    const execution = executionFor(request);
    const found = attemptRecord(request.runId, request.attemptId);
    const state = runState.read({
      actionId: request.actionId,
      runId: request.runId,
    });
    if (
      !(
        execution &&
        found &&
        state.ok &&
        state.action &&
        found.record.actionId === request.actionId &&
        found.record.spanId === request.spanId &&
        found.record.workerId === request.workerId &&
        found.record.generation === request.generation
      )
    ) {
      return { ok: false };
    }
    const { record } = found;
    const artifact = artifacts.read({ artifactId: record.capture?.artifactId });
    const verdict = classifyTerminal({
      attempt: record,
      text: artifact.ok ? artifact.text : undefined,
    });
    if (!verdict.verdict) {
      return { ok: false };
    }
    const resolved = await resolveTarget(execution.target);
    const observed = isRecord(resolved)
      ? await checkout.observe({
          repoDir: resolved.repoDir,
          wtDir: resolved.wtDir,
        })
      : { ok: false };
    if (
      !(
        observed.ok &&
        JSON.stringify(observed.identity) ===
          JSON.stringify(execution.checkoutIdentity)
      )
    ) {
      return { ok: false };
    }
    let completion = completionOf(request.runId, request.actionId);
    if (!completion) {
      const sealed = await observeCompletion({
        execution,
        record,
        request,
        verdict,
      });
      if (!sealed) {
        return { ok: false };
      }
      await recordCompletion(sealed);
      completion = completionOf(request.runId, request.actionId);
    }
    if (
      !(
        completion &&
        completionIntact(completion) &&
        completion.attemptId === request.attemptId &&
        completion.outcome === outcomeOf(verdict, execution, completion.change)
      )
    ) {
      return { ok: false };
    }
    return {
      actionId: request.actionId,
      artifactIds: [...completion.artifactIds],
      attemptId: request.attemptId,
      checkoutIdentity: execution.checkoutIdentity,
      evidenceId: completion.evidenceId,
      generation: request.generation,
      inputDigest: state.action.inputDigest,
      ok: true,
      outcome: completion.outcome,
      planVersion: state.action.planVersion,
      runId: request.runId,
      spanId: request.spanId,
      targetDigest: state.action.targetDigest,
      terminal: true,
      verified: true,
      workerId: request.workerId,
      writerSession: writerSession(request),
    };
  }

  // The request the coordinator needs to verify, record and settle one action.
  function completionRequest(runId, actionId) {
    const read = store.readRun({ runId });
    const execution = executionOf(runId, actionId);
    const attempt =
      read?.ok === true && execution
        ? read.view.attempts?.[execution.attemptId]
        : null;
    return isRecord(attempt)
      ? {
          actionId,
          attemptId: attempt.attemptId,
          generation: read.generation,
          runId,
          spanId: attempt.spanId,
          workerId: attempt.workerId,
        }
      : null;
  }

  async function finishAction(runId, actionId) {
    const request = completionRequest(runId, actionId);
    return request
      ? await coordinator.completeOwned(request)
      : fail('SPANS_EXEC_ATTEMPT_NOT_FOUND');
  }

  // Runs when the supervisor has read a process to its end. The captured
  // artifact is noted first; then the exit is verified and, if it proves a
  // terminal result, recorded and settled. Anything unverifiable stays held.
  async function handleExit({ binding, result }) {
    supervised.delete(binding.attemptId);
    const captured = await recordCaptured({ binding, result });
    if (!(captured?.ok === true && result?.ok === true)) {
      return captured;
    }
    if (result.receipt.capture.complete !== true) {
      const read = store.readRun({ runId: binding.runId });
      if (read.view?.actions?.[binding.actionId]?.state === 'intent') {
        const held = await recordUnknown(
          binding.runId,
          binding.actionId,
          read.generation
        );
        if (held?.ok !== true) {
          return held;
        }
      }
      return { ok: true, settled: false };
    }
    return await finishAction(binding.runId, binding.actionId);
  }

  // -------------------------------------------------------------------------
  // Acceptance: the one place a span becomes complete
  // -------------------------------------------------------------------------

  const sameSet = (left, right) =>
    Array.isArray(left) &&
    Array.isArray(right) &&
    left.length === right.length &&
    [...left].sort().every((id, index) => id === [...right].sort()[index]);

  // Everything an owner is shown before accepting, and the token that binds it.
  // It keeps three things apart: what the provider reported, what Setu checked,
  // and what the owner accepts. Setu ran no test of its own, so acceptance
  // rests on the owner's judgement of this evidence and the criteria they set.
  function acceptanceReview({ action, completion, generation, runId }) {
    const review = {
      accepted: false,
      actionId: action.actionId,
      after: {
        digest: completion.tree.digest,
        files: completion.tree.files,
        head: completion.tree.head,
      },
      artifactIds: [...completion.artifactIds],
      attemptId: action.attemptId,
      before: {
        digest: completion.baseline.digest,
        files: completion.baseline.files,
        head: completion.baseline.head,
      },
      change: completion.change,
      changedPaths: completion.changedPaths,
      completionEvidenceId: completion.evidenceId,
      completionRecordDigest: completion.recordDigest,
      criteria: completion.criteria,
      exit: completion.exit,
      generation,
      independentValidation: false,
      mode: completion.launchMode,
      outcome: completion.outcome,
      planVersion: action.planVersion,
      reported: {
        costCheck: completion.costCheck,
        costMicro: completion.costMicro,
        ...completion.reported,
      },
      runId,
      spanId: action.spanId,
      validation: 'owner-judgement',
      verified: {
        ...completion.checks,
        // The tree is fixed the first time the exit is verified. After a
        // restart that can be long after the exit, and any edit made in
        // between is part of what was observed.
        exitRecordedAt: completion.exitRecordedAt,
        treeObservedAt: completion.observedAt,
      },
    };
    return {
      confirmation: `${ACCEPT_PREFIX}${digestOf(review)}`,
      review,
    };
  }

  // Registered with the actions layer. It accepts only a completed action
  // whose artifacts, tree and owner confirmation all match what the durable
  // completion record says, and whose tree is still exactly that tree.
  async function verifyEvidence(references) {
    const refused = { ok: false, verified: false };
    const { actionId, evidence, runId } = references;
    const completion = completionOf(runId, actionId);
    const execution = executionOf(runId, actionId);
    const read = store.readRun({ runId });
    const action = read?.ok === true ? read.view.actions?.[actionId] : null;
    const evidenceFields = [
      'acceptedBy',
      'artifactIds',
      'completionEvidenceId',
      'confirmation',
      'tree',
    ];
    if (
      !(
        references.purpose === 'accept-completion' &&
        completion &&
        completionIntact(completion) &&
        execution &&
        completion.baseline.digest === execution.baselineTree &&
        completion.checks.requireChange !== 'unmet' &&
        completion.checks.cancel === 'none' &&
        !['mismatch', 'unobserved'].includes(completion.checks.session) &&
        isRecord(action) &&
        completion.attemptId === references.attemptId &&
        completion.outcome === 'completed' &&
        isRecord(evidence) &&
        Object.keys(evidence).sort().join() === evidenceFields.join() &&
        evidence.acceptedBy === 'owner' &&
        evidence.completionEvidenceId === completion.evidenceId &&
        sameSet(evidence.artifactIds, completion.artifactIds) &&
        sameSet(references.outcomeArtifactIds, completion.artifactIds) &&
        evidence.tree === completion.tree.digest &&
        references.tree === completion.tree.digest
      )
    ) {
      return refused;
    }
    const expected = acceptanceReview({
      action,
      completion,
      generation: references.generation,
      runId,
    });
    if (evidence.confirmation !== expected.confirmation) {
      return refused;
    }
    // The attempt must still show the terminal result the completion claims,
    // and every artifact it names must still read back whole.
    const attempt = read.view.attempts?.[references.attemptId];
    const artifact = artifacts.read({ artifactId: completion.artifactIds[0] });
    const terminal = classifyTerminal({
      attempt,
      text: artifact.ok ? artifact.text : undefined,
    });
    if (
      !(
        terminal.verdict &&
        terminal.outcome === 'completed' &&
        attempt.capture.artifactId === completion.artifactIds[0]
      )
    ) {
      return refused;
    }
    const current = await observeTree(execution.checkoutIdentity.checkoutPath);
    if (!(current.ok && current.digest === completion.tree.digest)) {
      return refused;
    }
    return {
      evidenceId: derivedId(
        'spans-accept',
        runId,
        actionId,
        completion.evidenceId,
        completion.tree.digest
      ),
      ok: true,
      verified: true,
    };
  }

  // Reads what an acceptance would be about, or says why there is none.
  function acceptanceTarget({ actionId, runId }) {
    const read = store.readRun({ runId });
    if (read?.ok !== true) {
      return { refusal: fail('SPANS_EXEC_RUN_UNAVAILABLE') };
    }
    const action = read.view.actions?.[actionId];
    const execution = executionOf(runId, actionId);
    const span = execution && read.view.spans?.[execution.spanId];
    if (!(isRecord(action) && execution && isRecord(span))) {
      return { refusal: fail('SPANS_EXEC_ACTION_NOT_FOUND') };
    }
    const settled =
      span.state === 'completed' && span.acceptedActionId === actionId;
    const completion = completionOf(runId, actionId);
    if (!((settled || action.state === 'completed') && completion)) {
      return {
        refusal: fail('SPANS_EXEC_NOT_COMPLETED', { action: action.state }),
      };
    }
    if (!completionIntact(completion)) {
      return { refusal: fail('SPANS_EXEC_EVIDENCE_INVALID') };
    }
    return { action, completion, execution, read, refusal: null, settled };
  }

  // A tree that is not exactly the completed one is never accepted.
  async function treeRefusal(execution, completion) {
    const tree = await observeTree(execution.checkoutIdentity.checkoutPath);
    if (!tree.ok) {
      return fail('SPANS_EXEC_TREE_UNREADABLE');
    }
    return tree.digest === completion.tree.digest
      ? null
      : fail('SPANS_EXEC_TREE_CHANGED', {
          expectedTree: completion.tree.digest,
          observedTree: tree.digest,
        });
  }

  async function accept(input) {
    const request = exactRequest(
      input,
      ['actionId', 'runId'],
      ['confirmation']
    );
    if (
      !(
        request &&
        isExplicitId(request.runId) &&
        isExplicitId(request.actionId) &&
        (request.confirmation === undefined ||
          typeof request.confirmation === 'string')
      )
    ) {
      return invalid();
    }
    const { actionId, runId } = request;
    if (request.confirmation !== undefined && !(await owner.acquire()).ok) {
      return fail('SPANS_EXEC_OWNED_ELSEWHERE');
    }
    const target = acceptanceTarget({ actionId, runId });
    if (target.refusal) {
      return target.refusal;
    }
    const { action, completion, execution, read } = target;
    const changed = target.settled
      ? null
      : await treeRefusal(execution, completion);
    if (changed) {
      return changed;
    }
    const { confirmation, review } = acceptanceReview({
      action,
      completion,
      generation: read.generation,
      runId,
    });
    if (request.confirmation === undefined) {
      return fail('SPANS_EXEC_ACCEPTANCE_CONFIRMATION_REQUIRED', {
        confirmation,
        review,
      });
    }
    if (request.confirmation !== confirmation) {
      return fail('SPANS_EXEC_REVIEW_CHANGED', { confirmation, review });
    }
    const accepted = await actions.acceptCompletion({
      actionId,
      evidence: {
        acceptedBy: 'owner',
        artifactIds: [...completion.artifactIds],
        completionEvidenceId: completion.evidenceId,
        confirmation,
        tree: completion.tree.digest,
      },
      generation: read.generation,
      runId,
      spanId: execution.spanId,
    });
    if (!accepted.ok) {
      return fail('SPANS_EXEC_ACCEPTANCE_REFUSED', { cause: accepted.code });
    }
    // The span is accepted. Only now may the writer claim over its tree go.
    const released = await finishAction(runId, actionId);
    return {
      accepted: true,
      actionId,
      checkpoint: accepted.checkpoint,
      evidenceId: accepted.evidenceId,
      ok: true,
      readySpanIds: accepted.readySpanIds ?? [],
      resources: released.resources,
      spanId: execution.spanId,
      status: 'accepted',
    };
  }

  async function complete(input) {
    const request = exactRequest(input, ['actionId', 'runId']);
    if (
      !(
        request &&
        isExplicitId(request.runId) &&
        isExplicitId(request.actionId)
      )
    ) {
      return invalid();
    }
    if (!(await owner.acquire()).ok) {
      return fail('SPANS_EXEC_OWNED_ELSEWHERE');
    }
    return await finishAction(request.runId, request.actionId);
  }

  // -------------------------------------------------------------------------
  // Review: observe everything a dispatch would bind, change nothing.
  // -------------------------------------------------------------------------

  function profileRequest(input) {
    const request = exactRequest(input, ['profile']);
    return request && PROFILE_PATTERN.test(request.profile) ? request : null;
  }

  // The checkout, its dependencies, its setup and its exact content, observed
  // for a review. Any of them unknown is a refusal, never a default.
  async function observeInputs(request) {
    const resolved = await resolveTarget(request.target);
    if (!(isRecord(resolved) && resolved.wtDir && resolved.repoDir)) {
      return { refusal: fail('SPANS_EXEC_TARGET_UNKNOWN') };
    }
    const { repoDir, wtDir } = resolved;
    const observed = await checkout.observe({ repoDir, wtDir });
    if (!observed.ok) {
      return { refusal: fail('SPANS_EXEC_CHECKOUT_UNKNOWN') };
    }
    const ready = await setup.ensure({
      checkoutIdentity: observed.identity,
      target: request.target,
      wtDir,
    });
    if (!(ready.ok && ready.state === 'ready')) {
      return { refusal: fail('SPANS_EXEC_SETUP_NOT_READY') };
    }
    const dependency = await dependencies.observe({
      checkoutIdentity: observed.identity,
      target: request.target,
      wtDir,
    });
    if (!dependency.ok) {
      return { refusal: fail('SPANS_EXEC_DEPENDENCY_UNKNOWN') };
    }
    // The exact content the work will start from, so a completion can be
    // compared with what was reviewed and not only with itself.
    const before = await observeTree(observed.identity.checkoutPath);
    if (!before.ok) {
      return { refusal: fail('SPANS_EXEC_TREE_UNREADABLE') };
    }
    return {
      baseline: {
        digest: before.digest,
        files: before.files,
        head: before.head,
      },
      dependency,
      observed,
      refusal: null,
      repoDir,
      wtDir,
    };
  }

  async function buildReview(request, selector) {
    const read = store.readRun({ runId: request.runId });
    if (read?.ok !== true || !isRecord(read.view)) {
      return { refusal: fail('SPANS_EXEC_RUN_UNAVAILABLE') };
    }
    const { view } = read;
    const planned = checkSpan(view, request.runId, request.spanId, selector);
    if (!planned.ok) {
      return planned;
    }
    const definition = profiles[request.profile];
    const budgetProblem = budgetRefusal(request, definition);
    if (budgetProblem) {
      return { refusal: budgetProblem };
    }
    const verified = capability.verify({ profile: request.profile });
    const launch = capability.capabilities(request.profile);
    if (!(verified.ok && launch.ok && launch.launch.allowed)) {
      return {
        refusal: fail('SPANS_EXEC_CAPABILITY_UNVERIFIED', {
          blockedBy: launch.launch?.blockedBy ?? ['session'],
        }),
      };
    }
    const seen = await observeInputs(request);
    if (seen.refusal) {
      return seen;
    }
    const { baseline, dependency, observed, repoDir, wtDir } = seen;
    const expected = {
      dependency: dependency.identity,
      dirty: observed.dirty,
      head: observed.head,
      identity: observed.identity,
    };
    const targetDigest = targetDigestFor(expected);
    const launchMode = launchModeOf(definition);
    const budgetMicro =
      request.budgetUsd === undefined ? null : toMicro(request.budgetUsd);
    const inputDigest = inputDigestOf({
      baselineTree: baseline.digest,
      budgetMicro,
      criteria: request.criteria,
      instructions: request.instructions,
      launchMode,
      requireChange: request.requireChange,
      wallClockMs: request.wallClockMs,
    });
    const review = {
      acceptance: {
        criteria: request.criteria,
        requireChange: request.requireChange,
      },
      ...plannedExecutionIds(planned, request),
      ...(budgetMicro === null
        ? { cost: SUBSCRIPTION_COST }
        : { budgetUsd: request.budgetUsd }),
      checkout: {
        dirtyCount: observed.dirty.count,
        head: observed.head,
        tree: { digest: baseline.digest, files: baseline.files },
      },
      generation: read.generation,
      instructions: request.instructions,
      launch: launch.launch,
      mode: {
        ...launchMode,
        // What the probe saw of the effort, next to what is asked for. A null
        // here means it was not observed, not that it is low.
        effort: {
          ...launchMode.effort,
          observed: launch.observations?.effort?.observed ?? null,
          status: launch.launch.unverified?.includes('effort')
            ? 'requested, not verified'
            : 'verified',
        },
      },
      planVersion: view.planVersion,
      profile: request.profile,
      requiredCapabilities: requiredCapabilitiesOf(definition),
      runId: request.runId,
      spanId: request.spanId,
      target: request.target,
      wallClockMs: request.wallClockMs,
    };
    const reviewDigest = digestOf({
      ...review,
      inputDigest,
      profileDigest: verified.profile.digest,
      targetDigest,
    });
    const dispatchRequest = {
      actionId: review.actionId,
      admissionKind: ADMISSION_KIND,
      attemptId: review.attemptId,
      authorizationId: derivedId('spans-auth', reviewDigest),
      checkout: { expected, repoDir, wtDir },
      generation: review.generation,
      inputDigest,
      planVersion: review.planVersion,
      profile: review.profile,
      requiredCapabilities: review.requiredCapabilities,
      requireEnforcedCap: !isSubscription(definition),
      runId: review.runId,
      spanId: review.spanId,
      target: review.target,
      targetDigest,
    };
    return {
      baseline,
      budgetMicro,
      confirmation: `${CONFIRMATION_PREFIX}${reviewDigest}`,
      dispatchRequest,
      launchMode,
      observed,
      profileDigest: verified.profile.digest,
      refusal: null,
      review,
    };
  }

  // -------------------------------------------------------------------------
  // Cancellation and the deadline
  // -------------------------------------------------------------------------

  const attemptRecord = (runId, attemptId) => {
    const read = store.readRun({ runId });
    const record = read?.ok === true ? read.view?.attempts?.[attemptId] : null;
    return isRecord(record) ? { generation: read.generation, record } : null;
  };

  function workerRef({ generation, record }) {
    return {
      actionId: record.actionId,
      attemptId: record.attemptId,
      coordinatorGeneration: generation,
      generation: record.generation,
      processStartId: record.processStart?.id,
      runId: record.runId,
      spanId: record.spanId,
      workerId: record.workerId,
    };
  }

  // Delivers a stop to the exact owned attempt. Delivery is recorded as
  // delivery; only the exit the supervisor later observes ends the attempt.
  async function cancel(input) {
    const request = exactRequest(input, ['attemptId', 'runId']);
    if (
      !(
        request &&
        isExplicitId(request.runId) &&
        isExplicitId(request.attemptId)
      )
    ) {
      return invalid();
    }
    if (!(await owner.acquire()).ok) {
      return fail('SPANS_EXEC_OWNED_ELSEWHERE');
    }
    const found = attemptRecord(request.runId, request.attemptId);
    if (!found) {
      return fail('SPANS_EXEC_ATTEMPT_NOT_FOUND');
    }
    if (!found.record.processStart?.id) {
      return fail('SPANS_EXEC_CANCEL_REFUSED');
    }
    const result = await worker.cancel(workerRef(found));
    if (result.ok === true) {
      return {
        attemptId: request.attemptId,
        cancel: result.cancel,
        ok: true,
        terminal: result.terminal === true,
      };
    }
    return result.cancel === 'unknown'
      ? fail('SPANS_EXEC_CANCEL_UNKNOWN', { cancel: 'unknown' })
      : fail('SPANS_EXEC_CANCEL_REFUSED');
  }

  // The detached child owns deadlines and stop; the parent only observes them.
  async function enforceDeadlines() {
    if (!(await owner.acquire()).ok) {
      return fail('SPANS_EXEC_OWNED_ELSEWHERE');
    }
    const held = [];
    await Promise.all(
      [...supervised.entries()].map(async ([attemptId, owned]) => {
        const found = attemptRecord(owned.runId, attemptId);
        if (!found) {
          return;
        }
        await worker.observe(workerRef(found));
        const current = attemptRecord(owned.runId, attemptId);
        if (current?.record.status === 'held') {
          held.push(attemptId);
          supervised.delete(attemptId);
          await recordUnknown(owned.runId, owned.actionId, current.generation);
        }
      })
    );
    return { failed: [], held, ok: true };
  }

  // A worker, a model or a peer may say it is done. That is recorded as what
  // was said, with its generation, and decides nothing: the only completion is
  // the one verified from the durable attempt. A report from an older
  // generation is history by the actions layer's own rule.
  function parseReport(input) {
    const request = exactRequest(
      input,
      ['actionId', 'generation', 'outcome', 'runId'],
      ['artifactIds']
    );
    return request &&
      isExplicitId(request.runId) &&
      isExplicitId(request.actionId) &&
      Number.isSafeInteger(request.generation) &&
      request.generation >= 0 &&
      ['completed', 'failed', 'unknown'].includes(request.outcome) &&
      (request.artifactIds === undefined ||
        (Array.isArray(request.artifactIds) &&
          request.artifactIds.length <= 64 &&
          request.artifactIds.every(isExplicitId)))
      ? request
      : null;
  }

  // A report may only name output this run already captured. Naming any other
  // artifact would make it readable through this run.
  const namesOnlyCaptured = (view, artifactIds = []) => {
    const captured = new Set(
      Object.values(view.attempts ?? {}).map(
        (attempt) => attempt?.capture?.artifactId
      )
    );
    return artifactIds.every((id) => captured.has(id));
  };

  async function recordHistorical(request) {
    const history = await actions.recordOutcome({
      actionId: request.actionId,
      artifactIds: request.artifactIds ?? [],
      generation: request.generation,
      outcome: request.outcome,
      runId: request.runId,
    });
    return {
      advanced: false,
      historical: history.historical === true,
      ok: history.historical === true,
      status: 'historical',
    };
  }

  async function report(input) {
    const request = parseReport(input);
    if (!request) {
      return invalid();
    }
    const read = store.readRun({ runId: request.runId });
    const action =
      read?.ok === true ? read.view.actions?.[request.actionId] : null;
    if (!isRecord(action)) {
      return fail('SPANS_EXEC_ACTION_NOT_FOUND');
    }
    if (!namesOnlyCaptured(read.view, request.artifactIds)) {
      return invalid();
    }
    if (request.generation > read.generation) {
      return fail('SPANS_EXEC_GENERATION_AHEAD');
    }
    if (request.generation < read.generation) {
      return await recordHistorical(request);
    }
    const appended = await writeStore.appendEvent({
      eventId: `spans.execution.reported:${digestOf([
        request.runId,
        request.actionId,
        request.generation,
        request.outcome,
        request.artifactIds ?? [],
      ])}`,
      payload: {
        actionId: request.actionId,
        authoritative: false,
        claimedArtifacts: request.artifactIds ?? [],
        generation: request.generation,
        outcome: request.outcome,
        spanId: action.spanId,
      },
      runId: request.runId,
      type: 'spans.execution.reported',
    });
    return appended?.ok === true
      ? { advanced: false, ok: true, status: 'reported' }
      : fail('SPANS_EXEC_REPORT_NOT_RECORDED');
  }

  // -------------------------------------------------------------------------
  // Restart reconciliation: hold what is unknown, settle what is proven
  // -------------------------------------------------------------------------

  async function processObservation(attempt) {
    const pid = attempt.processStart?.pid;
    if (!pid) {
      // A launch that was never recorded may still have started a process.
      return { state: 'unknown' };
    }
    const observed = await (observeProcess ?? observeProcessIdentity)(pid);
    if (observed?.state === 'absent') {
      return { state: 'absent' };
    }
    if (observed?.state !== 'alive') {
      return { state: 'unknown' };
    }
    return {
      processId: observed.processId,
      processStartIdentity: observed.processStartIdentity,
      state: 'alive',
    };
  }

  // The recovery module only decides; this records what it decided. It never
  // signals, relaunches or completes anything: a worker that is alive, absent
  // or unknown is held, and only a verified terminal receipt settles.
  function recoveryProcessIdentity(attempt) {
    const start = attempt.processStart;
    if (!start) {
      return null;
    }
    const prefix = `${start.pid}:`;
    return start.id?.startsWith(prefix)
      ? start.id.slice(prefix.length)
      : (start.id ?? null);
  }

  async function recordRecovery({ attempt, execution, generation, runId }) {
    const resolved = await resolveTarget(execution.target);
    const current = isRecord(resolved)
      ? await checkout.observe({
          repoDir: resolved.repoDir,
          wtDir: resolved.wtDir,
        })
      : { ok: false };
    const decision = reconcileSpansRecovery({
      attemptReceipt: {
        actionId: attempt.actionId,
        attemptId: attempt.attemptId,
        checkoutIdentity: execution.checkoutIdentity,
        deadlineAtMs: attempt.deadlineAt ?? null,
        generation: attempt.generation,
        lastObservedWallTimeMs: attempt.updatedAt ?? null,
        nativeSessionId: attempt.nativeId ?? null,
        runId,
        spanId: attempt.spanId,
        worker: {
          processId: attempt.processStart?.pid ?? null,
          processStartIdentity: recoveryProcessIdentity(attempt),
        },
      },
      clock: { sleepWakeGap: null, wallTimeMs: now() },
      currentCheckoutIdentity: current.ok
        ? current.identity
        : { known: false, reason: 'checkout not observed' },
      currentGeneration: generation,
      processObservation: await processObservation(attempt),
    });
    if (decision.ok) {
      for (const event of decision.events) {
        // biome-ignore lint/performance/noAwaitInLoops: Each durable recovery event must finish before the next is attempted.
        const recorded = await writeStore.appendEvent(event);
        if (recorded?.ok !== true) {
          return { decision: 'unrecorded', status: 'unknown' };
        }
      }
    }
    return decision.ok
      ? { decision: decision.decision, status: decision.status }
      : { decision: 'unrecorded', status: 'unknown' };
  }

  function recordUnknown(runId, actionId, generation) {
    return actions.recordOutcome({
      actionId,
      artifactIds: [],
      generation,
      outcome: 'unknown',
      runId,
    });
  }

  // An attempt whose exit is durable is settled from its own evidence.
  async function reconcileExited(base) {
    const finished = await finishAction(base.runId, base.actionId);
    const latest = store.readRun({ runId: base.runId }).view.actions?.[
      base.actionId
    ];
    return {
      ...base,
      action: latest?.state ?? null,
      reason: finished.ok ? undefined : finished.code,
      state: finished.ok ? 'settled' : 'held',
    };
  }

  // Anything else is work whose fate is not proven: hold it, record why, and
  // leave every resource where it is.
  async function reconcileUnproven({ base, execution, read }) {
    const { actionId, attemptId, runId } = base;
    if (read.view.actions?.[actionId]?.state === 'intent') {
      await recordUnknown(runId, actionId, read.generation);
    }
    const latest = store.readRun({ runId });
    const held = latest?.ok === true ? latest.view.attempts?.[attemptId] : null;
    if (!isRecord(held)) {
      return { ...base, reason: 'attempt-observation-unknown', state: 'held' };
    }
    const recovery = await recordRecovery({
      attempt: held,
      execution,
      generation: read.generation,
      runId,
    });
    return {
      ...base,
      ...recovery,
      reason: held.receipt?.reason,
      state: 'held',
    };
  }

  async function reconcileExecution(runId, execution) {
    const { actionId, attemptId, spanId } = execution;
    const base = { actionId, attemptId, runId, spanId };
    const read = store.readRun({ runId });
    const action = read?.ok === true ? read.view.actions?.[actionId] : null;
    const attempt = read?.ok === true ? read.view.attempts?.[attemptId] : null;
    if (!isRecord(action)) {
      // Authorized and possibly reserved, but no intent exists: nothing was
      // launched. What was reserved stays reserved.
      return {
        ...base,
        reason: 'authorized-without-intent',
        resolvable: true,
        state: 'held',
      };
    }
    if (!isRecord(attempt)) {
      if (action.state === 'intent') {
        await recordUnknown(runId, actionId, read.generation);
      }
      return { ...base, reason: 'intent-without-attempt', state: 'held' };
    }
    const observed = await worker.recover(
      workerRef({ generation: read.generation, record: attempt })
    );
    if (observed.ok === true && observed.status === 'running') {
      supervised.set(attemptId, { actionId, runId, spanId });
      return { ...base, state: 'supervised' };
    }
    if (observed.ok === true && observed.parentFinalized === true) {
      return await reconcileExited(base);
    }
    return await reconcileUnproven({ base, execution, read });
  }

  // The executions recorded in one run.
  function executionsOfRun(runId) {
    const read = store.readRun({ runId });
    return read?.ok === true ? Object.values(read.view.executions ?? {}) : [];
  }

  // Every execution recorded in the archive, run by run.
  function* executionsInArchive() {
    let afterRunId;
    for (;;) {
      const page = store.listRuns(
        afterRunId === undefined ? { limit: 200 } : { afterRunId, limit: 200 }
      );
      if (page?.ok !== true) {
        throw new Error('runs unreadable');
      }
      for (const { runId } of page.runs) {
        for (const execution of executionsOfRun(runId)) {
          yield { execution, runId };
        }
      }
      if (!page.hasMore) {
        return;
      }
      afterRunId = page.nextRunId;
    }
  }

  // Walks every execution in the archive once. It starts no process, signals no
  // process and releases nothing that is not proven finished.
  async function reconcile(input = {}) {
    if (!exactRequest(input, [])) {
      return invalid();
    }
    if (!(await owner.acquire()).ok) {
      return fail('SPANS_EXEC_OWNED_ELSEWHERE');
    }
    let found;
    try {
      found = [...executionsInArchive()];
    } catch {
      return fail('SPANS_EXEC_RUN_UNAVAILABLE');
    }
    const reconciled = [];
    for (const { execution, runId } of found) {
      // biome-ignore lint/performance/noAwaitInLoops: Executions are reconciled one at a time so each sees the last one's records.
      reconciled.push(await reconcileExecution(runId, execution));
    }
    return { ok: true, reconciled };
  }

  // -------------------------------------------------------------------------
  // Resolving a dispatch that was authorized but never reached intent
  // -------------------------------------------------------------------------

  // The worker cannot start before the action's intent is durable and its
  // attempt record exists. An authorization with neither, that no dispatch of
  // this service is still working on, therefore started nothing. Whatever it
  // reserved is the only thing left, and it is released here by an owner who
  // has been shown it. Anything with an intent, an attempt or a process is
  // another case: it keeps every resource.
  function unlaunchedTarget(runId, actionId) {
    const read = store.readRun({ runId });
    const execution = executionOf(runId, actionId);
    if (read?.ok !== true || !execution) {
      return { refusal: fail('SPANS_EXEC_ACTION_NOT_FOUND') };
    }
    const { attemptId, spanId } = execution;
    if (
      read.view.actions?.[actionId] ||
      read.view.attempts?.[attemptId] ||
      supervised.has(attemptId)
    ) {
      return { refusal: fail('SPANS_EXEC_NOT_RESOLVABLE') };
    }
    const others = Object.values(read.view.actions ?? {}).filter(
      (action) => isRecord(action) && action.spanId === spanId
    );
    return {
      execution,
      read,
      refusal: null,
      spanHasHistory: others.length > 0,
    };
  }

  async function resolveReview({ execution, read, runId, spanHasHistory }) {
    const leases = (await admission.status())?.leases ?? [];
    const lease = leases.find(
      (candidate) => candidate.operationId === admissionOperationId(execution)
    );
    const reservation =
      read.view.usage?.reservations?.[
        usageReservationId(runId, execution.actionId)
      ];
    const session = writerSession(execution);
    const claim = writer.check({
      checkoutPath: execution.checkoutIdentity.checkoutPath,
      session,
    });
    const held = {
      admission: lease ?? null,
      usage: reservation && reservation.state !== 'released',
      writer: claim.claim?.session === session && !spanHasHistory,
    };
    const review = {
      actionId: execution.actionId,
      attemptId: execution.attemptId,
      evidence: {
        action: 'absent',
        attempt: 'absent',
        dispatching: false,
        supervised: false,
      },
      generation: read.generation,
      releases: {
        admission: Boolean(lease),
        usage: Boolean(held.usage),
        writer: held.writer,
      },
      retains: {
        writer: claim.claim?.session === session && spanHasHistory,
      },
      runId,
      spanId: execution.spanId,
    };
    return {
      confirmation: `${RESOLVE_PREFIX}${digestOf({ bindingDigest: execution.bindingDigest, review })}`,
      held: { lease, ...held },
      review,
    };
  }

  // Releases what the reviewed resolve named, each through its own owner, and
  // says what happened to each. A release that fails stays held.
  async function releaseHeld({ actionId, built, execution, runId }) {
    const released = { admission: 'none', usage: 'none', writer: 'none' };
    if (built.held.usage) {
      const done = await usage.release({
        actionId,
        attemptId: execution.attemptId,
        runId,
        spanId: execution.spanId,
      });
      released.usage = done.ok ? 'released' : 'failed';
    }
    if (built.held.lease) {
      const done = await resources.admission.release(built.held.lease);
      released.admission = done?.ok ? 'released' : 'failed';
    }
    if (built.held.writer) {
      try {
        releaseWriter(
          execution.checkoutIdentity.checkoutPath,
          writerSession(execution)
        );
        released.writer = 'released';
      } catch {
        released.writer = 'failed';
      }
    }
    return released;
  }

  async function resolve(input) {
    const request = exactRequest(
      input,
      ['actionId', 'runId'],
      ['confirmation']
    );
    if (
      !(
        request &&
        isExplicitId(request.runId) &&
        isExplicitId(request.actionId) &&
        (request.confirmation === undefined ||
          typeof request.confirmation === 'string')
      )
    ) {
      return invalid();
    }
    if (!(await owner.acquire()).ok) {
      return fail('SPANS_EXEC_OWNED_ELSEWHERE');
    }
    const { actionId, runId } = request;
    const recorded = executionOf(runId, actionId);
    if (!recorded) {
      return fail('SPANS_EXEC_ACTION_NOT_FOUND');
    }
    const leave = enter(runId, recorded.spanId);
    if (!leave) {
      return fail('SPANS_EXEC_NOT_RESOLVABLE');
    }
    try {
      return await resolveHeld({
        actionId,
        confirmation: request.confirmation,
        runId,
      });
    } finally {
      leave();
    }
  }

  async function resolveHeld({ actionId, confirmation, runId }) {
    const target = unlaunchedTarget(runId, actionId);
    if (target.refusal) {
      return target.refusal;
    }
    const built = await resolveReview({ ...target, runId });
    if (confirmation === undefined) {
      return fail('SPANS_EXEC_CONFIRMATION_REQUIRED', {
        confirmation: built.confirmation,
        review: built.review,
      });
    }
    if (confirmation !== built.confirmation) {
      return fail('SPANS_EXEC_REVIEW_CHANGED', {
        confirmation: built.confirmation,
        review: built.review,
      });
    }
    const { execution } = target;
    const released = await releaseHeld({ actionId, built, execution, runId });
    const finished = !Object.values(released).includes('failed');
    // The authorization goes only once nothing it reserved is still held, so a
    // partial release can be resolved again.
    if (finished && !(await withdrawAuthorization(execution)).ok) {
      return fail('SPANS_EXEC_AUTHORIZATION_NOT_RECORDED');
    }
    return {
      actionId,
      ok: finished,
      ...(finished ? {} : { code: 'SPANS_EXEC_RELEASE_INCOMPLETE' }),
      released,
      resolved: finished,
      retained: built.review.retains,
      status: finished ? 'resolved' : 'held',
    };
  }

  // -------------------------------------------------------------------------
  // Status: a read of what is recorded and what is held. It starts nothing.
  // -------------------------------------------------------------------------

  function resourcesOf(execution, view, leases) {
    const reservation =
      view.usage?.reservations?.[
        usageReservationId(execution.runId, execution.actionId)
      ];
    const lease = leases.find(
      (candidate) => candidate.operationId === admissionOperationId(execution)
    );
    const session = writerSession(execution);
    const claim = writer.check({
      checkoutPath: execution.checkoutIdentity.checkoutPath,
      session,
    });
    let admissionState = 'released';
    if (lease) {
      admissionState = lease.ownership === 'uncertain' ? 'uncertain' : 'held';
    }
    return {
      admission: admissionState,
      usage: reservation?.state ?? 'none',
      writer: claim.claim?.session === session ? { session } : null,
    };
  }

  function acceptanceOf(execution, view) {
    const span = view.spans?.[execution.spanId];
    if (
      span?.state === 'completed' &&
      span.acceptedActionId === execution.actionId
    ) {
      return 'accepted';
    }
    const completion = view.completions?.[execution.actionId];
    return completion?.outcome === 'completed' &&
      completionIntact(completion) &&
      view.actions?.[execution.actionId]?.state === 'completed'
      ? 'pending'
      : 'none';
  }

  async function status(input) {
    const request = exactRequest(input, ['runId']);
    if (!(request && isExplicitId(request.runId))) {
      return invalid();
    }
    const read = store.readRun({ runId: request.runId });
    if (read?.ok !== true) {
      return fail('SPANS_EXEC_RUN_UNAVAILABLE');
    }
    const { view } = read;
    const held = await admission.status();
    const leases = held?.ok === false ? [] : (held.leases ?? []);
    const executions = [];
    for (const execution of Object.values(view.executions ?? {})) {
      const completion = view.completions?.[execution.actionId];
      executions.push({
        acceptance: acceptanceOf(execution, view),
        action: view.actions?.[execution.actionId]?.state ?? null,
        actionId: execution.actionId,
        attempt: view.attempts?.[execution.attemptId]?.status ?? null,
        attemptId: execution.attemptId,
        billing: execution.billing,
        completion: completion
          ? {
              artifactIds: completion.artifactIds,
              baseline: completion.baseline,
              change: completion.change,
              checks: completion.checks,
              costCheck: completion.costCheck,
              costMicro: completion.costMicro,
              criteria: completion.criteria,
              evidenceId: completion.evidenceId,
              independentValidation: completion.independentValidation,
              launchMode: completion.launchMode,
              outcome: completion.outcome,
              recordIntact: completionIntact(completion),
              reported: completion.reported,
              tree: completion.tree,
            }
          : null,
        launchMode: execution.launchMode,
        profile: execution.profile,
        resources: resourcesOf(execution, view, leases),
        spanId: execution.spanId,
      });
    }
    return {
      attempts: Object.values(view.attempts ?? {}),
      executions,
      generation: read.generation,
      ok: true,
    };
  }

  // -------------------------------------------------------------------------
  // Public operations
  // -------------------------------------------------------------------------

  async function dispatch(input) {
    const request = parseReview(input, { confirmation: true });
    if (!request) {
      return invalid();
    }
    if (!Object.hasOwn(profiles, request.profile)) {
      return fail('SPANS_EXEC_PROFILE_UNKNOWN');
    }
    if (request.confirmation === undefined) {
      return await dispatchReviewed(request);
    }
    // A confirmed dispatch has an effect, so only the supervisor may try it,
    // and only one dispatch or resolve of the span at a time.
    if (!(await owner.acquire()).ok) {
      return fail('SPANS_EXEC_OWNED_ELSEWHERE');
    }
    const leave = enter(request.runId, request.spanId);
    if (!leave) {
      return fail('SPANS_EXEC_SPAN_BUSY');
    }
    try {
      return await dispatchReviewed(request);
    } finally {
      leave();
    }
  }

  async function dispatchReviewed(request) {
    let built = await buildReview(request);
    if (built.refusal) {
      return built.refusal;
    }
    const { confirmation, review } = built;
    if (request.confirmation === undefined) {
      return fail('SPANS_EXEC_CONFIRMATION_REQUIRED', { confirmation, review });
    }
    if (request.confirmation !== confirmation) {
      return fail('SPANS_EXEC_REVIEW_CHANGED', { confirmation, review });
    }
    if (!request.reviewDigest) {
      return {
        code: 'SPANS_EXECUTION_REVIEW_UNAPPROVED',
        error: 'Prepare and approve this exact execution before dispatch.',
        ok: false,
      };
    }
    const approved = await reviewFlow.authorize({
      reviewDigest: request.reviewDigest,
      runId: request.runId,
    });
    if (!approved.ok) {
      return approved;
    }
    if (approved.built?.confirmation !== built.confirmation) {
      return fail('SPANS_EXEC_REVIEW_CHANGED');
    }
    ({ built } = approved);
    const { inputArtifact } = approved.review.binding;
    const { dispatchRequest } = built;
    dispatchRequest.inputDigest = inputDigestOf({
      baselineTree: built.baseline.digest,
      budgetMicro: built.budgetMicro,
      criteria: review.acceptance.criteria,
      inputArtifact,
      instructions: review.instructions,
      launchMode: built.launchMode,
      requireChange: review.acceptance.requireChange,
      wallClockMs: review.wallClockMs,
    });
    dispatchRequest.authorizationId = derivedId(
      'spans-auth',
      request.reviewDigest,
      dispatchRequest.inputDigest
    );
    const authorized = {
      actionId: review.actionId,
      approval: approved.approval,
      approvalDigest: digestOf(approved.approval),
      attemptId: review.attemptId,
      authorizationId: dispatchRequest.authorizationId,
      baseline: built.baseline,
      baselineTree: built.baseline.digest,
      billing: built.launchMode.billing,
      bindingDigest: digestOf(
        dispatchBinding(dispatchRequest, built.profileDigest)
      ),
      budgetMicro: built.budgetMicro,
      checkoutIdentity: built.observed.identity,
      createdAt: now(),
      criteria: review.acceptance.criteria,
      inputArtifact,
      inputDigest: dispatchRequest.inputDigest,
      instructions: review.instructions,
      launchMode: built.launchMode,
      profile: review.profile,
      requireChange: review.acceptance.requireChange,
      reviewRef: { reviewDigest: request.reviewDigest, runId: request.runId },
      reviewSelector: Object.fromEntries(
        [
          'actionId',
          'attemptId',
          'generation',
          'planVersion',
          'runId',
          'spanId',
        ].map((key) => [key, approved.review.binding[key]])
      ),
      runId: review.runId,
      spanId: review.spanId,
      target: review.target,
      wallClockMs: review.wallClockMs,
    };
    if (!(await recordAuthorization(authorized)).ok) {
      return fail('SPANS_EXEC_AUTHORIZATION_NOT_RECORDED');
    }
    const result = await resources.withExecution(authorized, () =>
      coordinator.dispatch(dispatchRequest)
    );
    if (!startedNothing(result)) {
      return result;
    }
    await withdrawAuthorization(authorized);
    // The dispatch contract keeps the writer claim after a refusal, so a retry
    // of the span reuses it. Say exactly what is held and how to let it go; the
    // claim is not released here.
    return result.resources?.writer === 'held'
      ? {
          ...result,
          recovery: {
            writer: {
              checkoutPath: built.observed.identity.checkoutPath,
              session: writerSession(dispatchRequest),
            },
          },
        }
      : result;
  }

  return Object.freeze({
    accept,
    approvalChallenge: (input) => reviewFlow.issue(input),
    approve: (input) => reviewFlow.approve(input),
    cancel,
    capabilities(input) {
      const request = profileRequest(input);
      if (!request) {
        return invalid();
      }
      const result = capability.capabilities(request.profile);
      return result.ok ? result : fail(result.code);
    },
    async close() {
      await worker.shutdown();
      await reviewFlow.close();
      writesClosed = true;
      await Promise.allSettled([...pendingWrites]);
      await owner.release();
      return { ok: true };
    },
    complete,
    dispatch,
    enforceDeadlines,
    // Resolves when every supervised process has been read to its end.
    idle: () => worker.idle(),
    prepare(input) {
      const request = parseReview(input);
      return request && Object.hasOwn(profiles, request.profile)
        ? reviewFlow.prepare(request)
        : Promise.resolve(invalid());
    },
    async probe(input) {
      const request = profileRequest(input);
      if (!request) {
        return invalid();
      }
      const result = await capability.probe(request.profile);
      return result.ok ? result : fail(result.code);
    },
    readReview: (input) => reviewFlow.read(input),
    reconcile,
    report,
    resolve,
    async review(input) {
      const request = parseReview(input);
      if (!request) {
        return invalid();
      }
      if (!Object.hasOwn(profiles, request.profile)) {
        return fail('SPANS_EXEC_PROFILE_UNKNOWN');
      }
      const built = await buildReview(request);
      return (
        built.refusal ?? {
          confirmation: built.confirmation,
          ok: true,
          review: built.review,
          status: 'review',
        }
      );
    },
    revoke: (input) => reviewFlow.revoke(input),
    status,
    usage(input) {
      const request = exactRequest(input, ['runId']);
      if (!(request && isExplicitId(request.runId))) {
        return invalid();
      }
      return usage.read(request.runId);
    },
  });
}
