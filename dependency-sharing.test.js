/** biome-ignore-all lint/performance/noAwaitInLoops: Each case mutates its fixture before checking the next rejection. */
import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  dependencySharingForTarget,
  inspectDependencyView,
  recordDependencyConsumer,
  repairDependencyView,
  sharedDependencyInstall,
} from './dependency-sharing.js';
import {
  installWorktreeDependencies,
  startWorktreeSetupInstall,
} from './workspace-setup.js';

import { createWorkspaceState } from './workspace-state.js';

const SHA256 = /^[a-f0-9]{64}$/;

function consumerFor(f) {
  return {
    bunVersion: '1.3.14',
    checkout: realpathSync(f.wtDir),
    linkerMode: 'isolated',
    lockfileHash: createHash('sha256')
      .update(readFileSync(join(f.wtDir, 'bun.lock')))
      .digest('hex'),
    platformNamespace: 'darwin-arm64-bun-1.3.14',
  };
}

function createSharedView(f, consumer) {
  const target = join(
    f.storeRoot,
    consumer.platformNamespace,
    'links',
    'package@1.0.0'
  );
  mkdirSync(target, { recursive: true });
  mkdirSync(join(f.wtDir, 'node_modules', '.bun'), { recursive: true });
  symlinkSync(target, join(f.wtDir, 'node_modules', '.bun', 'package@1.0.0'));
}

function fixture() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), '.setu-sharing-test-')));
  const workspace = join(dir, 'workspace');
  mkdirSync(workspace);
  const wtDir = join(workspace, 'checkout'),
    storeRoot = join(dir, 'protected-store');
  mkdirSync(wtDir);
  mkdirSync(storeRoot, { mode: 0o700 });
  writeFileSync(join(wtDir, 'package.json'), '{}');
  writeFileSync(join(wtDir, 'bun.lock'), '{}');
  writeFileSync(join(wtDir, 'bunfig.toml'), '[install]\nlinker = "isolated"\n');
  const executable = join(dir, 'fixture-installer');
  writeFileSync(
    executable,
    '#!/bin/sh\nprintf \'["1.3.14","darwin","arm64"]\\n\'\n',
    { mode: 0o700 }
  );
  return {
    dir,
    dispose: () => rmSync(dir, { recursive: true }),
    sharing: {
      enabled: true,
      executable,
      storeIdentity: { device: lstatSync(storeRoot).dev, mountPath: dir },
      storeRoot,
      version: '1.3.14',
      workspaceRoot: workspace,
    },
    storeRoot,
    workspace,
    wtDir,
  };
}

test('sharing is opt-in and rejects incomplete configuration before inspecting disk', async () => {
  expect(await sharedDependencyInstall('/absent', undefined)).toBeNull();
  expect(
    await sharedDependencyInstall('/absent', { enabled: false })
  ).toBeNull();
  for (const sharing of [
    { enabled: true },
    { enabled: true, version: '1.3.4' },
    { enabled: 'true' },
  ]) {
    await expect(sharedDependencyInstall('/absent', sharing)).rejects.toThrow(
      'explicit Bun 1.3.14'
    );
  }
});

test('hoisted projects refuse installed-package sharing without overriding their linker', async () => {
  const f = fixture();
  try {
    writeFileSync(
      join(f.wtDir, 'bunfig.toml'),
      '[install]\nlinker = "hoisted"\n'
    );
    await expect(
      sharedDependencyInstall(f.wtDir, f.sharing)
    ).rejects.toMatchObject({
      code: 'DEPENDENCY_LINKER_INCOMPATIBLE',
      message: expect.stringContaining('linker = "hoisted"'),
    });
    expect(existsSync(join(f.wtDir, 'node_modules'))).toBe(false);
  } finally {
    f.dispose();
  }
});

test('an unspecified linker is not overridden and refuses installed-package sharing', async () => {
  const f = fixture();
  try {
    rmSync(join(f.wtDir, 'bunfig.toml'));
    await expect(
      sharedDependencyInstall(f.wtDir, f.sharing)
    ).rejects.toMatchObject({
      code: 'DEPENDENCY_LINKER_INCOMPATIBLE',
      message: expect.stringContaining('linker = "isolated"'),
    });
  } finally {
    f.dispose();
  }
});

