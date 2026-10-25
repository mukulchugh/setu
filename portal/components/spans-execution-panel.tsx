import { useEffect, useId, useRef, useState } from 'preact/hooks';
import {
  approveSpansExecution,
  cancelSpansExecutionAttempt,
  clearSpansExecutionRecovery,
  decodeRetainedSpansExecutionInput,
  dispatchSpansExecution,
  findSpansExecutionAttempt,
  hasReceiptDependencyBinding,
  hasUnresolvedSpansExecutionOutcome,
  issueSpansExecutionChallenge,
  parseSpansExecutionCriteria,
  persistSpansExecutionCancelState,
  prepareSpansExecution,
  probeSpansExecutionProfile,
  type RegisteredSpansTarget,
  readRegisteredSpansTargets,
  readSpansExecutionCancelRecovery,
  readSpansExecutionCapabilities,
  readSpansExecutionRecovery,
  readSpansExecutionSavedReview,
  readSpansExecutionStatus,
  reconcileSpansExecution,
  reviewSpansExecution,
  revokeSpansExecution,
  runSpansExecutionCancelOperation,
  runSpansExecutionOperation,
  SPANS_EXECUTION_MAX_INSTRUCTIONS,
  SPANS_EXECUTION_MAX_MINUTES,
  SPANS_EXECUTION_PROFILE,
  type SpansExecutionAttemptBinding,
  type SpansExecutionCancelOperationResult,
  type SpansExecutionCancelState,
  type SpansExecutionCapabilities,
  type SpansExecutionDispatchResult,
  type SpansExecutionInput,
  type SpansExecutionOperationResult,
  type SpansExecutionPreparedReview,
  type SpansExecutionRecovery,
  type SpansExecutionRecoveryRead,
  type SpansExecutionRecoveryStage,
  type SpansExecutionStatus,
  type SpansExecutionStorage,
  sameSpansExecutionInput,
  spansExecutionErrorMessage,
  spansExecutionOperationInFlight,
  spansExecutionRecordIsEligible,
  spansExecutionSpanChoices,
  validSpansExecutionRequest,
} from '../spans-execution';
import {
  type ChallengeState,
  canStartProfileProbe,
  type ExecutionForm,
  type ExecutionNotice,
  type ExecutionResource,
  type ExecutionState,
  type ExecutionStatusResource,
  executionRecoveryPermissions,
  executionScopeIsCurrent,
  executionScopeKey,
  findLiveSpansExecutionAttempt,
  initialExecutionForRecovery,
  makeProfileProbeRecovery,
  protectedExecutionPermissions,
  type ReviewedExecution,
  recoveredExecutionState,
  resetExecutionAfterInputEdit,
  sameSpansExecutionAttemptBinding,
  selectExecutionProgress,
  settleExecutionConfirmation,
  transitionExecutionInScope,
} from '../spans-execution-state';
import { readSpansArtifact } from '../spans-read';
import type { SpansRecord } from '../spans-types';
import { inputCls } from '../ui';
import { Button } from '../ui/button';

const SAFE_STATE_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;

interface ArtifactEvidence {
  kind: 'error' | 'loaded';
  text?: string;
}

interface PanelState {
  cancellingAttemptId: string | null;
  capabilities:
    | ExecutionResource<SpansExecutionCapabilities>
    | { tag: 'probing'; value?: SpansExecutionCapabilities };
  execution: ExecutionState;
  form: ExecutionForm;
  formError: string | null;
  notice: ExecutionNotice | null;
  status: ExecutionStatusResource;
  targets: ExecutionResource<RegisteredSpansTarget[]>;
}

const initialForm = (): ExecutionForm => ({
  criteria: '',
  instructions: '',
  requireChange: false,
  spanId: '',
  targetKey: '',
  timeoutMinutes: '30',
});

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function child(value: unknown, key: string): unknown {
  return object(value)?.[key];
}

function textValue(value: unknown, fallback = 'Not available'): string {
  return typeof value === 'string' && value.length > 0 ? value : fallback;
}

function numberValue(value: unknown): number | null {
  return Number.isSafeInteger(value) && Number(value) >= 0
    ? Number(value)
    : null;
}

function browserStorage(): SpansExecutionStorage | null {
  try {
    return typeof window === 'undefined' ? null : window.sessionStorage;
  } catch {
    return null;
  }
}

function safeState(value: unknown): string | null {
  return typeof value === 'string' && SAFE_STATE_PATTERN.test(value)
    ? value
    : null;
}

function targetLabel(target: RegisteredSpansTarget): string {
  const branch = target.branch ? ` · ${target.branch}` : '';
  return `${target.label} / ${target.name}${branch}`;
}

function fieldValue(value: unknown, fallback = 'Not available'): string {
  if (typeof value === 'string') {
    return value || fallback;
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    return String(value);
  }
  if (typeof value === 'boolean') {
    return value ? 'Yes' : 'No';
  }
  return fallback;
}

function SummaryField({
  label,
  mono = false,
  value,
}: {
  label: string;
  mono?: boolean;
  value: unknown;
}) {
  return (
    <div class="min-w-0 py-1.5">
      <dt class="font-medium text-xs text-zinc-600 dark:text-zinc-300">
        {label}
      </dt>
      <dd
        class={`mt-0.5 min-w-0 break-words text-sm text-zinc-900 dark:text-zinc-100 ${mono ? 'font-mono' : ''}`}
      >
        {fieldValue(value)}
      </dd>
    </div>
  );
}

interface ProviderProfileState {
  busy: boolean;
  canVerify: boolean;
  canVerifyFresh: boolean;
  capabilities: SpansExecutionCapabilities | null;
  capabilityBusy: boolean;
  capabilityError: string | null;
  capabilityUnavailable: boolean;
  observedEffort: Record<string, unknown> | null;
  probeBlockedByRecovery: boolean;
  probeContextSelected: boolean;
  probeUnknown: boolean;
  profileDescription: string;
  stale: boolean;
}

interface ProviderProfileActions {
  verify: () => void;
  verifyFresh: () => void;
}

function ProviderProfileSection({
  actions,
  id,
  state,
}: {
  actions: ProviderProfileActions;
  id: string;
  state: ProviderProfileState;
}) {
  const {
    busy,
    canVerify,
    canVerifyFresh,
    capabilities,
    capabilityBusy,
    capabilityError,
    capabilityUnavailable,
    observedEffort,
    profileDescription,
    probeBlockedByRecovery,
    probeContextSelected,
    probeUnknown,
    stale,
  } = state;
  let verifyLabel = probeUnknown ? 'Run a fresh probe' : 'Verify profile';
  if (capabilityBusy) {
    verifyLabel = 'Verifying profile…';
  }
  return (
    <section
      aria-labelledby={`${id}-profile-title`}
      class="min-w-0 border-zinc-200 border-y py-4 dark:border-white/10"
    >
      <h3
        class="font-semibold text-sm text-zinc-900 dark:text-zinc-100"
        id={`${id}-profile-title`}
      >
        Provider profile
      </h3>
      <dl class="mt-2 grid min-w-0 gap-x-6 sm:grid-cols-2">
        <SummaryField label="Profile" value="Claude Code · Claude Sonnet 5.5" />
        <SummaryField label="Requested effort" value="medium" />
        <SummaryField
          label="Probe-reported effort"
          value={observedEffort?.observed ?? 'Not observed'}
        />
        <SummaryField
          label="Billing"
          value="Subscription billing · usage estimate only; this panel reports no monetary amount or limit."
        />
      </dl>
      {capabilities ? (
        <div aria-live="polite" class="mt-2 text-sm" role="status">
          <p
            class={
              capabilities.launch.allowed
                ? 'text-signal-green'
                : 'text-amber-900 dark:text-amber-100'
            }
          >
            {profileDescription}
          </p>
          {capabilities.launch.blockedBy.length > 0 && (
            <p class="mt-1 text-zinc-600 dark:text-zinc-300">
              Blocked by: {capabilities.launch.blockedBy.join(', ')}
            </p>
          )}
          {capabilities.launch.unverified.length > 0 && (
            <p class="mt-1 text-zinc-600 dark:text-zinc-300">
              Unverified: {capabilities.launch.unverified.join(', ')}
            </p>
          )}
        </div>
      ) : (
        <p
          aria-live="polite"
          class="mt-2 text-sm text-zinc-600 dark:text-zinc-300"
          role="status"
        >
          {capabilityError ?? 'Checking local profile capability…'}
        </p>
      )}
      {capabilityError && (
        <p class="mt-2 text-signal-red text-sm" role="alert">
          {capabilityError}
        </p>
      )}
      {probeUnknown && (
        <p
          class="mt-2 max-w-3xl text-amber-900 text-sm dark:text-amber-100"
          role="status"
        >
          The earlier probe may have reached the provider. This client has no
          probe operation identity, so current capability status cannot prove
          whether that exact request succeeded. A fresh probe may repeat
          provider quota use.
        </p>
      )}
      {probeBlockedByRecovery && (
        <p class="mt-2 max-w-3xl text-sm text-zinc-600 dark:text-zinc-300">
          Resolve the saved review before running a provider probe so its
          recovery record stays intact.
        </p>
      )}
      {!probeContextSelected && (
        <p class="mt-2 max-w-3xl text-sm text-zinc-600 dark:text-zinc-300">
          Choose a planned span and registered checkout to scope probe recovery.
          This selection does not send or start the span.
        </p>
      )}
      <p class="mt-2 max-w-3xl text-sm text-zinc-600 dark:text-zinc-300">
        Verify profile starts one small provider probe and uses provider quota.
        It does not start this span.
      </p>
      <Button
        class="mt-3 min-h-11"
        disabled={
          capabilityBusy ||
          busy ||
          stale ||
          !probeContextSelected ||
          (probeUnknown ? !canVerifyFresh : !canVerify) ||
          (capabilityUnavailable && !probeUnknown)
        }
        onClick={probeUnknown ? actions.verifyFresh : actions.verify}
        variant="secondary"
      >
        {verifyLabel}
      </Button>
    </section>
  );
}

interface ExecutionStatusState {
  busy: boolean;
  canCancel: boolean;
  cancelAttempt: (binding: SpansExecutionAttemptBinding) => void;
  cancellingAttemptId: string | null;
  recovery: SpansExecutionRecovery | null;
  runId: string;
  status: SpansExecutionStatus | null;
  statusBusy: boolean;
  statusDescription: string | null;
  statusError: string | null;
}

interface ExecutionStatusActions {
  cancelAttempt: (binding: SpansExecutionAttemptBinding) => void;
  check: () => void;
  refresh: () => void;
}

function ExecutionStatusSection({
  actions,
  id,
  state,
}: {
  actions: ExecutionStatusActions;
  id: string;
  state: ExecutionStatusState;
}) {
  const { busy, status, statusBusy, statusDescription, statusError } = state;
  return (
    <section
      aria-labelledby={`${id}-status-title`}
      class="mt-5 min-w-0 border-zinc-200 border-y py-4 dark:border-white/10"
    >
      <h3
        class="font-semibold text-sm text-zinc-900 dark:text-zinc-100"
        id={`${id}-status-title`}
      >
        Execution status
      </h3>
      <p class="mt-1 max-w-3xl text-sm text-zinc-600 dark:text-zinc-300">
        Status reads the current run without starting a worker. Captured or
        terminal evidence does not complete a span until the existing acceptance
        path records it.
      </p>
      {statusError && (
        <p class="mt-2 text-signal-red text-sm" role="alert">
          {statusError}
        </p>
      )}
      {status && status.executions.length > 0 ? (
        <ul class="mt-2 min-w-0 divide-y divide-zinc-200 dark:divide-white/10">
          {status.executions.map((item) => {
            const binding = statusAttemptBinding(status, state.runId, item);
            const liveStatus = ['launching', 'running', 'finalizing'].includes(
              String(item.attempt)
            );
            return (
              <li
                class="min-w-0 py-2 text-sm text-zinc-800 dark:text-zinc-100"
                key={String(item.actionId)}
              >
                <p class="break-words">
                  {textValue(item.spanId, 'Span unavailable')} · attempt{' '}
                  {safeState(item.attempt) ?? 'unknown'} · acceptance{' '}
                  {safeState(item.acceptance) ?? 'unknown'}
                </p>
                <p class="mt-1 break-all font-mono text-xs text-zinc-600 dark:text-zinc-300">
                  Action {textValue(item.actionId)} · attempt ID{' '}
                  {textValue(item.attemptId)}
                </p>
                {liveStatus && (
                  <ExecutionCancelControl
                    binding={binding}
                    busy={state.cancellingAttemptId === item.attemptId}
                    cancelAttempt={state.cancelAttempt}
                    enabled={
                      state.canCancel &&
                      !busy &&
                      !statusBusy &&
                      state.cancellingAttemptId === null
                    }
                    state={
                      binding
                        ? cancelStateForAttempt(binding, state.recovery)
                        : null
                    }
                  />
                )}
                {item.acceptance === 'accepted' && (
                  <p class="mt-1 text-signal-green">
                    The existing human acceptance path recorded this result.
                  </p>
                )}
                {item.acceptance === 'pending' && (
                  <p class="mt-1 text-amber-900 dark:text-amber-100">
                    Captured evidence is awaiting the existing human acceptance
                    path.
                  </p>
                )}
              </li>
            );
          })}
        </ul>
      ) : (
        <p
          aria-live="polite"
          class="mt-2 text-sm text-zinc-600 dark:text-zinc-300"
          role="status"
        >
          {statusDescription}
        </p>
      )}
      <div class="mt-3 flex min-w-0 flex-wrap gap-2">
        <Button
          class="min-h-11"
          disabled={statusBusy}
          onClick={actions.check}
          variant="secondary"
        >
          {statusBusy ? 'Checking status…' : 'Check execution status'}
        </Button>
        <Button
          class="min-h-11"
          disabled={busy}
          onClick={actions.refresh}
          variant="secondary"
        >
          Refresh parent run
        </Button>
      </div>
    </section>
  );
}

interface RecoverySectionState {
  busy: boolean;
  canCancel: boolean;
  cancelAttempt: (binding: SpansExecutionAttemptBinding) => void;
  cancellingAttemptId: string | null;
  execution: ExecutionState;
  matchedStatus: ReturnType<typeof statusForReview>;
  preparedReadback: boolean;
  reconciling: boolean;
  recovery: SpansExecutionRecovery | null;
  status: SpansExecutionStatus | null;
  statusBusy: boolean;
  statusError: string | null;
  targetsAvailable: boolean;
}

