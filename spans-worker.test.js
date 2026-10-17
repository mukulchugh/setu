import { afterEach, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openSpansStore } from './spans-store.js';
import { createSpansWorker, SPANS_WORKER_EVENT_TYPES } from './spans-worker.js';

const SEED = 'sk-proj-ABCDEFGHIJKLMNOPQRST';
const LIMITS = Object.freeze({
  maxActiveAttempts: 2,
  maxAttemptBytes: 1000,
  maxAttemptChunks: 20,
  maxChunkBytes: 100,
  maxDeadlineMs: 60_000,
  maxQueueBytes: 250,
});
const TYPES = SPANS_WORKER_EVENT_TYPES;
const ARTIFACT_ID = /^sha256:[0-9a-f]{64}$/;

const roots = [];
const stores = [];
afterEach(() => {
  for (const store of stores.splice(0)) {
    store.close();
  }
  for (const root of roots.splice(0)) {
    rmSync(root, { force: true, recursive: true });
  }
});

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

// Waits (by yielding, no sleeps) until work queued behind the launch settles.
async function until(check) {
  for (let turn = 0; turn < 50 && !check(); turn += 1) {
    // biome-ignore lint/performance/noAwaitInLoops: Each yield gives queued microtasks a turn before the next bounded poll.
    await flush();
  }
}

// Resolves to 'DEADLOCK' when the promise is still pending after the wait.
const settled = (promise) =>
  Promise.race([
    promise,
    new Promise((resolve) => setTimeout(() => resolve('DEADLOCK'), 500)),
  ]);

function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function initialView(generation = 1) {
  return {
    actions: {
      'action-1': {
        actionId: 'action-1',
        attemptId: 'attempt-1',
        spanId: 'a',
        state: 'intent',
      },
      'action-2': {
        actionId: 'action-2',
        attemptId: 'attempt-2',
        spanId: 'b',
        state: 'intent',
      },
    },
    checkpoint: 0,
    generation,
    planVersion: 1,
    runId: 'run-1',
    spans: {
      a: { dependencies: [], spanId: 'a', state: 'ready' },
      b: { dependencies: [], spanId: 'b', state: 'ready' },
    },
  };
}

// Compare-and-set fake that mirrors spans-model-store.js: commitRun takes
// {events, expectedGeneration, expectedRevision, runId, view}, refuses stale
// revision/generation with the SPANS_MODEL_STALE_* codes, and treats an event
// ID reused with a different body as a refusal.
function fakeStore(view, log) {
  let current = structuredClone(view);
  let revision = 1;
  const known = new Map();
  const store = {
    afterCommit: null,
    attempt: (id = 'attempt-1') => structuredClone(current.attempts?.[id]),
    bumpGeneration() {
      current.generation += 1;
      revision += 1;
    },
    commitCount: 0,
    commitRun(request) {
      store.commitCount += 1;
      const fault = store.fault?.(request, store.commitCount);
      if (fault === 'throw') {
        throw new Error('disk detail /private/path');
      }
      if (fault === 'refuse') {
        return { code: 'SPANS_MODEL_UNAVAILABLE', ok: false };
      }
      if (fault === 'conflict') {
        revision += 1;
        return { code: 'SPANS_MODEL_STALE_REVISION', ok: false };
      }
      if (request.expectedRevision !== revision) {
        return { code: 'SPANS_MODEL_STALE_REVISION', ok: false };
      }
      if (request.expectedGeneration !== current.generation) {
        return { code: 'SPANS_MODEL_STALE_GENERATION', ok: false };
      }
      for (const event of request.events) {
        const text = JSON.stringify(event);
        if (known.has(event.eventId) && known.get(event.eventId) !== text) {
          return { code: 'SPANS_MODEL_EVENT_REFUSED', ok: false };
        }
      }
      current = structuredClone(request.view);
      for (const event of request.events) {
        if (!known.has(event.eventId)) {
          known.set(event.eventId, JSON.stringify(event));
          store.events.push(structuredClone(event));
        }
      }
      revision += 1;
      log.push(`commit:${request.events.map((event) => event.type).join('+')}`);
      store.afterCommit?.(request);
      if (fault === 'throw-after') {
        throw new Error('crash after the commit landed');
      }
      return { generation: current.generation, ok: true, revision };
    },
    events: [],
    fault: null,
    // Stands in for another coordinator changing the record.
    patchAttempt(id, patch) {
      current.attempts[id] = { ...current.attempts[id], ...patch };
      revision += 1;
    },
    readFault: false,
    readRun({ runId }) {
      // biome-ignore lint/suspicious/noUnnecessaryConditions: Tests toggle this injected read failure after constructing the store.
      if (store.readFault) {
        throw new Error('read detail /private/path');
      }
      if (runId !== current.runId) {
        return { code: 'SPANS_MODEL_NOT_FOUND', ok: false };
      }
      return {
        generation: current.generation,
        ok: true,
        revision,
        view: structuredClone(current),
      };
    },
    get view() {
      return structuredClone(current);
    },
  };
  return store;
}

function fakeSpool(log) {
  const spool = {
    append: async (payload) => {
      spool.appends += 1;
      // biome-ignore lint/suspicious/noUnnecessaryConditions: Tests install this gate after constructing the spool.
      if (spool.gate) {
        await spool.gate.promise;
      }
      const fault = spool.appendFault?.(payload, spool.appends);
      if (fault === 'throw') {
        throw new Error('/private/spool/path');
      }
      if (fault === 'fail') {
        return { code: 'SPOOL_FULL', ok: false };
      }
      if (fault === 'retry') {
        return { ok: false, retryable: true };
      }
      spool.chunks.push({
        attemptDigest: payload.attemptDigest,
        binding: payload.binding,
        bytes: payload.bytes,
        generation: payload.generation,
        seq: payload.seq,
        text: payload.text,
      });
      log.push(`append:${payload.seq}`);
      return { ok: true };
    },
    appendFault: null,
    appends: 0,
    chunks: [],
    finalize(payload) {
      log.push('finalize');
      const fault = spool.finalizeFault?.(payload);
      if (fault === 'throw') {
        throw new Error('/private/spool/path');
      }
      if (fault === 'fail') {
        return { ok: false };
      }
      if (fault === 'bad') {
        return { artifactId: 'not-an-artifact', ok: true };
      }
      const artifactId = `sha256:${createHash('sha256')
        .update(
          JSON.stringify([
            payload.attemptDigest,
            payload.complete,
            payload.chainDigest,
          ])
        )
        .digest('hex')}`;
      spool.finalized.push({ ...payload, artifactId, texts: spool.texts() });
      return { artifactId, ok: true };
    },
    finalized: [],
    finalizeFault: null,
    gate: null,
    stat({ attemptDigest }) {
      const own = spool.chunks.filter(
        (chunk) => chunk.attemptDigest === attemptDigest
      );
      return {
        bytes: own.reduce((total, chunk) => total + chunk.bytes, 0),
        chunks: own.length,
        ok: true,
      };
    },
    texts: () => spool.chunks.map((chunk) => chunk.text),
  };
  return spool;
}

const okLaunch = () => ({
  nativeId: 'native-1',
  ok: true,
  processStart: { id: 'proc-1', pid: 4242 },
});

function fakeLauncher(log) {
  const launcher = {
    behavior: async () => okLaunch(),
    calls: [],
    launch(request) {
      launcher.calls.push(request);
      launcher.sink = request.sink;
      log.push('launch');
      return launcher.behavior(request);
    },
    sink: null,
    stop(request) {
      launcher.stops.push(request);
      log.push('stop');
      return launcher.stopBehavior(request);
    },
    stopBehavior: async () => ({ ok: true }),
    stops: [],
  };
  return launcher;
}

function harness({
  limits = {},
  preflight,
  store,
  view = initialView(),
  withStop = true,
} = {}) {
  const log = [];
  const clock = {
    now() {
      return clock.time;
    },
    time: 1000,
  };
  const launcher = fakeLauncher(log);
  const spool = fakeSpool(log);
  const usedStore = store ?? fakeStore(view, log);
  const options = {
    clock,
    launcher: withStop ? launcher : { launch: launcher.launch },
    limits: { ...LIMITS, ...limits },
    preflight,
    spool,
    store: usedStore,
    workerId: 'worker-1',
  };
  return {
    clock,
    launcher,
    log,
    makeWorker: () => createSpansWorker(options),
    options,
    spool,
    store: usedStore,
    worker: createSpansWorker(options),
  };
}

const startInput = (number = 1, overrides = {}) => ({
  actionId: `action-${number}`,
  attemptId: `attempt-${number}`,
  deadlineMs: 5000,
  generation: 1,
  runId: 'run-1',
  spanId: number === 1 ? 'a' : 'b',
  ...overrides,
});

const bindingInput = (number = 1, overrides = {}) => {
  const { deadlineMs: _deadline, ...binding } = startInput(number);
  return { ...binding, workerId: 'worker-1', ...overrides };
};

async function begin(h, number = 1, overrides = {}) {
  const result = await h.worker.start(startInput(number, overrides));
  expect(result).toMatchObject({ created: true, ok: true, status: 'running' });
  return result;
}

const refOf = (result, overrides = {}) => ({ ...result.ref, ...overrides });

function expectInert(receipt) {
  expect(receipt).toMatchObject({
    kind: 'spans.worker.receipt',
    ownershipReleased: false,
    resumeAvailable: false,
    version: 1,
    workAccepted: false,
  });
}

// ---------------------------------------------------------------------------
// Construction
// ---------------------------------------------------------------------------

test('construction requires explicit limits, adapters and a worker identity', () => {
  const { options } = harness();
  expect(() => createSpansWorker()).toThrow(TypeError);
  expect(() => createSpansWorker({ ...options, limits: undefined })).toThrow(
    TypeError
  );
  for (const name of Object.keys(LIMITS)) {
    for (const bad of [0, -1, 1.5, undefined, '5']) {
      expect(() =>
        createSpansWorker({ ...options, limits: { ...LIMITS, [name]: bad } })
      ).toThrow(TypeError);
    }
  }
  expect(() =>
    createSpansWorker({
      ...options,
      limits: { ...LIMITS, maxChunkBytes: LIMITS.maxQueueBytes + 1 },
    })
  ).toThrow(TypeError);
  expect(() =>
    createSpansWorker({ ...options, store: { readRun: () => null } })
  ).toThrow(TypeError);
  expect(() =>
    createSpansWorker({ ...options, spool: { append: () => null } })
  ).toThrow(TypeError);
  expect(() =>
    createSpansWorker({ ...options, launcher: { stop: () => null } })
  ).toThrow(TypeError);
  expect(() => createSpansWorker({ ...options, clock: {} })).toThrow(TypeError);
  expect(() => createSpansWorker({ ...options, workerId: '' })).toThrow(
    TypeError
  );
  expect(() => createSpansWorker({ ...options, preflight: 'yes' })).toThrow(
    TypeError
  );
});

// ---------------------------------------------------------------------------
// Intent before effect, immutable binding
// ---------------------------------------------------------------------------

test('saves the exact intent before the launcher runs, then records the process start', async () => {
  const h = harness();
  let seen;
  h.launcher.behavior = (request) => {
    seen = {
      key: request.idempotencyKey,
      record: h.store.attempt(),
      request,
    };
    return Promise.resolve(okLaunch());
  };
  const result = await h.worker.start(startInput());
  expect(result).toMatchObject({
    attemptId: 'attempt-1',
    created: true,
    nativeId: 'native-1',
    ok: true,
    processStart: { id: 'proc-1', pid: 4242 },
    ref: {
      actionId: 'action-1',
      attemptId: 'attempt-1',
      generation: 1,
      processStartId: 'proc-1',
      runId: 'run-1',
      spanId: 'a',
      workerId: 'worker-1',
    },
    status: 'running',
  });
  expect(seen.record).toMatchObject({
    actionId: 'action-1',
    attemptId: 'attempt-1',
    deadlineAt: 6000,
    generation: 1,
    nativeId: null,
    processStart: null,
    runId: 'run-1',
    spanId: 'a',
    status: 'launching',
    workerId: 'worker-1',
  });
  expect(seen.key).toBe(seen.record.attemptDigest);
  expect(seen.request.binding).toEqual({
    actionId: 'action-1',
    attemptId: 'attempt-1',
    generation: 1,
    runId: 'run-1',
    spanId: 'a',
    workerId: 'worker-1',
  });
  expect(
    h.log.filter((entry) =>
      [`commit:${TYPES.intent}`, 'launch', `commit:${TYPES.launched}`].includes(
        entry
      )
    )
  ).toEqual([`commit:${TYPES.intent}`, 'launch', `commit:${TYPES.launched}`]);
  expect(h.store.attempt()).toMatchObject({
    launchedAt: 1000,
    nativeId: 'native-1',
    processStart: { id: 'proc-1', pid: 4242 },
    status: 'running',
  });
  expect(h.store.events.map((event) => event.type)).toEqual([
    TYPES.intent,
    TYPES.launched,
  ]);
  expect(h.worker.inspect()).toMatchObject({ activeAttempts: 1 });
});

