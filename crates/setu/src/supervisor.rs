//! Spawns and stops supervised process groups. Children write their logs directly to files.
#![allow(dead_code)]

use crate::model::{ProcRecord, ResolvedProc, RunId, RunSpec};
use crate::procinfo;
use anyhow::Context;
use std::collections::BTreeMap;
use std::io::Write;
use std::os::unix::fs::OpenOptionsExt;
use std::path::Path;
use std::process::Stdio;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

pub type ExitTx = tokio::sync::mpsc::UnboundedSender<ExitEvent>;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ExitEvent {
    pub run: RunId,
    pub proc: String,
    pub pid: i32,
    /// None when killed by a signal.
    pub code: Option<i32>,
}

pub async fn spawn_proc(spec: &RunSpec, proc: &ResolvedProc, exits: ExitTx) -> anyhow::Result<ProcRecord> {
    if let Some(dir) = proc.log_path.parent() {
        secure_log_dirs(dir).with_context(|| format!("create log dir {}", dir.display()))?;
    }
    let mut log = std::fs::OpenOptions::new()
        .append(true)
        .create(true)
        .mode(0o600)
        .open(&proc.log_path)
        .with_context(|| format!("open log {}", proc.log_path.display()))?;
    // Raw output can hold secrets (redaction only happens when logs are served): files that
    // already exist, and their rotated copy, are tightened too (review #13).
    secure_log_file(&proc.log_path);
    let ts = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
    writeln!(log, "[setu] {ts} start {}: {}", proc.name, proc.command)?;
    let out = log.try_clone()?;
    let err = log;

    let mut env: BTreeMap<String, String> = spec.env.clone();
    if let Some(p) = proc.port {
        env.insert("PORT".into(), p.to_string());
    }

    // Use the login-shell PATH captured by `setu setup` (launchd's own PATH is minimal),
    // unless the run's env sets PATH itself.
    if !env.contains_key("PATH") {
        if let Some(p) = crate::globalcfg::login_path() {
            env.insert("PATH".into(), p);
        }
    }
    // `setu` itself must resolve inside procs (the generated Trigger.dev proc runs `setu x trigger-dev`),
    // even when the dir it was installed to is not on the captured login PATH. Appended, so it never shadows anything.
    if let Some(dir) = std::env::current_exe().ok().and_then(|e| e.parent().map(std::path::Path::to_path_buf)) {
        let base = env.get("PATH").cloned().or_else(|| std::env::var("PATH").ok()).unwrap_or_default();
        if !base.is_empty() && !std::env::split_paths(&base).any(|d| d == dir) {
            env.insert("PATH".into(), format!("{base}:{}", dir.display()));
        }
    }
    let mut cmd = tokio::process::Command::new("/bin/sh");
    // Don't leak the shell that started the daemon into the run: a stale PORT, direnv
    // state or a parent npm/nx context would point the proc at the wrong place.
    for (k, _) in std::env::vars_os() {
        let k = k.to_string_lossy().to_string();
        if LEAKY_ENV.contains(&k.as_str()) || LEAKY_PREFIXES.iter().any(|p| k.starts_with(p)) {
            cmd.env_remove(&k);
        }
    }
    cmd.arg("-c")
        .arg(&proc.command)
        .current_dir(&proc.cwd)
        .envs(&env)
        .stdin(Stdio::null())
        .stdout(Stdio::from(out))
        .stderr(Stdio::from(err))
        .kill_on_drop(false);
    // SAFETY: setsid is async-signal-safe and the closure touches no other state.
    unsafe {
        cmd.pre_exec(|| {
            if libc::setsid() == -1 {
                return Err(std::io::Error::last_os_error());
            }
            Ok(())
        });
    }
    let mut child = cmd.spawn().with_context(|| format!("spawn {}", proc.name))?;
    let pid = child.id().context("child exited before pid was read")? as i32;

    let mut start = procinfo::start_time(pid);
    for _ in 0..20 {
        if start.is_some() {
            break;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
        start = procinfo::start_time(pid);
    }
    let Some(start_time) = start else {
        // Could not identify it; do not leave an unrecorded process behind.
        // SAFETY: pid is our own just-spawned group leader.
        unsafe { libc::killpg(pid, libc::SIGKILL) };
        let _ = child.wait().await;
        anyhow::bail!("could not read start time for pid {pid}");
    };

    let (run, name) = (spec.id.clone(), proc.name.clone());
    tokio::spawn(async move {
        let code = child.wait().await.ok().and_then(|s| s.code());
        let _ = exits.send(ExitEvent { run, proc: name, pid, code });
    });
    Ok(ProcRecord { name: proc.name.clone(), pid, start_time, escaped: vec![], members: vec![] })
}

/// Create the log directory 0700 and tighten it and every ancestor up to the logs root.
fn secure_log_dirs(dir: &Path) -> std::io::Result<()> {
    use std::os::unix::fs::{DirBuilderExt, PermissionsExt};
    std::fs::DirBuilder::new().recursive(true).mode(0o700).create(dir)?;
    let root = crate::paths::logs_dir();
    for d in dir.ancestors().take_while(|a| a.starts_with(&root)) {
        std::fs::set_permissions(d, std::fs::Permissions::from_mode(0o700))?;
    }
    if !dir.starts_with(&root) {
        std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700))?;
    }
    Ok(())
}

