import { afterEach, expect, test } from 'bun:test';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createResourceAdmission } from './resource-admission.js';
import { createWorkspaceState } from './workspace-state.js';

const roots = [];
const children = [];
const GiB = 1024 ** 3;

function fixture({ availableBytes = 30 * GiB } = {}) {
  const root = fs.mkdtempSync(join(tmpdir(), 'setu-resource-admission-'));
  roots.push(root);
  const state = createWorkspaceState({
    configPath: join(root, 'config.json'),
    setuDir: root,
    workspaceRoot: root,
  });
  const reads = [];
  // biome-ignore lint/suspicious/useAwait: The health observer fixture preserves its asynchronous result contract.
  const hostHealth = async (options) => {
    reads.push(options);
    return { availableBytes, state: 'ready' };
  };
  const observeProcess = async (pid) =>
    pid === process.pid
      ? {
          processId: pid,
          processStartIdentity: `start-${pid}`,
          state: 'alive',
        }
      : { state: 'absent' };
  return {
    admission: (limits, observer, archiveCapacity) =>
      createResourceAdmission({
        ...(archiveCapacity === undefined ? {} : { archiveCapacity }),
        hostHealth,
        limits,
        now: () => 1234,
        observeProcess: observer ?? observeProcess,
        state,
      }),
    reads,
    root,
    state,
  };
}

afterEach(() => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null) {
      child.kill();
    }
  }
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { force: true, recursive: true });
  }
});

test('each admission refreshes storage and unknown or low storage refuses new work', async () => {
  const f = fixture();
  const admission = f.admission();
  expect(
    await admission.admit({
      kind: 'headless-run',
      operationId: 'headless-a',
      target: { name: 'topic', repo: 'repo' },
    })
  ).toMatchObject({ ok: true });
  expect(f.reads).toEqual([{ refresh: true }]);

  const unknown = createResourceAdmission({
    hostHealth: async () => ({ state: 'unknown' }),
    now: () => 1,
    state: f.state,
  });
  await expect(
    unknown.admit({
      kind: 'headless-run',
      operationId: 'headless-b',
      target: { name: 'topic', repo: 'repo' },
    })
  ).resolves.toMatchObject({ code: 'STORAGE_UNKNOWN', ok: false });

  const low = fixture({ availableBytes: 7 * GiB }).admission();
  await expect(
    low.admit({
      kind: 'install',
      operationId: 'install-low',
      target: { name: 'topic', repo: 'repo' },
    })
  ).resolves.toMatchObject({ code: 'STORAGE_LOW', ok: false });
  const refused = await low.admit({
    kind: 'install',
    operationId: 'install-low-message',
    target: { name: 'topic', repo: 'repo' },
  });
  expect(refused.error).toContain('7.0 GiB free, 8.0 GiB required');
  expect(refused.error).toContain('setu adopt');
});

test('the storage floor and session cap come from the live config document', async () => {
  const f = fixture({ availableBytes: 7 * GiB });
  const admission = f.admission();
  await f.state.replace('config', {
    resourceAdmission: { lowStorageFloorBytes: 5 * GiB },
  });
  await expect(
    admission.admit({
      kind: 'install',
      operationId: 'install-config-floor',
      target: { name: 'topic', repo: 'repo' },
    })
  ).resolves.toMatchObject({ ok: true });
  await f.state.replace('config', {
    resourceAdmission: { lowStorageFloorBytes: 'bad' },
  });
  await expect(
    admission.admit({
      kind: 'install',
      operationId: 'install-default-floor',
      target: { name: 'other', repo: 'repo' },
    })
  ).resolves.toMatchObject({ code: 'STORAGE_LOW', ok: false });
});

test('admission records leave the user config document byte-for-byte unchanged', async () => {
  const f = fixture();
  await f.state.replace('config', { userSetting: 'keep-this-exactly' });
  const configPath = join(f.root, 'config.json');
  const before = fs.readFileSync(configPath);
  await expect(
    f.admission().admit({
      kind: 'headless-run',
      operationId: 'config-isolation',
      target: { name: 'topic', repo: 'repo' },
    })
  ).resolves.toMatchObject({ ok: true });
  expect(fs.readFileSync(configPath)).toEqual(before);
  expect(f.state.read('resourceAdmission')).toMatchObject({
    leases: { 'config-isolation': { kind: 'headless-run' } },
  });
});

test('managed session cap includes headless runs and release frees only its exact operation', async () => {
  const f = fixture();
  const admission = f.admission({ maxManagedSessions: 2 });
  const first = await admission.admit({
    kind: 'session',
    operationId: 'session-a',
    target: { name: 'a', repo: 'repo' },
  });
  const second = await admission.admit({
    kind: 'headless-run',
    operationId: 'headless-b',
    target: { name: 'b', repo: 'repo' },
  });
  expect(first.ok).toBe(true);
  expect(second.ok).toBe(true);
  await expect(
    admission.admit({
      kind: 'headless-run',
      operationId: 'session-c',
      target: { name: 'c', repo: 'repo' },
    })
  ).resolves.toMatchObject({
    code: 'SESSION_CAPACITY_REACHED',
    ok: false,
  });
  await expect(
    admission.release({
      ...first.lease,
      acquiredAt: first.lease.acquiredAt + 1,
    })
  ).resolves.toMatchObject({ code: 'LEASE_MISMATCH', ok: false });
  expect((await admission.status()).leases).toHaveLength(2);
  await expect(admission.release(first.lease)).resolves.toEqual({ ok: true });
  await expect(
    admission.admit({
      kind: 'session',
      operationId: 'session-c',
      target: { name: 'c', repo: 'repo' },
    })
  ).resolves.toMatchObject({ ok: true });
});

