# setu — agent reference

Setu manages Quivly dev worktrees: bare repos in `$WORKSPACE/<repo>.git`, worktrees at
`$WORKSPACE/<repo>/<branch>`, one auto-assigned port + `*.quivly.local` domain each, and a
single shared Cloudflare tunnel URL (`dev-<name>.getquivly.ai`) that one worktree owns at a time.

**Debugging anything setu-related? Start with `setu doctor --json`.** It checks every layer
(brew deps, dnsmasq, resolver, caddy, sudoers, cloudflared, git sync, portal) and returns
`[{name, ok, fix}]`. Exit code 0 = all healthy.

## CLI (machine-friendly)

```
setu setup --name <you> [--workspace ~/workspace] [--zone getquivly.ai] --yes
                                     # non-interactive onboarding (needs sudo TTY once)
setu doctor --json                   # layer-by-layer health, exit 1 if any check fails
setu ls [repo] --json                # [{key, repo, name, port, running, wtDir, localDomain, tunnel}]
setu new <repo> <branch> [--tunnel] --json   # {wtDir, port, localDom, pubDom} — creates branch from origin/staging if new
setu rm <repo> <branch>              # stops servers (via portal) + removes worktree/port/domain
setu path <repo> <branch>            # prints worktree path
setu cd <repo> <branch>              # cd into worktree (shell wrapper; from scripts use: cd "$(setu path r b)")
setu init <gh-org>/<repo> [label]    # bare-clone + register + main worktree
setu tunnel <repo> <branch> [stop]   # point the shared public URL at this worktree
setu trigger <repo> <branch> [stop]  # detached trigger.dev dev server per worktree
setu update                          # stash-safe git pull + bun link + portal restart
setu version                         # version + commit sha
```

Errors go to stderr with exit code 1. `setu path` stdout is consumed by shell `cd` — never
prints anything else.

## Portal HTTP API (localhost:2999)

The portal owns all long-running processes (dev servers, inngest, the cloudflared tunnel).
Start it with `setu portal` if `GET /api/worktrees` refuses connection.

| Endpoint | Body | Effect |
|---|---|---|
| GET `/api/worktrees` | — | full worktree state incl. `active`, `tunnelOn`, `pr` |
| GET `/api/projects` | — | registered repos |
| GET `/api/ports` | — | processes listening on 3000–3999 |
| GET `/api/logs?repo=&name=&type=dev\|setup\|inngest\|trigger\|tunnel` | — | tail of that log |
| POST `/api/create` | `{repo, name, tunnel?}` | create worktree (bun install runs in background — poll the `setup` log) |
| POST `/api/remove` | `{repo, name}` | stop + remove worktree |
| POST `/api/start` / `/api/stop` | `{repo, name}` | dev server |
| POST `/api/tunnel/enable` / `/api/tunnel/disable` | `{repo, name}` | move/release the shared public URL |
| POST `/api/inngest/start` / `/api/inngest/stop` | `{repo, name}` | inngest dev server |
| POST `/api/trigger/start` / `/api/trigger/stop` | `{repo, name}` | trigger.dev dev server (version pinned to the worktree's @trigger.dev/sdk) |
| POST `/api/ports/kill` | `{port}` | SIGTERM whatever listens there |

All POSTs return `{ok: boolean, error?: string}`.

## Conventions

- New branches fork from `origin/staging`.
- `.env.local` is symlinked from the repo's `main` worktree (for `quivly-app`: `apps/quivly-app/.env.local`).
- Ports registry: `$WORKSPACE/.ports` (`repo/branch:port`); projects: `$WORKSPACE/.projects` (`name:base:slug:label`).
- Logs: `$WORKSPACE/logs/<repo>/<branch>/{dev,setup,inngest}.log`.
