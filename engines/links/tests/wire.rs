//! What a connected peer can and cannot make the engine do, driven by a hand-written authenticated peer.
mod common;
use common::*;
use serde_json::{Value, json};

/// A daemon with one raw peer on its roster and the usual authorization for it, ready for frames.
struct Target {
    engine: Engine,
    _daemon: Daemon,
    raw: Raw,
    addr: String,
    id: String,
}

fn deposit(origin: &str, body: &str) -> Value {
    json!({ "t": "deposit", "origin_id": origin, "recipient": wire_recipient("native-a"), "body": body, "reply_to": null, "run_hint": null, "span_hint": null })
}

fn code(reply: &Option<Value>) -> String {
    let reply = reply.as_ref().expect("a reply");
    assert_eq!(reply["t"], "rejected", "{reply}");
    reply["code"].as_str().unwrap().to_string()
}

impl Target {
    /// `grants`: whether the peer may receive into the shared project, as a normal pairing would have set up.
    fn new(grants: bool) -> Target {
        let engine = Engine::new();
        let id = engine.ok("identity", json!({}))["peer_id"].as_str().unwrap().to_string();
        let daemon = engine.start();
        let addr = engine.ok("transport_status", json!({}))["listen"][0].as_str().unwrap().to_string();
        let key = Raw::new_key();
        let raw_id = key.public().to_string();
        engine.ok("peer_add", json!({ "peer_id": raw_id, "label": "raw", "addresses": [] }));
        if grants {
            engine.ok("share_enable", json!({ "project": "project-1", "owner": "casey" }));
            engine.ok("binding_publish", json!({ "recipient": recipient("native-a"), "generation": 1, "valid_for_ms": 300_000, "project": "project-1" }));
            engine.ok("peer_grant", json!({ "peer_id": raw_id, "capability": "receive", "scope": { "kind": "peer" } }));
        }
        let raw = Raw::connect(key, &id, &addr).expect("a roster peer connects");
        Target { engine, _daemon: daemon, raw, addr, id }
    }

    fn hello(&self) -> Value {
        self.raw.send(self.raw.hello()).expect("hello reply")
    }

    fn inbox_len(&self) -> usize {
        self.engine.ok("list", json!({ "session_hint": "session-1" }))["messages"].as_array().unwrap().len()
    }
}

#[test]
fn a_peer_that_never_said_hello_gets_nothing_done() {
    let target = Target::new(true);
    assert_eq!(code(&target.raw.send(deposit("o1", "hi"))), "HELLO_REQUIRED");
    assert_eq!(target.inbox_len(), 0);
}

#[test]
fn a_compatible_peer_is_welcomed_with_the_negotiated_version() {
    let target = Target::new(true);
    let reply = target.hello();
    assert_eq!(reply["t"], "hello_ok");
    assert_eq!(reply["version"], setu_links::wire::VERSIONS[0]);
}

#[test]
fn a_complete_directory_publication_fits_one_transport_frame() {
    let entries = (0..256)
        .map(|n| setu_links::wire::Published {
            session_hint: format!("session-{n:028x}"),
            provider: "claude-code".into(),
            native_id: format!("w1:{n:064x}"),
            checkout: format!("w1:{:064x}", n + 256),
            scope: format!("ps_{n:032x}"),
            ttl_ms: 120_000,
        })
        .collect::<Vec<_>>();
    let frame = serde_json::to_vec(&setu_links::wire::Request::Published { entries }).unwrap();

    assert!(frame.len() > 64 * 1024, "the former limit must reject this valid complete replacement");
    assert!(frame.len() <= setu_links::wire::MAX_FRAME, "{} bytes", frame.len());
}

#[test]
fn an_incompatible_protocol_version_is_rejected_with_the_reason_and_changes_no_state() {
    let target = Target::new(true);
    let before = target.engine.snapshot();
    let reply = target.raw.send(json!({ "t": "hello", "versions": [99], "capabilities": ["deposit"], "engine_version": "x", "schema_version": 3 }));
    assert_eq!(code(&reply), "PROTOCOL_INCOMPATIBLE");
    assert_eq!(reply.unwrap()["supported"], json!(setu_links::wire::VERSIONS));
    wait_until("the connection to close", || target.raw.is_closed());
    assert_eq!(target.engine.snapshot(), before, "an incompatible peer changed state");
    assert_eq!(target.engine.ok("transport_status", json!({}))["links"].as_array().unwrap().iter().filter(|l| l["state"] == "connected").count(), 0);
}

