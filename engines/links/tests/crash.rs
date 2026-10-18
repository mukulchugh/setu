//! Kills the real engine process at each point around a commit. Needs `--features test-hooks`.
#![cfg(feature = "test-hooks")]
mod common;
use common::*;
use serde_json::{Value, json};

/// Runs one operation that is killed at `point`; the caller never gets a reply.
fn killed(engine: &Engine, op: &str, args: Value, point: &str) {
    let request = json!({ "protocol": "setu-links/1", "id": "t", "op": op, "args": args });
    let (reply, status, _) = engine.raw(&request.to_string(), &[("SETU_LINKS_TEST_KILL_AT", point)]);
    assert_eq!(reply, Value::Null, "{point}: a killed engine must not reply");
    assert!(!status.success(), "{point}: the engine was not killed");
}

fn inbox(engine: &Engine) -> Vec<Value> {
    engine.ok("list", json!({ "session_hint": "session-1" }))["messages"].as_array().unwrap().clone()
}

fn claim_args() -> Value {
    json!({ "recipient": recipient("native-a") })
}

#[test]
fn a_send_killed_before_commit_stores_nothing_and_the_retry_creates_one_message() {
    let engine = Engine::new();
    killed(&engine, "send", send_args("k1", "hello", "native-a"), "send:before-commit");
    // No store may even exist yet, or it holds no message.
    assert!(engine.call("list", json!({ "session_hint": "session-1" }))["result"]["messages"].as_array().is_none_or(|m| m.is_empty()));

    let retry = engine.ok("send", send_args("k1", "hello", "native-a"));
    assert_eq!(retry["replayed"], false);
    assert_eq!(inbox(&engine).len(), 1);
}

#[test]
fn a_send_killed_after_commit_left_exactly_one_message_and_the_retry_returns_it() {
    let engine = Engine::new();
    killed(&engine, "send", send_args("k1", "hello", "native-a"), "send:after-commit");
    let stored = inbox(&engine);
    assert_eq!(stored.len(), 1);
    assert_eq!(stored[0]["state"], "queued");

    let retry = engine.ok("send", send_args("k1", "hello", "native-a"));
    assert_eq!(retry["replayed"], true);
    assert_eq!(retry["message_id"], stored[0]["message_id"]);
    assert_eq!(inbox(&engine).len(), 1);
}

#[test]
fn a_claim_killed_before_commit_leaves_the_mail_queued() {
    let engine = Engine::new();
    let id = engine.ok("send", send_args("k1", "hello", "native-a"))["message_id"].clone();
    killed(&engine, "claim", claim_args(), "claim:before-commit");
    let status = engine.ok("status", json!({ "message_id": id }));
    assert_eq!(status["state"], "queued");
    assert_eq!(status["attempts"], 0);
    assert_eq!(engine.ok("claim", claim_args())["messages"].as_array().unwrap().len(), 1);
}

#[test]
fn a_claim_killed_after_commit_is_unknown_never_queued_and_never_claimed_again() {
    let engine = Engine::new();
    let id = engine.ok("send", send_args("k1", "hello", "native-a"))["message_id"].clone();
    killed(&engine, "claim", claim_args(), "claim:after-commit");
    let status = engine.ok("status", json!({ "message_id": id }));
    assert_eq!(status["state"], "handoff-unknown");
    assert_eq!(status["attempts"], 1);
    assert_eq!(engine.ok("claim", claim_args())["messages"], json!([]));
    assert_eq!(engine.ok("status", json!({ "message_id": id }))["state"], "handoff-unknown");
}

#[test]
fn a_confirmation_killed_before_commit_stays_unknown_and_after_commit_is_handed_off() {
    let engine = Engine::new();
    let id = engine.ok("send", send_args("k1", "hello", "native-a"))["message_id"].clone();
    let attempt = engine.ok("claim", claim_args())["attempt_id"].clone();
    let confirm = json!({ "attempt_id": attempt, "recipient": recipient("native-a") });

    killed(&engine, "confirm", confirm.clone(), "confirm:before-commit");
    assert_eq!(engine.ok("status", json!({ "message_id": id }))["state"], "handoff-unknown");

    killed(&engine, "confirm", confirm.clone(), "confirm:after-commit");
    assert_eq!(engine.ok("status", json!({ "message_id": id }))["state"], "handed-off");
}

#[test]
fn a_redelivery_killed_at_either_point_leaves_one_consistent_state() {
    let engine = Engine::new();
    let id = engine.ok("send", send_args("k1", "hello", "native-a"))["message_id"].clone();
    let attempt = engine.ok("claim", claim_args())["attempt_id"].clone();
    let redeliver = json!({ "message_id": id, "attempt_id": attempt, "recipient": recipient("native-a") });

    killed(&engine, "redeliver", redeliver.clone(), "redeliver:before-commit");
    assert_eq!(engine.ok("status", json!({ "message_id": id }))["state"], "handoff-unknown");
    killed(&engine, "redeliver", redeliver, "redeliver:after-commit");
    let status = engine.ok("status", json!({ "message_id": id }));
    assert_eq!(status["state"], "queued");
    assert_eq!(status["redeliveries"], 1);
}

