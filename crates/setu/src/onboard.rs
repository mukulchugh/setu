//! The one-command experience: `brew install mukulchugh/tap/setu && setu`.
//!
//! Bare `setu` on a machine that is not set up runs the whole setup without asking; any command that
//! needs the daemon does the same once, or restarts the daemon when the LaunchAgent is installed but
//! the daemon is down. Everything system-facing goes through [`Sys`], so tests drive this with a fake.

use crate::app;
use crate::globalcfg::GlobalConfig;
use crate::setup::{self, Layout, Step, Sys, LABEL, MARKER};
use anyhow::{anyhow, Result};
use std::path::{Path, PathBuf};

pub struct Ctx<'a> {
    pub sys: &'a dyn Sys,
    pub layout: Layout,
    pub home: PathBuf,
    /// The Setu.app that came with this build.
    pub bundled: Option<PathBuf>,
    /// Is a process running from this app bundle?
    pub running: &'a dyn Fn(&Path) -> bool,
    /// Can a sudo password prompt reach a person?
    pub tty: bool,
    /// Does a daemon answer on the socket right now?
    pub daemon_up: &'a dyn Fn() -> bool,
    /// How long to wait for the daemon to answer after starting it.
    pub wait_secs: u64,
    pub load_gcfg: &'a dyn Fn() -> Result<GlobalConfig>,
    /// Custom domains of the user's projects (for the resolver steps).
    pub domains: Vec<String>,
    /// The binary the LaunchAgent should run.
    pub binary: PathBuf,
}

/// The LaunchAgent plist is what makes Setu "installed".
pub fn installed(layout: &Layout) -> bool {
    layout.plist.exists()
}

pub fn app_step(home: &Path, bundled: Option<&Path>) -> Option<Step> {
    let dest = home.join("Applications/Setu.app");
    (bundled.is_some() && !dest.exists()).then(|| Step { id: "app".into(), description: "Install Setu.app into ~/Applications (open it from Spotlight)".into(), sudo: false })
}

/// The setup plan: the system steps, then the app.
pub fn plan(ctx: &Ctx, gcfg: &GlobalConfig) -> Vec<Step> {
    let mut steps = setup::plan_in(gcfg, &ctx.domains, &ctx.binary, ctx.sys, &ctx.layout);
    steps.extend(app_step(&ctx.home, ctx.bundled.as_deref()));
    steps
}

/// The exact shell command for a resolver step, for when there is no terminal to ask for a password.
pub fn resolver_command(layout: &Layout, domain: &str, dns_port: u16) -> String {
    format!(
        "sudo mkdir -p {dir} && printf '%s\\n' '{MARKER}' 'nameserver 127.0.0.1' 'port {dns_port}' | sudo tee {dir}/{domain} >/dev/null",
        dir = layout.resolver_dir.display()
    )
}

pub fn install_app(ctx: &Ctx) -> Result<String> {
    let actx = app::Ctx { home: ctx.home.clone(), bundled: ctx.bundled.clone(), running: ctx.running };
    app::install(&actx)
}

/// Wait up to `ctx.wait_secs` for the daemon to answer.
pub fn wait_for_daemon(ctx: &Ctx) -> bool {
    for _ in 0..ctx.wait_secs * 10 {
        if (ctx.daemon_up)() {
            return true;
        }
        ctx.sys.pause(100);
    }
    (ctx.daemon_up)()
}

