# Slice 8b: Turso as the storage engine (step 0 findings, 2026-11-12)

Owner decision 2026-11-12: replace `rusqlite` (bundled SQLite) with Turso (`turso` crate) behind the same `db.rs` seam.
Background: 08-storage-ranking.md (why, risks), 08-sqlite.md (behaviour that must hold), 08-sqlite-review.md (hardening).

## Version chosen: `turso = "=0.9.0-pre.5"` (pre-release), default features off
- crates.io on 2026-11-12: latest stable is 0.8.3 (2026-10-12); pre-releases 0.9.0-pre.1..5 (latest pre.5, 2026-11-10). Pinned with `=` because files, API and bug fixes still move weekly.
- **Why the pre-release over the stable.** I first probed and built everything on 0.8.3, then scanned *closed* issues since 0.8.3 shipped. Fixes in 0.9 that touch Setu's exact path (one process, one connection, WAL): #10032 (a `-wal` with a bad header checksum was used and the main file truncated at close, crash-recovery data loss), #6774 (pager freelist skipped the header size update), #7694 (DELETE could fail with a missing index entry after an overlapping UPDATE), #9391 (aborted transaction readable after a failed COMMIT). None of these are in 0.8.3. The whole test suite, the three e2e scripts and the kill tests pass on both; the API used is identical. No open issue is specific to 0.9.0-pre.* single-process WAL use.
- docs.rs has no rendered docs for either 0.8.3 or 0.9.0-pre.5 (`doc_status:false`), so the API was read from the crate source, and the build was verified locally.
- Default features (`mimalloc`, `fts`) are turned off: mimalloc installs a global allocator in a library crate and `fts` pulls a stemmer; neither is needed.
- Open-issue scan (2026-11-12), relevance to Setu's pattern (one process, one writer, one connection, default WAL, not MVCC):
  - #8593 WAL recovery treats a *short pread* of the 32-byte WAL header as an empty WAL (committed data in WAL silently dropped). Needs a short read from the OS, which POSIX allows but regular files on macOS/APFS do not do in practice; the reporter injected it with LD_PRELOAD. OPEN, residual risk.
  - #11383, #9362, #10314, #8536, #10114 multiprocess WAL: only for `experimental_multiprocess_wal`, which Setu does not enable. The daemon is the only process that opens the DB.
  - #7960, #11507, #11499, #9504, #10622, #11324 MVCC: Setu stays in the default WAL journal mode; MVCC is never enabled.
  - #9281 `UPDATE OR REPLACE` corrupts a UNIQUE index when a cascade deletes the updated row; #7975 `REPLACE` with a delete trigger; #9277 self-referencing cascade; #8705 CHECK over `||`. Setu uses none of these (`INSERT OR REPLACE` was rewritten as `ON CONFLICT DO UPDATE`; no triggers, no self-reference, CHECKs are `IN (...)`).
  - #11291 WITHOUT ROWID ignores COLLATE in PRIMARY KEY and "corrupts SQLite-created files": we have a `meta` table created WITHOUT ROWID by the rusqlite build. It is rebuilt as a plain table by migration 3, in one transaction (after a backup); new databases never have it.
  - #11304 a connection keeps writing to an old inode after the path is replaced. `db.rs` records (dev, inode) and `global()` reopens a replaced file, but this was not exercised against Turso and the daemon holds its handle for life: treated as a residual risk, not handled.
  - #10788 a failing statement inside BEGIN rolls the whole transaction back silently. The facade poisons the transaction on the first failed statement.
- Verdict: crash-safe transactions are available for our pattern (kill -9 loops in the spike and in the unit tests). Proceed, with the risk list at the bottom.

