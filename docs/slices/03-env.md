# Slice 3: env. Global, per-project and per-worktree env, with secrets agents never see

Research: `02-env-research.md`.

## What you get
- **Three layers you edit**, merged in this order:
  1. global (every project and worktree)
  2. project
  3. worktree

  Each layer holds plain values and secrets. Setu's computed values (`PORT`, `SETU_URL` and the rest) always win.
- **Secrets are stored apart from plain values.** Each layer has a sibling secrets file, mode 0600, in a 0700 directory. A name is treated as a secret when either:
  - you mark it, or
  - it matches `*KEY*`, `*TOKEN*`, `*SECRET*`, `*PASSWORD*`, `*PASS`, `DATABASE_URL`, `*_DSN` (case-insensitive).
- **Nothing hands back secret values, except one audited reveal** that only you can run:
  - list, set, import and the effective view return names, sources and masked previews only;
  - previews show at most the first 3 and last 4 characters, and nothing for values under 12 characters;
  - `reveal` exists on the CLI (and later the app), is never offered to MCP, and writes an audit line.
- **Import from an existing `.env` file**, parsed inside the daemon so values never pass through an agent:
  - `setu env import <file> <scope> [target]`
  - `--preview` first shows names and collisions only;
  - the source file and the `.env.local` symlink are untouched, because Next reads its own file and Setu's injected env already wins.
- **Effective view per run:** every name with its source (global, project, worktree or computed) and a masked preview. It shows which layer overrides which.
- **`stale_env` on each run:** the env is hashed at start, so `setu ls` can say "restart to apply env changes".
- **Audit log:** every set, unset, import and reveal goes to `~/Library/Logs/Setu/env-audit.jsonl` (0600), recording time, actor, operation, scope, target and name. Never a value.

## Not in this slice
- Encryption at rest (age, with the key in Keychain). Secrets already live in separate files, so this later becomes a one-function swap.
- MCP tools (slice 4) and the app editor (slice 6).
- Setup steps (installs, codegen) get their own small slice after MCP.

## Storage layout
```
~/.config/setu/env/global.toml            ~/.config/setu/env/global.secrets.toml
~/.config/setu/env/<project>.toml         ~/.config/setu/env/<project>.secrets.toml
~/.config/setu/env/<project>/<run>.toml   ~/.config/setu/env/<project>/<run>.secrets.toml
```
- Within a layer, the secrets file wins on a name clash.
- A name moves between the two files when its secret flag changes.
- The project config's `[env]` table (templates) stays where it is and sits below the project layer file.

## API (socket)

| Request | Returns |
|---|---|
| `env.list {scope, target?}` | `{vars:[{name, secret, preview?}]}` |
| `env.effective {run}` | `{vars:[{name, source, secret, preview?, overrides?:[source]}]}` |
| `env.set {scope, target?, name, value, secret?}` | `{name, secret, applies:"next start"}` (no value) |
| `env.unset {scope, target?, name}` | Confirmation |
| `env.import {scope, target?, path\|text, preview?, overwrite?}` | `{imported, skipped, overwritten, secrets}`, all as name lists |
| `env.reveal {scope, target?, name}` | The value. CLI and app only; MCP will never route it. Audited. |

`env.get` is removed, because it returned values.

## Verification
1. **Unit tests:**
   - layer merge order and secret precedence;
   - secret name detection;
   - masking rules;
   - the dotenv parser: comments, `export`, quotes, multiline double-quoted values, `=` inside values, and invalid names reported;
   - import preview and collision handling;
   - audit lines never containing values;
   - file modes 0600 and 0700.
2. **Sandbox end to end:**
   - set global, project and worktree values plus a secret;
   - `env effective` shows the right sources and masks;
   - the run's process actually receives the merged values (it writes them to its log);
   - `stale_env` flips after an edit and clears on restart.
3. **Leak checks:**
   - grep every socket reply in the e2e for the test secret's value: it must appear only in the `reveal` reply;
   - grep the audit log: the value must not appear.
4. **Live on quivly-app:** a dry-run import preview of the project `.env.local`, through the daemon. Only names come back; the agent never sees a value. A real import is not run unless you ask.

## Verification results (2026-11-11)
- **Unit tests:** 73 pass. Ten are new in `env.rs`: secret detection, masking, the dotenv parser, the plain/secret file split, file modes, import preview and overwrite, an audit log without values, and the env hash.
- **Sandbox end to end** (`/tmp/setu-e3`, fake values only):
  - Global, project and worktree layers merged in the right order. The effective view showed `SHARED from-project (overrides global, project-config)`.
  - The running process received the merged env.
  - Importing a file with an invalid line imported the valid names and reported the bad line by number only. The secret was detected and masked as `sk-…3210`.
  - A worktree edit set `stale_env` on the running run.
  - Reveal returned the value to the CLI and was refused for actor `mcp`.
  - The test secret appeared in no CLI output except reveal, and not in the audit log.
  - Secrets files are 0600 and the env dir is 0700.
- **Live import preview of the quivly-app `.env.local`:** not run by the agent. The permission system blocked it as credential access, so it is left for Mukul to run himself.
