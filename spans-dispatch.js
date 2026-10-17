import { createHash } from 'node:crypto';
import { isAbsolute } from 'node:path';
import { types } from 'node:util';
import { redactSpansValue as redactValue } from './spans-redaction.js';

// Guarded dispatch coordinator. It owns no scheduler, store, clock or live
// call: every effect goes through an injected adapter, and a missing adapter
// refuses before anything else runs. Existing Setu stores keep ownership of
// writer claims, checkout identity, setup, dependencies and admission leases.

const MAX_ID_LENGTH = 256;
const MAX_PATH_LENGTH = 4096;
const MAX_CAPABILITIES = 32;
const MAX_ARTIFACTS = 1024;
const MAX_DEPTH = 8;
const MAX_NODES = 256;
const MAX_KEYS = 64;
const MAX_ARRAY_LENGTH = 64;
const MAX_KEY_LENGTH = 256;
const MAX_STRING_LENGTH = 4096;
const MAX_TOTAL_CHARACTERS = 65_536;
const DIGEST_PATTERN = /^(?:sha256:)?[0-9a-f]{64}$/;
const DIGEST_PREFIX = 'sha256:';
const HEAD_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const HASH_PATTERN = /^[0-9a-f]{64}$/;
const SAFE_PART_FORBIDDEN_PATTERN = /[/\\:\s]/;
const AUTHORIZATION_ACTION = 'spans.dispatch';
const WRITER_AGENT = 'spans';
const ADMISSION_KINDS = new Set(['headless-run', 'session']);
const USAGE_CAPS = new Set(['enforced', 'estimated', 'unavailable']);
const ACTION_STATES = new Set(['completed', 'failed', 'intent', 'unknown']);
const TERMINAL_OUTCOMES = new Set(['completed', 'failed']);

// Adapter contract. Each entry lists the methods the coordinator calls.
export const SPANS_DISPATCH_ADAPTERS = Object.freeze({
  actions: Object.freeze(['prepareAction', 'recordOutcome']),
  admission: Object.freeze(['admit', 'release', 'status']),
  archive: Object.freeze(['capacity']),
  authorization: Object.freeze(['verify']),
  capabilities: Object.freeze(['verify']),
  checkout: Object.freeze(['observe']),
  dependencies: Object.freeze(['observe']),
  runState: Object.freeze(['read']),
  setup: Object.freeze(['ensure']),
  usage: Object.freeze(['release', 'reserve', 'settle']),
  worker: Object.freeze(['launch', 'verifyCompletion']),
  writer: Object.freeze(['check', 'claim', 'release']),
});

// Fixed text only. Adapter, store and request strings are never reflected.
const REFUSALS = {
  ACCEPTANCE_PENDING:
    'The completion was recorded and usage settled; the writer claim is kept until the span completion is accepted.',
  ACTION_CONFLICT: 'The action ID is already bound to different input.',
  ACTION_EXISTS:
    'The action already exists; it is returned, never launched again.',
  ACTION_NOT_FOUND: 'The action does not exist in this run.',
  ADAPTER_FAILED:
    'An adapter failed unexpectedly; any effect is unknown and resources were retained.',
  ADAPTER_MISSING:
    'A required adapter is missing; nothing was started or changed.',
  ADMISSION_REFUSED: 'Resource admission refused the launch.',
  ADMISSION_UNAVAILABLE: 'Resource admission could not be confirmed.',
  ARCHIVE_CAPACITY_BLOCKED:
    'The archive does not allow a new launch or its capacity is unknown.',
  AUTHORIZATION_MISMATCH:
    'The authorization is not bound to this exact dispatch.',
  AUTHORIZATION_MISSING: 'No verified authorization exists for this dispatch.',
  AUTHORIZATION_UNAVAILABLE: 'Authorization could not be checked.',
  CAPABILITY_MISSING: 'A required capability is not verified.',
  CAPABILITY_UNAVAILABLE: 'Capabilities could not be checked.',
  CAPACITY_WAIT:
    'Capacity is full; the dispatch waits without a launch or a retry attempt.',
  CHECKOUT_IDENTITY_CHANGED: 'The checkout identity changed.',
  CHECKOUT_UNKNOWN: 'The checkout could not be observed exactly.',
  COMPLETION_NOT_RECORDED:
    'The verified completion was not recorded; resources were retained.',
  COMPLETION_NOT_VERIFIED:
    'Completion is not verified for the owned worker; resources were retained.',
  DEPENDENCY_IDENTITY_CHANGED: 'The dependency identity changed.',
  DEPENDENCY_UNKNOWN: 'The dependency identity could not be observed exactly.',
  DIRTY_CHANGED: 'The working tree changed.',
  DISPATCH_IN_FLIGHT: 'This action is already being dispatched.',
  HEAD_CHANGED: 'The checkout HEAD changed.',
  INTENT_NOT_CONFIRMED:
    'The action intent was not confirmed; nothing was launched.',
  INTENT_REFUSED: 'The action intent was refused; nothing was launched.',
  LAUNCH_REFUSED: 'The worker refused before dispatch; nothing was launched.',
  LAUNCH_UNKNOWN:
    'The launch outcome is unknown; resources are held and nothing is resent.',
  LAUNCHED: 'The owned worker was dispatched; the work is not accepted.',
  LOCKFILE_CHANGED: 'The lockfile identity changed.',
  PLAN_CHANGED: 'The plan version is not the current plan version.',
  PROFILE_CHANGED: 'The model profile identity changed.',
  PROFILE_UNVERIFIED: 'The model profile identity is not verified.',
  RELEASE_INCOMPLETE:
    'The completion was recorded, but a resource could not be released.',
  RELEASED: 'The verified completion was recorded and resources released.',
  REQUEST_INVALID: 'The request does not use the expected format.',
  RUN_STATE_UNAVAILABLE: 'The run state could not be read.',
  SENSITIVE_VALUE: 'A value that looks like a secret was not accepted.',
  SETUP_FAILED: 'Setup failed; nothing was launched.',
  SETUP_IN_PROGRESS: 'Setup is already running for this checkout.',
  SETUP_NOT_READY: 'Setup has not completed; nothing was launched.',
  SETUP_UNKNOWN: 'The setup outcome is unknown; nothing was launched.',
  STALE_GENERATION: 'The coordinator generation is stale.',
  TARGET_DIGEST_MISMATCH:
    'The target digest does not match the expected checkout snapshot.',
  USAGE_CAP_NOT_ENFORCED: 'The usage cap is not enforced as required.',
  USAGE_UNAVAILABLE: 'A usage reservation could not be made.',
  WRITER_BUSY: 'Another owner holds the writer claim.',
  WRITER_LEASE_LOST: 'The writer lease is no longer held by this dispatch.',
  WRITER_TARGET_MISMATCH: 'The writer claim is for a different checkout.',
  WRITER_UNAVAILABLE: 'The writer claim could not be confirmed.',
};

export const SPANS_DISPATCH_CODES = Object.freeze(
  Object.fromEntries(Object.keys(REFUSALS).map((code) => [code, code]))
);

