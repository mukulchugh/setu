//! Presence and the directory: what a shared project publishes about its managed sessions is owner, task,
//! reachability and freshness, and nothing else. Reading it is passive.
mod common;
use common::*;
use serde_json::{Value, json};

fn enable(engine: &Engine, project: &str) {
    engine.ok("share_enable", json!({ "project": project, "owner": "Mukul" }));
}

fn ended(id: &str) -> Value {
    json!({ "session_id": id, "task": null, "reachability": { "state": "unreachable", "reason": "ended" } })
}

fn session(id: &str, task: Option<&str>, reachable: bool) -> Value {
    let reachability = if reachable { json!({ "state": "reachable" }) } else { json!({ "state": "unreachable", "reason": "not-running" }) };
    json!({ "session_id": id, "task": task, "reachability": reachability })
}

fn publish(engine: &Engine, project: &str, sessions: Vec<Value>) -> Value {
    engine.call("presence_publish", json!({ "project": project, "sessions": sessions }))
}

fn entries(engine: &Engine, args: Value) -> Vec<Value> {
    engine.ok("directory", args)["entries"].as_array().unwrap().clone()
}

#[test]
fn a_shared_project_lists_its_sessions_with_owner_task_reachability_and_freshness_only() {
    let engine = Engine::new();
    enable(&engine, "repo");
    assert_eq!(publish(&engine, "repo", vec![session("s1", Some("Fix the login redirect"), true), session("s2", None, false)])["result"]["published"], 2);

    let listed = entries(&engine, json!({}));
    assert_eq!(listed.len(), 2);
    let first = listed[0].as_object().unwrap();
    let mut keys: Vec<_> = first.keys().map(String::as_str).collect();
    keys.sort_unstable();
    assert_eq!(keys, ["activity_at", "observed_at", "owner", "project", "reachability", "session_id", "stale", "task", "task_at", "task_stale"]);
    assert_eq!(listed[0]["session_id"], "s1");
    assert_eq!(listed[0]["owner"], "Mukul");
    assert_eq!(listed[0]["task"], "Fix the login redirect");
    assert_eq!(listed[0]["reachability"], json!({ "state": "reachable", "reason": null }));
    assert_eq!(listed[0]["stale"], false);
    assert_eq!(listed[1]["task"], Value::Null);
    assert_eq!(listed[1]["reachability"], json!({ "state": "unreachable", "reason": "not-running" }));
}

#[test]
fn only_shared_projects_appear_and_a_project_filter_narrows_further() {
    let engine = Engine::new();
    enable(&engine, "repo");
    enable(&engine, "other");
    publish(&engine, "repo", vec![session("s1", None, true)]);
    publish(&engine, "other", vec![session("s9", None, true)]);

    assert_eq!(entries(&engine, json!({})).len(), 2);
    let only: Vec<_> = entries(&engine, json!({ "project": "repo" })).iter().map(|e| e["session_id"].as_str().unwrap().to_string()).collect();
    assert_eq!(only, ["s1"]);
    assert_eq!(entries(&engine, json!({ "project": "unshared" })).len(), 0);

    engine.ok("share_disable", json!({ "project": "repo" }));
    let rest: Vec<_> = entries(&engine, json!({})).iter().map(|e| e["session_id"].as_str().unwrap().to_string()).collect();
    assert_eq!(rest, ["s9"]);
}

#[test]
fn nothing_is_published_for_a_project_that_is_not_shared_and_nothing_is_created() {
    let engine = Engine::new();
    assert_eq!(publish(&engine, "repo", vec![session("s1", None, true)])["error"]["code"], "NOT_SHARED");
    assert!(!engine.dir.exists());
    enable(&engine, "repo");
    engine.ok("share_disable", json!({ "project": "repo" }));
    assert_eq!(publish(&engine, "repo", vec![session("s1", None, true)])["error"]["code"], "NOT_SHARED");
    assert_eq!(entries(&engine, json!({})).len(), 0);
}

#[test]
fn disabling_removes_the_presence_and_enabling_again_does_not_bring_it_back() {
    let engine = Engine::new();
    enable(&engine, "repo");
    publish(&engine, "repo", vec![session("s1", None, true)]);
    engine.ok("share_disable", json!({ "project": "repo" }));
    enable(&engine, "repo");
    assert_eq!(entries(&engine, json!({})).len(), 0);
}

