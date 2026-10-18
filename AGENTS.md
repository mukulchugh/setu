# setu — agent reference

Setu manages dev worktrees: bare repos in `$WORKSPACE/<repo>.git`, worktrees at
`$WORKSPACE/<repo>/<branch>`, one auto-assigned port + `*.setu.local` domain each, and a
single shared Cloudflare tunnel URL (`dev-<name>.<your-zone>`) that one worktree owns at a time.

**Debugging anything setu-related? Start with `setu doctor --json`.** It checks every layer
(brew deps, dnsmasq, resolver, caddy, sudoers, cloudflared, git sync, worktree-registry
hygiene, container runtime reachability, container memory budget vs. engine capacity, portal,
container-mode worktrees whose container died without Setu stopping it, stale writer
claims, and changed writer baselines; see Conventions and Writer claims)
and returns `[{name, ok, fix}]`. Exit code 0 = all healthy. Checks run concurrently, not
sequentially — don't assume output order reflects check duration.

## CLI (machine-friendly)

```
setu setup --name <you> [--workspace ~/workspace] --zone <your-cloudflare-domain> [--local-zone setu.local] [--engine orbstack|docker|colima|skip] --yes
                                     # non-interactive onboarding (needs sudo TTY once). Installs
                                     # Homebrew itself if missing (then asks for one re-run — see
                                     # Conventions), brew deps incl. gh (+ gh auth login if needed),
                                     # and a container engine if none is running — --engine defaults
                                     # to colima under --yes (the only headless-installable option;
                                     # orbstack/docker need one manual app launch either way)
setu doctor --json                   # layer-by-layer health, exit 1 if any check fails
setu ls [repo] --json                # [{key, repo, name, port, running, wtDir, localDomain, tunnel}]
setu new <repo> <branch> [--tunnel] [--start] [--bare] --json
                                      # {wtDir, port, localDom, pubDom, started} — creates branch from origin/staging if new
                                      # --start containerizes by default (see Container mode below); --bare opts out
setu start <repo> <branch> [--container|--bare]
                                      # start dev server via the portal — sticky per-worktree default if neither
                                      # flag is passed (see Container mode below), queues when it cannot be
                                      # admitted; the output names the position and the reason
setu stop <repo> <branch>            # stop dev server via the portal, or cancel it if still queued
                                      # exits 1 with PORTAL_REQUIRED when the portal is not running
setu prune [--force]                 # list (or, with --force, kill) dev-server processes that listen on an
                                      # unregistered port AND run from inside the workspace. A registered
                                      # worktree's Inngest port (its port + 5288) counts as registered
setu rm <repo> <branch> [--force]    # stops servers (via portal) + removes worktree/port/domain — also removes
                                      # a container-backed worktree's node_modules volume, not just its container
                                      # requires the running portal; offline removal never deletes locally
                                      # after an uncertain response, inspect status before retrying
                                      # never removes a worktree named main, with or without --force
                                      # without --force it also refuses ignored local env files that are
                                      # real files (not symlinks) and commits only a detached HEAD holds
                                      # a registry row whose folder and git registration are both gone is
                                      # cleaned up without --force
setu rm <repo> <branch> --operation-id <id> [--json]
                                      # retry only the recorded removal; never turn this into a fresh delete
setu path <repo> <branch>            # prints worktree path
setu cd <repo> <branch>              # cd into worktree (shell wrapper; from scripts use: cd "$(setu path r b)")
setu init <gh-org>/<repo> [label]    # bare-clone + register + main worktree
setu tunnel <repo> <branch> [stop]   # point the shared public URL at this worktree
setu sync <repo> <branch>            # merge the resolved base branch in — clean merges only,
                                      # aborts + reports conflicts rather than leaving it mid-merge
setu trigger <repo> <branch> [stop]  # requires the portal (/api/trigger/start|stop)
                                      # offline requests never launch or signal a standalone process
setu mcp install <codex|cursor>      # register the portal's MCP server (see below) in that
                                      # client's own config — idempotent, preserves existing config
setu update [--restart] [--include-untracked]
                                      # guarded cutover; a running portal requires explicit --restart
                                      # untracked preservation is opt-in; exact recovery stash is retained
                                      # only on branch main (UPDATE_BRANCH_UNSUPPORTED otherwise)
                                      # a failure before restart aborts the rebase, restores the original
                                      # revision, reapplies the stash and reopens the portal
setu version                         # version + commit sha
```

Errors go to stderr with exit code 1. `setu path` stdout is consumed by shell `cd` — never
prints anything else. `setu start`/`setu new --start` returning `{ok: true, queued: true,
position: N, reason}` means it didn't start yet — it's in the portal's queue and will start
automatically when it can be admitted; don't treat `ok: true` alone as "it's running now."
`reason` is `concurrency` (the server cap is reached) or `container-capacity` (the engine
has no CPU or memory budget left). `setu new --start --json` reports `started: false` with
`queued`, `position` and `reason` in that case.

## Portal HTTP API (localhost:2999)

The portal owns all long-running processes (dev servers, inngest, trigger.dev, configured
sidecars, the cloudflared tunnel). Start it with `setu portal` if `GET /api/worktrees`
refuses connection.

