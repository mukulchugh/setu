import { expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { renderDockerCompose } from './dev-runtime.js';
import { createWorktreeLifecycle } from './worktree-lifecycle.js';
import { createWorkspaceState } from './workspace-state.js';

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, reject, resolve };
}

const target = (name) => ({
  key: `repo/${name}`,
  name,
  port: 3300 + name.charCodeAt(0),
  repo: 'repo',
  repoDir: '/isolated/repo.git',
  wtDir: `/isolated/repo/${name}`,
});

function fixture(options = {}) {
  const running = new Map();
  const launches = [];
  const stops = [];
  const runtime = {
    async launch(t, spec, register, options) {
      const exit = deferred();
      const handle = {
        exit,
        exited: exit.promise,
        ownedGroup: true,
        pid: 100 + launches.length,
        state: 'alive',
      };
      launches.push({ handle, options, spec, target: t });
      running.set(t.key, handle);
      register(handle);
      return { skippedSidecars: [] };
    },
    async observe(_target, handle) {
      return handle?.state ?? 'dead';
    },
    async stop(t, handle, options) {
      stops.push({ handle, options, target: t });
      if (handle) {
        handle.state = 'dead';
        handle.exit?.resolve(0);
      }
      running.delete(t.key);
    },
    ...options.runtime,
  };
  const timers = new Map();
  let now = 0,
    timerId = 0;
  const clock = {
    clearTimeout(id) {
      timers.delete(id);
    },
    now: () => now,
    setTimeout(fn, delay) {
      timerId += 1;
      const id = timerId;
      timers.set(id, { at: now + delay, fn });
      return id;
    },
  };
  const capacity = {
    refresh: () => Promise.resolve({ available: true, cpus: 4, memMb: 8192 }),
    ...options.capacity,
  };
  const lifecycle = createWorktreeLifecycle({
    capacity,
    clock,
    runtime,
    settings: {
      containerMemoryLimit: '1g',
      maxConcurrentDevServers: 1,
      ...options.settings,
    },
    validateTarget: () => Promise.resolve(true),
    ...options.controller,
  });
  return {
    async advance(ms) {
      now += ms;
      for (const [id, timer] of [...timers]) {
        if (timer.at <= now) {
          timers.delete(id);
          await timer.fn();
        }
      }
    },
    launches,
    lifecycle,
    running,
    runtime,
    stops,
    timers,
  };
}

test('a booting worktree owns one slot until all teardown finishes', async () => {
  const f = fixture();
  const teardown = deferred();
  const originalStop = f.runtime.stop;
  f.runtime.stop = async (...args) => {
    await originalStop(...args);
    await teardown.promise;
  };
  expect((await f.lifecycle.start(target('a'), false)).ok).toBe(true);
  expect((await f.lifecycle.start(target('a'), false)).ok).toBe(false);
  expect((await f.lifecycle.start(target('b'), false)).queued).toBe(true);
  const stopping = f.lifecycle.stop(target('a'));
  expect(f.lifecycle.snapshot('repo/a').phase).toBe('stopping');
  expect(f.lifecycle.status().active).toBe(1);
  expect(f.running.has('repo/b')).toBe(false);
  teardown.resolve();
  await stopping;
  expect(f.lifecycle.status().active).toBe(1);
  expect(f.running.has('repo/b')).toBe(true);
  expect(f.lifecycle.snapshot('repo/a').phase).toBe('stopped');
});

test('accepted background setup retains admission until its actual completion', async () => {
  const f = fixture();
  const completion = deferred();
  expect(
    await f.lifecycle.startOperation(target('a'), 'setup', async () => ({
      completion: completion.promise,
      result: { installing: true, ok: true },
    }))
  ).toEqual({ installing: true, ok: true });
  expect(
    (
      await f.lifecycle.runOperation(target('a'), 'remove', () =>
        Promise.resolve({
          ok: true,
        })
      )
    ).code
  ).toBe('TARGET_BUSY');
  const paused = f.lifecycle.quiesce();
  expect(paused.ok).toBe(false);
  completion.resolve();
  await f.lifecycle.waitForOperation(target('a'));
  await f.lifecycle.reopen(paused.token, { coherent: true });
  expect(
    (
      await f.lifecycle.runOperation(target('a'), 'remove', () =>
        Promise.resolve({
          ok: true,
        })
      )
    ).ok
  ).toBe(true);
});

