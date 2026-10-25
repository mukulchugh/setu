# Shared dependencies

Setu keeps the package download cache separate from installed dependencies. A cache hit avoids downloading a package; it does not establish that installed files share disk data.

Installed sharing is opt-in for each checkout, by exact `"<repo>/<branch>"` target or for a whole repository with `"<repo>/*"`. Eligibility follows the checkout's actual runtime: a worktree is container-backed only while it runs in a container or once Setu has written its `docker-compose.setu.yml`, not merely because its next Start would default to a container. Existing dependency directories are never replaced by setup or repair. A configured store alone does not mean a checkout is enrolled.

## Supported layouts

Bun's isolated layout uses its native installed store. Hoisted projects keep real `node_modules` paths and workspace symlinks. Setu can clone eligible regular files from its content and metadata store on the same APFS volume. Each checkout keeps independent writable files. Unsupported file metadata is skipped and reported; a changed volume, unknown runtime or unsafe path refuses the operation.

Files with identical bytes, permissions, owner and extended attributes can reuse one stored object even when installed at different times. Each checkout retains its own timestamps. Full file identity and metadata are still checked before conversion, recovery and release. New conversion plans use version 2; saved version 1 plans retain their original object keys and recovery identities.

The supported product runtime is Bun 1.3.14 on macOS arm64. Store configuration must name a canonical private directory outside the workspace and pin its volume identity and Bun executable. No alternate disk is used when that volume is unavailable. Container-backed targets are not eligible for this native conversion.

## Native helper

Hoisted sharing requires the helper shipped as source in `engines/dependency-files`. Missing or incompatible native support is reported in status and refuses conversion. Status and conversion never compile or download a helper.

After approving a build in the Setu source checkout, build it explicitly:

```sh
bun run dependency-files:build
```

This compiles only the dependency-free helper and publishes `bin/setu-dependency-files` in that Setu checkout. A source update does not rebuild it automatically. The helper must be verified before using the feature on existing dependencies.

## Fresh setup and interrupted enrollment

For a newly created, opted-in hoisted checkout, setup first runs the ordinary frozen install with the pinned Bun executable. Enrollment starts only after Setu observes the installer process group and tracked descendants have settled. Setup records the install inputs, checkout identity and original admission reservation before enrollment. A running or unconfirmed installer never counts as ready.

If setup stops before a plan ID is recorded, use the existing setup retry action. It continues enrollment for that same settled attempt and reservation without rerunning the installer. Once plan and operation IDs exist, reconcile that recorded operation, then resume Apply using those IDs. Conflicts or missing settlement evidence remain blocked for inspection. Setup becomes ready only after the matching journal and installed dependency view confirm completion.

## Review, apply and recover

Stop development and other writers on the selected checkout first. Setu also checks its runtime, queue, setup, admission and writer records; unreadable observations refuse mutation.

```sh
setu dependencies status <repo> <branch> --json
setu dependencies prepare <repo> <branch> --json
setu dependencies apply <repo> <branch> --plan-id <plan-id> --confirm <plan-id> --json
```

Read the prepared file list, skipped files and logical byte count before applying. The exact plan ID binds the target, checkout incarnation, inputs, store and file identities. Generic confirmation flags do not bypass that review.

Apply retains each displaced original beside its installed file and records progress before changing entries. A late writer produces a conflict with both entries retained. An uncertain response is not proof that nothing happened. Keep the returned operation ID and reconcile that same operation:

```sh
setu dependencies recover <repo> <branch> --operation-id <operation-id> --json
```

Reconciliation inspects recorded and observed state. It does not blindly overwrite or delete files. Resume only with the original reviewed plan and operation ID after checking the result. Unknown and conflicting outcomes require inspection.

```sh
setu dependencies apply <repo> <branch> --plan-id <plan-id> --operation-id <operation-id> --confirm <plan-id> --json
```

The portal and MCP use the same operation service and review IDs. MCP provides `prepare_dependency_sharing`, `apply_dependency_sharing`, `recover_dependency_sharing`, `prepare_dependency_release` and `release_dependency_originals`.

## Release originals separately

Conversion retains original bytes until a second review. It cannot promise reclaimed space while those originals remain.

```sh
setu dependencies prepare-release <repo> <branch> --operation-id <operation-id> --json
setu dependencies release <repo> <branch> --release-id <release-id> --confirm <release-id> --json
```

Release removes only the exact originals in that review after checking the installed and retained identities again. It does not prune objects, adopt other checkouts or perform recursive cleanup. No automatic expiry or garbage collection runs.

Logical clone bytes and directory sizes are not measured physical savings. Physical savings remain unknown; any available-volume delta is only a volume observation affected by other disk activity. Real application compatibility and reclaim must be measured in a separately approved inactive-checkout pilot.
