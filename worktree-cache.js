import { createHash } from 'node:crypto';
import nativeFs from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { inspectCheckoutIdentity } from './checkout-identity.js';

const generatedRoots = ['.next/cache', '.next/dev/cache/turbopack'];
const object = (value) =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const exact = (left, right) => JSON.stringify(left) === JSON.stringify(right);
const sameEntry = (left, right) =>
  left.type === 'directory'
    ? ['path', 'type', 'birthtimeNs', 'dev', 'ino'].every(
        (key) => left[key] === right[key]
      )
    : exact(left, right);
const freeze = (value) => {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) {
      freeze(child);
    }
    Object.freeze(value);
  }
  return value;
};
const problem = (code, error) => ({ code, error, ok: false });
const keysExactly = (value, keys) =>
  object(value) &&
  Object.keys(value).length === keys.length &&
  Object.keys(value).every((key) => keys.includes(key));

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

function entryIdentity(stat, type) {
  if (
    typeof stat.birthtimeNs !== 'bigint' ||
    stat.birthtimeNs <= 0n ||
    stat.ino <= 0n ||
    stat.dev < 0n ||
    typeof stat.mtimeNs !== 'bigint'
  ) {
    throw Object.assign(new Error('Filesystem identity is unavailable'), {
      code: 'IDENTITY_UNKNOWN',
    });
  }
  return {
    birthtimeNs: String(stat.birthtimeNs),
    dev: String(stat.dev),
    ino: String(stat.ino),
    mtimeNs: String(stat.mtimeNs),
    size: String(stat.size),
    type,
  };
}

function below(root, path) {
  const value = relative(root, path);
  return (
    value &&
    !isAbsolute(value) &&
    value !== '..' &&
    !value.startsWith(`..${sep}`)
  );
}

function outputEntry(path, root, stat) {
  if (stat.isSymbolicLink()) {
    throw Object.assign(
      new Error('Generated output contains a symbolic link'),
      { code: 'SYMLINK_REJECTED' }
    );
  }
  const type = stat.isDirectory() ? 'directory' : stat.isFile() ? 'file' : null;
  if (!type) {
    throw Object.assign(new Error('Generated output contains a special file'), {
      code: 'SPECIAL_FILE_REJECTED',
    });
  }
  if (type === 'file' && stat.nlink !== 1n) {
    throw Object.assign(new Error('Generated output file has another link'), {
      code: 'LINKED_FILE_REJECTED',
    });
  }
  const pathParts = relative(root, path).split(sep);
  if (pathParts.some((part) => part === 'node_modules')) {
    throw Object.assign(
      new Error('Generated output reaches a dependency store'),
      { code: 'DEPENDENCY_STORE_REJECTED' }
    );
  }
  if (pathParts.some((part) => part === '.env' || part.startsWith('.env.'))) {
    throw Object.assign(
      new Error('Generated output contains ignored local data'),
      { code: 'LOCAL_DATA_REJECTED' }
    );
  }
  return { path: relative(root, path), ...entryIdentity(stat, type) };
}

function validTarget(target) {
  return (
    object(target) &&
    typeof target.repo === 'string' &&
    typeof target.name === 'string' &&
    typeof target.key === 'string' &&
    typeof target.wtDir === 'string' &&
    isAbsolute(target.wtDir) &&
    typeof target.repoDir === 'string' &&
    isAbsolute(target.repoDir) &&
    target.key === `${target.repo}/${target.name}`
  );
}

function immutableBody(manifest) {
  return {
    checkoutIdentity: manifest.checkoutIdentity,
    entries: manifest.entries,
    head: manifest.head,
    ownership: manifest.ownership,
    registered: manifest.registered,
    roots: manifest.roots,
    runtime: manifest.runtime,
    target: manifest.target,
    version: manifest.version,
  };
}

function hashManifest(manifest) {
  return createHash('sha256')
    .update(canonicalJson(immutableBody(manifest)))
    .digest('hex');
}

function allowedPath(path) {
  return (
    typeof path === 'string' &&
    path &&
    !isAbsolute(path) &&
    !path.split(sep).some((part) => !part || part === '.' || part === '..') &&
    generatedRoots.some(
      (root) => path === root || path.startsWith(`${root}${sep}`)
    )
  );
}

