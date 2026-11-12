//! Cutover helpers (slice 10): `setu path` and `setu import-v1`.
//!
//! `plan` is read-only: it reads the v1 files (`.projects`, `.ports`, and only the `workspace` and
//! `localZone` keys of `~/.setu.json`), the git worktree lists, and decides what would happen.
//! Writes go through the daemon (`import.adopt`); the CLI writes only project config files and the
//! append-only ledger.

use crate::{config, globalcfg, naming, paths, procinfo};
use anyhow::{anyhow, bail, Context, Result};
use serde_json::{json, Value};
use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};
use std::process::Command;

/// One entry of `git worktree list --porcelain`.
#[derive(Debug, Clone, PartialEq)]
pub struct WtEntry {
    pub path: PathBuf,
    pub branch: Option<String>,
    pub prunable: bool,
    pub locked: bool,
}

pub fn parse_porcelain(text: &str) -> Vec<WtEntry> {
    let mut out = Vec::new();
    for block in text.split("\n\n") {
        let (mut path, mut branch, mut bare, mut prunable, mut locked) = (None, None, false, false, false);
        for line in block.lines() {
            if let Some(p) = line.strip_prefix("worktree ") {
                path = Some(PathBuf::from(p));
            } else if let Some(b) = line.strip_prefix("branch ") {
                branch = Some(b.strip_prefix("refs/heads/").unwrap_or(b).to_string());
            } else if line.trim() == "bare" {
                bare = true;
            } else if line == "prunable" || line.starts_with("prunable ") {
                prunable = true;
            } else if line == "locked" || line.starts_with("locked ") {
                locked = true;
            }
        }
        if let (Some(path), false) = (path, bare) {
            out.push(WtEntry { path, branch, prunable, locked });
        }
    }
    out
}

pub fn list_entries(repo: &Path) -> Result<Vec<WtEntry>> {
    let out = Command::new("git").arg("--git-dir").arg(repo).args(["worktree", "list", "--porcelain"]).output().context("running git worktree list")?;
    if !out.status.success() {
        bail!("git worktree list failed for {}: {}", repo.display(), String::from_utf8_lossy(&out.stderr).trim());
    }
    Ok(parse_porcelain(&String::from_utf8_lossy(&out.stdout)))
}

fn canon(p: &Path) -> PathBuf {
    p.canonicalize().unwrap_or_else(|_| p.to_path_buf())
}

// ------------------------------------------------------------------ setu path

/// The worktree path of `project` for `which`: empty or `main` is the main worktree; otherwise a
/// run name, a branch name (slashes allowed) or the directory relative to the project folder.
pub fn path_for(project: &str, which: Option<&str>) -> Result<PathBuf> {
    let configs = config::load_all()?;
    // A v1 dotted name (`setu cd quivly-site2.0`) resolves to the dashed project import-v1 created.
    let dashed = project.replace('.', "-");
    let cfg = configs
        .iter()
        .find(|c| c.project == project)
        .or_else(|| configs.iter().find(|c| c.project == dashed))
        .ok_or_else(|| anyhow!("no project config named {project}"))?;
    let entries: Vec<WtEntry> = list_entries(&cfg.repo)?.into_iter().filter(|e| !e.prunable && e.path.is_dir()).collect();
    let pd = naming::project_dir(&cfg.repo);
    let run_of = |e: &WtEntry| naming::run_name(&pd, &e.path);
    let which = which.map(str::trim).filter(|w| !w.is_empty());
    let hit = match which {
        None => entries.iter().find(|e| run_of(e) == "main").or(entries.first()),
        Some(w) => {
            let cpd = canon(&pd);
            let wanted_run = naming::run_name(&cpd, &cpd.join(w));
            entries
                .iter()
                .find(|e| run_of(e) == w)
                .or_else(|| entries.iter().find(|e| e.branch.as_deref() == Some(w)))
                .or_else(|| entries.iter().find(|e| canon(&e.path).strip_prefix(&cpd).is_ok_and(|r| r == Path::new(w))))
                .or_else(|| entries.iter().find(|e| run_of(e) == wanted_run))
        }
    };
    match hit {
        Some(e) => Ok(canon(&e.path)),
        None => {
            let names: Vec<String> = entries.iter().map(&run_of).collect();
            bail!("no worktree {} in {project}; runs: {}", which.unwrap_or("main"), names.join(", "))
        }
    }
}

// ------------------------------------------------------------------ import-v1

