// lib.js — shared helpers for setu cli.js + portal.js.
// Single source of truth for config, domains, ports, envrc/caddy/hosts writes,
// and worktree lifecycle. Throws Error on failure; callers decide die vs JSON.

import { execFileSync, spawnSync } from 'child_process';
import {
  existsSync, readFileSync, writeFileSync, appendFileSync,
  mkdirSync, unlinkSync, realpathSync,
} from 'fs';
import { homedir } from 'os';
import { join, resolve } from 'path';
import { createHash } from 'crypto';

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
    // Was http://localhost:${port}/... — inconsistent with APP_BASE_URL on the
    // line above, and the actual root cause of "redirected to localhost" after
    // login: WORKOS_REDIRECT_URI is read once from this env var at process
    // startup by @workos-inc/authkit-nextjs and used verbatim as the OAuth
    // redirect destination, so a mismatched value here sends the browser to
    // localhost regardless of what domain the user actually visited through Caddy.
    const ld = localDomain(repo, name);
    writeEnvrc(wtDir, port, `http://${ld}`, `http://${ld}/authentication/callback`);
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

// Covers app dev-server ports (3000-3999) and inngest sidecar ports (appPort+5288,
// i.e. 8288-9287) in one lsof call. spawnSync, not execFileSync: with two -i
// selectors lsof exits 1 even when it successfully printed matches (verified) —
// execFileSync throws on that and discards output that was actually fine.
export function listActivePorts() {
  const res = spawnSync('lsof',
    ['-i', 'TCP:3000-3999', '-i', 'TCP:8288-9287', '-sTCP:LISTEN', '-nP', '-F', 'pcn'],
    { stdio: ['ignore', 'pipe', 'ignore'], encoding: 'utf8' });
  const out = res.stdout ?? '';
  const results = []; let cur = {};
  for (const line of out.split('\n')) {
    if (line.startsWith('p')) cur = { pid: line.slice(1) };
    else if (line.startsWith('c')) cur.cmd = line.slice(1);
    else if (line.startsWith('n')) { const m = line.match(/:(\d+)$/); if (m) results.push({ port: +m[1], pid: cur.pid, cmd: cur.cmd }); }
  }
  return results;
}

// cwd of a live process, via lsof — used to verify a port's actual listener
// belongs to the worktree the registry claims it does (setu doctor/prune).
export function processCwd(pid) {
  try {
    const out = execFileSync('lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-Fn'], { encoding: 'utf8' });
    return out.split('\n').find(l => l.startsWith('n'))?.slice(1) ?? null;
  } catch { return null; }
}

// ── AI coding CLI detection ──────────────────────────────────────────────────
// No single "which agent CLIs are installed + launch one" package exists as an
// importable primitive (checked: dmux/agentmanager/Codeman all bundle detection
// into a much bigger opinionated tool). This registry + which-check is the
// lazy version — a static tool-id -> binary map, not hardcoded to any one
// project's preferred 4 tools. Detected live (not cached) so installing a new
// CLI doesn't need a portal restart to be picked up.
export const AGENT_CLIS = {
  claude:      { bin: 'claude',          label: 'Claude' },
  codex:       { bin: 'codex',           label: 'Codex' },
  cursor:      { bin: 'cursor-agent',    label: 'Cursor' },
  aider:       { bin: 'aider',           label: 'Aider' },
  opencode:    { bin: 'opencode',        label: 'opencode' },
  amp:         { bin: 'amp',             label: 'Amp' },
  antigravity: { bin: 'antigravity-ide', label: 'Antigravity' },
  grok:        { bin: 'grok',            label: 'Grok' },
};

export function commandExists(bin) {
  return spawnSync('which', [bin], { stdio: 'ignore' }).status === 0;
}