| Endpoint | Body | Effect |
|---|---|---|
| GET `/api/worktrees` | — | full worktree state incl. `active`, `container` (compose project name if container-backed, else `null`), `queued`, `queuePosition`, `tunnelOn`, `pr` |
| GET `/api/projects` | — | registered repos |
| GET `/api/agents` | — | `[{id, label}]` — AI coding CLIs detected installed on this machine (live `which` check, not a fixed list) |
| GET `/api/ports` | — | processes listening on 3000–3999 (batched single `lsof` call, ~1-2s cached) |
| GET `/api/logs?repo=&name=&type=dev\|setup\|inngest\|trigger\|sidecar-<name>\|tunnel\|pr-review` | — | tail of that log |
| POST `/api/create` | `{repo, name, tunnel?}` | create worktree (bun install runs in background — poll the `setup` log) |
| POST `/api/remove` | `{repo, name, force?}` | reject dirty trees unless force is explicit, then stop and remove. Refusals carry `code`: `MAIN_WORKTREE` (a worktree named `main` is never removed) or `WORKTREE_DIRTY` (tracked or untracked changes, ignored local env files that are real files, or commits only a detached HEAD holds) |
| POST `/api/remove/cancel` | `{operationId}` | discard a pending removal whose checkout was not removed, so the worktree is usable again; refused while that removal is in flight |
| POST `/api/sidecars` | `{repo, sidecars}` | replace a project's sidecar list. Names are trimmed and must match `^[a-zA-Z0-9_-]+$` (`SIDECAR_NAME_INVALID` otherwise). A new or edited sidecar is skipped at start, and listed in `skippedSidecars`, until it is approved |
| POST `/api/sidecar-approvals/approve` | `{repo, name, command, args}` | approve a sidecar. `command` and `args` must be the ones the caller is looking at; a mismatch with the stored row is refused |
| POST `/api/start` | `{repo, name, container?}` | start dev server. `container: true`/`false` forces that mode. **Omit the field entirely** (not `null` — actually absent) to get the sticky per-worktree default (see Container mode below) instead of a flat global one — this is what the portal UI's Start button does. Container mode requires a reachable Docker-API-compatible daemon, any engine — fails with an explicit error rather than silently falling back to bare if none is reachable. Returns `{ok:true, container}` if actually started (the resolved mode, useful when the caller didn't force one), or `{ok:true, queued:true, position:N, container}` if the concurrent-server cap (`maxConcurrentDevServers`, default 3) is already reached; auto-starts sidecars from `sidecars.json` alongside it |
| POST `/api/stop` | `{repo, name}` | stop dev server (or dequeue it if still queued) — also stops its sidecars |
| POST `/api/open` | `{repo, name, tool}` | open the worktree in an installed agent CLI (Ghostty) — `tool` must be one of `/api/agents`' returned ids |
| POST `/api/tunnel/enable` / `/api/tunnel/disable` | `{repo, name}` | move/release the shared public URL |
| POST `/api/inngest/start` / `/api/inngest/stop` | `{repo, name}` | inngest dev server |
| POST `/api/trigger/start` / `/api/trigger/stop` | `{repo, name}` | trigger.dev dev server (version pinned to the worktree's @trigger.dev/sdk); spawned detached and stopped via its real process group, not just the tracked PID |
| POST `/api/ports/kill` | `{port, pid?}` | `port` must be in 3000-3999 or 8288-9287. A registered port goes through the worktree's real Stop (a raw SIGTERM to a container-published port would hit the engine's port-forwarding helper, not the dev server). If that Stop cannot identify the runtime, the caller sent the `pid` it saw, that process still holds the port, and no container publishes it, that one process gets SIGTERM. An unregistered port gets a plain SIGTERM. With `pid` set, a different current holder is refused with `PORT_OWNER_CHANGED` |
| GET `/api/pr-review/status?repo=&name=` | — | pr-walkthrough plugin install status (scope-checked against this worktree), current deep-review run state, and artifact info (findings count, staleness vs. current HEAD) for `pr-walkthrough`/`pr-brief` if either has been run against this PR |
| POST `/api/pr-review/run` | `{repo, name, skill}` | fire-and-forget: headlessly invokes the installed `pr-walkthrough`/`pr-brief` Claude Code plugin (`skill` must be one of those two) against this worktree's PR via `claude -p`, single-flight per worktree (both skills share one slot and one log). See `pr-review.js` for the invocation/security model |
| GET `/api/pr-review/artifact?repo=&name=&skill=` | — | serves the most recent run's self-contained report HTML directly |
| POST `/api/pr/create` | `{repo, name}` | open a GitHub PR against the project's base branch (`gh pr create --fill --base <base>`, the same base `setu sync` uses). Checked before anything is pushed: a GitHub remote exists, the branch has commits ahead of base, and no PR exists for it yet |
| POST `/api/pr/ready` | `{repo, name, ready}` | flip an existing PR between draft and ready for review (`gh pr ready` / `--undo`) |
| GET `/api/costs` | — | last-30-days spend per provider (Anthropic + OpenAI's real Admin APIs; Gemini is detection-only, no admin API exists) from `costs.js` — `{configured, totalCostUsd, last1d, last7d, last30d, byModel, daily}` or `{configured:false, reason}`, plus a top-level `budgets` object (`{daily?, weekly?, monthly?}`, each `{limit, spent, status}` — `status` is `ok`/`warning` (≥80% of limit)/`over`/`incomplete`) if `~/.setu-costs.json` sets any budget thresholds, else `null`. `last1d`/`last7d`/`last30d` and `budgets.spent` are all derived from the same 30-day `daily` fetch — no extra API calls. Never echoes `~/.setu-costs.json`'s key values back — aggregated numbers only, see that file's own comment in `lib.js` for why |

All POSTs return `{ok: boolean, error?: string, ...}`. A `queued: true` response means the
action was accepted but not yet performed — poll `/api/worktrees` and check `active`, not
just `ok`, to know if a dev server is actually running.

Recovery fields are part of the action contract. `/api/remove` accepts an optional
`operationId` to retry that exact recorded removal. A failed response can still contain
`removed: true`, `completedStages` and `pendingSteps`; do not repeat it as a new delete.
`GET /api/status` exposes `pendingRemovals` independently of existing worktree rows.
An uncertain network response is not evidence that an action failed before mutation.

`GET /api/worktrees?snapshot=1` adds `worktrees`, `status`, `checkedAt` and
`listenerObservation`; the default route preserves its array response. Unknown listener
observations retain the last display without certifying freshness. WebSocket clients
subscribe only while visible and close when their final view unsubscribes.

Status also includes workspace-filesystem `hostHealth`; `GET /api/status?refresh=1`
requests a fresh storage check. Unknown storage is not zero free space. Deployment
requires a current preflight context; an unknown completion keeps its owner and blocks
retry until diagnosed. Never remove a target lock merely because its operation is old.
A lock whose recorded process no longer exists is reclaimed automatically, unless it was
retained on purpose after an unknown outcome (`"retained": true` in the lock file).
`setu doctor` lists retained locks and locks with a dead owner. The CLI and the portal
release their locks on SIGINT and SIGTERM.

## Writer claims

Before editing, claim the worktree with your agent name, a unique session ID,
and a short task. Keep the same session ID throughout the task. If using an
agent hook, use the actual session ID supplied by that agent, so the hook and
claim agree. Never reuse another agent's session ID.

```sh
setu claim /path/to/worktree --agent codex --session session-123 --task "Fix login redirect"
# Refresh the heartbeat periodically during long tasks, for example every 30 minutes:
setu claim /path/to/worktree --agent codex --session session-123 --task "Fix login redirect"
# Release after finishing, including when abandoning the task:
setu release /path/to/worktree --session session-123
setu claims --json
```

`claim` and `release` default to the current directory. All four commands,
including `claim-check`, accept `--json`. An agent name is 1 to 40 lowercase letters,
digits or dashes, for example `claude-code`, `codex`, `cursor`, `opencode` or `human`.
The CLI records its parent PID by default. If a short-lived
shell launches the CLI, pass `--pid <agent-pid>` to record the long-lived local
agent process instead. MCP's `claim_worktree` requires this PID explicitly.

Claims live in `setu-writer.json` inside the worktree's own Git directory, so
linked worktrees have separate claims. The file records `agent`, `session`,
`task`, `pid`, `started_at`, `heartbeat`, `branch`, `head`, and `baseline`
(`count` and SHA-256 `hash` of the exact `git status --porcelain` output).
Branch and HEAD come from Git at claim time. Detached HEAD has a null branch;
an unborn branch has a null HEAD. A same-session refresh preserves the original
start time, branch, HEAD, and baseline, and updates the owner details and heartbeat.

A different session is refused with the current owner's details and a suggestion
to use `setu new <repo> <branch>`. Takeover is allowed only when the heartbeat is
at least two hours old **and** the recorded PID no longer exists. A takeover result
carries `tookOverFrom` (the previous agent, session, task and heartbeat), and the CLI warns
that the tree may hold that owner's uncommitted work. `claim-check` by the owning session
refreshes a heartbeat older than five minutes, so an agent that keeps checking keeps its
claim. `claim-check` on a path outside any Git worktree succeeds with no claim. `release` only
accepts the owning session, including for stale claims; `release --force` removes a claim
file only when it cannot be read. A lock left by a killed process is recovered on the next
claim, and `setu doctor` names such locks. Releasing an unclaimed
worktree succeeds without changing ownership. `claims` lists active claims in
the current repository and its sibling worktrees, plus registered Setu projects
and worktrees. It does not scan arbitrary repositories across the machine.

`setu doctor` reports stale claims, unreadable claim files, and changes to the
starting baseline. A changed baseline is a prompt to review, not proof of another
writer: the owner's own edits change it too. This status hash tracks changed paths
and status codes, not file contents, so further edits to an already-modified file
may leave it unchanged.

Claim writes and releases share an exclusive `setu-writer.json.lock` and publish
complete JSON snapshots atomically. If a process is killed during a claim operation,
the lock may remain. Inspect the PID in that lock and remove only the lock after
confirming that operation has exited. Do not delete a live owner's claim to bypass
the refusal.

For a PreToolUse command hook, call `setu claim-check <target-path> --session <id>`
before allowing a write. Exit 0 permits the tool; exit 2 blocks it with an owner
description on stderr. Errors also block. The check reads only the worktree
location and claim file, without running status, refreshing a heartbeat, or
contacting the portal. A stale claim held by another session still blocks until
explicitly reclaimed or released. File paths, new files, nested directories, and
symlinks are supported.

An example user-managed PreToolUse script that reads the hook JSON on stdin:

```js
#!/usr/bin/env bun
import { spawnSync } from 'child_process';
import { resolve } from 'path';

try {
  const event = await Bun.stdin.json();
  const target = resolve(event.cwd, event.tool_input?.file_path ?? '.');
  const result = spawnSync('setu', ['claim-check', target, '--session', event.session_id], { stdio: 'inherit' });
  process.exit(result.status === 0 ? 0 : 2);
} catch {
  console.error('Cannot check writer claim; verify the hook input and Setu installation.');
  process.exit(2);
}
```

Use this with write-capable tools such as Edit and Write. A shell or batch tool
that can write to several worktrees needs a wrapper that checks each target;
checking only its current directory cannot cover writes elsewhere. Claims are
cooperative coordination and do not stop programs that bypass these checks.
Setu does not install or change Claude or Codex hooks/settings. The MCP tools are
`claim_worktree` (`repo`, `name`, `agent`, `session`, `task`, `pid`),
`release_worktree` (`repo`, `name`, `session`), and `list_claims` (no arguments).

## Action log

Every mutating `POST /api/*` request appends one JSON line to `~/workspace/logs/actions.log`
(retention checks every five seconds; logs above 5 MB retain their latest 2.5 MB): `{ts, route, repo, name, ok,
error?}`. GET routes aren't logged (reads, not actions — the list/status polls alone run at
3 second intervals and would drown out everything else). Built specifically to close a real
gap: a prior incident (a worktree silently switched from bare to a container mid-use) took
correlating three separate external log sources by hand to root-cause, because portal.js
logged nothing about its own requests anywhere retrievable. `/mcp` is deliberately excluded
from this plain request log because it is a JSON-RPC envelope and can be SSE-framed. Supported
MCP mutations record durable operation outcomes instead; inspect `GET /api/operations` for
those records.

## MCP server (localhost:2999/mcp) — let an agent drive Setu directly

Same portal, same backend functions, a fourth front door (web UI / CLI / Raycast / MCP, in
that order of age). Tool registrations in `mcp-server.js` call straight into portal.js's own
functions in-process, not over
HTTP, with no self-fetch loopback. Streamable HTTP, stateless (fresh `McpServer` per request),
DNS-rebinding protection on, no CORS. The portal binds `127.0.0.1`; HTTP, WebSocket and MCP requests share a loopback/Host/Origin guard. Local Caddy access works, forwarded remote clients are rejected. The server also sends a real `instructions` string on
connect (MCP's own `InitializeResult.instructions` field) — architecture overview, tool
groupings, and a concrete debugging workflow, not just per-tool descriptions in isolation.

Register it with whatever's connecting:
- **Claude Code**: `claude --plugin-dir <setu>/claude-plugin` (a real packaged plugin — `.mcp.json` at its root, not inside `.claude-plugin/`).
- **Codex**: `setu mcp install codex` — appends `[mcp_servers.setu]` to `~/.codex/config.toml`.
- **Cursor**: `setu mcp install cursor` — merges `mcpServers.setu` into `~/.cursor/mcp.json`.
- **Anything else with an MCP client**: point it at `http://localhost:2999/mcp` (Streamable HTTP, no auth) in whatever config format it expects — no per-client code needed, it's a standard MCP server.

The portal must already be running when the client starts — no retry-on-demand if `/mcp` is
unreachable at session start. `create_worktree`/`remove_worktree`/`start_worktree`/
`stop_worktree` and the other route-handler hot paths (tunnel/inngest/trigger/convex
start/stop) go through async helpers (`activePidAsync`/`gitFetchAsync` in lib.js and the
command runner in dev-runtime.js, `Bun.spawn`-based) instead of
`execFileSync`/`spawnSync`, so a slow git/lsof/kill call no longer stalls the whole
single-threaded portal for every other in-flight request — same fix pattern `fetchPR` proved
out earlier. `cli.js` still uses the synchronous versions (one-shot foreground process, no
concurrent requests to starve). Compose teardown is asynchronous and propagates failures; failed cleanup keeps the worktree registered.

## Container mode (the default since 2026-08-10, sticky per worktree since the same day)

`setu start`/`setu new --start` run a worktree's dev server in a Docker-compatible container
— real cgroup-enforced memory/CPU limits instead of the polling footprint watchdog bare
processes rely on. `--container`/`--bare` (CLI) or `container: true`/`false` (API body) force
a specific mode. **Requires a reachable engine** (`docker info` succeeding) for container mode
— `setu start` fails with a clear error rather than silently falling back to bare if none is
running; pass `--bare` explicitly if you need to work without the engine up.

**The default is sticky per worktree, not a flat global switch.** `defaultContainerMode()`
(`lib.js`) applies only when neither flag/body-field is given: a worktree that already has a
`docker-compose.setu.yml` (has containerized before) stays container; a worktree with a
`dev.log` but no compose file (established bare-only history) stays bare; a worktree with
neither (genuinely new) gets the intended global default, container. This exists because of a
real incident: applying a flat "container unless told otherwise" default meant *any* restart
of *any* worktree — including one that had run bare for hours under real, active use, with
zero relation to container mode — could silently switch it into a container the moment
something (the memory-ceiling watchdog, or a portal-UI Start click on an untracked-but-alive
worktree) tried to bring it back up with no explicit choice made by anyone. Root-caused via
OrbStack's own log (`~/.orbstack/log/vmgr.log`) and Caddy's access log (`/opt/homebrew/var/log/caddy.log`,
JSON lines with epoch `ts` — filter by timestamp, not string-matching a human-readable time) —
both keep real historical evidence portal.js itself didn't log anywhere retrievable at the time.
That gap is closed now: every mutating `POST /api/*` request appends to
`~/workspace/logs/actions.log` (route, repo/name, ok/error) — see "Action log" below.

**Only the dev server process is containerized.** The portal, Caddy, dnsmasq, and git all
stay native on the host — this default governs how one process runs, not the rest of the
toolchain. Caddy's `reverse_proxy` target is unchanged, always `localhost:<port>`, identical
between bare and containerized worktrees — nothing about routing branches on which mode a
worktree is in.

**Engine-agnostic by design** — only plain Docker Engine API calls throughout (`docker info`,
`docker compose`, `mem_limit`/`cpus`, not `deploy.resources.limits`, which is swarm-only and
silently ignored by plain `docker compose up`). Works with OrbStack, Docker Desktop, or
Colima; not hardcoded to one engine, though only OrbStack has actually been tested.

**What gets generated**: `writeDockerCompose()` (`lib.js`) writes `<worktree>/docker-compose.setu.yml`
per start — gitignored via the bare repo's `.git/info/exclude` (not the tracked `.gitignore`,
since this is local Setu tooling, not a project concern). `ensureSetuExcludes()` (`lib.js`)
adds `.envrc`, `docker-compose.setu.yml`, `docker-compose.setu-agent.yml` and
`.setu-migration-prompted` there when a project is registered and whenever a worktree is
created, so Setu's own files never make a worktree look dirty. Source bind-mounts from the host;
`node_modules` is a container-local **named volume**, not a bind-mount — the host installs
macOS-native binaries (`@next/swc-darwin-arm64` etc.) that can't run in the Linux container.
The resolved (symlink-followed) `.env.local` is bind-mounted at the same in-container path
the app expects it at.

