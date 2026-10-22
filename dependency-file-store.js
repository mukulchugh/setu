import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import {
  link,
  lstat,
  mkdir,
  open,
  readFile,
  realpath,
  stat,
  unlink,
} from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import {
  dependencyObjectKey,
  sameDependencyObject,
} from './dependency-file-object.js';

const exec = promisify(execFile);
const BUN_VERSION = '1.3.14';
const NAMESPACE = 'hoisted/darwin-arm64-bun-1.3.14';
const STORE_DIRECTORY_MODE = 0o700;
const LOCK_FILE_MODE = 0o600;
const OBJECT_KEY = /^[a-f0-9]{64}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const DECIMAL = /^(0|[1-9][0-9]*)$/;
const SIGNED_DECIMAL = /^-?(0|[1-9][0-9]*)$/;
const DISPOSABLE_PATH =
  /(?:^|\/)(?:node_modules|\.git|\.bun-cache|cache|caches|tmp|temp)(?:\/|$)/i;
const LOCK_WAIT_MS = 15_000;
const LOCK_POLL_MS = 25;
// POSIX open flags are bit fields, not boolean operators.
// biome-ignore lint/suspicious/noBitwiseOperators: Required O_RDONLY and O_NOFOLLOW flag combination.
const NOFOLLOW_READ_FLAGS = fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW;

function storeError(code, message, cause) {
  return Object.assign(new Error(message, cause ? { cause } : undefined), {
    code,
  });
}

function hasExactMode(mode, expected) {
  // POSIX permission bits require a mask to exclude file type bits.
  // biome-ignore lint/suspicious/noBitwiseOperators: Required POSIX stat permission mask.
  return (mode & 0o7777) === expected;
}

function hasExecutableMode(mode) {
  // POSIX execute bits determine whether the pinned runtime can be invoked.
  // biome-ignore lint/suspicious/noBitwiseOperators: Required POSIX executable permission mask.
  return (mode & 0o111) !== 0;
}

function createWorkLimiter(limit) {
  let active = 0;
  const waiting = [];
  return async function runLimited(work) {
    if (active < limit) {
      active += 1;
    } else {
      await new Promise((resume) => waiting.push(resume));
    }
    try {
      return await work();
    } finally {
      const resume = waiting.shift();
      if (resume) {
        resume();
      } else {
        active -= 1;
      }
    }
  };
}

function isMissing(error) {
  return (
    error?.code === 'ENOENT' || error?.code === 'DEPENDENCY_STORE_ROOT_MISSING'
  );
}

function assertRelativePath(path, code = 'DEPENDENCY_STORE_PATH_INVALID') {
  if (
    typeof path !== 'string' ||
    !path ||
    path.startsWith('/') ||
    path.includes('\0')
  ) {
    throw storeError(code, 'A checkout-relative POSIX path is required');
  }
  const components = path.split('/');
  if (
    components.some(
      (component) =>
        !component ||
        component === '.' ||
        component === '..' ||
        component === '.git'
    )
  ) {
    throw storeError(code, 'The dependency file path is not safe');
  }
  return components;
}

function assertFingerprint(fingerprint) {
  if (
    !fingerprint ||
    typeof fingerprint !== 'object' ||
    Array.isArray(fingerprint)
  ) {
    throw storeError(
      'DEPENDENCY_STORE_FINGERPRINT_INVALID',
      'A complete dependency file fingerprint is required'
    );
  }
  assertRelativePath(fingerprint.relativePath);
  const validFingerprint =
    DECIMAL.test(fingerprint.device) &&
    DECIMAL.test(fingerprint.inode) &&
    SIGNED_DECIMAL.test(fingerprint.mtimeNs) &&
    SIGNED_DECIMAL.test(fingerprint.ctimeNs) &&
    SIGNED_DECIMAL.test(fingerprint.atimeNs) &&
    Number.isSafeInteger(fingerprint.size) &&
    fingerprint.size >= 0 &&
    Number.isSafeInteger(fingerprint.mode) &&
    fingerprint.mode >= 0 &&
    Number.isSafeInteger(fingerprint.uid) &&
    fingerprint.uid >= 0 &&
    Number.isSafeInteger(fingerprint.gid) &&
    fingerprint.gid >= 0 &&
    SHA256.test(fingerprint.contentHash) &&
    SHA256.test(fingerprint.metadataHash) &&
    SHA256.test(fingerprint.identityHash) &&
    Array.isArray(fingerprint.attributes) &&
    (() => {
      const names = new Set();
      return fingerprint.attributes.every((attribute) => {
        if (
          !attribute ||
          typeof attribute.name !== 'string' ||
          attribute.name.length === 0 ||
          attribute.name.includes('\0') ||
          !SHA256.test(attribute.digest) ||
          names.has(attribute.name)
        ) {
          return false;
        }
        names.add(attribute.name);
        return true;
      });
    })();
  if (!validFingerprint) {
    throw storeError(
      'DEPENDENCY_STORE_FINGERPRINT_INVALID',
      'The dependency file fingerprint is incomplete or malformed'
    );
  }
  return fingerprint;
}

function snapshotFingerprint(fingerprint) {
  return {
    ...fingerprint,
    attributes: fingerprint.attributes.map((attribute) => ({ ...attribute })),
  };
}

function objectKeyFor(fingerprint, version = 2) {
  assertFingerprint(fingerprint);
  const key = dependencyObjectKey(fingerprint, version);
  if (!OBJECT_KEY.test(key)) {
    throw storeError(
      'DEPENDENCY_STORE_KEY_INVALID',
      'A dependency object key could not be established'
    );
  }
  return key;
}

function assertNative(native) {
  for (const name of [
    'readDependencyFile',
    'sameDependencyFile',
    'cloneDependencyFile',
    'restoreDependencyTimes',
    'syncDependencyDirectory',
    'dependencyFileNativeStatus',
  ]) {
    if (typeof native?.[name] !== 'function') {
      throw storeError(
        'DEPENDENCY_FILE_NATIVE_UNAVAILABLE',
        'The verified native dependency-file helper is unavailable'
      );
    }
  }
}

