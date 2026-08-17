// Costs page — spend across Anthropic/OpenAI/Gemini's admin APIs. Owns its
// own fetch, only needs a back-navigation callback (the router stays in
// app.tsx, same shape as PortsPage/HelpPage). No config-input form here —
// the portal binds 0.0.0.0 (LAN-reachable, unauthenticated), so a form that
// could submit an admin key over plain HTTP is a real hole; ~/.setu-costs.json
// is written by hand, see its own comment in lib.js.
import { useCallback, useEffect, useState } from 'preact/hooks';
import { PageHeader } from '../ui';
import { StatusDot } from '../ui/badge';

type ProviderCosts = {
  byModel?: { costUsd: number; model: string }[];
  configured: boolean;
  error?: string;
  provider: string;
  reason?: string;
  totalCostUsd?: number;
  windowDays?: number;
};
type CostsSummary = { anthropic: ProviderCosts; gemini: ProviderCosts; openai: ProviderCosts };

const PROVIDER_LABEL: Record<string, string> = {
  anthropic: 'Anthropic (Claude)',
  gemini: 'Gemini',
  openai: 'OpenAI',
};

function fmtUsd(n: number) {
  return n.toLocaleString('en-US', { currency: 'USD', style: 'currency' });
}

function ProviderCard({ data }: { data: ProviderCosts }) {
  const label = PROVIDER_LABEL[data.provider] ?? data.provider;
  return (
    <div class="backdrop-blur-md bg-white/70 dark:bg-white/5 border border-white/75 dark:border-white/10 shadow-sm rounded-none p-5">
      <div class="flex items-center justify-between mb-3">
        <h3 class="text-sm font-semibold text-zinc-900 dark:text-zinc-100">{label}</h3>
        <StatusDot tone={data.error ? 'red' : data.configured ? 'emerald' : 'zinc'} />
      </div>

      {!data.configured && <p class="text-xs text-zinc-400 leading-relaxed">{data.reason}</p>}
      {data.error && <p class="text-xs text-signal-red leading-relaxed">{data.error}</p>}

      {data.configured && !data.error && (
        <>
          <p class="text-2xl font-bold text-zinc-900 dark:text-zinc-100 board-mono mb-1">{fmtUsd(data.totalCostUsd ?? 0)}</p>
          <p class="text-[11px] text-zinc-400 mb-4">last {data.windowDays} days</p>
          <div class="flex flex-col gap-1.5">
            {(data.byModel ?? []).slice(0, 8).map(m => (
              <div key={m.model} class="flex items-center justify-between text-xs gap-3">
                <span class="text-zinc-500 dark:text-zinc-400 truncate">{m.model}</span>
                <span class="font-mono text-zinc-700 dark:text-zinc-300 tabular-nums shrink-0">{fmtUsd(m.costUsd)}</span>
              </div>
            ))}
            {!data.byModel?.length && <p class="text-xs text-zinc-400">No spend in this window.</p>}
          </div>
        </>
      )}
    </div>
  );
}

export function CostsPage({ onBack }: { onBack: () => void }) {
  const [data, setData] = useState<CostsSummary | null>(null);
  const [loaded, setLoaded] = useState(false);

  const load = useCallback(async () => {
    setData(await fetch('/api/costs').then(r => r.json()).catch(() => null));
    setLoaded(true);
  }, []);

  useEffect(() => { load(); }, [load]);

  return (
    <div class="max-w-4xl mx-auto px-6 py-12">
      <PageHeader back={{ label: 'All worktrees', onClick: onBack }} title="Costs"
        subtitle={<span class="text-xs text-zinc-400">Spend across Anthropic, OpenAI, and Gemini's admin/usage APIs</span>} />

      {!loaded ? (
        <p class="text-zinc-400 text-center py-12">Loading…</p>
      ) : !data ? (
        <p class="text-zinc-400 text-center py-12">Couldn't reach the portal.</p>
      ) : (
        <div class="grid grid-cols-1 sm:grid-cols-3 gap-4">
          <ProviderCard data={data.anthropic} />
          <ProviderCard data={data.openai} />
          <ProviderCard data={data.gemini} />
        </div>
      )}

      <p class="text-[11px] text-zinc-400 mt-6">
        Configure via <code class="font-mono">~/.setu-costs.json</code> — never through this page, the portal isn't authenticated so credentials aren't accepted here. See AGENTS.md for the exact shape.
      </p>
    </div>
  );
}
