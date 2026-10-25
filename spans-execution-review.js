// Durable execution authority for Spans. This module records reviews and
// receipts; it never admits, launches, or retries work.

import { createHash } from 'node:crypto';
import { isAbsolute, normalize } from 'node:path';
import { parseSpansDependencyBinding } from './spans-dependency-binding.js';
import { targetDigestFor } from './spans-dispatch.js';

export const SPANS_EXECUTION_REVIEW_VERSION = 1;
const VERSION = SPANS_EXECUTION_REVIEW_VERSION;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const ARTIFACT_ID = /^sha256:[a-f0-9]{64}$/;
const HEX = /^[a-f0-9]{64}$/;
const HEAD = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const MAX_BYTES = 65_536;
const MAX_DEPTH = 20;
const MAX_NODES = 1024;
const MAX_KEYS = 128;
const MAX_ARRAY = 128;
const MAX_STRING = 4096;
const MAX_REVIEWS = 256;
const MAX_RECEIPTS = 256;
const MAX_RECEIPT_HISTORY = 64;
const SAFE_PART_FORBIDDEN = /[\\:\s]/;
const PATH_SEPARATOR = /[\\/]/;
const SEPARATOR = '/';
const LUNA_POLICY = Object.freeze({
  attempt: 0,
  attemptTimeoutMs: 1_800_000,
  capture: 'full-stop',
  effort: 'high',
  maxWorkers: 2,
  model: 'gpt-6-luna',
  provider: 'codex',
  retries: 0,
  subscriptionOnly: true,
});
const CLAUDE_POLICY = Object.freeze({
  attempt: 0,
  attemptTimeoutMs: 3_600_000,
  capture: 'full-stop',
  effort: 'medium',
  maxWorkers: 2,
  model: 'claude-sonnet-5-5',
  provider: 'anthropic',
  retries: 0,
  subscriptionOnly: true,
});
export const SPANS_EXECUTION_REVIEW_PROFILES = Object.freeze({
  'claude-code-sonnet': Object.freeze({
    effort: 'medium',
    model: 'claude-sonnet-5-5',
    policy: CLAUDE_POLICY,
    provider: 'anthropic',
  }),
  'codex:gpt-6-luna:high': Object.freeze({
    effort: 'high',
    model: 'gpt-6-luna',
    policy: LUNA_POLICY,
    provider: 'codex',
  }),
});
const ERRORS = Object.freeze({
  SPANS_EXECUTION_REVIEW_APPROVAL: 'Human confirmation could not be verified.',
  SPANS_EXECUTION_REVIEW_CHANGED:
    'Execution binding changed; prepare a new review.',
  SPANS_EXECUTION_REVIEW_CONFLICT:
    'A different execution review already exists.',
  SPANS_EXECUTION_REVIEW_INVALID: 'Invalid execution review request or record.',
  SPANS_EXECUTION_REVIEW_NOT_FOUND: 'Execution review was not found.',
  SPANS_EXECUTION_REVIEW_REVOKED: 'Execution review approval was revoked.',
  SPANS_EXECUTION_REVIEW_STORAGE:
    'Execution review could not be stored or read.',
  SPANS_EXECUTION_REVIEW_UNAPPROVED:
    'Execution review has no current approval.',
  SPANS_EXECUTION_REVIEW_UNKNOWN: 'Execution review write outcome is unknown.',
});
const refusal = (code) => ({ code, error: ERRORS[code], ok: false });
const isRecord = (value) =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const own = (value, key) => Object.hasOwn(value, key);
const id = (value) => typeof value === 'string' && ID.test(value);
const isDigest = (value) => typeof value === 'string' && HEX.test(value);

function property(value, key) {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (!(descriptor?.enumerable && own(descriptor, 'value'))) {
    throw new TypeError('property');
  }
  return descriptor.value;
}

function cloneArray(item, depth, visit) {
  if (Object.getPrototypeOf(item) !== Array.prototype) {
    throw new TypeError('array');
  }
  const keys = Reflect.ownKeys(item);
  const lengthDescriptor = Object.getOwnPropertyDescriptor(item, 'length');
  const length = lengthDescriptor?.value;
  if (length > MAX_ARRAY || keys.length !== length + 1) {
    throw new TypeError('array');
  }
  const result = [];
  for (let index = 0; index < length; index += 1) {
    result.push(visit(property(item, String(index)), depth + 1));
  }
  return result;
}

function cloneObject(item, depth, state, visit) {
  const prototype = Object.getPrototypeOf(item);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError('object');
  }
  const keys = Reflect.ownKeys(item);
  if (keys.length > MAX_KEYS) {
    throw new TypeError('keys');
  }
  const result = {};
  for (const key of keys) {
    if (
      typeof key !== 'string' ||
      key.length > MAX_STRING ||
      key === '__proto__'
    ) {
      throw new TypeError('key');
    }
    state.bytes += Buffer.byteLength(key, 'utf8');
    if (state.bytes > MAX_BYTES) {
      throw new TypeError('bytes');
    }
    result[key] = visit(property(item, key), depth + 1);
  }
  return result;
}

function cloneVisit(item, depth, state, ancestors) {
  state.nodes += 1;
  if (state.nodes > MAX_NODES || depth > MAX_DEPTH) {
    throw new TypeError('bounds');
  }
  if (item === null || typeof item === 'boolean') {
    return item;
  }
  if (typeof item === 'number') {
    if (!Number.isFinite(item)) {
      throw new TypeError('number');
    }
    return item;
  }
  if (typeof item === 'string') {
    if (item.length > MAX_STRING) {
      throw new TypeError('string');
    }
    state.bytes += Buffer.byteLength(item, 'utf8');
    if (state.bytes > MAX_BYTES) {
      throw new TypeError('bytes');
    }
    return item;
  }
  if (typeof item !== 'object' || ancestors.has(item)) {
    throw new TypeError('value');
  }
  ancestors.add(item);
  const visit = (child, childDepth) =>
    cloneVisit(child, childDepth, state, ancestors);
  const result = Array.isArray(item)
    ? cloneArray(item, depth, visit)
    : cloneObject(item, depth, state, visit);
  ancestors.delete(item);
  return result;
}

