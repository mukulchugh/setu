//! `setup` / `setup --undo`: LaunchAgent, captured PATH and DNS resolver files.
//! Every privileged or system action goes through [`Sys`] so tests use a fake.

use crate::globalcfg::{now_secs, write_atomic_private, GlobalConfig};
use crate::paths;
use anyhow::{anyhow, bail, Context, Result};
use serde::{Deserialize, Serialize};
use std::io::Write;
use std::net::ToSocketAddrs;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

pub const LABEL: &str = "dev.setu.daemon";
pub const MARKER: &str = "# managed by setu";

pub trait Sys {
    /// Run a command; returns (exit code, stdout).
    fn run(&self, cmd: &str, args: &[&str]) -> Result<(i32, String)>;
    fn run_sudo_write(&self, path: &Path, contents: &str) -> Result<()>;
    fn run_sudo_remove(&self, path: &Path) -> Result<()>;
    fn resolves_to_loopback(&self, host: &str) -> bool;
    fn uid(&self) -> u32;
    /// Login-shell PATH (real: runs the user's shell).
    fn login_path(&self) -> Result<String> {
        crate::globalcfg::capture_login_path()
    }
}

pub struct RealSys;

impl Sys for RealSys {
    fn run(&self, cmd: &str, args: &[&str]) -> Result<(i32, String)> {
        let out = Command::new(cmd).args(args).stdin(Stdio::null()).stderr(Stdio::null()).output().with_context(|| format!("running {cmd}"))?;
        Ok((out.status.code().unwrap_or(-1), String::from_utf8_lossy(&out.stdout).into_owned()))
    }

    fn run_sudo_write(&self, path: &Path, contents: &str) -> Result<()> {
        if let Some(dir) = path.parent() {
            let _ = Command::new("sudo").args(["/bin/mkdir", "-p"]).arg(dir).status();
        }
        let mut child = Command::new("sudo").arg("/usr/bin/tee").arg(path).stdin(Stdio::piped()).stdout(Stdio::null()).spawn().context("running sudo")?;
        child.stdin.take().ok_or_else(|| anyhow!("no stdin"))?.write_all(contents.as_bytes())?;
        let st = child.wait()?;
        if !st.success() {
            bail!("sudo tee {} failed ({st})", path.display());
        }
        Ok(())
    }

    fn run_sudo_remove(&self, path: &Path) -> Result<()> {
        let st = Command::new("sudo").args(["/bin/rm", "-f"]).arg(path).status().context("running sudo")?;
        if !st.success() {
            bail!("sudo rm {} failed ({st})", path.display());
        }
        Ok(())
    }

    fn resolves_to_loopback(&self, host: &str) -> bool {
        match (host, 80).to_socket_addrs() {
            Ok(mut it) => it.any(|a| a.ip().is_loopback()),
            Err(_) => false,
        }
    }

    fn uid(&self) -> u32 {
        unsafe { libc::getuid() }
    }
}

/// Where setup reads and writes; `real()` is the production layout.
#[derive(Debug, Clone)]
pub struct Layout {
    pub plist: PathBuf,
    pub record: PathBuf,
    /// config.toml (where the captured PATH is saved).
    pub config: PathBuf,
    pub log: PathBuf,
    pub resolver_dir: PathBuf,
}

impl Layout {
    pub fn real() -> Layout {
        let home = std::env::var_os("HOME").map(PathBuf::from).unwrap_or_else(|| PathBuf::from("/"));
        Layout {
            plist: home.join("Library/LaunchAgents").join(format!("{LABEL}.plist")),
            record: record_path(),
            config: crate::globalcfg::config_path(),
            log: paths::logs_dir().join("daemon.log"),
            resolver_dir: PathBuf::from("/etc/resolver"),
        }
    }
}

pub fn record_path() -> PathBuf {
    paths::config_dir().join("setup.toml")
}