## API (turso 0.8.3, from source)
- `Builder::new_local(path).build().await -> Database` (opening runs async IO); `db.connect() -> Connection`.
- `Connection`: `execute(sql, params) -> u64`, `query(sql, params) -> Rows`, `execute_batch`, `prepare`, `pragma_query`, `pragma_update`, `busy_timeout(Duration)`, `is_autocommit()`, `transaction_with_behavior(Immediate)`.
- `Rows::next().await -> Option<Row>`; `Row::get::<T>(idx)`, `get_value(idx) -> Value` (Null, Integer, Real, Text, Blob). Params: `()`, `[..]`, `turso::params!`.
- Same-connection write statements must not overlap (a second write statement returns BUSY): fine, the facade runs one statement at a time to completion.

## Feature matrix (probed against 0.8.3 on macOS, spike in /tmp)
| Feature | Result |
|---|---|
| WAL | `PRAGMA journal_mode=WAL` returns `wal`; reads an existing SQLite WAL-mode file |
| `PRAGMA user_version` read/write | works, and is rolled back with the transaction (DDL + user_version in one BEGIN IMMEDIATE) |
| `PRAGMA synchronous / foreign_keys / busy_timeout` | set and read back (NORMAL=1, ON, 5000) |
| FOREIGN KEY ... ON DELETE CASCADE | works; a violation returns `FOREIGN KEY constraint failed` |
| UNIQUE | works (`UNIQUE constraint failed: leases.port`) |
| CHECK | works |
| INTEGER PRIMARY KEY AUTOINCREMENT | works |
| `INSERT ... ON CONFLICT DO UPDATE`, `INSERT OR IGNORE` | work |
| Indexes | work |
| BEGIN IMMEDIATE / COMMIT / ROLLBACK | work, DDL is transactional |
| DROP TABLE, ALTER TABLE RENAME | work |
| `?N IS NULL` numbered params | work |
| json functions | not used by Setu (JSON is stored as TEXT and parsed in Rust) |
| `VACUUM INTO 'path'` | supported on a plain database, but **fails on every existing user database** (their `meta` table is WITHOUT ROWID) and leaves a stray file. Not used: the backup is a file copy after `wal_checkpoint(TRUNCATE)` |
| `PRAGMA quick_check` / `integrity_check` | supported, return `ok` |
| `PRAGMA application_id` | supported |
| `PRAGMA wal_checkpoint(TRUNCATE)` | supported |
| `PRAGMA journal_size_limit`, `PRAGMA optimize` | accepted as no-ops (COMPAT says No); not relied on |
| WITHOUT ROWID | not available without an experimental flag and insert-only: **dropped**; existing `meta` table is rebuilt (migration 3) |
| STRICT | COMPAT lists it as supported; not adopted here (separate hardening item) |
| Opening a DB created by the rusqlite build | works, including a database with an un-checkpointed `-wal` (fixtures `crates/setu/tests/fixtures/rusqlite-v2*.db`) |
| A second *process* opening the same file | refused: `Locking error: ... File is locked by another process` (no multiprocess flag). This holds for `sqlite3` CLI readers too (`database is locked`). |

### Consequences of the exclusive file lock
- Only the daemon opens the DB today (CLI and app go through the socket; audit writes originate in the daemon), so no product code changes. It also makes "daemon is the only writer" enforced by the engine.
- The one e2e assertion that ran `sqlite3` against the live DB (worktree-e2e.sh, "a refused rm must persist nothing") cannot read while the daemon runs; it now reads a point-in-time copy of db + wal with `sqlite3` (no new socket command; protocol unchanged).
- `setu-rs ls --offline` (future) must not open the file while a daemon runs.

## Async design (deviation from the brief, on purpose)
The brief said to make db calls async. They are async at the Turso boundary but the Setu-facing seam stayed closure-based and sync, driven on blocking threads; the daemon's runtime is never blocked, which the ticker test proves (`a_ticker_keeps_running_while_a_transaction_is_open`). `with_async`/`tx_async` exist for callers on the runtime (the daemon's final checkpoint uses `with_async`; `tx_async` is `#[allow(dead_code)]` because every existing async call site already reaches the DB through `spawn_blocking`).

