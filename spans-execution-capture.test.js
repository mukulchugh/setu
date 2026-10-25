import { afterEach, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSpansActions } from './spans-actions.js';
import { createSpansArtifacts } from './spans-artifacts.js';
import { createSpansDrafts } from './spans-drafts.js';
import { createSpansExecutionCapture } from './spans-execution-capture.js';
import { createSpansExecutionSpool } from './spans-execution-process.js';
import { openSpansStore } from './spans-store.js';
import { createSpansWorker } from './spans-worker.js';

const LIMITS = Object.freeze({
  maxActiveAttempts: 2,
  maxAttemptBytes: 16_384,
  maxAttemptChunks: 8,
  maxChunkBytes: 4096,
  maxDeadlineMs: 60_000,
  maxQueueBytes: 8192,
});
const roots = new Set();
const digest = (value) => createHash('sha256').update(value).digest('hex');
const capturedId = (runId, attemptId) =>
  `spans.execution.captured:${digest(JSON.stringify([runId, attemptId]))}`;

afterEach(() => {
  for (const root of roots) {
    rmSync(root, { force: true, recursive: true });
    roots.delete(root);
  }
});

async function fixture({
  onExitGate = null,
  onHoldGate = null,
  pollIntervalMs = 10_000,
  workerLimits = LIMITS,
} = {}) {
  const root = mkdtempSync(join(tmpdir(), 'setu-spans-capture-adapter-'));
  roots.add(root);
  const archiveRoot = join(root, 'archive');
  const tempRoot = join(root, 'capture-temp');
  mkdirSync(archiveRoot, { mode: 0o700 });
  mkdirSync(tempRoot, { mode: 0o700 });
  const store = openSpansStore({ root: archiveRoot });
  const artifacts = createSpansArtifacts({ root: archiveRoot });
  const spool = createSpansExecutionSpool({ artifacts, root: archiveRoot });
  const drafts = createSpansDrafts({ store });
  const actions = createSpansActions({ now: () => 1000, store });
  const runId = 'run-capture';
  const actionId = 'action-build';
  const attemptId = 'attempt-build';
  const spanId = 'build';
  const created = drafts.createRun({
    goal: 'Implement capture adapter',
    owner: 'test',
    runId,
    spans: [{ dependencies: [], spanId, title: 'Build the adapter' }],
  });
  if (!created.ok) {
    throw new Error(`draft fixture failed: ${created.code}`);
  }
  const prepared = await actions.prepareAction({
    actionId,
    attemptId,
    generation: 0,
    inputDigest: 'a'.repeat(64),
    planVersion: 1,
    runId,
    spanId,
    targetDigest: 'b'.repeat(64),
  });
  if (!prepared?.ok) {
    throw new Error(`action fixture failed: ${prepared?.code}`);
  }
  const execution = {
    actionId,
    approvalDigest: 'c'.repeat(64),
    attemptId,
    reviewRef: { reviewDigest: 'd'.repeat(64), runId },
    runId,
    spanId,
    wallClockMs: 30_000,
  };
  const beforeExecution = store.readRun({ runId });
  const view = structuredClone(beforeExecution.view);
  view.executions = { [actionId]: execution };
  const storedExecution = store.commitRun({
    events: [],
    expectedGeneration: beforeExecution.generation,
    expectedRevision: beforeExecution.revision,
    runId,
    view,
  });
  if (!storedExecution.ok) {
    throw new Error(`execution fixture failed: ${storedExecution.code}`);
  }

  const binding = Object.freeze({
    actionId,
    attemptId,
    generation: 0,
    runId,
    spanId,
    workerId: 'capture-worker',
  });
  const state = {
    approvalRevoked: false,
    cancelCalls: 0,
    closeCalls: 0,
    dispatchPermitUsed: false,
    holdFinalizeGate: null,
    holdFinalizeStarted: null,
    lateReads: 0,
    leaseResolutions: 0,
    nativeId: 'native-session-1',
    observationPatch: null,
    processIdentity: '4242:provider-start',
    providerPid: 4242,
    reconnectCalls: 0,
    reconnectGate: null,
    reconnectStarted: null,
    startCalls: 0,
    startRequest: null,
    startSource: null,
    storeClosed: false,
    worker: null,
  };

  const observedStore = {
    ...store,
    getEventById(input) {
      // biome-ignore lint/suspicious/noUnnecessaryConditions: Callers mutate this fixture after construction to exercise the guarded path.
      if (state.storeClosed) {
        state.lateReads += 1;
      }
      return store.getEventById(input);
    },
    readRun(input) {
      // biome-ignore lint/suspicious/noUnnecessaryConditions: Callers mutate this fixture after construction to exercise the guarded path.
      if (state.storeClosed) {
        state.lateReads += 1;
      }
      return store.readRun(input);
    },
  };

  const capturePath = ({ binding: requested, tempRoot: temp }) =>
    join(temp, 'capture', `${requested.runId}-${requested.attemptId}.json`);

  const authorize = ({ binding: requested, operation }) => {
    if (operation === 'start') {
      // biome-ignore lint/suspicious/noUnnecessaryConditions: Callers mutate this fixture after construction to exercise the guarded path.
      if (state.approvalRevoked) {
        return { noEffect: true, ok: false };
      }
      // biome-ignore lint/suspicious/noUnnecessaryConditions: Callers mutate this fixture after construction to exercise the guarded path.
      if (state.dispatchPermitUsed) {
        return { ok: false };
      }
      state.dispatchPermitUsed = true;
      return { currentAttempt: true, freshDispatch: true, ok: true };
    }
    if (['cancel', 'reconnect'].includes(operation)) {
      return { binding: requested, currentAttempt: true, ok: true };
    }
    return { ok: false };
  };

  const makeProcess = ({
    authorize: childAuthorize,
    resolveArchiveAdmission,
  }) => ({
    async cancel({ binding: requested, descriptorPath }) {
      state.cancelCalls += 1;
      const approved = await childAuthorize({
        binding: requested,
        operation: 'cancel',
      });
      if (!(approved.ok && descriptorPath === state.descriptorPath)) {
        return { code: 'CAPTURE_CANCEL_UNKNOWN', ok: false };
      }
      return await state.worker.cancel({ ...state.workerRef });
    },
    close() {
      state.closeCalls += 1;
      return { ok: true };
    },
    async reconnect({ binding: requested, descriptorPath }) {
      state.reconnectCalls += 1;
      const resolveStarted = state.reconnectStarted;
      // biome-ignore lint/suspicious/noUnnecessaryConditions: Callers mutate this fixture after construction to exercise the guarded path.
      if (resolveStarted) {
        state.reconnectStarted = null;
        resolveStarted();
      }
      // biome-ignore lint/suspicious/noUnnecessaryConditions: Callers mutate this fixture after construction to exercise the guarded path.
      if (state.reconnectGate) {
        await state.reconnectGate;
      }
      const approved = await childAuthorize({
        binding: requested,
        operation: 'reconnect',
      });
      if (!(approved.ok && state.binding && same(requested, state.binding))) {
        return { code: 'CAPTURE_PROCESS_UNKNOWN', ok: false };
      }
      const archive = store.readRun({ runId: requested.runId });
      const attempt = archive?.view?.attempts?.[requested.attemptId];
      const provider = {
        processStart: attempt?.processStart
          ? {
              ...attempt.processStart,
              id: `${attempt.processStart.pid}:${attempt.processStart.id.replace(
                `${attempt.processStart.pid}:`,
                ''
              )}`,
            }
          : null,
        state: attempt?.status === 'running' ? 'running' : 'unknown',
      };
      const observation = {
        nativeId: state.nativeId,
        provider,
        status: attempt?.status ?? 'unknown',
        ...state.observationPatch,
      };
      const result = {
        archive,
        binding: requested,
        captureProcess: state.captureProcess,
        descriptorPath: state.descriptorPath,
        observation,
        ok: true,
      };
      return state.reconnectPatch
        ? state.reconnectPatch(result, { descriptorPath, requested })
        : result;
    },
    async start(input) {
      state.startCalls += 1;
      const approved = await childAuthorize({
        binding: input.binding,
        operation: 'start',
      });
      const admitted = await resolveArchiveAdmission({
        binding: input.binding,
      });
      if (!(approved.ok && admitted.ok)) {
        return { code: 'ATTEMPT_AUTHORIZATION_REFUSED', ok: false };
      }
      if (state.unknownBeforeAttempt) {
        return { code: 'CAPTURE_READY_UNKNOWN', ok: false, unknown: true };
      }
      state.startRequest = input.start;
      state.startSource = input.source;
      const launcher = {
        launch: () => ({
          // biome-ignore lint/suspicious/noUnnecessaryConditions: Callers remove the native ID after fixture construction to exercise its first observation.
          ...(state.nativeId === null ? {} : { nativeId: state.nativeId }),
          ok: true,
          processStart: {
            id: state.processIdentity,
            pid: state.providerPid,
          },
        }),
        stop: () => ({ ok: true }),
      };
      const workerSpool = {
        ...spool,
        async finalize(finalizeRequest) {
          // biome-ignore lint/suspicious/noUnnecessaryConditions: Tests install this gate after the worker closure is constructed.
          if (state.holdFinalizeGate) {
            state.holdFinalizeStarted?.();
            await state.holdFinalizeGate;
          }
          return await spool.finalize(finalizeRequest);
        },
      };
      state.worker = createSpansWorker({
        clock: { now: () => 2000 },
        launcher,
        limits: input.limits,
        preflight: () => ({ ok: true }),
        spool: workerSpool,
        store,
        workerId: input.binding.workerId,
      });
      state.spool = spool;
      const started = await state.worker.start(input.start);
      if (!(started.ok && started.status === 'running')) {
        return {
          code: started.code ?? 'CAPTURE_START_UNKNOWN',
          ok: false,
          unknown: true,
        };
      }
      const descriptorPath = capturePath({ binding: input.binding, tempRoot });
      mkdirSync(join(tempRoot, 'capture'), { mode: 0o700, recursive: true });
      writeFileSync(descriptorPath, 'fake capture descriptor\n', {
        mode: 0o600,
      });
      state.binding = input.binding;
      state.captureProcess = {
        pid: 9876,
        processStartIdentity: 'capture-start',
      };
      state.descriptorPath = descriptorPath;
      state.workerRef = started.ref;
      state.executionReview = input.executionReview;
      return state.readyUnknown
        ? { code: 'CAPTURE_READY_UNKNOWN', ok: false, unknown: true }
        : {
            binding: input.binding,
            captureProcess: state.captureProcess,
            descriptorPath,
            ok: true,
            status: 'running',
          };
    },
  });

  let exitCalls = 0;
  const onExit = async ({ binding: completedBinding, result }) => {
    exitCalls += 1;
    if (onExitGate) {
      await onExitGate;
    }
    const recorded = await store.appendEvent({
      eventId: capturedId(completedBinding.runId, completedBinding.attemptId),
      payload: {
        actionId: completedBinding.actionId,
        artifactId: result.receipt.capture.artifactId,
        artifactIds: [result.receipt.capture.artifactId],
        attemptId: completedBinding.attemptId,
        bytes: result.receipt.capture.bytes,
        chunks: result.receipt.capture.chunks,
        complete: result.receipt.capture.complete,
        exit: result.receipt.exit,
        spanId: completedBinding.spanId,
      },
      runId: completedBinding.runId,
      type: 'spans.execution.captured',
    });
    if (recorded?.ok !== true) {
      return recorded;
    }
    return result.status === 'held'
      ? { ok: true, settled: false }
      : { ok: true, status: 'recorded' };
  };

  function makeAdapter() {
    return createSpansExecutionCapture({
      archiveRoot,
      authorize,
      createProcess: makeProcess,
      executionFor: (requested) => {
        const read = store.readRun({ runId: requested.runId });
        return read?.view?.executions?.[requested.actionId] ?? null;
      },
      exists: existsSync,
      limits: workerLimits,
      onExit,
      onHold: () => onHoldGate ?? Promise.resolve(),
      pollIntervalMs,
      resolveArchiveAdmission: () => {
        state.leaseResolutions += 1;
        return { leaseId: 'shared-lease', ok: true };
      },
      resolveCapturePath: capturePath,
      resolveSource: ({ binding: requested, execution: saved }) => ({
        argv: ['/fixture/provider', '--capture', requested.attemptId],
        cwd: root,
        env: { FIXTURE_EXECUTION: saved.approvalDigest, PATH: '/fixture/bin' },
        ok: true,
        stdin: 'reviewed fixture input\n',
      }),
      store: observedStore,
      tempRoot,
      workerId: binding.workerId,
    });
  }

  async function complete(text = 'captured fixture output\n') {
    const attempt = store.readRun({ runId }).view.attempts?.[attemptId];
    const ref = {
      ...binding,
      processStartId: attempt.processStart.id,
    };
    const captured = await state.worker.captureChunk({ ...ref, seq: 0, text });
    if (!captured.ok) {
      throw new Error(`capture fixture failed: ${captured.code}`);
    }
    return await state.worker.observeExit({
      ...ref,
      exit: { code: 0, signal: null },
    });
  }

  return {
    archiveRoot,
    binding,
    complete,
    get exitCalls() {
      return exitCalls;
    },
    makeAdapter,
    root,
    state,
    store,
    tempRoot,
  };
}

