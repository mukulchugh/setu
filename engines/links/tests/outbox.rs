//! The sending side: what is accepted into the outbox, what the sender may say about it, and what comes back.
mod common;
use common::*;
use serde_json::{Value, json};
use setu_links::wire::{Locator, recipient_digest};

fn status(engine: &Engine, id: &str) -> Value {
    engine.ok("status", json!({ "message_id": id }))
}

fn outbox(engine: &Engine, id: &str) -> Value {
    status(engine, id)["transport"]["outbox"].clone()
}

fn remote_state(engine: &Engine, id: &str) -> Value {
    status(engine, id)["transport"]["remote_state"].clone()
}

fn ready() -> Pair {
    let pair = Pair::new();
    pair.authorize(&pair.a, &pair.a_id, &pair.b, &pair.b_id, "project-1");
    pair.wait_published(&pair.a, &pair.b_id);
    pair
}

fn b_inbox(pair: &Pair) -> Vec<Value> {
    pair.b.ok("list", json!({ "session_hint": "session-1" }))["messages"].as_array().unwrap().clone()
}

fn stop_b(pair: &mut Pair) {
    pair.b_daemon.take().unwrap().kill();
    wait_until("b to stop", || pair.b.ok("transport_status", json!({}))["running"] == false);
}

#[test]
fn a_send_naming_a_conversation_the_peer_never_published_is_rejected_here_and_stores_nothing() {
    let pair = ready();
    let before = pair.a.snapshot();
    let mut args = send_args("k1", "hello", "native-other");
    args["recipient"] = wire_recipient("native-other");
    args["peer_id"] = json!(pair.b_id);
    assert_eq!(pair.a.err("send", args), "RECIPIENT_UNBOUND");
    let mut other_session = send_args("k2", "hello", "native-a");
    other_session["recipient"] = wire_recipient("native-a");
    other_session["recipient"]["session_hint"] = json!("session-unknown");
    other_session["peer_id"] = json!(pair.b_id);
    assert_eq!(pair.a.err("send", other_session), "RECIPIENT_UNBOUND");
    assert_eq!(pair.a.snapshot(), before);
}

#[test]
fn a_send_needs_a_known_peer_and_a_send_grant() {
    let pair = ready();
    let mut stranger = send_args("k1", "hello", "native-a");
    stranger["recipient"] = wire_recipient("native-a");
    stranger["peer_id"] = json!(Raw::new_key().public().to_string());
    assert_eq!(pair.a.err("send", stranger), "PEER_UNKNOWN");

    pair.a.ok("peer_grant_remove", json!({ "peer_id": pair.b_id, "capability": "send", "scope": { "kind": "peer" } }));
    let mut args = send_args("k2", "hello", "native-a");
    args["recipient"] = wire_recipient("native-a");
    args["peer_id"] = json!(pair.b_id);
    assert_eq!(pair.a.err("send", args), "PEER_NOT_AUTHORIZED");
}

#[test]
fn a_retried_send_is_one_message_and_a_different_payload_under_the_same_key_is_a_conflict() {
    let pair = ready();
    let first = pair.send(&pair.a, &pair.b_id, "k1", "hello");
    let again = pair.send(&pair.a, &pair.b_id, "k1", "hello");
    assert_eq!(again["message_id"], first["message_id"]);
    assert_eq!(again["replayed"], true);
    let mut changed = send_args("k1", "something else", "native-a");
    changed["recipient"] = wire_recipient("native-a");
    changed["peer_id"] = json!(pair.b_id);
    assert_eq!(pair.a.err("send", changed), "IDEMPOTENCY_CONFLICT");
    wait_until("the deposit", || remote_state(&pair.a, first["message_id"].as_str().unwrap()) == "queued");
    assert_eq!(b_inbox(&pair).len(), 1);
}

#[test]
fn a_message_for_a_peer_can_never_be_claimed_or_listed_as_local_mail() {
    let pair = ready();
    pair.send(&pair.a, &pair.b_id, "k1", "hello");
    // Same conversation tuple on this machine: the outbox is not its inbox.
    assert_eq!(pair.a.ok("claim", json!({ "recipient": recipient("native-a") }))["messages"], json!([]));
    assert_eq!(pair.a.ok("list", json!({ "session_hint": "session-1" }))["messages"], json!([]));
}

