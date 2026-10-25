import { expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readPortalStatus } from './portal-status.js';
import { createResourceAdmission } from './resource-admission.js';
import { createSetupProgress } from './setup-progress.js';
import {
  cloneBareRepository,
  createAndInstallWorktree,
  installWorktreeDependencies,
  prepareWorktreeCheckout,
  startWorktreeSetupInstall,
  withSetupAdmission,
} from './workspace-setup.js';
import { createWorkspaceState } from './workspace-state.js';
import { createWorktreeLifecycle } from './worktree-lifecycle.js';

function durableFixture() {
  const root = mkdtempSync(join(tmpdir(), 'setu-setup-wiring-'));
  const workspace = join(root, 'workspace');
  mkdirSync(workspace);
  return {
    dispose: () => rmSync(root, { force: true, recursive: true }),
    root,
    state: createWorkspaceState({
      configPath: join(root, 'config.json'),
      setuDir: root,
      workspaceRoot: workspace,
    }),
    workspace,
  };
}

function testAdmission(state) {
  return createResourceAdmission({
    hostHealth: async () => ({
      availableBytes: 30 * 1024 ** 3,
      state: 'ready',
    }),
    limits: { lowStorageFloorBytes: 0 },
    now: () => Date.now(),
    observeProcess: async (pid) => ({
      processId: pid,
      processStartIdentity: `test-${pid}`,
      state: 'alive',
    }),
    state,
  });
}

function sharedFixture() {
  const f = durableFixture();
  const wtDir = join(f.workspace, 'repo', 'topic');
  const storeRoot = join(f.root, 'store');
  mkdirSync(wtDir, { recursive: true });
  mkdirSync(storeRoot, { mode: 0o700 });
  writeFileSync(join(wtDir, 'package.json'), '{}');
  writeFileSync(join(wtDir, 'bun.lock'), '{}');
  writeFileSync(join(wtDir, 'bunfig.toml'), '[install]\nlinker = "isolated"\n');
  const executable = join(f.root, 'bun-fixture');
  writeFileSync(
    executable,
    '#!/bin/sh\nprintf \'["1.3.14","darwin","arm64"]\\n\'\n',
    { mode: 0o700 }
  );
  return {
    ...f,
    sharing: {
      enabled: true,
      executable,
      storeIdentity: {
        device: statSync(storeRoot).dev,
        mountPath: realpathSync(f.root),
      },
      storeRoot: realpathSync(storeRoot),
      version: '1.3.14',
      workspaceRoot: f.workspace,
    },
    wtDir,
  };
}

function consumerFor(wtDir) {
  return {
    bunVersion: '1.3.14',
    checkout: realpathSync(wtDir),
    linkerMode: 'isolated',
    lockfileHash: createHash('sha256')
      .update(readFileSync(join(wtDir, 'bun.lock')))
      .digest('hex'),
    platformNamespace: 'darwin-arm64-bun-1.3.14',
  };
}

function setupFixture(manifest) {
  let finish,
    fail,
    leases = 0;
  const exited = new Promise((resolve, reject) => {
    finish = resolve;
    fail = reject;
  });
  const effects = [];
  const target = { key: 'r/topic', name: 'topic', repo: 'r' };
  const context = {
    ready: false,
    res: {
      localDom: 'r-topic.setu.local',
      port: 3301,
      wtDir: '/isolated/r/topic',
    },
  };
  const lifecycle = createWorktreeLifecycle({
    capacity: { refresh: () => Promise.resolve({ available: false }) },
    clock: { clearTimeout, now: () => 0, setTimeout },
    runtime: {},
    settings: {},
    validateTarget: () => Promise.resolve(),
    withTarget: async (_target, task) => {
      leases += 1;
      try {
        return await task();
      } finally {
        leases -= 1;
      }
    },
  });
  const deps = {
    assertStorage: () => Promise.resolve(),
    closeLog: (fd) => {
      effects.push(['close', fd]);
    },
    exists: (path) => !!manifest && path.endsWith(`/${manifest}`),
    openLog: () => {
      effects.push(['open']);
      return 8;
    },
    spawn: (args, options) => {
      effects.push(['spawn', args, options]);
      return { exited, pid: 321 };
    },
    stopProcess: () => {
      effects.push(['stop']);
      return Promise.resolve();
    },
  };
  return {
    context,
    create: () =>
      lifecycle.startOperation(target, 'setup', () =>
        startWorktreeSetupInstall(context, deps)
      ),
    deps,
    effects,
    fail,
    finish,
    leases: () => leases,
    lifecycle,
    target,
  };
}

