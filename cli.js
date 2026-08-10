#!/usr/bin/env bun
// setu — workspace bridge: git worktrees, local domains, Cloudflare tunnels
// quivly internal tool — https://github.com/quivly/setu

import readline from 'readline';
import { execFileSync, spawnSync, spawn } from 'child_process';
import {
  existsSync, readFileSync, writeFileSync, appendFileSync,
  mkdirSync, readdirSync, statSync, openSync, unlinkSync,
} from 'fs';
import { join, resolve } from 'path';
import {
  HOME, CFG_PATH, SETU_DIR, PORTAL_PORT, HOSTS_TMP,
  BREW_PREFIX, CADDY_BIN, CLOUDFLARED_BIN,
  loadConfig, saveConfig, requireConfig,
  localDomain, publicDomain, envLocalPath, parseEnvFile, tunnelEnabled, pinnedTriggerVersion,
  writeCaddy, reloadCaddy, syncHosts,
  portEntries, getPort, activePid, listActivePorts, processCwd, loadProjects, registerProject,
  git, createWorktree, removeWorktree,
  portalPid, portalRequest, commandExists, killGroup, containerRuntimeAvailable,
  engineCapacity, parseMemToMb,
} from './lib.js';

const PKG_DIR = new URL('.', import.meta.url).pathname;

function cfg() {
  try { return requireConfig(); } catch (e) { die(e.message); }
}

// ── ANSI ──────────────────────────────────────────────────────────────────────

// Truecolor, not the standard ANSI green — matches the exact brand forest
// green used everywhere else (portal accent, Raycast icon: #085041), so
// setup's checkmarks read as the same brand rather than a generic terminal
// color. Falls back gracefully: any terminal without 24-bit color support
// just ignores the unrecognized SGR and shows default-color text.
const G  = '\x1b[38;2;8;80;65m';
const GR = '\x1b[90m';
const B  = '\x1b[1m';
const Y  = '\x1b[33m';
const R  = '\x1b[0m';
const C  = '\x1b[36m';

function box(text) {
  const pad = 38;
  process.stdout.write(`\n${C}╭${'─'.repeat(pad)}╮${R}\n`);
  process.stdout.write(`${C}│${R}  ${B}${text.padEnd(pad - 2)}${R}${C}│${R}\n`);
  process.stdout.write(`${C}╰${'─'.repeat(pad)}╯${R}\n\n`);
}

function ok(label)   { console.log(`  ${G}✓${R} ${label}`); }
function fail(label) { process.stdout.write(`${Y}✗ ${label}${R}\n`); }
function die(msg)    { console.error(`${Y}error:${R} ${msg}`); process.exit(1); }

function spin(label) { process.stdout.write(`  ${GR}○${R} ${label}...  `); }
function done()      { process.stdout.write(`${G}✓${R}\n`); }

function step(n, total, label) {
  console.log(`${B}[${n}/${total}] ${label}${R}`);
}

// ── args ──────────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const args = [], flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) { flags[key] = next; i++; }
      else flags[key] = true;
    } else args.push(a);
  }
  return { args, flags };
}

// ── router ────────────────────────────────────────────────────────────────────

const [,, cmdRaw, ...rest] = process.argv;
const cmd = { '--version': 'version', '-v': 'version' }[cmdRaw] ?? cmdRaw;
const { args, flags } = parseArgs(rest);
const asJson = !!flags.json;

// Passive staleness nudge — never on `path`/`cd` (the shell wrapper consumes stdout) or meta commands.
if (!['path', 'cd', 'update', 'setup', 'version', 'help', undefined].includes(cmd)) updateNudge();

switch (cmd) {
  case 'setup':   await cmdSetup(); break;
  case 'new':     await cmdNew(); break;
  case 'rm':      await cmdRm(); break;
  case 'ls':      await cmdLs(); break;
  case 'init':    await cmdInit(); break;
  case 'status':  await cmdLs(); break;
  case 'start':   await cmdStart(); break;
  case 'stop':    await cmdStop(); break;
  case 'prune':   await cmdPrune(); break;
  case 'portal':  await cmdPortal(); break;
  case 'tunnel':  await cmdTunnel(); break;
  case 'trigger': await cmdTrigger(); break;
  case 'fetch':   await cmdFetch(); break;
  case 'path':    await cmdPath(); break;
  case 'cd':      await cmdCd(); break;
  case 'update':  await cmdUpdate(); break;
  case 'doctor':  await cmdDoctor(); break;
  case 'version': cmdVersion(); break;
  default:        cmdHelp(); break;
}

// ── helpers ───────────────────────────────────────────────────────────────────

function resolvePath(p) {
  if (!p) return p;
  if (p.startsWith('~/')) return join(HOME, p.slice(2));
  if (p.startsWith('~'))  return join(HOME, p.slice(1));
  return resolve(p);
}

function brewInstalled(p){ return spawnSync('brew', ['list', p], { stdio: 'ignore' }).status === 0; }

function brewInstall(pkg) {
  spin(pkg);
  if (brewInstalled(pkg)) { done(); return; }
  process.stdout.write('installing...  ');
  try { execFileSync('brew', ['install', pkg], { stdio: ['ignore', 'pipe', 'pipe'] }); done(); }
  catch { fail(`failed — run: brew install ${pkg}`); process.exit(1); }
}

function ask(rl, question, defaultVal) {
  return new Promise(res => {
    const prompt = defaultVal
      ? `  ${C}?${R} ${question} [${GR}${defaultVal}${R}]:  `
      : `  ${C}?${R} ${question}:  `;
    rl.question(prompt, answer => res(answer.trim() || defaultVal || ''));
  });
}

function sudoTee(content, dest, mode) {
  execFileSync('sudo', ['tee', dest], { input: content, stdio: ['pipe', 'ignore', 'inherit'] });
  if (mode) execFileSync('sudo', ['chmod', mode, dest], { stdio: 'ignore' });
}

