//! Sharing policy: the engine is the one authority over which projects are shared, and a project that is
//! not shared accepts nothing from any principal but the local user.
mod common;
use common::*;
use serde_json::{Value, json};

fn enable(engine: &Engine, project: &str) -> Value {
    engine.ok("share_enable", json!({ "project": project, "owner": "Mukul" }))
}

fn state_of(engine: &Engine, project: &str) -> Value {
    engine.ok("share_status", json!({ "project": project }))["projects"][0].clone()
}

#[test]
fn enabling_records_visibility_and_receiving_and_leaves_interrupt_and_attention_off() {
    let engine = Engine::new();
    let enabled = enable(&engine, "repo");
    assert_eq!(enabled["changed"], true);
    let mut policy = enabled["policy"].clone();
    let scope = policy["scope"].as_str().unwrap().to_string();
    assert!(scope.starts_with("ps_") && scope.len() == 35, "{scope}");
    policy["scope"] = json!("<scope>");
    assert_eq!(
        policy,
        json!({ "version": 1, "scope": "<scope>", "owner": "Mukul", "visibility": true, "receive": true, "interrupt": false, "attention": false })
    );
    let status = state_of(&engine, "repo");
    assert_eq!(status["state"], "enabled");
    assert_eq!(status["policy"], enabled["policy"]);

    // Enabling the same policy again changes nothing, including its scope.
    let again = enable(&engine, "repo");
    assert_eq!(again["changed"], false);
    assert_eq!(again["policy"]["scope"], scope.as_str());

    // Withdrawing and enabling again is a new share with a new scope, so nothing keyed to the old one lives on.
    engine.ok("share_disable", json!({ "project": "repo" }));
    assert_ne!(enable(&engine, "repo")["policy"]["scope"], scope.as_str());
}

#[test]
fn a_project_nobody_enabled_reads_as_absent_and_the_read_creates_nothing() {
    let engine = Engine::new();
    assert_eq!(state_of(&engine, "repo")["state"], "absent");
    assert_eq!(engine.ok("share_status", json!({}))["projects"], json!([]));
    assert_eq!(engine.ok("share_disable", json!({ "project": "repo" }))["removed"], false);
    assert!(!engine.dir.exists(), "a read or a no-op disable created {:?}", engine.dir);
}

#[test]
fn a_policy_survives_an_engine_restart_and_is_listed_by_project() {
    let engine = Engine::new();
    enable(&engine, "repo");
    enable(&engine, "other");
    let restarted = Engine::at(&engine.dir);
    let projects = restarted.ok("share_status", json!({}))["projects"].clone();
    let names: Vec<_> = projects.as_array().unwrap().iter().map(|p| p["project"].as_str().unwrap()).collect();
    assert_eq!(names, ["other", "repo"]);
    assert_eq!(state_of(&restarted, "repo")["policy"]["owner"], "Mukul");
}

#[test]
fn disabling_withdraws_the_policy_and_is_repeatable() {
    let engine = Engine::new();
    enable(&engine, "repo");
    assert_eq!(engine.ok("share_disable", json!({ "project": "repo" }))["removed"], true);
    assert_eq!(state_of(&engine, "repo")["state"], "absent");
    assert_eq!(engine.ok("share_disable", json!({ "project": "repo" }))["removed"], false);
}

#[test]
fn policy_arguments_are_strict() {
    let engine = Engine::new();
    assert_eq!(engine.err("share_enable", json!({ "project": "repo" })), "REQUEST_INVALID");
    assert_eq!(engine.err("share_enable", json!({ "project": "repo", "owner": "Mukul", "interrupt": true })), "FIELD_UNSUPPORTED");
    assert_eq!(engine.err("share_enable", json!({ "project": "repo", "owner": "a\nb" })), "REQUEST_INVALID");
    assert_eq!(engine.err("share_enable", json!({ "project": "", "owner": "Mukul" })), "REQUEST_INVALID");
    assert!(!engine.dir.exists(), "a refused request created a store");
}

// ---- enforcement: the engine decides, by the trusted principal and the project's standing ----

fn deposit(engine: &Engine, key: &str, project: &str) -> Value {
    engine.call("send", session_send_args(key, "from a session", "native-a", "sender-session", project))
}

#[test]
fn the_local_user_may_message_their_own_sessions_without_a_shared_project() {
    let engine = Engine::new();
    let sent = engine.ok("send", send_args("k1", "hello", "native-a"));
    assert_eq!(sent["state"], "queued");
}

#[test]
fn another_principal_is_refused_when_the_project_is_not_shared_and_nothing_is_stored() {
    let engine = Engine::new();
    let refused = deposit(&engine, "k1", "repo");
    assert_eq!(refused["error"]["code"], "NOT_SHARED");
    assert_eq!(refused["error"]["details"], json!({ "project": "repo" }));
    assert_eq!(engine.ok("list", json!({ "session_hint": "session-1" }))["messages"], json!([]));
    assert!(!engine.dir.exists(), "a refused deposit created a store");
}

