// Drives the real `setu-links` binary: one process per operation, JSON in and out, as production does.
#![allow(dead_code)]

use rusqlite::Connection;
use serde_json::{Value, json};
use std::{
    io::Write,
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::atomic::{AtomicU32, Ordering},
};

static NEXT: AtomicU32 = AtomicU32::new(0);

// The schema exactly as the first release candidate created it.
pub const SCHEMA_1: &str = "
CREATE TABLE messages (
    id TEXT PRIMARY KEY,
    sender TEXT NOT NULL,
    idempotency_key TEXT NOT NULL,
    payload_digest TEXT NOT NULL,
    kind TEXT NOT NULL,
    body TEXT NOT NULL,
    size INTEGER NOT NULL,
    reply_to TEXT,
    run_hint TEXT,
    span_hint TEXT,
    provider TEXT NOT NULL,
    native_id TEXT NOT NULL,
    checkout TEXT NOT NULL,
    session_hint TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    UNIQUE (sender, idempotency_key)
);
CREATE INDEX messages_recipient ON messages (provider, native_id, checkout);
CREATE INDEX messages_session ON messages (session_hint);
CREATE TRIGGER messages_immutable BEFORE UPDATE ON messages
BEGIN SELECT RAISE(ABORT, 'messages are immutable'); END;
CREATE TRIGGER messages_permanent BEFORE DELETE ON messages
BEGIN SELECT RAISE(ABORT, 'messages are permanent'); END;
CREATE TABLE deliveries (
    message_id TEXT PRIMARY KEY REFERENCES messages (id),
    state TEXT NOT NULL CHECK (state IN
        ('queued', 'held', 'handoff-unknown', 'handed-off', 'acknowledged', 'expired', 'cancelled')),
    reason TEXT,
    attempts INTEGER NOT NULL DEFAULT 0,
    redeliveries INTEGER NOT NULL DEFAULT 0,
    attempt_id TEXT,
    expires_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);
CREATE INDEX deliveries_state ON deliveries (state);
CREATE TABLE attempts (
    id TEXT PRIMARY KEY,
    provider TEXT NOT NULL,
    native_id TEXT NOT NULL,
    checkout TEXT NOT NULL,
    claimed_at INTEGER NOT NULL
);
CREATE TABLE attempt_messages (
    attempt_id TEXT NOT NULL REFERENCES attempts (id),
    message_id TEXT NOT NULL REFERENCES messages (id),
    number INTEGER NOT NULL,
    PRIMARY KEY (attempt_id, message_id)
);
";

pub struct Engine {
    pub dir: PathBuf,
    owned: bool,
    /// The process ID of the daemon most recently started over this directory by this harness (0 before any), so
    /// readiness means that process, never a status file a dead daemon left behind.
    spawned: std::sync::atomic::AtomicU32,
}

pub fn recipient(native_id: &str) -> Value {
    json!({
        "provider": "claude-code",
        "native_id": native_id,
        "checkout": "{\"path\":\"/work/repo\",\"incarnation\":\"c1\"}",
        "session_hint": "session-1",
    })
}

pub fn send_args(key: &str, body: &str, native_id: &str) -> Value {
    json!({
        "idempotency_key": key,
        "sender": { "kind": "user" },
        "project": "repo",
        "recipient": recipient(native_id),
        "body": body,
    })
}

/// A send from a trusted test principal: a local session other than the user.
pub fn session_send_args(key: &str, body: &str, native_id: &str, sender_session: &str, project: &str) -> Value {
    let mut args = send_args(key, body, native_id);
    args["sender"] = json!({ "kind": "session", "id": sender_session });
    args["project"] = json!(project);
    args
}

impl Engine {
    pub fn new() -> Self {
        let dir = std::env::temp_dir().join(format!(
            "setu-links-test-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::SeqCst)
        ));
        Engine { dir, owned: true, spawned: std::sync::atomic::AtomicU32::new(0) }
    }

    /// The data directory is the persistent state; a second `Engine` over it is a restarted engine.
    pub fn at(dir: &Path) -> Self {
        Engine { dir: dir.to_path_buf(), owned: false, spawned: std::sync::atomic::AtomicU32::new(0) }
    }

