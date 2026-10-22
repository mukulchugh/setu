import { expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import {
  recordDependencyConsumer,
  sharedDependencyInstall,
} from './dependency-sharing.js';
import {
  installWorktreeDependencies,
  startWorktreeSetupInstall,
} from './workspace-setup.js';
import { createWorkspaceState } from './workspace-state.js';

const nativeModulePaths = [
  './dependency-file-native.js',
  './dependency-file-inputs.js',
  './dependency-file-store.js',
  './dependency-file-journal.js',
  './dependency-file-sharing.js',
];
const missingNativeModules = nativeModulePaths.filter(
  (path) => !existsSync(new URL(path, import.meta.url))
);
const DIGEST_RE = /^[a-f0-9]{64}$/;
const pinnedBunTest = test;
const PINNED_BUN = process.env.SETU_TEST_DEPENDENCY_BUN ?? process.execPath;

function makeGitFixture(label) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), `${label}-`)));
  const workspace = join(root, 'workspace');
  const source = join(root, 'source');
  const repoDir = join(root, 'repo.git');
  const checkout = join(workspace, 'repo', 'topic');
  mkdirSync(workspace);
  mkdirSync(source);
  mkdirSync(join(workspace, 'repo'), { recursive: true });
  execFileSync('git', ['init', '--quiet', '--initial-branch=main', source]);
  writeFileSync(
    join(source, 'package.json'),
    JSON.stringify({ name: 'fixture', workspaces: ['packages/*'] })
  );
  writeFileSync(join(source, 'bun.lock'), '{"lockfileVersion":1}\n');
  writeFileSync(join(source, 'bunfig.toml'), '[install]\nlinker = "hoisted"\n');
  writeFileSync(join(source, '.gitignore'), 'node_modules/\nignored/\n');
  mkdirSync(join(source, 'packages', 'core'), { recursive: true });
  writeFileSync(
    join(source, 'packages', 'core', 'package.json'),
    JSON.stringify({ name: '@fixture/core' })
  );
  execFileSync('git', ['-C', source, 'add', '.']);
  execFileSync('git', [
    '-C',
    source,
    '-c',
    'user.name=Setu fixture',
    '-c',
    'user.email=setu-fixture@invalid',
    'commit',
    '--quiet',
    '-m',
    'fixture',
  ]);
  execFileSync('git', ['clone', '--quiet', '--bare', source, repoDir]);
  execFileSync('git', [
    '--git-dir',
    repoDir,
    'worktree',
    'add',
    '--quiet',
    '-b',
    'topic',
    checkout,
    'main',
  ]);
  return {
    checkout,
    dispose: () => rmSync(root, { force: true, recursive: true }),
    repoDir,
    root,
    source,
    workspace,
  };
}

function makeIsolatedFixture() {
  const root = realpathSync(
    mkdtempSync(join(tmpdir(), 'setu-hoisted-isolated-regression-'))
  );
  const workspace = join(root, 'workspace');
  const checkout = join(workspace, 'repo', 'topic');
  const storeRoot = join(root, 'private-store');
  mkdirSync(checkout, { recursive: true });
  mkdirSync(storeRoot, { mode: 0o700 });
  writeFileSync(join(checkout, 'package.json'), '{"name":"fixture"}\n');
  writeFileSync(join(checkout, 'bun.lock'), '{"lockfileVersion":1}\n');
  writeFileSync(
    join(checkout, 'bunfig.toml'),
    '[install]\nlinker = "isolated"\n'
  );
  const sharing = {
    enabled: true,
    executable: PINNED_BUN,
    storeIdentity: {
      device: statSync(storeRoot).dev,
      mountPath: realpathSync(root),
    },
    storeRoot: realpathSync(storeRoot),
    version: '1.3.14',
    workspaceRoot: realpathSync(workspace),
  };
  const state = createWorkspaceState({
    configPath: join(root, 'config.json'),
    setuDir: root,
    workspaceRoot: workspace,
  });
  return {
    checkout,
    dispose: () => rmSync(root, { force: true, recursive: true }),
    sharing,
    state,
    storeRoot,
    workspace,
  };
}

