//! Peer mail follows the conversation, not the record that first received it: after an explicit resume the mail
//! is located at the new managed session and authorized there, in the same transaction as the publish.
mod common;
use common::*;
use serde_json::json;

fn republished_as_session_2(project: &str) -> serde_json::Value {
    let mut recipient = recipient("native-a");
    recipient["session_hint"] = json!("session-2");
    json!({ "recipient": recipient, "generation": 1, "valid_for_ms": 300_000, "project": project, "resumed_from": ["session-1"] })
}

fn deposited_and_ended() -> (Pair, String) {
    let pair = Pair::new();
    pair.authorize(&pair.a, &pair.a_id, &pair.b, &pair.b_id, "project-1");
    pair.wait_published(&pair.a, &pair.b_id);
    pair.send(&pair.a, &pair.b_id, "k1", "hello from a");
    wait_until("the deposit", || pair.b.ok("list", json!({ "session_hint": "session-1" }))["messages"].as_array().unwrap().len() == 1);
    let id = pair.b.ok("list", json!({ "session_hint": "session-1" }))["messages"][0]["message_id"].as_str().unwrap().to_string();
    pair.b.ok("binding_invalidate", json!({ "session_hint": "session-1", "reason": "ended", "generation": 5 }));
    assert_eq!(pair.b.ok("show", json!({ "message_id": id }))["state"], "held");
    (pair, id)
}

#[test]
fn publishing_with_resumed_from_moves_peer_mail_to_the_new_session_and_releases_it() {
    let (pair, id) = deposited_and_ended();
    let published = pair.b.ok("binding_publish", republished_as_session_2("project-1"));
    assert_eq!(published["released"], json!([id]));
    assert_eq!(pair.b.ok("show", json!({ "message_id": id }))["state"], "queued");

    let claimed = pair.b.ok("claim", json!({ "recipient": { "provider": "claude-code", "native_id": "native-a",
        "checkout": recipient("native-a")["checkout"], "session_hint": "session-2" } }));
    assert_eq!(claimed["messages"].as_array().unwrap().len(), 1);
    assert_eq!(claimed["messages"][0]["sender"]["id"], pair.a_id);
    assert!(claimed["text"].as_str().unwrap().contains(&format!("from=\"peer:{}\"", pair.a_id)));
}

#[test]
fn without_resumed_from_the_mail_stays_held_at_the_ended_session() {
    let (pair, id) = deposited_and_ended();
    let mut args = republished_as_session_2("project-1");
    args.as_object_mut().unwrap().remove("resumed_from");
    pair.b.ok("binding_publish", args);
    assert_eq!(pair.b.ok("show", json!({ "message_id": id }))["state"], "held");
}

#[test]
fn a_resume_only_moves_mail_for_the_exact_conversation() {
    let (pair, id) = deposited_and_ended();
    let mut other = recipient("native-other");
    other["session_hint"] = json!("session-2");
    pair.b.ok("binding_publish", json!({ "recipient": other, "generation": 1, "valid_for_ms": 300_000, "project": "project-1", "resumed_from": ["session-1"] }));
    assert_eq!(pair.b.ok("show", json!({ "message_id": id }))["state"], "held");
}

#[test]
fn resumed_from_is_bounded() {
    let engine = Engine::new();
    let mut args = republished_as_session_2("project-1");
    args["resumed_from"] = json!((0..9).map(|n| format!("session-old-{n}")).collect::<Vec<_>>());
    assert_eq!(engine.err("binding_publish", args), "FIELD_TOO_LARGE");
}
