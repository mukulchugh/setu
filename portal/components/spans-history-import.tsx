import { useEffect, useId, useRef, useState } from 'preact/hooks';
import {
  type SpansHistoryImportInput,
  type SpansHistoryImportResult,
  submitSpansHistoryImport,
  validateSpansHistoryImportInput,
} from '../spans-history';
import { inputCls } from '../ui';
import { Button } from '../ui/button';

type Destination = 'new' | 'existing';
interface Review {
  input: SpansHistoryImportInput;
}
interface Observation {
  input: SpansHistoryImportInput;
  result: SpansHistoryImportResult;
}

export function sameHistoryImportInput(
  left: SpansHistoryImportInput,
  right: SpansHistoryImportInput
): boolean {
  return (
    left.path === right.path &&
    left.provider === right.provider &&
    left.existingRunId === right.existingRunId &&
    left.maxBytes === right.maxBytes
  );
}

export function consumeHistoryImportToken<T extends object>(
  current: { current: T | null },
  token: T
): boolean {
  if (current.current !== token) {
    return false;
  }
  current.current = null;
  return true;
}

export function invalidateHistoryImportReview<T extends object>(current: {
  current: T | null;
}): void {
  current.current = null;
}

function snapshot(input: SpansHistoryImportInput): SpansHistoryImportInput {
  return {
    path: input.path,
    provider: input.provider,
    ...(input.existingRunId === undefined
      ? {}
      : { existingRunId: input.existingRunId }),
    ...(input.maxBytes === undefined ? {} : { maxBytes: input.maxBytes }),
  };
}

function outcomeTitle(result: SpansHistoryImportResult): string {
  if (result.kind === 'success') {
    return 'History page imported';
  }
  return result.kind === 'unknown'
    ? 'Import outcome unknown'
    : 'Import was not completed';
}

function pageProgress(
  result: Extract<SpansHistoryImportResult, { kind: 'success' }>
): string {
  if (result.hasMore) {
    return 'More history remains in the current file.';
  }
  return result.eof
    ? 'The end of the current file was reached.'
    : 'No more complete history is available in the current file.';
}

function searchProgress(
  status: Extract<SpansHistoryImportResult, { kind: 'success' }>['search']
): string {
  switch (status.kind) {
    case 'complete':
      return `Search indexing covers the archive through sequence ${status.targetSequence}. ${status.indexed} records were indexed across ${status.pages} pages.`;
    case 'pending':
      return 'The imported history was saved, but search indexing is still pending. Search coverage is incomplete.';
    case 'unknown':
      return 'The imported history was saved, but the search indexing outcome is unknown. Search coverage could not be verified.';
    case 'unverified':
      return 'The imported history was saved. Search coverage could not be verified.';
    default:
      return 'The imported history was saved. Search coverage could not be verified.';
  }
}

function providerName(provider: SpansHistoryImportInput['provider']): string {
  return provider === 'codex' ? 'Codex' : 'Claude Code';
}

function destinationName(input: SpansHistoryImportInput): string {
  return input.existingRunId
    ? `Attach to run ${input.existingRunId}`
    : 'Create a new read-only Past entry';
}

function SubmittedInput({ input }: { input: SpansHistoryImportInput }) {
  return (
    <dl class="mt-3 grid min-w-0 gap-x-4 gap-y-1 text-sm sm:grid-cols-[max-content_minmax(0,1fr)]">
      <dt>Submitted file</dt>
      <dd class="min-w-0 break-all font-mono">{input.path}</dd>
      <dt>Provider</dt>
      <dd>{providerName(input.provider)}</dd>
      <dt>Destination</dt>
      <dd class="min-w-0 break-all">{destinationName(input)}</dd>
    </dl>
  );
}

