import type { ComponentChildren } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { post } from '../api';
import {
  applyDependencyFilesBody,
  changeDependencyFilePage,
  createDependencyActionGuard,
  DEPENDENCY_FILE_PAGE_SIZE,
  type DependencyFileOperation,
  type DependencyFileSnapshot,
  type DependencyFileTarget,
  type DependencyReleasePlan,
  dependencyFileNativeReason,
  dependencyFileOperationFrom,
  dependencyFilePage,
  dependencyFileRoutes,
  dependencyFileSnapshot,
  dependencyOperationPanelState,
  dependencyOutcomeUnknown,
  dependencyPlanConfirmation,
  dependencyPlanReviewKey,
  dependencyReleaseConfirmation,
  dependencyReleaseResumeReviewKey,
  dependencyReleaseReviewKey,
  dependencyResumeReviewKey,
  dependencyStatusAllowsNewPlan,
  type HoistedDependencyPlan,
  parseDependencyReleasePlan,
  parseHoistedDependencyPlan,
  prepareDependencyReleaseBody,
  recoverDependencyFilesBody,
  releaseDependencyFilesBody,
  resumeDependencyFilesBody,
  resumeDependencyReleaseBody,
} from '../dependency-file-state';
import { formatStorageBytes } from '../host-storage';
import { Badge, StatusDot, type Tone } from '../ui/badge';
import { Button } from '../ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../ui/dialog';

interface PagedListProps<T> {
  getKey: (item: T) => string;
  identity: string;
  items: T[];
  label: string;
  listClass: string;
  ordered?: boolean;
  renderItem: (item: T, index: number) => ComponentChildren;
}

function PagedList<T>({
  getKey,
  identity,
  items,
  label,
  listClass,
  ordered = false,
  renderItem,
}: PagedListProps<T>) {
  const [storedPage, setStoredPage] = useState({ identity: '', page: 0 });
  const page = dependencyFilePage(storedPage, identity, items.length);
  const pageItems = items.slice(page.start, page.end);
  const first = items.length === 0 ? 0 : page.start + 1;
  const pagination = (
    <nav
      aria-label={`${label} pages`}
      class="flex flex-wrap items-center justify-between gap-2 border-zinc-200/70 border-t py-2 text-xs text-zinc-600 dark:border-white/10 dark:text-zinc-300"
    >
      <span aria-live="polite">
        Showing {first}–{page.end} of {items.length.toLocaleString()}
      </span>
      <div class="flex items-center gap-2">
        <Button
          compact
          disabled={page.page === 0}
          onClick={() =>
            setStoredPage(
              changeDependencyFilePage(
                storedPage,
                identity,
                items.length,
                DEPENDENCY_FILE_PAGE_SIZE,
                page.page - 1
              )
            )
          }
          variant="secondary"
        >
          Previous
        </Button>
        <span>
          Page {page.page + 1} of {Math.max(1, page.pageCount)}
        </span>
        <Button
          compact
          disabled={page.page >= page.pageCount - 1}
          onClick={() =>
            setStoredPage(
              changeDependencyFilePage(
                storedPage,
                identity,
                items.length,
                DEPENDENCY_FILE_PAGE_SIZE,
                page.page + 1
              )
            )
          }
          variant="secondary"
        >
          Next
        </Button>
      </div>
    </nav>
  );
  const listItems = pageItems.map((item, index) => (
    <li key={getKey(item)}>{renderItem(item, page.start + index)}</li>
  ));

  return (
    <div>
      {pagination}
      {ordered ? (
        <ol class={listClass}>{listItems}</ol>
      ) : (
        <ul class={listClass}>{listItems}</ul>
      )}
    </div>
  );
}

type Action =
  | 'apply'
  | 'prepare'
  | 'prepare-release'
  | 'reconcile'
  | 'release'
  | 'resume'
  | 'resume-release';

interface LocalValue<T> {
  targetKey: string;
  value: T;
}

interface DependencyFileControlsProps extends DependencyFileTarget {
  data: unknown;
  failed: boolean;
  onActionPending: (pending: boolean) => void;
  onRefresh: () => void;
  toast: (message: string, tone?: Tone) => void;
}

const record = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

function operationTone(state: string | null): Tone {
  if (state === 'completed' || state === 'released') {
    return 'emerald';
  }
  if (state === 'unknown' || state === 'conflict' || state === 'partial') {
    return 'amber';
  }
  if (state === 'running') {
    return 'emerald';
  }
  return 'zinc';
}

function actionError(value: unknown, fallback: string) {
  const result = record(value);
  return typeof result?.error === 'string' && result.error.trim()
    ? result.error
    : fallback;
}

function operationIdFromResponse(response: unknown, fallback: string | null) {
  const operation = dependencyFileOperationFrom(response);
  if (operation) {
    return operation.id;
  }
  const result = record(response);
  return typeof result?.operationId === 'string'
    ? result.operationId
    : fallback;
}

function operationAttention(state: string) {
  if (state === 'conflict') {
    return 'A file changed during the operation. Both entries are retained; reconcile before taking another action.';
  }
  if (state === 'partial') {
    return 'The operation is partial. Reconcile its recorded files before preparing another action.';
  }
  if (state === 'running') {
    return 'The operation is still running. Reconcile its recorded progress before preparing another action.';
  }
  return 'The operation outcome is unknown. Reconcile this operation before trying anything else.';
}

function operationStateOrUnknown(operation: DependencyFileOperation | null) {
  return operation ? operation.state : 'unknown';
}

function hasProgress(operation: DependencyFileOperation | null) {
  return (
    !!operation &&
    typeof operation.completedFiles === 'number' &&
    typeof operation.totalFiles === 'number' &&
    operation.totalFiles > 0
  );
}

function newestOperation(
  local: DependencyFileOperation | null,
  observed: DependencyFileOperation | null
) {
  if (!local) {
    return observed;
  }
  if (!observed) {
    return local;
  }
  if (local.id === observed.id) {
    return {
      ...local,
      ...observed,
      files: observed.files ?? local.files,
      planId: observed.planId ?? local.planId,
      releaseId: observed.releaseId ?? local.releaseId,
      resumable: observed.resumable ?? local.resumable,
    };
  }
  const localAt = local.updatedAt ?? 0;
  const observedAt = observed.updatedAt ?? 0;
  return observedAt >= localAt ? observed : local;
}

function fingerprintLabel(label: string) {
  return (
    label
      .split('.')
      .at(-1)
      ?.replace(/([a-z])([A-Z])/g, '$1 $2') ?? label
  );
}

interface PrepareActionContext {
  busy: Action | null;
  name: string;
  repo: string;
  runAction: (
    action: Action,
    path: string,
    body: unknown
  ) => Promise<unknown | null>;
  setError: (value: string | null) => void;
  setOperationState: (
    value: LocalValue<DependencyFileOperation> | null
  ) => void;
  setPlanDialogOpen: (value: boolean) => void;
  setPlanReview: (value: LocalValue<string> | null) => void;
  setPlanState: (value: LocalValue<HoistedDependencyPlan> | null) => void;
  setReleaseDialogOpen: (value: boolean) => void;
  setReleasePlanState: (
    value: LocalValue<DependencyReleasePlan> | null
  ) => void;
  setReleaseReview: (value: LocalValue<string> | null) => void;
  setResumeReleaseReview: (value: LocalValue<string> | null) => void;
  setResumeReview: (value: LocalValue<string> | null) => void;
  target: DependencyFileTarget;
  targetKey: string;
  toast: (message: string, tone?: Tone) => void;
}

async function prepareDependencyPlan(context: PrepareActionContext) {
  const {
    busy,
    name,
    repo,
    runAction,
    setError,
    setOperationState,
    setPlanDialogOpen,
    setPlanReview,
    setPlanState,
    setReleaseDialogOpen,
    setReleasePlanState,
    setReleaseReview,
    setResumeReleaseReview,
    setResumeReview,
    target,
    targetKey,
    toast,
  } = context;
  if (busy || !repo || !name) {
    return;
  }
  setPlanState(null);
  setReleasePlanState(null);
  setPlanReview(null);
  setReleaseReview(null);
  setResumeReview(null);
  setResumeReleaseReview(null);
  setPlanDialogOpen(false);
  setReleaseDialogOpen(false);
  setError(null);
  const response = await runAction('prepare', dependencyFileRoutes.prepare, {
    name,
    repo,
  });
  if (!response) {
    return;
  }
  const result = record(response);
  const nextPlan =
    result?.ok === true ? parseHoistedDependencyPlan(response, target) : null;
  if (nextPlan) {
    setPlanState({ targetKey, value: nextPlan });
    toast('Hoisted file plan is ready for review.', 'emerald');
    return;
  }
  const unreviewablePlan = record(result?.plan);
  if (
    Array.isArray(unreviewablePlan?.files) &&
    unreviewablePlan.files.length === 0
  ) {
    setError(
      'No eligible dependency files were found. Nothing was prepared or applied.'
    );
    toast('No eligible dependency files were found.', 'amber');
    return;
  }
  if (dependencyOutcomeUnknown(response)) {
    const pendingId = operationIdFromResponse(response, null);
    setOperationState(
      pendingId
        ? {
            targetKey,
            value: {
              id: pendingId,
              physicalSavingsBytes: null,
              state: 'unknown',
              updatedAt: Date.now(),
            },
          }
        : null
    );
    setError(
      'Plan preparation did not return a confirmed review. Refresh the worktree status before preparing again.'
    );
    toast('✗ Plan preparation outcome could not be confirmed.', 'red');
    return;
  }
  setError(actionError(response, 'The file plan could not be prepared.'));
  toast('✗ The file plan could not be prepared.', 'red');
}

