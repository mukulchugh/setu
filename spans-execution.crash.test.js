import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  createExecutionFixture,
  PROFILE,
  TARGET,
} from './spans-execution.test-support.js';
import { checkWriter } from './writer-claims.js';

// Crash tests. A child process runs the real service and is frozen at one
// boundary, then killed with SIGKILL. A new service restarts over the same
// archive, admission state and checkout. The provider is the local process
// fixture, so this proves Setu's restart behavior and nothing about a provider.

const CRASH_FIXTURE = join(import.meta.dir, 'spans-execution.crash-fixture.js');
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

async function waitForFile(path, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (!existsSync(path)) {
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${path}`);
    }
    // biome-ignore lint/performance/noAwaitInLoops: Poll for the file in order.
    await Bun.sleep(20);
  }
}

// Runs the dispatch in a child, kills it at `boundary`, and returns a fresh
// service that has reconciled the archive.
async function crashAt(boundary, serviceOptions = {}) {
  fx = createExecutionFixture();
  await fx.completeSetup();
  const service = fx.createService();
  await service.probe({ profile: PROFILE });
  probeRuns = fx.providerPids().length;
  const reviewed = await service.review(REVIEW);
  const input = { ...REVIEW, confirmation: reviewed.confirmation };
  await service.close();

  const child = Bun.spawn(
    [
      process.execPath,
      CRASH_FIXTURE,
      JSON.stringify({ boundary, input, root: fx.root }),
    ],
    { stderr: 'pipe', stdout: 'ignore' }
  );
  try {
    await waitForFile(join(fx.root, 'boundary'));
  } catch (error) {
    child.kill('SIGKILL');
    throw new Error(
      `${error.message}: ${await new Response(child.stderr).text()}`,
      { cause: error }
    );
  }
  child.kill('SIGKILL');
  await child.exited;
  // Let a provider the child started finish; its pipe to the dead parent is gone.
  await Bun.sleep(400);

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

  test('mid-launch, with a process that was never recorded', async () => {
    const result = await crashAt('launch');
    const [attempt] = Object.values(run().attempts);
    expect(attempt).toMatchObject({
      receipt: { outcome: 'unknown', reason: 'launch-unknown' },
      status: 'held',
    });
    expect(Object.values(run().actions)[0].state).toBe('unknown');
    await expectHeldNotRelaunched(result, { providers: 1 });
  });

  test('mid-run, with a worker nobody is watching', async () => {
    const result = await crashAt('run');
    const [attempt] = Object.values(run().attempts);
    expect(attempt).toMatchObject({
      receipt: { outcome: 'unknown', reason: 'worker-lost' },
      status: 'held',
    });
    expect(Object.values(run().actions)[0].state).toBe('unknown');
    expect(events('spans.recovery.reconciled').length).toBeGreaterThan(0);
    await expectHeldNotRelaunched(result, { providers: 1 });
  });

  test('after the exit was recorded, the verified outcome completes and settles', async () => {
    const { restarted } = await crashAt('exit');
    const [attempt] = Object.values(run().attempts);
    expect(attempt.status).toBe('exited');
    expect(Object.values(run().actions)[0].state).toBe('completed');
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

  test('after the outcome was recorded, before it was settled', async () => {
    const { restarted } = await crashAt('outcome');
    expect(Object.values(run().actions)[0].state).toBe('completed');
    expect(await restarted.usage({ runId: 'run-1' })).toMatchObject({
      outstandingReservationMicro: 0,
      runActualMicro: 0,
      unmeteredCount: 1,
    });
    expect((await fx.admission.status()).leases).toEqual([]);
    expect(claim()).toMatchObject({ agent: 'spans' });
    expect(events('spans.worker.launched')).toHaveLength(1);
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
    const { restarted } = await crashAt('run');
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
    const launched = await restarted.dispatch({
      ...REVIEW,
      confirmation: again.confirmation,
      instructions: 'Create fixture-output.txt, differently.',
    });
    expect(launched.status).toBe('launched');
    await restarted.idle();
  });

  test('refuses anything that reached intent or launched, and keeps every resource', async () => {
    for (const boundary of ['intent', 'run']) {
      // biome-ignore lint/performance/noAwaitInLoops: Each crash starts from a fresh fixture, in order.
      const { restarted } = await crashAt(boundary);
      const ids = idsOf();
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
      await fx.dispose();
      fx = undefined;
    }
  });

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
    const reviewed = await service.review(REVIEW);
    armed.push(true);
    const dispatching = service.dispatch({
      ...REVIEW,
      confirmation: reviewed.confirmation,
    });
    await atBarrier;
    const ids = idsOf();
    expect(
      await service.resolve({ ...ids, confirmation: 'spans-resolve:any' })
    ).toMatchObject({ code: 'SPANS_EXEC_NOT_RESOLVABLE', ok: false });

    resume();
    expect((await dispatching).status).toBe('launched');
    expect(claim()).toMatchObject({ agent: 'spans' });
    await service.idle();
  });

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
    const launched = await restarted.dispatch({
      ...REVIEW,
      confirmation: again.confirmation,
    });
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
  });

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