test('refuses an attempt whose action intent is missing, spent or bound elsewhere', async () => {
  const cases = [
    [
      (view) => {
        Reflect.deleteProperty(view.actions, 'action-1');
      },
      'ACTION_NOT_PREPARED',
    ],
    [
      (view) => {
        view.actions['action-1'].state = 'unknown';
      },
      'ACTION_NOT_PENDING',
    ],
    [
      (view) => {
        view.actions['action-1'].attemptId = 'attempt-9';
      },
      'ACTION_BINDING_MISMATCH',
    ],
    [
      (view) => {
        view.actions['action-1'].spanId = 'b';
      },
      'ACTION_BINDING_MISMATCH',
    ],
  ];
  for (const [mutate, code] of cases) {
    const view = initialView();
    mutate(view);
    const h = harness({ view });
    expect(
      // biome-ignore lint/performance/noAwaitInLoops: Each fixture is isolated and fully checked before the next is constructed.
      await h.worker.start(startInput())
    ).toMatchObject({ code, ok: false });
    expect(h.launcher.calls).toHaveLength(0);
    expect(h.store.commitCount).toBe(0);
    expect(h.worker.inspect().activeAttempts).toBe(0);
  }
});

test('an unconfirmed intent commit never launches and a retry never relaunches', async () => {
  for (const fault of ['refuse', 'throw']) {
    const h = harness();
    h.store.fault = () => fault;
    const failed =
      // biome-ignore lint/performance/noAwaitInLoops: Each fault mode needs its own fully settled store and launch assertion.
      await h.worker.start(startInput());
    expect(failed).toMatchObject({ code: 'COMMIT_FAILED', ok: false });
    expect(JSON.stringify(failed)).not.toContain('/private/path');
    expect(h.launcher.calls).toHaveLength(0);
  }

  const h = harness();
  h.store.fault = () => 'throw-after';
  expect(await h.worker.start(startInput())).toMatchObject({
    code: 'COMMIT_FAILED',
    ok: false,
  });
  h.store.fault = null;
  expect(h.store.attempt().status).toBe('launching');
  expect(await h.worker.start(startInput())).toMatchObject({
    created: false,
    ok: true,
    retryAllowed: false,
    status: 'launching',
    unresolved: true,
  });
  expect(h.launcher.calls).toHaveLength(0);
});

test('a changed binding for an existing attempt is a conflict, never a second launch', async () => {
  const h = harness();
  await begin(h);
  expect(await h.worker.start(startInput())).toMatchObject({
    created: false,
    ok: true,
    status: 'running',
  });
  expect(await h.worker.start(startInput(1, { generation: 2 }))).toMatchObject({
    code: 'ATTEMPT_CONFLICT',
    ok: false,
  });
  const restarted = h.makeWorker();
  expect(await restarted.start(startInput(1, { spanId: 'b' }))).toMatchObject({
    ok: false,
  });
  expect(h.launcher.calls).toHaveLength(1);
});

test('a failed preflight starts nothing and writes nothing', async () => {
  for (const preflight of [
    async () => ({ ok: false }),
    () => Promise.reject(new Error('gate detail')),
    async () => undefined,
  ]) {
    const h = harness({ preflight });
    const result =
      // biome-ignore lint/performance/noAwaitInLoops: Each preflight outcome is checked against a fresh worker before the next case.
      await h.worker.start(startInput());
    expect(result).toMatchObject({ code: 'PREFLIGHT_REFUSED', ok: false });
    expect(h.launcher.calls).toHaveLength(0);
    expect(h.store.commitCount).toBe(0);
    expect(h.worker.inspect().activeAttempts).toBe(0);
  }
  const h = harness({ preflight: async () => ({ ok: true }) });
  expect(await h.worker.start(startInput())).toMatchObject({ ok: true });
});

// ---------------------------------------------------------------------------
// Launch outcomes
// ---------------------------------------------------------------------------

test('a thrown launch is an unknown outcome held with a receipt, not a failure', async () => {
  const h = harness();
  h.launcher.behavior = () =>
    Promise.reject(new Error(`adapter detail ${SEED}`));
  const result = await h.worker.start(startInput());
  expect(result).toMatchObject({
    code: 'LAUNCH_UNKNOWN',
    held: true,
    launched: 'unknown',
    ok: false,
    unknown: true,
  });
  expect(JSON.stringify(result)).not.toContain('adapter detail');
  expect(result.receipt).toMatchObject({
    outcome: 'unknown',
    processStart: null,
    reason: 'launch-unknown',
    retryEligible: false,
    status: 'held',
  });
  expectInert(result.receipt);
  expect(h.store.attempt().status).toBe('held');

  const again = await h.worker.start(startInput());
  expect(again).toMatchObject({ created: false, ok: true, status: 'held' });
  expect(h.launcher.calls).toHaveLength(1);
  expect(h.launcher.stops).toHaveLength(0);
});

test('only an explicit launched:false refusal is recorded as not launched and retry-eligible', async () => {
  const h = harness();
  h.launcher.behavior = async () => ({
    code: 'NO_SLOT',
    error: `text with ${SEED}`,
    launched: false,
    ok: false,
  });
  const result = await h.worker.start(startInput());
  expect(result).toMatchObject({
    code: 'LAUNCH_REFUSED',
    launched: false,
    ok: false,
    recorded: true,
  });
  expect(JSON.stringify(result)).not.toContain(SEED);
  expect(result.receipt).toMatchObject({
    outcome: 'not-launched',
    reason: 'launch-refused',
    reasonCode: 'NO_SLOT',
    retryEligible: true,
    status: 'refused',
  });
  expectInert(result.receipt);
  expect(h.store.attempt().status).toBe('refused');
  expect(h.worker.inspect().activeAttempts).toBe(0);
});

test('ambiguous or malformed launch answers stay unknown', async () => {
  const answers = [
    { code: 'FAILED', ok: false },
    { ok: false },
    { ok: true },
    { ok: true, processStart: { pid: 5 } },
    { ok: true, processStart: { id: '' } },
    { ok: true, processStart: { id: SEED } },
    { ok: true, processStart: { id: 'proc', pid: -1 } },
    null,
    'started',
  ];
  for (const answer of answers) {
    const h = harness();
    h.launcher.behavior = async () => answer;
    expect(
      // biome-ignore lint/performance/noAwaitInLoops: Each malformed answer needs an independent worker and settled receipt check.
      await h.worker.start(startInput())
    ).toMatchObject({
      code: 'LAUNCH_UNKNOWN',
      held: true,
      ok: false,
    });
    expect(h.store.attempt()).toMatchObject({
      processStart: null,
      status: 'held',
    });
    expect(h.worker.inspect().activeAttempts).toBe(0);
  }
});

test('a launch whose record write is not confirmed is held with the observed process start', async () => {
  const h = harness();
  h.store.fault = (request) =>
    request.events.some((event) => event.type === TYPES.launched)
      ? 'refuse'
      : undefined;
  const result = await h.worker.start(startInput());
  expect(result).toMatchObject({
    code: 'LAUNCH_RECORD_UNCONFIRMED',
    held: true,
    launched: true,
    ok: false,
    unknown: true,
  });
  expect(h.store.attempt()).toMatchObject({
    nativeId: 'native-1',
    processStart: { id: 'proc-1', pid: 4242 },
    status: 'held',
  });
  expect(result.receipt.reason).toBe('launch-record-unconfirmed');
  expect(h.store.events.map((event) => event.type)).toEqual([
    TYPES.intent,
    TYPES.held,
  ]);
  expect(h.launcher.stops).toHaveLength(0);
});

// ---------------------------------------------------------------------------
// Crashes
// ---------------------------------------------------------------------------

test('crash after intent and before the launch answer is recovered as unknown, never relaunched', async () => {
  const h = harness();
  h.launcher.behavior = () =>
    new Promise(() => {
      // This fixture deliberately leaves launch unresolved.
    });
  // The launch never answers: this stands in for the process dying mid-launch.
  const hung = h.worker.start(startInput());
  expect(hung).toBeInstanceOf(Promise);
  await flush();
  expect(h.store.attempt().status).toBe('launching');

  const restarted = h.makeWorker();
  h.launcher.behavior = async () => okLaunch();
  expect(await restarted.start(startInput())).toMatchObject({
    created: false,
    ok: true,
    retryAllowed: false,
    status: 'launching',
    unresolved: true,
  });
  expect(h.launcher.calls).toHaveLength(1);

  const recovered = await restarted.recover(bindingInput());
  expect(recovered).toMatchObject({
    duplicate: false,
    held: true,
    ok: true,
    status: 'held',
  });
  expect(recovered.receipt).toMatchObject({
    outcome: 'unknown',
    reason: 'launch-unknown',
    recoveredAtGeneration: 1,
    retryEligible: false,
  });
  expect(recovered.receipt.capture).toMatchObject({
    bytes: 0,
    chunks: 0,
    countsConfirmed: true,
  });
  expectInert(recovered.receipt);
  expect(await restarted.recover(bindingInput())).toMatchObject({
    duplicate: true,
    ok: true,
    status: 'held',
  });
  expect(h.launcher.calls).toHaveLength(1);
  expect(h.launcher.stops).toHaveLength(0);
});

test('crash after launch is recovered from the spool counts without touching the process', async () => {
  const h = harness();
  const started = await begin(h);
  await h.worker.captureChunk({ ...refOf(started), seq: 0, text: 'first\n' });
  await h.worker.captureChunk({ ...refOf(started), seq: 1, text: 'second\n' });

  const restarted = h.makeWorker();
  expect(await restarted.recover(bindingInput())).toMatchObject({ ok: true });
  const { receipt } = await restarted.getReceipt({
    attemptId: 'attempt-1',
    runId: 'run-1',
  });
  expect(receipt).toMatchObject({
    deadlineAt: 6000,
    nativeId: 'native-1',
    outcome: 'unknown',
    processStart: { id: 'proc-1', pid: 4242 },
    reason: 'worker-lost',
    status: 'held',
  });
  expect(receipt.capture).toMatchObject({
    bytes: 13,
    chunks: 2,
    complete: false,
    countsConfirmed: true,
    gap: { fromSeq: 2, reason: 'worker-lost' },
  });
  expectInert(receipt);
  expect(h.launcher.stops).toHaveLength(0);

  // The old worker is stale: its exit cannot overwrite the held record.
  const late = await h.worker.observeExit({
    ...refOf(started),
    exit: { code: 0, signal: null },
  });
  expect(late).toMatchObject({ code: 'ATTEMPT_CLOSED', ok: false });
  expect(h.store.attempt().status).toBe('held');
  expect(h.spool.finalized).toHaveLength(0);
});

test('recovery is refused while a live worker owns the attempt', async () => {
  const h = harness();
  await begin(h);
  expect(await h.worker.recover(bindingInput())).toMatchObject({
    code: 'ATTEMPT_ACTIVE',
    ok: false,
  });
  expect(h.store.attempt().status).toBe('running');
});

test('recovery without spool counts says so instead of guessing', async () => {
  const h = harness();
  const started = await begin(h);
  await h.worker.captureChunk({ ...refOf(started), seq: 0, text: 'x\n' });
  const bare = createSpansWorker({
    ...h.options,
    spool: { append: h.spool.append, finalize: h.spool.finalize },
  });
  const recovered = await bare.recover(bindingInput());
  expect(recovered.receipt.capture).toMatchObject({
    chunks: 0,
    countsConfirmed: false,
  });
});

test('recovery of a flush that never produced its terminal receipt is held as interrupted', async () => {
  const h = harness();
  const started = await begin(h);
  await h.worker.captureChunk({ ...refOf(started), seq: 0, text: 'done\n' });
  h.store.fault = (request) =>
    request.events.some((event) => event.type === TYPES.exited)
      ? 'refuse'
      : undefined;
  const exited = await h.worker.observeExit({
    ...refOf(started),
    exit: { code: 0, signal: null },
  });
  expect(exited).toMatchObject({
    cause: 'COMMIT_FAILED',
    code: 'TERMINAL_UNCONFIRMED',
    ok: false,
    unknown: true,
  });
  expect(h.store.attempt()).toMatchObject({
    exit: { code: 0, signal: null },
    status: 'finalizing',
  });
  h.store.fault = null;
  const recovered = await h.makeWorker().recover(bindingInput());
  expect(recovered.receipt).toMatchObject({
    exit: { code: 0, signal: null },
    outcome: 'unknown',
    reason: 'finalize-interrupted',
    status: 'held',
  });
});

