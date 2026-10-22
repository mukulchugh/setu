import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  copyFileSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDependencyFileNative } from './dependency-file-native.js';
import { dependencyObjectKey } from './dependency-file-object.js';
import { openDependencyFileStore } from './dependency-file-store.js';

const SHA256 = /^[a-f0-9]{64}$/;

function hash(value) {
  return createHash('sha256').update(value).digest('hex');
}

function fixture({ base = tmpdir(), mountPath } = {}) {
  const directory = realpathSync(mkdtempSync(join(base, 'setu-file-store-')));
  const workspaceRoot = join(directory, 'workspace');
  const checkout = join(workspaceRoot, 'checkout with spaces');
  const storeRoot = join(directory, 'private-store');
  mkdirSync(checkout, { recursive: true });
  mkdirSync(storeRoot, { mode: 0o700 });
  const executable = join(directory, 'bun-version-fixture');
  writeFileSync(
    executable,
    '#!/bin/sh\nprintf \'["1.3.14","darwin","arm64"]\\n\'\n',
    { mode: 0o700 }
  );
  chmodSync(executable, 0o700);
  const sharing = {
    enabled: true,
    executable,
    storeIdentity: {
      device: lstatSync(storeRoot).dev,
      mountPath: mountPath ?? directory,
    },
    storeRoot,
    version: '1.3.14',
    workspaceRoot,
  };
  return {
    checkout,
    directory,
    dispose: () => rmSync(directory, { force: true, recursive: true }),
    sharing,
    storeRoot,
    workspaceRoot,
  };
}

function fingerprint(path, relativePath) {
  const info = lstatSync(path, { bigint: true });
  if (!info.isFile() || info.nlink !== 1n) {
    throw Object.assign(
      new Error('fixture file is not an exclusive regular file'),
      {
        code: 'DEPENDENCY_FILE_INELIGIBLE',
      }
    );
  }
  const bytes = readFileSync(path);
  const contentHash = hash(bytes);
  const mode = Number(info.mode);
  const uid = Number(info.uid);
  const gid = Number(info.gid);
  const metadataHash = hash(
    JSON.stringify([
      mode,
      uid,
      gid,
      String((BigInt(info.mtimeNs) / 1_000_000n) * 1_000_000n),
      [],
    ])
  );
  const identityHash = hash(
    [
      info.dev,
      info.ino,
      info.size,
      info.mtimeNs,
      info.ctimeNs,
      contentHash,
      metadataHash,
    ].join(':')
  );
  return {
    atimeNs: String(info.atimeNs),
    attributes: [],
    contentHash,
    ctimeNs: String(info.ctimeNs),
    device: String(info.dev),
    gid,
    identityHash,
    inode: String(info.ino),
    metadataHash,
    mode,
    mtimeNs: String(info.mtimeNs),
    relativePath,
    size: Number(info.size),
    uid,
  };
}

function sameDependencyFile(left, right, { identity = false } = {}) {
  if (
    left.contentHash !== right.contentHash ||
    left.metadataHash !== right.metadataHash
  ) {
    return false;
  }
  return !identity || left.identityHash === right.identityHash;
}

