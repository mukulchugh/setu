#!/usr/bin/env bun
// Dev portal — http://quivly.local

import { readFileSync, writeFileSync, appendFileSync, unlinkSync, mkdirSync, statSync, renameSync, openSync } from 'fs';
import { execFileSync, execSync } from 'child_process';
import { tmpdir } from 'os';

const _cfg = (() => {
  try { return JSON.parse(readFileSync(`${process.env.HOME}/.setu.json`, 'utf8')); } catch { return {}; }
})();
const WORKSPACE      = _cfg.workspace    ?? (process.env.HOME + '/workspace');
const TUNNEL_NAME    = _cfg.tunnel       ?? 'dev-mukul';
const CF_CREDENTIALS_CFG = _cfg.cfCredentials ?? `${process.env.HOME}/.cloudflared/c11a5c20-51a0-4002-936d-0469636209c1.json`;
const LOGS        = `${WORKSPACE}/logs`;
const CADDYFILE   = `${WORKSPACE}/Caddyfile`;
const PORT        = 2999;
const CLOUDFLARED = '/opt/homebrew/bin/cloudflared';
const LOG_MAX_BYTES = 5 * 1024 * 1024; // rotate at 5 MB

const procs        = new Map();
const inngestProcs = new Map();

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

function loadProjects() {
  try {
    return Object.fromEntries(
      readFileSync(`${WORKSPACE}/.projects`, 'utf8').split('\n')
        .filter(l => l.trim() && !l.startsWith('#'))
        .map(l => {
          const [name, base, slug, label] = l.split(':');
          return [name, { label: label?.trim() ?? name, github: `https://github.com/${slug}`, base: +base }];
        })
    );
  } catch { return {}; }
}

const REPO_META = loadProjects();

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
      '--repo', REPO_META[repo]?.github.replace('https://github.com/', '') ?? repo,
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

