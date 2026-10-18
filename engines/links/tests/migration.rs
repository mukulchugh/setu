//! A store written by the first shipped engine (schema 1) migrates explicitly to schema 2, keeping every message.
mod common;
use common::*;
use rusqlite::Connection;
use serde_json::json;

/// The schema-1 layout exactly as the first engine wrote it. A fixture of a historical format, not a copy of live code.
const SCHEMA_1: &str = "
CREATE TABLE messages (
    id TEXT PRIMARY KEY, sender TEXT NOT NULL, idempotency_key TEXT NOT NULL, payload_digest TEXT NOT NULL,
    kind TEXT NOT NULL, body TEXT NOT NULL, size INTEGER NOT NULL, reply_to TEXT, run_hint TEXT, span_hint TEXT,
    provider TEXT NOT NULL, native_id TEXT NOT NULL, checkout TEXT NOT NULL, session_hint TEXT NOT NULL,
    created_at INTEGER NOT NULL, UNIQUE (sender, idempotency_key)
);
CREATE INDEX messages_recipient ON messages (provider, native_id, checkout);
CREATE INDEX messages_session ON messages (session_hint);
CREATE TRIGGER messages_immutable BEFORE UPDATE ON messages BEGIN SELECT RAISE(ABORT, 'messages are immutable'); END;
CREATE TRIGGER messages_permanent BEFORE DELETE ON messages BEGIN SELECT RAISE(ABORT, 'messages are permanent'); END;
CREATE TABLE deliveries (
    message_id TEXT PRIMARY KEY REFERENCES messages (id),
    state TEXT NOT NULL CHECK (state IN ('queued', 'held', 'handoff-unknown', 'handed-off', 'acknowledged', 'expired', 'cancelled')),
    reason TEXT, attempts INTEGER NOT NULL DEFAULT 0, redeliveries INTEGER NOT NULL DEFAULT 0, attempt_id TEXT,
    expires_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE INDEX deliveries_state ON deliveries (state);
CREATE TABLE attempts (id TEXT PRIMARY KEY, provider TEXT NOT NULL, native_id TEXT NOT NULL, checkout TEXT NOT NULL, claimed_at INTEGER NOT NULL);
CREATE TABLE attempt_messages (
    attempt_id TEXT NOT NULL REFERENCES attempts (id), message_id TEXT NOT NULL REFERENCES messages (id),
    number INTEGER NOT NULL, PRIMARY KEY (attempt_id, message_id)
);
";

fn schema_1_store(engine: &Engine) {
    std::fs::create_dir_all(&engine.dir).unwrap();
    std::fs::set_permissions(&engine.dir, std::os::unix::fs::PermissionsExt::from_mode(0o700)).unwrap();
    let db = Connection::open(engine.dir.join("mailbox.sqlite3")).unwrap();
    db.pragma_update(None, "journal_mode", "WAL").unwrap();
    db.execute_batch(SCHEMA_1).unwrap();
    db.execute(
        "INSERT INTO messages VALUES ('m_old', 'user', 'k-old', 'digest-old', 'message', 'written by schema 1', 19, NULL, NULL, NULL,
            'claude-code', 'native-a', '{\"path\":\"/work/repo\",\"incarnation\":\"c1\"}', 'session-1', 1000)",
        [],
    )
    .unwrap();
    db.execute("INSERT INTO deliveries (message_id, state, expires_at, updated_at) VALUES ('m_old', 'queued', 9999999999999, 1000)", []).unwrap();
    db.pragma_update(None, "user_version", 1).unwrap();
}

#[test]
fn a_schema_1_store_migrates_to_the_current_schema_and_keeps_its_mail() {
    let engine = Engine::new();
    schema_1_store(&engine);

    assert_eq!(engine.ok("health", json!({}))["schema_version"], 3);
    // Reading a store this engine cannot read yet must not have been the thing that changed it.
    let shown = engine.ok("show", json!({ "message_id": "m_old" }));
    assert_eq!(shown["body"], "written by schema 1");
    assert_eq!(shown["state"], "queued");

    // The first write migrates; the old message is still the only one and still claimable by its exact conversation.
    engine.ok("send", send_args("k-new", "after migration", "native-a"));
    let claimed = engine.ok("claim", json!({ "recipient": recipient("native-a") }));
    assert_eq!(claimed["messages"].as_array().unwrap().len(), 2);
    assert_eq!(claimed["messages"][0]["message_id"], "m_old");
    assert_eq!(Connection::open(engine.dir.join("mailbox.sqlite3")).unwrap().pragma_query_value(None, "user_version", |r| r.get::<_, i64>(0)).unwrap(), 3);
}

#[test]
fn a_read_never_migrates_the_store() {
    let engine = Engine::new();
    schema_1_store(&engine);
    let before = std::fs::read(engine.dir.join("mailbox.sqlite3")).unwrap();
    assert_eq!(engine.ok("show", json!({ "message_id": "m_old" }))["body"], "written by schema 1");
    assert_eq!(engine.ok("health", json!({}))["store"], "ready");
    assert_eq!(std::fs::read(engine.dir.join("mailbox.sqlite3")).unwrap(), before);
}

