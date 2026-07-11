# setu

![setu](./banner.webp)

Workspace bridge for Quivly engineers — git worktrees, local `.quivly.local` domains, and a shared Cloudflare tunnel.

## Install

Requires `gh` (authenticated) and `bun`.

```bash
curl -fsSL https://raw.githubusercontent.com/quivly/setu/main/install.sh | bash
setu setup
```

Non-interactive (agents / scripts): `setu setup --name <you> --yes`

## Update

```bash
setu update     # stash-safe pull, shows what changed, restarts the portal
```

Setu also nudges you (once a day, on stderr) when it's behind origin.

## Something broken?

```bash
setu doctor     # checks every layer — dnsmasq, caddy, sudoers, tunnel, portal — with fix commands
```

## Commands

```
setu setup [--name x --yes]       First-time onboarding
setu doctor [--json]              Layer-by-layer health check

setu init  quivly/quivly-app      Clone repo + create main worktree
setu new   <repo> <branch>        Create worktree (auto port + local domain)
setu new   <repo> <branch> --tunnel   ...and take the public URL
setu rm    <repo> <branch>        Remove worktree

wt         <repo> <branch>        cd into worktree
setu ls    [repo] [--json]        List worktrees + running state
setu fetch <repo>                 git fetch --all
setu tunnel <repo> <branch>       Point the public URL at this worktree
setu tunnel <repo> <branch> stop  Release it
setu trigger <repo> <branch>      trigger.dev dev server (background, per worktree)

setu portal                       Start web UI at http://quivly.local
setu portal stop                  Stop portal
setu update                       Update setu
setu version                      Version + commit
```

## How it works

- Each worktree gets an auto-assigned port and a `<branch>.quivly.local` domain via Caddy
- One shared Cloudflare tunnel URL (`dev-<name>.getquivly.ai`) — `setu tunnel` moves it between worktrees
- The portal (`http://quivly.local`) owns all long-running processes: dev servers, inngest, cloudflared
- Config lives at `~/.setu.json`; shared logic in `lib.js` (used by both `cli.js` and `portal.js`)
- Agents: see [AGENTS.md](./AGENTS.md) for `--json` interfaces and the portal HTTP API
