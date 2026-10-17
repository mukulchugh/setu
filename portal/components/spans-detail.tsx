import type { ComponentChildren } from 'preact';
import { useId, useState } from 'preact/hooks';
import type { SpansJson, SpansRecord } from '../spans-types';
import { Button } from '../ui/button';

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

function isObject(
  value: SpansJson | undefined
): value is { [key: string]: SpansJson } {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function displayValue(value: SpansJson | undefined): string {
  if (value === undefined || value === null) {
    return 'Unknown';
  }
  if (typeof value === 'string') {
    return value || 'Not recorded';
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  return JSON.stringify(value, null, 2);
}

function hasValue(value: SpansJson | undefined): boolean {
  return value !== undefined && value !== null;
}

function Value({ value }: { value: SpansJson | undefined }) {
  if (!hasValue(value)) {
    return <span>Not recorded</span>;
  }
  if (typeof value === 'object') {
    return (
      <details class="mt-1 min-w-0 text-sm">
        <summary class="min-h-11 cursor-pointer py-2 text-zinc-700 dark:text-zinc-200">
          View recorded data
        </summary>
        <pre class="max-w-full overflow-x-auto whitespace-pre-wrap break-words rounded-none bg-zinc-100 p-3 font-mono text-xs text-zinc-800 dark:bg-zinc-900 dark:text-zinc-200">
          {displayValue(value)}
        </pre>
      </details>
    );
  }
  return <span class="break-words">{displayValue(value)}</span>;
}

function Field({
  label,
  value,
}: {
  label: string;
  value: SpansJson | undefined;
}) {
  return (
    <div class="min-w-0 py-2">
      <dt class="font-semibold text-xs text-zinc-600 dark:text-zinc-300">
        {label}
      </dt>
      <dd class="mt-1 break-words text-sm text-zinc-900 dark:text-zinc-100">
        <Value value={value} />
      </dd>
    </div>
  );
}

function Empty({ children }: { children: ComponentChildren }) {
  return (
    <p class="py-4 text-sm text-zinc-600 dark:text-zinc-300">{children}</p>
  );
}

function PlanPanel({ view }: { view: Record<string, SpansJson> }) {
  const spansValue = view.spans;
  let spans: readonly (readonly [string, SpansJson])[] = [];
  if (Array.isArray(spansValue)) {
    spans = spansValue.map((span, index) => [String(index), span] as const);
  } else if (isObject(spansValue)) {
    spans = Object.entries(spansValue);
  }
  const decisions = view.acceptedDecisions;
  const history = view.planHistory;
  return (
    <div class="space-y-5">
      <section
        aria-labelledby="spans-plan-version"
        class="border-zinc-200/70 border-b pb-4 dark:border-white/10"
      >
        <h3
          class="font-semibold text-zinc-900 dark:text-zinc-100"
          id="spans-plan-version"
        >
          Plan record
        </h3>
        <dl class="mt-2 grid min-w-0 gap-x-6 sm:grid-cols-2">
          <Field label="Plan version" value={view.planVersion} />
          <Field label="Checkpoint" value={view.checkpoint} />
        </dl>
      </section>
      <section aria-labelledby="spans-plan-workstreams">
        <h3
          class="font-semibold text-zinc-900 dark:text-zinc-100"
          id="spans-plan-workstreams"
        >
          Workstreams
        </h3>
        {spans.length ? (
          <ul class="mt-2 divide-y divide-zinc-200/70 dark:divide-white/10">
            {spans.map(([id, item]) => {
              let span: { [key: string]: SpansJson } = {};
              if (isObject(item)) {
                span = item;
              }
              return (
                <li class="min-w-0 py-3" key={id}>
                  <p class="break-words font-medium text-zinc-900 dark:text-zinc-100">
                    {typeof span.title === 'string' ? span.title : id}
                  </p>
                  <dl class="mt-1 grid min-w-0 gap-x-6 sm:grid-cols-2">
                    <Field label="Dependencies" value={span.dependencies} />
                    <Field label="State" value={span.state} />
                  </dl>
                </li>
              );
            })}
          </ul>
        ) : (
          <Empty>No workstreams recorded.</Empty>
        )}
      </section>
      <section
        aria-labelledby="spans-plan-decisions"
        class="border-zinc-200/70 border-t pt-4 dark:border-white/10"
      >
        <h3
          class="font-semibold text-zinc-900 dark:text-zinc-100"
          id="spans-plan-decisions"
        >
          Accepted decisions
        </h3>
        <Value value={decisions} />
      </section>
      <section
        aria-labelledby="spans-plan-history"
        class="border-zinc-200/70 border-t pt-4 dark:border-white/10"
      >
        <h3
          class="font-semibold text-zinc-900 dark:text-zinc-100"
          id="spans-plan-history"
        >
          Plan history
        </h3>
        <Value value={history} />
      </section>
    </div>
  );
}

function AssignmentList({ value }: { value: SpansJson | undefined }) {
  let entries: readonly (readonly [string, SpansJson])[] = [];
  if (Array.isArray(value)) {
    entries = value.map((entry, index) => [String(index), entry] as const);
  } else if (isObject(value)) {
    entries = Object.entries(value);
  }
  if (!entries.length) {
    return <Empty>No assignments recorded.</Empty>;
  }
  return (
    <ul class="divide-y divide-zinc-200/70 dark:divide-white/10">
      {entries.map(([key, entry]) => {
        const assignment = isObject(entry) ? entry : {};
        const {
          label: assignmentLabel,
          title: assignmentTitle,
          name: assignmentName,
        } = assignment;
        let title = key;
        if (typeof assignmentLabel === 'string') {
          title = assignmentLabel;
        } else if (typeof assignmentTitle === 'string') {
          title = assignmentTitle;
        } else if (typeof assignmentName === 'string') {
          title = assignmentName;
        } else if (typeof entry === 'string') {
          title = entry;
        }
        return (
          <li class="min-w-0 py-3" key={key}>
            <p class="break-words font-medium text-zinc-900 dark:text-zinc-100">
              {title}
            </p>
            <dl class="mt-1 grid min-w-0 gap-x-6 sm:grid-cols-2">
              <Field label="ID" value={assignment.actionId} />
              <Field label="Attempt ID" value={assignment.attemptId} />
              <Field label="Status" value={assignment.state} />
            </dl>
          </li>
        );
      })}
    </ul>
  );
}

function EntriesPanel({
  title,
  value,
}: {
  title: string;
  value: SpansJson | undefined;
}) {
  if (!hasValue(value)) {
    return <Empty>{title} are not recorded.</Empty>;
  }
  let entries: readonly (readonly [string, SpansJson])[] | null = null;
  if (Array.isArray(value)) {
    entries = value.map((entry, index) => [String(index), entry] as const);
  } else if (isObject(value)) {
    entries = Object.entries(value);
  }
  if (!entries) {
    return <Value value={value} />;
  }
  if (!entries.length) {
    return <Empty>{title} are not recorded.</Empty>;
  }
  return (
    <dl class="divide-y divide-zinc-200/70 dark:divide-white/10">
      {entries.map(([key, entry]) => (
        <Field key={key} label={key} value={entry} />
      ))}
    </dl>
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
  tab?: string;
  onTabChange?: (tab: string) => void;
}) {
  const generatedId = useId();
  const [localTab, setLocalTab] = useState<TabName>('Plan');
  const controlled = isTabName(tab);
  const selectedTab = controlled ? tab : localTab;
  const view = record === null ? null : record.view;
  const goal =
    view && typeof view.goal === 'string' ? view.goal : 'Goal not recorded';
  const owner =
    view && typeof view.owner === 'string' ? view.owner : 'Owner unknown';
  const nextStep =
    view && typeof view.nextStep === 'string'
      ? view.nextStep
      : 'No next step recorded';
  const workState = view?.state ?? view?.status;
  const processState =
    view && typeof view.processState === 'string'
      ? view.processState
      : 'Process state unknown';
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
        return <PlanPanel view={view} />;
      case 'Agents':
        return <AssignmentList value={view.assignments ?? view.actions} />;
      case 'Conversation':
        return conversation ?? <Empty>Conversation is not recorded.</Empty>;
      case 'Evidence':
        return evidence ?? <Empty>Evidence is not recorded.</Empty>;
      case 'Recovery':
        return (
          <div class="space-y-4">
            <p class="text-sm text-zinc-700 dark:text-zinc-200">
              Live dispatch is not enabled.
            </p>
            <dl class="grid min-w-0 gap-x-6 sm:grid-cols-2">
              <Field label="Recorded reason" value={view.reason} />
              <Field
                label="Recorded recovery state"
                value={view.recoveryState ?? view.state}
              />
              <Field label="Checkpoint" value={view.checkpoint} />
            </dl>
          </div>
        );
      case 'Resources':
        return <EntriesPanel title="Resources" value={view.resources} />;
      case 'Usage':
        return <EntriesPanel title="Usage" value={view.usage} />;
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
          <Field label="Owner" value={owner} />
          <Field label="Next step" value={nextStep} />
          <Field label="Work state" value={workState} />
          <Field label="Process state" value={processState} />
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