function entryValid(entry) {
  return (
    keysExactly(entry, [
      'path',
      'birthtimeNs',
      'dev',
      'ino',
      'mtimeNs',
      'size',
      'type',
    ]) &&
    allowedPath(entry.path) &&
    ['file', 'directory'].includes(entry.type) &&
    ['birthtimeNs', 'dev', 'ino', 'mtimeNs', 'size'].every(
      (key) => typeof entry[key] === 'string' && /^\d+$/.test(entry[key])
    ) &&
    entry.ino !== '0' &&
    entry.birthtimeNs !== '0'
  );
}

function validManifest(manifest, id) {
  if (
    !(
      object(manifest) &&
      manifest.version === 1 &&
      manifest.id === id &&
      typeof manifest.immutableHash === 'string' &&
      /^[a-f0-9]{64}$/.test(manifest.immutableHash) &&
      manifest.id === manifest.immutableHash &&
      manifest.immutableHash === hashManifest(manifest) &&
      ['prepared', 'partial', 'completed'].includes(manifest.status) &&
      validTarget(manifest.target) &&
      manifest.checkoutIdentity?.known === true &&
      typeof manifest.head === 'string' &&
      typeof manifest.registered === 'boolean' &&
      keysExactly(manifest.ownership, ['state']) &&
      typeof manifest.ownership.state === 'string' &&
      keysExactly(manifest.runtime, ['queued', 'state']) &&
      typeof manifest.runtime.state === 'string' &&
      typeof manifest.runtime.queued === 'boolean' &&
      Array.isArray(manifest.entries) &&
      Array.isArray(manifest.roots) &&
      Array.isArray(manifest.removedPaths)
    )
  ) {
    return false;
  }
  if (
    manifest.roots.length !== generatedRoots.length ||
    manifest.roots.some(
      (root, index) =>
        !keysExactly(root, ['exists', 'path']) ||
        root.path !== generatedRoots[index] ||
        typeof root.exists !== 'boolean'
    )
  ) {
    return false;
  }
  const paths = new Set();
  if (
    manifest.entries.some(
      (entry) =>
        !entryValid(entry) || paths.has(entry.path) || !paths.add(entry.path)
    )
  ) {
    return false;
  }
  for (const root of manifest.roots) {
    const beneathRoot = manifest.entries.filter(
      (entry) =>
        entry.path === root.path || entry.path.startsWith(`${root.path}${sep}`)
    );
    if (
      root.exists !== beneathRoot.length > 0 ||
      (root.exists &&
        !beneathRoot.some(
          (entry) => entry.path === root.path && entry.type === 'directory'
        ))
    ) {
      return false;
    }
  }
  for (const entry of manifest.entries) {
    const parent = dirname(entry.path);
    if (
      entry.path !== generatedRoots.find((root) => entry.path === root) &&
      !manifest.entries.some(
        (candidate) =>
          candidate.path === parent && candidate.type === 'directory'
      )
    ) {
      return false;
    }
  }
  const removed = new Set();
  if (
    manifest.removedPaths.some(
      (path) => !paths.has(path) || removed.has(path) || !removed.add(path)
    )
  ) {
    return false;
  }
  if (manifest.status === 'prepared') {
    return !manifest.removedPaths.length && manifest.retryId === undefined;
  }
  if (manifest.status === 'partial') {
    return typeof manifest.retryId === 'string' && manifest.retryId.length > 0;
  }
  return manifest.entries.every((entry) => removed.has(entry.path));
}

function sameEntries(left, right, partial) {
  return (
    left.length === right.length &&
    left.every((entry, index) =>
      partial ? sameEntry(entry, right[index]) : exact(entry, right[index])
    )
  );
}

