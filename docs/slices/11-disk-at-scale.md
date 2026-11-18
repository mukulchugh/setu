# Slice 11: disk and ports at agent scale (design, for review)

Status: **proposal**. Nothing is built until it is approved. The incident is in `docs/LIMITATIONS.md` (2026-11-18).

**Goal:** one Mac runs many agent worktrees and features in parallel under heavy load. Setu keeps disk and ports bounded on its own, warns early, and never deletes anything that cannot be rebuilt without the owner's approval.

## Bottom line

- **Disk at scale is a file-count problem, not a byte problem.** Through Bun's `clonefile` backend, a worktree's `node_modules` shares all its data with Bun's cache (0 bytes private). Its roughly 300,000 files still cost about 0.3 GB of filesystem metadata each, and that is most of what an idle worktree costs.
- **Recommended, in order:**
  1. a low-disk guard that warns at 10 GB free;
  2. ports freed on stop, and optional-process ports leased only when that process runs;
  3. a dependency clean policy for stopped worktrees (reinstall is about 14 s warm);
  4. auto-archive of merged, clean, pushed worktrees, never-run ones included, as a report the owner approves;
  5. an experiment with Bun's `hardlink` backend.
- **Not recommended now:** one shared `node_modules` per lockfile hash (workspace links and bundler roots break), whole-worktree APFS clones (no metadata saving), sparse checkout (source is 0.08 GB).

## Measurements (this Mac, 18 Nov)

| What | Files | Logical | Private (unique) | How |
|---|---|---|---|---|
| Idle worktree, whole tree | 312,051 | 4.08 GB | 0.10 GB | `getattrlist(ATTR_CMNEXT_PRIVATESIZE)` per file |
| Its `node_modules` | 301,840 | 3.96 GB | 0 GB | same |
| Tracked source (git) | 9,143 | 0.08 GB | 0.08 GB | `git ls-files` sizes |
| Worktree that ran the dev server | 332,421 | 6.69 GB | 2.72 GB | same; `.next` alone 2.60 GB private |
| Real space freed per removed idle worktree | | | about 0.38 GB | `df` free space sampled every 30 s while 9 worktrees were removed (+3.45 GB; other sessions were writing, so ±) |
| Bun global cache | 7,949 entries | 7.2 GB | shared | `du`; Setu reports 6.06 GB logical |
| Warm reinstall of the same worktree | 2,557 packages | | about 0.07 GB of `df` | `bun install --frozen-lockfile`: 13.7 s |

**Reading:** about 0.38 GB freed against 0.10 GB of private data means about 0.28 GB per idle worktree is metadata, about 0.9 KB per file. At 216 worktrees that is about 80 GB, before any build output. Only 4 worktrees had a `.next` folder at measurement time, so build output was not the main cost tonight (it is when many dev servers have run).

**Not measured, and why:** a full `du` of every worktree was capped. It is slow, and `du` double-counts clones, so logical totals overstate. `df` deltas are the ground truth, as in slice 2.

## Options

| Option | Saving per idle worktree | Risk | Verdict |
|---|---|---|---|
| **A. Dependency clean policy** (`kind = "deps"`, `clean_after = "3d"` measured from stop): delete `node_modules` of stopped Setu-run worktrees; `setu up` already reinstalls a missing tree | about 0.3 GB (the metadata) | Low. 14 s reinstall on next start. A test run in a cleaned worktree fails until `bun install` (needs `setu deps ensure` or an install-on-demand hint) | **Do** |
| **B. Output clean** (whole `.next`, not only `.next/cache`) for runs stopped longer than a day | up to 2.6 GB per run worktree | Low; regenerable | **Do** (extend the preset item) |
| **C. Auto-archive** merged, clean, pushed worktrees, never-run ones included, using the same git proof as `setu rm` (merged head, no unpushed commits, no stash, no dirty files, no claim, no process) | about 0.38 GB plus 5 ports each | Medium: deletes a checkout. The owner's rule: cleanup stops at a report | **Do, report-first:** the daemon lists candidates; one command approves the listed set; raise `daily_cap` for approved sets |
| **D. Free ports on stop**, re-lease on start (keep the same port when still free) | n/a | Low; URLs are by host name, so a port change is invisible | **Do** |
| **E. Lease optional-process ports lazily** (Inngest ports only when the Inngest process starts) | 4 ports per run that never runs Inngest | Low | **Do** with D |
| **F. Low-disk guard and budgets:** warn in `setu ls`, the app and MCP at under 10 GB free; at under 5 GB, refuse `setu new` with the cleanable list; optional per-project worktree budget | prevents the outage | Low | **Do first** |
| G. Bun `hardlink` backend (`[install] backend = "hardlink"`) | possibly most of the metadata (hard links add directory entries, not inodes) | Medium: a write into `node_modules` (postinstall, patching) writes into the shared cache | **Experiment** in one project; measure with `df`; recommend per project, not as a default |
| H. One shared `node_modules` per lockfile hash, symlinked into each worktree | nearly all | High: workspace packages are relative links into the worktree, bundlers resolve the real path outside the project root, and tools write into `node_modules` | **No** |
| I. Whole-worktree APFS clone | none: each cloned file still gets its own metadata | | **No** |
| J. Sparse checkout | under 0.08 GB | | **No** |

pnpm's content-addressed store uses hard links, the same mechanism as G. It needs no separate track: G measures it.

## Estimated effect (216 worktrees, as on 18 Nov)

- **A plus B:** about 0.3 GB per stopped worktree, plus `.next` where it exists. With about 85% of worktrees stopped, about 55 GB back, without touching any checkout.
- **C:** each archived worktree returns about 0.38 GB and 5 ports. Tonight's merged-and-clean set was 105 worktrees: about 40 GB and 525 ports.
- **D plus E:** leases fall from 1,050 to the ports of running runs (tens).

## Rules this keeps

- Delete only declared, regenerable, git-ignored items in stopped runs; every deletion goes to the audit log (slice 2).
- A worktree checkout is removed only with the owner's approval of the listed set; unknown means keep (slice 7).
- Ports change only for stopped runs; a running run's port never changes.

## Build order after approval

1. F (guard) and D plus E (ports): daemon only, no deletion.
2. A and B: preset items plus `setu deps ensure`.
3. C: the candidate report and one-command approval.
4. G: measured experiment in one project, written up here.
