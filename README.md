<p align="center"><img src="brand/icon/setu-icon-1024.png" width="128" alt="Setu"></p>

# Setu

Run every git worktree's app and its workers side by side, each at its own local URL. It runs entirely on your Mac and costs nothing: no Docker, no Cloudflare, no cloud account, no CI.

```
http://my-feature.example.test   ->  my-feature's web app, its workers, its own ports
http://bugfix.example.test       ->  another branch, running at the same time
http://myapp.example.test        ->  main
```

Open a worktree's URL and Setu starts it. If dependencies are missing, it installs them from the lockfile first. When the worktree goes idle, Setu stops it again. A single small background service does the routing, process supervision, env and disk bookkeeping. A native macOS app and an MCP server for AI agents sit on top of it.

- [Install](#install)
- [Quick start](#quick-start)
- [How it works](#how-it-works)
- [Project config reference](#project-config-reference)
- [Recipes](#recipes)
- [URLs and custom domains](#urls-and-custom-domains)
- [Env and secrets](#env-and-secrets)
- [Worktrees](#worktrees)
- [Disk](#disk)
- [Setu.app](#setuapp)
- [AI agents (MCP)](#ai-agents-mcp)
- [Command reference](#command-reference)
- [Global config](#global-config)
- [Moving from the old Setu](#moving-from-the-old-setu)
- [Troubleshooting](#troubleshooting)
- [Development](#development)

## Install

You need macOS 26 or later (Apple silicon or Intel) and [Homebrew](https://brew.sh).

```bash
brew install mukulchugh/tap/setu && setu
```

The first `setu` sets everything up without asking: it captures your shell PATH, starts the Setu service at login, installs Setu.app into `~/Applications`, and runs `setu doctor`, then prints what to do next. The only step that can need `sudo` is writing `/etc/resolver/<domain>` for a custom domain; in a terminal you get one normal password prompt, and without a terminal Setu skips it and prints the exact command.

**Upgrade** is just `brew upgrade setu`: the service notices its binary changed and restarts itself within a minute (running dev servers keep running), and Setu.app updates itself the next time it isn't open. Setu never opens or quits the app.

You can also run the steps yourself: `setu setup` shows its plan and asks first (`--dry-run` only shows it, `--yes` skips the question, `--undo` reverses it; the app is left in place, `setu app uninstall` removes it). Any command that needs the service, like `setu ls`, sets Setu up the first time or restarts the service if it is down. `setu doctor`, `setu mcp` and `setu migrate` never install anything: an AI agent that finds Setu not running is told to ask you to run `setu` once.

**Without Homebrew:**
1. Download `setu-universal-apple-darwin.tar.xz` from [Releases](../../releases). It holds one `setu` for any Mac, plus Setu.app.
2. Put `setu` on your PATH and run `setu`.
3. If you open a downloaded Setu.app directly, macOS says it "is damaged". That happens because the app is signed for local use rather than with a paid Apple Developer ID, and the browser marks the download. Clear the mark once with `xattr -dr com.apple.quarantine Setu.app`, or let `setu app` install it, which does that for you.

Homebrew installs never show this message.

## Quick start

1. **Keep repos as bare clones with worktrees next to them**, the layout Setu expects:

   ```
   ~/workspace/myapp.git/       bare repo
   ~/workspace/myapp/main/      main worktree
   ~/workspace/myapp/<branch>/  one folder per branch
   ```

2. **Describe the project once** in `~/.config/setu/projects/myapp.toml`:

   ```toml
   project = "myapp"
   repo    = "~/workspace/myapp.git"
   domain  = "example.test"            # or "localhost" for zero DNS setup
   recipes = ["next-env"]              # optional, see Recipes

   [procs.web]
   run  = "bun dev"                    # anything that listens on $PORT
   port = "web"

   [ports]
   web = {}
   ```

3. **Work:**

   ```bash
   setu new myapp feat/login          # worktree off the base branch, deps installed, env linked
   open http://feat-login.example.test
   setu ls                            # every run: status, real memory, URL
   setu logs -f                       # follow the current worktree's processes
   ```

Already have worktrees? Run `setu adopt <path>`. It registers the worktree without changing anything in it.

## How it works

- **The daemon** (`setu daemon`, started at login by the LaunchAgent `dev.setu.daemon`) is the only process that holds state. The CLI, the app and MCP all talk to it over a Unix socket.
- **Runs.** Each worktree is a run, named after its branch (slashes become dashes). It gets its own leased ports, one per name in `[ports]`, which stay with the run for its whole life.
- **The proxy** listens on port 80 (IPv4 and IPv6). It answers only requests from your own machine, and routes by hostname to the run's `web` port, websockets included, so hot reload works. If port 80 is taken, it falls back to 7777 and `setu doctor` says why.
- **On demand.** Opening the URL of a stopped run starts it. Browsers see a "Starting…" page (or "Installing dependencies…") that refreshes on its own. After `idle` minutes without requests, the run is stopped.
- **Processes** run in their own process groups. Setu proves they're its own (pid plus start time) before it ever signals them. A daemon restart or upgrade leaves dev servers running, and the next daemon adopts them.
- **State** lives in one database at `~/Library/Application Support/Setu/setu.db` (Turso). Logs are in `~/Library/Logs/Setu/<project>/<run>/<proc>.log`. Config is in `~/.config/setu/`.

## Project config reference

`~/.config/setu/projects/<project>.toml`:

```toml
project     = "myapp"                     # letters, digits, dashes
repo        = "~/workspace/myapp.git"     # the bare repo; worktrees are in ~/workspace/myapp/
domain      = "example.test"              # runs are <run>.example.test; main is myapp.example.test
aliases     = ["app.example.test"]        # extra names for the main run
recipes     = ["trigger", "inngest"]      # see Recipes
preset      = "auto"                      # stack presets: "auto", a name, or a list
idle        = "30m"                       # stop a run after this long without requests (default 30m)
max_running = 3                           # at most this many runs of this project up at once (default 3)
auto_install = true                       # reinstall missing dependencies on start (default true)

[ports]                                   # one leased port per name, per run
web = {}
worker = {}

[env]                                     # templates: see below
API_BASE = "{url}/api"
WORKER_PORT = "{port.worker}"

[procs.web]                               # the proc with port = "web" is what the URL serves
run  = "bun dev"
port = "web"

[procs.worker]
run  = "bun run worker --port {port.worker}"
cwd  = "apps/worker"                      # relative to the worktree
mise = false                              # true: run through `mise exec`

[worktree]
base     = "origin/staging"               # base for `setu new` (default: origin/staging, else the default branch)
link     = ["apps/web/.env.local"]        # symlinked from main into every worktree
copy     = ["config/local.json"]          # ignored files copied from main on `setu new`
min_free = "10GiB"                        # refuse `setu new` below this much free disk

[[setup.step]]                            # run once by `setu new`; replaces the automatic install
name = "install"
run  = "bun install --frozen-lockfile"

[[disk.item]]                             # declare rebuildable output for `setu disk`
name = "build-cache"
paths = [".cache"]
clean_after = "7d"
```

**Templates**, usable in `[env]` values, proc `run` lines and `cwd`:

| Variable | Value |
|---|---|
| `{url}` | the run's main URL, e.g. `http://feat-login.example.test` |
| `{host}`, `{domain}` | `feat-login.example.test`, `example.test` |
| `{project}`, `{run}` | `myapp`, `feat-login` |
| `{worktree}` | the worktree's absolute path |
| `{port.<name>}` | the run's leased port for that name |

Every proc also gets `PORT` (its `web` port), `SETU_PROJECT`, `SETU_RUN` and `SETU_URL`.

**Shared env files.** `[worktree] link` makes Setu symlink each listed file from `main` into every worktree. It does this on `setu new`, on adopt, and before every start, but only where the file is missing; an existing file is never replaced. This is the usual way to share one `.env.local`.

## Recipes

Setu doesn't know any tool by name. What a stack needs, such as a background worker, extra ports, or env that follows each worktree, lives in recipes: small TOML files. A project lists the ones it wants:

```toml
recipes = ["trigger", "inngest", "workos-authkit", "nx", "next-env"]
```

When Setu loads the config, it merges each recipe's `[ports]`, `[env]` and `[procs.*]` in. **Anything you write in the project config wins.** Define `[procs.trigger]` or one `[env]` key yourself, and only that piece is replaced.

Shipped recipes:

| Recipe | What it adds |
|---|---|
| `trigger` | A Trigger.dev dev worker. It uses the CLI version the worktree's `@trigger.dev/sdk` pins, and passes `--branch <run>` only where the installed SDK supports dev branches, so every worktree gets its own Trigger branch. It also adds the worktree's `.env.local`, if present. |
| `inngest` | An Inngest dev server on its own leased port, plus its connect-gateway and gRPC ports, so several worktrees can run Inngest at once. Sets `INNGEST_DEV` and `INNGEST_BASE_URL`. Needs `brew install inngest/tap/inngest`. |
| `convex` | A Convex dev process, using your package manager. |
| `workos-authkit` | `NEXT_PUBLIC_WORKOS_REDIRECT_URI = {url}/authentication/callback`, so sign-in returns to the right worktree. |
| `nx` | `NX_DAEMON = false`; Nx's shared daemon gets confused by worktrees. |
| `next-env` | `NEXT_PUBLIC_APP_BASE_URL = {url}`. |

```bash
setu recipes ls            # shipped and your own
setu recipes show trigger  # the full recipe
```

**Your own recipes** go in `~/.config/setu/recipes/<name>.toml`. A file with the same name as a shipped recipe replaces it. The format:

```toml
name = "mailpit"
description = "Local mail catcher per worktree."

[detect]                    # used by `setu import-v1` to suggest the recipe
any_of = [{ dependency = "nodemailer" }, { file = "mailpit.yml" }, { dir = "mail" }]

[ports]
mail_ui = {}
mail_smtp = {}

[env]
SMTP_URL = "smtp://127.0.0.1:{port.mail_smtp}"

[procs.mail]
run = "mailpit --listen 127.0.0.1:{port.mail_ui} --smtp 127.0.0.1:{port.mail_smtp}"
```

Recipes can also use `{dir}` (where detection matched), `{app_dir}` (`apps/<project>` if that folder exists, else `.`), `{pm}` and `{pm_exec}` (`bunx`, `pnpm exec`, `yarn` or `npx`, from the lockfile).

## URLs and custom domains

- **Main URL.** Every run gets `http://<run>.<domain>`, and the main run gets `http://<project>.<domain>`. Port 80 means there's no port number in the URL.
- **Which domain:**
  - `localhost`: works with no setup at all.
  - `.test`: reserved for exactly this. `setu setup` points it at Setu's built-in DNS server with one resolver file.
  - `.local`: works, but macOS also uses `.local` for local-network discovery, so prefer `.test` for new projects.
- **Extra names for the main run:** the project's `aliases`.
- **Custom URLs for any run, branches included:**

  ```bash
  setu alias feat-login demo.example.test   # <run> is project/run, a run name, or . for this worktree
  setu alias ls [run]                       # `setu ls` shows +N after the URL
  setu alias rm feat-login demo.example.test
  ```

  A custom URL routes exactly like the main one. It must be unique across all runs and projects. It's kept across restarts and dropped by `setu rm`; `setu restore` doesn't bring it back. `{url}` in env stays the main URL, so an app that checks allowed origins may need the alias added there.

## Env and secrets

Env comes in layers. Later layers win:

1. **Global:** `setu env set global NAME=value`
2. **Project config `[env]`,** with recipes merged in
3. **Project:** `setu env set project myapp NAME=value`
4. **Worktree:** `setu env set worktree myapp/feat-login NAME=value`
5. **Computed:** `PORT`, `SETU_*`

```bash
setu env effective feat-login                      # every var a run gets, and which layer it came from
setu env set project myapp STRIPE_KEY --secret     # prompts; the value is never echoed
setu env import project myapp .env.example --preview
setu env reveal project myapp STRIPE_KEY           # prints one value; audited
```

- **Secrets** are stored in separate `0600` files, shown masked, and redacted from logs.
- **They never reach** the database, MCP replies or error messages.
- **Change detection:** a running worktree whose env changed shows as stale in `setu ls` until it's restarted.

## Worktrees

```bash
setu new myapp feat/login [--from origin/main] [--start]
setu adopt ~/workspace/myapp/feat-login
setu cd myapp feat/login            # needs the shell function below
setu rm feat-login                  # stop, check, archive ignored files, remove; the branch is kept
setu restore feat-login             # bring it back, archived files included
setu forget feat-login              # unregister only; files untouched
```

- **What `setu rm` checks before deleting:** it refuses if the worktree has uncommitted or untracked changes, unpushed commits (unless proven merged), a live process inside it, or a writer claim. Ignored files that can't be rebuilt, such as local databases, are archived first in `~/.local/share/setu/archive/`.
- **Writer claims.** `setu claim <run>` tells other agents and Setu that you're editing this worktree. While it's held, removal, restart from another actor, and disk cleaning are refused. `setu release` drops it, and a claim whose process has died is considered stale.
- **Auto-removal** is off by default. Turn it on in the [global config](#global-config) and Setu removes worktrees that are proven merged, or that are clean, fully pushed and idle past `idle_after`. It waits out a grace period and removes at most `daily_cap` a day. Each candidate is shown in `setu ls` and the app before removal, and pinning it keeps it. Anything with local changes or unpushed work is never removed automatically.
- **`setu cd`** needs a small shell function in `~/.zshrc`:

  ```bash
  setu() { if [ "$1" = "cd" ]; then cd "$(command setu path "$2" "$3")" || return; else command setu "$@"; fi; }
  ```

## Disk

```bash
setu disk                 # what each worktree really costs (APFS clones counted once)
setu disk clean           # preview what can go
setu disk clean --apply   # delete it, and report the space actually freed
```

Only declared, rebuildable items are ever deleted: build output and caches from the stack presets or your `[[disk.item]]`, in stopped worktrees past their `clean_after`. Tracked files, dependencies and anything behind a symlink are never touched.

## Setu.app

A menu bar app for macOS 26 with four sections:

- **Runs:** start, stop, open, logs, claims, removal candidates.
- **Environments:** edit every layer; secrets are masked.
- **Disk:** see and free space.
- **Config:** setup and doctor.

It's a thin client of the background service and uses the installed `setu`. `setu app` installs or updates it, `setu app path` compares the bundled and installed versions, and `setu app uninstall` removes it. `setu app` never opens or quits the app.

## AI agents (MCP)

`setu mcp` is an MCP server over stdio with 23 tools:

- **Runs:** list, start, stop, restart, url, logs, and custom URL add, remove and list.
- **Env:** list, effective, set, unset, import. There is no reveal tool.
- **Disk:** report, clean.
- **Worktrees:** new, adopt, remove, claim, release, claims, removal candidates.

Secret values are never returned. Add it to your agent:

```bash
claude mcp add setu -- setu mcp                                    # Claude Code
printf '[mcp_servers.setu]\ncommand = "setu"\nargs = ["mcp"]\n' >> ~/.codex/config.toml   # Codex
```

In Cursor's `~/.cursor/mcp.json`: `"setu": { "command": "setu", "args": ["mcp"] }`.

## Command reference

| Command | What it does |
|---|---|
| `setu ls [--json]` | Every run: status, real memory, URL, notes |
| `setu up [path]` | Start the run for a worktree (default: the current directory) |
| `setu down [run]` | Stop a run |
| `setu restart [run]` | Stop and start; also takes over a dev server started outside Setu |
| `setu logs [run] [proc] [-f]` | Show or follow logs |
| `setu pin` / `unpin [run]` | Keep a run up, or let idle stop it again |
| `setu new` / `adopt` / `rm` / `restore` / `forget` | Worktree lifecycle, see [Worktrees](#worktrees) |
| `setu retry-setup <run>` | Re-run a new worktree's setup after a failure |
| `setu path <project> [run\|branch]` | A worktree's path (for `setu cd`) |
| `setu alias …` | Custom URLs, see [URLs](#urls-and-custom-domains) |
| `setu claim` / `release` / `claims` | Writer claims |
| `setu env …` | Env layers, see [Env](#env-and-secrets) |
| `setu disk [clean [--apply]]` | Disk report and cleaning |
| `setu recipes [ls\|show <name>]` | Recipes |
| `setu history [run] [--kind …]` | Audit log of env, worktree, disk and auto-removal events (names only) |
| `setu autoremove [--dry-run]` | Evaluate auto-removal now |
| `setu` | First run: set everything up. Afterwards: `setu ls` |
| `setu setup [--dry-run\|--yes\|--undo]` | Login service, PATH, DNS, Setu.app |
| `setu doctor [--json]` | Check every layer and print the exact fix |
| `setu app [install\|path\|uninstall]` | Setu.app |
| `setu migrate [plan\|run --yes\|rollback]` | Move from the old JS Setu |
| `setu import-v1 [--apply]` | Adopt the old Setu's projects, worktrees and ports |
| `setu mcp` | MCP server for agents |
| `setu daemon` | Run the service in the foreground |

`setu help` prints all of it with every flag.

## Global config

`~/.config/setu/config.toml`. Every key is optional:

```toml
proxy_port = 80            # unset: try 80, fall back to 7777
dns_port = 15353           # Setu's built-in DNS for custom domains
stop_runs_on_exit = false  # true: a daemon exit stops Setu-started runs

[auto_remove]
enabled = false
merged_after = "24h"       # a merged worktree must be idle this long
idle_after = "14d"         # an unmerged one this long
grace = "24h"              # candidates are shown this long before removal
daily_cap = 5
```

## Moving from the old Setu

If you used the JavaScript Setu (`~/.setu`, a web portal on `:2999`, Caddy), install the new one, then:

```bash
"$(brew --prefix)/bin/setu" migrate              # read-only plan
"$(brew --prefix)/bin/setu" migrate run --yes    # do it
setu migrate rollback                            # undo
```

- **What carries over:** your worktrees are adopted in place, with their URLs and ports. Project configs are generated with the right recipes. Shared `.env.local` links are kept.
- **AI tools:** Claude Code, Codex, Cursor, Claude Desktop and Gemini are switched to the new MCP server, with backups.

Details: [docs/MIGRATING.md](docs/MIGRATING.md).

## Troubleshooting

- **Start with `setu doctor`.** It checks the service, port 80, DNS, every proc's command, stores and the app, and prints the exact fix for anything that's off.
- **A URL says "Starting…" for a long time.** Run `setu logs <run> -f`; the first start of a big app can take a minute. "Setup failed" means the install failed: check the log, then `setu retry-setup <run>`.
- **Port 80 is taken.** Setu serves on `:7777` instead, and `setu doctor` names the program holding 80. Stop that program, then restart the service.
- **A worker says "address already in use".** It opens a fixed port of its own. Lease one in `[ports]` and pass `{port.<name>}`; the `inngest` recipe shows how.
- **"nothing resolves" a domain.** Run `setu setup` to add a resolver for it, or use `localhost`.
- **Restart the service:** `launchctl kickstart -k gui/$UID/dev.setu.daemon`. Dev servers keep running through it.

## Development

```bash
cargo build --release                         # target/release/setu
cargo test                                    # unit and integration tests
crates/setu/e2e/*-e2e.sh target/debug/setu    # end-to-end, each in its own sandbox
scripts/test-swift.sh                         # app tests (Command Line Tools are enough)
scripts/bundle-swift.sh                       # builds target-swift/Setu.app
scripts/release.sh 0.1.3 [--publish]          # build both Mac binaries, the app and the formula locally
```

- **No CI, on purpose:** releases are built on a Mac and published to GitHub Releases and the Homebrew tap by `scripts/release.sh`.
- **Design and evidence:** the design notes, plans and the evidence behind each part are in [docs/slices/](docs/slices/).
- **Old Setu:** the last JavaScript version is tagged [`v1-final`](../../tree/v1-final).

## License

MIT. See [LICENSE](LICENSE).
