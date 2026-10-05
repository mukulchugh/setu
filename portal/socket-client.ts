type Listener = (data: unknown) => void;
type Socket = Pick<
  WebSocket,
  | 'readyState'
  | 'send'
  | 'close'
  | 'onopen'
  | 'onmessage'
  | 'onclose'
  | 'onerror'
>;
interface Observation {
  code?: string;
  observedAt: number;
  state: 'ready' | 'unknown';
}
export interface ConnectionState {
  checkedAt?: number;
  error?: string;
  generation: number;
  listenerObservation?: Observation;
  phase:
    | 'paused'
    | 'refreshing'
    | 'current'
    | 'last-received'
    | 'reconnecting'
    | 'stale';
  receivedAt?: number;
}
interface Options {
  cancel: (timer: any) => void;
  now: () => number;
  onVisibility: (cb: () => void) => () => void;
  openSocket: () => Socket;
  readSnapshot: () => Promise<unknown>;
  schedule: (cb: () => void, ms: number) => any;
  visible: () => boolean;
}

// The socket owns view reads only. Hiding never cancels a mutation or process.
export function createPortalSocket(io: Options) {
  const listeners = new Map<string, Set<Listener>>();
  const resync = new Map<string, Set<() => void>>();
  const snapshots = new Map<string, unknown>();
  const stateListeners = new Set<(state: ConnectionState) => void>();
  let socket: Socket | null = null,
    generation = 0,
    backoff = 500;
  let reconnect: any = null,
    fallback: any = null,
    deadline: any = null;
  let removeVisibility: (() => void) | null = null;
  let hasConnected = false,
    awaiting = true,
    fallbackPending = false,
    delivery = 0;
  let state: ConnectionState = {
    generation,
    phase: io.visible() ? 'refreshing' : 'paused',
  };

  const wanted = () => listeners.size > 0 && io.visible();
  const publish = (next: Partial<ConnectionState>) => {
    state = Object.freeze({ ...state, ...next, generation });
    for (const cb of stateListeners) {
      cb(state);
    }
  };
  const clear = (timer: any) => {
    if (timer !== null) {
      io.cancel(timer);
    }
  };
  const send = (message: unknown) => {
    if (socket?.readyState === 1) {
      socket.send(JSON.stringify(message));
    }
  };
  function invalidate() {
    generation += 1;
    clear(reconnect);
    clear(fallback);
    clear(deadline);
    deadline = null;
    fallback = null;
    reconnect = null;
    const previous = socket;
    socket = null;
    previous?.close();
  }
  function freshness(data: any, heartbeat = false, viaHttp = false) {
    const capable =
      Number.isFinite(data?.checkedAt) && data?.listenerObservation;
    if (capable) {
      const observation = { ...data.listenerObservation } as Observation;
      if (
        !Number.isFinite(observation.observedAt) ||
        data.checkedAt < observation.observedAt ||
        data.checkedAt - observation.observedAt > 1500
      ) {
        observation.state = 'unknown';
        observation.code = 'OBSERVATION_EXPIRED';
      }
      publish({
        checkedAt: data.checkedAt,
        error:
          observation.state === 'unknown'
            ? 'Current process status could not be checked.'
            : undefined,
        listenerObservation: observation,
      });
      if (observation.state !== 'ready') {
        return;
      }
      awaiting = false;
      clear(fallback);
      fallback = null;
      clear(deadline);
      const receipt = io.now(),
        ownGeneration = generation;
      const streamMissing = viaHttp && socket?.readyState !== 1;
      publish({
        error: streamMissing
          ? 'Snapshot refreshed; live updates are unavailable.'
          : undefined,
        phase: streamMissing ? 'reconnecting' : 'current',
        receivedAt: receipt,
      });
      deadline = io.schedule(() => {
        deadline = null;
        if (ownGeneration === generation && wanted()) {
          publish({ phase: 'stale' });
        }
      }, 75_000);
    } else if (!heartbeat) {
      awaiting = false;
      clear(fallback);
      fallback = null;
      clear(deadline);
      deadline = null;
      publish({
        checkedAt: undefined,
        error: undefined,
        listenerObservation: undefined,
        phase: 'last-received',
        receivedAt: io.now(),
      });
    }
  }
  function receive(topic: string, data: any, viaHttp = false) {
    if (topic === 'worktrees:checked') {
      if (listeners.has('worktrees')) {
        freshness(data, true);
      }
      return;
    }
    const subscribers = listeners.get(topic);
    if (!subscribers?.size) {
      return;
    }
    if (topic === 'worktrees') {
      if (!(Array.isArray(data) || Array.isArray(data?.worktrees))) {
        return;
      }
      delivery += 1;
      freshness(data, false, viaHttp);
    }
    if (topic.startsWith('logs:') && Array.isArray(data)) {
      const previous = snapshots.get(topic) as { lines?: string[] } | undefined;
      const text = [...(previous?.lines ?? []), ...data]
        .slice(-150)
        .join('\n')
        .slice(-256 * 1024);
      data = { lines: text.split('\n') };
    }
    snapshots.set(topic, data);
    for (const cb of subscribers) {
      cb(data);
    }
  }
  function armFallback(ownGeneration: number) {
    if (fallback !== null || fallbackPending) {
      return;
    }
    if (!listeners.has('worktrees')) {
      return;
    }
    fallback = io.schedule(async () => {
      fallback = null;
      if (!wanted() || generation !== ownGeneration || !awaiting) {
        return;
      }
      const ownDelivery = delivery;
      fallbackPending = true;
      try {
        const result = await io.readSnapshot();
        if (
          wanted() &&
          generation === ownGeneration &&
          awaiting &&
          delivery === ownDelivery
        ) {
          receive('worktrees', result, true);
        }
      } catch {
        if (wanted() && generation === ownGeneration) {
          publish({
            error:
              'Could not refresh worktrees. Retry when the portal is available.',
          });
        }
      } finally {
        fallbackPending = false;
        if (generation !== ownGeneration && wanted() && awaiting) {
          armFallback(generation);
        }
      }
    }, 5000);
  }
  function connect(
    phase: ConnectionState['phase'] = hasConnected
      ? 'reconnecting'
      : 'refreshing'
  ) {
    reconnect = null;
    if (!wanted() || socket) {
      return;
    }
    const ownGeneration = generation;
    awaiting = true;
    publish({ phase });
    armFallback(ownGeneration);
    let current: Socket;
    try {
      current = io.openSocket();
    } catch {
      scheduleReconnect();
      return;
    }
    socket = current;
    const valid = () =>
      generation === ownGeneration && socket === current && wanted();
    current.onopen = () => {
      if (!valid()) {
        return;
      }
      backoff = 500;
      if (hasConnected) {
        for (const topic of listeners.keys()) {
          if (topic.startsWith('logs:')) {
            snapshots.delete(topic);
          }
        }
        for (const callbacks of resync.values()) {
          for (const cb of callbacks) {
            cb();
          }
        }
      }
      hasConnected = true;
      for (const topic of listeners.keys()) {
        send({ sub: topic });
      }
    };
    current.onmessage = (event) => {
      if (!valid()) {
        return;
      }
      try {
        const frame = JSON.parse(String(event.data));
        if (typeof frame.topic === 'string') {
          receive(frame.topic, frame.data);
        }
      } catch {
        // Ignore malformed frames; they cannot replace the last good snapshot.
      }
    };
    current.onclose = () => {
      if (!valid()) {
        return;
      }
      socket = null;
      clear(deadline);
      deadline = null;
      publish({ phase: 'reconnecting' });
      scheduleReconnect();
    };
    current.onerror = () => {
      // The close event owns reconnection; error alone must not create a second socket.
    };
  }
  function scheduleReconnect() {
    if (!wanted() || reconnect !== null) {
      return;
    }
    reconnect = io.schedule(() => connect(), backoff);
    backoff = Math.min(backoff * 2, 5000);
  }
  function visibilityChanged() {
    if (!io.visible()) {
      invalidate();
      publish({ phase: 'paused' });
      return;
    }
    if (socket || reconnect !== null) {
      return;
    }
    // Resume starts a new observation; cached rows remain readable.
    connect('refreshing');
  }

  return {
    getState: () => state,
    onState(cb: (state: ConnectionState) => void) {
      stateListeners.add(cb);
      cb(state);
      return () => {
        stateListeners.delete(cb);
      };
    },
    refresh() {
      if (!wanted() || (awaiting && (fallback !== null || fallbackPending))) {
        return;
      }
      invalidate();
      connect('refreshing');
    },
    subscribe(topic: string, cb: Listener, onResync?: () => void) {
      if (!removeVisibility) {
        removeVisibility = io.onVisibility(visibilityChanged);
      }
      let subscribers = listeners.get(topic);
      const first = !subscribers;
      if (!subscribers) {
        subscribers = new Set();
        listeners.set(topic, subscribers);
      }
      subscribers.add(cb);
      if (onResync) {
        let callbacks = resync.get(topic);
        if (!callbacks) {
          callbacks = new Set();
          resync.set(topic, callbacks);
        }
        callbacks.add(onResync);
      }
      if (io.visible() && snapshots.has(topic)) {
        cb(snapshots.get(topic));
      }
      if (socket) {
        if (first) {
          send({ sub: topic });
        }
      } else if (reconnect === null) {
        connect();
      }
    },
    unsubscribe(topic: string, cb: Listener, onResync?: () => void) {
      const subscribers = listeners.get(topic);
      subscribers?.delete(cb);
      if (subscribers?.size === 0) {
        listeners.delete(topic);
        snapshots.delete(topic);
        send({ unsub: topic });
      }
      if (onResync) {
        const callbacks = resync.get(topic);
        callbacks?.delete(onResync);
        if (!callbacks?.size) {
          resync.delete(topic);
        }
      }
      if (!listeners.size) {
        invalidate();
        removeVisibility?.();
        removeVisibility = null;
      }
    },
  };
}
