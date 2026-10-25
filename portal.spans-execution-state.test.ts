import { describe, expect, test } from 'bun:test';
import type {
  SpansExecutionAttemptBinding,
  SpansExecutionInput,
  SpansExecutionPreparedReview,
  SpansExecutionRecovery,
  SpansExecutionRecoveryRead,
  SpansExecutionStatus,
  SpansExecutionStorage,
} from './portal/spans-execution';
import {
  readSpansExecutionRecovery,
  runSpansExecutionOperation,
  spansExecutionRecordIsEligible,
  writeSpansExecutionRecovery,
} from './portal/spans-execution';
import {
  canStartProfileProbe,
  type ExecutionState,
  type ExecutionStatusResource,
  executionRecoveryPermissions,
  executionScopeIsCurrent,
  executionScopeKey,
  findLiveSpansExecutionAttempt,
  initialExecutionForRecovery,
  makeProfileProbeRecovery,
  protectedExecutionPermissions,
  recoveredExecutionState,
  resetExecutionAfterInputEdit,
  selectExecutionProgress,
  settleExecutionConfirmation,
  transitionExecutionInScope,
} from './portal/spans-execution-state';

const input: SpansExecutionInput = {
  criteria: [],
  instructions: 'Make the planned change.',
  profile: 'claude-code-sonnet',
  requireChange: true,
  runId: 'run-1',
  spanId: 'span-1',
  target: { name: 'feature', repo: 'project' },
  wallClockMs: 30 * 60_000,
};
const reviewDigest = 'a'.repeat(64);
const attemptBinding: SpansExecutionAttemptBinding = {
  actionId: 'action-1',
  attemptId: 'attempt-1',
  generation: 4,
  runId: input.runId,
  spanId: input.spanId,
  workerId: 'worker-1',
};

const review = {
  binding: {
    actionId: 'action-1',
    attemptId: 'attempt-1',
    checkout: {
      expected: {
        dependency: {
          inputDigest: 'a'.repeat(64),
          receiptDigest: 'b'.repeat(64),
          version: 2,
        },
      },
    },
    runId: input.runId,
    spanId: input.spanId,
  },
  confirmation: 'checksum',
  reviewDigest,
} as SpansExecutionPreparedReview;

const prepared = { input, review };
const statusScope = {
  generation: 4,
  runId: input.runId,
  scopeKey: executionScopeKey(input.runId, 4, 9),
};

function statusSnapshot(
  overrides: Partial<SpansExecutionStatus> = {}
): SpansExecutionStatus {
  return {
    attempts: [],
    executions: [],
    generation: statusScope.generation,
    ...overrides,
  };
}

function readyStatus(
  value: SpansExecutionStatus,
  overrides: Partial<{ runId: string; scopeKey: string }> = {}
): ExecutionStatusResource {
  return {
    runId: overrides.runId ?? statusScope.runId,
    scopeKey: overrides.scopeKey ?? statusScope.scopeKey,
    tag: 'ready',
    value,
  };
}

function protectedPermissions(
  resource: ExecutionStatusResource,
  spanId = input.spanId,
  candidates = { canPrepare: true, canStart: true },
  startActionId = attemptBinding.actionId
) {
  return protectedExecutionPermissions(
    resource,
    statusScope,
    spanId,
    candidates,
    startActionId
  );
}

function inMemoryStorage(): {
  entries: Map<string, string>;
  storage: SpansExecutionStorage;
} {
  const entries = new Map<string, string>();
  return {
    entries,
    storage: {
      getItem: (key) => entries.get(key) ?? null,
      removeItem: (key) => {
        entries.delete(key);
      },
      setItem: (key, value) => {
        entries.set(key, value);
      },
    },
  };
}

function marker(
  stage: SpansExecutionRecovery['stage']
): SpansExecutionRecovery {
  return {
    actionId: 'action-1',
    attemptId: 'attempt-1',
    confirmation: 'checksum',
    reviewDigest,
    runId: input.runId,
    spanId: input.spanId,
    stage,
    target: input.target,
    updatedAt: '2026-10-20T00:00:00.000Z',
  };
}

function confirming(intent: 'approve' | 'revoke'): ExecutionState {
  return {
    challenge: {
      challenge: {
        challengeId: 'challenge-1',
        expiresAt: '2026-10-20T00:05:00.000Z',
        intent,
        phrase: 'approve span-1',
        reviewDigest: review.reviewDigest,
        runId: input.runId,
      },
      response: 'approve span-1',
    },
    prepared,
    recovery: { kind: 'saved', value: marker('approval-pending') },
    tag: 'confirming',
  };
}

