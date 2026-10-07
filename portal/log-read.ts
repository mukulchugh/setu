export interface LogSnapshot {
  lines?: string[];
  observedAt?: number;
  retained?: boolean;
  state?: 'ready' | 'empty' | 'missing' | 'read-error';
  successfulAt?: number;
}
export interface LogRead {
  lines: string[] | null;
  state: 'loading' | 'ready' | 'empty' | 'missing' | 'read-error';
  successfulAt?: number;
}
export const initialLogRead: LogRead = { lines: null, state: 'loading' };

export function acceptLogSnapshot(
  previous: LogRead,
  snapshot: LogSnapshot,
  now: number
): LogRead {
  if (snapshot.state === 'read-error') {
    if (snapshot.successfulAt !== undefined && Array.isArray(snapshot.lines)) {
      return {
        lines: snapshot.lines,
        state: 'read-error',
        successfulAt: snapshot.successfulAt,
      };
    }
    return { ...previous, state: 'read-error' };
  }
  if (!Array.isArray(snapshot.lines)) {
    return { ...previous, state: 'read-error' };
  }
  return {
    lines: snapshot.lines,
    state: snapshot.state ?? (snapshot.lines.length ? 'ready' : 'empty'),
    successfulAt: snapshot.successfulAt ?? snapshot.observedAt ?? now,
  };
}

// The server sends a bounded tail, so every new snapshot drops lines from the
// top. While the reader is paused, keep the displayed text still and hold only
// the latest snapshot until following resumes.
export function createLogFollow(io: {
  apply: (snapshot: LogSnapshot) => void;
  holding: (held: boolean) => void;
  following: (enabled: boolean) => void;
}) {
  let enabled = true;
  let held: LogSnapshot | null = null;
  function hold(next: LogSnapshot | null) {
    if ((held === null) !== (next === null)) {
      io.holding(next !== null);
    }
    held = next;
  }
  return {
    accept(snapshot: LogSnapshot) {
      if (enabled) {
        io.apply(snapshot);
      } else {
        hold(snapshot);
      }
    },
    follow(next: boolean) {
      if (next === enabled) {
        return;
      }
      enabled = next;
      io.following(next);
      if (next && held) {
        const snapshot = held;
        hold(null);
        io.apply(snapshot);
      }
    },
    get following() {
      return enabled;
    },
    // A different log source must never show the previous source's held tail.
    reset() {
      hold(null);
      if (!enabled) {
        enabled = true;
        io.following(true);
      }
    },
  };
}
