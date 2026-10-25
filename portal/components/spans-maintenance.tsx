import { useEffect, useRef, useState } from 'preact/hooks';
import {
  type MaintenanceInput,
  type MaintenanceOperation,
  type MaintenanceResult,
  submitSpansMaintenance,
  validateMaintenanceInput,
} from '../spans-maintenance';
import { inputCls } from '../ui';
import { Button } from '../ui/button';

interface Review {
  backupRoot: string;
  destination: string;
  operation: MaintenanceOperation;
}

interface Observed {
  result: MaintenanceResult;
  review: Review;
}

interface MaintenanceStorage {
  getItem: (key: string) => string | null;
  setItem: (key: string, value: string) => void;
}

const RECOVERY_STORAGE_KEY = 'setu.spans-maintenance.recovery.v1';
const MAX_RECOVERY_BYTES = 64 * 1024;
const MAX_RECOVERY_ITEMS = 64;
const RECOVERY_UNAVAILABLE =
  'This tab could not save its maintenance recovery note, so the request was not sent.';
const RECOVERY_INVALID =
  'This tab could not read its maintenance recovery note. No new request can be sent until it is resolved.';
const RECOVERY_WRITE_FAILED =
  'This tab could not update its maintenance recovery note. The prior note was kept; inspect its destination before continuing.';
const UNKNOWN_MESSAGE =
  'The result is unknown. Inspect the destination before acting again.';
const INCOMPLETE_MESSAGE =
  'The incomplete destination was retained. Inspect it before acting again.';
const MAX_PATH_BYTES = 64 * 1024;

function exactObject(
  value: unknown,
  keys: string[]
): value is Record<string, unknown> {
  if (
    value === null ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    return false;
  }
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return (
    actual.length === expected.length &&
    actual.every((key, index) => key === expected[index])
  );
}