export function createWorktreeCache({
  state,
  manifests,
  fs = nativeFs,
  checkoutIdentity = (target) => inspectCheckoutIdentity(target, fs),
  gitHead,
  trackedPaths,
  ownership = async () => ({ state: 'unknown' }),
  runtime = async () => ({ state: 'unknown' }),
  now = Date.now,
  randomId,
  maxEntries = 25_000,
  maxScanMs = 5000,
  remove = async (entry, operations) =>
    entry.type === 'file'
      ? operations.unlink(entry.path)
      : operations.rmdir(entry.path),
} = {}) {
  if (
    !(
      state?.withTargets &&
      state?.read &&
      manifests?.get &&
      manifests?.save &&
      manifests?.update &&
      gitHead &&
      trackedPaths &&
      randomId &&
      Number.isInteger(maxEntries)
    ) ||
    maxEntries < 1 ||
    !Number.isFinite(maxScanMs) ||
    maxScanMs < 0
  ) {
    throw new Error(
      'createWorktreeCache requires state, manifests, Git readers, and a retry id generator'
    );
  }

  function scanBudget() {
    const deadline = now() + maxScanMs;
    let count = 0;
    return {
      check(add = 0) {
        if (count + add > maxEntries || now() > deadline) {
          throw Object.assign(
            new Error('Generated-output scan is incomplete'),
            { code: 'SCAN_INCOMPLETE' }
          );
        }
        count += add;
      },
    };
  }

  async function namesIn(directory, budget) {
    const names = [];
    const handle = await fs.opendir(directory);
    try {
      for await (const entry of handle) {
        budget.check(0);
        names.push(entry.name);
      }
    } finally {
      try {
        await handle.close();
      } catch {
        /* Async iteration may already have closed the directory handle. */
      }
    }
    return names.sort();
  }

  function registered(target) {
    const ports = state.read('ports');
    if (!Array.isArray(ports)) {
      return { state: 'unknown' };
    }
    const row = ports.find((value) => value.key === target.key);
    if (!row) {
      return { state: 'unregistered' };
    }
    return row.repo === target.repo &&
      row.name === target.name &&
      row.port === target.port
      ? { state: 'registered' }
      : { state: 'unknown' };
  }

  async function assertAncestors(checkout, path) {
    let current = checkout;
    for (const part of relative(checkout, path).split(sep)) {
      current = join(current, part);
      const stat = await fs.lstat(current, { bigint: true });
      if (stat.isSymbolicLink()) {
        throw Object.assign(
          new Error('Generated output has a symbolic-link ancestor'),
          { code: 'SYMLINK_REJECTED' }
        );
      }
      if (!stat.isDirectory()) {
        throw Object.assign(
          new Error('Generated output ancestor is not a directory'),
          { code: 'SPECIAL_FILE_REJECTED' }
        );
      }
    }
  }

  async function scan(target, identity) {
    const budget = scanBudget();
    const checkout = identity.checkoutPath;
    const rootStat = await fs.lstat(checkout, { bigint: true });
    if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
      throw Object.assign(new Error('Checkout is not a direct directory'), {
        code: 'IDENTITY_CHANGED',
      });
    }
    const roots = [];
    const entries = [];
    for (const generated of generatedRoots) {
      budget.check(1);
      const path = resolve(checkout, generated);
      if (!below(checkout, path)) {
        throw Object.assign(
          new Error('Generated output escaped the checkout'),
          { code: 'PATH_OUTSIDE_CHECKOUT' }
        );
      }
      let stat;
      try {
        stat = await fs.lstat(path, { bigint: true });
      } catch (error) {
        if (error.code === 'ENOENT') {
          roots.push({ exists: false, path: generated });
          continue;
        }
        throw error;
      }
      await assertAncestors(checkout, path);
      const root = outputEntry(path, checkout, stat);
      if (root.type !== 'directory') {
        throw Object.assign(
          new Error('Generated output root is not a directory'),
          { code: 'SPECIAL_FILE_REJECTED' }
        );
      }
      const listed = [];
      async function visit(directory) {
        const names = await namesIn(directory, budget);
        for (const name of names) {
          const child = join(directory, name);
          if (!below(path, child)) {
            throw Object.assign(
              new Error('Generated output escaped its exact root'),
              { code: 'PATH_OUTSIDE_CHECKOUT' }
            );
          }
          const childStat = await fs.lstat(child, { bigint: true });
          const entry = outputEntry(child, checkout, childStat);
          listed.push(entry);
          if (entry.type === 'directory') {
            await visit(child);
          }
        }
      }
      await visit(path);
      const all = [root, ...listed];
      roots.push({ exists: true, path: generated });
      entries.push(...all);
    }
    const tracked = await trackedPaths(target, generatedRoots);
    if (
      !(
        object(tracked) &&
        ['clean', 'tracked', 'unknown'].includes(tracked.state)
      )
    ) {
      throw Object.assign(
        new Error('Tracked-path observation is unavailable'),
        { code: 'TRACKING_UNKNOWN' }
      );
    }
    if (tracked.state === 'unknown') {
      throw Object.assign(
        new Error('Tracked-path observation is unavailable'),
        { code: 'TRACKING_UNKNOWN' }
      );
    }
    if (tracked.state === 'tracked') {
      throw Object.assign(
        new Error('Generated output includes a tracked source path'),
        { code: 'SOURCE_PATH_REJECTED' }
      );
    }
    return {
      entries: entries.sort((a, b) => a.path.localeCompare(b.path)),
      roots,
    };
  }

  async function current(target) {
    const identity = await checkoutIdentity(target);
    if (!identity?.known) {
      return problem(
        'IDENTITY_UNKNOWN',
        'Checkout identity cannot be established'
      );
    }
    const head = await gitHead(target);
    if (
      !head ||
      head.state !== 'known' ||
      typeof head.value !== 'string' ||
      !head.value
    ) {
      return problem('HEAD_UNKNOWN', 'Checkout HEAD cannot be established');
    }
    try {
      return {
        head: head.value,
        identity,
        ...(await scan(target, identity)),
        ok: true,
      };
    } catch (error) {
      return problem(
        error.code ?? 'CACHE_SCAN_FAILED',
        'Generated output cannot be safely prepared'
      );
    }
  }

  async function verify(manifest, identity) {
    const budget = scanBudget();
    const remaining = manifest.entries.filter(
      (entry) => !manifest.removedPaths.includes(entry.path)
    );
    const actual = [];
    try {
      for (const root of manifest.roots) {
        budget.check(0);
        const path = resolve(identity.checkoutPath, root.path);
        const expectedRoot =
          root.exists &&
          remaining.some(
            (entry) =>
              entry.path === root.path ||
              entry.path.startsWith(`${root.path}${sep}`)
          );
        try {
          await fs.lstat(path, { bigint: true });
          if (!expectedRoot) {
            return { code: 'CACHE_CHANGED', ok: false };
          }
          await assertAncestors(identity.checkoutPath, path);
        } catch (error) {
          if (error.code === 'ENOENT' && !expectedRoot) {
            continue;
          }
          return {
            code:
              error.code === 'SCAN_INCOMPLETE' ? error.code : 'CACHE_CHANGED',
            ok: false,
          };
        }
      }
      for (const entry of remaining) {
        budget.check(1);
        const path = resolve(identity.checkoutPath, entry.path);
        try {
          actual.push(
            outputEntry(
              path,
              identity.checkoutPath,
              await fs.lstat(path, { bigint: true })
            )
          );
        } catch {
          return { code: 'CACHE_CHANGED', ok: false };
        }
      }
      if (
        !sameEntries(
          actual.sort((a, b) => a.path.localeCompare(b.path)),
          remaining,
          manifest.status === 'partial'
        )
      ) {
        return { code: 'CACHE_CHANGED', ok: false };
      }
      for (const entry of remaining.filter(
        (value) => value.type === 'directory'
      )) {
        const directory = resolve(identity.checkoutPath, entry.path);
        const names = await namesIn(directory, budget);
        const expectedNames = remaining
          .filter(
            (child) =>
              relative(entry.path, child.path) &&
              !relative(entry.path, child.path).includes(sep)
          )
          .map((child) => relative(entry.path, child.path))
          .sort();
        if (!exact(names, expectedNames)) {
          return { code: 'CACHE_CHANGED', ok: false };
        }
      }
      const tracked = await trackedPaths(manifest.target, generatedRoots);
      return tracked?.state === 'clean'
        ? { ok: true }
        : { code: 'CACHE_CHANGED', ok: false };
    } catch (error) {
      return {
        code: error.code === 'SCAN_INCOMPLETE' ? error.code : 'CACHE_CHANGED',
        ok: false,
      };
    }
  }

  async function prepare(target) {
    if (!validTarget(target)) {
      return problem('INVALID_TARGET', 'Worktree target is invalid');
    }
    const registration = registered(target);
    if (registration.state === 'unknown') {
      return problem(
        'REGISTRATION_UNKNOWN',
        'Worktree registration cannot be established'
      );
    }
    const [initialOwner, initialActivity] = await Promise.all([
      ownership(target),
      runtime(target),
    ]);
    const initialBlock = activityProblem(initialOwner, initialActivity);
    if (initialBlock) {
      return initialBlock;
    }
    const observed = await current(target);
    if (!observed.ok) {
      return observed;
    }
    const [owner, activity] = await Promise.all([
      ownership(target),
      runtime(target),
    ]);
    const publishBlock = activityProblem(owner, activity);
    if (publishBlock) {
      return publishBlock;
    }
    const body = {
      checkoutIdentity: observed.identity,
      entries: observed.entries,
      head: observed.head,
      ownership: {
        state: typeof owner?.state === 'string' ? owner.state : 'unknown',
      },
      registered: registration.state === 'registered',
      roots: observed.roots,
      runtime: {
        queued: activity?.queued === true,
        state: typeof activity?.state === 'string' ? activity.state : 'unknown',
      },
      target: { ...target },
      version: 1,
    };
    const id = hashManifest(body);
    let existing;
    try {
      existing = await manifests.get(id);
    } catch {
      return problem(
        'MANIFEST_STORE_FAILED',
        'Cleanup manifest could not be read safely'
      );
    }
    if (existing) {
      if (!validManifest(existing, id)) {
        return problem(
          'MANIFEST_STORE_FAILED',
          'Cleanup manifest could not be read safely'
        );
      }
      return { manifest: existing, ok: true, registered: existing.registered };
    }
    const manifest = freeze({
      ...body,
      createdAt: now(),
      id,
      immutableHash: id,
      removedPaths: [],
      status: 'prepared',
    });
    try {
      await manifests.save(manifest);
    } catch {
      return problem(
        'MANIFEST_STORE_FAILED',
        'Cleanup manifest could not be recorded'
      );
    }
    return { manifest, ok: true, registered: manifest.registered };
  }

  function confirmationMatches(manifest, id, confirmation) {
    if (manifest.status === 'prepared') {
      return confirmation === id;
    }
    return (
      object(confirmation) &&
      confirmation.manifestId === id &&
      confirmation.retryId === manifest.retryId
    );
  }

  function activityProblem(owner, activity) {
    if (!object(owner) || owner.state === 'unknown') {
      return problem('UNKNOWN_WRITER', 'Writer ownership is unresolved');
    }
    if (owner.state !== 'clear') {
      return problem('ACTIVE_WRITER', 'A writer is active on this worktree');
    }
    if (!object(activity) || activity.state === 'unknown') {
      return problem('RUNTIME_UNKNOWN', 'Runtime ownership is unresolved');
    }
    if (activity.queued === true) {
      return problem('TARGET_QUEUED', 'Worktree is queued to start');
    }
    if (activity.state !== 'stopped') {
      return problem('ACTIVE_RUNTIME', 'A dev server or runtime is active');
    }
    return null;
  }

  async function persistPartial(manifest, removedPaths, code) {
    const retryId = randomId();
    const next = freeze({
      ...manifest,
      lastFailure: code,
      removedPaths,
      retryId,
      status: 'partial',
      updatedAt: now(),
    });
    await manifests.update(manifest.id, () => next);
    return next;
  }

  async function execute(manifestId, confirmation) {
    if (typeof manifestId !== 'string' || !manifestId) {
      return problem('MANIFEST_NOT_FOUND', 'Cleanup manifest was not found');
    }
    let initial;
    try {
      initial = await manifests.get(manifestId);
    } catch {
      return problem(
        'MANIFEST_STORE_FAILED',
        'Cleanup manifest could not be read safely'
      );
    }
    if (!initial) {
      return problem('MANIFEST_NOT_FOUND', 'Cleanup manifest was not found');
    }
    if (!validManifest(initial, manifestId)) {
      return problem('MANIFEST_INVALID', 'Cleanup manifest is invalid');
    }
    let lockEntered = false;
    let knownRemoved = [];
    try {
      return await state.withTargets([initial.target], async () => {
        lockEntered = true;
        const manifest = await manifests.get(manifestId);
        if (!manifest) {
          return problem(
            'MANIFEST_NOT_FOUND',
            'Cleanup manifest was not found'
          );
        }
        if (!validManifest(manifest, manifestId)) {
          return problem('MANIFEST_INVALID', 'Cleanup manifest is invalid');
        }
        if (manifest.status === 'completed') {
          return problem(
            'MANIFEST_ALREADY_EXECUTED',
            'Cleanup manifest was already executed'
          );
        }
        if (!confirmationMatches(manifest, manifestId, confirmation)) {
          return problem(
            'CONFIRMATION_REQUIRED',
            'Confirm this exact cleanup manifest before executing it'
          );
        }
        if (!manifest.registered) {
          return problem(
            'UNREGISTERED_CHECKOUT',
            'Unregistered checkouts are read-only'
          );
        }
        const registration = registered(manifest.target);
        if (registration.state !== 'registered') {
          return problem(
            registration.state === 'unregistered'
              ? 'UNREGISTERED_CHECKOUT'
              : 'REGISTRATION_UNKNOWN',
            'Worktree registration changed before cleanup'
          );
        }
        const [owner, activity] = await Promise.all([
          ownership(manifest.target),
          runtime(manifest.target),
        ]);
        const blocked = activityProblem(owner, activity);
        if (blocked) {
          return blocked;
        }
        const identity = await checkoutIdentity(manifest.target);
        if (!identity?.known) {
          return problem(
            'IDENTITY_UNKNOWN',
            'Checkout identity cannot be established'
          );
        }
        if (!exact(identity, manifest.checkoutIdentity)) {
          return problem(
            'IDENTITY_CHANGED',
            'Checkout identity changed since cleanup was prepared'
          );
        }
        const head = await gitHead(manifest.target);
        if (head?.state !== 'known' || typeof head.value !== 'string') {
          return problem('HEAD_UNKNOWN', 'Checkout HEAD cannot be established');
        }
        if (head.value !== manifest.head) {
          return problem(
            'HEAD_CHANGED',
            'Checkout HEAD changed since cleanup was prepared'
          );
        }
        const remaining = manifest.entries.filter(
          (entry) => !manifest.removedPaths.includes(entry.path)
        );
        const verification = await verify(manifest, identity);
        if (!verification.ok) {
          return problem(
            verification.code,
            verification.code === 'SCAN_INCOMPLETE'
              ? 'Generated output verification is incomplete'
              : 'Generated output changed since cleanup was prepared'
          );
        }
        const removedPaths = [...manifest.removedPaths];
        knownRemoved = removedPaths;
        const rootIndex = (path) =>
          manifest.roots.findIndex(
            (root) =>
              path === root.path || path.startsWith(`${root.path}${sep}`)
          );
        const work = remaining
          .map((entry) => ({
            ...entry,
            path: resolve(manifest.checkoutIdentity.checkoutPath, entry.path),
          }))
          .sort(
            (a, b) =>
              rootIndex(
                relative(manifest.checkoutIdentity.checkoutPath, a.path)
              ) -
                rootIndex(
                  relative(manifest.checkoutIdentity.checkoutPath, b.path)
                ) ||
              b.path.split(sep).length - a.path.split(sep).length ||
              a.path.localeCompare(b.path)
          );
        for (const entry of work) {
          try {
            await assertAncestors(
              manifest.checkoutIdentity.checkoutPath,
              dirname(entry.path)
            );
            const stat = await fs.lstat(entry.path, { bigint: true });
            const currentEntry = outputEntry(
              entry.path,
              manifest.checkoutIdentity.checkoutPath,
              stat
            );
            if (
              !sameEntry(currentEntry, {
                ...entry,
                path: relative(
                  manifest.checkoutIdentity.checkoutPath,
                  entry.path
                ),
              })
            ) {
              throw Object.assign(
                new Error(
                  'Generated output changed while cleanup was executing'
                ),
                { code: 'CACHE_CHANGED' }
              );
            }
            await remove(entry, {
              rmdir: fs.rmdir.bind(fs),
              unlink: fs.unlink.bind(fs),
            });
            removedPaths.push(
              relative(manifest.checkoutIdentity.checkoutPath, entry.path)
            );
            await manifests.update(manifest.id, (saved) =>
              freeze({
                ...saved,
                removedPaths: [...removedPaths],
                updatedAt: now(),
              })
            );
          } catch (error) {
            try {
              const partial = await persistPartial(
                manifest,
                removedPaths,
                error.code ?? 'CLEANUP_FAILED'
              );
              return {
                code: 'CLEANUP_PARTIAL',
                error: 'Cleanup stopped after removing only the recorded paths',
                ok: false,
                removedPaths,
                retryId: partial.retryId,
              };
            } catch {
              return {
                code: 'CLEANUP_OUTCOME_UNKNOWN',
                error: 'Cleanup outcome could not be recorded',
                ok: false,
                removedPaths: [...removedPaths],
              };
            }
          }
        }
        const completed = freeze({
          ...manifest,
          removedPaths,
          status: 'completed',
          updatedAt: now(),
        });
        await manifests.update(manifest.id, () => completed);
        return { ok: true, removedPaths };
      });
    } catch {
      return lockEntered
        ? {
            code: 'CLEANUP_OUTCOME_UNKNOWN',
            error: 'Cleanup outcome could not be recorded',
            ok: false,
            removedPaths: [...knownRemoved],
          }
        : problem(
            'TARGET_LOCK_UNAVAILABLE',
            'Cleanup target lock could not be acquired'
          );
    }
  }

  return Object.freeze({ execute, prepare });
}
