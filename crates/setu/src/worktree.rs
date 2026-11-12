//! Worktree lifecycle (slice 7): `new`, `adopt`, `rm` (a persisted, resumable operation) and
//! `restore`. Plan: docs/slices/07-worktrees.md. Everything here is blocking and runs on the
//! blocking pool; git always has a timeout, and an unknown git outcome is never turned into a
//! known one (V1-REVIEW invariants 7-19). The daemon owns state, stops and port leases and
//! plugs into `rm` through `RmHost`, so the state machine is testable without a daemon.
#![allow(dead_code)]

use crate::db::Db;
use crate::disk;
use crate::model::{ProjectConfig, SetupStep, WorktreeCfg};
use crate::{naming, presets, procinfo};
use anyhow::{anyhow, bail, Context, Result};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};
use std::io::Read;
use std::os::unix::fs::{DirBuilderExt, OpenOptionsExt, PermissionsExt};
use std::os::unix::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

const GIT_QUICK: Duration = Duration::from_secs(30);
const GIT_SLOW: Duration = Duration::from_secs(120);
const TAR_TIMEOUT: Duration = Duration::from_secs(600);
const STEP_TIMEOUT: Duration = Duration::from_secs(1800);
/// After a command exits, how long its output pipes may stay open (a background child can hold them).
const DRAIN_GRACE: Duration = Duration::from_secs(3);
/// Ignored data above this is refused rather than archived (override per call with `RmCtx.archive_cap`).
pub const ARCHIVE_MAX_BYTES: u64 = 4 * 1024 * 1024 * 1024;
/// `new` refuses below this much free space unless `[worktree] min_free` says otherwise.
pub const DEFAULT_MIN_FREE: u64 = 2 * 1024 * 1024 * 1024;

// ---------------------------------------------------------------- running commands

/// Three outcomes: ok, failed (a definite non-zero exit), unknown (timeout or could not run).
#[derive(Debug)]
pub enum ExecError {
    Failed { code: Option<i32>, stderr: String },
    Unknown(String),
}

impl std::fmt::Display for ExecError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ExecError::Failed { code, stderr } => write!(f, "exit {}: {}", code.map(|c| c.to_string()).unwrap_or_else(|| "signal".into()), stderr.trim()),
            ExecError::Unknown(m) => write!(f, "outcome unknown: {m}"),
        }
    }
}

impl std::error::Error for ExecError {}

impl ExecError {
    pub fn is_unknown(&self) -> bool {
        matches!(self, ExecError::Unknown(_))
    }
}

pub struct Out {
    pub stdout: Vec<u8>,
}

impl Out {
    pub fn text(&self) -> String {
        String::from_utf8_lossy(&self.stdout).into_owned()
    }
}

/// Run `cmd` with piped output and a deadline. The child leads its own process group, so a
/// timeout kills it and everything it spawned.
pub fn exec(mut cmd: Command, timeout: Duration) -> std::result::Result<Out, ExecError> {
    cmd.stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped()).process_group(0);
    let mut child = cmd.spawn().map_err(|e| ExecError::Unknown(format!("could not run {:?}: {e}", cmd.get_program())))?;
    let drain = |s: Option<Box<dyn Read + Send>>| {
        let buf = std::sync::Arc::new(std::sync::Mutex::new(Vec::<u8>::new()));
        let (done_tx, done_rx) = std::sync::mpsc::channel::<()>();
        let b = buf.clone();
        std::thread::spawn(move || {
            if let Some(mut s) = s {
                let mut chunk = [0u8; 8192];
                while let Ok(n) = s.read(&mut chunk) {
                    if n == 0 {
                        break;
                    }
                    b.lock().unwrap_or_else(|e| e.into_inner()).extend_from_slice(&chunk[..n]);
                }
            }
            let _ = done_tx.send(());
        });
        (buf, done_rx)
    };
    let (out_buf, out_done) = drain(child.stdout.take().map(|s| Box::new(s) as Box<dyn Read + Send>));
    let (err_buf, err_done) = drain(child.stderr.take().map(|s| Box::new(s) as Box<dyn Read + Send>));
    let deadline = Instant::now() + timeout;
    let status = loop {
        match child.try_wait() {
            Ok(Some(st)) => break Ok(st),
            Ok(None) if Instant::now() >= deadline => {
                // SAFETY: killpg on the group we created with process_group(0).
                unsafe { libc::killpg(child.id() as i32, libc::SIGKILL) };
                let _ = child.kill();
                let _ = child.wait();
                break Err(format!("timed out after {}s", timeout.as_secs()));
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(8)),
            Err(e) => break Err(format!("waiting failed: {e}")),
        }
    };
    // The child is gone. A background descendant may still hold the pipes open, so draining
    // is bounded: the deadline applies to the output too (review #19).
    let drain_until = std::cmp::min(deadline.max(Instant::now()), Instant::now() + DRAIN_GRACE);
    for done in [&out_done, &err_done] {
        let _ = done.recv_timeout(drain_until.saturating_duration_since(Instant::now()));
    }
    let stdout = out_buf.lock().unwrap_or_else(|e| e.into_inner()).clone();
    let stderr = String::from_utf8_lossy(&err_buf.lock().unwrap_or_else(|e| e.into_inner())).into_owned();
    match status {
        Ok(st) if st.success() => Ok(Out { stdout }),
        Ok(st) => Err(ExecError::Failed { code: st.code(), stderr }),
        Err(m) => Err(ExecError::Unknown(m)),
    }
}

fn git_cmd(dir: &Path, args: &[&str]) -> Command {
    let mut c = Command::new("git");
    for k in ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_COMMON_DIR", "GIT_OBJECT_DIRECTORY", "GIT_NAMESPACE"] {
        c.env_remove(k);
    }
    // Setu's own git calls never start background maintenance: `git fetch`/`commit` otherwise leave
    // a detached `git maintenance run --auto --detach` whose cwd is the worktree, which the
    // "processes" guard then counts as a live process in it (the suite's flaky failure).
    c.env("GIT_TERMINAL_PROMPT", "0").env("GIT_OPTIONAL_LOCKS", "0").args(["-c", "maintenance.auto=false", "-c", "gc.auto=0"]).arg("-C").arg(dir).args(args);
    c
}

/// `git -C dir args...` with a timeout.
pub fn git(dir: &Path, args: &[&str], timeout: Duration) -> std::result::Result<Out, ExecError> {
    exec(git_cmd(dir, args), timeout)
}

fn git_ok(dir: &Path, args: &[&str]) -> Result<Out> {
    git(dir, args, GIT_QUICK).map_err(|e| anyhow!("git {}: {e}", args.first().copied().unwrap_or("")))
}

/// True/false for a `rev-parse --verify`-style probe; an unknown outcome is an error.
fn git_probe(dir: &Path, args: &[&str]) -> Result<bool> {
    match git(dir, args, GIT_QUICK) {
        Ok(_) => Ok(true),
        Err(ExecError::Failed { code: Some(1) | Some(128), .. }) => Ok(false),
        Err(e) => bail!("git {}: {e}", args.first().copied().unwrap_or("")),
    }
}

// ---------------------------------------------------------------- names and refs

fn valid_ref_arg(what: &str, s: &str) -> Result<()> {
    if s.is_empty() || s.starts_with('-') || s.chars().any(|c| c.is_control() || c.is_whitespace()) || s.contains("@{") {
        bail!("{what} {s:?} is not a valid git name");
    }
    Ok(())
}

pub fn validate_branch(repo: &Path, branch: &str) -> Result<()> {
    valid_ref_arg("branch", branch)?;
    if !git_probe(repo, &["check-ref-format", &format!("refs/heads/{branch}")])? {
        bail!("{branch:?} is not a valid branch name");
    }
    Ok(())
}

/// Parsed `git worktree list --porcelain`: (path, branch short name or None when detached/bare).
pub fn worktree_entries(repo: &Path) -> Result<Vec<(PathBuf, Option<String>)>> {
    let out = git_ok(repo, &["worktree", "list", "--porcelain"])?.text();
    let mut res = Vec::new();
    for block in out.split("\n\n") {
        let mut path = None;
        let mut branch = None;
        let mut bare = false;
        for line in block.lines() {
            if let Some(p) = line.strip_prefix("worktree ") {
                path = Some(PathBuf::from(p));
            } else if let Some(b) = line.strip_prefix("branch refs/heads/") {
                branch = Some(b.to_string());
            } else if line.trim() == "bare" {
                bare = true;
            }
        }
        if let (Some(p), false) = (path, bare) {
            res.push((p, branch));
        }
    }
    Ok(res)
}

fn canon(p: &Path) -> PathBuf {
    p.canonicalize().unwrap_or_else(|_| p.to_path_buf())
}

fn is_registered(repo: &Path, wt: &Path) -> Result<bool> {
    let want = canon(wt);
    Ok(worktree_entries(repo)?.iter().any(|(p, _)| canon(p) == want))
}

/// Base for `new`: explicit `from`, else `[worktree] base`, else origin/staging if it exists,
/// else origin/<default branch>. The result must resolve to a commit.
pub fn resolve_base(repo: &Path, cfg: &WorktreeCfg, from: Option<&str>) -> Result<String> {
    let verify = |r: &str| git_probe(repo, &["rev-parse", "--verify", "--quiet", "--end-of-options", &format!("{r}^{{commit}}")]);
    let explicit = from.map(str::to_string).or_else(|| cfg.base.clone());
    if let Some(b) = explicit {
        valid_ref_arg("base", &b)?;
        if !verify(&b)? {
            bail!("base {b} does not resolve to a commit (did the fetch get it?)");
        }
        return Ok(b);
    }
    if verify("refs/remotes/origin/staging")? {
        return Ok("origin/staging".into());
    }
    let default = match git(repo, &["symbolic-ref", "--short", "refs/remotes/origin/HEAD"], GIT_QUICK) {
        Ok(o) => Some(o.text().trim().to_string()),
        Err(ExecError::Failed { .. }) => None,
        Err(e) => bail!("git symbolic-ref: {e}"),
    };
    let candidates: Vec<String> = default
        .into_iter()
        .chain(git(repo, &["symbolic-ref", "--short", "HEAD"], GIT_QUICK).ok().map(|o| format!("origin/{}", o.text().trim())))
        .chain(["origin/main".to_string(), "origin/master".to_string()])
        .collect();
    for c in candidates {
        if valid_ref_arg("base", &c).is_ok() && verify(&format!("refs/remotes/{c}"))? {
            return Ok(c);
        }
    }
    bail!("no base found: origin/staging and the default branch are both missing. Fetch the repo, or set [worktree] base / pass --from")
}

// ---------------------------------------------------------------- new

