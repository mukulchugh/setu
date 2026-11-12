//! In-flight request tracking per run, used for idle-stop decisions.
//! Design follows jdx/pitchfork's proxy activity tracker (MIT), keyed by `RunId`.
#![allow(dead_code)]

use crate::model::RunId;
use bytes::Bytes;
use hyper::body::{Body, Frame, SizeHint};
use std::collections::HashMap;
use std::pin::Pin;
use std::sync::{Arc, Mutex};
use std::task::{Context, Poll};
use std::time::{Duration, Instant};

struct Entry {
    in_flight: usize,
    last_activity: Instant,
    idle_stopping: bool,
    /// Wall-clock unix seconds of the last real proxied request (not `touch`). Feeds auto-removal.
    last_request: Option<u64>,
}

fn unix_now() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Snapshot {
    pub in_flight: usize,
    pub idle_for: Duration,
    pub idle_stopping: bool,
}

pub struct ActivityTracker {
    inner: Mutex<HashMap<RunId, Entry>>,
}

impl ActivityTracker {
    pub fn new() -> Arc<Self> {
        Arc::new(Self {
            inner: Mutex::new(HashMap::new()),
        })
    }

    fn entry<'a>(map: &'a mut HashMap<RunId, Entry>, run: &RunId) -> &'a mut Entry {
        map.entry(run.clone()).or_insert_with(|| Entry {
            in_flight: 0,
            last_activity: Instant::now(),
            idle_stopping: false,
            last_request: None,
        })
    }

    /// Start tracking one unit of traffic. `None` while the run is being idle-stopped.
    pub fn begin(self: &Arc<Self>, run: &RunId) -> Option<ActivityGuard> {
        let mut map = self.inner.lock().unwrap();
        let e = Self::entry(&mut map, run);
        if e.idle_stopping {
            return None;
        }
        e.in_flight += 1;
        e.last_activity = Instant::now();
        e.last_request = Some(unix_now());
        Some(ActivityGuard {
            tracker: self.clone(),
            run: run.clone(),
        })
    }

    /// Mark activity without a guard (e.g. when a run starts).
    pub fn touch(&self, run: &RunId) {
        let mut map = self.inner.lock().unwrap();
        Self::entry(&mut map, run).last_activity = Instant::now();
    }

    pub fn snapshot(&self, run: &RunId) -> Snapshot {
        let mut map = self.inner.lock().unwrap();
        let e = Self::entry(&mut map, run);
        Snapshot {
            in_flight: e.in_flight,
            idle_for: e.last_activity.elapsed(),
            idle_stopping: e.idle_stopping,
        }
    }

    /// Atomically decide to idle-stop: false if already stopping, busy, or idle < grace.
    pub fn claim_idle_stop(&self, run: &RunId, grace: Duration) -> bool {
        let mut map = self.inner.lock().unwrap();
        let e = Self::entry(&mut map, run);
        if e.idle_stopping || e.in_flight > 0 || e.last_activity.elapsed() < grace {
            return false;
        }
        e.idle_stopping = true;
        true
    }

    pub fn release_idle_stop(&self, run: &RunId) {
        let mut map = self.inner.lock().unwrap();
        let e = Self::entry(&mut map, run);
        e.idle_stopping = false;
        e.last_activity = Instant::now();
    }

    /// Unix seconds of the last proxied request, or None if there has been none since tracking began.
    pub fn last_request_unix(&self, run: &RunId) -> Option<u64> {
        self.inner.lock().unwrap().get(run).and_then(|e| e.last_request)
    }

    pub fn forget(&self, run: &RunId) {
        self.inner.lock().unwrap().remove(run);
    }
}

pub struct ActivityGuard {
    tracker: Arc<ActivityTracker>,
    run: RunId,
}

impl Drop for ActivityGuard {
    fn drop(&mut self) {
        let mut map = self.tracker.inner.lock().unwrap();
        if let Some(e) = map.get_mut(&self.run) {
            e.in_flight = e.in_flight.saturating_sub(1);
            e.last_activity = Instant::now();
            e.last_request = Some(unix_now());
        }
    }
}

/// Wraps a body, holding the guard until the body ends or is dropped.
pub struct GuardedBody<B> {
    inner: B,
    guard: Option<ActivityGuard>,
}

impl<B> GuardedBody<B> {
    pub fn new(inner: B, guard: ActivityGuard) -> Self {
        Self {
            inner,
            guard: Some(guard),
        }
    }
}

impl<B: Body<Data = Bytes> + Unpin> Body for GuardedBody<B> {
    type Data = Bytes;
    type Error = B::Error;

    fn poll_frame(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
    ) -> Poll<Option<Result<Frame<Bytes>, Self::Error>>> {
        let this = &mut *self;
        let res = Pin::new(&mut this.inner).poll_frame(cx);
        match &res {
            Poll::Ready(None) | Poll::Ready(Some(Err(_))) => this.guard = None,
            _ => {
                if this.inner.is_end_stream() {
                    this.guard = None;
                }
            }
        }
        res
    }

    fn is_end_stream(&self) -> bool {
        self.inner.is_end_stream()
    }

    fn size_hint(&self) -> SizeHint {
        self.inner.size_hint()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn run() -> RunId {
        RunId {
            project: "p".into(),
            run: "r".into(),
        }
    }

    #[test]
    fn begin_counts_and_drops() {
        let t = ActivityTracker::new();
        let g = t.begin(&run()).unwrap();
        assert_eq!(t.snapshot(&run()).in_flight, 1);
        drop(g);
        assert_eq!(t.snapshot(&run()).in_flight, 0);
    }

    #[test]
    fn last_request_is_wall_clock_and_only_set_by_real_requests() {
        let t = ActivityTracker::new();
        assert_eq!(t.last_request_unix(&run()), None);
        t.touch(&run()); // a start, not a request
        assert_eq!(t.last_request_unix(&run()), None);
        let g = t.begin(&run()).unwrap();
        let at = t.last_request_unix(&run()).unwrap();
        assert!(at > 1_700_000_000);
        drop(g);
        assert!(t.last_request_unix(&run()).unwrap() >= at);
        t.forget(&run());
        assert_eq!(t.last_request_unix(&run()), None);
    }

    #[test]
    fn claim_rules() {
        let t = ActivityTracker::new();
        let g = t.begin(&run()).unwrap();
        assert!(!t.claim_idle_stop(&run(), Duration::ZERO));
        drop(g);
        assert!(!t.claim_idle_stop(&run(), Duration::from_secs(60)));
        std::thread::sleep(Duration::from_millis(20));
        assert!(t.claim_idle_stop(&run(), Duration::from_millis(10)));
        assert!(!t.claim_idle_stop(&run(), Duration::ZERO));
        assert!(t.begin(&run()).is_none());
        t.release_idle_stop(&run());
        assert!(t.begin(&run()).is_some());
        t.forget(&run());
        assert_eq!(t.snapshot(&run()).in_flight, 0);
    }
}
