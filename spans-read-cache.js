import { createHash } from 'node:crypto';
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync,
} from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSpansCache } from './spans-cache.js';
import { buildSpansCacheKey } from './spans-cache-key.js';
import { SPANS_MODEL_LIMITS } from './spans-model-store.js';
import { redactSpansValue } from './spans-redaction.js';
import { SPANS_STORE_DATABASE_FILE } from './spans-store.js';

const CACHE_DOCUMENT_MAX_BYTES = SPANS_MODEL_LIMITS.documentBytes;
const IMPLEMENTATION_SOURCE_MAX_BYTES = 1024 * 1024;
const CACHE_WRITE_MAX_BYTES = CACHE_DOCUMENT_MAX_BYTES + 2 * 1024 * 1024;
const DEFAULT_PAGE_LIMIT = 50;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const IMPLEMENTATION_SOURCES = Object.freeze([
  'spans-artifacts.js',
  'spans-cache-key.js',
  'spans-cache.js',
  'spans-model-store.js',
  'spans-read-cache.js',
  'spans-redaction.js',
  'spans-runtime.js',
  'spans-search-text.js',
  'spans-search.js',
  'spans-service.js',
  'spans-store.js',
]);
const IMPLEMENTATION_IDENTITY_PATTERN = /^sha256:[a-f0-9]{64}$/;
const REQUEST_KEYS = new Set([
  'afterSequence',
  'expectedGeneration',
  'limit',
  'query',
  'runId',
  'throughSequence',
]);

// The only read-only operation admitted to the shared Spans cache. Its parser
// and tool versions are derived from the implementation sources below rather
// than manually bumped. This query has no model, prompt, approval or provider
// input.
export const SPANS_SEARCH_READ_ONLY_OPERATION = Object.freeze({
  id: 'spans-retained-history-search-v1',
  readOnly: true,
});

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function readImplementationSource(path) {
  // biome-ignore lint/suspicious/noBitwiseOperators: Source identity must not follow a replacement symlink.
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const before = fstatSync(fd);
    if (
      !before.isFile() ||
      before.size === 0 ||
      before.size > IMPLEMENTATION_SOURCE_MAX_BYTES
    ) {
      return null;
    }
    const buffer = Buffer.alloc(IMPLEMENTATION_SOURCE_MAX_BYTES + 1);
    let length = 0;
    while (length < buffer.length) {
      const count = readSync(fd, buffer, length, buffer.length - length, null);
      if (count === 0) {
        break;
      }
      length += count;
    }
    const after = fstatSync(fd);
    return length === before.size &&
      after.size === before.size &&
      after.mtimeMs === before.mtimeMs &&
      after.ctimeMs === before.ctimeMs
      ? buffer.subarray(0, length)
      : null;
  } finally {
    closeSync(fd);
  }
}

/** Fingerprint the current source set and the Bun/SQLite runtime once per cache instance. */
export function captureSpansSearchImplementationIdentity() {
  try {
    const bunVersion = process.versions.bun;
    if (typeof bunVersion !== 'string' || bunVersion.length === 0) {
      return null;
    }
    const hash = createHash('sha256');
    hash.update(`setu-spans-search-implementation-v1\0bun:${bunVersion}\0`);
    for (const name of IMPLEMENTATION_SOURCES) {
      const source = readImplementationSource(
        fileURLToPath(new URL(`./${name}`, import.meta.url))
      );
      if (!source) {
        return null;
      }
      hash.update(`${name}\0${source.length}\0`);
      hash.update(source);
    }
    return `sha256:${hash.digest('hex')}`;
  } catch {
    // A packaged or unreadable source tree cannot prove its implementation.
    return null;
  }
}

