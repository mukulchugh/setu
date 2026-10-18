//! Notification grouping and the bounds around it. Groups are a bounded view over retained requests: they
//! never hide or merge a row, their counts are not page-limited, and routine mail never joins them. Needs
//! `--features test-hooks` for the settable clock and the kill points.
#![cfg(feature = "test-hooks")]
mod common;
use common::*;
use rusqlite::params;
use serde_json::{Value, json};

const T0: i64 = 1_760_000_000_000;
const MINUTE: i64 = 60_000;

fn at(engine: &Engine, now: i64, op: &str, args: Value) -> Value {
    let reply = engine.call_env(op, args, &[("SETU_LINKS_TEST_NOW_MS", &now.to_string())]);
    assert_eq!(reply["ok"], true, "{op}: {reply}");
    reply["result"].clone()
}

fn at_err(engine: &Engine, now: i64, op: &str, args: Value) -> String {
    let reply = engine.call_env(op, args, &[("SETU_LINKS_TEST_NOW_MS", &now.to_string())]);
    assert_eq!(reply["ok"], false, "{op} unexpectedly succeeded: {reply}");
    reply["error"]["code"].as_str().unwrap().to_string()
}

fn request(key: &str, sender: &str, native: &str) -> Value {
    let mut recipient = recipient(native);
    recipient["session_hint"] = json!(format!("session-{native}"));
    json!({
        "idempotency_key": key,
        "sender": { "kind": "session", "id": sender },
        "project": "repo",
        "recipient": recipient,
        "body": format!("{key} needs you"),
    })
}

fn shared(engine: &Engine) {
    at(engine, T0, "share_enable", json!({ "project": "repo", "owner": "Mukul" }));
    let scope = at(engine, T0, "share_status", json!({ "project": "repo" }))["projects"][0]["policy"]["scope"].clone();
    at(engine, T0, "share_attention", json!({ "project": "repo", "enabled": true, "scope": scope }));
}

fn groups(engine: &Engine, now: i64) -> Vec<Value> {
    at(engine, now, "attention_list", json!({}))["notifications"]["groups"].as_array().unwrap().clone()
}

#[test]
fn five_rapid_requests_are_one_notification_and_five_retained_items() {
    let engine = Engine::new();
    shared(&engine);
    for n in 0..5 {
        at(&engine, T0 + n * 1000, "attention_send", request(&format!("k{n}"), "sender", "a"));
    }
    let listed = at(&engine, T0 + 6000, "attention_list", json!({}));
    assert_eq!(listed["items"].as_array().unwrap().len(), 5);
    let grouped = listed["notifications"]["groups"].as_array().unwrap();
    assert_eq!(grouped.len(), 1);
    assert_eq!(grouped[0]["count"], 5);
    assert_eq!(grouped[0]["count_complete"], true);
    assert_eq!(grouped[0]["sender"], json!({ "kind": "session", "id": "sender" }));
    assert_eq!(grouped[0]["first_at"], T0);
    assert_eq!(grouped[0]["last_at"], T0 + 4000);
    assert_eq!(grouped[0]["latest_attention_id"], listed["items"][0]["attention_id"]);
    assert_eq!(grouped[0]["item_ids"].as_array().unwrap().len(), 5);
    assert_eq!(listed["notifications"]["suppressed"], 0);
    // Every item names its group, and the key is the same for all five.
    let keys: std::collections::HashSet<_> = listed["items"].as_array().unwrap().iter().map(|i| i["group_key"].as_str().unwrap().to_string()).collect();
    assert_eq!(keys.len(), 1);
    assert_eq!(keys.into_iter().next().unwrap(), grouped[0]["group_key"].as_str().unwrap());
    assert!(listed["items"].as_array().unwrap().iter().all(|i| i["notifying"] == true));
}

#[test]
fn counts_cover_every_request_not_the_page() {
    let engine = Engine::new();
    shared(&engine);
    for n in 0..7 {
        at(&engine, T0 + n * 1000, "attention_send", request(&format!("k{n}"), "sender", "a"));
    }
    let page = at(&engine, T0 + 8000, "attention_list", json!({ "limit": 2 }));
    assert_eq!(page["items"].as_array().unwrap().len(), 2);
    assert_eq!(page["has_more"], true);
    assert_eq!(page["notifications"]["groups"][0]["count"], 7);
}