#[test]
fn another_principal_is_admitted_to_the_shared_project_only() {
    let engine = Engine::new();
    enable(&engine, "repo");
    assert_eq!(deposit(&engine, "k1", "repo")["ok"], true);
    // Sharing one project says nothing about another.
    assert_eq!(deposit(&engine, "k2", "other")["error"]["code"], "NOT_SHARED");

    let inbox = engine.ok("list", json!({ "session_hint": "session-1" }))["messages"].clone();
    assert_eq!(inbox[0]["sender"], json!({ "kind": "session", "id": "sender-session" }));
    assert_eq!(inbox.as_array().unwrap().len(), 1);
}

#[test]
fn disabling_makes_the_engine_refuse_other_principals_again() {
    let engine = Engine::new();
    enable(&engine, "repo");
    assert_eq!(deposit(&engine, "k1", "repo")["ok"], true);
    engine.ok("share_disable", json!({ "project": "repo" }));
    assert_eq!(deposit(&engine, "k2", "repo")["error"]["code"], "NOT_SHARED");
    // The local user is unaffected.
    assert_eq!(engine.ok("send", send_args("k3", "still mine", "native-a"))["state"], "queued");
}

#[test]
fn a_peer_cannot_be_named_a_sender_until_peer_grants_exist() {
    let engine = Engine::new();
    enable(&engine, "repo");
    for sender in [json!({ "kind": "peer", "id": "p1" }), json!({ "kind": "session" }), json!({ "kind": "user", "id": "x" }), json!({ "kind": "session", "id": "a:b" })] {
        let mut args = session_send_args("k1", "hi", "native-a", "x", "repo");
        args["sender"] = sender.clone();
        let code = engine.err("send", args);
        assert!(["SENDER_UNSUPPORTED", "REQUEST_INVALID", "FIELD_UNSUPPORTED"].contains(&code.as_str()), "{sender}: {code}");
    }
    assert_eq!(engine.ok("list", json!({ "session_hint": "session-1" }))["messages"], json!([]));
}

#[test]
fn the_same_key_from_different_principals_is_two_messages_and_a_sessions_retry_is_a_replay() {
    let engine = Engine::new();
    enable(&engine, "repo");
    let from_user = engine.ok("send", send_args("k1", "same", "native-a"))["message_id"].as_str().unwrap().to_string();
    let from_session = deposit(&engine, "k1", "repo")["result"]["message_id"].as_str().unwrap().to_string();
    assert_ne!(from_user, from_session);
    // Retrying the session's own send is a replay.
    assert_eq!(deposit(&engine, "k1", "repo")["result"]["replayed"], true);
}

// ---- withdrawal reaches mail already stored, and the claim path checks the policy on its own ----

fn queued_id(engine: &Engine, key: &str) -> String {
    deposit(engine, key, "repo")["result"]["message_id"].as_str().unwrap().to_string()
}

fn state(engine: &Engine, id: &str) -> Value {
    engine.ok("status", json!({ "message_id": id }))
}

#[test]
fn disabling_holds_mail_already_queued_from_other_principals_and_enabling_again_restores_it() {
    let engine = Engine::new();
    enable(&engine, "repo");
    let theirs = queued_id(&engine, "k1");
    let mine = engine.ok("send", send_args("k2", "mine", "native-a"))["message_id"].as_str().unwrap().to_string();

    engine.ok("share_disable", json!({ "project": "repo" }));
    let held = state(&engine, &theirs);
    assert_eq!((held["state"].as_str(), held["reason"].as_str()), (Some("held"), Some("policy-disabled")));
    assert_eq!(held["stored_state"], "held");
    assert_eq!(state(&engine, &mine)["state"], "queued");

    // The claim hands the conversation only what its owner is still entitled to.
    let claim = engine.ok("claim", json!({ "recipient": recipient("native-a") }));
    let ids: Vec<_> = claim["messages"].as_array().unwrap().iter().map(|m| m["message_id"].as_str().unwrap().to_string()).collect();
    assert_eq!(ids, [mine]);

    enable(&engine, "repo");
    assert_eq!(state(&engine, &theirs)["state"], "queued");
    let claim = engine.ok("claim", json!({ "recipient": recipient("native-a") }));
    assert_eq!(claim["messages"][0]["message_id"], theirs.as_str());
    assert_eq!(claim["messages"][0]["sender"], json!({ "kind": "session", "id": "sender-session" }));
    assert!(claim["text"].as_str().unwrap().contains("from=\"session:sender-session\""), "{claim}");
}

