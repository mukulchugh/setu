import { afterEach, expect, test } from 'bun:test';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { triggerBranchEnv, triggerDevBranch } from './lib.js';
import { createPortalRuntime } from './portal.js';
import { createWorkspaceState } from './workspace-state.js';

const CORE_PROBE =
  'node_modules/@trigger.dev/core/dist/esm/v3/apiClientManager/index.js';
const roots = [];

function tempDir(prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  roots.push(dir);
  return dir;
}

// A worktree whose installed @trigger.dev/core does (or doesn't) read
// TRIGGER_DEV_BRANCH, with a pinned SDK version in package.json.
function seedWorktree(wtDir, { supported, version = '4.8.1' }) {
  mkdirSync(
    join(wtDir, 'node_modules/@trigger.dev/core/dist/esm/v3/apiClientManager'),
    {
      recursive: true,
    }
  );
  writeFileSync(
    join(wtDir, CORE_PROBE),
    supported
      ? 'const value = getEnvVar("TRIGGER_DEV_BRANCH");\n'
      : 'const value = getEnvVar("TRIGGER_PREVIEW_BRANCH");\n'
  );
  writeFileSync(
    join(wtDir, 'package.json'),
    JSON.stringify({ dependencies: { '@trigger.dev/sdk': `^${version}` } })
  );
}

afterEach(() => {
  for (const dir of roots.splice(0)) {
    rmSync(dir, { force: true, recursive: true });
  }
});

test('each worktree gets a dev branch named after its Setu worktree name', () => {
  const wtDir = tempDir('setu-trigger-branch-');
  seedWorktree(wtDir, { supported: true });
  expect(triggerDevBranch('feat/foo', wtDir)).toEqual({
    branch: 'feat/foo',
    supported: true,
  });
  expect(triggerDevBranch('main', wtDir).branch).toBe('main');
  // "default" is Trigger's sentinel for the shared root dev environment
  expect(triggerDevBranch('default', wtDir).branch).toBe('setu-default');
  expect(triggerBranchEnv('feat/foo', wtDir)).toEqual({
    TRIGGER_DEV_BRANCH: 'feat/foo',
    TRIGGER_PREVIEW_BRANCH: 'feat/foo',
  });
});

test('an SDK without dev-branch support gets no branch env at all', () => {
  const old = tempDir('setu-trigger-branch-');
  seedWorktree(old, { supported: false, version: '4.4.6' });
  expect(triggerDevBranch('main', old).supported).toBe(false);
  expect(triggerBranchEnv('main', old)).toEqual({});
  // no node_modules: the worker and app must agree, so neither gets a branch
  expect(triggerBranchEnv('main', tempDir('setu-trigger-empty-'))).toEqual({});
});

async function portalFixture() {
  const root = tempDir('setu-trigger-portal-');
  const state = createWorkspaceState({
    configPath: join(root, 'config.json'),
    setuDir: root,
    workspaceRoot: root,
  });
  const config = { tunnel: 'fixture', workspace: root };
  await state.replace('config', config);
  await state.replace('projects', {
    r: { base: 3200, label: 'Fixture', slug: null },
  });
  await state.replace('ports', [
    { key: 'r/new', name: 'new', port: 3201, repo: 'r' },
    { key: 'r/old', name: 'old', port: 3202, repo: 'r' },
  ]);
  seedWorktree(join(root, 'r', 'new'), { supported: true });
  seedWorktree(join(root, 'r', 'old'), { supported: false, version: '4.4.6' });
  mkdirSync(join(root, 'r', 'new', 'apps', 'r'), { recursive: true });
  // .env.local must not be able to redirect the worker's task triggers
  writeFileSync(
    join(root, 'r', 'new', 'apps', 'r', '.env.local'),
    'VERCEL_GIT_COMMIT_REF=\nTRIGGER_PREVIEW_BRANCH=staging\n'
  );
  const portal = await createPortalRuntime({
    config,
    linksRoot: join(root, 'links'),
    reconcileTriggerSidecars: () => Promise.resolve(),
    state,
  });
  const { triggerProcs } = portal.internals.runtimeState;
  return {
    dispose: async () => {
      triggerProcs.clear();
      await portal.dispose();
    },
    portal,
    root,
    triggerProcs,
  };
}

function captureSpawns() {
  const calls = [];
  const original = Bun.spawn;
  Bun.spawn = (command, options) => {
    calls.push({ command, options });
    return {
      exited: new Promise(() => undefined),
      pid: 2 ** 22 + calls.length,
    };
  };
  return {
    calls,
    restore: () => {
      Bun.spawn = original;
    },
  };
}

test('startTrigger joins the worktree dev branch and pins the branch env last', async () => {
  const fx = await portalFixture();
  const spawns = captureSpawns();
  try {
    const result = await fx.portal.internals.startTrigger('r', 'new');
    expect(result).toEqual({ branch: 'new', ok: true });
    const [{ command, options }] = spawns.calls;
    expect(command).toEqual([
      'bunx',
      'trigger.dev@4.8.1',
      'dev',
      '--max-concurrent-runs',
      '2',
      '--branch',
      'new',
    ]);
    expect(options.env.TRIGGER_DEV_BRANCH).toBe('new');
    expect(options.env.TRIGGER_PREVIEW_BRANCH).toBe('new');
    expect(fx.triggerProcs.get('r/new').branch).toBe('new');
  } finally {
    spawns.restore();
    await fx.dispose();
  }
});

test('startTrigger on an old SDK keeps the default env and says so', async () => {
  const fx = await portalFixture();
  const spawns = captureSpawns();
  try {
    const result = await fx.portal.internals.startTrigger('r', 'old');
    expect(result.ok).toBe(true);
    expect(result.branch).toBeNull();
    expect(result.warning).toContain('4.4.6 has no dev-branch support');
    expect(spawns.calls[0].command).not.toContain('--branch');
    expect(spawns.calls[0].options.env.TRIGGER_DEV_BRANCH).toBeUndefined();
    const log = readFileSync(
      join(fx.root, 'logs', 'r', 'old', 'trigger.log'),
      'utf8'
    );
    expect(log).toContain(
      '[setu] @trigger.dev/sdk 4.4.6 has no dev-branch support'
    );
  } finally {
    spawns.restore();
    await fx.dispose();
  }
});

test('a running worker on the wrong dev env is reported, not treated as isolated', async () => {
  const fx = await portalFixture();
  const spawns = captureSpawns();
  try {
    fx.triggerProcs.set('r/new', {
      branch: null,
      native: null,
      ownedGroup: false,
      pid: 2 ** 22,
    });
    const result = await fx.portal.internals.startTrigger('r', 'new');
    expect(result).toMatchObject({
      code: 'TRIGGER_BRANCH_MISMATCH',
      ok: false,
    });
    expect(result.error).toContain('shared default dev environment');
    expect(spawns.calls).toHaveLength(0);

    fx.triggerProcs.set('r/new', {
      branch: 'new',
      native: null,
      ownedGroup: false,
      pid: 2 ** 22,
    });
    expect(await fx.portal.internals.startTrigger('r', 'new')).toEqual({
      error: 'already running',
      ok: false,
    });
  } finally {
    spawns.restore();
    await fx.dispose();
  }
});
