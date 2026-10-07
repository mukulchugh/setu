import { expect, test } from 'bun:test';
import {
  closeSync,
  ftruncateSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readSync,
  rmSync,
  statSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isAbsolute, relative, sep } from 'node:path';
import {
  effectiveContainerLimits,
  baseBranchRef,
  managedWorktreePath,
  portalRequestError,
  removeWorktree,
  resourceSettings,
  tunnelCredentials,
  validateWorktreeNames,
} from './lib.js';
import { artifactHtmlPath } from './pr-review.js';

// Load real functions without importing the portal, which starts a server.
function load(file, names, deps, state = '') {
  const source = readFileSync(new URL(file, import.meta.url), 'utf8');
  new Bun.Transpiler({ loader: 'js' }).transformSync(source);
  const declarations = names.map((name) => {
    const match = source.match(
      new RegExp(`^(?:export )?(?:async )?function ${name}\\([^]*?^}`, 'm')
    );
    if (!match) {
      throw new Error(`Missing ${name}`);
    }
    return match[0].replace(/^export /, '');
  });
  return Function(
    ...Object.keys(deps),
    `${state}\n${declarations.join('\n')}\nreturn {${names.join(',')}}`
  )(...Object.values(deps));
}

test('shared HTTP boundary rejects foreign Host, Origin, and forwarded remote clients before routing', async () => {
  let routed = 0;
  const { handle } = load('./portal.js', ['handle'], {
    logAction() {
      /* No side effect is needed in this fixture. */
    },
    portalRequestError: (...args) => portalRequestError(...args),
    routeRequest: async () => {
      routed += 1;
      return Response.json({ ok: true });
    },
  });
  const server = { requestIP: () => ({ address: '127.0.0.1' }) };
  for (const headers of [
    { host: 'foreign.invalid' },
    { origin: 'https://foreign.invalid' },
    { 'x-forwarded-for': '192.168.1.4' },
  ]) {
    const response = await handle(
      new Request('http://localhost:2999/api/projects', { headers }),
      server
    );
    expect(response.status).toBe(403);
  }
  expect(routed).toBe(0);
  expect(
    readFileSync(new URL('./portal.js', import.meta.url), 'utf8')
  ).toContain("hostname: '127.0.0.1'");
  expect(
    (await handle(new Request('http://localhost:2999/api/projects'), server))
      .status
  ).toBe(200);
});

test('request entry point uses the real guard for remote peers and cross-site POSTs', async () => {
  let routed = 0;
  const { handle } = load('./portal.js', ['handle'], {
    portalRequestError: (...args) => portalRequestError(...args),
    routeRequest: async () => {
      routed += 1;
      return Response.json({ ok: true });
    },
  });
  const remote = { requestIP: () => ({ address: '192.168.1.4' }) };
  expect(
    (await handle(new Request('http://localhost:2999/api/projects'), remote))
      .status
  ).toBe(403);
  const local = { requestIP: () => ({ address: '127.0.0.1' }) };
  expect(
    (
      await handle(
        new Request('http://localhost:2999/api/start', {
          headers: { origin: 'https://foreign.invalid' },
          method: 'POST',
        }),
        local
      )
    ).status
  ).toBe(403);
  expect(routed).toBe(0);
});

test('OAuth callback markup escapes error and error_description and locks down the page', async () => {
  const { mcpCallbackHtml, mcpRoutes } = load(
    './portal.js',
    ['mcpCallbackHtml', 'mcpRoutes'],
    {
      finishMcpAuth: async () => ({ ok: true }),
      loadMcpServers: () => [],
    }
  );
  const response = await mcpRoutes(
    new Request(
      'http://localhost:2999/api/mcp/oauth/callback/x?error=%3Cimg%3E&error_description=%3Cscript%3Ebad%3C%2Fscript%3E'
    ),
    '/api/mcp/oauth/callback/x',
    'GET'
  );
  const html = await response.text();
  expect(html).not.toContain('<script>bad</script>');
  expect(html).not.toContain('<img>');
  expect(html).toContain('&lt;script&gt;bad&lt;/script&gt;');
  const errorResponse = await mcpRoutes(
    new Request(
      'http://localhost:2999/api/mcp/oauth/callback/x?error=%3Cimg%3E'
    ),
    '/api/mcp/oauth/callback/x',
    'GET'
  );
  expect(await errorResponse.text()).toContain('&lt;img&gt;');
  expect(response.headers.get('content-security-policy')).toContain(
    "default-src 'none'"
  );
  expect(response.headers.get('x-frame-options')).toBe('DENY');
  expect(response.headers.get('x-content-type-options')).toBe('nosniff');
  expect((await mcpCallbackHtml('<b>', '<i>')).status).toBe(200);
});