test('store identity rejects a missing root and a substituted volume before creating a namespace', async () => {
  const f = fixture();
  try {
    await expect(
      sharedDependencyInstall(f.wtDir, {
        ...f.sharing,
        storeRoot: join(f.dir, 'missing-store'),
      })
    ).rejects.toThrow('missing or unavailable');
    await expect(
      sharedDependencyInstall(f.wtDir, {
        ...f.sharing,
        storeIdentity: { ...f.sharing.storeIdentity, device: -1 },
      })
    ).rejects.toThrow('configured volume');
    expect(existsSync(join(f.storeRoot, 'darwin-arm64-bun-1.3.14'))).toBe(
      false
    );
  } finally {
    f.dispose();
  }
});

test('dependency view inspection proves links, lockfile, store and linker before calling a view healthy', async () => {
  const f = fixture();
  try {
    const consumer = consumerFor(f);
    const sharing = {
      ...f.sharing,
      consumers: { [consumer.checkout]: consumer },
    };
    createSharedView(f, consumer);
    expect((await inspectDependencyView(f.wtDir, sharing)).state).toBe(
      'shared and healthy'
    );
    const substituteStore = join(f.dir, 'substitute-store');
    mkdirSync(substituteStore, { mode: 0o700 });
    expect(
      (
        await inspectDependencyView(f.wtDir, {
          ...sharing,
          storeRoot: substituteStore,
        })
      ).state
    ).toBe('unknown');
    writeFileSync(join(f.wtDir, 'bun.lock'), '{"changed":true}');
    expect((await inspectDependencyView(f.wtDir, sharing)).state).toBe(
      'unknown'
    );
    writeFileSync(join(f.wtDir, 'bun.lock'), '{}');
    rmSync(join(f.wtDir, 'node_modules', '.bun', 'package@1.0.0'));
    symlinkSync(
      join(f.storeRoot, 'missing-target'),
      join(f.wtDir, 'node_modules', '.bun', 'package@1.0.0')
    );
    expect((await inspectDependencyView(f.wtDir, sharing)).state).toBe(
      'dangling'
    );
    rmSync(join(f.wtDir, 'node_modules'), { recursive: true });
    mkdirSync(join(f.wtDir, 'node_modules'));
    expect((await inspectDependencyView(f.wtDir, sharing)).state).toBe(
      'shared but replaced by an ordinary install'
    );
    writeFileSync(
      join(f.wtDir, 'bunfig.toml'),
      '[install]\nlinker = "hoisted"\n'
    );
    expect((await inspectDependencyView(f.wtDir, sharing)).state).toBe(
      'unknown'
    );
    writeFileSync(
      join(f.wtDir, 'bunfig.toml'),
      '[install]\nlinker = "isolated"\n'
    );
    await expect(
      inspectDependencyView(f.wtDir, {
        ...sharing,
        storeRoot: join(f.dir, 'missing'),
      })
    ).resolves.toMatchObject({ state: 'unknown' });
  } finally {
    f.dispose();
  }
});

test('repair returns an isolated command without modifying a recorded replaced view and refuses hoisted content', async () => {
  const f = fixture();
  const oldSecret = process.env.SETU_REPAIR_SECRET_FIXTURE;
  process.env.SETU_REPAIR_SECRET_FIXTURE =
    'private-value-must-not-leave-the-process';
  try {
    const consumer = consumerFor(f);
    const sharing = {
      ...f.sharing,
      consumers: { [consumer.checkout]: consumer },
    };
    mkdirSync(join(f.wtDir, 'node_modules'));
    const ordinary = join(f.wtDir, 'node_modules', 'unowned.txt');
    writeFileSync(ordinary, 'keep');
    const repair = await repairDependencyView(f.wtDir, sharing);
    expect(repair).toMatchObject({ mode: 'isolated', ok: true });
    expect(Object.keys(repair.env).sort()).toEqual([
      'BUN_INSTALL_CACHE_DIR',
      'BUN_INSTALL_GLOBAL_STORE',
    ]);
    expect(
      JSON.stringify(repair).includes(process.env.SETU_REPAIR_SECRET_FIXTURE)
    ).toBe(false);
    expect(repair.command[1]).toEqual([
      'install',
      '--frozen-lockfile',
      '--linker',
      'isolated',
      '--backend',
      'copyfile',
      '--cache-dir',
      join(f.storeRoot, 'darwin-arm64-bun-1.3.14'),
    ]);
    expect(readFileSync(ordinary, 'utf8')).toBe('keep');
    writeFileSync(
      join(f.wtDir, 'bunfig.toml'),
      '[install]\nlinker = "hoisted"\n'
    );
    expect((await repairDependencyView(f.wtDir, sharing)).code).toBe(
      'DEPENDENCY_VIEW_NOT_MANAGED'
    );
    expect(readFileSync(ordinary, 'utf8')).toBe('keep');
  } finally {
    if (oldSecret === undefined) {
      delete process.env.SETU_REPAIR_SECRET_FIXTURE;
    } else {
      process.env.SETU_REPAIR_SECRET_FIXTURE = oldSecret;
    }
    f.dispose();
  }
});

