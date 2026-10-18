//! Two engines, two data directories, two real daemons: a message goes one engine's outbox to the other's inbox
//! and the recipient's own state comes back. Same-machine processes are contract evidence only; they say
//! nothing about real networks.
mod common;
use common::*;
use serde_json::{Value, json};

fn status(engine: &Engine, id: &str) -> Value {
    engine.ok("status", json!({ "message_id": id }))
}

fn inbox(engine: &Engine) -> Vec<Value> {
    engine.ok("list", json!({ "session_hint": "session-1" }))["messages"].as_array().unwrap().clone()
}

#[test]
fn a_message_reaches_the_remote_inbox_and_the_sender_sees_it_deposited() {
    let pair = Pair::new();
    pair.authorize(&pair.a, &pair.a_id, &pair.b, &pair.b_id, "project-1");
    pair.wait_published(&pair.a, &pair.b_id);

    let sent = pair.send(&pair.a, &pair.b_id, "k1", "hello from a");
    assert_eq!(sent["state"], "queued");
    let id = sent["message_id"].as_str().unwrap();
    // Durably accepted in A's outbox: that is not the same as deposited at B.
    assert_eq!(status(&pair.a, id)["transport"]["outbox"].as_str().is_some(), true);

    wait_until("the deposit", || status(&pair.a, id)["transport"]["outbox"] == "deposited");
    let seen = status(&pair.a, id);
    assert_eq!(seen["transport"]["remote_state"], "queued");
    assert_eq!(seen["state"], "queued");

    let received = inbox(&pair.b);
    assert_eq!(received.len(), 1);
    assert_eq!(received[0]["state"], "queued");
    let shown = pair.b.ok("show", json!({ "message_id": received[0]["message_id"] }));
    assert_eq!(shown["body"], "hello from a");
    assert_eq!(shown["sender"]["kind"], "peer");
    assert_eq!(shown["sender"]["peer_id"], pair.a_id);
}

fn claim_args() -> Value {
    json!({ "recipient": recipient("native-a") })
}

fn remote_state(engine: &Engine, id: &str) -> Value {
    status(engine, id)["transport"]["remote_state"].clone()
}

#[test]
fn the_recipients_own_state_changes_come_back_to_the_sender_as_receipts() {
    let pair = Pair::new();
    pair.authorize(&pair.a, &pair.a_id, &pair.b, &pair.b_id, "project-1");
    pair.wait_published(&pair.a, &pair.b_id);
    let id = pair.send(&pair.a, &pair.b_id, "k1", "please review")["message_id"].as_str().unwrap().to_string();
    wait_until("the deposit", || remote_state(&pair.a, &id) == "queued");

    // The recipient's engine alone decides what happens to it; the sender is told, never in charge.
    let claimed = pair.b.ok("claim", claim_args());
    let attempt = claimed["attempt_id"].as_str().unwrap().to_string();
    wait_until("handoff-unknown to reach the sender", || remote_state(&pair.a, &id) == "handoff-unknown");
    assert_eq!(status(&pair.a, &id)["state"], "handoff-unknown");

    pair.b.ok("confirm", json!({ "attempt_id": attempt, "recipient": recipient("native-a") }));
    wait_until("handed-off to reach the sender", || remote_state(&pair.a, &id) == "handed-off");

    let remote_id = inbox(&pair.b)[0]["message_id"].clone();
    pair.b.ok("acknowledge", json!({ "message_id": remote_id, "recipient": recipient("native-a") }));
    wait_until("acknowledged to reach the sender", || remote_state(&pair.a, &id) == "acknowledged");
    let last = status(&pair.a, &id);
    assert_eq!(last["state"], "acknowledged");
    assert_eq!(last["transport"]["outbox"], "deposited");
}

#[test]
fn messages_go_in_each_direction() {
    let pair = Pair::new();
    pair.authorize(&pair.a, &pair.a_id, &pair.b, &pair.b_id, "project-1");
    pair.authorize(&pair.b, &pair.b_id, &pair.a, &pair.a_id, "project-2");
    pair.wait_published(&pair.a, &pair.b_id);
    pair.wait_published(&pair.b, &pair.a_id);

    let to_b = pair.send(&pair.a, &pair.b_id, "k-ab", "a to b")["message_id"].as_str().unwrap().to_string();
    let to_a = pair.send(&pair.b, &pair.a_id, "k-ba", "b to a")["message_id"].as_str().unwrap().to_string();
    wait_until("both deposits", || remote_state(&pair.a, &to_b) == "queued" && remote_state(&pair.b, &to_a) == "queued");
    assert_eq!(inbox(&pair.b).len(), 1);
    assert_eq!(inbox(&pair.a).len(), 1);
    assert_eq!(pair.a.ok("show", json!({ "message_id": inbox(&pair.a)[0]["message_id"] }))["body"], "b to a");
}

fn connected_to(engine: &Engine, peer: &str) -> bool {
    engine.ok("transport_status", json!({}))["links"].as_array().is_some_and(|l| l.iter().any(|l| l["peer_id"] == peer && l["state"] == "connected"))
}

