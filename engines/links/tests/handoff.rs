mod common;
use common::*;
use serde_json::{Value, json};

fn claim_args(native_id: &str) -> Value {
    json!({ "recipient": recipient(native_id) })
}

fn sent(engine: &Engine, key: &str, body: &str, native_id: &str) -> String {
    engine.ok("send", send_args(key, body, native_id))["message_id"].as_str().unwrap().to_string()
}

fn state(engine: &Engine, id: &str) -> Value {
    engine.ok("status", json!({ "message_id": id }))
}

#[test]
fn claim_moves_mail_to_handoff_unknown_and_never_returns_it_again() {
    let engine = Engine::new();
    let id = sent(&engine, "k1", "first question", "native-a");

    let claim = engine.ok("claim", claim_args("native-a"));
    assert_eq!(claim["messages"].as_array().unwrap().len(), 1);
    assert_eq!(claim["messages"][0]["message_id"], id);
    assert_eq!(claim["messages"][0]["body"], "first question");
    assert!(claim["attempt_id"].as_str().unwrap().starts_with("a_"));

    let after = state(&engine, &id);
    assert_eq!(after["state"], "handoff-unknown");
    assert_eq!(after["attempts"], 1);

    let second = engine.ok("claim", claim_args("native-a"));
    assert_eq!(second["messages"], json!([]));
    assert_eq!(state(&engine, &id)["attempts"], 1);
}

#[test]
fn only_the_confirming_report_for_the_attempt_makes_it_handed_off() {
    let engine = Engine::new();
    let id = sent(&engine, "k1", "hello", "native-a");
    let claim = engine.ok("claim", claim_args("native-a"));

    let confirmed = engine.ok("confirm", json!({ "attempt_id": claim["attempt_id"], "recipient": recipient("native-a") }));
    assert_eq!(confirmed["confirmed"], json!([id]));
    assert_eq!(state(&engine, &id)["state"], "handed-off");

    // The same report again changes nothing.
    engine.ok("confirm", json!({ "attempt_id": claim["attempt_id"], "recipient": recipient("native-a") }));
    assert_eq!(state(&engine, &id)["state"], "handed-off");
}

#[test]
fn another_conversation_never_receives_the_mail() {
    let engine = Engine::new();
    let id = sent(&engine, "k1", "for a only", "native-a");
    let claim = engine.ok("claim", claim_args("native-b"));
    assert_eq!(claim["messages"], json!([]));
    assert_eq!(state(&engine, &id)["attempts"], 0);
}

#[test]
fn a_confirmation_from_the_wrong_recipient_or_for_an_unknown_attempt_fails() {
    let engine = Engine::new();
    let id = sent(&engine, "k1", "hello", "native-a");
    let claim = engine.ok("claim", claim_args("native-a"));

    let wrong = json!({ "attempt_id": claim["attempt_id"], "recipient": recipient("native-b") });
    assert_eq!(engine.err("confirm", wrong), "RECIPIENT_MISMATCH");
    assert_eq!(state(&engine, &id)["state"], "handoff-unknown");

    let unknown = json!({ "attempt_id": "a_unknown", "recipient": recipient("native-a") });
    assert_eq!(engine.err("confirm", unknown), "ATTEMPT_NOT_FOUND");
}

#[test]
fn only_the_addressed_recipient_can_acknowledge_and_only_after_handoff() {
    let engine = Engine::new();
    let id = sent(&engine, "k1", "hello", "native-a");
    let ack = |native_id: &str| json!({ "message_id": id, "recipient": recipient(native_id) });

    assert_eq!(engine.err("acknowledge", ack("native-a")), "INVALID_STATE");
    let claim = engine.ok("claim", claim_args("native-a"));
    assert_eq!(engine.err("acknowledge", ack("native-a")), "INVALID_STATE");

    engine.ok("confirm", json!({ "attempt_id": claim["attempt_id"], "recipient": recipient("native-a") }));
    assert_eq!(engine.err("acknowledge", ack("native-b")), "RECIPIENT_MISMATCH");
    assert_eq!(state(&engine, &id)["state"], "handed-off");

    assert_eq!(engine.ok("acknowledge", ack("native-a"))["state"], "acknowledged");
    assert_eq!(engine.ok("acknowledge", ack("native-a"))["state"], "acknowledged");
    assert_eq!(state(&engine, &id)["state"], "acknowledged");
}

