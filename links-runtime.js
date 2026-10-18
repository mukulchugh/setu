import { existsSync } from 'node:fs';
import { homedir, userInfo } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createLinksClient } from './links-client.js';
import { createLinksService } from './links-service.js';
import { listWriterClaims } from './writer-claims.js';

const defaultEngine = join(
  dirname(fileURLToPath(import.meta.url)),
  'engines/links/target/release/setu-links'
);

export const PRESENCE_INTERVAL_MS = 30_000;

// The task a session is working on, as that session wrote it in its own worktree's active writer claim, with
// the claim's own heartbeat as the time it was last refreshed. A claim held by any other session is not this
// session's task. An expired claim still shows its task, with its own old heartbeat, so the directory marks it
// old instead of dropping it. Reading a claim never changes it.
export function claimTaskLabel(record, list = listWriterClaims) {
  if (typeof record?.checkoutPath !== 'string') {
    return null;
  }
  try {
    const mine = [record.id, record.nativeConversation?.id].filter(Boolean);
    const claim = list([record.checkoutPath], { includeStale: true }).find(
      (row) => !(row.error || row.unreadable) && mine.includes(row.session)
    );
    const at = Date.parse(claim?.heartbeat);
    return typeof claim?.task === 'string' && Number.isFinite(at)
      ? { at, text: claim.task }
      : null;
  } catch {
    return null;
  }
}

// Presence is published by one interval the portal starts and disposes. A round never overlaps another, a
// failed round is dropped (the next one tries again), and nothing runs once disposed.
function createPresenceLifecycle({ publish, timers }) {
  let timer = null;
  let running = null;
  let disposed = false;

  function round() {
    if (disposed) {
      return Promise.resolve();
    }
    running ??= (async () => {
      try {
        await publish();
      } catch {
        // The next round publishes again.
      } finally {
        running = null;
      }
    })();
    return running;
  }

  return Object.freeze({
    async dispose() {
      disposed = true;
      if (timer !== null) {
        timers.clearInterval(timer);
        timer = null;
      }
      await running;
    },
    start() {
      if (disposed || timer !== null) {
        return;
      }
      timer = timers.setInterval(round, PRESENCE_INTERVAL_MS);
      timer?.unref?.();
      round();
    },
  });
}

// Composition only. Nothing starts and nothing is created until an operation runs; the engine process
// that serves it creates its own private store on the first send. A read, a report or a claim never creates one.
export function createLinksRuntime({
  root = join(homedir(), '.local/share/setu/links'),
  enginePath = process.env.SETU_LINKS_ENGINE ?? defaultEngine,
  isProject,
  resolveTarget,
  sessions,
  taskLabel = claimTaskLabel,
  timeoutMs,
  timers = { clearInterval, setInterval },
} = {}) {
  const service = createLinksService({
    client: createLinksClient({ dataDir: root, enginePath, timeoutMs }),
    defaultOwner: () => {
      try {
        return userInfo().username;
      } catch {
        // No owner label could be read; enabling then asks for one.
      }
    },
    isProject,
    resolveTarget,
    sessions,
    taskLabel,
  });
  return Object.freeze({
    // For the authenticated prompt hook only (see portal.js): never a route, tool or command.
    delivery: Object.freeze({
      claimExact: service.claimExact,
      confirmExact: service.confirmExact,
      reconcileExact: service.reconcileExact,
    }),
    linksAck: service.ack,
    linksCancel: service.cancel,
    linksDirectory: service.directory,
    linksInbox: service.inbox,
    linksPresence: createPresenceLifecycle({
      // Nothing can be shared before the engine has a data directory, so until then a round starts nothing.
      publish: () =>
        existsSync(root)
          ? service.publishPresence()
          : { ok: true, published: 0 },
      timers,
    }),
    linksRedeliver: service.redeliver,
    linksSend: service.send,
    linksShareDisable: service.shareDisable,
    linksShareEnable: service.shareEnable,
    linksShareStatus: service.shareStatus,
    linksShow: service.show,
    linksStatus: service.status,
    // Nothing can be shared before the engine has a data directory, so removing a project then has nothing to withdraw.
    linksWithdrawSharing: (name) =>
      existsSync(root)
        ? service.withdrawSharing(name)
        : Promise.resolve({ ok: true, removed: false }),
  });
}
