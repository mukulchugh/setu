import { Database } from 'bun:sqlite';
import { afterEach, describe, expect, test } from 'bun:test';
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createSpansArtifacts } from './spans-artifacts.js';
import { createSpansCache } from './spans-cache.js';
import {
  captureSpansReadArchiveIdentity,
  captureSpansSearchImplementationIdentity,
  createSpansReadCache,
} from './spans-read-cache.js';
import { createSpansRuntime } from './spans-runtime.js';
import { createSpansService } from './spans-service.js';
import { openSpansStore, SPANS_STORE_DATABASE_FILE } from './spans-store.js';

const roots = [];
const stores = [];
const runtimes = [];
const IMPLEMENTATION_IDENTITY = /^sha256:[a-f0-9]{64}$/;

afterEach(async () => {
  await Promise.all(
    runtimes
      .splice(0)
      .reverse()
      .map((runtime) => runtime.close())
  );
  for (const store of stores.splice(0).reverse()) {
    store.close();
  }
  for (const root of roots.splice(0)) {
    rmSync(root, { force: true, recursive: true });
  }
});

function newParent() {
  const parent = realpathSync(mkdtempSync(join(tmpdir(), 'spans-read-cache-')));
  roots.push(parent);
  return parent;
}

function openArchive(root) {
  const store = openSpansStore({ root });
  stores.push(store);
  return store;
}

function append(store, eventId, summary, type = 'run.note') {
  const result = store.appendEvent({
    eventId,
    payload: { summary },
    runId: 'run-cache',
    type,
  });
  expect(result.ok).toBe(true);
  return result.event;
}

function indexAll(store) {
  const initialized = store.initializeSearch();
  expect(initialized.ok).toBe(true);
  const indexed = store.indexSearchPage({ limit: 200 });
  expect(indexed).toMatchObject({
    coverage: { complete: true, stale: false },
    hasMore: false,
    ok: true,
  });
}

function allowWrites({ delay } = {}) {
  let gateCalls = 0;
  let effectCalls = 0;
  const archiveWrite = async (_request, effect) => {
    gateCalls += 1;
    if (delay) {
      delay.entered();
      await delay.wait;
    }
    const value = await effect();
    effectCalls += 1;
    return { ok: true, value };
  };
  return {
    archiveWrite,
    get effectCalls() {
      return effectCalls;
    },
    get gateCalls() {
      return gateCalls;
    },
  };
}

function tableNames(root) {
  const db = new Database(join(root, SPANS_STORE_DATABASE_FILE), {
    readonly: true,
    strict: true,
  });
  try {
    return db
      .query(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
      )
      .all()
      .map(({ name }) => name);
  } finally {
    db.close(true);
  }
}

function createCacheCaller(root, store, archiveWrite, implementationIdentity) {
  const service = createSpansService({
    artifacts: createSpansArtifacts({ root }),
    getArtifactReference: store.getArtifactReference,
    store,
  });
  return createSpansReadCache({
    archiveWrite,
    getIdentity: () => captureSpansReadArchiveIdentity(root),
    getImplementationIdentity:
      typeof implementationIdentity === 'function'
        ? implementationIdentity
        : () => implementationIdentity,
    getSearchService: () => service,
    getStore: () => store,
    openCacheWriter: () => openSpansStore({ create: false, root }),
    root,
  });
}

function replaceCacheEntry(root, key, entry) {
  const store = openSpansStore({ create: false, root });
  try {
    return store.writeCache(key, entry);
  } finally {
    store.close();
  }
}

