import type { ComponentChildren } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import {
  createSpansClientIntegrationsTransport,
  hasUnknownSpansIntegrationApplyOutcome,
  isCurrentSpansIntegrationReview,
  isCurrentSpansIntegrationRevision,
  needsSpansIntegrationReconciliation,
  type SpansClientIntegrationsApplyResult,
  type SpansClientIntegrationsResult,
  type SpansClientIntegrationsReview,
  type SpansClientIntegrationsReviewSelection,
  type SpansClientIntegrationsSummary,
  type SpansIntegrationClient,
  type SpansIntegrationEvidence,
  type SpansIntegrationOperation,
} from '../spans-client-integrations';
import { inputCls, Section } from '../ui';
import { Badge } from '../ui/badge';
import { Button } from '../ui/button';

type IntegrationMode = 'install-update' | 'remove-shared';
type BusyAction = 'review' | 'apply' | 'reconcile';

const integrations = createSpansClientIntegrationsTransport();
let reconciliationRequiredInSession = false;
let pendingIntegrationApply: Promise<void> | null = null;
let finishPendingIntegrationApply: (() => void) | null = null;
const clientNames: Record<SpansIntegrationClient, string> = {
  claude: 'Claude Code',
  codex: 'Codex',
  cursor: 'Cursor',
};

function evidenceLabel(
  evidence: SpansIntegrationEvidence,
  kind: 'connection' | 'fresh-session' | 'installed' | 'skill-activation'
) {
  if (evidence === 'unknown') {
    return 'Not verified';
  }
  const labels = evidence
    ? {
        connection: 'Connected',
        'fresh-session': 'Observed',
        installed: 'Installed',
        'skill-activation': 'Observed',
      }
    : {
        connection: 'Not connected',
        'fresh-session': 'Not observed',
        installed: 'Not verified as current',
        'skill-activation': 'Not observed',
      };
  return labels[kind];
}

function fixedFailureMessage(code: string, action: BusyAction | 'status') {
  if (code === 'INTEGRATION_PREVIEW_STALE') {
    return 'The reviewed files changed. Create a new review before applying.';
  }
  if (
    code === 'INTEGRATION_RECONCILIATION_REQUIRED' ||
    code === 'INTEGRATION_STATE_WRITE_UNKNOWN'
  ) {
    return 'Receipt state needs reconciliation before another review can be applied.';
  }
  if (action === 'status') {
    return 'Could not refresh client integration status. Retry to read it again.';
  }
  if (action === 'review') {
    return 'Could not create a fresh review. Refresh status and try Review again.';
  }
  if (action === 'reconcile') {
    return 'Receipt reconciliation could not be confirmed. Reconcile receipts again before reviewing.';
  }
  return 'Apply was not confirmed. Refresh status and create a new review before trying again.';
}

function conflictMessage(code: string) {
  if (
    code === 'RECONCILIATION_REQUIRED' ||
    code === 'INTEGRATION_RECONCILIATION_REQUIRED'
  ) {
    return 'A prior operation needs receipt reconciliation. This screen will leave the artifact unchanged.';
  }
  return 'Setu cannot verify ownership or the current file contents. This conflict is read-only; resolve it outside this screen, then review again.';
}

function operationLabel(operation: SpansIntegrationOperation) {
  if (operation.kind === 'no-op') {
    return 'No change needed';
  }
  if (operation.kind === 'install') {
    return 'Install';
  }
  if (operation.kind === 'update') {
    return 'Update';
  }
  return 'Remove';
}

