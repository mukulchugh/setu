// lib.js — shared helpers for setu cli.js + portal.js.
// Single source of truth for config, domains, ports, envrc/caddy/hosts writes,
// and worktree lifecycle. Throws Error on failure; callers decide die vs JSON.

import { execFileSync, spawnSync } from 'child_process';
import {
  existsSync, readFileSync, writeFileSync, appendFileSync,
  mkdirSync, unlinkSync,
} from 'fs';
import { homedir } from 'os';
import { join, resolve } from 'path';

export const HOME        = homedir();
export const CFG_PATH    = join(HOME, '.setu.json');
export const SETU_DIR    = join(HOME, '.setu');
export const PORTAL_PORT = 2999;
// Must match the sudoers rule written by `setu setup` — keep the two in sync.
export const HOSTS_TMP   = '/tmp/setu-hosts';

export const BREW_PREFIX = (() => {
  try { return execFileSync('brew', ['--prefix'], { encoding: 'utf8' }).trim(); }
  catch { return '/opt/homebrew'; }
})();
export const CADDY_BIN       = join(BREW_PREFIX, 'bin', 'caddy');
export const CLOUDFLARED_BIN = join(BREW_PREFIX, 'bin', 'cloudflared');

// ── config ────────────────────────────────────────────────────────────────────

export function loadConfig() {
  try { return JSON.parse(readFileSync(CFG_PATH, 'utf8')); } catch { return {}; }
}

export function saveConfig(c) {
  writeFileSync(CFG_PATH, JSON.stringify(c, null, 2) + '\n');
}

export function requireConfig() {
  const c = loadConfig();
  if (!c.workspace || !c.domain) throw new Error('Not configured — run `setu setup` first.');
  return c;
}

// ── domains ───────────────────────────────────────────────────────────────────