test('consumer records are written through workspace-state with the lockfile hash and resolved runtime namespace', async () => {
  const f = fixture();
  try {
    const configPath = join(f.dir, 'setu.json');
    const state = createWorkspaceState({
      configPath,
      setuDir: f.dir,
      workspaceRoot: f.workspace,
    });
    await state.replace('config', {
      dependencySharing: { enabled: true },
      userSetting: 'preserve this exact document',
    });
    const configBefore = readFileSync(configPath, 'utf8');
    const plan = await sharedDependencyInstall(f.wtDir, f.sharing);
    const recorded = await recordDependencyConsumer(
      state,
      f.wtDir,
      f.sharing,
      plan
    );
    expect(recorded).toMatchObject({
      consumer: {
        bunVersion: '1.3.14',
        checkout: realpathSync(f.wtDir),
        linkerMode: 'isolated',
        platformNamespace: 'darwin-arm64-bun-1.3.14',
      },
      ok: true,
    });
    expect(recorded.consumer.lockfileHash).toMatch(SHA256);
    expect(state.read('dependencyViews')).toEqual({
      consumers: { [recorded.consumer.checkout]: recorded.consumer },
    });
    expect(readFileSync(configPath, 'utf8')).toBe(configBefore);
  } finally {
    f.dispose();
  }
});

test('sharing rejects existing views, unsafe stores, and missing locks without conversion', async () => {
  const f = fixture();
  try {
    for (const kind of ['directory', 'dangling']) {
      const view = join(f.wtDir, 'node_modules');
      if (kind === 'directory') {
        mkdirSync(view);
      } else {
        symlinkSync('/absent-dependency-view', view);
      }
      await expect(sharedDependencyInstall(f.wtDir, f.sharing)).rejects.toThrow(
        'migration is not automatic'
      );
      expect(lstatSync(view).isSymbolicLink()).toBe(kind === 'dangling');
      rmSync(view, { recursive: true });
    }
    chmodSync(f.storeRoot, 0o755);
    await expect(sharedDependencyInstall(f.wtDir, f.sharing)).rejects.toThrow(
      'private, owned'
    );
    chmodSync(f.storeRoot, 0o700);
    const alias = join(f.dir, 'alias');
    symlinkSync(f.storeRoot, alias);
    await expect(
      sharedDependencyInstall(f.wtDir, { ...f.sharing, storeRoot: alias })
    ).rejects.toThrow('private, owned');
    await expect(
      sharedDependencyInstall(f.wtDir, { ...f.sharing, storeRoot: f.wtDir })
    ).rejects.toThrow('outside checkouts');
    await expect(
      sharedDependencyInstall(f.wtDir, {
        ...f.sharing,
        storeRoot: join(f.dir, '.bun-cache'),
      })
    ).rejects.toThrow('disposable');
    rmSync(join(f.wtDir, 'bun.lock'));
    await expect(
      sharedDependencyInstall(f.wtDir, f.sharing)
    ).rejects.toMatchObject({ code: 'ENOENT' });
    expect(existsSync(join(f.storeRoot, 'darwin-arm64-bun-1.3.14'))).toBe(
      false
    );
  } finally {
    f.dispose();
  }
});

