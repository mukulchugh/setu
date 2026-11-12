//! One-time import of the pre-SQLite state (slice 8): `state.json`, claim files, removal-operation
//! records, `autoremove.json` and the three JSONL audit logs. Runs once, in a single transaction,
//! when the database has no `meta.imported_from_json`; afterwards the originals are renamed to
//! `<name>.imported-<ts>` (kept, never deleted) and are not read again.

use crate::autoremove::{self, AutoState};
use crate::claims::{self, Claim};
use crate::db::{insert_event, Db, Event};
use crate::state::{self, State};
use crate::worktree::{self, OpRecord};
use anyhow::{Context, Result};
use serde_json::{json, Map, Value};
use std::collections::BTreeSet;
use std::path::{Path, PathBuf};

pub const META_KEY: &str = "imported_from_json";

/// Seconds since the epoch for `YYYY-MM-DDTHH:MM:SSZ` (what `env::rfc3339_now` writes).
pub fn parse_rfc3339(s: &str) -> Option<u64> {
    let b = s.as_bytes();
    if b.len() != 20 || b[4] != b'-' || b[7] != b'-' || b[10] != b'T' || b[13] != b':' || b[16] != b':' || b[19] != b'Z' {
        return None;
    }
    let n = |r: std::ops::Range<usize>| s.get(r)?.parse::<i64>().ok();
    let (y, m, d, hh, mm, ss) = (n(0..4)?, n(5..7)?, n(8..10)?, n(11..13)?, n(14..16)?, n(17..19)?);
    if !(1..=12).contains(&m) || !(1..=31).contains(&d) || hh > 23 || mm > 59 || ss > 60 {
        return None;
    }
    // Howard Hinnant's days_from_civil.
    let y = if m <= 2 { y - 1 } else { y };
    let era = y.div_euclid(400);
    let yoe = y.rem_euclid(400);
    let mp = if m > 2 { m - 3 } else { m + 9 };
    let doy = (153 * mp + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = era * 146_097 + doe - 719_468;
    u64::try_from(days * 86_400 + hh * 3600 + mm * 60 + ss).ok()
}

fn read_json<T: serde::de::DeserializeOwned>(p: &Path) -> Result<T> {
    let b = std::fs::read(p).with_context(|| format!("reading {}", p.display()))?;
    serde_json::from_slice(&b).with_context(|| format!("{} is not valid; fix or move it aside, then restart", p.display()))
}

/// `<dir>/<project>/<run>.json` files, sorted.
fn json_files_two_deep(dir: &Path) -> Vec<PathBuf> {
    let mut out = Vec::new();
    let Ok(projects) = std::fs::read_dir(dir) else { return out };
    for p in projects.flatten() {
        let Ok(files) = std::fs::read_dir(p.path()) else { continue };
        for f in files.flatten() {
            let path = f.path();
            let name = f.file_name().to_string_lossy().into_owned();
            if path.extension().is_some_and(|x| x == "json") && !name.starts_with('.') {
                out.push(path);
            }
        }
    }
    out.sort();
    out
}

fn key_from_path(p: &Path) -> String {
    let run = p.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default();
    let project = p.parent().and_then(|d| d.file_name()).map(|s| s.to_string_lossy().into_owned()).unwrap_or_default();
    format!("{project}/{run}")
}

fn lines(p: &Path) -> Vec<Value> {
    std::fs::read_to_string(p).map(|t| t.lines().filter_map(|l| serde_json::from_str::<Value>(l).ok()).collect()).unwrap_or_default()
}

fn s(v: &Value, k: &str) -> Option<String> {
    v.get(k).and_then(Value::as_str).map(String::from)
}

/// An env or worktree audit line as an event (`ts` is rfc3339 in both).
fn event_from_line(v: &Value, kind_of: impl Fn(&str) -> &'static str) -> Option<Event> {
    let op = s(v, "op")?;
    let ts = parse_rfc3339(v.get("ts")?.as_str()?)?;
    let obj = v.as_object()?;
    let mut detail = Map::new();
    for (k, x) in obj {
        if !matches!(k.as_str(), "ts" | "actor" | "op" | "scope" | "name" | "client" | "run") {
            detail.insert(k.clone(), x.clone());
        }
    }
    let kind = kind_of(&op);
    let run_key = if kind == "env" {
        (s(v, "scope").as_deref() == Some("worktree")).then(|| s(v, "target")).flatten()
    } else {
        s(v, "run").filter(|r| !r.is_empty())
    };
    Some(Event { ts, actor: s(v, "actor"), client: s(v, "client"), kind, op, run_key, scope: s(v, "scope"), name: s(v, "name"), detail: Value::Object(detail) })
}

fn disk_event(v: &Value) -> Option<Event> {
    let ts = v.get("ts")?.as_u64()?;
    Some(Event {
        ts,
        actor: Some("system".into()),
        client: None,
        kind: "disk",
        op: "clean".into(),
        run_key: s(v, "run"),
        scope: None,
        name: s(v, "item"),
        detail: json!({ "path": v.get("path"), "estimate_bytes": v.get("estimate_bytes"), "volume_free_delta_bytes": v.get("volume_free_delta_bytes") }),
    })
}

/// Import if not done yet. A file that cannot be read aborts everything (nothing is renamed or
/// marked), so the next start tries again after the user fixes or moves it.
pub fn run(db: &Db, state_dir: &Path, logs_dir: &Path) -> Result<()> {
    let mut sources: Vec<PathBuf> = Vec::new();
    let imported = db.tx(|tx| {
        let done: Option<String> = tx.query_opt("SELECT value FROM meta WHERE key = ?1", [META_KEY], |r| Ok(r.get::<String>(0)?))?;
        if done.is_some() {
            return Ok(false);
        }
        let mut counts = Map::new();

        let sp = state_dir.join("state.json");
        if sp.is_file() {
            let mut st: State = read_json(&sp)?;
            // Keep the first lease per port so the UNIQUE(port) constraint cannot reject the import.
            let mut seen = BTreeSet::new();
            for m in st.leases.values_mut() {
                m.retain(|_, p| seen.insert(*p));
            }
            counts.insert("runs".into(), json!(st.runs.len()));
            state::save_tx(tx, &st)?;
            sources.push(sp);
        }

        let mut n = 0;
        for p in json_files_two_deep(&state_dir.join("claims")) {
            let c = match read_json::<Claim>(&p) {
                Ok(c) => c,
                // An unreadable claim stays visible and blocking, as before.
                Err(_) => {
                    let now = claims::now();
                    Claim { run: key_from_path(&p), holder: "(unreadable)".into(), pid: None, start_time: None, created: now, heartbeat: now }
                }
            };
            claims::put_tx(tx, &c)?;
            sources.push(p);
            n += 1;
        }
        counts.insert("claims".into(), json!(n));

        let mut n = 0;
        for p in json_files_two_deep(&state_dir.join("worktrees")) {
            let rec: OpRecord = read_json(&p)?;
            worktree::put_op_tx(tx, &rec)?;
            sources.push(p);
            n += 1;
        }
        counts.insert("removal_ops".into(), json!(n));

        let ap = state_dir.join("autoremove.json");
        if ap.is_file() {
            let st: AutoState = read_json(&ap)?;
            autoremove::save_tx(tx, &st)?;
            sources.push(ap);
        }

        let mut events: Vec<(PathBuf, Vec<Event>)> = Vec::new();
        let ep = logs_dir.join("env-audit.jsonl");
        let wp = logs_dir.join("worktree-audit.jsonl");
        let dp = logs_dir.join("disk-audit.jsonl");
        events.push((ep.clone(), lines(&ep).iter().filter_map(|v| event_from_line(v, |_| "env")).collect()));
        events.push((wp.clone(), lines(&wp).iter().filter_map(|v| event_from_line(v, |op| if op.starts_with("autoremove-") { "autoremove" } else { "worktree" })).collect()));
        events.push((dp.clone(), lines(&dp).iter().filter_map(disk_event).collect()));
        let mut n = 0;
        for (p, evs) in &events {
            for e in evs {
                insert_event(tx, e)?;
                n += 1;
            }
            if p.is_file() {
                sources.push(p.clone());
            }
        }
        counts.insert("events".into(), json!(n));
        counts.insert("at".into(), json!(crate::db::now_secs()));
        tx.execute("INSERT INTO meta (key, value) VALUES (?1, ?2)", crate::db::params![META_KEY, Value::Object(counts).to_string()])?;
        Ok(true)
    })?;
    if imported {
        let ts = worktree::compact_ts();
        for p in sources {
            let Some(name) = p.file_name().map(|n| n.to_string_lossy().into_owned()) else { continue };
            let to = p.with_file_name(format!("{name}.imported-{ts}"));
            if let Err(e) = std::fs::rename(&p, &to) {
                eprintln!("setu: imported {} but could not rename it: {e}", p.display());
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::tests::tmp;
    use crate::model::{ProcRecord, RunId, RunRecord, RunSpec, RunStatus};
    use std::collections::BTreeMap;
    use std::fs;
    use std::time::Duration;

    #[test]
    fn rfc3339_round_trips_with_the_writer() {
        assert_eq!(parse_rfc3339("1970-01-01T00:00:00Z"), Some(0));
        assert_eq!(parse_rfc3339("2000-03-01T01:02:03Z"), Some(951_872_523));
        assert_eq!(parse_rfc3339("2026-13-01T00:00:00Z"), None);
        assert_eq!(parse_rfc3339("nope"), None);
        let now = crate::db::now_secs();
        let back = parse_rfc3339(&crate::env::rfc3339_now()).unwrap();
        assert!(back.abs_diff(now) <= 2);
    }

    /// Writes the old on-disk layout; returns (state dir, logs dir).
    fn fixture(tag: &str) -> (PathBuf, PathBuf) {
        let root = tmp(tag);
        let (st, logs) = (root.join("state"), root.join("logs"));
        fs::create_dir_all(st.join("claims/app")).unwrap();
        fs::create_dir_all(st.join("worktrees/app")).unwrap();
        fs::create_dir_all(&logs).unwrap();
        let spec = RunSpec {
            id: RunId { project: "app".into(), run: "feat-a".into() },
            worktree: "/w/feat-a".into(),
            host: "feat-a.app.local".into(),
            url: "http://feat-a.app.local".into(),
            ports: BTreeMap::from([("web".to_string(), 4123u16)]),
            env: BTreeMap::from([("API_KEY".to_string(), "CANARY-IMPORT-SECRET".to_string())]),
            procs: vec![],
            web_port: Some(4123),
            idle: Duration::from_secs(60),
        };
        let rec = RunRecord {
            spec,
            status: RunStatus::Running,
            pinned: true,
            procs: vec![ProcRecord { name: "web".into(), pid: 4242, start_time: 99, escaped: vec![] }],
            note: Some("hello".into()),
            stopped_at: Some(11),
            env_hash: Some(u64::MAX - 5),
            last_started_at: Some(12),
            last_request_at: Some(13),
        };
        let mut s = State::default();
        s.runs.insert("app/feat-a".into(), rec);
        s.leases.insert("app/feat-a".into(), BTreeMap::from([("web".to_string(), 4123u16)]));
        fs::write(st.join("state.json"), serde_json::to_vec_pretty(&s).unwrap()).unwrap();
        let c = Claim { run: "app/feat-a".into(), holder: "agent-x".into(), pid: Some(1), start_time: Some(7), created: 100, heartbeat: 200 };
        fs::write(st.join("claims/app/feat-a.json"), serde_json::to_vec(&c).unwrap()).unwrap();
        let op = OpRecord {
            version: 1,
            id: "abc-1".into(),
            project: "app".into(),
            run: "feat-b".into(),
            worktree: "/w/feat-b".into(),
            branch: Some("feat/b".into()),
            head: Some("deadbeef".into()),
            step: worktree::Step::Remove,
            archive: None,
            archived_files: 2,
            started: 50,
            updated: 60,
            finished: None,
            last_error: Some("boom".into()),
            backup_ref: None,
        };
        fs::write(st.join("worktrees/app/feat-b.json"), serde_json::to_vec(&op).unwrap()).unwrap();
        let mut ar = AutoState::default();
        ar.candidates.insert("app/feat-a".into(), autoremove::Candidate { since: 5, reason: "idle 14d".into() });
        ar.removals = autoremove::Removals { day: "2026-11-12".into(), count: 3 };
        ar.skips.insert("app/feat-a".into(), "pinned".into());
        fs::write(st.join("autoremove.json"), serde_json::to_vec(&ar).unwrap()).unwrap();
        fs::write(logs.join("env-audit.jsonl"), "{\"ts\":\"2026-11-10T10:00:00Z\",\"actor\":\"cli\",\"op\":\"set\",\"scope\":\"worktree\",\"target\":\"app/feat-a\",\"name\":\"API_KEY\",\"secret\":true}\nnot json\n").unwrap();
        fs::write(
            logs.join("worktree-audit.jsonl"),
            "{\"ts\":\"2026-11-10T11:00:00Z\",\"actor\":\"mcp\",\"op\":\"claim\",\"run\":\"app/feat-a\",\"client\":\"claude\",\"holder\":\"agent-x\"}\n{\"ts\":\"2026-11-10T12:00:00Z\",\"actor\":\"autoremove\",\"op\":\"autoremove-candidate\",\"run\":\"app/feat-a\",\"reason\":\"idle\"}\n",
        )
        .unwrap();
        fs::write(logs.join("disk-audit.jsonl"), "{\"ts\":1000,\"run\":\"app/feat-a\",\"item\":\"next\",\"path\":\"/w/.next\",\"estimate_bytes\":5,\"volume_free_delta_bytes\":-3}\n").unwrap();
        (st, logs)
    }

    #[test]
    fn imports_every_value_once_and_renames_the_originals() {
        let (st, logs) = fixture("import");
        let db = Db::open(&st.join("setu.db")).unwrap();
        run(&db, &st, &logs).unwrap();

        let s = state::load(&db).unwrap();
        let r = &s.runs["app/feat-a"];
        assert_eq!((r.status, r.pinned, r.note.as_deref()), (RunStatus::Running, true, Some("hello")));
        assert_eq!((r.stopped_at, r.last_started_at, r.last_request_at, r.env_hash), (Some(11), Some(12), Some(13), Some(u64::MAX - 5)));
        assert_eq!(r.procs[0].pid, 4242);
        assert_eq!(r.spec.ports["web"], 4123);
        assert!(r.spec.env.is_empty(), "secret env values are never stored");
        assert_eq!(s.leases["app/feat-a"]["web"], 4123);

        let c = claims::get(&db, "app/feat-a").unwrap().unwrap();
        assert_eq!((c.holder.as_str(), c.pid, c.start_time, c.created, c.heartbeat), ("agent-x", Some(1), Some(7), 100, 200));

        let op = worktree::load_op(&db, "app/feat-b").unwrap().unwrap();
        assert_eq!((op.step, op.archived_files, op.last_error.as_deref(), op.branch.as_deref()), (worktree::Step::Remove, 2, Some("boom"), Some("feat/b")));
        assert!(worktree::pending_removal(&db, "app/feat-b"));

        let a = autoremove::load_state(&db).unwrap();
        assert_eq!(a.candidates["app/feat-a"].since, 5);
        assert_eq!((a.removals.day.as_str(), a.removals.count, a.skips["app/feat-a"].as_str()), ("2026-11-12", 3, "pinned"));

        let ev = crate::db::list_events(&db, None, None, None, 50).unwrap();
        assert_eq!(ev.len(), 4, "the unparseable line is skipped");
        let env = ev.iter().find(|e| e["kind"] == "env").unwrap();
        assert_eq!((env["name"].as_str(), env["run"].as_str(), env["detail"]["secret"].as_bool()), (Some("API_KEY"), Some("app/feat-a"), Some(true)));
        assert_eq!(env["ts"].as_u64(), parse_rfc3339("2026-11-10T10:00:00Z"));
        let claim = ev.iter().find(|e| e["op"] == "claim").unwrap();
        assert_eq!((claim["kind"].as_str(), claim["client"].as_str(), claim["detail"]["holder"].as_str()), (Some("worktree"), Some("claude"), Some("agent-x")));
        assert_eq!(ev.iter().find(|e| e["op"] == "autoremove-candidate").unwrap()["kind"], "autoremove");
        let disk = ev.iter().find(|e| e["kind"] == "disk").unwrap();
        assert_eq!((disk["name"].as_str(), disk["detail"]["volume_free_delta_bytes"].as_i64()), (Some("next"), Some(-3)));

        // originals are renamed, not removed; nothing is left under the old names
        for old in ["state/state.json", "state/claims/app/feat-a.json", "state/worktrees/app/feat-b.json", "state/autoremove.json", "logs/env-audit.jsonl", "logs/worktree-audit.jsonl", "logs/disk-audit.jsonl"] {
            let p = st.parent().unwrap().join(old);
            assert!(!p.exists(), "{old} still there");
            let dir = p.parent().unwrap();
            let name = p.file_name().unwrap().to_string_lossy().into_owned();
            assert!(fs::read_dir(dir).unwrap().flatten().any(|e| e.file_name().to_string_lossy().starts_with(&format!("{name}.imported-"))), "{old} not kept");
        }

        // a second start does not import again, even if an old file reappears
        fs::write(st.join("state.json"), "{\"runs\":{},\"leases\":{}}").unwrap();
        run(&db, &st, &logs).unwrap();
        assert!(st.join("state.json").exists(), "left alone");
        assert_eq!(state::load(&db).unwrap().runs.len(), 1);
        assert_eq!(crate::db::list_events(&db, None, None, None, 50).unwrap().len(), 4);
        let _ = fs::remove_dir_all(st.parent().unwrap());
    }

    #[test]
    fn a_corrupt_file_aborts_without_marking_or_renaming() {
        let (st, logs) = fixture("corrupt");
        fs::write(st.join("state.json"), "{nope").unwrap();
        let db = Db::open(&st.join("setu.db")).unwrap();
        assert!(run(&db, &st, &logs).is_err());
        assert!(st.join("claims/app/feat-a.json").exists());
        assert_eq!(db.with(|c| c.scalar_i64("SELECT count(*) FROM meta", ())).unwrap(), 0);
        assert!(claims::get(&db, "app/feat-a").unwrap().is_none(), "the transaction rolled back");
        let _ = fs::remove_dir_all(st.parent().unwrap());
    }

    #[test]
    fn nothing_to_import_still_marks_done() {
        let root = tmp("empty");
        let db = Db::open(&root.join("state/setu.db")).unwrap();
        run(&db, &root.join("state"), &root.join("logs")).unwrap();
        assert!(db.with(|c| c.query_row("SELECT value FROM meta WHERE key = ?1", [META_KEY], |r| Ok(r.get::<String>(0)?))).is_ok());
        let _ = fs::remove_dir_all(&root);
    }
}
