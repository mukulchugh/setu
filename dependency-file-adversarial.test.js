import { expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { lstat, readFile, realpath, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { inspectCheckoutIdentity } from './checkout-identity.js';
import { setFixtureTimesNs } from './dependency-file-fixture-times.js';
import { createDependencyFileNative } from './dependency-file-native.js';
import { createDependencyFileService } from './dependency-file-service.js';
import { inspectDependencyReadiness } from './dependency-readiness.js';
import { createSetupProgress } from './setup-progress.js';
import { installWorktreeDependencies } from './workspace-setup.js';
import { createWorkspaceState } from './workspace-state.js';

const modulePaths = [
  './dependency-file-native.js',
  './dependency-file-inputs.js',
  './dependency-file-store.js',
  './dependency-file-journal.js',
  './dependency-file-sharing.js',
];
const missingModules = modulePaths.filter(
  (path) => !existsSync(new URL(path, import.meta.url))
);
const DIGEST_RE = /^[a-f0-9]{64}$/;
const PINNED_BUN = process.env.SETU_TEST_DEPENDENCY_BUN ?? process.execPath;
const checkoutFs = { lstat, readFile, realpath, stat };

function makeCheckoutFixture(label) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), `${label}-`)));
  const workspace = join(root, 'workspace');
  const source = join(root, 'source');
  const repoDir = join(root, 'repo.git');
  const checkout = join(workspace, 'repo', 'topic');
  const storeRoot = join(root, 'private-store');
  mkdirSync(workspace);
  mkdirSync(source);
  mkdirSync(join(workspace, 'repo'), { recursive: true });
  mkdirSync(storeRoot, { mode: 0o700 });
  mkdirSync(join(storeRoot, 'hoisted'), { mode: 0o700 });
  mkdirSync(join(storeRoot, 'hoisted', 'darwin-arm64-bun-1.3.14'), {
    mode: 0o700,
  });
  execFileSync('git', ['init', '--quiet', '--initial-branch=main', source]);
  writeFileSync(
    join(source, 'package.json'),
    JSON.stringify({ name: 'fixture', workspaces: ['packages/*'] })
  );
  writeFileSync(join(source, 'bun.lock'), '{"lockfileVersion":1}\n');
  writeFileSync(join(source, 'bunfig.toml'), '[install]\nlinker = "hoisted"\n');
  writeFileSync(join(source, '.gitignore'), 'node_modules/\n');
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
  mkdirSync(join(checkout, 'node_modules', 'pkg-a'), { recursive: true });
  mkdirSync(join(checkout, 'node_modules', '.bin'), { recursive: true });
  mkdirSync(join(checkout, 'packages', 'core', 'node_modules', 'pkg-b'), {
    recursive: true,
  });
  writeFileSync(
    join(checkout, 'node_modules', 'pkg-a', 'package.json'),
    JSON.stringify({ name: 'pkg-a', version: '1.0.0' })
  );
  writeFileSync(
    join(checkout, 'node_modules', 'pkg-a', 'index.js'),
    'module.exports = 17;\n'
  );
  writeFileSync(
    join(checkout, 'packages', 'core', 'node_modules', 'pkg-b', 'index.js'),
    'module.exports = 29;\n'
  );
  for (const relativePath of [
    'node_modules/pkg-a/package.json',
    'node_modules/pkg-a/index.js',
    'packages/core/node_modules/pkg-b/index.js',
  ]) {
    utimesSync(join(checkout, relativePath), 1_700_000_000, 1_700_000_000);
  }
  symlinkSync(
    '../pkg-a/index.js',
    join(checkout, 'node_modules', '.bin', 'pkg-a')
  );
  const sharing = {
    enabled: true,
    executable: PINNED_BUN,
    storeIdentity: {
      device: statSync(storeRoot).dev,
      mountPath: root,
    },
    storeRoot,
    version: '1.3.14',
    workspaceRoot: workspace,
  };
  const state = createWorkspaceState({
    configPath: join(root, 'config.json'),
    setuDir: root,
    workspaceRoot: workspace,
  });
  return {
    checkout,
    dispose: () => rmSync(root, { force: true, recursive: true }),
    repoDir,
    root,
    sharing,
    state,
    storeRoot,
    workspace,
  };
}

async function makeEngine(
  f,
  nativeOverrides = {},
  { nativeStatus = { available: true } } = {}
) {
  const counters = { exchanges: 0, reads: 0 };
  let exchangeHook = null;
  const fixtureNative = makeFixtureNative();
  const composedNative = { ...fixtureNative, ...nativeOverrides };
  const native = {
    ...composedNative,
    dependencyFileNativeStatus: () => Promise.resolve(nativeStatus),
    exchangeDependencyFiles: (
      root,
      targetRelativePath,
      temporaryRelativePath,
      options
    ) => {
      counters.exchanges += 1;
      if (exchangeHook) {
        return exchangeHook(
          root,
          targetRelativePath,
          temporaryRelativePath,
          options
        );
      }
      return testOnlyExchange(root, targetRelativePath, temporaryRelativePath);
    },
    readDependencyFile: (...args) => {
      counters.reads += 1;
      return composedNative.readDependencyFile(...args);
    },
  };
  const store = await f.modules.openDependencyFileStore(f.sharing, { native });
  const journal = f.modules.createDependencyFileJournal({
    now: () => Date.now(),
    randomId: randomUUID,
    state: f.state,
    storeRoot: store.identity.root,
  });
  const checkoutIdentity = await inspectCheckoutIdentity(
    { repoDir: f.repoDir, wtDir: f.checkout },
    checkoutFs
  );
  expect(checkoutIdentity.known).toBe(true);
  const target = {
    checkoutIdentity,
    name: 'topic',
    repo: 'repo',
    repoDir: f.repoDir,
    wtDir: f.checkout,
  };
  let mutableError = null;
  const engine = f.modules.createDependencyFileSharing({
    assertMutable: () => {
      if (mutableError) {
        throw mutableError;
      }
    },
    inputs: f.modules.dependencyFileInputs,
    journal,
    native,
    sharing: f.sharing,
    state: f.state,
    store,
  });
  return {
    counters,
    engine,
    journal,
    native,
    setExchangeHook: (hook) => {
      exchangeHook = hook;
    },
    setMutableError: (error) => {
      mutableError = error;
    },
    store,
    target,
  };
}