test('consumer completion preserves malformed journal bytes instead of replacing them', async () => {
  const f = fixture();
  try {
    const state = createWorkspaceState({
      configPath: join(f.dir, 'setu.json'),
      setuDir: f.dir,
      workspaceRoot: f.workspace,
    });
    const path = join(f.workspace, '.setu-dependency-views.json');
    const plan = { linker: 'isolated', namespace: 'darwin-arm64-bun-1.3.14' };
    for (const consumers of [
      null,
      [],
      { '/bad': { checkout: '/different' } },
    ]) {
      await state.replace('dependencyViews', {
        consumers,
        unrelated: 'preserve',
      });
      const before = readFileSync(path, 'utf8');
      await expect(
        recordDependencyConsumer(state, f.wtDir, f.sharing, plan)
      ).rejects.toMatchObject({ code: 'DEPENDENCY_VIEW_STATE_CORRUPT' });
      expect(readFileSync(path, 'utf8')).toBe(before);
    }
  } finally {
    f.dispose();
  }
});

test('one frozen copyfile plan reaches CLI and portal, with independent store storage gates', async () => {
  const f = fixture(),
    storage = [],
    calls = [];
  try {
    const deps = {
      assertStorage: (path) => {
        storage.push(['checkout', path]);
        return Promise.resolve();
      },
      assertStoreStorage: (path) => {
        storage.push(['store', path]);
        return Promise.resolve();
      },
      exists: existsSync,
      sharing: f.sharing,
      // Each fake installer invocation models a fresh view. Durable consumer
      // persistence is covered separately with real workspace-state below.
      state: { read: () => ({}), update: async (_name, change) => change({}) },
    };
    await installWorktreeDependencies(f.wtDir, {
      ...deps,
      run: (...args) => {
        calls.push(args);
        return { status: 0 };
      },
    });
    const context = { ready: false, res: { wtDir: f.wtDir } };
    let finish,
      stopped = false;
    const exited = new Promise((resolve) => {
      finish = resolve;
    });
    const pending = await startWorktreeSetupInstall(context, {
      ...deps,
      closeLog: () => {
        /* Fixture descriptor requires no close. */
      },
      openLog: () => 3,
      spawn: (...args) => {
        calls.push(args);
        return { exited, pid: 100 };
      },
      stopProcess: () => {
        stopped = true;
        return Promise.resolve();
      },
    });
    expect(context.ready).toBe(false);
    const [executable, installArgs, options] = calls[0];
    expect(installArgs).toEqual([
      'install',
      '--frozen-lockfile',
      '--linker',
      'isolated',
      '--backend',
      'copyfile',
      '--cache-dir',
      join(f.storeRoot, 'darwin-arm64-bun-1.3.14'),
    ]);
    expect(calls[1][0].slice(4)).toEqual([executable, ...installArgs]);
    expect(calls[1][1].env).toEqual(options.env);
    expect(options.env.BUN_INSTALL_GLOBAL_STORE).toBe('1');
    expect(storage.filter(([kind]) => kind === 'checkout')).toHaveLength(2);
    expect(storage.filter(([kind]) => kind === 'store')).toHaveLength(4);
    finish(0);
    await pending.completion;
    expect(context.ready).toBe(true);
    expect(stopped).toBe(true);
    const failure = Object.assign(new Error('Store is full'), {
      code: 'STORAGE_LOW',
    });
    await expect(
      installWorktreeDependencies(f.wtDir, {
        ...deps,
        assertStoreStorage: () => Promise.reject(failure),
        run: () => {
          throw new Error('must not spawn');
        },
      })
    ).rejects.toBe(failure);
    await expect(
      startWorktreeSetupInstall(context, {
        ...deps,
        assertStoreStorage: () => Promise.reject(failure),
        openLog: () => {
          throw new Error('must not open');
        },
      })
    ).rejects.toBe(failure);
  } finally {
    f.dispose();
  }
});

test('the executable must report the tested version, OS and architecture before store creation', async () => {
  const f = fixture();
  try {
    for (const runtime of [
      ['1.3.4', 'darwin', 'arm64'],
      ['1.3.14', 'linux', 'arm64'],
      ['1.3.14', 'darwin', 'x64'],
    ]) {
      writeFileSync(
        f.sharing.executable,
        `#!/bin/sh\nprintf '${JSON.stringify(runtime)}\\n'\n`,
        { mode: 0o700 }
      );
      await expect(sharedDependencyInstall(f.wtDir, f.sharing)).rejects.toThrow(
        'tested only'
      );
      expect(existsSync(join(f.storeRoot, 'darwin-arm64-bun-1.3.14'))).toBe(
        false
      );
    }
    writeFileSync(f.sharing.executable, '#!/bin/sh\nexit 7\n', { mode: 0o700 });
    await expect(sharedDependencyInstall(f.wtDir, f.sharing)).rejects.toThrow();
  } finally {
    f.dispose();
  }
});

