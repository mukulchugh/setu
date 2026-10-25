import { types } from 'node:util';
import { hashArtifact } from './spans-artifacts.js';
import { parseSpansDependencyBinding } from './spans-dependency-binding.js';
import { targetDigestFor } from './spans-dispatch.js';
import {
  canonicalJson,
  digestOf,
  holdsSecret,
  isExplicitId,
  sha256,
  toMicro,
} from './spans-execution-core.js';
import {
  buildSpansExecutionInput,
  SPANS_EXECUTION_INPUT_MAX_BYTES,
  SPANS_EXECUTION_INPUT_MEDIA_TYPE,
  SPANS_EXECUTION_INPUT_VERSION,
} from './spans-execution-input.js';
import {
  SPANS_EXECUTION_REVIEW_PROFILES,
  SPANS_EXECUTION_REVIEW_VERSION,
} from './spans-execution-review.js';
import { redactSpansValue } from './spans-redaction.js';

const DIGEST_PATTERN = /^[a-f0-9]{64}$/;
const HEAD_PATTERN = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const TARGET_PART = /^[^/\\\s:]+$/;
const MAX_INSTRUCTIONS = 8000;
const MAX_CRITERIA = 10;
const MAX_CRITERION_CHARS = 300;
const MAX_WALL_CLOCK_MS = 60 * 60 * 1000;
const MIN_WALL_CLOCK_MS = 1000;
const MAX_BUDGET_USD = 2;
const MAX_JSON_NODES = 4096;
const MAX_JSON_DEPTH = 40;
const MAX_JSON_BYTES = SPANS_EXECUTION_INPUT_MAX_BYTES * 16;
const ARCHIVE_BUDGET_BYTES = 5 * 1024 ** 3;
const ARCHIVE_BUDGET_VERSION = 1;
const MAX_WORKERS = 2;

const ERRORS = Object.freeze({
  SPANS_EXECUTION_BINDING_INVALID:
    'The trusted execution review could not be bound.',
  SPANS_EXECUTION_ENVELOPE_INVALID: 'The retained execution input is invalid.',
  SPANS_EXECUTION_ENVELOPE_TOO_LARGE:
    'The retained execution input exceeds its 65,536-byte limit.',
  SPANS_EXECUTION_REQUEST_INVALID: 'The retained execution request is invalid.',
});

const refusal = (code) => ({ code, error: ERRORS[code], ok: false });
const own = (value, key) => Object.hasOwn(value, key);
const isRecord = (value) =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

function plainRecord(value) {
  return (
    isRecord(value) &&
    !types.isProxy(value) &&
    (Object.getPrototypeOf(value) === Object.prototype ||
      Object.getPrototypeOf(value) === null)
  );
}

function dataValue(value, key) {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (!(descriptor?.enumerable && own(descriptor, 'value'))) {
    throw new TypeError('invalid-data-property');
  }
  return descriptor.value;
}

function exactData(value, required, optional = []) {
  if (!plainRecord(value)) {
    return null;
  }
  const keys = Reflect.ownKeys(value);
  const allowed = new Set([...required, ...optional]);
  if (
    keys.some((key) => typeof key !== 'string' || !allowed.has(key)) ||
    required.some((key) => !own(value, key))
  ) {
    return null;
  }
  const result = {};
  for (const key of keys) {
    result[key] = dataValue(value, key);
  }
  return result;
}

function copyJsonArray(value, state, ancestors, depth) {
  if (Object.getPrototypeOf(value) !== Array.prototype) {
    throw new TypeError('invalid-array');
  }
  const keys = Reflect.ownKeys(value);
  const length = Object.getOwnPropertyDescriptor(value, 'length')?.value;
  if (
    !Number.isSafeInteger(length) ||
    length < 0 ||
    length > MAX_JSON_NODES ||
    keys.length !== length + 1
  ) {
    throw new TypeError('invalid-array');
  }
  const result = [];
  for (let index = 0; index < length; index += 1) {
    result.push(
      copyJsonValue(
        dataValue(value, String(index)),
        state,
        ancestors,
        depth + 1
      )
    );
  }
  return result;
}

