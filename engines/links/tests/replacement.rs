mod common;
use common::*;
use serde_json::{Value, json};

fn state(engine: &Engine, id: &str) -> Value {
    engine.ok("status", json!({ "message_id": id }))
}

fn reconcile(engine: &Engine, native_id: &str) -> Value {
    engine.ok("reconcile", json!({ "recipient": recipient(native_id) }))
}

fn queued(engine: &Engine, key: &str, native_id: &str) -> String {
    engine.ok("send", send_args(key, "hello", native_id))["message_id"].as_str().unwrap().to_string()
}

fn moved_checkout(native_id: &str) -> Value {
    let mut moved = recipient(native_id);
    moved["checkout"] = json!("{\"path\":\"/work/repo\",\"incarnation\":\"c2\"}");
    moved
}

#[test]
fn a_reported_replacement_holds_the_old_mail_where_a_plain_read_sees_it() {
    let engine = Engine::new();
    let id = queued(&engine, "k1", "native-a");
    assert_eq!(state(&engine, &id)["state"], "queued");

    let result = reconcile(&engine, "native-b");
    assert_eq!(result["held"], json!([id]));

    for view in [state(&engine, &id), engine.ok("show", json!({ "message_id": id }))] {
        assert_eq!(view["state"], "held");
        assert_eq!(view["reason"], "conversation-replaced");
    }
    let listed = engine.ok("list", json!({ "session_hint": "session-1" }));
    assert_eq!(listed["messages"][0]["state"], "held");
}

#[test]
fn the_new_conversation_never_receives_the_old_conversations_mail() {
    let engine = Engine::new();
    let id = queued(&engine, "k1", "native-a");
    reconcile(&engine, "native-b");
    let claim = engine.ok("claim", json!({ "recipient": recipient("native-b") }));
    assert_eq!(claim["messages"], json!([]));
    assert_eq!(state(&engine, &id)["attempts"], 0);
}

#[test]
fn held_mail_returns_only_when_the_exact_conversation_is_reported_again() {
    let engine = Engine::new();
    let id = queued(&engine, "k1", "native-a");
    reconcile(&engine, "native-b");

    // The old conversation is not claimable while it is not the one the session runs.
    assert_eq!(engine.ok("claim", json!({ "recipient": recipient("native-a") }))["messages"], json!([]));
    // A third conversation, or the replacement again, never releases it.
    reconcile(&engine, "native-c");
    reconcile(&engine, "native-b");
    assert_eq!(state(&engine, &id)["state"], "held");

    let resumed = reconcile(&engine, "native-a");
    assert_eq!(resumed["released"], json!([id]));
    assert_eq!(state(&engine, &id)["state"], "queued");
    let claim = engine.ok("claim", json!({ "recipient": recipient("native-a") }));
    assert_eq!(claim["messages"][0]["message_id"], id);
}

#[test]
fn replacing_back_and_forth_keeps_each_conversations_mail_with_that_conversation() {
    let engine = Engine::new();
    let a = queued(&engine, "k1", "native-a");
    reconcile(&engine, "native-b");
    let b = queued(&engine, "k2", "native-b");
    assert_eq!(state(&engine, &b)["state"], "queued");

    reconcile(&engine, "native-a");
    assert_eq!(state(&engine, &a)["state"], "queued");
    assert_eq!(state(&engine, &b)["state"], "held");
    let claim = engine.ok("claim", json!({ "recipient": recipient("native-a") }));
    assert_eq!(claim["messages"].as_array().unwrap().len(), 1);
    assert_eq!(claim["messages"][0]["message_id"], a);
}

#[test]
fn a_claim_for_the_wrong_conversation_changes_nothing_for_anyone_else() {
    let engine = Engine::new();
    let id = queued(&engine, "k1", "native-a");
    let wrong = engine.ok("claim", json!({ "recipient": recipient("native-b") }));
    assert_eq!(wrong["messages"], json!([]));
    assert_eq!(state(&engine, &id)["state"], "queued");
    assert_eq!(state(&engine, &id)["reason"], Value::Null);
    let right = engine.ok("claim", json!({ "recipient": recipient("native-a") }));
    assert_eq!(right["messages"][0]["message_id"], id);
}