function IntegrationConflicts({
  conflicts,
}: {
  conflicts: SpansClientIntegrationsSummary['conflicts'];
}) {
  if (!conflicts.length) {
    return null;
  }
  return (
    <fieldset class="border border-amber-500/40 bg-amber-50/60 p-3 dark:bg-amber-950/20">
      <legend class="px-1 font-semibold text-sm">
        Conflicts need attention
      </legend>
      <ul class="mt-2 flex flex-col gap-3">
        {conflicts.map((conflict, index) => (
          <li class="min-w-0 text-sm" key={`${conflict.code}-${index}`}>
            <p>{conflictMessage(conflict.code)}</p>
            {conflict.path && (
              <p class="mt-1 break-all font-mono text-xs text-zinc-600 dark:text-zinc-300">
                {conflict.path}
              </p>
            )}
          </li>
        ))}
      </ul>
    </fieldset>
  );
}

function ClientStatusList({
  statuses,
}: {
  statuses: SpansClientIntegrationsSummary['statuses'];
}) {
  if (!statuses.length) {
    return (
      <p class="text-sm text-zinc-600 dark:text-zinc-300">
        No client status evidence is available yet.
      </p>
    );
  }
  return (
    <ul class="flex flex-col divide-y divide-zinc-200/70 dark:divide-white/10">
      {statuses.map((status) => (
        <li class="min-w-0 py-3 first:pt-0 last:pb-0" key={status.client}>
          <div class="mb-2 flex flex-wrap items-center gap-2">
            <h3 class="font-semibold text-sm">{clientNames[status.client]}</h3>
            <Badge tone="zinc">Client status</Badge>
          </div>
          <dl class="grid grid-cols-1 gap-x-5 gap-y-2 text-xs sm:grid-cols-2 lg:grid-cols-4">
            <div>
              <dt class="text-zinc-500 dark:text-zinc-400">
                Artifact installed
              </dt>
              <dd class="mt-0.5 font-medium">
                {evidenceLabel(status.installed, 'installed')}
              </dd>
            </div>
            <div>
              <dt class="text-zinc-500 dark:text-zinc-400">
                Connection observed
              </dt>
              <dd class="mt-0.5 font-medium">
                {evidenceLabel(status.connected, 'connection')}
              </dd>
            </div>
            <div>
              <dt class="text-zinc-500 dark:text-zinc-400">
                Fresh session observed
              </dt>
              <dd class="mt-0.5 font-medium">
                {evidenceLabel(status.freshSession, 'fresh-session')}
              </dd>
            </div>
            <div>
              <dt class="text-zinc-500 dark:text-zinc-400">
                Skill activation evidence
              </dt>
              <dd class="mt-0.5 font-medium">
                {evidenceLabel(status.skillActivated, 'skill-activation')}
              </dd>
            </div>
          </dl>
        </li>
      ))}
    </ul>
  );
}

function ClientStatusPanel({
  disabled,
  onRefresh,
  statusError,
  statusLoading,
  summary,
}: {
  disabled: boolean;
  onRefresh: () => Promise<void>;
  statusError: string | null;
  statusLoading: boolean;
  summary: SpansClientIntegrationsSummary | null;
}) {
  let statusContent: ComponentChildren;
  if (summary) {
    statusContent = (
      <>
        <ClientStatusList statuses={summary.statuses} />
        <IntegrationConflicts conflicts={summary.conflicts} />
      </>
    );
  } else if (statusLoading) {
    statusContent = (
      <p aria-live="polite" class="text-sm text-zinc-500" role="status">
        Loading client status…
      </p>
    );
  } else {
    statusContent = (
      <p class="text-sm text-zinc-600 dark:text-zinc-300">
        Client status is not available yet.
      </p>
    );
  }
  return (
    <div class="flex flex-col gap-3">
      <div class="flex flex-wrap items-center justify-between gap-2">
        <h3 class="font-semibold text-sm">Current client status</h3>
        <Button
          compact
          disabled={disabled}
          onClick={onRefresh}
          variant="secondary"
        >
          {statusLoading ? 'Refreshing…' : 'Refresh status'}
        </Button>
      </div>
      {statusError && (
        <p class="text-red-700 text-sm dark:text-red-300" role="status">
          {statusError}
        </p>
      )}
      {statusContent}
    </div>
  );
}

