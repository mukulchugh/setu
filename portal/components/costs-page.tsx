// Provider-reported cost totals. Credentials are configured outside this UI.
import {
  type Budgets,
  parseCostsSummary,
  type ProviderCosts,
} from '../costs-read';
import { PageHeader } from '../ui';
import { Badge } from '../ui/badge';
import { Button } from '../ui/button';
import { readJson, useVisiblePoll } from '../use-visible-poll';

const PROVIDER_LABEL: Record<string, string> = {
  anthropic: 'Anthropic (Claude)',
  gemini: 'Gemini',
  openai: 'OpenAI',
};

function fmtUsd(n: number) {
  return n.toLocaleString('en-US', { currency: 'USD', style: 'currency' });
}

const BUDGET_TONE = {
  incomplete: 'amber',
  ok: 'emerald',
  over: 'red',
  warning: 'amber',
} as const;
const BUDGET_LABEL = {
  daily: 'Daily',
  monthly: 'Monthly (30d)',
  weekly: 'Weekly (7d)',
} as const;

function BudgetBar({ budgets }: { budgets: Budgets }) {
  const periods = (['daily', 'weekly', 'monthly'] as const).filter(
    (k) => budgets[k]
  );
  if (!periods.length) {
    return null;
  }
  return (
    <div class="glass-panel mb-5 flex flex-wrap items-center gap-4 px-5 py-4">
      {periods.map((period) => {
        const p = budgets[period]!;
        return (
          <div class="flex flex-wrap items-center gap-2 text-sm" key={period}>
            <Badge tone={BUDGET_TONE[p.status]}>
              {p.status === 'ok'
                ? 'Within budget'
                : p.status === 'over'
                  ? 'Over budget'
                  : p.status === 'warning'
                    ? 'Near budget'
                    : 'Incomplete'}
            </Badge>
            <span class="text-zinc-500 dark:text-zinc-400">
              {BUDGET_LABEL[period]}
            </span>
            <span class="font-mono font-semibold text-zinc-900 tabular-nums dark:text-zinc-100">
              {fmtUsd(p.spent)}
            </span>
            <span class="text-zinc-300 dark:text-zinc-600">
              / {fmtUsd(p.limit)}
            </span>
            {p.incomplete && (
              <span class="text-signal-amber">Incomplete provider data</span>
            )}
          </div>
        );
      })}
    </div>
  );
}

function ProviderCard({ data }: { data: ProviderCosts }) {
  const label = PROVIDER_LABEL[data.provider] ?? data.provider;
  return (
    <div class="glass-panel min-w-0 p-5">
      <div class="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h3 class="font-semibold text-sm text-zinc-900 dark:text-zinc-100">
          {label}
        </h3>
        <Badge tone={data.error ? 'red' : data.configured ? 'emerald' : 'zinc'}>
          {data.error
            ? 'Read failed'
            : data.configured
              ? 'Connected'
              : data.provider === 'gemini'
                ? 'Detection only'
                : 'Not configured'}
        </Badge>
      </div>

      {!data.configured && (
        <p class="text-xs text-zinc-400 leading-relaxed">{data.reason}</p>
      )}
      {data.error && (
        <p class="text-signal-red text-xs leading-relaxed">{data.error}</p>
      )}

      {data.configured && !data.error && (
        <>
          <p class="board-mono mb-1 font-bold text-2xl text-zinc-900 dark:text-zinc-100">
            {data.totalCostUsd === undefined
              ? 'Unavailable'
              : fmtUsd(data.totalCostUsd)}
          </p>
          <p class="mb-4 text-[11px] text-zinc-400">
            {data.windowDays
              ? `Last ${data.windowDays} days`
              : 'Reporting window unavailable'}
          </p>
          <div class="flex flex-col gap-1.5">
            {(data.byModel ?? []).map((m) => (
              <div
                class="flex items-center justify-between gap-3 text-xs"
                key={m.model}
              >
                <span class="truncate text-zinc-500 dark:text-zinc-400">
                  {m.model}
                </span>
                <span class="shrink-0 font-mono text-zinc-700 tabular-nums dark:text-zinc-300">
                  {fmtUsd(m.costUsd)}
                </span>
              </div>
            ))}
            {!data.byModel?.length && (
              <p class="text-sm text-zinc-600 dark:text-zinc-300">
                {data.totalCostUsd === 0
                  ? 'No spend reported in this window.'
                  : 'No model breakdown available.'}
              </p>
            )}
          </div>
        </>
      )}
    </div>
  );
}

export function CostsPage({ onBack }: { onBack: () => void }) {
  const { data, failed, checkedAt, refresh } = useVisiblePoll(
    'costs',
    null,
    async (signal) =>
      parseCostsSummary(await readJson<unknown>('/api/costs', signal))
  );
  const loaded = data !== undefined;

  return (
    <div class="portal-page mx-auto max-w-5xl px-4 py-6 sm:px-6">
      <PageHeader
        actions={
          <Button compact onClick={refresh} variant="secondary">
            Refresh costs
          </Button>
        }
        back={{ label: 'All worktrees', onClick: onBack }}
        subtitle={
          <span class="text-xs text-zinc-400">
            Provider-reported API spend for Anthropic and OpenAI. Gemini
            availability is detected; its spend is not reported here.
          </span>
        }
        title="Costs"
      />

      {failed && (
        <p class="read-notice" role="status">
          Could not refresh costs.{' '}
          {data
            ? 'Showing the last successful read. '
            : 'No totals are available. '}
          <button class="underline" onClick={refresh} type="button">
            Retry
          </button>
        </p>
      )}
      {checkedAt && (
        <p class="mb-4 text-xs text-zinc-600 dark:text-zinc-300">
          Last received {new Date(checkedAt).toLocaleTimeString()}. Provider
          totals can arrive later than usage.
        </p>
      )}
      {loaded ? (
        data ? (
          <>
            {data.budgets && <BudgetBar budgets={data.budgets} />}
            <div class="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
              <ProviderCard data={data.anthropic} />
              <ProviderCard data={data.openai} />
              <ProviderCard data={data.gemini} />
            </div>
          </>
        ) : (
          <p class="py-12 text-center text-zinc-400">
            Couldn't reach the portal.
          </p>
        )
      ) : (
        !failed && <p class="empty-state">Loading provider costs…</p>
      )}

      <p class="mt-6 max-w-2xl text-sm text-zinc-600 leading-relaxed dark:text-zinc-300">
        Configure via <code class="font-mono">~/.setu-costs.json</code>.
        Credentials are configured on this Mac, outside the portal UI. Admin
        keys can also come from{' '}
        <code class="font-mono">$ANTHROPIC_ADMIN_KEY</code>/
        <code class="font-mono">$OPENAI_ADMIN_KEY</code> if already exported.
        See AGENTS.md for the exact shape, including optional
        daily/weekly/monthly budget alerts.
      </p>
    </div>
  );
}
