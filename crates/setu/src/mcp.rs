//! `setu mcp`: a stdio MCP server (JSON-RPC 2.0, one message per line) that forwards to the
//! daemon socket. No port, no token: the 0600 socket is the access control. stdout carries the
//! protocol only; diagnostics go to stderr. Every socket request is tagged `"actor":"mcp"`, which
//! the daemon uses to refuse `env.reveal`, and there is deliberately no reveal tool here.
//! Plan: docs/slices/04-mcp.md

use crate::api;
use anyhow::{anyhow, bail, Result};
use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

const LATEST_PROTOCOL: &str = "2025-06-18";
const SUPPORTED_PROTOCOLS: &[&str] = &["2025-06-18", "2025-03-26", "2024-11-05"];
const MAX_LOG_LINES: u64 = 500;

pub async fn run() -> Result<()> {
    let mut lines = BufReader::new(tokio::io::stdin()).lines();
    let mut out = tokio::io::stdout();
    let mut client: Option<String> = None;
    while let Some(line) = lines.next_line().await? {
        if line.trim().is_empty() {
            continue;
        }
        let msg: Value = match serde_json::from_str(&line) {
            Ok(m) => m,
            Err(e) => {
                write(&mut out, error_reply(Value::Null, -32700, &format!("parse error: {e}"))).await?;
                continue;
            }
        };
        if let Some(reply) = handle(&msg, &mut client).await {
            write(&mut out, reply).await?;
        }
    }
    Ok(())
}

async fn write(out: &mut tokio::io::Stdout, v: Value) -> Result<()> {
    let mut text = v.to_string();
    text.push('\n');
    out.write_all(text.as_bytes()).await?;
    out.flush().await?;
    Ok(())
}

fn error_reply(id: Value, code: i64, message: &str) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "error": { "code": code, "message": message } })
}

/// One incoming message. Notifications (no `id`) and stray responses get no reply.
async fn handle(msg: &Value, client: &mut Option<String>) -> Option<Value> {
    let method = msg.get("method").and_then(Value::as_str)?;
    let id = msg.get("id")?.clone();
    let params = msg.get("params").cloned().unwrap_or(Value::Null);
    let result = match method {
        "initialize" => {
            *client = params["clientInfo"]["name"].as_str().map(|n| n.chars().take(80).collect());
            let wanted = params["protocolVersion"].as_str().unwrap_or("");
            let version = SUPPORTED_PROTOCOLS.iter().find(|v| **v == wanted).copied().unwrap_or(LATEST_PROTOCOL);
            Ok(json!({
                "protocolVersion": version,
                "capabilities": { "tools": {} },
                "serverInfo": { "name": "setu", "version": env!("CARGO_PKG_VERSION") },
                "instructions": "Run and inspect worktree apps through Setu. Secret values are never returned; ask the user to set secrets themselves."
            }))
        }
        "ping" => Ok(json!({})),
        "tools/list" => Ok(json!({ "tools": tools() })),
        "tools/call" => {
            let name = params["name"].as_str().unwrap_or("");
            if !tools().iter().any(|t| t["name"] == name) {
                return Some(error_reply(id, -32602, &format!("unknown tool {name}")));
            }
            let args = params.get("arguments").cloned().unwrap_or_else(|| json!({}));
            Ok(match call_tool(name, &args, client.as_deref()).await {
                Ok(v) => json!({ "content": [{ "type": "text", "text": v.to_string() }], "isError": false }),
                Err(e) => json!({ "content": [{ "type": "text", "text": format!("{e:#}") }], "isError": true }),
            })
        }
        other => Err(format!("method not found: {other}")),
    };
    Some(match result {
        Ok(r) => json!({ "jsonrpc": "2.0", "id": id, "result": r }),
        Err(m) => error_reply(id, -32601, &m),
    })
}

