# Slice 10: cutover from the old JS Setu to the new Rust Setu

Status: **plan for approval**. Nothing has been changed yet.

Update: the script described below is now `setu migrate` (plan, `run --yes`, rollback), built into the binary and covered by `scripts/test-cutover-sandbox.sh`. `scripts/setu-cutover.sh` is a thin wrapper around it. The teammate guide is `docs/MIGRATING.md`.

The inventory was read-only, dated 2026-11-12. Every live change below runs only after Mukul's go-ahead, through one script with a ledger and a one-command rollback.

## 1. Old Setu today (v1)

| Piece | How it runs | Owner |
|---|---|---|
| Portal + web UI + MCP | `bun run ~/.setu/portal.js`, pid 15992, `127.0.0.1:2999`. No LaunchAgent, so it doesn't restart on reboot. | user |
| URLs on :80 | Caddy, user LaunchAgent `sh.brew.caddy`, `*:80`. `~/workspace/Caddyfile` imports 134 snippets in `caddy.d/*.caddy`, many of them stale. | user |
| DNS | dnsmasq, root LaunchDaemon, `address=/.quivly.local/127.0.0.1`, plus `/etc/resolver/quivly.local` (`nameserver 127.0.0.1`) | root |
| `/etc/hosts` block | 124 `*.quivly.local` lines between `# setu-start` and `# setu-end`. Redundant, because the dnsmasq wildcard already resolves them. | root |
| sudoers | `caddy-reload`, `caddy-setu-mukulchugh`, `setu-hosts-mukulchugh` | root |
| CLI | `~/.bun/bin/setu` (symlink to the JS `cli.js`), plus a zsh `setu()` function in `~/.zshrc:164-166` that handles `setu cd` through `setu path` | user |
| Agent MCP | `~/.claude.json` `mcpServers.setu` and `~/.codex/config.toml` `[mcp_servers.setu]`, both pointing at `http://localhost:2999/mcp` | user |
| Tunnel | cloudflared `dev-mukul`, credentials in `~/.cloudflared`. Not running. | user |

**Data:**
- `~/.setu.json` holds the workspace, localZone `quivly.local`, caps, autoCleanup and dependencySharing.
- `~/workspace/.projects` lists 13 projects; 12 have a bare repo (`renewal-rush` has none).
- `~/workspace/.ports` holds 123 port allocations.
- The `.setu-*.json` files are history only.

**Workspace (from the disk audit):**
- 183 git worktrees across 12 repos (dry run 2026-11-12). quivly-app has 119, and 10 of those are Claude Code's own.
- 2 v1 dev servers are running: `unified-harness-build` on :3081 and `codex/unified-agent-harness` on :3008.

## 2. New Setu (target)

| Piece | Replaces |
|---|---|
| `setu` daemon: proxy on **`*:80`** (loopback peers only), supervisor, Turso DB, DNS on 15353 for non-`quivly.local` domains. A user LaunchAgent `dev.setu.daemon` starts it at login. | portal.js and Caddy |
| `setu` CLI. The binary is renamed from `setu-rs`; `setu path` and `setu cd` stay compatible with the zsh function. | `~/.bun/bin/setu` |
| `setu mcp` (stdio) | the HTTP MCP on :2999 |
| Setu.app (SwiftUI) | the web portal |
| Unchanged: dnsmasq wildcard, `/etc/resolver/quivly.local`, Postgres, cloudflared | |

URLs keep their exact v1 names (`<branch>.quivly.local`, and `quivly-app.quivly.local` for main), on port 80 with no port suffix. So WorkOS callbacks and `allowedDevOrigins` keep working, and sign-in works again through the new proxy.

## 3. Migrating the worktrees: in place, nothing moves

1. **Project configs.** For each project in `.projects` that has a bare repo, generate `~/.config/setu/projects/<name>.toml`:
   - repo and domain `quivly.local`;
   - presets set to auto-detect, which picks up Next, Bun and the rest;
   - the dev command taken from that repo's `package.json` `dev` script, or the equivalent for other stacks, and flagged for review where it can't be inferred;
   - for quivly-app, the tested config that already exists.
2. **Adopt every worktree.** `setu import-v1` adopts the 171 that qualify, after a dry run first. Adopting registers the worktree and does not install or start anything. Each worktree then has a URL that starts it on demand, with idle stop.
3. **Ports.** Keep v1's port for each worktree where that port is free (import `.ports` as leases), so bookmarks and tools that point at `localhost:<port>` still work. New worktrees lease from the new range.
4. **Running v1 dev servers** (:3008, :3081) stay up until you restart them. A restart moves them under the new Setu.
5. **Env.**
   - The shared `.env.local` symlinks stay exactly as they are. Next reads them itself.
   - Setu-injected values (PORT, URL, Inngest and Trigger branch) come from the project config.
   - The old per-worktree `.envrc` files become redundant and are left in place, unused. The cleanup step reports them.