export const SPANS_DISPATCH_STATUSES = Object.freeze({
  duplicate: 'duplicate',
  held: 'held',
  launched: 'launched',
  recorded: 'recorded',
  refused: 'refused',
  released: 'released',
  wait: 'wait',
});

// Adapter-supplied codes are echoed only when they appear in these lists.
const ACTION_CAUSES = new Set([
  'CLOCK_INVALID',
  'COMMIT_FAILED',
  'DEPENDENCIES_INCOMPLETE',
  'DEPENDENCY_INPUT_INVALID',
  'RUN_READ_FAILED',
  'RUN_VIEW_INVALID',
  'SPAN_ACTION_OPEN',
  'SPAN_COMPLETED',
  'SPAN_NOT_FOUND',
  'STALE_REVISION',
]);
const ADMISSION_CAUSES = new Set([
  'ADMISSION_STATE_UNKNOWN',
  'ADMISSION_UNAVAILABLE',
  'INVALID_ADMISSION_REQUEST',
  'LEASE_OWNED_BY_ANOTHER',
  'LEASE_UNCERTAIN',
  'OPERATION_ID_CONFLICT',
  'OWNER_IDENTITY_UNKNOWN',
  'STORAGE_LOW',
  'STORAGE_UNKNOWN',
]);
const SETUP_CAUSES = new Set([
  'CHECKOUT_IDENTITY_MISMATCH',
  'DEPENDENCY_VIEW_UNKNOWN',
  'DEPENDENCY_VIEW_UNSAFE',
  'SETUP_ATTEMPT_INVALID',
  'SETUP_ATTEMPT_MISMATCH',
  'SETUP_COORDINATION_INVALID',
  'SETUP_PROGRESS_UNAVAILABLE',
]);
const USAGE_CAUSES = new Set([
  'BUDGET_EXCEEDED',
  'PRICE_UNKNOWN',
  'RESERVATION_CONFLICT',
  'USAGE_UNAVAILABLE',
]);
const WORKER_CAUSES = new Set([
  'CAPTURE_UNAVAILABLE',
  'FENCE_STALE',
  'PROFILE_UNSUPPORTED',
  'WORKER_REFUSED',
  'WORKER_UNAVAILABLE',
]);

// Dispatches in this process, so concurrent duplicates cannot both pass.
const IN_FLIGHT = new Set();

const isRecord = (value) =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const holdsSecret = (value) =>
  typeof value === 'string' && redactValue(value) !== value;

function hasControlCharacter(value) {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 32 || code === 127) {
      return true;
    }
  }
  return false;
}

function isExplicitId(value) {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= MAX_ID_LENGTH &&
    value.trim() === value &&
    value !== '__proto__' &&
    !hasControlCharacter(value)
  );
}

const isGeneration = (value) => Number.isSafeInteger(value) && value >= 0;

const isPlanVersion = (value) => isGeneration(value) || isExplicitId(value);

const isDigest = (value) =>
  typeof value === 'string' && DIGEST_PATTERN.test(value);

const bareDigest = (value) =>
  typeof value === 'string' && value.startsWith(DIGEST_PREFIX)
    ? value.slice(DIGEST_PREFIX.length)
    : value;

function isAbsolutePath(value) {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= MAX_PATH_LENGTH &&
    isAbsolute(value) &&
    !hasControlCharacter(value)
  );
}

// Mirrors the resource-admission target rules so a bad target refuses here.
function isSafePart(value) {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= MAX_ID_LENGTH &&
    !SAFE_PART_FORBIDDEN_PATTERN.test(value) &&
    !hasControlCharacter(value) &&
    value !== '.' &&
    value !== '..' &&
    !value.startsWith('-')
  );
}

function isTarget(value) {
  return (
    isRecord(value) &&
    isSafePart(value.repo) &&
    typeof value.name === 'string' &&
    value.name.split('/').every(isSafePart)
  );
}

// Bounded plain-JSON snapshot. Foreign data is only ever inspected through
// own property descriptors, so an accessor, a Proxy trap or an inherited
// getter is rejected without being invoked, and size limits apply before any
// property is read. Undefined record values are dropped like JSON does.
const REJECTED = Symbol('rejected');

function copyArray(value, depth, budget, ancestors) {
  if (Object.getPrototypeOf(value) !== Array.prototype) {
    return REJECTED;
  }
  const { length } = value;
  if (
    length > MAX_ARRAY_LENGTH ||
    Reflect.ownKeys(value).length !== length + 1
  ) {
    return REJECTED;
  }
  const copy = [];
  for (let index = 0; index < length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!(descriptor && 'value' in descriptor && descriptor.enumerable)) {
      return REJECTED;
    }
    const item = copyPlain(descriptor.value, depth + 1, budget, ancestors);
    if (item === REJECTED) {
      return REJECTED;
    }
    copy.push(item);
  }
  return copy;
}

function copyRecord(value, depth, budget, ancestors) {
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    return REJECTED;
  }
  const keys = Reflect.ownKeys(value);
  if (keys.length > MAX_KEYS) {
    return REJECTED;
  }
  const copy = {};
  for (const key of keys) {
    if (
      typeof key !== 'string' ||
      key.length > MAX_KEY_LENGTH ||
      key === '__proto__'
    ) {
      return REJECTED;
    }
    budget.characters += key.length;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!(descriptor && 'value' in descriptor && descriptor.enumerable)) {
      return REJECTED;
    }
    if (descriptor.value !== undefined) {
      const item = copyPlain(descriptor.value, depth + 1, budget, ancestors);
      if (item === REJECTED) {
        return REJECTED;
      }
      copy[key] = item;
    }
  }
  return copy;
}

function copyPlain(value, depth, budget, ancestors) {
  budget.nodes += 1;
  if (depth > MAX_DEPTH || budget.nodes > MAX_NODES) {
    return REJECTED;
  }
  if (value === null || typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : REJECTED;
  }
  if (typeof value === 'string') {
    budget.characters += value.length;
    return value.length <= MAX_STRING_LENGTH &&
      budget.characters <= MAX_TOTAL_CHARACTERS
      ? value
      : REJECTED;
  }
  if (
    typeof value !== 'object' ||
    types.isProxy(value) ||
    ancestors.has(value)
  ) {
    return REJECTED;
  }
  ancestors.add(value);
  const copy = Array.isArray(value)
    ? copyArray(value, depth, budget, ancestors)
    : copyRecord(value, depth, budget, ancestors);
  ancestors.delete(value);
  return budget.characters <= MAX_TOTAL_CHARACTERS ? copy : REJECTED;
}

function snapshotPlain(value) {
  const copy = copyPlain(value, 0, { characters: 0, nodes: 0 }, new Set());
  return copy === REJECTED ? { ok: false } : { ok: true, value: copy };
}

const isPlainData = (value) => snapshotPlain(value).ok;

