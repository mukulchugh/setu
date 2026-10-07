// "3h ago" style. Shared by app.tsx (lastCommitAt/createdAt, unix-seconds
// from repoGitMeta in portal.js) and the Archived view (removedAt, same
// unix-seconds convention). Split out here rather than defined in app.tsx so
// a components/ file can import it without a circular value-import back into
// app.tsx (app.tsx already imports components/ files, not the reverse).
import { useEffect, useState } from 'preact/hooks';

export function relativeTime(unixSeconds: number | null): string {
  if (!unixSeconds) {
    return '';
  }
  const s = Date.now() / 1000 - unixSeconds;
  if (s < 60) {
    return 'just now';
  }
  if (s < 3600) {
    return `${Math.floor(s / 60)}m ago`;
  }
  if (s < 86_400) {
    return `${Math.floor(s / 3600)}h ago`;
  }
  if (s < 2_592_000) {
    return `${Math.floor(s / 86_400)}d ago`;
  }
  return `${Math.floor(s / 2_592_000)}mo ago`;
}

// Memoized worktree cards skip unchanged snapshots, so ages need their own
// clock. One shared interval re-renders only these text nodes.
const clockSubscribers = new Set<() => void>();
let clockTimer: ReturnType<typeof setInterval> | null = null;

export function RelativeTime({ value }: { value: number | null }) {
  const [, setTick] = useState(0);
  useEffect(() => {
    const tick = () => setTick((n) => n + 1);
    clockSubscribers.add(tick);
    clockTimer ??= setInterval(() => {
      for (const subscriber of clockSubscribers) {
        subscriber();
      }
    }, 60_000);
    return () => {
      clockSubscribers.delete(tick);
      if (!clockSubscribers.size && clockTimer !== null) {
        clearInterval(clockTimer);
        clockTimer = null;
      }
    };
  }, []);
  return <>{relativeTime(value)}</>;
}
