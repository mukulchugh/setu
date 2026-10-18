//! Attention requests. A session in a shared project may ask the receiving person to look at it, if and only
//! if the person opted that project in. The request is retained in full, never delivered to an agent, and
//! notification grouping is a separate, bounded view over the retained rows.
mod common;
use common::*;
use serde_json::{Value, json};

fn enable(engine: &Engine, project: &str) -> Value {
    engine.ok("share_enable", json!({ "project": project, "owner": "Mukul" }))
}

/// The reviewed scope is the project's current one, as `share_status` reports it.
fn scope_of(engine: &Engine, project: &str) -> Value {
    engine.ok("share_status", json!({ "project": project }))["projects"][0]["policy"]["scope"].clone()
}

fn opt_in(engine: &Engine, project: &str, enabled: bool) -> Value {
    engine.ok("share_attention", json!({ "project": project, "enabled": enabled, "scope": scope_of(engine, project) }))
}

fn policy_of(engine: &Engine, project: &str) -> Value {
    engine.ok("share_status", json!({ "project": project }))["projects"][0]["policy"].clone()
}

fn request_args(key: &str, body: &str, sender: &str, project: &str) -> Value {
    json!({
        "idempotency_key": key,
        "sender": { "kind": "session", "id": sender },
        "project": project,
        "recipient": recipient("native-a"),
        "body": body,
    })
}

fn raise(engine: &Engine, key: &str, body: &str) -> Value {
    engine.ok("attention_send", request_args(key, body, "sender-session", "repo"))
}

fn items(engine: &Engine) -> Vec<Value> {
    engine.ok("attention_list", json!({}))["items"].as_array().unwrap().clone()
}

fn shared_and_opted_in(engine: &Engine) {
    enable(engine, "repo");
    opt_in(engine, "repo", true);
}

// ---- policy: attention is its own opt-in ----

#[test]
fn attention_is_off_until_the_project_opts_in_and_opting_in_changes_nothing_else() {
    let engine = Engine::new();
    let enabled = enable(&engine, "repo");
    assert_eq!(enabled["policy"]["attention"], false);
    let before = enabled["policy"].clone();

    let on = opt_in(&engine, "repo", true);
    assert_eq!(on["changed"], true);
    let mut expected = before.clone();
    expected["attention"] = json!(true);
    assert_eq!(on["policy"], expected);
    assert_eq!(policy_of(&engine, "repo"), expected);
    // The scope, the owner and the other permissions are exactly as they were; interrupt is still off.
    assert_eq!(policy_of(&engine, "repo")["interrupt"], false);

    let again = opt_in(&engine, "repo", true);
    assert_eq!(again["changed"], false);

    let off = opt_in(&engine, "repo", false);
    assert_eq!(off["changed"], true);
    assert_eq!(policy_of(&engine, "repo"), before);
}

#[test]
fn enabling_again_keeps_the_choice_but_a_withdrawal_starts_over_with_a_new_scope() {
    let engine = Engine::new();
    shared_and_opted_in(&engine);
    let scope = policy_of(&engine, "repo")["scope"].clone();

    // The same share with another owner label is not a new decision.
    let relabelled = engine.ok("share_enable", json!({ "project": "repo", "owner": "Someone" }));
    assert_eq!(relabelled["policy"]["attention"], true);
    assert_eq!(relabelled["policy"]["scope"], scope);
    // Enabling with nothing changed also keeps it.
    assert_eq!(enable(&engine, "repo")["policy"]["attention"], true);

    engine.ok("share_disable", json!({ "project": "repo" }));
    let fresh = enable(&engine, "repo");
    assert_eq!(fresh["policy"]["attention"], false);
    assert_ne!(fresh["policy"]["scope"], scope);
}

#[test]
fn opting_in_needs_a_readable_shared_project_and_creates_nothing_otherwise() {
    let engine = Engine::new();
    assert_eq!(engine.err("share_attention", json!({ "project": "repo", "enabled": true, "scope": "ps_x" })), "NOT_SHARED");
    assert!(!engine.dir.exists(), "a refused opt-in created a store");

    enable(&engine, "other");
    assert_eq!(engine.err("share_attention", json!({ "project": "repo", "enabled": true, "scope": "ps_x" })), "NOT_SHARED");

    enable(&engine, "repo");
    let scope = scope_of(&engine, "repo");
    let db = rusqlite::Connection::open(engine.dir.join("mailbox.sqlite3")).unwrap();
    db.execute("UPDATE sharing_policies SET policy = 'garbage' WHERE project = 'repo'", []).unwrap();
    assert_eq!(engine.err("share_attention", json!({ "project": "repo", "enabled": true, "scope": scope })), "POLICY_INVALID");
    // The unreadable policy was not repaired or replaced by the attempt.
    assert_eq!(engine.ok("share_status", json!({ "project": "repo" }))["projects"][0]["state"], "invalid");
}

