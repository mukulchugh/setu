import { expect, test } from 'bun:test';
import fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inspectCheckoutIdentity } from './checkout-identity.js';
import { assignPort } from './lib.js';
import {
  applyTunnelConfiguration,
  claimTunnelOwner,
  createRemovalRouting,
} from './removal-routing.js';
import { createWorkspaceState } from './workspace-state.js';
import { createWorktreeLifecycle } from './worktree-lifecycle.js';
import {
  createRemovalController,
  observeRemovalCheckout,
} from './worktree-removal.js';

const target = {
  key: 'repo/topic',
  name: 'topic',
  port: 3301,
  repo: 'repo',
  repoDir: '/isolated/repo.git',
  wtDir: '/isolated/repo/topic',
};
const identity = {
  admin: { birthtimeNs: '7', dev: '1', ino: '6' },
  adminPath: '/isolated/repo.git/worktrees/topic',
  checkout: { birthtimeNs: '3', dev: '1', ino: '2' },
  checkoutPath: target.wtDir,
  known: true,
  repository: { birthtimeNs: '5', dev: '1', ino: '4' },
  repositoryPath: target.repoDir,
};

function fixture(overrides = {}, documents) {
  const data = documents ?? {
    archive: [],
    ports: [
      {
        key: target.key,
        name: target.name,
        port: target.port,
        repo: target.repo,
      },
    ],
    removals: {},
  };
  const effects = [];
  const clone = (value) => structuredClone(value);
  const state = {
    read: (name) => clone(data[name]),
    async withWorkspace(_names, task) {
      return task({
        read: (name) => clone(data[name]),
        replace(name, value) {
          data[name] = clone(value);
          return { committed: true, reconciled: true, value: clone(value) };
        },
      });
    },
  };
  let observation = 'original';
  const deps = {
    admit: async (_target, task) =>
      task({
        stop: async () => {
          effects.push('stop');
          return { ok: true };
        },
      }),
    assertClean: async () => {
      effects.push('dirty-check');
    },
    capture: async () => ({
      archive: {
        branch: 'topic',
        label: 'Repo',
        name: 'topic',
        reason: 'manual',
        removedAt: 1000,
        repo: 'repo',
      },
      identity,
    }),
    cleanupRouting: async () => {
      effects.push('routing');
    },
    detachTunnel: async () => {
      effects.push('tunnel');
    },
    now: () => 1_000_000,
    observe: async () => ({ state: observation }),
    randomId: () => '00000000-0000-4000-8000-000000000001',
    removeGit: async () => {
      effects.push('git');
      observation = 'absent';
    },
    removeVolumes: async () => {
      effects.push('volumes');
    },
    serialize: (task) => task(),
    state,
    ...overrides,
  };
  return {
    controller: createRemovalController(deps),
    data,
    deps,
    effects,
    setObservation: (value) => {
      observation = value;
    },
  };
}

function failWrite(f, predicate, { after = false } = {}) {
  const original = f.deps.state.withWorkspace;
  f.deps.state.withWorkspace = (names, task) =>
    original(names, (scope) =>
      task({
        ...scope,
        replace(name, value) {
          if (!predicate(name, value)) {
            return scope.replace(name, value);
          }
          if (after) {
            return { ...scope.replace(name, value), reconciled: false };
          }
          throw Object.assign(new Error('simulated storage failure'), {
            code: 'ENOSPC',
            committed: false,
          });
        },
      })
    );
}

