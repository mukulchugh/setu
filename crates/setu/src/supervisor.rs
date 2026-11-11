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
        std::fs::create_dir_all(dir).with_context(|| format!("create log dir {}", dir.display()))?;
    }
    let mut log = std::fs::OpenOptions::new()
        .append(true)
        .create(true)
        .mode(0o644)
        .open(&proc.log_path)
        .with_context(|| format!("open log {}", proc.log_path.display()))?;
    let ts = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
    writeln!(log, "[setu] {ts} start {}: {}", proc.name, proc.command)?;
    let out = log.try_clone()?;
    let err = log;

    let mut env: BTreeMap<String, String> = spec.env.clone();
    if let Some(p) = proc.port {
        env.insert("PORT".into(), p.to_string());
    }

    // Use the login-shell PATH captured by `setu-rs setup` (launchd's own PATH is minimal),
    // unless the run's env sets PATH itself.
    if !env.contains_key("PATH") {
        if let Some(p) = crate::globalcfg::login_path() {
            env.insert("PATH".into(), p);
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
    Ok(ProcRecord { name: proc.name.clone(), pid, start_time, escaped: vec![] })
}

/// Env names never inherited from the daemon's own environment.
const LEAKY_ENV: &[&str] = &["PORT", "INIT_CWD", "OLDPWD", "PWD"];
const LEAKY_PREFIXES: &[&str] = &["npm_", "NX_", "DIRENV_", "__MISE"];

/// Record descendants that have left the proc's group, so a later stop (even after a
/// daemon restart) can still find them. Keeps entries whose start time still matches.
pub fn refresh_escaped(rec: &mut ProcRecord) {
    if !owned_and_alive(rec) {
        return;
    }
    let group = procinfo::group_pids(rec.pid);
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

pub async fn stop_procs(procs: &[ProcRecord], grace: Duration) -> anyhow::Result<()> {
    // (group leader pid, collected pids with their start times)
    let mut targets: Vec<(i32, Vec<(i32, Option<u64>)>)> = Vec::new();
    // Group leaders we may killpg: root provably ours, or a live group whose every member
    // started after the root (so the pgid cannot belong to a recycled stranger).
    let mut group_ok: Vec<i32> = Vec::new();
    for rec in procs {
        let mut members: Vec<(i32, Option<u64>)> = if owned_and_alive(rec) {
            procinfo::tree(rec.pid).into_iter().map(|p| (p, procinfo::start_time(p))).collect()
        } else {
            // Root gone but its group may live on (e.g. `bun dev` died, next-server didn't).
            // pgid == root pid, and macOS won't reuse a pid while its group exists; still
            // only take members that started after the root did.
            procinfo::group_pids(rec.pid)
                .into_iter()
                .map(|p| (p, procinfo::start_time(p)))
                .filter(|(_, st)| st.is_some_and(|t| t >= rec.start_time))
                .collect()
        };
        for &(pid, st) in &rec.escaped {
            if procinfo::start_time(pid) == Some(st) && !members.iter().any(|(p, _)| *p == pid) {
                members.push((pid, Some(st)));
            }
        }
        let group = procinfo::group_pids(rec.pid);
        if owned_and_alive(rec)
            || (!group.is_empty() && group.iter().all(|p| procinfo::start_time(*p).is_some_and(|t| t >= rec.start_time)))
        {
            group_ok.push(rec.pid);
        }
        if !members.is_empty() {
            targets.push((rec.pid, members));
        }
    }
    if targets.is_empty() {
        return Ok(());
    }

    let signal_all = |s: i32, targets: &[(i32, Vec<(i32, Option<u64>)>)]| {
        for (leader, members) in targets {
            let group = if group_ok.contains(leader) {
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
        return Ok(());
    }
    signal_all(libc::SIGKILL, &targets);
    let deadline = tokio::time::Instant::now() + Duration::from_secs(2);
    while !remaining(&targets).is_empty() && tokio::time::Instant::now() < deadline {
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    let left = remaining(&targets);
    if left.is_empty() {
        Ok(())
    } else {
        anyhow::bail!("processes still alive after SIGKILL: {left:?}")
    }
}

pub async fn wait_port(port: u16, timeout: Duration) -> bool {
    let deadline = tokio::time::Instant::now() + timeout;
    loop {
        for addr in [("127.0.0.1", port), ("::1", port)] {
            let t = Duration::from_millis(250);
            if let Ok(Ok(_)) = tokio::time::timeout(t, tokio::net::TcpStream::connect(addr)).await {
                return true;
            }
        }
        if tokio::time::Instant::now() >= deadline {
            return false;
        }
        tokio::time::sleep(Duration::from_millis(250)).await;
    }
}

pub fn run_footprint(procs: &[ProcRecord]) -> u64 {
    procs.iter().filter(|r| owned_and_alive(r)).map(|r| procinfo::tree_footprint(r.pid)).sum()
}

/// Copy-truncate rotation: keeps the inode so children with O_APPEND fds keep logging.
pub fn rotate_log(path: &Path, max_bytes: u64) -> std::io::Result<bool> {
    if std::fs::metadata(path)?.len() <= max_bytes {
        return Ok(false);
    }
    let mut rotated = path.as_os_str().to_owned();
    rotated.push(".1");
    std::fs::copy(path, &rotated)?;
    std::fs::OpenOptions::new().write(true).open(path)?.set_len(0)?;
    Ok(true)
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
        assert!(wait_port(port, Duration::from_secs(2)).await);
        drop(l);
        // Port 1 (tcpmux) never has a listener on macOS; a freed ephemeral port may be
        // reused by a parallel test.
        let t = std::time::Instant::now();
        assert!(!wait_port(1, Duration::from_millis(600)).await);
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
}