test('an unconfirmed background process outcome retains admission and blocks cutover', async () => {
  const f = fixture(),
    completion = deferred();
  await f.lifecycle.startOperation(target('a'), 'setup', async () => ({
    completion: completion.promise,
    result: { ok: true },
  }));
  completion.reject(
    Object.assign(new Error('setup exit unconfirmed'), {
      code: 'OPERATION_UNKNOWN',
    })
  );
  await f.lifecycle.waitForOperation(target('a'));
  expect(
    (
      await f.lifecycle.runOperation(target('a'), 'remove', () =>
        Promise.resolve({
          ok: true,
        })
      )
    ).code
  ).toBe('TARGET_BUSY');
  expect(f.lifecycle.operationStatus('repo/a')).toMatchObject({
    kind: 'setup',
    phase: 'unknown',
  });
  expect(f.lifecycle.quiesce().ok).toBe(false);
});

test('unknown background ownership retains its cooperating-writer lock while returning a bounded outcome', async () => {
  let held = 0;
  const f = fixture({
    controller: {
      withTarget: async (_target, task) => {
        held += 1;
        try {
          return await task();
        } finally {
          held -= 1;
        }
      },
    },
  });
  const completion = deferred();
  await f.lifecycle.startOperation(target('a'), 'setup', async () => ({
    completion: completion.promise,
    result: { ok: true },
  }));
  completion.reject(
    Object.assign(new Error('exit observation failed'), {
      code: 'OPERATION_UNKNOWN',
    })
  );
  expect((await f.lifecycle.waitForOperation(target('a'))).code).toBe(
    'OPERATION_UNKNOWN'
  );
  expect(held).toBe(1);
  expect(f.lifecycle.quiesce().ok).toBe(false);
});

test('a dequeued target reserves its slot while asynchronous revalidation is pending', async () => {
  const gate = deferred(),
    entered = deferred();
  let bChecks = 0;
  const f = fixture({
    controller: {
      validateTarget: async (t) => {
        if (t.name !== 'b') {
          return;
        }
        bChecks += 1;
        if (bChecks === 2) {
          entered.resolve();
          await gate.promise;
        }
      },
    },
  });
  await f.lifecycle.start(target('a'), false);
  await f.lifecycle.start(target('b'), false);
  const stop = f.lifecycle.stop(target('a'));
  await entered.promise;
  expect((await f.lifecycle.start(target('c'), false)).queued).toBe(true);
  gate.resolve();
  await stop;
  expect(f.lifecycle.status().active).toBe(1);
  expect(f.launches.map((item) => item.target.name)).toEqual(['a', 'b']);
});

test('Stop during restart configuration cancels relaunch and an old exit cannot clear a replacement', async () => {
  const f = fixture(),
    gate = deferred(),
    entered = deferred();
  await f.lifecycle.start(target('a'), false);
  const old = f.launches[0].handle;
  const restarting = f.lifecycle.restart(target('a'), async () => {
    entered.resolve();
    await gate.promise;
  });
  await entered.promise;
  const stopping = f.lifecycle.stop(target('a'));
  gate.resolve();
  await Promise.all([restarting, stopping]);
  expect(f.launches).toHaveLength(1);
  expect(f.lifecycle.status().active).toBe(0);
  await f.lifecycle.start(target('a'), false);
  const replacement = f.lifecycle.snapshot('repo/a');
  old.exit.resolve(0);
  await f.lifecycle.reconcile('repo/a', replacement.generation - 1);
  expect(f.lifecycle.snapshot('repo/a').generation).toBe(
    replacement.generation
  );
  expect(f.lifecycle.status().active).toBe(1);
});

test('VM shrink refuses restart before tearing down the previously admitted container', async () => {
  let cpus = 4;
  const f = fixture({
    capacity: { refresh: async () => ({ available: true, cpus, memMb: 8192 }) },
  });
  await f.lifecycle.start(target('a'), true);
  cpus = 1;
  expect((await f.lifecycle.restart(target('a'))).code).toBe(
    'RESTART_CAPACITY_UNAVAILABLE'
  );
  expect(f.running.has('repo/a')).toBe(true);
  expect(f.launches).toHaveLength(1);
  expect(f.lifecycle.snapshot('repo/a').limits.cpus).toBe(2);
});

