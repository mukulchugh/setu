import { redactSpansValue } from './spans-redaction.js';

// Pure capability evaluation for one requested launch profile. The caller
// supplies a fresh-session probe as data. This module reads no installed client
// configuration, makes no provider call, and never substitutes another model,
// provider, effort or cost mode. Freshness limits and the clock come from the
// caller.
//
// Trust boundary: this module checks the probe's shape, binding and freshness,
// and reports its provenance digest. It does not verify that the digest matches
// the probe's content. The adapter that builds the probe must be trusted.

export const SPANS_CAPABILITY_EFFORT_CEILING = 'xhigh';

// Lowest to highest. A level missing from this list is unsupported and fails
// closed, so an unlisted spelling can never pass as below the ceiling.
const EFFORT_ORDER = Object.freeze([
  'minimal',
  'low',
  'medium',
  'high',
  SPANS_CAPABILITY_EFFORT_CEILING,
]);
const ENFORCEMENT_LEVELS = Object.freeze([
  'enforced',
  'estimated',
  'unavailable',
]);
const PROBE_SOURCE = 'fresh-session-probe';
const MAX_ID_LENGTH = 256;
const MAX_REQUIRED_TOOLS = 64;
const CLIENT_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,39}$/;
const DIGEST_PATTERN = /^(?:sha256:)?[0-9a-f]{64}$/;
const DIGEST_PREFIX = 'sha256:';
const REQUEST_KEYS = Object.freeze(['evidence', 'now', 'policy', 'profile']);
const POLICY_KEYS = Object.freeze(['maxClockSkewMs', 'maxEvidenceAgeMs']);
const PROFILE_KEYS = Object.freeze([
  'client',
  'effort',
  'model',
  'provider',
  'requires',
  'sessionId',
]);
const REQUIREMENT_NAMES = Object.freeze([
  'hardCostCap',
  'hooks',
  'memory',
  'permissions',
  'resume',
  'rules',
  'tools',
]);
// Bounds on the plain-JSON copy of the policy, profile and evidence. Each one is
// checked while copying, so an oversized input is refused before it is copied.
const SNAPSHOT_LIMITS = Object.freeze({
  maxArrayLength: 64,
  maxBytes: 65_536,
  maxDepth: 8,
  maxKeys: 64,
  maxNodes: 512,
  maxStringLength: 1024,
});
// Keeps a malformed optional field distinct from an absent one.
const INVALID = Symbol('invalid');
// Thrown inside the snapshot walk and returned by snapshotJson, never shown.
const SNAPSHOT_REFUSED = Symbol('snapshot refused');

// Fixed text only. Request and evidence strings are never reflected.
const REFUSALS = {
  CLIENT_MISMATCH: 'The evidence was observed for a different client.',
  CLOCK_INVALID: 'The clock did not return a nonnegative safe integer.',
  CLOCK_MISSING: 'An explicit clock function is required.',
  EFFORT_UNSUPPORTED: 'effort must be a supported level no higher than xhigh.',
  EVALUATION_FAILED: 'The capability evaluation could not complete.',
  EVIDENCE_FUTURE: 'The evidence is dated beyond the allowed clock skew.',
  EVIDENCE_INVALID: 'The evidence does not use the expected format.',
  EVIDENCE_MISSING: 'Fresh-session evidence is required.',
  EVIDENCE_SENSITIVE: 'The evidence holds a value that looks like a secret.',
  EVIDENCE_STALE: 'The evidence is older than the allowed age.',
  INPUT_INVALID: 'The evaluation input must be an object.',
  POLICY_INVALID:
    'maxEvidenceAgeMs and maxClockSkewMs must be explicit nonnegative safe integers.',
  PROFILE_INVALID: 'The requested profile does not use the expected format.',
  PROFILE_SENSITIVE:
    'The requested profile holds a value that looks like a secret.',
  PROVENANCE_INVALID: 'The evidence provenance is not a fresh-session probe.',
  PROVENANCE_MISSING: 'The evidence has no provenance.',
  PROVIDER_MISMATCH: 'The evidence was observed for a different provider.',
  SESSION_MISMATCH: 'The evidence was observed for a different session.',
};

