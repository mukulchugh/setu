//! The derived receiver snapshot: published by the trusted service, bounded in time, revocable, and the only
//! thing that lets peer mail in. Everything is observed through the operation protocol.
mod common;
use common::*;
use serde_json::{Value, json};

fn publish_args(native_id: &str, generation: u64, valid_for_ms: u64) -> Value {
    json!({ "recipient": recipient(native_id), "generation": generation, "valid_for_ms": valid_for_ms })
}

#[test]
fn a_published_snapshot_is_shown_with_its_exact_conversation_and_a_bounded_lifetime() {
    let engine = Engine::new();
    let published = engine.ok("binding_publish", publish_args("native-a", 7, 60_000));
    let shown = engine.ok("binding_show", json!({ "session_hint": "session-1" }));
    assert_eq!(shown["state"], "valid");
    assert_eq!(shown["recipient"]["native_id"], "native-a");
    assert_eq!(shown["generation"], 7);
    assert_eq!(shown["valid_until"], published["valid_until"]);
    assert_eq!(shown["project"], Value::Null);
}

#[test]
fn a_session_never_published_has_no_snapshot_and_showing_creates_nothing() {
    let engine = Engine::new();
    assert_eq!(engine.ok("binding_show", json!({ "session_hint": "session-1" }))["state"], "absent");
    assert!(!engine.dir.exists());
}

#[test]
fn the_lifetime_is_bounded_between_one_millisecond_and_five_minutes() {
    let engine = Engine::new();
    assert_eq!(engine.err("binding_publish", publish_args("native-a", 1, 0)), "REQUEST_INVALID");
    assert_eq!(engine.err("binding_publish", publish_args("native-a", 1, 300_001)), "FIELD_TOO_LARGE");
    engine.ok("binding_publish", publish_args("native-a", 1, 300_000));
}

#[test]
fn generations_only_move_forward_and_one_generation_names_one_conversation() {
    let engine = Engine::new();
    engine.ok("binding_publish", publish_args("native-a", 5, 60_000));
    // A refresh of the same conversation at the same generation is fine.
    engine.ok("binding_publish", publish_args("native-a", 5, 60_000));
    assert_eq!(engine.err("binding_publish", publish_args("native-a", 4, 60_000)), "BINDING_STALE_GENERATION");
    assert_eq!(engine.err("binding_publish", publish_args("native-b", 5, 60_000)), "BINDING_CONFLICT");
    // A replacement conversation arrives with a higher generation.
    engine.ok("binding_publish", publish_args("native-b", 6, 60_000));
    assert_eq!(engine.ok("binding_show", json!({ "session_hint": "session-1" }))["recipient"]["native_id"], "native-b");
}

#[test]
fn publishing_holds_mail_for_a_replaced_conversation_and_restores_it_for_the_exact_one() {
    let engine = Engine::new();
    let for_a = engine.ok("send", send_args("k-a", "for a", "native-a"))["message_id"].as_str().unwrap().to_string();
    let published = engine.ok("binding_publish", publish_args("native-b", 2, 60_000));
    assert_eq!(published["held"], json!([for_a]));
    assert_eq!(engine.ok("show", json!({ "message_id": for_a }))["state"], "held");

    let back = engine.ok("binding_publish", publish_args("native-a", 3, 60_000));
    assert_eq!(back["released"], json!([for_a]));
    assert_eq!(engine.ok("show", json!({ "message_id": for_a }))["state"], "queued");
}

#[test]
fn invalidating_a_session_holds_its_queued_mail_and_withdraws_the_snapshot() {
    let engine = Engine::new();
    let id = engine.ok("send", send_args("k-a", "hello", "native-a"))["message_id"].as_str().unwrap().to_string();
    engine.ok("binding_publish", publish_args("native-a", 1, 60_000));

    let result = engine.ok("binding_invalidate", json!({ "session_hint": "session-1", "reason": "ended", "generation": 2 }));
    assert_eq!(result["held"], json!([id]));
    let shown = engine.ok("show", json!({ "message_id": id }));
    assert_eq!(shown["state"], "held");
    assert_eq!(shown["reason"], "session-not-running");
    assert_eq!(engine.ok("binding_show", json!({ "session_hint": "session-1" }))["state"], "invalid");
}

#[test]
fn only_known_reasons_invalidate_and_invalidating_again_is_safe() {
    let engine = Engine::new();
    engine.ok("binding_publish", publish_args("native-a", 1, 60_000));
    assert_eq!(engine.err("binding_invalidate", json!({ "session_hint": "session-1", "reason": "because", "generation": 2 })), "REQUEST_INVALID");
    engine.ok("binding_invalidate", json!({ "session_hint": "session-1", "reason": "replaced", "generation": 2 }));
    engine.ok("binding_invalidate", json!({ "session_hint": "session-1", "reason": "replaced", "generation": 2 }));
}

#[test]
fn a_session_that_never_published_can_be_fenced_and_a_late_publish_is_then_refused() {
    let engine = Engine::new();
    assert_eq!(engine.ok("binding_invalidate", json!({ "session_hint": "session-9", "reason": "ended", "generation": 4 }))["held"], json!([]));
    let shown = engine.ok("binding_show", json!({ "session_hint": "session-9" }));
    assert_eq!(shown["state"], "invalid");
    assert_eq!(shown["generation"], 4);
    let mut late = publish_args("native-a", 4, 60_000);
    late["recipient"]["session_hint"] = json!("session-9");
    assert_eq!(engine.err("binding_publish", late), "BINDING_FENCED");
}

