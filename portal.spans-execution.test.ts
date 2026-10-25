import { afterEach, describe, expect, test } from 'bun:test';
import {
  approveSpansExecution,
  cancelSpansExecutionAttempt,
  clearSpansExecutionRecovery,
  decodeRetainedSpansExecutionInput,
  dispatchSpansExecution,
  issueSpansExecutionChallenge,
  parseSpansExecutionCriteria,
  persistSpansExecutionCancelState,
  prepareSpansExecution,
  probeSpansExecutionProfile,
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
  SPANS_EXECUTION_PROFILE,
  type SpansExecutionInput,
  type SpansExecutionRecovery,
  sameSpansExecutionInput,
  spansExecutionOperationInFlight,
  spansExecutionRecordIsEligible,
  spansExecutionSpanChoices,
  validSpansExecutionRequest,
  writeSpansExecutionRecovery,
} from './portal/spans-execution';
import {
  executionScopeIsCurrent,
  executionScopeKey,
  protectedExecutionPermissions,
  transitionExecutionInScope,
} from './portal/spans-execution-state';
import type { SpansRecord } from './portal/spans-types';
import {
  createExecutionFixture,
  PROFILE,
  TARGET,
} from './spans-execution.test-support.js';

const originalFetch = globalThis.fetch;
const REVIEW_DIGEST_PATTERN = /^[a-f0-9]{64}$/;
const digest = 'a'.repeat(64);
const artifactDigest = 'b'.repeat(64);
const runId = 'run-1';
const spanId = 'span-a';
const actionId = 'action-1';
const attemptId = 'attempt-1';
const target = { name: 'feat/one', repo: 'demo' };
const attemptBinding = {
  actionId,
  attemptId,
  generation: 2,
  runId,
  spanId,
  workerId: 'worker-1',
};

const input: SpansExecutionInput = {
  criteria: ['Tests pass'],
  instructions: 'Implement the reviewed task.',
  profile: SPANS_EXECUTION_PROFILE,
  requireChange: true,
  runId,
  spanId,
  target,
  wallClockMs: 30 * 60_000,
};

const binding = {
  actionId,
  admission: { kind: 'headless-run', policyDigest: digest },
  attemptId,
  checkout: {
    expected: {
      dependency: {
        bunVersion: '1.3.14',
        linkerMode: 'isolated',
        lockfileHash: artifactDigest,
        platformNamespace: 'darwin-arm64',
      },
      dirty: { count: 0, hash: digest },
      head: 'c'.repeat(40),
      identity: { checkoutPath: '/workspace/demo/feat/one' },
    },
    repoDir: '/workspace/demo.git',
    wtDir: '/workspace/demo/feat/one',
  },
  digests: {
    dependencies: digest,
    dirty: digest,
    head: 'c'.repeat(40),
    lockfile: artifactDigest,
  },
  executionVersion: 1,
  generation: 2,
  inputArtifact: {
    digest: artifactDigest,
    id: `sha256:${artifactDigest}`,
  },
  planVersion: 3,
  policy: { subscriptionOnly: true },
  profile: {
    digest,
    effort: 'medium',
    id: SPANS_EXECUTION_PROFILE,
    model: 'claude-sonnet-5-5',
    provider: 'anthropic',
  },
  requiredCapabilities: ['launch', 'model', 'permissions'],
  runId,
  spanId,
  target,
  targetDigest: digest,
};

const preparedReview = {
  binding,
  executionVersion: 1,
  reviewDigest: digest,
};

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    headers: { 'content-type': 'application/json' },
    status,
  });
}

function useFetch(
  handler: (url: string, init: RequestInit) => Response | Promise<Response>
) {
  const calls: Array<{ init: RequestInit; url: string }> = [];
  globalThis.fetch = (async (inputValue, init = {}) => {
    const url = String(inputValue);
    calls.push({ init, url });
    return await handler(url, init);
  }) as typeof fetch;
  return calls;
}

function expectUiHeader(init: RequestInit) {
  expect(new Headers(init.headers).get('x-setu-source')).toBe('ui');
}

function oversizedResponseStream() {
  let pulls = 0;
  let cancelled = false;
  const response = new Response(
    new ReadableStream<Uint8Array>(
      {
        cancel() {
          cancelled = true;
        },
        pull(controller) {
          pulls += 1;
          if (pulls <= 2) {
            controller.enqueue(new Uint8Array(1024 * 1024));
          } else if (pulls === 3) {
            controller.enqueue(new Uint8Array(1));
          } else {
            controller.enqueue(new Uint8Array(1024 * 1024));
            controller.close();
          }
        },
      },
      { highWaterMark: 0 }
    )
  );
  return { cancelled: () => cancelled, pulls: () => pulls, response };
}

function reviewResponse() {
  return {
    confirmation: `spans-dispatch:${digest}`,
    ok: true,
    review: {
      actionId,
      attemptId,
      checkout: { dirtyCount: 0, head: 'c'.repeat(40) },
      generation: 2,
      mode: {
        billing: 'subscription',
        effort: { observed: null, requested: 'medium' },
        model: 'claude-sonnet-5-5',
        permissionMode: 'default',
        tools: null,
      },
      planVersion: 3,
      profile: SPANS_EXECUTION_PROFILE,
      runId,
      spanId,
      target,
      wallClockMs: input.wallClockMs,
    },
    status: 'review',
  };
}

