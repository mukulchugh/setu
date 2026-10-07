import { createPortalSocket } from './socket-client';

export type { ConnectionState } from './socket-client';

let client: ReturnType<typeof createPortalSocket> | undefined;

// Looking up the client is inert; the first visible subscriber opens it.
export function getWs() {
  if (!client) {
    client = createPortalSocket({
      cancel: (timer) => clearTimeout(timer),
      now: () => performance.now(),
      onVisibility: (cb) => {
        document.addEventListener('visibilitychange', cb);
        window.addEventListener('pageshow', cb);
        return () => {
          document.removeEventListener('visibilitychange', cb);
          window.removeEventListener('pageshow', cb);
        };
      },
      openSocket: () =>
        new WebSocket(
          `${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/ws`
        ),
      readSnapshot: async () => {
        const response = await fetch('/api/worktrees?snapshot=1');
        if (!response.ok) {
          throw new Error('Worktree refresh failed');
        }
        const payload = await response.json();
        if (!(Array.isArray(payload) || Array.isArray(payload?.worktrees))) {
          throw new Error('Invalid worktree snapshot');
        }
        return payload;
      },
      schedule: (cb, ms) => setTimeout(cb, ms),
      visible: () => document.visibilityState !== 'hidden',
    });
  }
  return client;
}
