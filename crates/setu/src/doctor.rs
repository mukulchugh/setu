//! `doctor`: check every layer and print the exact fix for each failure.

use crate::globalcfg::{now_secs, GlobalConfig};
use crate::model::ProjectConfig;
use crate::setup::{self, Sys};
use std::os::unix::fs::PermissionsExt;
use std::path::Path;

#[derive(Debug, Clone, PartialEq)]
pub struct Check {
    pub name: String,
    pub ok: bool,
    pub detail: String,
    pub fix: Option<String>,
}

pub struct DoctorInputs {
    /// Version reported by the daemon's ping, `None` if it did not answer.
    pub daemon_ping: Option<String>,
    pub cli_version: String,
    pub launch_agent_loaded: bool,
    pub gcfg: GlobalConfig,
    pub projects: Vec<ProjectConfig>,
    pub proxy_listening: bool,
}

const BUILTINS: &[&str] = &[
    "cd", "export", "echo", "exec", "source", ".", "set", "unset", "test", "[", "true", "false", "exit", "eval", "alias", "ulimit", "umask", "wait", "trap", "read", "printf", ":", "if", "for", "while", "(", "{",
];
const PATH_MAX_AGE_SECS: u64 = 30 * 24 * 3600;

fn ok(name: impl Into<String>, detail: impl Into<String>) -> Check {
    Check { name: name.into(), ok: true, detail: detail.into(), fix: None }
}
fn bad(name: impl Into<String>, detail: impl Into<String>, fix: impl Into<String>) -> Check {
    Check { name: name.into(), ok: false, detail: detail.into(), fix: Some(fix.into()) }
}

/// First word that must be an executable: skips `FOO=bar` assignments; `None` for builtins/templates.
fn command_word(run: &str) -> Option<&str> {
    let w = run.split_whitespace().find(|t| {
        let is_assign = t.split_once('=').is_some_and(|(k, _)| !k.is_empty() && k.chars().all(|c| c.is_ascii_alphanumeric() || c == '_'));
        !is_assign
    })?;
    if BUILTINS.contains(&w) || w.contains("{{") || w.starts_with('$') {
        return None;
    }
    Some(w)
}

fn is_exec(p: &Path) -> bool {
    std::fs::metadata(p).map(|m| m.is_file() && m.permissions().mode() & 0o111 != 0).unwrap_or(false)
}

fn on_path(word: &str, path: &str) -> bool {
    path.split(':').filter(|d| !d.is_empty()).any(|d| is_exec(&Path::new(d).join(word)))
}