function ImportOutcome({
  continuation,
  observation,
  onNext,
  onReviewAgain,
  onSelect,
  resultHeading,
}: {
  continuation: SpansHistoryImportInput | null;
  observation: Observation;
  onNext: (
    input: SpansHistoryImportInput,
    token: SpansHistoryImportInput
  ) => void;
  onReviewAgain: (input: SpansHistoryImportInput) => void;
  onSelect: (runId: string) => void;
  resultHeading: { current: HTMLHeadingElement | null };
}) {
  const { result } = observation;
  return (
    <div
      aria-live={result.kind === 'success' ? 'polite' : 'assertive'}
      class="mt-4 min-w-0 border-zinc-200 border-t pt-4 dark:border-white/10"
      role={result.kind === 'success' ? 'status' : 'alert'}
    >
      <h3 class="font-semibold" ref={resultHeading} tabIndex={-1}>
        {outcomeTitle(result)}
      </h3>
      <SubmittedInput input={observation.input} />
      {result.kind === 'success' ? (
        <>
          <p class="mt-3 text-sm">
            {result.importedCount} messages imported on this page.{' '}
            {pageProgress(result)}
          </p>
          <p class="mt-2 text-sm text-zinc-600 dark:text-zinc-300">
            The saved source position advanced from byte {result.expectedOffset}{' '}
            to byte {result.nextOffset}.
          </p>
          <p class="mt-2 text-sm text-zinc-600 dark:text-zinc-300">
            {searchProgress(result.search)}
          </p>
          {result.pendingByteCount > 0 && (
            <p class="mt-2 text-amber-800 text-sm dark:text-amber-200">
              The file ends with an incomplete record ({result.pendingByteCount}{' '}
              bytes); it has not been imported. Review this same file again
              after it is finished.
            </p>
          )}
          {result.gapCount > 0 && (
            <p class="mt-2 text-amber-800 text-sm dark:text-amber-200">
              {result.gapCount} source records were skipped or could not be
              represented. The imported history has a coverage gap.
            </p>
          )}
          <dl class="mt-3 grid min-w-0 gap-x-4 gap-y-1 text-sm sm:grid-cols-[max-content_minmax(0,1fr)]">
            <dt>Past entry</dt>
            <dd class="min-w-0 break-all font-mono">{result.runId}</dd>
          </dl>
          <div class="mt-3 flex flex-wrap gap-2">
            <Button
              class="min-h-11"
              onClick={() => onSelect(result.runId)}
              variant="secondary"
            >
              Open imported history
            </Button>
            {continuation ? (
              <Button
                class="min-h-11"
                onClick={() => onNext(continuation, continuation)}
              >
                Import next page from this submitted file
              </Button>
            ) : (
              !result.hasMore && (
                <Button
                  class="min-h-11"
                  onClick={() => onReviewAgain(observation.input)}
                  variant="secondary"
                >
                  Review this file again
                </Button>
              )
            )}
          </div>
          {!result.hasMore && (
            <p class="mt-2 text-sm text-zinc-600 dark:text-zinc-300">
              A new review checks the same source identity from its saved
              position. Nothing is read again until you review and confirm.
            </p>
          )}
        </>
      ) : (
        <p class="mt-2 max-w-2xl text-sm">{result.message}</p>
      )}
    </div>
  );
}