test('PR review artifacts cannot escape their snapshot data directory', () => {
  expect(
    artifactHtmlPath('owner/repo', 7, 'pr-walkthrough', '../outside', 'x.html')
  ).toBeNull();
  expect(
    artifactHtmlPath('owner/repo', 7, 'pr-walkthrough', 'snap', '../x.html')
  ).toBeNull();
});

test('runtime discovery accepts nested worktree directories but not sibling prefixes', () => {
  const { worktreeContains } = load('./portal.js', ['worktreeContains'], {
    isAbsolute,
    relative,
    sep,
  });
  expect(
    worktreeContains('/workspace/repo/topic', '/workspace/repo/topic')
  ).toBe(true);
  expect(
    worktreeContains('/workspace/repo/topic', '/workspace/repo/topic/apps/web')
  ).toBe(true);
  expect(
    worktreeContains('/workspace/repo/topic', '/workspace/repo/topic-other')
  ).toBe(false);
});

test('project setup target validates names without requiring a registered project', () => {
  const { projectSetupTarget } = load('./portal.js', ['projectSetupTarget'], {
    WORKSPACE: '/workspace',
    composeProjectName: () => 'compose',
    join,
    repoPath: (repo) => `/workspace/${repo}.git`,
    validateWorktreeNames: (repo, name) => {
      if (!(repo && name)) throw new Error('invalid');
    },
  });
  expect(projectSetupTarget('new-project')).toMatchObject({
    repoDir: '/workspace/new-project.git',
    wtDir: '/workspace/new-project/main',
  });
});

// Dirty/force/partial-removal cases exercise the imported production controller
// in worktree-removal.test.js; this former bypass must refuse every caller.
test('shared library removal cannot bypass the portal recovery owner', async () => {
  await expect(
    removeWorktree({ workspace: '/unused' }, 'r', 'topic', { force: true })
  ).rejects.toMatchObject({ code: 'PORTAL_REQUIRED' });
});

test('PR create and ready use the checked-out branch, not the directory name', async () => {
  const commands = [];
  const { createPr, setPrReady } = load(
    './portal.js',
    ['createPr', 'setPrReady'],
    {
      baseBranchRef: () => 'origin/staging',
      lifecycle: { runOperation: (_target, _kind, task) => task() },
      prCache: new Map(),
      REPO_META: { r: { slug: 'o/r' } },
      repoPath: () => '/bare/r.git',
      spawnRun: async (_cwd, args) => {
        commands.push(args);
        if (args.includes('rev-list')) return '1';
        if (args[0] === 'gh' && args[2] === 'list') return '[]';
        return 'https://example.test/pr/1';
      },
      worktreeBranch: () => Promise.resolve('feature/actual'),
      worktreeTarget: (repo, name) => ({ name, repo }),
      wtPath: () => '/r/directory',
    }
  );
  await createPr('r', 'directory');
  await setPrReady('r', 'directory', true);
  expect(commands[2]).toContain('feature/actual');
  expect(commands[4]).toContain('feature/actual');
});