#[test]
fn a_pause_starts_a_new_group_and_an_old_group_stops_notifying_but_is_not_lost() {
    let engine = Engine::new();
    shared(&engine);
    for n in 0..3 {
        at(&engine, T0 + n * 1000, "attention_send", request(&format!("a{n}"), "sender", "a"));
    }
    // More than five minutes later: a second group.
    for n in 0..2 {
        at(&engine, T0 + 6 * MINUTE + n * 1000, "attention_send", request(&format!("b{n}"), "sender", "a"));
    }
    let both = groups(&engine, T0 + 7 * MINUTE);
    assert_eq!(both.iter().map(|g| g["count"].as_i64().unwrap()).collect::<Vec<_>>(), [2, 3]);
    // Sixteen minutes after the first group's last request only the second still notifies.
    let later = groups(&engine, T0 + 17 * MINUTE);
    assert_eq!(later.len(), 1);
    assert_eq!(later[0]["count"], 2);
    // Everything is still there.
    assert_eq!(at(&engine, T0 + 17 * MINUTE, "attention_list", json!({}))["items"].as_array().unwrap().len(), 5);
    // After a long quiet time nothing notifies, and nothing was dropped.
    let quiet = at(&engine, T0 + 2 * 60 * MINUTE, "attention_list", json!({}));
    assert_eq!(quiet["notifications"], json!({ "groups": [], "suppressed": 0 }));
    assert_eq!(quiet["items"].as_array().unwrap().len(), 5);
}

#[test]
fn a_chain_of_requests_each_within_the_gap_is_one_group() {
    let engine = Engine::new();
    shared(&engine);
    for n in 0..4 {
        at(&engine, T0 + n * 4 * MINUTE, "attention_send", request(&format!("k{n}"), "sender", "a"));
    }
    let listed = groups(&engine, T0 + 13 * MINUTE);
    assert_eq!(listed.len(), 1);
    assert_eq!(listed[0]["count"], 4);
}

#[test]
fn different_senders_and_different_conversations_do_not_share_a_group() {
    let engine = Engine::new();
    shared(&engine);
    at(&engine, T0, "attention_send", request("k1", "sender-one", "a"));
    at(&engine, T0 + 1, "attention_send", request("k2", "sender-two", "a"));
    at(&engine, T0 + 2, "attention_send", request("k3", "sender-one", "b"));
    let listed = groups(&engine, T0 + 1000);
    assert_eq!(listed.len(), 3);
    assert!(listed.iter().all(|g| g["count"] == 1));
}

#[test]
fn only_so_many_groups_notify_and_the_rest_are_counted_not_dropped() {
    let engine = Engine::new();
    shared(&engine);
    for n in 0..22 {
        at(&engine, T0 + n, "attention_send", request(&format!("k{n}"), &format!("sender-{n}"), "a"));
    }
    let listed = at(&engine, T0 + 1000, "attention_list", json!({}));
    assert_eq!(listed["notifications"]["groups"].as_array().unwrap().len(), 20);
    assert_eq!(listed["notifications"]["suppressed"], 2);
    // Newest groups notify first; all 22 requests are retained.
    assert_eq!(listed["notifications"]["groups"][0]["sender"]["id"], "sender-21");
    let mut cursor = Value::Null;
    let mut total = 0;
    loop {
        let page = at(&engine, T0 + 1000, "attention_list", json!({ "limit": 10, "before_id": cursor }));
        total += page["items"].as_array().unwrap().len();
        if page["has_more"] != true {
            break;
        }
        cursor = page["next_before"].clone();
    }
    assert_eq!(total, 22);
}

