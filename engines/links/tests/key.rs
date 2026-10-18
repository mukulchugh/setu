//! The transport key: created once, whole or not at all, never regenerated behind the owner's back, and an
//! unusable one is refused promptly with a way out instead of hanging the engine.
mod common;
use common::*;
use serde_json::{Value, json};
use std::os::unix::fs::{PermissionsExt, symlink};
use std::time::{Duration, Instant};

fn private_dir(engine: &Engine) {
    std::fs::create_dir_all(&engine.dir).unwrap();
    std::fs::set_permissions(&engine.dir, std::fs::Permissions::from_mode(0o700)).unwrap();
}

fn key_path(engine: &Engine) -> std::path::PathBuf {
    engine.dir.join("transport.key")
}

fn write_key(engine: &Engine, bytes: &[u8], mode: u32) {
    private_dir(engine);
    std::fs::write(key_path(engine), bytes).unwrap();
    std::fs::set_permissions(key_path(engine), std::fs::Permissions::from_mode(mode)).unwrap();
}

fn public_of(bytes: &[u8; 32]) -> String {
    iroh::SecretKey::from_bytes(bytes).public().to_string()
}

#[test]
fn a_valid_existing_key_is_used_as_it_is_and_never_rewritten() {
    let engine = Engine::new();
    let bytes = [7u8; 32];
    write_key(&engine, &bytes, 0o600);
    assert_eq!(engine.ok("identity", json!({}))["peer_id"], public_of(&bytes));
    assert_eq!(std::fs::read(key_path(&engine)).unwrap(), bytes);
}

#[test]
fn concurrent_first_callers_all_get_the_same_identity_and_one_complete_private_key() {
    let engine = Engine::new();
    let ids: Vec<String> = std::thread::scope(|scope| {
        (0..8)
            .map(|_| scope.spawn(|| engine.ok("identity", json!({}))["peer_id"].as_str().unwrap().to_string()))
            .collect::<Vec<_>>()
            .into_iter()
            .map(|handle| handle.join().unwrap())
            .collect()
    });
    assert!(ids.iter().all(|id| *id == ids[0]), "{ids:?}");
    let meta = std::fs::metadata(key_path(&engine)).unwrap();
    assert_eq!((meta.len(), meta.permissions().mode() & 0o777), (32, 0o600));
    let stray: Vec<_> = std::fs::read_dir(&engine.dir).unwrap().filter_map(|e| e.ok()).filter(|e| e.file_name().to_string_lossy().contains("tmp")).collect();
    assert!(stray.is_empty(), "creation left temporary files behind: {stray:?}");
}

/// Every unusable key is refused at once with a stable code and a way out, and is left exactly as it was.
fn refused(engine: &Engine, what: &str) {
    let started = Instant::now();
    let reply = engine.call("identity", json!({}));
    assert!(started.elapsed() < Duration::from_secs(5), "{what}: not prompt");
    assert_eq!(reply["ok"], false, "{what}: {reply}");
    assert_eq!(reply["error"]["code"], "TRANSPORT_KEY_INVALID", "{what}");
    let message = reply["error"]["message"].as_str().unwrap();
    assert!(message.contains("transport.key") && message.contains("move"), "{what}: no recovery in {message:?}");
    assert_eq!(reply["error"]["retryable"], false);
}

#[test]
fn an_empty_short_or_overlong_key_is_refused_promptly_and_never_regenerated() {
    for (what, bytes) in [("empty", vec![]), ("short", vec![1u8; 31]), ("overlong", vec![1u8; 33])] {
        let engine = Engine::new();
        write_key(&engine, &bytes, 0o600);
        refused(&engine, what);
        assert_eq!(std::fs::read(key_path(&engine)).unwrap(), bytes, "{what}: the file was touched");
    }
}

#[test]
fn a_key_other_users_could_read_is_refused() {
    for mode in [0o640, 0o644, 0o604, 0o700] {
        let engine = Engine::new();
        write_key(&engine, &[3u8; 32], mode);
        refused(&engine, &format!("mode {mode:o}"));
        assert_eq!(std::fs::metadata(key_path(&engine)).unwrap().permissions().mode() & 0o777, mode);
    }
}

#[test]
fn a_symlink_or_a_directory_in_the_keys_place_is_refused() {
    let engine = Engine::new();
    write_key(&engine, &[3u8; 32], 0o600);
    let real = engine.dir.join("elsewhere.key");
    std::fs::rename(key_path(&engine), &real).unwrap();
    symlink(&real, key_path(&engine)).unwrap();
    refused(&engine, "symlink");
    assert!(std::fs::symlink_metadata(key_path(&engine)).unwrap().file_type().is_symlink());

    let engine = Engine::new();
    private_dir(&engine);
    std::fs::create_dir(key_path(&engine)).unwrap();
    refused(&engine, "directory");
}