test('PR creation checks branch state before push and targets the resolved base', async () => {
  const commands = [];
  const { createPr } = load('./portal.js', ['createPr'], {
    baseBranchRef: () => 'origin/staging',
    lifecycle: { runOperation: (_target, _kind, task) => task() },
    prCache: new Map(),
    REPO_META: { r: { slug: 'o/r' } },
    repoPath: () => '/bare/r.git',
    spawnRun: async (_cwd, args) => {
      commands.push(args);
      if (args[0] === 'git' && args.includes('rev-list')) return '2\n';
      if (args[0] === 'gh' && args[1] === 'pr' && args[2] === 'list')
        return '[]';
      return 'https://example.test/pr/1';
    },
    worktreeBranch: () => Promise.resolve('feature/actual'),
    worktreeTarget: (repo, name) => ({ name, repo }),
    wtPath: () => '/r/directory',
  });
  await createPr('r', 'directory');
  expect(commands[0]).toEqual([
    'git',
    'rev-list',
    '--count',
    'origin/staging..HEAD',
  ]);
  expect(commands[1]).toContain('--head');
  expect(commands[2]).toEqual([
    'git',
    'push',
    '-u',
    'origin',
    'feature/actual',
  ]);
  expect(commands[3]).toContain('--base');
  expect(commands[3]).toContain('staging');
});

test('PR creation derives staging from the real base branch helper before pushing', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'setu-pr-base-'));
  const bare = join(directory, 'repo.git');
  const source = join(directory, 'source');
  const git = (cwd, ...args) => {
    const result = Bun.spawnSync(['git', ...args], { cwd, stderr: 'pipe' });
    if (result.exitCode !== 0) {
      throw new Error(new TextDecoder().decode(result.stderr));
    }
  };
  try {
    git(directory, 'init', '--bare', bare);
    git(directory, 'init', source);
    git(source, 'config', 'user.email', 'test@example.test');
    git(source, 'config', 'user.name', 'Test');
    writeFileSync(join(source, 'file'), 'one');
    git(source, 'add', 'file');
    git(source, 'commit', '-m', 'initial');
    git(source, 'branch', '-M', 'staging');
    git(source, 'remote', 'add', 'origin', bare);
    git(source, 'push', '-u', 'origin', 'staging');
    const commands = [];
    const { createPr } = load('./portal.js', ['createPr'], {
      baseBranchRef,
      lifecycle: { runOperation: (_target, _kind, task) => task() },
      prCache: new Map(),
      REPO_META: { r: { slug: 'o/r' } },
      repoPath: () => bare,
      spawnRun: async (_cwd, args) => {
        commands.push(args);
        if (args.includes('rev-list')) return '1';
        if (args[0] === 'gh' && args[2] === 'list') return '[]';
        return 'https://example.test/pr/1';
      },
      worktreeBranch: () => Promise.resolve('feature/actual'),
      worktreeTarget: (repo, name) => ({ name, repo }),
      wtPath: () => source,
    });
    await createPr('r', 'topic');
    expect(commands[0]).toContain('origin/staging..HEAD');
    expect(commands.at(-1)).toContain('staging');
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
});

test('partial cost data never produces a healthy combined budget', () => {
  const { computeBudgets } = load(
    './costs.js',
    ['round2', 'budgetStatus', 'computeBudgets'],
    {}
  );
  const budgets = computeBudgets({ budgets: { daily: 100 } }, [
    { configured: true, last1d: 10, provider: 'openai' },
    { configured: true, error: 'timeout', provider: 'anthropic' },
  ]);
  expect(budgets.daily.status).toBe('incomplete');
  expect(budgets.daily.spent).toBe(10);
  expect(
    computeBudgets({ budgets: { daily: 100 } }, [{ configured: false }]).daily
      .status
  ).toBe('incomplete');
  expect(
    computeBudgets({ budgets: { daily: 3 } }, [
      { configured: true, last1d: 2.4, last30d: 0, last7d: 0 },
    ]).daily.status
  ).toBe('warning');
  expect(
    computeBudgets({ budgets: { daily: 3 } }, [
      { configured: true, last1d: Number.NaN, last30d: 0, last7d: 0 },
    ]).daily.status
  ).toBe('incomplete');
});

test('missing provider amounts make that provider incomplete instead of adding zero or strings', async () => {
  const { anthropicCosts, openaiCosts } = load(
    './costs.js',
    [
      'round2',
      'windowTotal',
      'summarize',
      'rfc3339',
      'anthropicCosts',
      'openaiCosts',
    ],
    {
      WINDOW_DAYS: 30,
      fetchAllPages: async (url) =>
        url.includes('anthropic')
          ? [{ results: [{ amount: null }], starting_at: '2026-01-01' }]
          : [{ results: [{ amount: { value: null } }], start_time: 0 }],
    }
  );
  await expect(anthropicCosts('key')).rejects.toThrow('Invalid anthropic');
  await expect(openaiCosts('key')).rejects.toThrow('Invalid openai');
});

