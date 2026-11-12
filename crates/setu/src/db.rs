//! The one SQLite-format database (slice 8, engine switched to Turso in slice 8b): `<state>/setu.db`.
//! Runs, leases, claims, removal operations, auto-remove state and the audit `events` all live here,
//! so a claim check, a removal step and a port release can commit together. Plans:
//! docs/slices/08-sqlite.md and docs/slices/08b-turso.md.
//!
//! The daemon is the only process that opens the file (Turso takes an exclusive file lock; a second
//! process is refused). One connection sits behind a `Mutex`.
//!
//! Turso's API is async, and its default Unix IO does `pread`/`fsync` inline inside `poll`, so awaiting
//! it on the daemon's `current_thread` runtime would itself block that runtime. Callers therefore run
//! on a blocking thread (`spawn_blocking`) and the closure API (`with`, `tx`) drives the futures to
//! completion with a tiny park/unpark `block_on`; `with_async` and `tx_async` do the hop for callers
//! that are on the runtime. The runtime is never blocked.
//!
//! Secrets never enter the database: run specs are stored with env values and rendered proc commands
//! blanked, and events carry names and flags only.

use crate::paths;
use anyhow::{anyhow, bail, Context, Result};
use serde_json::{json, Value};
use std::cell::Cell;
use std::collections::HashMap;
use std::future::Future;
use std::io::Write;
use std::os::unix::fs::{DirBuilderExt, MetadataExt, OpenOptionsExt, PermissionsExt};
use std::path::{Path, PathBuf};
use std::pin::pin;
use std::sync::{Arc, Mutex, OnceLock};
use std::task::{Context as TaskContext, Poll, Wake, Waker};
use std::time::Duration;
pub use turso::{params, Row};
use turso::params::IntoParams;

/// Version 1: every table. Ports are unique at the database level, so a double allocation fails
/// even if two writers ever raced. (`meta` was WITHOUT ROWID in the rusqlite builds; Turso cannot
/// update or delete such tables, so new databases get a plain table and V3 rebuilds old ones.)
const V1: &str = "
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
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

/// Version 3 (Turso): rebuild `meta` as an ordinary table. Databases made by the rusqlite builds
/// have it WITHOUT ROWID, which Turso only supports insert-only behind an experimental flag.
const V3: &str = "
CREATE TABLE meta_new (key TEXT PRIMARY KEY, value TEXT NOT NULL);
INSERT INTO meta_new (key, value) SELECT key, value FROM meta;
DROP TABLE meta;
ALTER TABLE meta_new RENAME TO meta;
";

/// Forward-only; the schema version is `PRAGMA user_version` = number of steps applied (the same
/// numbering `rusqlite_migration` used, so existing files line up).
const MIGRATIONS: &[&str] = &[V1, V2, V3];

pub const SCHEMA_VERSION: i64 = MIGRATIONS.len() as i64;
const BACKUPS_KEEP: usize = 3;
/// A WAL bigger than this is truncated by the next commit.
const WAL_LIMIT: u64 = 2 * 1024 * 1024;

// ---------------------------------------------------------------- async driver

struct Parker(std::thread::Thread);
impl Wake for Parker {
    fn wake(self: Arc<Self>) {
        self.0.unpark();
    }
    fn wake_by_ref(self: &Arc<Self>) {
        self.0.unpark();
    }
}

/// Drive `f` to completion on the calling thread (no runtime needed).
fn block_on<F: Future>(f: F) -> F::Output {
    let mut f = pin!(f);
    let waker = Waker::from(Arc::new(Parker(std::thread::current())));
    let mut cx = TaskContext::from_waker(&waker);
    loop {
        if let Poll::Ready(v) = f.as_mut().poll(&mut cx) {
            return v;
        }
        std::thread::park();
    }
}

// ---------------------------------------------------------------- connection facade

/// A connection handed to a `with`/`tx` closure. Statements run one at a time to completion and
/// every cursor is drained before the next statement (Turso rejects overlapping write statements).
/// Inside a transaction, the first failing statement poisons it: Turso has already rolled back at
/// that point, so nothing more may run and the transaction ends as an error.
pub struct Conn<'a> {
    c: &'a turso::Connection,
    failed: Cell<bool>,
}

impl Conn<'_> {
    fn guard(&self) -> Result<()> {
        if self.failed.get() {
            bail!("an earlier statement in this transaction failed; the transaction is rolled back");
        }
        Ok(())
    }

    fn note<T>(&self, r: turso::Result<T>) -> Result<T> {
        r.map_err(|e| {
            self.failed.set(true);
            anyhow!(e)
        })
    }

    /// Run a statement that returns no rows; the number of rows changed.
    pub fn execute(&self, sql: &str, p: impl IntoParams) -> Result<u64> {
        self.guard()?;
        self.note(block_on(self.c.execute(sql, p)))
    }

    /// Several `;`-separated statements, no parameters.
    pub fn execute_batch(&self, sql: &str) -> Result<()> {
        self.guard()?;
        self.note(block_on(self.c.execute_batch(sql)))
    }

    /// Every row, mapped by `f`.
    pub fn query<T>(&self, sql: &str, p: impl IntoParams, mut f: impl FnMut(&Row) -> Result<T>) -> Result<Vec<T>> {
        self.guard()?;
        let mut out = Vec::new();
        let mut mapped: Result<()> = Ok(());
        let r: turso::Result<()> = block_on(async {
            let mut rows = self.c.query(sql, p).await?;
            while let Some(row) = rows.next().await? {
                if mapped.is_ok() {
                    match f(&row) {
                        Ok(v) => out.push(v),
                        Err(e) => mapped = Err(e),
                    }
                }
            }
            Ok(())
        });
        self.note(r)?;
        mapped?;
        Ok(out)
    }

    /// The first row, or `None` when the query returns none. A real error is an error.
    pub fn query_opt<T>(&self, sql: &str, p: impl IntoParams, mut f: impl FnMut(&Row) -> Result<T>) -> Result<Option<T>> {
        let mut first = true;
        let rows = self.query(sql, p, |r| {
            if std::mem::take(&mut first) {
                f(r).map(Some)
            } else {
                Ok(None)
            }
        })?;
        Ok(rows.into_iter().next().flatten())
    }

    /// The first row; no rows is an error.
    pub fn query_row<T>(&self, sql: &str, p: impl IntoParams, f: impl FnMut(&Row) -> Result<T>) -> Result<T> {
        self.query_opt(sql, p, f)?.ok_or_else(|| anyhow!("query returned no rows"))
    }

    /// A single integer (counts, pragmas).
    pub fn scalar_i64(&self, sql: &str, p: impl IntoParams) -> Result<i64> {
        self.query_row(sql, p, |r| Ok(r.get::<i64>(0)?))
    }
}

