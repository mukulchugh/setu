# Slice 1: run every worktree's app and workers, each at its own URL

## What you get
- `setu up` in any quivly-app worktree starts the web app, the Inngest dev server and the Trigger.dev worker for that worktree, with ports chosen for you.
- The app is reachable at `http://<worktree>.quivly.local:7777`.
- `setu ls` shows every run, its URL, its status and its real RAM.
- Opening the URL of a stopped run starts it, showing a "Starting…" page while it boots.
- A run that has been idle for 30 minutes stops: its app and its workers together.
- It runs side by side with today's JS Setu without touching it:
  - different ports;
  - no Caddy;
  - no sudo;
  - no quivly-app changes.

Disk is the next slice: every new run still builds its own multi-GB `.next` here.

## Not in this slice
These come later as their own slices, each with its own research and plan:
- **Disk:** installs, `node_modules`, `.next` cleanup.
- **Setup:** copying env files and installing dependencies.
- **Worktrees:** create and remove.
- **macOS app**, and the LaunchAgent that starts the daemon at login.
- **HTTPS, and the cutover to port 80.**
- **Setu's own DNS for new domains:** `*.quivly.local` already resolves through today's dnsmasq, and `*.localhost` needs no DNS at all.

## Research this slice is built on
Sources: `RESEARCH.md` and the slice-1 lane reports from 2026-11-11.

**How quivly-app runs today (anatomy lane)**
- **Web app:** `bun dev` at the repo root, which runs nx, then `next dev` on `PORT` (Next 16.4.5, Turbopack).
- **Inngest:** `inngest-cli dev -p <port> -u <app>/api/inngest --no-discovery`.
  - The app also needs `INNGEST_DEV=1` and `INNGEST_BASE_URL` pointing at its own Inngest port.
  - v1 never sets `INNGEST_BASE_URL`, so every worktree's events may land on main's server.
- **Trigger.dev:** `bunx trigger.dev@<sdk version> dev --branch <run>`, and the app needs `TRIGGER_DEV_BRANCH` / `TRIGGER_PREVIEW_BRANCH` set to the same branch. It opens no local port.
- **Next's dev-origin allowlist** already includes `*.quivly.local`. Other domains need a config change in quivly-app.
- **WorkOS** builds its callback URL from the request Host, so no auth env change is needed.
- **Everything else** comes from the shared `.env.local`.

**Proxy behaviour (proxy lane)**
- Preserve the Host header, port included.
- Set `X-Forwarded-For/Proto/Host/Port`, overwriting whatever the client sent.
- Pass websocket upgrades through; Next HMR runs on `/_next/hmr` in Next 16 (`/_next/webpack-hmr` in older versions; verified live).
- Never buffer: stream both ways.
- Connect timeout about 5 s. No read timeout on upgraded or streaming connections.
- Show a 502 page when the upstream is down.
- Preserving Host keeps Next Server Actions working (their origin check includes the port).

**Daemon building blocks (Rust lane)**
- hyper 1 with http1 and `serve_connection_with_upgrades`, and the hyper-util client pool.
- Upgrades are spliced with `copy_bidirectional`.
- Request activity is tracked with pitchfork's ActivityGuard and `claim_idle_stop` design (MIT, credited).
- Processes run under process-wrap `ProcessSession`, stopped with TERM, a 5 s grace period, then KILL to the group.
- Readiness is checked by TCP connect polling.
- RAM is `proc_pid_rusage` `ri_phys_footprint`, summed over the process group.
- The daemon serves newline-delimited JSON over a Unix socket, on a tokio current-thread runtime.
- No axum, sysinfo, hickory or interprocess.

**Checked on this machine**
- Port 80 can be bound without root on the wildcard address, but not on 127.0.0.1.
- Today's Caddy holds `*:80`.
- `*.quivly.local` resolves through dnsmasq.

## Design

### Config
Config is a central file, `~/.config/setu/projects/<project>.toml`, so nothing is committed to quivly-app. A repo-root `setu.toml` comes later.

```toml
project = "quivly-app"
repo    = "~/workspace/quivly-app.git"   # worktrees are discovered from this bare repo
domain  = "quivly.local"                 # <run>.quivly.local; main is quivly-app.quivly.local (same names as v1)
idle    = "30m"

[ports]                                  # leased per run, kept across restarts
web     = {}
inngest = {}

[env]                                    # added to every proc of the run
NEXT_PUBLIC_APP_BASE_URL = "{url}"
INNGEST_DEV              = "1"
INNGEST_BASE_URL         = "http://127.0.0.1:{port.inngest}"
TRIGGER_DEV_BRANCH       = "{run}"
TRIGGER_PREVIEW_BRANCH   = "{run}"

[procs.web]
run  = "bun dev"
port = "web"                             # PORT={port.web}; this proc receives proxied traffic

[procs.inngest]
run = "inngest-cli dev -p {port.inngest} -u http://127.0.0.1:{port.web}/api/inngest --no-discovery"

[procs.trigger]
# The worktree has no local trigger CLI, so pin it to the installed SDK version (4.8.3 today).
# --branch is safe: @trigger.dev/core 4.8.3 reads TRIGGER_DEV_BRANCH (checked 2026-11-11).
run = "bunx trigger.dev@4.8.3 dev --max-concurrent-runs 2 --branch {run} --env-file apps/quivly-app/.env.local"
```

