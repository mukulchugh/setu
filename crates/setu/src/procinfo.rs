//! Process inspection (macOS via libproc). Non-macOS builds get inert stubs.
#![allow(dead_code)]

use std::collections::BTreeSet;

pub fn alive(pid: i32) -> bool {
    if pid <= 0 {
        return false;
    }
    // SAFETY: signal 0 only checks existence/permission; no signal is delivered.
    let r = unsafe { libc::kill(pid, 0) };
    r == 0 || std::io::Error::last_os_error().raw_os_error() == Some(libc::EPERM)
}

/// Pids in process group `pgid`.
pub fn group_pids(pgid: i32) -> Vec<i32> {
    sys::list(sys::PROC_PGRP_ONLY, pgid)
}

/// Direct children of `pid`.
pub fn children(pid: i32) -> Vec<i32> {
    sys::list(sys::PROC_PPID_ONLY, pid)
}

/// Kernel start time in microseconds since the epoch.
pub fn start_time(pid: i32) -> Option<u64> {
    sys::start_time(pid)
}

/// Physical footprint in bytes.
pub fn footprint(pid: i32) -> Option<u64> {
    sys::footprint(pid)
}

/// Group members plus all recursive descendants of each (catches children that left the group).
pub fn tree(pgid: i32) -> Vec<i32> {
    let mut seen: BTreeSet<i32> = BTreeSet::new();
    let mut stack: Vec<i32> = group_pids(pgid);
    while let Some(p) = stack.pop() {
        if p <= 0 || !seen.insert(p) {
            continue;
        }
        stack.extend(children(p));
    }
    seen.into_iter().collect()
}

pub fn tree_footprint(pgid: i32) -> u64 {
    tree(pgid).into_iter().filter_map(footprint).sum()
}

/// Current working directory of `pid` (None if gone or not permitted).
pub fn cwd(pid: i32) -> Option<std::path::PathBuf> {
    sys::cwd(pid)
}

/// TCP ports `pid` is listening on (IPv4 or IPv6), read from its sockets via libproc.
pub fn listening_ports(pid: i32) -> Vec<u16> {
    sys::listening_ports(pid)
}

/// A process whose cwd is inside `worktree` and that listens on `port`: (pid, start time).
/// This is the proof that a busy port belongs to that worktree's own dev server.
pub fn external_listener(worktree: &std::path::Path, port: u16) -> Option<(i32, u64)> {
    external_listeners(&[(worktree.to_path_buf(), port)]).pop().flatten()
}

/// `external_listener` for several (worktree, port) pairs with one scan of the process table.
pub fn external_listeners(wanted: &[(std::path::PathBuf, u16)]) -> Vec<Option<(i32, u64)>> {
    let me = std::process::id() as i32;
    let dirs: Vec<std::path::PathBuf> = wanted.iter().map(|(d, _)| std::fs::canonicalize(d).unwrap_or_else(|_| d.clone())).collect();
    let mut found: Vec<Option<(i32, u64)>> = vec![None; wanted.len()];
    for pid in all_pids() {
        if pid == me {
            continue;
        }
        let Some(c) = cwd(pid) else { continue };
        let hits: Vec<usize> = (0..wanted.len()).filter(|i| found[*i].is_none() && c.starts_with(&dirs[*i])).collect();
        if hits.is_empty() {
            continue;
        }
        let ports = listening_ports(pid);
        for i in hits {
            if ports.contains(&wanted[i].1) {
                found[i] = start_time(pid).map(|st| (pid, st));
            }
        }
    }
    found
}

/// Re-prove, right now, that this exact process incarnation still listens on `port` with its
/// cwd inside `worktree`.
pub fn listener_still_belongs(pid: i32, start: u64, worktree: &std::path::Path, port: u16) -> bool {
    let dir = std::fs::canonicalize(worktree).unwrap_or_else(|_| worktree.to_path_buf());
    start_time(pid) == Some(start) && cwd(pid).is_some_and(|c| c.starts_with(&dir)) && listening_ports(pid).contains(&port)
}

/// Parent, process group and start time of `pid`, from one libproc call.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Ident {
    pub ppid: i32,
    pub pgid: i32,
    pub start: u64,
}

pub fn ident(pid: i32) -> Option<Ident> {
    sys::ident(pid)
}

/// Executable name (basename of the path, a login shell's leading `-` removed).
pub fn exe_name(pid: i32) -> Option<String> {
    sys::exe_name(pid)
}

/// Shells and login programs are never treated as v1 dev servers or sidecars.
pub fn is_shell_name(n: &str) -> bool {
    matches!(n.trim_start_matches('-'), "zsh" | "bash" | "sh" | "fish" | "login")
}

