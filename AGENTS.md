# setu — agent reference

Setu manages Quivly dev worktrees: bare repos in `$WORKSPACE/<repo>.git`, worktrees at
`$WORKSPACE/<repo>/<branch>`, one auto-assigned port + `*.quivly.local` domain each, and a
single shared Cloudflare tunnel URL (`dev-<name>.getquivly.ai`) that one worktree owns at a time.

**Debugging anything setu-related? Start with `setu doctor --json`.** It checks every layer
(brew deps, dnsmasq, resolver, caddy, sudoers, cloudflared, git sync, worktree-registry
hygiene, container runtime reachability, container memory budget vs. engine capacity, portal,
container-mode worktrees whose container died without Setu stopping it — see Conventions)
and returns `[{name, ok, fix}]`. Exit code 0 = all healthy. Checks run concurrently, not
sequentially — don't assume output order reflects check duration.

## CLI (machine-friendly)

```
setu setup --name <you> [--workspace ~/workspace] [--zone getquivly.ai] [--engine orbstack|docker|colima|skip] --yes
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
                                      # flag is passed (see Container mode below), queues if MAX_CONCURRENT_DEV
                                      # is already reached
setu stop <repo> <branch>            # stop dev server via the portal, or cancel it if still queued
setu prune [--force]                 # list (or, with --force, kill) dev-server processes listening on a port
                                      # not in the .ports registry — the "running but invisible to setu" case
setu rm <repo> <branch> [--force]    # stops servers (via portal) + removes worktree/port/domain — also removes
                                      # a container-backed worktree's node_modules volume, not just its container
                                      # requires the running portal; offline removal never deletes locally
                                      # after an uncertain response, inspect status before retrying
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
setu version                         # version + commit sha
```

Errors go to stderr with exit code 1. `setu path` stdout is consumed by shell `cd` — never
prints anything else. `setu start`/`setu new --start` returning `{ok: true, queued: true,
position: N}` means it didn't start yet — it's in the portal's FIFO queue and will start
automatically when a slot frees up; don't treat `ok: true` alone as "it's running now."

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
| POST `/api/remove` | `{repo, name, force?}` | reject dirty trees unless force is explicit, then stop and remove |
| POST `/api/start` | `{repo, name, container?}` | start dev server. `container: true`/`false` forces that mode. **Omit the field entirely** (not `null` — actually absent) to get the sticky per-worktree default (see Container mode below) instead of a flat global one — this is what the portal UI's Start button does. Container mode requires a reachable Docker-API-compatible daemon, any engine — fails with an explicit error rather than silently falling back to bare if none is reachable. Returns `{ok:true, container}` if actually started (the resolved mode, useful when the caller didn't force one), or `{ok:true, queued:true, position:N, container}` if the concurrent-server cap (`maxConcurrentDevServers`, default 3) is already reached; auto-starts sidecars from `sidecars.json` alongside it |
| POST `/api/stop` | `{repo, name}` | stop dev server (or dequeue it if still queued) — also stops its sidecars |
| POST `/api/open` | `{repo, name, tool}` | open the worktree in an installed agent CLI (Ghostty) — `tool` must be one of `/api/agents`' returned ids |
| POST `/api/tunnel/enable` / `/api/tunnel/disable` | `{repo, name}` | move/release the shared public URL |
| POST `/api/inngest/start` / `/api/inngest/stop` | `{repo, name}` | inngest dev server |
| POST `/api/trigger/start` / `/api/trigger/stop` | `{repo, name}` | trigger.dev dev server (version pinned to the worktree's @trigger.dev/sdk); spawned detached and stopped via its real process group, not just the tracked PID |
| POST `/api/ports/kill` | `{port}` | stop whatever's on that port — routed through the real container stop path if it belongs to a known container-backed worktree (a raw SIGTERM to a container-published port would hit the engine's port-forwarding helper, not the dev server), otherwise a plain SIGTERM to the PID (bare processes, and unregistered/orphaned ports — `setu prune`'s case) |
| GET `/api/pr-review/status?repo=&name=` | — | pr-walkthrough plugin install status (scope-checked against this worktree), current deep-review run state, and artifact info (findings count, staleness vs. current HEAD) for `pr-walkthrough`/`pr-brief` if either has been run against this PR |
| POST `/api/pr-review/run` | `{repo, name, skill}` | fire-and-forget: headlessly invokes the installed `pr-walkthrough`/`pr-brief` Claude Code plugin (`skill` must be one of those two) against this worktree's PR via `claude -p`, single-flight per worktree (both skills share one slot and one log). See `pr-review.js` for the invocation/security model |
| GET `/api/pr-review/artifact?repo=&name=&skill=` | — | serves the most recent run's self-contained report HTML directly |
| POST `/api/pr/create` | `{repo, name}` | push the branch and open a GitHub PR (`gh pr create --fill`) — fails clearly if there's no GitHub remote, no commits ahead of base, or a PR already exists |
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

## Action log

Every mutating `POST /api/*` request appends one JSON line to `~/workspace/logs/actions.log`
(retention checks every five seconds; logs above 5 MB retain their latest 2.5 MB): `{ts, route, repo, name, ok,
error?}`. GET routes aren't logged (reads, not actions — the list/status polls alone run at
800ms-3s intervals and would drown out everything else). Built specifically to close a real
gap: a prior incident (a worktree silently switched from bare to a container mid-use) took
correlating three separate external log sources by hand to root-cause, because portal.js
logged nothing about its own requests anywhere retrievable. **`/mcp` is deliberately excluded**
— it's a JSON-RPC envelope (repo/name live under `params.arguments`, not top-level) and a
stateless response can be SSE-framed rather than plain JSON, so blindly extending the same
wrapper would silently mis-log every MCP-driven action as successful regardless of its real
outcome. An MCP-driven `create_worktree`/`remove_worktree`/etc. call today leaves no trace in
this log — real, tracked gap, not yet solved.