test('a protected store cannot live anywhere in the managed workspace, including aliases', async () => {
  const f = fixture();
  try {
    const sibling = join(f.workspace, 'other-checkout');
    mkdirSync(sibling);
    const store = join(sibling, 'private-store');
    mkdirSync(store, { mode: 0o700 });
    const alias = join(f.dir, 'workspace-alias');
    symlinkSync(f.workspace, alias);
    for (const [workspace, storeRoot] of [
      [f.workspace, store],
      [alias, store],
      [f.workspace, join(alias, 'other-checkout/private-store')],
      [f.workspace, f.workspace],
      [f.workspace, f.dir],
    ]) {
      await expect(
        sharedDependencyInstall(f.wtDir, {
          ...f.sharing,
          storeRoot,
          workspaceRoot: workspace,
        })
      ).rejects.toThrow('outside the managed workspace');
    }
    await expect(
      sharedDependencyInstall(f.wtDir, {
        ...f.sharing,
        workspaceRoot: undefined,
      })
    ).rejects.toThrow('workspace');
    expect(existsSync(join(store, 'darwin-arm64-bun-1.3.14'))).toBe(false);
  } finally {
    f.dispose();
  }
});

test('missing config or explicit enabled:false preserves ordinary setup', () => {
  expect(
    dependencySharingForTarget(undefined, 'r', 'feat/topic')
  ).toBeUndefined();
  expect(
    dependencySharingForTarget({ workspace: '/managed' }, 'r', 'feat/topic')
  ).toBeUndefined();
  expect(
    dependencySharingForTarget(
      {
        dependencySharing: {
          enabled: false,
          executable: '/bun',
          storeRoot: '/store',
          targets: { 'r/feat/topic': true },
          version: '1.3.14',
        },
        workspace: '/managed',
      },
      'r',
      'feat/topic'
    )
  ).toBeUndefined();
});

test('a malformed or absent enabled value is rejected rather than silently disabled', () => {
  const base = {
    executable: '/bun',
    storeRoot: '/store',
    targets: { 'r/feat/topic': true },
    version: '1.3.14',
  };
  for (const enabled of ['true', 1, null]) {
    expect(() =>
      dependencySharingForTarget(
        { dependencySharing: { ...base, enabled }, workspace: '/managed' },
        'r',
        'feat/topic'
      )
    ).toThrow('enabled must be true or false');
  }
  // enabled reachable only through the prototype chain must not be trusted.
  const inherited = Object.assign(Object.create({ enabled: true }), base);
  expect(() =>
    dependencySharingForTarget(
      { dependencySharing: inherited, workspace: '/managed' },
      'r',
      'feat/topic'
    )
  ).toThrow('enabled must be true or false');
});

test('enabled:true requires an explicit targets map', () => {
  expect(() =>
    dependencySharingForTarget(
      {
        dependencySharing: {
          enabled: true,
          executable: '/bun',
          storeRoot: '/store',
          version: '1.3.14',
        },
        workspace: '/managed',
      },
      'r',
      'feat/topic'
    )
  ).toThrow('targets is required');
});

test('the resolved installer/store/version/workspace fields are validated synchronously, before any checkout exists', () => {
  const targets = { 'r/feat/topic': true };
  for (const fields of [
    { executable: 'bun', storeRoot: '/store', version: '1.3.14' },
    { executable: '/bun', storeRoot: 'store', version: '1.3.14' },
    { executable: '/bun', storeRoot: '/store', version: '1.3.4' },
  ]) {
    expect(() =>
      dependencySharingForTarget(
        {
          dependencySharing: { enabled: true, targets, ...fields },
          workspace: '/managed',
        },
        'r',
        'feat/topic'
      )
    ).toThrow('explicit Bun 1.3.14');
  }
  expect(() =>
    dependencySharingForTarget(
      {
        dependencySharing: {
          enabled: true,
          executable: '/bun',
          storeRoot: '/store',
          targets,
          version: '1.3.14',
        },
        workspace: 'managed',
      },
      'r',
      'feat/topic'
    )
  ).toThrow('explicit Bun 1.3.14');
});

