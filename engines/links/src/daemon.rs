//! The long-running mode: one `setu-links serve` per data directory. It owns the transport endpoint and nothing
//! else; every message and receipt it moves lives in the engine store. Status is read passively from the lock and
//! the status file, so asking never starts anything.

use crate::{args::Fail, store, transport, util, wire};
use serde_json::{Value, json};
use std::{
    fs::{self, File, OpenOptions, TryLockError},
    io::{Read, Write},
    os::unix::fs::{DirBuilderExt, OpenOptionsExt, PermissionsExt},
    path::{Path, PathBuf},
};

/// Where the daemon listens unless told otherwise: this machine only, on a port the system picks.
pub const DEFAULT_LISTEN: &str = "127.0.0.1:0";
const KEY: &str = "transport.key";
const LOCK: &str = "serve.lock";
const STATUS: &str = "serve.json";

fn unavailable() -> Fail {
    Fail::new("STORE_UNAVAILABLE", "the data directory could not be used")
}

/// The data directory, created private on first use for operations that write.
fn private_dir(dir: &Path) -> Result<(), Fail> {
    if !dir.exists() {
        fs::DirBuilder::new().recursive(true).mode(0o700).create(dir).map_err(|_| unavailable())?;
    }
    let mode = fs::metadata(dir).map_err(|_| unavailable())?.permissions().mode();
    if mode & 0o077 != 0 {
        return Err(Fail::new("DATA_DIR_NOT_PRIVATE", "the data directory must be accessible to its owner only"));
    }
    Ok(())
}

const KEY_BYTES: usize = 32;
/// A leftover from a creator that died before publishing is cleaned up after this long.
const STALE_TEMPORARY_KEY_MS: u128 = 10 * 60 * 1000;

fn key_invalid(what: &str) -> Fail {
    Fail::new(
        "TRANSPORT_KEY_INVALID",
        format!("transport.key is {what}. The engine never replaces a key by itself; if this one is not wanted, move it aside and start again to make a new identity"),
    )
}

/// The key as stored, if there is one. Anything that is not a complete, private, regular file of this user's
/// own is refused here and left exactly as it is: a half-written or foreign key must never be mistaken for an
/// identity, and must never be silently replaced by a new one.
fn read_key(path: &Path, owner: u32) -> Result<Option<[u8; KEY_BYTES]>, Fail> {
    use std::os::unix::fs::MetadataExt;
    match fs::symlink_metadata(path) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(_) => return Err(unavailable()),
        Ok(meta) if meta.file_type().is_symlink() => return Err(key_invalid("a symbolic link")),
        Ok(meta) if !meta.is_file() => return Err(key_invalid("not a regular file")),
        Ok(_) => {}
    }
    let mut file = File::open(path).map_err(|_| unavailable())?;
    // Judge what was actually opened, not what the name said a moment ago.
    let meta = file.metadata().map_err(|_| unavailable())?;
    if !meta.is_file() || meta.len() != KEY_BYTES as u64 {
        return Err(key_invalid(&format!("{} bytes long, not {KEY_BYTES}", meta.len())));
    }
    if meta.permissions().mode() & 0o177 != 0 {
        return Err(key_invalid("accessible to other users or marked executable"));
    }
    if meta.uid() != owner {
        return Err(key_invalid("owned by a different user"));
    }
    let mut bytes = [0u8; KEY_BYTES];
    file.read_exact(&mut bytes).map_err(|_| key_invalid("unreadable"))?;
    Ok(Some(bytes))
}

/// A creator that died between publishing the key and removing its temporary name leaves a second name for the same
/// key. Once the key is known to be valid, any `transport.key.tmp-*` that is the very same file (same device and
/// inode) is removed, so moving the key aside really moves the only name. Nothing else is touched, and nothing is
/// removed beside a key that was refused.
fn remove_aliases_of_valid_key(dir: &Path, key: &Path) {
    use std::os::unix::fs::MetadataExt;
    let Ok(key_meta) = fs::symlink_metadata(key) else { return };
    let Ok(entries) = fs::read_dir(dir) else { return };
    for entry in entries.flatten() {
        if !entry.file_name().to_string_lossy().starts_with(&format!("{KEY}.tmp-")) {
            continue;
        }
        if fs::symlink_metadata(entry.path()).is_ok_and(|m| m.is_file() && m.dev() == key_meta.dev() && m.ino() == key_meta.ino()) {
            let _ = fs::remove_file(entry.path());
        }
    }
}

