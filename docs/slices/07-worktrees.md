# Slice 7: worktree lifecycle, writer claims, and robust auto-removal

Sources to port from (proven behaviour, not to copy blindly):
- v1 `~/.setu/lib.js` (createWorktree, assertRemovableWorktree, envLocalPath, baseBranchRef, ensureSetuExcludes)
- v1 `~/.setu/worktree-removal.js` and `~/.setu/remove-command.js` (the removal state machine)
- v1 `~/.setu/writer-claims.js` and `~/.setu/writer-claims-cli.js`
- the invariants in `~/Documents/handoffs/setu-v2-2026-11-11/V1-REVIEW.md` §4 (7–19), and defect D1 in §6

## What you get

### Lifecycle
- **`setu new <project> <branch> [--from <base>] [--start]`:**
  - fetch;
  - `git worktree add -b <branch> <project-dir>/<branch> <base>`. The default base is `origin/staging` if it exists, else `origin/<default branch>`; the project config can set it;
  - link the env files the project declares (`[worktree] link = ["apps/quivly-app/.env.local"]`, symlinked from the main worktree);
  - copy the files the project declares (`[worktree] copy = [...]`, ignored files only);
  - run the `[setup]` steps (for example `bun install --frozen-lockfile`).

  It refuses an existing branch worktree, a run-name collision, and a disk below the free-space floor (the v1 admission idea).
- **`setu adopt <path>`:** register an existing worktree. It installs nothing and changes nothing.
- **`setu rm <run> [--force]`:** a persisted, retryable operation. In order:
  1. stop the run;
  2. check the guards;
  3. archive irreplaceable ignored files;
  4. `git worktree remove`;
  5. drop state;
  6. release the port lease;
  7. write a marker.

  The branch is always kept, and a retry resumes from the recorded step.
- **`setu restore <run>`:** recreate the worktree from its kept branch and put back the archived files.

### Writer claims (agents coordinate edits)
- **`setu claim <run> [--as <name>] [--pid <pid>]`, `release <run>`, `claims`:**
  - A claim records the holder's name, its pid and pid start time, and a heartbeat.
  - A claim is stale when its pid is gone (incarnation checked) or its heartbeat is older than a TTL (default 2 h).
  - Stale claims are shown as stale and can be taken over.
- **Guards:** destructive actions refuse while a live claim exists: disk clean, `rm`, auto-removal, and restart from another actor.
- **MCP:** `worktree_claim`, `worktree_release`, `worktree_claims`, plus `worktree_new`, `worktree_adopt`, `worktree_remove` (never `--force`).
- **Setu.app:** a claim badge per run, showing who holds it.

### Auto-removal, robust (opt-in)
1. **Unknown means keep.** Age comes only from Setu's own event times: last stop, last proxied request, last start. Any missing input, git error or timeout skips the worktree.
2. **Proven safe, re-checked right before deleting:**
   - not `main`;
   - clean, including untracked files;
   - every commit on the remote, checked against a fresh fetch (a failed fetch means skip);
   - no process with its cwd inside;
   - no live claim;
   - the run is stopped.
3. **Merged means proven merged:** `git branch --merged <base>`, or the PR merged according to `gh` (that catches squash merges). If `gh` fails, the branch counts as not merged.
4. **Nothing irreplaceable is lost.** Ignored files that are neither declared regenerable (`[[disk.item]]`) nor dependencies are archived to `~/.local/share/setu/archive/<project>/<run>/<ts>.tar` and kept 30 days. `restore` brings them back.
5. **Two phases:** a worktree first becomes a candidate, visible in `ls` and the app, and is removed after a grace period (default 24 h) unless pinned. There is a daily cap (default 5), and every step is audited.

**Config (`~/.config/setu/config.toml` `[auto_remove]`):**

| Key | Default |
|---|---|
| `enabled` | `false` |
| `merged_after` | `24h` |
| `idle_after` | `14d` |
| `grace` | `24h` |
| `daily_cap` | `5` |

## Verification
- **Unit tests, on temp git repos with a bare remote:**
  - new, adopt, rm and restore;
  - every refusal: dirty tree, untracked files, unpushed commits, a live process, a live claim, `main`, a missing age (the D1 case), a failed fetch, ignored data archived and restored;
  - a crash between steps, then a retry;
  - squash-merged detection with a fake `gh`;
  - claim staleness by pid incarnation and by TTL.
- **Sandbox end to end:** new, then start, then claim, then refused removal, then release, then rm, then restore.
- **Live:** `new` and `rm` on a throwaway quivly-app branch. That needs the owner's go-ahead, because it runs `bun install`.
- No app launches.