// This processRunner is an explicitly test-only OS seam for the unavailable
// compiled helper. Probe fields come from actual fixture inodes, xattrs are
// read with the installed xattr executable, and timestamp writes are applied
// to fixtures. It does not prove native helper acceptance or replace any
// G1/G2/G3/G4 factory.
function makeFixtureNative() {
  const helperPath = join(tmpdir(), 'setu-test-only-dependency-file-helper');
  const processRunner = (command, args) => {
    if (command === helperPath) {
      const [action, root, relativePath, atimeNs, mtimeNs] = args;
      if (action === 'version') {
        return {
          stdout: JSON.stringify({
            capabilities: ['stdio', 'xattrs', 'swap', 'forced-clone', 'lease'],
            ok: true,
            protocol: 2,
            version: '2',
          }),
        };
      }
      if (action === 'lease-acquire' || action === 'lease-release') {
        // Explicit protocol seam only; this does not acquire a kernel lock.
        return {
          stdout: JSON.stringify({
            key: action === 'lease-acquire' ? relativePath : root,
            lease: action === 'lease-acquire' ? 'acquired' : 'released',
            ok: true,
            protocol: 2,
          }),
        };
      }
      if (action === 'probe') {
        const info = statSync(join(root, relativePath), { bigint: true });
        const sparse =
          info.size > 0n && typeof info.blocks === 'bigint'
            ? info.blocks * 512n < info.size
            : false;
        return {
          stdout: JSON.stringify({
            acl: false,
            atimeNs: String(info.atimeNs),
            ctimeNs: String(info.ctimeNs),
            device: String(info.dev),
            flags: 0,
            gid: Number(info.gid),
            inode: String(info.ino),
            mode: Number(info.mode),
            mtimeNs: String(info.mtimeNs),
            nlink: Number(info.nlink),
            ok: true,
            protocol: 1,
            regular: info.isFile(),
            size: String(info.size),
            sparse,
            uid: Number(info.uid),
          }),
        };
      }
      if (action === 'restore-times') {
        const fullPath = join(root, relativePath);
        setFixtureTimesNs(fullPath, atimeNs, mtimeNs);
        const info = statSync(fullPath, { bigint: true });
        return {
          stdout: JSON.stringify({
            atimeNs: String(info.atimeNs),
            device: String(info.dev),
            inode: String(info.ino),
            mtimeNs: String(info.mtimeNs),
            ok: true,
            protocol: 1,
            restored:
              String(info.atimeNs) === atimeNs &&
              String(info.mtimeNs) === mtimeNs,
          }),
        };
      }
      throw new Error(`Unsupported fixture helper action: ${action}`);
    }
    return {
      stdout: execFileSync(command, args, { encoding: 'utf8' }),
    };
  };
  return createDependencyFileNative({
    nativeBinary: helperPath,
    processRunner,
  });
}

function testOnlyExchange(root, targetRelativePath, temporaryRelativePath) {
  // Explicit JS-only swap seam. It models the completed exchange for G4
  // checkpoint/recovery contracts; it is not acceptance of Darwin RENAME_SWAP.
  const target = resolve(root, targetRelativePath);
  const temporary = resolve(root, temporaryRelativePath);
  if (
    dirname(target) !== dirname(temporary) ||
    !target.startsWith(`${resolve(root)}/`) ||
    !temporary.startsWith(`${resolve(root)}/`)
  ) {
    throw new Error('The test swap seam accepts sibling paths under its root');
  }
  const displaced = join(dirname(target), `.g8-swap-${randomUUID()}`);
  renameSync(target, displaced);
  renameSync(temporary, target);
  renameSync(displaced, temporary);
  return { exchanged: true };
}

async function prepare(f) {
  const prepared = await f.engine.prepare(f.target);
  expect(
    prepared,
    `prepare returned ${prepared.code ?? 'no code'}`
  ).toMatchObject({
    ok: true,
  });
  expect(prepared.plan).toMatchObject({
    mode: 'hoisted-cow',
    physicalSavingsBytes: null,
  });
  expect(prepared.plan.id).toMatch(DIGEST_RE);
  return prepared.plan;
}