test('low storage refuses both dependency installers before logs or processes and keeps removal available', async () => {
  const f = setupFixture('package.json');
  const refusal = Object.assign(new Error('Only 116 MiB is available'), {
    code: 'STORAGE_LOW',
  });
  const assertStorage = () => Promise.reject(refusal);
  f.deps.assertStorage = assertStorage;
  try {
    expect(await f.create()).toMatchObject({ code: 'STORAGE_LOW', ok: false });
    expect(f.effects).toEqual([]);
    expect(f.context.ready).toBe(false);
    expect(f.leases()).toBe(0);
    expect(
      await f.lifecycle.runOperation(f.target, 'remove', async () => ({
        ok: true,
      }))
    ).toEqual({ ok: true });
    const calls = [];
    await expect(
      installWorktreeDependencies(f.context.res.wtDir, {
        assertStorage,
        exists: f.deps.exists,
        run: (...args) => {
          calls.push(args);
          return { status: 0 };
        },
      })
    ).rejects.toMatchObject({ code: 'STORAGE_LOW' });
    expect(calls).toEqual([]);
  } finally {
    f.finish(0);
    await f.lifecycle.waitForOperation(f.target);
    f.lifecycle.dispose();
  }
});

test('portal setup without a dependency manifest becomes ready without any install process', async () => {
  const f = setupFixture(null);
  try {
    expect(await f.create()).toEqual({
      domain: 'r-topic.setu.local',
      ok: true,
      port: 3301,
      setup: 'ready',
    });
    expect(f.context.ready).toBe(true);
    expect(f.effects).toEqual([]);
    expect(f.leases()).toBe(0);
    expect(
      await f.lifecycle.runOperation(f.target, 'remove', () =>
        Promise.resolve({ ok: true })
      )
    ).toEqual({ ok: true });
  } finally {
    f.finish(0);
    await f.lifecycle.waitForOperation(f.target);
    f.lifecycle.dispose();
  }
});

test.each([
  ['package.json', 'bun', ['install']],
  ['pyproject.toml', 'uv', ['sync']],
  ['requirements.txt', 'uv', ['sync']],
  [null, null, null],
])(
  'manifest %s selects the same installer through CLI and portal',
  async (manifest, command, args) => {
    const f = setupFixture(manifest),
      calls = [];
    try {
      await installWorktreeDependencies(f.context.res.wtDir, {
        assertStorage: f.deps.assertStorage,
        exists: f.deps.exists,
        run: (...values) => {
          calls.push(values);
          return { status: 0 };
        },
      });
      await f.create();
      const spawned = f.effects.find(([kind]) => kind === 'spawn');
      if (manifest) {
        expect(calls[0].slice(0, 2)).toEqual([command, args]);
        expect(spawned[1]).toEqual([
          command === 'bun' ? process.execPath : command,
          ...args,
        ]);
      } else {
        expect(calls).toEqual([]);
        expect(spawned).toBeUndefined();
      }
    } finally {
      f.finish(0);
      await f.lifecycle.waitForOperation(f.target);
      f.lifecycle.dispose();
    }
  }
);

test('inline dependency installation forwards its stdio choice', async () => {
  let options;
  await installWorktreeDependencies('/fixture', {
    assertStorage: () => Promise.resolve(),
    exists: (path) => path.endsWith('package.json'),
    run: (_command, _args, runOptions) => {
      options = runOptions;
      return { status: 0 };
    },
    stdio: ['ignore', 2, 2],
  });
  expect(options.stdio).toEqual(['ignore', 2, 2]);
});

test('package setup retains admission through install and confirmed process-group exit', async () => {
  const f = setupFixture('package.json');
  let entered, finishGroup;
  const observing = new Promise((resolve) => {
    entered = resolve;
  });
  const groupExit = new Promise((resolve) => {
    finishGroup = resolve;
  });
  f.deps.stopProcess = (handle) => {
    expect(handle).toEqual({ ownedGroup: true, pid: 321 });
    entered();
    return groupExit;
  };
  try {
    expect(await f.create()).toMatchObject({ ok: true, setup: 'installing' });
    expect(f.leases()).toBe(1);
    expect(
      await f.lifecycle.runOperation(f.target, 'remove', () =>
        Promise.resolve({ ok: true })
      )
    ).toMatchObject({ code: 'TARGET_BUSY', ok: false });
    f.finish(0);
    await observing;
    expect(f.context.ready).toBe(false);
    expect(f.leases()).toBe(1);
    finishGroup();
    await f.lifecycle.waitForOperation(f.target);
    expect(f.context.ready).toBe(true);
    expect(f.leases()).toBe(0);
  } finally {
    f.finish(0);
    finishGroup();
    await f.lifecycle.waitForOperation(f.target);
    f.lifecycle.dispose();
  }
});

