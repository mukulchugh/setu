import { afterEach, expect, test } from 'bun:test';
import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createResourceAdmission,
  SPANS_ARCHIVE_BUDGET_BYTES,
} from './resource-admission.js';
import { createSpansActions } from './spans-actions.js';
import {
  spansExecutionArchiveReservation,
  spansExecutionArchiveWriteBytes,
  spansExecutionArchiveWriteContext,
} from './spans-execution-archive-policy.js';
import { openSpansStore, SPANS_STORE_LIMITS } from './spans-store.js';
import { createSpansWorker, SPANS_WORKER_EVENT_TYPES } from './spans-worker.js';
import { createWorkspaceState } from './workspace-state.js';

const MiB = 1024 ** 2;
const roots = [];
const stores = [];
const workerLimits = Object.freeze({
  maxActiveAttempts: 2,
  maxAttemptBytes: 4 * MiB,
  maxAttemptChunks: 65_536,
  maxChunkBytes: 64 * 1024,
  maxDeadlineMs: 60 * 60 * 1000,
  maxQueueBytes: MiB,
});
const smallWorkerLimits = Object.freeze({
  maxActiveAttempts: 2,
  maxAttemptBytes: 8,
  maxAttemptChunks: 4,
  maxChunkBytes: 8,
  maxDeadlineMs: 10_000,
  maxQueueBytes: 16,
});

test('the capture note keeps its own allocation before the remaining completion writes', () => {
  const attemptId = 'attempt-final';
  const actionId = 'action-final';
  const view = {
    actions: { [actionId]: { state: 'intent' } },
    attempts: {
      [attemptId]: {
        attemptId,
        cancel: { state: 'requested' },
        capture: { artifactId: `sha256:${'a'.repeat(64)}`, complete: true },
        status: 'exited',
      },
    },
  };
  const payload = { actionId, attemptId, complete: true };
  const capture = spansExecutionArchiveWriteBytes({
    limits: workerLimits,
    method: 'appendEvent',
    payload: { payload, type: 'spans.execution.captured', view },
  });
  const next = structuredClone(view);
  next.completions = { [actionId]: {} };
  const completion = spansExecutionArchiveWriteBytes({
    limits: workerLimits,
    method: 'commitRun',
    payload: {
      events: [{ payload, type: 'spans.execution.completion' }],
      view: next,
    },
  });
  expect(capture).toBeGreaterThan(completion);
});

test('parent reports and recovery notes preserve the remaining active capture terminal path', () => {
  const payload = { actionId: 'action-active', attemptId: 'attempt-active' };
  const view = {
    actions: { 'action-active': { state: 'intent' } },
    attempts: {
      'attempt-active': { attemptId: 'attempt-active', status: 'running' },
    },
  };
  const allocation = spansExecutionArchiveWriteBytes({
    limits: workerLimits,
    method: 'appendEvent',
    payload: { payload, type: 'spans.execution.reported', view },
  });
  const finalization = spansExecutionArchiveWriteBytes({
    limits: workerLimits,
    method: 'finalize',
  });
  expect(allocation).toBeGreaterThan(finalization);
});

test('write context reads the exact stored capture reference and ignores asserted history', () => {
  const eventId = `spans.execution.captured:${createHash('sha256')
    .update(JSON.stringify(['run-context', 'attempt-context']))
    .digest('hex')}`;
  const event = {
    eventId,
    payload: { actionId: 'action-context', attemptId: 'attempt-context' },
    runId: 'run-context',
    type: 'spans.execution.captured',
  };
  let lookups = 0;
  const store = {
    getEventById(query) {
      lookups += 1;
      expect(query).toEqual({ eventId });
      return { event, found: true, ok: true };
    },
    readRun: () => ({ ok: true, view: { checkpoint: 1 } }),
  };
  const context = spansExecutionArchiveWriteContext(store, 'appendEvent', {
    ...event,
    history: [{ type: 'untrusted-history' }],
  });
  expect(context.history).toEqual([event]);
  expect(context.view).toEqual({ checkpoint: 1 });
  expect(lookups).toBe(1);
  store.getEventById = () => ({
    event: { ...event, runId: 'other-run' },
    found: true,
    ok: true,
  });
  expect(
    spansExecutionArchiveWriteContext(store, 'appendEvent', event)
  ).toBeNull();
});

