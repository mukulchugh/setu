import { afterEach, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createAndInstallWorktree,
  installWorktreeDependencies,
} from './workspace-setup.js';
import { createWorkspaceState } from './workspace-state.js';

const roots = [];
const ansiColorPattern = new RegExp(
  `${String.fromCharCode(27)}\\[[0-9;]*m`,
  'g'
);
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
    // biome-ignore lint/suspicious/useAwait: The injected clock must preserve its asynchronous sleep contract.
    sleep: async (ms) => {
      time += ms;
    },
    workspaceRoot: root,
  });
  return { root, state, target: { name: 'topic', repo: 'repo' } };
}

test('setup retries with its supplied arguments after installing Homebrew', () => {
  const root = fs.mkdtempSync(join(tmpdir(), 'setu-setup-retry-'));
  roots.push(root);
  const bin = join(root, 'bin');
  fs.mkdirSync(bin);
  fs.writeFileSync(join(bin, 'curl'), '#!/bin/sh\nprintf ":\\n"\n');
  fs.chmodSync(join(bin, 'curl'), 0o755);

  const workspace = join(root, "workspace with 'quotes'");
  const setupArgs = [
    'setup',
    '--name',
    'lane',
    '--workspace',
    workspace,
    '--zone',
    'example.test',
    '--engine',
    'skip',
    '--yes',
  ];
  const result = spawnSync(
    process.execPath,
    [fileURLToPath(new URL('./cli.js', import.meta.url)), ...setupArgs],
    {
      encoding: 'utf8',
      env: { ...process.env, HOME: root, PATH: `${bin}:/usr/bin:/bin` },
    }
  );

  expect(result.status).toBe(0);
  const retry = result.stdout
    .replace(ansiColorPattern, '')
    .split('\n')
    .find((line) => line.trim().startsWith('setu setup '))
    .trim();
  const parsed = spawnSync(
    '/bin/sh',
    ['-c', `set -- ${retry}; printf '%s\\0' "$@"`],
    { encoding: 'utf8' }
  );
  expect(parsed.status).toBe(0);
  expect(parsed.stdout.split('\0').slice(0, -1)).toEqual([
    'setu',
    ...setupArgs,
  ]);
});

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
    assertStorage: async () => {
      // Storage is available for this fixture.
    },
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
    // biome-ignore lint/suspicious/useAwait: The create fixture preserves the asynchronous workspace-creation contract.
    create: async (options) => {
      createOptions = options;
      effects.push('create');
      return localResult;
    },
    enableTunnel: async () => {
      // biome-ignore lint/suspicious/useAwait: The target-lock callback retains its rejected-error promise boundary.
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

test.each(['install', 'enable'])(
  'failed installation or unconfirmed tunnel activation never reports a public domain: %s',
  async (failureAt) => {
    const f = fixture(),
      effects = [],
      localResult = { pubDom: null, wtDir: f.root };
    await expect(
      createAndInstallWorktree({
        ...f,
        ...f.target,
        create: async () => localResult,
        // biome-ignore lint/suspicious/useAwait: Tunnel activation failure must be a rejected promise.
        enableTunnel: async () => {
          effects.push('enable');
          throw new Error('activation unconfirmed');
        },
        // biome-ignore lint/suspicious/useAwait: Installation failure must be a rejected promise.
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
);
