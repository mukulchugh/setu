//! The one SQLite database (slice 8): `<state>/setu.db`. Runs, leases, claims, removal
//! operations, auto-remove state and the audit `events` all live here, so a claim check, a
//! removal step and a port release can commit together. Plan: docs/slices/08-sqlite.md.
//!
//! The daemon is the only writer. One connection sits behind a `Mutex`; every caller is on a
//! blocking thread (`spawn_blocking`) or in a CLI/test context, never on the async runtime.
//! Secrets never enter the database: run specs are stored with env values and rendered proc
//! commands blanked, and events carry names and flags only.

use crate::paths;
use anyhow::{anyhow, bail, Context, Result};
use rusqlite::{Connection, Transaction, TransactionBehavior};
use rusqlite_migration::{Migrations, M};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::os::unix::fs::{DirBuilderExt, MetadataExt, OpenOptionsExt, PermissionsExt};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

/// Version 1: every table. Ports are unique at the database level, so a double allocation fails
/// even if two writers ever raced.
const V1: &str = "
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) WITHOUT ROWID;
CREATE TABLE runs (
    key TEXT PRIMARY KEY,
    project TEXT NOT NULL,
    run TEXT NOT NULL,
    spec_json TEXT NOT NULL,
    status TEXT NOT NULL,
    pinned INTEGER NOT NULL DEFAULT 0,
    note TEXT,
    stopped_at INTEGER,
    last_started_at INTEGER,
    last_request_at INTEGER,
    env_hash TEXT,
    procs_json TEXT NOT NULL DEFAULT '[]'
);
CREATE TABLE leases (
    run_key TEXT NOT NULL REFERENCES runs(key) ON DELETE CASCADE,
    name TEXT NOT NULL,
    port INTEGER NOT NULL UNIQUE,
    PRIMARY KEY (run_key, name)
);
CREATE TABLE claims (
    run_key TEXT PRIMARY KEY,
    holder TEXT NOT NULL,
    pid INTEGER,
    pid_start INTEGER,
    since INTEGER NOT NULL,
    heartbeat INTEGER NOT NULL
);
CREATE TABLE removal_ops (
    run_key TEXT PRIMARY KEY,
    op_id TEXT NOT NULL,
    step TEXT NOT NULL,
    record_json TEXT NOT NULL,
    updated_at INTEGER NOT NULL
);
CREATE TABLE autoremove (
    kind TEXT NOT NULL CHECK (kind IN ('candidate', 'skip', 'removals')),
    key TEXT NOT NULL,
    since INTEGER,
    reason TEXT,
    day TEXT,
    count INTEGER,
    PRIMARY KEY (kind, key)
);
CREATE TABLE events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts INTEGER NOT NULL,
    actor TEXT,
    client TEXT,
    kind TEXT NOT NULL CHECK (kind IN ('env', 'worktree', 'disk', 'autoremove')),
    op TEXT NOT NULL,
    run_key TEXT,
    scope TEXT,
    name TEXT,
    detail_json TEXT NOT NULL DEFAULT '{}'
);
";

/// Version 2: the indexes `events.list` filters by.
const V2: &str = "
CREATE INDEX events_kind_id ON events (kind, id);
CREATE INDEX events_run_id ON events (run_key, id);
CREATE INDEX events_ts ON events (ts);
";

pub fn migrations() -> Migrations<'static> {
    Migrations::new(vec![M::up(V1), M::up(V2)])
}

pub struct Db {
    conn: Mutex<Connection>,
    path: PathBuf,
    /// (device, inode) of the database file when opened.
    ident: (u64, u64),
}

