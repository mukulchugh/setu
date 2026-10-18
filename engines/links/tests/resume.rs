// An explicit, verified resume: the same provider, native conversation and checkout continues under a new
// managed session record. The message's recipient never changes; only where it is located does.
mod common;
use common::*;
use rusqlite::Connection;
use serde_json::{Value, json};

fn located_at(native_id: &str, hint: &str) -> Value {
    let mut value = recipient(native_id);
    value["session_hint"] = json!(hint);
    value
}

fn state(engine: &Engine, id: &str) -> Value {
    engine.ok("status", json!({ "message_id": id }))
}

fn queued(engine: &Engine, key: &str, native_id: &str) -> String {
    engine.ok("send", send_args(key, "hello", native_id))["message_id"].as_str().unwrap().to_string()
}

fn resume(engine: &Engine, native_id: &str, hint: &str, from: &[&str]) -> Value {
    engine.ok("resume", json!({ "recipient": located_at(native_id, hint), "from": from }))
}

#[test]
fn mail_held_when_the_conversation_was_replaced_returns_when_it_is_resumed_under_a_new_record() {
    let engine = Engine::new();
    let id = queued(&engine, "k1", "native-a");
    engine.ok("reconcile", json!({ "recipient": recipient("native-b") }));
    assert_eq!(state(&engine, &id)["reason"], "conversation-replaced");

    let outcome = resume(&engine, "native-a", "session-2", &["session-1"]);
    assert_eq!(outcome, json!({ "moved": [id], "released": [id] }));

    let after = state(&engine, &id);
    assert_eq!(after["state"], "queued");
    assert_eq!(after["locator"], "session-2");
    // The original locator and the immutable recipient are untouched.
    assert_eq!(after["recipient"], recipient("native-a"));
    let claim = engine.ok("claim", json!({ "recipient": located_at("native-a", "session-2") }));
    assert_eq!(claim["messages"][0]["message_id"], id);
}

#[test]
fn queued_mail_is_found_through_the_new_record_and_still_through_the_old_one() {
    let engine = Engine::new();
    let id = queued(&engine, "k1", "native-a");
    let outcome = resume(&engine, "native-a", "session-2", &["session-1"]);
    assert_eq!(outcome, json!({ "moved": [id], "released": [] }));

    for hint in ["session-2", "session-1"] {
        let listed = engine.ok("list", json!({ "session_hint": hint }));
        assert_eq!(listed["messages"][0]["message_id"], id, "listed under {hint}");
        assert_eq!(listed["messages"][0]["locator"], "session-2");
        assert_eq!(listed["messages"][0]["recipient"]["session_hint"], "session-1");
    }
}

#[test]
fn a_resume_is_repeatable_and_changes_nothing_the_second_time() {
    let engine = Engine::new();
    queued(&engine, "k1", "native-a");
    resume(&engine, "native-a", "session-2", &["session-1"]);
    let again = resume(&engine, "native-a", "session-2", &["session-1"]);
    assert_eq!(again, json!({ "moved": [], "released": [] }));
}

#[test]
fn only_the_resumed_conversation_in_its_checkout_moves() {
    let engine = Engine::new();
    let other_conversation = queued(&engine, "k1", "native-b");
    let mine = queued(&engine, "k2", "native-a");
    let mut other_checkout = send_args("k3", "hello", "native-a");
    other_checkout["recipient"]["checkout"] = json!("{\"path\":\"/work/repo\",\"incarnation\":\"c2\"}");
    let elsewhere = engine.ok("send", other_checkout)["message_id"].as_str().unwrap().to_string();

    let outcome = resume(&engine, "native-a", "session-2", &["session-1"]);
    assert_eq!(outcome["moved"], json!([mine]));
    assert_eq!(state(&engine, &other_conversation)["locator"], "session-1");
    assert_eq!(state(&engine, &elsewhere)["locator"], "session-1");
}

#[test]
fn mail_from_a_locator_that_was_not_named_stays_where_it_is() {
    let engine = Engine::new();
    let id = queued(&engine, "k1", "native-a");
    let outcome = resume(&engine, "native-a", "session-3", &["session-2"]);
    assert_eq!(outcome, json!({ "moved": [], "released": [] }));
    assert_eq!(state(&engine, &id)["locator"], "session-1");
}