#[derive(Debug, Clone, Serialize)]
pub struct StepResult {
    pub name: String,
    pub ok: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct NewOutcome {
    pub path: PathBuf,
    pub run: String,
    pub branch: String,
    pub base: String,
    pub warnings: Vec<String>,
    pub setup: Vec<StepResult>,
    pub setup_log: Option<PathBuf>,
}

fn rel_ok(p: &str) -> Result<()> {
    crate::config::validate_disk_path(p)
}

/// Where the main worktree lives: `<project dir>/main`.
pub fn main_dir(cfg: &ProjectConfig) -> PathBuf {
    naming::project_dir(&cfg.repo).join("main")
}

/// Add `/<path>` lines to the repo's info/exclude (idempotent), so Setu's own symlinks never
/// make a worktree look dirty.
pub fn ensure_excludes(repo: &Path, rels: &[String]) -> Result<()> {
    if rels.is_empty() {
        return Ok(());
    }
    let common = git_ok(repo, &["rev-parse", "--git-common-dir"])?.text();
    let common = PathBuf::from(common.trim());
    let common = if common.is_absolute() { common } else { repo.join(common) };
    let file = common.join("info/exclude");
    let current = std::fs::read_to_string(&file).unwrap_or_default();
    let have: BTreeSet<&str> = current.lines().collect();
    let missing: Vec<String> = rels.iter().map(|r| format!("/{r}")).filter(|l| !have.contains(l.as_str())).collect();
    if missing.is_empty() {
        return Ok(());
    }
    std::fs::create_dir_all(file.parent().ok_or_else(|| anyhow!("bad exclude path"))?)?;
    let mut text = current;
    if !text.is_empty() && !text.ends_with('\n') {
        text.push('\n');
    }
    text.push_str(&missing.join("\n"));
    text.push('\n');
    std::fs::write(&file, text).with_context(|| format!("writing {}", file.display()))
}

/// Symlink the declared paths from the main worktree. Missing sources and existing targets are
/// skipped with a warning; nothing is ever overwritten.
pub fn link_files(cfg: &ProjectConfig, wt: &Path) -> Result<Vec<String>> {
    let mut warnings = Vec::new();
    if cfg.worktree.link.is_empty() {
        return Ok(warnings);
    }
    let main = main_dir(cfg);
    if !main.is_dir() {
        warnings.push(format!("no main worktree at {}; linked files skipped", main.display()));
        return Ok(warnings);
    }
    ensure_excludes(&cfg.repo, &cfg.worktree.link)?;
    for rel in &cfg.worktree.link {
        rel_ok(rel)?;
        let src = main.join(rel);
        let dst = wt.join(rel);
        if std::fs::symlink_metadata(&src).is_err() {
            warnings.push(format!("link {rel}: not present in the main worktree"));
            continue;
        }
        if std::fs::symlink_metadata(&dst).is_ok() {
            warnings.push(format!("link {rel}: already exists in the new worktree; left alone"));
            continue;
        }
        if let Some(parent) = dst.parent() {
            std::fs::create_dir_all(parent)?;
        }
        std::os::unix::fs::symlink(&src, &dst).with_context(|| format!("linking {rel}"))?;
    }
    Ok(warnings)
}

fn copy_tree(src: &Path, dst: &Path) -> Result<()> {
    let meta = std::fs::symlink_metadata(src)?;
    if meta.file_type().is_symlink() {
        return Ok(()); // never follow or copy links
    }
    if meta.is_dir() {
        std::fs::create_dir_all(dst)?;
        for e in std::fs::read_dir(src)? {
            let e = e?;
            copy_tree(&e.path(), &dst.join(e.file_name()))?;
        }
    } else if !dst.exists() {
        std::fs::copy(src, dst)?;
    }
    Ok(())
}

/// Copy declared files from the main worktree. Only git-ignored sources are copied (a tracked
/// file already arrived with the checkout); existing targets are kept.
pub fn copy_files(cfg: &ProjectConfig, wt: &Path) -> Result<Vec<String>> {
    let mut warnings = Vec::new();
    if cfg.worktree.copy.is_empty() {
        return Ok(warnings);
    }
    let main = main_dir(cfg);
    if !main.is_dir() {
        warnings.push(format!("no main worktree at {}; copied files skipped", main.display()));
        return Ok(warnings);
    }
    for rel in &cfg.worktree.copy {
        rel_ok(rel)?;
        let src = main.join(rel);
        if std::fs::symlink_metadata(&src).is_err() {
            warnings.push(format!("copy {rel}: not present in the main worktree"));
            continue;
        }
        if !git_probe(&main, &["check-ignore", "-q", "--", rel])? {
            warnings.push(format!("copy {rel}: not git-ignored in the main worktree; skipped (only ignored files are copied)"));
            continue;
        }
        let dst = wt.join(rel);
        if let Some(parent) = dst.parent() {
            std::fs::create_dir_all(parent)?;
        }
        copy_tree(&src, &dst).with_context(|| format!("copying {rel}"))?;
    }
    Ok(warnings)
}

/// Run the setup steps in order in `wt`; stdout and stderr of each go to `log` (never into a
/// reply, so they cannot bypass log redaction). Stops at the first failing step.
pub fn run_steps(steps: &[SetupStep], wt: &Path, env: &BTreeMap<String, String>, log: &Path) -> Result<Vec<StepResult>> {
    use std::io::Write;
    let mut results = Vec::new();
    if steps.is_empty() {
        return Ok(results);
    }
    if let Some(dir) = log.parent() {
        std::fs::DirBuilder::new().recursive(true).mode(0o700).create(dir)?;
    }
    let mut logf = std::fs::OpenOptions::new().create(true).append(true).mode(0o600).open(log)?;
    let _ = std::fs::set_permissions(log, std::fs::Permissions::from_mode(0o600));
    let mut env = env.clone();
    if !env.contains_key("PATH") {
        if let Some(p) = crate::globalcfg::login_path() {
            env.insert("PATH".into(), p);
        }
    }
    for st in steps {
        writeln!(logf, "[setu] {} setup {}: {}", crate::env::rfc3339_now(), st.name, st.run)?;
        let mut cmd = Command::new("/bin/sh");
        for (k, _) in std::env::vars_os() {
            let k = k.to_string_lossy().to_string();
            if crate::supervisor::LEAKY_ENV.contains(&k.as_str()) || crate::supervisor::LEAKY_PREFIXES.iter().any(|p| k.starts_with(p)) {
                cmd.env_remove(&k);
            }
        }
        cmd.arg("-c").arg(&st.run).current_dir(wt).envs(&env);
        // Output goes straight to the log file, not through a pipe.
        cmd.stdin(Stdio::null()).stdout(Stdio::from(logf.try_clone()?)).stderr(Stdio::from(logf.try_clone()?)).process_group(0);
        let mut child = cmd.spawn().with_context(|| format!("starting setup step {}", st.name))?;
        let deadline = Instant::now() + STEP_TIMEOUT;
        let ok = loop {
            match child.try_wait()? {
                Some(s) => break s.success(),
                None if Instant::now() >= deadline => {
                    // SAFETY: killpg on the group created above.
                    unsafe { libc::killpg(child.id() as i32, libc::SIGKILL) };
                    let _ = child.wait();
                    let _ = writeln!(logf, "[setu] setup {} timed out", st.name);
                    break false;
                }
                None => std::thread::sleep(Duration::from_millis(20)),
            }
        };
        let _ = writeln!(logf, "[setu] setup {} {}", st.name, if ok { "ok" } else { "FAILED" });
        results.push(StepResult { name: st.name.clone(), ok });
        if !ok {
            bail!("setup step {:?} failed; see {}", st.name, log.display());
        }
    }
    Ok(results)
}

/// Create `<project dir>/<branch>` as a new worktree. `existing_runs` are `project/run` keys the
/// daemon already knows. `env_for` registers the run and returns its env for the setup steps.
pub fn create(
    cfg: &ProjectConfig,
    branch: &str,
    from: Option<&str>,
    existing_runs: &BTreeSet<String>,
    ops: &Db,
    log_dir: &Path,
    env_for: impl FnOnce(&Path, &str) -> Result<BTreeMap<String, String>>,
) -> Result<NewOutcome> {
    let repo = cfg.repo.as_path();
    validate_branch(repo, branch)?;
    if let Some(f) = from {
        valid_ref_arg("base", f)?;
    }
    let pdir = canon(&naming::project_dir(repo));
    let path = pdir.join(branch);
    let run = naming::run_name(&pdir, &path);
    if run == "main" {
        bail!("{branch:?} would be the main worktree's slot; pick another branch name");
    }
    let key = format!("{}/{run}", cfg.project);
    if pending_removal(ops, &key) {
        bail!("a removal of {key} is pending; retry `setu rm {key}` first");
    }
    if existing_runs.contains(&key) {
        bail!("run {key} already exists; use `setu up` for it");
    }
    if std::fs::symlink_metadata(&path).is_ok() {
        bail!("{} already exists", path.display());
    }
    git(repo, &["fetch", "--all", "--prune", "--quiet"], GIT_SLOW).map_err(|e| anyhow!("fetch failed, refusing to branch from a stale base: {e}"))?;
    for (p, b) in worktree_entries(repo)? {
        if b.as_deref() == Some(branch) {
            bail!("branch {branch} is already checked out at {}; use `setu up` there", p.display());
        }
        if naming::run_name(&pdir, &p) == run {
            bail!("run name {run} is already used by {}", p.display());
        }
    }
    let probe_dir = pdir.ancestors().find(|a| a.exists()).unwrap_or(Path::new("/")).to_path_buf();
    let floor = cfg.worktree.min_free.unwrap_or(DEFAULT_MIN_FREE);
    let free = disk::free_bytes(&probe_dir);
    if free < floor {
        bail!("only {} free on the volume; creating a worktree needs at least {} (set [worktree] min_free to change)", disk::human_bytes(free), disk::human_bytes(floor));
    }
    if git_probe(repo, &["show-ref", "--verify", "--quiet", &format!("refs/heads/{branch}")])? {
        bail!("branch {branch} already exists; `setu restore` brings back a removed worktree, or pick another name");
    }
    let remote_branch = format!("refs/remotes/origin/{branch}");
    let tracks_remote = from.is_none() && cfg.worktree.base.is_none() && git_probe(repo, &["show-ref", "--verify", "--quiet", &remote_branch])?;
    let base = if tracks_remote { format!("origin/{branch}") } else { resolve_base(repo, &cfg.worktree, from)? };
    let path_s = path.to_string_lossy().into_owned();
    let track = if tracks_remote { "--track" } else { "--no-track" };
    git(repo, &["worktree", "add", track, "-b", branch, "--", &path_s, &base], GIT_SLOW).map_err(|e| anyhow!("git worktree add: {e}"))?;
    // The fork point lets auto-removal tell "merged" from "never had a commit of its own".
    if let Ok(h) = git(&path, &["rev-parse", "HEAD"], GIT_QUICK) {
        let _ = git(repo, &["config", "--local", &format!("branch.{branch}.setu-fork"), h.text().trim()], GIT_QUICK);
    }
    let after = |e: anyhow::Error| e.context(format!("the worktree was created at {} but the next step failed; it is kept", path.display()));
    let mut warnings = link_files(cfg, &path).map_err(after)?;
    warnings.extend(copy_files(cfg, &path).map_err(after)?);
    let (mut setup, mut setup_log) = (Vec::new(), None);
    let env = env_for(&path, &run).map_err(after)?;
    if !cfg.setup_steps.is_empty() {
        let log = log_dir.join(&cfg.project).join(&run).join("setup.log");
        setup = run_steps(&cfg.setup_steps, &path, &env, &log).map_err(after)?;
        setup_log = Some(log);
    }
    Ok(NewOutcome { path: canon(&path), run, branch: branch.to_string(), base, warnings, setup, setup_log })
}

/// Verify `path` is a worktree of the project's repo; returns its canonical path and run name.
/// Installs nothing and changes nothing.
pub fn adopt_check(cfg: &ProjectConfig, path: &Path) -> Result<(PathBuf, String)> {
    let want = path.canonicalize().with_context(|| format!("resolving {}", path.display()))?;
    let entries = worktree_entries(&cfg.repo)?;
    let hit = entries.iter().map(|(p, _)| canon(p)).find(|p| *p == want).ok_or_else(|| anyhow!("{} is not a worktree of {}", want.display(), cfg.project))?;
    let run = naming::run_name(&naming::project_dir(&cfg.repo), &hit);
    Ok((hit, run))
}

// ---------------------------------------------------------------- guards

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Reason {
    /// main, dirty, unpushed, fetch, processes, claim, running
    pub code: &'static str,
    pub message: String,
}

/// A fact that may be unknown; unknown always becomes a reason (unknown means keep).
#[derive(Debug, Clone, PartialEq)]
pub enum Fact<T> {
    Known(T),
    Unknown(String),
}

#[derive(Debug, Clone)]
pub struct GuardInput {
    pub is_main: bool,
    /// Changed or untracked entries from `git status` (ignored files excluded).
    pub dirty: Fact<Vec<String>>,
    /// Commits not on any remote ref: short descriptions, newest first.
    pub unpushed: Fact<Vec<String>>,
    /// Did the fresh fetch succeed?
    pub fetch: Fact<()>,
    /// Processes whose cwd is inside the worktree.
    pub procs: Vec<i32>,
    /// Holder of a live claim.
    pub claim: Option<String>,
    /// Some(status) when Setu's run is not stopped.
    pub running: Option<String>,
    /// `--force`: skips dirty, unpushed and fetch. Never main, claim, processes or running.
    pub force: bool,
}

/// Every reason this worktree may not be removed right now. Pure.
pub fn guards(i: &GuardInput) -> Vec<Reason> {
    let mut out = Vec::new();
    let mut add = |code: &'static str, message: String| out.push(Reason { code, message });
    if i.is_main {
        add("main", "the main worktree is never removed".into());
    }
    if let Some(holder) = &i.claim {
        add("claim", format!("a live writer claim is held by {holder}; it must release it (or go stale) first"));
    }
    if let Some(st) = &i.running {
        add("running", format!("the run is {st}; stop it first"));
    }
    if !i.procs.is_empty() {
        let list: Vec<String> = i.procs.iter().take(5).map(|p| p.to_string()).collect();
        add("processes", format!("{} process(es) have their working directory inside the worktree (pid {})", i.procs.len(), list.join(", ")));
    }
    if !i.force {
        match &i.dirty {
            Fact::Known(v) if !v.is_empty() => add("dirty", format!("{} uncommitted or untracked file(s), e.g. {}", v.len(), v.iter().take(3).cloned().collect::<Vec<_>>().join(", "))),
            Fact::Known(_) => {}
            Fact::Unknown(e) => add("dirty", format!("could not tell whether the worktree is clean: {e}")),
        }
        match &i.fetch {
            Fact::Known(()) => {}
            Fact::Unknown(e) => add("fetch", format!("could not fetch to verify what is on the remote: {e}")),
        }
        match &i.unpushed {
            Fact::Known(v) if !v.is_empty() => add("unpushed", format!("{} commit(s) are on no remote branch, e.g. {}", v.len(), v.iter().take(3).cloned().collect::<Vec<_>>().join("; "))),
            Fact::Known(_) => {}
            Fact::Unknown(e) => add("unpushed", format!("could not tell whether every commit is on a remote: {e}")),
        }
    }
    out
}

/// What the caller already knows when asking for facts.
pub struct FactCtx {
    pub is_main: bool,
    pub claim: Option<String>,
    pub running: Option<String>,
    pub force: bool,
    /// Preflight: the run is about to be stopped, so its own processes are not a reason yet.
    pub skip_procs: bool,
}

/// Gather the facts (blocking: fetch, status, log, libproc). Any git trouble becomes `Unknown`.
pub fn collect_facts(wt: &Path, ctx: FactCtx) -> GuardInput {
    collect_facts_opt(wt, ctx, true)
}

/// `collect_facts`, optionally without the network fetch (a re-check right before deleting).
fn collect_facts_opt(wt: &Path, ctx: FactCtx, fetch: bool) -> GuardInput {
    let dirty = match git(wt, &["status", "--porcelain", "--untracked-files=all"], GIT_SLOW) {
        Ok(o) => Fact::Known(o.text().lines().map(|l| l.to_string()).collect()),
        Err(e) => Fact::Unknown(e.to_string()),
    };
    let fetch = if !fetch {
        Fact::Known(())
    } else {
        match git(wt, &["fetch", "--all", "--prune", "--quiet"], GIT_SLOW) {
            Ok(_) => Fact::Known(()),
            Err(e) => Fact::Unknown(e.to_string()),
        }
    };
    let unpushed = match git(wt, &["log", "--format=%h %s", "--max-count=200", "HEAD", "--not", "--remotes", "--"], GIT_QUICK) {
        Ok(o) => Fact::Known(o.text().lines().map(|l| l.to_string()).collect()),
        Err(e) => Fact::Unknown(e.to_string()),
    };
    let me = std::process::id() as i32;
    let procs = if ctx.skip_procs { Vec::new() } else { procinfo::pids_with_cwd_under(wt).into_iter().filter(|p| *p != me).collect() };
    GuardInput { is_main: ctx.is_main, dirty, unpushed, fetch, procs, claim: ctx.claim, running: ctx.running, force: ctx.force }
}

// ---------------------------------------------------------------- archive selection

/// Ignored files that exist nowhere else: git-ignored, not under a declared `[[disk.item]]`
/// path (any kind), not under node_modules, not symlinks. Directories that merely contain a
/// declared path are expanded; other ignored directories are taken whole. Paths are relative.
pub fn irreplaceable(wt: &Path, declared: &[String]) -> Result<Vec<PathBuf>> {
    use std::os::unix::ffi::OsStrExt;
    let out = git(wt, &["ls-files", "-z", "--others", "--ignored", "--exclude-standard", "--directory"], GIT_SLOW).map_err(|e| anyhow!("listing ignored files: {e}"))?;
    let declared_abs: Vec<PathBuf> = declared.iter().flat_map(|p| presets::expand_paths(wt, p)).collect();
    let mut result = Vec::new();
    for raw in out.stdout.split(|b| *b == 0).filter(|s| !s.is_empty()) {
        let rel = PathBuf::from(std::ffi::OsStr::from_bytes(raw));
        select(wt, &rel, &declared_abs, &mut result)?;
    }
    result.sort();
    Ok(result)
}

fn select(wt: &Path, rel: &Path, declared_abs: &[PathBuf], out: &mut Vec<PathBuf>) -> Result<()> {
    // Only dependency trees are skipped. A nested `.git` is an independent repository whose local
    // history exists nowhere else, so it is archived like any other ignored data (review #5);
    // the worktree's own `.git` entry is a file that `ls-files --others` never lists.
    if rel.components().any(|c| matches!(c.as_os_str().to_str(), Some("node_modules"))) || rel == Path::new(".git") {
        return Ok(());
    }
    let abs = wt.join(rel);
    let Ok(meta) = std::fs::symlink_metadata(&abs) else { return Ok(()) };
    if meta.file_type().is_symlink() {
        return Ok(());
    }
    if declared_abs.iter().any(|d| abs.starts_with(d)) {
        return Ok(());
    }
    if meta.is_dir() && has_excluded(&abs, declared_abs) {
        for e in std::fs::read_dir(&abs)? {
            select(wt, &rel.join(e?.file_name()), declared_abs, out)?;
        }
        return Ok(());
    }
    out.push(rel.to_path_buf());
    Ok(())
}

/// Does this directory contain (at any depth) a node_modules or declared path? Such paths
/// are never descended into once found, so dependency trees are not walked.
fn has_excluded(dir: &Path, declared_abs: &[PathBuf]) -> bool {
    let Ok(rd) = std::fs::read_dir(dir) else { return false };
    for e in rd.flatten() {
        let p = e.path();
        if matches!(e.file_name().to_str(), Some("node_modules")) || declared_abs.iter().any(|d| p.starts_with(d)) {
            return true;
        }
        if e.file_type().is_ok_and(|t| t.is_dir()) && has_excluded(&p, declared_abs) {
            return true;
        }
    }
    false
}

/// `20261111T120000Z`-style timestamp for archive names.
pub fn compact_ts() -> String {
    crate::env::rfc3339_now().replace(['-', ':'], "")
}

pub fn archive_path(root: &Path, project: &str, run: &str, ts: &str) -> PathBuf {
    root.join(project).join(run).join(format!("{ts}.tar"))
}

/// Write `rels` (relative to `wt`) into `dest` via a temp file and rename. Mode 0600 (it holds env files).
pub fn write_archive(wt: &Path, rels: &[PathBuf], dest: &Path) -> Result<()> {
    use std::io::Write;
    use std::os::unix::ffi::OsStrExt;
    let dir = dest.parent().ok_or_else(|| anyhow!("bad archive path"))?;
    std::fs::DirBuilder::new().recursive(true).mode(0o700).create(dir)?;
    let name = dest.file_name().and_then(|n| n.to_str()).unwrap_or("a.tar");
    let tmp = dir.join(format!(".{name}.tmp"));
    let list = dir.join(format!(".{name}.list"));
    let res = (|| -> Result<()> {
        let mut f = std::fs::OpenOptions::new().write(true).create(true).truncate(true).mode(0o600).open(&list)?;
        for r in rels {
            f.write_all(r.as_os_str().as_bytes())?;
            f.write_all(&[0])?;
        }
        f.sync_all()?;
        let mut cmd = Command::new("tar");
        cmd.arg("-cf").arg(&tmp).arg("-C").arg(wt).arg("--null").arg("-T").arg(&list);
        exec(cmd, TAR_TIMEOUT).map_err(|e| anyhow!("tar: {e}"))?;
        std::fs::set_permissions(&tmp, std::fs::Permissions::from_mode(0o600))?;
        std::fs::rename(&tmp, dest)?;
        Ok(())
    })();
    let _ = std::fs::remove_file(&list);
    if res.is_err() {
        let _ = std::fs::remove_file(&tmp);
    }
    res.with_context(|| format!("archiving to {}", dest.display()))
}

/// Newest archive for a run (names sort by timestamp).
pub fn latest_archive(root: &Path, project: &str, run: &str) -> Option<PathBuf> {
    let mut v: Vec<PathBuf> = std::fs::read_dir(root.join(project).join(run))
        .ok()?
        .flatten()
        .map(|e| e.path())
        .filter(|p| p.extension().is_some_and(|x| x == "tar") && !p.file_name().is_some_and(|n| n.to_string_lossy().starts_with('.')))
        .collect();
    v.sort();
    v.pop()
}

// ---------------------------------------------------------------- rm: persisted operation

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Step {
    Stop,
    Guards,
    Archive,
    Remove,
    DropState,
    ReleaseLease,
    Marker,
    Done,
}

/// The persisted removal record. While `step != Done` it is a pending operation (retry resumes
/// at `step`); at `Done` it is the marker `restore` works from. `force` is deliberately not stored.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct OpRecord {
    pub version: u32,
    pub id: String,
    pub project: String,
    pub run: String,
    pub worktree: PathBuf,
    pub branch: Option<String>,
    pub head: Option<String>,
    /// The next step to run.
    pub step: Step,
    pub archive: Option<PathBuf>,
    pub archived_files: usize,
    pub started: u64,
    pub updated: u64,
    pub finished: Option<u64>,
    pub last_error: Option<String>,
    /// `--force` saved the dirty changes here (`refs/setu-backup/<branch>`) before removing.
    #[serde(default)]
    pub backup_ref: Option<String>,
}