// ---------------------------------------------------------------- database

pub struct Db {
    conn: Mutex<turso::Connection>,
    /// Kept alive for the connection; dropped after it (field order).
    _db: turso::Database,
    path: PathBuf,
    /// (device, inode) of the database file when opened.
    ident: (u64, u64),
}

fn pragma_i64(conn: &turso::Connection, sql: &str) -> Result<i64> {
    let c = Conn { c: conn, failed: Cell::new(false) };
    c.scalar_i64(sql, ())
}

fn is_lock_error(e: &str) -> bool {
    e.contains("locked by another process") || e.contains("database is locked")
}

/// Read-only look at an existing file before anything may modify it: its schema version and a quick
/// integrity check. Nothing is written, not even a `-shm`.
fn probe(path: &Path) -> Result<i64> {
    let p = path.to_str().ok_or_else(|| anyhow!("database path is not UTF-8"))?;
    let open = || -> Result<(turso::Database, turso::Connection)> {
        let db = block_on(turso::Builder::new_local(p).read_only(true).build())?;
        let conn = db.connect()?;
        Ok((db, conn))
    };
    let (_db, conn) = open().map_err(|e| {
        if is_lock_error(&format!("{e:#}")) {
            anyhow!("{} is in use by another Setu process; only one daemon may open it", path.display())
        } else {
            anyhow!("cannot open {} read-only: {e:#}", path.display())
        }
    })?;
    let version = pragma_i64(&conn, "PRAGMA user_version").with_context(|| format!("reading the schema version of {}", path.display()))?;
    if version > SCHEMA_VERSION {
        bail!(
            "{} was written by a newer Setu (database schema v{version}; this build understands up to v{SCHEMA_VERSION}). Refusing to open it; the file was not modified. Update Setu.",
            path.display()
        );
    }
    let c = Conn { c: &conn, failed: Cell::new(false) };
    let check = c.query("PRAGMA quick_check", (), |r| Ok(r.get::<String>(0)?)).with_context(|| format!("checking {}", path.display()))?;
    if check != ["ok"] {
        bail!(
            "{} failed its integrity check ({}). Refusing to open it; the file was not modified. Move it aside to start with an empty database (the JSON state is not rebuilt automatically).",
            path.display(),
            check.join("; ").chars().take(200).collect::<String>()
        );
    }
    Ok(version)
}

