# Known limitations

Append-only log of limits found in real use. Each entry: what happened, the cause in Setu, and where the fix is tracked. A fixed entry stays, marked with the version that fixed it.

## 2026-11-18: disk and ports run out when agents keep hundreds of worktrees

**What happened (one Mac, 460 GB data volume):**
- The data volume reached 100% (1.2 GB free) with about 317 worktrees, 216 of them in one project. Setu refused new worktrees, and installs, tests and builds failed in every agent session.
- The 1,000-port range (4000 to 4999) ran out. 297 runs held 1,050 leases; one project leased 5 ports per run (`web` plus four Inngest ports).

**Causes in Setu:**
- **Ports are never freed on stop.** A run keeps its lease until `setu rm` or `setu forget`. Ports for an optional process (Inngest) are leased even for runs that never start it.
- **Dependencies are never cleaned.** `node_modules` has no clean policy (`dependencies are kept`), so an idle worktree keeps its whole installed tree forever. Its data is shared with Bun's cache through APFS clones, but each of its roughly 310,000 files still costs filesystem metadata (measured below).
- **Auto-removal is too slow and too narrow for agent churn.** It removes at most `daily_cap = 5` worktrees a day, after `merged_after = 24h` plus `grace = 24h`, or `idle_after = 14d`. Worktrees Setu never ran (created with `setu new` and used only for tests) have no recorded event times, so they are never candidates ("unknown means keep").
- **There is no low-disk warning.** Setu noticed only when an operation failed near 1 to 2 GB free.

**Measured (18 Nov):**
- One idle worktree: 312,051 files, 4.08 GB logical, 0.10 GB private data (APFS `ATTR_CMNEXT_PRIVATESIZE`).
- The same worktree's `node_modules`: 301,840 files, 3.96 GB logical, 0 GB private.
- Removing 9 such worktrees freed 3.45 GB of `df` free space, about 0.38 GB each. The difference from private data is filesystem metadata for the files.
- A worktree that ran the dev server adds about 2.6 GB of unique `.next` output.

**Fix tracked in:** `docs/slices/11-disk-at-scale.md`.