## MCP server (localhost:2999/mcp) — let an agent drive Setu directly

Same portal, same backend functions, a fourth front door (web UI / CLI / Raycast / MCP, in
that order of age) — `mcp-server.js`'s 15 tools (`list_worktrees`, `create_worktree`,
`start_worktree`, `stop_worktree`, `sync_worktree`, `remove_worktree`, `get_diff`, `get_logs`,
`list_ports`, `list_projects`, `list_repo_prs`, `get_pr_review_status`, `run_pr_review`,
`create_pr`, `pr_ready`) call straight into portal.js's own functions in-process, not over
HTTP — no self-fetch loopback. Streamable HTTP, stateless (fresh `McpServer` per request),
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
start/stop) now go through async siblings (`activePidAsync`/`listActivePortsAsync`/
`killGroupAsync`/`gitFetchAsync` in lib.js, `Bun.spawn`-based) instead of
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
since this is local Setu tooling, not a project concern; each newly `addProject`-registered
repo needs this added by hand once, it isn't automated). Source bind-mounts from the host;
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

**Concurrency**: `worktree-lifecycle.js` owns admission, FIFO queueing, Stop and restart.
Bare and container processes share `maxConcurrentDevServers`. Restart preserves its
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

- Every container Setu itself stops goes through `composeDownAsync` (`stopContainer`/`removeWorktree` in portal.js), which `docker compose down`s — that *removes* the container entirely. So a compose-project container still *present* in `docker ps -a` but not `running`/`restarting` can only have gotten that way some other way: an OOM kill, a dev process that crash-looped past its `restart: on-failure` retry cap, or the container engine's own VM restarting and taking every container down with it (confirmed live: an OrbStack restart SIGKILLed a container mid-boot with nothing surfacing it — `reconcileDevServers` only adopts still-alive containers at portal boot, it never flags ones that died). `setu doctor`'s dead-container check (`composeProjectStates` in cli.js) exists for exactly this — one `docker ps -a` call bucketed by the `com.docker.compose.project` label, zero false positives by construction since Setu's own teardown never leaves a container in this state.
- `mise.toml` pins this repo's own `bun` version (`mise trust` once per clone to activate). Unrelated to `createWorktree`'s own `mise trust ...` call, which best-effort-trusts a *managed project's* own mise config on worktree creation — that's a different repo's config, not this one's. `setu doctor` reports whether `mise` itself is installed (optional, not a hard `setu setup` dependency).
- `cmdSetup` (`cli.js`) installing Homebrew itself, when missing, exits after the install and asks the user to re-run the exact same command rather than continuing in-process. Not laziness: `BREW_PREFIX`/`CADDY_BIN`/`CLOUDFLARED_BIN` (`lib.js`) are computed once at module load, before `cmdSetup` runs — with brew missing at that point they're already frozen to a fallback (wrong on Intel Macs, merely unverified on Apple Silicon) that a mid-process `PATH` patch can't fix, since they're already-evaluated constants, not lazy lookups. A fresh process re-evaluates them correctly.
- New branches fork from `origin/staging`.
- `importRepo` (`lib.js`, `writeSetuAgentMarkers`) writes `.setu.json` + a `## Managed by Setu` AGENTS.md section into a brand-new project's `main` worktree — so an agent working in a *managed* project (quivly-app, etc.) knows Setu owns its dev servers/worktrees, without having to already know Setu exists. Project-level only (repo name, portal URL, CLI reference, install one-liner) — never a specific worktree's port/domain, since these files are meant to be committed once to the project's default branch and inherited by every future worktree via git; baking in one worktree's assigned port would be stale for the next. Non-destructive to an existing AGENTS.md (appends, idempotent — checks for the marker heading before writing again) and never auto-committed, only `git add`-staged: committing into a project this tool doesn't own is the user's call. Only runs on first registration (`setu init`/sweep `--import`), not on every subsequent `setu new` — once committed, later worktrees inherit the files via normal git checkout.
  - Don't confuse this with `~/.setu-costs.json` (`COSTS_CFG_PATH` in `lib.js`) below — same filename stem, opposite everything else: that one lives in `$HOME` (not a managed project's repo), is never written by this tool at all (the user hand-writes it), and is never committed anywhere.
