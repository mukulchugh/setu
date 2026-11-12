//! `setu migrate`: move this machine from the old JS Setu (v1) to this one. Plan: docs/slices/10-cutover.md,
//! teammate guide: docs/MIGRATING.md.
//!
//!   setu migrate [plan]       read-only: what was found and what would change
//!   setu migrate run --yes    do it (stops at the first failure)
//!   setu migrate rollback     undo it from the step-0 backups
//!
//! Every step is appended to the ledger (`<data>/cutover-ledger.jsonl`, shared with `setu import-v1`).
//! Backups go to `<data>/cutover-<ts>/`. `<data>` is `$SETU_HOME`, else `~/.local/share/setu`.
//!
//! Order: 0 preflight, 1 review, 3 install, 4 stop v1, 5 setup, 2 adopt, 6 MCP, 7 verify. Adoption
//! (2) writes through the new daemon, and the daemon should come up on :80 first, otherwise every
//! adopted run would carry a :7777 URL.
//!
//! Nothing here assumes one machine's layout: the v1 portal is found by its command line, Caddy by
//! brew services or a LaunchAgent (or not at all), and each missing piece just skips its step.
//! Test hooks (harmless otherwise): HOME, SETU_HOME, SETU_LINK_DIR (where the `setu` link goes).

use crate::mcpcfg::{self, Fmt, Touched};
use crate::{cutover, globalcfg, naming, paths};
use anyhow::{anyhow, bail, Context, Result};
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

// ------------------------------------------------------------------------------------ context

struct Cx {
    home: PathBuf,
    data: PathBuf,
    ws: PathBuf,
    zone: String,
    link_dir: PathBuf,
    exe: PathBuf,
}

impl Cx {
    fn new() -> Result<Cx> {
        let home = paths::expand("~");
        let data = cutover::ledger_path().parent().map(Path::to_path_buf).unwrap_or_else(|| home.join(".local/share/setu"));
        let (ws, zone) = cutover::read_v1_settings();
        let link_dir = std::env::var_os("SETU_LINK_DIR").map(PathBuf::from).unwrap_or_else(|| home.join(".local/bin"));
        let exe = std::env::current_exe().context("finding the running binary")?;
        Ok(Cx { home, data, ws, zone, link_dir, exe: exe.canonicalize().unwrap_or(exe) })
    }
    fn uid(&self) -> u32 {
        unsafe { libc::getuid() }
    }
}

fn led(step: &str, status: &str, detail: &str) {
    let _ = cutover::ledger_append(json!({ "source": "setu-migrate", "step": step, "status": status, "detail": detail }));
}

fn run_cmd(cmd: &str, args: &[&str]) -> Option<(i32, String)> {
    let out = Command::new(cmd).args(args).stdin(Stdio::null()).stderr(Stdio::null()).output().ok()?;
    Some((out.status.code().unwrap_or(-1), String::from_utf8_lossy(&out.stdout).into_owned()))
}

// ------------------------------------------------------------------------------------- detection

#[derive(Debug, Clone, PartialEq)]
struct Proc {
    pid: i32,
    uid: u32,
    cmd: String,
}

fn parse_ps_line(l: &str) -> Option<Proc> {
    let (pid, rest) = l.trim_start().split_once(char::is_whitespace)?;
    let (uid, cmd) = rest.trim_start().split_once(char::is_whitespace)?;
    Some(Proc { pid: pid.parse().ok()?, uid: uid.parse().ok()?, cmd: cmd.trim().to_string() })
}

fn process_table() -> Vec<Proc> {
    run_cmd("ps", &["-axo", "pid=,uid=,command="]).map(|(_, out)| out.lines().filter_map(parse_ps_line).collect()).unwrap_or_default()
}

/// Is this command line the v1 portal? A runtime (or the script itself) running a `portal.js`
/// under a `.setu` folder, whatever the bun path or port. An editor or `tail` with the file open
/// is not.
fn is_portal_cmd(cmd: &str) -> bool {
    let toks: Vec<&str> = cmd.split_whitespace().collect();
    let Some(script) = toks.iter().position(|t| t.ends_with(".setu/portal.js")) else { return false };
    let base = |t: &str| t.rsplit('/').next().unwrap_or(t).to_string();
    script == 0 || ["bun", "node", "nodejs", "deno", "sh", "bash", "zsh", "env"].contains(&base(toks[0]).as_str())
}

/// Where the portal script lives (its folder is v1's install dir).
fn portal_script(cmd: &str) -> Option<PathBuf> {
    cmd.split_whitespace().find(|t| t.ends_with(".setu/portal.js")).map(PathBuf::from)
}

#[derive(Debug, Clone)]
struct Portal {
    proc_: Proc,
    ports: Vec<u16>,
}

/// The user's own v1 portals: the script must live under this home folder (a v1 install is `~/.setu`),
/// so another account's, or another home's, portal is never touched.
fn find_portals(procs: &[Proc], uid: u32, me: i32, home: &Path) -> Vec<Portal> {
    let canon_home = home.canonicalize().unwrap_or_else(|_| home.to_path_buf());
    procs
        .iter()
        .filter(|p| p.uid == uid && p.pid != me && is_portal_cmd(&p.cmd))
        .filter(|p| portal_script(&p.cmd).is_some_and(|s| s.starts_with(home) || s.starts_with(&canon_home)))
        .map(|p| Portal { proc_: p.clone(), ports: listen_ports(p.pid) })
        .collect()
}

fn listen_ports(pid: i32) -> Vec<u16> {
    let Some((_, out)) = run_cmd("lsof", &["-nP", "-a", "-p", &pid.to_string(), "-iTCP", "-sTCP:LISTEN", "-Fn"]) else { return vec![] };
    let mut v: Vec<u16> = out.lines().filter_map(|l| l.strip_prefix('n')?.rsplit(':').next()?.parse().ok()).collect();
    v.sort_unstable();
    v.dedup();
    v
}

#[derive(Debug, Clone, PartialEq)]
enum Caddy {
    Brew,
    Agent { label: String, plist: PathBuf },
    /// A caddy holds :80 but nothing we know how to stop cleanly.
    Holder(String),
    None,
}

fn brew_services() -> Vec<(String, String)> {
    run_cmd("brew", &["services", "list"])
        .map(|(_, out)| out.lines().filter_map(|l| {
            let mut it = l.split_whitespace();
            Some((it.next()?.to_string(), it.next()?.to_string()))
        }).collect())
        .unwrap_or_default()
}

fn port80_holder() -> Option<String> {
    let (_, out) = run_cmd("lsof", &["-nP", "-iTCP:80", "-sTCP:LISTEN"])?;
    let l = out.lines().nth(1)?;
    let mut it = l.split_whitespace();
    Some(format!("{} (pid {})", it.next()?, it.next()?))
}

fn detect_caddy(cx: &Cx, services: &[(String, String)]) -> Caddy {
    if services.iter().any(|(n, s)| n == "caddy" && s == "started") {
        return Caddy::Brew;
    }
    if let Ok(rd) = std::fs::read_dir(cx.home.join("Library/LaunchAgents")) {
        let mut plists: Vec<PathBuf> = rd.filter_map(Result::ok).map(|e| e.path()).filter(|p| p.extension().is_some_and(|e| e == "plist") && p.file_name().is_some_and(|n| n.to_string_lossy().to_lowercase().contains("caddy"))).collect();
        plists.sort();
        for plist in plists {
            let Some(label) = plist.file_stem().map(|s| s.to_string_lossy().into_owned()) else { continue };
            if run_cmd("launchctl", &["print", &format!("gui/{}/{label}", cx.uid())]).is_some_and(|(c, _)| c == 0) {
                return Caddy::Agent { label, plist };
            }
        }
    }
    match port80_holder() {
        Some(h) if h.to_lowercase().starts_with("caddy") => Caddy::Holder(h),
        _ => Caddy::None,
    }
}