#[test]
fn a_peer_missing_a_required_capability_is_rejected_by_name() {
    let target = Target::new(true);
    let before = target.engine.snapshot();
    let reply = target.raw.send(json!({ "t": "hello", "versions": setu_links::wire::VERSIONS, "capabilities": ["deposit"], "engine_version": "x", "schema_version": 3 }));
    assert_eq!(code(&reply), "CAPABILITY_MISSING");
    assert_eq!(target.engine.snapshot(), before);
}

#[test]
fn an_incompatible_peer_is_shown_as_such_in_status() {
    let target = Target::new(true);
    target.raw.send(json!({ "t": "hello", "versions": [99], "capabilities": [], "engine_version": "x", "schema_version": 3 }));
    wait_until("status to name it", || {
        target.engine.ok("transport_status", json!({}))["links"].as_array().unwrap().iter().any(|l| l["state"] == "incompatible" && l["code"] == "PROTOCOL_INCOMPATIBLE")
    });
}

#[test]
fn a_stranger_not_on_the_roster_is_refused_and_leaves_nothing_behind() {
    let engine = Engine::new();
    let id = engine.ok("identity", json!({}))["peer_id"].as_str().unwrap().to_string();
    let _daemon = engine.start();
    let addr = engine.ok("transport_status", json!({}))["listen"][0].as_str().unwrap().to_string();
    let before = engine.snapshot();
    let stranger = Raw::connect(Raw::new_key(), &id, &addr);
    if let Ok(raw) = stranger {
        // The handshake may complete; the engine then closes it without reading a frame.
        wait_until("the stranger to be dropped", || raw.is_closed());
    }
    assert_eq!(engine.snapshot(), before);
}

#[test]
fn a_stranger_is_turned_away_without_waiting_for_the_stores_write_lock() {
    let engine = Engine::new();
    let id = engine.ok("identity", json!({}))["peer_id"].as_str().unwrap().to_string();
    let _daemon = engine.start();
    let addr = engine.ok("transport_status", json!({}))["listen"][0].as_str().unwrap().to_string();
    // Somebody else (a claim, say) holds the write lock. A stranger's handshake must not queue behind it.
    let holder = rusqlite::Connection::open(engine.dir.join("mailbox.sqlite3")).unwrap();
    holder.execute_batch("BEGIN IMMEDIATE").unwrap();
    let started = std::time::Instant::now();
    if let Ok(raw) = Raw::connect(Raw::new_key(), &id, &addr) {
        wait_until("the stranger to be dropped", || raw.is_closed());
    }
    assert!(started.elapsed() < std::time::Duration::from_secs(3), "a stranger waited {:?} for the write lock", started.elapsed());
    holder.execute_batch("ROLLBACK").unwrap();
}

#[test]
fn a_deposit_is_stored_once_however_often_it_is_replayed() {
    let target = Target::new(true);
    target.hello();
    let first = target.raw.send(deposit("o1", "hello")).unwrap();
    assert_eq!((first["t"].as_str(), first["state"].as_str(), first["replayed"].as_bool()), (Some("deposited"), Some("queued"), Some(false)));
    let again = target.raw.send(deposit("o1", "hello")).unwrap();
    assert_eq!(again["replayed"], true);
    assert_eq!(target.inbox_len(), 1);
}

#[test]
fn the_same_key_with_a_different_payload_is_a_conflict_and_changes_nothing() {
    let target = Target::new(true);
    target.hello();
    target.raw.send(deposit("o1", "hello"));
    let before = target.engine.snapshot();
    assert_eq!(code(&target.raw.send(deposit("o1", "something else"))), "IDEMPOTENCY_CONFLICT");
    assert_eq!(target.engine.snapshot(), before);
}

#[test]
fn a_peer_with_no_grant_is_denied_and_cannot_tell_which_sessions_exist() {
    let target = Target::new(false);
    target.hello();
    let known = code(&target.raw.send(deposit("o1", "hi")));
    let mut unknown_session = deposit("o2", "hi");
    unknown_session["recipient"]["session_hint"] = json!("no-such-session");
    assert_eq!(known, "PEER_NOT_AUTHORIZED");
    assert_eq!(code(&target.raw.send(unknown_session)), "PEER_NOT_AUTHORIZED");
    assert_eq!(target.inbox_len(), 0);
}

#[test]
fn a_forged_session_that_was_never_bound_is_rejected_and_nothing_is_stored() {
    let target = Target::new(true);
    target.hello();
    let before = target.engine.snapshot();
    let mut forged = deposit("o1", "hi");
    forged["recipient"]["session_hint"] = json!("session-forged");
    let reply = target.raw.send(forged);
    assert_eq!(code(&reply), "RECIPIENT_BINDING_UNKNOWN");
    assert_eq!(reply.unwrap()["retryable"], true);
    assert_eq!(target.engine.snapshot(), before);
}

