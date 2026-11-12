//! The daemon: owns state, starts and stops runs, answers the proxy and the socket API.

use crate::activity::ActivityTracker;
use crate::autoremove;
use crate::globalcfg;
use crate::claims;
use crate::config;
use crate::deps;
use crate::worktree;
use crate::model::{self, Lookup, ProjectConfig, RunId, RunRecord, RunSpec, RunStatus, Routes};
use crate::disk;
use crate::env;
use crate::disk_measure;
use crate::naming;
use crate::paths;
use crate::ports;
use crate::procinfo;
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

pub struct Daemon {
    inner: Mutex<Inner>,
    /// The one database; used only from blocking threads.
    db: Arc<Db>,
    /// Highest state version written to disk; older snapshots are skipped.
    written: Arc<Mutex<u64>>,
    pub activity: Arc<ActivityTracker>,
    exits: ExitTx,
    /// One auto-remove evaluation at a time (hourly tick vs `setu autoremove`).
    ar_lock: Mutex<()>,
    /// One start or stop of a run at a time (review #7).
    life: Mutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>>,
    /// Dependency installs running at once, daemon-wide (a burst of on-demand starts must not fork 20 installs).
    install_slots: Arc<tokio::sync::Semaphore>,
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
    /// Runs whose start is installing missing dependencies right now (not persisted).
    installing: std::collections::HashSet<String>,
    /// (mtime ns, length) of each project's config file when `configs` last took it from disk.
    cfg_stamps: HashMap<String, (u128, u64)>,
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
        // Aliases never displace a run's own host.
        for (k, r) in &self.state.runs {
            for a in &r.spec.aliases {
                self.hosts.entry(a.clone()).or_insert_with(|| k.clone());
            }
        }
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
            [] => bail!("no run named {wanted}; see `setu ls`"),
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

/// Most dependency installs that run at the same time.
const MAX_CONCURRENT_INSTALLS: usize = 2;

impl Daemon {
    pub fn new(exits: ExitTx) -> Result<Arc<Self>> {
        let configs = config::load_all()?;
        let db = db::global().context("the state database could not be opened or imported; refusing to start")?;
        let state = state::load(&db).context("the state database is unreadable; refusing to start")?;
        Ok(Self::with_parts(configs, state, db, exits))
    }

    fn with_parts(configs: Vec<ProjectConfig>, state: State, db: Arc<Db>, exits: ExitTx) -> Arc<Self> {
        let mut inner = Inner { configs, state, hosts: HashMap::new(), version: 0, gens: HashMap::new(), installing: Default::default(), cfg_stamps: HashMap::new() };
        inner.rebuild_hosts();
        Arc::new(Self {
            inner: Mutex::new(inner),
            db,
            written: Arc::new(Mutex::new(0)),
            activity: ActivityTracker::new(),
            exits,
            ar_lock: Mutex::new(()),
            life: Mutex::new(HashMap::new()),
            install_slots: Arc::new(tokio::sync::Semaphore::new(MAX_CONCURRENT_INSTALLS)),
            #[cfg(test)]
            fail_persist: std::sync::atomic::AtomicBool::new(false),
            #[cfg(test)]
            clean_hook: Mutex::new(None),
        })
    }

    /// Journal config `[env]` secret values that an edit changed or removed, so logs written while
    /// they were current stay redactable (review B5). Fails the refresh if it cannot be recorded.
    fn journal_config_changes(&self, fresh: &[ProjectConfig]) -> Result<()> {
        let old: Vec<ProjectConfig> = self.lock().configs.clone();
        for o in &old {
            let new = fresh.iter().find(|c| c.project == o.project);
            for (name, value) in o.env.iter().filter(|(n, v)| env::looks_secret(n, v)) {
                if new.is_none_or(|c| c.env.get(name) != Some(value)) {
                    env::remember_superseded(name, value)?;
                }
            }
        }
        Ok(())
    }

    /// Blocking (reads the config file; never call under the state lock). The project's config as
    /// it is on disk now, so Restart, effective env and stale-env reporting never use the copy
    /// cached at registration (review B9). An invalid edit is an error, not a silent fallback to
    /// the old copy. Unchanged files (same mtime and length) reuse the cached parse.
    fn fresh_config(&self, project: &str) -> Result<ProjectConfig> {
        let path = paths::projects_dir().join(format!("{project}.toml"));
        let stamp = std::fs::metadata(&path).ok().map(|m| {
            let ns = m.modified().ok().and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok()).map_or(0, |d| d.as_nanos());
            (ns, m.len())
        });
        {
            let inner = self.lock();
            if let (Some(now), Some(then)) = (stamp, inner.cfg_stamps.get(project)) {
                if now == *then {
                    if let Ok(c) = inner.config(project) {
                        return Ok(c);
                    }
                }
            }
        }
        let direct = if stamp.is_some() { Some(config::load_project(&path)?) } else { None };
        let cfg = match direct.filter(|c| c.project == project) {
            Some(c) => c,
            None => match config::load_all()?.into_iter().find(|c| c.project == project) {
                Some(c) => c,
                // No file on disk: keep what the daemon already has.
                None => return self.lock().config(project),
            },
        };
        let mut all = self.lock().configs.clone();
        match all.iter_mut().find(|c| c.project == project) {
            Some(slot) => *slot = cfg.clone(),
            None => all.push(cfg.clone()),
        }
        self.journal_config_changes(&all)?;
        let mut inner = self.lock();
        inner.configs = all;
        if let Some(st) = stamp {
            inner.cfg_stamps.insert(project.to_string(), st);
        }
        domains_refresh(&inner.configs);
        Ok(cfg)
    }

    /// Mark a run whose web port is held by its own worktree's dev server (not started by Setu)
    /// as Running. Only a Stopped or Crashed run with no recorded processes is eligible, and the
    /// state is checked again when the change is applied. Returns whether it was applied.
    #[cfg(test)]
    fn mark_external(&self, k: &str, pid: i32, start_time: u64, port: u16) -> bool {
        self.mark_external_found(k, &procinfo::V1Found { listener: Some((pid, start_time)), ..Default::default() }, port)
    }

    /// `mark_external` for what a v1 run left behind: the listener's whole group (leader record,
    /// listener as evidence) when it was proven, else the bare listener, plus one record per sidecar group.
    fn mark_external_found(&self, k: &str, f: &procinfo::V1Found, port: u16) -> bool {
        let Some((lpid, lst)) = f.listener else { return false };
        let mut applied = false;
        self.set(k, |r| {
            if matches!(r.status, RunStatus::Stopped | RunStatus::Crashed) && r.procs.is_empty() && r.spec.web_port == Some(port) {
                let rec = |name: &str, pid: i32, start_time: u64, members: Vec<(i32, u64)>| crate::model::ProcRecord { name: name.into(), pid, start_time, escaped: vec![], members };
                r.status = RunStatus::Running;
                r.procs = vec![match f.leader {
                    Some((g, gst)) => rec(supervisor::EXTERNAL_PROC, g, gst, vec![(lpid, lst)]),
                    None => rec(supervisor::EXTERNAL_PROC, lpid, lst, vec![]),
                }];
                r.procs.extend(f.sidecars.iter().map(|&(p, st)| rec(supervisor::EXTERNAL_SIDECAR, p, st, vec![])));
                let side = if f.sidecars.is_empty() { String::new() } else { format!(" and {} sidecar group(s)", f.sidecars.len()) };
                r.note = Some(format!("already running outside Setu (pid {lpid} on port {port}, started from this worktree{side}); Down or Restart stops it, and a restart makes Setu its owner"));
                applied = true;
            }
        });
        applied
    }