function copyJsonRecord(value, state, ancestors, depth) {
  if (!plainRecord(value)) {
    throw new TypeError('invalid-json-data');
  }
  const keys = Reflect.ownKeys(value);
  if (keys.length > 256) {
    throw new TypeError('invalid-bounds');
  }
  const result = {};
  for (const key of keys) {
    if (typeof key !== 'string') {
      throw new TypeError('invalid-json-data');
    }
    state.bytes += Buffer.byteLength(key, 'utf8');
    if (state.bytes > MAX_JSON_BYTES) {
      throw new TypeError('invalid-bounds');
    }
    Object.defineProperty(result, key, {
      configurable: true,
      enumerable: true,
      value: copyJsonValue(dataValue(value, key), state, ancestors, depth + 1),
      writable: true,
    });
  }
  return result;
}

function copyJsonValue(item, state, ancestors, depth) {
  state.nodes += 1;
  if (state.nodes > MAX_JSON_NODES || depth > MAX_JSON_DEPTH) {
    throw new TypeError('invalid-bounds');
  }
  if (item === null || typeof item === 'boolean') {
    return item;
  }
  if (typeof item === 'string') {
    state.bytes += Buffer.byteLength(item, 'utf8');
    if (state.bytes > MAX_JSON_BYTES) {
      throw new TypeError('invalid-bounds');
    }
    return item;
  }
  if (typeof item === 'number' && Number.isFinite(item)) {
    return item;
  }
  if (typeof item !== 'object' || types.isProxy(item) || ancestors.has(item)) {
    throw new TypeError('invalid-json-data');
  }
  ancestors.add(item);
  try {
    return Array.isArray(item)
      ? copyJsonArray(item, state, ancestors, depth)
      : copyJsonRecord(item, state, ancestors, depth);
  } finally {
    ancestors.delete(item);
  }
}

function copyJson(value) {
  return copyJsonValue(value, { bytes: 0, nodes: 0 }, new Set(), 0);
}

function rootArgs(value, keys) {
  if (!plainRecord(value)) {
    return null;
  }
  return exactData(value, keys);
}

function validDigest(value) {
  return typeof value === 'string' && DIGEST_PATTERN.test(value);
}

function validTarget(value) {
  const target = exactData(value, ['name', 'repo']);
  if (
    !target ||
    typeof target.repo !== 'string' ||
    !TARGET_PART.test(target.repo)
  ) {
    return null;
  }
  if (
    typeof target.name !== 'string' ||
    !target.name
      .split('/')
      .every(
        (part) =>
          TARGET_PART.test(part) &&
          part !== '.' &&
          part !== '..' &&
          !part.startsWith('-')
      ) ||
    target.repo === '.' ||
    target.repo === '..' ||
    target.repo.startsWith('-')
  ) {
    return null;
  }
  return { name: target.name, repo: target.repo };
}

function profilePolicy(profileId) {
  if (
    typeof profileId !== 'string' ||
    !own(SPANS_EXECUTION_REVIEW_PROFILES, profileId)
  ) {
    return null;
  }
  const profile = SPANS_EXECUTION_REVIEW_PROFILES[profileId];
  return plainRecord(profile) && plainRecord(profile.policy) ? profile : null;
}

function validCriteria(value) {
  if (!Array.isArray(value) || types.isProxy(value)) {
    return null;
  }
  let copy;
  try {
    copy = copyJson(value);
  } catch {
    return null;
  }
  return copy.length <= MAX_CRITERIA &&
    copy.every(
      (item) =>
        typeof item === 'string' &&
        item.trim().length > 0 &&
        item.length <= MAX_CRITERION_CHARS &&
        !item.includes('\0') &&
        !holdsSecret(item)
    )
    ? copy
    : null;
}