// This adapter tests G2 coordination only; its copy operation is not clonefile evidence.
function fixtureNative({ cloneDelayMs = 0, afterClone } = {}) {
  const stats = { activeClones: 0, maxConcurrentClones: 0 };
  return {
    async cloneDependencyFile(
      sourceRoot,
      sourceRelativePath,
      destinationRoot,
      destinationRelativePath,
      expectedFingerprint
    ) {
      stats.activeClones += 1;
      stats.maxConcurrentClones = Math.max(
        stats.maxConcurrentClones,
        stats.activeClones
      );
      const source = join(sourceRoot, ...sourceRelativePath.split('/'));
      const destination = join(
        destinationRoot,
        ...destinationRelativePath.split('/')
      );
      try {
        const before = fingerprint(source, sourceRelativePath);
        if (
          !sameDependencyFile(before, expectedFingerprint, { identity: true })
        ) {
          throw Object.assign(new Error('fixture source changed'), {
            code: 'DEPENDENCY_FILE_SOURCE_CHANGED',
          });
        }
        if (cloneDelayMs) {
          await new Promise((resolve) => setTimeout(resolve, cloneDelayMs));
        }
        copyFileSync(source, destination, 1);
        chmodSync(destination, before.mode);
        const expectedMtime = new Date(
          Number(BigInt(expectedFingerprint.mtimeNs) / 1_000_000n)
        );
        utimesSync(destination, expectedMtime, expectedMtime);
        const cloned = fingerprint(destination, destinationRelativePath);
        if (!sameDependencyFile(cloned, expectedFingerprint)) {
          throw new Error('fixture clone mismatch');
        }
        await afterClone?.({
          destination,
          destinationRelativePath,
          destinationRoot,
        });
        return cloned;
      } finally {
        stats.activeClones -= 1;
      }
    },
    dependencyFileNativeStatus() {
      return { available: true };
    },
    readDependencyFile(root, relativePath) {
      const path = join(root, ...relativePath.split('/'));
      return { eligible: true, fingerprint: fingerprint(path, relativePath) };
    },
    restoreDependencyTimes(root, relativePath, { atimeNs, mtimeNs }) {
      const path = join(root, ...relativePath.split('/'));
      utimesSync(
        path,
        new Date(Number(BigInt(atimeNs) / 1_000_000n)),
        new Date(Number(BigInt(mtimeNs) / 1_000_000n))
      );
      return Promise.resolve({ atimeNs, mtimeNs, restored: true });
    },
    sameDependencyFile,
    stats,
    syncDependencyDirectory() {
      return Promise.resolve();
    },
  };
}

function open(f, native = fixtureNative()) {
  return openDependencyFileStore(f.sharing, { native });
}

async function readFingerprint(native, root, relativePath) {
  const result = await native.readDependencyFile(root, relativePath);
  if (!result.eligible) {
    throw new Error(`ineligible fixture: ${result.reason}`);
  }
  return result.fingerprint;
}

function writeInstalledFile(
  checkout,
  relativePath,
  contents = 'export default 1;\n'
) {
  const path = join(checkout, ...relativePath.split('/'));
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, contents, { mode: 0o644 });
  return path;
}

test('opens the configured hoisted namespace read-only and reports no physical savings', async () => {
  const f = fixture();
  try {
    const store = await open(f);
    const description = await store.describe();

    expect(store.namespace).toBe('hoisted/darwin-arm64-bun-1.3.14');
    expect(store.root).toBe(
      join(f.storeRoot, 'hoisted', 'darwin-arm64-bun-1.3.14')
    );
    expect(store.identity).toEqual({
      device: String(lstatSync(f.storeRoot).dev),
      executable: realpathSync(f.sharing.executable),
      mountPath: realpathSync(f.directory),
      namespace: 'hoisted/darwin-arm64-bun-1.3.14',
      root: realpathSync(f.storeRoot),
      version: '1.3.14',
    });
    expect(description.identity).toEqual(store.identity);
    expect(description.available).toBe(true);
    expect(description.namespaceAvailable).toBe(false);
    expect(description.physicalSavingsBytes).toBeNull();
    expect(description.volumeDeltaAvailableBytes).toBeNull();
    expect(lstatSync(f.storeRoot).mode % 0o1000).toBe(0o700);
    expect(() => lstatSync(store.root)).toThrow();
  } finally {
    f.dispose();
  }
});

