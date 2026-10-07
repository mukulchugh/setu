import { realpath as nativeRealpath } from 'node:fs/promises';
import { isAbsolute } from 'node:path';

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
  if (typeof sharing?.storeRoot === 'string') {
    const consumers = new Set();
    for (const record of Object.values(dependencyViews?.consumers ?? {})) {
      for (const checkout of consumerSet(record?.checkout)) {
        consumers.add(checkout);
      }
    }
    entries.push({ consumers, kind: 'package-store', path: sharing.storeRoot });
  }
  for (const row of Array.isArray(config?.sharedCaches)
    ? config.sharedCaches
    : []) {
    const entry = cacheEntry(row);
    if (entry) {
      entries.push(entry);
    }
  }
  return entries;
}

async function projectEntries(registrations, readProjectConfig) {
  const rows = await Promise.all(
    registrations.map(async (registration) => {
      const caches =
        registration?.caches ?? (await readProjectConfig(registration));
      return (Array.isArray(caches) ? caches : [])
        .map((cache) => cacheEntry(cache, registration?.checkout))
        .filter(Boolean);
    })
  );
  return rows.flat();
}

function canonicalEntries(entries, realpathPath) {
  return Promise.all(
    entries.map(async (entry) => {
      try {
        return { ...entry, path: await realpathPath(entry.path) };
      } catch {
        return { ...entry, incomplete: true };
      }
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
    const [config, dependencyViews, registrations] = await Promise.all([
      readConfig(),
      readDependencyViews(),
      readRegistry(),
    ]);
    const entries = [
      ...configuredEntries(config, dependencyViews),
      ...(await projectEntries(registrations, readProjectConfig)),
    ];
    return {
      ok: true,
      stores: catalogRows(await canonicalEntries(entries, realpathPath)),
    };
  }

  return { list };
}