/// 0600 for a log and its `.1` rotation.
pub(crate) fn secure_log_file(path: &Path) {
    use std::os::unix::fs::PermissionsExt;
    let mut rotated = path.as_os_str().to_owned();
    rotated.push(".1");
    for p in [path.to_path_buf(), std::path::PathBuf::from(rotated)] {
        if p.exists() {
            let _ = std::fs::set_permissions(&p, std::fs::Permissions::from_mode(0o600));
        }
    }
}

/// Env names never inherited from the daemon's own environment.
pub(crate) const LEAKY_ENV: &[&str] = &["PORT", "INIT_CWD", "OLDPWD", "PWD"];
pub(crate) const LEAKY_PREFIXES: &[&str] = &["npm_", "NX_", "DIRENV_", "__MISE"];

/// Record descendants that have left the proc's group, so a later stop (even after a
/// daemon restart) can still find them. Keeps entries whose start time still matches.
pub fn refresh_escaped(rec: &mut ProcRecord) {
    if !owned_and_alive(rec) {
        return;
    }
    let group = procinfo::group_pids(rec.pid);
    note_members(rec, &group);
    rec.escaped.retain(|&(p, st)| procinfo::start_time(p) == Some(st));
    for p in procinfo::tree(rec.pid) {
        if group.contains(&p) || rec.escaped.iter().any(|(e, _)| *e == p) {
            continue;
        }
        if let Some(st) = procinfo::start_time(p) {
            rec.escaped.push((p, st));
        }
    }
}

const MAX_MEMBERS: usize = 256;

/// Remember the incarnations (pid + start time) of the group's current members, and forget the
/// ones that are gone. Only call while the group is known to be ours.
fn note_members(rec: &mut ProcRecord, group: &[i32]) {
    rec.members.retain(|&(p, st)| procinfo::start_time(p) == Some(st));
    for &p in group {
        if p == rec.pid || rec.members.len() >= MAX_MEMBERS {
            continue;
        }
        if let Some(st) = procinfo::start_time(p) {
            if !rec.members.contains(&(p, st)) {
                rec.members.push((p, st));
            }
        }
    }
}

/// The leader's proc just exited under our supervision, so its group is still provably ours at
/// this instant: record who is in it, so later stops can still prove ownership.
pub fn record_members_at_exit(rec: &mut ProcRecord) {
    let group = procinfo::group_pids(rec.pid);
    note_members(rec, &group);
}

/// The leader is the recorded process, or is gone while one of the exact member incarnations
/// recorded under supervision still lives in its group. A gone leader plus members that merely
/// started later proves nothing after an observation gap: an unrelated session leader can reuse
/// the pid, start children and exit (review B3).
fn group_provably_ours(rec: &ProcRecord) -> bool {
    if owned_and_alive(rec) {
        return true;
    }
    if procinfo::alive(rec.pid) {
        return false;
    }
    procinfo::group_pids(rec.pid).iter().any(|p| procinfo::start_time(*p).is_some_and(|st| rec.members.contains(&(*p, st))))
}

/// The leader is gone and its group still has members, but none is a recorded incarnation: we
/// cannot tell whether it is ours. Never signalled; kept as unresolved.
pub fn ambiguous_group(rec: &ProcRecord) -> bool {
    !owned_and_alive(rec) && !procinfo::alive(rec.pid) && !procinfo::group_pids(rec.pid).is_empty() && !group_provably_ours(rec)
}

