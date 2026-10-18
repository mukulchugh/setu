//! A peer owns the recipient's state, but not the vocabulary: whatever it replies is checked in one place, an
//! invalid reply is never stored or shown, and the sender's message stays readable with an explicit failure.
mod common;
use common::*;
use serde_json::{Value, json};
use std::sync::{Arc, Mutex};

fn status(engine: &Engine, id: &str) -> Value {
    engine.ok("status", json!({ "message_id": id }))
}

/// An engine with a daemon, dialing a hand-written peer that publishes one session and answers as the test says.
struct Scene {
    a: Engine,
    b_id: String,
    _daemon: Daemon,
    _server: RawServer,
    answer: Arc<Mutex<Value>>,
}

fn scene(first: Value) -> Scene {
    let a = Engine::new();
    let key = Raw::new_key();
    let answer = Arc::new(Mutex::new(first));
    let shared = answer.clone();
    let server = RawServer::start(key_copy(&key), vec![published_entry("native-a")], move |request| polite(&request).unwrap_or_else(|| shared.lock().unwrap().clone()));
    let daemon = a.start();
    let b_id = key.public().to_string();
    a.ok("peer_add", json!({ "peer_id": b_id, "label": "machine b", "addresses": [server.addr] }));
    a.ok("peer_grant", json!({ "peer_id": b_id, "capability": "send", "scope": { "kind": "peer" } }));
    a.wait_published_by(&b_id);
    Scene { a, b_id, _daemon: daemon, _server: server, answer }
}

fn key_copy(key: &iroh::SecretKey) -> iroh::SecretKey {
    Raw::key_from(key)
}

fn deposited(state: &str, reason: Value, seq: i64) -> Value {
    json!({ "t": "deposited", "state": state, "reason": reason, "seq": seq, "replayed": false })
}

#[test]
fn an_invalid_deposit_answer_is_never_stored_and_the_message_stays_readable_and_retried() {
    let bad = [
        ("an unknown state", deposited("delivered-to-the-moon", Value::Null, 1)),
        ("an enormous reason", deposited("queued", json!("r".repeat(5000)), 1)),
        ("a negative sequence", deposited("queued", Value::Null, -4)),
        ("a sequence no number can carry", deposited("queued", Value::Null, i64::MAX)),
        ("a control character in the reason", deposited("queued", json!("line\u{1b}[2Jbreak"), 1)),
        ("a rejection with a lowercase code", json!({ "t": "rejected", "code": "not a code", "retryable": true, "supported": null })),
    ];
    for (what, reply) in bad {
        let scene = scene(reply);
        let id = scene.a.send_to_peer(&scene.b_id, "k1", "hello")["message_id"].as_str().unwrap().to_string();
        wait_until("the invalid answer to be noticed", || status(&scene.a, &id)["transport"]["last_error"] == "PEER_REPLY_INVALID");
        let seen = status(&scene.a, &id);
        assert_eq!((seen["state"].as_str(), seen["transport"]["outbox"].as_str()), (Some("queued"), Some("pending")), "{what}");
        assert_eq!(seen["transport"]["remote_state"], Value::Null, "{what}: peer data was kept");
        let raw = std::fs::read(scene.a.dir.join("mailbox.sqlite3")).unwrap();
        for forbidden in ["delivered-to-the-moon", "not a code", "break"] {
            assert!(!String::from_utf8_lossy(&raw).contains(forbidden), "{what}: {forbidden:?} reached the sender's database");
        }
        // The same message completes once the peer answers properly: it was never given up on.
        *scene.answer.lock().unwrap() = deposited("queued", Value::Null, 1);
        wait_until("the retry to succeed", || status(&scene.a, &id)["transport"]["outbox"] == "deposited");
        assert_eq!(status(&scene.a, &id)["transport"]["last_error"], Value::Null, "{what}: the failure outlived the success");
    }
}

#[test]
fn an_invalid_cancel_answer_never_confirms_a_cancel() {
    let scene = scene(deposited("queued", Value::Null, 1));
    let id = scene.a.send_to_peer(&scene.b_id, "k1", "oops")["message_id"].as_str().unwrap().to_string();
    wait_until("the deposit", || status(&scene.a, &id)["transport"]["outbox"] == "deposited");
    *scene.answer.lock().unwrap() = json!({ "t": "cancel_result", "result": "cancelled", "state": "weird", "reason": null });
    scene.a.ok("cancel", json!({ "message_id": id, "sender": { "kind": "user" } }));
    wait_until("the invalid answer to be noticed", || status(&scene.a, &id)["transport"]["last_error"] == "PEER_REPLY_INVALID");
    let seen = status(&scene.a, &id);
    assert_eq!(seen["transport"]["cancel"], "requested");
    assert_ne!(seen["state"], "cancelled");
    // A valid confirmation later still works.
    *scene.answer.lock().unwrap() = json!({ "t": "cancel_result", "result": "cancelled", "state": "cancelled", "reason": "cancelled by sender" });
    wait_until("the confirmation", || status(&scene.a, &id)["state"] == "cancelled");
}

#[test]
fn a_cancel_answer_that_is_neither_cancelled_nor_refused_is_invalid() {
    let scene = scene(deposited("queued", Value::Null, 1));
    let id = scene.a.send_to_peer(&scene.b_id, "k1", "oops")["message_id"].as_str().unwrap().to_string();
    wait_until("the deposit", || status(&scene.a, &id)["transport"]["outbox"] == "deposited");
    *scene.answer.lock().unwrap() = json!({ "t": "cancel_result", "result": "maybe", "state": "queued", "reason": null });
    scene.a.ok("cancel", json!({ "message_id": id, "sender": { "kind": "user" } }));
    wait_until("the invalid answer to be noticed", || status(&scene.a, &id)["transport"]["last_error"] == "PEER_REPLY_INVALID");
    assert_eq!(status(&scene.a, &id)["transport"]["cancel"], "requested");
}

