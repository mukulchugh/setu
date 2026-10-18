//! Nothing private about a local conversation (its provider id, its checkout, any path) crosses the wire or lands
//! in a peer's database, while exact matching, replacement holds, exact return, resume, receipts and redelivery
//! all keep working. Uses a synthetic identity shaped like the real one, paths included.
mod common;
use common::*;
use serde_json::{Value, json};

const PROJECT: &str = "acme-secret-project";
const NATIVE: &str = "3f2b8c1e-9a4d-4e57-b6a1-0c2d5e7f9a13";
const CHECKOUT: &str = r#"{"admin":{"birthtimeNs":"1792300000000000000","dev":16777230,"ino":8123456},"adminPath":"/Users/example/private/acme-secret-project.git/worktrees/feat-x","checkout":{"birthtimeNs":"1792300000000001234","dev":16777230,"ino":9123456},"checkoutPath":"/Users/example/private/acme-secret-project/feat-x","known":true,"repository":{"dev":16777230,"ino":7123456},"repositoryPath":"/Users/example/private/acme-secret-project.git"}"#;
const FORBIDDEN: [&str; 8] = ["/Users/example", "acme-secret-project", NATIVE, "checkoutPath", "adminPath", "repositoryPath", "birthtimeNs", "private"];

fn real(native: &str, checkout: &str, hint: &str) -> Value {
    json!({ "provider": "claude-code", "native_id": native, "checkout": checkout, "session_hint": hint })
}

fn the_real_one() -> Value {
    real(NATIVE, CHECKOUT, "session-1")
}

fn publish(engine: &Engine, recipient: Value, generation: u64) {
    engine.ok("binding_publish", json!({ "recipient": recipient, "generation": generation, "valid_for_ms": 300_000, "project": PROJECT }));
}

/// B runs the real-shaped conversation in a shared project and lets A see and message it.
fn real_pair() -> Pair {
    let pair = Pair::new();
    pair.b.ok("share_enable", json!({ "project": PROJECT, "owner": "casey" }));
    publish(&pair.b, the_real_one(), 1);
    let peer = json!({ "kind": "peer" });
    pair.b.ok("peer_grant", json!({ "peer_id": pair.a_id, "capability": "receive", "scope": peer }));
    pair.b.ok("peer_grant", json!({ "peer_id": pair.a_id, "capability": "visible", "scope": peer }));
    pair.a.ok("peer_grant", json!({ "peer_id": pair.b_id, "capability": "send", "scope": peer }));
    pair.wait_published(&pair.a, &pair.b_id);
    pair
}

fn status(engine: &Engine, id: &str) -> Value {
    engine.ok("status", json!({ "message_id": id }))
}

fn leaks(haystack: &[u8]) -> Vec<&'static str> {
    let text = String::from_utf8_lossy(haystack);
    FORBIDDEN.iter().copied().filter(|needle| text.contains(needle)).collect()
}

fn database_bytes(engine: &Engine) -> Vec<u8> {
    let mut all = std::fs::read(engine.dir.join("mailbox.sqlite3")).unwrap();
    all.extend(std::fs::read(engine.dir.join("mailbox.sqlite3-wal")).unwrap_or_default());
    all
}

fn b_message(pair: &Pair) -> Value {
    pair.b.ok("list", json!({ "session_hint": "session-1" }))["messages"][0].clone()
}

#[test]
fn nothing_private_reaches_the_peers_wire_database_or_views() {
    let pair = real_pair();
    // A third machine that B shows its sessions to, recording every byte B sends it.
    let watcher = Raw::new_key();
    let watcher_id = watcher.public().to_string();
    pair.b.ok("peer_add", json!({ "peer_id": watcher_id, "label": "watcher", "addresses": [] }));
    pair.b.ok("peer_grant", json!({ "peer_id": watcher_id, "capability": "visible", "scope": { "kind": "peer" } }));
    let addr = pair.b.ok("transport_status", json!({}))["listen"][0].as_str().unwrap().to_string();
    let raw = Raw::connect(watcher, &pair.b_id, &addr).unwrap();
    let seen = raw.capture_incoming();
    wait_until("B to publish to the watcher", || String::from_utf8_lossy(&seen.lock().unwrap()).contains("\"published\""));

    let id = pair.send(&pair.a, &pair.b_id, "k1", "hello")["message_id"].as_str().unwrap().to_string();
    wait_until("the deposit", || status(&pair.a, &id)["transport"]["outbox"] == "deposited");

    let wire = seen.lock().unwrap().clone();
    assert!(String::from_utf8_lossy(&wire).contains("w1:"), "the watcher saw no address at all");
    assert_eq!(leaks(&wire), Vec::<&str>::new(), "private data crossed the wire");
    // The sender's views, and its raw database file with its write-ahead log.
    for view in [status(&pair.a, &id), pair.a.ok("show", json!({ "message_id": id })), pair.a.ok("peer_list", json!({}))] {
        assert_eq!(leaks(view.to_string().as_bytes()), Vec::<&str>::new(), "a view shows private data: {view}");
    }
    assert_eq!(leaks(&database_bytes(&pair.a)), Vec::<&str>::new(), "the sender's database holds private data");
    // The owner's own machine keeps what is theirs.
    assert!(!leaks(&database_bytes(&pair.b)).is_empty(), "the test is not looking at real-shaped data");
}

