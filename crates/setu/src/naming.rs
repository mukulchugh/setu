//! Run naming, hosts and worktree discovery.
#![allow(dead_code)]

use crate::model::ProjectConfig;
use anyhow::{bail, Context, Result};
use std::path::{Path, PathBuf};
use std::process::Command;

/// Stable 64-bit FNV-1a.
pub fn fnv1a(s: &str) -> u64 {
    let mut h: u64 = 0xcbf29ce484222325;
    for b in s.bytes() {
        h ^= b as u64;
        h = h.wrapping_mul(0x100000001b3);
    }
    h
}

/// `~/workspace/quivly-app.git` -> `~/workspace/quivly-app`.
pub fn project_dir(repo: &Path) -> PathBuf {
    match repo.file_name().and_then(|n| n.to_str()) {
        Some(n) if n.len() > 4 && n.ends_with(".git") => repo.with_file_name(&n[..n.len() - 4]),
        _ => repo.to_path_buf(),
    }
}

pub fn run_name(project_dir: &Path, worktree: &Path) -> String {
    // Compare canonical paths: on macOS /tmp is a link to /private/tmp, and git may
    // report either form.
    let canon = |p: &Path| p.canonicalize().unwrap_or_else(|_| p.to_path_buf());
    let (project_dir, worktree) = (canon(project_dir), canon(worktree));
    let rel = worktree.strip_prefix(&project_dir).unwrap_or(&worktree);
    let lower = rel.to_string_lossy().to_lowercase();
    let mut out = String::new();
    for c in lower.chars() {
        let c = if c.is_ascii_lowercase() || c.is_ascii_digit() { c } else { '-' };
        if c == '-' && out.ends_with('-') {
            continue;
        }
        out.push(c);
    }
    let name = out.trim_matches('-').to_string();
    if name.is_empty() {
        return "main".into();
    }
    if name.len() > 63 {
        let h = fnv1a(&name) as u32;
        return format!("{}-{:08x}", &name[..54], h);
    }
    name
}

pub fn host_for(cfg: &ProjectConfig, run: &str) -> String {
    let label = if run == "main" { cfg.project.as_str() } else { run };
    format!("{}.{}", label, cfg.domain).to_lowercase()
}

pub fn list_worktrees(repo: &Path) -> Result<Vec<PathBuf>> {
    let out = Command::new("git")
        .arg("--git-dir")
        .arg(repo)
        .args(["worktree", "list", "--porcelain"])
        .output()
        .context("running git worktree list")?;
    if !out.status.success() {
        bail!("git worktree list failed for {}: {}", repo.display(), String::from_utf8_lossy(&out.stderr).trim());
    }
    let text = String::from_utf8_lossy(&out.stdout);
    let mut res = Vec::new();
    for block in text.split("\n\n") {
        let mut path = None;
        let mut bare = false;
        for line in block.lines() {
            if let Some(p) = line.strip_prefix("worktree ") {
                path = Some(PathBuf::from(p));
            } else if line.trim() == "bare" {
                bare = true;
            }
        }
        if let Some(p) = path {
            if !bare && p.is_dir() {
                res.push(p);
            }
        }
    }
    Ok(res)
}

pub fn find_worktree<'a>(cfgs: &'a [ProjectConfig], path: &Path) -> Result<Option<(&'a ProjectConfig, PathBuf)>> {
    let path = path.canonicalize().with_context(|| format!("resolving {}", path.display()))?;
    let mut best: Option<(&ProjectConfig, PathBuf, usize)> = None;
    for cfg in cfgs {
        let Ok(wts) = list_worktrees(&cfg.repo) else { continue };
        for wt in wts {
            let Ok(canon) = wt.canonicalize() else { continue };
            if path.starts_with(&canon) {
                let depth = canon.components().count();
                if best.as_ref().map_or(true, |b| depth > b.2) {
                    best = Some((cfg, canon, depth));
                }
            }
        }
    }
    Ok(best.map(|(c, p, _)| (c, p)))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeMap;
    use std::time::Duration;

    fn cfg() -> ProjectConfig {
        ProjectConfig {
            project: "Quivly-App".into(),
            repo: PathBuf::new(),
            domain: "quivly.local".into(),
            idle: Duration::from_secs(1),
            max_running: 3,
            ports: vec![],
            env: BTreeMap::new(),
            procs: BTreeMap::new(),
            presets: vec![],
            disk_items: vec![],
            stores: vec![],
        }
    }

    #[test]
    fn project_dir_strips_git() {
        assert_eq!(project_dir(Path::new("/a/quivly-app.git")), PathBuf::from("/a/quivly-app"));
        assert_eq!(project_dir(Path::new("/a/quivly-app")), PathBuf::from("/a/quivly-app"));
    }

    #[test]
    fn run_names() {
        let p = Path::new("/a/q");
        assert_eq!(run_name(p, Path::new("/a/q/feat/x")), "feat-x");
        assert_eq!(run_name(p, Path::new("/a/q/main")), "main");
        assert_eq!(run_name(p, p), "main");
        assert_eq!(run_name(p, Path::new("/a/q/Fix__Bug #1//x")), "fix-bug-1-x");
        let long = format!("/a/q/{}", "abcdefghij".repeat(10));
        let n = run_name(p, Path::new(&long));
        assert_eq!(n.len(), 63);
        assert_eq!(n, run_name(p, Path::new(&long)));
        assert!(n.starts_with(&"abcdefghij".repeat(10)[..54]));
        let other = format!("/a/q/{}x", "abcdefghij".repeat(10));
        assert_ne!(n, run_name(p, Path::new(&other)));
    }

    #[test]
    fn hosts() {
        assert_eq!(host_for(&cfg(), "main"), "quivly-app.quivly.local");
        assert_eq!(host_for(&cfg(), "feat-x"), "feat-x.quivly.local");
    }

    fn git(dir: &Path, args: &[&str]) {
        let st = Command::new("git")
            .current_dir(dir)
            .args(["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false"])
            .args(args)
            .output()
            .unwrap();
        assert!(st.status.success(), "{:?}: {}", args, String::from_utf8_lossy(&st.stderr));
    }

    #[test]
    fn worktrees_listed() {
        let root = std::env::temp_dir().join(format!("setu-naming-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let src = root.join("src");
        std::fs::create_dir_all(&src).unwrap();
        git(&src, &["init", "-q"]);
        git(&src, &["commit", "-q", "--allow-empty", "-m", "i"]);
        git(&root, &["clone", "-q", "--bare", "src", "proj.git"]);
        let bare = root.join("proj.git");
        git(&bare, &["worktree", "add", "-q", "../proj/feat", "-b", "feat"]);
        let wts = list_worktrees(&bare).unwrap();
        assert_eq!(wts.len(), 1);
        assert!(wts[0].ends_with("proj/feat"));

        let mut c = cfg();
        c.repo = bare.clone();
        let cfgs = vec![c];
        std::fs::create_dir_all(wts[0].join("sub")).unwrap();
        let (found, wt) = find_worktree(&cfgs, &wts[0].join("sub")).unwrap().unwrap();
        assert_eq!(found.project, "Quivly-App");
        assert_eq!(wt, wts[0].canonicalize().unwrap());
        assert!(find_worktree(&cfgs, &root).unwrap().is_none());
        let _ = std::fs::remove_dir_all(&root);
    }
}