    pub fn raw(&self, input: &str, env: &[(&str, &str)]) -> (Value, std::process::ExitStatus, String) {
        let mut cmd = Command::new(env!("CARGO_BIN_EXE_setu-links"));
        cmd.arg("--data-dir").arg(&self.dir).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped());
        for (k, v) in env {
            cmd.env(k, v);
        }
        let mut child = cmd.spawn().expect("spawn engine");
        child.stdin.take().unwrap().write_all(input.as_bytes()).unwrap();
        let out = child.wait_with_output().unwrap();
        let stdout = String::from_utf8_lossy(&out.stdout).to_string();
        let value = serde_json::from_str(stdout.trim()).unwrap_or(Value::Null);
        (value, out.status, String::from_utf8_lossy(&out.stderr).to_string())
    }

    pub fn call_env(&self, op: &str, args: Value, env: &[(&str, &str)]) -> Value {
        let request = json!({ "protocol": "setu-links/1", "id": "t", "op": op, "args": args });
        self.raw(&request.to_string(), env).0
    }

    pub fn call(&self, op: &str, args: Value) -> Value {
        self.call_env(op, args, &[])
    }

    pub fn ok(&self, op: &str, args: Value) -> Value {
        let reply = self.call(op, args);
        assert_eq!(reply["ok"], true, "{op} failed: {reply}");
        reply["result"].clone()
    }

    pub fn err(&self, op: &str, args: Value) -> String {
        let reply = self.call(op, args);
        assert_eq!(reply["ok"], false, "{op} unexpectedly succeeded: {reply}");
        reply["error"]["code"].as_str().unwrap().to_string()
    }
}

impl Drop for Engine {
    fn drop(&mut self) {
        if self.owned {
            let _ = std::fs::remove_dir_all(&self.dir);
        }
    }
}

/// A real `setu-links serve` process over an `Engine`'s data directory. Only processes this harness spawned are
/// ever signalled, and every one is killed and reaped when its owner is dropped, including when a test panics.
pub struct Daemon {
    pub child: std::process::Child,
}

impl Engine {
    /// Starts `serve` on a loopback port the system picks. `env` can carry a test kill point.
    pub fn serve(&self, env: &[(&str, &str)]) -> Daemon {
        self.serve_with(env, Some("127.0.0.1:0"))
    }

    /// `listen: None` is `serve` exactly as a user would start it without choosing an address.
    pub fn serve_with(&self, env: &[(&str, &str)], listen: Option<&str>) -> Daemon {
        let mut cmd = Command::new(env!("CARGO_BIN_EXE_setu-links"));
        cmd.args(["serve", "--data-dir"]).arg(&self.dir);
        if let Some(address) = listen {
            cmd.args(["--listen", address]);
        }
        cmd.stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
        for (k, v) in env {
            cmd.env(k, v);
        }
        let child = cmd.spawn().expect("spawn serve");
        self.spawned.store(child.id(), std::sync::atomic::Ordering::SeqCst);
        Daemon { child }
    }

    /// Waits until the daemon this harness just started reports itself running with a bound address.
    pub fn wait_running(&self) -> Value {
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(20);
        loop {
            let status = self.call("transport_status", serde_json::json!({}));
            // Only the process this harness started counts: a dead daemon's leftover file names another pid.
            let ours = status["result"]["pid"].as_u64() == Some(u64::from(self.spawned.load(std::sync::atomic::Ordering::SeqCst)));
            if status["result"]["running"] == true && ours && status["result"]["listen"].as_array().is_some_and(|l| !l.is_empty()) {
                return status["result"].clone();
            }
            assert!(std::time::Instant::now() < deadline, "the daemon never became ready: {status}");
            std::thread::sleep(std::time::Duration::from_millis(50));
        }
    }

    pub fn start(&self) -> Daemon {
        let daemon = self.serve(&[]);
        self.wait_running();
        daemon
    }
}

impl Daemon {
    pub fn pid(&self) -> u32 {
        self.child.id()
    }

    pub fn kill(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }

    pub fn terminate(&mut self) -> std::process::ExitStatus {
        let _ = Command::new("kill").arg("-TERM").arg(self.child.id().to_string()).status();
        self.child.wait().expect("wait for serve")
    }
}

impl Drop for Daemon {
    fn drop(&mut self) {
        self.kill();
    }
}

/// Two engines with separate data directories standing in for two machines, each with a running daemon.
pub struct Pair {
    pub a: Engine,
    pub b: Engine,
    pub a_id: String,
    pub b_id: String,
    pub a_daemon: Option<Daemon>,
    pub b_daemon: Option<Daemon>,
}

pub fn wait_until(what: &str, mut done: impl FnMut() -> bool) {
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(30);
    while !done() {
        assert!(std::time::Instant::now() < deadline, "timed out waiting for {what}");
        std::thread::sleep(std::time::Duration::from_millis(50));
    }
}