/// Is anything this record owns still running (the root, its group, or a recorded escaped child)?
pub fn unresolved(rec: &ProcRecord) -> bool {
    owned_and_alive(rec) || group_provably_ours(rec) || ambiguous_group(rec) || rec.escaped.iter().any(|&(p, st)| procinfo::start_time(p) == Some(st))
}

pub fn owned_and_alive(rec: &ProcRecord) -> bool {
    procinfo::alive(rec.pid) && procinfo::start_time(rec.pid) == Some(rec.start_time)
}

fn sig(pid: i32, s: i32) {
    if pid > 1 {
        // SAFETY: plain kill(2); pid validated > 1 by caller logic.
        unsafe { libc::kill(pid, s) };
    }
}

fn sig_group(pgid: i32, s: i32) {
    if pgid > 1 {
        // SAFETY: plain killpg(2); pgid > 1 is never the caller's own group.
        unsafe { libc::killpg(pgid, s) };
    }
}

/// Name of the record for a dev server that was already running when Setu found it.
pub const EXTERNAL_PROC: &str = "external (not started by Setu)";

/// Name of the record for a separate v1 process group (a sidecar) of an external run.
pub const EXTERNAL_SIDECAR: &str = "external sidecar (not started by Setu)";

pub fn is_external(rec: &ProcRecord) -> bool {
    rec.name == EXTERNAL_PROC || rec.name == EXTERNAL_SIDECAR
}

/// A record of a whole v1 process group: a sidecar, or the listener's group (its leader is
/// `pid`, the listener is the one entry in `members`). Anything else external is a bare listener.
pub fn is_external_group(rec: &ProcRecord) -> bool {
    rec.name == EXTERNAL_SIDECAR || (rec.name == EXTERNAL_PROC && !rec.members.is_empty())
}

/// Is the external record's process (the group for group records) still running?
pub fn external_alive(rec: &ProcRecord) -> bool {
    if owned_and_alive(rec) {
        return true;
    }
    rec.name == EXTERNAL_PROC && rec.members.iter().any(|&(p, st)| procinfo::start_time(p) == Some(st))
}