function normalizedRequest(raw, { requireNormalized = false } = {}) {
  const request = exactData(
    raw,
    [
      'instructions',
      'profile',
      'runId',
      'spanId',
      'target',
      'wallClockMs',
      ...(requireNormalized ? ['criteria', 'requireChange'] : []),
    ],
    [...(requireNormalized ? [] : ['criteria', 'requireChange']), 'budgetUsd']
  );
  if (!request) {
    return null;
  }
  const target = validTarget(request.target);
  const profile = profilePolicy(request.profile);
  if (!(target && profile)) {
    return null;
  }
  if (
    !(isExplicitId(request.runId) && isExplicitId(request.spanId)) ||
    typeof request.instructions !== 'string' ||
    request.instructions.trim().length === 0 ||
    request.instructions.length > MAX_INSTRUCTIONS ||
    request.instructions.includes('\0') ||
    holdsSecret(request.instructions) ||
    !Number.isSafeInteger(request.wallClockMs) ||
    request.wallClockMs < MIN_WALL_CLOCK_MS ||
    request.wallClockMs > MAX_WALL_CLOCK_MS ||
    request.wallClockMs > profile.policy.attemptTimeoutMs
  ) {
    return null;
  }
  const criteria = validCriteria(request.criteria ?? []);
  if (
    !criteria ||
    (requireNormalized && !Array.isArray(request.criteria)) ||
    (request.requireChange !== undefined &&
      typeof request.requireChange !== 'boolean')
  ) {
    return null;
  }
  const requireChange = request.requireChange === true;
  const result = {
    criteria,
    instructions: request.instructions,
    profile: request.profile,
    requireChange,
    runId: request.runId,
    spanId: request.spanId,
    target,
    wallClockMs: request.wallClockMs,
  };
  if (own(request, 'budgetUsd')) {
    const budget = request.budgetUsd;
    if (
      profile.policy.subscriptionOnly !== false ||
      typeof budget !== 'number' ||
      !Number.isFinite(budget) ||
      budget <= 0 ||
      budget > MAX_BUDGET_USD ||
      toMicro(budget) / 1_000_000 !== budget
    ) {
      return null;
    }
    result.budgetUsd = budget;
  } else if (profile.policy.subscriptionOnly !== true) {
    return null;
  }
  return result;
}

function validContext(context, request) {
  const record = exactData(context, [
    'dependencyEvidence',
    'goal',
    'plan',
    'runId',
    'span',
    'version',
  ]);
  if (
    !record ||
    record.version !== SPANS_EXECUTION_INPUT_VERSION ||
    record.runId !== request.runId ||
    typeof record.goal !== 'string' ||
    !Array.isArray(record.dependencyEvidence) ||
    !plainRecord(record.plan)
  ) {
    return false;
  }
  const span = exactData(
    record.span,
    ['dependencies', 'spanId', 'title'],
    ['acceptance', 'acceptanceCriteria', 'instructions', 'owner', 'ownership']
  );
  if (
    !span ||
    span.spanId !== request.spanId ||
    typeof span.title !== 'string' ||
    !Array.isArray(span.dependencies) ||
    span.dependencies.some((id) => !isExplicitId(id)) ||
    new Set(span.dependencies).size !== span.dependencies.length ||
    record.dependencyEvidence.length !== span.dependencies.length ||
    !record.dependencyEvidence.every((entry, index) => {
      const evidence = exactData(
        entry,
        ['spanId', 'state', 'title'],
        [
          'acceptedActionId',
          'acceptedCheckpoint',
          'acceptedEvidenceId',
          'artifactIds',
        ]
      );
      const acceptanceFields = [
        'acceptedActionId',
        'acceptedCheckpoint',
        'acceptedEvidenceId',
      ];
      const acceptedCount = acceptanceFields.filter((key) =>
        own(evidence ?? {}, key)
      ).length;
      const acceptedValid =
        acceptedCount === 0 ||
        (acceptedCount === acceptanceFields.length &&
          isExplicitId(evidence.acceptedActionId) &&
          Number.isSafeInteger(evidence.acceptedCheckpoint) &&
          evidence.acceptedCheckpoint >= 1 &&
          isExplicitId(evidence.acceptedEvidenceId));
      const artifactsValid =
        evidence?.artifactIds === undefined ||
        (Array.isArray(evidence.artifactIds) &&
          evidence.artifactIds.every(isExplicitId));
      return Boolean(
        evidence &&
          evidence.spanId === span.dependencies[index] &&
          typeof evidence.state === 'string' &&
          typeof evidence.title === 'string' &&
          acceptedValid &&
          artifactsValid &&
          (evidence.state === 'completed'
            ? acceptedCount === 3
            : acceptedCount === 0)
      );
    })
  ) {
    return false;
  }
  const plan = exactData(record.plan, [], ['owner', 'project', 'worktree']);
  if (!plan) {
    return false;
  }
  try {
    return canonicalJson(redactSpansValue(record)) === canonicalJson(record);
  } catch {
    return false;
  }
}