#[test]
fn resume_releases_only_the_hold_it_resolves_and_never_another_reason() {
    let engine = Engine::new();
    let replaced = queued(&engine, "k1", "native-a");
    let other = queued(&engine, "k2", "native-a");
    engine.ok("reconcile", json!({ "recipient": recipient("native-b") }));
    // A hold for some other reason, set directly because no public operation yet produces one.
    let db = Connection::open(engine.dir.join("mailbox.sqlite3")).unwrap();
    db.execute("UPDATE deliveries SET reason = 'sharing disabled' WHERE message_id = ?1", [&other]).unwrap();
    drop(db);

    let outcome = resume(&engine, "native-a", "session-2", &["session-1"]);
    assert_eq!(outcome["released"], json!([replaced]));
    assert_eq!(state(&engine, &replaced)["state"], "queued");
    let still = state(&engine, &other);
    assert_eq!(still["state"], "held");
    assert_eq!(still["reason"], "sharing disabled");
}

#[test]
fn handed_off_unknown_cancelled_and_expired_mail_keeps_its_state_when_moved() {
    let engine = Engine::new();
    let unknown = queued(&engine, "k1", "native-a");
    let claim = engine.ok("claim", json!({ "recipient": recipient("native-a") }));
    assert_eq!(claim["messages"][0]["message_id"], unknown);
    let cancelled = queued(&engine, "k2", "native-a");
    engine.ok("cancel", json!({ "message_id": cancelled, "sender": { "kind": "user" } }));

    resume(&engine, "native-a", "session-2", &["session-1"]);
    let moved_unknown = state(&engine, &unknown);
    assert_eq!(moved_unknown["state"], "handoff-unknown");
    assert_eq!(moved_unknown["locator"], "session-2");
    assert_eq!(state(&engine, &cancelled)["state"], "cancelled");
    // Nothing re-delivers by itself after a resume.
    let again = engine.ok("claim", json!({ "recipient": located_at("native-a", "session-2") }));
    assert_eq!(again["messages"], json!([]));
}

#[test]
fn after_a_resume_a_later_replacement_holds_the_moved_mail_under_the_new_record() {
    let engine = Engine::new();
    let id = queued(&engine, "k1", "native-a");
    resume(&engine, "native-a", "session-2", &["session-1"]);

    let held = engine.ok("reconcile", json!({ "recipient": located_at("native-b", "session-2") }));
    assert_eq!(held["held"], json!([id]));
    assert_eq!(state(&engine, &id)["reason"], "conversation-replaced");
    // The ended old record's report no longer controls it.
    let old = engine.ok("reconcile", json!({ "recipient": located_at("native-a", "session-1") }));
    assert_eq!(old["released"], json!([]));
    let back = engine.ok("reconcile", json!({ "recipient": located_at("native-a", "session-2") }));
    assert_eq!(back["released"], json!([id]));
}

#[test]
fn a_resume_without_a_store_creates_none() {
    let engine = Engine::new();
    let outcome = resume(&engine, "native-a", "session-2", &["session-1"]);
    assert_eq!(outcome, json!({ "moved": [], "released": [] }));
    assert!(!engine.dir.exists());
}

#[test]
fn a_malformed_resume_is_refused_and_changes_nothing() {
    let engine = Engine::new();
    let id = queued(&engine, "k1", "native-a");
    let too_many: Vec<String> = (0..9).map(|n| format!("session-x{n}")).collect();
    for from in [json!([]), json!("session-1"), json!([""]), json!([1]), json!(too_many)] {
        assert_eq!(engine.err("resume", json!({ "recipient": located_at("native-a", "session-2"), "from": from })), "REQUEST_INVALID");
    }
    assert_eq!(
        engine.err("resume", json!({ "recipient": located_at("native-a", "session-2"), "from": ["session-1"], "wake": true })),
        "FIELD_UNSUPPORTED"
    );
    assert_eq!(state(&engine, &id)["locator"], "session-1");
}
