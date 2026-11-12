# Slice 8: one SQLite database for Setu's state

Owner decision (2026-11-11): migrate now, before the cutover, so imported old-Setu data lands in the DB once.

## Why
State is currently spread across several formats, each written atomically on its own:
- `state.json` (runs and leases)
- one claim file per run
- one removal-operation record per run
- `autoremove.json`
- `env-audit.jsonl`, `worktree-audit.jsonl` and `disk-audit.jsonl`

Nothing is atomic across them, so a claim check, a removal step and a port release cannot commit together. History is not queryable.

## What
- **One database.** `paths::state_dir()/setu.db` (honors `SETU_HOME`) opened with:
  - `journal_mode=WAL`, `synchronous=NORMAL`, `foreign_keys=ON`, `busy_timeout=5000`
  - mode 0600, in a 0700 dir
- **Crates**, both standard, nothing hand-rolled:
  - `rusqlite` 0.42, feature `bundled`, so no system SQLite dependency;
  - `rusqlite_migration` 2.7, for ordered, versioned schema migrations embedded in the binary.
- **Tables:**

  | Table | Holds |
  |---|---|
  | `runs` | key, project, run, spec_json, status, pinned, note, stopped_at, last_started_at, last_request_at, env_hash, procs_json |
  | `leases` | run_key, name, port; UNIQUE(port) so double allocation fails at the DB |
  | `claims` | run_key PK, holder, pid, pid_start, since, heartbeat |
  | `removal_ops` | run_key, op_id, step, record_json, updated_at |
  | `autoremove` | candidates and the daily counter |
  | `events` | id, ts, actor, client, kind (env/worktree/disk/autoremove), op, run_key, scope, name, detail_json |

  The `events` table replaces the three JSONL audit logs. It never stores values, a rule kept by the existing API shapes.
- **Transactions:**
  - claim plus guard checks plus removal step transitions;
  - lease allocation plus run registration;
  - `rm` steps 5 to 7 (drop state, release lease, marker) in one transaction.
- **Concurrency.** The daemon is the only writer. The CLI and app keep going through the socket. Read-only direct access (`setu ls --offline`) is allowed later.
- **Event queries.** `events.list {kind?, run?, since?, limit}` on the socket, plus a `setu history [run] [--kind]` CLI. It is for the app's history views later.
- **One-time import on first start.** If `state.json` and the other JSON or JSONL files exist and the DB has no `meta.imported_from_json`, import them in a single transaction. Then rename the originals to `*.imported-<ts>` (kept, not deleted) and record the import in `meta`.
- **Unchanged:** project TOML configs and env TOML/secrets files stay files. Secrets must never enter the DB. Run logs stay append-only files.

## Verification
- **Migration tests:** a fresh DB; an upgrade from v1 schema to latest; idempotent import from a fixture set of old JSON files (one run, a lease, a claim, a pending removal op, autoremove state, audit lines). After import:
  - every value matches;
  - the originals are renamed, not removed;
  - a second start does not re-import.
- **Behaviour.** Every existing test suite passes unchanged, including `cargo test` and the e2e scripts for MCP, worktree and autoremove.
- **Atomicity tests:**
  - concurrent lease allocation never duplicates a port (the UNIQUE constraint);
  - a crash, simulated by the existing fail-after-step hook, between rm steps 5 and 7 leaves the DB consistent, and a retry completes.
- **Secrets.** Grep the `.db` file after the env e2e: no canary secret value appears.