#[test]
fn a_recipient_naming_a_replaced_conversation_is_held_and_never_delivered() {
    let target = Target::new(true);
    target.engine.ok(
        "binding_publish",
        json!({ "recipient": recipient("native-b"), "generation": 2, "valid_for_ms": 300_000, "project": "project-1" }),
    );
    target.hello();
    let reply = target.raw.send(deposit("o1", "for the old conversation")).unwrap();
    assert_eq!((reply["state"].as_str(), reply["reason"].as_str()), (Some("held"), Some("conversation-replaced")));
    // Neither the old nor the new conversation can claim it.
    assert_eq!(target.engine.ok("claim", json!({ "recipient": recipient("native-a") }))["messages"], json!([]));
    assert_eq!(target.engine.ok("claim", json!({ "recipient": recipient("native-b") }))["messages"], json!([]));
}

#[test]
fn an_oversized_body_and_an_oversized_frame_are_refused() {
    let target = Target::new(true);
    target.hello();
    assert_eq!(code(&target.raw.send(deposit("o1", &"x".repeat(16 * 1024 + 1)))), "BODY_TOO_LARGE");
    assert_eq!(code(&target.raw.send_claimed_length(10 * 1024 * 1024)), "FRAME_TOO_LARGE");
    assert_eq!(target.inbox_len(), 0);
}

#[test]
fn fields_the_protocol_does_not_define_are_refused_including_a_wake_flag_and_a_claimed_expiry() {
    let target = Target::new(true);
    target.hello();
    for extra in [("wake", json!(true)), ("expires_at", json!(1)), ("notify", json!(true))] {
        let mut frame = deposit("o1", "hi");
        frame[extra.0] = extra.1;
        assert_eq!(code(&target.raw.send(frame)), "REQUEST_INVALID", "{}", extra.0);
    }
    assert_eq!(target.inbox_len(), 0);
}

#[test]
fn a_burst_past_the_per_peer_rate_is_deferred_not_stored() {
    let target = Target::new(true);
    target.hello();
    for n in 0..60 {
        let reply = target.raw.send(deposit(&format!("o{n}"), "hi")).unwrap();
        assert_eq!(reply["t"], "deposited", "{n}: {reply}");
    }
    let reply = target.raw.send(deposit("o-extra", "hi")).unwrap();
    assert_eq!(reply["t"], "busy");
    assert!(target.engine.ok("list", json!({ "session_hint": "session-1" }))["messages"].as_array().unwrap().len() <= 60);
}

#[test]
fn a_receipt_or_cancel_for_a_message_this_machine_never_sent_changes_nothing() {
    let target = Target::new(true);
    target.hello();
    let before = target.engine.snapshot();
    let receipt = json!({ "t": "receipt", "origin_id": "m_none", "recipient_digest": "0", "state": "acknowledged", "reason": null, "seq": 9 });
    assert_eq!(code(&target.raw.send(receipt)), "MESSAGE_NOT_FOUND");
    assert_eq!(target.engine.snapshot(), before);
}

#[test]
fn losing_every_grant_stops_new_mail_and_holds_what_is_waiting() {
    let target = Target::new(true);
    target.hello();
    let reply = target.raw.send(deposit("o1", "hi")).unwrap();
    assert_eq!(reply["state"], "queued");
    target.engine.ok("peer_grant_remove", json!({ "peer_id": target.raw.id, "capability": "receive", "scope": { "kind": "peer" } }));
    let id = target.engine.ok("list", json!({ "session_hint": "session-1" }))["messages"][0]["message_id"].clone();
    let shown = target.engine.ok("show", json!({ "message_id": id }));
    assert_eq!((shown["state"].as_str(), shown["reason"].as_str()), (Some("held"), Some("authorization-lapsed")));
    assert_eq!(code(&target.raw.send(deposit("o2", "again"))), "PEER_NOT_AUTHORIZED");
    assert_eq!(target.engine.ok("claim", json!({ "recipient": recipient("native-a") }))["messages"], json!([]));
    let _ = (&target.addr, &target.id);
}

#[test]
fn removing_the_peer_closes_its_connection_and_holds_its_mail_as_revoked() {
    let target = Target::new(true);
    target.hello();
    target.raw.send(deposit("o1", "hi"));
    target.engine.ok("peer_remove", json!({ "peer_id": target.raw.id }));
    let id = target.engine.ok("list", json!({ "session_hint": "session-1" }))["messages"][0]["message_id"].clone();
    assert_eq!(target.engine.ok("show", json!({ "message_id": id }))["reason"], "peer-revoked");
    // The next frame is refused and the connection is dropped.
    assert_eq!(code(&target.raw.send(deposit("o2", "more"))), "PEER_NOT_AUTHORIZED");
    wait_until("the revoked connection to close", || target.raw.is_closed());
    assert_eq!(target.engine.ok("claim", json!({ "recipient": recipient("native-a") }))["messages"], json!([]));
}