function canonicalJson(value) {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(',')}]`;
  }
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .filter((key) => value[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

const sha256 = (text) => createHash('sha256').update(text).digest('hex');

function derivedId(prefix, ...parts) {
  return `${prefix}-${sha256(JSON.stringify([prefix, ...parts])).slice(0, 32)}`;
}

// One writer owner per span: a later attempt of the same span re-claims it,
// while another span or session stays blocked until a verified completion.
const writerSession = (request) =>
  derivedId('spans-writer', request.runId, request.spanId);

const admissionOperationId = (request) =>
  derivedId(
    'spans-adm',
    request.runId,
    request.spanId,
    request.attemptId,
    request.actionId
  );

const setupOperationId = (request) =>
  derivedId('spans-setup', request.runId, request.spanId);

// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------

function refusal(code, extra = {}) {
  return {
    code,
    effect: 'none',
    error: REFUSALS[code],
    launched: false,
    ok: false,
    status: SPANS_DISPATCH_STATUSES.refused,
    ...extra,
  };
}

function hold(code, extra = {}) {
  return refusal(code, {
    effect: 'unknown',
    retryAllowed: false,
    status: SPANS_DISPATCH_STATUSES.held,
    ...extra,
  });
}

function waitResult(reason) {
  return refusal('CAPACITY_WAIT', {
    reason,
    retryAllowed: true,
    retryAttemptCreated: false,
    status: SPANS_DISPATCH_STATUSES.wait,
  });
}

function duplicateResult(state) {
  const actionStatus = ACTION_STATES.has(state) ? state : 'unknown';
  return refusal('ACTION_EXISTS', {
    actionStatus,
    effect:
      actionStatus === 'completed' || actionStatus === 'failed'
        ? 'recorded'
        : 'unknown',
    retryAllowed: false,
    status: SPANS_DISPATCH_STATUSES.duplicate,
  });
}

function withCause(field, allowed, code) {
  return allowed.has(code) ? { [field]: code } : {};
}

async function callAdapter(work) {
  try {
    return { ok: true, value: await work() };
  } catch (error) {
    return { error, ok: false };
  }
}

const succeeded = (value) => isRecord(value) && value.ok === true;

// ---------------------------------------------------------------------------
// Request parsing
// ---------------------------------------------------------------------------

function invalid(field) {
  return refusal('REQUEST_INVALID', { field });
}

function parseCapabilities(value) {
  if (
    !(
      Array.isArray(value) &&
      value.length > 0 &&
      value.length <= MAX_CAPABILITIES &&
      value.every(isExplicitId)
    ) ||
    new Set(value).size !== value.length
  ) {
    return null;
  }
  return [...value].sort();
}

function isFingerprint(value) {
  return (
    isRecord(value) &&
    ['birthtimeNs', 'dev', 'ino'].every(
      (key) => typeof value[key] === 'string' && value[key].length > 0
    )
  );
}

function isIdentity(value) {
  return (
    isPlainData(value) &&
    isRecord(value) &&
    value.known === true &&
    ['admin', 'checkout', 'repository'].every((key) =>
      isFingerprint(value[key])
    ) &&
    ['adminPath', 'checkoutPath', 'repositoryPath'].every(
      (key) => typeof value[key] === 'string' && value[key].length > 0
    )
  );
}

function immutableIdentity(value) {
  const snapshot = snapshotPlain(value);
  if (!snapshot.ok) {
    return null;
  }
  const identity = snapshot.value;
  return Object.freeze({
    admin: Object.freeze({
      birthtimeNs: identity.admin.birthtimeNs,
      dev: identity.admin.dev,
      ino: identity.admin.ino,
    }),
    adminPath: identity.adminPath,
    checkout: Object.freeze({
      birthtimeNs: identity.checkout.birthtimeNs,
      dev: identity.checkout.dev,
      ino: identity.checkout.ino,
    }),
    checkoutPath: identity.checkoutPath,
    known: identity.known,
    repository: Object.freeze({
      birthtimeNs: identity.repository.birthtimeNs,
      dev: identity.repository.dev,
      ino: identity.repository.ino,
    }),
    repositoryPath: identity.repositoryPath,
  });
}

function isDirty(value) {
  return (
    isRecord(value) &&
    Number.isSafeInteger(value.count) &&
    value.count >= 0 &&
    typeof value.hash === 'string' &&
    HASH_PATTERN.test(value.hash)
  );
}

const DEPENDENCY_FIELDS = [
  'bunVersion',
  'linkerMode',
  'lockfileHash',
  'platformNamespace',
];

function pickDependency(value) {
  if (
    !(
      isRecord(value) &&
      DEPENDENCY_FIELDS.every(
        (key) => typeof value[key] === 'string' && value[key].length > 0
      )
    )
  ) {
    return null;
  }
  return Object.fromEntries(DEPENDENCY_FIELDS.map((key) => [key, value[key]]));
}

function parseExpected(value) {
  if (!isRecord(value)) {
    return null;
  }
  const dependency = pickDependency(value.dependency);
  if (
    !(
      isIdentity(value.identity) &&
      typeof value.head === 'string' &&
      HEAD_PATTERN.test(value.head) &&
      isDirty(value.dirty) &&
      dependency
    )
  ) {
    return null;
  }
  return {
    dependency,
    dirty: { count: value.dirty.count, hash: value.dirty.hash },
    head: value.head,
    identity: structuredClone(value.identity),
  };
}

// The digest the planner and the authorization must bind for a checkout: the
// SHA-256 of the canonical JSON of {dependency, dirty, head, identity}, where
// dependency holds only the four dependency identity fields. Null when the
// snapshot is not exact.
export function targetDigestFor(expected) {
  const copy = snapshotPlain(expected);
  const normalized = copy.ok ? parseExpected(copy.value) : null;
  return normalized ? sha256(canonicalJson(normalized)) : null;
}

function parseIds(input, names) {
  for (const name of names) {
    if (!isExplicitId(input[name])) {
      return invalid(name);
    }
  }
  if (!isGeneration(input.generation)) {
    return invalid('generation');
  }
  if (names.some((name) => holdsSecret(input[name]))) {
    return refusal('SENSITIVE_VALUE');
  }
  return null;
}

// Foreign input is copied into bounded plain data before any property is
// read; anything else is the same fixed refusal.
function parseInput(input, parse) {
  const copy = snapshotPlain(input);
  return copy.ok ? parse(copy.value) : invalid('request');
}

function parseDispatch(input) {
  if (!isRecord(input)) {
    return invalid('request');
  }
  const refused = parseIds(input, [
    'runId',
    'spanId',
    'actionId',
    'attemptId',
    'authorizationId',
    'profile',
  ]);
  if (refused) {
    return refused;
  }
  if (!isPlanVersion(input.planVersion)) {
    return invalid('planVersion');
  }
  if (holdsSecret(input.planVersion)) {
    return refusal('SENSITIVE_VALUE');
  }
  if (!isDigest(input.inputDigest)) {
    return invalid('inputDigest');
  }
  if (!isDigest(input.targetDigest)) {
    return invalid('targetDigest');
  }
  if (!ADMISSION_KINDS.has(input.admissionKind)) {
    return invalid('admissionKind');
  }
  const requiredCapabilities = parseCapabilities(input.requiredCapabilities);
  if (!requiredCapabilities) {
    return invalid('requiredCapabilities');
  }
  if (
    input.requireEnforcedCap !== undefined &&
    typeof input.requireEnforcedCap !== 'boolean'
  ) {
    return invalid('requireEnforcedCap');
  }
  if (!isTarget(input.target)) {
    return invalid('target');
  }
  const { checkout } = input;
  if (
    !(
      isRecord(checkout) &&
      isAbsolutePath(checkout.wtDir) &&
      isAbsolutePath(checkout.repoDir)
    )
  ) {
    return invalid('checkout');
  }
  const expected = parseExpected(checkout.expected);
  if (!expected) {
    return invalid('checkout.expected');
  }
  if (
    [...requiredCapabilities, input.target.repo, input.target.name].some(
      holdsSecret
    )
  ) {
    return refusal('SENSITIVE_VALUE');
  }
  return {
    actionId: input.actionId,
    admissionKind: input.admissionKind,
    attemptId: input.attemptId,
    authorizationId: input.authorizationId,
    expected,
    generation: input.generation,
    inputDigest: bareDigest(input.inputDigest),
    ok: true,
    planVersion: input.planVersion,
    profile: input.profile,
    repoDir: checkout.repoDir,
    requiredCapabilities,
    requireEnforcedCap: input.requireEnforcedCap === true,
    runId: input.runId,
    spanId: input.spanId,
    target: { name: input.target.name, repo: input.target.repo },
    targetDigest: bareDigest(input.targetDigest),
    wtDir: checkout.wtDir,
  };
}

function parseCompletion(input) {
  if (!isRecord(input)) {
    return invalid('request');
  }
  const refused = parseIds(input, [
    'runId',
    'spanId',
    'actionId',
    'attemptId',
    'workerId',
  ]);
  if (refused) {
    return refused;
  }
  // The checkout is attested by the durable worker receipt. A caller path is
  // only an optional claim that must match it, never a release target.
  if (input.wtDir !== undefined && !isAbsolutePath(input.wtDir)) {
    return invalid('wtDir');
  }
  return {
    actionId: input.actionId,
    attemptId: input.attemptId,
    generation: input.generation,
    ok: true,
    runId: input.runId,
    spanId: input.spanId,
    workerId: input.workerId,
    wtDir: input.wtDir ?? null,
  };
}

// ---------------------------------------------------------------------------
// Adapter validation
// ---------------------------------------------------------------------------

function missingAdapters(adapters) {
  const missing = [];
  for (const [name, methods] of Object.entries(SPANS_DISPATCH_ADAPTERS)) {
    const adapter = isRecord(adapters) ? adapters[name] : undefined;
    for (const method of methods) {
      if (
        !(
          adapter !== null &&
          typeof adapter === 'object' &&
          typeof adapter[method] === 'function'
        )
      ) {
        missing.push(`${name}.${method}`);
      }
    }
  }
  return missing;
}

// Every normalized field that decides what runs and where. The profile digest
// is the immutable profile identity a trusted adapter reported, never a
// request field, so an approval for one profile or cap policy cannot be
// replayed for another.
function authorizationBinding(request, profileDigest) {
  return {
    action: AUTHORIZATION_ACTION,
    actionId: request.actionId,
    admissionKind: request.admissionKind,
    attemptId: request.attemptId,
    generation: request.generation,
    inputDigest: request.inputDigest,
    planVersion: request.planVersion,
    profile: request.profile,
    profileDigest,
    repoDir: request.repoDir,
    requiredCapabilities: [...request.requiredCapabilities],
    requireEnforcedCap: request.requireEnforcedCap,
    runId: request.runId,
    spanId: request.spanId,
    targetDigest: request.targetDigest,
    targetName: request.target.name,
    targetRepo: request.target.repo,
    wtDir: request.wtDir,
  };
}

const DIGEST_BINDINGS = new Set([
  'inputDigest',
  'profileDigest',
  'targetDigest',
]);

function sameBinding(receipt, binding) {
  const echoed = snapshotPlain(receipt);
  return (
    echoed.ok &&
    isRecord(echoed.value) &&
    Object.entries(binding).every(
      ([key, value]) =>
        canonicalJson(
          DIGEST_BINDINGS.has(key)
            ? bareDigest(echoed.value[key])
            : echoed.value[key]
        ) === canonicalJson(value)
    )
  );
}

function actionBound(action, request) {
  return (
    action.spanId === request.spanId &&
    action.attemptId === request.attemptId &&
    action.planVersion === request.planVersion &&
    bareDigest(action.inputDigest) === request.inputDigest &&
    bareDigest(action.targetDigest) === request.targetDigest
  );
}

function sameFence(echoed, fence) {
  const copy = snapshotPlain(echoed);
  return copy.ok && canonicalJson(copy.value) === canonicalJson(fence);
}

const newContext = () => ({
  admission: { lease: null, owned: false, state: 'none' },
  binding: null,
  profileDigest: null,
  usage: { owned: false, state: 'none' },
  writer: 'none',
});

const snapshot = (ctx) => ({
  admission: ctx.admission.state,
  usage: ctx.usage.state,
  writer: ctx.writer,
});

export function createSpansDispatch({ adapters } = {}) {
  // The adapters are validated on every call: a late-removed method must
  // still fail closed, and construction never throws.
  const missing = () => {
    try {
      return missingAdapters(adapters);
    } catch {
      return ['adapters'];
    }
  };

  // -------------------------------------------------------------------------
  // Bindings, rechecked before every effect
  // -------------------------------------------------------------------------

  // Resolves the model profile identity and the required capabilities
  // together, on every pass, so a capability or profile change during any
  // awaited step is caught. The first digest is the only one accepted.
  async function checkProfile(request, ctx) {
    const checked = await callAdapter(() =>
      adapters.capabilities.verify({
        attemptId: request.attemptId,
        profile: request.profile,
        required: [...request.requiredCapabilities],
        runId: request.runId,
        spanId: request.spanId,
      })
    );
    const { value } = checked;
    if (
      !(
        checked.ok &&
        succeeded(value) &&
        Array.isArray(value.verified) &&
        value.verified.every((id) => typeof id === 'string')
      )
    ) {
      return refusal('CAPABILITY_UNAVAILABLE');
    }
    const { profile } = value;
    if (
      !(
        isRecord(profile) &&
        profile.id === request.profile &&
        isDigest(profile.digest)
      )
    ) {
      return refusal('PROFILE_UNVERIFIED');
    }
    const digest = bareDigest(profile.digest);
    if (ctx.profileDigest !== null && ctx.profileDigest !== digest) {
      return refusal('PROFILE_CHANGED');
    }
    const verified = new Set(value.verified);
    const absent = request.requiredCapabilities.filter(
      (id) => !verified.has(id)
    );
    if (absent.length > 0) {
      return refusal('CAPABILITY_MISSING', { missingCapabilities: absent });
    }
    ctx.profileDigest = digest;
    return null;
  }

  async function authorize(request, ctx) {
    const binding = authorizationBinding(request, ctx.profileDigest);
    ctx.binding = binding;
    const checked = await callAdapter(() =>
      adapters.authorization.verify({
        authorizationId: request.authorizationId,
        binding: structuredClone(binding),
      })
    );
    if (!checked.ok) {
      return refusal('AUTHORIZATION_UNAVAILABLE');
    }
    const receipt = checked.value;
    if (!(succeeded(receipt) && receipt.verified === true)) {
      return refusal('AUTHORIZATION_MISSING');
    }
    if (
      receipt.authorizationId !== request.authorizationId ||
      !sameBinding(receipt.binding, binding)
    ) {
      return refusal('AUTHORIZATION_MISMATCH');
    }
    return null;
  }

  // One fenced read of the run view: `state` when the generation is current,
  // otherwise the refusal.
  async function readRunState(request) {
    const read = await callAdapter(() =>
      adapters.runState.read({
        actionId: request.actionId,
        runId: request.runId,
      })
    );
    const state = read.ok ? read.value : null;
    if (!(succeeded(state) && isGeneration(state.generation))) {
      return { refused: refusal('RUN_STATE_UNAVAILABLE') };
    }
    if (state.generation !== request.generation) {
      return { refused: refusal('STALE_GENERATION') };
    }
    return { refused: null, state };
  }

  // `expect` is 'absent' before the intent exists and 'intent' after it.
  async function checkRunState(request, expect) {
    const read = await readRunState(request);
    if (read.refused) {
      return read.refused;
    }
    const { state } = read;
    if (state.planVersion !== request.planVersion) {
      return refusal('PLAN_CHANGED');
    }
    const action = state.action ?? null;
    if (action !== null && !isRecord(action)) {
      return refusal('RUN_STATE_UNAVAILABLE');
    }
    if (action === null) {
      return expect === 'absent' ? null : refusal('INTENT_NOT_CONFIRMED');
    }
    if (!actionBound(action, request)) {
      return refusal('ACTION_CONFLICT');
    }
    return expect === 'intent' && action.state === 'intent'
      ? null
      : duplicateResult(action.state);
  }

  async function checkArchive() {
    const checked = await callAdapter(() => adapters.archive.capacity());
    return succeeded(checked.value) && checked.value.newLaunchAllowed === true
      ? null
      : refusal('ARCHIVE_CAPACITY_BLOCKED');
  }

  async function checkCheckout(request) {
    const target = { repoDir: request.repoDir, wtDir: request.wtDir };
    const observedCheckout = await callAdapter(() =>
      adapters.checkout.observe({ ...target })
    );
    const checkout = observedCheckout.ok ? observedCheckout.value : null;
    if (
      !(
        succeeded(checkout) &&
        isIdentity(checkout.identity) &&
        typeof checkout.head === 'string' &&
        HEAD_PATTERN.test(checkout.head) &&
        isDirty(checkout.dirty)
      )
    ) {
      return refusal('CHECKOUT_UNKNOWN');
    }
    const observedDependencies = await callAdapter(() =>
      adapters.dependencies.observe({ ...target })
    );
    const dependency = succeeded(observedDependencies.value)
      ? pickDependency(observedDependencies.value.identity)
      : null;
    if (!dependency) {
      return refusal('DEPENDENCY_UNKNOWN');
    }
    const { expected } = request;
    if (canonicalJson(checkout.identity) !== canonicalJson(expected.identity)) {
      return refusal('CHECKOUT_IDENTITY_CHANGED');
    }
    if (checkout.head !== expected.head) {
      return refusal('HEAD_CHANGED');
    }
    if (dependency.lockfileHash !== expected.dependency.lockfileHash) {
      return refusal('LOCKFILE_CHANGED');
    }
    if (canonicalJson(dependency) !== canonicalJson(expected.dependency)) {
      return refusal('DEPENDENCY_IDENTITY_CHANGED');
    }
    if (
      checkout.dirty.count !== expected.dirty.count ||
      checkout.dirty.hash !== expected.dirty.hash
    ) {
      return refusal('DIRTY_CHANGED');
    }
    return null;
  }

  async function checkWriter(request) {
    const checked = await callAdapter(() =>
      adapters.writer.check({
        checkoutPath: request.wtDir,
        session: writerSession(request),
      })
    );
    if (!checked.ok) {
      return refusal('WRITER_UNAVAILABLE');
    }
    const { value } = checked;
    // A missing claim also reports ok, so the exact owner must be present.
    return succeeded(value) &&
      isRecord(value.claim) &&
      value.claim.session === writerSession(request) &&
      value.wtDir === request.expected.identity.checkoutPath
      ? null
      : refusal('WRITER_LEASE_LOST');
  }

  // The run state is read early so a duplicate or conflict answers before any
  // other check. With `fence`, it is read again as the last awaited step, so
  // a generation that moves during the archive, checkout or writer checks is
  // still seen before the effect.
  async function verifyBindings(
    request,
    ctx,
    { expect, fence = false, writer }
  ) {
    return (
      (await checkProfile(request, ctx)) ??
      (await authorize(request, ctx)) ??
      (await checkRunState(request, expect)) ??
      (await checkArchive()) ??
      (await checkCheckout(request)) ??
      (writer ? await checkWriter(request) : null) ??
      (fence ? await checkRunState(request, expect) : null)
    );
  }

  // -------------------------------------------------------------------------
  // Steps before the effect
  // -------------------------------------------------------------------------

  async function acquireWriter(request, ctx) {
    const session = writerSession(request);
    const claimed = await callAdapter(() =>
      adapters.writer.claim({
        checkoutPath: request.wtDir,
        owner: {
          agent: WRITER_AGENT,
          session,
          task: `Spans dispatch ${session}`,
        },
      })
    );
    const { value } = claimed;
    if (claimed.ok && isRecord(value) && value.ok === false) {
      return refusal(
        value.code === 'WRITER_BUSY' ? 'WRITER_BUSY' : 'WRITER_UNAVAILABLE'
      );
    }
    if (!(claimed.ok && succeeded(value) && value.claim?.session === session)) {
      // A thrown or malformed answer may still have written the claim.
      ctx.writer = 'unknown';
      return refusal('WRITER_UNAVAILABLE');
    }
    ctx.writer = 'held';
    return value.wtDir === request.expected.identity.checkoutPath
      ? null
      : refusal('WRITER_TARGET_MISMATCH');
  }

  function setupFailure(code) {
    if (code === 'OPERATION_UNKNOWN') {
      return hold('SETUP_UNKNOWN', { effect: 'none' });
    }
    if (code === 'SETUP_ALREADY_RUNNING') {
      return refusal('SETUP_IN_PROGRESS');
    }
    return refusal('SETUP_FAILED', withCause('setupCode', SETUP_CAUSES, code));
  }

  // Setup must be complete when this returns; an accepted request is not.
  async function ensureSetup(request) {
    const done = await callAdapter(() =>
      adapters.setup.ensure({
        checkoutIdentity: structuredClone(request.expected.identity),
        operationId: setupOperationId(request),
        repoDir: request.repoDir,
        session: writerSession(request),
        target: { ...request.target },
        wtDir: request.wtDir,
      })
    );
    if (!done.ok) {
      // biome-ignore lint/suspicious/noUnnecessaryConditions: Injected adapters may reject with null or undefined.
      return setupFailure(done.error?.code);
    }
    const { value } = done;
    if (succeeded(value)) {
      return value.state === 'ready' ? null : refusal('SETUP_NOT_READY');
    }
    return setupFailure(isRecord(value) ? value.code : undefined);
  }

  async function admit(request, ctx) {
    const operationId = admissionOperationId(request);
    const admitted = await callAdapter(() =>
      adapters.admission.admit({
        kind: request.admissionKind,
        operationId,
        target: { ...request.target },
      })
    );
    const { value } = admitted;
    if (admitted.ok && succeeded(value)) {
      if (isRecord(value.lease) && value.lease.operationId === operationId) {
        ctx.admission = {
          lease: value.lease,
          owned: value.existing !== true,
          state: 'held',
        };
        return null;
      }
      ctx.admission.state = 'unknown';
      return refusal('ADMISSION_UNAVAILABLE');
    }
    if (!(admitted.ok && isRecord(value))) {
      ctx.admission.state = 'unknown';
      return refusal('ADMISSION_UNAVAILABLE');
    }
    if (value.code === 'SESSION_CAPACITY_REACHED') {
      return waitResult('session-capacity');
    }
    if (value.code === 'INSTALL_IN_PROGRESS') {
      return waitResult('install-lane');
    }
    return refusal(
      'ADMISSION_REFUSED',
      withCause('admissionCode', ADMISSION_CAUSES, value.code)
    );
  }

  async function reserveUsage(request, ctx) {
    const reserved = await callAdapter(() =>
      adapters.usage.reserve({
        actionId: request.actionId,
        attemptId: request.attemptId,
        operationId: admissionOperationId(request),
        profile: request.profile,
        profileDigest: ctx.profileDigest,
        runId: request.runId,
        spanId: request.spanId,
      })
    );
    const { value } = reserved;
    if (reserved.ok && isRecord(value) && value.ok === false) {
      return refusal(
        'USAGE_UNAVAILABLE',
        withCause('usageCode', USAGE_CAUSES, value.code)
      );
    }
    if (
      !(
        reserved.ok &&
        succeeded(value) &&
        isExplicitId(value.reservationId) &&
        !holdsSecret(value.reservationId) &&
        USAGE_CAPS.has(value.cap)
      )
    ) {
      ctx.usage.state = 'unknown';
      return refusal('USAGE_UNAVAILABLE');
    }
    ctx.usage = {
      cap: value.cap,
      owned: value.existing !== true,
      reservationId: value.reservationId,
      state: 'held',
    };
    return request.requireEnforcedCap && value.cap !== 'enforced'
      ? refusal('USAGE_CAP_NOT_ENFORCED')
      : null;
  }

  // Only resources this call created are released, and only when the worker
  // was definitely never dispatched. A pre-existing or unknown holding stays.
  async function releaseUnlaunched(request, ctx) {
    if (ctx.usage.state === 'held' && ctx.usage.owned) {
      const released = await callAdapter(() =>
        adapters.usage.release({
          actionId: request.actionId,
          attemptId: request.attemptId,
          reason: 'unlaunched',
          runId: request.runId,
          spanId: request.spanId,
        })
      );
      ctx.usage.state = succeeded(released.value)
        ? 'released'
        : 'release-failed';
    }
    if (ctx.admission.state === 'held' && ctx.admission.owned) {
      const released = await callAdapter(() =>
        adapters.admission.release(ctx.admission.lease)
      );
      ctx.admission.state = succeeded(released.value)
        ? 'released'
        : 'release-failed';
    }
  }

  // A duplicate's resources belong to the dispatch that won the intent, and an
  // unconfirmed intent may be durable, so neither releases anything.
  async function fail(request, ctx, result) {
    if (
      result.status !== SPANS_DISPATCH_STATUSES.duplicate &&
      result.code !== 'INTENT_NOT_CONFIRMED'
    ) {
      await releaseUnlaunched(request, ctx);
    }
    return { ...result, resources: snapshot(ctx) };
  }

  // Once an intent is durable, resources are freed only if the action is
  // durably marked failed. Otherwise the unresolved intent keeps them held.
  async function failAfterIntent(request, ctx, result) {
    const outcomeRecorded = await recordOutcome(request, 'failed');
    const marked = { ...result, outcomeRecorded };
    return outcomeRecorded
      ? fail(request, ctx, marked)
      : { ...marked, resources: snapshot(ctx) };
  }

  async function recordOutcome(request, outcome, extra = {}) {
    const recorded = await callAdapter(() =>
      adapters.actions.recordOutcome({
        actionId: request.actionId,
        artifactIds: [],
        generation: request.generation,
        outcome,
        runId: request.runId,
        ...extra,
      })
    );
    return recorded.ok && succeeded(recorded.value);
  }

  async function recordIntent(request) {
    const prepared = await callAdapter(() =>
      adapters.actions.prepareAction({
        actionId: request.actionId,
        attemptId: request.attemptId,
        generation: request.generation,
        inputDigest: request.inputDigest,
        planVersion: request.planVersion,
        runId: request.runId,
        spanId: request.spanId,
        targetDigest: request.targetDigest,
      })
    );
    const { value } = prepared;
    if (!(prepared.ok && isRecord(value))) {
      return refusal('INTENT_NOT_CONFIRMED');
    }
    if (value.ok === true) {
      return value.created === true && value.status === 'intent'
        ? null
        : duplicateResult(value.status);
    }
    if (
      value.code === 'STALE_GENERATION' ||
      value.code === 'PLAN_CHANGED' ||
      value.code === 'ACTION_CONFLICT'
    ) {
      return refusal(value.code);
    }
    if (value.code === 'COMMIT_FAILED') {
      return refusal('INTENT_NOT_CONFIRMED');
    }
    return refusal(
      'INTENT_REFUSED',
      withCause('actionCode', ACTION_CAUSES, value.code)
    );
  }

  // -------------------------------------------------------------------------
  // The effect
  // -------------------------------------------------------------------------

  // The worker gets the exact binding that was just verified and a fence it
  // must re-check at its own effect boundary. A dispatch receipt that does not
  // echo the fence is not trusted as launched.
  async function launchWorker(request, ctx) {
    const binding = structuredClone(ctx.binding);
    const fence = {
      actionId: request.actionId,
      bindingDigest: sha256(canonicalJson(binding)),
      generation: request.generation,
      planVersion: request.planVersion,
      runId: request.runId,
      spanId: request.spanId,
      writerSession: writerSession(request),
    };
    const launched = await callAdapter(() =>
      adapters.worker.launch({
        actionId: request.actionId,
        admission: { operationId: admissionOperationId(request) },
        attemptId: request.attemptId,
        binding,
        fence: { ...fence },
        generation: request.generation,
        inputDigest: request.inputDigest,
        planVersion: request.planVersion,
        profile: request.profile,
        profileDigest: ctx.profileDigest,
        repoDir: request.repoDir,
        runId: request.runId,
        spanId: request.spanId,
        targetDigest: request.targetDigest,
        usage: { reservationId: ctx.usage.reservationId },
        writerSession: writerSession(request),
        wtDir: request.wtDir,
      })
    );
    const { value } = launched;
    if (
      launched.ok &&
      succeeded(value) &&
      value.dispatched === true &&
      isExplicitId(value.workerId) &&
      !holdsSecret(value.workerId) &&
      sameFence(value.fence, fence)
    ) {
      return {
        accepted: false,
        actionId: request.actionId,
        attemptId: request.attemptId,
        code: 'LAUNCHED',
        effect: 'launched',
        launched: true,
        ok: true,
        resources: snapshot(ctx),
        status: SPANS_DISPATCH_STATUSES.launched,
        workerId: value.workerId,
      };
    }
    // Only an explicit pre-dispatch refusal is a known non-launch. A throw, a
    // timeout, a missing flag or a half-formed receipt may have launched.
    if (launched.ok && isRecord(value) && value.dispatched === false) {
      return failAfterIntent(
        request,
        ctx,
        refusal(
          'LAUNCH_REFUSED',
          withCause('workerCode', WORKER_CAUSES, value.code)
        )
      );
    }
    const holdRecorded = await recordOutcome(request, 'unknown');
    return {
      ...hold('LAUNCH_UNKNOWN', { holdRecorded }),
      resources: snapshot(ctx),
    };
  }

  async function runDispatch(request, ctx) {
    const refused = await verifyBindings(request, ctx, {
      expect: 'absent',
      writer: false,
    });
    if (refused) {
      return { ...refused, resources: snapshot(ctx) };
    }

    // The writer lease comes first and is never released by a failure here.
    const stepped =
      (await acquireWriter(request, ctx)) ?? (await ensureSetup(request));
    if (stepped) {
      return { ...stepped, resources: snapshot(ctx) };
    }
    const admission = await admit(request, ctx);
    if (admission) {
      return fail(request, ctx, admission);
    }

    // Setup and admission were awaited; nothing earlier is trusted now.
    const absent = { expect: 'absent', writer: true };
    const recheck =
      (await verifyBindings(request, ctx, absent)) ??
      (await reserveUsage(request, ctx)) ??
      (await verifyBindings(request, ctx, absent)) ??
      (await recordIntent(request));
    if (recheck) {
      return fail(request, ctx, recheck);
    }

    // The fenced pass ends with the run state, and only synchronous code
    // separates it from the worker call.
    const final = await verifyBindings(request, ctx, {
      expect: 'intent',
      fence: true,
      writer: true,
    });
    if (final) {
      // The intent is durable but the worker was never called.
      return final.status === SPANS_DISPATCH_STATUSES.duplicate
        ? fail(request, ctx, final)
        : failAfterIntent(request, ctx, final);
    }
    return launchWorker(request, ctx);
  }

  // An unexpected adapter fault (for example a throwing accessor on a result)
  // never escapes. With nothing yet touched it is a plain refusal; otherwise
  // the effect is unknown and everything stays held.
  async function dispatchGuarded(request) {
    const ctx = newContext();
    try {
      return await runDispatch(request, ctx);
    } catch {
      const resources = snapshot(ctx);
      const touched = Object.values(resources).some(
        (state) => state !== 'none'
      );
      return {
        ...(touched ? hold('ADAPTER_FAILED') : refusal('ADAPTER_FAILED')),
        resources,
      };
    }
  }

  async function dispatch(input) {
    const absent = missing();
    if (absent.length > 0) {
      return refusal('ADAPTER_MISSING', { missing: absent });
    }
    const request = parseInput(input, parseDispatch);
    if (!request.ok) {
      return request;
    }
    if (targetDigestFor(request.expected) !== request.targetDigest) {
      return refusal('TARGET_DIGEST_MISMATCH');
    }
    const key = JSON.stringify([request.runId, request.actionId]);
    if (IN_FLIGHT.has(key)) {
      return refusal('DISPATCH_IN_FLIGHT');
    }
    IN_FLIGHT.add(key);
    try {
      return await dispatchGuarded(request);
    } finally {
      IN_FLIGHT.delete(key);
    }
  }

  // -------------------------------------------------------------------------
  // Verified completion and release
  // -------------------------------------------------------------------------

  // The receipt is the durable record the owned-worker adapter returns for
  // these exact references. It must name the run, span, action, attempt,
  // worker, generation, plan, digests, writer owner and the full checkout
  // identity, and each must match the committed action. A process exit or any
  // request field is never consulted, and the checkout it attests is the only
  // one a release may touch.
  async function verifyCompletion(request, action) {
    const checked = await callAdapter(() =>
      adapters.worker.verifyCompletion({
        actionId: request.actionId,
        attemptId: request.attemptId,
        generation: request.generation,
        runId: request.runId,
        spanId: request.spanId,
        workerId: request.workerId,
      })
    );
    const { value } = checked;
    const artifactIds = isRecord(value) ? (value.artifactIds ?? []) : [];
    if (
      !(
        checked.ok &&
        succeeded(value) &&
        value.verified === true &&
        value.terminal === true &&
        TERMINAL_OUTCOMES.has(value.outcome) &&
        ['actionId', 'attemptId', 'runId', 'spanId', 'workerId'].every(
          (key) => value[key] === request[key]
        ) &&
        value.generation === request.generation &&
        isPlanVersion(value.planVersion) &&
        value.planVersion === action.planVersion &&
        isDigest(value.inputDigest) &&
        bareDigest(value.inputDigest) === bareDigest(action.inputDigest) &&
        isDigest(value.targetDigest) &&
        bareDigest(value.targetDigest) === bareDigest(action.targetDigest) &&
        value.writerSession === writerSession(request) &&
        isIdentity(value.checkoutIdentity) &&
        (request.wtDir === null ||
          request.wtDir === value.checkoutIdentity.checkoutPath) &&
        isExplicitId(value.evidenceId) &&
        !holdsSecret(value.evidenceId) &&
        Array.isArray(artifactIds) &&
        artifactIds.length <= MAX_ARTIFACTS &&
        artifactIds.every((id) => isExplicitId(id) && !holdsSecret(id)) &&
        new Set(artifactIds).size === artifactIds.length
      )
    ) {
      return null;
    }
    const checkoutIdentity = immutableIdentity(value.checkoutIdentity);
    if (!checkoutIdentity) {
      return null;
    }
    return {
      artifactIds: [...artifactIds],
      checkoutIdentity,
      checkoutPath: value.checkoutIdentity.checkoutPath,
      evidenceId: value.evidenceId,
      outcome: value.outcome,
    };
  }

  async function releaseAdmission(request) {
    const operationId = admissionOperationId(request);
    const status = await callAdapter(() => adapters.admission.status());
    if (!(succeeded(status.value) && Array.isArray(status.value.leases))) {
      return 'failed';
    }
    const lease = status.value.leases.find(
      (candidate) =>
        isRecord(candidate) && candidate.operationId === operationId
    );
    if (!lease) {
      return 'absent';
    }
    const released = await callAdapter(() => adapters.admission.release(lease));
    if (succeeded(released.value)) {
      return 'released';
    }
    return isRecord(released.value) && released.value.code === 'LEASE_NOT_FOUND'
      ? 'absent'
      : 'failed';
  }

  // Usage and admission settle on the verified terminal outcome alone.
  async function settleResources(request, receipt) {
    const settled = await callAdapter(() =>
      adapters.usage.settle({
        actionId: request.actionId,
        attemptId: request.attemptId,
        evidenceId: receipt.evidenceId,
        outcome: receipt.outcome,
        runId: request.runId,
        spanId: request.spanId,
      })
    );
    return {
      admission: await releaseAdmission(request),
      usage: succeeded(settled.value) ? 'released' : 'failed',
    };
  }

  // The writer claim guards a tree that is not yet accepted, so only the
  // committed span acceptance releases it: the action layer's acceptance of
  // this exact action, with its evidence reference, is the authority. This
  // reads the run view fresh, after the settlement awaits, so a generation that
  // moved meanwhile stops the release.
  async function readAcceptance(request, expectedEvidenceId = null) {
    const read = await readRunState(request);
    if (read.refused) {
      return { code: read.refused.code };
    }
    const { action, span } = read.state;
    const accepted =
      isRecord(action) &&
      action.actionId === request.actionId &&
      action.attemptId === request.attemptId &&
      action.spanId === request.spanId &&
      action.state === 'completed' &&
      isRecord(span) &&
      span.state === 'completed' &&
      span.acceptedActionId === request.actionId &&
      isExplicitId(span.acceptedEvidenceId) &&
      (expectedEvidenceId === null ||
        span.acceptedEvidenceId === expectedEvidenceId) &&
      !holdsSecret(span.acceptedEvidenceId);
    return accepted
      ? { accepted: true, evidenceId: span.acceptedEvidenceId }
      : { accepted: false };
  }

  // Only the claim of this run and span on the checkout the worker receipt
  // attests is released. An absent claim is an idempotent repeat; a claim held
  // by anyone else, or on a different checkout, is never touched.
  async function releaseWriter(request, receipt, acceptedEvidenceId) {
    const session = writerSession(request);
    const checked = await callAdapter(() =>
      adapters.writer.check({ checkoutPath: receipt.checkoutPath, session })
    );
    // The claim check is an await, so validate that the same acceptance is
    // still current before interpreting the claim or attempting its release.
    const currentAcceptance = await readAcceptance(request, acceptedEvidenceId);
    if (currentAcceptance.code) {
      return currentAcceptance.code;
    }
    if (
      !currentAcceptance.accepted ||
      currentAcceptance.evidenceId !== acceptedEvidenceId
    ) {
      return 'ACCEPTANCE_PENDING';
    }
    const { value } = checked;
    if (!(checked.ok && isRecord(value) && value.ok === true)) {
      return 'failed';
    }
    if (value.claim === null || value.claim === undefined) {
      return 'absent';
    }
    if (
      !(
        isRecord(value.claim) &&
        value.claim.session === session &&
        value.wtDir === receipt.checkoutPath
      )
    ) {
      return 'failed';
    }
    const binding = Object.freeze({
      acceptedEvidenceId,
      actionId: request.actionId,
      attemptId: request.attemptId,
      checkoutIdentity: receipt.checkoutIdentity,
      completionEvidenceId: receipt.evidenceId,
      generation: request.generation,
      runId: request.runId,
      spanId: request.spanId,
    });
    // A trusted writer adapter must validate this fence at its release
    // effect boundary; this fresh read alone cannot make check and release
    // atomic.
    const released = await callAdapter(() =>
      adapters.writer.release({
        binding,
        checkoutPath: receipt.checkoutPath,
        session,
      })
    );
    return succeeded(released.value) ? 'released' : 'failed';
  }

  async function finishCompletion(request, receipt, resources) {
    const acceptance = await readAcceptance(request);
    const base = {
      accepted: acceptance.accepted === true,
      actionId: request.actionId,
      outcome: receipt.outcome,
      outcomeRecorded: true,
      resources,
    };
    if (acceptance.code) {
      return {
        ...base,
        ...hold(acceptance.code, { effect: 'recorded' }),
        launched: true,
      };
    }
    if (acceptance.accepted) {
      const writer = await releaseWriter(
        request,
        receipt,
        acceptance.evidenceId
      );
      if (writer === 'STALE_GENERATION' || writer === 'RUN_STATE_UNAVAILABLE') {
        return {
          ...base,
          accepted: false,
          ...hold(writer, { effect: 'recorded' }),
          launched: true,
        };
      }
      if (writer === 'ACCEPTANCE_PENDING') {
        return {
          ...base,
          accepted: false,
          code: writer,
          effect: 'recorded',
          launched: true,
          ok: true,
          status: SPANS_DISPATCH_STATUSES.recorded,
        };
      }
      resources.writer = writer;
      base.acceptedEvidenceId = acceptance.evidenceId;
    }
    if (Object.values(resources).includes('failed')) {
      return {
        ...base,
        ...hold('RELEASE_INCOMPLETE', { effect: 'recorded' }),
        launched: true,
      };
    }
    return {
      ...base,
      code: acceptance.accepted ? 'RELEASED' : 'ACCEPTANCE_PENDING',
      effect: 'recorded',
      launched: true,
      ok: true,
      status: acceptance.accepted
        ? SPANS_DISPATCH_STATUSES.released
        : SPANS_DISPATCH_STATUSES.recorded,
    };
  }

  async function completeGuarded(request) {
    const read = await readRunState(request);
    if (read.refused) {
      return read.refused;
    }
    const action = read.state.action ?? null;
    if (!isRecord(action)) {
      return refusal('ACTION_NOT_FOUND');
    }
    if (
      action.attemptId !== request.attemptId ||
      action.spanId !== request.spanId ||
      !ACTION_STATES.has(action.state)
    ) {
      return refusal('ACTION_CONFLICT');
    }

    const receipt = await verifyCompletion(request, action);
    if (!receipt) {
      return hold('COMPLETION_NOT_VERIFIED', { effect: 'unknown' });
    }
    const recorded = await recordOutcome(request, receipt.outcome, {
      artifactIds: receipt.artifactIds,
      evidence: {
        evidenceId: receipt.evidenceId,
        source: 'owned-worker-completion',
        workerId: request.workerId,
      },
    });
    if (!recorded) {
      return hold('COMPLETION_NOT_RECORDED', { effect: 'unknown' });
    }
    const resources = {
      ...(await settleResources(request, receipt)),
      writer: 'held',
    };
    return finishCompletion(request, receipt, resources);
  }

  // Usage and admission settle only here, and only for a verified terminal
  // outcome of the exact owned worker. Recording it is not span acceptance: the
  // writer claim stays until the committed run view shows the acceptance.
  async function completeOwned(input) {
    const absent = missing();
    if (absent.length > 0) {
      return refusal('ADAPTER_MISSING', { missing: absent });
    }
    const request = parseInput(input, parseCompletion);
    if (!request.ok) {
      return request;
    }
    const key = JSON.stringify([request.runId, request.actionId]);
    if (IN_FLIGHT.has(key)) {
      return refusal('DISPATCH_IN_FLIGHT');
    }
    IN_FLIGHT.add(key);
    try {
      return await completeGuarded(request);
    } catch {
      // Whatever ran before the fault is unknown, so nothing is released.
      return hold('ADAPTER_FAILED');
    } finally {
      IN_FLIGHT.delete(key);
    }
  }

  return Object.freeze({ completeOwned, dispatch });
}