impl Db {
    /// Open (creating mode 0600 in a 0700 dir), set the pragmas and bring the schema to the latest version.
    /// An existing file is first examined read-only: a database from a newer Setu, or one that fails its
    /// integrity check, is refused without being touched.
    pub fn open(path: &Path) -> Result<Db> {
        let dir = path.parent().filter(|d| !d.as_os_str().is_empty()).unwrap_or(Path::new("."));
        std::fs::DirBuilder::new().recursive(true).mode(0o700).create(dir).with_context(|| format!("creating {}", dir.display()))?;
        std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700)).with_context(|| format!("securing {}", dir.display()))?;
        let existing = std::fs::metadata(path).map(|m| m.len() > 0).unwrap_or(false);
        let version = if existing { probe(path)? } else { 0 };
        // Create the file ourselves so it is 0600 from the first byte (the -wal gets the same mode).
        // Turso does not copy the database file's mode onto the WAL (SQLite does), so make that file ourselves too.
        for f in [path.to_path_buf(), PathBuf::from(format!("{}-wal", path.display()))] {
            std::fs::OpenOptions::new().create(true).append(true).mode(0o600).open(&f).with_context(|| format!("creating {}", f.display()))?;
        }
        let p = path.to_str().ok_or_else(|| anyhow!("database path is not UTF-8"))?;
        let db = block_on(turso::Builder::new_local(p).build()).with_context(|| format!("opening {}", path.display()))?;
        let conn = db.connect().with_context(|| format!("opening {}", path.display()))?;
        conn.busy_timeout(Duration::from_millis(5000))?;
        let c = Conn { c: &conn, failed: Cell::new(false) };
        let mode = c.query("PRAGMA journal_mode=WAL", (), |r| Ok(r.get::<String>(0)?))?;
        if mode.first().map(|m| m.to_lowercase()).as_deref() != Some("wal") {
            bail!("{} could not be put in WAL mode (got {mode:?})", path.display());
        }
        c.execute("PRAGMA synchronous=NORMAL", ())?;
        c.execute("PRAGMA foreign_keys=ON", ())?;
        if version > 0 && version < SCHEMA_VERSION {
            backup(&c, path, version).with_context(|| format!("backing up {} before migrating it", path.display()))?;
        }
        migrate(&c, MIGRATIONS).with_context(|| format!("migrating {}", path.display()))?;
        drop(c);
        let md = std::fs::metadata(path)?;
        Ok(Db { conn: Mutex::new(conn), _db: db, path: path.to_path_buf(), ident: (md.dev(), md.ino()) })
    }

    #[cfg(test)]
    pub fn path(&self) -> &Path {
        &self.path
    }

    /// True while the file at `path` is still the one this handle opened.
    fn is_current(&self) -> bool {
        std::fs::metadata(&self.path).is_ok_and(|m| (m.dev(), m.ino()) == self.ident)
    }

    /// Put an abandoned transaction (a closure that panicked) behind us.
    fn settle(conn: &turso::Connection) {
        if matches!(conn.is_autocommit(), Ok(false)) {
            let _ = block_on(conn.execute("ROLLBACK", ()));
        }
    }

    /// Run `f` on the connection (reads, single statements). Blocking: call from a blocking thread.
    pub fn with<T>(&self, f: impl FnOnce(&Conn) -> Result<T>) -> Result<T> {
        let conn = self.conn.lock().unwrap_or_else(|e| e.into_inner());
        Self::settle(&conn);
        f(&Conn { c: &conn, failed: Cell::new(false) })
    }

    /// Run `f` in one write transaction (BEGIN IMMEDIATE); commits on Ok, rolls back on Err. A failed
    /// statement inside poisons the transaction even if `f` swallows the error.
    pub fn tx<T>(&self, f: impl FnOnce(&Conn) -> Result<T>) -> Result<T> {
        let conn = self.conn.lock().unwrap_or_else(|e| e.into_inner());
        Self::settle(&conn);
        let c = Conn { c: &conn, failed: Cell::new(false) };
        c.execute("BEGIN IMMEDIATE", ())?;
        let out = f(&c);
        if out.is_ok() && !c.failed.get() {
            match block_on(conn.execute("COMMIT", ())) {
                Ok(_) => {
                    self.trim_wal(&conn);
                    return out;
                }
                Err(e) => {
                    let _ = block_on(conn.execute("ROLLBACK", ()));
                    return Err(anyhow!(e).context("committing the transaction"));
                }
            }
        }
        // Turso has already ended the transaction after a failed statement; ROLLBACK then says so. Ignore that.
        if matches!(conn.is_autocommit(), Ok(false)) {
            let _ = block_on(conn.execute("ROLLBACK", ()));
        }
        match out {
            Err(e) => Err(e),
            Ok(_) => bail!("a statement in the transaction failed and was swallowed; the transaction was rolled back"),
        }
    }

    /// Turso's automatic checkpoint folds the WAL into the main file but did not shrink the file in a
    /// long-lived handle (it grew without bound in testing), so once it passes WAL_LIMIT after a commit
    /// the daemon truncates it. Best effort: a failure only means the WAL stays larger for now.
    fn trim_wal(&self, conn: &turso::Connection) {
        let wal = format!("{}-wal", self.path.display());
        if std::fs::metadata(&wal).is_ok_and(|m| m.len() > WAL_LIMIT) {
            let c = Conn { c: conn, failed: Cell::new(false) };
            let _ = c.query("PRAGMA wal_checkpoint(TRUNCATE)", (), |_| Ok(()));
        }
    }

    /// `with` for callers on the async runtime: runs on the blocking pool.
    pub async fn with_async<T: Send + 'static>(self: &Arc<Self>, f: impl FnOnce(&Conn) -> Result<T> + Send + 'static) -> Result<T> {
        let db = self.clone();
        tokio::task::spawn_blocking(move || db.with(f)).await?
    }

    /// `tx` for callers on the async runtime: runs on the blocking pool.
    #[allow(dead_code)] // the async twin of `tx`; exercised by the tests, no runtime caller needs it yet
    pub async fn tx_async<T: Send + 'static>(self: &Arc<Self>, f: impl FnOnce(&Conn) -> Result<T> + Send + 'static) -> Result<T> {
        let db = self.clone();
        tokio::task::spawn_blocking(move || db.tx(f)).await?
    }

    /// Fold the WAL into the main file and empty it.
    #[cfg(test)]
    pub fn checkpoint(&self) -> Result<()> {
        self.with(|c| c.query("PRAGMA wal_checkpoint(TRUNCATE)", (), |_| Ok(())).map(|_| ()))
    }
}

/// Apply the steps after the current `user_version`, each in its own transaction together with the
/// version bump, so a crash leaves either the old or the new version, never half a step.
fn migrate(c: &Conn, steps: &[&str]) -> Result<()> {
    let current = c.scalar_i64("PRAGMA user_version", ())?;
    if current as usize > steps.len() {
        bail!("database schema v{current} is newer than this build (v{})", steps.len());
    }
    for (i, sql) in steps.iter().enumerate().skip(current as usize) {
        let r = (|| -> Result<()> {
            c.execute("BEGIN IMMEDIATE", ())?;
            c.execute_batch(sql)?;
            c.execute(&format!("PRAGMA user_version = {}", i + 1), ())?;
            c.execute("COMMIT", ())?;
            Ok(())
        })();
        if let Err(e) = r {
            if matches!(c.c.is_autocommit(), Ok(false)) {
                let _ = block_on(c.c.execute("ROLLBACK", ()));
            }
            return Err(e.context(format!("migration to schema v{}", i + 1)));
        }
    }
    Ok(())
}