test('persisted tunnel stage retries owned teardown after the in-memory route disappeared', async () => {
  const routes = new Map([[target.key, { port: target.port }]]);
  let attempts = 0,
    allowExit = false;
  const routing = createRemovalRouting({
    removeTunnelRoute: async () => {
      attempts += 1;
      routes.delete(target.key);
      if (!allowExit) {
        throw new Error('Tunnel group absence unconfirmed');
      }
    },
  });
  const f = fixture({ detachTunnel: routing.detachTunnel });
  const first = await f.controller.remove(target);
  expect(first).toMatchObject({ ok: false, removed: false });
  expect(f.data.removals[first.operationId].attempting).toBe('tunnel');
  expect(routes.size).toBe(0);
  const retry = createRemovalController(f.deps);
  const stillUnknown = await retry.remove(target, {
    operationId: first.operationId,
  });
  expect(stillUnknown).toMatchObject({ ok: false, removed: false });
  expect(attempts).toBe(2);
  expect(f.effects).not.toContain('git');
  expect(f.data.ports).toHaveLength(1);
  allowExit = true;
  expect(
    await retry.remove(target, { operationId: first.operationId })
  ).toMatchObject({ ok: true, removed: true });
  expect(attempts).toBe(3);
  expect(f.effects.filter((effect) => effect === 'git')).toHaveLength(1);
});

test('failed hosts apply retains recovery and its port until exact retry confirms hosts and Caddy', async () => {
  let hostsReady = false,
    snippets = 1,
    refreshed = 0,
    cleared = 0;
  const routing = createRemovalRouting({
    fs: {
      lstat: async () => {
        if (!snippets) {
          throw Object.assign(new Error('absent'), { code: 'ENOENT' });
        }
        return { isFile: () => true, isSymbolicLink: () => false };
      },
      readFile: async () => `reverse_proxy localhost:${target.port}\n`,
      unlink: async () => {
        snippets -= 1;
      },
    },
    onRemoved: () => {
      cleared += 1;
    },
    reloadCaddy: async () => {
      refreshed += 1;
      return true;
    },
    removeTunnelRoute: () => {
      /* No side effect is needed in this fixture. */
      return Promise.resolve();
    },
    snippetPath: () => '/isolated/snippet',
    syncHosts: async () => hostsReady,
    withRouting: (task) => task(),
  });
  const f = fixture({ ...routing });
  const first = await f.controller.remove(target);
  expect(first).toMatchObject({
    code: 'REMOVAL_INCOMPLETE',
    ok: false,
    pendingSteps: ['routing', 'finalize'],
    removed: true,
  });
  expect(f.data.removals[first.operationId].port).toBe(target.port);
  expect(f.data.archive[0].removalComplete).toBeUndefined();
  expect([refreshed, cleared]).toEqual([0, 0]);
  hostsReady = true;
  expect(
    await createRemovalController(f.deps).remove(target, {
      operationId: first.operationId,
    })
  ).toMatchObject({ ok: true, removed: true });
  expect([snippets, refreshed, cleared]).toEqual([0, 1, 1]);
  expect(f.effects.filter((effect) => effect === 'git')).toHaveLength(1);
});

test('tunnel Caddy failure stops configuration before route launch', async () => {
  const effects = [];
  await expect(
    applyTunnelConfiguration(true, {
      addRoute: async () => {
        effects.push('add-route');
      },
      configure: async () => {
        effects.push('configure');
      },
      reload: () => Promise.resolve(false),
      removeRoute: () => {
        /* No side effect is needed in this fixture. */
        return Promise.resolve();
      },
    })
  ).rejects.toThrow('Caddy');
  expect(effects).toEqual(['configure']);
});