#[test]
fn an_unreadable_policy_withholds_its_sessions_and_is_reported_beside_the_others() {
    let engine = Engine::new();
    enable(&engine, "repo");
    enable(&engine, "other");
    publish(&engine, "repo", vec![session("s1", None, true)]);
    publish(&engine, "other", vec![session("s9", None, true)]);
    let db = rusqlite::Connection::open(engine.dir.join("mailbox.sqlite3")).unwrap();
    db.execute("UPDATE sharing_policies SET policy = '{broken' WHERE project = 'repo'", []).unwrap();
    drop(db);

    let reply = engine.ok("directory", json!({}));
    assert_eq!(reply["entries"].as_array().unwrap().len(), 1);
    assert_eq!(reply["entries"][0]["session_id"], "s9");
    assert_eq!(reply["problems"], json!([{ "project": "repo", "code": "POLICY_INVALID", "reason": "malformed" }]));
    assert_eq!(publish(&engine, "repo", vec![session("s1", None, true)])["error"]["code"], "POLICY_INVALID");
}

#[test]
fn a_project_whose_visibility_is_off_is_not_listed_and_takes_no_presence() {
    let engine = Engine::new();
    enable(&engine, "repo");
    publish(&engine, "repo", vec![session("s1", None, true)]);
    let db = rusqlite::Connection::open(engine.dir.join("mailbox.sqlite3")).unwrap();
    db.execute("UPDATE sharing_policies SET policy = replace(policy, '\"visibility\":true', '\"visibility\":false')", []).unwrap();
    drop(db);
    assert_eq!(entries(&engine, json!({})).len(), 0);
    assert_eq!(publish(&engine, "repo", vec![session("s1", None, true)])["error"]["code"], "NOT_SHARED");
}

#[test]
fn only_the_named_public_fields_are_accepted_so_no_path_or_transcript_can_be_published() {
    let engine = Engine::new();
    enable(&engine, "repo");
    for extra in ["path", "cwd", "checkout", "env", "transcript", "provider", "native_id", "pid"] {
        let mut entry = session("s1", None, true);
        entry[extra] = json!("/Users/someone/secret");
        assert_eq!(publish(&engine, "repo", vec![entry])["error"]["code"], "FIELD_UNSUPPORTED", "{extra}");
    }
    let mut bad_reason = session("s1", None, false);
    bad_reason["reachability"]["reason"] = json!("/Users/someone/secret");
    assert_eq!(publish(&engine, "repo", vec![bad_reason])["error"]["code"], "REQUEST_INVALID");
    let mut reachable_with_reason = session("s1", None, true);
    reachable_with_reason["reachability"]["reason"] = json!("not-running");
    assert_eq!(publish(&engine, "repo", vec![reachable_with_reason])["error"]["code"], "REQUEST_INVALID");
    assert_eq!(publish(&engine, "repo", vec![session("a/b", None, true)])["error"]["code"], "REQUEST_INVALID");
    assert_eq!(publish(&engine, "repo", vec![session("s1", None, true), session("s1", None, true)])["error"]["code"], "REQUEST_INVALID");
    assert_eq!(entries(&engine, json!({})).len(), 0);
}

#[test]
fn the_stored_presence_has_no_column_that_could_hold_a_path_environment_or_provider_context() {
    let engine = Engine::new();
    enable(&engine, "repo");
    publish(&engine, "repo", vec![session("s1", Some("task"), true)]);
    let db = rusqlite::Connection::open(engine.dir.join("mailbox.sqlite3")).unwrap();
    let mut statement = db.prepare("SELECT name FROM pragma_table_info('presence') ORDER BY name").unwrap();
    let columns: Vec<String> = statement.query_map([], |row| row.get(0)).unwrap().map(Result::unwrap).collect();
    assert_eq!(columns, ["activity_at", "observed_at", "project", "reach_reason", "reach_state", "session_id", "task", "task_at"]);
}

#[test]
fn a_task_is_one_bounded_printable_line() {
    let engine = Engine::new();
    enable(&engine, "repo");
    let noisy = format!("line one\n\u{1b}[31mred\u{1b}[0m   {}", "x".repeat(400));
    publish(&engine, "repo", vec![session("s1", Some(&noisy), true)]);
    let task = entries(&engine, json!({}))[0]["task"].as_str().unwrap().to_string();
    assert!(task.chars().count() <= 120, "{task}");
    assert!(!task.chars().any(char::is_control), "{task:?}");
    assert!(task.starts_with("line one [31mred"), "{task:?}");
    assert_eq!(publish(&engine, "repo", vec![session("s2", Some(&"x".repeat(5000)), true)])["error"]["code"], "FIELD_TOO_LARGE");
}

