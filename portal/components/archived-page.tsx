// Archived worktrees: a history/audit view, not an undelete feature. The
// worktree directory and any uncommitted state are genuinely gone by the
// time a record lands here; Recreate only re-runs the normal create flow
// for the same repo+branch, it does not bring back files. Self-contained
// like ports-page.tsx/help-page.tsx: owns its own fetch, only needs
// back-navigation and a recreate callback from the caller (the router
// itself stays in app.tsx).
import { useState } from 'preact/hooks';
import type { ArchivedWorktree } from '../app';
import { inputCls, PageHeader } from '../ui';
import { Badge } from '../ui/badge';
import { Button } from '../ui/button';
import { readArray, useVisiblePoll } from '../use-visible-poll';
import { Pagination } from './pagination';
import { relativeTime } from './relative-time';

// Same client-side pagination convention as the main worktree list
// (PAGE_SIZE in app.tsx): the API returns the full list, this component
// slices it into pages, not the server.
const PAGE_SIZE = 18;

export function ArchivedPage({
  onBack,
  onRecreate,
}: {
  onBack: () => void;
  onRecreate: (a: ArchivedWorktree) => void;
}) {
  const { data, failed, refresh } = useVisiblePoll(
    'archived-worktrees',
    null,
    (signal) => readArray<ArchivedWorktree>('/api/worktrees/archived', signal)
  );
  const items = data ?? [],
    loaded = data !== undefined;
  const [page, setPage] = useState(0);
  const [search, setSearch] = useState('');
  const [reason, setReason] = useState('all');
  const matches = items.filter(
    (item) =>
      (reason === 'all' || item.reason === reason) &&
      `${item.name} ${item.repo} ${item.branch} ${item.label}`
        .toLowerCase()
        .includes(search.trim().toLowerCase())
  );

  const pageCount = Math.max(1, Math.ceil(matches.length / PAGE_SIZE));
  const currentPage = Math.min(page, pageCount - 1);
  const filtered = matches.slice(
    currentPage * PAGE_SIZE,
    (currentPage + 1) * PAGE_SIZE
  );

  return (
    <div class="portal-page mx-auto max-w-4xl px-4 py-6 sm:px-6">
      <PageHeader
        actions={
          <Button compact onClick={refresh} variant="secondary">
            Refresh archive
          </Button>
        }
        back={{ label: 'All worktrees', onClick: onBack }}
        subtitle={
          <span class="block max-w-xl text-sm text-zinc-600 dark:text-zinc-300">
            Removed worktrees and their retained branches. Recreate opens a new
            checkout; it does not restore deleted files or uncommitted work.
          </span>
        }
        title="Archive"
      />

      <div class="page-toolbar">
        <label htmlFor="archive-search">
          Search archive
          <input
            class={inputCls}
            id="archive-search"
            onInput={(e) => {
              setSearch(e.currentTarget.value);
              setPage(0);
            }}
            placeholder="Branch, project or label…"
            value={search}
          />
        </label>
        <label htmlFor="archive-reason">
          Removal reason
          <select
            class={inputCls}
            id="archive-reason"
            onChange={(e) => {
              setReason(e.currentTarget.value);
              setPage(0);
            }}
            value={reason}
          >
            <option value="all">All reasons</option>
            {[...new Set(items.map((item) => item.reason))].map((value) => (
              <option key={value} value={value}>
                {value}
              </option>
            ))}
          </select>
        </label>
      </div>
      {loaded && (
        <p class="mb-3 text-sm text-zinc-600 dark:text-zinc-300">
          {matches.length} of {items.length} archived worktrees
        </p>
      )}
      {failed && (
        <p class="mb-3 text-signal-red text-sm" role="status">
          Could not load archived worktrees.{' '}
          {loaded ? 'Showing the last successful read. ' : ''}
          <button class="underline" onClick={refresh} type="button">
            Retry
          </button>
        </p>
      )}
      <div class="overflow-hidden rounded-none border border-white/75 bg-white/70 text-sm shadow-sm backdrop-blur-md dark:border-white/10 dark:bg-white/5">
        {loaded ? (
          matches.length ? (
            filtered.map((a, i) => (
              <div
                class="flex flex-wrap items-center gap-4 border-zinc-100 border-b px-4 py-3 transition-colors duration-150 last:border-0 hover:bg-white/50 dark:border-white/5 dark:hover:bg-white/5"
                key={`${a.repo}/${a.name}/${a.removedAt}/${i}`}
              >
                <div class="min-w-0 flex-1">
                  <div class="flex min-w-0 flex-wrap items-baseline gap-2">
                    <span class="break-words font-medium text-zinc-900 dark:text-zinc-100">
                      {a.name}
                    </span>
                    <span class="board-mono shrink-0 font-bold text-[10px] text-zinc-300">
                      {a.label}
                    </span>
                    <Badge tone={a.reason === 'merged' ? 'emerald' : 'zinc'}>
                      {a.reason}
                    </Badge>
                  </div>
                  <div class="mt-0.5 flex min-w-0 flex-wrap items-center gap-3 text-xs text-zinc-400">
                    <span class="break-all font-mono">
                      {a.repo}/{a.branch}
                    </span>
                    <span class="shrink-0">
                      Removed {relativeTime(a.removedAt)}
                    </span>
                    {a.prUrl && (
                      <a
                        class="shrink-0 transition-colors duration-150 hover:text-accent"
                        href={a.prUrl}
                        rel="noopener"
                        target="_blank"
                      >
                        View PR
                      </a>
                    )}
                  </div>
                </div>
                <Button
                  compact
                  onClick={() => onRecreate(a)}
                  variant="secondary"
                >
                  Recreate
                </Button>
              </div>
            ))
          ) : (
            <p class="px-4 py-6 text-center text-zinc-400">
              {items.length
                ? 'No archived worktrees match these filters.'
                : 'No archived worktrees yet. Removed worktrees will appear here.'}
            </p>
          )
        ) : (
          !failed && <p class="px-4 py-6 text-center text-zinc-400">Loading…</p>
        )}
      </div>

      <Pagination onPage={setPage} page={currentPage} pageCount={pageCount} />
    </div>
  );
}
