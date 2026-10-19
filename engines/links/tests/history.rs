mod common;
use common::*;
use rusqlite::Connection;
use serde_json::{Value, json};

#[test]
fn events_are_immutable_passive_and_cursor_past_filtered_rows() {
    let engine = Engine::new();
    let sent = engine.ok("send", send_args("history", "hello", "native-a"));
    let id = sent["message_id"].as_str().unwrap();
    let first = engine.ok("events", json!({ "limit": 1 }));
    assert_eq!(first["events"][0]["message_id"], id);
    assert_eq!(first["events"][0]["first"], true);
    assert_eq!(first["events"][0]["backfill"], false);
    assert_eq!(first["events"][0]["message"]["origin"], "local");
    assert_eq!(first["events"][0]["message"]["recipient"]["native_id"], serde_json::Value::Null);
    let empty = engine.ok("events", json!({ "after": 0, "origin": "peer:0000000000000000000000000000000000000000000000000000000000000000" }));
    assert_eq!(empty["events"], json!([]));
    assert_eq!(empty["next"], empty["head"]);
    assert_eq!(engine.err("events", json!({ "run_hint": "r" })), "REQUEST_INVALID");
}

#[test]
fn lifecycle_writes_one_final_event_per_message_transaction_and_never_for_a_replay() {
    let engine = Engine::new();
    let sent = engine.ok("send", send_args("history-life", "hello", "native-a"));
    let id = sent["message_id"].as_str().unwrap();
    assert_eq!(engine.ok("events", json!({})) ["events"].as_array().unwrap().len(), 1);
    assert_eq!(engine.ok("send", send_args("history-life", "hello", "native-a"))["replayed"], true);
    assert_eq!(engine.ok("events", json!({})) ["events"].as_array().unwrap().len(), 1);

    let claim = engine.ok("claim", json!({ "recipient": recipient("native-a") }));
    let attempt = claim["attempt_id"].clone();
    engine.ok("confirm", json!({ "attempt_id": attempt, "recipient": recipient("native-a") }));
    engine.ok("acknowledge", json!({ "message_id": id, "recipient": recipient("native-a") }));
    let events = engine.ok("events", json!({}));
    let states: Vec<_> = events["events"].as_array().unwrap().iter().map(|event| event["state"].as_str().unwrap()).collect();
    assert_eq!(states, ["queued", "handoff-unknown", "handed-off", "acknowledged"]);

    let db_path = engine.dir.join("mailbox.sqlite3");
    let mut db = Connection::open(&db_path).unwrap();
    let before: i64 = db.query_row("SELECT COUNT(*) FROM message_events", [], |row| row.get(0)).unwrap();
    db.execute("UPDATE deliveries SET state = state WHERE message_id = ?1", [id]).unwrap();
    assert_eq!(db.query_row("SELECT COUNT(*) FROM message_events", [], |row| row.get::<_, i64>(0)).unwrap(), before);
    let tx = db.transaction().unwrap();
    tx.execute("UPDATE deliveries SET state = 'queued', reason = NULL, updated_at = updated_at + 1 WHERE message_id = ?1", [id]).unwrap();
    tx.execute("UPDATE deliveries SET state = 'held', reason = 'temporary', updated_at = updated_at + 2 WHERE message_id = ?1", [id]).unwrap();
    setu_links::history::flush(&tx).unwrap();
    tx.commit().unwrap();
    assert_eq!(db.query_row("SELECT COUNT(*) FROM message_events", [], |row| row.get::<_, i64>(0)).unwrap(), before + 1);
    assert_eq!(engine.ok("events", json!({})) ["events"].as_array().unwrap().last().unwrap()["state"], "held");
    assert!(db.execute("UPDATE message_events SET state = 'queued' WHERE message_id = ?1", [id]).is_err());
}

#[test]
fn reconcile_cycles_append_after_returning_to_a_prior_state() {
    let engine = Engine::new();
    let id = engine.ok("send", send_args("history-cycle", "hello", "native-a"))["message_id"].clone();
    for _ in 0..2 {
        engine.ok("reconcile", json!({ "recipient": recipient("native-b") }));
        engine.ok("reconcile", json!({ "recipient": recipient("native-a") }));
    }
    let events = engine.ok("events", json!({}));
    let states: Vec<_> = events["events"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|event| event["message_id"] == id)
        .map(|event| event["state"].as_str().unwrap())
        .collect();
    assert_eq!(states, ["queued", "held", "queued", "held", "queued"]);
}