#[test]
fn an_offline_peer_leaves_the_message_pending_and_it_is_deposited_when_the_peer_is_back() {
    let mut pair = ready();
    stop_b(&mut pair);
    let id = pair.send(&pair.a, &pair.b_id, "k1", "while you were away")["message_id"].as_str().unwrap().to_string();
    // Accepted in the outbox, not at the peer: the two stages are never conflated.
    std::thread::sleep(std::time::Duration::from_millis(2500));
    let waiting = status(&pair.a, &id);
    assert_eq!(waiting["transport"]["outbox"], "pending");
    assert_eq!(waiting["state"], "queued");
    assert_eq!(waiting["transport"]["remote_state"], Value::Null);

    pair.b_daemon = Some(pair.b.start());
    // The restarted peer needs its session published again, as a running session would.
    pair.b.ok("binding_publish", json!({ "recipient": recipient("native-a"), "generation": 1, "valid_for_ms": 300_000, "project": "project-1" }));
    wait_until("the deposit after reconnect", || outbox(&pair.a, &id) == "deposited");
    assert_eq!(b_inbox(&pair).len(), 1);
}

/// Connects to A's daemon as B (its key read from B's data directory, with B's own daemon stopped).
fn as_b(pair: &mut Pair) -> Raw {
    stop_b(pair);
    let bytes = std::fs::read(pair.b.dir.join("transport.key")).unwrap();
    let key = iroh::SecretKey::from_bytes(&bytes.try_into().unwrap());
    let addr = pair.a.ok("transport_status", json!({}))["listen"][0].as_str().unwrap().to_string();
    let raw = Raw::connect(key, &pair.a_id, &addr).unwrap();
    assert_eq!(raw.send(raw.hello()).unwrap()["t"], "hello_ok");
    raw
}

fn digest_for(native_id: &str) -> String {
    let r = wire_recipient(native_id);
    recipient_digest(&Locator {
        provider: r["provider"].as_str().unwrap().into(),
        native_id: r["native_id"].as_str().unwrap().into(),
        checkout: r["checkout"].as_str().unwrap().into(),
        session_hint: r["session_hint"].as_str().unwrap().into(),
    })
}

fn receipt(id: &str, digest: &str, state: &str, seq: i64) -> Value {
    json!({ "t": "receipt", "origin_id": id, "recipient_digest": digest, "state": state, "reason": null, "seq": seq })
}

#[test]
fn an_acknowledgement_naming_the_wrong_recipient_is_rejected_and_changes_nothing() {
    let mut pair = ready();
    let id = pair.send(&pair.a, &pair.b_id, "k1", "hello")["message_id"].as_str().unwrap().to_string();
    wait_until("the deposit", || outbox(&pair.a, &id) == "deposited");
    let raw = as_b(&mut pair);
    let before = pair.a.snapshot();
    let reply = raw.send(receipt(&id, &digest_for("native-someone-else"), "acknowledged", 99)).unwrap();
    assert_eq!((reply["t"].as_str(), reply["code"].as_str()), (Some("rejected"), Some("RECEIPT_RECIPIENT_MISMATCH")));
    assert_eq!(pair.a.snapshot(), before);
    assert_eq!(remote_state(&pair.a, &id), "queued");

    // The right recipient is believed, once, and never made older by a replay.
    assert_eq!(raw.send(receipt(&id, &digest_for("native-a"), "acknowledged", 5)).unwrap()["t"], "ok");
    assert_eq!(remote_state(&pair.a, &id), "acknowledged");
    assert_eq!(raw.send(receipt(&id, &digest_for("native-a"), "queued", 3)).unwrap()["t"], "ok");
    assert_eq!(remote_state(&pair.a, &id), "acknowledged");
}

#[test]
fn a_receipt_from_a_machine_the_message_was_not_sent_to_is_not_about_this_message() {
    let mut pair = ready();
    let id = pair.send(&pair.a, &pair.b_id, "k1", "hello")["message_id"].as_str().unwrap().to_string();
    wait_until("the deposit", || outbox(&pair.a, &id) == "deposited");
    stop_b(&mut pair);
    // A third machine on A's roster claims the recipient acknowledged it.
    let third = Raw::new_key();
    pair.a.ok("peer_add", json!({ "peer_id": third.public().to_string(), "label": "third", "addresses": [] }));
    let addr = pair.a.ok("transport_status", json!({}))["listen"][0].as_str().unwrap().to_string();
    let raw = Raw::connect(third, &pair.a_id, &addr).unwrap();
    raw.send(raw.hello());
    let before = pair.a.snapshot();
    let reply = raw.send(receipt(&id, &digest_for("native-a"), "acknowledged", 99)).unwrap();
    assert_eq!(reply["code"], "MESSAGE_NOT_FOUND");
    assert_eq!(pair.a.snapshot(), before);
}

