import { useEffect, useRef, useState } from 'preact/hooks';
import {
  canAcceptSpansSearchResponse,
  readSpansSearch,
  SpansSearchReadError,
  type SpansSearchRequest,
  type SpansSearchResult,
} from '../spans-search';
import { inputCls } from '../ui';
import { Button } from '../ui/button';

interface Cursor {
  afterSequence: number;
  expectedGeneration?: number;
  throughSequence?: number;
}

type SearchState =
  | { kind: 'idle' }
  | { kind: 'loading'; key: string }
  | { kind: 'failed'; key: string; message: string; stale: boolean }
  | { kind: 'ready'; key: string; result: SpansSearchResult };

const SEARCH_LIMIT = 50;
const MAX_QUERY_LENGTH = 512;

function searchRequest(query: string, cursor: Cursor): SpansSearchRequest {
  return {
    afterSequence: cursor.afterSequence,
    expectedGeneration: cursor.expectedGeneration,
    limit: SEARCH_LIMIT,
    query,
    throughSequence: cursor.throughSequence,
  };
}

function SearchFeedback({
  coverage,
  failed,
  loading,
  onRestart,
  onRetry,
}: {
  coverage: SpansSearchResult['coverage'] | undefined;
  failed: Extract<SearchState, { kind: 'failed' }> | null;
  loading: boolean;
  onRetry: () => void;
  onRestart: () => void;
}) {
  return (
    <>
      {loading && (
        <p class="empty-state mt-4" role="status">
          Searching saved history…
        </p>
      )}
      {failed && (
        <div class="read-notice mt-4" role="alert">
          <p>{failed.message}</p>
          <div class="mt-3 flex flex-wrap gap-2">
            <Button
              compact
              onClick={failed.stale ? onRestart : onRetry}
              variant="secondary"
            >
              {failed.stale ? 'Restart search' : 'Retry search'}
            </Button>
          </div>
        </div>
      )}
      {coverage && (
        <p class="mt-4 text-sm text-zinc-600 dark:text-zinc-300" role="status">
          {coverage.stale || !coverage.complete
            ? `Partial history coverage: indexed through sequence ${coverage.indexedSequence} of ${coverage.latestSequence}.`
            : `History index current through sequence ${coverage.indexedSequence}.`}
        </p>
      )}
    </>
  );
}

function SearchMatches({
  result,
  submitted,
  onSelect,
}: {
  onSelect: (runId: string) => void;
  result: SpansSearchResult | null;
  submitted: string;
}) {
  if (!result) {
    return null;
  }
  if (result.hits.length === 0) {
    return (
      <p class="empty-state mt-4">No saved history matches “{submitted}”.</p>
    );
  }
  return (
    <>
      <p class="mt-4 text-sm text-zinc-600 dark:text-zinc-300">
        {result.hits.length} {result.hits.length === 1 ? 'match' : 'matches'} on
        this page.
      </p>
      <ol
        aria-busy={false}
        aria-label="Saved history matches"
        class="glass-panel mt-2 divide-y divide-zinc-200/60 text-sm dark:divide-white/10"
      >
        {result.hits.map((hit) => (
          <li
            class="min-w-0 px-4 py-4"
            key={`${hit.runId}:${hit.sequence}:${hit.eventId}`}
          >
            <p class="break-words text-zinc-800 dark:text-zinc-100">
              {hit.snippet}
            </p>
            <div class="mt-2 flex flex-wrap items-center gap-x-4 gap-y-2 text-xs text-zinc-600 dark:text-zinc-300">
              <span>Event {hit.eventId}</span>
              <span>Sequence {hit.sequence}</span>
              <Button
                compact
                onClick={() => onSelect(hit.runId)}
                variant="secondary"
              >
                Open run {hit.runId}
              </Button>
            </div>
          </li>
        ))}
      </ol>
    </>
  );
}

function SearchPages({
  cursors,
  loading,
  onNext,
  onPrevious,
  result,
}: {
  cursors: Cursor[];
  loading: boolean;
  onNext: () => void;
  onPrevious: () => void;
  result: SpansSearchResult | null;
}) {
  if (!result || (cursors.length <= 1 && !result.hasMore)) {
    return null;
  }
  return (
    <nav
      aria-label="History search pages"
      class="mt-4 flex flex-wrap items-center gap-3"
    >
      <Button
        compact
        disabled={cursors.length < 2 || loading}
        onClick={onPrevious}
        variant="secondary"
      >
        Previous results
      </Button>
      <Button
        compact
        disabled={!result.hasMore || loading}
        onClick={onNext}
        variant="secondary"
      >
        Next results
      </Button>
    </nav>
  );
}

