# setu

![setu](./banner.webp)

Workspace bridge for Quivly engineers — git worktrees, local `.quivly.local` domains, and a shared Cloudflare tunnel.

## Install

Prerequisites are [Homebrew](https://brew.sh) and a signed-in GitHub CLI (`gh auth login`), because this repository is private. `setu setup` installs everything else itself: `bun` (via `install.sh`, if missing), `caddy`/`cloudflared`/`dnsmasq`/`direnv`/`gh`, authenticates `gh` if needed, and offers to install a container engine if none is running (`setu start` containerizes by default — real memory/CPU caps). Missing Homebrew too? `setu setup` installs that first, then asks you to re-run the same command once (a fresh process is needed to pick up its own new PATH correctly).

```bash
gh api repos/mukulchugh/setu/contents/install.sh -H "Accept: application/vnd.github.raw" | bash
setu setup
```

**Container engine choice** (only asked if none is already running): OrbStack (recommended) or Docker Desktop both need one manual first launch to finish their own setup — this isn't skippable, it's how those apps work. Colima is the only fully headless option (`brew services`, no GUI at all). Skip entirely and pass `--bare` to `setu start` if you'd rather not install one.

Non-interactive (agents / scripts): `setu setup --name <you> --yes` — defaults to Colima if no engine is running and `--engine` isn't given, since it's the only one of the three that doesn't need a human to click through a GUI app's first launch. Override with `--engine orbstack|docker|colima|skip`.

## Update

```bash
setu update                         # update while the portal is offline
setu update --restart               # authorize a guarded restart if the portal is running
setu update --restart --include-untracked  # also preserve reviewed untracked source in the recovery stash
```

The updater stops before installation or restart if local changes cannot be restored. It retains the exact recovery stash and original revision. A running portal must support guarded updates and have no active, queued or uncertain work, supporting processes, tunnel or outgoing MCP connections. Older portals require a separately reviewed manual cutover. Setu also nudges you once a day on stderr when it is behind origin.

## Something broken?

```bash
setu doctor     # checks every layer — dnsmasq, caddy, sudoers, tunnel, worktree hygiene, portal — with fix commands
```

## Commands

```
setu setup [--name x --yes]       First-time onboarding
setu doctor [--json]              Layer-by-layer health check

setu init  quivly/quivly-app      Clone repo + create main worktree
setu new   <repo> <branch>        Create worktree (auto port + local domain)
setu new   <repo> <branch> --tunnel   ...and take the public URL
setu new   <repo> <branch> --start    ...and start its dev server
setu rm    <repo> <branch>        Remove a clean worktree through the running portal
setu rm    <repo> <branch> --force  Discard local changes and remove
                                   (a worktree named main is never removed)
setu rm    <repo> <branch> --operation-id <id>  Retry only that pending cleanup

setu cd    <repo> <branch>        cd into worktree
setu ls    [repo] [--json]        List worktrees + running state
setu start <repo> <branch>        Start dev server — sticky default: stays whatever mode this worktree has run as before, containerized if it's new (via the portal; queues past the concurrency cap)
setu start <repo> <branch> --container  Force containerized, even on a worktree that's always been bare
setu start <repo> <branch> --bare       Force bare, even on a worktree that's containerized before
setu stop  <repo> <branch>        Stop dev server (or cancel it if still queued)
setu prune [--force]              Find/kill dev servers running outside the registry
setu fetch <repo>                 git fetch --all
setu tunnel <repo> <branch>       Point the public URL at this worktree
setu tunnel <repo> <branch> stop  Release it
setu trigger <repo> <branch> [stop]  Start or stop Trigger through the running portal

setu portal                       Start web UI at http://quivly.local
setu portal stop                  Stop portal
setu update [--restart]            Guarded update on branch main; explicit restart authorization
setu version                      Version + commit
```

## Raycast extension

A third front door onto the same core the CLI and portal already use — lives in `raycast/`, talks to the portal's HTTP API (`localhost:2999`), nothing duplicated. Covers listing/starting/stopping/syncing worktrees and creating new ones, plus a Quick Open command that's the Raycast-native equivalent of the portal's ⌘K. Also ships as an [AI Extension](https://developers.raycast.com/ai/learn-core-concepts-of-ai-extensions) — Raycast's own AI can call `list-worktrees`/`start-worktree`/`stop-worktree`/`sync-worktree` directly from natural language.

`setu setup` checks for Raycast and prints this step if it's installed (there's no headless way to register a local extension — it goes through Raycast's own Import/Develop flow):

```
cd raycast && bun install && bunx ray develop
```

Requires `setu portal` to be running — the extension has an explicit "portal isn't running" state rather than failing silently.

A removal without `--force` refuses tracked or untracked changes, ignored local env files that are real files (a symlinked `.env.local` is fine), and commits that only a detached HEAD holds. A worktree named `main` is never removed, because it holds the real `.env.local` the others link to. Setu's own generated files are git-excluded automatically and do not count.

Removal can finish deleting a checkout while later cleanup fails. Setu reports `removed: true` with an operation ID and pending steps, keeps the port reserved, and shows recovery independently of the deleted card. Retry with that exact ID. After an unconfirmed network response, refresh status before trying again. An unknown process or checkout identity blocks destructive work; it does not authorize deleting an owner lock.

The portal pauses view updates and polling while hidden. Returning refreshes its process observation; failed reads retain the last good display. Log reads are bounded to 256 KiB and distinguish missing, empty and unreadable output. Host storage reports the workspace filesystem; Docker VM storage stays unknown unless measured separately.

Setu warns below 20 GiB free and checks storage again before new disk-heavy work. Below 10 GiB, or when free space cannot be verified, creation, installation and new launches are refused. Stop and removal remain available. This is a preflight check, not a disk quota: running applications and other tools can still consume space after a successful check. Docker VM space is separate from host free space.

Stopping a worktree keeps its files, build output and dependency volume. Review and explicitly remove abandoned worktrees to reclaim their owned resources. Never recursively delete folders just because they are named `dist`: package caches and `node_modules` also contain required package files. Setu's shared container cache is `workspace/.bun-cache`. [Bun's cache documentation](https://bun.com/docs/pm/global-cache) explains package copying and macOS copy-on-write; summed directory sizes are not a promise of reclaimable physical space. Setu does not automatically delete caches or worktrees.

### Workspace inventory

The portal's Inventory view includes Git worktrees that are missing from Setu's
registry. Search and copy an existing checkout path before creating another.
Registered rows and linked Git worktrees have separate counts; failed repository
discovery leaves the total unknown. Inventory caches discovery for 30 seconds and
does not scan every checkout's dependencies or build output. It provides review
checks, never an automatic deletion decision. Task ownership and last use remain
unknown when Setu cannot establish them.

### Experimental host dependency sharing

Sharing is off by default and applies only to explicitly named fresh checkouts.
All participating projects and worktrees use one centrally configured store.
Bun's native global store installs eligible package content once and links each
checkout's `node_modules` to its required dependencies, using isolated linking
and a frozen lockfile. Source worktrees stay in place.
Compatible package graphs share targets; different versions and peer graphs keep
their own targets. Local workspace packages, patched packages and trusted packages
retain their local installation behavior.

The tested installer is **Bun 1.3.14 on macOS arm64**. Setu verifies the selected
executable instead of relying on `PATH` or upgrading the app's runtime. The
`copyfile` backend avoids a cold concurrent `clonefileat` failure reproduced in
the pilot. This is not a claim that every application toolchain is compatible.

For reviewed targets, provision one private, owned directory with
mode `0700` outside the managed workspace and disposable cache/temp directories.
Set its location and installer once in `dependencySharing` in `~/.setu.json`;
the `targets` map selects exact repository/branch names with boolean values:

```json
{
  "dependencySharing": {
    "enabled": true,
    "executable": "/absolute/path/to/bun-1.3.14",
    "version": "1.3.14",
    "storeRoot": "/Users/you/.local/share/setu-dependencies",
    "targets": {
      "my-project/feature/example": true,
      "another-project/main": true
    }
  }
}
```

Merge this setting into existing configuration; do not replace the rest of the
file. A target cannot override the store or installer. CLI and portal setup use
the same policy and reject malformed sharing configuration before creating a
checkout. The checkout needs a regular
`bun.lock` and no existing root `node_modules`; existing views are never converted
automatically. Normal setup remains unchanged for every other target.

The earlier per-target policy map must be migrated explicitly: move the shared
store/installer fields to the central setting and list target names under
`targets`. Setu rejects that old configuration with a migration error; it does
not silently fall back to copied installs. If old targets use different stores,
review their existing consumers before selecting a central store. This setting
does not move or delete any existing package content.

The store's platform/runtime namespace is shared across projects; package
versions and resolved peer/dependency graphs remain distinct inside it. The
`copyfile` install backend populates the store and package-manager-required local
entries; it does not disable the global store's symlinks for eligible packages.
Patched/trusted packages and packages tied to local workspace paths can remain
local. Their presence must be measured rather than reported as full deduplication.

External-SSD migration is not enabled by this configuration example. It requires
verified volume identity and missing-drive handling before existing consumers
are converted. Real application builds and migrations remain separate acceptance
checks; tiny shared-store fixtures do not establish Quivly compatibility.

The protected store contains **live dependency targets**. Keep it after removing
a checkout, exclude it from cache cleanup, and do not prune it while consumers
remain. Removing the opt-in stops future shared installs; it does not detach
existing links. Container and agent-container sharing remain disabled pending
separate Linux runtime and toolchain verification.

Production deployment requires a current target preflight and explicit confirmation. The verified adapter supports Vercel 58.9.1 team-linked projects with an exact project and team. Netlify preview retains explicit site binding; Netlify production/custom targets and unverified Convex deployment adapters stay unavailable with an explanation. No deployment is used to discover a target.

## How it works

- Each worktree gets an auto-assigned port and a `<branch>.quivly.local` domain via Caddy
- One shared Cloudflare tunnel URL (`dev-<name>.getquivly.ai`) — `setu tunnel` moves it between worktrees
- The portal (`http://quivly.local`) owns all long-running processes: dev servers, inngest, trigger.dev, cloudflared, and any configured sidecars — `setu start`/`setu stop` (or the portal UI) reach it directly, so nothing gets started outside its tracking
- Concurrent dev servers are capped (`maxConcurrentDevServers` in `~/.setu.json`, default 3) — starting beyond the cap queues automatically and starts as a slot frees up, backed by a memory watchdog that restarts any single server that grows past a configured ceiling
- `setu start` runs a worktree's dev server in a Docker-compatible container — real cgroup-enforced `containerMemoryLimit`/`containerCpuLimit` (`~/.setu.json`, defaults `4g`/`2`, auto-clamped to whatever the engine itself actually has available) instead of the polling watchdog — **unless that worktree has only ever run bare before, in which case plain `setu start` keeps it bare.** The default is sticky per worktree, not a flat global switch: a brand-new worktree (or one that's already containerized once) defaults to a container; an established worktree with bare-only history stays bare until you explicitly pass `--container`. `--bare`/`--container` always force a specific mode regardless of history. Only the dev server itself is containerized — the portal, Caddy, dnsmasq, and git all stay native on the host, this only governs how the dev server process runs. Works with any Docker-API-compatible engine (OrbStack, Docker Desktop, Colima, …), not hardcoded to OrbStack — Caddy always proxies to `localhost:<port>` exactly like the bare path, so nothing about routing changes between the two. Full details are in [AGENTS.md](./AGENTS.md#container-mode-the-default-since-2026-08-10) (heading: "Container mode")
- Which "open in &lt;agent&gt;" buttons the portal shows isn't hardcoded — it detects installed AI coding CLIs live via `which` (see `AGENT_CLIS` in `lib.js`)
- Sidecar processes beyond Inngest/Trigger (a plain tunnel, a queue worker, anything project-specific) are configurable per-project via `$WORKSPACE/sidecars.json` — not hardcoded to any one repo's toolchain
- Config lives at `~/.setu.json`; shared logic in `lib.js` (used by both `cli.js` and `portal.js`)
- Agents: see [AGENTS.md](./AGENTS.md) for `--json` interfaces and the portal HTTP API

## Safety and resource behavior

The portal listens on `127.0.0.1:2999`. HTTP, WebSocket, and MCP requests must come from
loopback with a trusted local Host and Origin. The local Caddy address `quivly.local`
works; forwarded remote clients are rejected. This is a local tool, without multi-user authentication.

Removal checks tracked and untracked changes before stopping a worktree. Use `--force`
(or MCP `force: true`) only when discarding those files is intended. Git branches remain.

Container starts share the engine CPU budget and 90% of its memory. The remaining 10%
is reserved for the engine. Starts queue when either the engine budget or the configured
server count is full. The status response reports effective limits; settings retain the
requested values. Native sidecars use the footprint watchdog and are outside container cgroups.

Log retention checks open logs every five seconds and keeps the newest 2.5 MB when a log
exceeds 5 MB. It preserves the inode so running children can keep writing. This diagnostic
copytruncate policy can lose a concurrent line during trimming and allows bursts between checks.

## Verification

After installing the root and Raycast dependencies, run `bun run verify` for lifecycle,
security, resource, log, and cost regression checks plus separate portal and Raycast type checks.
The repository-wide `bun run check` also applies the existing Ultracite style rules.
