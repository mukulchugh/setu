// lib.js — shared helpers for setu cli.js + portal.js.
// Single source of truth for config, domains, ports, envrc/caddy/hosts writes,
// and worktree lifecycle. Throws Error on failure; callers decide die vs JSON.

import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { cpus, homedir, totalmem } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCommandRunner, renderDockerCompose } from './dev-runtime.js';
import { assertStorageHeadroom } from './host-health.js';
import {
  cloneBareRepository,
  prepareWorktreeCheckout,
} from './workspace-setup.js';
import { createWorkspaceState, StateError } from './workspace-state.js';
import {
  effectiveContainerLimits as lifecycleContainerLimits,
  parseMemToMb as lifecycleParseMemory,
  resourceSettings as lifecycleResourceSettings,
} from './worktree-lifecycle.js';
import { validateRemovalRecords } from './worktree-removal.js';
import { discoverWriterWorktrees } from './writer-claims.js';

const tunnelIdPattern = /^[0-9a-f-]{36}$/i;
const environmentAssignmentPattern =
  /^\s*(?:export\s+)?([\w.-]+)\s*=\s*(.*?)\s*$/;
const triggerVersionPrefixPattern = /^[\^~]/;
const listenerPortPattern = /:(\d+)$/;
const sidecarNamePattern = /^[a-zA-Z0-9_-]+$/;
const gitDirectoryPattern = /^gitdir:\s*(.+)\s*$/m;
const worktreePathPattern = /^worktree (.+)$/m;
const worktreeBranchPattern = /^branch refs\/heads\/(.+)$/m;
const originPrefixPattern = /^origin\//;
const mergeConflictPattern = /^(UU|AA|DD|AU|UA|UD|DU)/;
const environmentFilePattern = /^\.env/;
const remoteUrlSchemePattern = /^\w+:\/\/[^/]+\//;
const remoteUrlSshPattern = /^[^@\s]+@[^:]+:/;
const remoteUrlGitSuffixPattern = /\.git$/;
const trailingWhitespacePattern = /\s*$/;
const lineBreakPattern = /\r?\n/;
const githubSlugPattern = /github\.com[:/]([^/]+\/[^/]+?)(?:\.git)?$/;
const unsafeWorktreeTextPattern = /[\\:]/;
const whitespacePattern = /\s+/;

function hasAsciiControlCharacter(value) {
  for (const character of value) {
    if (character.codePointAt(0) <= 0x20) {
      return true;
    }
  }
  return false;
}

// Keep the established library API while lifecycle owns the implementation.
export const effectiveContainerLimits = lifecycleContainerLimits;
export const parseMemToMb = lifecycleParseMemory;
export const resourceSettings = lifecycleResourceSettings;

export const HOME = homedir();
export const CFG_PATH = join(HOME, '.setu.json');
// Deliberately separate from CFG_PATH, not a section inside it: this holds
// org-admin-scope API keys (Anthropic/OpenAI usage & cost reporting), a
// materially bigger blast radius than the rest of ~/.setu.json, and the
// user writes it by hand (never through the portal) so a key is never typed into
// a form this tool could echo back. Unrelated to the committed .setu.json
// writeSetuAgentMarkers drops into MANAGED PROJECTS below — same filename
// stem, opposite commit semantics; see AGENTS.md's Conventions section.
export const COSTS_CFG_PATH = join(HOME, '.setu-costs.json');
export const SETU_DIR = dirname(fileURLToPath(import.meta.url));
export const PACKAGE_VERSION = JSON.parse(
  readFileSync(join(SETU_DIR, 'package.json'), 'utf8')
).version;
export const PORTAL_PORT = 2999;
// Must match the sudoers rule written by `setu setup` — keep the two in sync.
export const HOSTS_TMP = '/tmp/setu-hosts';
export const HOSTS_START = '# setu-start';
export const HOSTS_END = '# setu-end';

// Importing shared helpers must not spawn Homebrew (including offline `setu rm`).
export const BREW_PREFIX =
  process.env.HOMEBREW_PREFIX ||
  ['/opt/homebrew', '/usr/local'].find((prefix) =>
    existsSync(join(prefix, 'bin', 'brew'))
  ) ||
  (process.arch === 'arm64' ? '/opt/homebrew' : '/usr/local');
export const CADDY_BIN = join(BREW_PREFIX, 'bin', 'caddy');
export const CLOUDFLARED_BIN = join(BREW_PREFIX, 'bin', 'cloudflared');

// ── config ────────────────────────────────────────────────────────────────────

export function workspaceState(workspace, options = {}) {
  return createWorkspaceState({
    configPath: CFG_PATH,
    setuDir: SETU_DIR,
    workspaceRoot: workspace,
    ...options,
  });
}

export function loadConfig(options = {}) {
  return workspaceState(undefined, options).read('config');
}

export const DEFAULT_LOCAL_ZONE = 'setu.local';

// Local suffix for the portal and every worktree domain (`setu setup --local-zone`).
export function localZone(c = loadConfig()) {
  return c.localZone || DEFAULT_LOCAL_ZONE;
}

// Only fields the caller intends to change belong in patch. Never pass a stale full snapshot.
export function saveConfig(patch, options = {}) {
  return workspaceState(undefined, options).update('config', (current) => {
    const next = { ...current, ...patch };
    resourceSettings(next);
    return next;
  });
}

export function installedStateValue(result) {
  if (!result.reconciled) {
    const error = new StateError(
      'STATE_RECONCILIATION_REQUIRED',
      'store',
      'readback'
    );
    error.committed = true;
    throw error;
  }
  if (result.warning) {
    console.warn(
      `${result.warning.code}: ${result.warning.phase}; state was committed`
    );
  }
  return result.value;
}

export function tunnelCredentials(directory, name, tunnels) {
  const matches = tunnels.filter((t) => t.name === name);
  if (matches.length !== 1 || !tunnelIdPattern.test(matches[0].id)) {
    throw new Error(`Could not identify tunnel ${name}`);
  }
  const path = join(directory, `${matches[0].id}.json`);
  const credentials = JSON.parse(readFileSync(path, 'utf8'));
  if (credentials.TunnelID !== matches[0].id) {
    throw new Error(`Credentials do not match tunnel ${name}`);
  }
  return path;
}

export function requireConfig() {
  const c = loadConfig();
  if (!(c.workspace && c.domain)) {
    throw new Error('Not configured — run `setu setup` first.');
  }
  return c;
}

export function portalRequestError(req, address, port = PORTAL_PORT) {
  const local = (ip) =>
    ip === '::1' || ip === '127.0.0.1' || ip === '::ffff:127.0.0.1';
  if (!local(address)) {
    return 'Setu only accepts local connections';
  }
  // Caddy is local too; do not let its proxy turn the portal into a LAN API.
  const forwarded = req.headers.get('x-forwarded-for');
  if (forwarded && !forwarded.split(',').every((ip) => local(ip.trim()))) {
    return 'Remote proxy clients are not allowed';
  }
  const hosts = new Set([
    `localhost:${port}`,
    `127.0.0.1:${port}`,
    `[::1]:${port}`,
    localZone(),
    `${localZone()}:80`,
  ]);
  const url = new URL(req.url);
  if (!hosts.has((req.headers.get('host') || url.host).toLowerCase())) {
    return 'Untrusted Host';
  }
  const origin = req.headers.get('origin');
  if (origin) {
    try {
      const parsed = new URL(origin);
      if (parsed.protocol !== 'http:' || !hosts.has(parsed.host)) {
        return 'Untrusted Origin';
      }
    } catch {
      return 'Untrusted Origin';
    }
  }
  const oauthCallback =
    req.method === 'GET' && url.pathname.startsWith('/api/mcp/oauth/callback/');
  if (!oauthCallback && req.headers.get('sec-fetch-site') === 'cross-site') {
    return 'Cross-site request rejected';
  }
  return null;
}

export function validateWorktreeNames(repo, name) {
  const safe = (value) =>
    typeof value === 'string' &&
    value.length > 0 &&
    !unsafeWorktreeTextPattern.test(value) &&
    !hasAsciiControlCharacter(value) &&
    value
      .split('/')
      .every(
        (part) => part && part !== '.' && part !== '..' && !part.startsWith('-')
      );
  if (!safe(repo) || repo.includes('/') || !safe(name)) {
    throw new Error('Invalid repo or worktree name');
  }
}

export function managedWorktreePath(
  workspace,
  repo,
  name,
  { registered = true } = {}
) {
  validateWorktreeNames(repo, name);
  if (!(registered || Object.hasOwn(loadProjects(workspace), repo))) {
    throw new Error('Project is not registered');
  }
  if (registered && !getPort(workspace, repo, name)) {
    throw new Error('Worktree is not registered');
  }
  return join(workspace, repo, name);
}

export function shellQuote(value) {
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}

// Never written by this tool — see COSTS_CFG_PATH's own comment. Read-only,
// same try/empty-object shape as loadConfig, so a missing/malformed file
// just reads as "nothing configured" rather than a crash.
export function loadCostsConfig() {
  try {
    return JSON.parse(readFileSync(COSTS_CFG_PATH, 'utf8'));
  } catch {
    return {};
  }
}

// ── domains ───────────────────────────────────────────────────────────────────

