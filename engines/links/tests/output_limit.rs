// What one provider turn can carry. Claude documents that plain hook stdout is capped at 10000 characters
// and that overflow is replaced by a file path and a short preview. A message whose tail would not reach the
// agent's context must therefore never be claimed, and never read `handed-off`. These tests pin the exact
// bounds through the real binary: whole messages only, no truncation, nothing claimed that does not fit.
mod common;
use common::*;
use rusqlite::{Connection, params};
use serde_json::{Value, json};

const FRAME_LIMIT: usize = 10_000;
const BODY_LIMIT: usize = 8 * 1024;

fn claim(engine: &Engine) -> Value {
    engine.ok("claim", json!({ "recipient": recipient("native-a") }))
}

fn text(claimed: &Value) -> &str {
    claimed["text"].as_str().unwrap()
}

fn send(engine: &Engine, key: &str, body: &str) -> String {
    engine.ok("send", send_args(key, body, "native-a"))["message_id"].as_str().unwrap().to_string()
}

/// The framing around one message and around the whole turn, measured through the real engine so the
/// tests below do not restate the format.
struct Overhead {
    turn: usize,
    frame: usize,
}

fn measure() -> Overhead {
    let one = Engine::new();
    send(&one, "a", "x");
    let single = text(&claim(&one)).len();
    let two = Engine::new();
    send(&two, "a", "x");
    send(&two, "b", "x");
    let double = text(&claim(&two)).len();
    // The second message adds one frame and one body byte.
    let frame = double - single - 1;
    Overhead { frame, turn: single - frame - 1 }
}

#[test]
fn the_limits_are_the_documented_provider_cap_and_a_body_that_always_fits_in_it() {
    assert_eq!(setu_links::frame::MAX_FRAME_BYTES, FRAME_LIMIT);
    assert_eq!(setu_links::mailbox::MAX_BODY_BYTES, BODY_LIMIT);
}

#[test]
fn a_body_at_the_cap_is_accepted_whole_and_one_byte_more_is_refused_before_anything_is_stored() {
    let engine = Engine::new();
    let id = send(&engine, "at-cap", &"a".repeat(BODY_LIMIT));
    assert_eq!(engine.err("send", send_args("over", &"a".repeat(BODY_LIMIT + 1), "native-a")), "BODY_TOO_LARGE");
    assert_eq!(engine.ok("list", json!({ "session_hint": "session-1" }))["messages"].as_array().unwrap().len(), 1);

    let claimed = claim(&engine);
    assert_eq!(claimed["messages"][0]["message_id"], id);
    assert_eq!(claimed["messages"][0]["body"].as_str().unwrap().len(), BODY_LIMIT);
    assert!(text(&claimed).contains(&"a".repeat(BODY_LIMIT)), "the whole body reaches the text");
    assert!(text(&claimed).len() <= FRAME_LIMIT);
}

#[test]
fn the_body_cap_counts_utf8_bytes_not_characters() {
    let engine = Engine::new();
    // U+20AC is three bytes: 2730 of them are 8190 bytes, 2731 are 8193.
    let fits = "\u{20AC}".repeat(2730);
    let id = send(&engine, "euro", &fits);
    assert_eq!(engine.err("send", send_args("euro-over", &"\u{20AC}".repeat(2731), "native-a")), "BODY_TOO_LARGE");
    let claimed = claim(&engine);
    assert_eq!(claimed["messages"][0]["message_id"], id);
    assert!(text(&claimed).contains(&fits));
    assert!(text(&claimed).len() <= FRAME_LIMIT, "{} bytes", text(&claimed).len());
}

#[test]
fn the_worst_case_metadata_with_the_largest_body_still_fits_one_turn_whole() {
    let engine = Engine::new();
    let mut args = send_args("worst", &"b".repeat(BODY_LIMIT), "native-a");
    // Every character of a reply target expands six-fold when escaped.
    args["reply_to"] = json!("\"".repeat(128));
    engine.ok("send", args);
    let claimed = claim(&engine);
    assert_eq!(claimed["messages"].as_array().unwrap().len(), 1);
    assert!(text(&claimed).contains(&"&quot;".repeat(128)));
    assert!(text(&claimed).contains(&"b".repeat(BODY_LIMIT)));
    assert!(text(&claimed).len() <= FRAME_LIMIT, "{} bytes", text(&claimed).len());
}