#[test]
fn serve_refuses_an_unusable_key_instead_of_hanging_and_starts_nothing() {
    let engine = Engine::new();
    write_key(&engine, &[1u8; 31], 0o600);
    let mut daemon = engine.serve(&[]);
    let started = Instant::now();
    let status = daemon.child.wait().unwrap();
    assert!(started.elapsed() < Duration::from_secs(5));
    assert!(status.success(), "serve reports the refusal in its reply and exits 0");
    let mut out = String::new();
    std::io::Read::read_to_string(&mut daemon.child.stdout.take().unwrap(), &mut out).unwrap();
    let reply: Value = serde_json::from_str(out.trim()).unwrap();
    assert_eq!(reply["error"]["code"], "TRANSPORT_KEY_INVALID");
    assert!(!engine.dir.join("serve.lock").exists() && !engine.dir.join("serve.json").exists());
    assert_eq!(engine.ok("transport_status", json!({}))["running"], false);
}

#[cfg(feature = "test-hooks")]
mod crash {
    use super::*;

    fn killed_at(engine: &Engine, point: &str) {
        let request = json!({ "protocol": "setu-links/1", "id": "t", "op": "identity", "args": {} });
        let (reply, status, _) = engine.raw(&request.to_string(), &[("SETU_LINKS_TEST_KILL_AT", point)]);
        assert_eq!(reply, Value::Null);
        assert!(!status.success(), "{point}: not killed");
    }

    #[test]
    fn killed_before_the_key_is_published_leaves_no_key_and_the_next_call_makes_one() {
        let engine = Engine::new();
        killed_at(&engine, "key:before-publish");
        assert!(!key_path(&engine).exists(), "a partial or complete key was published");
        let first = engine.ok("identity", json!({}))["peer_id"].clone();
        assert_eq!(std::fs::metadata(key_path(&engine)).unwrap().len(), 32);
        assert_eq!(engine.ok("identity", json!({}))["peer_id"], first);
    }

    #[test]
    fn killed_after_the_key_is_published_leaves_one_complete_key_that_is_kept() {
        let engine = Engine::new();
        killed_at(&engine, "key:after-publish");
        let bytes = std::fs::read(key_path(&engine)).unwrap();
        assert_eq!(bytes.len(), 32);
        let id = engine.ok("identity", json!({}))["peer_id"].clone();
        assert_eq!(id, public_of(&bytes.clone().try_into().unwrap()));
        assert_eq!(std::fs::read(key_path(&engine)).unwrap(), bytes);
    }

    fn names_of_the_key(engine: &Engine) -> Vec<String> {
        let mut found: Vec<String> = std::fs::read_dir(&engine.dir).unwrap().filter_map(|e| e.ok()).map(|e| e.file_name().to_string_lossy().to_string()).filter(|n| n.starts_with("transport.key")).collect();
        found.sort();
        found
    }

    #[test]
    fn a_crash_after_publishing_leaves_a_second_name_that_the_next_start_with_the_valid_key_removes() {
        use std::os::unix::fs::MetadataExt;
        let engine = Engine::new();
        killed_at(&engine, "key:after-publish");
        assert_eq!(names_of_the_key(&engine).len(), 2, "the crash should leave the key and its temporary name");
        let bytes = std::fs::read(key_path(&engine)).unwrap();
        let inode = std::fs::metadata(key_path(&engine)).unwrap().ino();
        let id = engine.ok("identity", json!({}))["peer_id"].clone();
        assert_eq!(names_of_the_key(&engine), vec!["transport.key".to_string()], "the alias of the key was left behind");
        let meta = std::fs::metadata(key_path(&engine)).unwrap();
        assert_eq!((meta.nlink(), meta.ino()), (1, inode));
        assert_eq!(std::fs::read(key_path(&engine)).unwrap(), bytes);
        assert_eq!(id, public_of(&bytes.try_into().unwrap()));
    }

    #[test]
    fn only_aliases_of_the_valid_key_are_removed_never_other_files_or_a_malformed_keys_evidence() {
        let engine = Engine::new();
        write_key(&engine, &[7u8; 32], 0o600);
        // An unrelated file that merely has a similar name, and an alias of nothing: neither is the key's.
        std::fs::write(engine.dir.join("transport.key.tmp-unrelated"), b"keep me").unwrap();
        engine.ok("identity", json!({}));
        assert!(engine.dir.join("transport.key.tmp-unrelated").exists(), "a file that is not the key's alias was removed");

        let broken = Engine::new();
        write_key(&broken, &[1u8; 31], 0o600);
        std::fs::hard_link(key_path(&broken), broken.dir.join("transport.key.tmp-evidence")).unwrap();
        refused(&broken, "malformed");
        assert!(broken.dir.join("transport.key.tmp-evidence").exists(), "evidence next to a malformed key was removed");
        assert_eq!(std::fs::read(key_path(&broken)).unwrap(), vec![1u8; 31]);
    }

    #[test]
    fn a_stale_temporary_file_from_an_earlier_crash_does_not_block_creation() {
        let engine = Engine::new();
        killed_at(&engine, "key:before-publish");
        assert!(std::fs::read_dir(&engine.dir).unwrap().filter_map(|e| e.ok()).any(|e| e.file_name().to_string_lossy().contains("tmp")), "the test needs the leftover");
        engine.ok("identity", json!({}));
        assert_eq!(std::fs::metadata(key_path(&engine)).unwrap().len(), 32);
    }
}
