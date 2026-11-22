//! A `brew upgrade` swaps the binary on disk, but launchd keeps running the old one until it is
//! restarted. The daemon notices the swap itself: it remembers the identity (device, inode, mtime,
//! size) of the file it was started from, and when that file is replaced it shuts down gracefully
//! with [`RESTART_EXIT_CODE`]. The LaunchAgent's `KeepAlive` (restart on a non-zero exit) starts the
//! new binary. Running dev servers are handled exactly as on a SIGTERM shutdown.

use std::os::unix::fs::MetadataExt;
use std::path::{Path, PathBuf};
use std::time::Duration;

/// Non-zero on purpose: the plist restarts the daemon only after an unsuccessful exit
/// (`KeepAlive` / `SuccessfulExit = false`). 75 is EX_TEMPFAIL.
pub const RESTART_EXIT_CODE: i32 = 75;

/// How often the daemon's maintenance tick runs (upgrade check, pending Setu.app update). Once a
/// minute; `SETU_MAINTENANCE_SECS` shortens it for tests and sandboxes.
pub fn maintenance_every() -> Duration {
    let secs = std::env::var("SETU_MAINTENANCE_SECS").ok().and_then(|v| v.parse::<u64>().ok()).filter(|s| *s > 0).unwrap_or(60);
    Duration::from_secs(secs)
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ExeId {
    dev: u64,
    ino: u64,
    mtime: (i64, i64),
    len: u64,
}

/// Identity of the file `path` resolves to (symlinks followed), `None` when it cannot be read.
pub fn exe_id(path: &Path) -> Option<ExeId> {
    let m = std::fs::metadata(path).ok()?;
    Some(ExeId { dev: m.dev(), ino: m.ino(), mtime: (m.mtime(), m.mtime_nsec()), len: m.len() })
}

/// Which path to watch. `override_` (`SETU_RESTART_WATCH`, a test seam) wins. Otherwise only a daemon
/// started through Homebrew's stable `.../opt/setu/bin/setu` link is watched: that link is what the
/// LaunchAgent runs and what an upgrade repoints. A dev build or a hand-run daemon is never restarted.
pub fn watch_path(argv0: Option<&str>, override_: Option<&str>) -> Option<PathBuf> {
    if let Some(o) = override_.filter(|o| !o.is_empty()) {
        return Some(PathBuf::from(o));
    }
    argv0.filter(|a| Path::new(a).is_absolute() && a.contains("/opt/setu/bin/setu")).map(PathBuf::from)
}

pub struct Watch {
    path: PathBuf,
    id: ExeId,
}

impl Watch {
    pub fn new(path: PathBuf) -> Option<Watch> {
        let id = exe_id(&path)?;
        Some(Watch { path, id })
    }

    pub fn from_env() -> Option<Watch> {
        let argv0 = std::env::args().next();
        Watch::new(watch_path(argv0.as_deref(), std::env::var("SETU_RESTART_WATCH").ok().as_deref())?)
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    /// Has the watched file been replaced since the daemon started? A path that is briefly missing
    /// (the middle of an upgrade) is "not yet": the next tick looks again.
    pub fn changed(&self) -> bool {
        exe_id(&self.path).is_some_and(|now| now != self.id)
    }
}

/// The daemon's maintenance check: `Some(exit code)` when it must shut down so launchd starts the new binary.
pub fn restart_code(w: Option<&Watch>) -> Option<i32> {
    w.filter(|w| w.changed()).map(|_| RESTART_EXIT_CODE)
}

// ---------------------------------------------------------------- self-upgrade

/// Homebrew's `brew` for a daemon started from `<prefix>/opt/setu/bin/setu`. `None` for any other
/// path: only a Homebrew install upgrades itself, never a dev build or a hand-run binary.
pub fn brew_for(watched: &Path) -> Option<PathBuf> {
    let prefix = watched.to_str()?.strip_suffix("/opt/setu/bin/setu")?;
    (!prefix.is_empty()).then(|| Path::new(prefix).join("bin/brew"))
}

/// Is a check due? `last` is the previous attempt (unix seconds), successful or not.
pub fn upgrade_due(last: Option<u64>, now: u64, every: u64) -> bool {
    last.is_none_or(|t| now.saturating_sub(t) >= every)
}

/// Where the last attempt's time is kept, so restarts and crash loops never re-run it early.
fn stamp_path() -> PathBuf {
    crate::paths::state_dir().join("last-upgrade-check")
}

pub fn last_check() -> Option<u64> {
    std::fs::read_to_string(stamp_path()).ok()?.trim().parse().ok()
}

pub fn record_check(now: u64) {
    let p = stamp_path();
    if let Some(d) = p.parent() {
        let _ = std::fs::create_dir_all(d);
    }
    let _ = std::fs::write(p, now.to_string());
}

/// Blocking: `brew update`, then `brew upgrade setu`. Returns brew's last output line. When the
/// binary changes, the maintenance tick sees it and restarts the daemon onto it.
pub fn upgrade_via(brew: &Path) -> anyhow::Result<String> {
    let run = |args: &[&str]| {
        let mut c = std::process::Command::new(brew);
        c.args(args).env("HOMEBREW_NO_ENV_HINTS", "1").env("HOMEBREW_NO_INSTALL_CLEANUP", "1");
        crate::worktree::exec(c, Duration::from_secs(600)).map_err(|e| anyhow::anyhow!("brew {}: {e}", args.join(" ")))
    };
    run(&["update", "--quiet"])?;
    let out = run(&["upgrade", "setu"])?;
    Ok(out.text().lines().last().unwrap_or("").to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("setu-selfupdate-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn only_the_homebrew_opt_link_is_watched_unless_overridden() {
        let brew = "/opt/homebrew/opt/setu/bin/setu";
        assert_eq!(watch_path(Some(brew), None), Some(PathBuf::from(brew)));
        assert_eq!(watch_path(Some("/usr/local/opt/setu/bin/setu"), None), Some(PathBuf::from("/usr/local/opt/setu/bin/setu")));
        assert_eq!(watch_path(Some("/Users/me/target/debug/setu"), None), None, "a dev build is never restarted");
        assert_eq!(watch_path(Some("setu"), None), None, "a relative argv[0] is not a launchd start");
        assert_eq!(watch_path(Some("/x/setu"), Some("/seam")), Some(PathBuf::from("/seam")));
        assert_eq!(watch_path(None, None), None);
    }

    #[test]
    fn a_replaced_or_retargeted_binary_is_detected_and_an_untouched_one_is_not() {
        let d = tmp("detect");
        let real = d.join("Cellar-1");
        std::fs::write(&real, "v1").unwrap();
        let opt = d.join("opt-setu");
        std::os::unix::fs::symlink(&real, &opt).unwrap();
        let w = Watch::new(opt.clone()).unwrap();
        assert!(!w.changed(), "nothing happened yet");
        assert_eq!(restart_code(Some(&w)), None);
        assert_eq!(restart_code(None), None);

        // brew upgrade: the opt link now points at a new file
        let newer = d.join("Cellar-2");
        std::fs::write(&newer, "v2 longer").unwrap();
        std::fs::remove_file(&opt).unwrap();
        assert!(!w.changed(), "a link that is briefly missing is not a change");
        std::os::unix::fs::symlink(&newer, &opt).unwrap();
        assert!(w.changed(), "the link was repointed");
        assert_eq!(restart_code(Some(&w)), Some(RESTART_EXIT_CODE), "a changed binary means: exit non-zero so launchd restarts us");

        // brew reinstall of the same version: the file itself is replaced
        let w2 = Watch::new(newer.clone()).unwrap();
        assert!(!w2.changed());
        std::fs::write(d.join("tmp"), "v2 longer").unwrap();
        std::fs::rename(d.join("tmp"), &newer).unwrap();
        assert!(w2.changed(), "same bytes, new inode");
        assert!(Watch::new(d.join("missing")).is_none());
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn the_restart_exit_code_is_non_zero_so_keepalive_restarts_the_daemon() {
        // The plist only restarts after an unsuccessful exit; a zero code would leave Setu down after an upgrade.
        assert_ne!(RESTART_EXIT_CODE, 0);
        let plist = crate::setup::plist(Path::new("/b/setu"), "/usr/bin", Path::new("/l"));
        assert!(plist.contains("<key>SuccessfulExit</key>\n\t\t<false/>"));
    }

    #[test]
    fn only_a_homebrew_install_finds_brew() {
        assert_eq!(brew_for(Path::new("/opt/homebrew/opt/setu/bin/setu")), Some(PathBuf::from("/opt/homebrew/bin/brew")));
        assert_eq!(brew_for(Path::new("/usr/local/opt/setu/bin/setu")), Some(PathBuf::from("/usr/local/bin/brew")));
        assert_eq!(brew_for(Path::new("/Users/me/setu/target/debug/setu")), None);
        assert_eq!(brew_for(Path::new("/opt/setu/bin/setu")), None, "no prefix");
    }

    #[test]
    fn a_check_is_due_once_per_interval() {
        assert!(upgrade_due(None, 100, 86_400));
        assert!(!upgrade_due(Some(100), 100 + 86_399, 86_400));
        assert!(upgrade_due(Some(100), 100 + 86_400, 86_400));
        assert!(!upgrade_due(Some(500), 100, 86_400), "a clock that went back never triggers early");
    }
}