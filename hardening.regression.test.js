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
import {
  effectiveContainerLimits,
  managedWorktreePath,
  portalRequestError,
  removeWorktree,
  resourceSettings,
  tunnelCredentials,
  validateWorktreeNames,
} from './lib.js';

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
    (await handle(new Request('http://localhost:2999/api/projects'), server))
      .status
  ).toBe(200);
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
      lifecycle: { runOperation: (_target, _kind, task) => task() },
      prCache: new Map(),
      REPO_META: { r: { slug: 'o/r' } },
      spawnRun: async (_cwd, args) => {
        commands.push(args);
        return 'https://example.test/pr/1';
      },
      worktreeBranch: () => Promise.resolve('feature/actual'),
      worktreeTarget: (repo, name) => ({ name, repo }),
      wtPath: () => '/r/directory',
    }
  );
  await createPr('r', 'directory');
  await setPrReady('r', 'directory', true);
  expect(commands[0]).toContain('feature/actual');
  expect(commands[2]).toContain('feature/actual');
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
  expect(peak).toBe(4);
  for (let i = 0; i < 100 && completed < 20; i += 1) {
    await Bun.sleep(5);
  }
  expect(completed).toBe(20);
  expect(active).toBe(0);
  expect(await fetchDirty('r', '19')).toBe(1);
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