// ---------------------------------------------------------------------------
// Native session identity
// ---------------------------------------------------------------------------

test('a native ID reported during launch is persisted once the launch is recorded', async () => {
  const h = harness();
  h.launcher.behavior = (request) => {
    request.sink.native('native-early');
    request.sink.chunk('early output\n');
    return Promise.resolve({
      ok: true,
      processStart: { id: 'proc-1', pid: 1 },
    });
  };
  const result = await h.worker.start(startInput());
  // The ID is written as soon as it is reported, not after the launch, so the
  // start answer reports it as recorded or not yet depending on the race with
  // the unawaited write; the record settles on it either way.
  expect(result.ok).toBe(true);
  expect([null, 'native-early']).toContain(result.nativeId);
  await until(
    () =>
      h.spool.chunks.length === 1 &&
      h.store.attempt().nativeId === 'native-early'
  );
  expect(h.store.attempt().nativeId).toBe('native-early');
  expect(h.spool.texts()).toEqual(['early output\n']);
});

test('a native ID is committed immediately, even while capture is blocked', async () => {
  const h = harness();
  h.launcher.behavior = async () => ({
    ok: true,
    processStart: { id: 'proc-1', pid: 1 },
  });
  const started = await begin(h);
  h.spool.gate = deferred();
  const pending = h.worker.captureChunk({
    ...refOf(started),
    seq: 0,
    text: 'hello\n',
  });
  await flush();

  const native = await h.worker.observeNative({
    ...refOf(started),
    nativeId: 'native-late',
  });
  expect(native).toMatchObject({ duplicate: false, ok: true });
  expect(h.store.attempt().nativeId).toBe('native-late');
  expect(h.spool.chunks).toHaveLength(0);
  h.spool.gate.resolve();
  expect(await pending).toMatchObject({ ok: true });

  const commits = h.store.commitCount;
  expect(
    await h.worker.observeNative({ ...refOf(started), nativeId: 'native-late' })
  ).toMatchObject({ duplicate: true, ok: true });
  expect(h.store.commitCount).toBe(commits);
  expect(
    await h.worker.observeNative({
      ...refOf(started),
      nativeId: 'native-other',
    })
  ).toMatchObject({ code: 'NATIVE_ID_CONFLICT', ok: false });
  expect(h.store.attempt().nativeId).toBe('native-late');
});

test('a conflicting native ID in the launch answer cannot replace the first one, even when the early report was not awaited', async () => {
  const h = harness();
  h.launcher.behavior = (request) => {
    request.sink.native('native-early');
    return Promise.resolve(okLaunch());
  };
  const result = await settled(h.worker.start(startInput()));
  expect(result).toMatchObject({
    code: 'NATIVE_ID_CONFLICT',
    held: true,
    ok: false,
    unknown: true,
  });
  await flush();
  expect(h.store.attempt()).toMatchObject({
    nativeId: 'native-early',
    status: 'held',
  });
  expect(JSON.stringify(h.store.view)).not.toContain('"nativeId":"native-1"');
});

test('unsafe native IDs are refused and nothing is stored', async () => {
  const h = harness();
  const started = await begin(h);
  const commits = h.store.commitCount;
  for (const nativeId of ['', ' x', 'a\nb', 'x'.repeat(300), SEED, 42, null]) {
    expect(
      // biome-ignore lint/performance/noAwaitInLoops: Each invalid callback must settle before the unchanged-state assertions.
      await h.worker.observeNative({ ...refOf(started), nativeId })
    ).toMatchObject({ code: 'NATIVE_ID_INVALID', ok: false });
  }
  expect(h.store.commitCount).toBe(commits);
  expect(JSON.stringify(h.store.view)).not.toContain(SEED);
});

test('an unconfirmed native ID write can be reported again', async () => {
  const h = harness();
  h.launcher.behavior = async () => ({
    ok: true,
    processStart: { id: 'proc-1', pid: 1 },
  });
  const started = await begin(h);
  h.store.fault = (request) =>
    request.events.some((event) => event.type === TYPES.native)
      ? 'refuse'
      : undefined;
  expect(
    await h.worker.observeNative({ ...refOf(started), nativeId: 'native-9' })
  ).toMatchObject({ code: 'COMMIT_FAILED', ok: false });
  expect(h.store.attempt().nativeId).toBeNull();
  h.store.fault = null;
  expect(
    await h.worker.observeNative({ ...refOf(started), nativeId: 'native-9' })
  ).toMatchObject({ duplicate: false, ok: true });
  expect(h.store.attempt().nativeId).toBe('native-9');
});

test('a missing native ID stays missing and never implies resume', async () => {
  const h = harness();
  h.launcher.behavior = async () => ({
    ok: true,
    processStart: { id: 'proc-1', pid: 1 },
  });
  const started = await begin(h);
  const exited = await h.worker.observeExit({
    ...refOf(started),
    exit: { code: 0, signal: null },
  });
  expect(exited.receipt).toMatchObject({
    nativeId: null,
    nativeIdState: 'missing',
    resumeAvailable: false,
  });
});

// ---------------------------------------------------------------------------
// Capture
// ---------------------------------------------------------------------------

test('chunks are redacted before the spool and nothing secret reaches storage', async () => {
  const h = harness();
  const started = await begin(h);
  const result = await h.worker.captureChunk({
    ...refOf(started),
    seq: 0,
    text: `deploy key ${SEED} ok\n`,
  });
  expect(result).toMatchObject({ duplicate: false, ok: true, seq: 0 });
  expect(h.spool.texts()).toEqual(['deploy key [REDACTED] ok\n']);
  // No record end: held raw in memory until the exit flushes it redacted.
  await h.worker.captureChunk({
    ...refOf(started),
    seq: 1,
    text: `token=${SEED}`,
  });
  expect(h.spool.texts()).toEqual(['deploy key [REDACTED] ok\n']);
  const exited = await h.worker.observeExit({
    ...refOf(started),
    exit: { code: 0, signal: null },
  });
  expect(exited.receipt.capture.bytes).toBe(
    h.spool.chunks.reduce((total, chunk) => total + chunk.bytes, 0)
  );
  const stored = JSON.stringify([
    h.store.view,
    h.store.events,
    h.spool.chunks,
    h.spool.finalized,
  ]);
  expect(stored).not.toContain(SEED);
  expect(stored).toContain('[REDACTED]');
});

test('duplicate chunks are idempotent, conflicts and gaps are refused', async () => {
  const h = harness();
  const started = await begin(h);
  const ref = refOf(started);
  expect(
    await h.worker.captureChunk({ ...ref, seq: 0, text: 'aaa\n' })
  ).toMatchObject({ duplicate: false, ok: true });
  expect(
    await h.worker.captureChunk({ ...ref, seq: 0, text: 'aaa\n' })
  ).toMatchObject({ duplicate: true, ok: true, seq: 0 });
  expect(h.spool.appends).toBe(1);
  expect(
    await h.worker.captureChunk({ ...ref, seq: 0, text: 'bbb\n' })
  ).toMatchObject({ code: 'CHUNK_CONFLICT', ok: false });
  expect(
    await h.worker.captureChunk({ ...ref, seq: 2, text: 'ccc\n' })
  ).toMatchObject({ code: 'CHUNK_OUT_OF_ORDER', expectedSeq: 1, ok: false });
  expect(h.spool.appends).toBe(1);
  expect(
    await h.worker.captureChunk({ ...ref, seq: 1, text: 'ccc\n' })
  ).toMatchObject({ ok: true });
  expect(h.spool.texts()).toEqual(['aaa\n', 'ccc\n']);
  expect(h.store.attempt().status).toBe('running');
});

test('an oversized chunk is refused whole and never truncated or counted', async () => {
  const h = harness();
  const started = await begin(h);
  const ref = refOf(started);
  // 40 characters but 120 bytes: the limit is bytes.
  for (const text of ['x'.repeat(101), '€'.repeat(40)]) {
    expect(
      // biome-ignore lint/performance/noAwaitInLoops: Each rejected caller chunk is checked before the next exact-boundary input.
      await h.worker.captureChunk({ ...ref, seq: 0, text })
    ).toMatchObject({
      code: 'CHUNK_TOO_LARGE',
      ok: false,
    });
    expect(await h.launcher.sink.chunk(text)).toMatchObject({
      code: 'CHUNK_TOO_LARGE',
    });
  }
  expect(h.spool.appends).toBe(0);
  expect(h.store.attempt().status).toBe('running');
  expect(h.worker.inspect().queuedBytes).toBe(0);
  expect(
    await h.worker.captureChunk({ ...ref, seq: 0, text: 'x'.repeat(100) })
  ).toMatchObject({ duplicate: false, ok: true, seq: 0 });
});

test('a full queue pushes back on the caller and nothing is discarded', async () => {
  const h = harness();
  const started = await begin(h);
  const ref = refOf(started);
  const texts = ['0', '1', '2'].map((digit) => `${digit.repeat(99)}\n`);
  h.spool.gate = deferred();
  const first = h.worker.captureChunk({ ...ref, seq: 0, text: texts[0] });
  const second = h.worker.captureChunk({ ...ref, seq: 1, text: texts[1] });
  await flush();
  expect(h.worker.inspect().queuedBytes).toBe(200);

  const refused = await h.worker.captureChunk({
    ...ref,
    seq: 2,
    text: texts[2],
  });
  expect(refused).toMatchObject({
    code: 'BACKPRESSURE',
    ok: false,
    retryable: true,
  });
  expect(h.store.attempt().status).toBe('running');

  const { gate } = h.spool;
  h.spool.gate = null;
  gate.resolve();
  expect(await first).toMatchObject({ ok: true });
  expect(await second).toMatchObject({ ok: true });
  expect(
    await h.worker.captureChunk({ ...ref, seq: 2, text: texts[2] })
  ).toMatchObject({ duplicate: false, ok: true });
  expect(h.spool.chunks.map((chunk) => chunk.seq)).toEqual([0, 1, 2]);
  expect(h.spool.texts()).toEqual(texts);
  expect(h.worker.inspect().queuedBytes).toBe(0);
});

test('a retryable spool answer is backpressure, not a capture failure', async () => {
  const h = harness();
  const started = await begin(h);
  h.spool.appendFault = (_payload, count) =>
    count === 1 ? 'retry' : undefined;
  const ref = refOf(started);
  expect(
    await h.worker.captureChunk({ ...ref, seq: 0, text: 'again\n' })
  ).toMatchObject({ code: 'BACKPRESSURE', ok: false, retryable: true });
  expect(h.store.attempt().status).toBe('running');
  expect(h.spool.chunks).toHaveLength(0);
  expect(
    await h.worker.captureChunk({ ...ref, seq: 0, text: 'again\n' })
  ).toMatchObject({ duplicate: false, ok: true, seq: 0 });
  expect(h.spool.texts()).toEqual(['again\n']);
});

test('a spool failure holds the attempt with an explicit capture gap and stops capture', async () => {
  for (const fault of ['fail', 'throw']) {
    const h = harness();
    const started =
      // biome-ignore lint/performance/noAwaitInLoops: Each spool fault runs against a fresh attempt and is asserted before the next.
      await begin(h);
    h.spool.appendFault = (_payload, count) =>
      count === 2 ? fault : undefined;
    const ref = refOf(started);
    await h.worker.captureChunk({ ...ref, seq: 0, text: 'kept\n' });
    const failed = await h.worker.captureChunk({
      ...ref,
      seq: 1,
      text: 'lost\n',
    });
    expect(failed).toMatchObject({
      code: 'CAPTURE_FAILED',
      held: true,
      ok: false,
    });
    expect(JSON.stringify(failed)).not.toContain('/private/spool/path');

    const record = h.store.attempt();
    expect(record).toMatchObject({ status: 'held' });
    expect(record.receipt).toMatchObject({
      outcome: 'unknown',
      reason: 'capture-failed',
      status: 'held',
    });
    expect(record.capture).toMatchObject({
      chunks: 1,
      complete: false,
      gap: { fromSeq: 1, reason: 'capture-failed' },
    });
    expect(record.capture.artifactId).toMatch(ARTIFACT_ID);
    expect(h.spool.finalized[0]).toMatchObject({ chunks: 1, complete: false });
    expect(h.spool.texts()).toEqual(['kept\n']);
    expect(h.launcher.stops).toHaveLength(0);

    expect(await h.launcher.sink.chunk('later\n')).toMatchObject({
      code: 'ATTEMPT_CLOSED',
    });
    expect(
      await h.worker.captureChunk({ ...ref, seq: 1, text: 'later\n' })
    ).toMatchObject({ code: 'ATTEMPT_NOT_ACTIVE' });
    expect(h.spool.texts()).toEqual(['kept\n']);
    expect(h.worker.inspect().activeAttempts).toBe(0);
  }
});