test('failure after spawn retains the registered handle and a failed Stop keeps the queue blocked', async () => {
  const f = fixture();
  const launch = f.runtime.launch;
  f.runtime.launch = async (...args) => {
    await launch(...args);
    throw new Error('sidecar startup failed');
  };
  expect((await f.lifecycle.start(target('a'), false)).ok).toBe(false);
  expect(f.lifecycle.snapshot('repo/a')).toMatchObject({
    phase: 'unknown',
    reserved: true,
  });
  expect((await f.lifecycle.start(target('b'), false)).queued).toBe(true);
  const stop = f.runtime.stop;
  f.runtime.stop = () => {
    return Promise.reject(new Error('exit unknown'));
  };
  expect((await f.lifecycle.stop(target('a'))).ok).toBe(false);
  expect(f.lifecycle.status().active).toBe(1);
  expect(f.running.has('repo/b')).toBe(false);
  f.runtime.stop = stop;
  f.runtime.launch = launch;
  await f.lifecycle.stop(target('a'));
  expect(f.running.has('repo/b')).toBe(true);
});

test('a main Stop confirmed dead releases the slot despite sidecar warnings', async () => {
  const f = fixture({
    runtime: {
      async stop(t, handle) {
        handle.state = 'dead';
        handle.exit.resolve(0);
        f.running.delete(t.key);
        return { warnings: ['Inngest could not stop'] };
      },
    },
  });
  await f.lifecycle.start(target('a'), false);
  await f.lifecycle.start(target('b'), false);
  await expect(f.lifecycle.stop(target('a'))).resolves.toEqual({
    ok: true,
    warnings: ['Inngest could not stop'],
  });
  expect(f.lifecycle.snapshot('repo/a')).toMatchObject({
    phase: 'stopped',
    reserved: false,
  });
  expect(f.running.has('repo/b')).toBe(true);
});

test('restart validation failure restores the running phase without Stop', async () => {
  const f = fixture({
    controller: {
      validateTarget: async (_target, { kind }) => {
        if (kind === 'restart') {
          throw new Error('target changed');
        }
      },
    },
  });
  await f.lifecycle.start(target('a'), false);
  await f.lifecycle.reconcile(
    'repo/a',
    f.lifecycle.snapshot('repo/a').generation
  );
  const handle = f.running.get('repo/a');
  await expect(f.lifecycle.restart(target('a'))).resolves.toMatchObject({
    code: 'RESTART_FAILED',
    ok: false,
  });
  expect(f.running.get('repo/a')).toBe(handle);
  expect(f.lifecycle.snapshot('repo/a')).toMatchObject({
    phase: 'running',
    reserved: true,
  });
});

test('restart leaves sidecars alone while ordinary starts retain sidecar behavior', async () => {
  const f = fixture();
  await f.lifecycle.start(target('a'), false);
  await f.lifecycle.restart(target('a'));
  expect(f.stops[0].options).toEqual({ sidecars: false });
  expect(f.launches[0].options).toBeUndefined();
  expect(f.launches[1].options).toEqual({ sidecars: false });
});

test('a failed restart update releases confirmed-dead ownership and launches the FIFO waiter', async () => {
  const f = fixture();
  await f.lifecycle.start(target('a'), false);
  await f.lifecycle.reconcile(
    'repo/a',
    f.lifecycle.snapshot('repo/a').generation
  );
  await f.lifecycle.start(target('b'), false);
  const result = await f.lifecycle.restart(target('a'), () => {
    return Promise.reject(new Error('environment write failed'));
  });
  expect(result).toMatchObject({ code: 'RESTART_FAILED', ok: false });
  expect(f.lifecycle.snapshot('repo/a')).toMatchObject({
    phase: 'running',
    reserved: true,
  });
  expect(f.running.has('repo/a')).toBe(true);
  expect(f.running.has('repo/b')).toBe(false);
  expect(f.launches.map((item) => item.target.name)).toEqual(['a']);
  expect((await f.lifecycle.start(target('a'), false)).code).toBe(
    'ALREADY_RUNNING'
  );
});

test('restart retains admitted limits in both resource ledger and rendered Compose after settings change', async () => {
  const f = fixture({ settings: { maxConcurrentDevServers: 3 } });
  await f.lifecycle.start(target('a'), true);
  await f.lifecycle.start(target('b'), true);
  await f.lifecycle.updateSettings({
    containerCpuLimit: 4,
    containerMemoryLimit: '1g',
    maxConcurrentDevServers: 3,
  });
  expect((await f.lifecycle.restart(target('a'))).ok).toBe(true);
  const spec = f.lifecycle.snapshot('repo/a').launchSpec;
  expect(spec.limits.cpus).toBe(2);
  expect(f.lifecycle.status().container.cpus).toBe(4);
  const yaml = renderDockerCompose(spec, {
    cacheDir: '/fixture/cache',
    env: {},
    wtDir: '/fixture/a',
  });
  expect(yaml).toContain('cpus: "2"');
  expect(yaml).toContain('mem_limit: "1024m"');
  await f.lifecycle.stop(target('a'));
  expect((await f.lifecycle.start(target('a'), true)).queued).toBe(true);
});

