//! Writer claims (slice 7): which agent or person is editing a worktree right now.
//! One row per run in the `claims` table; every read-check-write is one transaction.
//! A claim is stale when its pid is gone (start time checked, so a recycled pid does not count)
//! or its heartbeat is older than `TTL`. A stale claim may be taken over by another holder.
#![allow(dead_code)]

use crate::procinfo;
use anyhow::{anyhow, bail, Result};
use serde::{Deserialize, Serialize};
use crate::db::Db;
use rusqlite::{params, Connection, OptionalExtension};
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

/// `project/run`, each part a plain name.
fn validate_run(run: &str) -> Result<()> {
    let (project, name) = run.split_once('/').ok_or_else(|| anyhow!("claim run {run:?} must be project/run"))?;
    for part in [project, name] {
        if part.is_empty() || part.contains('/') || part.contains('\0') || part == "." || part == ".." || part.starts_with('.') {
            bail!("claim run {run:?} has an invalid component");
        }
    }
    Ok(())
}

fn row(r: &rusqlite::Row) -> rusqlite::Result<Claim> {
    Ok(Claim {
        run: r.get(0)?,
        holder: r.get(1)?,
        pid: r.get::<_, Option<i64>>(2)?.map(|p| p as i32),
        start_time: r.get::<_, Option<i64>>(3)?.map(|t| t as u64),
        created: r.get::<_, i64>(4)? as u64,
        heartbeat: r.get::<_, i64>(5)? as u64,
    })
}

const COLS: &str = "run_key, holder, pid, pid_start, since, heartbeat";

fn read_tx(conn: &Connection, run: &str) -> Result<Option<Claim>> {
    Ok(conn.query_row(&format!("SELECT {COLS} FROM claims WHERE run_key = ?1"), [run], row).optional()?)
}

