// lib.js — shared helpers for setu cli.js + portal.js.
// Single source of truth for config, domains, ports, envrc/caddy/hosts writes,
// and worktree lifecycle. Throws Error on failure; callers decide die vs JSON.

import { execFileSync, spawnSync } from 'child_process';
import {
  existsSync, readFileSync, writeFileSync, appendFileSync,
  mkdirSync, unlinkSync, realpathSync, copyFileSync, chmodSync,
} from 'fs';
import { homedir, cpus, totalmem } from 'os';
import { join, resolve, dirname } from 'path';
import { createHash } from 'crypto';

export const HOME        = homedir();
export const CFG_PATH    = join(HOME, '.setu.json');
// Deliberately separate from CFG_PATH, not a section inside it: this holds
// org-admin-scope API keys (Anthropic/OpenAI usage & cost reporting), a
// materially bigger blast radius than the rest of ~/.setu.json, and the
// user writes it by hand (never through the portal, which binds 0.0.0.0 —
// LAN-reachable, see AGENTS.md's MCP section) so a key is never typed into
// a form this tool could echo back. Unrelated to the committed .setu.json
// writeSetuAgentMarkers drops into MANAGED PROJECTS below — same filename
// stem, opposite commit semantics; see AGENTS.md's Conventions section.
export const COSTS_CFG_PATH = join(HOME, '.setu-costs.json');
export const SETU_DIR    = join(HOME, '.setu');
export const PORTAL_PORT = 2999;
// Must match the sudoers rule written by `setu setup` — keep the two in sync.
export const HOSTS_TMP   = '/tmp/setu-hosts';
export const HOSTS_START = '# quivly-start';
export const HOSTS_END   = '# quivly-end';

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

