//! A build without `test-hooks` is what ships: its clock and kill points cannot be steered.
#![cfg(not(feature = "test-hooks"))]
mod common;
use common::*;
use serde_json::json;

#[test]
fn a_shipped_build_ignores_the_test_clock_and_kill_points() {
    let engine = Engine::new();
    let env = [("SETU_LINKS_TEST_NOW_MS", "1000"), ("SETU_LINKS_TEST_KILL_AT", "send:before-commit")];
    let sent = engine.call_env("send", send_args("k", "hello", "native-a"), &env);
    assert_eq!(sent["ok"], true, "the kill point fired: {sent}");

    let inbox = engine.call_env("list", json!({ "session_hint": "session-1" }), &[]);
    let created = inbox["result"]["messages"][0]["created_at"].as_i64().unwrap();
    assert!(created > 1_700_000_000_000, "created_at {created} came from the test clock");
}
