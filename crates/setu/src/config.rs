//! Project config loading, env layers, template rendering and run resolution.
#![allow(dead_code)]

use crate::model::{ProcSpec, ProjectConfig, ResolvedProc, RunId, RunSpec, PROXY_PORT};
use crate::{naming, paths};
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
    idle: Option<String>,
    max_running: Option<usize>,
    #[serde(default)]
    ports: BTreeMap<String, RawPort>,
    #[serde(default)]
    env: BTreeMap<String, String>,
    #[serde(default)]
    procs: BTreeMap<String, RawProc>,
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
    let n: u64 = num.parse().map_err(|_| anyhow!("invalid duration {s:?}: expected e.g. 90s, 30m, 2h"))?;
    let mult = match unit {
        "s" => 1,
        "m" => 60,
        "h" => 3600,
        _ => bail!("invalid duration {s:?}: unit must be s, m or h"),
    };
    Ok(Duration::from_secs(n * mult))
}

fn parse_project(text: &str, file: &Path) -> Result<ProjectConfig> {
    let raw: RawProject = toml::from_str(text).with_context(|| format!("invalid project config {}", file.display()))?;
    let idle = parse_duration(raw.idle.as_deref().unwrap_or("30m")).with_context(|| format!("in {}", file.display()))?;
    let mut procs = BTreeMap::new();
    for (name, p) in raw.procs {
        if let Some(port) = &p.port {
            if !raw.ports.contains_key(port) {
                bail!("{}: proc {name:?} uses port {port:?} which is not in [ports]", file.display());
            }
        }
        procs.insert(name, ProcSpec { run: p.run, port: p.port, mise: p.mise, cwd: p.cwd });
    }
    Ok(ProjectConfig {
        project: raw.project,
        repo: paths::expand(&raw.repo),
        domain: raw.domain,
        idle,
        max_running: raw.max_running.unwrap_or(3),
        ports: raw.ports.into_keys().collect(),
        env: raw.env,
        procs,
    })
}

pub fn load_project(path: &Path) -> Result<ProjectConfig> {
    let text = std::fs::read_to_string(path).with_context(|| format!("reading {}", path.display()))?;
    parse_project(&text, path)
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
        if out.iter().any(|o| o.domain == c.domain) {
            bail!("duplicate domain {:?} ({})", c.domain, f.display());
        }
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
    toml::from_str(&text).with_context(|| format!("invalid env file {} (values must be strings)", path.display()))
}

pub fn global_env_path() -> PathBuf {
    paths::env_dir().join("global.toml")
}

pub fn worktree_env_path(id: &RunId) -> PathBuf {
    paths::env_dir().join(&id.project).join(format!("{}.toml", id.run))
}

pub fn render(template: &str, vars: &BTreeMap<String, String>) -> Result<String> {
    let mut out = String::with_capacity(template.len());
    let mut it = template.chars().peekable();
    while let Some(c) = it.next() {
        match c {
            '{' if it.peek() == Some(&'{') => {
                it.next();
                out.push('{');
            }
            '}' if it.peek() == Some(&'}') => {
                it.next();
                out.push('}');
            }
            '{' => {
                let mut name = String::new();
                loop {
                    match it.next() {
                        Some('}') => break,
                        Some(ch) => name.push(ch),
                        None => bail!("unterminated '{{' in template {template:?}"),
                    }
                }
                match vars.get(name.trim()) {
                    Some(v) => out.push_str(v),
                    None => bail!("unknown template variable {{{name}}} in {template:?}"),
                }
            }
            '}' => bail!("stray '}}' in template {template:?} (use '}}}}' for a literal brace)"),
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
    let url = format!("http://{host}:{PROXY_PORT}");
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

    #[test]
    fn durations() {
        assert_eq!(parse_duration("90s").unwrap(), Duration::from_secs(90));
        assert_eq!(parse_duration("30m").unwrap(), Duration::from_secs(1800));
        assert_eq!(parse_duration("2h").unwrap(), Duration::from_secs(7200));
        assert!(parse_duration("10").is_err());
        assert!(parse_duration("x5m").is_err());
        assert!(parse_duration("5d").is_err());
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
        assert!(e.contains("nope"));
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
        assert!(format!("{:#}", load_dir(&d).unwrap_err()).contains("duplicate domain"));
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn worktree_env_path_shape() {
        let id = RunId { project: "p".into(), run: "r".into() };
        assert!(worktree_env_path(&id).ends_with("env/p/r.toml"));
        assert!(global_env_path().ends_with("env/global.toml"));
    }
}
