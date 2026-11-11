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
            d.check_holder(&k, s(req, "holder"))?;
            d.stop(&k, RunStatus::Stopped).await?;
            d.describe(&k)
        }
        "start" => {
            let k = target(d, req)?;
            d.start(&k).await?;
            d.describe(&k)
        }
        "restart" => {
            let k = target(d, req)?;
            d.check_holder(&k, s(req, "holder"))?;
            d.stop(&k, RunStatus::Stopped).await?;
            d.start(&k).await?;
            d.describe(&k)
        }
        "logs" => {
            let lines = req.get("lines").and_then(Value::as_u64).unwrap_or(100) as usize;
            d.logs(s(req, "run").ok_or_else(|| anyhow!("logs needs a run"))?, s(req, "proc"), lines)
        }
        "pin" | "unpin" => d.pin(&target(d, req)?, cmd == "pin"),
        "resolve" => Ok(json!(target(d, req)?)),
        "env.list" => d.env_list(&scope(d, req)?),
        "env.effective" => d.env_effective(s(req, "run").ok_or_else(|| anyhow!("env.effective needs a run"))?),
        "env.set" => {
            let secret = req.get("secret").and_then(Value::as_bool);
            d.env_set(
                actor(req),
                client(req),
                &scope(d, req)?,
                s(req, "name").ok_or_else(|| anyhow!("env.set needs a name"))?,
                s(req, "value").ok_or_else(|| anyhow!("env.set needs a value"))?,
                secret,
            )
        }
        "env.unset" => d.env_unset(actor(req), client(req), &scope(d, req)?, s(req, "name").ok_or_else(|| anyhow!("env.unset needs a name"))?),
        "env.import" => d.env_import(
            actor(req),
            client(req),
            &scope(d, req)?,
            s(req, "path"),
            s(req, "text"),
            req.get("preview").and_then(Value::as_bool).unwrap_or(false),
            req.get("overwrite").and_then(Value::as_bool).unwrap_or(false),
        ),
        "env.reveal" => d.env_reveal(actor(req), &scope(d, req)?, s(req, "name").ok_or_else(|| anyhow!("env.reveal needs a name"))?),
        "disk.report" => d.disk_report(req.get("deps").and_then(Value::as_bool).unwrap_or(false)).await,
        "disk.clean" => {
            d.disk_clean(
                req.get("apply").and_then(Value::as_bool).unwrap_or(false),
                req.get("include_unmanaged").and_then(Value::as_bool).unwrap_or(false),
            )
            .await
        }
        "worktree.new" => {
            d.worktree_new(
                actor(req),
                client(req),
                s(req, "project").ok_or_else(|| anyhow!("worktree.new needs a project"))?,
                s(req, "branch").ok_or_else(|| anyhow!("worktree.new needs a branch"))?,
                s(req, "base").filter(|b| !b.is_empty()),
                req.get("start").and_then(Value::as_bool).unwrap_or(false),
            )
            .await
        }
        "worktree.adopt" => d.worktree_adopt(actor(req), client(req), &PathBuf::from(s(req, "path").ok_or_else(|| anyhow!("worktree.adopt needs a path"))?)).await,
        "worktree.rm" => {
            let force = req.get("force").and_then(Value::as_bool).unwrap_or(false);
            if force && actor(req) == "mcp" {
                bail!("force removal is not available to agents; ask the user to run `setu-rs rm --force` themselves");
            }
            d.worktree_rm(actor(req), client(req), s(req, "run").ok_or_else(|| anyhow!("worktree.rm needs a run"))?, force).await
        }
        "worktree.restore" => d.worktree_restore(actor(req), client(req), s(req, "run").ok_or_else(|| anyhow!("worktree.restore needs a run"))?).await,
        "claim" => {
            let pid = req.get("pid").and_then(Value::as_i64).map(|p| p as i32);
            d.claim(actor(req), client(req), s(req, "run").ok_or_else(|| anyhow!("claim needs a run"))?, s(req, "holder").ok_or_else(|| anyhow!("claim needs a holder"))?, pid)
        }
        "release" => d.release(actor(req), client(req), s(req, "run").ok_or_else(|| anyhow!("release needs a run"))?, s(req, "holder")),
        "claims" => Ok(d.claims_list()),
        "autoremove" => {
            let dry = req.get("dry_run").and_then(Value::as_bool).unwrap_or(false);
            if !dry && actor(req) == "mcp" {
                bail!("agents can only preview auto-removal; ask the user to run `setu-rs autoremove`");
            }
            d.autoremove(dry).await
        }
        "autoremove.candidates" => d.autoremove_candidates(),
        other => bail!("unknown cmd {other}"),
    }
}

/// Who is asking: "cli" (default), "app" or "mcp". The MCP shim always sets "mcp".
fn actor(req: &Value) -> &str {
    match s(req, "actor") {
        Some("mcp") => "mcp",
        Some("app") => "app",
        _ => "cli",
    }
}

/// MCP client name from the initialize handshake, for the audit log. Length-capped.
fn client(req: &Value) -> Option<&str> {
    s(req, "client").filter(|c| !c.is_empty() && c.len() <= 80)
}

fn scope(d: &Arc<Daemon>, req: &Value) -> Result<crate::env::Scope> {
    d.env_scope(s(req, "scope").unwrap_or("global"), s(req, "target"))
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