    /// Blocking: look for external listeners for every eligible run (one scan of the process table).
    fn detect_external_all(&self) -> Vec<String> {
        let eligible: Vec<(String, std::path::PathBuf, u16)> = self
            .lock()
            .state
            .runs
            .iter()
            .filter(|(_, r)| matches!(r.status, RunStatus::Stopped | RunStatus::Crashed) && r.procs.is_empty())
            .filter_map(|(k, r)| Some((k.clone(), r.spec.worktree.clone(), r.spec.web_port?)))
            .collect();
        if eligible.is_empty() {
            return Vec::new();
        }
        let wanted: Vec<(std::path::PathBuf, u16)> = eligible.iter().map(|(_, w, p)| (w.clone(), *p)).collect();
        let found = procinfo::v1_groups(&wanted, None);
        let mut out = Vec::new();
        for ((k, _, port), hit) in eligible.into_iter().zip(found) {
            if self.mark_external_found(&k, &hit, port) {
                out.push(k);
            }
        }
        out
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
                // A transitional state with nothing to supervise can never finish on its own: the
                // daemon died before the first process was recorded (or after the last one left).
                // Turn it into an explicit Stopped state the user can act on (review B11).
                if matches!(rec.status, RunStatus::Starting | RunStatus::Stopping | RunStatus::Running | RunStatus::Preparing) {
                    let was = rec.status;
                    self.set(&k, |r| {
                        // Setup died with the daemon: the checkout may be half installed, so it is not startable.
                        r.status = if was == RunStatus::Preparing { RunStatus::SetupFailed } else { RunStatus::Stopped };
                        r.stopped_at = Some(crate::disk::now_secs());
                        r.note = Some(match was {
                            RunStatus::Preparing => "the daemon restarted while setup was running; run `setu retry-setup` to finish it".to_string(),
                            RunStatus::Starting => "the daemon restarted while this run was starting, before any process was recorded; start it again".to_string(),
                            RunStatus::Stopping => "the daemon restarted while this run was stopping; no processes are recorded, so it is stopped".to_string(),
                            _ => "the daemon restarted and this run had no recorded processes; start it again".to_string(),
                        });
                    });
                }
                continue;
            }
            // A server Setu adopted but did not start (a v1 dev server) is kept as external while any
            // part of it lives; it is never signalled here. The watchdog re-proves and stops it on request.
            if rec.status == RunStatus::Running && rec.procs.iter().all(supervisor::is_external) {
                if rec.procs.iter().any(supervisor::external_alive) {
                    self.activity.touch(&rec.spec.id);
                } else {
                    self.set(&k, |r| {
                        r.status = RunStatus::Stopped;
                        r.procs.clear();
                        r.stopped_at = Some(crate::disk::now_secs());
                        r.note = Some("the external server exited while the daemon was down".into());
                    });
                }
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
                    r.note = Some(match &res {
                        Err(e) => format!("after a daemon restart some processes could not be stopped or proven to be this run's: {e:#}"),
                        Ok(()) => "some processes survived the stop after a daemon restart; stop the run again".to_string(),
                    });
                }
            });
        }
        // Reconciled states are on disk before the daemon serves its first request.
        if let Err(e) = self.persist_durable().await {
            eprintln!("setu: saving reconciled run states failed: {e:#}");
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
        self.register_seeded(cfg, worktree, run, None, RunStatus::Stopped).map(|(k, s, _)| (k, s))
    }

    /// `register`, optionally pre-leasing `seed` as the run's `web` port (import of a v1 port).
    /// The third value says whether the seed was used. A seed is refused when the run already
    /// has a lease, the port is outside 1024..=65535, reserved, leased to another run, or busy.
    fn register_seeded(&self, cfg: &ProjectConfig, worktree: &Path, run: &str, seed: Option<u16>, initial: RunStatus) -> Result<(String, RunSpec, Option<bool>)> {
        // Probing the port is slow-ish; do it before the state lock.
        // A busy port still counts as free for a seed when it is this worktree's own dev server.
        let seed_free = seed.map(|p| ports::port_free(p) || procinfo::external_listener(worktree, p).is_some());
        // Disk and git work happens before the state lock is taken (review #18).
        let fresh = config::load_all().ok();
        if let Some(f) = &fresh {
            self.journal_config_changes(f)?;
        }
        let id = RunId { project: cfg.project.clone(), run: run.to_string() };
        let layers = read_layers(&cfg.project, &id)?;
        let mut inner = self.lock();
        if let Some(fresh) = fresh {
            domains_refresh(&fresh);
            inner.cfg_stamps.clear();
            inner.configs = fresh;
        }
        let mut leases = inner.state.leases.clone();
        let k0 = key(&id);
        let mut seeded = None;
        if let Some(p) = seed {
            let wants_web = cfg.ports.iter().any(|n| n == "web");
            let sane = (1024..=65535).contains(&p) && ![80, 7777, 15353].contains(&p);
            let taken = leases.iter().any(|(rk, m)| *rk != k0 && m.values().any(|x| *x == p));
            if !wants_web || leases.contains_key(&k0) {
                seeded = Some(leases.get(&k0).and_then(|m| m.get("web")) == Some(&p));
            } else if sane && !taken && seed_free == Some(true) {
                leases.insert(k0.clone(), BTreeMap::from([("web".to_string(), p)]));
                seeded = Some(true);
            } else {
                seeded = Some(false);
            }
        }
        let spec = build_spec_with(cfg, worktree, run, &mut leases, &layers)?;
        inner.state.leases = leases;
        let k = key(&spec.id);
        for host in std::iter::once(&spec.host).chain(spec.aliases.iter()) {
            if let Some(other) = inner.hosts.get(host) {
                if other != &k {
                    bail!("host {host} already belongs to run {other}");
                }
            }
        }
        if let Some(existing) = inner.state.runs.get(&k) {
            if existing.spec.worktree != worktree {
                bail!("run name {k} already belongs to {}; rename one of the worktrees", existing.spec.worktree.display());
            }
        }
        let rec = inner.state.runs.entry(k.clone()).or_insert_with(|| RunRecord {
            spec: spec.clone(),
            status: initial,
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
        Ok((k, spec, seeded))
    }

    /// `setu import-v1`: register one existing worktree (no install, no start), keeping its v1
    /// port when `port` is free and sane. Idempotent.
    pub async fn import_adopt(self: &Arc<Self>, actor: &str, project: &str, path: &Path, port: Option<u16>) -> Result<Value> {
        let (p, name) = (path.to_path_buf(), project.to_string());
        let me = Arc::clone(self);
        let (k, spec, seeded) = tokio::task::spawn_blocking(move || -> Result<(String, RunSpec, Option<bool>)> {
            let configs = config::load_all()?;
            let cfg = configs.iter().find(|c| c.project == name).ok_or_else(|| anyhow!("no project config named {name}"))?;
            let (wt, run) = worktree::adopt_check(cfg, &p)?;
            me.register_seeded(cfg, &wt, &run, port, RunStatus::Stopped)
        })
        .await??;
        // A v1 dev server that is still up on the kept port becomes a running (external) run right away.
        if let (Some(port), true) = (spec.web_port, seeded == Some(true)) {
            let (me, k2, wt) = (Arc::clone(self), k.clone(), spec.worktree.clone());
            let _ = tokio::task::spawn_blocking(move || {
                me.mark_external_found(&k2, &procinfo::v1_group(&wt, port, None), port);
            })
            .await;
        }
        worktree::audit(actor, None, "adopt", &k, json!({ "path": spec.worktree, "import_v1": true }));
        Ok(json!({ "run": k, "url": spec.url, "port": spec.ports.get("web"), "port_kept": seeded.unwrap_or(false), "worktree": spec.worktree }))
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
            bail!("a removal of {k} is pending; retry `setu rm {k}` to finish it");
        }
        let life = self.life_lock(k);
        let _life = life.lock().await;
        // The run's own dev server may already be listening on its port (a v1 server, or one
        // started by hand): adopt it instead of starting a second one (and instead of failing on the busy port).
        let probe = self.lock().state.runs.get(k).filter(|r| matches!(r.status, RunStatus::Stopped | RunStatus::Crashed) && r.procs.is_empty()).and_then(|r| Some((r.spec.worktree.clone(), r.spec.web_port?)));
        if let Some((wt, port)) = probe {
            let f = tokio::task::spawn_blocking(move || procinfo::v1_group(&wt, port, None)).await?;
            if self.mark_external_found(k, &f, port) {
                return Ok(());
            }
        }
        let (id, wt_path) = {
            let inner = self.lock();
            let r = inner.state.runs.get(k).ok_or_else(|| anyhow!("unknown run {k}"))?;
            (r.spec.id.clone(), r.spec.worktree.clone())
        };
        // The layer files are read off the runtime thread and outside the state lock (review #18).
        // The project config is re-read too, so a restart picks up edits made since registration (review B9).
        let me = Arc::clone(self);
        let (layers, fresh_cfg, need) = tokio::task::spawn_blocking(move || -> Result<(Layers, ProjectConfig, deps::Need)> {
            let cfg = me.fresh_config(&id.project)?;
            // Missing dependencies (cheap directory check) are restored before the procs start.
            let need = deps::plan(&cfg, &wt_path);
            Ok((read_layers(&id.project, &id)?, cfg, need))
        })
        .await??;
        let (spec, gen, install) = {
            let mut inner = self.lock();
            let rec = inner.state.runs.get(k).ok_or_else(|| anyhow!("unknown run {k}"))?.clone();
            match rec.status {
                RunStatus::Running | RunStatus::Starting => return Ok(()),
                RunStatus::Stopping => bail!("{k} is stopping; try again in a moment"),
                RunStatus::Preparing => bail!("{k} is still being prepared (setup is running); it can start once setup succeeds"),
                RunStatus::SetupFailed => bail!("setup failed for {k}{}; fix the cause, then run `setu retry-setup {k}`", rec.note.as_deref().map(|n| format!(" ({n})")).unwrap_or_default()),
                _ => {}
            }
            if let Some(p) = rec.procs.iter().find(|p| supervisor::unresolved(p)) {
                bail!("{k} still has a process from an earlier run that could not be stopped (pid {}); run `setu down {k}` again, or end it by hand", p.pid);
            }
            if let deps::Need::Blocked(why) = &need {
                let note = format!("setup failed: {why}");
                if let Some(r) = inner.state.runs.get_mut(k) {
                    r.status = RunStatus::SetupFailed;
                    r.note = Some(note.clone());
                }
                inner.rebuild_hosts();
                drop(inner);
                self.persist();
                bail!("{k}: {note}");
            }
            let cfg = fresh_cfg;
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
                // Missing dependencies: the proxy shows the Preparing page until the install is done.
                r.status = if matches!(need, deps::Need::Install(_)) { RunStatus::Preparing } else { RunStatus::Starting };
                r.last_started_at = Some(crate::disk::now_secs());
                r.note = None;
                r.procs.clear();
            }
            inner.rebuild_hosts();
            drop(inner);
            self.persist();
            let install = match need {
                deps::Need::Install(steps) => Some(steps),
                _ => None,
            };
            (spec, gen, install)
        };
        if let Some(steps) = install {
            if let Err(e) = self.run_auto_install(k, &spec, steps).await {
                let note = format!("setup failed: {e:#}");
                self.set(k, |r| {
                    r.status = RunStatus::SetupFailed;
                    r.note = Some(note);
                });
                return Err(e.context(format!("installing dependencies for {k} failed; fix the cause, then run `setu retry-setup {k}`")));
            }
            let admitted = {
                let mut inner = self.lock();
                let (max, others) = match inner.config(&spec.id.project) {
                    Ok(c) => (c.max_running, inner.up_count(&spec.id.project)),
                    Err(_) => (usize::MAX, 0),
                };
                match inner.state.runs.get_mut(k) {
                    Some(r) if r.status == RunStatus::Preparing && others < max => {
                        r.status = RunStatus::Starting;
                        r.last_started_at = Some(crate::disk::now_secs());
                        true
                    }
                    Some(r) if r.status == RunStatus::Preparing => {
                        r.status = RunStatus::Stopped;
                        r.note = Some(format!("dependencies were installed, but {} already has {max} runs up (max_running); start it again once one is stopped", spec.id.project));
                        false
                    }
                    _ => false,
                }
            };
            self.persist();
            if !admitted {
                bail!("{k} was not started after its install: it was stopped or {} is at max_running", spec.id.project);
            }
        }
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
                        r.note = Some("web port never opened; see `setu logs`".into());
                    }
                }
            });
            if !ready {
                let _ = me.stop(&k2, RunStatus::Crashed).await;
            }
        });
        Ok(())
    }

    /// Run the auto-install steps for `spec`'s worktree: at most `MAX_CONCURRENT_INSTALLS` at once
    /// daemon-wide (callers wait for a slot while their run shows as preparing). The output goes to
    /// the run's setup log; an error carries a redacted tail of it.
    async fn run_auto_install(self: &Arc<Self>, k: &str, spec: &RunSpec, steps: Vec<model::SetupStep>) -> Result<()> {
        // The proxy's Preparing page says "installing dependencies" while this runs.
        struct Installing(Arc<Daemon>, String);
        impl Drop for Installing {
            fn drop(&mut self) {
                self.0.lock().installing.remove(&self.1);
            }
        }
        self.lock().installing.insert(k.to_string());
        let _installing = Installing(Arc::clone(self), k.to_string());
        let _slot = self.install_slots.clone().acquire_owned().await.map_err(|_| anyhow!("the install queue is closed"))?;
        let (wt, env) = (spec.worktree.clone(), spec.env.clone());
        let log = paths::logs_dir().join(&spec.id.project).join(&spec.id.run).join("setup.log");
        let l2 = log.clone();
        let res = tokio::task::spawn_blocking(move || worktree::run_steps(&steps, &wt, &env, &l2)).await?;
        match res {
            Ok(_) => Ok(()),
            Err(e) => {
                let me = Arc::clone(self);
                let key = k.to_string();
                let tail = tokio::task::spawn_blocking(move || -> Option<String> {
                    let lines = tail_lines(&log, 8).ok()?;
                    // Redaction failing means the tail is withheld, never shown raw.
                    let secrets = me.redaction_set(&key).ok()?;
                    let text = redact(&lines.join("\n"), &secrets);
                    Some(text.chars().take(1500).collect())
                })
                .await
                .ok()
                .flatten();
                match tail {
                    Some(t) if !t.trim().is_empty() => Err(anyhow!("{e:#}\n--- setup log tail ---\n{t}")),
                    _ => Err(e),
                }
            }
        }
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
            let Some(r) = inner.state.runs.get(k) else { bail!("unknown run {k}") };
            // Nothing runs while preparing or after a failed setup, and Stopped would unlock starting.
            if matches!(r.status, RunStatus::Preparing | RunStatus::SetupFailed) {
                return Ok(());
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
        // A server Setu adopted but did not start is stopped only after its claim is proven again.
        let (ext, procs): (Vec<_>, Vec<_>) = procs.into_iter().partition(supervisor::is_external);
        let (ext_wt, ext_port) = self.lock().state.runs.get(k).map(|r| (r.spec.worktree.clone(), r.spec.web_port)).unwrap_or_default();
        let mut result = supervisor::stop_procs(&procs, STOP_GRACE).await;
        let mut ext_left: Vec<crate::model::ProcRecord> = Vec::new();
        let mut ext_note: Option<String> = None;
        for e in &ext {
            let Some(port) = ext_port else { continue };
            match supervisor::stop_external(e, &ext_wt, port, STOP_GRACE).await {
                Ok(true) => {}
                Ok(false) => ext_note = Some(format!("{} (pid {}, port {port}) no longer matches this worktree, so it was not signalled", e.name, e.pid)),
                Err(er) => {
                    ext_left.push(e.clone());
                    if result.is_ok() {
                        result = Err(er);
                    }
                }
            }
        }
        let id = self.lock().state.runs.get(k).map(|r| r.spec.id.clone());
        // The tracker is forgotten below; keep its last request time (auto-removal's idle age).
        let last_req = id.as_ref().and_then(|id| self.activity.last_request_unix(id));
        // A failed stop keeps ownership of whatever is still alive and does not claim "stopped" (review #9).
        let mut left = retained_after_stop(&procs, result.is_err(), &supervisor::unresolved);
        left.extend(ext_left);
        self.set(k, |r| {
            r.procs = left.clone();
            if let Some(n) = &ext_note {
                r.note = Some(n.clone());
            }
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
        // The leader just died under our eyes: the group is provably ours right now, so record who is in it.
        self.set(&k, |r| {
            if let Some(p) = r.procs.iter_mut().find(|p| p.pid == ev.pid) {
                supervisor::record_members_at_exit(p);
            }
        });
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

    /// Blocking. The unix second before which no log file and no live process can still hold a
    /// value that was superseded then: the oldest of every log's data floor (rotation retires the
    /// bytes) and the start of every run that still has processes.
    fn history_horizon(&self) -> u64 {
        fn walk(dir: &Path, h: &mut u64) {
            let Ok(rd) = std::fs::read_dir(dir) else { return };
            for e in rd.flatten() {
                let p = e.path();
                match e.file_type() {
                    Ok(t) if t.is_dir() => walk(&p, h),
                    Ok(t) if t.is_file() => *h = (*h).min(supervisor::log_data_floor(&p)),
                    _ => {}
                }
            }
        }
        let mut h = crate::db::now_secs();
        for r in self.lock().state.runs.values() {
            if !r.procs.is_empty() || matches!(r.status, RunStatus::Starting | RunStatus::Running | RunStatus::Stopping) {
                h = h.min(r.last_started_at.unwrap_or(0));
            }
        }
        walk(&paths::logs_dir(), &mut h);
        h
    }

    /// Retire redaction-history values that no existing log or live process can still hold.
    pub async fn prune_redaction_history(self: &Arc<Self>) {
        let me = Arc::clone(self);
        match tokio::task::spawn_blocking(move || env::prune_history(me.history_horizon())).await {
            Ok(Ok(_)) => {}
            Ok(Err(e)) => eprintln!("setu: pruning the redaction history failed: {e:#}"),
            Err(e) => eprintln!("setu: pruning the redaction history failed: {e}"),
        }
    }

    /// Every SWEEP_EVERY: idle stop, crash detection for adopted procs, log rotation.
    pub async fn sweep(self: &Arc<Self>) {
        self.record_request_times();
        // Runs whose own dev server is already up outside Setu show as running (external).
        let me = Arc::clone(self);
        let _ = tokio::task::spawn_blocking(move || me.detect_external_all()).await;
        let runs: Vec<(String, RunRecord)> = self.lock().state.runs.iter().map(|(k, r)| (k.clone(), r.clone())).collect();
        for (k, r) in runs {
            for p in &r.spec.procs {
                let _ = supervisor::rotate_log(&p.log_path, LOG_MAX_BYTES);
            }
            if r.status != RunStatus::Running {
                continue;
            }
            // An external server is never crash-stopped or idle-stopped by Setu; if it exits the run is simply stopped.
            if r.procs.iter().any(supervisor::is_external) {
                // The run lives while the listener's group (or bare listener) lives.
                let listener_alive = r.procs.iter().any(|p| p.name == supervisor::EXTERNAL_PROC && supervisor::external_alive(p));
                if !listener_alive {
                    // Remaining v1 sidecar groups are stopped with the same re-proof as Down.
                    let mut stuck = false;
                    for p in r.procs.iter().filter(|p| p.name == supervisor::EXTERNAL_SIDECAR) {
                        if supervisor::stop_external(p, &r.spec.worktree, r.spec.web_port.unwrap_or(0), STOP_GRACE).await.is_err() {
                            stuck = true;
                        }
                    }
                    if !stuck {
                        self.set(&k, |x| {
                            if x.status == RunStatus::Running && x.procs.iter().all(supervisor::is_external) {
                                x.status = RunStatus::Stopped;
                                x.procs.clear();
                                x.stopped_at = Some(crate::disk::now_secs());
                                x.note = Some("the server that was running outside Setu exited".into());
                            }
                        });
                    }
                }
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
        // Configs are read from disk first (never under the state lock): staleness is judged
        // against what a start would use now, and an invalid edit is reported, not hidden (review B9).
        let projects: std::collections::BTreeSet<String> = self.lock().state.runs.values().map(|r| r.spec.id.project.clone()).collect();
        let fresh: BTreeMap<String, Result<ProjectConfig, String>> = projects.into_iter().map(|p| (p.clone(), self.fresh_config(&p).map_err(|e| format!("{e:#}")))).collect();
        let inner = self.lock();
        let mut leases = inner.state.leases.clone();
        Value::Array(
            inner
                .state
                .runs
                .iter()
                .map(|(k, r)| {
                    // A running run whose env would differ if started now needs a restart.
                    let live = matches!(r.status, RunStatus::Running | RunStatus::Starting) && r.env_hash.is_some();
                    let (stale, config_error) = if !live {
                        (false, None)
                    } else {
                        match fresh.get(&r.spec.id.project) {
                            Some(Ok(cfg)) => match build_spec(cfg, &r.spec.worktree, &r.spec.id.run, &mut leases) {
                                Ok(spec) => (Some(env::env_hash(&spec.env)) != r.env_hash, None),
                                Err(e) => (true, Some(format!("{e:#}"))),
                            },
                            Some(Err(e)) => (true, Some(e.clone())),
                            None => (false, None),
                        }
                    };
                    let mut v = run_json(&self.db, k, r);
                    v["stale_env"] = json!(stale);
                    v["config_error"] = json!(config_error);
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
        let rec = self.lock().state.runs.get(&k).cloned().ok_or_else(|| anyhow!("unknown run {k}"))?;
        let cfg = self.fresh_config(&rec.spec.id.project)?;
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
                let secret = layers.iter().any(|(_, _, s)| s.contains(name)) || env::looks_secret(name, value);
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
            bail!("reveal is not available to agents; ask the user to run `setu env reveal` themselves");
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
        for v in env::read_layer(&env::Scope::Global).context("the global env layer could not be read, so logs cannot be redacted safely")?.into_iter().filter(|v| v.secret) {
            flagged.insert(v.name.clone());
            out.push((v.name, v.value));
        }
        // The same classification the effective view uses: flagged in a layer, or a secret-looking
        // name with a credential-length value. An explicitly flagged secret too short to redact is
        // an error, never silently left in the log (review B5).
        for (name, value) in &spec.env {
            if flagged.contains(name) || env::looks_secret(name, value) {
                out.push((name.clone(), value.clone()));
            }
        }
        for (name, value) in &out {
            env::check_redactable(name, value)?;
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
                    "{k} has a live writer claim held by {h}; only {h} can do this. Ask it to release, or run `setu release {k}` yourself"
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
        let registered: Arc<Mutex<Option<String>>> = Arc::default();
        let reg = registered.clone();
        let out = tokio::task::spawn_blocking(move || {
            worktree::create(&cfg, &b, f.as_deref(), &existing, &me.db, &paths::logs_dir(), |path, run| {
                let wt = path.canonicalize()?;
                // Registered as Preparing: no manual or on-demand start until setup succeeds (review B10).
                let initial = if cfg.setup_steps.is_empty() { RunStatus::Stopped } else { RunStatus::Preparing };
                let (k, spec, _) = me.register_seeded(&cfg, &wt, run, None, initial)?;
                *reg.lock().unwrap_or_else(|e| e.into_inner()) = Some(k);
                Ok(spec.env)
            })
        })
        .await?;
        let out = match out {
            Ok(o) => o,
            Err(e) => {
                // A run that was registered but never finished setup stays registered, as setup-failed.
                let preparing = registered.lock().unwrap_or_else(|e| e.into_inner()).clone();
                if let Some(pk) = preparing {
                    let note = format!("setup failed: {e:#}");
                    self.set(&pk, |r| {
                        r.status = RunStatus::SetupFailed;
                        r.note = Some(note);
                    });
                }
                worktree::audit(actor, client, "new-failed", &format!("{project}/{branch}"), json!({ "error": format!("{e:#}") }));
                return Err(e);
            }
        };
        let k = format!("{project}/{}", out.run);
        self.set(&k, |r| {
            if r.status == RunStatus::Preparing {
                r.status = RunStatus::Stopped;
                r.note = None;
            }
        });
        worktree::audit(actor, client, "new", &k, json!({ "branch": out.branch, "base": out.base, "path": out.path }));
        if start {
            self.start(&k).await?;
        }
        let mut v = self.describe_async(&k).await?;
        v["worktree_new"] = serde_json::to_value(&out)?;
        Ok(v)
    }

    /// `setu retry-setup`: re-run the setup steps of a run whose setup failed or was interrupted.
    /// The run stays un-startable until they succeed (review B10).
    pub async fn worktree_retry_setup(self: &Arc<Self>, actor: &str, client: Option<&str>, wanted: &str) -> Result<Value> {
        let k = self.resolve(wanted)?;
        let (project, run, wt) = {
            let mut inner = self.lock();
            let r = inner.state.runs.get_mut(&k).ok_or_else(|| anyhow!("unknown run {k}"))?;
            match r.status {
                RunStatus::SetupFailed => {}
                RunStatus::Preparing => bail!("setup of {k} is already running"),
                _ => bail!("{k} did not fail setup (it is {:?}); retry-setup only applies to a setup-failed run", r.status),
            }
            r.status = RunStatus::Preparing;
            r.note = None;
            (r.spec.id.project.clone(), r.spec.id.run.clone(), r.spec.worktree.clone())
        };
        self.persist();
        let me = Arc::clone(self);
        let (p2, r2, w2) = (project.clone(), run.clone(), wt.clone());
        let prep = tokio::task::spawn_blocking(move || -> Result<(ProjectConfig, RunSpec, deps::Need)> {
            let cfg = me.fresh_config(&p2)?;
            let mut leases = me.lock().state.leases.clone();
            let spec = build_spec(&cfg, &w2, &r2, &mut leases)?;
            let need = deps::plan(&cfg, &w2);
            Ok((cfg, spec, need))
        })
        .await?;
        let res: Result<usize> = match prep {
            Err(e) => Err(e),
            Ok((cfg, spec, need)) => match need {
                deps::Need::Blocked(why) => Err(anyhow!("{why}")),
                deps::Need::Install(steps) => {
                    let n = steps.len();
                    self.run_auto_install(&k, &spec, steps).await.map(|_| n)
                }
                deps::Need::Nothing => {
                    let log = paths::logs_dir().join(&spec.id.project).join(&spec.id.run).join("setup.log");
                    let (steps, w) = (cfg.setup_steps.clone(), spec.worktree.clone());
                    let env = spec.env.clone();
                    tokio::task::spawn_blocking(move || worktree::run_steps(&steps, &w, &env, &log).map(|r| r.len())).await?
                }
            },
        };
        match res {
            Ok(steps) => {
                self.set(&k, |r| {
                    r.status = RunStatus::Stopped;
                    r.note = None;
                });
                worktree::audit(actor, client, "setup-retried", &k, json!({ "steps": steps }));
                self.describe_async(&k).await
            }
            Err(e) => {
                let note = format!("setup failed: {e:#}");
                self.set(&k, |r| {
                    r.status = RunStatus::SetupFailed;
                    r.note = Some(note);
                });
                worktree::audit(actor, client, "setup-retry-failed", &k, json!({ "error": format!("{e:#}") }));
                Err(e)
            }
        }
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

    /// `setu forget`: unregister a run and release its lease. The worktree's files are never touched.
    /// Refused while the run is up (or mid-setup/stop), has recorded processes, or has a live claim.
    pub async fn worktree_forget(self: &Arc<Self>, actor: &str, client: Option<&str>, wanted: &str) -> Result<Value> {
        let k = self.resolve(wanted)?;
        let life = self.life_lock(&k);
        let _life = life.lock().await;
        let (id, wt) = {
            let mut inner = self.lock();
            let r = inner.state.runs.get(&k).ok_or_else(|| anyhow!("unknown run {k}"))?;
            if matches!(r.status, RunStatus::Running | RunStatus::Starting | RunStatus::Stopping | RunStatus::Preparing) {
                bail!("{k} is {}; stop it first (`setu down {k}`), then forget it", format!("{:?}", r.status).to_lowercase());
            }
            if !r.procs.is_empty() {
                bail!("{k} still has recorded processes; run `setu down {k}` first");
            }
            if let Some(h) = claims::live_holder(&self.db, &k, claims::now()) {
                bail!("{k} has a live writer claim held by {h}; release it first (`setu release {k}`)");
            }
            let removed = inner.state.runs.remove(&k).ok_or_else(|| anyhow!("unknown run {k}"))?;
            inner.state.leases.remove(&k);
            inner.gens.remove(&k);
            inner.rebuild_hosts();
            (removed.spec.id, removed.spec.worktree)
        };
        self.activity.forget(&id);
        self.persist_durable().await?;
        worktree::audit(actor, client, "forget", &k, json!({ "path": wt }));
        Ok(json!({ "run": k, "forgotten": true, "worktree": wt }))
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
            // Squash- and rebase-merged branches look unpushed once the remote branch is deleted;
            // a validated merge proof (re-checked at each guard) is the only way past that guard (review B8).
            let proof = |wt: &Path, fetched: bool, head: Option<&str>| autoremove::rm_proof(&cfg, wt, fetched, head, &autoremove::real_gh);
            worktree::rm(&worktree::RmCtx { project: &project, run: &run, worktree: &wt, repo: &cfg.repo, declared: &declared, archive_root: &archive_root, db: &db, force, host: &host, archive_cap: None, merge_proof: Some(&proof) })
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
            bail!("auto_remove is off. Set `enabled = true` under [auto_remove] in {}, or preview with `setu autoremove --dry-run`", globalcfg::config_path().display());
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

    /// A run whose processes are all servers Setu took over rather than started.
    pub fn is_external_run(&self, k: &str) -> bool {
        self.lock().state.runs.get(k).is_some_and(|r| !r.procs.is_empty() && r.procs.iter().all(supervisor::is_external))
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
        "aliases": r.spec.aliases,
        "external": r.procs.iter().any(supervisor::is_external),
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
            (RunStatus::Preparing, _) => Lookup::Preparing { installing: inner.installing.contains(k.as_str()), run },
            (RunStatus::SetupFailed, _) => Lookup::SetupFailed { run },
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
            match r.status {
                RunStatus::Preparing => return Err(format!("{k} is still being prepared (setup is running)")),
                RunStatus::SetupFailed => return Err(format!("setup failed for {k}; run `setu retry-setup {k}`")),
                _ => {}
            }
            if !matches!(r.status, RunStatus::Running | RunStatus::Starting) {
                let cfg = inner.config(&run.project).map_err(|e| e.to_string())?;
                if inner.up_count(&run.project) >= cfg.max_running {
                    return Err(format!(
                        "{} already has {} runs up. Stop one with `setu down <run>` first.",
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
            Some(st @ (RunStatus::Running | RunStatus::Starting | RunStatus::Stopping | RunStatus::Preparing)) => Some(format!("{st:?}").to_lowercase()),
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
    let list: Vec<String> = configs.iter().map(|c| c.domain.to_lowercase()).filter(|d| !d.ends_with("localhost")).collect::<std::collections::BTreeSet<_>>().into_iter().collect();
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
        bail!("another setu daemon is already running");
    }
    Ok(f)
}

/// Who listens on a TCP port, for the log line and doctor: "caddy (pid 123)". Best effort.
pub fn port_holder(port: u16) -> Option<String> {
    let out = std::process::Command::new("lsof").args(["-nP", &format!("-iTCP:{port}"), "-sTCP:LISTEN", "-Fpc"]).output().ok()?;
    let text = String::from_utf8_lossy(&out.stdout);
    let (mut pid, mut name) = (None, None);
    for l in text.lines() {
        if let Some(p) = l.strip_prefix('p') {
            pid.get_or_insert(p.to_string());
        } else if let Some(c) = l.strip_prefix('c') {
            name.get_or_insert(c.to_string());
        }
    }
    Some(match (name, pid) {
        (Some(n), Some(p)) => format!("{n} (pid {p})"),
        (None, Some(p)) => format!("pid {p}"),
        _ => return None,
    })
}

/// Bind the proxy. Config `proxy_port` wins and must succeed. Otherwise try the wildcard :80
/// (IPv4 and IPv6 sockets, so both work as with v1's Caddy; loopback-only peers
/// are enforced by the proxy) and fall back to loopback :7777 on both 127.0.0.1 and ::1.
async fn bind_proxy() -> Result<(Vec<tokio::net::TcpListener>, &'static str, u16, globalcfg::ProxyBinding)> {
    if let Some(p) = globalcfg::GlobalConfig::load().ok().and_then(|c| c.proxy_port) {
        let (ls, ip) = if p < 1024 {
            (crate::proxy::bind_wildcard(p).with_context(|| format!("binding the proxy on port {p}"))?, "*")
        } else {
            (crate::proxy::bind_loopback(p).with_context(|| format!("binding the proxy on 127.0.0.1:{p}"))?, "127.0.0.1")
        };
        return Ok((ls, ip, p, globalcfg::ProxyBinding { port: p, fallback_reason: None }));
    }
    let want = globalcfg::DEFAULT_PROXY_PORT;
    match crate::proxy::bind_wildcard(want) {
        Ok(ls) => Ok((ls, "*", want, globalcfg::ProxyBinding { port: want, fallback_reason: None })),
        Err(e) => {
            let why = match port_holder(want) {
                Some(h) => format!("port {want} is held by {h}"),
                None => format!("port {want} is not available ({e})"),
            };
            let fb = globalcfg::FALLBACK_PROXY_PORT;
            eprintln!("setu daemon: {why}; serving the proxy on 127.0.0.1:{fb} instead. Free port {want} and restart the daemon to use it.");
            let ls = crate::proxy::bind_loopback(fb).with_context(|| format!("{why}, and the fallback 127.0.0.1:{fb} failed"))?;
            Ok((ls, "127.0.0.1", fb, globalcfg::ProxyBinding { port: fb, fallback_reason: Some(why) }))
        }
    }
}

/// Run the daemon until SIGINT/SIGTERM. Stops every run it started on the way out.
pub async fn run() -> Result<()> {
    // One daemon only: hold an exclusive lock for our lifetime, before touching state.
    let _lock = single_instance_lock()?;
    let (listeners, bind_ip, proxy_port, binding) = bind_proxy().await?;
    globalcfg::set_effective_proxy_port(proxy_port);
    if let Ok(text) = serde_json::to_string(&binding) {
        let _ = std::fs::write(globalcfg::proxy_binding_path(), text);
    }
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<ExitEvent>();
    let daemon = tokio::task::spawn_blocking(move || Daemon::new(tx)).await??;
    let _ = SELF.set(Arc::clone(&daemon));
    daemon.adopt().await;
    let routes: Arc<dyn Routes> = daemon.clone();
    let activity = daemon.activity.clone();
    tokio::spawn(async move {
        if let Err(e) = crate::proxy::serve_all(listeners, routes, activity).await {
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
    eprintln!("setu daemon: proxy on http://{bind_ip}:{proxy_port}, socket {}", paths::socket_path().display());

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
                daemon.prune_redaction_history().await;
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
    if globalcfg::GlobalConfig::load().is_ok_and(|c| c.stop_runs_on_exit) {
        eprintln!("setu daemon: stopping Setu-started runs (stop_runs_on_exit)");
        for k in daemon.running_keys() {
            if daemon.is_external_run(&k) {
                continue;
            }
            let _ = daemon.stop(&k, RunStatus::Stopped).await;
        }
    } else {
        eprintln!("setu daemon: exiting; running dev servers stay up and are adopted by the next daemon");
    }
    // Fold the WAL into the main file so the next start opens a small, clean database.
    if let Err(e) = daemon.db.with_async(|c| c.query("PRAGMA wal_checkpoint(TRUNCATE)", (), |_| Ok(())).map(|_| ())).await {
        eprintln!("setu: final checkpoint failed: {e:#}");
    }
    let _ = std::fs::remove_file(globalcfg::proxy_binding_path());
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

    /// Is a process matching `pattern` still alive after giving it up to 5 seconds to go away?
    /// A fixed short sleep is a flake under load.
    async fn still_running(pattern: &str) -> bool {
        for _ in 0..100 {
            if !pgrep(pattern) {
                return false;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        true
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
        let leaked = still_running("sleep 300701").await;
        pkill("sleep 300701");
        assert!(!leaked, "processes spawned by a cancelled start are still running");
        assert_eq!(recorded(&f), 0);
        assert_eq!(status(&f), RunStatus::Stopped);
    }

    #[tokio::test(flavor = "current_thread")]
    async fn a_sidecar_leader_exit_keeps_its_surviving_group_owned() {
        // review #8
        // The leader lives a second, so under load neither the start-time read nor the child's
        // fork/exec races its exit (the other flaky failure of the suite).
        let mut f = fixture(&[("w".to_string(), "sleep 300702 & sleep 1; exit 0".to_string())], "");
        f.d.start(&f.k).await.unwrap();
        let ev = tokio::time::timeout(Duration::from_secs(5), f.rx.recv()).await.unwrap().unwrap();
        f.d.on_exit(ev).await;
        assert!(pgrep("sleep 300702"), "the backgrounded child should still run");
        assert_eq!(recorded(&f), 1, "the record stays while its group survives");
        f.d.stop(&f.k, RunStatus::Stopped).await.unwrap();
        let left = still_running("sleep 300702").await;
        pkill("sleep 300702");
        assert!(!left, "stop must reach the surviving group");
        assert_eq!(recorded(&f), 0);
    }

    #[test]
    fn a_failed_stop_keeps_what_is_still_alive() {
        // review #9
        let rec = |pid| crate::model::ProcRecord { name: "w".into(), pid, start_time: 1, escaped: vec![], members: vec![] };
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
        let rec = crate::model::ProcRecord { name: "w".into(), pid, start_time: crate::procinfo::start_time(pid).unwrap(), escaped: vec![], members: vec![] };
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
        let leaked = still_running("sleep 300704").await;
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
        cfg.disk_items = vec![DiskItem { name: "next".into(), kind: DiskKind::Cache, paths: vec![".next".into()], clean_after: Some(Duration::from_secs(1)), install: None }];
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
            aliases: vec![],
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

    #[tokio::test(flavor = "current_thread")]
    async fn b5_short_config_secret_is_redacted_like_the_effective_view_classifies_it() {
        let f = fixture(&[("w".to_string(), "exec sleep 300711".to_string())], "[env]\nAPI_TOKEN = \"12345\"\n");
        let log_dir = paths::logs_dir().join("tp/r");
        std::fs::create_dir_all(&log_dir).unwrap();
        std::fs::write(log_dir.join("w.log"), "token=12345\nport 8080 is fine\n").unwrap();
        let eff = f.d.env_effective("r").unwrap();
        let tok = eff["vars"].as_array().unwrap().iter().find(|v| v["name"] == "API_TOKEN").unwrap();
        assert_eq!(tok["secret"], true);
        let out = f.d.logs(&f.k, None, 50).unwrap();
        let text = out["text"].as_str().unwrap();
        assert!(!text.contains("12345") || text.contains("port 8080"), "{text}");
        assert!(text.contains("token=[redacted:API_TOKEN]"), "{text}");
        assert!(text.contains("port 8080 is fine"), "{text}");
    }

    #[tokio::test(flavor = "current_thread")]
    async fn b5_history_is_not_capped_by_count_while_a_log_can_still_hold_the_value() {
        let f = fixture(&[("w".to_string(), "exec sleep 300712".to_string())], "");
        let log_dir = paths::logs_dir().join("tp/r");
        std::fs::create_dir_all(&log_dir).unwrap();
        std::fs::write(log_dir.join("w.log"), "old=OLDEST-ROTATED-SECRET\n").unwrap();
        let sc = env::Scope::Project("tp".into());
        for i in 0..502 {
            env::write_var(&sc, "DB_PASSWORD", &format!("rotated-{i:04}-value"), None).unwrap();
        }
        env::write_var(&sc, "OTHER_SECRET", "OLDEST-ROTATED-SECRET", None).unwrap();
        env::write_var(&sc, "OTHER_SECRET", "something-else-now", None).unwrap();
        assert!(env::redaction_history().unwrap().len() >= 502);
        let text = f.d.logs(&f.k, None, 50).unwrap()["text"].as_str().unwrap().to_string();
        assert!(!text.contains("OLDEST-ROTATED-SECRET"), "{text}");
        // once no log or process can hold them, rotation retires them
        std::fs::remove_dir_all(&log_dir).unwrap();
        let h = f.d.history_horizon();
        assert!(h > 0);
        env::prune_history(h + 1).unwrap();
        assert!(env::redaction_history().unwrap().is_empty());
    }

    #[tokio::test(flavor = "current_thread")]
    async fn b5_damaged_history_fails_log_delivery() {
        let f = fixture(&[("w".to_string(), "exec sleep 300713".to_string())], "");
        let log_dir = paths::logs_dir().join("tp/r");
        std::fs::create_dir_all(&log_dir).unwrap();
        std::fs::write(log_dir.join("w.log"), "hello\n").unwrap();
        env::write_var(&env::Scope::Project("tp".into()), "DB_PASSWORD", "rotated-one-value", None).unwrap();
        env::write_var(&env::Scope::Project("tp".into()), "DB_PASSWORD", "rotated-two-value", None).unwrap();
        let hp = paths::env_dir().join(".redact-history.jsonl");
        let mut text = std::fs::read_to_string(&hp).unwrap();
        text.push_str("{this line is damaged CANARY-HISTORY\n");
        std::fs::write(&hp, text).unwrap();
        let e = format!("{:#}", f.d.logs(&f.k, None, 50).unwrap_err());
        assert!(e.contains("damaged") && !e.contains("CANARY"), "{e}");
    }

    #[tokio::test(flavor = "current_thread")]
    async fn b5_an_edited_config_secret_is_journaled_for_redaction() {
        let f = fixture(&[("w".to_string(), "exec sleep 300714".to_string())], "[env]\nAPI_TOKEN = \"first-config-token\"\n");
        let p = paths::projects_dir().join("tp.toml");
        let t = std::fs::read_to_string(&p).unwrap().replace("first-config-token", "second-config-token");
        std::fs::write(&p, t).unwrap();
        f.d.env_effective("r").unwrap();
        assert!(env::redaction_history().unwrap().iter().any(|(n, v)| n == "API_TOKEN" && v == "first-config-token"));
    }

    #[tokio::test(flavor = "current_thread")]
    async fn b9_restart_effective_and_stale_env_use_the_config_on_disk() {
        let f = fixture(&[("w".to_string(), "exec sleep 300715".to_string())], "[env]\nA = \"old\"\n");
        let p = paths::projects_dir().join("tp.toml");
        let edit = |from: &str, to: &str| {
            let t = std::fs::read_to_string(&p).unwrap().replace(from, to);
            std::fs::write(&p, t).unwrap();
        };
        let val = |f: &Fx| -> String {
            let eff = f.d.env_effective("r").unwrap();
            eff["vars"].as_array().unwrap().iter().find(|v| v["name"] == "A").unwrap()["preview"].as_str().unwrap().to_string()
        };
        assert_eq!(val(&f), "old");
        edit("\"old\"", "\"newer\"");
        assert_eq!(val(&f), "newer", "effective must read the edited config");
        f.d.start(&f.k).await.unwrap();
        assert_eq!(f.d.lock().state.runs[&f.k].spec.env["A"], "newer");
        let stale = |f: &Fx| f.d.list()[0].clone();
        assert_eq!(stale(&f)["stale_env"], false);
        edit("\"newer\"", "\"newest\"");
        assert_eq!(stale(&f)["stale_env"], true, "a config edit needs a restart");
        // restart picks it up
        f.d.stop(&f.k, RunStatus::Stopped).await.unwrap();
        f.d.start(&f.k).await.unwrap();
        assert_eq!(f.d.lock().state.runs[&f.k].spec.env["A"], "newest");
        // an invalid edit is an error everywhere, never a silent fallback
        edit("domain = \"tp.local\"", "domain = \"tp local\"");
        assert!(f.d.env_effective("r").is_err());
        let row = stale(&f);
        assert_eq!(row["stale_env"], true);
        assert!(row["config_error"].as_str().is_some_and(|e| e.contains("domain")), "{row}");
        f.d.stop(&f.k, RunStatus::Stopped).await.unwrap();
        assert!(f.d.start(&f.k).await.is_err());
    }

    #[tokio::test(flavor = "current_thread")]
    async fn b11_adoption_turns_an_empty_transitional_record_into_a_persisted_stopped_state() {
        for status in [RunStatus::Starting, RunStatus::Stopping, RunStatus::Running] {
            let f = fixture(&[("w".to_string(), "exec sleep 300716".to_string())], "");
            f.d.set(&f.k, |r| {
                r.status = status;
                r.procs.clear();
            });
            f.d.adopt().await;
            assert_eq!(super::tests::status(&f), RunStatus::Stopped, "{status:?}");
            assert!(f.d.lock().state.runs[&f.k].note.as_deref().is_some_and(|n| n.contains("daemon restarted")));
            let disk = crate::state::load(&f.d.db).unwrap();
            assert_eq!(disk.runs[&f.k].status, RunStatus::Stopped, "reconciliation must be on disk when adopt returns");
            // and a start now works instead of reporting the stale Starting
            f.d.start(&f.k).await.unwrap();
            f.d.stop(&f.k, RunStatus::Stopped).await.unwrap();
        }
    }

    #[tokio::test(flavor = "current_thread")]
    async fn forget_unregisters_a_stopped_run_keeps_its_files_and_is_refused_while_running_or_claimed() {
        let f = fixture(&[("w".to_string(), "exec sleep 300790".to_string())], "");
        std::fs::write(f.wt.join("keep.txt"), "mine").unwrap();
        // running: refused
        f.d.start(&f.k).await.unwrap();
        let e = f.d.worktree_forget("cli", None, &f.k).await.unwrap_err();
        assert!(format!("{e:#}").contains("stop it first"), "{e:#}");
        f.d.stop(&f.k, RunStatus::Stopped).await.unwrap();
        // claimed: refused
        f.d.claim("cli", None, &f.k, "alice", None).unwrap();
        let e = f.d.worktree_forget("cli", None, &f.k).await.unwrap_err();
        assert!(format!("{e:#}").contains("live writer claim"), "{e:#}");
        assert!(f.d.lock().state.runs.contains_key(&f.k), "a refused forget changes nothing");
        f.d.release("cli", None, &f.k, None).unwrap();
        // stopped and unclaimed: forgotten, files untouched, lease released, event written
        let host = f.d.lock().state.runs[&f.k].spec.host.clone();
        f.d.worktree_forget("cli", None, &f.k).await.unwrap();
        assert!(!f.d.lock().state.runs.contains_key(&f.k));
        assert!(!f.d.lock().state.leases.contains_key(&f.k));
        assert!(matches!(f.d.lookup(&host), Lookup::Unknown));
        assert_eq!(std::fs::read_to_string(f.wt.join("keep.txt")).unwrap(), "mine");
        let disk = crate::state::load(&f.d.db).unwrap();
        assert!(!disk.runs.contains_key(&f.k) && !disk.leases.contains_key(&f.k));
        let ev = f.d.events(Some("worktree"), Some(&f.k), None, 50).unwrap();
        assert!(ev.to_string().contains("forget"), "{ev}");
        assert!(f.d.worktree_forget("cli", None, &f.k).await.is_err(), "unknown after forgetting");
    }

    // ---- auto-install of missing dependencies ----

    /// Puts a fake `bun` first on PATH for the test and restores PATH afterwards.
    struct FakeBun {
        old: Option<std::ffi::OsString>,
        log: PathBuf,
    }
    impl Drop for FakeBun {
        fn drop(&mut self) {
            match &self.old {
                Some(o) => std::env::set_var("PATH", o),
                None => std::env::remove_var("PATH"),
            }
        }
    }
    /// `body` is the shell body of the shim; `$LOG` is its argv log. Every call appends its argv to the log.
    fn fake_bun(dir: &Path, body: &str) -> FakeBun {
        use std::os::unix::fs::PermissionsExt;
        let bin = dir.join("shim-bin");
        std::fs::create_dir_all(&bin).unwrap();
        let log = dir.join("bun-argv.log");
        let script = format!("#!/bin/sh\nLOG='{}'\necho \"$@\" >> \"$LOG\"\n{body}\n", log.display());
        std::fs::write(bin.join("bun"), script).unwrap();
        std::fs::set_permissions(bin.join("bun"), std::fs::Permissions::from_mode(0o755)).unwrap();
        let old = std::env::var_os("PATH");
        let mut p = std::ffi::OsString::from(bin.as_os_str());
        p.push(":");
        p.push(old.clone().unwrap_or_default());
        std::env::set_var("PATH", p);
        FakeBun { old, log }
    }

    /// The daemon behind the real proxy, with on-demand start wired like `request_start` (which needs the global daemon).
    struct Demand(Arc<Daemon>);
    impl Routes for Demand {
        fn lookup(&self, host: &str) -> Lookup {
            Routes::lookup(&*self.0, host)
        }
        fn request_start(&self, run: &RunId) -> std::result::Result<(), String> {
            let (d, k) = (self.0.clone(), key(run));
            tokio::spawn(async move {
                let _ = d.start(&k).await;
            });
            Ok(())
        }
    }

    async fn demand_proxy(d: &Arc<Daemon>) -> u16 {
        let l = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = l.local_addr().unwrap().port();
        tokio::spawn(crate::proxy::serve(l, Arc::new(Demand(d.clone())), d.activity.clone()));
        port
    }

    async fn html_get(port: u16, host: &str) -> String {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let mut s = tokio::net::TcpStream::connect(("127.0.0.1", port)).await.unwrap();
        s.write_all(format!("GET / HTTP/1.1\r\nHost: {host}\r\nAccept: text/html\r\nConnection: close\r\n\r\n").as_bytes()).await.unwrap();
        let mut out = Vec::new();
        s.read_to_end(&mut out).await.unwrap();
        String::from_utf8_lossy(&out).into_owned()
    }

    fn bun_worktree(wt: &Path, lock: bool) {
        std::fs::create_dir_all(wt).unwrap();
        std::fs::write(wt.join("package.json"), "{}").unwrap();
        if lock {
            std::fs::write(wt.join("bun.lock"), "").unwrap();
        }
    }

    const BUN_EXTRA: &str = "preset = \"node-bun\"\nmax_running = 10\n";

    #[tokio::test(flavor = "current_thread")]
    async fn a_start_with_missing_node_modules_installs_once_serves_the_preparing_page_then_runs() {
        let f = fixture(&[("w".to_string(), "exec sleep 300801".to_string())], BUN_EXTRA);
        bun_worktree(&f.wt, true);
        let bun = fake_bun(&f._sb.dir, "sleep 1\nmkdir -p node_modules/dep");
        let host = f.d.lock().state.runs[&f.k].spec.host.clone();
        let port = demand_proxy(&f.d).await;
        // the first hit starts the run on demand; keep hitting while it installs
        let mut pages = Vec::new();
        for _ in 0..400 {
            pages.push(html_get(port, &host).await);
            if status(&f) == RunStatus::Running {
                break;
            }
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
        assert_eq!(status(&f), RunStatus::Running, "note: {:?}", f.d.lock().state.runs[&f.k].note);
        assert!(pages.iter().any(|p| p.starts_with("HTTP/1.1 503") && p.contains("Installing dependencies for tp/r")), "the installing page was served in between");
        assert!(f.wt.join("node_modules/dep").is_dir());
        assert_eq!(std::fs::read_to_string(&bun.log).unwrap().trim(), "install --frozen-lockfile", "one install, frozen");
        // deps are there now: a restart does not install again
        f.d.stop(&f.k, RunStatus::Stopped).await.unwrap();
        f.d.start(&f.k).await.unwrap();
        assert_eq!(std::fs::read_to_string(&bun.log).unwrap().lines().count(), 1);
        f.d.stop(&f.k, RunStatus::Stopped).await.unwrap();
    }

    #[tokio::test(flavor = "current_thread")]
    async fn six_concurrent_on_demand_hits_run_at_most_two_installs_at_once() {
        let f = fixture(&[("w".to_string(), "exec sleep 300802".to_string())], BUN_EXTRA);
        let cfg = config::load_all().unwrap().remove(0);
        let mut keys = vec![f.k.clone()];
        bun_worktree(&f.wt, true);
        for i in 1..6 {
            let wt = f._sb.dir.join(format!("wt/r{i}"));
            bun_worktree(&wt, true);
            keys.push(f.d.register(&cfg, &wt, &format!("r{i}")).unwrap().0);
        }
        let active = f._sb.dir.join("active");
        std::fs::create_dir_all(&active).unwrap();
        let seen = f._sb.dir.join("seen");
        let body = format!("A='{}'\ntouch \"$A/$$\"\nls \"$A\" | wc -l >> '{}'\nsleep 0.5\nmkdir -p node_modules/dep\nrm -f \"$A/$$\"", active.display(), seen.display());
        let bun = fake_bun(&f._sb.dir, &body);
        let port = demand_proxy(&f.d).await;
        let hosts: Vec<String> = keys.iter().map(|k| f.d.lock().state.runs[k].spec.host.clone()).collect();
        let hits: Vec<_> = hosts.iter().cloned().map(|h| tokio::spawn(async move { html_get(port, &h).await })).collect();
        for h in hits {
            h.await.unwrap();
        }
        for _ in 0..600 {
            if keys.iter().all(|k| f.d.lock().state.runs[k].status == RunStatus::Running) {
                break;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        let statuses: Vec<_> = keys.iter().map(|k| f.d.lock().state.runs[k].status).collect();
        assert!(statuses.iter().all(|s| *s == RunStatus::Running), "{statuses:?}");
        assert_eq!(std::fs::read_to_string(&bun.log).unwrap().lines().count(), 6, "each worktree installed once");
        let max = std::fs::read_to_string(&seen).unwrap().lines().filter_map(|l| l.trim().parse::<usize>().ok()).max().unwrap();
        assert_eq!(max, 2, "never more than 2 at once, and the cap was actually used");
        for k in &keys {
            f.d.stop(k, RunStatus::Stopped).await.unwrap();
        }
    }

    #[tokio::test(flavor = "current_thread")]
    async fn a_failed_install_is_setup_failed_with_the_log_tail_and_retry_setup_finishes_it() {
        let f = fixture(&[("w".to_string(), "exec sleep 300803".to_string())], BUN_EXTRA);
        bun_worktree(&f.wt, true);
        let flag = f._sb.dir.join("fail-flag");
        std::fs::write(&flag, "x").unwrap();
        let bun = fake_bun(&f._sb.dir, &format!("if [ -f '{}' ]; then echo 'error: registry unreachable (boom)'; exit 1; fi\nmkdir -p node_modules/dep", flag.display()));
        let e = f.d.start(&f.k).await.unwrap_err();
        assert!(format!("{e:#}").contains("retry-setup"), "{e:#}");
        let rec = f.d.lock().state.runs[&f.k].clone();
        assert_eq!(rec.status, RunStatus::SetupFailed);
        assert!(rec.note.as_deref().is_some_and(|n| n.contains("registry unreachable (boom)")), "log tail in the note: {:?}", rec.note);
        assert!(rec.procs.is_empty(), "nothing started");
        let host = rec.spec.host.clone();
        assert!(matches!(f.d.lookup(&host), Lookup::SetupFailed { .. }));
        assert!(f.d.worktree_retry_setup("cli", None, &f.k).await.is_err(), "still failing");
        std::fs::remove_file(&flag).unwrap();
        f.d.worktree_retry_setup("cli", None, &f.k).await.unwrap();
        assert_eq!(status(&f), RunStatus::Stopped);
        assert!(f.wt.join("node_modules/dep").is_dir());
        f.d.start(&f.k).await.unwrap();
        assert_eq!(std::fs::read_to_string(&bun.log).unwrap().lines().count(), 3, "fail, fail, then one good install; the start after retry installs nothing");
        f.d.stop(&f.k, RunStatus::Stopped).await.unwrap();
    }

    #[tokio::test(flavor = "current_thread")]
    async fn missing_deps_without_a_lockfile_fail_clearly_and_never_install_unfrozen() {
        let f = fixture(&[("w".to_string(), "exec sleep 300804".to_string())], BUN_EXTRA);
        bun_worktree(&f.wt, false);
        let bun = fake_bun(&f._sb.dir, "mkdir -p node_modules/dep");
        assert!(f.d.start(&f.k).await.is_err());
        let rec = f.d.lock().state.runs[&f.k].clone();
        assert_eq!(rec.status, RunStatus::SetupFailed);
        assert!(rec.note.as_deref().is_some_and(|n| n.contains("no lockfile") && n.contains("bun.lock")), "{:?}", rec.note);
        assert!(!bun.log.exists(), "no unfrozen install was attempted");
    }

    #[tokio::test(flavor = "current_thread")]
    async fn auto_install_false_opts_out_and_starts_without_installing() {
        let f = fixture(&[("w".to_string(), "exec sleep 300805".to_string())], &format!("{BUN_EXTRA}auto_install = false\n"));
        bun_worktree(&f.wt, true);
        let bun = fake_bun(&f._sb.dir, "mkdir -p node_modules/dep");
        f.d.start(&f.k).await.unwrap();
        assert!(!bun.log.exists() && !f.wt.join("node_modules").exists());
        f.d.stop(&f.k, RunStatus::Stopped).await.unwrap();
    }

    #[tokio::test(flavor = "current_thread")]
    async fn b10_a_new_run_cannot_start_until_setup_succeeds_and_setup_can_be_retried() {
        let sb = sandbox();
        let wf = crate::worktree::tests::fx("b10");
        let (go, fail) = (sb.dir.join("go"), sb.dir.join("fail"));
        let toml = format!(
            "project = \"app\"\nrepo = '{}'\ndomain = \"app.local\"\n[worktree]\nmin_free = \"0\"\n[[setup.step]]\nname = \"slow\"\nrun = 'i=0; while [ ! -f {} ] && [ $i -lt 400 ]; do sleep 0.05; i=$((i+1)); done; [ ! -f {} ]'\n",
            wf.repo.display(),
            go.display(),
            fail.display()
        );
        std::fs::create_dir_all(paths::projects_dir()).unwrap();
        std::fs::write(paths::projects_dir().join("app.toml"), toml).unwrap();
        let (tx, _rx) = tokio::sync::mpsc::unbounded_channel();
        let d = Daemon::new(tx).unwrap();
        let creator = {
            let d = d.clone();
            tokio::spawn(async move { d.worktree_new("cli", None, "app", "feat/b10", None, false).await })
        };
        let k = "app/feat-b10".to_string();
        for _ in 0..400 {
            if d.lock().state.runs.contains_key(&k) {
                break;
            }
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
        assert_eq!(d.lock().state.runs[&k].status, RunStatus::Preparing, "registered as preparing, not stopped");
        // manual start, on-demand start and the proxy lookup all see the preparing state
        let e = d.start(&k).await.unwrap_err();
        assert!(e.to_string().contains("being prepared"), "{e:#}");
        let host = d.lock().state.runs[&k].spec.host.clone();
        assert!(matches!(d.lookup(&host), Lookup::Preparing { .. }));
        assert!(d.request_start(&RunId { project: "app".into(), run: "feat-b10".into() }).is_err());
        // down must not unlock it either
        d.stop(&k, RunStatus::Stopped).await.unwrap();
        assert_eq!(d.lock().state.runs[&k].status, RunStatus::Preparing);
        // setup fails: the run stays registered, setup-failed, and cannot start
        std::fs::write(&fail, "x").unwrap();
        std::fs::write(&go, "x").unwrap();
        assert!(creator.await.unwrap().is_err());
        let rec = d.lock().state.runs[&k].clone();
        assert_eq!(rec.status, RunStatus::SetupFailed);
        assert!(rec.note.as_deref().is_some_and(|n| n.contains("setup")), "{:?}", rec.note);
        assert!(matches!(d.lookup(&host), Lookup::SetupFailed { .. }));
        let e = d.start(&k).await.unwrap_err();
        assert!(format!("{e:#}").contains("retry-setup"), "{e:#}");
        assert!(d.worktree_retry_setup("cli", None, &k).await.is_err(), "still failing");
        assert_eq!(d.lock().state.runs[&k].status, RunStatus::SetupFailed);
        // fixed: retry succeeds, the run becomes startable
        std::fs::remove_file(&fail).unwrap();
        d.worktree_retry_setup("cli", None, &k).await.unwrap();
        assert_eq!(d.lock().state.runs[&k].status, RunStatus::Stopped);
        d.start(&k).await.unwrap();
        d.stop(&k, RunStatus::Stopped).await.unwrap();
        // an interrupted setup (daemon died) is reconciled to setup-failed on adoption
        d.set(&k, |r| r.status = RunStatus::Preparing);
        d.adopt().await;
        assert_eq!(d.lock().state.runs[&k].status, RunStatus::SetupFailed);
        assert_eq!(crate::state::load(&d.db).unwrap().runs[&k].status, RunStatus::SetupFailed);
    }

    #[tokio::test(flavor = "current_thread")]
    async fn aliases_route_to_the_main_run_and_are_collision_checked() {
        let f = fixture(&[("w".to_string(), "exec sleep 300717".to_string())], "aliases = [\"Old.Name.tp.local\"]\n");
        // the fixture's run is `r`, not `main`: aliases belong to main only
        assert!(f.d.lock().state.runs[&f.k].spec.aliases.is_empty());
        assert!(matches!(f.d.lookup("old.name.tp.local"), Lookup::Unknown));
        let cfg = config::load_all().unwrap().remove(0);
        assert_eq!(cfg.aliases, vec!["old.name.tp.local".to_string()], "lowercased");
        let (km, spec) = f.d.register(&cfg, &f._sb.dir.join("wt/main"), "main").unwrap();
        assert_eq!(spec.aliases, vec!["old.name.tp.local".to_string()]);
        assert!(matches!(f.d.lookup("old.name.tp.local"), Lookup::Down { run } if run.run == "main"));
        assert!(matches!(f.d.lookup("tp.tp.local"), Lookup::Down { .. }), "the primary host still works");
        // another run may not claim the same alias
        let mut other = cfg.clone();
        other.project = "tq".into();
        other.aliases = vec!["old.name.tp.local".into()];
        let e = f.d.register(&other, &f._sb.dir.join("wt/main2"), "main").unwrap_err();
        assert!(e.to_string().contains("already belongs to run"), "{e:#}");
        let _ = km;
    }

    /// A daemon with one run `tp/r` whose web proc is declared (not started) and a leased web port.
    fn web_fixture() -> (Sandbox, Arc<Daemon>, String, u16, std::path::PathBuf) {
        let sb = sandbox();
        let toml = "project = \"tp\"\nrepo = \"/nonexistent/tp.git\"\ndomain = \"tp.local\"\n[ports.web]\n[procs.w]\nrun = 'exec sleep 300722'\nport = \"web\"\n";
        std::fs::create_dir_all(paths::projects_dir()).unwrap();
        std::fs::write(paths::projects_dir().join("tp.toml"), toml).unwrap();
        let wt = std::fs::canonicalize(&sb.dir).unwrap().join("wt/r");
        std::fs::create_dir_all(&wt).unwrap();
        let (tx, _rx) = tokio::sync::mpsc::unbounded_channel();
        let d = Daemon::new(tx).unwrap();
        let cfg = config::load_all().unwrap().remove(0);
        let (k, spec) = d.register(&cfg, &wt, "r").unwrap();
        let port = spec.ports["web"];
        (sb, d, k, port, wt)
    }

    fn serve_in(dir: &Path, port: u16) -> std::process::Child {
        std::fs::create_dir_all(dir).unwrap();
        let child = std::process::Command::new("python3")
            .args(["-m", "http.server", &port.to_string(), "--bind", "127.0.0.1"])
            .current_dir(dir)
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn()
            .unwrap();
        for _ in 0..200 {
            if std::net::TcpStream::connect(("127.0.0.1", port)).is_ok() {
                break;
            }
            std::thread::sleep(Duration::from_millis(50));
        }
        child
    }

    #[tokio::test(flavor = "current_thread")]
    async fn external_a_server_from_the_runs_own_worktree_on_its_port_is_adopted_routed_and_stoppable() {
        let (_sb, d, k, port, wt) = web_fixture();
        let mut child = serve_in(&wt, port);
        let pid = child.id() as i32;
        // the sweep notices it (no request needed)
        let me = d.clone();
        assert_eq!(tokio::task::spawn_blocking(move || me.detect_external_all()).await.unwrap(), vec![k.clone()]);
        let rec = d.lock().state.runs[&k].clone();
        assert_eq!(rec.status, RunStatus::Running);
        assert!(supervisor::is_external(&rec.procs[0]) && rec.procs[0].pid == pid);
        let host = rec.spec.host.clone();
        assert!(matches!(d.lookup(&host), Lookup::Up { port: p, .. } if p == port), "the proxy routes to the external server");
        assert_eq!(d.list()[0]["external"], true);
        assert_eq!(d.list()[0]["status"], "running");
        // a start does not launch a second server
        d.stop(&k, RunStatus::Stopped).await.unwrap();
        let mut gone = false;
        for _ in 0..100 {
            if child.try_wait().unwrap().is_some() {
                gone = true;
                break;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        if !gone {
            let _ = child.kill();
            let _ = child.wait();
        }
        assert!(gone, "Down must stop the external server after re-proving it");
        assert_eq!(d.lock().state.runs[&k].status, RunStatus::Stopped);
    }

    #[tokio::test(flavor = "current_thread")]
    async fn external_start_adopts_instead_of_starting_a_second_server_and_restart_makes_setu_the_owner() {
        let (_sb, d, k, port, wt) = web_fixture();
        let mut child = serve_in(&wt, port);
        d.start(&k).await.unwrap();
        let rec = d.lock().state.runs[&k].clone();
        assert_eq!(rec.status, RunStatus::Running);
        assert!(rec.procs.len() == 1 && supervisor::is_external(&rec.procs[0]), "no second server was spawned");
        // restart: the external server is stopped, then Setu starts (and owns) its own
        d.stop(&k, RunStatus::Stopped).await.unwrap();
        for _ in 0..100 {
            if child.try_wait().unwrap().is_some() {
                break;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        let _ = child.kill();
        let _ = child.wait();
        d.start(&k).await.unwrap();
        let rec = d.lock().state.runs[&k].clone();
        assert!(rec.procs.iter().all(|p| !supervisor::is_external(p)) && !rec.procs.is_empty(), "Setu owns the new process");
        d.stop(&k, RunStatus::Stopped).await.unwrap();
    }

    #[tokio::test(flavor = "current_thread")]
    async fn external_a_listener_outside_the_worktree_is_busy_and_never_signalled() {
        let (sb, d, k, port, _wt) = web_fixture();
        let mut stranger = serve_in(&std::fs::canonicalize(&sb.dir).unwrap().join("elsewhere"), port);
        let me = d.clone();
        assert!(tokio::task::spawn_blocking(move || me.detect_external_all()).await.unwrap().is_empty());
        let e = d.start(&k).await.unwrap_err();
        assert!(e.to_string().contains("in use by another process"), "{e:#}");
        assert!(d.lock().state.runs[&k].procs.is_empty());
        d.stop(&k, RunStatus::Stopped).await.unwrap();
        assert!(stranger.try_wait().unwrap().is_none(), "an unrelated listener must never be signalled");
        let _ = stranger.kill();
        let _ = stranger.wait();
    }

    #[tokio::test(flavor = "current_thread")]
    async fn external_down_re_proves_the_claim_and_leaves_a_process_that_no_longer_matches_alone() {
        let (_sb, d, k, port, _wt) = web_fixture();
        // a process that does not listen on the port (the original server is gone, the pid was reused)
        let mut other = std::process::Command::new("sleep").arg("300723").spawn().unwrap();
        let st = procinfo::start_time(other.id() as i32).unwrap();
        assert!(d.mark_external(&k, other.id() as i32, st, port));
        d.stop(&k, RunStatus::Stopped).await.unwrap();
        assert!(other.try_wait().unwrap().is_none(), "not signalled: it does not listen on the port from this worktree");
        let rec = d.lock().state.runs[&k].clone();
        assert!(rec.procs.is_empty() && rec.note.as_deref().is_some_and(|n| n.contains("not signalled")), "{:?}", rec.note);
        let _ = other.kill();
        let _ = other.wait();
    }

    // ---- v1 process groups: the listener's whole group and its sidecar groups ----

    const GROUP_FIXTURE: &str = r#"
import os, sys, subprocess, time
d, port, pf, role, other = sys.argv[1:6]
if os.fork() != 0:
    sys.exit(0)
os.setsid()
os.chdir(d)
dn = os.open(os.devnull, os.O_RDWR)
for fd in (0, 1, 2):
    os.dup2(dn, fd)
def publish():
    open(pf + ".tmp", "w").write(str(os.getpid()))
    os.rename(pf + ".tmp", pf)
if role == "shell":
    publish()
    os.execvp("sh", ["sh", "-c", "sleep 300; true"])
if port != "0":
    subprocess.Popen(["sh", "-c", "python3 -m http.server %s --bind 127.0.0.1; true" % port])
else:
    subprocess.Popen(["sleep", "300"])
publish()
while True:
    time.sleep(0.1)
    if os.path.exists(pf + ".move"):
        os.chdir(other)
"#;

    /// A recorded v1 group leader. Dropping it kills that group (the test's own process, by recorded pid).
    struct V1Grp {
        leader: i32,
        start: u64,
        flag: std::path::PathBuf,
    }
    impl Drop for V1Grp {
        fn drop(&mut self) {
            if procinfo::start_time(self.leader) == Some(self.start) {
                // SAFETY: killpg of the group whose leader this test spawned and just re-proved.
                unsafe { libc::killpg(self.leader, libc::SIGKILL) };
            }
        }
    }

    /// An orphaned (ppid 1) session leader with cwd `cwd`: the leader double-forks and its parent exits.
    /// `port` Some: its child chain ends in an HTTP listener on that port.
    fn v1_group(sandbox_dir: &Path, cwd: &Path, port: Option<u16>, role: &str, tag: &str, orphan: bool) -> V1Grp {
        let pf = sandbox_dir.join(format!("{tag}.pid"));
        let other = sandbox_dir.join("elsewhere");
        std::fs::create_dir_all(&other).unwrap();
        let mut cmd = std::process::Command::new("python3");
        cmd.args(["-c", GROUP_FIXTURE]).arg(cwd).arg(port.unwrap_or(0).to_string()).arg(&pf).arg(role).arg(&other);
        cmd.stdin(std::process::Stdio::null()).stdout(std::process::Stdio::null()).stderr(std::process::Stdio::null());
        if orphan {
            assert!(cmd.status().unwrap().success());
        } else {
            // not orphaned: this test process stays the parent of a plain session leader
            use std::os::unix::process::CommandExt;
            let script = "import os,sys,time\nos.chdir(sys.argv[1])\nopen(sys.argv[2],'w').write(str(os.getpid()))\ntime.sleep(300)";
            let mut c = std::process::Command::new("python3");
            c.args(["-c", script]).arg(cwd).arg(&pf).stdin(std::process::Stdio::null()).stdout(std::process::Stdio::null()).stderr(std::process::Stdio::null());
            // SAFETY: setsid in the forked child before exec.
            unsafe { c.pre_exec(|| if libc::setsid() == -1 { Err(std::io::Error::last_os_error()) } else { Ok(()) }) };
            std::mem::forget(c.spawn().unwrap());
        }
        let mut leader = 0;
        for _ in 0..200 {
            if let Ok(t) = std::fs::read_to_string(&pf) {
                if let Ok(n) = t.trim().parse::<i32>() {
                    leader = n;
                    break;
                }
            }
            std::thread::sleep(Duration::from_millis(50));
        }
        assert!(leader > 1, "fixture {tag} did not start");
        if let Some(p) = port {
            for _ in 0..200 {
                if std::net::TcpStream::connect(("127.0.0.1", p)).is_ok() {
                    break;
                }
                std::thread::sleep(Duration::from_millis(50));
            }
        }
        let start = procinfo::start_time(leader).unwrap();
        V1Grp { leader, start, flag: pf.with_extension("pid.move") }
    }

    async fn all_gone(g: &V1Grp, members: &[i32]) -> bool {
        for _ in 0..150 {
            if procinfo::group_pids(g.leader).is_empty() && members.iter().all(|p| !procinfo::alive(*p)) {
                return true;
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
        false
    }

    async fn detect(d: &Arc<Daemon>) -> Vec<String> {
        let me = d.clone();
        tokio::task::spawn_blocking(move || me.detect_external_all()).await.unwrap()
    }

    #[tokio::test(flavor = "current_thread")]
    async fn external_v1_detection_records_the_listener_group_and_the_sidecar_group_and_down_stops_every_process() {
        let (sb, d, k, port, wt) = web_fixture();
        let app = v1_group(&sb.dir, &wt, Some(port), "listener", "app", true);
        let side = v1_group(&sb.dir, &wt, None, "sidecar", "side", true);
        let app_members = procinfo::group_pids(app.leader);
        let side_members = procinfo::group_pids(side.leader);
        assert!(app_members.len() >= 3 && side_members.len() >= 2, "fixture trees: {app_members:?} {side_members:?}");
        assert_eq!(procinfo::ident(app.leader).unwrap().ppid, 1, "orphaned to launchd");
        assert_eq!(detect(&d).await, vec![k.clone()]);
        let rec = d.lock().state.runs[&k].clone();
        assert_eq!(rec.status, RunStatus::Running);
        assert_eq!(rec.procs.len(), 2, "{:?}", rec.procs);
        assert!(rec.procs[0].name == supervisor::EXTERNAL_PROC && rec.procs[0].pid == app.leader && rec.procs[0].start_time == app.start);
        assert!(rec.procs[0].members.len() == 1 && procinfo::listening_ports(rec.procs[0].members[0].0).contains(&port), "listener is the evidence");
        assert!(rec.procs[1].name == supervisor::EXTERNAL_SIDECAR && rec.procs[1].pid == side.leader);
        d.stop(&k, RunStatus::Stopped).await.unwrap();
        assert!(all_gone(&app, &app_members).await, "listener group must be gone");
        assert!(all_gone(&side, &side_members).await, "sidecar group must be gone");
        assert_eq!(d.lock().state.runs[&k].status, RunStatus::Stopped);
    }

    #[tokio::test(flavor = "current_thread")]
    async fn external_v1_runs_are_readopted_routed_and_never_signalled_after_a_daemon_restart() {
        let (sb, d, k, port, wt) = web_fixture();
        let app = v1_group(&sb.dir, &wt, Some(port), "listener", "app", true);
        let side = v1_group(&sb.dir, &wt, None, "sidecar", "side", true);
        let (am, sm) = (procinfo::group_pids(app.leader), procinfo::group_pids(side.leader));
        assert_eq!(detect(&d).await, vec![k.clone()]);
        d.persist_durable().await.unwrap();
        let before = d.lock().state.runs[&k].procs.clone();
        let host = d.lock().state.runs[&k].spec.host.clone();
        // a fresh daemon over the same state database, as after a restart
        let (tx, _rx) = tokio::sync::mpsc::unbounded_channel();
        let d2 = Daemon::new(tx).unwrap();
        d2.adopt().await;
        let rec = d2.lock().state.runs[&k].clone();
        assert_eq!(rec.status, RunStatus::Running, "not crashed or stopped: {:?}", rec.note);
        assert_eq!(rec.procs, before, "the external records are kept as they were");
        assert!(rec.procs.iter().all(supervisor::is_external));
        assert!(matches!(d2.lookup(&host), Lookup::Up { port: p, .. } if p == port), "still routed");
        assert_eq!(d2.list()[0]["external"], true);
        assert!(!am.iter().chain(sm.iter()).any(|p| !procinfo::alive(*p)), "nothing was signalled");
        assert_eq!(crate::state::load(&d2.db).unwrap().runs[&k].status, RunStatus::Running);
        // and Setu still stops it on request, after re-proving the claim
        d2.stop(&k, RunStatus::Stopped).await.unwrap();
        assert!(all_gone(&app, &am).await && all_gone(&side, &sm).await);
    }

    #[tokio::test(flavor = "current_thread")]
    async fn external_v1_run_whose_group_leader_exited_is_still_readopted_after_a_daemon_restart() {
        let (sb, d, k, port, wt) = web_fixture();
        let app = v1_group(&sb.dir, &wt, Some(port), "listener", "app", true);
        let am = procinfo::group_pids(app.leader);
        assert_eq!(detect(&d).await, vec![k.clone()]);
        d.persist_durable().await.unwrap();
        let listener = d.lock().state.runs[&k].procs[0].members[0].0;
        // the leader (the v1 launcher) is gone; the listener it started lives on
        // SAFETY: SIGKILL to the leader this test spawned and re-proved by its start time.
        unsafe { libc::kill(app.leader, libc::SIGKILL) };
        for _ in 0..100 {
            if !procinfo::alive(app.leader) {
                break;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        let (tx, _rx) = tokio::sync::mpsc::unbounded_channel();
        let d2 = Daemon::new(tx).unwrap();
        d2.adopt().await;
        let rec = d2.lock().state.runs[&k].clone();
        assert_eq!(rec.status, RunStatus::Running, "{:?}", rec.note);
        assert!(rec.procs.iter().all(supervisor::is_external));
        assert!(procinfo::alive(listener), "the listener was not signalled");
        // SAFETY: cleanup of the listener this test spawned.
        unsafe { libc::killpg(app.leader, libc::SIGKILL) };
        for p in am {
            unsafe { libc::kill(p, libc::SIGKILL) };
        }
    }

    #[tokio::test(flavor = "current_thread")]
    async fn external_v1_restart_stops_both_groups_and_setu_then_owns_its_own() {
        let (sb, d, k, port, wt) = web_fixture();
        let app = v1_group(&sb.dir, &wt, Some(port), "listener", "app", true);
        let side = v1_group(&sb.dir, &wt, None, "sidecar", "side", true);
        let (am, sm) = (procinfo::group_pids(app.leader), procinfo::group_pids(side.leader));
        d.start(&k).await.unwrap();
        let rec = d.lock().state.runs[&k].clone();
        assert!(rec.procs.len() == 2 && rec.procs.iter().all(supervisor::is_external), "adopted, no second server");
        d.stop(&k, RunStatus::Stopped).await.unwrap();
        assert!(all_gone(&app, &am).await && all_gone(&side, &sm).await);
        d.start(&k).await.unwrap();
        let rec = d.lock().state.runs[&k].clone();
        assert!(!rec.procs.is_empty() && rec.procs.iter().all(|p| !supervisor::is_external(p)), "Setu owns the new process");
        d.stop(&k, RunStatus::Stopped).await.unwrap();
    }

    #[tokio::test(flavor = "current_thread")]
    async fn external_v1_a_group_leader_whose_parent_is_not_1_is_never_recorded_or_signalled() {
        let (sb, d, k, port, wt) = web_fixture();
        let app = v1_group(&sb.dir, &wt, Some(port), "listener", "app", true);
        let mine = v1_group(&sb.dir, &wt, None, "sidecar", "mine", false);
        assert_eq!(procinfo::ident(mine.leader).unwrap().ppid, std::process::id() as i32);
        assert_eq!(detect(&d).await, vec![k.clone()]);
        let rec = d.lock().state.runs[&k].clone();
        assert!(rec.procs.iter().all(|p| p.pid != mine.leader), "{:?}", rec.procs);
        // the record is simply absent, so Down leaves that group alone
        d.stop(&k, RunStatus::Stopped).await.unwrap();
        assert!(procinfo::alive(mine.leader) && procinfo::start_time(mine.leader) == Some(mine.start));
        drop(app);
    }

    #[tokio::test(flavor = "current_thread")]
    async fn external_v1_a_shell_is_never_signalled() {
        let (sb, d, k, port, wt) = web_fixture();
        let _app = v1_group(&sb.dir, &wt, Some(port), "listener", "app", true);
        let sh = v1_group(&sb.dir, &wt, None, "shell", "sh", true);
        assert!(procinfo::exe_name(sh.leader).is_some_and(|n| procinfo::is_shell_name(&n)), "{:?}", procinfo::exe_name(sh.leader));
        assert_eq!(detect(&d).await, vec![k.clone()]);
        assert!(d.lock().state.runs[&k].procs.iter().all(|p| p.pid != sh.leader), "a shell is not a sidecar");
        // a forged record for the shell is refused at stop time too
        let forged = crate::model::ProcRecord { name: supervisor::EXTERNAL_SIDECAR.into(), pid: sh.leader, start_time: sh.start, escaped: vec![], members: vec![] };
        assert!(!supervisor::stop_external(&forged, &wt, port, Duration::from_millis(200)).await.unwrap());
        d.stop(&k, RunStatus::Stopped).await.unwrap();
        assert!(procinfo::alive(sh.leader));
    }

    #[tokio::test(flavor = "current_thread")]
    async fn external_v1_a_leader_whose_cwd_moved_out_of_the_worktree_is_never_signalled() {
        let (sb, d, k, port, wt) = web_fixture();
        let _app = v1_group(&sb.dir, &wt, Some(port), "listener", "app", true);
        let side = v1_group(&sb.dir, &wt, None, "sidecar", "side", true);
        assert_eq!(detect(&d).await, vec![k.clone()]);
        assert!(d.lock().state.runs[&k].procs.iter().any(|p| p.pid == side.leader));
        std::fs::write(&side.flag, "").unwrap();
        let mut moved = false;
        for _ in 0..100 {
            if procinfo::cwd(side.leader).is_some_and(|c| !c.starts_with(&wt)) {
                moved = true;
                break;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        assert!(moved, "fixture leader changed directory");
        d.stop(&k, RunStatus::Stopped).await.unwrap();
        assert!(procinfo::alive(side.leader) && !procinfo::group_pids(side.leader).is_empty(), "moved leader's group untouched");
        let note = d.lock().state.runs[&k].note.clone().unwrap_or_default();
        assert!(note.contains("not signalled"), "{note}");
    }

    #[tokio::test(flavor = "current_thread")]
    async fn external_v1_a_recycled_leader_with_a_different_start_time_is_never_signalled() {
        let (sb, d, k, port, wt) = web_fixture();
        let _app = v1_group(&sb.dir, &wt, Some(port), "listener", "app", true);
        let side = v1_group(&sb.dir, &wt, None, "sidecar", "side", true);
        assert_eq!(detect(&d).await, vec![k.clone()]);
        d.set(&k, |r| {
            for p in r.procs.iter_mut().filter(|p| p.pid == side.leader) {
                p.start_time += 1;
            }
        });
        d.stop(&k, RunStatus::Stopped).await.unwrap();
        assert!(procinfo::alive(side.leader) && procinfo::start_time(side.leader) == Some(side.start));
        assert!(!procinfo::group_pids(side.leader).is_empty());
    }

    #[tokio::test(flavor = "current_thread")]
    async fn external_v1_sweep_stops_leftover_sidecars_once_the_listener_group_is_gone() {
        let (sb, d, k, port, wt) = web_fixture();
        let app = v1_group(&sb.dir, &wt, Some(port), "listener", "app", true);
        let side = v1_group(&sb.dir, &wt, None, "sidecar", "side", true);
        let (am, sm) = (procinfo::group_pids(app.leader), procinfo::group_pids(side.leader));
        assert_eq!(detect(&d).await, vec![k.clone()]);
        d.sweep().await;
        assert_eq!(d.lock().state.runs[&k].status, RunStatus::Running, "the listener group lives, so the run stays running");
        // SAFETY: the test's own fixture group, leader proved by start time.
        unsafe { libc::killpg(app.leader, libc::SIGKILL) };
        assert!(all_gone(&app, &am).await);
        d.sweep().await;
        assert!(all_gone(&side, &sm).await, "leftover sidecar group stopped");
        let rec = d.lock().state.runs[&k].clone();
        assert!(rec.status == RunStatus::Stopped && rec.procs.is_empty(), "{:?} {:?}", rec.status, rec.procs);
    }
}