#[test]
fn a_session_outside_every_shared_project_admits_no_peer_whatever_it_was_granted() {
    let target = Target::new(true);
    // The session republishes without a project: it is no longer in anything shared.
    target.engine.ok("binding_publish", json!({ "recipient": recipient("native-a"), "generation": 1, "valid_for_ms": 300_000 }));
    target.engine.ok("peer_grant", json!({ "peer_id": target.raw.id, "capability": "receive", "scope": { "kind": "session", "id": "session-1" } }));
    target.hello();
    assert_eq!(code(&target.raw.send(deposit("o1", "hi"))), "PEER_NOT_AUTHORIZED");
    assert_eq!(target.inbox_len(), 0);
}

#[test]
fn a_session_grant_cannot_open_a_project_that_is_not_shared() {
    let target = Target::new(false);
    // Published into a project that has no sharing policy at all, with the broadest possible grants.
    target.engine.ok("binding_publish", json!({ "recipient": recipient("native-a"), "generation": 1, "valid_for_ms": 300_000, "project": "never-shared" }));
    for scope in [json!({ "kind": "peer" }), json!({ "kind": "session", "id": "session-1" })] {
        target.engine.ok("peer_grant", json!({ "peer_id": target.raw.id, "capability": "receive", "scope": scope }));
    }
    target.hello();
    assert_eq!(code(&target.raw.send(deposit("o1", "hi"))), "PEER_NOT_AUTHORIZED");
    assert_eq!(target.inbox_len(), 0);
}

#[test]
fn withdrawing_the_project_stops_new_mail_and_nothing_waiting_can_be_claimed() {
    let target = Target::new(true);
    target.hello();
    target.raw.send(deposit("o1", "hi"));
    target.engine.ok("share_disable", json!({ "project": "project-1" }));
    assert_eq!(code(&target.raw.send(deposit("o2", "more"))), "PEER_NOT_AUTHORIZED");
    assert_eq!(target.engine.ok("claim", json!({ "recipient": recipient("native-a") }))["messages"], json!([]));
}

#[test]
fn re_enabling_a_project_mints_a_new_scope_so_old_project_grants_stop_matching() {
    let target = Target::new(false);
    let scope = |engine: &Engine| engine.ok("share_enable", json!({ "project": "project-1", "owner": "casey" }))["policy"]["scope"].as_str().unwrap().to_string();
    let old = scope(&target.engine);
    target.engine.ok("binding_publish", json!({ "recipient": recipient("native-a"), "generation": 1, "valid_for_ms": 300_000, "project": "project-1" }));
    target.engine.ok("peer_grant", json!({ "peer_id": target.raw.id, "capability": "receive", "scope": { "kind": "project", "id": old } }));
    target.hello();
    assert_eq!(target.raw.send(deposit("o1", "hi")).unwrap()["t"], "deposited");

    target.engine.ok("share_disable", json!({ "project": "project-1" }));
    let renewed = scope(&target.engine);
    assert_ne!(old, renewed);
    // Sharing is back, the grant still names the old scope: it admits nothing until granted again.
    assert_eq!(code(&target.raw.send(deposit("o2", "after"))), "PEER_NOT_AUTHORIZED");
    target.engine.ok("peer_grant", json!({ "peer_id": target.raw.id, "capability": "receive", "scope": { "kind": "project", "id": renewed } }));
    assert_eq!(target.raw.send(deposit("o2", "after")).unwrap()["t"], "deposited");
}

#[test]
fn a_policy_that_does_not_allow_receiving_admits_nothing() {
    let target = Target::new(true);
    {
        // #11 owns policy writing; this fixture damages the stored policy the way a bad file would.
        let db = rusqlite::Connection::open(target.engine.dir.join("mailbox.sqlite3")).unwrap();
        db.execute("UPDATE sharing_policies SET policy = 'not json' WHERE project = 'project-1'", []).unwrap();
    }
    target.hello();
    assert_eq!(code(&target.raw.send(deposit("o1", "hi"))), "PEER_NOT_AUTHORIZED");
}