function reviewedRequestOf(built) {
  if (!plainRecord(built)) {
    return null;
  }
  const refusalValue = own(built, 'refusal')
    ? dataValue(built, 'refusal')
    : undefined;
  if (refusalValue !== null) {
    return null;
  }
  const review = dataValue(built, 'review');
  const dispatch = dataValue(built, 'dispatchRequest');
  if (!(plainRecord(review) && plainRecord(dispatch))) {
    return null;
  }
  const selector = {};
  for (const key of [
    'actionId',
    'attemptId',
    'generation',
    'planVersion',
    'runId',
    'spanId',
  ]) {
    selector[key] = dataValue(dispatch, key);
  }
  const acceptance = exactData(dataValue(review, 'acceptance'), [
    'criteria',
    'requireChange',
  ]);
  const target = validTarget(dataValue(review, 'target'));
  if (
    !(acceptance && target) ||
    dataValue(review, 'runId') !== selector.runId ||
    dataValue(review, 'spanId') !== selector.spanId ||
    dataValue(review, 'actionId') !== selector.actionId ||
    dataValue(review, 'attemptId') !== selector.attemptId ||
    dataValue(review, 'generation') !== selector.generation ||
    dataValue(review, 'planVersion') !== selector.planVersion
  ) {
    return null;
  }
  const requestRaw = {
    criteria: dataValue(acceptance, 'criteria'),
    instructions: dataValue(review, 'instructions'),
    profile: dataValue(review, 'profile'),
    requireChange: dataValue(acceptance, 'requireChange'),
    runId: dataValue(review, 'runId'),
    spanId: dataValue(review, 'spanId'),
    target,
    wallClockMs: dataValue(review, 'wallClockMs'),
  };
  const profile = profilePolicy(requestRaw.profile);
  if (!profile) {
    return null;
  }
  if (own(review, 'budgetUsd')) {
    requestRaw.budgetUsd = dataValue(review, 'budgetUsd');
  }
  const request = normalizedRequest(requestRaw, { requireNormalized: true });
  if (!request) {
    return null;
  }
  if (request.budgetUsd === undefined) {
    if (dataValue(built, 'budgetMicro') !== null) {
      return null;
    }
  } else if (dataValue(built, 'budgetMicro') !== toMicro(request.budgetUsd)) {
    return null;
  }
  return { request, selector };
}

function envelopeFrom(run, built) {
  const reviewed = reviewedRequestOf(built);
  if (!reviewed) {
    return refusal('SPANS_EXECUTION_ENVELOPE_INVALID');
  }
  const { request, selector } = reviewed;
  const input = buildSpansExecutionInput({ run, selector });
  if (!input.ok || input.mediaType !== SPANS_EXECUTION_INPUT_MEDIA_TYPE) {
    return refusal('SPANS_EXECUTION_ENVELOPE_INVALID');
  }
  let context;
  try {
    context = JSON.parse(input.text);
  } catch {
    return refusal('SPANS_EXECUTION_ENVELOPE_INVALID');
  }
  if (!validContext(context, request)) {
    return refusal('SPANS_EXECUTION_ENVELOPE_INVALID');
  }
  const envelope = {
    context,
    request,
    version: SPANS_EXECUTION_INPUT_VERSION,
  };
  const text = canonicalJson(envelope);
  const bytes = Buffer.byteLength(text, 'utf8');
  if (bytes > SPANS_EXECUTION_INPUT_MAX_BYTES) {
    return refusal('SPANS_EXECUTION_ENVELOPE_TOO_LARGE');
  }
  const mediaType = SPANS_EXECUTION_INPUT_MEDIA_TYPE;
  return {
    artifactId: `sha256:${hashArtifact(mediaType, text)}`,
    bytes,
    mediaType,
    ok: true,
    text,
  };
}