#[test]
fn binding_heartbeat_does_not_append_after_a_finalized_reconcile() {
    let pair = Pair::new();
    pair.authorize(&pair.a, &pair.a_id, &pair.b, &pair.b_id, "project-1");
    pair.wait_published(&pair.a, &pair.b_id);
    pair.send(&pair.a, &pair.b_id, "history-heartbeat", "waiting");
    wait_until("the peer message to arrive", || pair.b.ok("list", json!({ "session_hint": "session-1" }))["messages"].as_array().is_some_and(|messages| !messages.is_empty()));
    let id = pair.b.ok("list", json!({ "session_hint": "session-1" }))["messages"][0]["message_id"].clone();

    pair.b.ok("binding_publish", json!({ "recipient": recipient("native-b"), "generation": 2, "valid_for_ms": 300_000, "project": "project-1" }));
    pair.b.ok("peer_grant_remove", json!({ "peer_id": pair.a_id, "capability": "receive", "scope": { "kind": "peer" } }));
    // This production publish briefly releases the message, then authz::gate_all holds it again.
    pair.b.ok("binding_publish", json!({ "recipient": recipient("native-a"), "generation": 3, "valid_for_ms": 300_000, "project": "project-1" }));
    let shown = pair.b.ok("show", json!({ "message_id": id }));
    assert_eq!((shown["state"].as_str(), shown["reason"].as_str()), (Some("held"), Some("authorization-lapsed")));
    let before = pair.b.ok("events", json!({}))["events"].as_array().unwrap().len();
    pair.b.ok("binding_publish", json!({ "recipient": recipient("native-a"), "generation": 3, "valid_for_ms": 300_000, "project": "project-1" }));
    assert_eq!(pair.b.ok("events", json!({}))["events"].as_array().unwrap().len(), before);
}

#[test]
fn event_filters_and_extended_list_are_canonical_paged_and_bodyless() {
    let engine = Engine::new();
    for (key, run) in [("history-other", "other"), ("history-wanted-1", "wanted"), ("history-wanted-2", "wanted")] {
        let mut args = send_args(key, "private body", "native-a");
        args["run_hint"] = json!(run);
        engine.ok("send", args);
    }
    let page = engine.ok("events", json!({ "origin": "local", "run_hint": "wanted", "limit": 1 }));
    assert_eq!(page["head"], 3);
    assert_eq!(page["events"][0]["message"]["run_hint"], "wanted");
    assert_eq!(page["has_more"], true);
    let tail = engine.ok("events", json!({ "after": page["next"], "origin": "local", "run_hint": "wanted", "limit": 1 }));
    assert_eq!(tail["events"].as_array().unwrap().len(), 1);
    assert_eq!(tail["next"], tail["head"]);

    let listed = engine.ok("list", json!({ "origin": "local", "run_hint": "wanted", "limit": 1 }));
    assert_eq!(listed["messages"].as_array().unwrap().len(), 1);
    assert_eq!(listed["messages"][0]["origin"], "local");
    assert!(listed["messages"][0].get("body").is_none());
    assert_eq!(listed["has_more"], true);
    assert_eq!(engine.err("events", json!({ "origin": "peer:not-a-key" })), "REQUEST_INVALID");
    assert_eq!(engine.err("list", json!({ "origin": "local" })), "REQUEST_INVALID");
    assert_eq!(engine.ok("show", json!({ "message_id": listed["messages"][0]["message_id"] })) ["origin"], "local");
}

#[test]
fn extended_list_filters_projected_states_with_a_bounded_cursor() {
    let engine = Engine::new();
    let ids = (0..6)
        .map(|n| engine.ok("send", send_args(&format!("visible-state-{n}"), "private body", "native-a"))["message_id"].as_str().unwrap().to_string())
        .collect::<Vec<_>>();
    let db_path = engine.dir.join("mailbox.sqlite3");
    let db = Connection::open(&db_path).unwrap();
    for id in &ids[..2] {
        db.execute("UPDATE deliveries SET expires_at = 0 WHERE message_id = ?1", [id]).unwrap();
    }
    for id in &ids[4..] {
        db.execute("DELETE FROM deliveries WHERE message_id = ?1", [id]).unwrap();
        db.execute(
            "INSERT INTO outbox (message_id, peer_id, outbox_state, expires_at, remote_state, cancel_state, updated_at)
             VALUES (?1, 'peer', 'deposited', 9999999999999, 'handed-off', 'none', 0)",
            [id],
        )
        .unwrap();
    }

    let pages = |states: &[&str], observed: Option<Value>| {
        let mut after = None;
        let mut found = Vec::new();
        loop {
            let mut args = json!({ "session_hint": "session-1", "states": states, "limit": 1 });
            if let Some(after) = &after { args["after_id"] = json!(after); }
            if let Some(observed) = &observed { args["observed"] = observed.clone(); }
            let page = engine.ok("list", args);
            found.extend(page["messages"].as_array().unwrap().iter().map(|message| message["message_id"].as_str().unwrap().to_string()));
            if page["has_more"] == false { return found; }
            let next = page["next_after"].as_str().unwrap().to_string();
            assert_ne!(Some(next.clone()), after);
            after = Some(next);
        }
    };
    let mut expired = pages(&["expired"], None);
    expired.sort();
    let mut expected_expired = ids[..2].to_vec();
    expected_expired.sort();
    assert_eq!(expired, expected_expired);

    let mut held = pages(&["held"], Some(recipient("native-b")));
    held.sort();
    let mut expected_held = ids[2..4].to_vec();
    expected_held.sort();
    assert_eq!(held, expected_held);

    let mut remote = pages(&["handed-off"], None);
    remote.sort();
    let mut expected_remote = ids[4..].to_vec();
    expected_remote.sort();
    assert_eq!(remote, expected_remote);
}

#[test]
fn events_reject_bad_filters_without_creating_or_migrating_a_store() {
    let engine = Engine::new();
    assert_eq!(engine.err("events", json!({ "origin": "peer:UPPER" })), "REQUEST_INVALID");
    assert!(!engine.dir.exists());
}
