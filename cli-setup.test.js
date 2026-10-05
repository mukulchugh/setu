import { afterEach, expect, test } from 'bun:test';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createAndInstallWorktree,
  installWorktreeDependencies,
} from './workspace-setup.js';
import { createWorkspaceState } from './workspace-state.js';

const roots = [];
afterEach(() => {
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { force: true, recursive: true });
  }
});
function fixture() {
  const root = fs.mkdtempSync(join(tmpdir(), 'setu-cli-setup-'));
  roots.push(root);
  let time = 0;
  const state = createWorkspaceState({
    now: () => time,
    sleep: async (ms) => {
      time += ms;
    },
    workspaceRoot: root,
  });
  return { root, state, target: { name: 'topic', repo: 'repo' } };
}

test('CLI installation retains the checkout lease until completion and only then permits removal admission', async () => {
  const f = fixture();
  let entered, finish;
  const installing = new Promise((resolve) => {
    entered = resolve;
  });
  const held = new Promise((resolve) => {
    finish = resolve;
  });
  const result = { port: 3301, wtDir: join(f.root, 'repo', 'topic') };
  const setup = createAndInstallWorktree({
    ...f,
    ...f.target,
    create: async () => result,
    install: async () => {
      entered();
      await held;
    },
  });
  await installing;
  await expect(
    f.state.withTargets([f.target], () => 'removal admitted')
  ).rejects.toMatchObject({ code: 'STATE_BUSY' });
  finish();
  expect(await setup).toEqual(result);
  expect(await f.state.withTargets([f.target], () => 'removal admitted')).toBe(
    'removal admitted'
  );
});

test('dependency installation reports failed and unconfirmed completion instead of allowing a subsequent Start', async () => {
  const options = {
    assertStorage: async () => {},
    exists: (path) => path.endsWith('package.json'),
    run: () => ({ pid: 321, status: 2 }),
  };
  await expect(
    installWorktreeDependencies('/fixture', options)
  ).rejects.toThrow('Dependency installation failed');
  await expect(
    installWorktreeDependencies('/fixture', {
      ...options,
      run: () => ({
        error: new Error('observation lost'),
        pid: 321,
        status: null,
      }),
    })
  ).rejects.toThrow(expect.objectContaining({ code: 'OPERATION_UNKNOWN' }));
});

test('unknown CLI installation preserves its real target lease after returning the error', async () => {
  const f = fixture();
  await expect(
    createAndInstallWorktree({
      ...f,
      ...f.target,
      create: async () => ({ wtDir: f.root }),
      install: () => {
        throw Object.assign(new Error('exit unknown'), {
          code: 'OPERATION_UNKNOWN',
        });
      },
    })
  ).rejects.toMatchObject({ code: 'OPERATION_UNKNOWN' });
  await expect(
    f.state.withTargets([f.target], () => 'removed')
  ).rejects.toMatchObject({ code: 'STATE_BUSY' });
});

test('CLI tunnel setup prepares local routing and enables only after installation releases its target lease', async () => {
  const f = fixture(),
    effects = [];
  let entered, finish, createOptions;
  const installing = new Promise((resolve) => {
    entered = resolve;
  });
  const held = new Promise((resolve) => {
    finish = resolve;
  });
  const localResult = {
    port: 3301,
    pubDom: null,
    wtDir: join(f.root, 'repo', 'topic'),
  };
  const setup = createAndInstallWorktree({
    ...f,
    ...f.target,
    create: async (options) => {
      createOptions = options;
      effects.push('create');
      return localResult;
    },
    enableTunnel: async () => {
      await f.state.withTargets([f.target], async () => {
        effects.push('enable');
      });
      return 'dev-fixture.invalid';
    },
    install: async () => {
      effects.push('install');
      entered();
      await held;
    },
    tunnel: true,
  });
  await installing;
  try {
    expect(createOptions).toEqual({ tunnel: false });
    expect(effects).toEqual(['create', 'install']);
    expect(localResult.pubDom).toBeNull();
  } finally {
    finish();
  }
  expect(await setup).toMatchObject({
    port: 3301,
    pubDom: 'dev-fixture.invalid',
  });
  expect(effects).toEqual(['create', 'install', 'enable']);
  expect(localResult.pubDom).toBeNull();
});

test('failed installation or unconfirmed tunnel activation never reports a public domain', async () => {
  for (const failureAt of ['install', 'enable']) {
    const f = fixture(),
      effects = [],
      localResult = { pubDom: null, wtDir: f.root };
    await expect(
      createAndInstallWorktree({
        ...f,
        ...f.target,
        create: async () => localResult,
        enableTunnel: async () => {
          effects.push('enable');
          throw new Error('activation unconfirmed');
        },
        install: async () => {
          if (failureAt === 'install') {
            throw new Error('install failed');
          }
        },
        tunnel: true,
      })
    ).rejects.toThrow(
      failureAt === 'install' ? 'install failed' : 'activation unconfirmed'
    );
    expect(effects).toEqual(failureAt === 'install' ? [] : ['enable']);
    expect(localResult.pubDom).toBeNull();
  }
});