#[test]
fn publishing_again_replaces_a_session_and_leaves_unlisted_sessions_as_they_were() {
    let engine = Engine::new();
    enable(&engine, "repo");
    publish(&engine, "repo", vec![session("s1", Some("old"), true), session("s2", Some("keep"), true)]);
    publish(&engine, "repo", vec![session("s1", Some("new"), false)]);
    let listed = entries(&engine, json!({}));
    assert_eq!((listed[0]["task"].as_str(), listed[0]["reachability"]["state"].as_str()), (Some("new"), Some("unreachable")));
    assert_eq!(listed[1]["task"], "keep");
}

#[test]
fn reading_the_directory_creates_nothing_and_writes_nothing() {
    let engine = Engine::new();
    assert_eq!(engine.ok("directory", json!({})), json!({ "entries": [], "problems": [], "stale_after_ms": 120_000 }));
    assert!(!engine.dir.exists());
    enable(&engine, "repo");
    publish(&engine, "repo", vec![session("s1", None, true)]);
    let before = std::fs::read(engine.dir.join("mailbox.sqlite3")).unwrap();
    entries(&engine, json!({}));
    engine.ok("share_status", json!({}));
    assert_eq!(std::fs::read(engine.dir.join("mailbox.sqlite3")).unwrap(), before);
}

// ---- the free text a project publishes never carries a path, an environment reference or a secret ----

const UNSAFE_TASKS: [&str; 12] = [
    "Fix /Users/example/private/src/auth.js using $HOME/.ssh token=synthetic-secret",
    "edit ~/work/notes.md",
    "see ../../etc/hosts",
    "open C:\\Users\\someone\\secret.txt",
    "touch src/auth.js",
    "read https://example.com/internal/doc",
    "run with API_URL=http://localhost:3000",
    "use ${HOME} and $USER",
    "set %APPDATA% first",
    "key sk-synthetic-0123456789abcdef",
    "Authorization: Bearer synthetic-bearer-value",
    "ghp_abcdefghijklmnopqrstuvwxyz0123456789",
];

fn stored_text(engine: &Engine) -> String {
    let db = rusqlite::Connection::open(engine.dir.join("mailbox.sqlite3")).unwrap();
    let mut statement = db.prepare("SELECT COALESCE(task, '') FROM presence").unwrap();
    statement.query_map([], |row| row.get::<_, String>(0)).unwrap().map(Result::unwrap).collect::<Vec<_>>().join("\n")
}

#[test]
fn an_unsafe_task_is_never_stored_or_listed_even_when_published_directly() {
    let engine = Engine::new();
    enable(&engine, "repo");
    for (n, task) in UNSAFE_TASKS.iter().enumerate() {
        let id = format!("s{n}");
        assert_eq!(publish(&engine, "repo", vec![session(&id, Some(task), true)])["ok"], true, "{task}");
    }
    let listed = entries(&engine, json!({}));
    assert_eq!(listed.len(), UNSAFE_TASKS.len());
    for entry in &listed {
        assert_eq!(entry["task"], Value::Null, "{entry}");
        assert_eq!(entry["task_at"], Value::Null, "{entry}");
    }
    let stored = stored_text(&engine);
    for secret in ["/Users/example", "$HOME", "synthetic-secret", "~/work", "etc/hosts", "secret.txt", "src/auth.js", "example.com", "API_URL", "APPDATA", "sk-synthetic", "synthetic-bearer", "ghp_"] {
        assert!(!stored.contains(secret), "stored presence holds {secret:?}: {stored}");
    }
}

#[test]
fn ordinary_labels_and_already_redacted_ones_are_kept() {
    let engine = Engine::new();
    enable(&engine, "repo");
    let kept = [
        "Fix the login redirect",
        "Review CI/CD and/or deploy notes",
        "Fix [path] using [env] token=[REDACTED]",
        "Write the v2 migration (part 1/2)",
    ];
    for (n, task) in kept.iter().enumerate() {
        publish(&engine, "repo", vec![session(&format!("s{n}"), Some(task), true)]);
    }
    let listed: Vec<_> = entries(&engine, json!({})).iter().map(|e| e["task"].as_str().unwrap().to_string()).collect();
    assert_eq!(listed, kept);
}

