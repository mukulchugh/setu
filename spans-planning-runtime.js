// Lazy filesystem boundary for the offline Spans planning facade. The archive
// root is always supplied by the caller; this module has no default location.

import fs from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { createSpansPlanning } from './spans-planning.js';
import { openSpansStore } from './spans-store.js';

const closedResult = Object.freeze({
  code: 'SPANS_PLANNING_CLOSED',
  error: 'Spans planning runtime is closed.',
  ok: false,
});
const unavailableResult = Object.freeze({
  code: 'SPANS_DRAFT_STORAGE',
  error: 'Spans draft could not be stored or read.',
  ok: false,
});
const notFoundResult = Object.freeze({
  code: 'SPANS_MODEL_NOT_FOUND',
  error: 'Spans model record was not found.',
  ok: false,
});
const pathSeparatorPattern = /[\\/]/;

function readRoot(options) {
  try {
    if (
      options === null ||
      typeof options !== 'object' ||
      Array.isArray(options) ||
      Reflect.ownKeys(options).length !== 1 ||
      !Reflect.ownKeys(options).includes('root')
    ) {
      return;
    }
    const descriptor = Object.getOwnPropertyDescriptor(options, 'root');
    if (!(descriptor?.enumerable && Object.hasOwn(descriptor, 'value'))) {
      return;
    }
    const root = descriptor.value;
    if (
      typeof root === 'string' &&
      root.length > 0 &&
      !root.includes('\0') &&
      isAbsolute(root) &&
      !root.split(pathSeparatorPattern).includes('..')
    ) {
      return root;
    }
  } catch {
    // A hostile proxy is invalid input; never expose its exception.
  }
}

function didClose(handle) {
  try {
    return handle.close()?.ok === true;
  } catch {
    return false;
  }
}

// Provision only Setu's default location, never arbitrary caller-supplied parents.
export function prepareSpansDefaultParent(root) {
  const home = homedir();
  if (root !== join(home, '.local/share/setu/spans')) {
    return;
  }
  let path = home;
  for (const part of ['.local', 'share', 'setu']) {
    path = join(path, part);
    try {
      fs.mkdirSync(path, { mode: 0o700 });
    } catch (error) {
      if (error.code !== 'EEXIST') {
        throw error;
      }
    }
    const stat = fs.lstatSync(path);
    // biome-ignore lint/suspicious/noBitwiseOperators: POSIX permission masks require bitwise checks.
    const unsafeMode = (stat.mode & 0o022) !== 0;
    // biome-ignore lint/suspicious/noBitwiseOperators: Compare the exact private directory permissions.
    const privateMode = (stat.mode & 0o777) === 0o700;
    if (
      !stat.isDirectory() ||
      stat.isSymbolicLink() ||
      (typeof process.getuid === 'function' && stat.uid !== process.getuid()) ||
      unsafeMode ||
      (part === 'setu' && !privateMode)
    ) {
      throw new Error('Spans default parent is unsafe.');
    }
  }
}

function createLazyStore(root) {
  let reader;
  let writer;
  let closed = false;
  let creating = false;
  let closeFailed = false;

  function openReader() {
    if (closeFailed) {
      throw new Error('Spans store close failed.');
    }
    if (!(reader || writer)) {
      reader = openSpansStore({ readonly: true, root });
    }
    return writer ?? reader;
  }

  function closeReader() {
    if (!reader) {
      return;
    }
    if (!didClose(reader)) {
      closeFailed = true;
      throw new Error('Spans store close failed.');
    }
    reader = undefined;
    closeFailed = false;
  }

  function closeOwnedHandle(key) {
    const handle = key === 'reader' ? reader : writer;
    if (!handle) {
      return true;
    }
    if (!didClose(handle)) {
      return false;
    }
    if (key === 'reader') {
      reader = undefined;
    } else {
      writer = undefined;
    }
    return true;
  }

  const store = {
    commitRun(request) {
      if (closed || closeFailed) {
        return unavailableResult;
      }
      try {
        closeReader();
        if (!writer) {
          prepareSpansDefaultParent(root);
          writer = openSpansStore({ root });
        }
        return writer.commitRun(request);
      } catch {
        return unavailableResult;
      }
    },
    readEvents(query) {
      if (closed || closeFailed) {
        return unavailableResult;
      }
      try {
        return openReader().readEvents(query);
      } catch {
        return unavailableResult;
      }
    },
    readRun(query) {
      if (closed || closeFailed) {
        return unavailableResult;
      }
      try {
        const current = openReader();
        return current.readRun(query);
      } catch (error) {
        // A missing archive is an empty store only during validated creation.
        // Every other path, including revision, remains unavailable.
        return creating &&
          ['root-missing', 'database-missing'].includes(error?.phase)
          ? notFoundResult
          : unavailableResult;
      }
    },
  };
  return {
    close() {
      if (closed) {
        return { ok: true };
      }
      const readerClosed = closeOwnedHandle('reader');
      const writerClosed = closeOwnedHandle('writer');
      const ok = readerClosed && writerClosed;
      closeFailed = !ok;
      if (ok) {
        closed = true;
        return { ok: true };
      }
      return unavailableResult;
    },
    isCloseFailed() {
      return closeFailed;
    },
    store,
    withCreate(operation) {
      creating = true;
      try {
        return operation();
      } finally {
        creating = false;
      }
    },
  };
}

export function createSpansPlanningRuntime(options) {
  const root = readRoot(options);
  if (!root) {
    throw new TypeError('Spans planning runtime requires an absolute root.');
  }
  const lazy = createLazyStore(root);
  const planning = createSpansPlanning({ store: lazy.store });
  let closed = false;
  const invoke = (method, input) => {
    if (closed) {
      return { ...closedResult };
    }
    if (lazy.isCloseFailed()) {
      return { ...unavailableResult };
    }
    try {
      return planning[method](input);
    } catch {
      return { ...unavailableResult };
    }
  };

  return Object.freeze({
    close() {
      if (closed) {
        return { ok: true };
      }
      const result = lazy.close();
      if (result.ok === true) {
        closed = true;
      }
      return result;
    },
    spansDraftCreate(input) {
      if (closed) {
        return { ...closedResult };
      }
      return lazy.withCreate(() => invoke('createDraft', input));
    },
    spansPlanRevise(input) {
      return invoke('revisePlan', input);
    },
    spansWorkflowCreate(input) {
      if (closed) {
        return { ...closedResult };
      }
      return lazy.withCreate(() => invoke('createFromWorkflow', input));
    },
    spansWorkflowPreview(input) {
      return invoke('previewWorkflow', input);
    },
    spansWorkflows() {
      if (closed) {
        return { ...closedResult };
      }
      return invoke('listWorkflows');
    },
  });
}