afterEach(() => {
  for (const store of stores.splice(0)) {
    store.close();
  }
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { force: true, recursive: true });
  }
});

function fixture() {
  const workspace = fs.mkdtempSync(
    join(tmpdir(), 'setu-spans-archive-policy-')
  );
  roots.push(workspace);
  const archiveRoot = join(workspace, 'archive-capacity');
  const state = createWorkspaceState({
    configPath: join(workspace, 'config.json'),
    setuDir: workspace,
    workspaceRoot: workspace,
  });
  let measuredBytes = 0;
  const archiveCapacity = async ({ root, budgetBytes }) => ({
    ok: root === archiveRoot && budgetBytes === SPANS_ARCHIVE_BUDGET_BYTES,
    state: 'known',
    totalBytes: measuredBytes,
  });
  const admission = createResourceAdmission({
    archiveCapacity,
    hostHealth: async () => ({
      availableBytes: 40 * SPANS_ARCHIVE_BUDGET_BYTES,
      state: 'ready',
    }),
    limits: { lowStorageFloorBytes: 0, maxManagedSessions: 8 },
    now: () => 100,
    observeProcess: async (pid) => ({
      processId: pid,
      processStartIdentity: `fixture-${pid}`,
      state: 'alive',
    }),
    state,
  });
  return {
    admission,
    archiveRoot,
    get measuredBytes() {
      return measuredBytes;
    },
    set measuredBytes(value) {
      measuredBytes = value;
    },
    state,
    workspace,
  };
}

function bindingFor(number) {
  return Object.freeze({
    actionId: `action-${number}`,
    attemptId: `attempt-${number}`,
    generation: 1,
    runId: `run-${number}`,
    spanId: `span-${number}`,
    target: Object.freeze({ name: `feature-${number}`, repo: 'setu' }),
  });
}

function archiveRequest(reservation, number) {
  const binding = bindingFor(number);
  return {
    kind: 'headless-run',
    operationId: `capture-${number}`,
    spansArchiveReservation: reservation,
    spansBinding: binding,
    target: binding.target,
  };
}

async function admitLease(f, reservation, number) {
  const admitted = await f.admission.admit(archiveRequest(reservation, number));
  expect(admitted.ok).toBe(true);
  return admitted.lease;
}

function initialView(binding) {
  return {
    actions: {
      [binding.actionId]: {
        actionId: binding.actionId,
        attemptId: binding.attemptId,
        inputDigest: 'a'.repeat(64),
        outcomeArtifactIds: [],
        planVersion: 1,
        spanId: binding.spanId,
        state: 'intent',
        targetDigest: 'b'.repeat(64),
      },
    },
    checkpoint: 0,
    generation: binding.generation,
    planVersion: 1,
    runId: binding.runId,
    spans: {
      [binding.spanId]: {
        dependencies: [],
        spanId: binding.spanId,
        state: 'ready',
      },
    },
  };
}

function seedRun(store, binding) {
  const result = store.commitRun({
    events: [],
    expectedGeneration: 0,
    expectedRevision: 0,
    runId: binding.runId,
    view: initialView(binding),
  });
  expect(result.ok).toBe(true);
}

function logicalBytes(value) {
  return Buffer.byteLength(JSON.stringify(value));
}

function eventHistory(store, runId) {
  const events = [];
  let afterSequence = 0;
  for (;;) {
    const page = store.readEvents({
      afterSequence,
      limit: SPANS_STORE_LIMITS.pageLimit,
      runId,
    });
    if (!page.ok) {
      return [];
    }
    events.push(...page.events);
    if (!page.hasMore) {
      return events;
    }
    afterSequence = page.nextSequence;
  }
}