async function ensurePortal(c) {
  if (portalPid()) return;
  const portalJs = join(PKG_DIR, 'portal.js');
  if (!existsSync(portalJs)) die(`portal.js not found at ${portalJs}`);
  // cwd = package dir so bunfig.toml (tailwind plugin) and node_modules resolve
  const child = spawn('bun', ['run', portalJs], {
    cwd: PKG_DIR, detached: true, stdio: ['ignore', 'ignore', 'ignore'], env: { ...process.env, HOME },
  });
  child.unref();
  for (let i = 0; i < 40; i++) {
    try { await portalRequest('/api/worktrees'); return; } catch {}
    await new Promise(r => setTimeout(r, 200));
  }
  die('portal did not come up on :' + PORTAL_PORT);
}

function autoInstall(wtDir) {
  if (existsSync(join(wtDir, 'package.json'))) {
    spawnSync('bun', ['install'], { cwd: wtDir, stdio: 'inherit' });
  } else if (existsSync(join(wtDir, 'pyproject.toml')) || existsSync(join(wtDir, 'requirements.txt'))) {
    spawnSync('uv', ['sync'], { cwd: wtDir, stdio: 'inherit' });
  }
}

// ── setu setup [--name x] [--workspace p] [--zone z] [--yes] ─────────────────

