# Moving from the old Setu to the new Setu

This is for anyone still running the old JavaScript Setu (the one that lives in `~/.setu`, with the web portal on `localhost:2999` and Caddy serving your `*.local` URLs). One command moves you to the new Setu, and you can undo it with one command.

## What changes for you

| | Before | After |
|---|---|---|
| Your URLs | `<branch>.<zone>`, for example `my-branch.quivly.local` | The same names, on port 80, with no port number. The zone is the one in your old `~/.setu.json`. |
| Who serves port 80 | Caddy | The new `setu` daemon. It only answers requests from your own machine, over IPv4 and IPv6. |
| The dashboard | The web portal on `localhost:2999` | The Setu app, and `setu ls` in a terminal. |
| AI tools (MCP) | An HTTP server at `localhost:2999/mcp` | `setu mcp`, started by each tool. Claude Code, Codex, Cursor, Claude Desktop, Gemini and any project-level `.mcp.json` that named the old server are repointed for you. |
| The `setu` command | A link in `~/.bun/bin` to the JavaScript CLI | The new binary. `setu cd` keeps working if your `~/.zshrc` still has the `setu()` function. |
| Trigger.dev, Inngest, Convex | Started by the portal | Declared through recipes: `setu import-v1` writes a `recipes = ["trigger", ...]` line in your project config, and Setu merges the recipes' ports, env and procs in when it loads it (`setu recipes ls`). |

Your worktrees do not move. Nothing inside them is changed, and the shared `.env.local` files stay exactly as they are.

New things you can use right away:

- `setu restart [run]` stops a run and starts it again. It also works on a run that was started outside Setu (shown as "running, external").
- `setu recipes ls` and `setu recipes show <name>` list the recipes your configs can name. Each is a TOML file that says how to detect a stack and which ports, env and procs to add; put your own in `~/.config/setu/recipes/` (a file with a shipped recipe's name replaces it). The Trigger.dev worker's version-follow and `--branch` logic is now the shell command in the `trigger` recipe.
- `setu x trigger-dev` is gone. If a hand-written config still has `run = "setu x trigger-dev ..."`, `setu doctor` flags it; replace the proc with `recipes = ["trigger"]` (a top-level line) and delete the old `[procs.trigger]` block.

## The steps

1. Install the new binary.

   ```
   brew install mukulchugh/tap/setu
   ```

2. See what would happen. This is read only. Use the full path to the new binary for this step and the next one, because until the migration has run, `setu` in your terminal may still be the old JavaScript one (it sits earlier on your PATH, and your shell's `setu()` function calls it).

   ```
   "$(brew --prefix)/bin/setu" migrate
   ```

3. Review the output. It has three parts:
   - A table of what was found on your machine: the old portal (and its port), Caddy, dnsmasq, the DNS resolver file, your `setu()` shell function, the old `setu` link. Anything that is not there is skipped with a note, so a machine without Caddy is fine.
   - A table of AI tool config files. For each file you see how many old Setu entries it will repoint, by name only. Other servers in those files are never touched and their settings are never printed.
   - The `setu setup` plan and the `setu import-v1` dry run. This lists every worktree that will be adopted, the URL it gets, and whether its port is kept. A project marked "needs review" has no dev command that Setu could work out, and you fill it in later (see the caveats).

4. Do it.

   ```
   "$(brew --prefix)/bin/setu" migrate run --yes
   ```

   It prints one line per step and stops at the first problem, then tells you how to roll back. In order it:
   1. backs up every file it may edit, into `~/.local/share/setu/cutover-<time>/`;
   2. saves the import plan;
   3. installs the binary. If `setu` came from Homebrew it uses that. Otherwise it copies itself to `~/.local/share/setu/bin/setu` and links `~/.local/bin/setu` to it. It warns if `~/.local/bin` is not on your PATH. It removes the old `setu` link;
   4. stops the old portal and Caddy;
   5. runs `setu setup` (start at login, your shell PATH, port 80);
   6. adopts your worktrees and keeps their old ports;
   7. repoints the AI tool configs (this is the last edit it makes);
   8. checks that `setu doctor` passes, that a main URL and a branch URL answer, and that `setu mcp` lists its tools.

   If a step needs `sudo` (for example a DNS resolver file for your zone) it asks in the terminal. Without a terminal it stops before that step and tells you to run `setu setup` yourself.

5. Open a new terminal, so `setu` now means the new binary. Restart Claude Code, Codex and Cursor (and Claude Desktop or Gemini if you use them). They read their MCP settings when they start.

## What to check afterwards

- `setu doctor` ends with "all good".
- `setu ls` lists your worktrees, each with its URL.
- Open one of your URLs in a browser. A stopped worktree starts on demand and shows a "Starting" page until it is up. A page that says "Installing dependencies" or "Setting up the new worktree" refreshes by itself.
- Sign in once through the new URL if your app uses WorkOS. Generated configs set the redirect address for apps that need it.
- In Claude Code, Codex and Cursor, ask for the list of runs (the `run_list` tool) to confirm the new MCP server answers.
- Everything the migration did is in the ledger at `~/.local/share/setu/cutover-ledger.jsonl`.

## Rolling back

```
setu migrate rollback
```

This undoes the migration in reverse: it removes the launch-at-login entry, starts Caddy again, starts the old portal again, puts every config file back from the backup, restores the old `setu` link and removes the copied binary. A config file you edited after the migration keeps your edit, and only the Setu entries go back. Running it twice is harmless. The new Setu's own project configs and database are left in place, unused.

## Known caveats

- **Projects without a dev command.** If Setu cannot work out how to start a project (it looks at `package.json`, Django, Phoenix, Rails, Cargo and Go), the generated config at `~/.config/setu/projects/<project>.toml` has a `NEEDS REVIEW` note and no web command. The worktrees are still adopted and get URLs, but the URL cannot start the app until you fill in `[procs.web]` with a command that listens on `$PORT`.
- **Port 80 held by something else.** If another program still holds port 80 when the daemon starts, Setu serves on port 7777 instead, and your URLs get `:7777`. `setu doctor` says what holds the port. Stop that program and restart the daemon (`launchctl kickstart -k gui/$(id -u)/dev.setu.daemon`, or log out and in). Until then, the old portless URLs will not work.
- **Dnsmasq and the resolver file stay.** If you had dnsmasq answering `*.<zone>` and a file at `/etc/resolver/<zone>`, they are left alone, because the new Setu uses them too. The migration does not remove them.
- **Optional cleanup after a week.** Once everything has run cleanly for a week you can remove what the old Setu needed and the new one does not. These need `sudo`, so Setu never does them for you:
  - the block between `# setu-start` and `# setu-end` in `/etc/hosts` (the new Setu does not need it, because the resolver answers the whole zone);
  - the old `sudoers` entries in `/etc/sudoers.d/` for Caddy and `/etc/hosts` that the old Setu added;
  - Caddy itself (`brew uninstall caddy`), and the old `~/workspace/caddy.d` snippets.
- **Old dev servers keep running.** A dev server that was started by the old Setu stays up on its port. Setu shows it as "running, external" and routes to it. `setu restart <run>` moves it under the new Setu.
- **Tracked `.mcp.json` files.** A project-level `.mcp.json` that is committed to git shows up as a change in `git status` after the migration. Commit it or restore it as you prefer.
- **Rerunning.** `setu migrate run --yes` refuses to run again until the last migration is rolled back, so you never end up with two half-finished ones.