#[test]
fn a_reconcile_killed_at_either_point_is_all_or_nothing_and_safe_to_repeat() {
    let engine = Engine::new();
    let id = engine.ok("send", send_args("k1", "hello", "native-a"))["message_id"].clone();
    let report = json!({ "recipient": recipient("native-b") });

    killed(&engine, "reconcile", report.clone(), "reconcile:before-commit");
    assert_eq!(engine.ok("status", json!({ "message_id": id }))["state"], "queued");

    killed(&engine, "reconcile", report.clone(), "reconcile:after-commit");
    assert_eq!(engine.ok("status", json!({ "message_id": id }))["state"], "held");

    // Repeating the report changes nothing more.
    assert_eq!(engine.ok("reconcile", report)["held"], json!([]));
}

// ---- sharing and the schema migration: one transaction each, killed on either side of its commit ----

fn status_of(engine: &Engine, project: &str) -> Value {
    engine.ok("share_status", json!({ "project": project }))["projects"][0].clone()
}

fn user_version(engine: &Engine) -> i64 {
    rusqlite::Connection::open(engine.dir.join("mailbox.sqlite3")).unwrap().pragma_query_value(None, "user_version", |r| r.get(0)).unwrap()
}

fn deposit(engine: &Engine, key: &str) -> Value {
    engine.call("send", session_send_args(key, "from a session", "native-a", "sender-session", "repo"))
}

#[test]
fn a_migration_killed_before_its_commit_leaves_the_old_store_whole_and_the_retry_migrates_it() {
    let engine = Engine::new();
    version_one_store(&engine);
    killed(&engine, "share_enable", json!({ "project": "repo", "owner": "Mukul" }), "migrate:before-commit");
    assert_eq!(user_version(&engine), 1);
    assert_eq!(engine.ok("show", json!({ "message_id": "m_old" }))["body"], LEGACY_BODY);
    assert_eq!(status_of(&engine, "repo")["state"], "absent");
    assert_eq!(deposit(&engine, "k1")["error"]["code"], "NOT_SHARED");

    engine.ok("share_enable", json!({ "project": "repo", "owner": "Mukul" }));
    assert_eq!(user_version(&engine), 2);
    assert_eq!(engine.ok("show", json!({ "message_id": "m_old" }))["state"], "queued");
}

#[test]
fn a_migration_killed_after_its_commit_is_complete_and_keeps_every_message() {
    let engine = Engine::new();
    version_one_store(&engine);
    killed(&engine, "send", send_args(LEGACY_KEY, LEGACY_BODY, "native-a"), "migrate:after-commit");
    assert_eq!(user_version(&engine), 2);
    assert_eq!(engine.ok("show", json!({ "message_id": "m_old" }))["body"], LEGACY_BODY);
    // The retry of the interrupted send finds the old message.
    assert_eq!(engine.ok("send", send_args(LEGACY_KEY, LEGACY_BODY, "native-a"))["message_id"], "m_old");
    assert_eq!(status_of(&engine, "repo")["state"], "absent");
}

#[test]
fn enabling_killed_at_either_point_is_all_or_nothing_and_a_restart_keeps_the_decision() {
    let engine = Engine::new();
    killed(&engine, "share_enable", json!({ "project": "repo", "owner": "Mukul" }), "share_enable:before-commit");
    assert_eq!(status_of(&engine, "repo")["state"], "absent");
    assert_eq!(deposit(&engine, "k1")["error"]["code"], "NOT_SHARED");

    killed(&engine, "share_enable", json!({ "project": "repo", "owner": "Mukul" }), "share_enable:after-commit");
    assert_eq!(status_of(&engine, "repo")["state"], "enabled");
    assert_eq!(deposit(&engine, "k2")["ok"], true);
}