#[test]
fn a_conversation_that_reappears_does_not_release_mail_a_policy_is_holding() {
    let engine = Engine::new();
    enable(&engine, "repo");
    let theirs = queued_id(&engine, "k1");
    engine.ok("share_disable", json!({ "project": "repo" }));
    // The session reports the very conversation the mail is for; only the policy is the obstacle.
    let reconciled = engine.ok("reconcile", json!({ "recipient": recipient("native-a") }));
    assert_eq!(reconciled["released"], json!([]));
    assert_eq!(state(&engine, &theirs)["state"], "held");
    assert_eq!(engine.ok("claim", json!({ "recipient": recipient("native-a") }))["messages"], json!([]));
}

#[test]
fn the_claim_checks_the_policy_itself_even_when_nothing_held_the_mail_first() {
    // Withdrawal outside the engine's own operations (here: the row removed directly) still stops the claim.
    let engine = Engine::new();
    enable(&engine, "repo");
    let theirs = queued_id(&engine, "k1");
    let db = rusqlite::Connection::open(engine.dir.join("mailbox.sqlite3")).unwrap();
    db.execute("DELETE FROM sharing_policies", []).unwrap();
    drop(db);

    assert_eq!(engine.ok("claim", json!({ "recipient": recipient("native-a") }))["messages"], json!([]));
    let held = state(&engine, &theirs);
    assert_eq!((held["state"].as_str(), held["reason"].as_str()), (Some("held"), Some("policy-disabled")));
}

#[test]
fn reads_report_withdrawn_mail_as_held_without_writing() {
    let engine = Engine::new();
    enable(&engine, "repo");
    let theirs = queued_id(&engine, "k1");
    let db = rusqlite::Connection::open(engine.dir.join("mailbox.sqlite3")).unwrap();
    db.execute("DELETE FROM sharing_policies", []).unwrap();
    drop(db);
    let before = std::fs::read(engine.dir.join("mailbox.sqlite3")).unwrap();

    let read = state(&engine, &theirs);
    assert_eq!((read["state"].as_str(), read["reason"].as_str(), read["stored_state"].as_str()), (Some("held"), Some("policy-disabled"), Some("queued")));
    let listed = engine.ok("list", json!({ "session_hint": "session-1" }))["messages"][0].clone();
    assert_eq!(listed["state"], "held");
    assert_eq!(std::fs::read(engine.dir.join("mailbox.sqlite3")).unwrap(), before);
}

// ---- an unreadable policy fails closed for its project, recoverably, and survives a restart ----

fn set_policy_row(engine: &Engine, project: &str, version: i64, policy: &str) {
    let db = rusqlite::Connection::open(engine.dir.join("mailbox.sqlite3")).unwrap();
    db.execute("UPDATE sharing_policies SET version = ?2, policy = ?3 WHERE project = ?1", rusqlite::params![project, version, policy]).unwrap();
}

fn good_policy(engine: &Engine, project: &str) -> Value {
    state_of(engine, project)["policy"].clone()
}

#[test]
fn a_policy_the_engine_cannot_read_admits_nobody_and_says_how_to_recover() {
    let engine = Engine::new();
    enable(&engine, "repo");
    let good = good_policy(&engine, "repo");
    let mut wider = good.clone();
    wider["interrupt"] = json!(true);
    let mut extra = good.clone();
    extra["transcripts"] = json!(true);
    let cases = [
        (1, "{not json".to_string(), "malformed"),
        (1, "[]".to_string(), "malformed"),
        (1, wider.to_string(), "malformed"),
        (1, extra.to_string(), "malformed"),
        (1, good.to_string().replace("\"visibility\":true", "\"visibility\":\"yes\""), "malformed"),
        (2, good.to_string(), "unsupported-version"),
        (0, good.to_string(), "unsupported-version"),
    ];
    for (version, text, reason) in cases {
        set_policy_row(&engine, "repo", version, &text);
        let status = state_of(&engine, "repo");
        assert_eq!((status["state"].as_str(), status["error"]["code"].as_str(), status["error"]["reason"].as_str()), (Some("invalid"), Some("POLICY_INVALID"), Some(reason)), "{text}");

        let refused = deposit(&engine, "k1", "repo");
        assert_eq!(refused["error"]["code"], "POLICY_INVALID", "{text}");
        assert_eq!(refused["error"]["details"], json!({ "project": "repo", "reason": reason }));
        // Nothing opened for a restart either.
        assert_eq!(Engine::at(&engine.dir).call("send", session_send_args("k2", "x", "native-a", "s", "repo"))["error"]["code"], "POLICY_INVALID");
    }
    assert_eq!(engine.ok("list", json!({ "session_hint": "session-1" }))["messages"], json!([]));
}