#[test]
fn a_real_shaped_conversation_receives_hands_off_acknowledges_and_reports_back() {
    let pair = real_pair();
    let id = pair.send(&pair.a, &pair.b_id, "k1", "please review")["message_id"].as_str().unwrap().to_string();
    wait_until("the deposit", || status(&pair.a, &id)["transport"]["remote_state"] == "queued");

    // The conversation claims with its own trusted tuple; the stored address is the wire form.
    let claimed = pair.b.ok("claim", json!({ "recipient": the_real_one() }));
    assert_eq!(claimed["messages"].as_array().unwrap().len(), 1);
    let attempt = claimed["attempt_id"].as_str().unwrap();
    pair.b.ok("confirm", json!({ "attempt_id": attempt, "recipient": the_real_one() }));
    pair.b.ok("acknowledge", json!({ "message_id": b_message(&pair)["message_id"], "recipient": the_real_one() }));
    wait_until("the acknowledgement to reach the sender", || status(&pair.a, &id)["transport"]["remote_state"] == "acknowledged");
}

#[test]
fn a_different_checkout_or_conversation_never_matches_the_address() {
    let pair = real_pair();
    pair.send(&pair.a, &pair.b_id, "k1", "hello");
    wait_until("the deposit", || pair.b.ok("list", json!({ "session_hint": "session-1" }))["messages"].as_array().unwrap().len() == 1);
    for wrong in [real(NATIVE, "{\"checkoutPath\":\"/Users/example/private/other\"}", "session-1"), real("another-conversation", CHECKOUT, "session-1")] {
        assert_eq!(pair.b.ok("claim", json!({ "recipient": wrong }))["messages"], json!([]));
    }
    assert_eq!(pair.b.ok("claim", json!({ "recipient": the_real_one() }))["messages"].as_array().unwrap().len(), 1);
}

#[test]
fn mail_follows_replacement_exact_return_and_resume_whether_it_arrived_before_or_after() {
    let pair = real_pair();
    let first = pair.send(&pair.a, &pair.b_id, "k1", "arrived while current")["message_id"].as_str().unwrap().to_string();
    wait_until("the first deposit", || status(&pair.a, &first)["transport"]["remote_state"] == "queued");

    // A third machine that still believes the real conversation is current (its view is a moment old).
    let late = Raw::new_key();
    pair.b.ok("peer_add", json!({ "peer_id": late.public().to_string(), "label": "late", "addresses": [] }));
    pair.b.ok("peer_grant", json!({ "peer_id": late.public().to_string(), "capability": "receive", "scope": { "kind": "peer" } }));
    let addr = pair.b.ok("transport_status", json!({}))["listen"][0].as_str().unwrap().to_string();
    let raw = Raw::connect(late, &pair.b_id, &addr).unwrap();
    raw.send(raw.hello());

    // The session moves to another conversation: what was waiting for the real one is held.
    publish(&pair.b, real("other-native", "{\"other\":true}", "session-1"), 2);
    assert_eq!(b_message(&pair)["state"], "held");
    // Mail arriving now, still addressed to the replaced conversation, is held too.
    let arrived = raw.send(json!({ "t": "deposit", "origin_id": "late-1", "recipient": wire_form(&the_real_one()), "body": "arrived while replaced", "reply_to": null, "run_hint": null, "span_hint": null })).unwrap();
    assert_eq!((arrived["state"].as_str(), arrived["reason"].as_str()), (Some("held"), Some("conversation-replaced")));
    assert_eq!(pair.b.ok("claim", json!({ "recipient": real("other-native", "{\"other\":true}", "session-1") }))["messages"], json!([]));
    assert_eq!(pair.b.ok("claim", json!({ "recipient": the_real_one() }))["messages"], json!([]), "the replaced conversation claimed while another was current");

    // The exact conversation returns: both are queued again and delivered to it, and only to it.
    publish(&pair.b, the_real_one(), 3);
    let listed = pair.b.ok("list", json!({ "session_hint": "session-1" }))["messages"].as_array().unwrap().clone();
    assert!(listed.iter().all(|m| m["state"] == "queued"), "{listed:?}");
    assert_eq!(listed.len(), 2);
    let claimed = pair.b.ok("claim", json!({ "recipient": the_real_one() }));
    assert_eq!(claimed["messages"].as_array().unwrap().len(), 2);
}

