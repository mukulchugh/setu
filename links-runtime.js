import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createLinksClient } from './links-client.js';
import { createLinksHistoryService } from './links-history-service.js';
import { createLinksService } from './links-service.js';

const defaultEngine = join(
  dirname(fileURLToPath(import.meta.url)),
  'engines/links/target/release/setu-links'
);

// The same history service for an explicit offline command: no portal, only
// the engine process and the Spans archive it is pointed at.
export function createOfflineLinksHistory({
  enginePath = process.env.SETU_LINKS_ENGINE ?? defaultEngine,
  linksRoot = join(homedir(), '.local/share/setu/links'),
  spansRoot = join(homedir(), '.local/share/setu/spans'),
  timeoutMs,
} = {}) {
  return createLinksHistoryService({
    client: createLinksClient({ dataDir: linksRoot, enginePath, timeoutMs }),
    spansRoot,
  });
}

// Composition only. Nothing starts and nothing is created until an operation runs; the engine process
// that serves it creates its own private store on the first send. A read, a report or a claim never creates one.
export function createLinksRuntime({
  root = join(homedir(), '.local/share/setu/links'),
  enginePath = process.env.SETU_LINKS_ENGINE ?? defaultEngine,
  resolveTarget,
  sessions,
  spansRoot = join(homedir(), '.local/share/setu/spans'),
  timeoutMs,
} = {}) {
  const client = createLinksClient({ dataDir: root, enginePath, timeoutMs });
  const service = createLinksService({ client, resolveTarget, sessions });
  const history = createLinksHistoryService({ client, spansRoot });
  return Object.freeze({
    linksAck: service.ack,
    linksAssociationApprove: history.associationApprove,
    linksAssociationPreview: history.associationPreview,
    linksAssociationRevoke: history.associationRevoke,
    linksAssociations: history.associations,
    linksCancel: service.cancel,
    linksEvidenceAttach: history.evidenceAttach,
    linksEvidencePreview: history.evidencePreview,
    linksInbox: service.inbox,
    linksProjectionStatus: history.projectionStatus,
    linksRecovery: history.recovery,
    linksRedeliver: service.redeliver,
    linksSend: service.send,
    linksShow: service.show,
    linksStatus: service.status,
  });
}
