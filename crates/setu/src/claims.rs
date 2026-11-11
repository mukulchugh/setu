//! Writer claims (slice 7): which agent or person is editing a worktree right now.
//! One JSON file per run under `<state>/claims/<project>/<run>.json`, written atomically.
//! A claim is stale when its pid is gone (start time checked, so a recycled pid does not count)
//! or its heartbeat is older than `TTL`. A stale claim may be taken over by another holder.
//! Every function takes the claims directory, so tests use a temp dir.
#![allow(dead_code)]

use crate::procinfo;
use anyhow::{anyhow, bail, Context, Result};
use serde::{Deserialize, Serialize};
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::os::unix::fs::{DirBuilderExt, OpenOptionsExt};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

/// A claim whose heartbeat is older than this is stale.
pub const TTL_SECS: u64 = 2 * 60 * 60;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Claim {
    /// `project/run`
    pub run: String,
    pub holder: String,
    pub pid: Option<i32>,
    /// Kernel start time of `pid` when claimed; a different value later means the pid was recycled.
    pub start_time: Option<u64>,
    pub created: u64,
    pub heartbeat: u64,
}

#[derive(Debug, Clone, PartialEq)]
pub enum Outcome {
    Created,
    Refreshed,
    TookOver { from: Claim },
}

pub fn now() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

/// Same rule as v1 writer names: lowercase letters, digits and dashes, 1 to 40 chars.
pub fn validate_holder(h: &str) -> Result<()> {
    if h.is_empty() || h.len() > 40 || !h.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-') {
        bail!("claim holder {h:?} must be 1 to 40 characters of a-z, 0-9 and '-'");
    }
    Ok(())
}

/// Turn any client or user name into a valid holder name.
pub fn sanitize_holder(raw: &str) -> String {
    let mut out = String::new();
    for c in raw.to_lowercase().chars() {
        let c = if c.is_ascii_lowercase() || c.is_ascii_digit() { c } else { '-' };
        if c == '-' && (out.ends_with('-') || out.is_empty()) {
            continue;
        }
        out.push(c);
    }
    let out: String = out.trim_end_matches('-').chars().take(40).collect();
    if out.is_empty() { "agent".into() } else { out }
}

fn file_for(dir: &Path, run: &str) -> Result<PathBuf> {
    let (project, name) = run.split_once('/').ok_or_else(|| anyhow!("claim run {run:?} must be project/run"))?;
    for part in [project, name] {
        if part.is_empty() || part.contains('/') || part.contains('\0') || part == "." || part == ".." || part.starts_with('.') {
            bail!("claim run {run:?} has an invalid component");
        }
    }
    Ok(dir.join(project).join(format!("{name}.json")))
}

/// Exclusive flock on `<dir>/.lock` while `f` runs; the kernel releases it if we die.
fn with_lock<T>(dir: &Path, f: impl FnOnce() -> Result<T>) -> Result<T> {
    use std::os::unix::io::AsRawFd;
    fs::DirBuilder::new().recursive(true).mode(0o700).create(dir).with_context(|| format!("creating {}", dir.display()))?;
    let lock = OpenOptions::new().create(true).truncate(false).write(true).mode(0o600).open(dir.join(".lock"))?;
    // SAFETY: flock on a valid fd we own; blocking is fine, holders keep it for microseconds.
    if unsafe { libc::flock(lock.as_raw_fd(), libc::LOCK_EX) } != 0 {
        return Err(std::io::Error::last_os_error()).context("locking the claims directory");
    }
    f()
}

fn read_file(path: &Path) -> Result<Option<Claim>> {
    match fs::read(path) {
        Ok(b) => Ok(Some(serde_json::from_slice(&b).with_context(|| format!("unreadable claim file {}", path.display()))?)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e).with_context(|| format!("reading {}", path.display())),
    }
}

