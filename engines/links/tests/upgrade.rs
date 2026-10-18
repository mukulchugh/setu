// A mailbox written by the first engine release candidate (schema 1) must keep working. Reads stay
// compatible and write nothing; the first write upgrades it in place with one additive step.
mod common;
use common::*;
use rusqlite::Connection;
use serde_json::{Value, json};
use std::{fs, os::unix::fs::PermissionsExt, path::PathBuf};

fn database(engine: &Engine) -> PathBuf {
    engine.dir.join("mailbox.sqlite3")
}

fn version(engine: &Engine) -> i64 {
    let db = Connection::open(database(engine)).unwrap();
    db.pragma_query_value(None, "user_version", |row| row.get(0)).unwrap()
}

/// A schema-1 store holding one queued message for native-a, one held for native-a replaced by native-b,
/// and one already claimed and unknown.
fn earlier_store() -> (Engine, [&'static str; 3]) {
    let engine = Engine::new();
    fs::create_dir_all(&engine.dir).unwrap();
    fs::set_permissions(&engine.dir, fs::Permissions::from_mode(0o700)).unwrap();
    let path = database(&engine);
    let db = Connection::open(&path).unwrap();
    db.pragma_update(None, "journal_mode", "WAL").unwrap();
    db.execute_batch(SCHEMA_1).unwrap();
    let far = 4_102_444_800_000i64;
    let checkout = "{\"path\":\"/work/repo\",\"incarnation\":\"c1\"}";
    let rows = [
        ("m_queued", "native-a", "queued", None, 0, None),
        ("m_held", "native-a", "held", Some("conversation-replaced"), 0, None),
        ("m_unknown", "native-a", "handoff-unknown", Some("claimed"), 1, Some("a_1")),
    ];
    for (n, (id, native, state, reason, attempts, attempt)) in rows.iter().enumerate() {
        db.execute(
            "INSERT INTO messages (id, sender, idempotency_key, payload_digest, kind, body, size, provider, native_id, checkout, session_hint, created_at)
             VALUES (?1, 'user', ?2, 'digest', 'message', ?3, 5, 'claude-code', ?4, ?5, 'session-1', ?6)",
            rusqlite::params![id, format!("k{n}"), format!("body {n}"), native, checkout, 1000 + n as i64],
        )
        .unwrap();
        db.execute(
            "INSERT INTO deliveries (message_id, state, reason, attempts, attempt_id, expires_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, 1000)",
            rusqlite::params![id, state, reason, attempts, attempt, far],
        )
        .unwrap();
    }
    db.execute("INSERT INTO attempts (id, provider, native_id, checkout, claimed_at) VALUES ('a_1', 'claude-code', 'native-a', ?1, 1000)", [checkout]).unwrap();
    db.execute("INSERT INTO attempt_messages (attempt_id, message_id, number) VALUES ('a_1', 'm_unknown', 1)", []).unwrap();
    db.pragma_update(None, "user_version", 1).unwrap();
    drop(db);
    // Fold the write-ahead log in so the main file is the whole store.
    let db = Connection::open(&path).unwrap();
    db.pragma_update(None, "wal_checkpoint", "TRUNCATE").unwrap();
    drop(db);
    fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).unwrap();
    (engine, ["m_queued", "m_held", "m_unknown"])
}

fn state(engine: &Engine, id: &str) -> Value {
    engine.ok("status", json!({ "message_id": id }))
}

#[test]
fn reads_of_an_earlier_store_work_and_write_nothing() {
    let (engine, [queued, held, unknown]) = earlier_store();
    let before = fs::read(database(&engine)).unwrap();

    let status = state(&engine, queued);
    assert_eq!((status["state"].as_str(), status["locator"].as_str()), (Some("queued"), Some("session-1")));
    assert_eq!(state(&engine, held)["reason"], "conversation-replaced");
    assert_eq!(state(&engine, unknown)["state"], "handoff-unknown");
    assert_eq!(engine.ok("show", json!({ "message_id": queued }))["body"], "body 0");
    let listed = engine.ok("list", json!({ "session_hint": "session-1" }));
    assert_eq!(listed["messages"].as_array().unwrap().len(), 3);
    // A passive observation still projects the effective state without writing.
    let observed = engine.ok(
        "status",
        json!({ "message_id": queued, "observed": { "provider": "claude-code", "native_id": "native-b", "checkout": "{\"path\":\"/work/repo\",\"incarnation\":\"c1\"}", "session_hint": "session-1" } }),
    );
    assert_eq!(observed["state"], "held");

    assert_eq!(fs::read(database(&engine)).unwrap(), before, "a read must not change the database");
    assert_eq!(version(&engine), 1);
}

