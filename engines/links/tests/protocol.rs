mod common;
use common::*;
use serde_json::json;

const SECRET: &str = "SECRET-BODY-7f3a";

#[test]
fn another_protocol_version_is_rejected_with_what_is_supported() {
    let engine = Engine::new();
    let request = json!({ "protocol": "setu-links/9", "id": "t", "op": "health", "args": {} });
    let (reply, status, _) = engine.raw(&request.to_string(), &[]);
    assert!(status.success());
    assert_eq!(reply["error"]["code"], "PROTOCOL_INCOMPATIBLE");
    assert_eq!(reply["error"]["details"]["supported"], json!(["setu-links/1"]));
}

#[test]
fn a_field_the_protocol_does_not_define_is_refused_and_nothing_is_stored() {
    let engine = Engine::new();
    let mut args = send_args("k1", "hello", "native-a");
    args["wake"] = json!(true);
    assert_eq!(engine.err("send", args), "FIELD_UNSUPPORTED");
    assert_eq!(engine.ok("list", json!({ "session_hint": "session-1" }))["messages"], json!([]));
    assert!(!engine.dir.exists());
}

#[test]
fn only_the_local_user_can_be_a_sender() {
    let engine = Engine::new();
    let mut args = send_args("k1", "hello", "native-a");
    args["sender"] = json!({ "kind": "peer" });
    assert_eq!(engine.err("send", args), "SENDER_UNSUPPORTED");
}

#[test]
fn an_oversized_request_is_refused_before_it_is_parsed() {
    let engine = Engine::new();
    let (reply, _, _) = engine.raw(&" ".repeat(1024 * 1024 + 1), &[]);
    assert_eq!(reply["error"]["code"], "REQUEST_TOO_LARGE");
}

#[test]
fn message_bodies_never_appear_in_errors_or_diagnostics() {
    let engine = Engine::new();
    let body = format!("{SECRET} {}", "x".repeat(16 * 1024));
    let mut wrong_type = send_args("k3", SECRET, "native-a");
    wrong_type["recipient"]["native_id"] = json!({ "oops": SECRET });
    let mut extra = send_args("k4", SECRET, "native-a");
    extra["note"] = json!(SECRET);

    engine.ok("send", send_args("k1", SECRET, "native-a"));
    let requests = [
        json!({ "protocol": "setu-links/1", "id": "t", "op": "send", "args": send_args("big", &body, "native-a") }).to_string(),
        json!({ "protocol": "setu-links/1", "id": "t", "op": "send", "args": send_args("k1", &format!("{SECRET} changed"), "native-a") }).to_string(),
        json!({ "protocol": "setu-links/1", "id": "t", "op": "send", "args": wrong_type }).to_string(),
        json!({ "protocol": "setu-links/1", "id": "t", "op": "send", "args": extra }).to_string(),
        format!("{{\"protocol\": \"{SECRET}\", \"op\": "),
        format!("{{\"protocol\":\"setu-links/1\",\"op\":\"{SECRET}\",\"args\":{{}}}}"),
    ];
    for request in requests {
        let (reply, _, stderr) = engine.raw(&request, &[]);
        assert_eq!(reply["ok"], false, "{request}");
        assert!(!reply.to_string().contains(SECRET), "reply leaked the body: {reply}");
        assert!(!stderr.contains(SECRET), "stderr leaked the body: {stderr}");
    }
    // A successful send is quiet too.
    let (_, _, stderr) = engine.raw(&json!({ "protocol": "setu-links/1", "id": "t", "op": "send", "args": send_args("k9", SECRET, "native-a") }).to_string(), &[]);
    assert_eq!(stderr, "");
}

#[test]
fn arguments_that_are_not_an_object_are_refused_and_nothing_is_created() {
    let engine = Engine::new();
    for args in ["5", "null", "\"x\"", "[]", "true"] {
        for op in ["sweep", "send", "claim"] {
            let request = format!("{{\"protocol\":\"setu-links/1\",\"id\":\"t\",\"op\":\"{op}\",\"args\":{args}}}");
            let (reply, _, _) = engine.raw(&request, &[]);
            assert_eq!(reply["error"]["code"], "REQUEST_INVALID", "{op} with args {args}: {reply}");
        }
    }
    let missing = "{\"protocol\":\"setu-links/1\",\"id\":\"t\",\"op\":\"sweep\"}";
    assert_eq!(engine.raw(missing, &[]).0["error"]["code"], "REQUEST_INVALID");
    assert!(!engine.dir.exists(), "a refused request must not create a store");
}