/** Build the exact canonical input retained for a successful current buildReview. */
export function buildSpansExecutionEnvelope(input) {
  try {
    const args = rootArgs(input, ['run', 'built']);
    if (!args) {
      return refusal('SPANS_EXECUTION_ENVELOPE_INVALID');
    }
    return envelopeFrom(args.run, args.built);
  } catch {
    return refusal('SPANS_EXECUTION_ENVELOPE_INVALID');
  }
}

function requestFromEnvelope(envelope) {
  if (
    !plainRecord(envelope) ||
    Reflect.ownKeys(envelope).length !== 3 ||
    !own(envelope, 'context') ||
    !own(envelope, 'request') ||
    !own(envelope, 'version') ||
    dataValue(envelope, 'version') !== SPANS_EXECUTION_INPUT_VERSION
  ) {
    return null;
  }
  const request = normalizedRequest(dataValue(envelope, 'request'), {
    requireNormalized: true,
  });
  if (!(request && validContext(dataValue(envelope, 'context'), request))) {
    return null;
  }
  return request;
}

/** Decode a retained artifact against its existing v1 review input binding. */
export function readSpansExecutionRequest(input) {
  try {
    const args = rootArgs(input, ['artifact', 'binding']);
    if (!(args && plainRecord(args.artifact) && plainRecord(args.binding))) {
      return refusal('SPANS_EXECUTION_REQUEST_INVALID');
    }
    const artifact = exactData(args.artifact, ['mediaType', 'ok', 'text']);
    const { binding } = args;
    const inputArtifact = exactData(dataValue(binding, 'inputArtifact'), [
      'digest',
      'id',
    ]);
    if (
      artifact?.ok !== true ||
      artifact.mediaType !== SPANS_EXECUTION_INPUT_MEDIA_TYPE ||
      typeof artifact.text !== 'string' ||
      !inputArtifact ||
      !validDigest(inputArtifact.digest) ||
      inputArtifact.id !== `sha256:${inputArtifact.digest}`
    ) {
      return refusal('SPANS_EXECUTION_REQUEST_INVALID');
    }
    const bytes = Buffer.byteLength(artifact.text, 'utf8');
    if (bytes > SPANS_EXECUTION_INPUT_MAX_BYTES) {
      return refusal('SPANS_EXECUTION_REQUEST_INVALID');
    }
    const digest = hashArtifact(artifact.mediaType, artifact.text);
    if (
      digest !== inputArtifact.digest ||
      `sha256:${digest}` !== inputArtifact.id
    ) {
      return refusal('SPANS_EXECUTION_REQUEST_INVALID');
    }
    const bindingIdentity = exactData(binding, [
      'actionId',
      'admission',
      'attemptId',
      'checkout',
      'digests',
      'executionVersion',
      'generation',
      'inputArtifact',
      'planVersion',
      'policy',
      'profile',
      'requiredCapabilities',
      'runId',
      'spanId',
      'target',
      'targetDigest',
    ]);
    if (
      !bindingIdentity ||
      bindingIdentity.executionVersion !== SPANS_EXECUTION_REVIEW_VERSION
    ) {
      return refusal('SPANS_EXECUTION_REQUEST_INVALID');
    }
    const profile = exactData(bindingIdentity.profile, [
      'digest',
      'effort',
      'id',
      'model',
      'provider',
    ]);
    const expectedProfile = profile && profilePolicy(profile.id);
    const policy = copyJson(bindingIdentity.policy);
    if (!(profile && expectedProfile)) {
      return refusal('SPANS_EXECUTION_REQUEST_INVALID');
    }
    if (
      !validDigest(profile.digest) ||
      profile.provider !== expectedProfile.provider ||
      profile.model !== expectedProfile.model ||
      profile.effort !== expectedProfile.effort ||
      canonicalJson(policy) !== canonicalJson(expectedProfile.policy)
    ) {
      return refusal('SPANS_EXECUTION_REQUEST_INVALID');
    }
    let parsed;
    try {
      parsed = JSON.parse(artifact.text);
    } catch {
      return refusal('SPANS_EXECUTION_REQUEST_INVALID');
    }
    if (canonicalJson(parsed) !== artifact.text) {
      return refusal('SPANS_EXECUTION_REQUEST_INVALID');
    }
    const request = requestFromEnvelope(parsed);
    const bindingTarget = validTarget(bindingIdentity.target);
    if (
      !(request && bindingTarget) ||
      request.runId !== bindingIdentity.runId ||
      request.spanId !== bindingIdentity.spanId ||
      request.profile !== profile.id ||
      canonicalJson(request.target) !== canonicalJson(bindingTarget)
    ) {
      return refusal('SPANS_EXECUTION_REQUEST_INVALID');
    }
    return { ok: true, request };
  } catch {
    return refusal('SPANS_EXECUTION_REQUEST_INVALID');
  }
}

