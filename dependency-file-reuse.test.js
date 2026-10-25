import { expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
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
import { dependencyFileInputs } from './dependency-file-inputs.js';
import { createDependencyFileJournal } from './dependency-file-journal.js';
import { createDependencyFileNative } from './dependency-file-native.js';
import { createDependencyFileSharing } from './dependency-file-sharing.js';
import { openDependencyFileStore } from './dependency-file-store.js';
import { createWorkspaceState } from './workspace-state.js';

const PINNED_BUN = process.env.SETU_TEST_DEPENDENCY_BUN ?? process.execPath;
const FILE = 'node_modules/pkg-a/index.js';
const checkoutFs = { lstat, readFile, realpath, stat };

function makeFixture() {
  const root = realpathSync(
    mkdtempSync(join(tmpdir(), 'setu-dependency-reuse-'))
  );
  const workspace = join(root, 'workspace');
  const source = join(root, 'source');
  const repoDir = join(root, 'repo.git');
  const first = join(workspace, 'repo', 'topic-a');
  const second = join(workspace, 'repo', 'topic-b');
  const storeRoot = join(root, 'private-store');
  mkdirSync(workspace);
  mkdirSync(source);
  mkdirSync(join(workspace, 'repo'), { recursive: true });
  mkdirSync(join(storeRoot, 'hoisted', 'darwin-arm64-bun-1.3.14'), {
    mode: 0o700,
    recursive: true,
  });
  execFileSync('git', ['init', '--quiet', '--initial-branch=main', source]);
  writeFileSync(join(source, 'package.json'), '{"name":"reuse-fixture"}\n');
  writeFileSync(join(source, 'bun.lock'), '{"lockfileVersion":1}\n');
  writeFileSync(join(source, 'bunfig.toml'), '[install]\nlinker = "hoisted"\n');
  writeFileSync(join(source, '.gitignore'), 'node_modules/\n');
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
    'topic-a',
    first,
    'main',
  ]);
  execFileSync('git', [
    '--git-dir',
    repoDir,
    'worktree',
    'add',
    '--quiet',
    '-b',
    'topic-b',
    second,
    'main',
  ]);
  const sharing = {
    enabled: true,
    executable: PINNED_BUN,
    storeIdentity: { device: statSync(storeRoot).dev, mountPath: root },
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
    checkout(name, contents, seconds) {
      const checkout = name === 'topic-a' ? first : second;
      const path = join(checkout, FILE);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, contents, { mode: 0o644 });
      utimesSync(path, seconds, seconds);
      return checkout;
    },
    dispose: () => rmSync(root, { force: true, recursive: true }),
    first,
    repoDir,
    root,
    second,
    sharing,
    state,
    storeRoot,
    workspace,
  };
}

// Explicit test-only OS seam for the prebuilt native helper. Fingerprints use
// actual fixture descriptors; timestamps use the OS integer clock, and the
// atomic exchange is simulated. The real store, journal, and sharing factories run.
// This seam does not establish helper, lease, clonefile, or RENAME_SWAP support.
function makeFixtureNative({ failFirstExchange = false } = {}) {
  const helperPath = join(tmpdir(), 'setu-test-only-dependency-file-helper');
  let failExchange = failFirstExchange;
  const processRunner = (command, args) => {
    if (command !== helperPath) {
      if (command.endsWith('/xattr') || command === 'xattr') {
        return { stdout: '' };
      }
      return { stdout: execFileSync(command, args, { encoding: 'utf8' }) };
    }
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
          sparse: false,
          uid: Number(info.uid),
        }),
      };
    }
    if (action === 'restore-times') {
      const path = join(root, relativePath);
      setFixtureTimesNs(path, atimeNs, mtimeNs);
      const info = statSync(path, { bigint: true });
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
    throw new Error(`Unsupported test helper action: ${action}`);
  };
  const base = createDependencyFileNative({
    nativeBinary: helperPath,
    platformForTesting: 'darwin',
    processRunner,
  });
  return {
    ...base,
    exchangeDependencyFiles(root, targetPath, temporaryPath) {
      if (failExchange) {
        failExchange = false;
        throw Object.assign(new Error('injected pre-swap interruption'), {
          code: 'TEST_EXCHANGE_INTERRUPTED',
        });
      }
      // Labeled JS sibling-rename seam: recovery orchestration only.
      const target = resolve(root, targetPath);
      const temporary = resolve(root, temporaryPath);
      if (dirname(target) !== dirname(temporary)) {
        throw new Error('test exchange requires sibling entries');
      }
      const displaced = join(dirname(target), `.reuse-swap-${randomUUID()}`);
      renameSync(target, displaced);
      renameSync(temporary, target);
      renameSync(displaced, temporary);
      return { exchanged: true };
    },
  };
}

