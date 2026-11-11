//! `setu-rs <command>`. Everything except `daemon` and `logs` talks to the daemon socket.

use crate::api;
use crate::paths;
use anyhow::{anyhow, bail, Result};
use serde_json::{json, Value};

const USAGE: &str = "\
setu-rs: run every worktree's app and workers at its own local URL

  setu-rs setup [--dry-run] [--yes] [--undo]
                                     one-time setup: login PATH, start at login, custom domains
  setu-rs doctor [--json]            check every layer and print the exact fix
  setu-rs daemon                     run the daemon in the foreground
  setu-rs up [path]                  start the run for a worktree (default: current dir)
  setu-rs down [run]                 stop a run (default: the current worktree's)
  setu-rs ls [--json]                list runs with URL, status and RAM
  setu-rs logs [run] [proc] [-f]     show or follow logs
  setu-rs pin|unpin [run]            keep a run up, or let idle stop it again
  setu-rs disk [--deps] [--json]     what each worktree's declared items really cost
  setu-rs disk clean [--apply] [--include-unmanaged]
                                     delete regenerable items of stopped runs past policy
  setu-rs env ls <scope> [target]    scope: global | project <name> | worktree <run>
  setu-rs env effective [run]        every var a run gets, and which layer it comes from
  setu-rs env set <scope> [target] NAME=value [--secret|--plain]
  setu-rs env set <scope> [target] NAME --secret      type the value hidden
  setu-rs env unset <scope> [target] NAME
  setu-rs env import <scope> [target] <file> [--preview] [--overwrite]
  setu-rs env reveal <scope> [target] NAME          prints one value (audited)
  setu-rs mcp                        MCP server over stdio for AI agents (no secrets, no reveal)
";

pub fn main() -> i32 {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let rt = match tokio::runtime::Builder::new_current_thread().enable_all().build() {
        Ok(rt) => rt,
        Err(e) => {
            eprintln!("setu-rs: {e}");
            return 1;
        }
    };
    match rt.block_on(dispatch(args)) {
        Ok(()) => 0,
        Err(e) => {
            eprintln!("setu-rs: {e:#}");
            1
        }
    }
}

fn cwd() -> Result<String> {
    Ok(std::env::current_dir()?.canonicalize()?.display().to_string())
}

/// A run argument, or the worktree we are standing in.
fn target(arg: Option<&String>) -> Result<Value> {
    Ok(match arg {
        Some(run) => json!({ "run": run }),
        None => json!({ "path": cwd()? }),
    })
}

fn with_cmd(cmd: &str, mut v: Value) -> Value {
    v["cmd"] = json!(cmd);
    v
}

async fn dispatch(args: Vec<String>) -> Result<()> {
    let first = args.first().map(String::as_str);
    match first {
        None | Some("-h" | "--help" | "help") => {
            print!("{USAGE}");
            Ok(())
        }
        Some("daemon") => crate::daemon::run().await,
        Some("mcp") => crate::mcp::run().await,
        Some("up") => {
            let path = match args.get(1) {
                Some(p) => std::path::Path::new(p).canonicalize()?.display().to_string(),
                None => cwd()?,
            };
            let run = api::call(json!({ "cmd": "up", "path": path })).await?;
            println!("{} starting at {}", run["run"].as_str().unwrap_or("?"), run["url"].as_str().unwrap_or("?"));
            println!("  `setu-rs ls` shows when it is up; `setu-rs logs -f` follows its output");
            Ok(())
        }
        Some("down") => {
            let run = api::call(with_cmd("down", target(args.get(1))?)).await?;
            println!("{} stopped", run["run"].as_str().unwrap_or("?"));
            Ok(())
        }
        Some(c @ ("pin" | "unpin")) => {
            let run = api::call(with_cmd(c, target(args.get(1))?)).await?;
            println!("{} {}", run["run"].as_str().unwrap_or("?"), if c == "pin" { "pinned: idle stop is off" } else { "unpinned" });
            Ok(())
        }
        Some("ls") => {
            let runs = api::call(json!({ "cmd": "ls" })).await?;
            if args.iter().any(|a| a == "--json") {
                println!("{}", serde_json::to_string_pretty(&runs)?);
                return Ok(());
            }
            let list = runs.as_array().cloned().unwrap_or_default();
            if list.is_empty() {
                println!("no runs yet. In a worktree, run `setu-rs up`.");
            }
            for r in list {
                let mb = r["ram_bytes"].as_u64().unwrap_or(0) / (1024 * 1024);
                println!(
                    "{:<44} {:<9} {:>6} MB{}  {}{}",
                    r["run"].as_str().unwrap_or("?"),
                    r["status"].as_str().unwrap_or("?"),
                    mb,
                    if r["pinned"].as_bool() == Some(true) { " pinned" } else { "" },
                    r["url"].as_str().unwrap_or(""),
                    r["note"].as_str().map(|n| format!("  ({n})")).unwrap_or_default(),
                );
                if r["stale_env"].as_bool() == Some(true) {
                    println!("    env changed since this run started; `setu-rs down` then `setu-rs up` to apply");
                }
            }
            Ok(())
        }
        Some("logs") => logs(&args[1..]).await,
        Some("disk") => disk(&args[1..]).await,
        Some("setup") => setup_cmd(&args[1..]).await,
        Some("doctor") => doctor_cmd(&args[1..]).await,
        Some("--version" | "version") => {
            println!("setu-rs {}", env!("CARGO_PKG_VERSION"));
            Ok(())
        }
        Some("env") => env(&args[1..]).await,
        Some(other) => bail!("unknown command {other}\n\n{USAGE}"),
    }
}

async fn logs(args: &[String]) -> Result<()> {
    let follow = args.iter().any(|a| a == "-f");
    let rest: Vec<&String> = args.iter().filter(|a| *a != "-f").collect();
    let key = api::call(with_cmd("resolve", target(rest.first().copied())?)).await?;
    let key = key.as_str().ok_or_else(|| anyhow!("no run"))?.to_string();
    let dir = paths::logs_dir().join(&key);
    let files: Vec<String> = match rest.get(1) {
        Some(proc) => vec![dir.join(format!("{proc}.log")).display().to_string()],
        None => std::fs::read_dir(&dir)
            .map_err(|_| anyhow!("no logs yet for {key}"))?
            .filter_map(|e| e.ok())
            .map(|e| e.path())
            .filter(|p| p.extension().and_then(|x| x.to_str()) == Some("log"))
            .map(|p| p.display().to_string())
            .collect(),
    };
    let mut cmd = std::process::Command::new("tail");
    cmd.arg("-n").arg("100");
    if follow {
        cmd.arg("-F");
    }
    let status = cmd.args(&files).status()?;
    if !status.success() && !follow {
        bail!("tail failed");
    }
    Ok(())
}

async fn env(args: &[String]) -> Result<()> {
    let action = args.first().map(String::as_str).ok_or_else(|| anyhow!("env needs ls, effective, set, unset, import or reveal"))?;
    let flag = |f: &str| args.iter().any(|a| a == f);
    let pos: Vec<&String> = args.iter().skip(1).filter(|a| !a.starts_with("--")).collect();
    if action == "effective" {
        let run = match pos.first() {
            Some(r) => r.to_string(),
            None => api::call(json!({ "cmd": "resolve", "path": cwd()? })).await?.as_str().unwrap_or_default().to_string(),
        };
        let out = api::call(json!({ "cmd": "env.effective", "run": run })).await?;
        println!("# env for {}", out["run"].as_str().unwrap_or(""));
        for v in out["vars"].as_array().cloned().unwrap_or_default() {
            let over = v["overrides"].as_array().filter(|a| !a.is_empty()).map(|a| {
                format!("  (overrides {})", a.iter().filter_map(|x| x.as_str()).collect::<Vec<_>>().join(", "))
            });
            println!(
                "{:<36} {:<15} {}{}",
                v["name"].as_str().unwrap_or(""),
                v["source"].as_str().unwrap_or(""),
                preview(&v),
                over.unwrap_or_default()
            );
        }
        return Ok(());
    }
    // <scope> [target] ...: global takes no target.
    let scope = pos.first().map(|s| s.as_str()).ok_or_else(|| anyhow!("env {action} needs a scope: global, project <name> or worktree <run>"))?;
    let (target, rest): (Option<String>, Vec<&String>) = if scope == "global" {
        (None, pos[1..].to_vec())
    } else {
        (pos.get(1).map(|s| s.to_string()), pos.get(2..).map(|r| r.to_vec()).unwrap_or_default())
    };
    let mut req = json!({ "scope": scope });
    if let Some(t) = &target {
        req["target"] = json!(t);
    }
    match action {
        "ls" => {
            let out = api::call(with_cmd("env.list", req)).await?;
            for v in out["vars"].as_array().cloned().unwrap_or_default() {
                println!("{:<36} {}{}", v["name"].as_str().unwrap_or(""), preview(&v), if v["secret"].as_bool() == Some(true) { "  [secret]" } else { "" });
            }
            Ok(())
        }
        "set" => {
            let arg = rest.first().ok_or_else(|| anyhow!("env set needs NAME=value, or NAME --secret to type it hidden"))?;
            let (name, value) = match arg.split_once('=') {
                Some((n, v)) => (n.to_string(), v.to_string()),
                None => (arg.to_string(), read_hidden(&format!("value for {arg}: "))?),
            };
            req["name"] = json!(name);
            req["value"] = json!(value);
            if flag("--secret") {
                req["secret"] = json!(true);
            } else if flag("--plain") {
                req["secret"] = json!(false);
            }
            let out = api::call(with_cmd("env.set", req)).await?;
            println!(
                "set {name} in {scope}{} ({}); applies the next time each affected run starts",
                target.map(|t| format!(" {t}")).unwrap_or_default(),
                if out["secret"].as_bool() == Some(true) { "secret" } else { "plain" }
            );
            Ok(())
        }
        "unset" => {
            req["name"] = json!(rest.first().ok_or_else(|| anyhow!("env unset needs NAME"))?);
            let out = api::call(with_cmd("env.unset", req)).await?;
            println!("{}", if out["existed"].as_bool() == Some(true) { "unset" } else { "was not set" });
            Ok(())
        }
        "import" => {
            let file = rest.first().ok_or_else(|| anyhow!("env import <scope> [target] <file> [--preview] [--overwrite]"))?;
            req["path"] = json!(std::path::Path::new(file.as_str()).canonicalize()?.display().to_string());
            req["preview"] = json!(flag("--preview"));
            req["overwrite"] = json!(flag("--overwrite"));
            let out = api::call(with_cmd("env.import", req)).await?;
            let names = |k: &str| out[k].as_array().map(|a| a.iter().filter_map(|x| x.as_str()).collect::<Vec<_>>().join(", ")).unwrap_or_default();
            let verb = if flag("--preview") { "would import" } else { "imported" };
            println!("{verb}: {}", names("imported"));
            if !names("skipped").is_empty() {
                println!("skipped (already set; use --overwrite): {}", names("skipped"));
            }
            if !names("secrets").is_empty() {
                println!("stored as secrets: {}", names("secrets"));
            }
            if !names("problems").is_empty() {
                println!("problems: {}", names("problems"));
            }
            Ok(())
        }
        "reveal" => {
            req["name"] = json!(rest.first().ok_or_else(|| anyhow!("env reveal needs NAME"))?);
            let out = api::call(with_cmd("env.reveal", req)).await?;
            println!("{}", out["value"].as_str().unwrap_or(""));
            Ok(())
        }
        _ => bail!("env needs ls, effective, set, unset, import or reveal"),
    }
}

fn preview(v: &Value) -> String {
    match (v["secret"].as_bool(), v["preview"].as_str()) {
        (Some(true), Some(p)) => p.to_string(),
        (Some(true), None) => "••••••".into(),
        (_, Some(p)) => p.to_string(),
        _ => String::new(),
    }
}

/// Read a value from the terminal without echo (falls back to a plain stdin line).
fn read_hidden(prompt: &str) -> Result<String> {
    use std::io::{BufRead, Write};
    eprint!("{prompt}");
    std::io::stderr().flush()?;
    let tty = std::process::Command::new("stty").arg("-echo").stdin(std::fs::File::open("/dev/tty")?).status();
    let mut line = String::new();
    let read = std::io::stdin().lock().read_line(&mut line);
    if tty.is_ok() {
        let _ = std::process::Command::new("stty").arg("echo").stdin(std::fs::File::open("/dev/tty")?).status();
        eprintln!();
    }
    read?;
    let value = line.trim_end_matches(['\n', '\r']).to_string();
    if value.is_empty() {
        bail!("no value entered");
    }
    Ok(value)
}

async fn disk(args: &[String]) -> Result<()> {
    use crate::disk::{human_bytes, human_secs};
    let flag = |f: &str| args.iter().any(|a| a == f);
    if args.first().map(String::as_str) == Some("clean") {
        let apply = flag("--apply");
        let out = api::call(json!({ "cmd": "disk.clean", "apply": apply, "include_unmanaged": flag("--include-unmanaged") })).await?;
        let items = out["items"].as_array().cloned().unwrap_or_default();
        if items.is_empty() {
            println!("nothing to clean: no stopped run has items past their policy");
            return Ok(());
        }
        let mut est: u64 = 0;
        for i in &items {
            let size = i["size"]["private"].as_u64().unwrap_or(0);
            est += size;
            match (apply, i["error"].as_str()) {
                (true, Some(e)) => println!("  kept  {}  ({e})", i["path"].as_str().unwrap_or("")),
                (true, None) => println!("  freed {:>10}  {}", human_bytes(i["freed_bytes"].as_i64().unwrap_or(0).max(0) as u64), i["path"].as_str().unwrap_or("")),
                (false, _) => println!("  would free {:>10}  {}  ({})", human_bytes(size), i["path"].as_str().unwrap_or(""), i["reason"].as_str().unwrap_or("")),
            }
        }
        if apply {
            println!("volume free space changed by {}", human_bytes(out["freed_bytes"].as_i64().unwrap_or(0).max(0) as u64));
        } else {
            println!("about {} would be freed. Run `setu-rs disk clean --apply` to do it.", human_bytes(est));
        }
        return Ok(());
    }
    let out = api::call(json!({ "cmd": "disk.report", "deps": flag("--deps") })).await?;
    if flag("--json") {
        println!("{}", serde_json::to_string_pretty(&out)?);
        return Ok(());
    }
    let now = crate::disk::now_secs();
    let mut total: u64 = 0;
    let mut reclaim: u64 = 0;
    for w in out["worktrees"].as_array().cloned().unwrap_or_default() {
        let status = w["status"].as_str().unwrap_or("not run by setu");
        let stopped = w["stopped_at"].as_u64().map(|s| format!(", stopped {} ago", human_secs(now.saturating_sub(s)))).unwrap_or_default();
        println!("{}  [{status}{stopped}]", w["run"].as_str().unwrap_or("?"));
        let items = w["items"].as_array().cloned().unwrap_or_default();
        let all_paths: Vec<String> = items.iter().map(|i| i["path"].as_str().unwrap_or("").to_string()).collect();
        for i in items {
            let private = i["size"]["private"].as_u64();
            let logical = i["size"]["logical"].as_u64();
            let path = i["path"].as_str().unwrap_or("");
            // Count each byte once: an item inside another listed item is already in its parent's size.
            let nested = all_paths.iter().any(|p| p != path && path.starts_with(&format!("{p}/")));
            if !nested {
                total += private.unwrap_or(0);
                if i["eligible"].as_bool() == Some(true) {
                    reclaim += private.unwrap_or(0);
                }
            }
            let size = match (private, logical) {
                (Some(p), Some(l)) if l > p * 2 && l > 64 << 20 => format!("{} ({} shared)", human_bytes(p), human_bytes(l - p)),
                (Some(p), _) => human_bytes(p),
                _ => "not measured".into(),
            };
            println!(
                "   {:<16} {:>22}  {}  {}",
                i["item"].as_str().unwrap_or(""),
                size,
                if i["eligible"].as_bool() == Some(true) { "cleanable" } else { "kept" },
                i["path"].as_str().unwrap_or("")
            );
        }
    }
    for s in out["stores"].as_array().cloned().unwrap_or_default() {
        let warn = if s["low"].as_bool() == Some(true) { "  LOW: the next install will re-download everything" } else { "" };
        println!("store {:<12} {:>10}  {}{warn}", s["name"].as_str().unwrap_or(""), human_bytes(s["logical"].as_u64().unwrap_or(0)), s["path"].as_str().unwrap_or(""));
    }
    println!(
        "\nmeasured items: {} of their own data; cleanable now: {}; volume free: {}",
        human_bytes(total),
        human_bytes(reclaim),
        human_bytes(out["free_bytes"].as_u64().unwrap_or(0))
    );
    Ok(())
}

async fn setup_cmd(args: &[String]) -> Result<()> {
    use crate::globalcfg::GlobalConfig;
    use crate::setup::{self, Layout, RealSys};
    let flag = |f: &str| args.iter().any(|a| a == f);
    let sys = RealSys;
    let layout = Layout::real();
    if flag("--undo") {
        for line in setup::undo(&layout, &sys)? {
            println!("{line}");
        }
        return Ok(());
    }
    let mut gcfg = GlobalConfig::load()?;
    let domains: Vec<String> = crate::config::load_all()?.into_iter().map(|c| c.domain).collect();
    let binary = setup::stable_binary_path();
    let steps = setup::plan(&gcfg, &domains, &binary, &sys);
    if steps.is_empty() {
        println!("everything is already set up. `setu-rs doctor` checks it.");
        return Ok(());
    }
    println!("setu-rs setup will:");
    for s in &steps {
        println!("  {} {}", if s.sudo { "[sudo]" } else { "      " }, s.description);
    }
    if flag("--dry-run") {
        return Ok(());
    }
    if !flag("--yes") {
        use std::io::{BufRead, Write};
        print!("continue? [y/N] ");
        std::io::stdout().flush()?;
        let mut line = String::new();
        std::io::stdin().lock().read_line(&mut line)?;
        if !matches!(line.trim(), "y" | "Y" | "yes") {
            println!("nothing changed");
            return Ok(());
        }
    }
    let record = setup::apply(&steps, &mut gcfg, &binary, &layout, &sys)?;
    println!("done. Recorded in {}. Undo with `setu-rs setup --undo`.", setup::record_path().display());
    if let Some(p) = record.plist {
        println!("daemon starts at login from {p}");
    }
    Ok(())
}

async fn doctor_cmd(args: &[String]) -> Result<()> {
    use crate::doctor::{self, DoctorInputs};
    use crate::globalcfg::GlobalConfig;
    use crate::setup::{RealSys, Sys, LABEL};
    let sys = RealSys;
    let gcfg = GlobalConfig::load()?;
    let daemon_ping = api::call(json!({ "cmd": "ping" }))
        .await
        .ok()
        .and_then(|v| v["version"].as_str().map(String::from));
    let launch_agent_loaded = sys
        .run("launchctl", &["print", &format!("gui/{}/{LABEL}", sys.uid())])
        .map(|(code, _)| code == 0)
        .unwrap_or(false);
    let proxy_listening = std::net::TcpStream::connect_timeout(
        &std::net::SocketAddr::from(([127, 0, 0, 1], gcfg.proxy_port)),
        std::time::Duration::from_millis(300),
    )
    .is_ok();
    let checks = doctor::run(
        DoctorInputs {
            daemon_ping,
            cli_version: env!("CARGO_PKG_VERSION").to_string(),
            launch_agent_loaded,
            gcfg,
            projects: crate::config::load_all()?,
            proxy_listening,
        },
        &sys,
    );
    let failed = checks.iter().filter(|c| !c.ok).count();
    if args.iter().any(|a| a == "--json") {
        let v: Vec<Value> = checks.iter().map(|c| json!({ "name": c.name, "ok": c.ok, "detail": c.detail, "fix": c.fix })).collect();
        println!("{}", serde_json::to_string_pretty(&v)?);
    } else {
        for c in &checks {
            println!("{} {:<34} {}", if c.ok { "ok  " } else { "FAIL" }, c.name, c.detail);
            if let (false, Some(fix)) = (c.ok, &c.fix) {
                println!("       fix: {fix}");
            }
        }
        println!("{}", if failed == 0 { "all good".to_string() } else { format!("{failed} check(s) failed") });
    }
    if failed > 0 {
        bail!("doctor found {failed} problem(s)");
    }
    Ok(())
}
