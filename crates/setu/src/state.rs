//! Persistent daemon state (state.json).
#![allow(dead_code)]

use crate::model::RunRecord;
use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::fs::{self, File, OpenOptions};
use std::io::Write;
use std::os::unix::fs::{DirBuilderExt, OpenOptionsExt};
use std::path::Path;

#[derive(Debug, Default, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct State {
    pub runs: BTreeMap<String, RunRecord>,
    pub leases: BTreeMap<String, BTreeMap<String, u16>>,
}

pub fn load(path: &Path) -> Result<State> {
    match fs::read(path) {
        Ok(bytes) => serde_json::from_slice(&bytes).with_context(|| format!("corrupt state file {}", path.display())),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(State::default()),
        Err(e) => Err(e).with_context(|| format!("reading {}", path.display())),
    }
}

pub fn save(state: &State, path: &Path) -> Result<()> {
    let dir = path.parent().filter(|d| !d.as_os_str().is_empty()).unwrap_or(Path::new("."));
    fs::DirBuilder::new().recursive(true).mode(0o700).create(dir).with_context(|| format!("creating {}", dir.display()))?;
    let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("state");
    let tmp = dir.join(format!(".{name}.tmp.{}", std::process::id()));
    let data = serde_json::to_vec_pretty(state)?;
    let write = || -> Result<()> {
        let mut f = OpenOptions::new().write(true).create(true).truncate(true).mode(0o600).open(&tmp)?;
        f.write_all(&data)?;
        f.sync_all()?;
        fs::rename(&tmp, path)?;
        File::open(dir)?.sync_all()?;
        Ok(())
    };
    write().inspect_err(|_| {
        let _ = fs::remove_file(&tmp);
    })
    .with_context(|| format!("writing {}", path.display()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{RunId, RunSpec, RunStatus};
    use std::os::unix::fs::PermissionsExt;
    use std::time::Duration;

    fn tmpdir(tag: &str) -> std::path::PathBuf {
        let d = std::env::temp_dir().join(format!("setu-state-{tag}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&d);
        d
    }

    fn sample() -> State {
        let mut s = State::default();
        let spec = RunSpec {
            id: RunId { project: "p".into(), run: "r".into() },
            worktree: "/w".into(),
            host: "r.p.local".into(),
            url: "http://r.p.local:7777".into(),
            ports: BTreeMap::from([("web".to_string(), 4001u16)]),
            env: BTreeMap::new(),
            procs: vec![],
            web_port: Some(4001),
            idle: Duration::from_secs(60),
        };
        s.runs.insert("p/r".into(), RunRecord { spec, status: RunStatus::Running, pinned: true, procs: vec![], note: None });
        s.leases.insert("p/r".into(), BTreeMap::from([("web".to_string(), 4001u16)]));
        s
    }

    #[test]
    fn round_trip_and_mode() {
        let d = tmpdir("rt");
        let f = d.join("sub/state.json");
        save(&sample(), &f).unwrap();
        let back = load(&f).unwrap();
        assert_eq!(back.runs["p/r"].spec.web_port, Some(4001));
        assert!(back.runs["p/r"].pinned);
        assert_eq!(back.leases["p/r"]["web"], 4001);
        assert_eq!(fs::metadata(&f).unwrap().permissions().mode() & 0o777, 0o600);
        assert_eq!(fs::metadata(f.parent().unwrap()).unwrap().permissions().mode() & 0o777, 0o700);
        save(&State::default(), &f).unwrap();
        assert!(load(&f).unwrap().runs.is_empty());
        let _ = fs::remove_dir_all(&d);
    }

    #[test]
    fn missing_is_default_corrupt_is_err() {
        let d = tmpdir("bad");
        fs::create_dir_all(&d).unwrap();
        assert!(load(&d.join("nope.json")).unwrap().runs.is_empty());
        let f = d.join("state.json");
        fs::write(&f, "{not json").unwrap();
        assert!(load(&f).is_err());
        let _ = fs::remove_dir_all(&d);
    }
}