- `~/.setu-costs.json` (`COSTS_CFG_PATH`/`loadCostsConfig` in `lib.js`, consumed by `costs.js`) holds `anthropicAdminKey`/`openaiAdminKey` for the portal's `/api/costs` page — org-admin-scope credentials, a materially bigger blast radius than the rest of `~/.setu.json`, so they get their own file rather than a section of it. Read-only from this tool's side: nothing in `lib.js`/`portal.js` ever writes to it, and no route ever echoes its values back (the local portal never returns provider keys). The user writes it by hand. Either key falls back to `$ANTHROPIC_ADMIN_KEY`/`$OPENAI_ADMIN_KEY` if absent from the file — still same-machine/already-trusted, not a new input surface, since nothing ever reads a credential from the request itself. Optional `"budgets": {"daily": N, "weekly": N, "monthly": N}` (USD, any subset) drives the Costs page's budget bar — combined spend across whichever providers are actually configured, compared against each configured threshold; an unset period is simply omitted from `/api/costs`'s response, not defaulted.
  ```json
  {
    "anthropicAdminKey": "sk-ant-admin01-...",
    "openaiAdminKey": "sk-admin-...",
    "budgets": { "daily": 20, "weekly": 100, "monthly": 300 }
  }
  ```
- `.env.local` is symlinked from the repo's `main` worktree (for `quivly-app`: `apps/quivly-app/.env.local`).
- The non-tunnel `.envrc` (`NEXT_PUBLIC_APP_BASE_URL`/`NEXT_PUBLIC_WORKOS_REDIRECT_URI`) both point at the worktree's own `<branch>.quivly.local` domain, not `localhost` — if you ever see a `localhost:<port>` redirect after login, that's an env mismatch, not a Caddy problem (verified: Caddy always forwards the correct `Host`/`X-Forwarded-Host`).
- Ports registry: `$WORKSPACE/.ports` (`repo/branch:port`); projects: `$WORKSPACE/.projects` (`name:base:slug:label`).
- Sidecars registry (optional): `$WORKSPACE/sidecars.json` — `{ [repo]: [{name, enabled, command, args, env}] }`, Procfile-shaped. Loaded by the portal and spawned/stopped alongside the worktree's dev server. Not for Inngest/Trigger — those stay first-class endpoints; this is for anything else a project needs (a plain `cloudflared` tunnel, a queue worker, etc.).
- Concurrency: `maxConcurrentDevServers` in `~/.setu.json` (default 3) caps how many dev servers the portal will run at once; anything beyond that queues via `/api/start`'s `queued`/`position` response. Applies identically to bare and containerized worktrees — they share one cap. See "Container mode" above for the same-worktree-restart edge case this cap has to account for.
- Container mode: see the dedicated section above — it's the default now, not an opt-in aside.
- AI coding CLI registry: `AGENT_CLIS` in `lib.js` (tool-id → binary name), detected live via `which` — not a fixed list. Add a new tool by adding one entry there; no other file needs to change.
- Logs: `$WORKSPACE/logs/<repo>/<branch>/{dev,setup,inngest,trigger,sidecar-<name>,pr-review}.log`.
- PR review (`pr-review.js`): Tier 1 is the existing "Local diff" section (`computeDiff`/`/api/diff`) — a worktree-branch-vs-base diff, not the actual GitHub PR diff, labeled accordingly. Tier 2 shells out to the installed `pr-walkthrough`/`pr-brief` Claude Code plugin headlessly (`claude -p`, `--permission-mode acceptEdits`, `--tools` dropping `Edit`, `--disallowedTools` denying GH/git write-shaped Bash commands as the primary guard — verified empirically, not assumed, see the plugin-marketplace plan). Reads `~/.local/share/pr-walkthrough/{reviews,briefs}/<owner>/<repo>/pr-<N>/latest.json` + that snapshot's `manifest.json` for status/artifacts, never the multi-MB `guide.json`/`brief.json` directly.

## Verification and polling

Run `bun run verify` after changing lifecycle, resource, access, or cost behavior. It runs
the regression checks and type checks the Preact portal and React Raycast extension separately.
`bun run check` retains the broader Ultracite style audit.

Dirty counts are asynchronous metadata (`number | null`), refreshed at most once per 15 seconds
with four Git checks in flight. `null` means unknown. Removal always runs a fresh Git status.
Warm listener and branch reads return cached data during refresh. Preserve lsof output on exit 1:
multiple port selectors can print valid listeners and still return a nonzero status.
