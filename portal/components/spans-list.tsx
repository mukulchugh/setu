// Spans run list. Presentational only: the root owns the fetch, the phase
// filter and paging. Run text renders as plain text. The only row action is
// opening a run; a saved plan never starts from this page, and a process exit
// is never read as completion.
import type { SpansJson, SpansPhase, SpansRecord } from '../spans-types';
import { inputCls, PageHeader } from '../ui';
import { Badge, type Tone } from '../ui/badge';
import { Button } from '../ui/button';

const PHASES: { label: string; phase: SpansPhase }[] = [
  { label: 'All', phase: 'all' },
  { label: 'Past', phase: 'past' },
  { label: 'Live', phase: 'live' },
  { label: 'Planned', phase: 'planned' },
];

const EMPTY_COPY: Record<SpansPhase, string> = {
  all: 'No Spans runs are recorded yet.',
  live: 'No live runs are recorded in this archive.',
  past: 'No past runs are recorded yet.',
  planned:
    'No saved plans yet. A saved plan stays here and never starts on its own.',
};

type RunState =
  | 'blocked'
  | 'cancelled'
  | 'completed'
  | 'failed'
  | 'planned'
  | 'running'
  | 'unknown';

const STATE_BADGE: Record<RunState, { label: string; tone: Tone }> = {
  blocked: { label: 'Blocked', tone: 'amber' },
  cancelled: { label: 'Cancelled', tone: 'zinc' },
  completed: { label: 'Completed', tone: 'emerald' },
  failed: { label: 'Failed', tone: 'red' },
  planned: { label: 'Planned', tone: 'zinc' },
  running: { label: 'Running', tone: 'emerald' },
  unknown: { label: 'Unknown', tone: 'zinc' },
};

// Archive state words, matched after trimming, lowercasing and folding `-`,
// `_` and spaces, so "Recovery required" and "recovery_required" match. Ready
// reads as planned; paused, waiting and recovery read as blocked. Anything
// unlisted stays unknown.
const STATE_WORDS = new Map<string, RunState>([
  ['blocked', 'blocked'],
  ['cancelled', 'cancelled'],
  ['completed', 'completed'],
  ['failed', 'failed'],
  ['paused', 'blocked'],
  ['planned', 'planned'],
  ['ready', 'planned'],
  ['recovery required', 'blocked'],
  ['running', 'running'],
  ['waiting for you', 'blocked'],
]);

export interface SpansListProps {
  error: string | null;
  hasMore: boolean;
  hasPrevious: boolean;
  loading: boolean;
  onBack: () => void;
  onNext: () => void;
  onPhaseChange: (phase: SpansPhase) => void;
  onPrevious: () => void;
  onQueryChange: (query: string) => void;
  onRefresh: () => void;
  onSelect: (runId: string) => void;
  phase: SpansPhase;
  query: string;
  records: SpansRecord[];
  stale: boolean;
}

// Only non-empty strings are shown; any other shape is treated as absent.
function textField(
  view: Record<string, SpansJson>,
  key: string
): string | null {
  const value = view[key];
  if (typeof value !== 'string') {
    return null;
  }
  const text = value.trim();
  return text === '' ? null : text;
}

function runState(raw: string | null): RunState {
  if (raw === null) {
    return 'unknown';
  }
  const key = raw
    .trim()
    .toLowerCase()
    .replace(/[\s_-]+/g, ' ');
  return STATE_WORDS.get(key) ?? 'unknown';
}

function phaseCls(active: boolean) {
  return `min-h-9 shrink-0 rounded-none px-3 py-1.5 font-medium text-xs transition-colors duration-150 ${
    active
      ? 'bg-white text-zinc-900 shadow-sm dark:bg-zinc-700 dark:text-zinc-100'
      : 'text-zinc-600 hover:text-zinc-900 dark:text-zinc-300 dark:hover:text-zinc-100'
  }`;
}