function validReview(review: unknown): review is Review {
  if (
    !exactObject(review, ['backupRoot', 'destination', 'operation']) ||
    typeof review.backupRoot !== 'string' ||
    typeof review.destination !== 'string' ||
    (review.operation !== 'backup' && review.operation !== 'restore')
  ) {
    return false;
  }
  if (review.operation === 'backup') {
    return (
      review.backupRoot === '' &&
      validateMaintenanceInput({
        destination: review.destination,
        operation: 'backup',
      }) === null
    );
  }
  return (
    validateMaintenanceInput({
      backupRoot: review.backupRoot,
      destination: review.destination,
      operation: 'restore',
    }) === null
  );
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function persistedStatus(observed: Observed): 'incomplete' | 'unknown' | null {
  if (observed.result.kind === 'incomplete') {
    return 'incomplete';
  }
  return observed.result.kind === 'unknown' ? 'unknown' : null;
}

function observedFromPersisted(item: Record<string, unknown>): Observed | null {
  if (
    !exactObject(item, ['backupRoot', 'destination', 'operation', 'status']) ||
    (item.status !== 'pending' &&
      item.status !== 'incomplete' &&
      item.status !== 'unknown')
  ) {
    return null;
  }
  const review = {
    backupRoot: item.backupRoot,
    destination: item.destination,
    operation: item.operation,
  };
  if (!validReview(review)) {
    return null;
  }
  const incomplete = item.status === 'incomplete';
  return {
    result: {
      kind: incomplete ? 'incomplete' : 'unknown',
      message: incomplete ? INCOMPLETE_MESSAGE : UNKNOWN_MESSAGE,
    },
    review,
  };
}

export function loadUnresolvedMaintenance(
  storage: MaintenanceStorage
): { ok: true; observations: Observed[] } | { ok: false; observations: [] } {
  try {
    const stored = storage.getItem(RECOVERY_STORAGE_KEY);
    if (stored === null) {
      return { observations: [], ok: true };
    }
    if (byteLength(stored) > MAX_RECOVERY_BYTES) {
      return { observations: [], ok: false };
    }
    const parsed: unknown = JSON.parse(stored);
    if (
      !exactObject(parsed, ['items', 'version']) ||
      parsed.version !== 1 ||
      !Array.isArray(parsed.items) ||
      parsed.items.length > MAX_RECOVERY_ITEMS
    ) {
      return { observations: [], ok: false };
    }
    const observations: Observed[] = [];
    const destinations = new Set<string>();
    for (const item of parsed.items) {
      if (item === null || typeof item !== 'object' || Array.isArray(item)) {
        return { observations: [], ok: false };
      }
      const observation = observedFromPersisted(
        item as Record<string, unknown>
      );
      if (
        observation === null ||
        destinations.has(observation.review.destination)
      ) {
        return { observations: [], ok: false };
      }
      destinations.add(observation.review.destination);
      observations.push(observation);
    }
    return { observations, ok: true };
  } catch {
    return { observations: [], ok: false };
  }
}

export function writeUnresolvedMaintenance(
  storage: MaintenanceStorage,
  observations: Observed[]
): boolean {
  try {
    if (
      !Array.isArray(observations) ||
      observations.length > MAX_RECOVERY_ITEMS
    ) {
      return false;
    }
    const items: {
      backupRoot: string;
      destination: string;
      operation: MaintenanceOperation;
      status: 'incomplete' | 'unknown';
    }[] = [];
    const destinations = new Set<string>();
    for (const observation of observations) {
      const status = persistedStatus(observation);
      if (status === null) {
        continue;
      }
      if (
        !validReview(observation.review) ||
        byteLength(observation.review.destination) > MAX_PATH_BYTES ||
        byteLength(observation.review.backupRoot) > MAX_PATH_BYTES ||
        destinations.has(observation.review.destination)
      ) {
        return false;
      }
      destinations.add(observation.review.destination);
      items.push({
        backupRoot: observation.review.backupRoot,
        destination: observation.review.destination,
        operation: observation.review.operation,
        status,
      });
    }
    const serialized = JSON.stringify({ items, version: 1 });
    if (byteLength(serialized) > MAX_RECOVERY_BYTES) {
      return false;
    }
    storage.setItem(RECOVERY_STORAGE_KEY, serialized);
    return true;
  } catch {
    return false;
  }
}

function currentSessionStorage(): MaintenanceStorage | null {
  try {
    return typeof window === 'undefined' ? null : window.sessionStorage;
  } catch {
    return null;
  }
}

function persistPendingReview(review: Review, unresolved: Observed[]): boolean {
  const storage = currentSessionStorage();
  return (
    storage !== null &&
    writeUnresolvedMaintenance(storage, [
      ...unresolved,
      { result: { kind: 'unknown', message: UNKNOWN_MESSAGE }, review },
    ])
  );
}

function requestFor(review: Review): MaintenanceInput {
  return review.operation === 'backup'
    ? { destination: review.destination, operation: 'backup' }
    : {
        backupRoot: review.backupRoot,
        destination: review.destination,
        operation: 'restore',
      };
}

export function hasUnresolvedDestination(
  observed: Observed | null,
  destination: string
): boolean {
  return (
    observed !== null &&
    ['unknown', 'incomplete'].includes(observed.result.kind) &&
    destination === observed.review.destination
  );
}

export function retainUnresolvedMaintenance(
  prior: Observed[],
  observation: Observed
): Observed[] {
  return ['unknown', 'incomplete'].includes(observation.result.kind)
    ? [
        ...prior.filter(
          (item) => item.review.destination !== observation.review.destination
        ),
        observation,
      ]
    : prior;
}

function resultMessage(result: MaintenanceResult): string {
  if (result.kind === 'unknown') {
    return 'The outcome is unknown. The operation may have completed; inspect the destination before starting another operation.';
  }
  if (result.kind === 'incomplete') {
    return 'The operation did not complete fully. Its destination is retained; inspect it before starting another operation.';
  }
  if (result.kind === 'refused') {
    return result.message;
  }
  return 'The destination is ready. Restored archives remain inactive.';
}

function ResultCounts({
  counts,
}: {
  counts: Extract<MaintenanceResult, { kind: 'success' }>['counts'];
}) {
  return (
    <dl class="mt-3 grid min-w-0 gap-x-4 gap-y-1 text-sm sm:grid-cols-2">
      <dt>Artifacts</dt>
      <dd>{counts.artifacts}</dd>
      <dt>Artifact bytes</dt>
      <dd>{counts.artifactBytes}</dd>
      <dt>Cache entries</dt>
      <dd>{counts.cacheEntries}</dd>
      <dt>Database bytes</dt>
      <dd>{counts.databaseBytes}</dd>
      <dt>Events</dt>
      <dd>{counts.events}</dd>
      <dt>Sources</dt>
      <dd>{counts.sources}</dd>
      <dt>Views</dt>
      <dd>{counts.views}</dd>
    </dl>
  );
}

function ReviewPanel({
  busy,
  onConfirm,
  onEdit,
  observed,
  review,
  reviewHeading,
}: {
  busy: boolean;
  onConfirm: () => void;
  onEdit: () => void;
  observed: Observed | null;
  review: Review;
  reviewHeading: { current: HTMLHeadingElement | null };
}) {
  return (
    <fieldset
      aria-labelledby="spans-maintenance-review-title"
      class="mt-4 min-w-0 rounded border border-zinc-300 p-3 dark:border-white/15"
    >
      <h3
        class="font-semibold"
        id="spans-maintenance-review-title"
        ref={reviewHeading}
        tabIndex={-1}
      >
        Review this {review.operation}
      </h3>
      <dl class="mt-2 grid min-w-0 gap-1 text-sm">
        {review.operation === 'restore' && (
          <>
            <dt>Backup folder</dt>
            <dd class="min-w-0 break-all font-mono">{review.backupRoot}</dd>
          </>
        )}
        <dt>Destination</dt>
        <dd class="min-w-0 break-all font-mono">{review.destination}</dd>
      </dl>
      <p class="mt-2 text-sm text-zinc-600 dark:text-zinc-300">
        {review.operation === 'restore'
          ? 'The restored archive will remain inactive.'
          : 'This creates a backup at the destination shown above.'}
      </p>
      <div class="mt-3 flex flex-wrap gap-2">
        <Button
          disabled={busy || observed?.review === review}
          onClick={onConfirm}
        >
          Confirm {review.operation}
        </Button>
        <Button disabled={busy} onClick={onEdit} variant="secondary">
          Edit paths
        </Button>
      </div>
    </fieldset>
  );
}

function MaintenanceOutcome({
  observed,
  resultHeading,
}: {
  observed: Observed;
  resultHeading: { current: HTMLHeadingElement | null };
}) {
  const operationName =
    observed.review.operation === 'backup' ? 'Backup' : 'Restore';
  return (
    <div
      class="mt-4 min-w-0"
      role={observed.result.kind === 'success' ? 'status' : 'alert'}
    >
      <h3 class="font-semibold" ref={resultHeading} tabIndex={-1}>
        {observed.result.kind === 'success'
          ? `${operationName} completed`
          : `${operationName} ${observed.result.kind}`}
      </h3>
      <p class="mt-1 text-sm">{resultMessage(observed.result)}</p>
      <dl class="mt-2 grid min-w-0 gap-1 text-sm">
        {observed.review.operation === 'restore' && (
          <>
            <dt>Backup folder</dt>
            <dd class="min-w-0 break-all font-mono">
              {observed.review.backupRoot}
            </dd>
          </>
        )}
        <dt>Destination</dt>
        <dd class="min-w-0 break-all font-mono">
          {observed.review.destination}
        </dd>
      </dl>
      {observed.result.kind === 'success' && (
        <ResultCounts counts={observed.result.counts} />
      )}
    </div>
  );
}

export function SpansMaintenance() {
  const [operation, setOperation] = useState<MaintenanceOperation>('backup');
  const [destination, setDestination] = useState('');
  const [backupRoot, setBackupRoot] = useState('');
  const [review, setReview] = useState<Review | null>(null);
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [observed, setObserved] = useState<Observed | null>(null);
  const [unresolved, setUnresolved] = useState<Observed[]>([]);
  const [recoveryReady, setRecoveryReady] = useState(false);
  const [recoveryError, setRecoveryError] = useState<string | null>(null);
  const submissionLock = useRef(false);
  const submittedReview = useRef<Review | null>(null);
  const mounted = useRef(false);
  const ticket = useRef(0);
  const reviewHeading = useRef<HTMLHeadingElement>(null);
  const resultHeading = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    if (review) {
      reviewHeading.current?.focus();
    }
  }, [review]);
  useEffect(() => {
    if (observed) {
      resultHeading.current?.focus();
    }
  }, [observed]);

  useEffect(() => {
    mounted.current = true;
    const storage = currentSessionStorage();
    if (storage === null) {
      setRecoveryError(RECOVERY_UNAVAILABLE);
      setRecoveryReady(true);
    } else {
      const loaded = loadUnresolvedMaintenance(storage);
      if (loaded.ok) {
        setUnresolved(loaded.observations);
      } else {
        setRecoveryError(RECOVERY_INVALID);
      }
      setRecoveryReady(true);
    }
    return () => {
      mounted.current = false;
      ticket.current += 1;
    };
  }, []);

  const edit = (update: () => void) => {
    update();
    setReview(null);
    setFieldError(null);
  };

  const draft = (): Review => ({ backupRoot, destination, operation });
  const validate = (value: Review) =>
    validateMaintenanceInput(requestFor(value));
  const beginReview = () => {
    if (submissionLock.current || !recoveryReady || recoveryError) {
      return;
    }
    const current = draft();
    if (
      unresolved.some((item) =>
        hasUnresolvedDestination(item, current.destination)
      )
    ) {
      setFieldError(
        'This destination has an unresolved result. Inspect it before proceeding, or choose a different new destination.'
      );
      setReview(null);
      return;
    }
    const error = validate(current);
    setFieldError(error);
    if (!error) {
      setReview(current);
    }
  };

  const recordResult = (result: MaintenanceResult, reviewed: Review) => {
    const observation = { result, review: reviewed };
    const next = ['unknown', 'incomplete'].includes(result.kind)
      ? retainUnresolvedMaintenance(unresolved, observation)
      : unresolved.filter(
          (item) => item.review.destination !== reviewed.destination
        );
    const storage = currentSessionStorage();
    if (storage === null || !writeUnresolvedMaintenance(storage, next)) {
      setRecoveryError(RECOVERY_WRITE_FAILED);
    }
    setObserved(observation);
    setUnresolved(next);
  };

  const isCurrentSubmission = (currentTicket: number) =>
    mounted.current && ticket.current === currentTicket;

  const submitReviewed = async (reviewed: Review) => {
    if (!persistPendingReview(reviewed, unresolved)) {
      setRecoveryError(RECOVERY_UNAVAILABLE);
      return;
    }
    submissionLock.current = true;
    submittedReview.current = reviewed;
    setPending(true);
    ticket.current += 1;
    const currentTicket = ticket.current;
    try {
      const result = await submitSpansMaintenance(requestFor(reviewed));
      if (isCurrentSubmission(currentTicket)) {
        recordResult(result, reviewed);
      }
    } catch {
      if (isCurrentSubmission(currentTicket)) {
        recordResult(
          {
            kind: 'unknown',
            message: 'The request outcome could not be confirmed.',
          },
          reviewed
        );
      }
    } finally {
      if (isCurrentSubmission(currentTicket)) {
        submissionLock.current = false;
        setPending(false);
      }
    }
  };

  const confirm = async () => {
    if (!review) {
      return;
    }
    if (submissionLock.current || submittedReview.current === review) {
      return;
    }
    if (!recoveryReady || recoveryError) {
      return;
    }
    const error = validate(review);
    if (error) {
      setFieldError(error);
      setReview(null);
      return;
    }
    await submitReviewed(review);
  };

  const busy = pending || !recoveryReady || recoveryError !== null;
  return (
    <section
      aria-labelledby="spans-maintenance-title"
      class="mx-auto max-w-4xl px-4 pb-6 sm:px-6"
    >
      <details class="min-w-0 border-zinc-200 border-y py-2 dark:border-white/10">
        <summary class="min-h-11 cursor-pointer py-2 font-semibold text-zinc-800 dark:text-zinc-100">
          Archive backup and restore
        </summary>
        <div class="min-w-0 pt-2 pb-4">
          <h2
            class="font-semibold text-base text-zinc-900 dark:text-zinc-100"
            id="spans-maintenance-title"
          >
            Archive maintenance
          </h2>
          <p class="mt-1 max-w-2xl text-sm text-zinc-600 dark:text-zinc-300">
            Paths are on the Mac running Setu. Use a new destination folder;
            existing folders are never overwritten. A restore creates a
            separate, inactive archive.
          </p>
          <p class="mt-1 max-w-2xl text-sm text-zinc-600 dark:text-zinc-300">
            If this tab reloads before a result arrives, the destination stays
            blocked until you inspect it.
          </p>

          {recoveryError && (
            <p class="mt-3 text-signal-red text-sm" role="alert">
              {recoveryError}
            </p>
          )}

          <fieldset class="mt-4 min-w-0 space-y-4" disabled={busy}>
            <legend class="sr-only">Backup or restore an archive</legend>
            <div class="min-w-0">
              <label
                class="block font-medium text-sm"
                for="spans-maintenance-operation"
              >
                Operation
              </label>
              <select
                class={`${inputCls} mt-1 block w-full`}
                id="spans-maintenance-operation"
                onChange={(event) =>
                  edit(() =>
                    setOperation(
                      (event.currentTarget as HTMLSelectElement)
                        .value as MaintenanceOperation
                    )
                  )
                }
                value={operation}
              >
                <option value="backup">Create backup</option>
                <option value="restore">Restore to a separate archive</option>
              </select>
            </div>

            {operation === 'restore' && (
              <div class="min-w-0">
                <label
                  class="block font-medium text-sm"
                  for="spans-maintenance-backup"
                >
                  Backup folder on the Setu Mac
                </label>
                <input
                  aria-describedby={
                    fieldError ? 'spans-maintenance-error' : undefined
                  }
                  aria-invalid={!!fieldError}
                  autoComplete="off"
                  class={`${inputCls} mt-1 block w-full min-w-0 break-all font-mono`}
                  id="spans-maintenance-backup"
                  onInput={(event) =>
                    edit(() =>
                      setBackupRoot(
                        (event.currentTarget as HTMLInputElement).value
                      )
                    )
                  }
                  value={backupRoot}
                />
              </div>
            )}

            <div class="min-w-0">
              <label
                class="block font-medium text-sm"
                for="spans-maintenance-destination"
              >
                {operation === 'backup'
                  ? 'New backup folder on the Setu Mac'
                  : 'New restore archive folder on the Setu Mac'}
              </label>
              <input
                aria-describedby={
                  fieldError ? 'spans-maintenance-error' : undefined
                }
                aria-invalid={!!fieldError}
                autoComplete="off"
                class={`${inputCls} mt-1 block w-full min-w-0 break-all font-mono`}
                id="spans-maintenance-destination"
                onInput={(event) =>
                  edit(() =>
                    setDestination(
                      (event.currentTarget as HTMLInputElement).value
                    )
                  )
                }
                value={destination}
              />
            </div>
          </fieldset>

          {fieldError && (
            <p
              class="mt-3 text-signal-red text-sm"
              id="spans-maintenance-error"
              role="alert"
            >
              {fieldError}
            </p>
          )}

          {review ? (
            <ReviewPanel
              busy={busy}
              observed={observed}
              onConfirm={confirm}
              onEdit={() => setReview(null)}
              review={review}
              reviewHeading={reviewHeading}
            />
          ) : (
            <Button class="mt-4" disabled={busy} onClick={beginReview}>
              Review {operation === 'backup' ? 'backup' : 'restore'}
            </Button>
          )}

          {busy && (
            <p aria-live="polite" class="mt-3 text-sm" role="status">
              Submitting {review?.operation} request… Leaving this page will not
              cancel it.
            </p>
          )}
          {unresolved
            .filter((item) => item !== observed)
            .map((item) => (
              <MaintenanceOutcome
                key={item.review.destination}
                observed={item}
                resultHeading={{ current: null }}
              />
            ))}
          {observed && (
            <MaintenanceOutcome
              observed={observed}
              resultHeading={resultHeading}
            />
          )}
        </div>
      </details>
    </section>
  );
}
