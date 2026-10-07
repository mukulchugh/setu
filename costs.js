// Cost management — pulls org-level spend from Anthropic's and OpenAI's
// Admin APIs. Read-only: never writes ~/.setu-costs.json (see
// COSTS_CFG_PATH's own comment in lib.js) and never returns a raw key
// value to a caller, only aggregated numbers.
//
// Gemini has no equivalent admin/usage API (verified against
// ai.google.dev/gemini-api/docs/billing): spend is only visible in the AI
// Studio web UI, or via Cloud Billing export to BigQuery -- a GCP project +
// linked billing account + billing export enabled ahead of time (not
// retroactive), queried with `gcloud`/`bq`, not a single REST call. This
// file only detects whether that's set up; it doesn't attempt to build the
// BigQuery integration itself (out of scope until someone actually has that
// infra running).
//
// Cost-only for v1, not also token usage -- "cost management" is about
// dollars; usage_report/organization.usage.* are a separate, larger API
// surface (Anthropic's usage endpoint is one call, OpenAI's is split per
// endpoint family -- completions/embeddings/images/...) that can be added
// later if actually wanted.

import { commandExists, loadCostsConfig } from './lib.js';

const WINDOW_DAYS = 30;

function round2(n) {
  return Math.round(n * 100) / 100;
}

