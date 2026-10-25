import { afterEach, expect, test } from 'bun:test';
import { spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSpansActions } from './spans-actions.js';
import { createSpansArtifacts } from './spans-artifacts.js';
import { openSpansStore } from './spans-store.js';
import { createSpansWorkerHost } from './spans-worker-host.js';

const LIMITS = Object.freeze({
  maxActiveAttempts: 2,
  maxAttemptBytes: 4096,
  maxAttemptChunks: 20,
  maxChunkBytes: 1024,
  maxDeadlineMs: 60_000,
  maxQueueBytes: 2048,
});
const roots = [];
const fixtureProcesses = new Set();

afterEach(async () => {
  for (const child of fixtureProcesses) {
    try {
      process.kill(child.pid, 'SIGUSR2');
    } catch {
      // The disposable fixture may already have exited.
    }
  }
  await Promise.all(
    [...fixtureProcesses].map(
      (child) =>
        new Promise((resolve) => {
          if (child.exitCode !== null) {
            resolve();
            return;
          }
          child.once('exit', resolve);
          setTimeout(resolve, 1000).unref();
        })
    )
  );
  fixtureProcesses.clear();
  for (const root of roots.splice(0)) {
    rmSync(root, { force: true, recursive: true });
  }
});

function makeRoot() {
  const root = mkdtempSync(join(tmpdir(), 'spans-worker-host-'));
  chmodSync(root, 0o700);
  roots.push(root);
  return root;
}

const initialView = {
  actions: {},
  checkpoint: 0,
  generation: 0,
  planVersion: 1,
  runId: 'run-host',
  spans: { task: { dependencies: [], spanId: 'task', state: 'ready' } },
};

function openSeededStore(root) {
  const store = openSpansStore({ root });
  const seeded = store.commitRun({
    events: [],
    expectedGeneration: 0,
    expectedRevision: 0,
    runId: initialView.runId,
    view: initialView,
  });
  expect(seeded.ok).toBe(true);
  const actions = createSpansActions({ now: () => 100, store });
  return { actions, store };
}

function prepareAction(actions) {
  return actions.prepareAction({
    actionId: 'action-host',
    attemptId: 'attempt-host',
    generation: 0,
    inputDigest: 'a'.repeat(64),
    planVersion: 1,
    runId: 'run-host',
    spanId: 'task',
    targetDigest: 'b'.repeat(64),
  });
}

function fakeLauncher(effects = []) {
  return {
    launch(request) {
      effects.push({ binding: request.binding, kind: 'launch' });
      return {
        handle: { id: 'fixture-handle' },
        ok: true,
        processStart: { id: 'fixture-process', pid: 4242 },
      };
    },
    stop(request) {
      effects.push({ binding: request.binding, kind: 'stop' });
      return { ok: true };
    },
  };
}

function makeHost(root, launcher, extra = {}) {
  return createSpansWorkerHost({
    clock: { now: () => 200 },
    launcher,
    limits: LIMITS,
    preflight: async () => ({ ok: true }),
    root,
    workerId: 'worker-host',
    ...extra,
  });
}

test('host refuses a missing archive without creating or initializing it', () => {
  const parent = makeRoot();
  const missing = join(parent, 'archive');
  expect(() => makeHost(missing, fakeLauncher())).toThrow();
  expect(() => statSync(missing)).toThrow();
});

