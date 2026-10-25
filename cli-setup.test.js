import { afterEach, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runCli } from './cli.js';
import { createResourceAdmission } from './resource-admission.js';
import { createSetupProgress } from './setup-progress.js';
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

test('public CLI creation records dependency readiness only after its owned installer group settles', async () => {
  const f = fixture();
  const root = fs.realpathSync(f.root);
  const wtDir = join(root, 'repo', 'topic');
  fs.mkdirSync(wtDir, { recursive: true });
  fs.writeFileSync(
    join(wtDir, 'package.json'),
    '{"name":"cli-readiness-fixture","version":"1.0.0"}'
  );
  const state = createWorkspaceState({
    configPath: join(root, 'config.json'),
    setuDir: root,
    workspaceRoot: root,
  });
  const stamp = (path) => {
    const info = fs.statSync(path, { bigint: true });
    return {
      birthtimeNs: String(info.birthtimeNs),
      dev: String(info.dev),
      ino: String(info.ino),
    };
  };
  const identity = {
    admin: stamp(root),
    adminPath: root,
    checkout: stamp(wtDir),
    checkoutPath: wtDir,
    known: true,
    repository: stamp(root),
    repositoryPath: root,
  };
  const progress = createSetupProgress({ state });
  let entered;
  let settle;
  const groupEntered = new Promise((resolve) => {
    entered = resolve;
  });
  const groupSettled = new Promise((resolve) => {
    settle = resolve;
  });
  let active = false;
  let closed = false;
  const output = [];
  const originalLog = console.log;
  let running;
  console.log = (value) => output.push(value);
  try {
    running = runCli(['new', 'repo', 'topic', '--json'], {
      newCommand: {
        config: () => ({ workspace: root }),
        createHostHealth: () => async () => ({
          availableBytes: 30 * 1024 ** 3,
          state: 'ready',
        }),
        createSetupInstallProcesses: () => ({
          close() {
            closed = true;
          },
          hasOwnedWork: () => active,
          spawn(argv, options) {
            expect(argv).toEqual([process.execPath, 'install']);
            fs.writeSync(options.stdout, 'fixture install completed\n');
            active = true;
            return {
              exited: Promise.resolve(0),
              pid: 4321,
              setupOwnerId: 'cli-fixture-owner',
              signalCode: null,
            };
          },
          async stopProcess(owner) {
            expect(owner).toEqual({
              ownedGroup: true,
              pid: 4321,
              setupOwnerId: 'cli-fixture-owner',
            });
            entered();
            await groupSettled;
            active = false;
          },
        }),
        createWorktree: async () => ({
          localDom: 'topic.example.test',
          port: 3301,
          wtDir,
        }),
        inspectCheckoutIdentity: async () => identity,
        workspaceState: () => state,
      },
      request: () =>
        Promise.reject(
          new Error('No portal or server request belongs to this creation')
        ),
    });
    await Promise.race([
      groupEntered,
      running.then(() => {
        throw new Error('CLI returned before entering group settlement');
      }),
    ]);
    const pending = progress.get(f.target);
    expect(pending.state).toBe('running');
    expect(pending.dependencyReceipt).toBeUndefined();
    const admission = createResourceAdmission({
      hostHealth: async () => ({
        availableBytes: 30 * 1024 ** 3,
        state: 'ready',
      }),
      state,
    });
    expect((await admission.status()).leases).toHaveLength(1);
    settle();
    expect(await running).toBe(0);
    expect(closed).toBe(true);
    const completed = progress.get(f.target);
    expect(completed.state).toBe('completed');
    expect(completed.dependencyReceipt.attemptId).toBe(completed.attemptId);
    expect(completed.dependencyReceipt.inputs.noDependencies).toBe(true);
    expect((await admission.status()).leases).toHaveLength(0);
    expect(
      fs.readFileSync(join(root, 'logs', 'repo', 'topic', 'setup.log'), 'utf8')
    ).toBe('fixture install completed\n');
    expect(JSON.parse(output.at(-1)).started).toBe(false);
  } finally {
    settle();
    await running;
    console.log = originalLog;
  }
});