test('stores and stages fixture files without hard-linking installed paths', async () => {
  const f = fixture();
  try {
    mkdirSync(join(f.checkout, 'node_modules'), { recursive: true });
    const sourcePath = writeInstalledFile(
      f.checkout,
      'node_modules/pkg/index.js'
    );
    mkdirSync(join(f.checkout, 'node_modules/pkg/.setu-stage'));
    const native = fixtureNative();
    const store = await open(f, native);
    const expected = await readFingerprint(
      native,
      f.checkout,
      'node_modules/pkg/index.js'
    );
    const key = store.objectKey(expected);
    expect(key).toMatch(SHA256);
    expect(key).toBe(dependencyObjectKey(expected));

    const object = await store.ensure(expected, f.checkout);
    expect(object.key).toBe(key);
    expect(object.fingerprint.relativePath).toBe(object.relativePath);
    expect(object.fingerprint.contentHash).toBe(expected.contentHash);
    expect(await store.verify(key, expected)).toBe(true);

    const staged = await store.stage(
      key,
      f.checkout,
      'node_modules/pkg/.setu-stage/index.js',
      expected
    );
    const stagedPath = join(
      f.checkout,
      'node_modules/pkg/.setu-stage/index.js'
    );
    expect(staged.contentHash).toBe(expected.contentHash);
    expect(readFileSync(stagedPath, 'utf8')).toBe('export default 1;\n');
    expect(lstatSync(sourcePath).ino).not.toBe(lstatSync(stagedPath).ino);
    expect(lstatSync(sourcePath).nlink).toBe(1);
    expect(lstatSync(stagedPath).nlink).toBe(1);
  } finally {
    f.dispose();
  }
});

test('reuses one canonical object for compatible files with different mtimes', async () => {
  const f = fixture();
  try {
    const firstPath = writeInstalledFile(f.checkout, 'node_modules/pkg.js');
    const secondCheckout = join(f.workspaceRoot, 'checkout-two');
    mkdirSync(secondCheckout);
    const secondPath = writeInstalledFile(
      secondCheckout,
      'node_modules/pkg.js'
    );
    const firstTime = new Date('2024-01-02T03:04:05.000Z');
    const secondTime = new Date('2025-06-07T08:09:10.000Z');
    utimesSync(firstPath, firstTime, firstTime);
    utimesSync(secondPath, secondTime, secondTime);

    const native = fixtureNative();
    const store = await open(f, native);
    const firstFingerprint = await readFingerprint(
      native,
      f.checkout,
      'node_modules/pkg.js'
    );
    const secondFingerprint = await readFingerprint(
      native,
      secondCheckout,
      'node_modules/pkg.js'
    );
    expect(firstFingerprint.contentHash).toBe(secondFingerprint.contentHash);
    expect(firstFingerprint.metadataHash).not.toBe(
      secondFingerprint.metadataHash
    );

    const first = await store.ensure(firstFingerprint, f.checkout);
    const second = await store.ensure(secondFingerprint, secondCheckout);
    mkdirSync(join(secondCheckout, 'node_modules/.setu-stage'));
    const staged = await store.stage(
      second.key,
      secondCheckout,
      'node_modules/.setu-stage/pkg.js',
      secondFingerprint
    );

    expect(second.key).toBe(first.key);
    expect(second.relativePath).toBe(first.relativePath);
    expect(second.fingerprint.mtimeNs).toBe(firstFingerprint.mtimeNs);
    expect(await store.verify(second.key, secondFingerprint)).toBe(true);
    expect(staged.mtimeNs).toBe(secondFingerprint.mtimeNs);
    expect(staged.inode).not.toBe(second.fingerprint.inode);
  } finally {
    f.dispose();
  }
});

test('preserves explicit version 1 object keys for saved-plan recovery', async () => {
  const f = fixture();
  try {
    writeInstalledFile(f.checkout, 'node_modules/legacy.js');
    const native = fixtureNative();
    const store = await open(f, native);
    const expected = await readFingerprint(
      native,
      f.checkout,
      'node_modules/legacy.js'
    );
    const key = store.objectKey(expected, 1);

    expect(key).toBe(hash(`${expected.contentHash}${expected.metadataHash}`));
    const object = await store.ensure(expected, f.checkout, { version: 1 });
    expect(object.key).toBe(key);
    expect(await store.verify(key, expected)).toBe(true);
  } finally {
    f.dispose();
  }
});