test('queued container capacity recovers with zero readers and no timer after the queue empties', async () => {
  let available = true,
    probes = 0;
  const f = fixture({
    capacity: {
      refresh: async () => {
        probes += 1;
        return { available, cpus: 4, memMb: 8192 };
      },
    },
  });
  await f.lifecycle.start(target('a'), true);
  await f.lifecycle.start(target('b'), true);
  available = false;
  await f.advance(30_000);
  await f.lifecycle.stop(target('a'));
  expect(f.running.has('repo/b')).toBe(false);
  available = true;
  await f.advance(30_000);
  expect(f.running.has('repo/b')).toBe(true);
  expect(f.timers.size).toBe(0);
  expect(probes).toBe(3);
});

test('a container waiting for capacity does not block a later admissible bare start', async () => {
  let cpus = 2;
  const f = fixture({
    capacity: { refresh: async () => ({ available: true, cpus, memMb: 8192 }) },
    settings: { maxConcurrentDevServers: 3 },
  });
  await f.lifecycle.start(target('a'), true);
  cpus = 1;
  const waiting = await f.lifecycle.start(target('b'), true);
  expect(waiting).toMatchObject({
    ok: true,
    queued: true,
    reason: 'container-capacity',
  });
  expect(f.lifecycle.queueSnapshot()[0]).toMatchObject({
    key: 'repo/b',
    reason: 'container-capacity',
  });
  const started = await f.lifecycle.start(target('c'), false);
  expect(started.ok).toBe(true);
  expect(started.queued).toBeUndefined();
  expect(f.launches.map((item) => item.target.name)).toEqual(['a', 'c']);
});

test('drain skips an unadmittable queued container for a later queued bare start', async () => {
  let available = true;
  const f = fixture({
    capacity: {
      refresh: async () => ({ available, cpus: 4, memMb: 8192 }),
    },
  });
  await f.lifecycle.start(target('a'), false);
  await f.lifecycle.start(target('b'), true);
  await f.lifecycle.start(target('c'), false);
  available = false;
  await f.advance(30_000);
  await f.lifecycle.stop(target('a'));
  expect(f.launches.map((item) => item.target.name)).toEqual(['a', 'c']);
  expect(f.lifecycle.queueSnapshot()[0].key).toBe('repo/b');
});

test('unknown container exit retains ownership until two confirmed dead observations', async () => {
  const f = fixture();
  await f.lifecycle.start(target('a'), true);
  await f.lifecycle.start(target('b'), false);
  const original = f.lifecycle.snapshot('repo/a');
  f.launches[0].handle.state = 'unknown';
  f.launches[0].handle.exit.resolve(1);
  await f.lifecycle.reconcile('repo/a', original.generation);
  expect(f.lifecycle.status().active).toBe(1);
  expect(f.running.has('repo/b')).toBe(false);
  f.launches[0].handle.state = 'dead';
  await f.lifecycle.reconcile('repo/a', original.generation);
  expect(f.running.has('repo/b')).toBe(false);
  await f.lifecycle.reconcile('repo/a', original.generation);
  expect(f.running.has('repo/b')).toBe(true);
});

test('known operations keep target admission until completion while owned dev servers remain stoppable', async () => {
  const f = fixture();
  await f.lifecycle.start(target('a'), false);
  const review = deferred();
  const operation = f.lifecycle.runOperation(
    target('a'),
    'review',
    () => review.promise
  );
  expect(
    (
      await f.lifecycle.runOperation(target('a'), 'remove', () =>
        Promise.resolve({
          ok: true,
        })
      )
    ).code
  ).toBe('TARGET_BUSY');
  expect((await f.lifecycle.stop(target('a'))).ok).toBe(true);
  expect((await f.lifecycle.start(target('a'), false)).code).toBe(
    'TARGET_BUSY'
  );
  review.resolve({ ok: true });
  await operation;
  expect((await f.lifecycle.start(target('a'), false)).ok).toBe(true);
});