#[test]
fn the_notification_view_can_follow_one_session() {
    let engine = Engine::new();
    shared(&engine);
    at(&engine, T0, "attention_send", request("k1", "sender", "a"));
    at(&engine, T0 + 1, "attention_send", request("k2", "sender", "b"));
    let one = at(&engine, T0 + 1000, "attention_list", json!({ "session_hints": ["session-b"] }));
    assert_eq!(one["items"].as_array().unwrap().len(), 1);
    assert_eq!(one["notifications"]["groups"].as_array().unwrap().len(), 1);
    assert_eq!(one["notifications"]["groups"][0]["recipient_session_hint"], "session-b");
}

#[test]
fn routine_mail_and_fyis_never_notify() {
    let engine = Engine::new();
    shared(&engine);
    at(&engine, T0, "share_enable", json!({ "project": "repo", "owner": "Mukul" }));
    for n in 0..5 {
        at(&engine, T0 + n, "send", send_args(&format!("m{n}"), "routine note", "native-a"));
        at(&engine, T0 + n, "send", session_send_args(&format!("s{n}"), "FYI: done", "native-a", "sender", "repo"));
    }
    let listed = at(&engine, T0 + 1000, "attention_list", json!({}));
    assert_eq!(listed["items"], json!([]));
    assert_eq!(listed["notifications"], json!({ "groups": [], "suppressed": 0 }));
}

#[test]
fn withdrawing_or_switching_off_attention_stops_notifying_at_once_and_keeps_every_request() {
    let engine = Engine::new();
    shared(&engine);
    for n in 0..3 {
        at(&engine, T0 + n, "attention_send", request(&format!("k{n}"), "sender", "a"));
    }
    assert_eq!(groups(&engine, T0 + 1000).len(), 1);

    at(&engine, T0 + 2000, "share_attention", json!({ "project": "repo", "enabled": false }));
    let off = at(&engine, T0 + 2000, "attention_list", json!({}));
    assert_eq!(off["notifications"]["groups"], json!([]));
    assert!(off["items"].as_array().unwrap().iter().all(|i| i["admitted"] == false));
    assert_eq!(off["items"].as_array().unwrap().len(), 3);

    // Back on: the same share and scope, so the retained requests notify again while they are fresh.
    let scope = at(&engine, T0 + 3000, "share_status", json!({ "project": "repo" }))["projects"][0]["policy"]["scope"].clone();
    at(&engine, T0 + 3000, "share_attention", json!({ "project": "repo", "enabled": true, "scope": scope }));
    assert_eq!(groups(&engine, T0 + 3000).len(), 1);

    at(&engine, T0 + 4000, "share_disable", json!({ "project": "repo" }));
    assert_eq!(groups(&engine, T0 + 4000).len(), 0);
    assert_eq!(at(&engine, T0 + 4000, "attention_list", json!({}))["items"].as_array().unwrap().len(), 3);
}

#[test]
fn a_chain_that_reaches_the_edge_of_the_window_says_its_count_may_be_short() {
    let engine = Engine::new();
    shared(&engine);
    let now = T0 + 30 * 60 * MINUTE;
    let db = rusqlite::Connection::open(engine.dir.join("mailbox.sqlite3")).unwrap();
    // A chain with a request just outside the 24 h window, one inside, and the newest a minute ago.
    for (n, created) in [(0, now - 24 * 60 * MINUTE - MINUTE), (1, now - 24 * 60 * MINUTE + MINUTE), (2, now - MINUTE)] {
        seed(&db, &format!("old{n}"), "sender", created);
    }
    // A second sender's dense chain that starts three minutes before the window opens and runs to now.
    for step in 0..359 {
        seed(&db, &format!("chain{step}"), "sender2", now - 24 * 60 * MINUTE + MINUTE + step * 4 * MINUTE);
    }
    seed(&db, "before-edge", "sender2", now - 24 * 60 * MINUTE - 2 * MINUTE);
    let listed = groups(&engine, now);
    let chain = listed.iter().find(|g| g["sender"]["id"] == "sender2").expect("the long chain notifies");
    assert_eq!(chain["count_complete"], false);
    assert_eq!(chain["count"], 359);
    let short = listed.iter().find(|g| g["sender"]["id"] == "sender").unwrap();
    assert_eq!(short["count_complete"], true);
}