#[test]
fn a_cancel_before_any_attempt_cancels_here_and_nothing_is_ever_sent() {
    let mut pair = ready();
    stop_b(&mut pair);
    let id = pair.send(&pair.a, &pair.b_id, "k1", "oops")["message_id"].as_str().unwrap().to_string();
    let cancelled = pair.a.ok("cancel", json!({ "message_id": id, "sender": { "kind": "user" } }));
    assert_eq!(cancelled["state"], "cancelled");
    assert_eq!(status(&pair.a, &id)["transport"]["attempts"], 0);

    pair.b_daemon = Some(pair.b.start());
    pair.b.ok("binding_publish", json!({ "recipient": recipient("native-a"), "generation": 1, "valid_for_ms": 300_000, "project": "project-1" }));
    std::thread::sleep(std::time::Duration::from_millis(3000));
    assert_eq!(b_inbox(&pair).len(), 0, "a cancelled message must never reach the peer");
    assert_eq!(status(&pair.a, &id)["state"], "cancelled");
}

#[test]
fn a_cancel_after_deposit_is_pending_until_the_peer_confirms_it_got_there_first() {
    let pair = ready();
    let id = pair.send(&pair.a, &pair.b_id, "k1", "oops")["message_id"].as_str().unwrap().to_string();
    wait_until("the deposit", || outbox(&pair.a, &id) == "deposited");
    let asked = pair.a.ok("cancel", json!({ "message_id": id, "sender": { "kind": "user" } }));
    // Not cancelled yet: only the peer can say nothing was handed off.
    assert_eq!(asked["state"], "queued");
    assert_eq!(asked["cancel"], "requested");
    wait_until("the confirmation", || status(&pair.a, &id)["state"] == "cancelled");
    assert_eq!(status(&pair.a, &id)["transport"]["cancel"], "confirmed");
    assert_eq!(pair.b.ok("claim", json!({ "recipient": recipient("native-a") }))["messages"], json!([]));
    assert_eq!(b_inbox(&pair)[0]["state"], "cancelled");
}

#[test]
fn a_cancel_that_loses_the_race_to_a_claim_is_refused_with_the_truth() {
    let pair = ready();
    let id = pair.send(&pair.a, &pair.b_id, "k1", "oops")["message_id"].as_str().unwrap().to_string();
    wait_until("the deposit", || outbox(&pair.a, &id) == "deposited");
    pair.b.ok("claim", json!({ "recipient": recipient("native-a") }));
    pair.a.ok("cancel", json!({ "message_id": id, "sender": { "kind": "user" } }));
    wait_until("the refusal", || status(&pair.a, &id)["transport"]["cancel"] == "refused");
    let seen = status(&pair.a, &id);
    assert_eq!(seen["state"], "handoff-unknown");
    assert_ne!(seen["state"], "cancelled");
}

#[test]
fn a_cancel_that_arrives_before_its_deposit_makes_the_late_deposit_fail() {
    let pair = ready();
    // A raw peer cancels an origin the receiver has never seen, then the deposit for it shows up.
    let key = Raw::new_key();
    let raw_id = key.public().to_string();
    pair.b.ok("peer_add", json!({ "peer_id": raw_id, "label": "raw", "addresses": [] }));
    pair.b.ok("peer_grant", json!({ "peer_id": raw_id, "capability": "receive", "scope": { "kind": "peer" } }));
    let addr = pair.b.ok("transport_status", json!({}))["listen"][0].as_str().unwrap().to_string();
    let raw = Raw::connect(key, &pair.b_id, &addr).unwrap();
    raw.send(raw.hello());
    let cancel = raw.send(json!({ "t": "cancel", "origin_id": "m_early" })).unwrap();
    assert_eq!((cancel["t"].as_str(), cancel["result"].as_str()), (Some("cancel_result"), Some("cancelled")));
    let late = raw
        .send(json!({ "t": "deposit", "origin_id": "m_early", "recipient": wire_recipient("native-a"), "body": "late", "reply_to": null, "run_hint": null, "span_hint": null }))
        .unwrap();
    assert_eq!(late["code"], "CANCELLED");
    assert_eq!(b_inbox(&pair).len(), 0);
}

#[test]
fn a_full_outbox_for_one_conversation_refuses_more_and_stores_nothing() {
    let mut pair = ready();
    stop_b(&mut pair);
    for n in 0..100 {
        pair.send(&pair.a, &pair.b_id, &format!("k{n}"), "queued while away");
    }
    let before = pair.a.snapshot();
    let mut args = send_args("k-over", "one too many", "native-a");
    args["recipient"] = wire_recipient("native-a");
    args["peer_id"] = json!(pair.b_id);
    assert_eq!(pair.a.err("send", args), "RECIPIENT_QUEUE_FULL");
    assert_eq!(pair.a.snapshot(), before);
}

