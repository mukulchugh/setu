import {
  hasReceiptDependencyBinding,
  hasUnresolvedSpansExecutionOutcome,
  type SpansExecutionAttemptBinding,
  type SpansExecutionChallenge,
  type SpansExecutionInput,
  type SpansExecutionPreparedReview,
  type SpansExecutionRecovery,
  type SpansExecutionRecoveryRead,
  type SpansExecutionStatus,
} from './spans-execution';

type PreviewReview = Awaited<
  ReturnType<typeof import('./spans-execution').reviewSpansExecution>
>;

export interface ExecutionForm {
  criteria: string;
  instructions: string;
  requireChange: boolean;
  spanId: string;
  targetKey: string;
  timeoutMinutes: string;
}

export interface ReviewedExecution {
  input: SpansExecutionInput | null;
  review: SpansExecutionPreparedReview;
}

export interface ChallengeState {
  challenge: SpansExecutionChallenge;
  response: string;
}

export interface ExecutionNotice {
  kind: 'error' | 'status';
  text: string;
}

export type ExecutionResource<T> =
  | { error: string; tag: 'error' }
  | { tag: 'loading' }
  | { tag: 'ready'; value: T };

export type ExecutionStatusResource =
  | { error: string; tag: 'error' }
  | { tag: 'loading' }
  | {
      runId: string;
      scopeKey: string;
      tag: 'ready';
      value: SpansExecutionStatus;
    }
  | {
      runId: string;
      scopeKey: string;
      tag: 'reconciling';
      value?: SpansExecutionStatus;
    };

export interface ProtectedExecutionPermissions {
  canPrepare: boolean;
  canStart: boolean;
  prepareStatusBlocked: boolean;
  startStatusBlocked: boolean;
  status: SpansExecutionStatus | null;
  statusConfirmed: boolean;
}

export function protectedExecutionPermissions(
  resource: ExecutionStatusResource,
  expectedScope: { generation: number; runId: string; scopeKey: string },
  spanId: string | undefined,
  candidates: { canPrepare: boolean; canStart: boolean },
  startActionId?: string
): ProtectedExecutionPermissions {
  let status: SpansExecutionStatus | null = null;
  if (
    resource.tag === 'ready' &&
    resource.runId === expectedScope.runId &&
    resource.scopeKey === expectedScope.scopeKey &&
    isCurrentExecutionStatus(
      resource.value,
      expectedScope.runId,
      expectedScope.generation
    )
  ) {
    status = resource.value;
  }
  const confirmed = status !== null;
  const prepareStatusBlocked =
    status === null ||
    typeof spanId !== 'string' ||
    spanId.length === 0 ||
    blocksFreshPrepare(status, spanId);
  const startStatusBlocked =
    status === null ||
    typeof spanId !== 'string' ||
    spanId.length === 0 ||
    !startActionId ||
    !confirmsPreparedStart(status, spanId, startActionId);

  return {
    canPrepare: candidates.canPrepare && !prepareStatusBlocked,
    canStart: candidates.canStart && !startStatusBlocked,
    prepareStatusBlocked,
    startStatusBlocked,
    status,
    statusConfirmed: confirmed,
  };
}

const STATUS_TOKEN_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const EXECUTION_ACTION_STATES = new Set([
  'completed',
  'failed',
  'intent',
  'unknown',
]);
const EXECUTION_ACCEPTANCE_STATES = new Set(['accepted', 'none', 'pending']);
const EXECUTION_ATTEMPT_STATES = new Set([
  'exited',
  'finalizing',
  'held',
  'intent',
  'launching',
  'running',
]);

function isStatusToken(value: unknown): value is string {
  return typeof value === 'string' && STATUS_TOKEN_PATTERN.test(value);
}

function isStatusRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isCurrentExecutionStatus(
  value: unknown,
  runId: string,
  generation: number
): value is SpansExecutionStatus {
  if (
    !(
      isStatusRecord(value) &&
      value.generation === generation &&
      Number.isSafeInteger(value.generation) &&
      Array.isArray(value.attempts) &&
      value.attempts.length <= 256 &&
      Array.isArray(value.executions) &&
      value.executions.length <= 256
    )
  ) {
    return false;
  }

  return (
    value.attempts.every((attempt) => {
      if (
        !(
          isStatusRecord(attempt) &&
          isStatusToken(attempt.actionId) &&
          isStatusToken(attempt.attemptId) &&
          typeof attempt.spanId === 'string' &&
          attempt.spanId.length > 0 &&
          attempt.spanId.length <= 128 &&
          isStatusToken(attempt.status) &&
          EXECUTION_ATTEMPT_STATES.has(attempt.status)
        )
      ) {
        return false;
      }
      return attempt.runId === undefined || attempt.runId === runId;
    }) &&
    value.executions.every((execution) => {
      if (
        !(
          isStatusRecord(execution) &&
          isStatusToken(execution.actionId) &&
          isStatusToken(execution.attemptId) &&
          typeof execution.spanId === 'string' &&
          execution.spanId.length > 0 &&
          execution.spanId.length <= 128 &&
          isStatusToken(execution.acceptance) &&
          EXECUTION_ACCEPTANCE_STATES.has(execution.acceptance) &&
          (execution.action === null ||
            (isStatusToken(execution.action) &&
              EXECUTION_ACTION_STATES.has(execution.action))) &&
          (execution.attempt === null ||
            (isStatusToken(execution.attempt) &&
              EXECUTION_ATTEMPT_STATES.has(execution.attempt)))
        )
      ) {
        return false;
      }
      return execution.runId === undefined || execution.runId === runId;
    })
  );
}

function blocksFreshPrepare(
  status: SpansExecutionStatus,
  spanId: string
): boolean {
  return (
    status.executions.some(
      (execution) =>
        execution.spanId === spanId &&
        (execution.action !== 'failed' ||
          execution.acceptance !== 'none' ||
          (execution.attempt !== null && execution.attempt !== 'exited'))
    ) ||
    status.attempts.some(
      (attempt) => attempt.spanId === spanId && attempt.status !== 'exited'
    )
  );
}

function confirmsPreparedStart(
  status: SpansExecutionStatus,
  spanId: string,
  actionId: string
): boolean {
  // Preparing a review writes no execution intent. Any existing action for
  // this review means dispatch already crossed that boundary and needs recovery.
  return !(
    blocksFreshPrepare(status, spanId) ||
    status.executions.some((execution) => execution.actionId === actionId) ||
    status.attempts.some((attempt) => attempt.actionId === actionId)
  );
}

export type ExecutionState =
  | { recovery: SpansExecutionRecoveryRead; tag: 'idle' }
  | { recovery: SpansExecutionRecoveryRead; tag: 'previewing' }
  | {
      preview: {
        input: SpansExecutionInput;
        review: PreviewReview;
      };
      recovery: SpansExecutionRecoveryRead;
      tag: 'preview';
    }
  | {
      input: SpansExecutionInput;
      recovery: SpansExecutionRecoveryRead;
      tag: 'preparing';
    }
  | {
      marker: SpansExecutionRecovery;
      recovery: SpansExecutionRecoveryRead;
      tag: 'reading-review';
    }
  | {
      prepared: ReviewedExecution;
      readback: boolean;
      recovery: SpansExecutionRecoveryRead;
      tag: 'prepared';
    }
  | {
      intent: 'approve' | 'revoke';
      prepared: ReviewedExecution;
      recovery: SpansExecutionRecoveryRead;
      tag: 'requesting-challenge';
    }
  | {
      challenge: ChallengeState;
      prepared: ReviewedExecution;
      recovery: SpansExecutionRecoveryRead;
      tag: 'challenge' | 'confirming';
    }
  | {
      approvalObservation: 'current-session' | 'recovered';
      prepared: ReviewedExecution;
      recovery: SpansExecutionRecoveryRead;
      tag: 'approved';
    }
  | {
      prepared: ReviewedExecution;
      recovery: SpansExecutionRecoveryRead;
      tag: 'revoked';
    }
  | {
      operation: string;
      prepared?: ReviewedExecution;
      recovery: SpansExecutionRecoveryRead;
      tag: 'unknown';
    }
  | {
      prepared: ReviewedExecution;
      recovery: SpansExecutionRecoveryRead;
      status: string;
      tag: 'dispatched';
    }
  | {
      prepared: ReviewedExecution;
      recovery: SpansExecutionRecoveryRead;
      tag: 'dispatching';
    };

export interface ExecutionProgress {
  busy: boolean;
  challenge: ChallengeState | null;
  prepared: ReviewedExecution | null;
  preview: Extract<ExecutionState, { tag: 'preview' }>['preview'] | null;
}

const EXECUTION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

function isExecutionId(value: unknown): value is string {
  return typeof value === 'string' && EXECUTION_ID_PATTERN.test(value);
}