interface ApplyOutcomeContext {
  onActionPending: (pending: boolean) => void;
  setError: (value: string | null) => void;
  setOperationState: (
    value: LocalValue<DependencyFileOperation> | null
  ) => void;
  setPlanState: (value: LocalValue<HoistedDependencyPlan> | null) => void;
  targetKey: string;
  toast: (message: string, tone?: Tone) => void;
}

function applyOutcome(
  context: ApplyOutcomeContext,
  response: unknown,
  expectedOperationId: string
) {
  const {
    onActionPending,
    setError,
    setOperationState,
    setPlanState,
    targetKey,
    toast,
  } = context;
  const result = record(response);
  const serverOperation = dependencyFileOperationFrom(response);
  const returnedId =
    operationIdFromResponse(response, expectedOperationId) ??
    expectedOperationId;

  if (dependencyOutcomeUnknown(response)) {
    setOperationState({
      targetKey,
      value: {
        id: returnedId,
        mode: 'hoisted-cow',
        physicalSavingsBytes: null,
        state: 'unknown',
        updatedAt: serverOperation?.updatedAt ?? Date.now(),
      },
    });
    setError(
      `The apply result is uncertain. Reconcile operation ${returnedId} before continuing.`
    );
    toast('✗ Apply outcome is unknown. Reconcile before continuing.', 'red');
    return;
  }

  if (result?.ok === true && serverOperation) {
    setOperationState({ targetKey, value: serverOperation });
    onActionPending(serverOperation.state === 'running');
    setPlanState(null);
    setError(null);
    toast(
      serverOperation.state === 'completed'
        ? 'Hoisted file sharing is complete. Original files are retained for separate review.'
        : 'Hoisted file operation progress was recorded.',
      serverOperation.state === 'conflict' ? 'amber' : 'emerald'
    );
    return;
  }

  if (result?.ok === true) {
    setOperationState({
      targetKey,
      value: {
        id: returnedId,
        mode: 'hoisted-cow',
        physicalSavingsBytes: null,
        state: 'unknown',
        updatedAt: Date.now(),
      },
    });
    setError(
      `The server accepted the request but did not return progress. Reconcile operation ${returnedId}.`
    );
    toast('Apply progress needs reconciliation.', 'amber');
    return;
  }

  if (serverOperation) {
    setOperationState({
      targetKey,
      value: {
        ...serverOperation,
        releaseId:
          serverOperation.releaseId ??
          (typeof result?.releaseId === 'string'
            ? result.releaseId
            : expectedOperationId),
      },
    });
    onActionPending(serverOperation.state === 'running');
  } else {
    setOperationState(null);
  }
  setPlanState(null);
  setError(actionError(response, 'The reviewed plan was not applied.'));
  toast('✗ The reviewed plan was not applied.', 'red');
}

interface ReconcileOutcomeContext {
  onActionPending: (pending: boolean) => void;
  operation: DependencyFileOperation | null;
  operationId: string | null;
  setError: (value: string | null) => void;
  setOperationState: (
    value: LocalValue<DependencyFileOperation> | null
  ) => void;
  targetKey: string;
  toast: (message: string, tone?: Tone) => void;
}

function reconcileOutcome(context: ReconcileOutcomeContext, response: unknown) {
  const {
    onActionPending,
    operation,
    operationId,
    setError,
    setOperationState,
    targetKey,
    toast,
  } = context;
  const result = record(response);
  const serverOperation = dependencyFileOperationFrom(response);
  if (serverOperation) {
    setOperationState({
      targetKey,
      value: {
        ...serverOperation,
        releaseId:
          serverOperation.releaseId ??
          (typeof result?.releaseId === 'string'
            ? result.releaseId
            : operation?.releaseId),
      },
    });
    onActionPending(serverOperation.state === 'running');
    const needsAttention =
      serverOperation.state === 'unknown' ||
      serverOperation.state === 'conflict';
    setError(
      needsAttention
        ? 'The recorded operation still needs attention. Its files were left in place for review.'
        : null
    );
    toast(
      needsAttention
        ? `Operation ${serverOperation.state}. Review the recorded state before continuing.`
        : `Operation status reconciled: ${serverOperation.state}.`,
      operationTone(serverOperation.state)
    );
    return;
  }
  if (dependencyOutcomeUnknown(response) || result?.ok !== true) {
    setOperationState({
      targetKey,
      value: {
        ...(operation ?? {}),
        id: operationId ?? '',
        physicalSavingsBytes: null,
        state: dependencyOutcomeUnknown(response)
          ? 'unknown'
          : operationStateOrUnknown(operation),
        updatedAt: Date.now(),
      },
    });
    setError(
      actionError(
        response,
        'Reconciliation did not return a current operation state.'
      )
    );
    toast('✗ Reconciliation needs another review.', 'red');
    return;
  }
  setError(
    'Reconciliation returned no operation summary. Refresh status before continuing.'
  );
  toast('Reconciliation returned no progress summary.', 'amber');
}

interface DependencyOperationPanelProps {
  busy: Action | null;
  needsReconciliation: boolean;
  onReconcile: () => void;
  operation: DependencyFileOperation | null;
  progressAvailable: boolean;
  progressCompleted: number;
  progressPercent: number;
  progressTotal: number;
  resumeKey: string | null;
  resumeReleaseKey: string | null;
  setResumeDialogOpen: (value: boolean) => void;
  setResumeReleaseDialogOpen: (value: boolean) => void;
  setResumeReleaseReview: (value: LocalValue<string> | null) => void;
  setResumeReview: (value: LocalValue<string> | null) => void;
  targetKey: string;
}

