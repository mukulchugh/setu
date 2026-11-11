# Slice 5: install with Homebrew, onboard with one command

Research: `05-install-research.md`.

## What you get
- **Install with Homebrew:** `brew install <tap>/setu`. The Homebrew release is built by `dist` (cargo-dist 0.34.0, available from Homebrew) from a tag, as prebuilt arm64 and x86_64 tarballs. There is no git checkout and no self-update; updates come from `brew upgrade`.
- **`setu setup` does everything once, idempotently.** It shows a plan first, and supports `--dry-run`, `--yes` and `--undo`:
  1. **Capture your login-shell PATH.** It runs `$SHELL -lic 'printf %s "$PATH"'` and stores the result in `~/.config/setu/config.toml`, so dev servers started at login find mise, bun, node and the rest. No sudo.
  2. **Install and start the daemon at login.** It writes `~/Library/LaunchAgents/dev.setu.daemon.plist` and runs `launchctl bootstrap gui/$UID`.
     - The plist is set to `RunAtLoad`, and `KeepAlive` on a crash.
     - It points at the stable path `$(brew --prefix)/opt/setu/bin/…` when installed with brew, or at the current binary otherwise.
     - Logs go to `~/Library/Logs/Setu/daemon.log`.
     - No sudo.
  3. **Custom domains.** A domain ending in `.localhost` needs nothing. For any other project domain, such as `quivly.test`:
     - The daemon answers DNS for it on `127.0.0.1:15353`, A records to 127.0.0.1 and AAAA to ::1.
     - Setup writes `/etc/resolver/<domain>` (`nameserver 127.0.0.1`, `port 15353`) with a `# managed by setu` marker.
     - This is the only sudo step. It is skipped if the domain already resolves to loopback, as `quivly.local` does today through v1's dnsmasq.
  4. **Record everything** in `~/.config/setu/setup.toml`. `--undo` reverses exactly what is recorded there. It only removes resolver files carrying the setu marker, and never touches anything else.
- **`setu doctor`** checks every layer and prints the exact fix for each failure. It exits non-zero if anything fails. It checks:
  - the daemon answers, and its version matches the CLI;
  - the LaunchAgent is loaded;
  - the PATH snapshot exists, and every proc's command, such as `bun` or `inngest`, can be found on it;
  - the proxy port is listening;
  - each project domain resolves to loopback;
  - resolver files carry the setu marker;
  - each shared package store is warm.
- **The daemon spawns procs with the captured PATH**, not launchd's minimal one.

## Not in this slice (needs your call)
- **Publishing.**
  - The main repo `mukulchugh/setu` is private, and Homebrew cannot download release assets from a private repo without a token. So publishing needs either a public repo or a public releases repo, plus a `homebrew-tap` repo.
  - Creating repos, pushing tags and publishing releases are outward-facing, so they wait for your yes.
  - This slice proves the whole Homebrew install with a local tap and a local tarball.
- **Port 80 and the rename to `setu`.** v1's Caddy holds :80 and v1's `setu` command is on PATH. So until cutover the binary stays `setu-rs`, and the proxy stays on 7777 (configurable in `config.toml`). Cutover is its own slice.
- **The app cask.** It comes with the app slice.

## Verification
1. **Unit tests:**
   - the DNS responder: A, AAAA, REFUSED outside the domain, malformed packets;
   - plist generation;
   - plan, apply and undo with a fake privileged runner;
   - the marker check before removing anything;
   - each doctor check.
2. **Real run on this Mac:**
   - `setup --dry-run` shows the plan;
   - `setup` installs the LaunchAgent, and the daemon comes up under launchd with the captured PATH;
   - a quivly-app run started through the launchd daemon finds `bun` and `inngest`;
   - `doctor` passes;
   - `setup --undo` removes the agent.
3. **DNS:** `dig @127.0.0.1 -p 15353 x.demo.test` returns 127.0.0.1. Writing `/etc/resolver` needs your sudo, so it is offered and not done unattended.
4. **Homebrew:**
   - `dist build` produces the tarball and formula;
   - a local tap (`brew tap-new`) installs from the local tarball, and `brew install` then `setu-rs --version` works;
   - `brew uninstall` and `brew untap` clean up.
