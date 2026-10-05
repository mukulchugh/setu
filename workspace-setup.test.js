import { expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readPortalStatus } from './portal-status.js';
import {
  cloneBareRepository,
  installWorktreeDependencies,
  prepareWorktreeCheckout,
  startWorktreeSetupInstall,
} from './workspace-setup.js';
import { createWorktreeLifecycle } from './worktree-lifecycle.js';

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
      localDom: 'r-topic.quivly.local',
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
    assertStorage: async () => {},
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
  const assertStorage = async () => {
    throw refusal;
  };
  f.deps.assertStorage = assertStorage;
  try {
    expect(await f.create()).toMatchObject({ ok: false, code: 'STORAGE_LOW' });
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
      domain: 'r-topic.quivly.local',
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

test('manifest selection stays shared by CLI and portal dependency installation', async () => {
  for (const [manifest, command, args] of [
    ['package.json', 'bun', ['install']],
    ['pyproject.toml', 'uv', ['sync']],
    ['requirements.txt', 'uv', ['sync']],
    [null, null, null],
  ]) {
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
        expect(spawned[1].slice(4)).toEqual([command, ...args]);
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
});

test('inline dependency installation forwards its stdio choice', async () => {
  let options;
  await installWorktreeDependencies('/fixture', {
    assertStorage: async () => {},
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

test('clone awaits the checked async command before registration preparation and preserves command failure', async () => {
  const calls = [];
  let finish;
  const held = new Promise((resolve) => {
    finish = resolve;
  });
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
