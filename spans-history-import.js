// Explicit, bounded import of a selected native conversation into Spans history.
// The archive root and archiveWrite callback are supplied by the trusted owner.

import { createHash } from 'node:crypto';
import { lstat, readdir, realpath } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import { createSpansArtifacts } from './spans-artifacts.js';
import { prepareSpansDefaultParent } from './spans-planning-runtime.js';
import { SPANS_SEARCH_LIMITS } from './spans-search.js';
import { importSpansSourceFile } from './spans-source-import.js';
import { openSpansStore, SpansStoreError } from './spans-store.js';

const PARSER_VERSION = 'native-history-1';
const SOURCE_GENERATION = 0;
const MAX_BYTES = 4 * 1024 * 1024;
const MAX_SEARCH_PAGES_PER_IMPORT = 4;
const INVALID = Object.freeze({
  code: 'SOURCE_IMPORT_INVALID',
  error: 'Invalid source file import arguments.',
  ok: false,
});
const UNKNOWN = Object.freeze({
  code: 'SPANS_ARCHIVE_WRITE_UNKNOWN',
  error:
    'Import outcome is unknown; inspect archived history before continuing.',
  hasMore: false,
  nextOffset: null,
  ok: false,
  state: 'unknown',
  unknown: true,
});
const UNAVAILABLE = Object.freeze({
  code: 'SPANS_ARCHIVE_WRITE_UNAVAILABLE',
  error: 'Spans history could not be opened safely.',
  ok: false,
});
const NOT_INITIALIZED = Object.freeze({
  code: 'SPANS_ARCHIVE_NOT_INITIALIZED',
  error: 'The selected archive is not initialized.',
  ok: false,
});
const BUSY = Object.freeze({
  code: 'SPANS_IMPORT_BUSY',
  error: 'A source import is already active in this runtime.',
  ok: false,
});
const CLOSED = Object.freeze({
  code: 'SPANS_IMPORT_RUNTIME_CLOSED',
  error: 'Spans history import runtime is closed.',
  ok: false,
});
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const INPUT_KEYS = new Set(['existingRunId', 'maxBytes', 'path', 'provider']);

