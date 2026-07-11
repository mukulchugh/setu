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
  portEntries, getPort, activePid, loadProjects, registerProject,
  git, branchExists, createWorktree as libCreateWorktree, removeWorktree as libRemoveWorktree,
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

function listActivePorts() {
  try {
    const out = execFileSync('lsof', ['-i', 'TCP:3000-3999', '-sTCP:LISTEN', '-nP', '-F', 'pcn'],
      { stdio: ['ignore', 'pipe', 'ignore'] }).toString();
    const results = []; let cur = {};
    for (const line of out.split('\n')) {
      if (line.startsWith('p')) cur = { pid: line.slice(1) };
      else if (line.startsWith('c')) cur.cmd = line.slice(1);
      else if (line.startsWith('n')) { const m = line.match(/:(\d+)$/); if (m) results.push({ port: +m[1], pid: cur.pid, cmd: cur.cmd }); }
    }
    return results;
  } catch { return []; }
}

function killPort(port) {
  const pid = activePid(port);
  if (!pid) return { ok: false, error: 'nothing on that port' };
  try { process.kill(parseInt(pid), 'SIGTERM'); return { ok: true }; }
  catch (e) { return { ok: false, error: String(e) }; }
}

async function getWorktrees() {
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
        active:        !!activePid(port),
        tunnelRunning: tunnelProc !== null && activeTunnelMap.has(key),
        label:         meta.label,
        branchUrl,
        pr:            pr?.url ? { url: pr.url, number: pr.number, title: pr.title } : null,
        inngestActive: inngestProcs.has(key),
        inngestPort:   iPort,
        triggerActive: triggerProcs.has(key),
      };
    })
  );
}

// ── dev server ────────────────────────────────────────────────────────────────

function startWorktree(repo, name, port) {
  const key   = `${repo}/${name}`;
  if (procs.has(key)) return { ok: false, error: 'already running' };
  const wtDir = `${WORKSPACE}/${repo}/${name}`;
  const env   = { ...process.env, PORT: String(port) };
  const envrc = readEnvrc(wtDir);
  for (const m of envrc.matchAll(/^export (\w+)=(.+)$/gm)) env[m[1]] = m[2].trim();
  const fd   = openLogFd(repo, name, 'dev');
  const proc = Bun.spawn(['bun', 'dev'], { cwd: wtDir, env, stdout: fd, stderr: fd });
  procs.set(key, proc);
  proc.exited.then(() => procs.delete(key));
  return { ok: true };
}

function stopWorktree(repo, name, port) {
  const proc = procs.get(`${repo}/${name}`);
  if (proc) { proc.kill(); procs.delete(`${repo}/${name}`); }
  const pid = activePid(port);
  if (pid) { try { execFileSync('kill', [pid]); } catch {} }
  stopInngest(repo, name);
  stopTrigger(repo, name);
}

// ── inngest dev server ────────────────────────────────────────────────────────

function startInngest(repo, name, port) {
  const key   = `${repo}/${name}`;
  if (inngestProcs.has(key)) return { ok: false, error: 'already running' };
  const iPort = inngestPort(port);
  const fd    = openLogFd(repo, name, 'inngest');
  const proc  = Bun.spawn(
    [INNGEST_CLI, 'dev', '-p', String(iPort), '-u', `http://localhost:${port}/api/inngest`],
    { stdout: fd, stderr: fd }
  );
  inngestProcs.set(key, proc);
  proc.exited.then(() => inngestProcs.delete(key));
  return { ok: true, port: iPort };
}

function stopInngest(repo, name) {
  const key  = `${repo}/${name}`;
  const proc = inngestProcs.get(key);
  if (!proc) return { ok: false, error: 'not running' };
  proc.kill();
  inngestProcs.delete(key);
  return { ok: true };
}

// ── trigger.dev dev server (per worktree, like inngest) ──────────────────────

function startTrigger(repo, name) {
  const key = `${repo}/${name}`;
  if (triggerProcs.has(key)) return { ok: false, error: 'already running' };
  const wtDir = `${WORKSPACE}/${repo}/${name}`;
  const fd    = openLogFd(repo, name, 'trigger');
  // trigger tasks import Supabase keys etc. from the shared .env.local at load time
  const env   = { ...process.env, ...parseEnvFile(envLocalPath(repo, wtDir)) };
  const proc  = Bun.spawn(['bunx', `trigger.dev@${pinnedTriggerVersion(wtDir)}`, 'dev'],
    { cwd: wtDir, env, stdout: fd, stderr: fd });
  triggerProcs.set(key, proc);
  proc.exited.then(() => triggerProcs.delete(key));
  return { ok: true };
}

function stopTrigger(repo, name) {
  const key  = `${repo}/${name}`;
  const proc = triggerProcs.get(key);
  if (!proc) return { ok: false, error: 'not running' };
  proc.kill();
  triggerProcs.delete(key);
  return { ok: true };
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
  if (wasRunning) startWorktree(repo, name, port);
  return { ok: true };
}

function disableTunnel(repo, name, port) {
  const wasRunning = !!activePid(port);
  if (wasRunning) stopWorktree(repo, name, port);
  removeTunnelRoute(repo, name);
  configureWorktreeEnv(_cfg, repo, name, port, false);
  reloadCaddy(WORKSPACE);
  if (wasRunning) startWorktree(repo, name, port);
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

const TOOL_CMD = { claude: 'claude', codex: 'codex', antigravity: 'antigravity-ide', grok: 'grok' };

function openInGhostty(wtDir, tool) {
  const cmd = TOOL_CMD[tool];
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
      return Response.json(stopInngest(repo, name));
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
    const ports = listActivePorts();
    const registry = Object.fromEntries(portEntries(WORKSPACE).map(e => [e.port, e.key]));
    return Response.json(ports.map(p => ({ ...p, worktree: registry[p.port] ?? null })));
  }

  return new Response('Not found', { status: 404 });
}

// Rebuild merged ingress and restart the single tunnel process for all enabled worktrees
;(async () => {
  syncHosts(WORKSPACE);
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
