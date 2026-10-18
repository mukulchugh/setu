//! There is one mailbox store per engine, and the transport owns no message state of its own.
mod common;
use common::*;
use serde_json::json;

fn databases(dir: &std::path::Path) -> Vec<String> {
    let mut found: Vec<String> = std::fs::read_dir(dir)
        .unwrap()
        .filter_map(|entry| entry.ok())
        .map(|entry| entry.file_name().to_string_lossy().to_string())
        .filter(|name| name.contains(".sqlite"))
        .filter(|name| !name.ends_with("-wal") && !name.ends_with("-shm"))
        .collect();
    found.sort();
    found
}

#[test]
fn after_a_full_exchange_each_engine_still_has_exactly_one_database_and_only_messages_hold_bodies() {
    let pair = Pair::new();
    pair.authorize(&pair.a, &pair.a_id, &pair.b, &pair.b_id, "project-1");
    pair.wait_published(&pair.a, &pair.b_id);
    let id = pair.send(&pair.a, &pair.b_id, "k1", "a body that must live in one table only")["message_id"].as_str().unwrap().to_string();
    wait_until("the deposit", || pair.a.ok("status", json!({ "message_id": id }))["transport"]["outbox"] == "deposited");

    for engine in [&pair.a, &pair.b] {
        assert_eq!(databases(&engine.dir), vec!["mailbox.sqlite3".to_string()]);
        let db = rusqlite::Connection::open_with_flags(engine.dir.join("mailbox.sqlite3"), rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY).unwrap();
        let tables: Vec<String> = db
            .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
            .unwrap()
            .query_map([], |row| row.get(0))
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap();
        let with_text: Vec<&String> = tables
            .iter()
            .filter(|table| {
                db.prepare(&format!("PRAGMA table_info({table})"))
                    .unwrap()
                    .query_map([], |row| row.get::<_, String>(1))
                    .unwrap()
                    .any(|column| matches!(column.as_deref(), Ok("body" | "msg" | "payload")))
            })
            .collect();
        assert_eq!(with_text, vec![&"messages".to_string()], "a second place holds message text");
        // The body exists once per engine: in no other table, however it was moved.
        let copies: i64 = db.query_row("SELECT COUNT(*) FROM messages WHERE body LIKE '%one table only%'", [], |row| row.get(0)).unwrap();
        assert_eq!(copies, 1);
    }
}

#[test]
fn the_daemon_keeps_only_its_key_lock_and_status_files_beside_the_database() {
    let engine = Engine::new();
    let _daemon = engine.start();
    let mut files: Vec<String> = std::fs::read_dir(&engine.dir).unwrap().filter_map(|e| e.ok()).map(|e| e.file_name().to_string_lossy().to_string()).collect();
    files.retain(|name| !name.starts_with("mailbox.sqlite3"));
    files.sort();
    assert_eq!(files, vec!["serve.json", "serve.lock", "transport.key"]);
}
