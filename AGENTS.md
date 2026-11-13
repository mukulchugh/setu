# Setu: notes for agents working in this repo

- **Rust daemon and CLI:** `crates/setu` (one crate, binary `setu`).
- **macOS app:** `apps/setu-swift` (SwiftUI, a thin client over the daemon socket).
- **Design and evidence:** `docs/slices/`.
- **Old JS Setu:** tagged `v1-final`.
- **Recipes:** `crates/setu/recipes/*.toml`. Setu's Rust code names no third-party dev tool (a test enforces it); what a stack needs (ports, env, procs, detection) is a recipe. Adding one is adding a file. Users override by name in `<config dir>/recipes/`. Project configs name recipes (`recipes = [...]`) and `config.rs` merges them at load (project keys win); `import-v1` writes the line, it does not paste the recipe. `setu app` (`src/app.rs`) installs the bundled Setu.app into `~/Applications`.

## Build and test
- `cargo test`: unit and integration. It must stay at zero warnings.
- `crates/setu/e2e/*-e2e.sh <binary>`: each script runs in its own HOME and SETU_HOME, on non-80 ports.
- `scripts/test-cutover-sandbox.sh <binary>`: `setu migrate` run and rollback in a fake home.
- `scripts/test-swift.sh`: the app tests. They work with Command Line Tools only.
- `scripts/release.sh <version> [--publish]`: releases are built and published from this Mac. There is no CI on purpose.

## Rules
- The daemon is the only writer of state (`setu.db`, a Turso database). The CLI, the app and MCP all go through the socket.
- Never launch Setu.app or GUI apps to check UI. The app is tested against daemon-reply fixtures.
- Tests clean up only processes they started, by recorded PID. Never `pkill` or `killall` by pattern.
- Secrets never enter the DB, logs, MCP replies or error messages.
- Destructive actions such as `rm`, auto-removal and disk clean re-prove their guards right before acting, and refuse when they can't.
- Live use on a real machine: run `setu doctor` first. To deploy a new binary, `mv` it into place, then `launchctl kickstart -k gui/$UID/dev.setu.daemon`. Dev servers survive this.
