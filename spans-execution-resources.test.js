import { afterEach, expect, test } from 'bun:test';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createResourceAdmission,
  SPANS_ARCHIVE_BUDGET_BYTES,
} from './resource-admission.js';
import { createSpansActions } from './spans-actions.js';
import { admissionOperationId } from './spans-dispatch.js';
import { createSpansDrafts } from './spans-drafts.js';
import { spansExecutionArchiveReservation } from './spans-execution-archive-policy.js';
import { createSpansExecutionResources } from './spans-execution-resources.js';
import { openSpansStore } from './spans-store.js';
import { createWorkspaceState } from './workspace-state.js';

const roots = [];
const stores = [];
const limits = {
  maxActiveAttempts: 2,
  maxAttemptBytes: 4 * 1024 * 1024,
  maxAttemptChunks: 65_536,
  maxChunkBytes: 64 * 1024,
  maxDeadlineMs: 30 * 60 * 1000,
  maxQueueBytes: 1024 * 1024,
};

function fixture({
  executionOverrides = {},
  paths = true,
  persistAuthorization = true,
} = {}) {
  const dir = fs.mkdtempSync(join(tmpdir(), 'setu-spans-execution-resources-'));
  roots.push(dir);
  const archive = join(dir, 'archive');
  fs.mkdirSync(archive, { mode: 0o700 });
  const workspace = join(dir, 'workspace');
  fs.mkdirSync(workspace, { mode: 0o700 });
  const state = createWorkspaceState({
    configPath: join(dir, 'config.json'),
    setuDir: dir,
    workspaceRoot: workspace,
  });
  const store = openSpansStore({ root: archive });
  stores.push(store);
  const drafts = createSpansDrafts({ store });
  const runId = 'run-resources';
  expect(
    drafts.createRun({
      goal: 'resource seam',
      owner: 'fixture',
      runId,
      spans: [{ dependencies: [], spanId: 'build', title: 'Build' }],
    }).ok
  ).toBe(true);
  const target = { name: 'feature', repo: 'demo' };
  const { generation } = store.readRun({ runId });
  const execution = {
    actionId: 'action-resources',
    attemptId: 'attempt-resources',
    reviewSelector: { generation },
    runId,
    spanId: 'build',
    target,
    ...executionOverrides,
  };
  const read = store.readRun({ runId });
  if (persistAuthorization) {
    expect(
      store.commitRun({
        events: [
          {
            eventId: 'authorization-recorded',
            payload: {
              actionId: execution.actionId,
              attemptId: execution.attemptId,
            },
            runId,
            type: 'spans.execution.authorized',
          },
        ],
        expectedGeneration: read.generation,
        expectedRevision: read.revision,
        runId,
        view: { ...read.view, executions: { [execution.actionId]: execution } },
      }).ok
    ).toBe(true);
  }
  const resourceAdmission = createResourceAdmission({
    archiveCapacity: async ({ root, budgetBytes }) => ({
      ok: root === archive && budgetBytes === SPANS_ARCHIVE_BUDGET_BYTES,
      state: 'known',
      totalBytes: 0,
    }),
    hostHealth: async () => ({
      availableBytes: 20 * 1024 ** 3,
      state: 'ready',
    }),
    limits: { lowStorageFloorBytes: 0 },
    now: () => 100,
    observeProcess: async (pid) => ({
      processId: pid,
      processStartIdentity: `fixture-${pid}`,
      state: 'alive',
    }),
    state,
  });
  const resourcePaths = paths
    ? {
        configPath: join(dir, 'config.json'),
        setuDir: dir,
        workspaceRoot: workspace,
      }
    : {};
  const resources = createSpansExecutionResources({
    admission: resourceAdmission,
    limits,
    resourcePaths,
    root: archive,
    store,
  });
  return {
    archive,
    dir,
    execution,
    resourceAdmission,
    resources,
    runId,
    store,
    target,
  };
}

function eventPayload(f, extra = {}) {
  return {
    payload: {
      actionId: f.execution.actionId,
      attemptId: f.execution.attemptId,
      ...extra,
    },
    runId: f.runId,
    type: 'spans.execution.captured',
  };
}

afterEach(() => {
  for (const store of stores.splice(0)) {
    store.close();
  }
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { force: true, recursive: true });
  }
});