// RFC3339 without fractional seconds, matching Anthropic's own doc examples
// ("2025-01-08T00:00:00Z") exactly rather than trusting a picky parser to
// accept toISOString()'s milliseconds.
function rfc3339(d) {
  return d.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

async function fetchAllPages(baseUrl, params, headers) {
  const buckets = [];
  const seen = new Set();
  const signal = AbortSignal.timeout(15_000);
  let page;
  do {
    const p = new URLSearchParams(params);
    if (page) {
      p.set('page', page);
    }
    const res = await fetch(`${baseUrl}?${p.toString()}`, { headers, signal });
    if (!res.ok) {
      throw new Error(
        `${res.status} ${res.statusText}: ${await res.text().catch(() => '')}`
      );
    }
    const body = await res.json();
    buckets.push(...(body.data ?? []));
    page = body.has_more ? body.next_page : null;
    if (body.has_more && (!page || seen.has(page) || seen.size >= 100)) {
      throw new Error('Invalid cost pagination');
    }
    if (page) {
      seen.add(page);
    }
  } while (page);
  return buckets;
}

// Trailing totals, not calendar-aligned ones -- "last 7 days" as of the
// moment of the request, not "since Monday". daily is already oldest-first
// from fetchAllPages, so the trailing N days is just the last N entries;
// no extra API calls, this is derived from the same 30-day fetch summarize()
// already does.
function windowTotal(daily, days) {
  return round2(daily.slice(-days).reduce((sum, d) => sum + d.costUsd, 0));
}

function summarize(provider, buckets, dateOf, resultsOf, amountOf, labelOf) {
  const byModel = new Map();
  const daily = [];
  let totalCostUsd = 0;
  for (const bucket of buckets) {
    let dayCost = 0;
    for (const r of resultsOf(bucket)) {
      const usd = amountOf(r);
      if (!Number.isFinite(usd)) {
        throw new Error(`Invalid ${provider} cost amount`);
      }
      dayCost += usd;
      totalCostUsd += usd;
      const label = labelOf(r) ?? 'other';
      byModel.set(label, (byModel.get(label) ?? 0) + usd);
    }
    daily.push({ costUsd: round2(dayCost), date: dateOf(bucket) });
  }
  return {
    byModel: [...byModel.entries()]
      .map(([model, costUsd]) => ({ costUsd: round2(costUsd), model }))
      .sort((a, b) => b.costUsd - a.costUsd),
    configured: true,
    daily,
    last1d: windowTotal(daily, 1),
    last7d: windowTotal(daily, 7),
    last30d: windowTotal(daily, 30),
    provider,
    totalCostUsd: round2(totalCostUsd),
    windowDays: WINDOW_DAYS,
  };
}

// ── Anthropic ────────────────────────────────────────────────────────────
// docs: platform.claude.com/docs/en/api/admin-api/usage-cost/get-cost-report
// amount is in CENTS as a decimal string ("123.45" USD == $1.23) -- not
// dollars, despite the decimal formatting looking like it could be either.

async function anthropicCosts(adminKey) {
  const headers = { 'anthropic-version': '2023-06-01', 'x-api-key': adminKey };
  const buckets = await fetchAllPages(
    'https://api.anthropic.com/v1/organizations/cost_report',
    {
      'group_by[]': 'description',
      starting_at: rfc3339(new Date(Date.now() - WINDOW_DAYS * 86_400_000)),
    },
    headers
  );
  return summarize(
    'anthropic',
    buckets,
    (b) => b.starting_at.slice(0, 10),
    (b) => b.results,
    (r) =>
      r.amount === null || r.amount === undefined
        ? Number.NaN
        : Number(r.amount) / 100,
    (r) => r.model ?? r.description
  );
}

// ── OpenAI ───────────────────────────────────────────────────────────────
// docs: raw openapi.yaml, CostsResult schema -- amount is {value, currency},
// already in dollars, unlike Anthropic's cents-as-a-string.

async function openaiCosts(adminKey) {
  const headers = { Authorization: `Bearer ${adminKey}` };
  const buckets = await fetchAllPages(
    'https://api.openai.com/v1/organization/costs',
    {
      'group_by[]': 'line_item',
      limit: String(WINDOW_DAYS),
      start_time: String(
        Math.floor((Date.now() - WINDOW_DAYS * 86_400_000) / 1000)
      ),
    },
    headers
  );
  return summarize(
    'openai',
    buckets,
    (b) => new Date(b.start_time * 1000).toISOString().slice(0, 10),
    (b) => b.results,
    (r) =>
      r.amount?.value === null || r.amount?.value === undefined
        ? Number.NaN
        : Number(r.amount.value),
    (r) => r.line_item
  );
}

// ── Gemini (detection only) ─────────────────────────────────────────────

function geminiStatus(cfg) {
  if (!(commandExists('gcloud') && commandExists('bq'))) {
    return {
      configured: false,
      provider: 'gemini',
      reason:
        'gcloud/bq CLI not installed. Gemini has no admin API — usage/cost needs Google Cloud Billing export to BigQuery. Install the Google Cloud SDK, then check billing setup with `gcloud billing accounts list`.',
    };
  }
  if (!(cfg.gemini?.gcpProjectId && cfg.gemini?.bigQueryDataset)) {
    return {
      configured: false,
      provider: 'gemini',
      reason:
        'gcloud/bq found, but gcpProjectId/bigQueryDataset are not set in ~/.setu-costs.json. Also requires Cloud Billing export to BigQuery already enabled for your billing account (docs.cloud.google.com/billing/docs/how-to/export-data-bigquery) — not automatic, and not retroactive once enabled.',
    };
  }
  return {
    configured: false,
    provider: 'gemini',
    reason:
      'gcloud/bq + config found, but BigQuery querying isn’t implemented yet — this is a detection-only stub.',
  };
}

// ── budgets ──────────────────────────────────────────────────────────────
// Combined across whatever providers actually returned real numbers this
// request -- a provider that's unconfigured or errored just contributes 0,
// it doesn't block the other two from being budgeted. Thresholds are opt-in
// per period (~/.setu-costs.json's "budgets": {daily,weekly,monthly}); a
// period with no configured limit is simply omitted from the response, not
// shown as some default. "warning" at 80% of limit, "over" at 100%+ --
// tokentop's own "visual warnings" framing, not an arbitrary threshold.
function budgetStatus(spent, limit) {
  if (spent >= limit) {
    return 'over';
  }
  if (spent * 5 >= limit * 4) {
    return 'warning';
  }
  return 'ok';
}

function computeBudgets(cfg, providers) {
  const b = cfg.budgets;
  if (!b) {
    return null;
  }
  const spent = { last1d: 0, last7d: 0, last30d: 0 };
  let incomplete =
    !providers.some((p) => p.configured && !p.error) ||
    providers.some((p) => p.configured && p.error) ||
    !!(cfg.gemini?.gcpProjectId && cfg.gemini?.bigQueryDataset);
  for (const p of providers) {
    if (!p.configured || p.error) {
      continue;
    }
    for (const key of Object.keys(spent)) {
      if (!Number.isFinite(p[key])) {
        incomplete = true;
        spent[key] = Number.NaN;
      } else {
        spent[key] += p[key];
      }
    }
  }
  const periods = {
    daily: ['last1d', b.daily],
    monthly: ['last30d', b.monthly],
    weekly: ['last7d', b.weekly],
  };
  const out = {};
  for (const [period, [key, limit]] of Object.entries(periods)) {
    if (!Number.isFinite(limit) || limit <= 0) {
      continue;
    }
    const s = Number.isFinite(spent[key]) ? round2(spent[key]) : null;
    out[period] = {
      incomplete,
      limit,
      spent: s,
      status: !Number.isFinite(s)
        ? 'incomplete'
        : s >= limit
          ? 'over'
          : incomplete
            ? 'incomplete'
            : budgetStatus(s, limit),
    };
  }
  return Object.keys(out).length ? out : null;
}

// ── orchestration ────────────────────────────────────────────────────────

let costsInFlight = null,
  costsCachedAt = 0;
export function getCostsSummary() {
  if (!costsInFlight || Date.now() - costsCachedAt > 60_000) {
    costsCachedAt = Date.now();
    costsInFlight = computeCostsSummary().catch((error) => {
      costsInFlight = null;
      throw error;
    });
  }
  return costsInFlight;
}

async function computeCostsSummary() {
  const cfg = loadCostsConfig();
  // ~/.setu-costs.json is still the primary source (see COSTS_CFG_PATH's
  // comment in lib.js on why this is never portal-writable) -- env vars are
  // a same-machine, already-trusted fallback for whichever key isn't in the
  // file, not a new input surface. Nothing here ever reads from the request
  // itself, so this doesn't reopen the LAN-exposed-portal concern.
  const anthropicKey = cfg.anthropicAdminKey || process.env.ANTHROPIC_ADMIN_KEY;
  const openaiKey = cfg.openaiAdminKey || process.env.OPENAI_ADMIN_KEY;

  const [anthropic, openai] = await Promise.all([
    anthropicKey
      ? anthropicCosts(anthropicKey).catch((e) => ({
          configured: true,
          error: String(e.message ?? e),
          provider: 'anthropic',
        }))
      : Promise.resolve({
          configured: false,
          provider: 'anthropic',
          reason:
            'anthropicAdminKey not set in ~/.setu-costs.json (or $ANTHROPIC_ADMIN_KEY)',
        }),
    openaiKey
      ? openaiCosts(openaiKey).catch((e) => ({
          configured: true,
          error: String(e.message ?? e),
          provider: 'openai',
        }))
      : Promise.resolve({
          configured: false,
          provider: 'openai',
          reason:
            'openaiAdminKey not set in ~/.setu-costs.json (or $OPENAI_ADMIN_KEY)',
        }),
  ]);

  return {
    anthropic,
    budgets: computeBudgets(cfg, [anthropic, openai]),
    gemini: geminiStatus(cfg),
    openai,
  };
}
