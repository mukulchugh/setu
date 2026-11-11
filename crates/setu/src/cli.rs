//! `setu-rs <command>`. Everything except `daemon` and `logs` talks to the daemon socket.

use crate::api;
use crate::paths;
use anyhow::{anyhow, bail, Result};
use serde_json::{json, Value};

const USAGE: &str = "\
setu-rs: run every worktree's app and workers at its own local URL

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
  setu-rs env set <scope> [target] NAME=value
  setu-rs env unset <scope> [target] NAME
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
            }
            Ok(())
        }
        Some("logs") => logs(&args[1..]).await,
        Some("disk") => disk(&args[1..]).await,
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
    let action = args.first().map(String::as_str).ok_or_else(|| anyhow!("env needs ls, set or unset"))?;
    let scope = args.get(1).map(String::as_str).ok_or_else(|| anyhow!("env needs a scope: global, project or worktree"))?;
    let (target, rest) = if scope == "global" { (None, &args[2..]) } else { (args.get(2).cloned(), args.get(3..).unwrap_or(&[])) };
    let mut req = json!({ "scope": scope });
    if let Some(t) = &target {
        req["target"] = json!(t);
    }
    match action {
        "ls" => {
            let out = api::call(with_cmd("env.get", req)).await?;
            println!("# {}", out["path"].as_str().unwrap_or(""));
            if let Some(env) = out["env"].as_object() {
                for (k, v) in env {
                    println!("{k}={}", v.as_str().unwrap_or(""));
                }
            }
            Ok(())
        }
        "set" => {
            let pair = rest.first().ok_or_else(|| anyhow!("env set needs NAME=value"))?;
            let (name, value) = pair.split_once('=').ok_or_else(|| anyhow!("env set needs NAME=value"))?;
            req["name"] = json!(name);
            req["value"] = json!(value);
            api::call(with_cmd("env.set", req)).await?;
            println!("set {name} ({scope}); applies the next time each affected run starts");
            Ok(())
        }
        "unset" => {
            let name = rest.first().ok_or_else(|| anyhow!("env unset needs NAME"))?;
            req["name"] = json!(name);
            api::call(with_cmd("env.set", req)).await?;
            println!("unset {name} ({scope})");
            Ok(())
        }
        _ => bail!("env needs ls, set or unset"),
    }
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
