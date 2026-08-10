#!/usr/bin/env bun
// Dev portal — http://quivly.local

import { readFileSync, writeFileSync, appendFileSync, unlinkSync, mkdirSync, statSync, renameSync, openSync, existsSync } from 'fs';
import { execFileSync, spawnSync } from 'child_process';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
// Bun bundles + transpiles the Preact UI referenced by this page at serve time
import indexPage from './portal/index.html';
import {
  PORTAL_PORT, CLOUDFLARED_BIN,
  requireConfig, localDomain, publicDomain, envLocalPath, tunnelEnabled,
  parseEnvFile, pinnedTriggerVersion,
  readEnvrc, configureWorktreeEnv, reloadCaddy, syncHosts,
  portEntries, getPort, activePid, listActivePorts, processCwd, loadProjects, registerProject, removeProject,
  git, branchExists, createWorktree as libCreateWorktree, removeWorktree as libRemoveWorktree,
  AGENT_CLIS, detectAgentClis, loadSidecars, loadAllSidecars, saveSidecars, killGroup,
  loadCustomAgents, saveCustomAgents,
  containerRuntimeAvailable, composeProjectName, dockerComposePath, composeProjectAlive, writeDockerCompose,
  defaultContainerMode, needsMigrationPrompt, markMigrationPrompted, syncWithBase,
  worktreeBranchMap, branchMetadata, saveConfig, macCapacity, engineCapacity,
} from './lib.js';

let _cfg;
try { _cfg = requireConfig(); }
catch (e) { console.error(`setu portal: ${e.message}`); process.exit(1); }

const WORKSPACE      = _cfg.workspace;
const TUNNEL_NAME    = _cfg.tunnel;
const CF_CREDENTIALS_CFG = _cfg.cfCredentials;
const PKG_DIR     = new URL('.', import.meta.url).pathname;
const LOGS        = `${WORKSPACE}/logs`;
const PORT        = PORTAL_PORT;
const LOG_MAX_BYTES = 5 * 1024 * 1024; // rotate at 5 MB

const procs        = new Map();
const inngestProcs = new Map();
const triggerProcs = new Map();
const sidecarProcs = new Map(); // key: `${repo}/${name}/${sidecar.name}`

const INNGEST_CLI    = 'inngest-cli';
const INNGEST_OFFSET = 5288; // app port 3000 → inngest 8288, 3001 → 8289, …

const CF_CREDENTIALS  = CF_CREDENTIALS_CFG;
const TUNNEL_CONF_DIR = `${WORKSPACE}/tunnel.d`;
const MERGED_CONF     = `${TUNNEL_CONF_DIR}/merged.yml`;
const TUNNEL_LOG      = `${LOGS}/cloudflared/tunnel.log`;

// One cloudflared process with a merged ingress config.
// Replicas of the same tunnel are load-balanced by Cloudflare's edge — each replica
// applies its own local ingress rules, so two replicas with different ingress maps
// will randomly 404 each other's subdomains. Single process avoids this entirely.
const activeTunnelMap = new Map(); // key → { pubDom, port }
let   tunnelProc      = null;

function inngestPort(appPort) { return appPort + INNGEST_OFFSET; }

// ── logging ───────────────────────────────────────────────────────────────────

function logDir(repo, name) {
  const dir = `${LOGS}/${repo}/${name}`;
  mkdirSync(dir, { recursive: true });
  return dir;
}

function logPath(repo, name, type = 'dev') {
  if (type === 'tunnel') return TUNNEL_LOG;
  return `${logDir(repo, name)}/${type}.log`;
}

function rotateLog(path) {
  try {
    if (statSync(path).size > LOG_MAX_BYTES) renameSync(path, path + '.old');
  } catch {}
}

function openLogFd(repo, name, type = 'dev') {
  const path = logPath(repo, name, type);
  rotateLog(path);
  appendFileSync(path, `\n[${ new Date().toISOString() }] ── session start ──\n`);
  return openSync(path, 'a');
}

function tailLog(repo, name, type = 'dev', lines = 150) {
  try {
    const text = readFileSync(logPath(repo, name, type), 'utf8');
    const all  = text.split('\n');
    return { lines: all.slice(-lines), total: all.length };
  } catch { return { lines: [], total: 0 }; }
}

// ── Raycast extension dev mode ──────────────────────────────────────────────
// raycast/ lives inside the setu repo itself (PKG_DIR), not a registered
// project under WORKSPACE — it's Setu's own tooling, not something a
// worktree owns. `ray develop` is a long-running watch process (like `next
// dev`), so this is tracked the same shape as a worktree's dev server
// (procs Map elsewhere) rather than treated as a one-shot command.
const RAYCAST_DIR = `${PKG_DIR}raycast`;
let raycastDev = null; // { proc, pid } | null

function raycastLogPath() {
  const dir = `${LOGS}/_raycast`;
  mkdirSync(dir, { recursive: true });
  return `${dir}/dev.log`;
}

function startRaycastDev() {
  if (raycastDev) return { ok: true };
  if (!existsSync(RAYCAST_DIR)) return { ok: false, error: 'raycast/ not found in the setu repo' };
  const path = raycastLogPath();
  rotateLog(path);
  appendFileSync(path, `\n[${new Date().toISOString()}] ── raycast dev start ──\n`);
  const fd = openSync(path, 'a');
  // One script, not two spawns — `npm install` only when node_modules is
  // missing (so toggling dev mode on repeatedly doesn't reinstall every
  // time), then hands off to `ray develop` in the same process tree so a
  // single pid covers both steps for stop/kill purposes.
  const script = `${tmpdir()}/setu-raycast-dev-${Date.now()}.sh`;
  writeFileSync(script,
    `#!/bin/zsh\ncd "${RAYCAST_DIR}"\n[ -d node_modules ] || npm install\nexec npx ray develop\n`,
    { mode: 0o755 });
  const proc = Bun.spawn(['/bin/zsh', script], { cwd: RAYCAST_DIR, stdout: fd, stderr: fd, detached: true });
  raycastDev = { proc, pid: proc.pid };
  proc.exited.then(() => { if (raycastDev?.proc === proc) raycastDev = null; });
  return { ok: true };
}

function stopRaycastDev() {
  if (!raycastDev) return { ok: true };
  killGroup(raycastDev.pid);
  raycastDev = null;
  return { ok: true };
}

// ── repo metadata ─────────────────────────────────────────────────────────────

let REPO_META = loadProjects(WORKSPACE);

