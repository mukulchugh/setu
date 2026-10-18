//! The one durable mailbox store. Only this process opens the database.

use crate::args::Fail;
use rusqlite::{Connection, OpenFlags};
use std::{
    fs,
    os::unix::fs::{DirBuilderExt, PermissionsExt},
    path::{Path, PathBuf},
};

pub const SCHEMA_VERSION: i64 = 1;
const DATABASE: &str = "mailbox.sqlite3";

const SCHEMA: &str = "
CREATE TABLE messages (
    id TEXT PRIMARY KEY,
    sender TEXT NOT NULL,
    idempotency_key TEXT NOT NULL,
    payload_digest TEXT NOT NULL,
    kind TEXT NOT NULL,
    body TEXT NOT NULL,
    size INTEGER NOT NULL,
    reply_to TEXT,
    run_hint TEXT,
    span_hint TEXT,
    provider TEXT NOT NULL,
    native_id TEXT NOT NULL,
    checkout TEXT NOT NULL,
    session_hint TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    UNIQUE (sender, idempotency_key)
);
CREATE INDEX messages_recipient ON messages (provider, native_id, checkout);
CREATE INDEX messages_session ON messages (session_hint);
CREATE TRIGGER messages_immutable BEFORE UPDATE ON messages
BEGIN SELECT RAISE(ABORT, 'messages are immutable'); END;
CREATE TRIGGER messages_permanent BEFORE DELETE ON messages
BEGIN SELECT RAISE(ABORT, 'messages are permanent'); END;
CREATE TABLE deliveries (
    message_id TEXT PRIMARY KEY REFERENCES messages (id),
    state TEXT NOT NULL CHECK (state IN
        ('queued', 'held', 'handoff-unknown', 'handed-off', 'acknowledged', 'expired', 'cancelled')),
    reason TEXT,
    attempts INTEGER NOT NULL DEFAULT 0,
    redeliveries INTEGER NOT NULL DEFAULT 0,
    attempt_id TEXT,
    expires_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);
CREATE INDEX deliveries_state ON deliveries (state);
CREATE TABLE attempts (
    id TEXT PRIMARY KEY,
    provider TEXT NOT NULL,
    native_id TEXT NOT NULL,
    checkout TEXT NOT NULL,
    claimed_at INTEGER NOT NULL
);
CREATE TABLE attempt_messages (
    attempt_id TEXT NOT NULL REFERENCES attempts (id),
    message_id TEXT NOT NULL REFERENCES messages (id),
    number INTEGER NOT NULL,
    PRIMARY KEY (attempt_id, message_id)
);
";

pub struct Store {
    pub db: Connection,
}

fn unavailable() -> Fail {
    Fail::new("STORE_UNAVAILABLE", "the store could not be opened")
}

fn private_dir(dir: &Path, create: bool) -> Result<(), Fail> {
    if !dir.exists() {
        if !create {
            return Err(Fail::new("STORE_ABSENT", "no store exists yet"));
        }
        fs::DirBuilder::new().recursive(true).mode(0o700).create(dir).map_err(|_| unavailable())?;
    }
    let mode = fs::metadata(dir).map_err(|_| unavailable())?.permissions().mode();
    if mode & 0o077 != 0 {
        return Err(Fail::new("DATA_DIR_NOT_PRIVATE", "the data directory must be accessible to its owner only"));
    }
    Ok(())
}

impl Store {
    pub fn path(dir: &Path) -> PathBuf {
        dir.join(DATABASE)
    }

    /// Opens for writing, creating the store on first use.
    pub fn open_or_create(dir: &Path) -> Result<Self, Fail> {
        private_dir(dir, true)?;
        let path = Self::path(dir);
        let db = Connection::open(&path).map_err(|_| unavailable())?;
        fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).map_err(|_| unavailable())?;
        db.busy_timeout(std::time::Duration::from_secs(5))?;
        // Engines started together race to switch a new database to write-ahead logging; the loser waits.
        let mut tries = 0;
        while let Err(error) = db.pragma_update(None, "journal_mode", "WAL") {
            tries += 1;
            if tries >= 100 {
                return Err(error.into());
            }
            std::thread::sleep(std::time::Duration::from_millis(20));
        }
        db.pragma_update(None, "synchronous", "FULL")?;
        db.pragma_update(None, "foreign_keys", "ON")?;
        // Decided inside one write transaction, so engines started together create the schema once.
        db.execute_batch("BEGIN IMMEDIATE")?;
        let version: i64 = db.pragma_query_value(None, "user_version", |row| row.get(0))?;
        let ready = match version {
            0 => db.execute_batch(&format!("{SCHEMA}PRAGMA user_version = {SCHEMA_VERSION};")).is_ok(),
            SCHEMA_VERSION => true,
            _ => false,
        };
        if !ready {
            let _ = db.execute_batch("ROLLBACK");
            return Err(if version == 0 || version == SCHEMA_VERSION {
                unavailable()
            } else {
                Fail::new("SCHEMA_UNSUPPORTED", "the store was written by a different version")
            });
        }
        db.execute_batch("COMMIT")?;
        Ok(Store { db })
    }

    /// Opens an existing store without changing it. A read never creates a store.
    pub fn open_existing(dir: &Path) -> Result<Self, Fail> {
        private_dir(dir, false)?;
        let path = Self::path(dir);
        if !path.exists() {
            return Err(Fail::new("STORE_ABSENT", "no store exists yet"));
        }
        let db = Connection::open_with_flags(&path, OpenFlags::SQLITE_OPEN_READ_ONLY).map_err(|_| unavailable())?;
        db.busy_timeout(std::time::Duration::from_secs(5))?;
        let version: i64 = db.pragma_query_value(None, "user_version", |row| row.get(0))?;
        if version != SCHEMA_VERSION {
            return Err(Fail::new("SCHEMA_UNSUPPORTED", "the store was written by a different version"));
        }
        Ok(Store { db })
    }
}
