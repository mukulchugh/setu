# setu — agent reference

Setu manages Quivly dev worktrees: bare repos in `$WORKSPACE/<repo>.git`, worktrees at
`$WORKSPACE/<repo>/<branch>`, one auto-assigned port + `*.quivly.local` domain each, and a
single shared Cloudflare tunnel URL (`dev-<name>.getquivly.ai`) that one worktree owns at a time.

**Debugging anything setu-related? Start with `setu doctor --json`.** It checks every layer
(brew deps, dnsmasq, resolver, caddy, sudoers, cloudflared, git sync, worktree-registry
hygiene, container runtime reachability, container memory budget vs. engine capacity, portal)
and returns `[{name, ok, fix}]`. Exit code 0 = all healthy. Checks run concurrently, not
sequentially — don't assume output order reflects check duration.

## CLI (machine-friendly)

```
setu setup --name <you> [--workspace ~/workspace] [--zone getquivly.ai] --yes
                                     # non-interactive onboarding (needs sudo TTY once)
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
setu rm <repo> <branch>              # stops servers (via portal) + removes worktree/port/domain — also removes
                                      # a container-backed worktree's node_modules volume, not just its container
setu path <repo> <branch>            # prints worktree path
setu cd <repo> <branch>              # cd into worktree (shell wrapper; from scripts use: cd "$(setu path r b)")
setu init <gh-org>/<repo> [label]    # bare-clone + register + main worktree
setu tunnel <repo> <branch> [stop]   # point the shared public URL at this worktree
setu sync <repo> <branch>            # merge the resolved base branch in — clean merges only,
                                      # aborts + reports conflicts rather than leaving it mid-merge
setu trigger <repo> <branch> [stop]  # trigger.dev dev server per worktree — delegates to the portal
                                      # (/api/trigger/start|stop) when one is running, falls back to a
                                      # standalone detached process (own PID file) only when it isn't
setu mcp install <codex|cursor>      # register the portal's MCP server (see below) in that
                                      # client's own config — idempotent, preserves existing config
setu update                          # stash-safe git pull + bun link + portal restart
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
| POST `/api/remove` | `{repo, name}` | stop + remove worktree |
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

All POSTs return `{ok: boolean, error?: string, ...}`. A `queued: true` response means the
action was accepted but not yet performed — poll `/api/worktrees` and check `active`, not
just `ok`, to know if a dev server is actually running.

## MCP server (localhost:2999/mcp) — let an agent drive Setu directly

Same portal, same backend functions, a fourth front door (web UI / CLI / Raycast / MCP, in
that order of age) — `mcp-server.js`'s tools (`list_worktrees`, `create_worktree`,
`start_worktree`, `stop_worktree`, `sync_worktree`, `remove_worktree`, `get_diff`, `get_logs`,
`list_ports`, `list_projects`, `list_repo_prs`, `get_pr_review_status`, `run_pr_review`) call straight into
portal.js's own functions in-process, not over HTTP — no self-fetch loopback. Streamable
HTTP, stateless (fresh `McpServer` per request), DNS-rebinding protection on, no CORS.

Register it with whatever's connecting:
- **Claude Code**: `claude --plugin-dir <setu>/claude-plugin` (a real packaged plugin — `.mcp.json` at its root, not inside `.claude-plugin/`).
- **Codex**: `setu mcp install codex` — appends `[mcp_servers.setu]` to `~/.codex/config.toml`.
- **Cursor**: `setu mcp install cursor` — merges `mcpServers.setu` into `~/.cursor/mcp.json`.
- **Anything else with an MCP client**: point it at `http://localhost:2999/mcp` (Streamable HTTP, no auth) in whatever config format it expects — no per-client code needed, it's a standard MCP server.

The portal must already be running when the client starts — no retry-on-demand if `/mcp` is
unreachable at session start. Known open risk, not yet fixed: `create_worktree`/
`remove_worktree`/`start_worktree`/`stop_worktree` route through synchronous
`execFileSync`/`spawnSync` calls (`git()`, `activePid()`, `listActivePorts()`, `killGroup()`
in lib.js) that can stall the whole single-threaded portal under contention — same failure
class `fetchPR` hit and fixed once already, not yet converted at these sites.

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
both keep real historical evidence portal.js itself doesn't log anywhere retrievable.

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

**Resource limits**: `containerMemoryLimit`/`containerCpuLimit` in `~/.setu.json` (defaults
`4g`/`2`) are auto-clamped (`engineCapacity()`, `lib.js`) against `docker info`'s actual
`NCPU`/`MemTotal` — never trust the configured value blindly, a container asking for more
than the engine's own VM has gets rejected outright, not silently capped by Docker itself.
`setu doctor` separately checks that `maxConcurrentDevServers × containerMemoryLimit` fits
under the engine's total memory — the aggregate case `engineCapacity()`'s per-container clamp
doesn't cover (each container individually valid, but three of them jointly overcommitting).