fn seed(db: &rusqlite::Connection, key: &str, sender: &str, created_at: i64) {
    db.execute(
        "INSERT INTO messages (id, sender, idempotency_key, payload_digest, kind, body, size, provider, native_id, checkout, session_hint, created_at, project)
         VALUES (?1, ?2, ?1, 'seed', 'attention', 'seeded', 6, 'claude-code', 'native-a', ?3, 'session-native-a', ?4, 'repo')",
        params![format!("seed-{key}-{sender}-{created_at}"), format!("session:{sender}"), recipient("native-a")["checkout"].as_str().unwrap(), created_at],
    )
    .unwrap();
}

// ---- rate bounds ----

#[test]
fn one_sender_is_limited_per_conversation_and_the_limit_expires_with_the_window() {
    let engine = Engine::new();
    shared(&engine);
    let db = rusqlite::Connection::open(engine.dir.join("mailbox.sqlite3")).unwrap();
    for n in 0..199 {
        seed(&db, &format!("n{n}"), "sender", T0 + 1 + n);
    }
    // The 200th is accepted; the 201st is refused and nothing is stored for it.
    at(&engine, T0 + 1000, "attention_send", request("last-allowed", "sender", "native-a"));
    assert_eq!(at_err(&engine, T0 + 1001, "attention_send", request("one-too-many", "sender", "native-a")), "ATTENTION_RATE_LIMITED");
    assert_eq!(db.query_row("SELECT COUNT(*) FROM messages WHERE kind = 'attention'", [], |r| r.get::<_, i64>(0)).unwrap(), 200);
    // Another sender is not affected, and a retry of an accepted request still replays.
    at(&engine, T0 + 1002, "attention_send", request("other", "someone-else", "native-a"));
    assert_eq!(at(&engine, T0 + 1003, "attention_send", request("last-allowed", "sender", "native-a"))["replayed"], true);
    // A day later the window has moved on.
    at(&engine, T0 + 25 * 60 * MINUTE, "attention_send", request("one-too-many", "sender", "native-a"));
}

#[test]
fn a_conversation_cannot_be_flooded_by_many_senders() {
    let engine = Engine::new();
    shared(&engine);
    let db = rusqlite::Connection::open(engine.dir.join("mailbox.sqlite3")).unwrap();
    for sender in 0..5 {
        for n in 0..200 {
            seed(&db, &format!("n{n}"), &format!("sender-{sender}"), T0 + 1 + n);
        }
    }
    assert_eq!(at_err(&engine, T0 + 1000, "attention_send", request("k", "sender-new", "native-a")), "ATTENTION_RATE_LIMITED");
    // A different conversation is unaffected.
    at(&engine, T0 + 1000, "attention_send", request("k", "sender-new", "b"));
}

// ---- crash: a request is stored once or not at all ----

fn killed(engine: &Engine, args: Value, point: &str) {
    let request = json!({ "protocol": "setu-links/1", "id": "t", "op": "attention_send", "args": args });
    let (reply, status, _) = engine.raw(&request.to_string(), &[("SETU_LINKS_TEST_KILL_AT", point)]);
    assert_eq!(reply, Value::Null, "{point}: a killed engine must not reply");
    assert!(!status.success(), "{point}: the engine was not killed");
}

fn stored(engine: &Engine) -> usize {
    engine.ok("attention_list", json!({}))["items"].as_array().unwrap().len()
}

#[test]
fn a_request_killed_before_commit_leaves_nothing_and_the_retry_stores_one() {
    let engine = Engine::new();
    shared(&engine);
    killed(&engine, request("k1", "sender", "a"), "attention_send:before-commit");
    assert_eq!(stored(&engine), 0);
    assert_eq!(engine.ok("attention_send", request("k1", "sender", "a"))["replayed"], false);
    assert_eq!(stored(&engine), 1);
}