function portsRaw() {
  try { return readFileSync(`${WORKSPACE}/.ports`, 'utf8').trim(); } catch { return ''; }
}

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
  try {
    const pid = execFileSync('lsof', ['-i', `:${port}`, '-sTCP:LISTEN', '-t'],
      { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
    if (!pid) return { ok: false, error: 'nothing on that port' };
    process.kill(parseInt(pid), 'SIGTERM');
    return { ok: true };
  } catch (e) { return { ok: false, error: String(e) }; }
}

function activePid(port) {
  try {
    return execFileSync('lsof', ['-i', `:${port}`, '-sTCP:LISTEN', '-t'],
      { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
  } catch { return ''; }
}

function readEnvrc(wtDir) {
  try { return readFileSync(`${wtDir}/.envrc`, 'utf8'); } catch { return ''; }
}

function localDomain(repo, name)  {
  const slug = name.replace(/\//g, '-');
  return name === 'main' ? `${repo}.quivly.local` : `${slug}.quivly.local`;
}
function publicDomain() {
  return _cfg.domain ?? 'dev-mukul.getquivly.ai';
}
function hasTunnel(wtDir, repo, name) {
  const slug = name.replace(/\//g, '-');
  return readEnvrc(wtDir).includes(publicDomain(repo, name, slug));
}

async function getWorktrees() {
  return Promise.all(
    portsRaw().split('\n').filter(Boolean).map(async line => {
      const colonIdx = line.lastIndexOf(':');
      const key      = line.slice(0, colonIdx);
      const port     = parseInt(line.slice(colonIdx + 1), 10);
      const slashIdx = key.indexOf('/');
      const repo     = key.slice(0, slashIdx);
      const name     = key.slice(slashIdx + 1);
      const slug     = name.replace(/\//g, '-');
      const domain   = localDomain(repo, name);
      const wtDir    = `${WORKSPACE}/${repo}/${name}`;
      const tunnelOn = hasTunnel(wtDir, repo, name);
      const pubDomain = publicDomain(repo, name, slug);
      const meta     = REPO_META[repo] ?? { label: repo, github: null };
      const branchUrl = meta.github ? `${meta.github}/tree/${name}` : null;
      const pr        = name !== 'main' ? await fetchPR(repo, name) : null;
      const iPort = inngestPort(port);
      return {
        key, repo, name, slug, port, domain, pubDomain, tunnelOn,
        active:        !!activePid(port),
        tunnelRunning: tunnelProc !== null && activeTunnelMap.has(key),
        label:         meta.label,
        branchUrl,
        pr:            pr?.url ? { url: pr.url, number: pr.number, title: pr.title } : null,
        inngestActive: inngestProcs.has(key),
        inngestPort:   iPort,
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
  if (activeTunnelMap.size === 0) return;
  writeMergedConf();
  const fd = openTunnelLog();
  tunnelProc = Bun.spawn(
    [CLOUDFLARED, '--config', MERGED_CONF, 'tunnel', 'run', TUNNEL_NAME],
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

function reloadCaddy() {
  try {
    // stdio: 'inherit' so sudo password prompt (if any) works against the real TTY
    // even when the portal server itself was started with output redirected.
    execSync(`sudo caddy reload --config ${CADDYFILE}`, { stdio: 'inherit' });
  } catch {
    console.error(`⚠️  Caddy reload failed. You may need to run:\n    sudo caddy reload --config ${CADDYFILE}`);
  }
}

function syncHosts() {
  const raw = readFileSync('/etc/hosts', 'utf8');
  const cleaned = raw.replace(/\n?# quivly-start[\s\S]*?# quivly-end\n?/, '');
  const entries = portsRaw().split('\n').filter(Boolean).map(line => {
    const colonIdx = line.lastIndexOf(':');
    const key = line.slice(0, colonIdx);
    const slashIdx = key.indexOf('/');
    return `127.0.0.1\t${localDomain(key.slice(0, slashIdx), key.slice(slashIdx + 1))}`;
  });
  const newContent = cleaned.trimEnd() + '\n# quivly-start\n' + entries.join('\n') + '\n# quivly-end\n';
  writeFileSync('/tmp/quivly-hosts', newContent);
  try { execSync('sudo -n cp /tmp/quivly-hosts /etc/hosts', { stdio: 'ignore' }); } catch {}
}

function writeEnvrc(wtDir, port, appUrl, redirectUri) {
  writeFileSync(`${wtDir}/.envrc`,
    `export PORT=${port}\nexport NEXT_PUBLIC_APP_BASE_URL=${appUrl}\nexport NEXT_PUBLIC_WORKOS_REDIRECT_URI=${redirectUri}\n`);
  execSync(`direnv allow "${wtDir}"`);
}

function writeCaddy(repo, slug, localDom, port, pubDom) {
  const body = pubDom
    ? `http://${localDom},\nhttp://${pubDom} {\n  reverse_proxy localhost:${port}\n}\n`
    : `http://${localDom} {\n  reverse_proxy localhost:${port}\n}\n`;
  writeFileSync(`${WORKSPACE}/caddy.d/${repo}-${slug}.caddy`, body);
  reloadCaddy();
}

function enableTunnel(repo, name, port) {
  // Only one worktree can use the shared tunnel URL — evict any currently active one
  for (const [key, { port: p }] of activeTunnelMap.entries()) {
    if (key === `${repo}/${name}`) continue;
    const si = key.indexOf('/');
    disableTunnel(key.slice(0, si), key.slice(si + 1), p);
  }
  const slug     = name.replace(/\//g, '-');
  const wtDir    = `${WORKSPACE}/${repo}/${name}`;
  const localDom = localDomain(repo, name);
  const pubDom   = publicDomain();
  const wasRunning = !!activePid(port);
  if (wasRunning) stopWorktree(repo, name, port);
  writeEnvrc(wtDir, port, `https://${pubDom}`, `https://${pubDom}/authentication/callback`);
  writeCaddy(repo, slug, localDom, port, pubDom);
  addTunnelRoute(repo, name, pubDom, port);
  if (wasRunning) startWorktree(repo, name, port);
  return { ok: true };
}

function disableTunnel(repo, name, port) {
  const slug     = name.replace(/\//g, '-');
  const wtDir    = `${WORKSPACE}/${repo}/${name}`;
  const localDom = localDomain(repo, name);
  const wasRunning = !!activePid(port);
  if (wasRunning) stopWorktree(repo, name, port);
  removeTunnelRoute(repo, name);
  writeEnvrc(wtDir, port, `http://${localDom}`, `http://localhost:${port}/authentication/callback`);
  writeCaddy(repo, slug, localDom, port, null);
  if (wasRunning) startWorktree(repo, name, port);
  return { ok: true };
}

// ── create / remove worktree ──────────────────────────────────────────────────

function nextPort(repo) {
  const base = REPO_META[repo]?.base ?? 3200;
  const existing = portsRaw();
  let port = base;
  while (existing.includes(`:${port}`) || activePid(port)) port++;
  return port;
}

function branchExists(repoDir, name) {
  for (const ref of [`refs/heads/${name}`, `refs/remotes/origin/${name}`]) {
    try { execFileSync('git', ['-C', repoDir, 'show-ref', '--verify', '--quiet', ref]); return true; }
    catch {}
  }
  return false;
}

function createWorktree(repo, name, tunnel) {
  const slug    = name.replace(/\//g, '-');
  const repoDir = `${WORKSPACE}/${repo}.git`;
  const wtDir   = `${WORKSPACE}/${repo}/${name}`;

  const port = nextPort(repo);

  execFileSync('git', ['-C', repoDir, 'fetch', '--all', '--prune']);
  execFileSync('git', ['-C', repoDir, 'worktree', 'prune']);
  if (branchExists(repoDir, name)) {
    execFileSync('git', ['-C', repoDir, 'worktree', 'add', wtDir, name]);
  } else {
    execFileSync('git', ['-C', repoDir, 'worktree', 'add', '-b', name, wtDir, 'origin/staging']);
  }

  appendFileSync(`${WORKSPACE}/.ports`, `${repo}/${name}:${port}\n`);

  const localDom = localDomain(repo, name);
  const pubDom   = publicDomain(repo, name, slug);

  if (tunnel) {
    writeEnvrc(wtDir, port, `https://${pubDom}`, `https://${pubDom}/authentication/callback`);
    writeCaddy(repo, slug, localDom, port, pubDom);
    addTunnelRoute(repo, name, pubDom, port);
  } else {
    writeEnvrc(wtDir, port, `http://${localDom}`, `http://localhost:${port}/authentication/callback`);
    writeCaddy(repo, slug, localDom, port, null);
  }
  syncHosts();

  // symlink shared .env.local
  const envSrc = repo === 'quivly-app'
    ? `${WORKSPACE}/${repo}/main/apps/quivly-app/.env.local`
    : `${WORKSPACE}/${repo}/main/.env.local`;
  const envDst = repo === 'quivly-app'
    ? `${wtDir}/apps/quivly-app/.env.local`
    : `${wtDir}/.env.local`;
  try { unlinkSync(envDst); } catch {}
  execSync(`ln -sf "${envSrc}" "${envDst}"`);

  // mise trust + bun install (background — takes a while)
  const setupFd = openLogFd(repo, name, 'setup');
  Bun.spawn(['zsh', '-c', `mise trust "${wtDir}" 2>/dev/null; cd "${wtDir}" && bun install`],
    { stdout: setupFd, stderr: setupFd });

  return { ok: true, port, domain: localDom };
}

function removeWorktree(repo, name) {
  const slug    = name.replace(/\//g, '-');
  const repoDir = `${WORKSPACE}/${repo}.git`;
  const wtDir   = `${WORKSPACE}/${repo}/${name}`;

  // stop dev server and tunnel route first
  const line = portsRaw().split('\n').find(l => l.startsWith(`${repo}/${name}:`));
  if (line) {
    const port = parseInt(line.split(':').at(-1), 10);
    stopWorktree(repo, name, port);
  }
  if (activeTunnelMap.has(`${repo}/${name}`)) removeTunnelRoute(repo, name);

  try {
    execFileSync('git', ['-C', repoDir, 'worktree', 'remove', '--force', wtDir]);
  } catch (e) { return { ok: false, error: String(e) }; }

  // remove from .ports
  const newPorts = portsRaw().split('\n').filter(l => !l.startsWith(`${repo}/${name}:`)).filter(Boolean).join('\n');
  writeFileSync(`${WORKSPACE}/.ports`, newPorts ? newPorts + '\n' : '');

  // remove caddy snippet
  try { unlinkSync(`${WORKSPACE}/caddy.d/${repo}-${slug}.caddy`); } catch {}
  reloadCaddy();
  syncHosts();

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

  // Already registered?
  const projects = readFileSync(`${WORKSPACE}/.projects`, 'utf8').catch?.() ??
    (() => { try { return readFileSync(`${WORKSPACE}/.projects`, 'utf8'); } catch { return ''; } })();
  if (projects.split('\n').some(l => l.startsWith(`${name}:`))) {
    return { ok: false, error: `${name} is already registered` };
  }

  // Assign next free 100-port band
  const usedBases = projects.split('\n')
    .filter(l => l.trim() && !l.startsWith('#'))
    .map(l => parseInt(l.split(':')[1], 10))
    .filter(Boolean);
  let base = 3000;
  while (usedBases.includes(base)) base += 100;

  // Bare clone (existing) or bare init (new)
  mkdirSync(WORKSPACE, { recursive: true });
  if (slug) {
    execFileSync('git', ['clone', '--bare', `git@github.com:${slug}.git`, repoDir]);
    execFileSync('git', ['-C', repoDir, 'config', 'remote.origin.fetch', '+refs/heads/*:refs/remotes/origin/*']);
    execFileSync('git', ['-C', repoDir, 'fetch', '--all', '--prune']);
  } else {
    mkdirSync(repoDir, { recursive: true });
    execFileSync('git', ['-C', repoDir, 'init', '--bare']);
  }

  // Register in .projects
  appendFileSync(`${WORKSPACE}/.projects`, `${name}:${base}:${slug}:${label_}\n`);

  return { ok: true, name, base, slug: slug || null, label: label_ };
}

// ── open in Ghostty ───────────────────────────────────────────────────────────

const TOOL_CMD = { claude: 'claude', codex: 'codex', antigravity: 'antigravity-ide', grok: 'grok' };

function openInGhostty(wtDir, tool) {
  const cmd = TOOL_CMD[tool];
  if (!cmd) return { ok: false, error: 'unknown tool' };
  const script = `${tmpdir()}/qdev-${Date.now()}.sh`;
  writeFileSync(script, `#!/bin/zsh\nsource "$HOME/.zshrc"\ncd "${wtDir}"\n${cmd}\nexec zsh -l\n`);
  execSync(`chmod +x "${script}"`);
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
    Object.entries(loadProjects()).map(([name, m]) => ({ name, label: m.label }))
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
    const portLine = () => portsRaw().split('\n').find(l => l.startsWith(`${repo}/${name}:`));
    const getPort  = () => { const l = portLine(); return l ? parseInt(l.split(':').at(-1), 10) : null; };

    if (pathname === '/api/create') {
      try { return Response.json(createWorktree(repo, name, !!tunnel)); }
      catch (e) { return Response.json({ ok: false, error: String(e) }, { status: 500 }); }
    }
    if (pathname === '/api/remove') {
      return Response.json(removeWorktree(repo, name));
    }
    if (pathname === '/api/start') {
      const port = getPort(); if (!port) return Response.json({ ok: false }, { status: 404 });
      return Response.json(startWorktree(repo, name, port));
    }
    if (pathname === '/api/stop') {
      const port = getPort(); if (!port) return Response.json({ ok: false }, { status: 404 });
      stopWorktree(repo, name, port); return Response.json({ ok: true });
    }
    if (pathname === '/api/tunnel/enable') {
      const port = getPort(); if (!port) return Response.json({ ok: false }, { status: 404 });
      return Response.json(enableTunnel(repo, name, port));
    }
    if (pathname === '/api/tunnel/disable') {
      const port = getPort(); if (!port) return Response.json({ ok: false }, { status: 404 });
      return Response.json(disableTunnel(repo, name, port));
    }
    if (pathname === '/api/inngest/start') {
      const port = getPort(); if (!port) return Response.json({ ok: false }, { status: 404 });
      return Response.json(startInngest(repo, name, port));
    }
    if (pathname === '/api/inngest/stop') {
      return Response.json(stopInngest(repo, name));
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
    const registry = Object.fromEntries(
      portsRaw().split('\n').filter(Boolean).map(l => { const ci = l.lastIndexOf(':'); return [+l.slice(ci+1), l.slice(0,ci)]; })
    );
    return Response.json(ports.map(p => ({ ...p, worktree: registry[p.port] ?? null })));
  }

  if (pathname === '/') return new Response(HTML, { headers: { 'content-type': 'text/html; charset=utf-8' } });
  return new Response('Not found', { status: 404 });
}

// ── UI ────────────────────────────────────────────────────────────────────────

const HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>setu</title>
<script async src="https://cdn.tailwindcss.com"></script>
<style>
.icon-btn { display:inline-flex; align-items:center; justify-content:center; width:2rem; height:2rem; border-radius:9999px; background:rgba(255,255,255,0.55); backdrop-filter:blur(8px); -webkit-backdrop-filter:blur(8px); border:1px solid rgba(255,255,255,0.75); box-shadow:0 1px 3px rgba(0,0,0,0.07); transition:background 0.15s,color 0.15s,box-shadow 0.15s; flex-shrink:0; }
.icon-btn:hover { background:rgba(255,255,255,0.85); box-shadow:0 2px 8px rgba(0,0,0,0.12); }
.tip { position:relative; }
.tip::after { content:attr(data-tip); position:absolute; bottom:calc(100% + 6px); left:50%; transform:translateX(-50%); background:#18181B; color:#fff; font-size:11px; padding:3px 8px; border-radius:5px; white-space:nowrap; opacity:0; pointer-events:none; transition:opacity 0.12s; z-index:100; font-family:-apple-system,sans-serif; }
.tip:hover::after { opacity:1; }
@keyframes spin { to { transform:rotate(360deg); } }
.spin { animation:spin 0.7s linear infinite; }
#create-modal.flex { display:flex; }
#log-modal.flex { display:flex; }
.log-tab.active { background:white; color:#18181B; box-shadow:0 1px 2px rgba(0,0,0,.08); }
.log-tab:not(.active) { color:#71717A; }
.log-tab:not(.active):hover { color:#3F3F46; }
</style>
<body class="min-h-screen bg-zinc-50 text-zinc-700 antialiased" style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif">

<div class="max-w-5xl mx-auto px-6 py-12">

  <!-- header -->
  <div class="flex items-center justify-between mb-6">
    <div>
      <h1 class="text-xl font-semibold text-zinc-900 tracking-tight">setu</h1>
      <p class="text-sm text-zinc-400 mt-0.5 flex items-center gap-1.5">
        <span class="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse inline-block"></span>dev portal
      </p>
    </div>
    <div class="flex items-center gap-3">
      <select id="filter-repo" onchange="applyFilter()"
        class="bg-white border border-zinc-200 text-zinc-700 text-sm rounded-lg px-3 py-1.5 focus:outline-none focus:border-zinc-400">
        <option value="all">All</option>
      </select>
      <button onclick="openAddProjectModal()"
        class="text-sm font-medium px-4 py-1.5 rounded-lg border border-zinc-200 text-zinc-600 hover:bg-zinc-50 transition-colors">
        + Project
      </button>
      <button onclick="openCreateModal()"
        class="text-sm font-medium px-4 py-1.5 rounded-lg bg-zinc-900 text-white hover:bg-zinc-700 transition-colors">
        + Worktree
      </button>
    </div>
  </div>

  <!-- worktree list -->
  <div id="grid" class="flex flex-col gap-2.5">
    <p class="text-zinc-400 text-sm py-10 text-center">Loading…</p>
  </div>

  <!-- ports panel -->
  <div class="mt-8">
    <button onclick="togglePortsPanel()" class="flex items-center gap-2 text-xs font-medium text-zinc-400 hover:text-zinc-600 transition-colors mb-3">
      <svg id="ports-chevron" class="w-3.5 h-3.5 transition-transform" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M9 5l7 7-7 7"/></svg>
      Active ports (3000–3999)
    </button>
    <div id="ports-panel" class="hidden">
      <div id="ports-list" class="bg-white border border-zinc-200 rounded-xl overflow-hidden text-xs">
        <p class="text-zinc-400 px-4 py-3">Loading…</p>
      </div>
    </div>
  </div>

</div>

<!-- log viewer modal -->
<div id="log-modal" class="fixed inset-0 bg-black/40 backdrop-blur-sm z-50 hidden items-end justify-stretch" onclick="if(event.target===this) closeLogModal()">
  <div class="bg-white border-t border-zinc-200 shadow-2xl w-full" style="height:60vh; display:flex; flex-direction:column;">
    <div class="flex items-center gap-3 px-5 py-3 border-b border-zinc-100 shrink-0">
      <div class="flex gap-1 bg-zinc-100 rounded-lg p-0.5">
        <button onclick="switchLogTab('dev')" id="log-tab-dev" class="log-tab active text-xs font-medium px-3 py-1 rounded-md transition-colors">Dev server</button>
        <button onclick="switchLogTab('tunnel')" id="log-tab-tunnel" class="log-tab text-xs font-medium px-3 py-1 rounded-md transition-colors">Tunnel</button>
        <button onclick="switchLogTab('inngest')" id="log-tab-inngest" class="log-tab text-xs font-medium px-3 py-1 rounded-md transition-colors">Inngest</button>
        <button onclick="switchLogTab('setup')" id="log-tab-setup" class="log-tab text-xs font-medium px-3 py-1 rounded-md transition-colors">Setup</button>
      </div>
      <span id="log-title" class="text-xs text-zinc-400 flex-1"></span>
      <button onclick="copyLogToClipboard()" data-tip="Copy all" class="tip icon-btn text-zinc-400 hover:text-zinc-600 hover:bg-zinc-100">
        <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
      </button>
      <button onclick="closeLogModal()" class="icon-btn text-zinc-400 hover:text-zinc-600 hover:bg-zinc-100">
        <svg class="w-4 h-4" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12"/></svg>
      </button>
    </div>
    <pre id="log-output" class="flex-1 overflow-auto text-[11px] leading-relaxed font-mono text-zinc-600 bg-zinc-50 px-5 py-4 whitespace-pre-wrap break-all">Loading…</pre>
  </div>
</div>

<!-- add project modal -->
<div id="add-project-modal" class="fixed inset-0 bg-black/40 backdrop-blur-sm z-50 hidden items-center justify-center" onclick="if(event.target===this) closeAddProjectModal()">
  <div class="bg-white rounded-2xl border border-zinc-200 shadow-2xl p-6 w-full max-w-sm mx-4">
    <div class="flex items-center justify-between mb-5">
      <div>
        <h2 class="text-base font-semibold text-zinc-900">Add project</h2>
        <p class="text-xs text-zinc-400 mt-0.5">Register a new or existing repo</p>
      </div>
      <button onclick="closeAddProjectModal()" class="w-7 h-7 flex items-center justify-center rounded-lg text-zinc-400 hover:text-zinc-600 hover:bg-zinc-100 transition-colors">
        <svg class="w-4 h-4" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12"/></svg>
      </button>
    </div>
    <div class="flex flex-col gap-4">
      <div class="flex gap-1 bg-zinc-100 rounded-lg p-0.5 mb-1">
        <button id="proj-tab-existing" onclick="switchProjTab('existing')"
          class="proj-tab flex-1 text-xs font-medium py-1.5 rounded-md transition-colors bg-white text-zinc-900 shadow-sm">
          Existing repo
        </button>
        <button id="proj-tab-new" onclick="switchProjTab('new')"
          class="proj-tab flex-1 text-xs font-medium py-1.5 rounded-md transition-colors text-zinc-500">
          New repo
        </button>
      </div>

      <!-- existing: GitHub URL -->
      <div id="proj-existing-fields">
        <div class="flex flex-col gap-1.5">
          <label class="text-xs text-zinc-500">GitHub URL or slug</label>
          <input id="proj-github" placeholder="org/repo or https://github.com/org/repo" autocomplete="off"
            class="bg-white border border-zinc-200 text-zinc-800 text-sm rounded-lg px-3 py-2 focus:outline-none focus:border-zinc-400 placeholder-zinc-400"
            oninput="deriveProjName()">
        </div>
      </div>

      <!-- new: bare name only -->
      <div id="proj-new-fields" class="hidden">
        <div class="flex flex-col gap-1.5">
          <label class="text-xs text-zinc-500">Repo name</label>
          <input id="proj-newname" placeholder="my-new-project" autocomplete="off"
            class="bg-white border border-zinc-200 text-zinc-800 text-sm rounded-lg px-3 py-2 focus:outline-none focus:border-zinc-400 placeholder-zinc-400">
          <p class="text-[11px] text-zinc-400">Creates a bare local repo at ~/workspace/&lt;name&gt;.git — push a remote later.</p>
        </div>
      </div>

      <div class="flex flex-col gap-1.5">
        <label class="text-xs text-zinc-500">Label <span class="text-zinc-300">(optional)</span></label>
        <input id="proj-label" placeholder="My App" autocomplete="off"
          class="bg-white border border-zinc-200 text-zinc-800 text-sm rounded-lg px-3 py-2 focus:outline-none focus:border-zinc-400 placeholder-zinc-400">
      </div>

      <p id="proj-status" class="text-xs text-zinc-500 hidden"></p>

      <div class="flex gap-3 pt-1">
        <button onclick="closeAddProjectModal()"
          class="flex-1 text-sm font-medium px-4 py-2 rounded-lg border border-zinc-200 text-zinc-600 hover:bg-zinc-50 transition-colors">
          Cancel
        </button>
        <button id="proj-btn" onclick="submitAddProject()"
          class="flex-1 text-sm font-medium px-4 py-2 rounded-lg bg-zinc-900 text-white hover:bg-zinc-700 transition-colors">
          Add
        </button>
      </div>
    </div>
  </div>
</div>

<!-- new worktree modal -->
<div id="create-modal" class="fixed inset-0 bg-black/40 backdrop-blur-sm z-50 hidden items-center justify-center" onclick="if(event.target===this) closeCreateModal()">
  <div class="bg-white rounded-2xl border border-zinc-200 shadow-2xl p-6 w-full max-w-sm mx-4">
    <div class="flex items-center justify-between mb-5">
      <h2 class="text-base font-semibold text-zinc-900">New worktree</h2>
      <button onclick="closeCreateModal()" class="w-7 h-7 flex items-center justify-center rounded-lg text-zinc-400 hover:text-zinc-600 hover:bg-zinc-100 transition-colors">
        <svg class="w-4 h-4" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12"/></svg>
      </button>
    </div>
    <div class="flex flex-col gap-4">
      <div class="flex flex-col gap-1.5">
        <label class="text-xs text-zinc-500">Repo</label>
        <select id="create-repo"
          class="bg-white border border-zinc-200 text-zinc-800 text-sm rounded-lg px-3 py-2 focus:outline-none focus:border-zinc-400">
        </select>
      </div>
      <div class="flex flex-col gap-1.5">
        <label class="text-xs text-zinc-500">Branch name</label>
        <input id="create-name" placeholder="feat-my-feature" autocomplete="off"
          class="bg-white border border-zinc-200 text-zinc-800 text-sm rounded-lg px-3 py-2 focus:outline-none focus:border-zinc-400 placeholder-zinc-400"
          onkeydown="if(event.key==='Enter') createWorktree()">
      </div>
      <div class="flex items-center gap-2">
        <input type="checkbox" id="create-tunnel" class="accent-sky-500">
        <label for="create-tunnel" class="text-xs text-zinc-500">Enable tunnel</label>
      </div>
      <p id="create-status" class="text-xs text-zinc-500 hidden"></p>
      <div class="flex gap-3 pt-1">
        <button onclick="closeCreateModal()"
          class="flex-1 text-sm font-medium px-4 py-2 rounded-lg border border-zinc-200 text-zinc-600 hover:bg-zinc-50 transition-colors">
          Cancel
        </button>
        <button id="create-btn" onclick="createWorktree()"
          class="flex-1 text-sm font-medium px-4 py-2 rounded-lg bg-zinc-900 text-white hover:bg-zinc-700 transition-colors">
          Create
        </button>
      </div>
    </div>
  </div>
</div>

<script>
let allWorktrees = [];
let activeMenu   = null;
let logState     = { repo: null, name: null, type: 'dev', timer: null };
const pendingStart = new Set();
let fastPollTimer  = null;

async function loadProjectDropdowns(refresh = false) {
  const projects = await fetch('/api/projects').then(r => r.json()).catch(() => []);
  const filter   = document.getElementById('filter-repo');
  const create   = document.getElementById('create-repo');
  if (refresh) {
    filter.innerHTML = '<option value="all">All</option>';
    create.innerHTML = '';
  }
  projects.forEach(({ name, label }) => {
    filter.insertAdjacentHTML('beforeend', \`<option value="\${name}">\${label}</option>\`);
    create.insertAdjacentHTML('beforeend', \`<option value="\${name}">\${label}</option>\`);
  });
}

function applyFilter() { renderWorktrees(allWorktrees); }

let projTab = 'existing';

function switchProjTab(tab) {
  projTab = tab;
  ['existing','new'].forEach(t => {
    const btn = document.getElementById('proj-tab-' + t);
    btn.className = 'proj-tab flex-1 text-xs font-medium py-1.5 rounded-md transition-colors ' +
      (t === tab ? 'bg-white text-zinc-900 shadow-sm' : 'text-zinc-500');
    document.getElementById('proj-' + t + '-fields').classList.toggle('hidden', t !== tab);
  });
  setTimeout(() => {
    (tab === 'existing'
      ? document.getElementById('proj-github')
      : document.getElementById('proj-newname')).focus();
  }, 50);
}

function deriveProjName() {
  const val = document.getElementById('proj-github').value.trim()
    .replace('https://github.com/', '').replace('http://github.com/', '')
    .replace('git@github.com:', '').replace('.git', '');
  const name = val.split('/').at(-1) ?? '';
  if (name && !document.getElementById('proj-label').value)
    document.getElementById('proj-label').placeholder = name;
}

function openAddProjectModal() {
  const m = document.getElementById('add-project-modal');
  m.classList.remove('hidden'); m.classList.add('flex');
  switchProjTab('existing');
}

function closeAddProjectModal() {
  const m = document.getElementById('add-project-modal');
  m.classList.add('hidden'); m.classList.remove('flex');
  ['proj-github','proj-newname','proj-label'].forEach(id => { document.getElementById(id).value = ''; });
  const s = document.getElementById('proj-status');
  s.textContent = ''; s.classList.add('hidden');
  const btn = document.getElementById('proj-btn');
  btn.textContent = 'Add'; btn.disabled = false;
}

async function submitAddProject() {
  const btn    = document.getElementById('proj-btn');
  const status = document.getElementById('proj-status');
  const label  = document.getElementById('proj-label').value.trim();

  let github = '', name = '';
  if (projTab === 'existing') {
    github = document.getElementById('proj-github').value.trim();
    if (!github) { document.getElementById('proj-github').focus(); return; }
  } else {
    name = document.getElementById('proj-newname').value.trim();
    if (!name) { document.getElementById('proj-newname').focus(); return; }
  }

  btn.disabled = true; btn.textContent = 'Adding…';
  status.textContent = projTab === 'existing' ? 'Cloning repo…' : 'Initialising repo…';
  status.classList.remove('hidden');

  const res = await post('/api/project/add', { github, name, label });
  if (res.ok) {
    status.textContent = \`✓ Added \${res.name} (port band \${res.base}–\${res.base + 99})\`;
    await loadProjectDropdowns(true);
    setTimeout(closeAddProjectModal, 1800);
  } else {
    status.textContent = '✗ ' + (res.error ?? 'failed');
    btn.textContent = 'Add'; btn.disabled = false;
  }
}

function openCreateModal() {
  const m = document.getElementById('create-modal');
  m.classList.remove('hidden'); m.classList.add('flex');
  setTimeout(() => document.getElementById('create-name').focus(), 50);
}
function closeCreateModal() {
  const m = document.getElementById('create-modal');
  m.classList.add('hidden'); m.classList.remove('flex');
  document.getElementById('create-name').value = '';
  const s = document.getElementById('create-status');
  s.textContent = ''; s.classList.add('hidden');
  const btn = document.getElementById('create-btn');
  btn.textContent = 'Create'; btn.disabled = false;
}

function toggleMenu(key, e) {
  e.stopPropagation();
  const menu = document.getElementById('menu-' + key);
  const isOpen = !menu.classList.contains('hidden');
  if (activeMenu && activeMenu !== menu) activeMenu.classList.add('hidden');
  menu.classList.toggle('hidden', isOpen);
  activeMenu = isOpen ? null : menu;
}
document.addEventListener('click', () => { if (activeMenu) { activeMenu.classList.add('hidden'); activeMenu = null; } });

async function post(url, body) {
  return fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
    .then(r => r.json());
}

async function createWorktree() {
  const repo   = document.getElementById('create-repo').value;
  const name   = document.getElementById('create-name').value.trim();
  const tunnel = document.getElementById('create-tunnel').checked;
  const btn    = document.getElementById('create-btn');
  const status = document.getElementById('create-status');

  if (!name) { document.getElementById('create-name').focus(); return; }

  btn.disabled   = true;
  btn.textContent = 'Creating…';
  status.textContent = 'Setting up worktree and running bun install in background…';
  status.classList.remove('hidden');

  const res = await post('/api/create', { repo, name, tunnel });
  if (res.ok) {
    status.textContent = \`✓ Created on port \${res.port}\`;
    await refreshWorktrees();
    setTimeout(closeCreateModal, 1200);
  } else {
    status.textContent = '✗ ' + (res.error ?? 'failed');
    btn.textContent = 'Create';
    btn.disabled   = false;
  }
}

async function removeWorktree(repo, name) {
  if (!confirm(\`Remove worktree "\${name}"? The branch will not be deleted.\`)) return;
  await post('/api/remove', { repo, name });
  refreshWorktrees();
}

async function act(url, repo, name) {
  await post(url, { repo, name });
  await refreshWorktrees();
}

async function openTool(repo, name, tool) {
  await post('/api/open', { repo, name, tool });
}

function copyCD(repo, name, btn) {
  const ta = document.createElement('textarea');
  ta.value = \`cd ~/workspace/\${repo}/\${name}\`;
  ta.style.cssText = 'position:fixed;opacity:0;top:0;left:0';
  document.body.appendChild(ta); ta.focus(); ta.select();
  document.execCommand('copy'); document.body.removeChild(ta);
  const prev = btn.innerHTML;
  btn.innerHTML = '<svg class="w-3.5 h-3.5 text-emerald-500" fill="none" stroke="currentColor" stroke-width="2.5" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M5 13l4 4L19 7"/></svg>';
  setTimeout(() => { btn.innerHTML = prev; }, 1500);
}

// ── log viewer ────────────────────────────────────────────────────────────────

const LOG_TAB_CLS     = { active: 'bg-white text-zinc-900 shadow-sm', inactive: 'text-zinc-500 hover:text-zinc-700' };

function switchLogTab(type) {
  logState.type = type;
  ['dev','tunnel','inngest','setup'].forEach(t => {
    const el = document.getElementById('log-tab-' + t);
    el.className = 'log-tab text-xs font-medium px-3 py-1 rounded-md transition-colors ' +
      (t === type ? LOG_TAB_CLS.active : LOG_TAB_CLS.inactive);
  });
  fetchLog();
}

async function fetchLog() {
  const { repo, name, type } = logState;
  if (!repo) return;
  document.getElementById('log-title').textContent = \`\${repo}/\${name} • \${type}.log\`;
  const data = await fetch(\`/api/logs?repo=\${repo}&name=\${encodeURIComponent(name)}&type=\${type}\`).then(r => r.json()).catch(() => ({ lines: [] }));
  const out = document.getElementById('log-output');
  out.textContent = data.lines.length ? data.lines.join('\\n') : '(no log yet — start the dev server first)';
  out.scrollTop = out.scrollHeight;
}

function openLogModal(repo, name) {
  if (activeMenu) { activeMenu.classList.add('hidden'); activeMenu = null; }
  logState.repo = repo; logState.name = name; logState.type = 'dev';
  switchLogTab('dev');
  const m = document.getElementById('log-modal');
  m.classList.remove('hidden'); m.classList.add('flex');
  logState.timer = setInterval(fetchLog, 2000);
}

function closeLogModal() {
  const m = document.getElementById('log-modal');
  m.classList.add('hidden'); m.classList.remove('flex');
  clearInterval(logState.timer); logState.timer = null;
  logState.repo = null; logState.name = null;
}

function copyLogToClipboard() {
  const text = document.getElementById('log-output').textContent;
  navigator.clipboard.writeText(text).catch(() => {});
}

// ── worktree renderer ─────────────────────────────────────────────────────────

function renderWorktrees(wts) {
  allWorktrees = wts;
  const grid = document.getElementById('grid');
  const badgeColors = { App: 'bg-violet-50 text-violet-600 border border-violet-200', Landing: 'bg-sky-50 text-sky-600 border border-sky-200' };
  const filter = document.getElementById('filter-repo')?.value ?? 'all';
  const filtered = filter === 'all' ? wts : wts.filter(w => w.repo === filter);
  if (!filtered.length) {
    grid.innerHTML = '<p class="text-zinc-400 text-sm py-10 text-center">No worktrees' + (filter !== 'all' ? ' for this project' : '') + ' — click + New to create one.</p>';
    return;
  }
  grid.innerHTML = filtered.map(w => {
    const badge = badgeColors[w.label] ?? 'bg-zinc-100 text-zinc-500';
    const key   = w.key.replaceAll('/', '-').replaceAll('.', '_');
    return \`
    <div class="rounded-xl border \${w.active ? 'border-l-[3px] border-l-emerald-400 border-zinc-200 bg-white' : 'border-zinc-200 bg-white'} px-5 py-4 flex items-center gap-4 shadow-sm hover:shadow transition-shadow">

      <!-- meta -->
      <div class="flex-1 min-w-0">
        <div class="flex items-center gap-2 mb-1">
          <span class="text-[11px] font-semibold px-2 py-0.5 rounded-full \${badge} shrink-0">\${w.label}</span>
          <span class="text-zinc-900 font-semibold text-sm truncate">\${w.name}</span>
          <span class="flex items-center gap-1 text-xs \${w.active ? 'text-emerald-600' : 'text-zinc-400'} shrink-0 ml-1">
            <span class="w-1.5 h-1.5 rounded-full \${w.active ? 'bg-emerald-500' : 'bg-zinc-300'}"></span>
            \${w.active ? 'running' : 'stopped'}
          </span>
        </div>
        <div class="flex items-center gap-2 flex-wrap">
          <span class="font-mono text-xs text-zinc-400">\${w.domain}</span>
          \${w.tunnelOn ? \`<span class="font-mono text-xs text-sky-500">\${w.pubDomain}</span>\` : ''}
          \${w.inngestActive ? \`<a href="http://localhost:\${w.inngestPort}" target="_blank" class="flex items-center gap-1 text-xs text-orange-500 hover:text-orange-600 transition-colors shrink-0" title="Inngest dashboard">
            <span class="w-1.5 h-1.5 rounded-full bg-orange-400"></span>inngest:\${w.inngestPort}
          </a>\` : ''}
          \${w.branchUrl ? \`<a href="\${w.branchUrl}" target="_blank" class="flex items-center gap-1 text-xs text-zinc-400 hover:text-zinc-700 transition-colors shrink-0">
            <svg class="w-3 h-3" fill="currentColor" viewBox="0 0 16 16"><path d="M5 3.25a.75.75 0 1 1-1.5 0 .75.75 0 0 1 1.5 0zm0 2.122a2.25 2.25 0 1 0-1.5 0v.878A2.25 2.25 0 0 0 5.75 8.5h1.5v2.128a2.251 2.251 0 1 0 1.5 0V8.5h1.5a2.25 2.25 0 0 0 2.25-2.25v-.878a2.25 2.25 0 1 0-1.5 0v.878a.75.75 0 0 1-.75.75h-4.5A.75.75 0 0 1 5 6.25v-.878zm3.75 7.378a.75.75 0 1 1-1.5 0 .75.75 0 0 1 1.5 0zm3-8.75a.75.75 0 1 1-1.5 0 .75.75 0 0 1 1.5 0z"/></svg>branch
          </a>\` : ''}
          \${w.pr ? \`<a href="\${w.pr.url}" target="_blank" class="flex items-center gap-1 text-xs text-emerald-600 hover:text-emerald-700 transition-colors shrink-0">
            <svg class="w-3 h-3" fill="currentColor" viewBox="0 0 16 16"><path d="M1.5 3.25a2.25 2.25 0 1 1 3 2.122v5.256a2.251 2.251 0 1 1-1.5 0V5.372A2.25 2.25 0 0 1 1.5 3.25zm5.677-.177L9.573.677A.25.25 0 0 1 10 .854V2.5h1A2.5 2.5 0 0 1 13.5 5v5.628a2.251 2.251 0 1 1-1.5 0V5a1 1 0 0 0-1-1h-1v1.646a.25.25 0 0 1-.427.177L7.177 3.427a.25.25 0 0 1 0-.354zM3.75 2.5a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5zm0 9.5a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5zm8.25.75a.75.75 0 1 1 1.5 0 .75.75 0 0 1-1.5 0z"/></svg>PR #\${w.pr.number}
          </a>\` : ''}
        </div>
      </div>

      <!-- actions -->
      <div class="flex items-center gap-1 shrink-0">
        <!-- open -->
        <a href="http://\${w.domain}" target="_blank" data-tip="Open in browser"
          class="tip icon-btn \${w.active ? 'text-zinc-600 hover:text-zinc-900 hover:bg-zinc-100' : 'text-zinc-300 pointer-events-none'}">
          <svg class="w-4 h-4" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14"/></svg>
        </a>

        <!-- start / stop -->
        \${w.active
          ? \`<button onclick="act('/api/stop','\${w.repo}','\${w.name}')" data-tip="Stop server" class="tip icon-btn text-red-500 hover:bg-red-50">
              <svg class="w-4 h-4" fill="currentColor" viewBox="0 0 24 24"><rect x="6" y="6" width="12" height="12" rx="2"/></svg>
             </button>\`
          : pendingStart.has(w.key)
          ? \`<button disabled data-tip="Starting…" class="tip icon-btn text-emerald-400 cursor-not-allowed opacity-70">
              <svg class="w-4 h-4 spin" fill="none" stroke="currentColor" stroke-width="2.5" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"/></svg>
             </button>\`
          : \`<button onclick="actStart('\${w.repo}','\${w.name}')" data-tip="Start server" class="tip icon-btn text-emerald-600 hover:bg-emerald-50">
              <svg class="w-4 h-4" fill="currentColor" viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>
             </button>\`
        }

        <div class="w-px h-4 bg-zinc-200 mx-1"></div>

        <!-- claude -->
        <button onclick="openTool('\${w.repo}','\${w.name}','claude')" data-tip="Open in Claude" class="tip icon-btn text-zinc-500 hover:bg-zinc-100">
          <img src="https://www.google.com/s2/favicons?domain=claude.ai&sz=64" class="w-4 h-4 rounded-sm" alt="Claude"
            onerror="this.replaceWith(Object.assign(document.createElement('span'),{className:'text-[10px] font-bold',textContent:'C'}))">
        </button>

        <!-- codex -->
        <button onclick="openTool('\${w.repo}','\${w.name}','codex')" data-tip="Open in Codex" class="tip icon-btn text-zinc-500 hover:bg-zinc-100">
          <img src="https://www.google.com/s2/favicons?domain=openai.com&sz=64" class="w-4 h-4 rounded-sm" alt="Codex"
            onerror="this.replaceWith(Object.assign(document.createElement('span'),{className:'text-[10px] font-bold',textContent:'O'}))">
        </button>

        <!-- antigravity -->
        <button onclick="openTool('\${w.repo}','\${w.name}','antigravity')" data-tip="Open in Antigravity" class="tip icon-btn text-zinc-500 hover:bg-zinc-100">
          <img src="https://www.google.com/s2/favicons?domain=antigravity.google&sz=64" class="w-4 h-4 rounded-sm" alt="Antigravity"
            onerror="this.replaceWith(Object.assign(document.createElement('span'),{className:'text-[10px] font-bold',textContent:'AG'}))">
        </button>

        <!-- grok -->
        <button onclick="openTool('\${w.repo}','\${w.name}','grok')" data-tip="Open in Grok" class="tip icon-btn text-zinc-500 hover:bg-zinc-100">
          <img src="https://www.google.com/s2/favicons?domain=x.ai&sz=64" class="w-4 h-4 rounded-sm" alt="Grok"
            onerror="this.replaceWith(Object.assign(document.createElement('span'),{className:'text-[10px] font-bold',textContent:'GK'}))">
        </button>

        <!-- copy cd -->
        <button onclick="copyCD('\${w.repo}','\${w.name}', this)" data-tip="Copy cd command" class="tip icon-btn text-zinc-400 hover:text-zinc-600 hover:bg-zinc-100">
          <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
            <rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>
          </svg>
        </button>

        <div class="w-px h-4 bg-zinc-200 mx-1"></div>

        <!-- tunnel toggle -->
        <button onclick="act('\${w.tunnelOn ? '/api/tunnel/disable' : '/api/tunnel/enable'}','\${w.repo}','\${w.name}')"
          data-tip="\${w.tunnelRunning ? 'Tunnel live — click to disable' : w.tunnelOn ? 'Tunnel configured, not running' : 'Enable tunnel'}"
          class="tip icon-btn \${w.tunnelRunning ? 'text-sky-500 hover:bg-sky-50' : w.tunnelOn ? 'text-sky-300 hover:bg-sky-50' : 'text-zinc-400 hover:text-zinc-600 hover:bg-zinc-100'}">
          <svg class="w-4 h-4" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/><path d="M2 12h20M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg>
        </button>

        <!-- inngest toggle -->
        <button onclick="act('\${w.inngestActive ? '/api/inngest/stop' : '/api/inngest/start'}','\${w.repo}','\${w.name}')"
          data-tip="\${w.inngestActive ? 'Stop Inngest' : 'Start Inngest'}"
          class="tip icon-btn \${w.inngestActive ? 'text-orange-500 hover:bg-orange-50' : 'text-zinc-400 hover:text-zinc-600 hover:bg-zinc-100'}">
          <img src="https://www.google.com/s2/favicons?domain=inngest.com&sz=64" class="w-4 h-4 rounded-sm" alt="Inngest"
            onerror="this.replaceWith(Object.assign(document.createElement('span'),{className:'text-[10px] font-bold',textContent:'IN'}))">
        </button>

        <!-- kebab menu -->
        <div class="relative">
          <button onclick="toggleMenu('\${key}', event)" data-tip="More" class="tip icon-btn text-zinc-400 hover:text-zinc-600 hover:bg-zinc-100">
            <svg class="w-4 h-4" fill="currentColor" viewBox="0 0 24 24"><circle cx="12" cy="5" r="1.5"/><circle cx="12" cy="12" r="1.5"/><circle cx="12" cy="19" r="1.5"/></svg>
          </button>
          <div id="menu-\${key}" class="hidden absolute right-0 top-8 bg-white border border-zinc-200 rounded-xl shadow-lg z-10 py-1 min-w-[180px]">
            <button onclick="openLogModal('\${w.repo}','\${w.name}')"
              class="w-full text-left px-3 py-1.5 text-xs text-zinc-700 hover:bg-zinc-50 flex items-center gap-2 transition-colors whitespace-nowrap">
              <svg class="w-3 h-3 shrink-0 text-zinc-400" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"/></svg>
              View logs
            </button>
            <div class="my-1 border-t border-zinc-100"></div>
            <button onclick="removeWorktree('\${w.repo}','\${w.name}')"
              class="w-full text-left px-3 py-1.5 text-xs text-red-600 hover:bg-red-50 flex items-center gap-2 transition-colors whitespace-nowrap">
              <svg class="w-3 h-3 shrink-0" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"/></svg>
              Remove worktree
            </button>
          </div>
        </div>
      </div>

    </div>\`;
  }).join('');
}

async function actStart(repo, name) {
  const key = \`\${repo}/\${name}\`;
  pendingStart.add(key);
  renderWorktrees(allWorktrees);
  await post('/api/start', { repo, name });
  if (!fastPollTimer) {
    fastPollTimer = setInterval(async () => {
      await refreshWorktrees();
      if (pendingStart.size === 0) { clearInterval(fastPollTimer); fastPollTimer = null; }
    }, 800);
  }
}

async function refreshWorktrees() {
  const wts = await fetch('/api/worktrees').then(r => r.json()).catch(() => []);
  for (const w of wts) { if (w.active) pendingStart.delete(w.key); }
  renderWorktrees(wts);
}

let portsPanelOpen = false;
function togglePortsPanel() {
  portsPanelOpen = !portsPanelOpen;
  document.getElementById('ports-panel').classList.toggle('hidden', !portsPanelOpen);
  document.getElementById('ports-chevron').style.transform = portsPanelOpen ? 'rotate(90deg)' : '';
  if (portsPanelOpen) refreshPorts();
}

async function refreshPorts() {
  if (!portsPanelOpen) return;
  const ports = await fetch('/api/ports').then(r => r.json()).catch(() => []);
  const el = document.getElementById('ports-list');
  if (!ports.length) { el.innerHTML = '<p class="text-zinc-400 px-4 py-3">No processes on ports 3000–3999</p>'; return; }
  el.innerHTML = ports.map(p => \`
    <div class="flex items-center gap-3 px-4 py-2.5 border-b border-zinc-100 last:border-0">
      <span class="font-mono font-medium text-zinc-900 w-12">\${p.port}</span>
      <span class="text-zinc-400 w-10">PID \${p.pid}</span>
      <span class="text-zinc-500 flex-1 truncate">\${p.cmd}\${p.worktree ? \` <span class="text-zinc-400">· \${p.worktree}</span>\` : ''}</span>
      <button onclick="killPort(\${p.port})" class="text-red-400 hover:text-red-600 transition-colors px-2 py-0.5 rounded hover:bg-red-50 font-medium">kill</button>
    </div>
  \`).join('');
}

async function killPort(port) {
  await post('/api/ports/kill', { port });
  await refreshPorts();
  await refreshWorktrees();
}

async function refresh() {
  await refreshWorktrees();
  refreshPorts();
}
loadProjectDropdowns();
refresh();
setInterval(refresh, 3000);
</script>
</body>
</html>`;

// Rebuild merged ingress and restart the single tunnel process for all enabled worktrees
;(async () => {
  syncHosts();
  const wts = await getWorktrees().catch(() => []);
  for (const w of wts) {
    if (w.tunnelOn) activeTunnelMap.set(w.key, { pubDom: w.pubDomain, port: w.port });
  }
  if (activeTunnelMap.size > 0) restartTunnel();
})();

Bun.serve({ port: PORT, fetch: handle });
console.log(`Portal → http://quivly.local  (localhost:${PORT})`);