function RecoverySection({
  actions,
  id,
  permissions,
  state,
}: {
  actions: Pick<
    ExecutionPanelActions,
    | 'checkStatus'
    | 'cancelAttempt'
    | 'readSavedReview'
    | 'reconcile'
    | 'refresh'
    | 'requestApproval'
    | 'requestRevocation'
  >;
  id: string;
  permissions: Pick<ExecutionPermissions, 'canApprove' | 'canRevoke'>;
  state: RecoverySectionState;
}) {
  const {
    busy,
    canCancel,
    cancelAttempt,
    cancellingAttemptId,
    execution,
    matchedStatus,
    preparedReadback,
    recovery,
    reconciling,
    status,
    statusBusy,
    statusError,
    targetsAvailable,
  } = state;
  const dispatchMessage =
    recovery?.stage === 'dispatch-unknown'
      ? 'Start outcome is unknown. This attempt remains blocked; do not send Start again.'
      : 'Start was recorded. A launched or terminal worker does not mark the span complete; use existing evidence and the acceptance path.';
  const stopDetails = recoveryStopDetails(status, recovery, matchedStatus);
  let statusMessage = 'Execution status has not been confirmed.';
  if (status) {
    statusMessage =
      'No matching attempt appears in this snapshot. That is not proof Start never took effect; keep this attempt blocked.';
  }
  return (
    <section
      aria-labelledby={`${id}-recovery-title`}
      class="mt-4 min-w-0 border-zinc-200 border-b pb-4 dark:border-white/10"
    >
      <h3
        class="font-semibold text-sm text-zinc-900 dark:text-zinc-100"
        id={`${id}-recovery-title`}
      >
        Resolve the recorded attempt
      </h3>
      <p class="mt-1 max-w-3xl text-sm text-zinc-600 dark:text-zinc-300">
        Reconciliation checks Setu-owned saved execution attempts across the
        archive. It is not scoped to this run and does not start or retry a
        worker.
      </p>
      {recovery?.stage === 'prepare-unknown' && (
        <p class="mt-2 text-amber-900 text-sm dark:text-amber-100">
          Prepare outcome is unknown and no review digest was retained. Do not
          send Prepare again. Inspect this run’s evidence and refresh status.
        </p>
      )}
      {recovery?.stage === 'approval-unknown' && (
        <p class="mt-2 text-amber-900 text-sm dark:text-amber-100">
          Approval outcome is unknown. Read back the immutable review before
          asking for a new typed confirmation. Approval did not send Start.
        </p>
      )}
      {recovery?.stage === 'revocation-unknown' && (
        <p class="mt-2 text-amber-900 text-sm dark:text-amber-100">
          Revocation outcome is unknown. Read back the immutable review before
          asking for a new typed revocation confirmation.
        </p>
      )}
      {(recovery?.stage === 'dispatch-unknown' ||
        recovery?.stage === 'dispatched') && (
        <p class="mt-2 text-amber-900 text-sm dark:text-amber-100">
          {dispatchMessage}
        </p>
      )}
      {recovery?.actionId && recovery.attemptId && (
        <dl class="mt-2 grid min-w-0 gap-x-6 sm:grid-cols-2">
          <SummaryField label="Action ID" mono value={recovery.actionId} />
          <SummaryField label="Attempt ID" mono value={recovery.attemptId} />
        </dl>
      )}
      {recovery?.reviewDigest && (
        <SummaryField
          label="Review digest"
          mono
          value={recovery.reviewDigest}
        />
      )}
      {recovery?.reviewDigest && !preparedReadback && targetsAvailable && (
        <Button
          class="mt-3 min-h-11"
          disabled={busy}
          onClick={actions.readSavedReview}
          variant="secondary"
        >
          Read saved review and exact input
        </Button>
      )}
      {execution.tag === 'prepared' &&
        recovery?.stage === 'approval-unknown' &&
        execution.readback && (
          <div class="mt-3 flex min-w-0 flex-wrap gap-2">
            <Button
              class="min-h-11"
              disabled={!permissions.canApprove}
              onClick={actions.requestApproval}
            >
              Request a fresh approval challenge
            </Button>
            <Button
              class="min-h-11"
              disabled={!permissions.canRevoke}
              onClick={actions.requestRevocation}
              variant="secondary"
            >
              Confirm revocation with a new phrase
            </Button>
          </div>
        )}
      {execution.tag === 'prepared' &&
        recovery?.stage === 'revocation-unknown' &&
        execution.readback && (
          <Button
            class="mt-3 min-h-11"
            disabled={!permissions.canRevoke}
            onClick={actions.requestRevocation}
            variant="secondary"
          >
            Request a fresh revocation challenge
          </Button>
        )}
      <div class="mt-3 flex min-w-0 flex-wrap gap-2">
        <Button
          class="min-h-11"
          disabled={statusBusy}
          onClick={actions.checkStatus}
          variant="secondary"
        >
          {statusBusy ? 'Checking status…' : 'Check execution status'}
        </Button>
        <Button
          class="min-h-11"
          disabled={busy}
          onClick={actions.reconcile}
          variant="secondary"
        >
          {reconciling
            ? 'Reconciling saved executions…'
            : 'Reconcile saved executions'}
        </Button>
        <Button
          class="min-h-11"
          disabled={busy}
          onClick={actions.refresh}
          variant="secondary"
        >
          Refresh parent run
        </Button>
      </div>
      {statusError && (
        <p class="mt-2 text-signal-red text-sm" role="alert">
          {statusError}
        </p>
      )}
      {matchedStatus ? (
        <p
          aria-live="polite"
          class="mt-3 text-sm text-zinc-700 dark:text-zinc-200"
          role="status"
        >
          Attempt {matchedStatus.attempt}. Action {matchedStatus.action}.
          Acceptance {matchedStatus.acceptance}. Only the existing human
          acceptance path marks completion.
        </p>
      ) : (
        <p
          aria-live="polite"
          class="mt-3 text-sm text-zinc-600 dark:text-zinc-300"
          role="status"
        >
          {statusMessage}
        </p>
      )}
      {stopDetails.live && (
        <ExecutionCancelControl
          binding={stopDetails.binding}
          busy={cancellingAttemptId === recovery?.attemptId}
          cancelAttempt={cancelAttempt}
          enabled={
            canCancel && !busy && !statusBusy && cancellingAttemptId === null
          }
          state={
            stopDetails.binding
              ? cancelStateForAttempt(stopDetails.binding, recovery)
              : null
          }
        />
      )}
    </section>
  );
}

interface ExecutionRequestFormState {
  execution: ExecutionState;
  form: ExecutionForm;
  formError: string | null;
  targets: PanelState['targets'];
}

function ExecutionRequestForm({
  actions,
  id,
  permissions,
  spanChoices,
  state,
}: {
  actions: Pick<
    ExecutionPanelActions,
    'editForm' | 'formErrorRef' | 'formInvalid' | 'preview' | 'refresh'
  >;
  id: string;
  permissions: Pick<
    ExecutionPermissions,
    'busy' | 'canEdit' | 'canReview' | 'canSelectProbeScope'
  >;
  spanChoices: ReturnType<typeof spansExecutionSpanChoices>;
  state: ExecutionRequestFormState;
}) {
  const targets = state.targets.tag === 'ready' ? state.targets.value : [];
  const targetError =
    state.targets.tag === 'error' ? state.targets.error : null;
  const targetsLoading = state.targets.tag === 'loading';
  const selectedSpan = spanChoices.some(
    (span) => span.spanId === state.form.spanId
  );
  const selectedTarget = targets.some(
    (target) => target.key === state.form.targetKey
  );
  return (
    <form
      class="mt-4 min-w-0"
      onInvalidCapture={actions.formInvalid}
      onSubmit={actions.preview}
    >
      <fieldset
        aria-busy={permissions.busy || targetsLoading}
        class="min-w-0 space-y-4"
        disabled={
          !(permissions.canEdit || permissions.canSelectProbeScope) ||
          targetsLoading ||
          targets.length === 0
        }
      >
        <legend class="sr-only">Execution request</legend>
        <div class="min-w-0">
          <label
            class="block font-medium text-sm text-zinc-800 dark:text-zinc-100"
            for={`${id}-span`}
          >
            Planned span
          </label>
          <select
            class={`${inputCls} mt-1 block min-h-11 w-full min-w-0`}
            disabled={!(permissions.canEdit || permissions.canSelectProbeScope)}
            id={`${id}-span`}
            onChange={(event) =>
              actions.editForm((current) => ({
                ...current,
                spanId: event.currentTarget.value,
              }))
            }
            required
            value={state.form.spanId}
          >
            <option value="">Choose a span</option>
            {spanChoices.map((span) => (
              <option key={span.spanId} value={span.spanId}>
                {span.title} · {span.spanId} · {span.state}
              </option>
            ))}
          </select>
        </div>

        <div class="min-w-0">
          <label
            class="block font-medium text-sm text-zinc-800 dark:text-zinc-100"
            for={`${id}-target`}
          >
            Registered project and checkout
          </label>
          <select
            class={`${inputCls} mt-1 block min-h-11 w-full min-w-0`}
            disabled={!(permissions.canEdit || permissions.canSelectProbeScope)}
            id={`${id}-target`}
            onChange={(event) =>
              actions.editForm((current) => ({
                ...current,
                targetKey: event.currentTarget.value,
              }))
            }
            required
            value={state.form.targetKey}
          >
            <option value="">Choose a registered checkout</option>
            {targets.map((target) => (
              <option key={target.key} value={target.key}>
                {targetLabel(target)}
              </option>
            ))}
          </select>
          <p class="mt-1 text-xs text-zinc-600 dark:text-zinc-300">
            Only worktrees returned by Setu are selectable. The review records
            their observed checkout; no path is entered here.
          </p>
        </div>

        <div class="min-w-0">
          <label
            class="block font-medium text-sm text-zinc-800 dark:text-zinc-100"
            for={`${id}-instructions`}
          >
            Instructions for this span
          </label>
          <textarea
            class={`${inputCls} mt-1 block min-h-32 w-full min-w-0 resize-y`}
            disabled={!permissions.canEdit}
            id={`${id}-instructions`}
            maxLength={SPANS_EXECUTION_MAX_INSTRUCTIONS}
            onInput={(event) =>
              actions.editForm((current) => ({
                ...current,
                instructions: event.currentTarget.value,
              }))
            }
            required
            value={state.form.instructions}
          />
          <p class="mt-1 text-xs text-zinc-600 dark:text-zinc-300">
            {state.form.instructions.length} /{' '}
            {SPANS_EXECUTION_MAX_INSTRUCTIONS} characters. Editing any field
            clears the local preview and approval state.
          </p>
        </div>

        <div class="min-w-0">
          <label
            class="block font-medium text-sm text-zinc-800 dark:text-zinc-100"
            for={`${id}-timeout`}
          >
            Maximum run time in minutes
          </label>
          <input
            class={`${inputCls} mt-1 block min-h-11 w-full min-w-0 sm:max-w-40`}
            disabled={!permissions.canEdit}
            id={`${id}-timeout`}
            inputMode="numeric"
            max={SPANS_EXECUTION_MAX_MINUTES}
            min={1}
            onInput={(event) =>
              actions.editForm((current) => ({
                ...current,
                timeoutMinutes: event.currentTarget.value,
              }))
            }
            required
            type="number"
            value={state.form.timeoutMinutes}
          />
          <p class="mt-1 text-xs text-zinc-600 dark:text-zinc-300">
            Whole minutes from 1 to 60. Setu checks the final deadline again
            before launch.
          </p>
        </div>

        <div class="min-w-0">
          <label
            class="block font-medium text-sm text-zinc-800 dark:text-zinc-100"
            for={`${id}-criteria`}
          >
            Acceptance criteria (optional, one per line)
          </label>
          <textarea
            class={`${inputCls} mt-1 block min-h-24 w-full min-w-0 resize-y`}
            disabled={!permissions.canEdit}
            id={`${id}-criteria`}
            onInput={(event) =>
              actions.editForm((current) => ({
                ...current,
                criteria: event.currentTarget.value,
              }))
            }
            value={state.form.criteria}
          />
          <p class="mt-1 text-xs text-zinc-600 dark:text-zinc-300">
            At most 10 criteria, 300 characters each. The person reviewing
            captured evidence decides whether they are met.
          </p>
        </div>

        <label class="flex min-h-11 min-w-0 items-center gap-3 text-sm text-zinc-800 dark:text-zinc-100">
          <input
            checked={state.form.requireChange}
            class="size-4 shrink-0 accent-accent"
            disabled={!permissions.canEdit}
            onChange={(event) =>
              actions.editForm((current) => ({
                ...current,
                requireChange: event.currentTarget.checked,
              }))
            }
            type="checkbox"
          />
          Require a code change before this work can be accepted
        </label>
      </fieldset>

      {targetsLoading && (
        <p
          aria-live="polite"
          class="mt-3 text-sm text-zinc-600 dark:text-zinc-300"
          role="status"
        >
          Loading registered worktrees…
        </p>
      )}
      {targetError && (
        <div class="mt-3 text-signal-red text-sm" role="alert">
          <p>{targetError}</p>
          <Button
            class="mt-2 min-h-11"
            disabled={targetsLoading}
            onClick={actions.refresh}
            variant="secondary"
          >
            Retry worktree and capability read
          </Button>
        </div>
      )}
      {!(targetsLoading || targetError) && targets.length === 0 && (
        <p class="mt-3 text-sm text-zinc-600 dark:text-zinc-300">
          Setu has no registered checkout available for this review.
        </p>
      )}
      {spanChoices.length === 0 && (
        <p class="mt-3 text-sm text-zinc-600 dark:text-zinc-300">
          There are no incomplete spans available to review.
        </p>
      )}
      {state.formError && (
        <p
          aria-live="assertive"
          class="mt-3 text-signal-red text-sm"
          id={`${id}-form-error`}
          ref={actions.formErrorRef}
          role="alert"
          tabIndex={-1}
        >
          {state.formError}
        </p>
      )}
      <Button
        class="mt-4 min-h-11"
        disabled={!(permissions.canReview && selectedSpan && selectedTarget)}
        type="submit"
      >
        {state.execution.tag === 'previewing'
          ? 'Reviewing checkout…'
          : 'Preview execution review'}
      </Button>
    </form>
  );
}

interface ExecutionPreviewState {
  busy: boolean;
  execution: ExecutionState;
  mayReview: boolean;
  preview: NonNullable<ReturnType<typeof selectExecutionProgress>['preview']>;
}

interface ExecutionPreviewActions {
  discard: () => void;
  save: () => void;
}

function ExecutionPreviewSection({
  actions,
  id,
  state,
}: {
  actions: ExecutionPreviewActions;
  id: string;
  state: ExecutionPreviewState;
}) {
  const { busy, execution, mayReview, preview } = state;
  const { review } = preview.review;
  const target = object(child(review, 'target'));
  const checkout = object(child(review, 'checkout'));
  const mode = object(child(review, 'mode'));
  const effort = object(mode?.effort);
  const cost = object(child(review, 'cost'));
  const billing = cost?.billing;
  const billingText =
    billing === 'subscription'
      ? 'Subscription · provider usage estimate only; this panel reports no monetary amount or limit'
      : fieldValue(billing);
  return (
    <section
      aria-labelledby={`${id}-preview-title`}
      class="mt-5 min-w-0 border-zinc-200 border-y py-4 dark:border-white/10"
    >
      <h3
        class="font-semibold text-sm text-zinc-900 dark:text-zinc-100"
        id={`${id}-preview-title`}
      >
        Read-only preview
      </h3>
      <p class="mt-1 max-w-3xl text-sm text-zinc-600 dark:text-zinc-300">
        This preview observes the selected target and displays the proposed
        model, tool mode, criteria, timeout, and billing. Its checksum grants no
        authority.
      </p>
      <dl class="mt-3 grid min-w-0 gap-x-6 sm:grid-cols-2">
        <SummaryField
          label="Target"
          value={`${textValue(target?.repo)} / ${textValue(target?.name)}`}
        />
        <SummaryField label="HEAD" mono value={checkout?.head} />
        <SummaryField label="Dirty paths" value={checkout?.dirtyCount} />
        <SummaryField label="Model" value={mode?.model} />
        <SummaryField label="Requested effort" value={effort?.requested} />
        <SummaryField
          label="Probe-reported effort"
          value={effort?.observed ?? 'Not observed'}
        />
        <SummaryField
          label="Tool mode"
          value={fieldValue(mode?.permissionMode)}
        />
        <SummaryField
          label="Timeout"
          value={`${Math.ceil(preview.input.wallClockMs / 60_000)} minutes`}
        />
        <SummaryField label="Billing" value={billingText} />
        <SummaryField
          label="Preview checksum (not approval)"
          mono
          value={preview.review.confirmation}
        />
      </dl>
      <div class="mt-3 flex min-w-0 flex-wrap gap-2">
        <Button
          class="min-h-11"
          disabled={!mayReview || busy}
          onClick={actions.save}
        >
          {execution.tag === 'preparing'
            ? 'Saving review…'
            : 'Save immutable review'}
        </Button>
        <Button
          class="min-h-11"
          disabled={busy}
          onClick={actions.discard}
          variant="secondary"
        >
          Edit review inputs
        </Button>
      </div>
    </section>
  );
}