fn check_key(key: &str) -> Result<()> {
    let (p, r) = key.split_once('/').ok_or_else(|| anyhow!("run {key:?} must be project/run"))?;
    for part in [p, r] {
        if part.is_empty() || part.contains('/') || part.starts_with('.') {
            bail!("bad run name {key:?}");
        }
    }
    Ok(())
}

fn op_row(c: &crate::db::Conn, key: &str) -> Result<Option<OpRecord>> {
    let json: Option<String> = c.query_opt("SELECT record_json FROM removal_ops WHERE run_key = ?1", [key], |r| Ok(r.get::<String>(0)?))?;
    json.map(|j| serde_json::from_str(&j).with_context(|| format!("corrupt operation record for {key}"))).transpose()
}

pub fn load_op(db: &Db, key: &str) -> Result<Option<OpRecord>> {
    check_key(key)?;
    db.with(|c| op_row(c, key))
}

/// Insert or replace a removal record (one row per run).
pub fn put_op_tx(c: &crate::db::Conn, rec: &OpRecord) -> Result<()> {
    let step = serde_json::to_value(rec.step)?;
    c.execute(
        "INSERT INTO removal_ops (run_key, op_id, step, record_json, updated_at) VALUES (?1, ?2, ?3, ?4, ?5)
         ON CONFLICT(run_key) DO UPDATE SET op_id=excluded.op_id, step=excluded.step, record_json=excluded.record_json, updated_at=excluded.updated_at",
        crate::db::params![format!("{}/{}", rec.project, rec.run), rec.id.clone(), step.as_str().unwrap_or("").to_string(), serde_json::to_string(rec)?, rec.updated as i64],
    )?;
    Ok(())
}

fn save_op(db: &Db, rec: &OpRecord) -> Result<()> {
    check_key(&format!("{}/{}", rec.project, rec.run))?;
    db.with(|c| put_op_tx(c, rec))
}

/// An unfinished removal blocks `new` and `start` for that run. An unreadable record counts as pending.
pub fn pending_removal(db: &Db, key: &str) -> bool {
    match load_op(db, key) {
        Ok(None) => false,
        Ok(Some(r)) => r.step != Step::Done,
        Err(_) => true,
    }
}

fn all_ops(db: &Db) -> Vec<OpRecord> {
    db.with(|c| {
        let rows: Vec<String> = c.query("SELECT record_json FROM removal_ops ORDER BY run_key", (), |r| Ok(r.get::<String>(0)?))?;
        Ok(rows.iter().filter_map(|j| serde_json::from_str(j).ok()).collect())
    })
    .unwrap_or_default()
}

/// Every unfinished removal, for `doctor` and the app.
pub fn pending_ops(db: &Db) -> Vec<OpRecord> {
    all_ops(db).into_iter().filter(|r| r.step != Step::Done).collect()
}

/// What the daemon (or a test) provides to `rm`.
pub trait RmHost {
    /// Stop the run's processes; must be idempotent.
    fn stop(&self) -> Result<()>;
    /// Holder of a live claim, if any.
    fn claim_holder(&self) -> Option<String>;
    /// Some(status) when the run is not stopped.
    fn running(&self) -> Option<String>;
    /// Forget the run in daemon state (and its claim file); idempotent.
    fn drop_state(&self) -> Result<()>;
    /// Release the port lease; idempotent.
    fn release_lease(&self) -> Result<()>;
    /// Steps 5 to 7 (drop state, release lease, marker) commit together: `extra` deletes the run,
    /// lease and claim rows and writes the finished marker, and runs inside the one transaction.
    /// The daemon overrides this to write its state snapshot in the same transaction.
    fn commit_teardown(&self, db: &Db, extra: &mut dyn FnMut(&crate::db::Conn) -> Result<()>) -> Result<()> {
        db.tx(|tx| extra(tx))
    }
    /// Called after each step has been recorded; an error here simulates a crash (tests).
    fn after_step(&self, _step: Step) -> Result<()> {
        Ok(())
    }
}

pub struct RmCtx<'a> {
    pub project: &'a str,
    pub run: &'a str,
    /// Where the worktree is (or was).
    pub worktree: &'a Path,
    pub repo: &'a Path,
    /// `[[disk.item]]` path patterns (every kind): never archived.
    pub declared: &'a [String],
    pub archive_root: &'a Path,
    pub db: &'a Db,
    pub force: bool,
    pub host: &'a dyn RmHost,
    /// Refuse to archive more than this many bytes of ignored data; `None` means `ARCHIVE_MAX_BYTES`.
    pub archive_cap: Option<u64>,
    /// Validated proof that the branch tip is integrated into a freshly fetched base (a merged
    /// pull request for exactly this head, or an offline merge-tree/cherry match). Arguments:
    /// the worktree, whether a fetch just ran, and the head the removal was planned for. The
    /// "unpushed" guard accepts exactly this proof and nothing else, and it is evaluated again
    /// at every guard check, the last one right before deletion (review B8).
    pub merge_proof: Option<&'a MergeProofFn<'a>>,
}

pub type MergeProofFn<'a> = dyn Fn(&Path, bool, Option<&str>) -> Option<String> + 'a;

/// `guards` after letting a validated merge proof account for otherwise unpushed commits.
fn guards_with_proof(ctx: &RmCtx, mut g: GuardInput, fetched: bool, expected_head: Option<&str>) -> Vec<Reason> {
    if let (Fact::Known(v), Some(proof)) = (&g.unpushed, ctx.merge_proof) {
        if !v.is_empty() && !g.force && proof(ctx.worktree, fetched, expected_head).is_some() {
            g.unpushed = Fact::Known(vec![]);
        }
    }
    guards(&g)
}

#[derive(Debug, Clone, Serialize)]
pub struct RmOutcome {
    pub run: String,
    pub removed: bool,
    pub archive: Option<PathBuf>,
    pub archived_files: usize,
    pub branch: Option<String>,
    /// True when the record already said removed.
    pub already: bool,
}

/// A guard refusal: the reasons, nothing destructive done.
#[derive(Debug)]
pub struct Refused(pub Vec<Reason>);

impl std::fmt::Display for Refused {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "refusing to remove: ")?;
        for (i, r) in self.0.iter().enumerate() {
            if i > 0 {
                write!(f, "; ")?;
            }
            write!(f, "[{}] {}", r.code, r.message)?;
        }
        Ok(())
    }
}

impl std::error::Error for Refused {}

fn facts_ctx(ctx: &RmCtx, skip_procs: bool) -> FactCtx {
    FactCtx { is_main: ctx.run == "main", claim: ctx.host.claim_holder(), running: if skip_procs { None } else { ctx.host.running() }, force: ctx.force, skip_procs }
}

