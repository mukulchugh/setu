// Socket viewers and Raycast's HTTP tail share the same error/empty model.
import { useCallback, useEffect, useRef, useState } from 'preact/hooks';
import {
  acceptLogSnapshot,
  createLogFollow,
  initialLogRead,
  type LogRead,
  type LogSnapshot,
} from '../log-read';
import { Button, IconButton } from '../ui/button';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogTitle,
  dialogReturnTarget,
} from '../ui/dialog';
import { readJson, useVisiblePoll } from '../use-visible-poll';
import { getWs } from '../ws';
import { tablerCopy } from './icons';
import { stripAnsiSgr } from '../ui-helpers';

export const LOG_TABS = [
  'dev',
  'tunnel',
  'inngest',
  'trigger',
  'convex',
  'vercel',
  'netlify',
  'setup',
  'pr-review',
] as const;

function useLogBuffer(key: string | null) {
  const [read, setRead] = useState<LogRead>(initialLogRead);
  const [following, setFollowing] = useState(true);
  const [holding, setHolding] = useState(false);
  const preRef = useRef<HTMLElement>(null);
  const frame = useRef<number | null>(null);
  const followingNow = useRef(true);
  const toBottom = useCallback(() => {
    if (frame.current !== null) {
      cancelAnimationFrame(frame.current);
    }
    frame.current = requestAnimationFrame(() => {
      frame.current = null;
      if (followingNow.current && preRef.current) {
        preRef.current.scrollTop = preRef.current.scrollHeight;
      }
    });
  }, []);
  const [control] = useState(() =>
    createLogFollow({
      apply: (snapshot) => {
        setRead((previous) =>
          acceptLogSnapshot(previous, snapshot, Date.now())
        );
        toBottom();
      },
      following: (enabled) => {
        followingNow.current = enabled;
        setFollowing(enabled);
      },
      holding: setHolding,
    })
  );
  const setFollow = useCallback(
    (enabled: boolean) => {
      control.follow(enabled);
      if (enabled) {
        toBottom();
      }
    },
    [control, toBottom]
  );
  const onScroll = useCallback(() => {
    const pre = preRef.current;
    const atTail =
      !!pre && pre.scrollHeight - pre.scrollTop - pre.clientHeight < 32;
    if (pre && atTail !== control.following) {
      setFollow(atTail);
    }
  }, [control, setFollow]);
  const accept = useCallback(
    (snapshot: LogSnapshot) => control.accept(snapshot),
    [control]
  );
  useEffect(() => {
    control.reset();
    setRead(initialLogRead);
    return () => {
      if (frame.current !== null) {
        cancelAnimationFrame(frame.current);
      }
    };
  }, [key]);
  return {
    ...read,
    accept,
    following,
    holding,
    onScroll,
    preRef,
    setFollow,
  };
}

// Paused readers need to know the text is intentionally still.
function FollowNotice({ holding }: { holding: boolean }) {
  return (
    <p class="py-2 text-xs text-zinc-600 dark:text-zinc-300" role="status">
      Following paused. Reading position is preserved.
      {holding && ' Newer output is held until you follow again.'}
    </p>
  );
}

export function useLogPoll(url: string | null, intervalMs: number) {
  const buffer = useLogBuffer(url);
  const { data, failed, refresh } = useVisiblePoll(url, intervalMs, (signal) =>
    readJson<LogSnapshot>(url!, signal)
  );
  useEffect(() => {
    if (data) {
      buffer.accept(data);
    }
  }, [data]);
  useEffect(() => {
    if (failed) {
      buffer.accept({ state: 'read-error' });
    }
  }, [failed]);
  return { ...buffer, retry: refresh };
}

