import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { observeProcessIdentity } from './process-observation.js';
import {
  approvedDispatchInput,
  createExecutionFixture,
  PROFILE,
  PROVIDER_FIXTURE,
  TARGET,
} from './spans-execution.test-support.js';
import { spansWorkerCapturePath } from './spans-worker-process.js';

// Parent lifecycle integration over the real detached capture process. The
// only provider is spans-execution.provider-fixture.js, a local process test
// fixture; these assertions are not provider acceptance.
const REVIEW = Object.freeze({
  instructions: 'Create fixture-output.txt in the checkout.',
  profile: PROFILE,
  runId: 'run-1',
  spanId: 'build',
  target: TARGET,
  wallClockMs: 30_000,
});
const SHA256_ARTIFACT_ID = /^sha256:[0-9a-f]{64}$/;

let fx;
afterEach(async () => {
  if (fx) {
    await fx.dispose();
  }
  fx = undefined;
});

const run = () => fx.store.readRun({ runId: 'run-1' }).view;
const events = (type) =>
  fx.store
    .readEvents({ limit: 200, runId: 'run-1' })
    .events.filter((event) => event.type === type);

function attempt() {
  return Object.values(run().attempts ?? {})[0] ?? null;
}

function bindingOf(record = attempt()) {
  return {
    actionId: record.actionId,
    attemptId: record.attemptId,
    generation: record.generation,
    runId: record.runId,
    spanId: record.spanId,
    workerId: record.workerId,
  };
}

function captureProcessPath(record = attempt()) {
  const descriptorPath = spansWorkerCapturePath({
    binding: bindingOf(record),
    root: fx.archive,
    tempRoot: fx.root,
  });
  return join(descriptorPath, '..', 'capture-process.json');
}

function captureProcess(record = attempt()) {
  const path = captureProcessPath(record);
  return existsSync(path)
    ? JSON.parse(readFileSync(path, 'utf8')).captureProcess
    : null;
}

function leaseSnapshot(status) {
  expect(status.leases).toHaveLength(1);
  return structuredClone(status.leases[0]);
}

async function waitFor(description, predicate, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  if (await predicate()) {
    return;
  }
  if (Date.now() >= deadline) {
    throw new Error(`timed out waiting for ${description}`);
  }
  // Poll the specific durable/process condition under test.
  await Bun.sleep(20);
  await waitFor(description, predicate, deadline - Date.now());
}

async function sameProcessIsAlive(start) {
  const observed = await observeProcessIdentity(start.pid);
  return (
    observed.state !== 'absent' &&
    (observed.state !== 'alive' ||
      observed.processStartIdentity === start.id ||
      `${start.pid}:${observed.processStartIdentity}` === start.id)
  );
}

async function preparedService(providerEnv = {}, review = REVIEW) {
  await fx.completeSetup();
  const service = fx.createService({
    provider: {
      command: [process.execPath, PROVIDER_FIXTURE],
      env: {
        SETU_FIXTURE_DELAY_MS: '250',
        SETU_FIXTURE_NO_EFFORT: '1',
        SETU_FIXTURE_PIDFILE: join(fx.root, 'provider-pids'),
        ...providerEnv,
      },
    },
  });
  expect(await service.probe({ profile: PROFILE })).toMatchObject({ ok: true });
  const input = await approvedDispatchInput(service, review);
  return { input, service };
}