// biome-ignore lint/style/noNegationElse: The missing-source branch keeps a useful pending-test diagnostic while sibling modules are assembled.
if (!existsSync(new URL('./dependency-file-native.js', import.meta.url))) {
  test.skip('native contract cases pending dependency-file-native.js', () =>
    undefined);
} else {
  const nativeModule = await import('./dependency-file-native.js');
  const realNativeCapability = await nativeModule.dependencyFileNativeStatus();
  const nativeAcceptanceTest = realNativeCapability.available
    ? test
    : test.skip;

  nativeAcceptanceTest(
    `native fingerprints preserve supported metadata on forced clones and refuse symlink ancestors or hardlinks${realNativeCapability.available ? '' : ` (native helper unavailable: ${realNativeCapability.code})`}`,
    async () => {
      const root = realpathSync(
        mkdtempSync(join(tmpdir(), 'setu-dependency-native-g8-'))
      );
      const native = createDependencyFileNative();
      const storeRoot = join(root, 'private-store');
      mkdirSync(storeRoot, { mode: 0o700 });
      try {
        await native.withDependencyFileLease(storeRoot, root, async () => {
          const packageDir = join(root, 'node_modules', 'pkg');
          mkdirSync(packageDir, { recursive: true });
          writeFileSync(join(packageDir, 'index.js'), 'module.exports = 11;\n');
          execFileSync('/usr/bin/xattr', [
            '-w',
            'com.apple.quarantine',
            '0081;fixture;Setu;',
            join(packageDir, 'index.js'),
          ]);
          utimesSync(
            join(packageDir, 'index.js'),
            1_700_000_000,
            1_700_000_000
          );
          const source = await native.readDependencyFile(
            root,
            'node_modules/pkg/index.js'
          );
          expect(source.eligible).toBe(true);
          expect(
            source.fingerprint.attributes.some(
              ({ name }) => name === 'com.apple.quarantine'
            )
          ).toBe(true);
          const clone = await native.cloneDependencyFile(
            root,
            'node_modules/pkg/index.js',
            root,
            'node_modules/pkg/index.clone.js',
            source.fingerprint
          );
          const cloneRead = await native.readDependencyFile(
            root,
            'node_modules/pkg/index.clone.js'
          );
          expect(cloneRead.eligible).toBe(true);
          expect(native.sameDependencyFile(source.fingerprint, clone)).toBe(
            true
          );
          expect(cloneRead.fingerprint.attributes).toEqual(
            source.fingerprint.attributes
          );
          expect(cloneRead.fingerprint.metadataHash).toBe(
            source.fingerprint.metadataHash
          );
          expect(cloneRead.fingerprint.inode).not.toBe(
            source.fingerprint.inode
          );
          writeFileSync(join(packageDir, 'index.clone.js'), 'changed clone\n');
          expect(readFileSync(join(packageDir, 'index.js'), 'utf8')).toBe(
            'module.exports = 11;\n'
          );

          symlinkSync(packageDir, join(root, 'node_modules', 'alias'));
          const throughSymlink = await native.readDependencyFile(
            root,
            'node_modules/alias/index.js'
          );
          expect(throughSymlink.eligible).toBe(false);

          linkSync(
            join(packageDir, 'index.js'),
            join(packageDir, 'second-name.js')
          );
          const hardlinked = await native.readDependencyFile(
            root,
            'node_modules/pkg/index.js'
          );
          expect(hardlinked.eligible).toBe(false);
        });
      } finally {
        await native.close();
        rmSync(root, { force: true, recursive: true });
      }
    }
  );

  if (missingModules.length > 0) {
    test.skip(`G4 adversarial operation cases pending sibling modules: ${missingModules.filter((path) => path !== './dependency-file-native.js').join(', ')}`, () =>
      undefined);
  } else {
    const [
      ,
      { dependencyFileInputs },
      { openDependencyFileStore },
      { createDependencyFileJournal },
      { createDependencyFileSharing },
    ] = await Promise.all([
      Promise.resolve(nativeModule),
      import('./dependency-file-inputs.js'),
      import('./dependency-file-store.js'),
      import('./dependency-file-journal.js'),
      import('./dependency-file-sharing.js'),
    ]);

    test('store identity matches the frozen central-root and hoisted namespace shape', async () => {
      const f = makeCheckoutFixture('setu-dependency-store-identity');
      try {
        const store = await openDependencyFileStore(f.sharing, {
          native: makeFixtureNative(),
        });
        expect(store.identity).toEqual({
          device: String(statSync(f.storeRoot).dev),
          executable: realpathSync(PINNED_BUN),
          mountPath: f.root,
          namespace: 'hoisted/darwin-arm64-bun-1.3.14',
          root: f.storeRoot,
          version: '1.3.14',
        });
      } finally {
        f.dispose();
      }
    });

    test('fresh setup enrolls through current factories, records a ready receipt, and preserves readiness after release', async () => {
      const f = makeCheckoutFixture('setu-dependency-r2-receipt');
      try {
        for (const path of [
          join(f.checkout, 'node_modules'),
          join(f.checkout, 'packages', 'core', 'node_modules'),
        ]) {
          rmSync(path, { force: true, recursive: true });
        }
        const progress = createSetupProgress({
          newAttemptId: randomUUID,
          state: f.state,
        });
        const setupTarget = { name: 'topic', repo: 'repo' };
        const logLocation = join(f.root, 'setup.log');
        const native = {
          ...makeFixtureNative(),
          dependencyFileNativeStatus: () =>
            Promise.resolve({ available: true }),
          exchangeDependencyFiles: (root, targetPath, temporaryPath) => {
            // Labeled OS seam: JavaScript sibling renames exercise G4 recovery
            // orchestration but do not establish Darwin RENAME_SWAP acceptance.
            return testOnlyExchange(root, targetPath, temporaryPath);
          },
        };
        const serviceTarget = {
          checkoutIdentity: await inspectCheckoutIdentity(
            { repoDir: f.repoDir, wtDir: f.checkout },
            checkoutFs
          ),
          key: 'repo/topic',
          name: 'topic',
          repo: 'repo',
          repoDir: f.repoDir,
          wtDir: f.checkout,
        };
        let engine;
        let journal;
        const service = createDependencyFileService({
          assertMutable: () => ({ ok: true }),
          config: () => ({
            dependencySharing: {
              enabled: true,
              executable: PINNED_BUN,
              storeIdentity: f.sharing.storeIdentity,
              storeRoot: f.storeRoot,
              targets: { 'repo/topic': true },
              version: '1.3.14',
            },
            workspace: f.workspace,
          }),
          engineFactory: async ({ native: serviceNative, sharing }) => {
            const store = await openDependencyFileStore(sharing, {
              native: serviceNative,
            });
            journal = createDependencyFileJournal({
              state: f.state,
              storeRoot: store.identity.root,
            });
            engine = createDependencyFileSharing({
              assertMutable: () => undefined,
              inputs: dependencyFileInputs,
              journal,
              native: serviceNative,
              sharing,
              state: f.state,
              store,
            });
            return engine;
          },
          native,
          resolveTarget: async () => serviceTarget,
          setupProgress: progress,
          state: f.state,
        });
        let installCount = 0;
        const setupOptions = {
          admissionOperationId: 'setup-admission-g8',
          assertStorage: () => Promise.resolve(),
          assertStoreStorage: () => Promise.resolve(),
          checkoutIdentity: serviceTarget.checkoutIdentity,
          exists: existsSync,
          finalizeHoistedDependencySharing: (target, setupContext) =>
            service.enrollFresh(target, setupContext),
          logLocation,
          prepareHoistedDependencySharing: async (target) => {
            const status = await service.status({
              ...serviceTarget,
              ...target,
            });
            return status.native?.available ? { ok: true } : status;
          },
          progress,
          run: () => {
            installCount += 1;
            mkdirSync(join(f.checkout, 'node_modules', 'pkg-a'), {
              recursive: true,
            });
            mkdirSync(
              join(f.checkout, 'packages', 'core', 'node_modules', 'pkg-b'),
              { recursive: true }
            );
            writeFileSync(
              join(f.checkout, 'node_modules', 'pkg-a', 'index.js'),
              'module.exports = 17;\\n'
            );
            writeFileSync(
              join(
                f.checkout,
                'packages',
                'core',
                'node_modules',
                'pkg-b',
                'index.js'
              ),
              'module.exports = 29;\\n'
            );
            for (const relativePath of [
              'node_modules/pkg-a/index.js',
              'packages/core/node_modules/pkg-b/index.js',
            ]) {
              utimesSync(
                join(f.checkout, relativePath),
                1_700_000_000,
                1_700_000_000
              );
            }
            return { status: 0 };
          },
          sharing: f.sharing,
          state: f.state,
          target: setupTarget,
        };
        const preflightStatus = await service.status(serviceTarget);
        expect(
          preflightStatus.ok,
          `real G6/G4 enrollment preflight: ${preflightStatus.code ?? preflightStatus.state ?? 'no result code'}`
        ).toBe(true);
        const installed = await installWorktreeDependencies(
          f.checkout,
          setupOptions
        );
        expect(installed, 'fresh fixture install completes once').toEqual({
          installed: true,
        });
        expect(installCount, 'fixture installer is invoked exactly once').toBe(
          1
        );
        const record = progress.get(setupTarget);
        expect(
          record?.dependencyReceipt,
          'completed setup persists dependency receipt'
        ).toMatchObject({
          dependencyFiles: { state: 'completed' },
          outcome: 'completed',
        });
        const ready = await inspectDependencyReadiness({
          bunVersion: f.sharing.version,
          checkoutIdentity: serviceTarget.checkoutIdentity,
          dependencyFiles: record?.dependencyReceipt?.dependencyFiles,
          record,
          state: f.state,
          wtDir: f.checkout,
        });
        const status = await service.status(serviceTarget);
        expect(
          status.ok,
          `G6 service status: ${status.code ?? status.state ?? 'no result code'}`
        ).toBe(true);
        const completedOperation = await journal.getOperation(
          status.operations[0].id
        );
        expect(
          completedOperation.state,
          'enrollment completed before setup readiness'
        ).toBe('completed');
        const review = await engine.prepareRelease(serviceTarget, {
          operationId: completedOperation.id,
        });
        expect(
          review.ok,
          'release review is available for the enrolled originals'
        ).toBe(true);
        const released = await engine.release(serviceTarget, {
          confirmation: review.releaseId,
          releaseId: review.releaseId,
        });
        expect(
          released.ok,
          'separately reviewed original release completes'
        ).toBe(true);
        const releasedStatus = await service.status(serviceTarget);
        const releasedSummary = releasedStatus.views.find(
          (summary) => summary.repo === 'repo' && summary.name === 'topic'
        );
        const afterRelease = await inspectDependencyReadiness({
          bunVersion: f.sharing.version,
          checkoutIdentity: serviceTarget.checkoutIdentity,
          dependencyFiles: releasedSummary,
          record,
          state: f.state,
          wtDir: f.checkout,
        });
        expect(
          ready,
          `receipt readiness before release: ${ready.code ?? ready.state ?? 'no result code'}; journal views ${JSON.stringify(status.views)}; receipt ${JSON.stringify(record.dependencyReceipt.dependencyFiles)}`
        ).toMatchObject({ ok: true, state: 'ready' });
        expect(
          afterRelease,
          'release preserves the installed-view receipt'
        ).toMatchObject({ ok: true, state: 'ready' });
      } finally {
        f.dispose();
      }
    });

    test('unknown real-service enrollment cannot rerun the fixture installer', async () => {
      const f = makeCheckoutFixture('setu-dependency-unknown-enrollment');
      try {
        for (const path of [
          join(f.checkout, 'node_modules'),
          join(f.checkout, 'packages', 'core', 'node_modules'),
        ]) {
          rmSync(path, { force: true, recursive: true });
        }
        const progress = createSetupProgress({
          newAttemptId: randomUUID,
          state: f.state,
        });
        const setupTarget = { name: 'topic', repo: 'repo' };
        const serviceTarget = {
          checkoutIdentity: await inspectCheckoutIdentity(
            { repoDir: f.repoDir, wtDir: f.checkout },
            checkoutFs
          ),
          key: 'repo/topic',
          name: 'topic',
          repo: 'repo',
          repoDir: f.repoDir,
          wtDir: f.checkout,
        };
        const fixtureNative = makeFixtureNative();
        const native = {
          ...fixtureNative,
          cloneDependencyFile: () => {
            // Labeled OS copy seam: fail the real G2 store clone after setup's
            // installer settles, exercising its durable unknown recovery path.
            throw Object.assign(new Error('injected fixture clone refusal'), {
              code: 'TEST_COPY_REFUSED',
            });
          },
          dependencyFileNativeStatus: () =>
            Promise.resolve({ available: true }),
          exchangeDependencyFiles: (root, targetPath, temporaryPath) =>
            testOnlyExchange(root, targetPath, temporaryPath),
        };
        let journal;
        const service = createDependencyFileService({
          assertMutable: () => ({ ok: true }),
          config: () => ({
            dependencySharing: {
              enabled: true,
              executable: PINNED_BUN,
              storeIdentity: f.sharing.storeIdentity,
              storeRoot: f.storeRoot,
              targets: { 'repo/topic': true },
              version: '1.3.14',
            },
            workspace: f.workspace,
          }),
          engineFactory: async ({ native: serviceNative, sharing }) => {
            const store = await openDependencyFileStore(sharing, {
              native: serviceNative,
            });
            journal = createDependencyFileJournal({
              state: f.state,
              storeRoot: store.identity.root,
            });
            return createDependencyFileSharing({
              assertMutable: () => undefined,
              inputs: dependencyFileInputs,
              journal,
              native: serviceNative,
              sharing,
              state: f.state,
              store,
            });
          },
          native,
          resolveTarget: async () => serviceTarget,
          setupProgress: progress,
          state: f.state,
        });
        let installCount = 0;
        const setupOptions = {
          admissionOperationId: 'setup-admission-g8-unknown',
          assertStorage: () => Promise.resolve(),
          assertStoreStorage: () => Promise.resolve(),
          checkoutIdentity: serviceTarget.checkoutIdentity,
          exists: existsSync,
          finalizeHoistedDependencySharing: (target, setupContext) =>
            service.enrollFresh(target, setupContext),
          logLocation: join(f.root, 'setup.log'),
          prepareHoistedDependencySharing: async () => ({ ok: true }),
          progress,
          run: () => {
            installCount += 1;
            mkdirSync(join(f.checkout, 'node_modules', 'pkg-a'), {
              recursive: true,
            });
            writeFileSync(
              join(f.checkout, 'node_modules', 'pkg-a', 'index.js'),
              'module.exports = 17;\\n'
            );
            utimesSync(
              join(f.checkout, 'node_modules', 'pkg-a', 'index.js'),
              1_700_000_000,
              1_700_000_000
            );
            return { status: 0 };
          },
          sharing: f.sharing,
          state: f.state,
          target: setupTarget,
        };
        const preflightStatus = await service.status(serviceTarget);
        expect(
          preflightStatus.ok,
          `unknown enrollment preflight: ${preflightStatus.code ?? 'no result code'}`
        ).toBe(true);
        await expect(
          installWorktreeDependencies(f.checkout, setupOptions)
        ).rejects.toMatchObject({ code: 'OPERATION_UNKNOWN' });
        expect(installCount, 'first fixture install settles once').toBe(1);
        expect(progress.get(setupTarget)?.state).toBe('unknown');
        const operations = await journal.list();
        expect(operations.operations[0]).toMatchObject({
          code: 'DEPENDENCY_STORE_STAGE_FAILED',
          state: 'unknown',
        });
        await expect(
          installWorktreeDependencies(f.checkout, setupOptions)
        ).rejects.toMatchObject({
          code: 'DEPENDENCY_ENROLLMENT_RECONCILIATION_REQUIRED',
        });
        expect(
          installCount,
          'unknown enrollment recovery never reruns lifecycle scripts'
        ).toBe(1);
      } finally {
        f.dispose();
      }
    });

    test('status reads summaries without rehashing installed files and unavailable native swap refuses apply', async () => {
      const f = makeCheckoutFixture('setu-dependency-native-unavailable');
      try {
        f.modules = {
          createDependencyFileJournal,
          createDependencyFileSharing,
          dependencyFileInputs,
          openDependencyFileStore,
        };
        const runtime = await makeEngine(
          f,
          {},
          {
            nativeStatus: {
              available: false,
              code: 'NATIVE_HELPER_UNAVAILABLE',
              reason: 'The reviewed helper has not been built',
            },
          }
        );
        const readsBeforeStatus = runtime.counters.reads;
        const status = await runtime.engine.status(runtime.target);
        expect(
          status.ok,
          `status scenario: ${status.code ?? status.state ?? 'no result code'}`
        ).toBe(true);
        expect(runtime.counters.reads).toBe(readsBeforeStatus);
        const prepared = await runtime.engine.prepare(runtime.target);
        expect(
          prepared,
          `missing-native prepare scenario: ${prepared.code ?? 'no result code'}`
        ).toMatchObject({
          code: 'DEPENDENCY_FILE_NATIVE_UNAVAILABLE',
          ok: false,
        });
        expect(await runtime.journal.list()).toEqual({
          operations: [],
          views: [],
        });

        const originalPath = join(
          f.checkout,
          'node_modules',
          'pkg-a',
          'index.js'
        );
        const before = statSync(originalPath, { bigint: true });
        const originalText = readFileSync(originalPath, 'utf8');
        const result = await runtime.engine.apply(runtime.target, {
          confirmation: 'a'.repeat(64),
          operationId: 'a'.repeat(64),
          planId: 'a'.repeat(64),
        });
        expect(result.ok).toBe(false);
        expect(result.code).toBeDefined();
        expect(result.error).toBeTruthy();
        expect(readFileSync(originalPath, 'utf8')).toBe(originalText);
        expect(statSync(originalPath, { bigint: true }).ino).toBe(before.ino);
        expect(runtime.counters.exchanges).toBe(0);
      } finally {
        f.dispose();
      }
    });

    test('stage failure resumes the same operation without changing the original entry', async () => {
      const f = makeCheckoutFixture('setu-dependency-stage-resume');
      try {
        f.modules = {
          createDependencyFileJournal,
          createDependencyFileSharing,
          dependencyFileInputs,
          openDependencyFileStore,
        };
        let failCheckoutStage = true;
        const fixtureNative = makeFixtureNative();
        const native = {
          ...fixtureNative,
          cloneDependencyFile: (...args) => {
            if (failCheckoutStage && args[2] === f.checkout) {
              failCheckoutStage = false;
              throw Object.assign(new Error('injected stage interruption'), {
                code: 'TEST_STAGE_INTERRUPTED',
              });
            }
            return fixtureNative.cloneDependencyFile(...args);
          },
        };
        const runtime = await makeEngine(f, native);
        const plan = await prepare(runtime);
        const file = join(f.checkout, 'node_modules', 'pkg-a', 'index.js');
        const before = statSync(file, { bigint: true });
        const original = readFileSync(file, 'utf8');
        const interrupted = await runtime.engine.apply(runtime.target, {
          confirmation: plan.id,
          operationId: plan.id,
          planId: plan.id,
        });
        expect(interrupted.ok).toBe(false);
        expect(interrupted.code).toBeTruthy();
        expect(readFileSync(file, 'utf8')).toBe(original);
        expect(statSync(file, { bigint: true }).ino).toBe(before.ino);
        expect((await runtime.journal.getOperation(plan.id)).state).not.toBe(
          'completed'
        );

        await runtime.engine.recover(runtime.target, {
          operationId: plan.id,
        });
        const resumed = await runtime.engine.apply(runtime.target, {
          confirmation: plan.id,
          operationId: plan.id,
          planId: plan.id,
        });
        expect(resumed.ok).toBe(true);
        expect((await runtime.journal.getOperation(plan.id)).state).toBe(
          'completed'
        );
      } finally {
        f.dispose();
      }
    });

    test('prepare retries an ambiguous journal save as the same deterministic plan without touching installed files', async () => {
      const f = makeCheckoutFixture('setu-dependency-prepare-resume');
      try {
        f.modules = {
          createDependencyFileJournal,
          createDependencyFileSharing,
          dependencyFileInputs,
          openDependencyFileStore,
        };
        const runtime = await makeEngine(f);
        const installed = join(f.checkout, 'node_modules', 'pkg-a', 'index.js');
        const before = statSync(installed, { bigint: true });
        const original = readFileSync(installed, 'utf8');
        const savePlan = runtime.journal.savePlan.bind(runtime.journal);
        let loseResponse = true;
        runtime.journal.savePlan = async (plan) => {
          const saved = await savePlan(plan);
          if (loseResponse) {
            loseResponse = false;
            throw Object.assign(new Error('injected lost plan response'), {
              code: 'TEST_PLAN_WRITE_UNKNOWN',
            });
          }
          return saved;
        };

        const first = await runtime.engine.prepare(runtime.target);
        expect(first.ok).toBe(false);
        expect(first.code).toBeTruthy();
        runtime.journal.savePlan = savePlan;
        const second = await runtime.engine.prepare(runtime.target);
        expect(
          second.ok,
          `ambiguous save retry scenario: ${second.code ?? 'no result code'}`
        ).toBe(true);
        expect(second.plan.id).toMatch(DIGEST_RE);
        expect(await runtime.journal.getPlan(second.plan.id)).toEqual(
          second.plan
        );
        expect(readFileSync(installed, 'utf8')).toBe(original);
        expect(statSync(installed, { bigint: true }).ino).toBe(before.ino);
      } finally {
        f.dispose();
      }
    });

    test('stale input, checkout identity, store identity, and confirmation each refuse before a checkout swap', async () => {
      for (const scenario of ['confirmation', 'input', 'checkout', 'store']) {
        const f = makeCheckoutFixture(`setu-dependency-stale-${scenario}`);
        try {
          f.modules = {
            createDependencyFileJournal,
            createDependencyFileSharing,
            dependencyFileInputs,
            openDependencyFileStore,
          };
          // biome-ignore lint/performance/noAwaitInLoops: Each stale-input case needs its own real target and store.
          const runtime = await makeEngine(f);
          const plan = await prepare(runtime);
          const installed = join(
            f.checkout,
            'node_modules',
            'pkg-a',
            'index.js'
          );
          const before = statSync(installed, { bigint: true });
          const original = readFileSync(installed, 'utf8');
          let { target } = runtime;
          let confirmation = plan.id;
          if (scenario === 'confirmation') {
            confirmation = '0'.repeat(64);
          } else if (scenario === 'input') {
            writeFileSync(join(f.checkout, 'bun.lock'), '{"changed":true}\n');
          } else if (scenario === 'checkout') {
            target = {
              ...runtime.target,
              checkoutIdentity: {
                ...runtime.target.checkoutIdentity,
                checkout: {
                  ...runtime.target.checkoutIdentity.checkout,
                  ino: '1',
                },
                checkoutPath: `${runtime.target.checkoutIdentity.checkoutPath}-replacement`,
              },
            };
          } else {
            f.sharing.storeRoot = join(f.root, 'replacement-store');
            mkdirSync(f.sharing.storeRoot, { mode: 0o700 });
          }
          const result = await runtime.engine.apply(target, {
            confirmation,
            operationId: plan.id,
            planId: plan.id,
          });
          expect(
            result.ok,
            `${scenario} stale-target scenario: ${result.code ?? 'unexpected success'}`
          ).toBe(false);
          expect(
            result.code,
            `${scenario} stale-target result code`
          ).toBeTruthy();
          expect(runtime.counters.exchanges).toBe(0);
          expect(readFileSync(installed, 'utf8')).toBe(original);
          expect(statSync(installed, { bigint: true }).ino).toBe(before.ino);
        } finally {
          f.dispose();
        }
      }
    });

    test('target guard refusals for runtime, writer claim, and unknown observations cause no filesystem mutation', async () => {
      for (const code of [
        'RUNTIME_ACTIVE',
        'WRITER_CLAIMED',
        'TARGET_OBSERVATION_UNKNOWN',
      ]) {
        const f = makeCheckoutFixture(`setu-dependency-guard-${code}`);
        try {
          f.modules = {
            createDependencyFileJournal,
            createDependencyFileSharing,
            dependencyFileInputs,
            openDependencyFileStore,
          };
          // biome-ignore lint/performance/noAwaitInLoops: Each refused guard case has an isolated real target.
          const runtime = await makeEngine(f);
          const plan = await prepare(runtime);
          runtime.setMutableError(
            Object.assign(new Error(`/private/path/${code}`), { code })
          );
          const installed = join(
            f.checkout,
            'node_modules',
            'pkg-a',
            'index.js'
          );
          const before = statSync(installed, { bigint: true });
          const original = readFileSync(installed, 'utf8');
          const result = await runtime.engine.apply(runtime.target, {
            confirmation: plan.id,
            operationId: plan.id,
            planId: plan.id,
          });
          expect(result.ok).toBe(false);
          expect(result.code).toBe(code);
          expect(runtime.counters.exchanges).toBe(0);
          expect(readFileSync(installed, 'utf8')).toBe(original);
          expect(statSync(installed, { bigint: true }).ino).toBe(before.ino);
          expect(JSON.stringify(result)).not.toContain('/private/path/');
        } finally {
          f.dispose();
        }
      }
    });

    test('an interrupted exchange before its atomic effect retains the original and resumes only with the same operation id', async () => {
      const f = makeCheckoutFixture('setu-dependency-exchange-resume');
      try {
        f.modules = {
          createDependencyFileJournal,
          createDependencyFileSharing,
          dependencyFileInputs,
          openDependencyFileStore,
        };
        const runtime = await makeEngine(f);
        const plan = await prepare(runtime);
        let interrupt = true;
        runtime.setExchangeHook((root, targetRelative, stagedRelative) => {
          if (interrupt) {
            interrupt = false;
            throw Object.assign(new Error('injected exchange interruption'), {
              code: 'TEST_EXCHANGE_INTERRUPTED',
            });
          }
          return testOnlyExchange(root, targetRelative, stagedRelative);
        });
        const installed = join(f.checkout, 'node_modules', 'pkg-a', 'index.js');
        const original = readFileSync(installed, 'utf8');
        const originalInode = statSync(installed, { bigint: true }).ino;
        const first = await runtime.engine.apply(runtime.target, {
          confirmation: plan.id,
          operationId: plan.id,
          planId: plan.id,
        });
        expect(
          first.ok,
          `pre-effect exchange interruption: ${first.code ?? 'unexpected success'}`
        ).toBe(false);
        expect(
          first.code,
          'pre-effect exchange interruption result code'
        ).toBeTruthy();
        expect(readFileSync(installed, 'utf8')).toBe(original);
        expect(statSync(installed, { bigint: true }).ino).toBe(originalInode);
        expect(runtime.counters.exchanges).toBe(1);

        await runtime.engine.recover(runtime.target, {
          operationId: plan.id,
        });
        const resumed = await runtime.engine.apply(runtime.target, {
          confirmation: plan.id,
          operationId: plan.id,
          planId: plan.id,
        });
        expect(
          resumed.ok,
          `same-operation exchange resume: ${resumed.code ?? 'no result code'}`
        ).toBe(true);
        expect(runtime.counters.exchanges).toBe(plan.files.length + 1);
        const checkpoints = await runtime.journal.checkpoints(plan.id);
        const originalBackup = checkpoints.find((entry) =>
          entry.relativePath.endsWith('pkg-a/index.js')
        );
        expect(
          statSync(join(f.checkout, originalBackup.temporaryRelativePath), {
            bigint: true,
          }).ino,
          'exchange retains the exact original inode for separate release'
        ).toBe(originalInode);
        expect((await runtime.journal.getOperation(plan.id)).state).toBe(
          'completed'
        );
      } finally {
        f.dispose();
      }
    });

    test('corrupt store objects and malformed workspace journal summaries refuse closed without replacing the checkout', async () => {
      const f = makeCheckoutFixture('setu-dependency-corrupt-state');
      try {
        f.modules = {
          createDependencyFileJournal,
          createDependencyFileSharing,
          dependencyFileInputs,
          openDependencyFileStore,
        };
        const runtime = await makeEngine(f);
        const plan = await prepare(runtime);
        await runtime.journal.begin(plan);
        await expect(
          runtime.journal.checkpoint(plan.id, 0, {
            originalFingerprint: plan.files[0].fingerprint,
            phase: 'prepared',
            retainedFingerprint: null,
            stagedFingerprint: null,
            temporaryRelativePath: '../outside-checkout',
          })
        ).rejects.toBeDefined();
        expect(await runtime.journal.checkpoints(plan.id)).toEqual([]);
        const entry = plan.files.find((file) =>
          file.relativePath.endsWith('pkg-a/index.js')
        );
        const stored = await runtime.store.ensure(
          entry.fingerprint,
          f.checkout
        );
        const objectPath = resolve(runtime.store.root, stored.relativePath);
        expect(objectPath.startsWith(`${resolve(runtime.store.root)}/`)).toBe(
          true
        );
        writeFileSync(objectPath, 'forged object bytes\n');
        const installed = join(f.checkout, 'node_modules', 'pkg-a', 'index.js');
        const original = readFileSync(installed, 'utf8');
        const objectResult = await runtime.engine.apply(runtime.target, {
          confirmation: plan.id,
          operationId: plan.id,
          planId: plan.id,
        });
        expect(objectResult.ok).toBe(false);
        expect(objectResult.code).toBeTruthy();
        expect(runtime.counters.exchanges).toBe(0);
        expect(readFileSync(installed, 'utf8')).toBe(original);

        writeFileSync(
          join(f.workspace, '.setu-dependency-files.json'),
          '{"version":1,"operations":[],"views":{}}\n'
        );
        const status = await runtime.engine.status(runtime.target);
        expect(status.ok).toBe(false);
        expect(status.code).toBeTruthy();
        expect(readFileSync(installed, 'utf8')).toBe(original);
        expect(runtime.counters.exchanges).toBe(0);
      } finally {
        f.dispose();
      }
    });

    test('release refuses a changed retained original and keeps the replacement and installed target', async () => {
      const f = makeCheckoutFixture('setu-dependency-release-drift');
      try {
        f.modules = {
          createDependencyFileJournal,
          createDependencyFileSharing,
          dependencyFileInputs,
          openDependencyFileStore,
        };
        const runtime = await makeEngine(f);
        const plan = await prepare(runtime);
        const applied = await runtime.engine.apply(runtime.target, {
          confirmation: plan.id,
          operationId: plan.id,
          planId: plan.id,
        });
        expect(applied.ok).toBe(true);
        const review = await runtime.engine.prepareRelease(runtime.target, {
          operationId: plan.id,
        });
        expect(review.ok).toBe(true);
        const checkpoints = await runtime.journal.checkpoints(plan.id);
        const retained = checkpoints.find((entry) =>
          entry.relativePath.endsWith('pkg-a/index.js')
        );
        const retainedPath = join(f.checkout, retained.temporaryRelativePath);
        writeFileSync(retainedPath, 'changed after release review\n');
        const installed = join(f.checkout, retained.relativePath);
        const installedBefore = readFileSync(installed, 'utf8');
        const result = await runtime.engine.release(runtime.target, {
          confirmation: review.releaseId,
          releaseId: review.releaseId,
        });
        expect(result.ok).toBe(false);
        expect(result.code).toBeTruthy();
        expect(existsSync(retainedPath)).toBe(true);
        expect(readFileSync(retainedPath, 'utf8')).toBe(
          'changed after release review\n'
        );
        expect(readFileSync(installed, 'utf8')).toBe(installedBefore);
      } finally {
        f.dispose();
      }
    });

    test('a lost post-exchange checkpoint is reconciled without swapping a second time, then originals release only after a separate review', async () => {
      const f = makeCheckoutFixture('setu-dependency-checkpoint-recovery');
      try {
        f.modules = {
          createDependencyFileJournal,
          createDependencyFileSharing,
          dependencyFileInputs,
          openDependencyFileStore,
        };
        const runtime = await makeEngine(f);
        const plan = await prepare(runtime);
        const originalCheckpoint = runtime.journal.checkpoint.bind(
          runtime.journal
        );
        let loseSwappedCheckpoint = true;
        runtime.journal.checkpoint = (operationId, index, record) => {
          if (loseSwappedCheckpoint && record?.phase === 'swapped') {
            loseSwappedCheckpoint = false;
            throw Object.assign(new Error('injected lost checkpoint'), {
              code: 'TEST_CHECKPOINT_UNKNOWN',
            });
          }
          return originalCheckpoint(operationId, index, record);
        };
        const first = await runtime.engine.apply(runtime.target, {
          confirmation: plan.id,
          operationId: plan.id,
          planId: plan.id,
        });
        expect(
          first.ok,
          `lost post-exchange checkpoint: ${first.code ?? 'unexpected success'}`
        ).toBe(false);
        expect(
          first.code,
          'lost post-exchange checkpoint result code'
        ).toBeTruthy();
        expect(runtime.counters.exchanges).toBe(1);
        const checkpoints = await runtime.journal.checkpoints(plan.id);
        const backup = checkpoints.find((entry) =>
          entry.relativePath.endsWith('pkg-a/index.js')
        );
        expect(backup).toBeDefined();
        expect(existsSync(join(f.checkout, backup.temporaryRelativePath))).toBe(
          true
        );

        runtime.journal.checkpoint = originalCheckpoint;
        await runtime.engine.recover(runtime.target, {
          operationId: plan.id,
        });
        const resumed = await runtime.engine.apply(runtime.target, {
          confirmation: plan.id,
          operationId: plan.id,
          planId: plan.id,
        });
        expect(
          resumed.ok,
          `post-exchange reconciliation resume: ${resumed.code ?? 'no result code'}`
        ).toBe(true);
        expect(runtime.counters.exchanges).toBe(plan.files.length);
        expect((await runtime.journal.getOperation(plan.id)).state).toBe(
          'completed'
        );

        const releaseReview = await runtime.engine.prepareRelease(
          runtime.target,
          { operationId: plan.id }
        );
        expect(releaseReview.ok).toBe(true);
        expect(releaseReview.releaseId).toMatch(DIGEST_RE);
        const releasePlan = await runtime.journal.getReleasePlan(
          releaseReview.releaseId
        );
        expect(releasePlan.files).toHaveLength(plan.files.length);
        const unrelated = join(
          f.checkout,
          'node_modules',
          'pkg-a',
          'created-after-release-review.txt'
        );
        writeFileSync(unrelated, 'not part of the reviewed release\n');
        const released = await runtime.engine.release(runtime.target, {
          confirmation: releaseReview.releaseId,
          releaseId: releaseReview.releaseId,
        });
        expect(released.ok).toBe(true);
        expect(readFileSync(unrelated, 'utf8')).toBe(
          'not part of the reviewed release\n'
        );
        for (const checkpoint of checkpoints) {
          expect(
            existsSync(join(f.checkout, checkpoint.temporaryRelativePath))
          ).toBe(false);
        }
        expect(
          readFileSync(join(f.checkout, backup.relativePath), 'utf8')
        ).toBe('module.exports = 17;\n');
        expect((await runtime.journal.getOperation(plan.id)).state).toBe(
          'released'
        );
      } finally {
        f.dispose();
      }
    });

    test('a late writer displaced by the swap becomes a retained conflict, never an automatic overwrite-back', async () => {
      const f = makeCheckoutFixture('setu-dependency-late-writer');
      try {
        f.modules = {
          createDependencyFileJournal,
          createDependencyFileSharing,
          dependencyFileInputs,
          openDependencyFileStore,
        };
        const runtime = await makeEngine(f);
        const plan = await prepare(runtime);
        const targetFile = join(
          f.checkout,
          'node_modules',
          'pkg-a',
          'index.js'
        );
        runtime.setExchangeHook((root, targetRelative, stagedRelative) => {
          const lateText = 'module.exports = "late writer";\n';
          writeFileSync(join(root, targetRelative), lateText);
          testOnlyExchange(root, targetRelative, stagedRelative);
          return { exchanged: true, lateText };
        });
        const result = await runtime.engine.apply(runtime.target, {
          confirmation: plan.id,
          operationId: plan.id,
          planId: plan.id,
        });
        expect(
          result.ok,
          `late-writer exchange conflict: ${result.code ?? 'unexpected success'}`
        ).toBe(false);
        expect(result.code, 'late-writer must remain a conflict').toBe(
          'DEPENDENCY_FILE_CONFLICT'
        );
        const operation = await runtime.journal.getOperation(plan.id);
        expect(operation.state).toBe('conflict');
        const checkpoint = (await runtime.journal.checkpoints(plan.id)).find(
          (entry) => entry.relativePath.endsWith('pkg-a/index.js')
        );
        expect(existsSync(targetFile)).toBe(true);
        expect(
          existsSync(join(f.checkout, checkpoint.temporaryRelativePath))
        ).toBe(true);
        expect(
          readFileSync(
            join(f.checkout, checkpoint.temporaryRelativePath),
            'utf8'
          )
        ).toBe('module.exports = "late writer";\n');
        expect(readFileSync(targetFile, 'utf8')).toBe('module.exports = 17;\n');
      } finally {
        f.dispose();
      }
    });
  }
}