test('refuses G1 ineligible read results at source and stored-object boundaries', async () => {
  const f = fixture();
  try {
    writeInstalledFile(f.checkout, 'node_modules/pkg.js');
    const native = fixtureNative();
    const store = await open(f, native);
    const expected = await readFingerprint(
      native,
      f.checkout,
      'node_modules/pkg.js'
    );
    const object = await store.ensure(expected, f.checkout);
    native.readDependencyFile = async () => ({
      eligible: false,
      reason: 'hard-linked-file',
    });

    await expect(store.ensure(expected, f.checkout)).rejects.toMatchObject({
      code: 'DEPENDENCY_STORE_SOURCE_CHANGED',
    });
    await expect(store.verify(object.key, expected)).rejects.toMatchObject({
      code: 'DEPENDENCY_STORE_OBJECT_CORRUPT',
    });
    await expect(
      store.stage(
        object.key,
        f.checkout,
        'node_modules/.setu-stage/pkg.js',
        expected
      )
    ).rejects.toMatchObject({ code: 'DEPENDENCY_STORE_OBJECT_CORRUPT' });
  } finally {
    f.dispose();
  }
});

test('competing writers publish one verified immutable object without replacing it', async () => {
  const f = fixture();
  try {
    const sourcePath = writeInstalledFile(f.checkout, 'node_modules/pkg.js');
    const native = fixtureNative({ cloneDelayMs: 10 });
    const store = await open(f, native);
    const expected = await readFingerprint(
      native,
      f.checkout,
      'node_modules/pkg.js'
    );

    const [first, second] = await Promise.all([
      store.ensure(expected, f.checkout),
      store.ensure(expected, f.checkout),
    ]);

    expect(first.relativePath).toBe(second.relativePath);
    expect(await store.verify(first.key, expected)).toBe(true);
    expect(lstatSync(sourcePath).nlink).toBe(1);
    expect(lstatSync(join(store.root, first.relativePath)).nlink).toBe(1);
  } finally {
    f.dispose();
  }
});

test('mtime-distinct concurrent publishers reconcile to the winning canonical object', async () => {
  const f = fixture();
  try {
    const secondCheckout = join(f.workspaceRoot, 'checkout-two');
    mkdirSync(secondCheckout);
    const firstPath = writeInstalledFile(f.checkout, 'node_modules/pkg.js');
    const secondPath = writeInstalledFile(
      secondCheckout,
      'node_modules/pkg.js'
    );
    const firstTime = new Date('2024-04-05T06:07:08.000Z');
    const secondTime = new Date('2025-08-09T10:11:12.000Z');
    utimesSync(firstPath, firstTime, firstTime);
    utimesSync(secondPath, secondTime, secondTime);
    const native = fixtureNative({ cloneDelayMs: 10 });
    const store = await open(f, native);
    const [firstFingerprint, secondFingerprint] = await Promise.all([
      readFingerprint(native, f.checkout, 'node_modules/pkg.js'),
      readFingerprint(native, secondCheckout, 'node_modules/pkg.js'),
    ]);

    const [first, second] = await Promise.all([
      store.ensure(firstFingerprint, f.checkout),
      store.ensure(secondFingerprint, secondCheckout),
    ]);

    expect(first.key).toBe(second.key);
    expect(first.relativePath).toBe(second.relativePath);
    expect(first.fingerprint.mtimeNs).toBe(second.fingerprint.mtimeNs);
    expect([firstFingerprint.mtimeNs, secondFingerprint.mtimeNs]).toContain(
      first.fingerprint.mtimeNs
    );
    expect(await store.verify(first.key, firstFingerprint)).toBe(true);
    expect(await store.verify(second.key, secondFingerprint)).toBe(true);
  } finally {
    f.dispose();
  }
});

test('bounds concurrent native clone work across distinct objects', async () => {
  const f = fixture();
  try {
    mkdirSync(join(f.checkout, 'node_modules'), { recursive: true });
    const relativePaths = Array.from(
      { length: 8 },
      (_, index) => `node_modules/pkg-${index}.js`
    );
    for (const [index, relativePath] of relativePaths.entries()) {
      writeInstalledFile(
        f.checkout,
        relativePath,
        `export default ${index};\n`
      );
    }
    const native = fixtureNative({ cloneDelayMs: 20 });
    const store = await open(f, native);
    const fingerprints = [];
    fingerprints.push(
      ...(await Promise.all(
        relativePaths.map((relativePath) =>
          readFingerprint(native, f.checkout, relativePath)
        )
      ))
    );

    await Promise.all(
      fingerprints.map((plannedFingerprint) =>
        store.ensure(plannedFingerprint, f.checkout)
      )
    );

    expect(native.stats.maxConcurrentClones).toBe(4);
  } finally {
    f.dispose();
  }
});