#[test]
fn an_exact_return_under_a_new_record_resumes_waiting_mail_including_mail_that_arrived_while_replaced() {
    let pair = real_pair();
    let late = Raw::new_key();
    pair.b.ok("peer_add", json!({ "peer_id": late.public().to_string(), "label": "late", "addresses": [] }));
    pair.b.ok("peer_grant", json!({ "peer_id": late.public().to_string(), "capability": "receive", "scope": { "kind": "peer" } }));
    let addr = pair.b.ok("transport_status", json!({}))["listen"][0].as_str().unwrap().to_string();
    let raw = Raw::connect(late, &pair.b_id, &addr).unwrap();
    raw.send(raw.hello());
    pair.send(&pair.a, &pair.b_id, "k1", "before");
    wait_until("the deposit", || pair.b.ok("list", json!({ "session_hint": "session-1" }))["messages"].as_array().unwrap().len() == 1);

    publish(&pair.b, real("other-native", "{\"other\":true}", "session-1"), 2);
    raw.send(json!({ "t": "deposit", "origin_id": "late-1", "recipient": wire_form(&the_real_one()), "body": "after", "reply_to": null, "run_hint": null, "span_hint": null }));
    // The session record ends; the same conversation returns under a new record, saying whom it replaces.
    pair.b.ok("binding_invalidate", json!({ "session_hint": "session-1", "reason": "ended", "generation": 5 }));
    let resumed = real(NATIVE, CHECKOUT, "session-2");
    let published = pair.b.ok("binding_publish", json!({ "recipient": resumed, "generation": 1, "valid_for_ms": 300_000, "project": PROJECT, "resumed_from": ["session-1"] }));
    assert_eq!(published["released"].as_array().unwrap().len(), 2, "{published}");
    let claimed = pair.b.ok("claim", json!({ "recipient": resumed }));
    assert_eq!(claimed["messages"].as_array().unwrap().len(), 2);
}

#[test]
fn an_unknown_handoff_is_never_requeued_by_a_return_and_redelivery_works_on_wire_addressed_mail() {
    let pair = real_pair();
    pair.send(&pair.a, &pair.b_id, "k1", "hello");
    wait_until("the deposit", || pair.b.ok("list", json!({ "session_hint": "session-1" }))["messages"].as_array().unwrap().len() == 1);
    let claimed = pair.b.ok("claim", json!({ "recipient": the_real_one() }));
    let attempt = claimed["attempt_id"].as_str().unwrap().to_string();
    let id = b_message(&pair)["message_id"].clone();
    assert_eq!(b_message(&pair)["state"], "handoff-unknown");

    // Replacement and exact return, then a heartbeat: nothing re-queues an uncertain handoff on its own.
    publish(&pair.b, real("other-native", "{\"other\":true}", "session-1"), 2);
    publish(&pair.b, the_real_one(), 3);
    publish(&pair.b, the_real_one(), 3);
    assert_eq!(b_message(&pair)["state"], "handoff-unknown");

    // The addressed user's explicit choice still works, and the engine says the recipient matches.
    let observed = pair.b.ok("status", json!({ "message_id": id, "observed": the_real_one() }));
    assert_eq!(observed["observed_match"], true);
    let other = pair.b.ok("status", json!({ "message_id": id, "observed": real(NATIVE, "{\"x\":1}", "session-1") }));
    assert_eq!(other["observed_match"], false);
    assert_eq!(pair.b.err("redeliver", json!({ "message_id": id, "attempt_id": attempt, "recipient": real("elsewhere", CHECKOUT, "session-1") })), "RECIPIENT_MISMATCH");
    pair.b.ok("redeliver", json!({ "message_id": id, "attempt_id": attempt, "recipient": the_real_one() }));
    assert_eq!(b_message(&pair)["state"], "queued");
    assert_eq!(pair.b.ok("claim", json!({ "recipient": the_real_one() }))["messages"][0]["attempt"], 2);
}