test('reaching the per-attempt capture limit holds instead of dropping', async () => {
  const cases = [
    [{ maxAttemptChunks: 2 }, ['a\n', 'b\n', 'c\n']],
    [{ maxAttemptBytes: 150 }, [`${'1'.repeat(99)}\n`, `${'2'.repeat(99)}\n`]],
  ];
  for (const [limits, texts] of cases) {
    const h = harness({ limits });
    const started =
      // biome-ignore lint/performance/noAwaitInLoops: Each case has independent limits and ordered capture state.
      await begin(h);
    const results = [];
    for (const [seq, text] of texts.entries()) {
      const result =
        // biome-ignore lint/performance/noAwaitInLoops: Caller chunks must be processed in sequence for the retry and framing assertions.
        await h.worker.captureChunk({ ...refOf(started), seq, text });
      results.push(result);
    }
    expect(results.at(-1)).toMatchObject({
      code: 'SPOOL_LIMIT',
      held: true,
      ok: false,
    });
    expect(h.spool.chunks).toHaveLength(texts.length - 1);
    expect(h.store.attempt().receipt).toMatchObject({
      reason: 'spool-limit',
      status: 'held',
    });
    expect(h.store.attempt().capture.gap).toEqual({
      fromSeq: texts.length - 1,
      reason: 'spool-limit',
    });
  }
});

// ---------------------------------------------------------------------------
// Deadline
// ---------------------------------------------------------------------------

test('the deadline turns into an explicit held unknown with a receipt, without stopping the process', async () => {
  const h = harness();
  const started = await begin(h);
  await h.worker.captureChunk({ ...refOf(started), seq: 0, text: 'partial\n' });
  expect(await h.worker.enforceDeadline(refOf(started))).toMatchObject({
    expired: false,
    ok: true,
    remainingMs: 5000,
  });
  expect(h.store.attempt().status).toBe('running');

  h.clock.time = 6000;
  const expired = await h.worker.enforceDeadline(refOf(started));
  expect(expired).toMatchObject({
    expired: true,
    held: true,
    ok: true,
    status: 'held',
  });
  expect(expired.receipt).toMatchObject({
    deadlineAt: 6000,
    outcome: 'unknown',
    reason: 'deadline',
    status: 'held',
  });
  expectInert(expired.receipt);
  expect(expired.receipt.capture).toMatchObject({
    chunks: 1,
    complete: false,
    gap: { fromSeq: 1, reason: 'deadline' },
  });
  expect(expired.receipt.capture.artifactId).toMatch(ARTIFACT_ID);
  expect(h.launcher.stops).toHaveLength(0);
  expect(await h.launcher.sink.chunk('late')).toMatchObject({
    code: 'ATTEMPT_CLOSED',
  });
  expect(await h.worker.enforceDeadline(refOf(started))).toMatchObject({
    code: 'ATTEMPT_NOT_ACTIVE',
  });
});

test('an unusable clock neither starts nor expires anything', async () => {
  const h = harness();
  h.clock.now = () => 'soon';
  expect(await h.worker.start(startInput())).toMatchObject({
    code: 'CLOCK_INVALID',
    ok: false,
  });
  expect(h.launcher.calls).toHaveLength(0);

  const live = harness();
  const started = await begin(live);
  live.clock.now = () => -5;
  expect(await live.worker.enforceDeadline(refOf(started))).toMatchObject({
    code: 'CLOCK_INVALID',
  });
  expect(live.store.attempt().status).toBe('running');
});

test('the deadline sweep holds only expired attempts', async () => {
  const h = harness();
  await begin(h, 1);
  await begin(h, 2, { deadlineMs: 20_000 });
  h.clock.time = 6000;
  expect(await h.worker.enforceDeadlines()).toEqual({
    failed: [],
    held: ['attempt-1'],
    ok: true,
  });
  expect(h.store.attempt('attempt-1').status).toBe('held');
  expect(h.store.attempt('attempt-2').status).toBe('running');
  expect(h.worker.inspect().activeAttempts).toBe(1);
});

test('start refuses a deadline beyond the caller limit and bounds the active attempts', async () => {
  const h = harness({ limits: { maxActiveAttempts: 1 } });
  expect(
    await h.worker.start(
      startInput(1, { deadlineMs: LIMITS.maxDeadlineMs + 1 })
    )
  ).toMatchObject({ code: 'DEADLINE_INVALID' });
  const first = await begin(h, 1);
  expect(await h.worker.start(startInput(2))).toMatchObject({
    code: 'WORKER_FULL',
    ok: false,
  });
  expect(h.launcher.calls).toHaveLength(1);
  await h.worker.observeExit({
    ...refOf(first),
    exit: { code: 0, signal: null },
  });
  expect(await h.worker.start(startInput(2))).toMatchObject({ ok: true });
});

// ---------------------------------------------------------------------------
// Exit and terminal flush
// ---------------------------------------------------------------------------

test('queued chunks are flushed before the terminal receipt and exit never accepts the work', async () => {
  const h = harness();
  const started = await begin(h);
  const ref = refOf(started);
  h.spool.gate = deferred();
  const first = h.worker.captureChunk({ ...ref, seq: 0, text: 'one\n' });
  const second = h.worker.captureChunk({ ...ref, seq: 1, text: 'two\n' });
  await flush();

  const exiting = h.worker.observeExit({
    ...ref,
    exit: { code: 0, signal: null },
  });
  await flush();
  expect(h.log).not.toContain('finalize');
  expect(h.store.attempt().status).toBe('running');
  expect(await h.launcher.sink.chunk('after exit\n')).toMatchObject({
    code: 'ATTEMPT_CLOSED',
  });

  const { gate } = h.spool;
  h.spool.gate = null;
  gate.resolve();
  await first;
  await second;
  const done = await exiting;

  expect(
    h.log.filter(
      (entry) =>
        entry.startsWith('append') ||
        entry === 'finalize' ||
        entry === `commit:${TYPES.finalizing}` ||
        entry === `commit:${TYPES.exited}`
    )
  ).toEqual([
    'append:0',
    'append:1',
    `commit:${TYPES.finalizing}`,
    'finalize',
    `commit:${TYPES.exited}`,
  ]);
  expect(done).toMatchObject({ duplicate: false, ok: true, status: 'exited' });
  expect(done.receipt).toMatchObject({
    exit: { code: 0, signal: null },
    nativeId: 'native-1',
    outcome: 'process-exited',
    processStart: { id: 'proc-1', pid: 4242 },
    reason: 'process-exited',
    retryEligible: false,
    status: 'exited',
  });
  expect(done.receipt.capture).toMatchObject({
    bytes: 8,
    chunks: 2,
    complete: true,
    gap: null,
  });
  expect(done.receipt.capture.artifactId).toBe(h.spool.finalized[0].artifactId);
  expect(h.spool.finalized[0]).toMatchObject({
    chunks: 2,
    complete: true,
    texts: ['one\n', 'two\n'],
  });
  expectInert(done.receipt);

  // Process exit is an observation: the action and span are untouched.
  const { view } = h.store;
  expect(view.actions['action-1'].state).toBe('intent');
  expect(view.spans.a.state).toBe('ready');
  expect(view.checkpoint).toBe(0);
  expect(h.store.events.map((event) => event.type)).toEqual([
    TYPES.intent,
    TYPES.launched,
    TYPES.finalizing,
    TYPES.exited,
  ]);
  expect(h.worker.inspect().activeAttempts).toBe(0);
});

test('a signal exit is recorded without being read as success or failure', async () => {
  const h = harness();
  const started = await begin(h);
  const exited = await h.worker.observeExit({
    ...refOf(started),
    exit: { signal: 'SIGKILL' },
  });
  expect(exited.receipt).toMatchObject({
    exit: { code: null, signal: 'SIGKILL' },
    outcome: 'process-exited',
    workAccepted: false,
  });
});

test('a failed final flush holds the attempt and keeps the observed exit', async () => {
  for (const fault of ['fail', 'throw', 'bad']) {
    const h = harness();
    const started =
      // biome-ignore lint/performance/noAwaitInLoops: Each finalization fault is isolated and checked to completion.
      await begin(h);
    await h.worker.captureChunk({ ...refOf(started), seq: 0, text: 'data\n' });
    h.spool.finalizeFault = () => fault;
    const exited = await h.worker.observeExit({
      ...refOf(started),
      exit: { code: 0, signal: null },
    });
    expect(exited).toMatchObject({
      code: 'CAPTURE_FAILED',
      held: true,
      ok: false,
    });
    expect(JSON.stringify(exited)).not.toContain('/private/spool/path');
    expect(exited.receipt).toMatchObject({
      exit: { code: 0, signal: null },
      outcome: 'unknown',
      reason: 'finalize-failed',
      status: 'held',
    });
    expect(exited.receipt.capture).toMatchObject({
      artifactId: null,
      chunks: 1,
      complete: false,
    });
    expect(h.store.events.map((event) => event.type)).toEqual([
      TYPES.intent,
      TYPES.launched,
      TYPES.finalizing,
      TYPES.held,
    ]);
  }
});

test('duplicate exit callbacks return the same receipt and a different exit is a conflict', async () => {
  const h = harness();
  const started = await begin(h);
  const ref = refOf(started);
  const exit = { code: 0, signal: null };
  const [first, second, conflicting] = await Promise.all([
    h.worker.observeExit({ ...ref, exit }),
    h.worker.observeExit({ ...ref, exit }),
    h.worker.observeExit({ ...ref, exit: { code: 1, signal: null } }),
  ]);
  expect(first).toMatchObject({ duplicate: false, ok: true });
  expect(second).toMatchObject({ duplicate: true, ok: true });
  expect(second.receipt).toEqual(first.receipt);
  expect(conflicting).toMatchObject({ code: 'EXIT_CONFLICT', ok: false });
  expect(h.store.events).toHaveLength(4);
  const commits = h.store.commitCount;

  // After the worker released the attempt the record still answers a repeat.
  expect(await h.worker.observeExit({ ...ref, exit })).toMatchObject({
    duplicate: true,
    ok: true,
    status: 'exited',
  });
  expect(
    await h.worker.observeExit({ ...ref, exit: { code: 1, signal: null } })
  ).toMatchObject({ code: 'ATTEMPT_NOT_ACTIVE', ok: false });
  expect(await h.launcher.sink.exit(exit)).toMatchObject({
    duplicate: true,
    ok: true,
  });
  expect(h.store.commitCount).toBe(commits);
});

test('late callbacks after the terminal receipt and callbacks from another process are inert', async () => {
  const h = harness();
  const started = await begin(h);
  const ref = refOf(started);
  expect(
    await h.worker.captureChunk({
      ...ref,
      processStartId: 'proc-0',
      seq: 0,
      text: 'old process',
    })
  ).toMatchObject({ code: 'BINDING_MISMATCH', ok: false });
  expect(h.spool.appends).toBe(0);
  for (const override of [
    { workerId: 'worker-2' },
    { spanId: 'b' },
    { actionId: 'action-2' },
    { attemptId: 'attempt-2' },
  ]) {
    const result =
      // biome-ignore lint/performance/noAwaitInLoops: Each stale binding is awaited and checked before trying another identity.
      await h.worker.captureChunk({
        ...ref,
        ...override,
        seq: 0,
        text: 'x',
      });
    expect(result.ok).toBe(false);
  }
  expect(h.spool.appends).toBe(0);

  await h.worker.observeExit({ ...ref, exit: { code: 0, signal: null } });
  const commits = h.store.commitCount;
  expect(
    await h.worker.captureChunk({ ...ref, seq: 0, text: 'late' })
  ).toMatchObject({ code: 'ATTEMPT_NOT_ACTIVE', ok: false });
  expect(
    await h.worker.observeNative({ ...ref, nativeId: 'native-other' })
  ).toMatchObject({ code: 'ATTEMPT_NOT_ACTIVE', ok: false });
  expect(await h.launcher.sink.native('native-other')).toMatchObject({
    ok: false,
  });
  expect(h.spool.appends).toBe(0);
  expect(h.store.commitCount).toBe(commits);
});

// ---------------------------------------------------------------------------
// Generation fencing and compare-and-set
// ---------------------------------------------------------------------------

