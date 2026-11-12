//! Which loopback family a run's dev server listens on. Some servers bind only `[::1]` (for
//! example `mintlify dev`), others only `127.0.0.1`. The proxy and the readiness check share this
//! one probe so they always agree: IPv4 first (no added latency for the common case), `[::1]` when
//! IPv4 is refused, and the family that worked is remembered per (run, port).

use crate::model::RunId;
use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};
use std::time::Duration;
use tokio::net::TcpStream;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Family {
    V4,
    V6,
}

impl Family {
    /// The `host` part of an `http://host:port` URI.
    pub fn authority_host(self) -> &'static str {
        match self {
            Family::V4 => "127.0.0.1",
            Family::V6 => "[::1]",
        }
    }
    fn addr(self) -> &'static str {
        match self {
            Family::V4 => "127.0.0.1",
            Family::V6 => "::1",
        }
    }
    fn other(self) -> Family {
        match self {
            Family::V4 => Family::V6,
            Family::V6 => Family::V4,
        }
    }
}

fn memo() -> &'static Mutex<HashMap<(String, u16), Family>> {
    static M: OnceLock<Mutex<HashMap<(String, u16), Family>>> = OnceLock::new();
    M.get_or_init(Default::default)
}

fn lock() -> std::sync::MutexGuard<'static, HashMap<(String, u16), Family>> {
    memo().lock().unwrap_or_else(|e| e.into_inner())
}

/// The family remembered for this run's port, if a connection ever succeeded.
#[cfg(test)]
pub fn remembered(run: &RunId, port: u16) -> Option<Family> {
    lock().get(&(run.to_string(), port)).copied()
}

/// One connection attempt per family: the remembered one first (IPv4 when nothing is remembered),
/// then the other. A success is remembered; a double failure forgets, so the next call re-probes.
pub async fn connect(run: &RunId, port: u16, per_try: Duration) -> Option<(TcpStream, Family)> {
    let key = (run.to_string(), port);
    let first = lock().get(&key).copied().unwrap_or(Family::V4);
    for fam in [first, first.other()] {
        if let Ok(Ok(s)) = tokio::time::timeout(per_try, TcpStream::connect((fam.addr(), port))).await {
            lock().insert(key, fam);
            return Some((s, fam));
        }
    }
    lock().remove(&key);
    None
}

/// Poll `connect` until it succeeds or `timeout` passes. `step` is the pause between rounds.
pub async fn wait(run: &RunId, port: u16, timeout: Duration, per_try: Duration, step: Duration) -> Option<Family> {
    let deadline = tokio::time::Instant::now() + timeout;
    loop {
        if let Some((_, fam)) = connect(run, port, per_try).await {
            return Some(fam);
        }
        if tokio::time::Instant::now() >= deadline {
            return None;
        }
        tokio::time::sleep(step).await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rid(n: &str) -> RunId {
        RunId { project: "p".into(), run: n.into() }
    }

    #[tokio::test(flavor = "current_thread")]
    async fn a_refused_remembered_family_is_reprobed_and_the_new_family_remembered() {
        let run = rid("reprobe");
        let v6 = std::net::TcpListener::bind("[::1]:0").unwrap();
        let port = v6.local_addr().unwrap().port();
        let (_, fam) = connect(&run, port, Duration::from_millis(250)).await.unwrap();
        assert_eq!((fam, remembered(&run, port)), (Family::V6, Some(Family::V6)));
        drop(v6);
        let v4 = std::net::TcpListener::bind(("127.0.0.1", port)).unwrap();
        let (_, fam) = connect(&run, port, Duration::from_millis(250)).await.unwrap();
        assert_eq!((fam, remembered(&run, port)), (Family::V4, Some(Family::V4)));
        drop(v4);
        assert!(connect(&run, port, Duration::from_millis(250)).await.is_none());
        assert_eq!(remembered(&run, port), None, "a double refusal forgets");
    }

    #[tokio::test(flavor = "current_thread")]
    async fn ipv4_is_tried_first_when_nothing_is_remembered() {
        let run = rid("v4first");
        let v4 = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = v4.local_addr().unwrap().port();
        assert_eq!(connect(&run, port, Duration::from_millis(250)).await.unwrap().1, Family::V4);
    }
}
