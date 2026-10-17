import { lstat, readdir } from 'node:fs/promises';
import { resolve, sep } from 'node:path';

const categories = new Set([
  'source',
  'dependencies',
  'generated',
  'downloads',
  'live-store',
]);

const copy = (value) => JSON.parse(JSON.stringify(value));

function inode(stat) {
  return `${stat.dev}:${stat.ino}`;
}

function allocation(stat) {
  const blocks = Number(stat.blocks);
  return Number.isSafeInteger(blocks) && blocks >= 0 ? blocks * 512 : null;
}

function errorCode(error) {
  return error?.code === 'ELOOP' ? 'SYMLINK_UNSUPPORTED' : 'UNREADABLE';
}

function validConsumer(value) {
  return (
    value &&
    typeof value.repo === 'string' &&
    value.repo.length > 0 &&
    typeof value.name === 'string' &&
    value.name.length > 0
  );
}

function normalizeRoots(roots) {
  if (!Array.isArray(roots)) {
    throw new TypeError('roots must be an array');
  }
  const byPath = new Map();
  const ids = new Set();
  for (const root of roots) {
    if (
      !root ||
      typeof root.id !== 'string' ||
      !root.id ||
      ids.has(root.id) ||
      typeof root.path !== 'string' ||
      !root.path ||
      !categories.has(root.category)
    ) {
      throw new TypeError('invalid storage root');
    }
    ids.add(root.id);
    const path = resolve(root.path);
    const consumers = (root.consumers ?? []).filter(validConsumer);
    const existing = byPath.get(path);
    if (existing) {
      existing.consumers.push(...consumers);
      continue;
    }
    byPath.set(path, {
      category: root.category,
      consumers,
      id: root.id,
      path,
    });
  }
  for (const root of byPath.values()) {
    const unique = new Map();
    for (const consumer of root.consumers) {
      unique.set(`${consumer.repo}\0${consumer.name}`, {
        name: consumer.name,
        repo: consumer.repo,
      });
    }
    root.consumers = [...unique.values()];
  }
  return [...byPath.values()].sort((a, b) => a.path.localeCompare(b.path));
}

function nestedRoots(roots, root) {
  const prefix = `${root.path}${sep}`;
  return roots
    .filter((candidate) => candidate.path.startsWith(prefix))
    .map((candidate) => candidate.path);
}

