# Env slice research, 2026-11-11

This summarises one Sonnet research lane. Sources are listed at the end.

## Storage
**Threat model.** Two goals:
- AI agents never see values.
- Values are not casually readable at rest.

This is not a defence against malware running as the same user.

**Keychain.** Keychain item ACLs are bound to the binary's code signature, and dev rebuilds change it. That means a prompt after every rebuild for each item (community reports: DataDog/pup#542 and an Apple forums thread). Never use one item per secret.

**Now**
- Plain TOML layer files, mode 0600.
- Each layer gets a sibling secrets file, also 0600: `env/global.secrets.toml`, `env/<project>.secrets.toml`, `env/<project>/<run>.secrets.toml`.
- The API never returns values.

**Later**
- The secrets files become age-encrypted.
- The key is a single Keychain item, `setu/master-key`, read only by the daemon.
- This is safe once release builds are signed with a stable identity.

**Prior art**
- mise uses sops/age and redacts values.
- dotenvx stores the private key outside the repo.
- 1Password `op run` resolves `op://` references, and its MCP server returns names only.
- Vercel "sensitive" variables are write-only.

## Precedence with project .env files
Next.js looks up env in this order: `process.env`, `.env.$(NODE_ENV).local`, `.env.local`, `.env.$(NODE_ENV)`, `.env`. It stops at the first match.

So values Setu injects override `.env.local` with no file writes. Most dotenv loaders don't override existing env either; check this per stack.

## Import (values never leave the daemon)
- `env.import_preview` returns names and collision flags only.
- `env.import {scope, target?, path | text, overwrite?}` is parsed in the daemon. It returns `{imported, skipped, overwritten, secrets}` as name lists.
- Import copies values and never moves them. The source file and the `.env.local` symlink are left untouched.
- An optional `env.render` writes a 0600 file into the run's temp dir, for tools that insist on reading a file.

## MCP
**Shim.** Use `rmcp` (the official Rust SDK, 3.9.0, updated 2026-11-05). `setu-rs mcp` is a stdio shim that forwards to the 0600 Unix socket, so it needs no port and no token. Set it up with `claude mcp add --transport stdio setu -- setu-rs mcp`.

**Tools**
- `env_list {scope,target?,show:names|masked}`
- `env_effective {run}`, which includes each value's source
- `env_set {scope,target?,name,value?,secret?}`. A secret with no value returns `pending_user_input`, and the app then prompts the user, so the agent never types the secret.
- `env_unset`
- `env_import`
- `run_list`, `run_start`, `run_stop`, `run_restart`, `run_logs`, `run_url`

**Never for MCP:** a reveal tool. Reveal is app-only and audited.

**Masking.** At most the first 3 and last 4 characters are shown, and nothing at all for values under 12 characters.

**Audit log.** `audit.jsonl` (0600) records `{ts, actor, op, scope, target, name}` and never values.

**Other leaks to close**
- `env_get`/`env_set` currently echo values. Fix this before MCP.
- Redact known secret values from `run_logs`.
- Keep values out of all error messages.

## UX
- **Scopes:** tabs for Global, Project and Worktree, plus a read-only Effective tab.
- **Rows:** each row shows a source chip, and overridden rows are dimmed.
- **Secrets:** masked with an eye button for reveal. Names matching `*KEY|*TOKEN|*SECRET|*PASSWORD|DATABASE_URL` are flagged as secrets automatically.
- **Bulk paste:** pasted `.env` text shows a preview diff before it is applied.
- **Stale runs:** a `stale_env` flag per run (hash of the env at start compared with now) drives a "N runs need restart" banner.

Sources:
- https://nextjs.org/docs/app/guides/environment-variables
- https://crates.io/api/v1/crates/rmcp
- https://mise.jdx.dev/environments/secrets/
- https://dotenvx.com/docs/learn/encrypting/private-keys/
- https://www.1password.dev/security-for-ai/mcp-server
- https://vercel.com/academy/optimize-your-vercel-account/sensitive-env-vars
- https://code.claude.com/docs/en/mcp
- https://github.com/DataDog/pup/issues/542