#[test]
fn an_unsafe_owner_is_refused_when_sharing_is_enabled_and_nothing_is_stored() {
    let engine = Engine::new();
    for owner in ["/Users/someone", "me@$HOME", "token=abc", "sk-synthetic-0123456789abcdef", "~/me", "a/b/c"] {
        assert_eq!(engine.err("share_enable", json!({ "project": "repo", "owner": owner })), "REQUEST_INVALID", "{owner}");
    }
    assert!(!engine.dir.exists());
    for owner in ["mukul.chugh", "O'Brien", "Team A", "Mukul (work)"] {
        engine.ok("share_enable", json!({ "project": "repo", "owner": owner }));
    }
}

// ---- ended sessions are observed as ended, immediately and for good ----

#[test]
fn a_session_that_ends_is_listed_unreachable_as_ended_at_once() {
    let engine = Engine::new();
    enable(&engine, "repo");
    publish(&engine, "repo", vec![session("s1", Some("task"), true)]);
    assert_eq!(entries(&engine, json!({}))[0]["reachability"]["state"], "reachable");

    publish(&engine, "repo", vec![ended("s1")]);
    let listed = entries(&engine, json!({}));
    assert_eq!(listed.len(), 1);
    assert_eq!(listed[0]["reachability"], json!({ "state": "unreachable", "reason": "ended" }));
    assert_eq!(listed[0]["stale"], false);
}

#[test]
fn an_ended_session_cannot_be_made_reachable_again_by_a_delayed_report() {
    let engine = Engine::new();
    enable(&engine, "repo");
    publish(&engine, "repo", vec![session("s1", Some("task"), true)]);
    publish(&engine, "repo", vec![ended("s1")]);
    let before = entries(&engine, json!({}))[0].clone();

    // A round that listed the session before it ended and published after: neither its reachability nor
    // its task replaces the end.
    publish(&engine, "repo", vec![session("s1", Some("late task"), true)]);
    let after = entries(&engine, json!({}))[0].clone();
    assert_eq!(after, before);
    assert_eq!(after["reachability"], json!({ "state": "unreachable", "reason": "ended" }));
    // Other sessions of the project are not held back by it.
    publish(&engine, "repo", vec![session("s2", None, true)]);
    assert_eq!(entries(&engine, json!({})).len(), 2);
}

#[test]
fn an_ended_observation_is_not_refreshed_by_later_rounds() {
    let engine = Engine::new();
    enable(&engine, "repo");
    publish(&engine, "repo", vec![ended("s1")]);
    let first = entries(&engine, json!({}))[0]["observed_at"].as_i64().unwrap();
    std::thread::sleep(std::time::Duration::from_millis(20));
    publish(&engine, "repo", vec![ended("s1")]);
    assert_eq!(entries(&engine, json!({}))[0]["observed_at"].as_i64().unwrap(), first);
}

#[cfg(feature = "test-hooks")]
mod freshness {
    use super::*;

    const AT: &str = "SETU_LINKS_TEST_NOW_MS";

    fn at(engine: &Engine, op: &str, args: Value, now: i64) -> Value {
        engine.call_env(op, args, &[(AT, &now.to_string())])
    }

    #[test]
    fn an_old_observation_stays_listed_marked_stale_and_never_shows_as_reachable() {
        let engine = Engine::new();
        let t0 = 1_760_000_000_000i64;
        at(&engine, "share_enable", json!({ "project": "repo", "owner": "Mukul" }), t0);
        at(&engine, "presence_publish", json!({ "project": "repo", "sessions": [session("s1", Some("task"), true)] }), t0);

        let fresh = at(&engine, "directory", json!({}), t0 + 120_000)["result"]["entries"][0].clone();
        assert_eq!((fresh["stale"].clone(), fresh["observed_at"].clone()), (json!(false), json!(t0)));
        assert_eq!(fresh["reachability"]["state"], "reachable");

        let stale = at(&engine, "directory", json!({}), t0 + 120_001)["result"]["entries"][0].clone();
        assert_eq!(stale["stale"], true);
        assert_eq!(stale["session_id"], "s1");
        assert_eq!(stale["task"], "task");
        assert_eq!(stale["observed_at"], t0);
        assert_eq!(stale["reachability"], json!({ "state": "unknown", "reason": "stale" }));

        // Publishing again makes it live again.
        at(&engine, "presence_publish", json!({ "project": "repo", "sessions": [session("s1", Some("task"), true)] }), t0 + 500_000);
        let live = at(&engine, "directory", json!({}), t0 + 500_001)["result"]["entries"][0].clone();
        assert_eq!((live["stale"].clone(), live["reachability"]["state"].clone()), (json!(false), json!("reachable")));
    }

