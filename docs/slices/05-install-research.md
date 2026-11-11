# Install and onboarding research (Homebrew), 2026-11-11
Condensed from one research lane. Sources are at the bottom.

## Distribution
- **Tap.** Ship from our own tap, `<org>/homebrew-tap`, installed with `brew install <org>/tap/setu`. homebrew-core needs about 225 stars for a self-submission and a repo at least 30 days old, so apply later.
- **Release build.** `dist` (cargo-dist 0.34.0, 2026-11-02) runs on each tag.
  - It builds per-arch tarballs with checksums.
  - It pushes `Formula/setu.rb` to the tap using a `HOMEBREW_TAP_TOKEN`.
  - Release-plz handles versioning and tags.
  - Ship arm64 first; Intel drops to Tier 3 in Homebrew.
- **Mac app.**
  - It is a cask in the same tap: `Casks/setu.rb`.
  - It must be signed with a Developer ID, use the hardened runtime, and be notarized and stapled. Homebrew 5 removed `--no-quarantine`.
  - Either bundle the CLI and expose it with `binary`, or `depends_on formula:`. Keep one owner of the daemon binary.

## Starting the daemon at login
- **CLI only.** Use a formula `service do` block (`brew services`), with `std_service_path_env`. Never use `sudo brew services`.
- **With the app.** Use an SMAppService agent. Never run both, or two daemons fight over the port.
- **Simplest single story.** `setu setup` writes its own LaunchAgent pointing at `$(brew --prefix)/opt/setu/bin/setu daemon` and bootstraps it.
- **Upgrades.** `brew upgrade` does not clearly restart services. The daemon re-execs itself when its binary changes, and the CLI warns when its version differs from the running daemon's.
- **PATH under launchd.** launchd only provides `/usr/bin:/bin:/usr/sbin:/sbin`. Capture the login-shell PATH (`$SHELL -lic 'printf %s "$PATH"'`) at setup and on each daemon start, and spawn runs with it.

## Onboarding (copying the model from pitchfork's `proxy setup`)
1. `brew install …` needs no sudo.
2. `setu setup`:
   - Shows the plan, with `--dry-run` and `--yes`.
   - Captures PATH.
   - Installs the LaunchAgent.
   - The daemon binds `:80` on the wildcard address. That needs no root (verified here). Non-loopback peers are rejected.
   - For a custom TLD only, it writes `/etc/resolver/<tld>` with a setu marker comment. This is **the only sudo step**; `*.localhost` needs none.
   - pf is a fallback only, since it does not persist across reboots.
   - A local CA is set up only if HTTPS is enabled.
   - Everything is recorded in `setup.toml`.
3. `setu doctor` re-checks everything after reboots and upgrades and prints the exact fix.
4. `setu setup --undo` reverses what `setup.toml` recorded. Run it before `brew uninstall`, since a cask can't remove root files cleanly. Add a caveat saying so.

## Updates and uninstall
- **Updates** are `brew upgrade` only. No Sparkle for now (it would need `auto_updates true` and drifts from the formula). The app shows "update available" from a release check.
- **Cask uninstall** uses `uninstall launchctl:` and `zap trash:` for Application Support, Logs and Preferences.

Sources:
- https://docs.brew.sh/Package-Acceptance-Policy
- https://docs.brew.sh/Acceptable-Formulae
- https://docs.brew.sh/Acceptable-Casks
- https://docs.brew.sh/Cask-Cookbook
- https://docs.brew.sh/Formula-Cookbook
- https://github.com/axodotdev/cargo-dist/releases
- https://axodotdev.github.io/cargo-dist/book/installers/homebrew.html
- https://pitchfork.jdx.dev/guides/port-management