#[derive(Debug, Clone, PartialEq)]
pub struct Step {
    pub id: String,
    pub description: String,
    pub sudo: bool,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct SetupRecord {
    pub plist: Option<String>,
    pub resolver_files: Vec<String>,
    pub at: u64,
}

impl SetupRecord {
    pub fn load(path: &Path) -> Result<Self> {
        match std::fs::read_to_string(path) {
            Ok(s) => toml::from_str(&s).with_context(|| format!("parsing {}", path.display())),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Self::default()),
            Err(e) => Err(anyhow!(e)),
        }
    }
    fn save(&self, path: &Path) -> Result<()> {
        write_atomic_private(path, &toml::to_string_pretty(self)?)
    }
}

fn xml_escape(s: &str) -> String {
    s.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;").replace('"', "&quot;").replace('\'', "&apos;")
}

pub fn plist(binary: &Path, path_env: &str, log: &Path) -> String {
    let bin = xml_escape(&binary.to_string_lossy());
    let log = xml_escape(&log.to_string_lossy());
    let path_env = xml_escape(path_env);
    format!(
        r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>Label</key>
	<string>{LABEL}</string>
	<key>ProgramArguments</key>
	<array>
		<string>{bin}</string>
		<string>daemon</string>
	</array>
	<key>RunAtLoad</key>
	<true/>
	<key>KeepAlive</key>
	<dict>
		<key>SuccessfulExit</key>
		<false/>
	</dict>
	<key>StandardOutPath</key>
	<string>{log}</string>
	<key>StandardErrorPath</key>
	<string>{log}</string>
	<key>EnvironmentVariables</key>
	<dict>
		<key>PATH</key>
		<string>{path_env}</string>
	</dict>
	<key>ProcessType</key>
	<string>Background</string>
</dict>
</plist>
"#
    )
}

/// Homebrew's stable symlink if present (survives upgrades), else this binary.
pub fn stable_binary_path() -> PathBuf {
    for p in ["/opt/homebrew/opt/setu/bin/setu", "/usr/local/opt/setu/bin/setu"] {
        if Path::new(p).exists() {
            return PathBuf::from(p);
        }
    }
    let exe = std::env::current_exe().unwrap_or_else(|_| PathBuf::from("setu"));
    exe.canonicalize().unwrap_or(exe)
}

pub fn resolver_contents(dns_port: u16) -> String {
    format!("{MARKER}\nnameserver 127.0.0.1\nport {dns_port}\n")
}

fn probe_host(domain: &str) -> String {
    format!("setu-probe.{domain}")
}

fn path_for_plist(gcfg: &GlobalConfig) -> String {
    gcfg.path.clone().or_else(|| std::env::var("PATH").ok()).unwrap_or_else(|| "/usr/bin:/bin".into())
}

fn agent_loaded(sys: &dyn Sys) -> bool {
    sys.run("launchctl", &["print", &format!("gui/{}/{LABEL}", sys.uid())]).map(|(c, _)| c == 0).unwrap_or(false)
}

pub fn plan(gcfg: &GlobalConfig, domains: &[String], binary: &Path, sys: &dyn Sys) -> Vec<Step> {
    plan_in(gcfg, domains, binary, sys, &Layout::real())
}

pub fn plan_in(gcfg: &GlobalConfig, domains: &[String], binary: &Path, sys: &dyn Sys, layout: &Layout) -> Vec<Step> {
    let mut steps = vec![Step { id: "capture-path".into(), description: "Capture your login-shell PATH into config.toml".into(), sudo: false }];
    let want = plist(binary, &path_for_plist(gcfg), &layout.log);
    let identical = std::fs::read_to_string(&layout.plist).map(|c| c == want).unwrap_or(false);
    if !(identical && agent_loaded(sys)) {
        steps.push(Step {
            id: "launch-agent".into(),
            description: format!("Install and start the daemon at login ({})", layout.plist.display()),
            sudo: false,
        });
    }
    let mut seen = std::collections::BTreeSet::new();
    for d in domains {
        let d = d.trim().trim_matches('.').to_ascii_lowercase();
        if d.is_empty() || d.ends_with(".localhost") || d == "localhost" || crate::config::validate_domain(&d).is_err() || !seen.insert(d.clone()) {
            continue;
        }
        if sys.resolves_to_loopback(&probe_host(&d)) {
            continue;
        }
        steps.push(Step {
            id: format!("resolver:{d}"),
            description: format!("Write {}/{d} so *.{d} resolves to Setu (needs sudo)", layout.resolver_dir.display()),
            sudo: true,
        });
    }
    steps
}

