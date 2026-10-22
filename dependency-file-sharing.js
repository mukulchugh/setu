// Orchestration for reviewed, file-level hoisted dependency sharing. The
// native exchange is deliberately delegated to dependency-file-native.js;
// JavaScript never emulates an atomic swap with rename/unlink sequences.

import { createHash, randomUUID } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import {
  lstat,
  open,
  readdir,
  readFile,
  realpath,
  stat,
} from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { inspectCheckoutIdentity } from './checkout-identity.js';
import {
  dependencyObjectKey,
  sameDependencyObject,
} from './dependency-file-object.js';

const SHA256 = /^[a-f0-9]{64}$/;
const TARGET_PART = /^[^/\\\s:]+$/;
const DECIMAL = /^\d+$/;
const ERROR_CODE = /^[A-Z][A-Z0-9_]{1,63}$/;
const MAX_SCAN_ENTRIES = 1_000_000;
const MAX_SCAN_MS = 15 * 60_000;
const NATIVE_READ_CONCURRENCY = 8;
const PLAN_FILE_BATCH_SIZE = 32;
const EMPTY = Object.freeze({});

function object(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function canonicalJson(value) {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(',')}]`;
  }
  if (object(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function digestOf(value) {
  return sha256(canonicalJson(value));
}

function cloneJson(value) {
  return JSON.parse(canonicalJson(value));
}

function withoutAccessTimes(value) {
  if (Array.isArray(value)) {
    return value.map(withoutAccessTimes);
  }
  if (object(value)) {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([key]) => key !== 'atimeNs')
        .map(([key, child]) => [key, withoutAccessTimes(child)])
    );
  }
  return value;
}

function deepFreeze(value) {
  if (object(value) || Array.isArray(value)) {
    for (const child of Object.values(value)) {
      deepFreeze(child);
    }
    Object.freeze(value);
  }
  return value;
}

function validTarget(target) {
  return (
    object(target) &&
    typeof target.repo === 'string' &&
    TARGET_PART.test(target.repo) &&
    !['.', '..'].includes(target.repo) &&
    typeof target.name === 'string' &&
    target.name
      .split('/')
      .every((part) => TARGET_PART.test(part) && !['.', '..'].includes(part)) &&
    typeof target.wtDir === 'string' &&
    isAbsolute(target.wtDir) &&
    object(target.checkoutIdentity) &&
    target.checkoutIdentity.known === true
  );
}

function pathlessCheckoutIdentity(identity) {
  if (
    !object(identity) ||
    identity.known !== true ||
    !object(identity.checkout) ||
    !object(identity.repository) ||
    !object(identity.admin)
  ) {
    return null;
  }
  const evidence = (value) => {
    const { birthtimeNs, dev, ino } = value;
    if (
      ![birthtimeNs, dev, ino].every(
        (part) => typeof part === 'string' && DECIMAL.test(part)
      )
    ) {
      return null;
    }
    return { birthtimeNs, dev, ino };
  };
  const checkout = evidence(identity.checkout);
  const repository = evidence(identity.repository);
  const admin = evidence(identity.admin);
  return checkout && repository && admin
    ? { admin, checkout, known: true, repository }
    : null;
}

function pathUnder(root, candidate) {
  const rel = relative(root, candidate);
  return (
    rel !== '' &&
    rel !== '..' &&
    !rel.startsWith(`..${sep}`) &&
    !isAbsolute(rel)
  );
}

function safeRelative(value) {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    !value.includes('\0') &&
    !value.startsWith('/') &&
    value.split('/').every((part) => part && part !== '.' && part !== '..') &&
    !value.split('/').includes('.git')
  );
}

function sanitizedCode(value, fallback = 'DEPENDENCY_FILE_OPERATION_FAILED') {
  return typeof value === 'string' && ERROR_CODE.test(value) ? value : fallback;
}

function failure(code, error, extra = EMPTY) {
  return { ...extra, code, error, ok: false };
}

function publicError(error, fallback = 'DEPENDENCY_FILE_OPERATION_FAILED') {
  const code = sanitizedCode(error?.code, fallback);
  const safeMessage =
    {
      CHECKOUT_CHANGED:
        'The checkout identity changed; review the target again.',
      CONFIRMATION_REQUIRED:
        'Confirm the exact reviewed plan before applying it.',
      DEPENDENCY_FILE_CONFLICT:
        'A dependency file changed during the operation; both entries were retained.',
      DEPENDENCY_FILE_DEPENDENCIES_PENDING:
        'A required dependency-file module is not available in this checkout yet.',
      DEPENDENCY_FILE_NATIVE_UNAVAILABLE:
        'The Setu dependency-file native helper is unavailable; no file was exchanged.',
      DEPENDENCY_FILE_OPERATION_UNKNOWN:
        'The operation outcome is unknown; inspect and recover the same operation identity.',
      DEPENDENCY_FILE_PLAN_CHANGED:
        'The reviewed plan no longer matches the target, inputs, or store.',
      DEPENDENCY_FILE_RELEASE_DRIFT:
        'A retained original or installed target changed; no backup was removed.',
      DEPENDENCY_FILE_SCAN_INCOMPLETE:
        'The dependency file scan was incomplete; no plan was saved.',
      DEPENDENCY_FILE_STORE_CHANGED:
        'The configured dependency store identity changed; no new store was selected.',
      DEPENDENCY_FILE_TARGET_BUSY:
        'The checkout could not be confirmed mutable for this operation.',
      DEPENDENCY_FILE_TARGET_INPUTS_CHANGED:
        'The dependency inputs changed; prepare a new review.',
      DEPENDENCY_FILE_TARGET_INVALID:
        'A trusted registered checkout identity is required.',
      DEPENDENCY_FILE_TARGET_PATH_INVALID:
        'A dependency path was outside the reviewed checkout.',
    }[code] ?? 'The dependency-file operation could not be completed safely.';
  const identities = {};
  for (const key of ['planId', 'operationId', 'releaseId']) {
    if (typeof error?.[key] === 'string' && SHA256.test(error[key])) {
      identities[key] = error[key];
    }
  }
  return failure(code, safeMessage, identities);
}

function sameJson(left, right) {
  return canonicalJson(left) === canonicalJson(right);
}

function planDigest(plan) {
  const { createdAt: _createdAt, id: _id, ...body } = plan;
  return digestOf(withoutAccessTimes(body));
}

function stablePlanComparison(plan) {
  const { createdAt: _createdAt, id: _id, ...body } = plan;
  return withoutAccessTimes(body);
}

function releaseDigest(plan) {
  const { createdAt: _createdAt, id: _id, ...body } = plan;
  return digestOf(withoutAccessTimes(body));
}

function deterministicStagePath(
  target,
  inputDigest,
  relativePath,
  fingerprint,
  objectKey
) {
  const stableIdentity = {
    checkoutIdentity: withoutAccessTimes(target.checkoutIdentity),
    inputDigest,
    name: target.name,
    objectKey,
    relativePath,
    repo: target.repo,
    sourceIdentity: fingerprint.identityHash,
  };
  const token = digestOf(stableIdentity).slice(0, 32);
  const parent = dirname(relativePath).split(sep).join('/');
  const leaf = `.setu-dependency-${token}.stage`;
  return parent === '.' ? leaf : `${parent}/${leaf}`;
}

function existingPlanValid(plan, requestedId) {
  return (
    object(plan) &&
    [1, 2].includes(plan.version) &&
    plan.mode === 'hoisted-cow' &&
    typeof plan.id === 'string' &&
    SHA256.test(plan.id) &&
    plan.id === requestedId &&
    planDigest(plan) === plan.id &&
    Array.isArray(plan.files) &&
    Array.isArray(plan.skipped)
  );
}

function sameFile(native, left, right, identity = false) {
  return native.sameDependencyFile(left, right, { identity });
}

// A same-directory rename can update ctime on APFS. The inode and all stable
// file metadata still identify the displaced entry; ctime remains in the
// native identity hash and is used for pre-swap checks, but is excluded only
// when reconciling entries after the reviewed exchange.
function sameAfterExchangeIdentity(left, right) {
  return (
    object(left) &&
    object(right) &&
    [
      'device',
      'inode',
      'size',
      'mode',
      'uid',
      'gid',
      'mtimeNs',
      'contentHash',
      'metadataHash',
    ].every((key) => left[key] === right[key]) &&
    sameJson(left.attributes, right.attributes)
  );
}

function checkpointPayload(record) {
  return {
    phase: record.phase,
    ...(record.relativePath ? { relativePath: record.relativePath } : {}),
    ...(record.relativePath ? { relativePath: record.relativePath } : {}),
    ...(record.temporaryRelativePath
      ? { temporaryRelativePath: record.temporaryRelativePath }
      : {}),
    ...(record.originalFingerprint
      ? { originalFingerprint: record.originalFingerprint }
      : {}),
    ...(record.stagedFingerprint
      ? { stagedFingerprint: record.stagedFingerprint }
      : {}),
    ...(record.retainedFingerprint
      ? { retainedFingerprint: record.retainedFingerprint }
      : {}),
    ...(typeof record.releasePlanId === 'string'
      ? { releasePlanId: record.releasePlanId }
      : {}),
  };
}

function operationState(operations) {
  if (operations.some((row) => ['unknown', 'conflict'].includes(row.state))) {
    return 'attention-required';
  }
  if (
    operations.some((row) =>
      ['prepared', 'running', 'partial'].includes(row.state)
    )
  ) {
    return 'in-progress';
  }
  if (operations.some((row) => row.state === 'completed')) {
    return 'completed';
  }
  if (operations.some((row) => row.state === 'released')) {
    return 'released';
  }
  return 'unshared';
}

function listedOperations(listed) {
  if (Array.isArray(listed)) {
    return listed;
  }
  return Array.isArray(listed?.operations) ? listed.operations : [];
}

function comparePaths(left, right) {
  if (left < right) {
    return -1;
  }
  if (left > right) {
    return 1;
  }
  return 0;
}

function isVerifiedResult(result) {
  return result === true || result?.ok === true || result?.verified === true;
}

function assertEffect(result, code, key) {
  if (
    result === false ||
    result?.ok === false ||
    (key && result?.[key] === false)
  ) {
    throw currentError(code, 'native file operation was refused');
  }
}

function safeFileReason(reason) {
  return typeof reason === 'string' && reason.length <= 160
    ? reason.replace(/[\r\n\0]/g, ' ').trim() || 'not eligible'
    : 'not eligible';
}

async function statIdentity(path) {
  const info = await lstat(path, { bigint: true });
  if (info.isSymbolicLink() || !info.isDirectory()) {
    throw currentError(
      'DEPENDENCY_FILE_TARGET_PATH_INVALID',
      'exchange parent is not a stable directory'
    );
  }
  return {
    device: String(info.dev),
    inode: String(info.ino),
  };
}

async function exactCurrentIdentity(target) {
  const current = await inspectCheckoutIdentity(target, {
    readFile,
    realpath,
    stat,
  });
  const expected = pathlessCheckoutIdentity(target.checkoutIdentity);
  const observed = pathlessCheckoutIdentity(current);
  if (
    !(
      expected &&
      observed &&
      sameJson(expected, observed) &&
      current.checkoutPath === target.checkoutIdentity.checkoutPath &&
      current.repositoryPath === target.checkoutIdentity.repositoryPath &&
      current.adminPath === target.checkoutIdentity.adminPath
    )
  ) {
    throw Object.assign(new Error('checkout changed'), {
      code: 'CHECKOUT_CHANGED',
    });
  }
  // The journal and catalog bind the complete server-observed identity, including
  // canonical checkout/repository/admin paths, as well as the filesystem tuples.
  return current;
}

function rootRelativePath(checkout, root) {
  if (typeof root !== 'string' || !root) {
    throw Object.assign(new Error('invalid dependency root'), {
      code: 'DEPENDENCY_FILE_TARGET_PATH_INVALID',
    });
  }
  const absolute = isAbsolute(root) ? resolve(root) : resolve(checkout, root);
  if (!pathUnder(checkout, absolute)) {
    throw Object.assign(new Error('root outside checkout'), {
      code: 'DEPENDENCY_FILE_TARGET_PATH_INVALID',
    });
  }
  const rel = relative(checkout, absolute).split(sep).join('/');
  if (!safeRelative(rel)) {
    throw Object.assign(new Error('invalid dependency root'), {
      code: 'DEPENDENCY_FILE_TARGET_PATH_INVALID',
    });
  }
  return rel;
}

async function assertNoSymlinkAncestors(checkout, relativePath) {
  if (!safeRelative(relativePath)) {
    throw Object.assign(new Error('unsafe relative path'), {
      code: 'DEPENDENCY_FILE_TARGET_PATH_INVALID',
    });
  }
  let current = checkout;
  const parts = relativePath.split('/');
  for (const part of parts.slice(0, -1)) {
    current = join(current, part);
    // biome-ignore lint/performance/noAwaitInLoops: Each ancestor is checked before resolving the next path component.
    const info = await lstat(current, { bigint: true });
    if (info.isSymbolicLink() || !info.isDirectory()) {
      throw Object.assign(new Error('unsafe ancestor'), {
        code: 'DEPENDENCY_FILE_TARGET_PATH_INVALID',
      });
    }
  }
}

async function scanRoots(checkout, roots, native, now) {
  if (!Array.isArray(roots) || roots.some((root) => typeof root !== 'string')) {
    throw Object.assign(new Error('invalid dependency roots'), {
      code: 'DEPENDENCY_FILE_INPUT_INVALID',
    });
  }
  const startedAt = now();
  let visited = 0;
  const files = new Map();
  const skipped = new Map();
  const candidates = [];
  const normalizedRoots = [];
  for (const root of roots) {
    normalizedRoots.push(rootRelativePath(checkout, root));
  }
  normalizedRoots.sort();
  const rootsUnique = [];
  for (const root of [...new Set(normalizedRoots)]) {
    if (!rootsUnique.some((parent) => root.startsWith(`${parent}/`))) {
      rootsUnique.push(root);
    }
  }

  async function visit(relativePath) {
    visited += 1;
    if (visited > MAX_SCAN_ENTRIES || now() - startedAt > MAX_SCAN_MS) {
      throw Object.assign(new Error('scan incomplete'), {
        code: 'DEPENDENCY_FILE_SCAN_INCOMPLETE',
      });
    }
    await assertNoSymlinkAncestors(checkout, relativePath);
    const absolute = join(checkout, ...relativePath.split('/'));
    let info;
    try {
      info = await lstat(absolute, { bigint: true });
    } catch (error) {
      if (error.code === 'ENOENT') {
        return;
      }
      throw error;
    }
    if (info.isSymbolicLink()) {
      skipped.set(relativePath, 'symbolic link');
      return;
    }
    if (info.isDirectory()) {
      const names = (await readdir(absolute)).sort();
      for (const name of names) {
        // biome-ignore lint/performance/noAwaitInLoops: Each child is walked after its parent checks complete, in stable order.
        await visit(`${relativePath}/${name}`);
      }
      return;
    }
    if (!info.isFile()) {
      skipped.set(relativePath, 'not a regular file');
      return;
    }
    candidates.push(relativePath);
  }

  for (const root of rootsUnique) {
    // biome-ignore lint/performance/noAwaitInLoops: Roots are deduplicated, then walked in deterministic order.
    await visit(root);
  }
  let nextCandidate = 0;
  async function readCandidates() {
    while (nextCandidate < candidates.length) {
      const relativePath = candidates[nextCandidate];
      nextCandidate += 1;
      // biome-ignore lint/performance/noAwaitInLoops: Each bounded worker reads one file at a time to cap native probes at eight.
      const result = await native.readDependencyFile(checkout, relativePath);
      if (result?.eligible && object(result.fingerprint)) {
        files.set(relativePath, result.fingerprint);
      } else {
        skipped.set(relativePath, safeFileReason(result?.reason));
      }
    }
  }
  await Promise.all(
    Array.from(
      { length: Math.min(NATIVE_READ_CONCURRENCY, candidates.length) },
      () => readCandidates()
    )
  );
  const sortedFiles = [...files.entries()].sort(([left], [right]) =>
    comparePaths(left, right)
  );
  const sortedSkipped = [...skipped.entries()].sort(([left], [right]) =>
    comparePaths(left, right)
  );
  return {
    files: sortedFiles.map(([relativePath, fingerprint]) => ({
      fingerprint,
      relativePath,
    })),
    skipped: sortedSkipped.map(([relativePath, reason]) => ({
      reason,
      relativePath,
    })),
  };
}

function validFingerprint(fingerprint, relativePath) {
  return (
    object(fingerprint) &&
    (relativePath === undefined || fingerprint.relativePath === relativePath) &&
    Number.isSafeInteger(fingerprint.size) &&
    fingerprint.size >= 0 &&
    ['mode', 'uid', 'gid'].every((key) =>
      Number.isSafeInteger(fingerprint[key])
    ) &&
    ['device', 'inode', 'mtimeNs', 'ctimeNs', 'atimeNs'].every(
      (key) =>
        typeof fingerprint[key] === 'string' && DECIMAL.test(fingerprint[key])
    ) &&
    ['contentHash', 'metadataHash', 'identityHash'].every(
      (key) =>
        typeof fingerprint[key] === 'string' && SHA256.test(fingerprint[key])
    ) &&
    Array.isArray(fingerprint.attributes) &&
    fingerprint.attributes.every(
      (attribute) =>
        object(attribute) &&
        typeof attribute.name === 'string' &&
        typeof attribute.digest === 'string' &&
        SHA256.test(attribute.digest)
    )
  );
}

function sameCanonicalObject(native, version, expected, actual) {
  if (version === 2) {
    return sameDependencyObject(expected, actual);
  }
  // Version 1 keys include metadataHash, which includes mtime. Keep the
  // legacy full metadata comparison for saved plans and their stored objects.
  return native.sameDependencyFile(expected, actual);
}

function validObjectKeyForPlan(file, version) {
  try {
    return file.objectKey === dependencyObjectKey(file.fingerprint, version);
  } catch {
    return false;
  }
}

function validObjectFingerprint(fingerprint, objectKey) {
  return (
    validFingerprint(fingerprint) &&
    fingerprint.relativePath === `objects/${objectKey.slice(0, 2)}/${objectKey}`
  );
}

async function syncStableFileAndParent(absolutePath, native) {
  const handle = await open(
    absolutePath,
    // biome-ignore lint/suspicious/noBitwiseOperators: open(2) combines O_RDONLY with O_NOFOLLOW as a flag mask.
    fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW
  );
  try {
    const descriptorInfo = await handle.stat({ bigint: true });
    const pathInfo = await lstat(absolutePath, { bigint: true });
    if (
      !descriptorInfo.isFile() ||
      pathInfo.isSymbolicLink() ||
      !pathInfo.isFile() ||
      descriptorInfo.dev !== pathInfo.dev ||
      descriptorInfo.ino !== pathInfo.ino
    ) {
      throw currentError(
        'DEPENDENCY_FILE_SYNC_FAILED',
        'file identity changed before sync'
      );
    }
    await handle.sync();
    const afterInfo = await lstat(absolutePath, { bigint: true });
    if (
      afterInfo.isSymbolicLink() ||
      afterInfo.dev !== descriptorInfo.dev ||
      afterInfo.ino !== descriptorInfo.ino
    ) {
      throw currentError(
        'DEPENDENCY_FILE_SYNC_FAILED',
        'file identity changed during sync'
      );
    }
  } finally {
    await handle.close();
  }
  assertEffect(
    await native.syncDependencyDirectory(dirname(absolutePath)),
    'DEPENDENCY_FILE_SYNC_FAILED',
    'synced'
  );
}

function validStore(store) {
  return (
    object(store) &&
    typeof store.root === 'string' &&
    isAbsolute(store.root) &&
    object(store.identity) &&
    ['objectKey', 'ensure', 'stage', 'verify', 'describe'].every(
      (key) => typeof store[key] === 'function'
    )
  );
}

function validJournal(journal) {
  return (
    object(journal) &&
    [
      'savePlan',
      'getPlan',
      'begin',
      'getOperation',
      'checkpoint',
      'checkpoints',
      'finish',
      'list',
      'saveReleasePlan',
      'getReleasePlan',
      'setView',
    ].every((key) => typeof journal[key] === 'function')
  );
}

function validNative(native) {
  return (
    object(native) &&
    [
      'readDependencyFile',
      'sameDependencyFile',
      'exchangeDependencyFiles',
      'syncDependencyDirectory',
      'removeDependencyBackup',
      'dependencyFileNativeStatus',
      'restoreDependencyTimes',
    ].every((key) => typeof native[key] === 'function')
  );
}

function currentError(code, message, cause) {
  return Object.assign(new Error(message, { cause }), { code });
}

export function createDependencyFileSharing({
  state,
  sharing,
  native: injectedNative,
  store: injectedStore,
  journal: injectedJournal,
  inputs: injectedInputs,
  now = Date.now,
  randomId = randomUUID,
  assertMutable,
} = {}) {
  let dependenciesPromise;
  const targetLocks = new Map();

  function dependencies() {
    // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Dependency loading validates four independently optional real factories; keeping these fail-closed guards adjacent makes partial wiring visible.
    dependenciesPromise ??= (async () => {
      let native = injectedNative;
      if (!native) {
        native = await import('./dependency-file-native.js');
      }
      if (!validNative(native)) {
        throw currentError(
          'DEPENDENCY_FILE_DEPENDENCIES_PENDING',
          'native dependency-file interface unavailable'
        );
      }
      let store = injectedStore;
      if (!store) {
        const { openDependencyFileStore } = await import(
          './dependency-file-store.js'
        );
        store = await openDependencyFileStore(sharing, { native });
      }
      if (!validStore(store)) {
        throw currentError(
          'DEPENDENCY_FILE_DEPENDENCIES_PENDING',
          'dependency store interface unavailable'
        );
      }
      let journal = injectedJournal;
      if (!journal) {
        const { createDependencyFileJournal } = await import(
          './dependency-file-journal.js'
        );
        const { identity } = store;
        if (!object(identity) || typeof identity.root !== 'string') {
          throw currentError(
            'DEPENDENCY_FILE_STORE_CHANGED',
            'central configured store identity is unavailable'
          );
        }
        journal = createDependencyFileJournal({
          now,
          randomId,
          state,
          storeRoot: identity.root,
        });
      }
      if (!validJournal(journal)) {
        throw currentError(
          'DEPENDENCY_FILE_DEPENDENCIES_PENDING',
          'dependency journal interface unavailable'
        );
      }
      let inputs = injectedInputs;
      if (!inputs) {
        ({ dependencyFileInputs: inputs } = await import(
          './dependency-file-inputs.js'
        ));
      }
      if (typeof inputs !== 'function') {
        throw currentError(
          'DEPENDENCY_FILE_DEPENDENCIES_PENDING',
          'dependency input interface unavailable'
        );
      }
      return { inputs, journal, native, store };
    })();
    return dependenciesPromise;
  }

  async function withLocalTargetLock(target, work) {
    requireTarget(target);
    const key = `${target.repo}/${target.name}`;
    const previous = targetLocks.get(key) ?? Promise.resolve();
    let unlockTarget;
    const pendingLock = new Promise((resolveLock) => {
      unlockTarget = resolveLock;
    });
    const tail = previous.then(() => pendingLock);
    targetLocks.set(key, tail);
    await previous;
    try {
      return await work();
    } finally {
      unlockTarget();
      if (targetLocks.get(key) === tail) {
        targetLocks.delete(key);
      }
    }
  }

  async function withServiceTargetLock(target, work) {
    requireTarget(target);
    if (typeof state?.withTargets !== 'function') {
      throw currentError(
        'DEPENDENCY_FILE_TARGET_LOCK_REQUIRED',
        'workspace target lock unavailable'
      );
    }
    const deps = await dependencies();
    const lease = deps.native.withDependencyFileLease;
    if (typeof lease !== 'function' && !injectedNative) {
      throw currentError(
        'DEPENDENCY_FILE_LEASE_REQUIRED',
        'native checkout lease interface unavailable'
      );
    }
    return state.withTargets([{ name: target.name, repo: target.repo }], () =>
      withLocalTargetLock(target, () => {
        if (typeof lease !== 'function') {
          return work();
        }
        if (typeof deps.store.identity?.root !== 'string') {
          throw currentError(
            'DEPENDENCY_FILE_STORE_CHANGED',
            'central configured store identity is unavailable'
          );
        }
        return lease.call(
          deps.native,
          deps.store.identity.root,
          target.wtDir,
          work
        );
      })
    );
  }

  async function guard(target, phase, operationId) {
    if (typeof assertMutable !== 'function') {
      throw currentError(
        'DEPENDENCY_FILE_GUARD_REQUIRED',
        'mutation guard not configured'
      );
    }
    const result = await assertMutable(target, {
      ...(operationId ? { operationId } : {}),
      phase,
    });
    if (result === false || result?.ok === false) {
      throw currentError(
        result?.code ?? 'DEPENDENCY_FILE_TARGET_BUSY',
        'target mutation guard refused'
      );
    }
  }

  function requireTarget(target) {
    if (!validTarget(target)) {
      throw currentError(
        'DEPENDENCY_FILE_TARGET_INVALID',
        'trusted target identity unavailable'
      );
    }
  }

  async function captureTarget(target, { checkMutable = false, phase } = {}) {
    requireTarget(target);
    const root = await realpath(target.wtDir);
    if (
      root !== target.wtDir ||
      root !== target.checkoutIdentity.checkoutPath ||
      !(await lstat(root)).isDirectory()
    ) {
      throw currentError(
        'DEPENDENCY_FILE_TARGET_INVALID',
        'target is not a canonical checkout'
      );
    }
    const identity = await exactCurrentIdentity(target);
    if (checkMutable) {
      await guard(target, phase);
    }
    return { identity, root };
  }

  async function currentInputs(deps, root) {
    const result = await deps.inputs(root);
    if (
      !object(result) ||
      result.checkout !== root ||
      typeof result.inputDigest !== 'string' ||
      !SHA256.test(result.inputDigest) ||
      typeof result.head !== 'string' ||
      typeof result.lockfileHash !== 'string' ||
      !SHA256.test(result.lockfileHash) ||
      result.linker !== 'hoisted' ||
      !(
        (typeof result.device === 'number' &&
          Number.isSafeInteger(result.device)) ||
        (typeof result.device === 'string' && DECIMAL.test(result.device))
      ) ||
      !Array.isArray(result.roots)
    ) {
      throw currentError(
        'DEPENDENCY_FILE_INPUT_INVALID',
        'dependency input observation was incomplete'
      );
    }
    const checkoutInfo = await stat(root, { bigint: true });
    if (String(checkoutInfo.dev) !== String(result.device)) {
      throw currentError(
        'DEPENDENCY_FILE_INPUT_INVALID',
        'dependency input observation names a different checkout volume'
      );
    }
    return result;
  }

  async function currentStore(deps, checkoutRoot) {
    const described = await deps.store.describe();
    const identity = described?.identity ?? deps.store.identity;
    const root = described?.root ?? deps.store.root;
    const expectedNamespace = 'hoisted/darwin-arm64-bun-1.3.14';
    const identityShapeValid =
      object(identity) &&
      typeof identity.root === 'string' &&
      isAbsolute(identity.root) &&
      typeof identity.device === 'string' &&
      DECIMAL.test(identity.device) &&
      typeof identity.mountPath === 'string' &&
      isAbsolute(identity.mountPath) &&
      typeof identity.executable === 'string' &&
      isAbsolute(identity.executable) &&
      identity.version === '1.3.14' &&
      identity.namespace === expectedNamespace;
    if (
      !(
        identityShapeValid &&
        sameJson(identity, deps.store.identity) &&
        root === deps.store.root &&
        isAbsolute(root) &&
        (!sharing?.storeRoot || resolve(sharing.storeRoot) === identity.root) &&
        root === join(identity.root, ...expectedNamespace.split('/'))
      )
    ) {
      throw currentError(
        'DEPENDENCY_FILE_STORE_CHANGED',
        'store identity is inconsistent'
      );
    }
    const centralEntry = await lstat(identity.root, { bigint: true });
    if (
      centralEntry.isSymbolicLink() ||
      !centralEntry.isDirectory() ||
      (await realpath(identity.root)) !== identity.root
    ) {
      throw currentError(
        'DEPENDENCY_FILE_STORE_CHANGED',
        'configured store root is no longer canonical'
      );
    }
    const [storeInfo, checkoutInfo, mountInfo, canonicalMount] =
      await Promise.all([
        stat(identity.root, { bigint: true }),
        stat(checkoutRoot, { bigint: true }),
        stat(identity.mountPath, { bigint: true }),
        realpath(identity.mountPath),
      ]);
    if (
      String(storeInfo.dev) !== String(checkoutInfo.dev) ||
      identity.device !== String(storeInfo.dev) ||
      // macOS firmlinks can place this same device outside the mount's pathname.
      !mountInfo.isDirectory() ||
      identity.device !== String(mountInfo.dev) ||
      canonicalMount !== identity.mountPath ||
      identity.mountPath !== resolve(identity.mountPath)
    ) {
      throw currentError(
        'DEPENDENCY_FILE_STORE_CHANGED',
        'store and checkout do not share the configured volume'
      );
    }
    return { identity, root };
  }

  async function nativeCapability(native) {
    const result = await native.dependencyFileNativeStatus({
      ...(native.nativeBinary ? { nativeBinary: native.nativeBinary } : {}),
    });
    if (!object(result) || result.available !== true) {
      throw currentError(
        'DEPENDENCY_FILE_NATIVE_UNAVAILABLE',
        'native atomic exchange helper unavailable'
      );
    }
    return result;
  }

  async function checkpointMap(journal, operationId) {
    const rows = await journal.checkpoints(operationId);
    if (!Array.isArray(rows)) {
      throw currentError(
        'DEPENDENCY_FILE_OPERATION_UNKNOWN',
        'checkpoint list unavailable'
      );
    }
    const result = new Map();
    for (const row of rows) {
      if (
        !(
          object(row) &&
          Number.isSafeInteger(row.index) &&
          row.index >= 0 &&
          !result.has(row.index)
        )
      ) {
        throw currentError(
          'DEPENDENCY_FILE_JOURNAL_CORRUPT',
          'checkpoint list malformed'
        );
      }
      result.set(row.index, row);
    }
    return result;
  }

  async function persistFailure(journal, operationId, stateName, code) {
    try {
      await journal.finish(operationId, {
        code: sanitizedCode(code),
        state: stateName,
      });
      return true;
    } catch {
      return false;
    }
  }

  function recoveryIdentity(plan, operationId = plan.id) {
    return {
      name: plan.name,
      operationId,
      planId: plan.id,
      repo: plan.repo,
    };
  }

  async function makePlan(target, { phase = 'prepare' } = {}) {
    const deps = await dependencies();
    const captured = await captureTarget(target, { checkMutable: true, phase });
    // Do not turn a missing native reader into an apparently valid empty plan.
    const capability = await nativeCapability(deps.native);
    const observedInputs = await currentInputs(deps, captured.root);
    const currentStoreIdentity = await currentStore(deps, captured.root);
    const scanned = await scanRoots(
      captured.root,
      observedInputs.roots,
      deps.native,
      now
    );
    const files = [];
    let totalBytes = 0;
    for (
      let start = 0;
      start < scanned.files.length;
      start += PLAN_FILE_BATCH_SIZE
    ) {
      // biome-ignore lint/performance/noAwaitInLoops: Each review batch is checked before advancing to the next bounded batch.
      const batch = await Promise.all(
        scanned.files
          .slice(start, start + PLAN_FILE_BATCH_SIZE)
          .map(async ({ fingerprint, relativePath }, offset) => {
            if (!validFingerprint(fingerprint, relativePath)) {
              throw currentError(
                'DEPENDENCY_FILE_NATIVE_RESULT_INVALID',
                'native fingerprint is malformed'
              );
            }
            const key = deps.store.objectKey(fingerprint, 2);
            if (typeof key !== 'string' || !SHA256.test(key)) {
              throw currentError(
                'DEPENDENCY_FILE_STORE_RESULT_INVALID',
                'store returned an invalid content identity'
              );
            }
            const temporaryRelativePath = deterministicStagePath(
              target,
              observedInputs.inputDigest,
              relativePath,
              fingerprint,
              key
            );
            if (!safeRelative(temporaryRelativePath)) {
              throw currentError(
                'DEPENDENCY_FILE_STAGE_PATH_UNAVAILABLE',
                'deterministic sibling stage path was invalid'
              );
            }
            const stagePath = join(
              captured.root,
              ...temporaryRelativePath.split('/')
            );
            const stageExists = await lstat(stagePath).then(
              () => true,
              (error) => {
                if (error.code === 'ENOENT') {
                  return false;
                }
                throw error;
              }
            );
            if (stageExists) {
              throw currentError(
                'DEPENDENCY_FILE_STAGE_PATH_CONFLICT',
                'deterministic stage path is already occupied'
              );
            }
            return {
              fingerprint,
              index: start + offset,
              objectKey: key,
              relativePath,
              temporaryRelativePath,
            };
          })
      );
      for (const file of batch) {
        totalBytes += file.fingerprint.size;
        if (!Number.isSafeInteger(totalBytes)) {
          throw currentError(
            'DEPENDENCY_FILE_SCAN_INCOMPLETE',
            'logical byte count exceeded the safe range'
          );
        }
        files.push(file);
      }
    }
    const body = {
      checkoutIdentity: captured.identity,
      files,
      head: observedInputs.head,
      inputDigest: observedInputs.inputDigest,
      lockfileHash: observedInputs.lockfileHash,
      logicalCloneBytes: totalBytes,
      mode: 'hoisted-cow',
      name: target.name,
      physicalSavingsBytes: null,
      repo: target.repo,
      skipped: scanned.skipped,
      storeIdentity: currentStoreIdentity.identity,
      version: 2,
    };
    let plan = deepFreeze(
      cloneJson({
        ...body,
        createdAt: now(),
        id: digestOf(withoutAccessTimes(body)),
      })
    );
    const [finalIdentity, finalInputs, finalStore] = await Promise.all([
      exactCurrentIdentity(target),
      currentInputs(deps, captured.root),
      currentStore(deps, captured.root),
    ]);
    if (
      !sameJson(finalIdentity, captured.identity) ||
      finalInputs.inputDigest !== observedInputs.inputDigest ||
      finalInputs.head !== observedInputs.head ||
      finalInputs.lockfileHash !== observedInputs.lockfileHash ||
      !sameJson(finalStore.identity, currentStoreIdentity.identity)
    ) {
      throw currentError(
        'DEPENDENCY_FILE_PLAN_CHANGED',
        'target inputs changed during review preparation'
      );
    }
    await guard(target, phase, plan.id);
    const persisted = await deps.journal.getPlan(plan.id);
    if (persisted !== null && persisted !== undefined) {
      if (
        !(
          existingPlanValid(persisted, plan.id) &&
          sameJson(stablePlanComparison(persisted), stablePlanComparison(plan))
        )
      ) {
        throw currentError(
          'DEPENDENCY_FILE_PLAN_CONFLICT',
          'deterministic review identity is already bound to different inputs'
        );
      }
      // Preserve the first durable access-time snapshot for any eventual clone.
      plan = deepFreeze(cloneJson(persisted));
    } else {
      await deps.journal.savePlan(plan);
    }
    return {
      capability,
      inputs: observedInputs,
      plan,
      root: captured.root,
      storeIdentity: currentStoreIdentity.identity,
      targetIdentity: captured.identity,
    };
  }

  async function assertNoPriorOperation(journal, target) {
    const listed = await journal.list({ name: target.name, repo: target.repo });
    const operation = listedOperations(listed).find(
      (row) =>
        ['prepared', 'running', 'partial', 'unknown', 'conflict'].includes(
          row?.state
        ) ||
        (row?.state === 'completed' && row.retainedOriginalFiles > 0)
    );
    if (operation) {
      const error = currentError(
        'DEPENDENCY_FILE_OPERATION_EXISTS',
        'A prior operation must be recovered or separately released before preparing another plan'
      );
      if (SHA256.test(operation.id ?? '')) {
        error.operationId = operation.id;
      }
      if (SHA256.test(operation.planId ?? '')) {
        error.planId = operation.planId;
      }
      throw error;
    }
  }

  async function loadReviewedPlan(deps, target, planId) {
    if (typeof planId !== 'string' || !SHA256.test(planId)) {
      throw currentError(
        'DEPENDENCY_FILE_PLAN_INVALID',
        'reviewed plan id is invalid'
      );
    }
    const plan = await deps.journal.getPlan(planId);
    if (!existingPlanValid(plan, planId)) {
      throw currentError(
        'DEPENDENCY_FILE_PLAN_INVALID',
        'reviewed plan is missing or malformed'
      );
    }
    if (
      plan.repo !== target.repo ||
      plan.name !== target.name ||
      plan.mode !== 'hoisted-cow' ||
      !plan.files.every(
        (file, index) =>
          object(file) &&
          file.index === index &&
          safeRelative(file.relativePath) &&
          safeRelative(file.temporaryRelativePath) &&
          SHA256.test(file.objectKey) &&
          validFingerprint(file.fingerprint, file.relativePath) &&
          validObjectKeyForPlan(file, plan.version)
      ) ||
      plan.files.some(
        (file) => file.relativePath === file.temporaryRelativePath
      )
    ) {
      throw currentError(
        'DEPENDENCY_FILE_PLAN_INVALID',
        'reviewed plan is inconsistent with its target'
      );
    }
    return plan;
  }

  async function verifyPlanCurrent(
    deps,
    target,
    plan,
    phase,
    { mutable = true } = {}
  ) {
    const captured = await captureTarget(
      target,
      mutable ? { checkMutable: true, phase } : {}
    );
    const observedInputs = await currentInputs(deps, captured.root);
    const currentStoreIdentity = await currentStore(deps, captured.root);
    if (
      !sameJson(captured.identity, plan.checkoutIdentity) ||
      observedInputs.inputDigest !== plan.inputDigest ||
      observedInputs.head !== plan.head ||
      observedInputs.lockfileHash !== plan.lockfileHash ||
      !sameJson(currentStoreIdentity.identity, plan.storeIdentity)
    ) {
      throw currentError(
        'DEPENDENCY_FILE_PLAN_CHANGED',
        'reviewed plan no longer matches current inputs or identities'
      );
    }
    return { captured, inputs: observedInputs, store: currentStoreIdentity };
  }

  function assertPlanCurrent(deps, target, plan, phase) {
    return verifyPlanCurrent(deps, target, plan, phase, { mutable: true });
  }

  async function assertNativeReady(native) {
    const capability = await nativeCapability(native);
    return capability;
  }

  async function fileObservation(native, checkoutRoot, relativePath) {
    if (!safeRelative(relativePath)) {
      throw currentError(
        'DEPENDENCY_FILE_TARGET_PATH_INVALID',
        'dependency path is not checkout-relative'
      );
    }
    const absolute = join(checkoutRoot, ...relativePath.split('/'));
    let info;
    try {
      info = await lstat(absolute, { bigint: true });
    } catch (error) {
      if (error.code === 'ENOENT') {
        return { exists: false };
      }
      throw error;
    }
    if (info.isSymbolicLink() || !info.isFile()) {
      return { exists: true, invalid: true };
    }
    await assertNoSymlinkAncestors(checkoutRoot, relativePath);
    const result = await native.readDependencyFile(checkoutRoot, relativePath);
    if (
      !(result?.eligible && validFingerprint(result.fingerprint, relativePath))
    ) {
      return { exists: true, invalid: true };
    }
    return { exists: true, fingerprint: result.fingerprint };
  }

  function checkpointFor(file, map) {
    const current = map.get(file.index);
    if (
      current &&
      (current.temporaryRelativePath !== file.temporaryRelativePath ||
        !sameJson(current.originalFingerprint, file.fingerprint))
    ) {
      throw currentError(
        'DEPENDENCY_FILE_JOURNAL_CORRUPT',
        'checkpoint does not match the immutable plan'
      );
    }
    return current;
  }

  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Classification is the recovery state table; its ordered identity checks must stay together so unknown and conflict outcomes retain both entries.
  async function classifyFile(native, checkoutRoot, file, checkpoint) {
    const [target, temporary] = await Promise.all([
      fileObservation(native, checkoutRoot, file.relativePath),
      fileObservation(native, checkoutRoot, file.temporaryRelativePath),
    ]);
    if (target.invalid || temporary.invalid) {
      return { phase: 'conflict', target, temporary };
    }
    const originalAtTarget =
      target.exists &&
      sameFile(native, file.fingerprint, target.fingerprint, true);
    const exchangeCheckpoint = ['swapped', 'verified', 'released'].includes(
      checkpoint?.phase
    );
    const originalAtTemporary =
      temporary.exists &&
      (exchangeCheckpoint && checkpoint?.retainedFingerprint
        ? sameFile(
            native,
            checkpoint.retainedFingerprint,
            temporary.fingerprint,
            true
          )
        : sameAfterExchangeIdentity(file.fingerprint, temporary.fingerprint));
    const targetMatchesData =
      target.exists && sameFile(native, file.fingerprint, target.fingerprint);
    const temporaryMatchesData =
      temporary.exists &&
      sameFile(native, file.fingerprint, temporary.fingerprint);
    const stagedFromCheckpoint = checkpoint?.stagedFingerprint;
    const stagedAtTarget =
      stagedFromCheckpoint &&
      target.exists &&
      (exchangeCheckpoint
        ? sameFile(native, stagedFromCheckpoint, target.fingerprint, true)
        : sameAfterExchangeIdentity(stagedFromCheckpoint, target.fingerprint));
    const stagedAtTemporary =
      stagedFromCheckpoint &&
      temporary.exists &&
      sameFile(native, stagedFromCheckpoint, temporary.fingerprint, true);

    if (checkpoint?.phase === 'conflict') {
      return { phase: 'conflict', target, temporary };
    }

    if (checkpoint?.phase === 'released') {
      if (!temporary.exists && stagedAtTarget) {
        return { phase: 'released', target, temporary };
      }
      return { phase: 'conflict', target, temporary };
    }
    if (
      checkpoint?.phase === 'verified' &&
      typeof checkpoint.releasePlanId === 'string' &&
      !temporary.exists &&
      stagedAtTarget
    ) {
      // The exact release review was durably recorded before unlink. A crash
      // after unlink but before the released checkpoint is therefore
      // reconcilable without starting another release intent.
      return { phase: 'released', target, temporary };
    }
    if (originalAtTarget && !temporary.exists) {
      if (
        ['swapped', 'verified', 'unknown', 'conflict'].includes(
          checkpoint?.phase
        )
      ) {
        return { phase: 'conflict', target, temporary };
      }
      return { phase: 'prepared', target, temporary };
    }
    if (
      originalAtTarget &&
      temporary.exists &&
      temporaryMatchesData &&
      !sameFile(native, file.fingerprint, temporary.fingerprint, true)
    ) {
      if (stagedFromCheckpoint && !stagedAtTemporary) {
        return { phase: 'conflict', target, temporary };
      }
      return {
        phase: 'staged',
        stagedFingerprint: temporary.fingerprint,
        target,
        temporary,
      };
    }
    if (
      !originalAtTarget &&
      targetMatchesData &&
      temporary.exists &&
      originalAtTemporary
    ) {
      if (stagedFromCheckpoint && !stagedAtTarget) {
        return { phase: 'conflict', target, temporary };
      }
      // A checkpoint lost after exchange leaves the prior durable phase at
      // `staged`. Record the missing `swapped` transition first; G3 forbids
      // jumping directly from staged to verified.
      const phase = checkpoint?.phase === 'verified' ? 'verified' : 'swapped';
      return {
        phase,
        retainedFingerprint: temporary.fingerprint,
        stagedFingerprint: target.fingerprint,
        target,
        temporary,
      };
    }
    return { phase: 'conflict', target, temporary };
  }

  async function persistClassifiedFile(
    journal,
    operationId,
    file,
    checkpoint,
    classified
  ) {
    const record = {
      ...(checkpoint ?? {}),
      index: file.index,
      originalFingerprint: file.fingerprint,
      phase: classified.phase,
      temporaryRelativePath: file.temporaryRelativePath,
      ...(classified.stagedFingerprint
        ? { stagedFingerprint: classified.stagedFingerprint }
        : {}),
      ...(classified.retainedFingerprint
        ? { retainedFingerprint: classified.retainedFingerprint }
        : {}),
    };
    await journal.checkpoint(
      operationId,
      file.index,
      checkpointPayload(record)
    );
    return record;
  }

  function persistVerifiedCheckpoint(journal, operationId, file, checkpoint) {
    if (checkpoint?.phase !== 'swapped') {
      return checkpoint;
    }
    return journal.checkpoint(
      operationId,
      file.index,
      checkpointPayload({ ...checkpoint, phase: 'verified' })
    );
  }

  async function reconcileOperation(
    deps,
    target,
    plan,
    operationId,
    phase = 'recover'
  ) {
    const { captured } = await assertPlanCurrent(deps, target, plan, phase);
    const checkpoints = await checkpointMap(deps.journal, operationId);
    const results = [];
    let conflict = false;
    let allVerified = true;
    let allReleased = plan.files.length > 0;
    for (const file of plan.files) {
      const checkpoint = checkpoints.get(file.index);
      // biome-ignore lint/performance/noAwaitInLoops: Reconciliation checkpoints each file before advancing, preserving recovery order.
      const classified = await classifyFile(
        deps.native,
        captured.root,
        file,
        checkpoint
      );
      if (classified.phase === 'conflict') {
        conflict = true;
        allVerified = false;
        allReleased = false;
      } else {
        if (!['swapped', 'verified'].includes(classified.phase)) {
          allVerified = false;
        }
        if (classified.phase === 'released') {
          allVerified = false;
        } else {
          allReleased = false;
        }
      }
      let reconciledCheckpoint = checkpoint;
      if (!checkpoint || checkpoint.phase !== classified.phase) {
        reconciledCheckpoint = await persistClassifiedFile(
          deps.journal,
          operationId,
          file,
          checkpoint,
          classified
        );
      }
      reconciledCheckpoint = await persistVerifiedCheckpoint(
        deps.journal,
        operationId,
        file,
        reconciledCheckpoint
      );
      results.push({ checkpoint: reconciledCheckpoint, classified, file });
    }
    let stateName = 'partial';
    if (allVerified) {
      stateName = 'completed';
    }
    if (allReleased) {
      stateName = 'released';
    }
    if (conflict) {
      stateName = 'conflict';
    }
    const summary = await deps.journal.finish(operationId, {
      state: stateName,
    });
    return { results, state: stateName, summary };
  }

  async function createPreparedCheckpoints(journal, plan, operationId) {
    const current = await checkpointMap(journal, operationId);
    for (const file of plan.files) {
      const previous = current.get(file.index);
      if (previous) {
        if (
          previous.temporaryRelativePath !== file.temporaryRelativePath ||
          !sameJson(previous.originalFingerprint, file.fingerprint)
        ) {
          throw currentError(
            'DEPENDENCY_FILE_JOURNAL_CORRUPT',
            'existing checkpoint changed the reviewed target'
          );
        }
        continue;
      }
      // biome-ignore lint/performance/noAwaitInLoops: Prepared intents are durably recorded in plan order before mutation begins.
      const saved = await journal.checkpoint(operationId, file.index, {
        originalFingerprint: file.fingerprint,
        phase: 'prepared',
        relativePath: file.relativePath,
        temporaryRelativePath: file.temporaryRelativePath,
      });
      current.set(file.index, saved);
    }
    return current;
  }

  async function ensureAndStage(
    deps,
    target,
    operationId,
    file,
    version,
    guardPhase
  ) {
    await guard(target, guardPhase, operationId);
    const ensured = await deps.store.ensure(file.fingerprint, target.wtDir, {
      version,
    });
    if (
      !object(ensured) ||
      ensured.key !== file.objectKey ||
      ensured.relativePath !==
        `objects/${file.objectKey.slice(0, 2)}/${file.objectKey}` ||
      !validObjectFingerprint(ensured.fingerprint, file.objectKey) ||
      !sameCanonicalObject(
        deps.native,
        version,
        file.fingerprint,
        ensured.fingerprint
      )
    ) {
      throw currentError(
        'DEPENDENCY_FILE_STORE_RESULT_INVALID',
        'store did not verify the planned object'
      );
    }
    const verified = await deps.store.verify(file.objectKey, file.fingerprint);
    if (!isVerifiedResult(verified)) {
      throw currentError(
        'DEPENDENCY_FILE_STORE_OBJECT_INVALID',
        'stored object did not verify'
      );
    }
    await guard(target, guardPhase, operationId);
    const before = await fileObservation(
      deps.native,
      target.wtDir,
      file.relativePath
    );
    if (
      !before.exists ||
      before.invalid ||
      !sameFile(deps.native, file.fingerprint, before.fingerprint, true)
    ) {
      throw currentError(
        'DEPENDENCY_FILE_CONFLICT',
        'installed file changed after review'
      );
    }
    const staged = await deps.store.stage(
      file.objectKey,
      target.wtDir,
      file.temporaryRelativePath,
      file.fingerprint
    );
    if (staged?.ok === false) {
      throw currentError(
        staged.code ?? 'DEPENDENCY_FILE_STAGE_FAILED',
        'stage operation did not complete'
      );
    }
    const restored = await deps.native.restoreDependencyTimes(
      target.wtDir,
      file.temporaryRelativePath,
      {
        atimeNs: file.fingerprint.atimeNs,
        mtimeNs: file.fingerprint.mtimeNs,
      }
    );
    assertEffect(restored, 'DEPENDENCY_FILE_TIME_RESTORE_FAILED', 'restored');
    const stagedFile = await fileObservation(
      deps.native,
      target.wtDir,
      file.temporaryRelativePath
    );
    if (
      !stagedFile.exists ||
      stagedFile.invalid ||
      !sameFile(deps.native, file.fingerprint, stagedFile.fingerprint)
    ) {
      throw currentError(
        'DEPENDENCY_FILE_STAGE_INVALID',
        'staged clone did not preserve content and metadata'
      );
    }
    const stagedAbsolute = join(
      target.wtDir,
      ...file.temporaryRelativePath.split('/')
    );
    await syncStableFileAndParent(stagedAbsolute, deps.native);
    await guard(target, guardPhase, operationId);
    await deps.journal.checkpoint(operationId, file.index, {
      originalFingerprint: file.fingerprint,
      phase: 'staged',
      relativePath: file.relativePath,
      stagedFingerprint: stagedFile.fingerprint,
      temporaryRelativePath: file.temporaryRelativePath,
    });
    return stagedFile.fingerprint;
  }

  async function exchangeOne(
    deps,
    target,
    operationId,
    file,
    stagedFp,
    guardPhase
  ) {
    await guard(target, guardPhase, operationId);
    const [original, staged] = await Promise.all([
      fileObservation(deps.native, target.wtDir, file.relativePath),
      fileObservation(deps.native, target.wtDir, file.temporaryRelativePath),
    ]);
    if (
      !original.exists ||
      original.invalid ||
      !staged.exists ||
      staged.invalid ||
      !sameFile(deps.native, file.fingerprint, original.fingerprint, true) ||
      !sameFile(deps.native, stagedFp, staged.fingerprint, true)
    ) {
      throw currentError(
        'DEPENDENCY_FILE_CONFLICT',
        'target or staged file changed before atomic exchange'
      );
    }
    const parent = dirname(join(target.wtDir, ...file.relativePath.split('/')));
    const parentIdentity = await statIdentity(parent);
    const result = await deps.native.exchangeDependencyFiles(
      target.wtDir,
      file.relativePath,
      file.temporaryRelativePath,
      {
        ...(deps.native.nativeBinary
          ? { nativeBinary: deps.native.nativeBinary }
          : {}),
        parentDevice: parentIdentity.device,
        parentInode: parentIdentity.inode,
      }
    );
    if (result?.exchanged !== true) {
      throw currentError(
        'DEPENDENCY_FILE_OPERATION_UNKNOWN',
        'atomic exchange outcome was not confirmed'
      );
    }
    const [installed, retained] = await Promise.all([
      fileObservation(deps.native, target.wtDir, file.relativePath),
      fileObservation(deps.native, target.wtDir, file.temporaryRelativePath),
    ]);
    if (
      !(
        installed.exists &&
        retained.exists &&
        !installed.invalid &&
        !retained.invalid
      )
    ) {
      throw currentError(
        'DEPENDENCY_FILE_OPERATION_UNKNOWN',
        'exchanged entries could not be observed'
      );
    }
    if (
      !(
        sameAfterExchangeIdentity(stagedFp, installed.fingerprint) &&
        sameAfterExchangeIdentity(file.fingerprint, retained.fingerprint)
      )
    ) {
      await deps.journal.checkpoint(operationId, file.index, {
        originalFingerprint: file.fingerprint,
        phase: 'conflict',
        relativePath: file.relativePath,
        retainedFingerprint: retained.fingerprint,
        stagedFingerprint: installed.fingerprint,
        temporaryRelativePath: file.temporaryRelativePath,
      });
      throw currentError(
        'DEPENDENCY_FILE_CONFLICT',
        'displaced original identity did not match the reviewed entry'
      );
    }
    await deps.journal.checkpoint(operationId, file.index, {
      originalFingerprint: file.fingerprint,
      phase: 'swapped',
      relativePath: file.relativePath,
      retainedFingerprint: retained.fingerprint,
      stagedFingerprint: installed.fingerprint,
      temporaryRelativePath: file.temporaryRelativePath,
    });
    await syncStableFileAndParent(
      join(target.wtDir, ...file.relativePath.split('/')),
      deps.native
    );
    return deps.journal.checkpoint(operationId, file.index, {
      originalFingerprint: file.fingerprint,
      phase: 'verified',
      relativePath: file.relativePath,
      retainedFingerprint: retained.fingerprint,
      stagedFingerprint: installed.fingerprint,
      temporaryRelativePath: file.temporaryRelativePath,
    });
  }

  function updateRunningSummary(journal, operationId) {
    // G3 derives progress counters from durable checkpoints; callers can only
    // request a state transition, never overwrite checkpoint-derived totals.
    return journal.finish(operationId, { state: 'running' });
  }

  async function finishApplyView(
    journal,
    target,
    operationId,
    finishedSummary
  ) {
    const summary =
      finishedSummary ??
      (await journal.finish(operationId, { state: 'completed' }));
    try {
      await journal.setView({ name: target.name, repo: target.repo }, summary);
    } catch (cause) {
      throw currentError(
        'DEPENDENCY_FILE_VIEW_SUMMARY_UNKNOWN',
        'verified operation summary could not be published',
        cause
      );
    }
    return summary;
  }

  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: This is the guarded apply transition sequence; splitting it would obscure the required ordering of revalidation, durable intent, native exchange, and recovery reporting.
  async function executeApply(target, request, guardPhase = 'apply') {
    const deps = await dependencies();
    const plan = await loadReviewedPlan(deps, target, request.planId);
    const operationId = request.operationId ?? plan.id;
    if (operationId !== plan.id) {
      return failure(
        'DEPENDENCY_FILE_OPERATION_ID_MISMATCH',
        'The operation id must be the reviewed plan id.',
        { planId: plan.id }
      );
    }
    if (request.confirmation !== plan.id) {
      return failure(
        'CONFIRMATION_REQUIRED',
        'Confirm the exact reviewed plan before applying it.',
        { confirmation: plan.id, planId: plan.id }
      );
    }
    await assertPlanCurrent(deps, target, plan, guardPhase);
    await assertNativeReady(deps.native);
    let operation;
    try {
      operation = await deps.journal.begin(plan);
    } catch (error) {
      return {
        ...publicError(error, 'DEPENDENCY_FILE_OPERATION_UNKNOWN'),
        ...recoveryIdentity(plan, operationId),
      };
    }
    if (
      !object(operation) ||
      operation.id !== operationId ||
      operation.planId !== plan.id ||
      operation.repo !== plan.repo ||
      operation.name !== plan.name
    ) {
      return failure(
        'DEPENDENCY_FILE_JOURNAL_CORRUPT',
        'The durable operation does not match the reviewed plan.',
        { ...recoveryIdentity(plan, operationId), state: 'unknown' }
      );
    }
    if (operation.state === 'released') {
      return failure(
        'DEPENDENCY_FILE_OPERATION_RELEASED',
        'This operation has released its retained originals and cannot be applied again.',
        { ...recoveryIdentity(plan, operationId), state: 'released' }
      );
    }
    if (operation.state === 'conflict') {
      return failure(
        'DEPENDENCY_FILE_CONFLICT',
        'This operation has a recorded conflict; inspect the retained entries before continuing.',
        { ...recoveryIdentity(plan, operationId), state: 'conflict' }
      );
    }
    let existingCheckpoints;
    try {
      existingCheckpoints = await checkpointMap(deps.journal, operationId);
    } catch (error) {
      return {
        ...publicError(error, 'DEPENDENCY_FILE_OPERATION_UNKNOWN'),
        ...recoveryIdentity(plan, operationId),
      };
    }
    const releaseIntent = [...existingCheckpoints.values()].find(
      (row) => typeof row.releasePlanId === 'string'
    );
    if (releaseIntent) {
      return failure(
        'DEPENDENCY_FILE_RELEASE_PENDING',
        'A retained-original release has started; resume its exact release review before applying again.',
        {
          ...recoveryIdentity(plan, operationId),
          releaseId: releaseIntent.releasePlanId,
          state: operation.state,
        }
      );
    }
    if (
      ['completed', 'partial', 'running', 'unknown'].includes(operation.state)
    ) {
      let reconciled;
      try {
        reconciled = await reconcileOperation(
          deps,
          target,
          plan,
          operationId,
          guardPhase
        );
      } catch (error) {
        return publicError(error, 'DEPENDENCY_FILE_OPERATION_UNKNOWN');
      }
      if (reconciled.state === 'conflict') {
        return failure(
          'DEPENDENCY_FILE_CONFLICT',
          'A target or retained entry changed; both observed entries were left in place.',
          { ...recoveryIdentity(plan, operationId), state: 'conflict' }
        );
      }
      if (reconciled.state === 'released') {
        return failure(
          'DEPENDENCY_FILE_OPERATION_RELEASED',
          'This operation has released its retained originals and cannot be applied again.',
          { ...recoveryIdentity(plan, operationId), state: 'released' }
        );
      }
      if (reconciled.state === 'completed') {
        try {
          const summary = await finishApplyView(
            deps.journal,
            target,
            operationId,
            reconciled.summary
          );
          return {
            ...summary,
            ok: true,
            planId: plan.id,
            skipped: plan.skipped,
          };
        } catch (error) {
          if (
            error instanceof Error &&
            error.code === 'DEPENDENCY_FILE_VIEW_SUMMARY_UNKNOWN'
          ) {
            return failure(
              error.code,
              'The operation completed, but its current view summary could not be recorded.',
              { ...recoveryIdentity(plan, operationId), state: 'completed' }
            );
          }
          return publicError(error, 'DEPENDENCY_FILE_OPERATION_UNKNOWN');
        }
      }
    }
    let nativeActionStarted = false;
    try {
      const checkpoints = await createPreparedCheckpoints(
        deps.journal,
        plan,
        operationId
      );
      await deps.journal.finish(operationId, { state: 'running' });
      for (const [position, file] of plan.files.entries()) {
        // Input discovery and immutable-manifest verification are bounded to
        // batches. Every swap still checks its exact source and stage identities.
        if (position > 0 && position % 32 === 0) {
          // biome-ignore lint/performance/noAwaitInLoops: Revalidation runs once per fixed 32-file batch.
          await assertPlanCurrent(deps, target, plan, guardPhase);
        }
        let checkpoint = checkpointFor(file, checkpoints);
        const classified = await classifyFile(
          deps.native,
          target.wtDir,
          file,
          checkpoint
        );
        if (classified.phase === 'conflict') {
          checkpoint = await persistClassifiedFile(
            deps.journal,
            operationId,
            file,
            checkpoint,
            classified
          );
          checkpoints.set(file.index, checkpoint);
          throw currentError(
            'DEPENDENCY_FILE_CONFLICT',
            'target or retained file changed'
          );
        }
        if (
          classified.phase === 'verified' ||
          classified.phase === 'released'
        ) {
          if (classified.phase === 'released') {
            throw currentError(
              'DEPENDENCY_FILE_OPERATION_RELEASED',
              'operation backups already released'
            );
          }
          if (checkpoint?.phase !== 'verified') {
            checkpoint = await persistClassifiedFile(
              deps.journal,
              operationId,
              file,
              checkpoint,
              classified
            );
            checkpoints.set(file.index, checkpoint);
          }
          continue;
        }
        if (classified.phase === 'swapped') {
          checkpoint = await persistClassifiedFile(
            deps.journal,
            operationId,
            file,
            checkpoint,
            classified
          );
          checkpoint = await deps.journal.checkpoint(
            operationId,
            file.index,
            checkpointPayload({ ...checkpoint, phase: 'verified' })
          );
          checkpoints.set(file.index, checkpoint);
          continue;
        }
        let { stagedFingerprint } = classified;
        if (classified.phase === 'prepared') {
          nativeActionStarted = true;
          stagedFingerprint = await ensureAndStage(
            deps,
            target,
            operationId,
            file,
            plan.version,
            guardPhase
          );
        }
        if (!stagedFingerprint) {
          throw currentError(
            'DEPENDENCY_FILE_OPERATION_UNKNOWN',
            'staged file identity is unavailable'
          );
        }
        nativeActionStarted = true;
        const verifiedCheckpoint = await exchangeOne(
          deps,
          target,
          operationId,
          file,
          stagedFingerprint,
          guardPhase
        );
        checkpoints.set(file.index, verifiedCheckpoint);
        if ((position + 1) % 32 === 0) {
          await updateRunningSummary(deps.journal, operationId);
        }
      }
      await assertPlanCurrent(deps, target, plan, guardPhase);
      await assertNativeReady(deps.native);
      const finalCheckpoints = await checkpointMap(deps.journal, operationId);
      for (const file of plan.files) {
        const checkpoint = finalCheckpoints.get(file.index);
        // biome-ignore lint/performance/noAwaitInLoops: Verify each exchanged entry before finalizing the operation summary.
        const classified = await classifyFile(
          deps.native,
          target.wtDir,
          file,
          checkpoint
        );
        if (classified.phase !== 'verified') {
          if (classified.phase === 'conflict') {
            await persistClassifiedFile(
              deps.journal,
              operationId,
              file,
              checkpoint,
              classified
            );
            throw currentError(
              'DEPENDENCY_FILE_CONFLICT',
              'post-exchange identity changed'
            );
          }
          throw currentError(
            'DEPENDENCY_FILE_OPERATION_UNKNOWN',
            'post-exchange verification is incomplete'
          );
        }
      }
      await assertPlanCurrent(deps, target, plan, guardPhase);
      const summary = await finishApplyView(deps.journal, target, operationId);
      return {
        ...summary,
        ok: true,
        planId: plan.id,
        skipped: plan.skipped,
      };
    } catch (error) {
      const code = sanitizedCode(
        error instanceof Error ? error.code : undefined
      );
      if (code === 'DEPENDENCY_FILE_VIEW_SUMMARY_UNKNOWN') {
        return failure(
          code,
          'The operation completed, but its current view summary could not be recorded.',
          { ...recoveryIdentity(plan, operationId), state: 'completed' }
        );
      }
      let terminalState = 'partial';
      if (code.includes('UNKNOWN') || nativeActionStarted) {
        terminalState = 'unknown';
      }
      if (code === 'DEPENDENCY_FILE_CONFLICT') {
        terminalState = 'conflict';
      }
      const persisted = await persistFailure(
        deps.journal,
        operationId,
        terminalState,
        code
      );
      const recovery = recoveryIdentity(plan, operationId);
      return failure(
        persisted ? code : 'DEPENDENCY_FILE_OPERATION_UNKNOWN',
        persisted
          ? publicError({ code }).error
          : 'The outcome could not be recorded; inspect the same operation identity before retrying.',
        { ...recovery, state: persisted ? terminalState : 'unknown' }
      );
    }
  }

  async function prepare(target) {
    try {
      return await withServiceTargetLock(target, async () => {
        const deps = await dependencies();
        await assertNoPriorOperation(deps.journal, target);
        const built = await makePlan(target);
        return {
          capability: built.capability,
          confirmation: built.plan.id,
          fileCount: built.plan.files.length,
          logicalCloneBytes: built.plan.logicalCloneBytes,
          ok: true,
          physicalSavingsBytes: null,
          plan: built.plan,
          planId: built.plan.id,
          skipped: built.plan.skipped,
        };
      });
    } catch (error) {
      return publicError(error);
    }
  }

  async function apply(target, request = EMPTY, guardPhase = 'apply') {
    try {
      return await withServiceTargetLock(target, () =>
        executeApply(target, request, guardPhase)
      );
    } catch (error) {
      const operationId =
        typeof request.operationId === 'string'
          ? request.operationId
          : request.planId;
      return {
        ...publicError(error, 'DEPENDENCY_FILE_OPERATION_UNKNOWN'),
        ...(typeof request.planId === 'string'
          ? { planId: request.planId }
          : {}),
        ...(typeof operationId === 'string' ? { operationId } : {}),
      };
    }
  }

  async function recover(target, request = EMPTY, guardPhase = 'recover') {
    try {
      // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Recovery reconciles durable checkpoints against both live entries and preserves unknown/conflict outcomes without changing file names.
      return await withServiceTargetLock(target, async () => {
        const deps = await dependencies();
        requireTarget(target);
        if (
          typeof request.operationId !== 'string' ||
          !SHA256.test(request.operationId)
        ) {
          throw currentError(
            'DEPENDENCY_FILE_OPERATION_ID_INVALID',
            'operation id is invalid'
          );
        }
        const operation = await deps.journal.getOperation(request.operationId);
        if (operation === null || operation === undefined) {
          const plan = await loadReviewedPlan(
            deps,
            target,
            request.operationId
          );
          await assertPlanCurrent(deps, target, plan, guardPhase);
          await assertNativeReady(deps.native);
          const files = [];
          for (const file of plan.files) {
            // Recovery before begin is intentionally observational: every
            // reviewed source must still be the exact original and its
            // deterministic stage path must still be absent.
            // biome-ignore lint/performance/noAwaitInLoops: Observe each reviewed source and stage in plan order without creating checkpoints.
            const [original, staged] = await Promise.all([
              fileObservation(deps.native, target.wtDir, file.relativePath),
              fileObservation(
                deps.native,
                target.wtDir,
                file.temporaryRelativePath
              ),
            ]);
            if (
              !original.exists ||
              original.invalid ||
              !sameFile(
                deps.native,
                file.fingerprint,
                original.fingerprint,
                true
              ) ||
              staged.exists ||
              staged.invalid
            ) {
              throw currentError(
                'DEPENDENCY_FILE_CONFLICT',
                'unbegun plan no longer has every reviewed original and an absent stage path'
              );
            }
            files.push({
              phase: 'prepared',
              relativePath: file.relativePath,
              temporaryRelativePath: file.temporaryRelativePath,
            });
          }
          return {
            ...recoveryIdentity(plan, request.operationId),
            allFilesPrepared: true,
            files,
            ok: true,
            resumable: true,
            state: 'partial',
          };
        }
        if (
          !object(operation) ||
          operation.id !== request.operationId ||
          operation.planId !== request.operationId ||
          operation.repo !== target.repo ||
          operation.name !== target.name
        ) {
          throw currentError(
            'DEPENDENCY_FILE_OPERATION_NOT_FOUND',
            'operation does not belong to this target'
          );
        }
        const plan = await loadReviewedPlan(deps, target, operation.planId);
        if (operation.state === 'released') {
          await verifyPlanCurrent(deps, target, plan, guardPhase, {
            mutable: false,
          });
          return {
            ...recoveryIdentity(plan, operation.id),
            ok: true,
            resumable: false,
            state: 'released',
          };
        }
        const preexistingCheckpoints = await checkpointMap(
          deps.journal,
          operation.id
        );
        const releaseIds = [
          ...new Set(
            [...preexistingCheckpoints.values()]
              .map((row) => row.releasePlanId)
              .filter((id) => typeof id === 'string')
          ),
        ];
        if (releaseIds.length > 1) {
          throw currentError(
            'DEPENDENCY_FILE_RELEASE_PLAN_INVALID',
            'operation has more than one retained-original release identity'
          );
        }
        if (releaseIds.length === 1) {
          const releasePlan = await loadReleasePlan(
            deps,
            target,
            releaseIds[0]
          );
          if (releasePlan.operationId !== operation.id) {
            throw currentError(
              'DEPENDENCY_FILE_RELEASE_PLAN_INVALID',
              'release identity belongs to a different operation'
            );
          }
          await validateReleaseBinding(deps, releasePlan, {
            operation,
            plan,
          });
        }
        const reconciled = await reconcileOperation(
          deps,
          target,
          plan,
          operation.id,
          guardPhase
        );
        const files = reconciled.results.map(({ file, classified }) => ({
          phase: classified.phase,
          relativePath: file.relativePath,
          temporaryRelativePath: file.temporaryRelativePath,
          ...(classified.phase === 'conflict'
            ? {
                retainedFingerprint: classified.temporary?.fingerprint ?? null,
                targetFingerprint: classified.target?.fingerprint ?? null,
              }
            : {}),
        }));
        const [releaseId] = releaseIds;
        return {
          ...recoveryIdentity(plan, operation.id),
          files,
          ok: reconciled.state !== 'conflict',
          ...(releaseId ? { releaseId } : {}),
          resumable: ['partial', 'completed'].includes(reconciled.state),
          state: reconciled.state,
          ...(reconciled.state === 'conflict'
            ? {
                code: 'DEPENDENCY_FILE_CONFLICT',
                error:
                  'A target or retained entry changed; both observed entries were left in place.',
              }
            : {}),
        };
      });
    } catch (error) {
      return {
        ...publicError(error, 'DEPENDENCY_FILE_OPERATION_UNKNOWN'),
        ...(typeof request.operationId === 'string'
          ? { operationId: request.operationId }
          : {}),
      };
    }
  }

  async function status(target) {
    try {
      requireTarget(target);
      const deps = await dependencies();
      const listed = await deps.journal.list({
        name: target.name,
        repo: target.repo,
      });
      const operations = listedOperations(listed);
      let capability;
      try {
        capability = await deps.native.dependencyFileNativeStatus({
          ...(deps.native.nativeBinary
            ? { nativeBinary: deps.native.nativeBinary }
            : {}),
        });
      } catch {
        capability = { available: false, code: 'NATIVE_STATUS_UNKNOWN' };
      }
      return {
        ...(object(listed) && Object.hasOwn(listed, 'views')
          ? { views: listed.views }
          : {}),
        native: capability,
        ok: true,
        operations,
        state: operationState(operations),
      };
    } catch (error) {
      return publicError(error);
    }
  }

  async function notifyFreshEnrollmentPlan(onPlan, plan) {
    if (!onPlan) {
      return null;
    }
    try {
      const callbackResult = await onPlan(plan);
      if (callbackResult !== false && callbackResult?.ok !== false) {
        return null;
      }
      const error = currentError(
        callbackResult?.code ?? 'DEPENDENCY_FILE_OPERATION_UNKNOWN',
        'fresh enrollment plan callback did not confirm persistence'
      );
      return {
        ...publicError(error, 'DEPENDENCY_FILE_OPERATION_UNKNOWN'),
        operationId: plan.id,
        planId: plan.id,
      };
    } catch (error) {
      return {
        ...publicError(error, 'DEPENDENCY_FILE_OPERATION_UNKNOWN'),
        operationId: plan.id,
        planId: plan.id,
      };
    }
  }

  async function enrollFresh(target, { onPlan } = EMPTY) {
    try {
      return await withServiceTargetLock(target, async () => {
        if (onPlan !== undefined && typeof onPlan !== 'function') {
          throw currentError(
            'DEPENDENCY_FILE_ENROLLMENT_CALLBACK_INVALID',
            'fresh enrollment callback is invalid'
          );
        }
        const deps = await dependencies();
        requireTarget(target);
        await guard(target, 'enroll-fresh');
        const existing = await deps.journal.list({
          name: target.name,
          repo: target.repo,
        });
        const operations = listedOperations(existing);
        const pending = operations.find((row) =>
          ['prepared', 'running', 'partial', 'unknown', 'conflict'].includes(
            row?.state
          )
        );
        if (pending) {
          return failure(
            'DEPENDENCY_FILE_OPERATION_EXISTS',
            'A prior enrollment operation must be recovered by its existing identity before another intent is created.',
            {
              operationId: pending.id,
              planId: pending.planId,
              state: pending.state,
            }
          );
        }
        if (
          operations.some((row) =>
            ['completed', 'released'].includes(row?.state)
          )
        ) {
          return failure(
            'DEPENDENCY_FILE_ALREADY_ENROLLED',
            'This checkout already has a dependency-file operation; fresh enrollment is not an adoption path.',
            { state: 'completed' }
          );
        }
        const built = await makePlan(target, { phase: 'enroll-fresh' });
        const callbackFailure = await notifyFreshEnrollmentPlan(
          onPlan,
          built.plan
        );
        if (callbackFailure) {
          return callbackFailure;
        }
        return executeApply(
          target,
          {
            confirmation: built.plan.id,
            operationId: built.plan.id,
            planId: built.plan.id,
          },
          'enroll-fresh'
        );
      });
    } catch (error) {
      return publicError(error, 'DEPENDENCY_FILE_OPERATION_UNKNOWN');
    }
  }

  async function operationForRelease(deps, target, operationId) {
    if (typeof operationId !== 'string' || !SHA256.test(operationId)) {
      throw currentError(
        'DEPENDENCY_FILE_OPERATION_ID_INVALID',
        'operation id is invalid'
      );
    }
    const operation = await deps.journal.getOperation(operationId);
    if (
      !object(operation) ||
      operation.id !== operationId ||
      operation.planId !== operationId ||
      operation.repo !== target.repo ||
      operation.name !== target.name
    ) {
      throw currentError(
        'DEPENDENCY_FILE_OPERATION_NOT_FOUND',
        'operation does not belong to this target'
      );
    }
    const plan = await loadReviewedPlan(deps, target, operation.planId);
    return { operation, plan };
  }

  async function prepareRelease(target, request = EMPTY) {
    try {
      // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Release review binds every installed and retained identity before persisting a second immutable intent.
      return await withServiceTargetLock(target, async () => {
        const deps = await dependencies();
        const { operation, plan } = await operationForRelease(
          deps,
          target,
          request.operationId
        );
        const checkpoints = await checkpointMap(deps.journal, operation.id);
        const existingRelease = [...checkpoints.values()].find(
          (row) => typeof row.releasePlanId === 'string'
        );
        if (existingRelease) {
          const releasePlan = await loadReleasePlan(
            deps,
            target,
            existingRelease.releasePlanId
          );
          if (releasePlan.operationId !== operation.id) {
            throw currentError(
              'DEPENDENCY_FILE_RELEASE_PLAN_INVALID',
              'existing release review belongs to a different operation'
            );
          }
          await assertPlanCurrent(deps, target, plan, 'prepare-release');
          const releaseCheckpoints = await validateReleaseBinding(
            deps,
            releasePlan,
            { operation, plan }
          );
          for (const file of releasePlan.files) {
            const checkpoint = releaseCheckpoints.get(file.index);
            // biome-ignore lint/performance/noAwaitInLoops: Revalidate one retained backup at a time in immutable plan order.
            const [targetFile, backupFile] = await Promise.all([
              fileObservation(deps.native, target.wtDir, file.relativePath),
              fileObservation(
                deps.native,
                target.wtDir,
                file.temporaryRelativePath
              ),
            ]);
            if (
              !targetFile.exists ||
              targetFile.invalid ||
              !sameFile(
                deps.native,
                file.installedFingerprint,
                targetFile.fingerprint,
                true
              ) ||
              (backupFile.exists
                ? backupFile.invalid ||
                  !sameFile(
                    deps.native,
                    file.originalFingerprint,
                    backupFile.fingerprint,
                    true
                  )
                : checkpoint?.phase !== 'released' &&
                  checkpoint?.releasePlanId !== releasePlan.id)
            ) {
              throw currentError(
                'DEPENDENCY_FILE_RELEASE_DRIFT',
                'installed target or retained backup changed after release review'
              );
            }
          }
          await guard(target, 'prepare-release', operation.id);
          return {
            confirmation: releasePlan.id,
            fileCount: releasePlan.files.length,
            ok: true,
            releaseId: releasePlan.id,
            releasePlan,
            retainedOriginalFiles: releasePlan.files.length,
          };
        }
        if (operation.state !== 'completed') {
          return failure(
            'DEPENDENCY_FILE_RELEASE_NOT_READY',
            'Original release requires a completed operation; recover it and resume the same plan first.',
            {
              operationId: operation.id,
              planId: plan.id,
              state: operation.state,
            }
          );
        }
        await assertPlanCurrent(deps, target, plan, 'prepare-release');
        const files = [];
        for (const file of plan.files) {
          const checkpoint = checkpoints.get(file.index);
          if (
            checkpoint?.phase !== 'verified' ||
            !checkpoint.stagedFingerprint ||
            !checkpoint.retainedFingerprint
          ) {
            throw currentError(
              'DEPENDENCY_FILE_RELEASE_DRIFT',
              'completed operation lacks exact retained file identities'
            );
          }
          // biome-ignore lint/performance/noAwaitInLoops: Release review binds each backup and installed file before saving the review.
          const [targetFile, backupFile] = await Promise.all([
            fileObservation(deps.native, target.wtDir, file.relativePath),
            fileObservation(
              deps.native,
              target.wtDir,
              file.temporaryRelativePath
            ),
          ]);
          if (
            !targetFile.exists ||
            targetFile.invalid ||
            !backupFile.exists ||
            backupFile.invalid ||
            !sameFile(
              deps.native,
              checkpoint.stagedFingerprint,
              targetFile.fingerprint,
              true
            ) ||
            !sameFile(
              deps.native,
              checkpoint.retainedFingerprint,
              backupFile.fingerprint,
              true
            ) ||
            !sameAfterExchangeIdentity(file.fingerprint, backupFile.fingerprint)
          ) {
            throw currentError(
              'DEPENDENCY_FILE_RELEASE_DRIFT',
              'installed target or retained backup changed'
            );
          }
          files.push({
            index: file.index,
            installedFingerprint: targetFile.fingerprint,
            originalFingerprint: backupFile.fingerprint,
            relativePath: file.relativePath,
            temporaryRelativePath: file.temporaryRelativePath,
          });
        }
        const createdAt = now();
        const body = {
          checkoutIdentity: plan.checkoutIdentity,
          files,
          inputDigest: plan.inputDigest,
          manifestDigest: digestOf(plan),
          mode: 'hoisted-cow',
          name: plan.name,
          operationId: operation.id,
          planId: plan.id,
          repo: plan.repo,
          storeIdentity: plan.storeIdentity,
          version: 1,
        };
        const releasePlan = deepFreeze(
          cloneJson({
            ...body,
            createdAt,
            id: releaseDigest({ ...body, createdAt }),
          })
        );
        await assertPlanCurrent(deps, target, plan, 'prepare-release');
        await guard(target, 'prepare-release', operation.id);
        try {
          await deps.journal.saveReleasePlan(releasePlan);
        } catch (cause) {
          throw Object.assign(
            currentError(
              sanitizedCode(cause.code, 'DEPENDENCY_FILE_OPERATION_UNKNOWN'),
              'release review save outcome is unknown',
              cause
            ),
            {
              operationId: operation.id,
              planId: plan.id,
              releaseId: releasePlan.id,
            }
          );
        }
        return {
          confirmation: releasePlan.id,
          fileCount: releasePlan.files.length,
          manifestDigest: releasePlan.manifestDigest,
          ok: true,
          releaseId: releasePlan.id,
          releasePlan,
          retainedOriginalFiles: releasePlan.files.length,
        };
      });
    } catch (error) {
      return {
        ...publicError(error),
        ...(typeof request.operationId === 'string'
          ? { operationId: request.operationId }
          : {}),
        ...(typeof request.operationId === 'string' &&
        SHA256.test(request.operationId)
          ? { planId: request.operationId }
          : {}),
      };
    }
  }

  async function loadReleasePlan(deps, target, releaseId) {
    if (typeof releaseId !== 'string' || !SHA256.test(releaseId)) {
      throw currentError(
        'DEPENDENCY_FILE_RELEASE_ID_INVALID',
        'release id is invalid'
      );
    }
    const releasePlan = await deps.journal.getReleasePlan(releaseId);
    if (
      !object(releasePlan) ||
      releasePlan.version !== 1 ||
      releasePlan.mode !== 'hoisted-cow' ||
      releasePlan.id !== releaseId ||
      releaseDigest(releasePlan) !== releaseId ||
      releasePlan.repo !== target.repo ||
      releasePlan.name !== target.name ||
      releasePlan.planId !== releasePlan.operationId ||
      !SHA256.test(releasePlan.manifestDigest) ||
      !Array.isArray(releasePlan.files) ||
      !SHA256.test(releasePlan.operationId)
    ) {
      throw currentError(
        'DEPENDENCY_FILE_RELEASE_PLAN_INVALID',
        'release review is missing or malformed'
      );
    }
    for (const file of releasePlan.files) {
      if (
        !(
          object(file) &&
          Number.isSafeInteger(file.index) &&
          safeRelative(file.relativePath) &&
          safeRelative(file.temporaryRelativePath) &&
          file.relativePath !== file.temporaryRelativePath &&
          validFingerprint(
            file.originalFingerprint,
            file.temporaryRelativePath
          ) &&
          validFingerprint(file.installedFingerprint, file.relativePath)
        )
      ) {
        throw currentError(
          'DEPENDENCY_FILE_RELEASE_PLAN_INVALID',
          'release review contains an unsafe path or fingerprint'
        );
      }
    }
    return releasePlan;
  }

  async function validateReleaseBinding(deps, releasePlan, operation) {
    const { plan } = operation;
    if (
      !sameJson(releasePlan.checkoutIdentity, plan.checkoutIdentity) ||
      releasePlan.inputDigest !== plan.inputDigest ||
      releasePlan.manifestDigest !== digestOf(plan) ||
      releasePlan.planId !== plan.id ||
      !sameJson(releasePlan.storeIdentity, plan.storeIdentity) ||
      releasePlan.files.length !== plan.files.length
    ) {
      throw currentError(
        'DEPENDENCY_FILE_RELEASE_PLAN_INVALID',
        'release review is not bound to its completed operation'
      );
    }
    const checkpoints = await checkpointMap(
      deps.journal,
      operation.operation.id
    );
    for (let index = 0; index < plan.files.length; index += 1) {
      const planned = plan.files[index];
      const reviewed = releasePlan.files[index];
      const checkpoint = checkpoints.get(planned.index);
      if (
        reviewed.index !== planned.index ||
        reviewed.relativePath !== planned.relativePath ||
        reviewed.temporaryRelativePath !== planned.temporaryRelativePath ||
        !checkpoint?.retainedFingerprint ||
        !checkpoint?.stagedFingerprint ||
        !['verified', 'released'].includes(checkpoint.phase) ||
        (checkpoint.releasePlanId !== undefined &&
          checkpoint.releasePlanId !== releasePlan.id) ||
        !sameFile(
          deps.native,
          checkpoint.retainedFingerprint,
          reviewed.originalFingerprint,
          true
        ) ||
        !sameFile(
          deps.native,
          checkpoint.stagedFingerprint,
          reviewed.installedFingerprint,
          true
        ) ||
        !sameAfterExchangeIdentity(
          planned.fingerprint,
          reviewed.originalFingerprint
        )
      ) {
        throw currentError(
          'DEPENDENCY_FILE_RELEASE_PLAN_INVALID',
          'release review file identities do not match the operation journal'
        );
      }
    }
    return checkpoints;
  }

  async function release(target, request = EMPTY) {
    let releaseContext;
    try {
      // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Release removes only reviewed exact backups, rechecks each target, and checkpoints every unlink so interruptions remain recoverable.
      return await withServiceTargetLock(target, async () => {
        const deps = await dependencies();
        const releasePlan = await loadReleasePlan(
          deps,
          target,
          request.releaseId
        );
        const recovery = {
          operationId: releasePlan.operationId,
          planId: releasePlan.operationId,
          releaseId: releasePlan.id,
        };
        releaseContext = { deps, recovery };
        if (request.confirmation !== releasePlan.id) {
          return failure(
            'CONFIRMATION_REQUIRED',
            'Confirm the exact retained-original release review before removing any file.',
            { ...recovery, confirmation: releasePlan.id }
          );
        }
        const operation = await operationForRelease(
          deps,
          target,
          releasePlan.operationId
        );
        releaseContext.operation = operation;
        if (operation.operation.state === 'conflict') {
          return failure(
            'DEPENDENCY_FILE_CONFLICT',
            'The owning dependency operation is conflicted; no retained file was removed.',
            { ...recovery, state: 'conflict' }
          );
        }
        const checkpoints = await validateReleaseBinding(
          deps,
          releasePlan,
          operation
        );
        await assertPlanCurrent(deps, target, operation.plan, 'release');
        releaseContext.removedCount = 0;
        try {
          for (const [position, file] of releasePlan.files.entries()) {
            if (position > 0 && position % 32 === 0) {
              // biome-ignore lint/performance/noAwaitInLoops: Revalidation runs once per fixed 32-file batch.
              await assertPlanCurrent(deps, target, operation.plan, 'release');
            }
            const checkpoint = checkpoints.get(file.index);
            const [targetFile, backupFile] = await Promise.all([
              fileObservation(deps.native, target.wtDir, file.relativePath),
              fileObservation(
                deps.native,
                target.wtDir,
                file.temporaryRelativePath
              ),
            ]);
            if (
              !targetFile.exists ||
              targetFile.invalid ||
              !sameFile(
                deps.native,
                file.installedFingerprint,
                targetFile.fingerprint,
                true
              )
            ) {
              throw currentError(
                'DEPENDENCY_FILE_RELEASE_DRIFT',
                'installed target changed after release review'
              );
            }
            if (checkpoint?.phase === 'released' && !backupFile.exists) {
              continue;
            }
            if (
              !backupFile.exists &&
              checkpoint?.phase === 'verified' &&
              checkpoint?.releasePlanId === releasePlan.id
            ) {
              await assertNativeReady(deps.native);
              await guard(target, 'release', operation.operation.id);
              const backupAbsolute = join(
                target.wtDir,
                ...file.temporaryRelativePath.split('/')
              );
              assertEffect(
                await deps.native.syncDependencyDirectory(
                  dirname(backupAbsolute)
                ),
                'DEPENDENCY_FILE_SYNC_FAILED',
                'synced'
              );
              await deps.journal.checkpoint(
                operation.operation.id,
                file.index,
                {
                  originalFingerprint: checkpoint.originalFingerprint,
                  phase: 'released',
                  relativePath: file.relativePath,
                  releasePlanId: releasePlan.id,
                  retainedFingerprint: file.originalFingerprint,
                  stagedFingerprint: file.installedFingerprint,
                  temporaryRelativePath: file.temporaryRelativePath,
                }
              );
              checkpoints.set(file.index, { ...checkpoint, phase: 'released' });
              releaseContext.removedCount += 1;
              continue;
            }
            if (
              !backupFile.exists ||
              backupFile.invalid ||
              !sameFile(
                deps.native,
                file.originalFingerprint,
                backupFile.fingerprint,
                true
              ) ||
              checkpoint?.phase !== 'verified' ||
              (checkpoint.releasePlanId !== undefined &&
                checkpoint.releasePlanId !== releasePlan.id)
            ) {
              throw currentError(
                'DEPENDENCY_FILE_RELEASE_DRIFT',
                'retained backup changed after release review'
              );
            }
            await assertNativeReady(deps.native);
            await guard(target, 'release', operation.operation.id);
            const releaseIntent = checkpointPayload({
              ...checkpoint,
              releasePlanId: releasePlan.id,
            });
            const savedReleaseIntent = await deps.journal.checkpoint(
              operation.operation.id,
              file.index,
              releaseIntent
            );
            checkpoints.set(file.index, savedReleaseIntent);
            await assertNativeReady(deps.native);
            await guard(target, 'release', operation.operation.id);
            try {
              const removed = await deps.native.removeDependencyBackup(
                target.wtDir,
                file.temporaryRelativePath,
                file.originalFingerprint
              );
              assertEffect(
                removed,
                'DEPENDENCY_FILE_OPERATION_UNKNOWN',
                'removed'
              );
            } catch (cause) {
              throw currentError(
                'DEPENDENCY_FILE_OPERATION_UNKNOWN',
                'retained backup removal outcome is uncertain',
                cause
              );
            }
            const remains = await fileObservation(
              deps.native,
              target.wtDir,
              file.temporaryRelativePath
            );
            if (remains.exists) {
              throw currentError(
                'DEPENDENCY_FILE_OPERATION_UNKNOWN',
                'backup removal outcome could not be confirmed'
              );
            }
            releaseContext.removedCount += 1;
            const backupAbsolute = join(
              target.wtDir,
              ...file.temporaryRelativePath.split('/')
            );
            assertEffect(
              await deps.native.syncDependencyDirectory(
                dirname(backupAbsolute)
              ),
              'DEPENDENCY_FILE_SYNC_FAILED',
              'synced'
            );
            await deps.journal.checkpoint(operation.operation.id, file.index, {
              originalFingerprint: checkpoint.originalFingerprint,
              phase: 'released',
              relativePath: file.relativePath,
              releasePlanId: releasePlan.id,
              retainedFingerprint: file.originalFingerprint,
              stagedFingerprint: file.installedFingerprint,
              temporaryRelativePath: file.temporaryRelativePath,
            });
            checkpoints.set(file.index, {
              ...checkpoint,
              phase: 'released',
            });
          }
          await assertPlanCurrent(deps, target, operation.plan, 'release');
          await guard(target, 'release', operation.operation.id);
          const summary = await deps.journal.finish(operation.operation.id, {
            state: 'released',
          });
          try {
            await guard(target, 'release', operation.operation.id);
            await deps.journal.setView(
              { name: target.name, repo: target.repo },
              summary
            );
          } catch {
            return failure(
              'DEPENDENCY_FILE_VIEW_SUMMARY_UNKNOWN',
              'Original files were released, but the current view summary could not be recorded.',
              { ...recovery, state: 'released' }
            );
          }
          return { ...recovery, ...summary, ok: true };
        } catch (error) {
          const code = sanitizedCode(
            error instanceof Error ? error.code : undefined
          );
          let stateName = operation.operation.state;
          if (releaseContext.removedCount > 0) {
            stateName = 'partial';
          }
          if (
            code.includes('UNKNOWN') ||
            code === 'DEPENDENCY_FILE_SYNC_FAILED'
          ) {
            stateName = 'unknown';
          }
          if (releaseContext.removedCount > 0 || stateName === 'unknown') {
            await deps.journal
              .finish(operation.operation.id, {
                code,
                state: stateName,
              })
              // biome-ignore lint/suspicious/noEmptyBlockStatements: This follow-up is best effort; the operation result already preserves the primary partial or unknown outcome.
              .catch(() => {});
          }
          return failure(code, publicError({ code }).error, {
            ...recovery,
            state: stateName,
          });
        }
      });
    } catch (error) {
      if (releaseContext?.recovery) {
        return failure(
          sanitizedCode(
            error instanceof Error ? error.code : undefined,
            'DEPENDENCY_FILE_OPERATION_UNKNOWN'
          ),
          publicError(error, 'DEPENDENCY_FILE_OPERATION_UNKNOWN').error,
          { ...releaseContext.recovery, state: 'unknown' }
        );
      }
      return {
        ...publicError(error, 'DEPENDENCY_FILE_OPERATION_UNKNOWN'),
        ...(typeof request.releaseId === 'string'
          ? { releaseId: request.releaseId }
          : {}),
      };
    }
  }

  return Object.freeze({
    apply,
    enrollFresh,
    prepare,
    prepareRelease,
    recover,
    release,
    status,
  });
}