async function cmdSetup() {
  box('setu setup');

  // 1. deps
  step(1, 8, 'Dependencies');
  if (!commandExists('brew')) die('Homebrew not found — install from https://brew.sh');
  ok('homebrew');
  if (!commandExists('bun')) die('bun not found');
  ok('bun');
  for (const pkg of ['caddy', 'cloudflared', 'dnsmasq', 'direnv']) brewInstall(pkg);
  console.log();

  // 2. configure — flags first, prompts only for what's missing (agents pass flags)
  step(2, 8, 'Configuration');
  const existing = loadConfig();
  let name      = flags.name ?? (existing.tunnel ? existing.tunnel.replace(/^dev-/, '') : '');
  let workspace = resolvePath(flags.workspace ?? existing.workspace ?? join(HOME, 'workspace'));
  let zone      = flags.zone ?? existing.domain?.split('.').slice(1).join('.') ?? 'getquivly.ai';

  const interactive = process.stdin.isTTY && !flags.yes;
  if (interactive) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    try {
      name      = await ask(rl, 'Your name (e.g. "alice" → tunnel dev-alice)', name);
      workspace = resolvePath(await ask(rl, 'Workspace path', workspace.replace(HOME, '~')));
      zone      = await ask(rl, 'Zone domain', zone);
    } finally { rl.close(); }
  }
  if (!name) die('Name is required — pass --name <you> (non-interactive) or run in a terminal.');
  const input = { name, workspace, zone, tunnel: `dev-${name}`, domain: `dev-${name}.${zone}` };
  ok(`${input.tunnel} → ${input.domain}, workspace ${workspace}`);
  console.log();

  // 3. Cloudflare
  step(3, 8, 'Cloudflare tunnel');
  if (!existsSync(join(HOME, '.cloudflared', 'cert.pem'))) {
    process.stdout.write(`  ${GR}○${R} Logging in to Cloudflare...  `);
    execFileSync(CLOUDFLARED_BIN, ['tunnel', 'login'], { stdio: 'inherit' });
    done();
  } else {
    ok('already authenticated');
  }

  spin(`tunnel ${input.tunnel}`);
  const listOut = execFileSync(CLOUDFLARED_BIN, ['tunnel', 'list'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  if (!listOut.split('\n').some(l => l.includes(` ${input.tunnel} `))) {
    execFileSync(CLOUDFLARED_BIN, ['tunnel', 'create', input.tunnel], { stdio: 'ignore' });
    done();
  } else {
    process.stdout.write(`${G}✓${R} already exists\n`);
  }

  const cfDir  = join(HOME, '.cloudflared');
  const cfCreds = readdirSync(cfDir)
    .filter(f => f.endsWith('.json'))
    .map(f => ({ f, mt: statSync(join(cfDir, f)).mtimeMs }))
    .sort((a, b) => b.mt - a.mt)[0]?.f ?? '';
  const cfCredentials = cfCreds ? join(cfDir, cfCreds) : '';

  spin(`DNS *.${input.domain}`);
  try {
    execFileSync(CLOUDFLARED_BIN, ['tunnel', 'route', 'dns', input.tunnel, input.domain], { stdio: 'ignore' });
    execFileSync(CLOUDFLARED_BIN, ['tunnel', 'route', 'dns', input.tunnel, `*.${input.domain}`], { stdio: 'ignore' });
    done();
  } catch {
    process.stdout.write(`${G}✓${R} already configured\n`);
  }
  console.log();

  // 4. DNS & proxy
  step(4, 8, 'DNS & proxy');
  spin('dnsmasq');
  const dnsConf = join(BREW_PREFIX, 'etc', 'dnsmasq.conf');
  const dnsText = existsSync(dnsConf) ? readFileSync(dnsConf, 'utf8') : '';
  if (!dnsText.includes('address=/.quivly.local/127.0.0.1'))
    appendFileSync(dnsConf, '\naddress=/.quivly.local/127.0.0.1\n');
  // port 53 needs root — a user-level dnsmasq service silently fails to bind
  try {
    execFileSync('sudo', ['brew', 'services', 'restart', 'dnsmasq'], { stdio: ['inherit', 'ignore', 'ignore'] });
    done();
  } catch { fail('failed — run: sudo brew services restart dnsmasq'); }

  spin('/etc/resolver/quivly.local');
  execFileSync('sudo', ['mkdir', '-p', '/etc/resolver'], { stdio: 'ignore' });
  sudoTee('nameserver 127.0.0.1\n', '/etc/resolver/quivly.local');
  done();

  spin('Caddyfile');
  mkdirSync(join(input.workspace, 'caddy.d'), { recursive: true });
  mkdirSync(join(input.workspace, 'logs'),    { recursive: true });
  const caddyfile = join(input.workspace, 'Caddyfile');
  if (!existsSync(caddyfile))
    writeFileSync(caddyfile, `{ auto_https off }\nimport ${input.workspace}/caddy.d/*.caddy\n`);
  done();

  spin('caddy service');
  const services = execFileSync('brew', ['services', 'list'], { encoding: 'utf8' });
  if (!/^caddy\s+started/m.test(services)) {
    try { execFileSync('brew', ['services', 'restart', 'caddy'], { stdio: 'ignore' }); done(); }
    catch { fail('failed — run: brew services restart caddy'); }
  } else {
    process.stdout.write(`${G}✓${R} already running\n`);
  }
  console.log();

  // 5. Passwordless sudo — rules must match EXACTLY what lib.js runs
  step(5, 8, 'Passwordless sudo');
  const user = execFileSync('whoami', { encoding: 'utf8' }).trim();
  spin('caddy reload');
  const caddyRule = `${user} ALL=(ALL) NOPASSWD: ${CADDY_BIN} reload --config ${input.workspace}/Caddyfile`;
  sudoTee(caddyRule + '\n', `/etc/sudoers.d/caddy-setu-${user}`, '440');
  done();

  spin('/etc/hosts sync');
  const hostsRule = `${user} ALL=(ALL) NOPASSWD: /bin/cp ${HOSTS_TMP} /etc/hosts`;
  sudoTee(hostsRule + '\n', `/etc/sudoers.d/setu-hosts-${user}`, '440');
  done();
  console.log();

  // 6. config + shell
  step(6, 8, 'Shell & config');
  spin('~/.setu.json');
  saveConfig({ workspace: input.workspace, tunnel: input.tunnel, domain: input.domain, cfCredentials });
  done();

  spin('~/.zshrc');
  const zshrc = join(HOME, '.zshrc');
  const START = '# setu start';
  const END   = '# setu end';
  // a child process can't cd the parent shell — `setu cd` needs this wrapper
  const block = `${START}\nsetu() { if [ "$1" = "cd" ]; then cd "$(command setu path "$2" "$3")" || return; else command setu "$@"; fi; }\n${END}`;
  let current = '';
  try { current = readFileSync(zshrc, 'utf8'); } catch {}
  if (current.includes(START)) {
    const si = current.indexOf(START), ei = current.indexOf(END);
    writeFileSync(zshrc, current.slice(0, si) + block + (ei !== -1 ? current.slice(ei + END.length) : ''));
  } else {
    appendFileSync(zshrc, '\n' + block + '\n');
  }
  done();
  console.log();

  // 7. first hosts sync
  step(7, 8, 'Verify');
  syncHosts(input.workspace) ? ok('/etc/hosts synced') : fail('/etc/hosts sync');
  console.log();

  // 8. Raycast extension — optional, skipped silently if Raycast isn't
  // installed. There's no headless way to register a local extension with
  // Raycast (it goes through the app's own Import/Develop flow), so this
  // only ever prints the one manual step rather than pretending to automate it.
  step(8, 8, 'Raycast extension');
  if (existsSync('/Applications/Raycast.app') || existsSync('/Applications/Raycast Beta.app')) {
    ok('Raycast detected');
    console.log(`  ${GR}run: cd ${SETU_DIR}/raycast && npm install && npx ray develop${R}`);
  } else {
    console.log(`  ${GR}○${R} Raycast not installed — skipping`);
  }
  console.log();

  box('All done!');
  console.log(`  ${G}1.${R} source ~/.zshrc`);
  console.log(`  ${G}2.${R} setu portal`);
  console.log(`  ${G}3.${R} open http://quivly.local`);
  console.log(`  ${G}4.${R} setu init quivly/quivly-app`);
  console.log();
  console.log(`  ${GR}run \`setu doctor\` if anything misbehaves${R}\n`);
}

// ── setu new <repo> <branch> [--tunnel] [--start] [--container|--bare] [--json] ─

async function cmdNew() {
  const [repo, name] = args;
  if (!repo || !name) die('Usage: setu new <repo> <branch> [--tunnel] [--start] [--container|--bare] [--json]');
  const c = cfg();
  const withTunnel = !!flags.tunnel;

  let res;
  try { res = createWorktree(c, repo, name, { tunnel: withTunnel }); }
  catch (e) { die(e.message); }

  if (withTunnel) await ensureTunnel(c, repo, name);
  autoInstall(res.wtDir);

  let started = false;
  if (flags.start) {
    await ensurePortal(c);
    const startBody = { repo, name };
    if (flags.container) startBody.container = true;
    else if (flags.bare) startBody.container = false;
    // Neither flag: a brand-new worktree has no prior history either way, so
    // the portal's sticky default naturally resolves to the intended global
    // default (container) here — same call shape as `setu start`, not a
    // special case.
    const startRes = await portalRequest('/api/start', startBody).catch(e => ({ ok: false, error: String(e) }));
    started = !!startRes.ok;
    if (!started) fail(`dev server start failed: ${startRes.error ?? 'unknown'}`);
  }

  if (asJson) { console.log(JSON.stringify({ ...res, started })); return; }
  console.log(`\n  ${G}✓${R} worktree  ${res.wtDir}`);
  console.log(`  ${G}✓${R} port      :${res.port}`);
  console.log(`  ${G}✓${R} local     http://${res.localDom}`);
  if (withTunnel) console.log(`  ${G}✓${R} public    https://${res.pubDom}`);
  if (started) console.log(`  ${G}✓${R} dev server started`);
  console.log();
}

// ── setu rm <repo> <branch> ───────────────────────────────────────────────────

async function cmdRm() {
  const [repo, name] = args;
  if (!repo || !name) die('Usage: setu rm <repo> <branch>');
  const c = cfg();
  // Portal owns dev-server/tunnel processes — let it stop them + clean up
  if (portalPid()) {
    const res = await portalRequest('/api/remove', { repo, name }).catch(e => ({ ok: false, error: String(e) }));
    if (!res.ok) die(res.error ?? 'remove failed');
  } else {
    try { removeWorktree(c, repo, name); } catch (e) { die(e.message); }
  }
  ok(`removed ${repo}/${name}`);
}

// ── setu start / stop <repo> <branch> ─────────────────────────────────────────
// The portal already exposes /api/start and /api/stop — this is the CLI verb
// that was missing to reach them. Without it, `setu new` never started anything
// and the only way to start a worktree's dev server was clicking a button in the
// web UI, so real usage (agents included) bypassed the portal entirely by just
// `cd`-ing in and running `bun dev` directly — untracked, unbounded, duplicable.

async function cmdStart() {
  const [repo, name] = args;
  if (!repo || !name) die('Usage: setu start <repo> <branch> [--container|--bare]');
  const c = cfg();
  if (!getPort(c.workspace, repo, name)) die(`No worktree for ${repo}/${name} — run: setu new ${repo} ${name}`);
  await ensurePortal(c);
  // --container/--bare force a mode explicitly. Neither flag omits `container`
  // entirely so the portal applies its sticky per-worktree default instead of
  // blindly forcing one — found live: a flat "container unless --bare" default
  // silently switched an established, always-bare worktree into a container
  // the moment it needed a restart with no explicit choice from anyone.
  const body = { repo, name };
  if (flags.container) body.container = true;
  else if (flags.bare) body.container = false;
  const res = await portalRequest('/api/start', body).catch(e => ({ ok: false, error: String(e) }));
  if (!res.ok) die(res.error ?? 'start failed');
  ok(`started ${repo}/${name}${res.queued ? ' (queued)' : res.container ? ' (containerized)' : ' (bare)'}`);
}

async function cmdStop() {
  const [repo, name] = args;
  if (!repo || !name) die('Usage: setu stop <repo> <branch>');
  if (!portalPid()) { console.log('Portal not running — nothing to stop.'); return; }
  const res = await portalRequest('/api/stop', { repo, name }).catch(e => ({ ok: false, error: String(e) }));
  if (!res.ok) die(res.error ?? 'stop failed');
  ok(`stopped ${repo}/${name}`);
}

// ── setu prune [--force] ──────────────────────────────────────────────────────
// Finds dev-server processes that are listening but not in setu's own registry —
// the "orb" pattern found in production: a worktree fully running and consuming
// memory, invisible to `setu ls`/the portal because portEntries() only knows
// about what .ports already has. Dry-run by default; --force actually kills.

async function cmdPrune() {
  const c = cfg();
  const known  = new Set(portEntries(c.workspace).map(e => e.port));
  const active = listActivePorts();
  const orphans = active.filter(p => !known.has(p.port));

  if (!orphans.length) { ok('nothing to prune'); return; }

  console.log(`\n  ${Y}${orphans.length} unregistered process${orphans.length > 1 ? 'es' : ''} found:${R}\n`);
  for (const p of orphans) console.log(`  ${GR}pid ${p.pid}${R}  :${p.port}  ${p.cmd}`);
  console.log();

  if (!flags.force) { console.log(`  run with ${B}--force${R} to kill ${orphans.length > 1 ? 'them' : 'it'}\n`); return; }

  for (const p of orphans) {
    try { execFileSync('kill', [p.pid]); ok(`killed pid ${p.pid} (:${p.port})`); }
    catch (e) { fail(`pid ${p.pid}: ${e.message}`); }
  }
}

// ── setu ls [repo] [--json] ───────────────────────────────────────────────────

async function cmdLs() {
  const [repo] = args;
  const c = cfg();
  const entries = portEntries(c.workspace).filter(e => !repo || e.repo === repo);
  if (!entries.length) { asJson ? console.log('[]') : console.log('No worktrees yet.'); return; }

  const rows = entries.map(e => ({
    ...e,
    running: !!activePid(e.port),
    wtDir: join(c.workspace, e.repo, e.name),
    localDomain: localDomain(e.repo, e.name),
    tunnel: tunnelEnabled(join(c.workspace, e.repo, e.name), c),
  }));

  if (asJson) { console.log(JSON.stringify(rows, null, 2)); return; }
  for (const r of rows) {
    const state = r.running ? `${G}●${R} running` : `${GR}○${R} stopped`;
    console.log(`  ${state}  ${r.key}  :${r.port}${r.tunnel ? `  ${C}⇄ ${publicDomain(c)}${R}` : ''}`);
  }
}

// ── setu init <gh-slug> [label] ───────────────────────────────────────────────

async function cmdInit() {
  const [slug, label] = args;
  if (!slug) die('Usage: setu init quivly/quivly-app [label]');
  const c = cfg();
  const repo    = slug.split('/').pop();
  const repoDir = join(c.workspace, `${repo}.git`);

  if (!existsSync(repoDir)) {
    console.log(`  Cloning ${slug}...`);
    const useGh = spawnSync('gh', ['auth', 'status'], { stdio: 'ignore' }).status === 0;
    if (useGh) {
      execFileSync('gh', ['repo', 'clone', slug, repoDir, '--', '--bare'], { stdio: 'inherit' });
    } else {
      execFileSync('git', ['clone', '--bare', `git@github.com:${slug}.git`, repoDir], { stdio: 'inherit' });
    }
    git(repoDir, ['config', 'remote.origin.fetch', '+refs/heads/*:refs/remotes/origin/*']);
    git(repoDir, ['fetch', '--all', '--prune']);
  }

  registerProject(c.workspace, { name: repo, slug, label });
  args.length = 0; args.push(repo, 'main');
  await cmdNew();
}

// ── setu portal [stop] ────────────────────────────────────────────────────────

async function cmdPortal() {
  const [action] = args;
  const c = cfg();
  const pid = portalPid();

  if (action === 'stop') {
    if (pid) { execFileSync('kill', [pid]); ok('Portal stopped'); }
    else console.log('Portal not running.');
    return;
  }

  if (pid) {
    console.log(`Portal already running (pid ${pid}) → http://quivly.local`);
    return;
  }

  await ensurePortal(c);
  reloadCaddy(c.workspace);
  ok('Portal → http://quivly.local');
}

// ── setu tunnel <repo> <branch> [stop] ────────────────────────────────────────
// The portal owns the cloudflared process — the CLI just asks it.

async function ensureTunnel(c, repo, name) {
  await ensurePortal(c);
  const res = await portalRequest('/api/tunnel/enable', { repo, name })
    .catch(e => ({ ok: false, error: String(e) }));
  if (!res.ok) die(res.error ?? 'tunnel enable failed');
}

async function cmdTunnel() {
  const [repo, name, action] = args;
  if (!repo || !name) die('Usage: setu tunnel <repo> <branch> [stop]');
  const c = cfg();
  if (!getPort(c.workspace, repo, name)) die(`No worktree for ${repo}/${name} — run: setu new ${repo} ${name}`);

  if (action === 'stop') {
    if (!portalPid()) { console.log('Portal not running — tunnel already down.'); return; }
    const res = await portalRequest('/api/tunnel/disable', { repo, name })
      .catch(e => ({ ok: false, error: String(e) }));
    if (!res.ok) die(res.error ?? 'tunnel disable failed');
    ok(`tunnel disabled for ${repo}/${name}`);
    return;
  }

  await ensureTunnel(c, repo, name);
  ok(`Public → https://${publicDomain(c)}  (now pointing at ${repo}/${name})`);
}

// ── setu trigger <repo> <branch> [stop] ──────────────────────────────────────
// Runs `trigger dev` for a worktree as a detached background process, so
// multiple worktrees of the same repo can each run their own without
// fighting over a terminal.

function triggerLogPaths(workspace, repo, name) {
  const slug = name.replace(/\//g, '-');
  return {
    pidFile: join(workspace, 'logs', `trigger-${repo}-${slug}.pid`),
    logFile: join(workspace, 'logs', `trigger-${repo}-${slug}.log`),
  };
}

function runningPid(pidFile) {
  if (!existsSync(pidFile)) return null;
  const pid = parseInt(readFileSync(pidFile, 'utf8'));
  if (!pid) return null;
  try { process.kill(pid, 0); return pid; }
  catch (err) { return err.code === 'EPERM' ? pid : null; }
}

async function cmdTrigger() {
  const [repo, name, action] = args;
  if (!repo || !name) die('Usage: setu trigger <repo> <branch> [stop]');
  const c = cfg();
  const wtDir = join(c.workspace, repo, name);
  if (!existsSync(wtDir)) die(`No worktree for ${repo}/${name} — run: setu new ${repo} ${name}`);

  // Portal owns trigger.dev sidecars too (/api/trigger/start|stop) — delegate to
  // it when running, same as cmdRm does for worktree removal. Without this, a
  // CLI-started session and a portal-started session for the same worktree can't
  // see each other and nothing stops both from running at once.
  if (portalPid()) {
    if (action === 'stop') {
      const res = await portalRequest('/api/trigger/stop', { repo, name }).catch(e => ({ ok: false, error: String(e) }));
      if (!res.ok) die(res.error ?? 'stop failed');
      ok(`stopped trigger dev for ${repo}/${name}`);
    } else {
      const res = await portalRequest('/api/trigger/start', { repo, name }).catch(e => ({ ok: false, error: String(e) }));
      if (!res.ok) die(res.error ?? 'start failed');
      ok(`Trigger dev started for ${repo}/${name} (via portal)`);
    }
    return;
  }

  const { pidFile, logFile } = triggerLogPaths(c.workspace, repo, name);
  const pid = runningPid(pidFile);

  if (action === 'stop') {
    if (!pid) { console.log(`Trigger dev not running for ${repo}/${name}.`); return; }
    // killGroup, not a bare `process.kill(-pid, ...)` — this pid came from a PID
    // file that can outlive a reboot; blindly treating it as its own pgid risks
    // signaling a process group this pid was reassigned to (PID reuse) rather
    // than the one setu actually spawned. killGroup verifies pgid===pid first.
    killGroup(pid);
    unlinkSync(pidFile);
    ok(`stopped trigger dev for ${repo}/${name}`);
    return;
  }

  if (pid) {
    console.log(`Trigger dev already running (pid ${pid}) for ${repo}/${name} → ${logFile}`);
    return;
  }

  mkdirSync(join(c.workspace, 'logs'), { recursive: true });
  const out = openSync(logFile, 'a');
  const version = pinnedTriggerVersion(wtDir);
  // trigger tasks import Supabase keys etc. from the shared .env.local at load
  // time — a plain spawn() won't pick that up the way `next dev`/direnv would.
  const env = { ...process.env, ...parseEnvFile(envLocalPath(repo, wtDir)) };
  const child = spawn('bunx', [`trigger.dev@${version}`, 'dev'], {
    cwd: wtDir,
    detached: true,
    stdio: ['ignore', out, out],
    env,
  });
  writeFileSync(pidFile, String(child.pid));
  child.unref();

  ok(`Trigger dev started for ${repo}/${name} (pid ${child.pid})`);
  console.log(`  ${GR}logs: ${logFile}${R}`);
}

// ── setu fetch <repo> ─────────────────────────────────────────────────────────

async function cmdFetch() {
  const [repo] = args;
  if (!repo) die('Usage: setu fetch <repo>');
  const c = cfg();
  execFileSync('git', ['-C', join(c.workspace, `${repo}.git`), 'fetch', '--all', '--prune'], { stdio: 'inherit' });
}

// ── setu path <repo> <branch> ────────────────────────────────────────────────
// Used by the `wt()` shell function to cd into a worktree — stdout must stay clean.

async function cmdPath() {
  const [repo, name] = args;
  if (!repo || !name) die('Usage: setu path <repo> <branch>');
  const c = cfg();
  const p = join(c.workspace, repo, name);
  if (!existsSync(p)) die(`No worktree at ${p} — run: setu new ${repo} ${name}`);
  process.stdout.write(p + '\n');
}

// ── setu cd <repo> <branch> ──────────────────────────────────────────────────
// Normally intercepted by the setu() shell function before reaching the binary.
// Reaching here means shell integration isn't loaded — still print the path so
// `cd "$(setu cd r b)"` works, and hint on stderr.

async function cmdCd() {
  await cmdPath();
  if (process.stdout.isTTY)
    console.error(`${GR}shell integration not loaded — run: source ~/.zshrc${R}`);
}

// ── setu update ───────────────────────────────────────────────────────────────

function setuGit(argv, opts = {}) {
  return execFileSync('git', ['-C', SETU_DIR, ...argv], { encoding: 'utf8', ...opts });
}

async function cmdUpdate() {
  console.log('Updating setu...');
  if (!existsSync(join(SETU_DIR, '.git'))) {
    const useGh = spawnSync('gh', ['auth', 'status'], { stdio: 'ignore' }).status === 0;
    if (useGh) execFileSync('gh', ['repo', 'clone', 'quivly/setu', SETU_DIR, '--', '--quiet'], { stdio: 'inherit' });
    else execFileSync('git', ['clone', 'git@github.com:quivly/setu.git', SETU_DIR, '--quiet'], { stdio: 'inherit' });
  } else {
    setuGit(['fetch', 'origin', '--quiet']);
    const behind = parseInt(setuGit(['rev-list', '--count', 'HEAD..origin/main']).trim(), 10);
    const before = setuGit(['rev-parse', 'HEAD']).trim();

    const dirty = setuGit(['status', '--porcelain']).trim() !== '';
    if (dirty) {
      console.log(`  ${Y}⚠${R}  local edits in ~/.setu — stashing before update`);
      setuGit(['stash', 'push', '-m', `setu-update ${new Date().toISOString()}`]);
    }
    try {
      setuGit(['pull', '--rebase', '--quiet', 'origin', 'main'], { stdio: ['ignore', 'inherit', 'inherit'] });
    } catch {
      if (dirty) setuGit(['stash', 'pop']);
      die('pull failed — fix ~/.setu manually (git -C ~/.setu status)');
    }
    if (dirty) {
      try { setuGit(['stash', 'pop']); ok('local edits restored'); }
      catch {
        console.error(`  ${Y}⚠${R}  your local edits conflict with the update — they are saved in the stash.`);
        console.error(`     recover with: git -C ~/.setu stash show -p && git -C ~/.setu stash pop`);
      }
    }

    if (behind > 0) {
      console.log(`\n  ${B}What's new:${R}`);
      for (const l of setuGit(['log', '--oneline', `${before}..HEAD`]).trim().split('\n').filter(Boolean))
        console.log(`  ${GR}·${R} ${l}`);
      console.log();
    } else {
      ok('already up to date');
    }
  }

  execFileSync('bun', ['install'], { cwd: SETU_DIR, stdio: 'ignore' });
  execFileSync('bun', ['link'], { cwd: SETU_DIR, stdio: 'ignore' });

  // A running portal keeps serving old code — restart it
  const pid = portalPid();
  if (pid) {
    execFileSync('kill', [pid]);
    await new Promise(r => setTimeout(r, 500));
    const c = loadConfig();
    if (c.workspace) { await ensurePortal(c); ok('portal restarted'); }
  }
  const cNudge = loadConfig();
  saveConfig({ ...cNudge, lastUpdateCheck: Date.now() });
  ok('setu updated');
}

// Once a day: report staleness from the last fetch, then refresh refs in the
// background so tomorrow's check is current. Never blocks, never prompts.
function updateNudge() {
  try {
    const c = loadConfig();
    if (!existsSync(join(SETU_DIR, '.git'))) return;
    if (Date.now() - (c.lastUpdateCheck ?? 0) < 24 * 60 * 60 * 1000) return;
    saveConfig({ ...c, lastUpdateCheck: Date.now() });
    const behind = parseInt(setuGit(['rev-list', '--count', 'HEAD..origin/main']).trim(), 10);
    if (behind > 0)
      console.error(`${GR}setu is ${behind} commit${behind > 1 ? 's' : ''} behind — run \`setu update\`${R}`);
    const child = spawn('git', ['-C', SETU_DIR, 'fetch', 'origin', '--quiet'],
      { detached: true, stdio: 'ignore' });
    child.unref();
  } catch {}
}

// ── setu version ──────────────────────────────────────────────────────────────

function cmdVersion() {
  const pkg = JSON.parse(readFileSync(join(PKG_DIR, 'package.json'), 'utf8'));
  let sha = '';
  try { sha = setuGit(['rev-parse', '--short', 'HEAD']).trim(); } catch {}
  console.log(`setu ${pkg.version}${sha ? ` (${sha})` : ''}`);
}

// ── setu doctor [--json] ──────────────────────────────────────────────────────

// Bun.spawn, not execFileSync/spawnSync — checks run concurrently (Promise.all
// below) instead of one after another; a blocking exec call per check would
// serialize them on the event loop regardless of the Promise.all wrapper.
async function spawnText(cmd, args) {
  try {
    const proc = Bun.spawn([cmd, ...args], { stdout: 'pipe', stderr: 'ignore' });
    const text = await new Response(proc.stdout).text();
    await proc.exited;
    return { text, code: proc.exitCode };
  } catch { return { text: '', code: 1 }; }
}

async function cmdDoctor() {
  const c = loadConfig();
  const workspace = c.workspace ?? '';

  // Shared across multiple checks below — fetch once, not once per check.
  const [servicesRes, digRes, caddyAdmin] = await Promise.all([
    spawnText('brew', ['services', 'list']),
    spawnText('dig', ['+short', '+time=1', '+tries=1', 'test.quivly.local', '@127.0.0.1']),
    fetch('http://localhost:2019/config/', { signal: AbortSignal.timeout(1500) }).then(r => r.ok).catch(() => false),
  ]);
  const services    = servicesRes.text;
  const dnsmasqLine = services.split('\n').find(l => l.startsWith('dnsmasq')) ?? '';
  const sudoOk      = async (argv) => (await spawnText('sudo', ['-n', '-l', ...argv])).code === 0;

  const checkThunks = [
    ...['caddy', 'cloudflared', 'dnsmasq', 'direnv'].map(pkg => async () => (
      { name: `brew: ${pkg}`, ok: brewInstalled(pkg), fix: `brew install ${pkg}` }
    )),
    async () => ({ name: 'config ~/.setu.json', ok: !!(c.workspace && c.domain && c.tunnel), fix: 'setu setup' }),
    async () => ({
      name: 'dnsmasq service',
      ok: /^dnsmasq\s+started/.test(dnsmasqLine) && !/error/.test(dnsmasqLine),
      fix: 'sudo brew services stop dnsmasq && sudo brew services restart dnsmasq',
    }),
    async () => ({ name: 'dnsmasq resolves *.quivly.local', ok: digRes.text.includes('127.0.0.1'), fix: 'sudo brew services restart dnsmasq (then re-check)' }),
    async () => ({ name: '/etc/resolver/quivly.local', ok: existsSync('/etc/resolver/quivly.local'), fix: 'setu setup' }),
    async () => ({ name: 'caddy service', ok: /^caddy\s+started/m.test(services), fix: 'brew services restart caddy' }),
    async () => ({ name: 'caddy admin API (:2019)', ok: caddyAdmin, fix: 'brew services restart caddy' }),
    // `setu start` containerizes by default now (real memory/CPU cap) — a
    // missing runtime isn't merely informational, it means plain `setu start`
    // will fail until either the engine is running or `--bare` is passed.
    // Reports whichever engine answered (OrbStack, Docker Desktop, Colima, …)
    // without requiring one specifically — see the containerization plan.
    async () => {
      const rt = containerRuntimeAvailable();
      return { name: 'container runtime (setu start uses it by default)', ok: rt.available,
        fix: rt.available ? undefined : 'start OrbStack/Docker Desktop — or use `setu start --bare` until then' };
    },
    // engineCapacity() clamps each INDIVIDUAL container's limit to what the
    // engine has — that alone doesn't stop 3 containers, each individually
    // valid, from jointly asking for more memory than the engine's VM
    // actually has. Documented as an invariant to manage by hand in AGENTS.md;
    // this is the check that actually verifies it instead of leaving it as
    // homework. Memory only, not CPU — CPU is shares-based and softly
    // time-shares under oversubscription, it doesn't fail the way memory can.
    async () => {
      const cap = engineCapacity();
      if (!cap.memMb) return { name: 'container memory budget fits engine capacity', ok: true };
      const memLimitMb = parseMemToMb(c.containerMemoryLimit ?? '4g') ?? 4096;
      const maxDev = c.maxConcurrentDevServers ?? 3;
      const totalMb = memLimitMb * maxDev;
      const ok = totalMb <= cap.memMb;
      return { name: 'container memory budget fits engine capacity', ok,
        fix: ok ? undefined : `maxConcurrentDevServers(${maxDev}) × containerMemoryLimit(${memLimitMb}MB) = ${totalMb}MB exceeds the engine's ${cap.memMb}MB — lower one in ~/.setu.json` };
    },
    async () => ({
      name: 'sudoers: caddy reload',
      ok: !!workspace && await sudoOk([CADDY_BIN, 'reload', '--config', join(workspace, 'Caddyfile')]),
      fix: 'setu setup (rewrites /etc/sudoers.d/caddy-setu-*)',
    }),
    async () => ({ name: 'sudoers: hosts sync', ok: await sudoOk(['/bin/cp', HOSTS_TMP, '/etc/hosts']), fix: 'setu setup (rewrites /etc/sudoers.d/setu-hosts-*)' }),
    async () => ({ name: '/etc/hosts quivly block', ok: readFileSync('/etc/hosts', 'utf8').includes('# quivly-start'), fix: 'setu new <repo> <branch> (or any command that syncs hosts)' }),
    async () => ({ name: 'cloudflared cert', ok: existsSync(join(HOME, '.cloudflared', 'cert.pem')), fix: 'cloudflared tunnel login' }),
  ];

  if (c.tunnel) {
    checkThunks.push(async () => {
      const tl = await spawnText(CLOUDFLARED_BIN, ['tunnel', 'list']);
      return { name: `tunnel ${c.tunnel} exists`, ok: tl.text.split('\n').some(l => l.includes(` ${c.tunnel} `)), fix: `cloudflared tunnel create ${c.tunnel}` };
    });
  }

  // setu repo hygiene
  if (existsSync(join(SETU_DIR, '.git'))) {
    checkThunks.push(async () => ({ name: '~/.setu clean', ok: setuGit(['status', '--porcelain']).trim() === '', fix: 'git -C ~/.setu status — commit or stash local edits' }));
    checkThunks.push(async () => {
      let behind = 0;
      try { behind = parseInt(setuGit(['rev-list', '--count', 'HEAD..origin/main']).trim(), 10); } catch {}
      return { name: 'setu up to date', ok: behind === 0, fix: 'setu update' };
    });
  }

  // worktree hygiene — the class of bug that let a worktree ("orb") run fully
  // invisibly to setu for over a day in production: unregistered-but-running
  // processes, a registered port whose actual listener belongs to a different
  // worktree, and worktree directories git knows about that setu's own registry
  // (.ports/.projects) doesn't. entries/active computed once, shared by all
  // four checks below instead of each re-scanning independently.
  if (workspace) {
    const entries = portEntries(workspace);
    const active  = listActivePorts();

    checkThunks.push(async () => {
      const known = new Set(entries.map(e => e.port));
      const orphanProcs = active.filter(p => !known.has(p.port));
      return { name: 'no unregistered dev-server processes', ok: orphanProcs.length === 0,
        fix: orphanProcs.length ? `setu prune  (${orphanProcs.length} found: ${orphanProcs.map(p => `pid ${p.pid} :${p.port}`).join(', ')})` : undefined };
    });

    checkThunks.push(async () => {
      const mismatches = [];
      for (const e of entries) {
        const p = active.find(a => a.port === e.port);
        if (!p) continue;
        const cwd = processCwd(p.pid);
        const expected = resolve(join(workspace, e.repo, e.name));
        // Nx/monorepo dev servers end up with cwd nested inside apps/<app> —
        // only flag it if cwd isn't the worktree root or underneath it.
        if (cwd && resolve(cwd) !== expected && !resolve(cwd).startsWith(expected + '/'))
          mismatches.push(`${e.key} :${e.port} is actually serving ${cwd}`);
      }
      return { name: 'registered ports match their worktree', ok: mismatches.length === 0, fix: mismatches.join('; ') || undefined };
    });

    checkThunks.push(async () => {
      const registeredDirs = new Set(entries.map(e => join(workspace, e.repo, e.name)));
      const gitWorktreeDirs = new Set();
      for (const repo of Object.keys(loadProjects(workspace))) {
        const repoDir = join(workspace, `${repo}.git`);
        if (!existsSync(repoDir)) continue;
        try {
          const porcelain = git(repoDir, ['worktree', 'list', '--porcelain']);
          for (const wt of porcelain.trim().split('\n\n')) {
            const p = wt.match(/^worktree (.+)$/m)?.[1];
            if (p && p !== repoDir && !p.includes('/.claude/worktrees/')) gitWorktreeDirs.add(p);
          }
        } catch {}
      }
      const unregistered = [...gitWorktreeDirs].filter(d => !registeredDirs.has(d));
      return { name: 'all git worktrees are registered with setu', ok: unregistered.length === 0,
        fix: unregistered.length ? `setu new for: ${unregistered.join(', ')}  (or setu rm if abandoned)` : undefined };
    });

    // mirror case: registry entries for worktrees removed via raw `git worktree
    // remove` instead of `setu rm` — the port/domain registration outlives the
    // directory it pointed at.
    checkThunks.push(async () => {
      const stale = entries.filter(e => !existsSync(join(workspace, e.repo, e.name)));
      return { name: 'no registry entries for missing worktrees', ok: stale.length === 0,
        fix: stale.length ? `stale: ${stale.map(e => e.key).join(', ')}  — releasePort() or setu rm each` : undefined };
    });
  }

  checkThunks.push(async () => ({
    name: 'portal (:2999)',
    ok: await portalRequest('/api/worktrees').then(() => true).catch(() => false),
    fix: 'setu portal',
  }));

  const checks = (await Promise.all(checkThunks.map(fn => fn()))).map(r => ({ ...r, ok: !!r.ok }));

  if (asJson) {
    console.log(JSON.stringify(checks, null, 2));
    process.exit(checks.every(x => x.ok) ? 0 : 1);
  }

  console.log();
  for (const x of checks) {
    if (x.ok) ok(x.name);
    else console.log(`  ${Y}✗${R} ${x.name}  ${GR}→ ${x.fix}${R}`);
  }
  const bad = checks.filter(x => !x.ok).length;
  console.log();
  console.log(bad === 0 ? `  ${G}all checks passed${R}\n` : `  ${Y}${bad} problem${bad > 1 ? 's' : ''} found${R}\n`);
  process.exit(bad === 0 ? 0 : 1);
}

// ── setu help ─────────────────────────────────────────────────────────────────

function cmdHelp() {
  console.log(`
  ${B}setu${R} — workspace bridge for quivly developers

  ${C}Setup${R}
    setu setup                       First-time onboarding (interactive)
    setu setup --name x [--yes]      Non-interactive (agents / scripts)
    setu doctor [--json]             Check every layer, print fixes

  ${C}Repos${R}
    setu init  <gh-slug>             Clone repo + create main worktree
    setu new   <repo> <branch>       Create worktree (auto port + domain)
    setu new   <repo> <branch> --tunnel   ...and take the public URL
    setu new   <repo> <branch> --start    ...and start its dev server (new worktree → containerized; see below)
    setu new   <repo> <branch> --start --bare   ...force a bare process instead (no memory/CPU cap)
    setu rm    <repo> <branch>       Remove worktree

  ${C}Day-to-day${R}
    setu cd    <repo> <branch>       cd into worktree
    setu ls    [repo] [--json]       List worktrees + status
    setu status                      Same as ls
    setu start <repo> <branch>       Start dev server — sticky per-worktree default: a worktree that has
                                      only ever run bare stays bare; one that's containerized before (or is
                                      brand new) defaults to a container (real memory/CPU cap; needs Docker/OrbStack)
    setu start <repo> <branch> --container   Force containerized, even on a worktree that's always been bare
    setu start <repo> <branch> --bare        Force bare, even on a worktree that's containerized before
    setu stop  <repo> <branch>       Stop dev server (via portal)
    setu prune [--force]             Find/kill dev servers running outside the registry
    setu fetch <repo>                git fetch --all
    setu tunnel <repo> <branch>      Point the public URL at this worktree
    setu tunnel <repo> <branch> stop      Release it
    setu trigger <repo> <branch>     Run trigger.dev dev (background, per worktree)
    setu trigger <repo> <branch> stop     Stop it

  ${C}Portal${R}
    setu portal                      Start web UI at http://quivly.local
    setu portal stop                 Stop portal

  ${C}Meta${R}
    setu update                      Update setu (stash-safe, shows changelog)
    setu version                     Show version + commit
    setu help                        Show this
`);
}