#[test]
fn a_peer_cannot_put_a_path_or_a_provider_id_into_this_database() {
    let pair = real_pair();
    let hostile = Raw::new_key();
    let hostile_id = hostile.public().to_string();
    pair.a.ok("peer_add", json!({ "peer_id": hostile_id, "label": "hostile", "addresses": [] }));
    let addr = pair.a.ok("transport_status", json!({}))["listen"][0].as_str().unwrap().to_string();
    let raw = Raw::connect(hostile, &pair.a_id, &addr).unwrap();
    raw.send(raw.hello());
    let before = pair.a.snapshot();
    let published = |native: &str, checkout: &str| {
        json!({ "t": "published", "entries": [{ "session_hint": "session-1", "provider": "claude-code", "native_id": native, "checkout": checkout, "scope": "ps_00000000000000000000000000000001", "ttl_ms": 1000 }] })
    };
    let good = setu_links::wire::address("claude-code", NATIVE, CHECKOUT);
    for (native, checkout) in [(NATIVE.to_string(), good.1.clone()), (good.0.clone(), CHECKOUT.to_string()), (NATIVE.to_string(), CHECKOUT.to_string()), ("w1:XYZ".into(), good.1.clone())] {
        let reply = raw.send(published(&native, &checkout)).unwrap();
        assert_eq!((reply["t"].as_str(), reply["code"].as_str()), (Some("rejected"), Some("REQUEST_INVALID")), "{native}");
    }
    assert_eq!(pair.a.snapshot(), before);
    // Deposits are held to the same shape on the receiving side.
    let b_raw_key = Raw::new_key();
    pair.b.ok("peer_add", json!({ "peer_id": b_raw_key.public().to_string(), "label": "h", "addresses": [] }));
    pair.b.ok("peer_grant", json!({ "peer_id": b_raw_key.public().to_string(), "capability": "receive", "scope": { "kind": "peer" } }));
    let baddr = pair.b.ok("transport_status", json!({}))["listen"][0].as_str().unwrap().to_string();
    let b_raw = Raw::connect(b_raw_key, &pair.b_id, &baddr).unwrap();
    b_raw.send(b_raw.hello());
    let b_before = pair.b.snapshot();
    let reply = b_raw.send(json!({ "t": "deposit", "origin_id": "x1", "recipient": the_real_one(), "body": "hi", "reply_to": null, "run_hint": null, "span_hint": null })).unwrap();
    assert_eq!(reply["code"], "REQUEST_INVALID");
    assert_eq!(pair.b.snapshot(), b_before);
}

#[test]
fn a_send_to_a_peer_must_use_an_address_the_peer_published() {
    let pair = real_pair();
    let mut args = send_args("k1", "hello", NATIVE);
    args["recipient"] = the_real_one();
    args["peer_id"] = json!(pair.b_id);
    let before = pair.a.snapshot();
    assert_eq!(pair.a.err("send", args), "RECIPIENT_ADDRESS_INVALID");
    assert_eq!(pair.a.snapshot(), before);
}

#[test]
fn an_older_wire_version_is_refused_by_name_with_the_supported_one() {
    let pair = real_pair();
    let stranger = Raw::new_key();
    pair.b.ok("peer_add", json!({ "peer_id": stranger.public().to_string(), "label": "old", "addresses": [] }));
    let addr = pair.b.ok("transport_status", json!({}))["listen"][0].as_str().unwrap().to_string();
    let raw = Raw::connect(stranger, &pair.b_id, &addr).unwrap();
    let before = pair.b.snapshot();
    let reply = raw.send(json!({ "t": "hello", "versions": [1], "capabilities": ["cancel", "deposit", "published", "receipt"], "engine_version": "old", "schema_version": 3 })).unwrap();
    assert_eq!((reply["code"].as_str(), reply["supported"].clone()), (Some("PROTOCOL_INCOMPATIBLE"), json!([2])));
    assert_eq!(pair.b.snapshot(), before);
}

#[test]
fn the_address_function_matches_independently_computed_vectors() {
    // `printf 'setu-links/wire/native/1\0claude-code\0abc' | shasum -a 256`, and the checkout analogue.
    let (native, checkout) = setu_links::wire::address("claude-code", "abc", "xyz");
    assert_eq!(native, "w1:e6642cd2bd7aca03a21d966e1b1c69f6a44dd0ff876e8ad803adb74f8c437b6b");
    assert_eq!(checkout, "w1:d76bfda78b1240167abd0eb3ebf084eece95022b6d1110fa876890690a1b8724");
    // The same text in another role is a different address: the two components cannot be swapped.
    assert_ne!(setu_links::wire::address("claude-code", "xyz", "abc"), (native, checkout));
}

