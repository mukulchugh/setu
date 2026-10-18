import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCli } from './cli.js';
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
let portal;
let portalRoot;
afterEach(async () => {
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
  const service = execution ? fx.createService() : undefined;
  portal = await createPortalRuntime({
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
    spansExecution: service,
    spansRoot: fx.archive,
    state,
    timers: { clearInterval: () => undefined, setInterval: () => 1 },
  });
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
  return { get, post, request, service };
}

test('with execution disabled every execution route is unavailable and reads are unchanged', async () => {
  const { get, post } = await startPortal();
  const results = await Promise.all([
    get('/api/spans/execution/status?runId=run-1'),
    get(`/api/spans/execution/capabilities?profile=${PROFILE}`),
    post('/api/spans/execution/probe', { profile: PROFILE }),
    post('/api/spans/execution/review', REVIEW),
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
    get(`/api/spans/execution/capabilities?profile=${PROFILE}`),
    post('/api/spans/execution/probe', { profile: PROFILE }),
    post('/api/spans/execution/dispatch', REVIEW),
    post('/api/spans/execution/resolve', { actionId: 'a', runId: 'run-1' }),
  ]);
  for (const result of results) {
    expect(result.status).toBe(503);
    expect(result.body.code).toBe('SPANS_EXECUTION_CONFIG_INVALID');
  }
});

test('HTTP drives probe, review, confirmed dispatch, status and cancel', async () => {
  const { get, post, service } = await startPortal({ execution: true });

  const before = await get(
    `/api/spans/execution/capabilities?profile=${PROFILE}`
  );
  expect(before.body.launch.allowed).toBe(false);
  const probed = await post('/api/spans/execution/probe', { profile: PROFILE });
  expect(probed.body).toMatchObject({ launch: { allowed: true }, ok: true });

  const reviewed = await post('/api/spans/execution/review', REVIEW);
  expect(reviewed.body).toMatchObject({ ok: true, status: 'review' });

  // The first dispatch asks for the confirmation instead of acting.
  const asked = await post('/api/spans/execution/dispatch', REVIEW);
  expect(asked.body).toMatchObject({
    code: 'SPANS_EXEC_CONFIRMATION_REQUIRED',
    confirmation: reviewed.body.confirmation,
    ok: false,
  });
  expect((await fx.admission.status()).leases).toEqual([]);

  const launched = await post('/api/spans/execution/dispatch', {
    ...REVIEW,
    confirmation: reviewed.body.confirmation,
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

test('execution routes reject malformed requests before any service call', async () => {
  const { get, post } = await startPortal({ execution: true });
  expect((await get('/api/spans/execution/status')).status).toBe(400);
  expect(
    (await get('/api/spans/execution/status?runId=a&runId=b')).status
  ).toBe(400);
  expect(
    (await get('/api/spans/execution/status?runId=a&extra=1')).status
  ).toBe(400);
  expect((await post('/api/spans/execution/review', [REVIEW])).status).toBe(
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
});

test('the CLI drives the same operations through the portal', async () => {
  const { request, service } = await startPortal({ execution: true });
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
  const reviewed = await cli([
    'spans',
    'exec',
    'review',
    '--input',
    JSON.stringify(REVIEW),
    '--json',
  ]);
  expect(reviewed.code).toBe(0);
  const withheld = await cli([
    'spans',
    'exec',
    'dispatch',
    '--input',
    JSON.stringify(REVIEW),
    '--json',
  ]);
  expect(withheld.code).toBe(1);
  expect(withheld.value.code).toBe('SPANS_EXEC_CONFIRMATION_REQUIRED');
  const launched = await cli([
    'spans',
    'exec',
    'dispatch',
    '--input',
    JSON.stringify(REVIEW),
    '--confirmation',
    reviewed.value.confirmation,
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
  const reviewed = await post('/api/spans/execution/review', REVIEW);
  const launched = await post('/api/spans/execution/dispatch', {
    ...REVIEW,
    confirmation: reviewed.body.confirmation,
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
