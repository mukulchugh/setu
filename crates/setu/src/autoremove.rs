//! Robust auto-removal (slice 7, part 2). Plan: docs/slices/07-worktrees.md, "Auto-removal".
//!
//! The one rule that shapes everything here (V1-REVIEW D1): **unknown means keep**. A worktree's
//! idle age comes only from Setu's own recorded event times (last start, last stop, last proxied
//! request). If none was ever recorded, or anything needed cannot be read, the worktree is not
//! eligible; an unknown age is never read as zero or as infinity. Worktrees Setu never ran are
//! never touched.
//!
//! Two phases: an eligible worktree first becomes a *candidate* (visible in `ls`), and is removed
//! only when it is still eligible after the grace period and not pinned. Any failing check
//! resets the candidate. Removal itself goes through `worktree::rm` (guards, archive, resumable).
//! Everything is blocking; the daemon calls it from the blocking pool.

use crate::config::parse_duration;
use crate::db::Db;
use crate::disk::human_secs;
use crate::globalcfg::AutoRemoveCfg;
use crate::model::{ProjectConfig, RunRecord, RunStatus, WorktreeCfg};
use crate::worktree::{self, git, ExecError, FactCtx};
use anyhow::{bail, Context, Result};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::Duration;

/// Archives older than this are deleted by the sweep.
pub const ARCHIVE_KEEP_SECS: u64 = 30 * 86_400;
const GH_TIMEOUT: Duration = Duration::from_secs(30);
const GIT_QUICK: Duration = Duration::from_secs(30);

// ---------------------------------------------------------------- policy

#[derive(Debug, Clone)]
pub struct Policy {
    pub merged_after: u64,
    pub idle_after: u64,
    pub grace: u64,
    pub daily_cap: u32,
}

impl Policy {
    pub fn from_cfg(c: &AutoRemoveCfg) -> Result<Policy> {
        let d = |what: &str, s: &str| parse_duration(s).map(|d| d.as_secs()).with_context(|| format!("[auto_remove] {what}"));
        Ok(Policy { merged_after: d("merged_after", &c.merged_after)?, idle_after: d("idle_after", &c.idle_after)?, grace: d("grace", &c.grace)?, daily_cap: c.daily_cap })
    }
}

// ---------------------------------------------------------------- idle age

/// Setu's own event times for a run, unix seconds. Nothing else counts (never mtimes).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct Events {
    pub started: Option<u64>,
    pub stopped: Option<u64>,
    pub request: Option<u64>,
}

impl Events {
    pub fn from_record(r: &RunRecord) -> Events {
        Events { started: r.last_started_at, stopped: r.stopped_at, request: r.last_request_at }
    }
    pub fn last(&self) -> Option<u64> {
        [self.started, self.stopped, self.request].into_iter().flatten().max()
    }
}

/// Seconds since the latest recorded event. `None` when no event was ever recorded: unknown, never zero.
pub fn idle_age(ev: &Events, now: u64) -> Option<u64> {
    ev.last().map(|t| now.saturating_sub(t))
}

// ---------------------------------------------------------------- persisted state

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Candidate {
    pub since: u64,
    pub reason: String,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct Removals {
    /// Local day, `YYYY-MM-DD`.
    pub day: String,
    pub count: u32,
}

/// The `autoremove` table.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct AutoState {
    pub candidates: BTreeMap<String, Candidate>,
    pub removals: Removals,
    /// Last audited skip reason per run, so an unchanged skip is not logged every hour.
    pub skips: BTreeMap<String, String>,
}

/// Candidates, last audited skips and the daily counter, from the `autoremove` table.
pub fn load_state(db: &Db) -> Result<AutoState> {
    db.with(|c| {
        let mut st = AutoState::default();
        let mut q = c.prepare("SELECT kind, key, since, reason, day, count FROM autoremove")?;
        let rows = q.query_map([], |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, Option<i64>>(2)?, r.get::<_, Option<String>>(3)?, r.get::<_, Option<String>>(4)?, r.get::<_, Option<i64>>(5)?))
        })?;
        for row in rows {
            let (kind, key, since, reason, day, count) = row?;
            match kind.as_str() {
                "candidate" => {
                    st.candidates.insert(key, Candidate { since: since.unwrap_or(0) as u64, reason: reason.unwrap_or_default() });
                }
                "skip" => {
                    st.skips.insert(key, reason.unwrap_or_default());
                }
                _ => st.removals = Removals { day: day.unwrap_or_default(), count: count.unwrap_or(0) as u32 },
            }
        }
        Ok(st)
    })
}

/// Replace the whole persisted state in one transaction.
pub fn save_tx(tx: &rusqlite::Transaction, st: &AutoState) -> Result<()> {
    tx.execute("DELETE FROM autoremove", [])?;
    for (k, c) in &st.candidates {
        tx.execute("INSERT INTO autoremove (kind, key, since, reason) VALUES ('candidate', ?1, ?2, ?3)", rusqlite::params![k, c.since as i64, c.reason])?;
    }
    for (k, r) in &st.skips {
        tx.execute("INSERT INTO autoremove (kind, key, reason) VALUES ('skip', ?1, ?2)", rusqlite::params![k, r])?;
    }
    tx.execute("INSERT INTO autoremove (kind, key, day, count) VALUES ('removals', '', ?1, ?2)", rusqlite::params![st.removals.day, st.removals.count as i64])?;
    Ok(())
}

pub fn save_state(db: &Db, st: &AutoState) -> Result<()> {
    db.tx(|tx| save_tx(tx, st))
}

/// Local calendar day for the daily cap.
pub fn local_day(now: u64) -> String {
    let t = now as libc::time_t;
    // SAFETY: localtime_r writes into our zeroed tm and reads t; no shared state.
    let tm = unsafe {
        let mut tm: libc::tm = std::mem::zeroed();
        if libc::localtime_r(&t, &mut tm).is_null() {
            return format!("utc-day-{}", now / 86_400);
        }
        tm
    };
    format!("{:04}-{:02}-{:02}", tm.tm_year + 1900, tm.tm_mon + 1, tm.tm_mday)
}

// ---------------------------------------------------------------- inputs

