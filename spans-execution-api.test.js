import { afterEach, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { runCli } from './cli.js';
import {
  approveSpansExecution,
  cancelSpansExecutionAttempt,
  decodeRetainedSpansExecutionInput,
  dispatchSpansExecution,
  issueSpansExecutionChallenge,
  prepareSpansExecution,
  probeSpansExecutionProfile,
  readSpansExecutionCapabilities,
  readSpansExecutionSavedReview,
  readSpansExecutionStatus,
  reviewSpansExecution,
  revokeSpansExecution,
} from './portal/spans-execution';
import { findLiveSpansExecutionAttempt } from './portal/spans-execution-state';
import { readSpansArtifact } from './portal/spans-read';
import { createPortalRuntime } from './portal.js';
import {
  createExecutionFixture,
  PROFILE,
  TARGET,
} from './spans-execution.test-support.js';
import { createWorkspaceState } from './workspace-state.js';

// HTTP and CLI front doors over a real portal runtime and the real execution
// service. The provider is the local process fixture, so this is a process
// test and not provider acceptance.

const REVIEW = Object.freeze({
  instructions: 'Create fixture-output.txt in the checkout.',
  profile: PROFILE,
  runId: 'run-1',
  spanId: 'build',
  target: TARGET,
  wallClockMs: 30_000,
});

let fx;
const initialExitCode = process.exitCode ?? 0;
let portal;
let portalRoot;
afterEach(async () => {
  process.exitCode = initialExitCode;
  await portal?.dispose();
  portal = undefined;
  await fx?.dispose();
  fx = undefined;
  if (portalRoot) {
    rmSync(portalRoot, { force: true, recursive: true });
    portalRoot = undefined;
  }
});

async function startPortal({ config = {}, execution } = {}) {
  fx = createExecutionFixture();
  await fx.completeSetup();
  portalRoot = realpathSync(mkdtempSync(join(tmpdir(), 'setu-exec-api-')));
  const state = createWorkspaceState({
    configPath: join(portalRoot, 'config.json'),
    setuDir: portalRoot,
    workspaceRoot: portalRoot,
  });
  const fullConfig = { tunnel: 'fixture', workspace: portalRoot, ...config };
  await state.replace('config', fullConfig);
  const createPortal = (executionService) =>
    createPortalRuntime({
      computeWorktrees: () => Promise.resolve([]),
      config: fullConfig,
      indexPage: new Response('fixture'),
      managedAgents: {
        dispose: () => Promise.resolve(),
        recover: () => Promise.resolve(),
      },
      observeProcess: () => Promise.resolve({ state: 'unknown' }),
      port: 43_211,
      projects: {},
      reconcileDevServers: () => Promise.resolve(),
      reconcileTriggerSidecars: () => Promise.resolve(),
      routing: { syncHosts: () => Promise.resolve() },
      seedSidecarApprovals: () => Promise.resolve(),
      serve: () => ({ stop: () => undefined }),
      spansExecution: executionService,
      spansRoot: fx.archive,
      state,
      timers: { clearInterval: () => undefined, setInterval: () => 1 },
    });
  let service = execution ? fx.createService() : undefined;
  portal = await createPortal(service);
  await portal.start();
  const server = {
    requestIP: () => ({ address: '127.0.0.1' }),
    timeout: () => undefined,
  };
  const request = (path, init) =>
    portal.handle(new Request(`http://localhost:43211${path}`, init), server);
  const post = async (path, body) => {
    const response = await request(path, {
      body: JSON.stringify(body),
      headers: { 'content-type': 'application/json' },
      method: 'POST',
    });
    return { body: await response.json(), status: response.status };
  };
  const get = async (path) => {
    const response = await request(path);
    return { body: await response.json(), status: response.status };
  };
  return {
    get,
    post,
    request,
    async restartExecutionService() {
      if (!service) {
        throw new Error('An execution service is required for restart.');
      }
      await portal.dispose();
      portal = undefined;
      await service.close();
      service = fx.createService();
      portal = await createPortal(service);
      await portal.start();
      return service;
    },
    get service() {
      return service;
    },
  };
}

async function approveHttpReview(post, request = REVIEW) {
  const prepared = await post('/api/spans/execution/prepare', request);
  expect(prepared.body).toMatchObject({ ok: true, status: 'prepared' });
  expect(typeof prepared.body.review.reviewDigest).toBe('string');
  expect(typeof prepared.body.preview).toBe('object');
  const { reviewDigest } = prepared.body.review;
  const challenge = await post('/api/spans/execution/approval-challenge', {
    reviewDigest,
    runId: request.runId,
  });
  expect(challenge.body).toMatchObject({
    intent: 'approve',
    ok: true,
    reviewDigest,
  });
  const approved = await post('/api/spans/execution/approve', {
    confirmation: {
      challengeId: challenge.body.challengeId,
      response: challenge.body.phrase,
    },
    reviewDigest,
    runId: request.runId,
  });
  expect(approved.body).toMatchObject({ ok: true, replayed: false });
  return { approved: approved.body, prepared: prepared.body };
}

test('with execution disabled every execution route is unavailable and reads are unchanged', async () => {
  const { get, post } = await startPortal();
  const results = await Promise.all([
    get('/api/spans/execution/status?runId=run-1'),
    get(
      `/api/spans/execution/saved-review?runId=run-1&reviewDigest=${'0'.repeat(64)}`
    ),
    get(`/api/spans/execution/capabilities?profile=${PROFILE}`),
    post('/api/spans/execution/probe', { profile: PROFILE }),
    post('/api/spans/execution/review', REVIEW),
    post('/api/spans/execution/prepare', REVIEW),
    post('/api/spans/execution/approval-challenge', {
      reviewDigest: '0'.repeat(64),
      runId: 'run-1',
    }),
    post('/api/spans/execution/approve', {
      confirmation: { challengeId: '0'.repeat(64), response: 'Approve' },
      reviewDigest: '0'.repeat(64),
      runId: 'run-1',
    }),
    post('/api/spans/execution/revoke', {
      confirmation: { challengeId: '0'.repeat(64), response: 'Revoke' },
      reviewDigest: '0'.repeat(64),
      runId: 'run-1',
    }),
    post('/api/spans/execution/dispatch', REVIEW),
    post('/api/spans/execution/cancel', { attemptId: 'a', runId: 'run-1' }),
    post('/api/spans/execution/accept', { actionId: 'a', runId: 'run-1' }),
    post('/api/spans/execution/complete', { actionId: 'a', runId: 'run-1' }),
    post('/api/spans/execution/report', {
      actionId: 'a',
      generation: 0,
      outcome: 'completed',
      runId: 'run-1',
    }),
    post('/api/spans/execution/reconcile', {}),
    post('/api/spans/execution/resolve', { actionId: 'a', runId: 'run-1' }),
  ]);
  for (const result of results) {
    expect(result.status).toBe(503);
    expect(result.body).toMatchObject({
      code: 'SPANS_EXECUTION_DISABLED',
      ok: false,
    });
  }
  // Offline history and planning behave exactly as before.
  const runs = await get('/api/spans/runs?limit=1');
  expect(runs.status).toBe(200);
  expect(runs.body.records[0].runId).toBe('run-1');
  const run = await get('/api/spans/run?runId=run-1');
  expect(run.body.record.runId).toBe('run-1');
});

test('a malformed spansExecution setting keeps execution off and says why', async () => {
  const { get } = await startPortal({
    config: { spansExecution: { enabled: 'yes' } },
  });
  const status = await get('/api/spans/execution/status?runId=run-1');
  expect(status.status).toBe(503);
  expect(status.body).toMatchObject({
    code: 'SPANS_EXECUTION_CONFIG_INVALID',
    ok: false,
  });
});

test('a malformed setting refuses every execution route the same way', async () => {
  const { get, post } = await startPortal({
    config: { spansExecution: { enabled: 'yes' } },
  });
  const results = await Promise.all([
    get('/api/spans/execution/status?runId=run-1'),
    get(
      `/api/spans/execution/saved-review?runId=run-1&reviewDigest=${'0'.repeat(64)}`
    ),
    get(`/api/spans/execution/capabilities?profile=${PROFILE}`),
    post('/api/spans/execution/probe', { profile: PROFILE }),
    post('/api/spans/execution/review', REVIEW),
    post('/api/spans/execution/prepare', REVIEW),
    post('/api/spans/execution/approval-challenge', {
      reviewDigest: '0'.repeat(64),
      runId: 'run-1',
    }),
    post('/api/spans/execution/approve', {
      confirmation: { challengeId: '0'.repeat(64), response: 'Approve' },
      reviewDigest: '0'.repeat(64),
      runId: 'run-1',
    }),
    post('/api/spans/execution/revoke', {
      confirmation: { challengeId: '0'.repeat(64), response: 'Revoke' },
      reviewDigest: '0'.repeat(64),
      runId: 'run-1',
    }),
    post('/api/spans/execution/dispatch', REVIEW),
    post('/api/spans/execution/cancel', { attemptId: 'a', runId: 'run-1' }),
    post('/api/spans/execution/accept', { actionId: 'a', runId: 'run-1' }),
    post('/api/spans/execution/complete', { actionId: 'a', runId: 'run-1' }),
    post('/api/spans/execution/report', {
      actionId: 'a',
      generation: 0,
      outcome: 'completed',
      runId: 'run-1',
    }),
    post('/api/spans/execution/reconcile', {}),
    post('/api/spans/execution/resolve', { actionId: 'a', runId: 'run-1' }),
  ]);
  for (const result of results) {
    expect(result.status).toBe(503);
    expect(result.body.code).toBe('SPANS_EXECUTION_CONFIG_INVALID');
  }
});

test('HTTP drives durable preparation, typed approval, restart readback and dispatch', async () => {
  const portalFixture = await startPortal({ execution: true });
  const { get, post, service: initialService } = portalFixture;
  let service = initialService;

  const before = await get(
    `/api/spans/execution/capabilities?profile=${PROFILE}`
  );
  expect(before.body.launch.allowed).toBe(false);
  const probed = await post('/api/spans/execution/probe', { profile: PROFILE });
  expect(probed.body).toMatchObject({ launch: { allowed: true }, ok: true });

  const reviewed = await post('/api/spans/execution/review', REVIEW);
  expect(reviewed.body).toMatchObject({ ok: true, status: 'review' });

  const prepared = await post('/api/spans/execution/prepare', REVIEW);
  expect(prepared.body).toMatchObject({
    ok: true,
    review: {
      binding: { runId: 'run-1' },
      executionVersion: 1,
    },
    status: 'prepared',
  });
  expect(prepared.body.confirmation).toBe(reviewed.body.confirmation);
  const { reviewDigest } = prepared.body.review;
  expect(
    Object.keys(
      fx.store.readRun({ runId: REVIEW.runId }).view.execution.reviews
    )
  ).toEqual([reviewDigest]);
  expect(
    fx.store.readRun({ runId: REVIEW.runId }).view.execution.reviews[
      reviewDigest
    ]
  ).toEqual(prepared.body.review);
  const preparedEvent = fx.store
    .readEvents({ limit: 200, runId: REVIEW.runId })
    .events.find((event) => event.type === 'spans.execution-review.prepared');
  expect(preparedEvent.payload.reviewDigest).toBe(reviewDigest);
  expect(
    fx.store.getEventById({ eventId: preparedEvent.eventId })
  ).toMatchObject({ found: true, ok: true });
  const assertSavedReview = async () => {
    expect(
      await service.readReview({ reviewDigest, runId: REVIEW.runId })
    ).toEqual({ ok: true, review: prepared.body.review });
  };
  await assertSavedReview();
  const pidsBeforeApproval = fx.providerPids();
  expect(
    (await get('/api/spans/execution/status?runId=run-1')).body
  ).toMatchObject({ attempts: [], executions: [] });
  expect((await fx.admission.status()).leases).toEqual([]);
  expect(fx.providerPids()).toEqual(pidsBeforeApproval);
  const gitDir = fx.git(['rev-parse', '--git-dir']);
  expect(existsSync(join(resolve(fx.wtDir, gitDir), 'setu-writer.json'))).toBe(
    false
  );

  // A review checksum alone still asks for confirmation and cannot launch.
  const asked = await post('/api/spans/execution/dispatch', REVIEW);
  expect(asked.body).toMatchObject({
    code: 'SPANS_EXEC_CONFIRMATION_REQUIRED',
    confirmation: reviewed.body.confirmation,
    ok: false,
  });
  await assertSavedReview();
  const forged = await post('/api/spans/execution/approve', {
    approved: true,
    confirmation: {
      confirmedAt: '2026-10-20T00:00:00.000Z',
      reference: 'forged-reference',
      source: 'portal-human-confirmation',
    },
    confirmedAt: '2026-10-20T00:00:00.000Z',
    reference: 'forged-reference',
    reviewDigest,
    runId: 'run-1',
    source: 'portal-human-confirmation',
  });
  expect(forged.body).toMatchObject({
    code: 'SPANS_EXECUTION_REVIEW_INVALID',
    ok: false,
  });
  await assertSavedReview();
  const forgedReceipt = await post('/api/spans/execution/approve', {
    confirmation: {
      challengeId: '0'.repeat(64),
      confirmedAt: '2026-10-20T00:00:00.000Z',
      reference: 'forged-reference',
      response: 'Approve',
      source: 'portal-human-confirmation',
    },
    reviewDigest,
    runId: 'run-1',
  });
  expect(forgedReceipt.body).toMatchObject({
    code: 'SPANS_EXECUTION_REVIEW_APPROVAL',
    ok: false,
  });
  expect(
    fx.store.readRun({ runId: 'run-1' }).view.execution?.receipts?.[
      reviewDigest
    ]?.approvals ?? []
  ).toHaveLength(0);
  expect((await fx.admission.status()).leases).toEqual([]);

  await assertSavedReview();
  const challenge = await post('/api/spans/execution/approval-challenge', {
    reviewDigest,
    runId: 'run-1',
  });
  expect(challenge.body).toMatchObject({ intent: 'approve', ok: true });
  const approved = await post('/api/spans/execution/approve', {
    confirmation: {
      challengeId: challenge.body.challengeId,
      response: challenge.body.phrase,
    },
    reviewDigest,
    runId: 'run-1',
  });
  expect(approved.body).toMatchObject({ ok: true, replayed: false });
  const receipt = fx.store.readRun({ runId: 'run-1' }).view.execution.receipts[
    reviewDigest
  ];
  expect(receipt.approvals).toHaveLength(1);
  expect(receipt.approvals[0].confirmation).toMatchObject({
    reference: challenge.body.challengeId,
    source: 'portal-human-confirmation',
  });
  expect(fx.providerPids()).toEqual(pidsBeforeApproval);
  expect((await fx.admission.status()).leases).toEqual([]);

  service = await portalFixture.restartExecutionService();
  const saved = await get(
    `/api/spans/execution/saved-review?runId=run-1&reviewDigest=${reviewDigest}`
  );
  expect(saved.body).toMatchObject({
    ok: true,
    review: { executionVersion: 1, reviewDigest },
  });
  expect(fx.providerPids()).toEqual(pidsBeforeApproval);

  const launched = await post('/api/spans/execution/dispatch', {
    ...REVIEW,
    confirmation: prepared.body.confirmation,
    reviewDigest,
  });
  expect(launched.body).toMatchObject({ ok: true, status: 'launched' });
  await service.idle();

  const status = await get('/api/spans/execution/status?runId=run-1');
  expect(status.body.attempts[0]).toMatchObject({
    exit: { code: 0 },
    status: 'exited',
  });
  expect(status.body.usage).toMatchObject({
    outstandingReservationMicro: 0,
    runActualMicro: 0,
    unmeteredCount: 1,
  });
  expect(status.body.executions[0]).toMatchObject({
    acceptance: 'pending',
    action: 'completed',
  });

  const refused = await post('/api/spans/execution/cancel', {
    attemptId: 'not-an-attempt',
    runId: 'run-1',
  });
  expect(refused.body).toMatchObject({ ok: false });
});

test('the dashboard transport consumes real portal replies through approval and execution', async () => {
  const api = await startPortal({ execution: true });
  const originalFetch = globalThis.fetch;
  const requests = [];
  globalThis.fetch = (path, init) => {
    requests.push({
      path: String(path),
      source: new Headers(init?.headers).get('x-setu-source'),
    });
    return api.request(String(path), init);
  };
  try {
    const input = {
      ...REVIEW,
      criteria: ['The output exists'],
      instructions:
        'MODE:controlled-success\nCreate fixture-output.txt in the checkout.\n\nKeep the existing files.\n\tVerify the result.',
      requireChange: false,
      wallClockMs: 60_000,
    };
    expect((await readSpansExecutionCapabilities()).launch.allowed).toBe(false);
    await probeSpansExecutionProfile();
    expect((await readSpansExecutionCapabilities()).launch.allowed).toBe(true);
    const preview = await reviewSpansExecution(input);
    const prepared = await prepareSpansExecution(input, fx.wtDir);
    expect(prepared.confirmation).toBe(preview.confirmation);
    expect(prepared.binding.runId).toBe(input.runId);
    const saved = await readSpansExecutionSavedReview(
      input.runId,
      prepared.reviewDigest,
      fx.wtDir
    );
    expect(saved.binding).toEqual(prepared.binding);
    const artifact = await readSpansArtifact({
      artifactId: prepared.binding.inputArtifact.id,
      runId: input.runId,
    });
    expect(artifact.ok).toBe(true);
    expect(
      decodeRetainedSpansExecutionInput(artifact.text, prepared.binding)
    ).toEqual(input);
    const pidsBeforeApproval = fx.providerPids();
    const challenge = await issueSpansExecutionChallenge({
      intent: 'approve',
      reviewDigest: prepared.reviewDigest,
      runId: input.runId,
    });
    const approval = await approveSpansExecution({
      confirmation: {
        challengeId: challenge.challengeId,
        response: challenge.phrase,
      },
      reviewDigest: prepared.reviewDigest,
      runId: input.runId,
    });
    expect(approval.replayed).toBe(false);
    expect(fx.providerPids()).toEqual(pidsBeforeApproval);
    expect((await fx.admission.status()).leases).toEqual([]);
    const launched = await dispatchSpansExecution(
      input,
      {
        actionId: prepared.binding.actionId,
        attemptId: prepared.binding.attemptId,
      },
      prepared.confirmation,
      prepared.reviewDigest
    );
    expect(launched.status).toBe('launched');
    const running = await readSpansExecutionStatus(input.runId);
    const binding = findLiveSpansExecutionAttempt(running, input.runId);
    expect(binding?.attemptId).toBe(launched.attemptId);
    const stopped = await cancelSpansExecutionAttempt(binding);
    expect(stopped).toEqual({
      attemptId: launched.attemptId,
      cancel: 'delivered',
      terminal: false,
    });
    expect(await api.service.idle()).toMatchObject({ ok: true });
    const status = await readSpansExecutionStatus(input.runId);
    expect(status.attempts[0].status).toBe('exited');
    expect(status.executions[0].action).toBe('failed');
    expect(status.executions[0].acceptance).not.toBe('accepted');
    expect(
      fx.store.readRun({ runId: input.runId }).view.spans.build.state
    ).toBe('planned');
    expect(await cancelSpansExecutionAttempt(binding)).toEqual({
      attemptId: launched.attemptId,
      cancel: 'none',
      terminal: true,
    });
    const revoked = await issueSpansExecutionChallenge({
      intent: 'revoke',
      reviewDigest: prepared.reviewDigest,
      runId: input.runId,
    });
    const revocation = await revokeSpansExecution({
      confirmation: {
        challengeId: revoked.challengeId,
        response: revoked.phrase,
      },
      reviewDigest: prepared.reviewDigest,
      runId: input.runId,
    });
    expect(revocation.revoked).toBe(true);
    expect(
      requests
        .filter(({ path }) => path.includes('/execution/'))
        .every(({ source }) => source === 'ui')
    ).toBe(true);
  } finally {
    globalThis.fetch = originalFetch;
  }
}, 20_000);

test('execution routes reject malformed requests before any service call', async () => {
  const { get, post } = await startPortal({ execution: true });
  expect((await get('/api/spans/execution/status')).status).toBe(400);
  expect((await get('/api/spans/execution/saved-review')).status).toBe(400);
  expect(
    (await get('/api/spans/execution/status?runId=a&runId=b')).status
  ).toBe(400);
  expect(
    (
      await get(
        `/api/spans/execution/saved-review?runId=a&reviewDigest=${'0'.repeat(64)}&extra=1`
      )
    ).status
  ).toBe(400);
  expect(
    (await get('/api/spans/execution/status?runId=a&extra=1')).status
  ).toBe(400);
  expect((await post('/api/spans/execution/review', [REVIEW])).status).toBe(
    400
  );
  expect((await post('/api/spans/execution/prepare', [REVIEW])).status).toBe(
    400
  );
  const unknownField = await post('/api/spans/execution/review', {
    ...REVIEW,
    wtDir: fx.wtDir,
  });
  expect(unknownField.body).toMatchObject({
    code: 'SPANS_EXEC_REQUEST_INVALID',
    ok: false,
  });
  expect(
    (
      await post('/api/spans/execution/approval-challenge?extra=1', {
        reviewDigest: '0'.repeat(64),
        runId: 'run-1',
      })
    ).status
  ).toBe(400);
});

test('HTTP persists revocation and refuses dispatch for the revoked review', async () => {
  const { post } = await startPortal({ execution: true });
  await post('/api/spans/execution/probe', { profile: PROFILE });
  const { prepared } = await approveHttpReview(post);
  const { reviewDigest } = prepared.review;
  const pidsBeforeRevokedDispatch = fx.providerPids();
  const revokeChallenge = await post(
    '/api/spans/execution/approval-challenge',
    { intent: 'revoke', reviewDigest, runId: REVIEW.runId }
  );
  expect(revokeChallenge.body).toMatchObject({
    intent: 'revoke',
    ok: true,
    reviewDigest,
  });
  const revoked = await post('/api/spans/execution/revoke', {
    confirmation: {
      challengeId: revokeChallenge.body.challengeId,
      response: revokeChallenge.body.phrase,
    },
    reviewDigest,
    runId: REVIEW.runId,
  });
  expect(revoked.body).toMatchObject({ ok: true, replayed: false });
  expect(
    fx.store.readRun({ runId: REVIEW.runId }).view.execution.receipts[
      reviewDigest
    ].revocations
  ).toHaveLength(1);

  const refused = await post('/api/spans/execution/dispatch', {
    ...REVIEW,
    confirmation: prepared.confirmation,
    reviewDigest,
  });
  expect(refused.body).toMatchObject({
    code: 'SPANS_EXECUTION_REVIEW_REVOKED',
    ok: false,
  });
  expect(fx.providerPids()).toEqual(pidsBeforeRevokedDispatch);
  expect((await fx.admission.status()).leases).toEqual([]);
});

test('the CLI drives the same operations through the portal', async () => {
  const { request, service } = await startPortal({ execution: true });
  const reviewInput = JSON.stringify(REVIEW);
  const captured = [];
  const cli = async (argv) => {
    captured.length = 0;
    const code = await runCli(argv, {
      request: async ({ body, method, path }) => {
        const response = await request(path, {
          body: body === undefined ? undefined : JSON.stringify(body),
          headers: { 'content-type': 'application/json' },
          method,
        });
        const value = await response.json();
        captured.push(value);
        return value;
      },
    });
    return { code, value: captured.at(-1) };
  };

  expect((await cli(['spans', 'exec', 'probe', PROFILE, '--json'])).code).toBe(
    0
  );
  const capabilities = await cli([
    'spans',
    'exec',
    'capabilities',
    PROFILE,
    '--json',
  ]);
  expect(capabilities.value.launch.allowed).toBe(true);
  const prepared = await cli([
    'spans',
    'exec',
    'prepare',
    '--input',
    reviewInput,
    '--json',
  ]);
  expect(prepared.code).toBe(0);
  expect(prepared.value).toMatchObject({ ok: true, status: 'prepared' });
  const { review: preparedReview } = prepared.value;
  const { reviewDigest } = preparedReview;
  const challengeInput = JSON.stringify({ reviewDigest, runId: REVIEW.runId });
  const challenged = await cli([
    'spans',
    'exec',
    'approval-challenge',
    '--input',
    challengeInput,
    '--json',
  ]);
  expect(challenged.code).toBe(0);
  expect(challenged.value).toMatchObject({
    intent: 'approve',
    ok: true,
    reviewDigest,
  });
  const approvalInput = JSON.stringify({
    confirmation: {
      challengeId: challenged.value.challengeId,
      response: challenged.value.phrase,
    },
    reviewDigest,
    runId: REVIEW.runId,
  });
  const approved = await cli([
    'spans',
    'exec',
    'approve',
    '--input',
    approvalInput,
    '--json',
  ]);
  expect(approved.code).toBe(0);
  expect(approved.value).toMatchObject({ ok: true, replayed: false });
  const dispatchInput = JSON.stringify({ ...REVIEW, reviewDigest });
  const withheld = await cli([
    'spans',
    'exec',
    'dispatch',
    '--input',
    dispatchInput,
    '--json',
  ]);
  expect(withheld.code).toBe(1);
  expect(withheld.value.code).toBe('SPANS_EXEC_CONFIRMATION_REQUIRED');
  const launched = await cli([
    'spans',
    'exec',
    'dispatch',
    '--input',
    dispatchInput,
    '--confirmation',
    prepared.value.confirmation,
    '--json',
  ]);
  expect(launched.code).toBe(0);
  expect(launched.value.status).toBe('launched');
  await service.idle();
  const status = await cli(['spans', 'exec', 'status', 'run-1', '--json']);
  expect(status.value.attempts[0].status).toBe('exited');
  expect(
    (await cli(['spans', 'exec', 'cancel', 'run-1', 'nope', '--json'])).code
  ).toBe(1);
  expect((await cli(['spans', 'exec', 'bogus', '--json'])).code).toBe(1);
});

test('HTTP and CLI take a span from planned to accepted and ready its dependent', async () => {
  const { get, post, request, service } = await startPortal({
    execution: true,
  });
  await post('/api/spans/execution/probe', { profile: PROFILE });
  const { prepared } = await approveHttpReview(post);
  const launched = await post('/api/spans/execution/dispatch', {
    ...REVIEW,
    confirmation: prepared.confirmation,
    reviewDigest: prepared.review.reviewDigest,
  });
  await service.idle();

  // A completed attempt is not an accepted span.
  const run = () => get('/api/spans/run?runId=run-1');
  const before = await get('/api/spans/execution/status?runId=run-1');
  expect(before.body.executions[0]).toMatchObject({
    acceptance: 'pending',
    action: 'completed',
    resources: {
      admission: 'released',
      writer: { session: expect.any(String) },
    },
  });
  expect((await run()).body.record).toBeDefined();

  const identity = { actionId: launched.body.actionId, runId: 'run-1' };
  const asked = await post('/api/spans/execution/accept', identity);
  expect(asked.body.code).toBe('SPANS_EXEC_ACCEPTANCE_CONFIRMATION_REQUIRED');

  // The same flow through the CLI against the same portal.
  const captured = [];
  const cli = async (argv) => {
    const code = await runCli(argv, {
      request: async ({ body, method, path }) => {
        const response = await request(path, {
          body: body === undefined ? undefined : JSON.stringify(body),
          headers: { 'content-type': 'application/json' },
          method,
        });
        const value = await response.json();
        captured.push(value);
        return value;
      },
    });
    return { code, value: captured.at(-1) };
  };
  expect(
    (
      await cli([
        'spans',
        'exec',
        'complete',
        'run-1',
        identity.actionId,
        '--json',
      ])
    ).code
  ).toBe(0);
  const withheld = await cli([
    'spans',
    'exec',
    'accept',
    'run-1',
    identity.actionId,
    '--json',
  ]);
  expect(withheld.code).toBe(1);
  const accepted = await cli([
    'spans',
    'exec',
    'accept',
    'run-1',
    identity.actionId,
    '--confirmation',
    asked.body.confirmation,
    '--json',
  ]);
  expect(accepted.code).toBe(0);
  expect(accepted.value).toMatchObject({
    accepted: true,
    readySpanIds: ['verify'],
    status: 'accepted',
  });

  const after = await get('/api/spans/execution/status?runId=run-1');
  expect(after.body.executions[0]).toMatchObject({
    acceptance: 'accepted',
    resources: { admission: 'released', writer: null },
  });
  const dependent = await post('/api/spans/execution/review', {
    ...REVIEW,
    spanId: 'verify',
  });
  expect(dependent.body).toMatchObject({ ok: true, status: 'review' });

  const report = await cli([
    'spans',
    'exec',
    'report',
    '--input',
    JSON.stringify({ ...identity, generation: 0, outcome: 'completed' }),
    '--json',
  ]);
  expect(report.value.advanced).toBe(false);
  expect((await cli(['spans', 'exec', 'reconcile', '--json'])).value.ok).toBe(
    true
  );
});

test('the portal reconciles execution at startup and not otherwise', async () => {
  fx = createExecutionFixture();
  const inner = fx.createService();
  let reconciles = 0;
  const watched = {
    ...inner,
    reconcile: () => {
      reconciles += 1;
      return inner.reconcile();
    },
  };
  portalRoot = realpathSync(mkdtempSync(join(tmpdir(), 'setu-exec-api-')));
  const state = createWorkspaceState({
    configPath: join(portalRoot, 'config.json'),
    setuDir: portalRoot,
    workspaceRoot: portalRoot,
  });
  const config = { tunnel: 'fixture', workspace: portalRoot };
  await state.replace('config', config);
  const options = {
    computeWorktrees: () => Promise.resolve([]),
    config,
    indexPage: new Response('fixture'),
    managedAgents: {
      dispose: () => Promise.resolve(),
      recover: () => Promise.resolve(),
    },
    observeProcess: () => Promise.resolve({ state: 'unknown' }),
    port: 43_212,
    projects: {},
    reconcileDevServers: () => Promise.resolve(),
    reconcileTriggerSidecars: () => Promise.resolve(),
    routing: { syncHosts: () => Promise.resolve() },
    seedSidecarApprovals: () => Promise.resolve(),
    serve: () => ({ stop: () => undefined }),
    spansRoot: fx.archive,
    state,
    timers: { clearInterval: () => undefined, setInterval: () => 1 },
  };
  // Disabled: nothing is reconciled and no archive is touched.
  portal = await createPortalRuntime(options);
  await portal.start();
  expect(reconciles).toBe(0);
  await portal.dispose();

  portal = await createPortalRuntime({ ...options, spansExecution: watched });
  await portal.start();
  expect(reconciles).toBe(1);
});

test('turning execution on in the configuration builds the real service lazily, and nothing launches', async () => {
  const { get, post } = await startPortal({
    config: { spansExecution: { enabled: true, runBudgetUsd: 5 } },
  });
  // No probe has run, so there is no capability and no review can proceed.
  const capabilities = await get(
    `/api/spans/execution/capabilities?profile=${PROFILE}`
  );
  expect(capabilities.status).toBe(200);
  expect(capabilities.body).toMatchObject({
    launch: { allowed: false },
    ok: true,
  });
  // The built-in profile is the subscription profile: it takes no dollar budget.
  const review = await post('/api/spans/execution/review', REVIEW);
  expect(review.body).toMatchObject({
    code: 'SPANS_EXEC_CAPABILITY_UNVERIFIED',
    ok: false,
  });
  expect(
    await post('/api/spans/execution/review', { ...REVIEW, budgetUsd: 1 })
  ).toMatchObject({
    body: { code: 'SPANS_EXEC_BUDGET_NOT_APPLICABLE', ok: false },
  });
  const status = await get('/api/spans/execution/status?runId=run-1');
  expect(status.body).toMatchObject({ attempts: [], executions: [], ok: true });
  expect(fx.providerPids()).toEqual([]);
  expect((await fx.admission.status()).leases).toEqual([]);
});

test('an unusable run budget keeps execution off', async () => {
  const { get } = await startPortal({
    config: { spansExecution: { enabled: true, runBudgetUsd: 1000 } },
  });
  expect((await get('/api/spans/execution/status?runId=run-1')).body.code).toBe(
    'SPANS_EXECUTION_CONFIG_INVALID'
  );
});
