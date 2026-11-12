//! Disk: report what declared items really cost, and clean regenerable ones safely.
//! Plan: docs/slices/02-disk.md. Every rule there is enforced here, and re-checked
//! immediately before each delete.

use crate::disk_measure::{self, Size};
use crate::model::{DiskItem, DiskKind, ProjectConfig, RunStatus};
use crate::presets;
use crate::procinfo;
use anyhow::{bail, Result};
use serde::Serialize;
use std::path::{Component, Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

/// What Setu knows about one worktree when judging its items.
#[derive(Debug, Clone)]
pub struct WorktreeInfo {
    pub project: String,
    pub run: String,
    pub worktree: PathBuf,
    /// None when Setu has never run this worktree.
    pub status: Option<RunStatus>,
    pub stopped_at: Option<u64>,
    /// Holder of a live writer claim (slice 7): destructive actions refuse while set.
    pub claimed_by: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct Candidate {
    pub run: String,
    pub item: String,
    pub kind: DiskKind,
    pub path: PathBuf,
    pub size: Option<Size>,
    /// Would `clean --apply` delete it now?
    pub eligible: bool,
    /// Why it is (not) eligible, in plain words.
    pub reason: String,
}

pub fn now_secs() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

/// Options for judging eligibility.
#[derive(Debug, Clone, Copy, Default)]
pub struct Policy {
    /// Allow worktrees Setu never ran (no recorded stop time). Unknown age is then
    /// accepted, but every other rule still applies.
    pub include_unmanaged: bool,
    /// Measure items (slow for large trees). Deps are measured only if `measure_deps`.
    pub measure: bool,
    pub measure_deps: bool,
}

/// All existing paths of every declared item in one worktree, with eligibility.
pub fn candidates(cfg: &ProjectConfig, wt: &WorktreeInfo, policy: Policy, now: u64) -> Vec<Candidate> {
    let live_reason = liveness(wt);
    let mut out = Vec::new();
    for item in &cfg.disk_items {
        for pattern in &item.paths {
            for path in presets::expand_paths(&wt.worktree, pattern) {
                let size = (policy.measure && (item.kind != DiskKind::Deps || policy.measure_deps))
                    .then(|| disk_measure::measure(&path));
                let verdict = match &live_reason {
                    Some(r) => Err(r.clone()),
                    None => judge(item, wt, &path, policy, now),
                };
                let (eligible, reason) = match verdict {
                    Ok(r) => (true, r),
                    Err(r) => (false, r),
                };
                out.push(Candidate {
                    run: format!("{}/{}", wt.project, wt.run),
                    item: item.name.clone(),
                    kind: item.kind,
                    path,
                    size,
                    eligible,
                    reason,
                });
            }
        }
    }
    out
}

/// Some(reason) when the worktree is in use: by Setu, or by any process whose cwd is inside it.
fn liveness(wt: &WorktreeInfo) -> Option<String> {
    if let Some(holder) = &wt.claimed_by {
        return Some(format!("a live writer claim is held by {holder}; release it first"));
    }
    if matches!(wt.status, Some(RunStatus::Running | RunStatus::Starting | RunStatus::Stopping)) {
        return Some("the run is up".into());
    }
    let pids = procinfo::pids_with_cwd_under(&wt.worktree);
    if !pids.is_empty() {
        return Some(format!("{} process(es) are working in this worktree (pid {})", pids.len(), pids[0]));
    }
    None
}

/// Age and policy rules; safety rules are checked separately in `check_safe`.
fn judge(item: &DiskItem, wt: &WorktreeInfo, path: &Path, policy: Policy, now: u64) -> std::result::Result<String, String> {
    let Some(after) = item.clean_after else {
        return Err(match item.kind {
            DiskKind::Deps => "dependencies are kept (no clean policy)".into(),
            _ => "no clean policy for this item".into(),
        });
    };
    match wt.stopped_at {
        Some(stopped) => {
            let idle = now.saturating_sub(stopped);
            if idle < after.as_secs() {
                return Err(format!("stopped {} ago; policy is {}", human_secs(idle), human_secs(after.as_secs())));
            }
        }
        None if policy.include_unmanaged => {}
        None => return Err("Setu has no record of when this run stopped".into()),
    }
    check_safe(&wt.worktree, path)?;
    Ok(match wt.stopped_at {
        Some(s) => format!("stopped {} ago (policy {})", human_secs(now.saturating_sub(s)), human_secs(after.as_secs())),
        None => "not run by Setu; included on request".into(),
    })
}

/// Path containment, no symlinks anywhere from the worktree root down, git-ignored,
/// and no tracked files underneath.
pub fn check_safe(worktree: &Path, path: &Path) -> std::result::Result<(), String> {
    let root = worktree.canonicalize().map_err(|e| format!("worktree unreadable: {e}"))?;
    let rel = path.strip_prefix(worktree).map_err(|_| "path is not under the worktree".to_string())?;
    if rel.as_os_str().is_empty() {
        return Err("refusing to clean the worktree root".into());
    }
    // Walk every component with lstat: a symlinked ancestor or target is refused.
    let mut cur = root.clone();
    for comp in rel.components() {
        match comp {
            Component::Normal(c) => cur.push(c),
            _ => return Err("path has an unexpected component".into()),
        }
        let meta = std::fs::symlink_metadata(&cur).map_err(|e| format!("{}: {e}", cur.display()))?;
        if meta.file_type().is_symlink() {
            return Err(format!("{} is a symlink; Setu never follows links when cleaning", cur.display()));
        }
    }
    let real = cur.canonicalize().map_err(|e| format!("{e}"))?;
    if !real.starts_with(&root) || real == root {
        return Err("path resolves outside the worktree".into());
    }
    let rel_s = rel.to_string_lossy().to_string();
    let ignored = std::process::Command::new("git")
        .arg("-C")
        .arg(&root)
        .args(["check-ignore", "-q", "--", &rel_s])
        .status()
        .map_err(|e| format!("git check-ignore failed: {e}"))?;
    if !ignored.success() {
        return Err("git does not ignore this path".into());
    }
    let tracked = std::process::Command::new("git")
        .arg("-C")
        .arg(&root)
        .args(["ls-files", "--", &rel_s])
        .output()
        .map_err(|e| format!("git ls-files failed: {e}"))?;
    if !tracked.status.success() {
        return Err("git ls-files failed".into());
    }
    if !tracked.stdout.is_empty() {
        return Err("git tracks files under this path".into());
    }
    Ok(())
}

/// Delete one candidate after re-checking liveness and safety. Returns the volume
/// free-space change in bytes (the ground truth), and appends to the audit log.
pub fn clean_one(cfg: &ProjectConfig, wt: &WorktreeInfo, path: &Path, policy: Policy) -> Result<i64> {
    if let Some(r) = liveness(wt) {
        bail!("{}: {r}", path.display());
    }
    let item = cfg
        .disk_items
        .iter()
        .find(|i| i.paths.iter().any(|p| presets::expand_paths(&wt.worktree, p).iter().any(|x| x == path)))
        .ok_or_else(|| anyhow::anyhow!("{} is not a declared item", path.display()))?;
    if let Err(r) = judge(item, wt, path, policy, now_secs()) {
        bail!("{}: {r}", path.display());
    }
    let estimate = disk_measure::measure(path).private;
    let before = free_bytes(&wt.worktree);
    // remove_dir_all removes symlinks as links and never follows them.
    let meta = std::fs::symlink_metadata(path)?;
    if meta.is_dir() {
        std::fs::remove_dir_all(path)?;
    } else {
        std::fs::remove_file(path)?;
    }
    let after = free_bytes(&wt.worktree);
    let freed = after as i64 - before as i64;
    crate::db::record(crate::db::Event {
        ts: now_secs(),
        actor: Some("system".into()),
        client: None,
        kind: "disk",
        op: "clean".into(),
        run_key: Some(format!("{}/{}", wt.project, wt.run)),
        scope: None,
        name: Some(item.name.clone()),
        detail: serde_json::json!({ "path": path, "estimate_bytes": estimate, "volume_free_delta_bytes": freed }),
    });
    Ok(freed)
}

/// Free bytes available to the user on the volume holding `path`.
pub fn free_bytes(path: &Path) -> u64 {
    use std::os::unix::ffi::OsStrExt;
    let Ok(c) = std::ffi::CString::new(path.as_os_str().as_bytes()) else { return 0 };
    // SAFETY: statfs on a valid C string into a zeroed struct.
    unsafe {
        let mut s: libc::statfs = std::mem::zeroed();
        if libc::statfs(c.as_ptr(), &mut s) == 0 {
            (s.f_bavail as u64).saturating_mul(s.f_bsize as u64)
        } else {
            0
        }
    }
}

pub fn human_secs(s: u64) -> String {
    match s {
        s if s >= 86_400 => format!("{}d", s / 86_400),
        s if s >= 3_600 => format!("{}h", s / 3_600),
        s if s >= 60 => format!("{}m", s / 60),
        s => format!("{s}s"),
    }
}

pub fn human_bytes(b: u64) -> String {
    const G: f64 = 1024.0 * 1024.0 * 1024.0;
    const M: f64 = 1024.0 * 1024.0;
    let b = b as f64;
    if b >= G {
        format!("{:.1} GiB", b / G)
    } else if b >= M {
        format!("{:.0} MiB", b / M)
    } else {
        format!("{:.0} KiB", b / 1024.0)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::Command;
    use std::time::Duration;

    fn git_repo() -> tempfile_lite::Dir {
        let d = tempfile_lite::Dir::new();
        let r = d.path();
        Command::new("git").arg("-C").arg(r).args(["init", "-q"]).status().unwrap();
        std::fs::write(r.join(".gitignore"), ".next/\nlinked/\nignored-but-tracked/\n").unwrap();
        std::fs::create_dir_all(r.join("src")).unwrap();
        std::fs::write(r.join("src/a.txt"), "tracked").unwrap();
        std::fs::create_dir_all(r.join("ignored-but-tracked")).unwrap();
        std::fs::write(r.join("ignored-but-tracked/f"), "x").unwrap();
        Command::new("git").arg("-C").arg(r).args(["add", "-A"]).status().unwrap();
        Command::new("git").arg("-C").arg(r).args(["add", "-f", "ignored-but-tracked/f"]).status().unwrap();
        std::fs::create_dir_all(r.join(".next/dev/cache")).unwrap();
        std::fs::write(r.join(".next/dev/cache/blob"), vec![7u8; 4096]).unwrap();
        d
    }

    fn cfg(paths: &[&str], after: Option<Duration>) -> ProjectConfig {
        ProjectConfig {
            project: "p".into(),
            repo: "/nonexistent".into(),
            domain: "p.test".into(),
            idle: Duration::from_secs(60),
            max_running: 1,
            ports: vec![],
            env: Default::default(),
            procs: Default::default(),
            presets: vec![],
            disk_items: vec![DiskItem {
                name: "cache".into(),
                kind: DiskKind::Cache,
                paths: paths.iter().map(|s| s.to_string()).collect(),
                clean_after: after,
            }],
            stores: vec![],
            worktree: Default::default(),
            setup_steps: vec![],
        }
    }

    fn wt(dir: &Path, stopped_at: Option<u64>) -> WorktreeInfo {
        WorktreeInfo { project: "p".into(), run: "r".into(), worktree: dir.to_path_buf(), status: Some(RunStatus::Stopped), stopped_at, claimed_by: None }
    }

    #[test]
    fn live_claim_blocks_candidates_and_clean_one() {
        let d = git_repo();
        let c = cfg(&[".next/dev/cache"], Some(Duration::from_secs(60)));
        let mut w = wt(d.path(), Some(now_secs() - 120));
        w.claimed_by = Some("agent-a".into());
        let cands = candidates(&c, &w, Policy::default(), now_secs());
        assert!(cands.iter().all(|x| !x.eligible && x.reason.contains("claim is held by agent-a")), "{cands:?}");
        let target = d.path().join(".next/dev/cache");
        let err = clean_one(&c, &w, &target, Policy::default()).unwrap_err().to_string();
        assert!(err.contains("agent-a"), "{err}");
        assert!(target.exists());
    }

    #[test]
    fn eligible_after_policy_and_cleans() {
        let d = git_repo();
        let c = cfg(&[".next/dev/cache"], Some(Duration::from_secs(60)));
        let w = wt(d.path(), Some(now_secs() - 120));
        let cands = candidates(&c, &w, Policy::default(), now_secs());
        assert_eq!(cands.len(), 1);
        assert!(cands[0].eligible, "{}", cands[0].reason);
        clean_one(&c, &w, &cands[0].path, Policy::default()).unwrap();
        assert!(!d.path().join(".next/dev/cache").exists());
        assert!(d.path().join("src/a.txt").exists());
    }

    #[test]
    fn too_recent_or_unknown_age_is_kept() {
        let d = git_repo();
        let c = cfg(&[".next/dev/cache"], Some(Duration::from_secs(3600)));
        let recent = candidates(&c, &wt(d.path(), Some(now_secs() - 10)), Policy::default(), now_secs());
        assert!(!recent[0].eligible);
        let unknown = candidates(&c, &wt(d.path(), None), Policy::default(), now_secs());
        assert!(!unknown[0].eligible, "v1 D1: unknown age must never count as idle");
        let opted = candidates(&c, &wt(d.path(), None), Policy { include_unmanaged: true, ..Default::default() }, now_secs());
        assert!(opted[0].eligible, "{}", opted[0].reason);
    }

    #[test]
    fn symlinked_ancestor_is_refused() {
        let d = git_repo();
        let outside = tempfile_lite::Dir::new();
        std::fs::create_dir_all(outside.path().join(".next/dev/cache")).unwrap();
        std::os::unix::fs::symlink(outside.path(), d.path().join("linked")).unwrap();
        let err = check_safe(d.path(), &d.path().join("linked/.next/dev/cache")).unwrap_err();
        assert!(err.contains("symlink"), "{err}");
        assert!(outside.path().join(".next/dev/cache").exists());
    }

    #[test]
    fn tracked_or_unignored_is_refused() {
        let d = git_repo();
        assert!(check_safe(d.path(), &d.path().join("src")).unwrap_err().contains("ignore"));
        // git reports a tracked path as not ignored, so either refusal is correct.
        assert!(check_safe(d.path(), &d.path().join("ignored-but-tracked")).is_err());
    }

    #[test]
    fn live_process_in_worktree_blocks() {
        let d = git_repo();
        let mut child = Command::new("sleep").arg("30").current_dir(d.path()).spawn().unwrap();
        std::thread::sleep(Duration::from_millis(100));
        let c = cfg(&[".next/dev/cache"], Some(Duration::from_secs(1)));
        let cands = candidates(&c, &wt(d.path(), Some(now_secs() - 100)), Policy::default(), now_secs());
        let _ = child.kill();
        let _ = child.wait();
        assert!(!cands[0].eligible);
        assert!(cands[0].reason.contains("process"), "{}", cands[0].reason);
    }

    /// Minimal temp dir helper (no extra dependency).
    mod tempfile_lite {
        use std::path::{Path, PathBuf};
        pub struct Dir(PathBuf);
        impl Dir {
            pub fn new() -> Self {
                use std::sync::atomic::{AtomicU32, Ordering};
                static N: AtomicU32 = AtomicU32::new(0);
                let p = std::env::temp_dir().join(format!("setu-disk-{}-{}", std::process::id(), N.fetch_add(1, Ordering::SeqCst)));
                std::fs::create_dir_all(&p).unwrap();
                Dir(p.canonicalize().unwrap())
            }
            pub fn path(&self) -> &Path {
                &self.0
            }
        }
        impl Drop for Dir {
            fn drop(&mut self) {
                let _ = std::fs::remove_dir_all(&self.0);
            }
        }
    }
}