/// v1 CLI links: `~/.bun/bin/setu` and any `setu` symlink on PATH that points into a v1 install.
fn find_v1_links(cx: &Cx, v1_dirs: &[PathBuf]) -> Vec<(PathBuf, PathBuf)> {
    let mut dirs: Vec<PathBuf> = vec![cx.home.join(".bun/bin")];
    if let Some(p) = std::env::var_os("PATH") {
        dirs.extend(std::env::split_paths(&p));
    }
    let mut out: Vec<(PathBuf, PathBuf)> = Vec::new();
    for d in dirs {
        let link = d.join("setu");
        let Ok(target) = std::fs::read_link(&link) else { continue };
        let abs = if target.is_absolute() { target.clone() } else { d.join(&target) };
        let in_v1 = v1_dirs.iter().any(|v| abs.starts_with(v)) || link == cx.home.join(".bun/bin/setu");
        if in_v1 && !out.iter().any(|(l, _)| *l == link) {
            out.push((link, target));
        }
    }
    out
}

// ------------------------------------------------------------------------------------- install

#[derive(Debug, PartialEq)]
struct InstallPlan {
    /// The path the LaunchAgent and the MCP configs use.
    bin: PathBuf,
    /// Copy the running binary here (temp file, then rename); `None` under Homebrew.
    copy_to: Option<PathBuf>,
    /// Link this name to `bin` for the shell; `None` under Homebrew (its own bin is on PATH).
    link: Option<PathBuf>,
    homebrew: bool,
}

/// The Homebrew prefix the binary lives under, if any.
fn brew_prefix(exe: &Path) -> Option<PathBuf> {
    let s = exe.to_string_lossy();
    if let Some(i) = s.find("/Cellar/") {
        return Some(PathBuf::from(&s[..i]));
    }
    ["/opt/homebrew", "/home/linuxbrew/.linuxbrew"].iter().find(|p| exe.starts_with(p)).map(PathBuf::from)
}

fn install_plan(exe: &Path, data: &Path, link_dir: &Path, exists: &dyn Fn(&Path) -> bool) -> InstallPlan {
    if let Some(prefix) = brew_prefix(exe) {
        // Homebrew's stable symlink survives upgrades.
        let stable = [prefix.join("opt/setu/bin/setu"), prefix.join("bin/setu")].into_iter().find(|p| exists(p)).unwrap_or_else(|| exe.to_path_buf());
        return InstallPlan { bin: stable, copy_to: None, link: None, homebrew: true };
    }
    let dest = data.join("bin/setu");
    InstallPlan { copy_to: (exe != dest).then(|| dest.clone()), bin: dest, link: Some(link_dir.join("setu")), homebrew: false }
}

fn path_has(dir: &Path) -> bool {
    std::env::var_os("PATH").is_some_and(|p| std::env::split_paths(&p).any(|d| d == dir))
}

// ------------------------------------------------------------------------------------- MCP clients

#[derive(Debug, Clone)]
struct ClientFile {
    label: String,
    path: PathBuf,
    fmt: Fmt,
}

/// The main worktree of each v1 project (where a repo-level `.mcp.json` would live).
fn main_worktrees(cx: &Cx) -> Vec<PathBuf> {
    let Ok(text) = std::fs::read_to_string(cx.ws.join(".projects")) else { return vec![] };
    let mut out = Vec::new();
    for l in text.lines() {
        let name = l.split(':').next().unwrap_or("").trim();
        if name.is_empty() || name.starts_with('#') {
            continue;
        }
        let bare = cx.ws.join(format!("{name}.git"));
        let found = cutover::list_entries(&bare).ok().and_then(|es| {
            let pd = naming::project_dir(&bare);
            es.iter().find(|e| !e.prunable && naming::run_name(&pd, &e.path) == "main").map(|e| e.path.clone())
        });
        let wt = found.unwrap_or_else(|| cx.ws.join(name).join("main"));
        if !out.contains(&wt) {
            out.push(wt);
        }
    }
    out
}

fn client_files(cx: &Cx) -> Vec<ClientFile> {
    let h = &cx.home;
    let mut v = vec![
        ClientFile { label: "Claude Code".into(), path: h.join(".claude.json"), fmt: Fmt::ClaudeJson },
        ClientFile { label: "Codex".into(), path: h.join(".codex/config.toml"), fmt: Fmt::Codex },
        ClientFile { label: "Cursor".into(), path: h.join(".cursor/mcp.json"), fmt: Fmt::Plain },
        ClientFile { label: "Claude Desktop".into(), path: h.join("Library/Application Support/Claude/claude_desktop_config.json"), fmt: Fmt::Plain },
        ClientFile { label: "Gemini".into(), path: h.join(".gemini/settings.json"), fmt: Fmt::Plain },
    ];
    for wt in main_worktrees(cx) {
        let name = wt.parent().and_then(|p| p.file_name()).map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
        v.push(ClientFile { label: format!("{name} .mcp.json"), path: wt.join(".mcp.json"), fmt: Fmt::McpJson });
    }
    v
}

fn repoint_text(f: &ClientFile, text: &str, cmd: &str, ports: &[u16]) -> Result<Option<(String, Value)>> {
    Ok(match f.fmt {
        Fmt::Codex => mcpcfg::toml_repoint(text, cmd, ports)?.map(|(t, names)| (t, json!(names))),
        fmt => mcpcfg::json_repoint(text, fmt, cmd, ports)?.map(|(t, touched)| (t, json!(touched.iter().map(|x| json!({ "path": x.path, "key": x.key })).collect::<Vec<_>>()))),
    })
}

fn touched_from_json(v: &Value) -> Vec<Touched> {
    v.as_array().map(|a| a.iter().filter_map(|x| Some(Touched { path: x["path"].as_array()?.iter().filter_map(|p| p.as_str().map(String::from)).collect(), key: x["key"].as_str()?.to_string() })).collect()).unwrap_or_default()
}

fn sha256_of(path: &Path) -> Option<String> {
    run_cmd("shasum", &["-a", "256", &path.to_string_lossy()]).and_then(|(c, o)| (c == 0).then(|| o.split_whitespace().next().map(String::from)).flatten())
}

fn atomic_write(path: &Path, text: &str) -> Result<()> {
    // A config that is a symlink (dotfile managers do this) stays a symlink: write the file it points at.
    let resolved = path.canonicalize().unwrap_or_else(|_| path.to_path_buf());
    let path = resolved.as_path();
    let dir = path.parent().unwrap_or_else(|| Path::new("."));
    let tmp = dir.join(format!(".setu-migrate-{}", std::process::id()));
    std::fs::write(&tmp, text)?;
    if let Ok(md) = std::fs::metadata(path) {
        let _ = std::fs::set_permissions(&tmp, md.permissions());
    }
    std::fs::rename(&tmp, path).inspect_err(|_| {
        let _ = std::fs::remove_file(&tmp);
    })?;
    Ok(())
}

// ------------------------------------------------------------------------------------- backups

struct Bk {
    dir: PathBuf,
}

impl Bk {
    fn flag(&self, name: &str, val: &str) -> Result<()> {
        std::fs::create_dir_all(self.dir.join("flags"))?;
        std::fs::write(self.dir.join("flags").join(name), format!("{val}\n"))?;
        Ok(())
    }
    fn flagged(&self, name: &str) -> bool {
        self.dir.join("flags").join(name).exists()
    }
    fn val(&self, name: &str) -> Option<String> {
        std::fs::read_to_string(self.dir.join("flags").join(name)).ok().map(|s| s.trim_end().to_string()).filter(|s| !s.is_empty())
    }
}

