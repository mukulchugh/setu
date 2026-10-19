//! A store written before sharing existed (schema 1), and one written before the peer transport (schema 2), are
//! migrated explicitly by the first operation that writes, keeping every message; reads of them stay passive and
//! report nothing shared or sent.
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

    assert_eq!(engine.ok("health", json!({}))["schema_version"], 4);
    // Reading a store this engine cannot read yet must not have been the thing that changed it.
    let shown = engine.ok("show", json!({ "message_id": "m_old" }));
    assert_eq!(shown["body"], "written by schema 1");
    assert_eq!(shown["state"], "queued");

    // The first write migrates; the old message is still the only one and still claimable by its exact conversation.
    engine.ok("send", send_args("k-new", "after migration", "native-a"));
    let claimed = engine.ok("claim", json!({ "recipient": recipient("native-a") }));
    assert_eq!(claimed["messages"].as_array().unwrap().len(), 2);
    assert_eq!(claimed["messages"][0]["message_id"], "m_old");
    assert_eq!(Connection::open(engine.dir.join("mailbox.sqlite3")).unwrap().pragma_query_value(None, "user_version", |r| r.get::<_, i64>(0)).unwrap(), 4);
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
    assert_eq!(version_of(&engine), 4);
    assert_eq!(engine.ok("peer_list", json!({}))["peers"].as_array().unwrap().len(), 1);
    let events = engine.ok("events", json!({}));
    assert_eq!(events["events"][0]["message_id"], "m_old");
    assert_eq!(events["events"][0]["backfill"], true);
    assert_eq!(events["events"][0]["first"], true);
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
    assert_eq!(version_of(&engine), 4);
}

#[test]
fn reads_of_a_version_1_store_work_report_nothing_shared_and_change_nothing() {
    let engine = Engine::new();
    version_one_store(&engine);
    let before = std::fs::read(engine.dir.join("mailbox.sqlite3")).unwrap();

    assert_eq!(engine.ok("show", json!({ "message_id": "m_old" }))["body"], "written before sharing");
    assert_eq!(engine.ok("share_status", json!({ "project": "repo" }))["projects"][0]["state"], "absent");
    assert_eq!(engine.ok("directory", json!({}))["entries"], json!([]));
    assert_eq!(engine.ok("health", json!({}))["schema_version"], 4);
    assert_eq!(engine.ok("share_disable", json!({ "project": "repo" }))["removed"], false);
    assert_eq!(std::fs::read(engine.dir.join("mailbox.sqlite3")).unwrap(), before);
    assert_eq!(Connection::open(engine.dir.join("mailbox.sqlite3")).unwrap().pragma_query_value(None, "user_version", |r| r.get::<_, i64>(0)).unwrap(), 1);
}

#[test]
fn the_first_write_migrates_and_keeps_every_message_and_its_state() {
    let engine = Engine::new();
    version_one_store(&engine);
    // A principal other than the user is refused before anything is migrated or stored.
    assert_eq!(engine.call("send", session_send_args("k1", "x", "native-a", "s", "repo"))["error"]["code"], "NOT_SHARED");
    assert_eq!(Connection::open(engine.dir.join("mailbox.sqlite3")).unwrap().pragma_query_value(None, "user_version", |r| r.get::<_, i64>(0)).unwrap(), 1);

    engine.ok("share_enable", json!({ "project": "repo", "owner": "Mukul" }));
    let db = Connection::open(engine.dir.join("mailbox.sqlite3")).unwrap();
    assert_eq!(db.pragma_query_value(None, "user_version", |r| r.get::<_, i64>(0)).unwrap(), 4);
    drop(db);

    let old = engine.ok("show", json!({ "message_id": "m_old" }));
    assert_eq!((old["body"].as_str(), old["state"].as_str(), old["project"].clone()), (Some("written before sharing"), Some("queued"), json!(null)));
    assert_eq!(engine.ok("claim", json!({ "recipient": recipient("native-a") }))["messages"][0]["message_id"], "m_old");
    // New mail on the migrated store works under policy.
    assert_eq!(engine.call("send", session_send_args("k1", "x", "native-b", "s", "repo"))["ok"], true);
}

#[test]
fn a_store_migrated_by_a_send_is_the_same_as_a_fresh_one() {
    let engine = Engine::new();
    version_one_store(&engine);
    engine.ok("send", send_args("k2", "hello", "native-a"));
    let fresh = Engine::new();
    fresh.ok("send", send_args("k2", "hello", "native-a"));
    let tables = |engine: &Engine| {
        let db = Connection::open(engine.dir.join("mailbox.sqlite3")).unwrap();
        let mut statement = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").unwrap();
        statement.query_map([], |row| row.get::<_, String>(0)).unwrap().map(Result::unwrap).collect::<Vec<_>>()
    };
    assert_eq!(tables(&engine), tables(&fresh));
}

#[test]
fn the_same_send_retried_after_migration_is_a_replay_and_a_changed_one_still_conflicts() {
    let engine = Engine::new();
    version_one_store(&engine);
    // This recipient and body are exactly what the schema-1 engine accepted under this key.
    let retry = |body: &str, native_id: &str| {
        let mut args = send_args(LEGACY_KEY, body, native_id);
        args["recipient"]["session_hint"] = json!("session-1");
        engine.call("send", args)
    };

    let replay = retry(LEGACY_BODY, "native-a");
    assert_eq!((replay["ok"].clone(), replay["result"]["message_id"].clone(), replay["result"]["replayed"].clone()), (json!(true), json!("m_old"), json!(true)), "{replay}");
    // The first write migrated the store; the old row is as it was, and the replay stored nothing new.
    assert_eq!(engine.ok("show", json!({ "message_id": "m_old" }))["project"], json!(null));
    assert_eq!(engine.ok("list", json!({ "session_hint": "session-1" }))["messages"].as_array().unwrap().len(), 1);
    // Repeating it after the store is at schema 2 is still the same message.
    assert_eq!(retry(LEGACY_BODY, "native-a")["result"]["message_id"], "m_old");

    for (body, native_id) in [("a different body", "native-a"), (LEGACY_BODY, "native-b")] {
        let refused = retry(body, native_id);
        assert_eq!(refused["error"]["code"], "IDEMPOTENCY_CONFLICT", "{body} {native_id}");
        assert_eq!(refused["error"]["details"]["message_id"], "m_old");
    }
    let mut other_session = send_args(LEGACY_KEY, LEGACY_BODY, "native-a");
    other_session["recipient"]["session_hint"] = json!("session-2");
    assert_eq!(engine.err("send", other_session), "IDEMPOTENCY_CONFLICT");
    let mut reply_to = send_args(LEGACY_KEY, LEGACY_BODY, "native-a");
    reply_to["reply_to"] = json!("m_x");
    assert_eq!(engine.err("send", reply_to), "IDEMPOTENCY_CONFLICT");
}

#[test]
fn a_row_recorded_with_a_project_conflicts_when_retried_for_another_project() {
    let engine = Engine::new();
    // Only an older row, which has no project, is matched without one; a newer row means what it recorded.
    engine.ok("send", send_args("k1", "hello", "native-a"));
    let mut elsewhere = send_args("k1", "hello", "native-a");
    elsewhere["project"] = json!("other");
    assert_eq!(engine.err("send", elsewhere), "IDEMPOTENCY_CONFLICT");
}