impl Pair {
    /// Both daemons running and each on the other's roster. Nothing is granted yet.
    pub fn new() -> Self {
        Self::build(&[], &[])
    }

    /// Like `new`, with extra environment for each daemon (a test kill point, a faster tick).
    pub fn build(a_env: &[(&str, &str)], b_env: &[(&str, &str)]) -> Self {
        let (a, b) = (Engine::new(), Engine::new());
        let a_id = a.ok("identity", serde_json::json!({}))["peer_id"].as_str().unwrap().to_string();
        let b_id = b.ok("identity", serde_json::json!({}))["peer_id"].as_str().unwrap().to_string();
        let (a_daemon, b_daemon) = (a.serve(a_env), b.serve(b_env));
        a.wait_running();
        b.wait_running();
        let (a_addr, b_addr) = (
            a.ok("transport_status", serde_json::json!({}))["listen"][0].as_str().unwrap().to_string(),
            b.ok("transport_status", serde_json::json!({}))["listen"][0].as_str().unwrap().to_string(),
        );
        a.ok("peer_add", serde_json::json!({ "peer_id": b_id, "label": "machine b", "addresses": [b_addr] }));
        b.ok("peer_add", serde_json::json!({ "peer_id": a_id, "label": "machine a", "addresses": [a_addr] }));
        Pair { a, b, a_id, b_id, a_daemon: Some(a_daemon), b_daemon: Some(b_daemon) }
    }

    /// The full, normal authorization: `project` is shared on `to`, its session is published inside that project,
    /// `to` lets `from` receive and see it, and `from` may send. Directions are named by the arguments.
    pub fn authorize(&self, from: &Engine, from_id: &str, to: &Engine, to_id: &str, project: &str) {
        use serde_json::json;
        to.ok("share_enable", json!({ "project": project, "owner": "casey" }));
        to.ok(
            "binding_publish",
            json!({ "recipient": recipient("native-a"), "generation": 1, "valid_for_ms": 300_000, "project": project }),
        );
        let peer = json!({ "kind": "peer" });
        to.ok("peer_grant", json!({ "peer_id": from_id, "capability": "receive", "scope": peer }));
        to.ok("peer_grant", json!({ "peer_id": from_id, "capability": "visible", "scope": peer }));
        from.ok("peer_grant", json!({ "peer_id": to_id, "capability": "send", "scope": peer }));
    }

    /// Waits until the sender has the receiver's published view of the session, so a send is accepted.
    pub fn wait_published(&self, from: &Engine, to_id: &str) {
        wait_until("the receiver's published sessions to reach the sender", || {
            let cached = from.ok("peer_list", serde_json::json!({}));
            cached["peers"].as_array().unwrap().iter().any(|p| p["peer_id"] == to_id && p["published"].as_array().is_some_and(|e| !e.is_empty()))
        });
    }

    pub fn send(&self, from: &Engine, to_id: &str, key: &str, body: &str) -> serde_json::Value {
        from.send_to_peer(to_id, key, body)
    }
}

/// A hand-driven authenticated peer: its own key, the real transport, and frames written exactly as the test says,
/// so what the engine does with a hostile or incompatible peer is observed from outside.
pub struct Raw {
    pub rt: tokio::runtime::Runtime,
    pub endpoint: iroh::Endpoint,
    pub conn: iroh::endpoint::Connection,
    pub id: String,
}

impl Raw {
    /// The same key again (a `SecretKey` is not `Copy`), for a peer that reconnects after a daemon restart.
    pub fn key_from(key: &iroh::SecretKey) -> iroh::SecretKey {
        iroh::SecretKey::from_bytes(&key.to_bytes())
    }

    pub fn new_key() -> iroh::SecretKey {
        let mut bytes = [0u8; 32];
        getrandom::fill(&mut bytes).unwrap();
        iroh::SecretKey::from_bytes(&bytes)
    }