async function loadNative(native) {
  if (native) {
    assertNative(native);
    return native;
  }
  try {
    const loaded = await import('./dependency-file-native.js');
    assertNative(loaded);
    return loaded;
  } catch (cause) {
    throw storeError(
      'DEPENDENCY_FILE_NATIVE_UNAVAILABLE',
      'The verified native dependency-file helper is unavailable; no build or fallback was attempted',
      cause
    );
  }
}

async function readEligibleFingerprint(native, root, relativePath) {
  const result = await native.readDependencyFile(root, relativePath);
  if (result?.eligible !== true || !result.fingerprint) {
    throw storeError(
      'DEPENDENCY_FILE_INELIGIBLE',
      'The dependency file is not eligible for safe sharing'
    );
  }
  return assertFingerprint(result.fingerprint);
}

async function assertNoSymlinkComponents(path, code, message) {
  const absolute = resolve(path);
  const parsedRoot = absolute.startsWith(sep) ? sep : '';
  const components = absolute
    .slice(parsedRoot.length)
    .split(sep)
    .filter(Boolean);
  let current = parsedRoot || components.shift();
  if (!(parsedRoot || current)) {
    current = '.';
  }
  for (const component of components) {
    current = join(current, component);
    let info;
    try {
      // Check each ancestor before inspecting any child path.
      // biome-ignore lint/performance/noAwaitInLoops: Sequential no-follow validation prevents symlink traversal.
      info = await lstat(current);
    } catch (cause) {
      throw storeError(code, message, cause);
    }
    if (info.isSymbolicLink()) {
      throw storeError(code, message);
    }
  }
  return absolute;
}

function assertPrivateDirectoryInfo(info, expectedDevice, label) {
  if (
    !info.isDirectory() ||
    info.uid !== process.getuid() ||
    !hasExactMode(info.mode, STORE_DIRECTORY_MODE) ||
    (expectedDevice !== undefined && info.dev !== expectedDevice)
  ) {
    throw storeError(
      'DEPENDENCY_STORE_ROOT_INVALID',
      `${label} must be a current-user-owned private directory on the configured volume`
    );
  }
}

async function assertPrivateDirectory(path, expectedDevice, label) {
  const info = await lstat(path).catch((cause) => {
    throw storeError(
      'DEPENDENCY_STORE_ROOT_MISSING',
      `${label} is missing`,
      cause
    );
  });
  assertPrivateDirectoryInfo(info, expectedDevice, label);
  await assertNoSymlinkComponents(
    path,
    'DEPENDENCY_STORE_ROOT_INVALID',
    `${label} must not be reached through a symlink`
  );
  const canonical = await realpath(path).catch((cause) => {
    throw storeError(
      'DEPENDENCY_STORE_ROOT_INVALID',
      `${label} is unavailable`,
      cause
    );
  });
  if (canonical !== resolve(path)) {
    throw storeError(
      'DEPENDENCY_STORE_ROOT_INVALID',
      `${label} must be a canonical directory without symlinks`
    );
  }
  return info;
}

function assertOutsideWorkspace(storeRoot, workspaceRoot) {
  if (
    DISPOSABLE_PATH.test(storeRoot) ||
    storeRoot === workspaceRoot ||
    storeRoot.startsWith(`${workspaceRoot}${sep}`) ||
    workspaceRoot.startsWith(`${storeRoot}${sep}`)
  ) {
    throw storeError(
      'DEPENDENCY_STORE_ROOT_INVALID',
      'The dependency store must be outside checkouts and disposable paths'
    );
  }
}

function assertSharingConfiguration(sharing) {
  if (
    sharing?.enabled !== true ||
    sharing.version !== BUN_VERSION ||
    typeof sharing.executable !== 'string' ||
    !isAbsolute(sharing.executable) ||
    typeof sharing.storeRoot !== 'string' ||
    !isAbsolute(sharing.storeRoot) ||
    typeof sharing.workspaceRoot !== 'string' ||
    !isAbsolute(sharing.workspaceRoot)
  ) {
    throw storeError(
      'DEPENDENCY_STORE_CONFIG_INVALID',
      'Hoisted file sharing requires the existing enabled Bun 1.3.14 central store configuration'
    );
  }
  const identity = sharing.storeIdentity;
  if (
    !(identity && Number.isSafeInteger(identity.device)) ||
    identity.device < 0 ||
    typeof identity.mountPath !== 'string' ||
    !isAbsolute(identity.mountPath)
  ) {
    throw storeError(
      'DEPENDENCY_STORE_VOLUME_UNKNOWN',
      'The configured dependency-store volume identity is unavailable'
    );
  }
  if (process.platform !== 'darwin' || process.arch !== 'arm64') {
    throw storeError(
      'DEPENDENCY_STORE_RUNTIME_UNSUPPORTED',
      'Hoisted file sharing supports only Bun 1.3.14 on darwin-arm64'
    );
  }
  if (typeof process.getuid !== 'function') {
    throw storeError(
      'DEPENDENCY_STORE_RUNTIME_UNSUPPORTED',
      'The current platform cannot verify the dependency-store owner'
    );
  }
  return identity;
}

async function verifyRuntime(executable) {
  const canonicalExecutable = await realpath(executable).catch((cause) => {
    throw storeError(
      'DEPENDENCY_STORE_EXECUTABLE_INVALID',
      'The configured Bun executable is missing or unavailable',
      cause
    );
  });
  const info = await lstat(canonicalExecutable).catch((cause) => {
    throw storeError(
      'DEPENDENCY_STORE_EXECUTABLE_INVALID',
      'The configured Bun executable is unavailable',
      cause
    );
  });
  if (!(info.isFile() && hasExecutableMode(info.mode))) {
    throw storeError(
      'DEPENDENCY_STORE_EXECUTABLE_INVALID',
      'The configured Bun executable is not an executable file'
    );
  }
  let stdout;
  try {
    ({ stdout } = await exec(
      canonicalExecutable,
      [
        '-e',
        'console.log(JSON.stringify([Bun.version, process.platform, process.arch]))',
      ],
      {
        encoding: 'utf8',
        maxBuffer: 4096,
        timeout: 5000,
      }
    ));
  } catch (cause) {
    throw storeError(
      'DEPENDENCY_STORE_RUNTIME_UNKNOWN',
      'The configured Bun runtime could not be verified',
      cause
    );
  }
  let runtime;
  try {
    runtime = JSON.parse(stdout.trim());
  } catch (cause) {
    throw storeError(
      'DEPENDENCY_STORE_RUNTIME_UNKNOWN',
      'The configured Bun runtime returned an invalid identity',
      cause
    );
  }
  if (
    !Array.isArray(runtime) ||
    runtime.length !== 3 ||
    runtime[0] !== BUN_VERSION ||
    runtime[1] !== 'darwin' ||
    runtime[2] !== 'arm64'
  ) {
    throw storeError(
      'DEPENDENCY_STORE_RUNTIME_UNSUPPORTED',
      'The configured runtime is not Bun 1.3.14 on darwin-arm64'
    );
  }
  return canonicalExecutable;
}