impl Db {
    /// Open (creating mode 0600 in a 0700 dir), set the pragmas and bring the schema to the latest version.
    pub fn open(path: &Path) -> Result<Db> {
        let dir = path.parent().filter(|d| !d.as_os_str().is_empty()).unwrap_or(Path::new("."));
        std::fs::DirBuilder::new().recursive(true).mode(0o700).create(dir).with_context(|| format!("creating {}", dir.display()))?;
        std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700)).with_context(|| format!("securing {}", dir.display()))?;
        // Create the file ourselves so it is 0600 from the first byte (SQLite gives -wal/-shm the same mode).
        std::fs::OpenOptions::new().create(true).append(true).mode(0o600).open(path).with_context(|| format!("creating {}", path.display()))?;
        let mut conn = Connection::open(path).with_context(|| format!("opening {}", path.display()))?;
        conn.busy_timeout(Duration::from_millis(5000))?;
        conn.pragma_update(None, "journal_mode", "WAL")?;
        conn.pragma_update(None, "synchronous", "NORMAL")?;
        conn.pragma_update(None, "foreign_keys", "ON")?;
        migrations().to_latest(&mut conn).with_context(|| format!("migrating {}", path.display()))?;
        let md = std::fs::metadata(path)?;
        Ok(Db { conn: Mutex::new(conn), path: path.to_path_buf(), ident: (md.dev(), md.ino()) })
    }

    #[cfg(test)]
    pub fn path(&self) -> &Path {
        &self.path
    }

    /// True while the file at `path` is still the one this handle opened.
    fn is_current(&self) -> bool {
        std::fs::metadata(&self.path).is_ok_and(|m| (m.dev(), m.ino()) == self.ident)
    }

    /// Run `f` on the connection (reads, single statements). Blocking: call from a blocking thread.
    pub fn with<T>(&self, f: impl FnOnce(&Connection) -> Result<T>) -> Result<T> {
        let conn = self.conn.lock().unwrap_or_else(|e| e.into_inner());
        f(&conn)
    }

    /// Run `f` in one write transaction (BEGIN IMMEDIATE); commits on Ok, rolls back on Err.
    pub fn tx<T>(&self, f: impl FnOnce(&Transaction) -> Result<T>) -> Result<T> {
        let mut conn = self.conn.lock().unwrap_or_else(|e| e.into_inner());
        let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let out = f(&tx)?;
        tx.commit()?;
        Ok(out)
    }
}

/// The database for the current state dir (`SETU_HOME` aware). Opened, migrated and, once, the old
/// JSON state imported. One handle per path per process; reopened if the file was replaced.
pub fn global() -> Result<Arc<Db>> {
    static REG: OnceLock<Mutex<HashMap<PathBuf, Arc<Db>>>> = OnceLock::new();
    // Unit tests must never open the real state dir.
    #[cfg(test)]
    if std::env::var_os("SETU_HOME").is_none() {
        bail!("tests must set SETU_HOME before touching the database");
    }
    let path = paths::state_dir().join("setu.db");
    let mut reg = REG.get_or_init(Default::default).lock().unwrap_or_else(|e| e.into_inner());
    if let Some(db) = reg.get(&path) {
        if db.is_current() {
            return Ok(db.clone());
        }
    }
    let db = Arc::new(Db::open(&path)?);
    crate::dbimport::run(&db, &paths::state_dir(), &paths::logs_dir())?;
    reg.insert(path, db.clone());
    Ok(db)
}

// ---------------------------------------------------------------- events

/// One audit entry. By shape there is no value field: `detail` is for names, flags and counts.
pub struct Event {
    pub ts: u64,
    pub actor: Option<String>,
    pub client: Option<String>,
    pub kind: &'static str,
    pub op: String,
    pub run_key: Option<String>,
    pub scope: Option<String>,
    pub name: Option<String>,
    pub detail: Value,
}

pub fn insert_event(conn: &Connection, e: &Event) -> Result<()> {
    conn.execute(
        "INSERT INTO events (ts, actor, client, kind, op, run_key, scope, name, detail_json) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
        rusqlite::params![e.ts as i64, e.actor, e.client, e.kind, e.op, e.run_key, e.scope, e.name, e.detail.to_string()],
    )?;
    Ok(())
}