#[test]
fn enabling_attention_is_refused_for_any_scope_but_the_one_reviewed_and_disabling_never_needs_one() {
    let engine = Engine::new();
    enable(&engine, "repo");
    let reviewed = scope_of(&engine, "repo");
    // The share is withdrawn and made again after the review: a new scope.
    engine.ok("share_disable", json!({ "project": "repo" }));
    enable(&engine, "repo");
    assert_ne!(scope_of(&engine, "repo"), reviewed);
    assert_eq!(engine.err("share_attention", json!({ "project": "repo", "enabled": true, "scope": reviewed })), "SCOPE_CHANGED");
    assert_eq!(policy_of(&engine, "repo")["attention"], false);
    // The reviewed scope of the current share works.
    assert_eq!(engine.ok("share_attention", json!({ "project": "repo", "enabled": true, "scope": scope_of(&engine, "repo") }))["changed"], true);
    // Switching it off is a revocation: it needs no review, and a stale scope does not stop it.
    assert_eq!(engine.ok("share_attention", json!({ "project": "repo", "enabled": false }))["changed"], true);
    opt_in(&engine, "repo", true);
    assert_eq!(engine.ok("share_attention", json!({ "project": "repo", "enabled": false, "scope": reviewed }))["changed"], true);
    assert_eq!(policy_of(&engine, "repo")["attention"], false);
}

#[test]
fn the_opt_in_arguments_are_strict() {
    let engine = Engine::new();
    enable(&engine, "repo");
    for args in [
        json!({ "project": "repo", "scope": "ps_x" }),
        json!({ "project": "repo", "enabled": "yes", "scope": "ps_x" }),
        json!({ "project": "repo", "enabled": true, "scope": "ps_x", "interrupt": true }),
        json!({ "project": "", "enabled": true, "scope": "ps_x" }),
        // Enabling names the scope that was reviewed.
        json!({ "project": "repo", "enabled": true }),
    ] {
        let code = engine.err("share_attention", args.clone());
        assert!(["REQUEST_INVALID", "FIELD_UNSUPPORTED"].contains(&code.as_str()), "{args}: {code}");
    }
    assert_eq!(policy_of(&engine, "repo")["attention"], false);
}

#[test]
fn a_policy_that_grants_interrupt_or_carries_anything_else_is_still_unreadable() {
    let engine = Engine::new();
    shared_and_opted_in(&engine);
    let good = policy_of(&engine, "repo");
    let mut wider = good.clone();
    wider["interrupt"] = json!(true);
    let mut extra = good.clone();
    extra["wake"] = json!(true);
    let mut text = good.clone();
    text["attention"] = json!("yes");
    let db = rusqlite::Connection::open(engine.dir.join("mailbox.sqlite3")).unwrap();
    for broken in [wider, extra, text] {
        db.execute("UPDATE sharing_policies SET policy = ?1 WHERE project = 'repo'", [broken.to_string()]).unwrap();
        let status = engine.ok("share_status", json!({ "project": "repo" }))["projects"][0].clone();
        assert_eq!(status["state"], "invalid", "{broken}");
        assert_eq!(engine.err("attention_send", request_args("k1", "hi", "sender-session", "repo")), "POLICY_INVALID");
    }
}

// ---- admission: default deny, decided by the engine on every request ----

#[test]
fn nothing_is_accepted_unless_the_project_is_shared_and_opted_in() {
    let engine = Engine::new();
    let request = || request_args("k1", "please look", "sender-session", "repo");
    // Not shared at all: nothing is created.
    assert_eq!(engine.err("attention_send", request()), "NOT_SHARED");
    assert!(!engine.dir.exists(), "a refused request created a store");

    // Shared, attention still off.
    enable(&engine, "repo");
    assert_eq!(engine.err("attention_send", request()), "ATTENTION_NOT_ENABLED");
    assert!(items(&engine).is_empty());

    // Opting in admits it; opting in for one project says nothing about another.
    opt_in(&engine, "repo", true);
    assert_eq!(engine.ok("attention_send", request())["replayed"], false);
    enable(&engine, "other");
    assert_eq!(engine.err("attention_send", request_args("k2", "x", "sender-session", "other")), "ATTENTION_NOT_ENABLED");

    // Switching it off is immediate.
    opt_in(&engine, "repo", false);
    assert_eq!(engine.err("attention_send", request_args("k3", "x", "sender-session", "repo")), "ATTENTION_NOT_ENABLED");
    // Withdrawing the share is too.
    opt_in(&engine, "repo", true);
    engine.ok("share_disable", json!({ "project": "repo" }));
    assert_eq!(engine.err("attention_send", request_args("k4", "x", "sender-session", "repo")), "NOT_SHARED");
    assert_eq!(items(&engine).len(), 1, "only the one accepted request exists");
}