/// One registered run the sweep may consider. Built only from runs Setu has a record of.
#[derive(Debug, Clone)]
pub struct Item {
    pub key: String,
    pub run: String,
    pub worktree: PathBuf,
    pub repo: PathBuf,
    pub main_dir: PathBuf,
    pub wt_cfg: WorktreeCfg,
    pub pinned: bool,
    pub events: Events,
    /// Holder of a live claim (an unreadable claim file counts as live).
    pub claim: Option<String>,
    /// Some(status) when the run is not stopped.
    pub running: Option<String>,
}

/// Build the items from Setu's records. A worktree with no run record is not here at all.
pub fn items_from(cfgs: &[ProjectConfig], runs: &BTreeMap<String, RunRecord>, claim: impl Fn(&str) -> Option<String>) -> Vec<Item> {
    let mut out = Vec::new();
    for (key, r) in runs {
        let Some(cfg) = cfgs.iter().find(|c| c.project == r.spec.id.project) else { continue };
        let running = match r.status {
            RunStatus::Running | RunStatus::Starting | RunStatus::Stopping => Some(format!("{:?}", r.status).to_lowercase()),
            _ => None,
        };
        out.push(Item {
            key: key.clone(),
            run: r.spec.id.run.clone(),
            worktree: r.spec.worktree.clone(),
            repo: cfg.repo.clone(),
            main_dir: worktree::main_dir(cfg),
            wt_cfg: cfg.worktree.clone(),
            pinned: r.pinned,
            events: Events::from_record(r),
            claim: claim(key),
            running,
        });
    }
    out
}

/// What the sweep needs from the outside world. Tests inject fakes.
pub struct Deps<'a> {
    pub now: u64,
    /// Local day for `now` (a parameter so tests control the cap's day).
    pub day: String,
    /// `gh pr view <branch> --json state,mergedAt,headRefOid`, run in the main worktree. Err = any failure.
    pub gh: &'a dyn Fn(&Path, &str) -> std::result::Result<String, String>,
    pub audit: &'a dyn Fn(&str, &str, Value),
    /// Remove through the persisted `worktree::rm` path.
    pub remove: &'a dyn Fn(&Item) -> Result<()>,
    /// Persist state (called after every removal, so the cap survives a crash).
    pub save: &'a dyn Fn(&AutoState) -> Result<()>,
    /// Decide and report only: no removals, no audit, no saves.
    pub dry_run: bool,
}

/// Real `gh`, with the login PATH the daemon would give procs. Any failure is an `Err`.
pub fn real_gh(main: &Path, branch: &str) -> std::result::Result<String, String> {
    if branch.starts_with('-') {
        return Err("refusing a branch name that starts with '-'".into());
    }
    let mut c = Command::new("gh");
    c.current_dir(main).args(["pr", "view", branch, "--json", "state,mergedAt,headRefOid"]).env("GH_PROMPT_DISABLED", "1").env("GH_NO_UPDATE_NOTIFIER", "1");
    if let Some(p) = crate::globalcfg::login_path() {
        c.env("PATH", p);
    }
    worktree::exec(c, GH_TIMEOUT).map(|o| o.text()).map_err(|e| e.to_string())
}

// ---------------------------------------------------------------- evaluation

#[derive(Debug, Clone, PartialEq)]
pub enum Verdict {
    Eligible(String),
    /// Keep it. `quiet` skips are the ordinary "not old enough / not merged" case and are not audited.
    Skip { reason: String, quiet: bool },
}

fn skip(reason: impl Into<String>, quiet: bool) -> Verdict {
    Verdict::Skip { reason: reason.into(), quiet }
}

/// Is the PR for this branch merged, by `gh`? Requires `state == MERGED`, a `mergedAt`, and the
/// PR head equal to the local HEAD (so commits added after the merge are not mistaken for it).
fn gh_says_merged(out: &str, local_head: &str) -> bool {
    let Ok(v) = serde_json::from_str::<Value>(out) else { return false };
    v["state"].as_str() == Some("MERGED") && v["mergedAt"].as_str().is_some_and(|s| !s.is_empty()) && v["headRefOid"].as_str() == Some(local_head)
}

/// "ancestor" or "pull request" when proven merged. Every failure, timeout or doubt is `None`.
fn merged_how(it: &Item, fetch_ok: bool, d: &Deps) -> Option<&'static str> {
    let head = git(&it.worktree, &["rev-parse", "HEAD"], GIT_QUICK).ok().map(|o| o.text().trim().to_string()).filter(|h| !h.is_empty())?;
    let branch = match git(&it.worktree, &["symbolic-ref", "--short", "-q", "HEAD"], GIT_QUICK) {
        Ok(o) => o.text().trim().to_string(),
        Err(ExecError::Failed { .. }) | Err(ExecError::Unknown(_)) => return None,
    };
    if branch.is_empty() {
        return None;
    }
    // Ancestry alone also matches a fresh, untouched branch cut from base. It only proves a
    // merge when the branch was pushed (origin/<branch> exists); otherwise the idle rule applies.
    let pushed = matches!(
        git(&it.worktree, &["rev-parse", "--verify", "-q", &format!("refs/remotes/origin/{branch}")], GIT_QUICK),
        Ok(_)
    );
    if fetch_ok && pushed {
        if let Ok(base) = worktree::resolve_base(&it.repo, &it.wt_cfg, None) {
            if matches!(git(&it.worktree, &["merge-base", "--is-ancestor", &head, &base], GIT_QUICK), Ok(_)) {
                return Some("ancestor");
            }
        }
    }
    match (d.gh)(&it.main_dir, &branch) {
        Ok(out) if gh_says_merged(&out, &head) => Some("pull request"),
        _ => None,
    }
}

