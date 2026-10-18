import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { evaluateSpansCapabilities } from './spans-capabilities.js';
import { digestOf, isRecord, sha256, toMicro } from './spans-execution-core.js';
import {
  budgetEnforcement,
  isSubscription,
  providerArguments,
  providerEnvironment,
  SPANS_EXEC_PROBE_BUDGET_USD,
  SPANS_EXEC_PROBE_PROMPT,
  summarizeProviderOutput,
} from './spans-execution-provider.js';

// Capability evidence comes from one place: a fresh provider session that this
// module starts itself and reads the output of. Evidence is stored under the
// profile it describes, and nothing a caller, a peer or a model sends can
// create it. The stored record is only an observation; whether a launch is
// allowed is decided again, from that record, on every use.

const KEY_PREFIX = 'execution.probe.';
const SPEND_KEY = 'execution.probe-spend';
const PROBE_OUTPUT_BYTES = 64 * 1024;
const PROBE_WALL_CLOCK_MS = 120_000;
const DEFAULT_POLICY = Object.freeze({
  maxClockSkewMs: 60_000,
  maxEvidenceAgeMs: 6 * 60 * 60 * 1000,
});

const evidenceKey = (profileId) => `${KEY_PREFIX}${profileId}`;

// A metered profile requires a hard cost cap. A subscription profile sets no
// monetary cap, so it requires none and the gate does not pretend otherwise.
function requirementsOf(definition) {
  return {
    ...(isSubscription(definition) ? {} : { hardCostCap: true }),
    permissions: { mode: definition.permissionMode },
    ...(definition.tools ? { tools: [...definition.tools] } : {}),
  };
}

function capabilityProfile(definition, sessionId) {
  return {
    client: definition.client,
    effort: definition.effort,
    ...(definition.effortPolicy
      ? { effortPolicy: definition.effortPolicy }
      : {}),
    model: definition.model,
    provider: definition.provider,
    requires: requirementsOf(definition),
    sessionId,
  };
}

function toolsSeen(tools, definition) {
  const extra =
    definition.tools && tools.some((tool) => !definition.tools.includes(tool));
  return extra
    ? {}
    : Object.fromEntries(tools.map((tool) => [tool, 'available']));
}

function observedEvidence(summary, definition, { now, rawDigest }) {
  const { init, result } = summary;
  if (!(init?.sessionId && result)) {
    return null;
  }
  // A subscription probe has no budget stop to expect: it must have answered.
  if (
    isSubscription(definition) &&
    !(result.isError === false && result.subtype === 'success')
  ) {
    return null;
  }
  const identity = {
    client: definition.client,
    provider: definition.provider,
  };
  if (init.model) {
    identity.model = init.model;
  }
  if (init.effort) {
    identity.effort = init.effort;
  }
  const evidence = {
    connected: true,
    cost: isSubscription(definition)
      ? // No budget was set, so no cap was observed: not enforced, not priced.
        { enforcement: 'unavailable' }
      : {
          enforcement: budgetEnforcement(summary.result),
          ...(summary.cost === null || summary.costCheck === 'mismatch'
            ? {}
            : { pricing: 'known' }),
        },
    identity,
    installed: true,
    observedAt: now(),
    provenance: {
      digest: `sha256:${rawDigest}`,
      probeId: `probe-${rawDigest.slice(0, 16)}`,
      source: 'fresh-session-probe',
    },
    session: { id: init.sessionId, origin: 'fresh' },
    // A session with a tool the profile did not name is not the reviewed
    // toolset, so none of its tools count as verified.
    tools: toolsSeen(init.tools, definition),
  };
  if (init.permissionMode) {
    evidence.permissions = { mode: init.permissionMode, status: 'verified' };
  }
  return evidence;
}