    /// Connects as `key` to the daemon of `target` (a loopback address from its status).
    pub fn connect(key: iroh::SecretKey, target_id: &str, target_addr: &str) -> Result<Raw, String> {
        let rt = tokio::runtime::Builder::new_multi_thread().enable_all().build().unwrap();
        let id = key.public().to_string();
        let (endpoint, conn) = rt.block_on(async {
            let endpoint = iroh::Endpoint::builder(iroh::endpoint::presets::Minimal)
                .secret_key(key)
                .clear_ip_transports()
                .bind_addr("127.0.0.1:0")
                .unwrap()
                .bind()
                .await
                .map_err(|e| format!("{e}"))?;
            let address = iroh::EndpointAddr::new(target_id.parse().unwrap()).with_ip_addr(target_addr.parse().unwrap());
            let conn = tokio::time::timeout(std::time::Duration::from_secs(10), endpoint.connect(address, setu_links::wire::ALPN))
                .await
                .map_err(|_| "connect timed out".to_string())?
                .map_err(|e| format!("{e}"))?;
            Ok::<_, String>((endpoint, conn))
        })?;
        Ok(Raw { rt, endpoint, conn, id })
    }

    /// One request frame with exactly these bytes as its payload (length-prefixed correctly), and the reply if any.
    pub fn send_bytes(&self, payload: &[u8]) -> Option<Value> {
        self.rt.block_on(async {
            let (mut send, mut recv) = self.conn.open_bi().await.ok()?;
            send.write_all(&(payload.len() as u32).to_be_bytes()).await.ok()?;
            send.write_all(payload).await.ok()?;
            send.finish().ok()?;
            let mut len = [0u8; 4];
            tokio::time::timeout(std::time::Duration::from_secs(10), recv.read_exact(&mut len)).await.ok()?.ok()?;
            let mut buffer = vec![0; u32::from_be_bytes(len) as usize];
            recv.read_exact(&mut buffer).await.ok()?;
            serde_json::from_slice(&buffer).ok()
        })
    }

    pub fn send(&self, request: Value) -> Option<Value> {
        self.send_bytes(request.to_string().as_bytes())
    }

    /// A frame that claims a length it never delivers, to see that the length alone is refused.
    pub fn send_claimed_length(&self, claimed: u32) -> Option<Value> {
        self.rt.block_on(async {
            let (mut send, mut recv) = self.conn.open_bi().await.ok()?;
            send.write_all(&claimed.to_be_bytes()).await.ok()?;
            send.finish().ok()?;
            let mut len = [0u8; 4];
            tokio::time::timeout(std::time::Duration::from_secs(10), recv.read_exact(&mut len)).await.ok()?.ok()?;
            let mut buffer = vec![0; u32::from_be_bytes(len) as usize];
            recv.read_exact(&mut buffer).await.ok()?;
            serde_json::from_slice(&buffer).ok()
        })
    }

    pub fn hello(&self) -> Value {
        serde_json::json!({ "t": "hello", "versions": setu_links::wire::VERSIONS, "capabilities": ["cancel", "deposit", "published", "receipt"], "engine_version": "test", "schema_version": 3 })
    }

    pub fn is_closed(&self) -> bool {
        self.conn.close_reason().is_some()
    }
}

impl Raw {
    /// Answers whatever the engine on the other end sends (hello, published sessions, receipts) like a polite peer, and
    /// keeps every byte it was sent, so a test can look at exactly what crossed the wire.
    pub fn capture_incoming(&self) -> std::sync::Arc<std::sync::Mutex<Vec<u8>>> {
        let seen = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
        let (conn, sink) = (self.conn.clone(), seen.clone());
        self.rt.spawn(async move {
            while let Ok((mut send, mut recv)) = conn.accept_bi().await {
                let mut len = [0u8; 4];
                if recv.read_exact(&mut len).await.is_err() {
                    break;
                }
                let mut buffer = vec![0; u32::from_be_bytes(len) as usize];
                if recv.read_exact(&mut buffer).await.is_err() {
                    break;
                }
                sink.lock().unwrap().extend_from_slice(&buffer);
                let request: Value = serde_json::from_slice(&buffer).unwrap_or(Value::Null);
                let reply = polite(&request).unwrap_or(json!({ "t": "ok" })).to_string();
                let _ = send.write_all(&(reply.len() as u32).to_be_bytes()).await;
                let _ = send.write_all(reply.as_bytes()).await;
                let _ = send.finish();
            }
        });
        seen
    }
}

impl Drop for Raw {
    fn drop(&mut self) {
        self.conn.close(0u32.into(), b"done");
        self.rt.block_on(self.endpoint.close());
    }
}