function gatedStore(f, realStore, leasesByRun, limits, trace) {
  return {
    appendEvent: (event) => realStore.appendEvent(event),
    async commitRun(request) {
      const lease = leasesByRun.get(request.runId);
      const payload = {
        ...request,
        history: eventHistory(realStore, request.runId),
      };
      const maxBytes = spansExecutionArchiveWriteBytes({
        limits,
        method: 'commitRun',
        payload,
      });
      const entry = {
        maxBytes,
        method: 'commitRun',
        ok: false,
        payload: structuredClone(payload),
      };
      trace.push(entry);
      if (!(lease && Number.isSafeInteger(maxBytes))) {
        return { code: 'TEST_POLICY_ALLOCATION_INVALID', ok: false };
      }
      const admitted = await f.admission.withSpansArchiveWrite(
        { lease, maxBytes, root: f.archiveRoot },
        () => {
          const committed = realStore.commitRun(request);
          if (committed.ok) {
            // The injected counter models canonical view and event bytes only.
            // It is deliberately not presented as SQLite/WAL physical growth.
            f.measuredBytes += logicalBytes({
              events: request.events,
              view: request.view,
            });
          }
          return committed;
        }
      );
      entry.ok = admitted.ok;
      return admitted.ok ? admitted.value : admitted;
    },
    readRun: (request) => realStore.readRun(request),
  };
}

function gatedSpool(f, lease, limits, trace, failCompleteFinalize = false) {
  const chunks = [];
  const gated = async (method, payload, effect) => {
    const maxBytes = spansExecutionArchiveWriteBytes({
      limits,
      method,
      payload,
    });
    const entry = {
      maxBytes,
      method,
      ok: false,
      payload: structuredClone(payload),
    };
    trace.push(entry);
    if (!Number.isSafeInteger(maxBytes)) {
      return { code: 'TEST_POLICY_ALLOCATION_INVALID', ok: false };
    }
    const admitted = await f.admission.withSpansArchiveWrite(
      { lease, maxBytes, root: f.archiveRoot },
      async () => {
        const result = await effect();
        if (result.ok) {
          f.measuredBytes += logicalBytes(payload);
        }
        return result;
      }
    );
    entry.ok = admitted.ok;
    return admitted.ok ? admitted.value : admitted;
  };
  return {
    append: (payload) =>
      gated('append', payload, () => {
        chunks.push(structuredClone(payload));
        return { ok: true };
      }),
    finalize: (payload) =>
      gated(payload.complete ? 'finalize' : 'heldFinalize', payload, () => {
        if (failCompleteFinalize && payload.complete) {
          return { ok: false };
        }
        return {
          artifactId: `sha256:${createHash('sha256')
            .update(
              JSON.stringify([
                payload.attemptDigest,
                payload.complete,
                payload.chainDigest,
              ])
            )
            .digest('hex')}`,
          ok: true,
        };
      }),
    stat: ({ attemptDigest }) => {
      const records = chunks.filter(
        (chunk) => chunk.attemptDigest === attemptDigest
      );
      return {
        bytes: records.reduce((total, chunk) => total + chunk.bytes, 0),
        chunks: records.length,
        ok: true,
      };
    },
  };
}

function workerFor({
  f,
  failCompleteFinalize,
  lease,
  limits,
  store,
  trace,
  number,
}) {
  let sink;
  const launcher = {
    launch({ sink: requestedSink }) {
      sink = requestedSink;
      return Promise.resolve({
        nativeId: `native-${number}`,
        ok: true,
        processStart: { id: `process-${number}`, pid: 4242 + number },
      });
    },
    stop: async () => ({ ok: true }),
  };
  const worker = createSpansWorker({
    clock: { now: () => 1000 },
    launcher,
    limits,
    spool: gatedSpool(f, lease, limits, trace, failCompleteFinalize),
    store,
    workerId: `worker-${number}`,
  });
  return {
    launcher,
    get sink() {
      return sink;
    },
    worker,
  };
}

function committedTypes(trace, runId) {
  return trace
    .filter(
      (entry) => entry.method === 'commitRun' && entry.payload.runId === runId
    )
    .flatMap((entry) => entry.payload.events.map((event) => event.type));
}