function checkoutValue(dispatch) {
  const raw = dataValue(dispatch, 'checkout');
  const checkout = exactData(raw, ['expected', 'repoDir', 'wtDir']);
  if (
    !checkout ||
    typeof checkout.repoDir !== 'string' ||
    typeof checkout.wtDir !== 'string'
  ) {
    return null;
  }
  const expected = copyJson(checkout.expected);
  if (!plainRecord(expected) || targetDigestFor(expected) === null) {
    return null;
  }
  return { expected, repoDir: checkout.repoDir, wtDir: checkout.wtDir };
}

function profileDefinitionMatches(definition, profile) {
  const value = exactData(
    definition,
    ['billing', 'effort', 'model', 'provider'],
    ['client', 'effortPolicy', 'permissionMode', 'tools']
  );
  return Boolean(
    value &&
      value.billing === 'subscription' &&
      value.provider === profile.provider &&
      value.model === profile.model &&
      value.effort === profile.effort
  );
}

function limitsValue(value) {
  const limits = exactData(value, [
    'lowStorageFloorBytes',
    'maxManagedSessions',
  ]);
  return limits &&
    Number.isSafeInteger(limits.lowStorageFloorBytes) &&
    limits.lowStorageFloorBytes >= 0 &&
    Number.isSafeInteger(limits.maxManagedSessions) &&
    limits.maxManagedSessions >= 1 &&
    limits.maxManagedSessions <= 64
    ? limits
    : null;
}

function reviewedProfile({ built, definition }) {
  const review = dataValue(built, 'review');
  const profileId = dataValue(review, 'profile');
  const profile = profilePolicy(profileId);
  const wallClockMs = dataValue(review, 'wallClockMs');
  const profileDigest = dataValue(built, 'profileDigest');
  if (!(profile && profileDefinitionMatches(definition, profile))) {
    return null;
  }
  if (
    !(validDigest(profileDigest) && Number.isSafeInteger(wallClockMs)) ||
    wallClockMs < MIN_WALL_CLOCK_MS ||
    wallClockMs > profile.policy.attemptTimeoutMs
  ) {
    return null;
  }
  return {
    digest: profileDigest,
    effort: profile.effort,
    id: profileId,
    model: profile.model,
    provider: profile.provider,
  };
}