test('resource admission respects effective CPU, aggregate memory, and retained old limits', () => {
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
  // Aggregate and retained-limit behavior runs through createWorktreeLifecycle
  // in worktree-lifecycle.test.js, rather than copied portal functions.
});

test('log retention keeps the existing append descriptor usable during a long session', () => {
  const directory = mkdtempSync(join(tmpdir(), 'setu-log-'));
  const path = join(directory, 'dev.log');
  const max = 1024 * 1024;
  writeFileSync(path, `${'x'.repeat(max * 3)}tail`);
  const fd = openSync(path, 'a');
  const inode = statSync(path).ino;
  try {
    const { trimLog } = load('./portal.js', ['trimLog'], {
      Buffer,
      closeSync,
      console,
      ftruncateSync,
      LOG_MAX_BYTES: max,
      openSync,
      readSync,
      statSync,
      writeSync,
    });
    trimLog(path);
    expect(statSync(path).size).toBe(max / 2);
    expect(statSync(path).ino).toBe(inode);
    writeSync(fd, 'still-writing');
    expect(readFileSync(path, 'utf8').endsWith('tailstill-writing')).toBe(true);
  } finally {
    closeSync(fd);
    rmSync(directory, { recursive: true });
  }
});

test('setup chooses credentials by exact tunnel ID and rejects mismatches', () => {
  const directory = mkdtempSync(join(tmpdir(), 'setu-credentials-'));
  const id = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
  try {
    writeFileSync(
      join(directory, `${id}.json`),
      JSON.stringify({ TunnelID: id })
    );
    writeFileSync(join(directory, 'newer-unrelated.json'), '{}');
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
    rmSync(directory, { recursive: true });
  }
});

test('dirty badges return immediately and drain all checks with bounded concurrency', async () => {
  let active = 0,
    peak = 0,
    completed = 0;
  const cache = new Map();
  const { fetchDirty } = load(
    './portal.js',
    ['fetchDirty', 'drainDirtyQueue'],
    {
      DIRTY_TTL: 15_000,
      dirtyCache: cache,
      spawnRun: async () => {
        active += 1;
        peak = Math.max(peak, active);
        await Bun.sleep(5);
        active -= 1;
        completed += 1;
        return ' M a';
      },
      wtPath: (_repo, name) => name,
    },
    'let dirtyChecks = 0; const dirtyQueue = [];'
  );
  const first = await Promise.all(
    Array.from({ length: 20 }, (_, i) => fetchDirty('r', String(i)))
  );
  expect(first.every((x) => x === null)).toBe(true);
  await Bun.sleep(1);
  expect(peak).toBe(4);
  for (let i = 0; i < 100 && completed < 20; i += 1) {
    await Bun.sleep(5);
  }
  expect(completed).toBe(20);
  expect(active).toBe(0);
  expect(await fetchDirty('r', '19')).toBe(1);
});

test('dirty queue always releases a slot when a removed worktree makes path resolution fail', async () => {
  const cache = new Map();
  const { fetchDirty } = load(
    './portal.js',
    ['fetchDirty', 'drainDirtyQueue'],
    {
      DIRTY_TTL: 15_000,
      dirtyCache: cache,
      spawnRun: async () => ' M a',
      wtPath: (_repo, name) => {
        if (name === 'gone') throw new Error('Worktree is not registered');
        return name;
      },
    },
    'let dirtyChecks = 0; const dirtyQueue = [];'
  );
  await fetchDirty('r', 'gone');
  await fetchDirty('r', 'live');
  await Bun.sleep(10);
  expect(cache.get('r/gone')).toMatchObject({ count: null, pending: false });
  expect(cache.get('r/live')).toMatchObject({ count: 1, pending: false });
});