test('unknown package install completion retains its target lease and never marks setup ready', async () => {
  const f = setupFixture('package.json');
  expect(await f.create()).toMatchObject({ ok: true, setup: 'installing' });
  f.fail(new Error('exit observation unavailable'));
  await f.lifecycle.waitForOperation(f.target);
  expect(f.context.ready).toBe(false);
  expect(f.leases()).toBe(1);
  expect(f.lifecycle.operationStatus(f.target.key)).toMatchObject({
    phase: 'unknown',
  });
  expect(
    await f.lifecycle.runOperation(f.target, 'remove', () =>
      Promise.resolve({ ok: true })
    )
  ).toMatchObject({ code: 'TARGET_BUSY', ok: false });
  f.lifecycle.dispose();
});

test('a setup log-close error after spawn cannot release the running installer', async () => {
  const f = setupFixture('package.json');
  f.deps.closeLog = () => {
    throw new Error('close failed');
  };
  try {
    expect(await f.create()).toMatchObject({ ok: true, setup: 'installing' });
    expect(f.leases()).toBe(1);
    f.finish(0);
    await f.lifecycle.waitForOperation(f.target);
    expect(f.context.ready).toBe(false);
    expect(f.leases()).toBe(0);
    expect(f.lifecycle.operationStatus(f.target.key)).toMatchObject({
      phase: 'failed',
    });
  } finally {
    f.finish(0);
    await f.lifecycle.waitForOperation(f.target);
    f.lifecycle.dispose();
  }
});

test('setup admission serializes competing installs before target locking and retains unknown leases', async () => {
  const f = durableFixture();
  const admission = testAdmission(f.state);
  const target = { name: 'topic', repo: 'repo' };
  let release;
  const held = new Promise((resolve) => {
    release = resolve;
  });
  let locks = 0;
  let leasesWhenLocked = 0;
  const withTarget = async (_target, task) => {
    leasesWhenLocked = (await admission.status()).leases.length;
    locks += 1;
    try {
      return await task();
    } finally {
      locks -= 1;
    }
  };
  try {
    const first = await withSetupAdmission({
      admission,
      operationId: 'setup-one',
      target,
      task: async () => ({ completion: held, result: { ok: true } }),
      withTarget,
    });
    expect(first.result).toEqual({ ok: true });
    expect(leasesWhenLocked).toBe(1);
    expect(locks).toBe(0);
    await expect(
      withSetupAdmission({
        admission,
        operationId: 'setup-two',
        target: { name: 'other', repo: 'repo' },
        task: async () => ({ ok: true }),
        withTarget,
      })
    ).resolves.toMatchObject({ code: 'INSTALL_IN_PROGRESS', ok: false });
    expect(locks).toBe(0);
    release();
    await first.completion;
    expect((await admission.status()).leases).toEqual([]);

    const failedStart = await withSetupAdmission({
      admission,
      operationId: 'setup-failed',
      target,
      task: async () => ({
        completion: Promise.reject(new Error('installer failed')),
        result: { ok: true },
      }),
      withTarget,
    });
    await expect(failedStart.completion).rejects.toThrow('installer failed');
    expect((await admission.status()).leases).toEqual([]);

    const unknownStart = await withSetupAdmission({
      admission,
      operationId: 'setup-unknown',
      target,
      task: async () => ({
        completion: Promise.reject(
          Object.assign(new Error('unconfirmed'), { code: 'OPERATION_UNKNOWN' })
        ),
        result: { ok: true },
      }),
      withTarget,
    });
    expect(unknownStart.result).toEqual({ ok: true });
    await expect(unknownStart.completion).rejects.toMatchObject({
      code: 'OPERATION_UNKNOWN',
    });
    const unknown = await admission.status();
    expect(unknown.leases).toMatchObject([
      { kind: 'install', operationId: 'setup-unknown' },
    ]);
  } finally {
    f.dispose();
  }
});

test('setup admission releases an exact lease once without masking completion failures', async () => {
  const f = durableFixture();
  const raw = testAdmission(f.state);
  let releases = 0;
  const admission = {
    admit: (...args) => raw.admit(...args),
    // biome-ignore lint/suspicious/useAwait: The release adapter must turn synchronous state failures into rejected promises.
    release: async (...args) => {
      releases += 1;
      return raw.release(...args);
    },
  };
  const target = { name: 'topic', repo: 'repo' };
  try {
    let finish;
    const held = new Promise((resolve) => {
      finish = resolve;
    });
    const lifecycleStart = await withSetupAdmission({
      admission,
      operationId: 'lifecycle-holder',
      target,
      task: async () => ({ completion: held, result: { ok: true } }),
      withTarget: async (_target, task) => task(),
    });
    finish();
    await lifecycleStart.completion;
    expect(releases).toBe(1);

    const failure = new Error('known child failure');
    await expect(
      withSetupAdmission({
        admission,
        operationId: 'cli-direct-lock',
        target,
        task: async () => ({
          completion: Promise.reject(failure),
          result: { ok: true },
        }),
        withTarget: async (_target, task) => {
          const launched = await task();
          await launched.completion;
          return launched;
        },
      })
    ).rejects.toBe(failure);
    expect(releases).toBe(2);
  } finally {
    f.dispose();
  }
});

