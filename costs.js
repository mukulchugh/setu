// Cost management — pulls org-level spend from Anthropic's and OpenAI's
// Admin APIs. Read-only: never writes ~/.setu-costs.json (see
// COSTS_CFG_PATH's own comment in lib.js) and never returns a raw key
// value to a caller, only aggregated numbers -- the portal binds 0.0.0.0
// (LAN-reachable), so an endpoint that echoed a key back would be a real
// hole, not a theoretical one.
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

import { loadCostsConfig, commandExists } from './lib.js';

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
  let page;
  do {
    const p = new URLSearchParams(params);
    if (page) p.set('page', page);
    const res = await fetch(`${baseUrl}?${p.toString()}`, { headers });
    if (!res.ok) {
      throw new Error(`${res.status} ${res.statusText}: ${await res.text().catch(() => '')}`);
    }
    const body = await res.json();
    buckets.push(...(body.data ?? []));
    page = body.has_more ? body.next_page : null;
  } while (page);
  return buckets;
}

function summarize(provider, buckets, dateOf, resultsOf, amountOf, labelOf) {
  const byModel = new Map();
  const daily = [];
  let totalCostUsd = 0;
  for (const bucket of buckets) {
    let dayCost = 0;
    for (const r of resultsOf(bucket)) {
      const usd = amountOf(r);
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
  const buckets = await fetchAllPages('https://api.anthropic.com/v1/organizations/cost_report', {
    'group_by[]': 'description',
    starting_at: rfc3339(new Date(Date.now() - WINDOW_DAYS * 86_400_000)),
  }, headers);
  return summarize('anthropic', buckets,
    (b) => b.starting_at.slice(0, 10),
    (b) => b.results,
    (r) => Number(r.amount) / 100,
    (r) => r.model ?? r.description);
}

// ── OpenAI ───────────────────────────────────────────────────────────────
// docs: raw openapi.yaml, CostsResult schema -- amount is {value, currency},
// already in dollars, unlike Anthropic's cents-as-a-string.

async function openaiCosts(adminKey) {
  const headers = { Authorization: `Bearer ${adminKey}` };
  const buckets = await fetchAllPages('https://api.openai.com/v1/organization/costs', {
    'group_by[]': 'line_item',
    limit: String(WINDOW_DAYS),
    start_time: String(Math.floor((Date.now() - WINDOW_DAYS * 86_400_000) / 1000)),
  }, headers);
  return summarize('openai', buckets,
    (b) => new Date(b.start_time * 1000).toISOString().slice(0, 10),
    (b) => b.results,
    (r) => r.amount?.value ?? 0,
    (r) => r.line_item);
}

// ── Gemini (detection only) ─────────────────────────────────────────────

function geminiStatus(cfg) {
  if (!commandExists('gcloud') || !commandExists('bq')) {
    return {
      configured: false,
      provider: 'gemini',
      reason: 'gcloud/bq CLI not installed. Gemini has no admin API — usage/cost needs Google Cloud Billing export to BigQuery. Install the Google Cloud SDK, then check billing setup with `gcloud billing accounts list`.',
    };
  }
  if (!cfg.gemini?.gcpProjectId || !cfg.gemini?.bigQueryDataset) {
    return {
      configured: false,
      provider: 'gemini',
      reason: 'gcloud/bq found, but gcpProjectId/bigQueryDataset are not set in ~/.setu-costs.json. Also requires Cloud Billing export to BigQuery already enabled for your billing account (docs.cloud.google.com/billing/docs/how-to/export-data-bigquery) — not automatic, and not retroactive once enabled.',
    };
  }
  return {
    configured: false,
    provider: 'gemini',
    reason: 'gcloud/bq + config found, but BigQuery querying isn’t implemented yet — this is a detection-only stub.',
  };
}

// ── orchestration ────────────────────────────────────────────────────────

export async function getCostsSummary() {
  const cfg = loadCostsConfig();

  const [anthropic, openai] = await Promise.all([
    cfg.anthropicAdminKey
      ? anthropicCosts(cfg.anthropicAdminKey).catch((e) => ({ configured: true, error: String(e.message ?? e), provider: 'anthropic' }))
      : Promise.resolve({ configured: false, provider: 'anthropic', reason: 'anthropicAdminKey not set in ~/.setu-costs.json' }),
    cfg.openaiAdminKey
      ? openaiCosts(cfg.openaiAdminKey).catch((e) => ({ configured: true, error: String(e.message ?? e), provider: 'openai' }))
      : Promise.resolve({ configured: false, provider: 'openai', reason: 'openaiAdminKey not set in ~/.setu-costs.json' }),
  ]);

  return { anthropic, gemini: geminiStatus(cfg), openai };
}