test('POST action logging marks HTTP failures and thrown routes as failed', async () => {
  const entries = [];
  const updateControl = { mutate: (task) => task() };
  const { handle } = load('./portal.js', ['handle'], {
    logAction: (...args) => entries.push(args),
    portalRequestError: (...args) => portalRequestError(...args),
    routeRequest: async () => new Response('Not found', { status: 404 }),
    updateControl,
  });
  const server = {
    requestIP: () => ({ address: '127.0.0.1' }),
    timeout() {
      /* Recorded by the production server. */
    },
  };
  expect(
    (
      await handle(
        new Request('http://localhost:2999/api/unknown', {
          body: '{}',
          method: 'POST',
        }),
        server
      )
    ).status
  ).toBe(404);
  expect(entries[0][2]).toBe(false);
  const throwing = load('./portal.js', ['handle'], {
    logAction: (...args) => entries.push(args),
    portalRequestError: (...args) => portalRequestError(...args),
    routeRequest: async () => {
      throw new Error('route crash');
    },
    updateControl,
  });
  const response = await throwing.handle(
    new Request('http://localhost:2999/api/boom', {
      body: '{}',
      method: 'POST',
    }),
    server
  );
  expect(response.status).toBe(500);
  expect(entries.at(-1)[2]).toBe(false);
});

test('kill by port is limited to managed ranges and refuses a changed owner', async () => {
  const { killPort } = load('./portal.js', ['killPort'], {
    activePidAsync: async () => '222',
    portEntries: () => [],
    process: { kill() {} },
    stopWorktree: async () => ({ ok: true }),
    WORKSPACE: '/workspace',
  });
  expect((await killPort(22)).ok).toBe(false);
  await expect(killPort(3000, 111)).resolves.toMatchObject({
    code: 'PORT_OWNER_CHANGED',
    ok: false,
  });
});

test('kill by port signals the confirmed process only when Stop cannot identify it and no container publishes the port', async () => {
  const signalled = [];
  const make = (containerState, stopResult) =>
    load('./portal.js', ['killPort'], {
      activePidAsync: async () => '700\n701',
      composeProjectName: (repo, name) => `${repo}-${name}`,
      containerState: async () => containerState,
      portEntries: () => [{ name: 'feature', port: 3005, repo: 'r' }],
      process: { kill: (pid, signal) => signalled.push([pid, signal]) },
      stopWorktree: async () => stopResult,
      WORKSPACE: '/workspace',
    }).killPort;
  const refused = { code: 'STOP_FAILED', error: 'unidentified', ok: false };

  // Stop worked: nothing else is signalled.
  await expect(make('dead', { ok: true })(3005, 701)).resolves.toEqual({
    ok: true,
  });
  // Stop failed but a container may publish the port: the helper is never signalled.
  await expect(make('alive', refused)(3005, 701)).resolves.toEqual(refused);
  await expect(make('unknown', refused)(3005, 701)).resolves.toEqual(refused);
  // Stop failed and no pid was confirmed by the caller: still refused.
  await expect(make('dead', refused)(3005)).resolves.toEqual(refused);
  expect(signalled).toEqual([]);
  // Stop failed, bare worktree, caller confirmed one of the listed pids.
  await expect(make('dead', refused)(3005, 701)).resolves.toEqual({
    ok: true,
    pid: 701,
  });
  expect(signalled).toEqual([[701, 'SIGTERM']]);
  // A pid that no longer holds the port is refused.
  await expect(make('dead', refused)(3005, 999)).resolves.toMatchObject({
    code: 'PORT_OWNER_CHANGED',
  });
});

test('sidecar approval compares the command and arguments displayed to the client', async () => {
  let received;
  const { settingsRoutes } = load('./portal.js', ['settingsRoutes'], {
    WORKSPACE: '/workspace',
    approveSidecar: async (...args) => {
      received = args;
      return { committed: false, reconciled: true, status: 'unchanged' };
    },
    jsonTry: async (fn) => Response.json(await fn()),
    persistedAction: (value) => ({ ok: true, value }),
  });
  const response = await settingsRoutes(
    new Request('http://localhost:2999/api/sidecar-approvals/approve', {
      body: JSON.stringify({
        args: ['dev', '--safe'],
        command: 'worker',
        name: 'queue',
        repo: 'r',
      }),
      method: 'POST',
    }),
    '/api/sidecar-approvals/approve',
    'POST'
  );
  expect(response.status).toBe(200);
  expect(received).toEqual([
    '/workspace',
    'r',
    'queue',
    'worker',
    ['dev', '--safe'],
  ]);
});