/// Remove a worktree: stop, guards, archive, git remove, drop state, release lease, marker.
/// Resumable: a record at `step` continues there. The branch is never deleted.
pub fn rm(ctx: &RmCtx) -> Result<RmOutcome> {
    let key = format!("{}/{}", ctx.project, ctx.run);
    let existing = load_op(ctx.db, &key)?;
    let mut rec = match existing {
        Some(r) if r.step == Step::Done => {
            return Ok(RmOutcome { run: key, removed: true, archive: r.archive, archived_files: r.archived_files, branch: r.branch, already: true });
        }
        Some(r) => {
            if ctx.worktree.exists() && canon(&r.worktree) != canon(ctx.worktree) {
                bail!("the pending removal of {key} was for {}, but {} is a different checkout; refusing to touch it", r.worktree.display(), ctx.worktree.display());
            }
            r
        }
        None => {
            if ctx.run == "main" {
                let g = GuardInput { is_main: true, dirty: Fact::Known(vec![]), unpushed: Fact::Known(vec![]), fetch: Fact::Known(()), procs: vec![], claim: None, running: None, force: ctx.force };
                return Err(Refused(guards(&g)).into());
            }
            if !ctx.worktree.is_dir() {
                bail!("{} does not exist; nothing to remove", ctx.worktree.display());
            }
            // Preflight (invariant 10): nothing is persisted or signalled if the tree is not safe.
            let mut reasons = guards_with_proof(ctx, collect_facts(ctx.worktree, facts_ctx(ctx, true)), true, None);
            reasons.extend(submodule_reasons(ctx.worktree));
            if !reasons.is_empty() {
                return Err(Refused(reasons).into());
            }
            let branch = git(ctx.worktree, &["symbolic-ref", "--short", "-q", "HEAD"], GIT_QUICK).ok().map(|o| o.text().trim().to_string()).filter(|b| !b.is_empty());
            let head = git(ctx.worktree, &["rev-parse", "HEAD"], GIT_QUICK).ok().map(|o| o.text().trim().to_string());
            let now = crate::claims::now();
            let rec = OpRecord {
                version: 1,
                id: format!("{now:x}-{:x}", std::process::id()),
                project: ctx.project.into(),
                run: ctx.run.into(),
                worktree: canon(ctx.worktree),
                branch,
                head,
                step: Step::Stop,
                archive: None,
                archived_files: 0,
                started: now,
                updated: now,
                finished: None,
                last_error: None,
                backup_ref: None,
            };
            save_op(ctx.db, &rec)?;
            rec
        }
    };
    while rec.step != Step::Done {
        let step = rec.step;
        let res = if matches!(step, Step::DropState | Step::ReleaseLease | Step::Marker) { teardown(ctx, &mut rec) } else { advance(ctx, &mut rec) };
        match res {
            Ok(()) => {
                // Steps 5 to 7 are one commit; the hook still fires for each so a crash can be simulated after any of them.
                let steps: &[Step] = if matches!(step, Step::DropState | Step::ReleaseLease | Step::Marker) { &[Step::DropState, Step::ReleaseLease, Step::Marker] } else { &[step] };
                for s in steps {
                    ctx.host.after_step(*s)?;
                }
            }
            Err(e) => {
                rec.last_error = Some(format!("{e:#}"));
                rec.updated = crate::claims::now();
                let _ = save_op(ctx.db, &rec);
                return Err(e);
            }
        }
    }
    Ok(RmOutcome { run: key, removed: true, archive: rec.archive, archived_files: rec.archived_files, branch: rec.branch, already: false })
}

/// Run one step and record the next. Leaving `Guards` re-checks the claim table in the same
/// transaction that records the transition, so a claim taken meanwhile cannot slip past.
fn advance(ctx: &RmCtx, rec: &mut OpRecord) -> Result<()> {
    let step = rec.step;
    let next = run_step(ctx, rec)?;
    rec.step = next;
    rec.updated = crate::claims::now();
    rec.last_error = None;
    let key = format!("{}/{}", rec.project, rec.run);
    let res = ctx.db.tx(|tx| {
        if step == Step::Guards {
            let held = tx
                .query_opt("SELECT holder, pid, pid_start, since, heartbeat FROM claims WHERE run_key = ?1", [key.as_str()], |r| {
                    Ok(crate::claims::Claim { run: key.clone(), holder: r.get(0)?, pid: r.get::<Option<i64>>(1)?.map(|p| p as i32), start_time: r.get::<Option<i64>>(2)?.map(|t| t as u64), created: r.get::<i64>(3)? as u64, heartbeat: r.get::<i64>(4)? as u64 })
                })?
                .filter(|c| !crate::claims::is_stale(c, rec.updated));
            if let Some(c) = held {
                return Err(Refused(vec![Reason { code: "claim", message: format!("a live writer claim is held by {}; it must release it (or go stale) first", c.holder) }]).into());
            }
        }
        put_op_tx(tx, rec)
    });
    if res.is_err() {
        rec.step = step;
    }
    res
}

/// Steps 5 to 7 in one transaction: forget the run, release its lease and claim, write the marker.
fn teardown(ctx: &RmCtx, rec: &mut OpRecord) -> Result<()> {
    ctx.host.drop_state()?;
    ctx.host.release_lease()?;
    let key = format!("{}/{}", rec.project, rec.run);
    let now = crate::claims::now();
    let mut done = rec.clone();
    done.step = Step::Done;
    done.updated = now;
    done.finished = Some(now);
    done.last_error = None;
    ctx.host.commit_teardown(ctx.db, &mut |tx| {
        tx.execute("DELETE FROM claims WHERE run_key = ?1", [key.as_str()])?;
        tx.execute("DELETE FROM leases WHERE run_key = ?1", [key.as_str()])?;
        tx.execute("DELETE FROM runs WHERE key = ?1", [key.as_str()])?;
        put_op_tx(tx, &done)
    })?;
    *rec = done;
    Ok(())
}

/// Execute `rec.step`; returns the step to record next. May update other record fields.
fn run_step(ctx: &RmCtx, rec: &mut OpRecord) -> Result<Step> {
    match rec.step {
        Step::Stop => {
            ctx.host.stop().context("stopping the run")?;
            Ok(Step::Guards)
        }
        Step::Guards => {
            // A vanished checkout has nothing left to protect; teardown still completes.
            if ctx.worktree.is_dir() {
                let reasons = guards_with_proof(ctx, collect_facts(ctx.worktree, facts_ctx(ctx, false)), true, rec.head.as_deref());
                if !reasons.is_empty() {
                    return Err(Refused(reasons).into());
                }
                Ok(Step::Archive)
            } else {
                Ok(Step::Remove)
            }
        }
        Step::Archive => {
            if !ctx.worktree.is_dir() {
                return Ok(Step::Remove);
            }
            if rec.archive.is_none() {
                let p = archive_path(ctx.archive_root, ctx.project, ctx.run, &compact_ts());
                rec.archive = Some(p);
                save_op(ctx.db, rec)?; // plan the name first, so a retry never writes a second archive
            }
            if rec.archive.as_ref().is_some_and(|d| d.exists()) {
                return Ok(Step::Remove);
            }
            make_archive(ctx, rec)?;
            Ok(Step::Remove)
        }
        Step::Remove => {
            let wt = ctx.worktree;
            if wt.exists() {
                if !is_registered(ctx.repo, wt)? {
                    bail!("{} exists but is not a worktree of this repo any more; refusing to delete it", wt.display());
                }
                // A resumed removal never trusts an earlier step as permission to delete (review #2):
                // the checkout, the live guards and the ignored data are all checked again.
                let now_branch = git(wt, &["symbolic-ref", "--short", "-q", "HEAD"], GIT_QUICK).ok().map(|o| o.text().trim().to_string()).filter(|b| !b.is_empty());
                if rec.branch.is_some() && now_branch != rec.branch {
                    bail!("{} is on {:?} but the removal was planned for {:?}; refusing to delete a different checkout", wt.display(), now_branch, rec.branch);
                }
                let mut reasons = guards_with_proof(ctx, collect_facts_opt(wt, facts_ctx(ctx, false), false), false, rec.head.as_deref());
                reasons.extend(submodule_reasons(wt));
                if !reasons.is_empty() {
                    return Err(Refused(reasons).into());
                }
                refresh_archive(ctx, rec)?;
                if ctx.force {
                    backup_dirty(ctx, rec)?;
                }
                let wt_s = wt.to_string_lossy().into_owned();
                let mut args = vec!["worktree", "remove"];
                if ctx.force {
                    args.push("--force");
                }
                args.extend(["--", &wt_s]);
                git(ctx.repo, &args, GIT_SLOW).map_err(|e| match &e {
                    ExecError::Unknown(_) => anyhow!("git worktree remove finished with an unknown result ({e}); the record is kept, retry to continue"),
                    ExecError::Failed { stderr, .. } if stderr.contains("locked") => anyhow!("git worktree remove refused: the worktree is locked ({}). Run `git worktree unlock {}` if the lock is stale, then retry", stderr.trim(), wt.display()),
                    ExecError::Failed { stderr, .. } if stderr.contains("submodule") => anyhow!("git worktree remove refused: it contains submodules ({}). Deinitialise them (`git submodule deinit --all`) after saving any local commits, then retry", stderr.trim()),
                    _ => anyhow!("git worktree remove: {e}"),
                })?;
            }
            git(ctx.repo, &["worktree", "prune"], GIT_QUICK).map_err(|e| anyhow!("git worktree prune: {e}"))?;
            // Nested branch names leave empty parent folders behind.
            let pdir = canon(&naming::project_dir(ctx.repo));
            let mut parent = rec.worktree.parent();
            while let Some(p) = parent {
                if p == pdir || !p.starts_with(&pdir) || std::fs::remove_dir(p).is_err() {
                    break;
                }
                parent = p.parent();
            }
            Ok(Step::DropState)
        }
        // Steps 5 to 7 run together in `teardown`; a record left at either of the later two (older data) finishes there too.
        Step::DropState | Step::ReleaseLease | Step::Marker | Step::Done => Ok(Step::Done),
    }
}

// ---------------------------------------------------------------- archive helpers

/// Total bytes and newest modification time under `path` (links are never followed; a nested
/// `.git` is counted, unlike `disk_measure`).
fn scan(path: &Path, bytes: &mut u64, newest: &mut std::time::SystemTime) {
    let Ok(meta) = std::fs::symlink_metadata(path) else { return };
    if let Ok(m) = meta.modified() {
        *newest = (*newest).max(m);
    }
    if meta.file_type().is_symlink() {
        return;
    }
    if meta.is_dir() {
        if let Ok(rd) = std::fs::read_dir(path) {
            for e in rd.flatten() {
                scan(&e.path(), bytes, newest);
            }
        }
    } else {
        *bytes += meta.len();
    }
}

/// Members of a tar file, trailing slashes dropped; `None` when it cannot be listed.
fn tar_members(archive: &Path) -> Option<BTreeSet<String>> {
    let mut cmd = Command::new("tar");
    cmd.arg("-tf").arg(archive);
    let out = exec(cmd, TAR_TIMEOUT).ok()?;
    Some(out.text().lines().map(|l| l.trim_end_matches('/').to_string()).collect())
}

/// Does `archive` list every one of `rels`?
fn archive_lists(archive: &Path, rels: &[PathBuf]) -> bool {
    tar_members(archive).is_some_and(|m| rels.iter().all(|r| m.contains(r.to_string_lossy().trim_end_matches('/'))))
}

/// Archive the irreplaceable ignored data to `rec.archive`: size cap first, then write, then
/// read the tar back and confirm every selected path is in it before anything is deleted.
fn make_archive(ctx: &RmCtx, rec: &mut OpRecord) -> Result<()> {
    let dest = rec.archive.clone().ok_or_else(|| anyhow!("no archive path planned"))?;
    let rels = irreplaceable(ctx.worktree, ctx.declared)?;
    rec.archived_files = rels.len();
    if rels.is_empty() {
        rec.archive = None;
        return Ok(());
    }
    let (mut bytes, mut newest) = (0u64, std::time::UNIX_EPOCH);
    for r in &rels {
        scan(&ctx.worktree.join(r), &mut bytes, &mut newest);
    }
    let cap = ctx.archive_cap.unwrap_or(ARCHIVE_MAX_BYTES);
    if bytes > cap {
        return Err(Refused(vec![Reason {
            code: "archive-size",
            message: format!(
                "the ignored data that would be archived is {} (cap {}); move or delete the large files, or declare them as a [[disk.item]], then retry",
                disk::human_bytes(bytes),
                disk::human_bytes(cap)
            ),
        }])
        .into());
    }
    write_archive(ctx.worktree, &rels, &dest)?;
    if !archive_lists(&dest, &rels) {
        let _ = std::fs::remove_file(&dest);
        bail!("the archive {} does not list every selected file; nothing was deleted", dest.display());
    }
    Ok(())
}

/// Just before deleting: if ignored data changed or appeared after the archive was written, or
/// the archive no longer lists everything, write a fresh archive generation (review #2).
fn refresh_archive(ctx: &RmCtx, rec: &mut OpRecord) -> Result<()> {
    let rels = irreplaceable(ctx.worktree, ctx.declared)?;
    if rels.is_empty() {
        return Ok(());
    }
    let ok = rec.archive.as_ref().is_some_and(|a| {
        let Ok(am) = std::fs::metadata(a).and_then(|m| m.modified()) else { return false };
        let (mut b, mut newest) = (0u64, std::time::UNIX_EPOCH);
        for r in &rels {
            scan(&ctx.worktree.join(r), &mut b, &mut newest);
        }
        newest <= am && archive_lists(a, &rels)
    });
    if ok {
        return Ok(());
    }
    let mut ts = compact_ts();
    let mut dest = archive_path(ctx.archive_root, ctx.project, ctx.run, &ts);
    let mut n = 1;
    while dest.exists() {
        ts = format!("{}{n}", compact_ts());
        dest = archive_path(ctx.archive_root, ctx.project, ctx.run, &ts);
        n += 1;
    }
    rec.archive = Some(dest);
    save_op(ctx.db, rec)?;
    make_archive(ctx, rec)?;
    save_op(ctx.db, rec)
}

/// Initialised submodules keep their git data inside the superproject's admin dir, which
/// `git worktree remove` deletes: refuse until they are dealt with (never retried as "unknown").
fn submodule_reasons(wt: &Path) -> Vec<Reason> {
    if !wt.join(".gitmodules").exists() {
        return vec![];
    }
    match git(wt, &["submodule", "status"], GIT_QUICK) {
        Ok(o) => {
            let live = o.text().lines().filter(|l| !l.trim().is_empty() && !l.starts_with('-')).count();
            if live == 0 {
                vec![]
            } else {
                vec![Reason { code: "submodule", message: format!("{live} initialised submodule(s): their local commits live inside the worktree's git data. Run `git submodule deinit --all` (after pushing anything local) and retry") }]
            }
        }
        Err(e) => vec![Reason { code: "submodule", message: format!("could not inspect submodules: {e}") }],
    }
}