#[test]
fn when_the_receiver_stops_publishing_a_session_the_sender_stops_being_able_to_send_to_it() {
    let pair = ready();
    pair.b.ok("peer_grant_remove", json!({ "peer_id": pair.a_id, "capability": "visible", "scope": { "kind": "peer" } }));
    wait_until("the sender's view to empty", || {
        pair.a.ok("peer_list", json!({}))["peers"][0]["published"].as_array().unwrap().is_empty()
    });
    let mut args = send_args("k1", "hello", "native-a");
    args["recipient"] = wire_recipient("native-a");
    args["peer_id"] = json!(pair.b_id);
    assert_eq!(pair.a.err("send", args), "RECIPIENT_UNBOUND");
}

#[test]
fn when_the_receivers_session_ends_the_sender_stops_being_able_to_send_to_it() {
    let pair = ready();
    pair.b.ok("binding_invalidate", json!({ "session_hint": "session-1", "reason": "ended", "generation": 9 }));
    wait_until("the sender's view to empty", || {
        pair.a.ok("peer_list", json!({}))["peers"][0]["published"].as_array().unwrap().is_empty()
    });
    let mut args = send_args("k1", "hello", "native-a");
    args["recipient"] = wire_recipient("native-a");
    args["peer_id"] = json!(pair.b_id);
    assert_eq!(pair.a.err("send", args), "RECIPIENT_UNBOUND");
}

#[cfg(feature = "test-hooks")]
#[test]
fn an_outbound_message_nobody_could_take_expires_visibly_and_is_never_offered_again() {
    const DAY: i64 = 24 * 60 * 60 * 1000;
    let mut pair = ready();
    stop_b(&mut pair);
    let id = pair.send(&pair.a, &pair.b_id, "k1", "hello")["message_id"].as_str().unwrap().to_string();
    let created = status(&pair.a, &id)["created_at"].as_i64().unwrap();
    // Still pending when its seven days pass: it ends, with the reason shown, instead of waiting forever.
    let later = |op: &str, args: Value| pair.a.call_env(op, args, &[("SETU_LINKS_TEST_NOW_MS", &(created + 7 * DAY + 1).to_string())]);
    assert_eq!(status(&pair.a, &id)["state"], "queued");
    // A read already reports the expiry that has passed, before anything has persisted it.
    assert_eq!(later("status", json!({ "message_id": id }))["result"]["state"], "expired");
    later("sweep", json!({}));
    let seen = later("status", json!({ "message_id": id }));
    assert_eq!(seen["result"]["transport"]["outbox"], "expired");
    assert_eq!(seen["result"]["state"], "expired");
    assert_eq!(seen["result"]["reason"], "expired");
}

#[test]
fn a_receipt_with_an_invalid_state_reason_or_sequence_is_refused_and_changes_nothing() {
    let mut pair = ready();
    let id = pair.send(&pair.a, &pair.b_id, "k1", "hello")["message_id"].as_str().unwrap().to_string();
    wait_until("the deposit", || outbox(&pair.a, &id) == "deposited");
    let raw = as_b(&mut pair);
    let before = pair.a.snapshot();
    let digest = digest_for("native-a");
    let bad = [
        json!({ "t": "receipt", "origin_id": id, "recipient_digest": digest, "state": "nope", "reason": null, "seq": 50 }),
        json!({ "t": "receipt", "origin_id": id, "recipient_digest": digest, "state": "acknowledged", "reason": "r".repeat(129), "seq": 50 }),
        json!({ "t": "receipt", "origin_id": id, "recipient_digest": digest, "state": "acknowledged", "reason": "a\u{7}b", "seq": 50 }),
        json!({ "t": "receipt", "origin_id": id, "recipient_digest": digest, "state": "acknowledged", "reason": null, "seq": -1 }),
        json!({ "t": "receipt", "origin_id": id, "recipient_digest": digest, "state": "acknowledged", "reason": null, "seq": i64::MAX }),
    ];
    for frame in bad {
        let reply = raw.send(frame.clone()).unwrap();
        assert_eq!((reply["t"].as_str(), reply["code"].as_str()), (Some("rejected"), Some("REQUEST_INVALID")), "{frame}");
    }
    assert_eq!(pair.a.snapshot(), before);
}
