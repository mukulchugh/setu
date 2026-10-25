import { createHash } from 'node:crypto';
import {
  isSpansRedactionSafeKey,
  redactSpansValue as redactValue,
} from './spans-redaction.js';
import {
  evaluateDependencyReadiness,
  validateCoordinatorGeneration,
} from './spans-transitions.js';

const MAX_ID_LENGTH = 256;
const DIGEST_PATTERN = /^(?:sha256:)?[0-9a-f]{64}$/;
const DIGEST_PREFIX = 'sha256:';
const OBSERVED_OUTCOMES = new Set(['completed', 'failed', 'unknown']);
// spans-model-store.js answers with the SPANS_MODEL_STALE_* codes. The
// *_CONFLICT spellings are accepted as aliases of the same two conditions.
const STALE_REVISION_CODES = new Set([
  'SPANS_MODEL_REVISION_CONFLICT',
  'SPANS_MODEL_STALE_REVISION',
]);
const STALE_GENERATION_CODES = new Set([
  'SPANS_MODEL_GENERATION_CONFLICT',
  'SPANS_MODEL_STALE_GENERATION',
]);

const EVENT_TYPES = Object.freeze({
  accepted: 'spans.completion.accepted',
  historical: 'spans.action.outcome.historical',
  intent: 'spans.action.intent',
  outcome: 'spans.action.outcome',
});

// Fixed text only. Store, verifier and request strings are never reflected.
const REFUSALS = {
  ACCEPTANCE_CONFLICT: 'The span was already accepted from a different action.',
  ACTION_CONFLICT: 'The action ID is already bound to different input.',
  ACTION_NOT_COMPLETED:
    'Only an action with a completed outcome can be accepted.',
  ACTION_NOT_FOUND: 'The action does not exist in this run.',
  ACTION_SPAN_MISMATCH: 'The action belongs to a different span.',
  ARTIFACT_IDS_INVALID: 'artifactIds must be a list of unique explicit IDs.',
  CLOCK_INVALID: 'The clock did not return a nonnegative safe integer.',
  COMMIT_FAILED: 'The run update was not confirmed; reread before retrying.',
  DEPENDENCIES_INCOMPLETE: 'Every dependency must be accepted complete first.',
  DIGEST_INVALID: 'inputDigest must be a SHA-256 hex digest.',
  EVIDENCE_NOT_VERIFIED: 'The evidence was not verified.',
  EVIDENCE_REQUIRED: 'Completion evidence must be an object.',
  GENERATION_INVALID:
    'Coordinator generations must be nonnegative safe integers.',
  ID_INVALID: 'IDs must be explicit non-empty strings.',
  OUTCOME_CONFLICT: 'The reported outcome contradicts the recorded outcome.',
  OUTCOME_INVALID: 'outcome must be completed, failed, or unknown.',
  PLAN_CHANGED: 'The plan version is not the current plan version.',
  PLAN_VERSION_INVALID: 'planVersion must be an integer or explicit string.',
  RUN_READ_FAILED: 'The run could not be read.',
  RUN_READ_ONLY: 'Imported history cannot execute or accept actions.',
  RUN_VIEW_INVALID: 'The run view does not use the expected format.',
  SENSITIVE_VALUE: 'A value that looks like a secret was not stored.',
  SPAN_ACTION_OPEN: 'Another action on this span is not finished.',
  SPAN_COMPLETED: 'The span is already complete.',
  SPAN_NOT_FOUND: 'The span does not exist in this run.',
  STALE_GENERATION: 'The coordinator generation is stale.',
  STALE_REVISION: 'The run changed; reread and retry explicitly.',
  TARGET_DIGEST_INVALID: 'targetDigest must be a SHA-256 hex digest.',
};

const isRecord = (value) =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

function refuse(code, extra = {}) {
  return { code, error: REFUSALS[code], ok: false, ...extra };
}

const holdsSecret = (value) =>
  typeof value === 'string' && redactValue(value) !== value;

// ---------------------------------------------------------------------------
// Request parsing
// ---------------------------------------------------------------------------

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

const isGeneration = (value) => Number.isSafeInteger(value) && value >= 0;