**Templates:** `{project}`, `{run}`, `{domain}`, `{url}`, `{port.<name>}`. Nothing in the code knows about Next, Inngest or Trigger: they are just procs.

**Run name:** the worktree path relative to the project folder, with `/` turned into `-` (for example `feat/x` becomes `feat-x`). Names longer than 63 characters are cut and given a short hash.

**Toolchain.** Procs run through `sh -c` with the PATH and environment the daemon was started with, plus the run env. A `mise exec --` prefix is a per-proc option in config, so `bun` and `node` resolve per worktree.

**Binary name.** The binary is `setu` (it was `setu-rs` until the cutover slice, 10).

### Daemon
`setu daemon` runs in the foreground in this slice. The LaunchAgent comes later.

**Proxy**
- Listens on `127.0.0.1:7777` and rejects any peer that is not loopback.
- Routes by Host with a lookup in an in-memory table.

**Ports**
- Leased from 4000-4999, above v1's 3000-3999 and outside its 8288-9287.
- A lease is first-free from a hash of the run name. Before use, Setu checks the port actually binds and that no unknown process is listening on it.
- Leases are stored in state and reused on the next start.

**Runs**
- Starting a run starts every proc in its own process group.
- The run is ready when the web port accepts connections.
- Stopping the web proc stops every proc of the run.
- A crashed proc is marked "crashed" and is not auto-restarted in this slice.

**Idle stop**
- A run is idle when it has no in-flight request and no open websocket for `idle` minutes.
- Idle stop applies only to runs that were started on demand or by `setu up`.
- `setu pin <run>` exempts a run.
- Only proxied traffic counts as activity. Inngest calls the app port directly and Trigger has no HTTP, so a run doing background jobs can be stopped mid-job. Pin those runs.
- On-demand start only applies to runs registered with `setu up`. A request for any other name gets a 404 page.
- At most N runs can be up at once (default 3). Beyond that, a start is refused with a clear message.

**Logs:** one file per proc at `~/Library/Logs/Setu/<project>/<run>/<proc>.log`. The child writes straight to an append-mode file, never through a pipe to the daemon, so a daemon restart never blocks or kills it. Rotation is copy-truncate at 20 MB.

**State:** `~/Library/Application Support/Setu/state.json`, holding runs, leases and pids with their start times. It is written atomically.

On restart, the daemon re-adopts a live process group only if both the pid and its start time match. Otherwise it treats the run as stopped. It never signals a pid it cannot prove it owns, which is v1 invariant 20.

**Socket:** `~/Library/Application Support/Setu/d.sock`. It is mode 0600, and Setu checks the macOS 104-byte path limit.

### CLI

| Command | What it does |
|---|---|
| `setu up [path]` | Start the run for the worktree at path (default: the current directory) |
| `setu down [run]` | Stop that run |
| `setu ls [--json]` | List runs with URL, status and RAM |
| `setu logs <run> [proc] [-f]` | Show or follow logs |
| `setu pin <run>` / `unpin` | Exempt a run from idle stop, or undo that |
| `setu daemon` | Run the daemon in the foreground |

### Code layout
One crate, `crates/setu`, building one binary.

| Module | Holds |
|---|---|
| `config` | Config parsing |
| `naming` | Run names and URLs |
| `ports` | Port leases |
| `state` | Saved state |
| `supervisor` | Starting, stopping and watching procs |
| `activity` | Request tracking for idle stop |
| `proxy` | The HTTP proxy |
| `procinfo` | RAM per process group |
| `api` | The socket API |
| `cli` | The commands |

The binary target is about 5 MB. The daemon's idle memory target is under 15 MB.

## Verification, end to end, on real quivly-app worktrees
These steps start real dev servers and Trigger workers. They need your typed yes (decision 2).

Before starting:
- Check the load average and v1's running list.
- Confirm neither worktree has a writer claim or a v1 dev server.

When done, stop both runs. They sit outside v1's concurrency cap and memory watchdog.

1. **Two runs at once.** Run `setu up` in `release-lane0` and `release-lane1`. Both have `node_modules`, and v1 is not running either of them. Both apps answer on their URLs through the proxy, each with its own Inngest port. `ps` shows the three procs per run under separate process groups.
2. **Correct routing.** `curl -H 'Host: <a>.quivly.local:7777'` and the same for `<b>` reach different upstreams.
3. **Websockets work.** A websocket client completes an HMR upgrade on `/_next/webpack-hmr` through the proxy.
4. **Browser page loads.** A headless browser loads an unauthenticated page with a matching `Origin`. Its JS chunks load and the dev log shows no "Blocked cross-origin" warning. This uses the agent-browser MCP; no screenshots are taken of your screen.
5. **On-demand start and idle stop.** With `idle = "2m"` in a test config, a stopped run starts on the first request and shows the "Starting…" page. Two minutes later its whole process group is gone and the port is free.
6. **Restart adoption.** Kill and restart the daemon. The runs are re-adopted with the same ports, and nothing is signalled that Setu does not own.
7. **Measured.** The daemon's phys_footprint is measured, and `setu ls` RAM agrees with `footprint` within 10%.
8. **Unit tests** cover port leasing (races, unknown listener), run naming, the config templates and the activity tracker. Run with `cargo test`.

