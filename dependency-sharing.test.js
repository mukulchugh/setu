/** biome-ignore-all lint/performance/noAwaitInLoops: Each case mutates its fixture before checking the next rejection. */
import { expect, test } from 'bun:test';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  dependencySharingForTarget,
  sharedDependencyInstall,
} from './dependency-sharing.js';
import {
  installWorktreeDependencies,
  startWorktreeSetupInstall,
} from './workspace-setup.js';

function fixture() {
  // The production store refuses path segments named tmp or temp. The macOS
  // per-user temp directory has neither, so fixtures stay out of the home
  // directory unless a pilot root is supplied.
  const dir = realpathSync(
    mkdtempSync(
      join(
        process.env.SETU_SHARING_TEST_ROOT || tmpdir(),
        '.setu-sharing-test-'
      )
    )
  );
  const workspace = join(dir, 'workspace');
  mkdirSync(workspace);
  const wtDir = join(workspace, 'checkout'),
    storeRoot = join(dir, 'protected-store');
  mkdirSync(wtDir);
  mkdirSync(storeRoot, { mode: 0o700 });
  writeFileSync(join(wtDir, 'package.json'), '{}');
  writeFileSync(join(wtDir, 'bun.lock'), '{}');
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
  }
});
