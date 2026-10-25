import { homedir } from 'node:os';
import { join } from 'node:path';
import { createSpansArtifacts } from './spans-artifacts.js';
import { SPANS_MODEL_LIMITS } from './spans-model-store.js';
import { createSpansPlanningRuntime } from './spans-planning-runtime.js';
import {
  captureSpansReadArchiveIdentity,
  createSpansReadCache,
  sameSpansReadArchiveIdentity,
} from './spans-read-cache.js';
import { createSpansService } from './spans-service.js';
import {
  openSpansStore,
  SPANS_STORE_LIMITS,
  SpansStoreError,
} from './spans-store.js';

export const defaultSpansRoot = () =>
  join(homedir(), '.local/share/setu/spans');

const unavailable = () => ({
  code: 'SPANS_SERVICE_UNAVAILABLE',
  error: 'Spans history is unavailable.',
  ok: false,
});
const archiveWriteFailure = () => ({
  code: 'SPANS_ARCHIVE_WRITE_UNAVAILABLE',
  error: 'Spans archive write admission is unavailable.',
  ok: false,
});
const archiveWriteUnknown = () => ({
  code: 'SPANS_ARCHIVE_WRITE_UNKNOWN',
  error: 'Spans archive write outcome is unknown.',
  ok: false,
});

// One bounded view, one bounded event payload and conservative allowance for
// SQLite pages, indices, transaction journal/WAL metadata and row bookkeeping.
const ARCHIVE_WRITE_BOOKKEEPING_BYTES = 2 * 1024 * 1024;
const ARCHIVE_WRITE_MAX_BYTES =
  SPANS_MODEL_LIMITS.documentBytes +
  SPANS_STORE_LIMITS.payloadBytes +
  ARCHIVE_WRITE_BOOKKEEPING_BYTES;

// Reads never initialize an archive, migrate it, or build a search index. The
// store opens read-only, so a missing, older or newer schema is simply
// unavailable. Explicit draft creation owns initialization; the offline index
// command owns derived search indexing.
export function createSpansRuntime({
  root = defaultSpansRoot(),
  archiveWrite,
} = {}) {
  if (archiveWrite !== undefined && typeof archiveWrite !== 'function') {
    throw new TypeError('Spans archive write gate must be a function.');
  }
  const { close: closePlanning, ...planning } = createSpansPlanningRuntime({
    root,
  });
  let store;
  let service;
  let closed = false;
  let missing = false;
  let archiveIdentity;
  let spansReadCache;
  let closePromise;
  const activeSearches = new Set();
  function reader() {
    if (closed) {
      return null;
    }
    if (service) {
      return service;
    }
    missing = false;
    try {
      const identityBeforeOpen = captureSpansReadArchiveIdentity(root);
      store = openSpansStore({ readonly: true, root });
      const identityAfterOpen = captureSpansReadArchiveIdentity(root);
      archiveIdentity =
        identityBeforeOpen &&
        sameSpansReadArchiveIdentity(identityBeforeOpen, identityAfterOpen)
          ? identityAfterOpen
          : null;
      service = createSpansService({
        artifacts: createSpansArtifacts({ root }),
        getArtifactReference: store.getArtifactReference,
        store,
      });
      return service;
    } catch (error) {
      archiveIdentity = null;
      missing =
        error instanceof SpansStoreError &&
        error.code === 'SPANS_STORE_UNAVAILABLE' &&
        ['root-missing', 'database-missing'].includes(error.phase);
      store?.close();
      store = undefined;
      return null;
    }
  }
  const read = (method, input) => {
    const value = reader()?.[method]?.(input);
    if (value) {
      return value;
    }
    return !closed && missing
      ? {
          code: 'SPANS_ARCHIVE_NOT_INITIALIZED',
          error: 'Save your first workflow draft to create the local archive.',
          ok: false,
        }
      : unavailable();
  };
  const spansSearch = (input) => {
    if (closed) {
      return Promise.resolve(unavailable());
    }
    const operation = (async () => {
      const currentService = reader();
      if (!currentService) {
        return !closed && missing
          ? {
              code: 'SPANS_ARCHIVE_NOT_INITIALIZED',
              error:
                'Save your first workflow draft to create the local archive.',
              ok: false,
            }
          : unavailable();
      }
      if (!archiveWrite) {
        return currentService.getSearch(input);
      }
      if (!spansReadCache) {
        spansReadCache = createSpansReadCache({
          archiveWrite,
          getIdentity: () => {
            const current = captureSpansReadArchiveIdentity(root);
            return sameSpansReadArchiveIdentity(archiveIdentity, current)
              ? current
              : null;
          },
          getSearchService: () => service,
          getStore: () => store,
          isClosing: () => closed,
          openCacheWriter: () => openSpansStore({ create: false, root }),
          root,
        });
      }
      return (await spansReadCache.search(input)) ?? unavailable();
    })();
    activeSearches.add(operation);
    operation.then(
      () => activeSearches.delete(operation),
      () => activeSearches.delete(operation)
    );
    return operation;
  };
  const mutate = (method, input) => {
    if (closed) {
      if (!archiveWrite) {
        return planning[method](input);
      }
      return Promise.resolve({
        code: 'SPANS_PLANNING_CLOSED',
        error: 'Spans planning runtime is closed.',
        ok: false,
      });
    }
    if (!archiveWrite) {
      return planning[method](input);
    }
    let result;
    let effectStarted = false;
    try {
      result = archiveWrite({ maxBytes: ARCHIVE_WRITE_MAX_BYTES, root }, () => {
        effectStarted = true;
        return closed
          ? {
              code: 'SPANS_PLANNING_CLOSED',
              error: 'Spans planning runtime is closed.',
              ok: false,
            }
          : planning[method](input);
      });
    } catch {
      return Promise.resolve(
        effectStarted ? archiveWriteUnknown() : archiveWriteFailure()
      );
    }
    return Promise.resolve(result).then(
      (admitted) => {
        if (admitted?.ok === true && Object.hasOwn(admitted, 'value')) {
          return admitted.value;
        }
        return admitted?.ok === false ? admitted : archiveWriteFailure();
      },
      () => (effectStarted ? archiveWriteUnknown() : archiveWriteFailure())
    );
  };
  return Object.freeze({
    ...planning,
    close() {
      closed = true;
      if (closePromise) {
        return closePromise;
      }
      const finishClose = () => {
        const readResult = store?.close() ?? { ok: true };
        const planningResult = closePlanning();
        return readResult.ok === true ? planningResult : readResult;
      };
      if (activeSearches.size > 0) {
        closePromise = Promise.allSettled([...activeSearches]).then(() => {
          const result = finishClose();
          closePromise = undefined;
          return result;
        });
        return closePromise;
      }
      return finishClose();
    },
    spansArtifact: (input) => read('getArtifact', input),
    spansDraftCreate: (input) => mutate('spansDraftCreate', input),
    spansEvents: (input) => read('getEvents', input),
    spansPlanRevise: (input) => mutate('spansPlanRevise', input),
    spansRun: (input) => read('getRun', input),
    spansRuns: (input) => read('listRuns', input),
    spansSearch,
    spansSearchStatus: (input) => read('getSearchStatus', input),
    spansWorkflowCreate: (input) => mutate('spansWorkflowCreate', input),
  });
}
