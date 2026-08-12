// Jump-to-worktree, not a task runner — the one thing 45+ registered
// worktrees actually need is "find the one I'm thinking of" faster than
// scrolling three paginated grid pages. No fuzzy-match library: a plain
// substring filter over name/repo/branch/domain is enough at this scale and
// keeps this framework-agnostic (cmdk itself is a React library; this is
// Preact, so a ~40-line native implementation beats wiring a compat shim
// for one modal). onSelect is how a chosen worktree navigates — the router
// itself (navigate/parseRoute/useRoute) stays in app.tsx.
import { useState, useEffect, useRef } from 'preact/hooks';
import { Modal, StatusDot } from '../ui';
import type { Worktree } from '../app';

export function CommandBar({ worktrees, onSelect, onClose }: { worktrees: Worktree[]; onSelect: (w: Worktree) => void; onClose: () => void }) {
  const [q, setQ] = useState('');
  const [sel, setSel] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => { inputRef.current?.focus(); }, []);

  const needle = q.trim().toLowerCase();
  const results = (needle
    ? worktrees.filter(w => `${w.name} ${w.repo} ${w.label} ${w.domain}`.toLowerCase().includes(needle))
    : worktrees
  ).slice(0, 8);

  function go(w: Worktree) {
    onSelect(w);
    onClose();
  }

  function onKeyDown(e: any) {
    if (e.key === 'Escape') onClose();
    else if (e.key === 'ArrowDown') { e.preventDefault(); setSel(s => Math.min(s + 1, results.length - 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setSel(s => Math.max(s - 1, 0)); }
    else if (e.key === 'Enter' && results[sel]) go(results[sel]);
  }

  return (
    <Modal onClose={onClose}>
      <div class="bg-white dark:bg-zinc-900 rounded-none border border-zinc-200 dark:border-zinc-800 shadow-2xl w-full max-w-md mx-4" onKeyDown={onKeyDown}>
        <div class="flex items-center gap-2.5 px-4 py-3 border-b border-zinc-100 dark:border-zinc-800">
          <svg class="w-4 h-4 text-zinc-300 shrink-0" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" viewBox="0 0 24 24"><path d="M3 10a7 7 0 1 0 14 0a7 7 0 1 0 -14 0" /><path d="M21 21l-6 -6" /></svg>
          <input ref={inputRef} value={q} onInput={(e: any) => { setQ(e.target.value); setSel(0); }}
            placeholder="Jump to a worktree…" autocomplete="off"
            class="flex-1 text-sm bg-transparent outline-none placeholder-zinc-400 text-zinc-900 dark:text-zinc-100" />
          <span class="board-mono text-[10px] text-zinc-300 shrink-0">ESC</span>
        </div>
        <div class="max-h-80 overflow-auto py-1">
          {!results.length && <p class="text-xs text-zinc-400 px-4 py-6 text-center">No worktrees match "{q}"</p>}
          {results.map((w, i) => (
            <button key={w.key} onClick={() => go(w)} onMouseEnter={() => setSel(i)}
              class={`w-full flex items-center gap-2.5 px-4 py-2 text-left transition-colors duration-100 ${i === sel ? 'bg-zinc-100 dark:bg-zinc-800' : ''}`}>
              <StatusDot tone={w.active ? 'emerald' : w.queued ? 'amber' : 'zinc'} />
              <span class="text-sm text-zinc-900 dark:text-zinc-100 truncate">{w.name}</span>
              <span class="board-mono text-[9px] text-zinc-300 font-bold shrink-0 ml-auto">{w.label}</span>
            </button>
          ))}
        </div>
      </div>
    </Modal>
  );
}