function preparedResponse() {
  return {
    confirmation: `spans-dispatch:${digest}`,
    ok: true,
    preview: reviewResponse().review,
    review: preparedReview,
    status: 'prepared',
  };
}

function savedReviewResponse() {
  return { ok: true, review: preparedReview };
}

function approvalResponse(challengeId: string) {
  return {
    approval: {
      confirmation: {
        confirmedAt: '2026-10-20T12:00:00.000Z',
        reference: challengeId,
        source: 'portal-human-confirmation',
      },
      executionVersion: 1,
      reviewDigest: digest,
    },
    ok: true,
    replayed: false,
  };
}

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('Spans execution panel transport', () => {
  test('reads only registered worktrees from the actual array response', async () => {
    const calls = useFetch(() =>
      jsonResponse([
        {
          branch: 'feat/one',
          dirty: 0,
          key: 'demo/feat/one',
          label: 'Demo project',
          name: 'feat/one',
          repo: 'demo',
          wtDir: '/workspace/demo/feat/one',
        },
      ])
    );
    const targets = await readRegisteredSpansTargets();
    expect(targets).toEqual([
      {
        branch: 'feat/one',
        dirty: 0,
        key: 'demo/feat/one',
        label: 'Demo project',
        name: 'feat/one',
        repo: 'demo',
        wtDir: '/workspace/demo/feat/one',
      },
    ]);
    expect(calls[0]?.url).toBe('/api/worktrees');
    expectUiHeader(calls[0]?.init ?? {});
  });

  test('rejects duplicate, malformed, and pathless worktree rows', async () => {
    const calls = useFetch(() =>
      jsonResponse([
        { name: 'feat/one', repo: 'demo', wtDir: '/workspace/demo/feat/one' },
        { name: 'feat/one', repo: 'demo', wtDir: '/workspace/demo/feat/one' },
      ])
    );
    await expect(readRegisteredSpansTargets()).rejects.toMatchObject({
      kind: 'unavailable',
    });
    expect(calls).toHaveLength(1);
  });

  test('bounds streamed response bytes and preserves read versus write uncertainty', async () => {
    const expectUnavailableReadAndUnknownWrite = async (
      body: () => Response
    ) => {
      useFetch(() => body());
      await expect(readRegisteredSpansTargets()).rejects.toMatchObject({
        kind: 'unavailable',
      });
      useFetch(() => body());
      await expect(prepareSpansExecution(input)).rejects.toMatchObject({
        kind: 'unknown',
      });
    };
    await expectUnavailableReadAndUnknownWrite(() => new Response('{not-json'));
    await expectUnavailableReadAndUnknownWrite(() => new Response(null));
    await expectUnavailableReadAndUnknownWrite(
      () =>
        new Response(
          new ReadableStream<Uint8Array>({
            pull(controller) {
              controller.error(new Error('interrupted'));
            },
          })
        )
    );

    const readStream = oversizedResponseStream();
    useFetch(() => readStream.response);
    await expect(readRegisteredSpansTargets()).rejects.toMatchObject({
      kind: 'unavailable',
    });
    expect(readStream.cancelled()).toBe(true);
    expect(readStream.pulls()).toBe(3);

    const writeStream = oversizedResponseStream();
    useFetch(() => writeStream.response);
    await expect(prepareSpansExecution(input)).rejects.toMatchObject({
      kind: 'unknown',
    });
    expect(writeStream.cancelled()).toBe(true);
    expect(writeStream.pulls()).toBe(3);
  });

  test('reads capability reasons and keeps requested and observed effort separate', async () => {
    const calls = useFetch(() =>
      jsonResponse({
        launch: {
          allowed: false,
          blockedBy: ['session'],
          unverified: ['effort'],
        },
        observations: {
          effort: { observed: null, requested: 'medium' },
        },
        ok: true,
        profile: SPANS_EXECUTION_PROFILE,
        reason: 'EVIDENCE_MISSING',
      })
    );
    const result = await readSpansExecutionCapabilities();
    expect(result).toMatchObject({
      launch: {
        allowed: false,
        blockedBy: ['session'],
        unverified: ['effort'],
      },
      reason: 'EVIDENCE_MISSING',
    });
    expect(result.observations?.effort).toEqual({
      observed: null,
      requested: 'medium',
    });
    expect(calls[0]?.url).toBe(
      `/api/spans/execution/capabilities?profile=${SPANS_EXECUTION_PROFILE}`
    );
  });

  test('review sends the exact ordinary request and rejects cross-run previews', async () => {
    const calls = useFetch(() => jsonResponse(reviewResponse()));
    const result = await reviewSpansExecution(input);
    expect(result.confirmation).toBe(`spans-dispatch:${digest}`);
    expect(result.review.spanId).toBe(spanId);
    expect(calls[0]?.url).toBe('/api/spans/execution/review');
    expect(calls[0]?.init.method).toBe('POST');
    expectUiHeader(calls[0]?.init ?? {});
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual(input);

    useFetch(() =>
      jsonResponse({
        ...reviewResponse(),
        review: { ...reviewResponse().review, runId: 'run-other' },
      })
    );
    await expect(reviewSpansExecution(input)).rejects.toMatchObject({
      kind: 'unavailable',
    });
  });

  test('prepare and saved review decode the current execution service JSON shape', async () => {
    const fixture = createExecutionFixture();
    const service = fixture.createService();
    try {
      await fixture.completeSetup();
      const probe = await service.probe({ profile: PROFILE });
      expect(probe.ok).toBe(true);
      const serviceInput: SpansExecutionInput = {
        criteria: ['The output exists'],
        instructions: 'Create fixture-output.txt in the checkout.',
        profile: PROFILE,
        requireChange: false,
        runId: 'run-1',
        spanId: 'build',
        target: TARGET,
        wallClockMs: 60_000,
      };
      const actualPrepared = await service.prepare(serviceInput);
      const actualPreview = await service.review(serviceInput);
      expect(actualPrepared.ok).toBe(true);
      expect(actualPrepared.status).toBe('prepared');
      expect(actualPreview.ok).toBe(true);
      expect(actualPreview.status).toBe('review');
      expect(actualPrepared.review.executionVersion).toBe(1);
      expect(actualPrepared.review.binding.runId).toBe('run-1');
      const currentStatus = await service.status({ runId: 'run-1' });
      expect(currentStatus.ok).toBe(true);
      expect(currentStatus.executions).toHaveLength(0);
      const scopeKey = executionScopeKey('run-1', currentStatus.generation, 1);
      const beforeDispatch = protectedExecutionPermissions(
        { runId: 'run-1', scopeKey, tag: 'ready', value: currentStatus },
        { generation: currentStatus.generation, runId: 'run-1', scopeKey },
        'build',
        { canPrepare: false, canStart: true },
        actualPrepared.review.binding.actionId
      );
      expect(beforeDispatch.canStart).toBe(true);

      expect(actualPrepared.review.reviewDigest).toMatch(REVIEW_DIGEST_PATTERN);
      const { reviewDigest } = actualPrepared.review;
      const actualSaved = await service.readReview({
        reviewDigest,
        runId: 'run-1',
      });
      expect(actualSaved.ok).toBe(true);
      expect(actualSaved.review.reviewDigest).toBe(reviewDigest);
      expect('approval' in actualSaved).toBe(false);

      const calls = useFetch((url) =>
        jsonResponse(
          url.includes('/saved-review')
            ? actualSaved
            : { ...actualPrepared, confirmation: actualPreview.confirmation }
        )
      );
      const prepared = await prepareSpansExecution(serviceInput, fixture.wtDir);
      const saved = await readSpansExecutionSavedReview(
        'run-1',
        reviewDigest,
        fixture.wtDir
      );
      expect(prepared.reviewDigest).toBe(reviewDigest);
      expect(prepared.confirmation).toBe(actualPreview.confirmation);
      expect(prepared.binding.actionId).toBe(
        actualPrepared.review.binding.actionId
      );
      expect(saved.binding.runId).toBe('run-1');
      expect(saved.reviewDigest).toBe(reviewDigest);
      expect(saved.confirmation).toBe('');
      expect(calls.map((call) => call.url)).toEqual([
        '/api/spans/execution/prepare',
        '/api/spans/execution/saved-review?reviewDigest=' +
          reviewDigest +
          '&runId=run-1',
      ]);
    } finally {
      await fixture.dispose();
    }
  });

  test('prepare persists only ordinary fields and validates the immutable binding', async () => {
    const calls = useFetch(() => jsonResponse(preparedResponse()));
    const result = await prepareSpansExecution(input);
    expect(result.reviewDigest).toBe(digest);
    expect(result.binding.actionId).toBe(actionId);
    expect(calls[0]?.url).toBe('/api/spans/execution/prepare');
    expectUiHeader(calls[0]?.init ?? {});
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual(input);
  });

  test('prepare transport loss is an unknown outcome, not a safe retry', async () => {
    useFetch(() => {
      throw new TypeError('private transport details');
    });
    await expect(prepareSpansExecution(input)).rejects.toMatchObject({
      kind: 'unknown',
      message: expect.not.stringContaining('private transport details'),
    });
  });

  test('a declared refusal stays distinct from an unknown write outcome', async () => {
    useFetch(() =>
      jsonResponse({ code: 'SPANS_EXECUTION_REVIEW_CHANGED', ok: false }, 409)
    );
    await expect(prepareSpansExecution(input)).rejects.toMatchObject({
      code: 'SPANS_EXECUTION_REVIEW_CHANGED',
      kind: 'refused',
    });
  });

  test('saved review readback binds both run and review digest', async () => {
    const calls = useFetch(() => jsonResponse(savedReviewResponse()));
    const result = await readSpansExecutionSavedReview(runId, digest);
    expect(result.binding.runId).toBe(runId);
    expect(calls[0]?.url).toBe(
      `/api/spans/execution/saved-review?reviewDigest=${digest}&runId=${runId}`
    );

    useFetch(() =>
      jsonResponse({
        ok: true,
        review: {
          ...preparedReview,
          binding: { ...binding, runId: 'run-other' },
        },
      })
    );
    await expect(
      readSpansExecutionSavedReview(runId, digest)
    ).rejects.toMatchObject({ kind: 'unavailable' });
  });

  test('reconstructs only the exact request retained for the matching binding', async () => {
    const multilineInput = {
      ...input,
      instructions:
        'First paragraph.\r\n\r\nSecond paragraph:\n\t- preserve this line',
    };
    const envelope = {
      context: { acceptance: [], instructions: multilineInput.instructions },
      request: multilineInput,
      version: 1,
    };
    const retained = decodeRetainedSpansExecutionInput(
      JSON.stringify(envelope),
      binding
    );
    expect(retained).toEqual(multilineInput);
    expect(sameSpansExecutionInput(multilineInput, retained)).toBe(true);
    expect(
      decodeRetainedSpansExecutionInput(
        JSON.stringify({
          ...envelope,
          request: { ...multilineInput, instructions: 'bad\u0000instruction' },
        }),
        binding
      )
    ).toBeNull();
    expect(
      decodeRetainedSpansExecutionInput(
        JSON.stringify({
          ...envelope,
          request: { ...multilineInput, runId: 'run-other' },
        }),
        binding
      )
    ).toBeNull();

    const record = {
      generation: 1,
      revision: 1,
      runId,
      view: {
        planVersion: 3,
        spans: {
          [spanId]: {
            dependencies: [],
            spanId,
            state: 'planned',
            title: 'Visible title',
          },
        },
        state: 'planned',
      },
    } as unknown as SpansRecord;
    expect(
      validSpansExecutionRequest(
        multilineInput,
        record,
        [
          {
            dependencies: [],
            spanId,
            state: 'planned',
            title: 'Visible title',
          },
        ],
        [
          {
            branch: 'feat/one',
            dirty: 0,
            key: 'demo/feat/one',
            label: 'demo',
            name: target.name,
            repo: target.repo,
            wtDir: '/workspace/demo/feat/one',
          },
        ]
      )
    ).toBeNull();
    expect(
      validSpansExecutionRequest(
        { ...multilineInput, instructions: 'bad\u0001instruction' },
        record,
        [
          {
            dependencies: [],
            spanId,
            state: 'planned',
            title: 'Visible title',
          },
        ],
        [
          {
            branch: 'feat/one',
            dirty: 0,
            key: 'demo/feat/one',
            label: 'demo',
            name: target.name,
            repo: target.repo,
            wtDir: '/workspace/demo/feat/one',
          },
        ]
      )
    ).not.toBeNull();

    const reviewCalls = useFetch(() => jsonResponse(reviewResponse()));
    await reviewSpansExecution(multilineInput);
    expect(JSON.parse(String(reviewCalls[0]?.init.body)).instructions).toBe(
      multilineInput.instructions
    );

    const dispatchCalls = useFetch(() =>
      jsonResponse({ actionId, attemptId, ok: true, status: 'launched' })
    );
    await dispatchSpansExecution(
      multilineInput,
      { actionId, attemptId },
      `spans-dispatch:${digest}`,
      digest
    );
    expect(JSON.parse(String(dispatchCalls[0]?.init.body)).instructions).toBe(
      multilineInput.instructions
    );

    const values = new Map<string, string>();
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      removeItem: (key: string) => values.delete(key),
      setItem: (key: string, value: string) => values.set(key, value),
    };
    const marker: SpansExecutionRecovery = {
      runId,
      spanId,
      stage: 'prepare-pending',
      target,
      updatedAt: '2026-10-20T12:00:00.000Z',
    };
    expect(writeSpansExecutionRecovery(storage, marker)).toBe(true);
    expect(readSpansExecutionRecovery(storage, runId)).toMatchObject({
      kind: 'saved',
      value: { runId, spanId, stage: 'prepare-unknown', target },
    });
    expect(sameSpansExecutionInput(multilineInput, retained)).toBe(true);
  });

  test('approval challenge is explicit and approval does not dispatch', async () => {
    const challengeId = 'd'.repeat(64);
    const calls = useFetch((url) => {
      if (url.endsWith('/approval-challenge')) {
        return jsonResponse({
          challengeId,
          expiresAt: '2026-10-20T12:00:00.000Z',
          intent: 'approve',
          ok: true,
          phrase: 'confirm saved review',
          reviewDigest: digest,
        });
      }
      return jsonResponse(approvalResponse(challengeId));
    });
    const issued = await issueSpansExecutionChallenge({
      intent: 'approve',
      reviewDigest: digest,
      runId,
    });
    expect(issued.phrase).toBe('confirm saved review');
    const approved = await approveSpansExecution({
      confirmation: { challengeId, response: issued.phrase },
      reviewDigest: digest,
      runId,
    });
    expect(approved.replayed).toBe(false);
    expect(approved.approval.reviewDigest).toBe(digest);
    expect(
      (approved.approval.confirmation as Record<string, unknown>).reference
    ).toBe(challengeId);
    expect(calls.map(({ url }) => url)).toEqual([
      '/api/spans/execution/approval-challenge',
      '/api/spans/execution/approve',
    ]);
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({
      intent: 'approve',
      reviewDigest: digest,
      runId,
    });
    expect(JSON.parse(String(calls[1]?.init.body))).toEqual({
      confirmation: { challengeId, response: issued.phrase },
      reviewDigest: digest,
      runId,
    });
    for (const call of calls) {
      expectUiHeader(call.init);
      expect(call.url).not.toContain('/dispatch');
    }
  });

  test('revocation uses a separate challenge and typed confirmation', async () => {
    const challengeId = 'e'.repeat(64);
    const calls = useFetch((url) =>
      url.endsWith('/approval-challenge')
        ? jsonResponse({
            challengeId,
            expiresAt: '2026-10-20T12:00:00.000Z',
            intent: 'revoke',
            ok: true,
            phrase: 'revoke saved review',
            reviewDigest: digest,
          })
        : jsonResponse({ ok: true, replayed: false })
    );
    const challenge = await issueSpansExecutionChallenge({
      intent: 'revoke',
      reviewDigest: digest,
      runId,
    });
    const result = await revokeSpansExecution({
      confirmation: { challengeId, response: challenge.phrase },
      reviewDigest: digest,
      runId,
    });
    expect(result).toEqual({ replayed: false, revoked: true });
    expect(calls[1]?.url).toBe('/api/spans/execution/revoke');
    expect(JSON.parse(String(calls[1]?.init.body)).confirmation).toEqual({
      challengeId,
      response: challenge.phrase,
    });
  });

  test('dispatch sends the saved ordinary request and rejects mismatched attempt identity', async () => {
    const calls = useFetch(() =>
      jsonResponse({ actionId, attemptId, ok: true, status: 'launched' })
    );
    const result = await dispatchSpansExecution(
      input,
      { actionId, attemptId },
      `spans-dispatch:${digest}`,
      digest
    );
    expect(result).toEqual({ actionId, attemptId, status: 'launched' });
    expect(calls[0]?.url).toBe('/api/spans/execution/dispatch');
    expectUiHeader(calls[0]?.init ?? {});
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({
      ...input,
      confirmation: `spans-dispatch:${digest}`,
      reviewDigest: digest,
    });

    useFetch(() =>
      jsonResponse({
        actionId,
        attemptId: 'other',
        ok: true,
        status: 'launched',
      })
    );
    await expect(
      dispatchSpansExecution(
        input,
        { actionId, attemptId },
        `spans-dispatch:${digest}`,
        digest
      )
    ).rejects.toMatchObject({ kind: 'unknown' });
  });

  test('missing approval receipts and revoked receipts cannot advance execution', async () => {
    useFetch(() => jsonResponse({ ok: true, replayed: false }));
    await expect(
      approveSpansExecution({
        confirmation: { challengeId: 'd'.repeat(64), response: 'typed phrase' },
        reviewDigest: digest,
        runId,
      })
    ).rejects.toMatchObject({ kind: 'unknown' });

    useFetch(() =>
      jsonResponse({ code: 'SPANS_EXECUTION_REVIEW_REVOKED', ok: false }, 409)
    );
    await expect(
      dispatchSpansExecution(
        input,
        { actionId, attemptId },
        `spans-dispatch:${digest}`,
        digest
      )
    ).rejects.toMatchObject({
      code: 'SPANS_EXECUTION_REVIEW_REVOKED',
      kind: 'refused',
    });
  });

  test('a malformed held dispatch remains unknown, never a clean refusal', async () => {
    useFetch(() =>
      jsonResponse({ actionId, attemptId, ok: true, status: 'held' })
    );
    await expect(
      dispatchSpansExecution(
        input,
        { actionId, attemptId },
        `spans-dispatch:${digest}`,
        digest
      )
    ).rejects.toMatchObject({ kind: 'unknown' });

    const assertHeldCodeUnknown = async (code: string) => {
      useFetch(() => jsonResponse({ code, ok: false, status: 'held' }, 409));
      await expect(
        dispatchSpansExecution(
          input,
          { actionId, attemptId },
          `spans-dispatch:${digest}`,
          digest
        )
      ).rejects.toMatchObject({ kind: 'unknown' });
    };
    await assertHeldCodeUnknown('ACTION_EXISTS');
    await assertHeldCodeUnknown('SPANS_EXEC_ACTION_OPEN');
  });

  test('unknown and malformed mutation replies stay unknown', async () => {
    useFetch(() => new Response('{not-json', { status: 200 }));
    await expect(prepareSpansExecution(input)).rejects.toMatchObject({
      kind: 'unknown',
    });
    useFetch(() =>
      jsonResponse(
        { code: 'SPANS_EXEC_ACTION_OUTCOME_UNKNOWN', ok: false },
        503
      )
    );
    await expect(
      dispatchSpansExecution(
        input,
        { actionId, attemptId },
        `spans-dispatch:${digest}`,
        digest
      )
    ).rejects.toMatchObject({ kind: 'unknown' });
  });

  test('status is run-fenced and a missing attempt is not synthesized', async () => {
    const response = {
      attempts: [{ actionId, attemptId, runId, spanId, status: 'running' }],
      executions: [],
      generation: 2,
      ok: true,
    };
    const calls = useFetch(() => jsonResponse(response));
    const status = await readSpansExecutionStatus(runId);
    expect(status.attempts).toEqual(response.attempts);
    expect(calls[0]?.url).toBe(`/api/spans/execution/status?runId=${runId}`);
    useFetch(() =>
      jsonResponse({
        ...response,
        attempts: [{ ...response.attempts[0], runId: 'run-other' }],
      })
    );
    await expect(readSpansExecutionStatus(runId)).rejects.toMatchObject({
      kind: 'unavailable',
    });
    useFetch(() =>
      jsonResponse({ attempts: [], executions: [], generation: 2, ok: true })
    );
    const empty = await readSpansExecutionStatus(runId);
    expect(empty.attempts).toEqual([]);
  });

  test('a same-run status read must have well-formed span rows before it enables protected actions', async () => {
    const scopeKey = executionScopeKey(runId, 2, 3);
    useFetch(() =>
      jsonResponse({
        attempts: [],
        executions: [],
        generation: 2,
        ok: true,
      })
    );
    const current = await readSpansExecutionStatus(runId);
    const enabled = protectedExecutionPermissions(
      { runId, scopeKey, tag: 'ready', value: current },
      { generation: 2, runId, scopeKey },
      spanId,
      { canPrepare: true, canStart: true }
    );
    expect(enabled.canPrepare).toBe(true);
    expect(enabled.canStart).toBe(false);

    useFetch(() =>
      jsonResponse({
        attempts: [],
        executions: [
          {
            acceptance: 'none',
            action: 'intent',
            actionId,
            attempt: null,
            attemptId,
            runId,
            spanId,
          },
        ],
        generation: 2,
        ok: true,
      })
    );
    const prepared = await readSpansExecutionStatus(runId);
    const startReady = protectedExecutionPermissions(
      { runId, scopeKey, tag: 'ready', value: prepared },
      { generation: 2, runId, scopeKey },
      spanId,
      { canPrepare: false, canStart: true },
      actionId
    );
    expect(startReady.canPrepare).toBe(false);
    expect(startReady.canStart).toBe(false);

    useFetch(() =>
      jsonResponse({
        attempts: [{ spanId, status: 3 }],
        executions: [],
        generation: 2,
        ok: true,
      })
    );
    const malformed = await readSpansExecutionStatus(runId);
    const denied = protectedExecutionPermissions(
      { runId, scopeKey, tag: 'ready', value: malformed },
      { generation: 2, runId, scopeKey },
      spanId,
      { canPrepare: true, canStart: true }
    );
    expect(denied.canPrepare).toBe(false);
    expect(denied.canStart).toBe(false);
  });

  test('stop sends only the exact run and attempt and treats delivery as nonterminal', async () => {
    const calls = useFetch(() =>
      jsonResponse({
        attemptId,
        cancel: 'delivered',
        ok: true,
        terminal: false,
      })
    );
    const result = await cancelSpansExecutionAttempt(attemptBinding);
    expect(result).toEqual({ attemptId, cancel: 'delivered', terminal: false });
    expect(calls[0]?.url).toBe('/api/spans/execution/cancel');
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({
      attemptId,
      runId,
    });
    expectUiHeader(calls[0]?.init ?? {});
  });

  test('an existing exit receipt is distinct from stop delivery and never accepts work', async () => {
    useFetch(() =>
      jsonResponse({ attemptId, cancel: 'none', ok: true, terminal: true })
    );
    const states: string[] = [];
    const result = await runSpansExecutionCancelOperation({
      binding: attemptBinding,
      current: () => true,
      persist: (state) => {
        states.push(state);
        return true;
      },
      request: () => cancelSpansExecutionAttempt(attemptBinding),
      runId,
    });
    expect(result.kind).toBe('success');
    if (result.kind === 'success') {
      expect(result.value).toEqual({
        attemptId,
        cancel: 'none',
        terminal: true,
      });
    }
    expect(states).toEqual(['requested', 'terminal']);
  });

  test('stop is not sent when the requested recovery state cannot be saved', async () => {
    const storage = {
      getItem: () => null,
      removeItem: () => undefined,
      setItem: () => {
        throw new Error('session storage unavailable');
      },
    };
    let calls = 0;
    useFetch(() => {
      calls += 1;
      return jsonResponse({
        attemptId,
        cancel: 'delivered',
        ok: true,
        terminal: false,
      });
    });
    const result = await runSpansExecutionCancelOperation({
      binding: attemptBinding,
      current: () => true,
      persist: (state) =>
        persistSpansExecutionCancelState(storage, attemptBinding, state),
      request: () => cancelSpansExecutionAttempt(attemptBinding),
      runId,
    });
    expect(result.kind).toBe('recovery-unavailable');
    expect(calls).toBe(0);
  });

  test('stop recovery reuses matching dispatch status and preserves other unknown markers', () => {
    const values = new Map<string, string>();
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      removeItem: (key: string) => values.delete(key),
      setItem: (key: string, value: string) => values.set(key, value),
    };
    const dispatchRecovery: SpansExecutionRecovery = {
      actionId,
      attemptId,
      confirmation: `spans-dispatch:${digest}`,
      reviewDigest: digest,
      runId,
      spanId,
      stage: 'dispatch-unknown',
      target,
      updatedAt: '2026-10-20T12:00:00.000Z',
    };
    expect(writeSpansExecutionRecovery(storage, dispatchRecovery)).toBe(true);
    expect(
      persistSpansExecutionCancelState(
        storage,
        attemptBinding,
        'unknown',
        '2026-10-20T12:00:01.000Z'
      )
    ).toBe(true);
    expect(readSpansExecutionRecovery(storage, runId)).toMatchObject({
      kind: 'saved',
      value: {
        actionId,
        attemptId,
        reviewDigest: digest,
        stage: 'dispatch-unknown',
        status: 'cancel-unknown',
      },
    });

    const probeRecovery: SpansExecutionRecovery = {
      runId,
      spanId,
      stage: 'probe-unknown',
      target,
      updatedAt: '2026-10-20T12:00:02.000Z',
    };
    const approvalRecovery: SpansExecutionRecovery = {
      actionId,
      attemptId,
      confirmation: `spans-dispatch:${digest}`,
      reviewDigest: digest,
      runId,
      spanId,
      stage: 'approval-unknown',
      target,
      updatedAt: '2026-10-20T12:00:04.000Z',
    };
    for (const recovery of [probeRecovery, approvalRecovery]) {
      values.clear();
      expect(writeSpansExecutionRecovery(storage, recovery)).toBe(true);
      const before = readSpansExecutionRecovery(storage, runId);
      expect(
        persistSpansExecutionCancelState(
          storage,
          attemptBinding,
          'requested',
          '2026-10-20T12:00:03.000Z'
        )
      ).toBe(true);
      expect(readSpansExecutionRecovery(storage, runId)).toEqual(before);
      expect(
        readSpansExecutionCancelRecovery(storage, runId, attemptId)
      ).toMatchObject({ kind: 'saved', value: { state: 'requested' } });
    }
  });

  test('a lost stop response persists unknown and does not retry automatically', async () => {
    const values = new Map<string, string>();
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      removeItem: (key: string) => values.delete(key),
      setItem: (key: string, value: string) => values.set(key, value),
    };
    let calls = 0;
    useFetch(() => {
      calls += 1;
      throw new Error('response lost');
    });
    const result = await runSpansExecutionCancelOperation({
      binding: attemptBinding,
      current: () => true,
      persist: (state) =>
        persistSpansExecutionCancelState(
          storage,
          attemptBinding,
          state,
          '2026-10-20T12:00:00.000Z'
        ),
      request: () => cancelSpansExecutionAttempt(attemptBinding),
      runId,
    });
    expect(result.kind).toBe('unknown');
    expect(
      readSpansExecutionCancelRecovery(storage, runId, attemptId)
    ).toMatchObject({
      kind: 'saved',
      value: { binding: attemptBinding, state: 'unknown' },
    });
    expect(calls).toBe(1);
  });

  test('late stop results stay fenced from a different run view', async () => {
    let scope = executionScopeKey(runId, 2, 3);
    const expectedScope = scope;
    let resolveRequest:
      | ((value: {
          attemptId: string;
          cancel: 'delivered';
          terminal: false;
        }) => void)
      | undefined;
    let visible = 'run-2';
    const operation = runSpansExecutionCancelOperation({
      binding: attemptBinding,
      current: () => executionScopeIsCurrent(expectedScope, scope, true),
      persist: () => true,
      request: () =>
        new Promise((resolve) => {
          resolveRequest = resolve;
        }),
      runId,
    });
    scope = executionScopeKey('run-2', 1, 1);
    resolveRequest?.({ attemptId, cancel: 'delivered', terminal: false });
    const result = await operation;
    if ('current' in result && result.current) {
      visible = 'run-1';
    }
    expect(result).toMatchObject({ current: false, kind: 'success' });
    expect(
      transitionExecutionInScope(
        expectedScope,
        scope,
        true,
        visible,
        () => 'run-1'
      )
    ).toBe('run-2');
  });

  test('a malformed stop response is unknown and is not presented as terminal', async () => {
    const values = new Map<string, string>();
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      removeItem: (key: string) => values.delete(key),
      setItem: (key: string, value: string) => values.set(key, value),
    };
    useFetch(() =>
      jsonResponse({
        attemptId,
        cancel: 'delivered',
        ok: true,
        terminal: true,
      })
    );
    const result = await runSpansExecutionCancelOperation({
      binding: attemptBinding,
      current: () => true,
      persist: (state) =>
        persistSpansExecutionCancelState(
          storage,
          attemptBinding,
          state,
          '2026-10-20T12:00:00.000Z'
        ),
      request: () => cancelSpansExecutionAttempt(attemptBinding),
      runId,
    });
    expect(result.kind).toBe('unknown');
    expect(
      readSpansExecutionCancelRecovery(storage, runId, attemptId)
    ).toMatchObject({
      kind: 'saved',
      value: { state: 'unknown' },
    });
  });

  test('reconcile is an explicit empty-body POST and never launches', async () => {
    const calls = useFetch(() => jsonResponse({ ok: true, reconciled: [] }));
    await reconcileSpansExecution();
    expect(calls[0]?.url).toBe('/api/spans/execution/reconcile');
    expect(calls[0]?.init.method).toBe('POST');
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({});
    expectUiHeader(calls[0]?.init ?? {});
  });

  test('capability reads do not automatically probe the provider', async () => {
    const calls = useFetch(() =>
      jsonResponse({
        launch: { allowed: false, blockedBy: [], unverified: [] },
        ok: true,
        profile: SPANS_EXECUTION_PROFILE,
      })
    );
    await readSpansExecutionCapabilities();
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toContain('/capabilities?');
    expect(calls[0]?.init.method).toBeUndefined();
  });

  test('the optional profile probe is a separate explicit call', async () => {
    const calls = useFetch(() => jsonResponse({ ok: true }));
    await probeSpansExecutionProfile();
    expect(calls[0]?.url).toBe('/api/spans/execution/probe');
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({
      profile: SPANS_EXECUTION_PROFILE,
    });
  });

  test('criteria limits and imported or completed records fail closed', () => {
    expect(parseSpansExecutionCriteria(' first \n\nsecond ')).toEqual({
      criteria: ['first', 'second'],
      error: null,
    });
    expect(
      parseSpansExecutionCriteria(
        Array.from({ length: 11 }, () => 'x').join('\n')
      ).error
    ).toContain('at most 10');
    expect(parseSpansExecutionCriteria('x'.repeat(301)).error).toContain(
      '300 characters'
    );
    const record = {
      generation: 1,
      revision: 1,
      runId,
      view: {
        planVersion: 3,
        spans: {
          [spanId]: {
            dependencies: [],
            spanId,
            state: 'planned',
            title: 'Visible title',
          },
          done: {
            dependencies: [],
            spanId: 'done',
            state: 'completed',
            title: 'Already done',
          },
        },
        state: 'planned',
      },
    } as unknown as SpansRecord;
    expect(spansExecutionRecordIsEligible(record)).toBe(true);
    expect(spansExecutionSpanChoices(record)).toEqual([
      {
        dependencies: [],
        spanId,
        state: 'planned',
        title: 'Visible title',
      },
    ]);
    expect(
      spansExecutionRecordIsEligible({
        ...record,
        view: { ...record.view, kind: 'imported' },
      })
    ).toBe(false);
    expect(
      spansExecutionRecordIsEligible({
        ...record,
        view: { ...record.view, readOnly: true },
      })
    ).toBe(false);
    expect(
      spansExecutionRecordIsEligible({
        ...record,
        view: { ...record.view, state: 'completed' },
      })
    ).toBe(false);
  });

  test('pending mutations reload as unknown and session recovery is scoped to one run', () => {
    const values = new Map<string, string>();
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      removeItem: (key: string) => values.delete(key),
      setItem: (key: string, value: string) => values.set(key, value),
    };
    const marker: SpansExecutionRecovery = {
      actionId,
      attemptId,
      confirmation: `spans-dispatch:${digest}`,
      reviewDigest: digest,
      runId,
      spanId,
      stage: 'dispatch-pending',
      target,
      updatedAt: '2026-10-20T12:00:00.000Z',
    };
    expect(writeSpansExecutionRecovery(storage, marker)).toBe(true);
    const recovered = readSpansExecutionRecovery(storage, runId);
    expect(recovered.kind).toBe('saved');
    expect(recovered.kind === 'saved' ? recovered.value.stage : null).toBe(
      'dispatch-unknown'
    );
    expect(readSpansExecutionRecovery(storage, 'run-other').kind).toBe('empty');
    expect(clearSpansExecutionRecovery(storage, runId)).toBe(true);
    expect(readSpansExecutionRecovery(storage, runId).kind).toBe('empty');
  });

  test('missing or corrupt recovery storage fails closed', () => {
    expect(readSpansExecutionRecovery(null, runId).kind).toBe('unavailable');
    const storage = {
      getItem: () => '{broken',
      removeItem: () => undefined,
      setItem: () => undefined,
    };
    expect(readSpansExecutionRecovery(storage, runId).kind).toBe('corrupt');
  });

  test('a pending mutation is not sent when storage cannot persist recovery', async () => {
    const storage = {
      getItem: () => null,
      removeItem: () => undefined,
      setItem: () => {
        throw new Error('storage unavailable');
      },
    };
    const pending: SpansExecutionRecovery = {
      runId,
      spanId,
      stage: 'prepare-pending',
      target,
      updatedAt: '2026-10-20T12:00:00.000Z',
    };
    let requestSent = false;
    const result = await runSpansExecutionOperation({
      current: () => true,
      pending,
      request: () => {
        requestSent = true;
        return Promise.resolve('prepared');
      },
      runId,
      storage,
    });
    expect(result.kind).toBe('recovery-unavailable');
    expect(requestSent).toBe(false);
    expect(spansExecutionOperationInFlight(runId)).toBe(false);
  });

  test('changing reviewed input invalidates the exact approval identity', () => {
    expect(sameSpansExecutionInput(input, { ...input })).toBe(true);
    expect(
      sameSpansExecutionInput(input, {
        ...input,
        instructions: `${input.instructions} changed`,
      })
    ).toBe(false);
    expect(
      sameSpansExecutionInput(input, {
        ...input,
        target: { ...input.target, name: 'other' },
      })
    ).toBe(false);
    expect(
      sameSpansExecutionInput(input, { ...input, runId: 'run-other' })
    ).toBe(false);
  });

  test('a module latch blocks a second owner and fences a late result after a run switch', async () => {
    const values = new Map<string, string>();
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      removeItem: (key: string) => values.delete(key),
      setItem: (key: string, value: string) => values.set(key, value),
    };
    const pending: SpansExecutionRecovery = {
      runId,
      spanId,
      stage: 'prepare-pending',
      target,
      updatedAt: '2026-10-20T12:00:00.000Z',
    };
    let staleEffectCalled = false;
    const stale = await runSpansExecutionOperation({
      current: () => false,
      pending,
      request: () => {
        staleEffectCalled = true;
        return Promise.resolve('must not run');
      },
      runId,
      storage,
    });
    expect(stale.kind).toBe('stale');
    expect(staleEffectCalled).toBe(false);
    expect(readSpansExecutionRecovery(storage, runId).kind).toBe('empty');
    let finishRequest: ((value: string) => void) | undefined;
    let current = true;
    const first = runSpansExecutionOperation({
      completed: () => ({
        actionId,
        attemptId,
        confirmation: `spans-dispatch:${digest}`,
        reviewDigest: digest,
        runId,
        spanId,
        stage: 'prepared',
        target,
        updatedAt: '2026-10-20T12:00:01.000Z',
      }),
      current: () => current,
      pending,
      request: () =>
        new Promise((resolve) => {
          finishRequest = resolve;
        }),
      runId,
      storage,
      unknown: {
        ...pending,
        stage: 'prepare-unknown',
      },
    });
    expect(spansExecutionOperationInFlight(runId)).toBe(true);
    const secondOwner = await runSpansExecutionOperation({
      current: () => true,
      request: async () => 'should not run',
      runId,
      storage,
    });
    expect(secondOwner.kind).toBe('busy');
    current = false;
    finishRequest?.('saved');
    const result = await first;
    expect(result.kind).toBe('success');
    expect(result.kind === 'success' ? result.current : true).toBe(false);
    const recovery = readSpansExecutionRecovery(storage, runId);
    expect(recovery.kind).toBe('saved');
    expect(spansExecutionOperationInFlight(runId)).toBe(false);
  });
});