async function inspectOptionalPrivatePath(path, expectedDevice) {
  let info;
  try {
    info = await lstat(path);
  } catch (error) {
    if (isMissing(error)) {
      return false;
    }
    throw storeError(
      'DEPENDENCY_STORE_ROOT_INVALID',
      'An existing hoisted namespace path could not be inspected',
      error
    );
  }
  await assertPrivateDirectory(
    path,
    expectedDevice,
    'Hoisted namespace directories'
  );
  return info;
}

async function ensurePrivateDirectory(
  path,
  expectedDevice,
  parentPath,
  native,
  assertVolume
) {
  await assertVolume();
  let created = false;
  try {
    await mkdir(path, { mode: STORE_DIRECTORY_MODE });
    created = true;
  } catch (error) {
    if (error.code !== 'EEXIST') {
      throw storeError(
        'DEPENDENCY_STORE_DIRECTORY_CREATE_FAILED',
        'A private hoisted object directory could not be created',
        error
      );
    }
  }
  await assertPrivateDirectory(
    path,
    expectedDevice,
    'Hoisted namespace directories'
  );
  if (parentPath) {
    await assertPrivateDirectory(
      parentPath,
      expectedDevice,
      'Hoisted namespace directories'
    );
    await native.syncDependencyDirectory(parentPath).catch((cause) => {
      throw storeError(
        'DEPENDENCY_STORE_DIRECTORY_SYNC_UNKNOWN',
        'A hoisted namespace directory entry could not be made durable',
        cause
      );
    });
  }
  if (created) {
    await assertVolume();
  }
  return path;
}

async function syncExactFile(path, fingerprint) {
  const noFollow = fsConstants.O_NOFOLLOW;
  if (!Number.isInteger(noFollow)) {
    throw storeError(
      'DEPENDENCY_STORE_SYNC_UNAVAILABLE',
      'The platform cannot sync a staged dependency file without following symlinks'
    );
  }
  let handle;
  try {
    const beforePath = await lstat(path, { bigint: true });
    if (
      beforePath.isSymbolicLink() ||
      !beforePath.isFile() ||
      beforePath.nlink !== 1n ||
      String(beforePath.dev) !== fingerprint.device ||
      String(beforePath.ino) !== fingerprint.inode
    ) {
      throw storeError(
        'DEPENDENCY_STORE_STAGE_CORRUPT',
        'The private dependency object stage changed before file sync'
      );
    }
    handle = await open(path, NOFOLLOW_READ_FLAGS);
    const before = await handle.stat({ bigint: true });
    if (
      !before.isFile() ||
      before.dev !== beforePath.dev ||
      before.ino !== beforePath.ino ||
      before.size !== BigInt(fingerprint.size) ||
      Number(before.mode) !== fingerprint.mode ||
      Number(before.uid) !== fingerprint.uid ||
      Number(before.gid) !== fingerprint.gid
    ) {
      throw storeError(
        'DEPENDENCY_STORE_STAGE_CORRUPT',
        'The private dependency object stage changed before file sync'
      );
    }
    await handle.sync();
    const after = await handle.stat({ bigint: true });
    if (
      after.dev !== before.dev ||
      after.ino !== before.ino ||
      after.size !== before.size ||
      after.mode !== before.mode ||
      after.uid !== before.uid ||
      after.gid !== before.gid ||
      after.mtimeNs !== before.mtimeNs ||
      after.ctimeNs !== before.ctimeNs
    ) {
      throw storeError(
        'DEPENDENCY_STORE_STAGE_CORRUPT',
        'The private dependency object stage changed during file sync'
      );
    }
  } catch (cause) {
    if (cause.code?.startsWith('DEPENDENCY_STORE_')) {
      throw cause;
    }
    throw storeError(
      'DEPENDENCY_STORE_SYNC_UNKNOWN',
      'The private dependency object stage could not be synced safely',
      cause
    );
  } finally {
    await handle?.close().catch(() => {
      // Preserve the original fsync or validation result after best-effort close.
    });
  }
}

async function pathExists(path) {
  try {
    return await lstat(path);
  } catch (error) {
    if (isMissing(error)) {
      return null;
    }
    throw error;
  }
}

function checkKey(key) {
  if (typeof key !== 'string' || !OBJECT_KEY.test(key)) {
    throw storeError(
      'DEPENDENCY_STORE_KEY_INVALID',
      'A lowercase SHA-256 object key is required'
    );
  }
}

function objectRelativePath(key) {
  return `objects/${key.slice(0, 2)}/${key}`;
}

function lockRelativePath(key) {
  return `objects/${key.slice(0, 2)}/.${key}.publish.lock`;
}

function stageRelativePath(key, id) {
  return `objects/${key.slice(0, 2)}/.${key}.${id}.stage`;
}

async function assertCheckout(checkoutRoot, workspaceRoot, device) {
  if (typeof checkoutRoot !== 'string' || !isAbsolute(checkoutRoot)) {
    throw storeError(
      'DEPENDENCY_STORE_CHECKOUT_INVALID',
      'A canonical checkout path is required'
    );
  }
  const canonical = await realpath(checkoutRoot).catch((cause) => {
    throw storeError(
      'DEPENDENCY_STORE_CHECKOUT_INVALID',
      'The checkout path is missing or unavailable',
      cause
    );
  });
  if (
    canonical !== checkoutRoot ||
    canonical === workspaceRoot ||
    !canonical.startsWith(`${workspaceRoot}${sep}`)
  ) {
    throw storeError(
      'DEPENDENCY_STORE_CHECKOUT_INVALID',
      'The checkout must be a canonical child of the configured workspace'
    );
  }
  const info = await stat(canonical).catch((cause) => {
    throw storeError(
      'DEPENDENCY_STORE_CHECKOUT_INVALID',
      'The checkout path could not be inspected',
      cause
    );
  });
  if (!info.isDirectory() || info.dev !== device) {
    throw storeError(
      'DEPENDENCY_STORE_VOLUME_MISMATCH',
      'The checkout is not on the configured dependency-store volume'
    );
  }
  return canonical;
}