export function slugify(name) {
  return name.replace(/\//g, '-');
}

export function localDomain(repo, name, zone = localZone()) {
  return `${name === 'main' ? repo : slugify(name)}.${zone}`;
}

// Single shared public URL per developer (dev-<name>.<zone>). One worktree at a
// time owns it; the portal moves it between worktrees.
export function publicDomain(c) {
  return c.domain;
}

// ── env files ─────────────────────────────────────────────────────────────────

// ponytail: monorepo convention — apps/<repo>/ wins when present; add a
// per-project envDir setting if a repo ever breaks this convention.
export function envLocalPath(repo, wtDir) {
  const appDir = join(wtDir, 'apps', repo);
  return join(existsSync(appDir) ? appDir : wtDir, '.env.local');
}

export function parseEnvFile(path) {
  if (!existsSync(path)) {
    return {};
  }
  const out = {};
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (!line.trim() || line.trim().startsWith('#')) {
      continue;
    }
    const m = line.match(environmentAssignmentPattern);
    if (m) {
      out[m[1]] = m[2].replace(/^['"]|['"]$/g, '');
    }
  }
  return out;
}

function hasConvexEnv(dir) {
  const env = {
    ...parseEnvFile(join(dir, '.env')),
    ...parseEnvFile(join(dir, '.env.local')),
  };
  return (
    typeof env.CONVEX_DEPLOYMENT === 'string' &&
    env.CONVEX_DEPLOYMENT.length > 0
  );
}

// Convex is configured for a worktree when either signal is present: a
// convex/ folder (checked into git, present from a fresh clone before anyone
// has ever run `convex dev` locally) or a CONVEX_DEPLOYMENT line (written by
// a prior `npx convex dev`, which can outlive convex/ being gitignored in
// some setups). Checked at both the worktree root and the envLocalPath-
// resolved app dir, root first -- covers a plain repo (the two resolve to the
// same directory) and a monorepo where the app -- and therefore convex/ --
// lives nested (apps/<repo>, the monorepo convention envLocalPath follows). Returns the directory Convex actually
// lives in rather than a bare boolean, so callers spawn `npx convex dev`/
// `deploy` from the right cwd instead of re-deriving this same resolution
// themselves.
export function convexDir(repo, wtDir) {
  if (existsSync(join(wtDir, 'convex')) || hasConvexEnv(wtDir)) {
    return wtDir;
  }
  const appDir = dirname(envLocalPath(repo, wtDir));
  if (
    appDir !== wtDir &&
    (existsSync(join(appDir, 'convex')) || hasConvexEnv(appDir))
  ) {
    return appDir;
  }
  return null;
}

// The trigger.dev CLI aborts if its own version doesn't match the pinned
// @trigger.dev/sdk in package.json — resolve the same version instead of `@latest`.
export function pinnedTriggerVersion(wtDir) {
  try {
    const pkg = JSON.parse(readFileSync(join(wtDir, 'package.json'), 'utf8'));
    const v =
      pkg.dependencies?.['@trigger.dev/sdk'] ??
      pkg.devDependencies?.['@trigger.dev/sdk'];
    return v ? v.replace(triggerVersionPrefixPattern, '') : 'latest';
  } catch {
    return 'latest';
  }
}

export function readEnvrc(wtDir) {
  try {
    return readFileSync(join(wtDir, '.envrc'), 'utf8');
  } catch {
    return '';
  }
}

export function tunnelEnabled(wtDir, c) {
  return readEnvrc(wtDir).includes(`https://${c.domain}`);
}

export async function writeEnvrc(wtDir, port, appUrl) {
  installedStateValue(
    await workspaceState(undefined).replaceText(
      join(wtDir, '.envrc'),
      `export PORT=${port}\nexport NEXT_PUBLIC_APP_BASE_URL=${appUrl}\n`
    )
  );
  await allowDirenvAsync(wtDir);
}

export async function allowDirenvAsync(
  wtDir,
  { spawn = (args, options) => Bun.spawn(args, options) } = {}
) {
  try {
    const proc = spawn(['direnv', 'allow', wtDir], {
      stderr: 'ignore',
      stdin: 'ignore',
      stdout: 'ignore',
      timeout: 5000,
    });
    await proc.exited;
  } catch {
    // direnv is optional, as with the synchronous CLI helper it replaces.
  }
}

export async function configureWorktreeEnv(c, repo, name, port, withTunnel) {
  const wtDir = join(c.workspace, repo, name);
  if (withTunnel) {
    const pd = publicDomain(c);
    await writeEnvrc(wtDir, port, `https://${pd}`);
  } else {
    // The worktree's own domain, not localhost: OAuth callbacks built from
    // this URL must land back on the domain the browser actually visited.
    const ld = localDomain(repo, name);
    await writeEnvrc(wtDir, port, `http://${ld}`);
  }
  await writeCaddy(c, repo, name, port, withTunnel);
}

// ── caddy ─────────────────────────────────────────────────────────────────────

export function caddySnippetPath(workspace, repo, name) {
  return join(workspace, 'caddy.d', `${repo}-${slugify(name)}.caddy`);
}

export function writeCaddy(
  c,
  repo,
  name,
  port,
  withTunnel,
  { state = workspaceState(c.workspace) } = {}
) {
  return state.withRouting(async () => {
    const { ports } = await state.snapshot(['ports']);
    if (
      !ports.some((row) => row.key === `${repo}/${name}` && row.port === port)
    ) {
      throw new Error('Routing target registration changed');
    }
    const ld = localDomain(repo, name);
    const body = withTunnel
      ? `http://${ld},\nhttp://${publicDomain(c)} {\n  reverse_proxy localhost:${port}\n}\n`
      : `http://${ld} {\n  reverse_proxy localhost:${port}\n}\n`;
    const result = await state.replaceText(
      caddySnippetPath(c.workspace, repo, name),
      body
    );
    installedStateValue(result);
    return result;
  });
}

// Never prompts (sudo -n): callers may be detached with no TTY. The sudoers
// rule from `setu setup` covers exactly this argv.
export function reloadCaddy(
  workspace,
  { state = workspaceState(workspace), run = execFileSync } = {}
) {
  return state.withRouting(() => {
    const caddyfile = join(workspace, 'Caddyfile');
    try {
      run('sudo', ['-n', CADDY_BIN, 'reload', '--config', caddyfile], {
        stdio: 'ignore',
        timeout: 5000,
      });
      return true;
    } catch {
      console.warn(
        `⚠  caddy reload failed — run: sudo ${CADDY_BIN} reload --config ${caddyfile}`
      );
      return false;
    }
  });
}

// biome-ignore lint/suspicious/useAwait: Routing callers require any synchronous state failure to reject from this Promise-returning portal boundary.
export async function reloadCaddyAsync(
  workspace,
  {
    state = workspaceState(workspace),
    run = async (args, { timeoutMs }) => {
      const proc = Bun.spawn(args, {
        stderr: 'ignore',
        stdin: 'ignore',
        stdout: 'ignore',
        timeout: timeoutMs,
      });
      if ((await proc.exited) !== 0) {
        throw new Error('caddy reload failed');
      }
    },
  } = {}
) {
  return state.withRouting(async () => {
    const caddyfile = join(workspace, 'Caddyfile');
    try {
      await run(['sudo', '-n', CADDY_BIN, 'reload', '--config', caddyfile], {
        timeoutMs: 5000,
      });
      return true;
    } catch {
      console.warn(
        `⚠  caddy reload failed — run: sudo ${CADDY_BIN} reload --config ${caddyfile}`
      );
      return false;
    }
  });
}

// ── /etc/hosts sync ───────────────────────────────────────────────────────────

export function syncHosts(
  workspace,
  {
    state = workspaceState(workspace),
    hostsPath = '/etc/hosts',
    stagingPath = HOSTS_TMP,
    run = execFileSync,
  } = {}
) {
  return state.withRouting(async () => {
    const raw = readFileSync(hostsPath, 'utf8');
    const cleaned = raw.replace(
      new RegExp(`\\n?${HOSTS_START}[\\s\\S]*?${HOSTS_END}\\n?`),
      ''
    );
    const { config, ports } = await state.snapshot(['config', 'ports']);
    const zone = localZone(config);
    // Portal host too: /etc/hosts still resolves when a VPN/WARP bypasses
    // /etc/resolver, so dnsmasq is never the only path to the portal.
    const entries = [
      `127.0.0.1\t${zone}`,
      ...ports.map(
        ({ repo, name }) => `127.0.0.1\t${localDomain(repo, name, zone)}`
      ),
    ];
    const next =
      cleaned.trimEnd() +
      `\n${HOSTS_START}\n` +
      entries.join('\n') +
      `\n${HOSTS_END}\n`;
    installedStateValue(await state.replaceText(stagingPath, next));
    try {
      run('sudo', ['-n', '/bin/cp', stagingPath, hostsPath], {
        stdio: 'ignore',
        timeout: 5000,
      });
      return true;
    } catch {
      console.warn(
        '⚠  /etc/hosts sync failed — re-run `setu setup` to repair the sudoers rule'
      );
      return false;
    }
  });
}

// ── ports registry (workspace/.ports: "repo/name:port") ──────────────────────

export function portsRaw(workspace) {
  return portEntries(workspace)
    .map((row) => `${row.key}:${row.port}`)
    .join('\n');
}

// "repo/name" -> {repo, name}, split on the first '/'. A worktree name can
// itself contain '/' (e.g. a branch like "feat/x"), the repo name can't.
export function splitKey(key) {
  const si = key.indexOf('/');
  return { name: key.slice(si + 1), repo: key.slice(0, si) };
}

export function portEntries(workspace) {
  return workspaceState(workspace).read('ports');
}

export function getPort(workspace, repo, name) {
  return (
    portEntries(workspace).find((e) => e.repo === repo && e.name === name)
      ?.port ?? null
  );
}

export function activePid(port) {
  try {
    return execFileSync('lsof', [`-iTCP:${port}`, '-sTCP:LISTEN', '-t'], {
      stdio: ['ignore', 'pipe', 'ignore'],
    })
      .toString()
      .trim();
  } catch {
    return '';
  }
}

// Async sibling of activePid, for portal.js's request-handler hot paths —
// execFileSync blocks Bun's single JS thread for the whole lsof call,
// stalling every other in-flight request (same class of bug fetchPR hit,
// see its own comment). cli.js keeps calling the sync version: a one-shot
// foreground process has no concurrent requests to starve.
// biome-ignore lint/suspicious/useAwait: Public async callers must receive rejected Promises for argument coercion or spawn setup failures.
export async function activePidAsync(port) {
  return spawnText(['lsof', `-iTCP:${port}`, '-sTCP:LISTEN', '-t']);
}

// Covers app dev-server ports (3000-3999) and inngest sidecar ports (appPort+5288,
// i.e. 8288-9287) in one lsof call. spawnSync, not execFileSync: with two -i
// selectors lsof exits 1 even when it successfully printed matches (verified) —
// execFileSync throws on that and discards output that was actually fine.
export function listActivePorts() {
  const res = spawnSync(
    'lsof',
    [
      '-i',
      'TCP:3000-3999',
      '-i',
      'TCP:8288-9287',
      '-sTCP:LISTEN',
      '-nP',
      '-F',
      'pcn',
    ],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }
  );
  const out = res.stdout ?? '';
  const results = [];
  const seen = new Set();
  let cur = {};
  for (const line of out.split('\n')) {
    if (line.startsWith('p')) {
      cur = { pid: line.slice(1) };
    } else if (line.startsWith('c')) {
      cur.cmd = line.slice(1);
    } else if (line.startsWith('n')) {
      const m = line.match(listenerPortPattern);
      if (!m) {
        continue;
      }
      // A process listening on both IPv4 and IPv6 for the same port (e.g.
      // OrbStack's port-forwarding helper, confirmed live: two separate fds
      // both bound to `*:<port>`) prints one 'n' line per socket under the
      // same 'p' block — without this, that's a duplicate row per extra
      // protocol, not one row per actually-distinct listener.
      const key = `${cur.pid}:${m[1]}`;
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      results.push({ cmd: cur.cmd, pid: cur.pid, port: +m[1] });
    }
  }
  return results;
}

// cwd of a live process, via lsof — used to verify a port's actual listener
// belongs to the worktree the registry claims it does (setu doctor/prune).
export function processCwd(pid) {
  try {
    const out = execFileSync(
      'lsof',
      ['-a', '-p', String(pid), '-d', 'cwd', '-Fn'],
      { encoding: 'utf8' }
    );
    return (
      out
        .split('\n')
        .find((l) => l.startsWith('n'))
        ?.slice(1) ?? null
    );
  } catch {
    return null;
  }
}

// ── AI coding CLI detection ──────────────────────────────────────────────────
// No single "which agent CLIs are installed + launch one" package exists as an
// importable primitive (checked: dmux/agentmanager/Codeman all bundle detection
// into a much bigger opinionated tool). This registry + which-check is the
// lazy version — a static tool-id -> binary map, not hardcoded to any one
// project's preferred 4 tools. Detected live (not cached) so installing a new
// CLI doesn't need a portal restart to be picked up.
export const AGENT_CLIS = {
  aider: { bin: 'aider', label: 'Aider' },
  amp: { bin: 'amp', label: 'Amp' },
  antigravity: { bin: 'antigravity-ide', label: 'Antigravity' },
  claude: { bin: 'claude', label: 'Claude' },
  codex: { bin: 'codex', label: 'Codex' },
  cursor: { bin: 'cursor-agent', label: 'Cursor' },
  grok: { bin: 'grok', label: 'Grok' },
  opencode: { bin: 'opencode', label: 'opencode' },
};

export function commandExists(bin) {
  return Boolean(Bun.which(bin));
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
    const out = execFileSync('ps', ['-o', 'pgid=', '-p', String(pid)], {
      encoding: 'utf8',
    }).trim();
    if (out) {
      pgid = Number.parseInt(out, 10);
    }
  } catch {
    // Preserve the legacy signal fallback when process metadata is unavailable.
  }
  const target = pgid === pid ? `-${pgid}` : String(pid);
  try {
    execFileSync('kill', [`-${signal}`, '--', target], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

export function detectAgentClis(workspace) {
  const builtins = Object.entries(AGENT_CLIS)
    .filter(([, t]) => commandExists(t.bin))
    .map(([id, t]) => ({ id, label: t.label }));
  // Custom agents are never which-checked (see loadCustomAgents) — appended
  // as-is after the verified built-ins.
  const custom = loadCustomAgents(workspace).map(({ id, label }) => ({
    id,
    label,
  }));
  return [...builtins, ...custom];
}

// biome-ignore lint/suspicious/useAwait: Registry validation may throw synchronously; callers use this as a Promise-returning allocation boundary.
export async function assignPort(
  workspace,
  repo,
  name,
  { state = workspaceState(workspace), probe = allocationListeners } = {}
) {
  validateWorktreeNames(repo, name);
  return state.withWorkspace(
    ['ports', 'projects', 'removals'],
    async (scope) => {
      const entries = scope.read('ports'),
        pending = scope.read('removals');
      const key = `${repo}/${name}`;
      const reservations = pendingRemovalReservations(pending);
      if (reservations.some((row) => row.key === key)) {
        throw new Error('Worktree has pending removal recovery');
      }
      const existing = entries.find((row) => row.key === key);
      if (existing) {
        return existing.port;
      }
      const used = new Set([
        ...entries.map((row) => row.port),
        ...reservations.map((row) => row.port),
      ]);
      // One bounded listener scan is the only OS work allowed in this metadata scope.
      const listening = await probe();
      if (!(listening instanceof Set)) {
        throw new StateError(
          'STATE_UNREADABLE',
          'ports',
          'listener-observation'
        );
      }
      let port = scope.read('projects')[repo]?.base ?? 3200;
      while (used.has(port) || listening.has(port)) {
        port += 1;
      }
      if (port > 65_535) {
        throw new Error('No free managed port available');
      }
      installedStateValue(
        scope.replace('ports', [...entries, { key, name, port, repo }])
      );
      return port;
    }
  );
}

export function releasePort(workspace, repo, name) {
  validateWorktreeNames(repo, name);
  return workspaceState(workspace).update('ports', (entries) =>
    entries.filter((row) => row.key !== `${repo}/${name}`)
  );
}

function pendingRemovalReservations(pending) {
  // The recovery owner supplies versioned records. Unknown envelopes cannot free a port.
  const records = Object.values(pending);
  if (
    !records.every((row) => {
      if (
        !row ||
        typeof row !== 'object' ||
        typeof row.key !== 'string' ||
        !Number.isInteger(row.port) ||
        row.port < 1 ||
        row.port > 65_535
      ) {
        return false;
      }
      const slash = row.key.indexOf('/');
      if (slash < 1) {
        return false;
      }
      try {
        validateWorktreeNames(
          row.key.slice(0, slash),
          row.key.slice(slash + 1)
        );
        return true;
      } catch {
        return false;
      }
    })
  ) {
    throw new StateError('STATE_CORRUPT', 'removals', 'reservations');
  }
  return records;
}

async function allocationListeners() {
  let proc;
  try {
    proc = Bun.spawn(['lsof', '-nP', '-iTCP', '-sTCP:LISTEN', '-F', 'n'], {
      stderr: 'pipe',
      stdout: 'pipe',
      timeout: 2000,
    });
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    if (
      proc.signalCode ||
      ![0, 1].includes(code) ||
      (code === 1 && !stdout.trim() && stderr.trim())
    ) {
      throw new Error('unknown listeners');
    }
    return new Set(
      [...stdout.matchAll(/^n.*:(\d+)(?:\s.*)?$/gm)].map((match) =>
        Number(match[1])
      )
    );
  } catch {
    // biome-ignore lint/style/useErrorCause: Listener probing intentionally maps all raw command failures to this sanitized state error.
    throw new StateError('STATE_UNREADABLE', 'ports', 'listener-observation');
  }
}

// ── projects registry (workspace/.projects: "name:base:slug:label") ──────────

export function loadProjects(workspace) {
  return workspaceState(workspace).read('projects');
}

// Inventory includes stale registrations and missing checkouts; these expected
// paths are for inspection only, never authorization to act on a checkout.
export function workspaceInventoryRegistry(workspace) {
  const registrations = portEntries(workspace).map((entry) => {
    validateWorktreeNames(entry.repo, entry.name);
    return { ...entry, path: join(workspace, entry.repo, entry.name) };
  });
  const repos = new Set([
    ...Object.keys(loadProjects(workspace)),
    ...registrations.map((entry) => entry.repo),
  ]);
  return {
    projects: [...repos].map((repo) => {
      validateWorktreeNames(repo, 'main');
      return { repo, repoDir: join(workspace, `${repo}.git`) };
    }),
    registrations,
  };
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
  return loadAllSidecars(workspace, repo).filter(
    (s) => s.enabled !== false && s.command
  );
}

// Unfiltered — the settings UI needs to show and edit disabled/incomplete
// entries too, unlike loadSidecars() (used on the start path, which only
// ever wants what's actually enabled and runnable).
export function loadAllSidecars(workspace, repo) {
  const all = workspaceState(workspace).read('sidecars');
  return Object.hasOwn(all, repo) ? all[repo] : [];
}

export function saveSidecars(workspace, repo, sidecars) {
  const normalized = sidecars.map((sidecar) => {
    const name = typeof sidecar.name === 'string' ? sidecar.name.trim() : '';
    if (!sidecarNamePattern.test(name)) {
      throw Object.assign(
        new Error(
          'Sidecar name must use only letters, numbers, underscores, or hyphens'
        ),
        {
          code: 'SIDECAR_NAME_INVALID',
        }
      );
    }
    return { ...sidecar, name };
  });
  return workspaceState(workspace).update('sidecars', (all) => ({
    ...all,
    [repo]: normalized,
  }));
}

// ── file sync (workspace/file-sync.json: { [repo]: string[] } of glob patterns) ──
// Same per-repo JSON store shape as sidecars.json above, holding the extra
// gitignored files (beyond the shared .env.local, which is symlinked further
// down in createWorktree) each project wants copied into every new worktree
// so it gets its own independently editable copy — a .env.development.local,
// a config/local.json, whatever a given repo needs that isn't in git.
export function loadFileSyncGlobs(workspace, repo) {
  const all = workspaceState(workspace).read('fileSync');
  return Object.hasOwn(all, repo) ? all[repo] : [];
}

export function saveFileSyncGlobs(workspace, repo, globs) {
  return workspaceState(workspace).update('fileSync', (all) => ({
    ...all,
    [repo]: globs,
  }));
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
  const all = workspaceState(workspace).read('approvals');
  return Object.hasOwn(all, repo) ? all[repo] : {};
}

export function saveSidecarApprovals(workspace, repo, approvals) {
  return workspaceState(workspace).update('approvals', (all) => ({
    ...all,
    [repo]: approvals,
  }));
}

export function isSidecarApproved(workspace, repo, sidecar) {
  const approvals = loadSidecarApprovals(workspace, repo);
  return approvals[sidecar.name] === sidecarSignature(sidecar);
}

export function approveSidecar(workspace, repo, sidecarName, command, args) {
  return workspaceState(workspace).withWorkspace(
    ['sidecars', 'approvals'],
    (scope) => {
      const configured = scope.read('sidecars');
      const current = Object.hasOwn(configured, repo)
        ? configured[repo].find((row) => row.name === sidecarName)
        : undefined;
      if (
        !current ||
        sidecarSignature(current) !== sidecarSignature({ args, command })
      ) {
        throw new Error(
          'Sidecar command changed; review it again before approving'
        );
      }
      const all = scope.read('approvals');
      return scope.replace('approvals', {
        ...all,
        [repo]: { ...all[repo], [sidecarName]: sidecarSignature(current) },
      });
    }
  );
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
  return workspaceState(workspace).withWorkspace(
    ['sidecars', 'approvals'],
    (scope) => {
      if (scope.exists('approvals')) {
        return {
          committed: false,
          reconciled: true,
          status: 'unchanged',
          value: scope.read('approvals'),
        };
      }
      const approvals = Object.create(null);
      for (const [repo, sidecars] of Object.entries(scope.read('sidecars'))) {
        approvals[repo] = {};
        for (const sidecar of sidecars) {
          if (sidecar.name && sidecar.command) {
            approvals[repo][sidecar.name] = sidecarSignature(sidecar);
          }
        }
      }
      return scope.replace('approvals', approvals);
    }
  );
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
  return workspaceState(workspace).read('archive');
}

export function appendArchivedWorktree(workspace, record) {
  return workspaceState(workspace).update('archive', (all) => {
    const index = record.operationId
      ? all.findIndex((row) => row.operationId === record.operationId)
      : -1;
    if (index < 0) {
      all.push(record);
    } else {
      all[index] = { ...all[index], ...record };
    }
    return all.slice(-ARCHIVE_CAP);
  });
}

// ── custom agent CLIs (workspace/custom-agents.json: [{id, label, command}]) ──
// Same load/save shape as sidecars, but global — not per-repo. "Open in X"
// is a per-developer tool preference, not scoped to one project. No which()
// check on these (unlike AGENT_CLIS/detectAgentClis): the user typed the
// exact command they want run, which may not be a bare PATH binary at all
// (a shell alias, a script with flags, ...).
function kebabSlug(s) {
  return String(s || '')
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function uniqueSlugId(used, suppliedId, label, fallback) {
  if (suppliedId && !used.has(suppliedId)) {
    return suppliedId;
  }
  const base = kebabSlug(label) || fallback;
  let id = base;
  let suffix = 2;
  while (used.has(id)) {
    id = `${base}-${suffix}`;
    suffix += 1;
  }
  return id;
}

export function loadCustomAgents(workspace) {
  return workspaceState(workspace).read('customAgents');
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
  const out = agents.map(({ command, id: suppliedId, label }) => {
    let id = suppliedId;
    if (!id || used.has(id)) {
      const base = kebabSlug(label) || 'agent';
      id = base;
      let n = 2;
      while (used.has(id)) {
        id = `${base}-${n}`;
        n += 1;
      }
    }
    used.add(id);
    return { command, id, label };
  });
  return workspaceState(workspace).replace('customAgents', out);
}

// ── MCP servers (workspace/mcp-servers.json: [{id, name, transport, ...}]) ──
// Same global (not per-repo), whole-list-overwrite, kebab-slug-id shape as
// custom agents above — connecting to an MCP server is a per-developer tool
// preference, not scoped to one project.
export function loadMcpServers(workspace) {
  return workspaceState(workspace).read('mcpServers');
}

function copyMcpServer(input, used) {
  const {
    args,
    command,
    env,
    headers,
    httpAuthMode,
    id: suppliedId,
    name,
    transport,
    url,
  } = input;
  const id = uniqueSlugId(used, suppliedId, name, 'mcp-server');
  used.add(id);
  const server = { id, name, transport };
  if (transport === 'stdio') {
    server.command = command;
    if (args?.length) {
      server.args = args;
    }
    if (env && Object.keys(env).length) {
      server.env = env;
    }
  } else if (transport === 'http') {
    server.url = url;
    server.httpAuthMode = httpAuthMode === 'oauth' ? 'oauth' : 'headers';
    if (
      server.httpAuthMode === 'headers' &&
      headers &&
      Object.keys(headers).length
    ) {
      server.headers = headers;
    }
  }
  return server;
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
  const out = servers.map((server) => copyMcpServer(server, used));
  return workspaceState(workspace).replace('mcpServers', out);
}

// ── MCP OAuth tokens (workspace/mcp-tokens.json: {[issuer]: {clientInformation, tokens}}) ──
// Deliberately a separate file from mcp-servers.json, same split as
// sidecars.json/sidecar-approvals.json: config vs. security state. Keyed by
// issuer (the resolved authorization server URL), not by server id, per
// SEP-2352 — two configured servers can share an authorization server and
// must never get cross-registered client credentials. Only durable post-auth
// artifacts live here; PKCE verifier, CSRF state, and discovery state are
// per-attempt and stay in mcp.js's in-memory pendingAuth map, never written
// to disk. Issuer-field updates run under the document lock and publish a
// complete 0600 replacement; permissions are set before rename. Accepted,
// explicit trade-off for a single-user local tool: the MCP
// SDK's own docs recommend OS-level secure storage "in production" — a 0600
// file is the pragmatic choice here, not a silent shortcut.
export function loadMcpTokens(workspace) {
  return workspaceState(workspace).read('mcpTokens');
}

export function saveMcpTokens(workspace, issuer, patch) {
  if (
    typeof issuer !== 'string' ||
    !issuer ||
    !patch ||
    typeof patch !== 'object' ||
    Array.isArray(patch)
  ) {
    throw new Error('Invalid token issuer patch');
  }
  return workspaceState(workspace).update('mcpTokens', (all) => ({
    ...all,
    [issuer]: { ...all[issuer], ...patch },
  }));
}

// Deregisters a project (drops it from the .projects registry and the "add
// worktree" dropdown) without touching anything already on disk — existing
// worktrees, their git history, and their ports keep working exactly as
// before. Removing a project is a registry edit, not a delete.
export function removeProject(workspace, name) {
  return workspaceState(workspace).update('projects', (projects) => {
    delete projects[name];
    return projects;
  });
}

export async function registerProject(
  workspace,
  { name, slug = '', label = '' }
) {
  validateWorktreeNames(name, 'main');
  const result = await workspaceState(workspace).update(
    'projects',
    (projects) => {
      if (Object.hasOwn(projects, name)) {
        return projects;
      }
      const used = new Set(Object.values(projects).map((row) => row.base));
      let base = 3000;
      while (used.has(base)) {
        base += 100;
      }
      return { ...projects, [name]: { base, label: label || name, slug } };
    }
  );
  const repoDir = join(workspace, `${name}.git`);
  if (existsSync(repoDir)) {
    ensureSetuExcludes(repoDir);
  }
  return installedStateValue(result)[name].base;
}

export function ensureSetuExcludes(repoDir) {
  const exclude = join(repoDir, 'info', 'exclude');
  const generated = [
    '.envrc',
    'docker-compose.setu.yml',
    'docker-compose.setu-agent.yml',
    '.setu-migration-prompted',
  ];
  let current = '';
  try {
    current = readFileSync(exclude, 'utf8');
  } catch (error) {
    if (error.code !== 'ENOENT') {
      throw error;
    }
    mkdirSync(dirname(exclude), { recursive: true });
  }
  const existing = new Set(current.split(lineBreakPattern));
  const missing = generated.filter((entry) => !existing.has(entry));
  if (missing.length) {
    writeFileSync(
      exclude,
      `${current}${current && !current.endsWith('\n') ? '\n' : ''}${missing.join('\n')}\n`
    );
  }
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
  const res = spawnSync(
    'docker',
    ['info', '--format', '{{.ServerVersion}}|{{.OperatingSystem}}'],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }
  );
  if (res.status !== 0 || !res.stdout?.trim()) {
    return { available: false, engine: null };
  }
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
  const hash = createHash('sha1')
    .update(`${repo}/${name}`)
    .digest('hex')
    .slice(0, 8);
  const readable = `${repo}-${slugify(name)}`
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-');
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
  if (existsSync(dockerComposePath(wtDir))) {
    return true;
  }
  if (existsSync(join(workspace, 'logs', repo, name, 'dev.log'))) {
    return false;
  }
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
  if (existsSync(dockerComposePath(wtDir))) {
    return false; // already containerized at some point
  }
  if (!existsSync(join(workspace, 'logs', repo, name, 'dev.log'))) {
    return false; // no bare history yet either
  }
  return !existsSync(migrationMarkerPath(workspace, repo, name));
}

export function markMigrationPrompted(workspace, repo, name) {
  writeFileSync(migrationMarkerPath(workspace, repo, name), '');
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
  const res = spawnSync(
    'docker',
    ['info', '--format', '{{.NCPU}}|{{.MemTotal}}'],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }
  );
  if (res.status !== 0 || !res.stdout?.trim()) {
    return { cpus: null, memMb: null };
  }
  const [engineCpus, engineMemBytes] = res.stdout.trim().split('|');
  return {
    cpus: Number.parseInt(engineCpus, 10) || null,
    memMb: engineMemBytes ? Math.floor(+engineMemBytes / 1024 / 1024) : null,
  };
}

// "running" or "restarting" both count as alive — mid-retry-backoff (the
// `restart: on-failure:3` window between attempts) briefly reports neither
// "running" nor present in a --status=running filter, and a caller polling on
// a fixed interval (checkMemoryCeilings) could otherwise catch that gap and
// prematurely free the worktree's concurrency slot while Docker is about to
// bring it back up on its own. -a includes exited/dead containers so a
// permanently-given-up retry cap (genuinely dead) is correctly reported false.
export function composeProjectAlive(project) {
  const res = spawnSync(
    'docker',
    ['compose', '-p', project, 'ps', '-a', '--format', '{{.State}}'],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }
  );
  if (res.status !== 0) {
    return false;
  }
  return res.stdout
    .trim()
    .split('\n')
    .some((s) => s === 'running' || s === 'restarting');
}

// Async sibling of composeProjectAlive — same "running"/"restarting" check,
// sourced from spawnText (which discards stderr and never throws, so a
// nonzero-exit/no-such-project case naturally falls through to an empty
// string that matches neither state, same effective result as the sync
// version's explicit `res.status !== 0` early return). Used by
// startWorktree so a stale procs entry — a container that already died but
// hasn't yet hit checkMemoryCeilings' 2-consecutive-miss threshold (up to
// ~2 minutes, see MEM_CHECK_INTERVAL in portal.js) — doesn't block a real
// restart with a false "already running": confirmed live tonight, a dead
// pulse/main sat in procs long enough that /api/start rejected a genuine
// retry attempt.
export async function composeProjectAliveAsync(project) {
  const out = await spawnText([
    'docker',
    'compose',
    '-p',
    project,
    'ps',
    '-a',
    '--format',
    '{{.State}}',
  ]);
  return out
    .trim()
    .split('\n')
    .some((s) => s === 'running' || s === 'restarting');
}

// Teardown failures must keep the worktree tracked and prevent deletion.
export async function composeDownAsync(
  project,
  composeFile,
  extraArgs = [],
  { spawn = (...args) => Bun.spawn(...args) } = {}
) {
  const proc = spawn(
    [
      'docker',
      'compose',
      '-p',
      project,
      '-f',
      composeFile,
      'down',
      ...extraArgs,
    ],
    { stderr: 'pipe', stdout: 'ignore', timeout: 30_000 }
  );
  const error = await new Response(proc.stderr).text();
  if ((await proc.exited) !== 0) {
    throw new Error(error.trim() || 'Docker Compose teardown failed');
  }
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
// Containers reuse this download cache. Bun's cache contains package contents,
// including dist directories; never recursively sweep it for build outputs.
// Host Darwin dependencies and container Linux dependencies remain separate:
// each containerized worktree has its own node_modules volume.
// Cache layout: https://bun.com/docs/pm/global-cache
function bunCacheDir(workspace) {
  const dir = join(workspace, '.bun-cache');
  mkdirSync(dir, { recursive: true });
  return dir;
}

export async function writeDockerCompose(
  c,
  repo,
  name,
  port,
  cap,
  admittedSpec
) {
  const wtDir = join(c.workspace, repo, name);
  const spec = admittedSpec ?? {
    container: true,
    limits: effectiveContainerLimits(c, cap ?? engineCapacity()),
    port,
    project: composeProjectName(repo, name),
  };
  if (spec.port !== port || spec.project !== composeProjectName(repo, name)) {
    throw new Error('Admitted container identity changed');
  }
  const hostEnvLocal = envLocalPath(repo, wtDir);
  let envLocal = null;
  try {
    envLocal = {
      container: `/workspace${hostEnvLocal.slice(wtDir.length)}`,
      host: realpathSync(hostEnvLocal),
    };
  } catch {
    /* no .env.local yet (fresh worktree) — container still boots without it */
  }
  const yaml = renderDockerCompose(spec, {
    cacheDir: bunCacheDir(c.workspace),
    env: parseEnvFile(join(wtDir, '.envrc')),
    envLocal,
    wtDir,
  });
  installedStateValue(
    await workspaceState(c.workspace).replaceText(
      dockerComposePath(wtDir),
      yaml
    )
  );
  return dockerComposePath(wtDir);
}

export function agentComposePath(wtDir) {
  const id = createHash('sha1').update(wtDir).digest('hex').slice(0, 12);
  return join(dirname(wtDir), `.setu-agent-compose-${id}.yml`);
}

function agentGitMounts(wtDir, registeredBareRepoDir) {
  const gitFile = join(wtDir, '.git');
  const gitPointer = readFileSync(gitFile, 'utf8').match(
    gitDirectoryPattern
  )?.[1];
  if (!gitPointer) {
    throw new Error(`Could not identify the Git admin directory for ${wtDir}`);
  }
  const adminDir = resolve(wtDir, gitPointer);
  const canonicalBare = realpathSync(registeredBareRepoDir);
  const canonicalAdmin = realpathSync(adminDir);
  const adminRelative = relative(
    join(canonicalBare, 'worktrees'),
    canonicalAdmin
  );
  if (
    !adminRelative ||
    adminRelative.startsWith('..') ||
    isAbsolute(adminRelative)
  ) {
    throw new Error(
      'Git admin directory is outside the registered bare repository'
    );
  }
  const commonDir = readFileSync(join(adminDir, 'commondir'), 'utf8').trim();
  const bareRepoDir = resolve(adminDir, commonDir);
  if (realpathSync(bareRepoDir) !== canonicalBare) {
    throw new Error(
      'Git common directory does not match the registered bare repository'
    );
  }
  const checkoutGitFile = resolve(
    adminDir,
    readFileSync(join(adminDir, 'gitdir'), 'utf8').trim()
  );
  if (realpathSync(checkoutGitFile) !== realpathSync(gitFile)) {
    throw new Error('Git admin directory does not belong to this worktree');
  }
  return { adminDir, bareRepoDir };
}

// Agent-container sibling of writeDockerCompose, for the short-lived headless
// runs agent.js drives — not the long-running dev server. Every divergence
// below was found the hard way against a real worktree, not a style choice:
//
//  - image/command: `opts.image` (setu-agent:latest by default) idling on
//    `sleep infinity`. Sandcastle does the actual work via `docker exec`
//    into this container; it never runs `bun run dev` itself, so there's
//    nothing here that looks like writeDockerCompose's install-and-serve
//    command.
//  - restart: "no", not on-failure:3. A dev server resurrecting itself after
//    a crash is the point; an agent container resurrecting itself after the
//    run that owned it is gone is a zombie nobody is watching for exit.
//  - the git mount, below — the one that actually breaks things if skipped.
//  - environment is exactly `opts.env`, no .envrc parse and no injected
//    PORT — this container serves nothing, so there's no port to publish
//    and no dev-server env to inherit by default.
//  - no node_modules/bun-cache/.env.local mounts. Those exist in
//    writeDockerCompose purely to make `bun install && bun run dev` fast;
//    an idling `sleep infinity` container never runs that command, so
//    they'd just be unused volumes. A caller that wants installed deps
//    reachable passes them through opts.mounts / opts.env instead.
export async function writeAgentCompose(
  c,
  repo,
  name,
  opts = {},
  capacity = engineCapacity()
) {
  const wtDir = join(c.workspace, repo, name);
  // Suffixed, not composeProjectName(repo, name) verbatim — that exact name
  // is already the dev-server project for this same worktree (or will be,
  // the moment `setu start --container` runs), and two different compose
  // files sharing one Compose project name get silently reconciled against
  // each other on `up`. The suffix rides on the same sha1-of-registry-key
  // composeProjectName already uses to dodge repo/name slug collisions, so
  // it inherits that same collision-safety for free.
  const project = `${composeProjectName(repo, name)}-agent`;

  // A Setu worktree's `.git` is a *file*, not a directory — it holds
  // `gitdir: <workspace>/<repo>.git/worktrees/<branch>`, an absolute path
  // into the bare repo. Mounting only `wtDir:/workspace` (fine for
  // writeDockerCompose — `bun run dev` never touches git) leaves that
  // pointer dangling inside the container: nothing at that path, git
  // resolution fails on the first command. Validate that pointer against the
  // registered bare repository before mounting its own admin directory.
  const { adminDir, bareRepoDir } = agentGitMounts(
    wtDir,
    join(c.workspace, `${repo}.git`)
  );
  // node_modules MUST be a container-local named volume, exactly as
  // writeDockerCompose does it — and for a sharper reason here. The worktree
  // is bind-mounted read-write, so a `bun install` run *inside* the Linux
  // container writes Linux-native binaries (@next/swc-linux-arm64-gnu et al)
  // straight into the host's node_modules, breaking the macOS dev server
  // running against that same worktree. An agent implementing a feature runs
  // install/test/typecheck constantly, so this is the common path, not an
  // edge case. The named volume is namespaced by the compose project name,
  // which means it's also isolated from the dev server's own volume rather
  // than racing it.
  //
  // The bun cache comes along for the same reason writeDockerCompose mounts
  // it: the volume starts empty on a fresh agent run, and without the shared
  // cache that first install is a full cold download every time.
  const volumes = [
    `      - ${wtDir}:/workspace`,
    '      - node_modules:/workspace/node_modules',
    `      - ${bunCacheDir(c.workspace)}:/bun-cache`,
    `      - ${bareRepoDir}:${bareRepoDir}:ro`,
    `      - ${adminDir}:${adminDir}`,
    `      - ${bareRepoDir}/objects:${bareRepoDir}/objects`,
    `      - ${bareRepoDir}/refs:${bareRepoDir}/refs`,
    `      - ${bareRepoDir}/logs:${bareRepoDir}/logs`,
  ];
  // Credential mounts are forced read-only regardless of what the caller
  // passed in `readonly` — a writable credential mount would let a
  // compromised agent run overwrite the token file back on the host.
  for (const m of opts.mounts ?? []) {
    volumes.push(`      - ${m.hostPath}:${m.sandboxPath}:ro`);
  }

  // Map, not Object.entries piped straight to lines — opts.env is a plain
  // object so it can't itself carry a duplicate key, but building through a
  // Map keeps this function immune to the same duplicate-mapping-key class
  // of bug writeDockerCompose's PORT/env comment documents, in case a future
  // caller merges more than one source into opts.env before calling this.
  // Seeded before opts.env so an explicit caller value still wins, and so the
  // mounted /bun-cache is actually used rather than sitting there inert.
  const env = new Map([
    ['BUN_INSTALL_CACHE_DIR', '/bun-cache'],
    ...Object.entries(opts.env ?? {}),
  ]);
  const envLines = [...env].map(([k, v]) => `      ${k}: ${JSON.stringify(v)}`);

  const cap = capacity;
  let memLimit = c.containerMemoryLimit ?? '4g';
  let cpuLimit = c.containerCpuLimit ?? 2;
  if (cap.cpus && Number(cpuLimit) > cap.cpus) {
    cpuLimit = cap.cpus;
  }
  const memMb = parseMemToMb(memLimit);
  if (cap.memMb && memMb && memMb > cap.memMb) {
    memLimit = `${cap.memMb}m`;
  }

  const lines = [
    '# Generated by setu — regenerated on every agent run, do not edit by hand.',
    `name: ${project}`,
    'services:',
    '  agent:',
    `    image: ${opts.image ?? 'setu-agent:latest'}`,
    '    working_dir: /workspace',
    '    command: sleep infinity',
    '    restart: "no"',
    `    mem_limit: "${memLimit}"`,
    `    cpus: "${cpuLimit}"`,
  ];
  if (envLines.length) {
    lines.push('    environment:', ...envLines);
  }
  lines.push('    volumes:', ...volumes);
  // Egress allowlist hook: `opts.network` names a Docker network that
  // already exists on the host (the allowlist/proxy setup lives wherever
  // that network was created, not here) — attach to it when given, and say
  // nothing when it's absent so Compose falls back to its own default
  // bridge, same as every other worktree today.
  if (opts.network) {
    lines.push('    networks:', `      - ${opts.network}`);
  }
  // Top-level blocks come after the whole service block, so they're pushed
  // here rather than inline with their service-level counterparts.
  lines.push('volumes:', '  node_modules:');
  if (opts.network) {
    lines.push('networks:', `  ${opts.network}:`, '    external: true');
  }

  const yaml = `${lines.join('\n')}\n`;
  installedStateValue(
    await workspaceState(c.workspace).replaceText(agentComposePath(wtDir), yaml)
  );
  return agentComposePath(wtDir);
}

// ── git worktrees ─────────────────────────────────────────────────────────────

export function writerClaimPaths(workspace, cwd = process.cwd()) {
  const candidates = [cwd];
  if (workspace) {
    candidates.push(
      ...portEntries(workspace).map((e) => join(workspace, e.repo, e.name))
    );
    candidates.push(
      ...Object.keys(loadProjects(workspace)).map((repo) =>
        join(workspace, `${repo}.git`)
      )
    );
  }
  return discoverWriterWorktrees(candidates);
}

export function git(repoDir, args, opts = {}) {
  return execFileSync('git', ['-C', repoDir, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    ...opts,
  });
}

// Async counterpart to git() for the two call sites that are genuinely
// network-bound (createWorktree's `fetch --all --prune`, syncWithBase's
// `fetch origin <branch>`) -- every other git() call is local filesystem
// work (~7-12ms), not worth converting. Bun.spawn instead of execFileSync so
// a slow/hung remote doesn't block the whole portal, same class of bug
// fetchPR already fixed. Throws on failure like git() itself (unlike
// spawnText, which silently returns '') -- both callers rely on a failed
// fetch aborting rather than silently proceeding against a stale base.
export async function gitFetchAsync(
  dir,
  args,
  { spawn = (command, options) => Bun.spawn(command, options) } = {}
) {
  const run = createCommandRunner((command, options) =>
    spawn(command, { ...options, killSignal: 'SIGKILL' })
  );
  const result = await run(['git', '-C', dir, ...args], { timeoutMs: 120_000 });
  if (result.code !== 0 || result.timedOut || result.truncated) {
    throw new Error(
      result.stderr ||
        `git ${args.join(' ')} failed or returned incomplete output (exit ${result.code})`
    );
  }
  return result.stdout;
}

export function branchExists(repoDir, name) {
  for (const ref of [`refs/heads/${name}`, `refs/remotes/origin/${name}`]) {
    if (
      spawnSync('git', ['-C', repoDir, 'show-ref', '--verify', '--quiet', ref])
        .status === 0
    ) {
      return true;
    }
  }
  return false;
}

export function worktreeForBranch(repoDir, name) {
  const porcelain = git(repoDir, ['worktree', 'list', '--porcelain']);
  for (const entry of porcelain.trim().split('\n\n')) {
    const path = entry.match(worktreePathPattern)?.[1];
    const branch = entry.match(worktreeBranchPattern)?.[1];
    if (branch === name) {
      return path;
    }
  }
  return null;
}

// Full path->branch map in one pass — same porcelain parse worktreeForBranch
// already does, just returning everything instead of searching for one name.
// Needed because a worktree's directory name is not reliably its branch name
// (confirmed live: a worktree directory can be on a branch with a completely
// different name than the directory itself), so joining git ref data back to
// a specific worktree has to go through the actual path, not an assumption.
export function worktreeBranchMap(
  repoDir,
  porcelain = git(repoDir, ['worktree', 'list', '--porcelain'])
) {
  const map = new Map();
  for (const entry of porcelain.trim().split('\n\n')) {
    const path = entry.match(worktreePathPattern)?.[1];
    const branch = entry.match(worktreeBranchPattern)?.[1];
    if (path && branch) {
      map.set(resolve(path), branch);
    }
  }
  return map;
}

// The same base-branch choice createWorktree() already makes for new
// branches (fork point) — reused here for ahead/behind comparisons so
// neither place hardcodes 'origin/staging', which doesn't exist for most
// registered repos (confirmed live: only 2 of 5 have it; using it
// unconditionally fails with "unknown revision" on the rest).
export function baseBranchRef(repoDir) {
  return branchExists(repoDir, 'staging')
    ? 'origin/staging'
    : `origin/${git(repoDir, ['symbolic-ref', '--short', 'HEAD']).trim()}`;
}

async function runLocalGit(repoDir, args) {
  const proc = Bun.spawn(['git', '-C', repoDir, ...args], {
    stderr: 'ignore',
    stdin: 'ignore',
    stdout: 'pipe',
  });
  const [stdout, code] = await Promise.all([
    new Response(proc.stdout).text(),
    proc.exited,
  ]);
  if (code !== 0) {
    throw new Error(`git ${args.join(' ')} failed`);
  }
  return stdout.trim();
}

export async function baseBranchRefAsync(repoDir, { run = runLocalGit } = {}) {
  for (const ref of ['refs/heads/staging', 'refs/remotes/origin/staging']) {
    try {
      // biome-ignore lint/performance/noAwaitInLoops: The staging probe must fall through from local to remote before resolving the HEAD fallback.
      await run(repoDir, ['show-ref', '--verify', '--quiet', ref]);
      return 'origin/staging';
    } catch {
      // A missing local or remote staging ref falls through to HEAD, as in
      // branchExists() above.
    }
  }
  return `origin/${(await run(repoDir, ['symbolic-ref', '--short', 'HEAD'])).trim()}`;
}

// Merges the worktree's resolved base (same one branchMetadata's ahead/behind
// already compares against) into the worktree's own branch — "sync with
// staging" in the UI. Deliberately clean-only, by explicit decision: a merge
// that would conflict is attempted, detected via `git status --porcelain`'s
// conflict markers (UU/AA/etc — more reliable across git versions than
// parsing `git merge-tree` output), then immediately aborted so the worktree
// is never left mid-conflict. Setu tells you what would conflict; resolving
// it is still the user's job in their own editor.
export async function syncWithBase(
  wtDir,
  repoDir,
  {
    resolveBase = baseBranchRefAsync,
    runGit = gitFetchAsync,
    exists = existsSync,
  } = {}
) {
  const base = await resolveBase(repoDir);
  const branchName = base.replace(originPrefixPattern, '');
  // A detached worktree has no branch name; it cannot be the base branch.
  const checkedOut = (
    await runGit(wtDir, ['symbolic-ref', '--quiet', '--short', 'HEAD']).catch(
      () => ''
    )
  ).trim();
  const defaultBranch = (
    await runGit(repoDir, ['symbolic-ref', '--short', 'HEAD'])
  ).trim();
  if (
    checkedOut &&
    defaultBranch &&
    (checkedOut === defaultBranch || checkedOut === branchName)
  ) {
    return {
      code: 'SYNC_BASE_BRANCH',
      error: 'Sync is not available on the repository base branch.',
      ok: false,
    };
  }
  await runGit(wtDir, ['fetch', 'origin', branchName]);

  const dirty = (await runGit(wtDir, ['status', '--porcelain'])).trim();
  if (dirty) {
    return {
      error: 'Worktree has uncommitted changes — commit or stash first.',
      ok: false,
    };
  }

  try {
    await runGit(wtDir, ['merge', base, '--no-edit']);
    return { base, ok: true };
  } catch (mergeErr) {
    if (mergeErr.code === 'OPERATION_UNKNOWN') {
      throw mergeErr;
    }
    const status = await runGit(wtDir, ['status', '--porcelain']);
    const conflicts = status
      .split('\n')
      .filter((l) => mergeConflictPattern.test(l))
      .map((l) => l.slice(3).trim());
    // Only a real conflict leaves MERGE_HEAD behind — `merge --abort` itself
    // throws ("no merge to abort") if the failure was something else (e.g.
    // an unresolvable ref), which would otherwise crash this request instead
    // of reporting the actual error. --git-path (not a hardcoded .git/...)
    // because a linked worktree's .git is a file pointing elsewhere, not a
    // directory — the real MERGE_HEAD lives under the main repo's
    // worktrees/<name>/ dir, which only `git` itself resolves correctly.
    const mergeHeadPath = resolve(
      wtDir,
      (await runGit(wtDir, ['rev-parse', '--git-path', 'MERGE_HEAD'])).trim()
    );
    if (exists(mergeHeadPath)) {
      await runGit(wtDir, ['merge', '--abort']);
    }
    if (!conflicts.length) {
      return {
        error: `Merge failed: ${mergeErr.stderr || mergeErr.message}`,
        ok: false,
      };
    }
    return {
      conflicts,
      error: `Would conflict in ${conflicts.length} file${conflicts.length === 1 ? '' : 's'} — merge aborted, worktree unchanged.`,
      ok: false,
    };
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
export function branchMetadata(repoDir, raw) {
  let metadata = raw;
  if (metadata === undefined) {
    const base = baseBranchRef(repoDir);
    try {
      metadata = git(repoDir, [
        'for-each-ref',
        `--format=%(refname:short)\t%(committerdate:unix)\t%(ahead-behind:${base})`,
        'refs/heads/',
      ]);
    } catch {
      return new Map();
    }
  }
  const map = new Map();
  for (const line of metadata.trim().split('\n')) {
    if (!line) {
      continue;
    }
    const [branch, at, ab] = line.split('\t');
    const [ahead, behind] = (ab ?? '')
      .trim()
      .split(whitespacePattern)
      .map((n) => Number.parseInt(n, 10) || 0);
    map.set(branch, {
      ahead: ahead ?? 0,
      behind: behind ?? 0,
      lastCommitAt: Number.parseInt(at, 10) || null,
    });
  }
  return map;
}

// Copies each glob's matches from the main worktree into a freshly created
// one, preserving the relative path and creating parent directories as
// needed. Copy, not symlink, unlike the .env.local step in createWorktree
// below: these files are meant to be independently editable per worktree.
// Globs resolve against mainDir itself (the worktree root), the same base
// the repo checks out into — not envLocalPath's apps/<repo> convention, so
// a project needing an app-subdir file uses a glob with that subdir already
// in it, e.g. apps/my-app/.env.development.local.
// Never throws: a missing main worktree (first worktree ever) or a glob
// that matches nothing are both expected, logged, and skipped, not fatal to
// worktree creation.
export function syncIncludedFiles(mainDir, wtDir, globs) {
  if (!globs?.length) {
    return;
  }
  if (!existsSync(mainDir)) {
    console.warn(`⚠  file sync skipped — no main worktree yet at ${mainDir}`);
    return;
  }
  for (const pattern of globs) {
    let matches;
    try {
      matches = [
        ...new Bun.Glob(pattern).scanSync({
          cwd: mainDir,
          dot: true,
          onlyFiles: true,
        }),
      ];
    } catch (e) {
      console.warn(`⚠  file sync: bad glob "${pattern}": ${e.message}`);
      continue;
    }
    if (!matches.length) {
      console.warn(`⚠  file sync: "${pattern}" matched nothing in ${mainDir}`);
      continue;
    }
    for (const rel of matches) {
      if (rel.startsWith('..')) {
        continue; // a glob can't reach outside mainDir
      }
      const dest = join(wtDir, rel);
      if (existsSync(dest)) {
        continue; // never clobber an already-edited copy
      }
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
// biome-ignore lint/suspicious/useAwait: Target-lock validation may throw synchronously; callers require this exported creation API to reject instead.
export async function createWorktree(
  c,
  repo,
  name,
  { tunnel = false, readStorage } = {}
) {
  return workspaceState(c.workspace).withTargets([{ name, repo }], async () => {
    const pending = validateRemovalRecords(
      workspaceState(c.workspace).read('removals')
    );
    if (Object.values(pending).some((row) => row.key === `${repo}/${name}`)) {
      throw Object.assign(
        new Error(
          'Removal cleanup is pending for this worktree; retry its operation before creating'
        ),
        { code: 'REMOVAL_PENDING' }
      );
    }
    const repoDir = join(c.workspace, `${repo}.git`);
    const wtDir = managedWorktreePath(c.workspace, repo, name, {
      registered: false,
    });
    if (!existsSync(repoDir)) {
      throw new Error(
        `Bare repo not found: ${repoDir}\nRun: setu init <gh-slug>`
      );
    }

    const zone = localZone(c);
    const domain = localDomain(repo, name, zone);
    const collision = portEntries(c.workspace).find(
      (entry) =>
        (entry.repo !== repo || entry.name !== name) &&
        localDomain(entry.repo, entry.name, zone) === domain
    );
    if (collision) {
      throw Object.assign(
        new Error(
          `Local domain ${domain} is already used by ${collision.repo}/${collision.name}`
        ),
        { code: 'DOMAIN_COLLISION' }
      );
    }

    await assertStorageHeadroom(c.workspace, readStorage);
    await prepareWorktreeCheckout(
      { exists: existsSync(wtDir), name, repoDir, wtDir },
      {
        run: createCommandRunner((args, options) => Bun.spawn(args, options)),
      }
    );
    ensureSetuExcludes(repoDir);

    const port = await assignPort(c.workspace, repo, name);
    await configureWorktreeEnv(c, repo, name, port, tunnel);

    const mainEnv = envLocalPath(repo, join(c.workspace, repo, 'main'));
    const wtEnv = envLocalPath(repo, wtDir);
    if (existsSync(mainEnv) && !existsSync(wtEnv)) {
      linkWorktreeEnv(mainEnv, wtEnv);
    }

    const mainDir = join(c.workspace, repo, 'main');
    syncIncludedFiles(mainDir, wtDir, loadFileSyncGlobs(c.workspace, repo));

    await workspaceState(c.workspace).withRouting(async () => {
      await syncHosts(c.workspace);
      await reloadCaddyAsync(c.workspace);
    });

    return {
      localDom: domain,
      port,
      pubDom: tunnel ? publicDomain(c) : null,
      wtDir,
    };
  });
}

// The old `ln -sf` result was deliberately ignored. Keep setup non-fatal when
// a concurrent creator wins the destination path, without deleting that path.
export function linkWorktreeEnv(mainEnv, wtEnv, { link = symlinkSync } = {}) {
  try {
    link(mainEnv, wtEnv);
    return true;
  } catch {
    return false;
  }
}

// Removes worktree + registry entries + caddy snippet + hosts. Stopping dev
// servers / tunnel routes is the caller's job (only the portal owns processes).
export async function assertRemovableWorktree(
  c,
  repo,
  name,
  { force = false } = {}
) {
  if (typeof force !== 'boolean') {
    throw new Error('force must be a boolean');
  }
  if (name === 'main') {
    throw Object.assign(new Error('The main worktree cannot be removed.'), {
      code: 'MAIN_WORKTREE',
    });
  }
  const wtDir = managedWorktreePath(c.workspace, repo, name);
  if (force) {
    return;
  }
  const dirty = await gitFetchAsync(wtDir, [
    '--no-optional-locks',
    'status',
    '--porcelain',
    '--untracked-files=all',
  ]);
  if (dirty.trim()) {
    throw Object.assign(
      new Error(
        'Worktree has uncommitted changes or untracked files. Commit or stash them first; force removal permanently discards them.'
      ),
      { code: 'WORKTREE_DIRTY' }
    );
  }
  // `matching` reports an ignored directory such as node_modules as one entry.
  // With --untracked-files=all git would walk every file inside it.
  const ignored = await gitFetchAsync(wtDir, [
    '--no-optional-locks',
    'status',
    '--porcelain=v1',
    '-z',
    '--ignored=matching',
  ]);
  const envFiles = ignored
    .split('\0')
    .filter((entry) => entry.startsWith('!! '))
    .map((entry) => entry.slice(3))
    .filter((path) => environmentFilePattern.test(path.split('/').at(-1)))
    .filter((path) => !path.split('/').includes('node_modules'))
    .filter((path) => {
      try {
        return lstatSync(join(wtDir, path)).isFile();
      } catch {
        return false;
      }
    });
  if (envFiles.length) {
    throw Object.assign(
      new Error(
        `Worktree has ignored local env file${envFiles.length === 1 ? '' : 's'}: ${envFiles.join(', ')}.`
      ),
      { code: 'WORKTREE_DIRTY' }
    );
  }
  let detached = false;
  try {
    await gitFetchAsync(wtDir, ['symbolic-ref', '--quiet', '--short', 'HEAD']);
  } catch {
    detached = true;
  }
  if (detached) {
    const refs = (
      await gitFetchAsync(wtDir, [
        'for-each-ref',
        '--contains',
        'HEAD',
        '--format=%(refname)',
      ])
    ).trim();
    if (!refs) {
      throw Object.assign(
        new Error('Worktree is detached at a commit that no ref contains.'),
        { code: 'WORKTREE_DIRTY' }
      );
    }
  }
}

// biome-ignore lint/suspicious/useAwait: This legacy exported boundary must reject with PORTAL_REQUIRED, not throw synchronously.
export async function removeWorktree() {
  throw Object.assign(
    new Error(
      'PORTAL_REQUIRED: removal must use the running portal and its durable recovery controller'
    ),
    { code: 'PORTAL_REQUIRED' }
  );
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
  return [
    homeDir,
    '(',
    '-name',
    '.*',
    '-a',
    '!',
    '-name',
    '.git',
    '-o',
    '-name',
    'node_modules',
    ')',
    '-prune',
    '-o',
    '-type',
    'd',
    '-name',
    '.git',
    '-print',
    '-prune',
  ];
}

// Same slug.split('/').pop() cmdInit already uses to name a project off a
// gh-slug CLI arg, applied here to whatever the discovered repo's remote URL
// resolves to instead. Generalized past github.com (a full $HOME walk finds
// clones from any host, not just GitHub) by stripping any scheme/host or ssh
// user@host: prefix first. No remote at all leaves only the containing
// directory's own name to go on.
function deriveSweepName(remoteUrl, dirName) {
  if (!remoteUrl) {
    return dirName;
  }
  const slug = remoteUrl
    .trim()
    .replace(remoteUrlSchemePattern, '')
    .replace(remoteUrlSshPattern, '')
    .replace(remoteUrlGitSuffixPattern, '');
  return slug.split('/').pop() || dirName;
}

// Pure, no I/O — shared by both discovery paths so the drop/conflict/
// importable rule lives in exactly one place. registeredRemotes is every
// already-registered project's actual origin URL (read from its bare repo,
// not the .projects slug field, so this compares the real clone source).
// Returns null for "drop entirely" (same remote already registered).
function classifySweepCandidate(
  { path, name, remoteUrl, dirty },
  projects,
  registeredRemotes
) {
  if (remoteUrl && registeredRemotes.has(remoteUrl)) {
    return null;
  }
  if (projects[name]) {
    return {
      conflictWith: name,
      dirty,
      name,
      path,
      remoteUrl,
      status: 'conflict',
    };
  }
  return {
    conflictWith: null,
    dirty,
    name,
    path,
    remoteUrl,
    status: remoteUrl ? 'importable' : 'no-remote',
  };
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
    return (
      execFileSync('git', ['-C', dir, 'remote', 'get-url', 'origin'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: SWEEP_GIT_TIMEOUT_MS,
      }).trim() || null
    );
  } catch {
    return null;
  }
}

function readDirty(dir) {
  try {
    return (
      execFileSync(
        'git',
        ['-C', dir, '--no-optional-locks', 'status', '--porcelain'],
        {
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'pipe'],
          timeout: SWEEP_GIT_TIMEOUT_MS,
        }
      ).trim().length > 0
    );
  } catch {
    return false;
  }
}

// CLI path: execFileSync, synchronous throughout. Blocking is fine here —
// this only runs when someone explicitly types `setu sweep`.
export function discoverRepos(homeDir) {
  const { workspace } = loadConfig();
  const projects = workspace ? loadProjects(workspace) : {};
  const registeredRemotes = new Set(
    Object.keys(projects)
      .map((name) => readOriginUrl(join(workspace, `${name}.git`)))
      .filter(Boolean)
  );

  let raw;
  try {
    // stderr piped (not inherited) — a full $HOME walk hits dozens of
    // permission-denied system dirs (~/Library/.../TCC, CallHistoryDB, ...)
    // that find reports on stderr; inheriting it would dump that noise
    // straight into the user's terminal on every `setu sweep`, verified live.
    raw = execFileSync('find', sweepFindArgs(homeDir), {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (e) {
    raw = e.stdout ?? '';
  } // find exits non-zero on permission-denied subdirs, stdout is still complete
  const gitDirs = raw.split('\n').filter(Boolean);

  const out = [];
  for (const gitDir of gitDirs) {
    const dir = resolve(gitDir, '..');
    const t0 = Date.now();
    const remoteUrl = readOriginUrl(dir);
    // Sequential (unlike the portal path's Promise.all pair), so a path that
    // already burned the full timeout on the first call — a git process
    // actually got killed, not just "no remote configured" — isn't worth
    // waiting the full timeout on again for the second. dirty is informational
    // only, false is a safe default for a path this unresponsive.
    const timedOut = Date.now() - t0 >= SWEEP_GIT_TIMEOUT_MS - 50;
    const dirty = timedOut ? false : readDirty(dir);
    const name = deriveSweepName(remoteUrl, dir.split('/').pop());
    const shaped = classifySweepCandidate(
      { dirty, name, path: dir, remoteUrl },
      projects,
      registeredRemotes
    );
    if (shaped) {
      out.push(shaped);
    }
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
    // biome-ignore lint/performance/noAwaitInLoops: Each bounded concurrent chunk must finish before launching the next to enforce the process cap.
    out.push(...(await Promise.all(items.slice(i, i + size).map(fn))));
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
export async function spawnText(
  args,
  { timeoutMs, spawn = (...command) => Bun.spawn(...command) } = {}
) {
  try {
    const opts = { stderr: 'ignore', stdout: 'pipe' };
    if (timeoutMs) {
      opts.timeout = timeoutMs;
    }
    const proc = spawn(args, opts);
    const text = await new Response(proc.stdout).text();
    await proc.exited;
    return text.trim();
  } catch {
    return '';
  }
}

async function readOriginUrlAsync(dir) {
  const out = await spawnText(
    ['git', '-C', dir, 'remote', 'get-url', 'origin'],
    { timeoutMs: SWEEP_GIT_TIMEOUT_MS }
  );
  return out || null;
}

async function readDirtyAsync(dir) {
  return (
    (
      await spawnText(
        ['git', '-C', dir, '--no-optional-locks', 'status', '--porcelain'],
        { timeoutMs: SWEEP_GIT_TIMEOUT_MS }
      )
    ).length > 0
  );
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
  const { workspace } = loadConfig();
  const projects = workspace ? loadProjects(workspace) : {};
  const registeredRemotes = new Set(
    (
      await batchMap(Object.keys(projects), 8, (name) =>
        readOriginUrlAsync(join(workspace, `${name}.git`))
      )
    ).filter(Boolean)
  );

  const raw = await spawnText(['find', ...sweepFindArgs(homeDir)]);
  const gitDirs = raw.split('\n').filter(Boolean);
  const dirs = gitDirs.map((g) => resolve(g, '..'));

  const shaped = await batchMap(dirs, 8, async (dir) => {
    const [remoteUrl, dirty] = await Promise.all([
      readOriginUrlAsync(dir),
      readDirtyAsync(dir),
    ]);
    const name = deriveSweepName(remoteUrl, dir.split('/').pop());
    return classifySweepCandidate(
      { dirty, name, path: dir, remoteUrl },
      projects,
      registeredRemotes
    );
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
export function cloneBareRepo(
  repoDir,
  remoteUrl,
  ghSlug,
  { stdio = 'inherit' } = {}
) {
  const useGh =
    ghSlug &&
    spawnSync('gh', ['auth', 'status'], { stdio: 'ignore' }).status === 0;
  if (useGh) {
    execFileSync('gh', ['repo', 'clone', ghSlug, repoDir, '--', '--bare'], {
      stdio,
    });
  } else {
    execFileSync('git', ['clone', '--bare', remoteUrl, repoDir], { stdio });
  }
  git(repoDir, [
    'config',
    'remote.origin.fetch',
    '+refs/heads/*:refs/remotes/origin/*',
  ]);
  git(repoDir, ['fetch', '--all', '--prune']);
}

export async function cloneBareRepoAsync(
  repoDir,
  remoteUrl,
  ghSlug,
  {
    run = createCommandRunner((args, options) => Bun.spawn(args, options)),
    readStorage,
  } = {}
) {
  await assertStorageHeadroom(dirname(repoDir), readStorage);
  return cloneBareRepository(repoDir, remoteUrl, ghSlug, { run });
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
  return (
    `${SETU_AGENTS_SECTION_MARKER}\n\n` +
    `This project's git worktrees, local dev domains, and dev servers are managed by [Setu](https://github.com/mukulchugh/setu) — don't run \`npm run dev\`/\`bun dev\` directly, use Setu so the portal keeps tracking the process.\n\n` +
    `**If \`setu\` isn't installed:**\n\`\`\`bash\ngh api repos/mukulchugh/setu/contents/install.sh -H "Accept: application/vnd.github.raw" | bash\nsetu setup\n\`\`\`\n\n` +
    `**Common commands** (run from anywhere):\n\`\`\`\nsetu ls ${repo}                    List this project's worktrees + running state\nsetu new ${repo} <branch>          Create a new worktree\nsetu start ${repo} <branch>        Start a worktree's dev server\nsetu stop  ${repo} <branch>        Stop it\nsetu cd    ${repo} <branch>        cd into the worktree\n\`\`\`\n\n` +
    `Live state (ports, domains, running status): \`setu ls ${repo} --json\`, or the portal API at \`http://localhost:${PORTAL_PORT}/api/worktrees\`.\n`
  );
}

export async function writeSetuAgentMarkers(
  repo,
  wtDir,
  { stage = gitFetchAsync } = {}
) {
  const markerPath = join(wtDir, '.setu.json');
  if (!existsSync(markerPath)) {
    writeFileSync(
      markerPath,
      `${JSON.stringify(
        {
          docs: 'https://github.com/mukulchugh/setu',
          install:
            'gh api repos/mukulchugh/setu/contents/install.sh -H "Accept: application/vnd.github.raw" | bash',
          managedBy: 'setu',
          portal: `http://localhost:${PORTAL_PORT}`,
          repo,
        },
        null,
        2
      )}\n`
    );
  }

  const agentsPath = join(wtDir, 'AGENTS.md');
  const existing = existsSync(agentsPath)
    ? readFileSync(agentsPath, 'utf8')
    : '';
  if (!existing.includes(SETU_AGENTS_SECTION_MARKER)) {
    const trimmed = existing.replace(trailingWhitespacePattern, '');
    writeFileSync(
      agentsPath,
      (trimmed ? `${trimmed}\n\n` : '') + setuAgentsSection(repo)
    );
  }

  try {
    await stage(wtDir, ['add', '.setu.json', 'AGENTS.md']);
  } catch (error) {
    if (error.code === 'OPERATION_UNKNOWN') {
      throw error;
    }
  }
}

// Extracted from cmdInit's clone->register->create-main-worktree sequence so
// `setu init` (a github slug) and sweep --import (an already-discovered
// clone's exact origin URL) share one implementation instead of two that can
// drift. Takes the full config object, not just the workspace path, because
// createWorktree needs it — same convention createWorktree/removeWorktree
// above already use. Never touches whatever directory the caller discovered
// remoteUrl from: this always clones fresh into workspace/<name>.git.
// biome-ignore lint/suspicious/useAwait: Target-lock validation may throw synchronously; callers require this exported import API to reject instead.
export async function importRepo(
  c,
  { name, remoteUrl, label = '' },
  { readStorage } = {}
) {
  return workspaceState(c.workspace).withTargets(
    [{ name: 'main', repo: name }],
    async () => {
      const pending = validateRemovalRecords(
        workspaceState(c.workspace).read('removals')
      );
      if (Object.values(pending).some((row) => row.repo === name)) {
        throw Object.assign(
          new Error('Removal cleanup is pending for this repository'),
          { code: 'REMOVAL_PENDING' }
        );
      }
      const repoDir = join(c.workspace, `${name}.git`);
      await assertStorageHeadroom(c.workspace, readStorage);
      const ghSlug = remoteUrl?.match(githubSlugPattern)?.[1] ?? '';

      if (!existsSync(repoDir)) {
        if (!remoteUrl) {
          throw new Error(`No remote URL for ${name}, cannot clone.`);
        }
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
          throw new Error(
            `A directory already exists at ${wtParentDir} and importing would nest a worktree inside it. Move or rename it first, or choose a different project name.`
          );
        }
        await cloneBareRepoAsync(repoDir, remoteUrl, ghSlug, { readStorage });
      }

      await registerProject(c.workspace, { label, name, slug: ghSlug });
      const result = await createWorktree(c, name, 'main', { readStorage });
      await writeSetuAgentMarkers(name, result.wtDir);
      return result;
    }
  );
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
  const res = await fetch(
    `http://localhost:${PORTAL_PORT}${path}`,
    body === undefined
      ? { signal: AbortSignal.timeout(5000) }
      : {
          body: JSON.stringify(body),
          headers: { 'content-type': 'application/json' },
          method: 'POST',
          signal: AbortSignal.timeout(30_000),
        }
  );
  const data = await res.json();
  if (
    data &&
    typeof data === 'object' &&
    !Array.isArray(data) &&
    data.ok === false
  ) {
    throw new Error(data.error ?? `${path} failed`);
  }
  return data;
}
