// Drives the real `setu-links` binary: one process per operation, JSON in and out, as production does.
#![allow(dead_code)]

use rusqlite::Connection;
use serde_json::{Value, json};
use std::{
    io::Write,
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::atomic::{AtomicU32, Ordering},
};

static NEXT: AtomicU32 = AtomicU32::new(0);

// The schema exactly as the first release candidate created it.
pub const SCHEMA_1: &str = "
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

pub struct Engine {
    pub dir: PathBuf,
    owned: bool,
}

pub fn recipient(native_id: &str) -> Value {
    json!({
        "provider": "claude-code",
        "native_id": native_id,
        "checkout": "{\"path\":\"/work/repo\",\"incarnation\":\"c1\"}",
        "session_hint": "session-1",
    })
}

pub fn send_args(key: &str, body: &str, native_id: &str) -> Value {
    json!({
        "idempotency_key": key,
        "sender": { "kind": "user" },
        "project": "repo",
        "recipient": recipient(native_id),
        "body": body,
    })
}

/// A send from a trusted test principal: a local session other than the user.
pub fn session_send_args(key: &str, body: &str, native_id: &str, sender_session: &str, project: &str) -> Value {
    let mut args = send_args(key, body, native_id);
    args["sender"] = json!({ "kind": "session", "id": sender_session });
    args["project"] = json!(project);
    args
}

impl Engine {
    pub fn new() -> Self {
        let dir = std::env::temp_dir().join(format!(
            "setu-links-test-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::SeqCst)
        ));
        Engine { dir, owned: true }
    }

    /// The data directory is the persistent state; a second `Engine` over it is a restarted engine.
    pub fn at(dir: &Path) -> Self {
        Engine { dir: dir.to_path_buf(), owned: false }
    }

    pub fn raw(&self, input: &str, env: &[(&str, &str)]) -> (Value, std::process::ExitStatus, String) {
        let mut cmd = Command::new(env!("CARGO_BIN_EXE_setu-links"));
        cmd.arg("--data-dir").arg(&self.dir).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped());
        for (k, v) in env {
            cmd.env(k, v);
        }
        let mut child = cmd.spawn().expect("spawn engine");
        child.stdin.take().unwrap().write_all(input.as_bytes()).unwrap();
        let out = child.wait_with_output().unwrap();
        let stdout = String::from_utf8_lossy(&out.stdout).to_string();
        let value = serde_json::from_str(stdout.trim()).unwrap_or(Value::Null);
        (value, out.status, String::from_utf8_lossy(&out.stderr).to_string())
    }

    pub fn call_env(&self, op: &str, args: Value, env: &[(&str, &str)]) -> Value {
        let request = json!({ "protocol": "setu-links/1", "id": "t", "op": op, "args": args });
        self.raw(&request.to_string(), env).0
    }

    pub fn call(&self, op: &str, args: Value) -> Value {
        self.call_env(op, args, &[])
    }

    pub fn ok(&self, op: &str, args: Value) -> Value {
        let reply = self.call(op, args);
        assert_eq!(reply["ok"], true, "{op} failed: {reply}");
        reply["result"].clone()
    }

    pub fn err(&self, op: &str, args: Value) -> String {
        let reply = self.call(op, args);
        assert_eq!(reply["ok"], false, "{op} unexpectedly succeeded: {reply}");
        reply["error"]["code"].as_str().unwrap().to_string()
    }
}

impl Drop for Engine {
    fn drop(&mut self) {
        if self.owned {
            let _ = std::fs::remove_dir_all(&self.dir);
        }
    }
}

// The digest the schema-1 engine (the 805ab1f build) stored for exactly this send: key `legacy-key`, the body
// below, recipient native-a / the checkout below / session-1, no reply or hints. It was produced by running
// that engine, not by this one, so this test can disagree with the code under test.
pub const LEGACY_KEY: &str = "legacy-key";
pub const LEGACY_BODY: &str = "written before sharing";
pub const LEGACY_DIGEST: &str = "fd6724b04d97def88e95071e00a1c55298ebbbe744e41231c95094c7c2c2ebdc";

pub fn version_one_store(engine: &Engine) {
    std::fs::create_dir_all(&engine.dir).unwrap();
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&engine.dir, std::fs::Permissions::from_mode(0o700)).unwrap();
    }
    let db = Connection::open(engine.dir.join("mailbox.sqlite3")).unwrap();
    db.pragma_update(None, "journal_mode", "WAL").unwrap();
    db.execute_batch(SCHEMA_1).unwrap();
    db.execute(
        "INSERT INTO messages VALUES ('m_old', 'user', ?1, ?2, 'message', 'written before sharing', 22, NULL, NULL, NULL,
            'claude-code', 'native-a', '{\"path\":\"/work/repo\",\"incarnation\":\"c1\"}', 'session-1', 1760000000000)",
        [LEGACY_KEY, LEGACY_DIGEST],
    )
    .unwrap();
    db.execute("INSERT INTO deliveries (message_id, state, expires_at, updated_at) VALUES ('m_old', 'queued', 4102444800000, 1760000000000)", []).unwrap();
    db.pragma_update(None, "user_version", 1).unwrap();
}