/// What a v1 run left running: the listener, the process group it leads (when provable) and
/// the other v1 groups (sidecars) started from the same worktree.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct V1Found {
    pub listener: Option<(i32, u64)>,
    /// (leader pid, start time) of the listener's group.
    pub leader: Option<(i32, u64)>,
    /// (leader pid, start time) of every sidecar group.
    pub sidecars: Vec<(i32, u64)>,
}

fn orphaned(ppid: i32, portal: Option<i32>) -> bool {
    ppid == 1 || portal == Some(ppid)
}

/// Detect, with one scan of the process table, the v1 groups of every (worktree, port) pair.
/// A group qualifies when its leader (pgid == pid) has its cwd inside the worktree and was
/// orphaned (ppid 1, or `portal`). Shells never qualify; sidecars exclude `git`.
pub fn v1_groups(wanted: &[(std::path::PathBuf, u16)], portal: Option<i32>) -> Vec<V1Found> {
    let me = std::process::id() as i32;
    let dirs: Vec<std::path::PathBuf> = wanted.iter().map(|(d, _)| std::fs::canonicalize(d).unwrap_or_else(|_| d.clone())).collect();
    let mut found: Vec<V1Found> = vec![V1Found::default(); wanted.len()];
    // per wanted index: (pid, ident) of every process whose cwd is inside the worktree
    let mut cands: Vec<Vec<(i32, Ident)>> = vec![Vec::new(); wanted.len()];
    let mut listener_pgid: Vec<Option<i32>> = vec![None; wanted.len()];
    for pid in all_pids() {
        if pid == me {
            continue;
        }
        let Some(c) = cwd(pid) else { continue };
        let hits: Vec<usize> = (0..wanted.len()).filter(|i| c.starts_with(&dirs[*i])).collect();
        if hits.is_empty() {
            continue;
        }
        let Some(id) = ident(pid) else { continue };
        let ports = listening_ports(pid);
        for i in hits {
            cands[i].push((pid, id));
            if found[i].listener.is_none() && ports.contains(&wanted[i].1) {
                found[i].listener = Some((pid, id.start));
                listener_pgid[i] = Some(id.pgid);
            }
        }
    }
    for i in 0..wanted.len() {
        if found[i].listener.is_none() {
            continue;
        }
        let qualifies = |pid: i32, id: &Ident| id.pgid == pid && orphaned(id.ppid, portal) && !exe_name(pid).is_some_and(|n| is_shell_name(&n));
        if let Some(g) = listener_pgid[i] {
            if let Some((pid, id)) = cands[i].iter().find(|(p, _)| *p == g) {
                if qualifies(*pid, id) {
                    found[i].leader = Some((*pid, id.start));
                }
            }
        }
        let lead = found[i].leader.map(|l| l.0);
        for (pid, id) in &cands[i] {
            if Some(*pid) == lead || !qualifies(*pid, id) {
                continue;
            }
            if exe_name(*pid).as_deref() == Some("git") {
                continue;
            }
            found[i].sidecars.push((*pid, id.start));
        }
    }
    found
}

/// `v1_groups` for a single run.
pub fn v1_group(worktree: &std::path::Path, port: u16, portal: Option<i32>) -> V1Found {
    v1_groups(&[(worktree.to_path_buf(), port)], portal).pop().unwrap_or_default()
}

/// Re-prove, right now, that `pid` is still the same incarnation, still leads its own process
/// group, still has its cwd inside `worktree`, and is not a shell.
pub fn group_leader_still_belongs(pid: i32, start: u64, worktree: &std::path::Path) -> bool {
    let dir = std::fs::canonicalize(worktree).unwrap_or_else(|_| worktree.to_path_buf());
    ident(pid).is_some_and(|i| i.start == start && i.pgid == pid)
        && cwd(pid).is_some_and(|c| c.starts_with(&dir))
        && !exe_name(pid).is_some_and(|n| is_shell_name(&n))
}

/// `pid` and every recursive descendant.
pub fn descendants(pid: i32) -> Vec<i32> {
    let mut seen: BTreeSet<i32> = BTreeSet::new();
    let mut stack = vec![pid];
    while let Some(p) = stack.pop() {
        if p <= 0 || !seen.insert(p) {
            continue;
        }
        stack.extend(children(p));
    }
    seen.into_iter().collect()
}

/// Every pid libproc will list.
pub fn all_pids() -> Vec<i32> {
    sys::all_pids()
}

