import { claudeSubscriptionEnv } from './cli-helpers.js';

// The first provider is Claude Code, driven headlessly. This module only knows
// its command line and its stream-json output. Whatever those lines say is an
// observation: it can describe a session, never authorize or accept anything.

// The built-in profile runs on the owner's Claude subscription: no dollar
// budget is set or enforced, and usage is only ever reported as an estimate.
// `auto` is the permission mode the owner's own sessions already use. The
// toolset is only what coding needs: no sub-agents and no MCP tools, and never
// bypassPermissions. The effort is requested and cannot be seen from outside
// (the client reports none, and an organization can clamp the flag), so the
// profile says plainly that it accepts it unverified.
export const SPANS_EXEC_DEFAULT_PROFILES = Object.freeze({
  'claude-code-sonnet': Object.freeze({
    billing: 'subscription',
    client: 'claude-code',
    effort: 'medium',
    effortPolicy: 'requested-unverified',
    model: 'claude-sonnet-5-5',
    permissionMode: 'auto',
    provider: 'anthropic',
    tools: Object.freeze(['Bash', 'Edit', 'Glob', 'Grep', 'Read', 'Write']),
  }),
});

// True for a profile definition or for an execution record: both carry
// `billing`.
export const isSubscription = (record) => record?.billing === 'subscription';

const ISOLATION = Object.freeze({ restricted: true, settingSources: 'none' });

// The reviewed launch plan: everything about how the session is configured
// that a person approves and that the run is later held to.
export const launchModeOf = (definition) => ({
  billing: isSubscription(definition) ? 'subscription' : 'metered',
  effort: {
    policy: definition.effortPolicy ?? 'observed',
    requested: definition.effort,
  },
  // Every session starts without the user's, the project's or the local
  // settings, hooks or memory files (`--restricted`, no setting sources). Named
  // tools still work. Managed (organization) settings can still apply.
  isolation: ISOLATION,
  model: definition.model,
  permissionMode: definition.permissionMode,
  tools: definition.tools ? [...definition.tools].sort() : null,
});

// What a probe's budget stop proves about a cost cap. Claude Code documents its
// budget as a client-side estimate that stops the session after the response
// that crosses it, so no sample, even one that stayed under the cap, shows a
// ceiling. A stop is therefore only ever `estimated`, never `enforced`, and a
// metered Claude profile cannot satisfy a hard cost cap.
export const budgetEnforcement = (result) =>
  result?.subtype === 'error_max_budget_usd' ? 'estimated' : 'unavailable';

// Below one tenth of a cent a metered session must stop at its first spend.
// That is how the probe observes whether the cap is enforced instead of
// assuming it. The provider documents its budget as a client-side estimate that
// may overshoot, so what the probe records is the stop and the amount spent,
// not a ceiling. A subscription probe sets no budget at all.
export const SPANS_EXEC_PROBE_BUDGET_USD = 0.0001;
export const SPANS_EXEC_PROBE_PROMPT =
  'Reply with the single word ok. Do not use any tool.';

export function providerEnvironment(extra = {}) {
  return { ...claudeSubscriptionEnv(), ...extra };
}

// The command line of a Claude Code worker or probe, from one place. The first
// two flags isolate the session from ambient settings, hooks and memory files
// (see ISOLATION; the headless run and the PR review do not do this). The rest:
// no user MCP servers, no permission prompts, an explicit permission mode, a
// named toolset, and for a metered profile a budget the provider stops at after
// the response that crosses it. A subscription profile passes no budget.
export function providerArguments(
  command,
  { effort, maxBudgetUsd, model, permissionMode, tools }
) {
  return [
    ...command,
    '--restricted',
    '--setting-sources',
    '',
    '--strict-mcp-config',
    '-p',
    '-',
    '--output-format',
    'stream-json',
    '--verbose',
    ...(maxBudgetUsd === undefined
      ? []
      : ['--max-budget-usd', String(maxBudgetUsd)]),
    '--permission-mode',
    permissionMode,
    '--permission-prompts',
    'none',
    ...(Array.isArray(tools) ? ['--tools', tools.join(',')] : []),
    '--model',
    model,
    '--effort',
    effort,
  ];
}

function parseLine(line) {
  try {
    const value = JSON.parse(line);
    return value !== null && typeof value === 'object' && !Array.isArray(value)
      ? value
      : null;
  } catch {
    return null;
  }
}

const text = (value) => (typeof value === 'string' && value ? value : null);
const COST_EPSILON_USD = 1e-9;

// The result's total can be compared with the per-model costs the same result
// reports. This only shows the provider's own figures agree with each other. It
// is not an independent measure and not the amount billed.
function costCheckOf(result, total) {
  if (total === null) {
    return 'absent';
  }
  const usage = result.modelUsage;
  if (usage === null || typeof usage !== 'object' || Array.isArray(usage)) {
    return 'single-field';
  }
  const costs = Object.values(usage).map((entry) => entry?.costUSD);
  if (costs.length === 0 || !costs.every(Number.isFinite)) {
    return 'single-field';
  }
  const sum = costs.reduce((left, right) => left + right, 0);
  return Math.abs(sum - total) <= COST_EPSILON_USD
    ? 'self-consistent'
    : 'mismatch';
}

const TOKEN_FIELDS = Object.freeze([
  ['cacheCreationInputTokens', 'cacheCreation'],
  ['cacheReadInputTokens', 'cacheRead'],
  ['inputTokens', 'input'],
  ['outputTokens', 'output'],
]);
const countOf = (value) =>
  Number.isSafeInteger(value) && value >= 0 ? value : 0;

// Token counts the result reports per model, summed. They are the provider's
// own figures for its own session: an estimate of use, not a bill.
function tokensOf(result) {
  const usage = result?.modelUsage;
  if (usage === null || typeof usage !== 'object' || Array.isArray(usage)) {
    return null;
  }
  const total = { cacheCreation: 0, cacheRead: 0, input: 0, output: 0 };
  for (const entry of Object.values(usage)) {
    for (const [field, key] of TOKEN_FIELDS) {
      total[key] += countOf(entry?.[field]);
    }
  }
  return total;
}

// Reads provider output for what it observably said. Unknown lines are ignored.
export function summarizeProviderOutput(output) {
  let init = null;
  let result = null;
  for (const line of String(output).split('\n')) {
    const event = parseLine(line);
    if (!event) {
      continue;
    }
    if (event.type === 'system' && event.subtype === 'init' && !init) {
      init = event;
    }
    if (event.type === 'result') {
      result = event;
    }
  }
  const cost =
    result &&
    Number.isFinite(result.total_cost_usd) &&
    result.total_cost_usd >= 0
      ? result.total_cost_usd
      : null;
  return {
    cost,
    costCheck: result ? costCheckOf(result, cost) : 'absent',
    init: init && {
      effort: text(init.effort),
      model: text(init.model),
      permissionMode: text(init.permissionMode),
      perTurnEffortActive: init.per_turn_effort_active === true,
      sessionId: text(init.session_id),
      tools: Array.isArray(init.tools)
        ? init.tools.filter((tool) => typeof tool === 'string')
        : [],
    },
    result: result && {
      isError: result.is_error === true,
      subtype: text(result.subtype),
    },
    tokens: result ? tokensOf(result) : null,
  };
}
