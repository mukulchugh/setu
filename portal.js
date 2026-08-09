#!/usr/bin/env bun
// Dev portal — http://quivly.local

import { readFileSync, writeFileSync, appendFileSync, unlinkSync, mkdirSync, statSync, renameSync, openSync, existsSync } from 'fs';
import { execFileSync, spawnSync } from 'child_process';
import { tmpdir } from 'os';
import { join } from 'path';
// Bun bundles + transpiles the Preact UI referenced by this page at serve time
import indexPage from './portal/index.html';
import {
  PORTAL_PORT, CLOUDFLARED_BIN,
  requireConfig, localDomain, publicDomain, envLocalPath, tunnelEnabled,
  parseEnvFile, pinnedTriggerVersion,
  readEnvrc, configureWorktreeEnv, reloadCaddy, syncHosts,
  portEntries, getPort, activePid, listActivePorts, processCwd, loadProjects, registerProject,
  git, branchExists, createWorktree as libCreateWorktree, removeWorktree as libRemoveWorktree,
  AGENT_CLIS, detectAgentClis, loadSidecars,
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

// ── repo metadata ─────────────────────────────────────────────────────────────

let REPO_META = loadProjects(WORKSPACE);

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
  const pid = activePid(port);
  if (!pid) return { ok: false, error: 'nothing on that port' };
  try { process.kill(parseInt(pid), 'SIGTERM'); return { ok: true }; }
  catch (e) { return { ok: false, error: String(e) }; }
}