/// Execute `steps`, merging what was done into the setup record. Stops at the first failure
/// (what already succeeded stays recorded).
pub fn apply(steps: &[Step], gcfg: &mut GlobalConfig, binary: &Path, layout: &Layout, sys: &dyn Sys) -> Result<SetupRecord> {
    let mut rec = SetupRecord::load(&layout.record)?;
    let res = apply_steps(steps, gcfg, binary, layout, sys, &mut rec);
    rec.at = now_secs();
    rec.save(&layout.record)?;
    res.map(|_| rec)
}

fn apply_steps(steps: &[Step], gcfg: &mut GlobalConfig, binary: &Path, layout: &Layout, sys: &dyn Sys, rec: &mut SetupRecord) -> Result<()> {
    for s in steps {
        match s.id.as_str() {
            "capture-path" => {
                gcfg.path = Some(sys.login_path()?);
                gcfg.path_captured_at = Some(now_secs());
                gcfg.save_to(&layout.config)?;
            }
            "launch-agent" => {
                if let Some(dir) = layout.plist.parent() {
                    std::fs::create_dir_all(dir)?;
                }
                if let Some(dir) = layout.log.parent() {
                    std::fs::create_dir_all(dir)?;
                }
                std::fs::write(&layout.plist, plist(binary, &path_for_plist(gcfg), &layout.log))?;
                let target = format!("gui/{}", sys.uid());
                let _ = sys.run("launchctl", &["bootout", &format!("{target}/{LABEL}")]);
                let (code, _) = sys.run("launchctl", &["bootstrap", &target, &layout.plist.to_string_lossy()])?;
                if code != 0 {
                    bail!("launchctl bootstrap exited {code}");
                }
                rec.plist = Some(layout.plist.to_string_lossy().into_owned());
            }
            id => {
                let domain = id.strip_prefix("resolver:").ok_or_else(|| anyhow!("unknown step {id}"))?;
                // The domain becomes a file name written with sudo: plain DNS labels only (review #22).
                crate::config::validate_domain(domain).with_context(|| format!("refusing to write a resolver file for {domain:?}"))?;
                let file = layout.resolver_dir.join(domain);
                if file.parent() != Some(layout.resolver_dir.as_path()) {
                    bail!("{} is not directly inside {}", file.display(), layout.resolver_dir.display());
                }
                // Never overwrite a resolver file someone else wrote, and never guess: a file we cannot
                // inspect (unreadable, a link) is refused, not treated as absent.
                match std::fs::symlink_metadata(&file) {
                    Ok(md) if md.file_type().is_symlink() => bail!("{} is a symlink; leaving it alone", file.display()),
                    Ok(_) => match std::fs::read_to_string(&file) {
                        Ok(existing) if existing.lines().next() == Some(MARKER) => {}
                        Ok(_) => bail!("{} exists and is not managed by setu; leaving it alone", file.display()),
                        Err(e) => bail!("{} exists but cannot be read ({e}); leaving it alone", file.display()),
                    },
                    Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
                    Err(e) => bail!("cannot inspect {} ({e}); leaving it alone", file.display()),
                }
                sys.run_sudo_write(&file, &resolver_contents(gcfg.dns_port))?;
                let f = file.to_string_lossy().into_owned();
                if !rec.resolver_files.contains(&f) {
                    rec.resolver_files.push(f);
                }
            }
        }
    }
    Ok(())
}