impl Engine {
    /// Every table's rows, as one comparable value: what "no state change" is measured against.
    pub fn snapshot(&self) -> Value {
        let path = self.dir.join("mailbox.sqlite3");
        if !path.exists() {
            return Value::Null;
        }
        let db = rusqlite::Connection::open_with_flags(&path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY).unwrap();
        let tables: Vec<String> = db
            .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
            .unwrap()
            .query_map([], |row| row.get(0))
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap();
        let mut all = serde_json::Map::new();
        for table in tables {
            let mut statement = db.prepare(&format!("SELECT * FROM {table} ORDER BY 1, 2")).unwrap();
            let columns = statement.column_count();
            let rows: Vec<Value> = statement
                .query_map([], |row| {
                    Ok(Value::Array((0..columns).map(|i| match row.get_ref(i).unwrap() {
                        rusqlite::types::ValueRef::Null => Value::Null,
                        rusqlite::types::ValueRef::Integer(n) => Value::from(n),
                        rusqlite::types::ValueRef::Real(f) => Value::from(f),
                        rusqlite::types::ValueRef::Text(t) => Value::from(String::from_utf8_lossy(t).to_string()),
                        rusqlite::types::ValueRef::Blob(_) => Value::from("blob"),
                    }).collect()))
                })
                .unwrap()
                .collect::<Result<_, _>>()
                .unwrap();
            all.insert(table, Value::Array(rows));
        }
        Value::Object(all)
    }
}

/// A hand-written peer that *listens*: the engine under test dials it, and every request frame it receives is
/// answered by the test's own function, so malformed or hostile replies reach the sender through the real transport.
pub struct RawServer {
    rt: tokio::runtime::Runtime,
    router: Option<iroh::protocol::Router>,
    pub addr: String,
    pub id: String,
}

struct ServerHandler {
    answer: std::sync::Arc<dyn Fn(Value) -> Value + Send + Sync>,
    published: Vec<Value>,
}

impl std::fmt::Debug for ServerHandler {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("ServerHandler")
    }
}

impl iroh::protocol::ProtocolHandler for ServerHandler {
    async fn accept(&self, conn: iroh::endpoint::Connection) -> Result<(), iroh::protocol::AcceptError> {
        // Like a real peer: say hello, then publish what can be addressed, so the dialing engine can send.
        let pusher = conn.clone();
        let push = move |frame: Value| {
            let conn = pusher.clone();
            async move {
                let (mut send, mut recv) = conn.open_bi().await.ok()?;
                let bytes = frame.to_string();
                send.write_all(&(bytes.len() as u32).to_be_bytes()).await.ok()?;
                send.write_all(bytes.as_bytes()).await.ok()?;
                send.finish().ok()?;
                let mut len = [0u8; 4];
                recv.read_exact(&mut len).await.ok()?;
                let mut buffer = vec![0; u32::from_be_bytes(len) as usize];
                recv.read_exact(&mut buffer).await.ok()
            }
        };
        let hello = json!({ "t": "hello", "versions": [setu_links::wire::VERSIONS[0]], "capabilities": setu_links::wire::CAPABILITIES, "engine_version": "test", "schema_version": 3 });
        let published = json!({ "t": "published", "entries": self.published });
        tokio::spawn(async move {
            push(hello).await;
            push(published).await;
        });
        while let Ok((mut send, mut recv)) = conn.accept_bi().await {
            let mut len = [0u8; 4];
            if recv.read_exact(&mut len).await.is_err() {
                break;
            }
            let mut buffer = vec![0; u32::from_be_bytes(len) as usize];
            if recv.read_exact(&mut buffer).await.is_err() {
                break;
            }
            let request: Value = serde_json::from_slice(&buffer).unwrap_or(Value::Null);
            let reply = (self.answer)(request).to_string();
            let _ = send.write_all(&(reply.len() as u32).to_be_bytes()).await;
            let _ = send.write_all(reply.as_bytes()).await;
            let _ = send.finish();
        }
        Ok(())
    }
}

impl RawServer {
    /// `published` is what this peer tells the engine that dials it it can be sent to.
    pub fn start(key: iroh::SecretKey, published: Vec<Value>, handler: impl Fn(Value) -> Value + Send + Sync + 'static) -> RawServer {
        let rt = tokio::runtime::Builder::new_multi_thread().enable_all().build().unwrap();
        let id = key.public().to_string();
        let (router, addr) = rt.block_on(async {
            let endpoint = iroh::Endpoint::builder(iroh::endpoint::presets::Minimal)
                .secret_key(key)
                .clear_ip_transports()
                .bind_addr("127.0.0.1:0")
                .unwrap()
                .bind()
                .await
                .unwrap();
            let addr = endpoint.bound_sockets()[0].to_string();
            let router = iroh::protocol::Router::builder(endpoint).accept(setu_links::wire::ALPN, ServerHandler { answer: std::sync::Arc::new(handler), published }).spawn();
            (router, addr)
        });
        RawServer { rt, router: Some(router), addr, id }
    }
}