test('first admission is resolved from saved authorization in operation-local execution scope', async () => {
  const f = fixture();
  const operationId = admissionOperationId(f.execution);
  const result = await f.resources.withExecution(f.execution, () =>
    f.resources.admission.admit({
      kind: 'headless-run',
      operationId,
      target: f.target,
    })
  );
  expect(result.ok).toBe(true);
  expect(result.lease.spansBinding).toMatchObject({
    actionId: f.execution.actionId,
    attemptId: f.execution.attemptId,
    generation: f.execution.reviewSelector.generation,
  });
  expect(result.lease.spansArchiveReservation).toEqual(
    spansExecutionArchiveReservation({ limits, root: f.archive })
  );
});

test('the first authorization is admitted before its execution record exists', async () => {
  const f = fixture({ persistAuthorization: false });
  const read = f.store.readRun({ runId: f.runId });
  const payload = {
    events: [
      {
        ...eventPayload(f),
        eventId: 'first-authorization',
        type: 'spans.execution.authorized',
      },
    ],
    expectedGeneration: read.generation,
    expectedRevision: read.revision,
    runId: f.runId,
    view: { ...read.view, executions: { [f.execution.actionId]: f.execution } },
  };
  const operation = {
    kind: 'headless-run',
    operationId: admissionOperationId(f.execution),
    target: f.target,
  };
  expect(
    (
      await f.resources.withExecution(f.execution, () =>
        f.resources.admission.admit(operation)
      )
    ).ok
  ).toBe(false);
  const prepared = await f.resources.writeRequest({
    method: 'commitRun',
    payload,
  });
  expect(prepared.ok).toBe(true);
  expect(prepared.request.lease).toBeUndefined();
  expect(
    (
      await f.resourceAdmission.withSpansArchiveWrite(prepared.request, () =>
        f.store.commitRun(payload)
      )
    ).value.ok
  ).toBe(true);
  expect(
    (
      await f.resources.withExecution(f.execution, () =>
        f.resources.admission.admit(operation)
      )
    ).ok
  ).toBe(true);
});

test('the same operation scope keeps its exact lease after a real action intent is saved', async () => {
  const f = fixture();
  await f.resources.withExecution(f.execution, async () => {
    const admitted = await f.resources.admission.admit({
      kind: 'headless-run',
      operationId: admissionOperationId(f.execution),
      target: f.target,
    });
    expect(admitted.ok).toBe(true);
    const read = f.store.readRun({ runId: f.runId });
    const actions = createSpansActions({ store: f.store });
    expect(
      (
        await actions.prepareAction({
          actionId: f.execution.actionId,
          attemptId: f.execution.attemptId,
          generation: read.generation,
          inputDigest: 'a'.repeat(64),
          planVersion: read.view.planVersion,
          runId: f.runId,
          spanId: f.execution.spanId,
          targetDigest: 'b'.repeat(64),
        })
      ).ok
    ).toBe(true);
    expect(
      f.store.readRun({ runId: f.runId }).view.actions[f.execution.actionId]
        .generation
    ).toBeUndefined();
    const write = await f.resources.writeRequest({
      method: 'appendEvent',
      payload: eventPayload(f),
    });
    expect(write.ok).toBe(true);
    expect(write.request.lease).toEqual(admitted.lease);
    expect((await f.resources.admission.status()).leases).toHaveLength(1);
  });
});

test('an advanced archive generation cannot reuse or release the old exact lease', async () => {
  const f = fixture();
  const admitted = await f.resources.withExecution(f.execution, () =>
    f.resources.admission.admit({
      kind: 'headless-run',
      operationId: admissionOperationId(f.execution),
      target: f.target,
    })
  );
  expect(admitted.ok).toBe(true);
  const read = f.store.readRun({ runId: f.runId });
  expect(
    f.store.commitRun({
      events: [],
      expectedGeneration: read.generation,
      expectedRevision: read.revision,
      runId: f.runId,
      view: { ...read.view, generation: read.generation + 1 },
    }).ok
  ).toBe(true);
  expect(
    (
      await f.resources.writeRequest({
        method: 'appendEvent',
        payload: eventPayload(f),
      })
    ).ok
  ).toBe(false);
  expect((await f.resources.admission.release(admitted.lease)).ok).toBe(false);
  expect((await f.resourceAdmission.status()).leases).toHaveLength(1);
});