function DependencyOperationPanel({
  busy,
  needsReconciliation,
  onReconcile,
  operation,
  progressAvailable,
  progressCompleted,
  progressPercent,
  progressTotal,
  resumeKey,
  resumeReleaseKey,
  setResumeDialogOpen,
  setResumeReleaseDialogOpen,
  setResumeReleaseReview,
  setResumeReview,
  targetKey,
}: DependencyOperationPanelProps) {
  if (!operation) {
    return null;
  }
  const panelState = dependencyOperationPanelState(operation, busy);
  return (
    <section
      aria-busy={panelState.ariaBusy}
      aria-label="Hoisted dependency operation"
      class="mt-3 space-y-2"
    >
      <div
        aria-live="polite"
        class="flex flex-wrap items-center gap-2 text-xs"
        role="status"
      >
        <StatusDot
          pulse={operation.state === 'running'}
          tone={operationTone(operation.state)}
        />
        <span>Operation state</span>
        <Badge tone={operationTone(operation.state)}>{operation.state}</Badge>
      </div>
      {operation.mode && (
        <p class="text-xs text-zinc-600 dark:text-zinc-400">
          Mode: {operation.mode}
        </p>
      )}
      {progressAvailable && (
        <div class="space-y-1">
          <p class="text-xs text-zinc-600 dark:text-zinc-400">
            {progressCompleted} of {progressTotal} files verified
          </p>
          <progress
            aria-label="Hoisted dependency files verified"
            class="h-2 w-full accent-accent"
            max={progressTotal}
            value={progressCompleted}
          />
          <p class="text-[11px] text-zinc-500 dark:text-zinc-400">
            {progressPercent}% complete
          </p>
        </div>
      )}
      <dl class="grid min-w-0 grid-cols-[minmax(7rem,auto)_minmax(0,1fr)] gap-x-3 gap-y-1 text-xs">
        {typeof operation.logicalCloneBytes === 'number' && (
          <>
            <dt class="text-zinc-500 dark:text-zinc-400">Logical clone size</dt>
            <dd class="break-words">
              {formatStorageBytes(operation.logicalCloneBytes)}
            </dd>
          </>
        )}
        {typeof operation.retainedOriginalFiles === 'number' && (
          <>
            <dt class="text-zinc-500 dark:text-zinc-400">Retained originals</dt>
            <dd class="break-words">
              {operation.retainedOriginalFiles} files · physical savings unknown
            </dd>
          </>
        )}
        <dt class="text-zinc-500 dark:text-zinc-400">Disk savings</dt>
        <dd>Unknown</dd>
        <dt class="text-zinc-500 dark:text-zinc-400">Operation ID</dt>
        <dd class="break-all font-mono text-[11px]">{operation.id}</dd>
      </dl>
      {needsReconciliation && (
        <p
          class="max-w-prose text-amber-800 text-xs dark:text-amber-200"
          role="alert"
        >
          {operationAttention(operation.state)}
        </p>
      )}
      {panelState.canResumeApply && resumeKey && (
        <Button
          compact
          disabled={busy !== null}
          onClick={() => {
            setResumeReview({ targetKey, value: resumeKey });
            setResumeDialogOpen(true);
          }}
          variant="secondary"
        >
          Review resume of same plan
        </Button>
      )}
      {resumeReleaseKey && !needsReconciliation && (
        <Button
          compact
          disabled={busy !== null}
          onClick={() => {
            setResumeReleaseReview({ targetKey, value: resumeReleaseKey });
            setResumeReleaseDialogOpen(true);
          }}
          variant="secondary"
        >
          Review resume of release {operation.releaseId?.slice(0, 12)}…
        </Button>
      )}
      {panelState.canReconcile && (
        <Button
          compact
          disabled={busy !== null}
          onClick={onReconcile}
          variant="secondary"
        >
          {busy === 'reconcile' ? 'Reconciling…' : 'Reconcile operation'}
        </Button>
      )}
      {operation.state === 'conflict' && operation.files?.length ? (
        <fieldset class="space-y-2">
          <legend class="font-medium text-amber-900 text-xs dark:text-amber-100">
            Conflicting entries retained for diagnosis
          </legend>
          <PagedList
            getKey={(file) => `${file.relativePath}:${file.phase}`}
            identity={`${targetKey}\0conflict\0${operation.id}`}
            items={operation.files}
            label="Conflicting dependency files"
            listClass="max-h-64 space-y-3 overflow-auto border-zinc-200/70 border-t pt-3 text-xs dark:border-white/10"
            ordered
            renderItem={(file) => (
              <div class="min-w-0 space-y-1 border-zinc-200/60 border-b pb-3 dark:border-white/10">
                <p class="break-all">
                  Observed file: <code>{file.relativePath}</code>
                </p>
                <p class="break-all">
                  Retained entry:{' '}
                  <code>
                    {file.temporaryRelativePath ?? 'path not returned'}
                  </code>
                </p>
                <p class="break-all">
                  Observed target identity:{' '}
                  <code>
                    {file.targetFingerprint?.identityHash ?? 'not returned'}
                  </code>
                </p>
                <p class="break-all">
                  Observed retained identity:{' '}
                  <code>
                    {file.retainedFingerprint?.identityHash ?? 'not returned'}
                  </code>
                </p>
                {file.targetFingerprint?.contentHash && (
                  <p class="break-all">
                    Target content digest:{' '}
                    <code>{file.targetFingerprint.contentHash}</code>
                  </p>
                )}
                {file.targetFingerprint?.metadataHash && (
                  <p class="break-all">
                    Target metadata digest:{' '}
                    <code>{file.targetFingerprint.metadataHash}</code>
                  </p>
                )}
                {file.retainedFingerprint?.contentHash && (
                  <p class="break-all">
                    Retained content digest:{' '}
                    <code>{file.retainedFingerprint.contentHash}</code>
                  </p>
                )}
                {file.retainedFingerprint?.metadataHash && (
                  <p class="break-all">
                    Retained metadata digest:{' '}
                    <code>{file.retainedFingerprint.metadataHash}</code>
                  </p>
                )}
              </div>
            )}
          />
          <p class="text-xs text-zinc-600 dark:text-zinc-400">
            Reconcile only refreshes these observations. It does not resolve the
            conflict or remove either entry.
          </p>
        </fieldset>
      ) : null}
    </section>
  );
}

function DependencySkippedFiles({
  files,
  identity,
}: {
  files: DependencyFileSnapshot['skipped'];
  identity: string;
}) {
  if (files.length === 0) {
    return null;
  }
  return (
    <details class="mt-3 border-zinc-200/70 border-t pt-2 text-xs dark:border-white/10">
      <summary class="cursor-pointer font-medium text-zinc-700 focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent dark:text-zinc-200">
        Skipped files ({files.length})
      </summary>
      <PagedList
        getKey={(file) => `${file.relativePath}:${file.reason}`}
        identity={identity}
        items={files}
        label="Skipped files"
        listClass="mt-2 max-h-48 space-y-2 overflow-auto"
        renderItem={(file) => (
          <div class="min-w-0 border-zinc-200/60 border-b pb-2 dark:border-white/10">
            <code class="block break-all text-zinc-800 dark:text-zinc-200">
              {file.relativePath}
            </code>
            <span class="mt-1 block break-words text-zinc-500 dark:text-zinc-400">
              {file.reason}
            </span>
          </div>
        )}
      />
    </details>
  );
}

interface DependencyActionButtonsProps {
  busy: Action | null;
  canPrepareRelease: boolean;
  displayedPlanKey: string | null;
  needsReconciliation: boolean;
  onPrepare: () => void;
  onPrepareRelease: () => void;
  plan: HoistedDependencyPlan | null;
  setPlanDialogOpen: (value: boolean) => void;
  setPlanReview: (value: LocalValue<string> | null) => void;
  statusAllowsNewPlan: boolean;
  targetKey: string;
}

function DependencyActionButtons(props: DependencyActionButtonsProps) {
  const {
    busy,
    canPrepareRelease,
    displayedPlanKey,
    needsReconciliation,
    statusAllowsNewPlan,
    onPrepare,
    onPrepareRelease,
    plan,
    setPlanDialogOpen,
    setPlanReview,
    targetKey,
  } = props;
  return (
    <div class="mt-3 flex flex-wrap gap-2">
      <Button
        compact
        disabled={busy !== null || needsReconciliation || !statusAllowsNewPlan}
        onClick={onPrepare}
        variant="secondary"
      >
        {busy === 'prepare' ? 'Preparing…' : 'Prepare hoisted file plan'}
      </Button>
      {plan && (
        <Button
          compact
          disabled={busy !== null || needsReconciliation}
          onClick={() => {
            if (!displayedPlanKey) {
              return;
            }
            setPlanReview({ targetKey, value: displayedPlanKey });
            setPlanDialogOpen(true);
          }}
          variant="primary"
        >
          Review apply plan
        </Button>
      )}
      {canPrepareRelease && !needsReconciliation && statusAllowsNewPlan && (
        <Button
          compact
          disabled={busy !== null}
          onClick={onPrepareRelease}
          variant="secondary"
        >
          {busy === 'prepare-release'
            ? 'Preparing review…'
            : 'Review retained originals'}
        </Button>
      )}
    </div>
  );
}

function DependencyPlanStatus({
  plan,
  planDialogOpen,
  releasePlan,
  releaseDialogOpen,
  displayedPlanKey,
  displayedReleaseKey,
  needsReconciliation,
  busy,
  setReleaseDialogOpen,
  setReleaseReview,
  targetKey,
}: {
  displayedPlanKey: string | null;
  displayedReleaseKey: string | null;
  needsReconciliation: boolean;
  plan: HoistedDependencyPlan | null;
  planDialogOpen: boolean;
  releaseDialogOpen: boolean;
  releasePlan: DependencyReleasePlan | null;
  busy: Action | null;
  setReleaseDialogOpen: (value: boolean) => void;
  setReleaseReview: (value: LocalValue<string> | null) => void;
  targetKey: string;
}) {
  return (
    <>
      {plan && !planDialogOpen && displayedPlanKey && (
        <p class="mt-2 text-xs text-zinc-500 dark:text-zinc-400" role="status">
          Plan {plan.id.slice(0, 12)}… is ready. Open its review before applying
          it.
        </p>
      )}
      {releasePlan &&
        !releaseDialogOpen &&
        displayedReleaseKey &&
        !needsReconciliation && (
          <div
            class="mt-2 flex flex-wrap items-center gap-2 text-xs"
            role="status"
          >
            <span>Release review {releasePlan.id.slice(0, 12)}… is ready.</span>
            <Button
              compact
              disabled={busy !== null}
              onClick={() => {
                if (!displayedReleaseKey) {
                  return;
                }
                setReleaseReview({ targetKey, value: displayedReleaseKey });
                setReleaseDialogOpen(true);
              }}
              variant="secondary"
            >
              Open release review
            </Button>
          </div>
        )}
    </>
  );
}