test.each(['exited', 'group-stop'])(
  'unknown child outcome %s retains admission when progress persistence fails',
  async (mode) => {
    const f = durableFixture();
    const rawProgress = createSetupProgress({
      newAttemptId: () => `attempt-${mode}`,
      now: () => 1,
      state: f.state,
    });
    const progress = {
      ...rawProgress,
      finish: () => Promise.reject(new Error('progress write unavailable')),
    };
    const admission = testAdmission(f.state);
    const target = { name: `topic-${mode}`, repo: 'repo' };
    const wtDir = join(f.workspace, 'repo', target.name);
    mkdirSync(wtDir, { recursive: true });
    writeFileSync(join(wtDir, 'package.json'), '{}');
    let resolveExit, rejectExit;
    const exited = new Promise((resolve, reject) => {
      resolveExit = resolve;
      rejectExit = reject;
    });
    try {
      const started = await withSetupAdmission({
        admission,
        operationId: `unknown-${mode}`,
        target,
        task: () =>
          startWorktreeSetupInstall(
            {
              ready: false,
              res: { localDom: 'topic.local', port: 3301, wtDir },
            },
            {
              assertStorage: () => Promise.resolve(),
              checkoutIdentity: realpathSync(wtDir),
              closeLog: () => {
                /* The fixture has no log handle to close. */
              },
              exists: (path) => path === join(wtDir, 'package.json'),
              logLocation: join(f.root, 'setup.log'),
              openLog: () => 1,
              progress,
              spawn: () => ({ exited, pid: 712 }),
              stopProcess: () =>
                mode === 'group-stop'
                  ? Promise.reject(new Error('cannot observe group'))
                  : Promise.resolve(),
              target,
            }
          ),
        withTarget: async (_target, task) => task(),
      });
      if (mode === 'exited') {
        rejectExit(new Error('exit observation rejected'));
      } else {
        resolveExit(0);
      }
      await expect(started.completion).rejects.toMatchObject({
        code: 'OPERATION_UNKNOWN',
        recovery: { progress: { message: 'progress write unavailable' } },
      });
      expect((await admission.status()).leases).toMatchObject([
        { operationId: `unknown-${mode}` },
      ]);
    } finally {
      f.dispose();
    }
  }
);

test.each(['open', 'spawn', 'close'])(
  'log failure %s finishes durable setup only after required child proof',
  async (mode) => {
    const f = durableFixture();
    const target = { name: `topic-${mode}`, repo: 'repo' };
    const wtDir = join(f.workspace, 'repo', target.name);
    mkdirSync(wtDir, { recursive: true });
    writeFileSync(join(wtDir, 'package.json'), '{}');
    const progress = createSetupProgress({
      newAttemptId: () => `attempt-${mode}`,
      now: () => 1,
      state: f.state,
    });
    let finish;
    const exited = new Promise((resolve) => {
      finish = resolve;
    });
    try {
      const options = {
        assertStorage: () => Promise.resolve(),
        checkoutIdentity: realpathSync(wtDir),
        closeLog: () => {
          if (mode === 'close') {
            throw new Error('close failed');
          }
        },
        exists: (path) => path === join(wtDir, 'package.json'),
        logLocation: join(f.root, 'setup.log'),
        openLog: () => {
          if (mode === 'open') {
            throw new Error('open failed');
          }
          return 1;
        },
        progress,
        spawn: () => {
          if (mode === 'spawn') {
            throw new Error('spawn failed');
          }
          return { exited, pid: 811 };
        },
        stopProcess: () => Promise.resolve(),
        target,
      };
      if (mode === 'close') {
        const started = await startWorktreeSetupInstall(
          { ready: false, res: { localDom: 'topic.local', port: 3301, wtDir } },
          options
        );
        expect(progress.get(target)).toMatchObject({ state: 'running' });
        finish(0);
        await expect(started.completion).rejects.toThrow('log descriptor');
      } else {
        await expect(
          startWorktreeSetupInstall(
            {
              ready: false,
              res: { localDom: 'topic.local', port: 3301, wtDir },
            },
            options
          )
        ).rejects.toThrow(`${mode} failed`);
      }
      expect(progress.get(target)).toMatchObject({
        outcome: 'failed',
        state: 'failed',
      });
    } finally {
      f.dispose();
    }
  }
);

