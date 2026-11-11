# Stack-agnostic disk and setup research, 2026-11-11
Condensed from one research lane. [V] means verified from a fetched source; [R] means from recall and still to be checked.

## Two rules that hold across ecosystems
1. **Store-backed or content-addressed dirs clone well.** Examples: `node_modules`, `.nx/cache`, `vendor/`. Most package managers already share a global store:
   - bun: clonefile on macOS [V]
   - pnpm: clone, falling back to hardlink [V]
   - uv: clone [V]
   - Go: `GOMODCACHE` and `GOCACHE`
   - Cargo: registry only
   - Gradle and Maven: `~/.gradle`, `~/.m2`
2. **Compiler-state and environment dirs usually embed the checkout's absolute path,** so they need a reinstall or rebuild, not a clone. Examples:
   - Python `.venv` (absolute shebangs, `pyvenv.cfg`)
   - Elixir `_build`
   - .NET `obj`
   - Gradle `.gradle`
   - Cargo fingerprints and dep-info [V]
   - Turbopack's cache [V, from vercel/next.js PR #100780]
   - Rails bootsnap
   - Dart `.dart_tool`
   - Xcode DerivedData

## Regenerable per-checkout caches and outputs (safe to clean while stopped)
- **JS:**
  - Next: `.next/dev/cache/turbopack`, `.next/cache` [V]
  - Vite: `node_modules/.vite` [V]
  - Others: `.nuxt`, `.astro`, `dist/`, `build/`, `.turbo`, `.nx/cache`
- **Python:** `__pycache__`, `.pytest_cache`, `.ruff_cache`, `.mypy_cache`
- **Rust:** `target/`
- **Ruby:** `tmp/cache`
- **PHP (Laravel):** `storage/framework/{cache,views}`
- **Elixir:** `_build`
- **.NET:** `bin/`, `obj/`
- **Swift:** `.build`
- **Dart:** `.dart_tool`, `build/`

## Config shape borrowed from prior art
- **Nx, mise:** inputs and outputs per step, with content-hash freshness (mise `source_freshness_hash_contents` [V]).
- **devcontainer:** lifecycle phases, `onCreate` then `postCreate` then `postStart` [V].
- **worktrunk:**
  - hooks as a string, a table (run concurrently) or a pipeline (ordered) [V];
  - `copy-ignored` reflinks only files that are both gitignored and listed in `.worktreeinclude`, never tracked files [V].
- **Buildpacks, Railpack, Nixpacks:** a detect phase over marker files, then a plan [R].

## Presets are data, not code
- Presets ship as embedded TOML in the same schema as user config, plus a `[detect]` table (`any_of`, `none_of`, `priority`).
- Merge order: preset, then user project file, then per-worktree override.
- Framework presets stack on top of package-manager presets.
- The Rust code knows no ecosystem names, only generic detect and merge.

## Safety rules for any generic cleaner
1. Never touch a run that is live: check its process group, ports, any process whose cwd is inside the worktree, and the setup lock. Re-check right before deleting.
2. `realpath` containment inside the worktree; never follow symlinks; no `..` and no absolute globs.
3. Only git-ignored paths, never tracked files (`git check-ignore`).
4. Only declared items, never heuristics.
5. Never touch shared stores. Use the tool's own prune command as a separate, explicit action.
6. Dry-run by default, reporting logical and clone-aware physical size, age and policy.
7. Age is measured from the recorded last-stop time, never from mtime. Unknown age means skip (this is the v1 D1 lesson).
8. Keep an append-only audit log.