// Directory totals are observations only. On APFS they do not imply that
// deleting this root would release the same number of physical bytes.
export function createWorkspaceStorage({
  roots = [],
  now = Date.now,
  lstatPath = lstat,
  readdirPath = readdir,
  schedule = setTimeout,
  cancel = clearTimeout,
  timeoutMs = 5000,
  entryLimit = 25_000,
  cacheTtlMs = 15 * 60_000,
} = {}) {
  if (!(Number.isInteger(timeoutMs) && timeoutMs > 0)) {
    throw new TypeError('timeoutMs must be a positive integer');
  }
  if (!(Number.isInteger(entryLimit) && entryLimit > 0)) {
    throw new TypeError('entryLimit must be a positive integer');
  }
  const configured = normalizeRoots(roots);
  const byId = new Map(configured.map((root) => [root.id, root]));
  const cached = new Map();
  const pending = new Map();

  async function scan(root, seen) {
    const errors = new Set();
    const excluded = new Set(nestedRoots(configured, root));
    let logicalBytes = 0;
    let allocatedBytes = 0;
    let allocationKnown = true;
    let entries = 0;
    let skippedSymlinks = 0;
    let partial = false;
    let rootRead = false;

    const finish = (state) => ({
      allocatedBytes:
        state === 'unknown' || !allocationKnown ? null : allocatedBytes,
      category: root.category,
      complete: state === 'ready',
      consumers: root.consumers,
      // Independent root readings cannot establish a cross-root physical total.
      crossRootPhysicalBytes: null,
      entries,
      errors: [...errors],
      id: root.id,
      logicalBytes: state === 'unknown' ? null : logicalBytes,
      observedAt: now(),
      path: root.path,
      skippedSymlinks,
      state,
    });
    const stop = (code) => {
      partial = true;
      errors.add(code);
    };
    const expired = () => now() - startedAt >= timeoutMs;
    const startedAt = now();

    function inspectItem(item, isRoot) {
      if (item.isSymbolicLink()) {
        skippedSymlinks += 1;
        if (isRoot) {
          throw Object.assign(new Error('symbolic storage root'), {
            code: 'ELOOP',
          });
        }
        return false;
      }
      const key = inode(item);
      if (seen.has(key)) {
        return false;
      }
      seen.add(key);
      if (item.isFile()) {
        logicalBytes += Number(item.size);
        const bytes = allocation(item);
        if (bytes === null) {
          allocationKnown = false;
        } else {
          allocatedBytes += bytes;
        }
        return false;
      }
      return item.isDirectory();
    }

    async function childrenFor(path, isRoot) {
      try {
        const children = await readdirPath(path, { withFileTypes: true });
        rootRead ||= isRoot;
        return children;
      } catch (error) {
        if (isRoot) {
          throw error;
        }
        stop(errorCode(error));
        return null;
      }
    }

    async function visitChildren(path, children) {
      for (const child of children) {
        if (partial || expired()) {
          stop('TIME_LIMIT');
          return;
        }
        const childPath = resolve(path, child.name);
        if (excluded.has(childPath)) {
          continue;
        }
        if (entries >= entryLimit) {
          stop('ENTRY_LIMIT');
          return;
        }
        entries += 1;
        // biome-ignore lint/performance/noAwaitInLoops: Recursive scans share entry limits, time limits, and inode accounting in traversal order.
        await visit(childPath);
      }
    }

    async function visit(path, isRoot = false) {
      if (partial || expired()) {
        stop('TIME_LIMIT');
        return;
      }
      let item;
      try {
        item = await lstatPath(path);
      } catch (error) {
        if (isRoot) {
          throw error;
        }
        stop(errorCode(error));
        return;
      }
      if (!inspectItem(item, isRoot)) {
        return;
      }
      const children = await childrenFor(path, isRoot);
      if (children) {
        await visitChildren(path, children);
      }
    }

    try {
      await visit(root.path, true);
      return finish(partial ? 'partial' : 'ready');
    } catch (error) {
      errors.add(errorCode(error));
      return finish(rootRead ? 'partial' : 'unknown');
    }
  }

  function resultFor(root, sharedSeen = new Set(), { refresh = false } = {}) {
    const existing = pending.get(root.id);
    if (existing) {
      return existing.result;
    }
    const current = cached.get(root.id);
    if (!refresh && current && now() - current.observedAt < cacheTtlMs) {
      return Promise.resolve(copy(current));
    }
    const started = scan(root, sharedSeen).catch(() => ({
      allocatedBytes: null,
      category: root.category,
      complete: false,
      consumers: root.consumers,
      crossRootPhysicalBytes: null,
      entries: 0,
      errors: ['UNREADABLE'],
      id: root.id,
      logicalBytes: null,
      observedAt: now(),
      path: root.path,
      skippedSymlinks: 0,
      state: 'unknown',
    }));
    let timeout;
    const result = Promise.race([
      started,
      new Promise((resolveTimeout) => {
        timeout = schedule(
          () =>
            resolveTimeout({
              allocatedBytes: null,
              category: root.category,
              complete: false,
              consumers: root.consumers,
              crossRootPhysicalBytes: null,
              entries: 0,
              errors: ['TIME_LIMIT'],
              id: root.id,
              logicalBytes: null,
              observedAt: now(),
              path: root.path,
              skippedSymlinks: 0,
              state: 'partial',
            }),
          timeoutMs
        );
      }),
    ]).then((observation) => {
      cancel(timeout);
      cached.set(root.id, observation);
      return copy(observation);
    });
    pending.set(root.id, { result });
    started.finally(() => {
      if (pending.get(root.id)?.result === result) {
        pending.delete(root.id);
      }
    });
    return result;
  }

  function rootFor(id) {
    const root = byId.get(typeof id === 'string' ? id : id?.id);
    if (!root) {
      throw new TypeError('unknown storage root');
    }
    return root;
  }

  return {
    observe(id) {
      return resultFor(rootFor(id));
    },
    async observeAll() {
      const seen = new Set();
      const observations = [];
      for (const root of configured) {
        // Sequential observations make the batch inode set deterministic.
        // biome-ignore lint/performance/noAwaitInLoops: Roots share one inode set, so each scan must complete before the next reuses it.
        observations.push(await resultFor(root, seen, { refresh: true }));
      }
      return observations;
    },
    async observeSelected(ids) {
      if (!Array.isArray(ids) || ids.length === 0) {
        throw new TypeError('storage root ids must be a non-empty array');
      }
      const selected = [];
      const selectedIds = new Set();
      for (const id of ids) {
        const root = rootFor(id);
        if (!selectedIds.has(root.id)) {
          selectedIds.add(root.id);
          selected.push(root);
        }
      }
      // This is deliberately the same batch observer as observeAll: a known
      // target may have nested dependency/generated roots and hardlinks across
      // them, so independent observations would double-count allocated bytes.
      const seen = new Set();
      const observations = [];
      for (const root of selected) {
        // biome-ignore lint/performance/noAwaitInLoops: Selected roots share the same inode set for non-duplicated allocation totals.
        observations.push(await resultFor(root, seen, { refresh: true }));
      }
      return observations;
    },
    read(id) {
      const value = cached.get(rootFor(id).id);
      return value ? copy(value) : undefined;
    },
    readAll() {
      return configured.flatMap((root) => {
        const value = cached.get(root.id);
        return value ? [copy(value)] : [];
      });
    },
  };
}