fn tool(name: &str, description: &str, properties: Value, required: &[&str]) -> Value {
    json!({
        "name": name,
        "description": description,
        "inputSchema": { "type": "object", "properties": properties, "required": required, "additionalProperties": false }
    })
}

fn scope_props() -> Value {
    json!({
        "scope": { "type": "string", "enum": ["global", "project", "worktree"], "description": "Which env layer. Later layers win: global < project < worktree." },
        "target": { "type": "string", "description": "Project name for scope=project, run (project/run or unique run name) for scope=worktree. Omit for global." }
    })
}

fn with_scope(extra: Value) -> Value {
    let mut p = scope_props();
    if let (Some(p), Some(e)) = (p.as_object_mut(), extra.as_object()) {
        p.extend(e.clone());
    }
    p
}

/// The tool list. There is no reveal tool, by design.
pub fn tools() -> Vec<Value> {
    let run = json!({ "type": "string", "description": "Run name: project/run, or a run name that is unique across projects (see run_list)." });
    vec![
        tool("run_list", "List every known run with its URL, status (running, starting, stopped, crashed), RAM, ports and whether its env changed since it started (stale_env).", json!({}), &[]),
        tool(
            "run_start",
            "Start a run. Give `path` (a worktree directory; registers it if new) or `run` (an already registered run). Returns the run with its URL; it may still be starting, check run_list.",
            json!({
                "path": { "type": "string", "description": "Absolute path of a worktree." },
                "run": run.clone()
            }),
            &[],
        ),
        tool("run_stop", "Stop a run and all its processes. Refused while another holder has a live claim on it.", json!({ "run": run.clone(), "holder": { "type": "string", "description": "Your claim name, if you hold the claim." } }), &["run"]),
        tool("run_restart", "Stop then start a run. Use after env changes (see stale_env in run_list). Refused while another holder has a live claim on it.", json!({ "run": run.clone(), "holder": { "type": "string", "description": "Your claim name, if you hold the claim." } }), &["run"]),
        tool(
            "run_logs",
            "Recent log lines of a run. Known secret values are replaced with [redacted:NAME]. With no `proc`, all processes are shown, each line prefixed with [proc].",
            json!({
                "run": run.clone(),
                "proc": { "type": "string", "description": "Process name, e.g. web. Omit for all." },
                "lines": { "type": "integer", "minimum": 1, "maximum": MAX_LOG_LINES, "default": 100, "description": "How many trailing lines (max 500)." }
            }),
            &["run"],
        ),
        tool("run_url", "The local URL and status of a run.", json!({ "run": run.clone() }), &["run"]),
        tool("env_list", "List the variables set in one env layer: names, whether each is secret, and a masked preview. Secret values are never returned.", with_scope(json!({})), &["scope"]),
        tool("env_effective", "Every variable a run receives, with the layer each comes from and what it overrides. Secret values are masked.", json!({ "run": run.clone() }), &["run"]),
        tool(
            "env_set",
            "Set a variable in an env layer. For a secret, omit `value`: you get pending_user_input and must ask the user to run the command it names, so the secret never passes through you. Takes effect on the next start of each affected run.",
            with_scope(json!({
                "name": { "type": "string", "description": "Variable name, e.g. API_TOKEN." },
                "value": { "type": "string", "description": "The value. Omit for secrets." },
                "secret": { "type": "boolean", "description": "Force secret (true) or plain (false). Names containing KEY, TOKEN, SECRET or PASSWORD are secret by default." }
            })),
            &["scope", "name"],
        ),
        tool("env_unset", "Remove a variable from an env layer.", with_scope(json!({ "name": { "type": "string" } })), &["scope", "name"]),
        tool(
            "env_import",
            "Import a .env-style file into an env layer. The file is parsed by the daemon; only variable names come back. Existing variables are skipped.",
            with_scope(json!({
                "path": { "type": "string", "description": "Path of the dotenv file." },
                "preview": { "type": "boolean", "description": "Only report what would be imported." }
            })),
            &["scope", "path"],
        ),
        tool(
            "worktree_new",
            "Create a worktree for a branch in a configured project: fetches, branches from the project's base (origin/staging or the default branch, or `base`), links and copies the project's declared files, runs its setup steps (output goes to setup.log, see run_logs). Refuses an existing branch, run name or a nearly full disk. Add start=true to start it.",
            json!({
                "project": { "type": "string", "description": "Project name from run_list's run prefix." },
                "branch": { "type": "string", "description": "New branch name, e.g. feat/x. The worktree lives at <project dir>/<branch>." },
                "base": { "type": "string", "description": "Optional base ref, e.g. origin/main." },
                "start": { "type": "boolean", "description": "Start the run after creating it." }
            }),
            &["project", "branch"],
        ),
        tool("worktree_adopt", "Register an existing worktree of a configured project. Installs nothing and changes nothing in it.", json!({ "path": { "type": "string", "description": "Absolute path of the worktree." } }), &["path"]),
        tool(
            "worktree_remove",
            "Remove a worktree: stops the run, refuses if it is main, dirty (including untracked), has commits on no remote, has processes inside, is claimed, or is running; archives irreplaceable ignored files; keeps the branch. Never forces. Safe to retry after a failure.",
            json!({ "run": run.clone() }),
            &["run"],
        ),
        tool(
            "worktree_claim",
            "Claim a worktree before editing it so other agents stay out. Claim, edit, refresh by calling again with the same holder, then worktree_release. Pass your own process id so the claim ends when you do. Another live claim refuses; a stale one is taken over.",
            json!({
                "run": run.clone(),
                "holder": { "type": "string", "description": "Your name, a-z 0-9 and '-', max 40. Defaults to your MCP client name." },
                "pid": { "type": "integer", "description": "Your agent's process id." }
            }),
            &["run"],
        ),
        tool("worktree_release", "Release your claim on a worktree.", json!({ "run": run.clone(), "holder": { "type": "string", "description": "The name you claimed with. Defaults to your MCP client name." } }), &["run"]),
        tool("worktree_claims", "Who holds which worktree, with heartbeat age and whether each claim is stale.", json!({}), &[]),
        tool("worktree_removal_candidates", "Worktrees that auto-removal will delete after their grace period, with when and why. Read-only: it evaluates nothing and removes nothing. Pinned worktrees are never removed.", json!({}), &[]),
        tool("disk_report", "What each worktree's declared items (node_modules, build caches) really cost on disk, and what is cleanable.", json!({ "deps": { "type": "boolean", "description": "Also measure dependency directories (slower)." } }), &[]),
        tool("disk_clean", "Delete regenerable items of stopped runs that are past policy. Dry run unless apply=true.", json!({ "apply": { "type": "boolean", "description": "Actually delete. Default false lists what would be freed." } }), &[]),
    ]
}