function implementationVersions(identity) {
  return typeof identity === 'string' &&
    IMPLEMENTATION_IDENTITY_PATTERN.test(identity)
    ? Object.freeze({ parser: identity, skill: 'none-v1', tool: identity })
    : null;
}

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isCount(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function permissionBits(stat) {
  return stat.mode % 0o1000;
}

function privateDirectory(stat) {
  const bits = permissionBits(stat);
  return (
    stat.isDirectory() && bits % 0o100 === 0 && Math.floor(bits / 0o100) === 0o7
  );
}

function privateDatabase(stat) {
  const bits = permissionBits(stat);
  return (
    stat.isFile() &&
    stat.nlink === 1 &&
    bits % 0o100 === 0 &&
    Math.floor(bits / 0o100) >= 0o6
  );
}

/** Capture the private path and owner identity used by the open read handle. */
export function captureSpansReadArchiveIdentity(root) {
  try {
    const uid = process.getuid?.();
    if (!(typeof root === 'string' && root && Number.isSafeInteger(uid))) {
      return null;
    }
    const rootStat = lstatSync(root);
    const rootPath = realpathSync(root);
    const resolvedRootStat = lstatSync(rootPath);
    const databaseStat = lstatSync(join(rootPath, SPANS_STORE_DATABASE_FILE));
    if (
      rootStat.isSymbolicLink() ||
      resolvedRootStat.isSymbolicLink() ||
      databaseStat.isSymbolicLink() ||
      !privateDirectory(rootStat) ||
      !privateDirectory(resolvedRootStat) ||
      !privateDatabase(databaseStat) ||
      rootStat.dev !== resolvedRootStat.dev ||
      rootStat.ino !== resolvedRootStat.ino ||
      resolvedRootStat.uid !== uid ||
      databaseStat.uid !== uid
    ) {
      return null;
    }
    return Object.freeze({
      databaseDev: databaseStat.dev,
      databaseGid: databaseStat.gid,
      databaseIno: databaseStat.ino,
      databaseMode: permissionBits(databaseStat),
      databaseUid: databaseStat.uid,
      ownerUid: uid,
      rootDev: resolvedRootStat.dev,
      rootGid: resolvedRootStat.gid,
      rootIno: resolvedRootStat.ino,
      rootMode: permissionBits(resolvedRootStat),
      rootPath,
      rootUid: resolvedRootStat.uid,
    });
  } catch {
    return null;
  }
}

function sameIdentity(left, right) {
  return Boolean(
    left && right && JSON.stringify(left) === JSON.stringify(right)
  );
}

export function sameSpansReadArchiveIdentity(left, right) {
  return sameIdentity(left, right);
}

function normalizeSearchRequest(input) {
  try {
    if (!isPlainObject(input)) {
      return null;
    }
    const keys = Reflect.ownKeys(input);
    if (keys.some((key) => typeof key !== 'string' || !REQUEST_KEYS.has(key))) {
      return null;
    }
    const request = {};
    for (const key of keys) {
      const descriptor = Object.getOwnPropertyDescriptor(input, key);
      if (!(descriptor?.enumerable && Object.hasOwn(descriptor, 'value'))) {
        return null;
      }
      if (descriptor.value !== undefined) {
        request[key] = descriptor.value;
      }
    }
    const limit = request.limit ?? DEFAULT_PAGE_LIMIT;
    if (
      typeof request.query !== 'string' ||
      request.query.length < 1 ||
      request.query.length > 512 ||
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > 100 ||
      (request.afterSequence !== undefined &&
        !isCount(request.afterSequence)) ||
      (request.expectedGeneration !== undefined &&
        !isCount(request.expectedGeneration)) ||
      (request.throughSequence !== undefined &&
        !isCount(request.throughSequence)) ||
      (request.runId !== undefined &&
        !(
          typeof request.runId === 'string' && IDENTIFIER.test(request.runId)
        )) ||
      ((request.afterSequence ?? 0) > 0 &&
        request.expectedGeneration === undefined)
    ) {
      return null;
    }
    return {
      afterSequence: request.afterSequence ?? 0,
      expectedGeneration: request.expectedGeneration,
      limit,
      query: request.query,
      runId: request.runId,
      throughSequence: request.throughSequence,
    };
  } catch {
    return null;
  }
}

function coverageMatches(coverage, snapshot) {
  return Boolean(
    isPlainObject(coverage) &&
      coverage.complete === true &&
      coverage.stale === false &&
      coverage.generation === snapshot.generation &&
      coverage.indexedSequence === snapshot.indexedSequence &&
      coverage.latestSequence === snapshot.latestSequence
  );
}

async function currentSnapshot(getSearchService, getIdentity) {
  try {
    const service = getSearchService();
    const beforeIdentity = getIdentity();
    if (!(service && beforeIdentity)) {
      return null;
    }
    const status = await service.getSearchStatus();
    const afterIdentity = getIdentity();
    const coverage = status?.coverage;
    if (
      status?.ok !== true ||
      !coverage ||
      coverage.complete !== true ||
      coverage.stale !== false ||
      !isCount(status.generation) ||
      status.generation !== coverage.generation ||
      !isCount(coverage.indexedSequence) ||
      !isCount(coverage.latestSequence) ||
      coverage.indexedSequence !== coverage.latestSequence ||
      !sameIdentity(beforeIdentity, afterIdentity)
    ) {
      return null;
    }
    return {
      generation: status.generation,
      identity: afterIdentity,
      indexedSequence: coverage.indexedSequence,
      latestSequence: coverage.latestSequence,
    };
  } catch {
    return null;
  }
}

function sameSnapshot(left, right) {
  return Boolean(
    left &&
      right &&
      left.generation === right.generation &&
      left.indexedSequence === right.indexedSequence &&
      left.latestSequence === right.latestSequence &&
      sameIdentity(left.identity, right.identity)
  );
}

function validHit(hit, previous, throughSequence, runId) {
  return Boolean(
    isPlainObject(hit) &&
      isCount(hit.sequence) &&
      hit.sequence > previous &&
      hit.sequence <= throughSequence &&
      typeof hit.eventId === 'string' &&
      IDENTIFIER.test(hit.eventId) &&
      typeof hit.runId === 'string' &&
      IDENTIFIER.test(hit.runId) &&
      (runId === undefined || hit.runId === runId) &&
      hit.historical === true &&
      typeof hit.snippet === 'string' &&
      Buffer.byteLength(hit.snippet, 'utf8') <= 4096
  );
}

function validSearchResult(value, request, snapshot) {
  if (
    !isPlainObject(value) ||
    value.ok !== true ||
    value.generation !== snapshot.generation ||
    typeof value.hasMore !== 'boolean' ||
    !isCount(value.nextSequence) ||
    !isCount(value.throughSequence) ||
    value.throughSequence !==
      (request.throughSequence ?? snapshot.indexedSequence) ||
    value.throughSequence < request.afterSequence ||
    value.throughSequence > snapshot.indexedSequence ||
    (request.expectedGeneration !== undefined &&
      value.generation !== request.expectedGeneration) ||
    !coverageMatches(value.coverage, snapshot) ||
    !Array.isArray(value.hits) ||
    value.hits.length > request.limit
  ) {
    return false;
  }
  let previous = request.afterSequence;
  for (const hit of value.hits) {
    if (!validHit(hit, previous, value.throughSequence, request.runId)) {
      return false;
    }
    previous = hit.sequence;
  }
  return (
    (!value.hasMore || value.hits.length > 0) &&
    value.nextSequence ===
      (value.hits.at(-1)?.sequence ?? request.afterSequence)
  );
}

function dependencyFor(snapshot) {
  const corpus = [
    snapshot.identity,
    snapshot.generation,
    snapshot.indexedSequence,
    snapshot.latestSequence,
  ];
  return {
    digest: `sha256:${sha256(JSON.stringify(corpus))}`,
    generation: `${snapshot.generation}:${snapshot.indexedSequence}:${snapshot.latestSequence}`,
    id: 'corpus:spans-search',
    kind: 'corpus',
  };
}

function scopeFor(identity) {
  return {
    access: [
      `owner-${identity.ownerUid}`,
      `root-${identity.rootUid}-${identity.rootGid}-${identity.rootMode.toString(8)}`,
      `database-${identity.databaseUid}-${identity.databaseGid}-${identity.databaseMode.toString(8)}`,
    ].join(':'),
    environment: identity.rootPath,
    project: 'setu-spans-retained-history',
  };
}

function inputFor(request, snapshot) {
  return {
    afterSequence: request.afterSequence,
    expectedGeneration: snapshot.generation,
    limit: request.limit,
    operation: SPANS_SEARCH_READ_ONLY_OPERATION.id,
    query: request.query,
    runId: request.runId ?? null,
    throughSequence: request.throughSequence ?? snapshot.indexedSequence,
  };
}

function attachEvidence(result, evidence) {
  return result?.ok === true ? { ...result, cache: evidence } : result;
}

function evidenceFor(cacheResult, writeOutcome, now) {
  const createdAt = Number.isFinite(cacheResult?.createdAt)
    ? cacheResult.createdAt
    : null;
  return {
    ...cacheResult,
    ageMs: createdAt === null ? null : Math.max(0, now() - createdAt),
    persisted:
      cacheResult?.hit === true ? true : (writeOutcome?.persisted ?? false),
    ...(writeOutcome?.reason ? { persistenceReason: writeOutcome.reason } : {}),
  };
}

function unavailable() {
  return {
    code: 'SPANS_SERVICE_UNAVAILABLE',
    error: 'Spans history is unavailable.',
    ok: false,
  };
}

function resultSnapshot(value) {
  try {
    return JSON.stringify(value);
  } catch {
    // An unserializable effect result cannot be confirmed.
  }
}

async function executeCacheWrite({
  context,
  entry,
  getIdentity,
  getSearchService,
  isClosing,
  key,
  openCacheWriter,
  state,
}) {
  if (isClosing()) {
    return { reason: 'RUNTIME_CLOSING', written: false };
  }
  const current = await currentSnapshot(getSearchService, getIdentity);
  if (state.settled || state.parentReturned) {
    return { reason: 'ARCHIVE_WRITE_REFUSED', written: false };
  }
  if (!sameSnapshot(context.snapshot, current)) {
    return { reason: 'DEPENDENCIES_CHANGED', written: false };
  }

  let writer;
  let write;
  let close;
  try {
    // No archive handle spans an await. This writer opens only after admission
    // and closes immediately after its synchronous cache write.
    writer = openCacheWriter();
    state.writeAttempted = true;
    write = writer.writeCache(key, entry);
  } catch {
    return { reason: 'CACHE_WRITE_UNKNOWN', written: 'unknown' };
  } finally {
    try {
      close = writer?.close();
    } catch {
      close = { ok: false };
    }
  }
  if (write?.ok !== true || close?.ok !== true) {
    return { reason: 'CACHE_WRITE_UNKNOWN', written: 'unknown' };
  }
  const after = await currentSnapshot(getSearchService, getIdentity);
  if (!sameSnapshot(context.snapshot, after)) {
    return { reason: 'DEPENDENCIES_CHANGED', written: 'stale-key-only' };
  }
  return { written: true };
}

function createCacheWriteEffect(state, options) {
  return () => {
    if (state.settled || state.parentReturned || state.invocations !== 0) {
      state.invalidInvocation = true;
      return Promise.resolve({ code: 'SPANS_ARCHIVE_WRITE_GATE', ok: false });
    }
    state.invocations += 1;
    const effectPromise = executeCacheWrite({ ...options, state });
    state.effectPromises.add(effectPromise);
    effectPromise.then(
      (result) => {
        state.effectResult = result;
        state.effectResultSnapshot = resultSnapshot(result);
      },
      () => {
        state.effectResultSnapshot = undefined;
      }
    );
    return effectPromise;
  };
}

function exactCacheWriteAdmission(admitted, state) {
  return Boolean(
    admitted?.ok === true &&
      Object.hasOwn(admitted, 'value') &&
      state.invocations === 1 &&
      !state.invalidInvocation &&
      state.effectResultSnapshot !== undefined &&
      Object.is(admitted.value, state.effectResult) &&
      resultSnapshot(state.effectResult) === state.effectResultSnapshot
  );
}

function confirmedCacheWriteOutcome(effectResult) {
  if (effectResult?.written === true) {
    return { persisted: true };
  }
  if (effectResult?.written === 'stale-key-only') {
    return { persisted: true, reason: 'DEPENDENCIES_CHANGED' };
  }
  if (effectResult?.written === 'unknown') {
    return {
      persisted: 'unknown',
      reason: effectResult.reason ?? 'ARCHIVE_WRITE_UNKNOWN',
    };
  }
  return {
    persisted: false,
    reason: effectResult?.reason ?? 'ARCHIVE_WRITE_REFUSED',
  };
}

function unconfirmedCacheWriteOutcome(admitted, state) {
  if (state.writeAttempted) {
    return {
      persisted: 'unknown',
      reason:
        state.effectResult?.reason ??
        (state.invalidInvocation
          ? 'ARCHIVE_WRITE_GATE_INVALID'
          : 'ARCHIVE_WRITE_UNKNOWN'),
    };
  }
  if (state.invocations === 0 && admitted?.ok === false) {
    return { persisted: false, reason: 'ARCHIVE_WRITE_REFUSED' };
  }
  return {
    persisted: false,
    reason:
      state.effectResult?.reason ??
      (state.invocations === 0 || state.invalidInvocation
        ? 'ARCHIVE_WRITE_GATE_INVALID'
        : 'ARCHIVE_WRITE_REFUSED'),
  };
}

function resolveCacheWriteOutcome(admitted, state) {
  if (state.effectRejected) {
    return state.writeAttempted
      ? { persisted: 'unknown', reason: 'ARCHIVE_WRITE_UNKNOWN' }
      : { persisted: false, reason: 'ARCHIVE_WRITE_REFUSED' };
  }
  return exactCacheWriteAdmission(admitted, state)
    ? confirmedCacheWriteOutcome(state.effectResult)
    : unconfirmedCacheWriteOutcome(admitted, state);
}

async function publishEntry({
  archiveWrite,
  context,
  getIdentity,
  getSearchService,
  isClosing,
  key,
  openCacheWriter,
  root,
  entry,
}) {
  if (isClosing()) {
    return { persisted: false, reason: 'RUNTIME_CLOSING' };
  }
  const before = await currentSnapshot(getSearchService, getIdentity);
  if (!sameSnapshot(context.snapshot, before)) {
    return { persisted: false, reason: 'DEPENDENCIES_CHANGED' };
  }
  if (
    Buffer.byteLength(JSON.stringify(entry), 'utf8') > CACHE_DOCUMENT_MAX_BYTES
  ) {
    return { persisted: false, reason: 'CACHE_VALUE_TOO_LARGE' };
  }

  const state = {
    effectPromises: new Set(),
    effectRejected: false,
    effectResult: undefined,
    effectResultSnapshot: undefined,
    invalidInvocation: false,
    invocations: 0,
    parentReturned: false,
    settled: false,
    writeAttempted: false,
  };
  let admitted;
  try {
    admitted = await archiveWrite(
      { maxBytes: CACHE_WRITE_MAX_BYTES, root },
      createCacheWriteEffect(state, {
        context,
        entry,
        getIdentity,
        getSearchService,
        isClosing,
        key,
        openCacheWriter,
      })
    );
  } catch {
    admitted = undefined;
  } finally {
    state.parentReturned = true;
    state.settled = true;
  }

  const effectSettlements = await Promise.allSettled(state.effectPromises);
  state.effectRejected = effectSettlements.some(
    ({ status }) => status === 'rejected'
  );
  // Once the SQLite write was attempted, a parent refusal, fabricated result,
  // duplicate call or mismatched result cannot prove whether it committed.
  return resolveCacheWriteOutcome(admitted, state);
}

export function createSpansReadCache({
  archiveWrite,
  getImplementationIdentity = captureSpansSearchImplementationIdentity,
  getIdentity,
  getSearchService,
  getStore,
  isClosing = () => false,
  now = Date.now,
  openCacheWriter,
  root,
} = {}) {
  if (
    !(
      typeof archiveWrite === 'function' &&
      typeof getImplementationIdentity === 'function' &&
      typeof getIdentity === 'function' &&
      typeof getSearchService === 'function' &&
      typeof getStore === 'function' &&
      typeof isClosing === 'function' &&
      typeof now === 'function' &&
      typeof openCacheWriter === 'function' &&
      typeof root === 'string'
    )
  ) {
    throw new TypeError(
      'Spans read cache requires the admitted search runtime.'
    );
  }

  let sourceIdentity;
  try {
    sourceIdentity = getImplementationIdentity();
  } catch {
    sourceIdentity = null;
  }
  const versions = implementationVersions(sourceIdentity);
  const contexts = new Map();
  const writeOutcomes = new Map();
  const hasIdentity = () => {
    try {
      return Boolean(getIdentity());
    } catch {
      return false;
    }
  };
  const runCurrentOrRefuse = (service, input, reason) =>
    hasIdentity() ? runUncached(service, input, reason) : unavailable();
  const snapshotNow = () => currentSnapshot(getSearchService, getIdentity);
  const cache = createSpansCache({
    now,
    readEntry: async (key) => {
      const context = contexts.get(key);
      try {
        if (!context || isClosing()) {
          return null;
        }
        if (!sameSnapshot(context.snapshot, await snapshotNow())) {
          return null;
        }
        const store = getStore();
        if (typeof store?.readCache !== 'function') {
          return null;
        }
        const result = await Promise.resolve(store.readCache(key));
        if (!sameSnapshot(context.snapshot, await snapshotNow())) {
          return null;
        }
        if (
          result?.ok !== true ||
          !isPlainObject(result.entry) ||
          !validSearchResult(
            result.entry.value,
            context.request,
            context.snapshot
          )
        ) {
          return null;
        }
        return result.entry;
      } catch {
        // A damaged or unavailable cache is a miss; the store query is authority.
        return null;
      }
    },
    writeEntry: async (key, entry) => {
      const context = contexts.get(key);
      const outcome = context
        ? await publishEntry({
            archiveWrite,
            context,
            entry,
            getIdentity,
            getSearchService,
            isClosing,
            key,
            openCacheWriter,
            root,
          })
        : { persisted: false, reason: 'CACHE_CONTEXT_MISSING' };
      writeOutcomes.set(key, outcome);
    },
  });

  async function runUncached(service, input, reason) {
    return attachEvidence(await service.getSearch(input), {
      hit: false,
      missReason: reason,
      persisted: false,
    });
  }

  async function fillSearch(service, input, request, snapshot, context) {
    if (!sameSnapshot(snapshot, await snapshotNow())) {
      return {
        code: 'CACHE_DEPENDENCIES_CHANGED',
        error: 'Search changed.',
        ok: false,
      };
    }
    const value = await service.getSearch(input);
    context.computed = value;
    if (value?.ok !== true) {
      return value;
    }
    if (!validSearchResult(value, request, snapshot)) {
      return {
        code: 'CACHE_RESULT_INVALID',
        error: 'Search result is invalid.',
        ok: false,
      };
    }
    const safe = redactSpansValue(value);
    if (
      Buffer.byteLength(JSON.stringify(safe), 'utf8') > CACHE_DOCUMENT_MAX_BYTES
    ) {
      return {
        code: 'CACHE_VALUE_TOO_LARGE',
        error: 'Search result is too large.',
        ok: false,
      };
    }
    if (!sameSnapshot(snapshot, await snapshotNow())) {
      return {
        code: 'CACHE_DEPENDENCIES_CHANGED',
        error: 'Search changed.',
        ok: false,
      };
    }
    return { ok: true, value: safe };
  }

  function requestFitsSnapshot(request, snapshot) {
    return !(
      (request.expectedGeneration !== undefined &&
        request.expectedGeneration !== snapshot.generation) ||
      request.afterSequence >
        (request.throughSequence ?? snapshot.indexedSequence) ||
      (request.throughSequence !== undefined &&
        request.throughSequence > snapshot.indexedSequence)
    );
  }

  async function resolveCacheResult({
    cached,
    computed,
    input,
    keyResult,
    request,
    service,
    snapshot,
  }) {
    if (!sameSnapshot(snapshot, await snapshotNow())) {
      return runCurrentOrRefuse(service, input, 'DEPENDENCIES_CHANGED');
    }
    if (cached?.ok !== true) {
      if (computed?.ok !== true) {
        return computed ?? cached;
      }
      return attachEvidence(computed, {
        hit: false,
        key: keyResult.key,
        manifest: keyResult.manifest,
        missReason:
          cached.code === 'CACHE_VALUE_TOO_LARGE'
            ? 'CACHE_VALUE_TOO_LARGE'
            : 'CACHE_FILL_NOT_PUBLISHED',
        persisted: false,
      });
    }
    if (!validSearchResult(cached.value, request, snapshot)) {
      return runCurrentOrRefuse(service, input, 'CACHE_ENTRY_INVALID');
    }
    return attachEvidence(
      cached.value,
      evidenceFor(cached.cache, writeOutcomes.get(keyResult.key), now)
    );
  }

  async function cacheSearch(service, input, request, snapshot) {
    const dependencies = [dependencyFor(snapshot)];
    const scope = scopeFor(snapshot.identity);
    const operationInput = inputFor(request, snapshot);
    const keyResult = buildSpansCacheKey({
      dependencies,
      input: operationInput,
      scope,
      versions,
    });
    if (!keyResult.ok) {
      return runUncached(service, input, 'CACHE_KEY_UNAVAILABLE');
    }

    let context = contexts.get(keyResult.key);
    if (!context) {
      context = { computed: undefined, references: 0, request, snapshot };
      contexts.set(keyResult.key, context);
    }
    context.references += 1;
    try {
      let cached;
      try {
        cached = await cache.getOrFill({
          dependencies,
          fill: () => fillSearch(service, input, request, snapshot, context),
          input: operationInput,
          readOnly: SPANS_SEARCH_READ_ONLY_OPERATION.readOnly,
          scope,
          versions,
        });
      } catch {
        return runUncached(service, input, 'CACHE_OPERATION_FAILED');
      }
      const result = await resolveCacheResult({
        cached,
        computed: context.computed,
        input,
        keyResult,
        request,
        service,
        snapshot,
      });
      return result;
    } finally {
      context.references -= 1;
      if (context.references === 0) {
        if (contexts.get(keyResult.key) === context) {
          contexts.delete(keyResult.key);
        }
        writeOutcomes.delete(keyResult.key);
      }
    }
  }

  return Object.freeze({
    async search(input) {
      const service = getSearchService();
      if (!service) {
        return;
      }
      const request = normalizeSearchRequest(input);
      if (!request) {
        return service.getSearch(input);
      }
      if (!versions) {
        return runUncached(service, input, 'IMPLEMENTATION_IDENTITY_UNKNOWN');
      }
      const snapshot = await snapshotNow();
      if (!snapshot) {
        return runCurrentOrRefuse(
          service,
          input,
          'DEPENDENCIES_UNKNOWN_OR_STALE'
        );
      }
      if (!requestFitsSnapshot(request, snapshot)) {
        return service.getSearch(input);
      }
      return cacheSearch(service, input, request, snapshot);
    },
  });
}