describe('Spans retained-history read cache', () => {
  test('an oversized implementation source makes caching unavailable', async () => {
    const copy = newParent();
    const source = fileURLToPath(new URL('.', import.meta.url));
    for (const name of readdirSync(source)) {
      if (
        name.startsWith('spans-') &&
        name.endsWith('.js') &&
        !name.includes('.test.')
      ) {
        cpSync(join(source, name), join(copy, name));
      }
    }
    writeFileSync(join(copy, 'spans-runtime.js'), ' '.repeat(1024 * 1024 + 1));
    const module = await import(
      pathToFileURL(join(copy, 'spans-read-cache.js')).href
    );
    expect(module.captureSpansSearchImplementationIdentity()).toBeNull();
  });

  test('coalesces identical normalized searches, caches empty results, and reports a later hit', async () => {
    const root = join(newParent(), 'archive');
    const store = openArchive(root);
    append(store, 'event-1', 'ordinary retained history');
    indexAll(store);
    const originalTables = tableNames(root);
    let enterGate;
    let releaseGate;
    const gateEntered = new Promise((resolve) => {
      enterGate = resolve;
    });
    const gateWait = new Promise((resolve) => {
      releaseGate = resolve;
    });
    const gate = allowWrites({
      delay: { entered: enterGate, wait: gateWait },
    });
    const runtime = createSpansRuntime({
      archiveWrite: gate.archiveWrite,
      root,
    });
    runtimes.push(runtime);

    const first = runtime.spansSearch({ query: 'absentword' });
    const second = runtime.spansSearch({ limit: 50, query: 'absentword' });
    await gateEntered;
    releaseGate();
    const [coalescedA, coalescedB] = await Promise.all([first, second]);

    expect(coalescedA).toMatchObject({
      cache: { hit: false, persisted: true },
      hits: [],
      ok: true,
    });
    expect(coalescedB).toEqual({
      ...coalescedA,
      cache: { ...coalescedA.cache, ageMs: expect.any(Number) },
    });
    expect(coalescedA.cache.ageMs).toBeGreaterThanOrEqual(0);
    expect(coalescedB.cache.ageMs).toBeGreaterThanOrEqual(0);
    expect(gate.gateCalls).toBe(1);
    expect(gate.effectCalls).toBe(1);
    expect(tableNames(root)).toEqual(originalTables);
    expect(originalTables).toContain('spans_cache');

    const hit = await runtime.spansSearch({ query: 'absentword' });
    expect(hit).toMatchObject({
      cache: {
        ageMs: expect.any(Number),
        hit: true,
        manifest: {
          dependencies: [
            expect.objectContaining({
              generation: '0:1:1',
              kind: 'corpus',
            }),
          ],
          versions: {
            parser: expect.stringMatching(IMPLEMENTATION_IDENTITY),
            skill: 'none-v1',
            tool: expect.stringMatching(IMPLEMENTATION_IDENTITY),
          },
        },
        persisted: true,
      },
      hits: [],
      ok: true,
    });
    expect(hit.cache.manifest.versions).not.toHaveProperty(
      'modelSettingsDigest'
    );
    expect(hit.cache.manifest.versions).not.toHaveProperty(
      'promptSettingsDigest'
    );
    const sourceIdentity = captureSpansSearchImplementationIdentity();
    expect(sourceIdentity).toMatch(IMPLEMENTATION_IDENTITY);
    expect(hit.cache.manifest.versions).toEqual({
      parser: sourceIdentity,
      skill: 'none-v1',
      tool: sourceIdentity,
    });
    expect(gate.gateCalls).toBe(1);
  });

  test('the maximum public page and its manifest fit the one-megabyte document cap', async () => {
    const root = join(newParent(), 'archive');
    const store = openArchive(root);
    for (let index = 1; index <= 100; index += 1) {
      append(
        store,
        `event-${index}`,
        `maxresult ${'safe detail '.repeat(600)}`
      );
    }
    indexAll(store);
    const gate = allowWrites();
    const runtime = createSpansRuntime({
      archiveWrite: gate.archiveWrite,
      root,
    });
    runtimes.push(runtime);

    const result = await runtime.spansSearch({
      limit: 100,
      query: 'maxresult',
    });
    expect(result.ok).toBe(true);
    expect(result.cache).toMatchObject({ hit: false, persisted: true });
    expect(Array.isArray(result.hits)).toBe(true);
    expect(result.hits).toHaveLength(100);
    const cached = store.readCache(result.cache.key);
    expect(cached.ok).toBe(true);
    expect(
      Buffer.byteLength(JSON.stringify(cached.entry), 'utf8')
    ).toBeLessThanOrEqual(1024 * 1024);
    expect(gate.effectCalls).toBe(1);
  });

  test('keys bind the exact query, run filter, cursor, and page limit', async () => {
    const root = join(newParent(), 'archive');
    const store = openArchive(root);
    append(store, 'event-1', 'alpha beta first');
    append(store, 'event-2', 'alpha beta second');
    append(store, 'event-3', 'alpha beta third');
    indexAll(store);
    const gate = allowWrites();
    const runtime = createSpansRuntime({
      archiveWrite: gate.archiveWrite,
      root,
    });
    runtimes.push(runtime);

    const first = await runtime.spansSearch({ limit: 2, query: 'alpha' });
    const differentQuery = await runtime.spansSearch({
      limit: 2,
      query: 'beta',
    });
    const differentFilter = await runtime.spansSearch({
      limit: 2,
      query: 'alpha',
      runId: 'another-run',
    });
    const differentLimit = await runtime.spansSearch({
      limit: 3,
      query: 'alpha',
    });
    const cursorPage = await runtime.spansSearch({
      afterSequence: first.nextSequence,
      expectedGeneration: first.generation,
      limit: 2,
      query: 'alpha',
      throughSequence: first.throughSequence,
    });

    const keys = [
      first.cache.key,
      differentQuery.cache.key,
      differentFilter.cache.key,
      differentLimit.cache.key,
      cursorPage.cache.key,
    ];
    expect(new Set(keys).size).toBe(keys.length);
    expect(first.hits).toHaveLength(2);
    expect(cursorPage.hits).toEqual([
      expect.objectContaining({ eventId: 'event-3', sequence: 3 }),
    ]);
  });

  test('invalidates an empty result on addition, withdrawal, correction, and index generation changes', async () => {
    const root = join(newParent(), 'archive');
    const store = openArchive(root);
    append(store, 'event-1', 'ordinary retained history');
    indexAll(store);
    const gate = allowWrites();
    const runtime = createSpansRuntime({
      archiveWrite: gate.archiveWrite,
      root,
    });
    runtimes.push(runtime);

    const empty = await runtime.spansSearch({ query: 'newneedle' });
    expect(empty).toMatchObject({
      cache: { hit: false, persisted: true },
      hits: [],
      ok: true,
    });

    append(store, 'event-2', 'a newneedle was retained');
    const unindexed = await runtime.spansSearch({ query: 'newneedle' });
    expect(unindexed).toMatchObject({
      cache: {
        hit: false,
        missReason: 'DEPENDENCIES_UNKNOWN_OR_STALE',
        persisted: false,
      },
      coverage: { complete: false, latestSequence: 2, stale: true },
      hits: [],
      ok: true,
    });
    expect(store.indexSearchPage({ limit: 200 }).coverage).toMatchObject({
      complete: true,
      latestSequence: 2,
    });
    const afterAddition = await runtime.spansSearch({ query: 'newneedle' });
    expect(afterAddition).toMatchObject({
      cache: { hit: false, persisted: true },
      hits: [expect.objectContaining({ eventId: 'event-2' })],
      ok: true,
    });
    expect(afterAddition.cache.key).not.toBe(empty.cache.key);

    // The canonical archive is append-only: withdrawal and correction are
    // retained events. They advance the collection watermark and invalidate
    // the current query dependency without deleting earlier history.
    append(store, 'event-3', 'source withdrawn', 'source.withdrawn');
    append(store, 'event-4', 'source corrected', 'source.corrected');
    const correctedBeforeIndex = await runtime.spansSearch({
      query: 'newneedle',
    });
    expect(correctedBeforeIndex).toMatchObject({
      cache: {
        hit: false,
        missReason: 'DEPENDENCIES_UNKNOWN_OR_STALE',
        persisted: false,
      },
      coverage: { complete: false, latestSequence: 4, stale: true },
      ok: true,
    });

    expect(store.invalidateSearch()).toMatchObject({ generation: 1, ok: true });
    const rebuilding = await runtime.spansSearch({ query: 'newneedle' });
    expect(rebuilding).toMatchObject({
      cache: { hit: false, persisted: false },
      coverage: { complete: false, generation: 1, indexedSequence: 0 },
      hits: [],
      ok: true,
    });
    expect(store.indexSearchPage({ limit: 200 }).coverage).toMatchObject({
      complete: true,
      generation: 1,
      latestSequence: 4,
    });
    const rebuilt = await runtime.spansSearch({ query: 'newneedle' });
    expect(rebuilt).toMatchObject({
      cache: { hit: false, persisted: true },
      coverage: { complete: true, generation: 1, latestSequence: 4 },
      hits: [expect.objectContaining({ eventId: 'event-2' })],
      ok: true,
    });
    expect(rebuilt.cache.key).not.toBe(afterAddition.cache.key);
  });

  test('misses after private permission changes and archive restore identity changes', async () => {
    const parent = newParent();
    const root = join(parent, 'archive');
    const store = openArchive(root);
    append(store, 'event-1', 'identity needle');
    indexAll(store);
    const gate = allowWrites();
    const runtime = createSpansRuntime({
      archiveWrite: gate.archiveWrite,
      root,
    });
    runtimes.push(runtime);

    const first = await runtime.spansSearch({ query: 'identity' });
    expect(first.cache).toMatchObject({ hit: false, persisted: true });

    chmodSync(root, 0o500);
    const permissionChanged = await runtime.spansSearch({ query: 'identity' });
    expect(permissionChanged).toMatchObject({
      code: 'SPANS_SERVICE_UNAVAILABLE',
      ok: false,
    });
    chmodSync(root, 0o700);
    expect(gate.gateCalls).toBe(1);

    await runtime.close();
    runtimes.pop();
    store.close();
    stores.pop();

    const restoredRoot = join(parent, 'restored-archive');
    cpSync(root, restoredRoot, { recursive: true });
    const restoredGate = allowWrites();
    const restoredRuntime = createSpansRuntime({
      archiveWrite: restoredGate.archiveWrite,
      root: restoredRoot,
    });
    runtimes.push(restoredRuntime);
    const restored = await restoredRuntime.spansSearch({ query: 'identity' });
    expect(restored).toMatchObject({
      cache: { hit: false, persisted: true },
      hits: [expect.objectContaining({ eventId: 'event-1' })],
      ok: true,
    });
    expect(restored.cache.key).not.toBe(first.cache.key);
  });

  test('refuses an old runtime after the archive at its root is replaced', async () => {
    const parent = newParent();
    const root = join(parent, 'archive');
    const store = openArchive(root);
    append(store, 'event-1', 'old archive needle');
    indexAll(store);
    const gate = allowWrites();
    const runtime = createSpansRuntime({
      archiveWrite: gate.archiveWrite,
      root,
    });
    runtimes.push(runtime);

    const first = await runtime.spansSearch({ query: 'needle' });
    expect(first.cache).toMatchObject({ hit: false, persisted: true });
    store.close();

    const replacement = join(parent, 'replacement');
    const retired = join(parent, 'retired');
    cpSync(root, replacement, { recursive: true });
    renameSync(root, retired);
    renameSync(replacement, root);

    expect(await runtime.spansSearch({ query: 'needle' })).toMatchObject({
      code: 'SPANS_SERVICE_UNAVAILABLE',
      ok: false,
    });
    expect(gate.gateCalls).toBe(1);
  });

  test('same archive with a new source identity misses without cache write authority', async () => {
    const root = join(newParent(), 'archive');
    const store = openArchive(root);
    append(store, 'event-1', 'version needle');
    indexAll(store);
    const gate = allowWrites();
    let identityReads = 0;
    const sourceIdentity = `sha256:${'a'.repeat(64)}`;
    const firstCaller = createCacheCaller(
      root,
      store,
      gate.archiveWrite,
      () => {
        identityReads += 1;
        return sourceIdentity;
      }
    );
    const first = await firstCaller.search({ query: 'version' });
    expect(first.cache).toMatchObject({ hit: false, persisted: true });
    expect((await firstCaller.search({ query: 'version' })).cache.hit).toBe(
      true
    );
    expect(identityReads).toBe(1);

    let deniedCalls = 0;
    const secondCaller = createCacheCaller(
      root,
      store,
      (_request, _effect) => {
        deniedCalls += 1;
        return { code: 'SPANS_ARCHIVE_WRITE_UNAVAILABLE', ok: false };
      },
      `sha256:${'b'.repeat(64)}`
    );
    // The second source identity cannot reuse the first key. Its gate refuses
    // before the effect, so the existing archive row remains untouched.
    const afterVersionChange = await secondCaller.search({ query: 'version' });
    expect(afterVersionChange).toMatchObject({
      cache: {
        hit: false,
        persisted: false,
        persistenceReason: 'ARCHIVE_WRITE_REFUSED',
      },
      hits: [expect.objectContaining({ eventId: 'event-1' })],
      ok: true,
    });
    expect(afterVersionChange.cache.key).not.toBe(first.cache.key);
    expect(deniedCalls).toBe(1);
    expect(store.readCache(first.cache.key).ok).toBe(true);
    expect(store.readCache(afterVersionChange.cache.key).ok).toBe(false);
  });

  test('corrupt and partial entries miss; the shared cache refuses a non-read-only request', async () => {
    const root = join(newParent(), 'archive');
    const store = openArchive(root);
    append(store, 'event-1', 'integrity needle');
    indexAll(store);
    const gate = allowWrites();
    const runtime = createSpansRuntime({
      archiveWrite: gate.archiveWrite,
      root,
    });
    runtimes.push(runtime);

    const first = await runtime.spansSearch({ query: 'integrity' });
    expect(first.cache).toMatchObject({ hit: false, persisted: true });

    const raw = new Database(join(root, SPANS_STORE_DATABASE_FILE), {
      readwrite: true,
      strict: true,
    });
    try {
      raw
        .query('UPDATE spans_cache SET entry_json = ? WHERE cache_key = ?')
        .run('{partial', first.cache.key);
    } finally {
      raw.close(true);
    }
    const afterCorruption = await runtime.spansSearch({ query: 'integrity' });
    expect(afterCorruption).toMatchObject({
      cache: { hit: false, persisted: true },
      hits: [expect.objectContaining({ eventId: 'event-1' })],
      ok: true,
    });

    const current = store.readCache(first.cache.key);
    expect(current.ok).toBe(true);
    expect(
      replaceCacheEntry(root, first.cache.key, {
        ...current.entry,
        value: { hits: [], ok: true },
      }).ok
    ).toBe(true);
    const afterPartial = await runtime.spansSearch({ query: 'integrity' });
    expect(afterPartial).toMatchObject({
      cache: { hit: false, persisted: true },
      hits: [expect.objectContaining({ eventId: 'event-1' })],
      ok: true,
    });

    let fills = 0;
    let writes = 0;
    const guarded = createSpansCache({
      readEntry: () => {
        throw new Error('non-read-only requests must stop before read');
      },
      writeEntry: () => {
        writes += 1;
      },
    });
    const refused = await guarded.getOrFill({
      dependencies: [],
      fill: () => {
        fills += 1;
        return { ok: true, value: 'must not execute' };
      },
      input: { operation: 'spans-search' },
      readOnly: false,
      scope: { access: 'owner', environment: 'test', project: 'setu' },
      versions: { parser: '1', skill: 'none', tool: '1' },
    });
    expect(refused).toMatchObject({
      code: 'CACHE_READ_ONLY_REQUIRED',
      ok: false,
    });
    expect(fills).toBe(0);
    expect(writes).toBe(0);
    expect(gate.gateCalls).toBe(3);
  });

  test('a corpus change during delayed publication cannot return the earlier result', async () => {
    const root = join(newParent(), 'archive');
    const store = openArchive(root);
    append(store, 'event-1', 'shared term one');
    indexAll(store);
    let enterGate;
    let releaseGate;
    const gateEntered = new Promise((resolve) => {
      enterGate = resolve;
    });
    const gateWait = new Promise((resolve) => {
      releaseGate = resolve;
    });
    const gate = allowWrites({
      delay: { entered: enterGate, wait: gateWait },
    });
    const runtime = createSpansRuntime({
      archiveWrite: gate.archiveWrite,
      root,
    });
    runtimes.push(runtime);

    const pending = runtime.spansSearch({ query: 'shared' });
    await gateEntered;
    append(store, 'event-2', 'shared term two');
    expect(store.indexSearchPage({ limit: 200 })).toMatchObject({
      coverage: { complete: true, indexedSequence: 2, latestSequence: 2 },
      ok: true,
    });
    releaseGate();

    const result = await pending;
    expect(result).toMatchObject({
      cache: {
        hit: false,
        missReason: 'DEPENDENCIES_CHANGED',
        persisted: false,
      },
      coverage: { complete: true, indexedSequence: 2, latestSequence: 2 },
      hits: [
        expect.objectContaining({ eventId: 'event-1' }),
        expect.objectContaining({ eventId: 'event-2' }),
      ],
      ok: true,
    });
    expect(store.readCache(result.cache.key ?? 'sha256:missing').ok).toBe(
      false
    );
  });

  test('gate refusal returns computed truth and explicitly records no persistence', async () => {
    const root = join(newParent(), 'archive');
    const store = openArchive(root);
    append(store, 'event-1', 'truth needle');
    indexAll(store);
    let calls = 0;
    const runtime = createSpansRuntime({
      archiveWrite: () => {
        calls += 1;
        return { code: 'SPANS_ARCHIVE_WRITE_UNAVAILABLE', ok: false };
      },
      root,
    });
    runtimes.push(runtime);

    const result = await runtime.spansSearch({ query: 'truth' });
    expect(result).toMatchObject({
      cache: {
        hit: false,
        persisted: false,
        persistenceReason: 'ARCHIVE_WRITE_REFUSED',
      },
      hits: [expect.objectContaining({ eventId: 'event-1' })],
      ok: true,
    });
    expect(calls).toBe(1);
    expect(store.readCache(result.cache.key).ok).toBe(false);
  });

  test('coalesced denied fills return the same successful ordinary query', async () => {
    const root = join(newParent(), 'archive');
    const store = openArchive(root);
    append(store, 'event-1', 'denied gate needle');
    indexAll(store);
    let enterGate;
    let releaseGate;
    const gateEntered = new Promise((resolve) => {
      enterGate = resolve;
    });
    const gateWait = new Promise((resolve) => {
      releaseGate = resolve;
    });
    let gateCalls = 0;
    const runtime = createSpansRuntime({
      archiveWrite: async () => {
        gateCalls += 1;
        enterGate();
        await gateWait;
        return { code: 'SPANS_ARCHIVE_WRITE_UNAVAILABLE', ok: false };
      },
      root,
    });
    runtimes.push(runtime);

    const first = runtime.spansSearch({ query: 'needle' });
    const second = runtime.spansSearch({ limit: 50, query: 'needle' });
    await gateEntered;
    releaseGate();
    const [a, b] = await Promise.all([first, second]);

    expect(a).toMatchObject({
      cache: {
        hit: false,
        persisted: false,
        persistenceReason: 'ARCHIVE_WRITE_REFUSED',
      },
      hits: [expect.objectContaining({ eventId: 'event-1' })],
      ok: true,
    });
    expect(b.hits).toEqual(a.hits);
    expect(b.cache).toEqual({ ...a.cache, ageMs: expect.any(Number) });
    expect(a.cache.ageMs).toBeGreaterThanOrEqual(0);
    expect(b.cache.ageMs).toBeGreaterThanOrEqual(0);
    expect(gateCalls).toBe(1);
    expect(store.readCache(a.cache.key).ok).toBe(false);
  });

  test('coalesced oversized and failed source fills preserve source outcomes', async () => {
    const root = join(newParent(), 'archive');
    const store = openArchive(root);
    append(store, 'event-1', 'fixture source row');
    indexAll(store);
    const currentStatus = store.searchStatus();
    const baseCoverage = currentStatus.coverage;
    const largeCoverage = {
      ...baseCoverage,
      padding: 'x'.repeat(1024 * 1024),
    };
    let queryCalls = 0;
    let gateCalls = 0;
    const oversizedService = {
      getSearch: () => {
        queryCalls += 1;
        return {
          coverage: largeCoverage,
          generation: currentStatus.generation,
          hasMore: false,
          hits: [],
          nextSequence: 0,
          ok: true,
          throughSequence: baseCoverage.indexedSequence,
        };
      },
      getSearchStatus: () => ({
        ...currentStatus,
        coverage: largeCoverage,
      }),
    };
    const oversized = createSpansReadCache({
      archiveWrite: () => {
        gateCalls += 1;
        return { code: 'SPANS_ARCHIVE_WRITE_UNAVAILABLE', ok: false };
      },
      getIdentity: () => captureSpansReadArchiveIdentity(root),
      getImplementationIdentity: () => `sha256:${'c'.repeat(64)}`,
      getSearchService: () => oversizedService,
      getStore: () => store,
      openCacheWriter: () => openSpansStore({ create: false, root }),
      root,
    });
    const [largeA, largeB] = await Promise.all([
      oversized.search({ query: 'large' }),
      oversized.search({ query: 'large' }),
    ]);
    expect(largeA).toMatchObject({
      cache: {
        hit: false,
        missReason: 'CACHE_VALUE_TOO_LARGE',
        persisted: false,
      },
      ok: true,
    });
    expect(largeB.cache).toMatchObject(largeA.cache);
    expect(largeB.coverage).toEqual(largeA.coverage);
    expect(queryCalls).toBe(1);
    expect(gateCalls).toBe(0);

    let sourceCalls = 0;
    const failedService = {
      getSearch: () => {
        sourceCalls += 1;
        return { code: 'SPANS_SEARCH_UNAVAILABLE', ok: false };
      },
      getSearchStatus: () => currentStatus,
    };
    const failed = createSpansReadCache({
      archiveWrite: () => {
        gateCalls += 1;
        return { code: 'SPANS_ARCHIVE_WRITE_UNAVAILABLE', ok: false };
      },
      getIdentity: () => captureSpansReadArchiveIdentity(root),
      getImplementationIdentity: () => `sha256:${'d'.repeat(64)}`,
      getSearchService: () => failedService,
      getStore: () => store,
      openCacheWriter: () => openSpansStore({ create: false, root }),
      root,
    });
    const [failedA, failedB] = await Promise.all([
      failed.search({ query: 'source-error' }),
      failed.search({ query: 'source-error' }),
    ]);
    expect(failedA).toEqual({ code: 'SPANS_SEARCH_UNAVAILABLE', ok: false });
    expect(failedB).toEqual(failedA);
    expect(sourceCalls).toBe(1);
    expect(gateCalls).toBe(0);

    const actualService = createSpansService({
      artifacts: createSpansArtifacts({ root }),
      getArtifactReference: store.getArtifactReference,
      store,
    });
    const unknownIdentity = createSpansReadCache({
      archiveWrite: () => {
        gateCalls += 1;
        return { code: 'SPANS_ARCHIVE_WRITE_UNAVAILABLE', ok: false };
      },
      getIdentity: () => captureSpansReadArchiveIdentity(root),
      getImplementationIdentity: () => null,
      getSearchService: () => actualService,
      getStore: () => store,
      openCacheWriter: () => openSpansStore({ create: false, root }),
      root,
    });
    expect(await unknownIdentity.search({ query: 'fixture' })).toMatchObject({
      cache: {
        hit: false,
        missReason: 'IMPLEMENTATION_IDENTITY_UNKNOWN',
        persisted: false,
      },
      ok: true,
    });
    expect(gateCalls).toBe(0);
  });

  test('late, fabricated and duplicate gate effects cannot claim a confirmed write', async () => {
    const root = join(newParent(), 'archive');
    const store = openArchive(root);
    append(store, 'event-1', 'gate contract needle');
    indexAll(store);
    let lateEffect;
    let runningEffect;
    const lateRuntime = createSpansRuntime({
      archiveWrite: (_request, effect) => {
        lateEffect = effect;
        runningEffect = effect();
        return { code: 'SPANS_ARCHIVE_WRITE_UNAVAILABLE', ok: false };
      },
      root,
    });
    runtimes.push(lateRuntime);
    const lateResult = await lateRuntime.spansSearch({ query: 'needle' });
    expect(lateResult.cache).toMatchObject({
      persisted: false,
      persistenceReason: 'ARCHIVE_WRITE_REFUSED',
    });
    expect(await runningEffect).toMatchObject({
      reason: 'ARCHIVE_WRITE_REFUSED',
      written: false,
    });
    expect(await lateEffect()).toMatchObject({ ok: false });
    expect(store.readCache(lateResult.cache.key).ok).toBe(false);

    const fabricatedRuntime = createSpansRuntime({
      archiveWrite: async () => ({ ok: true, value: { written: true } }),
      root,
    });
    runtimes.push(fabricatedRuntime);
    const fabricated = await fabricatedRuntime.spansSearch({ query: 'needle' });
    expect(fabricated).toMatchObject({
      cache: {
        hit: false,
        persisted: false,
        persistenceReason: 'ARCHIVE_WRITE_GATE_INVALID',
      },
      hits: [expect.objectContaining({ eventId: 'event-1' })],
      ok: true,
    });
    expect(store.readCache(fabricated.cache.key).ok).toBe(false);

    let duplicateResult;
    const duplicateRuntime = createSpansRuntime({
      archiveWrite: async (_request, effect) => {
        const admittedResult = await effect();
        duplicateResult = await effect();
        return { ok: true, value: admittedResult };
      },
      root,
    });
    runtimes.push(duplicateRuntime);
    const duplicate = await duplicateRuntime.spansSearch({ query: 'needle' });
    expect(duplicateResult).toMatchObject({ ok: false });
    expect(duplicate.cache).toMatchObject({
      hit: false,
      persisted: 'unknown',
      persistenceReason: 'ARCHIVE_WRITE_GATE_INVALID',
    });
    expect(store.readCache(duplicate.cache.key).ok).toBe(true);
  });

  test('a runtime without the archive-write gate always performs the uncached read', async () => {
    const root = join(newParent(), 'archive');
    const store = openArchive(root);
    append(store, 'event-1', 'ungated needle');
    indexAll(store);
    const gate = allowWrites();
    const gatedRuntime = createSpansRuntime({
      archiveWrite: gate.archiveWrite,
      root,
    });
    runtimes.push(gatedRuntime);
    const cached = await gatedRuntime.spansSearch({ query: 'ungated' });
    expect(cached.cache).toMatchObject({ hit: false, persisted: true });
    await gatedRuntime.close();
    runtimes.pop();

    const ungatedRuntime = createSpansRuntime({ root });
    runtimes.push(ungatedRuntime);
    const current = await ungatedRuntime.spansSearch({ query: 'ungated' });
    expect(current).toMatchObject({
      hits: [expect.objectContaining({ eventId: 'event-1' })],
      ok: true,
    });
    expect(current).not.toHaveProperty('cache');
    expect(gate.gateCalls).toBe(1);
  });

  test('closing drains a started cache operation, refuses late searches, and leaves no writer open', async () => {
    const root = join(newParent(), 'archive');
    const store = openArchive(root);
    append(store, 'event-1', 'drain needle');
    indexAll(store);
    let enterGate;
    let releaseGate;
    const gateEntered = new Promise((resolve) => {
      enterGate = resolve;
    });
    const gateWait = new Promise((resolve) => {
      releaseGate = resolve;
    });
    const gate = allowWrites({
      delay: { entered: enterGate, wait: gateWait },
    });
    const runtime = createSpansRuntime({
      archiveWrite: gate.archiveWrite,
      root,
    });
    runtimes.push(runtime);
    let searchSettled = false;
    const search = runtime.spansSearch({ query: 'drain' }).finally(() => {
      searchSettled = true;
    });
    await gateEntered;

    const closing = runtime.close();
    expect(closing instanceof Promise).toBe(true);
    await Promise.resolve();
    expect(searchSettled).toBe(false);
    expect(await runtime.spansSearch({ query: 'drain' })).toMatchObject({
      code: 'SPANS_SERVICE_UNAVAILABLE',
      ok: false,
    });
    releaseGate();
    const result = await search;
    expect(result).toMatchObject({
      cache: { hit: false, persisted: false },
      hits: [expect.objectContaining({ eventId: 'event-1' })],
      ok: true,
    });
    expect(await closing).toEqual({ ok: true });
    expect(searchSettled).toBe(true);
    expect(gate.effectCalls).toBe(1);
    expect(store.readCache(result.cache.key ?? 'sha256:missing').ok).toBe(
      false
    );
  });

  test('a missing archive stays absent and never reaches the cache writer', async () => {
    const root = join(newParent(), 'not-created');
    const gate = allowWrites();
    const runtime = createSpansRuntime({
      archiveWrite: gate.archiveWrite,
      root,
    });
    runtimes.push(runtime);

    expect(await runtime.spansSearch({ query: 'anything' })).toMatchObject({
      code: 'SPANS_ARCHIVE_NOT_INITIALIZED',
      ok: false,
    });
    expect(existsSync(root)).toBe(false);
    expect(gate.gateCalls).toBe(0);
  });
});
