import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { observeProcessIdentity } from './process-observation.js';
import {
  approvedDispatchInput,
  createExecutionFixture,
  PROFILE,
  TARGET,
} from './spans-execution.test-support.js';
import { openSpansStore } from './spans-store.js';
import { checkWriter } from './writer-claims.js';

// Crash tests. A child process runs the real service and is frozen at one
// boundary, then killed with SIGKILL. A new service restarts over the same
// archive, admission state and checkout. The provider is the local process
// fixture, so this proves Setu's restart behavior and nothing about a provider.

const CRASH_FIXTURE = join(import.meta.dir, 'spans-execution.crash-fixture.js');
const BINDING_FIELDS = [
  'actionId',
  'attemptId',
  'generation',
  'runId',
  'spanId',
  'workerId',
];
const WORKER_ID = 'spans-worker-local';
const ATTEMPT_DIGEST = /^[0-9a-f]{64}$/;
const ARTIFACT_DIGEST = /^sha256:[0-9a-f]{64}$/;
const REVIEW = Object.freeze({
  instructions: 'Create fixture-output.txt in the checkout.',
  profile: PROFILE,
  runId: 'run-1',
  spanId: 'build',
  target: TARGET,
  wallClockMs: 30_000,
});

let fx;
// The probe also runs the fixture command once; workers are counted past it.
let probeRuns = 0;
const workers = () => fx.providerPids().length - probeRuns;
afterEach(async () => {
  await fx?.dispose();
  fx = undefined;
});

const events = (type) =>
  fx.store
    .readEvents({ limit: 200, runId: 'run-1' })
    .events.filter((event) => event.type === type);
const run = () => fx.store.readRun({ runId: 'run-1' }).view;
const claim = () => checkWriter(fx.wtDir, 'observer').claim;

