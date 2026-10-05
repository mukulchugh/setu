import { useCallback, useEffect, useRef, useState } from 'preact/hooks';
import { createVisiblePoll } from './visible-poll';

export async function readJson<T>(
  url: string,
  signal: AbortSignal
): Promise<T> {
  const response = await fetch(url, { signal });
  if (!response.ok) {
    throw new Error('Read failed');
  }
  return response.json();
}

export async function readArray<T>(
  url: string,
  signal: AbortSignal
): Promise<T[]> {
  const value = await readJson<unknown>(url, signal);
  if (!Array.isArray(value)) {
    throw new Error('Expected a list');
  }
  return value;
}

export function useVisiblePoll<T>(
  key: string | null,
  intervalMs: number | null,
  read: (signal: AbortSignal) => Promise<T>,
  immediate = true
) {
  const reader = useRef(read);
  reader.current = read;
  const poll = useRef<ReturnType<typeof createVisiblePoll<T>> | null>(null);
  const [snapshot, setSnapshot] = useState<{
    key: string | null;
    data?: T;
    failed: boolean;
    checkedAt?: number;
  }>({ failed: false, key });
  useEffect(() => {
    setSnapshot({ failed: false, key });
    if (key === null) {
      return;
    }
    const current = createVisiblePoll<T>({
      accept: (data) =>
        setSnapshot({ checkedAt: Date.now(), data, failed: false, key }),
      cancel: (timer) => clearTimeout(timer),
      immediate,
      intervalMs,
      onVisibility(callback) {
        document.addEventListener('visibilitychange', callback);
        return () => document.removeEventListener('visibilitychange', callback);
      },
      read: (signal) => reader.current(signal),
      reject: () => setSnapshot((previous) => ({ ...previous, failed: true })),
      schedule: (callback, delay) => setTimeout(callback, delay),
      visible: () => document.visibilityState !== 'hidden',
    });
    poll.current = current;
    return () => {
      current.stop();
      if (poll.current === current) {
        poll.current = null;
      }
    };
  }, [key, intervalMs, immediate]);
  const refresh = useCallback(() => poll.current?.refresh(), []);
  return {
    ...(snapshot.key === key
      ? snapshot
      : { checkedAt: undefined, data: undefined, failed: false }),
    refresh,
  };
}