test('package source allowlist covers the hoisted runtime and both G8 tests', () => {
  const manifest = JSON.parse(
    readFileSync(new URL('./package.json', import.meta.url), 'utf8')
  );
  const packedFiles = new Set(manifest.files);
  const requiredRuntimePaths = [
    'dependency-file-native.js',
    'dependency-file-engine.js',
    'dependency-file-inputs.js',
    'dependency-file-store.js',
    'dependency-file-journal.js',
    'dependency-file-sharing.js',
    'dependency-file-service.js',
    'engines/dependency-files/Cargo.toml',
    'engines/dependency-files/Cargo.lock',
    'engines/dependency-files/src',
  ];
  expect(requiredRuntimePaths.filter((path) => !packedFiles.has(path))).toEqual(
    []
  );
  expect(manifest.scripts.test).toContain(
    './dependency-file-integration.test.js'
  );
  expect(manifest.scripts.test).toContain(
    './dependency-file-adversarial.test.js'
  );
});

test('the existing isolated installer still emits its pinned global-store plan and consumer record', async () => {
  const f = makeIsolatedFixture();
  try {
    const plan = await sharedDependencyInstall(f.checkout, f.sharing);
    const namespace = join(f.storeRoot, 'darwin-arm64-bun-1.3.14');
    expect(plan.mode).toBe('isolated');
    expect(plan.linker).toBe('isolated');
    expect(plan.namespace).toBe('darwin-arm64-bun-1.3.14');
    expect(plan.command[0]).toBe(realpathSync(PINNED_BUN));
    expect(plan.command[1]).toEqual([
      'install',
      '--frozen-lockfile',
      '--linker',
      'isolated',
      '--backend',
      'copyfile',
      '--cache-dir',
      namespace,
    ]);
    expect(plan.env.BUN_INSTALL_GLOBAL_STORE).toBe('1');
    expect(plan.env.BUN_INSTALL_CACHE_DIR).toBe(namespace);
    expect(existsSync(join(f.checkout, 'node_modules'))).toBe(false);

    await recordDependencyConsumer(f.state, f.checkout, f.sharing, plan);
    const consumer =
      f.state.read('dependencyViews').consumers[realpathSync(f.checkout)];
    expect(consumer).toEqual({
      bunVersion: '1.3.14',
      checkout: realpathSync(f.checkout),
      linkerMode: 'isolated',
      lockfileHash: createHash('sha256')
        .update('{"lockfileVersion":1}\n')
        .digest('hex'),
      platformNamespace: 'darwin-arm64-bun-1.3.14',
    });
  } finally {
    f.dispose();
  }
});