/// Run `steps` without asking anything. A resolver step needs sudo: with a terminal it runs through
/// `sudo` (one normal password prompt), without one it is skipped and its command is printed.
/// A failed sudo step or app install is reported and does not stop the rest.
pub fn apply_steps(ctx: &Ctx, steps: &[Step], gcfg: &mut GlobalConfig, say: &mut dyn FnMut(&str)) -> Result<()> {
    let plain: Vec<Step> = steps.iter().filter(|s| !s.sudo && s.id != "app").cloned().collect();
    if !plain.is_empty() {
        setup::apply(&plain, gcfg, &ctx.binary, &ctx.layout, ctx.sys)?;
        say("  captured your shell PATH");
    }
    if plain.iter().any(|s| s.id == "launch-agent") {
        say("  installed the LaunchAgent; starting the daemon...");
        if !wait_for_daemon(ctx) {
            return Err(anyhow!("the daemon did not answer within {}s. See {} and run `setu doctor`", ctx.wait_secs, ctx.layout.log.display()));
        }
        say("  daemon is up");
    }
    for s in steps.iter().filter(|s| s.sudo) {
        let domain = s.id.strip_prefix("resolver:").unwrap_or(&s.id);
        if !ctx.tty {
            say(&format!("  skipped {domain} (needs sudo and there is no terminal). Run this in a terminal:"));
            say(&format!("    {}", resolver_command(&ctx.layout, domain, gcfg.dns_port)));
            continue;
        }
        say(&format!("  {domain}: writing the resolver file (sudo asks for your password)"));
        match setup::apply(std::slice::from_ref(s), gcfg, &ctx.binary, &ctx.layout, ctx.sys) {
            Ok(_) => say(&format!("  {domain}: done")),
            Err(e) => {
                say(&format!("  {domain}: not done ({e:#}). Run `setu setup` in a terminal to retry, or:"));
                say(&format!("    {}", resolver_command(&ctx.layout, domain, gcfg.dns_port)));
            }
        }
    }
    if steps.iter().any(|s| s.id == "app") {
        match install_app(ctx) {
            Ok(m) => say(&format!("  {m}")),
            Err(e) => say(&format!("  Setu.app not installed: {e:#}")),
        }
    }
    Ok(())
}

/// The whole first-run setup, as `setup --yes` plus the app.
pub fn first_run(ctx: &Ctx, say: &mut dyn FnMut(&str)) -> Result<()> {
    let mut gcfg = (ctx.load_gcfg)()?;
    let steps = plan(ctx, &gcfg);
    for s in &steps {
        say(&format!("  - {}", s.description));
    }
    apply_steps(ctx, &steps, &mut gcfg, say)
}

#[derive(Debug, PartialEq)]
pub enum Ensure {
    AlreadyUp,
    SetUp,
    Restarted,
}

/// Make sure a daemon answers: nothing if one does; the first-run setup when Setu is not installed;
/// `launchctl kickstart` when the LaunchAgent is installed but the daemon is down.
pub fn ensure_daemon(ctx: &Ctx, say: &mut dyn FnMut(&str)) -> Result<Ensure> {
    if (ctx.daemon_up)() {
        return Ok(Ensure::AlreadyUp);
    }
    if !installed(&ctx.layout) {
        say("Setu isn't set up yet; setting it up now...");
        first_run(ctx, say)?;
        return Ok(Ensure::SetUp);
    }
    let service = format!("gui/{}/{LABEL}", ctx.sys.uid());
    let started = ctx.sys.run("launchctl", &["kickstart", &service]).map(|(c, _)| c == 0).unwrap_or(false);
    if started && wait_for_daemon(ctx) {
        return Ok(Ensure::Restarted);
    }
    Err(anyhow!("{}\nthe LaunchAgent is installed but the daemon did not start; run `setu doctor`", crate::api::DaemonDown))
}