#[test]
fn only_a_session_can_raise_attention_never_the_user_or_a_peer() {
    let engine = Engine::new();
    shared_and_opted_in(&engine);
    for sender in [
        json!({ "kind": "user" }),
        json!({ "kind": "peer", "peer_id": "p1" }),
        json!({ "kind": "session" }),
        json!({ "kind": "session", "id": "a:b" }),
        json!({ "kind": "session", "id": "ok", "note": "x" }),
    ] {
        let mut args = request_args("k1", "hi", "x", "repo");
        args["sender"] = sender.clone();
        let code = engine.err("attention_send", args);
        assert!(["SENDER_UNSUPPORTED", "REQUEST_INVALID", "FIELD_UNSUPPORTED"].contains(&code.as_str()), "{sender}: {code}");
    }
    assert!(items(&engine).is_empty());
}

#[test]
fn a_request_carries_only_a_session_a_project_a_recipient_and_text() {
    let engine = Engine::new();
    shared_and_opted_in(&engine);
    for field in ["reply_to", "run_hint", "span_hint", "kind", "wake", "interrupt", "permission", "expires_at"] {
        let mut args = request_args("k1", "hi", "sender-session", "repo");
        args[field] = json!("x");
        assert_eq!(engine.err("attention_send", args), "FIELD_UNSUPPORTED", "{field}");
    }
    assert!(items(&engine).is_empty());
}

#[test]
fn the_text_is_bounded_and_printable() {
    let engine = Engine::new();
    shared_and_opted_in(&engine);
    let limit = "x".repeat(1024);
    assert_eq!(engine.ok("attention_send", request_args("k1", &limit, "sender-session", "repo"))["replayed"], false);
    assert_eq!(engine.err("attention_send", request_args("k2", &"x".repeat(1025), "sender-session", "repo")), "ATTENTION_TOO_LARGE");
    // Bytes, not characters.
    assert_eq!(engine.err("attention_send", request_args("k3", &"\u{20AC}".repeat(342), "sender-session", "repo")), "ATTENTION_TOO_LARGE");
    for bad in ["esc\u{1b}[31m", "nul\u{0}", "c1\u{85}", "bidi \u{202e}txt", "iso \u{2066}x", "line\u{2028}sep", "mark\u{200f}"] {
        assert_eq!(engine.err("attention_send", request_args("k4", bad, "sender-session", "repo")), "ATTENTION_BODY_INVALID", "{bad:?}");
    }
    // A request must say something.
    for blank in ["", " ", "\n\t  \n"] {
        let code = engine.err("attention_send", request_args("k6", blank, "sender-session", "repo"));
        assert!(["REQUEST_INVALID", "ATTENTION_BODY_INVALID"].contains(&code.as_str()), "{blank:?}: {code}");
    }
    // Newlines and tabs are ordinary text.
    engine.ok("attention_send", request_args("k5", "line one\n\tline two", "sender-session", "repo"));
    assert_eq!(items(&engine).len(), 2);
}

#[test]
fn a_retry_with_the_same_key_returns_the_same_request_and_a_different_one_conflicts() {
    let engine = Engine::new();
    shared_and_opted_in(&engine);
    let first = raise(&engine, "k1", "look at me");
    assert_eq!(first["replayed"], false);
    let retry = raise(&engine, "k1", "look at me");
    assert_eq!(retry["replayed"], true);
    assert_eq!(retry["attention_id"], first["attention_id"]);
    assert_eq!(engine.err("attention_send", request_args("k1", "something else", "sender-session", "repo")), "IDEMPOTENCY_CONFLICT");
    // Another session may use the same key.
    engine.ok("attention_send", request_args("k1", "look at me", "other-session", "repo"));
    assert_eq!(items(&engine).len(), 2);
}