#[cfg(feature = "test-hooks")]
#[test]
fn a_migration_killed_before_its_commit_leaves_the_schema_1_store_intact_and_the_retry_succeeds() {
    let engine = Engine::new();
    schema_1_store(&engine);
    let request = json!({ "protocol": "setu-links/1", "id": "t", "op": "send", "args": send_args("k-new", "after", "native-a") });
    let (reply, status, _) = engine.raw(&request.to_string(), &[("SETU_LINKS_TEST_KILL_AT", "migrate:before-commit")]);
    assert_eq!(reply, serde_json::Value::Null);
    assert!(!status.success());
    let version: i64 = Connection::open(engine.dir.join("mailbox.sqlite3")).unwrap().pragma_query_value(None, "user_version", |r| r.get(0)).unwrap();
    assert_eq!(version, 1, "a killed migration must leave schema 1");

    engine.ok("send", send_args("k-new", "after", "native-a"));
    assert_eq!(engine.ok("list", json!({ "session_hint": "session-1" }))["messages"].as_array().unwrap().len(), 2);
}

/// The schema-2 layout (sharing policy, project, delivery locator) exactly as the 1 -> 2 step writes it, on top of
/// the schema-1 fixture. A fixture of a historical format, not a call into live code.
fn schema_2_store(engine: &Engine) {
    schema_1_store(engine);
    let db = Connection::open(engine.dir.join("mailbox.sqlite3")).unwrap();
    db.execute_batch(
        "ALTER TABLE messages ADD COLUMN project TEXT;
         ALTER TABLE deliveries ADD COLUMN locator TEXT;
         CREATE INDEX messages_project ON messages (project);
         CREATE TABLE sharing_policies (project TEXT PRIMARY KEY, version INTEGER NOT NULL, policy TEXT NOT NULL, updated_at INTEGER NOT NULL);
         CREATE TABLE presence (project TEXT NOT NULL, session_id TEXT NOT NULL, task TEXT, reach_state TEXT NOT NULL CHECK (reach_state IN ('reachable', 'unreachable')),
            reach_reason TEXT, observed_at INTEGER NOT NULL, PRIMARY KEY (project, session_id));",
    )
    .unwrap();
    db.pragma_update(None, "user_version", 2).unwrap();
}

fn version_of(engine: &Engine) -> i64 {
    Connection::open(engine.dir.join("mailbox.sqlite3")).unwrap().pragma_query_value(None, "user_version", |r| r.get(0)).unwrap()
}

#[test]
fn asking_for_a_message_that_does_not_exist_on_an_older_store_says_so_and_writes_nothing() {
    for (label, build) in [("schema 1", schema_1_store as fn(&Engine)), ("schema 2", schema_2_store as fn(&Engine))] {
        let engine = Engine::new();
        build(&engine);
        let before = std::fs::read(engine.dir.join("mailbox.sqlite3")).unwrap();
        let expected = version_of(&engine);
        for op in ["status", "show"] {
            assert_eq!(engine.err(op, json!({ "message_id": "m_missing" })), "MESSAGE_NOT_FOUND", "{label} {op}");
        }
        assert_eq!(version_of(&engine), expected, "{label}: a read migrated the store");
        assert_eq!(std::fs::read(engine.dir.join("mailbox.sqlite3")).unwrap(), before, "{label}: a read changed the file");
    }
}

#[test]
fn the_transport_reads_on_an_older_store_find_nothing_and_change_nothing() {
    let engine = Engine::new();
    schema_2_store(&engine);
    let before = std::fs::read(engine.dir.join("mailbox.sqlite3")).unwrap();
    assert_eq!(engine.ok("peer_list", json!({}))["peers"], json!([]));
    assert_eq!(engine.ok("binding_show", json!({ "session_hint": "session-1" }))["state"], "absent");
    assert_eq!(version_of(&engine), 2);
    assert_eq!(std::fs::read(engine.dir.join("mailbox.sqlite3")).unwrap(), before);
}

#[test]
fn a_schema_2_store_migrates_to_3_keeping_its_mail_and_enabling_the_transport() {
    let engine = Engine::new();
    schema_2_store(&engine);
    assert_eq!(engine.ok("show", json!({ "message_id": "m_old" }))["body"], "written by schema 1");
    assert_eq!(version_of(&engine), 2);

    // The first write migrates; the old mail is intact and the new tables work.
    let real = iroh::SecretKey::from_bytes(&[9u8; 32]).public().to_string();
    engine.ok("peer_add", json!({ "peer_id": real, "label": "laptop", "addresses": [] }));
    assert_eq!(version_of(&engine), 3);
    assert_eq!(engine.ok("peer_list", json!({}))["peers"].as_array().unwrap().len(), 1);
    assert_eq!(engine.ok("claim", json!({ "recipient": recipient("native-a") }))["messages"][0]["message_id"], "m_old");
}

#[cfg(feature = "test-hooks")]
#[test]
fn a_schema_2_migration_killed_before_its_commit_leaves_schema_2_and_the_retry_succeeds() {
    let engine = Engine::new();
    schema_2_store(&engine);
    let request = json!({ "protocol": "setu-links/1", "id": "t", "op": "send", "args": send_args("k-new", "after", "native-a") });
    let (reply, status, _) = engine.raw(&request.to_string(), &[("SETU_LINKS_TEST_KILL_AT", "migrate:before-commit")]);
    assert_eq!(reply, serde_json::Value::Null);
    assert!(!status.success());
    assert_eq!(version_of(&engine), 2, "a killed migration must leave schema 2");
    engine.ok("send", send_args("k-new", "after", "native-a"));
    assert_eq!(version_of(&engine), 3);
}