#[test]
fn sending_never_holds_anothers_mail_without_a_report() {
    let engine = Engine::new();
    let old = queued(&engine, "k1", "native-a");
    queued(&engine, "k2", "native-b");
    assert_eq!(state(&engine, &old)["state"], "queued");
}

#[test]
fn a_changed_checkout_holds_the_mail_and_only_the_original_checkout_releases_it() {
    let engine = Engine::new();
    let id = queued(&engine, "k1", "native-a");
    let result = engine.ok("reconcile", json!({ "recipient": moved_checkout("native-a") }));
    assert_eq!(result["held"], json!([id]));
    assert_eq!(state(&engine, &id)["reason"], "checkout-changed");
    assert_eq!(engine.ok("claim", json!({ "recipient": moved_checkout("native-a") }))["messages"], json!([]));

    assert_eq!(reconcile(&engine, "native-a")["released"], json!([id]));
    assert_eq!(state(&engine, &id)["state"], "queued");
}

#[test]
fn cancelled_expired_and_handed_off_mail_is_never_revived_by_a_report() {
    let engine = Engine::new();
    let cancelled = queued(&engine, "k1", "native-a");
    reconcile(&engine, "native-b");
    engine.ok("cancel", json!({ "message_id": cancelled, "sender": { "kind": "user" } }));
    reconcile(&engine, "native-a");
    assert_eq!(state(&engine, &cancelled)["state"], "cancelled");

    let sent = queued(&engine, "k2", "native-a");
    let claim = engine.ok("claim", json!({ "recipient": recipient("native-a") }));
    assert_eq!(claim["messages"][0]["message_id"], sent);
    reconcile(&engine, "native-b");
    reconcile(&engine, "native-a");
    assert_eq!(state(&engine, &sent)["state"], "handoff-unknown");
}

#[test]
fn another_sessions_mail_is_untouched() {
    let engine = Engine::new();
    let id = queued(&engine, "k1", "native-a");
    let mut other = recipient("native-z");
    other["session_hint"] = json!("session-2");
    engine.ok("reconcile", json!({ "recipient": other }));
    assert_eq!(state(&engine, &id)["state"], "queued");
}

#[test]
fn a_report_must_name_exactly_a_recipient_and_nothing_else() {
    let engine = Engine::new();
    assert_eq!(engine.err("reconcile", json!({})), "REQUEST_INVALID");
    assert_eq!(engine.err("reconcile", json!({ "recipient": recipient("native-a"), "wake": true })), "FIELD_UNSUPPORTED");
    assert!(!engine.dir.exists());
}

#[test]
fn a_read_with_a_trusted_observation_shows_the_effective_state_and_writes_nothing() {
    let engine = Engine::new();
    let id = queued(&engine, "k1", "native-a");
    let seen = json!({ "message_id": id, "observed": recipient("native-b") });

    let status = engine.ok("status", seen.clone());
    assert_eq!(status["state"], "held");
    assert_eq!(status["reason"], "conversation-replaced");
    assert_eq!(status["stored_state"], "queued");
    let shown = engine.ok("show", seen);
    assert_eq!((shown["state"].clone(), shown["body"].clone()), (json!("held"), json!("hello")));
    let listed = engine.ok("list", json!({ "session_hint": "session-1", "observed": recipient("native-b") }));
    assert_eq!(listed["messages"][0]["state"], "held");
    let held_only = engine.ok("list", json!({ "session_hint": "session-1", "state": "held", "observed": recipient("native-b") }));
    assert_eq!(held_only["messages"].as_array().unwrap().len(), 1);

    // Nothing was persisted: the same read with no observation still says queued.
    let plain = state(&engine, &id);
    assert_eq!((plain["state"].clone(), plain["stored_state"].clone()), (json!("queued"), json!("queued")));
}

