// Archived worktrees: a history/audit view, not an undelete feature. The
// worktree directory and any uncommitted state are genuinely gone by the
// time a record lands here; Recreate only re-runs the normal create flow
// for the same repo+branch, it does not bring back files. Self-contained
// like ports-page.tsx/help-page.tsx: owns its own fetch, only needs
// back-navigation and a recreate callback from the caller (the router
// itself stays in app.tsx).
import { useState, useEffect, useCallback } from 'preact/hooks';
import { PageHeader } from '../ui';
import { Badge } from '../ui/badge';
import { Button } from '../ui/button';
import { relativeTime } from './relative-time';
import { Pagination } from './pagination';
import type { ArchivedWorktree } from '../app';

// Same client-side pagination convention as the main worktree list
// (PAGE_SIZE in app.tsx): the API returns the full list, this component
// slices it into pages, not the server.
const PAGE_SIZE = 18;

export function ArchivedPage({ onBack, onRecreate }: { onBack: () => void; onRecreate: (a: ArchivedWorktree) => void }) {
  const [items, setItems] = useState<ArchivedWorktree[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [page, setPage] = useState(0);

  const load = useCallback(async () => {
    setItems(await fetch('/api/worktrees/archived').then(r => r.json()).catch(() => []));
    setLoaded(true);
  }, []);

  useEffect(() => { load(); }, [load]);

  const pageCount = Math.max(1, Math.ceil(items.length / PAGE_SIZE));
  const filtered = items.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);

  return (
    <div class="max-w-3xl mx-auto px-6 py-12">
      <PageHeader back={{ label: 'All worktrees', onClick: onBack }} title="Archived"
        subtitle={
          <span class="text-xs text-zinc-400 max-w-xl block">
            A record of worktrees that were removed, when and why. The worktree directory itself is gone by the time it shows up here; this is history, not an undo. Recreate starts a fresh worktree for the same repo and branch, it does not restore the original files or uncommitted work.
          </span>
        } />

      <div class="backdrop-blur-md bg-white/70 dark:bg-white/5 border border-white/75 dark:border-white/10 shadow-sm rounded-none overflow-hidden text-sm">
        {!loaded
          ? <p class="text-zinc-400 px-4 py-6 text-center">Loading…</p>
          : !items.length
          ? <p class="text-zinc-400 px-4 py-6 text-center">No archived worktrees yet</p>
          : filtered.map((a, i) => (
            <div key={`${a.repo}/${a.name}/${a.removedAt}/${i}`}
              class="flex items-center gap-4 px-4 py-3 border-b border-zinc-100 dark:border-white/5 last:border-0 hover:bg-white/50 dark:hover:bg-white/5 transition-colors duration-150">
              <div class="min-w-0 flex-1">
                <div class="flex items-baseline gap-2 min-w-0 flex-wrap">
                  <span class="text-zinc-900 dark:text-zinc-100 font-medium truncate">{a.name}</span>
                  <span class="board-mono text-[10px] text-zinc-300 font-bold shrink-0">{a.label}</span>
                  <Badge tone={a.reason === 'merged' ? 'emerald' : 'zinc'}>{a.reason}</Badge>
                </div>
                <div class="flex items-center gap-3 text-xs text-zinc-400 min-w-0 flex-wrap mt-0.5">
                  <span class="font-mono truncate">{a.repo}/{a.branch}</span>
                  <span class="shrink-0">Removed {relativeTime(a.removedAt)}</span>
                  {a.prUrl && (
                    <a href={a.prUrl} target="_blank" class="shrink-0 hover:text-accent transition-colors duration-150">
                      View PR
                    </a>
                  )}
                </div>
              </div>
              <Button variant="secondary" compact onClick={() => onRecreate(a)}>Recreate</Button>
            </div>
          ))}
      </div>

      <Pagination page={page} pageCount={pageCount} onPage={setPage} />
    </div>
  );
}
