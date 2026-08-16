// Per-worktree diff review. Fetches GET /api/diff on mount (see portal.js's
// computeDiff/parseUnifiedDiff for the backend half) and renders it. Manual
// refresh only, no interval poll: unlike LiveLog above, this isn't a stream
// to watch, it's a "let me look at what changed" snapshot.
import { useState, useEffect, useCallback } from 'preact/hooks';
import { Badge } from '../ui/badge';
import { IconButton } from '../ui/button';
import { tablerRefresh, tablerChevronRight } from './icons';

type DiffLine = { type: 'add' | 'remove' | 'context'; content: string; oldLine?: number; newLine?: number };
type DiffHunk = { header: string; lines: DiffLine[] };
type DiffFile = { file: string; additions: number; deletions: number; hunks: DiffHunk[]; binary?: boolean; tooLarge?: boolean };
type DiffGroup = { files: DiffFile[]; additions: number; deletions: number; totalFiles: number; truncatedFileCount: number };
type DiffResponse = { base: string; baseResolved: boolean; committed: DiffGroup; uncommitted: DiffGroup; error?: string };

// Same refresh glyph DeployMenu/the sync-with-staging action already draw
// elsewhere in app.tsx: one icon meaning "reload this," not a second one.
function RefreshIcon({ spinning }: { spinning: boolean }) {
  return (
    <svg class={`w-4 h-4 ${spinning ? 'spin' : ''}`} fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" viewBox="0 0 24 24"><path d={tablerRefresh.path} /></svg>
  );
}

function Chevron({ open }: { open: boolean }) {
  return (
    <svg class={`w-3 h-3 shrink-0 text-zinc-400 transition-transform duration-150 ${open ? 'rotate-90' : ''}`}
      fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" viewBox="0 0 24 24"><path d={tablerChevronRight.path} /></svg>
  );
}

const LINE_BG: Record<DiffLine['type'], string> = {
  add: 'bg-signal-green/10 dark:bg-signal-green/15 text-signal-green',
  context: 'text-zinc-600 dark:text-zinc-400',
  remove: 'bg-signal-red/10 dark:bg-signal-red/15 text-signal-red',
};
const LINE_PREFIX: Record<DiffLine['type'], string> = { add: '+', context: ' ', remove: '-' };

