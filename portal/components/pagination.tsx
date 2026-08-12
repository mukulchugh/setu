// Shared page-number control. The main worktree list and the Archived view
// both slice a fetched-once array client-side (see PAGE_SIZE in app.tsx and
// archived-page.tsx), so they share this one control instead of each
// growing its own. Renders nothing at a single page, same as the inline
// block this was extracted from.
export function Pagination({ page, pageCount, onPage }: { page: number; pageCount: number; onPage: (page: number) => void }) {
  if (pageCount <= 1) return null;
  return (
    <div class="flex items-center justify-center gap-3 mt-6 text-sm text-zinc-500">
      <button onClick={() => onPage(Math.max(0, page - 1))} disabled={page === 0}
        class="w-8 h-8 flex items-center justify-center rounded-none backdrop-blur-md bg-white/60 dark:bg-white/5 border border-white/75 dark:border-white/10 shadow-sm disabled:opacity-40 transition-all duration-150 hover:text-zinc-800 dark:hover:text-zinc-200">‹</button>
      <span>{page + 1} / {pageCount}</span>
      <button onClick={() => onPage(Math.min(pageCount - 1, page + 1))} disabled={page >= pageCount - 1}
        class="w-8 h-8 flex items-center justify-center rounded-none backdrop-blur-md bg-white/60 dark:bg-white/5 border border-white/75 dark:border-white/10 shadow-sm disabled:opacity-40 transition-all duration-150 hover:text-zinc-800 dark:hover:text-zinc-200">›</button>
    </div>
  );
}
