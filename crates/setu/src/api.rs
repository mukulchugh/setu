//! Newline-delimited JSON over a Unix socket. One request per line, one reply per line:
//! `{"cmd":"ls"}` -> `{"ok":true,"data":...}` or `{"ok":false,"error":"..."}`.
//! The CLI, the macOS app and MCP all use this.

use crate::daemon::Daemon;
use crate::model::RunStatus;
use crate::paths;
use anyhow::{anyhow, bail, Context, Result};
use serde_json::{json, Value};
use std::os::unix::fs::PermissionsExt;
use std::path::PathBuf;
use std::sync::Arc;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::{UnixListener, UnixStream};

/// macOS `sun_path` holds 104 bytes including the trailing NUL.
const SUN_PATH_MAX: usize = 103;

pub async fn serve(daemon: Arc<Daemon>) -> Result<()> {
    let path = paths::socket_path();
    let dir = path.parent().ok_or_else(|| anyhow!("bad socket path"))?;
    std::fs::create_dir_all(dir)?;
    std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700))?;
    if path.as_os_str().len() > SUN_PATH_MAX {
        bail!("socket path {} is longer than macOS allows ({SUN_PATH_MAX} bytes); set SETU_HOME to a shorter dir", path.display());
    }
    if path.exists() {
        if UnixStream::connect(&path).await.is_ok() {
            bail!("another setu-rs daemon is already running ({})", path.display());
        }
        std::fs::remove_file(&path)?;
    }
    let listener = UnixListener::bind(&path).with_context(|| format!("binding {}", path.display()))?;
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600))?;
    loop {
        let (stream, _) = listener.accept().await?;
        let d = daemon.clone();
        tokio::spawn(async move {
            let (read, mut write) = stream.into_split();
            let mut lines = BufReader::new(read).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                let reply = match serde_json::from_str::<Value>(&line) {
                    Ok(req) => match handle(&d, &req).await {
                        Ok(data) => json!({ "ok": true, "data": data }),
                        Err(e) => json!({ "ok": false, "error": format!("{e:#}") }),
                    },
                    Err(e) => json!({ "ok": false, "error": format!("bad request: {e}") }),
                };
                let mut text = reply.to_string();
                text.push('\n');
                if write.write_all(text.as_bytes()).await.is_err() {
                    break;
                }
            }
        });
    }
}

fn s<'a>(req: &'a Value, field: &str) -> Option<&'a str> {
    req.get(field).and_then(Value::as_str)
}

async fn handle(d: &Arc<Daemon>, req: &Value) -> Result<Value> {
    let cmd = s(req, "cmd").ok_or_else(|| anyhow!("missing cmd"))?;
    match cmd {
        "ping" => Ok(json!({ "version": env!("CARGO_PKG_VERSION") })),
        "ls" => Ok(d.list()),
        "up" => {
            let path = PathBuf::from(s(req, "path").ok_or_else(|| anyhow!("up needs a path"))?);
            d.up(&path).await
        }
        "down" => {
            let k = target(d, req)?;
            d.stop(&k, RunStatus::Stopped).await?;
            d.describe(&k)
        }
        "pin" | "unpin" => d.pin(&target(d, req)?, cmd == "pin"),
        "resolve" => Ok(json!(target(d, req)?)),
        "env.get" => d.env_get(s(req, "scope").unwrap_or("global"), s(req, "target")),
        "env.set" => d.env_set(
            s(req, "scope").unwrap_or("global"),
            s(req, "target"),
            s(req, "name").ok_or_else(|| anyhow!("env.set needs a name"))?,
            s(req, "value"),
        ),
        other => bail!("unknown cmd {other}"),
    }
}

/// `run` (project/run or a unique run name) or `path` (a worktree path).
fn target(d: &Arc<Daemon>, req: &Value) -> Result<String> {
    if let Some(run) = s(req, "run") {
        return d.resolve(run);
    }
    if let Some(path) = s(req, "path") {
        return d.run_for_path(&PathBuf::from(path));
    }
    bail!("give a run name or a path")
}

/// Client side: one request, one reply.
pub async fn call(req: Value) -> Result<Value> {
    let path = paths::socket_path();
    // A daemon that was just started may not have bound its socket yet.
    let mut tries = 0;
    let stream = loop {
        match UnixStream::connect(&path).await {
            Ok(s) => break s,
            Err(_) if tries < 15 => {
                tries += 1;
                tokio::time::sleep(std::time::Duration::from_millis(200)).await;
            }
            Err(_) => bail!("setu-rs daemon is not running. Start it with `setu-rs daemon`."),
        }
    };
    let (read, mut write) = stream.into_split();
    let mut text = req.to_string();
    text.push('\n');
    write.write_all(text.as_bytes()).await?;
    let mut lines = BufReader::new(read).lines();
    let line = lines.next_line().await?.ok_or_else(|| anyhow!("daemon closed the connection"))?;
    let reply: Value = serde_json::from_str(&line)?;
    if reply.get("ok").and_then(Value::as_bool) == Some(true) {
        Ok(reply.get("data").cloned().unwrap_or(Value::Null))
    } else {
        bail!("{}", reply.get("error").and_then(Value::as_str).unwrap_or("request failed"))
    }
}
