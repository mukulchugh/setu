import { listWorktrees } from "../lib/api";

/**
 * Lists every registered Setu worktree with its status (running, stopped, or
 * queued), uncommitted-file count, and how far ahead/behind it is from its
 * base branch. Use this to answer questions like "what's running right now"
 * or "which worktrees have uncommitted changes".
 */
export default async function tool() {
  const worktrees = await listWorktrees();
  return worktrees.map((w) => ({
    repo: w.repo,
    name: w.name,
    status: w.active
      ? "running"
      : w.queued
        ? `queued (#${w.queuePosition})`
        : "stopped",
    mode: w.container ? "container" : "bare",
    dirty: w.dirty,
    ahead: w.ahead,
    behind: w.behind,
    domain: w.domain,
  }));
}