#[test]
fn redelivery_creates_a_new_attempt_and_a_late_report_for_the_old_one_cannot_confirm_it() {
    let engine = Engine::new();
    let id = sent(&engine, "k1", "hello", "native-a");
    let first = engine.ok("claim", claim_args("native-a"));
    let redeliver = |attempt: &Value, native_id: &str| {
        json!({ "message_id": id, "attempt_id": attempt, "recipient": recipient(native_id) })
    };

    assert_eq!(engine.err("redeliver", redeliver(&first["attempt_id"], "native-b")), "RECIPIENT_MISMATCH");
    assert_eq!(engine.ok("redeliver", redeliver(&first["attempt_id"], "native-a"))["state"], "queued");
    assert_eq!(state(&engine, &id)["redeliveries"], 1);

    let second = engine.ok("claim", claim_args("native-a"));
    assert_ne!(second["attempt_id"], first["attempt_id"]);
    assert_eq!(second["messages"][0]["attempt"], 2);
    assert_eq!(state(&engine, &id)["attempts"], 2);

    // The first attempt's report arrives late: it says nothing about the second attempt.
    let late = engine.ok("confirm", json!({ "attempt_id": first["attempt_id"], "recipient": recipient("native-a") }));
    assert_eq!(late["confirmed"], json!([]));
    assert_eq!(late["superseded"], json!([id]));
    assert_eq!(state(&engine, &id)["state"], "handoff-unknown");

    engine.ok("confirm", json!({ "attempt_id": second["attempt_id"], "recipient": recipient("native-a") }));
    assert_eq!(state(&engine, &id)["state"], "handed-off");
}

#[test]
fn redelivery_is_refused_unless_the_exact_unknown_attempt_is_named() {
    let engine = Engine::new();
    let id = sent(&engine, "k1", "hello", "native-a");
    let redeliver = |attempt: &str| json!({ "message_id": id, "attempt_id": attempt, "recipient": recipient("native-a") });

    assert_eq!(engine.err("redeliver", redeliver("a_none")), "INVALID_STATE");
    let first = engine.ok("claim", claim_args("native-a"));
    assert_eq!(engine.err("redeliver", redeliver("a_other")), "ATTEMPT_MISMATCH");
    engine.ok("confirm", json!({ "attempt_id": first["attempt_id"], "recipient": recipient("native-a") }));
    assert_eq!(engine.err("redeliver", redeliver(first["attempt_id"].as_str().unwrap())), "INVALID_STATE");
    assert_eq!(state(&engine, &id)["state"], "handed-off");
}

#[test]
fn concurrent_claims_never_hand_the_same_message_to_two_attempts() {
    let engine = Engine::new();
    for n in 0..3 {
        sent(&engine, &format!("k{n}"), "hello", "native-a");
    }
    let dir = engine.dir.clone();
    let workers: Vec<_> = (0..6)
        .map(|_| {
            let dir = dir.clone();
            std::thread::spawn(move || Engine::at(&dir).ok("claim", claim_args("native-a"))["messages"].as_array().unwrap().len())
        })
        .collect();
    let claimed: usize = workers.into_iter().map(|worker| worker.join().unwrap()).sum();
    assert_eq!(claimed, 3);
}

#[test]
fn the_inbox_lists_a_sessions_mail_with_its_state_and_can_filter_by_state() {
    let engine = Engine::new();
    let first = sent(&engine, "k0", "one", "native-a");
    for n in 1..9 {
        sent(&engine, &format!("k{n}"), "more", "native-a");
    }
    // One turn carries eight; the ninth is still waiting.
    engine.ok("claim", claim_args("native-a"));

    let all = engine.ok("list", json!({ "session_hint": "session-1" }));
    assert_eq!(all["messages"].as_array().unwrap().len(), 9);
    assert!(all["messages"][0].get("body").is_none(), "the inbox lists metadata, not bodies");

    let unknown = engine.ok("list", json!({ "session_hint": "session-1", "state": "handoff-unknown" }));
    assert_eq!(unknown["messages"].as_array().unwrap().len(), 8);
    assert_eq!(unknown["messages"][0]["message_id"], first);
    let waiting = engine.ok("list", json!({ "session_hint": "session-1", "state": "queued" }));
    assert_eq!(waiting["messages"].as_array().unwrap().len(), 1);
    assert_eq!(engine.ok("list", json!({ "session_hint": "other-session" }))["messages"], json!([]));
}
