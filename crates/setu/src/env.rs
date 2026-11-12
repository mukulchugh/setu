//! Layered env storage: global, project and worktree layers, each split into a plain file and a
//! 0600 secrets file. Pure functions over files; no daemon state. Callers decide what to return
//! over the socket: nothing here logs or audits a value.
// The coordinator wires these into the daemon/api/cli; until then they are unused.

use crate::config::load_env_layer;
use crate::model::RunId;
use crate::paths;
use anyhow::{bail, Context, Result};
use serde::Serialize;
use std::collections::{BTreeMap, BTreeSet};
use std::io::Write;
use std::os::unix::fs::{DirBuilderExt, OpenOptionsExt, PermissionsExt};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Scope {
    Global,
    Project(String),
    Worktree(RunId),
}

impl Scope {
    /// (plain file, secrets file) for this layer.
    pub fn paths(&self) -> (PathBuf, PathBuf) {
        let dir = paths::env_dir();
        match self {
            Scope::Global => (dir.join("global.toml"), dir.join("global.secrets.toml")),
            Scope::Project(p) => (dir.join(format!("{p}.toml")), dir.join(format!("{p}.secrets.toml"))),
            Scope::Worktree(id) => {
                let d = dir.join(&id.project);
                (d.join(format!("{}.toml", id.run)), d.join(format!("{}.secrets.toml", id.run)))
            }
        }
    }

    pub fn label(&self) -> String {
        match self {
            Scope::Global => "global",
            Scope::Project(_) => "project",
            Scope::Worktree(_) => "worktree",
        }
        .to_string()
    }

    fn target(&self) -> Option<String> {
        match self {
            Scope::Global => None,
            Scope::Project(p) => Some(p.clone()),
            Scope::Worktree(id) => Some(format!("{}/{}", id.project, id.run)),
        }
    }
}

/// Case-insensitive: contains KEY, TOKEN, SECRET or PASSWORD; ends with PASS; is DATABASE_URL;
/// ends with _DSN.
pub fn is_secret_name(name: &str) -> bool {
    let u = name.to_uppercase();
    ["KEY", "TOKEN", "SECRET", "PASSWORD"].iter().any(|p| u.contains(p))
        || u.ends_with("PASS")
        || u == "DATABASE_URL"
        || u.ends_with("_DSN")
}

/// Preview of a value: first 3 + "…" + last 4 chars; `None` under 12 chars.
pub fn mask(value: &str) -> Option<String> {
    let chars: Vec<char> = value.chars().collect();
    if chars.len() < 12 {
        return None;
    }
    let head: String = chars[..3].iter().collect();
    let tail: String = chars[chars.len() - 4..].iter().collect();
    Some(format!("{head}…{tail}"))
}

pub struct Var {
    pub name: String,
    pub value: String,
    pub secret: bool,
}

fn valid_name(name: &str) -> bool {
    let mut c = name.chars();
    matches!(c.next(), Some(f) if f.is_ascii_alphabetic() || f == '_')
        && c.all(|ch| ch.is_ascii_alphanumeric() || ch == '_')
}

fn load_pair(scope: &Scope) -> Result<(BTreeMap<String, String>, BTreeMap<String, String>)> {
    let (p, s) = scope.paths();
    Ok((load_env_layer(&p)?, load_env_layer(&s)?))
}

/// Plain file, then secrets file; secrets win on a clash and are marked secret.
pub fn read_layer(scope: &Scope) -> Result<Vec<Var>> {
    let (plain, secrets) = load_pair(scope)?;
    let mut all: BTreeMap<String, Var> = BTreeMap::new();
    for (name, value) in plain {
        all.insert(name.clone(), Var { name, value, secret: false });
    }
    for (name, value) in secrets {
        all.insert(name.clone(), Var { name, value, secret: true });
    }
    Ok(all.into_values().collect())
}