function HunkBlock({ hunk }: { hunk: DiffHunk }) {
  return (
    <div>
      {/* Quieter separator row, not a full line. Code-shaped content (often
          includes a function name), so this stays font-mono rather than the
          uppercase board-mono treatment used for pure UI labels. */}
      <div class="font-mono text-[10px] tracking-wide text-zinc-400 dark:text-zinc-500 bg-zinc-50 dark:bg-zinc-800/40 px-3 py-1 border-y border-zinc-100 dark:border-zinc-800">
        {hunk.header}
      </div>
      <div class="overflow-x-auto">
        {hunk.lines.map((l, i) => (
          <div key={i} class={`flex text-[11px] leading-[1.5] font-mono ${LINE_BG[l.type]}`}>
            <span class="select-none shrink-0 w-9 text-right pr-1.5 text-zinc-300 dark:text-zinc-600">{l.oldLine ?? ''}</span>
            <span class="select-none shrink-0 w-9 text-right pr-2 text-zinc-300 dark:text-zinc-600">{l.newLine ?? ''}</span>
            <span class="select-none shrink-0 w-3 text-center opacity-60">{LINE_PREFIX[l.type]}</span>
            <span class="whitespace-pre pr-3 flex-1">{l.content}</span>
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

function FileRow({ f, expanded, onToggle }: { f: DiffFile; expanded: boolean; onToggle: () => void }) {
  const collapsible = !f.binary && !f.tooLarge && f.hunks.length > 0;
  return (
    <div class="border-b border-zinc-100 dark:border-zinc-800 last:border-0">
      <div class={`flex items-center gap-2 px-3 py-2 text-xs ${collapsible ? 'cursor-pointer hover:bg-zinc-50 dark:hover:bg-zinc-800/40' : ''}`}
        onClick={collapsible ? onToggle : undefined}>
        {collapsible ? <Chevron open={expanded} /> : <span class="w-3 shrink-0" />}
        <span class="font-mono text-zinc-700 dark:text-zinc-300 truncate flex-1">{f.file}</span>
        {f.binary ? (
          <Badge tone="zinc">binary</Badge>
        ) : f.tooLarge ? (
          <Badge tone="amber" tip="Hunk content skipped past the size guard">{f.additions + f.deletions} lines</Badge>
        ) : (
          <>
            <Badge tone="emerald">+{f.additions}</Badge>
            <Badge tone="red">-{f.deletions}</Badge>
          </>
        )}
      </div>
      {f.binary && <div class="px-3 pb-2 -mt-1 text-xs text-zinc-400">binary file changed</div>}
      {f.tooLarge && <div class="px-3 pb-2 -mt-1 text-xs text-zinc-400">too large to display, {f.additions + f.deletions} lines changed</div>}
      {collapsible && expanded && f.hunks.map((h, i) => <HunkBlock key={i} hunk={h} />)}
    </div>
  );
}

function DiffGroupSection({ label, group, emptyText, warning, footnote, groupKey, expanded, onToggleFile, open, onToggleOpen }: {
  label: string; group: DiffGroup; emptyText: string; warning?: string; footnote?: string; groupKey: string;
  expanded: Record<string, boolean>; onToggleFile: (key: string) => void;
  open: boolean; onToggleOpen: () => void;
}) {
  return (
    <div class="mb-4 last:mb-0">
      <div class="flex items-center gap-2 cursor-pointer select-none mb-2" onClick={onToggleOpen}>
        <Chevron open={open} />
        <h3 class="board-mono text-[10px] font-bold text-zinc-400">{label}</h3>
        {group.totalFiles > 0 && (
          <span class="text-[11px] text-zinc-400">
            {group.totalFiles} file{group.totalFiles === 1 ? '' : 's'} · <span class="text-signal-green">+{group.additions}</span> <span class="text-signal-red">-{group.deletions}</span>
          </span>
        )}
      </div>
      {open && (
        <>
          {warning ? (
            <p class="text-xs text-signal-red pl-5">{warning}</p>
          ) : group.files.length === 0 ? (
            <p class="text-xs text-zinc-400 pl-5">{emptyText}</p>
          ) : (
            <div class="border border-zinc-200 dark:border-zinc-800 rounded-none">
              {group.files.map((f, i) => (
                // Index, not f.file: a rename plus an unrelated file sharing
                // that same new path elsewhere in the group would otherwise
                // collide (parser sets `file` from the "+++ b/" side).
                <FileRow key={i} f={f} expanded={!!expanded[`${groupKey}:${f.file}`]} onToggle={() => onToggleFile(`${groupKey}:${f.file}`)} />
              ))}
              {group.truncatedFileCount > 0 && (
                <p class="text-xs text-zinc-400 px-3 py-2">+{group.truncatedFileCount} more file{group.truncatedFileCount === 1 ? '' : 's'} not shown</p>
              )}
            </div>
          )}
          {footnote && <p class="text-xs text-zinc-400 pl-5 mt-1">{footnote}</p>}
        </>
      )}
    </div>
  );
}

// dirty is optional and only ever used to derive the untracked-files
// footnote below (WorktreePage already has it from /api/worktrees, via the
// same `git status --porcelain` that counts untracked files, unlike `git
// diff HEAD` which by design only sees tracked ones). DiffViewer still does
// its own fetch for everything else, this is a small enrichment, not a
// dependency on the parent's data being fresh.
export function DiffViewer({ repo, name, dirty }: { repo: string; name: string; dirty?: number }) {
  const [data, setData] = useState<DiffResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [groupOpen, setGroupOpen] = useState({ committed: true, uncommitted: true });

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res: DiffResponse = await fetch(`/api/diff?repo=${encodeURIComponent(repo)}&name=${encodeURIComponent(name)}`).then(r => r.json());
      if (res?.error) { setError(res.error); }
      else {
        setData(res);
        setError(null);
        // Reset per-file expand state to this fetch's own default rather than
        // carrying stale keys from a previous diff forward.
        const next: Record<string, boolean> = {};
        for (const [groupKey, group] of [['committed', res.committed], ['uncommitted', res.uncommitted]] as const) {
          const autoOpen = group.files.length <= AUTO_EXPAND_MAX_FILES;
          for (const f of group.files) next[`${groupKey}:${f.file}`] = autoOpen;
        }
        setExpanded(next);
      }
    } catch (e) { setError(String(e)); }
    setLoading(false);
  }, [repo, name]);

  useEffect(() => { load(); }, [load]);

  function toggleFile(key: string) { setExpanded(e => ({ ...e, [key]: !e[key] })); }

  // When the base can't be resolved, `committed` is empty by construction
  // (computeDiff never even runs that diff), so a combined total would
  // quietly undercount without saying so. Scope the header to what was
  // actually measured rather than assert a total that's missing a piece.
  const header = (
    <div class="flex items-center justify-between mb-3">
      <div class="text-xs text-zinc-400">
        {!data ? (loading ? 'Loading…' : ' ') : !data.baseResolved ? (
          <>
            {data.uncommitted.totalFiles} uncommitted file{data.uncommitted.totalFiles === 1 ? '' : 's'} changed ·{' '}
            <span class="text-signal-green">+{data.uncommitted.additions}</span>{' '}
            <span class="text-signal-red">-{data.uncommitted.deletions}</span>{' '}
            (base unresolved, committed diff unavailable)
          </>
        ) : (
          <>
            {data.committed.totalFiles + data.uncommitted.totalFiles} file{data.committed.totalFiles + data.uncommitted.totalFiles === 1 ? '' : 's'} changed ·{' '}
            <span class="text-signal-green">+{data.committed.additions + data.uncommitted.additions}</span>{' '}
            <span class="text-signal-red">-{data.committed.deletions + data.uncommitted.deletions}</span>
          </>
        )}
      </div>
      <IconButton tone="zinc" tip="Refresh diff" onClick={load} disabled={loading}>
        <RefreshIcon spinning={loading} />
      </IconButton>
    </div>
  );

  if (error) {
    return (
      <div>
        {header}
        <p class="text-xs text-signal-red">Failed to load diff: {error}</p>
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
  // git status --porcelain (dirty) counts untracked files, `git diff HEAD`
  // (uncommitted.totalFiles) by design doesn't, so the gap between them is
  // exactly the untracked-file count. Approximate but honest: both count one
  // line/entry per file, so the subtraction holds outside exotic states
  // (an in-progress merge) this view doesn't otherwise handle either.
  const untrackedCount = dirty != null ? Math.max(0, dirty - data.uncommitted.totalFiles) : 0;
  const untrackedFootnote = untrackedCount > 0
    ? `+${untrackedCount} untracked file${untrackedCount === 1 ? '' : 's'} not shown (new, not yet added to git)`
    : undefined;

  if (data.baseResolved && data.committed.totalFiles === 0 && data.uncommitted.totalFiles === 0 && untrackedCount === 0) {
    return (
      <div>
        {header}
        <p class="text-xs text-zinc-400">No changes since branching from {cleanBase}</p>
      </div>
    );
  }

  return (
    <div>
      {header}
      <DiffGroupSection label={`Committed since branching from ${cleanBase}`}
        group={data.committed} emptyText={`No changes since branching from ${cleanBase}`}
        warning={!data.baseResolved ? `Could not resolve base branch ${cleanBase}. Try fetching origin in this worktree.` : undefined}
        groupKey="committed" expanded={expanded} onToggleFile={toggleFile}
        open={groupOpen.committed} onToggleOpen={() => setGroupOpen(g => ({ ...g, committed: !g.committed }))} />
      <DiffGroupSection label="Uncommitted changes"
        group={data.uncommitted} emptyText="No changes to tracked files" footnote={untrackedFootnote}
        groupKey="uncommitted" expanded={expanded} onToggleFile={toggleFile}
        open={groupOpen.uncommitted} onToggleOpen={() => setGroupOpen(g => ({ ...g, uncommitted: !g.uncommitted }))} />
    </div>
  );
}