test('a central config resolves only its opted-in targets to one shared store', () => {
  const config = {
    dependencySharing: {
      enabled: true,
      executable: '/bun',
      storeRoot: '/store',
      targets: {
        'another-project/main': true,
        'r/feat/topic': true,
        'r/other': false,
      },
      version: '1.3.14',
    },
    workspace: '/managed',
  };
  expect(dependencySharingForTarget(config, 'r', 'feat/topic')).toEqual({
    enabled: true,
    executable: '/bun',
    storeRoot: '/store',
    version: '1.3.14',
    workspaceRoot: '/managed',
  });
  expect(dependencySharingForTarget(config, 'r', 'other')).toBeUndefined();
  expect(dependencySharingForTarget(config, 'r', 'unlisted')).toBeUndefined();
  expect(
    dependencySharingForTarget(config, 'other', 'feat/topic')
  ).toBeUndefined();
  expect(dependencySharingForTarget(config, 'another-project', 'main')).toEqual(
    dependencySharingForTarget(config, 'r', 'feat/topic')
  );
});

test('a legacy per-target policy map throws an actionable migration error, but only for the targets it configures', () => {
  const legacyPolicy = {
    enabled: true,
    executable: '/bun',
    storeRoot: '/store',
    version: '1.3.14',
  };
  const config = {
    dependencySharing: { 'r/feat/topic': legacyPolicy },
    workspace: '/managed',
  };
  expect(() => dependencySharingForTarget(config, 'r', 'feat/topic')).toThrow(
    'no longer supported'
  );
  expect(() => dependencySharingForTarget(config, 'r', 'feat/topic')).toThrow(
    'targets'
  );
  expect(
    dependencySharingForTarget(config, 'r', 'unconfigured')
  ).toBeUndefined();
  expect(
    dependencySharingForTarget(
      { ...config, dependencySharing: Object.create(config.dependencySharing) },
      'r',
      'feat/topic'
    )
  ).toBeUndefined();
  // An incomplete migration must not silently opt the legacy target out.
  expect(() =>
    dependencySharingForTarget(
      {
        ...config,
        dependencySharing: {
          ...config.dependencySharing,
          ...legacyPolicy,
          targets: {},
        },
      },
      'r',
      'feat/topic'
    )
  ).toThrow('no longer supported');
  expect(legacyPolicy.storeRoot).toBe('/store');
});

test('per-target store/executable/version overrides are rejected explicitly, not silently applied', () => {
  const config = {
    dependencySharing: {
      enabled: true,
      executable: '/bun',
      storeRoot: '/store',
      targets: { 'r/feat/topic': { storeRoot: '/other' } },
      version: '1.3.14',
    },
    workspace: '/managed',
  };
  expect(() => dependencySharingForTarget(config, 'r', 'feat/topic')).toThrow(
    'central-only'
  );
});

test('malformed central config and targets shapes fail before resolving a policy', () => {
  expect(() =>
    dependencySharingForTarget({ dependencySharing: '/store' }, 'r', 'name')
  ).toThrow('must be an object');
  expect(() =>
    dependencySharingForTarget(
      { dependencySharing: { enabled: true, targets: '/store' } },
      'r',
      'name'
    )
  ).toThrow('targets must be an object');
});

test('Python and manifest-free setup bypass even an invalid sharing policy', async () => {
  for (const manifest of ['pyproject.toml', 'requirements.txt', null]) {
    const calls = [];
    await installWorktreeDependencies('/absent', {
      assertStorage: () => Promise.resolve(),
      exists: (path) => !!manifest && path.endsWith(`/${manifest}`),
      run: (...args) => {
        calls.push(args);
        return { status: 0 };
      },
      sharing: { enabled: true },
    });
    expect(calls.map((args) => args.slice(0, 2))).toEqual(
      manifest ? [['uv', ['sync']]] : []
    );
    const spawned = [];
    const context = { ready: false, res: { wtDir: '/absent' } };
    const pending = await startWorktreeSetupInstall(context, {
      assertStorage: () => Promise.resolve(),
      closeLog: () => {},
      exists: (path) => !!manifest && path.endsWith(`/${manifest}`),
      openLog: () => 3,
      sharing: { enabled: true },
      spawn: (args) => {
        spawned.push(args.slice(4));
        return { exited: Promise.resolve(0), pid: 100 };
      },
      stopProcess: async () => {},
    });
    await pending.completion;
    expect(spawned).toEqual(manifest ? [['uv', 'sync']] : []);
    expect(context.ready).toBe(true);
  }
});