fn backups(data: &Path) -> Vec<PathBuf> {
    let mut v: Vec<PathBuf> = std::fs::read_dir(data).map(|rd| rd.filter_map(Result::ok).map(|e| e.path()).filter(|p| p.is_dir() && p.file_name().is_some_and(|n| n.to_string_lossy().starts_with("cutover-2"))).collect()).unwrap_or_default();
    v.sort();
    v
}

fn latest_backup(data: &Path) -> Option<Bk> {
    backups(data).pop().map(|dir| Bk { dir })
}

fn home_rel(cx: &Cx, p: &Path) -> String {
    let canon = cx.home.canonicalize().unwrap_or_else(|_| cx.home.clone());
    match p.strip_prefix(&cx.home).or_else(|_| p.strip_prefix(&canon)) {
        Ok(r) => format!("~/{}", r.display()),
        Err(_) => p.display().to_string(),
    }
}

// ------------------------------------------------------------------------------------- entry

pub fn main(args: &[String]) -> Result<()> {
    let mut sub = None;
    let mut yes = false;
    for a in args {
        match a.as_str() {
            "--yes" | "-y" => yes = true,
            s @ ("plan" | "run" | "rollback") if sub.is_none() => sub = Some(s.to_string()),
            other => bail!("unknown argument {other}; usage: setu migrate [plan | run --yes | rollback]"),
        }
    }
    let cx = Cx::new()?;
    match sub.as_deref().unwrap_or("plan") {
        "plan" => plan(&cx),
        "run" => {
            if !yes {
                bail!("refusing to run without --yes: review `setu migrate plan` first, then `setu migrate run --yes`");
            }
            run(&cx)
        }
        _ => rollback(&cx),
    }
}

// ------------------------------------------------------------------------------------- plan

fn table(rows: &[(String, String, String)]) -> String {
    let w0 = rows.iter().map(|r| r.0.chars().count()).max().unwrap_or(0);
    let w1 = rows.iter().map(|r| r.1.chars().count()).max().unwrap_or(0);
    rows.iter().map(|(a, b, c)| format!("  {a:<w0$}  {b:<w1$}  {c}")).collect::<Vec<_>>().join("\n")
}

struct Found {
    portals: Vec<Portal>,
    caddy: Caddy,
    services: Vec<(String, String)>,
    v1_links: Vec<(PathBuf, PathBuf)>,
    ports: Vec<u16>,
    install: InstallPlan,
}

fn discover(cx: &Cx) -> Found {
    let procs = process_table();
    let portals = find_portals(&procs, cx.uid(), std::process::id() as i32, &cx.home);
    let services = brew_services();
    let caddy = detect_caddy(cx, &services);
    let mut v1_dirs = vec![cx.home.join(".setu")];
    v1_dirs.extend(portals.iter().filter_map(|p| portal_script(&p.proc_.cmd)).filter_map(|s| s.parent().map(Path::to_path_buf)));
    let v1_links = find_v1_links(cx, &v1_dirs);
    let mut ports: Vec<u16> = portals.iter().flat_map(|p| p.ports.clone()).collect();
    ports.sort_unstable();
    ports.dedup();
    let install = install_plan(&cx.exe, &cx.data, &cx.link_dir, &|p| p.exists());
    // A v1 link at the very path we link to is replaced by the install step (its target is kept for rollback), not removed twice.
    let v1_links = v1_links.into_iter().filter(|(l, _)| Some(l) != install.link.as_ref()).collect();
    Found { portals, caddy, services, v1_links, ports, install }
}

fn plan(cx: &Cx) -> Result<()> {
    let f = discover(cx);
    println!("setu migrate plan (read-only: nothing is changed)");
    println!("  home: {}   workspace: {}   zone: {}   data: {}", cx.home.display(), cx.ws.display(), cx.zone, cx.data.display());
    let mut rows: Vec<(String, String, String)> = vec![("PIECE".into(), "FOUND".into(), "WHAT MIGRATE DOES".into())];
    for p in &f.portals {
        let ports = if p.ports.is_empty() { String::new() } else { format!(", port {}", p.ports.iter().map(u16::to_string).collect::<Vec<_>>().join("/")) };
        rows.push(("old portal".into(), format!("running, pid {}{ports}", p.proc_.pid), "stops it (rollback starts it again)".into()));
    }
    if f.portals.is_empty() {
        rows.push(("old portal".into(), "not running".into(), "nothing to stop".into()));
    }
    rows.push(match &f.caddy {
        Caddy::Brew => ("caddy".into(), "started (brew services)".into(), "stops it so Setu can use :80".into()),
        Caddy::Agent { label, .. } => ("caddy".into(), format!("LaunchAgent {label}"), "unloads it so Setu can use :80".into()),
        Caddy::Holder(h) => ("caddy".into(), format!("{h} holds :80"), "cannot stop it cleanly; stop it yourself, or Setu serves on :7777".into()),
        Caddy::None => ("caddy".into(), "not found".into(), "skips the Caddy step".into()),
    });
    // dnsmasq usually runs as root (a LaunchDaemon), so the user's process table may not show it.
    let dnsmasq = f.services.iter().any(|(n, s)| n == "dnsmasq" && s == "started")
        || Path::new("/Library/LaunchDaemons/homebrew.mxcl.dnsmasq.plist").exists()
        || run_cmd("pgrep", &["-x", "dnsmasq"]).is_some_and(|(code, _)| code == 0)
        || process_table().iter().any(|p| p.cmd.split_whitespace().next().is_some_and(|c| c.rsplit('/').next() == Some("dnsmasq")));
    rows.push(("dnsmasq".into(), if dnsmasq { "running".into() } else { "not found".into() }, "leaves it alone".into()));
    let resolver = Path::new("/etc/resolver").join(&cx.zone);
    rows.push(("resolver".into(), if resolver.exists() { format!("/etc/resolver/{} present", cx.zone) } else { format!("/etc/resolver/{} absent", cx.zone) }, "leaves it alone (`setu setup` adds it if *.zone does not resolve)".into()));
    match find_zsh_function(cx) {
        true => rows.push(("zsh setu()".into(), "found in ~/.zshrc".into(), "leaves it alone (`setu cd` keeps working)".into())),
        false => rows.push(("zsh setu()".into(), "not found".into(), "nothing; `setu cd` needs that function".into())),
    }
    for (l, t) in &f.v1_links {
        rows.push(("v1 CLI link".into(), format!("{} -> {}", home_rel(cx, l), home_rel(cx, t)), "removes it (rollback relinks)".into()));
    }
    if f.v1_links.is_empty() {
        rows.push(("v1 CLI link".into(), "not found".into(), "nothing to remove".into()));
    }
    rows.push(match (&f.install.copy_to, f.install.homebrew) {
        (_, true) => ("new setu".into(), format!("Homebrew: {}", f.install.bin.display()), "uses it as is (no copy, no link)".into()),
        (Some(c), _) => ("new setu".into(), format!("running from {}", cx.exe.display()), format!("copies it to {}, links {}", c.display(), f.install.link.as_ref().map(|l| home_rel(cx, l)).unwrap_or_default())),
        (None, _) => ("new setu".into(), format!("already at {}", f.install.bin.display()), format!("links {}", f.install.link.as_ref().map(|l| home_rel(cx, l)).unwrap_or_default())),
    });
    let holder = port80_holder();
    let already = f.portals.is_empty() && f.v1_links.is_empty() && holder.as_deref().is_some_and(|h| h.starts_with("setu "));
    if already {
        println!("  This machine already runs the new Setu (it serves :80 and no old portal or v1 CLI is left). Nothing to migrate; the table below is for reference.");
    }
    match holder {
        Some(h) if h.starts_with("setu ") => rows.push(("port 80".into(), format!("served by the new Setu {}", h.trim_start_matches("setu ")), "nothing to do".into())),
        Some(h) => rows.push(("port 80".into(), format!("held by {h}"), "Setu falls back to :7777 unless the holder is stopped".into())),
        None => rows.push(("port 80".into(), "free".into(), "Setu serves the proxy there (IPv4 and IPv6)".into())),
    }
    println!("\n{}", table(&rows));
    if let Some(l) = &f.install.link {
        if let Some(d) = l.parent() {
            if !path_has(d) {
                println!("\n  warning: {} is not on your PATH. Add this to your shell profile: export PATH=\"{}:$PATH\"", d.display(), home_rel(cx, d).replace("~/", "$HOME/"));
            }
        }
    }
    println!("\nMCP clients (only entries named `setu` or pointing at the old portal are repointed to `{} mcp`; other servers are never touched or shown):", f.install.bin.display());
    let mut mrows: Vec<(String, String, String)> = vec![("CLIENT".into(), "FILE".into(), "CHANGE".into())];
    for c in client_files(cx) {
        let change = match std::fs::read_to_string(&c.path) {
            Err(_) => "no such file; skipped".to_string(),
            Ok(t) => match mcpcfg::scan(&t, c.fmt, &f.install.bin.to_string_lossy(), &f.ports) {
                Err(_) => "not valid JSON/TOML; skipped (left untouched)".to_string(),
                Ok(names) if names.is_empty() => "no old Setu server; unchanged".to_string(),
                Ok(names) => format!("{} entr{} repointed ({})", names.len(), if names.len() == 1 { "y" } else { "ies" }, names.join(", ")),
            },
        };
        mrows.push((c.label, home_rel(cx, &c.path), change));
    }
    println!("{}", table(&mrows));
    match latest_backup(&cx.data) {
        Some(b) if !b.flagged("rolled-back") => println!("\n  WARNING: an earlier migration exists at {} and was not rolled back; `run` refuses until it is", b.dir.display()),
        _ => {}
    }
    println!("\nSteps (0 backups, 1 review, 3 install, 4 stop v1, 5 setup, 2 adopt, 6 MCP, 7 verify). Backups: {}/cutover-<timestamp>/", cx.data.display());
    println!("\nsetu setup would:");
    let me = cx.exe.to_string_lossy().into_owned();
    match run_cmd(&me, &["setup", "--dry-run"]) {
        Some((_, out)) => out.lines().for_each(|l| println!("  {l}")),
        None => println!("  (could not run setup --dry-run)"),
    }
    println!("\nimport-v1 dry run:");
    match Command::new(&me).arg("import-v1").stdin(Stdio::null()).output() {
        Ok(o) => {
            String::from_utf8_lossy(&o.stdout).lines().for_each(|l| println!("  {l}"));
            String::from_utf8_lossy(&o.stderr).lines().for_each(|l| println!("  {l}"));
        }
        Err(e) => println!("  could not run import-v1: {e}"),
    }
    println!("\nNothing was changed. To go ahead: setu migrate run --yes");
    Ok(())
}