pinnedBunTest(
  'synchronous CLI and background portal callers preserve the existing isolated linker contract',
  async () => {
    const cli = makeIsolatedFixture();
    const cliCalls = [];
    try {
      await installWorktreeDependencies(cli.checkout, {
        assertStorage: () => Promise.resolve(),
        assertStoreStorage: () => Promise.resolve(),
        exists: existsSync,
        run: (...args) => {
          cliCalls.push(args);
          return { status: 0 };
        },
        sharing: cli.sharing,
        state: cli.state,
      });
      const expectedNamespace = join(cli.storeRoot, 'darwin-arm64-bun-1.3.14');
      expect(cliCalls).toHaveLength(1);
      expect(cliCalls[0][0]).toBe(realpathSync(PINNED_BUN));
      expect(cliCalls[0][1]).toEqual([
        'install',
        '--frozen-lockfile',
        '--linker',
        'isolated',
        '--backend',
        'copyfile',
        '--cache-dir',
        expectedNamespace,
      ]);
      expect(cliCalls[0][2].env.BUN_INSTALL_GLOBAL_STORE).toBe('1');
      expect(
        cli.state.read('dependencyViews').consumers[realpathSync(cli.checkout)]
          ?.linkerMode
      ).toBe('isolated');
    } finally {
      cli.dispose();
    }

    const portal = makeIsolatedFixture();
    let finishExit;
    const exited = new Promise((resolve) => {
      finishExit = resolve;
    });
    const context = {
      ready: false,
      res: {
        localDom: 'topic.setu.local',
        port: 3301,
        wtDir: portal.checkout,
      },
    };
    const launches = [];
    try {
      const started = await startWorktreeSetupInstall(context, {
        assertStorage: () => Promise.resolve(),
        assertStoreStorage: () => Promise.resolve(),
        closeLog: () => undefined,
        exists: existsSync,
        openLog: () => 8,
        sharing: portal.sharing,
        spawn: (args, options) => {
          launches.push({ args, options });
          return { exited, pid: 321 };
        },
        state: portal.state,
        stopProcess: () => Promise.resolve(),
      });
      expect(started.result.setup).toBe('installing');
      expect(context.ready).toBe(false);
      expect(launches).toHaveLength(1);
      expect(launches[0].args.slice(0, 2)).toEqual([
        realpathSync(PINNED_BUN),
        'install',
      ]);
      expect(launches[0].options.env.BUN_INSTALL_GLOBAL_STORE).toBe('1');

      finishExit(0);
      await started.completion;
      expect(context.ready).toBe(true);
      expect(
        portal.state.read('dependencyViews').consumers[
          realpathSync(portal.checkout)
        ]?.linkerMode
      ).toBe('isolated');
    } finally {
      portal.dispose();
    }
  }
);

if (missingNativeModules.length > 0) {
  test.skip(`G2/G4 discovery-to-store integration pending sibling modules: ${missingNativeModules.join(', ')}`, () =>
    undefined);
} else {
  const { dependencyFileInputs } = await import('./dependency-file-inputs.js');

  test('input discovery finds the checkout and tracked or untracked nested workspace views without following workspace symlinks', async () => {
    const f = makeGitFixture('setu-dependency-inputs');
    try {
      const { checkout } = f;
      const nested = join(checkout, 'packages', 'core');
      const untracked = join(checkout, 'examples', 'labs');
      const ignored = join(checkout, 'ignored', 'private');
      mkdirSync(join(checkout, 'node_modules', 'pkg-root'), {
        recursive: true,
      });
      mkdirSync(join(nested, 'node_modules', 'pkg-core'), {
        recursive: true,
      });
      mkdirSync(untracked, { recursive: true });
      writeFileSync(
        join(untracked, 'package.json'),
        JSON.stringify({ name: '@fixture/untracked' })
      );
      mkdirSync(join(untracked, 'node_modules', 'pkg-untracked'), {
        recursive: true,
      });
      mkdirSync(join(ignored, 'node_modules', 'pkg-ignored'), {
        recursive: true,
      });
      writeFileSync(
        join(ignored, 'package.json'),
        JSON.stringify({ name: '@fixture/ignored' })
      );
      mkdirSync(join(checkout, 'node_modules', '@fixture'), {
        recursive: true,
      });
      symlinkSync(
        relative(join(checkout, 'node_modules', '@fixture'), nested),
        join(checkout, 'node_modules', '@fixture', 'core')
      );

      const result = await dependencyFileInputs(checkout);
      const expectedRoots = [
        'examples/labs/node_modules',
        'node_modules',
        'packages/core/node_modules',
      ].sort();
      expect(result).toMatchObject({ linker: 'hoisted' });
      expect(result.roots).toEqual(expectedRoots);
      expect(new Set(result.roots).size).toBe(result.roots.length);
      expect(
        result.roots.some((root) => root.split('/').includes('.git'))
      ).toBe(false);
      expect(result.inputDigest).toMatch(DIGEST_RE);
      expect(result.lockfileHash).toBe(
        createHash('sha256').update('{"lockfileVersion":1}\n').digest('hex')
      );
    } finally {
      f.dispose();
    }
  });
}