/// Pids whose cwd is `dir` or inside it (path-component prefix). Unreadable processes are skipped.
pub fn pids_with_cwd_under(dir: &std::path::Path) -> Vec<i32> {
    let dir = std::fs::canonicalize(dir).unwrap_or_else(|_| dir.to_path_buf());
    all_pids()
        .into_iter()
        .filter(|p| cwd(*p).is_some_and(|c| c.starts_with(&dir)))
        .collect()
}

#[cfg(target_os = "macos")]
mod sys {
    use std::ffi::c_void;

    pub const PROC_PGRP_ONLY: u32 = 2;
    pub const PROC_PPID_ONLY: u32 = 6;

    pub fn list(kind: u32, arg: i32) -> Vec<i32> {
        if arg <= 0 {
            return Vec::new();
        }
        // SAFETY: a null buffer asks libproc for the required size in bytes.
        let need = unsafe { libc::proc_listpids(kind, arg as u32, std::ptr::null_mut(), 0) };
        if need <= 0 {
            return Vec::new();
        }
        // Slack for processes spawned between the two calls.
        let mut buf: Vec<i32> = vec![0; need as usize / 4 + 32];
        // SAFETY: buf is valid for buf.len()*4 writable bytes.
        let got = unsafe {
            libc::proc_listpids(kind, arg as u32, buf.as_mut_ptr() as *mut c_void, (buf.len() * 4) as i32)
        };
        if got <= 0 {
            return Vec::new();
        }
        buf.truncate(got as usize / 4);
        buf.retain(|p| *p != 0);
        buf
    }

    pub fn start_time(pid: i32) -> Option<u64> {
        // SAFETY: proc_bsdinfo is plain data; all-zero is valid.
        let mut info: libc::proc_bsdinfo = unsafe { std::mem::zeroed() };
        let size = std::mem::size_of::<libc::proc_bsdinfo>() as i32;
        // SAFETY: info is a writable buffer of `size` bytes.
        let r = unsafe {
            libc::proc_pidinfo(pid, libc::PROC_PIDTBSDINFO, 0, &mut info as *mut _ as *mut c_void, size)
        };
        if r != size {
            return None;
        }
        Some(info.pbi_start_tvsec * 1_000_000 + info.pbi_start_tvusec)
    }

    pub fn ident(pid: i32) -> Option<super::Ident> {
        // SAFETY: proc_bsdinfo is plain data; all-zero is valid.
        let mut info: libc::proc_bsdinfo = unsafe { std::mem::zeroed() };
        let size = std::mem::size_of::<libc::proc_bsdinfo>() as i32;
        // SAFETY: info is a writable buffer of `size` bytes.
        let r = unsafe { libc::proc_pidinfo(pid, libc::PROC_PIDTBSDINFO, 0, &mut info as *mut _ as *mut c_void, size) };
        if r != size {
            return None;
        }
        Some(super::Ident { ppid: info.pbi_ppid as i32, pgid: info.pbi_pgid as i32, start: info.pbi_start_tvsec * 1_000_000 + info.pbi_start_tvusec })
    }

    pub fn exe_name(pid: i32) -> Option<String> {
        let mut buf = [0u8; 4096];
        // SAFETY: buf is writable for its length.
        let n = unsafe { libc::proc_pidpath(pid, buf.as_mut_ptr() as *mut c_void, buf.len() as u32) };
        if n <= 0 {
            return None;
        }
        let path = String::from_utf8_lossy(&buf[..n as usize]).to_string();
        Some(path.rsplit('/').next().unwrap_or(&path).trim_start_matches('-').to_string())
    }

    pub fn cwd(pid: i32) -> Option<std::path::PathBuf> {
        use std::os::unix::ffi::OsStrExt;
        // SAFETY: proc_vnodepathinfo is plain data; all-zero is valid.
        let mut info: libc::proc_vnodepathinfo = unsafe { std::mem::zeroed() };
        let size = std::mem::size_of::<libc::proc_vnodepathinfo>() as i32;
        // SAFETY: info is a writable buffer of `size` bytes.
        let r = unsafe {
            libc::proc_pidinfo(pid, libc::PROC_PIDVNODEPATHINFO, 0, &mut info as *mut _ as *mut c_void, size)
        };
        if r != size {
            return None;
        }
        // vip_path is declared as [[c_char; 32]; 32] (a MAXPATHLEN=1024 byte block) in libc.
        // SAFETY: the array is 1024 contiguous bytes.
        let bytes: &[u8] = unsafe { std::slice::from_raw_parts(info.pvi_cdir.vip_path.as_ptr() as *const u8, 1024) };
        let n = bytes.iter().position(|b| *b == 0)?;
        if n == 0 {
            return None;
        }
        Some(std::path::PathBuf::from(std::ffi::OsStr::from_bytes(&bytes[..n])))
    }