test('host recovery rejects proxies and accessors without invoking them', async () => {
  const root = makeRoot();
  const { store } = openSeededStore(root);
  const host = makeHost(root, fakeLauncher());
  let getterCalls = 0;
  const throwingAccessorInput = Object.defineProperty({}, 'runId', {
    get() {
      getterCalls += 1;
      throw new Error('malformed accessor');
    },
  });
  expect(await host.recover(throwingAccessorInput)).toMatchObject({
    code: 'RECOVERY_UNKNOWN',
    ok: false,
    unknown: true,
  });
  const accessorInput = Object.defineProperty({}, 'runId', {
    get() {
      getterCalls += 1;
      return 'run-host';
    },
  });
  expect(await host.recover(accessorInput)).toMatchObject({
    code: 'RECOVERY_UNKNOWN',
    ok: false,
    unknown: true,
  });
  expect(getterCalls).toBe(0);
  let proxyTrapCalls = 0;
  const proxyInput = new Proxy(
    { attemptId: 'attempt-host', generation: 0, runId: 'run-host' },
    {
      get() {
        proxyTrapCalls += 1;
        return 'run-host';
      },
      getOwnPropertyDescriptor() {
        proxyTrapCalls += 1;
        return { configurable: true, enumerable: true, value: 'run-host' };
      },
      ownKeys() {
        proxyTrapCalls += 1;
        return ['attemptId', 'generation', 'runId'];
      },
    }
  );
  expect(await host.recover(proxyInput)).toMatchObject({
    code: 'RECOVERY_UNKNOWN',
    ok: false,
    unknown: true,
  });
  expect(proxyTrapCalls).toBe(0);
  const revokedInput = Proxy.revocable({}, {});
  revokedInput.revoke();
  expect(await host.recover(revokedInput.proxy)).toMatchObject({
    code: 'RECOVERY_UNKNOWN',
    ok: false,
    unknown: true,
  });
  expect(host.close()).toEqual({ ok: true });
  store.close();
});

test('invalid archive write gate fails closed before opening the archive', () => {
  const parent = makeRoot();
  const missing = join(parent, 'missing');
  expect(() =>
    makeHost(missing, fakeLauncher(), { archiveWrite: true })
  ).toThrow('archiveWrite must be a function');
  expect(() => statSync(missing)).toThrow();
});

test('archive gate wraps writes, refuses without writing, and leaves reads ungated', async () => {
  const root = makeRoot();
  const { actions, store } = openSeededStore(root);
  await prepareAction(actions);
  const calls = [];
  const deniedWrites = new Set();
  let gateId = 0;
  const gate = async (request, effect) => {
    gateId += 1;
    const id = gateId;
    calls.push({
      id,
      maxBytes: request.maxBytes,
      root: request.root,
      type: 'gate',
    });
    if (deniedWrites.delete('next')) {
      calls.push({ id, type: 'denied' });
      return { code: 'SPANS_ARCHIVE_CAPACITY_REACHED', ok: false };
    }
    calls.push({ id, maxBytes: request.maxBytes, type: 'effect' });
    return { ok: true, value: await effect() };
  };
  const stops = [];
  const host = makeHost(
    root,
    {
      ...fakeLauncher(),
      stop(request) {
        stops.push(request);
        return { ok: true };
      },
    },
    { archiveWrite: gate }
  );

  await host.inspect();
  expect(calls).toEqual([]);
  const started = await host.start({
    actionId: 'action-host',
    attemptId: 'attempt-host',
    deadlineMs: 5000,
    generation: 0,
    runId: 'run-host',
    spanId: 'task',
  });
  expect(started).toMatchObject({ ok: true, status: 'running' });
  deniedWrites.add('next');
  expect(
    await host.captureChunk({ ...started.ref, seq: 0, text: 'refused\n' })
  ).toMatchObject({ code: 'SPOOL_LIMIT', ok: false });
  expect(stops).toHaveLength(1);
  expect(
    store.readRun({ runId: 'run-host' }).view.attempts['attempt-host']
  ).toMatchObject({ cancel: { state: 'delivered' }, status: 'held' });
  const refusedAppend = calls.find((call) => call.type === 'denied');
  expect(refusedAppend).toBeDefined();
  expect(
    calls.filter(
      (call) => call.type === 'effect' && call.id === refusedAppend.id
    )
  ).toHaveLength(0);
  expect(calls.some((call) => call.type === 'effect')).toBe(true);
  expect(host.close()).toMatchObject({
    code: 'SPANS_WORKER_ATTEMPTS_ACTIVE',
    ok: false,
  });
  store.close();
});

