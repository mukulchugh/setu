//! Shared types. Every module codes against these; change them only in the coordinator.

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::path::PathBuf;
use std::time::Duration;

/// Leased app ports live here: above v1's 3000-3999, clear of its 8288-9287 Inngest range.
pub const PORT_RANGE: std::ops::RangeInclusive<u16> = 4000..=4999;

/// One project, parsed from `~/.config/setu/projects/<project>.toml`.
#[derive(Debug, Clone, PartialEq)]
pub struct ProjectConfig {
    pub project: String,
    /// Bare repo; worktrees are discovered with `git worktree list --porcelain`.
    pub repo: PathBuf,
    /// Run hosts are `<run>.<domain>`; the `main` worktree is `<project>.<domain>`.
    pub domain: String,
    /// Extra hosts (under `domain`) that route to the `main` run, e.g. a v1 URL kept after a project rename.
    pub aliases: Vec<String>,
    pub idle: Duration,
    /// Max runs up at once across this project (default 3).
    pub max_running: usize,
    /// Named ports leased per run, e.g. "web", "inngest". Values are reserved for later options.
    pub ports: Vec<String>,
    /// Project env layer (unrendered templates).
    pub env: BTreeMap<String, String>,
    /// Ordered by name.
    pub procs: BTreeMap<String, ProcSpec>,
    /// Preset names requested by the project ("auto" = detect from marker files).
    pub presets: Vec<String>,
    /// Declared disk items after preset merge (see docs/slices/02-disk.md).
    pub disk_items: Vec<DiskItem>,
    /// Shared package stores to watch (never cleaned by Setu).
    pub stores: Vec<DiskStore>,
    /// `[worktree]` table: base ref, linked and copied files, free-space floor.
    pub worktree: WorktreeCfg,
    /// `[[setup.step]]`, run in order in a new worktree.
    pub setup_steps: Vec<SetupStep>,
    /// Reinstall missing dependencies (a deps item with an `install` command) before a start.
    /// `auto_install = false` turns it off; an explicit `[setup]` section also wins over it.
    pub auto_install: bool,
}

/// `[worktree]` in a project config (slice 7).
#[derive(Debug, Clone, Default, PartialEq)]
pub struct WorktreeCfg {
    /// Base ref for `new`; default is origin/staging if it exists, else origin/<default branch>.
    pub base: Option<String>,
    /// Paths (relative to the worktree root) symlinked from the main worktree, e.g. env files.
    pub link: Vec<String>,
    /// Ignored files copied from the main worktree.
    pub copy: Vec<String>,
    /// Refuse `new` when the volume has less free space than this.
    pub min_free: Option<u64>,
}

/// One `[[setup.step]]`: a shell command run in the new worktree.
#[derive(Debug, Clone, PartialEq)]
pub struct SetupStep {
    pub name: String,
    pub run: String,
    /// Reserved for skip logic (files whose content decides whether the step reruns).
    pub inputs: Vec<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum DiskKind {
    Deps,
    Output,
    Cache,
}

/// A regenerable directory inside a worktree, declared by a preset or the project.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct DiskItem {
    pub name: String,
    pub kind: DiskKind,
    /// Relative to the worktree root; `*` matches exactly one path segment. No `..`, no absolute paths.
    pub paths: Vec<String>,
    /// Auto-clean this long after the run's recorded stop; None = never auto-clean.
    pub clean_after: Option<Duration>,
    /// Deps items only: how to bring the item back when its path is missing.
    #[serde(default)]
    pub install: Option<Install>,
}

/// A frozen install command for a deps item.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Install {
    /// Shell command run in the worktree root.
    pub run: String,
    /// The install only runs when one of these exists in the worktree root (empty: no requirement).
    pub lockfiles: Vec<String>,
}

/// A shared store outside worktrees (e.g. a package manager cache). Watched, never cleaned.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct DiskStore {
    pub name: String,
    pub path: PathBuf,
    /// Warn when the store's logical size is below this (an emptied cache means slow, large re-downloads).
    pub warn_below: Option<u64>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct ProcSpec {
    /// Shell command, unrendered (templates allowed).
    pub run: String,
    /// Name of the leased port this proc listens on. The proc with a port that receives
    /// proxied traffic is the one named by `ProjectConfig::web_proc()`.
    pub port: Option<String>,
    /// Prefix the command with `mise exec --` so toolchains resolve per worktree.
    pub mise: bool,
    /// Working directory relative to the worktree root (default ".").
    pub cwd: Option<String>,
}

impl ProjectConfig {
    /// The proc that receives proxied HTTP: the first proc (by name) whose port is "web",
    /// else the first proc with any port.
    pub fn web_proc(&self) -> Option<(&str, &ProcSpec)> {
        self.procs
            .iter()
            .find(|(_, p)| p.port.as_deref() == Some("web"))
            .or_else(|| self.procs.iter().find(|(_, p)| p.port.is_some()))
            .map(|(n, p)| (n.as_str(), p))
    }
}