test('remove cancellation is dispatched to the removal controller', async () => {
  let operationId;
  const { worktreeRoutes } = load('./portal.js', ['worktreeRoutes'], {
    removals: {
      cancel: async (id) => {
        operationId = id;
        return { ok: true };
      },
    },
  });
  const response = await worktreeRoutes(
    new Request('http://localhost:2999/api/remove/cancel', {
      body: JSON.stringify({ operationId: 'remove-1' }),
      method: 'POST',
    }),
    '/api/remove/cancel',
    'POST'
  );
  expect(await response.json()).toEqual({ ok: true });
  expect(operationId).toBe('remove-1');
});

test('worktree native memory includes separate sidecars and deduplicates shared descendants', async () => {
  const { worktreeProcessTree } = load('./portal.js', ['worktreeProcessTree'], {
    convexDevProcs: new Map(),
    inngestProcs: new Map([['r/a', { pid: 2 }]]),
    processTree: async (entry) => [
      { pid: entry.pid, rss: 10 },
      { pid: 8, rss: 20 },
    ],
    sidecarProcs: new Map([
      ['r/a/s', { pid: 3 }],
      ['other/a/s', { pid: 4 }],
    ]),
    triggerProcs: new Map(),
  });
  expect(
    (await worktreeProcessTree('r/a', { pid: 1 })).map((row) => row.pid).sort()
  ).toEqual([1, 2, 3, 8]);
});

test('cost pagination rejects repeated cursors instead of looping forever', async () => {
  let calls = 0;
  const { fetchAllPages } = load('./costs.js', ['fetchAllPages'], {
    fetch: async () => {
      calls += 1;
      return Response.json({ data: [], has_more: true, next_page: 'same' });
    },
  });
  await expect(
    fetchAllPages('https://example.test/costs', {}, {})
  ).rejects.toThrow('pagination');
  expect(calls).toBe(2);
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
    rmSync(workspace, { recursive: true });
  }
  expect(() => validateWorktreeNames('r', 'feature/a')).not.toThrow();
});

test('lsof output survives exit 1 when one requested port range has no listeners', async () => {
  const { spawnText } = load('./lib.js', ['spawnText'], {
    Bun: {
      spawn: () => ({
        exited: Promise.resolve(1),
        stdout: new Response('p42\ncfixture\nn*:3301\n').body,
      }),
    },
  });
  expect(await spawnText(['lsof'])).toContain('n*:3301');
});

test('settings GET reconciles an uncertain committed config before reopening dependent actions', async () => {
  const installed = {
    containerCpuLimit: 3,
    containerMemoryLimit: '8g',
    maxConcurrentDevServers: 4,
    workspace: '/owned',
  };
  const applied = [];
  const { settingsRoutes } = load(
    './portal.js',
    ['settingsRoutes'],
    {
      _cfg: { maxConcurrentDevServers: 1, workspace: '/owned' },
      cachedContainerRuntime: () => Promise.resolve({}),
      lifecycle: {
        status: () => ({ max: installed.maxConcurrentDevServers }),
        updateSettings: async (value) => applied.push(value),
      },
      macCapacity: () => ({}),
      Response,
      requireConfig: () => installed,
      resourceSettings,
      WORKSPACE: '/owned',
    },
    'let configReconciled = false;'
  );
  const result = await (
    await settingsRoutes({}, '/api/settings', 'GET')
  ).json();
  expect(result).toMatchObject({
    containerCpuLimit: 3,
    containerMemoryLimit: '8g',
    maxConcurrentDevServers: 4,
  });
  expect(applied).toEqual([installed]);
  await settingsRoutes({}, '/api/settings', 'GET');
  expect(applied.length).toBe(1);
});