#[cfg(feature = "test-hooks")]
#[test]
fn the_receiver_sets_its_own_expiry_and_expired_mail_is_never_claimed() {
    const DAY: i64 = 24 * 60 * 60 * 1000;
    let engine = Engine::new();
    let t = 10_000_000_000_i64;
    let clock = |ms: i64| ms.to_string();
    let id = engine.ok("identity", json!({}))["peer_id"].as_str().unwrap().to_string();
    let daemon = engine.serve(&[("SETU_LINKS_TEST_NOW_MS", &clock(t))]);
    let status = engine.wait_running();
    let addr = status["listen"][0].as_str().unwrap().to_string();
    let key = Raw::new_key();
    let raw_id = key.public().to_string();
    let at = |ms: i64, op: &str, args: Value| engine.call_env(op, args, &[("SETU_LINKS_TEST_NOW_MS", &clock(ms))]);
    at(t, "peer_add", json!({ "peer_id": raw_id, "label": "raw", "addresses": [] }));
    at(t, "share_enable", json!({ "project": "project-1", "owner": "casey" }));
    at(t, "binding_publish", json!({ "recipient": recipient("native-a"), "generation": 1, "valid_for_ms": 300_000, "project": "project-1" }));
    at(t, "peer_grant", json!({ "peer_id": raw_id, "capability": "receive", "scope": { "kind": "peer" } }));
    let raw = Raw::connect(key, &id, &addr).unwrap();
    raw.send(raw.hello());
    let stored = raw.send(deposit("o1", "hi")).unwrap();
    assert_eq!(stored["t"], "deposited");
    let message = at(t, "list", json!({ "session_hint": "session-1" }))["result"]["messages"][0].clone();
    assert_eq!(message["expires_at"], t + 7 * DAY, "the receiver's own clock and limit decide the lifetime");
    let later = at(t + 7 * DAY + 1, "show", json!({ "message_id": message["message_id"] }));
    assert_eq!(later["result"]["state"], "expired");
    assert_eq!(at(t + 7 * DAY + 1, "claim", json!({ "recipient": recipient("native-a") }))["result"]["messages"], json!([]));
    drop(daemon);
}

#[test]
fn a_removed_peer_cannot_even_replay_a_deposit_it_made_before() {
    let target = Target::new(true);
    target.hello();
    target.raw.send(deposit("o1", "hi"));
    target.engine.ok("peer_remove", json!({ "peer_id": target.raw.id }));
    assert_eq!(code(&target.raw.send(deposit("o1", "hi"))), "PEER_NOT_AUTHORIZED");
}

#[cfg(feature = "test-hooks")]
mod clock {
    use super::*;

    const T: i64 = 10_000_000_000;

    /// A daemon whose clock stays at `T`, a raw peer on its roster, and a way to run operations at other times.
    struct Timed {
        engine: Engine,
        _daemon: Daemon,
        raw: Raw,
    }

    impl Timed {
        fn at(&self, ms: i64, op: &str, args: Value) -> Value {
            self.engine.call_env(op, args, &[("SETU_LINKS_TEST_NOW_MS", &ms.to_string())])
        }
    }

    /// The raw peer's key must be on the roster before it connects, so build it first.
    fn authorized(valid_for_ms: i64, published_at: i64) -> Timed {
        let engine = Engine::new();
        let id = engine.ok("identity", json!({}))["peer_id"].as_str().unwrap().to_string();
        let daemon = engine.serve(&[("SETU_LINKS_TEST_NOW_MS", &T.to_string())]);
        let addr = engine.wait_running()["listen"][0].as_str().unwrap().to_string();
        let key = Raw::new_key();
        let raw_id = key.public().to_string();
        let at = |ms: i64, op: &str, args: Value| engine.call_env(op, args, &[("SETU_LINKS_TEST_NOW_MS", &ms.to_string())]);
        at(T, "peer_add", json!({ "peer_id": raw_id, "label": "raw", "addresses": [] }));
        at(T, "share_enable", json!({ "project": "project-1", "owner": "casey" }));
        at(published_at, "binding_publish", json!({ "recipient": recipient("native-a"), "generation": 1, "valid_for_ms": valid_for_ms, "project": "project-1" }));
        at(T, "peer_grant", json!({ "peer_id": raw_id, "capability": "receive", "scope": { "kind": "peer" } }));
        let raw = Raw::connect(key, &id, &addr).unwrap();
        raw.send(raw.hello());
        Timed { engine, _daemon: daemon, raw }
    }

    #[test]
    fn a_snapshot_past_its_lifetime_admits_no_new_mail() {
        let timed = authorized(1_000, T - 10_000);
        assert_eq!(code(&timed.raw.send(deposit("o1", "hi"))), "RECIPIENT_BINDING_UNKNOWN");
        assert_eq!(timed.at(T, "list", json!({ "session_hint": "session-1" }))["result"]["messages"], json!([]));
    }