pub fn get_value(scope: &Scope, name: &str) -> Result<Option<String>> {
    Ok(read_layer(scope)?.into_iter().find(|v| v.name == name).map(|v| v.value))
}

/// Merged plain + secrets, for building a run's env.
pub fn layer_map(scope: &Scope) -> Result<BTreeMap<String, String>> {
    Ok(read_layer(scope)?.into_iter().map(|v| (v.name, v.value)).collect())
}

/// Names marked secret across the given layers (read errors are skipped).
#[allow(dead_code)] // kept for tests; MCP redaction reads layers directly
pub fn secret_names(scopes: &[Scope]) -> BTreeSet<String> {
    scopes
        .iter()
        .filter_map(|s| read_layer(s).ok())
        .flatten()
        .filter(|v| v.secret)
        .map(|v| v.name)
        .collect()
}

fn chmod(path: &Path, mode: u32) {
    let _ = std::fs::set_permissions(path, std::fs::Permissions::from_mode(mode));
}

fn ensure_dir(dir: &Path) -> Result<()> {
    std::fs::DirBuilder::new()
        .recursive(true)
        .mode(0o700)
        .create(dir)
        .with_context(|| format!("creating {}", dir.display()))?;
    chmod(&paths::env_dir(), 0o700);
    chmod(dir, 0o700);
    Ok(())
}

static TMP_SEQ: AtomicU64 = AtomicU64::new(0);

/// tmp file in the same dir (0600) -> write -> fsync -> rename -> fsync dir.
fn atomic_write(path: &Path, contents: &str) -> Result<()> {
    let dir = path.parent().context("env path has no parent")?;
    ensure_dir(dir)?;
    let tmp = dir.join(format!(
        ".{}.{}.{}.tmp",
        path.file_name().and_then(|n| n.to_str()).unwrap_or("env"),
        std::process::id(),
        TMP_SEQ.fetch_add(1, Ordering::Relaxed)
    ));
    let res = (|| -> Result<()> {
        let mut f = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(&tmp)
            .with_context(|| format!("creating {}", tmp.display()))?;
        f.write_all(contents.as_bytes())?;
        f.sync_all()?;
        std::fs::rename(&tmp, path).with_context(|| format!("writing {}", path.display()))?;
        std::fs::File::open(dir)?.sync_all()?;
        Ok(())
    })();
    if res.is_err() {
        let _ = std::fs::remove_file(&tmp);
    }
    res
}

fn write_map(path: &Path, map: &BTreeMap<String, String>) -> Result<()> {
    atomic_write(path, &toml::to_string(map).context("serializing env layer")?)
}

/// Apply many (name, value, explicit secret flag) updates with one read and at most two writes.
/// Returns the secret flag used for each, in order.
fn apply(scope: &Scope, updates: &[(String, String, Option<bool>)]) -> Result<Vec<bool>> {
    for (n, _, _) in updates {
        if !valid_name(n) {
            bail!("invalid env name {n:?}: use letters, digits and underscore, not starting with a digit");
        }
    }
    let (mut plain, mut secrets) = load_pair(scope)?;
    let (plain0, secrets0) = (plain.clone(), secrets.clone());
    let mut flags = Vec::with_capacity(updates.len());
    for (name, value, explicit) in updates {
        let existing = if secrets.contains_key(name) {
            Some(true)
        } else if plain.contains_key(name) {
            Some(false)
        } else {
            None
        };
        let secret = explicit.or(existing).unwrap_or_else(|| is_secret_name(name));
        let (dst, other) = if secret { (&mut secrets, &mut plain) } else { (&mut plain, &mut secrets) };
        other.remove(name);
        dst.insert(name.clone(), value.clone());
        flags.push(secret);
    }
    let (pp, sp) = scope.paths();
    if plain != plain0 {
        write_map(&pp, &plain)?;
    }
    if secrets != secrets0 {
        write_map(&sp, &secrets)?;
    }
    Ok(flags)
}

