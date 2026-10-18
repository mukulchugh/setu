// The trusted lifecycle seam. The managed session record is the only authority for a binding and its
// generation; this tells a publisher (the transport, when it is composed in) what that record says: publish
// a live verified binding, or invalidate one that ended, became unknown or lost its checkout.
//
// Best effort, and never a reason for a turn or the monitor to wait long. A caller waits for a publisher
// call at most `timeoutMs`; after that the call simply continues without being waited for. Per session there
// is at most one publish and at most one invalidation outstanding, each until it really settles: a later
// announcement of the same kind is skipped, never queued and never started beside it, so nothing piles up.
// Nothing is abandoned either, because an abandoned call would be a second one in flight. The composed
// publisher is the engine client, which kills a stuck engine at its own timeout and so always settles; a
// publisher that never settled would hold its slot and publish nothing more for that session, which is
// bounded and silent, not a backlog. An invalidation has its own slot so it is never held behind a stuck publish: the
// generation fence makes a publish that lands late harmless, because the invalidation carries a higher one.
//
// Only a reply that is literally `{ ok: true }` counts as "told". A rejection, `ok: false`, or anything
// malformed (null, undefined, `{}`, `{ ok: 'true' }`) is not evidence: an invalidation is not marked
// confirmed and a publish does not become a heartbeat, so both are retried at the same generation.

const delay = (ms) =>
  new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    // A pending wait must not keep a process alive.
    timer.unref?.();
  });

const told = (reply) => reply?.ok === true;

export function createLifecycleAnnouncer({
  lifecycle,
  sessions,
  now,
  heartbeatMs,
  timeoutMs = 500,
} = {}) {
  const lastPublished = new Map();
  const publishing = new Set();
  const invalidating = new Set();

  async function invalidate(record) {
    const { generation, reason } = record.bindingInvalid;
    if (record.bindingAnnounced === generation) {
      return;
    }
    const reply = await lifecycle.invalidate({
      generation,
      reason,
      sessionId: record.id,
    });
    if (told(reply)) {
      await sessions.markAnnounced(record.id, generation);
    }
  }

  async function publish(record, binding) {
    const generation = record.bindingGeneration ?? 0;
    const last = lastPublished.get(record.id);
    if (
      last &&
      last.generation === generation &&
      now() - last.at < heartbeatMs
    ) {
      return;
    }
    const reply = await lifecycle.publish({
      generation,
      project: record.repo,
      recipient: {
        checkoutIdentity: record.checkoutIdentity,
        nativeId: binding.id,
        provider: 'claude-code',
        sessionId: record.id,
      },
      resumedFrom: binding.resumedFrom ?? [],
    });
    if (told(reply)) {
      lastPublished.set(record.id, { at: now(), generation });
    }
  }

  // Starts one call in `slot` for a session unless one is still outstanding there, and waits for it at most
  // `timeoutMs`. The call is never cancelled and never repeated while it is outstanding.
  async function bounded(slot, sessionId, work) {
    if (slot.has(sessionId)) {
      return;
    }
    slot.add(sessionId);
    // `async` turns a synchronous throw from the publisher into a rejection like any other failure.
    const call = (async () => work())();
    const release = () => slot.delete(sessionId);
    call.then(release, release);
    await Promise.race([call.catch(() => undefined), delay(timeoutMs)]);
  }

  async function announce(record) {
    const binding = record?.nativeConversation;
    if (!(lifecycle && binding?.id && record.id)) {
      return;
    }
    try {
      if (record.bindingInvalid) {
        await bounded(invalidating, record.id, () => invalidate(record));
      } else if (
        record.ownership === 'owned' &&
        record.state === 'running' &&
        record.tool === 'claude-code'
      ) {
        await bounded(publishing, record.id, () => publish(record, binding));
      }
    } catch {
      // The next tick or turn tells it again.
    }
  }

  async function announceSession(sessionId) {
    try {
      await announce(sessions.get(sessionId));
    } catch {
      // Nothing here may fail a caller.
    }
  }

  // Sessions are independent, so their calls are started together and waited for together.
  async function announceAll() {
    try {
      await Promise.all(sessions.list().map((record) => announce(record)));
    } catch {
      // Same.
    }
  }

  return Object.freeze({ announceAll, announceSession });
}