/// Decide whether `it` is eligible right now. Blocking (fetches, runs git and gh).
pub fn evaluate(it: &Item, p: &Policy, d: &Deps) -> Verdict {
    if it.pinned {
        return skip("pinned", false);
    }
    if it.run == "main" || it.worktree == it.main_dir {
        return skip("the main worktree is never removed", true);
    }
    if !it.worktree.is_dir() {
        return skip("the worktree directory is missing", false);
    }
    if let Some(st) = &it.running {
        return skip(format!("the run is {st}"), true);
    }
    let Some(age) = idle_age(&it.events, d.now) else {
        return skip("unknown idle age: Setu has no recorded start, stop or request time for this run", false);
    };
    if age < p.merged_after.min(p.idle_after) {
        return skip(format!("idle {} is below the thresholds", human_secs(age)), true);
    }
    let facts = worktree::collect_facts(&it.worktree, FactCtx { is_main: false, claim: it.claim.clone(), running: it.running.clone(), force: false, skip_procs: false });
    let fetch_ok = matches!(facts.fetch, worktree::Fact::Known(()));
    let reasons = worktree::guards(&facts);
    if !reasons.is_empty() {
        let list: Vec<String> = reasons.iter().map(|r| format!("[{}] {}", r.code, r.message)).collect();
        return skip(list.join("; "), false);
    }
    if age >= p.merged_after {
        if let Some(how) = merged_how(it, fetch_ok, d) {
            return Verdict::Eligible(format!("merged ({how}), idle {}", human_secs(age)));
        }
    }
    if age >= p.idle_after {
        return Verdict::Eligible(format!("idle {}", human_secs(age)));
    }
    skip(format!("not proven merged and idle {} is below idle_after", human_secs(age)), true)
}

// ---------------------------------------------------------------- the sweep

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Decision {
    pub run: String,
    /// candidate-added, candidate-kept, candidate-cleared, would-remove, removed, remove-failed, skipped
    pub action: &'static str,
    pub reason: String,
}

fn dec(run: &str, action: &'static str, reason: impl Into<String>) -> Decision {
    Decision { run: run.to_string(), action, reason: reason.into() }
}

/// One evaluation of every item. Mutates `st` (the caller persists it unless dry-run).
pub fn sweep(items: &[Item], p: &Policy, st: &mut AutoState, d: &Deps) -> Vec<Decision> {
    let mut out = Vec::new();
    let audit = |op: &str, run: &str, extra: Value| {
        if !d.dry_run {
            (d.audit)(op, run, extra);
        }
    };
    if st.removals.day != d.day {
        st.removals = Removals { day: d.day.clone(), count: 0 };
    }
    let present: BTreeSet<&str> = items.iter().map(|i| i.key.as_str()).collect();
    let gone: Vec<String> = st.candidates.keys().filter(|k| !present.contains(k.as_str())).cloned().collect();
    for k in gone {
        st.candidates.remove(&k);
        st.skips.remove(&k);
        audit("autoremove-cleared", &k, json!({ "reason": "no longer a registered run" }));
        out.push(dec(&k, "candidate-cleared", "no longer a registered run"));
    }
    let mut save_failed = false;
    for it in items {
        match evaluate(it, p, d) {
            Verdict::Eligible(reason) => {
                st.skips.remove(&it.key);
                let Some(c) = st.candidates.get(&it.key).cloned() else {
                    st.candidates.insert(it.key.clone(), Candidate { since: d.now, reason: reason.clone() });
                    audit("autoremove-candidate", &it.key, json!({ "reason": reason, "removes_after": d.now + p.grace }));
                    out.push(dec(&it.key, "candidate-added", format!("{reason}; removal after {}", human_secs(p.grace))));
                    continue;
                };
                let waited = d.now.saturating_sub(c.since);
                if waited < p.grace {
                    out.push(dec(&it.key, "candidate-kept", format!("{reason}; {} of grace left", human_secs(p.grace - waited))));
                } else if st.removals.count >= p.daily_cap {
                    out.push(dec(&it.key, "skipped", format!("daily cap of {} removals reached; kept as a candidate", p.daily_cap)));
                } else if d.dry_run {
                    out.push(dec(&it.key, "would-remove", reason));
                } else if save_failed {
                    out.push(dec(&it.key, "skipped", "could not save auto-remove state; removing nothing more this sweep"));
                } else {
                    st.candidates.remove(&it.key);
                    match (d.remove)(it) {
                        Ok(()) => {
                            st.removals.count += 1;
                            audit("autoremove-removed", &it.key, json!({ "reason": reason, "candidate_since": c.since }));
                            out.push(dec(&it.key, "removed", reason));
                            if (d.save)(st).is_err() {
                                save_failed = true;
                            }
                        }
                        Err(e) => {
                            audit("autoremove-failed", &it.key, json!({ "reason": reason, "error": format!("{e:#}") }));
                            out.push(dec(&it.key, "remove-failed", format!("{e:#}")));
                        }
                    }
                }
            }
            Verdict::Skip { reason, quiet } => {
                if st.candidates.remove(&it.key).is_some() {
                    audit("autoremove-cleared", &it.key, json!({ "reason": reason }));
                    out.push(dec(&it.key, "candidate-cleared", reason));
                } else if !quiet && st.skips.get(&it.key) != Some(&reason) {
                    st.skips.insert(it.key.clone(), reason.clone());
                    audit("autoremove-skipped", &it.key, json!({ "reason": reason }));
                    out.push(dec(&it.key, "skipped", reason));
                }
            }
        }
    }
    out
}

// ---------------------------------------------------------------- archive pruning