function same(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

async function exhaustCapture(world, { confirmExit = true } = {}) {
  const ref = world.state.workerRef;
  const first = await world.state.worker.captureChunk({
    ...ref,
    seq: 0,
    text: 'partial captured output\n',
  });
  if (!first.ok) {
    throw new Error(`first held-fixture chunk failed: ${first.code}`);
  }
  let overflow;
  let exited;
  if (confirmExit) {
    let releaseFinalize;
    let markFinalizeStarted;
    world.state.holdFinalizeGate = new Promise((resolve) => {
      releaseFinalize = resolve;
    });
    const finalizeStarted = new Promise((resolve) => {
      markFinalizeStarted = resolve;
    });
    world.state.holdFinalizeStarted = markFinalizeStarted;
    const overflowWork = world.state.worker.captureChunk({
      ...ref,
      seq: 1,
      text: 'bounded output overflow\n',
    });
    await finalizeStarted;
    const exitWork = world.state.worker.observeExit({
      ...ref,
      exit: { code: 0, signal: null },
    });
    releaseFinalize();
    [overflow, exited] = await Promise.all([overflowWork, exitWork]);
    world.state.holdFinalizeGate = null;
    world.state.holdFinalizeStarted = null;
  } else {
    overflow = await world.state.worker.captureChunk({
      ...ref,
      seq: 1,
      text: 'bounded output overflow\n',
    });
  }
  if (overflow.code !== 'SPOOL_LIMIT' || overflow.held !== true) {
    throw new Error(`held-fixture exhaustion failed: ${overflow.code}`);
  }
  if (confirmExit && !(exited.ok && exited.status === 'held')) {
    throw new Error(`held-fixture exit failed: ${JSON.stringify(exited)}`);
  }
  return world.store.readRun({ runId: world.binding.runId }).view.attempts[
    world.binding.attemptId
  ];
}

test('starts one child effect from saved execution input and reports exact receipt replay', async () => {
  const world = await fixture();
  const adapter = world.makeAdapter();
  try {
    const started = await adapter.start({
      ...world.binding,
      deadlineMs: 1,
      executionReview: { approvalDigest: 'bad' },
      source: { command: '/untrusted/provider' },
    });
    expect(started).toMatchObject({
      actionId: world.binding.actionId,
      attemptId: world.binding.attemptId,
      created: true,
      dispatched: true,
      ok: true,
      status: 'running',
      workerId: world.binding.workerId,
    });
    expect(world.state.startCalls).toBe(1);
    expect(world.state.leaseResolutions).toBe(1);
    expect(world.state.executionReview).toEqual({
      approvalDigest: 'c'.repeat(64),
      reviewDigest: 'd'.repeat(64),
      runId: world.binding.runId,
    });
    expect(world.state.startRequest).toEqual({
      ...world.binding,
      deadlineMs: 30_000,
    });
    expect(world.state.startSource).toEqual({
      args: ['--capture', world.binding.attemptId],
      command: '/fixture/provider',
      cwd: world.root,
      env: { FIXTURE_EXECUTION: 'c'.repeat(64), PATH: '/fixture/bin' },
      stdin: 'reviewed fixture input\n',
    });
    expect(await adapter.start(world.binding)).toMatchObject({
      created: false,
      existing: true,
      ok: true,
      status: 'running',
    });
    expect(world.state.startCalls).toBe(1);
  } finally {
    await adapter.shutdown();
    world.state.storeClosed = true;
    world.store.close();
  }
});

test('an interrupted ready response stays unknown and replay never sends another start', async () => {
  const world = await fixture();
  const first = world.makeAdapter();
  try {
    world.state.readyUnknown = true;
    world.state.reconnectPatch = () => ({
      code: 'CAPTURE_PROCESS_UNKNOWN',
      ok: false,
      unknown: true,
    });
    const started = await first.start(world.binding);
    expect(started).toMatchObject({ ok: false, unknown: true });
    expect(started.dispatched).toBeUndefined();
    expect(
      world.store.readRun({ runId: world.binding.runId }).view.attempts[
        world.binding.attemptId
      ]
    ).toMatchObject({ status: 'running' });
    await first.shutdown();

    const restarted = world.makeAdapter();
    const replay = await restarted.start(world.binding);
    expect(replay).toMatchObject({ existing: true, ok: false, unknown: true });
    expect(world.state.startCalls).toBe(1);
    await restarted.shutdown();
  } finally {
    world.state.storeClosed = true;
    world.store.close();
  }
});

test('a lost start response with neither row nor descriptor never proves no effect', async () => {
  const world = await fixture();
  const first = world.makeAdapter();
  try {
    world.state.unknownBeforeAttempt = true;
    const started = await first.start(world.binding);
    expect(started).toMatchObject({ ok: false, unknown: true });
    expect(started.dispatched).toBeUndefined();
    expect(
      world.store.readRun({ runId: world.binding.runId }).view.attempts?.[
        world.binding.attemptId
      ]
    ).toBeUndefined();
    await first.shutdown();

    const restarted = world.makeAdapter();
    const replay = await restarted.start(world.binding);
    expect(replay).toMatchObject({ ok: false, unknown: true });
    expect(replay.dispatched).toBeUndefined();
    expect(world.state.startCalls).toBe(1);
    await restarted.shutdown();
  } finally {
    world.state.storeClosed = true;
    world.store.close();
  }
});

test('reconnect after adapter restart proves only the current saved attempt', async () => {
  const world = await fixture();
  const first = world.makeAdapter();
  try {
    await first.start(world.binding);
    await first.shutdown();
    const restarted = world.makeAdapter();
    expect(await restarted.recover(world.binding)).toMatchObject({
      ok: true,
      status: 'running',
    });
    expect(await restarted.start(world.binding)).toMatchObject({
      created: false,
      existing: true,
      ok: true,
      status: 'running',
    });
    expect(world.state.startCalls).toBe(1);
    expect(world.state.reconnectCalls).toBeGreaterThan(0);
    await restarted.shutdown();
  } finally {
    world.state.storeClosed = true;
    world.store.close();
  }
});

test('terminal child receipt reaches parent once even when it exits before parent restart', async () => {
  const world = await fixture();
  const first = world.makeAdapter();
  try {
    await first.start(world.binding);
    expect(await world.complete()).toMatchObject({
      ok: true,
      status: 'exited',
    });
    await first.shutdown();
    expect(world.exitCalls).toBe(0);

    const restarted = world.makeAdapter();
    expect(await restarted.recover(world.binding)).toMatchObject({
      ok: true,
      status: 'exited',
      terminal: true,
    });
    expect(await restarted.recover(world.binding)).toMatchObject({
      ok: true,
      status: 'exited',
      terminal: true,
    });
    expect(world.exitCalls).toBe(1);
    expect(
      world.store.getEventById({
        eventId: capturedId(world.binding.runId, world.binding.attemptId),
      }).found
    ).toBe(true);
    await restarted.shutdown();
  } finally {
    world.state.storeClosed = true;
    world.store.close();
  }
});

test('parent restart reruns idempotent finalization after the capture event was recorded', async () => {
  const world = await fixture();
  const first = world.makeAdapter();
  try {
    await first.start(world.binding);
    await world.complete();
    const attempt = world.store.readRun({ runId: world.binding.runId }).view
      .attempts[world.binding.attemptId];
    expect(
      world.store.appendEvent({
        eventId: capturedId(world.binding.runId, world.binding.attemptId),
        payload: {
          actionId: world.binding.actionId,
          artifactId: attempt.receipt.capture.artifactId,
          artifactIds: [attempt.receipt.capture.artifactId],
          attemptId: world.binding.attemptId,
          bytes: attempt.receipt.capture.bytes,
          chunks: attempt.receipt.capture.chunks,
          complete: attempt.receipt.capture.complete,
          exit: attempt.receipt.exit,
          spanId: world.binding.spanId,
        },
        runId: world.binding.runId,
        type: 'spans.execution.captured',
      }).ok
    ).toBe(true);
    await first.shutdown();

    const restarted = world.makeAdapter();
    const [recovered, observed, recoveredAgain] = await Promise.all([
      restarted.recover(world.binding),
      restarted.observe(world.binding),
      restarted.recover(world.binding),
    ]);
    for (const result of [recovered, observed, recoveredAgain]) {
      expect(result).toMatchObject({
        ok: true,
        status: 'exited',
        terminal: true,
      });
    }
    expect(world.exitCalls).toBe(1);
    await restarted.shutdown();
  } finally {
    world.state.storeClosed = true;
    world.store.close();
  }
});

test('confirmed spool exhaustion records partial evidence as held across restart', async () => {
  const world = await fixture({
    workerLimits: { ...LIMITS, maxAttemptChunks: 1 },
  });
  const first = world.makeAdapter();
  try {
    await first.start(world.binding);
    const held = await exhaustCapture(world);
    expect(held).toMatchObject({
      cancel: { state: 'delivered' },
      capture: {
        artifactId: expect.any(String),
        bytes: expect.any(Number),
        chunks: 1,
        complete: false,
        countsConfirmed: true,
        gap: { fromSeq: 1, reason: 'spool-limit' },
      },
      exit: { code: 0, signal: null },
      processStart: {
        id: world.state.processIdentity,
        pid: world.state.providerPid,
      },
      receipt: { outcome: 'unknown', status: 'held', workAccepted: false },
      status: 'held',
    });

    const observed = await first.observe(world.binding);
    expect(observed).toMatchObject({
      evidenceRecorded: true,
      ok: true,
      receipt: { capture: { complete: false, gap: { reason: 'spool-limit' } } },
      settled: false,
      status: 'held',
      terminal: true,
    });
    expect(world.exitCalls).toBe(1);
    const { event } = world.store.getEventById({
      eventId: capturedId(world.binding.runId, world.binding.attemptId),
    });
    expect(event.payload).toMatchObject({
      actionId: world.binding.actionId,
      artifactId: held.capture.artifactId,
      artifactIds: [held.capture.artifactId],
      attemptId: world.binding.attemptId,
      bytes: held.capture.bytes,
      chunks: held.capture.chunks,
      complete: false,
      exit: held.exit,
      spanId: world.binding.spanId,
    });
    expect(await first.observe(world.binding)).toMatchObject({
      evidenceRecorded: true,
      settled: false,
      status: 'held',
    });
    expect(world.exitCalls).toBe(1);
    expect(await first.idle()).toMatchObject({
      ok: false,
      unproven: [{ reason: 'capture-held' }],
    });
    expect(
      world.store.readRun({ runId: world.binding.runId }).view.actions[
        world.binding.actionId
      ].state
    ).toBe('intent');
    expect(world.state.startCalls).toBe(1);
    expect(world.state.cancelCalls).toBe(0);
    expect(world.state.leaseResolutions).toBe(1);
    await first.shutdown();
    expect(await first.idle()).toMatchObject({ closed: true, ok: false });

    const restarted = world.makeAdapter();
    expect(await restarted.recover(world.binding)).toMatchObject({
      evidenceRecorded: true,
      ok: true,
      settled: false,
      status: 'held',
      terminal: true,
    });
    expect(world.exitCalls).toBe(2);
    expect(await restarted.idle()).toMatchObject({ ok: false });
    expect(world.state.startCalls).toBe(1);
    expect(
      world.store.readRun({ runId: world.binding.runId }).view.actions[
        world.binding.actionId
      ].state
    ).toBe('intent');
    await restarted.shutdown();
  } finally {
    await first.shutdown();
    world.state.storeClosed = true;
    world.store.close();
  }
});

test('unconfirmed held receipts stay unknown without a fabricated capture event', async () => {
  await Promise.all(
    ['no-exit', 'unconfirmed-counts', 'missing-artifact'].map(
      async (defect) => {
        const world = await fixture({
          workerLimits: { ...LIMITS, maxAttemptChunks: 1 },
        });
        const adapter = world.makeAdapter();
        try {
          await adapter.start(world.binding);
          const held = await exhaustCapture(world, {
            confirmExit: defect !== 'no-exit',
          });
          if (defect !== 'no-exit') {
            const before = world.store.readRun({ runId: world.binding.runId });
            const view = structuredClone(before.view);
            const attempt = view.attempts[world.binding.attemptId];
            if (defect === 'unconfirmed-counts') {
              attempt.capture.countsConfirmed = false;
              attempt.receipt.capture.countsConfirmed = false;
            } else {
              attempt.capture.artifactId = null;
              attempt.receipt.capture.artifactId = null;
            }
            expect(
              world.store.commitRun({
                events: [],
                expectedGeneration: before.generation,
                expectedRevision: before.revision,
                runId: world.binding.runId,
                view,
              }).ok
            ).toBe(true);
          }

          expect(await adapter.observe(world.binding)).toMatchObject({
            code: 'ATTEMPT_HELD',
            ok: false,
            status: 'held',
            unknown: true,
          });
          expect(world.exitCalls).toBe(0);
          expect(
            world.store.getEventById({
              eventId: capturedId(world.binding.runId, world.binding.attemptId),
            }).found
          ).toBe(false);
          expect(await adapter.idle()).toMatchObject({ ok: false });
          if (defect === 'no-exit') {
            expect(
              await adapter.cancel({
                ...world.binding,
                processStartId: held.processStart.id,
              })
            ).toMatchObject({ cancel: 'delivered', duplicate: true, ok: true });
          }
          expect(
            world.store.readRun({ runId: world.binding.runId }).view.actions[
              world.binding.actionId
            ].state
          ).toBe('intent');
        } finally {
          await adapter.shutdown();
          world.state.storeClosed = true;
          world.store.close();
        }
      }
    )
  );
});

test('a preexisting capture event with the wrong artifact cannot confirm held evidence', async () => {
  const world = await fixture({
    workerLimits: { ...LIMITS, maxAttemptChunks: 1 },
  });
  const adapter = world.makeAdapter();
  try {
    await adapter.start(world.binding);
    const held = await exhaustCapture(world);
    const wrongArtifactId =
      held.capture.artifactId === 'e'.repeat(64)
        ? 'f'.repeat(64)
        : 'e'.repeat(64);
    expect(
      world.store.appendEvent({
        eventId: capturedId(world.binding.runId, world.binding.attemptId),
        payload: {
          actionId: world.binding.actionId,
          artifactId: wrongArtifactId,
          artifactIds: [wrongArtifactId],
          attemptId: world.binding.attemptId,
          bytes: held.capture.bytes,
          chunks: held.capture.chunks,
          complete: false,
          exit: held.exit,
          spanId: world.binding.spanId,
        },
        runId: world.binding.runId,
        type: 'spans.execution.captured',
      }).ok
    ).toBe(true);

    expect(await adapter.observe(world.binding)).toMatchObject({
      code: 'PARENT_FINALIZATION_UNKNOWN',
      ok: false,
      status: 'held',
      terminal: true,
      unknown: true,
    });
    expect(world.exitCalls).toBe(1);
    expect(await adapter.idle()).toMatchObject({ ok: false });
    expect(
      world.store.getEventById({
        eventId: capturedId(world.binding.runId, world.binding.attemptId),
      }).event.payload.artifactId
    ).toBe(wrongArtifactId);
  } finally {
    await adapter.shutdown();
    world.state.storeClosed = true;
    world.store.close();
  }
});

test('detached worker output is durable after parent shutdown', async () => {
  const world = await fixture();
  const first = world.makeAdapter();
  try {
    await first.start(world.binding);
    await first.shutdown();
    const chunk = await world.state.worker.captureChunk({
      ...world.state.workerRef,
      seq: 0,
      text: 'written while parent is offline\n',
    });
    expect(chunk.ok).toBe(true);
    const attempt = world.store.readRun({ runId: world.binding.runId }).view
      .attempts[world.binding.attemptId];
    expect(
      await world.state.spool.stat({ attemptDigest: attempt.attemptDigest })
    ).toMatchObject({
      bytes: 32,
      chunks: 1,
      ok: true,
    });

    const restarted = world.makeAdapter();
    expect(await restarted.recover(world.binding)).toMatchObject({
      ok: true,
      status: 'running',
    });
    expect(world.state.startCalls).toBe(1);
    await restarted.shutdown();
  } finally {
    world.state.storeClosed = true;
    world.store.close();
  }
});

test('the first durable native session appearing during reconnect remains supervised', async () => {
  const world = await fixture();
  world.state.nativeId = null;
  const adapter = world.makeAdapter();
  try {
    expect((await adapter.start(world.binding)).ok).toBe(true);
    world.state.reconnectPatch = async (result) => {
      world.state.reconnectPatch = null;
      expect(
        (
          await world.state.worker.observeNative({
            ...world.state.workerRef,
            nativeId: 'first-native-session',
          })
        ).ok
      ).toBe(true);
      world.state.nativeId = 'first-native-session';
      return {
        ...result,
        archive: world.store.readRun({ runId: world.binding.runId }),
        observation: { ...result.observation, nativeId: world.state.nativeId },
      };
    };
    const observed = await adapter.observe(world.binding);
    expect(observed.ok).toBe(true);
    expect(observed.status).toBe('running');
    expect(observed.attempt.nativeId).toBe('first-native-session');
    expect(world.state.startCalls).toBe(1);
  } finally {
    await adapter.shutdown();
    world.state.storeClosed = true;
    world.store.close();
  }
});

test('owned cancellation rechecks a first native ID committed during its observation', async () => {
  const world = await fixture();
  world.state.nativeId = null;
  const adapter = world.makeAdapter();
  try {
    expect((await adapter.start(world.binding)).ok).toBe(true);
    world.state.reconnectPatch = async (result) => {
      world.state.reconnectPatch = null;
      expect(
        (
          await world.state.worker.observeNative({
            ...world.state.workerRef,
            nativeId: 'first-native-session',
          })
        ).ok
      ).toBe(true);
      world.state.nativeId = 'first-native-session';
      return {
        ...result,
        archive: world.store.readRun({ runId: world.binding.runId }),
      };
    };
    const attempt = world.store.readRun({ runId: world.binding.runId }).view
      .attempts[world.binding.attemptId];
    expect(
      (
        await adapter.cancel({
          ...world.binding,
          processStartId: attempt.processStart.id,
        })
      ).ok
    ).toBe(true);
    expect(world.state.cancelCalls).toBe(1);
    expect(world.state.startCalls).toBe(1);
  } finally {
    await adapter.shutdown();
    world.state.storeClosed = true;
    world.store.close();
  }
});

test('owned cancellation remains available after the approval is revoked', async () => {
  const world = await fixture();
  const adapter = world.makeAdapter();
  try {
    await adapter.start(world.binding);
    world.state.approvalRevoked = true;
    const attempt = world.store.readRun({ runId: world.binding.runId }).view
      .attempts[world.binding.attemptId];
    const cancelled = await adapter.cancel({
      ...world.binding,
      processStartId: attempt.processStart.id,
    });
    expect(cancelled).toMatchObject({ cancel: 'delivered', ok: true });
    expect(world.state.cancelCalls).toBe(1);
  } finally {
    await adapter.shutdown();
    world.state.storeClosed = true;
    world.store.close();
  }
});

test('reconnect accepts a running snapshot while the same worker advances to finalizing', async () => {
  let releaseFinalize;
  let markFinalizeStarted;
  const finalizeGate = new Promise((resolve) => {
    releaseFinalize = resolve;
  });
  const finalizeStarted = new Promise((resolve) => {
    markFinalizeStarted = resolve;
  });
  const world = await fixture({ pollIntervalMs: 10_000 });
  const adapter = world.makeAdapter();
  let exitWork;
  let idleWork;
  let releaseIdleRead;
  const idleReadGate = new Promise((resolve) => {
    releaseIdleRead = resolve;
  });
  try {
    expect((await adapter.start(world.binding)).ok).toBe(true);
    const running = world.store.readRun({ runId: world.binding.runId });
    const runningAttempt = running.view.attempts[world.binding.attemptId];
    expect(runningAttempt.status).toBe('running');

    const cancelled = await adapter.cancel({
      ...world.binding,
      processStartId: runningAttempt.processStart.id,
    });
    expect(cancelled).toMatchObject({ cancel: 'delivered', ok: true });
    expect(world.state.cancelCalls).toBe(1);

    world.state.holdFinalizeGate = finalizeGate;
    world.state.holdFinalizeStarted = markFinalizeStarted;
    world.state.reconnectPatch = async (result) => {
      world.state.reconnectPatch = null;
      exitWork = world.complete();
      await finalizeStarted;
      return result;
    };

    const observed = await adapter.observe(world.binding);
    const finalizing = world.store.readRun({ runId: world.binding.runId });
    const finalizingAttempt = finalizing.view.attempts[world.binding.attemptId];
    expect(finalizingAttempt).toMatchObject({
      processStart: runningAttempt.processStart,
      receipt: runningAttempt.receipt,
      status: 'finalizing',
    });
    expect(observed).toMatchObject({ ok: true });
    expect(observed.terminal).toBeUndefined();
    expect(observed.status).toBe('observing');
    expect(world.exitCalls).toBe(0);
    expect(world.state.startCalls).toBe(1);
    expect(world.state.cancelCalls).toBe(1);
    expect(world.state.leaseResolutions).toBe(1);

    let markIdleRead;
    const idleReadStarted = new Promise((resolve) => {
      markIdleRead = resolve;
    });
    world.state.reconnectStarted = markIdleRead;
    world.state.reconnectGate = idleReadGate;
    let idleDone = false;
    idleWork = adapter.idle().then((result) => {
      idleDone = true;
      return result;
    });
    await idleReadStarted;
    expect(idleDone).toBe(false);
    expect(world.exitCalls).toBe(0);

    releaseFinalize();
    world.state.holdFinalizeGate = null;
    world.state.holdFinalizeStarted = null;
    expect(await exitWork).toMatchObject({ ok: true, status: 'exited' });
    releaseIdleRead();
    expect(await idleWork).toMatchObject({ ok: true });
    expect(world.exitCalls).toBe(1);
    expect(
      world.store.getEventById({
        eventId: capturedId(world.binding.runId, world.binding.attemptId),
      })
    ).toMatchObject({ found: true });
    expect(world.state.startCalls).toBe(1);
    expect(world.state.leaseResolutions).toBe(1);
  } finally {
    releaseFinalize?.();
    releaseIdleRead?.();
    await exitWork;
    await idleWork;
    await adapter.shutdown();
    world.state.storeClosed = true;
    world.store.close();
  }
});

test('an owned held capture can retry cancellation whose delivery is unknown', async () => {
  const world = await fixture({
    workerLimits: { ...LIMITS, maxAttemptChunks: 1 },
  });
  const adapter = world.makeAdapter();
  try {
    expect((await adapter.start(world.binding)).ok).toBe(true);
    const held = await exhaustCapture(world, { confirmExit: false });
    const read = world.store.readRun({ runId: world.binding.runId });
    const view = structuredClone(read.view);
    const attempt = view.attempts[world.binding.attemptId];
    attempt.cancel.state = 'unknown';
    attempt.receipt.cancel.state = 'unknown';
    expect(
      world.store.commitRun({
        events: [],
        expectedGeneration: read.generation,
        expectedRevision: read.revision,
        runId: world.binding.runId,
        view,
      }).ok
    ).toBe(true);
    world.state.observationPatch = {
      provider: { processStart: attempt.processStart, state: 'stopping' },
    };
    const cancelled = await adapter.cancel({
      ...world.binding,
      processStartId: held.processStart.id,
    });
    expect(cancelled.ok).toBe(true);
    expect(world.state.cancelCalls).toBe(1);
    expect(world.exitCalls).toBe(0);
    expect(
      world.store.readRun({ runId: world.binding.runId }).view.attempts[
        world.binding.attemptId
      ].exit
    ).toBeNull();
  } finally {
    await adapter.shutdown();
    world.state.storeClosed = true;
    world.store.close();
  }
});

test('stale generation, descriptor, or native identity stays unknown and held', async () => {
  for (const mismatch of [
    'generation',
    'descriptor',
    'native',
    'native-observation-missing',
  ]) {
    // biome-ignore lint/performance/noAwaitInLoops: Complete each isolated mismatch fixture before creating the next one.
    const world = await fixture();
    const adapter = world.makeAdapter();
    try {
      await adapter.start(world.binding);
      if (mismatch === 'generation') {
        const before = world.store.readRun({ runId: world.binding.runId });
        const view = structuredClone(before.view);
        view.generation += 1;
        expect(
          world.store.commitRun({
            events: [],
            expectedGeneration: before.generation,
            expectedRevision: before.revision,
            runId: world.binding.runId,
            view,
          }).ok
        ).toBe(true);
      } else if (mismatch === 'descriptor') {
        world.state.reconnectPatch = (result) => ({
          ...result,
          descriptorPath: join(world.tempRoot, 'capture', 'other.json'),
        });
      } else if (mismatch === 'native-observation-missing') {
        world.state.reconnectPatch = (result) => {
          const observation = Object.fromEntries(
            Object.entries(result.observation).filter(
              ([key]) => key !== 'nativeId'
            )
          );
          return { ...result, observation };
        };
      } else {
        world.state.observationPatch = { nativeId: 'native-session-stale' };
      }
      const recovered = await adapter.recover(world.binding);
      expect(recovered).toMatchObject({ ok: false, unknown: true });
      expect(await adapter.idle()).toMatchObject({ ok: false });
      expect(world.state.startCalls).toBe(1);
      expect(world.state.cancelCalls).toBe(0);
    } finally {
      await adapter.shutdown();
      world.state.storeClosed = true;
      world.store.close();
    }
  }
});

test('idle includes asynchronous parent finalization and shutdown fences late reads', async () => {
  let releaseExit;
  const exitGate = new Promise((resolve) => {
    releaseExit = resolve;
  });
  const world = await fixture({ onExitGate: exitGate, pollIntervalMs: 10_000 });
  const adapter = world.makeAdapter();
  try {
    await adapter.start(world.binding);
    await world.complete();
    const observing = adapter.observe(world.binding);
    while (world.exitCalls === 0) {
      // biome-ignore lint/performance/noAwaitInLoops: Wait for the specific callback before checking idle behavior.
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    let idleDone = false;
    const idle = adapter.idle().then((value) => {
      idleDone = true;
      return value;
    });
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(idleDone).toBe(false);
    releaseExit();
    await observing;
    expect(await idle).toMatchObject({ ok: true, unproven: [] });

    await adapter.shutdown();
    world.state.storeClosed = true;
    const readsAtShutdown = world.state.lateReads;
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(world.state.closeCalls).toBe(1);
    expect(world.state.cancelCalls).toBe(0);
    expect(world.state.lateReads).toBe(readsAtShutdown);
  } finally {
    releaseExit();
    await adapter.shutdown();
    world.state.storeClosed = true;
    world.store.close();
  }
});

test('shutdown drains a pending observation without cancelling the detached worker', async () => {
  const world = await fixture({ pollIntervalMs: 10_000 });
  const adapter = world.makeAdapter();
  let releaseReconnect;
  let markReconnectStarted;
  const reconnectGate = new Promise((resolve) => {
    releaseReconnect = resolve;
  });
  const reconnectStarted = new Promise((resolve) => {
    markReconnectStarted = resolve;
  });
  try {
    await adapter.start(world.binding);
    world.state.reconnectGate = reconnectGate;
    world.state.reconnectStarted = markReconnectStarted;
    const observe = adapter.observe(world.binding);
    await reconnectStarted;
    let shutdownDone = false;
    const shutdown = adapter.shutdown().then((result) => {
      shutdownDone = true;
      return result;
    });
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(shutdownDone).toBe(false);
    releaseReconnect();
    await observe;
    expect(await shutdown).toEqual({ ok: true });
    world.state.storeClosed = true;
    expect(world.state.closeCalls).toBe(1);
    expect(world.state.cancelCalls).toBe(0);
    expect(world.state.leaseResolutions).toBe(1);

    await world.complete('captured after parent shutdown\n');
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(world.exitCalls).toBe(0);
    expect(world.state.lateReads).toBe(0);
  } finally {
    releaseReconnect();
    await adapter.shutdown();
    world.state.storeClosed = true;
    world.store.close();
  }
});

test.each(['process', 'receipt', 'backwards'])(
  'a finalization observation still refuses a %s mismatch',
  async (mismatch) => {
    const world = await fixture();
    const adapter = world.makeAdapter();
    try {
      expect((await adapter.start(world.binding)).ok).toBe(true);
      world.state.reconnectPatch = (result) => {
        if (mismatch === 'backwards') {
          result.archive.view.attempts[world.binding.attemptId].status =
            'finalizing';
          result.observation.provider.state = 'draining';
        } else {
          world.state.reconnectPatch = null;
          const before = world.store.readRun({ runId: world.binding.runId });
          const view = structuredClone(before.view);
          const attempt = view.attempts[world.binding.attemptId];
          attempt.status = 'finalizing';
          if (mismatch === 'process') {
            attempt.processStart.id += '-replacement';
          } else {
            attempt.receipt = { unconfirmed: true };
          }
          expect(
            world.store.commitRun({
              events: [],
              expectedGeneration: before.generation,
              expectedRevision: before.revision,
              runId: world.binding.runId,
              view,
            }).ok
          ).toBe(true);
        }
        return result;
      };
      expect(await adapter.observe(world.binding)).toMatchObject({
        ok: false,
        unknown: true,
      });
      expect(await adapter.idle()).toMatchObject({ ok: false });
      expect(world.exitCalls).toBe(0);
      expect(world.state.startCalls).toBe(1);
      expect(world.state.cancelCalls).toBe(0);
    } finally {
      await adapter.shutdown();
      world.state.storeClosed = true;
      world.store.close();
    }
  }
);

test('fresh launch keeps proven terminal capture when the worker exits during confirmation', async () => {
  const world = await fixture();
  const adapter = world.makeAdapter();
  let release;
  let entered;
  world.state.reconnectGate = new Promise((resolve) => {
    release = resolve;
  });
  const observed = new Promise((resolve) => {
    entered = resolve;
  });
  world.state.reconnectStarted = entered;
  const starting = adapter.start(world.binding);
  try {
    await observed;
    expect((await world.complete()).ok).toBe(true);
    release();
    const result = await starting;
    expect(result, JSON.stringify(result)).toMatchObject({
      dispatched: true,
      ok: true,
      status: 'captured',
    });
    expect(world.state.startCalls).toBe(1);
  } finally {
    release();
    await starting;
    await adapter.shutdown();
    world.state.storeClosed = true;
    world.store.close();
  }
});

test('fresh launch reports proven draining capture without claiming running or completion', async () => {
  const world = await fixture();
  const adapter = world.makeAdapter();
  let release;
  let entered;
  let exiting;
  world.state.holdFinalizeGate = new Promise((resolve) => {
    release = resolve;
  });
  const finalizing = new Promise((resolve) => {
    entered = resolve;
  });
  world.state.holdFinalizeStarted = entered;
  world.state.reconnectPatch = async (result) => {
    if (!exiting) {
      exiting = world.complete();
      await finalizing;
    }
    result.observation.provider.state = 'draining';
    result.observation.provider.captureState = 'exited';
    return result;
  };
  try {
    const result = await adapter.start(world.binding);
    expect(result, JSON.stringify(result)).toMatchObject({
      dispatched: true,
      ok: true,
      status: 'observing',
    });
    expect(world.state.startCalls).toBe(1);
    expect(world.exitCalls).toBe(0);
  } finally {
    release();
    await exiting;
    await adapter.idle();
    await adapter.shutdown();
    world.state.storeClosed = true;
    world.store.close();
  }
});

test.each(['complete', 'held'])(
  'fresh %s launch acknowledgment does not wait for parent outcome finalization',
  async (kind) => {
    let releaseOutcome;
    const outcomeGate = new Promise((resolve) => {
      releaseOutcome = resolve;
    });
    const world = await fixture({
      onExitGate: outcomeGate,
      onHoldGate: outcomeGate,
      workerLimits: { ...LIMITS, maxAttemptChunks: 1 },
    });
    const adapter = world.makeAdapter();
    let releaseRead;
    let entered;
    world.state.reconnectGate = new Promise((resolve) => {
      releaseRead = resolve;
    });
    const reading = new Promise((resolve) => {
      entered = resolve;
    });
    world.state.reconnectStarted = entered;
    const starting = adapter.start(world.binding);
    try {
      await reading;
      if (kind === 'held') {
        await exhaustCapture(world);
      } else {
        expect((await world.complete()).ok).toBe(true);
      }
      releaseRead();
      const result = await Promise.race([
        starting,
        Bun.sleep(100).then(() => null),
      ]);
      expect(result).toMatchObject({
        dispatched: true,
        ok: true,
        status: 'captured',
      });
      expect(world.exitCalls).toBe(0);
    } finally {
      releaseRead();
      releaseOutcome();
      await starting;
      await adapter.idle();
      expect(world.exitCalls).toBe(1);
      expect(world.state.startCalls).toBe(1);
      await adapter.shutdown();
      world.state.storeClosed = true;
      world.store.close();
    }
  }
);
