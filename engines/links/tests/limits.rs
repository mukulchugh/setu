mod common;
use common::*;
use serde_json::json;

#[test]
fn an_oversized_message_is_rejected_with_a_reason_and_nothing_is_stored() {
    let engine = Engine::new();
    let largest = "x".repeat(16 * 1024);
    engine.ok("send", send_args("fits", &largest, "native-a"));

    let too_big = "x".repeat(16 * 1024 + 1);
    assert_eq!(engine.err("send", send_args("too-big", &too_big, "native-a")), "BODY_TOO_LARGE");

    let inbox = engine.ok("list", json!({ "session_hint": "session-1" }));
    assert_eq!(inbox["messages"].as_array().unwrap().len(), 1);
}

#[test]
fn a_full_inbox_rejects_further_mail_for_that_conversation_only() {
    let engine = Engine::new();
    for n in 0..100 {
        engine.ok("send", send_args(&format!("key-{n}"), "hello", "native-a"));
    }
    assert_eq!(engine.err("send", send_args("key-100", "hello", "native-a")), "RECIPIENT_QUEUE_FULL");
    engine.ok("send", send_args("key-100", "hello", "native-b"));

    // A retry of mail that is already stored is a replay, not new load.
    let replay = engine.ok("send", send_args("key-0", "hello", "native-a"));
    assert_eq!(replay["replayed"], true);
}

#[cfg(feature = "test-hooks")]
mod expiry {
    use super::*;

    const DAY_MS: i64 = 24 * 60 * 60 * 1000;

    #[test]
    fn mail_nobody_handled_expires_visibly() {
        let engine = Engine::new();
        let at = |ms: i64| [("SETU_LINKS_TEST_NOW_MS", ms.to_string())];
        let sent = engine.call_env("send", send_args("old", "hello", "native-a"), &[("SETU_LINKS_TEST_NOW_MS", "1000")]);
        let id = sent["result"]["message_id"].as_str().unwrap().to_string();

        let later = at(1000 + 7 * DAY_MS + 1);
        let later: Vec<(&str, &str)> = later.iter().map(|(k, v)| (*k, v.as_str())).collect();
        let status = engine.call_env("status", json!({ "message_id": id }), &later);
        assert_eq!(status["result"]["state"], "expired");
        assert_eq!(status["result"]["reason"], "expired");

        let swept = engine.call_env("sweep", json!({}), &later);
        assert_eq!(swept["result"]["expired"], json!([id]));
        let again = engine.call_env("sweep", json!({}), &later);
        assert_eq!(again["result"]["expired"], json!([]));
    }

    #[test]
    fn a_read_after_expiry_still_reports_what_the_store_holds_until_it_is_swept() {
        let engine = Engine::new();
        let sent = engine.call_env("send", send_args("old", "hello", "native-a"), &[("SETU_LINKS_TEST_NOW_MS", "1000")]);
        let queued = sent["result"]["message_id"].as_str().unwrap().to_string();
        let sent = engine.call_env("send", send_args("old2", "hello", "native-b"), &[("SETU_LINKS_TEST_NOW_MS", "1000")]);
        let held = sent["result"]["message_id"].as_str().unwrap().to_string();
        engine.call_env("reconcile", json!({ "recipient": recipient("native-a") }), &[("SETU_LINKS_TEST_NOW_MS", "1000")]);
        let later = [("SETU_LINKS_TEST_NOW_MS", "700000000")];

        for (id, stored) in [(&queued, "queued"), (&held, "held")] {
            let status = engine.call_env("status", json!({ "message_id": id }), &later);
            assert_eq!(status["result"]["state"], "expired", "{id}");
            assert_eq!(status["result"]["stored_state"], stored, "{id}: nothing has persisted the expiry yet");
        }
        // Expired mail is never restored by an observation, and the list agrees with the status.
        let observed = json!({ "session_hint": "session-1", "observed": recipient("native-b") });
        let listed = engine.call_env("list", observed, &later);
        let listed = listed["result"]["messages"].as_array().unwrap();
        for (id, stored) in [(&queued, "queued"), (&held, "held")] {
            let message = listed.iter().find(|m| m["message_id"] == id.as_str()).unwrap();
            assert_eq!((message["state"].clone(), message["stored_state"].clone()), (json!("expired"), json!(stored)));
        }

        engine.call_env("sweep", json!({}), &later);
        let swept = engine.call_env("status", json!({ "message_id": queued }), &later);
        assert_eq!(swept["result"]["stored_state"], "expired");
    }

    #[test]
    fn expired_mail_is_neither_claimed_nor_cancelled() {
        let engine = Engine::new();
        let sent = engine.call_env("send", send_args("old", "hello", "native-a"), &[("SETU_LINKS_TEST_NOW_MS", "1000")]);
        let id = sent["result"]["message_id"].as_str().unwrap().to_string();
        let later = [("SETU_LINKS_TEST_NOW_MS", "700000000")];

        let cancel = engine.call_env("cancel", json!({ "message_id": id, "sender": { "kind": "user" } }), &later);
        assert_eq!(cancel["error"]["code"], "NOT_CANCELLABLE");
        let claim = engine.call_env("claim", json!({ "recipient": recipient("native-a") }), &later);
        assert_eq!(claim["result"]["messages"], json!([]));
        let status = engine.call_env("status", json!({ "message_id": id }), &later);
        assert_eq!(status["result"]["state"], "expired");
    }
}