pub fn run(inp: DoctorInputs, sys: &dyn Sys) -> Vec<Check> {
    let mut out = Vec::new();

    out.push(match &inp.daemon_ping {
        None => bad("daemon", "not answering", "setu-rs setup   (or: setu-rs daemon)"),
        Some(v) if *v == inp.cli_version => ok("daemon", format!("answering, version {v}")),
        Some(v) => bad("daemon", format!("version {v} differs from CLI {}", inp.cli_version), format!("launchctl kickstart -k gui/{}/{}", sys.uid(), setup::LABEL)),
    });

    out.push(if inp.launch_agent_loaded {
        ok("launch agent", format!("{} loaded", setup::LABEL))
    } else {
        bad("launch agent", format!("{} not loaded", setup::LABEL), "setu-rs setup")
    });

    let captured = match (&inp.gcfg.path, inp.gcfg.path_captured_at) {
        (None, _) => {
            out.push(bad("login PATH", "no PATH snapshot", "setu-rs setup"));
            None
        }
        (Some(p), at) => {
            let age = at.map(|t| now_secs().saturating_sub(t));
            let detail = match age {
                Some(a) if a > PATH_MAX_AGE_SECS => format!("{} dirs captured {} days ago; consider refreshing with `setu-rs setup`", p.split(':').count(), a / 86400),
                Some(a) => format!("{} dirs captured {} days ago", p.split(':').count(), a / 86400),
                None => format!("{} dirs captured (time unknown)", p.split(':').count()),
            };
            out.push(ok("login PATH", detail));
            Some(p.as_str())
        }
    };

    if let Some(path) = captured {
        for pc in &inp.projects {
            for (name, spec) in &pc.procs {
                let mut words = Vec::new();
                if spec.mise {
                    words.push("mise");
                }
                if let Some(w) = command_word(&spec.run) {
                    words.push(w);
                }
                for w in words {
                    let label = format!("{}/{} command `{w}`", pc.project, name);
                    let found = if w.contains('/') { is_exec(Path::new(w)) } else { on_path(w, path) };
                    if found {
                        out.push(ok(label, "found"));
                    } else if w.contains('/') {
                        out.push(bad(label, "file not found or not executable", format!("check `run` of proc {name} in the {} project config", pc.project)));
                    } else {
                        out.push(bad(label, "not on the captured PATH", format!("install {w}, then run: setu-rs setup   (re-captures PATH)")));
                    }
                }
            }
        }
    }

    out.push(if inp.proxy_listening {
        ok("proxy", format!("listening on :{}", inp.gcfg.proxy_port))
    } else {
        bad("proxy", format!("nothing listening on :{}", inp.gcfg.proxy_port), "setu-rs setup   (or: setu-rs daemon)")
    });

    let mut seen = std::collections::BTreeSet::new();
    for pc in &inp.projects {
        let d = pc.domain.trim_matches('.').to_ascii_lowercase();
        if !seen.insert(d.clone()) {
            continue;
        }
        let name = format!("domain {d}");
        if sys.resolves_to_loopback(&format!("setu-probe.{d}")) {
            out.push(ok(name, "resolves to loopback"));
        } else {
            out.push(bad(name, "does not resolve to 127.0.0.1", "setu-rs setup"));
        }
    }

    for pc in &inp.projects {
        for st in &pc.stores {
            let Some(min) = st.warn_below else { continue };
            let size = crate::disk_measure::measure(&st.path).logical;
            let name = format!("store {}/{}", pc.project, st.name);
            if size < min {
                out.push(bad(name, format!("{}, below {} (looks emptied; the next install re-downloads everything)", crate::disk::human_bytes(size), crate::disk::human_bytes(min)), format!("warm it by installing dependencies once, e.g. in {}", st.path.display())));
            } else {
                out.push(ok(name, crate::disk::human_bytes(size)));
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{DiskStore, ProcSpec};
    use std::collections::BTreeMap;
    use std::path::PathBuf;
    use std::time::Duration;

    struct FakeSys {
        resolving: Vec<String>,
    }
    impl Sys for FakeSys {
        fn run(&self, _: &str, _: &[&str]) -> anyhow::Result<(i32, String)> {
            Ok((0, String::new()))
        }
        fn run_sudo_write(&self, _: &Path, _: &str) -> anyhow::Result<()> {
            Ok(())
        }
        fn run_sudo_remove(&self, _: &Path) -> anyhow::Result<()> {
            Ok(())
        }
        fn resolves_to_loopback(&self, host: &str) -> bool {
            self.resolving.iter().any(|d| host.ends_with(d.as_str()))
        }
        fn uid(&self) -> u32 {
            501
        }
    }

    fn tmpdir(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("setu-doctor-{}-{name}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    fn project(procs: &[(&str, &str, bool)], domain: &str, stores: Vec<DiskStore>) -> ProjectConfig {
        let mut map = BTreeMap::new();
        for (n, run, mise) in procs {
            map.insert(n.to_string(), ProcSpec { run: run.to_string(), port: None, mise: *mise, cwd: None });
        }
        ProjectConfig {
            project: "p".into(),
            repo: PathBuf::from("/r"),
            domain: domain.into(),
            idle: Duration::from_secs(1),
            max_running: 3,
            ports: vec![],
            env: BTreeMap::new(),
            procs: map,
            presets: vec![],
            disk_items: vec![],
            worktree: Default::default(),
            setup_steps: vec![],
            stores,
        }
    }

    fn inputs(path: Option<String>, projects: Vec<ProjectConfig>) -> DoctorInputs {
        DoctorInputs {
            daemon_ping: Some("0.1.0".into()),
            cli_version: "0.1.0".into(),
            launch_agent_loaded: true,
            gcfg: GlobalConfig { path, path_captured_at: Some(now_secs()), ..Default::default() },
            projects,
            proxy_listening: true,
        }
    }

    fn find<'a>(cs: &'a [Check], needle: &str) -> &'a Check {
        cs.iter().find(|c| c.name.contains(needle)).unwrap_or_else(|| panic!("no check {needle}: {cs:?}"))
    }

    #[test]
    fn all_good() {
        let d = tmpdir("good");
        let bin = d.join("bun");
        std::fs::write(&bin, "").unwrap();
        std::fs::set_permissions(&bin, std::fs::Permissions::from_mode(0o755)).unwrap();
        let p = project(&[("web", "FOO=bar bun run dev", false)], "a.localhost", vec![]);
        let cs = run(inputs(Some(format!("/nope:{}", d.display())), vec![p]), &FakeSys { resolving: vec!["localhost".into()] });
        assert!(cs.iter().all(|c| c.ok), "{cs:?}");
        assert!(find(&cs, "command `bun`").ok);
    }

    #[test]
    fn daemon_and_agent_failures() {
        let mut i = inputs(None, vec![]);
        i.daemon_ping = None;
        i.launch_agent_loaded = false;
        i.proxy_listening = false;
        let cs = run(i, &FakeSys { resolving: vec![] });
        assert!(!find(&cs, "daemon").ok);
        assert!(!find(&cs, "launch agent").ok);
        assert!(!find(&cs, "login PATH").ok);
        assert!(!find(&cs, "proxy").ok);
        assert!(cs.iter().all(|c| c.ok || c.fix.is_some()));
        let mut i = inputs(None, vec![]);
        i.daemon_ping = Some("0.0.9".into());
        let cs = run(i, &FakeSys { resolving: vec![] });
        let d = find(&cs, "daemon");
        assert!(!d.ok && d.detail.contains("0.0.9") && d.fix.as_deref().unwrap().contains("gui/501"));
    }

    #[test]
    fn old_path_is_warning_but_ok() {
        let mut i = inputs(Some("/usr/bin:/bin".into()), vec![]);
        i.gcfg.path_captured_at = Some(now_secs() - 40 * 86400);
        let cs = run(i, &FakeSys { resolving: vec![] });
        let c = find(&cs, "login PATH");
        assert!(c.ok && c.detail.contains("40 days"));
    }

    #[test]
    fn missing_commands_builtins_and_paths() {
        let d = tmpdir("cmds");
        let p = project(&[("a", "inngest dev", false), ("b", "cd x && ls", false), ("c", "{{bin}}/x", false), ("d", "/does/not/exist --x", false), ("e", "node a.js", true)], "q.test", vec![]);
        let cs = run(inputs(Some(d.display().to_string()), vec![p]), &FakeSys { resolving: vec!["q.test".into()] });
        let a = find(&cs, "p/a command");
        assert!(!a.ok && a.fix.as_deref().unwrap().contains("inngest"));
        assert!(!cs.iter().any(|c| c.name.contains("p/b command") && c.name.contains("`cd`")));
        assert!(!cs.iter().any(|c| c.name.starts_with("p/c")));
        assert!(!find(&cs, "p/d command").ok);
        assert!(!find(&cs, "command `mise`").ok);
        assert!(find(&cs, "domain q.test").ok);
    }

    #[test]
    fn command_word_parsing() {
        assert_eq!(command_word("FOO=bar BAZ=1 bun dev"), Some("bun"));
        assert_eq!(command_word("export A=1"), None);
        assert_eq!(command_word("./run.sh"), Some("./run.sh"));
        assert_eq!(command_word("A=1"), None);
    }

    #[test]
    fn domain_and_store() {
        let d = tmpdir("store");
        std::fs::write(d.join("f"), vec![0u8; 100]).unwrap();
        let stores = vec![
            DiskStore { name: "small".into(), path: d.clone(), warn_below: Some(1000) },
            DiskStore { name: "fine".into(), path: d.clone(), warn_below: Some(10) },
            DiskStore { name: "unwatched".into(), path: d.clone(), warn_below: None },
        ];
        let p = project(&[], "x.test", stores);
        let cs = run(inputs(Some("/usr/bin".into()), vec![p]), &FakeSys { resolving: vec![] });
        let dom = find(&cs, "domain x.test");
        assert!(!dom.ok && dom.fix.as_deref() == Some("setu-rs setup"));
        assert!(!find(&cs, "small").ok);
        assert!(find(&cs, "fine").ok);
        assert!(!cs.iter().any(|c| c.name.contains("unwatched")));
    }
}