/** Map a trusted current buildReview plus admitted-policy observations to E93 v1. */
export function buildSpansExecutionReviewBinding(input) {
  try {
    const args = rootArgs(input, [
      'built',
      'definition',
      'inputArtifact',
      'admissionLimits',
    ]);
    if (!(args && plainRecord(args.built))) {
      return refusal('SPANS_EXECUTION_BINDING_INVALID');
    }
    const { built } = args;
    if (own(built, 'refusal') && dataValue(built, 'refusal') !== null) {
      return refusal('SPANS_EXECUTION_BINDING_INVALID');
    }
    const review = dataValue(built, 'review');
    const dispatch = dataValue(built, 'dispatchRequest');
    if (!(plainRecord(review) && plainRecord(dispatch))) {
      return refusal('SPANS_EXECUTION_BINDING_INVALID');
    }
    const profile = reviewedProfile({ built, definition: args.definition });
    const checkout = checkoutValue(dispatch);
    const target = validTarget(dataValue(review, 'target'));
    const dispatchTarget = validTarget(dataValue(dispatch, 'target'));
    const inputArtifact = exactData(args.inputArtifact, ['digest', 'id']);
    const limits = limitsValue(args.admissionLimits);
    const requiredCapabilities = copyJson(
      dataValue(review, 'requiredCapabilities')
    );
    const selector = {};
    for (const key of [
      'actionId',
      'attemptId',
      'generation',
      'planVersion',
      'runId',
      'spanId',
    ]) {
      selector[key] = dataValue(dispatch, key);
    }
    const targetDigest = dataValue(dispatch, 'targetDigest');
    if (!(profile && checkout && target && dispatchTarget)) {
      return refusal('SPANS_EXECUTION_BINDING_INVALID');
    }
    if (
      canonicalJson(target) !== canonicalJson(dispatchTarget) ||
      !inputArtifact ||
      !validDigest(inputArtifact.digest) ||
      inputArtifact.id !== `sha256:${inputArtifact.digest}` ||
      !limits ||
      !Array.isArray(requiredCapabilities) ||
      requiredCapabilities.length === 0 ||
      requiredCapabilities.length > 64 ||
      requiredCapabilities.some((item) => !isExplicitId(item)) ||
      new Set(requiredCapabilities).size !== requiredCapabilities.length ||
      !isExplicitId(selector.actionId) ||
      !isExplicitId(selector.attemptId) ||
      !isExplicitId(selector.runId) ||
      !isExplicitId(selector.spanId) ||
      !Number.isSafeInteger(selector.generation) ||
      selector.generation < 0 ||
      !Number.isSafeInteger(selector.planVersion) ||
      selector.planVersion < 1 ||
      dataValue(review, 'runId') !== selector.runId ||
      dataValue(review, 'spanId') !== selector.spanId ||
      dataValue(review, 'actionId') !== selector.actionId ||
      dataValue(review, 'attemptId') !== selector.attemptId ||
      dataValue(review, 'generation') !== selector.generation ||
      dataValue(review, 'planVersion') !== selector.planVersion ||
      !validDigest(targetDigest) ||
      targetDigestFor(checkout.expected) !== targetDigest ||
      dataValue(dispatch, 'admissionKind') !== 'headless-run'
    ) {
      return refusal('SPANS_EXECUTION_BINDING_INVALID');
    }
    const { expected } = checkout;
    const expectedCheckout = exactData(expected, [
      'dependency',
      'dirty',
      'head',
      'identity',
    ]);
    const dependency =
      expectedCheckout &&
      parseSpansDependencyBinding(expectedCheckout.dependency);
    const dirty =
      expectedCheckout && exactData(expectedCheckout.dirty, ['count', 'hash']);
    if (!(expectedCheckout && dependency && dirty)) {
      return refusal('SPANS_EXECUTION_BINDING_INVALID');
    }
    if (
      typeof expectedCheckout.head !== 'string' ||
      !HEAD_PATTERN.test(expectedCheckout.head) ||
      !validDigest(dirty.hash)
    ) {
      return refusal('SPANS_EXECUTION_BINDING_INVALID');
    }
    const artifactDigest = inputArtifact.digest;
    const { policy } = profilePolicy(profile.id);
    const admissionPolicyDigest = digestOf({
      archiveBudget: {
        bytes: ARCHIVE_BUDGET_BYTES,
        version: ARCHIVE_BUDGET_VERSION,
      },
      limits,
      maxWorkers: MAX_WORKERS,
    });
    const binding = {
      actionId: selector.actionId,
      admission: {
        kind: 'headless-run',
        policyDigest: admissionPolicyDigest,
      },
      attemptId: selector.attemptId,
      checkout,
      digests: {
        dependencies: digestOf(dependency),
        dirty: dirty.hash,
        head:
          expectedCheckout.head.length === 40
            ? sha256(expectedCheckout.head)
            : expectedCheckout.head,
        ...(dependency.version === 2
          ? {}
          : { lockfile: dependency.lockfileHash }),
      },
      executionVersion: SPANS_EXECUTION_REVIEW_VERSION,
      generation: selector.generation,
      inputArtifact: { digest: artifactDigest, id: inputArtifact.id },
      planVersion: selector.planVersion,
      policy: copyJson(policy),
      profile,
      requiredCapabilities,
      runId: selector.runId,
      spanId: selector.spanId,
      target,
      targetDigest,
    };
    return { binding, ok: true };
  } catch {
    return refusal('SPANS_EXECUTION_BINDING_INVALID');
  }
}
