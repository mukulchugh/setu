import { isAbsolute, resolve } from 'node:path';
import { createSpansArtifacts } from './spans-artifacts.js';
import { importSpansSourceFile } from './spans-source-import.js';
import { openSpansStore, SpansStoreError } from './spans-store.js';

const INPUT_KEYS = [
  'maxBytes',
  'parserVersion',
  'path',
  'provider',
  'runId',
  'sourceGeneration',
  'sourceId',
];
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const UNKNOWN = Object.freeze({
  code: 'SPANS_ARCHIVE_WRITE_UNKNOWN',
  error: 'Spans archive write outcome is unknown.',
  nextOffset: null,
  ok: false,
  unknown: true,
});
const UNAVAILABLE = Object.freeze({
  code: 'SPANS_ARCHIVE_WRITE_UNAVAILABLE',
  error: 'Spans archive write admission is unavailable.',
  ok: false,
});
const BUSY = Object.freeze({
  code: 'SPANS_IMPORT_BUSY',
  error: 'A source import is already active in this runtime.',
  ok: false,
});
const CLOSED = Object.freeze({
  code: 'SPANS_IMPORT_RUNTIME_CLOSED',
  error: 'Spans import runtime is closed.',
  ok: false,
});
const NOT_INITIALIZED = Object.freeze({
  code: 'SPANS_ARCHIVE_NOT_INITIALIZED',
  error: 'The selected Spans archive is not initialized.',
  ok: false,
});

function normalizedInput(raw) {
  try {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
      return false;
    }
    const keys = Reflect.ownKeys(raw);
    if (
      keys.some((key) => typeof key !== 'string') ||
      (keys.sort().join(',') !== [...INPUT_KEYS].sort().join(',') &&
        keys.sort().join(',') !==
          [...INPUT_KEYS.filter((key) => key !== 'maxBytes')].sort().join(','))
    ) {
      return false;
    }
    const values = {};
    for (const key of keys) {
      const descriptor = Object.getOwnPropertyDescriptor(raw, key);
      if (!(descriptor && Object.hasOwn(descriptor, 'value'))) {
        return;
      }
      values[key] = descriptor.value;
    }
    const valid =
      typeof values.path === 'string' &&
      isAbsolute(values.path) &&
      !values.path.includes('\0') &&
      typeof values.provider === 'string' &&
      ['codex', 'claude'].includes(values.provider) &&
      typeof values.sourceId === 'string' &&
      IDENTIFIER.test(values.sourceId) &&
      Number.isSafeInteger(values.sourceGeneration) &&
      values.sourceGeneration >= 0 &&
      typeof values.parserVersion === 'string' &&
      IDENTIFIER.test(values.parserVersion) &&
      typeof values.runId === 'string' &&
      IDENTIFIER.test(values.runId) &&
      (values.maxBytes === undefined ||
        (Number.isSafeInteger(values.maxBytes) &&
          values.maxBytes >= 1 &&
          values.maxBytes <= 4 * 1024 * 1024));
    return valid ? values : undefined;
  } catch {
    return false;
  }
}

function storeIsMissing(error) {
  return (
    error instanceof SpansStoreError &&
    error.code === 'SPANS_STORE_UNAVAILABLE' &&
    ['root-missing', 'database-missing'].includes(error.phase)
  );
}

function mapGateFailure(result, started) {
  if (started || result?.unknown === true) {
    return UNKNOWN;
  }
  return result?.ok === false ? result : UNAVAILABLE;
}

/** Owns the private archive adapters for one explicit, bounded source import. */
export function createSpansImportRuntime({ root, archiveWrite } = {}) {
  if (typeof root !== 'string' || !isAbsolute(root) || resolve(root) !== root) {
    throw new TypeError(
      'Spans import runtime requires an explicit absolute root.'
    );
  }
  if (typeof archiveWrite !== 'function') {
    throw new TypeError(
      'Spans import runtime requires archiveWrite authority.'
    );
  }

  let store;
  let probe;
  let artifacts;
  let active;
  let closing = false;
  let closePromise;
  let uncertain = false;

  async function openWritableAdapters() {
    if (store && artifacts) {
      return { ok: true };
    }

    // This read-only probe proves the existing archive is usable without
    // initializing a missing root/database. Close it before gated write-open.
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
      return storeIsMissing(error) ? NOT_INITIALIZED : UNAVAILABLE;
    }

    let started = false;
    let gated;
    try {
      gated = await archiveWrite({ maxBytes: 1024 * 1024, root }, () => {
        started = true;
        store = openSpansStore({ create: false, root });
        artifacts = createSpansArtifacts({ root });
        return { ok: true };
      });
    } catch {
      return started ? UNKNOWN : UNAVAILABLE;
    }
    if (gated?.ok === true && gated.value?.ok === true) {
      return { ok: true };
    }
    return mapGateFailure(gated, started);
  }

  async function runImport(input) {
    try {
      const opened = await openWritableAdapters();
      if (opened?.ok !== true) {
        return opened;
      }
      return await importSpansSourceFile(
        { ...input, artifacts, store },
        { archiveWrite, root }
      );
    } catch {
      // The source importer owns its post-effect unknown classification. An
      // unexpected throw here is conservatively unknown once adapters exist.
      return UNKNOWN;
    }
  }

  function importSelected(input) {
    const normalized = normalizedInput(input);
    if (!normalized) {
      return Promise.resolve({
        code: 'SOURCE_IMPORT_INVALID',
        error: 'Invalid source file import arguments.',
        ok: false,
      });
    }
    if (closing) {
      return Promise.resolve(CLOSED);
    }
    if (uncertain) {
      return Promise.resolve(UNKNOWN);
    }
    if (active) {
      return Promise.resolve(BUSY);
    }
    const current = runImport(normalized)
      .then((result) => {
        uncertain = result?.unknown === true;
        return result;
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