## Known limits in this slice
- **v1's auto-cleanup can't see these runs.** It can delete a run's Turbopack cache after 2 hours and its `.next` after 24 hours. The cost is a slower next start, not lost data.
- **Sign-in through `:7777` is not covered.** `resolveRedirectUri` keeps the port, so the callback becomes `http://<run>.quivly.local:7777/authentication/callback`, and WorkOS only accepts registered callbacks. Sign-in is verified at the port-80 cutover instead.

## Decisions I need from you
1. **URLs for now.** `http://<worktree>.quivly.local:7777` works today with no quivly-app change, apart from sign-in (see above). The `:7777` disappears when Rust Setu takes over port 80 from Caddy at cutover.
2. **Live test.** May the verification start real dev servers and Trigger workers in `release-lane0` and `release-lane1`? I'll stop them afterwards.
3. **Inngest mode.** Does quivly-app's `.env.local` set an Inngest signing key or `INNGEST_BASE_URL`? If it does, the app talks to Inngest Cloud today. The plan forces `INNGEST_DEV=1` with a per-run local Inngest server. Keep that, or leave Inngest as `.env.local` has it?
4. **Idle and cap defaults.** Idle stop after 30 minutes, at most 3 runs up at once, and `pin` to keep a run up. Do these defaults suit you?

## Added 2026-11-11: env layers (UI and MCP come in their own slice)
You asked for env you can set in the app, global or per project, and reachable over MCP. Slice 1 only lays the data model for that:
- **Layers:** a run's env is built from four layers, each overriding the one before it:
  1. global
  2. project (`[env]` in the project config)
  3. worktree override
  4. Setu's computed values (`PORT`, `{url}`, and the rest)
- **Storage:** global and worktree layers are read from `~/.config/setu/env/global.toml` and `~/.config/setu/env/<project>/<run>.toml`.
- **Daemon API:** env list, get and set requests over the socket, so the app and MCP can be added on top.

Secret storage (Keychain or an encrypted file), importing `.env.local`, masked MCP output and the app's editor are a separate env slice, researched first.

## Verification results (2026-11-11)
**Sandbox** (`/tmp/setu-e2e`, a throwaway two-worktree project). All passed:
- 40 unit tests, three runs in a row.
- Two runs routed correctly by Host, with the per-run env template applied.
- A second daemon was refused.
- Idle stop after 20 s, and on-demand start via the "Starting…" page and via a waiting API request.
- After `kill -9` of the daemon, both runs were re-adopted.
- `down` left no processes behind, workers included.

**Live quivly-app** (`fix/harness-phase0-unblock` and `fix/harness-answer-failure-logging`, run at the same time):
- **Routing and auth redirect.** Both answered through `http://<run>.quivly.local:7777`. The WorkOS redirect carried each run's own callback host:port, so Host is preserved.
- **Page loads.** `/mcp-home` loaded in a headless browser with 54 `/_next` resources and no failures or cross-origin blocks.
- **Live reload.** Next 16 serves HMR on `/_next/hmr`, not `/_next/webpack-hmr` as the research said. A browser websocket through the proxy opened and received `turbopack-connected`.
- **Trigger.dev workers.** Both reported "Local worker ready on branch: <run>".
- **Daemon restart.** A daemon hot-swap with `kill -9` and a new binary re-adopted both live runs.
- **Memory.** The RAM in `setu ls` matched `footprint` within 1% (about 4.0 GB and 6.8 GB per run). The daemon itself was 2.6 MB.
- **Cleanup.** Both runs were stopped afterwards, and nothing was left on 4000-4999.

**Not covered**
- Sign-in through `:7777`, which waits for the port-80 cutover.
- Inngest: `inngest-cli` is not installed, and `bunx inngest-cli` fails because Bun blocks its install script.
- Idle stop at the real 30-minute setting; it was proven in the sandbox at 20 s.

**Fixed from the v1-comparison review**
- **Process groups.** A dead group root no longer leaves its group running. Escaped descendants are tracked and stopped. `killpg` is used only when the group is provably ours.
- **Single daemon.** A flock lock allows only one daemon, and the proxy binds before state is touched.
- **Ports.** IPv6 listeners now count when checking whether a port is free.
- **Runs.** A run-name collision is refused instead of silently repointed.
- **Blocking work.** Git and state fsync now run off the lock and off the runtime thread, with versioned writes.
- **Restarts.** Each start waiter carries a generation check. Adopted runs now get a web-proc liveness check.
- **Environment.** Leaky env vars (`PORT`, `npm_*`, `NX_*`, `DIRENV_*`) are scrubbed from children.
- **Naming.** Run naming compares canonical paths, which fixes `/tmp` vs `/private/tmp`.