export function SpansHistoryImport({
  onSelect,
}: {
  onSelect: (runId: string) => void;
}) {
  const id = useId();
  const pathId = `${id}-path`;
  const providerId = `${id}-provider`;
  const existingId = `${id}-existing`;
  const [path, setPath] = useState('');
  const [provider, setProvider] = useState<'codex' | 'claude'>('codex');
  const [destination, setDestination] = useState<Destination>('new');
  const [existingRunId, setExistingRunId] = useState('');
  const [review, setReview] = useState<Review | null>(null);
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [observation, setObservation] = useState<Observation | null>(null);
  const [continuation, setContinuation] =
    useState<SpansHistoryImportInput | null>(null);
  const [blocked, setBlocked] = useState(false);
  const lock = useRef(false);
  const reviewToken = useRef<Review | null>(null);
  const continuationToken = useRef<SpansHistoryImportInput | null>(null);
  const reviewHeading = useRef<HTMLHeadingElement>(null);
  const resultHeading = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    if (review) {
      reviewHeading.current?.focus();
    }
  }, [review]);
  useEffect(() => {
    if (observation) {
      resultHeading.current?.focus();
    }
  }, [observation]);

  const disabled = pending || blocked;
  const clearReview = () => {
    invalidateHistoryImportReview(reviewToken);
    setReview(null);
  };
  const edit = (update: () => void) => {
    if (disabled) {
      return;
    }
    update();
    clearReview();
    setFieldError(null);
  };
  const currentInput = (): SpansHistoryImportInput => ({
    path,
    provider,
    ...(destination === 'existing' ? { existingRunId } : {}),
  });
  const mayStartReview =
    !observation ||
    observation.result.kind === 'refused' ||
    !sameHistoryImportInput(currentInput(), observation.input);

  const beginReview = (input = currentInput()) => {
    if (lock.current || blocked) {
      return;
    }
    const submitted = snapshot(input);
    const error = validateSpansHistoryImportInput(submitted);
    setFieldError(error);
    if (!error) {
      const nextReview = { input: submitted };
      reviewToken.current = nextReview;
      setReview(nextReview);
    }
  };

  const send = async (input: SpansHistoryImportInput) => {
    if (lock.current || blocked) {
      return;
    }
    const submitted = snapshot(input);
    const error = validateSpansHistoryImportInput(submitted);
    if (error) {
      setFieldError(error);
      clearReview();
      return;
    }
    lock.current = true;
    setPending(true);
    setFieldError(null);
    continuationToken.current = null;
    setContinuation(null);
    clearReview();
    try {
      const result = await submitSpansHistoryImport(submitted);
      setObservation({ input: submitted, result });
      if (result.kind === 'success' && result.hasMore) {
        const next = snapshot(submitted);
        continuationToken.current = next;
        setContinuation(next);
      } else if (result.kind === 'unknown') {
        setBlocked(true);
      }
    } catch {
      setObservation({
        input: submitted,
        result: {
          kind: 'unknown',
          message:
            'The import outcome is unknown. Inspect retained history before retrying; Setu will not send another request in this view.',
        },
      });
      setBlocked(true);
    } finally {
      lock.current = false;
      setPending(false);
    }
  };

  const confirm = () => {
    if (!review || blocked || lock.current) {
      return;
    }
    if (consumeHistoryImportToken(reviewToken, review)) {
      setReview(null);
      send(review.input);
    }
  };

  const nextPage = (
    input: SpansHistoryImportInput,
    token: SpansHistoryImportInput
  ) => {
    if (
      blocked ||
      lock.current ||
      !consumeHistoryImportToken(continuationToken, token)
    ) {
      return;
    }
    setContinuation(null);
    send(input);
  };

  return (
    <section
      aria-labelledby={`${id}-title`}
      class="mx-auto min-w-0 max-w-4xl px-4 py-5 sm:px-6"
    >
      <details class="min-w-0 border-zinc-200 border-y py-2 dark:border-white/10">
        <summary class="min-h-11 cursor-pointer py-2 font-semibold text-zinc-800 dark:text-zinc-100">
          Import selected conversation history
        </summary>
        <div class="min-w-0 pt-2 pb-4">
          <h2
            class="font-semibold text-base text-zinc-900 dark:text-zinc-100"
            id={`${id}-title`}
          >
            Import a conversation file
          </h2>
          <p class="mt-1 max-w-2xl text-sm text-zinc-600 dark:text-zinc-300">
            Choose one absolute file path on the Mac running Setu. The source
            file stays untouched. Imported history is read-only and does not
            mean Setu ran or completed the original work.
          </p>

          <fieldset class="mt-4 min-w-0 space-y-4" disabled={disabled}>
            <legend class="sr-only">
              Selected conversation source and destination
            </legend>
            <div class="min-w-0">
              <label class="block font-medium text-sm" for={pathId}>
                Absolute source file path on the Setu Mac
              </label>
              <input
                aria-describedby={fieldError ? `${id}-error` : undefined}
                aria-invalid={Boolean(fieldError)}
                autoComplete="off"
                class={`${inputCls} mt-1 block min-h-11 w-full min-w-0 break-all font-mono`}
                id={pathId}
                onInput={(event) =>
                  edit(() => setPath(event.currentTarget.value))
                }
                value={path}
              />
            </div>

            <div class="min-w-0">
              <label class="block font-medium text-sm" for={providerId}>
                Conversation provider
              </label>
              <select
                class={`${inputCls} mt-1 block min-h-11 w-full`}
                id={providerId}
                onChange={(event) =>
                  edit(() => {
                    const { value } = event.currentTarget;
                    if (value === 'codex' || value === 'claude') {
                      setProvider(value);
                    }
                  })
                }
                value={provider}
              >
                <option value="codex">Codex</option>
                <option value="claude">Claude Code</option>
              </select>
            </div>

            <fieldset class="min-w-0 space-y-3">
              <legend class="font-medium text-sm">Import destination</legend>
              <label class="flex min-h-11 items-center gap-2 text-sm">
                <input
                  checked={destination === 'new'}
                  name={`${id}-destination`}
                  onChange={() => edit(() => setDestination('new'))}
                  type="radio"
                  value="new"
                />
                Create a new read-only Past entry
              </label>
              <label class="flex min-h-11 items-center gap-2 text-sm">
                <input
                  checked={destination === 'existing'}
                  name={`${id}-destination`}
                  onChange={() => edit(() => setDestination('existing'))}
                  type="radio"
                  value="existing"
                />
                Attach history to an existing run
              </label>
              {destination === 'existing' && (
                <div class="min-w-0">
                  <label class="block font-medium text-sm" for={existingId}>
                    Existing run ID
                  </label>
                  <input
                    aria-describedby={fieldError ? `${id}-error` : undefined}
                    aria-invalid={Boolean(fieldError)}
                    autoComplete="off"
                    class={`${inputCls} mt-1 block min-h-11 w-full min-w-0 break-all font-mono`}
                    id={existingId}
                    onInput={(event) =>
                      edit(() => setExistingRunId(event.currentTarget.value))
                    }
                    value={existingRunId}
                  />
                </div>
              )}
            </fieldset>
          </fieldset>

          {fieldError && (
            <p
              class="mt-3 text-signal-red text-sm"
              id={`${id}-error`}
              role="alert"
            >
              {fieldError}
            </p>
          )}

          {review && (
            <fieldset
              aria-labelledby={`${id}-review-title`}
              class="mt-4 min-w-0 rounded border border-zinc-300 p-3 dark:border-white/15"
            >
              <h3
                class="font-semibold"
                id={`${id}-review-title`}
                ref={reviewHeading}
                tabIndex={-1}
              >
                Review selected history import
              </h3>
              <SubmittedInput input={review.input} />
              <p class="mt-3 text-sm text-zinc-600 dark:text-zinc-300">
                This reads one bounded page from the selected file. The imported
                entry remains history only; it does not claim the original work
                succeeded.
              </p>
              <div class="mt-3 flex flex-wrap gap-2">
                <Button class="min-h-11" disabled={disabled} onClick={confirm}>
                  Import this page
                </Button>
                <Button
                  class="min-h-11"
                  disabled={disabled}
                  onClick={clearReview}
                  variant="secondary"
                >
                  Edit selection
                </Button>
              </div>
            </fieldset>
          )}

          {!review &&
            mayStartReview &&
            observation?.result.kind !== 'unknown' && (
              <Button
                class="mt-4 min-h-11"
                disabled={disabled}
                onClick={() => beginReview()}
              >
                {observation?.result.kind === 'success' &&
                !observation.result.hasMore &&
                sameHistoryImportInput(currentInput(), observation.input)
                  ? 'Review this file again'
                  : 'Review import'}
              </Button>
            )}

          {pending && (
            <p aria-live="polite" class="mt-3 text-sm" role="status">
              Importing one history page… Keep this view open until Setu reports
              the result.
            </p>
          )}

          {observation && (
            <ImportOutcome
              continuation={continuation}
              observation={observation}
              onNext={nextPage}
              onReviewAgain={beginReview}
              onSelect={onSelect}
              resultHeading={resultHeading}
            />
          )}
        </div>
      </details>
    </section>
  );
}