function DependencyFileHeader({
  failed,
  nativeReason,
  onRefresh,
  snapshot,
  statusReadOk,
}: {
  failed: boolean;
  nativeReason: string | null;
  onRefresh: () => void;
  snapshot: DependencyFileSnapshot;
  statusReadOk: boolean;
}) {
  const { statusFailure } = snapshot;
  return (
    <>
      <div class="flex flex-wrap items-center gap-2">
        <h3 class="board-mono font-bold text-[11px] text-zinc-700 dark:text-zinc-200">
          Hoisted dependency files
        </h3>
        {snapshot.mode && <Badge tone="zinc">{snapshot.mode}</Badge>}
        {snapshot.enrollmentState && (
          <Badge tone={operationTone(snapshot.enrollmentState)}>
            {snapshot.enrollmentState}
          </Badge>
        )}
      </div>
      <p class="mt-2 max-w-prose text-xs text-zinc-600 dark:text-zinc-400">
        Review a file plan before applying it. Original files stay retained
        until a separate release review. Logical clone size and retained file
        size do not measure disk savings.
      </p>
      {(failed || snapshot.statusFailure) && (
        <p class="mt-2 text-red-700 text-xs dark:text-red-300" role="status">
          Hoisted dependency status is unknown
          {statusFailure?.code ? ` (${statusFailure.code})` : ''}:{' '}
          {statusFailure
            ? statusFailure.error
            : 'The worktree resource read failed.'}
          <Button class="ml-2" compact onClick={onRefresh} variant="secondary">
            Refresh status
          </Button>
        </p>
      )}
      {!(snapshot.mode || failed || snapshot.statusFailure) && statusReadOk && (
        <p class="mt-2 text-xs text-zinc-500 dark:text-zinc-400">
          No hoisted enrollment status is recorded for this worktree.
        </p>
      )}
      {nativeReason && (
        <p
          class="mt-2 rounded-none bg-signal-amber/10 p-2 text-signal-amber text-xs"
          role="status"
        >
          Native file exchange is unavailable: {nativeReason} No file changes
          can be applied while it is unavailable.
        </p>
      )}
      {snapshot.reason && !snapshot.statusFailure && (
        <p class="mt-2 max-w-prose break-words text-xs text-zinc-500 dark:text-zinc-400">
          {snapshot.reason}
        </p>
      )}
    </>
  );
}

interface DependencyResumeDialogsProps {
  busy: Action | null;
  name: string;
  onResume: () => void;
  onResumeRelease: () => void;
  operation: DependencyFileOperation | null;
  progressAvailable: boolean;
  progressCompleted: number;
  progressTotal: number;
  releaseConfirmation: unknown;
  releaseOpen: boolean;
  releaseReviewKey: string | null;
  repo: string;
  resumeConfirmation: ReturnType<typeof resumeDependencyFilesBody>;
  resumeKey: string | null;
  resumeOpen: boolean;
  setReleaseOpen: (value: boolean) => void;
  setReleaseReviewKey: (value: LocalValue<string> | null) => void;
  setResumeOpen: (value: boolean) => void;
  setResumeReviewKey: (value: LocalValue<string> | null) => void;
}

function DependencyResumeDialogs(props: DependencyResumeDialogsProps) {
  const {
    busy,
    name,
    onResume,
    onResumeRelease,
    operation,
    progressAvailable,
    progressCompleted,
    progressTotal,
    releaseConfirmation,
    releaseOpen,
    releaseReviewKey,
    resumeConfirmation,
    resumeKey,
    resumeOpen,
    repo,
    setReleaseOpen,
    setReleaseReviewKey,
    setResumeOpen,
    setResumeReviewKey,
  } = props;
  return (
    <>
      <Dialog
        onOpenChange={(open) => {
          setResumeOpen(open);
          if (!open) {
            setResumeReviewKey(null);
          }
        }}
        open={resumeOpen && !!operation && !!resumeKey}
      >
        {operation && resumeKey && (
          <DialogContent class="sm:max-w-2xl">
            <DialogHeader>
              <DialogTitle>Review resume of the same hoisted plan</DialogTitle>
              <DialogDescription>
                Resume uses the saved plan and operation identities and
                continues only files the server can reconcile.
              </DialogDescription>
            </DialogHeader>
            <dl class="grid min-w-0 grid-cols-[minmax(7rem,auto)_minmax(0,1fr)] gap-x-3 gap-y-2 text-xs">
              <dt class="text-zinc-500 dark:text-zinc-400">Worktree</dt>
              <dd class="break-all">
                {repo}/{name}
              </dd>
              <dt class="text-zinc-500 dark:text-zinc-400">Operation ID</dt>
              <dd class="break-all font-mono text-[11px]">{operation.id}</dd>
              <dt class="text-zinc-500 dark:text-zinc-400">Plan ID</dt>
              <dd class="break-all font-mono text-[11px]">
                {operation.planId ?? operation.id}
              </dd>
              <dt class="text-zinc-500 dark:text-zinc-400">Recorded state</dt>
              <dd>{operation.state}</dd>
              {progressAvailable && (
                <>
                  <dt class="text-zinc-500 dark:text-zinc-400">
                    Files verified
                  </dt>
                  <dd>
                    {progressCompleted} of {progressTotal}
                  </dd>
                </>
              )}
            </dl>
            {operation.files && operation.files.length > 0 && (
              <PagedList
                getKey={(file) => `${file.relativePath}:${file.phase}`}
                identity={`${repo}\0${name}\0operation\0${operation.id}`}
                items={operation.files}
                label="Operation files"
                listClass="max-h-48 space-y-1 overflow-auto border-zinc-200/70 border-t pt-2 text-xs dark:border-white/10"
                ordered
                renderItem={(file) => (
                  <span class="min-w-0 break-all">
                    <code>{file.relativePath}</code> · {file.phase}
                  </span>
                )}
              />
            )}
            <p class="text-amber-800 text-xs dark:text-amber-200" role="status">
              Confirmation is bound to this operation ID and worktree. Physical
              savings remain unknown.
            </p>
            <DialogFooter>
              <Button
                compact
                disabled={busy !== null}
                onClick={() => setResumeOpen(false)}
                variant="secondary"
              >
                Cancel
              </Button>
              <Button
                compact
                disabled={busy !== null || !resumeConfirmation}
                onClick={onResume}
                variant="primary"
              >
                {busy === 'resume'
                  ? 'Resuming same plan…'
                  : 'Resume this same plan'}
              </Button>
            </DialogFooter>
          </DialogContent>
        )}
      </Dialog>

      <Dialog
        onOpenChange={(open) => {
          setReleaseOpen(open);
          if (!open) {
            setReleaseReviewKey(null);
          }
        }}
        open={releaseOpen && !!operation && !!releaseReviewKey}
      >
        {operation && releaseReviewKey && (
          <DialogContent class="sm:max-w-2xl">
            <DialogHeader>
              <DialogTitle>
                Review resume of retained-original release
              </DialogTitle>
              <DialogDescription>
                Continue the exact prior release review. Its ID remains separate
                from the owning apply operation.
              </DialogDescription>
            </DialogHeader>
            <dl class="grid min-w-0 grid-cols-[minmax(7rem,auto)_minmax(0,1fr)] gap-x-3 gap-y-2 text-xs">
              <dt class="text-zinc-500 dark:text-zinc-400">Worktree</dt>
              <dd class="break-all">
                {repo}/{name}
              </dd>
              <dt class="text-zinc-500 dark:text-zinc-400">Operation ID</dt>
              <dd class="break-all font-mono text-[11px]">{operation.id}</dd>
              <dt class="text-zinc-500 dark:text-zinc-400">
                Release review ID
              </dt>
              <dd class="break-all font-mono text-[11px]">
                {operation.releaseId}
              </dd>
              <dt class="text-zinc-500 dark:text-zinc-400">
                Retained originals remaining
              </dt>
              <dd>{operation.retainedOriginalFiles ?? 'unknown'}</dd>
            </dl>
            <p class="text-amber-800 text-xs dark:text-amber-200" role="alert">
              This continues the exact prior release review. Removed originals
              cannot be restored by this action.
            </p>
            <DialogFooter>
              <Button
                compact
                disabled={busy !== null}
                onClick={() => setReleaseOpen(false)}
                variant="secondary"
              >
                Keep remaining originals
              </Button>
              <Button
                compact
                disabled={busy !== null || !releaseConfirmation}
                onClick={onResumeRelease}
                variant="primary"
              >
                {busy === 'resume-release'
                  ? 'Resuming reviewed release…'
                  : 'Resume this reviewed release'}
              </Button>
            </DialogFooter>
          </DialogContent>
        )}
      </Dialog>
    </>
  );
}