#[test]
fn an_observation_of_the_exact_conversation_restores_held_mail_in_the_view_only() {
    let engine = Engine::new();
    let id = queued(&engine, "k1", "native-a");
    reconcile(&engine, "native-b");
    assert_eq!(state(&engine, &id)["state"], "held");

    let resumed = engine.ok("status", json!({ "message_id": id, "observed": recipient("native-a") }));
    assert_eq!((resumed["state"].clone(), resumed["stored_state"].clone()), (json!("queued"), json!("held")));
    assert_eq!(resumed["reason"], Value::Null);
    // A different conversation never restores it.
    let other = engine.ok("status", json!({ "message_id": id, "observed": recipient("native-c") }));
    assert_eq!(other["state"], "held");
    // The stored state changes only when the explicit report is made.
    assert_eq!(state(&engine, &id)["state"], "held");
    reconcile(&engine, "native-a");
    assert_eq!(state(&engine, &id)["state"], "queued");
}

#[test]
fn an_observation_of_a_changed_checkout_shows_checkout_changed() {
    let engine = Engine::new();
    let id = queued(&engine, "k1", "native-a");
    let seen = engine.ok("status", json!({ "message_id": id, "observed": moved_checkout("native-a") }));
    assert_eq!((seen["state"].clone(), seen["reason"].clone()), (json!("held"), json!("checkout-changed")));
}

#[test]
fn an_observation_never_changes_claimed_expired_or_other_sessions_mail() {
    let engine = Engine::new();
    let claimed = queued(&engine, "k1", "native-a");
    engine.ok("claim", json!({ "recipient": recipient("native-a") }));
    let seen = engine.ok("status", json!({ "message_id": claimed, "observed": recipient("native-b") }));
    assert_eq!(seen["state"], "handoff-unknown");

    let waiting = queued(&engine, "k2", "native-a");
    let mut other = recipient("native-z");
    other["session_hint"] = json!("session-2");
    let untouched = engine.ok("status", json!({ "message_id": waiting, "observed": other }));
    assert_eq!(untouched["state"], "queued");
}

#[test]
fn what_a_read_projects_is_what_the_explicit_report_then_persists() {
    let engine = Engine::new();
    let id = queued(&engine, "k1", "native-a");
    let projected = engine.ok("status", json!({ "message_id": id, "observed": recipient("native-b") }));
    reconcile(&engine, "native-b");
    let persisted = state(&engine, &id);
    assert_eq!((projected["state"].clone(), projected["reason"].clone()), (persisted["state"].clone(), persisted["reason"].clone()));
}

#[test]
fn a_malformed_observation_is_refused() {
    let engine = Engine::new();
    let id = queued(&engine, "k1", "native-a");
    assert_eq!(engine.err("status", json!({ "message_id": id, "observed": "native-b" })), "REQUEST_INVALID");
    assert_eq!(engine.err("status", json!({ "message_id": id, "observed": { "provider": "claude-code" } })), "REQUEST_INVALID");
}

#[test]
fn reads_reports_and_claims_on_an_absent_store_create_nothing() {
    let engine = Engine::new();
    assert_eq!(engine.ok("list", json!({ "session_hint": "session-1", "observed": recipient("native-a") }))["messages"], json!([]));
    assert_eq!(engine.err("status", json!({ "message_id": "m_1", "observed": recipient("native-a") })), "MESSAGE_NOT_FOUND");
    let reported = engine.ok("reconcile", json!({ "recipient": recipient("native-a") }));
    assert_eq!((reported["held"].clone(), reported["released"].clone()), (json!([]), json!([])));
    let claimed = engine.ok("claim", json!({ "recipient": recipient("native-a") }));
    assert_eq!(claimed["messages"], json!([]));
    assert!(!engine.dir.exists(), "only a send creates the store");
}