test('quiescence closes admission atomically and only its coherent owner can reopen', async () => {
  const f = fixture();
  const before = f.lifecycle.quiesce();
  expect(before.ok).toBe(true);
  expect((await f.lifecycle.start(target('a'), false)).code).toBe(
    'ADMISSION_CLOSED'
  );
  expect(
    (await f.lifecycle.reopen(Symbol('wrong'), { coherent: true })).ok
  ).toBe(false);
  expect((await f.lifecycle.reopen(before.token, { coherent: false })).ok).toBe(
    false
  );
  expect((await f.lifecycle.reopen(before.token, { coherent: true })).ok).toBe(
    true
  );
  await f.lifecycle.start(target('a'), false);
  const busy = f.lifecycle.quiesce();
  expect(busy).toMatchObject({ code: 'OWNED_WORK_ACTIVE', ok: false });
  expect(
    (
      await f.lifecycle.runOperation(target('b'), 'review', () =>
        Promise.resolve({
          ok: true,
        })
      )
    ).code
  ).toBe('ADMISSION_CLOSED');
  expect((await f.lifecycle.stop(target('a'))).ok).toBe(true);
});

test('only the existing quiescence owner can recheck changing work before cutover', async () => {
  const f = fixture();
  await f.lifecycle.start(target('a'), false);
  const owner = f.lifecycle.quiesce();
  expect(f.lifecycle.quiescenceStatus(owner.token)).toMatchObject({
    code: 'OWNED_WORK_ACTIVE',
    ok: false,
  });
  expect(f.lifecycle.quiescenceStatus(Symbol('wrong'))).toMatchObject({
    code: 'ADMISSION_CLOSED',
    ok: false,
  });
  await f.lifecycle.stop(target('a'));
  expect(f.lifecycle.quiescenceStatus(owner.token)).toEqual({ ok: true });
  expect((await f.lifecycle.start(target('b'), false)).code).toBe(
    'ADMISSION_CLOSED'
  );
});

test('Start reconciles a confirmed-dead adopted runtime without forgetting an unknown one', async () => {
  const f = fixture();
  const handle = { ownedGroup: false, pid: 77, state: 'unknown' };
  f.lifecycle.adopt(target('a'), handle, {
    container: false,
    limits: null,
    port: target('a').port,
  });
  expect((await f.lifecycle.start(target('a'), false)).ok).toBe(false);
  handle.state = 'dead';
  expect((await f.lifecycle.start(target('a'), false)).ok).toBe(true);
  expect(f.lifecycle.status().active).toBe(1);
  expect(f.launches).toHaveLength(1);
});

test('critical storage refuses the actual bare and container launch without reserving a slot', async () => {
  for (const container of [false, true]) {
    const f = fixture({
      controller: {
        assertStorage: () =>
          Promise.reject(
            Object.assign(new Error('116 MiB free'), { code: 'STORAGE_LOW' })
          ),
      },
    });
    expect(await f.lifecycle.start(target('a'), container)).toMatchObject({
      ok: false,
      code: 'STORAGE_LOW',
    });
    expect(f.launches).toHaveLength(0);
    expect(f.lifecycle.status().active).toBe(0);
  }
});

test('queue promotion rechecks storage and Stop and removal remain available after space falls', async () => {
  let low = false;
  const f = fixture({
    controller: {
      assertStorage: async () => {
        if (low)
          throw Object.assign(new Error('disk full'), { code: 'STORAGE_LOW' });
      },
    },
  });
  await f.lifecycle.start(target('a'), false);
  expect((await f.lifecycle.start(target('b'), false)).queued).toBe(true);
  low = true;
  expect((await f.lifecycle.stop(target('a'))).ok).toBe(true);
  expect(f.launches).toHaveLength(1);
  expect(f.lifecycle.snapshot('repo/b')).toMatchObject({
    phase: 'stopped',
    reserved: false,
    lastError: { code: 'STORAGE_LOW' },
  });
  expect(
    (
      await f.lifecycle.runOperation(target('b'), 'remove', async () => ({
        ok: true,
      }))
    ).ok
  ).toBe(true);
});

