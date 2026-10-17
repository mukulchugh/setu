// View subscriptions do not own queue draining or process supervision.
export function createWorktreeStream({
  readSnapshot,
  publish,
  schedule = setInterval,
  cancel = clearInterval,
  now = Date.now,
}) {
  let current = null;
  async function tick(entry) {
    if (current !== entry || entry.pending) {
      return;
    }
    entry.pending = true;
    try {
      const payload = await readSnapshot();
      if (current !== entry || !entry.clients.size) {
        return;
      }
      const content = JSON.stringify({
        observationState: payload.listenerObservation?.state,
        status: payload.status,
        worktrees: payload.worktrees,
      });
      if (content !== entry.content) {
        entry.content = content;
        entry.deliveredAt = now();
        publish(
          'worktrees',
          JSON.stringify({ data: payload, topic: 'worktrees' })
        );
      } else if (
        payload.listenerObservation?.state === 'ready' &&
        now() - entry.deliveredAt >= 30_000
      ) {
        entry.deliveredAt = now();
        publish(
          'worktrees',
          JSON.stringify({
            data: {
              checkedAt: payload.checkedAt,
              listenerObservation: payload.listenerObservation,
            },
            topic: 'worktrees:checked',
          })
        );
      }
    } catch {
      // The client freshness deadline exposes failed checks without erasing rows.
    } finally {
      entry.pending = false;
    }
  }
  return {
    close(ws) {
      const entry = current;
      if (!entry?.clients.delete(ws)) {
        return;
      }
      if (!entry.clients.size) {
        cancel(entry.timer);
        current = null;
      }
    },
    async open(ws) {
      let entry = current;
      if (!entry) {
        entry = {
          clients: new Set(),
          content: null,
          deliveredAt: now(),
          pending: false,
          timer: null,
        };
        current = entry;
        entry.timer = schedule(() => {
          tick(entry);
        }, 3000);
      }
      if (entry.clients.has(ws)) {
        return;
      }
      entry.clients.add(ws);
      ws.subscribe('worktrees');
      try {
        const payload = await readSnapshot();
        if (current === entry && entry.clients.has(ws)) {
          ws.send(JSON.stringify({ data: payload, topic: 'worktrees' }));
        }
      } catch {
        // Keep the last good snapshot; a later stream tick retries the read.
      }
    },
  };
}

export async function readFreshWorktreeSnapshot({
  listeners,
  worktrees,
  status,
  now = Date.now,
}) {
  await listeners.read();
  let observation = listeners.observation();
  let [rows, serverStatus] = await Promise.all([worktrees(), status()]);
  if (observation.state === 'ready' && now() - observation.observedAt > 1500) {
    // Cold Git/status work can outlive the listener TTL. Recompose once with
    // refreshed listeners; a still-slow result stays explicitly unknown.
    await listeners.read();
    observation = listeners.observation();
    rows = await worktrees();
  }
  const checkedAt = now();
  if (
    observation.state === 'ready' &&
    (checkedAt < observation.observedAt ||
      checkedAt - observation.observedAt > 1500)
  ) {
    observation = {
      ...observation,
      code: 'OBSERVATION_EXPIRED',
      state: 'unknown',
    };
  }
  return {
    checkedAt,
    listenerObservation: observation,
    status: serverStatus,
    worktrees: rows,
  };
}
