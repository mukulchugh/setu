import { expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { workspaceInventoryRegistry } from './lib.js';
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

// The portal is a server entrypoint. Evaluate only the actual read adapters;
// importing that module would start the user's server and reconcile processes.
const portal = readFileSync(new URL('./portal.js', import.meta.url), 'utf8');
const declaration = (name) =>
  portal.match(new RegExp(`^async function ${name}\\([^]*?^}`, 'm'))[0];

test('portal GET route uses inventory; other routes and methods do not trigger it', async () => {
  let reads = 0;
  const routes = Function(
    'workspaceInventory',
    `${declaration('worktreeRoutes')}; return worktreeRoutes;`
  )({
    read: () => {
      reads += 1;
      return { counts: { linked: 138, registered: 65 } };
    },
  });
  const response = await routes(
    new Request('http://localhost/api/workspace-inventory'),
    '/api/workspace-inventory',
    'GET'
  );
  expect(await response.json()).toEqual({
    counts: { linked: 138, registered: 65 },
  });
  expect(
    await routes(new Request('http://localhost/other'), '/other', 'GET')
  ).toBeNull();
  expect(
    await routes(
      new Request('http://localhost/api/workspace-inventory', {
        method: 'PUT',
      }),
      '/api/workspace-inventory',
      'PUT'
    )
  ).toBeNull();
  expect(reads).toBe(1);
});

test('portal activity adapter preserves unknown listeners, supporting work and portal timestamps', async () => {
  const deps = {
    convexDevProcs: new Map(),
    inngestProcs: new Map(),
    lastSeenAt: new Map([['r/main', 123]]),
    lifecycle: { operationStatus: () => null, snapshot: () => null },
    listenerObservation: {
      observation: () => ({ state: 'unknown' }),
      read: async () => [{ port: 3000 }],
    },
    portEntries: () => [registered('main'), registered('feature/nested')],
    queuePosition: (key) => (key === 'r/main' ? 1 : null),
    sidecarProcs: new Map([['r/feature/nested/worker', {}]]),
    triggerProcs: new Map(),
    WORKSPACE: '/workspace',
  };
  const read = Function(
    ...Object.keys(deps),
    `${declaration('readInventoryRuntime')};return readInventoryRuntime;`
  )(...Object.values(deps));
  const data = await read();
  expect(data.get('r/main')).toMatchObject({
    active: null,
    lastPortalActivityAt: 123,
  });
  expect(data.get('r/main').operation).toEqual({
    kind: 'start',
    phase: 'queued',
  });
  expect(data.get('r/feature/nested').active).toBe(true);
});