const isRecord = (value) =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

// Only ordinary objects, so a class instance, Map or Date is refused by its
// prototype before any of its fields are read.
const isPlainRecord = (value) => {
  if (!isRecord(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
};

const isNonnegativeInteger = (value) =>
  Number.isSafeInteger(value) && value >= 0;

const exactKeys = (value, allowed) =>
  isRecord(value) && Object.keys(value).every((key) => allowed.includes(key));

const fieldOf = (record, key) => (isRecord(record) ? record[key] : undefined);

const observedOneOf = (value, allowed) =>
  allowed.includes(value) ? value : 'unknown';

const yesNoUnknown = (value) => {
  if (value === true) {
    return 'yes';
  }
  return value === false ? 'no' : 'unknown';
};

function refuse(code) {
  return { code, error: REFUSALS[code], ok: false };
}

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

const isClientId = (value) =>
  typeof value === 'string' && CLIENT_ID_PATTERN.test(value);

const isDigest = (value) =>
  typeof value === 'string' && DIGEST_PATTERN.test(value);

// The optional sha256: spelling and the bare hex are the same digest.
const bareDigest = (value) =>
  value.startsWith(DIGEST_PREFIX) ? value.slice(DIGEST_PREFIX.length) : value;

// ---------------------------------------------------------------------------
// Plain-JSON snapshot. Own data descriptors are read directly, so no getter,
// toJSON or prototype hook runs. Anything outside plain JSON is refused.
// ---------------------------------------------------------------------------

// UTF-8 length, counted without encoding. A lone surrogate counts as U+FFFD.
function utf8Length(text) {
  let bytes = 0;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    const next = text.charCodeAt(index + 1);
    if (code < 0x80) {
      bytes += 1;
    } else if (code < 0x8_00) {
      bytes += 2;
    } else if (
      code >= 0xd8_00 &&
      code <= 0xdb_ff &&
      next >= 0xdc_00 &&
      next <= 0xdf_ff
    ) {
      bytes += 4;
      index += 1;
    } else {
      bytes += 3;
    }
  }
  return bytes;
}

// The length check runs before utf8Length, so an oversized string is never
// measured in full.
function copyText(text, state) {
  if (text.length > SNAPSHOT_LIMITS.maxStringLength) {
    throw SNAPSHOT_REFUSED;
  }
  state.bytes += utf8Length(text);
  if (state.bytes > SNAPSHOT_LIMITS.maxBytes) {
    throw SNAPSHOT_REFUSED;
  }
  return text;
}

function copyArray(items, depth, state) {
  const length = Object.getOwnPropertyDescriptor(items, 'length')?.value;
  if (
    Object.getPrototypeOf(items) !== Array.prototype ||
    !Number.isSafeInteger(length) ||
    length > SNAPSHOT_LIMITS.maxArrayLength ||
    // Holes and extra properties both change the own-key count.
    Reflect.ownKeys(items).length !== length + 1
  ) {
    throw SNAPSHOT_REFUSED;
  }
  const copy = [];
  for (let index = 0; index < length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(items, String(index));
    if (
      !(descriptor?.enumerable && 'value' in descriptor) ||
      descriptor.value === undefined
    ) {
      throw SNAPSHOT_REFUSED;
    }
    copy.push(copyValue(descriptor.value, depth + 1, state));
  }
  return copy;
}

// An undefined field is dropped, as JSON would drop it, so missing proof stays
// unknown. An undefined array item has no such meaning and is refused.
function copyRecord(record, depth, state) {
  if (!isPlainRecord(record)) {
    throw SNAPSHOT_REFUSED;
  }
  const keys = Reflect.ownKeys(record);
  if (keys.length > SNAPSHOT_LIMITS.maxKeys) {
    throw SNAPSHOT_REFUSED;
  }
  const copy = {};
  for (const key of keys) {
    if (typeof key !== 'string' || key === 'toJSON') {
      throw SNAPSHOT_REFUSED;
    }
    copyText(key, state);
    const descriptor = Object.getOwnPropertyDescriptor(record, key);
    if (!(descriptor?.enumerable && 'value' in descriptor)) {
      throw SNAPSHOT_REFUSED;
    }
    if (descriptor.value !== undefined) {
      Object.defineProperty(copy, key, {
        configurable: true,
        enumerable: true,
        value: copyValue(descriptor.value, depth + 1, state),
        writable: true,
      });
    }
  }
  return copy;
}

function copyValue(current, depth, state) {
  state.nodes += 1;
  if (state.nodes > SNAPSHOT_LIMITS.maxNodes) {
    throw SNAPSHOT_REFUSED;
  }
  if (current === null || typeof current === 'boolean') {
    return current;
  }
  if (typeof current === 'number' && Number.isFinite(current)) {
    return current;
  }
  if (typeof current === 'string') {
    return copyText(current, state);
  }
  // Also refuses undefined, functions, symbols, bigints and nonfinite numbers.
  if (
    typeof current !== 'object' ||
    depth >= SNAPSHOT_LIMITS.maxDepth ||
    state.ancestors.has(current)
  ) {
    throw SNAPSHOT_REFUSED;
  }
  state.ancestors.add(current);
  const copy = Array.isArray(current)
    ? copyArray(current, depth, state)
    : copyRecord(current, depth, state);
  state.ancestors.delete(current);
  return copy;
}

// Returns a fresh plain copy, or SNAPSHOT_REFUSED. Callers test the result with
// isRecord, so the refusal symbol is never mistaken for data. Any other error,
// such as a throwing proxy trap, propagates to evaluateSpansCapabilities.
function snapshotJson(value) {
  const state = { ancestors: new Set(), bytes: 0, nodes: 0 };
  try {
    return copyValue(value, 0, state);
  } catch (error) {
    if (error === SNAPSHOT_REFUSED) {
      return SNAPSHOT_REFUSED;
    }
    throw error;
  }
}

// Any redaction change means the value held a secret-looking field or string.
// The input is a snapshot, so it is plain JSON and stringify runs no user code.
function holdsSecret(value) {
  return JSON.stringify(redactSpansValue(value)) !== JSON.stringify(value);
}

function stamp(clock) {
  try {
    const at = clock();
    return isNonnegativeInteger(at) ? at : null;
  } catch {
    return null;
  }
}

// Reads the request's own data fields, never through a getter. The clock must
// be an explicit function; nothing defaults to Date.now.
function requestFields(input) {
  if (!isPlainRecord(input)) {
    return refuse('INPUT_INVALID');
  }
  const fields = {};
  for (const key of Reflect.ownKeys(input)) {
    if (typeof key !== 'string' || !REQUEST_KEYS.includes(key)) {
      return refuse('INPUT_INVALID');
    }
    const descriptor = Object.getOwnPropertyDescriptor(input, key);
    // An accessor cannot be read without running it, so the evaluation fails.
    if (!('value' in descriptor)) {
      return refuse('EVALUATION_FAILED');
    }
    if (!descriptor.enumerable) {
      return refuse('INPUT_INVALID');
    }
    fields[key] = descriptor.value;
  }
  if (typeof fields.now !== 'function') {
    return refuse('CLOCK_MISSING');
  }
  return { fields, ok: true };
}

// ---------------------------------------------------------------------------
// Request parsing
// ---------------------------------------------------------------------------

function parsePolicy(value) {
  const snapshot = snapshotJson(value);
  if (
    !(
      exactKeys(snapshot, POLICY_KEYS) &&
      isNonnegativeInteger(snapshot.maxClockSkewMs) &&
      isNonnegativeInteger(snapshot.maxEvidenceAgeMs)
    )
  ) {
    return refuse('POLICY_INVALID');
  }
  return {
    maxClockSkewMs: snapshot.maxClockSkewMs,
    maxEvidenceAgeMs: snapshot.maxEvidenceAgeMs,
    ok: true,
  };
}

function parseEffort(value) {
  if (typeof value !== 'string') {
    return refuse('PROFILE_INVALID');
  }
  const rank = EFFORT_ORDER.indexOf(value);
  if (
    rank === -1 ||
    rank > EFFORT_ORDER.indexOf(SPANS_CAPABILITY_EFFORT_CEILING)
  ) {
    return refuse('EFFORT_UNSUPPORTED');
  }
  return { effort: value, ok: true };
}

// Returns null when absent, the field value when exact and valid, or INVALID.
function optionalField(value, key, isValid) {
  if (value === undefined) {
    return null;
  }
  return exactKeys(value, [key]) && isValid(value[key]) ? value[key] : INVALID;
}

function parseToolIds(value) {
  const valid =
    Array.isArray(value) &&
    value.length <= MAX_REQUIRED_TOOLS &&
    value.every(isExplicitId) &&
    new Set(value).size === value.length;
  return valid ? [...value].sort() : INVALID;
}

function parseRequirements(value) {
  if (!exactKeys(value, REQUIREMENT_NAMES)) {
    return refuse('PROFILE_INVALID');
  }
  const { hardCostCap = false, hooks = false, resume = false } = value;
  const memory = optionalField(value.memory, 'scope', isExplicitId);
  const permissions = optionalField(value.permissions, 'mode', isExplicitId);
  const rules = optionalField(value.rules, 'digest', isDigest);
  const tools = value.tools === undefined ? null : parseToolIds(value.tools);
  const flags = [hardCostCap, hooks, resume];
  if (
    !flags.every((flag) => typeof flag === 'boolean') ||
    [memory, permissions, rules, tools].includes(INVALID)
  ) {
    return refuse('PROFILE_INVALID');
  }
  return {
    ok: true,
    requirements: {
      hardCostCap,
      hooks,
      memory,
      permissions,
      resume,
      rules: rules === null ? null : bareDigest(rules),
      tools,
    },
  };
}

function parseProfile(value) {
  const snapshot = snapshotJson(value);
  if (
    !(
      exactKeys(snapshot, PROFILE_KEYS) &&
      isClientId(snapshot.client) &&
      isClientId(snapshot.provider) &&
      isExplicitId(snapshot.model) &&
      isExplicitId(snapshot.sessionId)
    )
  ) {
    return refuse('PROFILE_INVALID');
  }
  const effort = parseEffort(snapshot.effort);
  if (!effort.ok) {
    return effort;
  }
  const requirements = parseRequirements(snapshot.requires);
  if (!requirements.ok) {
    return requirements;
  }
  const profile = {
    client: snapshot.client,
    effort: effort.effort,
    model: snapshot.model,
    provider: snapshot.provider,
    requirements: requirements.requirements,
    sessionId: snapshot.sessionId,
  };
  if (holdsSecret(profile)) {
    return refuse('PROFILE_SENSITIVE');
  }
  return { ok: true, ...profile };
}

function snapshotEvidence(value) {
  if (value === undefined || value === null) {
    return refuse('EVIDENCE_MISSING');
  }
  const snapshot = snapshotJson(value);
  if (!isRecord(snapshot)) {
    return refuse('EVIDENCE_INVALID');
  }
  if (holdsSecret(snapshot)) {
    return refuse('EVIDENCE_SENSITIVE');
  }
  return { ok: true, record: snapshot };
}

// ---------------------------------------------------------------------------
// Binding and freshness. Each returns null when the evidence may be used.
// ---------------------------------------------------------------------------

function provenanceRefusal(provenance) {
  if (provenance === undefined || provenance === null) {
    return refuse('PROVENANCE_MISSING');
  }
  const valid =
    isRecord(provenance) &&
    provenance.source === PROBE_SOURCE &&
    isExplicitId(provenance.probeId) &&
    isDigest(provenance.digest);
  return valid ? null : refuse('PROVENANCE_INVALID');
}

function observedAtRefusal(evidence, at, policy) {
  if (!isNonnegativeInteger(evidence.observedAt)) {
    return refuse('EVIDENCE_INVALID');
  }
  if (evidence.observedAt - at > policy.maxClockSkewMs) {
    return refuse('EVIDENCE_FUTURE');
  }
  if (at - evidence.observedAt > policy.maxEvidenceAgeMs) {
    return refuse('EVIDENCE_STALE');
  }
  return null;
}

function bindingRefusal(evidence, profile) {
  const { identity, session } = evidence;
  if (
    !(
      isRecord(identity) &&
      isClientId(identity.client) &&
      isClientId(identity.provider) &&
      isRecord(session) &&
      isExplicitId(session.id)
    )
  ) {
    return refuse('EVIDENCE_INVALID');
  }
  if (identity.client !== profile.client) {
    return refuse('CLIENT_MISMATCH');
  }
  if (identity.provider !== profile.provider) {
    return refuse('PROVIDER_MISMATCH');
  }
  if (session.id !== profile.sessionId) {
    return refuse('SESSION_MISMATCH');
  }
  return null;
}

function checkEvidence(evidence, profile, policy, at) {
  return (
    provenanceRefusal(evidence.provenance) ??
    observedAtRefusal(evidence, at, policy) ??
    bindingRefusal(evidence, profile)
  );
}

// ---------------------------------------------------------------------------
// Capability evaluators. Each returns { reasons, observed?, ... } and never
// decides enablement itself; settle() applies the session rule.
// ---------------------------------------------------------------------------

function modelResult(profile, identity) {
  const observed = isExplicitId(fieldOf(identity, 'model'))
    ? identity.model
    : 'unknown';
  if (observed === 'unknown') {
    return { observed, reasons: ['MODEL_UNKNOWN'], requested: profile.model };
  }
  return {
    observed,
    reasons: observed === profile.model ? [] : ['MODEL_MISMATCH'],
    requested: profile.model,
  };
}

function effortResult(profile, identity) {
  const observed = observedOneOf(fieldOf(identity, 'effort'), EFFORT_ORDER);
  if (observed === 'unknown') {
    return { observed, reasons: ['EFFORT_UNKNOWN'], requested: profile.effort };
  }
  return {
    observed,
    reasons: observed === profile.effort ? [] : ['EFFORT_MISMATCH'],
    requested: profile.effort,
  };
}

function toolsResult(ids, tools) {
  const missing = ids.filter(
    (id) =>
      !(
        isRecord(tools) &&
        Object.hasOwn(tools, id) &&
        tools[id] === 'available'
      )
  );
  return {
    missing,
    reasons: missing.length === 0 ? [] : ['TOOL_UNVERIFIED'],
  };
}

function rulesResult(digest, rules) {
  const observed =
    isRecord(rules) && isDigest(rules.digest) ? bareDigest(rules.digest) : null;
  if (observed === null) {
    return { reasons: ['RULES_UNVERIFIED'] };
  }
  return { reasons: observed === digest ? [] : ['RULES_DIGEST_MISMATCH'] };
}

function memoryResult(scope, memory) {
  if (fieldOf(memory, 'status') !== 'verified') {
    return { reasons: ['MEMORY_UNVERIFIED'] };
  }
  return {
    observed: isExplicitId(fieldOf(memory, 'scope')) ? memory.scope : 'unknown',
    reasons:
      fieldOf(memory, 'scope') === scope ? [] : ['MEMORY_SCOPE_MISMATCH'],
  };
}

function hooksResult(hooks) {
  const observed = observedOneOf(fieldOf(hooks, 'status'), [
    'unsupported',
    'verified',
  ]);
  const reasons = {
    unknown: ['HOOKS_UNVERIFIED'],
    unsupported: ['HOOKS_UNSUPPORTED'],
    verified: [],
  }[observed];
  return { observed, reasons };
}

// Native resume is only claimed when the probe's resume record itself says so.
// A probe that also reports a fresh session is not separately checked here; see
// the single-probe note in REPORT.md.
function resumeResult(resume, sessionId) {
  const observed = observedOneOf(fieldOf(resume, 'status'), [
    'unsupported',
    'verified',
  ]);
  if (observed === 'unknown') {
    return { observed, reasons: ['RESUME_UNVERIFIED'] };
  }
  if (observed === 'unsupported') {
    return { observed, reasons: ['RESUME_UNSUPPORTED'] };
  }
  // A fresh context is never a native resume, whatever else the probe claims.
  if (fieldOf(resume, 'origin') !== 'native-resume') {
    return { observed, reasons: ['RESUME_NOT_NATIVE'] };
  }
  if (fieldOf(resume, 'sessionId') !== sessionId) {
    return { observed, reasons: ['RESUME_SESSION_MISMATCH'] };
  }
  return { observed, reasons: [] };
}

function permissionsResult(mode, permissions) {
  if (fieldOf(permissions, 'status') !== 'verified') {
    return { reasons: ['PERMISSIONS_UNVERIFIED'] };
  }
  return {
    observed: isExplicitId(fieldOf(permissions, 'mode'))
      ? permissions.mode
      : 'unknown',
    reasons:
      fieldOf(permissions, 'mode') === mode ? [] : ['PERMISSIONS_MISMATCH'],
  };
}

// Hard enforcement of a cost cap. Only the probe's enforcement field decides
// it; a pricing estimate never does.
function costResult(cost) {
  const observed = observedOneOf(
    fieldOf(cost, 'enforcement'),
    ENFORCEMENT_LEVELS
  );
  const reasons = {
    enforced: [],
    estimated: ['COST_NOT_ENFORCED'],
    unavailable: ['COST_NOT_ENFORCED'],
    unknown: ['COST_UNVERIFIED'],
  }[observed];
  return { observed, reasons };
}

// Price knowledge for an estimate. Independent of enforcement.
function pricingResult(cost) {
  const observed = observedOneOf(fieldOf(cost, 'pricing'), ['known']);
  return { observed, reasons: observed === 'known' ? [] : ['PRICING_UNKNOWN'] };
}

// A capability is enabled only when it has no reasons. An unverified session
// adds SESSION_NOT_FRESH without hiding a capability's own reasons.
function settle(result, verified) {
  const { reasons, ...details } = result;
  const all = verified ? reasons : ['SESSION_NOT_FRESH', ...reasons];
  const unique = [...new Set(all)].sort();
  return { ...details, enabled: unique.length === 0, reasons: unique };
}

const isRequested = (value) => value !== null && value !== false;

function whenRequested(value, evaluateCapability, verified) {
  return isRequested(value)
    ? settle(evaluateCapability(value), verified)
    : { enabled: false, reasons: ['NOT_REQUESTED'] };
}

function capabilities(profile, evidence, verified) {
  const { requirements, sessionId } = profile;
  return {
    effort: settle(effortResult(profile, evidence.identity), verified),
    hardCostCap: whenRequested(
      requirements.hardCostCap,
      () => costResult(evidence.cost),
      verified
    ),
    hooks: whenRequested(
      requirements.hooks,
      () => hooksResult(evidence.hooks),
      verified
    ),
    memory: whenRequested(
      requirements.memory,
      (scope) => memoryResult(scope, evidence.memory),
      verified
    ),
    model: settle(modelResult(profile, evidence.identity), verified),
    permissions: whenRequested(
      requirements.permissions,
      (mode) => permissionsResult(mode, evidence.permissions),
      verified
    ),
    pricingEstimate: settle(pricingResult(evidence.cost), verified),
    resume: whenRequested(
      requirements.resume,
      () => resumeResult(evidence.resume, sessionId),
      verified
    ),
    rules: whenRequested(
      requirements.rules,
      (digest) => rulesResult(digest, evidence.rules),
      verified
    ),
    tools: whenRequested(
      requirements.tools,
      (ids) => toolsResult(ids, evidence.tools),
      verified
    ),
  };
}

// Launch needs a fresh session that proved installation and connection, the
// exact model and effort, and every requested capability. A hard cost cap also
// needs known pricing, so it cannot launch unpriced. This covers capability
// proof only; it does not authorize spend (see `spend` in evaluate).
function launchBlockers(evidence, requirements, capabilityMap, verified) {
  const blockers = verified ? [] : ['session'];
  if (evidence.installed !== true) {
    blockers.push('installed');
  }
  if (evidence.connected !== true) {
    blockers.push('connected');
  }
  for (const name of ['effort', 'model']) {
    if (!capabilityMap[name].enabled) {
      blockers.push(name);
    }
  }
  for (const name of REQUIREMENT_NAMES) {
    if (isRequested(requirements[name]) && !capabilityMap[name].enabled) {
      blockers.push(name);
    }
  }
  if (
    isRequested(requirements.hardCostCap) &&
    !capabilityMap.pricingEstimate.enabled
  ) {
    blockers.push('pricingEstimate');
  }
  return [...new Set(blockers)].sort();
}

function evaluate(input) {
  const request = requestFields(input);
  if (!request.ok) {
    return request;
  }
  const { fields } = request;
  const policy = parsePolicy(fields.policy);
  if (!policy.ok) {
    return policy;
  }
  const profile = parseProfile(fields.profile);
  if (!profile.ok) {
    return profile;
  }
  const snapshot = snapshotEvidence(fields.evidence);
  if (!snapshot.ok) {
    return snapshot;
  }
  const at = stamp(fields.now);
  if (at === null) {
    return refuse('CLOCK_INVALID');
  }
  const { record: evidence } = snapshot;
  const refusal = checkEvidence(evidence, profile, policy, at);
  if (refusal) {
    return refusal;
  }

  // Only a session that started fresh can verify anything.
  const verified = evidence.session.origin === 'fresh';
  const capabilityMap = capabilities(profile, evidence, verified);
  const blockedBy = launchBlockers(
    evidence,
    profile.requirements,
    capabilityMap,
    verified
  );
  return {
    capabilities: capabilityMap,
    client: profile.client,
    evidenceAgeMs: Math.max(0, at - evidence.observedAt),
    launch: { allowed: blockedBy.length === 0, blockedBy },
    ok: true,
    // Names the exact probe for approval or dispatch binding. The digest's
    // content is not checked here; contentVerified stays false.
    provenance: {
      contentVerified: false,
      digest: `${DIGEST_PREFIX}${bareDigest(evidence.provenance.digest)}`,
      observedAt: evidence.observedAt,
      probeId: evidence.provenance.probeId,
      source: PROBE_SOURCE,
    },
    provider: profile.provider,
    sessionId: profile.sessionId,
    // Capability proof never authorizes spend. The root usage gate decides it.
    spend: { authorized: false, gate: 'root-usage' },
    states: {
      connected: yesNoUnknown(evidence.connected),
      installed: yesNoUnknown(evidence.installed),
      verifiedFreshSession: yesNoUnknown(verified),
    },
  };
}

/**
 * Evaluate one requested launch profile against one fresh-session probe.
 * `now` must be an explicit clock function. `policy` must supply
 * maxEvidenceAgeMs and maxClockSkewMs; nothing defaults. Getters, toJSON and
 * non-plain values are refused without being invoked. The result's `provenance`
 * names the probe, but its digest content is unverified, so the caller must
 * trust the adapter that produced the probe.
 * Returns {ok:true, states, capabilities, launch, provenance, spend} or
 * {ok:false, code, error}.
 */
export function evaluateSpansCapabilities(input) {
  try {
    return evaluate(input);
  } catch {
    return refuse('EVALUATION_FAILED');
  }
}