/// Stop a server Setu adopted but did not start. Before any signal the claim is proven again:
/// this exact pid and start time must still listen on `port` with its cwd inside `worktree`.
/// Signals go to the process and its descendants one by one, never to a process group (the
/// server may share a group with the user's shell). `Ok(false)`: the proof failed, nothing was signalled.
pub async fn stop_external(rec: &ProcRecord, worktree: &Path, port: u16, grace: Duration) -> anyhow::Result<bool> {
    if is_external_group(rec) {
        return stop_external_group(rec, worktree, port, grace).await;
    }
    if !procinfo::alive(rec.pid) {
        return Ok(true);
    }
    if !procinfo::listener_still_belongs(rec.pid, rec.start_time, worktree, port) {
        return Ok(false);
    }
    let targets: Vec<(i32, Option<u64>)> = procinfo::descendants(rec.pid).into_iter().map(|p| (p, procinfo::start_time(p))).collect();
    let signal = |s: i32| {
        for (p, st) in &targets {
            if st.is_some() && procinfo::start_time(*p) == *st {
                sig(*p, s);
            }
        }
    };
    let gone = || !targets.iter().any(|(p, st)| st.is_some() && procinfo::start_time(*p) == *st);
    signal(libc::SIGTERM);
    let deadline = tokio::time::Instant::now() + grace;
    while !gone() && tokio::time::Instant::now() < deadline {
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    if gone() {
        return Ok(true);
    }
    signal(libc::SIGKILL);
    let deadline = tokio::time::Instant::now() + Duration::from_secs(2);
    while !gone() && tokio::time::Instant::now() < deadline {
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    if gone() {
        Ok(true)
    } else {
        anyhow::bail!("the external server (pid {}) is still alive after SIGKILL", rec.pid)
    }
}

/// Stop a v1 process group Setu adopted. Proven again first: the leader is the same
/// incarnation, still leads its group, still has its cwd inside `worktree`, is not a shell, and
/// (listener group) the recorded listener still holds `port` inside that group. Then the whole
/// group gets TERM, the grace period, then KILL. killpg is safe on a proven live leader because
/// a pgid is not reused while its leader lives. `Ok(false)`: a proof failed, nothing signalled.
async fn stop_external_group(rec: &ProcRecord, worktree: &Path, port: u16, grace: Duration) -> anyhow::Result<bool> {
    if !procinfo::alive(rec.pid) || procinfo::start_time(rec.pid) != Some(rec.start_time) {
        // The leader is gone (or its pid recycled). Without the leader nothing proves the rest, so
        // signal nothing; a gone leader and a gone group is simply done.
        return Ok(procinfo::start_time(rec.pid) != Some(rec.start_time) && procinfo::group_pids(rec.pid).is_empty());
    }
    if !procinfo::group_leader_still_belongs(rec.pid, rec.start_time, worktree) {
        return Ok(false);
    }
    if rec.name == EXTERNAL_PROC {
        let ok = rec.members.iter().any(|&(p, st)| {
            procinfo::ident(p).is_some_and(|i| i.start == st && i.pgid == rec.pid) && procinfo::listening_ports(p).contains(&port) && procinfo::cwd(p).is_some_and(|c| c.starts_with(std::fs::canonicalize(worktree).unwrap_or_else(|_| worktree.to_path_buf())))
        });
        if !ok {
            return Ok(false);
        }
    }
    let gone = || procinfo::group_pids(rec.pid).is_empty();
    sig_group(rec.pid, libc::SIGTERM);
    let deadline = tokio::time::Instant::now() + grace;
    while !gone() && tokio::time::Instant::now() < deadline {
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    if gone() {
        return Ok(true);
    }
    // Members keep the pgid alive, so it still names this group.
    sig_group(rec.pid, libc::SIGKILL);
    let deadline = tokio::time::Instant::now() + Duration::from_secs(2);
    while !gone() && tokio::time::Instant::now() < deadline {
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    if gone() {
        Ok(true)
    } else {
        anyhow::bail!("the external process group {} is still alive after SIGKILL", rec.pid)
    }
}

pub async fn stop_procs(procs: &[ProcRecord], grace: Duration) -> anyhow::Result<()> {
    // (group leader pid, collected pids with their start times)
    let mut targets: Vec<(i32, Vec<(i32, Option<u64>)>)> = Vec::new();
    // Group leaders we may killpg. Ownership of a group is proven only by the leader itself
    // (same pid, same start time) or by the leader being gone while its group lives on: a pid is
    // never reused while a group with that id exists. A leader pid that is alive with a different
    // start time was recycled, and the group it leads is a stranger's (review #6).
    let mut group_ok: Vec<i32> = Vec::new();
    for rec in procs {
        let root_alive = procinfo::alive(rec.pid);
        let mut members: Vec<(i32, Option<u64>)> = if owned_and_alive(rec) {
            procinfo::tree(rec.pid).into_iter().map(|p| (p, procinfo::start_time(p))).collect()
        } else if !root_alive && group_provably_ours(rec) {
            // Root gone but its group provably lives on (e.g. `bun dev` died, next-server didn't).
            procinfo::group_pids(rec.pid)
                .into_iter()
                .map(|p| (p, procinfo::start_time(p)))
                .filter(|(_, st)| st.is_some_and(|t| t >= rec.start_time))
                .collect()
        } else {
            Vec::new()
        };
        for &(pid, st) in &rec.escaped {
            if procinfo::start_time(pid) == Some(st) && !members.iter().any(|(p, _)| *p == pid) {
                members.push((pid, Some(st)));
            }
        }
        if group_provably_ours(rec) {
            group_ok.push(rec.pid);
        }
        if !members.is_empty() {
            targets.push((rec.pid, members));
        }
    }
    // A group with no proof of ownership is never signalled; the caller keeps the record.
    let ambiguity = || -> anyhow::Result<()> {
        match procs.iter().find(|r| ambiguous_group(r)) {
            Some(r) => anyhow::bail!(
                "process group {} still has members, but its leader (pid {}) is gone and none of the member processes Setu recorded is still in it, so Setu cannot prove the group is its own and did not signal it. If those processes belong to this run, end them by hand; the record stays until the group is gone",
                r.pid,
                r.pid
            ),
            None => Ok(()),
        }
    };
    if targets.is_empty() {
        return ambiguity();
    }

    let signal_all = |s: i32, targets: &[(i32, Vec<(i32, Option<u64>)>)]| {
        for (leader, members) in targets {
            // Ownership is re-proven right before each signal, not cached across the grace period.
            let ok = group_ok.contains(leader) && procs.iter().find(|r| r.pid == *leader).is_some_and(group_provably_ours);
            let group = if ok {
                sig_group(*leader, s);
                procinfo::group_pids(*leader)
            } else {
                Vec::new()
            };
            for (p, st) in members {
                // Skip pids already covered by the group signal, and recycled pids.
                if !group.contains(p) && st.is_some() && procinfo::start_time(*p) == *st {
                    sig(*p, s);
                }
            }
        }
    };
    let remaining = |targets: &[(i32, Vec<(i32, Option<u64>)>)]| -> Vec<i32> {
        let mut out = Vec::new();
        for (leader, members) in targets {
            let group = if group_ok.contains(leader) { procinfo::group_pids(*leader) } else { Vec::new() };
            for p in group {
                if !out.contains(&p) {
                    out.push(p);
                }
            }
            for (p, st) in members {
                if st.is_some() && procinfo::start_time(*p) == *st && !out.contains(p) {
                    out.push(*p);
                }
            }
        }
        out
    };

    signal_all(libc::SIGTERM, &targets);
    let deadline = tokio::time::Instant::now() + grace;
    while !remaining(&targets).is_empty() && tokio::time::Instant::now() < deadline {
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    if remaining(&targets).is_empty() {
        return ambiguity();
    }
    signal_all(libc::SIGKILL, &targets);
    let deadline = tokio::time::Instant::now() + Duration::from_secs(2);
    while !remaining(&targets).is_empty() && tokio::time::Instant::now() < deadline {
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    let left = remaining(&targets);
    if left.is_empty() {
        ambiguity()
    } else {
        anyhow::bail!("processes still alive after SIGKILL: {left:?}")
    }
}

/// Readiness: the same probe the proxy uses, so "up" here means the proxy can reach it.
pub async fn wait_port(run: &RunId, port: u16, timeout: Duration) -> bool {
    crate::upstream::wait(run, port, timeout, Duration::from_millis(250), Duration::from_millis(250)).await.is_some()
}

pub fn run_footprint(procs: &[ProcRecord]) -> u64 {
    procs.iter().filter(|r| owned_and_alive(r)).map(|r| procinfo::tree_footprint(r.pid)).sum()
}

/// Copy-truncate rotation: keeps the inode so children with O_APPEND fds keep logging.
/// Each rotation records when the live log was last truncated and when the copy's content
/// started (`<log>.rot`), so `log_data_floor` can say how old the oldest bytes in either file are.
pub fn rotate_log(path: &Path, max_bytes: u64) -> std::io::Result<bool> {
    if std::fs::metadata(path)?.len() <= max_bytes {
        return Ok(false);
    }
    let mut rotated = path.as_os_str().to_owned();
    rotated.push(".1");
    // What the live log held began at its last truncation (or its birth).
    let prev = rot_cur(path).max(birth_secs(path));
    std::fs::copy(path, &rotated)?;
    std::fs::OpenOptions::new().write(true).open(path)?.set_len(0)?;
    let now = crate::db::now_secs();
    // Best effort: a missing sidecar only makes the floor older, which keeps more history.
    let _ = std::fs::write(rot_path(path), format!("{prev} {now}\n"));
    secure_log_file(path);
    Ok(true)
}

fn rot_path(log: &Path) -> std::path::PathBuf {
    let mut p = log.as_os_str().to_owned();
    p.push(".rot");
    p.into()
}

fn rot_pair(log: &Path) -> Option<(u64, u64)> {
    let t = std::fs::read_to_string(rot_path(log)).ok()?;
    let mut it = t.split_whitespace().map(|x| x.parse::<u64>());
    match (it.next(), it.next()) {
        (Some(Ok(a)), Some(Ok(b))) => Some((a, b)),
        _ => None,
    }
}

fn rot_cur(log: &Path) -> u64 {
    rot_pair(log).map_or(0, |(_, c)| c)
}

/// Creation time in unix seconds; 0 (the safe, oldest answer) when the filesystem has none.
fn birth_secs(p: &Path) -> u64 {
    std::fs::metadata(p).and_then(|m| m.created()).ok().and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok()).map_or(0, |d| d.as_secs())
}

/// A lower bound (unix seconds) on when the oldest bytes still in this log file were written;
/// `u64::MAX` for files that are not logs. Secrets that stopped being current before the lowest
/// floor over all log files cannot appear in any of them (review B5).
pub fn log_data_floor(path: &Path) -> u64 {
    let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("");
    if name.ends_with(".rot") {
        return u64::MAX;
    }
    if let Some(base) = name.strip_suffix(".1").filter(|b| b.ends_with(".log")) {
        // The copy holds what the live log held up to its last rotation.
        return rot_pair(&path.with_file_name(base)).map_or(0, |(prev, _)| prev);
    }
    // The live log: bytes since its last truncation, never older than its birth.
    birth_secs(path).max(rot_cur(path))
}


#[cfg(all(test, target_os = "macos"))]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn fixture(dir: &Path, command: &str, port: Option<u16>) -> (RunSpec, ResolvedProc) {
        let proc = ResolvedProc {
            name: "web".into(),
            command: command.into(),
            cwd: dir.to_path_buf(),
            port,
            log_path: dir.join("logs").join("web.log"),
        };
        let mut env = BTreeMap::new();
        env.insert("FOO".to_string(), "bar".to_string());
        env.insert("PORT".to_string(), "1".to_string());
        let spec = RunSpec {
            id: RunId { project: "p".into(), run: "r".into() },
            worktree: dir.to_path_buf(),
            host: "r.p.local".into(),
            url: "http://r.p.local:7777".into(),
            ports: BTreeMap::new(),
            env,
            procs: vec![proc.clone()],
            web_port: port,
            idle: Duration::from_secs(60),
            aliases: vec![],
        };
        (spec, proc)
    }

    fn tmp(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("setu-sup-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    async fn gone(pids: &[i32]) {
        for _ in 0..30 {
            if pids.iter().all(|p| !procinfo::alive(*p)) {
                return;
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
        panic!("pids still alive: {pids:?}");
    }

    #[tokio::test(flavor = "current_thread")]
    async fn spawn_and_stop_single() {
        let d = tmp("single");
        let (spec, proc) = fixture(&d, "sleep 30", None);
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
        let rec = spawn_proc(&spec, &proc, tx).await.unwrap();
        assert!(rec.start_time > 0 && rec.pid > 1);
        assert!(owned_and_alive(&rec));
        assert!(run_footprint(std::slice::from_ref(&rec)) > 0);
        stop_procs(std::slice::from_ref(&rec), Duration::from_secs(3)).await.unwrap();
        assert!(!owned_and_alive(&rec));
        let ev = tokio::time::timeout(Duration::from_secs(3), rx.recv()).await.unwrap().unwrap();
        assert_eq!((ev.pid, ev.proc.as_str(), ev.code), (rec.pid, "web", None));
        let log = std::fs::read_to_string(&proc.log_path).unwrap();
        assert!(log.starts_with("[setu] ") && log.contains("start web: sleep 30"));
    }

    #[tokio::test(flavor = "current_thread")]
    async fn stop_kills_whole_tree() {
        let d = tmp("tree");
        let (spec, proc) = fixture(&d, "sleep 30 & sleep 30 & wait", None);
        let (tx, _rx) = tokio::sync::mpsc::unbounded_channel();
        let rec = spawn_proc(&spec, &proc, tx).await.unwrap();
        let mut pids = vec![];
        for _ in 0..30 {
            pids = procinfo::tree(rec.pid);
            if pids.len() >= 3 {
                break;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        assert!(pids.len() >= 3, "{pids:?}");
        stop_procs(std::slice::from_ref(&rec), Duration::from_secs(3)).await.unwrap();
        gone(&pids).await;
    }

    #[tokio::test(flavor = "current_thread")]
    async fn term_ignorer_gets_sigkill() {
        let d = tmp("ignore");
        // Wait for the trap to be installed before stopping.
        let (spec, proc) = fixture(&d, "trap '' TERM; echo ready; while :; do sleep 1; done", None);
        let (tx, _rx) = tokio::sync::mpsc::unbounded_channel();
        let rec = spawn_proc(&spec, &proc, tx).await.unwrap();
        for _ in 0..50 {
            if std::fs::read_to_string(&proc.log_path).unwrap_or_default().contains("ready\n") {
                break;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        let pids = procinfo::tree(rec.pid);
        let t = std::time::Instant::now();
        stop_procs(std::slice::from_ref(&rec), Duration::from_millis(500)).await.unwrap();
        assert!(t.elapsed() >= Duration::from_millis(500));
        gone(&pids).await;
    }

    #[tokio::test(flavor = "current_thread")]
    async fn wrong_start_time_not_signalled() {
        let d = tmp("forge");
        let (spec, proc) = fixture(&d, "sleep 30", None);
        let (tx, _rx) = tokio::sync::mpsc::unbounded_channel();
        let rec = spawn_proc(&spec, &proc, tx).await.unwrap();
        let forged = ProcRecord { start_time: rec.start_time + 1, ..rec.clone() };
        assert!(!owned_and_alive(&forged));
        stop_procs(&[forged], Duration::from_millis(300)).await.unwrap();
        assert!(procinfo::alive(rec.pid));
        stop_procs(std::slice::from_ref(&rec), Duration::from_secs(3)).await.unwrap();
        assert!(!owned_and_alive(&rec));
    }

    #[tokio::test(flavor = "current_thread")]
    async fn env_and_port_reach_child() {
        let d = tmp("env");
        let (spec, proc) = fixture(&d, "echo $PORT $FOO", Some(4321));
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
        let rec = spawn_proc(&spec, &proc, tx).await.unwrap();
        let ev = tokio::time::timeout(Duration::from_secs(3), rx.recv()).await.unwrap().unwrap();
        assert_eq!((ev.pid, ev.code), (rec.pid, Some(0)));
        let log = std::fs::read_to_string(&proc.log_path).unwrap();
        assert!(log.contains("4321 bar\n"), "{log}");
    }

    #[tokio::test(flavor = "current_thread")]
    async fn port_wait() {
        let l = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = l.local_addr().unwrap().port();
        assert!(wait_port(&RunId { project: "p".into(), run: "port-wait".into() }, port, Duration::from_secs(2)).await);
        drop(l);
        // Port 1 (tcpmux) never has a listener on macOS; a freed ephemeral port may be
        // reused by a parallel test.
        let t = std::time::Instant::now();
        assert!(!wait_port(&RunId { project: "p".into(), run: "port-wait".into() }, 1, Duration::from_millis(600)).await);
        assert!(t.elapsed() < Duration::from_secs(3));
    }

    #[test]
    fn self_footprint() {
        assert!(procinfo::footprint(std::process::id() as i32).unwrap() > 0);
    }

    #[test]
    fn rotate_copy_truncate() {
        let d = tmp("rot");
        let p = d.join("a.log");
        let mut f = std::fs::OpenOptions::new().append(true).create(true).open(&p).unwrap();
        f.write_all(b"0123456789").unwrap();
        assert!(!rotate_log(&p, 10).unwrap());
        assert!(rotate_log(&p, 5).unwrap());
        assert_eq!(std::fs::read(d.join("a.log.1")).unwrap(), b"0123456789");
        assert_eq!(std::fs::metadata(&p).unwrap().len(), 0);
        f.write_all(b"xy").unwrap();
        assert_eq!(std::fs::read(&p).unwrap(), b"xy");
    }

    #[tokio::test(flavor = "current_thread")]
    async fn a_recycled_leader_pid_is_never_treated_as_proof_of_group_ownership() {
        // review #6: an unrelated live process group whose leader pid equals a recorded pid
        use std::os::unix::process::CommandExt;
        let mut stranger = unsafe {
            std::process::Command::new("sleep")
                .arg("30")
                .pre_exec(|| {
                    if libc::setsid() == -1 {
                        return Err(std::io::Error::last_os_error());
                    }
                    Ok(())
                })
                .spawn()
                .unwrap()
        };
        let pid = stranger.id() as i32;
        let real = procinfo::start_time(pid).unwrap();
        // the old incarnation started earlier, so every member of the stranger's group "started after" it
        let rec = ProcRecord { name: "web".into(), pid, start_time: real - 5_000_000, escaped: vec![], members: vec![] };
        assert!(!owned_and_alive(&rec));
        let _ = stop_procs(std::slice::from_ref(&rec), Duration::from_millis(500)).await;
        let alive = procinfo::alive(pid);
        let _ = stranger.kill();
        let _ = stranger.wait();
        assert!(alive, "the stranger's process group must not be signalled");
    }

    #[tokio::test(flavor = "current_thread")]
    async fn raw_logs_are_private_even_when_the_file_already_exists() {
        // review #13
        use std::os::unix::fs::PermissionsExt;
        let d = tmp("logperm");
        let (spec, proc) = fixture(&d, "echo secret-ish", None);
        std::fs::create_dir_all(proc.log_path.parent().unwrap()).unwrap();
        std::fs::write(&proc.log_path, "old\n").unwrap();
        std::fs::set_permissions(&proc.log_path, std::fs::Permissions::from_mode(0o644)).unwrap();
        let mut rotated = proc.log_path.as_os_str().to_owned();
        rotated.push(".1");
        std::fs::write(&rotated, "older\n").unwrap();
        std::fs::set_permissions(&rotated, std::fs::Permissions::from_mode(0o644)).unwrap();
        let (tx, _rx) = tokio::sync::mpsc::unbounded_channel();
        let rec = spawn_proc(&spec, &proc, tx).await.unwrap();
        let mode = |p: &Path| std::fs::metadata(p).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode(&proc.log_path), 0o600);
        assert_eq!(mode(Path::new(&rotated)), 0o600);
        assert_eq!(mode(proc.log_path.parent().unwrap()), 0o700);
        stop_procs(std::slice::from_ref(&rec), Duration::from_secs(1)).await.ok();
        // rotation keeps the copy private too
        std::fs::write(&proc.log_path, vec![b'x'; 100]).unwrap();
        assert!(rotate_log(&proc.log_path, 10).unwrap());
        assert_eq!(mode(Path::new(&rotated)), 0o600);
    }

    /// A session whose leader exits right after starting a child: the child keeps the group alive.
    fn leaderless_group() -> (i32, i32) {
        use std::os::unix::process::CommandExt;
        let mut sh = unsafe {
            std::process::Command::new("sh")
                .args(["-c", "sleep 30 & exit 0"])
                .pre_exec(|| if libc::setsid() == -1 { Err(std::io::Error::last_os_error()) } else { Ok(()) })
                .spawn()
                .unwrap()
        };
        let leader = sh.id() as i32;
        sh.wait().unwrap();
        let member = (0..100)
            .find_map(|_| {
                std::thread::sleep(Duration::from_millis(20));
                procinfo::group_pids(leader).into_iter().find(|p| *p != leader)
            })
            .expect("the child should keep the group alive");
        (leader, member)
    }

    #[tokio::test(flavor = "current_thread")]
    async fn b3_a_gone_leader_with_only_newer_members_is_never_signalled() {
        let (leader, member) = leaderless_group();
        // an old record whose pid was recycled by an unrelated session: every member started later
        let rec = ProcRecord { name: "web".into(), pid: leader, start_time: 1, escaped: vec![], members: vec![] };
        assert!(!owned_and_alive(&rec) && !procinfo::alive(leader));
        assert!(ambiguous_group(&rec));
        assert!(unresolved(&rec), "the record must stay unresolved");
        let res = stop_procs(std::slice::from_ref(&rec), Duration::from_millis(300)).await;
        let survived = procinfo::alive(member);
        let msg = format!("{:#}", res.as_ref().err().map(|e| e.to_string()).unwrap_or_default());
        // positive evidence (the recorded member incarnation) makes the same group ours
        let proven = ProcRecord { members: vec![(member, procinfo::start_time(member).unwrap())], ..rec.clone() };
        assert!(group_provably_ours(&proven) && !ambiguous_group(&proven));
        let res2 = stop_procs(std::slice::from_ref(&proven), Duration::from_secs(2)).await;
        let gone = !procinfo::alive(member);
        if !gone {
            sig(member, libc::SIGKILL);
        }
        assert!(survived, "a group with no ownership evidence must not be signalled");
        assert!(msg.contains("cannot prove"), "the refusal must be diagnosable: {msg}");
        assert!(res2.is_ok() && gone, "recorded evidence lets stop reach the group: {res2:?}");
    }
}