/// Removes temporary keys an earlier creator left when it died before publishing. A recent one may belong to a
/// creator still running, so only old ones go.
fn clear_stale_temporaries(dir: &Path) {
    let Ok(entries) = fs::read_dir(dir) else { return };
    for entry in entries.flatten() {
        let stale = entry.file_name().to_string_lossy().starts_with(&format!("{KEY}.tmp-"))
            && entry.metadata().and_then(|m| m.modified()).ok().and_then(|t| t.elapsed().ok()).is_some_and(|age| age.as_millis() > STALE_TEMPORARY_KEY_MS);
        if stale {
            let _ = fs::remove_file(entry.path());
        }
    }
}

/// The machine's transport key: created once, owner-only, never printed. It names this machine to its peers and
/// says nothing about any conversation.
///
/// A new key is written whole to a private temporary file and then published with a hard link, which is atomic and
/// cannot replace an existing key: a crash leaves either no key or a complete one, and engines racing to create it
/// all end up reading the single winner.
pub fn secret_key(dir: &Path) -> Result<iroh::SecretKey, Fail> {
    use std::os::unix::fs::MetadataExt;
    private_dir(dir)?;
    let owner = fs::metadata(dir).map_err(|_| unavailable())?.uid();
    let path = dir.join(KEY);
    if let Some(bytes) = read_key(&path, owner)? {
        remove_aliases_of_valid_key(dir, &path);
        return Ok(iroh::SecretKey::from_bytes(&bytes));
    }
    clear_stale_temporaries(dir);
    let mut bytes = [0u8; KEY_BYTES];
    getrandom::fill(&mut bytes).map_err(|_| unavailable())?;
    let temporary = dir.join(format!("{KEY}.tmp-{}-{}", std::process::id(), util::new_id("k")));
    let mut file = OpenOptions::new().write(true).create_new(true).mode(0o600).open(&temporary).map_err(|_| unavailable())?;
    file.write_all(&bytes).and_then(|()| file.sync_all()).map_err(|_| {
        let _ = fs::remove_file(&temporary);
        unavailable()
    })?;
    drop(file);
    util::fault("key:before-publish");
    let published = fs::hard_link(&temporary, &path);
    util::fault("key:after-publish");
    let _ = fs::remove_file(&temporary);
    match published {
        Ok(()) => {
            let _ = File::open(dir).and_then(|d| d.sync_all());
            Ok(iroh::SecretKey::from_bytes(&bytes))
        }
        // Another engine published first: its key is the identity, and it was complete when it appeared.
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
            read_key(&path, owner)?.map(|bytes| iroh::SecretKey::from_bytes(&bytes)).ok_or_else(unavailable)
        }
        Err(_) => Err(unavailable()),
    }
}

pub fn identity(dir: &Path) -> Result<Value, Fail> {
    Ok(json!({ "peer_id": secret_key(dir)?.public().to_string() }))
}

/// Whether some process holds the serve lock, found without taking it for longer than an instant.
fn lock_held(dir: &Path) -> bool {
    let Ok(file) = File::open(dir.join(LOCK)) else { return false };
    match file.try_lock_shared() {
        Ok(()) => {
            let _ = file.unlock();
            false
        }
        Err(TryLockError::WouldBlock) => true,
        Err(TryLockError::Error(_)) => false,
    }
}

fn read_status(dir: &Path) -> Option<Value> {
    serde_json::from_str(&fs::read_to_string(dir.join(STATUS)).ok()?).ok()
}