test('a generation change while waiting to release is fenced under the shared resource lock', async () => {
  const f = fixture();
  const moving = {
    ...f.resourceAdmission,
    async release(lease, guard) {
      const read = f.store.readRun({ runId: f.runId });
      expect(
        f.store.commitRun({
          events: [],
          expectedGeneration: read.generation,
          expectedRevision: read.revision,
          runId: f.runId,
          view: { ...read.view, generation: read.generation + 1 },
        }).ok
      ).toBe(true);
      return await f.resourceAdmission.release(lease, guard);
    },
  };
  const resources = createSpansExecutionResources({
    admission: moving,
    limits,
    root: f.archive,
    store: f.store,
  });
  const admitted = await resources.withExecution(f.execution, () =>
    resources.admission.admit({
      kind: 'headless-run',
      operationId: admissionOperationId(f.execution),
      target: f.target,
    })
  );
  expect(admitted.ok).toBe(true);
  expect((await resources.admission.release(admitted.lease)).ok).toBe(false);
  expect((await f.resourceAdmission.status()).leases).toHaveLength(1);
});

test('restart resolves the exact durable lease, excludes its own reservation and supplies its proof to the shared write gate', async () => {
  const f = fixture();
  const operationId = admissionOperationId(f.execution);
  const first = await f.resources.withExecution(f.execution, () =>
    f.resources.admission.admit({
      kind: 'headless-run',
      operationId,
      target: f.target,
    })
  );
  const restarted = createSpansExecutionResources({
    admission: f.resourceAdmission,
    limits,
    resourcePaths: {
      configPath: join(fs.realpathSync(f.dir), 'config.json'),
      setuDir: fs.realpathSync(f.dir),
      workspaceRoot: fs.realpathSync(join(f.dir, 'workspace')),
    },
    root: f.archive,
    store: f.store,
  });
  const payload = eventPayload(f);
  const write = await restarted.writeRequest({
    method: 'appendEvent',
    payload,
  });
  expect(write.ok).toBe(true);
  expect(write.request.lease).toEqual(first.lease);
  expect(write.request.maxBytes).toBeGreaterThan(0);
  const result = await f.resourceAdmission.withSpansArchiveWrite(
    write.request,
    () => ({ wrote: true })
  );
  expect(result).toMatchObject({ ok: true, value: { wrote: true } });
  expect(
    await restarted.captureContext({
      actionId: f.execution.actionId,
      attemptId: f.execution.attemptId,
      generation: f.execution.reviewSelector.generation,
      runId: f.runId,
      spanId: f.execution.spanId,
      target: f.target,
    })
  ).toMatchObject({
    lease: first.lease,
    workspaceRoot: fs.realpathSync(join(f.dir, 'workspace')),
  });
});

test('active attempts without a matching lease and malformed event identities refuse', async () => {
  const f = fixture();
  const read = f.store.readRun({ runId: f.runId });
  const view = {
    ...read.view,
    actions: {
      [f.execution.actionId]: {
        actionId: f.execution.actionId,
        attemptId: f.execution.attemptId,
        spanId: f.execution.spanId,
        state: 'intent',
      },
    },
  };
  expect(
    f.store.commitRun({
      events: [],
      expectedGeneration: read.generation,
      expectedRevision: read.revision,
      runId: f.runId,
      view,
    }).ok
  ).toBe(true);
  expect(
    await f.resources.writeRequest({
      method: 'appendEvent',
      payload: eventPayload(f),
    })
  ).toMatchObject({ ok: false });
  expect(
    await f.resources.writeRequest({
      method: 'commitRun',
      payload: {
        events: [{ payload: { actionId: f.execution.actionId } }],
        runId: f.runId,
        view,
      },
    })
  ).toMatchObject({ ok: false });
  expect(
    await f.resources.writeRequest({
      method: 'commitRun',
      payload: { events: [], runId: f.runId, view },
    })
  ).toMatchObject({ ok: false });
});

test('pre-admission authorization writes remain unleased and terminal release permits ordinary writes', async () => {
  const f = fixture();
  const payload = eventPayload(f);
  const before = await f.resources.writeRequest({
    method: 'appendEvent',
    payload,
  });
  expect(before).toMatchObject({ ok: true, request: { root: f.archive } });
  expect(before.request.lease).toBeUndefined();

  const operationId = admissionOperationId(f.execution);
  const admitted = await f.resources.withExecution(f.execution, () =>
    f.resources.admission.admit({
      kind: 'headless-run',
      operationId,
      target: f.target,
    })
  );
  expect(admitted.ok).toBe(true);
  expect((await f.resources.admission.release(admitted.lease)).ok).toBe(true);
  const read = f.store.readRun({ runId: f.runId });
  const terminalView = {
    ...read.view,
    actions: {
      [f.execution.actionId]: {
        actionId: f.execution.actionId,
        attemptId: f.execution.attemptId,
        spanId: f.execution.spanId,
        state: 'failed',
      },
    },
    attempts: {
      [f.execution.attemptId]: {
        actionId: f.execution.actionId,
        attemptId: f.execution.attemptId,
        generation: f.execution.reviewSelector.generation,
        status: 'exited',
      },
    },
  };
  expect(
    f.store.commitRun({
      events: [],
      expectedGeneration: read.generation,
      expectedRevision: read.revision,
      runId: f.runId,
      view: terminalView,
    }).ok
  ).toBe(true);
  const after = await f.resources.writeRequest({
    method: 'appendEvent',
    payload,
  });
  expect(after).toMatchObject({ ok: true, request: { root: f.archive } });
  expect(after.request.lease).toBeUndefined();
});

