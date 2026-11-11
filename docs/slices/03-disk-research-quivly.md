# Disk research for quivly-app (Next 16.4.5 / Bun 1.3.14 / APFS), 2026-11-11
This covers one example stack. The general model is in `03-disk-research-generic.md`.

## Where the bytes are (measured read-only)
- **`.next` is real, unshared disk:** 12.7 GiB across just 3 worktrees.
  - In `unified-harness-build` (7.6 GiB):
    - `dev/cache/turbopack/v16.4.5-<hash>` is 5.9 GiB (78%), stored as RocksDB-style `.sst` files.
    - `dev/server` is 1.3 GiB.
    - `dev/static` is 341 MB.
  - Other worktrees show the same ratio: the cache is 70-78% of every `.next`.
- **The Turbopack cache never prunes itself.**
  - `experimental.turbopackFileSystemCacheForDev` defaults to true since 16.1.
  - The only GC is `experimental.turbopackGc` (16.4.0, experimental, off by default; `rootTtlMs` defaults to 3 days). There is no size cap. Source: nextjs.org config docs, 2026-10-06. Issue vercel/next.js#94915 reports 6.5 GB or more.
- **`node_modules` is effectively free while Bun's cache is warm.**
  - A `getattrlist` `ATTR_CMNEXT_PRIVATESIZE` probe over 304,961 files found 0.29 MiB private against 2,933 MiB logical.
  - What remains is about 115 MiB of filesystem metadata per tree.
  - The real risk is the Bun cache being emptied: a cold install downloads 2.7 GiB again.
- **Other items**
  - `.code-review-graph`: 1.5 GiB (regenerable).
  - `.nx/workspace-data`: 188 MB.
  - The bare git repo: 1.2 GiB, shared by all worktrees.

## Safety
- **A stopped run's dev cache is safe to delete.** The cost is recompiling routes on first request; the cold-compile cost for this app is not yet measured.
- **Never delete while running.** The DB is open and `.next/dev/lock` exists, and corruption has been seen (vercel/next.js#87283).
- **Never clone `.next` from a sibling worktree.** Turbopack tasks are location-dependent: the serialized NextConfig has absolute `turbopack.root`. vercel/next.js PR #100780, merged 2026-11-11 in canary only, still lists remaining location-dependent tasks.

## Measuring true cost
- `du` overcounts clones.
- Per-file `getattrlist(FSOPT_ATTR_CMN_EXTENDED, ATTR_CMNEXT_PRIVATESIZE)` gives "bytes freed if deleted now", relative to the current sharers.
- Ground truth is the change in volume free space when something is actually removed.
