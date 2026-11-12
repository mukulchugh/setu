# SQLite best-practice review, 2026-11-12
From one research lane; sources at the bottom. These fixes apply only if SQLite stays: the engine choice is being re-ranked.

## Severity and fix
- **High.** The slice doc said rusqlite 0.42. Stay on 0.41 until `rusqlite_migration` supports 0.42 (2.7 is pinned to `^0.41`).
- **High: downgrade.** A newer DB opened by an older binary fails with an opaque error (`DatabaseTooFarAhead`). Read `user_version` first and refuse with a clear message. Never touch the file.
- **High: backups.** Run `VACUUM INTO backups/setu-v<old>-<ts>.db` (mode 0600, keep the last 3) before any migration.
- **Medium: guard the file.** Set `application_id`. Run `PRAGMA quick_check` at start. On corruption, refuse, and add `setu doctor --repair` that quarantines the file to `.corrupt-<ts>` and rediscovers state. Never rebuild silently.
- **Medium: WAL hygiene.**
  - `journal_size_limit` = 8 MB.
  - `wal_checkpoint(TRUNCATE)` on shutdown.
  - `PRAGMA optimize` daily and on shutdown.
  - Assert that `journal_mode` returned `wal`.
- **Medium: bundled SQLite.** It is 3.50.2, which is inside the range of a WAL-reset bug fixed in 3.51.3. The risk is low with a single writer: keep the CLI read-only and bump `libsqlite3-sys` once a compatible version is out.
- **Medium: schema.** Make the tables `STRICT` with CHECK constraints before release. Use a plain `INTEGER PRIMARY KEY` for events, and prune old events.
- **Low to medium: write cost.** Whole-snapshot writes rewrite every row. Skip unchanged rows, diff the leases, and move volatile columns (`last_request_at`, heartbeat) into a small table of their own.

## Durability
WAL with `synchronous=NORMAL` keeps the database intact in every case:
- A process crash loses nothing.
- A power loss can roll back the last transactions. That is acceptable for this state, since claims and removal operations reconcile on the next start.

Sources:
- https://sqlite.org/wal.html
- https://docs.rs/rusqlite_migration/latest/rusqlite_migration/
- https://crates.io/api/v1/crates/libsqlite3-sys/versions