/// Passive: reads the lock and the status file and creates nothing.
pub fn status(dir: &Path) -> Value {
    if !lock_held(dir) {
        return json!({ "running": false });
    }
    // The lock is the truth about running; the file only adds detail, and may not be written yet.
    match read_status(dir) {
        Some(Value::Object(mut detail)) => {
            detail.insert("running".into(), json!(true));
            Value::Object(detail)
        }
        _ => json!({ "running": true, "listen": [] }),
    }
}

pub(crate) fn write_status(dir: &Path, status: &Value) -> std::io::Result<()> {
    let tmp = dir.join(format!("{STATUS}.tmp"));
    let mut file = OpenOptions::new().write(true).create(true).truncate(true).mode(0o600).open(&tmp)?;
    file.write_all(status.to_string().as_bytes())?;
    file.sync_all()?;
    fs::rename(tmp, dir.join(STATUS))
}

pub struct Options {
    pub dir: PathBuf,
    pub listen: Option<String>,
}

/// Runs the daemon until it is told to stop. A second one for the same directory reports the first and exits 0.
pub fn serve(options: Options) -> Result<Value, Fail> {
    let Options { dir, listen } = options;
    private_dir(&dir)?;
    let key = secret_key(&dir)?;
    let lock = OpenOptions::new().create(true).truncate(false).write(true).mode(0o600).open(dir.join(LOCK)).map_err(|_| unavailable())?;
    // A status probe holds the lock for an instant: try again before deciding someone else runs.
    let mut tries = 0;
    loop {
        match lock.try_lock() {
            Ok(()) => break,
            Err(TryLockError::WouldBlock) if tries < 5 => {
                tries += 1;
                std::thread::sleep(std::time::Duration::from_millis(40));
            }
            Err(TryLockError::WouldBlock) => {
                let pid = read_status(&dir).and_then(|s| s["pid"].as_u64());
                return Ok(json!({ "state": "already-running", "pid": pid }));
            }
            Err(TryLockError::Error(_)) => return Err(unavailable()),
        }
    }
    store::Store::open_or_create(&dir)?;
    let runtime = tokio::runtime::Builder::new_multi_thread().enable_all().build().map_err(|_| unavailable())?;
    let result = runtime.block_on(run(&dir, key, listen));
    drop(lock);
    result
}

async fn run(dir: &Path, key: iroh::SecretKey, listen: Option<String>) -> Result<Value, Fail> {
    use iroh::endpoint::{Endpoint, presets};
    // Loopback unless the user chose an address: reaching other machines is a deliberate setting, not a default.
    let address = listen.as_deref().unwrap_or(DEFAULT_LISTEN);
    let builder = Endpoint::builder(presets::Minimal)
        .secret_key(key.clone())
        .clear_ip_transports()
        .bind_addr(address)
        .map_err(|_| Fail::new("REQUEST_INVALID", "the listen address is invalid"))?;
    let endpoint = builder.bind().await.map_err(|_| Fail::new("TRANSPORT_UNAVAILABLE", "the transport could not start"))?;
    let listening: Vec<String> = endpoint.bound_sockets().iter().map(|a| a.to_string()).collect();
    let status = json!({
            "pid": std::process::id(),
            "peer_id": key.public().to_string(),
            "listen": listening,
            "protocol_versions": wire::VERSIONS,
            "engine_version": env!("CARGO_PKG_VERSION"),
            "started_at": util::now_ms(),
            "links": [],
        });
    write_status(dir, &status).map_err(|_| unavailable())?;
    let net = transport::Net::new(dir.to_path_buf(), endpoint.clone(), status);
    let router = iroh::protocol::Router::builder(endpoint.clone()).accept(wire::ALPN, transport::Handler(net.clone())).spawn();
    net.start();
    let mut term = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()).map_err(|_| unavailable())?;
    tokio::select! {
        _ = term.recv() => {}
        _ = tokio::signal::ctrl_c() => {}
    }
    let _ = router.shutdown().await;
    let _ = fs::remove_file(dir.join(STATUS));
    Ok(json!({ "state": "stopped" }))
}
