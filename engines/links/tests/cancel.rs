mod common;
use common::*;
use serde_json::json;

fn cancel(id: &str) -> serde_json::Value {
    json!({ "message_id": id, "sender": { "kind": "user" } })
}

#[test]
fn a_cancelled_message_is_never_handed_off() {
    let engine = Engine::new();
    let id = engine.ok("send", send_args("k1", "oops", "native-a"))["message_id"].as_str().unwrap().to_string();
    assert_eq!(engine.ok("cancel", cancel(&id))["state"], "cancelled");
    assert_eq!(engine.ok("cancel", cancel(&id))["state"], "cancelled");

    let claim = engine.ok("claim", json!({ "recipient": recipient("native-a") }));
    assert_eq!(claim["messages"], json!([]));
    let status = engine.ok("status", json!({ "message_id": id }));
    assert_eq!(status["state"], "cancelled");
    assert_eq!(status["attempts"], 0);
}

#[test]
fn mail_that_was_claimed_can_no_longer_be_cancelled() {
    let engine = Engine::new();
    let id = engine.ok("send", send_args("k1", "hello", "native-a"))["message_id"].as_str().unwrap().to_string();
    let claim = engine.ok("claim", json!({ "recipient": recipient("native-a") }));

    assert_eq!(engine.err("cancel", cancel(&id)), "NOT_CANCELLABLE");
    assert_eq!(engine.ok("status", json!({ "message_id": id }))["state"], "handoff-unknown");

    engine.ok("confirm", json!({ "attempt_id": claim["attempt_id"], "recipient": recipient("native-a") }));
    assert_eq!(engine.err("cancel", cancel(&id)), "NOT_CANCELLABLE");
}

#[test]
fn held_mail_can_be_cancelled_and_unknown_mail_is_not_found() {
    let engine = Engine::new();
    let id = engine.ok("send", send_args("k1", "hello", "native-a"))["message_id"].as_str().unwrap().to_string();
    engine.ok("reconcile", json!({ "recipient": recipient("native-b") }));
    assert_eq!(engine.ok("status", json!({ "message_id": id }))["state"], "held");
    assert_eq!(engine.ok("cancel", cancel(&id))["state"], "cancelled");
    assert_eq!(engine.err("cancel", cancel("m_missing")), "MESSAGE_NOT_FOUND");
}