function ChallengeConfirmation({
  busy,
  challenge,
  id,
  onCancel,
  onConfirm,
  onResponse,
}: {
  busy: boolean;
  challenge: ChallengeState;
  id: string;
  onCancel: (intent: 'approve' | 'revoke') => void;
  onConfirm: () => void;
  onResponse: (value: string) => void;
}) {
  const isApproval = challenge.challenge.intent === 'approve';
  return (
    <section
      aria-labelledby={`${id}-challenge-title`}
      class="mt-4 min-w-0 border-zinc-200 border-y py-4 dark:border-white/10"
    >
      <h3
        class="font-semibold text-sm text-zinc-900 dark:text-zinc-100"
        id={`${id}-challenge-title`}
      >
        {isApproval ? 'Type the approval phrase' : 'Type the revocation phrase'}
      </h3>
      <p class="mt-2 text-sm text-zinc-700 dark:text-zinc-200">
        Enter this exact phrase before{' '}
        {new Date(challenge.challenge.expiresAt).toLocaleTimeString()}:
      </p>
      <p class="mt-1 min-w-0 break-words font-mono text-sm text-zinc-900 dark:text-zinc-100">
        <code>{challenge.challenge.phrase}</code>
      </p>
      <label
        class="mt-3 block font-medium text-sm text-zinc-800 dark:text-zinc-100"
        for={`${id}-confirmation`}
      >
        Type the phrase exactly
      </label>
      <input
        autoComplete="off"
        class={`${inputCls} mt-1 block min-h-11 w-full min-w-0`}
        disabled={busy}
        id={`${id}-confirmation`}
        onInput={(event) => onResponse(event.currentTarget.value)}
        value={challenge.response}
      />
      <div class="mt-3 flex min-w-0 flex-wrap gap-2">
        <Button
          class="min-h-11"
          disabled={busy || challenge.response !== challenge.challenge.phrase}
          onClick={onConfirm}
        >
          {isApproval ? 'Save approval' : 'Revoke approval'}
        </Button>
        <Button
          class="min-h-11"
          disabled={busy}
          onClick={() => onCancel(challenge.challenge.intent)}
          variant="secondary"
        >
          Cancel confirmation
        </Button>
      </div>
    </section>
  );
}

interface PreparedExecutionState {
  busy: boolean;
  execution: ExecutionState;
  prepared: ReviewedExecution;
  recoveryBlocked: boolean;
  reviewIsCurrent: boolean;
  selectedTitle: string;
}

function PreparedExecutionSection({
  actions,
  id,
  permissions,
  state,
}: {
  actions: Pick<
    ExecutionPanelActions,
    | 'cancelChallenge'
    | 'changeChallengeResponse'
    | 'confirmChallenge'
    | 'dispatch'
    | 'requestApproval'
    | 'requestRevocation'
  >;
  id: string;
  permissions: Pick<
    ExecutionPermissions,
    'canApprove' | 'canDispatch' | 'canRevoke'
  >;
  state: PreparedExecutionState;
}) {
  const {
    busy,
    execution,
    prepared,
    recoveryBlocked,
    reviewIsCurrent,
    selectedTitle,
  } = state;
  const { challenge } = selectExecutionProgress(execution);
  const artifact = object(prepared.review.binding.inputArtifact);
  const evidenceIdentity = JSON.stringify([
    prepared.review.binding.runId,
    prepared.review.reviewDigest,
    artifact?.id ?? null,
  ]);
  return (
    <>
      <ExecutionReviewSummary
        input={prepared.input}
        key={evidenceIdentity}
        review={prepared.review}
        spanTitle={selectedTitle}
      />
      {!hasReceiptDependencyBinding(prepared.review) && (
        <p
          class="mt-3 text-amber-900 text-sm dark:text-amber-100"
          role="status"
        >
          This saved review uses an older dependency check. It remains available
          as history and can be revoked. Prepare a new review with a verified
          Setu setup receipt before approving or starting work.
        </p>
      )}
      {execution.tag === 'revoked' && (
        <p
          class="mt-3 text-amber-900 text-sm dark:text-amber-100"
          role="status"
        >
          This immutable review is revoked. Prepare a new review before seeking
          approval.
        </p>
      )}
      {execution.tag === 'prepared' && !recoveryBlocked && (
        <div class="mt-4 min-w-0">
          <p class="max-w-3xl text-sm text-zinc-600 dark:text-zinc-300">
            Approval records your typed confirmation for this immutable digest.
            It never starts a worker.
          </p>
          <Button
            class="mt-3 min-h-11"
            disabled={!permissions.canApprove}
            onClick={actions.requestApproval}
          >
            Request approval challenge
          </Button>
        </div>
      )}
      {execution.tag === 'approved' && (
        <div class="mt-4 min-w-0 border-zinc-200 border-y py-4 dark:border-white/10">
          <p
            class={
              execution.approvalObservation === 'recovered'
                ? 'text-amber-900 text-sm dark:text-amber-100'
                : 'text-signal-green text-sm'
            }
            role="status"
          >
            {execution.approvalObservation === 'recovered'
              ? 'This browser previously observed an approval response for this review. The saved marker does not prove approval is current or that no worker has started; Setu checks the approval and attempt state again when you request Start.'
              : 'Approval response received for this exact review. This action did not start a worker; Setu checks the approval and attempt state again when you request Start.'}
          </p>
          <div class="mt-3 flex min-w-0 flex-wrap gap-2">
            <Button
              class="min-h-11"
              disabled={!permissions.canDispatch}
              onClick={actions.dispatch}
            >
              Start approved span
            </Button>
            <Button
              class="min-h-11"
              disabled={!permissions.canRevoke}
              onClick={actions.requestRevocation}
              variant="secondary"
            >
              Revoke approval
            </Button>
          </div>
          {!reviewIsCurrent && (
            <p class="mt-2 text-amber-900 text-sm dark:text-amber-100">
              The saved review does not match the run’s current generation, plan
              version, target, or inputs. Refresh and prepare a new review.
            </p>
          )}
        </div>
      )}
      {challenge && (
        <ChallengeConfirmation
          busy={busy}
          challenge={challenge}
          id={id}
          onCancel={actions.cancelChallenge}
          onConfirm={actions.confirmChallenge}
          onResponse={actions.changeChallengeResponse}
        />
      )}
      {execution.tag === 'dispatching' && (
        <p
          aria-live="polite"
          class="mt-3 text-sm text-zinc-700 dark:text-zinc-200"
          role="status"
        >
          Saving the pending Start marker before sending the request…
        </p>
      )}
      {execution.tag === 'dispatched' && (
        <p
          aria-live="polite"
          class="mt-3 text-amber-900 text-sm dark:text-amber-100"
          role="status"
        >
          Start returned {execution.status}. This state blocks another Start
          until status or recovery is reviewed.
        </p>
      )}
    </>
  );
}

interface ReviewField {
  label: string;
  mono?: boolean;
  value: unknown;
}

function dependencyLabel(dependency: Record<string, unknown> | null): string {
  if (!dependency) {
    return 'Not available';
  }
  if (dependency.version === 2) {
    return 'Setu setup receipt · dependency binding v2';
  }
  const parts = [
    dependency.bunVersion,
    dependency.linkerMode,
    dependency.platformNamespace,
  ].filter((part): part is string => typeof part === 'string');
  return parts.join(' · ') || 'Observed; details unavailable';
}

function toolLabel(value: unknown): string {
  if (Array.isArray(value)) {
    return value
      .filter((tool): tool is string => typeof tool === 'string')
      .join(', ');
  }
  return value === null ? 'No named tool list' : 'Not available';
}

function billingLabel(
  preview: Record<string, unknown> | null,
  mode: Record<string, unknown> | null,
  policy: Record<string, unknown> | null
): string {
  const cost = object(child(preview, 'cost'));
  const billing = cost?.billing ?? mode?.billing;
  if (billing === 'subscription' || policy?.subscriptionOnly === true) {
    return 'Subscription · provider usage estimate only; this panel reports no monetary amount or limit';
  }
  return fieldValue(billing);
}

function reviewLocationFields(
  review: SpansExecutionPreparedReview,
  spanTitle: string
): ReviewField[] {
  const { binding, preview } = review;
  const checkout = object(binding.checkout);
  const expected = object(checkout?.expected);
  const expectedIdentity = object(expected?.identity);
  const dependency = object(expected?.dependency);
  const dirty = object(expected?.dirty);
  const digests = object(binding.digests);
  const target = object(binding.target) ?? object(child(preview, 'target'));
  const reviewCheckout = object(preview?.checkout);
  const checkoutPath = checkout?.wtDir ?? expectedIdentity?.checkoutPath;
  const bindingDirtyCount = numberValue(dirty?.count);
  const dirtyCount =
    bindingDirtyCount ?? numberValue(reviewCheckout?.dirtyCount);
  return [
    { label: 'Span', value: `${spanTitle} · ${textValue(binding.spanId)}` },
    {
      label: 'Registered target',
      value: `${textValue(target?.repo)} / ${textValue(target?.name)}`,
    },
    { label: 'Canonical checkout', mono: true, value: checkoutPath },
    {
      label: 'HEAD',
      mono: true,
      value: expected?.head ?? reviewCheckout?.head,
    },
    {
      label: 'Working tree',
      value:
        dirtyCount === null
          ? 'Not observed'
          : `${dirtyCount} changed path${dirtyCount === 1 ? '' : 's'}`,
    },
    {
      label: 'Dirty tree digest',
      mono: true,
      value: dirty?.hash ?? digests?.dirty,
    },
    { label: 'Dependency identity', value: dependencyLabel(dependency) },
    { label: 'Dependency digest', mono: true, value: digests?.dependencies },
    ...(dependency?.version === 2
      ? [
          {
            label: 'Setup receipt digest',
            mono: true,
            value: dependency.receiptDigest,
          },
          {
            label: 'Dependency input digest',
            mono: true,
            value: dependency.inputDigest,
          },
        ]
      : [
          {
            label: 'Legacy lockfile digest',
            mono: true,
            value: dependency?.lockfileHash ?? digests?.lockfile,
          },
        ]),
    {
      label: 'Generation / plan version',
      value: `${binding.generation} / ${binding.planVersion}`,
    },
  ];
}

function reviewModeFields(review: SpansExecutionPreparedReview): ReviewField[] {
  const { binding, preview } = review;
  const mode = object(child(preview, 'mode'));
  const effort = object(mode?.effort);
  const profile = object(binding.profile);
  const policy = object(binding.policy);
  return [
    { label: 'Model', value: mode?.model ?? profile?.model },
    { label: 'Requested effort', value: effort?.requested ?? profile?.effort },
    {
      label: 'Probe-reported effort',
      value: effort?.observed ?? 'Not observed',
    },
    {
      label: 'Tool mode',
      value: `${fieldValue(mode?.permissionMode)} · ${toolLabel(mode?.tools)}`,
    },
    { label: 'Billing', value: billingLabel(preview, mode, policy) },
  ];
}

function reviewInputFields(
  review: SpansExecutionPreparedReview,
  input: SpansExecutionInput | null
): ReviewField[] {
  const acceptance = object(child(review.preview, 'acceptance'));
  let criteria: string[] = [];
  if (Array.isArray(acceptance?.criteria)) {
    criteria = acceptance.criteria.filter(
      (criterion): criterion is string => typeof criterion === 'string'
    );
  } else if (input) {
    ({ criteria } = input);
  }
  const previewTimeout = numberValue(review.preview?.wallClockMs);
  const timeout = previewTimeout ?? input?.wallClockMs;
  const minutes = timeout ? Math.ceil(timeout / 60_000) : null;
  return [
    {
      label: 'Acceptance criteria',
      value: criteria.length ? criteria.join('\n') : 'None supplied',
    },
    {
      label: 'Require a code change',
      value: acceptance?.requireChange ?? input?.requireChange,
    },
    {
      label: 'Timeout',
      value: minutes === null ? 'Not available' : `${minutes} minutes`,
    },
  ];
}

function reviewEvidenceFields(
  review: SpansExecutionPreparedReview
): ReviewField[] {
  const inputArtifact = object(review.binding.inputArtifact);
  return [
    { label: 'Retained input artifact', mono: true, value: inputArtifact?.id },
    { label: 'Review digest', mono: true, value: review.reviewDigest },
  ];
}

function reviewFields(
  review: SpansExecutionPreparedReview,
  spanTitle: string,
  input: SpansExecutionInput | null
): ReviewField[] {
  return [
    ...reviewLocationFields(review, spanTitle),
    ...reviewModeFields(review),
    ...reviewInputFields(review, input),
    ...reviewEvidenceFields(review),
  ];
}

function ExecutionReviewSummary({
  input,
  review,
  spanTitle,
}: {
  input: SpansExecutionInput | null;
  review: SpansExecutionPreparedReview;
  spanTitle: string;
}) {
  const evidence = object(review.binding.inputArtifact);
  const evidenceId = typeof evidence?.id === 'string' ? evidence.id : null;
  const [artifact, setArtifact] = useState<ArtifactEvidence | null>(null);
  const reading = useRef(false);
  const evidenceRequest = useRef(0);
  const fields = reviewFields(review, spanTitle, input);
  const advancedLabels = new Set([
    'Dirty tree digest',
    'Dependency identity',
    'Dependency digest',
    'Lockfile digest',
    'Generation / plan version',
    'Retained input artifact',
    'Review digest',
  ]);
  const advancedFields = fields.filter((field) =>
    advancedLabels.has(field.label)
  );
  const summaryFields = fields.filter(
    (field) => !advancedLabels.has(field.label)
  );

  useEffect(() => {
    evidenceRequest.current += 1;
    const request = evidenceRequest.current;
    setArtifact(null);
    reading.current = false;
    return () => {
      if (evidenceRequest.current === request) {
        evidenceRequest.current += 1;
      }
    };
  }, [review.binding.runId, review.reviewDigest, evidenceId]);

  const readEvidence = async () => {
    if (!evidenceId || reading.current || artifact) {
      return;
    }
    reading.current = true;
    evidenceRequest.current += 1;
    const request = evidenceRequest.current;
    try {
      const result = await readSpansArtifact({
        artifactId: evidenceId,
        runId: review.binding.runId as string,
      });
      if (evidenceRequest.current === request) {
        setArtifact(
          result.ok ? { kind: 'loaded', text: result.text } : { kind: 'error' }
        );
      }
    } catch {
      if (evidenceRequest.current === request) {
        setArtifact({ kind: 'error' });
      }
    } finally {
      if (evidenceRequest.current === request) {
        reading.current = false;
      }
    }
  };

  return (
    <section
      aria-labelledby="spans-execution-review-title"
      class="mt-5 min-w-0 border-zinc-200 border-y py-4 dark:border-white/10"
    >
      <h3
        class="font-semibold text-sm text-zinc-900 dark:text-zinc-100"
        id="spans-execution-review-title"
      >
        Immutable execution review
      </h3>
      <p class="mt-1 max-w-3xl text-sm text-zinc-600 dark:text-zinc-300">
        Setu observed this checkout and saved the exact bounded input. The
        review digest names those observations; it is not approval or permission
        to start.
      </p>
      <dl class="mt-3 grid min-w-0 gap-x-6 sm:grid-cols-2">
        {summaryFields.map((field) => (
          <SummaryField
            key={field.label}
            label={field.label}
            mono={'mono' in field ? field.mono : false}
            value={field.value}
          />
        ))}
      </dl>
      <details class="mt-2 min-w-0 border-zinc-200 border-t pt-2 dark:border-white/10">
        <summary class="min-h-11 cursor-pointer py-2 font-medium text-sm text-zinc-800 dark:text-zinc-100">
          Checkout, dependency, and review digests
        </summary>
        <dl class="grid min-w-0 gap-x-6 sm:grid-cols-2">
          {advancedFields.map((field) => (
            <SummaryField
              key={field.label}
              label={field.label}
              mono={'mono' in field ? field.mono : false}
              value={field.value}
            />
          ))}
        </dl>
      </details>
      <details
        class="mt-2 min-w-0 border-zinc-200 border-t pt-2 dark:border-white/10"
        onToggle={(event) => {
          if (event.currentTarget.open) {
            readEvidence();
          }
        }}
      >
        <summary class="min-h-11 cursor-pointer py-2 font-medium text-sm text-zinc-800 dark:text-zinc-100">
          Read the retained execution input
        </summary>
        {artifact?.kind === 'error' && (
          <p class="py-2 text-signal-red text-sm" role="alert">
            The retained input could not be read here. The immutable review is
            still recorded, but its input was not verified in this view.
          </p>
        )}
        {artifact?.kind === 'loaded' && (
          <pre class="min-w-0 whitespace-pre-wrap break-words py-2 font-mono text-xs text-zinc-800 dark:text-zinc-100">
            {artifact.text}
          </pre>
        )}
        {!artifact && evidenceId && (
          <p
            aria-live="polite"
            class="py-2 text-sm text-zinc-600 dark:text-zinc-300"
          >
            Opening the retained artifact…
          </p>
        )}
        {!(artifact || evidenceId) && (
          <p class="py-2 text-signal-red text-sm" role="alert">
            The retained input identity is unavailable.
          </p>
        )}
      </details>
    </section>
  );
}