function assertSameFile(native, actual, expected, { identity = false } = {}) {
  if (!native.sameDependencyFile(actual, expected, { identity })) {
    return false;
  }
  return true;
}

async function readObject(
  native,
  root,
  key,
  expectedFingerprint,
  assertObjectPaths,
  runNative
) {
  await assertObjectPaths(key);
  checkKey(key);
  assertFingerprint(expectedFingerprint);
  const version = objectKeyVersion(key, expectedFingerprint);
  if (version === null) {
    throw storeError(
      'DEPENDENCY_STORE_OBJECT_KEY_MISMATCH',
      'The dependency object key does not bind the expected fingerprint'
    );
  }
  const relativePath = objectRelativePath(key);
  const path = join(root, ...relativePath.split('/'));
  const info = await pathExists(path).catch((cause) => {
    throw storeError(
      'DEPENDENCY_STORE_OBJECT_INVALID',
      'A dependency object path could not be inspected',
      cause
    );
  });
  if (!info) {
    throw storeError(
      'DEPENDENCY_STORE_OBJECT_MISSING',
      'The verified dependency object is missing'
    );
  }
  if (
    info.isSymbolicLink() ||
    !info.isFile() ||
    info.uid !== process.getuid() ||
    info.nlink !== 1
  ) {
    throw storeError(
      'DEPENDENCY_STORE_OBJECT_CORRUPT',
      'The dependency object is not an exclusive regular file'
    );
  }
  let actual;
  try {
    actual = await runNative(() =>
      readEligibleFingerprint(native, root, relativePath)
    );
  } catch (cause) {
    throw storeError(
      'DEPENDENCY_STORE_OBJECT_CORRUPT',
      'The dependency object failed native verification',
      cause
    );
  }
  if (!sameStoredObject(native, actual, expectedFingerprint, version)) {
    throw storeError(
      'DEPENDENCY_STORE_OBJECT_CORRUPT',
      'The dependency object does not match its content and metadata key'
    );
  }
  return { fingerprint: actual, key, relativePath };
}

function objectKeyVersion(key, fingerprint) {
  if (objectKeyFor(fingerprint, 2) === key) {
    return 2;
  }
  if (objectKeyFor(fingerprint, 1) === key) {
    return 1;
  }
  return null;
}

function sameStoredObject(native, actual, expected, version) {
  if (actual.device !== expected.device) {
    return false;
  }
  return version === 2
    ? sameDependencyObject(actual, expected)
    : assertSameFile(native, actual, expected);
}

async function readExistingObject(
  native,
  root,
  key,
  expectedFingerprint,
  assertObjectPaths,
  runNative
) {
  await assertObjectPaths(key);
  const relativePath = objectRelativePath(key);
  const path = join(root, ...relativePath.split('/'));
  const info = await pathExists(path).catch((cause) => {
    throw storeError(
      'DEPENDENCY_STORE_OBJECT_INVALID',
      'A dependency object path could not be inspected',
      cause
    );
  });
  if (!info) {
    return null;
  }
  if (info.nlink !== 1 && !info.isSymbolicLink() && info.isFile()) {
    return { pendingPublication: true };
  }
  return readObject(
    native,
    root,
    key,
    expectedFingerprint,
    assertObjectPaths,
    runNative
  );
}

async function inspectLock(path) {
  const info = await pathExists(path).catch((cause) => {
    throw storeError(
      'DEPENDENCY_STORE_LOCK_INVALID',
      'The dependency object publication lock is unreadable',
      cause
    );
  });
  if (!info) {
    return false;
  }
  if (
    info.isSymbolicLink() ||
    !info.isFile() ||
    info.uid !== process.getuid() ||
    !hasExactMode(info.mode, LOCK_FILE_MODE) ||
    info.nlink !== 1
  ) {
    throw storeError(
      'DEPENDENCY_STORE_LOCK_INVALID',
      'The dependency object publication lock is not a private regular file'
    );
  }
  return true;
}

async function acquireLock(
  native,
  root,
  key,
  expectedFingerprint,
  assertObjectPaths,
  assertVolume,
  runNative
) {
  const lockRelative = lockRelativePath(key);
  const lockPath = join(root, ...lockRelative.split('/'));
  const parent = join(root, ...lockRelative.split('/').slice(0, -1));
  const deadline = Date.now() + LOCK_WAIT_MS;
  while (Date.now() < deadline) {
    // Revalidate both the volume and path before each exclusive lock attempt.
    // biome-ignore lint/performance/noAwaitInLoops: Revalidation must immediately precede every lock acquisition attempt.
    await assertObjectPaths(key);
    await assertVolume();
    const token = randomUUID();
    let handle;
    try {
      handle = await open(lockPath, 'wx', LOCK_FILE_MODE);
    } catch (error) {
      if (error.code !== 'EEXIST') {
        throw storeError(
          'DEPENDENCY_STORE_LOCK_CREATE_FAILED',
          'A dependency object publication lock could not be acquired',
          error
        );
      }
      const held = await inspectLock(lockPath);
      if (!held) {
        continue;
      }
      const existing = await readExistingObject(
        native,
        root,
        key,
        expectedFingerprint,
        assertObjectPaths,
        runNative
      );
      if (existing && !existing.pendingPublication) {
        return { existing };
      }
      await new Promise((resolveWait) => setTimeout(resolveWait, LOCK_POLL_MS));
      continue;
    }

    const record = JSON.stringify({ pid: process.pid, token });
    try {
      await handle.writeFile(record, 'utf8');
      await handle.sync();
      const info = await handle.stat();
      if (
        !info.isFile() ||
        info.uid !== process.getuid() ||
        !hasExactMode(info.mode, LOCK_FILE_MODE) ||
        info.nlink !== 1
      ) {
        throw new Error(
          'The new publication lock is not private and exclusive'
        );
      }
      await handle.close();
      await native.syncDependencyDirectory(parent);
      return {
        handle: null,
        info: { dev: info.dev, ino: info.ino },
        lockPath,
        parent,
        record,
      };
    } catch (cause) {
      await handle?.close().catch(() => {
        // Preserve the lock failure outcome when best-effort close also fails.
      });
      throw storeError(
        'DEPENDENCY_STORE_LOCK_UNKNOWN',
        'The dependency object publication lock outcome is uncertain; it was retained',
        cause
      );
    }
  }
  throw storeError(
    'DEPENDENCY_STORE_OBJECT_BUSY',
    'Another dependency object writer has an unresolved publication; retry the same operation after diagnosis'
  );
}

