//! Kills a real daemon at each protocol step, restarts it, and checks the two engines converge on one message in
//! the recipient's inbox and the same state at both ends. Needs `--features test-hooks`.
#![cfg(feature = "test-hooks")]
mod common;
use common::*;
use serde_json::{Value, json};

const TICK: (&str, &str) = ("SETU_LINKS_TEST_TICK_MS", "100");

fn status(engine: &Engine, id: &str) -> Value {
    engine.ok("status", json!({ "message_id": id }))
}

fn b_inbox(pair: &Pair) -> Vec<Value> {
    pair.b.ok("list", json!({ "session_hint": "session-1" }))["messages"].as_array().unwrap().clone()
}

/// A pair where one daemon dies at `point`. `a_dies` says which side carries the kill point.
fn pair_killed_at(point: &str, a_dies: bool) -> Pair {
    let kill = ("SETU_LINKS_TEST_KILL_AT", point);
    let pair = if a_dies { Pair::build(&[TICK, kill], &[TICK]) } else { Pair::build(&[TICK], &[TICK, kill]) };
    pair.authorize(&pair.a, &pair.a_id, &pair.b, &pair.b_id, "project-1");
    pair.wait_published(&pair.a, &pair.b_id);
    pair
}

/// Waits for the side carrying the kill point to die, then brings it back without the kill point.
fn restart_after_the_kill(pair: &mut Pair, a_dies: bool) {
    let (engine, daemon) = if a_dies { (&pair.a, &mut pair.a_daemon) } else { (&pair.b, &mut pair.b_daemon) };
    let child = &mut daemon.as_mut().unwrap().child;
    wait_until("the daemon to be killed at the kill point", || child.try_wait().unwrap().is_some());
    let restarted = engine.serve(&[TICK]);
    engine.wait_running();
    *daemon = Some(restarted);
}

fn converges_on_one_deposited_message(pair: &Pair, id: &str) {
    wait_until("the deposit to settle", || {
        let seen = status(&pair.a, id);
        seen["transport"]["outbox"] == "deposited" && seen["transport"]["remote_state"] == "queued"
    });
    // Time and reconnects must not make a second copy.
    std::thread::sleep(std::time::Duration::from_millis(1500));
    assert_eq!(b_inbox(pair).len(), 1, "exactly one message in the recipient's inbox");
    assert_eq!(b_inbox(pair)[0]["state"], "queued");
    assert_eq!(status(&pair.a, id)["state"], "queued");
}

fn deposit_killed_at(point: &str, a_dies: bool) {
    let mut pair = pair_killed_at(point, a_dies);
    let id = pair.send(&pair.a, &pair.b_id, "k1", "hello")["message_id"].as_str().unwrap().to_string();
    restart_after_the_kill(&mut pair, a_dies);
    converges_on_one_deposited_message(&pair, &id);
}

#[test]
fn the_sender_killed_before_recording_an_attempt() {
    deposit_killed_at("attempt:before-commit", true);
}

#[test]
fn the_sender_killed_after_recording_an_attempt_and_before_sending() {
    deposit_killed_at("attempt:after-commit", true);
}

#[test]
fn the_sender_killed_just_before_the_frame_leaves() {
    deposit_killed_at("deposit:before-send", true);
}

#[test]
fn the_sender_killed_after_the_frame_left_and_before_the_answer_is_read() {
    deposit_killed_at("deposit:after-send", true);
}

#[test]
fn the_sender_killed_before_applying_the_answer() {
    deposit_killed_at("ack:before-commit", true);
}

#[test]
fn the_sender_killed_after_applying_the_answer() {
    deposit_killed_at("ack:after-commit", true);
}

#[test]
fn the_receiver_killed_before_committing_the_deposit() {
    deposit_killed_at("deposit:before-commit", false);
}

#[test]
fn the_receiver_killed_after_committing_and_before_answering_so_the_answer_is_lost() {
    deposit_killed_at("deposit:after-commit", false);
}

/// A delivered message whose recipient then claims it, so a receipt is owed back to the sender.
fn receipt_killed_at(point: &str, a_dies: bool) {
    let mut pair = pair_killed_at(point, a_dies);
    let id = pair.send(&pair.a, &pair.b_id, "k1", "hello")["message_id"].as_str().unwrap().to_string();
    wait_until("the deposit", || status(&pair.a, &id)["transport"]["outbox"] == "deposited");
    pair.b.ok("claim", json!({ "recipient": recipient("native-a") }));
    restart_after_the_kill(&mut pair, a_dies);
    wait_until("the receipt", || status(&pair.a, &id)["transport"]["remote_state"] == "handoff-unknown");
    assert_eq!(status(&pair.a, &id)["state"], "handoff-unknown");
    std::thread::sleep(std::time::Duration::from_millis(1000));
    assert_eq!(b_inbox(&pair).len(), 1);
    assert_eq!(b_inbox(&pair)[0]["state"], "handoff-unknown");
}

#[test]
fn the_receiver_killed_after_sending_a_receipt_before_recording_that_it_did() {
    receipt_killed_at("receipt:after-send", false);
}

#[test]
fn the_receiver_killed_before_recording_a_receipt_as_reported() {
    receipt_killed_at("reported:before-commit", false);
}

#[test]
fn the_receiver_killed_after_recording_a_receipt_as_reported() {
    receipt_killed_at("reported:after-commit", false);
}

#[test]
fn the_sender_killed_before_applying_a_receipt() {
    receipt_killed_at("receipt:before-commit", true);
}

#[test]
fn the_sender_killed_after_applying_a_receipt() {
    receipt_killed_at("receipt:after-commit", true);
}

/// A delivered message the sender then cancels; every outcome must end with the message cancelled at both ends.
fn cancel_killed_at(point: &str, a_dies: bool) {
    let mut pair = pair_killed_at(point, a_dies);
    let id = pair.send(&pair.a, &pair.b_id, "k1", "oops")["message_id"].as_str().unwrap().to_string();
    wait_until("the deposit", || status(&pair.a, &id)["transport"]["outbox"] == "deposited");
    pair.a.ok("cancel", json!({ "message_id": id, "sender": { "kind": "user" } }));
    restart_after_the_kill(&mut pair, a_dies);
    wait_until("the cancel to be confirmed", || status(&pair.a, &id)["state"] == "cancelled");
    assert_eq!(status(&pair.a, &id)["transport"]["cancel"], "confirmed");
    std::thread::sleep(std::time::Duration::from_millis(1000));
    assert_eq!(b_inbox(&pair)[0]["state"], "cancelled");
    assert_eq!(pair.b.ok("claim", json!({ "recipient": recipient("native-a") }))["messages"], json!([]));
}

#[test]
fn the_receiver_killed_before_committing_a_cancel() {
    cancel_killed_at("cancel:before-commit", false);
}

#[test]
fn the_receiver_killed_after_committing_a_cancel_so_its_answer_is_lost() {
    cancel_killed_at("cancel:after-commit", false);
}

#[test]
fn the_sender_killed_after_sending_a_cancel() {
    cancel_killed_at("cancel:after-send", true);
}

#[test]
fn the_sender_killed_before_applying_the_cancel_answer() {
    cancel_killed_at("cancel_apply:before-commit", true);
}

#[test]
fn the_sender_killed_after_applying_the_cancel_answer() {
    cancel_killed_at("cancel_apply:after-commit", true);
}