#[test]
fn a_key_is_one_namespace_across_messages_and_attention_so_neither_aliases_the_other() {
    let engine = Engine::new();
    shared_and_opted_in(&engine);
    let sent = engine.ok("send", session_send_args("shared-key", "look at me", "native-a", "sender-session", "repo"));
    assert_eq!(engine.err("attention_send", request_args("shared-key", "look at me", "sender-session", "repo")), "IDEMPOTENCY_CONFLICT");
    // And the other way round.
    raise(&engine, "other-key", "look at me");
    assert_eq!(engine.err("send", session_send_args("other-key", "look at me", "native-a", "sender-session", "repo")), "IDEMPOTENCY_CONFLICT");
    // Neither created the other's row.
    assert_eq!(items(&engine).len(), 1);
    assert_eq!(engine.ok("list", json!({ "session_hint": "session-1" }))["messages"].as_array().unwrap().len(), 1);
    assert_eq!(engine.ok("status", json!({ "message_id": sent["message_id"] }))["state"], "queued");
}

// ---- an attention request is not mail ----

#[test]
fn an_attention_request_is_never_mail_and_never_reaches_an_agent() {
    let engine = Engine::new();
    shared_and_opted_in(&engine);
    let id = raise(&engine, "k1", "please look at this")["attention_id"].clone();

    // The ordinary mailbox does not know it: it cannot be listed, read, claimed, acknowledged, redelivered,
    // cancelled or confirmed, and the recipient's next turn carries nothing.
    assert_eq!(engine.ok("list", json!({ "session_hint": "session-1" }))["messages"], json!([]));
    for op in ["status", "show"] {
        assert_eq!(engine.err(op, json!({ "message_id": id })), "MESSAGE_NOT_FOUND", "{op}");
    }
    assert_eq!(engine.err("cancel", json!({ "message_id": id, "sender": { "kind": "user" } })), "MESSAGE_NOT_FOUND");
    assert_eq!(engine.err("acknowledge", json!({ "message_id": id, "recipient": recipient("native-a") })), "MESSAGE_NOT_FOUND");
    assert_eq!(
        engine.err("redeliver", json!({ "message_id": id, "attempt_id": "a_x", "recipient": recipient("native-a") })),
        "MESSAGE_NOT_FOUND"
    );
    let claimed = engine.ok("claim", json!({ "recipient": recipient("native-a") }));
    assert_eq!(claimed, json!({ "attempt_id": null, "messages": [], "text": "" }));
    assert_eq!(engine.ok("sweep", json!({}))["expired"], json!([]));
    assert_eq!(engine.ok("reconcile", json!({ "recipient": recipient("native-b") })), json!({ "held": [], "released": [] }));
    assert_eq!(engine.ok("resume", json!({ "recipient": recipient("native-a"), "from": ["session-0"] })), json!({ "moved": [], "released": [] }));

    // The database has no delivery, attempt or hold for it: a request is a row and nothing else.
    let db = rusqlite::Connection::open(engine.dir.join("mailbox.sqlite3")).unwrap();
    let count = |sql: &str| db.query_row(sql, [], |row| row.get::<_, i64>(0)).unwrap();
    assert_eq!(count("SELECT COUNT(*) FROM messages WHERE kind = 'attention'"), 1);
    assert_eq!(count("SELECT COUNT(*) FROM deliveries"), 0);
    assert_eq!(count("SELECT COUNT(*) FROM attempts"), 0);
}

#[test]
fn an_attention_request_does_not_count_against_or_change_the_recipients_mailbox() {
    let engine = Engine::new();
    shared_and_opted_in(&engine);
    let mail = engine.ok("send", send_args("k1", "ordinary mail", "native-a"))["message_id"].clone();
    for n in 0..5 {
        raise(&engine, &format!("a{n}"), "look");
    }
    let claimed = engine.ok("claim", json!({ "recipient": recipient("native-a") }));
    assert_eq!(claimed["messages"].as_array().unwrap().len(), 1);
    assert_eq!(claimed["messages"][0]["message_id"], mail);
    assert!(!claimed["text"].as_str().unwrap().contains("look"));
}

#[test]
fn a_request_is_retained_after_the_share_is_withdrawn_but_no_longer_admitted() {
    let engine = Engine::new();
    shared_and_opted_in(&engine);
    raise(&engine, "k1", "look");
    assert_eq!(items(&engine)[0]["admitted"], true);
    engine.ok("share_disable", json!({ "project": "repo" }));
    let kept = items(&engine);
    assert_eq!(kept.len(), 1);
    assert_eq!(kept[0]["admitted"], false);
    // Sharing again with a new scope does not revive an old opt-in.
    enable(&engine, "repo");
    assert_eq!(items(&engine)[0]["admitted"], false);
}