function hasProcessStart(value: unknown): boolean {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const start = value as Record<string, unknown>;
  return (
    Number.isSafeInteger(start.pid) &&
    Number(start.pid) > 0 &&
    typeof start.id === 'string' &&
    start.id.length > 0 &&
    start.id.length <= 256 &&
    ![...start.id].some((character) => {
      const code = character.charCodeAt(0);
      return code < 32 || code === 127;
    })
  );
}

export function sameSpansExecutionAttemptBinding(
  left: SpansExecutionAttemptBinding,
  right: SpansExecutionAttemptBinding
): boolean {
  return (
    left.actionId === right.actionId &&
    left.attemptId === right.attemptId &&
    left.generation === right.generation &&
    left.runId === right.runId &&
    left.spanId === right.spanId &&
    left.workerId === right.workerId
  );
}

export function findLiveSpansExecutionAttempt(
  status: SpansExecutionStatus | null,
  runId: string,
  expected: Partial<SpansExecutionAttemptBinding> = {}
): SpansExecutionAttemptBinding | null {
  if (!(status && isExecutionId(runId))) {
    return null;
  }
  const matches = status.attempts.filter((row) => {
    const { processStart } = row;
    return (
      row.runId === runId &&
      ['launching', 'running', 'finalizing'].includes(String(row.status)) &&
      isExecutionId(row.actionId) &&
      isExecutionId(row.attemptId) &&
      isExecutionId(row.spanId) &&
      isExecutionId(row.workerId) &&
      Number.isSafeInteger(row.generation) &&
      row.generation === status.generation &&
      hasProcessStart(processStart) &&
      Object.entries(expected).every(([key, value]) => row[key] === value)
    );
  });
  if (matches.length !== 1) {
    return null;
  }
  const [attempt] = matches;
  const executions = status.executions.filter(
    (execution) =>
      execution.actionId === attempt.actionId &&
      execution.attemptId === attempt.attemptId &&
      execution.spanId === attempt.spanId &&
      (execution.runId === undefined || execution.runId === runId) &&
      execution.attempt === attempt.status
  );
  if (executions.length !== 1) {
    return null;
  }
  return {
    actionId: attempt.actionId as string,
    attemptId: attempt.attemptId as string,
    generation: Number(attempt.generation),
    runId,
    spanId: attempt.spanId as string,
    workerId: attempt.workerId as string,
  };
}

export function executionScopeKey(
  runId: string,
  generation: number,
  planVersion: unknown
): string {
  return JSON.stringify([runId, generation, planVersion]);
}

export function transitionExecutionInScope<T>(
  expectedScopeKey: string,
  currentScopeKey: string,
  mounted: boolean,
  current: T,
  transition: (current: T) => T
): T {
  return executionScopeIsCurrent(expectedScopeKey, currentScopeKey, mounted)
    ? transition(current)
    : current;
}

export function executionScopeIsCurrent(
  expectedScopeKey: string,
  currentScopeKey: string,
  mounted: boolean
): boolean {
  return mounted && expectedScopeKey === currentScopeKey;
}

export function executionRecoveryPermissions(
  execution: ExecutionState,
  reviewIsCurrent: boolean,
  busy: boolean,
  stale: boolean,
  recordEligible = true
): { canApprove: boolean; canRevoke: boolean } {
  const { prepared } = selectExecutionProgress(execution);
  const markerStage =
    execution.recovery.kind === 'saved'
      ? execution.recovery.value.stage
      : undefined;
  const hasPreparedInput = Boolean(prepared?.input);
  const preparedReadback =
    execution.tag === 'prepared' && execution.readback === true;
  const available =
    recordEligible && hasPreparedInput && reviewIsCurrent && !busy && !stale;

  return {
    canApprove: Boolean(
      available &&
        prepared &&
        hasReceiptDependencyBinding(prepared.review) &&
        preparedReadback &&
        (markerStage === 'prepared' || markerStage === 'approval-unknown')
    ),
    canRevoke: Boolean(
      available &&
        (execution.tag === 'approved' ||
          (preparedReadback &&
            (markerStage === 'approval-unknown' ||
              markerStage === 'revocation-unknown')))
    ),
  };
}

export function makeProfileProbeRecovery(
  context: {
    runId: string;
    spanId: string;
    target: { name: string; repo: string };
  },
  stage: 'probe-pending' | 'probe-unknown',
  updatedAt = new Date().toISOString()
): SpansExecutionRecovery {
  return {
    runId: context.runId,
    spanId: context.spanId,
    stage,
    target: context.target,
    updatedAt,
  };
}