**Resource limits**: requested `containerMemoryLimit`/`containerCpuLimit` in `~/.setu.json`
(defaults `4g`/`2`) are clamped to engine capacity. Container admission shares the VM CPU
budget and 90% of VM memory across running and starting containers; the remaining 10% is
reserved for the engine. The configured concurrency cap still applies. Queue admission uses
the limits assigned at launch; adopted containers reserve the VM until stopped because their
original limits are unknown. `/api/status` reports effective and configured limits separately.
Native sidecars remain outside container cgroups and are included in the footprint watchdog.

**Compose project names are a hash of the exact `repo/name` registry key, not just a
sanitized slug** (`composeProjectName()`, `lib.js`) — a lossy slug alone let two different,
valid branch names (`feat/ab` and `feat-ab`, both mapping `/`→`-`) collide onto the same
project name, causing the second `up` to silently recreate (destroy) the first worktree's
container while the tracking layer kept reporting the first as running. Don't revert to a
plain slug without re-solving this.

**Concurrency**: `worktree-lifecycle.js` owns admission, queueing, Stop and restart.
Bare and container processes share `maxConcurrentDevServers`. The queue is first in, first
out among entries that can be admitted: an entry that cannot be admitted yet (for example
a container waiting for engine CPU) does not hold back a later one that can. Restart
applies its change first (for example a tunnel move) and leaves the runtime untouched if
that fails; it never stops or starts sidecars. Restart preserves its
reservation until teardown is confirmed, then checks current capacity and launches with
the admitted limits. Tunnel changes use the same owner and preserve the running mode;
they cannot release a slot to another worktree and then silently overbook it.

**Crash-loop / liveness**: `restart: on-failure:3` lets Docker's own OOM-kill+retry handle a
container hitting its memory ceiling, capped so a limit that's genuinely too low doesn't
crash-loop forever. `checkMemoryCeilings()`'s 60s interval separately notices a container
that exhausted its retries and permanently gave up — nothing else does, since
`docker compose up -d` itself exits successfully long before a crash-loop plays out, so the
slot would otherwise stay occupied indefinitely. `worktree-lifecycle.js` requires **two
consecutive confirmed-dead observations** (`record.deadObservations`) before freeing a
container's slot. Failed or unavailable engine observations remain unknown and preserve
the reservation. An attached Compose wrapper exiting is not proof its container exited.

**`setu rm` on a container-backed worktree** also removes its `node_modules` volume (`down -v`,
not just `down`) — a normal stop deliberately keeps the volume so the next start skips
reinstalling, but there's no "next start" coming after a removal, so without this the volume
would leak forever with nothing left pointing at it.

## Conventions

- Every container Setu itself stops goes through `composeDownAsync` (the lifecycle Stop and `removeWorktree` in portal.js), which `docker compose down`s — that *removes* the container entirely. So a compose-project container still *present* in `docker ps -a` but not `running`/`restarting` can only have gotten that way some other way: an OOM kill, a dev process that crash-looped past its `restart: on-failure` retry cap, or the container engine's own VM restarting and taking every container down with it (confirmed live: an OrbStack restart SIGKILLed a container mid-boot with nothing surfacing it — `reconcileDevServers` only adopts still-alive containers at portal boot, it never flags ones that died). `setu doctor`'s dead-container check (`composeProjectStates` in cli.js) exists for exactly this — one `docker ps -a` call bucketed by the `com.docker.compose.project` label, zero false positives by construction since Setu's own teardown never leaves a container in this state.
- `mise.toml` pins this repo's own `bun` version (`mise trust` once per clone to activate). Unrelated to `createWorktree`'s own `mise trust ...` call, which best-effort-trusts a *managed project's* own mise config on worktree creation — that's a different repo's config, not this one's. `setu doctor` reports whether `mise` itself is installed (optional, not a hard `setu setup` dependency).
- `cmdSetup` (`cli.js`) installing Homebrew itself, when missing, exits after the install and asks the user to re-run the exact same command rather than continuing in-process. Not laziness: `BREW_PREFIX`/`CADDY_BIN`/`CLOUDFLARED_BIN` (`lib.js`) are computed once at module load, before `cmdSetup` runs — with brew missing at that point they're already frozen to a fallback (wrong on Intel Macs, merely unverified on Apple Silicon) that a mid-process `PATH` patch can't fix, since they're already-evaluated constants, not lazy lookups. A fresh process re-evaluates them correctly.
- New branches fork from `origin/staging`.
- `importRepo` (`lib.js`, `writeSetuAgentMarkers`) writes `.setu.json` + a `## Managed by Setu` AGENTS.md section into a brand-new project's `main` worktree — so an agent working in a *managed* project (any registered repo) knows Setu owns its dev servers/worktrees, without having to already know Setu exists. Project-level only (repo name, portal URL, CLI reference, install one-liner) — never a specific worktree's port/domain, since these files are meant to be committed once to the project's default branch and inherited by every future worktree via git; baking in one worktree's assigned port would be stale for the next. Non-destructive to an existing AGENTS.md (appends, idempotent — checks for the marker heading before writing again) and never auto-committed, only `git add`-staged: committing into a project this tool doesn't own is the user's call. Only runs on first registration (`setu init`/sweep `--import`), not on every subsequent `setu new` — once committed, later worktrees inherit the files via normal git checkout.
  - Don't confuse this with `~/.setu-costs.json` (`COSTS_CFG_PATH` in `lib.js`) below — same filename stem, opposite everything else: that one lives in `$HOME` (not a managed project's repo), is never written by this tool at all (the user hand-writes it), and is never committed anywhere.
- `~/.setu-costs.json` (`COSTS_CFG_PATH`/`loadCostsConfig` in `lib.js`, consumed by `costs.js`) holds `anthropicAdminKey`/`openaiAdminKey` for the portal's `/api/costs` page — org-admin-scope credentials, a materially bigger blast radius than the rest of `~/.setu.json`, so they get their own file rather than a section of it. Read-only from this tool's side: nothing in `lib.js`/`portal.js` ever writes to it, and no route ever echoes its values back (the local portal never returns provider keys). The user writes it by hand. Either key falls back to `$ANTHROPIC_ADMIN_KEY`/`$OPENAI_ADMIN_KEY` if absent from the file — still same-machine/already-trusted, not a new input surface, since nothing ever reads a credential from the request itself. Optional `"budgets": {"daily": N, "weekly": N, "monthly": N}` (USD, any subset) drives the Costs page's budget bar — combined spend across whichever providers are actually configured, compared against each configured threshold; an unset period is simply omitted from `/api/costs`'s response, not defaulted.
  ```json
  {
    "anthropicAdminKey": "sk-ant-admin01-...",
    "openaiAdminKey": "sk-admin-...",
    "budgets": { "daily": 20, "weekly": 100, "monthly": 300 }
  }
  ```
- `.env.local` is symlinked from the repo's `main` worktree (`apps/<repo>/.env.local` when that dir exists).
- The non-tunnel `.envrc` (`NEXT_PUBLIC_APP_BASE_URL`) points at the worktree's own `<branch>.setu.local` domain, not `localhost` — if you ever see a `localhost:<port>` redirect after login, that's an env mismatch, not a Caddy problem (verified: Caddy always forwards the correct `Host`/`X-Forwarded-Host`).
- Ports registry: `$WORKSPACE/.ports` (`repo/branch:port`); projects: `$WORKSPACE/.projects` (`name:base:slug:label`).
- Sidecars registry (optional): `$WORKSPACE/sidecars.json` — `{ [repo]: [{name, enabled, command, args, env}] }`, Procfile-shaped. Loaded by the portal and spawned/stopped alongside the worktree's dev server. Not for Inngest/Trigger — those stay first-class endpoints; this is for anything else a project needs (a plain `cloudflared` tunnel, a queue worker, etc.).
- Concurrency: `maxConcurrentDevServers` in `~/.setu.json` (default 3) caps how many dev servers the portal will run at once; anything beyond that queues via `/api/start`'s `queued`/`position` response. Applies identically to bare and containerized worktrees — they share one cap. See "Container mode" above for the same-worktree-restart edge case this cap has to account for.
- Container mode: see the dedicated section above — it's the default now, not an opt-in aside.
- AI coding CLI registry: `AGENT_CLIS` in `lib.js` (tool-id → binary name), detected live via `which` — not a fixed list. Add a new tool by adding one entry there; no other file needs to change.
- Logs: `$WORKSPACE/logs/<repo>/<branch>/{dev,setup,inngest,trigger,sidecar-<name>,pr-review}.log`.
- PR review (`pr-review.js`): Tier 1 is the existing "Local diff" section (`computeDiff`/`/api/diff`) — a worktree-branch-vs-base diff, not the actual GitHub PR diff, labeled accordingly. Tier 2 shells out to the installed `pr-walkthrough`/`pr-brief` Claude Code plugin headlessly (`claude -p`, `--permission-mode acceptEdits`, `--tools` dropping `Edit`, `--disallowedTools` denying GH/git write-shaped Bash commands as the primary guard — verified empirically, not assumed, see the plugin-marketplace plan). Reads `~/.local/share/pr-walkthrough/{reviews,briefs}/<owner>/<repo>/pr-<N>/latest.json` + that snapshot's `manifest.json` for status/artifacts, never the multi-MB `guide.json`/`brief.json` directly.