test('each exact attempt reserves once and shared admission sums two live leases at the boundary', async () => {
  const f = fixture();
  const reservation = spansExecutionArchiveReservation({
    limits: workerLimits,
    root: f.archiveRoot,
  });
  expect(reservation).toMatchObject({
    budgetBytes: SPANS_ARCHIVE_BUDGET_BYTES,
    root: f.archiveRoot,
  });
  expect(Number.isSafeInteger(reservation.reservedBytes)).toBe(true);
  expect(reservation.reservedBytes).toBeGreaterThan(0);
  expect(reservation.reservedBytes).toBeLessThan(
    SPANS_ARCHIVE_BUDGET_BYTES / 2
  );

  f.measuredBytes = SPANS_ARCHIVE_BUDGET_BYTES - 2 * reservation.reservedBytes;
  const first = await admitLease(f, reservation, 1);
  const second = await admitLease(f, reservation, 2);
  expect(first.operationId).toBe('capture-1');
  expect(second.operationId).toBe('capture-2');

  const capacity = await f.admission.status();
  expect(capacity.leases).toHaveLength(2);
  expect(
    capacity.leases.reduce(
      (total, lease) => total + lease.spansArchiveReservation.reservedBytes,
      0
    )
  ).toBe(2 * reservation.reservedBytes);

  const third = await f.admission.admit(archiveRequest(reservation, 3));
  expect(third).toMatchObject({
    code: 'SPANS_ARCHIVE_CAPACITY_REACHED',
    ok: false,
  });
});