const isPlanVersion = (value) =>
  (Number.isSafeInteger(value) && value >= 0) || isExplicitId(value);

const isDigest = (value) =>
  typeof value === 'string' && DIGEST_PATTERN.test(value);

// The optional sha256: spelling and the bare hex are the same digest.
const bareDigest = (value) =>
  value.startsWith(DIGEST_PREFIX) ? value.slice(DIGEST_PREFIX.length) : value;

function ownEntry(table, key) {
  return Object.hasOwn(table, key) && isRecord(table[key]) ? table[key] : null;
}

function sameIdSet(left, right) {
  if (!(Array.isArray(left) && left.length === right.length)) {
    return false;
  }
  const sortedLeft = [...left].sort();
  const sortedRight = [...right].sort();
  return sortedLeft.every((id, index) => id === sortedRight[index]);
}

function parseArtifactIds(value) {
  const ids = value === undefined ? [] : value;
  if (
    !(Array.isArray(ids) && ids.every(isExplicitId)) ||
    new Set(ids).size !== ids.length
  ) {
    return refuse('ARTIFACT_IDS_INVALID');
  }
  if (ids.some(holdsSecret)) {
    return refuse('SENSITIVE_VALUE');
  }
  return { ids: [...ids], ok: true };
}

function parseIds(input, names) {
  if (!isRecord(input)) {
    return refuse('ID_INVALID');
  }
  for (const name of names) {
    if (!isExplicitId(input[name])) {
      return refuse('ID_INVALID');
    }
  }
  if (
    names.some(
      (name) =>
        (name === 'actionId' || name === 'spanId') &&
        !isSpansRedactionSafeKey(input[name])
    )
  ) {
    return refuse('SENSITIVE_VALUE');
  }
  if (!isGeneration(input.generation)) {
    return refuse('GENERATION_INVALID');
  }
  if (names.some((name) => holdsSecret(input[name]))) {
    return refuse('SENSITIVE_VALUE');
  }
  return null;
}

function parsePrepare(input) {
  const refusal = parseIds(input, ['runId', 'spanId', 'actionId', 'attemptId']);
  if (refusal) {
    return refusal;
  }
  if (!isDigest(input.inputDigest)) {
    return refuse('DIGEST_INVALID');
  }
  if (!isDigest(input.targetDigest)) {
    return refuse('TARGET_DIGEST_INVALID');
  }
  if (!isPlanVersion(input.planVersion)) {
    return refuse('PLAN_VERSION_INVALID');
  }
  if (holdsSecret(input.planVersion)) {
    return refuse('SENSITIVE_VALUE');
  }
  return {
    actionId: input.actionId,
    attemptId: input.attemptId,
    generation: input.generation,
    inputDigest: bareDigest(input.inputDigest),
    ok: true,
    planVersion: input.planVersion,
    runId: input.runId,
    spanId: input.spanId,
    targetDigest: bareDigest(input.targetDigest),
  };
}

function parseOutcome(input) {
  const refusal = parseIds(input, ['runId', 'actionId']);
  if (refusal) {
    return refusal;
  }
  if (!OBSERVED_OUTCOMES.has(input.outcome)) {
    return refuse('OUTCOME_INVALID');
  }
  const artifacts = parseArtifactIds(input.artifactIds);
  if (!artifacts.ok) {
    return artifacts;
  }
  return {
    actionId: input.actionId,
    artifactIds: artifacts.ids,
    evidence: input.evidence ?? null,
    generation: input.generation,
    ok: true,
    outcome: input.outcome,
    runId: input.runId,
  };
}

function parseAcceptance(input) {
  const refusal = parseIds(input, ['runId', 'spanId', 'actionId']);
  if (refusal) {
    return refusal;
  }
  if (!isRecord(input.evidence)) {
    return refuse('EVIDENCE_REQUIRED');
  }
  return {
    actionId: input.actionId,
    evidence: input.evidence,
    generation: input.generation,
    ok: true,
    runId: input.runId,
    spanId: input.spanId,
  };
}

