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

### Custom URLs

Give any run, branches included, an extra hostname:

```bash
setu alias my-feature demo.example.test    # <run> is project/run, a run name, or . for this worktree
setu alias ls [run]                        # extra URLs (config and custom); `setu ls` shows +N
setu alias rm my-feature demo.example.test
```

It routes like the main URL (on-demand start, websockets, status pages). Names must be unique across all runs and projects. Names outside a project `domain`, `localhost` or an installed resolver are accepted with a warning that nothing resolves them yet: add the domain as a project `domain` or run `setu setup` (`.test` is better than `.local`). Custom URLs are stored with the run, survive restarts, and are dropped by `setu rm`/`forget`; `setu restore` does not bring them back. `{url}` in env stays the main URL, so an app that checks allowed origins may need the alias added.

## What it does

| | |
|---|---|
| **Runs** | Each worktree gets its own ports and URL. A built-in proxy serves port 80 on IPv4 and IPv6, with websockets, so hot reload works. It starts a worktree on demand and stops it when idle. Dev servers keep running across daemon restarts and upgrades. |
| **Any stack** | Stack knowledge lives in data presets: Next, Vite, Bun, pnpm, npm, uv, Mix, Bundler, Cargo, Go. Missing dependencies are installed from the lockfile on start. |
| **Env** | Global, project and worktree layers. Secrets are stored separately, shown masked, and redacted from logs. Agents never see their values. |
| **Disk** | `setu disk` shows what each worktree really costs, counting APFS clones correctly. `setu disk clean` removes only declared, rebuildable output from stopped worktrees. |
| **Worktrees** | `new`, `adopt`, `rm` and `restore`. Removal archives ignored files and keeps the branch. Agents take writer claims on a worktree. Optional auto-removal applies to merged worktrees only. |
| **Agents** | `setu mcp` is a stdio MCP server with 23 tools for runs, aliases, logs, env, disk and worktrees. |
| **App** | Setu.app: Runs, Environments, Disk and Config, in the menu bar or a window. |

## Commands

```
setu ls | up | down | restart | logs [-f] | path | cd
setu new | adopt | rm | restore | forget | claim | release | claims | alias
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

Releases are built on a Mac, with no CI: `scripts/release.sh <version>` tests and builds both Mac binaries and the Homebrew formula; add `--publish` to tag, create the GitHub release and update the tap.

Design notes, plans and the evidence behind each part are in [docs/slices/](docs/slices/).

The last JavaScript version is tagged [`v1-final`](../../tree/v1-final).

## License

MIT. See [LICENSE](LICENSE).