#[test]
fn a_message_stored_before_this_change_is_never_sent_never_rewritten_and_ends_visibly() {
    let pair = Pair::new();
    pair.authorize(&pair.a, &pair.a_id, &pair.b, &pair.b_id, "project-1");
    pair.wait_published(&pair.a, &pair.b_id);
    // A message from the earlier build: addressed with the raw tuple, still pending. (A fixture of stored data.)
    let rows_before;
    {
        let db = rusqlite::Connection::open(pair.a.dir.join("mailbox.sqlite3")).unwrap();
        db.execute(
            "INSERT INTO messages (id, sender, idempotency_key, payload_digest, kind, body, size, provider, native_id, checkout, session_hint, created_at)
             VALUES ('m_legacy', 'user', 'k-legacy', 'digest', 'message', 'old private address', 19, 'claude-code', ?1, ?2, 'session-1', 1000)",
            rusqlite::params![NATIVE, CHECKOUT],
        )
        .unwrap();
        db.execute("INSERT INTO outbox (message_id, peer_id, outbox_state, expires_at, updated_at) VALUES ('m_legacy', ?1, 'pending', 99999999999999, 1000)", [&pair.b_id]).unwrap();
        rows_before = db.query_row("SELECT id, sender, idempotency_key, payload_digest, body, provider, native_id, checkout, session_hint, created_at FROM messages WHERE id = 'm_legacy'", [], |r| {
            Ok((0..10).map(|i| r.get::<_, rusqlite::types::Value>(i).unwrap()).map(|v| format!("{v:?}")).collect::<Vec<_>>())
        }).unwrap();
    }
    wait_until("the legacy message to end visibly", || status(&pair.a, "m_legacy")["transport"]["outbox"] == "rejected");
    let seen = status(&pair.a, "m_legacy");
    assert_eq!((seen["state"].as_str(), seen["reason"].as_str()), (Some("rejected"), Some("LEGACY_PRIVATE_ADDRESS")));
    assert_eq!(seen["transport"]["attempts"], 0);
    // Still readable, byte for byte as it was written; never sent.
    let db = rusqlite::Connection::open_with_flags(pair.a.dir.join("mailbox.sqlite3"), rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY).unwrap();
    let rows_after = db.query_row("SELECT id, sender, idempotency_key, payload_digest, body, provider, native_id, checkout, session_hint, created_at FROM messages WHERE id = 'm_legacy'", [], |r| {
        Ok((0..10).map(|i| r.get::<_, rusqlite::types::Value>(i).unwrap()).map(|v| format!("{v:?}")).collect::<Vec<_>>())
    }).unwrap();
    assert_eq!(rows_before, rows_after);
    assert_eq!(pair.b.ok("list", json!({ "session_hint": "session-1" }))["messages"], json!([]));
    assert_eq!(pair.a.ok("show", json!({ "message_id": "m_legacy" }))["body"], "old private address");
}

#[test]
fn the_derived_cache_forgets_malformed_and_expired_entries_without_touching_mail() {
    let engine = Engine::new();
    let peer = Raw::new_key().public().to_string();
    engine.ok("peer_add", json!({ "peer_id": peer, "label": "p", "addresses": [] }));
    let (native, checkout) = setu_links::wire::address("claude-code", "n", "c");
    {
        let db = rusqlite::Connection::open(engine.dir.join("mailbox.sqlite3")).unwrap();
        let insert = |hint: &str, native: &str, checkout: &str, until: i64| {
            db.execute("INSERT INTO remote_bindings (peer_id, session_hint, provider, native_id, checkout, scope, valid_until) VALUES (?1, ?2, 'claude-code', ?3, ?4, 'ps_x', ?5)", rusqlite::params![peer, hint, native, checkout, until]).unwrap();
        };
        insert("raw", NATIVE, CHECKOUT, i64::MAX);
        insert("expired", &native, &checkout, 1);
        insert("good", &native, &checkout, i64::MAX);
    }
    engine.ok("sweep", json!({}));
    let kept: Vec<String> = rusqlite::Connection::open_with_flags(engine.dir.join("mailbox.sqlite3"), rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)
        .unwrap()
        .prepare("SELECT session_hint FROM remote_bindings ORDER BY 1")
        .unwrap()
        .query_map([], |r| r.get(0))
        .unwrap()
        .collect::<Result<_, _>>()
        .unwrap();
    assert_eq!(kept, vec!["good".to_string()]);
}