// Bun's Subprocess.kill() only signals the direct child PID, not its process group
// (confirmed: not exposed to JS). Sidecars are spawned with detached:true (setsid),
// making their pid the process-group id too — send the signal to the whole group so
// children (e.g. trigger dev's esbuild watcher) die even if the parent's own exit
// handler doesn't cascade to them (trigger.dev CLI v4.5.3 has exactly this bug).
// Don't assume pid==pgid: that only holds for detached:true spawns. A sidecar
// reconciled from before this portal started (see reconcileTriggerSidecars) keeps
// whatever pgid it was originally given — look it up rather than guess, or the
// kill silently targets a group that doesn't exist and nothing dies.
// Only send -pgid when pid IS the group leader (pgid === pid) — same guard
// kill-with-style uses. A freshly-spawned (detached:true) sidecar is always
// its own leader, so this always fires for the normal case. A *reconciled*
// pid (adopted from before this portal instance existed — see
// reconcileTriggerSidecars/reconcileDevServers) might have inherited a pgid
// from whatever spawned it originally; that group could contain processes
// Setu never created and doesn't own. Without this guard, killing that group
// could take out unrelated siblings — worst case, even Setu's own group, if
// the pgid happens to collide. Fall back to a plain single-pid kill instead.
function killGroup(pid, signal = 'TERM') {
  let pgid = pid;
  try {
    const out = execFileSync('ps', ['-o', 'pgid=', '-p', String(pid)], { encoding: 'utf8' }).trim();
    if (out) pgid = parseInt(out, 10);
  } catch {}
  const target = pgid === pid ? `-${pgid}` : String(pid);
  try { execFileSync('kill', [`-${signal}`, '--', target], { stdio: 'ignore' }); return true; }
  catch { return false; }
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
      return {
        key, repo, name, slug, port, domain, pubDomain: publicDomain(_cfg), tunnelOn,
        active:        activePorts.has(port),
        queued:        queuePosition(key) !== null,
        queuePosition: queuePosition(key),
        tunnelRunning: tunnelProc !== null && activeTunnelMap.has(key),
        label:         meta.label,
        branchUrl,
        pr:            pr?.url ? { url: pr.url, number: pr.number, title: pr.title } : null,
        inngestActive: inngestProcs.has(key) || activePorts.has(iPort),
        inngestPort:   iPort,
        triggerActive: triggerProcs.has(key),
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
const MAX_CONCURRENT_DEV = _cfg.maxConcurrentDevServers ?? 3;
const startQueue = []; // [{ key, repo, name, port }], FIFO

function queuePosition(key) {
  const i = startQueue.findIndex(q => q.key === key);
  return i === -1 ? null : i + 1;
}

function drainQueue() {
  while (startQueue.length && procs.size < MAX_CONCURRENT_DEV) {
    const next = startQueue.shift();
    if (procs.has(next.key)) continue; // started some other way already
    spawnWorktree(next.repo, next.name, next.port);
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

// Boot-time only: procs starts empty on every portal restart, same blind spot
// reconcileTriggerSidecars() fixes for Trigger — without this, a dev server
// that predates this portal instance (e.g. still running from before a
// restart) doesn't count against MAX_CONCURRENT_DEV, so the cap silently
// undercounts real concurrent servers. Unlike Trigger, dev servers do bind a
// port, so this reuses the same batched scan getWorktrees() already does.
function reconcileDevServers() {
  const activePorts = new Map(listActivePorts().map(p => [p.port, p.pid]));
  for (const { key, port } of portEntries(WORKSPACE)) {
    if (procs.has(key)) continue;
    const pid = activePorts.get(port);
    if (pid) procs.set(key, wrapPid(+pid));
  }
}

function startWorktree(repo, name, port) {
  const key = `${repo}/${name}`;
  if (procs.has(key)) return { ok: false, error: 'already running' };
  if (queuePosition(key)) return { ok: true, queued: true, position: queuePosition(key) };
  if (procs.size >= MAX_CONCURRENT_DEV) {
    startQueue.push({ key, repo, name, port });
    return { ok: true, queued: true, position: startQueue.length };
  }
  spawnWorktree(repo, name, port);
  return { ok: true };
}

function stopWorktree(repo, name, port) {
  const qi = startQueue.findIndex(q => q.key === `${repo}/${name}`);
  if (qi !== -1) startQueue.splice(qi, 1);
  procs.delete(`${repo}/${name}`);
  const pid = activePid(port);
  if (pid) { try { execFileSync('kill', [pid]); } catch {} }
  stopInngest(repo, name, port);
  stopTrigger(repo, name);
  stopSidecars(repo, name);
  drainQueue(); // don't wait on the killed process's async .then() to free the slot
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

function enableTunnel(repo, name, port) {
  // Only one worktree can use the shared tunnel URL — evict any currently active one
  for (const [key, { port: p }] of activeTunnelMap.entries()) {
    if (key === `${repo}/${name}`) continue;
    const si = key.indexOf('/');
    disableTunnel(key.slice(0, si), key.slice(si + 1), p);
  }
  const pubDom = publicDomain(_cfg);
  const wasRunning = !!activePid(port);
  if (wasRunning) stopWorktree(repo, name, port);
  configureWorktreeEnv(_cfg, repo, name, port, true);
  reloadCaddy(WORKSPACE);
  addTunnelRoute(repo, name, pubDom, port);
  // spawnWorktree, not startWorktree — this is resuming something that was
  // already running a moment ago, not a fresh admission decision, so it
  // shouldn't get stuck behind the concurrency queue.
  if (wasRunning) spawnWorktree(repo, name, port);
  return { ok: true };
}

function disableTunnel(repo, name, port) {
  const wasRunning = !!activePid(port);
  if (wasRunning) stopWorktree(repo, name, port);
  removeTunnelRoute(repo, name);
  configureWorktreeEnv(_cfg, repo, name, port, false);
  reloadCaddy(WORKSPACE);
  if (wasRunning) spawnWorktree(repo, name, port);
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
  const cmd = AGENT_CLIS[tool]?.bin;
  if (!cmd) return { ok: false, error: 'unknown tool' };
  const script = `${tmpdir()}/qdev-${Date.now()}.sh`;
  writeFileSync(script, `#!/bin/zsh\nsource "$HOME/.zshrc"\ncd "${wtDir}"\n${cmd}\nexec zsh -l\n`, { mode: 0o755 });
  Bun.spawn(['ghostty', `--working-directory=${wtDir}`, `--command=${script}`],
    { detached: true, stdio: ['ignore', 'ignore', 'ignore'] });
  return { ok: true };
}

// ── router ────────────────────────────────────────────────────────────────────

async function handle(req) {
  const { pathname } = new URL(req.url);
  const method = req.method;

  if (pathname === '/api/worktrees') return Response.json(await getWorktrees());

  if (pathname === '/api/agents') return Response.json(detectAgentClis());

  if (pathname === '/api/projects') return Response.json(
    Object.entries(loadProjects(WORKSPACE)).map(([name, m]) => ({ name, label: m.label }))
  );

  if (method === 'POST' && pathname === '/api/project/add') {
    const body = await req.json().catch(() => ({}));
    try { return Response.json(addProject(body)); }
    catch (e) { return Response.json({ ok: false, error: String(e) }, { status: 500 }); }
  }

  if (pathname === '/api/logs') {
    const p   = new URL(req.url).searchParams;
    const res = tailLog(p.get('repo'), p.get('name'), p.get('type') ?? 'dev', Number(p.get('n') ?? 150));
    return Response.json(res);
  }

  if (method === 'POST') {
    const body = await req.json().catch(() => ({}));
    const { repo, name, tool, tunnel } = body;
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
      return Response.json(startWorktree(repo, name, port));
    }
    if (pathname === '/api/stop') {
      const port = wtPort(); if (!port) return Response.json({ ok: false }, { status: 404 });
      stopWorktree(repo, name, port); return Response.json({ ok: true });
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

function checkMemoryCeilings() {
  for (const [key, entry] of procs.entries()) {
    const mb = processFootprintMb(entry.pid);
    if (mb > DEV_MEM_CEILING_MB) {
      const si = key.indexOf('/');
      const repo = key.slice(0, si), name = key.slice(si + 1);
      const port = getPort(WORKSPACE, repo, name);
      console.warn(`⚠ ${key} dev server at ${Math.round(mb)}MB, exceeds ${DEV_MEM_CEILING_MB}MB ceiling — restarting`);
      stopWorktree(repo, name, port);
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
  routes: { '/': indexPage },
  fetch: handle,
  development: false,
});
console.log(`Portal → http://quivly.local  (localhost:${PORT})`);
