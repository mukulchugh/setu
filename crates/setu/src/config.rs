//! Project config loading, env layers, template rendering and run resolution.
#![allow(dead_code)]

use crate::model::{DiskItem, DiskKind, DiskStore, Install, ProcSpec, ProjectConfig, ResolvedProc, RunId, RunSpec, SetupStep, WorktreeCfg};
use crate::presets::{self, RawItem};
use crate::{naming, paths, recipes, worktree};
use anyhow::{anyhow, bail, Context, Result};
use serde::Deserialize;
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::time::Duration;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RawProject {
    project: String,
    repo: String,
    domain: String,
    #[serde(default)]
    aliases: Vec<String>,
    idle: Option<String>,
    max_running: Option<usize>,
    #[serde(default)]
    ports: BTreeMap<String, RawPort>,
    #[serde(default)]
    env: BTreeMap<String, String>,
    #[serde(default)]
    procs: BTreeMap<String, RawProc>,
    /// Recipes to merge in (shipped ones and `<config dir>/recipes/*.toml`); keys written here win.
    #[serde(default)]
    recipes: Vec<String>,
    preset: Option<RawPresetSel>,
    #[serde(default)]
    disk: RawDisk,
    #[serde(default)]
    worktree: RawWorktree,
    #[serde(default)]
    setup: RawSetup,
    /// `auto_install = false` opts out of reinstalling missing dependencies on start.
    auto_install: Option<bool>,
}

#[derive(Deserialize, Default)]
#[serde(deny_unknown_fields)]
struct RawWorktree {
    base: Option<String>,
    #[serde(default)]
    link: Vec<String>,
    #[serde(default)]
    copy: Vec<String>,
    min_free: Option<String>,
}