    /// Listening TCP ports of `pid`. Reads `socket_fdinfo` by its documented layout
    /// (sys/proc_info.h), offsets counted from the start of the struct (24-byte proc_fileinfo
    /// header included, checked against a real listener by a test): `soi_family` at +184,
    /// `soi_kind` at +256 and, for a TCP socket, `insi_lport` at +268 and `tcpsi_state` at +344.
    pub fn listening_ports(pid: i32) -> Vec<u16> {
        const PROC_PIDFDSOCKETINFO: i32 = 3;
        const HDR: usize = 24;
        const SOCKINFO_TCP: i32 = 2;
        const TSI_S_LISTEN: i32 = 1;
        // SAFETY: a null buffer asks libproc for the required size in bytes.
        let need = unsafe { libc::proc_pidinfo(pid, libc::PROC_PIDLISTFDS, 0, std::ptr::null_mut(), 0) };
        if need <= 0 {
            return Vec::new();
        }
        let n = need as usize / std::mem::size_of::<libc::proc_fdinfo>() + 16;
        // SAFETY: proc_fdinfo is plain data.
        let mut fds: Vec<libc::proc_fdinfo> = vec![unsafe { std::mem::zeroed() }; n];
        // SAFETY: fds is writable for the byte length given.
        let got = unsafe { libc::proc_pidinfo(pid, libc::PROC_PIDLISTFDS, 0, fds.as_mut_ptr() as *mut c_void, (n * std::mem::size_of::<libc::proc_fdinfo>()) as i32) };
        if got <= 0 {
            return Vec::new();
        }
        fds.truncate(got as usize / std::mem::size_of::<libc::proc_fdinfo>());
        let rd32 = |b: &[u8], off: usize| i32::from_ne_bytes(b[off..off + 4].try_into().unwrap_or([0; 4]));
        let mut ports = Vec::new();
        for fd in fds.iter().filter(|f| f.proc_fdtype == libc::PROX_FDTYPE_SOCKET as u32) {
            let mut buf = [0u8; 1024];
            // SAFETY: buf is writable for 1024 bytes.
            let r = unsafe { libc::proc_pidfdinfo(pid, fd.proc_fd, PROC_PIDFDSOCKETINFO, buf.as_mut_ptr() as *mut c_void, buf.len() as i32) };
            if r < 348 {
                continue;
            }
            let _ = HDR;
            let (family, kind, lport, state) = (rd32(&buf, 184), rd32(&buf, 256), rd32(&buf, 268), rd32(&buf, 344));
            if kind == SOCKINFO_TCP && state == TSI_S_LISTEN && (family == libc::AF_INET || family == libc::AF_INET6) {
                // insi_lport is a network-order port held in an int.
                let port = u16::from_be((lport & 0xffff) as u16);
                if port != 0 {
                    ports.push(port);
                }
            }
        }
        ports
    }

    pub fn all_pids() -> Vec<i32> {
        // Unlike proc_listpids (which returns bytes), proc_listallpids returns a PID COUNT,
        // both for the size probe and the filled call. Getting this wrong kept ~1/10 of PIDs
        // and let "is anything running in this worktree?" miss live processes.
        // SAFETY: a null buffer asks libproc for the current number of PIDs.
        let need = unsafe { libc::proc_listallpids(std::ptr::null_mut(), 0) };
        if need <= 0 {
            return Vec::new();
        }
        let mut buf: Vec<i32> = vec![0; need as usize + 256];
        // SAFETY: buf is valid for buf.len()*4 writable bytes.
        let got = unsafe {
            libc::proc_listallpids(buf.as_mut_ptr() as *mut c_void, (buf.len() * std::mem::size_of::<i32>()) as i32)
        };
        if got <= 0 {
            return Vec::new();
        }
        buf.truncate((got as usize).min(buf.len()));
        buf.retain(|p| *p > 0);
        buf
    }

    pub fn footprint(pid: i32) -> Option<u64> {
        // SAFETY: rusage_info_v4 is plain data; all-zero is valid.
        let mut info: libc::rusage_info_v4 = unsafe { std::mem::zeroed() };
        // SAFETY: the C parameter is declared `rusage_info_t *` but is a pointer to the
        // caller's flavor-sized struct; info is writable and outlives the call.
        let r = unsafe {
            libc::proc_pid_rusage(pid, libc::RUSAGE_INFO_V4, &mut info as *mut _ as *mut libc::rusage_info_t)
        };
        if r != 0 {
            return None;
        }
        Some(info.ri_phys_footprint)
    }
}

