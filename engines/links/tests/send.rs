mod common;
use common::*;

#[test]
fn send_commits_a_queued_message_and_status_reports_it() {
    let engine = Engine::new();
    let sent = engine.ok("send", send_args("key-1", "hello there", "native-a"));
    assert_eq!(sent["state"], "queued");
    assert_eq!(sent["replayed"], false);
    let id = sent["message_id"].as_str().unwrap();

    let status = engine.ok("status", serde_json::json!({ "message_id": id }));
    assert_eq!(status["state"], "queued");
    assert_eq!(status["attempts"], 0);
}

#[test]
fn repeating_a_send_with_the_same_key_and_payload_returns_the_same_message() {
    let engine = Engine::new();
    let first = engine.ok("send", send_args("key-1", "hello", "native-a"));
    let again = engine.ok("send", send_args("key-1", "hello", "native-a"));
    assert_eq!(again["message_id"], first["message_id"]);
    assert_eq!(again["replayed"], true);

    let inbox = engine.ok("list", serde_json::json!({ "session_hint": "session-1" }));
    assert_eq!(inbox["messages"].as_array().unwrap().len(), 1);
}

#[test]
fn the_same_key_with_a_different_payload_conflicts_and_changes_nothing() {
    let engine = Engine::new();
    let first = engine.ok("send", send_args("key-1", "hello", "native-a"));

    for changed in [send_args("key-1", "different body", "native-a"), send_args("key-1", "hello", "native-b")] {
        let reply = engine.call("send", changed);
        assert_eq!(reply["error"]["code"], "IDEMPOTENCY_CONFLICT");
        assert_eq!(reply["error"]["details"]["message_id"], first["message_id"]);
    }
    let inbox = engine.ok("list", serde_json::json!({ "session_hint": "session-1" }));
    assert_eq!(inbox["messages"].as_array().unwrap().len(), 1);
    let shown = engine.ok("show", serde_json::json!({ "message_id": first["message_id"] }));
    assert_eq!(shown["body"], "hello");
    assert_eq!(shown["recipient"]["native_id"], "native-a");
}

#[test]
fn run_and_span_hints_are_kept_with_the_message_and_are_part_of_what_a_key_means() {
    let engine = Engine::new();
    let mut args = send_args("k1", "hello", "native-a");
    args["run_hint"] = serde_json::json!("run-7");
    args["span_hint"] = serde_json::json!("span-2");
    let id = engine.ok("send", args.clone())["message_id"].clone();

    let shown = engine.ok("show", serde_json::json!({ "message_id": id }));
    assert_eq!(shown["run_hint"], "run-7");
    assert_eq!(shown["span_hint"], "span-2");

    args["run_hint"] = serde_json::json!("run-8");
    assert_eq!(engine.err("send", args), "IDEMPOTENCY_CONFLICT");
}
