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
}