/// `--force` discards dirty changes: save them first as a commit under `refs/setu-backup/<branch>`
/// (tracked edits and untracked files; ignored files are archived instead).
fn backup_dirty(ctx: &RmCtx, rec: &mut OpRecord) -> Result<()> {
    let wt = ctx.worktree;
    let dirty = git(wt, &["status", "--porcelain", "--untracked-files=all"], GIT_SLOW).map_err(|e| anyhow!("could not read the worktree status before a forced removal: {e}"))?;
    if dirty.stdout.is_empty() {
        return Ok(());
    }
    let name = match &rec.branch {
        Some(b) => b.clone(),
        None => format!("detached-{}", rec.head.as_deref().unwrap_or("head").chars().take(12).collect::<String>()),
    };
    let refname = format!("refs/setu-backup/{name}");
    let idx = ctx.archive_root.join(format!(".backup-index-{}-{}", std::process::id(), TMP_N.fetch_add(1, std::sync::atomic::Ordering::Relaxed)));
    std::fs::create_dir_all(ctx.archive_root)?;
    let with_idx = |args: &[&str]| -> std::result::Result<Out, ExecError> {
        let mut c = git_cmd(wt, args);
        c.env("GIT_INDEX_FILE", &idx).env("GIT_AUTHOR_NAME", "setu").env("GIT_AUTHOR_EMAIL", "setu@localhost").env("GIT_COMMITTER_NAME", "setu").env("GIT_COMMITTER_EMAIL", "setu@localhost");
        exec(c, GIT_SLOW)
    };
    let res = (|| -> Result<String> {
        with_idx(&["read-tree", "HEAD"]).map_err(|e| anyhow!("backup: {e}"))?;
        with_idx(&["add", "-A"]).map_err(|e| anyhow!("backup: {e}"))?;
        let tree = with_idx(&["write-tree"]).map_err(|e| anyhow!("backup: {e}"))?.text().trim().to_string();
        let msg = format!("setu backup of uncommitted changes before a forced removal of {}", ctx.run);
        let commit = with_idx(&["-c", "commit.gpgsign=false", "commit-tree", &tree, "-p", "HEAD", "-m", &msg]).map_err(|e| anyhow!("backup: {e}"))?.text().trim().to_string();
        git_ok(wt, &["update-ref", &refname, &commit])?;
        Ok(refname.clone())
    })();
    let _ = std::fs::remove_file(&idx);
    rec.backup_ref = Some(res.context("saving the uncommitted changes before a forced removal failed; nothing was deleted")?);
    save_op(ctx.db, rec)
}

static TMP_N: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

// ---------------------------------------------------------------- removed list

/// Finished removals that `restore` can still work from, newest first (read-only, for the app).
/// `archive_size` is null when the archive file is gone (pruned): the branch alone can still be restored.
pub fn removed_list(db: &Db) -> Vec<serde_json::Value> {
    let mut rows: Vec<(u64, serde_json::Value)> = Vec::new();
    for r in all_ops(db) {
        if r.step != Step::Done {
            continue;
        }
        let at = r.finished.unwrap_or(r.updated);
        let size = r.archive.as_ref().and_then(|a| std::fs::metadata(a).ok()).map(|m| m.len());
        rows.push((
            at,
            serde_json::json!({
                "run": format!("{}/{}", r.project, r.run),
                "project": r.project,
                "branch": r.branch,
                "removed_at": at,
                "archive": r.archive,
                "archive_size": size,
            }),
        ));
    }
    rows.sort_by(|a, b| b.0.cmp(&a.0));
    rows.into_iter().map(|(_, v)| v).collect()
}

// ---------------------------------------------------------------- restore

#[derive(Debug, Clone, Serialize)]
pub struct RestoreOutcome {
    pub path: PathBuf,
    pub run: String,
    pub branch: Option<String>,
    pub restored_from: Option<PathBuf>,
    pub warnings: Vec<String>,
}

/// Recreate a removed worktree from its kept branch and put the archived files back. Setup
/// steps are not rerun (dependencies come back through the project's own install).
pub fn restore(cfg: &ProjectConfig, run: &str, ops: &Db, archive_root: &Path) -> Result<RestoreOutcome> {
    let key = format!("{}/{run}", cfg.project);
    let rec = load_op(ops, &key)?.ok_or_else(|| anyhow!("no removal record for {key}; nothing to restore"))?;
    if rec.step != Step::Done {
        bail!("the removal of {key} is not finished (at step {:?}); retry `setu rm {key}` first", rec.step);
    }
    let path = rec.worktree.clone();
    if std::fs::symlink_metadata(&path).is_ok() {
        bail!("{} already exists", path.display());
    }
    // Only the archive this removal recorded is ever restored; another removal's archive of the
    // same run name is a different checkout's data (review #17).
    let archive = rec.archive.clone().filter(|a| a.exists() && a.starts_with(archive_root));
    let members = match &archive {
        Some(a) => {
            let m = tar_members(a).ok_or_else(|| anyhow!("cannot read the archive {}; it is kept, nothing was restored", a.display()))?;
            if let Some(bad) = m.iter().find(|n| Path::new(n).is_absolute() || Path::new(n).components().any(|c| !matches!(c, std::path::Component::Normal(_) | std::path::Component::CurDir))) {
                bail!("the archive {} has an unsafe member path {bad:?}; refusing to extract it", a.display());
            }
            m
        }
        None => BTreeSet::new(),
    };
    let repo = cfg.repo.as_path();
    let _ = git(repo, &["worktree", "prune"], GIT_QUICK);
    let path_s = path.to_string_lossy().into_owned();
    let mut warnings = Vec::new();
    match (&rec.branch, &rec.head) {
        (Some(b), _) => {
            valid_ref_arg("branch", b)?;
            if git_probe(repo, &["show-ref", "--verify", "--quiet", &format!("refs/heads/{b}")])? {
                git(repo, &["worktree", "add", "--", &path_s, b], GIT_SLOW).map_err(|e| anyhow!("git worktree add: {e}"))?;
            } else if git_probe(repo, &["show-ref", "--verify", "--quiet", &format!("refs/remotes/origin/{b}")])? {
                git(repo, &["worktree", "add", "--track", "-b", b, "--", &path_s, &format!("origin/{b}")], GIT_SLOW).map_err(|e| anyhow!("git worktree add: {e}"))?;
            } else {
                bail!("branch {b} no longer exists locally or on origin; nothing to restore from");
            }
        }
        (None, Some(h)) => {
            valid_ref_arg("commit", h)?;
            git(repo, &["worktree", "add", "--detach", "--", &path_s, h], GIT_SLOW).map_err(|e| anyhow!("git worktree add: {e}"))?;
        }
        (None, None) => bail!("the removal record has neither a branch nor a commit"),
    }
    if let (Some(want), Ok(now)) = (&rec.head, git(&path, &["rev-parse", "HEAD"], GIT_QUICK)) {
        if now.text().trim() != want {
            warnings.push(format!("the branch moved since the removal: it was at {} and is now at {}", &want[..want.len().min(12)], &now.text().trim()[..now.text().trim().len().min(12)]));
        }
    }
    if let Some(b) = &rec.backup_ref {
        warnings.push(format!("uncommitted changes discarded by the forced removal are saved at {b}"));
    }
    warnings.extend(link_files(cfg, &path)?);
    match &archive {
        Some(a) => {
            // A member must not be written through a link (a linked file in the new worktree points into main).
            let through_link = members.iter().find(|m| {
                let mut cur = path.clone();
                let comps: Vec<_> = Path::new(m).components().collect();
                comps.iter().take(comps.len().saturating_sub(1)).any(|c| {
                    cur.push(c);
                    std::fs::symlink_metadata(&cur).is_ok_and(|md| md.file_type().is_symlink())
                })
            });
            if let Some(m) = through_link {
                warnings.push(format!("the archive was not extracted: {m} would be written through a link; it is kept at {}", a.display()));
            } else {
                for m in &members {
                    if std::fs::symlink_metadata(path.join(m)).is_ok_and(|md| !md.is_dir()) {
                        warnings.push(format!("{m} already exists in the restored worktree; the archived copy was not applied"));
                    }
                }
                let mut cmd = Command::new("tar");
                cmd.arg("-xkf").arg(a).arg("--no-same-owner").arg("-C").arg(&path);
                exec(cmd, TAR_TIMEOUT).map_err(|e| anyhow!("restoring {}: {e}", a.display()))?;
            }
        }
        None => warnings.push("nothing was archived for this removal; only the branch was restored".into()),
    }
    ops.with(|c| c.execute("DELETE FROM removal_ops WHERE run_key = ?1", [key.as_str()]))?;
    Ok(RestoreOutcome { path: canon(&path), run: run.to_string(), branch: rec.branch, restored_from: archive, warnings })
}

// ---------------------------------------------------------------- audit