test('source drift and corrupted objects fail closed without replacing stored bytes', async () => {
  const f = fixture();
  try {
    writeInstalledFile(f.checkout, 'node_modules/pkg.js');
    const native = fixtureNative();
    const store = await open(f, native);
    const expected = await readFingerprint(
      native,
      f.checkout,
      'node_modules/pkg.js'
    );
    const changedSource = writeInstalledFile(
      f.checkout,
      'node_modules/pkg.js',
      'export default 2;\n'
    );
    await expect(store.ensure(expected, f.checkout)).rejects.toMatchObject({
      code: 'DEPENDENCY_STORE_SOURCE_CHANGED',
    });
    expect(readFileSync(changedSource, 'utf8')).toBe('export default 2;\n');

    const current = await readFingerprint(
      native,
      f.checkout,
      'node_modules/pkg.js'
    );
    const object = await store.ensure(current, f.checkout);
    const objectPath = join(store.root, object.relativePath);
    writeFileSync(objectPath, 'corrupt object\n');
    await expect(store.verify(object.key, current)).rejects.toMatchObject({
      code: 'DEPENDENCY_STORE_OBJECT_CORRUPT',
    });
    await expect(store.ensure(current, f.checkout)).rejects.toMatchObject({
      code: 'DEPENDENCY_STORE_OBJECT_CORRUPT',
    });
    expect(readFileSync(objectPath, 'utf8')).toBe('corrupt object\n');
  } finally {
    f.dispose();
  }
});

test('refuses a staged file changed after its clone snapshot', async () => {
  const f = fixture();
  try {
    writeInstalledFile(
      f.checkout,
      'node_modules/pkg.js',
      'export default 1;\n'
    );
    const native = fixtureNative({
      afterClone({ destinationRoot, destination }) {
        if (destinationRoot === f.checkout) {
          writeFileSync(destination, 'export default 2;\n');
        }
      },
    });
    const store = await open(f, native);
    const expected = await readFingerprint(
      native,
      f.checkout,
      'node_modules/pkg.js'
    );
    const object = await store.ensure(expected, f.checkout);
    mkdirSync(join(f.checkout, 'node_modules/.setu-stage'), {
      recursive: true,
    });

    await expect(
      store.stage(
        object.key,
        f.checkout,
        'node_modules/.setu-stage/pkg.js',
        expected
      )
    ).rejects.toMatchObject({ code: 'DEPENDENCY_STORE_STAGE_CORRUPT' });
  } finally {
    f.dispose();
  }
});

test('rejects a missing or substituted configured volume without creating a namespace', async () => {
  const f = fixture();
  try {
    const missing = { ...f.sharing, storeRoot: join(f.directory, 'missing') };
    await expect(
      openDependencyFileStore(missing, { native: fixtureNative() })
    ).rejects.toMatchObject({ code: 'DEPENDENCY_STORE_ROOT_MISSING' });

    await expect(
      openDependencyFileStore(
        {
          ...f.sharing,
          storeIdentity: {
            ...f.sharing.storeIdentity,
            device: f.sharing.storeIdentity.device + 100,
          },
        },
        { native: fixtureNative() }
      )
    ).rejects.toMatchObject({ code: 'DEPENDENCY_STORE_VOLUME_MISMATCH' });
    expect(() => lstatSync(join(f.storeRoot, 'hoisted'))).toThrow();
  } finally {
    f.dispose();
  }
});