**Compose project names are a hash of the exact `repo/name` registry key, not just a
sanitized slug** (`composeProjectName()`, `lib.js`) — a lossy slug alone let two different,
valid branch names (`feat/ab` and `feat-ab`, both mapping `/`→`-`) collide onto the same
project name, causing the second `up` to silently recreate (destroy) the first worktree's
container while the tracking layer kept reporting the first as running. Don't revert to a
plain slug without re-solving this.

**Concurrency**: dev servers share one cap (`maxConcurrentDevServers`) regardless of bare vs.
container. `stopWorktree(repo, name, port, { drain: false })` exists specifically for a
caller that stops a worktree only to immediately respawn the *same* one (the memory-ceiling
restart path, tunnel enable/disable) — letting the default `drainQueue()` run in that gap
used to let a queued worktree fill the freed slot right before the original was added back on
top, silently exceeding the cap. Tunnel enable/disable also now resume a worktree in whatever
mode it was actually running in (`respawnAsBefore()`) — it used to always resume bare, which
silently stripped a containerized worktree's resource cap on every tunnel toggle.

**Crash-loop / liveness**: `restart: on-failure:3` lets Docker's own OOM-kill+retry handle a
container hitting its memory ceiling, capped so a limit that's genuinely too low doesn't
crash-loop forever. `checkMemoryCeilings()`'s 60s interval separately notices a container
that exhausted its retries and permanently gave up — nothing else does, since
`docker compose up -d` itself exits successfully long before a crash-loop plays out, so the
slot would otherwise stay occupied indefinitely. This requires **two consecutive** "not
alive" readings (`deadContainerStrikes` in `portal.js`) before freeing the slot, not one — a
single miss can be a transient window during a legitimate respawn (e.g. a tunnel toggle),
not a genuinely dead container; freeing the slot on one miss risked losing tracking of a
worktree that was actually fine a moment later.

**`setu rm` on a container-backed worktree** also removes its `node_modules` volume (`down -v`,
not just `down`) — a normal stop deliberately keeps the volume so the next start skips
reinstalling, but there's no "next start" coming after a removal, so without this the volume
would leak forever with nothing left pointing at it.

## Conventions

- New branches fork from `origin/staging`.
- `.env.local` is symlinked from the repo's `main` worktree (for `quivly-app`: `apps/quivly-app/.env.local`).
- The non-tunnel `.envrc` (`NEXT_PUBLIC_APP_BASE_URL`/`NEXT_PUBLIC_WORKOS_REDIRECT_URI`) both point at the worktree's own `<branch>.quivly.local` domain, not `localhost` — if you ever see a `localhost:<port>` redirect after login, that's an env mismatch, not a Caddy problem (verified: Caddy always forwards the correct `Host`/`X-Forwarded-Host`).
- Ports registry: `$WORKSPACE/.ports` (`repo/branch:port`); projects: `$WORKSPACE/.projects` (`name:base:slug:label`).
- Sidecars registry (optional): `$WORKSPACE/sidecars.json` — `{ [repo]: [{name, enabled, command, args, env}] }`, Procfile-shaped. Loaded by the portal and spawned/stopped alongside the worktree's dev server. Not for Inngest/Trigger — those stay first-class endpoints; this is for anything else a project needs (a plain `cloudflared` tunnel, a queue worker, etc.).
- Concurrency: `maxConcurrentDevServers` in `~/.setu.json` (default 3) caps how many dev servers the portal will run at once; anything beyond that queues via `/api/start`'s `queued`/`position` response. Applies identically to bare and containerized worktrees — they share one cap. See "Container mode" above for the same-worktree-restart edge case this cap has to account for.
- Container mode: see the dedicated section above — it's the default now, not an opt-in aside.
- AI coding CLI registry: `AGENT_CLIS` in `lib.js` (tool-id → binary name), detected live via `which` — not a fixed list. Add a new tool by adding one entry there; no other file needs to change.
- Logs: `$WORKSPACE/logs/<repo>/<branch>/{dev,setup,inngest,trigger,sidecar-<name>,pr-review}.log`.
- PR review (`pr-review.js`): Tier 1 is the existing "Local diff" section (`computeDiff`/`/api/diff`) — a worktree-branch-vs-base diff, not the actual GitHub PR diff, labeled accordingly. Tier 2 shells out to the installed `pr-walkthrough`/`pr-brief` Claude Code plugin headlessly (`claude -p`, `--permission-mode acceptEdits`, `--tools` dropping `Edit`, `--disallowedTools` denying GH/git write-shaped Bash commands as the primary guard — verified empirically, not assumed, see the plugin-marketplace plan). Reads `~/.local/share/pr-walkthrough/{reviews,briefs}/<owner>/<repo>/pr-<N>/latest.json` + that snapshot's `manifest.json` for status/artifacts, never the multi-MB `guide.json`/`brief.json` directly.