function statusForReview(
  status: SpansExecutionStatus | null,
  recovery: SpansExecutionRecovery | null
) {
  return status && recovery
    ? findSpansExecutionAttempt(status, recovery)
    : null;
}

function statusAttemptBinding(
  status: SpansExecutionStatus,
  runId: string,
  item: Record<string, unknown>
): SpansExecutionAttemptBinding | null {
  const { actionId, attemptId, spanId } = item;
  return typeof actionId === 'string' &&
    typeof attemptId === 'string' &&
    typeof spanId === 'string'
    ? findLiveSpansExecutionAttempt(status, runId, {
        actionId,
        attemptId,
        spanId,
      })
    : null;
}

function recoveryStopDetails(
  status: SpansExecutionStatus | null,
  recovery: SpansExecutionRecovery | null,
  matchedStatus: ReturnType<typeof statusForReview>
): { binding: SpansExecutionAttemptBinding | null; live: boolean } {
  const live = Boolean(
    matchedStatus &&
      ['launching', 'running', 'finalizing'].includes(matchedStatus.attempt)
  );
  const binding =
    status && recovery?.actionId && recovery.attemptId
      ? findLiveSpansExecutionAttempt(status, recovery.runId, {
          actionId: recovery.actionId,
          attemptId: recovery.attemptId,
          spanId: recovery.spanId,
        })
      : null;
  return { binding, live };
}

function cancelStateForAttempt(
  binding: SpansExecutionAttemptBinding,
  recovery: SpansExecutionRecovery | null
): SpansExecutionCancelState | null {
  const storedRecovery = readSpansExecutionRecovery(
    browserStorage(),
    binding.runId
  );
  const currentRecovery =
    storedRecovery.kind === 'saved' ? storedRecovery.value : recovery;
  if (
    currentRecovery?.runId === binding.runId &&
    currentRecovery.actionId === binding.actionId &&
    currentRecovery.attemptId === binding.attemptId &&
    currentRecovery.spanId === binding.spanId &&
    currentRecovery.status?.startsWith('cancel-')
  ) {
    const state = currentRecovery.status.slice('cancel-'.length);
    if (
      state === 'requested' ||
      state === 'delivered' ||
      state === 'unknown' ||
      state === 'refused' ||
      state === 'terminal'
    ) {
      return state;
    }
  }
  const saved = readSpansExecutionCancelRecovery(
    browserStorage(),
    binding.runId,
    binding.attemptId
  );
  return saved.kind === 'saved' &&
    sameSpansExecutionAttemptBinding(saved.value.binding, binding)
    ? saved.value.state
    : null;
}

function cancelStatusMessage(
  state: SpansExecutionCancelState | null,
  busy: boolean
): string | null {
  if (state === 'requested') {
    return busy
      ? 'Stop requested. Waiting for the delivery response.'
      : 'A stop request was pending when this view last closed. Its outcome is unknown; check status before requesting another stop.';
  }
  if (state === 'delivered') {
    return 'Stop delivery was confirmed. This does not confirm that the attempt exited or released its resources.';
  }
  if (state === 'unknown') {
    return 'Stop outcome is unknown. Check status; another stop requires a fresh confirmation that this exact attempt is still live.';
  }
  if (state === 'refused') {
    return 'Setu refused the stop. Check status before requesting another stop.';
  }
  if (state === 'terminal') {
    return 'Setu returned an existing exit receipt. Read current status to inspect the outcome; this does not accept the work.';
  }
  return null;
}

function cancelOperationNotice(
  result: SpansExecutionCancelOperationResult
): ExecutionNotice {
  switch (result.kind) {
    case 'success':
      if (result.value.terminal) {
        return {
          kind: result.recoverySaved ? 'status' : 'error',
          text: 'Setu returned an existing exit receipt. No stop was sent; reading current status does not accept the work.',
        };
      }
      return {
        kind: result.recoverySaved ? 'status' : 'error',
        text: result.recoverySaved
          ? 'Stop delivery was confirmed. This does not confirm exit or resource release; current status is being read.'
          : 'Stop delivery was confirmed, but its recovery update could not be saved. Current status is being read.',
      };
    case 'unknown':
      return {
        kind: 'error',
        text: result.recoverySaved
          ? 'Stop outcome is unknown. No automatic repeat was sent; current status is being read.'
          : 'Stop outcome is unknown and its recovery update could not be saved. Current status is being read.',
      };
    case 'refused':
      return {
        kind: 'error',
        text: 'Setu refused the stop. Current status is being read before another request can be made.',
      };
    case 'recovery-unavailable':
      return {
        kind: 'error',
        text: 'Stop was not sent because its recovery state could not be saved.',
      };
    case 'busy':
      return {
        kind: 'error',
        text: 'Another execution request is in flight. Stop was not sent.',
      };
    case 'stale':
      return {
        kind: 'error',
        text: 'The run changed before the stop could be sent.',
      };
    default:
      return {
        kind: 'error',
        text: 'The stop outcome could not be classified. Check current status.',
      };
  }
}

function executionCancelEligible(
  record: SpansRecord,
  stale: boolean,
  recovery: SpansExecutionRecoveryRead
): boolean {
  return (
    !(stale || spansExecutionOperationInFlight(record.runId)) &&
    spansExecutionRecordIsEligible(record) &&
    recovery.kind !== 'corrupt' &&
    recovery.kind !== 'unavailable'
  );
}

function ExecutionCancelControl({
  binding,
  busy,
  cancelAttempt,
  enabled,
  state,
}: {
  binding: SpansExecutionAttemptBinding | null;
  busy: boolean;
  cancelAttempt: (binding: SpansExecutionAttemptBinding) => void;
  enabled: boolean;
  state: SpansExecutionCancelState | null;
}) {
  const message = cancelStatusMessage(state, busy);
  let label = 'Stop attempt';
  if (busy) {
    label = 'Sending stop…';
  } else if (state) {
    label = 'Request stop again';
  }
  return (
    <div class="mt-2 flex min-w-0 flex-wrap items-center gap-2">
      <Button
        class="min-h-11"
        disabled={!(binding && enabled) || busy}
        onClick={() => binding && cancelAttempt(binding)}
        variant="secondary"
      >
        {label}
      </Button>
      {!binding && (
        <span class="text-sm text-zinc-600 dark:text-zinc-300">
          An exact running attempt is unavailable in this status snapshot.
        </span>
      )}
      {message && (
        <span
          aria-live="polite"
          class="max-w-3xl text-amber-900 text-sm dark:text-amber-100"
          role="status"
        >
          {message}
        </span>
      )}
    </div>
  );
}

function ignoreAsync(promise: Promise<unknown>) {
  promise.catch(() => undefined);
}

function recoveryValue(
  recovery: SpansExecutionRecoveryRead
): SpansExecutionRecovery | null {
  return recovery.kind === 'saved' ? recovery.value : null;
}

function recoveryStateFor(
  marker: SpansExecutionRecovery
): SpansExecutionRecoveryRead {
  return { kind: 'saved', value: marker };
}

function getCapabilities(
  resource: PanelState['capabilities']
): SpansExecutionCapabilities | null {
  if (resource.tag === 'ready') {
    return resource.value;
  }
  if (resource.tag === 'probing') {
    return resource.value ?? null;
  }
  return null;
}

function profileLaunchIsAllowed(
  capabilities: SpansExecutionCapabilities | null
): boolean {
  if (capabilities === null) {
    return false;
  }
  return capabilities.launch.allowed;
}

function getStatus(
  resource: PanelState['status']
): SpansExecutionStatus | null {
  if (resource.tag === 'ready' || resource.tag === 'reconciling') {
    return resource.value ?? null;
  }
  return null;
}

function makeRecovery(
  input: SpansExecutionInput,
  stage: SpansExecutionRecoveryStage,
  extra: Partial<SpansExecutionRecovery> = {}
): SpansExecutionRecovery {
  return {
    runId: input.runId,
    spanId: input.spanId,
    stage,
    target: input.target,
    updatedAt: new Date().toISOString(),
    ...extra,
  };
}

function formFromInput(
  input: SpansExecutionInput,
  targets: RegisteredSpansTarget[]
): ExecutionForm | null {
  const target = targets.find(
    (item) => item.repo === input.target.repo && item.name === input.target.name
  );
  if (!target || input.wallClockMs % 60_000 !== 0) {
    return null;
  }
  return {
    criteria: input.criteria.join('\n'),
    instructions: input.instructions,
    requireChange: input.requireChange,
    spanId: input.spanId,
    targetKey: target.key,
    timeoutMinutes: String(input.wallClockMs / 60_000),
  };
}

function inputFor(
  form: ExecutionForm,
  record: SpansRecord,
  targets: RegisteredSpansTarget[]
): { error: string | null; input: SpansExecutionInput | null } {
  const choices = spansExecutionSpanChoices(record);
  const span = choices.find((item) => item.spanId === form.spanId);
  const target = targets.find((item) => item.key === form.targetKey);
  if (!(span && target)) {
    return { error: 'Choose a span and a registered checkout.', input: null };
  }
  const parsed = parseSpansExecutionCriteria(form.criteria);
  if (parsed.error) {
    return { error: parsed.error, input: null };
  }
  const minutes = Number(form.timeoutMinutes);
  if (
    !Number.isInteger(minutes) ||
    minutes < 1 ||
    minutes > SPANS_EXECUTION_MAX_MINUTES
  ) {
    return {
      error: 'Enter a whole number of minutes from 1 to 60.',
      input: null,
    };
  }
  const input: SpansExecutionInput = {
    criteria: parsed.criteria,
    instructions: form.instructions,
    profile: SPANS_EXECUTION_PROFILE,
    requireChange: form.requireChange,
    runId: record.runId,
    spanId: span.spanId,
    target: { name: target.name, repo: target.repo },
    wallClockMs: minutes * 60_000,
  };
  const error = validSpansExecutionRequest(input, record, choices, targets);
  return { error, input: error ? null : input };
}

function reviewMatchesTarget(
  review: SpansExecutionPreparedReview,
  input: SpansExecutionInput,
  record: SpansRecord,
  targets: RegisteredSpansTarget[]
): boolean {
  const target = targets.find(
    (item) => item.repo === input.target.repo && item.name === input.target.name
  );
  const { binding } = review;
  const checkout = object(binding.checkout);
  const expected = object(checkout?.expected);
  const identity = object(expected?.identity);
  const path = checkout?.wtDir ?? identity?.checkoutPath;
  return Boolean(
    target &&
      target.repo === input.target.repo &&
      target.name === input.target.name &&
      path === target.wtDir &&
      binding.runId === record.runId &&
      binding.spanId === input.spanId &&
      binding.generation === record.generation &&
      binding.planVersion === record.view.planVersion
  );
}

function recoveryMatchesReview(
  marker: SpansExecutionRecovery,
  review: SpansExecutionPreparedReview,
  input: SpansExecutionInput
): boolean {
  return Boolean(
    marker.runId === input.runId &&
      marker.spanId === input.spanId &&
      marker.target.repo === input.target.repo &&
      marker.target.name === input.target.name &&
      marker.reviewDigest === review.reviewDigest &&
      marker.actionId === review.binding.actionId &&
      marker.attemptId === review.binding.attemptId &&
      marker.confirmation
  );
}

async function loadReviewedRecovery(
  marker: SpansExecutionRecovery,
  targets: RegisteredSpansTarget[],
  record: SpansRecord
): Promise<{ form: ExecutionForm; prepared: ReviewedExecution }> {
  if (!marker.reviewDigest) {
    throw new Error('The saved review digest is unavailable.');
  }
  const target = targets.find(
    (item) =>
      item.repo === marker.target.repo && item.name === marker.target.name
  );
  if (!target) {
    throw new Error('The reviewed checkout is no longer registered.');
  }
  const saved = await readSpansExecutionSavedReview(
    marker.runId,
    marker.reviewDigest,
    target.wtDir
  );
  const artifactIdentity = object(saved.binding.inputArtifact);
  if (!artifactIdentity || typeof artifactIdentity.id !== 'string') {
    throw new Error('Saved execution evidence is unavailable.');
  }
  const artifact = await readSpansArtifact({
    artifactId: artifactIdentity.id,
    runId: marker.runId,
  });
  const input = artifact.ok
    ? decodeRetainedSpansExecutionInput(artifact.text, saved.binding)
    : null;
  if (!input) {
    throw new Error('The saved review does not match this run and checkout.');
  }
  if (!recoveryMatchesReview(marker, saved, input)) {
    throw new Error('The saved review does not match this run and checkout.');
  }
  if (!reviewMatchesTarget(saved, input, record, targets)) {
    throw new Error('The saved review does not match this run and checkout.');
  }
  const form = formFromInput(input, targets);
  if (!form) {
    throw new Error('The retained input cannot be represented by this form.');
  }
  return {
    form,
    prepared: {
      input,
      review: { ...saved, confirmation: marker.confirmation ?? '' },
    },
  };
}

function recoveredReviewNotice(
  marker: SpansExecutionRecovery
): ExecutionNotice {
  let text =
    'The immutable saved review and exact retained input were read back.';
  if (marker.stage === 'approval-unknown') {
    text =
      'The immutable review and input were read back. The earlier approval outcome remains unknown; a fresh typed challenge is required.';
  } else if (marker.stage === 'revocation-unknown') {
    text =
      'The immutable review and input were read back. The earlier revocation outcome remains unknown; use a fresh typed challenge to confirm revocation.';
  }
  return { kind: 'status', text };
}

type ConfirmationReply =
  | Awaited<ReturnType<typeof approveSpansExecution>>
  | Awaited<ReturnType<typeof revokeSpansExecution>>;
type SettledOperation<T> = Extract<
  SpansExecutionOperationResult<T>,
  { current: boolean }
>;
type RecoveryIdentity = Required<
  Pick<
    SpansExecutionRecovery,
    'actionId' | 'attemptId' | 'confirmation' | 'reviewDigest'
  >
>;

function currentOperationResult<T>(
  result: SpansExecutionOperationResult<T>
): result is SettledOperation<T> {
  return 'current' in result && result.current;
}

function hasErrorCode(error: unknown, code: string): boolean {
  return error instanceof Error && 'code' in error && error.code === code;
}