fn find_zsh_function(cx: &Cx) -> bool {
    std::fs::read_to_string(cx.home.join(".zshrc")).is_ok_and(|t| t.contains("command setu path"))
}

// ------------------------------------------------------------------------------------- run

fn fail(step: &str, msg: &str) -> anyhow::Error {
    led(step, "failed", msg);
    anyhow!("step {step} FAILED: {msg}\nrollback with: setu migrate rollback")
}

fn run(cx: &Cx) -> Result<()> {
    let f = discover(cx);
    // 0: preflight and backups
    led("0", "start", "preflight and backups");
    if let Some(prior) = latest_backup(&cx.data) {
        if !prior.flagged("rolled-back") {
            return Err(fail("0", &format!("an earlier migration at {} was not rolled back; run: setu migrate rollback", prior.dir.display())));
        }
    }
    let me = cx.exe.to_string_lossy().into_owned();
    match run_cmd(&me, &["--version"]) {
        Some((0, v)) if v.starts_with("setu ") => {}
        _ => return Err(fail("0", &format!("{me} does not look like setu"))),
    }
    // Local time, like the original script's folder names, so "the latest backup" sorts the same across both.
    let ts = run_cmd("date", &["+%Y%m%d-%H%M%S"]).map(|(_, o)| o.trim().to_string()).filter(|t| t.len() == 15).unwrap_or_else(|| crate::env::rfc3339(globalcfg::now_secs() as i64).replace([':', '-'], "").replace('T', "-").chars().take(15).collect());
    // Two runs in the same second must not share a folder.
    let mut dir = cx.data.join(format!("cutover-{ts}"));
    for i in 2.. {
        if !dir.exists() {
            break;
        }
        dir = cx.data.join(format!("cutover-{ts}-{i}"));
    }
    let bk = Bk { dir };
    for d in [bk.dir.clone(), bk.dir.join("files"), bk.dir.join("flags"), bk.dir.join("mcp")] {
        std::fs::create_dir_all(&d).map_err(|e| fail("0", &format!("cannot create {}: {e}", d.display())))?;
    }
    for d in [&bk.dir, &bk.dir.join("files")] {
        let _ = std::fs::set_permissions(d, std::os::unix::fs::PermissionsExt::from_mode(0o700));
    }
    let clients = client_files(cx);
    let mut to_back_up: Vec<PathBuf> = vec![cx.home.join(".zshrc")];
    to_back_up.extend(clients.iter().map(|c| c.path.clone()));
    to_back_up.extend([cx.home.join(".setu.json"), cx.ws.join(".ports"), cx.ws.join(".projects"), cx.ws.join("Caddyfile")]);
    let mut manifest = String::new();
    let mut n = 0;
    for p in &to_back_up {
        if p.is_file() {
            n += 1;
            std::fs::copy(p, bk.dir.join("files").join(n.to_string())).map_err(|e| fail("0", &format!("cannot back up {}: {e}", p.display())))?;
            manifest.push_str(&format!("{n}\t{}\n", p.display()));
        }
    }
    std::fs::write(bk.dir.join("manifest"), manifest)?;
    std::fs::write(bk.dir.join("binary"), format!("{}\n", f.install.bin.display()))?;
    // The new setu's own database, if any (a point-in-time copy; restoring it is a manual step).
    let sd = paths::state_dir();
    if sd.is_dir() {
        let _ = std::fs::create_dir_all(bk.dir.join("db"));
        if let Ok(rd) = std::fs::read_dir(&sd) {
            for e in rd.filter_map(Result::ok) {
                if e.file_name().to_string_lossy().starts_with("setu.db") {
                    let _ = std::fs::copy(e.path(), bk.dir.join("db").join(e.file_name()));
                }
            }
        }
    }
    // v1 state needed to undo steps 3 and 4.
    let links: String = f.v1_links.iter().map(|(l, t)| format!("{}\t{}\n", l.display(), t.display())).collect();
    std::fs::write(bk.dir.join("v1-links"), links)?;
    let pcmds: String = f.portals.iter().map(|p| format!("{}\n", p.proc_.cmd)).collect();
    std::fs::write(bk.dir.join("portal-commands"), pcmds)?;
    led("0", "ok", &format!("backups in {} ({n} files)", bk.dir.display()));
    println!("step 0 ok: preflight passed, backups in {}", bk.dir.display());

    // 1: review (the dry run, saved)
    led("1", "start", "import-v1 dry run");
    let o = Command::new(&me).arg("import-v1").stdin(Stdio::null()).output().map_err(|e| fail("1", &format!("cannot run import-v1: {e}")))?;
    std::fs::write(bk.dir.join("import-plan.txt"), [&o.stdout[..], &o.stderr[..]].concat())?;
    if !o.status.success() {
        return Err(fail("1", &format!("import-v1 dry run failed: {}", tail(&String::from_utf8_lossy(&o.stderr), 3))));
    }
    led("1", "ok", &format!("plan saved to {}", bk.dir.join("import-plan.txt").display()));
    println!("step 1 ok: import-v1 dry run saved to {}/import-plan.txt", bk.dir.display());

    // 3: install the binary, remove the v1 link(s)
    led("3", "start", "install setu, remove the v1 link");
    let mut note = String::new();
    if let Some(copy) = &f.install.copy_to {
        let dir = copy.parent().ok_or_else(|| fail("3", "bad install path"))?;
        std::fs::create_dir_all(dir).map_err(|e| fail("3", &format!("cannot create {}: {e}", dir.display())))?;
        let existed = copy.exists();
        let tmp = dir.join(format!(".setu.tmp.{}", std::process::id()));
        std::fs::copy(&cx.exe, &tmp).map_err(|e| fail("3", &format!("cannot copy the binary: {e}")))?;
        std::fs::set_permissions(&tmp, std::os::unix::fs::PermissionsExt::from_mode(0o755)).map_err(|e| fail("3", &format!("chmod: {e}")))?;
        std::fs::rename(&tmp, copy).map_err(|e| {
            let _ = std::fs::remove_file(&tmp);
            fail("3", &format!("cannot install {}: {e}", copy.display()))
        })?;
        if !existed {
            bk.flag("binary-copied", &copy.display().to_string())?;
        }
        note.push_str(&format!("copied to {}", copy.display()));
    }
    if let Some(link) = &f.install.link {
        std::fs::create_dir_all(&cx.link_dir).map_err(|e| fail("3", &format!("cannot create {}: {e}", cx.link_dir.display())))?;
        match std::fs::symlink_metadata(link) {
            Ok(md) if md.file_type().is_symlink() => {
                let prev = std::fs::read_link(link)?;
                std::fs::write(bk.dir.join("install-prev-target"), format!("{}\n", prev.display()))?;
                std::fs::remove_file(link).map_err(|e| fail("3", &format!("cannot replace {}: {e}", link.display())))?;
            }
            Ok(_) => return Err(fail("3", &format!("{} exists and is not a symlink; move it away first", link.display()))),
            Err(_) => {}
        }
        std::os::unix::fs::symlink(&f.install.bin, link).map_err(|e| fail("3", &format!("cannot link {}: {e}", link.display())))?;
        bk.flag("installed", &link.display().to_string())?;
        note.push_str(&format!("{}linked {} -> {}", if note.is_empty() { "" } else { "; " }, link.display(), f.install.bin.display()));
    }
    let mut removed = 0;
    for (l, _) in &f.v1_links {
        std::fs::remove_file(l).map_err(|e| fail("3", &format!("cannot remove {}: {e}", l.display())))?;
        bk.flag("v1-links-removed", "1")?;
        removed += 1;
    }
    led("3", "ok", &format!("{note}; {removed} v1 link(s) removed"));
    println!("step 3 ok: {}; v1 link removed ({removed})", if note.is_empty() { "using the Homebrew binary".to_string() } else { note });

    // 4: stop v1 (portal, caddy)
    led("4", "start", "stop the old portal and caddy");
    for p in &f.portals {
        if !current_cmd(p.proc_.pid).is_some_and(|c| is_portal_cmd(&c)) {
            return Err(fail("4", &format!("pid {} is not the old portal", p.proc_.pid)));
        }
        bk.flag("portal-stopped", "1")?;
        unsafe { libc::kill(p.proc_.pid, libc::SIGTERM) };
    }
    if !f.portals.is_empty() && !wait_until(Duration::from_secs(10), || f.portals.iter().all(|p| !alive(p.proc_.pid))) {
        return Err(fail("4", &format!("the old portal (pid {}) did not stop", f.portals[0].proc_.pid)));
    }
    let caddy_note = match &f.caddy {
        Caddy::Brew => {
            bk.flag("caddy-stopped", "brew")?;
            if !run_cmd("brew", &["services", "stop", "caddy"]).is_some_and(|(c, _)| c == 0) {
                return Err(fail("4", "brew services stop caddy failed"));
            }
            wait_port80_free(&bk)?;
            "caddy stopped (brew services)".to_string()
        }
        Caddy::Agent { label, plist } => {
            bk.flag("caddy-stopped", &format!("agent\t{label}\t{}", plist.display()))?;
            if !run_cmd("launchctl", &["bootout", &format!("gui/{}/{label}", cx.uid())]).is_some_and(|(c, _)| c == 0) {
                return Err(fail("4", &format!("launchctl bootout {label} failed")));
            }
            wait_port80_free(&bk)?;
            format!("caddy stopped (LaunchAgent {label})")
        }
        Caddy::Holder(h) => format!("{h} holds :80 and was left running; Setu may fall back to :7777"),
        Caddy::None => "no caddy found; skipped".to_string(),
    };
    let portal_note = if f.portals.is_empty() { "old portal was not running".to_string() } else { format!("old portal stopped ({})", f.portals.iter().map(|p| p.proc_.pid.to_string()).collect::<Vec<_>>().join(", ")) };
    led("4", "ok", &format!("{portal_note}; {caddy_note}"));
    println!("step 4 ok: {portal_note}; {caddy_note}");

    // 5: setup (LaunchAgent, PATH capture, proxy on :80)
    led("5", "start", "setu setup");
    let bin = f.install.bin.to_string_lossy().into_owned();
    let dry = Command::new(&bin).args(["setup", "--dry-run"]).stdin(Stdio::null()).output().map_err(|e| fail("5", &format!("cannot run setup: {e}")))?;
    let plan_text = String::from_utf8_lossy(&dry.stdout).into_owned();
    if !dry.status.success() {
        return Err(fail("5", &format!("setu setup --dry-run failed: {}", tail(&String::from_utf8_lossy(&dry.stderr), 3))));
    }
    if plan_text.contains("[sudo]") && !stdin_is_tty() {
        return Err(fail("5", &format!("setup needs sudo steps and there is no terminal to ask for the password; run `setu setup` yourself, then run this again:\n{plan_text}")));
    }
    bk.flag("setup-attempted", "1")?;
    let setup_out = std::fs::File::create(bk.dir.join("setup.out"))?;
    let st = Command::new(&bin)
        .args(["setup", "--yes"])
        .stdin(if plan_text.contains("[sudo]") { Stdio::inherit() } else { Stdio::null() })
        .stdout(setup_out.try_clone()?)
        .stderr(setup_out)
        .status()
        .map_err(|e| fail("5", &format!("cannot run setup: {e}")))?;
    if !st.success() {
        return Err(fail("5", &format!("setu setup failed: {}", tail(&std::fs::read_to_string(bk.dir.join("setup.out")).unwrap_or_default(), 3))));
    }
    if !wait_until(Duration::from_secs(20), || run_cmd(&bin, &["ls"]).is_some_and(|(c, _)| c == 0)) {
        return Err(fail("5", "the daemon did not answer after setup"));
    }
    bk.flag("setup-done", "1")?;
    led("5", "ok", "daemon up");
    println!("step 5 ok: setup done, daemon answering");

    // 2: adopt worktrees and import port leases
    led("2", "start", "adopt worktrees and import port leases");
    let apply = Command::new(&bin).args(["import-v1", "--apply"]).stdin(Stdio::null()).output().map_err(|e| fail("2", &format!("cannot run import-v1: {e}")))?;
    std::fs::write(bk.dir.join("import-apply.txt"), [&apply.stdout[..], &apply.stderr[..]].concat())?;
    if !apply.status.success() {
        return Err(fail("2", &format!("import-v1 --apply failed: {}", tail(&String::from_utf8_lossy(&apply.stderr), 3))));
    }
    bk.flag("imported", "1")?;
    let adopted = String::from_utf8_lossy(&apply.stdout).lines().rev().find(|l| l.starts_with("adopted ")).unwrap_or("adopted").to_string();
    led("2", "ok", &adopted);
    println!("step 2 ok: {adopted}");

    // 6: MCP clients
    led("6", "start", "repoint agent MCP configs to setu mcp");
    let mut summary = Vec::new();
    for (i, c) in clients.iter().enumerate() {
        let Ok(text) = std::fs::read_to_string(&c.path) else { continue };
        // The parse error is never printed: a parser may quote the offending line, which can be another server's token.
        let Ok(res) = repoint_text(c, &text, &bin, &f.ports) else {
            println!("  note: {} is not valid {}; left untouched", c.path.display(), if c.fmt == Fmt::Codex { "TOML" } else { "JSON" });
            led("6", "skipped", &format!("{} is not valid; left untouched", c.path.display()));
            continue;
        };
        let Some((new_text, touched)) = res else { continue };
        let orig = std::fs::read_to_string(bk.dir.join("manifest")).unwrap_or_default().lines().find_map(|l| l.split_once('\t').filter(|(_, p)| Path::new(p) == c.path).map(|(n, _)| n.to_string()));
        let Some(orig) = orig else { return Err(fail("6", &format!("{} has no backup; refusing to edit it", c.path.display()))) };
        atomic_write(&c.path, &new_text).map_err(|e| fail("6", &format!("could not edit {}: {e:#}", c.path.display())))?;
        std::fs::write(bk.dir.join("mcp").join(format!("{i}.after")), &new_text)?;
        std::fs::write(bk.dir.join("mcp").join(format!("{i}.json")), serde_json::to_string(&json!({ "file": c.path, "fmt": c.fmt.name(), "backup": orig, "touched": touched }))?)?;
        let count = touched.as_array().map(Vec::len).unwrap_or(0);
        summary.push(format!("{} ({count})", c.label));
    }
    let s6 = if summary.is_empty() { "no client config had an old Setu server".to_string() } else { format!("repointed: {}", summary.join(", ")) };
    led("6", "ok", &s6);
    println!("step 6 ok: {s6} (restart Claude Code, Codex and Cursor to pick it up)");

    // 7: verify
    led("7", "start", "verify");
    let doctor = Command::new(&bin).arg("doctor").stdin(Stdio::null()).output().map_err(|e| fail("7", &format!("cannot run doctor: {e}")))?;
    let dout = String::from_utf8_lossy(&doctor.stdout).into_owned();
    std::fs::write(bk.dir.join("doctor.out"), &dout)?;
    if !doctor.status.success() {
        let bad: Vec<&str> = dout.lines().filter(|l| l.starts_with("FAIL") || l.trim_start().starts_with("fix:")).take(6).collect();
        return Err(fail("7", &format!("doctor reported problems: {}", bad.join(" | "))));
    }
    let ls = run_cmd(&bin, &["ls", "--json"]).map(|(_, o)| o).unwrap_or_default();
    let runs: Vec<Value> = serde_json::from_str::<Value>(&ls).ok().and_then(|v| v.as_array().cloned()).unwrap_or_default();
    if runs.is_empty() {
        return Err(fail("7", "setu ls shows no runs"));
    }
    // One main URL and one branch URL must be answered by the proxy (any HTTP status; a browser-style
    // request gets an immediate "Starting..." page instead of waiting, and the run starts on demand).
    let urls: Vec<String> = runs.iter().filter(|r| r["run"].as_str().is_some_and(|x| x.ends_with("/main"))).take(1).chain(runs.iter().filter(|r| r["run"].as_str().is_some_and(|x| !x.ends_with("/main"))).take(1)).filter_map(|r| r["url"].as_str().map(String::from)).collect();
    for u in &urls {
        match http_status(u) {
            Some(code) => println!("  {u} answered HTTP {code}"),
            None => return Err(fail("7", &format!("{u} did not answer through the proxy"))),
        }
    }
    if !mcp_lists_run_list(&bin) {
        return Err(fail("7", "setu mcp did not list run_list"));
    }
    bk.flag("verified", "1")?;
    led("7", "ok", &format!("doctor ok, {} runs, URLs answered, mcp lists run_list", runs.len()));
    println!("step 7 ok: doctor passes, {} runs, URLs answered, MCP lists run_list", runs.len());
    bk.flag("complete", "1")?;
    led("run", "complete", &format!("migration done; backups in {}", bk.dir.display()));
    println!("\nStill by hand: one sign-in through the new URL, and `run_list` from Claude Code, Codex and Cursor after restarting them.");
    if let Some(l) = &f.install.link {
        if let Some(d) = l.parent() {
            if !path_has(d) {
                println!("warning: {} is not on your PATH, so `setu` will not be found in a new terminal. Add: export PATH=\"$HOME/.local/bin:$PATH\"", d.display());
            }
        }
    }
    println!("\nmigration complete. Undo with: setu migrate rollback");
    Ok(())
}