#[test]
fn disabling_killed_before_its_commit_changes_nothing_and_after_it_withdraws_everything() {
    let engine = Engine::new();
    engine.ok("share_enable", json!({ "project": "repo", "owner": "Mukul" }));
    engine.ok("presence_publish", json!({ "project": "repo", "sessions": [{ "session_id": "s1", "reachability": { "state": "reachable" } }] }));
    let queued = deposit(&engine, "k1")["result"]["message_id"].clone();

    killed(&engine, "share_disable", json!({ "project": "repo" }), "share_disable:before-commit");
    assert_eq!(status_of(&engine, "repo")["state"], "enabled");
    assert_eq!(engine.ok("directory", json!({}))["entries"].as_array().unwrap().len(), 1);
    assert_eq!(engine.ok("status", json!({ "message_id": queued }))["state"], "queued");

    killed(&engine, "share_disable", json!({ "project": "repo" }), "share_disable:after-commit");
    assert_eq!(status_of(&engine, "repo")["state"], "absent");
    assert_eq!(engine.ok("directory", json!({}))["entries"], json!([]));
    assert_eq!(engine.ok("status", json!({ "message_id": queued }))["state"], "held");
    assert_eq!(deposit(&engine, "k2")["error"]["code"], "NOT_SHARED");
    // Nothing from the withdrawn project is handed to the conversation.
    assert_eq!(engine.ok("claim", json!({ "recipient": recipient("native-a") }))["messages"], json!([]));
}

#[test]
fn a_presence_publish_killed_at_either_point_is_all_or_nothing() {
    let engine = Engine::new();
    engine.ok("share_enable", json!({ "project": "repo", "owner": "Mukul" }));
    let args = json!({ "project": "repo", "sessions": [{ "session_id": "s1", "reachability": { "state": "reachable" } }] });
    killed(&engine, "presence_publish", args.clone(), "presence_publish:before-commit");
    assert_eq!(engine.ok("directory", json!({}))["entries"], json!([]));
    killed(&engine, "presence_publish", args, "presence_publish:after-commit");
    assert_eq!(engine.ok("directory", json!({}))["entries"].as_array().unwrap().len(), 1);
}

#[test]
fn a_resume_killed_around_its_commit_either_happened_completely_or_not_at_all() {
    for point in ["resume:before-commit", "resume:after-commit"] {
        let engine = Engine::new();
        let id = engine.ok("send", send_args("k1", "hello", "native-a"))["message_id"].as_str().unwrap().to_string();
        engine.ok("reconcile", json!({ "recipient": recipient("native-b") }));
        let mut resumed = recipient("native-a");
        resumed["session_hint"] = json!("session-2");
        killed(&engine, "resume", json!({ "recipient": resumed, "from": ["session-1"] }), point);

        let after = engine.ok("status", json!({ "message_id": id }));
        let (state, locator) = (after["state"].as_str().unwrap(), after["locator"].as_str().unwrap());
        if point.ends_with("before-commit") {
            assert_eq!((state, locator), ("held", "session-1"), "{point}");
        } else {
            assert_eq!((state, locator), ("queued", "session-2"), "{point}");
        }
    }
}

#[test]
fn an_upgrade_killed_before_it_commits_leaves_a_usable_earlier_store_and_a_retry_upgrades_it() {
    let engine = Engine::new();
    // An earlier-schema store: the first release candidate's exact tables (shared with upgrade.rs), version 1.
    std::fs::create_dir_all(&engine.dir).unwrap();
    std::fs::set_permissions(&engine.dir, std::os::unix::fs::PermissionsExt::from_mode(0o700)).unwrap();
    let db = rusqlite::Connection::open(engine.dir.join("mailbox.sqlite3")).unwrap();
    db.execute_batch(SCHEMA_1).unwrap();
    db.execute_batch(
        "INSERT INTO messages VALUES ('m_1', 'user', 'k', 'd', 'message', 'hello', 5, NULL, NULL, NULL, 'claude-code', 'native-a', '{\"path\":\"/work/repo\",\"incarnation\":\"c1\"}', 'session-1', 1000);
         INSERT INTO deliveries (message_id, state, expires_at, updated_at) VALUES ('m_1', 'queued', 4102444800000, 1000);
         PRAGMA user_version = 1;",
    )
    .unwrap();
    drop(db);
    std::fs::set_permissions(engine.dir.join("mailbox.sqlite3"), std::os::unix::fs::PermissionsExt::from_mode(0o600)).unwrap();

    killed(&engine, "reconcile", json!({ "recipient": recipient("native-a") }), "migrate:before-commit");
    let db = rusqlite::Connection::open(engine.dir.join("mailbox.sqlite3")).unwrap();
    let version: i64 = db.pragma_query_value(None, "user_version", |row| row.get(0)).unwrap();
    assert_eq!(version, 1, "a killed upgrade must leave the earlier schema");
    drop(db);
    // Still readable, nothing lost.
    assert_eq!(engine.ok("status", json!({ "message_id": "m_1" }))["state"], "queued");
    // A retry completes it.
    engine.ok("reconcile", json!({ "recipient": recipient("native-a") }));
    let db = rusqlite::Connection::open(engine.dir.join("mailbox.sqlite3")).unwrap();
    let version: i64 = db.pragma_query_value(None, "user_version", |row| row.get(0)).unwrap();
    assert_eq!(version, 2);
    assert_eq!(engine.ok("status", json!({ "message_id": "m_1" }))["locator"], "session-1");
}