#[test]
fn a_contradictory_cancel_answer_never_confirms_or_refuses_a_cancel() {
    let scene = scene(deposited("queued", Value::Null, 1));
    let id = scene.a.send_to_peer(&scene.b_id, "k1", "oops")["message_id"].as_str().unwrap().to_string();
    wait_until("the deposit", || status(&scene.a, &id)["transport"]["outbox"] == "deposited");
    scene.a.ok("cancel", json!({ "message_id": id, "sender": { "kind": "user" } }));
    // "cancelled" with a state that says the message was handed over, acknowledged, or still waiting, and "refused"
    // with a state of cancelled, each contradict themselves: none may settle the cancel either way.
    for (result, state) in [("cancelled", "handed-off"), ("cancelled", "acknowledged"), ("cancelled", "queued"), ("refused", "cancelled")] {
        *scene.answer.lock().unwrap() = json!({ "t": "cancel_result", "result": result, "state": state, "reason": null });
        std::thread::sleep(std::time::Duration::from_millis(2500));
        let seen = status(&scene.a, &id);
        assert_eq!(seen["transport"]["cancel"], "requested", "{result}/{state}");
        assert_ne!(seen["state"], "cancelled", "{result}/{state}");
        assert_eq!(seen["transport"]["remote_state"], "queued", "{result}/{state}: the peer's contradiction was stored");
        assert_eq!(seen["transport"]["last_error"], "PEER_REPLY_INVALID", "{result}/{state}");
    }
    // A consistent answer still settles it.
    *scene.answer.lock().unwrap() = json!({ "t": "cancel_result", "result": "refused", "state": "handed-off", "reason": null });
    wait_until("a consistent refusal", || status(&scene.a, &id)["transport"]["cancel"] == "refused");
    assert_eq!(status(&scene.a, &id)["transport"]["remote_state"], "handed-off");
}

/// Everything the engine under test sends this hand-written peer, in order, by request type.
fn dialled_scene(hello_answer: Value) -> (Scene2, Arc<Mutex<Vec<String>>>) {
    let a = Engine::new();
    let key = Raw::new_key();
    let seen = Arc::new(Mutex::new(Vec::new()));
    let recorded = seen.clone();
    let server = RawServer::start(Raw::key_from(&key), vec![published_entry("native-a")], move |request| {
        recorded.lock().unwrap().push(request["t"].as_str().unwrap_or("?").to_string());
        match request["t"].as_str() {
            Some("hello") => hello_answer.clone(),
            _ => polite(&request).unwrap_or(json!({ "t": "ok" })),
        }
    });
    let daemon = a.start();
    let b_id = key.public().to_string();
    a.ok("peer_add", json!({ "peer_id": b_id, "label": "machine b", "addresses": [server.addr] }));
    a.ok("peer_grant", json!({ "peer_id": b_id, "capability": "send", "scope": { "kind": "peer" } }));
    (Scene2 { a, b_id, _daemon: daemon, _server: server }, seen)
}

struct Scene2 {
    a: Engine,
    b_id: String,
    _daemon: Daemon,
    _server: RawServer,
}

fn hello_ok(version: u64, capabilities: Value) -> Value {
    json!({ "t": "hello_ok", "version": version, "capabilities": capabilities })
}

fn link_state(scene: &Scene2) -> Option<(String, Option<String>)> {
    scene.a.ok("transport_status", json!({}))["links"]
        .as_array()
        .and_then(|links| links.iter().find(|l| l["peer_id"] == scene.b_id))
        .map(|l| (l["state"].as_str().unwrap().to_string(), l["code"].as_str().map(str::to_string)))
}

#[test]
fn a_peer_answering_hello_with_an_unsupported_version_or_missing_capabilities_is_never_published_or_deposited_to() {
    let all = json!(setu_links::wire::CAPABILITIES);
    let cases = [
        ("an unsupported version", hello_ok(1, all.clone()), "PROTOCOL_INCOMPATIBLE"),
        ("no capabilities at all", hello_ok(setu_links::wire::VERSIONS[0] as u64, json!([])), "CAPABILITY_MISSING"),
        ("one mandatory capability missing", hello_ok(setu_links::wire::VERSIONS[0] as u64, json!(["cancel", "published", "receipt"])), "CAPABILITY_MISSING"),
    ];
    for (what, answer, code) in cases {
        let (scene, seen) = dialled_scene(answer);
        wait_until(what, || link_state(&scene).is_some_and(|(state, _)| state == "incompatible"));
        assert_eq!(link_state(&scene).unwrap().1.as_deref(), Some(code), "{what}");
        std::thread::sleep(std::time::Duration::from_millis(2500));
        let sent = seen.lock().unwrap().clone();
        assert!(sent.iter().all(|t| t == "hello"), "{what}: the engine went on to send {sent:?}");
    }
}

#[test]
fn a_peer_offering_extra_optional_capabilities_is_welcome() {
    let mut capabilities: Vec<&str> = setu_links::wire::CAPABILITIES.to_vec();
    capabilities.push("something-newer");
    let (scene, seen) = dialled_scene(hello_ok(setu_links::wire::VERSIONS[0] as u64, json!(capabilities)));
    wait_until("the engine to publish to the peer", || seen.lock().unwrap().iter().any(|t| t == "published"));
    assert!(link_state(&scene).is_some_and(|(state, _)| state == "connected"));
}