function ActionSelector({
  disabled,
  mode,
  onChange,
}: {
  disabled: boolean;
  mode: IntegrationMode;
  onChange: (mode: IntegrationMode) => void;
}) {
  return (
    <fieldset
      class="flex flex-col gap-3 border-zinc-200/70 border-y py-3 dark:border-white/10"
      disabled={disabled}
    >
      <legend class="px-1 font-semibold text-sm">Choose an action</legend>
      <label class="flex items-start gap-2 text-sm">
        <input
          checked={mode === 'install-update'}
          class="mt-0.5"
          name="spans-client-integrations-mode"
          onChange={() => onChange('install-update')}
          type="radio"
        />
        <span>
          Review install or update for Claude Code, Codex, and Cursor
          <span class="mt-0.5 block text-xs text-zinc-500 dark:text-zinc-400">
            Codex and Cursor share one Setu-owned skill artifact.
          </span>
        </span>
      </label>
      <label class="flex items-start gap-2 text-sm">
        <input
          checked={mode === 'remove-shared'}
          class="mt-0.5"
          name="spans-client-integrations-mode"
          onChange={() => onChange('remove-shared')}
          type="radio"
        />
        <span>
          Review removal of the shared Codex and Cursor artifact
          <span class="mt-0.5 block text-xs text-zinc-500 dark:text-zinc-400">
            Removes only the exact Setu-owned file after review. Claude Code’s
            bundled plugin remains in Setu.
          </span>
        </span>
      </label>
    </fieldset>
  );
}

function ReconciliationNotice({
  busy,
  busyAction,
  onReconcile,
}: {
  busy: boolean;
  busyAction: BusyAction | null;
  onReconcile: () => Promise<void>;
}) {
  return (
    <div
      class="flex flex-col items-start gap-2 border border-amber-500/40 bg-amber-50/60 p-3 dark:bg-amber-950/20"
      role="alert"
    >
      <p class="text-sm">
        A prior apply needs receipt reconciliation. Applying and creating a new
        review are blocked until the receipt state is reconciled.
      </p>
      <Button disabled={busy} onClick={onReconcile} variant="secondary">
        {busyAction === 'reconcile'
          ? 'Reconciling receipts…'
          : 'Reconcile receipts'}
      </Button>
    </div>
  );
}

function ActionFeedback({
  actionMessage,
  reviewError,
}: {
  actionMessage: string | null;
  reviewError: string | null;
}) {
  return (
    <>
      {reviewError && (
        <p class="text-red-700 text-sm dark:text-red-300" role="status">
          {reviewError}
        </p>
      )}
      {actionMessage && (
        <p class="text-sm text-zinc-700 dark:text-zinc-200" role="status">
          {actionMessage}
        </p>
      )}
    </>
  );
}