export function slugify(name) { return name.replace(/\//g, '-'); }

export function localDomain(repo, name) {
  return name === 'main' ? `${repo}.quivly.local` : `${slugify(name)}.quivly.local`;
}

// Single shared public URL per developer (dev-<name>.<zone>). One worktree at a
// time owns it; the portal moves it between worktrees.
export function publicDomain(c) { return c.domain; }

// ── env files ─────────────────────────────────────────────────────────────────

export function envLocalPath(repo, wtDir) {
  return repo === 'quivly-app'
    ? join(wtDir, 'apps', 'quivly-app', '.env.local')
    : join(wtDir, '.env.local');
}

export function parseEnvFile(path) {
  if (!existsSync(path)) return {};
  const out = {};
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (!line.trim() || line.trim().startsWith('#')) continue;
    const m = line.match(/^\s*(?:export\s+)?([\w.-]+)\s*=\s*(.*?)\s*$/);
    if (m) out[m[1]] = m[2].replace(/^['"]|['"]$/g, '');
  }
  return out;
}

// The trigger.dev CLI aborts if its own version doesn't match the pinned
// @trigger.dev/sdk in package.json — resolve the same version instead of `@latest`.
export function pinnedTriggerVersion(wtDir) {
  try {
    const pkg = JSON.parse(readFileSync(join(wtDir, 'package.json'), 'utf8'));
    const v = pkg.dependencies?.['@trigger.dev/sdk'] ?? pkg.devDependencies?.['@trigger.dev/sdk'];
    return v ? v.replace(/^[\^~]/, '') : 'latest';
  } catch { return 'latest'; }
}

export function readEnvrc(wtDir) {
  try { return readFileSync(join(wtDir, '.envrc'), 'utf8'); } catch { return ''; }
}

export function tunnelEnabled(wtDir, c) {
  return readEnvrc(wtDir).includes(`https://${c.domain}`);
}

export function writeEnvrc(wtDir, port, appUrl, redirectUri) {
  writeFileSync(join(wtDir, '.envrc'),
    `export PORT=${port}\nexport NEXT_PUBLIC_APP_BASE_URL=${appUrl}\nexport NEXT_PUBLIC_WORKOS_REDIRECT_URI=${redirectUri}\n`);
  spawnSync('direnv', ['allow', wtDir], { stdio: 'ignore' });
}

export function configureWorktreeEnv(c, repo, name, port, withTunnel) {
  const wtDir = join(c.workspace, repo, name);
  if (withTunnel) {
    const pd = publicDomain(c);
    writeEnvrc(wtDir, port, `https://${pd}`, `https://${pd}/authentication/callback`);
  } else {
    writeEnvrc(wtDir, port, `http://${localDomain(repo, name)}`, `http://localhost:${port}/authentication/callback`);
  }
  writeCaddy(c, repo, name, port, withTunnel);
}

// ── caddy ─────────────────────────────────────────────────────────────────────

export function caddySnippetPath(workspace, repo, name) {
  return join(workspace, 'caddy.d', `${repo}-${slugify(name)}.caddy`);
}

export function writeCaddy(c, repo, name, port, withTunnel) {
  const ld = localDomain(repo, name);
  const body = withTunnel
    ? `http://${ld},\nhttp://${publicDomain(c)} {\n  reverse_proxy localhost:${port}\n}\n`
    : `http://${ld} {\n  reverse_proxy localhost:${port}\n}\n`;
  writeFileSync(caddySnippetPath(c.workspace, repo, name), body);
}

// Never prompts (sudo -n): callers may be detached with no TTY. The sudoers
// rule from `setu setup` covers exactly this argv.
export function reloadCaddy(workspace) {
  const caddyfile = join(workspace, 'Caddyfile');
  try {
    execFileSync('sudo', ['-n', CADDY_BIN, 'reload', '--config', caddyfile], { stdio: 'ignore' });
    return true;
  } catch {
    console.warn(`⚠  caddy reload failed — run: sudo ${CADDY_BIN} reload --config ${caddyfile}`);
    return false;
  }
}

// ── /etc/hosts sync ───────────────────────────────────────────────────────────

export function syncHosts(workspace) {
  const raw = readFileSync('/etc/hosts', 'utf8');
  const cleaned = raw.replace(/\n?# quivly-start[\s\S]*?# quivly-end\n?/, '');
  const entries = portEntries(workspace)
    .map(({ repo, name }) => `127.0.0.1\t${localDomain(repo, name)}`);
  const next = cleaned.trimEnd() + '\n# quivly-start\n' + entries.join('\n') + '\n# quivly-end\n';
  writeFileSync(HOSTS_TMP, next);
  try {
    execFileSync('sudo', ['-n', '/bin/cp', HOSTS_TMP, '/etc/hosts'], { stdio: 'ignore' });
    return true;
  } catch {
    console.warn(`⚠  /etc/hosts sync failed — re-run \`setu setup\` to repair the sudoers rule`);
    return false;
  }
}

// ── ports registry (workspace/.ports: "repo/name:port") ──────────────────────

export function portsRaw(workspace) {
  try { return readFileSync(join(workspace, '.ports'), 'utf8').trim(); } catch { return ''; }
}

export function portEntries(workspace) {
  return portsRaw(workspace).split('\n').filter(Boolean).map(line => {
    const ci   = line.lastIndexOf(':');
    const key  = line.slice(0, ci);
    const port = parseInt(line.slice(ci + 1), 10);
    const si   = key.indexOf('/');
    return { key, repo: key.slice(0, si), name: key.slice(si + 1), port };
  });
}

export function getPort(workspace, repo, name) {
  return portEntries(workspace).find(e => e.repo === repo && e.name === name)?.port ?? null;
}

export function activePid(port) {
  try {
    return execFileSync('lsof', ['-i', `:${port}`, '-sTCP:LISTEN', '-t'],
      { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
  } catch { return ''; }
}

export function assignPort(workspace, repo, name) {
  const existing = getPort(workspace, repo, name);
  if (existing) return existing;
  const base = loadProjects(workspace)[repo]?.base ?? 3200;
  const used = new Set(portEntries(workspace).map(e => e.port));
  let port = base;
  while (used.has(port) || activePid(port)) port++;
  appendFileSync(join(workspace, '.ports'), `${repo}/${name}:${port}\n`);
  return port;
}

export function releasePort(workspace, repo, name) {
  const keep = portEntries(workspace).filter(e => !(e.repo === repo && e.name === name));
  writeFileSync(join(workspace, '.ports'),
    keep.length ? keep.map(e => `${e.key}:${e.port}`).join('\n') + '\n' : '');
}

// ── projects registry (workspace/.projects: "name:base:slug:label") ──────────

export function loadProjects(workspace) {
  try {
    return Object.fromEntries(
      readFileSync(join(workspace, '.projects'), 'utf8').split('\n')
        .filter(l => l.trim() && !l.startsWith('#'))
        .map(l => {
          const [name, base, slug, label] = l.split(':');
          return [name, {
            label: label?.trim() || name,
            slug:  slug || null,
            github: slug ? `https://github.com/${slug}` : null,
            base: +base,
          }];
        })
    );
  } catch { return {}; }
}

export function registerProject(workspace, { name, slug = '', label = '' }) {
  const projects = loadProjects(workspace);
  if (projects[name]) return projects[name].base;
  const usedBases = Object.values(projects).map(p => p.base).filter(Boolean);
  let base = 3000;
  while (usedBases.includes(base)) base += 100;
  appendFileSync(join(workspace, '.projects'), `${name}:${base}:${slug}:${label || name}\n`);
  return base;
}

// ── git worktrees ─────────────────────────────────────────────────────────────

export function git(repoDir, args, opts = {}) {
  return execFileSync('git', ['-C', repoDir, ...args],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opts });
}

export function branchExists(repoDir, name) {
  for (const ref of [`refs/heads/${name}`, `refs/remotes/origin/${name}`]) {
    if (spawnSync('git', ['-C', repoDir, 'show-ref', '--verify', '--quiet', ref]).status === 0) return true;
  }
  return false;
}

export function worktreeForBranch(repoDir, name) {
  const porcelain = git(repoDir, ['worktree', 'list', '--porcelain']);
  for (const entry of porcelain.trim().split('\n\n')) {
    const path   = entry.match(/^worktree (.+)$/m)?.[1];
    const branch = entry.match(/^branch refs\/heads\/(.+)$/m)?.[1];
    if (branch === name) return path;
  }
  return null;
}

// Creates worktree + port + envrc + caddy + env symlink + hosts. Dependency
// install is the caller's job (CLI runs it inline, portal in the background).
export function createWorktree(c, repo, name, { tunnel = false } = {}) {
  const repoDir = join(c.workspace, `${repo}.git`);
  const wtDir   = join(c.workspace, repo, name);
  if (!existsSync(repoDir)) throw new Error(`Bare repo not found: ${repoDir}\nRun: setu init <gh-slug>`);

  git(repoDir, ['fetch', '--all', '--prune']);
  git(repoDir, ['worktree', 'prune']);

  if (!existsSync(wtDir)) {
    const existingPath = worktreeForBranch(repoDir, name);
    if (existingPath && resolve(existingPath) !== resolve(wtDir)) {
      throw new Error(`Branch '${name}' is already checked out at ${existingPath}`);
    }
    if (branchExists(repoDir, name)) {
      git(repoDir, ['worktree', 'add', wtDir, name]);
    } else {
      // new branches fork from staging when the repo has one, else the default branch
      const base = branchExists(repoDir, 'staging') ? 'origin/staging'
        : `origin/${git(repoDir, ['symbolic-ref', '--short', 'HEAD']).trim()}`;
      git(repoDir, ['worktree', 'add', '-b', name, wtDir, base]);
    }
  }

  const port = assignPort(c.workspace, repo, name);
  configureWorktreeEnv(c, repo, name, port, tunnel);

  const mainEnv = envLocalPath(repo, join(c.workspace, repo, 'main'));
  const wtEnv   = envLocalPath(repo, wtDir);
  if (existsSync(mainEnv) && !existsSync(wtEnv)) {
    spawnSync('ln', ['-sf', mainEnv, wtEnv], { stdio: 'ignore' });
  }

  syncHosts(c.workspace);
  reloadCaddy(c.workspace);

  return { wtDir, port, localDom: localDomain(repo, name), pubDom: tunnel ? publicDomain(c) : null };
}

// Removes worktree + registry entries + caddy snippet + hosts. Stopping dev
// servers / tunnel routes is the caller's job (only the portal owns processes).
export function removeWorktree(c, repo, name) {
  const repoDir = join(c.workspace, `${repo}.git`);
  const wtDir   = join(c.workspace, repo, name);
  git(repoDir, ['worktree', 'remove', '--force', wtDir]);
  releasePort(c.workspace, repo, name);
  try { unlinkSync(caddySnippetPath(c.workspace, repo, name)); } catch {}
  reloadCaddy(c.workspace);
  syncHosts(c.workspace);
}

// ── portal client (used by CLI to talk to the running portal) ────────────────

export function portalPid() {
  return activePid(PORTAL_PORT);
}

export async function portalRequest(path, body) {
  const res = await fetch(`http://localhost:${PORTAL_PORT}${path}`, body === undefined
    ? { signal: AbortSignal.timeout(5000) }
    : { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body), signal: AbortSignal.timeout(30000) });
  return res.json();
}