fn write_file(path: &Path, c: &Claim) -> Result<()> {
    let parent = path.parent().ok_or_else(|| anyhow!("bad claim path"))?;
    fs::DirBuilder::new().recursive(true).mode(0o700).create(parent)?;
    let tmp = parent.join(format!(".claim.tmp.{}", std::process::id()));
    let res = (|| -> Result<()> {
        let mut f = OpenOptions::new().write(true).create(true).truncate(true).mode(0o600).open(&tmp)?;
        f.write_all(&serde_json::to_vec_pretty(c)?)?;
        f.sync_all()?;
        fs::rename(&tmp, path)?;
        Ok(())
    })();
    if res.is_err() {
        let _ = fs::remove_file(&tmp);
    }
    res.with_context(|| format!("writing {}", path.display()))
}

/// Stale: the holder's process is gone (or is a different incarnation), or the heartbeat is too old.
pub fn is_stale(c: &Claim, now: u64) -> bool {
    if now.saturating_sub(c.heartbeat) > TTL_SECS {
        return true;
    }
    match c.pid {
        None => false,
        Some(pid) => {
            if !procinfo::alive(pid) {
                return true;
            }
            match (c.start_time, procinfo::start_time(pid)) {
                (Some(then), Some(nowt)) => then != nowt,
                _ => false,
            }
        }
    }
}

pub fn get(dir: &Path, run: &str) -> Result<Option<Claim>> {
    read_file(&file_for(dir, run)?)
}

/// The holder of a live (not stale) claim. An unreadable claim file counts as live: unknown means keep.
pub fn live_holder(dir: &Path, run: &str, now: u64) -> Option<String> {
    match get(dir, run) {
        Ok(None) => None,
        Ok(Some(c)) => (!is_stale(&c, now)).then_some(c.holder),
        Err(_) => Some("(unreadable claim file)".into()),
    }
}

/// Claim `run` for `holder`. The same holder refreshes its own claim; a stale claim of another
/// holder is taken over; a live claim of another holder is refused.
pub fn claim(dir: &Path, run: &str, holder: &str, pid: Option<i32>, now: u64) -> Result<(Claim, Outcome)> {
    validate_holder(holder)?;
    let path = file_for(dir, run)?;
    let start_time = match pid {
        Some(p) => {
            if !procinfo::alive(p) {
                bail!("pid {p} is not running; a claim needs a live holder process");
            }
            procinfo::start_time(p)
        }
        None => None,
    };
    with_lock(dir, || {
        let existing = read_file(&path)?;
        let outcome = match &existing {
            None => Outcome::Created,
            Some(old) if old.holder == holder => Outcome::Refreshed,
            Some(old) if is_stale(old, now) => Outcome::TookOver { from: old.clone() },
            Some(old) => bail!(
                "{run} is claimed by {} (pid {}, heartbeat {}s ago); use another worktree, or wait until it releases or goes stale",
                old.holder,
                old.pid.map(|p| p.to_string()).unwrap_or_else(|| "none".into()),
                now.saturating_sub(old.heartbeat)
            ),
        };
        let created = match (&outcome, &existing) {
            (Outcome::Refreshed, Some(old)) => old.created,
            _ => now,
        };
        // A refresh without a pid keeps the recorded one.
        let (pid, start_time) = match (&outcome, &existing, pid) {
            (Outcome::Refreshed, Some(old), None) => (old.pid, old.start_time),
            _ => (pid, start_time),
        };
        let c = Claim { run: run.to_string(), holder: holder.to_string(), pid, start_time, created, heartbeat: now };
        write_file(&path, &c)?;
        Ok((c, outcome))
    })
}

/// Refresh the heartbeat. Only the holder, and only while the claim is not stale.
pub fn heartbeat(dir: &Path, run: &str, holder: &str, now: u64) -> Result<Claim> {
    let path = file_for(dir, run)?;
    with_lock(dir, || {
        let mut c = read_file(&path)?.ok_or_else(|| anyhow!("{run} has no claim"))?;
        if c.holder != holder {
            bail!("{run} is claimed by {}, not {holder}", c.holder);
        }
        if is_stale(&c, now) {
            bail!("the claim on {run} went stale; claim it again");
        }
        c.heartbeat = now;
        write_file(&path, &c)?;
        Ok(c)
    })
}