test('concurrent tunnel creates evict the previous owner before target setup admission', async () => {
  const routes = new Map(),
    effects = [];
  let chain = Promise.resolve(),
    admitted = false,
    releaseFirst,
    firstEntered;
  const firstGate = new Promise((resolve) => {
    releaseFirst = resolve;
  });
  const entered = new Promise((resolve) => {
    firstEntered = resolve;
  });
  const deps = {
    release: async (key) => {
      expect(admitted).toBe(false);
      effects.push(`release ${key}`);
      routes.delete(key);
      return { ok: true };
    },
    routes: () => routes.entries(),
    serialize: (task) => {
      const result = chain.then(task);
      chain = result.catch(() => {
        /* No side effect is needed in this fixture. */
      });
      return result;
    },
  };
  const create = (key) =>
    claimTunnelOwner(key, deps, async () => {
      admitted = true;
      effects.push(`create ${key}`);
      routes.set(key, { port: 3200 });
      if (key === 'r/first') {
        firstEntered();
        await firstGate;
      }
      admitted = false;
      return { ok: true };
    });
  const first = create('r/first');
  await entered;
  const second = create('r/second');
  releaseFirst();
  await Promise.all([first, second]);
  expect(effects).toEqual([
    'create r/first',
    'release r/first',
    'create r/second',
  ]);
  expect([...routes.keys()]).toEqual(['r/second']);
  deps.release = () => Promise.resolve({ code: 'TARGET_BUSY', ok: false });
  expect(await create('r/third')).toMatchObject({
    code: 'TARGET_BUSY',
    ok: false,
  });
  expect([...routes.keys()]).toEqual(['r/second']);
});

test('dirty rejection precedes persistence, runtime signals, volume removal and Git deletion', async () => {
  const f = fixture({
    assertClean: () => {
      return Promise.reject(new Error('dirty worktree'));
    },
  });
  expect(await f.controller.remove(target)).toMatchObject({
    ok: false,
    removed: false,
  });
  expect(f.effects).toEqual([]);
  expect(f.data.removals).toEqual({});
  expect(f.data.ports).toHaveLength(1);
});

test('an absent unregistered checkout skips clean and identity capture but clears registry and routing', async () => {
  const f = fixture({
    assertClean: async () => {
      throw new Error('must not inspect a missing checkout');
    },
    capture: async () => {
      throw new Error('must not capture a missing checkout');
    },
    observe: async (record) => ({
      state: record.identity?.absent ? 'absent' : 'unknown',
    }),
  });
  await expect(f.controller.remove(target)).resolves.toMatchObject({
    ok: true,
    removed: true,
  });
  expect(f.effects).toEqual(['routing']);
  expect(f.data.ports).toEqual([]);
});

test('a pending intact checkout can be cancelled, but an in-flight removal cannot', async () => {
  const f = fixture({
    removeVolumes: async () => {
      throw new Error('engine unavailable');
    },
  });
  const pending = await f.controller.remove(target);
  expect(pending).toMatchObject({ ok: false, removed: false });
  await expect(f.controller.cancel(pending.operationId)).resolves.toEqual({
    ok: true,
  });
  expect(f.data.removals).toEqual({});

  let release;
  const held = new Promise((resolve) => {
    release = resolve;
  });
  const active = fixture({
    removeVolumes: async () => held,
  });
  const running = active.controller.remove(target);
  while (!Object.keys(active.data.removals).length) {
    await Promise.resolve();
  }
  const operationId = Object.keys(active.data.removals)[0];
  await expect(active.controller.cancel(operationId)).resolves.toMatchObject({
    code: 'REMOVAL_IN_FLIGHT',
    ok: false,
  });
  release();
  await running;
});

test('a retry whose checkout vanished completes pending idempotent teardown', async () => {
  const f = fixture({
    removeVolumes: async () => {
      throw new Error('engine unavailable');
    },
  });
  const pending = await f.controller.remove(target);
  expect(pending).toMatchObject({ ok: false, removed: false });
  f.setObservation('absent');
  const retry = createRemovalController({
    ...f.deps,
    removeVolumes: async () => {
      f.effects.push('volumes');
    },
  });
  await expect(
    retry.remove(target, { operationId: pending.operationId })
  ).resolves.toMatchObject({ ok: true, removed: true });
  expect(f.effects).toContain('volumes');
  expect(f.effects).toContain('tunnel');
  expect(f.effects).toContain('routing');
});