/// Whichever side has the larger key is the one a "keep the older connection" rule would wrongly turn away
/// after a restart, so killing each side in turn covers it whatever keys the run happened to draw.
#[test]
fn a_restarted_peer_replaces_the_connection_its_dead_predecessor_left_behind() {
    for restarted_is_a in [true, false] {
        let mut pair = Pair::new();
        pair.authorize(&pair.a, &pair.a_id, &pair.b, &pair.b_id, "project-1");
        pair.wait_published(&pair.a, &pair.b_id);
        wait_until("the link", || connected_to(&pair.a, &pair.b_id) && connected_to(&pair.b, &pair.a_id));

        let (engine, daemon) = if restarted_is_a { (&pair.a, &mut pair.a_daemon) } else { (&pair.b, &mut pair.b_daemon) };
        daemon.take().unwrap().kill();
        *daemon = Some(engine.start());
        let restarted_at = std::time::Instant::now();
        wait_until("the restarted peer to be linked again", || connected_to(&pair.a, &pair.b_id) && connected_to(&pair.b, &pair.a_id));
        // Waiting out the transport's idle timeout (many seconds) would also "work"; a prompt replacement is the point.
        assert!(restarted_at.elapsed() < std::time::Duration::from_secs(6), "the dead connection held the restarted peer out for {:?}", restarted_at.elapsed());

        let id = pair.send(&pair.a, &pair.b_id, &format!("k-{restarted_is_a}"), "after the restart")["message_id"].as_str().unwrap().to_string();
        wait_until("a deposit over the new link", || status(&pair.a, &id)["transport"]["outbox"] == "deposited");
    }
}

/// Both machines go down and come back on the addresses their rosters hold: they find each other again, the
/// receiver's sessions are published again, and mail sent afterwards is deposited. (On ephemeral ports the
/// addresses would change and both rosters would go stale; a deployment pins a port.)
#[test]
fn both_daemons_restarting_on_their_known_addresses_reconnect_republish_and_deliver() {
    let mut pair = Pair::new();
    pair.authorize(&pair.a, &pair.a_id, &pair.b, &pair.b_id, "project-1");
    pair.wait_published(&pair.a, &pair.b_id);
    let first = pair.send(&pair.a, &pair.b_id, "k-before", "before")["message_id"].as_str().unwrap().to_string();
    wait_until("the first deposit", || status(&pair.a, &first)["transport"]["outbox"] == "deposited");

    let address = |engine: &Engine| engine.ok("transport_status", json!({}))["listen"][0].as_str().unwrap().to_string();
    let (a_addr, b_addr) = (address(&pair.a), address(&pair.b));
    pair.a_daemon.take().unwrap().kill();
    pair.b_daemon.take().unwrap().kill();
    wait_until("both to stop", || pair.a.ok("transport_status", json!({}))["running"] == false && pair.b.ok("transport_status", json!({}))["running"] == false);

    // The sender's cache of what the receiver published would carry a send through on its own for two minutes; the
    // test must see a fresh publish after the restart, so the cache is emptied while both are down.
    rusqlite::Connection::open(pair.a.dir.join("mailbox.sqlite3")).unwrap().execute("DELETE FROM remote_bindings", []).unwrap();
    pair.a_daemon = Some(pair.a.serve_with(&[], Some(&a_addr)));
    pair.b_daemon = Some(pair.b.serve_with(&[], Some(&b_addr)));
    pair.a.wait_running();
    pair.b.wait_running();
    wait_until("the two to find each other", || connected_to(&pair.a, &pair.b_id) && connected_to(&pair.b, &pair.a_id));
    // Only a publish that arrives after the restart can refill the emptied cache; then a new message goes through.
    pair.wait_published(&pair.a, &pair.b_id);
    let second = pair.send(&pair.a, &pair.b_id, "k-after", "after both restarts")["message_id"].as_str().unwrap().to_string();
    wait_until("the second deposit", || status(&pair.a, &second)["transport"]["outbox"] == "deposited");
    assert_eq!(inbox(&pair.b).len(), 2);
    // The first message is still the one message it was.
    assert_eq!(status(&pair.a, &first)["transport"]["remote_state"], "queued");
}

#[test]
fn a_cancel_by_the_recipient_is_reported_as_the_recipients_state_not_as_the_senders_cancel() {
    let pair = Pair::new();
    pair.authorize(&pair.a, &pair.a_id, &pair.b, &pair.b_id, "project-1");
    pair.wait_published(&pair.a, &pair.b_id);
    let id = pair.send(&pair.a, &pair.b_id, "k1", "please")["message_id"].as_str().unwrap().to_string();
    wait_until("the deposit", || status(&pair.a, &id)["transport"]["remote_state"] == "queued");

    // The receiving user cancels the message in their own inbox. That is the recipient's state to report.
    let remote_id = inbox(&pair.b)[0]["message_id"].clone();
    pair.b.ok("cancel", json!({ "message_id": remote_id, "sender": { "kind": "user" } }));
    wait_until("the recipient's cancellation to reach the sender", || remote_state(&pair.a, &id) == "cancelled");
    let seen = status(&pair.a, &id);
    assert_eq!(seen["state"], "cancelled");
    // The sender never asked for it, so nothing invents a sender-side confirmation.
    assert_eq!(seen["transport"]["cancel"], "none");
    assert_eq!(seen["transport"]["outbox"], "deposited");
}
