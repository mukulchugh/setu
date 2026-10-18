//! The roster and grants: written only through trusted operations, default deny, nothing implied.
mod common;
use common::*;
use serde_json::{Value, json};

/// A real Ed25519 public key (hex), as a peer's identity is.
const PEER_A: &str = "3b6a27bcceb6a42d62a3a8d02a6f0d73653215771de243a63ac048a18b59da29";
const PEER_B: &str = "d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a";

fn add(engine: &Engine, peer: &str, label: &str) -> Value {
    engine.ok("peer_add", json!({ "peer_id": peer, "label": label, "addresses": ["127.0.0.1:4000"] }))
}

fn grant(peer: &str, capability: &str, scope: Value) -> Value {
    json!({ "peer_id": peer, "capability": capability, "scope": scope })
}

fn peers(engine: &Engine) -> Vec<Value> {
    engine.ok("peer_list", json!({}))["peers"].as_array().unwrap().clone()
}

#[test]
fn a_peer_added_by_the_service_has_no_grants() {
    let engine = Engine::new();
    add(&engine, PEER_A, "work laptop");
    let listed = peers(&engine);
    assert_eq!(listed.len(), 1);
    assert_eq!(listed[0]["peer_id"], PEER_A);
    assert_eq!(listed[0]["label"], "work laptop");
    assert_eq!(listed[0]["addresses"], json!(["127.0.0.1:4000"]));
    assert_eq!(listed[0]["grants"], json!([]));
}

#[test]
fn listing_peers_creates_nothing() {
    let engine = Engine::new();
    assert_eq!(peers(&engine), Vec::<Value>::new());
    assert!(!engine.dir.exists());
}

#[test]
fn an_identity_that_is_not_a_public_key_is_refused_and_stores_nothing() {
    let engine = Engine::new();
    for bad in ["", "abc", &"z".repeat(64), &"A".repeat(64)] {
        let code = engine.err("peer_add", json!({ "peer_id": bad, "label": "x", "addresses": [] }));
        assert!(code == "REQUEST_INVALID" || code == "FIELD_TOO_LARGE", "{bad}: {code}");
    }
    assert!(!engine.dir.exists());
}

#[test]
fn addresses_must_be_socket_addresses_and_are_bounded() {
    let engine = Engine::new();
    for bad in [json!(["not an address"]), json!(["example.com:80"]), json!(vec!["127.0.0.1:1"; 9]), json!("127.0.0.1:1")] {
        assert_eq!(engine.err("peer_add", json!({ "peer_id": PEER_A, "label": "x", "addresses": bad })), "REQUEST_INVALID");
    }
}

#[test]
fn adding_a_peer_again_updates_its_label_and_addresses_but_keeps_its_grants() {
    let engine = Engine::new();
    add(&engine, PEER_A, "old");
    engine.ok("peer_grant", grant(PEER_A, "send", json!({ "kind": "peer" })));
    engine.ok("peer_add", json!({ "peer_id": PEER_A, "label": "new", "addresses": ["127.0.0.1:5000"] }));
    let listed = peers(&engine);
    assert_eq!(listed[0]["label"], "new");
    assert_eq!(listed[0]["addresses"], json!(["127.0.0.1:5000"]));
    assert_eq!(listed[0]["grants"].as_array().unwrap().len(), 1);
}

#[test]
fn a_grant_needs_a_known_peer_a_known_capability_and_a_well_formed_scope() {
    let engine = Engine::new();
    assert_eq!(engine.err("peer_grant", grant(PEER_A, "send", json!({ "kind": "peer" }))), "PEER_UNKNOWN");
    add(&engine, PEER_A, "a");
    assert_eq!(engine.err("peer_grant", grant(PEER_A, "wake", json!({ "kind": "peer" }))), "REQUEST_INVALID");
    assert_eq!(engine.err("peer_grant", grant(PEER_A, "send", json!({ "kind": "everything" }))), "REQUEST_INVALID");
    assert_eq!(engine.err("peer_grant", grant(PEER_A, "send", json!({ "kind": "project" }))), "REQUEST_INVALID");
    assert_eq!(engine.err("peer_grant", grant(PEER_A, "send", json!({ "kind": "peer", "id": "x" }))), "FIELD_UNSUPPORTED");
    assert_eq!(peers(&engine)[0]["grants"], json!([]));
}

#[test]
fn grants_are_listed_by_capability_and_scope_and_granting_twice_stores_one() {
    let engine = Engine::new();
    add(&engine, PEER_A, "a");
    engine.ok("peer_grant", grant(PEER_A, "receive", json!({ "kind": "project", "id": "project-digest-1" })));
    engine.ok("peer_grant", grant(PEER_A, "receive", json!({ "kind": "project", "id": "project-digest-1" })));
    engine.ok("peer_grant", grant(PEER_A, "visible", json!({ "kind": "session", "id": "session-1" })));
    let grants = peers(&engine)[0]["grants"].as_array().unwrap().clone();
    assert_eq!(grants.len(), 2);
    assert!(grants.contains(&json!({ "capability": "receive", "scope": { "kind": "project", "id": "project-digest-1" } })));
    assert!(grants.contains(&json!({ "capability": "visible", "scope": { "kind": "session", "id": "session-1" } })));
}

#[test]
fn removing_a_grant_removes_only_that_grant_and_is_safe_to_repeat() {
    let engine = Engine::new();
    add(&engine, PEER_A, "a");
    engine.ok("peer_grant", grant(PEER_A, "send", json!({ "kind": "peer" })));
    engine.ok("peer_grant", grant(PEER_A, "receive", json!({ "kind": "peer" })));
    engine.ok("peer_grant_remove", grant(PEER_A, "send", json!({ "kind": "peer" })));
    engine.ok("peer_grant_remove", grant(PEER_A, "send", json!({ "kind": "peer" })));
    assert_eq!(peers(&engine)[0]["grants"], json!([{ "capability": "receive", "scope": { "kind": "peer" } }]));
}

#[test]
fn removing_a_peer_removes_its_grants_and_leaves_other_peers_alone() {
    let engine = Engine::new();
    add(&engine, PEER_A, "a");
    add(&engine, PEER_B, "b");
    engine.ok("peer_grant", grant(PEER_A, "send", json!({ "kind": "peer" })));
    engine.ok("peer_grant", grant(PEER_B, "send", json!({ "kind": "peer" })));
    engine.ok("peer_remove", json!({ "peer_id": PEER_A }));
    engine.ok("peer_remove", json!({ "peer_id": PEER_A }));
    let listed = peers(&engine);
    assert_eq!(listed.len(), 1);
    assert_eq!(listed[0]["peer_id"], PEER_B);
    assert_eq!(listed[0]["grants"].as_array().unwrap().len(), 1);
    // Re-adding a removed peer does not bring its old grants back.
    add(&engine, PEER_A, "a again");
    assert_eq!(peers(&engine).iter().find(|p| p["peer_id"] == PEER_A).unwrap()["grants"], json!([]));
}

#[test]
fn a_wake_flag_or_any_unknown_field_is_refused_everywhere() {
    let engine = Engine::new();
    assert_eq!(engine.err("peer_add", json!({ "peer_id": PEER_A, "label": "x", "addresses": [], "wake": true })), "FIELD_UNSUPPORTED");
    add(&engine, PEER_A, "a");
    let mut with_extra = grant(PEER_A, "send", json!({ "kind": "peer" }));
    with_extra["authorize_wake"] = json!(true);
    assert_eq!(engine.err("peer_grant", with_extra), "FIELD_UNSUPPORTED");
}