#[test]
fn a_turn_carries_whole_messages_up_to_the_frame_limit_and_the_next_waits_untouched() {
    let Overhead { turn, frame } = measure();
    // Two messages exactly fill the limit: one at the body cap, one sized to land on the last byte.
    let first = BODY_LIMIT;
    let second = FRAME_LIMIT - turn - 2 * frame - first;
    let engine = Engine::new();
    let a = send(&engine, "a", &"a".repeat(first));
    let b = send(&engine, "b", &"b".repeat(second));
    let c = send(&engine, "c", "c");
    let claimed = claim(&engine);
    assert_eq!(text(&claimed).len(), FRAME_LIMIT, "the batch lands exactly on the limit");
    let ids: Vec<_> = claimed["messages"].as_array().unwrap().iter().map(|m| m["message_id"].clone()).collect();
    assert_eq!(ids, vec![json!(a), json!(b)]);
    // The third did not fit, so it was not claimed: still queued, no attempt, not held.
    let waiting = engine.ok("status", json!({ "message_id": c }));
    assert_eq!((waiting["state"].as_str(), waiting["attempts"].as_i64()), (Some("queued"), Some(0)));
    assert_eq!(claim(&engine)["messages"][0]["message_id"], c);

    // One byte more and the second no longer fits beside the first.
    let engine = Engine::new();
    send(&engine, "a", &"a".repeat(first));
    let b = send(&engine, "b", &"b".repeat(second + 1));
    let claimed = claim(&engine);
    assert_eq!(claimed["messages"].as_array().unwrap().len(), 1);
    assert!(text(&claimed).len() <= FRAME_LIMIT);
    assert_eq!(engine.ok("status", json!({ "message_id": b }))["state"], "queued");
}

#[test]
fn many_multibyte_messages_never_overflow_a_turn_and_none_is_cut() {
    let engine = Engine::new();
    let body = "\u{00E9}\u{4E16}\u{1F600}".repeat(400); // 2 + 3 + 4 bytes per repeat
    for n in 0..8 {
        send(&engine, &format!("k{n}"), &format!("{n}{body}"));
    }
    let mut seen = 0;
    for _ in 0..8 {
        let claimed = claim(&engine);
        let messages = claimed["messages"].as_array().unwrap();
        if messages.is_empty() {
            break;
        }
        assert!(text(&claimed).len() <= FRAME_LIMIT, "{} bytes", text(&claimed).len());
        for message in messages {
            // The entire body is in the text, ending where it ended.
            assert!(text(&claimed).contains(message["body"].as_str().unwrap()));
        }
        seen += messages.len();
    }
    assert_eq!(seen, 8, "every message is delivered whole over successive turns");
}

// ---- Mail stored before the cap existed ----

/// A queued message the earlier 16 KiB rule accepted, inserted as that engine would have stored it.
fn legacy_row(engine: &Engine, id: &str, body_bytes: usize) {
    let db = Connection::open(engine.dir.join("mailbox.sqlite3")).unwrap();
    db.execute(
        "INSERT INTO messages (id, sender, idempotency_key, payload_digest, kind, body, size, provider, native_id, checkout, session_hint, created_at)
         VALUES (?1, 'user', ?1, 'digest', 'message', ?2, ?3, 'claude-code', 'native-a', ?4, 'session-1', 1)",
        params![id, "L".repeat(body_bytes), body_bytes as i64, recipient("native-a")["checkout"].as_str().unwrap()],
    )
    .unwrap();
    db.execute("INSERT INTO deliveries (message_id, state, expires_at, updated_at) VALUES (?1, 'queued', 4102444800000, 1)", [id]).unwrap();
}