// ── git metadata cache (last-commit / ahead-behind, batched per repo) ────────
// branchMetadata()+worktreeBranchMap() are each one call per REPO, not per
// worktree (see lib.js) — still worth a short TTL so a full /api/worktrees
// poll (every 800ms while a start is pending) doesn't re-run them needlessly.
// Nothing in the poll path fetches, so this is inherently as stale as the
// last `git fetch` regardless of TTL — the TTL bounds re-parse cost, not staleness.

const gitMetaCache = new Map(); // repo -> { branchMeta, pathToBranch, fetchedAt }
const GIT_META_TTL = 10_000;

function repoGitMeta(repo) {
  const cached = gitMetaCache.get(repo);
  if (cached && Date.now() - cached.fetchedAt < GIT_META_TTL) return cached;
  const repoDir = `${WORKSPACE}/${repo}.git`;
  let branchMeta = new Map(), pathToBranch = new Map();
  try {
    branchMeta = branchMetadata(repoDir);
    pathToBranch = worktreeBranchMap(repoDir);
  } catch {}
  const entry = { branchMeta, pathToBranch, fetchedAt: Date.now() };
  gitMetaCache.set(repo, entry);
  return entry;
}

// Uncommitted-changes count — genuinely per-worktree (live working-tree
// state, can't be batched from the bare repo like the ref data above).
// Same shape as fetchPR: Bun.spawn (not execFileSync — see fetchPR's own
// comment on why), short TTL cache.
const dirtyCache = new Map();
const DIRTY_TTL  = 5_000;

async function fetchDirty(repo, name) {
  const key    = `${repo}/${name}`;
  const cached = dirtyCache.get(key);
  if (cached && Date.now() - cached.fetchedAt < DIRTY_TTL) return cached.count;
  const wtDir = `${WORKSPACE}/${repo}/${name}`;
  try {
    const proc = Bun.spawn(['git', '-C', wtDir, '--no-optional-locks', 'status', '--porcelain'],
      { stdout: 'pipe', stderr: 'ignore' });
    const raw  = await new Response(proc.stdout).text();
    await proc.exited;
    const count = raw.trim() ? raw.trim().split('\n').length : 0;
    dirtyCache.set(key, { count, fetchedAt: Date.now() });
    return count;
  } catch {
    dirtyCache.set(key, { count: 0, fetchedAt: Date.now() });
    return 0;
  }
}

// ── PR cache ──────────────────────────────────────────────────────────────────

const prCache = new Map();
const PR_TTL  = 60_000;

async function fetchPR(repo, name) {
  const key    = `${repo}/${name}`;
  const cached = prCache.get(key);
  if (cached && Date.now() - cached.fetchedAt < PR_TTL) return cached;
  try {
    // ponytail: Bun.spawn keeps event loop unblocked; execFileSync froze it with 10+ parallel calls
    const proc = Bun.spawn(['gh', 'pr', 'list', '--head', name,
      '--repo', REPO_META[repo]?.slug ?? repo,
      '--json', 'number,title,url', '--limit', '1',
    ], { stdout: 'pipe', stderr: 'ignore' });
    const raw  = await new Response(proc.stdout).text();
    await proc.exited;
    const pr    = JSON.parse(raw.trim())[0] ?? null;
    const entry = pr ? { ...pr, fetchedAt: Date.now() } : { fetchedAt: Date.now() };
    prCache.set(key, entry);
    return entry;
  } catch {
    const entry = { fetchedAt: Date.now() };
    prCache.set(key, entry);
    return entry;
  }
}

// ── helpers ───────────────────────────────────────────────────────────────────

// ponytail: ports.js's activePid() call in getWorktrees() used to run once per
// worktree, every poll (3s idle / 800ms mid-start) — same execFileSync-freezes-the-
// event-loop bug fetchPR() already had. Batch + short TTL cache, shared with /api/ports.
let _portsCache = null, _portsCacheAt = 0;
const PORTS_TTL = 1500;

function activePortsCached() {
  const now = Date.now();
  if (_portsCache && now - _portsCacheAt < PORTS_TTL) return _portsCache;
  _portsCache = listActivePorts();
  _portsCacheAt = now;
  return _portsCache;
}

function killPort(port) {
  // A container-published port's host-side "process" is the engine's own
  // port-forwarding helper, not the dev server itself — signaling it directly
  // isn't scoped to one container (reconcileDevServers hits this exact hazard
  // and already branches container-first for the same reason). Route through
  // the real stop path whenever the port belongs to a known, container-backed
  // worktree; the raw PID-kill fallback below stays for bare processes and for
  // genuinely-unregistered ports (setu prune's orphan-killing case).
  const owner = portEntries(WORKSPACE).find(e => e.port === port);
  const entry = owner && procs.get(owner.key);
  if (entry?.container) {
    stopContainer(owner.repo, owner.name, entry.container);
    if (procs.get(owner.key) === entry) procs.delete(owner.key);
    drainQueue();
    return { ok: true };
  }
  const pid = activePid(port);
  if (!pid) return { ok: false, error: 'nothing on that port' };
  try { process.kill(parseInt(pid), 'SIGTERM'); return { ok: true }; }
  catch (e) { return { ok: false, error: String(e) }; }
}

// Resource usage — only ever called for `active` worktrees (no point
// measuring what isn't running), so this never scales with the full 45+
// worktree registry, only with maxConcurrentDevServers (default 3).
async function activeMemMb(entry) {
  if (!entry) return null;
  if (entry.container) {
    try {
      const idProc = Bun.spawn(['docker', 'compose', '-p', entry.container, 'ps', '-q'], { stdout: 'pipe', stderr: 'ignore' });
      const id = (await new Response(idProc.stdout).text()).trim().split('\n')[0];
      await idProc.exited;
      if (!id) return null;
      const statsProc = Bun.spawn(['docker', 'stats', '--no-stream', '--format', '{{.MemUsage}}', id], { stdout: 'pipe', stderr: 'ignore' });
      const raw = (await new Response(statsProc.stdout).text()).trim();
      await statsProc.exited;
      // "123.4MiB / 4GiB" — only the used side matters here
      const m = raw.match(/^([\d.]+)\s*(MiB|GiB)/);
      if (!m) return null;
      return m[2] === 'GiB' ? parseFloat(m[1]) * 1024 : parseFloat(m[1]);
    } catch { return null; }
  }
  if (entry.pid) return processFootprintMb(entry.pid);
  return null;
}