test('a stale lease cannot release a later acquisition with the same operation id', async () => {
  const f = fixture();
  let tick = 1;
  const admission = createResourceAdmission({
    hostHealth: async () => ({ availableBytes: 30 * GiB, state: 'ready' }),
    now: () => tick,
    observeProcess: async (pid) => ({
      processId: pid,
      processStartIdentity: 'same-process',
      state: 'alive',
    }),
    state: f.state,
  });
  const request = {
    kind: 'headless-run',
    operationId: 'reused-operation',
    target: { name: 'topic', repo: 'repo' },
  };
  const first = await admission.admit(request);
  expect(first.ok).toBe(true);
  await expect(admission.release(first.lease)).resolves.toEqual({ ok: true });
  tick = 2;
  const replacement = await admission.admit(request);
  expect(replacement.lease.acquiredAt).toBe(2);
  await expect(admission.release(first.lease)).resolves.toMatchObject({
    code: 'LEASE_MISMATCH',
    ok: false,
  });
  expect((await admission.status()).leases).toMatchObject([
    { acquiredAt: 2, operationId: 'reused-operation' },
  ]);
});

const spansBinding = Object.freeze({
  actionId: 'action-a',
  attemptId: 'attempt-a',
  generation: 3,
  runId: 'run-a',
  spanId: 'span-a',
  target: Object.freeze({ name: 'feat/a', repo: 'setu' }),
});

test('Spans admission binding is durable across a state-store close and reopen', async () => {
  const f = fixture();
  const request = {
    kind: 'headless-run',
    operationId: 'spans-admission',
    spansBinding,
    target: spansBinding.target,
  };
  const acquired = await f.admission().admit(request);
  expect(acquired.ok).toBe(true);
  expect(
    f.state.read('resourceAdmission').leases['spans-admission'].spansBinding
  ).toEqual(spansBinding);

  // Model a crash after reservation but before the action intent was recorded.
  const reopenedState = createWorkspaceState({
    configPath: join(f.root, 'config.json'),
    setuDir: f.root,
    workspaceRoot: f.root,
  });
  const reopened = createResourceAdmission({
    hostHealth: async () => ({ availableBytes: 30 * GiB, state: 'ready' }),
    limits: { lowStorageFloorBytes: 0 },
    now: () => 1235,
    observeProcess: async (pid) => ({
      processId: pid,
      processStartIdentity: `start-${pid}`,
      state: 'alive',
    }),
    state: reopenedState,
  });
  const status = await reopened.status();
  expect(status).toMatchObject({
    leases: [{ operationId: 'spans-admission', spansBinding }],
    ok: true,
  });
  await expect(reopened.admit(request)).resolves.toMatchObject({
    existing: true,
    ok: true,
  });
  expect((await reopened.status()).leases[0].owner).toEqual(
    acquired.lease.owner
  );
});

test('a Spans lease rejects missing, foreign, and malformed bindings on release or replay', async () => {
  const f = fixture();
  const request = {
    kind: 'headless-run',
    operationId: 'bound-operation',
    spansBinding,
    target: spansBinding.target,
  };
  const admission = f.admission();
  const acquired = await admission.admit(request);
  expect(acquired.ok).toBe(true);
  await expect(
    admission.admit({ ...request, spansBinding: undefined })
  ).resolves.toMatchObject({ code: 'INVALID_ADMISSION_REQUEST', ok: false });
  await expect(
    admission.admit({
      ...request,
      spansBinding: { ...spansBinding, generation: 4 },
    })
  ).resolves.toMatchObject({ code: 'OPERATION_ID_CONFLICT', ok: false });
  await expect(
    admission.admit({
      ...request,
      spansBinding: { ...spansBinding, unexpected: true },
    })
  ).resolves.toMatchObject({ code: 'INVALID_ADMISSION_REQUEST', ok: false });
  await expect(
    admission.admit({
      ...request,
      target: { name: 'topic', repo: 'another-repo' },
    })
  ).resolves.toMatchObject({ code: 'INVALID_ADMISSION_REQUEST', ok: false });
  await expect(
    admission.release({ ...acquired.lease, spansBinding: undefined })
  ).resolves.toMatchObject({ code: 'LEASE_MISMATCH', ok: false });
  await expect(
    admission.release({
      ...acquired.lease,
      spansBinding: { ...spansBinding, actionId: 'foreign-action' },
    })
  ).resolves.toMatchObject({ code: 'LEASE_MISMATCH', ok: false });
  expect((await admission.status()).leases).toHaveLength(1);
});

test('Spans binding targets must exactly match request and lease targets', async () => {
  const f = fixture();
  const admission = f.admission();
  const mismatchedBinding = {
    ...spansBinding,
    target: { name: 'other', repo: spansBinding.target.repo },
  };
  await expect(
    admission.admit({
      kind: 'headless-run',
      operationId: 'binding-target-mismatch',
      spansBinding: mismatchedBinding,
      target: spansBinding.target,
    })
  ).resolves.toMatchObject({ code: 'INVALID_ADMISSION_REQUEST', ok: false });
  expect(f.state.read('resourceAdmission')).toEqual({});

  const acquired = await admission.admit({
    kind: 'headless-run',
    operationId: 'binding-target-release-mismatch',
    spansBinding,
    target: spansBinding.target,
  });
  expect(acquired.ok).toBe(true);
  await expect(
    admission.release({
      ...acquired.lease,
      spansBinding: mismatchedBinding,
    })
  ).resolves.toMatchObject({ code: 'LEASE_MISMATCH', ok: false });

  const persisted = f.state.read('resourceAdmission');
  persisted.leases['binding-target-release-mismatch'].spansBinding =
    mismatchedBinding;
  await f.state.replace('resourceAdmission', persisted);
  await expect(admission.status()).resolves.toMatchObject({
    code: 'ADMISSION_STATE_UNKNOWN',
    ok: false,
  });
});