function cloneBounded(value) {
  const state = { bytes: 0, nodes: 0 };
  const copy = cloneVisit(value, 0, state, new Set());
  const encoded = JSON.stringify(copy);
  if (Buffer.byteLength(encoded, 'utf8') > MAX_BYTES) {
    throw new TypeError('bytes');
  }
  return copy;
}

function canonical(value) {
  const copy = cloneBounded(value);
  function encode(item) {
    if (Array.isArray(item)) {
      return `[${item.map(encode).join(',')}]`;
    }
    if (isRecord(item)) {
      return `{${Object.keys(item)
        .sort()
        .map((key) => `${JSON.stringify(key)}:${encode(item[key])}`)
        .join(',')}}`;
    }
    return JSON.stringify(item);
  }
  return encode(copy);
}

function sha(value) {
  return createHash('sha256').update(canonical(value), 'utf8').digest('hex');
}

function exactKeys(value, keys, optional = []) {
  if (!isRecord(value)) {
    return false;
  }
  const ownKeys = Reflect.ownKeys(value);
  const allowed = new Set([...keys, ...optional]);
  return (
    ownKeys.every((key) => typeof key === 'string' && allowed.has(key)) &&
    keys.every((key) => own(value, key))
  );
}

function select(raw, required, optional = []) {
  const value = cloneBounded(raw);
  if (!exactKeys(value, required, optional)) {
    return null;
  }
  return value;
}

function validSelectorRequest(request, withDigest) {
  if (!request) {
    return false;
  }
  if (
    ![request.runId, request.spanId, request.actionId, request.attemptId].every(
      id
    )
  ) {
    return false;
  }
  if (!Number.isSafeInteger(request.generation)) {
    return false;
  }
  if (request.generation < 0) {
    return false;
  }
  if (!Number.isSafeInteger(request.planVersion)) {
    return false;
  }
  if (request.planVersion < 1) {
    return false;
  }
  if (withDigest && !isDigest(request.reviewDigest)) {
    return false;
  }
  return true;
}

function validReviewRequest(request) {
  if (!request) {
    return false;
  }
  if (!id(request.runId)) {
    return false;
  }
  return isDigest(request.reviewDigest);
}

function normalizeSelector(raw, withDigest = false) {
  const request = select(
    raw,
    ['actionId', 'attemptId', 'generation', 'planVersion', 'runId', 'spanId'],
    withDigest ? ['reviewDigest'] : []
  );
  if (!validSelectorRequest(request, withDigest)) {
    return null;
  }
  return request;
}

function matchesSelector(binding, selector) {
  return (
    binding.executionVersion === VERSION &&
    binding.runId === selector.runId &&
    binding.spanId === selector.spanId &&
    binding.actionId === selector.actionId &&
    binding.attemptId === selector.attemptId &&
    binding.generation === selector.generation &&
    binding.planVersion === selector.planVersion
  );
}

function validTarget(target) {
  return (
    exactKeys(target, ['name', 'repo']) &&
    safePart(target.repo) &&
    safeTargetName(target.name)
  );
}

function validCheckout(checkout) {
  return (
    exactKeys(checkout, ['expected', 'repoDir', 'wtDir']) &&
    absolutePath(checkout.wtDir) &&
    absolutePath(checkout.repoDir)
  );
}

// V1 defines direct duplicates for dirty and lockfile, and a SHA-256 Git head
// is itself a digest. It does not define derivations for dependencies or a
// SHA-1 Git head, so those values remain opaque rather than being guessed.
function validExpectedCheckout(expected, digests) {
  if (!exactKeys(expected, ['dependency', 'dirty', 'head', 'identity'])) {
    return false;
  }
  if (!HEAD.test(expected.head)) {
    return false;
  }
  if (!isDigest(digests.head)) {
    return false;
  }
  if (!exactKeys(expected.dirty, ['count', 'hash'])) {
    return false;
  }
  if (!Number.isSafeInteger(expected.dirty.count)) {
    return false;
  }
  if (expected.dirty.count < 0) {
    return false;
  }
  if (!isDigest(expected.dirty.hash)) {
    return false;
  }
  const dependency = parseSpansDependencyBinding(expected.dependency);
  if (!dependency || expected.dirty.hash !== digests.dirty) {
    return false;
  }
  if (dependency.version === 2) {
    if (own(digests, 'lockfile') || digests.dependencies !== sha(dependency)) {
      return false;
    }
  } else if (dependency.lockfileHash !== digests.lockfile) {
    return false;
  }
  return expected.head.length !== 64 || expected.head === digests.head;
}

function validIdentity(identity, checkout) {
  if (
    !exactKeys(identity, [
      'admin',
      'adminPath',
      'checkout',
      'checkoutPath',
      'known',
      'repository',
      'repositoryPath',
    ])
  ) {
    return false;
  }
  if (identity.known !== true) {
    return false;
  }
  if (identity.checkoutPath !== checkout.wtDir) {
    return false;
  }
  if (identity.repositoryPath !== checkout.repoDir) {
    return false;
  }
  for (const key of ['admin', 'checkout', 'repository']) {
    if (!exactKeys(identity[key], ['birthtimeNs', 'dev', 'ino'])) {
      return false;
    }
    if (
      !Object.values(identity[key]).every(
        (part) =>
          typeof part === 'string' && part.length > 0 && part.length <= 128
      )
    ) {
      return false;
    }
  }
  return (
    absolutePath(identity.adminPath) &&
    absolutePath(identity.checkoutPath) &&
    absolutePath(identity.repositoryPath)
  );
}

function validDigests(digests) {
  const fields = ['dependencies', 'dirty', 'head'];
  return (
    (exactKeys(digests, fields) ||
      exactKeys(digests, [...fields, 'lockfile'])) &&
    Object.values(digests).every(isDigest)
  );
}

function ambiguousCommitFailure(result) {
  return (
    result?.unknown === true ||
    result?.state === 'unknown' ||
    ['SPANS_MODEL_BUSY', 'SPANS_MODEL_UNAVAILABLE'].includes(result?.code) ||
    (typeof result?.code === 'string' && result.code.endsWith('_UNKNOWN'))
  );
}