/// Insert or replace a claim row.
pub fn put_tx(conn: &Connection, c: &Claim) -> Result<()> {
    conn.execute(
        "INSERT OR REPLACE INTO claims (run_key, holder, pid, pid_start, since, heartbeat) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        params![c.run, c.holder, c.pid.map(i64::from), c.start_time.map(|t| t as i64), c.created as i64, c.heartbeat as i64],
    )?;
    Ok(())
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

pub fn get(db: &Db, run: &str) -> Result<Option<Claim>> {
    validate_run(run)?;
    db.with(|c| read_tx(c, run))
}

/// The holder of a live (not stale) claim. A claim that cannot be read counts as live: unknown means keep.
pub fn live_holder(db: &Db, run: &str, now: u64) -> Option<String> {
    match get(db, run) {
        Ok(None) => None,
        Ok(Some(c)) => (!is_stale(&c, now)).then_some(c.holder),
        Err(_) => Some("(unreadable claim)".into()),
    }
}

/// Claim `run` for `holder`. The same holder refreshes its own claim; a stale claim of another
/// holder is taken over; a live claim of another holder is refused.
pub fn claim(db: &Db, run: &str, holder: &str, pid: Option<i32>, now: u64) -> Result<(Claim, Outcome)> {
    validate_holder(holder)?;
    validate_run(run)?;
    let start_time = match pid {
        Some(p) => {
            if !procinfo::alive(p) {
                bail!("pid {p} is not running; a claim needs a live holder process");
            }
            procinfo::start_time(p)
        }
        None => None,
    };
    db.tx(|tx| {
        let existing = read_tx(tx, run)?;
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
        put_tx(tx, &c)?;
        Ok((c, outcome))
    })
}

/// Refresh the heartbeat. Only the holder, and only while the claim is not stale.
pub fn heartbeat(db: &Db, run: &str, holder: &str, now: u64) -> Result<Claim> {
    validate_run(run)?;
    db.tx(|tx| {
        let mut c = read_tx(tx, run)?.ok_or_else(|| anyhow!("{run} has no claim"))?;
        if c.holder != holder {
            bail!("{run} is claimed by {}, not {holder}", c.holder);
        }
        if is_stale(&c, now) {
            bail!("the claim on {run} went stale; claim it again");
        }
        c.heartbeat = now;
        put_tx(tx, &c)?;
        Ok(c)
    })
}

/// Remove a claim. `holder = Some(h)` must match unless the claim is stale; `None` is an
/// administrator (CLI or app) releasing whatever is there. Returns the removed claim.
pub fn release(db: &Db, run: &str, holder: Option<&str>, now: u64) -> Result<Option<Claim>> {
    validate_run(run)?;
    db.tx(|tx| {
        let Some(c) = read_tx(tx, run)? else { return Ok(None) };
        if let Some(h) = holder {
            if c.holder != h && !is_stale(&c, now) {
                bail!("{run} is claimed by {}, not {h}; only the holder (or the user, from the CLI) can release it", c.holder);
            }
        }
        tx.execute("DELETE FROM claims WHERE run_key = ?1", [run])?;
        Ok(Some(c))
    })
}

/// Every claim, stale ones included (callers mark them with `is_stale`).
pub fn list(db: &Db) -> Vec<Claim> {
    db.with(|c| {
        let mut q = c.prepare(&format!("SELECT {COLS} FROM claims ORDER BY run_key"))?;
        let rows = q.query_map([], row)?.collect::<std::result::Result<Vec<_>, _>>()?;
        Ok(rows)
    })
    .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::tests::temp_db;

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
        let (d, dir) = temp_db("claims-basic");
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
        assert_eq!(list(&d).len(), 1);
        // a live claim of another holder is refused, and so is releasing it as that holder
        assert!(claim(&d, "p/r", "agent-b", None, t + 10).unwrap_err().to_string().contains("claimed by agent-a"));
        assert!(release(&d, "p/r", Some("agent-b"), t + 10).is_err());
        assert!(release(&d, "p/r", Some("agent-a"), t + 10).unwrap().is_some());
        assert!(release(&d, "p/r", Some("agent-a"), t + 10).unwrap().is_none());
        assert!(live_holder(&d, "p/r", t + 10).is_none());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn stale_by_dead_pid_and_takeover() {
        let (d, dir) = temp_db("claims-deadpid");
        let t = now();
        let (pid, st) = dead_pid();
        // plant a claim whose process is gone
        let c = Claim { run: "p/r".into(), holder: "agent-a".into(), pid: Some(pid), start_time: st, created: t, heartbeat: t };
        d.with(|conn| put_tx(conn, &c)).unwrap();
        assert!(is_stale(&c, t));
        assert!(live_holder(&d, "p/r", t).is_none());
        let (n, o) = claim(&d, "p/r", "agent-b", Some(me()), t).unwrap();
        assert_eq!(o, Outcome::TookOver { from: c });
        assert_eq!(n.holder, "agent-b");
        assert!(!is_stale(&n, t));
        let _ = std::fs::remove_dir_all(&dir);
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
        let (d, dir) = temp_db("claims-ttl");
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
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn refuses_dead_pid_and_bad_names() {
        let (d, dir) = temp_db("claims-bad");
        let t = now();
        let (pid, _) = dead_pid();
        assert!(claim(&d, "p/r", "agent-a", Some(pid), t).is_err());
        assert!(claim(&d, "p/r", "Bad Name", None, t).is_err());
        assert!(claim(&d, "p/r", "", None, t).is_err());
        assert!(claim(&d, "../x/y", "a", None, t).is_err());
        assert!(claim(&d, "norun", "a", None, t).is_err());
        assert_eq!(sanitize_holder("Claude Code (v2)"), "claude-code-v2");
        assert_eq!(sanitize_holder("???"), "agent");
        assert!(list(&d).is_empty(), "refusals stored nothing");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn concurrent_claims_have_exactly_one_winner() {
        let (d, dir) = temp_db("claims-race");
        drop(d);
        let path = dir.join("setu.db");
        let t = now();
        let wins: usize = std::thread::scope(|sc| {
            let hs: Vec<_> = (0..8)
                .map(|i| {
                    let path = path.clone();
                    sc.spawn(move || claim(&Db::open(&path).unwrap(), "p/r", &format!("agent-{i}"), None, t).is_ok())
                })
                .collect();
            hs.into_iter().map(|h| h.join().unwrap()).filter(|w| *w).count()
        });
        assert_eq!(wins, 1, "check and write are one transaction");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
