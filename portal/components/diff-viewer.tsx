// Per-worktree diff review. Fetches GET /api/diff on mount (see portal.js's
// computeDiff/parseUnifiedDiff for the backend half) and renders it. Manual
// refresh and visibility resume, no interval poll: unlike LiveLog above, this isn't a stream
// to watch, it's a "let me look at what changed" snapshot.
import { useEffect, useId, useState } from 'preact/hooks';
import { Badge } from '../ui/badge';
import { IconButton } from '../ui/button';
import { readJson, useVisiblePoll } from '../use-visible-poll';
import { tablerChevronRight, tablerRefresh } from './icons';

interface DiffLine {
  content: string;
  newLine?: number;
  oldLine?: number;
  type: 'add' | 'remove' | 'context';
}
interface DiffHunk {
  header: string;
  lines: DiffLine[];
}
interface DiffFile {
  additions: number;
  binary?: boolean;
  deletions: number;
  file: string;
  hunks: DiffHunk[];
  tooLarge?: boolean;
}
interface DiffGroup {
  additions: number;
  deletions: number;
  files: DiffFile[];
  totalFiles: number;
  truncatedFileCount: number;
}
interface DiffResponse {
  base: string;
  baseResolved: boolean;
  committed: DiffGroup;
  error?: string;
  uncommitted: DiffGroup & { untracked?: string[] };
}

// Same refresh glyph DeployMenu/the sync-with-staging action already draw
// elsewhere in app.tsx: one icon meaning "reload this," not a second one.
function RefreshIcon({ spinning }: { spinning: boolean }) {
  return (
    <svg
      aria-hidden="true"
      class={`h-4 w-4 ${spinning ? 'spin' : ''}`}
      fill="none"
      stroke="currentColor"
      stroke-linecap="round"
      stroke-linejoin="round"
      stroke-width="2.5"
      viewBox="0 0 24 24"
    >
      <path d={tablerRefresh.path} />
    </svg>
  );
}

function Chevron({ open }: { open: boolean }) {
  return (
    <svg
      aria-hidden="true"
      class={`h-3 w-3 shrink-0 text-zinc-400 transition-transform duration-150 ${open ? 'rotate-90' : ''}`}
      fill="none"
      stroke="currentColor"
      stroke-linecap="round"
      stroke-linejoin="round"
      stroke-width="2.5"
      viewBox="0 0 24 24"
    >
      <path d={tablerChevronRight.path} />
    </svg>
  );
}

const LINE_BG: Record<DiffLine['type'], string> = {
  add: 'bg-signal-green/10 dark:bg-signal-green/15 text-signal-green',
  context: 'text-zinc-600 dark:text-zinc-400',
  remove: 'bg-signal-red/10 dark:bg-signal-red/15 text-signal-red',
};
const LINE_PREFIX: Record<DiffLine['type'], string> = {
  add: '+',
  context: ' ',
  remove: '-',
};