#[test]
fn a_request_killed_after_commit_exists_exactly_once_and_the_retry_returns_it() {
    let engine = Engine::new();
    shared(&engine);
    killed(&engine, request("k1", "sender", "a"), "attention_send:after-commit");
    assert_eq!(stored(&engine), 1);
    let retry = engine.ok("attention_send", request("k1", "sender", "a"));
    assert_eq!(retry["replayed"], true);
    assert_eq!(retry["attention_id"], engine.ok("attention_list", json!({}))["items"][0]["attention_id"]);
    assert_eq!(stored(&engine), 1);
}

#[test]
fn a_policy_change_killed_before_commit_changes_nothing() {
    let engine = Engine::new();
    shared(&engine);
    let args = json!({ "protocol": "setu-links/1", "id": "t", "op": "share_attention", "args": { "project": "repo", "enabled": false } });
    let (reply, status, _) = engine.raw(&args.to_string(), &[("SETU_LINKS_TEST_KILL_AT", "share_attention:before-commit")]);
    assert_eq!(reply, Value::Null);
    assert!(!status.success());
    assert_eq!(engine.ok("share_status", json!({ "project": "repo" }))["projects"][0]["policy"]["attention"], true);
}

// ---- a group is one chain: its key, its count and its members agree item by item ----

fn item_keys(listed: &Value) -> Vec<(String, Option<String>, bool)> {
    listed["items"].as_array().unwrap().iter().map(|i| (i["body"].as_str().unwrap().to_string(), i["group_key"].as_str().map(str::to_string), i["notifying"].as_bool().unwrap())).collect()
}

#[test]
fn two_chains_from_one_sender_are_two_groups_with_their_own_keys_and_members() {
    let engine = Engine::new();
    shared(&engine);
    for (key, at_ms) in [("a1", 0), ("a2", 1000), ("b1", 8 * MINUTE), ("b2", 8 * MINUTE + 1000), ("b3", 8 * MINUTE + 2000)] {
        let mut args = request(key, "sender", "a");
        args["body"] = json!(key);
        at(&engine, T0 + at_ms, "attention_send", args);
    }
    let listed = at(&engine, T0 + 10 * MINUTE, "attention_list", json!({}));
    let grouped = listed["notifications"]["groups"].as_array().unwrap();
    assert_eq!(grouped.len(), 2);
    assert_ne!(grouped[0]["group_key"], grouped[1]["group_key"], "two chains share a key");
    assert_eq!((grouped[0]["count"].as_i64(), grouped[1]["count"].as_i64()), (Some(3), Some(2)));
    // Every item carries the key of its own chain, and its chain's count and members match it.
    let by_key = |key: &Value| grouped.iter().find(|g| g["group_key"] == *key).unwrap();
    for item in listed["items"].as_array().unwrap() {
        let group = by_key(&item["group_key"]);
        let body = item["body"].as_str().unwrap();
        assert_eq!(group["count"], if body.starts_with('b') { 3 } else { 2 }, "{body}");
        assert!(group["item_ids"].as_array().unwrap().contains(&item["attention_id"]), "{body}");
        assert_eq!(item["notifying"], true);
    }
}

#[test]
fn an_old_request_does_not_inherit_a_new_chains_key_or_notification() {
    let engine = Engine::new();
    shared(&engine);
    let mut old = request("old", "sender", "a");
    old["body"] = json!("old");
    at(&engine, T0, "attention_send", old);
    let later = T0 + 20 * 60 * MINUTE;
    let mut fresh = request("new", "sender", "a");
    fresh["body"] = json!("new");
    at(&engine, later, "attention_send", fresh);
    let keys = item_keys(&at(&engine, later + 1000, "attention_list", json!({})));
    let new = keys.iter().find(|k| k.0 == "new").unwrap();
    let old = keys.iter().find(|k| k.0 == "old").unwrap();
    assert!(new.1.is_some() && new.2);
    // The old request is in its own, finished chain: a key of its own, and no notification.
    assert!(old.1.is_some() && !old.2);
    assert_ne!(old.1, new.1);
    // A request outside the window is in no counted chain at all.
    let ancient = T0 + 26 * 60 * MINUTE;
    let aged = item_keys(&at(&engine, ancient, "attention_list", json!({})));
    assert!(aged.iter().all(|k| !k.2));
}

