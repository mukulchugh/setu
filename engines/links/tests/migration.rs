//! A store written before sharing existed (schema 1) is migrated explicitly by the first operation that
//! writes, keeping every message; reads of it stay passive and report nothing shared.
mod common;
use common::*;
use rusqlite::Connection;
use serde_json::json;

#[test]
fn reads_of_a_version_1_store_work_report_nothing_shared_and_change_nothing() {
    let engine = Engine::new();
    version_one_store(&engine);
    let before = std::fs::read(engine.dir.join("mailbox.sqlite3")).unwrap();

    assert_eq!(engine.ok("show", json!({ "message_id": "m_old" }))["body"], "written before sharing");
    assert_eq!(engine.ok("share_status", json!({ "project": "repo" }))["projects"][0]["state"], "absent");
    assert_eq!(engine.ok("directory", json!({}))["entries"], json!([]));
    assert_eq!(engine.ok("health", json!({}))["schema_version"], 2);
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
    assert_eq!(db.pragma_query_value(None, "user_version", |r| r.get::<_, i64>(0)).unwrap(), 2);
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