#[derive(Debug, Clone, PartialEq)]
pub enum Cfg {
    Existing,
    Generated,
    NeedsReview,
    Skipped(&'static str),
}

impl Cfg {
    pub fn label(&self) -> String {
        match self {
            Cfg::Existing => "existing".into(),
            Cfg::Generated => "generated".into(),
            Cfg::NeedsReview => "needs review".into(),
            Cfg::Skipped(why) => format!("skipped ({why})"),
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub enum PortPlan {
    None,
    Kept(u16),
    /// Kept, and a server from that worktree is listening on it right now.
    KeptRunning(u16),
    New(Option<String>),
    /// Already registered in the daemon; this is its current web port.
    Registered(Option<u16>),
    /// Leased from Setu's own range during this apply.
    Leased(u16),
}

impl PortPlan {
    pub fn label(&self) -> String {
        match self {
            PortPlan::None => "-".into(),
            PortPlan::Kept(p) => format!("{p} (kept)"),
            PortPlan::KeptRunning(p) => format!("{p} (kept, running)"),
            PortPlan::New(None) => "new".into(),
            PortPlan::New(Some(why)) => format!("new ({why})"),
            PortPlan::Registered(Some(p)) => format!("{p} (registered)"),
            PortPlan::Registered(None) => "- (registered)".into(),
            PortPlan::Leased(p) => format!("{p} (new)"),
        }
    }
}

#[derive(Debug, Clone)]
pub struct Row {
    pub project: String,
    pub worktree: PathBuf,
    pub run: String,
    pub url: String,
    pub port: PortPlan,
    pub cfg: Cfg,
    pub registered: bool,
}

impl Row {
    pub fn skipped(&self) -> bool {
        matches!(self.cfg, Cfg::Skipped(_))
    }
    pub fn seed(&self) -> Option<u16> {
        match self.port {
            PortPlan::Kept(p) | PortPlan::KeptRunning(p) => Some(p),
            _ => None,
        }
    }
}

pub struct ConfigToWrite {
    pub project: String,
    pub path: PathBuf,
    pub text: String,
    pub state: Cfg,
}

pub struct Plan {
    pub rows: Vec<Row>,
    pub configs: Vec<ConfigToWrite>,
    /// Projects in `.projects` with no bare repo, and other things worth saying.
    pub notes: Vec<String>,
}

/// What we use from v1: the workspace folder, the zone, the project names and v1 ports.
pub struct V1 {
    pub workspace: PathBuf,
    pub zone: String,
    pub projects: Vec<String>,
    /// (project, path relative to the project folder, port)
    ports_raw: Vec<(String, String, u16)>,
}

/// The workspace folder and local zone from `~/.setu.json`. Only those two keys are read (the file
/// also holds credentials); defaults apply when the file or a key is missing.
pub fn read_v1_settings() -> (PathBuf, String) {
    let (mut workspace, mut zone) = (paths::expand("~/workspace"), "quivly.local".to_string());
    if let Ok(text) = std::fs::read_to_string(paths::expand("~/.setu.json")) {
        if let Ok(v) = serde_json::from_str::<Value>(&text) {
            if let Some(w) = v.get("workspace").and_then(Value::as_str) {
                workspace = paths::expand(w);
            }
            if let Some(z) = v.get("localZone").and_then(Value::as_str) {
                zone = z.trim_matches('.').to_ascii_lowercase();
            }
        }
    }
    (workspace, zone)
}

pub fn read_v1() -> Result<V1> {
    let (workspace, zone) = read_v1_settings();
    let pfile = workspace.join(".projects");
    let projects_text = std::fs::read_to_string(&pfile).with_context(|| format!("reading {}", pfile.display()))?;
    let mut projects = Vec::new();
    for l in projects_text.lines() {
        let name = l.split(':').next().unwrap_or("").trim();
        if !name.is_empty() && !name.starts_with('#') && !projects.iter().any(|p| p == name) {
            projects.push(name.to_string());
        }
    }
    let mut ports_raw = Vec::new();
    if let Ok(t) = std::fs::read_to_string(workspace.join(".ports")) {
        for l in t.lines() {
            let Some((key, port)) = l.trim().rsplit_once(':') else { continue };
            let Some((project, rel)) = key.split_once('/') else { continue };
            if let Ok(p) = port.trim().parse::<u16>() {
                ports_raw.push((project.to_string(), rel.to_string(), p));
            }
        }
    }
    Ok(V1 { workspace, zone, projects, ports_raw })
}

impl V1 {
    /// run name -> v1 port, for one project.
    fn ports_for(&self, project: &str, repo: &Path) -> BTreeMap<String, u16> {
        let pd = canon(&naming::project_dir(repo));
        let mut m = BTreeMap::new();
        for (p, rel, port) in &self.ports_raw {
            if p == project {
                m.entry(naming::run_name(&pd, &pd.join(rel))).or_insert(*port);
            }
        }
        m
    }
}

/// A dev command inferred from the main worktree.
#[derive(Debug, PartialEq)]
pub struct Inferred {
    pub run: String,
    /// Where it came from, for the config header.
    pub how: String,
}

pub fn infer_dev(root: &Path) -> Option<Inferred> {
    let has = |f: &str| root.join(f).exists();
    if let Ok(text) = std::fs::read_to_string(root.join("package.json")) {
        let v: Value = serde_json::from_str(&text).unwrap_or(Value::Null);
        if let Some(dev) = v.get("scripts").and_then(|s| s.get("dev")).and_then(Value::as_str) {
            let pm_field = v.get("packageManager").and_then(Value::as_str).unwrap_or("");
            let pm = if pm_field.starts_with("bun") || has("bun.lock") || has("bun.lockb") {
                "bun"
            } else if pm_field.starts_with("pnpm") || has("pnpm-lock.yaml") {
                "pnpm"
            } else if pm_field.starts_with("yarn") || has("yarn.lock") {
                "yarn"
            } else {
                "npm"
            };
            let mut run = format!("{pm} run dev");
            // Vite ignores $PORT; give it the port explicitly.
            if dev.contains("vite") && !dev.contains("next ") {
                run.push_str(if pm == "npm" { " -- --port {port.web} --strictPort" } else { " --port {port.web} --strictPort" });
            }
            return Some(Inferred { run, how: format!("package.json \"dev\" script ({pm})") });
        }
    }
    if has("manage.py") {
        return Some(Inferred { run: "uv run python manage.py runserver {port.web}".into(), how: "manage.py (Django)".into() });
    }
    if has("mix.exs") {
        return Some(Inferred { run: "mix phx.server".into(), how: "mix.exs (Phoenix, reads $PORT)".into() });
    }
    if has("Gemfile") && has("config.ru") {
        return Some(Inferred { run: "bundle exec rails server -p {port.web}".into(), how: "Gemfile + config.ru (Rails)".into() });
    }
    if has("Cargo.toml") {
        return Some(Inferred { run: "cargo run".into(), how: "Cargo.toml (reads $PORT if the app does)".into() });
    }
    if has("go.mod") {
        return Some(Inferred { run: "go run .".into(), how: "go.mod (reads $PORT if the app does)".into() });
    }
    None
}

/// What the repo needs besides its web server: the sidecars v1 ran per worktree (Inngest, Trigger.dev,
/// Convex) and the env v1's `.envrc` used to provide. v1 kept none of this on disk (its sidecar
/// state lived in the portal's memory), so it is read from the repo itself.
#[derive(Debug, Default, Clone, PartialEq)]
pub struct Stack {
    /// There is a package.json (a JS/TS app).
    pub js: bool,
    /// `@workos-inc/authkit-nextjs` is a dependency: older code needs the redirect URI set.
    pub workos: bool,
    pub nx: bool,
    /// Directory (relative to the worktree, "" for the root) the Trigger.dev worker runs in.
    pub trigger: Option<String>,
    /// Extra `--env-file` for the Trigger.dev worker (the v1 `apps/<repo>/.env.local` convention).
    pub trigger_env_file: Option<String>,
    pub inngest: bool,
    /// Directory the Convex dev server runs in.
    pub convex: Option<String>,
    /// Package manager, for the Convex command.
    pub pm: &'static str,
}

fn package_deps(dir: &Path) -> Option<BTreeSet<String>> {
    let v: Value = serde_json::from_str(&std::fs::read_to_string(dir.join("package.json")).ok()?).ok()?;
    let mut out = BTreeSet::new();
    for k in ["dependencies", "devDependencies"] {
        if let Some(o) = v.get(k).and_then(Value::as_object) {
            out.extend(o.keys().cloned());
        }
    }
    Some(out)
}

pub fn detect_stack(root: &Path, app: &str) -> Stack {
    let has = |f: &str| root.join(f).exists();
    let pm = if has("bun.lock") || has("bun.lockb") {
        "bun"
    } else if has("pnpm-lock.yaml") {
        "pnpm"
    } else if has("yarn.lock") {
        "yarn"
    } else {
        "npm"
    };
    let mut st = Stack { js: has("package.json"), nx: has("nx.json"), pm, ..Default::default() };
    // Where to look: the root, the v1 convention apps/<repo>, then the other apps one level down.
    let mut dirs: Vec<String> = vec![String::new(), format!("apps/{app}")];
    if let Ok(rd) = std::fs::read_dir(root.join("apps")) {
        let mut more: Vec<String> = rd.filter_map(Result::ok).filter(|e| e.path().is_dir()).filter_map(|e| e.file_name().to_str().map(|n| format!("apps/{n}"))).collect();
        more.sort();
        dirs.extend(more.into_iter().take(20));
    }
    dirs.dedup();
    let mut sdk_at: Option<String> = None;
    for rel in &dirs {
        let d = if rel.is_empty() { root.to_path_buf() } else { root.join(rel) };
        if !d.is_dir() {
            continue;
        }
        if let Some(deps) = package_deps(&d) {
            st.nx |= deps.contains("nx");
            st.workos |= deps.contains("@workos-inc/authkit-nextjs");
            st.inngest |= deps.contains("inngest");
            if deps.contains("convex") && st.convex.is_none() {
                st.convex = Some(rel.clone());
            }
            if deps.contains("@trigger.dev/sdk") && sdk_at.is_none() {
                sdk_at = Some(rel.clone());
            }
        }
        if st.trigger.is_none() && ["ts", "js", "mjs", "cjs", "mts"].iter().any(|e| d.join(format!("trigger.config.{e}")).exists()) {
            st.trigger = Some(rel.clone());
        }
        if st.convex.is_none() && d.join("convex").is_dir() {
            st.convex = Some(rel.clone());
        }
    }
    // The pinned SDK without a config file still means Trigger is in use.
    if st.trigger.is_none() {
        st.trigger = sdk_at;
    }
    if st.trigger.as_deref() == Some("") && root.join("apps").join(app).is_dir() {
        st.trigger_env_file = Some(format!("apps/{app}/.env.local"));
    }
    st
}

/// The generated project config. `None` gives the commented placeholder.
pub fn generate_config(project: &str, repo_display: &str, domain: &str, inferred: Option<&Inferred>, aliases: &[String], stack: &Stack) -> (String, Cfg) {
    let mut t = format!("# {project}: generated by `setu import-v1`. Review before relying on it.\n");
    let state = match inferred {
        Some(i) => {
            t.push_str(&format!("# Dev command inferred from {}.\n", i.how));
            Cfg::Generated
        }
        None => {
            t.push_str("# NEEDS REVIEW: setu could not infer a dev command for this repo. Fill in the proc below.\n");
            Cfg::NeedsReview
        }
    };
    t.push_str(&format!("project = \"{project}\"\nrepo    = \"{repo_display}\"\ndomain  = \"{domain}\"\n"));
    if !aliases.is_empty() {
        let list: Vec<String> = aliases.iter().map(|a| format!("\"{a}\"")).collect();
        t.push_str(&format!("# The v1 URL of the main worktree keeps working.\naliases = [{}]\n", list.join(", ")));
    }
    t.push_str("preset  = \"auto\"\nidle    = \"30m\"\n\n[ports]\nweb = {}\n");
    if stack.inngest {
        t.push_str("inngest = {}\n");
    }
    // The env v1's .envrc wrote, plus what v1's portal gave its sidecars.
    let mut env: Vec<(&str, &str)> = Vec::new();
    if stack.js {
        env.push(("NEXT_PUBLIC_APP_BASE_URL", "{url}"));
    }
    if stack.workos {
        env.push(("NEXT_PUBLIC_WORKOS_REDIRECT_URI", "{url}/authentication/callback"));
    }
    if stack.nx {
        env.push(("NX_DAEMON", "false"));
    }
    if stack.inngest {
        env.push(("INNGEST_DEV", "1"));
        env.push(("INNGEST_BASE_URL", "http://127.0.0.1:{port.inngest}"));
    }
    if stack.trigger.is_some() {
        env.push(("TRIGGER_DEV_BRANCH", "{run}"));
        env.push(("TRIGGER_PREVIEW_BRANCH", "{run}"));
    }
    if !env.is_empty() {
        t.push_str("\n[env]\n");
        let w = env.iter().map(|(k, _)| k.len()).max().unwrap_or(0);
        for (k, v) in env {
            t.push_str(&format!("{k:<w$} = \"{v}\"\n"));
        }
    }
    t.push('\n');
    match inferred {
        Some(i) => t.push_str(&format!("[procs.web]\nrun  = \"{}\"\nport = \"web\"\n", i.run)),
        None => t.push_str("# [procs.web]\n# run  = \"<your dev command; it must listen on $PORT>\"\n# port = \"web\"\n"),
    }
    if stack.inngest {
        t.push_str("\n# Inngest dev server (`brew install inngest/tap/inngest`; the binary is `inngest`), on its own port.\n");
        t.push_str("[procs.inngest]\nrun = \"inngest dev -p {port.inngest} -u http://127.0.0.1:{port.web}/api/inngest --no-discovery\"\n");
    }
    if let Some(dir) = &stack.trigger {
        t.push_str("\n# The Trigger.dev CLI version follows the worktree's pinned SDK; --branch only where supported.\n");
        let mut run = "setu x trigger-dev --max-concurrent-runs 2".to_string();
        if let Some(f) = &stack.trigger_env_file {
            run.push_str(&format!(" --env-file {f}"));
        }
        t.push_str(&format!("[procs.trigger]\nrun = \"{run}\"\n"));
        if !dir.is_empty() {
            t.push_str(&format!("cwd = \"{dir}\"\n"));
        }
    }
    if let Some(dir) = &stack.convex {
        let run = match stack.pm {
            "bun" => "bunx convex dev",
            "pnpm" => "pnpm exec convex dev",
            "yarn" => "yarn convex dev",
            _ => "npx convex dev",
        };
        t.push_str("\n# Convex dev server (a watch process against your Convex dev deployment).\n");
        t.push_str(&format!("[procs.convex]\nrun = \"{run}\"\n"));
        if !dir.is_empty() {
            t.push_str(&format!("cwd = \"{dir}\"\n"));
        }
    }
    (t, state)
}

/// Does this existing config still carry a NEEDS REVIEW marker?
fn marked_for_review(text: &str) -> bool {
    text.lines().any(|l| l.trim_start().starts_with('#') && l.contains("NEEDS REVIEW"))
}

const RESERVED_PORTS: &[u16] = &[80, 7777, 15353];

fn url_for(project: &str, run: &str, domain: &str, proxy_port: u16) -> String {
    let label = if run == "main" { project } else { run };
    let host = format!("{label}.{domain}").to_lowercase();
    if proxy_port == 80 {
        format!("http://{host}")
    } else {
        format!("http://{host}:{proxy_port}")
    }
}

/// Registered runs known to the daemon: `project/run` -> web port.
pub type Registered = BTreeMap<String, Option<u16>>;

pub fn plan(v1: &V1, registered: &Registered, port_is_free: &dyn Fn(u16) -> bool) -> Result<Plan> {
    let proxy_port = globalcfg::proxy_port();
    let mut plan = Plan { rows: vec![], configs: vec![], notes: vec![] };
    let mut claimed: BTreeSet<u16> = registered.values().flatten().copied().collect();
    let dns = globalcfg::GlobalConfig::load().map(|c| c.dns_port).unwrap_or(15353);
    let mut projects = v1.projects.clone();
    projects.sort();
    for v1name in projects {
        // A v1 name with dots (`quivly-site2.0`) is not a valid Setu project name: it is imported
        // under the dashed name, and its v1 main host is kept as an alias when possible.
        let name = if config::validate_project_name(&v1name).is_ok() {
            v1name.clone()
        } else {
            let mapped = v1name.replace('.', "-");
            if mapped == v1name || config::validate_project_name(&mapped).is_err() {
                plan.notes.push(format!("{v1name}: not a valid project name, skipped"));
                continue;
            }
            if v1.projects.iter().any(|o| *o == mapped) {
                plan.notes.push(format!("{v1name}: would be imported as {mapped}, which is also a v1 project, skipped"));
                continue;
            }
            plan.notes.push(format!("{v1name}: not a valid Setu project name; imported as {mapped}"));
            mapped
        };
        let renamed = name != v1name;
        let repo_abs = v1.workspace.join(format!("{v1name}.git"));
        if !repo_abs.is_dir() {
            plan.notes.push(format!("{v1name}: no bare repo at {}, skipped", repo_abs.display()));
            continue;
        }
        let cfg_path = paths::projects_dir().join(format!("{name}.toml"));
        let entries = match list_entries(&repo_abs) {
            Ok(e) => e,
            Err(e) => {
                plan.notes.push(format!("{name}: {e:#}, skipped"));
                continue;
            }
        };
        let pd = naming::project_dir(&repo_abs);
        // Config: keep an existing one, else generate from the main worktree.
        let (text, state) = match std::fs::read_to_string(&cfg_path) {
            Ok(t) => {
                let st = if marked_for_review(&t) { Cfg::NeedsReview } else { Cfg::Existing };
                (t, st)
            }
            Err(_) => {
                let usable = |e: &&WtEntry| !e.prunable && e.path.is_dir();
                let main = entries.iter().filter(usable).find(|e| naming::run_name(&pd, &e.path) == "main").or_else(|| entries.iter().find(usable));
                let inferred = main.and_then(|m| infer_dev(&m.path));
                let alias = format!("{}.{}", v1name.to_ascii_lowercase(), v1.zone);
                let alias_ok = renamed && config::validate_domain(&alias).is_ok();
                if renamed && !alias_ok {
                    plan.notes.push(format!("{name}: the v1 host {alias} is not a valid DNS name, so the main URL changes to {}", url_for(&name, "main", &v1.zone, proxy_port)));
                }
                let aliases: Vec<String> = if alias_ok { vec![alias] } else { vec![] };
                let stack = main.map(|m| detect_stack(&m.path, &v1name)).unwrap_or_default();
                let (t, st) = generate_config(&name, &home_relative(&repo_abs), &v1.zone, inferred.as_ref(), &aliases, &stack);
                config::parse_project(&t, &cfg_path).with_context(|| format!("generated config for {name} is invalid"))?;
                plan.configs.push(ConfigToWrite { project: name.clone(), path: cfg_path.clone(), text: t.clone(), state: st.clone() });
                (t, st)
            }
        };
        let parsed: toml::Value = toml::from_str(&text).unwrap_or(toml::Value::Table(Default::default()));
        let domain = parsed.get("domain").and_then(toml::Value::as_str).unwrap_or(&v1.zone).trim_matches('.').to_string();
        if renamed {
            let alias = format!("{}.{}", v1name.to_ascii_lowercase(), domain);
            let have = parsed.get("aliases").and_then(toml::Value::as_array).is_some_and(|a| a.iter().any(|x| x.as_str().is_some_and(|x| x.eq_ignore_ascii_case(&alias))));
            let url = |h: &str| if proxy_port == 80 { format!("http://{h}") } else { format!("http://{h}:{proxy_port}") };
            if have {
                plan.notes.push(format!("{name}: main also answers at {} (the v1 URL, kept as an alias)", url(&alias)));
            } else if !plan.configs.iter().any(|c| c.project == name) {
                plan.notes.push(format!("{name}: the existing config has no alias for {alias}, so the main URL changes from {} to {}; add `aliases = [\"{alias}\"]` to keep the old one", url(&alias), url_for(&name, "main", &domain, proxy_port)));
            }
        }
        let has_web = parsed.get("ports").and_then(|p| p.get("web")).is_some();
        let v1_ports = v1.ports_for(&v1name, &repo_abs);
        let mut seen_runs = BTreeSet::new();
        let mut rows: Vec<Row> = Vec::new();
        for e in &entries {
            let run = naming::run_name(&pd, &e.path);
            let skip = if e.path.to_string_lossy().contains("/.claude/worktrees/") {
                Some("claude-owned")
            } else if !inside_project_dir(&pd, &e.path) {
                // Throwaway checkouts that only `git worktree list` knows about (e.g. under /tmp).
                Some("outside workspace")
            } else if e.prunable {
                Some("prunable")
            } else if e.locked {
                Some("locked")
            } else if !seen_runs.insert(run.clone()) {
                Some("duplicate run name")
            } else {
                None
            };
            let reg = registered.get(&format!("{name}/{run}")).copied();
            let mut row = Row {
                project: name.clone(),
                worktree: e.path.clone(),
                url: url_for(&name, &run, &domain, proxy_port),
                run,
                port: PortPlan::None,
                cfg: state.clone(),
                registered: reg.is_some(),
            };
            if let Some(why) = skip {
                row.cfg = Cfg::Skipped(why);
                rows.push(row);
                continue;
            }
            if let Some(p) = reg {
                row.port = PortPlan::Registered(p);
            } else if has_web {
                row.port = match v1_ports.get(&row.run) {
                    None => PortPlan::New(None),
                    Some(&p) if !(1024..=65535).contains(&p) || RESERVED_PORTS.contains(&p) || p == dns || p == proxy_port => PortPlan::New(Some(format!("v1 port {p} out of range"))),
                    Some(&p) if claimed.contains(&p) => PortPlan::New(Some(format!("{p} already taken"))),
                    // Busy, but by this worktree's own dev server (its cwd is inside the worktree): kept.
                    Some(&p) if !port_is_free(p) && procinfo::external_listener(&e.path, p).is_some() => {
                        claimed.insert(p);
                        PortPlan::KeptRunning(p)
                    }
                    Some(&p) if !port_is_free(p) => PortPlan::New(Some(format!("{p} in use"))),
                    Some(&p) => {
                        claimed.insert(p);
                        PortPlan::Kept(p)
                    }
                };
            }
            rows.push(row);
        }
        rows.sort_by(|a, b| a.run.cmp(&b.run));
        plan.rows.extend(rows);
    }
    Ok(plan)
}

/// Is `wt` under `<workspace>/<project>/`? Both sides are canonicalized so /tmp vs /private/tmp cannot fool it.
fn inside_project_dir(project_dir: &Path, wt: &Path) -> bool {
    let wt_c = match wt.canonicalize() {
        Ok(p) => p,
        // A worktree whose directory is gone: resolve its parent so a symlinked prefix still compares right.
        Err(_) => wt.parent().and_then(|d| d.canonicalize().ok()).map(|d| d.join(wt.file_name().unwrap_or_default())).unwrap_or_else(|| wt.to_path_buf()),
    };
    wt_c.starts_with(canon(project_dir)) && wt_c != canon(project_dir)
}

fn home_relative(p: &Path) -> String {
    let (home, p) = (canon(&paths::expand("~")), canon(p));
    match p.strip_prefix(&home) {
        Ok(rel) => format!("~/{}", rel.display()),
        Err(_) => p.display().to_string(),
    }
}

pub fn table(rows: &[Row]) -> String {
    let mut lines: Vec<Vec<String>> = vec![["PROJECT", "WORKTREE", "RUN", "URL", "PORT", "CONFIG"].iter().map(|s| s.to_string()).collect()];
    for r in rows {
        let skipped = r.skipped();
        lines.push(vec![
            r.project.clone(),
            home_relative(&r.worktree),
            r.run.clone(),
            if skipped { "-".into() } else { r.url.clone() },
            if skipped { "-".into() } else { r.port.label() },
            r.cfg.label(),
        ]);
    }
    let widths: Vec<usize> = (0..6).map(|i| lines.iter().map(|l| l[i].chars().count()).max().unwrap_or(0)).collect();
    lines
        .iter()
        .map(|l| l.iter().enumerate().map(|(i, c)| if i == 5 { c.clone() } else { format!("{c:<w$}", w = widths[i]) }).collect::<Vec<_>>().join("  "))
        .collect::<Vec<_>>()
        .join("\n")
}

pub fn ledger_path() -> PathBuf {
    paths::archive_dir().parent().map(Path::to_path_buf).unwrap_or_else(|| PathBuf::from(".")).join("cutover-ledger.jsonl")
}

/// Append one JSON line. The ledger is never rewritten.
pub fn ledger_append(entry: Value) -> Result<()> {
    use std::io::Write;
    let p = ledger_path();
    if let Some(d) = p.parent() {
        std::fs::create_dir_all(d)?;
    }
    let mut v = entry;
    v["ts"] = json!(globalcfg::now_secs());
    let mut f = std::fs::OpenOptions::new().create(true).append(true).open(&p)?;
    writeln!(f, "{v}")?;
    Ok(())
}

pub fn summarize(rows: &[Row]) -> String {
    let skipped = rows.iter().filter(|r| r.skipped()).count();
    let done = rows.iter().filter(|r| r.registered && !r.skipped()).count();
    let kept = rows.iter().filter(|r| matches!(r.port, PortPlan::Kept(_) | PortPlan::KeptRunning(_))).count();
    format!("{} worktree(s): {} to adopt, {} already adopted, {} skipped; {} v1 port(s) to keep", rows.len(), rows.len() - skipped - done, done, skipped, kept)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn porcelain_flags() {
        let t = "worktree /r.git\nbare\n\nworktree /w/main\nHEAD abc\nbranch refs/heads/main\n\nworktree /w/x\nHEAD abc\ndetached\nlocked why\n\nworktree /w/gone\nHEAD abc\nbranch refs/heads/feat/a\nprunable gitdir file points to non-existent location\n";
        let e = parse_porcelain(t);
        assert_eq!(e.len(), 3);
        assert_eq!(e[0].branch.as_deref(), Some("main"));
        assert!(e[1].locked && !e[1].prunable);
        assert!(e[2].prunable && e[2].branch.as_deref() == Some("feat/a"));
    }

    #[test]
    fn generated_configs_parse() {
        for inf in [Some(Inferred { run: "bun run dev".into(), how: "x".into() }), None] {
            let (t, _) = generate_config("p", "~/workspace/p.git", "quivly.local", inf.as_ref(), &[], &Stack::default());
            config::parse_project(&t, Path::new("p.toml")).unwrap();
        }
    }

    #[test]
    fn infers_package_managers() {
        let d = std::env::temp_dir().join(format!("setu-infer-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        assert!(infer_dev(&d).is_none());
        std::fs::write(d.join("package.json"), r#"{"scripts":{"dev":"next dev"}}"#).unwrap();
        assert_eq!(infer_dev(&d).unwrap().run, "npm run dev");
        std::fs::write(d.join("pnpm-lock.yaml"), "").unwrap();
        assert_eq!(infer_dev(&d).unwrap().run, "pnpm run dev");
        std::fs::write(d.join("bun.lock"), "").unwrap();
        assert_eq!(infer_dev(&d).unwrap().run, "bun run dev");
        std::fs::write(d.join("package.json"), r#"{"scripts":{"dev":"vite"}}"#).unwrap();
        assert!(infer_dev(&d).unwrap().run.ends_with("--port {port.web} --strictPort"));
        let _ = std::fs::remove_dir_all(&d);
    }

    fn write_all(root: &Path, files: &[(&str, &str)]) {
        for (f, c) in files {
            let p = root.join(f);
            std::fs::create_dir_all(p.parent().unwrap()).unwrap();
            std::fs::write(p, c).unwrap();
        }
    }

    #[test]
    fn a_trigger_inngest_workos_nx_repo_gets_the_complete_config() {
        let d = std::env::temp_dir().join(format!("setu-stack-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        write_all(
            &d,
            &[
                ("package.json", r#"{"scripts":{"dev":"next dev"},"dependencies":{"@trigger.dev/sdk":"^4.4.6"}}"#),
                ("bun.lock", ""),
                ("nx.json", "{}"),
                ("trigger.config.ts", "export default {}"),
                ("apps/quivly-app/package.json", r#"{"dependencies":{"inngest":"3","@workos-inc/authkit-nextjs":"2","next":"16"}}"#),
            ],
        );
        let st = detect_stack(&d, "quivly-app");
        assert_eq!(
            st,
            Stack { js: true, workos: true, nx: true, trigger: Some(String::new()), trigger_env_file: Some("apps/quivly-app/.env.local".into()), inngest: true, convex: None, pm: "bun" }
        );
        let inf = infer_dev(&d);
        let (t, state) = generate_config("quivly-app", "~/workspace/quivly-app.git", "quivly.local", inf.as_ref(), &[], &st);
        assert_eq!(state, Cfg::Generated);
        let squeezed = t.lines().map(|l| l.split_whitespace().collect::<Vec<_>>().join(" ")).collect::<Vec<_>>().join("\n");
        for want in [
            "inngest = {}",
            "NEXT_PUBLIC_APP_BASE_URL = \"{url}\"",
            "NEXT_PUBLIC_WORKOS_REDIRECT_URI = \"{url}/authentication/callback\"",
            "NX_DAEMON = \"false\"",
            "INNGEST_DEV = \"1\"",
            "INNGEST_BASE_URL = \"http://127.0.0.1:{port.inngest}\"",
            "TRIGGER_DEV_BRANCH = \"{run}\"",
            "TRIGGER_PREVIEW_BRANCH = \"{run}\"",
            "run = \"bun run dev\"",
            "run = \"inngest dev -p {port.inngest} -u http://127.0.0.1:{port.web}/api/inngest --no-discovery\"",
            "run = \"setu x trigger-dev --max-concurrent-runs 2 --env-file apps/quivly-app/.env.local\"",
        ] {
            assert!(squeezed.contains(want), "missing {want:?} in:\n{t}");
        }
        assert!(!t.contains("[procs.convex]"));
        let cfg = config::parse_project(&t, Path::new("quivly-app.toml")).unwrap();
        let run = config::resolve_run(&cfg, Path::new("/w"), "feat-x", &BTreeMap::from([("web".to_string(), 4001u16), ("inngest".to_string(), 4002u16)]), &BTreeMap::new(), &BTreeMap::new()).unwrap();
        assert_eq!(run.env["TRIGGER_DEV_BRANCH"], "feat-x");
        assert_eq!(run.env["INNGEST_BASE_URL"], "http://127.0.0.1:4002");
        assert_eq!(run.env["NEXT_PUBLIC_WORKOS_REDIRECT_URI"], format!("{}/authentication/callback", run.env["NEXT_PUBLIC_APP_BASE_URL"]));
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn a_plain_app_and_a_convex_app_get_only_what_they_use() {
        let d = std::env::temp_dir().join(format!("setu-stack2-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        write_all(&d, &[("package.json", r#"{"scripts":{"dev":"vite"},"dependencies":{"react":"1"}}"#)]);
        let st = detect_stack(&d, "plain");
        assert_eq!(st, Stack { js: true, pm: "npm", ..Default::default() });
        let (t, _) = generate_config("plain", "~/workspace/plain.git", "q.local", infer_dev(&d).as_ref(), &[], &st);
        assert!(t.contains("NEXT_PUBLIC_APP_BASE_URL") && !t.contains("WORKOS") && !t.contains("NX_DAEMON") && !t.contains("INNGEST") && !t.contains("TRIGGER") && !t.contains("[procs.trigger]") && !t.contains("[procs.convex]"), "{t}");
        assert!(t.contains("--port {port.web} --strictPort"), "vite keeps its explicit port flag: {t}");
        write_all(&d, &[("apps/web/package.json", r#"{"dependencies":{"convex":"1"}}"#), ("pnpm-lock.yaml", "")]);
        let st = detect_stack(&d, "plain");
        assert_eq!(st.convex.as_deref(), Some("apps/web"));
        let (t, _) = generate_config("plain", "~/workspace/plain.git", "q.local", None, &[], &st);
        assert!(t.contains("[procs.convex]\nrun = \"pnpm exec convex dev\"\ncwd = \"apps/web\""), "{t}");
        config::parse_project(&t, Path::new("p.toml")).unwrap();
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn url_omits_port_80() {
        assert_eq!(url_for("app", "main", "q.local", 80), "http://app.q.local");
        assert_eq!(url_for("app", "feat-x", "q.local", 7777), "http://feat-x.q.local:7777");
    }

    #[test]
    fn a_generated_config_for_a_renamed_project_keeps_the_v1_host_as_an_alias() {
        let (t, _) = generate_config("quivly-site2-0", "~/workspace/quivly-site2.0.git", "quivly.local", None, &["quivly-site2.0.quivly.local".to_string()], &Stack::default());
        let cfg = config::parse_project(&t, Path::new("x.toml")).unwrap();
        assert_eq!(cfg.project, "quivly-site2-0");
        assert_eq!(cfg.aliases, vec!["quivly-site2.0.quivly.local".to_string()]);
        let main = config::resolve_run(&cfg, Path::new("/w"), "main", &BTreeMap::from([("web".to_string(), 4001u16)]), &BTreeMap::new(), &BTreeMap::new()).unwrap();
        assert_eq!(main.host, "quivly-site2-0.quivly.local");
        assert_eq!(main.aliases, cfg.aliases);
    }

    #[test]
    fn plan_skips_worktrees_outside_the_workspace_project_dir() {
        let sb = crate::env::tests::sandbox();
        let g = |dir: &Path, args: &[&str]| {
            let st = Command::new("git")
                .args(["-c", "user.email=e@e", "-c", "user.name=e", "-c", "commit.gpgsign=false", "-c", "protocol.file.allow=always"])
                .args(args)
                .current_dir(dir)
                .stdout(std::process::Stdio::null())
                .stderr(std::process::Stdio::null())
                .status()
                .unwrap();
            assert!(st.success(), "git {args:?}");
        };
        let ws = canon(&sb.dir).join("ws");
        let seed = canon(&sb.dir).join("seed");
        std::fs::create_dir_all(&ws).unwrap();
        std::fs::create_dir_all(&seed).unwrap();
        g(&seed, &["init", "-q", "-b", "main", "."]);
        std::fs::write(seed.join("f"), "x").unwrap();
        g(&seed, &["add", "-A"]);
        g(&seed, &["commit", "-q", "-m", "i"]);
        g(&ws, &["clone", "-q", "--bare", seed.to_str().unwrap(), "app.git"]);
        let bare = ws.join("app.git");
        g(&ws, &["--git-dir", bare.to_str().unwrap(), "worktree", "add", "-q", ws.join("app/main").to_str().unwrap(), "main"]);
        let scratch = canon(&sb.dir).join("scratch/wt-1");
        g(&ws, &["--git-dir", bare.to_str().unwrap(), "worktree", "add", "-q", "-b", "scratch1", scratch.to_str().unwrap(), "main"]);
        let v1 = V1 { workspace: ws.clone(), zone: "q.local".into(), projects: vec!["app".into()], ports_raw: vec![] };
        let plan = plan(&v1, &BTreeMap::new(), &|_| true).unwrap();
        let by = |run: &str| plan.rows.iter().find(|r| r.worktree.ends_with(run)).unwrap_or_else(|| panic!("{run}: {:?}", plan.rows.iter().map(|r| &r.worktree).collect::<Vec<_>>())).clone();
        assert!(!by("app/main").skipped());
        assert_eq!(by("scratch/wt-1").cfg, Cfg::Skipped("outside workspace"));
        assert_eq!(by("scratch/wt-1").cfg.label(), "skipped (outside workspace)");
    }
}