test('Spans binding and target validation rejects symbols, hidden keys, and accessors without invoking getters', async () => {
  const f = fixture();
  let getterCalls = 0;
  const accessorBinding = { ...spansBinding };
  Object.defineProperty(accessorBinding, 'runId', {
    enumerable: true,
    get() {
      getterCalls += 1;
      return spansBinding.runId;
    },
  });
  const hiddenBinding = { ...spansBinding };
  Object.defineProperty(hiddenBinding, 'hidden', {
    enumerable: false,
    value: true,
  });
  const symbolBinding = { ...spansBinding, [Symbol('extra')]: true };
  const accessorTarget = { ...spansBinding.target };
  Object.defineProperty(accessorTarget, 'repo', {
    enumerable: true,
    get() {
      getterCalls += 1;
      return spansBinding.target.repo;
    },
  });
  await Promise.all(
    [
      accessorBinding,
      hiddenBinding,
      symbolBinding,
      { ...spansBinding, target: accessorTarget },
    ].map(async (binding, index) =>
      expect(
        f.admission().admit({
          kind: 'headless-run',
          operationId: `invalid-binding-${index}`,
          spansBinding: binding,
          target: spansBinding.target,
        })
      ).resolves.toMatchObject({ code: 'INVALID_ADMISSION_REQUEST', ok: false })
    )
  );
  expect(getterCalls).toBe(0);
  expect(f.state.read('resourceAdmission')).toEqual({});
});

test('a reused pid with a different process start stays uncertain and cannot reuse its lease', async () => {
  const f = fixture();
  const request = {
    kind: 'install',
    operationId: 'pid-reused',
    target: { name: 'topic', repo: 'repo' },
  };
  const first = f.admission(undefined, async (pid) => ({
    processId: pid,
    processStartIdentity: 'first-start',
    state: 'alive',
  }));
  expect((await first.admit(request)).ok).toBe(true);
  const afterReuse = f.admission(undefined, async (pid) => ({
    processId: pid,
    processStartIdentity: 'replacement-start',
    state: 'alive',
  }));
  await expect(afterReuse.admit(request)).resolves.toMatchObject({
    code: 'LEASE_UNCERTAIN',
    ok: false,
  });
  await expect(afterReuse.status()).resolves.toMatchObject({
    leases: [{ operationId: 'pid-reused', ownership: 'uncertain' }],
    ok: true,
  });
});

function startInstallProcess(root, operationId, hold = false, binding = null) {
  const script = `
    import { createResourceAdmission } from ${JSON.stringify(
      new URL('./resource-admission.js', import.meta.url).href
    )};
    import { createWorkspaceState } from ${JSON.stringify(
      new URL('./workspace-state.js', import.meta.url).href
    )};
    const root = process.argv[1];
    const operationId = process.argv[2];
    const spansBinding = JSON.parse(process.argv[3] || 'null');
    const state = createWorkspaceState({ configPath: root + '/config.json', setuDir: root, workspaceRoot: root });
    const admission = createResourceAdmission({
      hostHealth: async () => ({ availableBytes: 30 * 1024 ** 3, state: 'ready' }),
      now: Date.now,
      observeProcess: async (pid) => ({ processId: pid, processStartIdentity: 'start-' + pid, state: 'alive' }),
      state,
    });
    const result = await admission.admit({ kind: 'install', operationId, target: spansBinding?.target ?? { repo: 'repo', name: 'topic' }, ...(spansBinding ? { spansBinding } : {}) });
    process.stdout.write(JSON.stringify(result) + '\\n');
    if (${hold ? 'true' : 'false'}) {
      await new Promise((resolve) => process.stdin.once('data', resolve));
    }
    if (result.ok) await admission.release(result.lease);
  `;
  const child = spawn(
    process.execPath,
    [
      '--eval',
      script,
      root,
      operationId,
      binding ? JSON.stringify(binding) : '',
    ],
    {
      stdio: ['pipe', 'pipe', 'pipe'],
    }
  );
  children.push(child);
  return new Promise((resolve, reject) => {
    let output = '',
      error = '';
    child.stdout.on('data', (chunk) => {
      output += chunk;
      const end = output.indexOf('\n');
      if (end >= 0) {
        resolve({ child, result: JSON.parse(output.slice(0, end)) });
      }
    });
    child.stderr.on('data', (chunk) => {
      error += chunk;
    });
    child.on('error', reject);
    child.on('exit', (code) => {
      if (!output.includes('\n')) {
        reject(new Error(`child exited ${code}: ${error}`));
      }
    });
  });
}

test('two real processes cannot both enter the shared install lane', async () => {
  const f = fixture();
  const first = await startInstallProcess(f.root, 'install-a', true);
  expect(first.result).toMatchObject({ ok: true });
  const second = await startInstallProcess(f.root, 'install-b');
  expect(second.result).toMatchObject({
    code: 'INSTALL_IN_PROGRESS',
    ok: false,
  });
  first.child.stdin.write('release\n');
});

test('operation idempotency belongs only to the process that acquired the lease', async () => {
  const f = fixture();
  const first = await startInstallProcess(f.root, 'same-operation', true);
  expect(first.result).toMatchObject({ ok: true });
  const second = await startInstallProcess(f.root, 'same-operation');
  expect(second.result).toMatchObject({
    code: 'LEASE_OWNED_BY_ANOTHER',
    ok: false,
  });
  first.child.stdin.write('release\n');
});