test('real worker commit payloads keep the cancel race and cap-held exit inside two near-cap leases', async () => {
  const f = fixture();
  const limits = smallWorkerLimits;
  const reservation = spansExecutionArchiveReservation({
    limits,
    root: f.archiveRoot,
  });
  expect(reservation).toBeDefined();
  f.measuredBytes = SPANS_ARCHIVE_BUDGET_BYTES - 2 * reservation.reservedBytes;
  const leases = new Map([
    [1, await admitLease(f, reservation, 1)],
    [2, await admitLease(f, reservation, 2)],
  ]);

  const storeRoot = join(f.workspace, 'sqlite-store');
  fs.mkdirSync(storeRoot, { mode: 0o700 });
  const realStore = openSpansStore({ root: storeRoot });
  stores.push(realStore);
  const bindings = new Map(
    [1, 2].map((number) => [number, bindingFor(number)])
  );
  for (const binding of bindings.values()) {
    seedRun(realStore, binding);
  }

  const trace = [];
  const leasesByRun = new Map(
    [...bindings].map(([number, binding]) => [
      binding.runId,
      leases.get(number),
    ])
  );
  const store = gatedStore(f, realStore, leasesByRun, limits, trace);
  const cancelled = workerFor({
    f,
    lease: leases.get(1),
    limits,
    number: 1,
    store,
    trace,
  });
  const cancelledBinding = bindings.get(1);
  const started = await cancelled.worker.start({
    actionId: cancelledBinding.actionId,
    attemptId: cancelledBinding.attemptId,
    deadlineMs: 5000,
    generation: cancelledBinding.generation,
    runId: cancelledBinding.runId,
    spanId: cancelledBinding.spanId,
  });
  expect(started).toMatchObject({ created: true, ok: true, status: 'running' });
  expect((await cancelled.sink.chunk('ok\n')).ok).toBe(true);

  // The owned stop calls the real generic sink while delivery is still in
  // flight. The worker must finish its ordinary capture path before the stop
  // result can be committed.
  cancelled.launcher.stop = async () => {
    const exit = await cancelled.sink.exit({ code: 0, signal: null });
    return { ok: exit.ok };
  };
  const cancelResult = await cancelled.worker.cancel(started.ref);
  expect(cancelResult).toMatchObject({ cancel: 'delivered', ok: true });

  const cancelledTypes = committedTypes(trace, cancelledBinding.runId);
  const cancelRequested = cancelledTypes.indexOf(
    SPANS_WORKER_EVENT_TYPES.cancelRequested
  );
  const finalizing = cancelledTypes.indexOf(
    SPANS_WORKER_EVENT_TYPES.finalizing
  );
  const exited = cancelledTypes.indexOf(SPANS_WORKER_EVENT_TYPES.exited);
  const cancelDelivered = cancelledTypes.indexOf(
    SPANS_WORKER_EVENT_TYPES.cancelDelivered
  );
  expect(cancelRequested).toBeGreaterThanOrEqual(0);
  expect(finalizing).toBeGreaterThan(cancelRequested);
  expect(exited).toBeGreaterThan(finalizing);
  expect(cancelDelivered).toBeGreaterThan(exited);

  const cancelledRecord = realStore.readRun({ runId: cancelledBinding.runId })
    .view.attempts[cancelledBinding.attemptId];
  expect(cancelledRecord).toMatchObject({
    cancel: { state: 'delivered' },
    capture: { complete: true },
    status: 'exited',
  });

  const held = workerFor({
    f,
    lease: leases.get(2),
    limits,
    number: 2,
    store,
    trace,
  });
  const heldBinding = bindings.get(2);
  const heldStarted = await held.worker.start({
    actionId: heldBinding.actionId,
    attemptId: heldBinding.attemptId,
    deadlineMs: 5000,
    generation: heldBinding.generation,
    runId: heldBinding.runId,
    spanId: heldBinding.spanId,
  });
  expect(heldStarted).toMatchObject({
    created: true,
    ok: true,
    status: 'running',
  });
  expect((await held.sink.chunk('a\nb\nc\nd\n')).ok).toBe(true);
  expect(await held.sink.chunk('e\n')).toMatchObject({
    code: 'SPOOL_LIMIT',
    held: true,
  });

  // The parent's real action service records UNKNOWN after cancel and hold,
  // matching restart reconciliation's ordering.
  const actions = createSpansActions({ now: () => 1001, store });
  expect(
    await actions.recordOutcome({
      actionId: heldBinding.actionId,
      artifactIds: [],
      generation: heldBinding.generation,
      outcome: 'unknown',
      runId: heldBinding.runId,
    })
  ).toMatchObject({ ok: true, status: 'unknown' });
  const heldExit = await held.sink.exit({ code: 143, signal: null });
  expect(heldExit).toMatchObject({
    ok: true,
    processExited: true,
    status: 'held',
  });

  const heldTypes = committedTypes(trace, heldBinding.runId);
  const heldCancel = heldTypes.indexOf(
    SPANS_WORKER_EVENT_TYPES.cancelRequested
  );
  const heldReceipt = heldTypes.indexOf(SPANS_WORKER_EVENT_TYPES.held);
  const unknownOutcome = heldTypes.indexOf('spans.action.outcome');
  const heldExited = heldTypes.lastIndexOf(SPANS_WORKER_EVENT_TYPES.exited);
  expect(heldCancel).toBeGreaterThanOrEqual(0);
  expect(heldReceipt).toBeGreaterThan(heldCancel);
  expect(unknownOutcome).toBeGreaterThan(heldReceipt);
  expect(heldExited).toBeGreaterThan(unknownOutcome);

  const writes = trace.filter(
    (entry) =>
      entry.payload?.runId === cancelledBinding.runId ||
      entry.payload?.runId === heldBinding.runId ||
      entry.method !== 'commitRun'
  );
  expect(writes.length).toBeGreaterThan(0);
  expect(writes.every((entry) => Number.isSafeInteger(entry.maxBytes))).toBe(
    true
  );
  expect(
    writes.every(
      (entry) =>
        entry.maxBytes <=
        leases.get(entry.payload?.runId === heldBinding.runId ? 2 : 1)
          .spansArchiveReservation.reservedBytes
    )
  ).toBe(true);
  expect(writes.every((entry) => entry.ok)).toBe(true);
  expect(
    trace
      .filter((entry) => entry.method === 'commitRun')
      .every((entry) => entry.payload.events.length > 0)
  ).toBe(true);
});