test.each(['malformed', 'invalid-consumer', 'replaced', 'unknown'])(
  'shared setup refuses consumer %s without invoking an install',
  async (scenario) => {
    const f = sharedFixture();
    const calls = [];
    const consumerPath = join(f.workspace, '.setu-dependency-views.json');
    try {
      if (scenario === 'malformed') {
        writeFileSync(consumerPath, JSON.stringify({ consumers: [] }));
      } else if (scenario === 'invalid-consumer') {
        writeFileSync(
          consumerPath,
          JSON.stringify({ consumers: { [realpathSync(f.wtDir)]: {} } })
        );
      } else {
        const consumer = consumerFor(f.wtDir);
        if (scenario === 'unknown') {
          consumer.lockfileHash = '0'.repeat(64);
        }
        await f.state.update('dependencyViews', () => ({
          consumers: { [consumer.checkout]: consumer },
        }));
        if (scenario === 'replaced') {
          mkdirSync(join(f.wtDir, 'node_modules'));
        }
      }
      const malformed = ['malformed', 'invalid-consumer'].includes(scenario);
      const before = malformed ? readFileSync(consumerPath, 'utf8') : null;
      const error = await installWorktreeDependencies(f.wtDir, {
        assertStorage: () => Promise.resolve(),
        exists: (path) => path === join(f.wtDir, 'package.json'),
        run: (...args) => {
          calls.push(args);
          return { status: 0 };
        },
        sharing: f.sharing,
        state: f.state,
      }).then(
        () => null,
        (cause) => cause
      );
      expect(error?.code, scenario).toBe(
        malformed ? 'DEPENDENCY_VIEW_UNKNOWN' : 'DEPENDENCY_VIEW_UNSAFE'
      );
      expect(calls).toEqual([]);
      if (before) {
        expect(readFileSync(consumerPath, 'utf8')).toBe(before);
      }
    } finally {
      f.dispose();
    }
  }
);

test('an absent dependency consumer document is a legitimate fresh shared install', async () => {
  const f = sharedFixture();
  const calls = [];
  try {
    await installWorktreeDependencies(f.wtDir, {
      assertStorage: () => Promise.resolve(),
      exists: (path) => path === join(f.wtDir, 'package.json'),
      run: (...args) => {
        calls.push(args);
        return { status: 0 };
      },
      sharing: f.sharing,
      state: f.state,
    });
    expect(calls).toHaveLength(1);
    expect(f.state.read('dependencyViews')).toMatchObject({
      consumers: { [realpathSync(f.wtDir)]: consumerFor(f.wtDir) },
    });
  } finally {
    f.dispose();
  }
});

test('reviewed retry runs its exact durable attempt once and rejects forged contexts before effects', async () => {
  const f = durableFixture();
  const wtDir = join(f.workspace, 'repo', 'topic');
  mkdirSync(wtDir, { recursive: true });
  writeFileSync(join(wtDir, 'package.json'), '{}');
  const target = { name: 'topic', repo: 'repo' };
  const identity = realpathSync(wtDir);
  let attempt = 0;
  const progress = createSetupProgress({
    newAttemptId: () => {
      attempt += 1;
      return `attempt-${attempt}`;
    },
    now: () => attempt,
    state: f.state,
  });
  let firstDone, secondDone;
  const firstExit = new Promise((resolve) => {
    firstDone = resolve;
  });
  const secondExit = new Promise((resolve) => {
    secondDone = resolve;
  });
  let launches = 0;
  const common = {
    assertStorage: () => Promise.resolve(),
    checkoutIdentity: identity,
    closeLog: () => {
      /* no log descriptor is opened in this fixture */
    },
    exists: (path) => path === join(wtDir, 'package.json'),
    logLocation: join(f.root, 'setup.log'),
    openLog: () => 1,
    progress,
    spawn: () => {
      const exited = launches === 0 ? firstExit : secondExit;
      launches += 1;
      return { exited, pid: 900 + launches };
    },
    stopProcess: () => Promise.resolve(),
    target,
  };
  const context = {
    ready: false,
    res: { localDom: 'topic.local', port: 3301, wtDir },
  };
  try {
    const first = await startWorktreeSetupInstall(context, common);
    await progress.recover();
    const reviewed = progress.get(target);
    const retry = await progress.retry({
      attemptId: reviewed.attemptId,
      checkoutIdentity: identity,
      logLocation: common.logLocation,
      stage: 'preparing',
      target,
    });
    expect(retry).toMatchObject({
      ok: true,
      record: { attemptId: 'attempt-2' },
    });
    await expect(
      startWorktreeSetupInstall(context, {
        ...common,
        setupAttempt: { ...retry.record, attemptId: 'attempt-1' },
      })
    ).rejects.toMatchObject({ code: 'SETUP_ATTEMPT_MISMATCH' });
    expect(launches).toBe(1);
    const second = await startWorktreeSetupInstall(context, {
      ...common,
      setupAttempt: retry.record,
    });
    expect(launches).toBe(2);
    firstDone(0);
    await expect(first.completion).rejects.toMatchObject({
      code: 'SETUP_ATTEMPT_MISMATCH',
    });
    secondDone(0);
    await second.completion;
    expect(progress.get(target)).toMatchObject({
      attemptId: 'attempt-2',
      state: 'completed',
    });
  } finally {
    f.dispose();
  }
});