test('a dead owner remains visible as uncertain until its exact lease is recovered', async () => {
  const f = fixture();
  const dead = await startInstallProcess(f.root, 'dead-install', true);
  expect(dead.result).toMatchObject({ ok: true });
  const exited = new Promise((resolve) => dead.child.once('exit', resolve));
  dead.child.kill('SIGKILL');
  await exited;
  const restarted = f.admission();
  const status = await restarted.status();
  expect(status).toMatchObject({
    leases: [
      {
        operationId: 'dead-install',
        ownership: 'uncertain',
      },
    ],
    ok: true,
  });
  await expect(
    restarted.admit({
      kind: 'install',
      operationId: 'dead-install',
      target: { name: 'topic', repo: 'repo' },
    })
  ).resolves.toMatchObject({ code: 'LEASE_UNCERTAIN', ok: false });
  await expect(
    restarted.admit({
      kind: 'install',
      operationId: 'next-install',
      target: { name: 'next', repo: 'repo' },
    })
  ).resolves.toMatchObject({ code: 'INSTALL_IN_PROGRESS', ok: false });
  await expect(restarted.release(status.leases[0])).resolves.toEqual({
    ok: true,
  });
  await expect(
    restarted.admit({
      kind: 'install',
      operationId: 'next-install',
      target: { name: 'next', repo: 'repo' },
    })
  ).resolves.toMatchObject({ ok: true });
});

test('a crashed process leaves its binding and original owner durable before action intent', async () => {
  const f = fixture();
  const binding = {
    actionId: 'action-crashed',
    attemptId: 'attempt-crashed',
    generation: 7,
    runId: 'run-crashed',
    spanId: 'span-crashed',
    target: { name: 'topic', repo: 'repo' },
  };
  const child = await startInstallProcess(
    f.root,
    'spans-crashed',
    true,
    binding
  );
  expect(child.result).toMatchObject({
    lease: { spansBinding: binding },
    ok: true,
  });
  const originalOwner = child.result.lease.owner;
  const exited = new Promise((resolve) => child.child.once('exit', resolve));
  child.child.kill('SIGKILL');
  await exited;

  const restarted = f.admission();
  const status = await restarted.status();
  expect(status).toMatchObject({
    leases: [
      {
        operationId: 'spans-crashed',
        owner: originalOwner,
        ownership: 'uncertain',
        spansBinding: binding,
      },
    ],
    ok: true,
  });
  await expect(
    restarted.admit({
      kind: 'install',
      operationId: 'spans-crashed',
      spansBinding: binding,
      target: binding.target,
    })
  ).resolves.toMatchObject({ code: 'LEASE_UNCERTAIN', ok: false });
  expect((await restarted.status()).leases[0].owner).toEqual(originalOwner);
});

test('Spans shares an atomic two-worker ceiling across admission instances', async () => {
  const f = fixture();
  const authorities = [
    f.admission({ maxManagedSessions: 8 }),
    f.admission({ maxManagedSessions: 8 }),
  ];
  const requests = [0, 1, 2].map((index) => ({
    kind: 'headless-run',
    operationId: `spans-limit-${index}`,
    spansBinding: { ...spansBinding, attemptId: `attempt-${index}` },
    target: spansBinding.target,
  }));
  const results = await Promise.all(
    requests.map((request, index) => authorities[index % 2].admit(request))
  );
  expect(results.filter((result) => result.ok)).toHaveLength(2);
  expect(results.filter((result) => !result.ok)).toEqual([
    expect.objectContaining({ code: 'SESSION_CAPACITY_REACHED' }),
  ]);
  const ordinary = await authorities[0].admit({
    kind: 'session',
    operationId: 'ordinary-session',
    target: spansBinding.target,
  });
  expect(ordinary.ok).toBe(true);
  const admittedIndex = results.findIndex((result) => result.ok);
  expect(await authorities[1].admit(requests[admittedIndex])).toMatchObject({
    existing: true,
    ok: true,
  });
  expect((await authorities[0].release(results[admittedIndex].lease)).ok).toBe(
    true
  );
  const refusedIndex = results.findIndex((result) => !result.ok);
  expect((await authorities[1].admit(requests[refusedIndex])).ok).toBe(true);
});

const archiveBudget = 5 * GiB;
const archiveRequest = (
  f,
  operationId,
  reservedBytes,
  binding = spansBinding
) => ({
  kind: 'headless-run',
  operationId,
  spansArchiveReservation: {
    budgetBytes: archiveBudget,
    reservedBytes,
    root: f.root,
  },
  spansBinding: binding,
  target: binding.target,
});

test('ordinary admissions never inspect archive capacity', async () => {
  const f = fixture();
  let calls = 0;
  const admission = f.admission(undefined, undefined, () => {
    calls += 1;
    throw new Error('ordinary admission must not inspect archive');
  });
  await expect(
    admission.admit({
      kind: 'session',
      operationId: 'ordinary-no-archive',
      target: spansBinding.target,
    })
  ).resolves.toMatchObject({ ok: true });
  expect(calls).toBe(0);
});

test('shared admission serializes archive reservations and surfaces the 80% warning', async () => {
  const f = fixture();
  const inspected = [];
  const archiveCapacity = ({ root, budgetBytes }) => {
    inspected.push({ budgetBytes, root });
    return { ok: true, state: 'known', totalBytes: 4 * GiB };
  };
  const authorities = [
    f.admission({ maxManagedSessions: 8 }, undefined, archiveCapacity),
    f.admission({ maxManagedSessions: 8 }, undefined, archiveCapacity),
  ];
  const requests = [
    archiveRequest(f, 'archive-near-a', 500 * 1024 ** 2, {
      ...spansBinding,
      attemptId: 'archive-attempt-a',
    }),
    archiveRequest(f, 'archive-near-b', 700 * 1024 ** 2, {
      ...spansBinding,
      attemptId: 'archive-attempt-b',
    }),
  ];
  const results = await Promise.all(
    requests.map((request, index) => authorities[index].admit(request))
  );
  expect(results.filter((result) => result.ok)).toHaveLength(1);
  expect(results.filter((result) => !result.ok)).toMatchObject([
    { code: 'SPANS_ARCHIVE_CAPACITY_REACHED', ok: false },
  ]);
  expect(inspected).toEqual([
    { budgetBytes: archiveBudget, root: f.root },
    { budgetBytes: archiveBudget, root: f.root },
  ]);
  const accepted = results.find((result) => result.ok);
  expect(accepted.spansArchiveCapacity).toMatchObject({
    budgetBytes: archiveBudget,
    warning: true,
  });
  expect(accepted.lease.spansArchiveReservation).toEqual(
    requests[results.indexOf(accepted)].spansArchiveReservation
  );
  expect(Object.isFrozen(accepted.lease.spansArchiveReservation)).toBe(true);
  expect((await authorities[0].status()).leases[0]).toMatchObject({
    spansArchiveReservation: accepted.lease.spansArchiveReservation,
  });
  expect(
    f.state.read('resourceAdmission').leases[accepted.lease.operationId]
  ).not.toHaveProperty('measuredBytes');
});