function confirmationOutcome(
  result: SettledOperation<ConfirmationReply>,
  confirming: ExecutionState,
  intent: 'approve' | 'revoke',
  input: SpansExecutionInput,
  identity: RecoveryIdentity
): { execution: ExecutionState; notice: ExecutionNotice } {
  if (result.kind === 'success' && result.recoverySaved) {
    const text = confirmationSuccessText(intent, result.value.replayed);
    const marker = makeRecovery(
      input,
      confirmationStages(intent).success,
      identity
    );
    return {
      execution: settleExecutionConfirmation(
        confirming,
        intent,
        'success',
        recoveryStateFor(marker)
      ),
      notice: { kind: 'status', text },
    };
  }
  if (result.kind === 'refused' && result.recoverySaved) {
    const marker = confirmationRefusalRecovery(
      intent,
      result.error,
      input,
      identity
    );
    const revoked = marker.stage === 'revoked';
    return {
      execution: settleExecutionConfirmation(
        confirming,
        intent,
        revoked ? 'revoked' : 'refused',
        recoveryStateFor(marker)
      ),
      notice: {
        kind: 'error',
        text: spansExecutionErrorMessage(
          result.error,
          'Setu refused this confirmation.'
        ),
      },
    };
  }
  const stage = confirmationStages(intent).unknown;
  const operationName = confirmationOperationName(intent);
  return {
    execution: settleExecutionConfirmation(
      confirming,
      intent,
      'unknown',
      recoveryStateFor(makeRecovery(input, stage, identity))
    ),
    notice: {
      kind: 'error',
      text: `${operationName} outcome unknown. Read the saved review before requesting another challenge.`,
    },
  };
}

function confirmationSuccessText(
  intent: 'approve' | 'revoke',
  replayed: boolean
): string {
  if (intent === 'approve') {
    return replayed
      ? 'The saved approval response was confirmed again. This action did not start a worker.'
      : 'Approval response received. This action did not start a worker.';
  }
  return replayed
    ? 'This review was already revoked.'
    : 'Approval revoked. Starting is disabled for this review.';
}

function confirmationOperationName(intent: 'approve' | 'revoke'): string {
  return intent === 'approve' ? 'Approval' : 'Revocation';
}

function confirmationStages(intent: 'approve' | 'revoke') {
  if (intent === 'approve') {
    return {
      pending: 'approval-pending' as const,
      success: 'approved' as const,
      unknown: 'approval-unknown' as const,
    };
  }
  return {
    pending: 'revocation-pending' as const,
    success: 'revoked' as const,
    unknown: 'revocation-unknown' as const,
  };
}

function confirmationRefusalRecovery(
  intent: 'approve' | 'revoke',
  error: unknown,
  input: SpansExecutionInput,
  identity: RecoveryIdentity
): SpansExecutionRecovery {
  if (hasErrorCode(error, 'SPANS_EXECUTION_REVIEW_REVOKED')) {
    return makeRecovery(input, 'revoked', identity);
  }
  return makeRecovery(
    input,
    intent === 'approve' ? 'prepared' : 'approved',
    identity
  );
}

async function sendTypedChallenge(
  challenge: ChallengeState
): Promise<ConfirmationReply> {
  const input = {
    confirmation: {
      challengeId: challenge.challenge.challengeId,
      response: challenge.response,
    },
    reviewDigest: challenge.challenge.reviewDigest,
    runId: challenge.challenge.runId,
  };
  if (challenge.challenge.intent === 'approve') {
    return await approveSpansExecution(input);
  }
  return await revokeSpansExecution(input);
}

function confirmableChallenge(
  challenge: ChallengeState | null,
  prepared: ReviewedExecution | null,
  busy: boolean,
  runId: string
): {
  challenge: ChallengeState;
  input: SpansExecutionInput;
  prepared: ReviewedExecution;
} | null {
  if (!challenge) {
    return null;
  }
  if (!prepared) {
    return null;
  }
  if (!prepared.input || busy) {
    return null;
  }
  if (
    challenge.challenge.runId !== runId ||
    challenge.challenge.reviewDigest !== prepared.review.reviewDigest
  ) {
    return null;
  }
  return { challenge, input: prepared.input, prepared };
}

function dispatchOutcome(
  result: SettledOperation<SpansExecutionDispatchResult>,
  prepared: ReviewedExecution,
  input: SpansExecutionInput,
  identity: RecoveryIdentity
): {
  execution: ExecutionState;
  notice: ExecutionNotice;
  refreshStatus: boolean;
} {
  if (result.kind === 'success' && result.recoverySaved) {
    const { status } = result.value;
    let text = `Start returned ${status}. Keep this attempt blocked while its status is reconciled.`;
    if (status === 'duplicate') {
      text =
        'Setu returned the existing attempt. Completion still needs captured evidence and the existing human acceptance path.';
    } else if (status === 'launched') {
      text =
        'Worker launched. This does not mark the span complete; inspect captured evidence and use the existing acceptance path.';
    }
    const marker = makeRecovery(input, 'dispatched', { ...identity, status });
    return {
      execution: {
        prepared,
        recovery: recoveryStateFor(marker),
        status,
        tag: 'dispatched',
      },
      notice: { kind: 'status', text },
      refreshStatus: true,
    };
  }
  if (result.kind === 'refused' && result.recoverySaved) {
    const revoked = hasErrorCode(
      result.error,
      'SPANS_EXECUTION_REVIEW_REVOKED'
    );
    const stage = revoked ? 'revoked' : 'approved';
    const execution: ExecutionState = revoked
      ? {
          prepared,
          recovery: recoveryStateFor(makeRecovery(input, stage, identity)),
          tag: 'revoked',
        }
      : {
          approvalObservation: 'recovered',
          prepared,
          recovery: recoveryStateFor(makeRecovery(input, stage, identity)),
          tag: 'approved',
        };
    return {
      execution,
      notice: {
        kind: 'error',
        text: spansExecutionErrorMessage(
          result.error,
          'Setu refused to start this review.'
        ),
      },
      refreshStatus: false,
    };
  }
  return {
    execution: {
      operation: 'dispatch',
      prepared,
      recovery: recoveryStateFor(
        makeRecovery(input, 'dispatch-unknown', identity)
      ),
      tag: 'unknown',
    },
    notice: {
      kind: 'error',
      text: 'Start outcome is unknown. Do not send Start again; check status or explicitly reconcile the run.',
    },
    refreshStatus: false,
  };
}

function dispatchRefusalRecovery(
  error: unknown,
  input: SpansExecutionInput,
  identity: RecoveryIdentity
): SpansExecutionRecovery {
  const stage = hasErrorCode(error, 'SPANS_EXECUTION_REVIEW_REVOKED')
    ? 'revoked'
    : 'approved';
  return makeRecovery(input, stage, identity);
}

function approvedDispatchContext(
  execution: ExecutionState,
  mayDispatch: boolean,
  recovery: SpansExecutionRecovery | null
): {
  identity: RecoveryIdentity;
  input: SpansExecutionInput;
  prepared: ReviewedExecution;
} | null {
  if (execution.tag !== 'approved' || !mayDispatch || !recovery) {
    return null;
  }
  const { prepared } = execution;
  const { input } = prepared;
  if (!input) {
    return null;
  }
  return {
    identity: {
      actionId: String(prepared.review.binding.actionId),
      attemptId: String(prepared.review.binding.attemptId),
      confirmation: prepared.review.confirmation,
      reviewDigest: prepared.review.reviewDigest,
    },
    input,
    prepared,
  };
}

function dispatchUnavailableOutcome(
  kind: 'busy' | 'recovery-unavailable',
  priorRecovery: SpansExecutionRecoveryRead,
  prepared: ReviewedExecution
): { execution: ExecutionState; notice: ExecutionNotice } {
  const storageUnavailable = kind === 'recovery-unavailable';
  return {
    execution: {
      operation: 'dispatch',
      prepared,
      recovery: storageUnavailable ? { kind: 'unavailable' } : priorRecovery,
      tag: 'unknown',
    },
    notice: {
      kind: 'error',
      text: storageUnavailable
        ? 'Session recovery could not be written. Setu did not send Start.'
        : 'Another execution action is still in flight.',
    },
  };
}

function canReconcileExecution(
  recovery: SpansExecutionRecovery | null,
  recoveryIssue: string | null
): boolean {
  if (recovery) {
    if (
      recovery.stage === 'probe-pending' ||
      recovery.stage === 'probe-unknown'
    ) {
      return false;
    }
    return hasUnresolvedSpansExecutionOutcome(recovery.stage);
  }
  return Boolean(recoveryIssue);
}

function executionPermissions(
  panel: PanelState,
  record: SpansRecord,
  stale: boolean
): ExecutionPermissions {
  const { execution } = panel;
  const progress = selectExecutionProgress(execution);
  const recovery = recoveryValue(execution.recovery);
  const recoveryIssue = recoveryDescription(execution.recovery);
  const unresolved =
    recovery !== null && hasUnresolvedSpansExecutionOutcome(recovery.stage);
  const storageReady =
    execution.recovery.kind === 'empty' || execution.recovery.kind === 'saved';
  const targets = panel.targets.tag === 'ready' ? panel.targets.value : [];
  const capabilities = getCapabilities(panel.capabilities);
  const selectedSpanId = progress.prepared?.input?.spanId || panel.form.spanId;
  const profileLaunchAllowed = profileLaunchIsAllowed(capabilities);
  const markerStage = recovery?.stage;
  const reviewAlreadySaved =
    markerStage === 'prepared' ||
    markerStage === 'approved' ||
    markerStage === 'revoked';
  const candidate = inputFor(panel.form, record, targets).input;
  const eligibleRecord = spansExecutionRecordIsEligible(record);
  const reviewIsCurrent = reviewMatchesCurrentInput(
    progress.prepared,
    candidate,
    record,
    targets
  );
  const busy =
    progress.busy ||
    panel.capabilities.tag === 'probing' ||
    panel.status.tag === 'reconciling' ||
    spansExecutionOperationInFlight(record.runId);
  const canSelectProbeScope = Boolean(
    markerStage === 'probe-unknown' && !busy && !stale && storageReady
  );
  const recoveryBlocked = Boolean(recoveryIssue || unresolved);
  const canEdit = Boolean(!(recoveryBlocked || busy || stale) && storageReady);
  const canReviewCandidate = Boolean(
    eligibleRecord &&
      !recoveryBlocked &&
      !reviewAlreadySaved &&
      !busy &&
      !stale &&
      profileLaunchAllowed &&
      targets.length > 0 &&
      spansExecutionSpanChoices(record).length > 0
  );
  const { canApprove, canRevoke } = executionRecoveryPermissions(
    execution,
    reviewIsCurrent,
    busy,
    stale,
    eligibleRecord
  );
  const canDispatchCandidate = Boolean(
    execution.tag === 'approved' &&
      progress.prepared?.input &&
      hasReceiptDependencyBinding(progress.prepared.review) &&
      recovery?.stage === 'approved' &&
      recovery.confirmation &&
      recovery.reviewDigest === progress.prepared.review.reviewDigest &&
      reviewIsCurrent &&
      profileLaunchAllowed &&
      storageReady &&
      !unresolved &&
      !stale &&
      !busy
  );
  const preparedActionId = progress.prepared
    ? progress.prepared.review.binding.actionId
    : undefined;
  const protectedActions = protectedExecutionPermissions(
    panel.status,
    {
      generation: record.generation,
      runId: record.runId,
      scopeKey: executionScopeKey(
        record.runId,
        record.generation,
        record.view.planVersion
      ),
    },
    selectedSpanId,
    { canPrepare: canReviewCandidate, canStart: canDispatchCandidate },
    typeof preparedActionId === 'string' ? preparedActionId : undefined
  );
  return {
    busy,
    canApprove,
    canDispatch: protectedActions.canStart,
    canEdit,
    canReconcile: canReconcileExecution(recovery, recoveryIssue),
    canReview: protectedActions.canPrepare,
    canRevoke,
    canSelectProbeScope,
    recoveryBlocked: Boolean(recoveryIssue || unresolved),
    reviewIsCurrent,
  };
}

function recoveryDescription(
  recovery: SpansExecutionRecoveryRead
): string | null {
  if (recovery.kind === 'corrupt') {
    return 'Saved recovery data is corrupt. Execution stays blocked; inspect the run and browser session before continuing.';
  }
  if (recovery.kind === 'unavailable') {
    return 'Session recovery storage is unavailable. Mutating execution actions stay blocked.';
  }
  return null;
}

interface PanelScope {
  form: ExecutionForm;
  record: SpansRecord;
  scopeKey: string;
  targets: RegisteredSpansTarget[];
}

type PanelStateUpdate = PanelState | ((current: PanelState) => PanelState);
type PanelStateSetter = (update: PanelStateUpdate) => void;

async function readExecutionStatus(
  scopeKey: string,
  runId: string,
  scopeRef: { current: PanelScope },
  mountedRef: { current: boolean },
  panelRef: { current: PanelState },
  setPanel: PanelStateSetter,
  onRefresh: () => void
): Promise<void> {
  if (
    executionScopeIsCurrent(
      scopeKey,
      scopeRef.current.scopeKey,
      mountedRef.current
    )
  ) {
    setPanel((current) =>
      transitionExecutionInScope(
        scopeKey,
        scopeRef.current.scopeKey,
        mountedRef.current,
        current,
        (state) => ({ ...state, status: { tag: 'loading' } })
      )
    );
  }
  try {
    const next = await readSpansExecutionStatus(runId);
    if (
      !executionScopeIsCurrent(
        scopeKey,
        scopeRef.current.scopeKey,
        mountedRef.current
      )
    ) {
      return;
    }
    setPanel((current) =>
      transitionExecutionInScope(
        scopeKey,
        scopeRef.current.scopeKey,
        mountedRef.current,
        current,
        (state) => ({
          ...state,
          status: { runId, scopeKey, tag: 'ready', value: next },
        })
      )
    );
    const savedRecovery = recoveryValue(panelRef.current.execution.recovery);
    const currentRecovery =
      savedRecovery?.runId === runId ? savedRecovery : null;
    const found = currentRecovery
      ? findSpansExecutionAttempt(next, currentRecovery)
      : null;
    const accepted = Boolean(
      currentRecovery &&
        hasUnresolvedSpansExecutionOutcome(currentRecovery.stage) &&
        found?.acceptance === 'accepted'
    );
    if (accepted && clearSpansExecutionRecovery(browserStorage(), runId)) {
      setPanel((current) =>
        transitionExecutionInScope(
          scopeKey,
          scopeRef.current.scopeKey,
          mountedRef.current,
          current,
          (state) => ({
            ...state,
            execution: { recovery: { kind: 'empty' }, tag: 'idle' },
            notice: {
              kind: 'status',
              text: 'The existing human acceptance path recorded this result. Refreshing the run summary.',
            },
          })
        )
      );
      onRefresh();
    }
  } catch (error) {
    if (
      executionScopeIsCurrent(
        scopeKey,
        scopeRef.current.scopeKey,
        mountedRef.current
      )
    ) {
      setPanel((current) =>
        transitionExecutionInScope(
          scopeKey,
          scopeRef.current.scopeKey,
          mountedRef.current,
          current,
          (state) => ({
            ...state,
            status: {
              error: spansExecutionErrorMessage(
                error,
                'Execution status could not be read.'
              ),
              tag: 'error',
            },
          })
        )
      );
    }
  }
}

function scopeHasInput(scope: PanelScope, input: SpansExecutionInput): boolean {
  const current = inputFor(scope.form, scope.record, scope.targets).input;
  return (
    scope.record.runId === input.runId &&
    sameSpansExecutionInput(current, input)
  );
}

function reviewMatchesCurrentInput(
  prepared: ReviewedExecution | null,
  candidate: SpansExecutionInput | null,
  record: SpansRecord,
  targets: RegisteredSpansTarget[]
): boolean {
  return Boolean(
    prepared?.input &&
      prepared.review.binding.runId === record.runId &&
      prepared.review.binding.generation === record.generation &&
      prepared.review.binding.planVersion === record.view.planVersion &&
      sameSpansExecutionInput(candidate, prepared.input) &&
      reviewMatchesTarget(prepared.review, prepared.input, record, targets)
  );
}

function statusDescriptionFor(
  status: SpansExecutionStatus | null
): string | null {
  if (status === null) {
    return 'Execution status has not been confirmed.';
  }
  if (status.executions.length === 0) {
    return 'No attempts appear in this status snapshot. A missing attempt alone does not resolve a pending request.';
  }
  return null;
}