// What the probe saw that the capability gate does not decide on, kept beside
// the evidence so a reader can tell observed from requested. Effort is only
// ever observed when the session itself reported it; the requested flag and a
// per-turn self-report are shown but never promoted.
function observationsOf(summary, definition, capUsd) {
  const effort = {
    observed: summary.init?.effort ?? null,
    perTurnEffortActive: summary.init?.perTurnEffortActive === true,
    policy: definition.effortPolicy ?? 'observed',
    requested: definition.effort,
  };
  if (isSubscription(definition)) {
    return {
      billing: 'subscription',
      effort,
      // What the session reported about itself. The dollar figure is the
      // provider's estimate of API-equivalent cost, not a charge to the owner.
      usage: {
        apiEquivalentUsd: summary.cost,
        billed: 'unknown',
        costCheck: summary.costCheck,
        tokens: summary.tokens,
      },
    };
  }
  return {
    budget: {
      capUsd,
      costCheck: summary.costCheck,
      costUsd: summary.cost,
      overshot: summary.cost !== null && summary.cost > capUsd,
      stop: summary.result?.subtype === 'error_max_budget_usd',
    },
    effort,
  };
}

async function readBounded(stream, limit) {
  const chunks = [];
  let length = 0;
  for await (const chunk of stream) {
    length += chunk.byteLength;
    if (length > limit) {
      return null;
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

export function createSpansCapability({
  command,
  env = {},
  now = Date.now,
  policy = DEFAULT_POLICY,
  profiles,
  spawn = Bun.spawn,
  store,
}) {
  const definitionOf = (profileId) =>
    Object.hasOwn(profiles, profileId) ? profiles[profileId] : null;

  function stored(profileId) {
    const read = store.readCache(evidenceKey(profileId));
    return read?.ok === true && isRecord(read.entry) ? read.entry : null;
  }

  function evaluate(profileId) {
    const definition = definitionOf(profileId);
    if (!definition) {
      return { code: 'PROFILE_UNKNOWN', ok: false };
    }
    const record = stored(profileId);
    if (!record?.evidence) {
      return { code: 'EVIDENCE_MISSING', definition, ok: false };
    }
    const result = evaluateSpansCapabilities({
      evidence: record.evidence,
      now,
      policy,
      profile: capabilityProfile(definition, record.evidence.session?.id),
    });
    return { definition, record, result };
  }

  // Every probe is a real provider session. What each reports is kept in one
  // running total so it is never invisible. A metered probe's figure is the
  // reported charge; a subscription probe's is an estimate and a token count,
  // never a charge.
  function probeSpend() {
    const read = store.readCache(SPEND_KEY);
    const entry = read?.ok === true && isRecord(read.entry) ? read.entry : {};
    const count = (value) => (Number.isSafeInteger(value) ? value : 0);
    return {
      estimatedApiEquivalentMicro: count(entry.estimatedApiEquivalentMicro),
      estimatedTokens: count(entry.estimatedTokens),
      probes: count(entry.probes),
      subscriptionProbes: count(entry.subscriptionProbes),
      totalMicro: count(entry.totalMicro),
      unpriced: count(entry.unpriced),
    };
  }

  function accountProbe(summary, definition) {
    const before = probeSpend();
    const micro = summary.cost === null ? 0 : toMicro(summary.cost);
    const tokens = summary.tokens
      ? Object.values(summary.tokens).reduce((left, right) => left + right, 0)
      : 0;
    const subscription = isSubscription(definition);
    store.writeCache(SPEND_KEY, {
      ...before,
      estimatedApiEquivalentMicro:
        before.estimatedApiEquivalentMicro + (subscription ? micro : 0),
      estimatedTokens: before.estimatedTokens + (subscription ? tokens : 0),
      probes: before.probes + 1,
      subscriptionProbes: before.subscriptionProbes + (subscription ? 1 : 0),
      totalMicro: before.totalMicro + (subscription ? 0 : micro),
      unpriced: before.unpriced + (summary.cost === null ? 1 : 0),
    });
  }

  // What a profile can do right now, from stored probe evidence alone.
  function capabilities(profileId) {
    const evaluated = evaluate(profileId);
    if (evaluated.code === 'PROFILE_UNKNOWN') {
      return { code: 'SPANS_EXEC_PROFILE_UNKNOWN', ok: false };
    }
    if (!evaluated.result) {
      return {
        launch: { allowed: false, blockedBy: ['session'] },
        ok: true,
        profile: profileId,
        reason: evaluated.code,
      };
    }
    const { result } = evaluated;
    if (!result.ok) {
      return {
        launch: { allowed: false, blockedBy: ['session'] },
        ok: true,
        profile: profileId,
        reason: result.code,
      };
    }
    return {
      evidenceAgeMs: result.evidenceAgeMs,
      launch: result.launch,
      observations: evaluated.record.observations ?? null,
      ok: true,
      probeSpend: probeSpend(),
      profile: profileId,
      provenance: result.provenance,
    };
  }

  // The dispatch coordinator's capability contract. The profile digest names
  // the profile definition and the exact probe, so a new probe or a changed
  // definition during a dispatch is seen as a changed profile.
  function verify({ profile: profileId }) {
    const evaluated = evaluate(profileId);
    if (!evaluated.result?.ok) {
      return { ok: false };
    }
    const { definition, record, result } = evaluated;
    const verified = Object.entries(result.capabilities)
      .filter(([, capability]) => capability.enabled)
      .map(([name]) => name);
    if (result.launch.allowed) {
      verified.push('launch');
    }
    return {
      ok: true,
      profile: {
        digest: digestOf({
          definition,
          probe: result.provenance.digest,
          sessionId: record.evidence.session.id,
        }),
        id: profileId,
      },
      verified: verified.sort(),
    };
  }

  async function runProbe(definition) {
    const cwd = await mkdtemp(join(tmpdir(), 'setu-probe-'));
    let child;
    try {
      child = spawn(
        providerArguments(command, {
          effort: definition.effort,
          // A subscription probe sets no budget: it is one short reply.
          maxBudgetUsd: isSubscription(definition)
            ? undefined
            : SPANS_EXEC_PROBE_BUDGET_USD,
          model: definition.model,
          permissionMode: definition.permissionMode,
          tools: definition.tools,
        }),
        {
          cwd,
          env: providerEnvironment(env),
          stderr: 'ignore',
          stdin: 'pipe',
          stdout: 'pipe',
        }
      );
      child.stdin.write(SPANS_EXEC_PROBE_PROMPT);
      child.stdin.end();
      const timer = setTimeout(
        () => child.kill('SIGKILL'),
        PROBE_WALL_CLOCK_MS
      );
      const output = await readBounded(child.stdout, PROBE_OUTPUT_BYTES);
      await child.exited;
      clearTimeout(timer);
      return output;
    } catch {
      child?.kill('SIGKILL');
      return null;
    } finally {
      await rm(cwd, { force: true, recursive: true });
    }
  }

  // Starts one fresh, capped provider session and records only what it showed.
  async function probe(profileId) {
    const definition = definitionOf(profileId);
    if (!definition) {
      return { code: 'SPANS_EXEC_PROFILE_UNKNOWN', ok: false };
    }
    const output = await runProbe(definition);
    if (output === null) {
      return { code: 'SPANS_EXEC_PROBE_FAILED', ok: false };
    }
    const summary = summarizeProviderOutput(output);
    // The session ran and may have charged, whatever else it showed.
    accountProbe(summary, definition);
    const capUsd = SPANS_EXEC_PROBE_BUDGET_USD;
    const evidence = observedEvidence(summary, definition, {
      now,
      rawDigest: sha256(output),
    });
    if (!evidence) {
      return { code: 'SPANS_EXEC_PROBE_INCONCLUSIVE', ok: false };
    }
    const saved = store.writeCache(evidenceKey(profileId), {
      evidence,
      observations: observationsOf(summary, definition, capUsd),
      profileId,
    });
    if (saved?.ok !== true) {
      return { code: 'SPANS_EXEC_PROBE_NOT_RECORDED', ok: false };
    }
    return capabilities(profileId);
  }

  // What the usage ledger needs to know about a profile: whether its price is
  // known and whether the provider was observed to enforce a hard cap.
  function usageFacts(profileId) {
    const evaluated = evaluate(profileId);
    if (!evaluated.result?.ok) {
      return null;
    }
    const { capabilities: observed } = evaluated.result;
    return {
      billing: isSubscription(evaluated.definition)
        ? 'subscription'
        : 'metered',
      enforcementAvailable: observed.hardCostCap.enabled,
      priceKnown: observed.pricingEstimate.enabled,
    };
  }

  return Object.freeze({ capabilities, probe, usageFacts, verify });
}