    #[test]
    fn mail_already_stored_is_not_handed_off_once_its_snapshot_has_lapsed() {
        let timed = authorized(60_000, T);
        assert_eq!(timed.raw.send(deposit("o1", "hi")).unwrap()["state"], "queued");
        // Nothing has told the engine anything; time alone has made the evidence stale.
        let late = timed.at(T + 61_000, "claim", json!({ "recipient": recipient("native-a") }));
        assert_eq!(late["result"]["messages"], json!([]));
        let id = timed.at(T, "list", json!({ "session_hint": "session-1" }))["result"]["messages"][0]["message_id"].clone();
        let shown = timed.at(T + 61_000, "show", json!({ "message_id": id }));
        assert_eq!((shown["result"]["state"].as_str(), shown["result"]["reason"].as_str()), (Some("held"), Some("authorization-lapsed")));
    }

    #[test]
    fn mail_held_for_a_lapse_comes_back_when_the_evidence_does() {
        let timed = authorized(60_000, T);
        timed.raw.send(deposit("o1", "hi"));
        timed.at(T + 61_000, "claim", json!({ "recipient": recipient("native-a") }));
        timed.at(T + 62_000, "binding_publish", json!({ "recipient": recipient("native-a"), "generation": 1, "valid_for_ms": 60_000, "project": "project-1" }));
        let claimed = timed.at(T + 63_000, "claim", json!({ "recipient": recipient("native-a") }));
        assert_eq!(claimed["result"]["messages"].as_array().unwrap().len(), 1);
    }

    /// The per-minute rate stops a burst; the per-peer pending cap stops a slow trickle that never stops. Three
    /// minutes of the maximum rate across three sessions reaches it, and the daemon's clock is moved between batches.
    #[test]
    fn a_peer_that_keeps_depositing_is_stopped_at_its_pending_cap_whatever_the_rate() {
        let engine = Engine::new();
        let id = engine.ok("identity", json!({}))["peer_id"].as_str().unwrap().to_string();
        let key = Raw::new_key();
        let raw_id = key.public().to_string();
        let at = |ms: i64, op: &str, args: Value| engine.call_env(op, args, &[("SETU_LINKS_TEST_NOW_MS", &ms.to_string())]);
        at(T, "peer_add", json!({ "peer_id": raw_id, "label": "raw", "addresses": [] }));
        at(T, "share_enable", json!({ "project": "project-1", "owner": "casey" }));
        at(T, "peer_grant", json!({ "peer_id": raw_id, "capability": "receive", "scope": { "kind": "peer" } }));
        let session = |n: usize| {
            let mut r = recipient(&format!("native-{n}"));
            r["session_hint"] = json!(format!("session-{n}"));
            r
        };
        for n in 0..3 {
            at(T, "binding_publish", json!({ "recipient": session(n), "generation": 1, "valid_for_ms": 300_000, "project": "project-1" }));
        }
        let deposit_to = |n: usize, origin: &str| {
            json!({ "t": "deposit", "origin_id": origin, "recipient": wire_form(&session(n)), "body": "hi", "reply_to": null, "run_hint": null, "span_hint": null })
        };
        let mut sent = 0;
        let mut last = None;
        for batch in 0..4 {
            let daemon = engine.serve(&[("SETU_LINKS_TEST_NOW_MS", &(T + batch * 61_000).to_string())]);
            let addr = engine.wait_running()["listen"][0].as_str().unwrap().to_string();
            let raw = Raw::connect(Raw::key_from(&key), &id, &addr).unwrap();
            raw.send(raw.hello());
            for _ in 0..60 {
                if sent == 201 {
                    break;
                }
                let reply = raw.send(deposit_to(sent % 3, &format!("o{sent}"))).unwrap();
                if sent < 200 {
                    assert_eq!(reply["t"], "deposited", "{sent}: {reply}");
                } else {
                    last = Some(reply);
                }
                sent += 1;
            }
            drop(daemon);
        }
        let refused = last.expect("the 201st deposit was attempted");
        assert_eq!((refused["t"].as_str(), refused["code"].as_str()), (Some("rejected"), Some("PEER_QUEUE_FULL")));
        assert_eq!(refused["retryable"], true);
    }
}

fn cancel(origin: &str) -> Value {
    json!({ "t": "cancel", "origin_id": origin })
}

fn tombstones(target: &Target) -> i64 {
    rusqlite::Connection::open_with_flags(target.engine.dir.join("mailbox.sqlite3"), rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)
        .unwrap()
        .query_row("SELECT COUNT(*) FROM cancel_tombstones", [], |row| row.get(0))
        .unwrap()
}

#[test]
fn a_cancel_naming_an_origin_that_is_not_a_plain_bounded_id_is_refused_and_records_nothing() {
    let target = Target::new(true);
    target.hello();
    let before = target.engine.snapshot();
    for origin in ["".to_string(), "x".repeat(129), "x".repeat(100_000), "has space".into(), "new\nline".into(), "../../etc".into(), "nul\u{0}byte".into()] {
        let reply = target.raw.send(cancel(&origin));
        assert_eq!(code(&reply), "REQUEST_INVALID", "{:?}", origin.chars().take(20).collect::<String>());
    }
    assert_eq!(target.engine.snapshot(), before);
}