#[derive(Deserialize, Default)]
#[serde(deny_unknown_fields)]
struct RawSetup {
    #[serde(default)]
    step: Vec<RawSetupStep>,
    /// Same switch as the top-level `auto_install`; either one set to false turns it off.
    auto_install: Option<bool>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RawSetupStep {
    name: String,
    run: String,
    #[serde(default)]
    inputs: Vec<String>,
}

/// `preset = "next"` or `preset = ["auto", "next"]`.
#[derive(Deserialize)]
#[serde(untagged)]
pub(crate) enum RawPresetSel {
    One(String),
    Many(Vec<String>),
}

/// The `[[disk.item]]` / `[[disk.store]]` tables; shared by project configs and preset files.
#[derive(Deserialize, Default)]
#[serde(deny_unknown_fields)]
pub(crate) struct RawDisk {
    #[serde(default)]
    pub item: Vec<RawDiskItem>,
    #[serde(default)]
    pub store: Vec<RawDiskStore>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct RawDiskItem {
    name: String,
    kind: Option<DiskKind>,
    #[serde(default)]
    paths: Vec<String>,
    clean_after: Option<String>,
    #[serde(default)]
    disabled: bool,
    /// Deps items: command that restores the item when its path is missing.
    install: Option<String>,
    #[serde(default)]
    lockfiles: Vec<String>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct RawDiskStore {
    name: String,
    path: String,
    warn_below: Option<String>,
}

/// Port options are reserved for later; only empty tables are accepted.
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RawPort {}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RawProc {
    run: String,
    port: Option<String>,
    #[serde(default)]
    mise: bool,
    cwd: Option<String>,
}

pub fn parse_duration(s: &str) -> Result<Duration> {
    let s = s.trim();
    let split = s.find(|c: char| !c.is_ascii_digit()).unwrap_or(s.len());
    let (num, unit) = s.split_at(split);
    let n: u64 = num.parse().map_err(|_| anyhow!("invalid duration {s:?}: expected e.g. 90s, 30m, 2h, 7d"))?;
    let mult = match unit {
        "s" => 1,
        "m" => 60,
        "h" => 3600,
        "d" => 86400,
        _ => bail!("invalid duration {s:?}: unit must be s, m, h or d"),
    };
    Ok(Duration::from_secs(n * mult))
}

/// Parse a size like "1GiB", "500MB", "2048KiB" or "512" (bytes). SI units are powers of 1000,
/// IEC units (KiB, MiB, GiB, TiB) powers of 1024. Decimals are allowed ("1.5GiB").
pub fn parse_size(s: &str) -> Result<u64> {
    let t = s.trim();
    let split = t.find(|c: char| !(c.is_ascii_digit() || c == '.')).unwrap_or(t.len());
    let (num, unit) = t.split_at(split);
    let n: f64 = num.parse().map_err(|_| anyhow!("invalid size {s:?}: expected e.g. 1GiB, 500MB, 2048KiB"))?;
    let mult: f64 = match unit.trim().to_ascii_lowercase().as_str() {
        "" | "b" => 1.0,
        "kb" => 1e3,
        "mb" => 1e6,
        "gb" => 1e9,
        "tb" => 1e12,
        "kib" => 1024.0,
        "mib" => 1048576.0,
        "gib" => 1073741824.0,
        "tib" => 1099511627776.0,
        _ => bail!("invalid size {s:?}: unknown unit {:?}", unit.trim()),
    };
    Ok((n * mult) as u64)
}

/// A disk path must be relative, without `..`, empty segments or a leading `/`; `*` is only
/// allowed as a whole segment.
pub fn validate_disk_path(p: &str) -> Result<()> {
    if p.is_empty() {
        bail!("empty path");
    }
    if p.starts_with('/') {
        bail!("path {p:?} must be relative (no leading '/')");
    }
    for seg in p.split('/') {
        if seg.is_empty() {
            bail!("path {p:?} has an empty segment");
        }
        if seg == ".." {
            bail!("path {p:?} must not contain '..'");
        }
        if seg.contains('*') && seg != "*" {
            bail!("path {p:?}: '*' is only allowed as a whole segment");
        }
    }
    Ok(())
}

pub(crate) fn convert_item(r: RawDiskItem) -> Result<RawItem> {
    let name = r.name;
    let ctx = || format!("disk item {name:?}");
    if r.disabled {
        // A disabled item only needs its name; it removes a preset item of that name.
        let item = DiskItem { name: name.clone(), kind: r.kind.unwrap_or(DiskKind::Cache), paths: vec![], clean_after: None, install: None };
        return Ok(RawItem { item, disabled: true });
    }
    let kind = r.kind.ok_or_else(|| anyhow!("kind is required (deps, output or cache)")).with_context(ctx)?;
    if r.paths.is_empty() {
        return Err(anyhow!("paths is required and must not be empty")).with_context(ctx);
    }
    for p in &r.paths {
        validate_disk_path(p).with_context(ctx)?;
    }
    let clean_after = r.clean_after.as_deref().map(parse_duration).transpose().with_context(ctx)?;
    let install = match r.install {
        None => None,
        Some(run) => {
            if kind != DiskKind::Deps {
                return Err(anyhow!("install is only valid on a deps item")).with_context(ctx);
            }
            if run.trim().is_empty() {
                return Err(anyhow!("install must not be empty")).with_context(ctx);
            }
            for l in &r.lockfiles {
                validate_disk_path(l).with_context(ctx)?;
            }
            Some(Install { run, lockfiles: r.lockfiles })
        }
    };
    Ok(RawItem { item: DiskItem { name: name.clone(), kind, paths: r.paths, clean_after, install }, disabled: false })
}

pub(crate) fn convert_store(r: RawDiskStore) -> Result<DiskStore> {
    let warn_below = r.warn_below.as_deref().map(parse_size).transpose().with_context(|| format!("disk store {:?}", r.name))?;
    Ok(DiskStore { name: r.name, path: paths::expand(&r.path), warn_below })
}

pub(crate) fn convert_disk(d: RawDisk) -> Result<(Vec<RawItem>, Vec<DiskStore>)> {
    let items = d.item.into_iter().map(convert_item).collect::<Result<_>>()?;
    let stores = d.store.into_iter().map(convert_store).collect::<Result<_>>()?;
    Ok((items, stores))
}

fn convert_worktree(r: RawWorktree) -> Result<WorktreeCfg> {
    for p in r.link.iter().chain(r.copy.iter()) {
        // `*` has no meaning here; reject it instead of guessing.
        if p.contains('*') {
            bail!("[worktree] path {p:?} must not contain '*'");
        }
        validate_disk_path(p).context("[worktree] link/copy")?;
    }
    if let Some(b) = &r.base {
        if b.is_empty() || b.starts_with('-') {
            bail!("[worktree] base {b:?} is not a valid ref");
        }
    }
    let min_free = r.min_free.as_deref().map(parse_size).transpose().context("[worktree] min_free")?;
    Ok(WorktreeCfg { base: r.base, link: r.link, copy: r.copy, min_free })
}

pub(crate) fn parse_project(text: &str, file: &Path) -> Result<ProjectConfig> {
    parse_project_in(text, file, |_| None)
}

/// Parse a project; `checkout` maps the repo to the checkout root used for preset detection.
fn parse_project_in(text: &str, file: &Path, checkout: impl FnOnce(&Path) -> Option<PathBuf>) -> Result<ProjectConfig> {
    parse_project_with(text, file, checkout, Some(&recipes::user_dir()))
}

/// `parse_project_in` with the directory that holds the user's own recipes spelled out.
pub(crate) fn parse_project_with(text: &str, file: &Path, checkout: impl FnOnce(&Path) -> Option<PathBuf>, recipe_dir: Option<&Path>) -> Result<ProjectConfig> {
    let raw: RawProject = toml::from_str(text).with_context(|| format!("invalid project config {}", file.display()))?;
    validate_project_name(&raw.project).with_context(|| format!("in {}", file.display()))?;
    validate_domain(&raw.domain).with_context(|| format!("in {}", file.display()))?;
    let mut aliases: Vec<String> = Vec::new();
    for a in &raw.aliases {
        let a = a.to_ascii_lowercase();
        validate_domain(&a).with_context(|| format!("alias {a:?} in {}", file.display()))?;
        if !a.ends_with(&format!(".{}", raw.domain.to_ascii_lowercase())) {
            bail!("{}: alias {a:?} must be a host under the project domain {:?} (Setu's DNS only answers that domain)", file.display(), raw.domain);
        }
        if !aliases.contains(&a) {
            aliases.push(a);
        }
    }
    let idle = parse_duration(raw.idle.as_deref().unwrap_or("30m")).with_context(|| format!("in {}", file.display()))?;
    let mut procs = BTreeMap::new();
    for (name, p) in raw.procs {
        procs.insert(name, ProcSpec { run: p.run, port: p.port, mise: p.mise, cwd: p.cwd });
    }
    let requested: Vec<String> = match raw.preset {
        None => vec!["auto".into()],
        Some(RawPresetSel::One(s)) => vec![s],
        Some(RawPresetSel::Many(v)) => v,
    };
    let (items, stores) = convert_disk(raw.disk).with_context(|| format!("in {}", file.display()))?;
    let worktree = convert_worktree(raw.worktree).with_context(|| format!("in {}", file.display()))?;
    let auto_install = raw.auto_install != Some(false) && raw.setup.auto_install != Some(false);
    let mut setup_steps = Vec::new();
    for st in raw.setup.step {
        if st.name.trim().is_empty() || st.run.trim().is_empty() {
            bail!("{}: every [[setup.step]] needs a name and a run", file.display());
        }
        if setup_steps.iter().any(|o: &SetupStep| o.name == st.name) {
            bail!("{}: duplicate setup step {:?}", file.display(), st.name);
        }
        for p in &st.inputs {
            validate_disk_path(p).with_context(|| format!("setup step {:?} inputs", st.name))?;
        }
        setup_steps.push(SetupStep { name: st.name, run: st.run, inputs: st.inputs });
    }
    let repo = paths::expand(&raw.repo);
    let checkout = if requested.iter().any(|r| r == "auto") { checkout(&repo) } else { None };
    let (presets, disk_items, stores) = presets::resolve(&requested, checkout.as_deref(), &items, &stores)
        .with_context(|| format!("in {}", file.display()))?;
    let mut cfg = ProjectConfig {
        project: raw.project,
        repo,
        presets,
        disk_items,
        stores,
        worktree,
        setup_steps,
        auto_install,
        domain: raw.domain,
        aliases,
        idle,
        max_running: raw.max_running.unwrap_or(3),
        ports: raw.ports.into_keys().collect(),
        env: raw.env,
        procs,
    };
    merge_recipes(&mut cfg, &raw.recipes, file, recipe_dir)?;
    for (name, p) in &cfg.procs {
        if let Some(port) = &p.port {
            if !cfg.ports.contains(port) {
                bail!("{}: proc {name:?} uses port {port:?} which is not in [ports]", file.display());
            }
        }
    }
    Ok(cfg)
}

/// Merge the named recipes into `cfg`: their ports, env and procs fill in what the project does not
/// say itself (a key written in the project always wins; with two recipes the first one listed wins).
/// The generation-time variables are filled from the main worktree, once per load.
fn merge_recipes(cfg: &mut ProjectConfig, names: &[String], file: &Path, recipe_dir: Option<&Path>) -> Result<()> {
    if names.is_empty() {
        return Ok(());
    }
    let main = worktree::main_dir(cfg);
    for r in recipes::resolve(names, file, &main, &cfg.project, recipe_dir)? {
        for port in r.ports.into_keys() {
            if !cfg.ports.contains(&port) {
                cfg.ports.push(port);
            }
        }
        for (k, v) in r.env {
            cfg.env.entry(k).or_insert(v);
        }
        for (name, p) in r.procs {
            cfg.procs.entry(name).or_insert(ProcSpec { run: p.run, port: p.port, mise: false, cwd: p.cwd });
        }
    }
    cfg.ports.sort();
    Ok(())
}

pub fn load_project(path: &Path) -> Result<ProjectConfig> {
    let text = std::fs::read_to_string(path).with_context(|| format!("reading {}", path.display()))?;
    parse_project_in(&text, path, main_checkout)
}

/// The repo's main worktree if present, else its first worktree; errors mean "no checkout".
fn main_checkout(repo: &Path) -> Option<PathBuf> {
    let main = naming::project_dir(repo).join("main");
    if main.is_dir() {
        return Some(main);
    }
    naming::list_worktrees(repo).ok()?.into_iter().next()
}

fn load_dir(dir: &Path) -> Result<Vec<ProjectConfig>> {
    let rd = match std::fs::read_dir(dir) {
        Ok(rd) => rd,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(vec![]),
        Err(e) => return Err(e).with_context(|| format!("reading {}", dir.display())),
    };
    let mut files: Vec<PathBuf> = rd
        .filter_map(|e| e.ok().map(|e| e.path()))
        .filter(|p| p.extension().is_some_and(|x| x == "toml"))
        .collect();
    files.sort();
    let mut out: Vec<ProjectConfig> = Vec::new();
    for f in files {
        let c = load_project(&f)?;
        if out.iter().any(|o| o.project == c.project) {
            bail!("duplicate project name {:?} ({})", c.project, f.display());
        }
        // Projects may share a domain (v1 put every project on `quivly.local`); a host that two
        // runs would both claim is refused when the second one registers.
        out.push(c);
    }
    Ok(out)
}

pub fn load_all() -> Result<Vec<ProjectConfig>> {
    load_dir(&paths::projects_dir())
}

pub fn load_env_layer(path: &Path) -> Result<BTreeMap<String, String>> {
    let text = match std::fs::read_to_string(path) {
        Ok(t) => t,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(BTreeMap::new()),
        Err(e) => return Err(e).with_context(|| format!("reading {}", path.display())),
    };
    toml::from_str(&text).map_err(|e| {
        // toml's own message quotes the offending source line, which may be a secret value.
        let at = e.span().map(|sp| {
            let line = text[..sp.start.min(text.len())].matches('\n').count() + 1;
            format!(" at line {line}")
        });
        anyhow!("invalid env file {}{} (values must be strings; the line is not shown because it may hold a secret)", path.display(), at.unwrap_or_default())
    })
}

/// A project name is a single plain path component: it names files in the env directory, so a
/// dot, a separator or the name `global` could alias another scope's files (review #12).
pub fn validate_project_name(name: &str) -> Result<()> {
    let ok = !name.is_empty()
        && name.len() <= 64
        && name.chars().next().is_some_and(|c| c.is_ascii_alphanumeric())
        && name.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
        && !name.eq_ignore_ascii_case("global");
    if !ok {
        bail!("project name {name:?} must be 1-64 letters, digits, '-' or '_' (starting with a letter or digit) and cannot be \"global\"");
    }
    Ok(())
}

/// A project domain is a DNS name. It becomes a file name under /etc/resolver, so anything that
/// is not plain labels (separators, `..`, absolute paths, control characters) is refused (review #22).
pub fn validate_domain(domain: &str) -> Result<()> {
    let bad = || anyhow!("domain {domain:?} is not a valid DNS name (use dot-separated labels of letters, digits and '-')");
    if domain.is_empty() || domain.len() > 253 {
        return Err(bad());
    }
    for label in domain.split('.') {
        let b = label.as_bytes();
        let ok = !b.is_empty() && b.len() <= 63 && b[0] != b'-' && b[b.len() - 1] != b'-' && b.iter().all(|c| c.is_ascii_alphanumeric() || *c == b'-');
        if !ok {
            return Err(bad());
        }
    }
    Ok(())
}

/// A hostname for `setu alias`: trimmed, lowercased, a valid DNS name. IPs, wildcards, ports and
/// anything over 253 characters are refused.
pub fn validate_custom_host(raw: &str) -> Result<String> {
    let host = raw.trim().to_lowercase();
    if host.is_empty() {
        bail!("give a hostname, e.g. demo.example.test");
    }
    if host.contains('*') {
        bail!("{raw:?}: wildcards are not supported; give one exact hostname");
    }
    if host.len() > 253 {
        bail!("{raw:?}: a hostname is at most 253 characters");
    }
    if host.parse::<std::net::IpAddr>().is_ok() || host.rsplit('.').next().is_some_and(|l| l.bytes().all(|c| c.is_ascii_digit())) {
        bail!("{raw:?}: an IP address is not a hostname; Setu routes by name");
    }
    if host.contains(':') || host.contains('/') {
        bail!("{raw:?}: give the bare hostname, without a port or path");
    }
    validate_domain(&host).map_err(|_| anyhow!("{raw:?} is not a valid hostname (lowercase letters, digits and '-', dot-separated labels of at most 63 characters)"))?;
    Ok(host)
}

pub fn global_env_path() -> PathBuf {
    paths::env_dir().join("global.toml")
}

pub fn worktree_env_path(id: &RunId) -> PathBuf {
    paths::env_dir().join(&id.project).join(format!("{}.toml", id.run))
}

/// Render `{name}` placeholders. Errors never quote the template: an unknown placeholder in a
/// secret-looking config value may itself be a credential, so diagnostics carry only a fixed
/// message and a byte offset (the caller's context names the env variable or proc).
pub fn render(template: &str, vars: &BTreeMap<String, String>) -> Result<String> {
    let mut out = String::with_capacity(template.len());
    let mut it = template.char_indices().peekable();
    while let Some((at, c)) = it.next() {
        match c {
            '{' if matches!(it.peek(), Some((_, '{'))) => {
                it.next();
                out.push('{');
            }
            '}' if matches!(it.peek(), Some((_, '}'))) => {
                it.next();
                out.push('}');
            }
            '{' => {
                let mut name = String::new();
                loop {
                    match it.next() {
                        Some((_, '}')) => break,
                        Some((_, ch)) => name.push(ch),
                        None => bail!("unterminated '{{' at byte offset {at} in a template value (contents not shown)"),
                    }
                }
                match vars.get(name.trim()) {
                    Some(v) => out.push_str(v),
                    None => bail!("unknown template variable at byte offset {at} (contents not shown)"),
                }
            }
            '}' => bail!("stray '}}' at byte offset {at} in a template value (use '}}}}' for a literal brace)"),
            c => out.push(c),
        }
    }
    Ok(out)
}

pub fn resolve_run(
    cfg: &ProjectConfig,
    worktree: &Path,
    run: &str,
    ports: &BTreeMap<String, u16>,
    global_env: &BTreeMap<String, String>,
    worktree_env: &BTreeMap<String, String>,
) -> Result<RunSpec> {
    let host = naming::host_for(cfg, run);
    let port = crate::globalcfg::proxy_port();
    let url = if port == 80 { format!("http://{host}") } else { format!("http://{host}:{port}") };
    let mut vars: BTreeMap<String, String> = BTreeMap::new();
    vars.insert("project".into(), cfg.project.clone());
    vars.insert("run".into(), run.to_string());
    vars.insert("domain".into(), cfg.domain.clone());
    vars.insert("host".into(), host.clone());
    vars.insert("url".into(), url.clone());
    vars.insert("worktree".into(), worktree.to_string_lossy().into_owned());
    let mut leased = BTreeMap::new();
    for name in &cfg.ports {
        let p = ports.get(name).ok_or_else(|| anyhow!("no leased port for {name:?} in {}/{run}", cfg.project))?;
        vars.insert(format!("port.{name}"), p.to_string());
        leased.insert(name.clone(), *p);
    }

    let mut env = global_env.clone();
    for (k, v) in &cfg.env {
        env.insert(k.clone(), render(v, &vars).with_context(|| format!("env {k}"))?);
    }
    for (k, v) in worktree_env {
        env.insert(k.clone(), render(v, &vars).with_context(|| format!("worktree env {k}"))?);
    }
    env.insert("SETU_PROJECT".into(), cfg.project.clone());
    env.insert("SETU_RUN".into(), run.to_string());
    env.insert("SETU_URL".into(), url.clone());

    let web_port = cfg.web_proc().and_then(|(_, p)| p.port.as_ref()).and_then(|n| leased.get(n).copied());
    if let Some(p) = web_port {
        env.insert("PORT".into(), p.to_string());
    }

    let mut procs = Vec::new();
    for (name, p) in &cfg.procs {
        let mut command = render(&p.run, &vars).with_context(|| format!("proc {name}"))?;
        if p.mise {
            command = format!("mise exec -- {command}");
        }
        procs.push(ResolvedProc {
            name: name.clone(),
            command,
            cwd: worktree.join(p.cwd.as_deref().unwrap_or(".")),
            port: p.port.as_ref().and_then(|n| leased.get(n).copied()),
            log_path: paths::logs_dir().join(&cfg.project).join(run).join(format!("{name}.log")),
        });
    }
    Ok(RunSpec {
        id: RunId { project: cfg.project.clone(), run: run.to_string() },
        worktree: worktree.to_path_buf(),
        host,
        url,
        ports: leased,
        env,
        procs,
        web_port,
        idle: cfg.idle,
        aliases: if run == "main" { cfg.aliases.clone() } else { Vec::new() },
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    const SAMPLE: &str = r#"
project = "quivly-app"
repo = "/r/quivly-app.git"
domain = "quivly.local"
idle = "90s"

[ports.web]
[ports.inngest]

[env]
A = "project"
B = "{host}"
URLISH = "{url}/x"

[procs.web]
run = "bun dev --port {port.web}"
port = "web"
mise = true
cwd = "apps/web"

[procs.worker]
run = "bun worker {{literal}}"
"#;

    fn sample() -> ProjectConfig {
        parse_project(SAMPLE, Path::new("t.toml")).unwrap()
    }

    fn map(v: &[(&str, &str)]) -> BTreeMap<String, String> {
        v.iter().map(|(a, b)| (a.to_string(), b.to_string())).collect()
    }

    /// A project whose main worktree is `<tmp>/<tag>/main` (files given), plus a user recipe dir.
    fn recipe_fixture(tag: &str, files: &[(&str, &str)]) -> (PathBuf, PathBuf) {
        let base = std::env::temp_dir().join(format!("setu-cfg-recipes-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        let main = base.join("app/main");
        for (f, c) in files {
            let p = main.join(f);
            std::fs::create_dir_all(p.parent().unwrap()).unwrap();
            std::fs::write(p, c).unwrap();
        }
        std::fs::create_dir_all(base.join("recipes")).unwrap();
        (base.clone(), base.join("recipes"))
    }

    fn recipe_cfg(base: &Path, user: &Path, extra_top: &str, extra: &str) -> Result<ProjectConfig> {
        let text = format!("project = \"app\"\nrepo = \"{}/app.git\"\ndomain = \"q.local\"\n{extra_top}\n[ports]\nweb = {{}}\n{extra}", base.display());
        parse_project_with(&text, Path::new("app.toml"), |_| None, Some(user))
    }

    #[test]
    fn recipes_are_merged_into_the_project_at_load() {
        let (base, user) = recipe_fixture("merge", &[("bun.lock", ""), ("apps/app/package.json", r#"{"dependencies":{"inngest":"3"}}"#), ("trigger.config.ts", "")]);
        let c = recipe_cfg(&base, &user, "recipes = [\"trigger\", \"inngest\", \"nx\"]", "[procs.web]\nrun = \"x\"\nport = \"web\"\n").unwrap();
        assert_eq!(c.procs.keys().map(String::as_str).collect::<Vec<_>>(), ["inngest", "trigger", "web"]);
        assert!(c.ports.contains(&"inngest".to_string()) && c.ports.contains(&"web".to_string()));
        assert_eq!(c.env["NX_DAEMON"], "false");
        assert_eq!(c.env["TRIGGER_DEV_BRANCH"], "{run}", "run-time variables stay for run time");
        let t = &c.procs["trigger"].run;
        assert!(t.contains("exec bunx") && t.contains("{worktree}/apps/app/.env.local"), "{t}");
        assert!(!t.contains("{app_dir}") && !t.contains("{pm"), "{t}");
        assert_eq!(c.procs["trigger"].cwd.as_deref(), Some(""), "the config sits at the root of the main worktree");
        assert!(c.procs["inngest"].run.contains("{port.inngest}"), "{}", c.procs["inngest"].run);
        // A project without recipes is untouched.
        let plain = recipe_cfg(&base, &user, "", "[procs.web]\nrun = \"x\"\nport = \"web\"\n").unwrap();
        assert_eq!(plain.procs.len(), 1);
        assert!(plain.env.is_empty());
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn keys_written_in_the_project_win_over_the_recipe() {
        let (base, user) = recipe_fixture("override", &[("trigger.config.ts", "")]);
        let c = recipe_cfg(
            &base,
            &user,
            "recipes = [\"trigger\", \"nx\"]",
            "\n[env]\nNX_DAEMON = \"true\"\n\n[procs.trigger]\nrun = \"my own worker\"\n",
        )
        .unwrap();
        assert_eq!(c.procs["trigger"].run, "my own worker");
        assert_eq!(c.procs["trigger"].cwd, None, "the whole proc is replaced, not merged field by field");
        assert_eq!(c.env["NX_DAEMON"], "true");
        assert_eq!(c.env["TRIGGER_DEV_BRANCH"], "{run}", "other recipe keys still apply");
        // a port the project already declares is not duplicated
        std::fs::write(user.join("p.toml"), "name = \"p\"\n[detect]\nany_of = [{ file = \"x\" }]\n[ports]\nweb = {}\nside = {}\n[procs.p]\nrun = \"go\"\nport = \"side\"\n").unwrap();
        let c = recipe_cfg(&base, &user, "recipes = [\"p\"]", "").unwrap();
        assert_eq!(c.ports, ["side", "web"]);
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn an_unknown_recipe_is_a_config_error_naming_the_file_and_the_choices() {
        let (base, user) = recipe_fixture("unknown", &[]);
        let e = format!("{:#}", recipe_cfg(&base, &user, "recipes = [\"nope\"]", "").unwrap_err());
        assert!(e.contains("app.toml") && e.contains("unknown recipe \"nope\"") && e.contains("available recipes:") && e.contains("trigger") && e.contains("nx"), "{e}");
        // a user recipe is available by name, and overrides a shipped one
        std::fs::write(user.join("mine.toml"), "name = \"nx\"\n[detect]\nany_of = [{ file = \"nx.json\" }]\n[env]\nNX_DAEMON = \"mine\"\n").unwrap();
        std::fs::write(user.join("extra.toml"), "name = \"extra\"\n[detect]\nany_of = [{ file = \"e\" }]\n[env]\nE = \"1\"\n").unwrap();
        let c = recipe_cfg(&base, &user, "recipes = [\"nx\", \"extra\"]", "").unwrap();
        assert_eq!((c.env["NX_DAEMON"].as_str(), c.env["E"].as_str()), ("mine", "1"));
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn app_dir_pm_and_dir_come_from_the_main_worktree() {
        let (base, user) = recipe_fixture("vars", &[("pnpm-lock.yaml", ""), ("apps/app/x", ""), ("apps/web/convex/schema.ts", "")]);
        let c = recipe_cfg(&base, &user, "recipes = [\"convex\", \"trigger\"]", "").unwrap();
        assert_eq!(c.procs["convex"].run, "pnpm exec convex dev");
        assert_eq!(c.procs["convex"].cwd.as_deref(), Some("apps/web"), "{{dir}} is where the recipe's detect rule matched");
        assert!(c.procs["trigger"].run.contains("{worktree}/apps/app/.env.local"), "apps/<project> exists");
        let _ = std::fs::remove_dir_all(&base);
        // No apps/<project> folder and no lockfile: `.` and npm. No main worktree at all: the same, with an empty {dir}.
        let (base, user) = recipe_fixture("vars2", &[("package.json", "{}")]);
        let c = recipe_cfg(&base, &user, "recipes = [\"convex\", \"trigger\"]", "").unwrap();
        assert_eq!(c.procs["convex"].run, "npx convex dev");
        assert!(c.procs["trigger"].run.contains("{worktree}/./.env.local"));
        let _ = std::fs::remove_dir_all(&base);
        let gone = std::env::temp_dir().join(format!("setu-cfg-recipes-nomain-{}", std::process::id()));
        let c = recipe_cfg(&gone, &user, "recipes = [\"convex\"]", "").unwrap();
        assert_eq!(c.procs["convex"].run, "npx convex dev");
    }

    #[test]
    fn worktree_and_setup_tables() {
        let text = format!(
            "{SAMPLE}\n[worktree]\nbase = \"origin/develop\"\nlink = [\"apps/web/.env.local\"]\ncopy = [\"data/seed.db\"]\nmin_free = \"1GiB\"\n\n[[setup.step]]\nname = \"install\"\nrun = \"bun install --frozen-lockfile\"\ninputs = [\"bun.lock\"]\n\n[[setup.step]]\nname = \"gen\"\nrun = \"bun gen\"\n"
        );
        let c = parse_project(&text, Path::new("t.toml")).unwrap();
        assert_eq!(c.worktree.base.as_deref(), Some("origin/develop"));
        assert_eq!(c.worktree.link, ["apps/web/.env.local"]);
        assert_eq!(c.worktree.copy, ["data/seed.db"]);
        assert_eq!(c.worktree.min_free, Some(1 << 30));
        assert_eq!(c.setup_steps.len(), 2);
        assert_eq!(c.setup_steps[0].inputs, ["bun.lock"]);
        assert!(sample().setup_steps.is_empty() && sample().worktree.link.is_empty());
        for bad in ["[worktree]\nlink = [\"../x\"]", "[worktree]\ncopy = [\"/abs\"]", "[worktree]\nbase = \"-x\"", "[worktree]\nlink = [\"a/*\"]", "[[setup.step]]\nname = \"a\"\nrun = \"\"", "[worktree]\nnope = 1"] {
            assert!(parse_project(&format!("{SAMPLE}\n{bad}"), Path::new("t.toml")).is_err(), "{bad}");
        }
    }

    #[test]
    fn durations() {
        assert_eq!(parse_duration("90s").unwrap(), Duration::from_secs(90));
        assert_eq!(parse_duration("30m").unwrap(), Duration::from_secs(1800));
        assert_eq!(parse_duration("2h").unwrap(), Duration::from_secs(7200));
        assert!(parse_duration("10").is_err());
        assert!(parse_duration("x5m").is_err());
        assert_eq!(parse_duration("7d").unwrap(), Duration::from_secs(604800));
        assert!(parse_duration("5w").is_err());
        assert!(parse_duration("").is_err());
    }

    #[test]
    fn parses_config() {
        let c = sample();
        assert_eq!(c.project, "quivly-app");
        assert_eq!(c.idle, Duration::from_secs(90));
        assert_eq!(c.max_running, 3);
        assert_eq!(c.ports, vec!["inngest".to_string(), "web".to_string()]);
        assert!(c.procs["web"].mise);
        assert_eq!(c.procs["web"].cwd.as_deref(), Some("apps/web"));
        assert_eq!(c.web_proc().unwrap().0, "web");
        let d = parse_project("project='p'\nrepo='/r'\ndomain='d'\n", Path::new("t")).unwrap();
        assert_eq!(d.idle, Duration::from_secs(1800));
    }

    #[test]
    fn rejects_bad_config() {
        let e = parse_project("project='p'\nrepo='/r'\ndomain='d'\nbogus=1\n", Path::new("my.toml")).unwrap_err();
        assert!(format!("{e:#}").contains("my.toml") && format!("{e:#}").contains("bogus"));
        let bad = "project='p'\nrepo='/r'\ndomain='d'\n[procs.w]\nrun='x'\nport='web'\n";
        assert!(format!("{:#}", parse_project(bad, Path::new("t")).unwrap_err()).contains("not in [ports]"));
        assert!(parse_project("project='p'\nrepo='/r'\n", Path::new("t")).is_err());
        let bad_proc = "project='p'\nrepo='/r'\ndomain='d'\n[procs.w]\nrun='x'\nnope=1\n";
        assert!(parse_project(bad_proc, Path::new("t")).is_err());
    }

    #[test]
    fn render_cases() {
        let v = map(&[("a", "1"), ("port.web", "4000")]);
        assert_eq!(render("x{a}y{port.web}", &v).unwrap(), "x1y4000");
        assert_eq!(render("{{a}} {{ }}", &v).unwrap(), "{a} { }");
        let e = render("{nope}", &v).unwrap_err().to_string();
        assert!(e.contains("byte offset 0") && !e.contains("nope"), "{e}");
        assert!(render("{a", &v).is_err());
        assert!(render("a}", &v).is_err());
    }

    #[test]
    fn resolve_precedence_and_port() {
        let c = sample();
        let ports = BTreeMap::from([("web".to_string(), 4100u16), ("inngest".to_string(), 4200u16)]);
        let g = map(&[("A", "global"), ("G", "g"), ("SETU_RUN", "bad"), ("W", "g")]);
        let w = map(&[("W", "wt-{run}"), ("PORT", "1")]);
        let s = resolve_run(&c, Path::new("/wt/feat-x"), "feat-x", &ports, &g, &w).unwrap();
        assert_eq!(s.env["A"], "project");
        assert_eq!(s.env["G"], "g");
        assert_eq!(s.env["W"], "wt-feat-x");
        assert_eq!(s.env["B"], "feat-x.quivly.local");
        assert_eq!(s.env["SETU_RUN"], "feat-x");
        assert_eq!(s.env["SETU_PROJECT"], "quivly-app");
        assert_eq!(s.env["SETU_URL"], "http://feat-x.quivly.local:7777");
        assert_eq!(s.env["PORT"], "4100");
        assert_eq!(s.web_port, Some(4100));
        assert_eq!(s.idle, Duration::from_secs(90));
        let names: Vec<_> = s.procs.iter().map(|p| p.name.as_str()).collect();
        assert_eq!(names, ["web", "worker"]);
        assert_eq!(s.procs[0].command, "mise exec -- bun dev --port 4100");
        assert_eq!(s.procs[0].cwd, PathBuf::from("/wt/feat-x/apps/web"));
        assert_eq!(s.procs[0].port, Some(4100));
        assert_eq!(s.procs[1].command, "bun worker {literal}");
        assert_eq!(s.procs[1].cwd, PathBuf::from("/wt/feat-x/."));
        assert!(s.procs[0].log_path.ends_with("quivly-app/feat-x/web.log"));
        let main = resolve_run(&c, Path::new("/wt/main"), "main", &ports, &g, &w).unwrap();
        assert_eq!(main.host, "quivly-app.quivly.local");
    }

    #[test]
    fn resolve_missing_port_errors() {
        let c = sample();
        let ports = BTreeMap::from([("web".to_string(), 4100u16)]);
        assert!(resolve_run(&c, Path::new("/w"), "r", &ports, &BTreeMap::new(), &BTreeMap::new()).is_err());
    }

    fn tmpdir(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("setu-config-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn env_layer_files() {
        let d = tmpdir("env");
        assert!(load_env_layer(&d.join("none.toml")).unwrap().is_empty());
        std::fs::write(d.join("a.toml"), "K = \"v\"\n").unwrap();
        assert_eq!(load_env_layer(&d.join("a.toml")).unwrap()["K"], "v");
        std::fs::write(d.join("b.toml"), "K = 1\n").unwrap();
        assert!(load_env_layer(&d.join("b.toml")).is_err());
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn load_dir_duplicates() {
        let d = tmpdir("dir");
        assert!(load_dir(&d.join("missing")).unwrap().is_empty());
        std::fs::write(d.join("a.toml"), "project='a'\nrepo='/r'\ndomain='x'\n").unwrap();
        std::fs::write(d.join("note.txt"), "ignored").unwrap();
        assert_eq!(load_dir(&d).unwrap().len(), 1);
        std::fs::write(d.join("b.toml"), "project='a'\nrepo='/r'\ndomain='y'\n").unwrap();
        assert!(format!("{:#}", load_dir(&d).unwrap_err()).contains("duplicate project"));
        std::fs::write(d.join("b.toml"), "project='b'\nrepo='/r'\ndomain='x'\n").unwrap();
        // a shared domain is allowed
        assert_eq!(load_dir(&d).unwrap().len(), 2);
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn worktree_env_path_shape() {
        let id = RunId { project: "p".into(), run: "r".into() };
        assert!(worktree_env_path(&id).ends_with("env/p/r.toml"));
        assert!(global_env_path().ends_with("env/global.toml"));
    }

    #[test]
    fn sizes() {
        assert_eq!(parse_size("1GiB").unwrap(), 1 << 30);
        assert_eq!(parse_size("512MiB").unwrap(), 512 << 20);
        assert_eq!(parse_size("500MB").unwrap(), 500_000_000);
        assert_eq!(parse_size("2048KiB").unwrap(), 2 << 20);
        assert_eq!(parse_size("1.5GiB").unwrap(), 3 << 29);
        assert_eq!(parse_size("42").unwrap(), 42);
        assert!(parse_size("").is_err());
        assert!(parse_size("GiB").is_err());
        assert!(parse_size("5 parsecs").is_err());
    }

    #[test]
    fn disk_path_validation() {
        for ok in ["a", ".next/cache", "*/.next", "*/*/node_modules/.vite"] {
            validate_disk_path(ok).unwrap();
        }
        for bad in ["", "/abs", "../x", "a/../b", "a//b", "a/", "x*", "*.log", "a/b*/c"] {
            assert!(validate_disk_path(bad).is_err(), "{bad}");
        }
    }

    const BASE: &str = "project='p'\nrepo='/r'\ndomain='d'\n";

    #[test]
    fn disk_config_round_trip() {
        let t = format!(
            "{BASE}preset = \"rust-cargo\"\n[[disk.item]]\nname='x'\nkind='output'\npaths=['out','*/out']\nclean_after='2h'\n\
             [[disk.item]]\nname='cargo-target'\ndisabled=true\n\
             [[disk.store]]\nname='s'\npath='~/cache'\nwarn_below='1GiB'\n"
        );
        let c = parse_project(&t, Path::new("t")).unwrap();
        assert_eq!(c.presets, vec!["rust-cargo".to_string()]);
        assert_eq!(c.disk_items.len(), 1);
        let i = &c.disk_items[0];
        assert_eq!((i.name.as_str(), i.kind, i.clean_after), ("x", DiskKind::Output, Some(Duration::from_secs(7200))));
        assert_eq!(i.paths, ["out", "*/out"]);
        assert_eq!(c.stores[0].warn_below, Some(1 << 30));
        assert_eq!(c.stores[0].path, paths::expand("~/cache"));
    }

    #[test]
    fn preset_selection_forms() {
        let none = parse_project(&format!("{BASE}preset = []\n"), Path::new("t")).unwrap();
        assert!(none.presets.is_empty() && none.disk_items.is_empty());
        let auto = parse_project(BASE, Path::new("t")).unwrap();
        assert!(auto.presets.is_empty());
        let many = parse_project(&format!("{BASE}preset = ['go', 'node-npm']\n"), Path::new("t")).unwrap();
        assert_eq!(many.presets, ["go", "node-npm"]);
        assert!(parse_project(&format!("{BASE}preset = 'nope'\n"), Path::new("t")).is_err());
    }

    #[test]
    fn rejects_bad_disk_config() {
        let bad = |extra: &str| parse_project(&format!("{BASE}{extra}"), Path::new("t")).is_err();
        assert!(bad("[[disk.item]]\nname='x'\npaths=['a']\n")); // kind required
        assert!(bad("[[disk.item]]\nname='x'\nkind='cache'\n")); // paths required
        assert!(bad("[[disk.item]]\nname='x'\nkind='cache'\npaths=['../a']\n"));
        assert!(bad("[[disk.item]]\nname='x'\nkind='cache'\npaths=['a']\nbogus=1\n"));
        assert!(bad("[[disk.item]]\nname='x'\nkind='junk'\npaths=['a']\n"));
        assert!(bad("[[disk.store]]\nname='s'\npath='/p'\nwarn_below='x'\n"));
        assert!(bad("[disk]\nbogus=1\n"));
    }

    #[test]
    fn project_names_and_domains_are_validated() {
        // review #12 and #22
        let ok = |name: &str, domain: &str| parse_project(&format!("project='{name}'\nrepo='/r'\ndomain='{domain}'\n"), Path::new("t")).is_ok();
        assert!(ok("demo", "demo.local") && ok("quivly-app", "quivly.local") && ok("p_1", "d"));
        for bad in ["demo.secrets", "global", "Global", "a/b", "..", "", ".hidden", "a b"] {
            assert!(!ok(bad, "demo.local"), "{bad:?}");
        }
        for bad in ["/etc/sudoers", "../x", "a/b", "a..b", "-a.b", "a.b.", "bad name", "x\u{7}.test", ""] {
            assert!(!ok("demo", bad), "{bad:?}");
        }
    }

    #[test]
    fn a_malformed_env_file_error_never_quotes_the_line() {
        // review #10: toml's own message shows the offending source line
        let d = std::env::temp_dir().join(format!("setu-envfile-{}", std::process::id()));
        std::fs::create_dir_all(&d).unwrap();
        let f = d.join("x.secrets.toml");
        std::fs::write(&f, "A = \"fine\"\nTOKEN = CANARY-REVIEW-{SECRET}\n").unwrap();
        let e = format!("{:#}", load_env_layer(&f).unwrap_err());
        assert!(!e.contains("CANARY") && !e.contains("SECRET"), "{e}");
        assert!(e.contains("line 2"), "{e}");
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn template_errors_never_echo_the_value() {
        let v = map(&[("a", "1")]);
        for t in ["CANARY-REVIEW-{SECRET}", "CANARY-{unterminated", "CANARY-}stray"] {
            let e = format!("{:#}", render(t, &v).unwrap_err());
            assert!(!e.contains("CANARY"), "{e}");
        }
    }

    #[test]
    fn b4_unknown_placeholder_contents_never_appear_in_the_error() {
        let v = map(&[("a", "1")]);
        let e = format!("{:#}", render("x {CANARY-CREDENTIAL} y", &v).unwrap_err());
        assert!(!e.contains("CANARY") && !e.contains("CREDENTIAL"), "{e}");
        assert!(e.contains("byte offset 2"), "{e}");
        // through resolve_run the error names the env variable, still without the contents
        let mut cfg = sample();
        cfg.env.insert("API_TOKEN".into(), "{CANARY-CREDENTIAL}".into());
        let leases = map_ports();
        let e = format!("{:#}", resolve_run(&cfg, Path::new("/w"), "r", &leases, &BTreeMap::new(), &BTreeMap::new()).unwrap_err());
        assert!(e.contains("env API_TOKEN") && !e.contains("CANARY"), "{e}");
    }

    fn map_ports() -> BTreeMap<String, u16> {
        [("web".to_string(), 3000u16), ("inngest".to_string(), 3001u16)].into_iter().collect()
    }

    #[test]
    fn a_short_value_under_a_secret_looking_name_is_ordinary_config() {
        // `MAX_TOKENS = "50"` must not stop a project from loading; it is not a credential.
        let t = "project = \"p\"\nrepo = \"/r\"\ndomain = \"p.local\"\n[env]\nMAX_TOKENS = \"50\"\nAPI_TOKEN = \"12345\"\n";
        let cfg = parse_project(t, Path::new("p.toml")).unwrap();
        assert!(!crate::env::looks_secret("MAX_TOKENS", &cfg.env["MAX_TOKENS"]));
        assert!(crate::env::looks_secret("API_TOKEN", &cfg.env["API_TOKEN"]));
    }

    #[test]
    fn aliases_must_be_hosts_under_the_domain_and_only_main_gets_them() {
        let t = |a: &str| format!("project = \"p\"\nrepo = \"/r\"\ndomain = \"q.local\"\naliases = [{a}]\n");
        let cfg = parse_project(&t("\"My.Site2.0.q.local\""), Path::new("p.toml")).unwrap();
        assert_eq!(cfg.aliases, vec!["my.site2.0.q.local".to_string()]);
        for bad in ["\"other.example\"", "\"q.local\"", "\"../x.q.local\"", "\"a b.q.local\""] {
            assert!(parse_project(&t(bad), Path::new("p.toml")).is_err(), "{bad}");
        }
        let main = resolve_run(&cfg, Path::new("/w"), "main", &BTreeMap::new(), &BTreeMap::new(), &BTreeMap::new()).unwrap();
        assert_eq!(main.aliases, cfg.aliases);
        let feat = resolve_run(&cfg, Path::new("/w"), "feat-x", &BTreeMap::new(), &BTreeMap::new(), &BTreeMap::new()).unwrap();
        assert!(feat.aliases.is_empty());
    }

    #[test]
    fn custom_hosts_are_lowercased_and_ips_wildcards_and_long_names_are_refused() {
        assert_eq!(validate_custom_host(" Demo.Example.TEST ").unwrap(), "demo.example.test");
        assert_eq!(validate_custom_host("localhost").unwrap(), "localhost");
        assert_eq!(validate_custom_host("a-b.c1.test").unwrap(), "a-b.c1.test");
        for bad in ["", "   ", "127.0.0.1", "10.0.0.1.", "::1", "[::1]", "*.example.test", "a*.test", "demo.example.test:8080", "demo/x.test", "-a.test", "a-.test", "a..test", "a b.test", "dem\u{f6}.test", "under_score.test", "a.123"] {
            assert!(validate_custom_host(bad).is_err(), "{bad:?} should be refused");
        }
        let too_long = format!("{}.test", vec!["a".repeat(63); 4].join("."));
        assert!(too_long.len() > 253 && validate_custom_host(&too_long).unwrap_err().to_string().contains("253"));
    }
}