test('archive reservation allows the exact budget boundary and rejects overflow', async () => {
  const f = fixture();
  const admission = f.admission(undefined, undefined, async () => ({
    ok: true,
    state: 'known',
    totalBytes: archiveBudget - 600,
  }));
  const exact = await admission.admit(archiveRequest(f, 'archive-exact', 600));
  expect(exact).toMatchObject({
    ok: true,
    spansArchiveCapacity: { totalWithCandidate: archiveBudget },
  });
  await admission.release(exact.lease);
  const tooLarge = await admission.admit(
    archiveRequest(f, 'archive-over', 601, {
      ...spansBinding,
      attemptId: 'attempt-over',
    })
  );
  expect(tooLarge).toMatchObject({
    code: 'SPANS_ARCHIVE_CAPACITY_REACHED',
    ok: false,
  });
});

test('unknown archive observations and safe-integer arithmetic overflow refuse without persisting', async () => {
  const f = fixture();
  const unknown = f.admission(undefined, undefined, () => ({
    ok: false,
    state: 'unknown',
    totalBytes: 0,
  }));
  await expect(
    unknown.admit(archiveRequest(f, 'archive-unknown', 10))
  ).resolves.toMatchObject({
    code: 'SPANS_ARCHIVE_CAPACITY_UNKNOWN',
    ok: false,
  });
  const overflow = f.admission(undefined, undefined, () => ({
    ok: true,
    state: 'known',
    totalBytes: Number.MAX_SAFE_INTEGER,
  }));
  await expect(
    overflow.admit(
      archiveRequest(f, 'archive-arithmetic-overflow', 10, {
        ...spansBinding,
        attemptId: 'attempt-overflow',
      })
    )
  ).resolves.toMatchObject({
    code: 'SPANS_ARCHIVE_CAPACITY_UNKNOWN',
    ok: false,
  });
  expect(f.state.read('resourceAdmission')).toEqual({});
});

test('archive reservations reject malformed roots, amounts, budget, accessors, symbols, and missing binding', async () => {
  const f = fixture();
  let calls = 0;
  const admission = f.admission(undefined, undefined, () => {
    calls += 1;
    return { ok: true, state: 'known', totalBytes: 0 };
  });
  const base = archiveRequest(f, 'invalid-reservation', 10);
  const accessor = { ...base.spansArchiveReservation };
  Object.defineProperty(accessor, 'reservedBytes', {
    enumerable: true,
    get() {
      throw new Error('getter must not run');
    },
  });
  const accessorRequest = { ...base, operationId: 'outer-accessor' };
  Object.defineProperty(accessorRequest, 'spansArchiveReservation', {
    enumerable: true,
    get() {
      throw new Error('outer getter must not run');
    },
  });
  const invalidReservations = [
    { ...base.spansArchiveReservation, root: `${f.root}/../other` },
    { ...base.spansArchiveReservation, root: `${f.root}\n` },
    { ...base.spansArchiveReservation, reservedBytes: 0 },
    {
      ...base.spansArchiveReservation,
      reservedBytes: Number.MAX_SAFE_INTEGER + 1,
    },
    { ...base.spansArchiveReservation, budgetBytes: archiveBudget - 1 },
    { ...base.spansArchiveReservation, extra: true },
    { ...base.spansArchiveReservation, [Symbol('extra')]: true },
    accessor,
  ];
  await Promise.all(
    invalidReservations.map((reservation, index) =>
      expect(
        admission.admit({
          ...base,
          operationId: `invalid-reservation-${index}`,
          spansArchiveReservation: reservation,
        })
      ).resolves.toMatchObject({
        code: 'INVALID_ADMISSION_REQUEST',
        ok: false,
      })
    )
  );
  await expect(admission.admit(accessorRequest)).resolves.toMatchObject({
    code: 'INVALID_ADMISSION_REQUEST',
    ok: false,
  });
  await expect(
    admission.admit({
      ...base,
      operationId: 'reservation-without-binding',
      spansBinding: undefined,
    })
  ).resolves.toMatchObject({ code: 'INVALID_ADMISSION_REQUEST', ok: false });
  expect(calls).toBe(0);
  expect(f.state.read('resourceAdmission')).toEqual({});
});