test('a storage-denied restart preserves the exact running handle without Stop or reconfiguration', async () => {
  let low = false,
    changed = false;
  const f = fixture({
    controller: {
      assertStorage: async () => {
        if (low)
          throw Object.assign(new Error('disk full'), { code: 'STORAGE_LOW' });
      },
    },
  });
  await f.lifecycle.start(target('a'), false);
  await f.lifecycle.reconcile(
    'repo/a',
    f.lifecycle.snapshot('repo/a').generation
  );
  const before = f.lifecycle.snapshot('repo/a');
  low = true;
  expect(
    await f.lifecycle.restart(target('a'), async () => {
      changed = true;
    })
  ).toMatchObject({ ok: false, code: 'STORAGE_LOW' });
  expect(changed).toBe(false);
  expect(f.launches).toHaveLength(1);
  expect(f.running.get('repo/a')).toBe(f.launches[0].handle);
  expect(f.lifecycle.snapshot('repo/a')).toMatchObject({
    pid: before.pid,
    generation: before.generation,
    phase: 'running',
    reserved: true,
  });
});

test('an asynchronous storage refusal releases admission to a queued checkout without a new reader', async () => {
  const checking = deferred(),
    entered = deferred();
  const f = fixture({
    controller: {
      assertStorage: async (t) => {
        if (t.name === 'a') {
          entered.resolve();
          await checking.promise;
        }
      },
    },
  });
  const starting = f.lifecycle.start(target('a'), false);
  await entered.promise;
  expect((await f.lifecycle.start(target('b'), false)).queued).toBe(true);
  checking.reject(
    Object.assign(new Error('unknown disk'), { code: 'STORAGE_UNKNOWN' })
  );
  expect((await starting).code).toBe('STORAGE_UNKNOWN');
  expect(f.launches.map((row) => row.target.name)).toEqual(['b']);
});

test('exit watchers and queue timers drain from a clean real workspace lock context', async () => {
  const root = mkdtempSync(join(tmpdir(), 'setu-lifecycle-als-'));
  const state = createWorkspaceState({ workspaceRoot: root });
  const makeTarget = (name) => ({
    key: `repo/${name}`,
    name,
    port: 3400,
    project: `repo-${name}`,
    repo: 'repo',
    wtDir: join(root, 'repo', name),
  });
  async function exitsDrain(first, second) {
    const exits = new Map(),
      dead = new Set(),
      launched = [];
    const lifecycle = createWorktreeLifecycle({
      capacity: {
        refresh: async () => ({ available: true, cpus: 4, memMb: 8192 }),
      },
      clock: { now: Date.now, setTimeout, clearTimeout },
      runtime: {
        async launch(t, _spec, register) {
          let resolve;
          const exited = new Promise((done) => {
            resolve = done;
          });
          exits.set(t.key, resolve);
          launched.push(t.key);
          register({ exited, ownedGroup: true, pid: 1000 + launched.length });
        },
        async observe(t) {
          return dead.has(t.key) ? 'dead' : 'alive';
        },
        async stop() {},
      },
      settings: { maxConcurrentDevServers: 1 },
      validateTarget: async () => {},
      withTarget: (t, task) => state.withTargets([t], task),
    });
    await lifecycle.start(makeTarget(first), false);
    await lifecycle.start(makeTarget(second), false);
    dead.add(`repo/${first}`);
    exits.get(`repo/${first}`)(0);
    for (let count = 0; count < 20 && launched.length < 2; count += 1) {
      await Bun.sleep(10);
    }
    expect(launched).toEqual([`repo/${first}`, `repo/${second}`]);
  }
  await exitsDrain('zeta', 'alpha');
  await exitsDrain('alpha2', 'zeta2');

  let capacity = { cpus: 4, memMb: 4096 };
  let tick = 0;
  const launched = [];
  const lifecycle = createWorktreeLifecycle({
    capacity: { refresh: async () => ({ available: true, ...capacity }) },
    clock: {
      now: () => (tick += 31_000),
      setTimeout: (task) => setTimeout(task, 10),
      clearTimeout,
    },
    runtime: {
      async launch(t, _spec, register) {
        launched.push(t.key);
        register({ ownedGroup: true, pid: 2000 + launched.length });
      },
      async observe() {
        return 'alive';
      },
      async stop() {},
    },
    settings: {
      containerCpuLimit: 1,
      containerMemoryLimit: '4g',
      maxConcurrentDevServers: 3,
    },
    validateTarget: async () => {},
    withTarget: (t, task) => state.withTargets([t], task),
  });
  await lifecycle.start(makeTarget('timer-a'), true);
  await lifecycle.start(makeTarget('timer-b'), true);
  capacity = { cpus: 4, memMb: 16384 };
  for (let count = 0; count < 20 && launched.length < 2; count += 1) {
    await Bun.sleep(10);
  }
  expect(launched).toEqual(['repo/timer-a', 'repo/timer-b']);
  lifecycle.dispose();
});