function HunkBlock({ hunk }: { hunk: DiffHunk }) {
  return (
    <div>
      {/* Quieter separator row, not a full line. Code-shaped content (often
          includes a function name), so this stays font-mono rather than the
          uppercase board-mono treatment used for pure UI labels. */}
      <div class="border-zinc-100 border-y bg-zinc-50 px-3 py-1 font-mono text-[10px] text-zinc-400 tracking-wide dark:border-zinc-800 dark:bg-zinc-800/40 dark:text-zinc-500">
        {hunk.header}
      </div>
      <div class="overflow-x-auto">
        {hunk.lines.map((l, i) => (
          <div
            class={`flex font-mono text-[11px] leading-[1.5] ${LINE_BG[l.type]}`}
            key={i}
          >
            <span class="w-9 shrink-0 select-none pr-1.5 text-right text-zinc-300 dark:text-zinc-600">
              {l.oldLine ?? ''}
            </span>
            <span class="w-9 shrink-0 select-none pr-2 text-right text-zinc-300 dark:text-zinc-600">
              {l.newLine ?? ''}
            </span>
            <span class="w-3 shrink-0 select-none text-center opacity-60">
              {LINE_PREFIX[l.type]}
            </span>
            <span class="flex-1 whitespace-pre pr-3">{l.content}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

// >2 files collapses by default (a reviewer opening a 20-file diff wants an
// index first, not everything unrolled); 1-2 files is the whole point of
// opening this view, so they start open.
const AUTO_EXPAND_MAX_FILES = 2;

function FileRow({
  f,
  expanded,
  onToggle,
}: {
  f: DiffFile;
  expanded: boolean;
  onToggle: () => void;
}) {
  const collapsible = !(f.binary || f.tooLarge) && f.hunks.length > 0;
  const panelId = useId();
  return (
    <div class="border-zinc-100 border-b last:border-0 dark:border-zinc-800">
      <button
        aria-controls={collapsible ? panelId : undefined}
        aria-expanded={collapsible ? expanded : undefined}
        class={`flex w-full flex-wrap items-center gap-2 px-3 py-2 text-left text-xs ${collapsible ? 'cursor-pointer hover:bg-zinc-50 dark:hover:bg-zinc-800/40' : ''}`}
        disabled={!collapsible}
        onClick={collapsible ? onToggle : undefined}
        type="button"
      >
        {collapsible ? (
          <Chevron open={expanded} />
        ) : (
          <span class="w-3 shrink-0" />
        )}
        <span class="min-w-0 flex-1 break-words font-mono text-zinc-700 dark:text-zinc-300">
          {f.file}
        </span>
        {f.binary ? (
          <Badge tone="zinc">binary</Badge>
        ) : f.tooLarge ? (
          <Badge tip="Hunk content skipped past the size guard" tone="amber">
            {f.additions + f.deletions} lines
          </Badge>
        ) : (
          <>
            <Badge tone="emerald">+{f.additions}</Badge>
            <Badge tone="red">-{f.deletions}</Badge>
          </>
        )}
      </button>
      {f.binary && (
        <div class="-mt-1 px-3 pb-2 text-xs text-zinc-400">
          binary file changed
        </div>
      )}
      {f.tooLarge && (
        <div class="-mt-1 px-3 pb-2 text-xs text-zinc-400">
          too large to display, {f.additions + f.deletions} lines changed
        </div>
      )}
      {collapsible && (
        <div hidden={!expanded} id={panelId}>
          {expanded && f.hunks.map((h, i) => <HunkBlock hunk={h} key={i} />)}
        </div>
      )}
    </div>
  );
}

function DiffGroupSection({
  label,
  group,
  emptyText,
  warning,
  footnote,
  groupKey,
  expanded,
  onToggleFile,
  open,
  onToggleOpen,
}: {
  label: string;
  group: DiffGroup;
  emptyText: string;
  warning?: string;
  footnote?: string;
  groupKey: string;
  expanded: Record<string, boolean>;
  onToggleFile: (key: string) => void;
  open: boolean;
  onToggleOpen: () => void;
}) {
  const panelId = useId();
  return (
    <div class="mb-4 last:mb-0">
      <h3>
        <button
          aria-controls={panelId}
          aria-expanded={open}
          class="mb-2 flex select-none flex-wrap items-center gap-2 text-left"
          onClick={onToggleOpen}
          type="button"
        >
          <Chevron open={open} />
          <span class="board-mono font-bold text-[10px] text-zinc-400">
            {label}
          </span>
          {group.totalFiles > 0 && (
            <span class="text-[11px] text-zinc-400">
              {group.totalFiles} file{group.totalFiles === 1 ? '' : 's'} ·{' '}
              <span class="text-signal-green">+{group.additions}</span>{' '}
              <span class="text-signal-red">-{group.deletions}</span>
            </span>
          )}
        </button>
      </h3>
      <div hidden={!open} id={panelId}>
        {open && (
          <>
            {warning ? (
              <p class="pl-5 text-signal-red text-xs">{warning}</p>
            ) : group.files.length === 0 ? (
              <p class="pl-5 text-xs text-zinc-400">{emptyText}</p>
            ) : (
              <div class="rounded-none border border-zinc-200 dark:border-zinc-800">
                {group.files.map((f, i) => (
                  // Index, not f.file: a rename plus an unrelated file sharing
                  // that same new path elsewhere in the group would otherwise
                  // collide (parser sets `file` from the "+++ b/" side).
                  <FileRow
                    expanded={!!expanded[`${groupKey}:${f.file}`]}
                    f={f}
                    key={i}
                    onToggle={() => onToggleFile(`${groupKey}:${f.file}`)}
                  />
                ))}
                {group.truncatedFileCount > 0 && (
                  <p class="px-3 py-2 text-xs text-zinc-400">
                    +{group.truncatedFileCount} more file
                    {group.truncatedFileCount === 1 ? '' : 's'} not shown
                  </p>
                )}
              </div>
            )}
            {footnote && (
              <p class="mt-1 pl-5 text-xs text-zinc-400">{footnote}</p>
            )}
          </>
        )}
      </div>
    </div>
  );
}

// dirty is optional and only ever used to derive the untracked-files
// footnote below (WorktreePage already has it from /api/worktrees, via the
// same `git status --porcelain` that counts untracked files, unlike `git
// diff HEAD` which by design only sees tracked ones). DiffViewer still does
// its own fetch for everything else, this is a small enrichment, not a
// dependency on the parent's data being fresh.
export function DiffViewer({
  repo,
  name,
  dirty,
}: {
  repo: string;
  name: string;
  dirty?: number | null;
}) {
  const url = `/api/diff?repo=${encodeURIComponent(repo)}&name=${encodeURIComponent(name)}`;
  const {
    data,
    failed,
    refresh: load,
  } = useVisiblePoll(
    url,
    null,
    async (signal) => {
      const result = await readJson<DiffResponse>(url, signal);
      if (
        result.error ||
        !Array.isArray(result.committed?.files) ||
        !Array.isArray(result.uncommitted?.files)
      ) {
        throw new Error('Diff unavailable');
      }
      return result;
    },
    true,
    false
  );
  const loading = !(data || failed);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [groupOpen, setGroupOpen] = useState({
    committed: true,
    uncommitted: true,
  });

  useEffect(() => {
    const next: Record<string, boolean> = {};
    if (data) {
      for (const [groupKey, group] of [
        ['committed', data.committed],
        ['uncommitted', data.uncommitted],
      ] as const) {
        const autoOpen = group.files.length <= AUTO_EXPAND_MAX_FILES;
        for (const file of group.files) {
          next[`${groupKey}:${file.file}`] = autoOpen;
        }
      }
    }
    setExpanded((previous) =>
      Object.fromEntries(
        Object.entries(next).map(([key, value]) => [
          key,
          previous[key] ?? value,
        ])
      )
    );
  }, [data]);

  function toggleFile(key: string) {
    setExpanded((e) => ({ ...e, [key]: !e[key] }));
  }

  // When the base can't be resolved, `committed` is empty by construction
  // (computeDiff never even runs that diff), so a combined total would
  // quietly undercount without saying so. Scope the header to what was
  // actually measured rather than assert a total that's missing a piece.
  const header = (
    <div class="mb-3 flex flex-wrap items-center justify-between gap-3">
      <div class="text-xs text-zinc-400">
        {data ? (
          data.baseResolved ? (
            <>
              {data.committed.totalFiles + data.uncommitted.totalFiles} file
              {data.committed.totalFiles + data.uncommitted.totalFiles === 1
                ? ''
                : 's'}{' '}
              changed ·{' '}
              <span class="text-signal-green">
                +{data.committed.additions + data.uncommitted.additions}
              </span>{' '}
              <span class="text-signal-red">
                -{data.committed.deletions + data.uncommitted.deletions}
              </span>
            </>
          ) : (
            <>
              {data.uncommitted.totalFiles} uncommitted file
              {data.uncommitted.totalFiles === 1 ? '' : 's'} changed ·{' '}
              <span class="text-signal-green">
                +{data.uncommitted.additions}
              </span>{' '}
              <span class="text-signal-red">-{data.uncommitted.deletions}</span>{' '}
              (base unresolved, committed diff unavailable)
            </>
          )
        ) : loading ? (
          'Loading…'
        ) : (
          ' '
        )}
      </div>
      <IconButton
        disabled={loading}
        onClick={load}
        tip="Refresh diff"
        tone="zinc"
      >
        <RefreshIcon spinning={loading} />
      </IconButton>
    </div>
  );

  const readError = failed && (
    <p class="mb-3 text-signal-red text-xs" role="status">
      Could not refresh this diff.{' '}
      {data ? 'Showing the last successful read. ' : ''}
      <button class="underline" onClick={load} type="button">
        Retry
      </button>
    </p>
  );
  if (failed && !data) {
    return (
      <div>
        {header}
        {readError}
      </div>
    );
  }

  if (!data) {
    return (
      <div>
        {header}
        <p class="text-xs text-zinc-400">Loading diff…</p>
      </div>
    );
  }

  const cleanBase = data.base.replace(/^origin\//, '');
  const untracked = data.uncommitted.untracked ?? [];
  const untrackedFootnote =
    untracked.length > 0
      ? `Untracked: ${untracked.slice(0, 10).join(', ')}${untracked.length > 10 ? ` and ${untracked.length - 10} more` : ''}`
      : dirty === null
        ? 'Working tree status is unknown.'
        : undefined;

  if (
    data.baseResolved &&
    data.committed.totalFiles === 0 &&
    data.uncommitted.totalFiles === 0 &&
    untracked.length === 0 &&
    dirty !== null
  ) {
    return (
      <div>
        {header}
        <p class="text-xs text-zinc-400">
          No changes since branching from {cleanBase}
        </p>
        {readError}
      </div>
    );
  }

  return (
    <div>
      {header}
      {readError}
      <DiffGroupSection
        emptyText={`No changes since branching from ${cleanBase}`}
        expanded={expanded}
        group={data.committed}
        groupKey="committed"
        label={`Committed since branching from ${cleanBase}`}
        onToggleFile={toggleFile}
        onToggleOpen={() =>
          setGroupOpen((g) => ({ ...g, committed: !g.committed }))
        }
        open={groupOpen.committed}
        warning={
          data.baseResolved
            ? undefined
            : `Could not resolve base branch ${cleanBase}. Try fetching origin in this worktree.`
        }
      />
      <DiffGroupSection
        emptyText="No changes to tracked files"
        expanded={expanded}
        footnote={untrackedFootnote}
        group={data.uncommitted}
        groupKey="uncommitted"
        label="Uncommitted changes"
        onToggleFile={toggleFile}
        onToggleOpen={() =>
          setGroupOpen((g) => ({ ...g, uncommitted: !g.uncommitted }))
        }
        open={groupOpen.uncommitted}
      />
    </div>
  );
}