// ---------------------------------------------------------------------------
// Store access. The store contract is exact: commitRun takes {events,
// expectedGeneration, expectedRevision, runId, view} and appendEvent takes one
// {eventId, payload, runId, type} envelope.
// ---------------------------------------------------------------------------

function validView(view, runId, read) {
  return (
    isRecord(view) &&
    view.runId === runId &&
    view.generation === read.generation &&
    Number.isSafeInteger(read.revision) &&
    isRecord(view.spans) &&
    isRecord(view.actions) &&
    Number.isSafeInteger(view.checkpoint) &&
    view.checkpoint >= 0
  );
}

// The store's read object is never mutated; callers work on a clone.
async function loadRun(store, runId) {
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
    view?.readOnly === true ||
    view?.kind === 'imported' ||
    view?.state === 'imported'
  ) {
    return refuse('RUN_READ_ONLY');
  }
  if (!validView(view, runId, read)) {
    return refuse('RUN_VIEW_INVALID');
  }
  return {
    generation: read.generation,
    ok: true,
    revision: read.revision,
    view,
  };
}

function fence(requested, loaded) {
  return validateCoordinatorGeneration({
    currentGeneration: loaded.generation,
    expectedGeneration: requested,
  });
}

// The event ID is a hash of the structured identity, runId included, so it is
// valid for the store, never embeds caller text, and cannot collide between
// runs that reuse an action ID. Payload strings are redacted here.
function buildEvent(type, runId, identity, payload) {
  const digest = createHash('sha256')
    .update(JSON.stringify([type, runId, ...identity]))
    .digest('hex');
  return {
    eventId: `${type}:${digest}`,
    payload: redactValue(payload),
    runId,
    type,
  };
}