test('archive reservations survive reopen with uncertain owners and exact release proof', async () => {
  const f = fixture();
  const capacity = async () => ({ ok: true, state: 'known', totalBytes: 0 });
  const admission = f.admission(undefined, undefined, capacity);
  const reserved = await admission.admit(
    archiveRequest(f, 'archive-crashed', 700 * 1024 ** 2)
  );
  expect(reserved.ok).toBe(true);
  const reopenedState = createWorkspaceState({
    configPath: join(f.root, 'config.json'),
    setuDir: f.root,
    workspaceRoot: f.root,
  });
  const restarted = createResourceAdmission({
    archiveCapacity: async () => ({
      ok: true,
      state: 'known',
      totalBytes: archiveBudget - 1024 ** 3,
    }),
    hostHealth: async () => ({ availableBytes: 30 * GiB, state: 'ready' }),
    now: () => 1235,
    observeProcess: async (pid) =>
      pid === process.pid
        ? {
            processId: pid,
            processStartIdentity: `restarted-start-${pid}`,
            state: 'alive',
          }
        : { state: 'absent' },
    state: reopenedState,
  });
  await expect(restarted.status()).resolves.toMatchObject({
    leases: [
      {
        operationId: 'archive-crashed',
        ownership: 'uncertain',
        spansArchiveReservation: reserved.lease.spansArchiveReservation,
      },
    ],
    ok: true,
  });
  await expect(
    restarted.admit(
      archiveRequest(f, 'archive-next', 400 * 1024 ** 2, {
        ...spansBinding,
        attemptId: 'attempt-next',
      })
    )
  ).resolves.toMatchObject({
    code: 'SPANS_ARCHIVE_CAPACITY_REACHED',
    ok: false,
  });
  await expect(
    restarted.release({
      ...reserved.lease,
      spansArchiveReservation: {
        ...reserved.lease.spansArchiveReservation,
        reservedBytes: 699 * 1024 ** 2,
      },
    })
  ).resolves.toMatchObject({ code: 'LEASE_MISMATCH', ok: false });
  await expect(
    restarted.release({
      ...reserved.lease,
      spansArchiveReservation: {
        ...reserved.lease.spansArchiveReservation,
        root: `${f.root}/foreign`,
      },
    })
  ).resolves.toMatchObject({ code: 'LEASE_MISMATCH', ok: false });
  expect((await restarted.status()).leases).toHaveLength(1);
  await expect(restarted.release(reserved.lease)).resolves.toEqual({
    ok: true,
  });
});

test('archive reservation replay requires the exact existing reservation', async () => {
  const f = fixture();
  const admission = f.admission(undefined, undefined, () => ({
    ok: true,
    state: 'known',
    totalBytes: 0,
  }));
  const request = archiveRequest(f, 'archive-replay', 100, spansBinding);
  const acquired = await admission.admit(request);
  expect(acquired.ok).toBe(true);
  await expect(
    admission.admit({
      ...request,
      spansArchiveReservation: {
        ...request.spansArchiveReservation,
        reservedBytes: 101,
      },
    })
  ).resolves.toMatchObject({ code: 'OPERATION_ID_CONFLICT', ok: false });
  await expect(admission.admit(request)).resolves.toMatchObject({
    existing: true,
    ok: true,
  });
  expect((await admission.status()).leases).toHaveLength(1);
});

test('archive write gate validates bounds and runs an unowned import only within capacity', async () => {
  const f = fixture();
  let measuredBytes = archiveBudget - 100;
  let calls = 0;
  const admission = f.admission(undefined, undefined, async () => ({
    ok: true,
    state: 'known',
    totalBytes: measuredBytes,
  }));
  const invalid = await admission.withSpansArchiveWrite(
    { maxBytes: 101, root: f.root },
    () => {
      calls += 1;
    }
  );
  expect(invalid).toMatchObject({
    code: 'SPANS_ARCHIVE_CAPACITY_REACHED',
    ok: false,
  });
  await expect(
    admission.withSpansArchiveWrite(
      { maxBytes: 0, root: f.root },
      () => undefined
    )
  ).resolves.toMatchObject({ code: 'SPANS_ARCHIVE_WRITE_INVALID', ok: false });
  await expect(
    admission.withSpansArchiveWrite(
      { maxBytes: archiveBudget + 1, root: f.root },
      () => undefined
    )
  ).resolves.toMatchObject({ code: 'SPANS_ARCHIVE_WRITE_INVALID', ok: false });
  await expect(
    admission.withSpansArchiveWrite(
      { maxBytes: 1, root: `${f.root}/..` },
      () => undefined
    )
  ).resolves.toMatchObject({ code: 'SPANS_ARCHIVE_WRITE_INVALID', ok: false });

  measuredBytes = archiveBudget - 100;
  const result = await admission.withSpansArchiveWrite(
    { maxBytes: 100, root: f.root },
    () => {
      calls += 1;
      return 'imported';
    }
  );
  expect(result).toMatchObject({
    ok: true,
    spansArchiveCapacity: { totalWithCandidate: archiveBudget },
    value: 'imported',
  });
  expect(calls).toBe(1);
  expect(f.state.read('resourceAdmission')).toEqual({});
});

test('archive write gate verifies the complete lease and retains it when the effect throws', async () => {
  const f = fixture();
  const admission = f.admission(undefined, undefined, () => ({
    ok: true,
    state: 'known',
    totalBytes: 0,
  }));
  const acquired = await admission.admit(
    archiveRequest(f, 'archive-write-lease', 1000)
  );
  expect(acquired.ok).toBe(true);
  const options = { lease: acquired.lease, maxBytes: 500, root: f.root };
  let calls = 0;
  const invalidOptionsList = [
    { ...options, lease: undefined },
    {
      ...options,
      lease: { ...acquired.lease, operationId: 'forged-operation' },
    },
    {
      ...options,
      lease: {
        ...acquired.lease,
        acquiredAt: acquired.lease.acquiredAt + 1,
      },
    },
    {
      ...options,
      lease: {
        ...acquired.lease,
        owner: { ...acquired.lease.owner, processStart: 'forged-owner' },
      },
    },
    {
      ...options,
      lease: {
        ...acquired.lease,
        spansBinding: { ...spansBinding, actionId: 'foreign-action' },
      },
    },
    {
      ...options,
      lease: {
        ...acquired.lease,
        spansArchiveReservation: {
          ...acquired.lease.spansArchiveReservation,
          reservedBytes: 900,
        },
      },
    },
  ];
  await Promise.all(
    invalidOptionsList.map(async (invalidOptions) => {
      await expect(
        admission.withSpansArchiveWrite(invalidOptions, () => {
          calls += 1;
        })
      ).resolves.toMatchObject({ code: 'LEASE_MISMATCH', ok: false });
    })
  );
  await expect(
    admission.withSpansArchiveWrite({ ...options, maxBytes: 1001 }, () => {
      calls += 1;
    })
  ).resolves.toMatchObject({ code: 'LEASE_MISMATCH', ok: false });
  expect(calls).toBe(0);

  const failure = new Error('fixture write failed');
  await expect(
    admission.withSpansArchiveWrite(options, () => {
      throw failure;
    })
  ).resolves.toMatchObject({
    code: 'SPANS_ARCHIVE_WRITE_UNKNOWN',
    ok: false,
    unknown: true,
  });
  expect((await admission.status()).leases).toHaveLength(1);
});