export function SpansSearch({
  onSelect,
}: {
  onSelect: (runId: string) => void;
}) {
  const [draft, setDraft] = useState('');
  const [submitted, setSubmitted] = useState('');
  const [searchVersion, setSearchVersion] = useState(0);
  const [cursors, setCursors] = useState<Cursor[]>([{ afterSequence: 0 }]);
  const cursor = cursors.at(-1) ?? { afterSequence: 0 };
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<SearchState>({ kind: 'idle' });
  const [validation, setValidation] = useState<string | null>(null);
  const controller = useRef<AbortController | null>(null);
  const requestKey = JSON.stringify([
    submitted,
    cursor.afterSequence,
    cursor.throughSequence ?? null,
    cursor.expectedGeneration ?? null,
    searchVersion,
    attempt,
  ]);
  const currentRequestKey = useRef(requestKey);
  currentRequestKey.current = requestKey;

  useEffect(() => {
    if (!submitted) {
      return;
    }
    const abort = new AbortController();
    controller.current = abort;
    let current = true;
    const request = searchRequest(submitted, cursor);
    setState({ key: requestKey, kind: 'loading' });
    readSpansSearch(request, abort.signal).then(
      (responseData) => {
        if (
          current &&
          canAcceptSpansSearchResponse(
            requestKey,
            currentRequestKey.current,
            abort.signal
          )
        ) {
          setState({ key: requestKey, kind: 'ready', result: responseData });
        }
      },
      (error: unknown) => {
        if (
          current &&
          canAcceptSpansSearchResponse(
            requestKey,
            currentRequestKey.current,
            abort.signal
          )
        ) {
          const isStale =
            error instanceof SpansSearchReadError &&
            error.code === 'SPANS_SERVICE_STALE';
          setState({
            key: requestKey,
            kind: 'failed',
            message:
              error instanceof SpansSearchReadError
                ? error.message
                : 'History search is unavailable. Try again.',
            stale: isStale,
          });
        }
      }
    );
    return () => {
      current = false;
      abort.abort();
      if (controller.current === abort) {
        controller.current = null;
      }
    };
  }, [requestKey]);

  const submit = () => {
    const query = draft.trim();
    if (!query || query.length > MAX_QUERY_LENGTH) {
      setValidation('Enter a search phrase of 1 to 512 characters.');
      return;
    }
    setValidation(null);
    setSubmitted(query);
    setCursors([{ afterSequence: 0 }]);
    setSearchVersion((version) => version + 1);
  };

  const reset = () => {
    setCursors([{ afterSequence: 0 }]);
    setAttempt((value) => value + 1);
  };

  const visibleState =
    state.kind !== 'idle' && state.key === requestKey ? state : null;
  const result = visibleState?.kind === 'ready' ? visibleState.result : null;
  const coverage = result?.coverage;
  const retry = () => setAttempt((value) => value + 1);
  const failed = visibleState?.kind === 'failed' ? visibleState : null;
  const loading = visibleState?.kind === 'loading';
  const next = () => {
    setCursors((items) => {
      const first = items[0] ?? { afterSequence: 0 };
      return [
        {
          afterSequence: 0,
          expectedGeneration: first.expectedGeneration ?? result?.generation,
          throughSequence: first.throughSequence ?? result?.throughSequence,
        },
        ...items.slice(1),
        {
          afterSequence: result?.nextSequence ?? 0,
          expectedGeneration: result?.generation,
          throughSequence: result?.throughSequence,
        },
      ];
    });
  };
  const previous = () => setCursors((items) => items.slice(0, -1));

  return (
    <section
      aria-labelledby="spans-history-search-title"
      class="portal-page mx-auto max-w-4xl px-4 pb-8 sm:px-6"
    >
      <div class="border-zinc-200/70 border-t pt-6 dark:border-white/10">
        <h2
          class="font-semibold text-lg text-zinc-900 dark:text-zinc-100"
          id="spans-history-search-title"
        >
          Search saved history
        </h2>
        <p class="mt-1 max-w-2xl text-sm text-zinc-600 dark:text-zinc-300">
          Search indexed event text across this archive. Run summary filters
          above are separate.
        </p>
        <div class="mt-4 flex flex-wrap items-end gap-3">
          <label
            class="min-w-0 flex-1 text-sm text-zinc-700 dark:text-zinc-200"
            htmlFor="spans-history-query"
          >
            Event text
            <input
              aria-describedby={
                validation ? 'spans-history-query-error' : undefined
              }
              aria-invalid={validation ? true : undefined}
              class={inputCls}
              id="spans-history-query"
              maxLength={MAX_QUERY_LENGTH}
              onInput={(event) => setDraft(event.currentTarget.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault();
                  submit();
                }
              }}
              type="search"
              value={draft}
            />
          </label>
          <Button
            compact
            disabled={visibleState?.kind === 'loading'}
            onClick={submit}
            variant="secondary"
          >
            Search history
          </Button>
          {visibleState?.kind === 'loading' && (
            <Button
              compact
              onClick={() => {
                controller.current?.abort();
                setState({
                  key: requestKey,
                  kind: 'failed',
                  message: 'Search cancelled.',
                  stale: false,
                });
              }}
              variant="secondary"
            >
              Cancel
            </Button>
          )}
        </div>
        {validation && (
          <p
            class="mt-2 text-signal-red text-sm"
            id="spans-history-query-error"
            role="alert"
          >
            {validation}
          </p>
        )}

        <SearchFeedback
          coverage={coverage}
          failed={failed}
          loading={loading}
          onRestart={reset}
          onRetry={retry}
        />
        <SearchMatches
          onSelect={onSelect}
          result={result}
          submitted={submitted}
        />
        <SearchPages
          cursors={cursors}
          loading={loading}
          onNext={next}
          onPrevious={previous}
          result={result}
        />
      </div>
    </section>
  );
}
