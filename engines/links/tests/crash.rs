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
