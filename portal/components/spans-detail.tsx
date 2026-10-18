import type { ComponentChildren } from 'preact';
import { useId, useState } from 'preact/hooks';
import type { SpansRecord } from '../spans-types';
import { Button } from '../ui/button';
import {
  SpansAgentsPanel,
  SpansPlanPanel,
  SpansRecoveryPanel,
  SpansResourcesPanel,
  SpansUsagePanel,
} from './spans-panels';

const SUMMARY_TEXT_LIMIT = 4096;

const TABS = [
  'Plan',
  'Agents',
  'Conversation',
  'Evidence',
  'Recovery',
  'Resources',
  'Usage',
] as const;
type TabName = (typeof TABS)[number];

function isTabName(value: string | undefined): value is TabName {
  return TABS.some((name) => name === value);
}

function directText(value: unknown, fallback: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    return fallback;
  }
  return value.length > SUMMARY_TEXT_LIMIT
    ? `${value.slice(0, SUMMARY_TEXT_LIMIT)}… (truncated)`
    : value;
}

function SummaryField({ label, value }: { label: string; value: unknown }) {
  let display = 'Structured value available; details unavailable.';
  if (value === undefined || value === null) {
    display = 'Unknown';
  } else if (typeof value === 'string') {
    display = value || '(empty)';
  } else if (typeof value === 'number') {
    display = Number.isFinite(value) ? String(value) : 'Unavailable';
  } else if (typeof value === 'boolean') {
    display = String(value);
  }
  return (
    <div class="min-w-0 py-2">
      <dt class="font-semibold text-xs text-zinc-600 dark:text-zinc-300">
        {label}
      </dt>
      <dd class="mt-1 break-words text-sm text-zinc-900 dark:text-zinc-100">
        {display}
      </dd>
    </div>
  );
}

function Empty({ children }: { children: ComponentChildren }) {
  return (
    <p class="py-4 text-sm text-zinc-600 dark:text-zinc-300">{children}</p>
  );
}

export function SpansDetail({
  record,
  loading,
  error,
  stale,
  onBack,
  onRefresh,
  conversation,
  evidence,
  links,
  tab,
  onTabChange,
}: {
  record: SpansRecord | null;
  loading: boolean;
  error: string | null;
  stale: boolean;
  onBack: () => void;
  onRefresh: () => void;
  conversation: ComponentChildren;
  evidence: ComponentChildren;
  links?: ComponentChildren;
  tab?: string;
  onTabChange?: (tab: string) => void;
}) {
  const generatedId = useId();
  const [localTab, setLocalTab] = useState<TabName>('Plan');
  const controlled = isTabName(tab);
  const selectedTab = controlled ? tab : localTab;
  const view = record === null ? null : record.view;
  const goal = directText(view?.goal, 'Goal not recorded');
  const baseId = `spans-detail-${generatedId}`;
  const activePanelId = `${baseId}-panel`;

  function selectTab(nextTab: TabName) {
    if (!controlled) {
      setLocalTab(nextTab);
    }
    onTabChange?.(nextTab);
  }

  function renderPanel() {
    if (!view) {
      return (
        <Empty>
          {loading ? 'Loading run details…' : 'Run details are not available.'}
        </Empty>
      );
    }
    switch (selectedTab) {
      case 'Plan':
        return <SpansPlanPanel view={view} />;
      case 'Agents':
        return <SpansAgentsPanel view={view} />;
      case 'Conversation':
        return conversation ?? <Empty>Conversation is unavailable.</Empty>;
      case 'Evidence':
        return evidence ?? <Empty>Evidence is unavailable.</Empty>;
      case 'Recovery':
        return (
          <>
            <SpansRecoveryPanel view={view} />
            {links}
          </>
        );
      case 'Resources':
        return <SpansResourcesPanel view={view} />;
      case 'Usage':
        return <SpansUsagePanel view={view} />;
      default:
        return <Empty>Run details are not available.</Empty>;
    }
  }

  return (
    <div class="mx-auto w-full min-w-0 max-w-6xl px-4 py-5 sm:px-6">
      <div class="mb-5 flex flex-wrap items-center gap-2">
        <Button compact onClick={onBack} variant="secondary">
          Back to runs
        </Button>
        <Button
          compact
          disabled={loading}
          onClick={onRefresh}
          variant="secondary"
        >
          {loading ? 'Refreshing…' : 'Refresh'}
        </Button>
        {stale && (
          <span class="font-medium text-signal-amber text-sm" role="status">
            Showing last known data · stale
          </span>
        )}
      </div>
      {error && (
        <p class="mb-4 text-signal-red text-sm" role="alert">
          {error}
        </p>
      )}
      <header class="min-w-0 border-zinc-200/70 border-b pb-5 dark:border-white/10">
        <h1 class="max-w-4xl break-words font-semibold text-2xl text-zinc-950 tracking-tight sm:text-3xl dark:text-zinc-50">
          {goal}
        </h1>
        <dl class="mt-4 grid min-w-0 gap-x-8 sm:grid-cols-3">
          <SummaryField label="Owner" value={view?.owner} />
          <SummaryField label="Next step" value={view?.nextStep} />
          <SummaryField
            label="Work state"
            value={view?.state ?? view?.status}
          />
          <SummaryField label="Process state" value={view?.processState} />
        </dl>
      </header>
      <fieldset class="mt-4 flex min-w-0 flex-wrap gap-2">
        <legend class="sr-only">Run details</legend>
        {TABS.map((name) => {
          const tabId = `${baseId}-tab-${name.toLowerCase()}`;
          return (
            <Button
              aria-controls={activePanelId}
              aria-pressed={selectedTab === name}
              class="min-h-11"
              compact
              key={name}
              onClick={() => selectTab(name)}
              variant={selectedTab === name ? 'primary' : 'secondary'}
            >
              <span id={tabId}>{name}</span>
            </Button>
          );
        })}
      </fieldset>
      <section
        aria-label={`${selectedTab} details`}
        aria-labelledby={`${baseId}-tab-${selectedTab.toLowerCase()}`}
        class="mt-5 min-w-0"
        id={activePanelId}
      >
        {renderPanel()}
      </section>
    </div>
  );
}
