# setu — agent reference

Setu manages Quivly dev worktrees: bare repos in `$WORKSPACE/<repo>.git`, worktrees at
`$WORKSPACE/<repo>/<branch>`, one auto-assigned port + `*.quivly.local` domain each, and a
single shared Cloudflare tunnel URL (`dev-<name>.getquivly.ai`) that one worktree owns at a time.

**Debugging anything setu-related? Start with `setu doctor --json`.** It checks every layer
(brew deps, dnsmasq, resolver, caddy, sudoers, cloudflared, git sync, worktree-registry
hygiene, portal) and returns `[{name, ok, fix}]`. Exit code 0 = all healthy. Checks run
concurrently, not sequentially — don't assume output order reflects check duration.

## CLI (machine-friendly)

```
setu setup --name <you> [--workspace ~/workspace] [--zone getquivly.ai] --yes
                                     # non-interactive onboarding (needs sudo TTY once)
setu doctor --json                   # layer-by-layer health, exit 1 if any check fails
setu ls [repo] --json                # [{key, repo, name, port, running, wtDir, localDomain, tunnel}]
setu new <repo> <branch> [--tunnel] [--start] --json
                                      # {wtDir, port, localDom, pubDom, started} — creates branch from origin/staging if new
setu start <repo> <branch>           # start dev server via the portal — queues if MAX_CONCURRENT_DEV is already reached
setu stop <repo> <branch>            # stop dev server via the portal, or cancel it if still queued
setu prune [--force]                 # list (or, with --force, kill) dev-server processes listening on a port
                                      # not in the .ports registry — the "running but invisible to setu" case
setu rm <repo> <branch>              # stops servers (via portal) + removes worktree/port/domain
setu path <repo> <branch>            # prints worktree path
setu cd <repo> <branch>              # cd into worktree (shell wrapper; from scripts use: cd "$(setu path r b)")
setu init <gh-org>/<repo> [label]    # bare-clone + register + main worktree
setu tunnel <repo> <branch> [stop]   # point the shared public URL at this worktree
setu trigger <repo> <branch> [stop]  # trigger.dev dev server per worktree — delegates to the portal
                                      # (/api/trigger/start|stop) when one is running, falls back to a
                                      # standalone detached process (own PID file) only when it isn't
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
| GET `/api/logs?repo=&name=&type=dev\|setup\|inngest\|trigger\|sidecar-<name>\|tunnel` | — | tail of that log |
| POST `/api/create` | `{repo, name, tunnel?}` | create worktree (bun install runs in background — poll the `setup` log) |
| POST `/api/remove` | `{repo, name}` | stop + remove worktree |
| POST `/api/start` | `{repo, name, container?}` | start dev server — **containerized by default** now (`container !== false`), bare only if the caller explicitly passes `container: false` (requires a reachable Docker-API-compatible daemon, any engine — fails with an explicit error rather than silently falling back to bare if none is reachable). Returns `{ok:true}` if actually started, or `{ok:true, queued:true, position:N}` if the concurrent-server cap (`maxConcurrentDevServers`, default 3) is already reached; auto-starts sidecars from `sidecars.json` alongside it |
| POST `/api/stop` | `{repo, name}` | stop dev server (or dequeue it if still queued) — also stops its sidecars |
| POST `/api/open` | `{repo, name, tool}` | open the worktree in an installed agent CLI (Ghostty) — `tool` must be one of `/api/agents`' returned ids |
| POST `/api/tunnel/enable` / `/api/tunnel/disable` | `{repo, name}` | move/release the shared public URL |
| POST `/api/inngest/start` / `/api/inngest/stop` | `{repo, name}` | inngest dev server |
| POST `/api/trigger/start` / `/api/trigger/stop` | `{repo, name}` | trigger.dev dev server (version pinned to the worktree's @trigger.dev/sdk); spawned detached and stopped via its real process group, not just the tracked PID |
| POST `/api/ports/kill` | `{port}` | SIGTERM whatever listens there |

All POSTs return `{ok: boolean, error?: string, ...}`. A `queued: true` response means the
action was accepted but not yet performed — poll `/api/worktrees` and check `active`, not
just `ok`, to know if a dev server is actually running.

## Conventions

- New branches fork from `origin/staging`.
- `.env.local` is symlinked from the repo's `main` worktree (for `quivly-app`: `apps/quivly-app/.env.local`).
- The non-tunnel `.envrc` (`NEXT_PUBLIC_APP_BASE_URL`/`NEXT_PUBLIC_WORKOS_REDIRECT_URI`) both point at the worktree's own `<branch>.quivly.local` domain, not `localhost` — if you ever see a `localhost:<port>` redirect after login, that's an env mismatch, not a Caddy problem (verified: Caddy always forwards the correct `Host`/`X-Forwarded-Host`).
- Ports registry: `$WORKSPACE/.ports` (`repo/branch:port`); projects: `$WORKSPACE/.projects` (`name:base:slug:label`).
- Sidecars registry (optional): `$WORKSPACE/sidecars.json` — `{ [repo]: [{name, enabled, command, args, env}] }`, Procfile-shaped. Loaded by the portal and spawned/stopped alongside the worktree's dev server. Not for Inngest/Trigger — those stay first-class endpoints; this is for anything else a project needs (a plain `cloudflared` tunnel, a queue worker, etc.).
- Concurrency: `maxConcurrentDevServers` in `~/.setu.json` (default 3) caps how many dev servers the portal will run at once; anything beyond that queues via `/api/start`'s `queued`/`position` response. Applies identically to bare and containerized worktrees — they share one cap.
- Container mode (**the default** as of 2026-08-10 — `setu start`/`setu new --start` use it unless `--bare` is passed; `POST /api/start` unless the caller sends `container: false`): generates `<worktree>/docker-compose.setu.yml` (`writeDockerCompose()` in `lib.js`, gitignored via the bare repo's `.git/info/exclude`, not the tracked `.gitignore` — it's local Setu tooling, not a project concern). Source bind-mounts from the host; `node_modules` is a container-local named volume, NOT a host bind-mount (host installs macOS-native binaries — `@next/swc-darwin-arm64` etc. — that can't run in the Linux container; proven live). `containerMemoryLimit`/`containerCpuLimit` in `~/.setu.json` (defaults `4g`/`2`) are auto-clamped against `docker info`'s actual `NCPU`/`MemTotal` — trusting the configured value blindly can ask for more than the engine's own VM has (proven live: a 1-CPU OrbStack VM rejected a `cpus: 2` request outright). Caddy's `reverse_proxy` target is unchanged — always `localhost:<port>` — so nothing about routing branches on bare vs. container. `restart: on-failure:3` lets Docker's own OOM-kill+retry handle a memory ceiling being hit, capped so a genuinely-too-low limit doesn't crash-loop forever; `checkMemoryCeilings()`'s 60s interval separately notices a container that exhausted its retries and frees its concurrency slot (nothing else does — `docker compose up -d` itself exits successfully long before a crash-loop plays out). Engine-agnostic by design: only plain Docker Engine API calls throughout (`docker info`, `docker compose`, `mem_limit`/`cpus` — NOT `deploy.resources.limits`, which is swarm-only and silently ignored by plain `docker compose up`) — works with OrbStack, Docker Desktop, or Colima, not hardcoded to one engine.
- AI coding CLI registry: `AGENT_CLIS` in `lib.js` (tool-id → binary name), detected live via `which` — not a fixed list. Add a new tool by adding one entry there; no other file needs to change.
- Logs: `$WORKSPACE/logs/<repo>/<branch>/{dev,setup,inngest,trigger,sidecar-<name>}.log`.
