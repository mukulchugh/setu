import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { createSpansArtifacts } from './spans-artifacts.js';
import { createSpansExecution } from './spans-execution.js';
import { isRecord } from './spans-execution-core.js';
import {
  SPANS_EXECUTION_GET_ROUTES,
  SPANS_EXECUTION_POST_ROUTES,
} from './spans-execution-routes.js';
import { defaultSpansRoot } from './spans-runtime.js';
import { openSpansStore, SPANS_STORE_DATABASE_FILE } from './spans-store.js';

// Portal-side composition for Spans execution. It stays out of the way unless
// the machine owner turned execution on in the Setu configuration: until then
// no archive is opened, no service exists and every execution route answers
// 503. Turning it on is explicit configuration, never a request.
//
//   "spansExecution": { "enabled": true, "runBudgetUsd": 10 }
// runBudgetUsd only bounds metered profiles; the subscription profile has none.
//
// The setting is read once, when the portal starts. Changing it in the
// configuration file takes effect after the portal is restarted.

const MAX_RUN_BUDGET_USD = 100;

function settings(config) {
  const block = config?.spansExecution;
  if (block === undefined) {
    return { enabled: false };
  }
  if (
    !(
      isRecord(block) &&
      typeof block.enabled === 'boolean' &&
      Object.keys(block).every((key) =>
        ['enabled', 'runBudgetUsd'].includes(key)
      ) &&
      (block.runBudgetUsd === undefined ||
        (typeof block.runBudgetUsd === 'number' &&
          block.runBudgetUsd > 0 &&
          block.runBudgetUsd <= MAX_RUN_BUDGET_USD))
    )
  ) {
    return { enabled: false, invalid: true };
  }
  return { enabled: block.enabled, runBudgetUsd: block.runBudgetUsd };
}

const configInvalid = Object.freeze({
  code: 'SPANS_EXECUTION_CONFIG_INVALID',
  error: 'The spansExecution setting is not valid; execution stays disabled.',
  ok: false,
});

// Read paths never initialize or migrate an archive. The first writable
// handle opens only inside the execution service's admitted write effect.
function executionArchive(root) {
  let handle = null;
  let writable = false;
  let closed = false;
  const unavailable = () => ({
    code: 'SPANS_EXEC_ARCHIVE_UNAVAILABLE',
    ok: false,
  });
  const reader = () => {
    if (closed) {
      throw new Error('Execution archive is closed.');
    }
    handle ??= openSpansStore({ create: false, readonly: true, root });
    return handle;
  };
  const prepareWrite = () => {
    if (closed) {
      throw new Error('Execution archive is closed.');
    }
    if (writable) {
      return;
    }
    if (handle && handle.close()?.ok !== true) {
      throw new Error('Execution archive reader could not close.');
    }
    handle = null;
    handle = openSpansStore({ create: false, root });
    writable = true;
  };
  const store = {};
  for (const method of [
    'getArtifactReference',
    'getEventById',
    'listRuns',
    'readCache',
    'readEvents',
    'readRun',
    'readSourceCursor',
  ]) {
    store[method] = (...args) => {
      try {
        return reader()[method](...args);
      } catch {
        return unavailable();
      }
    };
  }
  for (const method of [
    'appendEvent',
    'commitRun',
    'writeCache',
    'withCurrentAttempt',
  ]) {
    store[method] = (...args) => {
      if (!(writable && handle) || closed) {
        return unavailable();
      }
      return handle[method](...args);
    };
  }
  return {
    artifacts: createSpansArtifacts({ root }),
    close() {
      closed = true;
      const result = handle?.close() ?? { ok: true };
      if (result.ok === true) {
        handle = null;
      }
      return result;
    },
    prepareWrite,
    root,
    store: Object.freeze(store),
  };
}

export function createSpansExecutionRuntime({
  admission,
  config,
  injected,
  resourcePaths,
  resolveTarget,
  root = defaultSpansRoot(),
  setupProgress,
}) {
  const chosen = settings(config);
  if (!(injected || chosen.enabled)) {
    // Disabled: no services at all, so the routes answer 503 and nothing opens.
    return Object.freeze({
      close: () => Promise.resolve(),
      recover: () => Promise.resolve({ ok: true, skipped: true }),
      // A malformed setting is told apart from a switched-off one on every
      // route, so nobody is left guessing why execution is unavailable.
      services: Object.hasOwn(chosen, 'invalid')
        ? Object.freeze(
            Object.fromEntries(
              [
                ...Object.values(SPANS_EXECUTION_POST_ROUTES),
                ...Object.values(SPANS_EXECUTION_GET_ROUTES).map(
                  (route) => route.action
                ),
              ].map((name) => [name, () => configInvalid])
            )
          )
        : Object.freeze({}),
    });
  }

  let opened = null;
  let closed = false;
  const closedResult = () => ({ code: 'SPANS_EXEC_RUNTIME_CLOSED', ok: false });
  function open() {
    if (injected) {
      return injected;
    }
    if (!opened) {
      const archive = executionArchive(root);
      opened = {
        archive,
        service: createSpansExecution({
          admission,
          archive,
          resolveTarget,
          resourcePaths,
          runBudgetUsd: chosen.runBudgetUsd,
          setupProgress,
        }),
      };
    }
    return opened.service;
  }

  async function status(input) {
    if (closed) {
      return closedResult();
    }
    const service = open();
    const result = await service.status(input);
    return result.ok
      ? { ...result, usage: await service.usage(input) }
      : result;
  }

  const invoke = (method, input) =>
    closed ? closedResult() : open()[method](input);

  return Object.freeze({
    async close() {
      closed = true;
      if (injected) {
        return;
      }
      if (opened) {
        await opened.service.close();
        if (opened.archive.close()?.ok !== true) {
          throw new Error('Execution archive could not close.');
        }
        opened = null;
      }
    },
    // At startup, only an archive that already exists is reconciled. This holds
    // what is unknown and settles what is proven; it never starts anything.
    recover() {
      if (closed) {
        return Promise.resolve(closedResult());
      }
      if (!(injected || existsSync(join(root, SPANS_STORE_DATABASE_FILE)))) {
        return Promise.resolve({ ok: true, skipped: true });
      }
      return open().reconcile();
    },
    services: Object.freeze({
      spansExecutionAccept: (input) => invoke('accept', input),
      spansExecutionApprovalChallenge: (input) =>
        invoke('approvalChallenge', input),
      spansExecutionApprove: (input) => invoke('approve', input),
      spansExecutionCancel: (input) => invoke('cancel', input),
      spansExecutionCapabilities: (input) => invoke('capabilities', input),
      spansExecutionComplete: (input) => invoke('complete', input),
      spansExecutionDispatch: (input) => invoke('dispatch', input),
      spansExecutionPrepare: (input) => invoke('prepare', input),
      spansExecutionProbe: (input) => invoke('probe', input),
      spansExecutionReadReview: (input) => invoke('readReview', input),
      spansExecutionReconcile: (input) => invoke('reconcile', input),
      spansExecutionReport: (input) => invoke('report', input),
      spansExecutionResolve: (input) => invoke('resolve', input),
      spansExecutionReview: (input) => invoke('review', input),
      spansExecutionRevoke: (input) => invoke('revoke', input),
      spansExecutionStatus: status,
    }),
  });
}
