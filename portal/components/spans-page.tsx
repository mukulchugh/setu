import { useState } from 'preact/hooks';
import { evidenceSpanChoices } from '../links-history';
import { parseSpansLocation, spansLocationSearch } from '../spans-location';
import {
  readSpansArtifact,
  readSpansEvents,
  readSpansRun,
  readSpansRuns,
} from '../spans-read';
import type { SpansPhase } from '../spans-types';
import { Button } from '../ui/button';
import { useVisiblePoll } from '../use-visible-poll';
import { LinksRecoveryPanel } from './links-history';
import { SpansConversation } from './spans-conversation';
import { SpansDetail } from './spans-detail';
import { SpansEvidence } from './spans-evidence';
import { SpansHistoryImport } from './spans-history-import';
import { SpansList } from './spans-list';
import { SpansMaintenance } from './spans-maintenance';
import { SpansPlanning } from './spans-planning';
import { SpansSearch } from './spans-search';

export function SpansPage({
  runId,
  onBack,
  onSelect,
}: {
  runId?: string;
  onBack: () => void;
  onSelect: (runId: string) => void;
}) {
  return runId ? (
    <RunPage key={runId} onBack={onBack} runId={runId} />
  ) : (
    <RunList onBack={onBack} onSelect={onSelect} />
  );
}

function updateLocation(changes: Record<string, string | number | null>) {
  const search = spansLocationSearch(window.location.search, changes);
  window.history.replaceState(null, '', `${window.location.pathname}${search}`);
}

function RunList({
  onBack,
  onSelect,
}: {
  onBack: () => void;
  onSelect: (runId: string) => void;
}) {
  const [planning, setPlanning] = useState(false);
  const [initial] = useState(() => parseSpansLocation(window.location.search));
  const [phase, setPhase] = useState<SpansPhase>(initial.phase);
  const [query, setQuery] = useState(initial.query);
  const [cursors, setCursors] = useState(['']);
  const cursor = cursors.at(-1) ?? '';
  const page = useVisiblePoll(
    JSON.stringify(['spans', phase, query, cursor]),
    15_000,
    (signal) => readSpansRuns(phase, query, cursor, signal)
  );
  const archiveNotInitialized =
    page.data?.kind === 'archive-not-initialized' && !page.failed;
  const runPage = page.data?.kind === 'page' ? page.data.page : undefined;
  if (planning) {
    return (
      <>
        <div class="mx-auto max-w-4xl px-4 pt-4 sm:px-6">
          <Button onClick={() => setPlanning(false)} variant="secondary">
            Back to runs
          </Button>
        </div>
        <SpansPlanning onCreated={onSelect} />
      </>
    );
  }
  return (
    <>
      <div class="px-4 pt-4 sm:px-6">
        <Button onClick={() => setPlanning(true)}>Plan a workflow</Button>
      </div>
      <SpansHistoryImport onSelect={onSelect} />
      <SpansMaintenance />
      <SpansList
        archiveNotInitialized={archiveNotInitialized}
        error={page.failed ? 'Refresh to retry.' : null}
        hasMore={runPage?.hasMore ?? false}
        hasPrevious={cursors.length > 1}
        loading={!(page.data || page.failed)}
        onBack={onBack}
        onNext={() => {
          if (runPage?.hasMore && runPage.nextRunId) {
            setCursors([...cursors, runPage.nextRunId]);
          }
        }}
        onPhaseChange={(value) => {
          setPhase(value);
          updateLocation({ phase: value });
          setCursors(['']);
        }}
        onPrevious={() => setCursors(cursors.slice(0, -1))}
        onQueryChange={(value) => {
          setQuery(value);
          updateLocation({ query: value });
          setCursors(['']);
        }}
        onRefresh={page.refresh}
        onSelect={onSelect}
        phase={phase}
        query={query}
        records={runPage?.records ?? []}
        stale={page.failed && runPage !== undefined}
      />
      <SpansSearch onSelect={onSelect} />
    </>
  );
}

function RunPage({ runId, onBack }: { runId: string; onBack: () => void }) {
  const [initial] = useState(() => parseSpansLocation(window.location.search));
  const [tab, setTab] = useState<string | null>(() =>
    initial.tab === 'Plan' &&
    new URLSearchParams(window.location.search).get('tab') !== 'Plan'
      ? null
      : initial.tab
  );
  const [artifactId, setArtifactId] = useState<string | null>(
    initial.artifactId || null
  );
  const [cursors, setCursors] = useState([initial.after]);
  const after = cursors.at(-1) ?? 0;
  const run = useVisiblePoll(`spans-run:${runId}`, 15_000, (signal) =>
    readSpansRun(runId, signal)
  );
  const history = useVisiblePoll(
    `spans-events:${runId}:${after}`,
    15_000,
    (signal) => readSpansEvents(runId, after, signal)
  );
  const next = () => {
    if (history.data?.hasMore && history.data.nextSequence > after) {
      setCursors([...cursors, history.data.nextSequence]);
      updateLocation({ after: history.data.nextSequence });
    }
  };
  const paging = (
    <nav aria-label="History pages" class="flex flex-wrap gap-3 py-3">
      <Button
        disabled={after === 0}
        onClick={() => {
          setCursors([0]);
          updateLocation({ after: 0 });
        }}
        variant="secondary"
      >
        First history page
      </Button>
      <Button
        disabled={cursors.length < 2}
        onClick={() => {
          setCursors(cursors.slice(0, -1));
          updateLocation({ after: cursors.at(-2) ?? 0 });
        }}
        variant="secondary"
      >
        Previous history page
      </Button>
      <Button
        disabled={!history.data?.hasMore}
        onClick={next}
        variant="secondary"
      >
        Next history page
      </Button>
      <span class="text-sm">
        Events after sequence {after}. Evidence below belongs to this page.
      </span>
    </nav>
  );
  const historyError = history.failed
    ? 'History could not be refreshed. Try Refresh.'
    : null;
  return (
    <SpansDetail
      conversation={
        <>
          {paging}
          <SpansConversation
            error={historyError}
            events={history.data?.events ?? []}
            hasMore={false}
            historyMore={history.data?.hasMore ?? false}
            loading={!(history.data || history.failed)}
            onLinksChanged={history.refresh}
            onLoadMore={next}
            readArtifact={readSpansArtifact}
            runId={runId}
            spanChoices={evidenceSpanChoices(run.data?.view ?? {})}
            stale={history.failed && !!history.data}
          />
        </>
      }
      error={
        run.failed ? 'This run could not be refreshed. Try Refresh.' : null
      }
      evidence={
        <>
          {paging}
          {historyError && <p role="alert">{historyError}</p>}
          {!(history.data || history.failed) && (
            <p role="status">Loading evidence…</p>
          )}
          <SpansEvidence
            artifactId={artifactId}
            events={history.data?.events ?? []}
            onArtifactChange={(value) => {
              setArtifactId(value);
              updateLocation({ artifact: value });
            }}
            readArtifact={readSpansArtifact}
            runId={runId}
          />
        </>
      }
      links={<LinksRecoveryPanel onChanged={history.refresh} runId={runId} />}
      loading={!(run.data || run.failed)}
      onBack={onBack}
      onRefresh={() => {
        run.refresh();
        history.refresh();
      }}
      onTabChange={(value) => {
        setTab(value);
        updateLocation({ tab: value });
      }}
      record={run.data ?? null}
      stale={run.failed && !!run.data}
      tab={
        tab ?? (run.data?.view.kind === 'imported' ? 'Conversation' : 'Plan')
      }
    />
  );
}