#[test]
fn an_older_oversized_message_is_held_with_its_reason_readable_in_full_and_never_claimed() {
    let engine = Engine::new();
    let fresh = send(&engine, "fresh", "short enough");
    legacy_row(&engine, "m_legacy_big", 14 * 1024);
    legacy_row(&engine, "m_legacy_mid", BODY_LIMIT + 1);

    // A plain read already says so, without any claim.
    for id in ["m_legacy_big", "m_legacy_mid"] {
        let status = engine.ok("status", json!({ "message_id": id }));
        assert_eq!((status["state"].as_str(), status["reason"].as_str()), (Some("held"), Some("provider-output-limit")), "{id}");
        assert_eq!(status["stored_state"], "queued", "{id}: the store itself has not changed yet");
    }

    // The claim delivers what fits and neither claims nor attempts the old rows.
    let claimed = claim(&engine);
    let ids: Vec<_> = claimed["messages"].as_array().unwrap().iter().map(|m| m["message_id"].clone()).collect();
    assert_eq!(ids, vec![json!(fresh)]);
    assert!(!text(&claimed).contains("LLLLL"), "no byte of an old oversized body reaches the text");
    for id in ["m_legacy_big", "m_legacy_mid"] {
        let status = engine.ok("status", json!({ "message_id": id }));
        assert_eq!((status["state"].as_str(), status["reason"].as_str()), (Some("held"), Some("provider-output-limit")), "{id}");
        assert_eq!(status["stored_state"], "held", "{id}");
        assert_eq!(status["attempts"], 0, "{id}: nothing was attempted");
        assert!(status["attempt_id"].is_null(), "{id}");
    }
    let db = Connection::open(engine.dir.join("mailbox.sqlite3")).unwrap();
    let attempts: i64 = db.query_row("SELECT COUNT(*) FROM attempt_messages WHERE message_id LIKE 'm_legacy%'", [], |row| row.get(0)).unwrap();
    assert_eq!(attempts, 0, "no attempt may reference an old oversized row");

    // The sender can still read all of it, and cancel it, and send something shorter instead.
    let shown = engine.ok("show", json!({ "message_id": "m_legacy_big" }));
    assert_eq!(shown["body"].as_str().unwrap().len(), 14 * 1024);
    let listed = engine.ok("list", json!({ "session_hint": "session-1" }));
    assert_eq!(listed["messages"].as_array().unwrap().len(), 3);
    assert_eq!(engine.ok("cancel", json!({ "message_id": "m_legacy_mid", "sender": { "kind": "user" } }))["state"], "cancelled");
    send(&engine, "shorter", "the short version");
}

#[test]
fn nothing_that_restores_held_mail_releases_an_output_limit_hold() {
    let engine = Engine::new();
    send(&engine, "fresh", "hello");
    legacy_row(&engine, "m_legacy_big", 12 * 1024);
    claim(&engine);
    for _ in 0..2 {
        // The exact conversation is reported again, and a resume names the old locator.
        engine.ok("reconcile", json!({ "recipient": recipient("native-a") }));
        let mut moved = recipient("native-a");
        moved["session_hint"] = json!("session-2");
        engine.ok("resume", json!({ "recipient": moved, "from": ["session-1"] }));
    }
    let observed = engine.ok("status", json!({ "message_id": "m_legacy_big", "observed": recipient("native-a") }));
    assert_eq!((observed["state"].as_str(), observed["reason"].as_str()), (Some("held"), Some("provider-output-limit")));
    assert_eq!(engine.ok("status", json!({ "message_id": "m_legacy_big" }))["stored_state"], "held");
    assert_eq!(claim(&engine)["messages"], json!([]));
}

#[test]
fn an_old_row_far_beyond_any_frame_is_held_too() {
    // Far beyond any frame: held like the other old rows, and it does not block the mail that fits.
    let engine = Engine::new();
    send(&engine, "fresh", "hello");
    legacy_row(&engine, "m_legacy_huge", 60 * 1024);
    let claimed = claim(&engine);
    assert_eq!(claimed["messages"].as_array().unwrap().len(), 1);
    assert_eq!(engine.ok("status", json!({ "message_id": "m_legacy_huge" }))["reason"], "provider-output-limit");
}