describe('execution scope and tagged state transitions', () => {
  test('protected Prepare and Start require fresh same-run and same-generation status', () => {
    const loading = protectedPermissions({ tag: 'loading' });
    expect(loading.canPrepare).toBe(false);
    expect(loading.canStart).toBe(false);
    expect(loading.statusConfirmed).toBe(false);

    const error = protectedPermissions({
      error: 'Status read failed.',
      tag: 'error',
    });
    expect(error.canPrepare).toBe(false);
    expect(error.canStart).toBe(false);

    const reconciling = protectedPermissions({
      runId: statusScope.runId,
      scopeKey: statusScope.scopeKey,
      tag: 'reconciling',
      value: statusSnapshot(),
    });
    expect(reconciling.canPrepare).toBe(false);
    expect(reconciling.canStart).toBe(false);

    const staleRun = protectedPermissions(
      readyStatus(statusSnapshot(), { runId: 'run-old' })
    );
    expect(staleRun.canPrepare).toBe(false);
    expect(staleRun.canStart).toBe(false);

    const staleScope = protectedPermissions(
      readyStatus(statusSnapshot(), { scopeKey: 'older-plan-scope' })
    );
    expect(staleScope.canPrepare).toBe(false);
    expect(staleScope.canStart).toBe(false);

    const staleGeneration = protectedPermissions(
      readyStatus(statusSnapshot({ generation: 3 }))
    );
    expect(staleGeneration.canPrepare).toBe(false);
    expect(staleGeneration.canStart).toBe(false);

    const malformed = protectedPermissions(
      readyStatus({
        attempts: [{ spanId: input.spanId }],
        executions: [],
        generation: statusScope.generation,
      } as unknown as SpansExecutionStatus)
    );
    expect(malformed.canPrepare).toBe(false);
    expect(malformed.canStart).toBe(false);
  });

  test('existing execution intent blocks Prepare and Start even for the same review', () => {
    const blockedRows = [
      { acceptance: 'none', action: 'intent', attempt: null },
      { acceptance: 'none', action: 'unknown', attempt: null },
      { acceptance: 'none', action: 'completed', attempt: 'exited' },
      { acceptance: 'pending', action: 'failed', attempt: 'exited' },
      { acceptance: 'accepted', action: 'failed', attempt: 'exited' },
      { acceptance: 'none', action: 'failed', attempt: 'held' },
      { acceptance: 'none', action: 'failed', attempt: 'unknown' },
    ];

    for (const execution of blockedRows) {
      const result = protectedPermissions(
        readyStatus(
          statusSnapshot({
            executions: [
              {
                actionId: 'action-1',
                attemptId: 'attempt-1',
                spanId: input.spanId,
                ...execution,
              },
            ],
          })
        )
      );
      expect(result.canPrepare).toBe(false);
      expect(result.canStart).toBe(false);
    }

    for (const attemptStatus of [
      'launching',
      'running',
      'finalizing',
      'held',
      'unknown',
    ]) {
      const result = protectedPermissions(
        readyStatus(
          statusSnapshot({
            attempts: [
              {
                actionId: 'action-1',
                attemptId: 'attempt-1',
                spanId: input.spanId,
                status: attemptStatus,
              },
            ],
            executions: [
              {
                acceptance: 'none',
                action: 'intent',
                actionId: 'action-1',
                attempt: attemptStatus,
                attemptId: 'attempt-1',
                spanId: input.spanId,
              },
            ],
          })
        )
      );
      expect(result.canPrepare).toBe(false);
      expect(result.canStart).toBe(false);
    }
  });

  test('a failed prior action permits a new Prepare but not a stale Start', () => {
    const failedAction = readyStatus(
      statusSnapshot({
        attempts: [
          {
            actionId: 'action-1',
            attemptId: 'attempt-1',
            spanId: input.spanId,
            status: 'exited',
          },
        ],
        executions: [
          {
            acceptance: 'none',
            action: 'failed',
            actionId: 'action-1',
            attempt: 'exited',
            attemptId: 'attempt-1',
            spanId: input.spanId,
          },
        ],
      })
    );
    const freshReview = protectedPermissions(failedAction);
    expect(freshReview.canPrepare).toBe(true);
    expect(freshReview.canStart).toBe(false);
  });

  test('a recovered approval stays blocked until fresh status confirms no dispatch intent', () => {
    const approved = recoveredExecutionState(marker('approved'), prepared);
    expect(approved.tag).toBe('approved');

    const awaitingRefresh = protectedPermissions(
      { tag: 'loading' },
      input.spanId,
      { canPrepare: false, canStart: true }
    );
    expect(awaitingRefresh.canPrepare).toBe(false);
    expect(awaitingRefresh.canStart).toBe(false);

    const currentPreparedAction = readyStatus(statusSnapshot());
    const refreshed = protectedPermissions(
      currentPreparedAction,
      input.spanId,
      {
        canPrepare: false,
        canStart: true,
      }
    );
    expect(refreshed.statusConfirmed).toBe(true);
    expect(refreshed.canStart).toBe(true);

    const malformedRefresh = protectedPermissions(
      {
        error: 'Status read failed.',
        tag: 'error',
      },
      input.spanId,
      { canPrepare: false, canStart: true }
    );
    expect(malformedRefresh.canStart).toBe(false);
  });

  test('stop identity requires one exact live owned attempt and its matching execution', () => {
    const attempt = {
      ...attemptBinding,
      processStart: { id: '100:Tue Oct 20 08:00:00 2026', pid: 100 },
      status: 'running',
    };
    const execution = {
      actionId: attemptBinding.actionId,
      attempt: 'running',
      attemptId: attemptBinding.attemptId,
      spanId: attemptBinding.spanId,
    };
    const status = {
      attempts: [attempt],
      executions: [execution],
      generation: attemptBinding.generation,
    };
    expect(findLiveSpansExecutionAttempt(status, input.runId)).toEqual(
      attemptBinding
    );
    expect(
      findLiveSpansExecutionAttempt(status, input.runId, {
        ...attemptBinding,
        workerId: 'other-worker',
      })
    ).toBeNull();
    expect(
      findLiveSpansExecutionAttempt(
        { ...status, attempts: [{ ...attempt, runId: 'run-2' }] },
        input.runId
      )
    ).toBeNull();
    expect(
      findLiveSpansExecutionAttempt({ ...status, executions: [] }, input.runId)
    ).toBeNull();
    expect(
      findLiveSpansExecutionAttempt({ ...status, generation: 9 }, input.runId)
    ).toBeNull();
    expect(
      findLiveSpansExecutionAttempt(
        {
          ...status,
          attempts: [
            {
              ...attempt,
              processStart: { id: attempt.processStart.id, pid: -1 },
            },
          ],
        },
        input.runId
      )
    ).toBeNull();
    expect(
      findLiveSpansExecutionAttempt(
        { ...status, attempts: [{ ...attempt, status: 'exited' }] },
        input.runId
      )
    ).toBeNull();
    expect(
      findLiveSpansExecutionAttempt(
        { ...status, attempts: [{ ...attempt, processStart: null }] },
        input.runId
      )
    ).toBeNull();
  });

  test('recovered revocation-unknown exposes only a fresh revoke challenge', () => {
    const preparedReview = recoveredExecutionState(
      marker('prepared'),
      prepared
    );
    expect(
      executionRecoveryPermissions(preparedReview, true, false, false)
    ).toEqual({ canApprove: true, canRevoke: false });

    const revocationUnknown = recoveredExecutionState(
      marker('revocation-unknown'),
      prepared
    );

    expect(
      executionRecoveryPermissions(revocationUnknown, true, false, false)
    ).toEqual({ canApprove: false, canRevoke: true });

    const approvalUnknown = recoveredExecutionState(
      marker('approval-unknown'),
      prepared
    );
    expect(
      executionRecoveryPermissions(approvalUnknown, true, false, false)
    ).toEqual({ canApprove: true, canRevoke: true });
  });

  test('recovery challenge permissions stay disabled when stale, busy, changed, or ineligible', () => {
    const revocationUnknown = recoveredExecutionState(
      marker('revocation-unknown'),
      prepared
    );
    expect(
      executionRecoveryPermissions(revocationUnknown, true, false, true)
    ).toEqual({ canApprove: false, canRevoke: false });
    expect(
      executionRecoveryPermissions(revocationUnknown, true, true, false)
    ).toEqual({ canApprove: false, canRevoke: false });
    expect(
      executionRecoveryPermissions(revocationUnknown, false, false, false)
    ).toEqual({ canApprove: false, canRevoke: false });
    expect(
      executionRecoveryPermissions(revocationUnknown, true, false, false, false)
    ).toEqual({ canApprove: false, canRevoke: false });
  });

  test('execution eligibility rejects legacy imported markers individually', () => {
    const record = (view: Record<string, unknown>) =>
      ({
        generation: 1,
        revision: 1,
        runId: input.runId,
        view,
      }) as never;
    const eligibleView = { state: 'planned' };

    expect(spansExecutionRecordIsEligible(record(eligibleView))).toBe(true);
    expect(
      spansExecutionRecordIsEligible(
        record({ ...eligibleView, imported: true })
      )
    ).toBe(false);
    expect(
      spansExecutionRecordIsEligible(
        record({ ...eligibleView, sourceId: 'source-1' })
      )
    ).toBe(false);
    expect(
      spansExecutionRecordIsEligible(
        record({ ...eligibleView, sourceId: null })
      )
    ).toBe(false);
  });

  test('scope identity changes when run, generation, or plan version changes', () => {
    const initial = executionScopeKey('run-1', 4, 9);
    expect(executionScopeKey('run-2', 4, 9)).not.toBe(initial);
    expect(executionScopeKey('run-1', 5, 9)).not.toBe(initial);
    expect(executionScopeKey('run-1', 4, 10)).not.toBe(initial);
  });

  test('editing clears local preview and saved approval affordances only after pending work is settled', () => {
    const preview: ExecutionState = {
      preview: { input, review: {} as never },
      recovery: { kind: 'empty' },
      tag: 'preview',
    };
    const approved = recoveredExecutionState(marker('approved'), prepared);
    const pending: ExecutionState = {
      operation: 'dispatch',
      prepared,
      recovery: { kind: 'saved', value: marker('dispatch-unknown') },
      tag: 'unknown',
    };

    expect(resetExecutionAfterInputEdit(preview)).toEqual({
      recovery: { kind: 'empty' },
      tag: 'idle',
    });
    expect(resetExecutionAfterInputEdit(approved)).toEqual({
      recovery: { kind: 'empty' },
      tag: 'idle',
    });
    expect(resetExecutionAfterInputEdit(pending)).toBe(pending);
  });

  test('confirmation results distinguish approval, revocation, refusal, and unknown', () => {
    const approved = settleExecutionConfirmation(
      confirming('approve'),
      'approve',
      'success',
      { kind: 'saved', value: marker('approved') }
    );
    expect(approved.tag).toBe('approved');
    if (approved.tag === 'approved') {
      expect(approved.approvalObservation).toBe('current-session');
      expect(approved.recovery).toEqual({
        kind: 'saved',
        value: marker('approved'),
      });
    }

    const revoked = settleExecutionConfirmation(
      confirming('revoke'),
      'revoke',
      'success',
      { kind: 'saved', value: marker('revoked') }
    );
    expect(revoked.tag).toBe('revoked');

    const unknown = settleExecutionConfirmation(
      confirming('approve'),
      'approve',
      'unknown',
      { kind: 'saved', value: marker('approval-unknown') }
    );
    expect(unknown.tag).toBe('unknown');
    expect(unknown.recovery).toEqual({
      kind: 'saved',
      value: marker('approval-unknown'),
    });

    const unknownRevocation = settleExecutionConfirmation(
      confirming('revoke'),
      'revoke',
      'unknown',
      { kind: 'saved', value: marker('revocation-unknown') }
    );
    expect(unknownRevocation.tag).toBe('unknown');
    expect(unknownRevocation.recovery).toEqual({
      kind: 'saved',
      value: marker('revocation-unknown'),
    });

    const refusedRevocation = settleExecutionConfirmation(
      confirming('revoke'),
      'revoke',
      'refused',
      { kind: 'saved', value: marker('approved') }
    );
    expect(refusedRevocation.tag).toBe('approved');
    if (refusedRevocation.tag === 'approved') {
      expect(refusedRevocation.approvalObservation).toBe('recovered');
    }
  });

  test('late confirmation cannot advance a different tagged operation', () => {
    const current: ExecutionState = {
      recovery: { kind: 'empty' },
      tag: 'idle',
    };
    expect(
      settleExecutionConfirmation(current, 'approve', 'success', {
        kind: 'saved',
        value: marker('approved'),
      })
    ).toBe(current);
  });

  test('recovery stages stay explicit and restored approval is labeled as recovered', () => {
    const unresolved: SpansExecutionRecoveryRead = {
      kind: 'saved',
      value: marker('dispatch-unknown'),
    };
    const requiresReviewRead = initialExecutionForRecovery(unresolved);
    expect(requiresReviewRead.tag).toBe('reading-review');
    expect(selectExecutionProgress(requiresReviewRead).busy).toBe(true);
    const unresolvedAfterRead = recoveredExecutionState(
      unresolved.value,
      prepared
    );
    expect(unresolvedAfterRead.tag).toBe('unknown');
    expect(resetExecutionAfterInputEdit(unresolvedAfterRead)).toBe(
      unresolvedAfterRead
    );

    const needsReviewReadback = initialExecutionForRecovery({
      kind: 'saved',
      value: marker('approved'),
    });
    expect(needsReviewReadback.tag).toBe('reading-review');

    const restored = recoveredExecutionState(marker('approved'), prepared);
    expect(restored.tag).toBe('approved');
    if (restored.tag === 'approved') {
      expect(restored.approvalObservation).toBe('recovered');
      expect(restored.recovery.kind).toBe('saved');
    }
    const restoredProgress = selectExecutionProgress(restored);
    expect(restoredProgress.prepared).not.toBeNull();
    if (restoredProgress.prepared) {
      expect(restoredProgress.prepared.review.reviewDigest).toBe(reviewDigest);
    }
  });

  test('a remounted pending probe is unknown and cannot send another request automatically', async () => {
    const { storage, entries } = inMemoryStorage();
    const context = {
      runId: input.runId,
      spanId: input.spanId,
      target: input.target,
    };
    const pending = makeProfileProbeRecovery(
      context,
      'probe-pending',
      '2026-10-20T00:00:00.000Z'
    );
    const unknown = makeProfileProbeRecovery(
      context,
      'probe-unknown',
      '2026-10-20T00:00:01.000Z'
    );
    let requests = 0;
    let loseResponse: ((error: Error) => void) | undefined;
    const first = runSpansExecutionOperation({
      current: () => true,
      pending,
      request: () => {
        requests += 1;
        return new Promise((_, reject) => {
          loseResponse = reject;
        });
      },
      runId: input.runId,
      storage,
      unknown,
    });

    expect(requests).toBe(1);
    const restored = readSpansExecutionRecovery(storage, input.runId);
    expect(restored.kind).toBe('saved');
    if (restored.kind !== 'saved') {
      return;
    }
    expect(restored.value.stage).toBe('probe-unknown');
    expect(initialExecutionForRecovery(restored).tag).toBe('unknown');
    expect(canStartProfileProbe(restored)).toBe(false);
    expect(canStartProfileProbe(restored, true)).toBe(true);

    let remountRequests = 0;
    if (canStartProfileProbe(restored)) {
      await runSpansExecutionOperation({
        current: () => true,
        pending,
        request: () => {
          remountRequests += 1;
          return Promise.resolve();
        },
        runId: input.runId,
        storage,
        unknown,
      });
    }
    expect(remountRequests).toBe(0);
    expect(entries.size).toBe(1);

    loseResponse?.(new Error('response lost'));
    expect((await first).kind).toBe('unknown');
  });

  test('probe recovery storage failure sends no provider request', async () => {
    let requests = 0;
    const result = await runSpansExecutionOperation({
      current: () => true,
      pending: makeProfileProbeRecovery(
        { runId: input.runId, spanId: input.spanId, target: input.target },
        'probe-pending'
      ),
      request: () => {
        requests += 1;
        return Promise.resolve();
      },
      runId: input.runId,
      storage: {
        getItem: () => null,
        removeItem: () => undefined,
        setItem: () => {
          throw new Error('session storage blocked');
        },
      },
    });

    expect(result.kind).toBe('recovery-unavailable');
    expect(requests).toBe(0);
  });

  test('a saved review blocks probing without replacing its recovery marker', () => {
    const { storage } = inMemoryStorage();
    for (const stage of ['prepared', 'approved'] as const) {
      const savedReview = marker(stage);
      expect(writeSpansExecutionRecovery(storage, savedReview)).toBe(true);
      const before = readSpansExecutionRecovery(storage, input.runId);

      expect(canStartProfileProbe(before)).toBe(false);
      expect(readSpansExecutionRecovery(storage, input.runId)).toEqual(before);
    }
  });

  test('recovery for a new run never loads the previous run review', () => {
    const { storage } = inMemoryStorage();
    expect(writeSpansExecutionRecovery(storage, marker('prepared'))).toBe(true);

    const newRunRecovery = readSpansExecutionRecovery(storage, 'run-2');
    expect(newRunRecovery).toEqual({ kind: 'empty' });
    expect(initialExecutionForRecovery(newRunRecovery)).toEqual({
      recovery: { kind: 'empty' },
      tag: 'idle',
    });
  });

  test('challenge-pending reloads as prepared with immutable identity and no typed phrase', async () => {
    const { storage, entries } = inMemoryStorage();
    const pending = marker('challenge-pending');
    const settled = marker('prepared');
    let requestSawPending = false;
    const result = await runSpansExecutionOperation({
      completed: () => settled,
      current: () => true,
      pending,
      request: () => {
        const raw = [...entries.values()][0] ?? '';
        requestSawPending =
          (JSON.parse(raw) as { stage?: string }).stage === 'challenge-pending';
        return Promise.resolve(true);
      },
      runId: input.runId,
      storage,
    });
    expect(result.kind).toBe('success');
    expect(requestSawPending).toBe(true);

    expect(writeSpansExecutionRecovery(storage, pending)).toBe(true);

    const restored = readSpansExecutionRecovery(storage, input.runId);
    expect(restored.kind).toBe('saved');
    if (restored.kind !== 'saved') {
      return;
    }
    expect(restored.value.stage).toBe('prepared');
    expect(restored.value).toMatchObject({
      actionId: pending.actionId,
      attemptId: pending.attemptId,
      confirmation: pending.confirmation,
      reviewDigest: pending.reviewDigest,
    });
    expect(initialExecutionForRecovery(restored).tag).toBe('reading-review');
    expect(recoveredExecutionState(restored.value, prepared)).toMatchObject({
      prepared,
      readback: true,
      tag: 'prepared',
    });
    const storedValue = [...entries.values()][0] ?? '';
    expect(storedValue).not.toContain('approve span-1');

    expect(
      writeSpansExecutionRecovery(storage, {
        ...pending,
        confirmation: undefined,
      })
    ).toBe(true);
    expect(readSpansExecutionRecovery(storage, input.runId).kind).toBe(
      'corrupt'
    );
  });

  test('late operation callbacks cannot alter a new run or an unmounted panel', async () => {
    const oldScope = executionScopeKey('run-1', 4, 9);
    const newScope = executionScopeKey('run-2', 1, 1);
    const { storage } = inMemoryStorage();
    const current = initialExecutionForRecovery({ kind: 'empty' });
    const late = recoveredExecutionState(marker('approved'), prepared);
    let activeScope = oldScope;
    let mounted = true;
    let resolveRequest: (() => void) | undefined;
    const operation = runSpansExecutionOperation({
      completed: () => null,
      current: () => executionScopeIsCurrent(oldScope, activeScope, mounted),
      pending: marker('approval-pending'),
      request: () =>
        new Promise<void>((resolve) => {
          resolveRequest = resolve;
        }),
      runId: input.runId,
      storage,
    });

    activeScope = newScope;
    resolveRequest?.();
    const result = await operation;
    expect(result).toMatchObject({ current: false, kind: 'success' });
    expect(
      transitionExecutionInScope(
        oldScope,
        activeScope,
        mounted,
        current,
        () => late
      )
    ).toBe(current);

    activeScope = oldScope;
    mounted = false;
    expect(
      transitionExecutionInScope(
        oldScope,
        activeScope,
        mounted,
        current,
        () => late
      )
    ).toBe(current);
  });
});

test('legacy dependency reviews remain revocable but cannot receive a new execution approval', () => {
  const legacy = {
    ...prepared,
    review: {
      ...review,
      binding: {
        ...review.binding,
        checkout: {
          expected: {
            dependency: {
              bunVersion: '1.3.14',
              linkerMode: 'isolated',
              lockfileHash: 'a'.repeat(64),
              platformNamespace: 'darwin-arm64',
            },
          },
        },
      },
    },
  };
  expect(
    executionRecoveryPermissions(
      recoveredExecutionState(marker('prepared'), legacy),
      true,
      false,
      false
    )
  ).toEqual({ canApprove: false, canRevoke: false });
  expect(
    executionRecoveryPermissions(
      recoveredExecutionState(marker('revocation-unknown'), legacy),
      true,
      false,
      false
    )
  ).toEqual({ canApprove: false, canRevoke: true });
});