test('durable retry rejects an old completion and completes only its new attempt', async () => {
  const f = durableFixture();
  const wtDir = join(f.workspace, 'repo', 'topic');
  mkdirSync(wtDir, { recursive: true });
  writeFileSync(join(wtDir, 'package.json'), '{}');
  const target = { name: 'topic', repo: 'repo' };
  const identity = realpathSync(wtDir);
  let nextAttempt = 0;
  const progress = createSetupProgress({
    newAttemptId: () => {
      nextAttempt += 1;
      return `attempt-${nextAttempt}`;
    },
    now: () => nextAttempt,
    state: f.state,
  });
  const starts = [];
  const launch = () => {
    let done;
    const exited = new Promise((resolve) => {
      done = resolve;
    });
    return { done, exited, pid: 400 + starts.length };
  };
  const options = () => ({
    assertStorage: () => Promise.resolve(),
    checkoutIdentity: identity,
    closeLog: () => {
      /* no log descriptor is opened in this fixture */
    },
    exists: (path) => path === join(wtDir, 'package.json'),
    logLocation: join(f.root, 'setup.log'),
    openLog: () => 1,
    progress,
    spawn: () => {
      const process = launch();
      starts.push(process);
      return process;
    },
    stopProcess: () => Promise.resolve(),
    target,
  });
  const context = {
    ready: false,
    res: { localDom: 'topic.local', port: 3301, wtDir },
  };
  try {
    const first = await startWorktreeSetupInstall(context, options());
    expect(progress.get(target)).toMatchObject({
      attemptId: 'attempt-1',
      state: 'running',
    });
    await progress.recover();
    const second = await startWorktreeSetupInstall(context, options());
    expect(progress.get(target)).toMatchObject({
      attemptId: 'attempt-2',
      state: 'running',
    });
    starts[0].done(0);
    await expect(first.completion).rejects.toMatchObject({
      code: 'SETUP_ATTEMPT_MISMATCH',
    });
    expect(progress.get(target)).toMatchObject({
      attemptId: 'attempt-2',
      state: 'running',
    });
    starts[1].done(0);
    await second.completion;
    expect(progress.get(target)).toMatchObject({
      attemptId: 'attempt-2',
      outcome: 'completed',
    });
  } finally {
    f.dispose();
  }
});

test('CLI create retains admission when both install outcome and progress persistence are unknown', async () => {
  const f = durableFixture();
  const admission = testAdmission(f.state);
  const target = { name: 'topic', repo: 'repo' };
  const wtDir = join(f.workspace, 'repo', 'topic');
  mkdirSync(wtDir, { recursive: true });
  const progress = {
    ...createSetupProgress({
      newAttemptId: () => 'cli-attempt',
      state: f.state,
    }),
    finish: () => Promise.reject(new Error('progress write unavailable')),
  };
  try {
    await expect(
      createAndInstallWorktree({
        admission,
        checkoutIdentity: async () => realpathSync(wtDir),
        create: async () => ({ wtDir }),
        // biome-ignore lint/suspicious/useAwait: Unknown installer completion must reject with its operation code.
        install: async () => {
          throw Object.assign(new Error('child outcome unknown'), {
            code: 'OPERATION_UNKNOWN',
          });
        },
        logLocation: join(f.root, 'setup.log'),
        operationId: 'cli-unknown',
        ...target,
        progress,
        state: f.state,
      })
    ).rejects.toMatchObject({
      code: 'OPERATION_UNKNOWN',
      recovery: { progress: { message: 'progress write unavailable' } },
    });
    expect((await admission.status()).leases).toMatchObject([
      { operationId: 'cli-unknown' },
    ]);
    expect(progress.get(target).state).toBe('running');
  } finally {
    f.dispose();
  }
});

