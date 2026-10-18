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

export function createSpansExecutionRuntime({
  admission,
  config,
  injected,
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
  function open() {
    if (injected) {
      return injected;
    }
    if (!opened) {
      const store = openSpansStore({ root });
      opened = {
        service: createSpansExecution({
          admission,
          archive: {
            artifacts: createSpansArtifacts({ root }),
            root,
            store,
          },
          resolveTarget,
          runBudgetUsd: chosen.runBudgetUsd,
          setupProgress,
        }),
        store,
      };
    }
    return opened.service;
  }

  async function status(input) {
    const service = open();
    const result = await service.status(input);
    return result.ok
      ? { ...result, usage: await service.usage(input) }
      : result;
  }

  return Object.freeze({
    async close() {
      if (injected) {
        return;
      }
      if (opened) {
        await opened.service.close();
        opened.store.close();
        opened = null;
      }
    },
    // At startup, only an archive that already exists is reconciled. This holds
    // what is unknown and settles what is proven; it never starts anything.
    recover() {
      if (!(injected || existsSync(join(root, SPANS_STORE_DATABASE_FILE)))) {
        return Promise.resolve({ ok: true, skipped: true });
      }
      return open().reconcile();
    },
    services: Object.freeze({
      spansExecutionAccept: (input) => open().accept(input),
      spansExecutionCancel: (input) => open().cancel(input),
      spansExecutionCapabilities: (input) => open().capabilities(input),
      spansExecutionComplete: (input) => open().complete(input),
      spansExecutionDispatch: (input) => open().dispatch(input),
      spansExecutionProbe: (input) => open().probe(input),
      spansExecutionReconcile: (input) => open().reconcile(input),
      spansExecutionReport: (input) => open().report(input),
      spansExecutionResolve: (input) => open().resolve(input),
      spansExecutionReview: (input) => open().review(input),
      spansExecutionStatus: status,
    }),
  });
}