function ReviewChallengeControls({
  busy,
  busyAction,
  mode,
  needsReconciliation,
  onApply,
  onPhraseChange,
  phrase,
  review,
}: {
  busy: boolean;
  busyAction: BusyAction | null;
  mode: IntegrationMode;
  needsReconciliation: boolean;
  onApply: () => Promise<void>;
  onPhraseChange: (phrase: string) => void;
  phrase: string;
  review: SpansClientIntegrationsReview;
}) {
  const challenge = reviewHasChallenge(review) ? review : null;
  if (!challenge) {
    return (
      <p class="text-sm text-zinc-600 dark:text-zinc-300" role="status">
        {review.summary.ready
          ? 'A confirmation challenge is not available. Create a fresh review before applying.'
          : 'This review has conflicts and cannot be applied. Resolve them outside this screen, then review again.'}
      </p>
    );
  }
  const expired = Date.parse(challenge.expiresAt) <= Date.now();
  const removalPhraseValid =
    mode !== 'remove-shared' || challenge.phrase.startsWith('Remove');
  const phraseMatches = phrase === challenge.phrase;
  return (
    <div class="flex flex-col items-start gap-2">
      <p class="text-xs text-zinc-600 dark:text-zinc-300">
        Review expires at{' '}
        <time dateTime={challenge.expiresAt}>
          {new Date(challenge.expiresAt).toLocaleTimeString()}
        </time>
        .
      </p>
      {expired && (
        <p class="text-amber-800 text-sm dark:text-amber-200" role="status">
          This review expired. Create a fresh review before applying.
        </p>
      )}
      {mode === 'remove-shared' && !removalPhraseValid && (
        <p class="text-red-700 text-sm dark:text-red-300" role="status">
          The removal review did not return a valid confirmation phrase. Create
          a fresh review before continuing.
        </p>
      )}
      <p class="text-sm">
        Type this exact phrase:{' '}
        <strong class="font-mono">{challenge.phrase}</strong>
      </p>
      <label
        class="w-full max-w-xl font-medium text-xs"
        for="spans-integration-confirmation"
      >
        Confirmation phrase
        <input
          autoComplete="off"
          class={`${inputCls} mt-1 py-1.5 font-mono text-sm`}
          disabled={busy || needsReconciliation}
          id="spans-integration-confirmation"
          onInput={(event) => onPhraseChange(event.currentTarget.value)}
          value={phrase}
        />
      </label>
      <Button
        disabled={
          busy ||
          needsReconciliation ||
          !phraseMatches ||
          expired ||
          !removalPhraseValid
        }
        onClick={onApply}
      >
        {busyAction === 'apply'
          ? 'Applying reviewed change…'
          : 'Apply reviewed change'}
      </Button>
    </div>
  );
}

function IntegrationReviewPanel({
  busy,
  busyAction,
  mode,
  needsReconciliation,
  onApply,
  onPhraseChange,
  phrase,
  review,
}: {
  busy: boolean;
  busyAction: BusyAction | null;
  mode: IntegrationMode;
  needsReconciliation: boolean;
  onApply: () => Promise<void>;
  onPhraseChange: (phrase: string) => void;
  phrase: string;
  review: SpansClientIntegrationsReview | null;
}) {
  if (!review) {
    return null;
  }
  return (
    <section
      aria-labelledby="spans-integration-review-title"
      class="flex min-w-0 flex-col gap-3 border-zinc-200/70 border-t pt-4 dark:border-white/10"
    >
      <div>
        <h3 class="font-semibold text-sm" id="spans-integration-review-title">
          Review exact changes
        </h3>
        <p class="mt-1 text-xs text-zinc-600 dark:text-zinc-300">
          Check every path, content digest, and consumer before typing the
          confirmation phrase. User-edited or conflicting files stay unchanged.
        </p>
      </div>
      <ReviewedOperations review={review} />
      <IntegrationConflicts conflicts={review.summary.conflicts} />
      <ReviewChallengeControls
        busy={busy}
        busyAction={busyAction}
        mode={mode}
        needsReconciliation={needsReconciliation}
        onApply={onApply}
        onPhraseChange={onPhraseChange}
        phrase={phrase}
        review={review}
      />
    </section>
  );
}