/// Reverse exactly what the record lists. Returns human-readable lines of what happened.
pub fn undo(layout: &Layout, sys: &dyn Sys) -> Result<Vec<String>> {
    let mut rec = SetupRecord::load(&layout.record)?;
    let mut log = Vec::new();
    if let Some(p) = rec.plist.take() {
        let _ = sys.run("launchctl", &["bootout", &format!("gui/{}/{LABEL}", sys.uid())]);
        let p = PathBuf::from(p);
        match std::fs::remove_file(&p) {
            Ok(()) => log.push(format!("removed {}", p.display())),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => bail!("removing {}: {e}", p.display()),
        }
    }
    let mut kept = Vec::new();
    for f in std::mem::take(&mut rec.resolver_files) {
        let p = PathBuf::from(&f);
        match std::fs::read_to_string(&p) {
            Ok(c) if c.lines().next() == Some(MARKER) => match sys.run_sudo_remove(&p) {
                Ok(()) => log.push(format!("removed {f}")),
                Err(e) => {
                    log.push(format!("could not remove {f}: {e}"));
                    kept.push(f);
                }
            },
            Ok(_) => log.push(format!("left {f} alone (not managed by setu)")),
            Err(_) => {} // already gone
        }
    }
    rec.resolver_files = kept;
    rec.at = now_secs();
    rec.save(&layout.record)?;
    Ok(log)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;

    #[derive(Default)]
    struct Fake {
        calls: RefCell<Vec<String>>,
        resolving: Vec<String>,
        loaded: bool,
        bootstrap_code: i32,
    }

    impl Sys for Fake {
        fn run(&self, cmd: &str, args: &[&str]) -> Result<(i32, String)> {
            self.calls.borrow_mut().push(format!("{cmd} {}", args.join(" ")));
            if args.first() == Some(&"print") {
                return Ok((if self.loaded { 0 } else { 113 }, String::new()));
            }
            if args.first() == Some(&"bootstrap") {
                return Ok((self.bootstrap_code, String::new()));
            }
            Ok((0, String::new()))
        }
        fn run_sudo_write(&self, path: &Path, contents: &str) -> Result<()> {
            self.calls.borrow_mut().push(format!("write {}", path.display()));
            std::fs::create_dir_all(path.parent().unwrap())?;
            std::fs::write(path, contents)?;
            Ok(())
        }
        fn run_sudo_remove(&self, path: &Path) -> Result<()> {
            self.calls.borrow_mut().push(format!("rm {}", path.display()));
            std::fs::remove_file(path)?;
            Ok(())
        }
        fn resolves_to_loopback(&self, host: &str) -> bool {
            self.resolving.iter().any(|d| host.ends_with(d.as_str()))
        }
        fn uid(&self) -> u32 {
            501
        }
        fn login_path(&self) -> Result<String> {
            Ok("/fake/bin:/usr/bin".into())
        }
    }

    fn layout(name: &str) -> Layout {
        let d = std::env::temp_dir().join(format!("setu-setup-{}-{name}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        Layout { plist: d.join("LaunchAgents/dev.setu.daemon.plist"), record: d.join("cfg/setup.toml"), config: d.join("cfg/config.toml"), log: d.join("logs/daemon.log"), resolver_dir: d.join("resolver") }
    }

    fn ids(steps: &[Step]) -> Vec<String> {
        steps.iter().map(|s| s.id.clone()).collect()
    }

    fn doms(v: &[&str]) -> Vec<String> {
        v.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn plan_localhost_custom_and_resolving() {
        let l = layout("plan");
        let g = GlobalConfig::default();
        let bin = Path::new("/bin/setu");
        let fake = Fake { resolving: vec!["quivly.local".into()], ..Default::default() };
        let steps = plan_in(&g, &doms(&["a.localhost", "quivly.local", "demo.test", "demo.test"]), bin, &fake, &l);
        assert_eq!(ids(&steps), ["capture-path", "launch-agent", "resolver:demo.test"]);
        assert!(!steps[0].sudo && !steps[1].sudo && steps[2].sudo);
    }

    #[test]
    fn plan_skips_loaded_identical_agent() {
        let l = layout("skip");
        let g = GlobalConfig { path: Some("/x:/y".into()), ..Default::default() };
        let bin = Path::new("/bin/setu");
        std::fs::create_dir_all(l.plist.parent().unwrap()).unwrap();
        std::fs::write(&l.plist, plist(bin, "/x:/y", &l.log)).unwrap();
        let loaded = Fake { loaded: true, ..Default::default() };
        assert_eq!(ids(&plan_in(&g, &[], bin, &loaded, &l)), ["capture-path"]);
        // loaded but different plist, or identical but not loaded: reinstall
        let not_loaded = Fake::default();
        assert!(ids(&plan_in(&g, &[], bin, &not_loaded, &l)).contains(&"launch-agent".to_string()));
        assert!(ids(&plan_in(&g, &[], Path::new("/other"), &loaded, &l)).contains(&"launch-agent".to_string()));
    }

    #[test]
    fn apply_records_and_undo_removes_only_marker_files() {
        let l = layout("apply");
        let mut g = GlobalConfig::default();
        let bin = Path::new("/bin/setu");
        let fake = Fake::default();
        let steps = plan_in(&g, &doms(&["demo.test"]), bin, &fake, &l);
        let rec = apply(&steps, &mut g, bin, &l, &fake).unwrap();
        assert_eq!(g.path.as_deref(), Some("/fake/bin:/usr/bin"));
        assert_eq!(rec.plist.as_deref(), Some(l.plist.to_str().unwrap()));
        assert_eq!(rec.resolver_files.len(), 1);
        let on_disk = std::fs::read_to_string(l.resolver_dir.join("demo.test")).unwrap();
        assert_eq!(on_disk, "# managed by setu\nnameserver 127.0.0.1\nport 15353\n");
        assert!(std::fs::read_to_string(&l.plist).unwrap().contains("/fake/bin:/usr/bin"));
        assert!(fake.calls.borrow().iter().any(|c| c.starts_with("launchctl bootstrap gui/501 ")));
        assert_eq!(SetupRecord::load(&l.record).unwrap(), rec);

        // someone else's resolver file is also (wrongly) in the record
        let foreign = l.resolver_dir.join("foreign.test");
        std::fs::write(&foreign, "nameserver 10.0.0.1\n").unwrap();
        let mut r = SetupRecord::load(&l.record).unwrap();
        r.resolver_files.push(foreign.to_string_lossy().into_owned());
        r.save(&l.record).unwrap();

        let fake2 = Fake::default();
        let out = undo(&l, &fake2).unwrap();
        assert!(!l.resolver_dir.join("demo.test").exists());
        assert!(foreign.exists(), "foreign file untouched");
        assert!(!l.plist.exists());
        let calls = fake2.calls.borrow();
        assert!(calls.iter().any(|c| c == "launchctl bootout gui/501/dev.setu.daemon"));
        assert_eq!(calls.iter().filter(|c| c.starts_with("rm ")).count(), 1);
        assert!(out.iter().any(|l| l.contains("left") && l.contains("foreign.test")));
        assert_eq!(SetupRecord::load(&l.record).unwrap().resolver_files.len(), 0);
        assert!(SetupRecord::load(&l.record).unwrap().plist.is_none());
    }

    #[test]
    fn apply_refuses_to_overwrite_foreign_resolver() {
        let l = layout("foreign");
        std::fs::create_dir_all(&l.resolver_dir).unwrap();
        std::fs::write(l.resolver_dir.join("demo.test"), "nameserver 1.1.1.1\n").unwrap();
        let mut g = GlobalConfig::default();
        let fake = Fake::default();
        let steps = vec![Step { id: "resolver:demo.test".into(), description: String::new(), sudo: true }];
        assert!(apply(&steps, &mut g, Path::new("/b"), &l, &fake).is_err());
        assert!(fake.calls.borrow().is_empty());
    }

    #[test]
    fn resolver_domains_that_are_paths_are_never_planned_or_written() {
        // review #22
        let l = layout("domainpath");
        let g = GlobalConfig::default();
        let bin = Path::new("/bin/setu");
        let fake = Fake::default();
        let steps = plan_in(&g, &doms(&["/etc/sudoers", "../../etc/hosts", "a/b.test", "ok.test", "bad name.test"]), bin, &fake, &l);
        assert_eq!(ids(&steps), ["capture-path", "launch-agent", "resolver:ok.test"]);
        // even a hand-made step is refused before anything is written
        let mut g2 = GlobalConfig::default();
        for bad in ["resolver:/etc/sudoers", "resolver:../x", "resolver:a/b"] {
            let steps = vec![Step { id: bad.into(), description: String::new(), sudo: true }];
            assert!(apply(&steps, &mut g2, bin, &l, &fake).is_err(), "{bad}");
        }
        assert!(fake.calls.borrow().is_empty(), "{:?}", fake.calls.borrow());
    }

    #[test]
    fn an_unreadable_or_linked_resolver_target_is_a_refusal_not_an_overwrite() {
        use std::os::unix::fs::PermissionsExt;
        let l = layout("unreadable");
        std::fs::create_dir_all(&l.resolver_dir).unwrap();
        let mut g = GlobalConfig::default();
        let fake = Fake::default();
        let steps = vec![Step { id: "resolver:demo.test".into(), description: String::new(), sudo: true }];
        // a file we cannot read
        let f = l.resolver_dir.join("demo.test");
        std::fs::write(&f, "# managed by setu\n").unwrap();
        std::fs::set_permissions(&f, std::fs::Permissions::from_mode(0o000)).unwrap();
        let readable_anyway = std::fs::read_to_string(&f).is_ok(); // running as root
        let r = apply(&steps, &mut g, Path::new("/b"), &l, &fake);
        std::fs::set_permissions(&f, std::fs::Permissions::from_mode(0o600)).unwrap();
        if !readable_anyway {
            assert!(r.is_err() && fake.calls.borrow().is_empty());
        }
        // a symlink
        std::fs::remove_file(&f).unwrap();
        std::os::unix::fs::symlink("/etc/hosts", &f).unwrap();
        assert!(apply(&steps, &mut g, Path::new("/b"), &l, &fake).is_err());
        assert!(fake.calls.borrow().is_empty());
    }

    #[test]
    fn bootstrap_failure_is_error_and_not_recorded() {
        let l = layout("bootfail");
        let mut g = GlobalConfig::default();
        let fake = Fake { bootstrap_code: 5, ..Default::default() };
        let steps = vec![Step { id: "launch-agent".into(), description: String::new(), sudo: false }];
        assert!(apply(&steps, &mut g, Path::new("/b"), &l, &fake).is_err());
        assert!(SetupRecord::load(&l.record).unwrap().plist.is_none());
    }

    #[test]
    fn plist_is_well_formed_and_escaped() {
        let p = plist(Path::new("/a&b/setu"), "/x:/y&z", Path::new("/l/daemon.log"));
        for k in ["<key>Label</key>", "dev.setu.daemon", "<key>ProgramArguments</key>", "<string>daemon</string>", "<key>RunAtLoad</key>", "<key>KeepAlive</key>", "<key>SuccessfulExit</key>", "<key>StandardOutPath</key>", "<key>StandardErrorPath</key>", "<key>EnvironmentVariables</key>", "<key>PATH</key>", "<key>ProcessType</key>", "<string>Background</string>"] {
            assert!(p.contains(k), "missing {k}");
        }
        assert!(p.contains("/a&amp;b/setu") && p.contains("/x:/y&amp;z"));
        assert!(!p.contains("a&b"));
        assert_eq!(p.matches("<dict>").count(), p.matches("</dict>").count());
        assert_eq!(p.matches("<string>").count(), p.matches("</string>").count());
    }
}