// Only send -pgid when pid IS the group leader (pgid === pid) — same guard
// kill-with-style (a comparable npm package) uses. A freshly-spawned
// detached:true process is always its own leader, so this always fires for
// the normal case. It matters for a pid recovered from state written before
// the current process's lifetime (e.g. setu's own trigger.dev PID file,
// which can outlive a reboot, or the portal's reconciled sidecar entries) —
// that pid's process might no longer be the one that wrote the record (PID
// reuse) or might have inherited a pgid from something setu never spawned.
// Blasting that group could kill unrelated processes it doesn't own.
// Falls back to a plain single-pid kill when pgid !== pid.
export function killGroup(pid, signal = 'TERM') {
  let pgid = pid;
  try {
    const out = execFileSync('ps', ['-o', 'pgid=', '-p', String(pid)], { encoding: 'utf8' }).trim();
    if (out) pgid = parseInt(out, 10);
  } catch {}
  const target = pgid === pid ? `-${pgid}` : String(pid);
  try { execFileSync('kill', [`-${signal}`, '--', target], { stdio: 'ignore' }); return true; }
  catch { return false; }
}

export function detectAgentClis() {
  return Object.entries(AGENT_CLIS)
    .filter(([, t]) => commandExists(t.bin))
    .map(([id, t]) => ({ id, label: t.label }));
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

// ── project sidecars (workspace/sidecars.json: { [repo]: [{name, enabled, command, args, env}] }) ──
// Procfile/docker-compose-profile shaped, per research: no existing process
// orchestrator (pm2/overmind/process-compose/...) fits without Setu handing off
// its own parent-process role, since it already spawns the dev server itself —
// so this is a plain declarative list Setu loops over with the spawn path it
// already has, not a new dependency. Not for Inngest/Trigger — those already
// work as first-class endpoints; this is for anything else a project needs
// (a plain cloudflared tunnel, a queue worker, whatever), so nothing about
// starting a worktree stays hardcoded to one project's toolchain.
export function loadSidecars(workspace, repo) {
  try {
    const all = JSON.parse(readFileSync(join(workspace, 'sidecars.json'), 'utf8'));
    return (all[repo] ?? []).filter(s => s.enabled !== false && s.command);
  } catch { return []; }
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

// ── containers (optional per-worktree, engine-agnostic) ──────────────────────
// Opt-in alternative to the bare `bun dev` process: real cgroup-enforced memory/
// CPU caps instead of the polling footprint watchdog above. Deliberately never
// assumes OrbStack specifically — only the plain Docker Engine API surface
// (`docker info`, `docker compose`, `-p`/`mem_limit`/named volumes), so it works
// identically on Docker Desktop, Colima, or Podman's docker-compat, and keeps
// working if OrbStack itself has an outage. A worktree with no
// docker-compose.setu.yml is a plain bare process, same as always — this is
// additive, not a replacement path.

export function containerRuntimeAvailable() {
  const res = spawnSync('docker', ['info', '--format', '{{.ServerVersion}}|{{.OperatingSystem}}'],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  if (res.status !== 0 || !res.stdout?.trim()) return { available: false, engine: null };
  const [version, engine] = res.stdout.trim().split('|');
  return { available: true, engine: engine || 'docker', version };
}

// A hash suffix, not just a sanitized slug — `slugify` maps `/` to `-`, so two
// ordinary, independently-valid branch names (`feat/ab` and `feat-ab`) used to
// collide on the exact same project name. Docker Compose then treats the
// second `up` as a config change to the same project and recreates the first
// worktree's container out from under it — found via live review, not a
// hypothetical. The hash is of the exact registry key, so it's collision-safe
// regardless of how lossy the human-readable prefix is.
export function composeProjectName(repo, name) {
  const hash = createHash('sha1').update(`${repo}/${name}`).digest('hex').slice(0, 8);
  const readable = `${repo}-${slugify(name)}`.toLowerCase().replace(/[^a-z0-9-]/g, '-');
  return `setu-${readable}-${hash}`;
}

export function dockerComposePath(wtDir) {
  return join(wtDir, 'docker-compose.setu.yml');
}

// Sticky per-worktree default, used whenever a start call doesn't explicitly
// say --container or --bare (a plain `setu start`, or the portal UI's Start
// button, which never sends the field at all). Found live: an established
// worktree that had only ever run bare got silently switched to a container
// on a restart with no explicit choice made by anyone — container becoming
// the global default doesn't mean every worktree's history should be
// overridden by it. A worktree that has run in container mode before (has a
// compose file on disk) stays sticky-container. A worktree with prior bare
// history (a dev.log already exists) but has never containerized stays
// sticky-bare — it has to be opted in explicitly with --container once. Only
// a genuinely brand-new worktree (no history either way) gets the intended
// global default.
export function defaultContainerMode(workspace, repo, name) {
  const wtDir = join(workspace, repo, name);
  if (existsSync(dockerComposePath(wtDir))) return true;
  if (existsSync(join(workspace, 'logs', repo, name, 'dev.log'))) return false;
  return true;
}

export function parseMemToMb(v) {
  const m = String(v).trim().match(/^(\d+(?:\.\d+)?)\s*(g|m)$/i);
  if (!m) return null;
  return m[2].toLowerCase() === 'g' ? parseFloat(m[1]) * 1024 : parseFloat(m[1]);
}

// docker info's NCPU/MemTotal report what the engine itself has available (the
// VM's own allocation on macOS) — a per-container limit above that isn't just
// wasted, Docker rejects the container outright. Proven live: this machine's
// OrbStack VM has 1 CPU allocated, and the original containerCpuLimit default
// of 2 failed with "range of CPUs is from 0.01 to 1.00, as there are only 1
// CPUs available" — .setu.json's configured value can't be trusted blindly.
export function engineCapacity() {
  const res = spawnSync('docker', ['info', '--format', '{{.NCPU}}|{{.MemTotal}}'],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  if (res.status !== 0 || !res.stdout?.trim()) return { cpus: null, memMb: null };
  const [cpus, memBytes] = res.stdout.trim().split('|');
  return { cpus: parseInt(cpus, 10) || null, memMb: memBytes ? Math.floor(+memBytes / 1024 / 1024) : null };
}

// "running" or "restarting" both count as alive — mid-retry-backoff (the
// `restart: on-failure:3` window between attempts) briefly reports neither
// "running" nor present in a --status=running filter, and a caller polling on
// a fixed interval (checkMemoryCeilings) could otherwise catch that gap and
// prematurely free the worktree's concurrency slot while Docker is about to
// bring it back up on its own. -a includes exited/dead containers so a
// permanently-given-up retry cap (genuinely dead) is correctly reported false.
export function composeProjectAlive(project) {
  const res = spawnSync('docker', ['compose', '-p', project, 'ps', '-a', '--format', '{{.State}}'],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  if (res.status !== 0) return false;
  return res.stdout.trim().split('\n').some(s => s === 'running' || s === 'restarting');
}

// Caddy's reverse_proxy target never changes between bare and containerized —
// always `localhost:<port>` (same port Setu's own registry already allocated).
// The container publishes that port to the host with a plain `-p port:port`,
// proven throughout the Phase 0 spike before any engine-specific networking
// (`.orb.local`) was even tested. node_modules is a container-local named
// volume, not a host bind-mount — the host installs macOS-native binaries
// (@next/swc-darwin-arm64 etc.) that can't run in the Linux container; only the
// source tree bind-mounts from the host. The resolved (symlink-followed)
// .env.local is bind-mounted at the same in-container path the app expects it.
export function writeDockerCompose(c, repo, name, port) {
  const wtDir = join(c.workspace, repo, name);
  const project = composeProjectName(repo, name);

  // Map, not an array of pairs — .envrc already contains `export PORT=...`
  // (writeEnvrc always writes it first), so a plain array would emit PORT
  // twice and Docker's YAML parser rejects the resulting duplicate mapping
  // key outright (`docker compose up` fails before anything starts).
  const env = new Map([['PORT', String(port)]]);
  for (const m of readEnvrc(wtDir).matchAll(/^export (\w+)=(.+)$/gm)) env.set(m[1], m[2].trim());
  const envLines = [...env].map(([k, v]) => `      ${k}: ${JSON.stringify(v)}`).join('\n');

  const volumes = [
    `      - ${wtDir}:/workspace`,
    `      - node_modules:/workspace/node_modules`,
  ];
  const hostEnvLocal = envLocalPath(repo, wtDir);
  try {
    const real = realpathSync(hostEnvLocal);
    const inContainer = '/workspace' + hostEnvLocal.slice(wtDir.length);
    volumes.push(`      - ${real}:${inContainer}`);
  } catch { /* no .env.local yet (fresh worktree) — container still boots without it */ }

  const cap = engineCapacity();
  let memLimit = c.containerMemoryLimit ?? '4g';
  let cpuLimit = c.containerCpuLimit ?? 2;
  if (cap.cpus && Number(cpuLimit) > cap.cpus) cpuLimit = cap.cpus;
  const memMb = parseMemToMb(memLimit);
  if (cap.memMb && memMb && memMb > cap.memMb) memLimit = `${cap.memMb}m`;

  const yaml = `# Generated by setu — regenerated on every \`setu start --container\`, do not edit by hand.
name: ${project}
services:
  dev:
    image: oven/bun:latest
    working_dir: /workspace
    command: sh -c "bun install && bun run dev"
    restart: on-failure:3
    mem_limit: "${memLimit}"
    cpus: "${cpuLimit}"
    ports:
      - "${port}:${port}"
    environment:
${envLines}
    volumes:
${volumes.join('\n')}
volumes:
  node_modules:
`;
  writeFileSync(dockerComposePath(wtDir), yaml);
  return dockerComposePath(wtDir);
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

// Full path->branch map in one pass — same porcelain parse worktreeForBranch
// already does, just returning everything instead of searching for one name.
// Needed because a worktree's directory name is not reliably its branch name
// (confirmed live: a worktree directory can be on a branch with a completely
// different name than the directory itself), so joining git ref data back to
// a specific worktree has to go through the actual path, not an assumption.
export function worktreeBranchMap(repoDir) {
  const porcelain = git(repoDir, ['worktree', 'list', '--porcelain']);
  const map = new Map();
  for (const entry of porcelain.trim().split('\n\n')) {
    const path   = entry.match(/^worktree (.+)$/m)?.[1];
    const branch = entry.match(/^branch refs\/heads\/(.+)$/m)?.[1];
    if (path && branch) map.set(resolve(path), branch);
  }
  return map;
}

// The same base-branch choice createWorktree() already makes for new
// branches (fork point) — reused here for ahead/behind comparisons so
// neither place hardcodes 'origin/staging', which doesn't exist for most
// registered repos (confirmed live: only 2 of 5 have it; using it
// unconditionally fails with "unknown revision" on the rest).
export function baseBranchRef(repoDir) {
  return branchExists(repoDir, 'staging') ? 'origin/staging'
    : `origin/${git(repoDir, ['symbolic-ref', '--short', 'HEAD']).trim()}`;
}

// One call per repo, not one per worktree — %(ahead-behind:) and
// %(committerdate:unix) are ref-level properties, so every branch's data
// comes back in a single `for-each-ref` (measured live: 77ms for 300+
// branches in one real repo). The alternative — per-worktree `git log`/
// `rev-list` via the synchronous git() above — is the same class of bug this
// codebase has already hit and fixed twice elsewhere (fetchPR, activePid):
// O(n) synchronous subprocess spawns blocking Bun's single event loop during
// exactly the poll window (as low as 800ms mid-start) that most needs to stay
// responsive. Returns Map<branchName, {lastCommitAt, ahead, behind}>;
// ahead/behind are 0 if the repo has no reachable base (rare, but
// for-each-ref degrades to blank fields rather than erroring per-branch).
export function branchMetadata(repoDir) {
  const base = baseBranchRef(repoDir);
  let raw;
  try {
    raw = git(repoDir, ['for-each-ref',
      `--format=%(refname:short)\t%(committerdate:unix)\t%(ahead-behind:${base})`, 'refs/heads/']);
  } catch { return new Map(); }
  const map = new Map();
  for (const line of raw.trim().split('\n')) {
    if (!line) continue;
    const [branch, at, ab] = line.split('\t');
    const [ahead, behind] = (ab ?? '').trim().split(/\s+/).map(n => parseInt(n, 10) || 0);
    map.set(branch, { lastCommitAt: parseInt(at, 10) || null, ahead: ahead ?? 0, behind: behind ?? 0 });
  }
  return map;
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