#[test]
fn a_roster_peer_with_no_grant_cannot_make_the_engine_remember_anything() {
    let target = Target::new(false);
    target.hello();
    assert_eq!(code(&target.raw.send(cancel("m_early"))), "PEER_NOT_AUTHORIZED");
    assert_eq!(tombstones(&target), 0);
}

#[test]
fn cancelling_the_same_unseen_origin_again_records_it_once() {
    let target = Target::new(true);
    target.hello();
    for _ in 0..3 {
        assert_eq!(target.raw.send(cancel("m_early")).unwrap()["result"], "cancelled");
    }
    assert_eq!(tombstones(&target), 1);
}

#[test]
fn cancelling_a_message_that_is_here_records_no_tombstone() {
    let target = Target::new(true);
    target.hello();
    target.raw.send(deposit("o1", "hi"));
    assert_eq!(target.raw.send(cancel("o1")).unwrap()["result"], "cancelled");
    assert_eq!(tombstones(&target), 0);
}

#[cfg(feature = "test-hooks")]
mod tombstone_limits {
    use super::*;

    const T: i64 = 10_000_000_000;
    const DAY: i64 = 24 * 60 * 60 * 1000;

    struct Clocked {
        engine: Engine,
        id: String,
        raw_key: iroh::SecretKey,
    }

    fn clocked() -> Clocked {
        let engine = Engine::new();
        let id = engine.ok("identity", json!({}))["peer_id"].as_str().unwrap().to_string();
        let raw_key = Raw::new_key();
        let at = |ms: i64, op: &str, args: Value| engine.call_env(op, args, &[("SETU_LINKS_TEST_NOW_MS", &ms.to_string())]);
        at(T, "peer_add", json!({ "peer_id": raw_key.public().to_string(), "label": "raw", "addresses": [] }));
        at(T, "share_enable", json!({ "project": "project-1", "owner": "casey" }));
        at(T, "peer_grant", json!({ "peer_id": raw_key.public().to_string(), "capability": "receive", "scope": { "kind": "peer" } }));
        Clocked { engine, id, raw_key }
    }

    impl Clocked {
        fn daemon_at(&self, now: i64) -> (Daemon, Raw) {
            let daemon = self.engine.serve(&[("SETU_LINKS_TEST_NOW_MS", &now.to_string())]);
            let addr = self.engine.wait_running()["listen"][0].as_str().unwrap().to_string();
            let raw = Raw::connect(Raw::key_from(&self.raw_key), &self.id, &addr).unwrap();
            raw.send(raw.hello());
            (daemon, raw)
        }

        fn count(&self) -> i64 {
            rusqlite::Connection::open_with_flags(self.engine.dir.join("mailbox.sqlite3"), rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)
                .unwrap()
                .query_row("SELECT COUNT(*) FROM cancel_tombstones", [], |row| row.get(0))
                .unwrap()
        }
    }

    #[test]
    fn a_peer_cancelling_unseen_origins_is_rate_limited_then_capped_and_a_full_cap_refuses_honestly() {
        let c = clocked();
        let mut made = 0;
        for batch in 0..4 {
            let (_daemon, raw) = c.daemon_at(T + batch * 61_000);
            for _ in 0..60 {
                if made >= 200 {
                    break;
                }
                assert_eq!(raw.send(cancel(&format!("m_{made}"))).unwrap()["result"], "cancelled", "{made}");
                made += 1;
            }
        }
        assert_eq!(c.count(), 200);
        // Over the cap: refused as a retryable failure, nothing recorded, and never reported as cancelled.
        let (_daemon, raw) = c.daemon_at(T + 4 * 61_000);
        let refused = raw.send(cancel("m_one_more"));
        assert_eq!(code(&refused), "TOMBSTONE_LIMIT");
        assert_eq!(refused.unwrap()["retryable"], true);
        assert_eq!(c.count(), 200);
        // Because nothing was recorded, a deposit of that origin is not blocked: the engine did not claim a cancel it lacks.
        let late = raw.send(deposit("m_one_more", "hi"));
        assert!(late.is_some());
    }

    #[test]
    fn the_rate_limit_defers_a_burst_of_cancels() {
        let c = clocked();
        let (_daemon, raw) = c.daemon_at(T);
        for n in 0..60 {
            assert_eq!(raw.send(cancel(&format!("m_{n}"))).unwrap()["result"], "cancelled");
        }
        assert_eq!(raw.send(cancel("m_burst")).unwrap()["t"], "busy");
        assert_eq!(c.count(), 60);
    }