/// Returns the secret flag the value was stored with. Secret = explicit flag, else the name's
/// existing flag, else name detection.
pub fn write_var(scope: &Scope, name: &str, value: &str, secret: Option<bool>) -> Result<bool> {
    Ok(apply(scope, &[(name.to_string(), value.to_string(), secret)])?[0])
}

/// Returns whether the name existed.
pub fn unset_var(scope: &Scope, name: &str) -> Result<bool> {
    let (mut plain, mut secrets) = load_pair(scope)?;
    let (p, s) = (plain.remove(name).is_some(), secrets.remove(name).is_some());
    let (pp, sp) = scope.paths();
    if p {
        write_map(&pp, &plain)?;
    }
    if s {
        write_map(&sp, &secrets)?;
    }
    Ok(p || s)
}

/// Parse dotenv text. Problems carry line numbers and reasons only, never text from the input.
pub fn parse_dotenv(text: &str) -> (Vec<(String, String)>, Vec<String>) {
    let lines: Vec<&str> = text.split('\n').map(|l| l.strip_suffix('\r').unwrap_or(l)).collect();
    let (mut out, mut problems) = (Vec::new(), Vec::new());
    let mut i = 0;
    while i < lines.len() {
        let lineno = i + 1;
        let mut line = lines[i].trim_start();
        i += 1;
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        if let Some(r) = line.strip_prefix("export") {
            if r.starts_with([' ', '\t']) {
                line = r.trim_start();
            }
        }
        let Some((raw_name, rest)) = line.split_once('=') else {
            problems.push(format!("line {lineno}: no '=' found"));
            continue;
        };
        let name = raw_name.trim();
        let rest = rest.trim_start();
        let value = if let Some(r) = rest.strip_prefix('\'') {
            match r.find('\'') {
                Some(end) => Some(r[..end].to_string()),
                None => {
                    problems.push(format!("line {lineno}: unterminated single quote"));
                    None
                }
            }
        } else if let Some(r) = rest.strip_prefix('"') {
            let mut buf = String::new();
            let mut cur = r;
            let mut closed = false;
            loop {
                let mut chars = cur.chars();
                while let Some(c) = chars.next() {
                    match c {
                        '"' => {
                            closed = true;
                            break;
                        }
                        '\\' => match chars.next() {
                            Some('n') => buf.push('\n'),
                            Some('"') => buf.push('"'),
                            Some('\\') => buf.push('\\'),
                            Some(o) => {
                                buf.push('\\');
                                buf.push(o);
                            }
                            None => buf.push('\\'),
                        },
                        o => buf.push(o),
                    }
                }
                if closed || i >= lines.len() {
                    break;
                }
                buf.push('\n');
                cur = lines[i];
                i += 1;
            }
            if closed {
                Some(buf)
            } else {
                problems.push(format!("line {lineno}: unterminated double quote"));
                None
            }
        } else {
            let cut = rest.find(" #").or_else(|| rest.find("\t#")).unwrap_or(rest.len());
            Some(rest[..cut].trim_end().to_string())
        };
        let Some(value) = value else { continue };
        if !valid_name(name) {
            problems.push(format!("line {lineno}: invalid name"));
            continue;
        }
        out.push((name.to_string(), value));
    }
    (out, problems)
}

/// Names only, never values. `imported` includes `overwritten`.
#[derive(Debug, Default, Serialize)]
pub struct ImportReport {
    pub imported: Vec<String>,
    pub skipped: Vec<String>,
    pub overwritten: Vec<String>,
    pub secrets: Vec<String>,
    /// Parse problems: line numbers and reasons only.
    pub problems: Vec<String>,
}

