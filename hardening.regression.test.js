import { expect, test } from 'bun:test';
import {
  closeSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  anthropicCosts,
  computeBudgets,
  fetchAllPages,
  openaiCosts,
} from './costs.js';
import {
  composeDownAsync,
  effectiveContainerLimits,
  managedWorktreePath,
  portalRequestError,
  removeWorktree,
  resourceSettings,
  spawnText,
  tunnelCredentials,
  validateWorktreeNames,
} from './lib.js';
import { createPortalRuntime } from './portal.js';
import { artifactHtmlPath } from './pr-review.js';

const runtime = (options = {}) =>
  createPortalRuntime({
    config: { tunnel: 'fixture', workspace: '/private/tmp/setu-hardening' },
    ...options,
  });

test('actual portal handler rejects foreign Host, Origin, and remote peers before routing', async () => {
  const portal = await runtime();
  const local = { requestIP: () => ({ address: '127.0.0.1' }) };
  const remote = { requestIP: () => ({ address: '192.168.1.4' }) };
  expect(
    (
      await portal.handle(
        new Request('http://localhost:2999/api/projects', {
          headers: { host: 'foreign.invalid' },
        }),
        local
      )
    ).status
  ).toBe(403);
  expect(
    (
      await portal.handle(
        new Request('http://localhost:2999/api/projects'),
        remote
      )
    ).status
  ).toBe(403);
  expect(
    portalRequestError(
      new Request('http://localhost:2999/api/start', {
        headers: { origin: 'https://foreign.invalid' },
        method: 'POST',
      }),
      '127.0.0.1'
    )
  ).toBeTruthy();
  await portal.dispose();
});

test('actual portal callback markup escapes OAuth errors and locks down the page', async () => {
  const portal = await runtime();
  const response = portal.internals.mcpCallbackHtml(
    '<img>',
    '<script>bad</script>'
  );
  const html = await response.text();
  expect(html).not.toContain('<script>bad</script>');
  expect(html).toContain('&lt;script&gt;bad&lt;/script&gt;');
  expect(response.headers.get('content-security-policy')).toContain(
    "default-src 'none'"
  );
  await portal.dispose();
});

test('portal helpers keep checkout boundaries and project setup targets constrained', async () => {
  const portal = await runtime();
  expect(
    portal.internals.worktreeContains(
      '/workspace/r/topic',
      '/workspace/r/topic/apps/web'
    )
  ).toBe(true);
  expect(
    portal.internals.worktreeContains(
      '/workspace/r/topic',
      '/workspace/r/topic-other'
    )
  ).toBe(false);
  expect(portal.internals.projectSetupTarget('new-project')).toMatchObject({
    repoDir: '/private/tmp/setu-hardening/new-project.git',
    wtDir: '/private/tmp/setu-hardening/new-project/main',
  });
  expect(
    artifactHtmlPath('owner/repo', 7, 'pr-walkthrough', '../outside', 'x.html')
  ).toBeNull();
  await portal.dispose();
});

test('injected library boundaries propagate compose failure and bounded process output', async () => {
  await expect(
    composeDownAsync('fixture', '/fixture.yml', [], {
      spawn: () => ({
        exited: Promise.resolve(1),
        stderr: new Blob(['daemon refused']).stream(),
      }),
    })
  ).rejects.toThrow('daemon refused');
  const result = await spawnText(['fixture'], {
    spawn: () => ({
      exited: Promise.resolve(0),
      stderr: new Blob([]).stream(),
      stdout: new Blob(['ok']).stream(),
    }),
    timeoutMs: 1,
  });
  expect(result).toBe('ok');
});

test('cost helpers use injected pagination and preserve incomplete provider data', async () => {
  expect(
    computeBudgets({ budgets: { daily: 100 } }, [
      { configured: true, last1d: 10 },
      { configured: true, error: 'timeout' },
    ]).daily.status
  ).toBe('incomplete');
  await expect(
    anthropicCosts('key', {
      fetchPages: async () => [
        { results: [{ amount: null }], starting_at: '2026-01-01' },
      ],
    })
  ).rejects.toThrow('Invalid anthropic');
  await expect(
    openaiCosts('key', {
      fetchPages: async () => [
        { results: [{ amount: { value: null } }], start_time: 0 },
      ],
    })
  ).rejects.toThrow('Invalid openai');
  await expect(
    fetchAllPages(
      'https://example.test',
      {},
      {},
      {
        request: async () =>
          Response.json({ data: [], has_more: true, next_page: 'same' }),
      }
    )
  ).rejects.toThrow('Invalid cost pagination');
});