// ---- reading: passive, exact, and paged stably ----

#[test]
fn a_request_shows_its_sender_its_text_and_where_it_was_addressed() {
    let engine = Engine::new();
    shared_and_opted_in(&engine);
    let id = raise(&engine, "k1", "the build needs your decision")["attention_id"].clone();
    let shown = engine.ok("attention_show", json!({ "attention_id": id }));
    assert_eq!(shown["attention_id"], id);
    assert_eq!(shown["sender"], json!({ "kind": "session", "id": "sender-session" }));
    assert_eq!(shown["body"], "the build needs your decision");
    assert_eq!(shown["project"], "repo");
    assert_eq!(shown["recipient"], recipient("native-a"));
    assert_eq!(shown["admitted"], true);
    assert!(shown["created_at"].as_i64().unwrap() > 0);
    assert_eq!(engine.err("attention_show", json!({ "attention_id": "m_unknown" })), "ATTENTION_NOT_FOUND");
    // A message is not an attention request.
    let mail = engine.ok("send", send_args("k2", "mail", "native-a"))["message_id"].clone();
    assert_eq!(engine.err("attention_show", json!({ "attention_id": mail })), "ATTENTION_NOT_FOUND");
}

#[test]
fn reads_create_nothing_and_a_missing_store_is_empty() {
    let engine = Engine::new();
    assert_eq!(engine.ok("attention_list", json!({})), json!({ "items": [], "has_more": false, "next_before": null, "notifications": { "groups": [], "suppressed": 0 } }));
    assert_eq!(engine.err("attention_show", json!({ "attention_id": "m_x" })), "ATTENTION_NOT_FOUND");
    assert!(!engine.dir.exists());
}

#[test]
fn a_read_leaves_the_store_byte_for_byte_as_it_was() {
    let engine = Engine::new();
    shared_and_opted_in(&engine);
    raise(&engine, "k1", "look");
    let path = engine.dir.join("mailbox.sqlite3");
    let before = std::fs::read(&path).unwrap();
    items(&engine);
    engine.ok("attention_show", json!({ "attention_id": items(&engine)[0]["attention_id"] }));
    assert_eq!(std::fs::read(&path).unwrap(), before);
}

#[test]
fn the_list_pages_newest_first_without_gaps_or_repeats_even_as_new_requests_arrive() {
    let engine = Engine::new();
    shared_and_opted_in(&engine);
    let mut all = Vec::new();
    for n in 0..7 {
        all.push(raise(&engine, &format!("k{n}"), &format!("note {n}"))["attention_id"].as_str().unwrap().to_string());
    }
    let first = engine.ok("attention_list", json!({ "limit": 3 }));
    assert_eq!(first["items"].as_array().unwrap().len(), 3);
    assert_eq!(first["has_more"], true);
    // A request that arrives between pages does not shift the next page.
    raise(&engine, "late", "late note");
    let second = engine.ok("attention_list", json!({ "limit": 3, "before_id": first["next_before"] }));
    let third = engine.ok("attention_list", json!({ "limit": 3, "before_id": second["next_before"] }));
    assert_eq!(third["has_more"], false);
    let seen: Vec<_> = [&first, &second, &third].iter().flat_map(|page| page["items"].as_array().unwrap().iter().map(|i| i["attention_id"].as_str().unwrap().to_string())).collect();
    let expected: Vec<_> = all.iter().rev().cloned().collect();
    assert_eq!(seen, expected);
    assert_eq!(engine.err("attention_list", json!({ "limit": 0 })), "REQUEST_INVALID");
    assert_eq!(engine.err("attention_list", json!({ "limit": 101 })), "REQUEST_INVALID");
    assert_eq!(engine.err("attention_list", json!({ "before_id": "m_unknown" })), "ATTENTION_NOT_FOUND");
}

#[test]
fn a_blank_request_is_refused_before_a_store_exists() {
    let engine = Engine::new();
    assert_eq!(engine.err("attention_send", request_args("k1", "  \n ", "sender-session", "repo")), "ATTENTION_BODY_INVALID");
    assert!(!engine.dir.exists());
}