test('archive gate runs before spool current-attempt fencing', async () => {
  const root = makeRoot();
  const { actions, store } = openSeededStore(root);
  await prepareAction(actions);
  const events = [];
  const observedWrites = new Set();
  const gate = async (_request, effect) => {
    const chunkWrite = observedWrites.delete('next');
    if (chunkWrite) {
      events.push('gate');
      const authority = store.withCurrentAttempt(
        {
          actionId: 'action-host',
          attemptId: 'attempt-host',
          generation: 0,
          runId: 'run-host',
          spanId: 'task',
          workerId: 'worker-host',
        },
        () => {
          events.push('fence');
          return { ok: true };
        }
      );
      expect(authority).toEqual({ ok: true });
    }
    const value = await effect();
    if (chunkWrite) {
      events.push('write');
    }
    return { ok: true, value };
  };
  const host = makeHost(root, fakeLauncher(), { archiveWrite: gate });
  const started = await host.start({
    actionId: 'action-host',
    attemptId: 'attempt-host',
    deadlineMs: 5000,
    generation: 0,
    runId: 'run-host',
    spanId: 'task',
  });
  expect(started.ok).toBe(true);
  observedWrites.add('next');
  expect(
    await host.captureChunk({ ...started.ref, seq: 0, text: 'fenced\n' })
  ).toMatchObject({ ok: true });
  expect(events).toEqual(['gate', 'fence', 'write']);
  await host.observeExit({
    ...started.ref,
    exit: { code: 0, signal: null },
  });
  expect(host.close()).toEqual({ ok: true });
  store.close();
});

test('archive gate errors fail closed before recording intent or launching', async () => {
  const root = makeRoot();
  const { actions, store } = openSeededStore(root);
  await prepareAction(actions);
  const effects = [];
  const host = makeHost(root, fakeLauncher(effects), {
    archiveWrite: () => {
      throw new Error('fixture gate failure');
    },
  });
  const result = await host.start({
    actionId: 'action-host',
    attemptId: 'attempt-host',
    deadlineMs: 5000,
    generation: 0,
    runId: 'run-host',
    spanId: 'task',
  });
  expect(result.ok).toBe(false);
  expect(effects).toEqual([]);
  const read = store.readRun({ runId: 'run-host' });
  expect(read.ok).toBe(true);
  expect(read.view.attempts?.['attempt-host']).toBeUndefined();
  expect(host.close()).toEqual({ ok: true });
  store.close();
});

test('real archive action intent, fenced launch, spool and artifact survive reopen', async () => {
  const root = makeRoot();
  const { actions, store } = openSeededStore(root);
  expect(await prepareAction(actions)).toMatchObject({
    ok: true,
    status: 'intent',
  });
  const effects = [];
  const host = makeHost(root, fakeLauncher(effects));

  const started = await host.start({
    actionId: 'action-host',
    attemptId: 'attempt-host',
    deadlineMs: 5000,
    generation: 0,
    runId: 'run-host',
    spanId: 'task',
  });
  expect(started).toMatchObject({ ok: true, status: 'running' });
  expect(effects).toHaveLength(1);
  expect(host.close()).toMatchObject({
    code: 'SPANS_WORKER_ATTEMPTS_ACTIVE',
    ok: false,
  });

  expect(
    await host.captureChunk({ ...started.ref, seq: 0, text: 'fixture log\n' })
  ).toMatchObject({ ok: true });
  const exited = await host.observeExit({
    ...started.ref,
    exit: { code: 0, signal: null },
  });
  expect(exited).toMatchObject({ ok: true, status: 'exited' });
  const { artifactId } = exited.receipt.capture;
  expect(createSpansArtifacts({ root }).read({ artifactId })).toMatchObject({
    ok: true,
    text: 'fixture log\n',
  });

  expect(host.close()).toEqual({ ok: true });
  store.close();
  const reopened = openSpansStore({ readonly: true, root });
  expect(
    reopened.readRun({ runId: 'run-host' }).view.attempts['attempt-host']
  ).toMatchObject({
    capture: { artifactId, chunks: 1, complete: true },
    status: 'exited',
  });
  expect(reopened.close()).toEqual({ ok: true });
});