test('a stale generation is inert and a newer coordinator reconciles the attempt', async () => {
  const h = harness();
  const started = await begin(h);
  const ref = refOf(started);
  await h.worker.captureChunk({ ...ref, seq: 0, text: 'one\n' });
  h.store.bumpGeneration();

  const commits = h.store.commitCount;
  expect(
    await h.worker.captureChunk({
      ...ref,
      generation: 0,
      seq: 1,
      text: 'older\n',
    })
  ).toMatchObject({ code: 'STALE_GENERATION', ok: false });
  expect(h.spool.texts()).toEqual(['one\n']);
  expect(h.store.commitCount).toBe(commits);

  const exited = await h.worker.observeExit({
    ...ref,
    exit: { code: 0, signal: null },
  });
  expect(exited).toMatchObject({
    cause: 'STALE_GENERATION',
    code: 'FINALIZE_UNCONFIRMED',
    ok: false,
    unknown: true,
  });
  expect(h.store.attempt()).toMatchObject({ exit: null, status: 'running' });
  expect(h.spool.finalized).toHaveLength(0);
  expect(await h.launcher.sink.chunk('late')).toMatchObject({
    code: 'ATTEMPT_CLOSED',
  });
  expect(h.worker.inspect().activeAttempts).toBe(0);

  const successor = h.makeWorker();
  expect(
    await successor.recover({ ...bindingInput(), coordinatorGeneration: 1 })
  ).toMatchObject({ code: 'STALE_GENERATION', ok: false });
  const recovered = await successor.recover({
    ...bindingInput(),
    coordinatorGeneration: 2,
  });
  expect(recovered.receipt).toMatchObject({
    generation: 1,
    reason: 'worker-lost',
    recoveredAtGeneration: 2,
  });

  // The newer coordinator may cancel by exact identity; the attempt's own
  // generation stays immutable.
  expect(
    await successor.cancel({ ...ref, coordinatorGeneration: 2 })
  ).toMatchObject({ cancel: 'delivered', ok: true });
  expect(h.store.attempt().generation).toBe(1);
});

test('a revision conflict rereads and retries, then gives up explicitly', async () => {
  const h = harness();
  h.store.fault = (_request, count) => (count === 1 ? 'conflict' : undefined);
  expect(await h.worker.start(startInput())).toMatchObject({ ok: true });
  expect(h.store.commitCount).toBe(3);
  expect(h.store.events.map((event) => event.type)).toEqual([
    TYPES.intent,
    TYPES.launched,
  ]);

  const stuck = harness();
  stuck.store.fault = () => 'conflict';
  expect(await stuck.worker.start(startInput())).toMatchObject({
    code: 'STALE_REVISION',
    ok: false,
  });
  expect(stuck.store.commitCount).toBe(4);
  expect(stuck.launcher.calls).toHaveLength(0);
});

// ---------------------------------------------------------------------------
// Cancellation
// ---------------------------------------------------------------------------

test('cancel needs the exact owner, saves its request before stopping and does not claim an exit', async () => {
  const h = harness();
  const started = await begin(h);
  const ref = refOf(started);
  const baseline = h.store.commitCount;
  const mismatches = [
    [{ processStartId: 'proc-x' }, 'BINDING_MISMATCH'],
    [{ workerId: 'worker-2' }, 'BINDING_MISMATCH'],
    [{ spanId: 'b' }, 'BINDING_MISMATCH'],
    [{ actionId: 'action-2' }, 'BINDING_MISMATCH'],
    [{ attemptId: 'attempt-2' }, 'ATTEMPT_NOT_FOUND'],
    [{ generation: 0 }, 'STALE_GENERATION'],
    [{ generation: 2 }, 'STALE_GENERATION'],
  ];
  for (const [override, code] of mismatches) {
    expect(
      // biome-ignore lint/performance/noAwaitInLoops: Each mismatch check observes the same unchanged running attempt.
      await h.worker.cancel({ ...ref, ...override })
    ).toMatchObject({
      code,
      ok: false,
    });
  }
  expect(h.launcher.stops).toHaveLength(0);
  expect(h.store.commitCount).toBe(baseline);

  let atStop;
  h.launcher.stopBehavior = () => {
    atStop = h.store.attempt().cancel;
    return Promise.resolve({ ok: true });
  };
  expect(await h.worker.cancel(ref)).toMatchObject({
    cancel: 'delivered',
    ok: true,
    terminal: false,
  });
  expect(atStop).toMatchObject({ state: 'requested' });
  expect(h.launcher.stops[0]).toMatchObject({
    binding: { attemptId: 'attempt-1', workerId: 'worker-1' },
    processStartId: 'proc-1',
  });
  expect(h.store.attempt()).toMatchObject({
    cancel: { state: 'delivered' },
    status: 'running',
  });
  expect(await h.worker.cancel(ref)).toMatchObject({
    cancel: 'delivered',
    duplicate: true,
    ok: true,
  });
  expect(h.launcher.stops).toHaveLength(1);

  const exited = await h.worker.observeExit({
    ...ref,
    exit: { code: 143, signal: null },
  });
  expect(exited.receipt).toMatchObject({
    cancel: { state: 'delivered' },
    outcome: 'process-exited',
    status: 'exited',
    workAccepted: false,
  });
  expect(await h.worker.cancel(ref)).toMatchObject({ code: 'ATTEMPT_CLOSED' });
});

test('an unconfirmed stop stays unknown and is never retried automatically', async () => {
  for (const stopBehavior of [
    () => Promise.reject(new Error('stop detail /private/path')),
    async () => ({ ok: false }),
    async () => undefined,
  ]) {
    const h = harness();
    const started =
      // biome-ignore lint/performance/noAwaitInLoops: Each stop outcome is checked with a fresh attempt before the next.
      await begin(h);
    h.launcher.stopBehavior = stopBehavior;
    const result = await h.worker.cancel(refOf(started));
    expect(result).toMatchObject({
      cancel: 'unknown',
      code: 'CANCEL_UNKNOWN',
      ok: false,
      unknown: true,
    });
    expect(JSON.stringify(result)).not.toContain('/private/path');
    expect(h.store.attempt()).toMatchObject({
      cancel: { state: 'unknown' },
      status: 'running',
    });
    expect(await h.worker.cancel(refOf(started))).toMatchObject({
      cancel: 'unknown',
      duplicate: true,
    });
    expect(h.launcher.stops).toHaveLength(1);
  }
});

test('cancel is unavailable without a stop adapter or a recorded process start', async () => {
  const noStop = harness({ withStop: false });
  const started = await begin(noStop);
  const commits = noStop.store.commitCount;
  expect(await noStop.worker.cancel(refOf(started))).toMatchObject({
    code: 'CANCEL_UNSUPPORTED',
  });
  expect(noStop.store.commitCount).toBe(commits);

  const unknown = harness();
  unknown.launcher.behavior = () => Promise.reject(new Error('lost'));
  await unknown.worker.start(startInput());
  expect(
    await unknown.worker.cancel({ ...bindingInput(), processStartId: 'proc-1' })
  ).toMatchObject({ code: 'BINDING_MISMATCH', ok: false });
  expect(unknown.launcher.stops).toHaveLength(0);
});

// ---------------------------------------------------------------------------
// Receipts and input validation
// ---------------------------------------------------------------------------

test('receipts are plain JSON that recovery can read without any adapter', async () => {
  const h = harness();
  const started = await begin(h);
  expect(
    await h.worker.getReceipt({ attemptId: 'attempt-1', runId: 'run-1' })
  ).toMatchObject({
    code: 'ATTEMPT_NOT_TERMINAL',
    ok: false,
    status: 'running',
  });
  expect(
    await h.worker.getReceipt({ attemptId: 'attempt-9', runId: 'run-1' })
  ).toMatchObject({ code: 'ATTEMPT_NOT_FOUND' });
  expect(
    await h.worker.getReceipt({ attemptId: '', runId: 'run-1' })
  ).toMatchObject({ code: 'ID_INVALID' });
  const exited = await h.worker.observeExit({
    ...refOf(started),
    exit: { code: 0, signal: null },
  });
  const read = await h.makeWorker().getReceipt({
    attemptId: 'attempt-1',
    runId: 'run-1',
  });
  expect(read.receipt).toEqual(exited.receipt);
  expect(JSON.parse(JSON.stringify(read.receipt))).toEqual(read.receipt);
});

test('malicious start input is refused with fixed text before any write or launch', async () => {
  const getterTrap = { ...startInput() };
  Object.defineProperty(getterTrap, 'runId', {
    enumerable: true,
    get() {
      throw new Error(`boom ${SEED}`);
    },
  });
  const inputs = [
    [undefined, 'ID_INVALID'],
    [null, 'ID_INVALID'],
    ['run-1', 'ID_INVALID'],
    [[], 'ID_INVALID'],
    [startInput(1, { runId: '' }), 'ID_INVALID'],
    [startInput(1, { runId: 'run\n1' }), 'ID_INVALID'],
    [startInput(1, { runId: ' run-1' }), 'ID_INVALID'],
    [startInput(1, { spanId: 'x'.repeat(257) }), 'ID_INVALID'],
    [startInput(1, { attemptId: '__proto__' }), 'ID_INVALID'],
    [startInput(1, { actionId: 7 }), 'ID_INVALID'],
    [startInput(1, { actionId: SEED }), 'SENSITIVE_VALUE'],
    [startInput(1, { attemptId: 'token' }), 'SENSITIVE_VALUE'],
    [startInput(1, { attemptId: 'password' }), 'SENSITIVE_VALUE'],
    [startInput(1, { generation: -1 }), 'GENERATION_INVALID'],
    [startInput(1, { generation: 1.5 }), 'GENERATION_INVALID'],
    [startInput(1, { generation: Number.NaN }), 'GENERATION_INVALID'],
    [startInput(1, { generation: '1' }), 'GENERATION_INVALID'],
    [startInput(1, { deadlineMs: 0 }), 'DEADLINE_INVALID'],
    [startInput(1, { deadlineMs: -5 }), 'DEADLINE_INVALID'],
    [startInput(1, { deadlineMs: 1.5 }), 'DEADLINE_INVALID'],
    [startInput(1, { deadlineMs: '5000' }), 'DEADLINE_INVALID'],
    [
      startInput(1, { deadlineMs: Number.POSITIVE_INFINITY }),
      'DEADLINE_INVALID',
    ],
    [getterTrap, 'WORKER_FAILED'],
  ];
  for (const [input, code] of inputs) {
    const h = harness();
    const result =
      // biome-ignore lint/performance/noAwaitInLoops: Each malicious input is tested with a fresh worker and no launch.
      await h.worker.start(input);
    expect(result).toMatchObject({ code, ok: false });
    expect(typeof result.error).toBe('string');
    expect(JSON.stringify(result)).not.toContain(SEED);
    expect(h.launcher.calls).toHaveLength(0);
    expect(h.store.commitCount).toBe(0);
  }
});

test('malformed callbacks are refused without changing the attempt', async () => {
  const h = harness();
  const started = await begin(h);
  const ref = refOf(started);
  const commits = h.store.commitCount;
  const chunks = [
    { seq: 0, text: '' },
    { seq: 0, text: 42 },
    { seq: 0, text: null },
    { seq: -1, text: 'x' },
    { seq: 1.5, text: 'x' },
    { seq: Number.NaN, text: 'x' },
    { seq: '0', text: 'x' },
  ];
  for (const chunk of chunks) {
    expect(
      // biome-ignore lint/performance/noAwaitInLoops: Each malformed chunk is checked before the unchanged-state assertions.
      await h.worker.captureChunk({ ...ref, ...chunk })
    ).toMatchObject({
      code: 'CHUNK_INVALID',
      ok: false,
    });
  }
  const exits = [
    {},
    null,
    { code: '0' },
    { code: 1.5 },
    { code: 1e12 },
    { signal: 'sigterm' },
    { signal: 7 },
    { code: null, signal: null },
  ];
  for (const exit of exits) {
    expect(
      // biome-ignore lint/performance/noAwaitInLoops: Each malformed exit is checked before the unchanged-state assertions.
      await h.worker.observeExit({ ...ref, exit })
    ).toMatchObject({
      code: 'EXIT_INVALID',
      ok: false,
    });
  }
  expect(
    await h.worker.captureChunk({ ...ref, processStartId: undefined, seq: 0 })
  ).toMatchObject({ code: 'ID_INVALID' });
  expect(await h.worker.captureChunk(null)).toMatchObject({ ok: false });
  expect(
    await h.worker.recover({ ...bindingInput(), coordinatorGeneration: -1 })
  ).toMatchObject({ code: 'GENERATION_INVALID' });
  expect(h.spool.appends).toBe(0);
  expect(h.store.commitCount).toBe(commits);
  expect(h.store.attempt().status).toBe('running');
  expect(
    await h.worker.captureChunk({ ...ref, seq: 0, text: 'fine' })
  ).toMatchObject({ ok: true });
});

