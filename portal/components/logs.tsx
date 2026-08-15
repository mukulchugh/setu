// Log viewing: the modal (LogModal), the inline tail (LiveLog), and the
// shared polling hook both are built on (useLogPoll). RaycastSection also
// imports useLogPoll from here for its own log tail. LogModal/LiveLog
// themselves are built on useLogStream below instead, a WS-based sibling
// with the same return shape.
import { useState, useEffect, useRef } from 'preact/hooks';
import { Modal, CloseBtn, IconButton } from '../ui';
import { getWs } from '../ws';

export const LOG_TABS = ['dev', 'tunnel', 'inngest', 'trigger', 'convex', 'vercel', 'netlify', 'setup', 'pr-review'] as const;

// Shared by LogModal, LiveLog, and RaycastSection's log tail — each polled a
// log endpoint on an interval with the same fetch/scroll-pin/cleanup shape,
// hand-rolled independently. lines stays null until the first fetch resolves
// so callers can distinguish "still loading" from "loaded, genuinely empty".
// url === null skips polling entirely (RaycastSection only wants the log
// endpoint hit while the dev process is actually running).
export function useLogPoll(url: string | null, intervalMs: number): { lines: string[] | null; preRef: { current: HTMLPreElement | null } } {
  const [lines, setLines] = useState<string[] | null>(null);
  const preRef = useRef<HTMLPreElement>(null);

  useEffect(() => {
    if (!url) return;
    let alive = true;
    async function load() {
      const data = await fetch(url!).then(r => r.json()).catch(() => ({ lines: [] }));
      if (!alive) return;
      setLines(data.lines ?? []);
      requestAnimationFrame(() => { if (preRef.current) preRef.current.scrollTop = preRef.current.scrollHeight; });
    }
    load();
    const t = setInterval(load, intervalMs);
    return () => { alive = false; clearInterval(t); };
  }, [url, intervalMs]);

  return { lines, preRef };
}

// WS-based counterpart to useLogPoll above, for the two viewers that have a
// concrete repo/name/type to build a `logs:${repo}/${name}/${type}` topic
// from (RaycastSection's tail has none of those, so it stays on useLogPoll).
// Same return shape and the same scroll-pin-to-bottom behavior on new
// lines. Unlike the HTTP endpoint, the WS topic delivers incremental
// arrays of new lines rather than a full replace each time, so this
// accumulates instead of overwriting -- and resets that accumulator
// whenever repo/name/type changes, since switching topics mid-stream
// would otherwise mix lines from two different logs together. It also
// resets on a WS reconnect (portal restart, network blip): the server
// treats the re-sent {sub} as a brand new subscriber and replies with a
// full catch-up tail, which would otherwise get appended onto the
// already-shown lines and duplicate them.
export function useLogStream(repo: string, name: string, type: string): { lines: string[] | null; preRef: { current: HTMLPreElement | null } } {
  const [lines, setLines] = useState<string[] | null>(null);
  const preRef = useRef<HTMLPreElement>(null);

  useEffect(() => {
    setLines(null);
    const topic = `logs:${repo}/${name}/${type}`;
    const ws = getWs();
    const onMessage = (newLines: string[]) => {
      setLines(prev => (prev ?? []).concat(newLines));
      requestAnimationFrame(() => { if (preRef.current) preRef.current.scrollTop = preRef.current.scrollHeight; });
    };
    const onResync = () => setLines(null);
    ws.subscribe(topic, onMessage, onResync);
    return () => ws.unsubscribe(topic, onMessage, onResync);
  }, [repo, name, type]);

  return { lines, preRef };
}

// Custom sidecars (sidecars.json) are per-worktree, not a fixed known set
// like the rest of LOG_TABS -- extraTabs lets a caller that already knows
// this worktree's configured sidecar names (app.tsx has the worktrees list
// in state either way) fold them into the same tab strip, dynamically,
// instead of a sidecar log only being reachable via initialType with no way
// to switch to a different one or discover it existed at all.
export function LogModal({ repo, name, initialType, extraTabs, onClose }: { repo: string; name: string; initialType?: string; extraTabs?: string[]; onClose: () => void }) {
  const [type, setType] = useState(initialType ?? 'dev');
  const { lines, preRef } = useLogStream(repo, name, type);
  const text = lines === null ? 'Loading…' : lines.length ? lines.join('\n') : '(no log yet — start the dev server first)';
  const tabs = [...LOG_TABS, ...(extraTabs ?? []).map(n => `sidecar-${n}`)];

  return (
    <Modal onClose={onClose} position="bottom">
      <div class="bg-white/90 dark:bg-zinc-900/70 backdrop-blur-xl border-t border-zinc-200 dark:border-zinc-800 shadow-2xl w-full" style="height:60vh; display:flex; flex-direction:column;">
        <div class="flex items-center gap-3 px-5 py-3 border-b border-zinc-100 dark:border-zinc-800 shrink-0">
          <div class="flex gap-1 bg-zinc-100 dark:bg-zinc-800 rounded-none p-0.5 overflow-x-auto">
            {tabs.map(t => (
              <button key={t} onClick={() => setType(t)}
                class={`text-xs font-medium px-3 py-1 rounded-none transition-all duration-150 shrink-0 ${type === t ? 'bg-white dark:bg-zinc-700 text-zinc-900 dark:text-zinc-100 shadow-sm' : 'text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-300'}`}>
                {t === 'dev' ? 'Dev server' : t === 'pr-review' ? 'PR review' : t.startsWith('sidecar-') ? t.slice(8) : t[0].toUpperCase() + t.slice(1)}
              </button>
            ))}
          </div>
          <span class="text-xs text-zinc-400 flex-1">{repo}/{name} • {type}.log</span>
          <IconButton tip="Copy all" onClick={() => navigator.clipboard.writeText(text).catch(() => {})}>
            <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" viewBox="0 0 24 24"><path d="M7 9.667a2.667 2.667 0 0 1 2.667 -2.667h8.666a2.667 2.667 0 0 1 2.667 2.667v8.666a2.667 2.667 0 0 1 -2.667 2.667h-8.666a2.667 2.667 0 0 1 -2.667 -2.667l0 -8.666" /><path d="M4.012 16.737a2.005 2.005 0 0 1 -1.012 -1.737v-10c0 -1.1 .9 -2 2 -2h10c.75 0 1.158 .385 1.5 1" /></svg>
          </IconButton>
          <CloseBtn onClick={onClose} />
        </div>
        <pre ref={preRef} class="flex-1 overflow-auto text-[11px] leading-relaxed font-mono text-zinc-600 dark:text-zinc-400 bg-zinc-50/80 dark:bg-black/20 px-5 py-4 whitespace-pre-wrap break-all">{text}</pre>
      </div>
    </Modal>
  );
}

// Live-updating log tail — same polling fetch LogModal already does, without
// the modal chrome (this renders inline in a Section, not an overlay).
export function LiveLog({ repo, name, type }: { repo: string; name: string; type: string }) {
  const { lines, preRef } = useLogStream(repo, name, type);
  const text = lines === null ? 'Loading…' : lines.length ? lines.join('\n') : '(no log yet)';
  return <pre ref={preRef} class="max-h-64 overflow-auto text-[11px] leading-relaxed font-mono text-zinc-600 dark:text-zinc-400 whitespace-pre-wrap break-all">{text}</pre>;
}
