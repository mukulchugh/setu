#!/usr/bin/env bun
// setu — workspace bridge: git worktrees, local domains, Cloudflare tunnels
// quivly internal tool — https://github.com/quivly/setu

import readline from 'readline';
import { execSync, execFileSync, spawnSync, spawn } from 'child_process';
import {
  existsSync, readFileSync, writeFileSync, appendFileSync,
  mkdirSync, readdirSync, statSync,
} from 'fs';
import { homedir } from 'os';
import { join, resolve } from 'path';

// ── config ────────────────────────────────────────────────────────────────────

const HOME     = homedir();
const CFG_PATH = join(HOME, '.setu.json');
const PKG_DIR  = new URL('.', import.meta.url).pathname; // setu package dir

function loadConfig() {
  try { return JSON.parse(readFileSync(CFG_PATH, 'utf8')); } catch { return {}; }
}

function cfg() {
  const c = loadConfig();
  if (!c.workspace) { die('Run `setu setup` first.'); }
  return c;
}

// ── ANSI ──────────────────────────────────────────────────────────────────────

const G  = '\x1b[32m';
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

// ── router ────────────────────────────────────────────────────────────────────

const [,, cmd, ...argv] = process.argv;

switch (cmd) {
  case 'setup':  await cmdSetup(); break;
  case 'new':    await cmdNew(argv); break;
  case 'rm':     await cmdRm(argv); break;
  case 'ls':     await cmdLs(argv); break;
  case 'init':   await cmdInit(argv); break;
  case 'status': await cmdStatus(); break;
  case 'portal': await cmdPortal(argv); break;
  case 'tunnel': await cmdTunnel(argv); break;
  case 'fetch':  await cmdFetch(argv); break;
  case 'path':   await cmdPath(argv); break;
  case 'update': await cmdUpdate(); break;
  default:       cmdHelp(); break;
}

// ── helpers ───────────────────────────────────────────────────────────────────

function resolvePath(p) {
  if (!p) return p;
  if (p.startsWith('~/')) return join(HOME, p.slice(2));
  if (p.startsWith('~'))  return join(HOME, p.slice(1));
  return resolve(p);
}

function cmdExists(c)    { return spawnSync('which', [c], { stdio: 'ignore' }).status === 0; }
function brewInstalled(p){ return spawnSync('brew', ['list', p], { stdio: 'ignore' }).status === 0; }