/// Record a worktree event (`autoremove-*` ops are kind `autoremove`). Failures are reported, never raised.
pub fn audit(actor: &str, client: Option<&str>, op: &str, run: &str, extra: serde_json::Value) {
    let kind = if op.starts_with("autoremove-") { "autoremove" } else { "worktree" };
    crate::db::record(crate::db::Event {
        ts: crate::db::now_secs(),
        actor: Some(actor.into()),
        client: client.map(String::from),
        kind,
        op: op.into(),
        run_key: Some(run.to_string()).filter(|r| !r.is_empty()),
        scope: None,
        name: None,
        detail: extra,
    });
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use crate::model::{DiskItem, DiskKind};
    use std::fs;
    use std::sync::Mutex;

    pub(crate) fn g(dir: &Path, args: &[&str]) -> String {
        let o = Command::new("git")
            .current_dir(dir)
            .args(["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", "-c", "protocol.file.allow=always", "-c", "maintenance.auto=false", "-c", "gc.auto=0"])
            .args(args)
            .output()
            .unwrap();
        assert!(o.status.success(), "git {:?}: {}", args, String::from_utf8_lossy(&o.stderr));
        String::from_utf8_lossy(&o.stdout).trim().to_string()
    }

    pub(crate) struct Fx {
        pub(crate) root: PathBuf,
        pub(crate) origin: PathBuf,
        pub(crate) repo: PathBuf,
        pub(crate) pdir: PathBuf,
        pub(crate) ops: Db,
        pub(crate) logs: PathBuf,
        pub(crate) archives: PathBuf,
        pub(crate) cfg: ProjectConfig,
    }

    impl Drop for Fx {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.root);
        }
    }

    /// origin.git (bare) <- app.git (bare clone WITH a remote-tracking refspec) + app/main worktree.
    pub(crate) fn fx(tag: &str) -> Fx {
        let root = canon(&std::env::temp_dir()).join(format!("setu-wt-{tag}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        let seed = root.join("seed");
        fs::create_dir_all(&seed).unwrap();
        g(&seed, &["init", "-q", "-b", "main"]);
        fs::write(seed.join(".gitignore"), "*.db\n.env.local\n.next/\nnode_modules/\nscratch/\nsetup-*.txt\n").unwrap();
        fs::write(seed.join("README.md"), "hi\n").unwrap();
        g(&seed, &["add", "."]);
        g(&seed, &["commit", "-q", "-m", "init"]);
        g(&root, &["clone", "-q", "--bare", "seed", "origin.git"]);
        g(&root, &["clone", "-q", "--bare", "origin.git", "app.git"]);
        let repo = root.join("app.git");
        g(&repo, &["config", "remote.origin.fetch", "+refs/heads/*:refs/remotes/origin/*"]);
        g(&repo, &["fetch", "-q", "origin"]);
        assert!(!g(&repo, &["rev-parse", "origin/main"]).is_empty(), "fixture: origin/main must resolve");
        let pdir = root.join("app");
        g(&repo, &["worktree", "add", "-q", pdir.join("main").to_str().unwrap(), "main"]);
        let cfg = ProjectConfig {
            project: "app".into(),
            repo: repo.clone(),
            domain: "app.local".into(),
            idle: Duration::from_secs(60),
            aliases: vec![],
            max_running: 3,
            ports: vec![],
            env: Default::default(),
            procs: Default::default(),
            presets: vec![],
            disk_items: vec![
                DiskItem { name: "deps".into(), kind: DiskKind::Deps, paths: vec!["node_modules".into()], clean_after: None, install: None },
                DiskItem { name: "next".into(), kind: DiskKind::Cache, paths: vec![".next".into(), "scratch/.next".into()], clean_after: None, install: None },
            ],
            stores: vec![],
            worktree: WorktreeCfg { min_free: Some(0), ..Default::default() },
            setup_steps: vec![],
            auto_install: true,
        };
        Fx { origin: root.join("origin.git"), ops: Db::open(&root.join("ops/setu.db")).unwrap(), logs: root.join("logs"), archives: root.join("archives"), root, repo, pdir, cfg }
    }

    pub(crate) fn new_wt(f: &Fx, branch: &str) -> NewOutcome {
        create(&f.cfg, branch, None, &BTreeSet::new(), &f.ops, &f.logs, |_, _| Ok(BTreeMap::new())).unwrap()
    }

    #[derive(Default)]
    struct Host {
        claim: Option<String>,
        running: Option<String>,
        /// Run the teardown statements, then fail before commit (a crash inside steps 5 to 7).
        fail_commit: bool,
        fail_after: Mutex<Option<Step>>,
        calls: Mutex<Vec<&'static str>>,
    }

    impl RmHost for Host {
        fn stop(&self) -> Result<()> {
            self.calls.lock().unwrap().push("stop");
            Ok(())
        }
        fn claim_holder(&self) -> Option<String> {
            self.claim.clone()
        }
        fn running(&self) -> Option<String> {
            self.running.clone()
        }
        fn drop_state(&self) -> Result<()> {
            self.calls.lock().unwrap().push("drop");
            Ok(())
        }
        fn release_lease(&self) -> Result<()> {
            self.calls.lock().unwrap().push("lease");
            Ok(())
        }
        fn commit_teardown(&self, db: &Db, extra: &mut dyn FnMut(&crate::db::Conn) -> Result<()>) -> Result<()> {
            db.tx(|tx| {
                extra(tx)?;
                if self.fail_commit {
                    bail!("simulated crash before commit");
                }
                Ok(())
            })
        }
        fn after_step(&self, step: Step) -> Result<()> {
            if *self.fail_after.lock().unwrap() == Some(step) {
                bail!("simulated crash after {step:?}");
            }
            Ok(())
        }
    }

    fn do_rm(f: &Fx, run: &str, wt: &Path, force: bool, host: &Host) -> Result<RmOutcome> {
        let declared: Vec<String> = f.cfg.disk_items.iter().flat_map(|i| i.paths.clone()).collect();
        rm(&RmCtx { project: "app", run, worktree: wt, repo: &f.repo, declared: &declared, archive_root: &f.archives, db: &f.ops, force, host, archive_cap: None, merge_proof: None })
    }

    fn input() -> GuardInput {
        GuardInput { is_main: false, dirty: Fact::Known(vec![]), unpushed: Fact::Known(vec![]), fetch: Fact::Known(()), procs: vec![], claim: None, running: None, force: false }
    }

    fn codes(i: &GuardInput) -> Vec<&'static str> {
        guards(i).into_iter().map(|r| r.code).collect()
    }

    // ---- guards (pure)

    #[test]
    fn guards_clean_input_has_no_reasons() {
        assert!(guards(&input()).is_empty());
    }

    #[test]
    fn guards_each_reason() {
        assert_eq!(codes(&GuardInput { is_main: true, ..input() }), ["main"]);
        assert_eq!(codes(&GuardInput { dirty: Fact::Known(vec!["?? a".into()]), ..input() }), ["dirty"]);
        assert_eq!(codes(&GuardInput { dirty: Fact::Unknown("timed out".into()), ..input() }), ["dirty"]);
        assert_eq!(codes(&GuardInput { unpushed: Fact::Known(vec!["abc1234 wip".into()]), ..input() }), ["unpushed"]);
        assert_eq!(codes(&GuardInput { unpushed: Fact::Unknown("x".into()), ..input() }), ["unpushed"]);
        assert_eq!(codes(&GuardInput { fetch: Fact::Unknown("offline".into()), ..input() }), ["fetch"]);
        assert_eq!(codes(&GuardInput { procs: vec![42], ..input() }), ["processes"]);
        assert_eq!(codes(&GuardInput { claim: Some("agent-a".into()), ..input() }), ["claim"]);
        assert_eq!(codes(&GuardInput { running: Some("running".into()), ..input() }), ["running"]);
        let all = GuardInput {
            is_main: true,
            dirty: Fact::Known(vec!["x".into()]),
            unpushed: Fact::Known(vec!["y".into()]),
            fetch: Fact::Unknown("z".into()),
            procs: vec![1],
            claim: Some("a".into()),
            running: Some("running".into()),
            force: false,
        };
        assert_eq!(codes(&all).len(), 7);
    }

    #[test]
    fn force_skips_only_dirty_unpushed_and_fetch() {
        let all = GuardInput {
            is_main: true,
            dirty: Fact::Known(vec!["x".into()]),
            unpushed: Fact::Known(vec!["y".into()]),
            fetch: Fact::Unknown("z".into()),
            procs: vec![1],
            claim: Some("a".into()),
            running: Some("running".into()),
            force: true,
        };
        assert_eq!(codes(&all), ["main", "claim", "running", "processes"]);
    }

    // ---- guards (facts from real repos)

    #[test]
    fn facts_clean_dirty_untracked_unpushed() {
        let f = fx("facts");
        let o = new_wt(&f, "feat/x");
        let ctx = |force| FactCtx { is_main: false, claim: None, running: None, force, skip_procs: true };
        assert!(guards(&collect_facts(&o.path, ctx(false))).is_empty(), "fresh worktree is clean");
        // untracked
        fs::write(o.path.join("new.txt"), "x").unwrap();
        assert_eq!(codes(&collect_facts(&o.path, ctx(false))), ["dirty"]);
        fs::remove_file(o.path.join("new.txt")).unwrap();
        // modified tracked file
        fs::write(o.path.join("README.md"), "changed\n").unwrap();
        assert_eq!(codes(&collect_facts(&o.path, ctx(false))), ["dirty"]);
        g(&o.path, &["commit", "-q", "-am", "local only"]);
        assert_eq!(codes(&collect_facts(&o.path, ctx(false))), ["unpushed"]);
        assert!(guards(&collect_facts(&o.path, ctx(true))).is_empty(), "force skips unpushed");
        // pushing makes it safe, and a merged-away remote branch is verified by the fresh fetch
        g(&o.path, &["push", "-q", "origin", "feat/x"]);
        assert!(guards(&collect_facts(&o.path, ctx(false))).is_empty());
    }

    #[test]
    fn facts_fetch_failure_is_a_reason() {
        let f = fx("fetchfail");
        let o = new_wt(&f, "feat/y");
        g(&f.repo, &["config", "remote.origin.url", "/nonexistent/nowhere.git"]);
        let got = guards(&collect_facts(&o.path, FactCtx { is_main: false, claim: None, running: None, force: false, skip_procs: true }));
        assert!(got.iter().any(|r| r.code == "fetch"), "{got:?}");
    }

    #[test]
    fn facts_detached_head_commit_is_unpushed() {
        let f = fx("detached");
        let o = new_wt(&f, "feat/d");
        g(&o.path, &["checkout", "-q", "--detach"]);
        fs::write(o.path.join("README.md"), "detached work\n").unwrap();
        g(&o.path, &["commit", "-q", "-am", "only on detached head"]);
        let got = guards(&collect_facts(&o.path, FactCtx { is_main: false, claim: None, running: None, force: false, skip_procs: true }));
        assert!(got.iter().any(|r| r.code == "unpushed"), "{got:?}");
    }

    #[test]
    fn facts_process_inside_is_a_reason() {
        let f = fx("proc");
        let o = new_wt(&f, "feat/p");
        let mut child = Command::new("sleep").arg("30").current_dir(&o.path).spawn().unwrap();
        let got = guards(&collect_facts(&o.path, FactCtx { is_main: false, claim: None, running: None, force: false, skip_procs: false }));
        let skipped = guards(&collect_facts(&o.path, FactCtx { is_main: false, claim: None, running: None, force: false, skip_procs: true }));
        let _ = child.kill();
        let _ = child.wait();
        assert!(got.iter().any(|r| r.code == "processes"), "{got:?}");
        assert!(skipped.is_empty());
    }

    // ---- base, new

    #[test]
    fn base_resolution() {
        let f = fx("base");
        assert_eq!(resolve_base(&f.repo, &WorktreeCfg::default(), None).unwrap(), "origin/main");
        // origin grows a staging branch; after a fetch it wins
        g(&f.origin, &["branch", "staging", "main"]);
        g(&f.repo, &["fetch", "-q", "origin"]);
        assert_eq!(resolve_base(&f.repo, &WorktreeCfg::default(), None).unwrap(), "origin/staging");
        let cfg = WorktreeCfg { base: Some("origin/main".into()), ..Default::default() };
        assert_eq!(resolve_base(&f.repo, &cfg, None).unwrap(), "origin/main");
        assert_eq!(resolve_base(&f.repo, &cfg, Some("origin/staging")).unwrap(), "origin/staging", "--from beats config");
        assert!(resolve_base(&f.repo, &cfg, Some("origin/nope")).is_err());
        assert!(resolve_base(&f.repo, &cfg, Some("--upload-pack=x")).is_err());
    }

    #[test]
    fn new_links_copies_runs_setup_and_stays_clean() {
        let mut f = fx("new");
        let main = f.pdir.join("main");
        fs::write(main.join(".env.local"), "TOKEN=fake\n").unwrap();
        fs::write(main.join("seed.db"), "seed-data").unwrap();
        fs::write(main.join("README.md"), "tracked\n").unwrap();
        f.cfg.worktree.link = vec![".env.local".into(), "missing.env".into()];
        f.cfg.worktree.copy = vec!["seed.db".into(), "README.md".into()];
        f.cfg.setup_steps = vec![
            SetupStep { name: "one".into(), run: "echo step-one-out; echo $SETU_TEST > setup-1.txt".into(), inputs: vec![] },
            SetupStep { name: "two".into(), run: "echo two > setup-2.txt".into(), inputs: vec![] },
        ];
        let out = create(&f.cfg, "feat/x", None, &BTreeSet::new(), &f.ops, &f.logs, |p, run| {
            assert_eq!(run, "feat-x");
            assert!(p.exists());
            Ok(BTreeMap::from([("SETU_TEST".to_string(), "from-run-env".to_string())]))
        })
        .unwrap();
        assert_eq!(out.base, "origin/main");
        assert_eq!(out.path, canon(&f.pdir.join("feat/x")));
        assert!(fs::symlink_metadata(out.path.join(".env.local")).unwrap().file_type().is_symlink());
        assert_eq!(fs::read_to_string(out.path.join(".env.local")).unwrap(), "TOKEN=fake\n");
        assert_eq!(fs::read_to_string(out.path.join("seed.db")).unwrap(), "seed-data");
        assert!(!fs::symlink_metadata(out.path.join("seed.db")).unwrap().file_type().is_symlink());
        assert_eq!(fs::read_to_string(out.path.join("README.md")).unwrap(), "hi\n", "tracked files are not copied over the checkout");
        assert!(out.warnings.iter().any(|w| w.contains("missing.env")));
        assert!(out.warnings.iter().any(|w| w.contains("README.md") && w.contains("not git-ignored")));
        assert_eq!(out.setup.len(), 2);
        assert_eq!(fs::read_to_string(out.path.join("setup-1.txt")).unwrap().trim(), "from-run-env");
        let log = fs::read_to_string(out.setup_log.unwrap()).unwrap();
        assert!(log.contains("step-one-out") && log.contains("setup two ok"), "{log}");
        assert_eq!(g(&out.path, &["status", "--porcelain"]), "", "links and setup output must not make the worktree dirty");
        assert!(g(&out.path, &["rev-parse", "--abbrev-ref", "HEAD"]).contains("feat/x"));
    }

    #[test]
    fn new_refusals_and_failing_setup_keeps_worktree() {
        let mut f = fx("newbad");
        let run = |f: &Fx, b: &str, existing: &BTreeSet<String>| create(&f.cfg, b, None, existing, &f.ops, &f.logs, |_, _| Ok(BTreeMap::new()));
        assert!(run(&f, "-x", &BTreeSet::new()).is_err());
        assert!(run(&f, "bad name", &BTreeSet::new()).is_err());
        assert!(run(&f, "a..b", &BTreeSet::new()).is_err());
        assert!(run(&f, "main", &BTreeSet::new()).unwrap_err().to_string().contains("main worktree"), "main is reserved");
        new_wt(&f, "feat/a");
        assert!(run(&f, "feat/a", &BTreeSet::new()).is_err(), "existing worktree");
        g(&f.repo, &["branch", "old-branch", "main"]);
        assert!(run(&f, "old-branch", &BTreeSet::new()).unwrap_err().to_string().contains("restore"));
        assert!(run(&f, "feat/b", &BTreeSet::from(["app/feat-b".to_string()])).unwrap_err().to_string().contains("already exists"));
        // run-name collision with a different path: feat-c vs feat/c
        new_wt(&f, "feat-c");
        assert!(run(&f, "feat/c", &BTreeSet::new()).is_err());
        // disk floor
        f.cfg.worktree.min_free = Some(u64::MAX);
        assert!(run(&f, "feat/d", &BTreeSet::new()).unwrap_err().to_string().contains("free"));
        f.cfg.worktree.min_free = Some(0);
        // failing setup leaves the worktree in place and says so
        f.cfg.setup_steps = vec![SetupStep { name: "boom".into(), run: "exit 3".into(), inputs: vec![] }];
        let e = run(&f, "feat/e", &BTreeSet::new()).unwrap_err();
        assert!(format!("{e:#}").contains("boom") && format!("{e:#}").contains("kept"), "{e:#}");
        assert!(f.pdir.join("feat/e").exists());
        // a pending removal blocks new
        let key = "app/feat-f";
        let rec = OpRecord { version: 1, id: "x".into(), project: "app".into(), run: "feat-f".into(), worktree: f.pdir.join("feat/f"), branch: None, head: None, step: Step::Archive, archive: None, archived_files: 0, started: 0, updated: 0, finished: None, last_error: None, backup_ref: None };
        save_op(&f.ops, &rec).unwrap();
        assert!(pending_removal(&f.ops, key));
        assert!(run(&f, "feat/f", &BTreeSet::new()).unwrap_err().to_string().contains("pending"));
    }

    #[test]
    fn new_tracks_an_existing_remote_branch() {
        let f = fx("remotebranch");
        let o = new_wt(&f, "feat/r");
        fs::write(o.path.join("a.txt"), "a").unwrap();
        g(&o.path, &["add", "."]);
        g(&o.path, &["commit", "-q", "-m", "a"]);
        g(&o.path, &["push", "-q", "origin", "feat/r"]);
        // remove the local worktree and branch, keep the remote branch
        g(&f.repo, &["worktree", "remove", "--force", o.path.to_str().unwrap()]);
        g(&f.repo, &["branch", "-D", "feat/r"]);
        let again = new_wt(&f, "feat/r");
        assert_eq!(again.base, "origin/feat/r");
        assert!(again.path.join("a.txt").exists());
    }

    #[test]
    fn adopt_checks_membership_only() {
        let f = fx("adopt");
        let o = new_wt(&f, "feat/ad");
        let (p, run) = adopt_check(&f.cfg, &o.path).unwrap();
        assert_eq!(run, "feat-ad");
        assert_eq!(p, o.path);
        assert!(adopt_check(&f.cfg, &f.root).is_err());
    }

    // ---- archive selection

    #[test]
    fn archive_selection_excludes_declared_and_deps_includes_the_rest() {
        let f = fx("select");
        let o = new_wt(&f, "feat/s");
        let w = &o.path;
        for (p, c) in [
            (".env.local", "secret"),
            ("local.db", "db"),
            (".next/cache/c.bin", "cache"),
            ("node_modules/pkg/i.js", "dep"),
            ("scratch/keep.txt", "keep me"),
            ("scratch/.next/cache/z", "regen"),
            ("nested/node_modules/x/y", "dep2"),
        ] {
            fs::create_dir_all(w.join(p).parent().unwrap()).unwrap();
            fs::write(w.join(p), c).unwrap();
        }
        // nested/ is only partially ignored, so git lists node_modules itself, which we skip
        std::os::unix::fs::symlink(f.pdir.join("main/README.md"), w.join("link.db")).unwrap();
        let declared: Vec<String> = f.cfg.disk_items.iter().flat_map(|i| i.paths.clone()).collect();
        let got: Vec<String> = irreplaceable(w, &declared).unwrap().iter().map(|p| p.to_string_lossy().into_owned()).collect();
        assert!(got.contains(&".env.local".to_string()), "{got:?}");
        assert!(got.contains(&"local.db".to_string()), "{got:?}");
        assert!(got.contains(&"scratch/keep.txt".to_string()), "directory containing a declared path is expanded: {got:?}");
        for bad in [".next", "node_modules", "scratch/.next", "scratch", "link.db", "nested", "nested/node_modules"] {
            assert!(!got.iter().any(|p| p.trim_end_matches('/') == bad), "{bad} must not be archived whole: {got:?}");
        }
        assert!(!got.iter().any(|p| p.contains("node_modules") || p.contains(".next")), "{got:?}");
        // the tar holds exactly the selection and keeps content
        let dest = f.archives.join("app/feat-s/t1.tar");
        let rels = irreplaceable(w, &declared).unwrap();
        write_archive(w, &rels, &dest).unwrap();
        assert_eq!(fs::metadata(&dest).unwrap().permissions().mode() & 0o777, 0o600);
        let listing = String::from_utf8(Command::new("tar").arg("-tf").arg(&dest).output().unwrap().stdout).unwrap();
        assert!(listing.contains("local.db") && listing.contains(".env.local") && listing.contains("scratch/keep.txt"), "{listing}");
        assert!(!listing.contains("node_modules") && !listing.contains("c.bin") && !listing.contains("regen"), "{listing}");
        assert_eq!(latest_archive(&f.archives, "app", "feat-s"), Some(dest));
    }

    // ---- rm

    #[test]
    fn rm_happy_path_archives_removes_keeps_branch_and_is_idempotent() {
        let f = fx("rm");
        let o = new_wt(&f, "feat/rm");
        fs::write(o.path.join("local.db"), "precious").unwrap();
        fs::create_dir_all(o.path.join("node_modules/p")).unwrap();
        fs::write(o.path.join("node_modules/p/i.js"), "x").unwrap();
        let host = Host::default();
        let out = do_rm(&f, "feat-rm", &o.path, false, &host).unwrap();
        assert!(out.removed && !out.already);
        assert_eq!(out.archived_files, 1);
        let arch = out.archive.clone().unwrap();
        assert!(arch.exists() && arch.starts_with(&f.archives));
        assert!(!o.path.exists());
        assert!(!f.pdir.join("feat").exists(), "empty parent of a nested branch is tidied");
        assert!(!worktree_entries(&f.repo).unwrap().iter().any(|(p, _)| canon(p) == o.path));
        g(&f.repo, &["show-ref", "--verify", "refs/heads/feat/rm"]); // branch kept
        assert_eq!(*host.calls.lock().unwrap(), ["stop", "drop", "lease"]);
        let marker = load_op(&f.ops, "app/feat-rm").unwrap().unwrap();
        assert_eq!(marker.step, Step::Done);
        assert_eq!(marker.branch.as_deref(), Some("feat/rm"));
        let again = do_rm(&f, "feat-rm", &o.path, false, &host).unwrap();
        assert!(again.already);
        assert_eq!(host.calls.lock().unwrap().len(), 3, "a finished removal repeats nothing");
    }

    #[test]
    fn rm_refusals_persist_nothing_and_force_is_narrow() {
        let f = fx("rmrefuse");
        let o = new_wt(&f, "feat/n");
        let host = Host::default();
        // dirty with an untracked file
        fs::write(o.path.join("u.txt"), "u").unwrap();
        let e = do_rm(&f, "feat-n", &o.path, false, &host).unwrap_err();
        assert!(e.downcast_ref::<Refused>().unwrap().0.iter().any(|r| r.code == "dirty"));
        assert!(load_op(&f.ops, "app/feat-n").unwrap().is_none(), "invariant 10: nothing persisted");
        assert!(host.calls.lock().unwrap().is_empty(), "nothing stopped before the preflight passes");
        assert!(o.path.exists());
        // a live claim refuses even with force
        let claimed = Host { claim: Some("agent-a".into()), ..Default::default() };
        let e = do_rm(&f, "feat-n", &o.path, true, &claimed).unwrap_err();
        assert!(e.downcast_ref::<Refused>().unwrap().0.iter().any(|r| r.code == "claim"));
        assert!(o.path.exists() && load_op(&f.ops, "app/feat-n").unwrap().is_none());
        // main is never removed, forced or not
        let main = f.pdir.join("main");
        for force in [false, true] {
            let e = do_rm(&f, "main", &main, force, &host).unwrap_err();
            assert!(e.downcast_ref::<Refused>().unwrap().0.iter().any(|r| r.code == "main"));
        }
        assert!(main.exists());
        // force removes a dirty tree and still archives ignored data
        fs::write(o.path.join("local.db"), "keep").unwrap();
        let out = do_rm(&f, "feat-n", &o.path, true, &host).unwrap();
        assert!(out.removed && out.archive.is_some());
        assert!(!o.path.exists());
    }

    #[test]
    fn rm_blocked_while_the_run_is_up_after_stop() {
        let f = fx("rmrunning");
        let o = new_wt(&f, "feat/u");
        let host = Host { running: Some("running".into()), ..Default::default() };
        let e = do_rm(&f, "feat-u", &o.path, false, &host).unwrap_err();
        assert!(e.downcast_ref::<Refused>().unwrap().0.iter().any(|r| r.code == "running"));
        // the record sits at Guards, so a retry after the run is really stopped completes
        assert_eq!(load_op(&f.ops, "app/feat-u").unwrap().unwrap().step, Step::Guards);
        assert!(o.path.exists());
        let ok = Host::default();
        assert!(do_rm(&f, "feat-u", &o.path, false, &ok).unwrap().removed);
    }

    #[test]
    fn rm_crash_after_archive_resumes_without_a_second_archive() {
        let f = fx("rmcrash");
        let o = new_wt(&f, "feat/c1");
        fs::write(o.path.join("local.db"), "precious").unwrap();
        let crashy = Host::default();
        *crashy.fail_after.lock().unwrap() = Some(Step::Archive);
        let e = do_rm(&f, "feat-c1", &o.path, false, &crashy).unwrap_err();
        assert!(e.to_string().contains("simulated crash"));
        let rec = load_op(&f.ops, "app/feat-c1").unwrap().unwrap();
        assert_eq!(rec.step, Step::Remove, "the archive step was recorded as complete");
        assert!(o.path.exists(), "nothing removed yet");
        let archive = rec.archive.clone().unwrap();
        assert!(archive.exists());
        assert!(pending_removal(&f.ops, "app/feat-c1"));
        // retry with a healthy host: resumes at Remove, does not stop or archive again
        let ok = Host::default();
        let out = do_rm(&f, "feat-c1", &o.path, false, &ok).unwrap();
        assert!(out.removed);
        assert_eq!(out.archive, Some(archive.clone()));
        assert_eq!(*ok.calls.lock().unwrap(), ["drop", "lease"], "stop was already recorded");
        assert!(!o.path.exists());
        let tars: Vec<_> = fs::read_dir(archive.parent().unwrap()).unwrap().flatten().filter(|e| e.path().extension().is_some_and(|x| x == "tar")).collect();
        assert_eq!(tars.len(), 1, "exactly one archive");
        assert!(!pending_removal(&f.ops, "app/feat-c1"));
    }

    #[test]
    fn rm_crash_before_archive_and_vanished_checkout_still_complete() {
        let f = fx("rmvanish");
        let o = new_wt(&f, "feat/v");
        let crashy = Host::default();
        *crashy.fail_after.lock().unwrap() = Some(Step::Stop);
        assert!(do_rm(&f, "feat-v", &o.path, false, &crashy).is_err());
        assert_eq!(load_op(&f.ops, "app/feat-v").unwrap().unwrap().step, Step::Guards);
        // the checkout disappears behind our back
        fs::remove_dir_all(&o.path).unwrap();
        let ok = Host::default();
        let out = do_rm(&f, "feat-v", &o.path, false, &ok).unwrap();
        assert!(out.removed);
        assert_eq!(*ok.calls.lock().unwrap(), ["drop", "lease"]);
        assert!(!worktree_entries(&f.repo).unwrap().iter().any(|(p, _)| canon(p) == canon(&o.path) || p.ends_with("feat/v")));
    }

    fn seed_state(f: &Fx, key: &str, port: i64) {
        f.ops
            .tx(|tx| {
                tx.execute("INSERT INTO runs (key, project, run, spec_json, status, procs_json) VALUES (?1, 'app', ?2, '{}', 'stopped', '[]')", crate::db::params![key, key.trim_start_matches("app/")])?;
                tx.execute("INSERT INTO leases (run_key, name, port) VALUES (?1, 'web', ?2)", crate::db::params![key, port])?;
                tx.execute("INSERT INTO claims (run_key, holder, since, heartbeat) VALUES (?1, 'gone', 1, 1)", [key])?;
                Ok(())
            })
            .unwrap();
    }

    fn rows(f: &Fx, key: &str) -> (i64, i64, i64) {
        f.ops
            .with(|c| {
                let n = |t: &str, col: &str| c.scalar_i64(&format!("SELECT count(*) FROM {t} WHERE {col} = ?1"), [key]);
                Ok((n("runs", "key")?, n("leases", "run_key")?, n("claims", "run_key")?))
            })
            .unwrap()
    }

    #[test]
    fn rm_steps_5_to_7_commit_together_and_a_crash_inside_rolls_back() {
        let f = fx("rmtx");
        let o = new_wt(&f, "feat/t");
        seed_state(&f, "app/feat-t", 4500);
        // a crash after the statements but before the commit: nothing changed, the record still says DropState
        let crashy = Host { fail_commit: true, ..Default::default() };
        let e = do_rm(&f, "feat-t", &o.path, false, &crashy).unwrap_err();
        assert!(e.to_string().contains("simulated crash before commit"));
        assert_eq!(rows(&f, "app/feat-t"), (1, 1, 1), "run, lease and claim survive a rolled-back teardown");
        let rec = load_op(&f.ops, "app/feat-t").unwrap().unwrap();
        assert_eq!(rec.step, Step::DropState);
        assert!(pending_removal(&f.ops, "app/feat-t"));
        // retry with a healthy host completes all three steps at once
        let ok = Host::default();
        assert!(do_rm(&f, "feat-t", &o.path, false, &ok).unwrap().removed);
        assert_eq!(*ok.calls.lock().unwrap(), ["drop", "lease"], "stop was already recorded");
        assert_eq!(rows(&f, "app/feat-t"), (0, 0, 0));
        assert_eq!(load_op(&f.ops, "app/feat-t").unwrap().unwrap().step, Step::Done);
        assert!(!pending_removal(&f.ops, "app/feat-t"));
    }

    #[test]
    fn rm_crash_after_the_teardown_commit_leaves_a_finished_record() {
        for hook in [Step::DropState, Step::ReleaseLease, Step::Marker] {
            let f = fx("rmtx2");
            let o = new_wt(&f, "feat/t2");
            seed_state(&f, "app/feat-t2", 4501);
            let crashy = Host::default();
            *crashy.fail_after.lock().unwrap() = Some(hook);
            assert!(do_rm(&f, "feat-t2", &o.path, false, &crashy).is_err());
            // committed as one unit regardless of where the process died afterwards
            assert_eq!(rows(&f, "app/feat-t2"), (0, 0, 0), "{hook:?}");
            assert_eq!(load_op(&f.ops, "app/feat-t2").unwrap().unwrap().step, Step::Done);
            let again = do_rm(&f, "feat-t2", &o.path, false, &Host::default()).unwrap();
            assert!(again.already);
        }
    }

    #[test]
    fn a_claim_taken_while_guards_ran_blocks_the_transition() {
        let f = fx("rmclaim");
        let o = new_wt(&f, "feat/cl");
        let crashy = Host::default();
        *crashy.fail_after.lock().unwrap() = Some(Step::Stop);
        assert!(do_rm(&f, "feat-cl", &o.path, false, &crashy).is_err());
        // review #3: while the removal is pending the claim API refuses new claims
        let e = crate::claims::claim(&f.ops, "app/feat-cl", "agent-z", None, crate::claims::now()).unwrap_err();
        assert!(e.to_string().contains("being removed"), "{e:#}");
        assert!(crate::claims::get(&f.ops, "app/feat-cl").unwrap().is_none());
        // a claim row that got in some other way (older data) still blocks the Guards -> Archive transition
        f.ops.with(|c| c.execute("INSERT INTO claims (run_key, holder, since, heartbeat) VALUES ('app/feat-cl', 'agent-z', ?1, ?1)", [crate::claims::now() as i64])).unwrap();
        let e = do_rm(&f, "feat-cl", &o.path, false, &Host::default()).unwrap_err();
        assert!(e.downcast_ref::<Refused>().unwrap().0.iter().any(|r| r.code == "claim"), "{e:#}");
        assert_eq!(load_op(&f.ops, "app/feat-cl").unwrap().unwrap().step, Step::Guards, "the transition was not recorded");
        assert!(o.path.exists());
        crate::claims::release(&f.ops, "app/feat-cl", None, crate::claims::now()).unwrap();
        assert!(do_rm(&f, "feat-cl", &o.path, false, &Host::default()).unwrap().removed);
    }

    #[test]
    fn rm_refuses_a_replacement_checkout_at_the_same_path() {
        let f = fx("rmswap");
        let o = new_wt(&f, "feat/w");
        let crashy = Host::default();
        *crashy.fail_after.lock().unwrap() = Some(Step::Archive);
        assert!(do_rm(&f, "feat-w", &o.path, false, &crashy).is_err());
        // someone replaces the worktree with a plain directory
        g(&f.repo, &["worktree", "remove", "--force", o.path.to_str().unwrap()]);
        fs::create_dir_all(&o.path).unwrap();
        fs::write(o.path.join("important.txt"), "not a worktree").unwrap();
        let e = do_rm(&f, "feat-w", &o.path, true, &Host::default()).unwrap_err();
        assert!(e.to_string().contains("not a worktree of this repo"), "{e:#}");
        assert!(o.path.join("important.txt").exists());
    }

    // ---- restore

    #[test]
    fn restore_round_trip_puts_back_ignored_data_and_links() {
        let mut f = fx("restore");
        fs::write(f.pdir.join("main/.env.local"), "TOKEN=fake\n").unwrap();
        f.cfg.worktree.link = vec![".env.local".into()];
        let o = new_wt(&f, "feat/rs");
        fs::write(o.path.join("local.db"), "irreplaceable").unwrap();
        fs::create_dir_all(o.path.join("scratch")).unwrap();
        fs::write(o.path.join("scratch/notes.txt"), "notes").unwrap();
        fs::create_dir_all(o.path.join(".next")).unwrap();
        fs::write(o.path.join(".next/x"), "regen").unwrap();
        let out = do_rm(&f, "feat-rs", &o.path, false, &Host::default()).unwrap();
        assert!(out.archive.is_some());
        assert!(!o.path.exists());
        let r = restore(&f.cfg, "feat-rs", &f.ops, &f.archives).unwrap();
        assert_eq!(r.path, o.path);
        assert_eq!(fs::read_to_string(r.path.join("local.db")).unwrap(), "irreplaceable");
        assert_eq!(fs::read_to_string(r.path.join("scratch/notes.txt")).unwrap(), "notes");
        assert!(!r.path.join(".next/x").exists(), "declared regenerable data is not archived");
        assert!(fs::symlink_metadata(r.path.join(".env.local")).unwrap().file_type().is_symlink(), "links are recreated");
        assert!(g(&r.path, &["rev-parse", "--abbrev-ref", "HEAD"]).contains("feat/rs"));
        assert_eq!(g(&r.path, &["status", "--porcelain"]), "");
        assert!(load_op(&f.ops, "app/feat-rs").unwrap().is_none(), "marker consumed");
        assert!(restore(&f.cfg, "feat-rs", &f.ops, &f.archives).is_err());
    }

    #[test]
    fn removed_list_reports_finished_removals_only() {
        let f = fx("removed");
        assert!(removed_list(&f.ops).is_empty());
        let o = new_wt(&f, "feat/gone");
        fs::write(o.path.join("local.db"), "precious").unwrap();
        let out = do_rm(&f, "feat-gone", &o.path, false, &Host::default()).unwrap();
        let rows = removed_list(&f.ops);
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0]["run"], "app/feat-gone");
        assert_eq!(rows[0]["project"], "app");
        assert_eq!(rows[0]["branch"], "feat/gone");
        assert!(rows[0]["removed_at"].as_u64().unwrap() > 0);
        assert_eq!(rows[0]["archive"], serde_json::json!(out.archive));
        assert!(rows[0]["archive_size"].as_u64().unwrap() > 0);
        // A pruned archive keeps the entry (branch restore still works) but drops the size.
        fs::remove_file(out.archive.unwrap()).unwrap();
        assert!(removed_list(&f.ops)[0]["archive_size"].is_null());
        // A pending (unfinished) removal is not listed; a restored one is gone.
        let o2 = new_wt(&f, "feat/pending");
        let crashy = Host::default();
        *crashy.fail_after.lock().unwrap() = Some(Step::Stop);
        let _ = do_rm(&f, "feat-pending", &o2.path, false, &crashy);
        assert_eq!(removed_list(&f.ops).len(), 1);
        restore(&f.cfg, "feat-gone", &f.ops, &f.archives).unwrap();
        assert!(removed_list(&f.ops).is_empty());
    }

    #[test]
    fn restore_needs_a_finished_removal_and_ignores_unrelated_archives() {
        // review #17: an older archive of the same run name is another checkout's data
        let f = fx("restore2");
        assert!(restore(&f.cfg, "nope", &f.ops, &f.archives).unwrap_err().to_string().contains("no removal record"));
        let o = new_wt(&f, "feat/r2");
        let crashy = Host::default();
        *crashy.fail_after.lock().unwrap() = Some(Step::Stop);
        let _ = do_rm(&f, "feat-r2", &o.path, false, &crashy);
        assert!(restore(&f.cfg, "feat-r2", &f.ops, &f.archives).unwrap_err().to_string().contains("not finished"));
        let out = do_rm(&f, "feat-r2", &o.path, false, &Host::default()).unwrap();
        assert!(out.archive.is_none(), "nothing irreplaceable was left");
        let dir = f.archives.join("app/feat-r2");
        let src = f.root.join("src-old");
        fs::create_dir_all(&src).unwrap();
        fs::write(src.join("local.db"), "stale database the user deleted").unwrap();
        write_archive(&src, &[PathBuf::from("local.db")], &dir.join("20200101T000000Z.tar")).unwrap();
        let r = restore(&f.cfg, "feat-r2", &f.ops, &f.archives).unwrap();
        assert!(!r.path.join("local.db").exists(), "the stray archive must not come back");
        assert!(r.restored_from.is_none() && r.warnings.iter().any(|w| w.contains("nothing was archived")), "{:?}", r.warnings);
    }

    fn do_rm_cap(f: &Fx, run: &str, wt: &Path, force: bool, host: &Host, cap: Option<u64>) -> Result<RmOutcome> {
        let declared: Vec<String> = f.cfg.disk_items.iter().flat_map(|i| i.paths.clone()).collect();
        rm(&RmCtx { project: "app", run, worktree: wt, repo: &f.repo, declared: &declared, archive_root: &f.archives, db: &f.ops, force, host, archive_cap: cap, merge_proof: None })
    }

    #[test]
    fn a_resumed_removal_rearchives_ignored_data_created_after_the_archive() {
        // review #2
        let f = fx("rmresume");
        let o = new_wt(&f, "feat/rr");
        fs::write(o.path.join("local.db"), "v1").unwrap();
        let crashy = Host::default();
        *crashy.fail_after.lock().unwrap() = Some(Step::Archive);
        assert!(do_rm(&f, "feat-rr", &o.path, false, &crashy).is_err());
        assert_eq!(load_op(&f.ops, "app/feat-rr").unwrap().unwrap().step, Step::Remove);
        std::thread::sleep(Duration::from_millis(30));
        fs::write(o.path.join("local.db"), "v2 edited after the archive").unwrap();
        fs::write(o.path.join("new-local.db"), "created after the archive").unwrap();
        let out = do_rm(&f, "feat-rr", &o.path, false, &Host::default()).unwrap();
        assert!(!o.path.exists());
        let arch = out.archive.unwrap();
        let listing = Command::new("tar").arg("-tf").arg(&arch).output().unwrap();
        assert!(String::from_utf8_lossy(&listing.stdout).contains("new-local.db"));
        let r = restore(&f.cfg, "feat-rr", &f.ops, &f.archives).unwrap();
        assert_eq!(fs::read_to_string(r.path.join("local.db")).unwrap(), "v2 edited after the archive");
        assert_eq!(fs::read_to_string(r.path.join("new-local.db")).unwrap(), "created after the archive");
    }

    #[test]
    fn a_resumed_removal_rechecks_the_live_guards() {
        // review #2/#3: the claim table is read again before the delete, not only when leaving Guards
        let f = fx("rmreguard");
        let o = new_wt(&f, "feat/rg");
        let crashy = Host::default();
        *crashy.fail_after.lock().unwrap() = Some(Step::Archive);
        assert!(do_rm(&f, "feat-rg", &o.path, false, &crashy).is_err());
        let claimed = Host { claim: Some("late-writer".into()), ..Default::default() };
        let e = do_rm(&f, "feat-rg", &o.path, false, &claimed).unwrap_err();
        assert!(e.downcast_ref::<Refused>().unwrap().0.iter().any(|r| r.code == "claim"), "{e:#}");
        assert!(o.path.exists());
    }

    #[test]
    fn an_ignored_nested_repository_is_archived_with_its_history() {
        // review #5
        let f = fx("nested");
        let o = new_wt(&f, "feat/ns");
        let nested = o.path.join("scratch/nested");
        fs::create_dir_all(&nested).unwrap();
        g(&nested, &["init", "-q", "-b", "main"]);
        fs::write(nested.join("README"), "local only").unwrap();
        g(&nested, &["add", "."]);
        g(&nested, &["commit", "-q", "-m", "local-only commit"]);
        let rels = irreplaceable(&o.path, &["node_modules".to_string()]).unwrap();
        assert!(rels.iter().any(|r| r.starts_with("scratch")), "{rels:?}");
        let out = do_rm(&f, "feat-ns", &o.path, false, &Host::default()).unwrap();
        let r = restore(&f.cfg, "feat-ns", &f.ops, &f.archives).unwrap();
        assert!(out.archive.is_some());
        assert_eq!(g(&r.path.join("scratch/nested"), &["log", "--format=%s"]), "local-only commit");
    }

    #[test]
    fn the_archive_size_cap_refuses_clearly_and_a_larger_cap_proceeds() {
        let f = fx("cap");
        let o = new_wt(&f, "feat/cap");
        fs::write(o.path.join("local.db"), vec![1u8; 4096]).unwrap();
        let e = do_rm_cap(&f, "feat-cap", &o.path, false, &Host::default(), Some(1024)).unwrap_err();
        let reasons = &e.downcast_ref::<Refused>().expect("a clear refusal").0;
        assert_eq!(reasons[0].code, "archive-size");
        assert!(reasons[0].message.contains("cap"), "{}", reasons[0].message);
        assert!(o.path.join("local.db").exists());
        assert!(do_rm_cap(&f, "feat-cap", &o.path, false, &Host::default(), Some(1 << 20)).unwrap().removed);
    }

    #[test]
    fn a_locked_worktree_is_a_clear_refusal_with_a_hint_and_retry_works() {
        let f = fx("locked");
        let o = new_wt(&f, "feat/lk");
        g(&f.repo, &["worktree", "lock", "--reason", "test", o.path.to_str().unwrap()]);
        let e = do_rm(&f, "feat-lk", &o.path, false, &Host::default()).unwrap_err();
        let m = format!("{e:#}");
        assert!(m.contains("locked") && m.contains("git worktree unlock") && !m.contains("unknown"), "{m}");
        assert!(o.path.exists());
        g(&f.repo, &["worktree", "unlock", o.path.to_str().unwrap()]);
        assert!(do_rm(&f, "feat-lk", &o.path, false, &Host::default()).unwrap().removed);
    }

    #[test]
    fn a_worktree_with_an_initialised_submodule_is_refused_before_anything_is_persisted() {
        let f = fx("submod");
        let sub = f.root.join("subsrc");
        fs::create_dir_all(&sub).unwrap();
        g(&sub, &["init", "-q", "-b", "main"]);
        fs::write(sub.join("s.txt"), "s").unwrap();
        g(&sub, &["add", "."]);
        g(&sub, &["commit", "-q", "-m", "sub"]);
        let o = new_wt(&f, "feat/sm");
        g(&o.path, &["submodule", "add", "-q", sub.to_str().unwrap(), "vendor/sub"]);
        g(&o.path, &["commit", "-q", "-m", "add submodule"]);
        g(&o.path, &["push", "-q", "origin", "HEAD:refs/heads/feat/sm"]);
        let e = do_rm(&f, "feat-sm", &o.path, false, &Host::default()).unwrap_err();
        assert!(e.downcast_ref::<Refused>().unwrap().0.iter().any(|r| r.code == "submodule"), "{e:#}");
        assert!(load_op(&f.ops, "app/feat-sm").unwrap().is_none());
        assert!(o.path.exists());
    }

    #[test]
    fn a_forced_removal_saves_dirty_changes_under_refs_setu_backup() {
        let f = fx("backup");
        let o = new_wt(&f, "feat/bk");
        fs::write(o.path.join("README.md"), "edited\n").unwrap();
        fs::write(o.path.join("u.txt"), "untracked work\n").unwrap();
        assert!(do_rm(&f, "feat-bk", &o.path, true, &Host::default()).unwrap().removed);
        assert!(!o.path.exists());
        let rec = load_op(&f.ops, "app/feat-bk").unwrap().unwrap();
        assert_eq!(rec.backup_ref.as_deref(), Some("refs/setu-backup/feat/bk"));
        assert_eq!(g(&f.repo, &["show", "refs/setu-backup/feat/bk:u.txt"]), "untracked work");
        assert_eq!(g(&f.repo, &["show", "refs/setu-backup/feat/bk:README.md"]), "edited");
        let r = restore(&f.cfg, "feat-bk", &f.ops, &f.archives).unwrap();
        assert!(r.warnings.iter().any(|w| w.contains("refs/setu-backup/feat/bk")), "{:?}", r.warnings);
    }

    #[test]
    fn restore_warns_when_the_branch_moved_and_refuses_unsafe_member_paths() {
        let f = fx("restoresafe");
        let o = new_wt(&f, "feat/mv");
        fs::write(o.path.join("local.db"), "x").unwrap();
        let out = do_rm(&f, "feat-mv", &o.path, false, &Host::default()).unwrap();
        // the branch moves while the worktree is gone
        let head = load_op(&f.ops, "app/feat-mv").unwrap().unwrap().head.unwrap();
        let tree = g(&f.repo, &["rev-parse", &format!("{head}^{{tree}}")]);
        let moved = g(&f.repo, &["commit-tree", &tree, "-p", &head, "-m", "moved"]);
        g(&f.repo, &["update-ref", "refs/heads/feat/mv", &moved]);
        // a tar whose member climbs out of the worktree replaces the real archive
        fs::write(f.root.join("outside.txt"), "evil").unwrap();
        let evil = out.archive.clone().unwrap();
        fs::remove_file(&evil).unwrap();
        let st = Command::new("tar").arg("-cPf").arg(&evil).arg("-C").arg(&f.archives).arg("../outside.txt").status().unwrap();
        assert!(st.success());
        let e = restore(&f.cfg, "feat-mv", &f.ops, &f.archives).unwrap_err();
        assert!(e.to_string().contains("unsafe member"), "{e:#}");
        assert!(!o.path.exists(), "refused before the worktree was created");
        // with a normal archive the move is reported
        write_archive(&f.pdir.join("main"), &[PathBuf::from("README.md")], &evil).unwrap();
        let r = restore(&f.cfg, "feat-mv", &f.ops, &f.archives).unwrap();
        assert!(r.warnings.iter().any(|w| w.contains("branch moved")), "{:?}", r.warnings);
    }

    #[test]
    fn exec_stops_waiting_for_output_a_background_child_holds_open() {
        // review #19
        let mut c = Command::new("sh");
        c.arg("-c").arg("sleep 8 & echo hi");
        let t = Instant::now();
        let out = exec(c, Duration::from_secs(30)).unwrap();
        assert!(t.elapsed() < Duration::from_secs(6), "waited {:?}", t.elapsed());
        assert_eq!(out.text().trim(), "hi");
    }
}
