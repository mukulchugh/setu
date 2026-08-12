// Repo-level PR browser: every open PR on a repo via `gh pr list`
// (portal.js's fetchRepoPRs/GET /api/repo-prs), whether or not a worktree
// exists for it yet. Fetch-on-open, not polled -- same "a human looking at
// this is the activity" convention as DiffViewer. worktrees/loaded are
// passed in from App's own state rather than fetched again here: the parent
// already holds the full, live worktree list, and cross-referencing a PR's
// branch against it is a pure client-side computation now that Worktree
// carries a real `branch` field (not just the directory name, which isn't
// reliably the same thing -- see worktreeBranchMap's comment in lib.js).
import { useState, useEffect, useCallback } from 'preact/hooks';
import { Modal, CloseBtn, IconButton, Badge, SecondaryButton, StatusDot } from '../ui';
import { relativeTime } from './relative-time';
import { checksTone, type PrChecks } from './pr-status';
import type { Worktree } from '../app';

type RepoPr = {
  number: number; title: string; url: string; branch: string;
  isDraft: boolean; checks: PrChecks; updatedAt: string; author: string | null;
};
type RepoPrsResponse = { prs: RepoPr[]; error: string | null };

function RefreshIcon({ spinning }: { spinning: boolean }) {
  return (
    <svg class={`w-4 h-4 ${spinning ? 'spin' : ''}`} fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" viewBox="0 0 24 24">
      <path d="M20 11a8.1 8.1 0 0 0 -15.5 -2m-.5 -4v4h4" />
      <path d="M4 13a8.1 8.1 0 0 0 15.5 2m.5 4v-4h-4" />
    </svg>
  );
}

export function RepoPrsModal({ repo, label, worktrees, loaded, onClose, onOpenWorktree, onCreateFromPr }: {
  repo: string; label: string; worktrees: Worktree[]; loaded: boolean;
  onClose: () => void; onOpenWorktree: (name: string) => void; onCreateFromPr: (repo: string, branch: string) => void;
}) {
  const [data, setData] = useState<RepoPrsResponse | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setData(await fetch(`/api/repo-prs?repo=${encodeURIComponent(repo)}`).then(r => r.json()).catch(() => ({ prs: [], error: 'request failed' })));
    setLoading(false);
  }, [repo]);

  useEffect(() => { load(); }, [load]);

  return (
    <Modal onClose={onClose} position="bottom">
      <div class="bg-white dark:bg-zinc-900 border-t border-zinc-200 dark:border-white/10 shadow-2xl w-full" style="height:70vh; display:flex; flex-direction:column;">
        <div class="flex items-center gap-3 px-5 py-3 border-b border-zinc-100 dark:border-white/10 shrink-0">
          <span class="text-sm font-semibold text-zinc-900 dark:text-zinc-100 flex-1">Open PRs — {label}</span>
          <IconButton tone="zinc" tip="Refresh" onClick={load} disabled={loading}>
            <RefreshIcon spinning={loading} />
          </IconButton>
          <CloseBtn onClick={onClose} />
        </div>
        <div class="flex-1 overflow-auto">
          {!data ? (
            <p class="text-zinc-400 px-5 py-6 text-center text-sm">Loading…</p>
          ) : data.error ? (
            <p class="text-signal-red px-5 py-6 text-center text-sm">{data.error}</p>
          ) : !data.prs.length ? (
            <p class="text-zinc-400 px-5 py-6 text-center text-sm">No open PRs on this repo</p>
          ) : data.prs.map(pr => {
            const match = loaded ? worktrees.find(w => w.repo === repo && w.branch === pr.branch) : undefined;
            return (
              <div key={pr.number}
                class="flex items-center gap-4 px-5 py-3 border-b border-zinc-100 dark:border-white/5 last:border-0 hover:bg-zinc-50 dark:hover:bg-white/5 transition-colors duration-150">
                <div class="min-w-0 flex-1">
                  <div class="flex items-baseline gap-2 min-w-0 flex-wrap">
                    <a href={pr.url} target="_blank" class="text-zinc-900 dark:text-zinc-100 font-medium truncate hover:text-accent transition-colors">
                      #{pr.number} — {pr.title}
                    </a>
                    {pr.isDraft && <Badge tone="amber">draft</Badge>}
                    {pr.checks !== 'none' && (
                      <span class="tip shrink-0" data-tip={`checks: ${pr.checks}`}>
                        <StatusDot tone={checksTone(pr.checks)} pulse={pr.checks === 'pending'} />
                      </span>
                    )}
                  </div>
                  <div class="flex items-center gap-3 text-xs text-zinc-400 min-w-0 flex-wrap mt-0.5">
                    <span class="font-mono truncate">{pr.branch}</span>
                    {pr.author && <span class="shrink-0">{pr.author}</span>}
                    {/* gh returns ISO8601; relativeTime takes unix seconds
                        (same convention as lastCommitAt/removedAt elsewhere
                        in this app), not milliseconds -- dividing by 1000
                        matters, an unconverted Date.getTime() would show
                        every PR as updated "months" ago. */}
                    <span class="shrink-0">Updated {relativeTime(new Date(pr.updatedAt).getTime() / 1000)}</span>
                  </div>
                </div>
                {!loaded ? (
                  <span class="text-xs text-zinc-400 shrink-0">…</span>
                ) : match ? (
                  <SecondaryButton compact onClick={() => onOpenWorktree(match.name)}>Open</SecondaryButton>
                ) : (
                  <SecondaryButton compact onClick={() => onCreateFromPr(repo, pr.branch)}>Create worktree</SecondaryButton>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </Modal>
  );
}