test('archive write gate refuses unknown capacity before invoking its effect', async () => {
  const f = fixture();
  const admission = f.admission(undefined, undefined, async () => ({
    ok: false,
    state: 'unknown',
  }));
  let calls = 0;
  await expect(
    admission.withSpansArchiveWrite({ maxBytes: 10, root: f.root }, () => {
      calls += 1;
    })
  ).resolves.toMatchObject({
    code: 'SPANS_ARCHIVE_CAPACITY_UNKNOWN',
    ok: false,
  });
  expect(calls).toBe(0);
});

test('serialized archive writes update measured usage before a waiting admission check', async () => {
  const f = fixture();
  let measuredBytes = 0;
  const archiveCapacity = async () => ({
    ok: true,
    state: 'known',
    totalBytes: measuredBytes,
  });
  const writer = f.admission(undefined, undefined, archiveCapacity);
  const admission = f.admission(undefined, undefined, archiveCapacity);
  let releaseEffect;
  const effectStarted = new Promise((resolve) => {
    releaseEffect = resolve;
  });
  let unblockEffect;
  const effectBarrier = new Promise((resolve) => {
    unblockEffect = resolve;
  });
  const write = writer.withSpansArchiveWrite(
    { maxBytes: archiveBudget - 100, root: f.root },
    async () => {
      releaseEffect();
      await effectBarrier;
      measuredBytes = archiveBudget - 100;
      return true;
    }
  );
  await effectStarted;
  const waitingAdmission = admission.admit(
    archiveRequest(f, 'admission-after-import', 101, {
      ...spansBinding,
      attemptId: 'attempt-after-import',
    })
  );
  unblockEffect();
  await expect(write).resolves.toMatchObject({ ok: true, value: true });
  await expect(waitingAdmission).resolves.toMatchObject({
    code: 'SPANS_ARCHIVE_CAPACITY_REACHED',
    ok: false,
  });
});

test('capture allowance is reserved for its lease and cannot be consumed by import', async () => {
  const f = fixture();
  let measuredBytes = 4 * GiB;
  const admission = f.admission(undefined, undefined, async () => ({
    ok: true,
    state: 'known',
    totalBytes: measuredBytes,
  }));
  const acquired = await admission.admit(
    archiveRequest(f, 'reserved-capture', 1 * GiB)
  );
  expect(acquired.ok).toBe(true);
  measuredBytes += 512 * 1024 ** 2;
  await expect(
    admission.withSpansArchiveWrite({ maxBytes: 1, root: f.root }, () => {
      throw new Error('import must not steal reserved capture capacity');
    })
  ).resolves.toMatchObject({
    code: 'SPANS_ARCHIVE_CAPACITY_REACHED',
    ok: false,
  });

  // Captured bytes are part of measurement; the lease's remaining allowance
  // is omitted only for this exact lease's bounded write.
  measuredBytes = 4 * GiB;
  await expect(
    admission.withSpansArchiveWrite(
      { lease: acquired.lease, maxBytes: 1 * GiB, root: f.root },
      () => 'capture'
    )
  ).resolves.toMatchObject({ ok: true, value: 'capture' });
});

test('legacy Spans leases without a root block budgeted work and archive writes', async () => {
  const f = fixture();
  const admission = f.admission(undefined, undefined, () => ({
    ok: true,
    state: 'known',
    totalBytes: 0,
  }));
  const acquired = await admission.admit(
    archiveRequest(f, 'legacy-spans', 100)
  );
  const document = f.state.read('resourceAdmission');
  const { spansArchiveReservation, ...legacyLease } =
    document.leases['legacy-spans'];
  document.leases['legacy-spans'] = legacyLease;
  await f.state.replace('resourceAdmission', document);
  await expect(
    admission.admit(
      archiveRequest(f, 'new-budgeted-spans', 100, {
        ...spansBinding,
        attemptId: 'attempt-new-budgeted',
      })
    )
  ).resolves.toMatchObject({
    code: 'SPANS_ARCHIVE_CAPACITY_UNKNOWN',
    ok: false,
  });
  await expect(
    admission.withSpansArchiveWrite(
      { maxBytes: 1, root: f.root },
      () => 'must not run'
    )
  ).resolves.toMatchObject({
    code: 'SPANS_ARCHIVE_CAPACITY_UNKNOWN',
    ok: false,
  });
  await expect(
    admission.withSpansArchiveWrite(
      { lease: acquired.lease, maxBytes: 1, root: f.root },
      () => 'must not run'
    )
  ).resolves.toMatchObject({
    code: 'SPANS_ARCHIVE_CAPACITY_UNKNOWN',
    ok: false,
  });
  expect(acquired.ok).toBe(true);
});

test('a trusted archive writer that exceeds its bound is unknown and keeps its reservation', async () => {
  const f = fixture();
  let bytes = 0;
  const admission = f.admission(undefined, undefined, () => ({
    ok: true,
    state: 'known',
    totalBytes: bytes,
  }));
  const acquired = await admission.admit(
    archiveRequest(f, 'write-over-bound', 1000)
  );
  expect(acquired.ok).toBe(true);
  expect(
    await admission.withSpansArchiveWrite(
      { lease: acquired.lease, maxBytes: 10, root: f.root },
      () => {
        bytes += 11;
      }
    )
  ).toMatchObject({
    code: 'SPANS_ARCHIVE_WRITE_UNKNOWN',
    ok: false,
    unknown: true,
  });
  expect((await admission.status()).leases).toHaveLength(1);
});

