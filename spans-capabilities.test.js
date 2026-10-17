import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import {
  evaluateSpansCapabilities,
  SPANS_CAPABILITY_EFFORT_CEILING,
} from './spans-capabilities.js';

const NOW = 1_000_000;
const POLICY = Object.freeze({
  maxClockSkewMs: 1000,
  maxEvidenceAgeMs: 60_000,
});
const DIGEST = 'a'.repeat(64);
const OTHER_DIGEST = 'b'.repeat(64);
const PROBE_DIGEST = 'c'.repeat(64);
const CAPABILITY_MODULE_FORBIDDEN_IMPORTS =
  /node:fs|node:child_process|node:net|node:http|fetch\(|Bun\.spawn|process\.env/;
const ALL_CAPABILITIES = [
  'effort',
  'hardCostCap',
  'hooks',
  'memory',
  'model',
  'permissions',
  'pricingEstimate',
  'resume',
  'rules',
  'tools',
];

const isPlainRecord = (value) =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

// Deep-merges plain objects. An undefined leaf removes that key from the
// JSON-like snapshot, which is how these tests express missing proof.
function merge(base, changes) {
  const result = { ...base };
  for (const [key, value] of Object.entries(changes)) {
    result[key] =
      isPlainRecord(value) && isPlainRecord(base[key])
        ? merge(base[key], value)
        : value;
  }
  return result;
}

function profile(changes = {}) {
  return merge(
    {
      client: 'claude-code',
      effort: 'xhigh',
      model: 'model-under-test',
      provider: 'anthropic',
      requires: {
        hardCostCap: true,
        hooks: true,
        memory: { scope: 'memory-scope-1' },
        permissions: { mode: 'permission-mode-1' },
        resume: true,
        rules: { digest: DIGEST },
        tools: ['tool-a', 'tool-b'],
      },
      sessionId: 'session-1',
    },
    changes
  );
}

function probe(changes = {}) {
  return merge(
    {
      connected: true,
      cost: { enforcement: 'enforced', pricing: 'known' },
      hooks: { status: 'verified' },
      identity: {
        client: 'claude-code',
        effort: 'xhigh',
        model: 'model-under-test',
        provider: 'anthropic',
      },
      installed: true,
      memory: { scope: 'memory-scope-1', status: 'verified' },
      observedAt: NOW - 100,
      permissions: { mode: 'permission-mode-1', status: 'verified' },
      provenance: {
        digest: PROBE_DIGEST,
        probeId: 'probe-1',
        source: 'fresh-session-probe',
      },
      resume: {
        origin: 'native-resume',
        sessionId: 'session-1',
        status: 'verified',
      },
      rules: { digest: DIGEST },
      session: { id: 'session-1', origin: 'fresh' },
      tools: { 'tool-a': 'available', 'tool-b': 'available' },
    },
    changes
  );
}

function run({
  evidenceChanges = {},
  policy = POLICY,
  profileChanges = {},
  now = () => NOW,
} = {}) {
  return evaluateSpansCapabilities({
    evidence: probe(evidenceChanges),
    now,
    policy,
    profile: profile(profileChanges),
  });
}

const reasonsOf = (result, name) => result.capabilities[name].reasons;

test('allows launch only when a fresh bound probe proves every requested capability', () => {
  const result = run();

  expect(result).toMatchObject({
    client: 'claude-code',
    evidenceAgeMs: 100,
    launch: { allowed: true, blockedBy: [] },
    ok: true,
    provider: 'anthropic',
    sessionId: 'session-1',
    states: {
      connected: 'yes',
      installed: 'yes',
      verifiedFreshSession: 'yes',
    },
  });
  for (const name of ALL_CAPABILITIES) {
    expect(result.capabilities[name].enabled).toBe(true);
  }
  // Capability proof never authorizes spend; the root usage gate still decides.
  expect(result.spend).toEqual({ authorized: false, gate: 'root-usage' });
});

test('reports installed, connected and verified as separate states', () => {
  const resumed = run({
    evidenceChanges: { connected: false, session: { origin: 'resumed' } },
  });

  expect(resumed.ok).toBe(true);
  expect(resumed.states).toEqual({
    connected: 'no',
    installed: 'yes',
    verifiedFreshSession: 'no',
  });
  expect(resumed.launch.allowed).toBe(false);
  expect(resumed.launch.blockedBy).toContain('session');
  expect(resumed.launch.blockedBy).toContain('connected');
  for (const name of ALL_CAPABILITIES) {
    expect(resumed.capabilities[name].enabled).toBe(false);
    expect(reasonsOf(resumed, name)).toContain('SESSION_NOT_FRESH');
  }
});

test('unknown installation and connection are reported as unknown and block launch', () => {
  const result = run({
    evidenceChanges: { connected: undefined, installed: undefined },
  });

  expect(result.states).toMatchObject({
    connected: 'unknown',
    installed: 'unknown',
    verifiedFreshSession: 'yes',
  });
  expect(result.launch.allowed).toBe(false);
  expect(result.launch.blockedBy).toEqual(['connected', 'installed']);
});

test('an unknown session origin is not verified', () => {
  const result = run({ evidenceChanges: { session: { origin: undefined } } });

  expect(result.states.verifiedFreshSession).toBe('no');
  expect(result.launch.allowed).toBe(false);
});

test('stale evidence fails closed at the caller-supplied age limit', () => {
  expect(
    run({ evidenceChanges: { observedAt: NOW - POLICY.maxEvidenceAgeMs } }).ok
  ).toBe(true);
  expect(
    run({
      evidenceChanges: { observedAt: NOW - POLICY.maxEvidenceAgeMs - 1 },
    })
  ).toMatchObject({ code: 'EVIDENCE_STALE', ok: false });
});

test('future evidence beyond the caller clock skew is refused', () => {
  expect(
    run({ evidenceChanges: { observedAt: NOW + POLICY.maxClockSkewMs } }).ok
  ).toBe(true);
  expect(
    run({
      evidenceChanges: { observedAt: NOW + POLICY.maxClockSkewMs + 1 },
    })
  ).toMatchObject({ code: 'EVIDENCE_FUTURE', ok: false });
});

test('a clock that cannot return a safe integer refuses before judging evidence', () => {
  expect(
    run({
      now: () => {
        throw new Error('clock unavailable');
      },
    })
  ).toMatchObject({ code: 'CLOCK_INVALID', ok: false });
  expect(run({ now: () => 1.5 })).toMatchObject({
    code: 'CLOCK_INVALID',
    ok: false,
  });
  expect(run({ now: () => -1 })).toMatchObject({
    code: 'CLOCK_INVALID',
    ok: false,
  });
});

test('freshness limits are required and never defaulted', () => {
  expect(
    evaluateSpansCapabilities({
      evidence: probe(),
      now: () => NOW,
      profile: profile(),
    })
  ).toMatchObject({ code: 'POLICY_INVALID', ok: false });
  expect(
    run({ policy: { maxEvidenceAgeMs: POLICY.maxEvidenceAgeMs } })
  ).toMatchObject({ code: 'POLICY_INVALID', ok: false });
  expect(run({ policy: { ...POLICY, extraLimit: 1 } })).toMatchObject({
    code: 'POLICY_INVALID',
    ok: false,
  });
  expect(
    run({ policy: { ...POLICY, maxEvidenceAgeMs: Number.POSITIVE_INFINITY } })
  ).toMatchObject({ code: 'POLICY_INVALID', ok: false });
  expect(run({ policy: { ...POLICY, maxClockSkewMs: -1 } })).toMatchObject({
    code: 'POLICY_INVALID',
    ok: false,
  });
});

test('missing and malformed evidence are refused without a capability result', () => {
  const base = {
    now: () => NOW,
    policy: POLICY,
    profile: profile(),
  };

  expect(
    evaluateSpansCapabilities({ ...base, evidence: undefined })
  ).toMatchObject({ code: 'EVIDENCE_MISSING', ok: false });
  expect(evaluateSpansCapabilities({ ...base, evidence: null })).toMatchObject({
    code: 'EVIDENCE_MISSING',
    ok: false,
  });
  expect(
    evaluateSpansCapabilities({ ...base, evidence: 'fresh' })
  ).toMatchObject({ code: 'EVIDENCE_INVALID', ok: false });
  expect(evaluateSpansCapabilities({ ...base, evidence: [] })).toMatchObject({
    code: 'EVIDENCE_INVALID',
    ok: false,
  });
  expect(run({ evidenceChanges: { observedAt: 1.5 } })).toMatchObject({
    code: 'EVIDENCE_INVALID',
    ok: false,
  });
});

test('provenance must be a fresh-session probe with an explicit digest', () => {
  expect(run({ evidenceChanges: { provenance: undefined } })).toMatchObject({
    code: 'PROVENANCE_MISSING',
    ok: false,
  });
  expect(
    run({ evidenceChanges: { provenance: { source: 'agent-message' } } })
  ).toMatchObject({ code: 'PROVENANCE_INVALID', ok: false });
  expect(
    run({ evidenceChanges: { provenance: { digest: 'abc' } } })
  ).toMatchObject({ code: 'PROVENANCE_INVALID', ok: false });
  expect(
    run({ evidenceChanges: { provenance: { digest: [PROBE_DIGEST] } } })
  ).toMatchObject({ code: 'PROVENANCE_INVALID', ok: false });
  expect(
    run({ evidenceChanges: { provenance: { probeId: undefined } } })
  ).toMatchObject({ code: 'PROVENANCE_INVALID', ok: false });
});

test('a wrong client, provider or session never yields a capability result', () => {
  const client = run({ evidenceChanges: { identity: { client: 'codex' } } });
  const provider = run({
    evidenceChanges: { identity: { provider: 'openai' } },
  });
  const session = run({ evidenceChanges: { session: { id: 'session-2' } } });

  expect(client).toMatchObject({ code: 'CLIENT_MISMATCH', ok: false });
  expect(provider).toMatchObject({ code: 'PROVIDER_MISMATCH', ok: false });
  expect(session).toMatchObject({ code: 'SESSION_MISMATCH', ok: false });
  expect(client).not.toHaveProperty('capabilities');
  expect(provider).not.toHaveProperty('capabilities');
  expect(session).not.toHaveProperty('capabilities');
  expect(run({ evidenceChanges: { identity: undefined } })).toMatchObject({
    code: 'EVIDENCE_INVALID',
    ok: false,
  });
});

test('a different model is never substituted for the requested model', () => {
  const result = run({
    evidenceChanges: { identity: { model: 'model-other' } },
  });

  expect(result.ok).toBe(true);
  expect(result.capabilities.model).toEqual({
    enabled: false,
    observed: 'model-other',
    reasons: ['MODEL_MISMATCH'],
    requested: 'model-under-test',
  });
  expect(result).not.toHaveProperty('fallback');
  expect(result.launch.allowed).toBe(false);
  expect(result.launch.blockedBy).toContain('model');
});

test('an unknown observed model is reported as unknown and blocks launch', () => {
  const result = run({ evidenceChanges: { identity: { model: undefined } } });

  expect(result.capabilities.model).toMatchObject({
    enabled: false,
    observed: 'unknown',
    reasons: ['MODEL_UNKNOWN'],
  });
  expect(result.launch.allowed).toBe(false);
});

test('effort must be supported and no higher than the xhigh ceiling', () => {
  expect(SPANS_CAPABILITY_EFFORT_CEILING).toBe('xhigh');

  for (const effort of ['max', 'XHIGH', 'xhigh ', '']) {
    expect(run({ profileChanges: { effort } })).toMatchObject({
      code: 'EFFORT_UNSUPPORTED',
      ok: false,
    });
  }
  expect(run({ profileChanges: { effort: 42 } })).toMatchObject({
    code: 'PROFILE_INVALID',
    ok: false,
  });

  const lower = run({
    evidenceChanges: { identity: { effort: 'high' } },
    profileChanges: { effort: 'high' },
  });
  expect(lower.launch.allowed).toBe(true);
});

test('observed effort that is unsupported or different disables effort', () => {
  const unsupported = run({ evidenceChanges: { identity: { effort: 'max' } } });
  expect(unsupported.capabilities.effort).toMatchObject({
    enabled: false,
    observed: 'unknown',
    reasons: ['EFFORT_UNKNOWN'],
  });
  expect(unsupported.launch.blockedBy).toContain('effort');

  const mismatch = run({ evidenceChanges: { identity: { effort: 'high' } } });
  expect(mismatch.capabilities.effort).toMatchObject({
    enabled: false,
    observed: 'high',
    reasons: ['EFFORT_MISMATCH'],
    requested: 'xhigh',
  });
});

test('missing or unsupported hook proof disables hooks and blocks a profile that requires them', () => {
  const missing = run({ evidenceChanges: { hooks: undefined } });
  expect(missing.capabilities.hooks).toMatchObject({
    enabled: false,
    reasons: ['HOOKS_UNVERIFIED'],
  });
  expect(missing.launch.blockedBy).toContain('hooks');

  const unsupported = run({
    evidenceChanges: { hooks: { status: 'unsupported' } },
  });
  expect(unsupported.capabilities.hooks).toMatchObject({
    enabled: false,
    reasons: ['HOOKS_UNSUPPORTED'],
  });
  expect(unsupported.launch.allowed).toBe(false);
});

test('an unsupported capability that the profile does not request does not block launch', () => {
  const result = run({
    evidenceChanges: { hooks: { status: 'unsupported' } },
    profileChanges: { requires: { hooks: false } },
  });

  expect(result.capabilities.hooks).toEqual({
    enabled: false,
    reasons: ['NOT_REQUESTED'],
  });
  expect(result.launch).toEqual({ allowed: true, blockedBy: [] });
});

test('a profile with no requirements launches on identity, model and effort alone', () => {
  const result = evaluateSpansCapabilities({
    evidence: probe(),
    now: () => NOW,
    policy: POLICY,
    profile: { ...profile(), requires: {} },
  });

  expect(result.launch).toEqual({ allowed: true, blockedBy: [] });
  expect(result.capabilities.resume).toEqual({
    enabled: false,
    reasons: ['NOT_REQUESTED'],
  });
});

test('resume is native only when the probe proves it for the bound session', () => {
  const freshOrigin = run({
    evidenceChanges: { resume: { origin: 'fresh' } },
  });
  expect(freshOrigin.capabilities.resume).toMatchObject({
    enabled: false,
    reasons: ['RESUME_NOT_NATIVE'],
  });

  const missing = run({ evidenceChanges: { resume: undefined } });
  expect(missing.capabilities.resume).toMatchObject({
    enabled: false,
    reasons: ['RESUME_UNVERIFIED'],
  });

  const otherSession = run({
    evidenceChanges: { resume: { sessionId: 'session-9' } },
  });
  expect(otherSession.capabilities.resume).toMatchObject({
    enabled: false,
    reasons: ['RESUME_SESSION_MISMATCH'],
  });

  const unsupported = run({
    evidenceChanges: { resume: { status: 'unsupported' } },
  });
  expect(unsupported.capabilities.resume).toMatchObject({
    enabled: false,
    reasons: ['RESUME_UNSUPPORTED'],
  });
});

test('memory, rules, tools and permissions each need matching proof', () => {
  const memoryUnverified = run({
    evidenceChanges: { memory: { status: 'unknown' } },
  });
  expect(memoryUnverified.capabilities.memory.reasons).toEqual([
    'MEMORY_UNVERIFIED',
  ]);

  const memoryScope = run({
    evidenceChanges: { memory: { scope: 'other-scope' } },
  });
  expect(memoryScope.capabilities.memory.reasons).toEqual([
    'MEMORY_SCOPE_MISMATCH',
  ]);

  const memoryNoScope = run({
    evidenceChanges: { memory: { scope: undefined } },
  });
  expect(memoryNoScope.capabilities.memory).toMatchObject({
    enabled: false,
    observed: 'unknown',
    reasons: ['MEMORY_SCOPE_MISMATCH'],
  });

  const toolMissing = run({
    evidenceChanges: { tools: { 'tool-b': undefined } },
  });
  expect(toolMissing.capabilities.tools).toEqual({
    enabled: false,
    missing: ['tool-b'],
    reasons: ['TOOL_UNVERIFIED'],
  });

  const toolNotAvailable = run({
    evidenceChanges: { tools: { 'tool-a': 'available', 'tool-b': 'missing' } },
  });
  expect(toolNotAvailable.capabilities.tools.missing).toEqual(['tool-b']);

  const rulesMismatch = run({
    evidenceChanges: { rules: { digest: OTHER_DIGEST } },
  });
  expect(rulesMismatch.capabilities.rules.reasons).toEqual([
    'RULES_DIGEST_MISMATCH',
  ]);

  const rulesMissing = run({ evidenceChanges: { rules: undefined } });
  expect(rulesMissing.capabilities.rules.reasons).toEqual(['RULES_UNVERIFIED']);

  const permissionsMismatch = run({
    evidenceChanges: { permissions: { mode: 'permission-mode-2' } },
  });
  expect(permissionsMismatch.capabilities.permissions.reasons).toEqual([
    'PERMISSIONS_MISMATCH',
  ]);

  const permissionsUnverified = run({
    evidenceChanges: { permissions: { status: 'unknown' } },
  });
  expect(permissionsUnverified.capabilities.permissions.reasons).toEqual([
    'PERMISSIONS_UNVERIFIED',
  ]);
});

test('the rules digest matches with or without the sha256 prefix', () => {
  const prefixed = run({
    evidenceChanges: { rules: { digest: `sha256:${DIGEST}` } },
  });

  expect(prefixed.capabilities.rules.enabled).toBe(true);
});

test('hard cost enforcement is separate from the pricing estimate', () => {
  const estimated = run({
    evidenceChanges: { cost: { enforcement: 'estimated', pricing: 'known' } },
  });
  expect(estimated.capabilities.hardCostCap).toMatchObject({
    enabled: false,
    observed: 'estimated',
    reasons: ['COST_NOT_ENFORCED'],
  });
  expect(estimated.capabilities.pricingEstimate.enabled).toBe(true);
  expect(estimated.launch.blockedBy).toContain('hardCostCap');

  const unavailable = run({
    evidenceChanges: { cost: { enforcement: 'unavailable', pricing: 'known' } },
  });
  expect(unavailable.capabilities.hardCostCap).toMatchObject({
    enabled: false,
    observed: 'unavailable',
    reasons: ['COST_NOT_ENFORCED'],
  });

  const unknown = run({
    evidenceChanges: { cost: { enforcement: 'maybe' } },
  });
  expect(unknown.capabilities.hardCostCap).toMatchObject({
    enabled: false,
    observed: 'unknown',
    reasons: ['COST_UNVERIFIED'],
  });
});

test('a hard cost cap cannot launch an unpriced provider even when enforced', () => {
  const unpriced = run({
    evidenceChanges: { cost: { enforcement: 'enforced', pricing: 'unknown' } },
  });

  expect(unpriced.capabilities.hardCostCap.enabled).toBe(true);
  expect(unpriced.capabilities.pricingEstimate).toEqual({
    enabled: false,
    observed: 'unknown',
    reasons: ['PRICING_UNKNOWN'],
  });
  expect(unpriced.launch.allowed).toBe(false);
  expect(unpriced.launch.blockedBy).toContain('pricingEstimate');
});

test('unknown pricing does not block a profile that does not request a hard cap', () => {
  const result = run({
    evidenceChanges: { cost: { enforcement: 'estimated', pricing: 'unknown' } },
    profileChanges: { requires: { hardCostCap: false } },
  });

  expect(result.capabilities.hardCostCap).toEqual({
    enabled: false,
    reasons: ['NOT_REQUESTED'],
  });
  expect(result.capabilities.pricingEstimate.enabled).toBe(false);
  expect(result.launch).toEqual({ allowed: true, blockedBy: [] });
});

test('sensitive evidence is refused and never echoed', () => {
  const modelSecret = run({
    evidenceChanges: { identity: { model: 'sk-proj-abcdefghijklmnop' } },
  });
  expect(modelSecret).toMatchObject({
    code: 'EVIDENCE_SENSITIVE',
    ok: false,
  });
  expect(JSON.stringify(modelSecret)).not.toContain('abcdefghijklmnop');

  const tokenField = run({ evidenceChanges: { token: 'plain-value-1234' } });
  expect(tokenField).toMatchObject({ code: 'EVIDENCE_SENSITIVE', ok: false });
  expect(JSON.stringify(tokenField)).not.toContain('plain-value-1234');

  const bearerNote = run({
    evidenceChanges: { notes: 'Authorization: Bearer abcdefghijklmnop1234' },
  });
  expect(bearerNote).toMatchObject({ code: 'EVIDENCE_SENSITIVE', ok: false });
  expect(JSON.stringify(bearerNote)).not.toContain('abcdefghijklmnop1234');
});

test('a sensitive requested profile is refused and never echoed', () => {
  const result = run({
    profileChanges: { model: 'sk-proj-abcdefghijklmnop' },
  });

  expect(result).toMatchObject({ code: 'PROFILE_SENSITIVE', ok: false });
  expect(JSON.stringify(result)).not.toContain('abcdefghijklmnop');
});

test('requested profile requirements are exact and malicious identifiers are refused', () => {
  expect(run({ profileChanges: { requires: { deploy: true } } })).toMatchObject(
    { code: 'PROFILE_INVALID', ok: false }
  );
  expect(
    run({ profileChanges: { requires: { tools: ['__proto__'] } } })
  ).toMatchObject({ code: 'PROFILE_INVALID', ok: false });
  expect(
    run({ profileChanges: { requires: { tools: ['tool-a', 'tool-a'] } } })
  ).toMatchObject({ code: 'PROFILE_INVALID', ok: false });
  expect(
    run({
      profileChanges: {
        requires: {
          tools: Array.from({ length: 65 }, (_, index) => `tool-${index}`),
        },
      },
    })
  ).toMatchObject({ code: 'PROFILE_INVALID', ok: false });
  expect(run({ profileChanges: { requires: { hooks: 'yes' } } })).toMatchObject(
    { code: 'PROFILE_INVALID', ok: false }
  );
  expect(
    run({ profileChanges: { deploymentTarget: 'production' } })
  ).toMatchObject({ code: 'PROFILE_INVALID', ok: false });
  expect(run({ profileChanges: { sessionId: ' session-1' } })).toMatchObject({
    code: 'PROFILE_INVALID',
    ok: false,
  });
  expect(run({ profileChanges: { client: 'Claude Code' } })).toMatchObject({
    code: 'PROFILE_INVALID',
    ok: false,
  });
});

test('a prototype-like evidence key does not change capability results', () => {
  const text = JSON.stringify(probe()).replace(
    '"tools":{',
    '"tools":{"__proto__":"available",'
  );
  const hostile = JSON.parse(text);

  const result = evaluateSpansCapabilities({
    evidence: hostile,
    now: () => NOW,
    policy: POLICY,
    profile: profile(),
  });

  expect(result.ok).toBe(true);
  expect(result.capabilities.tools.enabled).toBe(true);
  expect(result.launch.allowed).toBe(true);
});

test('a hostile evidence getter becomes a bounded invalid result', () => {
  const hostile = probe();
  Object.defineProperty(hostile, 'observedAt', {
    enumerable: true,
    get() {
      throw new Error('boom');
    },
  });

  expect(
    evaluateSpansCapabilities({
      evidence: hostile,
      now: () => NOW,
      policy: POLICY,
      profile: profile(),
    })
  ).toMatchObject({ code: 'EVIDENCE_INVALID', ok: false });
});

test('a throwing input getter becomes a bounded evaluation failure', () => {
  const hostileInput = {
    evidence: probe(),
    now: () => NOW,
    profile: profile(),
  };
  Object.defineProperty(hostileInput, 'policy', {
    enumerable: true,
    get() {
      throw new Error('boom');
    },
  });

  expect(evaluateSpansCapabilities(hostileInput)).toMatchObject({
    code: 'EVALUATION_FAILED',
    ok: false,
  });
  expect(evaluateSpansCapabilities(null)).toMatchObject({
    code: 'INPUT_INVALID',
    ok: false,
  });
});

test('inputs are not mutated by evaluation', () => {
  const input = {
    evidence: probe(),
    now: () => NOW,
    policy: { ...POLICY },
    profile: profile(),
  };
  const before = JSON.stringify({
    evidence: input.evidence,
    policy: input.policy,
    profile: input.profile,
  });

  evaluateSpansCapabilities(input);

  expect(
    JSON.stringify({
      evidence: input.evidence,
      policy: input.policy,
      profile: input.profile,
    })
  ).toBe(before);
});

test('the module reads no configuration and makes no process or network call', () => {
  const source = readFileSync(
    new URL('./spans-capabilities.js', import.meta.url),
    'utf8'
  );

  expect(source).not.toMatch(CAPABILITY_MODULE_FORBIDDEN_IMPORTS);
});

test('getters are refused and never invoked', () => {
  let calls = 0;
  const counted = (value) => ({
    enumerable: true,
    get() {
      calls += 1;
      return value;
    },
  });
  const evidence = probe();
  Object.defineProperty(
    evidence.identity,
    'model',
    counted('model-under-test')
  );
  const requested = profile();
  Object.defineProperty(requested, 'model', counted('model-under-test'));
  const hostileInput = {
    evidence: probe(),
    now: () => NOW,
    profile: profile(),
  };
  Object.defineProperty(hostileInput, 'policy', counted(POLICY));

  expect(
    evaluateSpansCapabilities({
      evidence,
      now: () => NOW,
      policy: POLICY,
      profile: profile(),
    })
  ).toMatchObject({ code: 'EVIDENCE_INVALID', ok: false });
  expect(
    evaluateSpansCapabilities({
      evidence: probe(),
      now: () => NOW,
      policy: POLICY,
      profile: requested,
    })
  ).toMatchObject({ code: 'PROFILE_INVALID', ok: false });
  expect(evaluateSpansCapabilities(hostileInput)).toMatchObject({
    code: 'EVALUATION_FAILED',
    ok: false,
  });
  expect(calls).toBe(0);
});

test('a forged toJSON is refused and never supplies the probe', () => {
  const forged = probe({ session: { origin: 'resumed' } });
  forged.toJSON = () => probe();

  const result = evaluateSpansCapabilities({
    evidence: forged,
    now: () => NOW,
    policy: POLICY,
    profile: profile(),
  });

  expect(result).toMatchObject({ code: 'EVIDENCE_INVALID', ok: false });
  expect(result).not.toHaveProperty('launch');
  expect(
    run({ evidenceChanges: { identity: { toJSON: 'forged' } } })
  ).toMatchObject({ code: 'EVIDENCE_INVALID', ok: false });
  expect(run({ profileChanges: { toJSON: () => profile() } })).toMatchObject({
    code: 'PROFILE_INVALID',
    ok: false,
  });
});

test('values outside plain JSON are refused rather than copied', () => {
  const cyclic = {};
  cyclic.self = cyclic;
  const sparse = new Array(3);
  sparse[0] = 'a';
  sparse[2] = 'c';
  const extraArrayProperty = ['a'];
  extraArrayProperty.extra = 'x';
  class Identity {}
  const symbolKey = probe();
  symbolKey[Symbol('hidden')] = 'x';
  const hiddenKey = probe();
  Object.defineProperty(hiddenKey, 'hidden', { enumerable: false, value: 'x' });

  const changes = [
    { notes: () => 'x' },
    { notes: Symbol('x') },
    { notes: 1n },
    { cost: { enforcement: Number.NaN } },
    { cost: { enforcement: Number.POSITIVE_INFINITY } },
    { notes: cyclic },
    { notes: ['a', undefined] },
    { notes: sparse },
    { notes: extraArrayProperty },
    { notes: new Map() },
    { notes: new Date(0) },
    { notes: new Identity() },
  ];
  for (const evidenceChanges of changes) {
    expect(run({ evidenceChanges })).toMatchObject({
      code: 'EVIDENCE_INVALID',
      ok: false,
    });
  }
  for (const evidence of [symbolKey, hiddenKey]) {
    expect(
      evaluateSpansCapabilities({
        evidence,
        now: () => NOW,
        policy: POLICY,
        profile: profile(),
      })
    ).toMatchObject({ code: 'EVIDENCE_INVALID', ok: false });
  }
});

test('the snapshot refuses input past its depth, node, byte and collection bounds', () => {
  const nested = (levels) => {
    let node = 'leaf';
    for (let level = 0; level < levels; level += 1) {
      node = { next: node };
    }
    return node;
  };
  const wide = Array.from({ length: 40 }, () =>
    Array.from({ length: 40 }, () => 0)
  );
  const bulk = Array.from({ length: 64 }, () => 'x'.repeat(1000));
  const moreBulk = Array.from({ length: 8 }, () => 'x'.repeat(1000));
  const manyKeys = Object.fromEntries(
    Array.from({ length: 60 }, (_, index) => [`key-${index}`, 1])
  );

  // Depth: evidence is level 0, so seven nested containers fit and eight do not.
  expect(run({ evidenceChanges: { deep: nested(7) } }).ok).toBe(true);
  const overBounds = [
    { deep: nested(8) },
    { wide },
    { bulk, moreBulk },
    { notes: 'x'.repeat(1025) },
    { notes: Array.from({ length: 65 }, () => 'x') },
    manyKeys,
  ];
  for (const evidenceChanges of overBounds) {
    expect(run({ evidenceChanges })).toMatchObject({
      code: 'EVIDENCE_INVALID',
      ok: false,
    });
  }
});

test('the clock is an explicit function and is never defaulted', () => {
  const base = { evidence: probe(), policy: POLICY, profile: profile() };

  expect(evaluateSpansCapabilities(base)).toMatchObject({
    code: 'CLOCK_MISSING',
    ok: false,
  });
  expect(evaluateSpansCapabilities({ ...base, now: NOW })).toMatchObject({
    code: 'CLOCK_MISSING',
    ok: false,
  });
  expect(evaluateSpansCapabilities({ ...base, now: undefined })).toMatchObject({
    code: 'CLOCK_MISSING',
    ok: false,
  });
});

test('unexpected top-level keys are refused', () => {
  const base = {
    evidence: probe(),
    now: () => NOW,
    policy: POLICY,
    profile: profile(),
  };

  expect(
    evaluateSpansCapabilities({ ...base, fallback: 'other-model' })
  ).toMatchObject({ code: 'INPUT_INVALID', ok: false });
  expect(
    evaluateSpansCapabilities({ ...base, [Symbol('hidden')]: true })
  ).toMatchObject({ code: 'INPUT_INVALID', ok: false });
  expect(evaluateSpansCapabilities([])).toMatchObject({
    code: 'INPUT_INVALID',
    ok: false,
  });
});

test('the decision carries the probe provenance without claiming its content was verified', () => {
  const result = run();

  expect(result.provenance).toEqual({
    contentVerified: false,
    digest: `sha256:${PROBE_DIGEST}`,
    observedAt: NOW - 100,
    probeId: 'probe-1',
    source: 'fresh-session-probe',
  });
  const prefixed = run({
    evidenceChanges: {
      provenance: { digest: `sha256:${PROBE_DIGEST}` },
    },
  });
  expect(prefixed.provenance).toEqual(result.provenance);
});

test('an unknown unpriced probe keeps pricing disabled when no hard cap is requested', () => {
  const result = run({
    evidenceChanges: { cost: undefined },
    profileChanges: { requires: { hardCostCap: false } },
  });

  expect(result.ok).toBe(true);
  expect(result.capabilities.pricingEstimate).toEqual({
    enabled: false,
    observed: 'unknown',
    reasons: ['PRICING_UNKNOWN'],
  });
  expect(result.capabilities.hardCostCap).toEqual({
    enabled: false,
    reasons: ['NOT_REQUESTED'],
  });
  expect(result.launch).toEqual({ allowed: true, blockedBy: [] });
  // The capability gate passes here, yet spend is still not authorized.
  expect(result.spend).toEqual({ authorized: false, gate: 'root-usage' });
});