function unknownCommit() {
  return { ...refusal('SPANS_EXECUTION_REVIEW_UNKNOWN'), unknown: true };
}

function validInputArtifact(inputArtifact) {
  return (
    exactKeys(inputArtifact, ['digest', 'id']) &&
    isDigest(inputArtifact.digest) &&
    ARTIFACT_ID.test(inputArtifact.id)
  );
}

function validProfile(profile) {
  if (
    !(
      exactKeys(profile, ['digest', 'effort', 'id', 'model', 'provider']) &&
      isDigest(profile.digest)
    )
  ) {
    return false;
  }
  const expected = Object.hasOwn(SPANS_EXECUTION_REVIEW_PROFILES, profile.id)
    ? SPANS_EXECUTION_REVIEW_PROFILES[profile.id]
    : null;
  return Boolean(
    expected &&
      profile.provider === expected.provider &&
      profile.model === expected.model &&
      profile.effort === expected.effort
  );
}

function policyForProfile(profile) {
  return validProfile(profile)
    ? SPANS_EXECUTION_REVIEW_PROFILES[profile.id].policy
    : null;
}

function validCapabilities(capabilities) {
  return (
    Array.isArray(capabilities) &&
    capabilities.length <= 64 &&
    capabilities.every(id) &&
    new Set(capabilities).size === capabilities.length
  );
}

function validAdmission(admission) {
  return (
    exactKeys(admission, ['kind', 'policyDigest']) &&
    ['headless-run', 'session'].includes(admission.kind) &&
    isDigest(admission.policyDigest)
  );
}

function normalizeBinding(raw, selector) {
  const keys = [
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
  ];
  const binding = select(raw, keys);
  if (!(binding && matchesSelector(binding, selector))) {
    return null;
  }
  if (!validTarget(binding.target)) {
    return null;
  }
  if (!validCheckout(binding.checkout)) {
    return null;
  }
  if (!validDigests(binding.digests)) {
    return null;
  }
  const { expected } = binding.checkout;
  if (!validExpectedCheckout(expected, binding.digests)) {
    return null;
  }
  if (!validIdentity(expected.identity, binding.checkout)) {
    return null;
  }
  if (!validInputArtifact(binding.inputArtifact)) {
    return null;
  }
  if (!validProfile(binding.profile)) {
    return null;
  }
  if (!validCapabilities(binding.requiredCapabilities)) {
    return null;
  }
  if (!validAdmission(binding.admission)) {
    return null;
  }
  const expectedPolicy = policyForProfile(binding.profile);
  if (
    !expectedPolicy ||
    canonical(binding.policy) !== canonical(expectedPolicy)
  ) {
    return null;
  }
  if (
    !isDigest(binding.targetDigest) ||
    targetDigestFor(expected) !== binding.targetDigest
  ) {
    return null;
  }
  return binding;
}

function safePart(value) {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 256 &&
    !value.startsWith('-') &&
    value !== '.' &&
    value !== '..' &&
    !PATH_SEPARATOR.test(value) &&
    !SAFE_PART_FORBIDDEN.test(value) &&
    hasNoControlCharacters(value)
  );
}

function safeTargetName(value) {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.split(SEPARATOR).every(safePart)
  );
}

function absolutePath(value) {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 4096 &&
    isAbsolute(value) &&
    normalize(value) === value &&
    hasNoControlCharacters(value) &&
    !value.split(PATH_SEPARATOR).includes('..')
  );
}

function hasNoControlCharacters(value) {
  for (const character of value) {
    const code = character.codePointAt(0);
    if (code < 32 || code === 127) {
      return false;
    }
  }
  return true;
}

function stableEventId(type, runId, reviewDigest, detail = '') {
  return createHash('sha256')
    .update(
      JSON.stringify([
        'spans.execution-review',
        type,
        runId,
        reviewDigest,
        detail,
      ])
    )
    .digest('hex');
}

function validConfirmation(raw) {
  const value = select(raw, ['confirmedAt', 'reference', 'source']);
  if (
    !value ||
    typeof value.source !== 'string' ||
    value.source.length < 1 ||
    value.source.length > 128 ||
    !id(value.reference) ||
    typeof value.confirmedAt !== 'string' ||
    value.confirmedAt.length > 64 ||
    Number.isNaN(Date.parse(value.confirmedAt))
  ) {
    return null;
  }
  return value;
}

function confirmationMatches(raw, expected) {
  const provenance = validConfirmation(raw);
  return provenance && canonical(provenance) === canonical(expected);
}

function validReviewRecord(record, key) {
  if (
    !exactKeys(record, ['binding', 'executionVersion', 'reviewDigest']) ||
    record.executionVersion !== VERSION ||
    record.reviewDigest !== key ||
    !isDigest(key)
  ) {
    return false;
  }
  const binding = normalizeBinding(record.binding, record.binding);
  return Boolean(
    binding &&
      sha(binding) === key &&
      canonical(binding) === canonical(record.binding)
  );
}

function validReceipt(receipt) {
  if (
    !exactKeys(receipt, ['approvals', 'revocations', 'version']) ||
    receipt.version !== VERSION ||
    !Array.isArray(receipt.approvals) ||
    !Array.isArray(receipt.revocations) ||
    receipt.approvals.length > MAX_RECEIPT_HISTORY ||
    receipt.revocations.length > MAX_RECEIPT_HISTORY
  ) {
    return false;
  }
  return (
    receipt.approvals.every(
      (entry) =>
        exactKeys(entry, ['confirmation', 'version']) &&
        entry.version === VERSION &&
        Boolean(validConfirmation(entry.confirmation))
    ) &&
    receipt.revocations.every(
      (entry) =>
        exactKeys(entry, ['at', 'reference', 'source', 'version']) &&
        entry.version === VERSION &&
        typeof entry.source === 'string' &&
        entry.source.length > 0 &&
        entry.source.length <= 128 &&
        id(entry.reference) &&
        typeof entry.at === 'string' &&
        !Number.isNaN(Date.parse(entry.at))
    )
  );
}

function validExecutionReviews(reviews, reviewKeys) {
  for (const key of reviewKeys) {
    if (!validReviewRecord(reviews[key], key)) {
      return false;
    }
  }
  return true;
}

