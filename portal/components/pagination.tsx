// Shared page-number control. The main worktree list and the Archived view
// both slice a fetched-once array client-side (see PAGE_SIZE in app.tsx and
// archived-page.tsx), so they share this one control instead of each
// growing its own. Renders nothing at a single page, same as the inline
// block this was extracted from.
export function Pagination({
  page,
  pageCount,
  onPage,
}: {
  page: number;
  pageCount: number;
  onPage: (page: number) => void;
}) {
  if (pageCount <= 1) {
    return null;
  }
  return (
    <nav
      aria-label="Pagination"
      class="mt-6 flex flex-wrap items-center justify-center gap-3 text-sm text-zinc-600 dark:text-zinc-300"
    >
      <button
        aria-label="Previous page"
        class="flex h-8 w-8 items-center justify-center rounded-none border border-white/75 bg-white/60 shadow-sm backdrop-blur-md transition-colors duration-150 hover:text-zinc-800 disabled:opacity-40 dark:border-white/10 dark:bg-white/5 dark:hover:text-zinc-200"
        disabled={page === 0}
        onClick={() => onPage(Math.max(0, page - 1))}
        type="button"
      >
        ‹
      </button>
      <span>
        Page {page + 1} of {pageCount}
      </span>
      <button
        aria-label="Next page"
        class="flex h-8 w-8 items-center justify-center rounded-none border border-white/75 bg-white/60 shadow-sm backdrop-blur-md transition-colors duration-150 hover:text-zinc-800 disabled:opacity-40 dark:border-white/10 dark:bg-white/5 dark:hover:text-zinc-200"
        disabled={page >= pageCount - 1}
        onClick={() => onPage(Math.min(pageCount - 1, page + 1))}
        type="button"
      >
        ›
      </button>
    </nav>
  );
}