/// Copy the database (after a checkpoint, so the main file is complete) to
/// `backups/setu-v<old>-<ts>.db`, mode 0600, and keep the newest three. `VACUUM INTO` is not used:
/// it cannot read the WITHOUT ROWID tables of databases made by the rusqlite builds.
fn backup(c: &Conn, path: &Path, from_version: i64) -> Result<PathBuf> {
    c.query("PRAGMA wal_checkpoint(TRUNCATE)", (), |_| Ok(()))?;
    let dir = path.parent().unwrap_or(Path::new(".")).join("backups");
    std::fs::DirBuilder::new().recursive(true).mode(0o700).create(&dir)?;
    std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700))?;
    let ts = now_secs();
    let mut n = 0;
    let dest = loop {
        let name = if n == 0 { format!("setu-v{from_version}-{ts}.db") } else { format!("setu-v{from_version}-{ts}-{n}.db") };
        let dest = dir.join(name);
        match std::fs::OpenOptions::new().write(true).create_new(true).mode(0o600).open(&dest) {
            Ok(mut out) => {
                let mut src = std::fs::File::open(path)?;
                std::io::copy(&mut src, &mut out)?;
                out.flush()?;
                out.sync_all()?;
                break dest;
            }
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => n += 1,
            Err(e) => return Err(e.into()),
        }
    };
    // Anything the checkpoint could not fold in travels with the copy.
    let wal = PathBuf::from(format!("{}-wal", path.display()));
    if std::fs::metadata(&wal).is_ok_and(|m| m.len() > 0) {
        let mut out = std::fs::OpenOptions::new().write(true).create_new(true).mode(0o600).open(format!("{}-wal", dest.display()))?;
        std::io::copy(&mut std::fs::File::open(&wal)?, &mut out)?;
        out.sync_all()?;
    }
    let mut all: Vec<(std::time::SystemTime, PathBuf)> = std::fs::read_dir(&dir)?
        .filter_map(|e| e.ok())
        .filter(|e| {
            let n = e.file_name().to_string_lossy().to_string();
            n.starts_with("setu-v") && n.ends_with(".db")
        })
        .filter_map(|e| Some((e.metadata().ok()?.modified().ok()?, e.path())))
        .collect();
    all.sort();
    while all.len() > BACKUPS_KEEP {
        let (_, old) = all.remove(0);
        let _ = std::fs::remove_file(format!("{}-wal", old.display()));
        let _ = std::fs::remove_file(old);
    }
    Ok(dest)
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
    // Let go of a handle to a replaced file before opening the new one.
    reg.remove(&path);
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

pub fn insert_event(conn: &Conn, e: &Event) -> Result<()> {
    conn.execute(
        "INSERT INTO events (ts, actor, client, kind, op, run_key, scope, name, detail_json) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
        params![e.ts as i64, e.actor.clone(), e.client.clone(), e.kind, e.op.clone(), e.run_key.clone(), e.scope.clone(), e.name.clone(), e.detail.to_string()],
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
        c.query(
            "SELECT id, ts, actor, client, kind, op, run_key, scope, name, detail_json FROM events
             WHERE (?1 IS NULL OR kind = ?1) AND (?2 IS NULL OR run_key = ?2) AND (?3 IS NULL OR ts >= ?3)
             ORDER BY id DESC LIMIT ?4",
            params![kind, run, since.map(|s| s as i64), limit],
            |r| {
                let detail: String = r.get(9)?;
                Ok(json!({
                    "id": r.get::<i64>(0)?,
                    "ts": r.get::<i64>(1)?,
                    "actor": r.get::<Option<String>>(2)?,
                    "client": r.get::<Option<String>>(3)?,
                    "kind": r.get::<String>(4)?,
                    "op": r.get::<String>(5)?,
                    "run": r.get::<Option<String>>(6)?,
                    "scope": r.get::<Option<String>>(7)?,
                    "name": r.get::<Option<String>>(8)?,
                    "detail": serde_json::from_str::<Value>(&detail).unwrap_or(Value::Null),
                }))
            },
        )
    })
}