#[test]
fn a_request_beyond_the_listed_ids_of_a_long_chain_still_belongs_to_it() {
    let engine = Engine::new();
    shared(&engine);
    let now = T0 + 5 * 60 * MINUTE;
    let db = rusqlite::Connection::open(engine.dir.join("mailbox.sqlite3")).unwrap();
    // 60 requests a minute apart, ending a minute ago: one chain, longer than the 50 ids a group lists.
    for n in 0..60 {
        seed(&db, &format!("c{n}"), "sender", now - MINUTE * (60 - n));
    }
    let listed = at(&engine, now, "attention_list", json!({ "limit": 100 }));
    let grouped = listed["notifications"]["groups"].as_array().unwrap();
    assert_eq!(grouped.len(), 1);
    assert_eq!(grouped[0]["count"], 60);
    assert_eq!(grouped[0]["item_ids"].as_array().unwrap().len(), 50);
    let key = grouped[0]["group_key"].clone();
    // The ten oldest are not among the listed ids, and still carry the chain's key and its notification.
    let listed_ids: Vec<_> = grouped[0]["item_ids"].as_array().unwrap().clone();
    let outside: Vec<_> = listed["items"].as_array().unwrap().iter().filter(|i| !listed_ids.contains(&i["attention_id"])).collect();
    assert_eq!(outside.len(), 10);
    assert!(outside.iter().all(|i| i["group_key"] == key && i["notifying"] == true));
}

#[test]
fn requests_of_groups_beyond_the_notifying_cap_are_counted_but_do_not_claim_to_notify() {
    let engine = Engine::new();
    shared(&engine);
    for n in 0..22 {
        let mut args = request(&format!("k{n}"), &format!("sender-{n}"), "a");
        args["body"] = json!(format!("from {n}"));
        at(&engine, T0 + n, "attention_send", args);
    }
    let listed = at(&engine, T0 + 1000, "attention_list", json!({}));
    assert_eq!(listed["notifications"]["suppressed"], 2);
    let keys = item_keys(&listed);
    assert_eq!(keys.iter().filter(|k| k.2).count(), 20);
    // The two oldest groups are the ones not shown, and their requests are not marked as notifying.
    assert!(keys.iter().filter(|k| k.0 == "from 0" || k.0 == "from 1").all(|k| !k.2 && k.1.is_some()));
}

#[test]
fn a_reopted_in_share_may_notify_again_for_requests_still_inside_the_window_and_never_for_older_ones() {
    let engine = Engine::new();
    shared(&engine);
    for (key, at_ms) in [("old", 0), ("recent", 30 * MINUTE)] {
        let mut args = request(key, "sender", "a");
        args["body"] = json!(key);
        at(&engine, T0 + at_ms, "attention_send", args);
    }
    // The share is withdrawn and made again, and the person opts in again, 40 minutes in.
    let later = T0 + 40 * MINUTE;
    at(&engine, later, "share_disable", json!({ "project": "repo" }));
    at(&engine, later, "share_enable", json!({ "project": "repo", "owner": "Mukul" }));
    let scope = at(&engine, later, "share_status", json!({ "project": "repo" }))["projects"][0]["policy"]["scope"].clone();
    at(&engine, later, "share_attention", json!({ "project": "repo", "enabled": true, "scope": scope }));
    let keys = item_keys(&at(&engine, later, "attention_list", json!({})));
    let find = |name: &str| keys.iter().find(|k| k.0 == name).unwrap().clone();
    assert!(find("recent").2, "a request 10 minutes old may notify under the new opt-in");
    assert!(!find("old").2, "a request 40 minutes old never does");
}

#[test]
fn a_blank_request_is_refused_with_the_clock_pinned_too() {
    let engine = Engine::new();
    shared(&engine);
    let mut args = request("k1", "sender", "a");
    args["body"] = json!("   ");
    assert_eq!(at_err(&engine, T0, "attention_send", args), "ATTENTION_BODY_INVALID");
}