fn tail(s: &str, n: usize) -> String {
    let v: Vec<&str> = s.lines().collect();
    v[v.len().saturating_sub(n)..].join(" | ")
}

fn alive(pid: i32) -> bool {
    unsafe { libc::kill(pid, 0) == 0 }
}

fn current_cmd(pid: i32) -> Option<String> {
    run_cmd("ps", &["-o", "command=", "-p", &pid.to_string()]).map(|(_, o)| o.trim().to_string()).filter(|s| !s.is_empty())
}

fn wait_until(limit: Duration, mut done: impl FnMut() -> bool) -> bool {
    let end = Instant::now() + limit;
    loop {
        if done() {
            return true;
        }
        if Instant::now() >= end {
            return false;
        }
        std::thread::sleep(Duration::from_millis(250));
    }
}

fn wait_port80_free(_bk: &Bk) -> Result<()> {
    if wait_until(Duration::from_secs(10), || port80_holder().is_none()) {
        Ok(())
    } else {
        Err(fail("4", &format!("port 80 is still held by {} after stopping caddy", port80_holder().unwrap_or_default())))
    }
}

fn stdin_is_tty() -> bool {
    unsafe { libc::isatty(0) == 1 }
}

/// GET / with a browser-style Accept, to whatever host the URL names, through 127.0.0.1.
fn http_status(url: &str) -> Option<u16> {
    use std::io::{Read, Write};
    let rest = url.strip_prefix("http://")?;
    let hostport = rest.split('/').next()?;
    let (host, port) = match hostport.rsplit_once(':') {
        Some((h, p)) => (h, p.parse::<u16>().ok()?),
        None => (hostport, 80),
    };
    let mut s = std::net::TcpStream::connect_timeout(&std::net::SocketAddr::from(([127, 0, 0, 1], port)), Duration::from_secs(5)).ok()?;
    s.set_read_timeout(Some(Duration::from_secs(30))).ok()?;
    s.write_all(format!("GET / HTTP/1.1\r\nHost: {hostport}\r\nAccept: text/html\r\nConnection: close\r\n\r\n").as_bytes()).ok()?;
    let _ = host;
    let mut buf = [0u8; 64];
    let n = s.read(&mut buf).ok()?;
    String::from_utf8_lossy(&buf[..n]).split_whitespace().nth(1)?.parse().ok()
}

