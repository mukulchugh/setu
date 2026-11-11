//! Port leasing.
#![allow(dead_code)]

use crate::model::PORT_RANGE;
use crate::naming::fnv1a;
use anyhow::{bail, Result};
use std::collections::{BTreeMap, BTreeSet};
use std::net::{SocketAddr, TcpListener, TcpStream};
use std::time::Duration;

pub fn port_free(port: u16) -> bool {
    // Listeners bound only to ::1 (common for "localhost" on macOS) must count as taken.
    let v6 = std::net::SocketAddr::from((std::net::Ipv6Addr::LOCALHOST, port));
    if std::net::TcpStream::connect_timeout(&v6, std::time::Duration::from_millis(100)).is_ok() {
        return false;
    }
    if std::net::TcpListener::bind(v6).is_err() && std::net::TcpListener::bind(("::1", 0)).is_ok() {
        return false;
    }
    port_free_v4(port)
}

fn port_free_v4(port: u16) -> bool {
    let addr = SocketAddr::from(([127, 0, 0, 1], port));
    if TcpStream::connect_timeout(&addr, Duration::from_millis(100)).is_ok() {
        return false;
    }
    TcpListener::bind(("127.0.0.1", port)).is_ok() && TcpListener::bind(("0.0.0.0", port)).is_ok()
}

pub fn lease(
    leases: &BTreeMap<String, BTreeMap<String, u16>>,
    run_key: &str,
    names: &[String],
    is_free: impl Fn(u16) -> bool,
) -> Result<BTreeMap<String, u16>> {
    if let Some(existing) = leases.get(run_key) {
        if names.iter().all(|n| existing.contains_key(n)) {
            return Ok(existing.clone());
        }
    }
    let mut result = leases.get(run_key).cloned().unwrap_or_default();
    let mut taken: BTreeSet<u16> = leases.values().flat_map(|m| m.values().copied()).collect();
    taken.extend(result.values().copied());
    let start = *PORT_RANGE.start() as u64;
    let len = (*PORT_RANGE.end() - *PORT_RANGE.start()) as u64 + 1;
    for name in names {
        if result.contains_key(name) {
            continue;
        }
        let first = fnv1a(&format!("{run_key}/{name}")) % len;
        let mut found = None;
        for i in 0..len {
            let p = (start + (first + i) % len) as u16;
            if !taken.contains(&p) && is_free(p) {
                found = Some(p);
                break;
            }
        }
        let Some(p) = found else { bail!("no free port left in {:?} for {run_key}/{name}", PORT_RANGE) };
        taken.insert(p);
        result.insert(name.clone(), p);
    }
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn names(v: &[&str]) -> Vec<String> {
        v.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn deterministic_and_in_range() {
        let a = lease(&BTreeMap::new(), "p/r", &names(&["web", "inngest"]), |_| true).unwrap();
        let b = lease(&BTreeMap::new(), "p/r", &names(&["web", "inngest"]), |_| true).unwrap();
        assert_eq!(a, b);
        assert_ne!(a["web"], a["inngest"]);
        assert!(a.values().all(|p| PORT_RANGE.contains(p)));
    }

    #[test]
    fn reuse_existing() {
        let mut leases = BTreeMap::new();
        leases.insert("p/r".to_string(), BTreeMap::from([("web".to_string(), 4321u16)]));
        let got = lease(&leases, "p/r", &names(&["web"]), |_| false).unwrap();
        assert_eq!(got["web"], 4321);
        // extending keeps the old port
        let got = lease(&leases, "p/r", &names(&["web", "x"]), |_| true).unwrap();
        assert_eq!(got["web"], 4321);
        assert_ne!(got["x"], 4321);
    }

    #[test]
    fn skips_other_runs_and_busy() {
        let first = lease(&BTreeMap::new(), "p/a", &names(&["web"]), |_| true).unwrap()["web"];
        let mut leases = BTreeMap::new();
        leases.insert("p/b".to_string(), BTreeMap::from([("web".to_string(), first)]));
        let got = lease(&leases, "p/a", &names(&["web"]), |_| true).unwrap()["web"];
        assert_ne!(got, first);
        let got2 = lease(&BTreeMap::new(), "p/a", &names(&["web"]), |p| p != first).unwrap()["web"];
        assert_ne!(got2, first);
        assert!(PORT_RANGE.contains(&got2));
    }

    #[test]
    fn wraps_and_exhausts() {
        assert!(lease(&BTreeMap::new(), "p/a", &names(&["web"]), |_| false).is_err());
        // only the very first range port is free: wrap-around must find it
        let got = lease(&BTreeMap::new(), "p/a", &names(&["web"]), |p| p == *PORT_RANGE.start()).unwrap();
        assert_eq!(got["web"], *PORT_RANGE.start());
    }

    #[test]
    fn port_free_detects_listener() {
        let l = TcpListener::bind("127.0.0.1:0").unwrap();
        let p = l.local_addr().unwrap().port();
        assert!(!port_free(p));
        // Not re-checked after drop: parallel tests may grab the freed ephemeral port.
    }
}