/// Append an event without blocking the caller's runtime: on a runtime it is queued on the blocking
/// pool, elsewhere it is written inline. A failure is reported to stderr and never propagates.
pub fn record(e: Event) {
    let job = move || {
        if let Err(err) = global().and_then(|db| db.with(|c| insert_event(c, &e))) {
            eprintln!("setu: audit write failed: {err:#}");
        }
    };
    match tokio::runtime::Handle::try_current() {
        Ok(h) => {
            h.spawn_blocking(job);
        }
        Err(_) => job(),
    }
}

pub const KINDS: [&str; 4] = ["env", "worktree", "disk", "autoremove"];
pub const MAX_EVENTS: usize = 1000;
pub const DEFAULT_EVENTS: usize = 50;

/// Newest first. `since` is unix seconds (inclusive); `limit` is clamped to 1..=MAX_EVENTS.
pub fn list_events(db: &Db, kind: Option<&str>, run: Option<&str>, since: Option<u64>, limit: usize) -> Result<Vec<Value>> {
    if let Some(k) = kind {
        if !KINDS.contains(&k) {
            bail!("kind must be one of {}", KINDS.join(", "));
        }
    }
    let limit = limit.clamp(1, MAX_EVENTS) as i64;
    db.with(|c| {
        let mut st = c.prepare(
            "SELECT id, ts, actor, client, kind, op, run_key, scope, name, detail_json FROM events
             WHERE (?1 IS NULL OR kind = ?1) AND (?2 IS NULL OR run_key = ?2) AND (?3 IS NULL OR ts >= ?3)
             ORDER BY id DESC LIMIT ?4",
        )?;
        let rows = st.query_map(rusqlite::params![kind, run, since.map(|s| s as i64), limit], |r| {
            let detail: String = r.get(9)?;
            Ok(json!({
                "id": r.get::<_, i64>(0)?,
                "ts": r.get::<_, i64>(1)?,
                "actor": r.get::<_, Option<String>>(2)?,
                "client": r.get::<_, Option<String>>(3)?,
                "kind": r.get::<_, String>(4)?,
                "op": r.get::<_, String>(5)?,
                "run": r.get::<_, Option<String>>(6)?,
                "scope": r.get::<_, Option<String>>(7)?,
                "name": r.get::<_, Option<String>>(8)?,
                "detail": serde_json::from_str::<Value>(&detail).unwrap_or(Value::Null),
            }))
        })?;
        rows.collect::<std::result::Result<Vec<_>, _>>().map_err(|e| anyhow!(e))
    })
}