function RunRow({
  record,
  onSelect,
}: {
  record: SpansRecord;
  onSelect: (runId: string) => void;
}) {
  const { runId, view } = record;
  const title = textField(view, 'goal') ?? 'Untitled run';
  const stateWord = textField(view, 'state') ?? textField(view, 'status');
  const state = STATE_BADGE[runState(stateWord)];
  const owner = textField(view, 'owner');
  const project = textField(view, 'project');
  const worktree = textField(view, 'worktree');
  return (
    <li class="flex min-w-0 flex-wrap items-start justify-between gap-3 border-zinc-200/60 border-b px-4 py-4 last:border-0 dark:border-white/10">
      <div class="min-w-0 flex-1">
        <div class="flex min-w-0 flex-wrap items-baseline gap-2">
          <span class="worktree-name break-words font-semibold text-zinc-900 dark:text-zinc-100">
            {title}
          </span>
          <Badge tone={state.tone}>{state.label}</Badge>
        </div>
        {(owner || project || worktree) && (
          <p class="mt-1 flex min-w-0 flex-wrap gap-x-4 gap-y-1 text-xs text-zinc-600 dark:text-zinc-300">
            {owner && <span class="break-all">Owner {owner}</span>}
            {project && <span class="break-all">Project {project}</span>}
            {worktree && <span class="break-all">Worktree {worktree}</span>}
          </p>
        )}
        <p class="mt-1 break-all font-mono text-xs text-zinc-600 dark:text-zinc-300">
          Run {runId}
        </p>
      </div>
      <Button
        aria-label={`Open run: ${title} (${runId})`}
        compact
        onClick={() => onSelect(runId)}
        variant="secondary"
      >
        Open run
      </Button>
    </li>
  );
}

export function SpansList({
  records,
  query,
  onQueryChange,
  phase,
  onPhaseChange,
  onSelect,
  onBack,
  onRefresh,
  onNext,
  onPrevious,
  hasMore,
  hasPrevious,
  loading,
  error,
  stale,
}: SpansListProps) {
  const hasRecords = records.length > 0;
  const count = records.length;
  return (
    <div class="portal-page mx-auto max-w-4xl px-4 py-6 sm:px-6">
      <PageHeader
        actions={
          <Button
            compact
            disabled={loading}
            onClick={onRefresh}
            variant="secondary"
          >
            Refresh
          </Button>
        }
        back={{ label: 'Back', onClick: onBack }}
        subtitle={
          <span class="block max-w-xl text-sm text-zinc-600 dark:text-zinc-300">
            Retained work history and execution plans. Saved plans never start
            on their own.
          </span>
        }
        title="Spans"
      />

      <label
        class="mb-4 block text-sm text-zinc-700 dark:text-zinc-200"
        htmlFor="spans-query"
      >
        Search run summaries
        <input
          class={inputCls}
          id="spans-query"
          maxLength={256}
          onInput={(event) => onQueryChange(event.currentTarget.value)}
          type="search"
          value={query}
        />
      </label>
      <fieldset class="mb-4 flex max-w-full flex-wrap gap-1 rounded-none bg-zinc-100 p-0.5 dark:bg-zinc-800">
        <legend class="sr-only">Show runs</legend>
        {PHASES.map(({ label, phase: value }) => (
          <button
            aria-pressed={phase === value}
            class={phaseCls(phase === value)}
            key={value}
            onClick={() => onPhaseChange(value)}
            type="button"
          >
            {label}
          </button>
        ))}
      </fieldset>

      {error !== null && (
        <div class="read-notice" role="alert">
          <p>
            {hasRecords
              ? 'Could not refresh Spans runs.'
              : 'Could not load Spans runs.'}{' '}
            {error}
          </p>
          <Button compact onClick={onRefresh} variant="secondary">
            Refresh
          </Button>
        </div>
      )}
      {stale && (
        <p class="read-notice" role="status">
          Showing the last successful read. Runs may have changed since then.
        </p>
      )}

      {hasRecords && (
        <p class="mb-3 text-sm text-zinc-600 dark:text-zinc-300">
          {loading
            ? 'Refreshing runs…'
            : `${count} ${count === 1 ? 'run' : 'runs'} on this page.`}
          {!loading && hasMore && ' More runs are available on the next page.'}
        </p>
      )}
      {hasRecords && (
        <ul
          aria-busy={loading}
          aria-label="Spans runs"
          class="glass-panel text-sm"
        >
          {records.map((record) => (
            <RunRow key={record.runId} onSelect={onSelect} record={record} />
          ))}
        </ul>
      )}
      {!hasRecords && loading && (
        <p class="empty-state" role="status">
          Loading runs…
        </p>
      )}
      {!(hasRecords || loading) && error === null && (
        <p class="empty-state">{EMPTY_COPY[phase]}</p>
      )}

      {(hasPrevious || hasMore) && (
        <nav
          aria-label="Spans pages"
          class="mt-6 flex flex-wrap items-center justify-center gap-3 text-sm text-zinc-600 dark:text-zinc-300"
        >
          <Button
            compact
            disabled={!hasPrevious}
            onClick={onPrevious}
            variant="secondary"
          >
            Previous page
          </Button>
          <Button
            compact
            disabled={!hasMore}
            onClick={onNext}
            variant="secondary"
          >
            Next page
          </Button>
        </nav>
      )}
    </div>
  );
}