interface DependencyPlanDialogsProps {
  apply: () => void;
  busy: Action | null;
  name: string;
  onApplyOpenChange: (open: boolean) => void;
  onRelease: () => void;
  onReleaseOpenChange: (open: boolean) => void;
  plan: HoistedDependencyPlan | null;
  planConfirmation: string | null;
  planOpen: boolean;
  releaseConfirmation: string | null;
  releaseOpen: boolean;
  releasePlan: DependencyReleasePlan | null;
  repo: string;
}

function DependencyPlanDialogs(props: DependencyPlanDialogsProps) {
  const {
    apply,
    busy,
    name,
    onApplyOpenChange,
    onRelease,
    onReleaseOpenChange,
    plan,
    planConfirmation,
    planOpen,
    releaseConfirmation,
    releaseOpen,
    releasePlan,
    repo,
  } = props;
  return (
    <>
      <Dialog onOpenChange={onApplyOpenChange} open={planOpen && !!plan}>
        {plan && (
          <DialogContent class="sm:max-w-2xl">
            <DialogHeader>
              <DialogTitle>Review hoisted file plan</DialogTitle>
              <DialogDescription>
                Applying exchanges each reviewed file atomically and retains the
                displaced original for a separate release review.
              </DialogDescription>
            </DialogHeader>
            <dl class="grid min-w-0 grid-cols-[minmax(7rem,auto)_minmax(0,1fr)] gap-x-3 gap-y-2 text-xs">
              <dt class="text-zinc-500 dark:text-zinc-400">Worktree</dt>
              <dd class="break-all">
                {repo}/{name}
              </dd>
              <dt class="text-zinc-500 dark:text-zinc-400">Mode</dt>
              <dd>Hoisted file sharing · strict copy-on-write clones</dd>
              <dt class="text-zinc-500 dark:text-zinc-400">Plan ID</dt>
              <dd class="break-all font-mono text-[11px]">{plan.id}</dd>
              <dt class="text-zinc-500 dark:text-zinc-400">
                Files to exchange
              </dt>
              <dd>{plan.files.length}</dd>
              <dt class="text-zinc-500 dark:text-zinc-400">Files skipped</dt>
              <dd>{plan.skipped.length}</dd>
              <dt class="text-zinc-500 dark:text-zinc-400">
                Logical clone size
              </dt>
              <dd>{formatStorageBytes(plan.logicalCloneBytes)}</dd>
              <dt class="text-zinc-500 dark:text-zinc-400">Physical savings</dt>
              <dd>Unknown</dd>
              <dt class="text-zinc-500 dark:text-zinc-400">Input digest</dt>
              <dd class="break-all font-mono text-[11px]">
                {plan.inputDigest}
              </dd>
            </dl>
            <details
              class="border-zinc-200/70 border-t pt-2 text-xs dark:border-white/10"
              open
            >
              <summary class="cursor-pointer font-medium text-zinc-700 focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent dark:text-zinc-200">
                Files to exchange ({plan.files.length})
              </summary>
              <PagedList
                getKey={(file) => `${file.index}:${file.relativePath}`}
                identity={`${repo}\0${name}\0plan\0${plan.id}`}
                items={plan.files}
                label="Files to exchange"
                listClass="mt-2 max-h-48 space-y-1 overflow-auto font-mono text-[11px]"
                ordered
                renderItem={(file) => (
                  <span class="break-all">
                    {file.index + 1}. {file.relativePath} ·{' '}
                    {formatStorageBytes(file.fingerprint.size)}
                  </span>
                )}
              />
            </details>
            <details
              class="border-zinc-200/70 border-t pt-2 text-xs dark:border-white/10"
              open
            >
              <summary class="cursor-pointer font-medium text-zinc-700 focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent dark:text-zinc-200">
                Skipped files and reasons ({plan.skipped.length})
              </summary>
              {plan.skipped.length > 0 ? (
                <PagedList
                  getKey={(file) => `${file.relativePath}:${file.reason}`}
                  identity={`${repo}\0${name}\0plan-skipped\0${plan.id}`}
                  items={plan.skipped}
                  label="Skipped files and reasons"
                  listClass="mt-2 max-h-40 space-y-2 overflow-auto"
                  renderItem={(file) => (
                    <div class="min-w-0 border-zinc-200/60 border-b pb-2 dark:border-white/10">
                      <code class="block break-all">{file.relativePath}</code>
                      <span class="mt-1 block break-words text-zinc-500 dark:text-zinc-400">
                        {file.reason}
                      </span>
                    </div>
                  )}
                />
              ) : (
                <p class="mt-2 text-zinc-500 dark:text-zinc-400">
                  No files were skipped.
                </p>
              )}
            </details>
            <p class="text-amber-800 text-xs dark:text-amber-200" role="status">
              This plan is for {repo}/{name}. Applying uses this exact plan ID;
              a changed target or plan requires a new review.
            </p>
            <DialogFooter>
              <Button
                compact
                disabled={busy !== null}
                onClick={() => onApplyOpenChange(false)}
                variant="secondary"
              >
                Cancel
              </Button>
              <Button
                compact
                disabled={busy !== null || !planConfirmation}
                onClick={apply}
                variant="primary"
              >
                {busy === 'apply'
                  ? 'Applying reviewed plan…'
                  : 'Apply this reviewed plan'}
              </Button>
            </DialogFooter>
          </DialogContent>
        )}
      </Dialog>

      <Dialog
        onOpenChange={onReleaseOpenChange}
        open={releaseOpen && !!releasePlan}
      >
        {releasePlan && (
          <DialogContent class="sm:max-w-2xl">
            <DialogHeader>
              <DialogTitle>Review release of retained originals</DialogTitle>
              <DialogDescription>
                This separate review lists the exact retained originals and
                current installed files. Only listed retained files can be
                released.
              </DialogDescription>
            </DialogHeader>
            <dl class="grid min-w-0 grid-cols-[minmax(7rem,auto)_minmax(0,1fr)] gap-x-3 gap-y-2 text-xs">
              <dt class="text-zinc-500 dark:text-zinc-400">Worktree</dt>
              <dd class="break-all">
                {repo}/{name}
              </dd>
              <dt class="text-zinc-500 dark:text-zinc-400">
                Release review ID
              </dt>
              <dd class="break-all font-mono text-[11px]">{releasePlan.id}</dd>
              <dt class="text-zinc-500 dark:text-zinc-400">
                Apply operation ID
              </dt>
              <dd class="break-all font-mono text-[11px]">
                {releasePlan.operationId}
              </dd>
              <dt class="text-zinc-500 dark:text-zinc-400">Retained files</dt>
              <dd>{releasePlan.files.length}</dd>
              <dt class="text-zinc-500 dark:text-zinc-400">Physical savings</dt>
              <dd>Unknown</dd>
            </dl>
            <PagedList
              getKey={(file) => file.relativePath}
              identity={`${repo}\0${name}\0release\0${releasePlan.id}`}
              items={releasePlan.files}
              label="Retained original files"
              listClass="max-h-64 space-y-3 overflow-auto border-zinc-200/70 border-t pt-3 text-xs"
              ordered
              renderItem={(file) => (
                <div class="min-w-0 border-zinc-200/60 border-b pb-3 dark:border-white/10">
                  <code class="block break-all">{file.relativePath}</code>
                  <ul class="mt-2 space-y-1">
                    {file.fingerprints.map((fingerprint) => (
                      <li
                        class="min-w-0 break-all text-zinc-600 dark:text-zinc-300"
                        key={`${file.relativePath}:${fingerprint.label}`}
                      >
                        {fingerprintLabel(fingerprint.label)}:{' '}
                        <code>{fingerprint.identityHash}</code>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            />
            <p class="text-amber-800 text-xs dark:text-amber-200" role="status">
              Releasing these originals is a separate irreversible file removal.
              The release ID binds to the exact listed file identities; recorded
              sizes do not establish disk savings.
            </p>
            <DialogFooter>
              <Button
                compact
                disabled={busy !== null}
                onClick={() => onReleaseOpenChange(false)}
                variant="secondary"
              >
                Keep originals
              </Button>
              <Button
                compact
                disabled={busy !== null || !releaseConfirmation}
                onClick={onRelease}
                variant="primary"
              >
                {busy === 'release'
                  ? 'Releasing reviewed originals…'
                  : 'Release these originals'}
              </Button>
            </DialogFooter>
          </DialogContent>
        )}
      </Dialog>
    </>
  );
}

interface DependencyActionContext
  extends PrepareActionContext,
    ApplyOutcomeContext,
    ReconcileOutcomeContext {
  onRefresh: () => void;
  operation: DependencyFileOperation | null;
  operationId: string | null;
  plan: HoistedDependencyPlan | null;
  planConfirmation: string | null;
  planReviewKey: string | null;
  releaseConfirmation: string | null;
  releasePlan: DependencyReleasePlan | null;
  releaseReviewKey: string | null;
  resumeConfirmation: ReturnType<typeof resumeDependencyFilesBody>;
  resumeReleaseConfirmation: ReturnType<typeof resumeDependencyReleaseBody>;
  resumeReleaseReviewKey: string | null;
  resumeReviewKey: string | null;
  runAction: (
    action: Action,
    path: string,
    body: unknown
  ) => Promise<unknown | null>;
  setReleaseDialogOpen: (value: boolean) => void;
  setResumeDialogOpen: (value: boolean) => void;
  setResumeReleaseDialogOpen: (value: boolean) => void;
  setResumeReleaseReview: (value: LocalValue<string> | null) => void;
}

interface ActionRunnerContext {
  actionGuard: ReturnType<typeof createDependencyActionGuard>;
  busy: Action | null;
  onActionPending: (pending: boolean) => void;
  onRefresh: () => void;
  setBusyState: (value: LocalValue<Action> | null) => void;
  setError: (value: string | null) => void;
  targetKey: string;
}

async function runDependencyAction(
  action: Action,
  path: string,
  body: unknown,
  context: ActionRunnerContext
) {
  const {
    actionGuard,
    busy,
    onActionPending,
    onRefresh,
    setBusyState,
    setError,
    targetKey,
  } = context;
  if (busy) {
    return null;
  }
  const actionToken = actionGuard.begin(targetKey);
  setBusyState({ targetKey, value: action });
  setError(null);
  onActionPending(true);
  try {
    const response = await post(path, body);
    return actionGuard.isCurrent(actionToken, targetKey) ? response : null;
  } catch {
    return actionGuard.isCurrent(actionToken, targetKey)
      ? {
          error:
            'The outcome could not be confirmed. Reconcile the recorded operation before continuing.',
          networkUncertain: true,
          ok: false,
        }
      : null;
  } finally {
    if (actionGuard.isCurrent(actionToken, targetKey)) {
      setBusyState(null);
      onRefresh();
    }
  }
}

async function applyPlanAction(context: DependencyActionContext) {
  const {
    busy,
    plan,
    planConfirmation,
    planReviewKey,
    runAction,
    setError,
    setOperationState,
    setPlanDialogOpen,
    setPlanReview,
    setPlanState,
    setReleasePlanState,
    setReleaseReview,
    target,
    targetKey,
    onActionPending,
    toast,
  } = context;
  if (!plan || busy || !planConfirmation) {
    return;
  }
  const body = applyDependencyFilesBody(target, plan, planReviewKey);
  if (!body) {
    setPlanReview(null);
    setError('This review changed. Prepare and review the plan again.');
    return;
  }
  const expectedOperationId = plan.id;
  setOperationState({
    targetKey,
    value: {
      id: expectedOperationId,
      mode: 'hoisted-cow',
      physicalSavingsBytes: null,
      state: 'running',
      updatedAt: Date.now(),
    },
  });
  setReleasePlanState(null);
  setReleaseReview(null);
  const response = await runAction('apply', dependencyFileRoutes.apply, body);
  setPlanDialogOpen(false);
  setPlanReview(null);
  if (!response) {
    return;
  }
  applyOutcome(
    {
      onActionPending,
      setError,
      setOperationState,
      setPlanState,
      targetKey,
      toast,
    },
    response,
    expectedOperationId
  );
}

async function reconcileAction(context: DependencyActionContext) {
  const {
    busy,
    operation,
    operationId,
    runAction,
    setError,
    setOperationState,
    setPlanReview,
    setPlanState,
    setReleasePlanState,
    setReleaseReview,
    setResumeReview,
    setResumeReleaseReview,
    target,
    targetKey,
    onActionPending,
    toast,
  } = context;
  const body = recoverDependencyFilesBody(target, operationId);
  if (busy || !body) {
    return;
  }
  setPlanReview(null);
  setReleaseReview(null);
  setResumeReview(null);
  setResumeReleaseReview(null);
  setPlanState(null);
  setReleasePlanState(null);
  const response = await runAction(
    'reconcile',
    dependencyFileRoutes.recover,
    body
  );
  if (!response) {
    return;
  }
  reconcileOutcome(
    {
      onActionPending,
      operation,
      operationId,
      setError,
      setOperationState,
      targetKey,
      toast,
    },
    response
  );
}

async function resumeApplyAction(context: DependencyActionContext) {
  const {
    busy,
    onActionPending,
    operation,
    resumeConfirmation,
    resumeReviewKey,
    runAction,
    setError,
    setOperationState,
    setPlanState,
    setResumeDialogOpen,
    setResumeReview,
    target,
    targetKey,
    toast,
  } = context;
  if (!operation || busy || !resumeConfirmation) {
    return;
  }
  const body = resumeDependencyFilesBody(target, operation, resumeReviewKey);
  if (!body) {
    setResumeReview(null);
    setError(
      'The recorded operation changed. Reconcile it again before resuming.'
    );
    return;
  }
  const expectedId = operation.id;
  setOperationState({
    targetKey,
    value: { ...operation, state: 'running', updatedAt: Date.now() },
  });
  const response = await runAction('resume', dependencyFileRoutes.apply, body);
  setResumeDialogOpen(false);
  setResumeReview(null);
  if (!response) {
    return;
  }
  const result = record(response);
  const returned = dependencyFileOperationFrom(response);
  const releaseId =
    typeof result?.releaseId === 'string'
      ? result.releaseId
      : operation.releaseId;
  if (dependencyOutcomeUnknown(response)) {
    setOperationState({
      targetKey,
      value: {
        ...(returned ?? operation),
        id: expectedId,
        physicalSavingsBytes: null,
        releaseId,
        state: 'unknown',
        updatedAt: returned?.updatedAt ?? Date.now(),
      },
    });
    setError(
      `The resumed apply result is uncertain. Reconcile operation ${expectedId} before continuing.`
    );
    return;
  }
  if (returned) {
    setOperationState({ targetKey, value: { ...returned, releaseId } });
    setPlanState(null);
    setError(null);
    onActionPending(returned.state === 'running');
    toast(
      `Operation progress recorded: ${returned.state}.`,
      operationTone(returned.state)
    );
    return;
  }
  setOperationState({
    targetKey,
    value: {
      ...operation,
      releaseId,
      state: result?.ok === true ? 'unknown' : operation.state,
      updatedAt: Date.now(),
    },
  });
  setError(
    result?.ok === true
      ? `The server accepted the resumed apply without a summary. Reconcile operation ${expectedId}.`
      : actionError(response, 'The recorded plan could not be resumed.')
  );
}
async function resumeReleaseAction(context: DependencyActionContext) {
  const {
    busy,
    operation,
    resumeReleaseConfirmation,
    resumeReleaseReviewKey,
    runAction,
    setError,
    setOperationState,
    setResumeReleaseDialogOpen,
    setResumeReleaseReview,
    target,
    targetKey,
    toast,
  } = context;
  if (!operation || busy || !resumeReleaseConfirmation) {
    return;
  }
  const body = resumeDependencyReleaseBody(
    target,
    operation,
    resumeReleaseReviewKey
  );
  if (!body) {
    setResumeReleaseReview(null);
    setError(
      'The recorded release review changed. Reconcile before resuming it.'
    );
    return;
  }
  const expectedOperationId = operation.id;
  const expectedReleaseId = operation.releaseId;
  setOperationState({
    targetKey,
    value: { ...operation, state: 'running', updatedAt: Date.now() },
  });
  const response = await runAction(
    'resume-release',
    dependencyFileRoutes.release,
    body
  );
  setResumeReleaseDialogOpen(false);
  setResumeReleaseReview(null);
  if (!response) {
    return;
  }
  const result = record(response);
  const returned = dependencyFileOperationFrom(response);
  if (dependencyOutcomeUnknown(response)) {
    setOperationState({
      targetKey,
      value: {
        ...(returned ?? operation),
        id: expectedOperationId,
        physicalSavingsBytes: null,
        releaseId: expectedReleaseId,
        state: 'unknown',
        updatedAt: returned?.updatedAt ?? Date.now(),
      },
    });
    setError(
      `The release result is uncertain. Reconcile operation ${expectedOperationId} and release ${expectedReleaseId}.`
    );
    return;
  }
  if (returned) {
    setOperationState({
      targetKey,
      value: { ...returned, releaseId: expectedReleaseId },
    });
    setError(null);
    toast(
      `Original release progress recorded: ${returned.state}.`,
      operationTone(returned.state)
    );
    return;
  }
  setOperationState({
    targetKey,
    value: {
      ...operation,
      state: result?.ok === true ? 'unknown' : operation.state,
      updatedAt: Date.now(),
    },
  });
  setError(
    result?.ok === true
      ? `The server accepted the release without a summary. Reconcile operation ${expectedOperationId}.`
      : actionError(
          response,
          'The reviewed original release could not be resumed.'
        )
  );
}
async function prepareReleaseAction(context: DependencyActionContext) {
  const {
    busy,
    operation,
    operationId,
    runAction,
    setError,
    setOperationState,
    setPlanReview,
    setPlanState,
    setReleaseDialogOpen,
    setReleasePlanState,
    setReleaseReview,
    target,
    targetKey,
    toast,
  } = context;
  const body = prepareDependencyReleaseBody(target, operationId);
  if (busy || !body || !operation || operation.state !== 'completed') {
    return;
  }
  setReleasePlanState(null);
  setReleaseReview(null);
  setPlanReview(null);
  setPlanState(null);
  setError(null);
  const response = await runAction(
    'prepare-release',
    dependencyFileRoutes.prepareRelease,
    body
  );
  if (!response) {
    return;
  }
  const result = record(response);
  const nextPlan =
    result?.ok === true && operation
      ? parseDependencyReleasePlan(response, target, operation.id)
      : null;
  if (nextPlan && operation && nextPlan.operationId === operation.id) {
    setReleasePlanState({ targetKey, value: nextPlan });
    const reviewKey = dependencyReleaseReviewKey(nextPlan, target);
    setReleaseReview(reviewKey ? { targetKey, value: reviewKey } : null);
    setReleaseDialogOpen(true);
    return;
  }
  if (dependencyOutcomeUnknown(response)) {
    setOperationState({
      targetKey,
      value: {
        ...operation,
        physicalSavingsBytes: null,
        state: 'unknown',
        updatedAt: Date.now(),
      },
    });
    setError(
      `The release review could not be confirmed. Reconcile operation ${operation.id} before preparing another review.`
    );
    toast('✗ Original release review is uncertain. Reconcile first.', 'red');
    return;
  }
  setError(
    actionError(
      response,
      'A complete review of retained originals was not returned.'
    )
  );
  toast('✗ Original release review is unavailable.', 'red');
}
async function releaseOriginalsAction(context: DependencyActionContext) {
  const {
    busy,
    onActionPending,
    operation,
    releaseConfirmation,
    releasePlan,
    releaseReviewKey,
    runAction,
    setError,
    setOperationState,
    setReleaseDialogOpen,
    setReleasePlanState,
    setReleaseReview,
    target,
    targetKey,
    toast,
  } = context;
  if (!releasePlan || busy || !releaseConfirmation) {
    return;
  }
  const body = releaseDependencyFilesBody(
    target,
    releasePlan,
    releaseReviewKey
  );
  if (!body) {
    setReleaseReview(null);
    setError('This release review changed. Prepare and review it again.');
    return;
  }
  const expectedOperationId = releasePlan.operationId;
  setOperationState({
    targetKey,
    value: {
      id: expectedOperationId,
      mode: 'hoisted-cow',
      physicalSavingsBytes: null,
      state: 'running',
      updatedAt: Date.now(),
    },
  });
  const response = await runAction(
    'release',
    dependencyFileRoutes.release,
    body
  );
  setReleaseDialogOpen(false);
  setReleaseReview(null);
  if (!response) {
    return;
  }
  const result = record(response);
  const serverOperation = dependencyFileOperationFrom(response);
  if (dependencyOutcomeUnknown(response)) {
    setOperationState({
      targetKey,
      value: {
        ...(serverOperation ?? operation ?? {}),
        id: expectedOperationId,
        mode: 'hoisted-cow',
        physicalSavingsBytes: null,
        releaseId: releasePlan.id,
        state: 'unknown',
        updatedAt: serverOperation?.updatedAt ?? Date.now(),
      },
    });
    setError(
      `The release result is uncertain. Reconcile operation ${expectedOperationId} and release ${releasePlan.id} before continuing.`
    );
    toast('✗ Original release outcome is unknown. Reconcile first.', 'red');
    return;
  }
  if (serverOperation) {
    setOperationState({
      targetKey,
      value: {
        ...serverOperation,
        releaseId: serverOperation.releaseId ?? releasePlan.id,
      },
    });
    onActionPending(serverOperation.state === 'running');
    setReleasePlanState(null);
    setError(null);
    toast(
      serverOperation.state === 'released'
        ? 'Reviewed original files were released.'
        : `Release progress recorded: ${serverOperation.state}.`,
      operationTone(serverOperation.state)
    );
    return;
  }
  if (result?.ok === true) {
    setOperationState({
      targetKey,
      value: {
        ...(operation ?? {}),
        id: expectedOperationId,
        mode: 'hoisted-cow',
        physicalSavingsBytes: null,
        state: 'unknown',
        updatedAt: Date.now(),
      },
    });
    setError(
      `The server accepted the release but did not return its progress. Reconcile operation ${expectedOperationId}.`
    );
    toast('Release progress needs reconciliation.', 'amber');
    return;
  }
  setReleasePlanState(null);
  setReleaseReview(null);
  setError(actionError(response, 'The retained originals were not released.'));
  toast('✗ The retained originals were not released.', 'red');
}

function dependencyFileViewModel(
  operation: DependencyFileOperation | null,
  plan: HoistedDependencyPlan | null,
  releasePlan: DependencyReleasePlan | null,
  target: DependencyFileTarget,
  skippedFromStatus: DependencyFileSnapshot['skipped']
) {
  const progressCompleted = operation?.completedFiles ?? 0;
  const progressTotal = operation?.totalFiles ?? 0;
  return {
    canPrepareRelease:
      operation?.state === 'completed' &&
      (operation.retainedOriginalFiles ?? 0) > 0,
    displayedPlanKey: plan ? dependencyPlanReviewKey(plan, target) : null,
    displayedReleaseKey: releasePlan
      ? dependencyReleaseReviewKey(releasePlan, target)
      : null,
    needsReconciliation:
      operation?.state === 'unknown' ||
      operation?.state === 'conflict' ||
      operation?.state === 'partial' ||
      operation?.state === 'running',
    operationId: operation ? operation.id : null,
    progressAvailable: hasProgress(operation) && progressTotal > 0,
    progressCompleted,
    progressPercent:
      progressTotal > 0
        ? Math.min(100, Math.floor((progressCompleted / progressTotal) * 100))
        : 0,
    progressTotal,
    skipped: plan ? plan.skipped : skippedFromStatus,
  };
}

export function DependencyFileControls({
  data,
  failed,
  name,
  onActionPending,
  onRefresh,
  repo,
  toast,
}: DependencyFileControlsProps) {
  const target = { name, repo };
  const targetKey = `${repo}\0${name}`;
  const previousTargetKey = useRef(targetKey);
  const actionGuard = useRef(createDependencyActionGuard());
  actionGuard.current.targetChanged(targetKey);
  const statusReadOk = record(data)?.ok === true;
  const snapshot = dependencyFileSnapshot(data, target);
  const [busyState, setBusyState] = useState<LocalValue<Action> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [planState, setPlanState] =
    useState<LocalValue<HoistedDependencyPlan> | null>(null);
  const [releasePlanState, setReleasePlanState] =
    useState<LocalValue<DependencyReleasePlan> | null>(null);
  const [operationState, setOperationState] =
    useState<LocalValue<DependencyFileOperation> | null>(null);
  const [planReview, setPlanReview] = useState<LocalValue<string> | null>(null);
  const [releaseReview, setReleaseReview] = useState<LocalValue<string> | null>(
    null
  );
  const [resumeReview, setResumeReview] = useState<LocalValue<string> | null>(
    null
  );
  const [resumeReleaseReview, setResumeReleaseReview] =
    useState<LocalValue<string> | null>(null);
  const [planDialogOpen, setPlanDialogOpen] = useState(false);
  const [releaseDialogOpen, setReleaseDialogOpen] = useState(false);
  const [resumeDialogOpen, setResumeDialogOpen] = useState(false);
  const [resumeReleaseDialogOpen, setResumeReleaseDialogOpen] = useState(false);
  const busy = busyState?.targetKey === targetKey ? busyState.value : null;

  useEffect(() => {
    if (previousTargetKey.current !== targetKey) {
      previousTargetKey.current = targetKey;
      setPlanState(null);
      setReleasePlanState(null);
      setOperationState(null);
      setPlanReview(null);
      setReleaseReview(null);
      setResumeReview(null);
      setResumeReleaseReview(null);
      setPlanDialogOpen(false);
      setReleaseDialogOpen(false);
      setResumeDialogOpen(false);
      setResumeReleaseDialogOpen(false);
      setError(null);
    }
  }, [targetKey, onActionPending]);

  const plan = planState?.targetKey === targetKey ? planState.value : null;
  const releasePlan =
    releasePlanState?.targetKey === targetKey ? releasePlanState.value : null;
  const localOperation =
    operationState?.targetKey === targetKey ? operationState.value : null;
  const operation = newestOperation(localOperation, snapshot.operation);
  const view = dependencyFileViewModel(
    operation,
    plan,
    releasePlan,
    target,
    snapshot.skipped
  );
  const {
    canPrepareRelease,
    displayedPlanKey,
    displayedReleaseKey,
    needsReconciliation,
    operationId,
    progressAvailable,
    progressCompleted,
    progressPercent,
    progressTotal,
    skipped,
  } = view;
  const planReviewKey =
    planReview?.targetKey === targetKey ? planReview.value : null;
  const releaseReviewKey =
    releaseReview?.targetKey === targetKey ? releaseReview.value : null;
  const resumeReviewKey =
    resumeReview?.targetKey === targetKey ? resumeReview.value : null;
  const resumeReleaseReviewKey =
    resumeReleaseReview?.targetKey === targetKey
      ? resumeReleaseReview.value
      : null;
  const planConfirmation = plan
    ? dependencyPlanConfirmation(plan, target, planReviewKey)
    : null;
  const releaseConfirmation = releasePlan
    ? dependencyReleaseConfirmation(releasePlan, target, releaseReviewKey)
    : null;
  const resumeKey = operation
    ? dependencyResumeReviewKey(operation, target)
    : null;
  const resumeReleaseKey = operation
    ? dependencyReleaseResumeReviewKey(operation, target)
    : null;
  const resumeConfirmation = operation
    ? resumeDependencyFilesBody(target, operation, resumeReviewKey)
    : null;
  const resumeReleaseConfirmation = operation
    ? resumeDependencyReleaseBody(target, operation, resumeReleaseReviewKey)
    : null;
  const nativeReason = dependencyFileNativeReason(snapshot);
  useEffect(() => {
    onActionPending(busy !== null || operation?.state === 'running');
  }, [busy, onActionPending, operation?.id, operation?.state]);

  const runAction = (action: Action, path: string, body: unknown) =>
    runDependencyAction(action, path, body, {
      actionGuard: actionGuard.current,
      busy,
      onActionPending,
      onRefresh,
      setBusyState,
      setError,
      targetKey,
    });

  const actionContext: DependencyActionContext = {
    busy,
    name,
    onActionPending,
    onRefresh,
    operation,
    operationId,
    plan,
    planConfirmation,
    planReviewKey,
    releaseConfirmation,
    releasePlan,
    releaseReviewKey,
    repo,
    resumeConfirmation,
    resumeReleaseConfirmation,
    resumeReleaseReviewKey,
    resumeReviewKey,
    runAction,
    setError,
    setOperationState,
    setPlanDialogOpen,
    setPlanReview,
    setPlanState,
    setReleaseDialogOpen,
    setReleasePlanState,
    setReleaseReview,
    setResumeDialogOpen,
    setResumeReleaseDialogOpen,
    setResumeReleaseReview,
    setResumeReview,
    target,
    targetKey,
    toast,
  };

  async function prepare() {
    await prepareDependencyPlan({
      busy,
      name,
      repo,
      runAction,
      setError,
      setOperationState,
      setPlanDialogOpen,
      setPlanReview,
      setPlanState,
      setReleaseDialogOpen,
      setReleasePlanState,
      setReleaseReview,
      setResumeReleaseReview,
      setResumeReview,
      target,
      targetKey,
      toast,
    });
  }

  const applyPlan = () => applyPlanAction(actionContext);

  const reconcile = () => reconcileAction(actionContext);

  const resumeApply = () => resumeApplyAction(actionContext);

  const resumeRelease = () => resumeReleaseAction(actionContext);

  const prepareRelease = () => prepareReleaseAction(actionContext);

  const releaseOriginals = () => releaseOriginalsAction(actionContext);

  return (
    <div class="mt-4 border-zinc-200/70 border-t pt-4 dark:border-white/10">
      <DependencyFileHeader
        failed={failed}
        nativeReason={nativeReason}
        onRefresh={onRefresh}
        snapshot={snapshot}
        statusReadOk={statusReadOk}
      />

      <DependencyOperationPanel
        busy={busy}
        needsReconciliation={needsReconciliation}
        onReconcile={reconcile}
        operation={operation}
        progressAvailable={progressAvailable}
        progressCompleted={progressCompleted}
        progressPercent={progressPercent}
        progressTotal={progressTotal}
        resumeKey={resumeKey}
        resumeReleaseKey={resumeReleaseKey}
        setResumeDialogOpen={setResumeDialogOpen}
        setResumeReleaseDialogOpen={setResumeReleaseDialogOpen}
        setResumeReleaseReview={setResumeReleaseReview}
        setResumeReview={setResumeReview}
        targetKey={targetKey}
      />

      <DependencySkippedFiles
        files={skipped}
        identity={`${repo}\0${name}\0status-skipped`}
      />
      <DependencyActionButtons
        busy={busy}
        canPrepareRelease={canPrepareRelease}
        displayedPlanKey={displayedPlanKey}
        needsReconciliation={needsReconciliation}
        onPrepare={prepare}
        onPrepareRelease={prepareRelease}
        plan={plan}
        setPlanDialogOpen={setPlanDialogOpen}
        setPlanReview={setPlanReview}
        statusAllowsNewPlan={dependencyStatusAllowsNewPlan(snapshot)}
        targetKey={targetKey}
      />

      {error && (
        <p
          class="mt-3 max-w-prose break-words rounded-none bg-signal-red/10 p-2 text-signal-red text-xs"
          role="alert"
        >
          {error}
        </p>
      )}

      <DependencyResumeDialogs
        busy={busy}
        name={name}
        onResume={resumeApply}
        onResumeRelease={resumeRelease}
        operation={operation}
        progressAvailable={progressAvailable}
        progressCompleted={progressCompleted}
        progressTotal={progressTotal}
        releaseConfirmation={resumeReleaseConfirmation}
        releaseOpen={resumeReleaseDialogOpen}
        releaseReviewKey={resumeReleaseKey}
        repo={repo}
        resumeConfirmation={resumeConfirmation}
        resumeKey={resumeKey}
        resumeOpen={resumeDialogOpen}
        setReleaseOpen={setResumeReleaseDialogOpen}
        setReleaseReviewKey={setResumeReleaseReview}
        setResumeOpen={setResumeDialogOpen}
        setResumeReviewKey={setResumeReview}
      />
      <DependencyPlanDialogs
        apply={applyPlan}
        busy={busy}
        name={name}
        onApplyOpenChange={(open) => {
          setPlanDialogOpen(open);
          if (!open) {
            setPlanReview(null);
          }
        }}
        onRelease={releaseOriginals}
        onReleaseOpenChange={(open) => {
          setReleaseDialogOpen(open);
          if (!open) {
            setReleaseReview(null);
          }
        }}
        plan={plan}
        planConfirmation={planConfirmation}
        planOpen={planDialogOpen}
        releaseConfirmation={releaseConfirmation}
        releaseOpen={releaseDialogOpen}
        releasePlan={releasePlan}
        repo={repo}
      />

      <DependencyPlanStatus
        busy={busy}
        displayedPlanKey={displayedPlanKey}
        displayedReleaseKey={displayedReleaseKey}
        needsReconciliation={needsReconciliation}
        plan={plan}
        planDialogOpen={planDialogOpen}
        releaseDialogOpen={releaseDialogOpen}
        releasePlan={releasePlan}
        setReleaseDialogOpen={setReleaseDialogOpen}
        setReleaseReview={setReleaseReview}
        targetKey={targetKey}
      />
    </div>
  );
}