#[test]
fn the_list_can_be_limited_to_one_session() {
    let engine = Engine::new();
    shared_and_opted_in(&engine);
    raise(&engine, "k1", "for session one");
    let mut other = request_args("k2", "for session two", "sender-session", "repo");
    other["recipient"]["session_hint"] = json!("session-2");
    other["recipient"]["native_id"] = json!("native-b");
    engine.ok("attention_send", other);
    let only = engine.ok("attention_list", json!({ "session_hints": ["session-2"] }));
    assert_eq!(only["items"].as_array().unwrap().len(), 1);
    assert_eq!(only["items"][0]["body"], "for session two");
    assert_eq!(items(&engine).len(), 2);
}

#[test]
fn a_store_from_before_sharing_reads_as_having_no_requests_and_a_read_does_not_upgrade_it() {
    let engine = Engine::new();
    version_one_store(&engine);
    let version = || rusqlite::Connection::open(engine.dir.join("mailbox.sqlite3")).unwrap().pragma_query_value(None, "user_version", |r| r.get::<_, i64>(0)).unwrap();
    assert_eq!(version(), 1);
    assert_eq!(engine.ok("attention_list", json!({}))["items"], json!([]));
    assert_eq!(engine.err("attention_show", json!({ "attention_id": "att_x" })), "ATTENTION_NOT_FOUND");
    assert_eq!(engine.err("share_attention", json!({ "project": "repo", "enabled": true, "scope": "ps_x" })), "NOT_SHARED");
    assert_eq!(version(), 1, "a read or a refusal must not migrate the store");
    // The old mail is untouched by any of it.
    assert_eq!(engine.ok("list", json!({ "session_hint": "session-1" }))["messages"].as_array().unwrap().len(), 1);
}

#[test]
fn the_list_can_be_limited_to_several_sessions_and_the_filter_is_checked() {
    let engine = Engine::new();
    shared_and_opted_in(&engine);
    for (n, hint) in ["session-1", "session-2", "session-3"].iter().enumerate() {
        let mut args = request_args(&format!("k{n}"), &format!("for {hint}"), "sender-session", "repo");
        args["recipient"]["session_hint"] = json!(hint);
        args["recipient"]["native_id"] = json!(format!("native-{n}"));
        engine.ok("attention_send", args);
    }
    let two = engine.ok("attention_list", json!({ "session_hints": ["session-1", "session-3"] }));
    let bodies: Vec<_> = two["items"].as_array().unwrap().iter().map(|i| i["body"].as_str().unwrap()).collect();
    assert_eq!(bodies, ["for session-3", "for session-1"]);
    assert_eq!(engine.err("attention_list", json!({ "session_hints": [] })), "REQUEST_INVALID");
    assert_eq!(engine.err("attention_list", json!({ "session_hints": "session-1" })), "REQUEST_INVALID");
    assert_eq!(engine.err("attention_list", json!({ "session_hints": [1] })), "REQUEST_INVALID");
    assert_eq!(engine.err("attention_list", json!({ "session_hints": [""] })), "REQUEST_INVALID");
    assert_eq!(engine.err("attention_list", json!({ "session_hints": ["x".repeat(129)] })), "REQUEST_INVALID");
    // The old single-session field is gone, not silently ignored.
    assert_eq!(engine.err("attention_list", json!({ "session_hint": "session-1" })), "FIELD_UNSUPPORTED");
}

#[test]
fn showing_one_request_carries_no_notification_state_because_that_needs_the_whole_window() {
    let engine = Engine::new();
    shared_and_opted_in(&engine);
    let id = raise(&engine, "k1", "look")["attention_id"].clone();
    let shown = engine.ok("attention_show", json!({ "attention_id": id }));
    assert!(shown.get("group_key").is_none() && shown.get("notifying").is_none(), "{shown}");
}

#[test]
fn a_worktree_with_very_many_sessions_is_listed_completely_not_truncated() {
    let engine = Engine::new();
    shared_and_opted_in(&engine);
    let mut args = request_args("k1", "for the last session", "sender-session", "repo");
    args["recipient"]["session_hint"] = json!("session-1999");
    args["recipient"]["native_id"] = json!("native-1999");
    engine.ok("attention_send", args);
    raise(&engine, "k2", "for session-1");
    // Two thousand sessions named, the one with a request last: nothing is cut to a count.
    let hints: Vec<String> = (0..2000).map(|n| format!("session-{n}")).collect();
    let listed = engine.ok("attention_list", json!({ "session_hints": hints }));
    assert_eq!(listed["items"].as_array().unwrap().len(), 2);
    // The request protocol's size bound (`REQUEST_TOO_LARGE`, tested in protocol.rs) is the only limit.
}