async function commitRun(store, runId, loaded, view, events) {
  let result;
  try {
    result = await store.commitRun({
      events,
      expectedGeneration: loaded.generation,
      expectedRevision: loaded.revision,
      runId,
      view: redactValue(view),
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

// A positive receipt is only what the root-provided callback returns for the
// exact references; any request field such as verified:true is ignored.
async function verifyReceipt(verifyEvidence, references) {
  let receipt;
  try {
    receipt = await verifyEvidence(structuredClone(references));
  } catch {
    return refuse('EVIDENCE_NOT_VERIFIED');
  }
  if (
    isRecord(receipt) &&
    receipt.ok === true &&
    receipt.verified === true &&
    isExplicitId(receipt.evidenceId) &&
    !holdsSecret(receipt.evidenceId)
  ) {
    return { evidenceId: receipt.evidenceId, ok: true };
  }
  return refuse('EVIDENCE_NOT_VERIFIED');
}

function acceptedSpanIds(view) {
  return Object.entries(view.spans)
    .filter(([, span]) => isRecord(span) && span.state === 'completed')
    .map(([spanId]) => ({ spanId, verified: true }));
}

function checkDependencies(view, span) {
  const readiness = evaluateDependencyReadiness({
    acceptedCompletions: acceptedSpanIds(view),
    dependencies: span.dependencies,
  });
  if (!readiness.ok) {
    return readiness;
  }
  if (!readiness.ready) {
    return refuse('DEPENDENCIES_INCOMPLETE', {
      waitingFor: readiness.waitingFor,
    });
  }
  return { ok: true };
}

function promoteReadyDependents(view, completedSpanId) {
  const readySpanIds = [];
  for (const [spanId, span] of Object.entries(view.spans)) {
    if (
      !(
        isRecord(span) &&
        span.state === 'planned' &&
        Array.isArray(span.dependencies) &&
        span.dependencies.includes(completedSpanId)
      )
    ) {
      continue;
    }
    const readiness = checkDependencies(view, span);
    if (readiness.ok) {
      span.state = 'ready';
      readySpanIds.push(spanId);
    }
  }
  return readySpanIds.sort();
}

function existingActionResult(action) {
  const result = {
    actionId: action.actionId,
    created: false,
    ok: true,
    status: action.state,
  };
  // Unknown keeps ownership of the effect; it is never a fresh intent.
  return action.state === 'unknown'
    ? { ...result, retryAllowed: false }
    : result;
}

function boundFieldsMatch(action, request) {
  return (
    action.spanId === request.spanId &&
    action.inputDigest === request.inputDigest &&
    action.targetDigest === request.targetDigest &&
    action.planVersion === request.planVersion &&
    action.attemptId === request.attemptId
  );
}

function hasOpenAction(view, spanId) {
  return Object.values(view.actions).some(
    (action) =>
      isRecord(action) && action.spanId === spanId && action.state !== 'failed'
  );
}

// Null means the prepare request may create a fresh intent.
function prepareRefusal(view, request) {
  if (view.planVersion !== request.planVersion) {
    return refuse('PLAN_CHANGED');
  }

  if (Object.hasOwn(view.actions, request.actionId)) {
    const action = ownEntry(view.actions, request.actionId);
    if (!(action && boundFieldsMatch(action, request))) {
      return refuse('ACTION_CONFLICT');
    }
    return existingActionResult(action);
  }

  const span = ownEntry(view.spans, request.spanId);
  if (!span) {
    return refuse('SPAN_NOT_FOUND');
  }
  if (span.state === 'completed') {
    return refuse('SPAN_COMPLETED');
  }
  const dependencies = checkDependencies(view, span);
  if (!dependencies.ok) {
    return dependencies;
  }
  if (hasOpenAction(view, request.spanId)) {
    return refuse('SPAN_ACTION_OPEN');
  }
  return null;
}

function intentEvent(request, generation, at) {
  return buildEvent(
    EVENT_TYPES.intent,
    request.runId,
    [
      request.actionId,
      request.spanId,
      request.attemptId,
      request.planVersion,
      request.inputDigest,
      request.targetDigest,
    ],
    {
      actionId: request.actionId,
      at,
      attemptId: request.attemptId,
      generation,
      inputDigest: request.inputDigest,
      planVersion: request.planVersion,
      spanId: request.spanId,
      targetDigest: request.targetDigest,
    }
  );
}

// `done` holds a terminal result; otherwise the outcome is a fresh transition
// and `resolvesUnknown` marks one that needs verified evidence.
function outcomeTransition(action, request) {
  const previousState = action.state;
  if (previousState === request.outcome) {
    return {
      done: sameIdSet(action.outcomeArtifactIds, request.artifactIds)
        ? existingActionResult(action)
        : refuse('OUTCOME_CONFLICT'),
    };
  }
  const resolvesUnknown =
    previousState === 'unknown' && request.outcome !== 'unknown';
  if (previousState !== 'intent' && !resolvesUnknown) {
    return { done: refuse('OUTCOME_CONFLICT') };
  }
  return { done: null, resolvesUnknown };
}

function resolveUnknownReferences(action, request, generation) {
  return {
    actionId: action.actionId,
    attemptId: action.attemptId,
    evidence: request.evidence,
    generation,
    inputDigest: action.inputDigest,
    outcome: request.outcome,
    outcomeArtifactIds: request.artifactIds,
    planVersion: action.planVersion,
    purpose: 'resolve-unknown',
    runId: request.runId,
    spanId: action.spanId,
    targetDigest: action.targetDigest,
  };
}

function outcomeEvent({
  action,
  at,
  evidenceId,
  generation,
  previousState,
  request,
}) {
  return buildEvent(
    EVENT_TYPES.outcome,
    request.runId,
    [action.actionId, request.outcome],
    {
      actionId: action.actionId,
      artifactIds: request.artifactIds,
      at,
      attemptId: action.attemptId,
      generation,
      outcome: request.outcome,
      previousState,
      spanId: action.spanId,
      ...(evidenceId ? { resolvedEvidenceId: evidenceId } : {}),
    }
  );
}

function duplicateAcceptance(span, request) {
  if (span.acceptedActionId !== request.actionId) {
    return refuse('ACCEPTANCE_CONFLICT');
  }
  return {
    actionId: request.actionId,
    checkpoint: span.acceptedCheckpoint,
    duplicate: true,
    evidenceId: span.acceptedEvidenceId,
    ok: true,
    spanId: request.spanId,
  };
}

// `done` holds a terminal result; otherwise `span` and `action` are the
// committed entries the acceptance may proceed against.
function acceptanceTarget(view, request) {
  const span = ownEntry(view.spans, request.spanId);
  if (!span) {
    return { done: refuse('SPAN_NOT_FOUND') };
  }
  const action = ownEntry(view.actions, request.actionId);
  if (!action) {
    return { done: refuse('ACTION_NOT_FOUND') };
  }
  if (action.spanId !== request.spanId) {
    return { done: refuse('ACTION_SPAN_MISMATCH') };
  }

  if (span.state === 'completed') {
    return { done: duplicateAcceptance(span, request) };
  }
  if (action.state !== 'completed') {
    return { done: refuse('ACTION_NOT_COMPLETED') };
  }
  if (view.planVersion !== action.planVersion) {
    return { done: refuse('PLAN_CHANGED') };
  }
  const dependencies = checkDependencies(view, span);
  if (!dependencies.ok) {
    return { done: dependencies };
  }
  return { action, done: null, span };
}

export function createSpansActions({
  store,
  verifyEvidence = async () => ({ ok: false, verified: false }),
  now = Date.now,
} = {}) {
  if (
    !(
      isRecord(store) &&
      typeof store.readRun === 'function' &&
      typeof store.commitRun === 'function'
    )
  ) {
    throw new TypeError('store must provide readRun and commitRun.');
  }
  if (typeof verifyEvidence !== 'function' || typeof now !== 'function') {
    throw new TypeError('verifyEvidence and now must be functions.');
  }

  // Null when the clock is unusable; callers refuse before mutating anything.
  function stamp() {
    try {
      const at = now();
      return Number.isSafeInteger(at) && at >= 0 ? at : null;
    } catch {
      return null;
    }
  }

  async function prepareAction(input) {
    const request = parsePrepare(input);
    if (!request.ok) {
      return request;
    }
    const loaded = await loadRun(store, request.runId);
    if (!loaded.ok) {
      return loaded;
    }
    const generation = fence(request.generation, loaded);
    if (!generation.ok) {
      return generation;
    }
    const { view } = loaded;
    const early = prepareRefusal(view, request);
    if (early) {
      return early;
    }
    const at = stamp();
    if (at === null) {
      return refuse('CLOCK_INVALID');
    }

    view.actions[request.actionId] = {
      actionId: request.actionId,
      attemptId: request.attemptId,
      inputDigest: request.inputDigest,
      outcomeArtifactIds: [],
      planVersion: request.planVersion,
      spanId: request.spanId,
      state: 'intent',
      targetDigest: request.targetDigest,
    };
    const event = intentEvent(request, loaded.generation, at);
    const committed = await commitRun(store, request.runId, loaded, view, [
      event,
    ]);
    if (!committed.ok) {
      return committed;
    }
    return {
      actionId: request.actionId,
      created: true,
      ok: true,
      status: 'intent',
    };
  }

  // The history record is immutable: identity and payload hold only what the
  // late reporter said plus the action's span, never the clock or the current
  // generation. A retry therefore rebuilds the identical event and the store
  // treats it as a no-op duplicate. Only a strictly older generation is
  // history; a newer one is simply refused.
  async function appendHistorical(request, loaded) {
    const stale = refuse('STALE_GENERATION', { historical: false });
    const action = ownEntry(loaded.view.actions, request.actionId);
    if (
      !(
        action &&
        request.generation < loaded.generation &&
        typeof store.appendEvent === 'function'
      )
    ) {
      return stale;
    }
    const artifactIds = [...request.artifactIds].sort();
    const event = buildEvent(
      EVENT_TYPES.historical,
      request.runId,
      [request.actionId, request.generation, request.outcome, artifactIds],
      {
        actionId: request.actionId,
        artifactIds,
        historical: true,
        outcome: request.outcome,
        reportedGeneration: request.generation,
        spanId: action.spanId,
      }
    );
    try {
      const result = await store.appendEvent(event);
      return { ...stale, historical: isRecord(result) && result.ok === true };
    } catch {
      return stale;
    }
  }

  function verifyOutcomeResolution(transition, action, request, generation) {
    if (!transition.resolvesUnknown) {
      return Promise.resolve({ evidenceId: undefined, ok: true });
    }
    return verifyReceipt(
      verifyEvidence,
      resolveUnknownReferences(action, request, generation)
    );
  }

  async function recordOutcome(input) {
    const request = parseOutcome(input);
    if (!request.ok) {
      return request;
    }
    const loaded = await loadRun(store, request.runId);
    if (!loaded.ok) {
      return loaded;
    }
    const generation = fence(request.generation, loaded);
    if (!generation.ok) {
      return generation.code === 'STALE_GENERATION'
        ? appendHistorical(request, loaded)
        : generation;
    }
    const { view } = loaded;
    const action = ownEntry(view.actions, request.actionId);
    if (!action) {
      return refuse('ACTION_NOT_FOUND');
    }

    const transition = outcomeTransition(action, request);
    if (transition.done) {
      return transition.done;
    }

    const receipt = await verifyOutcomeResolution(
      transition,
      action,
      request,
      loaded.generation
    );
    if (!receipt.ok) {
      return receipt;
    }
    const { evidenceId } = receipt;
    const at = stamp();
    if (at === null) {
      return refuse('CLOCK_INVALID');
    }

    const previousState = action.state;
    action.state = request.outcome;
    action.outcomeArtifactIds = [...request.artifactIds];
    const event = outcomeEvent({
      action,
      at,
      evidenceId,
      generation: loaded.generation,
      previousState,
      request,
    });
    const committed = await commitRun(store, request.runId, loaded, view, [
      event,
    ]);
    if (!committed.ok) {
      return committed;
    }
    // A reported completed outcome is an observation, not span acceptance.
    return {
      accepted: false,
      actionId: action.actionId,
      created: true,
      ok: true,
      status: request.outcome,
    };
  }

  async function acceptCompletion(input) {
    const request = parseAcceptance(input);
    if (!request.ok) {
      return request;
    }
    const loaded = await loadRun(store, request.runId);
    if (!loaded.ok) {
      return loaded;
    }
    const generation = fence(request.generation, loaded);
    if (!generation.ok) {
      return generation;
    }
    const { view } = loaded;
    const target = acceptanceTarget(view, request);
    if (target.done) {
      return target.done;
    }
    const { action, span } = target;

    // References come from the committed view, never from the request.
    const receipt = await verifyReceipt(verifyEvidence, {
      actionId: action.actionId,
      attemptId: action.attemptId,
      evidence: request.evidence,
      generation: loaded.generation,
      inputDigest: action.inputDigest,
      outcomeArtifactIds: action.outcomeArtifactIds,
      planVersion: action.planVersion,
      purpose: 'accept-completion',
      runId: request.runId,
      spanId: request.spanId,
      targetDigest: action.targetDigest,
      tree: request.evidence.tree ?? null,
    });
    if (!receipt.ok) {
      return receipt;
    }
    const at = stamp();
    if (at === null) {
      return refuse('CLOCK_INVALID');
    }

    const checkpoint = view.checkpoint + 1;
    span.state = 'completed';
    span.acceptedActionId = request.actionId;
    span.acceptedCheckpoint = checkpoint;
    span.acceptedEvidenceId = receipt.evidenceId;
    view.checkpoint = checkpoint;
    const readySpanIds = promoteReadyDependents(view, request.spanId);
    const event = buildEvent(
      EVENT_TYPES.accepted,
      request.runId,
      [request.spanId, request.actionId],
      {
        actionId: request.actionId,
        at,
        checkpoint,
        evidenceId: receipt.evidenceId,
        generation: loaded.generation,
        readySpanIds,
        spanId: request.spanId,
      }
    );
    const committed = await commitRun(store, request.runId, loaded, view, [
      event,
    ]);
    if (!committed.ok) {
      return committed;
    }
    return {
      actionId: request.actionId,
      checkpoint,
      duplicate: false,
      evidenceId: receipt.evidenceId,
      ok: true,
      readySpanIds,
      spanId: request.spanId,
    };
  }

  return { acceptCompletion, prepareAction, recordOutcome };
}