impl Drop for RawServer {
    fn drop(&mut self) {
        if let Some(router) = self.router.take() {
            let _ = self.rt.block_on(router.shutdown());
        }
    }
}

/// The answers of a well-behaved peer to the requests that are not the point of a test.
pub fn polite(request: &Value) -> Option<Value> {
    match request["t"].as_str() {
        Some("hello") => Some(json!({ "t": "hello_ok", "version": setu_links::wire::VERSIONS[0], "capabilities": setu_links::wire::CAPABILITIES })),
        Some("published") | Some("ping") | Some("receipt") => Some(json!({ "t": "ok" })),
        _ => None,
    }
}

/// The recipient as a peer addresses it on the wire: the same session and provider, the native conversation and
/// the checkout as their opaque addresses. One place, so it changes in one place.
pub fn wire_recipient(native_id: &str) -> Value {
    wire_form(&recipient(native_id))
}

/// Any local recipient, as it is addressed on the wire.
pub fn wire_form(local: &Value) -> Value {
    let (native, checkout) = setu_links::wire::address(local["provider"].as_str().unwrap(), local["native_id"].as_str().unwrap(), local["checkout"].as_str().unwrap());
    json!({ "provider": local["provider"], "native_id": native, "checkout": checkout, "session_hint": local["session_hint"] })
}

/// What a peer publishes for a session: the wire form of the recipient, the sharing scope, and a lifetime.
pub fn published_entry(native_id: &str) -> Value {
    let r = wire_recipient(native_id);
    json!({ "session_hint": r["session_hint"], "provider": r["provider"], "native_id": r["native_id"], "checkout": r["checkout"], "scope": "ps_00000000000000000000000000000001", "ttl_ms": 120_000 })
}

impl Engine {
    /// Waits until this engine holds a fresh published view of `peer`'s session.
    pub fn wait_published_by(&self, peer: &str) {
        wait_until("the peer's published sessions to arrive", || {
            self.ok("peer_list", serde_json::json!({}))["peers"]
                .as_array()
                .unwrap()
                .iter()
                .any(|p| p["peer_id"] == peer && p["published"].as_array().is_some_and(|e| !e.is_empty()))
        });
    }

    /// A send to `peer`, addressed exactly as that peer published the session.
    pub fn send_to_peer(&self, peer: &str, key: &str, body: &str) -> Value {
        let listed = self.ok("peer_list", serde_json::json!({}));
        let entry = listed["peers"].as_array().unwrap().iter().find(|p| p["peer_id"] == peer).unwrap()["published"][0].clone();
        self.ok("send", json!({ "idempotency_key": key, "sender": { "kind": "user" }, "project": "repo", "recipient": entry["recipient"], "body": body, "peer_id": peer }))
    }
}

// The digest the schema-1 engine (the 805ab1f build) stored for exactly this send: key `legacy-key`, the body
// below, recipient native-a / the checkout below / session-1, no reply or hints. It was produced by running
// that engine, not by this one, so this test can disagree with the code under test.
pub const LEGACY_KEY: &str = "legacy-key";
pub const LEGACY_BODY: &str = "written before sharing";
pub const LEGACY_DIGEST: &str = "fd6724b04d97def88e95071e00a1c55298ebbbe744e41231c95094c7c2c2ebdc";

pub fn version_one_store(engine: &Engine) {
    std::fs::create_dir_all(&engine.dir).unwrap();
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&engine.dir, std::fs::Permissions::from_mode(0o700)).unwrap();
    }
    let db = Connection::open(engine.dir.join("mailbox.sqlite3")).unwrap();
    db.pragma_update(None, "journal_mode", "WAL").unwrap();
    db.execute_batch(SCHEMA_1).unwrap();
    db.execute(
        "INSERT INTO messages VALUES ('m_old', 'user', ?1, ?2, 'message', 'written before sharing', 22, NULL, NULL, NULL,
            'claude-code', 'native-a', '{\"path\":\"/work/repo\",\"incarnation\":\"c1\"}', 'session-1', 1760000000000)",
        [LEGACY_KEY, LEGACY_DIGEST],
    )
    .unwrap();
    db.execute("INSERT INTO deliveries (message_id, state, expires_at, updated_at) VALUES ('m_old', 'queued', 4102444800000, 1760000000000)", []).unwrap();
    db.pragma_update(None, "user_version", 1).unwrap();
}