pub fn now_secs() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    pub(crate) fn tmp(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("setu-db-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        d
    }

    /// A throwaway database in its own temp dir (removed by the caller).
    pub(crate) fn temp_db(tag: &str) -> (Db, PathBuf) {
        let d = tmp(tag);
        (Db::open(&d.join("setu.db")).unwrap(), d)
    }

    fn mode(p: &Path) -> u32 {
        std::fs::metadata(p).unwrap().permissions().mode() & 0o777
    }

    #[test]
    fn fresh_database_has_pragmas_modes_and_latest_schema() {
        let (db, d) = temp_db("fresh");
        assert_eq!(mode(&d), 0o700);
        assert_eq!(mode(&d.join("setu.db")), 0o600);
        db.with(|c| {
            let jm: String = c.query_row("PRAGMA journal_mode", [], |r| r.get(0))?;
            let sync: i64 = c.query_row("PRAGMA synchronous", [], |r| r.get(0))?;
            let fk: i64 = c.query_row("PRAGMA foreign_keys", [], |r| r.get(0))?;
            let bt: i64 = c.query_row("PRAGMA busy_timeout", [], |r| r.get(0))?;
            assert_eq!((jm.as_str(), sync, fk, bt), ("wal", 1, 1, 5000));
            let tables: Vec<String> = c.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")?.query_map([], |r| r.get(0))?.collect::<std::result::Result<_, _>>()?;
            assert_eq!(tables, ["autoremove", "claims", "events", "leases", "meta", "removal_ops", "runs"]);
            let idx: i64 = c.query_row("SELECT count(*) FROM sqlite_master WHERE type='index' AND name LIKE 'events_%'", [], |r| r.get(0))?;
            assert_eq!(idx, 3);
            Ok(())
        })
        .unwrap();
        // WAL side files inherit the restrictive mode
        db.with(|c| Ok(c.execute("INSERT INTO meta VALUES ('k','v')", [])?)).unwrap();
        for side in ["setu.db-wal", "setu.db-shm"] {
            if d.join(side).exists() {
                assert_eq!(mode(&d.join(side)), 0o600, "{side}");
            }
        }
        migrations().validate().unwrap();
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn upgrade_from_v1_keeps_data_and_adds_indexes() {
        let d = tmp("upgrade");
        std::fs::create_dir_all(&d).unwrap();
        let p = d.join("setu.db");
        {
            let mut c = Connection::open(&p).unwrap();
            migrations().to_version(&mut c, 1).unwrap();
            c.execute("INSERT INTO events (ts, kind, op) VALUES (5, 'env', 'set')", []).unwrap();
            c.execute("INSERT INTO meta VALUES ('keep', 'me')", []).unwrap();
            let n: i64 = c.query_row("SELECT count(*) FROM sqlite_master WHERE type='index' AND name LIKE 'events_%'", [], |r| r.get(0)).unwrap();
            assert_eq!(n, 0, "v1 has no event indexes");
        }
        let db = Db::open(&p).unwrap();
        db.with(|c| {
            let n: i64 = c.query_row("SELECT count(*) FROM sqlite_master WHERE type='index' AND name LIKE 'events_%'", [], |r| r.get(0))?;
            assert_eq!(n, 3);
            let ev: i64 = c.query_row("SELECT count(*) FROM events", [], |r| r.get(0))?;
            let keep: String = c.query_row("SELECT value FROM meta WHERE key='keep'", [], |r| r.get(0))?;
            assert_eq!((ev, keep.as_str()), (1, "me"));
            let v: i64 = c.query_row("PRAGMA user_version", [], |r| r.get(0))?;
            assert_eq!(v, 2);
            Ok(())
        })
        .unwrap();
        drop(db);
        // reopening at the latest version is a no-op
        Db::open(&p).unwrap();
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn events_filter_order_and_limit() {
        let (db, d) = temp_db("events");
        let mk = |ts: u64, kind: &'static str, op: &str, run: Option<&str>| Event { ts, actor: Some("cli".into()), client: None, kind, op: op.into(), run_key: run.map(String::from), scope: None, name: None, detail: json!({ "n": ts }) };
        db.with(|c| {
            insert_event(c, &mk(10, "env", "set", None))?;
            insert_event(c, &mk(20, "worktree", "new", Some("p/a")))?;
            insert_event(c, &mk(30, "worktree", "rm", Some("p/a")))?;
            insert_event(c, &mk(40, "disk", "clean", Some("p/b")))?;
            Ok(())
        })
        .unwrap();
        let all = list_events(&db, None, None, None, 50).unwrap();
        assert_eq!(all.iter().map(|e| e["op"].as_str().unwrap()).collect::<Vec<_>>(), ["clean", "rm", "new", "set"]);
        assert_eq!(list_events(&db, Some("worktree"), None, None, 50).unwrap().len(), 2);
        assert_eq!(list_events(&db, None, Some("p/a"), None, 50).unwrap().len(), 2);
        assert_eq!(list_events(&db, None, None, Some(30), 50).unwrap().len(), 2);
        let one = list_events(&db, None, None, None, 1).unwrap();
        assert_eq!((one.len(), one[0]["detail"]["n"].as_u64()), (1, Some(40)));
        assert!(list_events(&db, Some("nope"), None, None, 5).is_err());
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn a_failed_transaction_rolls_back() {
        let (db, d) = temp_db("rollback");
        let r: Result<()> = db.tx(|tx| {
            tx.execute("INSERT INTO meta VALUES ('a', '1')", [])?;
            bail!("boom")
        });
        assert!(r.is_err());
        assert_eq!(db.with(|c| Ok(c.query_row("SELECT count(*) FROM meta", [], |r| r.get::<_, i64>(0))?)).unwrap(), 0);
        let _ = std::fs::remove_dir_all(&d);
    }
}