describe('detached parent restart', () => {
  test('reconnects the same live capture, process, native session and shared lease', async () => {
    fx = createExecutionFixture();
    const { input, service } = await preparedService(
      { SETU_FIXTURE_DELAY_MS: '50' },
      {
        ...REVIEW,
        instructions:
          'MODE:stubborn\nCreate fixture-output.txt in the checkout.',
      }
    );
    const launched = await service.dispatch(input);
    if (launched.status !== 'launched') {
      throw new Error(
        JSON.stringify({
          code: launched.code,
          ok: launched.ok,
          reason: launched.reason,
          status: launched.status,
        })
      );
    }
    await waitFor('the provider native session and process receipt', () => {
      const current = attempt();
      return Boolean(current?.nativeId && current?.processStart?.pid);
    });
    const before = attempt();
    const beforeCapture = captureProcess(before);
    expect(Number.isSafeInteger(beforeCapture.pid)).toBe(true);
    expect(typeof beforeCapture.processStartIdentity).toBe('string');
    expect(fx.providerPids()).toContain(before.processStart.pid);
    const providerCount = fx.providerPids().length;
    const leaseBefore = leaseSnapshot(await fx.admission.status());

    await service.close();
    const restarted = fx.createService();
    const recovered = await restarted.reconcile();
    expect(recovered.ok).toBe(true);
    expect(attempt()).toMatchObject({
      nativeId: before.nativeId,
      processStart: before.processStart,
      status: 'running',
    });
    expect(captureProcess()).toEqual(beforeCapture);
    expect(fx.providerPids()).toHaveLength(providerCount);
    expect(leaseSnapshot(await fx.admission.status())).toEqual(leaseBefore);
    expect((await restarted.usage({ runId: 'run-1' })).heldCount).toBe(1);
    expect(events('spans.execution.captured')).toHaveLength(0);

    // Cancellation is a human-owned request after restart. Delivery alone is
    // deliberately nonterminal and cannot release the exact attempt's lease.
    const cancelled = await restarted.cancel({
      attemptId: before.attemptId,
      runId: before.runId,
    });
    expect(cancelled).toMatchObject({
      cancel: 'delivered',
      ok: true,
      terminal: false,
    });
    expect(attempt().status).toBe('running');
    expect(leaseSnapshot(await fx.admission.status())).toEqual(leaseBefore);
    expect((await restarted.usage({ runId: 'run-1' })).heldCount).toBe(1);
    expect(events('spans.worker.cancel.delivered')).toHaveLength(1);
  });

  test('records a complete child capture only after exit is verified by restart reconciliation', async () => {
    fx = createExecutionFixture();
    const { input, service } = await preparedService(
      {},
      {
        ...REVIEW,
        instructions:
          'MODE:controlled-success\nCreate fixture-output.txt in the checkout.',
      }
    );
    const launched = await service.dispatch(input);
    expect(launched).toMatchObject({ ok: true, status: 'launched' });
    await waitFor('the live attempt receipt', () =>
      Boolean(attempt()?.processStart?.pid)
    );
    const beforeClose = attempt();
    const child = captureProcess(beforeClose);
    expect(child?.pid).toEqual(expect.any(Number));
    const heldLease = leaseSnapshot(await fx.admission.status());

    await waitFor('the controlled fixture completion trigger', () =>
      existsSync(
        join(fx.root, `provider-pids.${beforeClose.processStart.pid}.ready`)
      )
    );
    await service.close();
    const owned = await observeProcessIdentity(beforeClose.processStart.pid);
    expect(`${owned.processId}:${owned.processStartIdentity}`).toBe(
      beforeClose.processStart.id
    );
    process.kill(beforeClose.processStart.pid, 'SIGUSR2');
    await waitFor(
      'the provider process to exit while its parent is closed',
      () => sameProcessIsAlive(beforeClose.processStart).then((alive) => !alive)
    );
    await waitFor(
      'the detached capture child verified terminal receipt',
      () => attempt()?.status === 'exited'
    );
    expect(attempt()).toMatchObject({ capture: { complete: true } });
    expect(
      fx.artifacts.read({ artifactId: attempt().capture.artifactId })
    ).toMatchObject({
      ok: true,
    });
    expect(events('spans.execution.captured')).toHaveLength(0);
    expect(leaseSnapshot(await fx.admission.status())).toEqual(heldLease);
    expect(run().actions[launched.actionId].state).toBe('intent');
    const restarted = fx.createService();
    expect((await restarted.usage({ runId: 'run-1' })).heldCount).toBe(1);
    const reconciled = await restarted.reconcile();
    expect(reconciled.ok).toBe(true);
    expect(attempt()).toMatchObject({
      receipt: { outcome: 'process-exited' },
      status: 'exited',
    });
    expect(events('spans.execution.captured')).toHaveLength(1);
    const {
      capture: { artifactId },
    } = attempt();
    expect(fx.artifacts.read({ artifactId })).toMatchObject({ ok: true });
    expect(run().actions[launched.actionId].state).toBe('completed');
    expect(run().spans.build.state).toBe('planned');
    expect(await restarted.usage({ runId: 'run-1' })).toMatchObject({
      heldCount: 0,
      outstandingReservationMicro: 0,
      unmeteredCount: 1,
    });
    expect((await fx.admission.status()).leases).toEqual([]);
    expect((await restarted.reconcile()).ok).toBe(true);
    expect(events('spans.execution.captured')).toHaveLength(1);
    expect(fx.providerPids()).toHaveLength(2); // one capability probe and one worker
  });

  test('preserves a confirmed spool-limit partial artifact as held history', async () => {
    fx = createExecutionFixture();
    await fx.completeSetup();
    const service = fx.createService({
      provider: {
        command: [process.execPath, PROVIDER_FIXTURE],
        env: {
          SETU_FIXTURE_DELAY_MS: '50',
          SETU_FIXTURE_NO_EFFORT: '1',
          SETU_FIXTURE_PIDFILE: join(fx.root, 'provider-pids'),
        },
      },
      workerLimits: { maxAttemptChunks: 2 },
    });
    expect(await service.probe({ profile: PROFILE })).toMatchObject({
      ok: true,
    });
    const input = await approvedDispatchInput(service, {
      ...REVIEW,
      instructions: 'MODE:chatty\nCreate fixture-output.txt in the checkout.',
    });
    const launched = await service.dispatch(input);
    if (launched.ok !== true) {
      expect(launched).toMatchObject({
        code: 'LAUNCH_UNKNOWN',
        retryAllowed: false,
        status: 'held',
      });
    }
    await waitFor('the confirmed partial capture receipt', () => {
      const current = attempt();
      return (
        current?.status === 'held' &&
        current.exit !== null &&
        current.capture.artifactId !== null &&
        events('spans.execution.captured').length === 1
      );
    });
    expect((await service.idle()).ok).toBe(false);

    const partial = attempt();
    expect(partial).toMatchObject({
      capture: { complete: false, gap: { reason: 'spool-limit' } },
      status: 'held',
    });
    expect(partial.capture.artifactId).toMatch(SHA256_ARTIFACT_ID);
    expect(
      fx.artifacts.read({ artifactId: partial.capture.artifactId })
    ).toMatchObject({
      ok: true,
    });
    expect(run().actions[partial.actionId].state).toBe('unknown');
    const leaseBefore = leaseSnapshot(await fx.admission.status());
    expect((await service.usage({ runId: 'run-1' })).heldCount).toBe(1);
    expect(events('spans.execution.captured')).toHaveLength(1);
    expect(events('spans.completion.accepted')).toHaveLength(0);

    await service.close();
    const restarted = fx.createService();
    expect((await restarted.reconcile()).ok).toBe(true);
    expect(attempt()).toMatchObject({
      capture: { artifactId: partial.capture.artifactId, complete: false },
      status: 'held',
    });
    expect(leaseSnapshot(await fx.admission.status())).toEqual(leaseBefore);
    expect((await restarted.usage({ runId: 'run-1' })).heldCount).toBe(1);
    expect(run().actions[partial.actionId].state).toBe('unknown');
    expect(events('spans.completion.accepted')).toHaveLength(0);
    expect(events('spans.execution.captured')).toHaveLength(1);
  });
});