test('successful removal orders teardown before Git, archives once, and writes final marker before clearing reservation', async () => {
  const f = fixture();
  const result = await f.controller.remove(target);
  expect(result).toMatchObject({ ok: true, pendingSteps: [], removed: true });
  expect(f.effects).toEqual([
    'dirty-check',
    'dirty-check',
    'stop',
    'volumes',
    'tunnel',
    'dirty-check',
    'git',
    'routing',
  ]);
  expect(f.data.archive).toHaveLength(1);
  expect(f.data.archive[0]).toMatchObject({
    operationId: result.operationId,
    removalComplete: true,
  });
  expect(f.data.ports).toEqual([]);
  expect(f.data.removals).toEqual({});
  f.setObservation('conflict');
  expect(
    await f.controller.remove(target, { operationId: result.operationId })
  ).toEqual(result);
  expect(f.effects.filter((effect) => effect === 'git')).toHaveLength(1);
});

test('routing failure reports removed and keeps its port reservation; reconstructed exact-ID retry never repeats Git', async () => {
  const f = fixture({ cleanupRouting: () => Promise.resolve(false) });
  const result = await f.controller.remove(target);
  expect(result).toMatchObject({
    code: 'REMOVAL_INCOMPLETE',
    ok: false,
    pendingSteps: ['routing', 'finalize'],
    removed: true,
  });
  expect(f.data.removals[result.operationId].port).toBe(3301);
  expect(f.data.ports).toEqual([]);
  expect(f.data.archive[0].removalComplete).toBeUndefined();
  const retry = fixture({}, f.data);
  retry.setObservation('absent');
  expect(
    (await retry.controller.remove(target, { operationId: result.operationId }))
      .ok
  ).toBe(true);
  expect(retry.effects).toEqual(['routing']);
  expect(f.data.archive).toHaveLength(1);
  expect(f.data.removals).toEqual({});
});

test('unknown post-Git observation reports uncertain deletion and keeps metadata for exact retry', async () => {
  const f = fixture();
  f.deps.removeGit = async () => {
    f.setObservation('unknown');
  };
  // Construct with the controlled failure dependency; importing does not perform recovery.
  const controller = createRemovalController(f.deps);
  const result = await controller.remove(target);
  expect(result).toMatchObject({
    code: 'REMOVAL_OUTCOME_UNKNOWN',
    ok: false,
    removed: null,
  });
  expect(Object.keys(f.data.removals)).toHaveLength(1);
  const retry = fixture(
    { observe: () => Promise.resolve({ state: 'missing-checkout' }) },
    f.data
  );
  expect(
    await retry.controller.remove(target, { operationId: result.operationId })
  ).toMatchObject({ code: 'REMOVAL_OUTCOME_UNKNOWN', removed: null });
  expect(retry.effects).toEqual([]);
});

test('unconfirmed Git process completion retains target admission even if checkout absence can be observed', async () => {
  let held = 0;
  const lifecycle = createWorktreeLifecycle({
    capacity: {},
    clock: { clearTimeout, now: () => 0, setTimeout },
    runtime: {
      stop: () => {
        /* No side effect is needed in this fixture. */
        return Promise.resolve();
      },
    },
    settings: {},
    validateTarget: () => {
      /* No side effect is needed in this fixture. */
      return Promise.resolve();
    },
    withTarget: async (_target, task) => {
      held += 1;
      try {
        return await task();
      } finally {
        held -= 1;
      }
    },
  });
  const f = fixture({
    admit: (target, task) => lifecycle.runOperation(target, 'remove', task),
  });
  f.deps.removeGit = async () => {
    f.setObservation('absent');
    throw Object.assign(new Error('exit observation failed'), {
      code: 'OPERATION_UNKNOWN',
    });
  };
  const controller = createRemovalController(f.deps);
  const result = await controller.remove(target);
  expect(result).toMatchObject({
    causeCode: 'OPERATION_UNKNOWN',
    code: 'REMOVAL_OUTCOME_UNKNOWN',
    ok: false,
    removed: null,
  });
  expect(held).toBe(1);
  expect(lifecycle.operationStatus(target.key)).toMatchObject({
    kind: 'remove',
    phase: 'unknown',
  });
  expect(f.data.removals[result.operationId].attempting).toBe('git');
  expect(f.data.archive).toHaveLength(0);
  expect(f.data.ports).toHaveLength(1);
});