#[test]
fn an_unreadable_policy_leaves_the_local_users_own_mail_and_other_projects_alone() {
    let engine = Engine::new();
    enable(&engine, "repo");
    enable(&engine, "other");
    set_policy_row(&engine, "repo", 7, "garbage");
    assert_eq!(engine.ok("send", send_args("k1", "mine", "native-a"))["state"], "queued");
    assert_eq!(state_of(&engine, "other")["state"], "enabled");
    assert_eq!(deposit(&engine, "k2", "other")["ok"], true);
}

#[test]
fn mail_deposited_before_the_policy_broke_is_held_not_claimed() {
    let engine = Engine::new();
    enable(&engine, "repo");
    let theirs = queued_id(&engine, "k1");
    set_policy_row(&engine, "repo", 1, "{not json");
    assert_eq!(engine.ok("claim", json!({ "recipient": recipient("native-a") }))["messages"], json!([]));
    let held = state(&engine, &theirs);
    assert_eq!((held["state"].as_str(), held["reason"].as_str()), (Some("held"), Some("policy-invalid")));
}

#[test]
fn an_unreadable_policy_is_recovered_by_disabling_or_by_enabling_again() {
    let engine = Engine::new();
    enable(&engine, "repo");
    set_policy_row(&engine, "repo", 1, "{not json");
    assert_eq!(engine.ok("share_disable", json!({ "project": "repo" }))["removed"], true);
    assert_eq!(state_of(&engine, "repo")["state"], "absent");

    enable(&engine, "repo");
    set_policy_row(&engine, "repo", 9, "{}");
    let enabled = enable(&engine, "repo");
    assert_eq!(enabled["changed"], true);
    assert_eq!(state_of(&engine, "repo")["state"], "enabled");
    assert_eq!(deposit(&engine, "k1", "repo")["ok"], true);
}

#[test]
fn a_restart_preserves_a_valid_policy_exactly() {
    let engine = Engine::new();
    let before = enable(&engine, "repo")["policy"].clone();
    let restarted = Engine::at(&engine.dir);
    assert_eq!(state_of(&restarted, "repo")["policy"], before);
    assert_eq!(restarted.call("send", session_send_args("k1", "x", "native-a", "s", "repo"))["ok"], true);
}

#[test]
fn changing_the_owner_label_keeps_the_scope_and_only_a_withdrawal_mints_a_new_one() {
    let engine = Engine::new();
    let first = enable(&engine, "repo");
    let renamed = engine.ok("share_enable", json!({ "project": "repo", "owner": "Mukul C" }));
    assert_eq!(renamed["changed"], true);
    assert_eq!(renamed["policy"]["owner"], "Mukul C");
    assert_eq!(renamed["policy"]["scope"], first["policy"]["scope"]);

    engine.ok("share_disable", json!({ "project": "repo" }));
    assert_ne!(enable(&engine, "repo")["policy"]["scope"], first["policy"]["scope"]);
}


#[test]
fn a_cross_record_resume_preserves_a_policy_hold_until_the_project_is_shared_again() {
    let engine = Engine::new();
    enable(&engine, "repo");
    let id = queued_id(&engine, "resume-policy");
    engine.ok("share_disable", json!({ "project": "repo" }));
    let mut current = recipient("native-a");
    current["session_hint"] = json!("session-resumed");
    let resumed = engine.ok("resume", json!({ "recipient": current, "from": ["session-1"] }));
    assert_eq!(resumed["moved"], json!([id]));
    assert_eq!(resumed["released"], json!([]));
    engine.ok("reconcile", json!({ "recipient": current }));
    let held = state(&engine, &id);
    assert_eq!(held["locator"], "session-resumed");
    assert_eq!(held["reason"], "policy-disabled");
    assert_eq!(held["attempts"], 0);
    assert_eq!(engine.ok("claim", json!({ "recipient": current }))["messages"], json!([]));
    enable(&engine, "repo");
    assert_eq!(engine.ok("claim", json!({ "recipient": current }))["messages"][0]["message_id"], id);
}

#[test]
fn session_principal_batches_preserve_attribution_and_fit_whole_provider_frames() {
    let engine = Engine::new();
    enable(&engine, "repo");
    let sender = "s".repeat(128);
    let body = "界".repeat(2000);
    for key in ["first", "second"] {
        engine.ok("send", session_send_args(key, &body, "native-a", &sender, "repo"));
    }
    for _ in 0..2 {
        let claim = engine.ok("claim", json!({ "recipient": recipient("native-a") }));
        assert_eq!(claim["messages"].as_array().unwrap().len(), 1);
        let text = claim["text"].as_str().unwrap();
        assert!(text.len() <= 10000);
        assert!(text.contains(&format!("from=\"session:{sender}\"")));
        assert!(text.contains(&body));
        assert!(text.ends_with("</setu-link-message>\n"));
    }
    assert_eq!(engine.ok("claim", json!({ "recipient": recipient("native-a") }))["messages"], json!([]));
}
