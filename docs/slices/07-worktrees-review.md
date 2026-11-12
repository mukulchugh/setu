# Worktree, merge-detection and claims: prior-art review, 2026-11-12
Condensed from one research lane. Sources are at the bottom. These are changes to make after the outside code review is merged in.

## Ranked changes
1. **Merged detection: false positive and false negative.**
   - Record the fork-point SHA at `new` and require real commits beyond it.
   - Persist "was pushed", and use upstream config or the reflog as the signal, not `refs/remotes/origin/<branch>`. GitHub deletes the branch on merge, and `fetch --prune` then removes that ref.
   - `autoremove.rs` `merged_how`.
2. **Offline merge check.** A simulated merge (`git merge-tree --write-tree origin/base HEAD` producing the same tree as base), then `git cherry`, then patch-id. This covers squash merges and rebase-and-merge without `gh`. Worktrunk and gitsweeper use the same approach.
3. **Tighter `gh` check.**
   - Use `gh pr list --head <b> --state merged --json number,headRefOid,mergedAt,baseRefName,headRepositoryOwner`.
   - Require the PR's base to equal our base and its head repo to equal origin.
   - Give "gh unavailable" its own reason, so users can see why nothing is being cleaned.
4. **rm robustness.**
   - Verify the archive (`tar -tf` count) before `git worktree remove`, and cap its size.
   - Pre-check for submodules.
   - Treat git's deterministic refusals (locked worktree, submodule) as errors with a hint, not as "unknown, retry".
5. **Claims.**
   - A short TTL (10 to 15 min) for claims without a pid. Pid-bound claims keep 2 h as a backstop.
   - Flag claims whose recorded start_time is None.
   - Optionally mirror a claim into `git worktree lock --reason "setu claim: <holder>"`, so git's own remove and prune also refuse.
6. **`--force` backs up first.** Store the dirty changes as `refs/setu-backup/<branch>`, as worktrunk does. Add optional pre-remove and post-remove hooks.
7. **Restore.**
   - Warn when the branch tip differs from the recorded head.
   - Guard tar extraction: `--no-same-owner`, check member paths, and handle collisions with linked files.

## Notes
- None of Claude Code, Cursor or Codex documents a claim protocol; they isolate work by worktree. Setu's claims are a new feature, not borrowed from those tools.
- Git's own locks (`index.lock`, worktree `locked`) have no liveness check. Setu's pid plus start-time check is stronger.

Sources:
- https://git-scm.com/docs/git-worktree
- https://worktrunk.dev/remove/
- https://github.com/coderabbitai/git-worktree-runner
- https://gitsweeper.readthedocs.io/en/latest/usage/squash-merge-detection/
- https://skills.cat/skills/wilbertliu/agent-skills/multi-agent-locks