function brewInstall(pkg) {
  spin(pkg);
  if (brewInstalled(pkg)) { done(); return; }
  process.stdout.write('installing...  ');
  try { execSync(`brew install ${pkg}`, { stdio: ['ignore', 'pipe', 'pipe'] }); done(); }
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

// worktree helpers
function workspacePath(c, repo, name) {
  return join(c.workspace, repo, name);
}

function getPort(workspace, repo, name) {
  const portsFile = join(workspace, '.ports');
  if (!existsSync(portsFile)) return null;
  const line = readFileSync(portsFile, 'utf8')
    .split('\n').find(l => l.startsWith(`${repo}/${name}:`));
  return line ? parseInt(line.split(':')[1]) : null;
}

function assignPort(workspace, repo, name) {
  const portsFile  = join(workspace, '.ports');
  const projectsFile = join(workspace, '.projects');

  let existing = getPort(workspace, repo, name);
  if (existing) return existing;

  // base port from .projects
  let base = 3200;
  if (existsSync(projectsFile)) {
    const line = readFileSync(projectsFile, 'utf8')
      .split('\n').find(l => l.startsWith(`${repo}:`));
    if (line) base = parseInt(line.split(':')[1]);
  }

  // find next free port
  const usedPorts = existsSync(portsFile)
    ? readFileSync(portsFile, 'utf8').split('\n')
        .filter(Boolean).map(l => parseInt(l.split(':')[1]))
    : [];

  let port = base;
  while (usedPorts.includes(port)) port++;

  appendFileSync(portsFile, `${repo}/${name}:${port}\n`);
  return port;
}

function localDomain(repo, name) {
  const slug = name.replace(/\//g, '-');
  return name === 'main' ? `${repo}.quivly.local` : `${slug}.quivly.local`;
}

function publicDomain(c, repo, name) {
  const slug = name.replace(/\//g, '-');
  if (name === 'main') {
    return repo === 'quivly-app' ? c.domain : `${repo}.${c.domain}`;
  }
  return repo === 'quivly-app'
    ? `${slug}.${c.domain}`
    : `${slug}--${repo}.${c.domain}`;
}

function writeEnvrc(wtDir, port, appUrl, redirectUri) {
  writeFileSync(join(wtDir, '.envrc'),
    `export PORT=${port}\nexport NEXT_PUBLIC_APP_BASE_URL=${appUrl}\nexport NEXT_PUBLIC_WORKOS_REDIRECT_URI=${redirectUri}\n`);
  spawnSync('direnv', ['allow', wtDir], { stdio: 'ignore' });
}

function writeCaddy(workspace, repo, name, port, withTunnel, c) {
  const ld = localDomain(repo, name);
  const slug = name.replace(/\//g, '-');
  const snippet = withTunnel
    ? `http://${ld},\nhttp://${publicDomain(c, repo, name)} {\n  reverse_proxy localhost:${port}\n}\n`
    : `http://${ld} {\n  reverse_proxy localhost:${port}\n}\n`;
  writeFileSync(join(workspace, 'caddy.d', `${repo}-${slug}.caddy`), snippet);
}

function caddyReload(workspace) {
  try {
    execSync(`sudo caddy reload --config ${workspace}/Caddyfile 2>/dev/null`, { stdio: 'ignore' });
  } catch {
    console.warn(`  ${Y}⚠${R}  caddy reload failed — run manually`);
  }
}

// ── setu setup ────────────────────────────────────────────────────────────────

async function cmdSetup() {
  box('setu setup');

  // 1. deps
  step(1, 7, 'Dependencies');
  if (!cmdExists('brew')) die('Homebrew not found — install from https://brew.sh');
  ok('homebrew');
  if (!cmdExists('bun')) die('bun not found');
  ok('bun');
  for (const pkg of ['caddy', 'cloudflared', 'dnsmasq', 'direnv']) brewInstall(pkg);
  console.log();

  // 2. configure
  step(2, 7, 'Configuration');
  const existing = loadConfig();
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  let input;
  try {
    const nameDefault = existing.tunnel ? existing.tunnel.replace(/^dev-/, '') : '';
    const name = await ask(rl, 'Your name (e.g. "alice" → tunnel dev-alice)', nameDefault);
    if (!name) die('Name is required.');

    const wsRaw = await ask(rl, 'Workspace path', existing.workspace?.replace(HOME, '~') ?? '~/workspace');
    const workspace = resolvePath(wsRaw);

    const zoneDefault = existing.domain?.split('.').slice(1).join('.') ?? 'getquivly.ai';
    const zone = await ask(rl, 'Zone domain', zoneDefault);

    input = { name, workspace, zone, tunnel: `dev-${name}`, domain: `dev-${name}.${zone}` };
  } finally { rl.close(); }
  console.log();

  // 3. Cloudflare
  step(3, 7, 'Cloudflare tunnel');
  if (!existsSync(join(HOME, '.cloudflared', 'cert.pem'))) {
    process.stdout.write(`  ${GR}○${R} Logging in to Cloudflare...  `);
    execSync('cloudflared tunnel login', { stdio: 'inherit' });
    done();
  } else {
    ok('already authenticated');
  }

  spin(`tunnel ${input.tunnel}`);
  const listOut = execSync('cloudflared tunnel list', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  if (!listOut.split('\n').some(l => l.includes(` ${input.tunnel} `))) {
    execSync(`cloudflared tunnel create ${input.tunnel}`, { stdio: 'ignore' });
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
    execSync(`cloudflared tunnel route dns ${input.tunnel} '${input.domain}'`, { stdio: 'ignore' });
    execSync(`cloudflared tunnel route dns ${input.tunnel} '*.${input.domain}'`, { stdio: 'ignore' });
    done();
  } catch {
    process.stdout.write(`${G}✓${R} already configured\n`);
  }
  console.log();

  // 4. DNS & proxy
  step(4, 7, 'DNS & proxy');
  spin('dnsmasq');
  const dnsConf = '/opt/homebrew/etc/dnsmasq.conf';
  const dnsText = existsSync(dnsConf) ? readFileSync(dnsConf, 'utf8') : '';
  if (!dnsText.includes('address=/.quivly.local/127.0.0.1'))
    appendFileSync(dnsConf, '\naddress=/.quivly.local/127.0.0.1\n');
  execSync('brew services restart dnsmasq', { stdio: 'ignore' });
  done();

  spin('/etc/resolver/quivly.local');
  execSync('sudo mkdir -p /etc/resolver', { stdio: 'ignore' });
  execSync('echo "nameserver 127.0.0.1" | sudo tee /etc/resolver/quivly.local > /dev/null');
  done();

  spin('Caddyfile');
  mkdirSync(join(input.workspace, 'caddy.d'), { recursive: true });
  mkdirSync(join(input.workspace, 'logs'),    { recursive: true });
  const caddyfile = join(input.workspace, 'Caddyfile');
  if (!existsSync(caddyfile))
    writeFileSync(caddyfile, `{ auto_https off }\nimport ${input.workspace}/caddy.d/*.caddy\n`);
  done();
  console.log();

  // 5. /etc/hosts
  step(5, 7, '/etc/hosts');
  spin('127.0.0.1 quivly.local');
  const hosts = readFileSync('/etc/hosts', 'utf8');
  if (!hosts.includes('quivly.local'))
    execSync('echo "127.0.0.1  quivly.local" | sudo tee -a /etc/hosts > /dev/null');
  done();
  console.log();

  // 6. Passwordless sudo
  step(6, 7, 'Passwordless sudo');
  const user    = execSync('whoami', { encoding: 'utf8' }).trim();
  const caddyBin = '/opt/homebrew/bin/caddy';
  spin('caddy reload');
  const caddyRule = `${user} ALL=(ALL) NOPASSWD: ${caddyBin} reload --config ${input.workspace}/Caddyfile`;
  execSync(`echo "${caddyRule}" | sudo tee /etc/sudoers.d/caddy-setu-${user} > /dev/null`);
  execSync(`sudo chmod 440 /etc/sudoers.d/caddy-setu-${user}`, { stdio: 'ignore' });
  done();

  spin('/etc/hosts sync');
  const hostsRule = `${user} ALL=(ALL) NOPASSWD: /bin/cp /tmp/setu-hosts /etc/hosts`;
  execSync(`echo "${hostsRule}" | sudo tee /etc/sudoers.d/setu-hosts-${user} > /dev/null`);
  execSync(`sudo chmod 440 /etc/sudoers.d/setu-hosts-${user}`, { stdio: 'ignore' });
  done();
  console.log();

  // 7. config + shell
  step(7, 7, 'Shell & config');
  const finalCfg = { workspace: input.workspace, tunnel: input.tunnel, domain: input.domain, cfCredentials };
  spin('~/.setu.json');
  writeFileSync(CFG_PATH, JSON.stringify(finalCfg, null, 2) + '\n');
  done();

  // Minimal shell injection — just the cd shortcut
  spin('~/.zshrc');
  const zshrc = join(HOME, '.zshrc');
  const START = '# setu start';
  const END   = '# setu end';
  const block = `${START}\nwt() { cd "$(setu path "$1" "$2")"; }\n${END}`;
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

  box('All done!');
  console.log(`  ${G}1.${R} source ~/.zshrc`);
  console.log(`  ${G}2.${R} setu portal`);
  console.log(`  ${G}3.${R} open http://quivly.local`);
  console.log(`  ${G}4.${R} setu init quivly/quivly-app`);
  console.log();
  console.log(`  ${GR}run \`setu help\` for all commands${R}\n`);
}

// ── setu new <repo> <branch> [--tunnel] ──────────────────────────────────────

async function cmdNew([repo, name, ...flags]) {
  if (!repo || !name) die('Usage: setu new <repo> <branch> [--tunnel]');
  const c = cfg();
  const withTunnel = flags.includes('--tunnel');
  const workspace = c.workspace;
  const repoDir = join(workspace, `${repo}.git`);
  const wtDir   = join(workspace, repo, name);

  if (!existsSync(repoDir)) die(`Bare repo not found: ${repoDir}\nRun: setu init <gh-slug>`);

  execSync(`git -C ${repoDir} fetch --all --prune`, { stdio: 'ignore' });
  execSync(`git -C ${repoDir} worktree prune`, { stdio: 'ignore' });

  if (!existsSync(wtDir)) {
    const hasBranch =
      spawnSync('git', ['-C', repoDir, 'show-ref', '--verify', '--quiet', `refs/heads/${name}`]).status === 0 ||
      spawnSync('git', ['-C', repoDir, 'show-ref', '--verify', '--quiet', `refs/remotes/origin/${name}`]).status === 0;

    if (hasBranch) {
      execSync(`git -C ${repoDir} worktree add ${wtDir} ${name}`);
    } else {
      execSync(`git -C ${repoDir} worktree add ${wtDir} -b ${name} origin/staging`);
    }
  }

  const port = assignPort(workspace, repo, name);
  const ld   = localDomain(repo, name);
  const pd   = publicDomain(c, repo, name);

  if (withTunnel) {
    writeEnvrc(wtDir, port, `https://${pd}`, `https://${pd}/authentication/callback`);
  } else {
    writeEnvrc(wtDir, port, `http://${ld}`, `http://localhost:${port}/authentication/callback`);
  }

  // Symlink shared .env.local from main
  const mainEnv = repo === 'quivly-app'
    ? join(workspace, repo, 'main', 'apps', 'quivly-app', '.env.local')
    : join(workspace, repo, 'main', '.env.local');
  const wtEnv = repo === 'quivly-app'
    ? join(wtDir, 'apps', 'quivly-app', '.env.local')
    : join(wtDir, '.env.local');
  if (existsSync(mainEnv) && !existsSync(wtEnv)) {
    spawnSync('ln', ['-sf', mainEnv, wtEnv], { stdio: 'ignore' });
  }

  writeCaddy(workspace, repo, name, port, withTunnel, c);
  caddyReload(workspace);

  spawnSync('bun', ['install'], { cwd: wtDir, stdio: 'inherit' });

  console.log(`\n  ${G}✓${R} worktree  ${wtDir}`);
  console.log(`  ${G}✓${R} port      :${port}`);
  console.log(`  ${G}✓${R} local     http://${ld}`);
  if (withTunnel) console.log(`  ${G}✓${R} public    https://${pd}`);
  console.log();
}

// ── setu rm <repo> <branch> ───────────────────────────────────────────────────

async function cmdRm([repo, name]) {
  if (!repo || !name) die('Usage: setu rm <repo> <branch>');
  const c = cfg();
  const repoDir = join(c.workspace, `${repo}.git`);
  const wtDir   = join(c.workspace, repo, name);
  const slug    = name.replace(/\//g, '-');

  execSync(`git -C ${repoDir} worktree remove ${wtDir} --force`, { stdio: 'inherit' });

  const portsFile = join(c.workspace, '.ports');
  if (existsSync(portsFile)) {
    const lines = readFileSync(portsFile, 'utf8').split('\n')
      .filter(l => !l.startsWith(`${repo}/${name}:`));
    writeFileSync(portsFile, lines.join('\n'));
  }

  const caddy = join(c.workspace, 'caddy.d', `${repo}-${slug}.caddy`);
  if (existsSync(caddy)) { (await import('fs')).unlinkSync(caddy); }

  caddyReload(c.workspace);
  ok(`removed ${repo}/${name}`);
}

// ── setu ls [repo] ────────────────────────────────────────────────────────────

async function cmdLs([repo]) {
  const c = cfg();
  const portsFile = join(c.workspace, '.ports');
  if (!existsSync(portsFile)) { console.log('No worktrees yet.'); return; }

  const ports = readFileSync(portsFile, 'utf8').split('\n').filter(Boolean);
  for (const line of ports) {
    if (repo && !line.startsWith(`${repo}/`)) continue;
    const [key, port] = line.split(':');
    const pid = spawnSync('lsof', ['-i', `:${port}`, '-sTCP:LISTEN', '-t'], { stdio: ['ignore', 'pipe', 'ignore'] })
      .stdout?.toString().trim();
    const state = pid ? `${G}●${R} running` : `${GR}○${R} stopped`;
    console.log(`  ${state}  ${key}  :${port}`);
  }
}

// ── setu init <gh-slug> ───────────────────────────────────────────────────────

async function cmdInit([slug, label]) {
  if (!slug) die('Usage: setu init quivly/quivly-app [label]');
  const c = cfg();
  const repo    = slug.split('/').pop();
  const repoDir = join(c.workspace, `${repo}.git`);

  if (!existsSync(repoDir)) {
    console.log(`  Cloning ${slug}...`);
    execSync(`git clone --bare git@github.com:${slug}.git ${repoDir}`, { stdio: 'inherit' });
    execSync(`git -C ${repoDir} config remote.origin.fetch '+refs/heads/*:refs/remotes/origin/*'`);
    execSync(`git -C ${repoDir} fetch --all --prune`, { stdio: 'ignore' });
  }

  // Register in .projects
  const projectsFile = join(c.workspace, '.projects');
  const projectsText = existsSync(projectsFile) ? readFileSync(projectsFile, 'utf8') : '';
  if (!projectsText.includes(`${repo}:`)) {
    let base = 3000;
    const taken = projectsText.split('\n').filter(Boolean)
      .map(l => parseInt(l.split(':')[1])).filter(n => !isNaN(n));
    while (taken.includes(base)) base += 100;
    appendFileSync(projectsFile, `${repo}:${base}:${slug}:${label ?? repo}\n`);
  }

  await cmdNew([repo, 'main']);
}

// ── setu status ───────────────────────────────────────────────────────────────

async function cmdStatus() {
  await cmdLs([]);
}

// ── setu portal [stop] ────────────────────────────────────────────────────────

async function cmdPortal([action]) {
  const c = cfg();
  const pid = spawnSync('lsof', ['-i', ':2999', '-sTCP:LISTEN', '-t'],
    { stdio: ['ignore', 'pipe', 'ignore'] }).stdout?.toString().trim();

  if (action === 'stop') {
    if (pid) { execSync(`kill ${pid}`); ok('Portal stopped'); }
    else console.log('Portal not running.');
    return;
  }

  if (pid) {
    console.log(`Portal already running (pid ${pid}) → http://quivly.local`);
    return;
  }

  const portalJs = join(PKG_DIR, 'portal.js');
  if (!existsSync(portalJs)) die(`portal.js not found at ${portalJs}`);

  const child = spawn('bun', ['run', portalJs], {
    detached: true,
    stdio: ['ignore', 'ignore', 'ignore'],
    env: { ...process.env, HOME },
  });
  child.unref();

  caddyReload(c.workspace);
  ok('Portal → http://quivly.local');
}

// ── setu tunnel <repo> <branch> ───────────────────────────────────────────────

async function cmdTunnel([repo, name]) {
  if (!repo || !name) die('Usage: setu tunnel <repo> <branch>');
  const c    = cfg();
  const port = getPort(c.workspace, repo, name);
  if (!port) die(`No worktree for ${repo}/${name} — run: setu new ${repo} ${name}`);

  const ld = localDomain(repo, name);
  const pd = publicDomain(c, repo, name);

  writeEnvrc(join(c.workspace, repo, name), port,
    `https://${pd}`, `https://${pd}/authentication/callback`);
  writeCaddy(c.workspace, repo, name, port, true, c);
  caddyReload(c.workspace);
  ok(`Public → https://${pd}`);
}

// ── setu fetch <repo> ─────────────────────────────────────────────────────────

async function cmdFetch([repo]) {
  if (!repo) die('Usage: setu fetch <repo>');
  const c = cfg();
  execSync(`git -C ${join(c.workspace, `${repo}.git`)} fetch --all --prune`, { stdio: 'inherit' });
}

// ── setu path <repo> <branch> ────────────────────────────────────────────────
// Used by the `wt()` shell function to cd into a worktree

async function cmdPath([repo, name]) {
  if (!repo || !name) die('Usage: setu path <repo> <branch>');
  const c = cfg();
  process.stdout.write(join(c.workspace, repo, name) + '\n');
}

// ── setu update ───────────────────────────────────────────────────────────────

async function cmdUpdate() {
  console.log('Updating setu...');
  execSync('bun install -g github:quivly/setu', { stdio: 'inherit' });
  ok('setu updated');
}

// ── setu help ─────────────────────────────────────────────────────────────────

function cmdHelp() {
  console.log(`
  ${B}setu${R} — workspace bridge for quivly developers

  ${C}Setup${R}
    setu setup                       First-time onboarding

  ${C}Repos${R}
    setu init  <gh-slug>             Clone repo + create main worktree
    setu new   <repo> <branch>       Create worktree (auto port + domain)
    setu new   <repo> <branch> --tunnel   ...with Cloudflare tunnel
    setu rm    <repo> <branch>       Remove worktree

  ${C}Day-to-day${R}
    wt         <repo> <branch>       cd into worktree  ${GR}(shell alias)${R}
    setu ls    [repo]                List worktrees + status
    setu status                      Same as ls
    setu fetch <repo>                git fetch --all
    setu tunnel <repo> <branch>      Enable public tunnel on existing worktree

  ${C}Portal${R}
    setu portal                      Start web UI at http://quivly.local
    setu portal stop                 Stop portal

  ${C}Meta${R}
    setu update                      Update setu to latest
    setu help                        Show this
`);
}