/// `project/run`, e.g. `quivly-app/feat-x`.
#[derive(Debug, Clone, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
pub struct RunId {
    pub project: String,
    pub run: String,
}

impl std::fmt::Display for RunId {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}/{}", self.project, self.run)
    }
}

/// Everything needed to start a run, fully rendered. Built by `config::resolve_run`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct RunSpec {
    pub id: RunId,
    pub worktree: PathBuf,
    /// Lowercase host without port, e.g. `feat-x.quivly.local`.
    pub host: String,
    /// `http://<host>:<PROXY_PORT>`
    pub url: String,
    pub ports: BTreeMap<String, u16>,
    /// Final env after all layers and templates (global < project < worktree < computed).
    pub env: BTreeMap<String, String>,
    pub procs: Vec<ResolvedProc>,
    /// Port of the proc that receives proxied traffic.
    pub web_port: Option<u16>,
    pub idle: Duration,
    /// Extra hosts that route to this run (project `aliases`, main run only).
    #[serde(default)]
    pub aliases: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ResolvedProc {
    pub name: String,
    /// Rendered shell command (run via `sh -c`).
    pub command: String,
    pub cwd: PathBuf,
    pub port: Option<u16>,
    pub log_path: PathBuf,
}

/// A process Setu started. `pgid == pid` because every proc leads its own session.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ProcRecord {
    pub name: String,
    pub pid: i32,
    /// Process start time from the kernel (`procinfo::start_time`), used to refuse
    /// signalling a recycled pid.
    pub start_time: u64,
    /// Descendants that left the group (setsid/daemonized children), seen while the
    /// proc was alive: (pid, start_time). Stop signals them only if the start time still matches.
    #[serde(default)]
    pub escaped: Vec<(i32, u64)>,
    /// Members of the proc's group seen under continuous supervision (while the leader lived,
    /// or at the instant it exited): (pid, start_time). A group whose leader is gone is the
    /// proc's own only while one of these exact incarnations still lives in it, because a
    /// process group id is never reused while any member exists (review B3).
    #[serde(default)]
    pub members: Vec<(i32, u64)>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum RunStatus {
    Stopped,
    Starting,
    Running,
    Stopping,
    Crashed,
    /// A new worktree whose setup steps are still running; nothing may start it yet.
    Preparing,
    /// Setup failed or was interrupted; the run cannot start until `setu retry-setup` succeeds.
    SetupFailed,
}

/// Persisted per run in state.json.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct RunRecord {
    pub spec: RunSpec,
    pub status: RunStatus,
    pub pinned: bool,
    pub procs: Vec<ProcRecord>,
    /// Last error or crash note, if any.
    pub note: Option<String>,
    /// Unix seconds when Setu last saw this run stop. Disk policies age from this, never from mtimes.
    #[serde(default)]
    pub stopped_at: Option<u64>,
    /// Hash of the env the running procs were started with (for "restart to apply env changes").
    #[serde(default)]
    pub env_hash: Option<u64>,
    /// Unix seconds when Setu last started this run. With `stopped_at` and `last_request_at`
    /// this is the only input to auto-removal's idle age; all three missing means "unknown".
    #[serde(default)]
    pub last_started_at: Option<u64>,
    /// Unix seconds of the last request the proxy served for this run (updated at most once a minute).
    #[serde(default)]
    pub last_request_at: Option<u64>,
    /// Extra hosts added with `setu alias`. They belong to this record (any run, branches
    /// included), are stored in the database, and are dropped with the run.
    #[serde(default)]
    pub custom_aliases: Vec<String>,
}

/// What the proxy learns about a Host.
#[derive(Debug, Clone, PartialEq)]
pub enum Lookup {
    Up { run: RunId, port: u16 },
    Starting { run: RunId },
    /// Registered but stopped/crashed: the proxy may ask for an on-demand start.
    Down { run: RunId },
    /// Setup is still running: the proxy shows a "preparing" page. `installing` tells a start that
    /// is installing missing dependencies from a new worktree running its setup steps.
    Preparing { run: RunId, installing: bool },
    /// Setup failed: never started on demand; the proxy says how to retry.
    SetupFailed { run: RunId },
    /// The project declares no procs: there is nothing to start.
    NoServer { run: RunId },
    /// The run has procs but none has a port, so nothing serves HTTP.
    NoHttp { run: RunId },
    Unknown,
}

/// Implemented by the daemon; the proxy only talks to this.
pub trait Routes: Send + Sync + 'static {
    /// Pure in-memory lookup by host (port already stripped, lowercase).
    fn lookup(&self, host: &str) -> Lookup;
    /// Non-blocking: ask the daemon to start a Down run. Returns false if refused
    /// (for example the max-running cap); the proxy then shows `refusal`.
    fn request_start(&self, run: &RunId) -> Result<(), String>;
}