export function canStartProfileProbe(
  recovery: SpansExecutionRecoveryRead,
  freshAttempt = false
): boolean {
  if (recovery.kind === 'empty') {
    return !freshAttempt;
  }
  return Boolean(
    freshAttempt &&
      recovery.kind === 'saved' &&
      recovery.value.stage === 'probe-unknown'
  );
}

export function selectExecutionProgress(
  execution: ExecutionState
): ExecutionProgress {
  let prepared: ReviewedExecution | null = null;
  if (
    execution.tag === 'prepared' ||
    execution.tag === 'requesting-challenge' ||
    execution.tag === 'challenge' ||
    execution.tag === 'confirming' ||
    execution.tag === 'approved' ||
    execution.tag === 'revoked' ||
    execution.tag === 'dispatching' ||
    execution.tag === 'dispatched'
  ) {
    ({ prepared } = execution);
  } else if (execution.tag === 'unknown') {
    ({ prepared = null } = execution);
  }

  return {
    busy: [
      'previewing',
      'preparing',
      'reading-review',
      'requesting-challenge',
      'confirming',
      'dispatching',
    ].includes(execution.tag),
    challenge:
      execution.tag === 'challenge' || execution.tag === 'confirming'
        ? execution.challenge
        : null,
    prepared,
    preview: execution.tag === 'preview' ? execution.preview : null,
  };
}

export function initialExecutionForRecovery(
  recovery: SpansExecutionRecoveryRead
): ExecutionState {
  if (recovery.kind === 'saved' && recovery.value.reviewDigest) {
    return { marker: recovery.value, recovery, tag: 'reading-review' };
  }
  if (
    recovery.kind === 'saved' &&
    hasUnresolvedSpansExecutionOutcome(recovery.value.stage)
  ) {
    return { operation: recovery.value.stage, recovery, tag: 'unknown' };
  }
  return { recovery, tag: 'idle' };
}

export function recoveredExecutionState(
  marker: SpansExecutionRecovery,
  prepared: ReviewedExecution
): ExecutionState {
  const recovery: SpansExecutionRecoveryRead = { kind: 'saved', value: marker };
  switch (marker.stage) {
    case 'approved':
      return {
        approvalObservation: 'recovered',
        prepared,
        recovery,
        tag: 'approved',
      };
    case 'revoked':
      return { prepared, recovery, tag: 'revoked' };
    case 'dispatched':
      return {
        prepared,
        recovery,
        status: marker.status?.startsWith('cancel-')
          ? 'recorded'
          : (marker.status ?? 'recorded'),
        tag: 'dispatched',
      };
    case 'prepared':
    case 'approval-unknown':
    case 'revocation-unknown':
      return { prepared, readback: true, recovery, tag: 'prepared' };
    default:
      return {
        operation: 'saved review recovery',
        prepared,
        recovery,
        tag: 'unknown',
      };
  }
}

export function resetExecutionAfterInputEdit(
  execution: ExecutionState
): ExecutionState {
  if (selectExecutionProgress(execution).busy) {
    return execution;
  }
  if (
    execution.recovery.kind !== 'empty' &&
    execution.recovery.kind !== 'saved'
  ) {
    return execution;
  }
  if (
    execution.recovery.kind === 'saved' &&
    hasUnresolvedSpansExecutionOutcome(execution.recovery.value.stage)
  ) {
    return execution;
  }
  return { recovery: { kind: 'empty' }, tag: 'idle' };
}

export function settleExecutionConfirmation(
  execution: ExecutionState,
  intent: 'approve' | 'revoke',
  outcome: 'success' | 'revoked' | 'refused' | 'unknown',
  recovery: SpansExecutionRecoveryRead
): ExecutionState {
  if (
    execution.tag !== 'confirming' ||
    execution.challenge.challenge.intent !== intent
  ) {
    return execution;
  }

  const { prepared } = execution;
  if (outcome === 'success') {
    return intent === 'approve'
      ? {
          approvalObservation: 'current-session',
          prepared,
          recovery,
          tag: 'approved',
        }
      : { prepared, recovery, tag: 'revoked' };
  }
  if (outcome === 'revoked') {
    return { prepared, recovery, tag: 'revoked' };
  }
  if (outcome === 'refused') {
    return intent === 'approve'
      ? { prepared, readback: true, recovery, tag: 'prepared' }
      : {
          approvalObservation: 'recovered',
          prepared,
          recovery,
          tag: 'approved',
        };
  }
  return { operation: intent, prepared, recovery, tag: 'unknown' };
}