test('reopened host observes the original worker and holds only after confirmed absence', async () => {
  const root = makeRoot();
  const { actions, store } = openSeededStore(root);
  expect(await prepareAction(actions)).toMatchObject({
    ok: true,
    status: 'intent',
  });
  const marker = join(root, 'worker-fixture');
  const fixturePath = join(
    dirname(fileURLToPath(import.meta.url)),
    'spans-worker-process.fixture.js'
  );
  const child = spawn(process.execPath, [fixturePath, marker], {
    stdio: 'ignore',
  });
  fixtureProcesses.add(child);
  const readyDeadline = Date.now() + 3000;
  const waitForReady = async () => {
    if (existsSync(`${marker}.ready`)) {
      return true;
    }
    if (Date.now() >= readyDeadline) {
      return false;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
    return waitForReady();
  };
  expect(await waitForReady()).toBe(true);
  const identity = 'Mon Oct 19 10:00:00 2026';
  const processStart = { id: `${child.pid}:${identity}`, pid: child.pid };
  let observationState = 'alive';
  const observeProcess = (pid) => {
    if (observationState === 'unknown') {
      return { state: 'unknown' };
    }
    try {
      process.kill(pid, 0);
      return {
        processId: pid,
        processStartIdentity:
          observationState === 'mismatch'
            ? 'Tue Oct 20 10:00:00 2026'
            : identity,
        state: 'alive',
      };
    } catch (error) {
      return { state: error.code === 'ESRCH' ? 'absent' : 'unknown' };
    }
  };
  const first = makeHost(
    root,
    {
      launch: () => ({
        ok: true,
        processStart,
      }),
    },
    { observeProcess }
  );
  const started = await first.start({
    actionId: 'action-host',
    attemptId: 'attempt-host',
    deadlineMs: 5000,
    generation: 0,
    runId: 'run-host',
    spanId: 'task',
  });
  expect(started).toMatchObject({ ok: true, status: 'running' });

  let duplicateLaunches = 0;
  const stopCalls = [];
  const reopened = makeHost(
    root,
    {
      launch() {
        duplicateLaunches += 1;
        return { ok: true, processStart };
      },
      stop(request) {
        stopCalls.push(request);
        return { ok: true };
      },
    },
    { observeProcess }
  );
  let resolveObservation;
  let signalObservationStarted;
  const observationStarted = new Promise((resolve) => {
    signalObservationStarted = resolve;
  });
  let observationCalls = 0;
  const pendingHost = makeHost(root, fakeLauncher(), {
    observeProcess: () => {
      observationCalls += 1;
      signalObservationStarted();
      return new Promise((resolve) => {
        resolveObservation = resolve;
      });
    },
  });
  const pendingRecovery = pendingHost.recover({
    attemptId: 'attempt-host',
    generation: 0,
    runId: 'run-host',
  });
  await observationStarted;
  expect(pendingHost.close()).toMatchObject({
    code: 'SPANS_WORKER_ATTEMPTS_ACTIVE',
    ok: false,
  });
  resolveObservation({
    processId: child.pid,
    processStartIdentity: identity,
    state: 'alive',
  });
  expect(await pendingRecovery).toMatchObject({
    decision: 'reattach-required',
    ok: true,
    status: 'worker-alive',
  });
  expect(pendingHost.close()).toEqual({ ok: true });
  expect(
    await pendingHost.recover({
      attemptId: 'attempt-host',
      generation: 0,
      runId: 'run-host',
    })
  ).toEqual({ code: 'HOST_CLOSED', ok: false });
  expect(observationCalls).toBe(1);
  expect(
    await reopened.start({
      actionId: 'action-host',
      attemptId: 'attempt-host',
      deadlineMs: 5000,
      generation: 0,
      runId: 'run-host',
      spanId: 'task',
    })
  ).toMatchObject({ ok: true, retryAllowed: false, unresolved: true });
  expect(duplicateLaunches).toBe(0);
  expect(
    await reopened.recover({
      attemptId: 'attempt-host',
      generation: 0,
      runId: 'run-host',
    })
  ).toMatchObject({
    decision: 'reattach-required',
    ok: true,
    status: 'worker-alive',
  });
  observationState = 'unknown';
  expect(
    await reopened.recover({
      attemptId: 'attempt-host',
      generation: 0,
      runId: 'run-host',
    })
  ).toMatchObject({
    code: 'RECOVERY_PROCESS_UNKNOWN',
    ok: false,
    unknown: true,
  });
  observationState = 'mismatch';
  expect(
    await reopened.recover({
      attemptId: 'attempt-host',
      generation: 0,
      runId: 'run-host',
    })
  ).toMatchObject({
    code: 'RECOVERY_PROCESS_IDENTITY_MISMATCH',
    ok: false,
    unknown: true,
  });
  expect(stopCalls).toHaveLength(0);
  expect(duplicateLaunches).toBe(0);
  expect(
    store.readRun({ runId: 'run-host' }).view.attempts['attempt-host'].status
  ).toBe('running');

  observationState = 'alive';
  process.kill(child.pid, 'SIGUSR2');
  await new Promise((resolve) => child.once('exit', resolve));
  expect(
    await reopened.recover({
      attemptId: 'attempt-host',
      generation: 0,
      runId: 'run-host',
    })
  ).toMatchObject({ held: true, ok: true, status: 'held' });
  expect(
    store.readRun({ runId: 'run-host' }).view.attempts['attempt-host']
  ).toMatchObject({
    receipt: { outcome: 'unknown', ownershipReleased: false },
    status: 'held',
  });
  expect(
    await reopened.start({
      actionId: 'action-host',
      attemptId: 'attempt-host',
      deadlineMs: 5000,
      generation: 0,
      runId: 'run-host',
      spanId: 'task',
    })
  ).toMatchObject({
    created: false,
    ok: true,
    receipt: { outcome: 'unknown', ownershipReleased: false },
    status: 'held',
  });
  expect(duplicateLaunches).toBe(0);
  expect(stopCalls).toHaveLength(0);
  expect(reopened.close()).toEqual({ ok: true });
  expect(first.close()).toMatchObject({ ok: false });
  store.close();
});

test('changed generation fences launch and spool append at their effect boundaries', async () => {
  const root = makeRoot();
  const { actions, store } = openSeededStore(root);
  await prepareAction(actions);
  const effects = [];
  const host = makeHost(root, fakeLauncher(effects));

  const current = store.readRun({ runId: 'run-host' });
  expect(
    store.commitRun({
      events: [],
      expectedGeneration: 0,
      expectedRevision: current.revision,
      runId: 'run-host',
      view: { ...current.view, generation: 1 },
    }).ok
  ).toBe(true);
  const staleStart = await host.start({
    actionId: 'action-host',
    attemptId: 'attempt-host',
    deadlineMs: 5000,
    generation: 0,
    runId: 'run-host',
    spanId: 'task',
  });
  expect(staleStart.ok).toBe(false);
  expect(effects).toEqual([]);

  expect(host.close()).toEqual({ ok: true });
  store.close();
});

test('wrong action binding is refused without a provider effect', async () => {
  const root = makeRoot();
  const { actions, store } = openSeededStore(root);
  await prepareAction(actions);
  const effects = [];
  const host = makeHost(root, fakeLauncher(effects));
  const result = await host.start({
    actionId: 'action-host',
    attemptId: 'different-attempt',
    deadlineMs: 5000,
    generation: 0,
    runId: 'run-host',
    spanId: 'task',
  });
  expect(result).toMatchObject({ code: 'ACTION_BINDING_MISMATCH', ok: false });
  expect(effects).toEqual([]);
  expect(host.close()).toEqual({ ok: true });
  store.close();
});

test('generation change after launch fences append and keeps the attempt unresolved', async () => {
  const root = makeRoot();
  const { actions, store } = openSeededStore(root);
  await prepareAction(actions);
  const effects = [];
  const host = makeHost(root, fakeLauncher(effects));
  const started = await host.start({
    actionId: 'action-host',
    attemptId: 'attempt-host',
    deadlineMs: 5000,
    generation: 0,
    runId: 'run-host',
    spanId: 'task',
  });
  expect(started.ok).toBe(true);

  const current = store.readRun({ runId: 'run-host' });
  expect(
    store.commitRun({
      events: [],
      expectedGeneration: 0,
      expectedRevision: current.revision,
      runId: 'run-host',
      view: { ...current.view, generation: 1 },
    }).ok
  ).toBe(true);
  expect(
    await host.captureChunk({
      ...started.ref,
      seq: 0,
      text: 'must not persist\n',
    })
  ).toMatchObject({ code: 'STALE_GENERATION', ok: false });
  expect(effects).toHaveLength(1);
  expect(
    store.readRun({ runId: 'run-host' }).view.attempts['attempt-host']
  ).toMatchObject({ capture: { chunks: 0 }, status: 'running' });
  expect(host.close()).toMatchObject({
    code: 'SPANS_WORKER_ATTEMPTS_ACTIVE',
    ok: false,
  });
  store.close();
});

test('the launcher sink terminal receipt releases host ownership after durable finalization', async () => {
  const root = makeRoot();
  const { actions, store } = openSeededStore(root);
  await prepareAction(actions);
  let sink;
  const host = makeHost(root, {
    launch(request) {
      ({ sink } = request);
      return { ok: true, processStart: { id: 'owned-process', pid: 4242 } };
    },
  });
  const started = await host.start({
    actionId: 'action-host',
    attemptId: 'attempt-host',
    deadlineMs: 5000,
    generation: 0,
    runId: 'run-host',
    spanId: 'task',
  });
  expect(started.ok).toBe(true);
  expect((await sink.chunk('captured through launcher\n')).ok).toBe(true);
  expect((await sink.exit({ code: 0, signal: null })).ok).toBe(true);
  expect(host.close()).toEqual({ ok: true });
  expect(
    store.readRun({ runId: 'run-host' }).view.attempts['attempt-host'].status
  ).toBe('exited');
  store.close();
});

test('a rejected asynchronous stop stays unknown and retains live ownership', async () => {
  const root = makeRoot();
  const { actions, store } = openSeededStore(root);
  expect((await prepareAction(actions)).ok).toBe(true);
  const host = makeHost(root, {
    ...fakeLauncher(),
    stop: () => Promise.reject(new Error('broken synchronous stop contract')),
  });
  const started = await host.start({
    actionId: 'action-host',
    attemptId: 'attempt-host',
    deadlineMs: 5000,
    generation: 0,
    runId: 'run-host',
    spanId: 'task',
  });
  expect(started.ok).toBe(true);
  expect(await host.cancel(started.ref)).toMatchObject({
    cancel: 'unknown',
    ok: false,
  });
  await new Promise((resolve) => setImmediate(resolve));
  expect(host.close()).toMatchObject({
    code: 'SPANS_WORKER_ATTEMPTS_ACTIVE',
    ok: false,
  });
  expect(
    await host.observeExit({
      ...started.ref,
      exit: { code: 0, signal: null },
    })
  ).toMatchObject({ ok: true, status: 'exited' });
  expect(host.close()).toEqual({ ok: true });
  store.close();
});

test('capture exhaustion stops under the real current-attempt fence before holding', async () => {
  const root = makeRoot();
  const { actions, store } = openSeededStore(root);
  expect((await prepareAction(actions)).ok).toBe(true);
  const stops = [];
  const host = createSpansWorkerHost({
    clock: { now: () => 200 },
    launcher: {
      ...fakeLauncher(),
      stop(request) {
        stops.push(request);
        expect(
          store.readRun({ runId: 'run-host' }).view.attempts['attempt-host']
        ).toMatchObject({
          cancel: { state: 'requested' },
          status: 'running',
        });
        return { ok: true };
      },
    },
    limits: { ...LIMITS, maxAttemptChunks: 1 },
    preflight: async () => ({ ok: true }),
    root,
    workerId: 'worker-host',
  });
  const started = await host.start({
    actionId: 'action-host',
    attemptId: 'attempt-host',
    deadlineMs: 5000,
    generation: 0,
    runId: 'run-host',
    spanId: 'task',
  });
  expect(started.ok).toBe(true);
  expect(
    (await host.captureChunk({ ...started.ref, seq: 0, text: 'kept\n' })).ok
  ).toBe(true);
  expect(
    await host.captureChunk({ ...started.ref, seq: 1, text: 'exhausted\n' })
  ).toMatchObject({
    cancel: 'delivered',
    code: 'SPOOL_LIMIT',
    held: true,
    ok: false,
  });
  expect(stops).toHaveLength(1);
  expect(stops[0].processStartId).toBe('fixture-process');
  expect(
    store.readRun({ runId: 'run-host' }).view.attempts['attempt-host']
  ).toMatchObject({
    cancel: { state: 'delivered' },
    status: 'held',
  });
  expect(host.close()).toMatchObject({
    code: 'SPANS_WORKER_ATTEMPTS_ACTIVE',
    ok: false,
  });
  store.close();
});

test('shared archive authority is rechecked at the native launch boundary', async () => {
  const root = makeRoot();
  const { actions, store } = openSeededStore(root);
  await prepareAction(actions);
  const effects = [];
  let refused = false;
  const host = makeHost(root, fakeLauncher(effects), {
    archiveWrite: async (_request, effect) => {
      const attempt = store.readRun({ runId: 'run-host' }).view.attempts?.[
        'attempt-host'
      ];
      if (!refused && attempt?.status === 'launching') {
        refused = true;
        return { code: 'LEASE_MISMATCH', ok: false };
      }
      return { ok: true, value: await effect() };
    },
  });
  const result = await host.start({
    actionId: 'action-host',
    attemptId: 'attempt-host',
    deadlineMs: 5000,
    generation: 0,
    runId: 'run-host',
    spanId: 'task',
  });
  expect(result.ok).toBe(false);
  expect(effects).toEqual([]);
  store.close();
});

test('owned exit after capture exhaustion stays held but records process exit', async () => {
  const root = makeRoot();
  const { actions, store } = openSeededStore(root);
  await prepareAction(actions);
  let sink;
  const host = makeHost(
    root,
    {
      ...fakeLauncher(),
      launch(request) {
        ({ sink } = request);
        return { ok: true, processStart: { id: 'owned-process', pid: 4242 } };
      },
    },
    { limits: { ...LIMITS, maxAttemptChunks: 1 } }
  );
  expect(
    (
      await host.start({
        actionId: 'action-host',
        attemptId: 'attempt-host',
        deadlineMs: 5000,
        generation: 0,
        runId: 'run-host',
        spanId: 'task',
      })
    ).ok
  ).toBe(true);
  expect((await sink.chunk('first\n')).ok).toBe(true);
  expect(await sink.chunk('second\n')).toMatchObject({
    code: 'SPOOL_LIMIT',
    ok: false,
  });
  expect(host.close().ok).toBe(false);
  expect(await sink.exit({ code: null, signal: 'SIGTERM' })).toMatchObject({
    ok: true,
    processExited: true,
    status: 'held',
  });
  expect(await sink.exit({ code: null, signal: 'SIGTERM' })).toMatchObject({
    duplicate: true,
    ok: true,
    processExited: true,
    status: 'held',
  });
  expect(await sink.exit({ code: 0, signal: null })).toMatchObject({
    code: 'EXIT_CONFLICT',
    ok: false,
  });
  const attempt = store.readRun({ runId: 'run-host' }).view.attempts[
    'attempt-host'
  ];
  expect(attempt).toMatchObject({
    capture: { complete: false, gap: { reason: 'spool-limit' } },
    exit: { code: null, signal: 'SIGTERM' },
    status: 'held',
  });
  expect(host.close()).toEqual({ ok: true });
  store.close();
});

async function runCaptureFailureAfterAppend({ appendEffectRuns }) {
  const root = makeRoot();
  const { actions, store } = openSeededStore(root);
  await prepareAction(actions);
  let sink;
  let failNextAppend = false;
  const stops = [];
  const host = makeHost(
    root,
    {
      ...fakeLauncher(),
      launch(request) {
        ({ sink } = request);
        return { ok: true, processStart: { id: 'owned-process', pid: 4242 } };
      },
      stop(request) {
        stops.push(request);
        return { ok: true };
      },
    },
    {
      archiveWrite: async (_request, effect) => {
        // biome-ignore lint/suspicious/noUnnecessaryConditions: The fixture arms this one-shot failure after the host starts.
        if (failNextAppend) {
          failNextAppend = false;
          if (appendEffectRuns) {
            expect((await effect()).ok).toBe(true);
          }
          return {
            code: 'SPANS_ARCHIVE_WRITE_UNKNOWN',
            ok: false,
            unknown: true,
          };
        }
        return { ok: true, value: await effect() };
      },
    }
  );
  const started = await host.start({
    actionId: 'action-host',
    attemptId: 'attempt-host',
    deadlineMs: 5000,
    generation: 0,
    runId: 'run-host',
    spanId: 'task',
  });
  expect(started.ok).toBe(true);
  expect((await sink.chunk('durable prefix\n')).ok).toBe(true);
  const cancel = await host.cancel(started.ref);
  failNextAppend = true;
  const failed = await sink.chunk('uncertain append\n');
  const exit = await sink.exit({ code: null, signal: 'SIGTERM' });
  const { view } = store.readRun({ runId: 'run-host' });
  const attempt = view.attempts['attempt-host'];
  const artifact = attempt.capture.artifactId
    ? createSpansArtifacts({ root }).read({
        artifactId: attempt.capture.artifactId,
      })
    : null;
  const closed = host.close();
  store.close();
  return { artifact, attempt, cancel, closed, exit, failed, stops, view };
}

test('a refused append finalizes only the proven prefix and records an owned held exit', async () => {
  const result = await runCaptureFailureAfterAppend({
    appendEffectRuns: false,
  });

  expect(result.failed).toMatchObject({
    code: 'CAPTURE_FAILED',
    held: true,
    ok: false,
  });
  expect(result.cancel).toMatchObject({ cancel: 'delivered', ok: true });
  expect(result.stops).toMatchObject([
    {
      binding: {
        actionId: 'action-host',
        attemptId: 'attempt-host',
        generation: 0,
        runId: 'run-host',
        spanId: 'task',
        workerId: 'worker-host',
      },
      processStartId: 'owned-process',
    },
  ]);
  expect(result.exit).toMatchObject({
    ok: true,
    processExited: true,
    status: 'held',
  });
  expect(result.attempt).toMatchObject({
    cancel: { state: 'delivered' },
    capture: {
      bytes: 'durable prefix\n'.length,
      chunks: 1,
      complete: false,
      countsConfirmed: true,
      gap: { fromSeq: 1, reason: 'capture-failed' },
    },
    exit: { code: null, signal: 'SIGTERM' },
    receipt: {
      outcome: 'unknown',
      ownershipReleased: false,
      reason: 'capture-failed',
      retryEligible: false,
      status: 'held',
      workAccepted: false,
    },
    status: 'held',
  });
  expect(result.artifact).toMatchObject({ ok: true, text: 'durable prefix\n' });
  expect(result.view.completions?.['action-host']).toBeUndefined();
  expect(result.closed).toEqual({ ok: true });
});

test('an append effect with a lost acknowledgement leaves held counts unknown after owned exit', async () => {
  const result = await runCaptureFailureAfterAppend({ appendEffectRuns: true });

  expect(result.failed).toMatchObject({
    code: 'CAPTURE_FAILED',
    held: true,
    ok: false,
  });
  expect(result.cancel).toMatchObject({ cancel: 'delivered', ok: true });
  expect(result.exit).toMatchObject({
    ok: true,
    processExited: true,
    status: 'held',
  });
  expect(result.attempt).toMatchObject({
    cancel: { state: 'delivered' },
    capture: {
      complete: false,
      countsConfirmed: false,
      gap: { fromSeq: 1, reason: 'capture-failed' },
    },
    exit: { code: null, signal: 'SIGTERM' },
    receipt: {
      outcome: 'unknown',
      ownershipReleased: false,
      reason: 'capture-failed',
      retryEligible: false,
      status: 'held',
      workAccepted: false,
    },
    status: 'held',
  });
  expect(result.attempt.capture.artifactId).toBeNull();
  expect(result.view.completions?.['action-host']).toBeUndefined();
  expect(result.closed).toEqual({ ok: true });
});