pub fn import(scope: &Scope, text: &str, preview: bool, overwrite: bool) -> Result<ImportReport> {
    let (parsed, problems) = parse_dotenv(text);
    // Last duplicate wins; keep first-seen order.
    let mut order: Vec<String> = Vec::new();
    let mut vals: BTreeMap<String, String> = BTreeMap::new();
    for (k, v) in parsed {
        if vals.insert(k.clone(), v).is_none() {
            order.push(k);
        }
    }
    let existing: BTreeMap<String, bool> = read_layer(scope)?.into_iter().map(|v| (v.name, v.secret)).collect();
    let mut rep = ImportReport { problems, ..Default::default() };
    let mut updates = Vec::new();
    for name in order {
        let prior = existing.get(&name).copied();
        if prior.is_some() && !overwrite {
            rep.skipped.push(name);
            continue;
        }
        if prior.is_some() {
            rep.overwritten.push(name.clone());
        }
        if prior.unwrap_or_else(|| is_secret_name(&name)) {
            rep.secrets.push(name.clone());
        }
        let value = vals.remove(&name).unwrap_or_default();
        rep.imported.push(name.clone());
        updates.push((name, value, None));
    }
    if !preview && !updates.is_empty() {
        apply(scope, &updates)?;
    }
    Ok(rep)
}

pub(crate) fn rfc3339_now() -> String {
    rfc3339(crate::db::now_secs() as i64)
}

/// `YYYY-MM-DDTHH:MM:SSZ` for unix seconds.
pub(crate) fn rfc3339(secs: i64) -> String {
    let (days, rem) = (secs.div_euclid(86400), secs.rem_euclid(86400));
    // Howard Hinnant's civil_from_days.
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + i64::from(m <= 2);
    format!("{y:04}-{m:02}-{d:02}T{:02}:{:02}:{:02}Z", rem / 3600, rem % 3600 / 60, rem % 60)
}

/// Record an env event in the database. By API shape there is no value parameter:
/// callers cannot pass one. `extra` is for non-secret metadata (counts, flags); keys named
/// `value`/`values` are dropped defensively. Failures are reported to stderr, never panics.
pub fn audit(actor: &str, op: &str, scope: &Scope, name: Option<&str>, extra: Option<serde_json::Value>) {
    let mut detail = serde_json::Map::new();
    if let Some(t) = scope.target() {
        detail.insert("target".into(), serde_json::json!(t));
    }
    let mut client = None;
    if let Some(serde_json::Value::Object(x)) = extra {
        for (k, v) in x {
            if k == "client" {
                client = v.as_str().map(String::from);
            } else if k != "value" && k != "values" && !detail.contains_key(&k) {
                detail.insert(k, v);
            }
        }
    }
    crate::db::record(crate::db::Event {
        ts: crate::db::now_secs(),
        actor: Some(actor.into()),
        client,
        kind: "env",
        op: op.into(),
        run_key: matches!(scope, Scope::Worktree(_)).then(|| scope.target()).flatten(),
        scope: Some(scope.label()),
        name: name.map(String::from),
        detail: serde_json::Value::Object(detail),
    });
}

