import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createLinksClient } from './links-client.js';
import { createLinksService } from './links-service.js';

const defaultEngine = join(
  dirname(fileURLToPath(import.meta.url)),
  'engines/links/target/release/setu-links'
);

// Composition only. Nothing starts and nothing is created until an operation runs; the engine process
// that serves it creates its own private store on the first send. A read, a report or a claim never creates one.
export function createLinksRuntime({
  root = join(homedir(), '.local/share/setu/links'),
  enginePath = process.env.SETU_LINKS_ENGINE ?? defaultEngine,
  resolveTarget,
  sessions,
  timeoutMs,
} = {}) {
  const service = createLinksService({
    client: createLinksClient({ dataDir: root, enginePath, timeoutMs }),
    resolveTarget,
    sessions,
  });
  return Object.freeze({
    linksAck: service.ack,
    linksCancel: service.cancel,
    linksInbox: service.inbox,
    linksRedeliver: service.redeliver,
    linksSend: service.send,
    linksShow: service.show,
    linksStatus: service.status,
  });
}