#[test]
fn a_delayed_publish_never_resurrects_an_ended_or_replaced_binding() {
    let engine = Engine::new();
    engine.ok("binding_publish", publish_args("native-a", 5, 60_000));
    engine.ok("binding_invalidate", json!({ "session_hint": "session-1", "reason": "ended", "generation": 6 }));
    // A heartbeat that was already in flight, at the old or the fenced generation, changes nothing.
    assert_eq!(engine.err("binding_publish", publish_args("native-a", 5, 60_000)), "BINDING_STALE_GENERATION");
    assert_eq!(engine.err("binding_publish", publish_args("native-a", 6, 60_000)), "BINDING_FENCED");
    assert_eq!(engine.ok("binding_show", json!({ "session_hint": "session-1" }))["state"], "invalid");
    // Only a strictly newer decision binds again.
    engine.ok("binding_publish", publish_args("native-a", 7, 60_000));
    assert_eq!(engine.ok("binding_show", json!({ "session_hint": "session-1" }))["state"], "valid");
}

#[test]
fn an_old_invalidate_cannot_kill_a_newer_binding() {
    let engine = Engine::new();
    engine.ok("binding_publish", publish_args("native-b", 9, 60_000));
    assert_eq!(
        engine.err("binding_invalidate", json!({ "session_hint": "session-1", "reason": "replaced", "generation": 8 })),
        "BINDING_STALE_GENERATION"
    );
    assert_eq!(engine.ok("binding_show", json!({ "session_hint": "session-1" }))["state"], "valid");
}

#[test]
fn invalidating_at_the_bindings_own_generation_is_safe_to_repeat_and_a_newer_fence_wins() {
    let engine = Engine::new();
    engine.ok("binding_publish", publish_args("native-a", 5, 60_000));
    engine.ok("binding_invalidate", json!({ "session_hint": "session-1", "reason": "disabled", "generation": 5 }));
    engine.ok("binding_invalidate", json!({ "session_hint": "session-1", "reason": "disabled", "generation": 5 }));
    engine.ok("binding_invalidate", json!({ "session_hint": "session-1", "reason": "ended", "generation": 8 }));
    assert_eq!(engine.err("binding_publish", publish_args("native-a", 8, 60_000)), "BINDING_FENCED");
    assert_eq!(engine.ok("binding_show", json!({ "session_hint": "session-1" }))["generation"], 8);
}

#[test]
fn an_ownership_that_is_unknown_invalidates_like_an_ended_session() {
    let engine = Engine::new();
    let id = engine.ok("send", send_args("k-a", "hello", "native-a"))["message_id"].as_str().unwrap().to_string();
    engine.ok("binding_publish", publish_args("native-a", 1, 60_000));
    let result = engine.ok("binding_invalidate", json!({ "session_hint": "session-1", "reason": "ownership-unknown", "generation": 2 }));
    assert_eq!(result["held"], json!([id]));
    assert_eq!(engine.ok("show", json!({ "message_id": id }))["reason"], "session-not-running");
    assert_eq!(engine.ok("binding_show", json!({ "session_hint": "session-1" }))["invalid_reason"], "ownership-unknown");
}

#[test]
fn an_invalidation_must_name_its_generation() {
    let engine = Engine::new();
    assert_eq!(engine.err("binding_invalidate", json!({ "session_hint": "session-1", "reason": "ended" })), "REQUEST_INVALID");
}

#[test]
fn a_project_is_an_opaque_string_set_only_by_the_publisher() {
    let engine = Engine::new();
    let mut args = publish_args("native-a", 1, 60_000);
    args["project"] = json!("project-digest-1");
    engine.ok("binding_publish", args);
    assert_eq!(engine.ok("binding_show", json!({ "session_hint": "session-1" }))["project"], "project-digest-1");
    // Refreshing without a project removes it: a disabled project stops covering the session.
    engine.ok("binding_publish", publish_args("native-a", 1, 60_000));
    assert_eq!(engine.ok("binding_show", json!({ "session_hint": "session-1" }))["project"], Value::Null);
}

#[test]
fn nothing_besides_the_documented_fields_is_accepted() {
    let engine = Engine::new();
    let mut args = publish_args("native-a", 1, 60_000);
    args["wake"] = json!(true);
    assert_eq!(engine.err("binding_publish", args), "FIELD_UNSUPPORTED");
    assert!(!engine.dir.exists(), "a refused request left a store behind");
}

#[cfg(feature = "test-hooks")]
mod clock {
    use super::*;

    fn at(ms: i64) -> [(&'static str, String); 1] {
        [("SETU_LINKS_TEST_NOW_MS", ms.to_string())]
    }

    fn call_at(engine: &Engine, ms: i64, op: &str, args: Value) -> Value {
        let env = at(ms);
        engine.call_env(op, args, &[(env[0].0, env[0].1.as_str())])
    }

    #[test]
    fn a_snapshot_past_its_lifetime_reads_as_expired_and_is_never_extended_by_reading() {
        let engine = Engine::new();
        call_at(&engine, 1_000_000, "binding_publish", publish_args("native-a", 1, 60_000));
        assert_eq!(call_at(&engine, 1_059_999, "binding_show", json!({ "session_hint": "session-1" }))["result"]["state"], "valid");
        let late = call_at(&engine, 1_060_000, "binding_show", json!({ "session_hint": "session-1" }));
        assert_eq!(late["result"]["state"], "expired");
        assert_eq!(late["result"]["valid_until"], 1_060_000);
    }

    #[test]
    fn a_heartbeat_inside_the_lifetime_moves_the_expiry_forward() {
        let engine = Engine::new();
        call_at(&engine, 1_000_000, "binding_publish", publish_args("native-a", 1, 60_000));
        call_at(&engine, 1_040_000, "binding_publish", publish_args("native-a", 1, 60_000));
        assert_eq!(call_at(&engine, 1_090_000, "binding_show", json!({ "session_hint": "session-1" }))["result"]["state"], "valid");
    }
}