test('an unreadable or malformed run view is refused with fixed text', async () => {
  const h = harness();
  h.store.readRun = () => {
    throw new Error('read detail /private/path');
  };
  const unreadable = await h.worker.start(startInput());
  expect(unreadable).toMatchObject({ code: 'RUN_READ_FAILED', ok: false });
  expect(JSON.stringify(unreadable)).not.toContain('/private/path');

  const bad = harness();
  bad.store.readRun = () => ({
    generation: 1,
    ok: true,
    revision: 1,
    view: { runId: 'run-1' },
  });
  expect(await bad.worker.start(startInput())).toMatchObject({
    code: 'RUN_VIEW_INVALID',
  });
  const wrongAttempts = harness();
  const real = wrongAttempts.store.readRun;
  wrongAttempts.store.readRun = (request) => {
    const read = real(request);
    return { ...read, view: { ...read.view, attempts: [] } };
  };
  expect(await wrongAttempts.worker.start(startInput())).toMatchObject({
    code: 'RUN_VIEW_INVALID',
  });
  expect(wrongAttempts.launcher.calls).toHaveLength(0);
});

// ---------------------------------------------------------------------------
// Real event/model store
// ---------------------------------------------------------------------------

function openReal(root) {
  const store = openSpansStore({ root });
  stores.push(store);
  return store;
}

test('the real event and model store carries the full lifecycle and survives reopen', async () => {
  const root = mkdtempSync(join(tmpdir(), 'spans-worker-'));
  roots.push(root);
  const store = openReal(root);
  expect(
    store.commitRun({
      events: [],
      expectedGeneration: 0,
      expectedRevision: 0,
      runId: 'run-1',
      view: initialView(0),
    }).ok
  ).toBe(true);

  const h = harness({ store });
  h.launcher.behavior = async () => ({
    ok: true,
    processStart: { id: 'proc-1', pid: 4242 },
  });
  const started = await h.worker.start(startInput(1, { generation: 0 }));
  expect(started).toMatchObject({ ok: true, status: 'running' });
  await h.launcher.sink.chunk(`log ${SEED}`);
  expect(await h.launcher.sink.native('native-real')).toMatchObject({
    ok: true,
  });
  const exited = await h.launcher.sink.exit({ code: 0, signal: null });
  expect(exited).toMatchObject({ ok: true, status: 'exited' });

  const run = store.readRun({ runId: 'run-1' });
  expect(run.view.attempts['attempt-1']).toMatchObject({
    nativeId: 'native-real',
    status: 'exited',
  });
  expect(run.view.actions['action-1'].state).toBe('intent');
  const { events } = store.readEvents({ runId: 'run-1' });
  expect(events.map((event) => event.type)).toEqual([
    TYPES.intent,
    TYPES.launched,
    TYPES.native,
    TYPES.finalizing,
    TYPES.exited,
  ]);
  expect(JSON.stringify([run, events, h.spool.chunks])).not.toContain(SEED);

  // A second attempt crashes mid-run; a reopened store recovers it as held.
  const second = await h.worker.start(startInput(2, { generation: 0 }));
  expect(second.ok).toBe(true);
  await h.launcher.sink.chunk('partial\n');
  store.close();

  const reopened = openReal(root);
  const successor = createSpansWorker({ ...h.options, store: reopened });
  const recovered = await successor.recover(bindingInput(2, { generation: 0 }));
  expect(recovered).toMatchObject({ held: true, ok: true });
  expect(recovered.receipt).toMatchObject({
    reason: 'worker-lost',
    status: 'held',
  });
  expect(recovered.receipt.capture.chunks).toBe(1);
  expect(
    reopened.readRun({ runId: 'run-1' }).view.attempts['attempt-2'].status
  ).toBe('held');
});

test('the real store fences a stale generation and the attempt stays unresolved', async () => {
  const root = mkdtempSync(join(tmpdir(), 'spans-worker-'));
  roots.push(root);
  const store = openReal(root);
  store.commitRun({
    events: [],
    expectedGeneration: 0,
    expectedRevision: 0,
    runId: 'run-1',
    view: initialView(0),
  });
  const h = harness({ store });
  const started = await h.worker.start(startInput(1, { generation: 0 }));
  expect(started.ok).toBe(true);

  const read = store.readRun({ runId: 'run-1' });
  expect(
    store.commitRun({
      events: [],
      expectedGeneration: 0,
      expectedRevision: read.revision,
      runId: 'run-1',
      view: { ...read.view, generation: 1 },
    }).ok
  ).toBe(true);

  const exited = await h.worker.observeExit({
    ...refOf(started),
    exit: { code: 0, signal: null },
  });
  expect(exited).toMatchObject({
    cause: 'STALE_GENERATION',
    code: 'FINALIZE_UNCONFIRMED',
    ok: false,
  });
  expect(
    store.readRun({ runId: 'run-1' }).view.attempts['attempt-1']
  ).toMatchObject({ status: 'running' });
});

// ---------------------------------------------------------------------------
// Callbacks awaited by the launcher before it returns
// ---------------------------------------------------------------------------

const ACCEPTED = { accepted: true, ok: true, pending: true };
// An early native ID is answered only once it is durable, not as a queued ack.
const NATIVE_RECORDED = {
  duplicate: false,
  nativeId: 'native-early',
  ok: true,
};
const processStart = { id: 'proc-1', pid: 1 };

test('a launcher that awaits the sink before returning is not deadlocked and nothing is lost', async () => {
  const h = harness();
  const acks = [];
  h.launcher.behavior = async (request) => {
    acks.push(await request.sink.native('native-early'));
    acks.push(await request.sink.chunk('first\n'));
    acks.push(await request.sink.chunk('second\n'));
    // Chunks are acknowledged only: nothing is spooled while the launch is
    // unrecorded. The native ID is already durable on the launching record.
    expect(h.spool.chunks).toHaveLength(0);
    expect(h.store.attempt()).toMatchObject({
      nativeId: 'native-early',
      status: 'launching',
    });
    return { ok: true, processStart };
  };
  const result = await settled(h.worker.start(startInput()));
  expect(result).toMatchObject({ ok: true, status: 'running' });
  expect(acks).toEqual([NATIVE_RECORDED, ACCEPTED, ACCEPTED]);

  await until(
    () =>
      h.spool.chunks.length === 2 &&
      h.worker.inspect().queuedBytes === 0 &&
      h.store.attempt().nativeId === 'native-early'
  );
  expect(h.spool.texts()).toEqual(['first\n', 'second\n']);
  expect(h.store.attempt()).toMatchObject({
    nativeId: 'native-early',
    status: 'running',
  });
  expect(h.store.events.map((event) => event.type)).toEqual([
    TYPES.intent,
    TYPES.native,
    TYPES.launched,
  ]);
});

test('an exit awaited during the launch is finalized after the launch is recorded', async () => {
  const h = harness();
  const acks = [];
  h.launcher.behavior = async (request) => {
    acks.push(await request.sink.native('native-early'));
    acks.push(await request.sink.chunk('hello\n'));
    acks.push(await request.sink.chunk('tail without end'));
    acks.push(await request.sink.exit({ code: 0, signal: null }));
    acks.push(await request.sink.exit({ code: 0, signal: null }));
    acks.push(await request.sink.exit({ code: 1, signal: null }));
    acks.push(await request.sink.chunk('after the exit\n'));
    return { ok: true, processStart };
  };
  const result = await settled(h.worker.start(startInput()));
  expect(result).toMatchObject({ ok: true, status: 'running' });
  expect(acks[0]).toEqual(NATIVE_RECORDED);
  expect(acks.slice(1, 5)).toEqual(new Array(4).fill(ACCEPTED));
  expect(acks[5]).toMatchObject({ code: 'EXIT_CONFLICT', ok: false });
  expect(acks[6]).toMatchObject({ code: 'ATTEMPT_CLOSED', ok: false });

  await until(() => h.store.attempt().status === 'exited');
  const record = h.store.attempt();
  expect(record).toMatchObject({
    exit: { code: 0, signal: null },
    nativeId: 'native-early',
    status: 'exited',
  });
  expect(record.capture).toMatchObject({
    chunks: 2,
    complete: true,
    gap: null,
  });
  expect(h.spool.texts()).toEqual(['hello\n', 'tail without end']);
  expect(h.store.events.map((event) => event.type)).toEqual([
    TYPES.intent,
    TYPES.native,
    TYPES.launched,
    TYPES.finalizing,
    TYPES.exited,
  ]);
  expectInert(record.receipt);
  expect(h.worker.inspect()).toMatchObject({
    activeAttempts: 0,
    queuedBytes: 0,
  });
});

test('callbacks accepted before a launch that ends unrecorded keep the native ID and name what was not stored', async () => {
  const endings = [
    async () => ({ code: 'NO_SLOT', launched: false, ok: false }),
    () => Promise.reject(new Error('adapter detail')),
    async () => null,
  ];
  for (const ending of endings) {
    const h = harness();
    const acks = [];
    h.launcher.behavior = async (request) => {
      acks.push(await request.sink.native('native-early'));
      acks.push(await request.sink.chunk('early\n'));
      acks.push(await request.sink.exit({ code: 0, signal: null }));
      return ending();
    };
    const result =
      // biome-ignore lint/performance/noAwaitInLoops: Each launch ending uses a fresh worker and is fully checked before the next.
      await settled(h.worker.start(startInput()));
    // Even an explicit refusal is unknown once the provider reported activity.
    expect(result).toMatchObject({
      code: 'LAUNCH_UNKNOWN',
      held: true,
      ok: false,
      unknown: true,
    });
    expect(acks).toEqual([NATIVE_RECORDED, ACCEPTED, ACCEPTED]);
    expect(result.receipt).toMatchObject({
      nativeId: 'native-early',
      outcome: 'unknown',
      retryEligible: false,
      status: 'held',
    });
    expect(result.receipt.capture.gap).toMatchObject({
      reason: 'launch-unknown',
      unpersistedBytes: 6,
      unpersistedChunks: 1,
    });
    await flush();
    await flush();
    expect(h.spool.chunks).toHaveLength(0);
    expect(h.spool.finalized).toHaveLength(0);
    expect(h.store.attempt()).toMatchObject({
      nativeId: 'native-early',
      status: 'held',
    });
    expect(h.launcher.stops).toHaveLength(0);
    expect(h.worker.inspect()).toMatchObject({
      activeAttempts: 0,
      queuedBytes: 0,
    });
  }
});

test('an ID observed during a launch whose record is not confirmed is carried by the hold', async () => {
  const h = harness();
  h.launcher.behavior = async (request) => {
    await request.sink.native('native-early');
    return { ok: true, processStart };
  };
  h.store.fault = (request) =>
    request.events.some((event) => event.type === TYPES.launched)
      ? 'refuse'
      : undefined;
  const result = await settled(h.worker.start(startInput()));
  expect(result).toMatchObject({
    code: 'LAUNCH_RECORD_UNCONFIRMED',
    held: true,
    ok: false,
  });
  expect(h.store.attempt()).toMatchObject({
    nativeId: 'native-early',
    processStart,
    status: 'held',
  });
});

test('a full queue before the launch is recorded refuses at once and retryably', async () => {
  const h = harness();
  const texts = ['0', '1', '2'].map((digit) => `${digit.repeat(99)}\n`);
  const acks = [];
  h.launcher.behavior = async (request) => {
    for (const text of texts) {
      const ack =
        // biome-ignore lint/performance/noAwaitInLoops: The sink contract requires each chunk result before sending the next chunk.
        await request.sink.chunk(text);
      acks.push(ack);
    }
    return { ok: true, processStart };
  };
  expect(await settled(h.worker.start(startInput()))).toMatchObject({
    ok: true,
  });
  expect(acks.map((ack) => ack.ok)).toEqual([true, true, false]);
  expect(acks[2]).toMatchObject({
    code: 'BACKPRESSURE',
    ok: false,
    retryable: true,
  });
  await until(
    () => h.spool.chunks.length === 2 && h.worker.inspect().queuedBytes === 0
  );
  // The refused chunk was not consumed; the sink takes it once the launch is
  // recorded.
  expect(await h.launcher.sink.chunk(texts[2])).toMatchObject({ ok: true });
  expect(h.spool.texts()).toEqual(texts);
});

// ---------------------------------------------------------------------------
// Early native identity is durable before it is acknowledged
// ---------------------------------------------------------------------------