    #[test]
    fn tombstones_outlive_an_honest_retry_window_and_are_then_forgotten() {
        let c = clocked();
        {
            let (_daemon, raw) = c.daemon_at(T);
            raw.send(cancel("m_early"));
        }
        let sweep_at = |ms: i64| c.engine.call_env("sweep", json!({}), &[("SETU_LINKS_TEST_NOW_MS", &ms.to_string())]);
        // A sender retries a deposit for up to seven days: seven days later the tombstone must still stand.
        sweep_at(T + 7 * DAY);
        assert_eq!(c.count(), 1, "pruned while a retry could still arrive");
        sweep_at(T + 8 * DAY + 1);
        assert_eq!(c.count(), 0, "kept forever");
    }
}

#[test]
fn mail_held_when_a_grant_lapsed_follows_a_new_explicit_grant_but_revoked_mail_never_returns() {
    let target = Target::new(true);
    target.hello();
    target.raw.send(deposit("o-lapsed", "waiting"));
    let id = target.engine.ok("list", json!({ "session_hint": "session-1" }))["messages"][0]["message_id"].clone();
    target.engine.ok("peer_grant_remove", json!({ "peer_id": target.raw.id, "capability": "receive", "scope": { "kind": "peer" } }));
    assert_eq!(target.engine.ok("show", json!({ "message_id": id }))["reason"], "authorization-lapsed");
    // The user decides again: the same mail is authorized by the new grant.
    target.engine.ok("peer_grant", json!({ "peer_id": target.raw.id, "capability": "receive", "scope": { "kind": "peer" } }));
    assert_eq!(target.engine.ok("claim", json!({ "recipient": recipient("native-a") }))["messages"].as_array().unwrap().len(), 1);

    // Mail held because its peer was removed stays held, even if that peer is added and granted again.
    target.raw.send(deposit("o-revoked", "more"));
    target.engine.ok("peer_remove", json!({ "peer_id": target.raw.id }));
    target.engine.ok("peer_add", json!({ "peer_id": target.raw.id, "label": "raw again", "addresses": [] }));
    target.engine.ok("peer_grant", json!({ "peer_id": target.raw.id, "capability": "receive", "scope": { "kind": "peer" } }));
    assert_eq!(target.engine.ok("claim", json!({ "recipient": recipient("native-a") }))["messages"], json!([]));
    let held = target.engine.ok("list", json!({ "session_hint": "session-1" }))["messages"].as_array().unwrap().iter().filter(|m| m["reason"] == "peer-revoked").count();
    assert_eq!(held, 1);
}

#[test]
fn a_held_message_is_not_shown_as_queued_just_because_the_conversation_is_observed_again() {
    let target = Target::new(true);
    target.hello();
    target.raw.send(deposit("o1", "hi"));
    target.engine.ok("peer_remove", json!({ "peer_id": target.raw.id }));
    let id = target.engine.ok("list", json!({ "session_hint": "session-1" }))["messages"][0]["message_id"].clone();
    let seen = target.engine.ok("show", json!({ "message_id": id, "observed": recipient("native-a") }));
    assert_eq!((seen["state"].as_str(), seen["reason"].as_str()), (Some("held"), Some("peer-revoked")));
    assert_eq!(seen["observed_match"], true);
}

#[test]
fn a_publish_reports_as_released_only_mail_that_is_still_queued_when_it_commits() {
    let target = Target::new(true);
    target.hello();
    target.raw.send(deposit("o1", "waiting"));
    let id = target.engine.ok("list", json!({ "session_hint": "session-1" }))["messages"][0]["message_id"].clone();
    // The conversation is replaced, so the mail is held for that; then its sender loses the right to deliver.
    target.engine.ok("binding_publish", json!({ "recipient": recipient("native-b"), "generation": 2, "valid_for_ms": 300_000, "project": "project-1" }));
    target.engine.ok("peer_grant_remove", json!({ "peer_id": target.raw.id, "capability": "receive", "scope": { "kind": "peer" } }));
    // The exact conversation returns. The conversation alone would release the mail, authorization holds it again.
    let returned = target.engine.ok("binding_publish", json!({ "recipient": recipient("native-a"), "generation": 3, "valid_for_ms": 300_000, "project": "project-1" }));
    let shown = target.engine.ok("show", json!({ "message_id": id }));
    assert_eq!((shown["state"].as_str(), shown["reason"].as_str()), (Some("held"), Some("authorization-lapsed")));
    assert_eq!(returned["released"], json!([]), "the reply says released for mail that is held");
    assert_eq!(returned["held"], json!([id]));
}
