//! Persistent daemon state: runs and port leases, stored in the SQLite database (`runs`, `leases`).
//! The daemon keeps the authoritative copy in memory and writes whole snapshots in one transaction.
//! Secrets never reach the database: env values and rendered proc commands are blanked, because
//! every start rebuilds the spec fresh from config and the env layers anyway.
#![allow(dead_code)]

use crate::db::Db;
use crate::model::{RunRecord, RunSpec, RunStatus};
use anyhow::{Context, Result};
use rusqlite::{params, Connection, Transaction};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};

#[derive(Debug, Default, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct State {
    pub runs: BTreeMap<String, RunRecord>,
    pub leases: BTreeMap<String, BTreeMap<String, u16>>,
}

fn scrub(spec: &RunSpec) -> RunSpec {
    let mut s = spec.clone();
    s.env.clear();
    for p in &mut s.procs {
        p.command.clear();
    }
    s
}

fn status_text(s: RunStatus) -> Result<String> {
    Ok(serde_json::to_value(s)?.as_str().unwrap_or("stopped").to_string())
}

pub fn load(db: &Db) -> Result<State> {
    db.with(load_conn)
}

pub fn load_conn(c: &Connection) -> Result<State> {
    let mut st = State::default();
    let mut q = c.prepare("SELECT key, spec_json, status, pinned, note, stopped_at, last_started_at, last_request_at, env_hash, procs_json FROM runs ORDER BY key")?;
    let rows = q.query_map([], |r| {
        Ok((
            r.get::<_, String>(0)?,
            r.get::<_, String>(1)?,
            r.get::<_, String>(2)?,
            r.get::<_, bool>(3)?,
            r.get::<_, Option<String>>(4)?,
            r.get::<_, Option<i64>>(5)?,
            r.get::<_, Option<i64>>(6)?,
            r.get::<_, Option<i64>>(7)?,
            r.get::<_, Option<String>>(8)?,
            r.get::<_, String>(9)?,
        ))
    })?;
    for row in rows {
        let (key, spec, status, pinned, note, stopped, started, request, hash, procs) = row?;
        let rec = RunRecord {
            spec: serde_json::from_str(&spec).with_context(|| format!("run {key}: bad spec in the database"))?,
            status: serde_json::from_value(serde_json::Value::String(status)).with_context(|| format!("run {key}: bad status"))?,
            pinned,
            procs: serde_json::from_str(&procs).with_context(|| format!("run {key}: bad procs"))?,
            note,
            stopped_at: stopped.map(|v| v as u64),
            env_hash: hash.and_then(|h| h.parse().ok()),
            last_started_at: started.map(|v| v as u64),
            last_request_at: request.map(|v| v as u64),
        };
        st.runs.insert(key, rec);
    }
    let mut q = c.prepare("SELECT run_key, name, port FROM leases")?;
    for row in q.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, i64>(2)?)))? {
        let (k, n, p) = row?;
        st.leases.entry(k).or_default().insert(n, p as u16);
    }
    Ok(st)
}

/// Make the runs and leases tables equal to `s`. Runs are upserted (never replaced, so rows that
/// reference them stay put); leases of runs that are not registered are not stored.
pub fn save_tx(tx: &Transaction, s: &State) -> Result<()> {
    tx.execute("DELETE FROM leases", [])?;
    {
        let mut up = tx.prepare_cached(
            "INSERT INTO runs (key, project, run, spec_json, status, pinned, note, stopped_at, last_started_at, last_request_at, env_hash, procs_json)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)
             ON CONFLICT(key) DO UPDATE SET project=excluded.project, run=excluded.run, spec_json=excluded.spec_json, status=excluded.status,
               pinned=excluded.pinned, note=excluded.note, stopped_at=excluded.stopped_at, last_started_at=excluded.last_started_at,
               last_request_at=excluded.last_request_at, env_hash=excluded.env_hash, procs_json=excluded.procs_json",
        )?;
        for (k, r) in &s.runs {
            up.execute(params![
                k,
                r.spec.id.project,
                r.spec.id.run,
                serde_json::to_string(&scrub(&r.spec))?,
                status_text(r.status)?,
                r.pinned,
                r.note,
                r.stopped_at.map(|v| v as i64),
                r.last_started_at.map(|v| v as i64),
                r.last_request_at.map(|v| v as i64),
                r.env_hash.map(|h| h.to_string()),
                serde_json::to_string(&r.procs)?,
            ])?;
        }
    }
    let keep: BTreeSet<&String> = s.runs.keys().collect();
    let mut have = tx.prepare("SELECT key FROM runs")?;
    let existing: Vec<String> = have.query_map([], |r| r.get(0))?.collect::<std::result::Result<_, _>>()?;
    drop(have);
    for k in existing.iter().filter(|k| !keep.contains(k)) {
        tx.execute("DELETE FROM runs WHERE key = ?1", [k])?;
    }
    let mut ins = tx.prepare_cached("INSERT INTO leases (run_key, name, port) VALUES (?1, ?2, ?3)")?;
    for (k, names) in &s.leases {
        if !s.runs.contains_key(k) {
            continue;
        }
        for (n, p) in names {
            ins.execute(params![k, n, *p as i64])?;
        }
    }
    Ok(())
}