    #[test]
    fn an_observation_older_than_a_week_is_pruned_by_the_next_publish() {
        let engine = Engine::new();
        let t0 = 1_760_000_000_000i64;
        at(&engine, "share_enable", json!({ "project": "repo", "owner": "Mukul" }), t0);
        at(&engine, "presence_publish", json!({ "project": "repo", "sessions": [session("gone", None, true)] }), t0);
        let later = t0 + 7 * 24 * 60 * 60 * 1000 + 1;
        assert_eq!(at(&engine, "directory", json!({}), later)["result"]["entries"][0]["stale"], true);
        at(&engine, "presence_publish", json!({ "project": "repo", "sessions": [session("s2", None, true)] }), later);
        let ids: Vec<_> = at(&engine, "directory", json!({}), later)["result"]["entries"].as_array().unwrap().iter().map(|e| e["session_id"].as_str().unwrap().to_string()).collect();
        assert_eq!(ids, ["s2"]);
    }

    #[test]
    fn an_ended_session_stays_ended_when_its_observation_ages_and_a_missing_one_reads_unknown() {
        let engine = Engine::new();
        let t0 = 1_760_000_000_000i64;
        at(&engine, "share_enable", json!({ "project": "repo", "owner": "Mukul" }), t0);
        at(&engine, "presence_publish", json!({ "project": "repo", "sessions": [ended("done"), session("gone", None, true)] }), t0);
        let listed = at(&engine, "directory", json!({}), t0 + 600_000)["result"]["entries"].clone();
        let by_id = |id: &str| listed.as_array().unwrap().iter().find(|e| e["session_id"] == id).unwrap().clone();
        assert_eq!(by_id("done")["reachability"], json!({ "state": "unreachable", "reason": "ended" }));
        assert_eq!(by_id("done")["stale"], true);
        assert_eq!(by_id("gone")["reachability"], json!({ "state": "unknown", "reason": "stale" }));
    }

    #[test]
    fn task_and_activity_times_are_what_the_service_observed_not_the_polling_time() {
        let engine = Engine::new();
        let t0 = 1_760_000_000_000i64;
        at(&engine, "share_enable", json!({ "project": "repo", "owner": "Mukul" }), t0);
        let mut entry = session("s1", Some("Fix the login redirect"), true);
        entry["task_at"] = json!(t0 - 3 * 60 * 60 * 1000);
        entry["activity_at"] = json!(t0 - 40_000);
        assert_eq!(at(&engine, "presence_publish", json!({ "project": "repo", "sessions": [entry] }), t0)["ok"], true);
        let listed = at(&engine, "directory", json!({}), t0 + 1_000)["result"]["entries"][0].clone();
        assert_eq!(listed["observed_at"], t0);
        assert_eq!(listed["task_at"], t0 - 3 * 60 * 60 * 1000);
        assert_eq!(listed["task_stale"], true);
        assert_eq!(listed["activity_at"], t0 - 40_000);
        assert_eq!(listed["task"], "Fix the login redirect");

        // A session with no claim and no hook has neither time: unknown, never the polling time.
        at(&engine, "presence_publish", json!({ "project": "repo", "sessions": [session("s2", None, true)] }), t0);
        let listed = at(&engine, "directory", json!({}), t0)["result"]["entries"].clone();
        let s2 = listed.as_array().unwrap().iter().find(|e| e["session_id"] == "s2").unwrap();
        assert_eq!((s2["task_at"].clone(), s2["task_stale"].clone(), s2["activity_at"].clone()), (Value::Null, json!(false), Value::Null));

        // A time from the future, or a task time with no task, is not accepted.
        let mut future = session("s3", Some("x"), true);
        future["task_at"] = json!(t0 + 3_600_000);
        assert_eq!(at(&engine, "presence_publish", json!({ "project": "repo", "sessions": [future] }), t0)["error"]["code"], "REQUEST_INVALID");
        let mut orphan = session("s4", None, true);
        orphan["task_at"] = json!(t0);
        assert_eq!(at(&engine, "presence_publish", json!({ "project": "repo", "sessions": [orphan] }), t0)["error"]["code"], "REQUEST_INVALID");
        let mut negative = session("s5", None, true);
        negative["activity_at"] = json!(-1);
        assert_eq!(at(&engine, "presence_publish", json!({ "project": "repo", "sessions": [negative] }), t0)["error"]["code"], "REQUEST_INVALID");
    }
}
