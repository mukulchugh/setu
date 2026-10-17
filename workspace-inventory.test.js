import { expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import {
  readFile as readFileAsync,
  realpath as realpathAsync,
  stat as statAsync,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inspectCheckoutIdentity } from './checkout-identity.js';
import { workspaceInventoryRegistry } from './lib.js';
import { createPortalRuntime } from './portal.js';
import { createWorktreeAdoption } from './portal-adoption.js';
import {
  createWorkspaceInventory,
  parseLinkedWorktrees,
} from './workspace-inventory.js';

const sha = 'a'.repeat(40);
const record = (path, branch = 'feature/nested', extras = []) =>
  [
    `worktree ${path}`,
    `HEAD ${sha}`,
    branch ? `branch refs/heads/${branch}` : 'detached',
    ...extras,
    '',
    '',
  ].join('\0');
const result = (stdout, overrides = {}) => ({
  code: 0,
  stdout,
  timedOut: false,
  truncated: false,
  ...overrides,
});
const registered = (name, repo = 'r') => ({
  key: `${repo}/${name}`,
  name,
  path: `/workspace/${repo}/${name}`,
  port: 3000,
  repo,
});
const project = (repo = 'r') => ({ repo, repoDir: `/workspace/${repo}.git` });
const directory = async () => ({ isDirectory: () => true });

function adoptionFixture(overrides = {}) {
  const calls = [];
  const records = {};
  let port = null;
  const adoption = createWorktreeAdoption({
    // biome-ignore lint/suspicious/useAwait: Port allocation preserves the asynchronous adoption collaborator contract.
    assignPort: async (...args) => {
      calls.push(['assignPort', ...args]);
      port = 3201;
      return port;
    },
    expectedPath: (repo, name) => `/workspace/${repo}/${name}`,
    inspectIdentity: async () => ({
      checkoutPath: '/workspace/r/topic',
      known: true,
    }),
    // biome-ignore lint/suspicious/useAwait: Checkout lookup preserves the asynchronous adoption collaborator contract.
    isLinkedWorktree: async (...args) => {
      calls.push(['isLinkedWorktree', ...args]);
      return true;
    },
    isRegisteredProject: (repo) => repo === 'r',
    readRecords: async () => structuredClone(records),
    registeredPort: () => port,
    validateTarget: (repo, name, path) => ({
      name,
      repo,
      wtDir: `/workspace/${repo}/${name}`,
      ...(path === `/workspace/${repo}/${name}` ? {} : { invalid: true }),
    }),
    withRecords: (task) => task(),
    withTarget: (_target, task) => task(),
    // biome-ignore lint/suspicious/useAwait: Record mutation and clone failures must reject through the persistence contract.
    writeRecords: async (next) => {
      for (const key of Object.keys(records)) {
        delete records[key];
      }
      Object.assign(records, structuredClone(next));
    },
    // biome-ignore lint/suspicious/useAwait: Routing writes preserve the asynchronous adoption collaborator contract.
    writeRouting: async (...args) => {
      calls.push(['writeRouting', ...args]);
      return { ok: true };
    },
    ...overrides,
  });
  return { adoption, calls, records };
}

test('adoption verifies a managed linked checkout before allocating its port and routing', async () => {
  const { adoption, calls } = adoptionFixture();
  expect(
    await adoption.adopt({
      name: 'topic',
      path: '/workspace/r/topic',
      repo: 'r',
    })
  ).toEqual({
    name: 'topic',
    ok: true,
    path: '/workspace/r/topic',
    port: 3201,
    repo: 'r',
  });
  expect(calls).toEqual([
    ['isLinkedWorktree', 'r', '/workspace/r/topic'],
    ['isLinkedWorktree', 'r', '/workspace/r/topic'],
    ['assignPort', 'r', 'topic'],
    ['writeRouting', 'r', 'topic', 3201],
  ]);
});

test('adoption refuses unregistered projects, registered names, unknown identities and non-linked paths', async () => {
  expect(
    await adoptionFixture().adoption.adopt({
      name: 'topic',
      path: '/workspace/other/topic',
      repo: 'other',
    })
  ).toMatchObject({ code: 'PROJECT_NOT_REGISTERED', ok: false });
  expect(
    await adoptionFixture({ registeredPort: () => 3200 }).adoption.adopt({
      name: 'topic',
      path: '/workspace/r/topic',
      repo: 'r',
    })
  ).toMatchObject({ code: 'WORKTREE_ALREADY_REGISTERED', ok: false });
  expect(
    await adoptionFixture({
      inspectIdentity: async () => ({ known: false }),
    }).adoption.adopt({
      name: 'topic',
      path: '/workspace/r/topic',
      repo: 'r',
    })
  ).toMatchObject({ code: 'CHECKOUT_IDENTITY_UNKNOWN', ok: false });
  expect(
    await adoptionFixture({
      isLinkedWorktree: async () => false,
    }).adoption.adopt({
      name: 'topic',
      path: '/workspace/r/topic',
      repo: 'r',
    })
  ).toMatchObject({ code: 'WORKTREE_NOT_LINKED', ok: false });
  expect(
    await adoptionFixture().adoption.adopt({
      name: 'topic',
      path: '/outside/topic',
      repo: 'r',
    })
  ).toMatchObject({ code: 'ADOPTION_PATH_INVALID', ok: false });
});

test('adoption retains exact identity for hosts and Caddy recovery without reallocating the port', async () => {
  const results = [
    {
      code: 'ADOPTION_HOSTS_PENDING',
      error: 'Hosts routing could not be applied',
      ok: false,
    },
    {
      code: 'ADOPTION_CADDY_PENDING',
      error: 'Caddy routing could not be reloaded',
      ok: false,
    },
    { ok: true },
  ];
  const { adoption, calls, records } = adoptionFixture({
    // biome-ignore lint/suspicious/useAwait: Routing retries preserve the asynchronous collaborator contract.
    writeRouting: async (...args) => {
      calls.push(['writeRouting', ...args]);
      return results.shift();
    },
  });
  const input = { name: 'topic', path: '/workspace/r/topic', repo: 'r' };
  await expect(adoption.adopt(input)).resolves.toMatchObject({
    code: 'ADOPTION_HOSTS_PENDING',
    ok: false,
    port: 3201,
  });
  expect(records['r/topic']).toMatchObject({ name: 'topic', repo: 'r' });
  await expect(adoption.adopt(input)).resolves.toMatchObject({
    code: 'ADOPTION_CADDY_PENDING',
    ok: false,
    port: 3201,
  });
  await expect(adoption.adopt(input)).resolves.toMatchObject({
    ok: true,
    port: 3201,
  });
  expect(records).toEqual({});
  expect(calls.filter(([name]) => name === 'assignPort')).toHaveLength(1);
});

test('adoption rejects a replacement checkout before publishing or retrying a registration', async () => {
  let observations = 0;
  const { adoption, calls } = adoptionFixture({
    // biome-ignore lint/suspicious/useAwait: Checkout observations preserve the asynchronous identity collaborator contract.
    inspectIdentity: async () => {
      observations += 1;
      return {
        checkoutPath: '/workspace/r/topic',
        known: true,
        marker: observations === 1 ? 'first' : 'replacement',
      };
    },
  });
  await expect(
    adoption.adopt({ name: 'topic', path: '/workspace/r/topic', repo: 'r' })
  ).resolves.toMatchObject({ code: 'ADOPTION_IDENTITY_CHANGED', ok: false });
  expect(calls.some(([name]) => name === 'assignPort')).toBe(false);
});

test('adoption validates the target before reading or publishing registry state', async () => {
  const { adoption, calls } = adoptionFixture({
    validateTarget: () => {
      throw new Error('invalid target');
    },
  });
  await expect(
    adoption.adopt({ name: '../topic', path: '/workspace/r/topic', repo: 'r' })
  ).resolves.toMatchObject({ code: 'ADOPTION_TARGET_INVALID', ok: false });
  expect(calls).toEqual([]);
});

test('adoption requires a real linked Git checkout with matching administration identity', async () => {
  const root = mkdtempSync(join(tmpdir(), 'setu-adoption-'));
  const bare = join(root, 'r.git');
  const seed = join(root, 'seed');
  const checkout = join(root, 'r', 'topic');
  const git = (args, cwd) =>
    execFileSync('git', args, { cwd, stdio: 'ignore' });
  try {
    git(['init', '--bare', bare]);
    git(['clone', bare, seed]);
    git(['config', 'user.email', 'test@example.invalid'], seed);
    git(['config', 'user.name', 'Test'], seed);
    writeFileSync(join(seed, 'README.md'), 'fixture\n');
    git(['add', 'README.md'], seed);
    git(['commit', '-m', 'fixture'], seed);
    git(['push', 'origin', 'HEAD:main'], seed);
    git(['symbolic-ref', 'HEAD', 'refs/heads/main'], bare);
    git(['worktree', 'add', checkout, 'main'], bare);

    const { adoption } = adoptionFixture({
      inspectIdentity: (_repo, _name, wtDir) =>
        inspectCheckoutIdentity(
          { repoDir: bare, wtDir },
          {
            readFile: readFileAsync,
            realpath: realpathAsync,
            stat: statAsync,
          }
        ),
      isLinkedWorktree: async (_repo, path) =>
        parseLinkedWorktrees(
          execFileSync(
            'git',
            ['-C', bare, 'worktree', 'list', '--porcelain', '-z'],
            { encoding: 'utf8' }
          )
        ).some((worktree) => worktree.path === path),
      validateTarget: (repo, name) => ({ name, repo, wtDir: checkout }),
    });
    expect(
      await adoption.adopt({ name: 'topic', path: checkout, repo: 'r' })
    ).toMatchObject({
      ok: true,
      path: await realpathAsync(checkout),
      port: 3201,
    });
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

function fixture(options = {}) {
  return createWorkspaceInventory({
    readRegistry: async () => ({
      projects: [project()],
      registrations: [registered('main')],
    }),
    run: async () => result(record('/workspace/r/main', 'main')),
    statPath: directory,
    ...options,
  });
}

test('NUL parser preserves unusual paths, nested branches and detached/locked records; excludes bare', () => {
  const path = '/workspace/r/with space\nand "quotes"';
  const rows = parseLinkedWorktrees(
    `worktree /workspace/r.git\0bare\0\0${record(path, 'feat/a/b')}${record('/external/detached', null, ['locked why\nkeep', 'prunable'])}`
  );
  expect(rows).toEqual([
    {
      branch: 'feat/a/b',
      detached: false,
      head: sha,
      locked: false,
      path,
      prunable: false,
    },
    {
      branch: null,
      detached: true,
      head: sha,
      locked: true,
      path: '/external/detached',
      prunable: true,
    },
  ]);
  expect(parseLinkedWorktrees('')).toEqual([]);
  expect(() => parseLinkedWorktrees(record(path).slice(0, -1))).toThrow(
    'Incomplete'
  );
});

test('joins by exact checkout path, retains nested names, duplicate branches and external checkouts', async () => {
  const inventory = fixture({
    readRegistry: async () => ({
      projects: [project()],
      registrations: [registered('feature/nested')],
    }),
    run: async () =>
      result(
        record('/workspace/r/feature/nested', 'actual-branch') +
          record('/external/other', 'actual-branch') +
          record('/external/other', 'actual-branch')
      ),
  });
  const data = await inventory.read();
  expect(data.counts).toEqual({
    linked: 2,
    missing: 0,
    observedLinked: 2,
    registered: 1,
    unregistered: 1,
  });
  expect(data.rows[0]).toMatchObject({
    branch: 'actual-branch',
    key: 'r/feature/nested',
    name: 'feature/nested',
    registered: true,
  });
  expect(data.rows[1]).toMatchObject({
    active: null,
    key: null,
    lastUsedAt: null,
    owner: null,
    path: '/external/other',
    registered: false,
  });
  expect(data.rows[1].review.reasons.join(' ')).toContain('existing checkout');
  expect(() =>
    parseLinkedWorktrees(record('/same', 'one') + record('/same', 'two'))
  ).toThrow('Conflicting');
});

test('missing registrations stay visible; permission errors and discovery failures remain unknown', async () => {
  const inventory = fixture({
    readRegistry: async () => ({
      projects: [project(), project('broken')],
      registrations: [registered('missing'), registered('hidden', 'broken')],
    }),
    run: async (args) =>
      args[2].endsWith('/broken.git') ? result('', { code: 1 }) : result(''),
    statPath: (path) => {
      throw Object.assign(new Error('Directory observation failed'), {
        code: path.endsWith('missing') ? 'ENOENT' : 'EACCES',
      });
    },
  });
  const data = await inventory.read();
  expect(data.state).toBe('partial');
  expect(data.counts).toMatchObject({
    linked: null,
    missing: null,
    observedLinked: 0,
    registered: 2,
    unregistered: null,
  });
  expect(data.rows[0]).toMatchObject({
    discovery: 'ready',
    linked: false,
    presence: 'missing',
  });
  expect(data.rows[1]).toMatchObject({
    discovery: 'unknown',
    linked: null,
    presence: 'unknown',
  });
  expect(data.repositories[1].error).toBe('Git worktree discovery unavailable');
});

test('a successful empty discovery is ready while timeout, truncation and malformed output are unknown', async () => {
  for (const output of [
    result('', { timedOut: true }),
    result('', { truncated: true }),
    result('bad'),
  ]) {
    // biome-ignore lint/performance/noAwaitInLoops: Separate failure scenarios are checked independently.
    const data = await fixture({ run: async () => output }).read();
    expect(data.state).toBe('partial');
    expect(data.rows[0].linked).toBeNull();
  }
  const data = await fixture({ run: async () => result('') }).read();
  expect(data.state).toBe('ready');
  expect(data.counts.linked).toBe(0);
  expect(data.rows[0].linked).toBe(false);
});

test('cache deduplicates readers and disk probes while runtime stays fresh; failures retain prior discovered paths', async () => {
  let time = 1,
    gitCalls = 0,
    statCalls = 0,
    active = true,
    fail = false;
  const inventory = fixture({
    now: () => time,
    readRuntime: async () =>
      new Map([
        [
          'r/main',
          {
            active,
            lastPortalActivityAt: 12,
            operation: { kind: 'review', phase: 'unknown' },
          },
        ],
      ]),
    run: () => {
      gitCalls += 1;
      return result(
        record('/workspace/r/main', 'main') + record('/external/keep'),
        // biome-ignore lint/suspicious/noUnnecessaryConditions: The test changes fail between cached and refreshed reads.
        { code: fail ? 1 : 0 }
      );
    },
    statPath: () => {
      statCalls += 1;
      return directory();
    },
  });
  const first = await Promise.all([
    inventory.read(),
    inventory.read(),
    inventory.read(),
  ]);
  expect(gitCalls).toBe(1);
  expect(statCalls).toBe(2);
  expect(first[0].rows[0]).toMatchObject({
    active: true,
    lastPortalActivityAt: 12,
    lastUsedAt: null,
    owner: null,
  });
  active = false;
  expect((await inventory.read()).rows[0].active).toBe(false);
  expect(gitCalls).toBe(1);
  time += 30_000;
  fail = true;
  const failed = await inventory.read();
  expect(gitCalls).toBe(2);
  expect(
    failed.rows.find((row) => row.path === '/external/keep')
  ).toMatchObject({ discovery: 'unknown', linked: null });
  expect(failed.counts.linked).toBeNull();
  expect(failed.counts.observedLinked).toBe(0);
  await inventory.read();
  expect(gitCalls).toBe(2);
});

test('bounds concurrent Git commands and directory probes with no per-worktree Git scans', async () => {
  let runningGit = 0,
    maxGit = 0,
    runningStat = 0,
    maxStat = 0,
    calls = 0;
  const commands = [];
  const inventory = fixture({
    readRegistry: async () => ({
      projects: Array.from({ length: 6 }, (_, i) => project(`r${i}`)),
      registrations: [],
    }),
    run: async (args, options) => {
      calls += 1;
      commands.push(args.slice(3));
      runningGit += 1;
      maxGit = Math.max(maxGit, runningGit);
      expect(options.timeoutMs).toBe(5000);
      expect(options.maxOutputBytes).toBe(2 * 1024 * 1024);
      await new Promise((resolve) => setTimeout(resolve, 1));
      runningGit -= 1;
      return result(record(`${args[2]}/a`) + record(`${args[2]}/b`));
    },
    statPath: async () => {
      runningStat += 1;
      maxStat = Math.max(maxStat, runningStat);
      await new Promise((resolve) => setTimeout(resolve, 1));
      runningStat -= 1;
      return directory();
    },
  });
  const data = await inventory.read();
  expect(calls).toBe(6);
  expect(maxGit).toBe(2);
  expect(maxStat).toBe(4);
  expect(data.counts.linked).toBe(12);
  expect(
    commands.every(
      (command) => command.join(' ') === 'worktree list --porcelain -z'
    )
  ).toBe(true);
});

test('cleanup review always requires ignored data, shared targets, exact HEAD, ownership, refs and resources', async () => {
  const data = await fixture().read();
  expect(data.rows[0].review.requiredGates).toEqual([
    'ignored-data',
    'shared-targets',
    'exact-merged-head',
    'task-ownership',
    'branch-retention',
    'runtime-resources',
  ]);
  expect(data.rows[0].review.reasons.join(' ')).toContain('shared environment');
  expect(data.rows[0].review).not.toHaveProperty('eligible');
  expect(data.rows[0].owner).toBeNull();
  expect(data.rows[0].lastUsedAt).toBeNull();
});

test('registry read errors are not presented as an empty workspace and runtime failure is unknown', async () => {
  await expect(
    fixture({
      readRegistry: () => {
        throw new Error('STATE_CORRUPT');
      },
    }).read()
  ).rejects.toThrow('STATE_CORRUPT');
  const data = await fixture({
    readRuntime: () => {
      throw new Error('listener unavailable');
    },
  }).read();
  expect(data.rows[0].active).toBeNull();
});

test('actual registry adapter includes absent paths and orphaned projects without changing registry bytes', () => {
  const root = mkdtempSync(join(tmpdir(), 'setu-inventory-'));
  const ports = 'r/feature/nested:3000\norphan/main:3001\n';
  const projects = 'r:3000:org/r:Repository\n';
  try {
    writeFileSync(join(root, '.ports'), ports);
    writeFileSync(join(root, '.projects'), projects);
    const data = workspaceInventoryRegistry(root);
    expect(data.projects).toEqual([
      { repo: 'r', repoDir: join(root, 'r.git') },
      { repo: 'orphan', repoDir: join(root, 'orphan.git') },
    ]);
    expect(data.registrations[0]).toMatchObject({
      name: 'feature/nested',
      path: join(root, 'r/feature/nested'),
    });
    expect(data.registrations).toHaveLength(2);
    expect(readFileSync(join(root, '.ports'), 'utf8')).toBe(ports);
    expect(readFileSync(join(root, '.projects'), 'utf8')).toBe(projects);
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test('portal GET route uses inventory; other routes and methods do not trigger it', async () => {
  let reads = 0;
  const portal = await createPortalRuntime({
    config: {
      tunnel: 'fixture',
      workspace: '/private/tmp/setu-inventory-route',
    },
    workspaceInventory: {
      read: () => {
        reads += 1;
        return { counts: { linked: 138, registered: 65 } };
      },
    },
  });
  const response = await portal.internals.worktreeRoutes(
    new Request('http://localhost/api/workspace-inventory'),
    '/api/workspace-inventory',
    'GET'
  );
  expect(await response.json()).toEqual({
    counts: { linked: 138, registered: 65 },
  });
  expect(
    await portal.internals.worktreeRoutes(
      new Request('http://localhost/other'),
      '/other',
      'GET'
    )
  ).toBeNull();
  expect(
    await portal.internals.worktreeRoutes(
      new Request('http://localhost/api/workspace-inventory', {
        method: 'PUT',
      }),
      '/api/workspace-inventory',
      'PUT'
    )
  ).toBeNull();
  expect(reads).toBe(1);
  await portal.dispose();
});

test('portal activity adapter retains unknown listeners, queued work, timestamps, and nested sidecars', async () => {
  const workspace = mkdtempSync(join(tmpdir(), 'setu-inventory-runtime-'));
  const lifecycle = {
    dispose() {
      // This lifecycle fixture has no resources to release.
    },
    operationStatus: () => null,
    queueSnapshot: () => [{ key: 'r/main' }],
    refreshCapacity: async () => ({}),
    snapshot: () => null,
    status: () => ({ max: 3 }),
  };
  try {
    writeFileSync(
      join(workspace, '.ports'),
      'r/main:3000\nr/feature/nested:3001\n'
    );
    const portal = await createPortalRuntime({
      config: { tunnel: 'fixture', workspace },
      lifecycle,
      listenerObservation: {
        observation: () => ({ state: 'unknown' }),
        read: async () => [{ port: 3000 }],
      },
    });
    const state = portal.internals.runtimeState;
    state.lastSeenAt.set('r/main', 123);
    state.sidecarProcs.set('r/feature/nested/worker', {});
    const data = await portal.internals.readInventoryRuntime();
    expect(data.get('r/main')).toMatchObject({
      active: null,
      lastPortalActivityAt: 123,
    });
    expect(data.get('r/main').operation).toEqual({
      kind: 'start',
      phase: 'queued',
    });
    expect(data.get('r/feature/nested').active).toBe(true);
    await portal.dispose();
  } finally {
    rmSync(workspace, { force: true, recursive: true });
  }
});