Turso's API is async only. Its default Unix IO runs `pread`/`fsync` inline inside `poll` (turso_core io/unix.rs), so awaiting it on the daemon's `current_thread` runtime would itself block that runtime. Setu's DB users (state, claims, removal ops, autoremove state, audit events) are synchronous state machines that already run on `spawn_blocking` threads (the daemon runs a `current_thread` runtime and never touches the DB on the runtime thread). The seam therefore keeps the closure API but drives Turso's futures to completion with a small park/unpark `block_on` on the calling blocking thread, behind one `Mutex<Connection>`. The tokio runtime is never blocked, and no call site needed to become async (which would have meant rewriting the 1,800-line worktree state machine). `Db` also offers `with_async`/`tx_async` helpers that hop to the blocking pool for callers on the runtime.

## Risks carried (also in the final report)
1. Turso is pre-1.0; weekly releases; open #8593 (short read of the WAL header).
2. No `journal_size_limit`/`optimize`. Tested: in a long-lived handle Turso's own checkpoint did *not* keep the `-wal` file from growing (3.5 MB after 9,000 small transactions and rising), so `Db::tx` truncates the WAL after a commit once it exceeds 2 MiB (`the_wal_stays_bounded_over_many_transactions`), plus checkpoint on shutdown.
3. Exclusive lock: external tools (sqlite3) cannot read while the daemon is up.
4. Going back to the rusqlite build: files stay SQLite-format, but the old build refuses a v3 file (`DatabaseTooFarAhead`). The way back is the pre-migration copy in `backups/setu-v2-<ts>.db` (taken automatically), which loses anything written after the upgrade.
5. Coverage notes: the lease and claim race tests now share one handle across threads (Turso refuses a second connection from another process, so separate-connection races are not possible; production has one handle). The un-checkpointed-WAL fixture was produced with the system SQLite (Python `sqlite3`), not the rusqlite build; the checkpointed fixture is from the rusqlite build.
6. Not carried over from 08-sqlite-review.md: `application_id` (nothing reads it), `journal_size_limit` and `PRAGMA optimize` (unsupported by Turso, no-ops), `setu doctor --repair` and the daily optimize/event pruning (separate work), STRICT tables (supported but a schema change; left for its own migration), the volatile-columns table. `busy_timeout=5000` is set and read back, but is moot: one connection under an exclusive process lock never contends.

## What was built and verified (2026-11-12)
- `db.rs`: `Db` over one Turso connection; `Conn` facade (`execute`, `execute_batch`, `query`, `query_opt`, `query_row`, `scalar_i64`); `with`/`tx` (blocking, for blocking threads), `with_async`/`tx_async` (hop to the blocking pool); own forward-only migration runner on `PRAGMA user_version` (each step and its version bump in one `BEGIN IMMEDIATE`); steps V1, V2 as before, V3 rebuilds `meta` without WITHOUT ROWID.
- Open sequence for an existing file: read-only probe first (schema version and `quick_check`; nothing written, no sidecars), refuse a newer or corrupt file untouched, then writable open, WAL assert, pragmas, backup (checkpoint then copy to `backups/setu-v<old>-<ts>.db`, 0600, dir 0700, keep 3, only when a migration is pending on a non-empty DB), migrate.
- The `-wal` file is pre-created 0600 (Turso, unlike SQLite, does not inherit the database file's mode).
- Daemon shutdown runs `wal_checkpoint(TRUNCATE)` (after a clean stop the state dir holds `setu.db` and an empty `-wal`).
- Transactions poison on the first failed statement (Turso #10788 rolls back silently), "no rows" is distinct from an error (`query_opt`), a panic inside a transaction is rolled back at the next use.
- `INSERT OR REPLACE` became `ON CONFLICT DO UPDATE` (avoids the OR REPLACE class of Turso bugs).
- Not carried over: `journal_size_limit`, `PRAGMA optimize`, `application_id` (not needed; COMPAT: journal_size_limit/optimize unsupported).
- The AUTOINCREMENT sequence lives in a Turso-internal table (`__turso_internal_seq_*`), not `sqlite_sequence`. Verified: after opening a SQLite-made fixture, new event ids continue after the old ones.
