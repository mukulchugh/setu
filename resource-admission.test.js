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
    admission: (limits, observer = observeProcess) =>
      createResourceAdmission({
        hostHealth,
        limits,
        now: () => 1234,
        observeProcess: observer,
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

  const low = fixture({ availableBytes: 19 * GiB }).admission();
  await expect(
    low.admit({
      kind: 'install',
      operationId: 'install-low',
      target: { name: 'topic', repo: 'repo' },
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

function startInstallProcess(root, operationId, hold = false) {
  const script = `
    import { createResourceAdmission } from ${JSON.stringify(
      new URL('./resource-admission.js', import.meta.url).href
    )};
    import { createWorkspaceState } from ${JSON.stringify(
      new URL('./workspace-state.js', import.meta.url).href
    )};
    const root = process.argv[1];
    const operationId = process.argv[2];
    const state = createWorkspaceState({ configPath: root + '/config.json', setuDir: root, workspaceRoot: root });
    const admission = createResourceAdmission({
      hostHealth: async () => ({ availableBytes: 30 * 1024 ** 3, state: 'ready' }),
      now: Date.now,
      observeProcess: async (pid) => ({ processId: pid, processStartIdentity: 'start-' + pid, state: 'alive' }),
      state,
    });
    const result = await admission.admit({ kind: 'install', operationId, target: { repo: 'repo', name: 'topic' } });
    process.stdout.write(JSON.stringify(result) + '\\n');
    if (${hold ? 'true' : 'false'}) {
      await new Promise((resolve) => process.stdin.once('data', resolve));
    }
    if (result.ok) await admission.release(result.lease);
  `;
  const child = spawn(process.execPath, ['--eval', script, root, operationId], {
    stdio: ['pipe', 'pipe', 'pipe'],
  });
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
