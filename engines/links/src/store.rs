//! The one durable mailbox store. Only this process opens the database.

use crate::{args::Fail, util};
use rusqlite::{Connection, OpenFlags};
use std::{
    fs,
    os::unix::fs::{DirBuilderExt, PermissionsExt},
    path::{Path, PathBuf},
};

pub const SCHEMA_VERSION: i64 = 2;
/// The first schema that has sharing policy and presence; a store before it reads as having none.
pub const SHARING_SCHEMA: i64 = 2;
const DATABASE: &str = "mailbox.sqlite3";

const SCHEMA_V1: &str = "
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

/// Schema 1 to 2: sharing policy and presence live beside the mailbox in the one store. Existing tables and
/// rows are kept as they are; a message also records the project it was addressed in, so a policy that
/// later withdraws can hold mail from a principal it no longer admits. Older messages have no project.
const MIGRATION_1_TO_2: &str = "
ALTER TABLE messages ADD COLUMN project TEXT;
CREATE INDEX messages_project ON messages (project);
CREATE TABLE sharing_policies (
    project TEXT PRIMARY KEY,
    version INTEGER NOT NULL,
    policy TEXT NOT NULL,
    updated_at INTEGER NOT NULL
);
CREATE TABLE presence (
    project TEXT NOT NULL,
    session_id TEXT NOT NULL,
    task TEXT,
    task_at INTEGER,
    activity_at INTEGER,
    reach_state TEXT NOT NULL CHECK (reach_state IN ('reachable', 'unreachable')),
    reach_reason TEXT,
    observed_at INTEGER NOT NULL,
    PRIMARY KEY (project, session_id)
);
";

pub struct Store {
    pub db: Connection,
    /// The schema version on disk. A store opened for reading may still be at version 1.
    pub version: i64,
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

/// Every mutation ends here, so every one can be killed on either side of its commit.
pub fn commit(tx: rusqlite::Transaction, op: &str) -> Result<(), Fail> {
    util::fault(&format!("{op}:before-commit"));
    tx.commit()?;
    util::fault(&format!("{op}:after-commit"));
    Ok(())
}

impl Store {
    /// Whether this store has the sharing tables (schema 1 does not).
    pub fn has_sharing(&self) -> bool {
        self.version >= SHARING_SCHEMA
    }

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
        // Decided inside one write transaction, so engines started together create or migrate the schema once.
        db.execute_batch("BEGIN IMMEDIATE")?;
        let version: i64 = db.pragma_query_value(None, "user_version", |row| row.get(0))?;
        let steps: &[&str] = match version {
            0 => &[SCHEMA_V1, MIGRATION_1_TO_2],
            1 => &[MIGRATION_1_TO_2],
            SCHEMA_VERSION => &[],
            _ => {
                let _ = db.execute_batch("ROLLBACK");
                return Err(Fail::new("SCHEMA_UNSUPPORTED", "the store was written by a different version"));
            }
        };
        let migrated = steps.iter().all(|step| db.execute_batch(step).is_ok())
            && (steps.is_empty() || db.execute_batch(&format!("PRAGMA user_version = {SCHEMA_VERSION};")).is_ok());
        if !migrated {
            let _ = db.execute_batch("ROLLBACK");
            return Err(unavailable());
        }
        util::fault("migrate:before-commit");
        db.execute_batch("COMMIT")?;
        util::fault("migrate:after-commit");
        Ok(Store { db, version: SCHEMA_VERSION })
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
        // A read never migrates: a version 1 store is read as it is, and has no sharing policy yet.
        if !(1..=SCHEMA_VERSION).contains(&version) {
            return Err(Fail::new("SCHEMA_UNSUPPORTED", "the store was written by a different version"));
        }
        Ok(Store { db, version })
    }
}