pub fn now_secs() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use std::io::{BufRead, BufReader};
    use std::process::{Command, Stdio};

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

    fn fixture(name: &str) -> PathBuf {
        Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures").join(name)
    }

    /// Copy a rusqlite-era fixture (and its -wal, if any) into a fresh temp dir.
    fn stage_fixture(tag: &str, name: &str) -> (PathBuf, PathBuf) {
        let d = tmp(tag);
        std::fs::create_dir_all(&d).unwrap();
        let dst = d.join("setu.db");
        std::fs::copy(fixture(name), &dst).unwrap();
        let wal = PathBuf::from(format!("{}-wal", fixture(name).display()));
        if wal.exists() {
            std::fs::copy(&wal, format!("{}-wal", dst.display())).unwrap();
        }
        (d, dst)
    }

    fn files(dir: &Path) -> Vec<(String, Vec<u8>)> {
        let mut v: Vec<_> = std::fs::read_dir(dir).unwrap().flatten().filter(|e| e.path().is_file()).map(|e| (e.file_name().to_string_lossy().into_owned(), std::fs::read(e.path()).unwrap())).collect();
        v.sort();
        v
    }

    #[test]
    fn fresh_database_has_pragmas_modes_and_latest_schema() {
        let (db, d) = temp_db("fresh");
        assert_eq!(mode(&d), 0o700);
        assert_eq!(mode(&d.join("setu.db")), 0o600);
        db.with(|c| {
            let jm: String = c.query_row("PRAGMA journal_mode", (), |r| Ok(r.get(0)?))?;
            let sync = c.scalar_i64("PRAGMA synchronous", ())?;
            let fk = c.scalar_i64("PRAGMA foreign_keys", ())?;
            let bt = c.scalar_i64("PRAGMA busy_timeout", ())?;
            assert_eq!((jm.as_str(), sync, fk, bt), ("wal", 1, 1, 5000));
            let tables: Vec<String> = c.query("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '__turso_internal%' ORDER BY name", (), |r| Ok(r.get(0)?))?;
            assert_eq!(tables, ["autoremove", "claims", "events", "leases", "meta", "removal_ops", "runs"]);
            assert_eq!(c.scalar_i64("SELECT count(*) FROM sqlite_master WHERE type='index' AND name LIKE 'events_%'", ())?, 3);
            assert_eq!(c.scalar_i64("PRAGMA user_version", ())?, SCHEMA_VERSION);
            let meta_sql: String = c.query_row("SELECT sql FROM sqlite_master WHERE name = 'meta'", (), |r| Ok(r.get(0)?))?;
            assert!(!meta_sql.to_uppercase().contains("WITHOUT ROWID"), "{meta_sql}");
            Ok(())
        })
        .unwrap();
        // the WAL has the same restrictive mode, also after writes and a checkpoint
        db.with(|c| c.execute("INSERT INTO meta VALUES ('k','v')", ())).unwrap();
        assert_eq!(mode(&d.join("setu.db-wal")), 0o600);
        db.checkpoint().unwrap();
        for side in ["setu.db-wal", "setu.db-shm"] {
            if d.join(side).exists() {
                assert_eq!(mode(&d.join(side)), 0o600, "{side}");
            }
        }
        assert!(!d.join("backups").exists(), "a fresh database has nothing to back up");
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn opens_a_database_created_by_the_rusqlite_build() {
        for name in ["rusqlite-v2.db", "rusqlite-v2-wal.db"] {
            let (d, path) = stage_fixture(&format!("fx-{}", name.len()), name);
            let db = Db::open(&path).unwrap_or_else(|e| panic!("{name}: {e:#}"));
            db.with(|c| {
                assert_eq!(c.scalar_i64("PRAGMA user_version", ())?, SCHEMA_VERSION, "{name}");
                assert_eq!(c.scalar_i64("SELECT count(*) FROM runs WHERE key = 'e2e/feat-one'", ())?, 1);
                let lease: i64 = c.scalar_i64("SELECT port FROM leases WHERE run_key = 'e2e/feat-one' AND name = 'web'", ())?;
                assert_eq!(lease, 4426);
                let holder: String = c.query_row("SELECT holder FROM claims WHERE run_key = 'e2e/feat-one'", (), |r| Ok(r.get(0)?))?;
                assert_eq!(holder, "fixture-agent");
                let events = c.scalar_i64("SELECT count(*) FROM events", ())?;
                assert_eq!(events, if name.contains("wal") { 10 } else { 9 }, "{name}: rows that only lived in the old WAL are kept");
                // new event ids continue after the SQLite-assigned ones (no reuse, order preserved)
                insert_event(c, &Event { ts: 1, actor: None, client: None, kind: "env", op: "after-upgrade".into(), run_key: None, scope: None, name: None, detail: json!({}) })?;
                let max_old = c.scalar_i64("SELECT max(id) FROM events WHERE op <> 'after-upgrade'", ())?;
                let new_id = c.scalar_i64("SELECT id FROM events WHERE op = 'after-upgrade'", ())?;
                assert!(new_id > max_old, "{name}: new id {new_id} must follow {max_old}");
                c.execute("DELETE FROM events WHERE op = 'after-upgrade'", ())?;
                // meta was WITHOUT ROWID; it is now an ordinary, updatable table with its rows
                assert_eq!(c.scalar_i64("SELECT count(*) FROM meta WHERE key = 'imported_from_json'", ())?, 1);
                c.execute("UPDATE meta SET value = 'x' WHERE key = 'imported_from_json'", ())?;
                c.execute("DELETE FROM meta WHERE key = 'imported_from_json'", ())?;
                Ok(())
            })
            .unwrap();
            // the old state loads through the normal reader
            let st = crate::state::load(&db).unwrap();
            assert_eq!(st.leases["e2e/feat-one"]["web"], 4426);
            // and it was backed up before the v2 -> v3 migration
            let backups: Vec<_> = std::fs::read_dir(d.join("backups")).unwrap().flatten().map(|e| e.file_name().to_string_lossy().into_owned()).collect();
            assert!(backups.iter().any(|b| b.starts_with("setu-v2-") && b.ends_with(".db")), "{backups:?}");
            drop(db);
            let _ = std::fs::remove_dir_all(&d);
        }
    }

    #[test]
    fn a_backup_is_taken_before_migrating_and_only_the_last_three_are_kept() {
        let (d, path) = stage_fixture("backup", "rusqlite-v2.db");
        let original = std::fs::read(&path).unwrap();
        // old backups from earlier migrations exist already
        let bdir = d.join("backups");
        std::fs::create_dir_all(&bdir).unwrap();
        for i in 0..4 {
            std::fs::write(bdir.join(format!("setu-v1-{i}.db")), b"old").unwrap();
            std::thread::sleep(Duration::from_millis(20));
        }
        drop(Db::open(&path).unwrap());
        let mut names: Vec<String> = std::fs::read_dir(&bdir).unwrap().flatten().map(|e| e.file_name().to_string_lossy().into_owned()).collect();
        names.sort();
        assert_eq!(names.len(), BACKUPS_KEEP, "{names:?}");
        let new = names.iter().find(|n| n.starts_with("setu-v2-")).expect("the new backup survives pruning");
        let copy = bdir.join(new);
        assert_eq!(mode(&copy), 0o600);
        assert_eq!(mode(&bdir), 0o700);
        // the backup is the pre-migration database: same rows, schema v2
        let body = std::fs::read(&copy).unwrap();
        assert_eq!(body.len(), original.len());
        let b = Db::open_raw_for_test(&copy);
        assert_eq!(b, 2, "the backup keeps the old schema version");
        // reopening at the latest version makes no further backup
        let before = std::fs::read_dir(&bdir).unwrap().count();
        drop(Db::open(&path).unwrap());
        assert_eq!(std::fs::read_dir(&bdir).unwrap().count(), before);
        let _ = std::fs::remove_dir_all(&d);
    }

    impl Db {
        /// Schema version of a file, read read-only (test helper).
        fn open_raw_for_test(p: &Path) -> i64 {
            let copy = p.with_extension("probe.db");
            std::fs::copy(p, &copy).unwrap();
            let v = probe_version_only(&copy);
            let _ = std::fs::remove_file(&copy);
            v
        }
    }

    fn probe_version_only(p: &Path) -> i64 {
        let db = block_on(turso::Builder::new_local(p.to_str().unwrap()).read_only(true).build()).unwrap();
        let conn = db.connect().unwrap();
        pragma_i64(&conn, "PRAGMA user_version").unwrap()
    }

    #[test]
    fn a_newer_database_is_refused_and_left_byte_identical() {
        // case 1: the newer version is in the main file's header
        let (d, path) = stage_fixture("newer-main", "rusqlite-v2.db");
        {
            let db = Db::open(&path).unwrap();
            db.with(|c| c.execute(&format!("PRAGMA user_version = {}", SCHEMA_VERSION + 1), ())).unwrap();
            db.checkpoint().unwrap();
        }
        // a single-file database: no -wal at all, so a stray sidecar would show up as a new file
        let _ = std::fs::remove_file(format!("{}-wal", path.display()));
        let before = files(&d);
        let err = Db::open(&path).err().expect("must refuse").to_string();
        assert!(err.contains("newer Setu") && err.contains(&format!("v{}", SCHEMA_VERSION + 1)), "{err}");
        assert_eq!(files(&d), before, "refusal must not touch the file or create sidecars");
        let _ = std::fs::remove_dir_all(&d);

        // case 2: the newer version only exists in the un-checkpointed WAL
        let (d, path) = stage_fixture("newer-wal", "rusqlite-v2.db");
        drop(Db::open(&path).unwrap());
        let me = std::env::current_exe().unwrap();
        let st = Command::new(me).args(["db::tests::child_set_version_and_exit", "--exact", "--nocapture", "--test-threads=1"]).env("SETU_TEST_CHILD_DB", &path).status().unwrap();
        assert!(st.success());
        let wal = PathBuf::from(format!("{}-wal", path.display()));
        assert!(std::fs::metadata(&wal).map(|m| m.len() > 0).unwrap_or(false), "the child left its change in the WAL");
        let before = files(&d);
        let err = Db::open(&path).err().expect("must refuse").to_string();
        assert!(err.contains("newer Setu"), "{err}");
        assert_eq!(files(&d), before);
        let _ = std::fs::remove_dir_all(&d);
    }

    /// Child half of the test above: bump the schema version, then exit without closing or checkpointing.
    #[test]
    fn child_set_version_and_exit() {
        let Some(p) = std::env::var_os("SETU_TEST_CHILD_DB") else { return };
        let db = Db::open(Path::new(&p)).unwrap();
        db.with(|c| c.execute(&format!("PRAGMA user_version = {}", SCHEMA_VERSION + 4), ())).unwrap();
        std::process::exit(0);
    }

    #[test]
    fn a_corrupt_file_is_refused_untouched() {
        let d = tmp("corrupt");
        std::fs::create_dir_all(&d).unwrap();
        let path = d.join("setu.db");
        std::fs::write(&path, b"this is not a database, but it is long enough to look like one".repeat(200)).unwrap();
        let before = files(&d);
        assert!(Db::open(&path).is_err());
        assert_eq!(files(&d), before);
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn a_failed_migration_step_rolls_back_with_its_version_bump() {
        let (db, d) = temp_db("migfail");
        let r = db.with(|c| {
            let steps: &[&str] = &[V1, V2, V3, "CREATE TABLE half (x INTEGER); INSERT INTO half VALUES (1); INSERT INTO no_such_table VALUES (1);"];
            migrate(c, steps)
        });
        assert!(r.unwrap_err().to_string().contains("migration to schema v4"));
        db.with(|c| {
            assert_eq!(c.scalar_i64("PRAGMA user_version", ())?, SCHEMA_VERSION, "the version did not advance");
            assert_eq!(c.scalar_i64("SELECT count(*) FROM sqlite_master WHERE name = 'half'", ())?, 0, "the half-applied step left nothing");
            Ok(())
        })
        .unwrap();
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
            tx.execute("INSERT INTO meta VALUES ('a', '1')", ())?;
            bail!("boom")
        });
        assert!(r.is_err());
        assert_eq!(db.with(|c| c.scalar_i64("SELECT count(*) FROM meta", ())).unwrap(), 0);
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn a_failed_statement_poisons_the_transaction_even_if_the_caller_swallows_it() {
        let (db, d) = temp_db("poison");
        let r = db.tx(|tx| {
            tx.execute("INSERT INTO meta VALUES ('keep', '1')", ())?;
            // a constraint failure the closure ignores: Turso has already ended the transaction
            let _ = tx.execute("INSERT INTO meta VALUES ('keep', '2')", ());
            let second = tx.execute("INSERT INTO meta VALUES ('later', '3')", ());
            assert!(second.is_err(), "nothing may run after a failed statement");
            Ok(())
        });
        assert!(r.is_err(), "a swallowed failure must not turn into a commit");
        assert_eq!(db.with(|c| c.scalar_i64("SELECT count(*) FROM meta", ())).unwrap(), 0, "no partial commit");
        // the connection is usable afterwards
        db.with(|c| c.execute("INSERT INTO meta VALUES ('ok', '1')", ())).unwrap();
        assert_eq!(db.with(|c| c.scalar_i64("SELECT count(*) FROM meta", ())).unwrap(), 1);
        // "no rows" is not an engine error and does not poison
        db.tx(|tx| {
            assert!(tx.query_opt("SELECT value FROM meta WHERE key = 'zz'", (), |r| Ok(r.get::<String>(0)?))?.is_none());
            assert!(tx.query_row("SELECT value FROM meta WHERE key = 'zz'", (), |r| Ok(r.get::<String>(0)?)).is_err());
            tx.execute("INSERT INTO meta VALUES ('after', '1')", ())?;
            Ok(())
        })
        .unwrap();
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn a_panic_inside_a_transaction_does_not_leave_the_connection_stuck() {
        let (db, d) = temp_db("panic");
        let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let _ = db.tx(|tx| {
                tx.execute("INSERT INTO meta VALUES ('p', '1')", ())?;
                panic!("boom");
                #[allow(unreachable_code)]
                Ok(())
            });
        }));
        assert!(r.is_err());
        db.tx(|tx| tx.execute("INSERT INTO meta VALUES ('q', '1')", ())).unwrap();
        assert_eq!(db.with(|c| c.scalar_i64("SELECT count(*) FROM meta", ())).unwrap(), 1, "the abandoned transaction was rolled back");
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn a_second_process_cannot_open_the_database_while_the_daemon_has_it() {
        let (db, d) = temp_db("lock");
        let me = std::env::current_exe().unwrap();
        let out = Command::new(me).args(["db::tests::child_try_open", "--exact", "--nocapture", "--test-threads=1"]).env("SETU_TEST_CHILD_DB", db.path()).output().unwrap();
        let text = String::from_utf8_lossy(&out.stdout);
        assert!(text.contains("CHILD-REFUSED"), "{text}");
        // and the holder is unharmed
        db.with(|c| c.execute("INSERT INTO meta VALUES ('still', 'fine')", ())).unwrap();
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn child_try_open() {
        let Some(p) = std::env::var_os("SETU_TEST_CHILD_DB") else { return };
        match Db::open(Path::new(&p)) {
            Ok(_) => println!("CHILD-OPENED"),
            Err(e) => println!("CHILD-REFUSED {e:#}"),
        }
    }

    /// Child: open, start a transaction, write rows, report READY, then wait to be killed (never commits).
    #[test]
    fn child_write_uncommitted() {
        let Some(p) = std::env::var_os("SETU_TEST_CHILD_DB") else { return };
        let db = Db::open(Path::new(&p)).unwrap();
        let _ = db.tx(|tx| {
            for i in 0..50 {
                tx.execute("INSERT INTO events (ts, kind, op) VALUES (?1, 'env', 'uncommitted')", params![i as i64])?;
            }
            println!("READY");
            use std::io::Write;
            std::io::stdout().flush().unwrap();
            std::thread::sleep(Duration::from_secs(60));
            Ok(())
        });
    }

    /// Child: commit two-row transactions forever, printing each acknowledged one.
    #[test]
    fn child_commit_pairs() {
        let Some(p) = std::env::var_os("SETU_TEST_CHILD_DB") else { return };
        let db = Db::open(Path::new(&p)).unwrap();
        for i in 0..1_000_000i64 {
            db.tx(|tx| {
                tx.execute("INSERT INTO meta VALUES (?1, 'a')", params![format!("pair-{i}-a")])?;
                tx.execute("INSERT INTO meta VALUES (?1, 'b')", params![format!("pair-{i}-b")])?;
                Ok(())
            })
            .unwrap();
            println!("ACK {i}");
            use std::io::Write;
            std::io::stdout().flush().unwrap();
        }
    }

    fn spawn_child(test: &str, db: &Path) -> std::process::Child {
        Command::new(std::env::current_exe().unwrap())
            .args([&format!("db::tests::{test}"), "--exact", "--nocapture", "--test-threads=1"])
            .env("SETU_TEST_CHILD_DB", db)
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .unwrap()
    }

    #[test]
    fn a_process_killed_mid_transaction_leaves_a_consistent_database() {
        let (db, d) = temp_db("kill-uncommitted");
        let path = db.path().to_path_buf();
        drop(db);
        for round in 0..5 {
            let mut child = spawn_child("child_write_uncommitted", &path);
            let mut out = BufReader::new(child.stdout.take().unwrap());
            let mut line = String::new();
            loop {
                line.clear();
                assert!(out.read_line(&mut line).unwrap() > 0, "child exited before READY (round {round})");
                if line.contains("READY") {
                    break;
                }
            }
            child.kill().unwrap();
            child.wait().unwrap();
            let db = Db::open(&path).unwrap_or_else(|e| panic!("reopen after kill, round {round}: {e:#}"));
            db.with(|c| {
                assert_eq!(c.scalar_i64("SELECT count(*) FROM events WHERE op = 'uncommitted'", ())?, 0, "an uncommitted transaction leaves nothing");
                let ic: Vec<String> = c.query("PRAGMA integrity_check", (), |r| Ok(r.get(0)?))?;
                assert_eq!(ic, ["ok"]);
                Ok(())
            })
            .unwrap();
        }
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn a_process_killed_between_commits_keeps_every_acknowledged_transaction() {
        let (db, d) = temp_db("kill-commits");
        let path = db.path().to_path_buf();
        drop(db);
        for round in 0..6u64 {
            let mut child = spawn_child("child_commit_pairs", &path);
            let mut out = BufReader::new(child.stdout.take().unwrap());
            let mut last: i64 = -1;
            let mut line = String::new();
            // let it commit a varying number of transactions, then kill it without warning
            let stop_at = 5 + (round as i64 * 37) % 60;
            while last < stop_at {
                line.clear();
                if out.read_line(&mut line).unwrap() == 0 {
                    break;
                }
                if let Some(n) = line.trim().strip_prefix("ACK ") {
                    last = n.parse().unwrap();
                }
            }
            child.kill().unwrap();
            child.wait().unwrap();
            assert!(last >= 0, "child committed nothing in round {round}");
            let db = Db::open(&path).unwrap_or_else(|e| panic!("reopen after kill, round {round}: {e:#}"));
            db.with(|c| {
                let ic: Vec<String> = c.query("PRAGMA integrity_check", (), |r| Ok(r.get(0)?))?;
                assert_eq!(ic, ["ok"]);
                // every acknowledged pair is present, and no pair is half there
                let n = c.scalar_i64("SELECT count(*) FROM meta WHERE key LIKE 'pair-%'", ())?;
                assert_eq!(n % 2, 0, "round {round}: a half-committed pair");
                for i in 0..=last {
                    let both = c.scalar_i64("SELECT count(*) FROM meta WHERE key IN (?1, ?2)", params![format!("pair-{i}-a"), format!("pair-{i}-b")])?;
                    assert_eq!(both, 2, "round {round}: acknowledged pair {i} lost");
                }
                Ok(())
            })
            .unwrap();
            // the next child counts from 0 again: clear the pairs so every round is checked exactly
            db.with(|c| c.execute("DELETE FROM meta WHERE key LIKE 'pair-%'", ())).unwrap();
        }
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn a_ticker_keeps_running_while_a_transaction_is_open() {
        let rt = tokio::runtime::Builder::new_current_thread().enable_time().build().unwrap();
        rt.block_on(async {
            let (db, d) = temp_db("ticker");
            let db = Arc::new(db);
            let ticks = Arc::new(std::sync::atomic::AtomicU32::new(0));
            let t = ticks.clone();
            let ticker = tokio::spawn(async move {
                loop {
                    tokio::time::sleep(Duration::from_millis(5)).await;
                    t.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                }
            });
            let seen_during = db
                .tx_async({
                    let ticks = ticks.clone();
                    move |tx| {
                        tx.execute("INSERT INTO meta VALUES ('slow', '1')", ())?;
                        let before = ticks.load(std::sync::atomic::Ordering::SeqCst);
                        std::thread::sleep(Duration::from_millis(200));
                        Ok(ticks.load(std::sync::atomic::Ordering::SeqCst) - before)
                    }
                })
                .await
                .unwrap();
            ticker.abort();
            assert!(seen_during >= 10, "the runtime kept scheduling while the transaction held the database ({seen_during} ticks)");
            assert_eq!(db.with_async(|c| c.scalar_i64("SELECT count(*) FROM meta", ())).await.unwrap(), 1);
            let _ = std::fs::remove_dir_all(&d);
        });
    }

    #[test]
    fn the_wal_stays_bounded_over_many_transactions() {
        let (db, d) = temp_db("walgrow");
        let wal = d.join("setu.db-wal");
        let mut sizes = Vec::new();
        for round in 0..6 {
            for i in 0..1500 {
                db.tx(|tx| {
                    tx.execute("INSERT INTO events (ts, kind, op, detail_json) VALUES (?1, 'env', 'grow', ?2)", params![i as i64, "x".repeat(200)])?;
                    tx.execute("INSERT INTO meta VALUES (?1, 'v') ON CONFLICT(key) DO UPDATE SET value = excluded.value", params![format!("k{}", i % 50)])?;
                    Ok(())
                })
                .unwrap();
            }
            sizes.push(std::fs::metadata(&wal).map(|m| m.len()).unwrap_or(0));
            eprintln!("round {round}: wal {} bytes", sizes.last().unwrap());
        }
        let max = *sizes.iter().max().unwrap();
        assert!(max < WAL_LIMIT + 512 * 1024, "the WAL grew to {max} bytes over {sizes:?}");
        let ic: Vec<String> = db.with(|c| c.query("PRAGMA integrity_check", (), |r| Ok(r.get(0)?))).unwrap();
        assert_eq!(ic, ["ok"]);
        assert_eq!(db.with(|c| c.scalar_i64("SELECT count(*) FROM events WHERE op = 'grow'", ())).unwrap(), 9000);
        let _ = std::fs::remove_dir_all(&d);
    }
}