async function releaseLock(native, lock, key, assertObjectPaths, assertVolume) {
  await assertObjectPaths(key);
  await assertVolume();
  const info = await lstat(lock.lockPath).catch((cause) => {
    throw storeError(
      'DEPENDENCY_STORE_LOCK_RELEASE_UNKNOWN',
      'The dependency object publication lock could not be reconciled',
      cause
    );
  });
  const record = await readFile(lock.lockPath, 'utf8').catch((cause) => {
    throw storeError(
      'DEPENDENCY_STORE_LOCK_RELEASE_UNKNOWN',
      'The dependency object publication lock could not be verified',
      cause
    );
  });
  if (
    info.isSymbolicLink() ||
    !info.isFile() ||
    info.uid !== process.getuid() ||
    !hasExactMode(info.mode, LOCK_FILE_MODE) ||
    info.nlink !== 1 ||
    info.dev !== lock.info.dev ||
    info.ino !== lock.info.ino ||
    record !== lock.record
  ) {
    throw storeError(
      'DEPENDENCY_STORE_LOCK_RELEASE_UNKNOWN',
      'The dependency object publication lock changed before release'
    );
  }
  await unlink(lock.lockPath).catch((cause) => {
    throw storeError(
      'DEPENDENCY_STORE_LOCK_RELEASE_UNKNOWN',
      'The dependency object publication lock could not be removed',
      cause
    );
  });
  try {
    await native.syncDependencyDirectory(lock.parent);
  } catch (cause) {
    throw storeError(
      'DEPENDENCY_STORE_LOCK_RELEASE_UNKNOWN',
      'The dependency object publication lock release is not durable',
      cause
    );
  }
}

async function removeStageAfterPublish(
  native,
  root,
  stageRelative,
  stageFingerprint,
  objectPath
) {
  const stagePath = join(root, ...stageRelative.split('/'));
  const [stageInfo, objectInfo] = await Promise.all([
    lstat(stagePath),
    lstat(objectPath),
  ]).catch((cause) => {
    throw storeError(
      'DEPENDENCY_STORE_PUBLISH_UNKNOWN',
      'The staged dependency object could not be reconciled after publication',
      cause
    );
  });
  if (
    stageInfo.isSymbolicLink() ||
    objectInfo.isSymbolicLink() ||
    !stageInfo.isFile() ||
    !objectInfo.isFile() ||
    stageInfo.dev !== objectInfo.dev ||
    stageInfo.ino !== objectInfo.ino ||
    stageInfo.nlink !== 2 ||
    objectInfo.nlink !== 2 ||
    String(stageInfo.dev) !== stageFingerprint.device ||
    String(stageInfo.ino) !== stageFingerprint.inode
  ) {
    throw storeError(
      'DEPENDENCY_STORE_PUBLISH_UNKNOWN',
      'The staged dependency object changed during publication'
    );
  }
  await unlink(stagePath).catch((cause) => {
    throw storeError(
      'DEPENDENCY_STORE_PUBLISH_UNKNOWN',
      'The temporary object alias could not be removed after publication',
      cause
    );
  });
  try {
    await native.syncDependencyDirectory(dirname(objectPath));
  } catch (cause) {
    throw storeError(
      'DEPENDENCY_STORE_PUBLISH_UNKNOWN',
      'The dependency object publication could not be made durable',
      cause
    );
  }
}

async function cleanupUnpublishedStage(
  native,
  root,
  stageRelative,
  expectedFingerprint,
  runNative
) {
  const stagePath = join(root, ...stageRelative.split('/'));
  const info = await pathExists(stagePath).catch((cause) => {
    throw storeError(
      'DEPENDENCY_STORE_STAGE_UNKNOWN',
      'The private dependency object stage could not be reconciled',
      cause
    );
  });
  if (!info) {
    return;
  }
  if (info.isSymbolicLink() || !info.isFile() || info.nlink !== 1) {
    throw storeError(
      'DEPENDENCY_STORE_STAGE_UNKNOWN',
      'The private dependency object stage is not an exclusive regular file'
    );
  }
  let actual;
  try {
    actual = await runNative(() =>
      readEligibleFingerprint(native, root, stageRelative)
    );
  } catch (cause) {
    throw storeError(
      'DEPENDENCY_STORE_STAGE_UNKNOWN',
      'The private dependency object stage could not be verified before cleanup',
      cause
    );
  }
  if (
    !assertSameFile(native, actual, expectedFingerprint, { identity: true })
  ) {
    throw storeError(
      'DEPENDENCY_STORE_STAGE_UNKNOWN',
      'The private dependency object stage changed before cleanup'
    );
  }
  await unlink(stagePath).catch((cause) => {
    throw storeError(
      'DEPENDENCY_STORE_STAGE_UNKNOWN',
      'The private dependency object stage could not be removed',
      cause
    );
  });
  await native.syncDependencyDirectory(dirname(stagePath)).catch((cause) => {
    throw storeError(
      'DEPENDENCY_STORE_STAGE_UNKNOWN',
      'The private dependency object stage cleanup could not be made durable',
      cause
    );
  });
}