async function getWorktrees() {
  const activePorts = new Set(activePortsCached().map(p => p.port));
  return Promise.all(
    portEntries(WORKSPACE).map(async ({ key, repo, name, port }) => {
      const slug     = name.replace(/\//g, '-');
      const domain   = localDomain(repo, name);
      const wtDir    = `${WORKSPACE}/${repo}/${name}`;
      const tunnelOn = tunnelEnabled(wtDir, _cfg);
      const meta     = REPO_META[repo] ?? { label: repo, github: null };
      const branchUrl = meta.github ? `${meta.github}/tree/${name}` : null;
      const pr        = name !== 'main' ? await fetchPR(repo, name) : null;
      const iPort = inngestPort(port);
      const active = activePorts.has(port);
      const procEntry = procs.get(key);

      // Worktree directory name isn't reliably the branch name — join
      // through the real path->branch map, not an assumption (see
      // worktreeBranchMap's comment in lib.js for the confirmed live case
      // where this bit us).
      const { branchMeta, pathToBranch } = repoGitMeta(repo);
      const branch = pathToBranch.get(resolve(wtDir)) ?? name;
      const gm = branchMeta.get(branch) ?? { lastCommitAt: null, ahead: 0, behind: 0 };
      const [dirty, memMb] = await Promise.all([
        fetchDirty(repo, name),
        active ? activeMemMb(procEntry) : Promise.resolve(null),
      ]);

      return {
        key, repo, name, slug, port, domain, pubDomain: publicDomain(_cfg), tunnelOn,
        active,
        container:     procEntry?.container ?? null,
        // What a plain Start (no explicit --container/--bare) would resolve
        // to right now — lets the UI show this *before* the click instead of
        // the user finding out after, which is the exact blind spot that let
        // an established worktree get silently switched to a container.
        nextStartMode: defaultContainerMode(WORKSPACE, repo, name) ? 'container' : 'bare',
        needsMigrationPrompt: needsMigrationPrompt(WORKSPACE, repo, name),
        queued:        queuePosition(key) !== null,
        queuePosition: queuePosition(key),
        tunnelRunning: tunnelProc !== null && activeTunnelMap.has(key),
        label:         meta.label,
        branchUrl,
        pr:            pr?.url ? { url: pr.url, number: pr.number, title: pr.title } : null,
        inngestActive: inngestProcs.has(key) || activePorts.has(iPort),
        inngestPort:   iPort,
        triggerActive: triggerProcs.has(key),
        lastCommitAt:  gm.lastCommitAt,
        ahead:         gm.ahead,
        behind:        gm.behind,
        dirty,
        memMb,
        // Directory birthtime, not a subprocess — statSync is essentially
        // free (no spawn) and APFS supports real birthtime. This is
        // creation time, not last-activity — don't conflate the two in the
        // UI (lastCommitAt is the "worked on" signal).
        createdAt: (() => { try { return Math.floor(statSync(wtDir).birthtimeMs / 1000); } catch { return null; } })(),
      };
    })
  );
}

// ── dev server ────────────────────────────────────────────────────────────────
// Each next-server can still be several hundred MB to low-GB even after the
// Turbopack-eviction fix (Next.js ≥16.3.0) — unbounded concurrent starts is
// exactly the failure mode this whole portal exists to prevent. Cap concurrent
// dev servers; anything beyond the cap queues and starts automatically as a
// slot frees up (a worktree stopping, or exiting on its own).
// `let`, not `const` — the settings page (POST /api/settings) updates this
// in-memory so a concurrency-cap change takes effect immediately, not only
// after the portal process restarts. Persisted to ~/.setu.json via
// saveConfig() at the same time so it survives a real restart too.
let MAX_CONCURRENT_DEV = _cfg.maxConcurrentDevServers ?? 3;
const startQueue = []; // [{ key, repo, name, port }], FIFO

function queuePosition(key) {
  const i = startQueue.findIndex(q => q.key === key);
  return i === -1 ? null : i + 1;
}

function drainQueue() {
  while (startQueue.length && procs.size < MAX_CONCURRENT_DEV) {
    const next = startQueue.shift();
    if (procs.has(next.key)) continue; // started some other way already
    if (next.container) spawnContainer(next.repo, next.name, next.port);
    else spawnWorktree(next.repo, next.name, next.port);
  }
}

function spawnWorktree(repo, name, port) {
  const key   = `${repo}/${name}`;
  const wtDir = `${WORKSPACE}/${repo}/${name}`;
  const env   = { ...process.env, PORT: String(port) };
  const envrc = readEnvrc(wtDir);
  for (const m of envrc.matchAll(/^export (\w+)=(.+)$/gm)) env[m[1]] = m[2].trim();
  const fd   = openLogFd(repo, name, 'dev');
  const proc = Bun.spawn(['bun', 'dev'], { cwd: wtDir, env, stdout: fd, stderr: fd });
  const entry = wrapProc(proc);
  procs.set(key, entry);
  proc.exited.then(() => { if (procs.get(key) === entry) { procs.delete(key); drainQueue(); } });
  startSidecars(repo, name, port);
}

// Container path: `docker compose up -d --build` returns as soon as containers
// are created and detached — the slow part (bun install && bun run dev) runs
// INSIDE the container afterward, so this is not a blocking start any more than
// the bare path is. Readiness is observed the same way as bare processes: once
// the container's published port opens, getWorktrees()'s existing lsof-based
// scan sees it — no container-specific polling needed there.
function spawnContainer(repo, name, port) {
  const key   = `${repo}/${name}`;
  const wtDir = `${WORKSPACE}/${repo}/${name}`;
  writeDockerCompose(_cfg, repo, name, port);
  const project = composeProjectName(repo, name);
  const fd = openLogFd(repo, name, 'dev');
  const proc = Bun.spawn(
    ['docker', 'compose', '-p', project, '-f', dockerComposePath(wtDir), 'up', '-d', '--build'],
    { cwd: wtDir, stdout: fd, stderr: fd });
  const entry = wrapContainer(project);
  procs.set(key, entry);
  proc.exited.then((code) => {
    // Only `up -d` itself failing (bad compose file, daemon unreachable) lands
    // here fast — the app's own boot happens after this exits, inside the
    // container. A nonzero exit means no container is actually running, so
    // don't leave a phantom "running" entry blocking the concurrency slot.
    if (code !== 0 && procs.get(key) === entry) { procs.delete(key); drainQueue(); }
  });
  startSidecars(repo, name, port);
}

function stopContainer(repo, name, project) {
  const wtDir = `${WORKSPACE}/${repo}/${name}`;
  // No -v: the node_modules named volume survives, so the next `up` skips
  // `bun install` unless the compose file's volume was ever pruned separately.
  try { execFileSync('docker', ['compose', '-p', project, '-f', dockerComposePath(wtDir), 'down'], { stdio: 'ignore' }); }
  catch {}
}

// Boot-time only: procs starts empty on every portal restart, same blind spot
// reconcileTriggerSidecars() fixes for Trigger — without this, a dev server
// that predates this portal instance (e.g. still running from before a
// restart) doesn't count against MAX_CONCURRENT_DEV, so the cap silently
// undercounts real concurrent servers. Container-backed worktrees are checked
// FIRST via `docker compose ps` — falling through to the generic port scan for
// them would misidentify the engine's own port-forwarding helper process as
// "the dev server pid" and a later stop would try to kill it directly, which
// isn't safe (that helper isn't scoped to one container).
function reconcileDevServers() {
  const activePorts = new Map(listActivePorts().map(p => [p.port, p.pid]));
  for (const { key, repo, name, port } of portEntries(WORKSPACE)) {
    if (procs.has(key)) continue;
    const wtDir = `${WORKSPACE}/${repo}/${name}`;
    if (existsSync(dockerComposePath(wtDir))) {
      const project = composeProjectName(repo, name);
      if (composeProjectAlive(project)) { procs.set(key, wrapContainer(project)); continue; }
    }
    const pid = activePorts.get(port);
    if (pid) procs.set(key, wrapPid(+pid));
  }
}

function startWorktree(repo, name, port, container = true) {
  const key = `${repo}/${name}`;
  if (procs.has(key)) return { ok: false, error: 'already running' };
  if (queuePosition(key)) return { ok: true, queued: true, position: queuePosition(key) };
  if (container) {
    const rt = containerRuntimeAvailable();
    // Fail loud, not silently downgrade to bare — a caller expecting a hard
    // memory/CPU cap getting a silently-uncapped process instead would defeat
    // the entire point. Explicit --bare is the escape hatch, not a fallback
    // this function reaches for on its own.
    if (!rt.available) return { ok: false, error: 'no Docker-compatible daemon reachable (docker info failed) — start OrbStack/Docker Desktop, or pass --bare to run natively instead' };
  }
  if (procs.size >= MAX_CONCURRENT_DEV) {
    startQueue.push({ key, repo, name, port, container });
    return { ok: true, queued: true, position: startQueue.length, container };
  }
  if (container) spawnContainer(repo, name, port); else spawnWorktree(repo, name, port);
  return { ok: true, container };
}

// drain=false is for callers that stop a worktree only to immediately respawn
// the SAME one (a restart, not a real vacancy) — checkMemoryCeilings' restart
// path and the tunnel toggle below. Defaulting drain=true here and letting
// drainQueue() run unconditionally used to admit a queued worktree into the
// slot in the moment between stop and respawn, and then the caller's respawn
// added the original worktree back on top — procs.size silently exceeding
// MAX_CONCURRENT_DEV, the exact thing the cap exists to prevent. If the
// respawn itself later fails, spawnWorktree/spawnContainer's own `.then`
// handlers already drain the queue — so skipping the drain here never leaves
// a slot stuck, it only avoids double-counting during a same-worktree restart.
function stopWorktree(repo, name, port, { drain = true } = {}) {
  const key = `${repo}/${name}`;
  const qi = startQueue.findIndex(q => q.key === key);
  if (qi !== -1) startQueue.splice(qi, 1);
  const entry = procs.get(key);
  procs.delete(key);
  if (entry?.container) {
    stopContainer(repo, name, entry.container);
  } else {
    const pid = activePid(port);
    if (pid) { try { execFileSync('kill', [pid]); } catch {} }
  }
  stopInngest(repo, name, port);
  stopTrigger(repo, name);
  stopSidecars(repo, name);
  if (drain) drainQueue();
}

// ── configurable per-project sidecars (workspace/sidecars.json) ──────────────
// Generic version of what startInngest/startTrigger already do, for anything
// project-specific that isn't Inngest or Trigger — a plain cloudflared tunnel,
// a queue worker, whatever a future project needs. Not hardcoded to quivly-app.

function startSidecars(repo, name, port) {
  const wtDir = `${WORKSPACE}/${repo}/${name}`;
  for (const s of loadSidecars(WORKSPACE, repo)) {
    const key = `${repo}/${name}/${s.name}`;
    if (sidecarProcs.has(key)) continue;
    const fd  = openLogFd(repo, name, `sidecar-${s.name}`);
    const env = { ...process.env, PORT: String(port), ...s.env };
    const proc = Bun.spawn([s.command, ...(s.args ?? [])], { cwd: wtDir, env, stdout: fd, stderr: fd, detached: true });
    const entry = wrapProc(proc);
    sidecarProcs.set(key, entry);
    proc.exited.then(() => { if (sidecarProcs.get(key) === entry) sidecarProcs.delete(key); });
  }
}

function stopSidecars(repo, name) {
  const prefix = `${repo}/${name}/`;
  for (const [key, entry] of sidecarProcs.entries()) {
    if (!key.startsWith(prefix)) continue;
    killGroup(entry.pid);
    sidecarProcs.delete(key);
  }
}

// Uniform wrapper for both freshly-spawned (native Bun.Subprocess) and reconciled
// (discovered-at-startup, PID only) sidecar entries — lets stop paths kill either
// the same way, and lets a portal restart re-adopt a still-live sidecar instead of
// losing track of it (inngestProcs/triggerProcs start as empty Maps every restart).
function wrapProc(proc) { return { pid: proc.pid, native: proc }; }
function wrapPid(pid)   { return { pid, native: null }; }
// Container-backed entries have no OS pid Setu owns directly (the tracked
// process is `docker compose up -d`, which exits once containers are
// created) — `container` holds the compose project name instead, and
// stop/reconcile paths branch on its presence.
function wrapContainer(project) { return { pid: null, native: null, container: project }; }

// ── inngest dev server ────────────────────────────────────────────────────────

function startInngest(repo, name, port) {
  const key   = `${repo}/${name}`;
  if (inngestProcs.has(key)) return { ok: false, error: 'already running' };
  const iPort = inngestPort(port);
  if (activePid(iPort)) return { ok: false, error: `port ${iPort} already in use (untracked process)` };
  const fd    = openLogFd(repo, name, 'inngest');
  const proc  = Bun.spawn(
    [INNGEST_CLI, 'dev', '-p', String(iPort), '-u', `http://localhost:${port}/api/inngest`, '--no-discovery'],
    { stdout: fd, stderr: fd, detached: true }
  );
  const entry = wrapProc(proc);
  inngestProcs.set(key, entry);
  proc.exited.then(() => { if (inngestProcs.get(key) === entry) inngestProcs.delete(key); });
  return { ok: true, port: iPort };
}

function stopInngest(repo, name, port) {
  const key   = `${repo}/${name}`;
  const entry = inngestProcs.get(key);
  if (entry) killGroup(entry.pid);
  inngestProcs.delete(key);
  // fall back to whatever's actually bound to the inngest port, same pattern as
  // stopWorktree — the tracked entry can be stale after a portal restart
  const iPort = port != null ? inngestPort(port) : null;
  const pid   = iPort ? activePid(iPort) : null;
  if (pid) killGroup(pid);
  if (!entry && !pid) return { ok: false, error: 'not running' };
  return { ok: true };
}

// ── trigger.dev dev server (per worktree, like inngest) ──────────────────────

// trigger.dev doesn't bind a local port (it's a websocket client to the cloud
// backend), so unlike inngest its "is this actually running" state can't be
// cross-checked against lsof — startup reconciliation (below) is what keeps this
// accurate across a portal restart instead.
const TRIGGER_MAX_CONCURRENT_RUNS = 2;

function startTrigger(repo, name) {
  const key = `${repo}/${name}`;
  if (triggerProcs.has(key)) return { ok: false, error: 'already running' };
  const wtDir = `${WORKSPACE}/${repo}/${name}`;
  const fd    = openLogFd(repo, name, 'trigger');
  // trigger tasks import Supabase keys etc. from the shared .env.local at load time
  const env   = { ...process.env, ...parseEnvFile(envLocalPath(repo, wtDir)) };
  const proc  = Bun.spawn(
    ['bunx', `trigger.dev@${pinnedTriggerVersion(wtDir)}`, 'dev', '--max-concurrent-runs', String(TRIGGER_MAX_CONCURRENT_RUNS)],
    { cwd: wtDir, env, stdout: fd, stderr: fd, detached: true });
  const entry = wrapProc(proc);
  triggerProcs.set(key, entry);
  proc.exited.then(() => { if (triggerProcs.get(key) === entry) triggerProcs.delete(key); });
  return { ok: true };
}

function stopTrigger(repo, name) {
  const key   = `${repo}/${name}`;
  const entry = triggerProcs.get(key);
  if (!entry) return { ok: false, error: 'not running' };
  // group-kill, not entry.native?.kill() — trigger.dev v4.5.3's own SIGTERM handler
  // races ahead of and defeats the code path that would dispose its esbuild child
  // (source-verified), so signal the whole process group directly instead
  killGroup(entry.pid);
  triggerProcs.delete(key);
  return { ok: true };
}

// Startup-only: discover trigger dev processes already running (from before this
// portal instance started) and adopt them into triggerProcs, keyed by matching
// their cwd against a known worktree. Cheap because it only runs once at boot.
function reconcileTriggerSidecars() {
  let raw;
  try { raw = execFileSync('ps', ['-eo', 'pid=,command='], { encoding: 'utf8' }); }
  catch { return; }
  const dirToKey = new Map(
    portEntries(WORKSPACE).map(({ key, repo, name }) => [`${WORKSPACE}/${repo}/${name}`, key])
  );
  for (const line of raw.split('\n')) {
    const m = line.match(/^\s*(\d+)\s+.*\.bin\/trigger dev\b/);
    if (!m) continue;
    const pid = +m[1];
    const cwd = processCwd(pid);
    const key = cwd && dirToKey.get(cwd);
    if (key && !triggerProcs.has(key)) triggerProcs.set(key, wrapPid(pid));
  }
}

// ── single cloudflared process with merged ingress ────────────────────────────

function writeMergedConf() {
  mkdirSync(TUNNEL_CONF_DIR, { recursive: true });
  const rules = [...activeTunnelMap.values()]
    .map(({ pubDom, port }) => `  - hostname: ${pubDom}\n    service: http://localhost:${port}`)
    .join('\n');
  writeFileSync(MERGED_CONF, [
    `tunnel: ${TUNNEL_NAME}`,
    `credentials-file: ${CF_CREDENTIALS}`,
    `protocol: http2`,
    `ingress:`,
    rules,
    `  - service: http_status:404`,
  ].join('\n') + '\n');
}

function openTunnelLog() {
  const dir = `${LOGS}/cloudflared`;
  mkdirSync(dir, { recursive: true });
  rotateLog(TUNNEL_LOG);
  appendFileSync(TUNNEL_LOG, `\n[${new Date().toISOString()}] ── session start ──\n`);
  return openSync(TUNNEL_LOG, 'a');
}

function restartTunnel() {
  if (tunnelProc) { tunnelProc.kill(); tunnelProc = null; }
  // reap orphaned cloudflared from a previous portal — two replicas of the same
  // tunnel serve divergent ingress maps and randomly 404 (see comment above)
  spawnSync('pkill', ['-f', `cloudflared --config ${MERGED_CONF}`]);
  if (activeTunnelMap.size === 0) return;
  writeMergedConf();
  const fd = openTunnelLog();
  tunnelProc = Bun.spawn(
    [CLOUDFLARED_BIN, '--config', MERGED_CONF, 'tunnel', 'run', TUNNEL_NAME],
    { stdout: fd, stderr: fd }
  );
  tunnelProc.exited.then(() => { tunnelProc = null; });
}

function addTunnelRoute(repo, name, pubDom, port) {
  activeTunnelMap.set(`${repo}/${name}`, { pubDom, port });
  restartTunnel();
  return { ok: true };
}

function removeTunnelRoute(repo, name) {
  activeTunnelMap.delete(`${repo}/${name}`);
  restartTunnel();
  return { ok: true };
}

// ── per-worktree tunnel toggle ────────────────────────────────────────────────

// Resumes a worktree in whatever mode it was actually running before —
// container or bare — instead of always spawnWorktree (bare). Always-bare
// used to silently strip a containerized worktree's memory/CPU cap on every
// tunnel toggle, with nothing telling the user it happened.
function respawnAsBefore(repo, name, port, wasContainer) {
  if (wasContainer) spawnContainer(repo, name, port); else spawnWorktree(repo, name, port);
}

function enableTunnel(repo, name, port) {
  // Only one worktree can use the shared tunnel URL — evict any currently active one
  for (const [key, { port: p }] of activeTunnelMap.entries()) {
    if (key === `${repo}/${name}`) continue;
    const si = key.indexOf('/');
    disableTunnel(key.slice(0, si), key.slice(si + 1), p);
  }
  const key = `${repo}/${name}`;
  const wasContainer = !!procs.get(key)?.container;
  const wasRunning = !!activePid(port);
  const pubDom = publicDomain(_cfg);
  // drain: false — this is a same-worktree restart, not a real vacancy; see
  // stopWorktree's comment. Captured wasContainer before stopping since
  // stopWorktree deletes the procs entry.
  if (wasRunning) stopWorktree(repo, name, port, { drain: false });
  configureWorktreeEnv(_cfg, repo, name, port, true);
  reloadCaddy(WORKSPACE);
  addTunnelRoute(repo, name, pubDom, port);
  // spawnContainer/spawnWorktree directly, not startWorktree — this is
  // resuming something that was already running a moment ago, not a fresh
  // admission decision, so it shouldn't get stuck behind the concurrency queue.
  if (wasRunning) respawnAsBefore(repo, name, port, wasContainer);
  return { ok: true };
}

function disableTunnel(repo, name, port) {
  const key = `${repo}/${name}`;
  const wasContainer = !!procs.get(key)?.container;
  const wasRunning = !!activePid(port);
  if (wasRunning) stopWorktree(repo, name, port, { drain: false });
  removeTunnelRoute(repo, name);
  configureWorktreeEnv(_cfg, repo, name, port, false);
  reloadCaddy(WORKSPACE);
  if (wasRunning) respawnAsBefore(repo, name, port, wasContainer);
  return { ok: true };
}

// ── create / remove worktree ──────────────────────────────────────────────────

function createWorktree(repo, name, tunnel) {
  const res = libCreateWorktree(_cfg, repo, name, { tunnel });
  if (tunnel) addTunnelRoute(repo, name, publicDomain(_cfg), res.port);

  // mise trust + bun install (background — takes a while)
  const setupFd = openLogFd(repo, name, 'setup');
  Bun.spawn(['zsh', '-c', `mise trust "${res.wtDir}" 2>/dev/null; cd "${res.wtDir}" && bun install`],
    { stdout: setupFd, stderr: setupFd });

  return { ok: true, port: res.port, domain: res.localDom };
}

function removeWorktree(repo, name) {
  // stop dev server and tunnel route first
  const port = getPort(WORKSPACE, repo, name);
  if (port) stopWorktree(repo, name, port);
  if (activeTunnelMap.has(`${repo}/${name}`)) removeTunnelRoute(repo, name);

  // The worktree is being permanently removed, not just stopped — unlike a
  // normal stop (stopContainer's `down` deliberately keeps the node_modules
  // volume so a later start skips reinstalling), there's no later start
  // coming. Without this, the volume leaks forever with nothing left
  // pointing at it — the exact kind of disk bloat this tool exists to avoid.
  // Must run before libRemoveWorktree deletes the directory (and the compose
  // file with it) below.
  const wtDir = `${WORKSPACE}/${repo}/${name}`;
  if (existsSync(dockerComposePath(wtDir))) {
    try {
      execFileSync('docker',
        ['compose', '-p', composeProjectName(repo, name), '-f', dockerComposePath(wtDir), 'down', '-v'],
        { stdio: 'ignore' });
    } catch {}
  }

  try { libRemoveWorktree(_cfg, repo, name); }
  catch (e) { return { ok: false, error: String(e) }; }

  prCache.delete(`${repo}/${name}`);
  return { ok: true };
}

// ── project registration ──────────────────────────────────────────────────────

function addProject({ github = '', name: nameArg = '', label = '' }) {
  // Normalise GitHub input → org/repo slug
  const slug = github.trim()
    .replace(/^https?:\/\/github\.com\//, '')
    .replace(/^git@github\.com:/, '')
    .replace(/\.git$/, '');

  const name  = (nameArg.trim() || slug.split('/').at(-1) || '').replace(/[^a-zA-Z0-9._-]/g, '-');
  if (!name) return { ok: false, error: 'repo name required' };

  const label_ = label.trim() || name;
  const repoDir = `${WORKSPACE}/${name}.git`;

  if (loadProjects(WORKSPACE)[name]) {
    return { ok: false, error: `${name} is already registered` };
  }

  // Bare clone (existing) or bare init (new)
  mkdirSync(WORKSPACE, { recursive: true });
  if (slug && !existsSync(repoDir)) {
    const useGh = spawnSync('gh', ['auth', 'status'], { stdio: 'ignore' }).status === 0;
    if (useGh) execFileSync('gh', ['repo', 'clone', slug, repoDir, '--', '--bare']);
    else execFileSync('git', ['clone', '--bare', `git@github.com:${slug}.git`, repoDir]);
    git(repoDir, ['config', 'remote.origin.fetch', '+refs/heads/*:refs/remotes/origin/*']);
    git(repoDir, ['fetch', '--all', '--prune']);
  } else if (!slug) {
    mkdirSync(repoDir, { recursive: true });
    execFileSync('git', ['-C', repoDir, 'init', '--bare']);
  }

  const base = registerProject(WORKSPACE, { name, slug, label: label_ });
  REPO_META = loadProjects(WORKSPACE);

  return { ok: true, name, base, slug: slug || null, label: label_ };
}

// ── open in Ghostty ───────────────────────────────────────────────────────────
// Which coding CLIs to offer isn't hardcoded to one fixed list — AGENT_CLIS
// (lib.js) is detected live via `which`, so this works for whatever's actually
// installed on this machine, not just the tools one project happened to use.

function openInGhostty(wtDir, tool) {
  const cmd = AGENT_CLIS[tool]?.bin
    ?? loadCustomAgents(WORKSPACE).find(a => a.id === tool)?.command;
  if (!cmd) return { ok: false, error: 'unknown tool' };
  const script = `${tmpdir()}/qdev-${Date.now()}.sh`;
  writeFileSync(script, `#!/bin/zsh\nsource "$HOME/.zshrc"\ncd "${wtDir}"\n${cmd}\nexec zsh -l\n`, { mode: 0o755 });
  // Not a raw `ghostty` spawn — Ghostty's own --help is explicit that launching
  // the terminal from the CLI isn't supported on macOS ("use open -na
  // Ghostty.app"). The raw binary silently spawns a process with zero children
  // and never runs the script; /api/open still returned {ok:true} throughout
  // since Bun.spawn not throwing synchronously was the only check — confirmed
  // live via a marker-file test that only the `open -na` form actually executes.
  Bun.spawn(['open', '-na', 'Ghostty', '--args', `--working-directory=${wtDir}`, `--command=${script}`],
    { detached: true, stdio: ['ignore', 'ignore', 'ignore'] });
  return { ok: true };
}

// ── router ────────────────────────────────────────────────────────────────────

async function handle(req) {
  const { pathname } = new URL(req.url);
  const method = req.method;

  if (pathname === '/api/worktrees') return Response.json(await getWorktrees());

  if (pathname === '/api/status') {
    const rt = containerRuntimeAvailable();
    return Response.json({
      concurrency: { active: procs.size, max: MAX_CONCURRENT_DEV, queued: startQueue.length },
      container: {
        engineAvailable: rt.available, engine: rt.engine,
        memoryLimit: _cfg.containerMemoryLimit ?? '4g',
        cpuLimit: _cfg.containerCpuLimit ?? 2,
      },
    });
  }

  if (pathname === '/api/agents') return Response.json(detectAgentClis(WORKSPACE));

  if (pathname === '/api/projects') return Response.json(
    Object.entries(loadProjects(WORKSPACE)).map(([name, m]) => ({ name, label: m.label, github: m.github }))
  );

  if (method === 'POST' && pathname === '/api/project/add') {
    const body = await req.json().catch(() => ({}));
    try { return Response.json(addProject(body)); }
    catch (e) { return Response.json({ ok: false, error: String(e) }, { status: 500 }); }
  }

  if (method === 'POST' && pathname === '/api/project/remove') {
    const body = await req.json().catch(() => ({}));
    try { removeProject(WORKSPACE, body.name); return Response.json({ ok: true }); }
    catch (e) { return Response.json({ ok: false, error: String(e) }, { status: 500 }); }
  }

  // Both GET (read current values + real hardware/Docker capacity for the
  // settings UI's ranges) and POST (persist a change) live on one path —
  // handled here, before the generic POST body-parsing block below, so a
  // POST to this path returns from here and never falls through to it.
  if (pathname === '/api/settings') {
    if (method === 'GET') {
      return Response.json({
        maxConcurrentDevServers: MAX_CONCURRENT_DEV,
        containerMemoryLimit: _cfg.containerMemoryLimit ?? '4g',
        containerCpuLimit: _cfg.containerCpuLimit ?? 2,
        mac: macCapacity(),
        docker: engineCapacity(),
      });
    }
    if (method === 'POST') {
      const body = await req.json().catch(() => ({}));
      if (body.maxConcurrentDevServers != null) {
        MAX_CONCURRENT_DEV = Math.max(1, Number(body.maxConcurrentDevServers) || 1);
        _cfg.maxConcurrentDevServers = MAX_CONCURRENT_DEV;
        drainQueue(); // a raised cap should immediately start anything already queued
      }
      if (body.containerMemoryLimit != null) _cfg.containerMemoryLimit = String(body.containerMemoryLimit);
      if (body.containerCpuLimit != null) _cfg.containerCpuLimit = Number(body.containerCpuLimit) || 1;
      saveConfig(_cfg);
      return Response.json({ ok: true });
    }
  }

  // Sidecars: GET returns every entry (including disabled) for the settings
  // UI to edit; POST replaces the whole per-repo list — the caller always
  // sends the full array back (add/remove/toggle are all client-side edits
  // to that array), matching saveSidecars()'s per-repo-overwrite shape.
  if (pathname === '/api/sidecars') {
    const p = new URL(req.url).searchParams;
    if (method === 'GET') return Response.json(loadAllSidecars(WORKSPACE, p.get('repo') ?? ''));
    if (method === 'POST') {
      const body = await req.json().catch(() => ({}));
      try { saveSidecars(WORKSPACE, body.repo, body.sidecars ?? []); return Response.json({ ok: true }); }
      catch (e) { return Response.json({ ok: false, error: String(e) }, { status: 500 }); }
    }
  }

  // Custom agents: same shape as sidecars above — GET for the settings UI to
  // edit, POST replaces the whole (global, not per-repo) list.
  if (pathname === '/api/custom-agents') {
    if (method === 'GET') return Response.json(loadCustomAgents(WORKSPACE));
    if (method === 'POST') {
      const body = await req.json().catch(() => ({}));
      try { saveCustomAgents(WORKSPACE, body.agents ?? []); return Response.json({ ok: true }); }
      catch (e) { return Response.json({ ok: false, error: String(e) }, { status: 500 }); }
    }
  }

  if (pathname === '/api/logs') {
    const p   = new URL(req.url).searchParams;
    const res = tailLog(p.get('repo'), p.get('name'), p.get('type') ?? 'dev', Number(p.get('n') ?? 150));
    return Response.json(res);
  }

  if (pathname === '/api/raycast/status') {
    return Response.json({ running: !!raycastDev, dirExists: existsSync(RAYCAST_DIR) });
  }
  if (pathname === '/api/raycast/log') {
    const n = Number(new URL(req.url).searchParams.get('n') ?? 150);
    try {
      const all = readFileSync(raycastLogPath(), 'utf8').split('\n');
      return Response.json({ lines: all.slice(-n) });
    } catch { return Response.json({ lines: [] }); }
  }
  if (method === 'POST' && pathname === '/api/raycast/start') return Response.json(startRaycastDev());
  if (method === 'POST' && pathname === '/api/raycast/stop') return Response.json(stopRaycastDev());

  if (method === 'POST') {
    const body = await req.json().catch(() => ({}));
    const { repo, name, tool, tunnel, container } = body;
    const wtPort = () => getPort(WORKSPACE, repo, name);

    if (pathname === '/api/create') {
      try { return Response.json(createWorktree(repo, name, !!tunnel)); }
      catch (e) { return Response.json({ ok: false, error: String(e) }, { status: 500 }); }
    }
    if (pathname === '/api/remove') {
      return Response.json(removeWorktree(repo, name));
    }
    if (pathname === '/api/start') {
      const port = wtPort(); if (!port) return Response.json({ ok: false }, { status: 404 });
      // Container is the default for dev servers, not opt-in — but ONLY when
      // nobody expressed a preference. `container` explicitly true/false
      // (a CLI --container/--bare flag) always wins. Omitted entirely (a
      // plain `setu start`, or the portal UI's Start button, which never
      // sends this field) falls back to defaultContainerMode's sticky,
      // per-worktree default — found live: applying the flat global default
      // unconditionally silently switched an established, always-bare
      // worktree into a container the moment it needed a restart, with no
      // one having asked for that. Native stays for the tooling around it
      // (portal, Caddy, dnsmasq, git) regardless — this only governs how the
      // dev server process itself runs.
      const useContainer = container === undefined ? defaultContainerMode(WORKSPACE, repo, name) : container !== false;
      // An explicit mode choice (from either the Force bare/container menu
      // or the one-time migration prompt) settles needsMigrationPrompt for
      // good, regardless of which mode was actually picked — the point was
      // never "must containerize," it was "must not decide silently."
      if (container !== undefined && needsMigrationPrompt(WORKSPACE, repo, name)) markMigrationPrompted(WORKSPACE, repo, name);
      return Response.json(startWorktree(repo, name, port, useContainer));
    }
    if (pathname === '/api/stop') {
      const port = wtPort(); if (!port) return Response.json({ ok: false }, { status: 404 });
      stopWorktree(repo, name, port); return Response.json({ ok: true });
    }
    if (pathname === '/api/sync') {
      const wtDir = `${WORKSPACE}/${repo}/${name}`;
      const repoDir = `${WORKSPACE}/${repo}.git`;
      try { return Response.json(syncWithBase(wtDir, repoDir)); }
      catch (e) { return Response.json({ ok: false, error: String(e) }, { status: 500 }); }
    }
    if (pathname === '/api/tunnel/enable') {
      const port = wtPort(); if (!port) return Response.json({ ok: false }, { status: 404 });
      return Response.json(enableTunnel(repo, name, port));
    }
    if (pathname === '/api/tunnel/disable') {
      const port = wtPort(); if (!port) return Response.json({ ok: false }, { status: 404 });
      return Response.json(disableTunnel(repo, name, port));
    }
    if (pathname === '/api/inngest/start') {
      const port = wtPort(); if (!port) return Response.json({ ok: false }, { status: 404 });
      return Response.json(startInngest(repo, name, port));
    }
    if (pathname === '/api/inngest/stop') {
      return Response.json(stopInngest(repo, name, wtPort()));
    }
    if (pathname === '/api/trigger/start') {
      return Response.json(startTrigger(repo, name));
    }
    if (pathname === '/api/trigger/stop') {
      return Response.json(stopTrigger(repo, name));
    }
    if (pathname === '/api/open') {
      return Response.json(openInGhostty(`${WORKSPACE}/${repo}/${name}`, tool));
    }
    if (pathname === '/api/ports/kill') {
      const { port } = body;
      return Response.json(killPort(port));
    }
  }

  if (pathname === '/api/ports') {
    const ports = activePortsCached();
    const registry = Object.fromEntries(portEntries(WORKSPACE).map(e => [e.port, e.key]));
    return Response.json(ports.map(p => ({ ...p, worktree: registry[p.port] ?? null })));
  }

  return new Response('Not found', { status: 404 });
}

// No upstream config (Next.js/Node/Turbopack) can cap Turbopack's native-side memory
// growth — NODE_OPTIONS=--max-old-space-size only bounds the V8/JS heap, confirmed via
// docs + vercel/next.js#92052. This is the backstop: restart any tracked dev server
// whose *physical* footprint (not just RSS — this box compresses most of a Node/Bun
// heap, so RSS alone hid a 17GB-footprint process behind a ~2.6GB RSS reading) crosses
// a ceiling. Even on Next.js ≥16.3.0 (memory eviction default-on), eviction is
// best-effort, not a hard cap.
const DEV_MEM_CEILING_MB = _cfg.devMemCeilingMb ?? 8192;
const MEM_CHECK_INTERVAL = 60_000;

function processFootprintMb(pid) {
  try {
    const out = execFileSync('footprint', [String(pid)], { encoding: 'utf8' });
    const m = out.match(/phys_footprint:\s*([\d.]+)\s*(MB|GB)/);
    if (!m) return 0;
    return m[2] === 'GB' ? parseFloat(m[1]) * 1024 : parseFloat(m[1]);
  } catch { return 0; }
}

const deadContainerStrikes = new Map(); // key -> consecutive "not alive" readings

function checkMemoryCeilings() {
  for (const [key, entry] of procs.entries()) {
    if (entry.container) {
      // Docker's own cgroup limit + `restart: on-failure:3` already enforce
      // and retry the memory ceiling — nothing in Setu needs to restart a
      // container itself. But `docker compose up -d` exits successfully the
      // moment containers are created, long before a crash-loop plays out, so
      // nothing else ever notices a container that permanently gave up after
      // exhausting its retries — without this, its concurrency slot stays
      // occupied forever (verified live: a memory limit too small for the
      // app to ever boot left a dead entry in `procs` indefinitely).
      if (composeProjectAlive(entry.container)) {
        deadContainerStrikes.delete(key);
      } else {
        // Require two consecutive misses, not one — a single "not alive"
        // reading can be a transient window during a legitimate recreate
        // (a tunnel toggle or manual restart respawning the same worktree),
        // not just a container that's genuinely given up for good. Treating
        // one miss as final risked freeing a slot — and losing container
        // tracking — for a worktree that was actually fine a moment later.
        const strikes = (deadContainerStrikes.get(key) ?? 0) + 1;
        if (strikes >= 2) {
          console.warn(`⚠ ${key} container exited and is not restarting — freeing its slot`);
          procs.delete(key);
          deadContainerStrikes.delete(key);
          drainQueue();
        } else {
          deadContainerStrikes.set(key, strikes);
        }
      }
      continue;
    }
    const mb = processFootprintMb(entry.pid);
    if (mb > DEV_MEM_CEILING_MB) {
      const si = key.indexOf('/');
      const repo = key.slice(0, si), name = key.slice(si + 1);
      const port = getPort(WORKSPACE, repo, name);
      console.warn(`⚠ ${key} dev server at ${Math.round(mb)}MB, exceeds ${DEV_MEM_CEILING_MB}MB ceiling — restarting`);
      stopWorktree(repo, name, port, { drain: false });
      if (port) spawnWorktree(repo, name, port);
    }
  }
}

setInterval(checkMemoryCeilings, MEM_CHECK_INTERVAL);

// Rebuild merged ingress and restart the single tunnel process for all enabled worktrees
;(async () => {
  syncHosts(WORKSPACE);
  reconcileDevServers();
  reconcileTriggerSidecars();
  const wts = await getWorktrees().catch(() => []);
  for (const w of wts) {
    if (w.tunnelOn) activeTunnelMap.set(w.key, { pubDom: w.pubDomain, port: w.port });
  }
  if (activeTunnelMap.size > 0) restartTunnel();
})();

Bun.serve({
  port: PORT,
  // Both routes serve the identical SPA shell — the client-side router (app.tsx)
  // reads location.pathname itself. Needed so a hard refresh or a direct link
  // to /worktree/:repo/:name doesn't 404 (client-side pushState alone only
  // handles in-app navigation, not a fresh page load hitting the server).
  routes: { '/': indexPage, '/worktree/:repo/:name': indexPage, '/settings': indexPage, '/help': indexPage, '/ports': indexPage },
  fetch: handle,
  development: false,
});
console.log(`Portal → http://quivly.local  (localhost:${PORT})`);
