// Global worktree navigation; selection stays on the input for keyboard and touch.
import { useId, useLayoutEffect, useRef, useState } from 'preact/hooks';
import type { Worktree } from '../app';
import { StatusDot } from '../ui/badge';
import { Dialog, DialogClose, DialogContent } from '../ui/dialog';
import { commandSelection, worktreeState } from '../worktree-list';
import { tablerSearch } from './icons';

export function CommandBar({
  worktrees,
  onSelect,
  onClose,
  returnFocus,
}: {
  worktrees: Worktree[];
  onSelect: (w: Worktree) => void;
  onClose: () => void;
  returnFocus?: { current: HTMLElement | null };
}) {
  const [q, setQ] = useState('');
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const selectedNavigation = useRef(false);
  const listId = useId();
  const countId = useId();
  const { results, matchCount, selectedIndex, selected } = commandSelection(
    worktrees,
    q,
    selectedKey
  );
  const optionId = (w: Worktree) => `${listId}-${encodeURIComponent(w.key)}`;
  const activeId = selected ? optionId(selected) : undefined;
  useLayoutEffect(() => {
    if (activeId) {
      document.getElementById(activeId)?.scrollIntoView({ block: 'nearest' });
    }
  }, [activeId]);
  function go(w: Worktree) {
    selectedNavigation.current = true;
    onSelect(w);
    onClose();
  }
  function onKeyDown(e: KeyboardEvent) {
    if (e.isComposing) {
      return;
    }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (!results.length) {
        return;
      }
      const next = Math.max(
        0,
        Math.min(
          results.length - 1,
          selectedIndex + (e.key === 'ArrowDown' ? 1 : -1)
        )
      );
      setSelectedKey(results[next].key);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      e.stopPropagation();
      if (selected) {
        go(selected);
      }
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
        aria-label="Jump to a worktree"
        class="command-palette p-0 sm:max-w-md"
        finalFocus={() =>
          selectedNavigation.current
            ? false
            : returnFocus?.current?.isConnected
              ? returnFocus.current
              : (document.getElementById('jump-to-worktree') ?? true)
        }
        initialFocus={inputRef}
      >
        <div class="flex items-center gap-3 border-zinc-200 border-b px-4 py-3 dark:border-zinc-700">
          <svg
            aria-hidden="true"
            class="h-4 w-4 shrink-0 text-zinc-600 dark:text-zinc-300"
            fill="none"
            stroke="currentColor"
            stroke-linecap="round"
            stroke-linejoin="round"
            stroke-width="2"
            viewBox="0 0 24 24"
          >
            <path d={tablerSearch.path} />
          </svg>
          <input
            aria-activedescendant={activeId}
            aria-autocomplete="list"
            aria-controls={listId}
            aria-describedby={countId}
            aria-expanded="true"
            aria-label="Jump to a worktree"
            autoComplete="off"
            class="min-w-0 flex-1 bg-transparent text-sm text-zinc-900 placeholder-zinc-600 dark:text-zinc-100 dark:placeholder-zinc-400"
            onInput={(e) => {
              setQ(e.currentTarget.value);
              setSelectedKey(null);
            }}
            onKeyDown={onKeyDown}
            placeholder="Search all worktrees…"
            ref={inputRef}
            role="combobox"
            value={q}
          />
          <DialogClose
            aria-label="Close worktree search"
            class="shrink-0 px-2 py-2 text-xs text-zinc-700 dark:text-zinc-200"
          >
            Close
          </DialogClose>
        </div>
        <p
          aria-atomic="true"
          aria-live="polite"
          class="px-4 py-2 text-xs text-zinc-600 dark:text-zinc-300"
          id={countId}
          role="status"
        >
          {matchCount === 0
            ? 'No matching worktrees'
            : `${matchCount} matching worktree${matchCount === 1 ? '' : 's'}${matchCount > results.length ? `; showing first ${results.length}` : ''}`}
        </p>
        <div
          aria-label="Worktrees"
          class="command-results overflow-y-auto py-1"
          id={listId}
          role="listbox"
        >
          {results.map((w, i) => (
            <div
              aria-selected={i === selectedIndex}
              class={`command-option flex w-full cursor-pointer items-center gap-3 px-4 py-3 text-left ${i === selectedIndex ? 'bg-zinc-100 dark:bg-zinc-800' : ''}`}
              id={optionId(w)}
              key={w.key}
              onClick={() => go(w)}
              onKeyDown={(e) => {
                if (!e.isComposing && (e.key === 'Enter' || e.key === ' ')) {
                  e.preventDefault();
                  go(w);
                }
              }}
              onMouseDown={(e) => e.preventDefault()}
              onMouseEnter={() => setSelectedKey(w.key)}
              role="option"
              tabIndex={-1}
            >
              <span aria-hidden="true">
                <StatusDot
                  tone={
                    worktreeState(w) === 'running'
                      ? 'emerald'
                      : worktreeState(w) === 'stopped'
                        ? 'zinc'
                        : 'amber'
                  }
                />
              </span>
              <span class="min-w-0 flex-1 break-words text-sm text-zinc-900 dark:text-zinc-100">
                {w.name}
              </span>
              <span class="max-w-[35%] break-words text-xs text-zinc-600 dark:text-zinc-300">
                {w.label} · {worktreeState(w)}
              </span>
            </div>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  );
}