/// `20261111T120000Z` to unix seconds. None for anything that is not exactly that shape.
fn parse_compact_ts(ts: &str) -> Option<u64> {
    let b = ts.as_bytes();
    if b.len() != 16 || b[8] != b'T' || b[15] != b'Z' || !b.iter().enumerate().all(|(i, c)| i == 8 || i == 15 || c.is_ascii_digit()) {
        return None;
    }
    let n = |r: std::ops::Range<usize>| ts[r].parse::<i64>().ok();
    let (y, m, d, hh, mm, ss) = (n(0..4)?, n(4..6)?, n(6..8)?, n(9..11)?, n(11..13)?, n(13..15)?);
    if !(1..=12).contains(&m) || !(1..=31).contains(&d) || hh > 23 || mm > 59 || ss > 60 {
        return None;
    }
    // Howard Hinnant's days_from_civil.
    let y = if m <= 2 { y - 1 } else { y };
    let era = y.div_euclid(400);
    let yoe = y.rem_euclid(400);
    let doy = (153 * (if m > 2 { m - 3 } else { m + 9 }) + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = era * 146_097 + doe - 719_468;
    u64::try_from(days * 86_400 + hh * 3600 + mm * 60 + ss).ok()
}

/// Delete `<root>/<project>/<run>/<ts>.tar` regular files whose name-encoded timestamp is more
/// than 30 days old. Touches nothing else: other names, symlinks, deeper paths and unparseable
/// timestamps are left alone. Empty run and project directories are tidied with `remove_dir`
/// (which refuses non-empty ones). Returns the deleted files.
pub fn prune_archives(root: &Path, now: u64) -> Vec<PathBuf> {
    let mut gone = Vec::new();
    let subdirs = |p: &Path| -> Vec<PathBuf> {
        std::fs::read_dir(p)
            .map(|rd| rd.flatten().filter(|e| e.file_type().is_ok_and(|t| t.is_dir())).map(|e| e.path()).collect())
            .unwrap_or_default()
    };
    for project in subdirs(root) {
        for run in subdirs(&project) {
            let Ok(rd) = std::fs::read_dir(&run) else { continue };
            for e in rd.flatten() {
                let path = e.path();
                let name = e.file_name().to_string_lossy().into_owned();
                let Some(ts) = name.strip_suffix(".tar") else { continue };
                let Some(at) = parse_compact_ts(ts) else { continue };
                if !e.file_type().is_ok_and(|t| t.is_file()) || now.saturating_sub(at) <= ARCHIVE_KEEP_SECS {
                    continue;
                }
                if std::fs::remove_file(&path).is_ok() {
                    gone.push(path);
                }
            }
            let _ = std::fs::remove_dir(&run);
        }
        let _ = std::fs::remove_dir(&project);
    }
    gone
}

// ---------------------------------------------------------------- visibility

/// `{candidate_since, removes_after, reason}` for `ls`, or null. Only while auto-removal is on.
pub fn removal_json(st: &AutoState, key: &str, cfg: &AutoRemoveCfg, pinned: bool) -> Value {
    if !cfg.enabled || pinned {
        return Value::Null;
    }
    let (Some(c), Ok(p)) = (st.candidates.get(key), Policy::from_cfg(cfg)) else { return Value::Null };
    json!({ "candidate_since": c.since, "removes_after": c.since + p.grace, "reason": c.reason })
}

/// All current candidates (read-only; no fetch, no evaluation).
pub fn candidates_json(st: &AutoState, cfg: &AutoRemoveCfg) -> Result<Value> {
    let p = Policy::from_cfg(cfg)?;
    let list: Vec<Value> = st.candidates.iter().map(|(k, c)| json!({ "run": k, "candidate_since": c.since, "removes_after": c.since + p.grace, "reason": c.reason })).collect();
    Ok(json!({ "enabled": cfg.enabled, "candidates": list, "daily_cap": p.daily_cap, "removed_today": st.removals.count, "day": st.removals.day }))
}

/// Refuse nonsense up front.
pub fn check_cfg(cfg: &AutoRemoveCfg) -> Result<Policy> {
    let p = Policy::from_cfg(cfg)?;
    if p.daily_cap == 0 {
        bail!("[auto_remove] daily_cap is 0, so nothing could ever be removed");
    }
    Ok(p)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::worktree::tests::{fx, g, new_wt, Fx};
    use crate::worktree::{NewOutcome, RmCtx, RmHost};
    use std::cell::RefCell;
    use std::fs;
    use std::sync::Mutex;

    const T0: u64 = 1_800_000_000;
    const DAY: u64 = 86_400;

    fn policy() -> Policy {
        Policy { merged_after: DAY, idle_after: 14 * DAY, grace: 3600, daily_cap: 5 }
    }

    struct NoopHost;
    impl RmHost for NoopHost {
        fn stop(&self) -> Result<()> {
            Ok(())
        }
        fn claim_holder(&self) -> Option<String> {
            None
        }
        fn running(&self) -> Option<String> {
            None
        }
        fn drop_state(&self) -> Result<()> {
            Ok(())
        }
        fn release_lease(&self) -> Result<()> {
            Ok(())
        }
    }

    fn item(f: &Fx, o: &NewOutcome, stopped_ago: Option<u64>) -> Item {
        Item {
            key: format!("app/{}", o.run),
            run: o.run.clone(),
            worktree: o.path.clone(),
            repo: f.repo.clone(),
            main_dir: worktree::main_dir(&f.cfg),
            wt_cfg: f.cfg.worktree.clone(),
            pinned: false,
            events: Events { started: None, stopped: stopped_ago.map(|a| T0 - a), request: None },
            claim: None,
            running: None,
        }
    }

    /// Run one sweep with a fake clock; returns decisions and the audit lines.
    fn run(f: &Fx, items: &[Item], p: &Policy, st: &mut AutoState, now: u64, day: &str, gh: &dyn Fn(&Path, &str) -> std::result::Result<String, String>, dry: bool) -> (Vec<Decision>, Vec<(String, String)>) {
        let log = RefCell::new(Vec::new());
        let audit = |op: &str, run: &str, _x: Value| log.borrow_mut().push((op.to_string(), run.to_string()));
        let declared: Vec<String> = f.cfg.disk_items.iter().flat_map(|i| i.paths.clone()).collect();
        let remove = |it: &Item| -> Result<()> {
            worktree::rm(&RmCtx { project: "app", run: &it.run, worktree: &it.worktree, repo: &f.repo, declared: &declared, archive_root: &f.archives, db: &f.ops, force: false, host: &NoopHost }).map(|_| ())
        };
        let save = |_: &AutoState| -> Result<()> { Ok(()) };
        let d = Deps { now, day: day.into(), gh, audit: &audit, remove: &remove, save: &save, dry_run: dry };
        let out = sweep(items, p, st, &d);
        (out, log.into_inner())
    }

    fn no_gh(_: &Path, _: &str) -> std::result::Result<String, String> {
        Err("gh is not installed".into())
    }

    /// Commit + push a branch commit from its worktree; returns the commit sha.
    fn push_commit(o: &NewOutcome, file: &str) -> String {
        fs::write(o.path.join(file), "x\n").unwrap();
        g(&o.path, &["add", file]);
        g(&o.path, &["commit", "-q", "-m", file]);
        g(&o.path, &["push", "-q", "origin", &format!("HEAD:refs/heads/{}", o.branch)]);
        g(&o.path, &["rev-parse", "HEAD"])
    }

    /// Fast-forward origin's main to `sha` (a plain merge of the pushed branch).
    fn merge_into_origin_main(f: &Fx, sha: &str) {
        g(&f.origin, &["update-ref", "refs/heads/main", sha]);
    }

    /// Put a different commit on origin's main (what a squash merge looks like to the branch).
    fn squash_into_origin_main(f: &Fx) {
        let other = f.root.join("other");
        g(&f.root, &["clone", "-q", "origin.git", "other"]);
        fs::write(other.join("squashed.txt"), "s\n").unwrap();
        g(&other, &["add", "."]);
        g(&other, &["commit", "-q", "-m", "squash"]);
        g(&other, &["push", "-q", "origin", "HEAD:main"]);
    }

    fn merged_json(head: &str) -> String {
        json!({ "state": "MERGED", "mergedAt": "2026-11-01T00:00:00Z", "headRefOid": head }).to_string()
    }

    // ---- D1

    #[test]
    fn unknown_age_is_never_eligible_and_never_zero() {
        assert_eq!(idle_age(&Events::default(), u64::MAX), None);
        assert_eq!(idle_age(&Events { started: Some(100), stopped: None, request: Some(300) }, 1000), Some(700));
        let f = fx("d1");
        let o = new_wt(&f, "feat/d1");
        let sha = push_commit(&o, "a.txt");
        merge_into_origin_main(&f, &sha);
        let it = item(&f, &o, None); // no recorded event at all
        // Even with absurd thresholds of zero, and a merged branch, it is kept.
        let p = Policy { merged_after: 0, idle_after: 0, grace: 0, daily_cap: 5 };
        let mut st = AutoState::default();
        for now in [0, T0, u64::MAX / 2] {
            let (dec, _) = run(&f, std::slice::from_ref(&it), &p, &mut st, now, "d", &no_gh, false);
            assert!(st.candidates.is_empty(), "{dec:?}");
            assert!(it.worktree.is_dir());
            assert!(dec.iter().all(|d| d.action == "skipped" && d.reason.contains("unknown idle age")), "{dec:?}");
        }
    }

    #[test]
    fn a_worktree_setu_never_ran_is_never_considered() {
        let f = fx("neverran");
        let o = new_wt(&f, "feat/never");
        assert!(o.path.is_dir());
        // No run record for it: the sweep's inputs simply do not include it.
        let items = items_from(std::slice::from_ref(&f.cfg), &BTreeMap::new(), |_| None);
        assert!(items.is_empty());
        let mut st = AutoState::default();
        let (dec, audit) = run(&f, &items, &policy(), &mut st, T0 + 400 * DAY, "d", &no_gh, false);
        assert!(dec.is_empty() && audit.is_empty() && st.candidates.is_empty());
        assert!(o.path.is_dir());
    }

    // ---- merged detection

    #[test]
    fn merged_branch_detected_by_ancestry() {
        let f = fx("anc");
        let o = new_wt(&f, "feat/anc");
        let sha = push_commit(&o, "a.txt");
        let it = item(&f, &o, Some(2 * DAY));
        let mut st = AutoState::default();
        // Not merged yet: ancestor false, gh unavailable, idle below idle_after.
        let (dec, _) = run(&f, std::slice::from_ref(&it), &policy(), &mut st, T0, "d", &no_gh, false);
        assert!(st.candidates.is_empty(), "{dec:?}");
        merge_into_origin_main(&f, &sha);
        let (dec, audit) = run(&f, std::slice::from_ref(&it), &policy(), &mut st, T0, "d", &no_gh, false);
        assert_eq!(dec[0].action, "candidate-added", "{dec:?}");
        assert!(dec[0].reason.contains("merged (ancestor)") && dec[0].reason.contains("idle 2d"), "{dec:?}");
        assert_eq!(audit, vec![("autoremove-candidate".to_string(), it.key.clone())]);
    }

    #[test]
    fn fresh_unpushed_branch_is_not_merged() {
        // A new worktree with no commits of its own is an ancestor of base, but was never
        // pushed: it must wait for the idle rule, not the short merged rule.
        let f = fx("fresh");
        let o = new_wt(&f, "feat/fresh");
        let it = item(&f, &o, Some(2 * DAY));
        let mut st = AutoState::default();
        let (dec, _) = run(&f, std::slice::from_ref(&it), &policy(), &mut st, T0, "d", &no_gh, false);
        assert!(st.candidates.is_empty(), "{dec:?}");
        assert!(dec.iter().all(|d| !d.reason.contains("merged")), "{dec:?}");
    }

    #[test]
    fn squash_merge_detected_only_through_gh_and_only_for_the_same_head() {
        let f = fx("squash");
        let o = new_wt(&f, "feat/sq");
        let sha = push_commit(&o, "a.txt");
        squash_into_origin_main(&f);
        let it = item(&f, &o, Some(2 * DAY));
        let mut st = AutoState::default();
        // gh unavailable: not merged.
        run(&f, std::slice::from_ref(&it), &policy(), &mut st, T0, "d", &no_gh, false);
        assert!(st.candidates.is_empty());
        // gh says merged, but for a different head (the branch moved after the merge): not merged.
        let stale = |_: &Path, _: &str| Ok(merged_json("deadbeef"));
        run(&f, std::slice::from_ref(&it), &policy(), &mut st, T0, "d", &stale, false);
        assert!(st.candidates.is_empty());
        // Open or unmerged PR: not merged.
        let open = |_: &Path, _: &str| Ok(json!({ "state": "OPEN", "mergedAt": null, "headRefOid": sha }).to_string());
        run(&f, std::slice::from_ref(&it), &policy(), &mut st, T0, "d", &open, false);
        assert!(st.candidates.is_empty());
        // Garbage output: not merged.
        let junk = |_: &Path, _: &str| Ok("not json".to_string());
        run(&f, std::slice::from_ref(&it), &policy(), &mut st, T0, "d", &junk, false);
        assert!(st.candidates.is_empty());
        // gh runs in the main worktree with the branch name.
        let seen = Mutex::new(None);
        let good = |dir: &Path, b: &str| {
            *seen.lock().unwrap() = Some((dir.to_path_buf(), b.to_string()));
            Ok(merged_json(&sha))
        };
        let (dec, _) = run(&f, std::slice::from_ref(&it), &policy(), &mut st, T0, "d", &good, false);
        assert_eq!(dec[0].action, "candidate-added", "{dec:?}");
        assert!(dec[0].reason.contains("merged (pull request)"));
        assert_eq!(seen.lock().unwrap().clone().unwrap(), (worktree::main_dir(&f.cfg), "feat/sq".to_string()));
    }

    #[test]
    fn gh_failure_counts_as_not_merged() {
        let f = fx("ghfail");
        let o = new_wt(&f, "feat/gf");
        push_commit(&o, "a.txt");
        let it = item(&f, &o, Some(2 * DAY));
        let mut st = AutoState::default();
        let boom = |_: &Path, _: &str| Err("exit 1: no pull requests found".to_string());
        let (dec, _) = run(&f, std::slice::from_ref(&it), &policy(), &mut st, T0, "d", &boom, false);
        assert!(st.candidates.is_empty() && dec.is_empty(), "{dec:?}");
    }

    #[test]
    fn fetch_failure_means_skip_even_when_gh_says_merged() {
        let f = fx("fetchfail");
        let o = new_wt(&f, "feat/ff");
        let sha = push_commit(&o, "a.txt");
        merge_into_origin_main(&f, &sha);
        let it = item(&f, &o, Some(2 * DAY));
        // The remote disappears: every fetch fails.
        fs::rename(&f.origin, f.root.join("origin-gone.git")).unwrap();
        let mut st = AutoState::default();
        let ok = |_: &Path, _: &str| Ok(merged_json(&sha));
        let (dec, _) = run(&f, std::slice::from_ref(&it), &policy(), &mut st, T0, "d", &ok, false);
        assert!(st.candidates.is_empty(), "{dec:?}");
        assert_eq!(dec[0].action, "skipped");
        assert!(dec[0].reason.contains("[fetch]"), "{dec:?}");
    }

    // ---- idle threshold

    #[test]
    fn idle_threshold_makes_an_unmerged_branch_eligible() {
        let f = fx("idle");
        let o = new_wt(&f, "feat/idle");
        push_commit(&o, "a.txt");
        let mut st = AutoState::default();
        let it = item(&f, &o, Some(14 * DAY - 1));
        run(&f, std::slice::from_ref(&it), &policy(), &mut st, T0, "d", &no_gh, false);
        assert!(st.candidates.is_empty());
        let it = item(&f, &o, Some(14 * DAY));
        let (dec, _) = run(&f, std::slice::from_ref(&it), &policy(), &mut st, T0, "d", &no_gh, false);
        assert_eq!(dec[0].action, "candidate-added");
        assert!(dec[0].reason.starts_with("idle 14d"), "{dec:?}");
    }

    #[test]
    fn newest_event_wins() {
        let ev = Events { started: Some(10), stopped: Some(500), request: Some(200) };
        assert_eq!(idle_age(&ev, 600), Some(100));
        // A request after the stop still counts as activity.
        let ev = Events { started: Some(10), stopped: Some(500), request: Some(550) };
        assert_eq!(idle_age(&ev, 600), Some(50));
    }

    // ---- two phases

    #[test]
    fn candidate_first_then_removed_only_after_grace_with_archive() {
        let f = fx("grace");
        let o = new_wt(&f, "feat/gr");
        let sha = push_commit(&o, "a.txt");
        merge_into_origin_main(&f, &sha);
        fs::write(o.path.join(".env.local"), "SECRET=1\n").unwrap(); // ignored, irreplaceable
        let it = item(&f, &o, Some(2 * DAY));
        let p = policy();
        let mut st = AutoState::default();
        let (d1, _) = run(&f, std::slice::from_ref(&it), &p, &mut st, T0, "d", &no_gh, false);
        assert_eq!(d1[0].action, "candidate-added");
        assert!(o.path.is_dir());
        // Just before grace ends: kept, nothing removed.
        let (d2, _) = run(&f, std::slice::from_ref(&it), &p, &mut st, T0 + p.grace - 1, "d", &no_gh, false);
        assert_eq!(d2[0].action, "candidate-kept", "{d2:?}");
        assert!(o.path.is_dir());
        // Dry run at the deadline: reports, removes nothing, leaves state and audit alone.
        let before = st.clone();
        let (dd, au) = run(&f, std::slice::from_ref(&it), &p, &mut st, T0 + p.grace, "d", &no_gh, true);
        assert_eq!(dd[0].action, "would-remove");
        assert!(o.path.is_dir() && au.is_empty());
        assert_eq!(st, before);
        // At the deadline: removed through worktree::rm, archive written.
        let (d3, audit) = run(&f, std::slice::from_ref(&it), &p, &mut st, T0 + p.grace, "d", &no_gh, false);
        assert_eq!(d3[0].action, "removed", "{d3:?}");
        assert!(!o.path.exists());
        assert!(st.candidates.is_empty());
        assert_eq!(st.removals.count, 1);
        assert!(worktree::latest_archive(&f.archives, "app", &o.run).is_some());
        assert_eq!(audit, vec![("autoremove-removed".to_string(), it.key.clone())]);
        // The branch is kept.
        assert!(!g(&f.repo, &["rev-parse", "--verify", "refs/heads/feat/gr"]).is_empty());
    }

    fn merged_candidate(tag: &str, branch: &str) -> (Fx, NewOutcome, Item, AutoState) {
        let f = fx(tag);
        let o = new_wt(&f, branch);
        let sha = push_commit(&o, "a.txt");
        merge_into_origin_main(&f, &sha);
        let it = item(&f, &o, Some(2 * DAY));
        let mut st = AutoState::default();
        let (d, _) = run(&f, std::slice::from_ref(&it), &policy(), &mut st, T0, "d", &no_gh, false);
        assert_eq!(d[0].action, "candidate-added");
        (f, o, it, st)
    }

    #[test]
    fn pin_blocks_removal_and_resets_the_candidate() {
        let (f, o, mut it, mut st) = merged_candidate("pin", "feat/pin");
        it.pinned = true;
        let (d, audit) = run(&f, std::slice::from_ref(&it), &policy(), &mut st, T0 + 10 * DAY, "d", &no_gh, false);
        assert_eq!(d[0].action, "candidate-cleared");
        assert_eq!(d[0].reason, "pinned");
        assert!(o.path.is_dir() && st.candidates.is_empty());
        assert_eq!(audit[0].0, "autoremove-cleared");
        // Unpinned later: it starts over as a fresh candidate, not an overdue one.
        it.pinned = false;
        let now = T0 + 10 * DAY;
        let (d, _) = run(&f, std::slice::from_ref(&it), &policy(), &mut st, now, "d", &no_gh, false);
        assert_eq!(d[0].action, "candidate-added");
        assert!(o.path.is_dir());
    }

    #[test]
    fn a_dirty_tree_clears_candidacy() {
        let (f, o, it, mut st) = merged_candidate("dirty", "feat/dirty");
        fs::write(o.path.join("wip.txt"), "unsaved\n").unwrap();
        let (d, _) = run(&f, std::slice::from_ref(&it), &policy(), &mut st, T0 + 2 * 3600, "d", &no_gh, false);
        assert_eq!(d[0].action, "candidate-cleared", "{d:?}");
        assert!(d[0].reason.contains("[dirty]"));
        assert!(o.path.join("wip.txt").exists() && st.candidates.is_empty());
    }

    #[test]
    fn a_live_claim_clears_candidacy() {
        let (f, o, mut it, mut st) = merged_candidate("claim", "feat/claim");
        it.claim = Some("agent-7".into());
        let (d, _) = run(&f, std::slice::from_ref(&it), &policy(), &mut st, T0 + 2 * 3600, "d", &no_gh, false);
        assert_eq!(d[0].action, "candidate-cleared");
        assert!(d[0].reason.contains("[claim]"));
        assert!(o.path.is_dir());
    }

    #[test]
    fn a_process_inside_clears_candidacy() {
        let (f, o, it, mut st) = merged_candidate("proc", "feat/proc");
        let mut child = Command::new("sleep").arg("30").current_dir(&o.path).spawn().unwrap();
        let (d, _) = run(&f, std::slice::from_ref(&it), &policy(), &mut st, T0 + 2 * 3600, "d", &no_gh, false);
        let _ = child.kill();
        let _ = child.wait();
        assert_eq!(d[0].action, "candidate-cleared", "{d:?}");
        assert!(d[0].reason.contains("[processes]"));
        assert!(o.path.is_dir());
    }

    #[test]
    fn a_running_run_is_kept_quietly() {
        let (f, o, mut it, mut st) = merged_candidate("running", "feat/running");
        it.running = Some("running".into());
        let (d, _) = run(&f, std::slice::from_ref(&it), &policy(), &mut st, T0 + 2 * 3600, "d", &no_gh, false);
        assert_eq!(d[0].action, "candidate-cleared");
        assert!(o.path.is_dir());
    }

    #[test]
    fn main_is_never_a_candidate() {
        let f = fx("main");
        let mut it = item(&f, &new_wt(&f, "feat/m"), Some(100 * DAY));
        it.run = "main".into();
        it.worktree = worktree::main_dir(&f.cfg);
        it.key = "app/main".into();
        let mut st = AutoState::default();
        let (d, audit) = run(&f, std::slice::from_ref(&it), &policy(), &mut st, T0, "d", &no_gh, false);
        assert!(d.is_empty() && audit.is_empty() && st.candidates.is_empty());
    }

    // ---- daily cap

    #[test]
    fn daily_cap_limits_removals_per_local_day() {
        let f = fx("cap");
        let mut items = Vec::new();
        for b in ["feat/c1", "feat/c2"] {
            let o = new_wt(&f, b);
            let sha = push_commit(&o, &format!("{}.txt", o.run));
            merge_into_origin_main(&f, &sha);
            items.push(item(&f, &o, Some(2 * DAY)));
        }
        // The second branch's push is on top of the first's? No: each was cut from origin/main
        // at its own time, so make both reachable from main.
        let tip2 = g(&items[1].worktree, &["rev-parse", "HEAD"]);
        let tip1 = g(&items[0].worktree, &["rev-parse", "HEAD"]);
        let other = f.root.join("mrg");
        g(&f.root, &["clone", "-q", "origin.git", "mrg"]);
        g(&other, &["fetch", "-q", "origin"]);
        g(&other, &["merge", "-q", "--no-edit", &tip1]);
        g(&other, &["merge", "-q", "--no-edit", &tip2]);
        g(&other, &["push", "-q", "origin", "HEAD:main"]);
        let p = Policy { daily_cap: 1, ..policy() };
        let mut st = AutoState::default();
        run(&f, &items, &p, &mut st, T0, "2026-11-12", &no_gh, false);
        assert_eq!(st.candidates.len(), 2);
        let (d, _) = run(&f, &items, &p, &mut st, T0 + 3600, "2026-11-12", &no_gh, false);
        let acts: Vec<&str> = d.iter().map(|x| x.action).collect();
        assert_eq!(acts, vec!["removed", "skipped"], "{d:?}");
        assert!(d[1].reason.contains("daily cap"));
        assert!(!items[0].worktree.exists() && items[1].worktree.is_dir());
        assert_eq!(st.candidates.len(), 1);
        // Same day, later: still capped.
        let (d, _) = run(&f, &items[1..], &p, &mut st, T0 + 7200, "2026-11-12", &no_gh, false);
        assert_eq!(d[0].action, "skipped");
        // Next day: the counter resets and the candidate goes.
        let (d, _) = run(&f, &items[1..], &p, &mut st, T0 + DAY, "2026-11-13", &no_gh, false);
        assert_eq!(d[0].action, "removed", "{d:?}");
        assert_eq!(st.removals, Removals { day: "2026-11-13".into(), count: 1 });
    }

    #[test]
    fn candidates_for_vanished_runs_are_dropped() {
        let (f, _o, _it, mut st) = merged_candidate("gone", "feat/gone");
        let (d, audit) = run(&f, &[], &policy(), &mut st, T0 + 10, "d", &no_gh, false);
        assert_eq!(d[0].action, "candidate-cleared");
        assert!(st.candidates.is_empty());
        assert_eq!(audit[0].0, "autoremove-cleared");
    }

    // ---- state, config, archives

    #[test]
    fn state_roundtrips_and_save_replaces() {
        let (db, d) = crate::db::tests::temp_db("ar-state");
        assert_eq!(load_state(&db).unwrap(), AutoState::default());
        let mut st = AutoState::default();
        st.candidates.insert("a/b".into(), Candidate { since: 5, reason: "idle 14d".into() });
        st.skips.insert("a/c".into(), "pinned".into());
        st.removals = Removals { day: "2026-11-12".into(), count: 3 };
        save_state(&db, &st).unwrap();
        assert_eq!(load_state(&db).unwrap(), st);
        st.candidates.clear();
        save_state(&db, &st).unwrap();
        assert_eq!(load_state(&db).unwrap(), st);
        let _ = fs::remove_dir_all(&d);
    }

    #[test]
    fn config_defaults_and_parsing() {
        let c: crate::globalcfg::GlobalConfig = toml::from_str("proxy_port = 80\n").unwrap();
        assert!(!c.auto_remove.enabled);
        let p = Policy::from_cfg(&c.auto_remove).unwrap();
        assert_eq!((p.merged_after, p.idle_after, p.grace, p.daily_cap), (DAY, 14 * DAY, DAY, 5));
        let c: crate::globalcfg::GlobalConfig = toml::from_str("[auto_remove]\nenabled = true\ngrace = \"2s\"\ndaily_cap = 1\n").unwrap();
        assert!(c.auto_remove.enabled);
        assert_eq!(Policy::from_cfg(&c.auto_remove).unwrap().grace, 2);
        let bad = AutoRemoveCfg { idle_after: "soon".into(), ..Default::default() };
        assert!(Policy::from_cfg(&bad).is_err());
        assert!(check_cfg(&AutoRemoveCfg { daily_cap: 0, ..Default::default() }).is_err());
    }

    #[test]
    fn visibility_json() {
        let mut st = AutoState::default();
        st.candidates.insert("a/b".into(), Candidate { since: 1000, reason: "merged (ancestor), idle 2d".into() });
        let on = AutoRemoveCfg { enabled: true, ..Default::default() };
        let v = removal_json(&st, "a/b", &on, false);
        assert_eq!((v["candidate_since"].as_u64(), v["removes_after"].as_u64()), (Some(1000), Some(1000 + DAY)));
        assert_eq!(removal_json(&st, "a/b", &on, true), Value::Null);
        assert_eq!(removal_json(&st, "a/x", &on, false), Value::Null);
        assert_eq!(removal_json(&st, "a/b", &AutoRemoveCfg::default(), false), Value::Null);
        assert_eq!(candidates_json(&st, &on).unwrap()["candidates"].as_array().unwrap().len(), 1);
    }

    #[test]
    fn compact_timestamps_parse() {
        assert_eq!(parse_compact_ts("19700101T000000Z"), Some(0));
        assert_eq!(parse_compact_ts("20000301T010203Z"), Some(951_872_523));
        assert_eq!(parse_compact_ts("2026-11-11T12:00:00Z"), None);
        assert_eq!(parse_compact_ts("20261311T120000Z"), None);
        assert_eq!(parse_compact_ts("notes"), None);
        // agrees with the format the archive writer produces
        assert!(parse_compact_ts(&worktree::compact_ts()).is_some());
    }

    #[test]
    fn archive_pruning_touches_only_matching_old_files() {
        let root = std::env::temp_dir().join(format!("setu-ar-prune-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        let now = parse_compact_ts("20261112T000000Z").unwrap();
        let w = |rel: &str| {
            let p = root.join(rel);
            fs::create_dir_all(p.parent().unwrap()).unwrap();
            fs::write(&p, "x").unwrap();
            p
        };
        let old = w("app/feat-a/20261001T000000Z.tar"); // 42 days
        let edge = w("app/feat-a/20261013T000000Z.tar"); // exactly 30 days: kept
        let fresh = w("app/feat-a/20261110T000000Z.tar");
        let only_old = w("app/feat-b/20250101T000000Z.tar"); // its dir becomes empty
        let other_name = w("app/feat-a/notes.tar");
        let wrong_ext = w("app/feat-a/20250101T000000Z.txt");
        let hidden = w("app/feat-a/.20250101T000000Z.tar.tmp");
        let shallow = w("20250101T000000Z.tar"); // not under project/run
        let deep = w("app/feat-a/sub/20250101T000000Z.tar");
        let stray = w("app/README");
        let target = root.join("outside.txt");
        fs::write(&target, "keep").unwrap();
        std::os::unix::fs::symlink(&target, root.join("app/feat-a/20250101T000001Z.tar")).unwrap();
        let removed = prune_archives(&root, now);
        let mut names: Vec<String> = removed.iter().map(|p| p.strip_prefix(&root).unwrap().display().to_string()).collect();
        names.sort();
        assert_eq!(names, vec!["app/feat-a/20261001T000000Z.tar", "app/feat-b/20250101T000000Z.tar"]);
        assert!(!old.exists() && !only_old.exists());
        for kept in [&edge, &fresh, &other_name, &wrong_ext, &hidden, &shallow, &deep, &stray, &target] {
            assert!(kept.exists(), "{} must survive", kept.display());
        }
        assert!(root.join("app/feat-a/20250101T000001Z.tar").symlink_metadata().is_ok(), "symlinks are not followed or removed");
        assert!(!root.join("app/feat-b").exists(), "an emptied run dir is tidied");
        assert!(root.join("app/feat-a").is_dir());
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn items_come_only_from_run_records_with_their_event_times() {
        let f = fx("items");
        let o = new_wt(&f, "feat/it");
        let spec = crate::model::RunSpec {
            id: crate::model::RunId { project: "app".into(), run: o.run.clone() },
            worktree: o.path.clone(),
            host: "h".into(),
            url: "u".into(),
            ports: Default::default(),
            env: Default::default(),
            procs: vec![],
            web_port: None,
            idle: Duration::from_secs(1),
        };
        let rec = RunRecord { spec, status: RunStatus::Crashed, pinned: true, procs: vec![], note: None, stopped_at: Some(7), env_hash: None, last_started_at: Some(3), last_request_at: None };
        let mut runs = BTreeMap::new();
        runs.insert(format!("app/{}", o.run), rec);
        let items = items_from(std::slice::from_ref(&f.cfg), &runs, |k| (k.ends_with("it")).then(|| "me".to_string()));
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].events, Events { started: Some(3), stopped: Some(7), request: None });
        assert!(items[0].pinned && items[0].running.is_none());
        assert_eq!(items[0].claim.as_deref(), Some("me"));
    }
}
