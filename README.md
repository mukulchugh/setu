# setu

Workspace bridge for Quivly engineers — git worktrees, local `.quivly.local` domains, and Cloudflare tunnels.

## Install

Requires `gh` (authenticated) and `bun`.

```bash
cd ~ && gh repo clone quivly/setu ~/.setu && cd ~/.setu && bun link && setu setup
```

## Update

```bash
setu update
```

## Commands

```
setu setup                        First-time onboarding

setu init  quivly/quivly-app      Clone repo + create main worktree
setu new   <repo> <branch>        Create worktree (auto port + local domain)
setu new   <repo> <branch> --tunnel   ...with Cloudflare public URL
setu rm    <repo> <branch>        Remove worktree

wt         <repo> <branch>        cd into worktree
setu ls    [repo]                 List worktrees + running state
setu status                       Same as ls
setu fetch <repo>                 git fetch --all
setu tunnel <repo> <branch>       Enable public tunnel on existing worktree

setu portal                       Start web UI at http://quivly.local
setu portal stop                  Stop portal
```

## How it works

- Each worktree gets an auto-assigned port and a `<branch>.quivly.local` domain via Caddy
- A single shared Cloudflare tunnel (`dev-<name>.getquivly.ai`) handles public URLs
- Config lives at `~/.setu.json`
- Portal at `http://quivly.local` shows all worktrees, ports, tunnel state