// Reconnect keeps the last successful tail readable until a replacement arrives.
export function useLogStream(repo: string, name: string, type: string) {
  const topic = `logs:${repo}/${name}/${type}`;
  const buffer = useLogBuffer(topic);
  useEffect(() => {
    const ws = getWs();
    const onMessage = (snapshot: LogSnapshot) => buffer.accept(snapshot);
    ws.subscribe(topic, onMessage);
    return () => ws.unsubscribe(topic, onMessage);
  }, [topic]);
  return { ...buffer, retry: () => getWs().refresh() };
}

export function LogReadStatus({
  read,
}: {
  read: LogRead & { retry: () => void };
}) {
  if (read.state === 'ready') {
    return null;
  }
  const text =
    read.state === 'read-error'
      ? `Could not read this log.${read.successfulAt === undefined ? '' : ` Showing the last successful read at ${new Date(read.successfulAt).toLocaleTimeString()}.`}`
      : read.state === 'loading'
        ? 'Loading log…'
        : read.state === 'missing'
          ? 'No log file yet. Run the matching service or action to create one.'
          : 'The log is empty.';
  return (
    <p
      class={`px-1 py-2 text-xs ${read.state === 'read-error' ? 'text-red-700 dark:text-red-300' : 'text-zinc-600 dark:text-zinc-300'}`}
      role="status"
    >
      {text}{' '}
      {read.state === 'read-error' && (
        <button class="underline" onClick={read.retry} type="button">
          Retry
        </button>
      )}
    </p>
  );
}

// Custom sidecars (sidecars.json) are per-worktree, not a fixed known set
// like the rest of LOG_TABS -- extraTabs lets a caller that already knows
// this worktree's configured sidecar names (app.tsx has the worktrees list
// in state either way) fold them into the same tab strip, dynamically,
// instead of a sidecar log only being reachable via initialType with no way
// to switch to a different one or discover it existed at all.
export function LogModal({
  repo,
  name,
  initialType,
  extraTabs,
  onClose,
  returnFocus,
}: {
  repo: string;
  name: string;
  initialType?: string;
  extraTabs?: string[];
  onClose: () => void;
  returnFocus?: HTMLElement | null;
}) {
  const [type, setType] = useState(initialType ?? 'dev');
  const [copyStatus, setCopyStatus] = useState('');
  const read = useLogStream(repo, name, type);
  const { lines, preRef } = read;
  const text = stripAnsiSgr(lines?.join('\n') ?? '');
  const tabs = [
    ...new Set([
      ...LOG_TABS,
      ...(extraTabs ?? []).map((n) => `sidecar-${n}`),
      type,
    ]),
  ];
  async function copyLog() {
    try {
      await navigator.clipboard.writeText(text);
      setCopyStatus('Copied the displayed log tail.');
    } catch {
      setCopyStatus(
        'Could not copy. Select the log text and copy it manually.'
      );
    }
  }

  return (
    <Dialog
      onOpenChange={(open: boolean) => {
        if (!open) {
          onClose();
        }
      }}
      open
    >
      <DialogContent
        class="flex h-[min(75dvh,48rem)] max-h-[calc(100dvh-1rem)] flex-col"
        finalFocus={
          returnFocus
            ? () => dialogReturnTarget(returnFocus, document.body)
            : undefined
        }
        position="bottom"
      >
        <DialogTitle class="sr-only">
          Logs for {repo}/{name}
        </DialogTitle>
        <div class="flex shrink-0 flex-wrap items-center gap-3 border-zinc-100 border-b px-5 py-3 dark:border-zinc-800">
          <fieldset class="flex min-w-0 max-w-full gap-1 overflow-x-auto rounded-none bg-zinc-100 p-0.5 dark:bg-zinc-800">
            <legend class="sr-only">Log source</legend>
            {tabs.map((t) => (
              <button
                aria-pressed={type === t}
                class={`shrink-0 rounded-none px-3 py-1 font-medium text-xs transition-colors duration-150 ${type === t ? 'bg-white text-zinc-900 shadow-sm dark:bg-zinc-700 dark:text-zinc-100' : 'text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-300'}`}
                key={t}
                onClick={() => {
                  setType(t);
                  setCopyStatus('');
                }}
                type="button"
              >
                {t === 'dev'
                  ? 'Dev server'
                  : t === 'pr-review'
                    ? 'PR review'
                    : t.startsWith('sidecar-')
                      ? t.slice(8)
                      : t[0].toUpperCase() + t.slice(1)}
              </button>
            ))}
          </fieldset>
          <span class="min-w-0 flex-1 truncate text-xs text-zinc-400">
            {repo}/{name} • {type}.log • recent tail
          </span>
          <Button
            aria-pressed={read.following}
            compact
            onClick={() => read.setFollow(!read.following)}
            variant="secondary"
          >
            Follow new lines
          </Button>
          <IconButton
            disabled={!text}
            onClick={copyLog}
            tip="Copy displayed log tail"
          >
            <svg
              aria-hidden="true"
              class="h-3.5 w-3.5"
              fill="none"
              stroke="currentColor"
              stroke-linecap="round"
              stroke-linejoin="round"
              stroke-width="2"
              viewBox="0 0 24 24"
            >
              <path d={tablerCopy.path} />
            </svg>
          </IconButton>
          <DialogClose
            aria-label="Close logs"
            class="flex h-7 w-7 items-center justify-center rounded-lg text-zinc-400 transition-colors duration-200 hover:bg-zinc-100 hover:text-zinc-600"
          >
            <svg
              aria-hidden="true"
              class="h-4 w-4"
              fill="none"
              stroke="currentColor"
              stroke-linecap="round"
              stroke-linejoin="round"
              stroke-width="2"
              viewBox="0 0 24 24"
            >
              <path d="M18 6l-12 12" />
              <path d="M6 6l12 12" />
            </svg>
          </DialogClose>
        </div>
        <div class="px-5">
          <LogReadStatus read={read} />
          {copyStatus && (
            <p class="py-2 text-sm" role="status">
              {copyStatus}
            </p>
          )}
          {!read.following && <FollowNotice holding={read.holding} />}
        </div>
        <section
          aria-label={`${type} log output`}
          class="log-viewer flex-1 overflow-auto whitespace-pre-wrap break-all bg-zinc-950 px-5 py-4 font-mono text-xs text-zinc-200 leading-relaxed"
          onScroll={read.onScroll}
          ref={preRef}
          // biome-ignore lint/a11y/noNoninteractiveTabindex: The scrollable log region needs keyboard scrolling inside the dialog.
          tabIndex={0}
        >
          <pre class="m-0 whitespace-pre-wrap break-all font-mono">
            {text}
          </pre>
        </section>
      </DialogContent>
    </Dialog>
  );
}