## Spans execution (live, opt-in)

Spans can dispatch one reviewed span to one real local worker (Claude Code,
headless) and finish it through accepted completion. It is **off by default**:
every `/api/spans/execution/*` route answers 503 `SPANS_EXECUTION_DISABLED` and no
archive is opened until `~/.setu.json` contains
`"spansExecution": {"enabled": true, "runBudgetUsd": 10}` (`runBudgetUsd` is
optional and bounds what a *metered* profile may reserve; the built-in subscription
profile has no dollar amount, so it does not apply to it). A `spansExecution` block
that is present but malformed also answers 503, with `SPANS_EXECUTION_CONFIG_INVALID`
on every execution route. The setting is read once when the portal starts, so
changing `~/.setu.json` takes effect after a portal restart (`setu portal stop`, then
`setu portal`). Reads, planning and history never reach execution.

The flow, over HTTP or `setu spans exec ...`:

1. `probe <profile>` starts one fresh, short provider session (one reply, told to use
   no tool) with the profile's exact mode and toolset, and records what it showed (model,
   permission mode, tools, effort if the session reported it). The built-in subscription
   profile passes no dollar budget. This is the only source of capability. Caller JSON,
   a peer or a model cannot create it. Every probe uses the subscription; what it
   reported is added to a running total that `capabilities` returns (`probeSpend`) as a
   token count and a provider estimate, never as a charge. Evidence goes stale after six
   hours; a re-probe changes every confirmation.
2. `review` is read-only. It returns the exact binding (plan, generation, profile
   digest, checkout snapshot including a content digest of the tree the work will start
   from, instructions, the billing mode, permission mode and exact toolset, the model and
   the requested effort, wall clock up to one hour, and the optional acceptance
   conditions `criteria` and `requireChange`) and a confirmation token. A subscription
   review has no `budgetUsd` and says so (`cost.monetaryCap: null`, `enforcement:
   'none'`); a `budgetUsd` on it is `SPANS_EXEC_BUDGET_NOT_APPLICABLE`. A metered profile
   still requires `budgetUsd` (up to 2 USD).
   `dispatch` without the token returns the review.
3. `dispatch` with the exact token, after the user confirmed the review, claims the
   writer slot, takes shared admission, reserves usage, saves the durable intent and
   then starts one process. Exactly one layer takes each resource. Only one dispatch or
   resolve of a span runs at a time in a service: the other is refused
   (`SPANS_EXEC_SPAN_BUSY` for a dispatch, `SPANS_EXEC_NOT_RESOLVABLE` for a resolve)
   rather than queued, so a resolve can never release what a dispatch has just taken, nor
   the reverse. A changed
   instruction, budget, plan, generation, acceptance condition or checkout (including any
   edit to a file) is `SPANS_EXEC_REVIEW_CHANGED`; a tree that changes after the match but
   before the launch starts nothing. A dispatch the coordinator refused before any intent
   or reservation withdraws its authorization, so a newly reviewed dispatch of the same
   span is not blocked by it. The action, attempt, reservation and admission identities are
   derived from an ordinal; an ordinal whose ledger reservation was released is never used
   again, so the next dispatch of the span gets fresh identities and a live reservation,
   and the released row stays as history. The dispatch contract keeps a span's writer claim
   after a plain refusal so a retry can reuse it; the refusal then carries
   `recovery.writer = {checkoutPath, session}` (the CLI prints the exact `setu release`
   command) and nothing is released for you.
4. The supervisor spools redacted, bounded output and publishes one artifact. `cancel`
   delivers a stop to the exact owned attempt; delivery is not an exit. A cancelled
   attempt is never completion, whatever it printed or however it exited. The wall clock
   holds an overdue attempt as unknown and stops it.
5. When the exit is durable, completion is verified and the outcome is recorded, and
   usage and admission settle. `complete` repeats this by name. The record keeps three
   things apart: what the provider **reported** (its own result line and cost), what Setu
   **verified** (clean exit, complete capture, no cancel, the tree before and after, the
   `requireChange` condition), and what is **accepted** (only an owner's `accept`). Setu
   runs no test or check of its own, so `independentValidation` is always `false` and
   acceptance rests on the owner's judgement of the shown evidence. A process exit, a
   model saying it is done, or a `report` is never acceptance. A run that changes nothing
   is a legitimate completion unless the reviewed dispatch set `requireChange`, which
   compares file content (an empty commit moves HEAD but is not a change).
6. `accept` without a token returns what would be accepted: the tree and HEAD before and
   after, the changed paths (relative to the reviewed HEAD, so anything already dirty
   appears too), the criteria the owner set, the captured artifacts, and the reported and
   verified fields. With the exact token it re-checks that the tree is byte-for-byte the
   completed one and that the stored completion record still matches its own digest,
   accepts the span, makes dependents ready and releases the writer claim.

Profile and billing: the built-in profile `claude-code-sonnet` runs on the owner's
Claude subscription. It sets no dollar budget and passes no `--max-budget-usd`, it
claims no cap (`hardCostCap` is not required and nothing says `enforced`), and the
ledger reserves no amount for it (no limits, `hardCap: false`; the run's ledger totals
count it only in `unmeteredCount`). What bounds a run is the reviewed wall clock,
`cancel`, one worker and shared admission. Permission mode is `auto`, the mode the
owner's own sessions use, never `bypassPermissions`; the toolset is exactly
`Bash, Edit, Glob, Grep, Read, Write` (no sub-agents, no MCP servers). Mode and toolset
are part of the reviewed binding and of the probe, and after the run the worker's own
init event must show the same model, permission mode and tools (`verified.session`),
or the outcome is `failed` (for a profile with a toolset; a profile without one has
nothing to compare). Every session starts with `--restricted --setting-sources ""`, so
the user's, project's and local settings, hooks and memory files are not loaded (named
tools still work; organization-managed settings can still apply). That isolation is part
of the reviewed mode (`isolation`) and of the probe, and it is built in one place,
`providerArguments`. A profile with a `billing` other than `subscription` is metered and
keeps the strict path: a required `budgetUsd`, a hard cost cap, and ledger limits. A
Claude Code budget stop is a client-side estimate that stops after the response that
crosses the budget, so no probe sample (under, at or over the cap) is ever `enforced`:
a metered Claude profile always stays blocked on `hardCostCap`. The generic capability
and ledger foundation are unchanged and still enforce caps for any provider that proves
one. The ledger's rule: limits are optional per policy, and a
policy with no limits and no hard cap measures no money, so a reservation needs no
amount; any limit or hard cap keeps every earlier rule.

Usage on a subscription is only ever an estimate. The result's token counts and its
`total_cost_usd` are the provider's own figures (checked only against its per-model
figures; a mismatch is shown as such). They appear as `reported.usage` with
`billed: 'unknown'` and `basis: 'provider-reported estimate'`, never as a recorded
charge, and Setu does not know what, if anything, was billed.

Effort: the init event of a live session did not report an effort level (it reported
only `per_turn_effort_active: true`), and the provider documents that organization
settings can clamp `--effort`. The requested flag is shown as `requested`, never as
`observed`. The built-in profile says `effortPolicy: 'requested-unverified'`, an
explicit per-profile choice that lets the launch proceed when the session reported no
effort at all; the review and `launch.unverified` then read `requested, not verified`.
An effort the session did report that differs from the request (or that cannot be read)
still blocks, every profile without that policy still needs the effort observed, and the
policy excuses nothing else. This is not an effort guarantee.

Held work: an attempt whose launch or exit is unknown (a kill mid-launch, mid-run, an
unprovable process identity, a missed deadline, a capture limit) is held, its action is
`unknown`, and its writer claim, admission lease and usage reservation stay. `reconcile`
runs at portal start (and on request), holds such work, settles only what has a durable
terminal receipt, and never launches or signals anything. Nothing relaunches an unknown
attempt. **No operation resolves an unknown attempt yet**; that needs its own specified
owner action. The one exception is a dispatch that was authorized but killed before its
intent became durable: no worker can have started, and `resolve <run> <action>` shows
the admission lease, usage reservation and writer claim it would release, and releases
them only with the exact token (the writer claim stays if the span already has other
actions). A failed or unknown outcome keeps the span's writer claim; release it
deliberately with `setu release <worktree> --session <session from status>`.

One supervisor owns an archive: the owner is the highest-numbered `execution.owner.<n>`
file, and a number is never reused. The newest file is never deleted: a release writes a
`released` tombstone under the next number. A contender takes over a dead or released
owner by creating the next number with an exclusive link, so an observer holding an old
reading can only try a number that already exists. A winner must still be the highest
file right after creating its own (a lower number can be free again once pruned),
otherwise it removes only its own file and does not own. Only numbers below a winner's
own are pruned, so a live successor is never deleted, and an owner that cannot be
identified is never overtaken.

Trust boundary: the portal API is the local user's cooperative API, as described for
claims above and for the loopback/Host guard. A confirmation token is a digest the API
hands back, not proof that a person reviewed anything, and nothing here defends against a
program running as the same user that calls the API itself.

