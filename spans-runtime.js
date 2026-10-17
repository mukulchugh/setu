import { lstatSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createSpansArtifacts } from './spans-artifacts.js';
import { createSpansPlanningRuntime } from './spans-planning-runtime.js';
import { createSpansService } from './spans-service.js';
import { openSpansStore, SPANS_STORE_DATABASE_FILE } from './spans-store.js';

const unavailable = () => ({
  code: 'SPANS_SERVICE_UNAVAILABLE',
  error: 'Spans history is unavailable. Select or create an archive first.',
  ok: false,
});

// Reads never initialize an archive, migrate it, or build a search index. The
// store opens read-only, so a missing, older or newer schema is simply
// unavailable. Explicit draft creation owns initialization; the offline index
// command owns derived search indexing.
export function createSpansRuntime({
  root = join(homedir(), '.local/share/setu/spans'),
} = {}) {
  const { close: closePlanning, ...planning } = createSpansPlanningRuntime({
    root,
  });
  let store;
  let service;
  let closed = false;
  function reader() {
    if (closed) {
      return null;
    }
    if (service) {
      return service;
    }
    try {
      const file = lstatSync(join(root, SPANS_STORE_DATABASE_FILE));
      if (!file.isFile() || file.isSymbolicLink()) {
        return null;
      }
      store = openSpansStore({ readonly: true, root });
      service = createSpansService({
        artifacts: createSpansArtifacts({ root }),
        getArtifactReference: store.getArtifactReference,
        store,
      });
      return service;
    } catch {
      store?.close();
      store = undefined;
      return null;
    }
  }
  const read = (method, input) => reader()?.[method]?.(input) ?? unavailable();
  return Object.freeze({
    ...planning,
    close() {
      closed = true;
      const readResult = store?.close() ?? { ok: true };
      const planningResult = closePlanning();
      return readResult.ok === true ? planningResult : readResult;
    },
    spansArtifact: (input) => read('getArtifact', input),
    spansEvents: (input) => read('getEvents', input),
    spansRun: (input) => read('getRun', input),
    spansRuns: (input) => read('listRuns', input),
    spansSearch: (input) => read('getSearch', input),
    spansSearchStatus: (input) => read('getSearchStatus', input),
  });
}