function isPlainRecord(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function normalizeInput(input) {
  try {
    if (!isPlainRecord(input)) {
      return;
    }
    const values = {};
    for (const key of Reflect.ownKeys(input)) {
      const descriptor = Object.getOwnPropertyDescriptor(input, key);
      if (
        typeof key !== 'string' ||
        !INPUT_KEYS.has(key) ||
        !descriptor?.enumerable ||
        !Object.hasOwn(descriptor, 'value')
      ) {
        return;
      }
      values[key] = descriptor.value;
    }
    if (
      typeof values.path !== 'string' ||
      !values.path.length ||
      values.path.length > 4096 ||
      values.path.includes('\0') ||
      !isAbsolute(values.path) ||
      typeof values.provider !== 'string' ||
      !['codex', 'claude'].includes(values.provider) ||
      (values.existingRunId !== undefined &&
        !(
          typeof values.existingRunId === 'string' &&
          IDENTIFIER.test(values.existingRunId)
        )) ||
      (values.maxBytes !== undefined &&
        !(
          Number.isSafeInteger(values.maxBytes) &&
          values.maxBytes >= 1 &&
          values.maxBytes <= MAX_BYTES
        ))
    ) {
      return;
    }
    return {
      existingRunId: values.existingRunId,
      maxBytes: values.maxBytes,
      path: values.path,
      provider: values.provider,
    };
  } catch {
    // A hostile proxy is invalid input.
  }
}

function identityDigest(canonicalPath, provider, destination) {
  return createHash('sha256')
    .update(
      JSON.stringify([
        'setu-spans-history-import-v1',
        canonicalPath,
        provider,
        destination,
      ])
    )
    .digest('hex');
}

function isMissingArchive(error) {
  return (
    error instanceof SpansStoreError &&
    error.code === 'SPANS_STORE_UNAVAILABLE' &&
    ['root-missing', 'database-missing'].includes(error.phase)
  );
}

async function canInitializeRoot(root) {
  try {
    return (await readdir(root)).length === 0;
  } catch (error) {
    return error.code === 'ENOENT';
  }
}

function mapAdmissionFailure(result, started) {
  if (started || result?.unknown === true) {
    return UNKNOWN;
  }
  if (result?.ok === false) {
    return result;
  }
  return UNAVAILABLE;
}

function isNotFound(result) {
  return result?.ok === false && result.code === 'SPANS_MODEL_NOT_FOUND';
}

function sameImportedView(view, sourceId) {
  return (
    view?.kind === 'imported' &&
    view?.importVersion === 1 &&
    view?.readOnly === true &&
    view?.provenance?.sourceId === sourceId
  );
}

function importedView(runId, sourceId, provider, state) {
  return {
    actions: {},
    checkpoint: 0,
    generation: 0,
    goal: 'Imported conversation',
    importVersion: 1,
    kind: 'imported',
    owner: provider,
    provenance: {
      parserVersion: PARSER_VERSION,
      provider,
      sourceGeneration: SOURCE_GENERATION,
      sourceId,
    },
    readOnly: true,
    runId,
    spans: {},
    state,
  };
}

/** Create a per-runtime source import service. Each importSelected call reads one page. */
export function createSpansHistoryImport({ root, archiveWrite } = {}) {
  if (typeof root !== 'string' || !isAbsolute(root) || resolve(root) !== root) {
    throw new TypeError(
      'Spans history import requires an explicit absolute root.'
    );
  }
  if (typeof archiveWrite !== 'function') {
    throw new TypeError(
      'Spans history import requires archiveWrite authority.'
    );
  }

  let store;
  let artifacts;
  let probe;
  let active;
  let closing = false;
  let closePromise;
  let uncertain = false;

  async function gatedWrite(maxBytes, effect) {
    let started = false;
    let result;
    try {
      result = await archiveWrite({ maxBytes, root }, () => {
        started = true;
        return effect();
      });
    } catch {
      return mapAdmissionFailure(undefined, started);
    }
    if (result?.ok === true && Object.hasOwn(result, 'value')) {
      return { ok: true, value: result.value };
    }
    return mapAdmissionFailure(result, started);
  }

  async function inspectArchive(allowCreate) {
    try {
      if (probe) {
        return UNAVAILABLE;
      }
      probe = openSpansStore({ create: false, readonly: true, root });
      const closed = probe.close();
      if (closed?.ok !== true) {
        return UNAVAILABLE;
      }
      probe = undefined;
    } catch (error) {
      if (!isMissingArchive(error)) {
        return UNAVAILABLE;
      }
      if (!allowCreate) {
        return NOT_INITIALIZED;
      }
      if (!(await canInitializeRoot(root))) {
        return UNAVAILABLE;
      }
      return { missing: true, ok: true };
    }

    return { missing: false, ok: true };
  }

  async function openWritable(allowCreate) {
    if (store && artifacts) {
      return { ok: true };
    }
    const inspected = await inspectArchive(allowCreate);
    if (!inspected.ok) {
      return inspected;
    }
    const { missing } = inspected;
    const opened = await gatedWrite(2 * 1024 * 1024, async () => {
      if (missing) {
        prepareSpansDefaultParent(root);
        if (!(await canInitializeRoot(root))) {
          return UNAVAILABLE;
        }
      }
      store = openSpansStore({ ...(missing ? {} : { create: false }), root });
      artifacts = createSpansArtifacts({ root });
      return { ok: true };
    });
    if (opened?.ok === true) {
      return opened.value?.ok === true ? { ok: true } : UNAVAILABLE;
    }
    if (opened?.unknown) {
      uncertain = true;
    }
    return opened;
  }

  async function ensureView(runId, sourceId, provider) {
    const current = store.readRun({ runId });
    if (current?.ok === true) {
      return sameImportedView(current.view, sourceId)
        ? { ok: true, view: current }
        : {
            code: 'SOURCE_DESTINATION_CONFLICT',
            error: 'Import destination is already in use.',
            ok: false,
          };
    }
    if (!isNotFound(current)) {
      return {
        code: 'SPANS_ARCHIVE_UNAVAILABLE',
        error: 'Spans history is unavailable.',
        ok: false,
      };
    }
    const result = await gatedWrite(1024 * 1024, () =>
      store.commitRun({
        events: [],
        expectedGeneration: 0,
        expectedRevision: 0,
        runId,
        view: importedView(runId, sourceId, provider, 'importing'),
      })
    );
    if (result?.ok !== true) {
      if (result?.unknown) {
        uncertain = true;
      }
      return result;
    }
    if (result.value?.ok !== true) {
      return {
        code: 'SPANS_ARCHIVE_UNAVAILABLE',
        error: 'Spans history is unavailable.',
        ok: false,
      };
    }
    return { ok: true, view: store.readRun({ runId }) };
  }

  async function setStandaloneState(runId, sourceId, imported) {
    const state =
      imported.hasMore || imported.pendingByteCount > 0
        ? 'importing'
        : 'imported';
    const current = store.readRun({ runId });
    if (current?.ok !== true || !sameImportedView(current.view, sourceId)) {
      return {
        code: 'SPANS_ARCHIVE_UNAVAILABLE',
        error: 'Spans history is unavailable.',
        ok: false,
      };
    }
    const view = {
      ...current.view,
      importProgress: {
        hasMore: imported.hasMore,
        nextOffset: imported.nextOffset,
        pendingByteCount: imported.pendingByteCount,
      },
      state,
    };
    const result = await gatedWrite(1024 * 1024, () =>
      store.commitRun({
        events: [],
        expectedGeneration: current.generation,
        expectedRevision: current.revision,
        runId,
        view,
      })
    );
    if (result?.ok !== true || result.value?.ok !== true) {
      if (result?.unknown) {
        uncertain = true;
        return UNKNOWN;
      }
      return {
        code: 'SPANS_ARCHIVE_UNAVAILABLE',
        error: 'Spans history is unavailable.',
        ok: false,
      };
    }
    return { ok: true };
  }

  function searchFailure(code, error, indexed = 0, unknown = false) {
    return {
      code: code ?? 'SPANS_SEARCH_UNAVAILABLE',
      complete: false,
      error,
      indexed,
      ok: false,
      ...(unknown ? { unknown: true } : {}),
    };
  }

  function validSearchCoverage(status) {
    return (
      status?.ok === true &&
      Number.isSafeInteger(status.coverage?.latestSequence) &&
      Number.isSafeInteger(status.coverage?.indexedSequence)
    );
  }

  function indexSearchPage() {
    return gatedWrite(SPANS_SEARCH_LIMITS.indexPageBytes, () =>
      store.indexSearchPage({ limit: SPANS_SEARCH_LIMITS.indexPage })
    );
  }

  async function advanceSearchIndex(start, targetSequence) {
    let page = start;
    let indexed = 0;
    let pages = 0;
    while (
      page.coverage.indexedSequence < targetSequence &&
      pages < MAX_SEARCH_PAGES_PER_IMPORT
    ) {
      // Each bounded page needs fresh shared archive admission.
      // biome-ignore lint/performance/noAwaitInLoops: each bounded index page needs fresh archive admission.
      const admitted = await indexSearchPage();
      pages += 1;
      if (admitted?.ok !== true || admitted.value?.ok !== true) {
        return {
          failure: searchFailure(
            admitted?.code ?? admitted?.value?.code,
            'Imported history was saved, but search indexing did not complete.',
            indexed,
            admitted?.unknown === true
          ),
          ok: false,
        };
      }
      page = admitted.value;
      indexed += Number.isSafeInteger(page.indexed) ? page.indexed : 0;
      if (
        page.coverage?.indexedSequence < targetSequence &&
        page.indexed === 0
      ) {
        return {
          failure: searchFailure(
            'SPANS_SEARCH_STALLED',
            'Imported history was saved, but search indexing stalled.',
            indexed
          ),
          ok: false,
        };
      }
    }
    return { indexed, ok: true, page, pages };
  }

  async function selectedCanonicalPath(path) {
    try {
      const selected = await lstat(path);
      if (!selected.isFile() || selected.isSymbolicLink()) {
        return {
          code: 'SOURCE_UNAVAILABLE',
          error: 'Source file could not be opened safely.',
          ok: false,
        };
      }
      return { canonicalPath: await realpath(path), ok: true };
    } catch {
      return {
        code: 'SOURCE_UNAVAILABLE',
        error: 'Source file could not be opened safely.',
        ok: false,
      };
    }
  }

  async function prepareDestination(input, runId, sourceId) {
    const opened = await openWritable(input.existingRunId === undefined);
    if (opened?.ok !== true) {
      return opened;
    }
    if (input.existingRunId === undefined) {
      return ensureView(runId, sourceId, input.provider);
    }
    const destinationRun = store.readRun({ runId });
    if (destinationRun?.ok === true) {
      return { ok: true };
    }
    if (isNotFound(destinationRun)) {
      return {
        code: 'SOURCE_DESTINATION_NOT_FOUND',
        error: 'Import destination was not found.',
        ok: false,
      };
    }
    return {
      code: 'SPANS_ARCHIVE_UNAVAILABLE',
      error: 'Spans history is unavailable.',
      ok: false,
    };
  }

  async function importPage(input, runId, sourceId) {
    const imported = await importSpansSourceFile(
      {
        ...(input.maxBytes === undefined ? {} : { maxBytes: input.maxBytes }),
        artifacts,
        parserVersion: PARSER_VERSION,
        path: input.path,
        provider: input.provider,
        runId,
        sourceGeneration: SOURCE_GENERATION,
        sourceId,
        store,
      },
      { archiveWrite, root }
    );
    if (imported?.unknown === true) {
      uncertain = true;
      return { ...imported, runId, sourceId, state: 'unknown' };
    }
    if (imported?.ok !== true) {
      return { ...imported, runId, sourceId };
    }

    if (input.existingRunId === undefined) {
      const updated = await setStandaloneState(runId, sourceId, imported);
      if (updated?.ok !== true) {
        uncertain = true;
        return { ...UNKNOWN, runId, sourceId };
      }
    }
    const search = await indexImportedHistory();
    return {
      ...imported,
      runId,
      search,
      sourceId,
      state:
        imported.hasMore || imported.pendingByteCount > 0
          ? 'importing'
          : 'imported',
    };
  }

  async function indexImportedHistory() {
    const initialized = await gatedWrite(2 * 1024 * 1024, () =>
      store.initializeSearch()
    );
    if (initialized?.ok !== true || initialized.value?.ok !== true) {
      return searchFailure(
        initialized?.code ?? initialized?.value?.code,
        'Imported history was saved, but search indexing is unavailable.',
        0,
        initialized?.unknown === true
      );
    }

    let status;
    try {
      status = store.searchStatus();
    } catch {
      return searchFailure(
        'SPANS_SEARCH_UNAVAILABLE',
        'Imported history was saved, but search indexing is unavailable.'
      );
    }
    if (!validSearchCoverage(status)) {
      return searchFailure(
        status?.code,
        'Imported history was saved, but search indexing is unavailable.'
      );
    }

    const targetSequence = status.coverage.latestSequence;
    const advanced = await advanceSearchIndex(status, targetSequence);
    if (advanced.ok !== true) {
      return advanced.failure;
    }

    const { indexed, page, pages } = advanced;
    const complete = page.coverage.indexedSequence >= targetSequence;
    return {
      complete,
      coverage: page.coverage,
      hasMore: !complete,
      indexed,
      ok: true,
      pages,
      targetSequence,
    };
  }

  async function doImport(input) {
    const selected = await selectedCanonicalPath(input.path);
    if (selected.ok !== true) {
      return selected;
    }
    const destination =
      input.existingRunId === undefined
        ? 'standalone'
        : `run:${input.existingRunId}`;
    const digest = identityDigest(
      selected.canonicalPath,
      input.provider,
      destination
    );
    const sourceId = digest;
    const runId = input.existingRunId ?? `import-${digest.slice(0, 58)}`;

    const destinationReady = await prepareDestination(input, runId, sourceId);
    if (destinationReady?.ok !== true) {
      return destinationReady;
    }
    return importPage(
      { ...input, path: selected.canonicalPath },
      runId,
      sourceId
    );
  }

  function importSelected(raw) {
    const input = normalizeInput(raw);
    if (!input) {
      return Promise.resolve({ ...INVALID });
    }
    if (closing) {
      return Promise.resolve({ ...CLOSED });
    }
    if (uncertain) {
      return Promise.resolve({ ...UNKNOWN });
    }
    if (active) {
      return Promise.resolve({ ...BUSY });
    }
    const current = doImport(input)
      .catch(() => {
        uncertain = true;
        return { ...UNKNOWN };
      })
      .finally(() => {
        if (active === current) {
          active = undefined;
        }
      });
    active = current;
    return current;
  }

  function close() {
    closing = true;
    if (!closePromise) {
      closePromise = (async () => {
        if (active) {
          await active;
        }
        try {
          const probeResult = probe?.close() ?? { ok: true };
          if (probeResult.ok !== true) {
            return probeResult;
          }
          probe = undefined;
          const result = store?.close() ?? { ok: true };
          if (result.ok === true) {
            store = undefined;
            artifacts = undefined;
          }
          return result;
        } catch {
          return UNAVAILABLE;
        }
      })().then((result) => {
        if (result.ok !== true) {
          closePromise = undefined;
        }
        return result;
      });
    }
    return closePromise;
  }

  return Object.freeze({ close, importSelected });
}
