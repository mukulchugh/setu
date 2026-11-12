<p align="center"><img src="brand/icon/setu-icon-1024.png" width="128" alt="Setu"></p>

# Setu

Run every git worktree's app and its workers side by side, each at its own local URL. No Docker, no Cloudflare, no sudo.

```
http://my-feature.example.local   ->  my-feature's Next.js, Trigger worker and Inngest, on their own ports
http://main.example.local         ->  main, running at the same time
```

Open a worktree's URL and Setu starts it. It reinstalls dependencies first if they are missing, and stops the worktree again when idle. One small daemon does the routing, process supervision, env and disk bookkeeping. A native macOS app (SwiftUI) and an MCP server for AI agents sit on top of it.

## Install

```bash
brew install mukulchugh/tap/setu
setu setup        # installs the login service, captures your shell PATH, checks DNS
setu doctor       # everything green?
```

Coming from the old JavaScript Setu (`~/.setu`, the web portal on :2999)? Run `setu migrate`. It shows a read-only plan first, and `setu migrate rollback` undoes everything. See [docs/MIGRATING.md](docs/MIGRATING.md).

## Quick start

Describe a project once in `~/.config/setu/projects/<name>.toml`:

```toml
project = "myapp"
repo    = "~/workspace/myapp.git"     # a bare repo; worktrees live in ~/workspace/myapp/<branch>
domain  = "example.local"             # *.localhost works with no DNS setup at all

[env]
NEXT_PUBLIC_APP_BASE_URL = "{url}"

[procs.web]
run  = "bun dev"                      # anything that listens on $PORT
port = "web"

[procs.trigger]                       # optional workers run next to the app
run = "setu x trigger-dev --env-file .env.local"
```

Then:

```bash
setu new myapp my-feature     # new worktree off the base branch, deps installed, env linked
open http://my-feature.example.local
setu ls                       # every run: status, real memory, URL
```

Already have worktrees? `setu adopt <path>` registers one without touching it.

## What it does

| | |
|---|---|
| **Runs** | Each worktree gets its own ports and URL. A built-in proxy serves port 80 on IPv4 and IPv6, with websockets, so hot reload works. It starts a worktree on demand and stops it when idle. Dev servers keep running across daemon restarts and upgrades. |
| **Any stack** | Stack knowledge lives in data presets: Next, Vite, Bun, pnpm, npm, uv, Mix, Bundler, Cargo, Go. Missing dependencies are installed from the lockfile on start. |
| **Env** | Global, project and worktree layers. Secrets are stored separately, shown masked, and redacted from logs. Agents never see their values. |
| **Disk** | `setu disk` shows what each worktree really costs, counting APFS clones correctly. `setu disk clean` removes only declared, rebuildable output from stopped worktrees. |
| **Worktrees** | `new`, `adopt`, `rm` and `restore`. Removal archives ignored files and keeps the branch. Agents take writer claims on a worktree. Optional auto-removal applies to merged worktrees only. |
| **Agents** | `setu mcp` is a stdio MCP server with 20 tools for runs, logs, env, disk and worktrees. |
| **App** | Setu.app: Runs, Environments, Disk and Config, in the menu bar or a window. |

## Commands

```
setu ls | up | down | restart | logs [-f] | path | cd
setu new | adopt | rm | restore | forget | claim | release | claims
setu env set | unset | list | import | effective
setu disk [clean]
setu setup | doctor | migrate | history | mcp
```

`setu help` lists everything.

## Build from source

```bash
cargo build --release          # binary at target/release/setu
cargo test                     # unit and integration tests
crates/setu/e2e/*-e2e.sh target/debug/setu   # end-to-end, each in its own sandbox
scripts/bundle-swift.sh        # builds target-swift/Setu.app (macOS 26, Swift 6.2)
```

Design notes, plans and the evidence behind each part are in [docs/slices/](docs/slices/).

The last JavaScript version is tagged [`v1-final`](../../tree/v1-final).

## License

MIT. See [LICENSE](LICENSE).