fn mcp_lists_run_list(bin: &str) -> bool {
    use std::io::Write;
    let Ok(mut child) = Command::new(bin).arg("mcp").stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::null()).spawn() else { return false };
    if let Some(mut si) = child.stdin.take() {
        let _ = si.write_all(b"{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"initialize\",\"params\":{\"protocolVersion\":\"2024-11-05\",\"capabilities\":{},\"clientInfo\":{\"name\":\"migrate\",\"version\":\"0\"}}}\n{\"jsonrpc\":\"2.0\",\"id\":2,\"method\":\"tools/list\"}\n");
    }
    child.wait_with_output().is_ok_and(|o| String::from_utf8_lossy(&o.stdout).contains("run_list"))
}

// ------------------------------------------------------------------------------------- rollback

fn rollback(cx: &Cx) -> Result<()> {
    let Some(bk) = latest_backup(&cx.data) else { bail!("no migration backup found in {}; nothing to roll back", cx.data.display()) };
    if bk.flagged("rolled-back") {
        println!("already rolled back ({})", bk.dir.display());
        return Ok(());
    }
    let bin = std::fs::read_to_string(bk.dir.join("binary")).ok().map(|s| s.trim().to_string()).filter(|s| !s.is_empty()).ok_or_else(|| anyhow!("{} has no recorded binary", bk.dir.display()))?;
    led("rollback", "start", &format!("from {}", bk.dir.display()));
    let log = bk.dir.join("rollback.out");
    let mut fails = 0;
    let mut say = |label: &str, r: Result<()>| match r {
        Ok(()) => println!("  rollback: {label}"),
        Err(e) => {
            println!("  rollback FAILED: {label} ({e:#}; see {})", log.display());
            let _ = std::fs::OpenOptions::new().create(true).append(true).open(&log).and_then(|mut f| std::io::Write::write_all(&mut f, format!("{label}: {e:#}\n").as_bytes()));
            fails += 1;
        }
    };
    let sh = |cmd: &str, args: &[&str]| -> Result<()> {
        let st = Command::new(cmd).args(args).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null()).status().with_context(|| format!("running {cmd}"))?;
        if st.success() { Ok(()) } else { bail!("{cmd} exited {st}") }
    };
    // 1. setup --undo (stops the daemon, removes the LaunchAgent). Falls back to this binary if the install is gone.
    if bk.flagged("setup-attempted") {
        let b = if Path::new(&bin).exists() { bin.clone() } else { cx.exe.to_string_lossy().into_owned() };
        say("setu setup --undo", sh(&b, &["setup", "--undo"]));
    }
    // 2. caddy back
    if let Some(v) = bk.val("caddy-stopped") {
        let mut it = v.split('\t');
        match it.next() {
            Some("agent") => {
                let (label, plist) = (it.next().unwrap_or(""), it.next().unwrap_or(""));
                say(&format!("start LaunchAgent {label}"), sh("launchctl", &["bootstrap", &format!("gui/{}", cx.uid()), plist]));
            }
            // "brew", and the "1" that the original bash script wrote.
            _ => say("brew services start caddy", sh("brew", &["services", "start", "caddy"])),
        }
    }
    // 3. old portal back
    if bk.flagged("portal-stopped") {
        // `portal-command` (one line) is what the original bash script recorded.
        let recorded = format!("{}\n{}", std::fs::read_to_string(bk.dir.join("portal-commands")).unwrap_or_default(), std::fs::read_to_string(bk.dir.join("portal-command")).unwrap_or_default());
        for cmd in recorded.lines().filter(|l| !l.trim().is_empty()) {
            if find_portals(&process_table(), cx.uid(), std::process::id() as i32, &cx.home).iter().any(|p| p.proc_.cmd == cmd) {
                continue;
            }
            let toks: Vec<&str> = cmd.split_whitespace().collect();
            let dir = portal_script(cmd).and_then(|s| s.parent().map(Path::to_path_buf)).unwrap_or_else(|| cx.home.join(".setu"));
            use std::os::unix::process::CommandExt;
            let r = Command::new(toks[0]).args(&toks[1..]).current_dir(&dir).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null()).process_group(0).spawn().map(|_| ()).map_err(anyhow::Error::from);
            say("start the old portal", r);
        }
    }
    // 4. MCP configs: byte-exact restore when nobody changed the file since we did, else only our entries
    let mut recs: Vec<PathBuf> = std::fs::read_dir(bk.dir.join("mcp")).map(|rd| rd.filter_map(Result::ok).map(|e| e.path()).filter(|p| p.extension().is_some_and(|e| e == "json")).collect()).unwrap_or_default();
    recs.sort();
    for rec in recs {
        let Ok(v) = std::fs::read_to_string(&rec).map_err(anyhow::Error::from).and_then(|t| Ok(serde_json::from_str::<Value>(&t)?)) else { continue };
        let (Some(file), Some(fmt), Some(n)) = (v["file"].as_str().map(PathBuf::from), v["fmt"].as_str().and_then(Fmt::parse), v["backup"].as_str()) else { continue };
        let backup = bk.dir.join("files").join(n);
        let after = std::fs::read(rec.with_extension("after")).ok();
        let cur = std::fs::read(&file).ok();
        let label = format!("restore {}", file.display());
        if cur.is_some() && cur == after {
            say(&label, std::fs::read_to_string(&backup).map_err(anyhow::Error::from).and_then(|t| atomic_write(&file, &t)));
        } else if let Some(cur) = cur {
            println!("  note: {} changed since the migration; restoring only the Setu entries", file.display());
            let r = (|| -> Result<()> {
                let (cur, old) = (String::from_utf8(cur)?, std::fs::read_to_string(&backup)?);
                let text = if fmt == Fmt::Codex {
                    let names: Vec<String> = v["touched"].as_array().map(|a| a.iter().filter_map(|x| x.as_str().map(String::from)).collect()).unwrap_or_default();
                    mcpcfg::toml_restore(&cur, &old, &names)?
                } else {
                    mcpcfg::json_restore(&cur, &old, &touched_from_json(&v["touched"]))?
                };
                atomic_write(&file, &text)
            })();
            say(&label, r);
        }
    }
    // The original bash script's layout: flags `claude-touched` / `codex-touched` with the file's checksum after the edit.
    for (flag, shaflag, file, fmt) in [("claude-touched", "claude-sha", cx.home.join(".claude.json"), Fmt::ClaudeJson), ("codex-touched", "codex-sha", cx.home.join(".codex/config.toml"), Fmt::Codex)] {
        if !bk.flagged(flag) {
            continue;
        }
        let backup = std::fs::read_to_string(bk.dir.join("manifest")).unwrap_or_default().lines().find_map(|l| l.split_once('\t').filter(|(_, p)| Path::new(p) == file).map(|(n, _)| bk.dir.join("files").join(n)));
        let label = format!("restore {}", file.display());
        let Some(backup) = backup else { continue };
        if sha256_of(&file).is_some() && sha256_of(&file) == bk.val(shaflag) {
            say(&label, std::fs::read_to_string(&backup).map_err(anyhow::Error::from).and_then(|t| atomic_write(&file, &t)));
        } else {
            println!("  note: {} changed since the migration; restoring only the Setu entry", file.display());
            let r = (|| -> Result<()> {
                let (cur, old) = (std::fs::read_to_string(&file)?, std::fs::read_to_string(&backup)?);
                let text = if fmt == Fmt::Codex { mcpcfg::toml_restore(&cur, &old, &["setu".to_string()])? } else { mcpcfg::json_restore(&cur, &old, &[Touched { path: vec!["mcpServers".into()], key: "setu".into() }])? };
                atomic_write(&file, &text)
            })();
            say(&label, r);
        }
    }
    // (~/.zshrc and the other backed-up files are never modified by the migration; their copies are kept for reference)
    // 5. our link and copy out, the v1 links back
    if let Some(dest) = bk.val("installed") {
        let dest = PathBuf::from(dest);
        let ours = std::fs::read_link(&dest).is_ok_and(|t| t == Path::new(&bin));
        if ours {
            let prev = std::fs::read_to_string(bk.dir.join("install-prev-target")).ok().map(|s| s.trim().to_string()).filter(|s| !s.is_empty());
            let r = std::fs::remove_file(&dest).map_err(anyhow::Error::from).and_then(|()| match &prev {
                Some(p) => std::os::unix::fs::symlink(p, &dest).map_err(anyhow::Error::from),
                None => Ok(()),
            });
            say(&if prev.is_some() { format!("restore {}", dest.display()) } else { format!("remove {}", dest.display()) }, r);
        }
    }
    // The original script recorded one link: `bun-link-removed` plus `bun-link-target`.
    let legacy_link = bk.val("bun-link-removed").and(std::fs::read_to_string(bk.dir.join("bun-link-target")).ok()).map(|t| format!("{}\t{}\n", cx.home.join(".bun/bin/setu").display(), t.trim()));
    if bk.flagged("v1-links-removed") || legacy_link.is_some() {
        let recorded = format!("{}{}", std::fs::read_to_string(bk.dir.join("v1-links")).unwrap_or_default(), legacy_link.unwrap_or_default());
        for l in recorded.lines() {
            let Some((link, target)) = l.split_once('\t') else { continue };
            let link = PathBuf::from(link);
            let r = (|| -> Result<()> {
                if let Some(d) = link.parent() {
                    std::fs::create_dir_all(d)?;
                }
                let _ = std::fs::remove_file(&link);
                std::os::unix::fs::symlink(target, &link)?;
                Ok(())
            })();
            say(&format!("relink {}", link.display()), r);
        }
    }
    if let Some(copy) = bk.val("binary-copied") {
        say(&format!("remove the copied binary {copy}"), std::fs::remove_file(&copy).map_err(anyhow::Error::from));
    }
    if fails > 0 {
        led("rollback", "failed", &format!("{fails} action(s) failed"));
        bail!("rollback had {fails} failure(s); see {} and fix by hand. Backups are in {}", log.display(), bk.dir.display());
    }
    bk.flag("rolled-back", "1")?;
    led("rollback", "ok", &format!("rolled back from {}", bk.dir.display()));
    println!("rolled back. Backups kept in {}. The new Setu's configs and database were left in place (unused).", bk.dir.display());
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_portal_is_found_by_its_command_line_whatever_the_runtime_or_port() {
        for yes in [
            "/Users/a/.bun/bin/bun run /Users/a/.setu/portal.js",
            "bun /Users/a/.setu/portal.js",
            "/opt/homebrew/bin/node /home/b/.setu/portal.js --port 3010",
            "bash /tmp/x/home/.setu/portal.js",
            "/Users/a/.setu/portal.js",
        ] {
            assert!(is_portal_cmd(yes), "{yes}");
        }
        for no in ["vim /Users/a/.setu/portal.js", "tail -f /Users/a/.setu/portal.js", "bun run /Users/a/other/portal.js", "grep .setu/portal.js x"] {
            assert!(!is_portal_cmd(no), "{no}");
        }
        assert_eq!(portal_script("bun run /h/.setu/portal.js").unwrap(), PathBuf::from("/h/.setu/portal.js"));
    }

    #[test]
    fn install_uses_homebrew_when_the_binary_lives_there_else_copies_and_links() {
        let all = |_: &Path| true;
        let none = |_: &Path| false;
        let p = install_plan(Path::new("/opt/homebrew/Cellar/setu/0.1.0/bin/setu"), Path::new("/h/.local/share/setu"), Path::new("/h/.local/bin"), &all);
        assert_eq!(p, InstallPlan { bin: PathBuf::from("/opt/homebrew/opt/setu/bin/setu"), copy_to: None, link: None, homebrew: true });
        let p = install_plan(Path::new("/opt/homebrew/Cellar/setu/0.1.0/bin/setu"), Path::new("/d"), Path::new("/l"), &none);
        assert_eq!(p.bin, PathBuf::from("/opt/homebrew/Cellar/setu/0.1.0/bin/setu"), "no stable link: the real path");
        let p = install_plan(Path::new("/Users/a/build/target/release/setu"), Path::new("/h/.local/share/setu"), Path::new("/h/.local/bin"), &all);
        assert_eq!(p, InstallPlan { bin: PathBuf::from("/h/.local/share/setu/bin/setu"), copy_to: Some(PathBuf::from("/h/.local/share/setu/bin/setu")), link: Some(PathBuf::from("/h/.local/bin/setu")), homebrew: false });
        let p = install_plan(Path::new("/h/.local/share/setu/bin/setu"), Path::new("/h/.local/share/setu"), Path::new("/h/.local/bin"), &all);
        assert_eq!(p.copy_to, None, "already the installed copy");
        assert!(brew_prefix(Path::new("/usr/local/bin/setu")).is_none(), "a manual /usr/local copy is not Homebrew");
        assert_eq!(brew_prefix(Path::new("/usr/local/Cellar/setu/1/bin/setu")), Some(PathBuf::from("/usr/local")));
    }

    #[test]
    fn only_portals_under_this_home_are_ours() {
        let procs = vec![
            Proc { pid: 1, uid: 501, cmd: "bun run /Users/a/.setu/portal.js".into() },
            Proc { pid: 2, uid: 501, cmd: "bun run /Users/other/.setu/portal.js".into() },
            Proc { pid: 3, uid: 0, cmd: "bun run /Users/a/.setu/portal.js".into() },
        ];
        let got = find_portals(&procs, 501, 99, Path::new("/Users/a"));
        assert_eq!(got.iter().map(|p| p.proc_.pid).collect::<Vec<_>>(), [1]);
    }

    #[test]
    fn a_symlinked_config_stays_a_symlink() {
        let d = std::env::temp_dir().join(format!("setu-atomic-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(d.join("dotfiles")).unwrap();
        std::fs::write(d.join("dotfiles/real.json"), "old").unwrap();
        std::os::unix::fs::symlink(d.join("dotfiles/real.json"), d.join("link.json")).unwrap();
        atomic_write(&d.join("link.json"), "new").unwrap();
        assert!(std::fs::symlink_metadata(d.join("link.json")).unwrap().file_type().is_symlink());
        assert_eq!(std::fs::read_to_string(d.join("dotfiles/real.json")).unwrap(), "new");
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn process_lines_parse() {
        assert_eq!(parse_ps_line("  123   501 /bin/bun run /h/.setu/portal.js"), Some(Proc { pid: 123, uid: 501, cmd: "/bin/bun run /h/.setu/portal.js".into() }));
        assert_eq!(parse_ps_line(" 9 0 /sbin/launchd").unwrap().uid, 0);
        assert!(parse_ps_line("garbage").is_none());
    }
}