function profileDescriptionFor(
  capabilities: SpansExecutionCapabilities | null
): string {
  if (capabilities && capabilities.launch.allowed === true) {
    return 'Local probe allows this profile for review.';
  }
  if (capabilities?.reason) {
    return `Profile is unavailable for launch · ${capabilities.reason}`;
  }
  return 'Profile capability is not verified.';
}

function settledProfileProbeState(
  result: SettledOperation<boolean>,
  prior: SpansExecutionCapabilities | undefined,
  unknown: SpansExecutionRecovery
): Pick<PanelState, 'capabilities' | 'execution' | 'notice'> {
  if (result.kind === 'success') {
    return {
      capabilities: {
        ...(prior ? { value: prior } : {}),
        error:
          'The provider returned, but session recovery could not be cleared.',
        tag: 'error',
      },
      execution: {
        operation: 'provider probe recovery',
        recovery: recoveryStateFor(unknown),
        tag: 'unknown',
      },
      notice: {
        kind: 'error',
        text: 'The provider confirmed the probe, but its pending recovery marker could not be cleared. Keep another probe blocked until a fresh attempt is explicitly reviewed.',
      },
    };
  }
  if (result.kind === 'refused' && result.recoverySaved) {
    return {
      capabilities: prior
        ? { tag: 'ready', value: prior }
        : {
            error: spansExecutionErrorMessage(
              result.error,
              'Setu refused the provider probe.'
            ),
            tag: 'error',
          },
      execution: { recovery: { kind: 'empty' }, tag: 'idle' },
      notice: {
        kind: 'error',
        text: spansExecutionErrorMessage(
          result.error,
          'Setu refused the provider probe. No retry was sent.'
        ),
      },
    };
  }
  const probeRecovery = result.recoverySaved
    ? recoveryStateFor(unknown)
    : { kind: 'unavailable' as const };
  return {
    capabilities: {
      ...(prior ? { value: prior } : {}),
      error: spansExecutionErrorMessage(
        result.error,
        'The provider probe could not be confirmed.'
      ),
      tag: 'error',
    },
    execution: {
      operation: 'provider probe',
      recovery: probeRecovery,
      tag: 'unknown',
    },
    notice: {
      kind: 'error',
      text: 'Probe outcome is unknown. The server exposes no operation identity, so current capability status cannot prove whether this exact request succeeded. Do not retry automatically; a fresh probe may repeat provider quota use.',
    },
  };
}

function selectedProfileProbeContext(
  record: SpansRecord,
  form: ExecutionForm,
  selectedTarget: RegisteredSpansTarget | undefined
): {
  runId: string;
  spanId: string;
  target: { name: string; repo: string };
  targetKey: string;
} | null {
  const span = spansExecutionSpanChoices(record).find(
    (choice) => choice.spanId === form.spanId
  );
  if (!(span && selectedTarget)) {
    return null;
  }
  return {
    runId: record.runId,
    spanId: span.spanId,
    target: { name: selectedTarget.name, repo: selectedTarget.repo },
    targetKey: selectedTarget.key,
  };
}

function providerProfileStateFor(
  panel: PanelState,
  permissions: ExecutionPermissions,
  stale: boolean,
  spanChoices: ReturnType<typeof spansExecutionSpanChoices>,
  targets: RegisteredSpansTarget[]
): ProviderProfileState {
  const capabilities = getCapabilities(panel.capabilities);
  const recovery = recoveryValue(panel.execution.recovery);
  const probeUnknown = recovery?.stage === 'probe-unknown';
  const probeContextSelected = Boolean(
    spanChoices.some((span) => span.spanId === panel.form.spanId) &&
      targets.some((target) => target.key === panel.form.targetKey)
  );
  const capabilityUnavailable = capabilities?.reason === 'PROFILE_UNKNOWN';
  return {
    busy: permissions.busy,
    canVerify: Boolean(
      canStartProfileProbe(panel.execution.recovery) &&
        probeContextSelected &&
        !permissions.busy &&
        !stale
    ),
    canVerifyFresh: Boolean(
      probeUnknown &&
        canStartProfileProbe(panel.execution.recovery, true) &&
        probeContextSelected &&
        !permissions.busy &&
        !stale
    ),
    capabilities,
    capabilityBusy: panel.capabilities.tag === 'probing',
    capabilityError:
      panel.capabilities.tag === 'error' ? panel.capabilities.error : null,
    capabilityUnavailable,
    observedEffort: object(child(capabilities?.observations, 'effort')),
    probeBlockedByRecovery: Boolean(
      panel.execution.recovery.kind === 'saved' && !probeUnknown
    ),
    probeContextSelected,
    probeUnknown,
    profileDescription:
      probeUnknown &&
      capabilities !== null &&
      capabilities.launch.allowed === true
        ? 'Current capability allows this profile for review; it does not identify the earlier probe.'
        : profileDescriptionFor(capabilities),
    stale,
  };
}

interface ExecutionPermissions {
  busy: boolean;
  canApprove: boolean;
  canDispatch: boolean;
  canEdit: boolean;
  canReconcile: boolean;
  canReview: boolean;
  canRevoke: boolean;
  canSelectProbeScope: boolean;
  recoveryBlocked: boolean;
  reviewIsCurrent: boolean;
}

interface ExecutionPanelActions {
  cancelAttempt: (binding: SpansExecutionAttemptBinding) => void;
  cancelChallenge: (intent: 'approve' | 'revoke') => void;
  changeChallengeResponse: (value: string) => void;
  checkStatus: () => void;
  confirmChallenge: () => void;
  discardPreview: () => void;
  dispatch: () => void;
  editForm: (update: (current: ExecutionForm) => ExecutionForm) => void;
  formErrorRef: (element: HTMLParagraphElement | null) => void;
  formInvalid: () => void;
  preview: (event: SubmitEvent) => void;
  readSavedReview: () => void;
  reconcile: () => void;
  refresh: () => void;
  requestApproval: () => void;
  requestRevocation: () => void;
  saveReview: () => void;
  verifyFreshProfile: () => void;
  verifyProfile: () => void;
}

function ExecutionPanelContent({
  actions,
  id,
  panel,
  permissions,
  record,
  stale,
}: {
  actions: ExecutionPanelActions;
  id: string;
  panel: PanelState;
  permissions: ExecutionPermissions;
  record: SpansRecord;
  stale: boolean;
}) {
  const { execution } = panel;
  const progress = selectExecutionProgress(execution);
  const { prepared, preview } = progress;
  const eligibleRecord = spansExecutionRecordIsEligible(record);
  const spanChoices = spansExecutionSpanChoices(record);
  const targets = panel.targets.tag === 'ready' ? panel.targets.value : [];
  const recovery = recoveryValue(execution.recovery);
  const preparedReadback = Boolean(prepared?.input);
  const matchedStatus = statusForReview(getStatus(panel.status), recovery);
  const reviewedSpan = prepared
    ? spanChoices.find((span) => span.spanId === prepared.review.binding.spanId)
    : undefined;
  const recoveredSpan = recovery
    ? spanChoices.find((span) => span.spanId === recovery.spanId)
    : undefined;
  const selectedTitle =
    reviewedSpan?.title ?? recoveredSpan?.title ?? 'Saved span';
  const status = getStatus(panel.status);
  const statusError = panel.status.tag === 'error' ? panel.status.error : null;
  const statusBusy =
    panel.status.tag === 'loading' ||
    panel.status.tag === 'reconciling' ||
    panel.cancellingAttemptId !== null;
  const { busy, recoveryBlocked } = permissions;
  const profileState = providerProfileStateFor(
    panel,
    permissions,
    stale,
    spanChoices,
    targets
  );
  const recoveryIssue = recoveryDescription(execution.recovery);
  const statusDescription = statusDescriptionFor(status);
  if (!eligibleRecord) {
    return (
      <section
        aria-labelledby={`${id}-title`}
        class="mx-auto min-w-0 max-w-4xl px-4 py-5 sm:px-6"
      >
        <h2
          class="font-semibold text-base text-zinc-900 dark:text-zinc-100"
          id={`${id}-title`}
        >
          Operate a planned span
        </h2>
        <p class="mt-2 max-w-2xl text-sm text-zinc-600 dark:text-zinc-300">
          This run is imported, read-only, or completed. Execution controls are
          unavailable.
        </p>
      </section>
    );
  }

  return (
    <section
      aria-labelledby={`${id}-title`}
      class="mx-auto min-w-0 max-w-4xl px-4 py-5 sm:px-6"
    >
      <header class="mb-5 min-w-0">
        <h2
          class="font-semibold text-base text-zinc-900 dark:text-zinc-100"
          id={`${id}-title`}
        >
          Operate a planned span
        </h2>
        <p class="mt-1 max-w-3xl text-sm text-zinc-600 dark:text-zinc-300">
          Review the exact instruction, checkout, provider settings, and timeout
          before saving approval. Approval and Start are separate actions.
        </p>
        <p class="mt-2 text-xs text-zinc-600 dark:text-zinc-300">
          Current plan: generation {record.generation} · plan version{' '}
          {fieldValue(record.view.planVersion, 'not recorded')}
        </p>
      </header>

      {stale && (
        <div class="mb-4 border-amber-700/30 border-y py-3 text-amber-900 text-sm dark:border-amber-300/30 dark:text-amber-100">
          This run view may be stale. Refresh it before preparing or starting a
          review.
          <Button
            class="mt-2 min-h-11"
            onClick={actions.refresh}
            variant="secondary"
          >
            Refresh run and execution status
          </Button>
        </div>
      )}

      <ProviderProfileSection
        actions={{
          verify: actions.verifyProfile,
          verifyFresh: actions.verifyFreshProfile,
        }}
        id={id}
        state={profileState}
      />

      {recoveryIssue && (
        <p class="mt-4 text-signal-red text-sm" role="alert">
          {recoveryIssue}
        </p>
      )}

      {recoveryBlocked && !profileState.probeUnknown && (
        <RecoverySection
          actions={actions}
          id={id}
          permissions={permissions}
          state={{
            busy,
            canCancel: executionCancelEligible(
              record,
              stale,
              execution.recovery
            ),
            cancelAttempt: actions.cancelAttempt,
            cancellingAttemptId: panel.cancellingAttemptId,
            execution,
            matchedStatus,
            preparedReadback,
            reconciling: panel.status.tag === 'reconciling',
            recovery,
            status,
            statusBusy,
            statusError,
            targetsAvailable: targets.length > 0,
          }}
        />
      )}

      {(!recoveryBlocked || permissions.canSelectProbeScope) && (
        <>
          <ExecutionRequestForm
            actions={actions}
            id={id}
            permissions={permissions}
            spanChoices={spanChoices}
            state={{
              execution,
              form: panel.form,
              formError: panel.formError,
              targets: panel.targets,
            }}
          />
          {preview && (
            <ExecutionPreviewSection
              actions={{
                discard: actions.discardPreview,
                save: actions.saveReview,
              }}
              id={id}
              state={{
                busy,
                execution,
                mayReview: permissions.canReview,
                preview,
              }}
            />
          )}
        </>
      )}

      {prepared && (
        <PreparedExecutionSection
          actions={actions}
          id={id}
          permissions={permissions}
          state={{
            busy,
            execution,
            prepared,
            recoveryBlocked,
            reviewIsCurrent: permissions.reviewIsCurrent,
            selectedTitle,
          }}
        />
      )}

      {!recoveryBlocked && (
        <ExecutionStatusSection
          actions={{
            cancelAttempt: actions.cancelAttempt,
            check: actions.checkStatus,
            refresh: actions.refresh,
          }}
          id={id}
          state={{
            busy,
            canCancel: executionCancelEligible(
              record,
              stale,
              execution.recovery
            ),
            cancelAttempt: actions.cancelAttempt,
            cancellingAttemptId: panel.cancellingAttemptId,
            recovery,
            runId: record.runId,
            status,
            statusBusy,
            statusDescription,
            statusError,
          }}
        />
      )}

      {panel.notice && (
        <p
          aria-live={panel.notice.kind === 'error' ? 'assertive' : 'polite'}
          class={
            panel.notice.kind === 'error'
              ? 'mt-4 text-signal-red text-sm'
              : 'mt-4 text-sm text-zinc-700 dark:text-zinc-200'
          }
          role={panel.notice.kind === 'error' ? 'alert' : 'status'}
        >
          {panel.notice.text}
        </p>
      )}
    </section>
  );
}

