//! The long-running mode: one process per data directory, passive status, a stable transport identity.
mod common;
use common::*;
use serde_json::json;
use std::os::unix::fs::PermissionsExt;
use std::time::{Duration, Instant};

fn wait_until(what: &str, mut done: impl FnMut() -> bool) {
    let deadline = Instant::now() + Duration::from_secs(20);
    while !done() {
        assert!(Instant::now() < deadline, "timed out waiting for {what}");
        std::thread::sleep(Duration::from_millis(50));
    }
}

#[test]
fn the_transport_identity_is_a_stable_private_public_key() {
    let engine = Engine::new();
    let first = engine.ok("identity", json!({}));
    let id = first["peer_id"].as_str().unwrap();
    assert_eq!(id.len(), 64);
    assert!(id.chars().all(|c| c.is_ascii_digit() || ('a'..='f').contains(&c)));
    assert_eq!(engine.ok("identity", json!({}))["peer_id"], first["peer_id"]);
    let mode = |p: std::path::PathBuf| std::fs::metadata(p).unwrap().permissions().mode() & 0o777;
    assert_eq!(mode(engine.dir.join("transport.key")), 0o600);
    assert_eq!(mode(engine.dir.clone()), 0o700);
}

#[test]
fn status_of_a_stopped_transport_starts_nothing_and_creates_nothing() {
    let engine = Engine::new();
    let status = engine.ok("transport_status", json!({}));
    assert_eq!(status["running"], false);
    assert!(!engine.dir.exists(), "a status read created {:?}", engine.dir);
}

#[test]
fn a_running_daemon_reports_itself_and_the_identity_matches() {
    let engine = Engine::new();
    let daemon = engine.start();
    let status = engine.ok("transport_status", json!({}));
    assert_eq!(status["running"], true);
    assert_eq!(status["pid"], daemon.pid());
    assert_eq!(status["peer_id"], engine.ok("identity", json!({}))["peer_id"]);
    assert_eq!(status["protocol_versions"], json!(setu_links::wire::VERSIONS));
    assert!(status["listen"][0].as_str().unwrap().starts_with("127.0.0.1:"));
}

#[test]
fn starting_twice_yields_one_process_and_the_second_says_so() {
    let engine = Engine::new();
    let first = engine.start();
    let mut second = engine.serve(&[]);
    assert!(second.child.wait().unwrap().success());
    let mut stdout = String::new();
    std::io::Read::read_to_string(&mut second.child.stdout.take().unwrap(), &mut stdout).unwrap();
    let reply: serde_json::Value = serde_json::from_str(stdout.trim()).unwrap();
    assert_eq!(reply["result"]["state"], "already-running");
    assert_eq!(reply["result"]["pid"], first.pid());
    assert_eq!(engine.ok("transport_status", json!({}))["pid"], first.pid());
}

#[test]
fn status_reads_do_not_start_a_stopped_transport_even_when_asked_repeatedly() {
    let engine = Engine::new();
    engine.ok("identity", json!({}));
    for _ in 0..3 {
        assert_eq!(engine.ok("transport_status", json!({}))["running"], false);
        assert_eq!(engine.ok("health", json!({}))["store"], "absent");
    }
}

#[test]
fn a_killed_daemon_leaves_a_lock_that_does_not_block_the_next_start() {
    let engine = Engine::new();
    let mut first = engine.start();
    first.kill();
    wait_until("the lock to be released", || engine.ok("transport_status", json!({}))["running"] == false);
    let second = engine.start();
    assert_ne!(second.pid(), first.pid());
}

#[test]
fn a_stale_status_file_does_not_make_a_dead_daemon_look_alive() {
    let engine = Engine::new();
    let mut daemon = engine.start();
    daemon.kill();
    assert!(engine.dir.join("serve.json").exists(), "the test needs the leftover file");
    wait_until("status to notice", || engine.ok("transport_status", json!({}))["running"] == false);
}

#[test]
fn a_terminated_daemon_exits_cleanly_and_reports_stopped() {
    let engine = Engine::new();
    let mut daemon = engine.start();
    assert!(daemon.terminate().success());
    assert_eq!(engine.ok("transport_status", json!({}))["running"], false);
}

#[test]
fn without_an_address_the_daemon_listens_on_loopback_only() {
    let engine = Engine::new();
    let _daemon = engine.serve_with(&[], None);
    let status = engine.wait_running();
    let listening = status["listen"].as_array().unwrap();
    assert!(!listening.is_empty());
    for address in listening {
        let address: std::net::SocketAddr = address.as_str().unwrap().parse().unwrap();
        assert!(address.ip().is_loopback(), "listening on {address} without being asked to");
    }
}

#[test]
fn an_address_the_user_chooses_is_honored() {
    let engine = Engine::new();
    let _daemon = engine.serve_with(&[], Some("0.0.0.0:0"));
    let status = engine.wait_running();
    assert!(status["listen"].as_array().unwrap().iter().any(|a| a.as_str().unwrap().starts_with("0.0.0.0:")), "{status}");
}
