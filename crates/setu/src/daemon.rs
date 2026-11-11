//! The daemon: owns state, starts and stops runs, answers the proxy and the socket API.

use crate::activity::ActivityTracker;
use crate::config;
use crate::model::{Lookup, ProjectConfig, RunId, RunRecord, RunSpec, RunStatus, Routes, PROXY_PORT};
use crate::disk;
use crate::env;
use crate::disk_measure;
use crate::naming;
use crate::paths;
use crate::ports;
use crate::state::{self, State};
use crate::supervisor::{self, ExitEvent, ExitTx};
use anyhow::{anyhow, bail, Context, Result};
use serde_json::{json, Value};
use std::collections::{BTreeMap, HashMap};
use std::path::Path;
use std::sync::{Arc, Mutex};
use std::time::Duration;

const STOP_GRACE: Duration = Duration::from_secs(5);
/// First compile of a large Next app can take minutes.
const START_TIMEOUT: Duration = Duration::from_secs(300);
const SWEEP_EVERY: Duration = Duration::from_secs(10);
const LOG_MAX_BYTES: u64 = 20 * 1024 * 1024;

pub struct Daemon {
    inner: Mutex<Inner>,
    /// Highest state version written to disk; older snapshots are skipped.
    written: Arc<Mutex<u64>>,
    pub activity: Arc<ActivityTracker>,
    exits: ExitTx,
}

struct Inner {
    configs: Vec<ProjectConfig>,
    state: State,
    /// host -> run key
    hosts: HashMap<String, String>,
    version: u64,
}

fn key(id: &RunId) -> String {
    id.to_string()
}

impl Inner {
    fn rebuild_hosts(&mut self) {
        self.hosts = self.state.runs.iter().map(|(k, r)| (r.spec.host.clone(), k.clone())).collect();
    }
    fn config(&self, project: &str) -> Result<ProjectConfig> {
        self.configs
            .iter()
            .find(|c| c.project == project)
            .cloned()
            .ok_or_else(|| anyhow!("no project config named {project}"))
    }
    fn up_count(&self, project: &str) -> usize {
        self.state
            .runs
            .values()
            .filter(|r| r.spec.id.project == project && matches!(r.status, RunStatus::Running | RunStatus::Starting))
            .count()
    }
    /// Exact `project/run`, or a run name that is unique across projects.
    fn resolve_key(&self, wanted: &str) -> Result<String> {
        if self.state.runs.contains_key(wanted) {
            return Ok(wanted.to_string());
        }
        let hits: Vec<&String> = self.state.runs.iter().filter(|(_, r)| r.spec.id.run == wanted).map(|(k, _)| k).collect();
        match hits.as_slice() {
            [one] => Ok((*one).clone()),
            [] => bail!("no run named {wanted}; see `setu-rs ls`"),
            _ => bail!("{wanted} matches several projects; use project/run"),
        }
    }
}


/// Build the RunSpec fresh, so env and config edits apply on every start.
fn build_spec(cfg: &ProjectConfig, worktree: &Path, run: &str, leases: &mut BTreeMap<String, BTreeMap<String, u16>>) -> Result<RunSpec> {
    let id = RunId { project: cfg.project.clone(), run: run.to_string() };
    let k = key(&id);
    let lease = ports::lease(leases, &k, &cfg.ports, ports::port_free)?;
    leases.insert(k, lease.clone());
    // Layers: global < project config [env] < project layer < worktree layer < computed.
    let mut layered = cfg.clone();
    for (name, value) in env::layer_map(&env::Scope::Project(cfg.project.clone()))? {
        layered.env.insert(name, value);
    }
    let global = env::layer_map(&env::Scope::Global)?;
    let worktree_env = env::layer_map(&env::Scope::Worktree(id.clone()))?;
    config::resolve_run(&layered, worktree, run, &lease, &global, &worktree_env)
}