async function waitForBoundary(path, resultPath, child, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (!existsSync(path)) {
    if (child.exitCode !== null) {
      const result = existsSync(resultPath)
        ? readFileSync(resultPath, 'utf8')
        : 'no fixture result';
      throw new Error(`fixture exited before ${path}: ${result}`);
    }
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${path}`);
    }
    // biome-ignore lint/performance/noAwaitInLoops: Wait for the supervised child or its boundary marker.
    await Bun.sleep(20);
  }
}

function bindingFields(value) {
  return Object.fromEntries(
    BINDING_FIELDS.map((field) => [field, value?.[field]])
  );
}

function executionAttempt(view = run()) {
  if (!view) {
    return null;
  }
  const execution = Object.values(view.executions ?? {}).find(
    (row) => row.spanId === 'build'
  );
  return execution ? (view.attempts?.[execution.attemptId] ?? null) : null;
}

function expectExactAttemptBinding(attempt = executionAttempt()) {
  expect(attempt).toBeTruthy();
  const view = run();
  const expected = {
    actionId: attempt.actionId,
    attemptId: attempt.attemptId,
    generation: view.generation,
    runId: 'run-1',
    spanId: 'build',
    workerId: WORKER_ID,
  };
  expect(bindingFields(attempt)).toEqual(expected);
  if (attempt.receipt) {
    expect(bindingFields(attempt.receipt)).toEqual(expected);
  }
  return expected;
}

function expectCompleteReceipt(attempt = executionAttempt()) {
  expect(attempt).toBeTruthy();
  const binding = expectExactAttemptBinding(attempt);
  expect(attempt.exit).not.toBeNull();
  expect(attempt.status).toBe('exited');
  expect(attempt).toMatchObject({
    receipt: {
      ...binding,
      attemptDigest: attempt.attemptDigest,
      capture: {
        complete: true,
        countsConfirmed: true,
      },
      exit: attempt.exit,
      kind: 'spans.worker.receipt',
      outcome: 'process-exited',
      ownershipReleased: false,
      reason: 'process-exited',
      resumeAvailable: false,
      retryEligible: false,
      status: 'exited',
      workAccepted: false,
    },
  });
  expect(attempt.attemptDigest).toMatch(ATTEMPT_DIGEST);
  expect(attempt.receipt.capture.artifactId).toMatch(ARTIFACT_DIGEST);
  expect(attempt.receipt.capture).toEqual(attempt.capture);
  expect(attempt.receipt.processStart).toEqual(attempt.processStart);
  expect(attempt.receipt.nativeId).toBe(attempt.nativeId);
  expect(attempt.receipt.nativeIdState).toBe(
    attempt.nativeId === null ? 'missing' : 'recorded'
  );
  expect(attempt.receipt.capture.gap).toBeNull();
  return attempt.receipt;
}

async function waitForTerminalReceipt(timeoutMs = 15_000) {
  const reader = openSpansStore({
    create: false,
    readonly: true,
    root: fx.archive,
  });
  const deadline = Date.now() + timeoutMs;
  try {
    while (Date.now() <= deadline) {
      const read = reader.readRun({ runId: 'run-1' });
      const attempt = executionAttempt(read.view);
      if (attempt?.receipt?.kind === 'spans.worker.receipt' && attempt.exit) {
        return attempt;
      }
      // biome-ignore lint/performance/noAwaitInLoops: Poll the read-only archive for the detached child's terminal receipt.
      await Bun.sleep(20);
    }
  } finally {
    reader.close();
  }
  throw new Error('timed out waiting for a durable detached-worker receipt');
}

async function expectResourcesHeld(service) {
  expect((await fx.admission.status()).leases).toHaveLength(1);
  expect((await service.usage({ runId: 'run-1' })).heldCount).toBe(1);
  expect(claim()).toMatchObject({ agent: 'spans' });
}

// Runs the dispatch in a child, kills it at `boundary`, and returns a fresh
// service that has reconciled the archive.
async function crashAt(
  boundary,
  serviceOptions = {},
  { providerDelayMs, restart = true, review = REVIEW } = {}
) {
  fx = createExecutionFixture();
  await fx.completeSetup();
  const service = fx.createService();
  await service.probe({ profile: PROFILE });
  probeRuns = fx.providerPids().length;
  const input = await approvedDispatchInput(service, review);
  await service.close();

  const child = Bun.spawn(
    [
      process.execPath,
      CRASH_FIXTURE,
      JSON.stringify({ boundary, input, providerDelayMs, root: fx.root }),
    ],
    { stderr: 'pipe', stdout: 'ignore' }
  );
  try {
    await waitForBoundary(
      join(fx.root, 'boundary'),
      join(fx.root, 'fixture-result.json'),
      child
    );
  } catch (error) {
    const { exitCode } = child;
    if (exitCode === null) {
      child.kill('SIGKILL');
    }
    throw new Error(
      `${error.message} (${boundary}, exit ${exitCode ?? 'unknown'})`,
      {
        cause: error,
      }
    );
  }
  child.kill('SIGKILL');
  await child.exited;

  if (!restart) {
    return { input, restarted: null, summary: null };
  }

  const restarted = fx.createService(serviceOptions);
  const summary = await restarted.reconcile();
  expect(summary.ok).toBe(true);
  return { input, restarted, summary };
}

async function expectHeldNotRelaunched({ input, restarted }, { providers }) {
  expect(events('spans.worker.launched').length).toBeLessThanOrEqual(1);
  expect(workers()).toBe(providers);
  // Everything the dead process held is still held.
  expect((await fx.admission.status()).leases).toHaveLength(1);
  expect((await fx.admission.status()).leases[0].ownership).toBe('uncertain');
  expect(claim()).toMatchObject({ agent: 'spans' });
  expect((await restarted.usage({ runId: 'run-1' })).heldCount).toBe(1);
  // Asking again starts nothing.
  const again = await restarted.dispatch(input);
  expect(again.status).not.toBe('launched');
  expect(workers()).toBe(providers);
  expect(run().spans.build.state).toBe('planned');
  expect(events('spans.completion.accepted')).toHaveLength(0);
}

describe('killing the process at each boundary', () => {
  test('after the usage reservation, before any intent', async () => {
    const result = await crashAt('reservation');
    expect(Object.keys(run().actions)).toEqual([]);
    expect(run().attempts).toBeUndefined();
    await expectHeldNotRelaunched(result, { providers: 0 });
  });

  test('after the durable intent, before any launch', async () => {
    const result = await crashAt('intent');
    const [action] = Object.values(run().actions);
    expect(action.state).toBe('unknown');
    expect(run().attempts).toBeUndefined();
    await expectHeldNotRelaunched(result, { providers: 0 });
  });

  test('the native capture child keeps running after a crash at its spawn event', async () => {
    await crashAt(
      'launch',
      {},
      {
        providerDelayMs: 900,
        restart: false,
      }
    );
    const observer = fx.createService();
    const attempt = await waitForTerminalReceipt();
    expectCompleteReceipt(attempt);
    const [action] = Object.values(run().actions);
    expect(action.state).toBe('intent');
    expect(events('spans.execution.captured')).toHaveLength(0);
    expect(events('spans.action.outcome')).toHaveLength(0);
    expect(workers()).toBe(1);
    await expectResourcesHeld(observer);

    const summary = await observer.reconcile();
    expect(summary.ok).toBe(true);
    expect(Object.values(run().actions)[0].state).toBe('completed');
    expect(await observer.usage({ runId: 'run-1' })).toMatchObject({
      outstandingReservationMicro: 0,
      runActualMicro: 0,
      unmeteredCount: 1,
    });
    expect((await fx.admission.status()).leases).toEqual([]);
    expect(claim()).toMatchObject({ agent: 'spans' });
    expect(workers()).toBe(1);
    expect(events('spans.completion.accepted')).toHaveLength(0);
  });

  test('the live provider continues after its parent dies before start acknowledgement', async () => {
    const { input } = await crashAt(
      'start',
      {},
      {
        restart: false,
        review: {
          ...REVIEW,
          instructions:
            'MODE:controlled-success\nCreate fixture-output.txt in the checkout.',
        },
      }
    );
    const restarted = fx.createService();
    const before = executionAttempt();
    expect(before).toMatchObject({ status: 'running' });
    expectExactAttemptBinding(before);
    expect(Object.values(run().actions)[0].state).toBe('intent');
    expect(events('spans.execution.captured')).toHaveLength(0);
    expect(events('spans.action.outcome')).toHaveLength(0);
    expect(workers()).toBe(1);
    await expectResourcesHeld(restarted);

    const readyFile = join(
      fx.root,
      `provider-pids.${before.processStart.pid}.ready`
    );
    const readyDeadline = Date.now() + 3000;
    while (!existsSync(readyFile)) {
      if (Date.now() >= readyDeadline) {
        throw new Error(
          'The surviving controlled provider did not become ready.'
        );
      }
      // biome-ignore lint/performance/noAwaitInLoops: Wait for this exact owned fixture's completion trigger to be installed.
      await Bun.sleep(20);
    }
    const owned = await observeProcessIdentity(before.processStart.pid);
    expect(`${owned.processId}:${owned.processStartIdentity}`).toBe(
      before.processStart.id
    );
    process.kill(before.processStart.pid, 'SIGUSR2');
    const receipt = expectCompleteReceipt(await waitForTerminalReceipt());
    expect(receipt.capture.complete).toBe(true);
    expect(Object.values(run().actions)[0].state).toBe('intent');
    expect(events('spans.execution.captured')).toHaveLength(0);
    await expectResourcesHeld(restarted);

    const summary = await restarted.reconcile();
    expect(summary.ok).toBe(true);
    expect(Object.values(run().actions)[0].state).toBe('completed');
    expect(await restarted.usage({ runId: 'run-1' })).toMatchObject({
      outstandingReservationMicro: 0,
      runActualMicro: 0,
      unmeteredCount: 1,
    });
    expect((await fx.admission.status()).leases).toEqual([]);
    expect(claim()).toMatchObject({ agent: 'spans' });
    expect(workers()).toBe(1);
    expect(events('spans.completion.accepted')).toHaveLength(0);
    expect((await restarted.dispatch(input)).status).not.toBe('launched');
    expect(workers()).toBe(1);
  });

  test('after the exact terminal receipt and captured event, before parent outcome', async () => {
    await crashAt('captured', {}, { restart: false });
    const observer = fx.createService();
    expectCompleteReceipt();
    const [action] = Object.values(run().actions);
    expect(action.state).toBe('intent');
    expect(events('spans.execution.captured')).toHaveLength(1);
    expect(events('spans.action.outcome')).toHaveLength(0);
    await expectResourcesHeld(observer);

    const summary = await observer.reconcile();
    expect(summary.ok).toBe(true);
    expect(Object.values(run().actions)[0].state).toBe('completed');
    expect(await observer.usage({ runId: 'run-1' })).toMatchObject({
      outstandingReservationMicro: 0,
      runActualMicro: 0,
      unmeteredCount: 1,
    });
    expect((await fx.admission.status()).leases).toEqual([]);
    expect(claim()).toMatchObject({ agent: 'spans' });
    expect(workers()).toBe(1);
    expect(events('spans.completion.accepted')).toHaveLength(0);
  });

  test('after outcome commit but before lease and usage settlement', async () => {
    await crashAt('outcome', {}, { restart: false });
    const [action] = Object.values(run().actions);
    expect(action.state).toBe('completed');
    expectCompleteReceipt();
    expect(events('spans.execution.captured')).toHaveLength(1);
    expect((await fx.admission.status()).leases).toHaveLength(1);
    expect(Object.values(run().usage.reservations)[0].state).toBe('reserved');
    expect(claim()).toMatchObject({ agent: 'spans' });

    const restarted = fx.createService();
    const summary = await restarted.reconcile();
    expect(summary.ok).toBe(true);
    expect(await restarted.usage({ runId: 'run-1' })).toMatchObject({
      outstandingReservationMicro: 0,
      runActualMicro: 0,
      unmeteredCount: 1,
    });
    expect((await fx.admission.status()).leases).toEqual([]);
    expect(claim()).toMatchObject({ agent: 'spans' });
    expect(workers()).toBe(1);
    expect(events('spans.worker.launched')).toHaveLength(1);
    expect(run().spans.build.state).toBe('planned');
  });

  test('before acceptance, the restarted service can still review and accept', async () => {
    const { restarted } = await crashAt('acceptance');
    const [action] = Object.values(run().actions);
    expect(action.state).toBe('completed');
    expect(run().spans.build.state).toBe('planned');
    const asked = await restarted.accept({
      actionId: action.actionId,
      runId: 'run-1',
    });
    expect(asked.code).toBe('SPANS_EXEC_ACCEPTANCE_CONFIRMATION_REQUIRED');
    const accepted = await restarted.accept({
      actionId: action.actionId,
      confirmation: asked.confirmation,
      runId: 'run-1',
    });
    expect(accepted).toMatchObject({
      accepted: true,
      ok: true,
      readySpanIds: ['verify'],
    });
    expect(claim()).toBeNull();
    expect(run().spans.verify.state).toBe('ready');
    expect(events('spans.worker.launched')).toHaveLength(1);
  });

  test('reconciling again changes nothing', async () => {
    const { restarted } = await crashAt('intent');
    const before = fx.store.readEvents({ limit: 200, runId: 'run-1' }).events
      .length;
    const { revision } = fx.store.readRun({ runId: 'run-1' });
    expect((await restarted.reconcile()).ok).toBe(true);
    expect(
      fx.store.readEvents({ limit: 200, runId: 'run-1' }).events
    ).toHaveLength(before);
    expect(fx.store.readRun({ runId: 'run-1' }).revision).toBe(revision);
  });
});

describe('resolving a dispatch that never reached intent', () => {
  const idsOf = () => {
    const [execution] = Object.values(run().executions);
    return { actionId: execution.actionId, runId: 'run-1' };
  };

  // Includes the 20s crash-boundary wait and a separate fresh native dispatch.
  test('shows what it would release, needs the exact confirmation, then frees it all', async () => {
    const { restarted, summary } = await crashAt('reservation');
    expect(summary.reconciled[0]).toMatchObject({
      reason: 'authorized-without-intent',
      resolvable: true,
      state: 'held',
    });
    const ids = idsOf();

    const asked = await restarted.resolve(ids);
    expect(asked).toMatchObject({
      code: 'SPANS_EXEC_CONFIRMATION_REQUIRED',
      ok: false,
    });
    expect(asked.review).toMatchObject({
      evidence: { action: 'absent', attempt: 'absent' },
      releases: { admission: true, usage: true, writer: true },
    });
    // Asking changed nothing.
    expect((await fx.admission.status()).leases).toHaveLength(1);
    expect(claim()).toMatchObject({ agent: 'spans' });

    expect(
      await restarted.resolve({ ...ids, confirmation: 'spans-resolve:wrong' })
    ).toMatchObject({ code: 'SPANS_EXEC_REVIEW_CHANGED', ok: false });
    expect((await fx.admission.status()).leases).toHaveLength(1);

    const resolved = await restarted.resolve({
      ...ids,
      confirmation: asked.confirmation,
    });
    expect(resolved).toMatchObject({
      ok: true,
      released: {
        admission: 'released',
        usage: 'released',
        writer: 'released',
      },
      status: 'resolved',
    });
    expect((await fx.admission.status()).leases).toEqual([]);
    expect(
      (await restarted.usage({ runId: 'run-1' })).outstandingReservationMicro
    ).toBe(0);
    expect(claim()).toBeNull();
    expect(workers()).toBe(0);
    expect(events('spans.execution.authorization-withdrawn')).toHaveLength(1);

    // The span can now be reviewed and dispatched afresh, with changed inputs.
    const again = await restarted.review({
      ...REVIEW,
      instructions: 'Create fixture-output.txt, differently.',
    });
    expect(again.ok).toBe(true);
    const input = await approvedDispatchInput(restarted, {
      ...REVIEW,
      instructions: 'Create fixture-output.txt, differently.',
    });
    const launched = await restarted.dispatch(input);
    expect(launched.status).toBe('launched');
    await restarted.idle();
  }, 30_000);

  for (const boundary of ['intent', 'captured']) {
    test(`refuses resolution after ${boundary} and keeps every resource`, async () => {
      const { restarted: alreadyReconciled } = await crashAt(
        boundary,
        {},
        { restart: boundary !== 'captured' }
      );
      const restarted = alreadyReconciled ?? fx.createService();
      const ids = idsOf();
      if (boundary === 'captured') {
        expectExactAttemptBinding();
        expectCompleteReceipt();
        // Launch acknowledgment can become unknown before capture finishes.
        expect(['intent', 'unknown']).toContain(
          Object.values(run().actions)[0].state
        );
        expect(events('spans.action.outcome')).toHaveLength(0);
      }
      expect(await restarted.resolve(ids)).toMatchObject({
        code: 'SPANS_EXEC_NOT_RESOLVABLE',
        ok: false,
      });
      expect(
        await restarted.resolve({ ...ids, confirmation: 'spans-resolve:any' })
      ).toMatchObject({ code: 'SPANS_EXEC_NOT_RESOLVABLE', ok: false });
      expect((await fx.admission.status()).leases).toHaveLength(1);
      expect((await restarted.usage({ runId: 'run-1' })).heldCount).toBe(1);
      expect(claim()).toMatchObject({ agent: 'spans' });
      if (boundary === 'captured') {
        expect((await restarted.reconcile()).ok).toBe(true);
      }
      await fx.dispose();
      fx = undefined;
    }, 20_000);
  }

  test('a dispatch of the same binding cannot start while a resolve is releasing, and the worker keeps its claim', async () => {
    const armed = [];
    let reached;
    let resume;
    const atBarrier = new Promise((resolve) => {
      reached = resolve;
    });
    const gate = new Promise((resolve) => {
      resume = resolve;
    });
    // The resolve is held right after it released the admission lease.
    const holding = {
      async release(lease) {
        const done = await fx.admission.release(lease);
        if (armed.length > 0) {
          armed.length = 0;
          reached();
          await gate;
        }
        return done;
      },
    };
    const { input, restarted } = await crashAt('reservation', {
      admission: new Proxy(
        {},
        {
          get: (_, key) =>
            key === 'release' ? holding.release : fx.admission[key],
        }
      ),
    });
    const ids = idsOf();
    const asked = await restarted.resolve(ids);
    armed.push(true);
    const resolving = restarted.resolve({
      ...ids,
      confirmation: asked.confirmation,
    });
    await atBarrier;

    // The same binding is dispatched in that window: it must start nothing.
    const raced = await restarted.dispatch(input);
    expect(raced).toMatchObject({ code: 'SPANS_EXEC_SPAN_BUSY', ok: false });
    expect(raced.status).not.toBe('launched');
    expect(workers()).toBe(0);
    expect(run().attempts ?? {}).toEqual({});

    resume();
    expect(await resolving).toMatchObject({ ok: true, status: 'resolved' });
    expect(claim()).toBeNull();
    expect((await fx.admission.status()).leases).toEqual([]);
    expect(workers()).toBe(0);
  });

  test('a resolve cannot release anything while a dispatch of that action is in flight', async () => {
    fx = createExecutionFixture();
    await fx.completeSetup();
    const armed = [];
    let reached;
    let resume;
    const atBarrier = new Promise((resolve) => {
      reached = resolve;
    });
    const gate = new Promise((resolve) => {
      resume = resolve;
    });
    const service = fx.createService({
      admission: new Proxy(
        {},
        {
          get: (_, key) =>
            key === 'admit'
              ? async (value) => {
                  if (armed.length > 0) {
                    armed.length = 0;
                    reached();
                    await gate;
                  }
                  return fx.admission.admit(value);
                }
              : fx.admission[key],
        }
      ),
    });
    await service.probe({ profile: PROFILE });
    probeRuns = fx.providerPids().length;
    const input = await approvedDispatchInput(service, REVIEW);
    armed.push(true);
    const dispatching = service.dispatch(input);
    await atBarrier;
    const ids = idsOf();
    expect(
      await service.resolve({ ...ids, confirmation: 'spans-resolve:any' })
    ).toMatchObject({ code: 'SPANS_EXEC_NOT_RESOLVABLE', ok: false });

    resume();
    expect((await dispatching).status).toBe('launched');
    expect(claim()).toMatchObject({ agent: 'spans' });
    await service.idle();
  }, 20_000);

  test('a span reused after a resolve gets a fresh identity and a live reservation, and the old row stays', async () => {
    const { restarted } = await crashAt('reservation');
    const ids = idsOf();
    const asked = await restarted.resolve(ids);
    await restarted.resolve({ ...ids, confirmation: asked.confirmation });
    const [oldReservation] = Object.values(run().usage.reservations);
    expect(oldReservation).toMatchObject({
      observation: { verifiedNoEffect: true },
      state: 'released',
    });

    // The same input is reviewed and dispatched again.
    const again = await restarted.review(REVIEW);
    expect(again.review.actionId).not.toBe(ids.actionId);
    expect(again.review.attemptId).not.toBe(oldReservation.attemptId);
    const input = await approvedDispatchInput(restarted, REVIEW);
    const launched = await restarted.dispatch(input);
    expect(launched).toMatchObject({ status: 'launched' });
    expect(launched.actionId).toBe(again.review.actionId);

    // A live reservation is held for the new action while it runs.
    const reservations = Object.values(run().usage.reservations);
    expect(reservations).toHaveLength(2);
    const live = reservations.find((row) => row.actionId === launched.actionId);
    expect(live).toMatchObject({ held: false, state: 'reserved' });
    expect((await restarted.usage({ runId: 'run-1' })).heldCount).toBe(1);

    await restarted.idle();
    // The old accounting is untouched; the new one settles on its own.
    const after = Object.values(run().usage.reservations);
    expect(after.find((row) => row.actionId === ids.actionId)).toEqual(
      oldReservation
    );
    expect(
      after.find((row) => row.actionId === launched.actionId)
    ).toMatchObject({ actualMicro: null, state: 'released' });
  }, 20_000);

  test('a second supervisor cannot resolve', async () => {
    const { restarted } = await crashAt('reservation');
    const ids = idsOf();
    const other = fx.createService();
    expect(await other.resolve(ids)).toMatchObject({
      code: 'SPANS_EXEC_OWNED_ELSEWHERE',
    });
    expect(restarted).toBeDefined();
  });
});