test('archive aliases share reservations and unknown roots cannot free reserved space', async () => {
  const f = fixture();
  const other = fixture();
  const archive = join(f.root, 'archive');
  fs.mkdirSync(archive, { mode: 0o700 });
  fs.symlinkSync(f.root, join(other.root, 'alias'));
  const alias = join(other.root, 'alias', 'archive');
  const admission = f.admission(undefined, undefined, async () => ({
    ok: true,
    state: 'known',
    totalBytes: 0,
  }));
  const request = archiveRequest(f, 'alias-owner', archiveBudget - 100);
  request.spansArchiveReservation.root = archive;
  expect((await admission.admit(request)).ok).toBe(true);
  let effects = 0;
  const refused = await admission.withSpansArchiveWrite(
    { maxBytes: 101, root: alias },
    () => {
      effects += 1;
    }
  );
  expect(refused).toMatchObject({
    code: 'SPANS_ARCHIVE_CAPACITY_REACHED',
    ok: false,
  });
  expect(effects).toBe(0);
  fs.renameSync(archive, join(f.root, 'moved'));
  const unknownRoot = await admission.withSpansArchiveWrite(
    { maxBytes: 101, root: other.root },
    () => {
      effects += 1;
    }
  );
  expect(unknownRoot).toMatchObject({
    code: 'SPANS_ARCHIVE_CAPACITY_REACHED',
    ok: false,
  });
  expect(effects).toBe(0);
});

async function seedRecoverableLease(state, overrides = {}) {
  const lease = {
    acquiredAt: 41,
    kind: 'install',
    operationId: 'recover-this',
    owner: { pid: 987_654, processStart: 'old-incarnation' },
    target: { name: 'topic', repo: 'repo' },
    ...overrides,
  };
  await state.replace('resourceAdmission', {
    leases: { [lease.operationId]: lease },
  });
  return lease;
}

function recoveryAdmission(state, oldObservation) {
  return createResourceAdmission({
    hostHealth: async () => ({ availableBytes: 0, state: 'unknown' }),
    observeProcess: async (pid) =>
      pid === process.pid
        ? {
            processId: pid,
            processStartIdentity: 'current-incarnation',
            state: 'alive',
          }
        : oldObservation(pid),
    state,
  });
}

test('recoverLease transfers one absent-owner lease without changing its identity or checking capacity', async () => {
  const f = fixture();
  const original = await seedRecoverableLease(f.state);
  let oldOwnerReads = 0;
  const admission = recoveryAdmission(f.state, () => {
    oldOwnerReads += 1;
    return { state: 'absent' };
  });

  const recovered = await admission.recoverLease(original);
  expect(recovered).toMatchObject({
    lease: {
      acquiredAt: original.acquiredAt,
      kind: original.kind,
      operationId: original.operationId,
      owner: { pid: process.pid, processStart: 'current-incarnation' },
      target: original.target,
    },
    ok: true,
  });
  expect(oldOwnerReads).toBe(2);
  expect(
    f.state.read('resourceAdmission').leases[original.operationId]
  ).toEqual({
    ...original,
    owner: recovered.lease.owner,
  });
  await expect(admission.recoverLease(recovered.lease)).resolves.toMatchObject({
    lease: recovered.lease,
    ok: true,
  });
});

test('recoverLease accepts a positively replaced prior PID incarnation', async () => {
  const f = fixture();
  const original = await seedRecoverableLease(f.state);
  let reads = 0;
  const admission = recoveryAdmission(f.state, (pid) => {
    reads += 1;
    return {
      processId: pid,
      processStartIdentity: 'new-incarnation',
      state: 'alive',
    };
  });
  await expect(admission.recoverLease(original)).resolves.toMatchObject({
    ok: true,
  });
  expect(reads).toBe(2);
});

test.each([
  [
    'same prior incarnation',
    (pid) => ({
      processId: pid,
      processStartIdentity: 'old-incarnation',
      state: 'alive',
    }),
  ],
  ['unknown prior owner', () => ({ state: 'unknown' })],
  [
    'unreadable prior owner',
    () => {
      throw new Error('probe failed');
    },
  ],
])(
  'recoverLease refuses %s and retains the exact lease',
  async (_label, observeOld) => {
    const f = fixture();
    const original = await seedRecoverableLease(f.state);
    const admission = recoveryAdmission(f.state, observeOld);
    await expect(admission.recoverLease(original)).resolves.toMatchObject({
      code: 'LEASE_OWNER_NOT_RECOVERABLE',
      ok: false,
    });
    expect(
      f.state.read('resourceAdmission').leases[original.operationId]
    ).toEqual(original);
  }
);

test('recoverLease rejects a stale exact identity and detects replacement during the serialized update', async () => {
  const f = fixture();
  const original = await seedRecoverableLease(f.state);
  const admission = recoveryAdmission(f.state, () => ({ state: 'absent' }));
  await expect(
    admission.recoverLease({ ...original, acquiredAt: 42 })
  ).resolves.toMatchObject({
    code: 'LEASE_MISMATCH',
    ok: false,
  });

  let updates = 0;
  const racingState = {
    read: (key) => f.state.read(key),
    update: (key, transform) => {
      updates += 1;
      if (updates === 1) {
        return f.state.update(key, (document) =>
          transform({
            ...document,
            leases: {
              ...document.leases,
              [original.operationId]: {
                ...original,
                acquiredAt: original.acquiredAt + 1,
              },
            },
          })
        );
      }
      return f.state.update(key, transform);
    },
  };
  const racing = recoveryAdmission(racingState, () => ({ state: 'absent' }));
  await expect(racing.recoverLease(original)).resolves.toMatchObject({
    code: 'LEASE_MISMATCH',
    ok: false,
  });
  expect(
    f.state.read('resourceAdmission').leases[original.operationId].acquiredAt
  ).toBe(42);
});
