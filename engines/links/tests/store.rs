mod common;
use common::*;
use rusqlite::Connection;
use serde_json::json;
use std::os::unix::fs::PermissionsExt;

fn database(engine: &Engine) -> std::path::PathBuf {
    engine.dir.join("mailbox.sqlite3")
}

#[test]
fn reads_never_create_a_store() {
    let engine = Engine::new();
    assert_eq!(engine.ok("list", json!({ "session_hint": "session-1" }))["messages"], json!([]));
    assert_eq!(engine.err("status", json!({ "message_id": "m_none" })), "MESSAGE_NOT_FOUND");
    assert_eq!(engine.err("show", json!({ "message_id": "m_none" })), "MESSAGE_NOT_FOUND");
    assert_eq!(engine.ok("health", json!({}))["store"], "absent");
    assert!(!engine.dir.exists(), "a read created {:?}", engine.dir);

    engine.ok("send", send_args("k1", "hello", "native-a"));
    let health = engine.ok("health", json!({}));
    assert_eq!(health["store"], "ready");
    assert_eq!(health["schema_version"], 4);
}

#[test]
fn the_store_is_private_to_its_owner() {
    let engine = Engine::new();
    engine.ok("send", send_args("k1", "hello", "native-a"));
    let mode = |path: &std::path::Path| std::fs::metadata(path).unwrap().permissions().mode() & 0o777;
    assert_eq!(mode(&engine.dir), 0o700);
    assert_eq!(mode(&database(&engine)), 0o600);
}

#[test]
fn a_data_directory_open_to_others_is_refused() {
    let engine = Engine::new();
    std::fs::create_dir_all(&engine.dir).unwrap();
    std::fs::set_permissions(&engine.dir, std::fs::Permissions::from_mode(0o755)).unwrap();
    assert_eq!(engine.err("send", send_args("k1", "hello", "native-a")), "DATA_DIR_NOT_PRIVATE");
    assert!(!database(&engine).exists());
}

#[test]
fn a_store_from_a_newer_version_is_refused_and_left_untouched() {
    let engine = Engine::new();
    engine.ok("send", send_args("k1", "hello", "native-a"));
    {
        let db = Connection::open(database(&engine)).unwrap();
        db.pragma_update(None, "user_version", 99).unwrap();
    }
    let before = std::fs::read(database(&engine)).unwrap();

    assert_eq!(engine.err("send", send_args("k2", "hello", "native-a")), "SCHEMA_UNSUPPORTED");
    assert_eq!(engine.err("status", json!({ "message_id": "m_any" })), "SCHEMA_UNSUPPORTED");
    assert_eq!(std::fs::read(database(&engine)).unwrap(), before);
}

#[test]
fn the_recipient_of_a_stored_message_cannot_be_altered_or_removed() {
    let engine = Engine::new();
    let id = engine.ok("send", send_args("k1", "hello", "native-a"))["message_id"].as_str().unwrap().to_string();
    // Even a claim from a replacement conversation, which holds the mail, leaves the recipient as sent.
    engine.ok("claim", json!({ "recipient": recipient("native-b") }));
    assert_eq!(engine.ok("show", json!({ "message_id": id }))["recipient"]["native_id"], "native-a");

    let db = Connection::open(database(&engine)).unwrap();
    assert!(db.execute("UPDATE messages SET native_id = 'native-b' WHERE id = ?1", [&id]).is_err());
    assert!(db.execute("UPDATE messages SET body = 'other' WHERE id = ?1", [&id]).is_err());
    assert!(db.execute("DELETE FROM messages WHERE id = ?1", [&id]).is_err());
    assert_eq!(engine.ok("show", json!({ "message_id": id }))["recipient"]["native_id"], "native-a");
}

#[test]
fn engines_started_together_on_an_empty_directory_all_succeed_with_one_store() {
    let engine = Engine::new();
    let dir = engine.dir.clone();
    let workers: Vec<_> = (0..8)
        .map(|n| {
            let dir = dir.clone();
            std::thread::spawn(move || {
                Engine::at(&dir).call("send", send_args(&format!("key-{n}"), "hello", "native-a"))
            })
        })
        .collect();
    for worker in workers {
        let reply = worker.join().unwrap();
        assert_eq!(reply["ok"], true, "{reply}");
    }
    assert_eq!(engine.ok("list", json!({ "session_hint": "session-1" }))["messages"].as_array().unwrap().len(), 8);
}