6. **History.** Old Setu's `.setu-*.json` files are archived to `~/.local/share/setu/v1-archive/`. They are not imported.

## 4. Cutover steps (one script, every step written to an append-only ledger)

| # | Step | Sudo? | Reversible? |
|---|---|---|---|
| 0 | Preflight: back up `~/.zshrc`, `~/.claude.json`, `~/.codex/config.toml`, `~/.setu.json`, `.ports`, `.projects` and the Caddyfile to `~/.local/share/setu/cutover-<ts>/`. Check that new Setu builds and `doctor` passes. | no | n/a |
| 1 | Generate the project configs and run adoption as a dry run. **Mukul reviews the list.** | no | delete configs |
| 2 | Adopt all worktrees and import the port leases. | no | the DB backup |
| 3 | Install `setu` (Homebrew from the local tap until publishing, or a symlink to the release build) and remove the `~/.bun/bin/setu` link (`bun remove -g setu`). | no | relink |
| 4 | Stop the old portal (pid 15992). Stop Caddy (`brew services stop caddy`). | no | start both again |
| 5 | `setu setup`: LaunchAgent, PATH capture, proxy on `*:80`. | no | `setu setup --undo` |
| 6 | Repoint agent MCP to `setu mcp` (stdio) in `~/.claude.json` and `~/.codex/config.toml`. The backups were made in step 0. | no | restore the backups |
| 7 | Verify: `doctor`; `curl` `quivly-app.quivly.local` and one branch URL; one sign-in through :80; `setu ls`; MCP `run_list` from Claude and from Codex. | no | n/a |
| 8 | Optional cleanup, after a week of running clean: remove the `/etc/hosts` block (needs **sudo**), the stale `caddy.d` snippets, the Caddy formula, and the old sudoers entries (needs **sudo**). Keep `~/.setu` checked out but unused. | yes, for the system files | backups |

**Order actually run:** 0, 1, 3, 4, 5, 2, 6, 7. Adoption (step 2) runs after `setu setup` (step 5) because adoption writes through the daemon. A daemon started while Caddy still holds :80 would fall back to :7777 and write that port into every adopted run's URL.

**Dry run against the real workspace (2026-11-12, after the review fixes), read-only:**
- **183 worktrees:**
  - 171 to adopt;
  - 12 skipped: 10 owned by Claude Code and 2 prunable git entries in pulse.
- **108 v1 ports kept.**
- **Configs:**
  - quivly-app keeps its existing config.
  - Generated configs for adhd, pulse, quivly-reporting, tracer, `mukulchugh-com` and `quivly-site2-0`.
  - altr, quivly-documentation, quivly-data-copilot, quivly-skills and skills have no detectable dev command. They are adopted and get URLs, but each needs its `web` command filled in before its URL can start it.
- **Dotted names.**
  - `mukulchugh.com` is imported as `mukulchugh-com`, and `quivly-site2.0` as `quivly-site2-0`.
  - Their v1 main URLs (`mukulchugh.com.quivly.local` and `quivly-site2.0.quivly.local`) keep working as aliases.
- **Running v1 dev servers.**
  - `:3008` and `:3081` keep their ports and stay up.
  - Setu proves each listener runs from its own worktree (by cwd), then routes to it as "running, external".
  - The next restart puts them under Setu.
  - Setu never signals a listener that isn't proven to belong to the worktree.
- **`renewal-rush`:** no repo, so skipped.

**Who runs it.**
- The LaunchAgent install (step 5) is yours to run. The agent's sandbox is not allowed to install it.
- Build the release binary and copy it to a stable path first. A symlink into a build directory would end up in the LaunchAgent.
- From this session, type:
  1. `! cd ~/workspace/setu-rust && cargo build --release && mkdir -p ~/.local/share/setu/bin && cp target/release/setu ~/.local/share/setu/bin/setu`
  2. `! ~/workspace/setu-rust/scripts/setu-cutover.sh plan --binary ~/.local/share/setu/bin/setu`
  3. `! ~/workspace/setu-rust/scripts/setu-cutover.sh run --binary ~/.local/share/setu/bin/setu --yes-i-have-reviewed-the-plan`
- Once Homebrew publishing is live, `brew install` replaces the copied binary. Setup prefers the Homebrew path.

**Rollback** is one command, `setu-cutover rollback`. In order:
1. `setu setup --undo`
2. `brew services start caddy`
3. start the old portal
4. restore the MCP configs from the step-0 backups. `~/.zshrc` is never modified; its `setu cd` function works unchanged with the new `setu path`.
5. relink `~/.bun/bin/setu`