/// Stable FNV-1a (64-bit) over the sorted `k=v` pairs, for `stale_env`.
pub fn env_hash(env: &BTreeMap<String, String>) -> u64 {
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    let mut feed = |bytes: &[u8]| {
        for b in bytes {
            h ^= u64::from(*b);
            h = h.wrapping_mul(0x0000_0100_0000_01b3);
        }
    };
    for (k, v) in env {
        feed(k.as_bytes());
        feed(b"=");
        feed(v.as_bytes());
        feed(b"\0");
    }
    h
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Mutex, MutexGuard};

    static LOCK: Mutex<()> = Mutex::new(());
    static SEQ: AtomicU64 = AtomicU64::new(0);

    struct Sandbox {
        dir: PathBuf,
        _g: MutexGuard<'static, ()>,
    }
    impl Drop for Sandbox {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.dir);
        }
    }
    fn sandbox() -> Sandbox {
        let g = LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let dir = std::env::temp_dir().join(format!(
            "setu-env-test-{}-{}",
            std::process::id(),
            SEQ.fetch_add(1, Ordering::Relaxed)
        ));
        std::fs::create_dir_all(&dir).unwrap();
        std::env::set_var("SETU_HOME", &dir);
        Sandbox { dir, _g: g }
    }
    fn wt() -> Scope {
        Scope::Worktree(RunId { project: "proj".into(), run: "feat".into() })
    }
    fn mode(p: &Path) -> u32 {
        std::fs::metadata(p).unwrap().permissions().mode() & 0o777
    }

    #[test]
    fn secret_detection() {
        for n in ["API_KEY", "github_token", "MY_SECRET_X", "DB_PASSWORD", "ROOT_PASS", "DATABASE_URL", "sentry_dsn", "Monkey"] {
            assert!(is_secret_name(n), "{n}");
        }
        for n in ["PORT", "NODE_ENV", "DATABASE_URL_X", "DSN", "PASSENGER", "HOST"] {
            assert!(!is_secret_name(n), "{n}");
        }
    }

    #[test]
    fn masking() {
        assert_eq!(mask("short"), None);
        assert_eq!(mask("elevenchars"), None);
        assert_eq!(mask("abcdefghijkl").unwrap(), "abc…ijkl");
        assert_eq!(mask("ééééééééééééé").unwrap(), "ééé…éééé");
        assert_eq!(mask("日本語日本語日本語日本語").unwrap(), "日本語…語日本語");
        assert_eq!(mask("日本語日本語日"), None);
    }

    #[test]
    fn parser_cases() {
        let text = "# comment\n\nA=1\nexport B=two words\nC='lit\\n$x'\nD=\"a\\nb\\\"q\\\\\"\nE=x=y=z\nF=val # trailing\nG=\"multi\nline\" \r\nH=a#b\r\n9BAD=1\nnoequals\nI=\n";
        let (v, p) = parse_dotenv(text);
        let m: BTreeMap<_, _> = v.into_iter().collect();
        assert_eq!(m["A"], "1");
        assert_eq!(m["B"], "two words");
        assert_eq!(m["C"], "lit\\n$x");
        assert_eq!(m["D"], "a\nb\"q\\");
        assert_eq!(m["E"], "x=y=z");
        assert_eq!(m["F"], "val");
        assert_eq!(m["G"], "multi\nline");
        assert_eq!(m["H"], "a#b");
        assert_eq!(m["I"], "");
        assert_eq!(p.len(), 2, "{p:?}");
    }

    #[test]
    fn problems_never_contain_values() {
        let (_, p) = parse_dotenv("1bad=sk-supersecretvalue-123\nsk-supersecretvalue-123\nQ=\"sk-supersecretvalue-123\n");
        assert_eq!(p.len(), 3);
        assert!(p.iter().all(|s| !s.contains("supersecret") && !s.contains("1bad")), "{p:?}");
    }

    #[test]
    fn write_read_unset_round_trip() {
        let _s = sandbox();
        let sc = Scope::Project("proj".into());
        assert!(read_layer(&sc).unwrap().is_empty());
        assert!(!write_var(&sc, "PLAIN", "v1", None).unwrap());
        assert!(write_var(&sc, "API_TOKEN", "t1", None).unwrap());
        let (pp, sp) = sc.paths();
        assert!(std::fs::read_to_string(&pp).unwrap().contains("PLAIN"));
        assert!(!std::fs::read_to_string(&pp).unwrap().contains("API_TOKEN"));
        assert!(std::fs::read_to_string(&sp).unwrap().contains("API_TOKEN"));
        // existing flag sticks without an explicit one
        assert!(write_var(&sc, "API_TOKEN", "t2", None).unwrap());
        assert_eq!(get_value(&sc, "API_TOKEN").unwrap().as_deref(), Some("t2"));
        // move between files
        assert!(write_var(&sc, "PLAIN", "v1", Some(true)).unwrap());
        assert!(!std::fs::read_to_string(&pp).unwrap().contains("PLAIN"));
        assert!(!write_var(&sc, "API_TOKEN", "t2", Some(false)).unwrap());
        assert!(std::fs::read_to_string(&pp).unwrap().contains("API_TOKEN"));
        assert!(!std::fs::read_to_string(&sp).unwrap().contains("API_TOKEN"));
        let vars = read_layer(&sc).unwrap();
        assert_eq!(vars.len(), 2);
        assert!(vars.iter().find(|v| v.name == "PLAIN").unwrap().secret);
        assert!(unset_var(&sc, "PLAIN").unwrap());
        assert!(!unset_var(&sc, "PLAIN").unwrap());
        assert_eq!(layer_map(&sc).unwrap().len(), 1);
        assert!(write_var(&sc, "1BAD", "x", None).is_err());
        assert!(write_var(&sc, "A-B", "x", None).is_err());
    }

    #[test]
    fn secrets_win_on_clash() {
        let _s = sandbox();
        let sc = Scope::Global;
        let (pp, sp) = sc.paths();
        std::fs::create_dir_all(pp.parent().unwrap()).unwrap();
        std::fs::write(&pp, "X = \"plain\"\nY = \"y\"\n").unwrap();
        std::fs::write(&sp, "X = \"secret\"\n").unwrap();
        let vars = read_layer(&sc).unwrap();
        let x = vars.iter().find(|v| v.name == "X").unwrap();
        assert_eq!((x.value.as_str(), x.secret), ("secret", true));
        assert_eq!(layer_map(&sc).unwrap()["X"], "secret");
        assert_eq!(secret_names(&[sc]), BTreeSet::from(["X".to_string()]));
    }

    #[test]
    fn modes_and_scopes() {
        let _s = sandbox();
        let sc = wt();
        write_var(&sc, "DB_PASSWORD", "pw-123456789012", None).unwrap();
        write_var(&sc, "HOST", "h", None).unwrap();
        let (pp, sp) = sc.paths();
        assert!(sp.ends_with("env/proj/feat.secrets.toml"));
        assert!(pp.ends_with("env/proj/feat.toml"));
        assert_eq!(mode(&sp), 0o600);
        assert_eq!(mode(&pp), 0o600);
        assert_eq!(mode(pp.parent().unwrap()), 0o700);
        assert_eq!(mode(&paths::env_dir()), 0o700);
        assert_eq!((Scope::Global.label(), Scope::Project("p".into()).label(), sc.label()), ("global".into(), "project".into(), "worktree".into()));
        // pre-existing loose dir gets tightened
        chmod(pp.parent().unwrap(), 0o755);
        write_var(&sc, "A", "b", None).unwrap();
        assert_eq!(mode(pp.parent().unwrap()), 0o700);
        // no tmp files left behind
        assert!(std::fs::read_dir(pp.parent().unwrap()).unwrap().all(|e| !e.unwrap().file_name().to_string_lossy().ends_with(".tmp")));
    }

    #[test]
    fn import_preview_and_overwrite() {
        let _s = sandbox();
        let sc = Scope::Project("proj".into());
        write_var(&sc, "EXISTING", "old", None).unwrap();
        let text = "EXISTING=new\nFRESH=1\nSTRIPE_KEY=sk-aaaaaaaaaaaa\nbad line\n";
        let (pp, sp) = sc.paths();
        let before = std::fs::read_to_string(&pp).unwrap();
        let r = import(&sc, text, true, false).unwrap();
        assert_eq!(r.imported, ["FRESH", "STRIPE_KEY"]);
        assert_eq!(r.skipped, ["EXISTING"]);
        assert!(r.overwritten.is_empty());
        assert_eq!(r.secrets, ["STRIPE_KEY"]);
        assert_eq!(r.problems.len(), 1);
        assert_eq!(std::fs::read_to_string(&pp).unwrap(), before);
        assert!(!sp.exists());
        let r = import(&sc, text, false, false).unwrap();
        assert_eq!(r.imported.len(), 2);
        assert_eq!(get_value(&sc, "EXISTING").unwrap().as_deref(), Some("old"));
        assert_eq!(get_value(&sc, "STRIPE_KEY").unwrap().as_deref(), Some("sk-aaaaaaaaaaaa"));
        let r = import(&sc, text, false, true).unwrap();
        assert_eq!(r.overwritten, ["EXISTING", "FRESH", "STRIPE_KEY"]);
        assert_eq!(get_value(&sc, "EXISTING").unwrap().as_deref(), Some("new"));
        let json = serde_json::to_string(&r).unwrap();
        assert!(!json.contains("sk-aaaaaaaaaaaa"));
    }

    #[test]
    fn audit_has_no_value() {
        let _s = sandbox();
        let sc = wt();
        let secret = "sk-supersecretvalue-123";
        write_var(&sc, "OPENAI_API_KEY", secret, None).unwrap();
        audit("cli", "set", &sc, Some("OPENAI_API_KEY"), Some(serde_json::json!({"secret": true, "value": secret})));
        audit("cli", "reveal", &Scope::Global, None, None);
        let db = crate::db::global().unwrap();
        let evs = crate::db::list_events(&db, Some("env"), None, None, 10).unwrap();
        assert_eq!(evs.len(), 2);
        let text = serde_json::to_string(&evs).unwrap();
        assert!(!text.contains(secret));
        let first = evs.iter().find(|e| e["op"] == "set").unwrap();
        assert_eq!(first["scope"], "worktree");
        assert_eq!(first["run"], "proj/feat");
        assert_eq!(first["detail"]["target"], "proj/feat");
        assert_eq!(first["name"], "OPENAI_API_KEY");
        assert_eq!(first["detail"]["secret"], true);
        assert_eq!(first["actor"], "cli");
        // the database files themselves never hold the value
        db.checkpoint().unwrap();
        for f in std::fs::read_dir(db.path().parent().unwrap()).unwrap().flatten() {
            if f.file_name().to_string_lossy().starts_with("setu.db") {
                let bytes = std::fs::read(f.path()).unwrap();
                assert!(!bytes.windows(secret.len()).any(|w| w == secret.as_bytes()), "{}", f.path().display());
            }
        }
        // non-value surfaces (names, masks, import reports) never carry it
        let names = format!("{:?}", secret_names(&[sc.clone()]));
        let masked = format!("{:?}", read_layer(&sc).unwrap().iter().map(|v| (v.name.clone(), v.secret, mask(&v.value))).collect::<Vec<_>>());
        assert!(!names.contains(secret));
        assert!(!masked.contains(secret));
    }

    #[test]
    fn hash_stable_and_order_independent() {
        let a: BTreeMap<String, String> = [("A", "1"), ("B", "2")].iter().map(|(k, v)| (k.to_string(), v.to_string())).collect();
        let b: BTreeMap<String, String> = [("B", "2"), ("A", "1")].iter().map(|(k, v)| (k.to_string(), v.to_string())).collect();
        assert_eq!(env_hash(&a), env_hash(&b));
        assert_eq!(env_hash(&a), env_hash(&a.clone()));
        let c: BTreeMap<String, String> = [("A", "1"), ("B", "3")].iter().map(|(k, v)| (k.to_string(), v.to_string())).collect();
        assert_ne!(env_hash(&a), env_hash(&c));
        let d: BTreeMap<String, String> = [("AB", ""), ("", "")].iter().map(|(k, v)| (k.to_string(), v.to_string())).collect();
        let e: BTreeMap<String, String> = [("A", "B")].iter().map(|(k, v)| (k.to_string(), v.to_string())).collect();
        assert_ne!(env_hash(&d), env_hash(&e));
        assert_eq!(env_hash(&BTreeMap::new()), 0xcbf2_9ce4_8422_2325);
    }
}