const eventTypes = (h) => h.store.events.map((event) => event.type);
const writesNative = (request) =>
  request.events.some((event) => event.type === TYPES.native);

test('an ID reported through the awaited sink is durable in the real store while the launch never resolves', async () => {
  const root = mkdtempSync(join(tmpdir(), 'spans-worker-'));
  roots.push(root);
  const store = openReal(root);
  expect(
    store.commitRun({
      events: [],
      expectedGeneration: 0,
      expectedRevision: 0,
      runId: 'run-1',
      view: initialView(0),
    }).ok
  ).toBe(true);

  const h = harness({ store });
  const hang = deferred();
  const acks = [];
  h.launcher.behavior = async (request) => {
    acks.push(await request.sink.native('native-hang'));
    await hang.promise;
    return { ok: true, processStart };
  };
  let starting;
  try {
    starting = h.worker.start(startInput(1, { generation: 0 }));
    await until(() => acks.length === 1);
    // The launch is still unresolved: the ID and its event are already stored.
    expect(acks).toEqual([
      { duplicate: false, nativeId: 'native-hang', ok: true },
    ]);
    expect(
      store.readRun({ runId: 'run-1' }).view.attempts['attempt-1']
    ).toMatchObject({ nativeId: 'native-hang', status: 'launching' });
    const { events } = store.readEvents({ runId: 'run-1' });
    expect(events.map((event) => event.type)).toEqual([
      TYPES.intent,
      TYPES.native,
    ]);
    expect(JSON.stringify(events[1])).toContain('native-hang');
  } finally {
    hang.resolve();
  }
  expect(await settled(starting)).toMatchObject({
    nativeId: 'native-hang',
    ok: true,
    status: 'running',
  });
  expect(
    store.readRun({ runId: 'run-1' }).view.attempts['attempt-1']
  ).toMatchObject({ nativeId: 'native-hang', status: 'running' });
});

test('a launch answer without an ID keeps the first durable native ID', async () => {
  await Promise.all(
    [{}, { nativeId: null }].map(async (answer) => {
      const h = harness();
      h.launcher.behavior = async (request) => {
        await request.sink.native('native-early');
        return { ok: true, processStart, ...answer };
      };
      const result = await settled(h.worker.start(startInput()));
      expect(result).toMatchObject({
        nativeId: 'native-early',
        ok: true,
        status: 'running',
      });
      expect(h.store.attempt()).toMatchObject({
        nativeId: 'native-early',
        status: 'running',
      });
      expect(eventTypes(h)).toEqual([
        TYPES.intent,
        TYPES.native,
        TYPES.launched,
      ]);
      const launched = h.store.events.find(
        (event) => event.type === TYPES.launched
      );
      expect(launched.payload.nativeId).toBe('native-early');
      expect(await h.launcher.sink.native('native-early')).toMatchObject({
        duplicate: true,
        ok: true,
      });
      expect(await h.launcher.sink.native('native-other')).toMatchObject({
        code: 'NATIVE_ID_CONFLICT',
        ok: false,
      });
      expect(h.store.attempt().nativeId).toBe('native-early');
    })
  );
});

test('a launch answer that contradicts the first native ID holds the attempt and keeps the first', async () => {
  // The first ID is durable.
  const durable = harness();
  durable.launcher.behavior = async (request) => {
    await request.sink.native('native-first');
    return { nativeId: 'native-other', ok: true, processStart };
  };
  const held = await settled(durable.worker.start(startInput()));
  expect(held).toMatchObject({
    code: 'NATIVE_ID_CONFLICT',
    held: true,
    launched: true,
    ok: false,
    unknown: true,
  });
  expect(durable.store.attempt()).toMatchObject({
    nativeId: 'native-first',
    processStart,
    status: 'held',
  });
  expect(held.receipt).toMatchObject({
    nativeId: 'native-first',
    nativeIdState: 'recorded',
    outcome: 'unknown',
    retryEligible: false,
    status: 'held',
  });
  expect(held.receipt.capture.gap).toMatchObject({
    conflictingNativeId: 'native-other',
    reason: 'native-id-conflict',
  });
  expectInert(held.receipt);
  expect(eventTypes(durable)).toEqual([TYPES.intent, TYPES.native, TYPES.held]);
  expect(durable.launcher.stops).toHaveLength(0);
  expect(durable.worker.inspect()).toMatchObject({
    activeAttempts: 0,
    queuedBytes: 0,
  });

  // The first ID was seen but its write was refused: still a contradiction.
  const unwritten = harness();
  unwritten.store.fault = (request) =>
    writesNative(request) ? 'refuse' : undefined;
  const acks = [];
  unwritten.launcher.behavior = async (request) => {
    acks.push(await request.sink.native('native-first'));
    return { nativeId: 'native-other', ok: true, processStart };
  };
  const heldUnwritten = await settled(unwritten.worker.start(startInput()));
  expect(acks[0]).toMatchObject({ code: 'COMMIT_FAILED', ok: false });
  expect(heldUnwritten).toMatchObject({
    code: 'NATIVE_ID_CONFLICT',
    held: true,
    ok: false,
  });
  expect(unwritten.store.attempt()).toMatchObject({
    nativeId: 'native-first',
    status: 'held',
  });
  expect(heldUnwritten.receipt.capture.gap).toMatchObject({
    conflictingNativeId: 'native-other',
  });
  expect(eventTypes(unwritten)).toEqual([TYPES.intent, TYPES.held]);
});

test('a failed early native write is a fixed refusal, never a durable success, and can be reported again', async () => {
  await Promise.all(
    ['refuse', 'throw'].map(async (fault) => {
      const h = harness();
      h.store.fault = (request) => (writesNative(request) ? fault : undefined);
      const acks = [];
      h.launcher.behavior = async (request) => {
        acks.push(await request.sink.native('native-early'));
        return { ok: true, processStart };
      };
      const result = await settled(h.worker.start(startInput()));
      expect(result).toMatchObject({
        nativeId: null,
        ok: true,
        status: 'running',
      });
      expect(acks).toHaveLength(1);
      expect(acks[0]).toMatchObject({ code: 'COMMIT_FAILED', ok: false });
      expect(acks[0].nativeId).toBeUndefined();
      expect(JSON.stringify(acks)).not.toContain('private');
      expect(h.store.attempt().nativeId).toBeNull();
      expect(eventTypes(h)).toEqual([TYPES.intent, TYPES.launched]);

      h.store.fault = null;
      expect(await h.launcher.sink.native('native-early')).toMatchObject({
        duplicate: false,
        ok: true,
      });
      expect(h.store.attempt().nativeId).toBe('native-early');
    })
  );
});

test('a takeover while the early native write is in flight leaves no old-generation write', async () => {
  const h = harness();
  let taken = false;
  h.store.fault = (request) => {
    if (!taken && writesNative(request)) {
      taken = true;
      h.store.bumpGeneration();
    }
  };
  const acks = [];
  h.launcher.behavior = async (request) => {
    acks.push(await request.sink.native('native-old'));
    return { ok: true, processStart };
  };
  const result = await settled(h.worker.start(startInput()));
  expect(taken).toBe(true);
  expect(acks).toHaveLength(1);
  expect(acks[0]).toMatchObject({ code: 'STALE_GENERATION', ok: false });
  expect(result).toMatchObject({
    code: 'LAUNCH_RECORD_UNCONFIRMED',
    ok: false,
    unknown: true,
  });
  // Only the intent from the original generation exists; the fenced worker
  // wrote neither the ID, the launch, nor a hold.
  expect(eventTypes(h)).toEqual([TYPES.intent]);
  expect(h.store.attempt()).toMatchObject({
    nativeId: null,
    status: 'launching',
  });
  expect(h.store.view.generation).toBe(2);
  expect(h.spool.chunks).toHaveLength(0);
  expect(h.worker.inspect().activeAttempts).toBe(0);
});

test('concurrent early reports of one ID share a single write and a different ID is refused at once', async () => {
  const h = harness();
  let answers = [];
  h.launcher.behavior = async (request) => {
    answers = await Promise.all([
      request.sink.native('native-early'),
      request.sink.native('native-early'),
      request.sink.native('native-other'),
    ]);
    return { ok: true, processStart };
  };
  expect(await settled(h.worker.start(startInput()))).toMatchObject({
    nativeId: 'native-early',
    ok: true,
  });
  expect(answers[0]).toEqual(NATIVE_RECORDED);
  expect(answers[1]).toEqual({ ...NATIVE_RECORDED, duplicate: true });
  expect(answers[2]).toMatchObject({ code: 'NATIVE_ID_CONFLICT', ok: false });
  expect(eventTypes(h).filter((type) => type === TYPES.native)).toHaveLength(1);
  expect(h.store.attempt().nativeId).toBe('native-early');
});

// ---------------------------------------------------------------------------
// Effect-boundary fences
// ---------------------------------------------------------------------------

test('the launcher receives the immutable fence it was called at', async () => {
  const h = harness();
  await begin(h);
  const [call] = h.launcher.calls;
  expect(call.fence).toEqual({
    attemptDigest: call.attemptDigest,
    generation: 1,
  });
  expect(Object.isFrozen(call.fence)).toBe(true);
  expect(call.generation).toBe(1);
});

test('a takeover between the intent and the launch stops before the launcher is called', async () => {
  const cases = [
    [(h) => h.store.bumpGeneration(), 'STALE_GENERATION', 'launching'],
    [
      (h) => h.store.patchAttempt('attempt-1', { status: 'held' }),
      'ATTEMPT_CLOSED',
      'held',
    ],
    [
      (h) => {
        h.store.readFault = true;
      },
      'RUN_READ_FAILED',
      'launching',
    ],
  ];
  for (const [takeover, code, status] of cases) {
    const h = harness();
    h.store.afterCommit = (request) => {
      if (request.events.some((event) => event.type === TYPES.intent)) {
        takeover(h);
      }
    };
    const result =
      // biome-ignore lint/performance/noAwaitInLoops: Each takeover is applied to an independent worker before its launch assertion.
      await h.worker.start(startInput());
    expect(result).toMatchObject({ code, launched: false, ok: false });
    expect(JSON.stringify(result)).not.toContain('/private/path');
    expect(h.launcher.calls).toHaveLength(0);
    expect(h.launcher.stops).toHaveLength(0);
    expect(h.store.attempt().status).toBe(status);
    expect(h.worker.inspect().activeAttempts).toBe(0);
  }
});

test('a generation change while chunks wait stops the stale worker before the spool', async () => {
  const h = harness();
  const started = await begin(h);
  const ref = refOf(started);
  h.spool.gate = deferred();
  const first = h.worker.captureChunk({ ...ref, seq: 0, text: 'one\n' });
  const second = h.worker.captureChunk({ ...ref, seq: 1, text: 'two\n' });
  await flush();
  expect(h.spool.appends).toBe(1);

  h.store.bumpGeneration();
  const { gate } = h.spool;
  h.spool.gate = null;
  gate.resolve();
  // The first append was already past its fence; the queued one is not.
  expect(await first).toMatchObject({ ok: true });
  expect(await second).toMatchObject({ code: 'STALE_GENERATION', ok: false });
  expect(h.spool.appends).toBe(1);
  expect(h.spool.texts()).toEqual(['one\n']);
  expect(h.spool.chunks[0]).toMatchObject({
    binding: {
      actionId: 'action-1',
      attemptId: 'attempt-1',
      generation: 1,
      runId: 'run-1',
      spanId: 'a',
      workerId: 'worker-1',
    },
    generation: 1,
  });
  expect(h.worker.inspect().activeAttempts).toBe(0);
  expect(await h.launcher.sink.chunk('three\n')).toMatchObject({
    code: 'ATTEMPT_CLOSED',
  });
  expect(h.store.attempt().status).toBe('running');
});

test('a record held by its owner while a chunk waits is not written to the spool', async () => {
  const h = harness();
  const started = await begin(h);
  h.store.patchAttempt('attempt-1', { status: 'held' });
  expect(
    await h.worker.captureChunk({ ...refOf(started), seq: 0, text: 'late\n' })
  ).toMatchObject({ code: 'ATTEMPT_CLOSED', ok: false });
  expect(h.spool.appends).toBe(0);
  expect(h.worker.inspect().activeAttempts).toBe(0);
});

test('an unreadable store before an append writes nothing and can be retried', async () => {
  const h = harness();
  const started = await begin(h);
  const ref = refOf(started);
  h.store.readFault = true;
  expect(
    await h.worker.captureChunk({ ...ref, seq: 0, text: 'again\n' })
  ).toMatchObject({ code: 'BACKPRESSURE', ok: false, retryable: true });
  expect(h.spool.appends).toBe(0);
  h.store.readFault = false;
  expect(
    await h.worker.captureChunk({ ...ref, seq: 0, text: 'again\n' })
  ).toMatchObject({ duplicate: false, ok: true });
  expect(h.spool.texts()).toEqual(['again\n']);
});