async function makeRuntime(f, native) {
  const store = await openDependencyFileStore(f.sharing, { native });
  const journal = createDependencyFileJournal({
    state: f.state,
    storeRoot: store.identity.root,
  });
  const engine = createDependencyFileSharing({
    assertMutable: () => undefined,
    inputs: dependencyFileInputs,
    journal,
    native,
    sharing: f.sharing,
    state: f.state,
    store,
  });
  async function target(checkout, name) {
    const checkoutIdentity = await inspectCheckoutIdentity(
      { repoDir: f.repoDir, wtDir: checkout },
      checkoutFs
    );
    expect(checkoutIdentity.known).toBe(true);
    return {
      checkoutIdentity,
      name,
      repo: 'repo',
      repoDir: f.repoDir,
      wtDir: checkout,
    };
  }
  return { engine, journal, native, store, target };
}

const nativeOptIn = process.env.SETU_DEPENDENCY_FILE_NATIVE_REUSE === '1';

test('fixture timestamp restoration preserves integer nanoseconds and refuses symlinks', () => {
  const root = mkdtempSync(join(tmpdir(), 'setu-fixture-clock-'));
  try {
    const path = join(root, 'entry.js');
    writeFileSync(path, 'fixture');
    const atime = '1710000000123456789';
    const mtime = '1720000000987654321';
    setFixtureTimesNs(path, atime, mtime);
    const before = statSync(path, { bigint: true });
    expect(String(before.atimeNs)).toBe(atime);
    expect(String(before.mtimeNs)).toBe(mtime);
    const link = join(root, 'link.js');
    symlinkSync(path, link);
    expect(() => setFixtureTimesNs(link, '1', '2')).toThrow();
    const after = statSync(path, { bigint: true });
    expect(after.atimeNs).toBe(before.atimeNs);
    expect(after.mtimeNs).toBe(before.mtimeNs);
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test('independent installs reuse one canonical object while retaining target times and operation identity', async () => {
  const f = makeFixture();
  const native = makeFixtureNative({ failFirstExchange: true });
  try {
    const sourceA = f.checkout(
      'topic-a',
      'module.exports = 17;\n',
      1_700_000_000
    );
    const sourceB = f.checkout(
      'topic-b',
      'module.exports = 17;\n',
      1_710_000_000
    );
    const beforeA = statSync(join(sourceA, FILE), { bigint: true });
    const beforeB = statSync(join(sourceB, FILE), { bigint: true });
    expect(beforeA.mtimeNs).not.toBe(beforeB.mtimeNs);
    const runtime = await makeRuntime(f, native);
    const targetA = await runtime.target(sourceA, 'topic-a');
    const targetB = await runtime.target(sourceB, 'topic-b');

    const preparedA = await runtime.engine.prepare(targetA);
    expect(preparedA.ok, `first prepare: ${preparedA.code ?? ''}`).toBe(true);
    const planA = preparedA.plan;
    const fileA = planA.files.find((file) => file.relativePath === FILE);
    expect(fileA).toBeDefined();

    const firstApply = await runtime.engine.apply(targetA, {
      confirmation: planA.id,
      operationId: planA.id,
      planId: planA.id,
    });
    expect(firstApply.ok).toBe(false);
    expect(firstApply.operationId ?? firstApply.id).toBe(planA.id);
    expect(readFileSync(join(sourceA, FILE), 'utf8')).toBe(
      'module.exports = 17;\n'
    );
    const recovered = await runtime.engine.recover(targetA, {
      operationId: planA.id,
    });
    expect(recovered.ok, `same-ID recovery: ${recovered.code ?? ''}`).toBe(
      true
    );
    const resumed = await runtime.engine.apply(targetA, {
      confirmation: planA.id,
      operationId: planA.id,
      planId: planA.id,
    });
    expect(resumed.ok, `same-ID apply: ${resumed.code ?? ''}`).toBe(true);
    const objectPath = join(
      runtime.store.root,
      'objects',
      fileA.objectKey.slice(0, 2),
      fileA.objectKey
    );
    const canonicalA = statSync(objectPath, { bigint: true });
    const installedA = statSync(join(sourceA, FILE), { bigint: true });
    expect(installedA.ino).not.toBe(canonicalA.ino);
    expect(installedA.mtimeNs).toBe(beforeA.mtimeNs);

    const releaseA = await runtime.engine.prepareRelease(targetA, {
      operationId: planA.id,
    });
    expect(releaseA.ok, `first release review: ${releaseA.code ?? ''}`).toBe(
      true
    );
    const releasedA = await runtime.engine.release(targetA, {
      confirmation: releaseA.releaseId,
      releaseId: releaseA.releaseId,
    });
    expect(releasedA.ok, `first release: ${releasedA.code ?? ''}`).toBe(true);

    const preparedB = await runtime.engine.prepare(targetB);
    expect(preparedB.ok, `second prepare: ${preparedB.code ?? ''}`).toBe(true);
    const planB = preparedB.plan;
    const fileB = planB.files.find((file) => file.relativePath === FILE);
    expect(fileB).toBeDefined();
    expect(fileB.objectKey).toBe(fileA.objectKey);
    expect(fileB.fingerprint.mtimeNs).not.toBe(fileA.fingerprint.mtimeNs);
    const appliedB = await runtime.engine.apply(targetB, {
      confirmation: planB.id,
      operationId: planB.id,
      planId: planB.id,
    });
    expect(appliedB.ok, `second apply: ${appliedB.code ?? ''}`).toBe(true);
    const canonicalB = statSync(objectPath, { bigint: true });
    const installedB = statSync(join(sourceB, FILE), { bigint: true });
    expect(canonicalB.ino).toBe(canonicalA.ino);
    expect(canonicalB.mtimeNs).toBe(canonicalA.mtimeNs);
    expect(installedB.ino).not.toBe(canonicalB.ino);
    expect(installedB.mtimeNs).toBe(beforeB.mtimeNs);

    const releaseB = await runtime.engine.prepareRelease(targetB, {
      operationId: planB.id,
    });
    expect(releaseB.ok, `second release review: ${releaseB.code ?? ''}`).toBe(
      true
    );
    const releasedB = await runtime.engine.release(targetB, {
      confirmation: releaseB.releaseId,
      releaseId: releaseB.releaseId,
    });
    expect(releasedB.ok, `second release: ${releasedB.code ?? ''}`).toBe(true);

    writeFileSync(join(sourceA, FILE), 'module.exports = 99;\n');
    expect(readFileSync(join(sourceB, FILE), 'utf8')).toBe(
      'module.exports = 17;\n'
    );
    expect(readFileSync(objectPath, 'utf8')).toBe('module.exports = 17;\n');
    expect(statSync(objectPath, { bigint: true }).ino).toBe(canonicalA.ino);
  } finally {
    f.dispose();
  }
});

test('legacy version 1 object keys still address strict timestamp-bound objects', async () => {
  const f = makeFixture();
  const native = makeFixtureNative();
  try {
    const checkout = f.checkout(
      'topic-a',
      'module.exports = 31;\n',
      1_720_000_000
    );
    const runtime = await makeRuntime(f, native);
    const read = await native.readDependencyFile(checkout, FILE);
    expect(read.eligible).toBe(true);
    const { fingerprint } = read;
    const legacyKey = createHash('sha256')
      .update(fingerprint.contentHash)
      .update(fingerprint.metadataHash)
      .digest('hex');
    expect(runtime.store.objectKey(fingerprint, 1)).toBe(legacyKey);
    const ensured = await runtime.store.ensure(fingerprint, checkout, {
      version: 1,
    });
    expect(ensured.key).toBe(legacyKey);
    expect(await runtime.store.verify(legacyKey, fingerprint)).toBe(true);
    const staged = await runtime.store.stage(
      legacyKey,
      checkout,
      'node_modules/.legacy-stage.js',
      fingerprint
    );
    expect(staged.mtimeNs).toBe(fingerprint.mtimeNs);
    expect(staged.inode).not.toBe(ensured.fingerprint.inode);
  } finally {
    f.dispose();
  }
});

test.skipIf(!nativeOptIn)(
  'prebuilt native helper also reuses objects across distinct install mtimes',
  async () => {
    const helper = process.env.SETU_DEPENDENCY_FILE_NATIVE_HELPER;
    expect(
      helper,
      'set SETU_DEPENDENCY_FILE_NATIVE_HELPER to an existing approved binary'
    ).toBeTruthy();
    const { access } = await import('node:fs/promises');
    await access(helper);
    const native = createDependencyFileNative({ nativeBinary: helper });
    const capability = await native.dependencyFileNativeStatus();
    expect(capability.available, capability.code ?? capability.reason).toBe(
      true
    );
    const f = makeFixture();
    try {
      const first = f.checkout(
        'topic-a',
        'module.exports = 23;\n',
        1_700_000_000
      );
      const second = f.checkout(
        'topic-b',
        'module.exports = 23;\n',
        1_710_000_000
      );
      const store = await openDependencyFileStore(f.sharing, { native });
      const [readFirst, readSecond] = await Promise.all([
        native.readDependencyFile(first, FILE),
        native.readDependencyFile(second, FILE),
      ]);
      expect(readFirst.eligible).toBe(true);
      expect(readSecond.eligible).toBe(true);
      expect(readFirst.fingerprint.mtimeNs).not.toBe(
        readSecond.fingerprint.mtimeNs
      );
      const ensuredFirst = await store.ensure(readFirst.fingerprint, first);
      const ensuredSecond = await store.ensure(readSecond.fingerprint, second);
      expect(ensuredSecond.key).toBe(ensuredFirst.key);
      const canonical = join(
        store.root,
        'objects',
        ensuredFirst.key.slice(0, 2),
        ensuredFirst.key
      );
      const canonicalBefore = statSync(canonical, { bigint: true });
      const stagedFirst = await store.stage(
        ensuredFirst.key,
        first,
        'node_modules/.native-stage.js',
        readFirst.fingerprint
      );
      const stagedSecond = await store.stage(
        ensuredSecond.key,
        second,
        'node_modules/.native-stage.js',
        readSecond.fingerprint
      );
      expect(stagedFirst.mtimeNs).toBe(readFirst.fingerprint.mtimeNs);
      expect(stagedSecond.mtimeNs).toBe(readSecond.fingerprint.mtimeNs);
      expect(stagedFirst.inode).not.toBe(canonicalBefore.ino.toString());
      expect(stagedSecond.inode).not.toBe(canonicalBefore.ino.toString());
      expect(statSync(canonical, { bigint: true }).ino).toBe(
        canonicalBefore.ino
      );
    } finally {
      await native.close();
      f.dispose();
    }
  }
);
