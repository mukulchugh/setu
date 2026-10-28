import { expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { lstat, readFile, realpath, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inspectCheckoutIdentity } from './checkout-identity.js';
import { handleMcpRequest, initMcpServer } from './mcp-server.js';
import { createPortalRuntime } from './portal.js';
import { createWorkspaceState } from './workspace-state.js';
import { createWorktreeLifecycle } from './worktree-lifecycle.js';

async function fixture({ extraConfig, ...options } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'setu-portal-runtime-'));
  const state = createWorkspaceState({
    configPath: join(root, 'config.json'),
    setuDir: root,
    workspaceRoot: root,
  });
  const config = { tunnel: 'fixture', workspace: root, ...extraConfig };
  await state.replace('config', config);
  const portal = await createPortalRuntime({
    config,
    linksRoot: join(root, 'links'),
    state,
    ...options,
  });
  const server = {
    requestIP: () => ({ address: '127.0.0.1' }),
    timeout: options.requestTimeout ?? (() => undefined),
  };
  return {
    dispose: async () => {
      await portal.dispose();
      rmSync(root, { force: true, recursive: true });
    },
    portal,
    request: (path, body, source = 'ui') =>
      portal.handle(
        new Request(
          `http://localhost:${options.port ?? 2999}${path}`,
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

test('dependency file mutations retain their connection beyond the ordinary server idle window', async () => {
  const timeouts = [];
  const fx = await fixture({
    port: 43_210,
    requestTimeout: (request, seconds) => {
      timeouts.push({ path: new URL(request.url).pathname, seconds });
    },
  });
  try {
    await fx.request('/api/dependency-sharing/prepare', {
      name: 'missing',
      repo: 'fixture',
    });
    await fx.request('/api/operations');
    expect(timeouts).toEqual([
      { path: '/api/dependency-sharing/prepare', seconds: 0 },
    ]);
  } finally {
    await fx.dispose();
  }
});

function mcpInitializeRequest(port, host = `localhost:${port}`) {
  return new Request(`http://localhost:${port}/mcp`, {
    body: JSON.stringify({
      id: 1,
      jsonrpc: '2.0',
      method: 'initialize',
      params: {
        capabilities: {},
        clientInfo: { name: 'host-guard', version: '1' },
        protocolVersion: '2025-06-18',
      },
    }),
    headers: {
      accept: 'application/json, text/event-stream',
      'content-type': 'application/json',
      host,
    },
    method: 'POST',
  });
}

test.each(['idle', 'owned', 'unknown'])(
  'update cutover preserves installer ownership and named blockers: %s',
  async (state) => {
    const fx = await fixture({
      port: 43_210,
      setupInstallProcesses: {
        close() {
          /* This fixture owns no processes. */
        },
        hasOwnedWork() {
          if (state === 'unknown') {
            throw new Error('installer observation unreadable');
          }
          return state === 'owned';
        },
      },
    });
    try {
      const capabilities = await (
        await fx.request('/api/update/capabilities')
      ).json();
      const result = await (
        await fx.request('/api/update/quiesce', capabilities)
      ).json();
      expect(result.ok).toBe(state === 'idle');
      if (state !== 'idle') {
        expect(result).toMatchObject({ code: 'OWNED_WORK_ACTIVE', ok: false });
        expect(result.blockers).toContain(
          state === 'owned'
            ? 'dependency installer work active'
            : 'supporting work state unreadable'
        );
      }
    } finally {
      await fx.dispose();
    }
  }
);

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

test('MCP accepts only the trusted host for its runtime port', async () => {
  initMcpServer({});
  expect((await handleMcpRequest(mcpInitializeRequest(2999))).status).toBe(200);

  const fx = await fixture({ port: 43_210 });
  const server = {
    requestIP: () => ({ address: '127.0.0.1' }),
    timeout: () => undefined,
  };
  try {
    expect(
      (await fx.portal.handle(mcpInitializeRequest(43_210), server)).status
    ).toBe(200);
    expect(
      (
        await handleMcpRequest(
          mcpInitializeRequest(43_210, 'localhost:2999'),
          43_210
        )
      ).status
    ).toBe(403);
  } finally {
    await fx.dispose();
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

test('create reaches its normal validation after resolving dependency sharing', async () => {
  const fx = await fixture({
    hostHealth: () =>
      Promise.resolve({ availableBytes: 32 * 1024 ** 3, state: 'ready' }),
  });
  try {
    await fx.state.replace('projects', {
      missing: { base: 3900, label: 'Fixture', slug: null },
    });
    const response = await fx.request('/api/create', {
      name: 'topic',
      repo: 'missing',
    });
    expect(await response.json()).toMatchObject({
      error: `Bare repo not found: ${join(fx.root, 'missing.git')}\nRun: setu init <gh-slug>`,
      ok: false,
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
      // biome-ignore lint/suspicious/useAwait: The launch fixture preserves rejected registration failures at its promise boundary.
      launch: async (_target, _spec, register) => {
        register({ ownedGroup: true, pid: 123 });
        return {};
      },
      observe: async () => 'alive',
      stop: async () => {
        // The lifecycle fixture has nothing to stop.
      },
    },
    settings: { maxConcurrentDevServers: 1 },
    validateTarget: async () => {
      // Every fixture target is valid.
    },
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

test('explicit startup binds one injected server, installs dependency MCP handlers and disposes its hooks and timers', async () => {
  const timers = new Set();
  let timerId = 0,
    served = 0,
    stopped = 0,
    migrations = 0,
    routed = 0,
    routes,
    installedMcp;
  const before = process.listenerCount('SIGTERM');
  const fx = await fixture({
    computeWorktrees: async () => [],
    indexPage: new Response('fixture'),
    initializeMcp: (deps) => {
      installedMcp = deps;
      initMcpServer(deps);
    },
    managedAgents: {
      dispose: async () => {
        // The fixture starts no managed agents.
      },
      recover: async () => {
        // The fixture has no managed-agent state.
      },
    },
    observeProcess: async () => ({ state: 'unknown' }),
    port: 43_210,
    projects: {},
    reconcileDevServers: async () => {
      // The fixture has no existing runtimes to reconcile.
    },
    reconcileTriggerSidecars: async () => {
      // The fixture has no existing Trigger sidecars to reconcile.
    },
    routing: {
      // biome-ignore lint/suspicious/useAwait: The routing fixture preserves the asynchronous bootstrap collaborator contract.
      syncHosts: async () => {
        routed += 1;
      },
    },
    // biome-ignore lint/suspicious/useAwait: The approval migration fixture preserves the asynchronous bootstrap collaborator contract.
    seedSidecarApprovals: async () => {
      migrations += 1;
    },
    serve: (options) => {
      const { port, routes: serverRoutes } = options;
      served += 1;
      expect(port).toBe(43_210);
      routes = serverRoutes;
      return {
        stop: () => {
          stopped += 1;
        },
      };
    },
    timers: {
      clearInterval: (id) => timers.delete(id),
      setInterval: () => {
        timerId += 1;
        const id = timerId;
        timers.add(id);
        return id;
      },
    },
  });
  try {
    expect(served).toBe(0);
    await Promise.all([fx.portal.start(), fx.portal.start()]);
    expect([served, migrations, routed]).toEqual([1, 1, 1]);
    const digest = 'a'.repeat(64);
    await Promise.all(
      [
        ['dependencyPrepare', 'prepare_dependency_sharing', {}],
        [
          'dependencyApply',
          'apply_dependency_sharing',
          { confirmation: digest, planId: digest },
        ],
        [
          'dependencyRecover',
          'recover_dependency_sharing',
          { operationId: digest },
        ],
        [
          'dependencyPrepareRelease',
          'prepare_dependency_release',
          { operationId: digest },
        ],
        [
          'dependencyRelease',
          'release_dependency_originals',
          { confirmation: digest, releaseId: digest },
        ],
      ].map(async ([dependency, tool, review]) => {
        expect(typeof installedMcp[dependency], dependency).toBe('function');
        const response = await handleMcpRequest(
          new Request('http://localhost:43210/mcp', {
            body: JSON.stringify({
              id: tool,
              jsonrpc: '2.0',
              method: 'tools/call',
              params: {
                arguments: { name: 'missing', repo: 'fixture', ...review },
                name: tool,
              },
            }),
            headers: {
              accept: 'application/json, text/event-stream',
              'content-type': 'application/json',
              host: 'localhost:43210',
            },
            method: 'POST',
          }),
          43_210
        );
        expect(response.status).toBe(200);
        const wire = await response.text();
        const payload = response.headers
          .get('content-type')
          ?.includes('text/event-stream')
          ? JSON.parse(
              wire
                .split('\n')
                .find((line) => line.startsWith('data:'))
                .slice(5)
            )
          : JSON.parse(wire);
        const result = JSON.parse(
          payload.result.content.find((item) => item.type === 'text').text
        );
        expect(result).toMatchObject({
          code: 'WORKTREE_NOT_FOUND',
          ok: false,
        });
        expect(payload.result.isError).toBe(true);
      })
    );
    expect(routes['/links']).toBeDefined();
    // Log retention, memory ceilings, idle timeouts, auto cleanup and the Links
    // presence round.
    expect(timers.size).toBe(5);
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

test('real fixture removal uses injected routing without invoking host commands', async () => {
  const effects = [];
  const fx = await fixture({
    command: (args) => {
      expect(args[0]).toBe('git');
      return Promise.resolve({
        code: 0,
        stderr: '',
        stdout: execFileSync(args[0], args.slice(1), { encoding: 'utf8' }),
        timedOut: false,
        truncated: false,
      });
    },
    devRuntime: {
      observe: () => Promise.resolve('dead'),
      stop: () => Promise.resolve(),
    },
    reconcileTriggerSidecars: () => {
      effects.push('reconcile');
      return Promise.resolve();
    },
    removalRouting: {
      reloadCaddy: () => {
        effects.push('caddy');
        return Promise.resolve(true);
      },
      removeTunnelRoute: () => {
        effects.push('tunnel');
        return Promise.resolve({ ok: true });
      },
    },
    routing: {
      syncHosts: () => {
        effects.push('hosts');
        return Promise.resolve(true);
      },
    },
  });
  try {
    const bare = join(fx.root, 'fixture.git');
    const checkout = join(fx.root, 'fixture', 'topic');
    const git = (...args) =>
      execFileSync('git', args, {
        encoding: 'utf8',
        input: '',
        stdio: ['pipe', 'pipe', 'pipe'],
      }).trim();
    git('init', '--bare', bare);
    const tree = git('-C', bare, 'mktree');
    const revision = git(
      '-C',
      bare,
      '-c',
      'user.name=Fixture',
      '-c',
      'user.email=fixture@example.invalid',
      'commit-tree',
      tree,
      '-m',
      'fixture'
    );
    git('-C', bare, 'update-ref', 'refs/heads/main', revision);
    git('-C', bare, 'worktree', 'add', '--detach', checkout, revision);
    await fx.state.replace('projects', {
      fixture: { base: 3910, label: 'Fixture', slug: null },
    });
    await fx.state.replace('ports', [
      { key: 'fixture/topic', name: 'topic', port: 3910, repo: 'fixture' },
    ]);
    const result = await (
      await fx.request('/api/remove', { name: 'topic', repo: 'fixture' })
    ).json();
    expect(result).toMatchObject({ ok: true });
    expect(existsSync(checkout)).toBe(false);
    expect(fx.state.read('ports')).toEqual([]);
    expect(effects).toEqual(['reconcile', 'tunnel', 'hosts', 'caddy']);
  } finally {
    await fx.dispose();
  }
});

async function registerEmptyFixture(fx) {
  const bare = join(fx.root, 'fixture.git');
  const checkout = join(fx.root, 'fixture', 'topic');
  const git = (...args) =>
    execFileSync('git', args, {
      encoding: 'utf8',
      input: '',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
  git('init', '--bare', bare);
  const tree = git('-C', bare, 'mktree');
  const revision = git(
    '-C',
    bare,
    '-c',
    'user.name=Fixture',
    '-c',
    'user.email=fixture@example.invalid',
    'commit-tree',
    tree,
    '-m',
    'fixture'
  );
  git('-C', bare, 'update-ref', 'refs/heads/main', revision);
  git('-C', bare, 'worktree', 'add', '--detach', checkout, revision);
  await fx.state.replace('projects', {
    fixture: { base: 3910, label: 'Fixture', slug: null },
  });
  await fx.state.replace('ports', [
    { key: 'fixture/topic', name: 'topic', port: 3910, repo: 'fixture' },
  ]);
  return { bare, checkout };
}

test('retry of unknown enrollment never enters new installation admission or invents a dependency operation id', async () => {
  let admissionChecks = 0;
  const fx = await fixture({
    hostHealth: () => {
      admissionChecks += 1;
      throw new Error('New installation admission must not run');
    },
    port: 43_210,
  });
  try {
    const { bare, checkout } = await registerEmptyFixture(fx);
    const identity = await inspectCheckoutIdentity(
      { repoDir: bare, wtDir: checkout },
      { lstat, readFile, realpath, stat }
    );
    expect(identity.known).toBe(true);
    const record = {
      attemptId: 'original-enrollment-attempt',
      checkoutIdentity: identity,
      finishedAt: 2,
      logLocation: join(fx.root, 'setup.log'),
      outcome: 'unknown',
      stage: 'dependency-enrollment',
      startedAt: 1,
      state: 'unknown',
      target: { name: 'topic', repo: 'fixture' },
      updatedAt: 2,
    };
    await fx.state.replace('setupProgress', {
      records: { 'fixture/topic': record },
    });
    const result = await (
      await fx.request('/api/setup-progress/retry', {
        attemptId: record.attemptId,
        checkoutIdentity: identity,
        ...record.target,
      })
    ).json();
    expect(result).toMatchObject({
      code: 'DEPENDENCY_FILE_SETUP_BINDING_REQUIRED',
      ok: false,
    });
    expect(typeof result.eventId).toBe('string');
    expect(result.operationId).toBeUndefined();
    expect(admissionChecks).toBe(0);
    expect(fx.state.read('setupProgress').records['fixture/topic']).toEqual(
      record
    );
    expect(existsSync(join(checkout, 'node_modules'))).toBe(false);
  } finally {
    await fx.dispose();
  }
});

test('dependency conversion refuses retained listeners after their observation becomes unknown', async () => {
  const fx = await fixture({
    // Opted in, so the refusal under test is the runtime one, not the
    // missing opt-in that is reported first.
    extraConfig: {
      dependencySharing: {
        enabled: true,
        executable: '/opt/setu/bin/bun',
        storeRoot: '/private/setu/dependencies',
        targets: { 'fixture/topic': true },
        version: '1.3.14',
      },
    },
    listenerObservation: {
      observation: () => ({ observedAt: Date.now(), state: 'unknown' }),
      read: () => Promise.resolve([]),
    },
    port: 43_210,
  });
  try {
    await registerEmptyFixture(fx);
    const result = await (
      await fx.request('/api/dependency-sharing/prepare', {
        name: 'topic',
        repo: 'fixture',
      })
    ).json();
    expect(result).toMatchObject({ code: 'RUNTIME_UNKNOWN', ok: false });
    expect(fx.state.read('dependencyFiles')).toEqual({
      operations: {},
      version: 1,
      views: {},
    });
  } finally {
    await fx.dispose();
  }
});