// Live-updating log tail — same polling fetch LogModal already does, without
// the modal chrome (this renders inline in a Section, not an overlay).
export function LiveLog({
  repo,
  name,
  type,
}: {
  repo: string;
  name: string;
  type: string;
}) {
  const read = useLogStream(repo, name, type);
  const { lines, preRef } = read;
  const text = stripAnsiSgr(lines?.join('\n') ?? '');
  return (
    <>
      <div class="mb-2 flex flex-wrap items-center justify-between gap-2">
        <LogReadStatus read={read} />
        {!read.following && <FollowNotice holding={read.holding} />}
        <Button
          aria-pressed={read.following}
          compact
          onClick={() => read.setFollow(!read.following)}
          variant="secondary"
        >
          Follow new lines
        </Button>
      </div>
      <section
        aria-label={`${type} log output`}
        class="log-viewer max-h-64 overflow-auto whitespace-pre-wrap break-all font-mono text-[11px] text-zinc-600 leading-relaxed dark:text-zinc-400"
        onScroll={read.onScroll}
        ref={preRef}
        // biome-ignore lint/a11y/noNoninteractiveTabindex: Keyboard users must be able to scroll and read the bounded log region.
        tabIndex={0}
      >
        <pre class="m-0 whitespace-pre-wrap break-all font-mono">{text}</pre>
      </section>
    </>
  );
}