test('accepts a store under the /Users firmlink through its observed data-volume anchor', async () => {
  if (process.platform !== 'darwin') {
    return;
  }

  const users = realpathSync('/Users');
  const dataVolume = realpathSync('/System/Volumes/Data');
  const usersInfo = lstatSync(users);
  const dataInfo = lstatSync(dataVolume);
  if (usersInfo.dev !== dataInfo.dev) {
    return;
  }

  const f = fixture({ base: process.cwd(), mountPath: dataVolume });
  try {
    expect(realpathSync(f.storeRoot).startsWith(`${dataVolume}/`)).toBe(false);
    expect(lstatSync(f.storeRoot).dev).toBe(dataInfo.dev);
    const store = await open(f);
    expect((await store.describe()).identity).toMatchObject({
      mountPath: dataVolume,
      root: realpathSync(f.storeRoot),
    });
  } finally {
    f.dispose();
  }
});

test('accepts the root mount anchor only when its observed device matches the store', async () => {
  const rootInfo = lstatSync('/');
  const f = fixture({ mountPath: '/' });
  try {
    if (rootInfo.dev !== lstatSync(f.storeRoot).dev) {
      return;
    }
    const store = await open(f);
    expect((await store.describe()).identity.mountPath).toBe('/');
  } finally {
    f.dispose();
  }
});

test('refuses a mount anchor replaced at the same path', async () => {
  const f = fixture();
  const mountPath = join(f.directory, 'mount-anchor');
  const displaced = join(f.directory, 'displaced-anchor');
  mkdirSync(mountPath);
  const sharing = {
    ...f.sharing,
    storeIdentity: { ...f.sharing.storeIdentity, mountPath },
  };
  try {
    const store = await openDependencyFileStore(sharing, {
      native: fixtureNative(),
    });
    renameSync(mountPath, displaced);
    mkdirSync(mountPath);
    await expect(store.describe()).rejects.toMatchObject({
      code: 'DEPENDENCY_STORE_VOLUME_MISMATCH',
    });
  } finally {
    f.dispose();
  }
});

test('detects replacement of the configured source root even on the same device', async () => {
  const f = fixture();
  const displaced = join(f.directory, 'displaced-store');
  try {
    const store = await open(f);
    renameSync(f.storeRoot, displaced);
    mkdirSync(f.storeRoot, { mode: 0o700 });
    await expect(store.describe()).rejects.toMatchObject({
      code: 'DEPENDENCY_STORE_VOLUME_MISMATCH',
    });
  } finally {
    f.dispose();
  }
});

test('refuses store roots reached through a symlink', async () => {
  const f = fixture();
  const alias = join(f.directory, 'store-alias');
  try {
    symlinkSync(f.storeRoot, alias, 'dir');
    await expect(
      openDependencyFileStore(
        { ...f.sharing, storeRoot: alias },
        { native: fixtureNative() }
      )
    ).rejects.toMatchObject({ code: 'DEPENDENCY_STORE_ROOT_INVALID' });
    expect(() => lstatSync(join(f.storeRoot, 'hoisted'))).toThrow();
  } finally {
    f.dispose();
  }
});

test('reports unavailable native capability and refuses mutation without creating store directories', async () => {
  const f = fixture();
  try {
    mkdirSync(join(f.checkout, 'node_modules'), { recursive: true });
    writeInstalledFile(f.checkout, 'node_modules/pkg.js');
    const native = fixtureNative();
    native.dependencyFileNativeStatus = async () => ({
      available: false,
      code: 'DEPENDENCY_FILE_NATIVE_UNAVAILABLE',
      reason: 'No compiled helper is present',
    });
    const store = await open(f, native);
    const description = await store.describe();
    const expected = await readFingerprint(
      native,
      f.checkout,
      'node_modules/pkg.js'
    );

    expect(description.available).toBe(false);
    expect(description.native).toMatchObject({
      available: false,
      code: 'DEPENDENCY_FILE_NATIVE_UNAVAILABLE',
    });
    await expect(store.ensure(expected, f.checkout)).rejects.toMatchObject({
      code: 'DEPENDENCY_FILE_NATIVE_UNAVAILABLE',
    });
    expect(() => lstatSync(join(f.storeRoot, 'hoisted'))).toThrow();
  } finally {
    f.dispose();
  }
});

