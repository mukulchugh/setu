import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPortalRuntime } from './portal.js';
import { createWorkspaceState } from './workspace-state.js';
import { createWorktreeLifecycle } from './worktree-lifecycle.js';

async function fixture(options = {}) {
  const root = mkdtempSync(join(tmpdir(), 'setu-portal-runtime-'));
  const state = createWorkspaceState({
    configPath: join(root, 'config.json'),
    setuDir: root,
    workspaceRoot: root,
  });
  const config = { tunnel: 'fixture', workspace: root };
  await state.replace('config', config);
  const portal = await createPortalRuntime({ config, state, ...options });
  const server = { requestIP: () => ({ address: '127.0.0.1' }), timeout() {} };
  return {
    dispose: async () => {
      await portal.dispose();
      rmSync(root, { force: true, recursive: true });
    },
    portal,
    request: (path, body, source = 'ui') =>
      portal.handle(
        new Request(
          `http://localhost:2999${path}`,
          body === undefined
            ? {}
            : {
                body: JSON.stringify(body),
                headers: { 'x-setu-source': source },
                method: 'POST',
              }
        ),
        server
      ),
    root,
    state,
  };
}

test('a child import under an empty HOME is inert and exits without a configuration file', async () => {
  const home = mkdtempSync(join(tmpdir(), 'setu-portal-import-'));
  const script = `
    const fs = await import('node:fs');
    const fsPromises = await import('node:fs/promises');
    for (const method of ['appendFileSync', 'mkdirSync', 'openSync', 'writeFileSync']) fs.default[method] = () => { throw new Error('filesystem during import') };
    for (const method of ['readFile', 'writeFile', 'mkdir']) fsPromises.default[method] = () => { throw new Error('filesystem during import') };
    Bun.serve = () => { throw new Error('serve during import') };
    Bun.spawn = () => { throw new Error('process during import') };
    globalThis.fetch = () => { throw new Error('network during import') };
    globalThis.setInterval = () => { throw new Error('timer during import') };
    const originalExit = process.exit;
    const originalKill = process.kill;
    process.exit = () => { throw new Error('exit during import') };
    process.kill = () => { throw new Error('signal during import') };
    await import(${JSON.stringify(new URL('./portal.js', import.meta.url).href)});
    process.exit = originalExit;
    process.kill = originalKill;
    console.log('imported');
  `;
  try {
    const proc = Bun.spawn([process.execPath, '-e', script], {
      env: { ...process.env, HOME: home },
      stderr: 'pipe',
      stdout: 'pipe',
    });
    expect(await proc.exited).toBe(0);
    expect(await new Response(proc.stdout).text()).toContain('imported');
    expect(await new Response(proc.stderr).text()).toBe('');
  } finally {
    rmSync(home, { force: true, recursive: true });
  }
});

test('the imported dispatcher handles reads and mutations without serializing a parallel read', async () => {
  let release;
  const slow = new Promise((done) => {
    release = done;
  });
  const fx = await fixture({
    removals: {
      cancel: async (operationId) => {
        await slow;
        return { ok: true, operationId, recovery: 'cancelled' };
      },
    },
  });
  const mutation = fx.request('/api/remove/cancel', {
    operationId: 'remove-1',
  });
  const read = await fx.request('/api/operations');
  expect(read.status).toBe(200);
  expect((await read.json()).ok).toBe(true);
  release();
  expect(await (await mutation).json()).toMatchObject({
    ok: true,
    operationId: 'remove-1',
    recovery: 'cancelled',
  });
  expect(fx.state.read('operationEvents').events.at(-1)).toMatchObject({
    kind: 'removal-cancel',
    source: 'ui',
    state: 'completed',
  });
  await fx.dispose();
});

test('settings writes use the supplied isolated state and retain actual source and failures', async () => {
  const fx = await fixture();
  try {
    const response = await fx.request(
      '/api/settings',
      { maxConcurrentDevServers: 3 },
      'cli'
    );
    expect((await response.json()).ok).toBe(true);
    expect(fx.state.read('config').maxConcurrentDevServers).toBe(3);
    expect(fx.state.read('operationEvents').events.at(-1)).toMatchObject({
      kind: 'settings-save',
      source: 'cli',
      state: 'completed',
    });
    const bad = await fx.request(
      '/api/settings',
      { maxConcurrentDevServers: -1 },
      'raycast'
    );
    expect(bad.status).toBe(400);
    expect((await bad.json()).ok).toBe(false);
    expect(fx.state.read('config').maxConcurrentDevServers).toBe(3);
    expect(fx.state.read('operationEvents').events.at(-1)).toMatchObject({
      source: 'raycast',
      state: 'failed',
    });
  } finally {
    await fx.dispose();
  }
});

