# Storage engine ranking for Setu state, 2026-11-12
From one research lane, checked against the crates.io API and project docs (sources at the bottom). Scores are judgment calls, not measurements.

| Rank | Engine | Verdict |
|---|---|---|
| 1 | **SQLite (rusqlite 0.41, bundled)** | Best fit. Real transactions, `UNIQUE` leases, check-and-set claims, history queries in SQL, standard migrations and tooling (`sqlite3`, `VACUUM INTO`). Cost: about 1.2 MB binary. |
| 2 | **Turso (Rust rewrite of SQLite, `turso` 0.9-pre)** | The cutting-edge path. SQLite file format, async tokio API, and the file falls back to rusqlite, so the choice is reversible. Pre-1.0, MVCC experimental, no SAVEPOINT, weekly pre-releases, roadmap unclear after the Supabase acquisition (2026-10). Watch, spike behind a trait, adopt at 1.0. |
| 3 | redb 4.5 | Pure Rust and small. Crash-recovery data-loss fixes as late as 4.2–4.4 (Aug–Oct 2026). Every index, uniqueness check and migration would be hand-built. |
| 4 | fjall 3.1 | LSM key-value store, pure Rust. No SQL; indexes and migrations hand-built; durability must be requested explicitly. |
| 5 | heed (LMDB) | Battle-tested. Raw bytes only, fixed map size. |
| No | libSQL | Its own README sends new projects to Turso. Maintenance only. |
| No | DuckDB | Analytical (OLAP) engine, a poor fit for row-level state and claims, and much larger. |
| No | sled | Abandoned since 2024-10. |
| No | plain files + journal | What we had: nothing atomic across stores. |

**Decision pending.** If SQLite stays:
- Apply the hardening in `08-sqlite-review.md`.
- Keep `db.rs` as the only seam, so Turso can replace it at 1.0.

Sources:
- https://github.com/tursodatabase/turso
- https://github.com/tursodatabase/turso/blob/main/COMPAT.md
- https://github.com/tursodatabase/libsql
- https://supabase.com/blog/supabase-is-acquiring-turso
- https://github.com/cberner/redb/blob/master/CHANGELOG.md
- https://github.com/fjall-rs/fjall