test('refreshes native capability after opening when the approved helper appears', async () => {
  const f = fixture();
  try {
    writeInstalledFile(f.checkout, 'node_modules/pkg.js');
    const native = fixtureNative();
    let available = false;
    native.dependencyFileNativeStatus = async () => ({
      available,
      code: 'DEPENDENCY_FILE_NATIVE_UNAVAILABLE',
    });
    const store = await open(f, native);
    expect((await store.describe()).available).toBe(false);
    available = true;
    const expected = await readFingerprint(
      native,
      f.checkout,
      'node_modules/pkg.js'
    );
    expect((await store.describe()).available).toBe(true);
    expect((await store.ensure(expected, f.checkout)).key).toBe(
      store.objectKey(expected)
    );
  } finally {
    f.dispose();
  }
});

// Uses the real G1 factory and host stat/forced-clone operations. The test seam
// represents the unavailable helper protocol and an empty xattr enumeration;
// it does not claim to verify native helper packaging or xattr contents.
test('real G1 factory adapter stores and stages eligible files through the host clone path', async () => {
  if (process.platform !== 'darwin' || process.arch !== 'arm64') {
    return;
  }
  const f = fixture();
  try {
    const sourcePath = writeInstalledFile(
      f.checkout,
      'node_modules/pkg.js',
      'real factory bytes\n'
    );
    const fixedTime = new Date('2024-03-04T05:06:07.123Z');
    utimesSync(sourcePath, fixedTime, fixedTime);
    mkdirSync(join(f.checkout, 'node_modules', '.setu-stage'));
    const native = createDependencyFileNative({
      nativeBinary: '/test/setu-dependency-files',
      processRunner: (command, args) => {
        if (command === '/usr/bin/xattr') {
          return { stderr: '', stdout: '' };
        }
        if (command !== '/test/setu-dependency-files') {
          throw new Error('unexpected command');
        }
        if (args[0] === 'version') {
          return {
            stderr: '',
            stdout: `${JSON.stringify({
              capabilities: [
                'stdio',
                'xattrs',
                'swap',
                'forced-clone',
                'lease',
              ],
              ok: true,
              protocol: 2,
              version: '2',
            })}\n`,
          };
        }
        if (args[0] === 'probe') {
          const info = lstatSync(join(args[1], ...args[2].split('/')), {
            bigint: true,
          });
          return {
            stderr: '',
            stdout: `${JSON.stringify({
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
            })}\n`,
          };
        }
        if (args[0] === 'restore-times') {
          const filePath = join(args[1], ...args[2].split('/'));
          utimesSync(
            filePath,
            new Date(Number(BigInt(args[3])) / 1_000_000),
            new Date(Number(BigInt(args[4])) / 1_000_000)
          );
          return {
            stderr: '',
            stdout: `${JSON.stringify({
              atimeNs: args[3],
              device: args[5],
              inode: args[6],
              mtimeNs: args[4],
              ok: true,
              protocol: 1,
              restored: true,
            })}\n`,
          };
        }
        throw new Error(`unexpected helper command ${args[0]}`);
      },
    });
    const store = await open(f, native);
    const result = await native.readDependencyFile(
      f.checkout,
      'node_modules/pkg.js'
    );
    expect(result.eligible).toBe(true);
    const object = await store.ensure(result.fingerprint, f.checkout);
    const staged = await store.stage(
      object.key,
      f.checkout,
      'node_modules/.setu-stage/pkg.js',
      result.fingerprint
    );
    expect(staged.contentHash).toBe(result.fingerprint.contentHash);
    expect(
      readFileSync(join(f.checkout, 'node_modules/.setu-stage/pkg.js'), 'utf8')
    ).toBe('real factory bytes\n');
  } finally {
    f.dispose();
  }
});

test('rejects malformed object keys before touching the store', async () => {
  const f = fixture();
  try {
    const store = await open(f);
    await expect(store.verify('../not-a-key', {})).rejects.toMatchObject({
      code: 'DEPENDENCY_STORE_KEY_INVALID',
    });
    await expect(
      store.stage('../not-a-key', f.checkout, 'node_modules/tmp.js', {})
    ).rejects.toMatchObject({ code: 'DEPENDENCY_STORE_KEY_INVALID' });
  } finally {
    f.dispose();
  }
});