impl Daemon {
    pub fn new(exits: ExitTx) -> Result<Arc<Self>> {
        let configs = config::load_all()?;
        let state = state::load(&paths::state_file()).context("state.json is unreadable; refusing to start")?;
        let mut inner = Inner { configs, state, hosts: HashMap::new(), version: 0 };
        inner.rebuild_hosts();
        Ok(Arc::new(Self {
            inner: Mutex::new(inner),
            written: Arc::new(Mutex::new(0)),
            activity: ActivityTracker::new(),
            exits,
        }))
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Inner> {
        self.inner.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// After a restart: keep runs whose processes are provably ours and alive; stop the rest.
    pub async fn adopt(self: &Arc<Self>) {
        let runs: Vec<(String, RunRecord)> = self.lock().state.runs.iter().map(|(k, r)| (k.clone(), r.clone())).collect();
        for (k, rec) in runs {
            if rec.procs.is_empty() {
                continue;
            }
            let all_alive = rec.procs.iter().all(supervisor::owned_and_alive);
            if all_alive && rec.status == RunStatus::Running {
                self.activity.touch(&rec.spec.id);
                continue;
            }
            let _ = supervisor::stop_procs(&rec.procs, STOP_GRACE).await;
            self.set(&k, |r| {
                r.status = RunStatus::Stopped;
                r.procs.clear();
                r.stopped_at = Some(crate::disk::now_secs());
                r.note = Some("stopped after a daemon restart".into());
            });
        }
    }

    fn set(&self, k: &str, f: impl FnOnce(&mut RunRecord)) {
        {
            let mut inner = self.lock();
            if let Some(r) = inner.state.runs.get_mut(k) {
                f(r);
            }
        }
        self.persist();
    }

    /// Snapshot under the lock, write (with fsync) on the blocking pool. Snapshots are
    /// versioned so a slow older write can never overwrite a newer one.
    fn persist(&self) {
        let (snap, ver) = {
            let mut inner = self.lock();
            inner.version += 1;
            (inner.state.clone(), inner.version)
        };
        let written = self.written.clone();
        let job = move || {
            let mut w = written.lock().unwrap_or_else(|e| e.into_inner());
            if ver > *w {
                match state::save(&snap, &paths::state_file()) {
                    Ok(()) => *w = ver,
                    Err(e) => eprintln!("setu: saving state failed: {e:#}"),
                }
            }
        };
        match tokio::runtime::Handle::try_current() {
            Ok(h) => {
                h.spawn_blocking(job);
            }
            Err(_) => job(),
        }
    }

    /// Register the run for a worktree path (if new) and start it.
    pub async fn up(self: &Arc<Self>, path: &Path) -> Result<Value> {
        // Config reads and `git worktree list` run on the blocking pool, never under the lock.
        let p = path.to_path_buf();
        let (cfg, worktree) = tokio::task::spawn_blocking(move || -> Result<(ProjectConfig, std::path::PathBuf)> {
            let configs = config::load_all()?;
            let (cfg, wt) = naming::find_worktree(&configs, &p)?
                .ok_or_else(|| anyhow!("{} is not inside a worktree of any configured project", p.display()))?;
            Ok((cfg.clone(), wt))
        })
        .await??;
        let run = naming::run_name(&naming::project_dir(&cfg.repo), &worktree);
        let k = {
            let mut inner = self.lock();
            if let Ok(fresh) = config::load_all() {
                inner.configs = fresh;
            }
            let cfg = &cfg;
            let mut leases = inner.state.leases.clone();
            let spec = build_spec(cfg, &worktree, &run, &mut leases)?;
            inner.state.leases = leases;
            let k = key(&spec.id);
            if let Some(other) = inner.hosts.get(&spec.host) {
                if other != &k {
                    bail!("host {} already belongs to run {other}", spec.host);
                }
            }
            if let Some(existing) = inner.state.runs.get(&k) {
                if existing.spec.worktree != worktree {
                    bail!(
                        "run name {k} already belongs to {}; rename one of the worktrees",
                        existing.spec.worktree.display()
                    );
                }
            }
            let rec = inner.state.runs.entry(k.clone()).or_insert_with(|| RunRecord {
                spec: spec.clone(),
                status: RunStatus::Stopped,
                pinned: false,
                procs: vec![],
                note: None,
                stopped_at: None,
                env_hash: None,
            });
            rec.spec = spec;
            inner.rebuild_hosts();
            drop(inner);
            self.persist();
            k
        };
        self.start(&k).await?;
        self.describe(&k)
    }

    /// Start a registered run: spawn every proc, then wait for the web port.
    pub async fn start(self: &Arc<Self>, k: &str) -> Result<()> {
        let spec = {
            let mut inner = self.lock();
            let rec = inner.state.runs.get(k).ok_or_else(|| anyhow!("unknown run {k}"))?.clone();
            match rec.status {
                RunStatus::Running | RunStatus::Starting => return Ok(()),
                RunStatus::Stopping => bail!("{k} is stopping; try again in a moment"),
                _ => {}
            }
            let cfg = inner.config(&rec.spec.id.project)?;
            if inner.up_count(&cfg.project) >= cfg.max_running {
                bail!("{} already has {} runs up (max_running); stop one first", cfg.project, cfg.max_running);
            }
            let mut leases = inner.state.leases.clone();
            let spec = build_spec(&cfg, &rec.spec.worktree, &rec.spec.id.run, &mut leases)?;
            inner.state.leases = leases;
            if let Some(r) = inner.state.runs.get_mut(k) {
                r.spec = spec.clone();
                r.env_hash = Some(env::env_hash(&spec.env));
                r.status = RunStatus::Starting;
                r.note = None;
                r.procs.clear();
            }
            inner.rebuild_hosts();
            drop(inner);
            self.persist();
            spec
        };
        for port in spec.ports.values() {
            if !ports::port_free(*port) {
                self.set(k, |r| {
                    r.status = RunStatus::Crashed;
                    r.note = Some(format!("port {port} is in use by another process"));
                });
                bail!("port {port} for {k} is in use by another process");
            }
        }
        self.activity.touch(&spec.id);
        for proc in &spec.procs {
            match supervisor::spawn_proc(&spec, proc, self.exits.clone()).await {
                Ok(rec) => self.set(k, |r| r.procs.push(rec)),
                Err(e) => {
                    let procs = self.lock().state.runs.get(k).map(|r| r.procs.clone()).unwrap_or_default();
                    let _ = supervisor::stop_procs(&procs, STOP_GRACE).await;
                    self.set(k, |r| {
                        r.status = RunStatus::Crashed;
                        r.procs.clear();
                        r.note = Some(format!("could not start {}: {e:#}", proc.name));
                    });
                    return Err(e);
                }
            }
        }
        let me = Arc::clone(self);
        let k2 = k.to_string();
        // This waiter belongs to this incarnation only; a stop or restart in between makes it a no-op.
        let generation: Vec<i32> = self.lock().state.runs.get(k).map(|r| r.procs.iter().map(|p| p.pid).collect()).unwrap_or_default();
        tokio::spawn(async move {
            let ready = match spec.web_port {
                Some(p) => supervisor::wait_port(p, START_TIMEOUT).await,
                None => true,
            };
            let current: Vec<i32> = me.lock().state.runs.get(&k2).map(|r| r.procs.iter().map(|p| p.pid).collect()).unwrap_or_default();
            if current != generation {
                return;
            }
            me.set(&k2, |r| {
                if r.status == RunStatus::Starting {
                    if ready {
                        r.status = RunStatus::Running;
                    } else {
                        r.note = Some("web port never opened; see `setu-rs logs`".into());
                    }
                }
            });
            if !ready {
                let _ = me.stop(&k2, RunStatus::Crashed).await;
            }
        });
        Ok(())
    }

    pub async fn stop(self: &Arc<Self>, k: &str, end: RunStatus) -> Result<()> {
        let procs = {
            let mut inner = self.lock();
            let r = inner.state.runs.get_mut(k).ok_or_else(|| anyhow!("unknown run {k}"))?;
            if r.status == RunStatus::Stopping {
                return Ok(());
            }
            r.status = RunStatus::Stopping;
            let procs = r.procs.clone();
            drop(inner);
            self.persist();
            procs
        };
        let result = supervisor::stop_procs(&procs, STOP_GRACE).await;
        let id = self.lock().state.runs.get(k).map(|r| r.spec.id.clone());
        self.set(k, |r| {
            r.status = end;
            r.procs.clear();
            r.stopped_at = Some(crate::disk::now_secs());
            if let Err(e) = &result {
                r.note = Some(format!("stop incomplete: {e:#}"));
            }
        });
        if let Some(id) = id {
            self.activity.forget(&id);
        }
        result
    }

    /// A proc exited on its own.
    pub async fn on_exit(self: &Arc<Self>, ev: ExitEvent) {
        let k = key(&ev.run);
        let (web, status) = {
            let inner = self.lock();
            let Some(r) = inner.state.runs.get(&k) else { return };
            if !r.procs.iter().any(|p| p.pid == ev.pid) {
                return; // an earlier incarnation
            }
            let cfg_web = inner.config(&r.spec.id.project).ok().and_then(|c| c.web_proc().map(|(n, _)| n.to_string()));
            (cfg_web, r.status)
        };
        if !matches!(status, RunStatus::Running | RunStatus::Starting) {
            return;
        }
        let note = format!("{} exited ({})", ev.proc, ev.code.map(|c| format!("code {c}")).unwrap_or_else(|| "signal".into()));
        if web.as_deref() == Some(ev.proc.as_str()) {
            let _ = self.stop(&k, RunStatus::Crashed).await;
            self.set(&k, |r| r.note = Some(note));
        } else {
            self.set(&k, |r| {
                r.procs.retain(|p| p.pid != ev.pid);
                r.note = Some(note);
            });
        }
    }

    /// Every SWEEP_EVERY: idle stop, crash detection for adopted procs, log rotation.
    pub async fn sweep(self: &Arc<Self>) {
        let runs: Vec<(String, RunRecord)> = self.lock().state.runs.iter().map(|(k, r)| (k.clone(), r.clone())).collect();
        for (k, r) in runs {
            for p in &r.spec.procs {
                let _ = supervisor::rotate_log(&p.log_path, LOG_MAX_BYTES);
            }
            if r.status != RunStatus::Running {
                continue;
            }
            // Track children that left their group, so stop can still reach them.
            let mut procs = r.procs.clone();
            procs.iter_mut().for_each(supervisor::refresh_escaped);
            if procs != r.procs {
                self.set(&k, |x| {
                    if x.procs.iter().map(|p| p.pid).eq(procs.iter().map(|p| p.pid)) {
                        x.procs = procs.clone();
                    }
                });
            }
            // Adopted runs have no exit watcher: a dead web proc means the run is down.
            let web_name = r.spec.procs.iter().find(|p| p.port.is_some() && p.port == r.spec.web_port).map(|p| p.name.clone());
            let web_dead = match &web_name {
                Some(n) => !r.procs.iter().any(|p| &p.name == n && supervisor::owned_and_alive(p)),
                None => !r.procs.iter().any(supervisor::owned_and_alive),
            };
            if web_dead {
                let _ = self.stop(&k, RunStatus::Crashed).await;
                self.set(&k, |x| x.note = Some("the web process is gone".into()));
                continue;
            }
            if r.pinned {
                continue;
            }
            if self.activity.claim_idle_stop(&r.spec.id, r.spec.idle) {
                let _ = self.stop(&k, RunStatus::Stopped).await;
                self.set(&k, |x| x.note = Some("stopped after idle".into()));
                self.activity.release_idle_stop(&r.spec.id);
            }
        }
    }

    pub fn describe(&self, k: &str) -> Result<Value> {
        let inner = self.lock();
        let r = inner.state.runs.get(k).ok_or_else(|| anyhow!("unknown run {k}"))?;
        Ok(run_json(k, r))
    }

    pub fn list(&self) -> Value {
        let inner = self.lock();
        let mut leases = inner.state.leases.clone();
        Value::Array(
            inner
                .state
                .runs
                .iter()
                .map(|(k, r)| {
                    // A running run whose env would differ if started now needs a restart.
                    let stale = matches!(r.status, RunStatus::Running | RunStatus::Starting)
                        && r.env_hash.is_some()
                        && inner
                            .config(&r.spec.id.project)
                            .and_then(|cfg| build_spec(&cfg, &r.spec.worktree, &r.spec.id.run, &mut leases))
                            .is_ok_and(|spec| Some(env::env_hash(&spec.env)) != r.env_hash);
                    let mut v = run_json(k, r);
                    v["stale_env"] = json!(stale);
                    v
                })
                .collect(),
        )
    }

    pub fn pin(&self, wanted: &str, on: bool) -> Result<Value> {
        let k = self.lock().resolve_key(wanted)?;
        self.set(&k, |r| r.pinned = on);
        self.describe(&k)
    }

    pub fn resolve(&self, wanted: &str) -> Result<String> {
        self.lock().resolve_key(wanted)
    }

    pub fn run_for_path(&self, path: &Path) -> Result<String> {
        let configs = self.lock().configs.clone();
        let (cfg, worktree) = naming::find_worktree(&configs, path)?
            .ok_or_else(|| anyhow!("{} is not inside a configured worktree", path.display()))?;
        let run = naming::run_name(&naming::project_dir(&cfg.repo), &worktree);
        Ok(format!("{}/{run}", cfg.project))
    }

    /// Parse `scope` + `target` from a request into an env scope.
    pub fn env_scope(&self, scope: &str, target: Option<&str>) -> Result<env::Scope> {
        match scope {
            "global" => Ok(env::Scope::Global),
            "project" => {
                let p = target.ok_or_else(|| anyhow!("project scope needs a project name"))?;
                self.lock().config(p)?;
                Ok(env::Scope::Project(p.to_string()))
            }
            "worktree" => {
                let k = self.resolve(target.ok_or_else(|| anyhow!("worktree scope needs a run"))?)?;
                Ok(env::Scope::Worktree(self.lock().state.runs[&k].spec.id.clone()))
            }
            _ => bail!("scope must be global, project or worktree"),
        }
    }

    /// Names, secret flags and masked previews. Never values.
    pub fn env_list(&self, scope: &env::Scope) -> Result<Value> {
        let vars: Vec<Value> = env::read_layer(scope)?
            .into_iter()
            .map(|v| {
                let preview = if v.secret { env::mask(&v.value) } else { Some(v.value.clone()) };
                json!({ "name": v.name, "secret": v.secret, "preview": preview })
            })
            .collect();
        Ok(json!({ "scope": scope.label(), "vars": vars }))
    }

    /// Every name a run receives, with the layer it comes from. Secrets masked.
    pub fn env_effective(&self, wanted: &str) -> Result<Value> {
        let k = self.resolve(wanted)?;
        let (cfg, rec) = {
            let inner = self.lock();
            let rec = inner.state.runs.get(&k).cloned().ok_or_else(|| anyhow!("unknown run {k}"))?;
            (inner.config(&rec.spec.id.project)?, rec)
        };
        let mut leases = self.lock().state.leases.clone();
        let spec = build_spec(&cfg, &rec.spec.worktree, &rec.spec.id.run, &mut leases)?;
        let layers: Vec<(&str, BTreeMap<String, String>, std::collections::BTreeSet<String>)> = {
            let mut out = Vec::new();
            for (label, scope) in [
                ("global", env::Scope::Global),
                ("project", env::Scope::Project(cfg.project.clone())),
                ("worktree", env::Scope::Worktree(spec.id.clone())),
            ] {
                let vars = env::read_layer(&scope)?;
                let secrets = vars.iter().filter(|v| v.secret).map(|v| v.name.clone()).collect();
                out.push((label, vars.into_iter().map(|v| (v.name, v.value)).collect(), secrets));
            }
            out
        };
        const COMPUTED: &[&str] = &["PORT", "SETU_PROJECT", "SETU_RUN", "SETU_URL"];
        let vars: Vec<Value> = spec
            .env
            .iter()
            .map(|(name, value)| {
                let mut sources: Vec<&str> = Vec::new();
                if layers[0].1.contains_key(name) {
                    sources.push("global");
                }
                if cfg.env.contains_key(name) {
                    sources.push("project-config");
                }
                for (label, map, _) in &layers[1..] {
                    if map.contains_key(name) {
                        sources.push(label);
                    }
                }
                if COMPUTED.contains(&name.as_str()) {
                    sources.push("computed");
                }
                let source = sources.last().copied().unwrap_or("computed");
                let secret = layers.iter().any(|(_, _, s)| s.contains(name)) || env::is_secret_name(name);
                let preview = if secret { env::mask(value) } else { Some(value.clone()) };
                json!({ "name": name, "source": source, "overrides": &sources[..sources.len().saturating_sub(1)], "secret": secret, "preview": preview })
            })
            .collect();
        Ok(json!({ "run": k, "vars": vars }))
    }

    pub fn env_set(&self, actor: &str, scope: &env::Scope, name: &str, value: &str, secret: Option<bool>) -> Result<Value> {
        let stored_secret = env::write_var(scope, name, value, secret)?;
        env::audit(actor, "set", scope, Some(name), Some(json!({ "secret": stored_secret })));
        Ok(json!({ "name": name, "secret": stored_secret, "applies": "on the next start of each affected run" }))
    }

    pub fn env_unset(&self, actor: &str, scope: &env::Scope, name: &str) -> Result<Value> {
        let existed = env::unset_var(scope, name)?;
        env::audit(actor, "unset", scope, Some(name), None);
        Ok(json!({ "name": name, "existed": existed }))
    }

    /// Parse a dotenv file or text inside the daemon; replies carry names only.
    pub fn env_import(&self, actor: &str, scope: &env::Scope, path: Option<&str>, text: Option<&str>, preview: bool, overwrite: bool) -> Result<Value> {
        let body = match (path, text) {
            (Some(p), _) => std::fs::read_to_string(p).with_context(|| format!("reading {p}"))?,
            (None, Some(t)) => t.to_string(),
            (None, None) => bail!("import needs a path or text"),
        };
        let report = env::import(scope, &body, preview, overwrite)?;
        if !preview {
            env::audit(actor, "import", scope, None, Some(json!({ "names": report.imported })));
        }
        Ok(serde_json::to_value(report)?)
    }

    /// The only call that returns a value. Never allowed for MCP; always audited.
    pub fn env_reveal(&self, actor: &str, scope: &env::Scope, name: &str) -> Result<Value> {
        if actor == "mcp" {
            bail!("reveal is not available to agents; ask the user to run `setu-rs env reveal` themselves");
        }
        let value = env::get_value(scope, name)?.ok_or_else(|| anyhow!("{name} is not set in this layer"))?;
        env::audit(actor, "reveal", scope, Some(name), None);
        Ok(json!({ "name": name, "value": value }))
    }

    /// Every worktree of every configured project, with what Setu knows about it.
    fn snapshot(&self) -> (Vec<ProjectConfig>, BTreeMap<String, RunRecord>) {
        let inner = self.lock();
        (inner.configs.clone(), inner.state.runs.clone())
    }

    /// `disk.report`: declared items per worktree, stores health, volume free space.
    pub async fn disk_report(&self, measure_deps: bool) -> Result<Value> {
        let (configs, runs) = self.snapshot();
        tokio::task::spawn_blocking(move || {
            let policy = disk::Policy { measure: true, measure_deps, include_unmanaged: false };
            let now = disk::now_secs();
            let mut worktrees = Vec::new();
            let mut stores = Vec::new();
            let mut free = 0;
            for (cfg, wt) in all_worktrees(&configs, &runs) {
                free = disk::free_bytes(&wt.worktree);
                let items = disk::candidates(&cfg, &wt, policy, now);
                if items.is_empty() {
                    continue;
                }
                worktrees.push(json!({
                    "run": format!("{}/{}", wt.project, wt.run),
                    "worktree": wt.worktree,
                    "status": wt.status,
                    "stopped_at": wt.stopped_at,
                    "items": items,
                }));
            }
            for cfg in &configs {
                for st in &cfg.stores {
                    let size = disk_measure::measure(&st.path);
                    let low = st.warn_below.is_some_and(|w| size.logical < w);
                    stores.push(json!({ "project": cfg.project, "name": st.name, "path": st.path, "logical": size.logical, "low": low }));
                }
            }
            Ok(json!({ "free_bytes": free, "worktrees": worktrees, "stores": stores }))
        })
        .await?
    }

    /// `disk.clean`: delete eligible items (or list them when `apply` is false).
    pub async fn disk_clean(&self, apply: bool, include_unmanaged: bool) -> Result<Value> {
        let (configs, runs) = self.snapshot();
        tokio::task::spawn_blocking(move || {
            let policy = disk::Policy { measure: !apply, measure_deps: false, include_unmanaged };
            let now = disk::now_secs();
            let mut done = Vec::new();
            let mut freed_total: i64 = 0;
            for (cfg, wt) in all_worktrees(&configs, &runs) {
                // Deepest paths first, so a nested item (.next/dev/cache) goes before its parent (.next/dev).
                let mut eligible: Vec<_> = disk::candidates(&cfg, &wt, policy, now).into_iter().filter(|c| c.eligible).collect();
                eligible.sort_by_key(|c| std::cmp::Reverse(c.path.components().count()));
                for c in eligible {
                    if !apply {
                        done.push(json!({ "run": c.run, "path": c.path, "item": c.item, "size": c.size, "reason": c.reason }));
                        continue;
                    }
                    match disk::clean_one(&cfg, &wt, &c.path, policy) {
                        Ok(freed) => {
                            freed_total += freed;
                            done.push(json!({ "run": c.run, "path": c.path, "item": c.item, "freed_bytes": freed }));
                        }
                        Err(e) => done.push(json!({ "run": c.run, "path": c.path, "item": c.item, "error": format!("{e:#}") })),
                    }
                }
            }
            Ok(json!({ "applied": apply, "items": done, "freed_bytes": freed_total }))
        })
        .await?
    }

    pub fn running_keys(&self) -> Vec<String> {
        self.lock()
            .state
            .runs
            .iter()
            .filter(|(_, r)| !r.procs.is_empty())
            .map(|(k, _)| k.clone())
            .collect()
    }
}

/// Every worktree of every project, paired with Setu's record of it (blocking: runs git).
fn all_worktrees(configs: &[ProjectConfig], runs: &BTreeMap<String, RunRecord>) -> Vec<(ProjectConfig, disk::WorktreeInfo)> {
    let mut out = Vec::new();
    for cfg in configs {
        let pdir = naming::project_dir(&cfg.repo);
        for wt in naming::list_worktrees(&cfg.repo).unwrap_or_default() {
            let run = naming::run_name(&pdir, &wt);
            let rec = runs.get(&format!("{}/{run}", cfg.project));
            out.push((
                cfg.clone(),
                disk::WorktreeInfo {
                    project: cfg.project.clone(),
                    run,
                    worktree: wt,
                    status: rec.map(|r| r.status),
                    stopped_at: rec.and_then(|r| r.stopped_at),
                },
            ));
        }
    }
    out
}

fn run_json(k: &str, r: &RunRecord) -> Value {
    let ram = if r.procs.is_empty() { 0 } else { supervisor::run_footprint(&r.procs) };
    json!({
        "run": k,
        "url": r.spec.url,
        "status": r.status,
        "pinned": r.pinned,
        "ram_bytes": ram,
        "ports": r.spec.ports,
        "worktree": r.spec.worktree,
        "procs": r.procs.iter().map(|p| json!({"name": p.name, "pid": p.pid})).collect::<Vec<_>>(),
        "note": r.note,
    })
}

impl Routes for Daemon {
    fn lookup(&self, host: &str) -> Lookup {
        let inner = self.lock();
        let Some(k) = inner.hosts.get(host) else { return Lookup::Unknown };
        let Some(r) = inner.state.runs.get(k) else { return Lookup::Unknown };
        let run = r.spec.id.clone();
        match (r.status, r.spec.web_port) {
            (RunStatus::Running, Some(port)) => Lookup::Up { run, port },
            (RunStatus::Starting, _) | (RunStatus::Stopping, _) => Lookup::Starting { run },
            _ => Lookup::Down { run },
        }
    }

    fn request_start(&self, run: &RunId) -> std::result::Result<(), String> {
        // Needs an Arc to spawn; the daemon registers itself in `handle()` at startup.
        let me = SELF.get().cloned().ok_or("daemon not ready")?;
        let k = key(run);
        {
            let inner = self.lock();
            let r = inner.state.runs.get(&k).ok_or("unknown run")?;
            if !matches!(r.status, RunStatus::Running | RunStatus::Starting) {
                let cfg = inner.config(&run.project).map_err(|e| e.to_string())?;
                if inner.up_count(&run.project) >= cfg.max_running {
                    return Err(format!(
                        "{} already has {} runs up. Stop one with `setu-rs down <run>` first.",
                        run.project, cfg.max_running
                    ));
                }
            }
        }
        tokio::spawn(async move {
            if let Err(e) = me.start(&k).await {
                eprintln!("setu: on-demand start of {k} failed: {e:#}");
            }
        });
        Ok(())
    }
}

static SELF: std::sync::OnceLock<Arc<Daemon>> = std::sync::OnceLock::new();

/// flock(2) on state_dir/daemon.lock; released by the kernel when the daemon exits.
fn single_instance_lock() -> Result<std::fs::File> {
    use std::os::unix::io::AsRawFd;
    let dir = paths::state_dir();
    std::fs::create_dir_all(&dir)?;
    let f = std::fs::OpenOptions::new().create(true).truncate(false).write(true).open(dir.join("daemon.lock"))?;
    // SAFETY: flock on a valid fd we own.
    if unsafe { libc::flock(f.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } != 0 {
        bail!("another setu-rs daemon is already running");
    }
    Ok(f)
}

/// Run the daemon until SIGINT/SIGTERM. Stops every run it started on the way out.
pub async fn run() -> Result<()> {
    // One daemon only: hold an exclusive lock for our lifetime, before touching state.
    let _lock = single_instance_lock()?;
    let listener = tokio::net::TcpListener::bind(("127.0.0.1", PROXY_PORT))
        .await
        .with_context(|| format!("binding the proxy on 127.0.0.1:{PROXY_PORT}"))?;
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<ExitEvent>();
    let daemon = Daemon::new(tx)?;
    let _ = SELF.set(Arc::clone(&daemon));
    daemon.adopt().await;
    let routes: Arc<dyn Routes> = daemon.clone();
    let activity = daemon.activity.clone();
    tokio::spawn(async move {
        if let Err(e) = crate::proxy::serve(listener, routes, activity).await {
            eprintln!("setu: proxy stopped: {e:#}");
        }
    });
    let api_daemon = daemon.clone();
    tokio::spawn(async move {
        if let Err(e) = crate::api::serve(api_daemon).await {
            eprintln!("setu: api stopped: {e:#}");
        }
    });
    let exit_daemon = daemon.clone();
    tokio::spawn(async move {
        while let Some(ev) = rx.recv().await {
            exit_daemon.on_exit(ev).await;
        }
    });
    eprintln!("setu-rs daemon: proxy on http://127.0.0.1:{PROXY_PORT}, socket {}", paths::socket_path().display());

    let mut term = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())?;
    let mut tick = tokio::time::interval(SWEEP_EVERY);
    // Hourly: clean regenerable items of stopped, Setu-managed runs past their policy.
    let mut disk_tick = tokio::time::interval(Duration::from_secs(3600));
    loop {
        tokio::select! {
            _ = tick.tick() => daemon.sweep().await,
            _ = disk_tick.tick() => {
                match daemon.disk_clean(true, false).await {
                    Ok(v) if v["items"].as_array().is_some_and(|a| !a.is_empty()) => eprintln!("setu: auto disk clean: {v}"),
                    Err(e) => eprintln!("setu: auto disk clean failed: {e:#}"),
                    _ => {}
                }
            }
            _ = tokio::signal::ctrl_c() => break,
            _ = term.recv() => break,
        }
    }
    eprintln!("setu-rs daemon: stopping runs");
    for k in daemon.running_keys() {
        let _ = daemon.stop(&k, RunStatus::Stopped).await;
    }
    let _ = std::fs::remove_file(paths::socket_path());
    Ok(())
}