test('prepare-only intent may be cleared for Start, but a begun volume step cannot be abandoned', async () => {
  const before = fixture({
    admit: async (_target, task) =>
      task({
        stop: () => Promise.resolve({ error: 'stop interrupted', ok: false }),
      }),
  });
  await before.controller.remove(target);
  await before.controller.assertCanMutate(target, { kind: 'start' });
  expect(before.data.removals).toEqual({});
  const after = fixture({
    removeVolumes: () => {
      return Promise.reject(new Error('volume result unknown'));
    },
  });
  await after.controller.remove(target);
  await expect(
    after.controller.assertCanMutate(target, { kind: 'start' })
  ).rejects.toMatchObject({ code: 'REMOVAL_PENDING' });
  expect(Object.keys(after.data.removals)).toHaveLength(1);
});

test('an explicit different operation ID cannot join an in-flight removal', async () => {
  let finish, entered;
  const held = new Promise((resolve) => {
    finish = resolve;
  });
  const started = new Promise((resolve) => {
    entered = resolve;
  });
  const f = fixture({
    removeVolumes: async () => {
      entered();
      await held;
    },
  });
  const removal = f.controller.remove(target);
  await started;
  const wrong = f.controller.remove(target, {
    operationId: '00000000-0000-4000-8000-000000000099',
  });
  finish();
  expect(await wrong).toMatchObject({ code: 'REMOVAL_NOT_FOUND', ok: false });
  expect((await removal).ok).toBe(true);
});

test('a retry requires current force permission and a same-path replacement blocks all effects', async () => {
  const f = fixture({
    removeVolumes: () => {
      return Promise.reject(new Error('volume unavailable'));
    },
  });
  const first = await f.controller.remove(target, { force: true });
  const retry = fixture(
    {
      assertClean: async (_target, force) => {
        if (!force) {
          throw new Error('dirty without current force');
        }
      },
    },
    f.data
  );
  expect(
    (await retry.controller.remove(target, { operationId: first.operationId }))
      .ok
  ).toBe(false);
  expect(retry.effects).toEqual([]);
  retry.setObservation('conflict');
  expect(
    await retry.controller.remove(target, {
      force: true,
      operationId: first.operationId,
    })
  ).toMatchObject({
    code: 'REMOVAL_IDENTITY_CHANGED',
    ok: false,
    removed: null,
  });
  expect(retry.effects).toEqual([]);
});

test('prepare write failure performs no destructive work; committed unreadable preparation retains its operation ID', async () => {
  const before = fixture();
  failWrite(before, (name) => name === 'removals');
  expect(await before.controller.remove(target)).toMatchObject({
    committed: false,
    ok: false,
    removed: false,
  });
  expect(before.effects).toEqual(['dirty-check']);
  expect(before.data.removals).toEqual({});
  const after = fixture();
  failWrite(after, (name) => name === 'removals', { after: true });
  const result = await after.controller.remove(target);
  expect(result).toMatchObject({
    committed: true,
    ok: false,
    operationId: '00000000-0000-4000-8000-000000000001',
    removed: false,
  });
  expect(after.effects).toEqual(['dirty-check']);
});