## 5. Keeping the workspace clean, always

The rule: every worktree goes through Setu, from creation to removal. Running `git worktree add` and `rm -rf` by hand is how the workspace got to 183 worktrees and 134 stale Caddy snippets.

### Habits
- **Start work** with `setu new <project> <branch>`. Agents use the MCP `worktree_new`, never a raw `git worktree add`.
- **Finish work** with `setu rm <run>` after the merge. It archives ignored files and keeps the branch.
- **Agents:**
  - one agent per worktree, on one branch;
  - `setu claim` before editing and `release` after;
  - branches named `agent/<tool>/<task>`, so the stale policy can be applied mechanically.
- **Never nest worktrees.** Setu refuses to create a worktree inside another one.
- **Claude Code's worktrees are left alone.** It owns `.claude/worktrees/` and sweeps them itself; quivly-app has 10 today. Setu doesn't adopt them or remove them.
- **Keep `~/workspace` out of Desktop, Documents and iCloud.** Add it to the Spotlight Privacy list.

### Default policy

| What | When | Action | Guard |
|---|---|---|---|
| Stale git admin entries (pulse has 2) | every `ls` and daemon start | `git worktree prune` | skip locked entries |
| Merged worktree | PR merged and branch tip equals the PR head SHA | becomes a candidate, removed after 24 h grace | clean, pushed, stopped, no claim, not protected |
| Idle worktree, clean and pushed | flagged at 14 days, candidate at 30 days | archive, then remove | same guards |
| Dirty or unpushed worktree | never removed automatically | listed in the weekly report | your decision |
| Regenerable caches (`.next`, `node_modules`, `target`) | run stopped for 7 days | `setu disk clean` | no live process, no claim |
| Package-manager caches (Bun, pnpm, cargo registry) | never automatically | size reported | explicit command only |
| Archives (tar of ignored files) | kept 30 days | deleted | merged work only |
| Repo maintenance | hourly, daily and weekly | `git maintenance register` (incremental strategy) | try on one bare repo first, since bare-repo behaviour is unconfirmed |
| Docker and OrbStack | weekly | report only | never pruned |

**Protected branches,** never auto-removed: `main`, `master`, `staging`, `develop`, `release/*`, `hotfix/*`.

### Git settings per bare repo
- **`remote.origin.fetch` is already correct on all 12 repos** (checked 2026-11-12). Adopting a repo must still verify it, because bare clones don't get it by default, and without it merge detection reads stale refs.
- **Set `fetch.prune=true` and `fetch.writeCommitGraph=true`.** Leave `fetch.pruneTags` off, because it deletes local-only tags.
- **Use `core.fsmonitor` and `core.untrackedCache`** only on repos where `git status` takes over 1 s. Each worktree runs its own daemon.

### Rollout after cutover
1. **Week 1:** auto-removal stays off. The weekly report shows what it *would* remove, and you review that list.
2. **Week 2:** `[auto_remove] enabled = true` for merged worktrees only, with a daily cap of 5.
3. **Later:** idle removal, if the week-2 events are clean.
4. **The existing backlog:** the report lists which of the 171 adopted worktrees are merged. You approve one ledgered batch of `setu rm`. Nothing is removed without that approval.

### Weekly report (`setu report`)
- Worktree counts by state: active, idle, merged, dirty, unpushed, and removable.
- Volume free space, and space reclaimed, measured as the free-space change (`df`), not `du`. Clones make `du` overcount.
- The largest worktrees by clone-aware private size.
- Stale branches, pruned admin entries, and claims whose process is gone.
- Each repo's maintenance status, archive count and size, and Docker usage.
- Everything Setu refused to delete, and why.

### Code this needs (after cutover, not blocking it)
- `setu report`, plus a weekly daemon task that writes it.
- Checking the git settings when a repo is adopted.
- `worktree prune` before each list.
- A protected-branch list.
- Changing the `idle_after` default from 14 d to 30 d.
- A check that the PR head SHA equals the branch tip in merge detection.
- `tmutil addexclusion` on cache dirs when a worktree is created (no sudo needed).
- A 30-day archive retention sweep.

## 6. Code needed before the cutover (built and verified 2026-11-12)
- **Rename the binary to `setu`.** Cargo bin name, the dist formula and the app bundle path.
- **`setu path <project> <branch>`,** for the zsh `cd` function.
- **`setu import-v1`.** It reads `.projects`, `.ports` and `~/.setu.json`, generates the configs, adopts the worktrees and imports the leases. Dry-run by default.
- **`setu-cutover` script.** The steps and rollback above, with a ledger.
- **Proxy on `*:80` by default** once Caddy is stopped. It falls back to 7777 if :80 is taken, and `doctor` explains why.