fn str_arg<'a>(args: &'a Value, k: &str) -> Option<&'a str> {
    args.get(k).and_then(Value::as_str).filter(|s| !s.is_empty())
}

fn need<'a>(args: &'a Value, k: &str) -> Result<&'a str> {
    str_arg(args, k).ok_or_else(|| anyhow!("missing required argument `{k}`"))
}

/// Every daemon request from this shim goes through here, so the actor tag cannot be forgotten.
async fn daemon(mut req: Value, client: Option<&str>, write: bool) -> Result<Value> {
    req["actor"] = json!("mcp");
    if write {
        if let Some(c) = client {
            req["client"] = json!(c);
        }
    }
    api::call(req).await
}

/// Scope fields shared by the env tools. The scope value is validated by the daemon.
fn scope_req(cmd: &str, args: &Value) -> Result<Value> {
    let mut req = json!({ "cmd": cmd, "scope": need(args, "scope")? });
    if let Some(t) = str_arg(args, "target") {
        req["target"] = json!(t);
    }
    Ok(req)
}

/// The claim holder name: the `holder` argument, else the MCP client name.
fn holder(args: &Value, client: Option<&str>) -> String {
    crate::claims::sanitize_holder(str_arg(args, "holder").or(client).unwrap_or("agent"))
}