test('wrong root, binding fields and a legacy reservation-less lease fail closed', async () => {
  const f = fixture();
  const operationId = admissionOperationId(f.execution);
  await f.resources.withExecution(f.execution, () =>
    f.resources.admission.admit({
      kind: 'headless-run',
      operationId,
      target: f.target,
    })
  );
  const payload = eventPayload(f);
  const wrongRoot = createSpansExecutionResources({
    admission: f.resourceAdmission,
    limits,
    resourcePaths: {},
    root: join(f.archive, 'different-root'),
    store: f.store,
  });
  expect(
    await wrongRoot.writeRequest({ method: 'appendEvent', payload })
  ).toMatchObject({ ok: false });

  const mismatchedResults = await Promise.all(
    ['generation', 'actionId', 'attemptId'].map((key) => {
      const mismatched = {
        ...f.resourceAdmission,
        status: async () => {
          const status = await f.resourceAdmission.status();
          return {
            ...status,
            leases: status.leases.map((lease) => ({
              ...lease,
              spansBinding: {
                ...lease.spansBinding,
                [key]:
                  key === 'generation'
                    ? lease.spansBinding.generation + 1
                    : `${lease.spansBinding[key]}-other`,
              },
            })),
          };
        },
      };
      const resources = createSpansExecutionResources({
        admission: mismatched,
        limits,
        resourcePaths: {},
        root: f.archive,
        store: f.store,
      });
      return resources.writeRequest({ method: 'appendEvent', payload });
    })
  );
  expect(mismatchedResults.every((result) => result.ok === false)).toBe(true);
  const wrongReservation = {
    ...f.resourceAdmission,
    status: async () => {
      const status = await f.resourceAdmission.status();
      return {
        ...status,
        leases: status.leases.map((lease) => ({
          ...lease,
          spansArchiveReservation: {
            ...lease.spansArchiveReservation,
            reservedBytes: lease.spansArchiveReservation.reservedBytes + 1,
          },
        })),
      };
    },
  };
  const reservationResources = createSpansExecutionResources({
    admission: wrongReservation,
    limits,
    resourcePaths: {},
    root: f.archive,
    store: f.store,
  });
  expect(
    await reservationResources.writeRequest({ method: 'appendEvent', payload })
  ).toMatchObject({ ok: false });

  const legacy = fixture();
  const legacyId = admissionOperationId(legacy.execution);
  expect(
    (
      await legacy.resourceAdmission.admit({
        kind: 'headless-run',
        operationId: legacyId,
        spansBinding: {
          actionId: legacy.execution.actionId,
          attemptId: legacy.execution.attemptId,
          generation: legacy.execution.reviewSelector.generation,
          runId: legacy.runId,
          spanId: legacy.execution.spanId,
          target: legacy.target,
        },
        target: legacy.target,
      })
    ).ok
  ).toBe(true);
  expect(
    await legacy.resources.writeRequest({
      method: 'appendEvent',
      payload: eventPayload(legacy),
    })
  ).toMatchObject({ ok: false });
});

test('cleanup identity needs no approval fields, while invalid injected paths fail closed', async () => {
  const f = fixture();
  const operationId = admissionOperationId(f.execution);
  await f.resources.withExecution(f.execution, () =>
    f.resources.admission.admit({
      kind: 'headless-run',
      operationId,
      target: f.target,
    })
  );
  expect(
    await f.resources.writeRequest({
      method: 'appendEvent',
      payload: eventPayload(f),
    })
  ).toMatchObject({ ok: true });
  const noPaths = createSpansExecutionResources({
    admission: f.resourceAdmission,
    limits,
    resourcePaths: {},
    root: f.archive,
    store: f.store,
  });
  expect(
    await noPaths.captureContext({
      actionId: f.execution.actionId,
      attemptId: f.execution.attemptId,
      generation: f.execution.reviewSelector.generation,
      runId: f.runId,
      spanId: f.execution.spanId,
      target: f.target,
    })
  ).toMatchObject({ ok: false });
});
