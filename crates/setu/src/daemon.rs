//! The daemon: owns state, starts and stops runs, answers the proxy and the socket API.

use crate::activity::ActivityTracker;
use crate::autoremove;
use crate::globalcfg;
use crate::claims;
use crate::config;
use crate::worktree;
use crate::model::{Lookup, ProjectConfig, RunId, RunRecord, RunSpec, RunStatus, Routes};
use crate::disk;
use crate::env;
use crate::disk_measure;
use crate::naming;
use crate::paths;
use crate::ports;
use crate::db::{self, Db};
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
const MAX_LOG_LINES: usize = 500;
/// Only this much of a log file's end is read for `logs`.
const LOG_TAIL_BYTES: u64 = 512 * 1024;
/// Values only *guessed* to be secret (by name) and shorter than this are not redacted (they would mangle ordinary text).
const MIN_REDACT_LEN: usize = 6;

pub struct Daemon {
    inner: Mutex<Inner>,
    /// The one database; used only from blocking threads.
    db: Arc<Db>,
    /// Highest state version written to disk; older snapshots are skipped.
    written: Arc<Mutex<u64>>,
    pub activity: Arc<ActivityTracker>,
    exits: ExitTx,
    /// One auto-remove evaluation at a time (hourly tick vs `setu-rs autoremove`).
    ar_lock: Mutex<()>,
    /// One start or stop of a run at a time (review #7).
    life: Mutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>>,
    /// Test hook: make `persist_durable` fail.
    #[cfg(test)]
    fail_persist: std::sync::atomic::AtomicBool,
    /// Test hook: runs after `disk_clean` took its snapshot, before it deletes.
    #[cfg(test)]
    clean_hook: Mutex<Option<Box<dyn Fn() + Send>>>,
}

struct Inner {
    configs: Vec<ProjectConfig>,
    state: State,
    /// host -> run key
    hosts: HashMap<String, String>,
    version: u64,
    /// Bumped by every stop of a run; a start that sees it change was cancelled.
    gens: HashMap<String, u64>,
}