function ReviewedOperations({
  review,
}: {
  review: SpansClientIntegrationsReview;
}) {
  const {
    summary: { operations, sharedArtifactRemoval },
  } = review;
  return (
    <div class="flex flex-col gap-3">
      {operations.length ? (
        <ul class="flex flex-col divide-y divide-zinc-200/70 border-zinc-200/70 border-y dark:divide-white/10 dark:border-white/10">
          {operations.map((operation, index) => (
            <li
              class="min-w-0 py-3 first:pt-3 last:pb-3"
              key={`${operation.path}-${index}`}
            >
              <div class="flex flex-wrap items-center gap-2">
                <Badge tone={operation.kind === 'remove' ? 'amber' : 'zinc'}>
                  {operationLabel(operation)}
                </Badge>
                <span class="font-medium text-sm">
                  {clientNames[operation.client]}
                </span>
                {operation.version && (
                  <span class="text-xs text-zinc-500 dark:text-zinc-400">
                    {operation.version}
                  </span>
                )}
              </div>
              <dl class="mt-2 grid min-w-0 gap-2 text-xs">
                <div>
                  <dt class="text-zinc-500 dark:text-zinc-400">Exact path</dt>
                  <dd class="mt-0.5 break-all font-mono">{operation.path}</dd>
                </div>
                {operation.digest && (
                  <div>
                    <dt class="text-zinc-500 dark:text-zinc-400">
                      {operation.kind === 'remove'
                        ? 'Current digest'
                        : 'Content digest'}
                    </dt>
                    <dd class="mt-0.5 break-all font-mono">
                      {operation.digest}
                    </dd>
                  </div>
                )}
                {operation.consumers && (
                  <div>
                    <dt class="text-zinc-500 dark:text-zinc-400">Consumers</dt>
                    <dd class="mt-0.5">
                      {operation.consumers
                        .map((client) => clientNames[client])
                        .join(', ')}
                    </dd>
                  </div>
                )}
              </dl>
            </li>
          ))}
        </ul>
      ) : (
        <p class="text-sm text-zinc-600 dark:text-zinc-300">
          The selected client artifacts already match the reviewed Setu bundle.
        </p>
      )}
      {sharedArtifactRemoval && (
        <>
          <dl class="grid min-w-0 gap-2 border-zinc-200/70 border-y py-3 text-xs dark:border-white/10">
            <div>
              <dt class="text-zinc-500 dark:text-zinc-400">
                Shared artifact path
              </dt>
              <dd class="mt-0.5 break-all font-mono">
                {sharedArtifactRemoval.path}
              </dd>
            </div>
            <div>
              <dt class="text-zinc-500 dark:text-zinc-400">
                Affected consumers
              </dt>
              <dd class="mt-0.5">
                {sharedArtifactRemoval.affectedClients
                  .map((client) => clientNames[client])
                  .join(' and ')}
              </dd>
            </div>
          </dl>
          <p class="text-sm">Claude Code’s bundled plugin remains in Setu.</p>
        </>
      )}
    </div>
  );
}

function reviewHasChallenge(
  review: SpansClientIntegrationsReview | null
): review is SpansClientIntegrationsReviewChallenge {
  if (review === null) {
    return false;
  }
  return Boolean(
    review.summary.ready && review.reviewId && review.phrase && review.expiresAt
  );
}

type SpansClientIntegrationsReviewChallenge = SpansClientIntegrationsReview & {
  expiresAt: string;
  phrase: string;
  reviewId: string;
};

interface CanApplyReviewedIntegrationInput {
  busy: boolean;
  mode: IntegrationMode;
  needsReconciliation: boolean;
  phrase: string;
  review: SpansClientIntegrationsReview | null;
  statusConfirmed: boolean;
}

function canApplyReviewedIntegration(
  input: CanApplyReviewedIntegrationInput
): input is CanApplyReviewedIntegrationInput & {
  review: SpansClientIntegrationsReviewChallenge;
} {
  const { busy, mode, needsReconciliation, phrase, review, statusConfirmed } =
    input;
  if (!reviewHasChallenge(review)) {
    return false;
  }
  if (mode === 'remove-shared' && !review.phrase.startsWith('Remove')) {
    return false;
  }
  return (
    statusConfirmed &&
    !(busy || needsReconciliation) &&
    phrase === review.phrase &&
    Date.parse(review.expiresAt) > Date.now()
  );
}

