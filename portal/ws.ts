// Singleton WebSocket connection to the portal backend -- shared by every
// component that wants live server-pushed state (worktree list/status, log
// tails) instead of each one running its own HTTP polling loop. Connects
// lazily on first subscribe, reconnects with exponential backoff on close,
// and re-sends every topic that still has active listeners once the new
// connection opens (a fresh socket carries none of the old server-side
// subscriptions).
//
// Wire contract (matches the server implementation of the same spec):
//   client -> server: {"sub": "<topic>"} / {"unsub": "<topic>"} JSON frames
//   server -> client: {"topic": "<topic>", "data": <payload>} JSON frames

type Listener = (data: any) => void;
type ResyncListener = () => void;

const INITIAL_BACKOFF_MS = 500;
const MAX_BACKOFF_MS = 5000;

const listeners = new Map<string, Set<Listener>>();
// Fired per-topic right before a *reconnect* re-sends {sub: topic} -- lets a
// subscriber that accumulates incremental data (useLogStream) know the next
// payload is a fresh catch-up, not a delta, so it can reset its own state
// instead of appending onto a stream that's now stale. Not fired on the
// initial connect, only on reconnects (there's nothing to reset yet then).
const resyncListeners = new Map<string, Set<ResyncListener>>();
let socket: WebSocket | null = null;
let backoffMs = INITIAL_BACKOFF_MS;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let hasConnectedOnce = false;

function send(msg: Record<string, unknown>) {
  if (socket && socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(msg));
}

function connect() {
  reconnectTimer = null;
  socket = new WebSocket(`ws://${location.host}/ws`);

  socket.onopen = () => {
    backoffMs = INITIAL_BACKOFF_MS;
    const isReconnect = hasConnectedOnce;
    hasConnectedOnce = true;
    // A fresh connection starts with none of the previous connection's
    // server-side subscriptions (the server auto-subscribes 'worktrees' on
    // open regardless, so re-sending sub for it here is harmless). Re-request
    // every topic that still has a listener on this side.
    for (const topic of listeners.keys()) {
      if (isReconnect) for (const cb of resyncListeners.get(topic) ?? []) cb();
      send({ sub: topic });
    }
  };

  socket.onmessage = (ev) => {
    let msg: { topic?: string; data?: unknown };
    try { msg = JSON.parse(ev.data); } catch { return; }
    if (!msg.topic) return;
    const subs = listeners.get(msg.topic);
    if (!subs || subs.size === 0) return;
    for (const cb of subs) cb(msg.data);
  };

  socket.onclose = () => {
    socket = null;
    reconnectTimer = setTimeout(connect, backoffMs);
    backoffMs = Math.min(backoffMs * 2, MAX_BACKOFF_MS);
  };

  // onerror is always followed by the socket tearing itself down, which
  // fires onclose above -- that's where the reconnect is scheduled. This
  // handler just swallows the event so it doesn't hit the console unhandled.
  socket.onerror = () => {};
}

function ensureConnected() {
  if (!socket && !reconnectTimer) connect();
}

// One shared connection, many topic subscribers. subscribe/unsubscribe both
// take the same callback reference so two components watching the same
// topic at once (e.g. an inline LiveLog and a LogModal open on the same
// worktree's dev log) can come and go independently -- the server only sees
// one sub/unsub per topic, sent on the 0-to-1 and 1-to-0 listener edges.
export function getWs() {
  ensureConnected();
  return {
    subscribe(topic: string, onMessage: Listener, onResync?: ResyncListener) {
      ensureConnected();
      let subs = listeners.get(topic);
      if (!subs) {
        subs = new Set();
        listeners.set(topic, subs);
        send({ sub: topic });
      }
      subs.add(onMessage);
      if (onResync) {
        let rs = resyncListeners.get(topic);
        if (!rs) { rs = new Set(); resyncListeners.set(topic, rs); }
        rs.add(onResync);
      }
    },
    unsubscribe(topic: string, onMessage: Listener, onResync?: ResyncListener) {
      const subs = listeners.get(topic);
      if (subs) {
        subs.delete(onMessage);
        if (subs.size === 0) {
          listeners.delete(topic);
          send({ unsub: topic });
        }
      }
      if (onResync) {
        const rs = resyncListeners.get(topic);
        if (rs) {
          rs.delete(onResync);
          if (rs.size === 0) resyncListeners.delete(topic);
        }
      }
    },
  };
}