pub fn save(db: &Db, s: &State) -> Result<()> {
    db.tx(|tx| save_tx(tx, s))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::tests::temp_db;
    use crate::model::{ResolvedProc, RunId};
    use std::time::Duration;

    fn sample() -> State {
        let mut s = State::default();
        let spec = RunSpec {
            id: RunId { project: "p".into(), run: "r".into() },
            worktree: "/w".into(),
            host: "r.p.local".into(),
            url: "http://r.p.local:7777".into(),
            ports: BTreeMap::from([("web".to_string(), 4001u16)]),
            env: BTreeMap::from([("TOKEN".to_string(), "CANARY-STATE-SECRET".to_string())]),
            procs: vec![ResolvedProc { name: "web".into(), command: "serve --key CANARY-STATE-SECRET".into(), cwd: "/w".into(), port: Some(4001), log_path: "/l/web.log".into() }],
            web_port: Some(4001),
            idle: Duration::from_secs(60),
        };
        s.runs.insert("p/r".into(), RunRecord { spec, status: RunStatus::Running, pinned: true, procs: vec![], note: None, stopped_at: None, env_hash: Some(u64::MAX), last_started_at: None, last_request_at: None });
        s.leases.insert("p/r".into(), BTreeMap::from([("web".to_string(), 4001u16)]));
        s
    }

    #[test]
    fn round_trip_strips_secrets_and_replaces_snapshots() {
        let (db, d) = temp_db("state-rt");
        save(&db, &sample()).unwrap();
        let back = load(&db).unwrap();
        assert_eq!(back.runs["p/r"].spec.web_port, Some(4001));
        assert!(back.runs["p/r"].pinned);
        assert_eq!(back.runs["p/r"].env_hash, Some(u64::MAX));
        assert_eq!(back.leases["p/r"]["web"], 4001);
        assert!(back.runs["p/r"].spec.env.is_empty());
        assert!(back.runs["p/r"].spec.procs[0].command.is_empty());
        assert_eq!(back.runs["p/r"].spec.procs[0].log_path.to_str(), Some("/l/web.log"));
        // a lease for an unregistered run is not stored
        let mut s = sample();
        s.leases.insert("ghost/x".into(), BTreeMap::from([("web".to_string(), 4002u16)]));
        save(&db, &s).unwrap();
        assert!(!load(&db).unwrap().leases.contains_key("ghost/x"));
        // an empty snapshot clears everything
        save(&db, &State::default()).unwrap();
        let e = load(&db).unwrap();
        assert!(e.runs.is_empty() && e.leases.is_empty());
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn a_duplicate_port_is_rejected_and_rolls_the_snapshot_back() {
        let (db, d) = temp_db("state-unique");
        save(&db, &sample()).unwrap();
        let mut bad = sample();
        let mut other = bad.runs["p/r"].clone();
        other.spec.id.run = "r2".into();
        bad.runs.insert("p/r2".into(), other);
        bad.leases.insert("p/r2".into(), BTreeMap::from([("web".to_string(), 4001u16)]));
        assert!(save(&db, &bad).is_err(), "UNIQUE(port) refuses a double allocation");
        let kept = load(&db).unwrap();
        assert_eq!(kept.runs.len(), 1, "the failed snapshot left no trace");
        assert_eq!(kept.leases["p/r"]["web"], 4001);
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn concurrent_writers_never_hold_the_same_port_twice() {
        let (db, d) = temp_db("state-conc");
        drop(db);
        let path = d.join("setu.db");
        // Separate connections (as separate processes would have) race to lease the same ports.
        let wins: Vec<usize> = std::thread::scope(|sc| {
            let hs: Vec<_> = (0..8)
                .map(|i| {
                    let path = path.clone();
                    sc.spawn(move || {
                        let db = Db::open(&path).unwrap();
                        let mut won = 0;
                        for port in 4000u16..4020 {
                            let r = db.tx(|tx| {
                                tx.execute("INSERT OR IGNORE INTO runs (key, project, run, spec_json, status, procs_json) VALUES (?1, 'p', ?2, '{}', 'stopped', '[]')", params![format!("p/r{i}"), format!("r{i}")])?;
                                tx.execute("INSERT INTO leases (run_key, name, port) VALUES (?1, ?2, ?3)", params![format!("p/r{i}"), format!("n{port}"), port as i64])?;
                                Ok(())
                            });
                            if r.is_ok() {
                                won += 1;
                            }
                        }
                        won
                    })
                })
                .collect();
            hs.into_iter().map(|h| h.join().unwrap()).collect()
        });
        assert_eq!(wins.iter().sum::<usize>(), 20, "every port is won by exactly one writer");
        let db = Db::open(&path).unwrap();
        let (total, distinct): (i64, i64) = db.with(|c| Ok(c.query_row("SELECT count(*), count(DISTINCT port) FROM leases", [], |r| Ok((r.get(0)?, r.get(1)?)))?)).unwrap();
        assert_eq!((total, distinct), (20, 20));
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn a_secret_canary_never_reaches_the_database_files() {
        let (db, d) = temp_db("state-canary");
        save(&db, &sample()).unwrap();
        db.with(|c| Ok(c.execute_batch("PRAGMA wal_checkpoint(FULL)")?)).unwrap();
        for f in std::fs::read_dir(&d).unwrap().flatten() {
            let bytes = std::fs::read(f.path()).unwrap();
            assert!(!bytes.windows(19).any(|w| w == b"CANARY-STATE-SECRET"), "{}", f.path().display());
        }
        let _ = std::fs::remove_dir_all(&d);
    }
}
