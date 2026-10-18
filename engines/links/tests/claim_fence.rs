//! A claim may carry the generation its caller authenticated at. The engine refuses it, inside the claim's own
//! transaction and before touching anything, unless the session's snapshot is fresh, valid, exactly that
//! conversation, at exactly that generation. Callers that send no generation keep the original behavior.
mod common;
use common::*;
use serde_json::{Value, json};

fn publish(native_id: &str, generation: u64) -> Value {
    json!({ "recipient": recipient(native_id), "generation": generation, "valid_for_ms": 60_000 })
}

fn claim(native_id: &str, expected: u64) -> Value {
    json!({ "recipient": recipient(native_id), "expected_generation": expected })
}

fn state(engine: &Engine, id: &str) -> String {
    engine.ok("show", json!({ "message_id": id }))["state"].as_str().unwrap().to_string()
}

fn queued_for(engine: &Engine, key: &str, native_id: &str) -> String {
    engine.ok("send", send_args(key, "hello", native_id))["message_id"].as_str().unwrap().to_string()
}

#[test]
fn a_stale_conversations_claim_is_refused_and_leaves_both_conversations_mail_exactly_as_it_was() {
    let engine = Engine::new();
    let for_x = queued_for(&engine, "kx", "native-x");
    let for_y = queued_for(&engine, "ky", "native-y");
    engine.ok("binding_publish", publish("native-x", 1));
    // X is replaced by Y: X's mail is held, Y's is queued.
    engine.ok("binding_publish", publish("native-y", 2));
    assert_eq!((state(&engine, &for_x).as_str(), state(&engine, &for_y).as_str()), ("held", "queued"));
    let before = engine.snapshot();

    assert_eq!(engine.err("claim", claim("native-x", 1)), "BINDING_NOT_CURRENT");
    assert_eq!(engine.snapshot(), before, "a refused claim changed the store");
    assert_eq!((state(&engine, &for_x).as_str(), state(&engine, &for_y).as_str()), ("held", "queued"));
}

#[test]
fn the_current_conversation_claims_at_its_generation() {
    let engine = Engine::new();
    let id = queued_for(&engine, "k", "native-x");
    engine.ok("binding_publish", publish("native-x", 4));
    let claimed = engine.ok("claim", claim("native-x", 4));
    assert_eq!(claimed["messages"].as_array().unwrap().len(), 1);
    assert_eq!(state(&engine, &id), "handoff-unknown");
}

#[test]
fn a_heartbeat_at_the_same_generation_does_not_disturb_a_claim_that_was_authenticated_before_it() {
    let engine = Engine::new();
    queued_for(&engine, "k", "native-x");
    engine.ok("binding_publish", publish("native-x", 4));
    engine.ok("binding_publish", publish("native-x", 4));
    assert_eq!(engine.ok("claim", claim("native-x", 4))["messages"].as_array().unwrap().len(), 1);
}

#[test]
fn a_claim_at_a_generation_other_than_the_snapshots_is_refused() {
    let engine = Engine::new();
    let id = queued_for(&engine, "k", "native-x");
    engine.ok("binding_publish", publish("native-x", 4));
    let before = engine.snapshot();
    for wrong in [3, 5] {
        assert_eq!(engine.err("claim", claim("native-x", wrong)), "BINDING_NOT_CURRENT");
    }
    assert_eq!(engine.snapshot(), before);
    assert_eq!(state(&engine, &id), "queued");
}

#[test]
fn an_invalidated_session_refuses_the_claim_even_at_the_matching_generation() {
    let engine = Engine::new();
    let id = queued_for(&engine, "k", "native-x");
    engine.ok("binding_publish", publish("native-x", 4));
    engine.ok("binding_invalidate", json!({ "session_hint": "session-1", "reason": "ended", "generation": 5 }));
    let before = engine.snapshot();
    assert_eq!(engine.err("claim", claim("native-x", 4)), "BINDING_NOT_CURRENT");
    assert_eq!(engine.err("claim", claim("native-x", 5)), "BINDING_NOT_CURRENT");
    assert_eq!(engine.snapshot(), before);
    assert_eq!(state(&engine, &id), "held");
}

#[test]
fn a_session_with_no_snapshot_refuses_the_claim_and_creates_no_store() {
    let engine = Engine::new();
    assert_eq!(engine.err("claim", claim("native-x", 1)), "BINDING_NOT_CURRENT");
    assert!(!engine.dir.exists());
}

#[test]
fn a_snapshot_for_another_conversation_at_the_same_generation_refuses_the_claim() {
    let engine = Engine::new();
    queued_for(&engine, "k", "native-x");
    engine.ok("binding_publish", publish("native-y", 4));
    // Same generation number, different tuple: the claim names a conversation the session does not run.
    assert_eq!(engine.err("claim", claim("native-x", 4)), "BINDING_NOT_CURRENT");
}

#[test]
fn a_claim_that_names_a_generation_must_name_a_whole_number() {
    let engine = Engine::new();
    for bad in [json!(-1), json!("4"), json!(1.5), json!(null)] {
        let mut args = claim("native-x", 1);
        args["expected_generation"] = bad;
        let code = engine.err("claim", args);
        assert!(code == "REQUEST_INVALID" || code == "FIELD_TOO_LARGE", "{code}");
    }
    assert!(!engine.dir.exists());
}

#[test]
fn a_claim_without_a_generation_keeps_the_original_behavior() {
    let engine = Engine::new();
    let id = queued_for(&engine, "k", "native-x");
    assert_eq!(engine.ok("claim", json!({ "recipient": recipient("native-x") }))["messages"].as_array().unwrap().len(), 1);
    assert_eq!(state(&engine, &id), "handoff-unknown");
}

#[cfg(feature = "test-hooks")]
#[test]
fn a_snapshot_past_its_lifetime_refuses_the_claim_without_expiring_or_claiming_anything() {
    let engine = Engine::new();
    let at = |ms: i64, op: &str, args: Value| engine.call_env(op, args, &[("SETU_LINKS_TEST_NOW_MS", &ms.to_string())]);
    at(1_000_000, "send", send_args("k", "hello", "native-x"));
    at(1_000_000, "binding_publish", publish("native-x", 4));
    let before = engine.snapshot();
    let refused = at(1_060_001, "claim", claim("native-x", 4));
    assert_eq!(refused["error"]["code"], "BINDING_NOT_CURRENT");
    assert_eq!(engine.snapshot(), before);
}