fn abs(path: &str) -> Result<String> {
    Ok(std::path::Path::new(path).canonicalize().map_err(|e| anyhow!("{path}: {e}"))?.display().to_string())
}

async fn call_tool(name: &str, args: &Value, client: Option<&str>) -> Result<Value> {
    match name {
        "run_list" => daemon(json!({ "cmd": "ls" }), client, false).await,
        "run_start" => match (str_arg(args, "path"), str_arg(args, "run")) {
            (Some(p), _) => daemon(json!({ "cmd": "up", "path": abs(p)? }), client, true).await,
            (None, Some(r)) => daemon(json!({ "cmd": "start", "run": r }), client, true).await,
            _ => bail!("give `path` (a worktree) or `run` (a registered run)"),
        },
        "run_stop" => daemon(json!({ "cmd": "down", "run": need(args, "run")?, "holder": holder(args, client) }), client, true).await,
        "run_restart" => daemon(json!({ "cmd": "restart", "run": need(args, "run")?, "holder": holder(args, client) }), client, true).await,
        "worktree_new" => {
            let mut req = json!({ "cmd": "worktree.new", "project": need(args, "project")?, "branch": need(args, "branch")?, "start": args.get("start").and_then(Value::as_bool).unwrap_or(false) });
            if let Some(b) = str_arg(args, "base") {
                req["base"] = json!(b);
            }
            daemon(req, client, true).await
        }
        "worktree_adopt" => daemon(json!({ "cmd": "worktree.adopt", "path": abs(need(args, "path")?)? }), client, true).await,
        "worktree_remove" => daemon(json!({ "cmd": "worktree.rm", "run": need(args, "run")? }), client, true).await,
        "worktree_claim" => {
            // The shim lives as long as the agent's session, so its pid is a good default.
            let pid = args.get("pid").and_then(Value::as_i64).unwrap_or(std::process::id() as i64);
            daemon(json!({ "cmd": "claim", "run": need(args, "run")?, "holder": holder(args, client), "pid": pid }), client, true).await
        }
        "worktree_release" => daemon(json!({ "cmd": "release", "run": need(args, "run")?, "holder": holder(args, client) }), client, true).await,
        "worktree_claims" => daemon(json!({ "cmd": "claims" }), client, false).await,
        "worktree_removal_candidates" => daemon(json!({ "cmd": "autoremove.candidates" }), client, false).await,
        "run_logs" => {
            let lines = args.get("lines").and_then(Value::as_u64).unwrap_or(100).clamp(1, MAX_LOG_LINES);
            let mut req = json!({ "cmd": "logs", "run": need(args, "run")?, "lines": lines });
            if let Some(p) = str_arg(args, "proc") {
                req["proc"] = json!(p);
            }
            daemon(req, client, false).await
        }
        "run_url" => {
            let key = daemon(json!({ "cmd": "resolve", "run": need(args, "run")? }), client, false).await?;
            let all = daemon(json!({ "cmd": "ls" }), client, false).await?;
            all.as_array()
                .and_then(|a| a.iter().find(|r| r["run"] == key))
                .map(|r| json!({ "run": r["run"], "url": r["url"], "status": r["status"] }))
                .ok_or_else(|| anyhow!("run {key} not found"))
        }
        "env_list" => daemon(scope_req("env.list", args)?, client, false).await,
        "env_effective" => daemon(json!({ "cmd": "env.effective", "run": need(args, "run")? }), client, false).await,
        "env_set" => {
            let mut req = scope_req("env.set", args)?;
            req["name"] = json!(need(args, "name")?);
            let Some(value) = args.get("value").and_then(Value::as_str) else {
                let target = str_arg(args, "target").map(|t| format!(" {t}")).unwrap_or_default();
                return Ok(json!({
                    "status": "pending_user_input",
                    "next": format!("Ask the user to run: setu env set {}{} {} --secret", need(args, "scope")?, target, need(args, "name")?)
                }));
            };
            req["value"] = json!(value);
            if let Some(b) = args.get("secret").and_then(Value::as_bool) {
                req["secret"] = json!(b);
            }
            daemon(req, client, true).await
        }
        "env_unset" => {
            let mut req = scope_req("env.unset", args)?;
            req["name"] = json!(need(args, "name")?);
            daemon(req, client, true).await
        }
        "env_import" => {
            let mut req = scope_req("env.import", args)?;
            req["path"] = json!(abs(need(args, "path")?)?);
            let preview = args.get("preview").and_then(Value::as_bool).unwrap_or(false);
            req["preview"] = json!(preview);
            daemon(req, client, !preview).await
        }
        "disk_report" => daemon(json!({ "cmd": "disk.report", "deps": args.get("deps").and_then(Value::as_bool).unwrap_or(false) }), client, false).await,
        "disk_clean" => {
            let apply = args.get("apply").and_then(Value::as_bool).unwrap_or(false);
            daemon(json!({ "cmd": "disk.clean", "apply": apply }), client, apply).await
        }
        other => bail!("unknown tool {other}"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_tool_has_an_object_schema() {
        let list = tools();
        assert_eq!(list.len(), 20);
        for t in &list {
            let name = t["name"].as_str().unwrap();
            assert!(!t["description"].as_str().unwrap().is_empty(), "{name}");
            assert_eq!(t["inputSchema"]["type"], "object", "{name}");
            assert!(t["inputSchema"]["properties"].is_object(), "{name}");
            for r in t["inputSchema"]["required"].as_array().unwrap() {
                assert!(t["inputSchema"]["properties"].get(r.as_str().unwrap()).is_some(), "{name} requires unknown {r}");
            }
        }
    }

    #[test]
    fn no_tool_can_reveal_a_secret() {
        for t in tools() {
            let name = t["name"].as_str().unwrap().to_lowercase();
            assert!(!name.contains("reveal") && !name.contains("get_secret"), "{name}");
        }
    }

    #[tokio::test]
    async fn handshake_records_client_and_lists_tools() {
        let mut client = None;
        let init = json!({ "jsonrpc": "2.0", "id": 1, "method": "initialize", "params": { "protocolVersion": "2025-03-26", "clientInfo": { "name": "test-client" } } });
        let r = handle(&init, &mut client).await.unwrap();
        assert_eq!(r["result"]["protocolVersion"], "2025-03-26");
        assert_eq!(client.as_deref(), Some("test-client"));
        let note = json!({ "jsonrpc": "2.0", "method": "notifications/initialized" });
        assert!(handle(&note, &mut client).await.is_none());
        let l = handle(&json!({ "jsonrpc": "2.0", "id": 2, "method": "tools/list" }), &mut client).await.unwrap();
        assert_eq!(l["result"]["tools"].as_array().unwrap().len(), 20);
        let bad = handle(&json!({ "jsonrpc": "2.0", "id": 3, "method": "tools/call", "params": { "name": "env_reveal" } }), &mut client).await.unwrap();
        assert_eq!(bad["error"]["code"], -32602);
    }

    #[tokio::test]
    async fn secret_env_set_without_value_never_reaches_the_daemon() {
        let r = call_tool("env_set", &json!({ "scope": "project", "target": "app", "name": "API_TOKEN" }), None).await.unwrap();
        assert_eq!(r["status"], "pending_user_input");
        assert_eq!(r["next"], "Ask the user to run: setu env set project app API_TOKEN --secret");
    }
}