/// Remove a claim. `holder = Some(h)` must match unless the claim is stale; `None` is an
/// administrator (CLI or app) releasing whatever is there. Returns the removed claim.
pub fn release(dir: &Path, run: &str, holder: Option<&str>, now: u64) -> Result<Option<Claim>> {
    let path = file_for(dir, run)?;
    with_lock(dir, || {
        let Some(c) = read_file(&path).or_else(|e| match holder {
            // A corrupt file can only be removed by an administrator.
            None => Ok(Some(Claim { run: run.into(), holder: "(unreadable)".into(), pid: None, start_time: None, created: now, heartbeat: now })),
            Some(_) => Err(e),
        })?
        else {
            return Ok(None);
        };
        if let Some(h) = holder {
            if c.holder != h && !is_stale(&c, now) {
                bail!("{run} is claimed by {}, not {h}; only the holder (or the user, from the CLI) can release it", c.holder);
            }
        }
        match fs::remove_file(&path) {
            Ok(()) => {}
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => return Err(e).with_context(|| format!("removing {}", path.display())),
        }
        Ok(Some(c))
    })
}

/// Every claim on disk, stale ones included (callers mark them with `is_stale`).
pub fn list(dir: &Path, now: u64) -> Vec<Claim> {
    let mut out = Vec::new();
    let Ok(projects) = fs::read_dir(dir) else { return out };
    for p in projects.flatten() {
        let Ok(files) = fs::read_dir(p.path()) else { continue };
        for f in files.flatten() {
            let path = f.path();
            if path.extension().is_none_or(|x| x != "json") {
                continue;
            }
            match read_file(&path) {
                Ok(Some(c)) => out.push(c),
                Ok(None) => {}
                Err(_) => {
                    let run = format!("{}/{}", p.file_name().to_string_lossy(), path.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default());
                    out.push(Claim { run, holder: "(unreadable)".into(), pid: None, start_time: None, created: now, heartbeat: now });
                }
            }
        }
    }
    out.sort_by(|a, b| a.run.cmp(&b.run));
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("setu-claims-{tag}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&d);
        d
    }

    fn me() -> i32 {
        std::process::id() as i32
    }

    /// A pid that existed and is now gone, with the start time it had.
    fn dead_pid() -> (i32, Option<u64>) {
        let mut child = std::process::Command::new("sleep").arg("30").spawn().unwrap();
        let pid = child.id() as i32;
        let st = procinfo::start_time(pid);
        child.kill().unwrap();
        child.wait().unwrap();
        (pid, st)
    }

    #[test]
    fn claim_refresh_release() {
        let d = tmp("basic");
        let t = now();
        let (c, o) = claim(&d, "p/r", "agent-a", Some(me()), t).unwrap();
        assert_eq!(o, Outcome::Created);
        assert_eq!(c.pid, Some(me()));
        assert!(c.start_time.is_some() || !cfg!(target_os = "macos"));
        let (c2, o) = claim(&d, "p/r", "agent-a", None, t + 5).unwrap();
        assert_eq!(o, Outcome::Refreshed);
        assert_eq!(c2.created, t);
        assert_eq!(c2.pid, Some(me()), "refresh without a pid keeps the recorded one");
        assert_eq!(c2.heartbeat, t + 5);
        assert_eq!(heartbeat(&d, "p/r", "agent-a", t + 9).unwrap().heartbeat, t + 9);
        assert!(heartbeat(&d, "p/r", "other", t + 9).is_err());
        assert_eq!(live_holder(&d, "p/r", t + 10).as_deref(), Some("agent-a"));
        assert_eq!(list(&d, t).len(), 1);
        // a live claim of another holder is refused, and so is releasing it as that holder
        assert!(claim(&d, "p/r", "agent-b", None, t + 10).unwrap_err().to_string().contains("claimed by agent-a"));
        assert!(release(&d, "p/r", Some("agent-b"), t + 10).is_err());
        assert!(release(&d, "p/r", Some("agent-a"), t + 10).unwrap().is_some());
        assert!(release(&d, "p/r", Some("agent-a"), t + 10).unwrap().is_none());
        assert!(live_holder(&d, "p/r", t + 10).is_none());
        let _ = fs::remove_dir_all(&d);
    }

    #[test]
    fn stale_by_dead_pid_and_takeover() {
        let d = tmp("deadpid");
        let t = now();
        let (pid, st) = dead_pid();
        // plant a claim whose process is gone
        let c = Claim { run: "p/r".into(), holder: "agent-a".into(), pid: Some(pid), start_time: st, created: t, heartbeat: t };
        write_file(&file_for(&d, "p/r").unwrap(), &c).unwrap();
        assert!(is_stale(&c, t));
        assert!(live_holder(&d, "p/r", t).is_none());
        let (n, o) = claim(&d, "p/r", "agent-b", Some(me()), t).unwrap();
        assert_eq!(o, Outcome::TookOver { from: c });
        assert_eq!(n.holder, "agent-b");
        assert!(!is_stale(&n, t));
        let _ = fs::remove_dir_all(&d);
    }

    #[test]
    fn stale_by_recycled_pid_incarnation() {
        let t = now();
        let st = procinfo::start_time(me());
        let mut c = Claim { run: "p/r".into(), holder: "a".into(), pid: Some(me()), start_time: st, created: t, heartbeat: t };
        assert!(!is_stale(&c, t));
        if let Some(s) = st {
            c.start_time = Some(s + 1_000_000); // the pid is alive, but it is a different process
            assert!(is_stale(&c, t));
        }
    }

    #[test]
    fn stale_by_ttl_and_pidless_claims() {
        let d = tmp("ttl");
        let t = now();
        claim(&d, "p/r", "agent-a", None, t).unwrap();
        assert!(live_holder(&d, "p/r", t + TTL_SECS).is_some(), "exactly at the TTL is still live");
        assert!(live_holder(&d, "p/r", t + TTL_SECS + 1).is_none());
        // heartbeat resets the clock
        heartbeat(&d, "p/r", "agent-a", t + 100).unwrap();
        assert!(live_holder(&d, "p/r", t + TTL_SECS + 50).is_some());
        // takeover after TTL
        let (_, o) = claim(&d, "p/r", "agent-b", None, t + 100 + TTL_SECS + 1).unwrap();
        assert!(matches!(o, Outcome::TookOver { .. }));
        // a stale claim can be released by anyone
        assert!(release(&d, "p/r", Some("zzz"), t + 100 + 2 * TTL_SECS + 5).unwrap().is_some());
        let _ = fs::remove_dir_all(&d);
    }

    #[test]
    fn refuses_dead_pid_bad_names_and_unreadable_files() {
        let d = tmp("bad");
        let t = now();
        let (pid, _) = dead_pid();
        assert!(claim(&d, "p/r", "agent-a", Some(pid), t).is_err());
        assert!(claim(&d, "p/r", "Bad Name", None, t).is_err());
        assert!(claim(&d, "p/r", "", None, t).is_err());
        assert!(claim(&d, "../x/y", "a", None, t).is_err());
        assert!(claim(&d, "norun", "a", None, t).is_err());
        assert_eq!(sanitize_holder("Claude Code (v2)"), "claude-code-v2");
        assert_eq!(sanitize_holder("???"), "agent");
        claim(&d, "p/r", "a", None, t).unwrap();
        fs::write(file_for(&d, "p/r").unwrap(), "{broken").unwrap();
        assert_eq!(live_holder(&d, "p/r", t).as_deref(), Some("(unreadable claim file)"));
        assert_eq!(list(&d, t)[0].holder, "(unreadable)");
        assert!(release(&d, "p/r", Some("a"), t).is_err());
        assert!(release(&d, "p/r", None, t).unwrap().is_some());
        let _ = fs::remove_dir_all(&d);
    }
}
