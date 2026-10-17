import { lstatSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createSpansArtifacts } from './spans-artifacts.js';
import { createSpansService } from './spans-service.js';
import { openSpansStore, SPANS_STORE_DATABASE_FILE } from './spans-store.js';

const unavailable = () => ({
  code: 'SPANS_SERVICE_UNAVAILABLE',
  error: 'Spans history is unavailable. Select or create an archive first.',
  ok: false,
});

// Reads never initialize an archive. The explicit offline command owns creation.
export function createSpansRuntime({
  root = join(homedir(), '.local/share/setu/spans'),
} = {}) {
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
      store = openSpansStore({ root });
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
  const read = (method, input) => reader()?.[method](input) ?? unavailable();
  return Object.freeze({
    close() {
      closed = true;
      return store?.close() ?? { ok: true };
    },
    spansArtifact: (input) => read('getArtifact', input),
    spansEvents: (input) => read('getEvents', input),
    spansRun: (input) => read('getRun', input),
    spansRuns: (input) => read('listRuns', input),
  });
}