function validExecutionReceipts(execution, receiptKeys) {
  for (const key of receiptKeys) {
    if (
      !(
        isDigest(key) &&
        validReceipt(execution.receipts[key]) &&
        own(execution.reviews, key)
      )
    ) {
      return false;
    }
  }
  return true;
}

function validExecutionRecord(execution) {
  if (
    !exactKeys(execution, ['receipts', 'reviews', 'version']) ||
    execution.version !== VERSION ||
    !isRecord(execution.reviews) ||
    !isRecord(execution.receipts)
  ) {
    return false;
  }
  const reviewKeys = Reflect.ownKeys(execution.reviews);
  const receiptKeys = Reflect.ownKeys(execution.receipts);
  if (
    reviewKeys.length > MAX_REVIEWS ||
    receiptKeys.length > MAX_RECEIPTS ||
    reviewKeys.some((key) => typeof key !== 'string') ||
    receiptKeys.some((key) => typeof key !== 'string')
  ) {
    return false;
  }
  if (!validExecutionReviews(execution.reviews, reviewKeys)) {
    return false;
  }
  return validExecutionReceipts(execution, receiptKeys);
}

export function createSpansExecutionReviews({
  store,
  resolveBinding,
  verifyConfirmation,
  verifyRevocation,
  verifyWritable,
} = {}) {
  const configured =
    isRecord(store) &&
    typeof store.readRun === 'function' &&
    typeof store.getEventById === 'function' &&
    typeof store.commitRun === 'function';

  function run(runId) {
    try {
      const result = store.readRun({ runId });
      if (result?.ok === true) {
        return result;
      }
      return result?.code === 'SPANS_MODEL_NOT_FOUND' ? null : false;
    } catch {
      return false;
    }
  }

  function commitRun(input) {
    try {
      const result = store.commitRun(input);
      if (result?.ok === true) {
        return null;
      }
      if (
        ['SPANS_MODEL_STALE_GENERATION', 'SPANS_MODEL_STALE_REVISION'].includes(
          result?.code
        )
      ) {
        return refusal('SPANS_EXECUTION_REVIEW_CHANGED');
      }
      return ambiguousCommitFailure(result)
        ? unknownCommit()
        : refusal('SPANS_EXECUTION_REVIEW_STORAGE');
    } catch {
      return unknownCommit();
    }
  }

  function eventById(eventId, runId, type, digest) {
    try {
      const result = store.getEventById({ eventId });
      const event =
        result?.ok === true && result.found ? cloneBounded(result.event) : null;
      return event &&
        event.eventId === eventId &&
        event.runId === runId &&
        event.type === type &&
        event.payload?.reviewDigest === digest &&
        event.payload?.executionVersion === VERSION
        ? event
        : null;
    } catch {
      return null;
    }
  }

  function executionState(view) {
    if (!isRecord(view)) {
      return null;
    }
    if (!own(view, 'execution')) {
      return { receipts: {}, reviews: {}, version: VERSION };
    }
    const { execution } = view;
    return validExecutionRecord(execution) ? execution : null;
  }

  function reviewAt(current, reviewDigest) {
    const execution = executionState(current.view);
    if (!execution) {
      return { invalid: true };
    }
    const record = execution.reviews[reviewDigest];
    return record ? { execution, record } : null;
  }

  function reviewable(current, selector) {
    if (!current || current === false) {
      return 'SPANS_EXECUTION_REVIEW_STORAGE';
    }
    if (
      current.view?.readOnly === true ||
      current.view?.imported === true ||
      current.view?.kind === 'imported' ||
      current.view?.state === 'imported' ||
      current.view?.sourceId !== undefined
    ) {
      return 'SPANS_EXECUTION_REVIEW_INVALID';
    }
    if (
      current.generation !== selector.generation ||
      current.view.planVersion !== selector.planVersion ||
      !current.view.spans?.[selector.spanId]
    ) {
      return 'SPANS_EXECUTION_REVIEW_CHANGED';
    }
    if (!executionState(current.view)) {
      return 'SPANS_EXECUTION_REVIEW_INVALID';
    }
    return null;
  }

  function hasPreparedEvidence(runId, reviewDigest) {
    const type = 'spans.execution-review.prepared';
    return Boolean(
      eventById(
        stableEventId(type, runId, reviewDigest),
        runId,
        type,
        reviewDigest
      )
    );
  }

  async function resolve(selector) {
    if (typeof resolveBinding !== 'function') {
      return null;
    }
    try {
      const raw = await resolveBinding(cloneBounded(selector));
      return normalizeBinding(raw, selector);
    } catch {
      return null;
    }
  }

  async function writable(selector) {
    if (typeof verifyWritable !== 'function') {
      return false;
    }
    try {
      return (await verifyWritable(cloneBounded(selector))) === true;
    } catch {
      return false;
    }
  }

  function makeEvent(type, binding, reviewDigest, payload, detail = '') {
    return {
      eventId: stableEventId(type, binding.runId, reviewDigest, detail),
      payload,
      runId: binding.runId,
      type,
    };
  }

  function approvalEventsMatch(approvals, runId, reviewDigest) {
    const checked = [];
    for (const entry of approvals) {
      const type = 'spans.execution-review.approved';
      const event = eventById(
        stableEventId(type, runId, reviewDigest, entry.confirmation.reference),
        runId,
        type,
        reviewDigest
      );
      if (
        !event ||
        canonical(validConfirmation(event.payload.confirmation)) !==
          canonical(entry.confirmation)
      ) {
        return null;
      }
      checked.push(entry);
    }
    return checked;
  }

  function revocationEventsMatch(revocations, runId, reviewDigest) {
    const checked = [];
    for (const entry of revocations) {
      const type = 'spans.execution-review.revoked';
      const event = eventById(
        stableEventId(type, runId, reviewDigest, entry.reference),
        runId,
        type,
        reviewDigest
      );
      if (
        !event ||
        event.payload.reference !== entry.reference ||
        event.payload.source !== entry.source ||
        event.payload.revokedAt !== entry.at
      ) {
        return null;
      }
      checked.push(entry);
    }
    return checked;
  }

  function receiptMatches(execution, runId, reviewDigest) {
    const storedReceipt = execution.receipts[reviewDigest] ?? {
      approvals: [],
      revocations: [],
      version: VERSION,
    };
    if (
      !(validReceipt(storedReceipt) && hasPreparedEvidence(runId, reviewDigest))
    ) {
      return null;
    }
    const approvals = approvalEventsMatch(
      storedReceipt.approvals,
      runId,
      reviewDigest
    );
    if (!approvals) {
      return null;
    }
    const revocations = revocationEventsMatch(
      storedReceipt.revocations,
      runId,
      reviewDigest
    );
    if (!revocations) {
      return null;
    }
    const checked = { approvals, revocations, version: VERSION };
    return canonical(checked) === canonical(storedReceipt)
      ? storedReceipt
      : null;
  }

  async function prepareContext(raw) {
    if (!configured) {
      return { result: refusal('SPANS_EXECUTION_REVIEW_STORAGE') };
    }
    const selector = normalizeSelector(raw);
    if (!selector) {
      return { result: refusal('SPANS_EXECUTION_REVIEW_INVALID') };
    }
    if (!(await writable(selector))) {
      return { result: refusal('SPANS_EXECUTION_REVIEW_STORAGE') };
    }
    const binding = await resolve(selector);
    if (!binding) {
      return { result: refusal('SPANS_EXECUTION_REVIEW_CHANGED') };
    }
    const initial = run(selector.runId);
    if (!initial || initial === false) {
      return {
        result: refusal(
          initial === null
            ? 'SPANS_EXECUTION_REVIEW_NOT_FOUND'
            : 'SPANS_EXECUTION_REVIEW_STORAGE'
        ),
      };
    }
    const error = reviewable(initial, selector);
    if (error) {
      return { result: refusal(error) };
    }
    const state = prepareRecord({ binding, initial, selector });
    if (Object.hasOwn(state, 'result')) {
      return state.result;
    }
    return persistPreparedReview(state);
  }

  function prepareRecord(context) {
    const { binding, initial, selector } = context;
    const record = {
      binding,
      executionVersion: VERSION,
      reviewDigest: sha(binding),
    };
    const execution = executionState(initial.view);
    const prior = execution.reviews[record.reviewDigest];
    if (prior) {
      return {
        result:
          canonical(prior) === canonical(record)
            ? { ok: true, replayed: true, review: cloneBounded(prior) }
            : refusal('SPANS_EXECUTION_REVIEW_CONFLICT'),
      };
    }
    if (Object.keys(execution.reviews).length >= MAX_REVIEWS) {
      return { result: refusal('SPANS_EXECUTION_REVIEW_STORAGE') };
    }
    const fresh = run(selector.runId);
    if (
      !fresh ||
      fresh === false ||
      fresh.revision !== initial.revision ||
      fresh.generation !== initial.generation
    ) {
      return { result: refusal('SPANS_EXECUTION_REVIEW_CHANGED') };
    }
    return { binding, execution, fresh, record, selector };
  }

  function persistPreparedReview({
    binding,
    execution,
    fresh,
    record,
    selector,
  }) {
    const nextView = structuredClone(fresh.view);
    nextView.execution = {
      ...execution,
      reviews: { ...execution.reviews, [record.reviewDigest]: record },
    };
    const result = commitRun({
      events: [
        makeEvent(
          'spans.execution-review.prepared',
          binding,
          record.reviewDigest,
          {
            artifactId: binding.inputArtifact.id,
            executionVersion: VERSION,
            reviewDigest: record.reviewDigest,
          }
        ),
      ],
      expectedGeneration: fresh.generation,
      expectedRevision: fresh.revision,
      runId: selector.runId,
      view: nextView,
    });
    if (result) {
      return result;
    }
    return { ok: true, replayed: false, review: cloneBounded(record) };
  }

  async function prepare(raw) {
    try {
      const result = await prepareContext(raw);
      return Object.hasOwn(result, 'result') ? result.result : result;
    } catch {
      return refusal('SPANS_EXECUTION_REVIEW_INVALID');
    }
  }

  // biome-ignore lint/suspicious/useAwait: Public service methods consistently return promises.
  async function read(raw) {
    try {
      if (!configured) {
        return refusal('SPANS_EXECUTION_REVIEW_STORAGE');
      }
      const request = select(raw, ['reviewDigest', 'runId']);
      if (!validReviewRequest(request)) {
        return refusal('SPANS_EXECUTION_REVIEW_INVALID');
      }
      const current = run(request.runId);
      if (!current || current === false) {
        return refusal(
          current === null
            ? 'SPANS_EXECUTION_REVIEW_NOT_FOUND'
            : 'SPANS_EXECUTION_REVIEW_STORAGE'
        );
      }
      const found = reviewAt(current, request.reviewDigest);
      if (
        !found ||
        found.invalid ||
        !hasPreparedEvidence(request.runId, request.reviewDigest)
      ) {
        return refusal('SPANS_EXECUTION_REVIEW_INVALID');
      }
      return { ok: true, review: cloneBounded(found.record) };
    } catch {
      return refusal('SPANS_EXECUTION_REVIEW_INVALID');
    }
  }

  function approvalReview(raw) {
    if (!configured || typeof verifyConfirmation !== 'function') {
      return { result: refusal('SPANS_EXECUTION_REVIEW_APPROVAL') };
    }
    const request = select(raw, ['confirmation', 'reviewDigest', 'runId']);
    if (!validReviewRequest(request)) {
      return { result: refusal('SPANS_EXECUTION_REVIEW_INVALID') };
    }
    const before = run(request.runId);
    if (!before || before === false) {
      return {
        result: refusal(
          before === null
            ? 'SPANS_EXECUTION_REVIEW_NOT_FOUND'
            : 'SPANS_EXECUTION_REVIEW_STORAGE'
        ),
      };
    }
    const found = reviewAt(before, request.reviewDigest);
    if (!found || found.invalid) {
      return { result: refusal('SPANS_EXECUTION_REVIEW_INVALID') };
    }
    return {
      before,
      found,
      request,
      selector: selectorFromBinding(found.record.binding),
    };
  }

  async function finishApproval(context, confirmation) {
    const { before, found, request, selector } = context;
    const finalBinding = await resolve(selector);
    if (
      !finalBinding ||
      canonical(finalBinding) !== canonical(found.record.binding)
    ) {
      return refusal('SPANS_EXECUTION_REVIEW_CHANGED');
    }
    const current = run(request.runId);
    if (
      !current ||
      current === false ||
      current.revision !== before.revision ||
      current.generation !== before.generation
    ) {
      return refusal('SPANS_EXECUTION_REVIEW_CHANGED');
    }
    const currentFound = reviewAt(current, request.reviewDigest);
    if (
      !currentFound ||
      currentFound.invalid ||
      canonical(currentFound.record) !== canonical(found.record)
    ) {
      return refusal('SPANS_EXECUTION_REVIEW_CHANGED');
    }
    const finalBad = reviewable(current, selector);
    if (finalBad) {
      return refusal(finalBad);
    }
    const finalReceipt = receiptMatches(
      currentFound.execution,
      request.runId,
      request.reviewDigest
    );
    if (!finalReceipt) {
      return refusal('SPANS_EXECUTION_REVIEW_INVALID');
    }
    if (finalReceipt.revocations.length) {
      return refusal('SPANS_EXECUTION_REVIEW_REVOKED');
    }
    return commitApproval({
      confirmation,
      current,
      finalReceipt,
      found,
      request,
    });
  }

  async function approvalWorkflow(context) {
    const { before, found, request, selector } = context;
    if (!(await writable(selector))) {
      return refusal('SPANS_EXECUTION_REVIEW_STORAGE');
    }
    const bad = reviewable(before, selector);
    if (bad) {
      return refusal(bad);
    }
    const currentBinding = await resolve(selector);
    if (
      !currentBinding ||
      canonical(currentBinding) !== canonical(found.record.binding)
    ) {
      return refusal('SPANS_EXECUTION_REVIEW_CHANGED');
    }
    if (!hasPreparedEvidence(request.runId, request.reviewDigest)) {
      return refusal('SPANS_EXECUTION_REVIEW_INVALID');
    }
    const existing = receiptMatches(
      found.execution,
      request.runId,
      request.reviewDigest
    );
    if (!existing) {
      return refusal('SPANS_EXECUTION_REVIEW_INVALID');
    }
    if (existing.revocations.length) {
      return refusal('SPANS_EXECUTION_REVIEW_REVOKED');
    }
    const verified = await verifyConfirmation({
      confirmation: cloneBounded(request.confirmation),
      reviewDigest: request.reviewDigest,
      runId: request.runId,
    });
    const confirmation = validConfirmation(verified);
    if (!confirmation) {
      return refusal('SPANS_EXECUTION_REVIEW_APPROVAL');
    }
    return finishApproval(context, confirmation);
  }

  function commitApproval({
    confirmation,
    current,
    finalReceipt,
    found,
    request,
  }) {
    const payload = {
      confirmation,
      executionVersion: VERSION,
      reviewDigest: request.reviewDigest,
    };
    const approval = { confirmation, version: VERSION };
    if (
      finalReceipt.approvals.some(
        (entry) => canonical(entry) === canonical(approval)
      )
    ) {
      return { approval: payload, ok: true, replayed: true };
    }
    if (finalReceipt.approvals.length >= MAX_RECEIPT_HISTORY) {
      return refusal('SPANS_EXECUTION_REVIEW_STORAGE');
    }
    const nextView = structuredClone(current.view);
    nextView.execution.receipts[request.reviewDigest] = {
      ...finalReceipt,
      approvals: [...finalReceipt.approvals, approval],
    };
    const result = commitRun({
      events: [
        makeEvent(
          'spans.execution-review.approved',
          found.record.binding,
          request.reviewDigest,
          payload,
          confirmation.reference
        ),
      ],
      expectedGeneration: current.generation,
      expectedRevision: current.revision,
      runId: request.runId,
      view: nextView,
    });
    if (result) {
      return result;
    }
    return { approval: payload, ok: true, replayed: false };
  }

  async function approve(raw) {
    try {
      const review = approvalReview(raw);
      if (Object.hasOwn(review, 'result')) {
        return review.result;
      }
      return await approvalWorkflow(review);
    } catch {
      return refusal('SPANS_EXECUTION_REVIEW_INVALID');
    }
  }

  function revocationReview(raw) {
    if (!configured) {
      return { result: refusal('SPANS_EXECUTION_REVIEW_STORAGE') };
    }
    if (typeof verifyRevocation !== 'function') {
      return { result: refusal('SPANS_EXECUTION_REVIEW_APPROVAL') };
    }
    const request = select(raw, ['confirmation', 'reviewDigest', 'runId']);
    if (!validReviewRequest(request)) {
      return { result: refusal('SPANS_EXECUTION_REVIEW_INVALID') };
    }
    const before = run(request.runId);
    if (!before || before === false) {
      return {
        result: refusal(
          before === null
            ? 'SPANS_EXECUTION_REVIEW_NOT_FOUND'
            : 'SPANS_EXECUTION_REVIEW_STORAGE'
        ),
      };
    }
    const found = reviewAt(before, request.reviewDigest);
    if (!found || found.invalid) {
      return { result: refusal('SPANS_EXECUTION_REVIEW_INVALID') };
    }
    return { before, found, request };
  }

  function revocationReceipt(found, request) {
    const currentReceipt = receiptMatches(
      found.execution,
      request.runId,
      request.reviewDigest
    );
    if (!currentReceipt) {
      return { result: refusal('SPANS_EXECUTION_REVIEW_INVALID') };
    }
    if (currentReceipt.revocations.length) {
      return { result: { ok: true, replayed: true } };
    }
    if (!currentReceipt.approvals.length) {
      return { result: refusal('SPANS_EXECUTION_REVIEW_UNAPPROVED') };
    }
    if (currentReceipt.revocations.length >= MAX_RECEIPT_HISTORY) {
      return { result: refusal('SPANS_EXECUTION_REVIEW_STORAGE') };
    }
    return { currentReceipt };
  }

  async function revocationProvenance(request) {
    try {
      const verified = await verifyRevocation({
        confirmation: cloneBounded(request.confirmation),
        intent: 'revoke',
        reviewDigest: request.reviewDigest,
        runId: request.runId,
      });
      const provenance = validConfirmation(verified);
      return provenance
        ? { provenance }
        : { result: refusal('SPANS_EXECUTION_REVIEW_APPROVAL') };
    } catch {
      return { result: refusal('SPANS_EXECUTION_REVIEW_APPROVAL') };
    }
  }

  async function finalRevocationSnapshot(context) {
    const { before, found, request, selector } = context;
    if (!(await writable(selector))) {
      return { result: refusal('SPANS_EXECUTION_REVIEW_STORAGE') };
    }
    const current = run(request.runId);
    if (
      !current ||
      current === false ||
      current.revision !== before.revision ||
      current.generation !== before.generation
    ) {
      return { result: refusal('SPANS_EXECUTION_REVIEW_CHANGED') };
    }
    const currentFound = reviewAt(current, request.reviewDigest);
    if (
      !currentFound ||
      currentFound.invalid ||
      canonical(currentFound.record) !== canonical(found.record)
    ) {
      return { result: refusal('SPANS_EXECUTION_REVIEW_CHANGED') };
    }
    const currentReceipt = receiptMatches(
      currentFound.execution,
      request.runId,
      request.reviewDigest
    );
    if (!currentReceipt) {
      return { result: refusal('SPANS_EXECUTION_REVIEW_INVALID') };
    }
    if (currentReceipt.revocations.length) {
      return { result: { ok: true, replayed: true } };
    }
    if (!currentReceipt.approvals.length) {
      return { result: refusal('SPANS_EXECUTION_REVIEW_UNAPPROVED') };
    }
    return { current, currentFound, currentReceipt };
  }

  async function revokeWorkflow(context) {
    const { before, found, request } = context;
    const selector = selectorFromBinding(found.record.binding);
    if (!(await writable(selector))) {
      return refusal('SPANS_EXECUTION_REVIEW_STORAGE');
    }
    const receiptState = revocationReceipt(found, request);
    if (Object.hasOwn(receiptState, 'result')) {
      return receiptState.result;
    }
    const proof = await revocationProvenance(request);
    if (Object.hasOwn(proof, 'result')) {
      return proof.result;
    }
    const snapshot = await finalRevocationSnapshot({
      before,
      found,
      request,
      selector,
    });
    if (Object.hasOwn(snapshot, 'result')) {
      return snapshot.result;
    }
    return commitRevocation({
      current: snapshot.current,
      currentReceipt: snapshot.currentReceipt,
      found: snapshot.currentFound,
      provenance: proof.provenance,
      request,
    });
  }

  function commitRevocation({
    current,
    currentReceipt,
    found,
    provenance,
    request,
  }) {
    const { confirmedAt: revokedAt, reference, source } = provenance;
    const payload = {
      executionVersion: VERSION,
      reference,
      reviewDigest: request.reviewDigest,
      revokedAt,
      source,
    };
    const nextView = structuredClone(current.view);
    nextView.execution.receipts[request.reviewDigest] = {
      ...currentReceipt,
      revocations: [
        ...currentReceipt.revocations,
        { at: revokedAt, reference, source, version: VERSION },
      ],
    };
    const result = commitRun({
      events: [
        makeEvent(
          'spans.execution-review.revoked',
          found.record.binding,
          request.reviewDigest,
          payload,
          reference
        ),
      ],
      expectedGeneration: current.generation,
      expectedRevision: current.revision,
      runId: request.runId,
      view: nextView,
    });
    if (result) {
      return result;
    }
    return { ok: true, replayed: false };
  }

  async function revoke(raw) {
    try {
      const review = revocationReview(raw);
      if (Object.hasOwn(review, 'result')) {
        return review.result;
      }
      return await revokeWorkflow(review);
    } catch {
      return refusal('SPANS_EXECUTION_REVIEW_INVALID');
    }
  }

  function authorizationRecord(before, selector) {
    const found = reviewAt(before, selector.reviewDigest);
    if (
      !found ||
      found.invalid ||
      !validReviewRecord(found.record, selector.reviewDigest)
    ) {
      return { result: refusal('SPANS_EXECUTION_REVIEW_INVALID') };
    }
    const bad = reviewable(before, selector);
    if (bad) {
      return { result: refusal(bad) };
    }
    return { before, found, selector };
  }

  function authorizationRequest(raw) {
    if (!configured || typeof verifyConfirmation !== 'function') {
      return { result: refusal('SPANS_EXECUTION_REVIEW_APPROVAL') };
    }
    const selector = normalizeSelector(raw, true);
    if (!selector) {
      return { result: refusal('SPANS_EXECUTION_REVIEW_INVALID') };
    }
    return { selector };
  }

  function authorizationRun(selector) {
    const before = run(selector.runId);
    if (!before || before === false) {
      return refusal(
        before === null
          ? 'SPANS_EXECUTION_REVIEW_NOT_FOUND'
          : 'SPANS_EXECUTION_REVIEW_STORAGE'
      );
    }
    return { before };
  }

  function authorizationReceipt(found, selector) {
    const receipt = receiptMatches(
      found.execution,
      selector.runId,
      selector.reviewDigest
    );
    if (!receipt) {
      return { result: refusal('SPANS_EXECUTION_REVIEW_INVALID') };
    }
    if (!hasPreparedEvidence(selector.runId, selector.reviewDigest)) {
      return { result: refusal('SPANS_EXECUTION_REVIEW_INVALID') };
    }
    if (receipt.revocations.length) {
      return { result: refusal('SPANS_EXECUTION_REVIEW_REVOKED') };
    }
    const approval = receipt.approvals.at(-1);
    if (!approval) {
      return { result: refusal('SPANS_EXECUTION_REVIEW_UNAPPROVED') };
    }
    return { approval, receipt };
  }

  function authorizationSnapshot(context) {
    const { approval, before, found, receipt, selector } = context;
    const after = run(selector.runId);
    if (
      !after ||
      after === false ||
      after.revision !== before.revision ||
      after.generation !== before.generation
    ) {
      return { result: refusal('SPANS_EXECUTION_REVIEW_CHANGED') };
    }
    const afterFound = reviewAt(after, selector.reviewDigest);
    if (
      !afterFound ||
      afterFound.invalid ||
      canonical(afterFound.record) !== canonical(found.record)
    ) {
      return { result: refusal('SPANS_EXECUTION_REVIEW_CHANGED') };
    }
    const afterBad = reviewable(after, selector);
    if (afterBad) {
      return { result: refusal(afterBad) };
    }
    const afterReceipt = receiptMatches(
      afterFound.execution,
      selector.runId,
      selector.reviewDigest
    );
    if (!afterReceipt) {
      return { result: refusal('SPANS_EXECUTION_REVIEW_INVALID') };
    }
    if (afterReceipt.revocations.length) {
      return { result: refusal('SPANS_EXECUTION_REVIEW_REVOKED') };
    }
    if (canonical(afterReceipt) !== canonical(receipt)) {
      return { result: refusal('SPANS_EXECUTION_REVIEW_CHANGED') };
    }
    return { after, approval, before, found, selector };
  }

  function finalAuthorization({
    approval,
    before,
    finalBinding,
    finalRun,
    found,
    selector,
  }) {
    if (
      !finalBinding ||
      canonical(finalBinding) !== canonical(found.record.binding) ||
      !finalRun ||
      finalRun === false ||
      finalRun.revision !== before.revision
    ) {
      return refusal('SPANS_EXECUTION_REVIEW_CHANGED');
    }
    const review = cloneBounded(found.record);
    const confirmation = cloneBounded(approval.confirmation);
    const approvalResult = {
      confirmation,
      executionVersion: VERSION,
      reviewDigest: selector.reviewDigest,
    };
    return { approval: approvalResult, ok: true, review };
  }

  async function authorize(raw) {
    try {
      const requested = authorizationRequest(raw);
      if (Object.hasOwn(requested, 'result')) {
        return requested.result;
      }
      const { selector } = requested;
      if (!(await writable(selector))) {
        return refusal('SPANS_EXECUTION_REVIEW_STORAGE');
      }
      const current = authorizationRun(selector);
      if (!Object.hasOwn(current, 'before')) {
        return current;
      }
      const { before } = current;
      const review = authorizationRecord(before, selector);
      if (Object.hasOwn(review, 'result')) {
        return review.result;
      }
      const { found } = review;
      const binding = await resolve(selector);
      if (
        !(binding && canonical(binding) === canonical(found.record.binding))
      ) {
        return refusal('SPANS_EXECUTION_REVIEW_CHANGED');
      }
      const receiptState = authorizationReceipt(found, selector);
      if (Object.hasOwn(receiptState, 'result')) {
        return receiptState.result;
      }
      const { approval, receipt } = receiptState;
      const verified = await verifyConfirmation({
        confirmation: cloneBounded(approval.confirmation),
        reviewDigest: selector.reviewDigest,
        runId: selector.runId,
      });
      if (!confirmationMatches(verified, approval.confirmation)) {
        return refusal('SPANS_EXECUTION_REVIEW_APPROVAL');
      }
      const snapshot = authorizationSnapshot({
        approval,
        before,
        found,
        receipt,
        selector,
      });
      if (Object.hasOwn(snapshot, 'result')) {
        return snapshot.result;
      }
      const finalBinding = await resolve(selector);
      const finalRun = run(selector.runId);
      return finalAuthorization({
        ...snapshot,
        finalBinding,
        finalRun,
      });
    } catch {
      return refusal('SPANS_EXECUTION_REVIEW_INVALID');
    }
  }

  // Synchronous supplemental evidence for a caller that already holds the
  // current attempt fence. This deliberately does not resolve the live
  // binding or return an authorization; callers must first use authorize().
  function checkApprovalCurrent(rawSelector, rawExpectedApproval) {
    try {
      const requested = authorizationRequest(rawSelector);
      if (Object.hasOwn(requested, 'result')) {
        return requested.result;
      }
      const { selector } = requested;
      const expected = select(rawExpectedApproval, [
        'confirmation',
        'executionVersion',
        'reviewDigest',
      ]);
      if (
        !expected ||
        expected.executionVersion !== VERSION ||
        expected.reviewDigest !== selector.reviewDigest
      ) {
        return refusal('SPANS_EXECUTION_REVIEW_APPROVAL');
      }
      const expectedConfirmation = validConfirmation(expected.confirmation);
      if (!expectedConfirmation) {
        return refusal('SPANS_EXECUTION_REVIEW_APPROVAL');
      }
      const current = authorizationRun(selector);
      if (!Object.hasOwn(current, 'before')) {
        return current;
      }
      const review = authorizationRecord(current.before, selector);
      if (Object.hasOwn(review, 'result')) {
        return review.result;
      }
      const receiptState = authorizationReceipt(review.found, selector);
      if (Object.hasOwn(receiptState, 'result')) {
        return receiptState.result;
      }
      const matchesActiveReceipt = receiptState.receipt.approvals.some(
        (entry) =>
          entry.version === VERSION &&
          canonical(entry.confirmation) === canonical(expectedConfirmation)
      );
      if (!matchesActiveReceipt) {
        return refusal('SPANS_EXECUTION_REVIEW_APPROVAL');
      }
      return {
        current: true,
        evidence: {
          confirmedAt: expectedConfirmation.confirmedAt,
          executionVersion: VERSION,
          reference: expectedConfirmation.reference,
          reviewDigest: selector.reviewDigest,
          source: expectedConfirmation.source,
        },
        ok: true,
      };
    } catch {
      return refusal('SPANS_EXECUTION_REVIEW_INVALID');
    }
  }

  return Object.freeze({
    approve,
    authorize,
    checkApprovalCurrent,
    prepare,
    read,
    revoke,
  });
}

function selectorFromBinding(binding) {
  return {
    actionId: binding.actionId,
    attemptId: binding.attemptId,
    generation: binding.generation,
    planVersion: binding.planVersion,
    runId: binding.runId,
    spanId: binding.spanId,
  };
}