test('final archive marker failure and pending clear failure remain retryable without a second Git removal', async () => {
  for (const failure of ['marker', 'clear']) {
    const f = fixture();
    failWrite(f, (name, value) =>
      failure === 'marker'
        ? name === 'archive' && value[0]?.removalComplete === true
        : name === 'removals' && Object.keys(value).length === 0
    );
    const result = await f.controller.remove(target);
    expect(result).toMatchObject({
      ok: false,
      pendingSteps: ['finalize'],
      removed: true,
    });
    expect(Object.keys(f.data.removals)).toHaveLength(1);
    expect(f.data.archive[0].removalComplete === true).toBe(
      failure === 'clear'
    );
    const conflict = fixture(
      { observe: () => Promise.resolve({ state: 'conflict' }) },
      f.data
    );
    expect(
      await conflict.controller.remove(target, {
        operationId: result.operationId,
      })
    ).toMatchObject({ code: 'REMOVAL_IDENTITY_CHANGED', ok: false });
    expect(conflict.effects).toEqual([]);
    const retry = fixture({}, f.data);
    retry.setObservation('absent');
    expect(
      (
        await retry.controller.remove(target, {
          operationId: result.operationId,
        })
      ).ok
    ).toBe(true);
    expect(retry.effects).toEqual([]);
    expect(f.data.archive).toHaveLength(1);
  }
});

test('real state allocation cannot reuse the removed port while routing cleanup is pending', async () => {
  const root = await fs.mkdtemp(join(tmpdir(), 'setu-removal-state-'));
  try {
    const state = createWorkspaceState({
      configPath: join(root, 'config.json'),
      setuDir: root,
      workspaceRoot: root,
    });
    await state.replace('ports', [
      {
        key: target.key,
        name: target.name,
        port: target.port,
        repo: target.repo,
      },
    ]);
    let finish, enter;
    const held = new Promise((resolve) => {
      finish = resolve;
    });
    const entered = new Promise((resolve) => {
      enter = resolve;
    });
    const f = fixture({
      cleanupRouting: async () => {
        enter();
        await held;
      },
      state,
    });
    const removal = f.controller.remove(target);
    await entered;
    const probe = async () =>
      new Set(Array.from({ length: 101 }, (_, i) => 3200 + i));
    expect(await assignPort(root, 'repo', 'second', { probe, state })).toBe(
      3302
    );
    finish();
    expect((await removal).ok).toBe(true);
    expect(await assignPort(root, 'repo', 'third', { probe, state })).toBe(
      3301
    );
    expect(state.read('removals')).toEqual({});
  } finally {
    await fs.rm(root, { force: true, recursive: true });
  }
});

test('production observation distinguishes original, replacement, absent checkout registration and complete absence', async () => {
  const root = await fs.mkdtemp(join(tmpdir(), 'setu-removal-observation-'));
  try {
    const repoDir = join(root, 'repo.git'),
      wtDir = join(root, 'repo', 'topic'),
      admin = join(repoDir, 'worktrees', 'topic');
    await fs.mkdir(admin, { recursive: true });
    await fs.mkdir(wtDir, { recursive: true });
    await fs.writeFile(join(wtDir, '.git'), `gitdir: ${admin}\n`);
    await fs.writeFile(join(admin, 'commondir'), '../..\n');
    await fs.writeFile(join(admin, 'gitdir'), `${wtDir}/.git\n`);
    const t = { ...target, repoDir, wtDir },
      record = { identity: await inspectCheckoutIdentity(t, fs) };
    let registered = true;
    const run = async () => ({
      code: 0,
      stdout: registered
        ? `worktree ${wtDir}\0branch refs/heads/topic\0\0`
        : '',
    });
    expect(await observeRemovalCheckout(record, t, { fs, run })).toEqual({
      state: 'original',
    });
    await fs.rename(wtDir, `${wtDir}-original`);
    expect(await observeRemovalCheckout(record, t, { fs, run })).toEqual({
      state: 'missing-checkout',
    });
    await fs.mkdir(wtDir);
    await fs.writeFile(join(wtDir, '.git'), `gitdir: ${admin}\n`);
    expect(await observeRemovalCheckout(record, t, { fs, run })).toEqual({
      state: 'conflict',
    });
    await fs.rm(wtDir, { recursive: true });
    await fs.rm(admin, { recursive: true });
    registered = false;
    expect(await observeRemovalCheckout(record, t, { fs, run })).toEqual({
      state: 'absent',
    });
  } finally {
    await fs.rm(root, { force: true, recursive: true });
  }
});