test('a takeover after the finalizing write stops the flush before the spool', async () => {
  for (const tail of ['', 'tail']) {
    const h = harness();
    const started =
      // biome-ignore lint/performance/noAwaitInLoops: Each tail case has independent durable state and ordered exit handling.
      await begin(h);
    await h.worker.captureChunk({ ...refOf(started), seq: 0, text: 'data\n' });
    if (tail) {
      await h.worker.captureChunk({ ...refOf(started), seq: 1, text: tail });
    }
    h.store.afterCommit = (request) => {
      if (request.events.some((event) => event.type === TYPES.finalizing)) {
        h.store.bumpGeneration();
      }
    };
    const exited = await h.worker.observeExit({
      ...refOf(started),
      exit: { code: 0, signal: null },
    });
    expect(exited).toMatchObject({
      cause: 'STALE_GENERATION',
      code: 'FINALIZE_UNCONFIRMED',
      ok: false,
      unknown: true,
    });
    expect(h.spool.texts()).toEqual(['data\n']);
    expect(h.spool.finalized).toHaveLength(0);
    expect(h.store.attempt().status).toBe('finalizing');
    expect(h.worker.inspect().activeAttempts).toBe(0);

    const recovered = await h
      .makeWorker()
      .recover({ ...bindingInput(), coordinatorGeneration: 2 });
    expect(recovered.receipt).toMatchObject({
      reason: 'finalize-interrupted',
      recoveredAtGeneration: 2,
    });
  }
});

// ---------------------------------------------------------------------------
// Record framing: nothing raw is persisted, nothing is truncated as complete
// ---------------------------------------------------------------------------

const WIDE = { maxAttemptBytes: 4000, maxChunkBytes: 400, maxQueueBytes: 1000 };

async function feed(h, started, texts) {
  const results = [];
  for (const [seq, text] of texts.entries()) {
    const result =
      // biome-ignore lint/performance/noAwaitInLoops: Caller chunks must be fed in sequence so framing and retry state remain deterministic.
      await h.worker.captureChunk({ ...refOf(started), seq, text });
    results.push(result);
  }
  return results;
}

test('a secret split across chunks is never stored raw, not even as a fragment', async () => {
  const cases = [
    [
      ['key sk-', 'proj-ABCDEFGHIJKLMNOPQRST done\n'],
      'key [REDACTED] done\n',
      ['sk-', 'ABCDEF'],
    ],
    [
      ['Authorization: Bear', 'er abcdefghijklmnop\n'],
      'Authorization: [REDACTED]\n',
      ['Bear', 'abcdef'],
    ],
    [
      ['Authorization: Bearer\n', 'abcdefghijklmnop\n'],
      'Authorization: [REDACTED]\n',
      ['abcdef'],
    ],
    [
      ['pass', 'word=hunter2hunter2\n'],
      'password=[REDACTED]\n',
      ['hunter2', 'pass\n'],
    ],
    [
      ['password:\n', 'hunter2hunter2\n'],
      'password:\n[REDACTED]\n',
      ['hunter2'],
    ],
    [['api_key="abc def', ' ghi"\n'], 'api_key="[REDACTED]"\n', ['abc', 'ghi']],
    [['api_key="abc\n', 'def"\n'], 'api_key="[REDACTED]"\n', ['abc', 'def']],
  ];
  for (const [texts, stored, fragments] of cases) {
    const h = harness({ limits: WIDE });
    const started =
      // biome-ignore lint/performance/noAwaitInLoops: Each redaction case uses an isolated worker and ordered source chunks.
      await begin(h);
    const results = await feed(h, started, texts);
    // The first chunk ends inside the secret: held in memory, not stored.
    expect(results[0].pendingBytes).toBeGreaterThan(0);
    expect(h.spool.chunks).toHaveLength(1);
    expect(h.spool.texts()).toEqual([stored]);
    for (const chunk of h.spool.chunks) {
      for (const fragment of fragments) {
        expect(chunk.text).not.toContain(fragment);
      }
    }
  }
});

test('a private key block split across chunks is stored only as a redaction', async () => {
  const h = harness({ limits: WIDE });
  const started = await begin(h);
  await feed(h, started, [
    'before\n-----BEGIN PRIV',
    'ATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0B\n',
    'KcwggSjAgEAAoIBAQC7zzzz\n-----END PRIVATE',
  ]);
  // Only the text before the block is stored while the block is open.
  expect(h.spool.texts()).toEqual(['before\n']);
  await h.worker.captureChunk({
    ...refOf(started),
    seq: 3,
    text: ' KEY-----\nafter\n',
  });
  expect(h.spool.texts()).toEqual(['before\n', '[REDACTED]\nafter\n']);
  const stored = h.spool.texts().join('');
  for (const fragment of ['MIIEvQ', 'Kcwgg', 'BEGIN', 'PRIVATE']) {
    expect(stored).not.toContain(fragment);
  }
});

test('multibyte text is never cut: surrogate halves rejoin and splits fall on code points', async () => {
  const h = harness();
  const started = await begin(h);
  const results = await feed(h, started, ['\uD83D', '\uDE00 ok\n']);
  expect(results[0]).toMatchObject({ ok: true, pendingBytes: 3 });
  expect(h.spool.texts()).toEqual(['😀 ok\n']);
  expect(h.spool.chunks[0].bytes).toBe(Buffer.byteLength('😀 ok\n', 'utf8'));

  // Redaction grows the line past the chunk limit: it is split into records
  // that each fit and no character is cut.
  const wide = harness();
  const wideStarted = await begin(wide);
  const line = `${'€Bearer a '.repeat(8)}\n`;
  expect(Buffer.byteLength(line, 'utf8')).toBeLessThanOrEqual(100);
  await feed(wide, wideStarted, [line]);
  const expected = `${'€Bearer [REDACTED] '.repeat(8)}\n`;
  expect(wide.spool.chunks.length).toBeGreaterThan(1);
  expect(wide.spool.chunks.every((chunk) => chunk.bytes <= 100)).toBe(true);
  expect(wide.spool.texts().join('')).toBe(expected);
  expect(wide.spool.texts().join('')).not.toContain('�');
});

test('an overlong or unterminated record holds the attempt and is never truncated or stored', async () => {
  const h = harness();
  const started = await begin(h);
  const ref = refOf(started);
  expect(
    await h.worker.captureChunk({ ...ref, seq: 0, text: 'x'.repeat(100) })
  ).toMatchObject({ ok: true, pendingBytes: 100 });
  expect(
    await h.worker.captureChunk({ ...ref, seq: 1, text: 'y' })
  ).toMatchObject({ code: 'RECORD_TOO_LONG', held: true, ok: false });
  expect(h.spool.chunks).toHaveLength(0);
  const record = h.store.attempt();
  expect(record.status).toBe('held');
  expect(record.capture).toMatchObject({
    chunks: 0,
    complete: false,
    gap: { fromSeq: 0, pendingBytes: 101, reason: 'record-too-long' },
  });
  expect(JSON.stringify([h.store.view, h.store.events])).not.toContain(
    'xxxxxx'
  );
  expect(h.launcher.stops).toHaveLength(0);

  // A key block that does not end within the bound is not stored either.
  const block = harness();
  const blockStarted = await begin(block);
  const results = await feed(block, blockStarted, [
    '-----BEGIN PRIVATE KEY-----\n',
    `${'A'.repeat(60)}\n`,
    `${'B'.repeat(40)}\n`,
  ]);
  expect(results[2]).toMatchObject({ code: 'RECORD_TOO_LONG', held: true });
  expect(block.spool.chunks).toHaveLength(0);
  expect(JSON.stringify([block.store.view, block.store.events])).not.toContain(
    'AAAAAAAA'
  );
  expect(block.store.attempt().capture.gap).toMatchObject({
    reason: 'record-too-long',
  });
});

test('at the exit the unfinished last line is stored redacted and an unterminated key block is withheld', async () => {
  const h = harness();
  const started = await begin(h);
  await feed(h, started, ['done\n', 'password=hunter2hunter2']);
  expect(h.spool.texts()).toEqual(['done\n']);
  const exited = await h.worker.observeExit({
    ...refOf(started),
    exit: { code: 0, signal: null },
  });
  expect(h.spool.texts()).toEqual(['done\n', 'password=[REDACTED]']);
  expect(exited.receipt.capture).toMatchObject({
    chunks: 2,
    complete: true,
    gap: null,
  });

  const open = harness();
  const openStarted = await begin(open);
  const unfinished = '-----BEGIN PRIVATE KEY-----\nMIIEvQ';
  await feed(open, openStarted, ['ok\n', unfinished]);
  const closed = await open.worker.observeExit({
    ...refOf(openStarted),
    exit: { code: 0, signal: null },
  });
  expect(closed).toMatchObject({ ok: true, status: 'exited' });
  expect(open.spool.texts()).toEqual(['ok\n']);
  expect(open.spool.finalized[0]).toMatchObject({ complete: false });
  // The process exit is real, but the capture is not complete and says why.
  expect(closed.receipt).toMatchObject({ outcome: 'process-exited' });
  expect(closed.receipt.capture).toMatchObject({
    chunks: 1,
    complete: false,
    gap: {
      fromSeq: 1,
      pendingBytes: Buffer.byteLength(unfinished, 'utf8'),
      reason: 'unterminated-record',
    },
  });
  expect(JSON.stringify([open.store.view, open.spool.finalized])).not.toContain(
    'MIIEvQ'
  );
});

test('a hold names the raw text that was never stored and does not stop the process', async () => {
  const h = harness();
  const started = await begin(h);
  await feed(h, started, ['complete\n', 'half line']);
  h.clock.time = 6000;
  const expired = await h.worker.enforceDeadline(refOf(started));
  expect(expired).toMatchObject({ expired: true, held: true, ok: true });
  expect(expired.receipt.capture).toMatchObject({
    chunks: 1,
    complete: false,
    gap: { fromSeq: 1, pendingBytes: 9, reason: 'deadline' },
  });
  expect(h.spool.texts()).toEqual(['complete\n']);
  expect(JSON.stringify(h.store.view)).not.toContain('half line');
  expect(h.launcher.stops).toHaveLength(0);
});

test('a retried half of a split secret is a duplicate and is not stored twice', async () => {
  const h = harness({ limits: WIDE });
  const started = await begin(h);
  const ref = refOf(started);
  const half = { ...ref, seq: 0, text: 'Authorization: Bear' };
  expect(await h.worker.captureChunk(half)).toMatchObject({
    duplicate: false,
    ok: true,
    pendingBytes: 19,
  });
  expect(await h.worker.captureChunk(half)).toMatchObject({
    duplicate: true,
    ok: true,
    seq: 0,
  });
  expect(
    await h.worker.captureChunk({ ...half, text: 'Authorization: Other' })
  ).toMatchObject({ code: 'CHUNK_CONFLICT', ok: false });
  const rest = { ...ref, seq: 1, text: 'er abcdefghijklmnop\n' };
  expect(await h.worker.captureChunk(rest)).toMatchObject({
    duplicate: false,
    ok: true,
    pendingBytes: 0,
  });
  expect(await h.worker.captureChunk(rest)).toMatchObject({ duplicate: true });
  expect(h.spool.texts()).toEqual(['Authorization: [REDACTED]\n']);
});

test('a retryable spool answer in the middle of one chunk resumes at the same records', async () => {
  const h = harness();
  const started = await begin(h);
  const ref = refOf(started);
  // 100 raw bytes that redact to 199: two records.
  const line = `${'Bearer a '.repeat(11)}\n`;
  h.spool.appendFault = (_payload, count) =>
    count === 2 ? 'retry' : undefined;
  expect(
    await h.worker.captureChunk({ ...ref, seq: 0, text: line })
  ).toMatchObject({ code: 'BACKPRESSURE', ok: false, retryable: true });
  expect(h.spool.chunks).toHaveLength(1);
  expect(h.store.attempt().status).toBe('running');

  expect(
    await h.worker.captureChunk({ ...ref, seq: 0, text: line })
  ).toMatchObject({ duplicate: false, ok: true, seq: 0 });
  expect(h.spool.chunks.map((chunk) => chunk.seq)).toEqual([0, 1]);
  expect(h.spool.texts().join('')).toBe(`${'Bearer [REDACTED] '.repeat(11)}\n`);
  // The first record was not written twice.
  expect(h.spool.appends).toBe(3);
});