async function createStoreDirectories(root, key, device, native, assertVolume) {
  const hoistedRoot = join(root, 'hoisted');
  const runtimeRoot = join(root, 'hoisted', 'darwin-arm64-bun-1.3.14');
  const objectsRoot = join(runtimeRoot, 'objects');
  const shardRoot = join(objectsRoot, key.slice(0, 2));
  await ensurePrivateDirectory(hoistedRoot, device, root, native, assertVolume);
  await ensurePrivateDirectory(
    runtimeRoot,
    device,
    hoistedRoot,
    native,
    assertVolume
  );
  await ensurePrivateDirectory(
    objectsRoot,
    device,
    runtimeRoot,
    native,
    assertVolume
  );
  await ensurePrivateDirectory(
    shardRoot,
    device,
    objectsRoot,
    native,
    assertVolume
  );
  return { runtimeRoot, shardRoot };
}

async function verifyOrNull(
  native,
  root,
  key,
  fingerprint,
  assertObjectPaths,
  runNative
) {
  const existing = await readExistingObject(
    native,
    root,
    key,
    fingerprint,
    assertObjectPaths,
    runNative
  );
  if (existing?.pendingPublication) {
    return null;
  }
  return existing;
}

export async function openDependencyFileStore(sharing, { native } = {}) {
  const volumeIdentity = { ...assertSharingConfiguration(sharing) };
  const canonicalWorkspace = await realpath(sharing.workspaceRoot).catch(
    (cause) => {
      throw storeError(
        'DEPENDENCY_STORE_WORKSPACE_INVALID',
        'The configured workspace root is missing or unavailable',
        cause
      );
    }
  );
  const configuredRoot = resolve(sharing.storeRoot);
  const storeRootInfo = await assertPrivateDirectory(
    configuredRoot,
    undefined,
    'Dependency store root'
  );
  const canonicalStoreRoot = await realpath(configuredRoot);
  const storeRootIdentity = await lstat(configuredRoot, { bigint: true });
  if (canonicalStoreRoot !== configuredRoot) {
    throw storeError(
      'DEPENDENCY_STORE_ROOT_INVALID',
      'The configured dependency store root must be canonical'
    );
  }
  assertOutsideWorkspace(canonicalStoreRoot, canonicalWorkspace);

  const mountPath = resolve(volumeIdentity.mountPath);
  await assertNoSymlinkComponents(
    mountPath,
    'DEPENDENCY_STORE_VOLUME_MISMATCH',
    'The configured dependency-store mount must not be reached through a symlink'
  );
  const canonicalMount = await realpath(mountPath).catch((cause) => {
    throw storeError(
      'DEPENDENCY_STORE_VOLUME_MISMATCH',
      'The configured dependency-store volume is missing or unavailable',
      cause
    );
  });
  const mountInfo = await stat(canonicalMount, { bigint: true }).catch(
    (cause) => {
      throw storeError(
        'DEPENDENCY_STORE_VOLUME_MISMATCH',
        'The configured dependency-store volume is unavailable',
        cause
      );
    }
  );
  if (
    canonicalMount !== volumeIdentity.mountPath ||
    Number(mountInfo.dev) !== volumeIdentity.device ||
    storeRootInfo.dev !== volumeIdentity.device ||
    // macOS firmlinks can put the same inode beneath a different canonical
    // pathname (for example /Users and /System/Volumes/Data/Users).
    storeRootIdentity.dev !== mountInfo.dev
  ) {
    throw storeError(
      'DEPENDENCY_STORE_VOLUME_MISMATCH',
      'The configured dependency store is not on its recorded volume'
    );
  }

  const executable = await verifyRuntime(sharing.executable);
  const root = join(canonicalStoreRoot, ...NAMESPACE.split('/'));
  const storeIdentity = {
    device: String(volumeIdentity.device),
    executable,
    mountPath: canonicalMount,
    namespace: NAMESPACE,
    root: canonicalStoreRoot,
    version: BUN_VERSION,
  };
  let path = canonicalStoreRoot;
  for (const component of NAMESPACE.split('/')) {
    path = join(path, component);
    // Stop at the first absent directory and never inspect descendants through it.
    // biome-ignore lint/performance/noAwaitInLoops: Ordered namespace path validation is a safety invariant.
    const exists = await inspectOptionalPrivatePath(
      path,
      volumeIdentity.device
    );
    if (!exists) {
      break;
    }
  }
  const loadedNative = await loadNative(native);
  const runNative = createWorkLimiter(4);
  let nativeStatus;
  async function refreshNativeStatus() {
    try {
      nativeStatus = await loadedNative.dependencyFileNativeStatus();
    } catch {
      nativeStatus = {
        available: false,
        code: 'DEPENDENCY_FILE_NATIVE_STATUS_UNKNOWN',
        reason: 'The native dependency-file capability could not be checked',
      };
    }
    if (
      !nativeStatus ||
      typeof nativeStatus !== 'object' ||
      typeof nativeStatus.available !== 'boolean'
    ) {
      nativeStatus = {
        available: false,
        code: 'DEPENDENCY_FILE_NATIVE_STATUS_INVALID',
        reason:
          'The native dependency-file capability returned an invalid status',
      };
    }
    return nativeStatus;
  }

  async function assertNativeAvailable() {
    await refreshNativeStatus();
    if (!nativeStatus.available) {
      throw storeError(
        nativeStatus.code ?? 'DEPENDENCY_FILE_NATIVE_UNAVAILABLE',
        'The verified native dependency-file helper is unavailable; no build or fallback was attempted'
      );
    }
  }

  async function assertVolume() {
    const rootInfo = await assertPrivateDirectory(
      canonicalStoreRoot,
      undefined,
      'Dependency store root'
    );
    const currentMount = await realpath(mountPath).catch((cause) => {
      throw storeError(
        'DEPENDENCY_STORE_VOLUME_MISMATCH',
        'The configured dependency-store volume is missing or unavailable',
        cause
      );
    });
    const currentMountInfo = await stat(currentMount).catch((cause) => {
      throw storeError(
        'DEPENDENCY_STORE_VOLUME_MISMATCH',
        'The configured dependency-store volume is unavailable',
        cause
      );
    });
    const currentMountIdentity = await stat(currentMount, {
      bigint: true,
    }).catch((cause) => {
      throw storeError(
        'DEPENDENCY_STORE_VOLUME_MISMATCH',
        'The configured dependency-store volume is unavailable',
        cause
      );
    });
    const currentRootIdentity = await lstat(canonicalStoreRoot, {
      bigint: true,
    }).catch((cause) => {
      throw storeError(
        'DEPENDENCY_STORE_ROOT_INVALID',
        'The configured dependency store root is unavailable',
        cause
      );
    });
    if (
      currentMount !== canonicalMount ||
      currentMountInfo.dev !== volumeIdentity.device ||
      currentMountIdentity.dev !== mountInfo.dev ||
      currentMountIdentity.ino !== mountInfo.ino ||
      currentMountIdentity.birthtimeNs !== mountInfo.birthtimeNs ||
      rootInfo.dev !== volumeIdentity.device ||
      currentRootIdentity.dev !== storeRootIdentity.dev ||
      currentRootIdentity.ino !== storeRootIdentity.ino ||
      currentRootIdentity.birthtimeNs !== storeRootIdentity.birthtimeNs ||
      currentRootIdentity.dev !== currentMountIdentity.dev
    ) {
      throw storeError(
        'DEPENDENCY_STORE_VOLUME_MISMATCH',
        'The configured dependency store is no longer on its recorded volume'
      );
    }
  }

  async function assertObjectPaths(key, { allowMissing = true } = {}) {
    checkKey(key);
    await assertVolume();
    let current = canonicalStoreRoot;
    for (const component of [
      'hoisted',
      'darwin-arm64-bun-1.3.14',
      'objects',
      key.slice(0, 2),
    ]) {
      current = join(current, component);
      try {
        // Verify each parent before continuing into the next directory.
        // biome-ignore lint/performance/noAwaitInLoops: Ordered no-symlink path validation prevents traversal.
        await assertPrivateDirectory(
          current,
          volumeIdentity.device,
          'Hoisted namespace directories'
        );
      } catch (error) {
        if (allowMissing && isMissing(error)) {
          return false;
        }
        throw error;
      }
    }
    return true;
  }

  async function assertTargetCheckout(checkoutRoot) {
    await assertVolume();
    const checkout = await assertCheckout(
      checkoutRoot,
      canonicalWorkspace,
      volumeIdentity.device
    );
    const withinStore =
      checkout === canonicalStoreRoot ||
      checkout.startsWith(`${canonicalStoreRoot}${sep}`);
    if (withinStore) {
      throw storeError(
        'DEPENDENCY_STORE_CHECKOUT_INVALID',
        'The checkout cannot be inside the dependency store'
      );
    }
    return checkout;
  }

  // This path deliberately keeps source verification, staged clone validation,
  // durable publication, and uncertain-outcome retention in strict order.
  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Splitting this durability protocol risks separating its verified checkpoints.
  async function ensure(fingerprint, checkoutRoot, { version = 2 } = {}) {
    await assertNativeAvailable();
    assertFingerprint(fingerprint);
    const expectedFingerprint = snapshotFingerprint(fingerprint);
    const key = objectKeyFor(expectedFingerprint, version);
    const checkout = await assertTargetCheckout(checkoutRoot);
    let source;
    try {
      source = await runNative(() =>
        readEligibleFingerprint(
          loadedNative,
          checkout,
          expectedFingerprint.relativePath
        )
      );
    } catch (cause) {
      throw storeError(
        'DEPENDENCY_STORE_SOURCE_CHANGED',
        'The planned source dependency file could not be revalidated',
        cause
      );
    }
    if (
      !assertSameFile(loadedNative, source, expectedFingerprint, {
        identity: true,
      })
    ) {
      throw storeError(
        'DEPENDENCY_STORE_SOURCE_CHANGED',
        'The source dependency file changed after its review snapshot'
      );
    }

    const { shardRoot } = await createStoreDirectories(
      canonicalStoreRoot,
      key,
      volumeIdentity.device,
      loadedNative,
      assertVolume
    );
    await assertObjectPaths(key);
    const existing = await verifyOrNull(
      loadedNative,
      root,
      key,
      expectedFingerprint,
      assertObjectPaths,
      runNative
    );
    if (existing) {
      return existing;
    }

    const lock = await acquireLock(
      loadedNative,
      root,
      key,
      expectedFingerprint,
      assertObjectPaths,
      assertVolume,
      runNative
    );
    if (lock.existing) {
      return lock.existing;
    }
    let operationError;
    let retainLock = false;
    let result;
    try {
      const afterLock = await verifyOrNull(
        loadedNative,
        root,
        key,
        expectedFingerprint,
        assertObjectPaths,
        runNative
      );
      if (afterLock) {
        result = afterLock;
      } else {
        const id = randomUUID();
        const temporaryRelativePath = stageRelativePath(key, id);
        const temporaryPath = join(root, ...temporaryRelativePath.split('/'));
        await assertVolume();
        let stagedFingerprint;
        try {
          stagedFingerprint = await runNative(() =>
            loadedNative.cloneDependencyFile(
              checkout,
              expectedFingerprint.relativePath,
              root,
              temporaryRelativePath,
              expectedFingerprint
            )
          );
        } catch (cause) {
          throw storeError(
            'DEPENDENCY_STORE_STAGE_FAILED',
            'The dependency object could not be strictly cloned into its private stage',
            cause
          );
        }
        assertFingerprint(stagedFingerprint);
        if (
          !assertSameFile(loadedNative, stagedFingerprint, expectedFingerprint)
        ) {
          throw storeError(
            'DEPENDENCY_STORE_STAGE_CORRUPT',
            'The staged dependency object does not match its content and metadata key'
          );
        }
        const stagedCheck = await runNative(() =>
          readEligibleFingerprint(loadedNative, root, temporaryRelativePath)
        );
        if (
          !assertSameFile(loadedNative, stagedCheck, stagedFingerprint, {
            identity: true,
          })
        ) {
          throw storeError(
            'DEPENDENCY_STORE_STAGE_CORRUPT',
            'The private staged dependency object changed before publication'
          );
        }
        const sourceAfterClone = await runNative(() =>
          readEligibleFingerprint(
            loadedNative,
            checkout,
            expectedFingerprint.relativePath
          )
        );
        if (
          !assertSameFile(loadedNative, sourceAfterClone, expectedFingerprint, {
            identity: true,
          })
        ) {
          throw storeError(
            'DEPENDENCY_STORE_SOURCE_CHANGED',
            'The source dependency file changed while its object was being cloned'
          );
        }

        await syncExactFile(temporaryPath, stagedFingerprint);
        await loadedNative.syncDependencyDirectory(shardRoot);
        await assertVolume();
        const relativePath = objectRelativePath(key);
        const objectPath = join(root, ...relativePath.split('/'));
        try {
          await link(temporaryPath, objectPath);
        } catch (cause) {
          if (cause.code !== 'EEXIST') {
            throw storeError(
              'DEPENDENCY_STORE_PUBLISH_FAILED',
              'The immutable dependency object could not be published without replacement',
              cause
            );
          }
          const winner = await readObject(
            loadedNative,
            root,
            key,
            expectedFingerprint,
            assertObjectPaths,
            runNative
          );
          await cleanupUnpublishedStage(
            loadedNative,
            root,
            temporaryRelativePath,
            stagedCheck,
            runNative
          );
          result = winner;
        }

        if (!result) {
          retainLock = true;
          try {
            await loadedNative.syncDependencyDirectory(shardRoot);
            await removeStageAfterPublish(
              loadedNative,
              root,
              temporaryRelativePath,
              stagedCheck,
              objectPath
            );
            result = await readObject(
              loadedNative,
              root,
              key,
              expectedFingerprint,
              assertObjectPaths,
              runNative
            );
            retainLock = false;
          } catch (cause) {
            throw storeError(
              'DEPENDENCY_STORE_PUBLISH_UNKNOWN',
              'The immutable dependency object publication is uncertain; its entries and lock were retained',
              cause
            );
          }
        }
      }
    } catch (error) {
      operationError = error;
    }

    if (!retainLock) {
      try {
        await releaseLock(
          loadedNative,
          lock,
          key,
          assertObjectPaths,
          assertVolume
        );
      } catch (cause) {
        throw storeError(
          'DEPENDENCY_STORE_OPERATION_UNKNOWN',
          'The dependency object operation finished with an uncertain lock release',
          operationError
            ? new AggregateError(
                [operationError, cause],
                'Dependency object operation and lock release both failed'
              )
            : cause
        );
      }
    }
    if (operationError) {
      throw operationError;
    }
    return result;
  }

  async function stage(
    key,
    checkoutRoot,
    temporaryRelativePath,
    expectedFingerprint
  ) {
    await assertNativeAvailable();
    checkKey(key);
    assertFingerprint(expectedFingerprint);
    const expected = snapshotFingerprint(expectedFingerprint);
    const version = objectKeyVersion(key, expected);
    if (version === null) {
      throw storeError(
        'DEPENDENCY_STORE_OBJECT_KEY_MISMATCH',
        'The stage request does not match its expected object key'
      );
    }
    assertRelativePath(temporaryRelativePath);
    const checkout = await assertTargetCheckout(checkoutRoot);
    const object = await readObject(
      loadedNative,
      root,
      key,
      expected,
      assertObjectPaths,
      runNative
    );
    let staged;
    try {
      await assertVolume();
      staged = await runNative(() =>
        loadedNative.cloneDependencyFile(
          root,
          objectRelativePath(key),
          checkout,
          temporaryRelativePath,
          object.fingerprint
        )
      );
      assertFingerprint(staged);
      if (
        !sameStoredObject(loadedNative, staged, object.fingerprint, version)
      ) {
        throw storeError(
          'DEPENDENCY_STORE_STAGE_CORRUPT',
          'The staged checkout file does not match the verified object'
        );
      }
      await syncExactFile(
        join(checkout, ...temporaryRelativePath.split('/')),
        staged
      );
      await runNative(() =>
        loadedNative.restoreDependencyTimes(checkout, temporaryRelativePath, {
          atimeNs: expected.atimeNs,
          mtimeNs: expected.mtimeNs,
        })
      );
      const stagedCheck = await runNative(() =>
        readEligibleFingerprint(loadedNative, checkout, temporaryRelativePath)
      );
      await assertVolume();
      if (
        stagedCheck.device !== expected.device ||
        stagedCheck.inode !== staged.inode ||
        !assertSameFile(loadedNative, stagedCheck, expected)
      ) {
        throw storeError(
          'DEPENDENCY_STORE_STAGE_CORRUPT',
          'The staged checkout file changed during verification'
        );
      }
      const parentPath = join(
        checkout,
        ...temporaryRelativePath.split('/').slice(0, -1)
      );
      await loadedNative.syncDependencyDirectory(parentPath);
      return stagedCheck;
    } catch (cause) {
      if (cause.code?.startsWith('DEPENDENCY_STORE_')) {
        throw cause;
      }
      throw storeError(
        'DEPENDENCY_STORE_STAGE_FAILED',
        'A verified store object could not be strictly cloned beside the checkout target',
        cause
      );
    }
  }

  async function verify(key, fingerprint) {
    await assertNativeAvailable();
    checkKey(key);
    assertFingerprint(fingerprint);
    const expected = snapshotFingerprint(fingerprint);
    await readObject(
      loadedNative,
      root,
      key,
      expected,
      assertObjectPaths,
      runNative
    );
    return true;
  }

  async function describe() {
    await refreshNativeStatus();
    await assertVolume();
    let namespaceAvailable = true;
    let current = canonicalStoreRoot;
    for (const component of NAMESPACE.split('/')) {
      current = join(current, component);
      try {
        // Verify each parent before continuing into the next directory.
        // biome-ignore lint/performance/noAwaitInLoops: Ordered no-symlink path validation prevents traversal.
        await assertPrivateDirectory(
          current,
          volumeIdentity.device,
          'Hoisted namespace directories'
        );
      } catch (error) {
        if (isMissing(error)) {
          namespaceAvailable = false;
          break;
        }
        throw error;
      }
    }
    return {
      available: nativeStatus.available,
      identity: { ...storeIdentity },
      namespace: NAMESPACE,
      namespaceAvailable,
      native: {
        available: nativeStatus.available,
        ...(nativeStatus.code ? { code: nativeStatus.code } : {}),
        ...(nativeStatus.reason ? { reason: nativeStatus.reason } : {}),
      },
      physicalSavingsBytes: null,
      root,
      volumeDeltaAvailableBytes: null,
    };
  }

  return {
    describe,
    ensure,
    identity: storeIdentity,
    namespace: NAMESPACE,
    objectKey: (fingerprint, version = 2) => objectKeyFor(fingerprint, version),
    root,
    stage,
    verify,
  };
}