function applyFeedback(
  result: SpansClientIntegrationsResult<SpansClientIntegrationsApplyResult>
) {
  if (hasUnknownSpansIntegrationApplyOutcome(result)) {
    return {
      actionMessage:
        'Apply outcome is unknown. Reconcile receipts before creating another review.',
      needsReconciliation: true,
      reviewError: null,
    };
  }
  if (result.ok) {
    return {
      actionMessage: result.idempotent
        ? 'No file change was needed. Create a fresh review before another apply.'
        : 'The reviewed change was applied. Create a fresh review before another apply.',
      needsReconciliation: false,
      reviewError: null,
    };
  }
  return {
    actionMessage: null,
    needsReconciliation: false,
    reviewError: fixedFailureMessage(result.code, 'apply'),
  };
}

function reviewButtonLabel(
  mode: IntegrationMode,
  busyAction: BusyAction | null
) {
  if (busyAction === 'review') {
    return 'Reviewing current files…';
  }
  return mode === 'remove-shared'
    ? 'Review shared artifact removal'
    : 'Review install or update';
}

function beginSessionApply() {
  if (pendingIntegrationApply) {
    return null;
  }
  pendingIntegrationApply = new Promise((resolve) => {
    finishPendingIntegrationApply = resolve;
  });
  return () => {
    const finish = finishPendingIntegrationApply;
    pendingIntegrationApply = null;
    finishPendingIntegrationApply = null;
    finish?.();
  };
}

async function waitForSessionApply() {
  const pendingApply = pendingIntegrationApply;
  if (pendingApply) {
    await pendingApply;
  }
}