test('CLI setup threads the admitted lease operation id into installer context', async () => {
  const f = durableFixture();
  const wtDir = join(f.workspace, 'repo', 'topic');
  mkdirSync(wtDir, { recursive: true });
  const lease = { kind: 'install', operationId: 'lease-operation-exact' };
  let installContext;
  try {
    await createAndInstallWorktree({
      admission: {
        admit: async () => ({ lease, ok: true }),
        release: async (received) => ({ ok: received === lease }),
      },
      checkoutIdentity: async () => realpathSync(wtDir),
      create: async () => ({ wtDir }),
      install: (_path, context) => {
        installContext = context;
      },
      logLocation: join(f.root, 'setup.log'),
      name: 'topic',
      operationId: 'lease-operation-exact',
      repo: 'repo',
      state: f.state,
    });
    expect(installContext.admissionOperationId).toBe(lease.operationId);
  } finally {
    f.dispose();
  }
});

test('completed create retry does not reinstall or move tunnel ownership', async () => {
  const f = durableFixture();
  const target = { name: 'topic', repo: 'repo' };
  const wtDir = join(f.workspace, 'repo', 'topic');
  mkdirSync(wtDir, { recursive: true });
  const identity = realpathSync(wtDir);
  const progress = createSetupProgress({
    newAttemptId: () => 'attempt-one',
    now: () => 1,
    state: f.state,
  });
  await progress.start({
    checkoutIdentity: identity,
    logLocation: 'setup.log',
    stage: 'completed',
    target,
  });
  await progress.finish({
    attemptId: 'attempt-one',
    checkoutIdentity: identity,
    outcome: 'completed',
    target,
  });
  let installs = 0;
  let tunnels = 0;
  try {
    const result = await createAndInstallWorktree({
      checkoutIdentity: async () => identity,
      create: async () => ({ wtDir }),
      enableTunnel: () => {
        tunnels += 1;
        return Promise.resolve('public.example');
      },
      install: () => {
        installs += 1;
        return Promise.resolve();
      },
      logLocation: 'setup.log',
      name: target.name,
      progress,
      repo: target.repo,
      state: f.state,
      tunnel: true,
    });
    expect(result).toMatchObject({ setup: 'unverified', wtDir });
    expect(installs).toBe(0);
    expect(tunnels).toBe(0);
  } finally {
    f.dispose();
  }
});

test('ordinary opt-out remains an ordinary install and failed shared setup records no consumer', async () => {
  const f = durableFixture();
  const wtDir = join(f.workspace, 'repo', 'topic');
  mkdirSync(wtDir, { recursive: true });
  writeFileSync(join(wtDir, 'package.json'), '{}');
  const calls = [];
  try {
    await installWorktreeDependencies(wtDir, {
      assertStorage: () => Promise.resolve(),
      exists: (path) => path === join(wtDir, 'package.json'),
      run: (...args) => {
        calls.push(args);
        return { status: 0 };
      },
      sharing: { enabled: false },
      state: f.state,
    });
    expect(calls[0].slice(0, 2)).toEqual(['bun', ['install']]);
    await expect(
      installWorktreeDependencies(wtDir, {
        assertStorage: () => Promise.resolve(),
        exists: (path) => path === join(wtDir, 'package.json'),
        run: () => ({ status: 0 }),
        sharing: { enabled: true },
        state: f.state,
      })
    ).rejects.toThrow('Dependency sharing requires explicit Bun');
    expect(f.state.read('dependencyViews')).toEqual({});
  } finally {
    f.dispose();
  }
});

test('clone awaits the checked async command before registration preparation and preserves command failure', async () => {
  const calls = [];
  let finish;
  const held = new Promise((resolve) => {
    finish = resolve;
  });
  // biome-ignore lint/suspicious/useAwait: The command adapter must retain async errors and adoption of the held clone promise.
  const run = async (args) => {
    calls.push(args);
    if (args[0] === 'gh') {
      return { code: 1 };
    }
    if (args[1] === 'clone') {
      return held;
    }
    return { code: 0, stdout: '' };
  };
  const clone = cloneBareRepository(
    '/isolated/repo.git',
    'git@example/repo',
    'org/repo',
    { run }
  );
  await Promise.resolve();
  expect(calls.some((args) => args.includes('config'))).toBe(false);
  finish({ code: 2, stderr: 'clone refused' });
  await expect(clone).rejects.toThrow('clone refused');
  expect(calls.some((args) => args.includes('config'))).toBe(false);
});

test('checkout creation awaits the async Git add', async () => {
  let finish;
  const held = new Promise((resolve) => {
    finish = resolve;
  });
  const calls = [];
  // biome-ignore lint/suspicious/useAwait: The command adapter must retain async errors and adoption of the held Git promise.
  const run = async (args) => {
    calls.push(args);
    return args.includes('add') ? held : { code: 0, stdout: '' };
  };
  const creation = prepareWorktreeCheckout(
    {
      exists: false,
      name: 'topic',
      repoDir: '/isolated/repo.git',
      wtDir: '/isolated/repo/topic',
    },
    { run }
  );
  for (let i = 0; i < 10; i += 1) {
    // biome-ignore lint/performance/noAwaitInLoops: Advance the command promise chain without releasing the held Git add.
    await Promise.resolve();
  }
  expect(calls.some((args) => args.includes('add'))).toBe(true);
  finish({ code: 0, stdout: '' });
  await creation;
});