test('absent-identity observation accepts a registry row when both checkout and bare repository are gone', async () => {
  const root = await fs.mkdtemp(join(tmpdir(), 'setu-removal-gone-'));
  try {
    const t = {
      ...target,
      repoDir: join(root, 'missing.git'),
      wtDir: join(root, 'missing', 'topic'),
    };
    await expect(
      observeRemovalCheckout({ identity: { absent: true } }, t, {
        fs,
        run: async () => {
          throw new Error('git must not be invoked when the bare repository is gone');
        },
      })
    ).resolves.toEqual({ state: 'absent' });
  } finally {
    await fs.rm(root, { force: true, recursive: true });
  }
});

test('persisted identity key order does not turn an unchanged incarnation into a conflict', async () => {
  // Keep the old on-disk ordering literal: formatters must not rewrite this fixture.
  const oldIdentity = JSON.parse('{"known":true,"checkoutPath":"/isolated/repo/topic","repositoryPath":"/isolated/repo.git","adminPath":"/isolated/repo.git/worktrees/topic","checkout":{"dev":"1","ino":"2","birthtimeNs":"3"},"repository":{"dev":"1","ino":"4","birthtimeNs":"5"},"admin":{"dev":"1","ino":"6","birthtimeNs":"7"}}');
  const directory = (path) => {
    const value = path === target.repoDir ? oldIdentity.repository : path === target.wtDir ? oldIdentity.checkout : oldIdentity.admin;
    return { dev: BigInt(value.dev), ino: BigInt(value.ino), birthtimeNs: BigInt(value.birthtimeNs), isDirectory: () => true, isSymbolicLink: () => false };
  };
  const files = {
    realpath: (path) => Promise.resolve(path),
    stat: (path) => Promise.resolve(directory(path)),
    lstat: (path) => Promise.resolve(directory(path)),
    readFile: (path) => Promise.resolve(path === `${target.wtDir}/.git` ? `gitdir: ${oldIdentity.adminPath}\n` : path === `${oldIdentity.adminPath}/gitdir` ? `${target.wtDir}/.git\n` : '../..\n'),
  };
  const run = () => Promise.resolve({ code: 0, stdout: `worktree ${target.wtDir}\0\0` });
  expect(await observeRemovalCheckout({ identity: oldIdentity }, target, { fs: files, run })).toEqual({ state: 'original' });
  for (const part of ['checkout', 'repository', 'admin']) {
    for (const field of ['dev', 'ino', 'birthtimeNs']) {
      const changed = structuredClone(oldIdentity);
      changed[part][field] = '999';
      expect(await observeRemovalCheckout({ identity: changed }, target, { fs: files, run })).toEqual({ state: 'conflict' });
    }
  }
});

test('archive updates preserve the legacy chronological order and cap', async () => {
  const f = fixture();
  f.data.archive = Array.from({ length: 500 }, (_, index) => ({
    name: String(index),
    removedAt: index,
    repo: 'older',
  }));
  const result = await f.controller.remove(target);
  expect(result.ok).toBe(true);
  expect(f.data.archive).toHaveLength(500);
  expect(f.data.archive[0].name).toBe('1');
  expect(f.data.archive.at(-1)).toMatchObject({
    operationId: result.operationId,
    removalComplete: true,
  });
});

test('Git receives only the force choice on this destructive request', async () => {
  for (const force of [false, true]) {
    const values = [],
      f = fixture();
    const controller = createRemovalController({
      ...f.deps,
      removeGit: async (_record, currentForce) => {
        values.push(currentForce);
        f.setObservation('absent');
      },
    });
    expect((await controller.remove(target, { force })).ok).toBe(true);
    expect(values).toEqual([force]);
  }
});