export function SpansClientIntegrations() {
  const [mode, setMode] = useState<IntegrationMode>('install-update');
  const [summary, setSummary] = useState<SpansClientIntegrationsSummary | null>(
    null
  );
  const [review, setReview] = useState<SpansClientIntegrationsReview | null>(
    null
  );
  const [phrase, setPhrase] = useState('');
  const [busyAction, setBusyAction] = useState<BusyAction | null>(null);
  const [statusLoading, setStatusLoading] = useState(true);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [reviewError, setReviewError] = useState<string | null>(null);
  const [actionMessage, setActionMessage] = useState<string | null>(null);
  const [needsReconciliation, setNeedsReconciliation] = useState(
    reconciliationRequiredInSession
  );
  const [statusConfirmed, setStatusConfirmed] = useState(false);
  const reviewRef = useRef<SpansClientIntegrationsReview | null>(null);
  const busyActionRef = useRef<BusyAction | null>(null);
  const mountedRef = useRef(false);
  const reconciliationRequiredRef = useRef(reconciliationRequiredInSession);
  const statusConfirmedRef = useRef(false);
  const selectionRevisionRef = useRef(0);
  const reviewRequestRef = useRef(0);
  const statusRequestRef = useRef(0);
  const statusMutationRef = useRef(0);

  function updateReview(nextReview: SpansClientIntegrationsReview | null) {
    reviewRef.current = nextReview;
    setReview(nextReview);
  }

  function beginAction(action: BusyAction) {
    if (busyActionRef.current !== null) {
      return false;
    }
    busyActionRef.current = action;
    setBusyAction(action);
    return true;
  }

  function endAction(action: BusyAction) {
    if (busyActionRef.current === action) {
      busyActionRef.current = null;
      if (mountedRef.current) {
        setBusyAction(null);
      }
    }
  }

  function beginReviewAction() {
    return (
      statusConfirmedRef.current &&
      !reconciliationRequiredRef.current &&
      beginAction('review')
    );
  }

  function setReconciliationRequired(required: boolean) {
    reconciliationRequiredInSession = required;
    reconciliationRequiredRef.current = required;
    if (mountedRef.current) {
      setNeedsReconciliation(required);
    }
  }

  function setStatusConfirmedValue(confirmed: boolean) {
    statusConfirmedRef.current = confirmed;
    if (mountedRef.current) {
      setStatusConfirmed(confirmed);
    }
  }

  async function refreshStatus() {
    statusRequestRef.current += 1;
    const requestId = statusRequestRef.current;
    const mutationId = statusMutationRef.current;
    setStatusLoading(true);
    setStatusConfirmedValue(false);
    await waitForSessionApply();
    const result = await integrations.getStatus();
    if (
      !mountedRef.current ||
      requestId !== statusRequestRef.current ||
      mutationId !== statusMutationRef.current
    ) {
      return;
    }
    setStatusLoading(false);
    if (result.ok) {
      setSummary(result.summary);
      setStatusError(null);
      if (needsSpansIntegrationReconciliation(result.summary)) {
        setReconciliationRequired(true);
      } else {
        setReconciliationRequired(reconciliationRequiredInSession);
      }
      setStatusConfirmedValue(true);
    } else {
      setStatusError(fixedFailureMessage(result.code, 'status'));
    }
  }

  useEffect(() => {
    mountedRef.current = true;
    reconciliationRequiredRef.current = reconciliationRequiredInSession;
    setNeedsReconciliation(reconciliationRequiredInSession);
    refreshStatus().catch(() => undefined);
    return () => {
      mountedRef.current = false;
    };
  }, []);

  function changeMode(nextMode: IntegrationMode) {
    if (
      nextMode === mode ||
      busyActionRef.current === 'apply' ||
      busyActionRef.current === 'reconcile' ||
      reconciliationRequiredRef.current
    ) {
      return;
    }
    selectionRevisionRef.current += 1;
    setMode(nextMode);
    updateReview(null);
    setPhrase('');
    setReviewError(null);
    setActionMessage(null);
  }

  async function createReview() {
    if (!beginReviewAction()) {
      return;
    }
    const revision = selectionRevisionRef.current;
    reviewRequestRef.current += 1;
    const requestId = reviewRequestRef.current;
    const selection: SpansClientIntegrationsReviewSelection =
      mode === 'remove-shared'
        ? {
            clients: ['codex', 'cursor'] as const,
            removeSharedArtifact: true as const,
          }
        : {};
    updateReview(null);
    setPhrase('');
    setReviewError(null);
    setActionMessage(null);
    const result = await integrations.review(selection);
    if (
      mountedRef.current &&
      requestId === reviewRequestRef.current &&
      isCurrentSpansIntegrationRevision(revision, selectionRevisionRef.current)
    ) {
      if (result.ok) {
        setSummary(result.summary);
        updateReview(result);
        if (needsSpansIntegrationReconciliation(result.summary)) {
          setReconciliationRequired(true);
        }
      } else {
        if (
          result.code === 'INTEGRATION_RECONCILIATION_REQUIRED' ||
          result.code === 'INTEGRATION_STATE_WRITE_UNKNOWN'
        ) {
          setReconciliationRequired(true);
        }
        setReviewError(fixedFailureMessage(result.code, 'review'));
      }
    }
    endAction('review');
  }

  async function submitReviewedChange(submittedReviewId: string) {
    const finishSessionApply = beginSessionApply();
    if (!finishSessionApply) {
      endAction('apply');
      return;
    }
    statusMutationRef.current += 1;
    setStatusConfirmedValue(false);
    setActionMessage(null);
    setReviewError(null);
    let result: SpansClientIntegrationsResult<SpansClientIntegrationsApplyResult>;
    try {
      result = await integrations.apply({
        response: phrase,
        reviewId: submittedReviewId,
      });
    } catch {
      result = {
        code: 'TRANSPORT_UNCERTAIN',
        kind: 'transport',
        ok: false,
        unknown: true,
      };
    }
    const feedback = applyFeedback(result);
    if (feedback.needsReconciliation) {
      reconciliationRequiredInSession = true;
    }
    finishSessionApply();
    if (mountedRef.current) {
      const currentReviewId = reviewRef.current?.reviewId ?? null;
      if (isCurrentSpansIntegrationReview(submittedReviewId, currentReviewId)) {
        updateReview(null);
        setPhrase('');
      }
      if (feedback.needsReconciliation) {
        setReconciliationRequired(true);
      }
      setActionMessage(feedback.actionMessage);
      setReviewError(feedback.reviewError);
      refreshStatus().catch(() => undefined);
    }
    endAction('apply');
  }

  async function applyReview() {
    if (
      reviewHasChallenge(review) &&
      Date.parse(review.expiresAt) <= Date.now()
    ) {
      setReviewError(
        'This review expired. Create a fresh review before applying.'
      );
      return;
    }
    const applyInput = {
      busy: busyActionRef.current !== null,
      mode,
      needsReconciliation: reconciliationRequiredRef.current,
      phrase,
      review,
      statusConfirmed: statusConfirmedRef.current,
    };
    if (!canApplyReviewedIntegration(applyInput)) {
      return;
    }
    const submittedReviewId = applyInput.review.reviewId;
    if (!beginAction('apply')) {
      return;
    }
    await submitReviewedChange(submittedReviewId);
  }

  async function reconcileReceipts() {
    if (!(reconciliationRequiredRef.current && beginAction('reconcile'))) {
      return;
    }
    statusMutationRef.current += 1;
    setStatusConfirmedValue(false);
    setStatusLoading(true);
    setActionMessage(null);
    setReviewError(null);
    const result = await integrations.reconcile();
    if (result.ok) {
      setReconciliationRequired(
        needsSpansIntegrationReconciliation(result.summary)
      );
    }
    if (mountedRef.current) {
      setStatusLoading(false);
      if (result.ok) {
        const stillNeedsReconciliation = needsSpansIntegrationReconciliation(
          result.summary
        );
        setSummary(result.summary);
        setStatusError(null);
        setStatusConfirmedValue(true);
        if (stillNeedsReconciliation) {
          setActionMessage(
            'Receipt reconciliation found an unresolved operation. Keep this flow blocked and reconcile again after inspecting the current status.'
          );
        } else {
          updateReview(null);
          setPhrase('');
          setActionMessage(
            'Receipt reconciliation completed. Create a new review before applying.'
          );
        }
      } else {
        setReconciliationRequired(true);
        setReviewError(fixedFailureMessage(result.code, 'reconcile'));
      }
    }
    endAction('reconcile');
  }

  const busy = busyAction !== null;
  return (
    <Section title="Agent Integrations">
      <div class="flex flex-col gap-4">
        <p class="max-w-3xl text-sm text-zinc-600 dark:text-zinc-300">
          Review Setu’s bundled client artifacts. Connection, fresh-session
          evidence, and skill activation are reported separately when the client
          has supplied validated observations.
        </p>
        <ClientStatusPanel
          disabled={busy}
          onRefresh={refreshStatus}
          statusError={statusError}
          statusLoading={statusLoading}
          summary={summary}
        />
        <ActionSelector
          disabled={
            busyAction === 'apply' ||
            busyAction === 'reconcile' ||
            needsReconciliation
          }
          mode={mode}
          onChange={changeMode}
        />
        {needsReconciliation && (
          <ReconciliationNotice
            busy={busy}
            busyAction={busyAction}
            onReconcile={reconcileReceipts}
          />
        )}
        <div class="flex flex-col items-start gap-2">
          <Button
            disabled={busy || needsReconciliation || !statusConfirmed}
            onClick={createReview}
          >
            {reviewButtonLabel(mode, busyAction)}
          </Button>
          <ActionFeedback
            actionMessage={actionMessage}
            reviewError={reviewError}
          />
        </div>
        <IntegrationReviewPanel
          busy={busy || !statusConfirmed}
          busyAction={busyAction}
          mode={mode}
          needsReconciliation={needsReconciliation}
          onApply={applyReview}
          onPhraseChange={setPhrase}
          phrase={phrase}
          review={review}
        />
      </div>
    </Section>
  );
}