#[cfg(not(target_os = "macos"))]
mod sys {
    pub const PROC_PGRP_ONLY: u32 = 2;
    pub const PROC_PPID_ONLY: u32 = 6;
    pub fn list(_kind: u32, _arg: i32) -> Vec<i32> {
        Vec::new()
    }
    pub fn start_time(_pid: i32) -> Option<u64> {
        None
    }
    pub fn cwd(_pid: i32) -> Option<std::path::PathBuf> {
        None
    }
    pub fn ident(_pid: i32) -> Option<super::Ident> {
        None
    }
    pub fn exe_name(_pid: i32) -> Option<String> {
        None
    }
    pub fn all_pids() -> Vec<i32> {
        Vec::new()
    }
    pub fn listening_ports(_pid: i32) -> Vec<u16> {
        Vec::new()
    }
    pub fn footprint(_pid: i32) -> Option<u64> {
        None
    }
}

#[cfg(all(test, target_os = "macos"))]
mod tests {
    use super::*;

    #[test]
    fn self_info() {
        let me = std::process::id() as i32;
        assert!(alive(me));
        assert!(start_time(me).is_some());
        assert!(footprint(me).unwrap() > 0);
        assert!(tree_footprint(unsafe { libc::getpgid(0) }) > 0);
        assert!(!alive(i32::MAX));
    }

    #[test]
    fn cwd_of_spawned_child() {
        let dir = std::env::temp_dir().join(format!("setu-cwd-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let canon = std::fs::canonicalize(&dir).unwrap();
        let mut child = std::process::Command::new("sleep").arg("30").current_dir(&dir).spawn().unwrap();
        let pid = child.id() as i32;
        let got = cwd(pid);
        let under = pids_with_cwd_under(&dir);
        let _ = child.kill();
        let _ = child.wait();
        let _ = std::fs::remove_dir_all(&dir);
        assert_eq!(got, Some(canon));
        assert!(under.contains(&pid));
        assert!(all_pids().contains(&pid) || !alive(pid));
    }
}

#[cfg(all(test, target_os = "macos"))]
mod listener_tests {
    use super::*;

    #[test]
    fn a_listener_in_a_directory_is_found_by_port_and_cwd_and_a_stranger_is_not() {
        let l = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = l.local_addr().unwrap().port();
        let me = std::process::id() as i32;
        assert!(listening_ports(me).contains(&port), "own listener must be visible");
        // a child server started in a directory
        let dir = std::fs::canonicalize(std::env::temp_dir()).unwrap().join(format!("setu-listen-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let free = {
            let t = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
            t.local_addr().unwrap().port()
        };
        let mut child = std::process::Command::new("python3").args(["-m", "http.server", &free.to_string(), "--bind", "127.0.0.1"]).current_dir(&dir).stdout(std::process::Stdio::null()).stderr(std::process::Stdio::null()).spawn().unwrap();
        let pid = child.id() as i32;
        let mut found = None;
        for _ in 0..100 {
            found = external_listener(&dir, free);
            if found.is_some() {
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(50));
        }
        let elsewhere = external_listener(&std::env::temp_dir().join("setu-listen-nowhere"), free);
        let wrong_port = external_listener(&dir, free.wrapping_add(1).max(1025));
        let proof = found.map(|(p, st)| listener_still_belongs(p, st, &dir, free));
        let _ = child.kill();
        let _ = child.wait();
        let _ = std::fs::remove_dir_all(&dir);
        assert_eq!(found.map(|f| f.0), Some(pid));
        assert_eq!(proof, Some(true));
        assert!(elsewhere.is_none(), "cwd outside the worktree is not proof");
        assert!(wrong_port.is_none() || wrong_port.map(|f| f.0) != Some(pid) || free.wrapping_add(1) == free);
        drop(l);
    }
}

#[cfg(all(test, target_os = "macos"))]
mod all_pids_count_tests {
    #[test]
    fn all_pids_sees_every_process() {
        let ours = super::all_pids();
        let ps = std::process::Command::new("ps").arg("-A").arg("-o").arg("pid=").output().unwrap();
        let ps_count = String::from_utf8_lossy(&ps.stdout).lines().filter(|l| !l.trim().is_empty()).count();
        // Processes come and go between the two reads; allow a small difference only.
        assert!(ours.len() * 10 >= ps_count * 9, "all_pids saw {} of {} processes", ours.len(), ps_count);
        assert!(ours.contains(&(std::process::id() as i32)));
        assert!(ours.contains(&1));
    }
}