test('finalize failure during an in-flight cancel holds before recording the stop result', async () => {
  const f = fixture();
  const limits = smallWorkerLimits;
  const reservation = spansExecutionArchiveReservation({
    limits,
    root: f.archiveRoot,
  });
  expect(reservation).toBeDefined();
  f.measuredBytes = SPANS_ARCHIVE_BUDGET_BYTES - reservation.reservedBytes;
  const lease = await admitLease(f, reservation, 3);

  const storeRoot = join(f.workspace, 'failed-finalize-store');
  fs.mkdirSync(storeRoot, { mode: 0o700 });
  const realStore = openSpansStore({ root: storeRoot });
  stores.push(realStore);
  const binding = bindingFor(3);
  seedRun(realStore, binding);
  const trace = [];
  const store = gatedStore(
    f,
    realStore,
    new Map([[binding.runId, lease]]),
    limits,
    trace
  );
  const worker = workerFor({
    f,
    failCompleteFinalize: true,
    lease,
    limits,
    number: 3,
    store,
    trace,
  });
  const started = await worker.worker.start({
    actionId: binding.actionId,
    attemptId: binding.attemptId,
    deadlineMs: 5000,
    generation: binding.generation,
    runId: binding.runId,
    spanId: binding.spanId,
  });
  expect(started).toMatchObject({ created: true, ok: true, status: 'running' });
  const chunkResult = await worker.sink.chunk('ok\n');
  expect(chunkResult).toMatchObject({ ok: true });
  worker.launcher.stop = async () => {
    const exit = await worker.sink.exit({ code: 0, signal: null });
    return { ok: exit.ok };
  };

  const cancelled = await worker.worker.cancel(started.ref);
  expect(cancelled).toMatchObject({
    cancel: 'unknown',
    code: 'CANCEL_UNKNOWN',
    ok: false,
    unknown: true,
  });
  const types = committedTypes(trace, binding.runId);
  const cancelRequested = types.indexOf(
    SPANS_WORKER_EVENT_TYPES.cancelRequested
  );
  const finalizing = types.indexOf(SPANS_WORKER_EVENT_TYPES.finalizing);
  const held = types.indexOf(SPANS_WORKER_EVENT_TYPES.held);
  const cancelUnknown = types.indexOf(SPANS_WORKER_EVENT_TYPES.cancelUnknown);
  expect(cancelRequested).toBeGreaterThanOrEqual(0);
  expect(finalizing).toBeGreaterThan(cancelRequested);
  expect(held).toBeGreaterThan(finalizing);
  expect(cancelUnknown).toBeGreaterThan(held);
  expect(types).not.toContain(SPANS_WORKER_EVENT_TYPES.exited);

  const attempt = realStore.readRun({ runId: binding.runId }).view.attempts[
    binding.attemptId
  ];
  expect(attempt).toMatchObject({
    cancel: { state: 'unknown' },
    capture: { complete: false, gap: { reason: 'finalize-failed' } },
    status: 'held',
  });
  expect(trace.every((entry) => Number.isSafeInteger(entry.maxBytes))).toBe(
    true
  );
  expect(
    trace.every((entry) => entry.maxBytes <= reservation.reservedBytes)
  ).toBe(true);
  expect(trace.every((entry) => entry.ok)).toBe(true);
});

test('invalid or oversized trusted worker limits and unknown write methods fail closed', () => {
  const f = fixture();
  for (const limits of [
    { ...workerLimits, maxActiveAttempts: 3 },
    { ...workerLimits, maxAttemptBytes: 4 * MiB + 1 },
    { ...workerLimits, maxAttemptChunks: 65_537 },
    { ...workerLimits, maxDeadlineMs: 60 * 60 * 1000 + 1 },
    { ...workerLimits, maxChunkBytes: 0 },
    { ...workerLimits, maxChunkBytes: workerLimits.maxQueueBytes + 1 },
    { ...workerLimits, extra: true },
  ]) {
    expect(
      spansExecutionArchiveReservation({ limits, root: f.archiveRoot })
    ).toBeUndefined();
    expect(
      spansExecutionArchiveWriteBytes({ limits, method: 'append' })
    ).toBeUndefined();
  }
  expect(
    spansExecutionArchiveReservation({
      limits: workerLimits,
      root: 'relative',
    })
  ).toBeUndefined();
  expect(
    spansExecutionArchiveWriteBytes({
      limits: workerLimits,
      method: 'configure',
    })
  ).toBeUndefined();
});