test('existing checkout path must be a linked worktree, not a plain parent directory', async () => {
  const root = mkdtempSync(join(tmpdir(), 'setu-worktree-checkout-'));
  try {
    const source = join(root, 'source');
    const repoDir = join(root, 'repo.git');
    execFileSync('git', ['init', '-b', 'main', source]);
    execFileSync('git', [
      '-C',
      source,
      'config',
      'user.email',
      'test@example.com',
    ]);
    execFileSync('git', ['-C', source, 'config', 'user.name', 'Test']);
    writeFileSync(join(source, 'README.md'), 'seed');
    execFileSync('git', ['-C', source, 'add', '.']);
    execFileSync('git', ['-C', source, 'commit', '-m', 'seed']);
    execFileSync('git', ['clone', '--bare', source, repoDir]);
    const wtDir = join(root, 'repo', 'feat');
    mkdirSync(join(wtDir, 'x'), { recursive: true });
    // biome-ignore lint/suspicious/useAwait: This synchronous Git fixture implements the production async command interface.
    const run = async (args) => {
      try {
        return {
          code: 0,
          stderr: '',
          stdout: execFileSync(args[0], args.slice(1), { encoding: 'utf8' }),
          timedOut: false,
          truncated: false,
        };
      } catch (error) {
        return {
          code: error.status ?? 1,
          stderr: String(error.stderr ?? ''),
          stdout: String(error.stdout ?? ''),
          timedOut: false,
          truncated: false,
        };
      }
    };
    await expect(
      prepareWorktreeCheckout(
        { exists: true, name: 'feat', repoDir, wtDir },
        { run }
      )
    ).rejects.toThrow('not a linked worktree');
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

for (const kind of ['clone', 'checkout']) {
  test(`production status read completes while admitted ${kind} remains pending`, async () => {
    let release, entered, deadline;
    const held = new Promise((resolve) => {
      release = resolve;
    });
    const started = new Promise((resolve) => {
      entered = resolve;
    });
    const target = {
      key: 'r/topic',
      name: 'topic',
      repo: 'r',
      repoDir: '/isolated/r.git',
      wtDir: '/isolated/r/topic',
    };
    const lifecycle = createWorktreeLifecycle({
      capacity: {
        refresh: () =>
          Promise.resolve({
            available: true,
            cpus: 4,
            engine: 'fixture',
            memMb: 8192,
          }),
      },
      clock: { clearTimeout, now: () => 0, setTimeout },
      runtime: {},
      settings: { maxConcurrentDevServers: 3 },
      validateTarget: () => {
        /* No side effect is needed in this fixture. */
        return Promise.resolve();
      },
    });
    // biome-ignore lint/suspicious/useAwait: Setup must adopt the held command promise and reject callback failures.
    const run = async (args) => {
      if (args[1] === 'clone' || args.includes('add')) {
        entered();
        return held;
      }
      return { code: 0, stdout: '' };
    };
    const setup = lifecycle.runOperation(target, 'setup', async () => {
      if (kind === 'clone') {
        await cloneBareRepository(target.repoDir, 'git@example/r', null, {
          run,
        });
      } else {
        await prepareWorktreeCheckout({ ...target, exists: false }, { run });
      }
      return { ok: true };
    });
    await started;
    try {
      const status = await Promise.race([
        readPortalStatus({
          config: { maxConcurrentDevServers: 3 },
          lifecycle,
          pendingRemovals: () => [],
          readHostHealth: () => Promise.resolve({ state: 'ready' }),
        }),
        new Promise((_, reject) => {
          deadline = setTimeout(
            () => reject(new Error('Status waited for setup')),
            500
          );
        }),
      ]);
      expect(status).toMatchObject({
        concurrency: { active: 0, max: 3, queued: 0 },
        container: { engineAvailable: true },
        hostHealth: { state: 'ready' },
      });
      expect(lifecycle.operationStatus(target.key)).toMatchObject({
        kind: 'setup',
        phase: 'running',
      });
      expect(
        await lifecycle.runOperation(target, 'remove', () =>
          Promise.resolve({
            ok: true,
          })
        )
      ).toMatchObject({ code: 'TARGET_BUSY', ok: false });
    } finally {
      clearTimeout(deadline);
      release({ code: 0, stdout: '' });
      await setup;
      lifecycle.dispose();
    }
  });
}
