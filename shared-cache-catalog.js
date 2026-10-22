import { realpath as nativeRealpath } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';

const cacheKinds = new Set(['package-store', 'download-cache', 'task-cache']);

function validCache(row) {
  return (
    row &&
    cacheKinds.has(row.kind) &&
    typeof row.path === 'string' &&
    isAbsolute(row.path)
  );
}

function consumerSet(checkout) {
  return new Set(
    typeof checkout === 'string' && isAbsolute(checkout) ? [checkout] : []
  );
}

function cacheEntry(row, checkout) {
  return validCache(row)
    ? { consumers: consumerSet(checkout), kind: row.kind, path: row.path }
    : null;
}

function configuredEntries(config, dependencyViews) {
  const sharing = config?.dependencySharing;
  const entries = [];
  if (sharing?.storeRoot !== undefined) {
    if (
      typeof sharing.storeRoot !== 'string' ||
      !isAbsolute(sharing.storeRoot)
    ) {
      throw new TypeError('Shared cache storeRoot must be an absolute path');
    }
    const consumerRows = dependencyViews?.consumers ?? {};
    if (
      !consumerRows ||
      typeof consumerRows !== 'object' ||
      Array.isArray(consumerRows)
    ) {
      throw new TypeError(
        'Shared cache dependency consumers must be an object'
      );
    }
    const records = Object.values(consumerRows);
    const checkouts = records.flatMap((record) => [
      ...consumerSet(record?.checkout),
    ]);
    entries.push({
      consumers: new Set(checkouts),
      incomplete: checkouts.length !== records.length,
      kind: 'package-store',
      path: sharing.storeRoot,
    });
  }
  if (
    config?.sharedCaches !== undefined &&
    !Array.isArray(config.sharedCaches)
  ) {
    throw new TypeError('Shared cache configuration must be an array');
  }
  for (const row of config?.sharedCaches ?? []) {
    const entry = cacheEntry(row);
    if (!entry) {
      throw new TypeError(
        'Shared cache entries must have an absolute path and valid kind'
      );
    }
    entries.push(entry);
  }
  return entries;
}

function hoistedEntries(document) {
  const object = (value) =>
    value && typeof value === 'object' && !Array.isArray(value);
  if (!object(document) || document.version !== 1 || !object(document.views)) {
    throw new TypeError('Hoisted dependency view metadata is invalid');
  }
  return Object.values(document.views).map((view) => {
    const checkout = view?.checkoutIdentity?.checkoutPath;
    const root = view?.storeIdentity?.root;
    if (
      view?.mode !== 'hoisted-cow' ||
      typeof view.state !== 'string' ||
      typeof checkout !== 'string' ||
      !isAbsolute(checkout) ||
      typeof root !== 'string' ||
      !isAbsolute(root)
    ) {
      throw new TypeError('Hoisted dependency view metadata is invalid');
    }
    return {
      consumers: new Set([checkout]),
      incomplete: !['completed', 'released'].includes(view.state),
      kind: 'package-store',
      path: root,
    };
  });
}

async function projectEntries(registrations, readProjectConfig) {
  if (!Array.isArray(registrations)) {
    throw new TypeError('Shared cache catalog registry must be an array');
  }
  const rows = await Promise.all(
    registrations.map(async (registration) => {
      const caches =
        registration?.caches ?? (await readProjectConfig(registration));
      if (!Array.isArray(caches)) {
        throw new TypeError(
          'Project shared cache configuration must be an array'
        );
      }
      return caches.map((cache) => {
        const entry = cacheEntry(cache, registration?.checkout);
        if (!entry) {
          throw new TypeError(
            'Project shared cache entries must have an absolute path and valid kind'
          );
        }
        return entry;
      });
    })
  );
  return rows.flat();
}

async function canonicalConsumer(consumer, realpathPath) {
  try {
    return { incomplete: false, path: await realpathPath(consumer) };
  } catch (error) {
    // Keep explicit metadata for checkouts that are not currently on disk;
    // resolve() still removes lexical aliases such as /a/./b.
    return { incomplete: error.code !== 'ENOENT', path: resolve(consumer) };
  }
}

function canonicalEntries(entries, realpathPath) {
  return Promise.all(
    entries.map(async (entry) => {
      let { path } = entry;
      let incomplete = entry.incomplete === true;
      try {
        path = await realpathPath(entry.path);
      } catch {
        incomplete = true;
      }
      const consumers = await Promise.all(
        [...entry.consumers].map((consumer) =>
          canonicalConsumer(consumer, realpathPath)
        )
      );
      return {
        ...entry,
        consumers: new Set(consumers.map((consumer) => consumer.path)),
        incomplete:
          incomplete || consumers.some((consumer) => consumer.incomplete),
        path,
      };
    })
  );
}

function catalogRows(entries) {
  const stores = new Map();
  for (const entry of entries) {
    const key = `${entry.kind}:${entry.path}`;
    const current = stores.get(key) ?? {
      consumers: new Set(),
      incomplete: false,
      kind: entry.kind,
      path: entry.path,
    };
    for (const consumer of entry.consumers) {
      current.consumers.add(consumer);
    }
    current.incomplete ||= entry.incomplete === true;
    stores.set(key, current);
  }
  return [...stores.values()]
    .map((store) => ({
      consumers: [...store.consumers].sort(),
      incomplete: store.incomplete || store.consumers.size === 0,
      kind: store.kind,
      path: store.path,
    }))
    .sort(
      (a, b) => a.path.localeCompare(b.path) || a.kind.localeCompare(b.kind)
    );
}

// The caller supplies only registered checkout roots and explicitly configured
// cache paths. This module deliberately has no home-directory discovery path.
export function createSharedCacheCatalog({
  readConfig,
  readDependencyViews = async () => ({}),
  readDependencyFiles = async () => ({ version: 1, views: {} }),
  readRegistry,
  readProjectConfig = async () => [],
  realpathPath = nativeRealpath,
} = {}) {
  if (typeof readConfig !== 'function' || typeof readRegistry !== 'function') {
    throw new Error(
      'Shared cache catalog requires readConfig and readRegistry'
    );
  }

  async function list() {
    const [config, dependencyViews, dependencyFiles, registrations] =
      await Promise.all([
        readConfig(),
        readDependencyViews(),
        readDependencyFiles(),
        readRegistry(),
      ]);
    const entries = [
      ...configuredEntries(config, dependencyViews),
      ...hoistedEntries(dependencyFiles),
      ...(await projectEntries(registrations, readProjectConfig)),
    ];
    return {
      ok: true,
      stores: catalogRows(await canonicalEntries(entries, realpathPath)),
    };
  }

  return { list };
}