export function SpansExecutionPanel({
  onRefresh,
  record,
  stale,
}: {
  onRefresh: () => void;
  record: SpansRecord;
  stale: boolean;
}) {
  const id = useId();
  const currentScopeKey = executionScopeKey(
    record.runId,
    record.generation,
    record.view.planVersion
  );
  const [panel, setPanel] = useState<PanelState>(() => ({
    cancellingAttemptId: null,
    capabilities: { tag: 'loading' },
    execution: initialExecutionForRecovery(
      readSpansExecutionRecovery(browserStorage(), record.runId)
    ),
    form: initialForm(),
    formError: null,
    notice: null,
    status: { tag: 'loading' },
    targets: { tag: 'loading' },
  }));
  const panelRef = useRef(panel);
  panelRef.current = panel;
  const scopeRef = useRef<PanelScope>({
    form: panel.form,
    record,
    scopeKey: currentScopeKey,
    targets: panel.targets.tag === 'ready' ? panel.targets.value : [],
  });
  scopeRef.current = {
    form: panel.form,
    record,
    scopeKey: currentScopeKey,
    targets: panel.targets.tag === 'ready' ? panel.targets.value : [],
  };
  const mountedRef = useRef(false);
  const staleRef = useRef(stale);
  staleRef.current = stale;
  const errorRef = useRef<HTMLParagraphElement | null>(null);
  const targets = panel.targets.tag === 'ready' ? panel.targets.value : [];
  const selectedTarget = targets.find(
    (target) => target.key === panel.form.targetKey
  );
  const { execution } = panel;
  const recovery = recoveryValue(execution.recovery);
  const { challenge, prepared } = selectExecutionProgress(execution);
  const capabilities = getCapabilities(panel.capabilities);
  const status = getStatus(panel.status);
  const permissions = executionPermissions(panel, record, stale);
  const { busy } = permissions;

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    if (!panel.formError) {
      return;
    }
    errorRef.current?.focus();
  }, [panel.formError]);

  function setPanelInScope(
    scopeKey: string,
    transition: (current: PanelState) => PanelState
  ) {
    setPanel((current) =>
      transitionExecutionInScope(
        scopeKey,
        scopeRef.current.scopeKey,
        mountedRef.current,
        current,
        transition
      )
    );
  }

  async function readStatus(scopeKey: string, runId: string) {
    await readExecutionStatus(
      scopeKey,
      runId,
      scopeRef,
      mountedRef,
      panelRef,
      setPanel,
      onRefresh
    );
  }

  async function readSavedReview(
    scopeKey: string,
    marker: SpansExecutionRecovery,
    registeredTargets: RegisteredSpansTarget[],
    scopedRecord: SpansRecord
  ) {
    if (!marker.reviewDigest) {
      return;
    }
    setPanel((current) => ({
      ...current,
      execution: {
        marker,
        recovery: recoveryStateFor(marker),
        tag: 'reading-review',
      },
    }));
    try {
      const restored = await loadReviewedRecovery(
        marker,
        registeredTargets,
        scopedRecord
      );
      if (
        !executionScopeIsCurrent(
          scopeKey,
          scopeRef.current.scopeKey,
          mountedRef.current
        )
      ) {
        return;
      }
      setPanel((current) =>
        transitionExecutionInScope(
          scopeKey,
          scopeRef.current.scopeKey,
          mountedRef.current,
          current,
          (state) => ({
            ...state,
            execution: recoveredExecutionState(marker, restored.prepared),
            form: restored.form,
            notice: recoveredReviewNotice(marker),
          })
        )
      );
    } catch {
      if (
        executionScopeIsCurrent(
          scopeKey,
          scopeRef.current.scopeKey,
          mountedRef.current
        )
      ) {
        setPanel((current) =>
          transitionExecutionInScope(
            scopeKey,
            scopeRef.current.scopeKey,
            mountedRef.current,
            current,
            (state) => ({
              ...state,
              execution: {
                operation: 'saved review readback',
                prepared: undefined,
                recovery: recoveryStateFor(marker),
                tag: 'unknown',
              },
              notice: {
                kind: 'error',
                text: 'The saved review or its exact retained input could not be verified. Do not resend the earlier mutation.',
              },
            })
          )
        );
      }
    }
  }

  async function loadRunContext(
    scopeKey: string,
    signal: AbortSignal,
    scopedRecovery: SpansExecutionRecoveryRead,
    scopedRecord: SpansRecord
  ) {
    const [targetResult, capabilityResult] = await Promise.allSettled([
      readRegisteredSpansTargets(signal),
      readSpansExecutionCapabilities(SPANS_EXECUTION_PROFILE, signal),
    ]);
    if (
      !executionScopeIsCurrent(
        scopeKey,
        scopeRef.current.scopeKey,
        mountedRef.current
      )
    ) {
      return;
    }
    const marker = recoveryValue(scopedRecovery);
    let loadedTargets: RegisteredSpansTarget[] = [];
    if (targetResult.status === 'fulfilled') {
      loadedTargets = targetResult.value;
      const isProbeRecovery =
        marker?.stage === 'probe-unknown' || marker?.stage === 'probe-pending';
      const recoveredTarget = isProbeRecovery
        ? loadedTargets.find(
            (target) =>
              target.repo === marker.target.repo &&
              target.name === marker.target.name
          )
        : undefined;
      const recoveredSpan = isProbeRecovery
        ? spansExecutionSpanChoices(scopedRecord).find(
            (span) => span.spanId === marker.spanId
          )
        : undefined;
      setPanel((current) =>
        transitionExecutionInScope(
          scopeKey,
          scopeRef.current.scopeKey,
          mountedRef.current,
          current,
          (state) => ({
            ...state,
            form: {
              ...state.form,
              spanId: isProbeRecovery
                ? (recoveredSpan?.spanId ?? '')
                : state.form.spanId,
              targetKey: isProbeRecovery
                ? (recoveredTarget?.key ?? '')
                : state.form.targetKey || loadedTargets[0]?.key || '',
            },
            targets: { tag: 'ready', value: loadedTargets },
          })
        )
      );
    } else {
      setPanel((current) =>
        transitionExecutionInScope(
          scopeKey,
          scopeRef.current.scopeKey,
          mountedRef.current,
          current,
          (state) => ({
            ...state,
            targets: {
              error: spansExecutionErrorMessage(
                targetResult.reason,
                'Registered worktrees could not be loaded.'
              ),
              tag: 'error',
            },
          })
        )
      );
    }
    if (capabilityResult.status === 'fulfilled') {
      setPanel((current) =>
        transitionExecutionInScope(
          scopeKey,
          scopeRef.current.scopeKey,
          mountedRef.current,
          current,
          (state) => ({
            ...state,
            capabilities: { tag: 'ready', value: capabilityResult.value },
          })
        )
      );
    } else {
      setPanel((current) =>
        transitionExecutionInScope(
          scopeKey,
          scopeRef.current.scopeKey,
          mountedRef.current,
          current,
          (state) => ({
            ...state,
            capabilities: {
              error: spansExecutionErrorMessage(
                capabilityResult.reason,
                'Provider capability status could not be read.'
              ),
              tag: 'error',
            },
          })
        )
      );
    }
    if (
      targetResult.status === 'fulfilled' &&
      marker?.reviewDigest &&
      executionScopeIsCurrent(
        scopeKey,
        scopeRef.current.scopeKey,
        mountedRef.current
      )
    ) {
      await readSavedReview(scopeKey, marker, loadedTargets, scopedRecord);
    }
  }

  useEffect(() => {
    const scopeKey = currentScopeKey;
    const controller = new AbortController();
    const savedRecovery = readSpansExecutionRecovery(
      browserStorage(),
      record.runId
    );
    const initialExecution = initialExecutionForRecovery(savedRecovery);
    setPanel({
      cancellingAttemptId: null,
      capabilities: { tag: 'loading' },
      execution: initialExecution,
      form: initialForm(),
      formError: null,
      notice: null,
      status: { tag: 'loading' },
      targets: { tag: 'loading' },
    });
    ignoreAsync(
      loadRunContext(scopeKey, controller.signal, savedRecovery, record)
    );
    ignoreAsync(readStatus(scopeKey, record.runId));
    return () => {
      controller.abort();
    };
  }, [currentScopeKey, record.runId]);

  function operationIsCurrent(
    scopeKey: string,
    input?: SpansExecutionInput,
    review?: SpansExecutionPreparedReview
  ): boolean {
    const latest = scopeRef.current;
    if (
      !executionScopeIsCurrent(scopeKey, latest.scopeKey, mountedRef.current)
    ) {
      return false;
    }
    if (input && !scopeHasInput(latest, input)) {
      return false;
    }
    if (review && input) {
      return reviewMatchesTarget(review, input, latest.record, latest.targets);
    }
    return true;
  }

  function canStopInScope(
    scopeKey: string,
    binding: SpansExecutionAttemptBinding,
    allowOwnPending = false,
    checkInFlight = true
  ): boolean {
    const currentAttempt = panelRef.current.cancellingAttemptId;
    return (
      operationIsCurrent(scopeKey) &&
      !staleRef.current &&
      spansExecutionRecordIsEligible(scopeRef.current.record) &&
      panelRef.current.status.tag !== 'loading' &&
      panelRef.current.status.tag !== 'reconciling' &&
      !selectExecutionProgress(panelRef.current.execution).busy &&
      (currentAttempt === null ||
        (allowOwnPending && currentAttempt === binding.attemptId)) &&
      !(checkInFlight && spansExecutionOperationInFlight(binding.runId))
    );
  }

  async function freshStatusForStop(
    runId: string
  ): Promise<SpansExecutionStatus | null> {
    try {
      return await readSpansExecutionStatus(runId);
    } catch {
      return null;
    }
  }

  function finishStop(
    scopeKey: string,
    notice: ExecutionNotice,
    statusResource?: ExecutionStatusResource
  ) {
    setPanelInScope(scopeKey, (current) => ({
      ...current,
      cancellingAttemptId: null,
      notice,
      ...(statusResource ? { status: statusResource } : {}),
    }));
  }

  async function stopAttempt(binding: SpansExecutionAttemptBinding) {
    const scopeKey = currentScopeKey;
    if (!canStopInScope(scopeKey, binding)) {
      return;
    }
    setPanelInScope(scopeKey, (current) => ({
      ...current,
      cancellingAttemptId: binding.attemptId,
      notice: null,
    }));

    const freshStatus = await freshStatusForStop(binding.runId);
    if (!operationIsCurrent(scopeKey)) {
      return;
    }
    if (!freshStatus) {
      finishStop(
        scopeKey,
        {
          kind: 'error',
          text: 'Current attempt status could not be read. No stop was sent.',
        },
        { error: 'Execution status could not be read.', tag: 'error' }
      );
      return;
    }
    setPanelInScope(scopeKey, (current) => ({
      ...current,
      status: {
        runId: binding.runId,
        scopeKey,
        tag: 'ready',
        value: freshStatus,
      },
    }));
    const confirmed = findLiveSpansExecutionAttempt(
      freshStatus,
      binding.runId,
      binding
    );
    if (
      !(
        confirmed &&
        sameSpansExecutionAttemptBinding(confirmed, binding) &&
        canStopInScope(scopeKey, binding, true)
      )
    ) {
      finishStop(scopeKey, {
        kind: 'status',
        text: 'This exact attempt is no longer recorded as running in fresh status. No stop was sent.',
      });
      return;
    }

    const result = await runSpansExecutionCancelOperation({
      binding: confirmed,
      current: () => canStopInScope(scopeKey, binding, true, false),
      persist: (state) =>
        persistSpansExecutionCancelState(browserStorage(), confirmed, state),
      request: () => cancelSpansExecutionAttempt(confirmed),
      runId: confirmed.runId,
    });
    if (
      !operationIsCurrent(scopeKey) ||
      ('current' in result && !result.current)
    ) {
      return;
    }
    finishStop(scopeKey, cancelOperationNotice(result));
    await readStatus(scopeKey, binding.runId);
  }

  function updateExecution(
    nextExecution: ExecutionState,
    notice?: ExecutionNotice | null
  ) {
    setPanel((current) => ({
      ...current,
      execution: nextExecution,
      ...(notice === undefined ? {} : { notice }),
    }));
  }

  function makeInput(): SpansExecutionInput | null {
    const result = inputFor(panel.form, record, targets);
    setPanel((current) => ({ ...current, formError: result.error }));
    return result.input;
  }

  function editForm(update: (current: ExecutionForm) => ExecutionForm) {
    const currentRecovery = recoveryValue(panel.execution.recovery);
    if (
      permissions.canSelectProbeScope &&
      currentRecovery?.stage === 'probe-unknown'
    ) {
      const next = update(panel.form);
      if (
        next.spanId !== panel.form.spanId ||
        next.targetKey !== panel.form.targetKey
      ) {
        setPanel((current) => ({
          ...current,
          form: {
            ...current.form,
            spanId: next.spanId,
            targetKey: next.targetKey,
          },
          formError: null,
          notice: null,
        }));
      }
      return;
    }
    if (!permissions.canEdit) {
      return;
    }
    if (
      currentRecovery &&
      hasUnresolvedSpansExecutionOutcome(currentRecovery.stage)
    ) {
      return;
    }
    if (
      currentRecovery &&
      !clearSpansExecutionRecovery(browserStorage(), record.runId)
    ) {
      updateExecution(
        {
          operation: 'clear recovery before editing',
          recovery: { kind: 'unavailable' },
          tag: 'unknown',
        },
        {
          kind: 'error',
          text: 'Recovery state could not be cleared. Keep this run blocked and inspect the saved review before editing.',
        }
      );
      return;
    }
    updateExecution(resetExecutionAfterInputEdit(panel.execution), null);
    setPanel((current) => ({
      ...current,
      form: update(current.form),
      formError: null,
      notice: null,
    }));
  }

  async function previewExecution(event: SubmitEvent) {
    event.preventDefault();
    if (!permissions.canReview || busy) {
      return;
    }
    const input = makeInput();
    if (!input) {
      return;
    }
    const scopeKey = currentScopeKey;
    updateExecution(
      { recovery: panel.execution.recovery, tag: 'previewing' },
      null
    );
    try {
      const result = await reviewSpansExecution(input);
      if (!operationIsCurrent(scopeKey, input)) {
        return;
      }
      updateExecution(
        {
          preview: { input, review: result },
          recovery: panel.execution.recovery,
          tag: 'preview',
        },
        {
          kind: 'status',
          text: 'Read-only preview loaded. It has not been saved or approved.',
        }
      );
    } catch (error) {
      if (operationIsCurrent(scopeKey, input)) {
        updateExecution(
          { recovery: panel.execution.recovery, tag: 'idle' },
          {
            kind: 'error',
            text: spansExecutionErrorMessage(
              error,
              'The read-only review could not be loaded.'
            ),
          }
        );
      }
    }
  }

  async function saveImmutableReview() {
    if (execution.tag !== 'preview' || !permissions.canReview || busy) {
      return;
    }
    const { input } = execution.preview;
    const scopeKey = currentScopeKey;
    const pending = makeRecovery(input, 'prepare-pending');
    updateExecution(
      {
        input,
        recovery: recoveryStateFor(pending),
        tag: 'preparing',
      },
      { kind: 'status', text: 'Saving the immutable review…' }
    );
    const result = await runSpansExecutionOperation({
      completed: (review) =>
        makeRecovery(input, 'prepared', {
          actionId: String(review.binding.actionId),
          attemptId: String(review.binding.attemptId),
          confirmation: review.confirmation,
          reviewDigest: review.reviewDigest,
        }),
      current: () => operationIsCurrent(scopeKey, input),
      pending,
      refused: () => null,
      request: () => prepareSpansExecution(input, selectedTarget?.wtDir),
      runId: input.runId,
      storage: browserStorage(),
      unknown: makeRecovery(input, 'prepare-unknown'),
    });
    if (result.kind === 'busy') {
      updateExecution(
        {
          preview: execution.preview,
          recovery: panel.execution.recovery,
          tag: 'preview',
        },
        { kind: 'status', text: 'Another execution action is still in flight.' }
      );
      return;
    }
    if (result.kind === 'recovery-unavailable') {
      updateExecution(
        {
          operation: 'prepare',
          recovery: { kind: 'unavailable' },
          tag: 'unknown',
        },
        {
          kind: 'error',
          text: 'Session recovery could not be written. Setu did not send Prepare.',
        }
      );
      return;
    }
    if (!currentOperationResult(result)) {
      return;
    }
    if (result.kind === 'success' && result.recoverySaved) {
      const marker = makeRecovery(input, 'prepared', {
        actionId: String(result.value.binding.actionId),
        attemptId: String(result.value.binding.attemptId),
        confirmation: result.value.confirmation,
        reviewDigest: result.value.reviewDigest,
      });
      updateExecution(
        {
          prepared: { input, review: result.value },
          readback: true,
          recovery: recoveryStateFor(marker),
          tag: 'prepared',
        },
        {
          kind: 'status',
          text: 'Immutable review saved. Approval is separate and has not started the span.',
        }
      );
      return;
    }
    if (result.kind === 'refused' && result.recoverySaved) {
      updateExecution(
        {
          preview: execution.preview,
          recovery: { kind: 'empty' },
          tag: 'preview',
        },
        {
          kind: 'error',
          text: spansExecutionErrorMessage(
            result.error,
            'Setu refused to save this review.'
          ),
        }
      );
      return;
    }
    const marker = makeRecovery(input, 'prepare-unknown');
    updateExecution(
      {
        operation: 'prepare',
        recovery: recoveryStateFor(marker),
        tag: 'unknown',
      },
      {
        kind: 'error',
        text: 'Prepare outcome is unknown. Do not send it again; inspect run evidence and execution status.',
      }
    );
  }

  async function finishProfileProbe(
    result: SpansExecutionOperationResult<boolean>,
    scopeKey: string,
    context: NonNullable<ReturnType<typeof selectedProfileProbeContext>>,
    prior: SpansExecutionCapabilities | undefined,
    unknown: SpansExecutionRecovery
  ) {
    if (result.kind === 'busy') {
      setPanelInScope(scopeKey, (current) => ({
        ...current,
        capabilities: prior
          ? { tag: 'ready', value: prior }
          : {
              error: 'Another execution action is still in flight.',
              tag: 'error',
            },
        notice: {
          kind: 'error',
          text: 'Another execution action is still in flight.',
        },
      }));
      return;
    }
    if (result.kind === 'recovery-unavailable') {
      setPanelInScope(scopeKey, (current) => ({
        ...current,
        capabilities: prior
          ? { tag: 'ready', value: prior }
          : {
              error: 'Session recovery storage is unavailable.',
              tag: 'error',
            },
        execution: {
          operation: 'provider probe recovery',
          recovery:
            panel.execution.recovery.kind === 'saved'
              ? panel.execution.recovery
              : { kind: 'unavailable' },
          tag: 'unknown',
        },
        notice: {
          kind: 'error',
          text: 'Session recovery could not be written. Setu did not send the provider probe.',
        },
      }));
      return;
    }
    if (!currentOperationResult(result)) {
      return;
    }
    const isCurrentProbe = () =>
      operationIsCurrent(scopeKey) &&
      scopeRef.current.form.spanId === context.spanId &&
      scopeRef.current.form.targetKey === context.targetKey;
    if (result.kind === 'success' && result.recoverySaved) {
      setPanelInScope(scopeKey, (current) => ({
        ...current,
        capabilities: {
          tag: 'probing',
          ...(prior ? { value: prior } : {}),
        },
        execution: { recovery: { kind: 'empty' }, tag: 'idle' },
        notice: {
          kind: 'status',
          text: 'The provider confirmed the probe request. Reading current profile capability…',
        },
      }));
      try {
        const next = await readSpansExecutionCapabilities(
          SPANS_EXECUTION_PROFILE
        );
        if (!isCurrentProbe()) {
          return;
        }
        setPanelInScope(scopeKey, (current) => ({
          ...current,
          capabilities: { tag: 'ready', value: next },
          notice: {
            kind: 'status',
            text: 'Provider probe returned. Review its observed details below.',
          },
        }));
      } catch (error) {
        if (!isCurrentProbe()) {
          return;
        }
        setPanelInScope(scopeKey, (current) => ({
          ...current,
          capabilities: {
            ...(prior ? { value: prior } : {}),
            error: spansExecutionErrorMessage(
              error,
              'Current provider capability could not be read.'
            ),
            tag: 'error',
          },
          notice: {
            kind: 'error',
            text: 'The provider confirmed the probe request, but current capability details could not be read.',
          },
        }));
      }
      return;
    }
    const settled = settledProfileProbeState(result, prior, unknown);
    setPanelInScope(scopeKey, (current) => ({ ...current, ...settled }));
  }

  async function verifyProfile(freshAttempt: boolean) {
    if (
      panel.capabilities.tag === 'probing' ||
      busy ||
      stale ||
      (!freshAttempt && capabilities?.reason === 'PROFILE_UNKNOWN') ||
      !canStartProfileProbe(panel.execution.recovery, freshAttempt) ||
      spansExecutionOperationInFlight(record.runId)
    ) {
      return;
    }
    const context = selectedProfileProbeContext(
      record,
      panel.form,
      selectedTarget
    );
    if (!context) {
      setPanel((current) => ({
        ...current,
        notice: {
          kind: 'error',
          text: 'Choose a planned span and registered checkout before probing so session recovery has real context. This does not send or start the span.',
        },
      }));
      return;
    }
    const scopeKey = currentScopeKey;
    const prior = capabilities ?? undefined;
    const pending = makeProfileProbeRecovery(context, 'probe-pending');
    const unknown = makeProfileProbeRecovery(context, 'probe-unknown');
    const storage = browserStorage();
    setPanel((current) => ({
      ...current,
      capabilities: { tag: 'probing', ...(prior ? { value: prior } : {}) },
      notice: {
        kind: 'status',
        text: freshAttempt
          ? 'Starting the explicitly requested fresh provider probe. It may repeat provider quota use and does not start the selected span.'
          : 'Starting one small provider probe. It uses provider quota and does not start the selected span.',
      },
    }));
    const result = await runSpansExecutionOperation({
      completed: () => null,
      current: () =>
        operationIsCurrent(scopeKey) &&
        scopeRef.current.form.spanId === context.spanId &&
        scopeRef.current.form.targetKey === context.targetKey,
      pending,
      refused: () => null,
      request: async () => {
        await probeSpansExecutionProfile(SPANS_EXECUTION_PROFILE);
        return true;
      },
      runId: record.runId,
      storage,
      unknown,
    });
    await finishProfileProbe(result, scopeKey, context, prior, unknown);
  }

  async function requestChallenge(intent: 'approve' | 'revoke') {
    const currentPrepared = prepared;
    const input = currentPrepared?.input;
    if (!(currentPrepared && input && recovery)) {
      return;
    }
    if (
      intent === 'approve' ? !permissions.canApprove : !permissions.canRevoke
    ) {
      return;
    }
    const scopeKey = currentScopeKey;
    const identity: RecoveryIdentity = {
      actionId: String(currentPrepared.review.binding.actionId),
      attemptId: String(currentPrepared.review.binding.attemptId),
      confirmation: currentPrepared.review.confirmation,
      reviewDigest: currentPrepared.review.reviewDigest,
    };
    const pending = makeRecovery(input, 'challenge-pending', identity);
    const settled = makeRecovery(input, 'prepared', identity);
    updateExecution(
      {
        intent,
        prepared: currentPrepared,
        recovery: recoveryStateFor(pending),
        tag: 'requesting-challenge',
      },
      null
    );
    const result = await runSpansExecutionOperation({
      completed: () => settled,
      current: () =>
        operationIsCurrent(scopeKey, input, currentPrepared.review),
      pending,
      refused: () => settled,
      request: () =>
        issueSpansExecutionChallenge({
          intent,
          reviewDigest: currentPrepared.review.reviewDigest,
          runId: record.runId,
        }),
      runId: record.runId,
      storage: browserStorage(),
      unknown: settled,
    });
    if (result.kind === 'busy') {
      updateExecution(
        {
          prepared: currentPrepared,
          readback: true,
          recovery: panel.execution.recovery,
          tag: 'prepared',
        },
        {
          kind: 'error',
          text: 'Another execution action is still in flight.',
        }
      );
      return;
    }
    if (result.kind === 'recovery-unavailable') {
      updateExecution(
        {
          prepared: currentPrepared,
          readback: true,
          recovery: { kind: 'unavailable' },
          tag: 'prepared',
        },
        {
          kind: 'error',
          text: 'Session recovery could not be written. Setu did not issue the confirmation challenge.',
        }
      );
      return;
    }
    if (!currentOperationResult(result)) {
      return;
    }
    if (result.kind === 'success' && result.recoverySaved) {
      setPanelInScope(scopeKey, (current) => ({
        ...current,
        execution: {
          challenge: { challenge: result.value, response: '' },
          prepared: currentPrepared,
          recovery: recoveryStateFor(settled),
          tag: 'challenge',
        },
        notice: {
          kind: 'status',
          text:
            intent === 'approve'
              ? 'Type the exact phrase to save approval. Approval will not start the span.'
              : 'Type the exact phrase to revoke approval.',
        },
      }));
      return;
    }
    if (result.kind === 'success') {
      setPanelInScope(scopeKey, (current) => ({
        ...current,
        execution: {
          prepared: currentPrepared,
          readback: true,
          recovery: { kind: 'unavailable' },
          tag: 'prepared',
        },
        notice: {
          kind: 'error',
          text: 'The challenge response returned, but its recovery state could not be saved. The typed phrase is unavailable in this view.',
        },
      }));
      return;
    }
    setPanelInScope(scopeKey, (current) => ({
      ...current,
      execution: {
        prepared: currentPrepared,
        readback: true,
        recovery: result.recoverySaved
          ? recoveryStateFor(settled)
          : { kind: 'unavailable' },
        tag: 'prepared',
      },
      notice: {
        kind: 'error',
        text:
          result.kind === 'refused'
            ? spansExecutionErrorMessage(
                result.error,
                'Setu refused to issue the confirmation challenge.'
              )
            : 'Challenge outcome is unknown. It did not approve or start the span. No typed response was retained; request another challenge only as a deliberate action.',
      },
    }));
  }

  async function confirmChallenge() {
    const current = confirmableChallenge(
      challenge,
      prepared,
      busy,
      record.runId
    );
    if (!current) {
      return;
    }
    const {
      challenge: currentChallenge,
      input,
      prepared: currentPrepared,
    } = current;
    if (currentChallenge.response !== currentChallenge.challenge.phrase) {
      setPanel((state) => ({
        ...state,
        notice: {
          kind: 'error',
          text: 'Type the confirmation phrase exactly as shown.',
        },
      }));
      return;
    }
    const scopeKey = currentScopeKey;
    const { intent } = currentChallenge.challenge;
    const identity: RecoveryIdentity = {
      actionId: String(currentPrepared.review.binding.actionId),
      attemptId: String(currentPrepared.review.binding.attemptId),
      confirmation: currentPrepared.review.confirmation,
      reviewDigest: currentPrepared.review.reviewDigest,
    };
    const stages = confirmationStages(intent);
    const pending = makeRecovery(input, stages.pending, identity);
    const confirming: ExecutionState = {
      challenge: currentChallenge,
      prepared: currentPrepared,
      recovery: recoveryStateFor(pending),
      tag: 'confirming',
    };
    updateExecution(confirming, null);
    const result = await runSpansExecutionOperation({
      completed: () => makeRecovery(input, stages.success, identity),
      current: () =>
        operationIsCurrent(scopeKey, input, currentPrepared.review),
      pending,
      refused: (error) =>
        confirmationRefusalRecovery(intent, error, input, identity),
      request: () => sendTypedChallenge(currentChallenge),
      runId: record.runId,
      storage: browserStorage(),
      unknown: makeRecovery(input, stages.unknown, identity),
    });
    if (result.kind === 'busy' || result.kind === 'recovery-unavailable') {
      const didNotSend = result.kind === 'recovery-unavailable';
      updateExecution(
        {
          operation: intent,
          prepared: currentPrepared,
          recovery: didNotSend
            ? { kind: 'unavailable' }
            : panel.execution.recovery,
          tag: 'unknown',
        },
        {
          kind: 'error',
          text: didNotSend
            ? 'Session recovery could not be saved. Setu did not send the confirmation.'
            : 'Another execution action is still in flight.',
        }
      );
      return;
    }
    if (!currentOperationResult(result)) {
      return;
    }
    const outcome = confirmationOutcome(
      result,
      confirming,
      intent,
      input,
      identity
    );
    updateExecution(outcome.execution, outcome.notice);
  }

  async function startApprovedSpan() {
    const dispatchContext = approvedDispatchContext(
      execution,
      permissions.canDispatch,
      recovery
    );
    if (!dispatchContext) {
      return;
    }
    const { identity, input, prepared: preparedReview } = dispatchContext;
    const scopeKey = currentScopeKey;
    const pending = makeRecovery(input, 'dispatch-pending', identity);
    updateExecution(
      {
        prepared: preparedReview,
        recovery: recoveryStateFor(pending),
        tag: 'dispatching',
      },
      { kind: 'status', text: 'Starting the reviewed span…' }
    );
    const result = await runSpansExecutionOperation({
      completed: (dispatch) =>
        makeRecovery(input, 'dispatched', {
          ...identity,
          status: dispatch.status,
        }),
      current: () => operationIsCurrent(scopeKey, input, preparedReview.review),
      pending,
      refused: (error) => dispatchRefusalRecovery(error, input, identity),
      request: () =>
        dispatchSpansExecution(
          input,
          { actionId: identity.actionId, attemptId: identity.attemptId },
          identity.confirmation,
          identity.reviewDigest
        ),
      runId: input.runId,
      storage: browserStorage(),
      unknown: makeRecovery(input, 'dispatch-unknown', identity),
    });
    if (result.kind === 'busy' || result.kind === 'recovery-unavailable') {
      const outcome = dispatchUnavailableOutcome(
        result.kind,
        panel.execution.recovery,
        preparedReview
      );
      updateExecution(outcome.execution, outcome.notice);
      return;
    }
    if (!currentOperationResult(result)) {
      return;
    }
    const outcome = dispatchOutcome(result, preparedReview, input, identity);
    updateExecution(outcome.execution, outcome.notice);
    if (outcome.refreshStatus) {
      ignoreAsync(readStatus(scopeKey, input.runId));
    }
  }

  async function runExplicitReconcile() {
    if (!permissions.canReconcile) {
      return;
    }
    if (busy || spansExecutionOperationInFlight(record.runId)) {
      return;
    }
    const scopeKey = currentScopeKey;
    setPanel((current) => ({
      ...current,
      notice: {
        kind: 'status',
        text: 'Reconciling saved execution outcomes across the archive. This does not launch or retry a worker…',
      },
      status: {
        ...(status ? { value: status } : {}),
        runId: record.runId,
        scopeKey,
        tag: 'reconciling',
      },
    }));
    const result = await runSpansExecutionOperation({
      current: () => operationIsCurrent(scopeKey),
      request: async () => {
        await reconcileSpansExecution();
        return true;
      },
      runId: record.runId,
      storage: browserStorage(),
    });
    if (!currentOperationResult(result)) {
      if (result.kind === 'busy') {
        setPanel((current) => ({
          ...current,
          status: status
            ? {
                runId: record.runId,
                scopeKey,
                tag: 'ready',
                value: status,
              }
            : {
                error: 'Another execution action is still in flight.',
                tag: 'error',
              },
        }));
      }
      return;
    }
    if (result.kind === 'success') {
      setPanel((current) => ({
        ...current,
        notice: {
          kind: 'status',
          text: 'Saved execution reconciliation returned. Refresh this run’s status; a missing attempt alone does not prove Start never took effect.',
        },
      }));
      await readStatus(scopeKey, record.runId);
    } else {
      setPanel((current) => ({
        ...current,
        notice: {
          kind: 'error',
          text: 'Saved execution reconciliation outcome may be unknown. Refresh status before acting again.',
        },
        status: {
          error: spansExecutionErrorMessage(
            result.error,
            'Refresh status before acting again.'
          ),
          tag: 'error',
        },
      }));
    }
  }

  async function verifySavedReview() {
    const marker = recovery;
    if (!marker?.reviewDigest || busy || targets.length === 0) {
      return;
    }
    await readSavedReview(currentScopeKey, marker, targets, record);
  }

  async function refreshLocalContext() {
    onRefresh();
    const controller = new AbortController();
    const scopedRecovery = readSpansExecutionRecovery(
      browserStorage(),
      record.runId
    );
    await Promise.all([
      loadRunContext(
        currentScopeKey,
        controller.signal,
        scopedRecovery,
        record
      ),
      readStatus(currentScopeKey, record.runId),
    ]);
  }

  const actions: ExecutionPanelActions = {
    cancelAttempt: (binding) => ignoreAsync(stopAttempt(binding)),
    cancelChallenge: (intent) => {
      if (
        !(prepared && challenge) ||
        challenge.challenge.intent !== intent ||
        busy
      ) {
        return;
      }
      updateExecution(
        intent === 'revoke'
          ? {
              approvalObservation: 'recovered',
              prepared,
              recovery: execution.recovery,
              tag: 'approved',
            }
          : {
              prepared,
              readback: Boolean(prepared.input),
              recovery: execution.recovery,
              tag: 'prepared',
            },
        null
      );
    },
    changeChallengeResponse: (value) => {
      if (execution.tag !== 'challenge' || !prepared) {
        return;
      }
      setPanel((current) => ({
        ...current,
        execution: {
          challenge: { ...execution.challenge, response: value },
          prepared,
          recovery: execution.recovery,
          tag: 'challenge',
        },
      }));
    },
    checkStatus: () => ignoreAsync(readStatus(currentScopeKey, record.runId)),
    confirmChallenge: () => ignoreAsync(confirmChallenge()),
    discardPreview: () =>
      updateExecution(resetExecutionAfterInputEdit(execution), null),
    dispatch: () => ignoreAsync(startApprovedSpan()),
    editForm,
    formErrorRef: (element) => {
      errorRef.current = element;
    },
    formInvalid: () =>
      setPanel((current) => ({
        ...current,
        formError: 'Complete the required fields and correct invalid values.',
      })),
    preview: (event) => ignoreAsync(previewExecution(event)),
    readSavedReview: () => ignoreAsync(verifySavedReview()),
    reconcile: () => ignoreAsync(runExplicitReconcile()),
    refresh: () => ignoreAsync(refreshLocalContext()),
    requestApproval: () => ignoreAsync(requestChallenge('approve')),
    requestRevocation: () => ignoreAsync(requestChallenge('revoke')),
    saveReview: () => ignoreAsync(saveImmutableReview()),
    verifyFreshProfile: () => ignoreAsync(verifyProfile(true)),
    verifyProfile: () => ignoreAsync(verifyProfile(false)),
  };
  return (
    <ExecutionPanelContent
      actions={actions}
      id={id}
      panel={panel}
      permissions={permissions}
      record={record}
      stale={stale}
    />
  );
}
