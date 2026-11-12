# Slice 2: disk. Measure what every worktree really costs, and clean regenerable output safely, for any stack

Research behind this slice:
- `03-disk-research-quivly.md` (the measured example)
- `03-disk-research-generic.md` (across ecosystems)
- `MEASUREMENTS.md` in the handoff folder

## What you get
- **`setu disk`** shows, for every worktree of every configured project:
  - what each declared item really costs on disk: logical size, plus clone-aware "frees if deleted" bytes;
  - the run's status and how long ago it stopped;
  - the volume's free space;
  - a health line for each shared package store. A cold or emptied store is the expensive case: 2.7 GiB to re-download for quivly-app.
- **`setu disk clean`** is a dry run by default. With `--apply` it deletes only declared, regenerable, git-ignored caches and outputs, in stopped runs, after their age policy has passed. Every deletion is written to an audit log.
- **The daemon cleans automatically** on the same rules, hourly, for runs it manages. It only ever deletes what `disk clean` would list.
- **Nothing is stack-specific in code.** Ecosystem knowledge lives in preset TOML files, with a `[detect]` section matching marker files. Presets only fill defaults, and the project config can override or disable any of them.

## Not in this slice
- Clone-from-sibling sharing. Measured: a warm Bun cache already makes `node_modules` cost about 0.3 MiB of private data per tree, and `.next` must not be cloned. Revisit per ecosystem with measurements.
- `[setup]` steps such as installs and codegen. They come with env in slice 3.
- Pruning shared stores. That is the tool's own command, run explicitly.

## Config (project TOML; presets use the same shape)
```toml
preset = ["auto"]              # default; or a list of names; [] disables presets

[[disk.item]]
name   = "next-dev-cache"
kind   = "cache"               # deps | output | cache
paths  = [".next/dev/cache", "*/*/.next/dev/cache"]   # relative; '*' matches one path segment only
clean_after = "24h"            # measured from the run's recorded stop time; absent = never auto-clean
# disabled = true              # drop a preset item with this name

[[disk.store]]
name = "bun-cache"
path = "~/.bun/install/cache"
warn_below = "1GiB"            # an emptied store makes the next install re-download everything
```

Shipped presets, as embedded data:

| Preset | Detects | Declares |
|---|---|---|
| `node-bun` | `bun.lock`, `bun.lockb` | the `node_modules` deps item and the bun store |
| `node-pnpm` | | `node_modules` and the pnpm store |
| `node-npm` | | `node_modules` |
| `next` | a `next.config.*` at the root or one or two levels down | `.next/dev/cache` and `.next/cache` (clean after 24 h); `.next/dev` (clean after 7 d) |
| `vite` | | `node_modules/.vite` |
| `python-uv` | | `.venv` as deps (never auto-clean); `__pycache__` is skipped because it is scattered, and caches go under `.pytest_cache`, `.ruff_cache`, `.mypy_cache` |
| `rust-cargo` | | `target` as output, clean after 7 d |
| `go` | | no per-tree items; stores only |
| `ruby-bundler` | | `tmp/cache` |
| `elixir-mix` | | `_build` as output |

Presets are additive, and a project can stack several of them.

## Safety rules (all must hold before any deletion)
1. **The run is stopped in Setu's state**, and no live process has its cwd inside the worktree. That covers dev servers started by hand or by v1. Both are re-checked right before each delete.
2. **The path resolves inside the worktree.** `realpath` is checked against the worktree's realpath. A symlinked candidate, or one with a symlinked ancestor inside the worktree, is skipped. Setu never follows symlinks.
3. **Git ignores the path.** `git check-ignore` must match it, and no tracked file may be under it.
4. **The path is declared** by a preset or by the project config.
5. **Age comes from Setu's own record of when the run stopped.** A new `stopped_at` field is added to the run record. A worktree Setu never ran has no stop time, so auto-clean skips it. `disk clean --include-unmanaged` can act on those, but only with `--apply` and only for items whose policy allows it.
6. **Dry-run is the default.** `--apply` deletes, and appends `{ts, run, path, bytes_freed_estimate}` to `~/Library/Logs/Setu/disk-audit.jsonl`.

## Measuring
- **Private size:** a Rust walker calls `getattrlist(ATTR_CMNEXT_PRIVATESIZE)` per file, with no symlink following, no crossing of devices, and skipping nested `.git`.
- **Logical size:** the same walker adds up `st_size`.
- **Caching:** results are cached per item by directory mtime. Walks run on the blocking pool, and `setu disk` streams rows as they finish.
- **Ground truth for savings:** the volume's free space before and after a clean.

## Code
| Module | Holds |
|---|---|
| `disk_measure.rs` | The walker, and `private_size` / `logical_size` |
| `presets.rs` and `presets/*.toml` | Detection, merge and parsing (embedded with `include_str!`) |
| `disk.rs` | Candidates, safety checks, clean, audit |
| daemon / api / cli | Hourly sweep, `disk.report` and `disk.clean` requests, `stopped_at` |
| `procinfo` | `cwd(pid)` and `pids_with_cwd_under(dir)` (`proc_pidinfo PROC_PIDVNODEPATHINFO`) |

## Verification
1. **Unit tests:**
   - preset detect and merge, including disabling and overriding an item;
   - glob matching with one segment per `*`;
   - every safety rule, using temp git repos:
     - a symlink escape (the v1 D2 case);
     - tracked files;
     - a non-ignored path;
     - a running proc with its cwd inside;
     - a missing stop time (the v1 D1 case);
   - the walker on clones: `cp -c` a dir, check private size is about 0.
2. **Read-only on this machine:** `setu disk` across all quivly-app worktrees. Check it agrees with the research numbers: about 12.7 GiB of `.next` across 3 trees, and `node_modules` private about 0.
3. **Apply on one stopped Setu-managed run** (`fix/harness-phase0-unblock`, whose `.next` Setu created in slice 1). Run `disk clean --apply` and report the free-space change against the dry-run estimate. Then start the run again and confirm it recompiles and serves.

## Verification results (2026-11-11)
**Unit tests:** 63 pass, three runs in a row. They cover:
- every safety rule: symlinked ancestors, tracked or non-ignored paths, a live process with its cwd inside the worktree, unknown age, and age policy;
- preset detect, merge and disable;
- `*` expansion that never walks into `node_modules`;
- the clone-aware walker on real APFS clones;
- `cwd` lookup by pid.

**Read-only report on this machine:** `setu disk` measured all 101 quivly-app worktrees in about 12.5 s, deps left unmeasured by default.
- It found 14.0 GiB of private data in declared items.
- `unified-harness-build` alone holds a 7.6 GiB `.next/dev`, of which 5.9 GiB is cache. This matches the research.
- Nothing was cleanable. Live v1 dev servers and unmanaged worktrees are refused, and runs stopped before `stopped_at` existed are kept because their age is unknown.
- The bun store showed as healthy at 2.0 GiB.

**Apply on a stopped, Setu-managed run** (`fix/harness-phase0-unblock`, with a temporary 1-minute policy override that was removed afterwards):
- The dry run listed exactly one item: the 407 MiB dev cache.
- Estimated private size was 426,323,968 bytes, and the measured volume free-space change was 426,336,256 bytes.
- Only the cache went; git status stayed clean. The audit line was written.
- On restart, `/mcp-home` served after an 11.6 s cold compile, and the cache started rebuilding.

**Still open**
- Clone-from-sibling sharing per ecosystem, still to be measured.
- `[setup]` steps, which come in slice 3.
- A disk budget, the app UI, and running the auto-clean under launchd (slice 5).