// Never written by this tool — see COSTS_CFG_PATH's own comment. Read-only,
// same try/empty-object shape as loadConfig, so a missing/malformed file
// just reads as "nothing configured" rather than a crash.
export function loadCostsConfig() {
  try { return JSON.parse(readFileSync(COSTS_CFG_PATH, 'utf8')); } catch { return {}; }
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

function hasConvexEnv(dir) {
  const env = { ...parseEnvFile(join(dir, '.env')), ...parseEnvFile(join(dir, '.env.local')) };
  return typeof env.CONVEX_DEPLOYMENT === 'string' && env.CONVEX_DEPLOYMENT.length > 0;
}

// Convex is configured for a worktree when either signal is present: a
// convex/ folder (checked into git, present from a fresh clone before anyone
// has ever run `convex dev` locally) or a CONVEX_DEPLOYMENT line (written by
// a prior `npx convex dev`, which can outlive convex/ being gitignored in
// some setups). Checked at both the worktree root and the envLocalPath-
// resolved app dir, root first -- covers a plain repo (the two resolve to the
// same directory) and a monorepo where the app -- and therefore convex/ --
// lives nested (apps/quivly-app for the quivly-app repo, the one case
// envLocalPath already special-cases). Returns the directory Convex actually
// lives in rather than a bare boolean, so callers spawn `npx convex dev`/
// `deploy` from the right cwd instead of re-deriving this same resolution
// themselves.
export function convexDir(repo, wtDir) {
  if (existsSync(join(wtDir, 'convex')) || hasConvexEnv(wtDir)) return wtDir;
  const appDir = dirname(envLocalPath(repo, wtDir));
  if (appDir !== wtDir && (existsSync(join(appDir, 'convex')) || hasConvexEnv(appDir))) return appDir;
  return null;
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
  const cleaned = raw.replace(new RegExp(`\\n?${HOSTS_START}[\\s\\S]*?${HOSTS_END}\\n?`), '');
  const entries = portEntries(workspace)
    .map(({ repo, name }) => `127.0.0.1\t${localDomain(repo, name)}`);
  const next = cleaned.trimEnd() + `\n${HOSTS_START}\n` + entries.join('\n') + `\n${HOSTS_END}\n`;
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

// "repo/name" -> {repo, name}, split on the first '/'. A worktree name can
// itself contain '/' (e.g. a branch like "feat/x"), the repo name can't.
export function splitKey(key) {
  const si = key.indexOf('/');
  return { name: key.slice(si + 1), repo: key.slice(0, si) };
}

export function portEntries(workspace) {
  return portsRaw(workspace).split('\n').filter(Boolean).map(line => {
    const ci   = line.lastIndexOf(':');
    const key  = line.slice(0, ci);
    const port = parseInt(line.slice(ci + 1), 10);
    return { key, ...splitKey(key), port };
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

// Async sibling of activePid, for portal.js's request-handler hot paths —
// execFileSync blocks Bun's single JS thread for the whole lsof call,
// stalling every other in-flight request (same class of bug fetchPR hit,
// see its own comment). cli.js keeps calling the sync version: a one-shot
// foreground process has no concurrent requests to starve.
export async function activePidAsync(port) {
  return spawnText(['lsof', '-i', `:${port}`, '-sTCP:LISTEN', '-t']);
}

// Covers app dev-server ports (3000-3999) and inngest sidecar ports (appPort+5288,
// i.e. 8288-9287) in one lsof call. spawnSync, not execFileSync: with two -i
// selectors lsof exits 1 even when it successfully printed matches (verified) —
// execFileSync throws on that and discards output that was actually fine.
export function listActivePorts() {
  const res = spawnSync('lsof',
    ['-i', 'TCP:3000-3999', '-i', 'TCP:8288-9287', '-sTCP:LISTEN', '-nP', '-F', 'pcn'],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  const out = res.stdout ?? '';
  const results = []; let cur = {};
  for (const line of out.split('\n')) {
    if (line.startsWith('p')) cur = { pid: line.slice(1) };
    else if (line.startsWith('c')) cur.cmd = line.slice(1);
    else if (line.startsWith('n')) { const m = line.match(/:(\d+)$/); if (m) results.push({ cmd: cur.cmd, pid: cur.pid, port: +m[1] }); }
  }
  return results;
}

// Async sibling of listActivePorts — same parsing, sourced from spawnText
// (which already tolerates lsof's exit-1-on-success quirk by never
// throwing). portal.js's hot paths use this; cli.js keeps the sync version.
export async function listActivePortsAsync() {
  const out = await spawnText(['lsof', '-i', 'TCP:3000-3999', '-i', 'TCP:8288-9287', '-sTCP:LISTEN', '-nP', '-F', 'pcn']);
  const results = []; let cur = {};
  for (const line of out.split('\n')) {
    if (line.startsWith('p')) cur = { pid: line.slice(1) };
    else if (line.startsWith('c')) cur.cmd = line.slice(1);
    else if (line.startsWith('n')) { const m = line.match(/:(\d+)$/); if (m) results.push({ cmd: cur.cmd, pid: cur.pid, port: +m[1] }); }
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
  aider:       { bin: 'aider',           label: 'Aider' },
  amp:         { bin: 'amp',             label: 'Amp' },
  antigravity: { bin: 'antigravity-ide', label: 'Antigravity' },
  claude:      { bin: 'claude',          label: 'Claude' },
  codex:       { bin: 'codex',           label: 'Codex' },
  cursor:      { bin: 'cursor-agent',    label: 'Cursor' },
  grok:        { bin: 'grok',            label: 'Grok' },
  opencode:    { bin: 'opencode',        label: 'opencode' },
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

// Async sibling of killGroup — same pgid-then-kill shape, Bun.spawn instead
// of execFileSync so a stop/remove request doesn't block the whole portal.
export async function killGroupAsync(pid, signal = 'TERM') {
  let pgid = pid;
  const out = (await spawnText(['ps', '-o', 'pgid=', '-p', String(pid)])).trim();
  if (out) pgid = parseInt(out, 10);
  const target = pgid === pid ? `-${pgid}` : String(pid);
  try {
    const proc = Bun.spawn(['kill', `-${signal}`, '--', target], { stderr: 'ignore', stdout: 'ignore' });
    return (await proc.exited) === 0;
  } catch { return false; }
}

export function detectAgentClis(workspace) {
  const builtins = Object.entries(AGENT_CLIS)
    .filter(([, t]) => commandExists(t.bin))
    .map(([id, t]) => ({ id, label: t.label }));
  // Custom agents are never which-checked (see loadCustomAgents) — appended
  // as-is after the verified built-ins.
  const custom = loadCustomAgents(workspace).map(({ id, label }) => ({ id, label }));
  return [...builtins, ...custom];
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
            base: +base,
            github: slug ? `https://github.com/${slug}` : null,
            label: label?.trim() || name,
            slug:  slug || null,
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

// Unfiltered — the settings UI needs to show and edit disabled/incomplete
// entries too, unlike loadSidecars() (used on the start path, which only
// ever wants what's actually enabled and runnable).
export function loadAllSidecars(workspace, repo) {
  try {
    const all = JSON.parse(readFileSync(join(workspace, 'sidecars.json'), 'utf8'));
    return all[repo] ?? [];
  } catch { return []; }
}

export function saveSidecars(workspace, repo, sidecars) {
  const path = join(workspace, 'sidecars.json');
  let all = {};
  try { all = JSON.parse(readFileSync(path, 'utf8')); } catch { /* first sidecar ever registered */ }
  all[repo] = sidecars;
  writeFileSync(path, JSON.stringify(all, null, 2) + '\n');
}

// ── file sync (workspace/file-sync.json: { [repo]: string[] } of glob patterns) ──
// Same per-repo JSON store shape as sidecars.json above, holding the extra
// gitignored files (beyond the shared .env.local, which is symlinked further
// down in createWorktree) each project wants copied into every new worktree
// so it gets its own independently editable copy — a .env.development.local,
// a config/local.json, whatever a given repo needs that isn't in git.
export function loadFileSyncGlobs(workspace, repo) {
  try {
    const all = JSON.parse(readFileSync(join(workspace, 'file-sync.json'), 'utf8'));
    return Array.isArray(all[repo]) ? all[repo] : [];
  } catch { return []; }
}

export function saveFileSyncGlobs(workspace, repo, globs) {
  const path = join(workspace, 'file-sync.json');
  let all = {};
  try { all = JSON.parse(readFileSync(path, 'utf8')); } catch { /* first project to configure file sync */ }
  all[repo] = globs;
  writeFileSync(path, JSON.stringify(all, null, 2) + '\n');
}

// ── sidecar approval gate (workspace/sidecar-approvals.json: { [repo]: { [name]: approvedSignature } }) ──
// Same per-repo JSON store shape as sidecars.json/file-sync.json above.
// Sidecars aren't repo-committed like a real approval-gated hook would be,
// they're typed into a local Settings input, so this isn't a tamper
// boundary. It's a sanity-check net: a newly-added or just-edited sidecar
// command gets one explicit look in the UI before Setu starts running it
// automatically, instead of silently firing on the next Start. The
// "approved" value is the literal command+args string, not a hash,
// comparing two short strings is exactly as correct here and simpler.
function sidecarSignature(s) {
  return `${s.command ?? ''} ${(s.args ?? []).join(' ')}`.trim();
}

export function loadSidecarApprovals(workspace, repo) {
  try {
    const all = JSON.parse(readFileSync(join(workspace, 'sidecar-approvals.json'), 'utf8'));
    return all[repo] ?? {};
  } catch { return {}; }
}

export function saveSidecarApprovals(workspace, repo, approvals) {
  const path = join(workspace, 'sidecar-approvals.json');
  let all = {};
  try { all = JSON.parse(readFileSync(path, 'utf8')); } catch { /* first sidecar ever approved */ }
  all[repo] = approvals;
  writeFileSync(path, JSON.stringify(all, null, 2) + '\n');
}

export function isSidecarApproved(workspace, repo, sidecar) {
  const approvals = loadSidecarApprovals(workspace, repo);
  return approvals[sidecar.name] === sidecarSignature(sidecar);
}

export function approveSidecar(workspace, repo, sidecarName, command, args) {
  const approvals = loadSidecarApprovals(workspace, repo);
  approvals[sidecarName] = sidecarSignature({ args, command });
  saveSidecarApprovals(workspace, repo, approvals);
}

// First-run migration: sidecars configured before this gate existed should
// keep working exactly as before, not suddenly demand approval. Runs once,
// detected by the approvals file not existing yet, and auto-approves every
// sidecar already on record as-is. A sidecars.json that exists but fails to
// parse (mid-write, corrupt) must NOT be treated as "no sidecars" here: that
// would write an empty approvals file, mark the migration done for good, and
// every real pre-existing sidecar would demand approval forever. Bail
// without writing instead, so the next boot retries.
export function seedSidecarApprovalsIfMissing(workspace) {
  const approvalsPath = join(workspace, 'sidecar-approvals.json');
  if (existsSync(approvalsPath)) return;
  const sidecarsPath = join(workspace, 'sidecars.json');
  let all = {};
  if (existsSync(sidecarsPath)) {
    try { all = JSON.parse(readFileSync(sidecarsPath, 'utf8')); }
    catch { return; }
  }
  const approvals = {};
  for (const [repo, sidecars] of Object.entries(all)) {
    approvals[repo] = {};
    for (const s of sidecars) approvals[repo][s.name] = sidecarSignature(s);
  }
  writeFileSync(approvalsPath, JSON.stringify(approvals, null, 2) + '\n');
}

// ── archived worktrees (workspace/archived-worktrees.json: array of
// { repo, name, label, branch, prUrl, removedAt, reason } records) ──
// Same small-JSON-file convention as sidecars.json/file-sync.json/
// sidecar-approvals.json above, but a flat array (not repo-keyed): this is a
// chronological audit log of removed worktrees, not per-repo config. Purely
// additive record-keeping wrapped around removeWorktree() below. It does not
// change what gets deleted or how, and it cannot restore anything: the
// worktree directory is genuinely gone. This is just a browsable history of
// what was there and when it left.
const ARCHIVE_CAP = 500; // keep only the most recent 500 removals, drop the oldest beyond that

export function loadArchivedWorktrees(workspace) {
  try {
    const all = JSON.parse(readFileSync(join(workspace, 'archived-worktrees.json'), 'utf8'));
    return Array.isArray(all) ? all : [];
  } catch { return []; }
}

export function appendArchivedWorktree(workspace, record) {
  const path = join(workspace, 'archived-worktrees.json');
  let all = loadArchivedWorktrees(workspace);
  all.push(record);
  if (all.length > ARCHIVE_CAP) all = all.slice(all.length - ARCHIVE_CAP);
  writeFileSync(path, JSON.stringify(all, null, 2) + '\n');
}

// ── custom agent CLIs (workspace/custom-agents.json: [{id, label, command}]) ──
// Same load/save shape as sidecars, but global — not per-repo. "Open in X"
// is a per-developer tool preference, not scoped to one project. No which()
// check on these (unlike AGENT_CLIS/detectAgentClis): the user typed the
// exact command they want run, which may not be a bare PATH binary at all
// (a shell alias, a script with flags, ...).
function kebabSlug(s) {
  return String(s || '').toLowerCase().trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

export function loadCustomAgents(workspace) {
  try {
    return JSON.parse(readFileSync(join(workspace, 'custom-agents.json'), 'utf8'));
  } catch { return []; }
}

// Whole-list overwrite, matching saveSidecars()'s style. Also the sole place
// `id` is assigned/validated: kept as-is when it's already unique (so editing
// an existing custom agent's label doesn't silently change its routing id),
// otherwise derived as a lowercase-kebab slug of the label and deduped —
// against BOTH the built-in AGENT_CLIS ids and every other custom agent's id
// — since `id` is the routing key openInGhostty/openTool look up by, and a
// collision with a built-in would silently hijack that tool's entry.
export function saveCustomAgents(workspace, agents) {
  const used = new Set(Object.keys(AGENT_CLIS));
  const out = agents.map(a => {
    let id = a.id;
    if (!id || used.has(id)) {
      const base = kebabSlug(a.label) || 'agent';
      id = base;
      let n = 2;
      while (used.has(id)) id = `${base}-${n++}`;
    }
    used.add(id);
    return { command: a.command, id, label: a.label };
  });
  writeFileSync(join(workspace, 'custom-agents.json'), JSON.stringify(out, null, 2) + '\n');
}

// ── MCP servers (workspace/mcp-servers.json: [{id, name, transport, ...}]) ──
// Same global (not per-repo), whole-list-overwrite, kebab-slug-id shape as
// custom agents above — connecting to an MCP server is a per-developer tool
// preference, not scoped to one project.
export function loadMcpServers(workspace) {
  try {
    return JSON.parse(readFileSync(join(workspace, 'mcp-servers.json'), 'utf8'));
  } catch { return []; }
}

// id is kept as-is when already unique (so editing a server's name doesn't
// change its routing id), otherwise derived as a kebab slug of the name and
// deduped against every other configured server's id. This id is load-bearing
// beyond just routing: it's baked into the server's OAuth redirect_uri
// (/api/mcp/oauth/callback/<id>) at DCR time, so once assigned it must never
// change for that server, or every future auth attempt fails with a
// spec-level redirect_uri_mismatch. Renaming a server only ever touches name.
export function saveMcpServers(workspace, servers) {
  const used = new Set();
  const out = servers.map(s => {
    let id = s.id;
    if (!id || used.has(id)) {
      const base = kebabSlug(s.name) || 'mcp-server';
      id = base;
      let n = 2;
      while (used.has(id)) id = `${base}-${n++}`;
    }
    used.add(id);
    const server = { id, name: s.name, transport: s.transport };
    if (s.transport === 'stdio') {
      server.command = s.command;
      if (s.args?.length) server.args = s.args;
      if (s.env && Object.keys(s.env).length) server.env = s.env;
    } else if (s.transport === 'http') {
      server.url = s.url;
      server.httpAuthMode = s.httpAuthMode === 'oauth' ? 'oauth' : 'headers';
      if (server.httpAuthMode === 'headers' && s.headers && Object.keys(s.headers).length) server.headers = s.headers;
    }
    return server;
  });
  writeFileSync(join(workspace, 'mcp-servers.json'), JSON.stringify(out, null, 2) + '\n');
}

// ── MCP OAuth tokens (workspace/mcp-tokens.json: {[issuer]: {clientInformation, tokens}}) ──
// Deliberately a separate file from mcp-servers.json, same split as
// sidecars.json/sidecar-approvals.json: config vs. security state. Keyed by
// issuer (the resolved authorization server URL), not by server id, per
// SEP-2352 — two configured servers can share an authorization server and
// must never get cross-registered client credentials. Only durable post-auth
// artifacts live here; PKCE verifier, CSRF state, and discovery state are
// per-attempt and stay in mcp.js's in-memory pendingAuth map, never written
// to disk (an interrupted attempt isn't resumable across a portal restart
// regardless, so persisting that material would only be a stray secret on
// disk with no benefit). Every write chmod's explicitly to 0600 after
// writing, not via writeFileSync's {mode} option — that option only applies
// when a file is newly created, not on an overwrite of an existing one,
// which is this file's actual save pattern (whole-file overwrite every
// time). Accepted, explicit trade-off for a single-user local tool: the MCP
// SDK's own docs recommend OS-level secure storage "in production" — a 0600
// file is the pragmatic choice here, not a silent shortcut.
export function loadMcpTokens(workspace) {
  try {
    return JSON.parse(readFileSync(join(workspace, 'mcp-tokens.json'), 'utf8'));
  } catch { return {}; }
}

export function saveMcpTokens(workspace, tokensByIssuer) {
  const path = join(workspace, 'mcp-tokens.json');
  writeFileSync(path, JSON.stringify(tokensByIssuer, null, 2) + '\n');
  chmodSync(path, 0o600);
}

// Deregisters a project (drops it from the .projects registry and the "add
// worktree" dropdown) without touching anything already on disk — existing
// worktrees, their git history, and their ports keep working exactly as
// before. Removing a project is a registry edit, not a delete.
export function removeProject(workspace, name) {
  const path = join(workspace, '.projects');
  const lines = readFileSync(path, 'utf8').split('\n')
    .filter(l => l.trim() && !l.startsWith('#') && l.split(':')[0] !== name);
  writeFileSync(path, lines.join('\n') + '\n');
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

// Explicit, one-time migration prompt for exactly the sticky-bare case above
// — a worktree with bare history and no container history. Not automatic:
// the same silent-switch incident that made defaultContainerMode() sticky in
// the first place is exactly what "automatically" containerizing on next
// Start would reintroduce. Answered once (either choice, via
// markMigrationPrompted) and never asked again for that worktree.
function migrationMarkerPath(workspace, repo, name) {
  return join(workspace, repo, name, '.setu-migration-prompted');
}

export function needsMigrationPrompt(workspace, repo, name) {
  const wtDir = join(workspace, repo, name);
  if (existsSync(dockerComposePath(wtDir))) return false; // already containerized at some point
  if (!existsSync(join(workspace, 'logs', repo, name, 'dev.log'))) return false; // no bare history yet either
  return !existsSync(migrationMarkerPath(workspace, repo, name));
}

export function markMigrationPrompted(workspace, repo, name) {
  writeFileSync(migrationMarkerPath(workspace, repo, name), '');
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
// The actual host — what the Mac itself has, independent of whatever a
// Docker VM has been allocated (which is usually a fraction of this and is
// what engineCapacity() below reports). The settings UI shows both: this
// caps how high a concurrency slider can sensibly go, engineCapacity()
// explains why a container CPU/memory limit above the VM's own allocation
// gets silently clamped in writeDockerCompose().
export function macCapacity() {
  return { cpus: cpus().length, memMb: Math.floor(totalmem() / 1024 / 1024) };
}

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
// One directory, shared by every containerized worktree of every project —
// not a Docker named volume (those get project-prefixed by Compose unless
// marked `external: true`, which then requires the volume to already exist
// before `up`, real ceremony for no benefit here). A plain host bind mount
// works because unlike node_modules (real compiled/native binaries that
// can't cross the macOS-host/Linux-container boundary), bun's cache is just
// downloaded registry tarballs — genuinely portable, safe to share. Bun's
// own cache is tarball-level and keyed by name@version regardless of which
// project asked for it (confirmed against bun.sh/docs/install/cache), so
// two worktrees — even of different repos — installing the same version of
// the same package both hit this cache instead of both re-fetching.
// Concurrent `bun install`s from different containers writing here at once:
// the one documented race (oven-sh/bun#28062) is explicitly Windows-only in
// its own root-cause (a #[cfg(windows)] code path) — not proven safe on
// Linux by the docs, but no equivalent Linux corruption report exists
// either, and Setu's own concurrency cap keeps simultaneous container
// starts small regardless.
function bunCacheDir(workspace) {
  const dir = join(workspace, '.bun-cache');
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function writeDockerCompose(c, repo, name, port) {
  const wtDir = join(c.workspace, repo, name);
  const project = composeProjectName(repo, name);

  // Map, not an array of pairs — .envrc already contains `export PORT=...`
  // (writeEnvrc always writes it first), so a plain array would emit PORT
  // twice and Docker's YAML parser rejects the resulting duplicate mapping
  // key outright (`docker compose up` fails before anything starts).
  const env = new Map([['PORT', String(port)], ['BUN_INSTALL_CACHE_DIR', '/bun-cache']]);
  for (const [k, v] of Object.entries(parseEnvFile(join(wtDir, '.envrc')))) env.set(k, v);
  const envLines = [...env].map(([k, v]) => `      ${k}: ${JSON.stringify(v)}`).join('\n');

  const volumes = [
    `      - ${wtDir}:/workspace`,
    `      - node_modules:/workspace/node_modules`,
    `      - ${bunCacheDir(c.workspace)}:/bun-cache`,
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

// Async counterpart to git() for the two call sites that are genuinely
// network-bound (createWorktree's `fetch --all --prune`, syncWithBase's
// `fetch origin <branch>`) -- every other git() call is local filesystem
// work (~7-12ms), not worth converting. Bun.spawn instead of execFileSync so
// a slow/hung remote doesn't block the whole portal, same class of bug
// fetchPR already fixed. Throws on failure like git() itself (unlike
// spawnText, which silently returns '') -- both callers rely on a failed
// fetch aborting rather than silently proceeding against a stale base.
async function gitFetchAsync(dir, args) {
  const proc = Bun.spawn(['git', '-C', dir, ...args], { stderr: 'pipe', stdout: 'pipe' });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const code = await proc.exited;
  if (code !== 0) throw new Error(stderr.trim() || `git ${args.join(' ')} failed (exit ${code})`);
  return stdout;
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

// Merges the worktree's resolved base (same one branchMetadata's ahead/behind
// already compares against) into the worktree's own branch — "sync with
// staging" in the UI. Deliberately clean-only, by explicit decision: a merge
// that would conflict is attempted, detected via `git status --porcelain`'s
// conflict markers (UU/AA/etc — more reliable across git versions than
// parsing `git merge-tree` output), then immediately aborted so the worktree
// is never left mid-conflict. Setu tells you what would conflict; resolving
// it is still the user's job in their own editor.
export async function syncWithBase(wtDir, repoDir) {
  const base = baseBranchRef(repoDir);
  const branchName = base.replace(/^origin\//, '');
  await gitFetchAsync(wtDir, ['fetch', 'origin', branchName]);

  const dirty = git(wtDir, ['status', '--porcelain']).trim();
  if (dirty) return { error: 'Worktree has uncommitted changes — commit or stash first.', ok: false };

  try {
    git(wtDir, ['merge', base, '--no-edit']);
    return { base, ok: true };
  } catch (mergeErr) {
    const status = git(wtDir, ['status', '--porcelain']);
    const conflicts = status.split('\n')
      .filter(l => /^(UU|AA|DD|AU|UA|UD|DU)/.test(l))
      .map(l => l.slice(3).trim());
    // Only a real conflict leaves MERGE_HEAD behind — `merge --abort` itself
    // throws ("no merge to abort") if the failure was something else (e.g.
    // an unresolvable ref), which would otherwise crash this request instead
    // of reporting the actual error. --git-path (not a hardcoded .git/...)
    // because a linked worktree's .git is a file pointing elsewhere, not a
    // directory — the real MERGE_HEAD lives under the main repo's
    // worktrees/<name>/ dir, which only `git` itself resolves correctly.
    const mergeHeadPath = resolve(wtDir, git(wtDir, ['rev-parse', '--git-path', 'MERGE_HEAD']).trim());
    if (existsSync(mergeHeadPath)) git(wtDir, ['merge', '--abort']);
    if (!conflicts.length) return { error: `Merge failed: ${mergeErr.stderr || mergeErr.message}`, ok: false };
    return { conflicts, error: `Would conflict in ${conflicts.length} file${conflicts.length === 1 ? '' : 's'} — merge aborted, worktree unchanged.`, ok: false };
  }
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
    map.set(branch, { ahead: ahead ?? 0, behind: behind ?? 0, lastCommitAt: parseInt(at, 10) || null });
  }
  return map;
}

// Copies each glob's matches from the main worktree into a freshly created
// one, preserving the relative path and creating parent directories as
// needed. Copy, not symlink, unlike the .env.local step in createWorktree
// below: these files are meant to be independently editable per worktree.
// Globs resolve against mainDir itself (the worktree root), the same base
// the repo checks out into — not envLocalPath's quivly-app special-case, so
// a project needing an app-subdir file uses a glob with that subdir already
// in it, e.g. apps/quivly-app/.env.development.local.
// Never throws: a missing main worktree (first worktree ever) or a glob
// that matches nothing are both expected, logged, and skipped, not fatal to
// worktree creation.
export function syncIncludedFiles(mainDir, wtDir, globs) {
  if (!globs?.length) return;
  if (!existsSync(mainDir)) {
    console.warn(`⚠  file sync skipped — no main worktree yet at ${mainDir}`);
    return;
  }
  for (const pattern of globs) {
    let matches;
    try { matches = [...new Bun.Glob(pattern).scanSync({ cwd: mainDir, dot: true, onlyFiles: true })]; }
    catch (e) { console.warn(`⚠  file sync: bad glob "${pattern}": ${e.message}`); continue; }
    if (!matches.length) { console.warn(`⚠  file sync: "${pattern}" matched nothing in ${mainDir}`); continue; }
    for (const rel of matches) {
      if (rel.startsWith('..')) continue; // a glob can't reach outside mainDir
      const dest = join(wtDir, rel);
      if (existsSync(dest)) continue; // never clobber an already-edited copy
      try {
        mkdirSync(dirname(dest), { recursive: true });
        copyFileSync(join(mainDir, rel), dest);
      } catch (e) {
        console.warn(`⚠  file sync: failed to copy ${rel}: ${e.message}`);
      }
    }
  }
}

// Creates worktree + port + envrc + caddy + env symlink + hosts. Dependency
// install is the caller's job (CLI runs it inline, portal in the background).
export async function createWorktree(c, repo, name, { tunnel = false } = {}) {
  const repoDir = join(c.workspace, `${repo}.git`);
  const wtDir   = join(c.workspace, repo, name);
  if (!existsSync(repoDir)) throw new Error(`Bare repo not found: ${repoDir}\nRun: setu init <gh-slug>`);

  await gitFetchAsync(repoDir, ['fetch', '--all', '--prune']);
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
      const base = baseBranchRef(repoDir);
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

  const mainDir = join(c.workspace, repo, 'main');
  syncIncludedFiles(mainDir, wtDir, loadFileSyncGlobs(c.workspace, repo));

  syncHosts(c.workspace);
  reloadCaddy(c.workspace);

  return { localDom: localDomain(repo, name), port, pubDom: tunnel ? publicDomain(c) : null, wtDir };
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

// ── sweep & import (plain git clones outside Setu's bare+worktree layout) ────
// Finds repos like ~/soma or ~/Personal/skills that were never `setu init`-ed,
// so they can be brought in on request. Discovery never mutates a candidate:
// only remote-url and status reads. Import always bare-clones into a fresh
// ~/workspace/<name>.git and never touches the originally-discovered dir.

// The prune clause skips descending into dotfile-prefixed dirs and
// node_modules BEFORE find enters them, not after — this is what keeps a
// full $HOME walk fast and is why it correctly excludes every tool-cache
// noise source in one rule (.grok, .gemini, .claude, .codex, .zprezto)
// instead of a per-tool blocklist. `.git` itself is excluded from the
// dot-prefix prune (`! -name .git`) since a bare `-name '.*'` also matches
// `.git` and would prune away the exact directories this is looking for
// before the -name .git branch ever runs, verified live: the plan's original
// clause without this exclusion returns zero results, always. The trailing
// -prune after -print stops find from wastefully descending into a matched
// .git's own internals (objects/, refs/, ...) once it's already been found.
function sweepFindArgs(homeDir) {
  return [homeDir, '(', '-name', '.*', '-a', '!', '-name', '.git', '-o', '-name', 'node_modules', ')', '-prune',
    '-o', '-type', 'd', '-name', '.git', '-print', '-prune'];
}

// Same slug.split('/').pop() cmdInit already uses to name a project off a
// gh-slug CLI arg, applied here to whatever the discovered repo's remote URL
// resolves to instead. Generalized past github.com (a full $HOME walk finds
// clones from any host, not just GitHub) by stripping any scheme/host or ssh
// user@host: prefix first. No remote at all leaves only the containing
// directory's own name to go on.
function deriveSweepName(remoteUrl, dirName) {
  if (!remoteUrl) return dirName;
  const slug = remoteUrl.trim()
    .replace(/^\w+:\/\/[^/]+\//, '')
    .replace(/^[^@\s]+@[^:]+:/, '')
    .replace(/\.git$/, '');
  return slug.split('/').pop() || dirName;
}

// Pure, no I/O — shared by both discovery paths so the drop/conflict/
// importable rule lives in exactly one place. registeredRemotes is every
// already-registered project's actual origin URL (read from its bare repo,
// not the .projects slug field, so this compares the real clone source).
// Returns null for "drop entirely" (same remote already registered).
function classifySweepCandidate({ path, name, remoteUrl, dirty }, projects, registeredRemotes) {
  if (remoteUrl && registeredRemotes.has(remoteUrl)) return null;
  if (projects[name]) return { conflictWith: name, dirty, name, path, remoteUrl, status: 'conflict' };
  return { conflictWith: null, dirty, name, path, remoteUrl, status: remoteUrl ? 'importable' : 'no-remote' };
}

// Per-candidate git probes only (not the find walk, and not git() calls
// elsewhere in this file) — verified live: a repo living under iCloud Drive
// (~/Library/Mobile Documents/.../Backup/...) makes `git remote get-url` and
// `git status` hang for 4s+ per call while iCloud materializes the on-demand
// placeholder files, and a real $HOME on this machine turned up 20+ such
// candidates. Real local repos resolve in single-digit milliseconds even for
// a large monorepo (measured), so this timeout is pure headroom for them and
// a hard cap on the iCloud (or any other slow/network-mounted path) case.
const SWEEP_GIT_TIMEOUT_MS = 1500;

function readOriginUrl(dir) {
  try {
    return execFileSync('git', ['-C', dir, 'remote', 'get-url', 'origin'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: SWEEP_GIT_TIMEOUT_MS }).trim() || null;
  } catch { return null; }
}

function readDirty(dir) {
  try {
    return execFileSync('git', ['-C', dir, '--no-optional-locks', 'status', '--porcelain'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: SWEEP_GIT_TIMEOUT_MS }).trim().length > 0;
  } catch { return false; }
}

// CLI path: execFileSync, synchronous throughout. Blocking is fine here —
// this only runs when someone explicitly types `setu sweep`.
export function discoverRepos(homeDir) {
  const workspace = loadConfig().workspace;
  const projects  = workspace ? loadProjects(workspace) : {};
  const registeredRemotes = new Set(
    Object.keys(projects).map(name => readOriginUrl(join(workspace, `${name}.git`))).filter(Boolean)
  );

  let raw;
  try {
    // stderr piped (not inherited) — a full $HOME walk hits dozens of
    // permission-denied system dirs (~/Library/.../TCC, CallHistoryDB, ...)
    // that find reports on stderr; inheriting it would dump that noise
    // straight into the user's terminal on every `setu sweep`, verified live.
    raw = execFileSync('find', sweepFindArgs(homeDir), { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) { raw = e.stdout ?? ''; } // find exits non-zero on permission-denied subdirs, stdout is still complete
  const gitDirs = raw.split('\n').filter(Boolean);

  const out = [];
  for (const gitDir of gitDirs) {
    const dir  = resolve(gitDir, '..');
    const t0   = Date.now();
    const remoteUrl = readOriginUrl(dir);
    // Sequential (unlike the portal path's Promise.all pair), so a path that
    // already burned the full timeout on the first call — a git process
    // actually got killed, not just "no remote configured" — isn't worth
    // waiting the full timeout on again for the second. dirty is informational
    // only, false is a safe default for a path this unresponsive.
    const timedOut = Date.now() - t0 >= SWEEP_GIT_TIMEOUT_MS - 50;
    const dirty  = timedOut ? false : readDirty(dir);
    const name   = deriveSweepName(remoteUrl, dir.split('/').pop());
    const shaped = classifySweepCandidate({ dirty, name, path: dir, remoteUrl }, projects, registeredRemotes);
    if (shaped) out.push(shaped);
  }
  return out;
}

// Bounded-concurrency batch: chunks of `size` run concurrently via
// Promise.all, then the next chunk starts. Keeps a dozens-of-candidates sweep
// from spawning 100+ git processes at once (unbounded parallel would thrash)
// while staying far faster than fully sequential.
async function batchMap(items, size, fn) {
  const out = [];
  for (let i = 0; i < items.length; i += size) {
    out.push(...await Promise.all(items.slice(i, i + size).map(fn)));
  }
  return out;
}

// Shared by discoverReposAsync below and portal.js's fetchDirty/fetchPR/
// activeMemMb. Bun.spawn, not execFileSync, since a blocking exec call
// would freeze the single-threaded request handler for however long the
// walk/git/docker calls take. Trimmed stdout text on success, empty string
// on any failure (bad binary, non-zero exit, timeout); callers that need to
// distinguish "ran and printed nothing" from "failed to run" don't exist
// today, so this doesn't try to. timeoutMs is opt-in per call; omitted
// entirely for calls that should never be cut off (e.g. the sweep find walk,
// which can legitimately take multiple seconds over a full $HOME).
export async function spawnText(args, { timeoutMs } = {}) {
  try {
    const opts = { stderr: 'ignore', stdout: 'pipe' };
    if (timeoutMs) opts.timeout = timeoutMs;
    const proc = Bun.spawn(args, opts);
    const text = await new Response(proc.stdout).text();
    await proc.exited;
    return text.trim();
  } catch { return ''; }
}

async function readOriginUrlAsync(dir) {
  const out = await spawnText(['git', '-C', dir, 'remote', 'get-url', 'origin'], { timeoutMs: SWEEP_GIT_TIMEOUT_MS });
  return out || null;
}

async function readDirtyAsync(dir) {
  return (await spawnText(['git', '-C', dir, '--no-optional-locks', 'status', '--porcelain'], { timeoutMs: SWEEP_GIT_TIMEOUT_MS })).length > 0;
}

// Portal path: Bun.spawn based, async throughout (including the find walk
// itself, which can take multiple seconds over a full $HOME). Never blocks
// the event loop the way execFileSync would — this codebase has already hit
// and fixed that exact class of bug twice (fetchPR, the old per-worktree
// git() calls in getWorktrees()). Per-candidate git reads (remote-url +
// status, 2 spawns each) run in bounded batches, not fully unbounded
// parallel — a dozens-of-candidates home directory can otherwise spawn 100+
// processes at once.
export async function discoverReposAsync(homeDir) {
  const workspace = loadConfig().workspace;
  const projects  = workspace ? loadProjects(workspace) : {};
  const registeredRemotes = new Set(
    (await batchMap(Object.keys(projects), 8, name => readOriginUrlAsync(join(workspace, `${name}.git`))))
      .filter(Boolean)
  );

  const raw     = await spawnText(['find', ...sweepFindArgs(homeDir)]);
  const gitDirs = raw.split('\n').filter(Boolean);
  const dirs    = gitDirs.map(g => resolve(g, '..'));

  const shaped = await batchMap(dirs, 8, async dir => {
    const [remoteUrl, dirty] = await Promise.all([readOriginUrlAsync(dir), readDirtyAsync(dir)]);
    const name = deriveSweepName(remoteUrl, dir.split('/').pop());
    return classifySweepCandidate({ dirty, name, path: dir, remoteUrl }, projects, registeredRemotes);
  });
  return shaped.filter(Boolean);
}

// gh-clone when authenticated (keeps whatever SSH/HTTPS creds `gh auth
// login` already set up), else a plain git clone against remoteUrl directly.
// Either way, forces the origin fetch refspec afterward, since a bare clone's
// default refspec only tracks the one branch that was checked out, then
// does the first fetch. Shared by importRepo below and portal.js's
// addProject; stdio defaults to 'inherit' (importRepo's CLI callers want
// clone progress visible), addProject passes 'pipe' since it's headless.
export function cloneBareRepo(repoDir, remoteUrl, ghSlug, { stdio = 'inherit' } = {}) {
  const useGh = ghSlug && spawnSync('gh', ['auth', 'status'], { stdio: 'ignore' }).status === 0;
  if (useGh) {
    execFileSync('gh', ['repo', 'clone', ghSlug, repoDir, '--', '--bare'], { stdio });
  } else {
    execFileSync('git', ['clone', '--bare', remoteUrl, repoDir], { stdio });
  }
  git(repoDir, ['config', 'remote.origin.fetch', '+refs/heads/*:refs/remotes/origin/*']);
  git(repoDir, ['fetch', '--all', '--prune']);
}

// So an agent (or human) working inside a Setu-managed project's own
// worktree knows dev servers/ports/domains are Setu's job, not npm
// run dev — without that context nothing tells them Setu even exists.
// Deliberately project-level only (repo name, portal URL, CLI reference),
// never a specific worktree's port/domain: these two files are meant to be
// committed once to the project's default branch and inherited by every
// future worktree via git, so baking in THIS worktree's own assigned port
// would already be stale for the next one. Idempotent (safe to call again
// on an already-marked repo) and non-destructive to an existing AGENTS.md —
// appends one clearly delimited section instead of overwriting, matching
// how gstack's own skill-routing install appends to CLAUDE.md rather than
// replacing it. Written and staged, never committed here: committing to a
// project this tool doesn't own is the user's call, not an automatic one.
const SETU_AGENTS_SECTION_MARKER = '## Managed by Setu';

function setuAgentsSection(repo) {
  return `${SETU_AGENTS_SECTION_MARKER}\n\n` +
    `This project's git worktrees, local dev domains, and dev servers are managed by [Setu](https://github.com/quivly/setu) — don't run \`npm run dev\`/\`bun dev\` directly, use Setu so the portal keeps tracking the process.\n\n` +
    `**If \`setu\` isn't installed:**\n\`\`\`bash\ncurl -fsSL https://raw.githubusercontent.com/quivly/setu/main/install.sh | bash\nsetu setup\n\`\`\`\n\n` +
    `**Common commands** (run from anywhere):\n\`\`\`\nsetu ls ${repo}                    List this project's worktrees + running state\nsetu new ${repo} <branch>          Create a new worktree\nsetu start ${repo} <branch>        Start a worktree's dev server\nsetu stop  ${repo} <branch>        Stop it\nsetu cd    ${repo} <branch>        cd into the worktree\n\`\`\`\n\n` +
    `Live state (ports, domains, running status): \`setu ls ${repo} --json\`, or the portal API at \`http://localhost:${PORTAL_PORT}/api/worktrees\`.\n`;
}

function writeSetuAgentMarkers(repo, wtDir) {
  const markerPath = join(wtDir, '.setu.json');
  if (!existsSync(markerPath)) {
    writeFileSync(markerPath, JSON.stringify({
      managedBy: 'setu', repo, portal: `http://localhost:${PORTAL_PORT}`,
      install: 'curl -fsSL https://raw.githubusercontent.com/quivly/setu/main/install.sh | bash',
      docs: 'https://github.com/quivly/setu',
    }, null, 2) + '\n');
  }

  const agentsPath = join(wtDir, 'AGENTS.md');
  const existing = existsSync(agentsPath) ? readFileSync(agentsPath, 'utf8') : '';
  if (!existing.includes(SETU_AGENTS_SECTION_MARKER)) {
    const trimmed = existing.replace(/\s*$/, '');
    writeFileSync(agentsPath, (trimmed ? trimmed + '\n\n' : '') + setuAgentsSection(repo));
  }

  try { git(wtDir, ['add', '.setu.json', 'AGENTS.md']); } catch {}
}

// Extracted from cmdInit's clone->register->create-main-worktree sequence so
// `setu init` (a github slug) and sweep --import (an already-discovered
// clone's exact origin URL) share one implementation instead of two that can
// drift. Takes the full config object, not just the workspace path, because
// createWorktree needs it — same convention createWorktree/removeWorktree
// above already use. Never touches whatever directory the caller discovered
// remoteUrl from: this always clones fresh into workspace/<name>.git.
export async function importRepo(c, { name, remoteUrl, label = '' }) {
  const repoDir = join(c.workspace, `${name}.git`);
  const ghSlug  = remoteUrl?.match(/github\.com[:/]([^/]+\/[^/]+?)(?:\.git)?$/)?.[1] ?? '';

  if (!existsSync(repoDir)) {
    if (!remoteUrl) throw new Error(`No remote URL for ${name}, cannot clone.`);
    // createWorktree() below runs `git worktree add` into
    // join(c.workspace, name, 'main'). If that directory already exists (a
    // plain clone discovered by sweep, sitting at exactly this project's
    // derived name) the worktree lands as an untracked subfolder inside it
    // instead of getting its own clean directory. Verified live via sweep
    // --import. Only checked here, gated on repoDir not existing yet, so a
    // re-run of setu init on an already-initialized project, where this
    // directory is expected to exist and is setu's own, is unaffected.
    const wtParentDir = join(c.workspace, name);
    if (existsSync(wtParentDir)) {
      throw new Error(`A directory already exists at ${wtParentDir} and importing would nest a worktree inside it. Move or rename it first, or choose a different project name.`);
    }
    cloneBareRepo(repoDir, remoteUrl, ghSlug);
  }

  registerProject(c.workspace, { label, name, slug: ghSlug });
  const result = await createWorktree(c, name, 'main');
  writeSetuAgentMarkers(name, result.wtDir);
  return result;
}

// ── portal client (used by CLI to talk to the running portal) ────────────────

export function portalPid() {
  return activePid(PORTAL_PORT);
}

// The portal's own API isn't uniform: GET /api/worktrees and /api/projects
// return a raw array with no `ok` field at all, POST routes return
// {ok, error?, ...}. A bare `res.json()` used to resolve either way,
// including a jsonTry 500 (`{ok:false,...}`), which meant a genuine
// failure looked identical to success to every caller unless they happened
// to already check `.ok` themselves. Throw only on an explicit
// `ok === false` (mutating routes' own failure shape); an array or a
// plain object with no `ok` key at all is success, not "no field to check."
export async function portalRequest(path, body) {
  const res = await fetch(`http://localhost:${PORTAL_PORT}${path}`, body === undefined
    ? { signal: AbortSignal.timeout(5000) }
    : { 
        body: JSON.stringify(body), headers: { 'content-type': 'application/json' },method: 'POST', signal: AbortSignal.timeout(30000) });
  const data = await res.json();
  if (data && typeof data === 'object' && !Array.isArray(data) && data.ok === false) {
    throw new Error(data.error ?? `${path} failed`);
  }
  return data;
}