Not verified: the real `claude` binary was driven once by the parent through the public
service (one probe, one edit, accepted completion); the default shipped argument list,
the HTTP and CLI path and Ghostty have not been run live. The metered probe shape is
recorded and replayed in tests (`spans-execution.recorded-probe.jsonl`, rebuilt from a
live probe with paths and ids removed). The init and result of a real subscription task
session are replayed from `spans-execution.recorded-live-subscription-task.jsonl`
(sanitized; init and result shape only). Everything else is exercised against a local
process fixture. Work requests approved under Setu Links (ticket 12 /
#19) are not wired: the seam is the authorization step, where an approved request
would have to supply the same exact binding (target, input, plan, generation) that
`review` computes and have it re-checked at dispatch.

## Verification and polling

Run `bun run verify` after changing lifecycle, resource, access, or cost behavior. It runs
the regression checks and type checks the Preact portal and React Raycast extension separately.
`bun run check` retains the broader Ultracite style audit.

Dirty counts are asynchronous metadata (`number | null`), refreshed at most once per 15 seconds
with four Git checks in flight. `null` means unknown. Removal always runs a fresh Git status.
Warm listener and branch reads return cached data during refresh. Preserve lsof output on exit 1:
multiple port selectors can print valid listeners and still return a nonzero status.

## Complete interface contract

This section is the current inventory. `H` means the local HTTP API, `W` the
portal UI, `C` the CLI, `M` MCP, and `R` Raycast. An `H` entry is callable only
through the loopback portal guard. GET targets are query parameters; POST targets
are JSON. `T` means the registered target `{repo,name}`. A checkout identity is
the complete server-provided identity object, passed back unchanged.

Every mutation returns a known result or `{ok:false, code, error, ...recovery}`.
`accepted` and `queued` do not mean a runtime is running. Preserve `unknown` and
inspect the named status or durable record before retrying. HTTP records an
`x-setu-source` value of `ui`, `cli`, or `raycast`, otherwise `portal`; MCP is
recorded as `mcp`. Source is attribution, not authorization.

### CLI

`--json` is accepted by the CLI parser. The command-specific flags below are the
ones that change behavior. `file|-` accepts a file or standard input. Flags that
carry JSON must contain JSON.

| Command | Flags and target | Operation and recovery |
| --- | --- | --- |
| `setup` | `--name`, `--workspace`, `--zone`, `--engine orbstack\|docker\|colima\|skip`, `--yes` | Provision local prerequisites and configuration. A Homebrew install requires a rerun. |
| `doctor` | `--json` | Read concurrent local health checks and their fixes. |
| `init <gh-org>/<repo> [label]` | none | Register a GitHub repository and create `main`; local import outcomes are durable. |
| `new <repo> <branch>` | `--tunnel`, `--start`, `--container`, `--bare` | Create a worktree. `--start` can return queued; inspect worktree state. |
| `rm <repo> <branch>` | `--force`, `--operation-id <id>` | Remove through the portal. Force requests destructive behavior and needs explicit approval. Retry only the returned operation ID after an uncertain result. |
| `ls [repo]`, `status` | none | List registered worktrees; `status` aliases `ls`. |
| `start <repo> <branch>` | `--container`, `--bare` | Request a dev-server start. Omit both for sticky mode. Queued is not running. |
| `stop <repo> <branch>` | none | Stop or dequeue through a running portal. |
| `prune` | `--force` | List unregistered workspace listeners. `--force` requests a single-pid kill and needs explicit approval. CLI only. |
| `fetch <repo>` | none | Fetch the bare repository; durable local outcome. |
| `sweep` | `--import <name>` | List unmanaged clones or explicitly import one. |
| `portal [stop]` | none | Start or stop the local portal. |
| `mcp install <client>` | `--all` | Configure a supported local MCP client. `mcp status` reads configuration status. |
| `tunnel <repo> <branch> [stop]` | none | Move or release the one shared tunnel. |
| `sync <repo> <branch>` | none | Cleanly merge the resolved base; a conflict is aborted. |
| `trigger <repo> <branch> [stop]` | none | Start or stop Trigger through the portal. |
| `logs <repo> <branch>` | `--type`, `--lines` | Read a bounded log tail. |
| `diff <repo> <branch>` | `--verbose` | Read base and uncommitted diff information. |
| `ports` | none | List listeners from the portal. |
| `pr create\|ready\|status <repo> <branch>` | none | Create a PR, mark it ready, or read PR-review status. Creation is an external action. |
| `storage [inspect <repo> <branch>]` | `--store <id>` | Read cached storage, or explicitly inspect one server-known target/store. |
| `operations [repo branch]` | `--since`, `--limit` | Read durable operation outcomes. |
| `sessions [list [repo branch]]` | `end <repo> <branch> --session <id> --checkout <file\|->` | List or end an exact owned session. Identity is mandatory for end. |
| `links send <repo> <branch>` | `--session <id> --body-file <file\|-> [--idempotency-key <key> --reply-to <message>]` | Queue a message for one exact session's verified native conversation. Needs the running portal (`PORTAL_REQUIRED` otherwise). A refused send stores nothing. After an uncertain result, repeat with the same key. |
| `links inbox <repo> <branch>` | `--session <id> [--state <state>]` | List that session's messages and their honest states. |
| `links show <message>`, `links status <message>` | none | Read one message with its body, or its state and attempt count without the body. |
| `links cancel <message>` | none | Retract a message that has not been handed off. |
| `links ack <repo> <branch>` | `--session <id> --message <message>` | The addressed conversation's user acknowledges a handed-off message. |
| `links share enable <repo>` | `--owner <label> --confirmation <token>` | Share one project. The first call changes nothing and returns the exact public fields (owner, task, reachability, freshness, session ID) with a token; only the user passes that token back. Needs the running portal. |
| `links share disable <repo>` | none | Withdraw sharing: the project leaves the directory and other principals are refused. |
| `links share status [<repo>]` | none | The sharing policy of one project, or of every project that has one. |
| `links directory [<repo>]` | none | Managed sessions of shared projects with owner, task, reachability and freshness. |
| `links redeliver <repo> <branch>` | `--session <id> --message <message> --attempt <attempt>` | Accept a possible duplicate for a `handoff-unknown` message; the next claim is a new, counted attempt. |
| `caches prepare <repo> <branch>` | none | Produce an exact generated-cache cleanup manifest. |
| `caches execute <repo> <branch>` | `--manifest <id> --confirmation <token>` or `--retry <file\|->` | Execute only the reviewed manifest. A partial result returns `retryId`; retry identity contains `manifestId` and `retryId`. |
| `admission` | none | Read resource-admission leases and limits. |
| `setup-progress [list [repo branch]]` | `retry <repo> <branch> --checkout <file\|-> --attempt <id>` | Read durable setup or retry an exact attempt and identity. |
| `attention [list [repo branch]]` | `focus <repo> <branch> --session <id> --checkout <file\|->` | Read normalized attention or focus an exact verified terminal. |
| `headless list [repo branch]` | none | Read bounded headless-run records without prompts/output. |
| `headless start <repo> <branch>` | `--prompt-file <file\|->`, `--model`, `--budget`, `--wall-clock-ms`, `--output-bytes` | Start bounded Claude Code headless work. Budget is at most 2 USD, wall clock at most one hour, output at most 64 KiB. No headless turn limit is defined. |
| `headless resume <repo> <branch>` | `--run <id> --prompt-file <file\|->`, `--model`, `--budget`, `--wall-clock-ms`, `--output-bytes` | Resume the exact bounded Claude Code run. The same budget, wall-clock, and output limits apply. |
| `headless cancel <repo> <branch>` | `--run <id> --checkout <file\|->` | Cancel only the exact owned run. |
| `dependencies [status [repo branch]]` | `verify\|repair <repo> <branch>` | Read/verify a dependency view. Repair returns a plan and does not replace a view. |
| `shared-caches` | none | Read shared cache catalog records. |
| `workflows list\|runs <repo> <branch>` | none | Read GitHub workflow metadata/runs. |
| `workflows dispatch <repo> <branch>` | `--workflow <id> --ref <ref> --inputs <file\|-> [--confirmation <token>]` | First request returns a token; submit that exact token only if the reviewed workflow/ref/inputs remain unchanged. |
| `actions list` | none | Read saved connected-MCP actions. |
| `actions save` | `--input <file\|->` | Save a reviewed connected-tool mapping. |
| `actions preflight` | `--action <id> --input <file\|->` | Produce a token bound to the action revision and input. |
| `actions invoke` | `--action <id> --input <file\|-> --confirmation <token>` | Invoke only the exact reviewed external-tool input. |
| `adopt <repo> <branch>` | `--path <linked-checkout>` | Register an existing verified linked worktree without setup or start. |
| `review handoff <repo> <branch>` | `--session <id> --checkout <file\|-> --artifact <file\|-> --findings <file\|->` | Paste selected records into an exact owned terminal without submitting text. |
| `path <repo> <branch>`, `cd <repo> <branch>` | none | Print the registered worktree path; `cd` is normally a shell wrapper. |
| `update` | `--restart`, `--include-untracked` | Run guarded Setu update. A running portal requires explicit `--restart`; this is CLI only. |
| `version`, `help` | none | Print local version/commit or help. |
| `spans [list\|show <run>\|events <run>\|artifact <run> <artifact>\|search <query>\|search-status\|workflows]` | `--after`, `--since`, `--through`, `--generation`, `--run`, `--limit` | Read the offline Spans archive. Nothing here starts work. |
| `spans preview\|create-workflow\|create-draft\|revise-plan` | `--input <json>` | Save offline plans only; does not approve or start work. |
| `spans exec capabilities <profile>`, `exec status <run>` | none | Read stored probe evidence or run state. Starts nothing. |
| `spans exec probe <profile>` | none | Start one short fresh provider session to observe capability. It uses the owner's subscription (a metered profile would use a dollar budget); confirm intent first. |
| `spans exec review`, `exec dispatch` | `--input <json>`, dispatch also `[--confirmation <token>]` | Review is read-only. Dispatch without a token returns the review; with the exact token it starts one real local worker. |
| `spans exec cancel <run> <attempt>`, `exec complete <run> <action>`, `exec report`, `exec reconcile` | `report --input <json>` | Deliver a stop (not an exit), verify a finished attempt, record a claim as history, or hold and settle after a restart. |
| `spans exec accept <run> <action>`, `exec resolve <run> <action>` | `[--confirmation <token>]` | Without a token each returns the exact review. Accept completes a verified action; resolve releases a dispatch that never reached intent. |
| `claim [worktree]` | `--agent --session --task [--pid]` | Claim or refresh a writer slot. |
| `release [worktree]` | `--session` | Release only the owning writer slot. |
| `claims` | none | List known writer claims. |
| `claim-check <path>` | `--session` | Read-only writer hook check; exit 2 blocks a write. |

`settings` has no CLI or MCP command. Update and prune have no MCP, Raycast,
or portal-button front door. Settings is web/API only. The update API routes are
internal coordination for the guarded CLI update, not a separate update front door.

### Portal HTTP API

The table is complete and tested against `PORTAL_API_ROUTES`. `confirmation` in a
row means a visible review must occur first. A returned token binds reviewed
input; it does not authorize destructive or external work. Obtain explicit user
confirmation after review, then submit the token. Editing workflow inputs, saved
MCP action input, or deployment context invalidates its token. Deploy uses
current preflight context and an installed, source-verified provider binding; it
never downloads a provider tool to make a deployment possible.

<!-- PORTAL_API_ROUTES_START -->
| Method | Path | Operation, target, confirmation/recovery | Front doors |
| --- | --- | --- | --- |
| `GET` | `/api/agent-sessions` | `repo?`,`name?`; list durable sessions, each with a `nativeConversation` binding (`bound` with `provider`,`id`,`boundAt`; `pending`; or `unavailable` with `provider-unverified`). | H W C M |
| `POST` | `/api/agent-sessions/end` | T plus `sessionId`,`checkoutIdentity`; end only after owned PID/process-start identity is proven. | H W C M |
| `GET` | `/api/agents` | List installed agent CLIs. | H W R |
| `GET` | `/api/attention` | `repo?`,`name?`; list normalized attention events. | H W C M |
| `POST` | `/api/attention/focus` | T plus `sessionId`,`checkoutIdentity`; focus only through an exact Ghostty terminal mapping. | H W C M |
| `POST` | `/api/attention/hook` | Trusted provider hook payload only; unsupported payload remains unknown. | H W |
| `POST` | `/api/convex/deploy` | T plus `target`,`expectedContext`; current preflight/binding required. | H W |
| `POST` | `/api/convex/start` | T; start Convex development runtime. | H M |
| `GET` | `/api/convex/status` | T query; read Convex deployment state. | H W |
| `POST` | `/api/convex/stop` | T; stop Convex development runtime. | H M |
| `GET` | `/api/costs` | Read configured provider spend aggregates. | H W |
| `POST` | `/api/create` | `{repo,name,tunnel?}`; create worktree and durable setup. | H W M R |
| `GET` | `/api/custom-agents` | Read configured custom agent entries. | H W |
| `POST` | `/api/custom-agents` | Replace reviewed custom agent entries. | H W |
| `GET` | `/api/dependency-sharing` | No input; read dependency-sharing views. | H W C M |
| `POST` | `/api/dependency-sharing/repair` | T; return repair plan only, never convert a view. | H W C M |
| `POST` | `/api/dependency-sharing/verify` | T; verify one view. | H W C M |
| `GET` | `/api/deploy/preflight` | T plus `provider`,`target`; read fresh deployment context. | H W |
| `GET` | `/api/diff` | T query; read base and worktree diff. | H W C M |
| `GET` | `/api/file-sync-globs` | `repo`; read project file-sync globs. | H W |
| `POST` | `/api/file-sync-globs` | `repo`,`globs`; replace project file-sync globs. | H W |
| `GET` | `/api/github/runs` | T query; list bounded GitHub workflow runs. | H W C M |
| `POST` | `/api/github/dispatch` | T plus `workflow`,`ref`,`inputs`,`confirmation?`; first response supplies review token. | H W C M |
| `GET` | `/api/github/workflows` | T query; list verified dispatchable workflows. | H W C M |
| `GET` | `/api/headless-runs` | `repo?`,`name?`; list without prompt/output. | H W C M |
| `POST` | `/api/headless-runs/cancel` | T plus `runId`,`checkoutIdentity`; cancel exact owned run. | H W C M |
| `POST` | `/api/headless-runs/resume` | T plus `runId`,`prompt`, limits; server obtains fresh identity. | H W C M |
| `POST` | `/api/headless-runs/start` | T plus `prompt`, optional bounded model/limits. | H W C M |
| `POST` | `/api/inngest/start` | T; start Inngest runtime. | H W M |
| `POST` | `/api/inngest/stop` | T; stop Inngest runtime. | H W M |
| `POST` | `/api/links/ack` | T plus `sessionId`,`messageId`; the addressed conversation's user acknowledges a handed-off message. Not task completion. | H C |
| `POST` | `/api/links/cancel` | `messageId`; retract a queued or held message. Refused once handed to a conversation. | H C |
| `GET` | `/api/links/directory` | `repo?`; entries `{project,sessionId,owner,task,taskAt,taskStale,activityAt,reachability{state,reason},observedAt,stale}` of shared projects' managed sessions, and `problems` for a project whose policy cannot be read. Passive. | H C |
| `GET` | `/api/links/inbox` | T plus `sessionId`,`state?`; messages addressed to that session, newest last, without bodies. `observed` says whether the current binding was compared; each message has `state` (effective) and `storedState`. | H C |
| `GET` | `/api/links/message` | `messageId`; one message with its body. | H C |
| `POST` | `/api/links/redeliver` | T plus `sessionId`,`messageId`,`attemptId`,`confirmation?`; the first request returns a review token for the exact message, current unknown attempt and recipient; submit that token only after the receiving user confirms a possible duplicate. Not an agent tool. | H C |
| `POST` | `/api/links/share/disable` | `repo`; removes the policy and presence, holds mail from other principals. | H C |
| `POST` | `/api/links/share/enable` | `repo`,`owner?`,`confirmation?`; without the reviewed token it returns `LINKS_CONFIRMATION_REQUIRED` and the field list, and changes nothing. | H C |
| `GET` | `/api/links/share/status` | `repo?`; policy state `enabled`, `disabled` or `invalid` (with recovery). Passive. | H C |
| `POST` | `/api/links/send` | T plus `sessionId`,`idempotencyKey`,`body`,`replyTo?`; refused unless the session is running with a verified native conversation. | H C |
| `GET` | `/api/links/status` | `messageId`; delivery state, reason and attempt count, without the body. `observed` and `storedState` as for inbox. | H C |
| `GET` | `/api/logs` | T query plus `type?`,`n?`; bounded log tail. | H W C M |
| `GET` | `/api/mcp-servers` | Read connected MCP-server configuration/status. | H W |
| `POST` | `/api/mcp-servers` | Save reviewed MCP-server configuration. | H W |
| `POST` | `/api/mcp/connect` | Connect one configured server. | H W |
| `POST` | `/api/mcp/disconnect` | Disconnect one configured server. | H W |
| `GET` | `/api/mcp-actions` | List saved reviewed MCP actions. | H W C M |
| `POST` | `/api/mcp-actions/invoke` | `actionId`,`input`,`confirmation`; exact preflight token required. | H W C M |
| `POST` | `/api/mcp-actions/preflight` | `actionId`,`input`; returns token bound to current input/revision. | H W C M |
| `POST` | `/api/mcp-actions/save` | Reviewed connected-tool mapping fields. | H W C M |
| `GET` | `/api/mcp/oauth/callback/:serverId` | OAuth callback for the exact configured server ID. | H W |
| `POST` | `/api/netlify/deploy` | T plus `target`,`expectedContext`; current preflight/binding required. | H W |
| `GET` | `/api/netlify/status` | T query; read Netlify deployment status. | H W |
| `POST` | `/api/open` | T plus `tool`; open a detected agent CLI/session. | H W R |
| `GET` | `/api/operations` | `repo?`,`name?`,`since?`,`limit?`; read durable operation outcomes. | H W C M |
| `GET` | `/api/ports` | List local listeners and registered ownership. | H W C M R |
| `POST` | `/api/ports/kill` | `port`,`pid?`; exact current holder or registered stop path. | H W R |
| `GET` | `/api/pr-review/artifact` | T query plus `skill`; serve latest report artifact. | H W |
| `POST` | `/api/pr-review/run` | T plus `skill`; starts paid headless review, confirm user intent first. | H W M |
| `POST` | `/api/pr-review/handoff` | T plus exact session/identity/artifact/findings and Ghostty mapping; paste only, no Enter. | H W C M |
| `GET` | `/api/pr-review/status` | T query; read plugin/run/artifact state. | H W C M |
| `POST` | `/api/pr/create` | T; push/open GitHub PR. External action. | H W C M |
| `POST` | `/api/pr/ready` | T plus `ready`; toggle existing PR draft state. | H W C M |
| `POST` | `/api/project/add` | `github`,`name?`,`label?`; register a project. | H W |
| `POST` | `/api/project/remove` | `name`; remove a project registration only, after withdrawing its Links sharing (refused with `LINKS_OUTCOME_UNKNOWN` if the withdrawal is not confirmed). | H W |
| `GET` | `/api/projects` | List registered projects. | H W M R |
| `GET` | `/api/resource-admission` | Read admission leases/limits. | H W C M |
| `GET` | `/api/raycast/log` | Read Raycast bridge log. | H W R |
| `POST` | `/api/raycast/start` | Start Raycast bridge/runtime. | H W R |
| `GET` | `/api/raycast/status` | Read Raycast bridge/runtime status. | H W R |
| `POST` | `/api/raycast/stop` | Stop Raycast bridge/runtime. | H W R |
| `POST` | `/api/remove` | T plus `force?`,`operationId?`; force requests destructive behavior and needs approval. Retry only returned operation ID. | H W M R |
| `POST` | `/api/remove/cancel` | `operationId`; cancel a pending removal before checkout removal. | H W |
| `GET` | `/api/repo-prs` | `repo`; list open repository PRs. | H W M |
| `GET` | `/api/settings` | Read web settings. | H W |
| `POST` | `/api/settings` | Save web settings. | H W |
| `GET` | `/api/setup-progress` | `repo?`,`name?`; list durable setup records. | H W C M |
| `POST` | `/api/setup-progress/retry` | T plus `attemptId`,`checkoutIdentity`; retry exact recorded attempt. | H W C M |
| `GET` | `/api/shared-caches` | List shared-cache catalog records. | H W C M |
| `GET` | `/api/spans/runs` | `afterRunId?`,`limit?`,`phase?`,`query?`; bounded retained run summaries. | H W C M |
| `GET` | `/api/spans/workflows` | none; offline workflow catalog, no archive write. | H W C M |
| `POST` | `/api/spans/workflows/preview` | workflow inputs; redacted preview and digest, no archive write. | H W C M |
| `POST` | `/api/spans/workflows/create` | original workflow inputs plus preview digest; save a Planned draft only. | H W C M |
| `POST` | `/api/spans/drafts/create` | explicit run, goal, owner and spans; save a Planned draft only. | H W C M |
| `POST` | `/api/spans/plans/revise` | runId, goal, spans, expectedRevision, expectedGeneration; reject stale plans and action history. | H W C M |
| `GET` | `/api/spans/search` | `query`,`runId?`,`limit?`,`afterSequence?`,`throughSequence?`,`expectedGeneration?`; bounded historical matches, stale generation returns 409. | H W C M |
| `GET` | `/api/spans/search/status` | none; index generation and coverage, without indexing. | H W C M |
| `GET` | `/api/spans/run` | `runId`; full retained run view. | H W C M |
| `GET` | `/api/spans/events` | `runId`,`afterSequence?`,`limit?`; bounded append-only history. | H W C M |
| `GET` | `/api/spans/artifact` | `runId`,`artifactId`; inert redacted artifact referenced by that run. | H W C M |
| `GET` | `/api/spans/execution/capabilities` | `profile`; launch capability from stored local probe evidence only; 503 while execution is disabled. | H C |
| `POST` | `/api/spans/execution/probe` | `profile`; starts one fresh, short provider session (no budget flag on the subscription profile) to observe capability. It uses the owner's subscription (one recorded probe reported about 0.0103 USD of API-equivalent estimate); confirm user intent first. | H C |
| `POST` | `/api/spans/execution/review` | runId, spanId, profile, instructions, wallClockMs, target, `budgetUsd?` (metered profiles only), `criteria?`, `requireChange?`; read-only review and exact confirmation token. | H C |
| `POST` | `/api/spans/execution/dispatch` | the review fields plus `confirmation`; without it returns the review. Starts one real local worker; needs explicit user confirmation after review. | H C |
| `POST` | `/api/spans/execution/cancel` | `runId`,`attemptId`; deliver a stop to the exact owned attempt. Delivery is not an exit. | H C |
| `POST` | `/api/spans/execution/accept` | `runId`,`actionId`,`confirmation?`; without it returns the exact review. Accepts a verified completed action only if the tree is unchanged; needs explicit user confirmation after review. | H C |
| `POST` | `/api/spans/execution/complete` | `runId`,`actionId`; verify the finished attempt, record its outcome and settle usage and admission. Idempotent. | H C |
| `POST` | `/api/spans/execution/reconcile` | none; hold unknown work and settle proven work after a restart. Starts and signals nothing. | H C |
| `POST` | `/api/spans/execution/resolve` | `runId`,`actionId`,`confirmation?`; without it returns the exact review. Releases the resources of a dispatch that never reached intent; needs explicit user confirmation after review. | H C |
| `POST` | `/api/spans/execution/report` | `runId`,`actionId`,`generation`,`outcome`,`artifactIds?`; records a reported outcome as history or an observation. Never completes anything. | H C |
| `GET` | `/api/spans/execution/status` | `runId`; attempts, captured output references and usage. Never starts anything. | H C |
| `POST` | `/api/sidecar-approvals/approve` | `repo`,`name`,`command`,`args`; must match reviewed sidecar. | H W |
| `GET` | `/api/sidecars` | `repo`; list project sidecars. | H W M |
| `POST` | `/api/sidecars` | `repo`,`sidecars`; replace project sidecars. | H W |
| `POST` | `/api/start` | T plus optional boolean `container`; omit for sticky mode. Accepted/queued requires observation. | H W C M R |
| `GET` | `/api/status` | Read portal, host, pending-removal and runtime status. | H W R |
| `POST` | `/api/stop` | T; stop/dequeue dev server and sidecars. | H W C M R |
| `GET` | `/api/sweep` | Read import candidates. | H W |
| `POST` | `/api/sweep/import` | `name`,`remoteUrl`,`label?`; import a discovered clone. | H W |
| `POST` | `/api/sync` | T; clean base merge only. | H W C M R |
| `POST` | `/api/trigger/start` | T; start Trigger runtime. | H W C M |
| `POST` | `/api/trigger/stop` | T; stop Trigger runtime. | H W C M |
| `POST` | `/api/tunnel/disable` | T; release shared tunnel. | H W C M |
| `POST` | `/api/tunnel/enable` | T; move shared tunnel. | H W C M |
| `GET` | `/api/update/capabilities` | Internal guarded-update capability check. | H |
| `POST` | `/api/update/quiesce` | Internal guarded-update handoff. | H |
| `POST` | `/api/update/reopen` | Internal guarded-update recovery. | H |
| `POST` | `/api/update/stop` | Internal guarded-update stop. | H |
| `POST` | `/api/vercel/deploy` | T plus `target`,`expectedContext`; current preflight/binding required. | H W |
| `GET` | `/api/vercel/status` | T query; read Vercel deployment status. | H W |
| `GET` | `/api/workspace-inventory` | Read discovered/registered worktree inventory. | H W |
| `GET` | `/api/workspace-storage` | Read cached known-root storage observations only. | H W C M |
| `POST` | `/api/workspace-storage/inspect` | T or `storeId`; explicit server-resolved inspection. | H W C M |
| `POST` | `/api/worktree-cache/execute` | T plus `manifestId`,`confirmation`; execute only after user confirms the reviewed manifest. | H W C M |
| `POST` | `/api/worktree-cache/prepare` | T; create the cleanup manifest for review. | H W C M |
| `POST` | `/api/worktrees/adopt` | T plus verified linked-worktree `path`; no install/start. | H W C M |
| `GET` | `/api/worktrees` | List worktrees; `snapshot=1` adds observations/status. | H W M R |
| `GET` | `/api/worktrees/archived` | List archived worktrees. | H W |
<!-- PORTAL_API_ROUTES_END -->

### MCP tools

MCP is a local, stateless HTTP server at `/mcp`; the portal must already be
running. Tool mutations use the same target/identity/confirmation rules as the
HTTP rows. `T` below is `{repo,name}`. A tool with `identity` needs the exact
checkout identity. `review token` means preflight first and no edited input.

| Tool | Input shape | Operation |
| --- | --- | --- |
| `claim_worktree`, `release_worktree`, `list_claims` | T plus claim owner fields; release session; none | Writer ownership, release, and listing. Claim needs agent/session/task/pid. |
| `list_worktrees`, `list_projects`, `list_ports`, `get_doctor` | none | Read core local state. |
| `create_worktree` | T, `tunnel?` | Create without starting. |
| `adopt_worktree` | T, `path` | Verify and register linked checkout only. |
| `start_worktree`, `stop_worktree` | T, `container?` for start | Start with sticky default or stop/dequeue. Observe queued outcomes. |
| `enable_tunnel`, `disable_tunnel` | T | Move/release the shared tunnel. |
| `start_inngest`, `stop_inngest`, `start_trigger`, `stop_trigger`, `start_convex`, `stop_convex` | T | Control first-class runtimes. |
| `list_sidecars` | T | Read custom sidecar configuration/status. |
| `get_sidecar_logs` | T, `sidecar`, `lines?` | Read a bounded sidecar log. |
| `get_workspace_storage` | none | Read cached storage without scanning. |
| `inspect_workspace_storage` | T, optional `storeId` | Explicitly inspect a server-known root. |
| `list_operations`, `get_resource_admission` | optional target filters; none | Read outcomes/admission. |
| `list_dependency_sharing` | T | Read one dependency-sharing view. |
| `verify_dependency_sharing`, `plan_dependency_repair` | T | Verify one view or return a repair plan only. |
| `list_shared_caches` | none | Read shared-cache catalog. |
| `list_agent_sessions`, `end_agent_session` | target filters; T, `sessionId`, identity | Read sessions or end one only after owned process identity verification. |
| `prepare_worktree_cache_cleanup`, `execute_worktree_cache_cleanup` | T; T, `manifestId`, user-confirmed review token | Review, obtain user confirmation, then perform exact generated-cache cleanup. Partial results return retry identity. |
| `get_setup_progress`, `retry_setup` | target filters; T, `attemptId`, identity | Read/retry an exact durable setup attempt. |
| `list_attention`, `focus_agent_session` | target filters; T, `sessionId`, identity | Read attention or focus only through an exact Ghostty terminal mapping. |
| `handoff_review_findings` | T, `sessionId`, identity, artifact, findings | Paste through the exact Ghostty mapping without submission. |
| `list_headless_runs`, `start_headless_run`, `cancel_headless_run`, `resume_headless_run` | target filters; T plus prompt/limits; cancel identity/run ID | Manage bounded Claude Code headless runs. |
| `list_github_workflows`, `list_github_runs` | T | Read workflows/runs. |
| `dispatch_github_workflow` | T, workflow/ref/inputs, `confirmation?` | First call returns a review token; edited input invalidates it. |
| `list_mcp_actions`, `save_mcp_action`, `preflight_mcp_action`, `invoke_mcp_action` | none; mapping; action/input; action/input/token | Save, review, then invoke connected MCP tools. |
| `sync_worktree` | T | Clean base merge only. |
| `remove_worktree` | T, `force?`, `operationId?`, `reason?` | Destructive removal needs explicit approval; resume only returned operation ID. |
| `get_diff`, `get_logs` | T, `verbose?`; T, `type?`, `lines?` | Read bounded diff/log output. |
| `list_repo_prs` | `repo` | Read repository PRs. |
| `get_pr_review_status`, `run_pr_review` | T; T, skill | Read or start paid fire-and-forget review after user approval. |
| `create_pr`, `pr_ready` | T; T, `ready` | Create a PR or toggle draft/ready. |

### State, setup, cleanup, attention, and deployment

Runtime source and observation are separate. A registry/lifecycle record is a
claim about known runtime state; a listener/container/process observation can be
fresh, cached, or unknown. A failed observation preserves the last display but
does not certify it. Unknown stays unknown and retains resource reservations
until a supported recovery observation proves a result. Start completion waits
for an observed `running` state or a known failed, stopped, cancelled, or unknown
outcome. It does not infer success from acceptance or queue admission.

Setup, sessions, headless runs, cache manifests, operation events, dependency
views, and attention use durable state. End/cancel/focus/retry/handoff compares
the reviewed checkout identity to a fresh observation. A restarted portal marks
unfinished setup unknown until evidence recovers it. A durable session can be
signalled only after ownership, PID start identity, and checkout are proven.
Focus and handoff additionally require an exact terminal mapping.

Generated-cache cleanup has a narrow manifest: only `.next/cache` and
`.next/dev/cache/turbopack`, never `node_modules`, an env file, a symlink, or a
special/linked file. The manifest records target, checkout identity, HEAD,
registered/ownership/runtime snapshots, root entries with filesystem identity,
and its immutable SHA-256 ID. Execution rechecks each condition. A partial
result reports only `removedPaths` plus a new `retryId`; use it with the same
manifest ID after a fresh review.

Claude Code has trusted hook wiring. The launch token is a per-launch capability:
only its SHA-256 digest is stored, on the private managed-session record, and it
stays valid for the life of that session (it is not consumed at first bind). Every
hook (`SessionStart`, `PermissionRequest`, `Notification:agent_needs_input`, `Stop`)
must present it; a native session ID and working directory only locate the session.
Setu also checks the provider, the owned running session, and a freshly observed
checkout incarnation (filesystem identity, never HEAD). A missing, wrong,
cross-session, ended or replaced credential resolves nothing and names a stable
non-secret reason. The verified native conversation is stored on the session record
(provider, ID, bound-at, and up to eight replaced IDs kept privately), survives a
portal restart, and is shown as `nativeConversation` in session listings. A second
`SessionStart` with a new ID is a replacement; an earlier ID of the same session
resumes. One native ID is refused on a second live session, and an ID that an ended
or unconfirmed session held is never adopted by a new launch. Codex has no native
trusted-hook wiring. Setu can launch a managed Codex process and track its checkout, PID,
and process-start ownership. Its normalized parser recognizes `PermissionRequest`
and `Stop` shapes, which does not establish support for a native Codex hook.
The native focus/paste adapter was derived from Ghostty 1.3.1's scripting
dictionary/source. It needs an existing owned Ghostty terminal UUID and matching
checkout; it never launches a terminal and returns an explicit
unavailable/disabled/unknown result when proof is missing. No live Ghostty or
provider acceptance run has been performed.

Workflow dispatch and saved MCP actions bind their confirmation token to the
exact reviewed fields. The user must approve the reviewed action before its
token is submitted. Change the workflow/ref/inputs or action revision/input,
then preflight again. Deployment binds an `expectedContext` from fresh preflight
to the checkout identity, revision/dirty state, target, and provider binding.
Vercel's reviewed adapter is 58.9.1 with exact project/team linkage; Netlify
preview requires the exact linked site. Convex requires the source-verified
installed CLI/deployment-key binding. An unavailable or unbound adapter is a
refusal, never a fallback or an accepted deployment.

### Setu Links (local inbox)

`setu links` sends messages to one exact managed session's native conversation. The Setu-owned engine
in `engines/links` (Rust, `setu-links`, protocol `setu-links/1`) is the only holder of mailbox state;
JavaScript is a client of it (`links-client.js`, composed in `links-service.js`/`links-runtime.js`) and
never opens its database. Engine state lives in `~/.local/share/setu/links` (directory 0700, database
0600). See `engines/links/README.md` for the operations, states, limits and build.

- A send needs a running, owned session in its original checkout with a verified native conversation
  (`nativeConversation.state === 'bound'`) on a provider with verified delivery (Claude only). Otherwise it
  is refused with a stable code (`LINKS_SESSION_NOT_FOUND`, `LINKS_SESSION_ENDED`,
  `LINKS_SESSION_NOT_RUNNING`, `LINKS_CHECKOUT_CHANGED`, `LINKS_PROVIDER_UNVERIFIED`,
  `LINKS_NO_NATIVE_BINDING`) and nothing is stored or held for later. Identity is never inferred from
  branch, directory or terminal.
- `queued` is durable but not delivered. A claim moves mail to `handoff-unknown` at once; only the exact
  attempt's confirming report makes it `handed-off`, and `handed-off` is not read or understood.
  Nothing is replayed automatically: only a confirmed `redeliver` makes a new attempt.
- Reads are passive and honest. `inbox`, `status` and `show` never create the store and never write: the
  service passes the engine a trusted observation (the session's verified conversation, in the checkout as
  freshly observed, only while the session is verifiably running and owned) and the engine reports the
  effective state from it. Mail for any other conversation reads as `held` (`conversation-replaced`, or
  `checkout-changed` when only the checkout differs); held mail for exactly the observed conversation reads
  as `queued`, never because a different conversation appeared. `storedState` is always what the engine
  holds, and `observed: false` means there was nothing trustworthy to compare (no verified binding, ended or
  not-owned session, unreadable target or session list), so `state` is the stored state. Only an explicit
  send or claim persists the transition (`reconcile`); the live binding transitions come from the
  authenticated hook work (#10). The managed record is the only identity authority and the engine the only
  mailbox authority; there is no second registry.
- `redeliver` can duplicate a message that did arrive, so it is the receiving user's choice. The first
  request returns `LINKS_CONFIRMATION_REQUIRED` with a token bound to the exact message, its current unknown
  attempt and its recipient; the user reviews it and passes it back (`--confirmation <token>`). Any caller
  field about itself (`source`, `confirmed`, ...) is ignored or refused, a token for an earlier attempt or
  another conversation is void, the review identifies the recipient the way the engine does (provider, native conversation, checkout; never the session locator), the engine is asked to redeliver only after the exact token matches, and no agent tool (MCP) offers redelivery. The portal's loopback routes
  are a cooperative local-user surface: they do not defend against other software running as the same
  user.
- An unconfirmed result is `LINKS_OUTCOME_UNKNOWN` with recovery that fits the operation: a send names its
  idempotency key to repeat; cancel, acknowledge and confirm say repeating is safe; a claim says anything
  it claimed is `handoff-unknown` and is only redelivered on explicit request. Nothing is requeued on
  uncertainty. The client accepts an engine result only if it has exactly the expected shape.
- `claim` and `confirm` have no HTTP route: they belong to the provider hook, which authenticates a session
  first. A message or receipt is not Span completion, writer authority, admission, attention approval or
  spend authorization, and nothing wakes a provider.
- **Shared projects.** `setu links share enable <repo>` first returns the exact public fields (owner label,
  task, reachability, freshness, session ID) and what is never shared (transcripts, paths, environment,
  provider context) with a token; nothing is stored until the user passes that token back. The engine
  (`sharing_policies`, `presence`; schema 2, migrated by the first write) is the only holder of the policy
  and the presence. Visibility and receiving are granted; interrupting an agent and raising attention are
  recorded off. The local user's own mail never needs sharing. Any other principal (a `session` sender,
  `{kind:'session', id}`; a peer is not yet a sender) is admitted only by a readable policy for the
  message's project, checked on send and again on claim; an unreadable or unknown-version policy admits
  nobody for that project (`LINKS_POLICY_INVALID`; recover with `share disable`, then enable again). Mail
  already stored from a principal the project no longer admits is held (`policy-disabled`) and returns when
  sharing is enabled again (the new enable is what authorizes it; expiry and the original recipient are
  unchanged). The policy carries an opaque scope (`ps_…`) for anything outside this machine to bind to; the
  local project name never leaves it. Changing only the owner label keeps the scope; withdrawing and
  enabling again mints a new one, so grants made to the old scope stop matching.
- **A project is a registered Setu project, named by the registry's own rule, and only a printable subset of
  those names can be shared**: one line of at most 128 bytes with no control character (the registry also allows
  DEL and the C1 range; such a name is refused at review and has nothing to withdraw, so it can still be
  removed). Removing a project
  (`POST /api/project/remove`) withdraws its sharing first, with no extra prompt; if the withdrawal is not
  confirmed (`LINKS_OUTCOME_UNKNOWN`) the project stays registered. Adding the name again starts unshared and
  needs a new confirmation. The publisher and the directory skip any project the registry no longer holds,
  even if a policy row remains (`share status` reports `registered:false`). Worktrees, writer claims and
  admission are untouched.
- **Presence and the directory.** A session's presence is its owner label, a short task label, a fixed
  reachability reason and freshness. The task is the text that session wrote in its worktree's active writer
  claim, cut to 120 characters with file paths, environment references and recognizable secrets replaced by
  markers (the Spans redaction finds secrets; `links-labels.js` finds paths and `$VAR`/`NAME=value`
  references), and dropped when nothing useful is left; the engine applies the same shapes again and stores
  no task that still carries them, and an owner label that carries one is refused at review. This is a
  filter on a short label, not a promise about free text in general. Freshness has three honest parts:
  `observedAt` (the engine's time when the portal last observed the session), `taskAt` (the claim's own
  heartbeat; `taskStale` after two hours) and `activityAt` (the last authenticated managed-hook event, from
  the session record's `lastHookAt`; `null` when none has arrived, never inferred from polling or process
  liveness). An observation older than two minutes stays listed marked `stale` and reads `unknown` rather than
  reachable; an ended session is published once as `ended` and stays that way (a delayed report cannot make it reachable
  again; it is reported without reading its checkout or claim); an old writer claim still shows its task, marked
  `taskStale`. The portal publishes for shared
  projects when sharing is enabled and every 30 seconds (one interval it starts and disposes, never
  overlapping), in batches of at most 256 sessions. Reads (`share status`, `directory`) never create a store
  or write. Enabling and disabling do not touch writer claims or resource admission.
- Build and test: `bun run engine:build`, `bun run engine:test` (set `SETU_LINKS_CARGO` to the pinned
  toolchain's cargo; a missing toolchain fails the check). `bun run verify` includes the engine tests and
  the naming check. A development engine is found at `engines/links/target/release/setu-links` or
  `SETU_LINKS_ENGINE`; shipping the built binary is part of the release-lifecycle work.

### Runtime and dependency-sharing limits

The package version is `0.2.0`; no release is implied by that source value.
Setu provisions Bun 1.3.14 through `install.sh`; a source checkout uses
`bun install --frozen-lockfile`. `mise.toml` selects Bun 1.3.14. Root typecheck
and Raycast typecheck require the root dependencies `typescript`, `@raycast/api`,
`@raycast/utils`, `@types/node`, and `@types/react`; do not rely on a Raycast
`node_modules` symlink. Raycast itself is a manual local action:
`cd raycast && bun install && bunx ray develop`.

Native dependency sharing is source/fixture verified only for Bun 1.3.14 on
macOS arm64, an explicitly opted-in fresh checkout, `[install] linker =
"isolated"`, and a private 0700 store outside the workspace. Hoisted or
unspecified linkers are explicitly incompatible. No production rollout has happened.
An existing `node_modules` is never replaced automatically. Dependency repair
currently returns a plan. APFS copy-on-write and directory-size observations are
observations, not a guarantee of physical reclaim. No server, browser,
container, provider, or native-app acceptance was run for this documentation
change.