/// Printed after a first run: how to add a project and what to try next.
pub fn next_steps(projects_dir: &Path, v1_found: bool, app_installed: bool) -> String {
    let mut s = String::from("\nSetu is ready. Next:\n\n");
    if v1_found {
        s.push_str("  1. The old JavaScript Setu is on this machine. `setu migrate` shows what it would move (read-only);\n     `setu migrate run --yes` moves your projects, worktrees and ports.\n     Or add a project by hand:\n\n");
    } else {
        s.push_str("  1. Add a project. Create a file in the config folder:\n\n");
    }
    s.push_str(&format!(
        "       {dir}/myapp.toml\n\n         project = \"myapp\"\n         repo    = \"~/workspace/myapp.git\"\n         domain  = \"localhost\"\n\n         [procs.web]\n         run  = \"bun dev\"\n         port = \"web\"\n\n         [ports]\n         web = {{}}\n\n",
        dir = projects_dir.display()
    ));
    s.push_str("  2. Make a worktree with its own URL: `setu new myapp feat/login`, or `setu adopt <path>` for one you have.\n");
    s.push_str("  3. `setu ls` lists every run with its URL; `setu help` lists all commands.\n");
    if app_installed {
        s.push_str("\nOpen Setu from Spotlight for the menu bar view.\n");
    }
    s
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::{Cell, RefCell};

    struct Fake {
        calls: RefCell<Vec<String>>,
        started: Cell<bool>,
        /// What `launchctl kickstart` answers.
        kick_code: i32,
    }

    impl Fake {
        fn new() -> Fake {
            Fake { calls: RefCell::default(), started: Cell::new(false), kick_code: 0 }
        }
        fn called(&self, prefix: &str) -> usize {
            self.calls.borrow().iter().filter(|c| c.starts_with(prefix)).count()
        }
    }

    impl Sys for Fake {
        fn run(&self, cmd: &str, args: &[&str]) -> Result<(i32, String)> {
            self.calls.borrow_mut().push(format!("{cmd} {}", args.join(" ")));
            match args.first() {
                Some(&"print") => return Ok((if self.started.get() { 0 } else { 113 }, String::new())),
                Some(&"bootstrap") => self.started.set(true),
                Some(&"kickstart") => {
                    if self.kick_code == 0 {
                        self.started.set(true);
                    }
                    return Ok((self.kick_code, String::new()));
                }
                _ => {}
            }
            Ok((0, String::new()))
        }
        fn run_sudo_write(&self, path: &Path, contents: &str) -> Result<()> {
            self.calls.borrow_mut().push(format!("write {}", path.display()));
            std::fs::create_dir_all(path.parent().unwrap())?;
            std::fs::write(path, contents)?;
            Ok(())
        }
        fn run_sudo_remove(&self, _path: &Path) -> Result<()> {
            Ok(())
        }
        fn resolves_to_loopback(&self, _host: &str) -> bool {
            false
        }
        fn pause(&self, _ms: u64) {}
        fn uid(&self) -> u32 {
            501
        }
        fn login_path(&self) -> Result<String> {
            Ok("/fake/bin:/usr/bin".into())
        }
    }

    struct Sb {
        dir: PathBuf,
    }

    fn sandbox(tag: &str) -> Sb {
        let d = std::env::temp_dir().join(format!("setu-onboard-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        Sb { dir: d }
    }

    fn layout(d: &Path) -> Layout {
        Layout { plist: d.join("home/Library/LaunchAgents/dev.setu.daemon.plist"), record: d.join("cfg/setup.toml"), config: d.join("cfg/config.toml"), log: d.join("logs/daemon.log"), resolver_dir: d.join("resolver") }
    }

    fn fake_app(dir: &Path, version: &str) -> PathBuf {
        let app = dir.join("Setu.app");
        std::fs::create_dir_all(app.join("Contents/MacOS")).unwrap();
        std::fs::write(app.join("Contents/Info.plist"), format!("<plist><dict><key>CFBundleShortVersionString</key><string>{version}</string></dict></plist>")).unwrap();
        app
    }

    fn with_ctx<R>(b: &Sb, fake: &Fake, tty: bool, domains: &[&str], bundled: bool, f: impl FnOnce(&Ctx) -> R) -> R {
        let never = |_: &Path| false;
        let up = || fake.started.get();
        let load = || Ok(GlobalConfig::default());
        let ctx = Ctx {
            sys: fake,
            layout: layout(&b.dir),
            home: b.dir.join("home"),
            bundled: bundled.then(|| fake_app(&b.dir.join("pkg"), "0.2.0")),
            running: &never,
            tty,
            daemon_up: &up,
            wait_secs: 2,
            load_gcfg: &load,
            domains: domains.iter().map(|d| d.to_string()).collect(),
            binary: PathBuf::from("/bin/setu"),
        };
        f(&ctx)
    }

    #[test]
    fn a_first_run_installs_the_agent_waits_for_the_daemon_and_installs_the_app() {
        let b = sandbox("first");
        let fake = Fake::new();
        let mut out = Vec::new();
        with_ctx(&b, &fake, false, &[], true, |ctx| {
            first_run(ctx, &mut |l| out.push(l.to_string())).unwrap();
            assert!(installed(&ctx.layout));
        });
        assert_eq!(fake.called("launchctl bootstrap gui/501 "), 1, "{:?}", fake.calls.borrow());
        assert!(b.dir.join("home/Applications/Setu.app/Contents/Info.plist").exists(), "the bundled app is installed");
        assert!(out.iter().any(|l| l.contains("daemon is up")), "{out:?}");
        assert!(out.iter().any(|l| l.contains("Setu.app")), "{out:?}");
        assert_eq!(fake.called("write "), 0, "no resolver file without a custom domain");
        let _ = std::fs::remove_dir_all(&b.dir);
    }

    #[test]
    fn a_daemon_that_never_answers_fails_the_first_run_with_a_pointer_to_the_log() {
        let b = sandbox("never");
        let fake = Fake::new();
        let never_up = || false;
        let never = |_: &Path| false;
        let load = || Ok(GlobalConfig::default());
        let ctx = Ctx { sys: &fake, layout: layout(&b.dir), home: b.dir.join("home"), bundled: None, running: &never, tty: false, daemon_up: &never_up, wait_secs: 1, load_gcfg: &load, domains: vec![], binary: PathBuf::from("/bin/setu") };
        let e = first_run(&ctx, &mut |_| {}).unwrap_err().to_string();
        assert!(e.contains("did not answer") && e.contains("setu doctor"), "{e}");
        let _ = std::fs::remove_dir_all(&b.dir);
    }

    #[test]
    fn a_resolver_step_runs_through_sudo_with_a_terminal_and_is_skipped_with_its_command_without_one() {
        let b = sandbox("sudo");
        // with a terminal: sudo writes the file
        let fake = Fake::new();
        with_ctx(&b, &fake, true, &["demo.test"], false, |ctx| first_run(ctx, &mut |_| {}).unwrap());
        assert_eq!(fake.called("write "), 1);
        assert!(b.dir.join("resolver/demo.test").exists());
        let _ = std::fs::remove_dir_all(&b.dir);

        // without one: nothing is written, the exact command is printed, setup still completes
        let b = sandbox("nosudo");
        let fake = Fake::new();
        let mut out = Vec::new();
        with_ctx(&b, &fake, false, &["demo.test"], false, |ctx| first_run(ctx, &mut |l| out.push(l.to_string())).unwrap());
        assert_eq!(fake.called("write "), 0);
        assert!(!b.dir.join("resolver/demo.test").exists());
        let cmd = out.iter().find(|l| l.contains("sudo tee")).unwrap_or_else(|| panic!("{out:?}"));
        assert!(cmd.contains("/demo.test") && cmd.contains("port 15353") && cmd.contains("# managed by setu"), "{cmd}");
        assert_eq!(fake.called("launchctl bootstrap"), 1, "the rest of the setup still ran");
        let _ = std::fs::remove_dir_all(&b.dir);
    }

    #[test]
    fn a_failed_sudo_step_is_reported_and_does_not_fail_the_setup() {
        let b = sandbox("sudofail");
        let fake = Fake::new();
        // a foreign file makes the resolver step refuse
        std::fs::create_dir_all(b.dir.join("resolver")).unwrap();
        std::fs::write(b.dir.join("resolver/demo.test"), "nameserver 1.1.1.1\n").unwrap();
        let mut out = Vec::new();
        with_ctx(&b, &fake, true, &["demo.test"], false, |ctx| first_run(ctx, &mut |l| out.push(l.to_string())).unwrap());
        assert!(out.iter().any(|l| l.contains("not done") && l.contains("demo.test")), "{out:?}");
        let _ = std::fs::remove_dir_all(&b.dir);
    }

    #[test]
    fn ensure_sets_up_when_not_installed_and_says_so_once() {
        let b = sandbox("ensure-setup");
        let fake = Fake::new();
        let mut out = Vec::new();
        let r = with_ctx(&b, &fake, false, &[], false, |ctx| ensure_daemon(ctx, &mut |l| out.push(l.to_string())).unwrap());
        assert_eq!(r, Ensure::SetUp);
        assert_eq!(out[0], "Setu isn't set up yet; setting it up now...");
        assert_eq!(out.iter().filter(|l| l.contains("isn't set up")).count(), 1);
        assert_eq!(fake.called("launchctl bootstrap"), 1);
        assert_eq!(fake.called("launchctl kickstart"), 0);
        let _ = std::fs::remove_dir_all(&b.dir);
    }

    #[test]
    fn ensure_kickstarts_when_the_agent_is_installed_and_the_daemon_is_down() {
        let b = sandbox("ensure-kick");
        let fake = Fake::new();
        let l = layout(&b.dir);
        std::fs::create_dir_all(l.plist.parent().unwrap()).unwrap();
        std::fs::write(&l.plist, "x").unwrap();
        let mut out = Vec::new();
        let r = with_ctx(&b, &fake, false, &[], true, |ctx| ensure_daemon(ctx, &mut |l| out.push(l.to_string())).unwrap());
        assert_eq!(r, Ensure::Restarted);
        assert_eq!(fake.called("launchctl kickstart gui/501/dev.setu.daemon"), 1, "{:?}", fake.calls.borrow());
        assert_eq!(fake.called("launchctl bootstrap"), 0, "an installed agent is not set up again");
        assert!(out.is_empty(), "nothing is printed for a plain restart: {out:?}");
        assert!(!b.dir.join("home/Applications").exists(), "no app install on a restart");
        let _ = std::fs::remove_dir_all(&b.dir);
    }

    #[test]
    fn ensure_does_nothing_when_the_daemon_answers_and_fails_with_a_doctor_hint_when_kickstart_fails() {
        let b = sandbox("ensure-up");
        let fake = Fake::new();
        fake.started.set(true);
        let r = with_ctx(&b, &fake, false, &[], false, |ctx| ensure_daemon(ctx, &mut |_| {}).unwrap());
        assert_eq!(r, Ensure::AlreadyUp);
        assert!(fake.calls.borrow().is_empty());

        let b2 = sandbox("ensure-fail");
        let mut fake2 = Fake::new();
        fake2.kick_code = 113;
        let l = layout(&b2.dir);
        std::fs::create_dir_all(l.plist.parent().unwrap()).unwrap();
        std::fs::write(&l.plist, "x").unwrap();
        let e = with_ctx(&b2, &fake2, false, &[], false, |ctx| ensure_daemon(ctx, &mut |_| {}).unwrap_err().to_string());
        assert!(e.contains("setu daemon is not running") && e.contains("setu doctor"), "{e}");
        let _ = std::fs::remove_dir_all(&b.dir);
        let _ = std::fs::remove_dir_all(&b2.dir);
    }

    #[test]
    fn the_app_is_a_listed_plan_step_only_when_a_bundle_exists_and_nothing_is_installed() {
        let b = sandbox("appstep");
        let fake = Fake::new();
        let with = with_ctx(&b, &fake, false, &[], true, |ctx| plan(ctx, &GlobalConfig::default()).iter().map(|s| s.id.clone()).collect::<Vec<_>>());
        assert_eq!(with, ["capture-path", "launch-agent", "app"]);
        let without = with_ctx(&b, &fake, false, &[], false, |ctx| plan(ctx, &GlobalConfig::default()).iter().map(|s| s.id.clone()).collect::<Vec<_>>());
        assert_eq!(without, ["capture-path", "launch-agent"]);
        fake_app(&b.dir.join("home/Applications"), "0.1.0");
        let installed = with_ctx(&b, &fake, false, &[], true, |ctx| plan(ctx, &GlobalConfig::default()).iter().map(|s| s.id.clone()).collect::<Vec<_>>());
        assert_eq!(installed, ["capture-path", "launch-agent"], "an installed app is the daemon's to update, not setup's");
        let _ = std::fs::remove_dir_all(&b.dir);
    }

    #[test]
    fn next_steps_name_the_config_path_and_point_at_migrate_only_when_v1_exists() {
        let dir = Path::new("/h/.config/setu/projects");
        let fresh = next_steps(dir, false, true);
        assert!(fresh.contains("/h/.config/setu/projects/myapp.toml") && fresh.contains("[procs.web]") && fresh.contains("setu ls") && fresh.contains("Spotlight"));
        assert!(!fresh.contains("setu migrate"));
        let v1 = next_steps(dir, true, false);
        assert!(v1.contains("setu migrate") && !v1.contains("Spotlight"));
    }
}