/// After a stop attempt: the records whose processes are still alive when the stop failed.
/// A successful stop leaves nothing; a failed one never forgets a live process.
fn retained_after_stop(procs: &[crate::model::ProcRecord], stop_failed: bool, unresolved: &dyn Fn(&crate::model::ProcRecord) -> bool) -> Vec<crate::model::ProcRecord> {
    if !stop_failed {
        return Vec::new();
    }
    procs.iter().filter(|p| unresolved(p)).cloned().collect()
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


/// The env layers a run's spec is built from, read from disk (blocking; never call under the state lock).
struct Layers {
    global: BTreeMap<String, String>,
    project: Vec<env::Var>,
    worktree: Vec<env::Var>,
}

fn read_layers(project: &str, id: &RunId) -> Result<Layers> {
    Ok(Layers {
        global: env::layer_map(&env::Scope::Global)?,
        project: env::read_layer(&env::Scope::Project(project.to_string()))?,
        worktree: env::read_layer(&env::Scope::Worktree(id.clone()))?,
    })
}

/// Build the RunSpec fresh, so env and config edits apply on every start.
fn build_spec(cfg: &ProjectConfig, worktree: &Path, run: &str, leases: &mut BTreeMap<String, BTreeMap<String, u16>>) -> Result<RunSpec> {
    let id = RunId { project: cfg.project.clone(), run: run.to_string() };
    let layers = read_layers(&cfg.project, &id)?;
    build_spec_with(cfg, worktree, run, leases, &layers)
}

fn build_spec_with(cfg: &ProjectConfig, worktree: &Path, run: &str, leases: &mut BTreeMap<String, BTreeMap<String, u16>>, layers: &Layers) -> Result<RunSpec> {
    let id = RunId { project: cfg.project.clone(), run: run.to_string() };
    let k = key(&id);
    let lease = ports::lease(leases, &k, &cfg.ports, ports::port_free)?;
    leases.insert(k, lease.clone());
    // Layers: global < project config [env] < project layer < worktree layer < computed.
    // Plain layer values may use {templates}; secret values are literal data and are never
    // rendered, so braces in a secret survive and cannot leak through a template error (review #10).
    let mut layered = cfg.clone();
    for v in layers.project.iter().filter(|v| !v.secret) {
        layered.env.insert(v.name.clone(), v.value.clone());
    }
    let worktree_plain: BTreeMap<String, String> = layers.worktree.iter().filter(|v| !v.secret).map(|v| (v.name.clone(), v.value.clone())).collect();
    let mut spec = config::resolve_run(&layered, worktree, run, &lease, &layers.global, &worktree_plain)?;
    let web = spec.web_port;
    let is_computed = |name: &str| matches!(name, "SETU_PROJECT" | "SETU_RUN" | "SETU_URL") || (name == "PORT" && web.is_some());
    for v in layers.project.iter().filter(|v| v.secret) {
        if !layers.worktree.iter().any(|w| w.name == v.name) && !is_computed(&v.name) {
            spec.env.insert(v.name.clone(), v.value.clone());
        }
    }
    for v in layers.worktree.iter().filter(|v| v.secret) {
        if !is_computed(&v.name) {
            spec.env.insert(v.name.clone(), v.value.clone());
        }
    }
    Ok(spec)
}

impl Daemon {
    pub fn new(exits: ExitTx) -> Result<Arc<Self>> {
        let configs = config::load_all()?;
        let db = db::global().context("the state database could not be opened or imported; refusing to start")?;
        let state = state::load(&db).context("the state database is unreadable; refusing to start")?;
        Ok(Self::with_parts(configs, state, db, exits))
    }

    fn with_parts(configs: Vec<ProjectConfig>, state: State, db: Arc<Db>, exits: ExitTx) -> Arc<Self> {
        let mut inner = Inner { configs, state, hosts: HashMap::new(), version: 0, gens: HashMap::new() };
        inner.rebuild_hosts();
        Arc::new(Self {
            inner: Mutex::new(inner),
            db,
            written: Arc::new(Mutex::new(0)),
            activity: ActivityTracker::new(),
            exits,
            ar_lock: Mutex::new(()),
            life: Mutex::new(HashMap::new()),
            #[cfg(test)]
            fail_persist: std::sync::atomic::AtomicBool::new(false),
            #[cfg(test)]
            clean_hook: Mutex::new(None),
        })
    }

    fn life_lock(&self, k: &str) -> Arc<tokio::sync::Mutex<()>> {
        self.life.lock().unwrap_or_else(|e| e.into_inner()).entry(k.to_string()).or_default().clone()
    }

    fn generation(&self, k: &str) -> u64 {
        self.lock().gens.get(k).copied().unwrap_or(0)
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
            let res = supervisor::stop_procs(&rec.procs, STOP_GRACE).await;
            // Processes that could not be stopped stay recorded, so a later stop can retry (review #9).
            let left = retained_after_stop(&rec.procs, res.is_err(), &supervisor::unresolved);
            self.set(&k, |r| {
                r.status = if left.is_empty() { RunStatus::Stopped } else { RunStatus::Crashed };
                r.procs = left.clone();
                if left.is_empty() {
                    r.stopped_at = Some(crate::disk::now_secs());
                    r.note = Some("stopped after a daemon restart".into());
                } else {
                    r.note = Some("some processes survived the stop after a daemon restart; stop the run again".into());
                }
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

    /// Snapshot under the lock, write on the blocking pool in one transaction. Snapshots are
    /// versioned so a slow older write can never overwrite a newer one.
    fn persist(&self) {
        let (snap, ver) = self.snapshot_state();
        let (written, db) = (self.written.clone(), self.db.clone());
        let job = move || {
            if let Err(e) = write_snapshot(&db, &written, &snap, ver, &mut |_| Ok(())) {
                eprintln!("setu: saving state failed: {e:#}");
            }
        };
        match tokio::runtime::Handle::try_current() {
            Ok(h) => {
                h.spawn_blocking(job);
            }
            Err(_) => job(),
        }
    }

    /// Like `persist`, but awaited: a failure is returned, so a lifecycle step is only reported
    /// done once its ownership records are on disk (review #15).
    async fn persist_durable(self: &Arc<Self>) -> Result<()> {
        #[cfg(test)]
        if self.fail_persist.load(std::sync::atomic::Ordering::SeqCst) {
            bail!("injected persistence failure");
        }
        let (snap, ver) = self.snapshot_state();
        let (written, db) = (self.written.clone(), self.db.clone());
        tokio::task::spawn_blocking(move || write_snapshot(&db, &written, &snap, ver, &mut |_| Ok(()))).await?
    }

    fn snapshot_state(&self) -> (State, u64) {
        let mut inner = self.lock();
        inner.version += 1;
        (inner.state.clone(), inner.version)
    }

    /// Register (or refresh) the run record for a worktree and return its key and spec.
    /// Shared by `up`, `worktree.new`, `worktree.adopt` and `worktree.restore`.
    fn register(&self, cfg: &ProjectConfig, worktree: &Path, run: &str) -> Result<(String, RunSpec)> {
        // Disk and git work happens before the state lock is taken (review #18).
        let fresh = config::load_all().ok();
        let id = RunId { project: cfg.project.clone(), run: run.to_string() };
        let layers = read_layers(&cfg.project, &id)?;
        let mut inner = self.lock();
        if let Some(fresh) = fresh {
            domains_refresh(&fresh);
            inner.configs = fresh;
        }
        let mut leases = inner.state.leases.clone();
        let spec = build_spec_with(cfg, worktree, run, &mut leases, &layers)?;
        inner.state.leases = leases;
        let k = key(&spec.id);
        if let Some(other) = inner.hosts.get(&spec.host) {
            if other != &k {
                bail!("host {} already belongs to run {other}", spec.host);
            }
        }
        if let Some(existing) = inner.state.runs.get(&k) {
            if existing.spec.worktree != worktree {
                bail!("run name {k} already belongs to {}; rename one of the worktrees", existing.spec.worktree.display());
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
            last_started_at: None,
            last_request_at: None,
        });
        rec.spec = spec.clone();
        inner.rebuild_hosts();
        drop(inner);
        self.persist();
        Ok((k, spec))
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
        let me = Arc::clone(self);
        let (c2, w2, r2) = (cfg.clone(), worktree.clone(), run.clone());
        let (k, _) = tokio::task::spawn_blocking(move || me.register(&c2, &w2, &r2)).await??;
        self.start(&k).await?;
        self.describe_async(&k).await
    }

    /// Start a registered run: spawn every proc, then wait for the web port.
    /// Start and stop of one run never overlap: a stop that arrives mid-start cancels it, and
    /// any process spawned after that is stopped before start lets go (review #7).
    pub async fn start(self: &Arc<Self>, k: &str) -> Result<()> {
        let (db, key) = (self.db.clone(), k.to_string());
        if tokio::task::spawn_blocking(move || worktree::pending_removal(&db, &key)).await? {
            bail!("a removal of {k} is pending; retry `setu-rs rm {k}` to finish it");
        }
        let life = self.life_lock(k);
        let _life = life.lock().await;
        let id = self.lock().state.runs.get(k).ok_or_else(|| anyhow!("unknown run {k}"))?.spec.id.clone();
        // The layer files are read off the runtime thread and outside the state lock (review #18).
        let layers = tokio::task::spawn_blocking(move || read_layers(&id.project.clone(), &id)).await??;
        let (spec, gen) = {
            let mut inner = self.lock();
            let rec = inner.state.runs.get(k).ok_or_else(|| anyhow!("unknown run {k}"))?.clone();
            match rec.status {
                RunStatus::Running | RunStatus::Starting => return Ok(()),
                RunStatus::Stopping => bail!("{k} is stopping; try again in a moment"),
                _ => {}
            }
            if let Some(p) = rec.procs.iter().find(|p| supervisor::unresolved(p)) {
                bail!("{k} still has a process from an earlier run that could not be stopped (pid {}); run `setu-rs down {k}` again, or end it by hand", p.pid);
            }
            let cfg = inner.config(&rec.spec.id.project)?;
            if inner.up_count(&cfg.project) >= cfg.max_running {
                bail!("{} already has {} runs up (max_running); stop one first", cfg.project, cfg.max_running);
            }
            let mut leases = inner.state.leases.clone();
            let spec = build_spec_with(&cfg, &rec.spec.worktree, &rec.spec.id.run, &mut leases, &layers)?;
            inner.state.leases = leases;
            let gen = inner.gens.get(k).copied().unwrap_or(0);
            if let Some(r) = inner.state.runs.get_mut(k) {
                r.spec = spec.clone();
                r.env_hash = Some(env::env_hash(&spec.env));
                r.status = RunStatus::Starting;
                r.last_started_at = Some(crate::disk::now_secs());
                r.note = None;
                r.procs.clear();
            }
            inner.rebuild_hosts();
            drop(inner);
            self.persist();
            (spec, gen)
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
            if self.generation(k) != gen {
                return self.cancel_start(k).await;
            }
            match supervisor::spawn_proc(&spec, proc, self.exits.clone()).await {
                Ok(rec) => {
                    let pushed = {
                        let mut inner = self.lock();
                        if inner.gens.get(k).copied().unwrap_or(0) != gen {
                            false
                        } else {
                            if let Some(r) = inner.state.runs.get_mut(k) {
                                r.procs.push(rec.clone());
                            }
                            true
                        }
                    };
                    if !pushed {
                        let _ = supervisor::stop_procs(std::slice::from_ref(&rec), STOP_GRACE).await;
                        return self.cancel_start(k).await;
                    }
                    // The new process is only reported started once its ownership record is saved.
                    if let Err(e) = self.persist_durable().await {
                        let procs = self.lock().state.runs.get(k).map(|r| r.procs.clone()).unwrap_or_default();
                        let _ = supervisor::stop_procs(&procs, STOP_GRACE).await;
                        self.set(k, |r| {
                            r.status = RunStatus::Crashed;
                            r.procs.clear();
                            r.note = Some(format!("could not save the process record for {}: {e:#}", proc.name));
                        });
                        return Err(e.context(format!("could not save the process record for {}; its processes were stopped", proc.name)));
                    }
                }
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

    /// A stop arrived while start was spawning: stop what this start created and give way.
    async fn cancel_start(self: &Arc<Self>, k: &str) -> Result<()> {
        let procs = self.lock().state.runs.get(k).map(|r| r.procs.clone()).unwrap_or_default();
        let res = supervisor::stop_procs(&procs, STOP_GRACE).await;
        let left = retained_after_stop(&procs, res.is_err(), &supervisor::unresolved);
        self.set(k, |r| {
            r.status = RunStatus::Stopped;
            r.procs = left.clone();
            r.note = Some("start was cancelled by a stop".into());
        });
        bail!("the start of {k} was cancelled by a stop")
    }

    pub async fn stop(self: &Arc<Self>, k: &str, end: RunStatus) -> Result<()> {
        {
            let mut inner = self.lock();
            if !inner.state.runs.contains_key(k) {
                bail!("unknown run {k}");
            }
            // Tells an in-flight start to give way, then wait for it to finish.
            *inner.gens.entry(k.to_string()).or_default() += 1;
        }
        let life = self.life_lock(k);
        let _life = life.lock().await;
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
        // The tracker is forgotten below; keep its last request time (auto-removal's idle age).
        let last_req = id.as_ref().and_then(|id| self.activity.last_request_unix(id));
        // A failed stop keeps ownership of whatever is still alive and does not claim "stopped" (review #9).
        let left = retained_after_stop(&procs, result.is_err(), &supervisor::unresolved);
        self.set(k, |r| {
            r.procs = left.clone();
            if left.is_empty() {
                r.status = end;
                r.stopped_at = Some(crate::disk::now_secs());
            } else {
                r.status = RunStatus::Crashed;
            }
            if let Some(t) = last_req {
                r.last_request_at = Some(r.last_request_at.map_or(t, |p| p.max(t)));
            }
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
            // A sidecar's leader is gone, but its group or escaped children may live on: the record
            // stays until they are gone too, so Stop, restart and adoption can still reach them (review #8).
            self.set(&k, |r| {
                r.procs.retain(|p| p.pid != ev.pid || supervisor::unresolved(p));
                r.note = Some(note);
            });
        }
    }

    /// Copy each run's last proxied-request time from the in-memory tracker into its record,
    /// at most once a minute per run (the record is persisted on every change).
    fn record_request_times(&self) {
        let updates: Vec<(String, u64)> = {
            let inner = self.lock();
            inner
                .state
                .runs
                .iter()
                .filter_map(|(k, r)| {
                    let t = self.activity.last_request_unix(&r.spec.id)?;
                    let due = r.last_request_at.is_none_or(|p| t >= p + 60);
                    due.then(|| (k.clone(), t))
                })
                .collect()
        };
        for (k, t) in updates {
            self.set(&k, |r| r.last_request_at = Some(t));
        }
    }

    /// Every SWEEP_EVERY: idle stop, crash detection for adopted procs, log rotation.
    pub async fn sweep(self: &Arc<Self>) {
        self.record_request_times();
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
        Ok(run_json(&self.db, k, r))
    }

    /// `describe` on the blocking pool (it reads the claim from the database).
    pub async fn describe_async(self: &Arc<Self>, k: &str) -> Result<Value> {
        let (me, k) = (Arc::clone(self), k.to_string());
        tokio::task::spawn_blocking(move || me.describe(&k)).await?
    }

    pub fn list(&self) -> Value {
        let gcfg = globalcfg::GlobalConfig::load().ok();
        let auto = autoremove::load_state(&self.db).ok();
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
                    let mut v = run_json(&self.db, k, r);
                    v["stale_env"] = json!(stale);
                    v["removal"] = match (&gcfg, &auto) {
                        (Some(g), Some(a)) => autoremove::removal_json(a, k, &g.auto_remove, r.pinned),
                        _ => Value::Null,
                    };
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

    pub fn env_set(&self, actor: &str, client: Option<&str>, scope: &env::Scope, name: &str, value: &str, secret: Option<bool>) -> Result<Value> {
        let stored_secret = env::write_var(scope, name, value, secret)?;
        env::audit(actor, "set", scope, Some(name), Some(with_client(json!({ "secret": stored_secret }), client)));
        Ok(json!({ "name": name, "secret": stored_secret, "applies": "on the next start of each affected run" }))
    }

    pub fn env_unset(&self, actor: &str, client: Option<&str>, scope: &env::Scope, name: &str) -> Result<Value> {
        let existed = env::unset_var(scope, name)?;
        env::audit(actor, "unset", scope, Some(name), Some(with_client(json!({}), client)));
        Ok(json!({ "name": name, "existed": existed }))
    }

    /// Parse a dotenv file or text inside the daemon; replies carry names only.
    pub fn env_import(&self, actor: &str, client: Option<&str>, scope: &env::Scope, path: Option<&str>, text: Option<&str>, preview: bool, overwrite: bool) -> Result<Value> {
        let body = match (path, text) {
            (Some(p), _) => std::fs::read_to_string(p).with_context(|| format!("reading {p}"))?,
            (None, Some(t)) => t.to_string(),
            (None, None) => bail!("import needs a path or text"),
        };
        let report = env::import(scope, &body, preview, overwrite)?;
        if !preview {
            env::audit(actor, "import", scope, None, Some(with_client(json!({ "names": report.imported }), client)));
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

    /// Last `lines` lines of a run's proc logs with every current secret value redacted.
    /// Several procs are prefixed with `[proc] `.
    pub fn logs(&self, wanted: &str, proc: Option<&str>, lines: usize) -> Result<Value> {
        let k = self.resolve(wanted)?;
        if !self.lock().state.runs.contains_key(&k) {
            bail!("unknown run {k}");
        }
        let lines = lines.clamp(1, MAX_LOG_LINES);
        let dir = paths::logs_dir().join(&k);
        let mut names: Vec<String> = match proc {
            Some(p) => {
                if p.is_empty() || !p.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.')) || p.starts_with('.') {
                    bail!("bad proc name");
                }
                vec![p.to_string()]
            }
            None => std::fs::read_dir(&dir)
                .map(|rd| {
                    rd.filter_map(|e| e.ok())
                        .filter_map(|e| e.file_name().to_str().and_then(|n| n.strip_suffix(".log")).map(String::from))
                        .collect()
                })
                .unwrap_or_default(),
        };
        names.sort();
        if names.is_empty() {
            bail!("no logs yet for {k}");
        }
        let multi = proc.is_none() && names.len() > 1;
        let mut out = Vec::new();
        for name in &names {
            let text = tail_lines(&dir.join(format!("{name}.log")), lines).with_context(|| format!("no log for proc {name}"))?;
            for l in text {
                out.push(if multi { format!("[{name}] {l}") } else { l });
            }
        }
        let secrets = self.redaction_set(&k)?;
        let text = redact(&out.join("\n"), &secrets);
        Ok(json!({ "run": k, "lines": text.lines().count(), "text": text }))
    }

    /// Every secret value that must never leave in a log: values flagged secret in any layer,
    /// the effective env values whose name looks secret (config `[env]` included), and values
    /// that were secret before (rotated or removed). Anything unreadable fails the call: log
    /// delivery never fails open (review #11).
    fn redaction_set(&self, k: &str) -> Result<Vec<(String, String)>> {
        let (cfg, rec) = {
            let inner = self.lock();
            let rec = inner.state.runs.get(k).cloned().ok_or_else(|| anyhow!("unknown run {k}"))?;
            (inner.config(&rec.spec.id.project)?, rec)
        };
        let id = rec.spec.id.clone();
        let layers = read_layers(&cfg.project, &id).context("the env layers could not be read, so logs cannot be redacted safely")?;
        let mut leases = self.lock().state.leases.clone();
        let spec = build_spec_with(&cfg, &rec.spec.worktree, &id.run, &mut leases, &layers)?;
        let mut out: Vec<(String, String)> = Vec::new();
        let mut flagged: std::collections::BTreeSet<String> = Default::default();
        for v in layers.project.iter().chain(layers.worktree.iter()).filter(|v| v.secret) {
            flagged.insert(v.name.clone());
            out.push((v.name.clone(), v.value.clone()));
        }
        for scope in [env::Scope::Global] {
            for v in env::read_layer(&scope).context("the global env layer could not be read, so logs cannot be redacted safely")?.into_iter().filter(|v| v.secret) {
                flagged.insert(v.name.clone());
                out.push((v.name, v.value));
            }
        }
        for (name, value) in &spec.env {
            // Name-based guesses keep the length floor (they would otherwise mangle ordinary text).
            if flagged.contains(name) || (env::is_secret_name(name) && value.len() >= MIN_REDACT_LEN) {
                out.push((name.clone(), value.clone()));
            }
        }
        out.extend(env::redaction_history().context("the redaction history could not be read, so logs cannot be redacted safely")?);
        Ok(out)
    }

    /// Every worktree of every configured project, with what Setu knows about it.
    fn snapshot(&self) -> (Vec<ProjectConfig>, BTreeMap<String, RunRecord>) {
        let inner = self.lock();
        (inner.configs.clone(), inner.state.runs.clone())
    }

    /// `disk.report`: declared items per worktree, stores health, volume free space.
    pub async fn disk_report(&self, measure_deps: bool) -> Result<Value> {
        let (configs, runs) = self.snapshot();
        let db = self.db.clone();
        tokio::task::spawn_blocking(move || {
            let policy = disk::Policy { measure: true, measure_deps, include_unmanaged: false };
            let now = disk::now_secs();
            let mut worktrees = Vec::new();
            let mut stores = Vec::new();
            let mut free = 0;
            for (cfg, wt) in all_worktrees(&db, &configs, &runs) {
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
    pub async fn disk_clean(self: &Arc<Self>, apply: bool, include_unmanaged: bool) -> Result<Value> {
        let (configs, runs) = self.snapshot();
        let db = self.db.clone();
        let me = Arc::clone(self);
        tokio::task::spawn_blocking(move || {
            let policy = disk::Policy { measure: !apply, measure_deps: false, include_unmanaged };
            let now = disk::now_secs();
            let mut done = Vec::new();
            let mut freed_total: i64 = 0;
            for (cfg, wt) in all_worktrees(&db, &configs, &runs) {
                // Deepest paths first, so a nested item (.next/dev/cache) goes before its parent (.next/dev).
                let mut eligible: Vec<_> = disk::candidates(&cfg, &wt, policy, now).into_iter().filter(|c| c.eligible).collect();
                eligible.sort_by_key(|c| std::cmp::Reverse(c.path.components().count()));
                #[cfg(test)]
                if let Some(h) = me.clean_hook.lock().unwrap_or_else(|e| e.into_inner()).as_ref() {
                    h();
                }
                for c in eligible {
                    if !apply {
                        done.push(json!({ "run": c.run, "path": c.path, "item": c.item, "size": c.size, "reason": c.reason }));
                        continue;
                    }
                    // Status and claim are read again for every deletion: the snapshot above can be
                    // minutes old by now (review #14).
                    match disk::clean_one(&cfg, &me.fresh_info(&db, &wt), &c.path, policy) {
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


    // ------------------------------------------------------------ slice 7: worktrees and claims

    /// Refuse a destructive action by someone who is not the claim holder.
    pub fn check_holder(&self, k: &str, holder: Option<&str>) -> Result<()> {
        if let Some(h) = claims::live_holder(&self.db, k, claims::now()) {
            if holder != Some(h.as_str()) {
                bail!(
                    "{k} has a live writer claim held by {h}; only {h} can do this. Ask it to release, or run `setu-rs release {k}` yourself"
                );
            }
        }
        Ok(())
    }

    fn project_config(&self, project: &str) -> Result<ProjectConfig> {
        let fresh = config::load_all()?;
        fresh.into_iter().find(|c| c.project == project).ok_or_else(|| anyhow!("no project config named {project}"))
    }

    pub async fn worktree_new(self: &Arc<Self>, actor: &str, client: Option<&str>, project: &str, branch: &str, from: Option<&str>, start: bool) -> Result<Value> {
        let cfg = self.project_config(project)?;
        let existing: std::collections::BTreeSet<String> = self.lock().state.runs.keys().cloned().collect();
        let me = Arc::clone(self);
        let (b, f) = (branch.to_string(), from.map(String::from));
        let out = tokio::task::spawn_blocking(move || {
            worktree::create(&cfg, &b, f.as_deref(), &existing, &me.db, &paths::logs_dir(), |path, run| {
                let wt = path.canonicalize()?;
                let (_, spec) = me.register(&cfg, &wt, run)?;
                Ok(spec.env)
            })
        })
        .await?;
        let out = match out {
            Ok(o) => o,
            Err(e) => {
                worktree::audit(actor, client, "new-failed", &format!("{project}/{branch}"), json!({ "error": format!("{e:#}") }));
                return Err(e);
            }
        };
        let k = format!("{project}/{}", out.run);
        worktree::audit(actor, client, "new", &k, json!({ "branch": out.branch, "base": out.base, "path": out.path }));
        if start {
            self.start(&k).await?;
        }
        let mut v = self.describe_async(&k).await?;
        v["worktree_new"] = serde_json::to_value(&out)?;
        Ok(v)
    }

    pub async fn worktree_adopt(self: &Arc<Self>, actor: &str, client: Option<&str>, path: &Path) -> Result<Value> {
        let p = path.to_path_buf();
        let (cfg, wt, run) = tokio::task::spawn_blocking(move || -> Result<(ProjectConfig, std::path::PathBuf, String)> {
            let configs = config::load_all()?;
            let (cfg, found) = naming::find_worktree(&configs, &p)?.ok_or_else(|| anyhow!("{} is not inside a worktree of any configured project", p.display()))?;
            let (wt, run) = worktree::adopt_check(cfg, &found)?;
            Ok((cfg.clone(), wt, run))
        })
        .await??;
        let me = Arc::clone(self);
        let (c2, w2, r2) = (cfg.clone(), wt.clone(), run.clone());
        let (k, _) = tokio::task::spawn_blocking(move || me.register(&c2, &w2, &r2)).await??;
        worktree::audit(actor, client, "adopt", &k, json!({ "path": wt }));
        self.describe_async(&k).await
    }

    pub async fn worktree_rm(self: &Arc<Self>, actor: &str, client: Option<&str>, wanted: &str, force: bool) -> Result<Value> {
        // The run may already be gone from state (a retry after DropState): fall back to the record.
        let found = {
            let inner = self.lock();
            inner.resolve_key(wanted).map(|k| {
                let r = &inner.state.runs[&k];
                (k.clone(), r.spec.id.project.clone(), r.spec.id.run.clone(), r.spec.worktree.clone())
            })
        };
        let (key, project, run, wt) = match found {
            Ok(f) => f,
            Err(e) => {
                let (db, w) = (self.db.clone(), wanted.to_string());
                match tokio::task::spawn_blocking(move || worktree::load_op(&db, &w)).await? {
                    Ok(Some(rec)) => (wanted.to_string(), rec.project, rec.run, rec.worktree),
                    _ => return Err(e),
                }
            }
        };
        let db = self.db.clone();
        let cfg = self.project_config(&project)?;
        let declared: Vec<String> = cfg.disk_items.iter().flat_map(|i| i.paths.clone()).collect();
        let host = DaemonHost { d: Arc::clone(self), key: key.clone(), rt: tokio::runtime::Handle::current() };
        let archive_root = paths::archive_dir();
        let result = tokio::task::spawn_blocking(move || {
            worktree::rm(&worktree::RmCtx { project: &project, run: &run, worktree: &wt, repo: &cfg.repo, declared: &declared, archive_root: &archive_root, db: &db, force, host: &host, archive_cap: None })
        })
        .await?;
        match result {
            Ok(o) => {
                worktree::audit(actor, client, "rm", &key, json!({ "force": force, "archive": o.archive, "archived_files": o.archived_files, "already": o.already }));
                Ok(serde_json::to_value(o)?)
            }
            Err(e) => {
                worktree::audit(actor, client, "rm-refused", &key, json!({ "force": force, "error": format!("{e:#}") }));
                Err(e)
            }
        }
    }

    pub async fn worktree_restore(self: &Arc<Self>, actor: &str, client: Option<&str>, wanted: &str) -> Result<Value> {
        let configs = config::load_all()?;
        let archive_root = paths::archive_dir();
        let (db, w) = (self.db.clone(), wanted.to_string());
        let (cfg, run, out) = tokio::task::spawn_blocking(move || -> Result<(ProjectConfig, String, worktree::RestoreOutcome)> {
            let (cfg, run) = if let Some((p, r)) = w.split_once('/') {
                (configs.into_iter().find(|c| c.project == p).ok_or_else(|| anyhow!("no project config named {p}"))?, r.to_string())
            } else {
                let hits: Vec<_> = configs.into_iter().filter(|c| matches!(worktree::load_op(&db, &format!("{}/{w}", c.project)), Ok(Some(_)))).collect();
                match hits.len() {
                    1 => (hits.into_iter().next().unwrap_or_else(|| unreachable!()), w.clone()),
                    0 => bail!("no removal record for {w}"),
                    _ => bail!("{w} matches several projects; use project/run"),
                }
            };
            let out = worktree::restore(&cfg, &run, &db, &archive_root)?;
            Ok((cfg, run, out))
        })
        .await??;
        let me = Arc::clone(self);
        let (c2, p2, r2) = (cfg.clone(), out.path.clone(), run.clone());
        let (k, _) = tokio::task::spawn_blocking(move || me.register(&c2, &p2, &r2)).await??;
        worktree::audit(actor, client, "restore", &k, json!({ "branch": out.branch, "archive": out.restored_from }));
        let mut v = self.describe_async(&k).await?;
        v["restore"] = serde_json::to_value(&out)?;
        Ok(v)
    }

    /// `wt` with its run status, stop time and claim re-read from live state.
    fn fresh_info(&self, db: &Db, wt: &disk::WorktreeInfo) -> disk::WorktreeInfo {
        let k = format!("{}/{}", wt.project, wt.run);
        let rec = self.lock().state.runs.get(&k).map(|r| (r.status, r.stopped_at));
        let mut w = wt.clone();
        w.status = rec.map(|r| r.0);
        w.stopped_at = rec.and_then(|r| r.1);
        w.claimed_by = claims::live_holder(db, &k, claims::now());
        w
    }

    /// Read-only: the current auto-removal candidates and the daily count. No fetch, no evaluation.
    pub fn autoremove_candidates(&self) -> Result<Value> {
        let gcfg = globalcfg::GlobalConfig::load()?;
        let st = autoremove::load_state(&self.db)?;
        autoremove::candidates_json(&st, &gcfg.auto_remove)
    }

    /// One auto-removal evaluation now (the hourly tick calls this too). `dry_run` decides and
    /// reports without removing, auditing or saving. Blocking work runs on the blocking pool with a deadline.
    pub async fn autoremove(self: &Arc<Self>, dry_run: bool) -> Result<Value> {
        let gcfg = globalcfg::GlobalConfig::load()?;
        if !gcfg.auto_remove.enabled && !dry_run {
            bail!("auto_remove is off. Set `enabled = true` under [auto_remove] in {}, or preview with `setu-rs autoremove --dry-run`", globalcfg::config_path().display());
        }
        let policy = autoremove::check_cfg(&gcfg.auto_remove)?;
        self.record_request_times();
        let runs = self.lock().state.runs.clone();
        let cfgs = config::load_all()?;
        let me = Arc::clone(self);
        let rt = tokio::runtime::Handle::current();
        let job = tokio::task::spawn_blocking(move || -> Result<Value> {
            let _guard = me.ar_lock.try_lock().map_err(|_| anyhow!("an auto-remove evaluation is already running"))?;
            let items = autoremove::items_from(&cfgs, &runs, |k| claims::live_holder(&me.db, k, claims::now()));
            let mut st = autoremove::load_state(&me.db)?;
            let now = crate::disk::now_secs();
            let audit = |op: &str, run: &str, extra: Value| worktree::audit("autoremove", None, op, run, extra);
            let remove = |it: &autoremove::Item| -> Result<()> {
                // Re-check against live state right before deleting: pinned, or anything happened since the snapshot.
                {
                    let inner = me.lock();
                    let r = inner.state.runs.get(&it.key).ok_or_else(|| anyhow!("run is no longer registered"))?;
                    if r.pinned {
                        bail!("pinned since the evaluation started");
                    }
                    if autoremove::Events::from_record(r) != it.events || !matches!(r.status, RunStatus::Stopped | RunStatus::Crashed) {
                        bail!("the run was used since the evaluation started");
                    }
                }
                rt.block_on(me.worktree_rm("autoremove", None, &it.key, false)).map(|_| ())
            };
            let save = |s: &autoremove::AutoState| autoremove::save_state(&me.db, s);
            let deps = autoremove::Deps { now, day: autoremove::local_day(now), gh: &autoremove::real_gh, audit: &audit, remove: &remove, save: &save, dry_run };
            let decisions = autoremove::sweep(&items, &policy, &mut st, &deps);
            let mut pruned = Vec::new();
            if !dry_run {
                autoremove::save_state(&me.db, &st)?;
                pruned = autoremove::prune_archives(&paths::archive_dir(), now);
                for p in &pruned {
                    worktree::audit("autoremove", None, "autoremove-pruned-archive", "", json!({ "archive": p }));
                }
            }
            Ok(json!({ "dry_run": dry_run, "decisions": decisions, "removed_today": st.removals.count, "daily_cap": policy.daily_cap, "pruned_archives": pruned.len() }))
        });
        tokio::time::timeout(Duration::from_secs(3600), job).await.map_err(|_| anyhow!("auto-remove evaluation timed out after an hour"))??
    }

    pub fn claim(&self, actor: &str, client: Option<&str>, wanted: &str, holder: &str, pid: Option<i32>) -> Result<Value> {
        let k = self.resolve(wanted)?;
        let (c, outcome) = claims::claim(&self.db, &k, holder, pid, claims::now())?;
        let how = match &outcome {
            claims::Outcome::Created => "claimed",
            claims::Outcome::Refreshed => "refreshed",
            claims::Outcome::TookOver { .. } => "took over a stale claim",
        };
        let extra = match &outcome {
            claims::Outcome::TookOver { from } => json!({ "holder": holder, "took_over_from": from.holder }),
            _ => json!({ "holder": holder, "pid": pid }),
        };
        worktree::audit(actor, client, "claim", &k, extra);
        Ok(json!({ "run": k, "result": how, "claim": c }))
    }

    /// `holder = None` is a person at the CLI or app releasing whatever claim is there; MCP must name the holder.
    pub fn release(&self, actor: &str, client: Option<&str>, wanted: &str, holder: Option<&str>) -> Result<Value> {
        if actor == "mcp" && holder.is_none() {
            bail!("release needs `holder`: the name you claimed with");
        }
        let k = self.resolve(wanted)?;
        let removed = claims::release(&self.db, &k, holder, claims::now())?;
        worktree::audit(actor, client, "release", &k, json!({ "holder": removed.as_ref().map(|c| c.holder.clone()) }));
        Ok(json!({ "run": k, "released": removed.is_some(), "holder": removed.map(|c| c.holder) }))
    }

    /// `events.list`: audit events, newest first. `run` may be a short run name; a removed run is matched as written.
    pub fn events(&self, kind: Option<&str>, run: Option<&str>, since: Option<u64>, limit: usize) -> Result<Value> {
        let run = run.map(|r| self.resolve(r).unwrap_or_else(|_| r.to_string()));
        Ok(Value::Array(db::list_events(&self.db, kind, run.as_deref(), since, limit)?))
    }

    pub fn claims_list(&self) -> Value {
        let now = claims::now();
        Value::Array(
            claims::list(&self.db)
                .into_iter()
                .map(|c| json!({ "run": c.run, "holder": c.holder, "pid": c.pid, "since": c.created, "heartbeat": c.heartbeat, "stale": claims::is_stale(&c, now), "start_time_unknown": claims::start_unknown(&c) }))
                .collect(),
        )
    }

    /// Read-only: configured projects with their `[worktree] base` (null = Setu picks one).
    /// Finished removals `restore` can still work from (read from the database).
    pub fn removed(&self) -> Value {
        Value::Array(worktree::removed_list(&self.db))
    }

    pub fn projects_list(&self) -> Result<Value> {
        let mut cfgs = config::load_all()?;
        cfgs.sort_by(|a, b| a.project.cmp(&b.project));
        Ok(Value::Array(cfgs.into_iter().map(|c| json!({ "project": c.project, "base": c.worktree.base })).collect()))
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
/// Add the MCP client name (from its initialize handshake) to an audit entry.
fn with_client(mut extra: Value, client: Option<&str>) -> Value {
    if let (Some(c), Some(o)) = (client, extra.as_object_mut()) {
        o.insert("client".into(), json!(c));
    }
    extra
}

/// The last `n` lines of a file, reading at most `LOG_TAIL_BYTES` from its end.
fn tail_lines(path: &Path, n: usize) -> Result<Vec<String>> {
    use std::io::{Read, Seek, SeekFrom};
    let mut f = std::fs::File::open(path)?;
    let len = f.metadata()?.len();
    let start = len.saturating_sub(LOG_TAIL_BYTES);
    f.seek(SeekFrom::Start(start))?;
    let mut buf = Vec::new();
    f.take(LOG_TAIL_BYTES).read_to_end(&mut buf)?;
    let text = String::from_utf8_lossy(&buf);
    let mut lines: Vec<&str> = text.lines().collect();
    if start > 0 && !lines.is_empty() {
        lines.remove(0); // probably cut mid-line
    }
    let skip = lines.len().saturating_sub(n);
    Ok(lines[skip..].iter().map(|l| l.to_string()).collect())
}

/// Replace every occurrence of each secret value with `[redacted:NAME]`. Only empty values are
/// skipped (callers decide which guessed values are too short to be worth redacting); longer
/// values go first so a prefix cannot expose the rest.
pub fn redact(text: &str, secrets: &[(String, String)]) -> String {
    let mut list: Vec<&(String, String)> = secrets.iter().filter(|(_, v)| !v.is_empty()).collect();
    list.sort_by_key(|(_, v)| std::cmp::Reverse(v.len()));
    let mut out = text.to_string();
    for (name, value) in list {
        out = out.replace(value.as_str(), &format!("[redacted:{name}]"));
    }
    out
}

fn all_worktrees(db: &Db, configs: &[ProjectConfig], runs: &BTreeMap<String, RunRecord>) -> Vec<(ProjectConfig, disk::WorktreeInfo)> {
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
                    run: run.clone(),
                    worktree: wt,
                    status: rec.map(|r| r.status),
                    stopped_at: rec.and_then(|r| r.stopped_at),
                    claimed_by: claims::live_holder(db, &format!("{}/{run}", cfg.project), claims::now()),
                },
            ));
        }
    }
    out
}

/// `{holder, stale, pid, since}` for the run's claim, or null.
fn claim_json(db: &Db, k: &str) -> Value {
    match claims::get(db, k) {
        Ok(Some(c)) => json!({ "holder": c.holder, "stale": claims::is_stale(&c, claims::now()), "pid": c.pid, "since": c.created, "heartbeat": c.heartbeat, "start_time_unknown": claims::start_unknown(&c) }),
        Ok(None) => Value::Null,
        Err(_) => json!({ "holder": "(unreadable)", "stale": false }),
    }
}

fn run_json(db: &Db, k: &str, r: &RunRecord) -> Value {
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
        "claim": claim_json(db, k),
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


/// Plugs the daemon's state into `worktree::rm`. Runs on the blocking pool; `stop` re-enters the runtime.
struct DaemonHost {
    d: Arc<Daemon>,
    key: String,
    rt: tokio::runtime::Handle,
}

impl worktree::RmHost for DaemonHost {
    fn stop(&self) -> Result<()> {
        if !self.d.lock().state.runs.contains_key(&self.key) {
            return Ok(());
        }
        self.rt.block_on(self.d.stop(&self.key, RunStatus::Stopped))
    }
    fn claim_holder(&self) -> Option<String> {
        claims::live_holder(&self.d.db, &self.key, claims::now())
    }
    fn running(&self) -> Option<String> {
        let inner = self.d.lock();
        match inner.state.runs.get(&self.key).map(|r| r.status) {
            Some(st @ (RunStatus::Running | RunStatus::Starting | RunStatus::Stopping)) => Some(format!("{st:?}").to_lowercase()),
            _ => None,
        }
    }
    /// In memory only; `commit_teardown` writes the result together with the lease and marker.
    fn drop_state(&self) -> Result<()> {
        let id = {
            let mut inner = self.d.lock();
            let id = inner.state.runs.remove(&self.key).map(|r| r.spec.id);
            inner.rebuild_hosts();
            id
        };
        if let Some(id) = id {
            self.d.activity.forget(&id);
        }
        Ok(())
    }
    fn release_lease(&self) -> Result<()> {
        self.d.lock().state.leases.remove(&self.key);
        Ok(())
    }
    fn commit_teardown(&self, db: &Db, extra: &mut dyn FnMut(&crate::db::Conn) -> Result<()>) -> Result<()> {
        let (snap, ver) = self.d.snapshot_state();
        write_snapshot(db, &self.d.written, &snap, ver, extra)
    }
}

/// Write a state snapshot (if it is newer than the last one written) and `extra`, in one transaction.
/// `extra` always runs: it is the part of a change that must not be skipped when a newer snapshot already landed.
fn write_snapshot(db: &Db, written: &Mutex<u64>, snap: &State, ver: u64, extra: &mut dyn FnMut(&crate::db::Conn) -> Result<()>) -> Result<()> {
    let mut w = written.lock().unwrap_or_else(|e| e.into_inner());
    db.tx(|tx| {
        if ver > *w {
            state::save_tx(tx, snap)?;
        }
        extra(tx)
    })?;
    if ver > *w {
        *w = ver;
    }
    Ok(())
}

static SELF: std::sync::OnceLock<Arc<Daemon>> = std::sync::OnceLock::new();

/// Domains the built-in DNS answers for: every project domain except *.localhost.
fn dns_domains() -> Arc<std::sync::RwLock<Vec<String>>> {
    static D: std::sync::OnceLock<Arc<std::sync::RwLock<Vec<String>>>> = std::sync::OnceLock::new();
    D.get_or_init(|| Arc::new(std::sync::RwLock::new(Vec::new()))).clone()
}

fn domains_refresh(configs: &[ProjectConfig]) {
    let list: Vec<String> = configs.iter().map(|c| c.domain.to_lowercase()).filter(|d| !d.ends_with("localhost")).collect();
    if let Ok(mut w) = dns_domains().write() {
        *w = list;
    }
}

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
    let proxy_port = crate::globalcfg::proxy_port();
    // Port 80 can only be bound unprivileged on the wildcard address; the proxy still
    // drops every non-loopback peer. Any other port binds loopback only.
    let bind_ip = if proxy_port < 1024 { "0.0.0.0" } else { "127.0.0.1" };
    let listener = tokio::net::TcpListener::bind((bind_ip, proxy_port))
        .await
        .with_context(|| format!("binding the proxy on {bind_ip}:{proxy_port}"))?;
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<ExitEvent>();
    let daemon = tokio::task::spawn_blocking(move || Daemon::new(tx)).await??;
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
    // DNS for custom project domains (not *.localhost), for /etc/resolver/<domain>.
    let dns_port = crate::globalcfg::GlobalConfig::load().map(|c| c.dns_port).unwrap_or(15353);
    let domains = dns_domains();
    domains_refresh(&daemon.lock().configs);
    tokio::spawn(async move {
        if let Err(e) = crate::dns::serve(dns_port, domains).await {
            eprintln!("setu: DNS on 127.0.0.1:{dns_port} unavailable: {e:#}");
        }
    });
    eprintln!("setu-rs daemon: proxy on http://{bind_ip}:{proxy_port}, socket {}", paths::socket_path().display());

    let mut term = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())?;
    let mut tick = tokio::time::interval(SWEEP_EVERY);
    // Hourly: clean regenerable items of stopped, Setu-managed runs past their policy.
    let mut disk_tick = tokio::time::interval(Duration::from_secs(3600));
    // Hourly, and not at startup: opt-in auto-removal of merged or long-idle worktrees.
    let mut ar_tick = tokio::time::interval_at(tokio::time::Instant::now() + Duration::from_secs(3600), Duration::from_secs(3600));
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
            _ = ar_tick.tick() => {
                if globalcfg::GlobalConfig::load().is_ok_and(|c| c.auto_remove.enabled) {
                    let d = daemon.clone();
                    tokio::spawn(async move {
                        match d.autoremove(false).await {
                            Ok(v) if v["decisions"].as_array().is_some_and(|a| !a.is_empty()) => eprintln!("setu: auto-remove: {}", v["decisions"]),
                            Err(e) => eprintln!("setu: auto-remove failed: {e:#}"),
                            _ => {}
                        }
                    });
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
    // Fold the WAL into the main file so the next start opens a small, clean database.
    if let Err(e) = daemon.db.with_async(|c| c.query("PRAGMA wal_checkpoint(TRUNCATE)", (), |_| Ok(())).map(|_| ())).await {
        eprintln!("setu: final checkpoint failed: {e:#}");
    }
    let _ = std::fs::remove_file(paths::socket_path());
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::env::tests::{sandbox, Sandbox};
    use std::path::PathBuf;

    fn pgrep(pattern: &str) -> bool {
        std::process::Command::new("pgrep").args(["-f", pattern]).output().map(|o| !o.stdout.is_empty()).unwrap_or(false)
    }

    fn pkill(pattern: &str) {
        let _ = std::process::Command::new("pkill").args(["-f", pattern]).status();
    }

    struct Fx {
        _sb: Sandbox,
        d: Arc<Daemon>,
        rx: tokio::sync::mpsc::UnboundedReceiver<ExitEvent>,
        k: String,
        wt: PathBuf,
    }

    /// A daemon over a sandboxed SETU_HOME with one project `tp` whose procs are `procs` (name -> command)
    /// and one registered run `tp/r`.
    fn fixture(procs: &[(String, String)], extra: &str) -> Fx {
        let sb = sandbox();
        let mut toml = String::from("project = \"tp\"\nrepo = \"/nonexistent/tp.git\"\ndomain = \"tp.local\"\n");
        toml.push_str(extra);
        for (n, c) in procs {
            toml.push_str(&format!("[procs.{n}]\nrun = '{c}'\n"));
        }
        std::fs::create_dir_all(paths::projects_dir()).unwrap();
        std::fs::write(paths::projects_dir().join("tp.toml"), toml).unwrap();
        let wt = sb.dir.join("wt/r");
        std::fs::create_dir_all(&wt).unwrap();
        let (tx, rx) = tokio::sync::mpsc::unbounded_channel();
        let d = Daemon::new(tx).unwrap();
        let cfg = config::load_all().unwrap().remove(0);
        let (k, _) = d.register(&cfg, &wt, "r").unwrap();
        Fx { _sb: sb, d, rx, k, wt }
    }

    fn status(f: &Fx) -> RunStatus {
        f.d.lock().state.runs[&f.k].status
    }

    fn recorded(f: &Fx) -> usize {
        f.d.lock().state.runs[&f.k].procs.len()
    }

    #[tokio::test(flavor = "current_thread")]
    async fn a_stop_during_start_leaves_no_process_behind() {
        // review #7
        let procs: Vec<(String, String)> = (0..25).map(|i| (format!("p{i:02}"), "exec sleep 300701".to_string())).collect();
        let f = fixture(&procs, "");
        let (d, k) = (f.d.clone(), f.k.clone());
        let starter = {
            let (d, k) = (d.clone(), k.clone());
            tokio::spawn(async move { d.start(&k).await })
        };
        for _ in 0..2000 {
            if recorded(&f) >= 1 {
                break;
            }
            tokio::time::sleep(Duration::from_millis(1)).await;
        }
        assert!(recorded(&f) >= 1, "start never got going");
        d.stop(&k, RunStatus::Stopped).await.unwrap();
        let _ = starter.await.unwrap();
        tokio::time::sleep(Duration::from_millis(300)).await;
        let leaked = pgrep("sleep 300701");
        pkill("sleep 300701");
        assert!(!leaked, "processes spawned by a cancelled start are still running");
        assert_eq!(recorded(&f), 0);
        assert_eq!(status(&f), RunStatus::Stopped);
    }

    #[tokio::test(flavor = "current_thread")]
    async fn a_sidecar_leader_exit_keeps_its_surviving_group_owned() {
        // review #8
        let mut f = fixture(&[("w".to_string(), "sleep 300702 & exit 0".to_string())], "");
        f.d.start(&f.k).await.unwrap();
        let ev = tokio::time::timeout(Duration::from_secs(5), f.rx.recv()).await.unwrap().unwrap();
        f.d.on_exit(ev).await;
        assert!(pgrep("sleep 300702"), "the backgrounded child should still run");
        assert_eq!(recorded(&f), 1, "the record stays while its group survives");
        f.d.stop(&f.k, RunStatus::Stopped).await.unwrap();
        tokio::time::sleep(Duration::from_millis(200)).await;
        let left = pgrep("sleep 300702");
        pkill("sleep 300702");
        assert!(!left, "stop must reach the surviving group");
        assert_eq!(recorded(&f), 0);
    }

    #[test]
    fn a_failed_stop_keeps_what_is_still_alive() {
        // review #9
        let rec = |pid| crate::model::ProcRecord { name: "w".into(), pid, start_time: 1, escaped: vec![] };
        let procs = [rec(10), rec(11)];
        assert!(retained_after_stop(&procs, false, &|_| true).is_empty(), "a successful stop leaves nothing");
        let left = retained_after_stop(&procs, true, &|p| p.pid == 11);
        assert_eq!(left.iter().map(|p| p.pid).collect::<Vec<_>>(), [11]);
        assert!(retained_after_stop(&procs, true, &|_| false).is_empty());
    }

    #[tokio::test(flavor = "current_thread")]
    async fn start_refuses_while_an_unstopped_process_is_still_recorded() {
        // review #9: ownership is not cleared by a failed stop, and start must not clear it either
        let f = fixture(&[("w".to_string(), "exec sleep 300703".to_string())], "");
        use std::os::unix::process::CommandExt;
        // like a supervised proc: its own session, so it leads its own group
        let mut stranger = unsafe { std::process::Command::new("sleep").arg("300703").pre_exec(|| if libc::setsid() == -1 { Err(std::io::Error::last_os_error()) } else { Ok(()) }).spawn().unwrap() };
        let pid = stranger.id() as i32;
        // reap it as soon as it dies, so it does not linger as a zombie
        let reaper = std::thread::spawn(move || stranger.wait());
        let rec = crate::model::ProcRecord { name: "w".into(), pid, start_time: crate::procinfo::start_time(pid).unwrap(), escaped: vec![] };
        f.d.set(&f.k, |r| {
            r.status = RunStatus::Crashed;
            r.procs = vec![rec.clone()];
        });
        let e = f.d.start(&f.k).await.unwrap_err();
        assert!(e.to_string().contains("still has a process"), "{e:#}");
        assert_eq!(recorded(&f), 1, "the record survived the refused start");
        f.d.stop(&f.k, RunStatus::Stopped).await.unwrap();
        let _ = reaper.join();
        assert_eq!(recorded(&f), 0);
        pkill("sleep 300703");
    }

    #[tokio::test(flavor = "current_thread")]
    async fn start_is_not_reported_done_when_the_process_record_cannot_be_saved() {
        // review #15
        let f = fixture(&[("w".to_string(), "exec sleep 300704".to_string())], "");
        f.d.fail_persist.store(true, std::sync::atomic::Ordering::SeqCst);
        let e = f.d.start(&f.k).await.unwrap_err();
        assert!(format!("{e:#}").contains("could not save"), "{e:#}");
        tokio::time::sleep(Duration::from_millis(200)).await;
        let leaked = pgrep("sleep 300704");
        pkill("sleep 300704");
        assert!(!leaked, "a process whose ownership could not be saved must be stopped");
        assert_eq!(status(&f), RunStatus::Crashed);
        assert_eq!(recorded(&f), 0);
    }

    #[tokio::test(flavor = "current_thread")]
    async fn logs_redact_config_secrets_short_declared_secrets_and_previous_values_and_fail_closed() {
        // review #11
        let f = fixture(&[("w".to_string(), "exec sleep 300705".to_string())], "[env]\nAPI_TOKEN = \"cfg-token-abcdefgh\"\n");
        let id = RunId { project: "tp".into(), run: "r".into() };
        env::write_var(&env::Scope::Worktree(id.clone()), "PIN", "12345", Some(true)).unwrap();
        env::write_var(&env::Scope::Project("tp".into()), "DB_PASSWORD", "rotated-old-value", None).unwrap();
        env::write_var(&env::Scope::Project("tp".into()), "DB_PASSWORD", "rotated-new-value", None).unwrap();
        let log_dir = paths::logs_dir().join("tp/r");
        std::fs::create_dir_all(&log_dir).unwrap();
        std::fs::write(
            log_dir.join("w.log"),
            "token=cfg-token-abcdefgh\npin=12345\nold=rotated-old-value\nnew=rotated-new-value\nport 8080 is fine\n",
        )
        .unwrap();
        let out = f.d.logs(&f.k, None, 50).unwrap();
        let text = out["text"].as_str().unwrap();
        for leaked in ["cfg-token-abcdefgh", "12345", "rotated-old-value", "rotated-new-value"] {
            assert!(!text.contains(leaked), "{leaked} leaked: {text}");
        }
        assert!(text.contains("port 8080 is fine"), "{text}");
        // an unreadable secret layer must stop log delivery, not skip redaction
        let (_, secrets_path) = env::Scope::Project("tp".into()).paths();
        std::fs::write(&secrets_path, "DB_PASSWORD = oops-not-quoted\n").unwrap();
        let e = f.d.logs(&f.k, None, 50).unwrap_err();
        assert!(!format!("{e:#}").contains("oops-not-quoted"), "{e:#}");
    }

    #[tokio::test(flavor = "current_thread")]
    async fn secrets_with_braces_are_literal_and_template_errors_never_echo_values() {
        // review #10
        let f = fixture(&[("w".to_string(), "exec sleep 300706".to_string())], "");
        let cfg = f.d.lock().config("tp").unwrap();
        env::write_var(&env::Scope::Project("tp".into()), "API_TOKEN", "CANARY-REVIEW-{SECRET}", None).unwrap();
        let mut leases = f.d.lock().state.leases.clone();
        let spec = build_spec(&cfg, &f.wt, "r", &mut leases).unwrap();
        assert_eq!(spec.env["API_TOKEN"], "CANARY-REVIEW-{SECRET}", "a secret is stored data, not a template");
        env::write_var(&env::Scope::Project("tp".into()), "NOTE", "CANARY-PLAIN-{broken", Some(false)).unwrap();
        let e = f.d.env_effective("r").unwrap_err();
        assert!(!format!("{e:#}").contains("CANARY"), "{e:#}");
        // a malformed secrets file does not echo its line either
        let (_, sp) = env::Scope::Project("tp".into()).paths();
        std::fs::write(&sp, "API_TOKEN = CANARY-LINE-{X}\n").unwrap();
        let e = f.d.env_effective("r").unwrap_err();
        assert!(!format!("{e:#}").contains("CANARY"), "{e:#}");
    }

    #[tokio::test(flavor = "current_thread")]
    async fn disk_clean_rereads_status_and_claims_right_before_each_deletion() {
        // review #14
        use crate::model::{DiskItem, DiskKind, RunSpec};
        let sb = sandbox();
        let f = crate::worktree::tests::fx("daemon-clean");
        let o = crate::worktree::tests::new_wt(&f, "feat/dc");
        std::fs::create_dir_all(o.path.join(".next")).unwrap();
        std::fs::write(o.path.join(".next/blob"), vec![1u8; 2048]).unwrap();
        let mut cfg = f.cfg.clone();
        cfg.disk_items = vec![DiskItem { name: "next".into(), kind: DiskKind::Cache, paths: vec![".next".into()], clean_after: Some(Duration::from_secs(1)) }];
        let spec = RunSpec {
            id: RunId { project: "app".into(), run: "feat-dc".into() },
            worktree: o.path.clone(),
            host: "x".into(),
            url: "http://x".into(),
            ports: BTreeMap::new(),
            env: BTreeMap::new(),
            procs: vec![],
            web_port: None,
            idle: Duration::from_secs(60),
        };
        let mut st = State::default();
        st.runs.insert(
            "app/feat-dc".into(),
            RunRecord { spec, status: RunStatus::Stopped, pinned: false, procs: vec![], note: None, stopped_at: Some(1), env_hash: None, last_started_at: None, last_request_at: None },
        );
        let db = Arc::new(Db::open(&sb.dir.join("clean.db")).unwrap());
        let (tx, _rx) = tokio::sync::mpsc::unbounded_channel();
        let d = Daemon::with_parts(vec![cfg], st, db.clone(), tx);
        // a writer takes the claim after the sweep has already decided
        let db2 = db.clone();
        *d.clean_hook.lock().unwrap() = Some(Box::new(move || {
            claims::claim(&db2, "app/feat-dc", "late-writer", None, claims::now()).unwrap();
        }));
        let out = d.disk_clean(true, false).await.unwrap();
        assert!(o.path.join(".next/blob").exists(), "a claim taken mid-sweep must stop the deletion: {out}");
        assert!(out["items"].as_array().unwrap().iter().any(|i| i["error"].as_str().is_some_and(|e| e.contains("claim"))), "{out}");
        // without the claim the same sweep does clean it
        claims::release(&db, "app/feat-dc", None, claims::now()).unwrap();
        *d.clean_hook.lock().unwrap() = None;
        d.disk_clean(true, false).await.unwrap();
        assert!(!o.path.join(".next").exists());
    }
}