test('a queued HTTP start records completion only after the real lifecycle observes it running', async () => {
  const lifecycle = createWorktreeLifecycle({
    capacity: {},
    clock: { clearTimeout, now: Date.now, setTimeout },
    runtime: {
      launch: async (_target, _spec, register) => {
        register({ ownedGroup: true, pid: 123 });
        return {};
      },
      observe: async () => 'alive',
      stop: async () => {},
    },
    settings: { maxConcurrentDevServers: 1 },
    validateTarget: async () => {},
  });
  const fx = await fixture({ lifecycle });
  try {
    await fx.state.replace('ports', [
      { key: 'r/topic', name: 'topic', port: 3201, repo: 'r' },
    ]);
    const first = {
      key: 'r/first',
      name: 'first',
      port: 3200,
      repo: 'r',
      wtDir: join(fx.root, 'first'),
    };
    await lifecycle.start(first, false);
    const accepted = await (
      await fx.request(
        '/api/start',
        { container: false, name: 'topic', repo: 'r' },
        'cli'
      )
    ).json();
    expect(accepted).toMatchObject({ ok: true, queued: true });
    expect(fx.state.read('operationEvents').events.at(-1).state).toBe('queued');
    await lifecycle.stop(first);
    const started = lifecycle.snapshot('r/topic');
    expect(started.phase).toBe('starting');
    await lifecycle.reconcile('r/topic', started.generation);
    await fx.portal.internals.waitForOutcomes();
    expect(fx.state.read('operationEvents').events.at(-1)).toMatchObject({
      id: accepted.operationId,
      source: 'cli',
      state: 'completed',
    });
  } finally {
    await fx.dispose();
  }
});

test('explicit startup binds one injected server and dispose removes its hooks and timers', async () => {
  const timers = new Set();
  let timerId = 0,
    served = 0,
    stopped = 0,
    migrations = 0,
    routed = 0;
  const before = process.listenerCount('SIGTERM');
  const fx = await fixture({
    computeWorktrees: async () => [],
    indexPage: new Response('fixture'),
    initializeMcp: () => {},
    managedAgents: { dispose: async () => {}, recover: async () => {} },
    observeProcess: async () => ({ state: 'unknown' }),
    port: 43_210,
    projects: {},
    reconcileDevServers: async () => {},
    reconcileTriggerSidecars: async () => {},
    routing: {
      syncHosts: async () => {
        routed += 1;
      },
    },
    seedSidecarApprovals: async () => {
      migrations += 1;
    },
    serve: (options) => {
      served += 1;
      expect(options.port).toBe(43_210);
      return {
        stop: () => {
          stopped += 1;
        },
      };
    },
    timers: {
      clearInterval: (id) => timers.delete(id),
      setInterval: () => {
        const id = ++timerId;
        timers.add(id);
        return id;
      },
    },
  });
  try {
    expect(served).toBe(0);
    await Promise.all([fx.portal.start(), fx.portal.start()]);
    expect([served, migrations, routed]).toEqual([1, 1, 1]);
    expect(timers.size).toBe(3);
    expect(process.listenerCount('SIGTERM')).toBe(before + 1);
    const address = { requestIP: () => ({ address: '127.0.0.1' }) };
    expect(
      (
        await fx.portal.handle(
          new Request('http://localhost:43210/api/projects'),
          address
        )
      ).status
    ).toBe(200);
    expect(
      (
        await fx.portal.handle(
          new Request('http://localhost:2999/api/projects'),
          address
        )
      ).status
    ).toBe(403);
    await fx.portal.dispose();
    expect(stopped).toBe(1);
    expect(timers.size).toBe(0);
    expect(process.listenerCount('SIGTERM')).toBe(before);
  } finally {
    await fx.dispose();
  }
});