#[test]
fn the_first_write_upgrades_in_place_and_keeps_every_message_and_state() {
    let (engine, [queued, held, unknown]) = earlier_store();
    // A reconcile that restores the held message is a write: it upgrades first.
    let outcome = engine.ok("reconcile", json!({ "recipient": recipient("native-a") }));
    assert_eq!(outcome["released"], json!([held]));
    assert_eq!(version(&engine), 3);

    assert_eq!(state(&engine, queued)["state"], "queued");
    assert_eq!(state(&engine, held)["state"], "queued");
    assert_eq!(state(&engine, unknown)["state"], "handoff-unknown");
    assert_eq!(state(&engine, unknown)["attempt_id"], "a_1");
    assert_eq!(state(&engine, queued)["locator"], "session-1");
    // Messages are untouched and still immutable.
    let db = Connection::open(database(&engine)).unwrap();
    let count: i64 = db.query_row("SELECT COUNT(*) FROM messages", [], |row| row.get(0)).unwrap();
    assert_eq!(count, 3);
    assert!(db.execute("UPDATE messages SET body = 'x'", []).is_err());
}

#[test]
fn an_upgraded_store_supports_resume_and_the_upgrade_happens_once() {
    let (engine, [queued, ..]) = earlier_store();
    let mut elsewhere = recipient("native-a");
    elsewhere["session_hint"] = json!("session-2");
    let outcome = engine.ok("resume", json!({ "recipient": elsewhere, "from": ["session-1"] }));
    assert_eq!(outcome["moved"].as_array().unwrap().len(), 3);
    assert_eq!(state(&engine, queued)["locator"], "session-2");
    assert_eq!(version(&engine), 3);

    let db = Connection::open(database(&engine)).unwrap();
    let columns: i64 = db
        .query_row("SELECT COUNT(*) FROM pragma_table_info('deliveries') WHERE name = 'locator'", [], |row| row.get(0))
        .unwrap();
    assert_eq!(columns, 1);
    drop(db);
    // Another write changes nothing about the schema.
    engine.ok("reconcile", json!({ "recipient": recipient("native-a") }));
    assert_eq!(version(&engine), 3);
}

#[test]
fn a_send_to_an_earlier_store_upgrades_it_and_the_new_message_is_queued_beside_the_old() {
    let (engine, [queued, ..]) = earlier_store();
    let id = engine.ok("send", send_args("fresh", "new body", "native-a"))["message_id"].as_str().unwrap().to_string();
    assert_eq!(version(&engine), 3);
    assert_eq!(state(&engine, &id)["state"], "queued");
    assert_eq!(state(&engine, queued)["state"], "queued");
}

#[test]
fn engines_started_together_on_an_earlier_store_upgrade_it_once_and_all_succeed() {
    let (engine, ids) = earlier_store();
    let dir = engine.dir.clone();
    let handles: Vec<_> = (0..6)
        .map(|_| {
            let dir = dir.clone();
            std::thread::spawn(move || Engine::at(&dir).call("reconcile", json!({ "recipient": recipient("native-a") }))["ok"] == true)
        })
        .collect();
    for handle in handles {
        assert!(handle.join().unwrap());
    }
    assert_eq!(version(&engine), 3);
    for id in ids {
        assert!(state(&engine, id)["state"].is_string());
    }
}

#[test]
fn a_newer_store_is_still_refused_and_left_untouched() {
    let (engine, _) = earlier_store();
    let db = Connection::open(database(&engine)).unwrap();
    db.pragma_update(None, "user_version", 4).unwrap();
    drop(db);
    let before = fs::read(database(&engine)).unwrap();
    assert_eq!(engine.err("reconcile", json!({ "recipient": recipient("native-a") })), "SCHEMA_UNSUPPORTED");
    assert_eq!(engine.err("status", json!({ "message_id": "m_queued" })), "SCHEMA_UNSUPPORTED");
    assert_eq!(fs::read(database(&engine)).unwrap(), before);
}