test('shared library removal cannot bypass the portal recovery owner', async () => {
  await expect(
    removeWorktree({ workspace: '/unused' }, 'r', 'topic', { force: true })
  ).rejects.toMatchObject({ code: 'PORTAL_REQUIRED' });
});

test('resource admission validates limits and clamps effective CPU and memory capacity', () => {
  expect(() => resourceSettings({ containerMemoryLimit: 'broken' })).toThrow();
  expect(() => resourceSettings({ maxConcurrentDevServers: 1.5 })).toThrow();
  expect(() =>
    resourceSettings({ containerCpuLimit: Number.POSITIVE_INFINITY })
  ).toThrow();
  const config = {
    containerCpuLimit: 4,
    containerMemoryLimit: '7g',
    maxConcurrentDevServers: 4,
  };
  expect(effectiveContainerLimits(config, { cpus: 1, memMb: 28_089 }).max).toBe(
    1
  );
  expect(
    effectiveContainerLimits(config, { cpus: 16, memMb: 28_089 }).max
  ).toBe(3);
});

test('tunnel setup selects only the credential whose tunnel id matches', () => {
  const directory = mkdtempSync(join(tmpdir(), 'setu-credentials-'));
  const id = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
  try {
    writeFileSync(
      join(directory, `${id}.json`),
      JSON.stringify({ TunnelID: id })
    );
    writeFileSync(join(directory, 'unrelated.json'), '{}');
    expect(tunnelCredentials(directory, 'test', [{ id, name: 'test' }])).toBe(
      join(directory, `${id}.json`)
    );
    writeFileSync(
      join(directory, `${id}.json`),
      JSON.stringify({ TunnelID: 'wrong' })
    );
    expect(() =>
      tunnelCredentials(directory, 'test', [{ id, name: 'test' }])
    ).toThrow();
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
});

test('worktree target validation rejects traversal, flags, and unregistered paths', () => {
  for (const name of ['../a', '/a', 'a/../b', '-a', 'a\\b', 'a b']) {
    expect(() => validateWorktreeNames('r', name)).toThrow();
  }
  const workspace = mkdtempSync(join(tmpdir(), 'setu-unregistered-test-'));
  try {
    expect(() => managedWorktreePath(workspace, 'r', 'a')).toThrow(
      'not registered'
    );
  } finally {
    rmSync(workspace, { force: true, recursive: true });
  }
  expect(() => validateWorktreeNames('r', 'feature/a')).not.toThrow();
});

test('lsof output survives exit 1 when one requested range has no listener', async () => {
  const output = await spawnText(['lsof'], {
    spawn: () => ({
      exited: Promise.resolve(1),
      stdout: new Response('p42\ncfixture\nn*:3301\n').body,
    }),
  });
  expect(output).toContain('n*:3301');
});

test('PR routes use the checked-out feature branch and resolve the base before push', async () => {
  const workspace = mkdtempSync(join(tmpdir(), 'setu-pr-route-'));
  const commands = [];
  const state = {
    read: () => ({}),
    replaceText: async () => ({ committed: true }),
    update: async (_document, change) => change({}),
    withRouting: async (task) => task(),
    withTargets: async (_targets, task) => task(),
  };
  const lifecycle = {
    dispose() {
      /* The fixture has no lifecycle resources to release. */
    },
    operationStatus: () => null,
    queueSnapshot: () => [],
    refreshCapacity: async () => ({}),
    runOperation: (_target, _kind, task) => task(),
    snapshot: () => null,
    status: () => ({ max: 3 }),
  };
  try {
    const bare = join(workspace, 'r.git');
    const seed = join(workspace, 'seed');
    const git = (cwd, ...args) => {
      const result = Bun.spawnSync(['git', ...args], { cwd, stderr: 'pipe' });
      if (result.exitCode !== 0) {
        throw new Error(new TextDecoder().decode(result.stderr));
      }
    };
    git(workspace, 'init', '--bare', bare);
    git(workspace, 'init', seed);
    git(seed, 'config', 'user.email', 'fixture@example.test');
    git(seed, 'config', 'user.name', 'Fixture');
    writeFileSync(join(seed, 'README.md'), 'fixture\n');
    git(seed, 'add', 'README.md');
    git(seed, 'commit', '-m', 'fixture');
    git(seed, 'branch', '-M', 'staging');
    git(seed, 'remote', 'add', 'origin', bare);
    git(seed, 'push', 'origin', 'staging');
    git(bare, 'symbolic-ref', 'HEAD', 'refs/heads/staging');
    mkdirSync(join(workspace, 'r', 'topic'), { recursive: true });
    writeFileSync(join(workspace, '.ports'), 'r/topic:3001\n');
    writeFileSync(join(workspace, '.projects'), 'r:3000:o/r:Fixture\n');
    const command = (args, options = {}) => {
      commands.push(args);
      let stdout = '';
      if (args.includes('rev-list')) {
        stdout = '2\n';
      } else if (args[0] === 'gh' && args[2] === 'list') {
        stdout = '[]';
      } else if (args[0] === 'gh' && args[2] === 'create') {
        stdout = 'https://example.test/pr/1';
      } else if (args.includes('symbolic-ref')) {
        stdout = options.cwd?.endsWith('.git') ? 'staging' : 'feature/actual';
      }
      return Promise.resolve({
        code: 0,
        stderr: '',
        stdout,
        timedOut: false,
        truncated: false,
      });
    };
    const portal = await createPortalRuntime({
      command,
      config: { tunnel: 'fixture', workspace },
      lifecycle,
      projects: { r: { slug: 'o/r' } },
      state,
    });
    const response = await portal.internals.worktreeRoutes(
      new Request('http://localhost:2999/api/pr/create', {
        body: JSON.stringify({ name: 'topic', repo: 'r' }),
        method: 'POST',
      }),
      '/api/pr/create',
      'POST'
    );
    expect(await response.json()).toMatchObject({
      ok: true,
      url: 'https://example.test/pr/1',
    });
    expect(commands.find((args) => args.includes('rev-list'))).toContain(
      'origin/staging..HEAD'
    );
    expect(
      commands.find((args) => args[0] === 'git' && args[1] === 'push')
    ).toEqual(['git', 'push', '-u', 'origin', 'feature/actual']);
    expect(
      commands.find((args) => args[0] === 'gh' && args[2] === 'create')
    ).toEqual(
      expect.arrayContaining(['--head', 'feature/actual', '--base', 'staging'])
    );
    await expect(
      portal.internals.setPrReady('r', 'topic', true)
    ).resolves.toMatchObject({ ok: true });
    expect(
      commands.find(
        (args) => args[0] === 'gh' && args[1] === 'pr' && args[2] === 'ready'
      )
    ).toEqual(expect.arrayContaining(['feature/actual', '--repo', 'o/r']));
    await portal.dispose();
  } finally {
    rmSync(workspace, { force: true, recursive: true });
  }
});

test('dirty badges return immediately, observe a four-command cap, and recover a removed registration', async () => {
  const workspace = mkdtempSync(join(tmpdir(), 'setu-dirty-'));
  let active = 0;
  let peak = 0;
  let completed = 0;
  const lifecycle = {
    dispose() {
      /* The fixture has no lifecycle resources to release. */
    },
    operationStatus: () => null,
    queueSnapshot: () => [],
    refreshCapacity: async () => ({}),
    snapshot: () => null,
    status: () => ({ max: 3 }),
  };
  try {
    writeFileSync(
      join(workspace, '.ports'),
      `${Array.from(
        { length: 20 },
        (_, index) => `r/${index}:${3000 + index}`
      ).join('\n')}\n`
    );
    const portal = await createPortalRuntime({
      command: async () => {
        active += 1;
        peak = Math.max(peak, active);
        await Bun.sleep(5);
        active -= 1;
        completed += 1;
        return {
          code: 0,
          stderr: '',
          stdout: ' M a',
          timedOut: false,
          truncated: false,
        };
      },
      config: { tunnel: 'fixture', workspace },
      lifecycle,
    });
    const first = await Promise.all(
      Array.from({ length: 20 }, (_, index) =>
        portal.internals.fetchDirty('r', String(index))
      )
    );
    expect(first.every((value) => value === null)).toBe(true);
    for (let index = 0; index < 100 && completed < 20; index += 1) {
      // biome-ignore lint/performance/noAwaitInLoops: The bounded poll yields between observations until queued dirty reads finish.
      await Bun.sleep(5);
    }
    expect(peak).toBe(4);
    expect(completed).toBe(20);
    expect(await portal.internals.fetchDirty('r', '19')).toBe(1);
    await portal.internals.fetchDirty('r', 'gone');
    await Bun.sleep(5);
    expect(portal.internals.dirtyCache.get('r/gone')).toMatchObject({
      count: null,
      pending: false,
    });
    await portal.dispose();
  } finally {
    rmSync(workspace, { force: true, recursive: true });
  }
});

test('kill-port refuses out-of-range and changed owners before any signal', async () => {
  const signals = [];
  const portal = await runtime({
    activePid: async () => '222',
    signalProcess: (...args) => signals.push(args),
  });
  expect((await portal.internals.killPort(22)).ok).toBe(false);
  await expect(portal.internals.killPort(3000, 111)).resolves.toMatchObject({
    code: 'PORT_OWNER_CHANGED',
    ok: false,
  });
  expect(signals).toEqual([]);
  await portal.dispose();
});

test('actual POST dispatch records a failed action response in the isolated workspace log', async () => {
  const workspace = mkdtempSync(join(tmpdir(), 'setu-action-log-'));
  try {
    mkdirSync(join(workspace, 'logs'), { recursive: true });
    const portal = await createPortalRuntime({
      config: { tunnel: 'fixture', workspace },
      removals: {
        cancel: (id) => {
          if (id === 'crash') {
            return Promise.reject(new Error('route crash'));
          }
          return Promise.resolve({ error: 'refused', ok: false });
        },
      },
    });
    const response = await portal.handle(
      new Request('http://localhost:2999/api/remove/cancel', {
        body: JSON.stringify({ operationId: 'remove-1' }),
        method: 'POST',
      }),
      {
        requestIP: () => ({ address: '127.0.0.1' }),
        timeout() {
          /* The test server has no timeout side effect. */
        },
      }
    );
    expect(response.status).toBe(200);
    const entry = JSON.parse(
      readFileSync(join(workspace, 'logs', 'actions.log'), 'utf8').trim()
    );
    expect(entry).toMatchObject({
      error: 'refused',
      ok: false,
      route: '/api/remove/cancel',
    });
    const server = {
      requestIP: () => ({ address: '127.0.0.1' }),
      timeout() {
        /* The test server has no timeout side effect. */
      },
    };
    for (const [path, operationId, status] of [
      ['/api/remove/cancel', 'crash', 500],
      ['/api/unknown', '', 404],
    ]) {
      // biome-ignore lint/performance/noAwaitInLoops: Each route writes the same action log and must finish before checking its last entry.
      const failed = await portal.handle(
        new Request(`http://localhost:2999${path}`, {
          body: JSON.stringify({ operationId }),
          method: 'POST',
        }),
        server
      );
      expect(failed.status).toBe(status);
      const last = readFileSync(join(workspace, 'logs', 'actions.log'), 'utf8')
        .trim()
        .split('\n')
        .at(-1);
      expect(JSON.parse(last)).toMatchObject({ ok: false, route: path });
    }
    await portal.dispose();
  } finally {
    rmSync(workspace, { force: true, recursive: true });
  }
});

test('kill-port signals only the confirmed listener when Stop fails and the container is proven absent', async () => {
  const workspace = mkdtempSync(join(tmpdir(), 'setu-kill-port-'));
  const signals = [];
  let stopped = { ok: true };
  let container = 'dead';
  writeFileSync(join(workspace, '.ports'), 'r/topic:3005\n');
  const portal = await createPortalRuntime({
    activePid: async () => '700\n701',
    command: async () => ({
      code: container === 'unknown' ? 1 : 0,
      stdout: container === 'alive' ? 'container-id' : '',
      timedOut: false,
    }),
    config: { tunnel: 'fixture', workspace },
    lifecycle: {
      dispose() {
        /* The fixture has no lifecycle resources to release. */
      },
      stop: async () => stopped,
    },
    signalProcess: (...args) => signals.push(args),
  });
  try {
    const kill = portal.internals.killPort;
    await expect(kill(3005, 701)).resolves.toEqual({ ok: true });
    stopped = { code: 'STOP_FAILED', error: 'unidentified', ok: false };
    for (const state of ['alive', 'unknown', 'dead']) {
      container = state;
      // biome-ignore lint/performance/noAwaitInLoops: Each kill observation must finish before mutating the shared container state for the next case.
      await expect(
        kill(3005, state === 'dead' ? undefined : 701)
      ).resolves.toEqual(stopped);
    }
    expect(signals).toEqual([]);
    await expect(kill(3005, 701)).resolves.toEqual({ ok: true, pid: 701 });
    expect(signals).toEqual([[701, 'SIGTERM']]);
    await expect(kill(3005, 999)).resolves.toMatchObject({
      code: 'PORT_OWNER_CHANGED',
    });
    expect(signals).toHaveLength(1);
  } finally {
    await portal.dispose();
    rmSync(workspace, { force: true, recursive: true });
  }
});

test('settings GET reconciles an uncertain committed config before reopening dependent actions', async () => {
  const workspace = mkdtempSync(join(tmpdir(), 'setu-settings-reconcile-'));
  let installed = { maxConcurrentDevServers: 1, workspace };
  const applied = [];
  const portal = await createPortalRuntime({
    config: installed,
    lifecycle: {
      dispose() {
        /* The fixture has no lifecycle resources to release. */
      },
      refreshCapacity: async () => ({}),
      status: () => ({ max: installed.maxConcurrentDevServers }),
      updateSettings: async (settings) => applied.push(settings),
    },
    state: {
      read: () => installed,
      update: (_document, update) => {
        try {
          installed = update(installed);
          return Promise.resolve({
            committed: true,
            reconciled: false,
            status: 'uncertain',
          });
        } catch (error) {
          return Promise.reject(error);
        }
      },
      withTargets: (_targets, task) => task(),
    },
  });
  try {
    const route = portal.internals.settingsRoutes;
    const response = await route(
      new Request('http://localhost:2999/api/settings', {
        body: JSON.stringify({
          containerCpuLimit: 3,
          containerMemoryLimit: '8g',
          maxConcurrentDevServers: 4,
        }),
        method: 'POST',
      }),
      '/api/settings',
      'POST'
    );
    expect(await response.json()).toMatchObject({
      code: 'STATE_RECONCILIATION_REQUIRED',
      ok: false,
    });
    expect(applied).toEqual([]);
    expect(
      await (await route({}, '/api/settings', 'GET')).json()
    ).toMatchObject({
      containerCpuLimit: 3,
      containerMemoryLimit: '8g',
      maxConcurrentDevServers: 4,
    });
    expect(applied).toEqual([installed]);
    await route({}, '/api/settings', 'GET');
    expect(applied).toHaveLength(1);
  } finally {
    await portal.dispose();
    rmSync(workspace, { force: true, recursive: true });
  }
});

test('worktree native memory includes sidecars once and excludes other worktrees', async () => {
  const portal = await runtime({
    processMemory: async () => [
      { pgid: 1, pid: 1, ppid: 0, rss: 10 },
      { pgid: 2, pid: 2, ppid: 0, rss: 10 },
      { pgid: 3, pid: 3, ppid: 0, rss: 10 },
      { pgid: 4, pid: 4, ppid: 0, rss: 10 },
      { pgid: 1, pid: 8, ppid: 1, rss: 20 },
    ],
  });
  const state = portal.internals.runtimeState;
  state.inngestProcs.set('r/a', { pid: 2 });
  state.sidecarProcs.set('r/a/worker', { pid: 3 });
  state.sidecarProcs.set('other/a/worker', { pid: 4 });
  const rows = await portal.internals.worktreeProcessTree('r/a', { pid: 1 });
  expect(rows.map((row) => row.pid).sort()).toEqual([1, 2, 3, 8]);
  await portal.dispose();
});

test('log truncation keeps the live append descriptor usable', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'setu-log-'));
  const path = join(directory, 'dev.log');
  const max = 5 * 1024 * 1024;
  writeFileSync(path, `${'x'.repeat(max * 3)}tail`);
  const fd = openSync(path, 'a');
  try {
    const portal = await runtime();
    portal.internals.trimLog(path);
    writeSync(fd, 'still-writing');
    expect(statSync(path).size).toBe(max / 2 + 'still-writing'.length);
    expect(readFileSync(path, 'utf8').endsWith('tailstill-writing')).toBe(true);
    await portal.dispose();
  } finally {
    closeSync(fd);
    rmSync(directory, { force: true, recursive: true });
  }
});
