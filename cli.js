#!/usr/bin/env bun

// setu — workspace bridge: git worktrees, local domains, Cloudflare tunnels
// quivly internal tool — https://github.com/mukulchugh/setu

import { execFileSync, spawn, spawnSync } from 'node:child_process';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import readline from 'node:readline';
import {
  activePid,
  BREW_PREFIX,
  CADDY_BIN,
  CFG_PATH,
  CLOUDFLARED_BIN,
  commandExists,
  composeProjectName,
  containerRuntimeAvailable,
  createWorktree,
  discoverRepos,
  dockerComposePath,
  effectiveContainerLimits,
  engineCapacity,
  getPort,
  git,
  HOME,
  HOSTS_START,
  HOSTS_TMP,
  importRepo,
  installedStateValue,
  listActivePorts,
  loadConfig,
  loadProjects,
  localDomain,
  PORTAL_PORT,
  portalPid,
  portalRequest,
  portEntries,
  processCwd,
  publicDomain,
  reloadCaddy,
  requireConfig,
  SETU_DIR,
  saveConfig,
  spawnText,
  syncHosts,
  tunnelCredentials,
  tunnelEnabled,
  workspaceState,
} from './lib.js';
import {
  requestPortalMutation,
  requestRemoval,
  runRemoveCommand,
} from './remove-command.js';
import { runTriggerCommand } from './trigger-command.js';
import { createUpdateCommand, describeUpdate } from './update-command.js';
import { dependencySharingForTarget } from './dependency-sharing.js';
import {
  createAndInstallWorktree,
  installWorktreeDependencies,
} from './workspace-setup.js';

const PKG_DIR = new URL('.', import.meta.url).pathname;
const MCP_URL = `http://localhost:${PORTAL_PORT}/mcp`;

function cfg() {
  try {
    return requireConfig();
  } catch (e) {
    die(e.message);
  }
}

// ── ANSI ──────────────────────────────────────────────────────────────────────

// Truecolor, not the standard ANSI green — matches the exact brand forest
// green used everywhere else (portal accent, Raycast icon: #085041), so
// setup's checkmarks read as the same brand rather than a generic terminal
// color. Falls back gracefully: any terminal without 24-bit color support
// just ignores the unrecognized SGR and shows default-color text.
const G = '\x1b[38;2;8;80;65m';
const GR = '\x1b[90m';
const B = '\x1b[1m';
const Y = '\x1b[33m';
const R = '\x1b[0m';
const C = '\x1b[36m';

function box(text) {
  const pad = 38;
  process.stdout.write(`\n${C}╭${'─'.repeat(pad)}╮${R}\n`);
  process.stdout.write(`${C}│${R}  ${B}${text.padEnd(pad - 2)}${R}${C}│${R}\n`);
  process.stdout.write(`${C}╰${'─'.repeat(pad)}╯${R}\n\n`);
}

function ok(label) {
  console.log(`  ${G}✓${R} ${label}`);
}
function fail(label) {
  process.stdout.write(`${Y}✗ ${label}${R}\n`);
}
function die(msg) {
  console.error(`${Y}error:${R} ${msg}`);
  process.exit(1);
}

function spin(label) {
  process.stdout.write(`  ${GR}○${R} ${label}...  `);
}
function done() {
  process.stdout.write(`${G}✓${R}\n`);
}

function step(n, total, label) {
  console.log(`${B}[${n}/${total}] ${label}${R}`);
}

// ── args ──────────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const args = [],
    flags = {};
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        flags[key] = next;
        i += 1;
      } else {
        flags[key] = true;
      }
    } else {
      args.push(a);
    }
  }
  return { args, flags };
}

// ── router ────────────────────────────────────────────────────────────────────

const [, , cmdRaw, ...rest] = process.argv;
const cmd = { '--version': 'version', '-v': 'version' }[cmdRaw] ?? cmdRaw;
const { args, flags } = parseArgs(rest);
const asJson = !!flags.json;

// Passive staleness nudge — never on `path`/`cd` (the shell wrapper consumes stdout) or meta commands.
// Removal and Trigger must reach the portal before causing local side effects.
if (
  ![
    'rm',
    'trigger',
    'path',
    'cd',
    'update',
    'setup',
    'version',
    'help',
    undefined,
  ].includes(cmd)
) {
  await updateNudge();
}

switch (cmd) {
  case 'setup':
    await cmdSetup();
    break;
  case 'new':
    await cmdNew();
    break;
  case 'rm':
    await cmdRm();
    break;
  case 'ls':
    await cmdLs();
    break;
  case 'init':
    await cmdInit();
    break;
  case 'sweep':
    await cmdSweep();
    break;
  case 'status':
    await cmdLs();
    break;
  case 'start':
    await cmdStart();
    break;
  case 'stop':
    await cmdStop();
    break;
  case 'prune':
    await cmdPrune();
    break;
  case 'portal':
    await cmdPortal();
    break;
  case 'mcp':
    await cmdMcp();
    break;
  case 'tunnel':
    await cmdTunnel();
    break;
  case 'sync':
    await cmdSync();
    break;
  case 'trigger':
    await cmdTrigger();
    break;
  case 'fetch':
    await cmdFetch();
    break;
  case 'path':
    await cmdPath();
    break;
  case 'cd':
    await cmdCd();
    break;
  case 'update':
    await cmdUpdate();
    break;
  case 'doctor':
    await cmdDoctor();
    break;
  case 'version':
    cmdVersion();
    break;
  default:
    cmdHelp();
    break;
}

// ── helpers ───────────────────────────────────────────────────────────────────

function resolvePath(p) {
  if (!p) {
    return p;
  }
  if (p.startsWith('~/')) {
    return join(HOME, p.slice(2));
  }
  if (p.startsWith('~')) {
    return join(HOME, p.slice(1));
  }
  return resolve(p);
}

function brewInstalled(p) {
  return spawnSync('brew', ['list', p], { stdio: 'ignore' }).status === 0;
}

function brewInstall(pkg) {
  spin(pkg);
  if (brewInstalled(pkg)) {
    done();
    return;
  }
  process.stdout.write('installing...  ');
  try {
    execFileSync('brew', ['install', pkg], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    done();
  } catch {
    fail(`failed — run: brew install ${pkg}`);
    process.exit(1);
  }
}

function ask(rl, question, defaultVal) {
  return new Promise((res) => {
    const prompt = defaultVal
      ? `  ${C}?${R} ${question} [${GR}${defaultVal}${R}]:  `
      : `  ${C}?${R} ${question}:  `;
    rl.question(prompt, (answer) => res(answer.trim() || defaultVal || ''));
  });
}

function sudoTee(content, dest, mode) {
  execFileSync('sudo', ['tee', dest], {
    input: content,
    stdio: ['pipe', 'ignore', 'inherit'],
  });
  if (mode) {
    execFileSync('sudo', ['chmod', mode, dest], { stdio: 'ignore' });
  }
}

// Collapses the `.catch(e => ({ok:false,error:String(e)}))` -> `if (!res.ok)
// die(...)` pattern repeated across most portalRequest call sites below.
// Not every call site wants this: some warn and continue instead of dying,
// so those stay on portalRequest directly.
async function portalCall(path, body, failMsg) {
  const res = await portalRequest(path, body).catch((e) => ({
    error: String(e),
    ok: false,
  }));
  if (!res.ok) {
    die(res.error ?? failMsg);
  }
  return res;
}

async function ensurePortal(c) {
  return workspaceState(c.workspace).withUpdate(async () => {
    if (portalPid()) {
      return;
    }
    const portalJs = join(PKG_DIR, 'portal.js');
    if (!existsSync(portalJs)) {
      throw new Error(`portal.js not found at ${portalJs}`);
    }
    // The updater holds this same scope until its source/dependency cutover settles.
    const child = spawn('bun', ['run', portalJs], {
      cwd: PKG_DIR,
      detached: true,
      env: { ...process.env, HOME },
      stdio: ['ignore', 'ignore', 'ignore'],
    });
    child.unref();
    for (let i = 0; i < 40; i += 1) {
      try {
        await portalRequest('/api/worktrees');
        return;
      } catch {
        // Startup readiness is checked again until the bounded deadline.
      }
      await new Promise((r) => setTimeout(r, 200));
    }
    throw new Error(`portal did not come up on :${PORTAL_PORT}`);
  });
}

function autoInstall(wtDir, sharing) {
  return installWorktreeDependencies(wtDir, {
    exists: existsSync,
    run: spawnSync,
    sharing,
  });
}

// ── setu setup [--name x] [--workspace p] [--zone z] [--yes] ─────────────────

async function cmdSetup() {
  box('setu setup');
  const interactive = process.stdin.isTTY && !flags.yes;

  // 1. deps
  step(1, 9, 'Dependencies');
  if (!commandExists('brew')) {
    spin('Homebrew');
    try {
      // The exact one-liner brew.sh itself publishes — `bash -c` parses its
      // own argument as a real command line, so the $(...) inside undergoes
      // command substitution the same way it would typed at a prompt.
      execFileSync(
        '/bin/bash',
        [
          '-c',
          '$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)',
        ],
        { stdio: 'inherit' }
      );
      done();
    } catch {
      die(
        'Homebrew install failed — install manually from https://brew.sh, then re-run setu setup.'
      );
    }
    // BREW_PREFIX/CADDY_BIN/CLOUDFLARED_BIN (lib.js) are computed once at
    // module load, before this function ever runs — with brew missing at
    // that point they're already frozen to a fallback that's wrong on Intel
    // Macs (and merely stale, not re-verified, on Apple Silicon). Patching
    // process.env.PATH here would fix `brew`/`gh` lookups for the rest of
    // this process but not those already-baked constants — cleanest correct
    // fix is a fresh process, not a partial in-place patch.
    console.log(
      `\n  ${G}✓${R} Homebrew installed. Re-run this exact command to continue:\n`
    );
    console.log(`  ${GR}${['setu', 'setup', ...rest].join(' ')}${R}\n`);
    process.exit(0);
  }
  ok('homebrew');
  if (!commandExists('bun')) {
    die('bun not found');
  }
  ok('bun');
  for (const pkg of ['caddy', 'cloudflared', 'dnsmasq', 'direnv', 'gh']) {
    brewInstall(pkg);
  }
  if (spawnSync('gh', ['auth', 'status'], { stdio: 'ignore' }).status === 0) {
    ok('gh authenticated');
  } else {
    console.log(`  ${GR}○${R} gh not authenticated — logging in...`);
    try {
      execFileSync('gh', ['auth', 'login'], { stdio: 'inherit' });
      ok('gh authenticated');
    } catch {
      fail('gh auth failed — run manually: gh auth login');
    }
  }
  console.log();

  // 2. container engine — `setu start` containerizes by default (real
  // memory/CPU caps); `setu start --bare` works with no engine at all, so
  // this is offered, never a hard requirement. OrbStack and Docker Desktop
  // both need one manual app launch to finish first-run setup (accept
  // terms, grant a network-extension permission) — confirmed via `brew info
  // --cask orbstack`'s own Caveats ("Open the OrbStack app to finish
  // setup"), not assumed, so this doesn't pretend to fully automate those
  // two. Colima is the only genuinely headless option (brew services, no
  // GUI at all) — what a non-interactive `--yes` run defaults to absent an
  // explicit --engine flag.
  step(2, 9, 'Container engine');
  const rt = containerRuntimeAvailable();
  if (rt.available) {
    ok(`${rt.engine} already running`);
  } else {
    let engine = (flags.engine ?? '').toLowerCase();
    if (interactive && !engine) {
      const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
      });
      console.log(
        '  No container engine detected. setu start containerizes by default —'
      );
      console.log(
        `  setu start --bare skips this entirely if you'd rather not install one.`
      );
      console.log(
        `  ${GR}1${R}) OrbStack (recommended, lightweight)   ${GR}2${R}) Docker Desktop   ${GR}3${R}) Colima (CLI-only, no GUI)   ${GR}4${R}) Skip`
      );
      try {
        let choice = '';
        while (
          ![
            '1',
            '2',
            '3',
            '4',
            'orbstack',
            'docker',
            'colima',
            'skip',
          ].includes(choice)
        ) {
          choice = (await ask(rl, 'Choice', '1')).toLowerCase();
        }
        engine =
          { 1: 'orbstack', 2: 'docker', 3: 'colima', 4: 'skip' }[choice] ??
          choice;
      } finally {
        rl.close();
      }
    } else if (!engine) {
      engine = 'colima'; // non-interactive default — the only fully headless option
    }

    if (engine === 'skip') {
      console.log(
        `  ${GR}○${R} skipped — use \`setu start --bare\` until an engine is set up`
      );
    } else if (engine === 'colima') {
      spin('colima');
      try {
        execFileSync('brew', ['install', 'colima', 'docker'], {
          stdio: 'ignore',
        });
        execFileSync('brew', ['services', 'start', 'colima'], {
          stdio: 'ignore',
        });
        done();
      } catch {
        fail(
          'colima install/start failed — run manually: brew install colima docker && brew services start colima'
        );
      }
    } else if (engine === 'orbstack' || engine === 'docker') {
      const cask = engine === 'orbstack' ? 'orbstack' : 'docker-desktop';
      const appName = engine === 'orbstack' ? 'OrbStack' : 'Docker';
      spin(cask);
      try {
        execFileSync('brew', ['install', '--cask', cask], { stdio: 'ignore' });
        execFileSync('open', ['-a', appName], { stdio: 'ignore' });
        done();
        console.log(
          `  ${GR}○${R} ${appName} needs one manual first launch to finish setup — it should now be opening. Run \`setu doctor\` after to confirm.`
        );
      } catch {
        fail(
          `${appName} install failed — run manually: brew install --cask ${cask}`
        );
      }
    } else {
      fail(
        `unknown engine '${engine}' — pass --engine orbstack|docker|colima|skip`
      );
    }
  }
  console.log();

  // 3. configure — flags first, prompts only for what's missing (agents pass flags)
  step(3, 9, 'Configuration');
  const existing = loadConfig();
  let name =
    flags.name ?? (existing.tunnel ? existing.tunnel.replace(/^dev-/, '') : '');
  let workspace = resolvePath(
    flags.workspace ?? existing.workspace ?? join(HOME, 'workspace')
  );
  let zone =
    flags.zone ??
    existing.domain?.split('.').slice(1).join('.') ??
    'getquivly.ai';

  if (interactive) {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    try {
      name = await ask(rl, 'Your name (e.g. "alice" → tunnel dev-alice)', name);
      workspace = resolvePath(
        await ask(rl, 'Workspace path', workspace.replace(HOME, '~'))
      );
      zone = await ask(rl, 'Zone domain', zone);
    } finally {
      rl.close();
    }
  }
  if (!name) {
    die(
      'Name is required — pass --name <you> (non-interactive) or run in a terminal.'
    );
  }
  const input = {
    domain: `dev-${name}.${zone}`,
    name,
    tunnel: `dev-${name}`,
    workspace,
    zone,
  };
  ok(`${input.tunnel} → ${input.domain}, workspace ${workspace}`);
  console.log();

  // 3. Cloudflare
  step(4, 9, 'Cloudflare tunnel');
  if (existsSync(join(HOME, '.cloudflared', 'cert.pem'))) {
    ok('already authenticated');
  } else {
    process.stdout.write(`  ${GR}○${R} Logging in to Cloudflare...  `);
    execFileSync(CLOUDFLARED_BIN, ['tunnel', 'login'], { stdio: 'inherit' });
    done();
  }

  spin(`tunnel ${input.tunnel}`);
  const findTunnel = () =>
    JSON.parse(
      execFileSync(
        CLOUDFLARED_BIN,
        ['tunnel', 'list', '--output', 'json', '--name', input.tunnel],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }
      )
    ).filter((t) => t.name === input.tunnel);
  let tunnels = findTunnel();
  if (!tunnels.length) {
    execFileSync(CLOUDFLARED_BIN, ['tunnel', 'create', input.tunnel], {
      stdio: 'inherit',
    });
    tunnels = findTunnel();
  }
  const cfCredentials = tunnelCredentials(
    join(HOME, '.cloudflared'),
    input.tunnel,
    tunnels
  );
  done();

  spin(`DNS *.${input.domain}`);
  // Cloudflared reports an existing matching route as success itself.
  // Authentication, permission, and conflicting-route errors must stay errors.
  for (const domain of [input.domain, `*.${input.domain}`]) {
    execFileSync(
      CLOUDFLARED_BIN,
      ['tunnel', 'route', 'dns', input.tunnel, domain],
      { stdio: 'inherit' }
    );
  }
  done();
  console.log();

  // 4. DNS & proxy
  step(5, 9, 'DNS & proxy');
  spin('dnsmasq');
  const dnsConf = join(BREW_PREFIX, 'etc', 'dnsmasq.conf');
  const dnsText = existsSync(dnsConf) ? readFileSync(dnsConf, 'utf8') : '';
  if (!dnsText.includes('address=/.quivly.local/127.0.0.1')) {
    appendFileSync(dnsConf, '\naddress=/.quivly.local/127.0.0.1\n');
  }
  // port 53 needs root — a user-level dnsmasq service silently fails to bind
  try {
    execFileSync('sudo', ['brew', 'services', 'restart', 'dnsmasq'], {
      stdio: ['inherit', 'ignore', 'ignore'],
    });
    done();
  } catch {
    fail('failed — run: sudo brew services restart dnsmasq');
  }

  spin('/etc/resolver/quivly.local');
  execFileSync('sudo', ['mkdir', '-p', '/etc/resolver'], { stdio: 'ignore' });
  sudoTee('nameserver 127.0.0.1\n', '/etc/resolver/quivly.local');
  done();

  spin('Caddyfile');
  mkdirSync(join(input.workspace, 'caddy.d'), { recursive: true });
  mkdirSync(join(input.workspace, 'logs'), { recursive: true });
  const caddyfile = join(input.workspace, 'Caddyfile');
  await workspaceState(input.workspace).withRouting(async () => {
    if (!existsSync(caddyfile)) {
      installedStateValue(
        await workspaceState(input.workspace).replaceText(
          caddyfile,
          `{ auto_https off }\nimport ${input.workspace}/caddy.d/*.caddy\n`
        )
      );
    }
  });
  done();

  spin('caddy service');
  const services = execFileSync('brew', ['services', 'list'], {
    encoding: 'utf8',
  });
  if (/^caddy\s+started/m.test(services)) {
    process.stdout.write(`${G}✓${R} already running\n`);
  } else {
    try {
      execFileSync('brew', ['services', 'restart', 'caddy'], {
        stdio: 'ignore',
      });
      done();
    } catch {
      fail('failed — run: brew services restart caddy');
    }
  }
  console.log();

  // 5. Passwordless sudo — rules must match EXACTLY what lib.js runs
  step(6, 9, 'Passwordless sudo');
  const user = execFileSync('whoami', { encoding: 'utf8' }).trim();
  spin('caddy reload');
  const caddyRule = `${user} ALL=(ALL) NOPASSWD: ${CADDY_BIN} reload --config ${input.workspace}/Caddyfile`;
  sudoTee(`${caddyRule}\n`, `/etc/sudoers.d/caddy-setu-${user}`, '440');
  done();

  spin('/etc/hosts sync');
  const hostsRule = `${user} ALL=(ALL) NOPASSWD: /bin/cp ${HOSTS_TMP} /etc/hosts`;
  sudoTee(`${hostsRule}\n`, `/etc/sudoers.d/setu-hosts-${user}`, '440');
  done();
  console.log();

  // 6. config + shell
  step(7, 9, 'Shell & config');
  spin('~/.setu.json');
  installedStateValue(
    await saveConfig({
      cfCredentials,
      domain: input.domain,
      tunnel: input.tunnel,
      workspace: input.workspace,
    })
  );
  done();

  spin('~/.zshrc');
  const zshrc = join(HOME, '.zshrc');
  const START = '# setu start';
  const END = '# setu end';
  // a child process can't cd the parent shell — `setu cd` needs this wrapper
  const block = `${START}\nsetu() { if [ "$1" = "cd" ]; then cd "$(command setu path "$2" "$3")" || return; else command setu "$@"; fi; }\n${END}`;
  let current = '';
  try {
    current = readFileSync(zshrc, 'utf8');
  } catch {
    // Setup can create the shell configuration when no readable file exists.
  }
  if (current.includes(START)) {
    const si = current.indexOf(START),
      ei = current.indexOf(END);
    writeFileSync(
      zshrc,
      current.slice(0, si) +
        block +
        (ei === -1 ? '' : current.slice(ei + END.length))
    );
  } else {
    appendFileSync(zshrc, `\n${block}\n`);
  }
  done();
  console.log();

  // 7. first hosts sync
  step(8, 9, 'Verify');
  (await syncHosts(input.workspace))
    ? ok('/etc/hosts synced')
    : fail('/etc/hosts sync');
  console.log();

  // 8. Raycast extension — optional, skipped silently if Raycast isn't
  // installed. There's no headless way to register a local extension with
  // Raycast (it goes through the app's own Import/Develop flow), so this
  // only ever prints the one manual step rather than pretending to automate it.
  step(9, 9, 'Raycast extension');
  if (
    existsSync('/Applications/Raycast.app') ||
    existsSync('/Applications/Raycast Beta.app')
  ) {
    ok('Raycast detected');
    console.log(
      `  ${GR}run: cd ${SETU_DIR}/raycast && bun install && bunx ray develop${R}`
    );
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
  if (!(repo && name)) {
    die(
      'Usage: setu new <repo> <branch> [--tunnel] [--start] [--container|--bare] [--json]'
    );
  }
  const c = cfg();
  const withTunnel = !!flags.tunnel;

  let res;
  try {
    const sharing = dependencySharingForTarget(c, repo, name);
    res = await createAndInstallWorktree({
      create: (options) => createWorktree(c, repo, name, options),
      enableTunnel: async () => {
        await ensureTunnel(c, repo, name);
        return publicDomain(c);
      },
      install: (wtDir) => autoInstall(wtDir, sharing),
      name,
      repo,
      state: workspaceState(c.workspace),
      tunnel: withTunnel,
    });
  } catch (e) {
    die(e.message);
  }

  let started = false;
  if (flags.start) {
    await ensurePortal(c);
    const startBody = { name, repo };
    if (flags.container) {
      startBody.container = true;
    } else if (flags.bare) {
      startBody.container = false;
    }
    // Neither flag: a brand-new worktree has no prior history either way, so
    // the portal's sticky default naturally resolves to the intended global
    // default (container) here — same call shape as `setu start`, not a
    // special case.
    const startRes = await portalRequest('/api/start', startBody).catch(
      (e) => ({ error: String(e), ok: false })
    );
    started = !!startRes.ok;
    if (!started) {
      fail(`dev server start failed: ${startRes.error ?? 'unknown'}`);
    }
  }

  if (asJson) {
    console.log(JSON.stringify({ ...res, started }));
    return;
  }
  console.log(`\n  ${G}✓${R} worktree  ${res.wtDir}`);
  console.log(`  ${G}✓${R} port      :${res.port}`);
  console.log(`  ${G}✓${R} local     http://${res.localDom}`);
  if (withTunnel) {
    console.log(`  ${G}✓${R} public    https://${res.pubDom}`);
  }
  if (started) {
    console.log(`  ${G}✓${R} dev server started`);
  }
  console.log();
}

// ── setu rm <repo> <branch> ───────────────────────────────────────────────────

async function cmdRm() {
  const [repo, name] = args;
  const outcome = await runRemoveCommand(
    {
      force: flags.force ?? false,
      json: asJson,
      name,
      operationId: flags['operation-id'],
      repo,
    },
    {
      request: (body) =>
        requestRemoval(body, {
          url: `http://127.0.0.1:${PORTAL_PORT}/api/remove`,
        }),
      stderr: (text) => console.error(`error: ${text}`),
      stdout: asJson ? (text) => console.log(text) : ok,
    }
  );
  process.exitCode = outcome.exitCode;
}

// ── setu start / stop <repo> <branch> ─────────────────────────────────────────
// The portal already exposes /api/start and /api/stop — this is the CLI verb
// that was missing to reach them. Without it, `setu new` never started anything
// and the only way to start a worktree's dev server was clicking a button in the
// web UI, so real usage (agents included) bypassed the portal entirely by just
// `cd`-ing in and running `bun dev` directly — untracked, unbounded, duplicable.

async function cmdStart() {
  const [repo, name] = args;
  if (!(repo && name)) {
    die('Usage: setu start <repo> <branch> [--container|--bare]');
  }
  const c = cfg();
  if (!getPort(c.workspace, repo, name)) {
    die(`No worktree for ${repo}/${name} — run: setu new ${repo} ${name}`);
  }
  await ensurePortal(c);
  // --container/--bare force a mode explicitly. Neither flag omits `container`
  // entirely so the portal applies its sticky per-worktree default instead of
  // blindly forcing one — found live: a flat "container unless --bare" default
  // silently switched an established, always-bare worktree into a container
  // the moment it needed a restart with no explicit choice from anyone.
  const body = { name, repo };
  if (flags.container) {
    body.container = true;
  } else if (flags.bare) {
    body.container = false;
  }
  const res = await portalCall('/api/start', body, 'start failed');
  ok(
    `started ${repo}/${name}${res.queued ? ' (queued)' : res.container ? ' (containerized)' : ' (bare)'}`
  );
}

async function cmdStop() {
  const [repo, name] = args;
  if (!(repo && name)) {
    die('Usage: setu stop <repo> <branch>');
  }
  if (!portalPid()) {
    console.log('Portal not running — nothing to stop.');
    return;
  }
  await portalCall('/api/stop', { name, repo }, 'stop failed');
  ok(`stopped ${repo}/${name}`);
}

// ── setu prune [--force] ──────────────────────────────────────────────────────
// Finds dev-server processes that are listening but not in setu's own registry —
// the "orb" pattern found in production: a worktree fully running and consuming
// memory, invisible to `setu ls`/the portal because portEntries() only knows
// about what .ports already has. Dry-run by default; --force actually kills.

async function cmdPrune() {
  const c = cfg();
  const known = new Set(portEntries(c.workspace).map((e) => e.port));
  const active = listActivePorts();
  const orphans = active.filter((p) => !known.has(p.port));

  if (!orphans.length) {
    ok('nothing to prune');
    return;
  }

  console.log(
    `\n  ${Y}${orphans.length} unregistered process${orphans.length > 1 ? 'es' : ''} found:${R}\n`
  );
  for (const p of orphans) {
    console.log(`  ${GR}pid ${p.pid}${R}  :${p.port}  ${p.cmd}`);
  }
  console.log();

  if (!flags.force) {
    console.log(
      `  run with ${B}--force${R} to kill ${orphans.length > 1 ? 'them' : 'it'}\n`
    );
    return;
  }

  // Raw single-pid kill, not killGroup() (lib.js): these pids come from a
  // live lsof scan, not anything setu spawned, so there's no spawn record to
  // say whether the pid owns its own process group. killGroup would still
  // "work" (fall back to a single kill) if it doesn't, but blasting the group
  // on a pid we have zero attribution for risks killing an unrelated process
  // that just happens to share it (e.g. an interactive shell's foreground
  // job). A raw single-pid kill matches exactly what --force authorized.
  for (const p of orphans) {
    try {
      execFileSync('kill', [p.pid]);
      ok(`killed pid ${p.pid} (:${p.port})`);
    } catch (e) {
      fail(`pid ${p.pid}: ${e.message}`);
    }
  }
}

// ── setu ls [repo] [--json] ───────────────────────────────────────────────────

async function cmdLs() {
  const [repo] = args;
  const c = cfg();
  const entries = portEntries(c.workspace).filter(
    (e) => !repo || e.repo === repo
  );
  if (!entries.length) {
    asJson ? console.log('[]') : console.log('No worktrees yet.');
    return;
  }

  const rows = entries.map((e) => ({
    ...e,
    localDomain: localDomain(e.repo, e.name),
    running: !!activePid(e.port),
    tunnel: tunnelEnabled(join(c.workspace, e.repo, e.name), c),
    wtDir: join(c.workspace, e.repo, e.name),
  }));

  if (asJson) {
    console.log(JSON.stringify(rows, null, 2));
    return;
  }
  for (const r of rows) {
    const state = r.running ? `${G}●${R} running` : `${GR}○${R} stopped`;
    console.log(
      `  ${state}  ${r.key}  :${r.port}${r.tunnel ? `  ${C}⇄ ${publicDomain(c)}${R}` : ''}`
    );
  }
}

// ── setu init <gh-slug> [label] ───────────────────────────────────────────────

async function cmdInit() {
  const [slug, label] = args;
  if (!slug) {
    die('Usage: setu init quivly/quivly-app [label]');
  }
  const c = cfg();
  const repo = slug.split('/').pop();

  if (!existsSync(join(c.workspace, `${repo}.git`))) {
    console.log(`  Cloning ${slug}...`);
  }
  try {
    await importRepo(c, {
      label,
      name: repo,
      remoteUrl: `git@github.com:${slug}.git`,
    });
  } catch (e) {
    die(e.message);
  }

  args.length = 0;
  args.push(repo, 'main');
  await cmdNew();
}

// ── setu sweep [--import <name>] [--json] ─────────────────────────────────────
// Finds plain git clones already on disk that were never brought into Setu's
// bare-repo+worktree layout, and can bring one in on request. Read-only
// until --import is passed.

async function cmdSweep() {
  const c = cfg();
  // Not just cosmetic: a $HOME with old clones sitting on iCloud Drive can
  // take a while on a cold cache (each git call is capped, see
  // SWEEP_GIT_TIMEOUT_MS in lib.js, but a few dozen capped calls still add
  // up) — without this, a slow scan looks identical to a hung one.
  if (!asJson) {
    spin(`Scanning ${HOME} for git repos`);
  }
  const candidates = discoverRepos(HOME);
  if (!asJson) {
    done();
  }

  if (!flags.import) {
    if (asJson) {
      console.log(JSON.stringify(candidates, null, 2));
      return;
    }
    if (!candidates.length) {
      console.log(
        'Nothing to sweep in, everything found is already registered.'
      );
      return;
    }
    console.log();
    for (const cand of candidates) {
      const remote = cand.remoteUrl ?? 'no remote';
      const dirtyFlag = cand.dirty ? `${Y}dirty${R}` : `${GR}clean${R}`;
      const statusLabel =
        cand.status === 'importable'
          ? `${G}importable${R}`
          : cand.status === 'no-remote'
            ? `${GR}no remote${R}`
            : `${Y}conflict with ${cand.conflictWith}${R}`;
      console.log(`  ${B}${cand.name}${R}  ${GR}${cand.path}${R}`);
      console.log(`    ${remote}  ${dirtyFlag}  ${statusLabel}`);
    }
    console.log(
      `\n  ${candidates.length} candidate${candidates.length === 1 ? '' : 's'} found. Use --import <name> to bring one in.\n`
    );
    return;
  }

  const name = flags.import;
  const cand = candidates.find((x) => x.name === name);
  if (!cand) {
    die(
      `No sweep candidate named '${name}'. Run \`setu sweep\` to list candidates.`
    );
  }
  if (cand.status === 'conflict') {
    die(
      `'${name}' conflicts with already-registered project '${cand.conflictWith}'. Rename or resolve first.`
    );
  }
  if (cand.status === 'no-remote') {
    die(`'${name}' has no remote, nothing to clone from.`);
  }

  console.log(`  Importing ${name} from ${cand.remoteUrl}...`);
  try {
    await importRepo(c, {
      label: cand.name,
      name: cand.name,
      remoteUrl: cand.remoteUrl,
    });
  } catch (e) {
    die(e.message);
  }
  ok(`imported ${name} into ${c.workspace}/${name}.git, worktree main ready`);
}

// ── setu portal [stop] ────────────────────────────────────────────────────────

async function cmdPortal() {
  const [action] = args;
  const c = cfg();
  const pid = portalPid();

  if (action === 'stop') {
    if (pid) {
      execFileSync('kill', [pid]);
      ok('Portal stopped');
    } else {
      console.log('Portal not running.');
    }
    return;
  }

  if (pid) {
    console.log(`Portal already running (pid ${pid}) → http://quivly.local`);
    return;
  }

  await ensurePortal(c);
  await reloadCaddy(c.workspace);
  ok('Portal → http://quivly.local');
}

// ── setu mcp install <target> ─────────────────────────────────────────────────
// Setu's own MCP server (mcp-server.js) is mounted at /mcp on the portal
// regardless of which client connects to it -- this just registers that one
// URL with whichever client's own config file/format expects it. Claude Code
// isn't handled here: it already has a real installable plugin at
// claude-plugin/ (a marketplace-installable package, not a config-file edit),
// so that path is pointed at below rather than duplicated.

// TOML, confirmed against OpenAI's own config reference (developers.openai.com/codex/config-reference):
// mcp_servers.<id> with a bare `url` field selects Streamable HTTP -- no
// separate transport/type key needed, `command` is what would select stdio
// instead. Appended, not parsed+rewritten: a hand-rolled TOML parser risks
// mangling real config (model settings, other mcp_servers) for a one-block
// addition; a new top-level table appended at file end is valid TOML
// regardless of what's above it, and the regex guard below makes this safe
// to re-run without duplicating the block.
function mcpInstallCodex() {
  const dir = join(HOME, '.codex');
  const path = join(dir, 'config.toml');
  mkdirSync(dir, { recursive: true });
  const text = existsSync(path) ? readFileSync(path, 'utf8') : '';
  if (/^\[mcp_servers\.setu\]/m.test(text)) {
    ok(`Already configured in ${path}`);
    return;
  }
  writeFileSync(
    path,
    `${text.replace(/\n*$/, '\n')}\n[mcp_servers.setu]\nurl = "${MCP_URL}"\n`
  );
  ok(`Added Setu MCP server to ${path}`);
  console.log(
    `  Run ${B}codex${R}, then ${B}/mcp${R} to confirm it's connected.`
  );
}

// JSON, confirmed against Cursor's own docs (cursor.com/docs/context/mcp):
// mcpServers.<name> with a bare `url` field is enough for a remote server --
// no `type` key (that's stdio-only, per the same docs), unlike Claude Code's
// plugin schema which requires one. Real parse+merge here (not an append),
// since JSON.parse/stringify make it safe to preserve whatever else is
// already in this file, unlike the TOML case above.
function mcpInstallCursor() {
  const dir = join(HOME, '.cursor');
  const path = join(dir, 'mcp.json');
  mkdirSync(dir, { recursive: true });
  let conf = {};
  if (existsSync(path)) {
    try {
      conf = JSON.parse(readFileSync(path, 'utf8'));
    } catch (e) {
      die(`${path} has invalid JSON -- fix it manually first: ${e.message}`);
    }
  }
  conf.mcpServers ??= {};
  if (conf.mcpServers.setu) {
    ok(`Already configured in ${path}`);
    return;
  }
  conf.mcpServers.setu = { url: MCP_URL };
  writeFileSync(path, `${JSON.stringify(conf, null, 2)}\n`);
  ok(`Added Setu MCP server to ${path}`);
  console.log('  Restart Cursor (or reload its MCP servers) to pick it up.');
}

async function cmdMcp() {
  const [sub, target] = args;
  if (sub !== 'install' || !target) {
    die('Usage: setu mcp install <codex|cursor>');
  }
  if (target === 'codex') {
    return mcpInstallCodex();
  }
  if (target === 'cursor') {
    return mcpInstallCursor();
  }
  die(
    `Unknown target '${target}'. Supported: codex, cursor.\n` +
      `  Claude Code: claude --plugin-dir ${PKG_DIR}claude-plugin (already packaged, see claude-plugin/).\n` +
      `  Anything else with its own MCP client: point it at ${MCP_URL} (Streamable HTTP, no auth) in whatever config format it expects.`
  );
}

// ── setu tunnel <repo> <branch> [stop] ────────────────────────────────────────
// The portal owns the cloudflared process — the CLI just asks it.

async function ensureTunnel(c, repo, name) {
  await ensurePortal(c);
  await portalCall(
    '/api/tunnel/enable',
    { name, repo },
    'tunnel enable failed'
  );
}

async function cmdTunnel() {
  const [repo, name, action] = args;
  if (!(repo && name)) {
    die('Usage: setu tunnel <repo> <branch> [stop]');
  }
  const c = cfg();
  if (!getPort(c.workspace, repo, name)) {
    die(`No worktree for ${repo}/${name} — run: setu new ${repo} ${name}`);
  }

  if (action === 'stop') {
    if (!portalPid()) {
      console.log('Portal not running — tunnel already down.');
      return;
    }
    await portalCall(
      '/api/tunnel/disable',
      { name, repo },
      'tunnel disable failed'
    );
    ok(`tunnel disabled for ${repo}/${name}`);
    return;
  }

  await ensureTunnel(c, repo, name);
  ok(`Public → https://${publicDomain(c)}  (now pointing at ${repo}/${name})`);
}

// ── setu sync <repo> <branch> ─────────────────────────────────────────────────
// Merges the worktree's resolved base branch in via the portal (syncWithBase,
// lib.js) -- same action the web UI's "Sync with staging" button and the
// Raycast sync tool already call, just missing from the CLI until now.

async function cmdSync() {
  const [repo, name] = args;
  if (!(repo && name)) {
    die('Usage: setu sync <repo> <branch>');
  }
  const c = cfg();
  if (!getPort(c.workspace, repo, name)) {
    die(`No worktree for ${repo}/${name} — run: setu new ${repo} ${name}`);
  }
  await ensurePortal(c);
  const res = await portalCall('/api/sync', { name, repo }, 'sync failed');
  ok(`Synced ${repo}/${name} with ${res.base}`);
}

// ── setu trigger <repo> <branch> [stop] ──────────────────────────────────────
// The portal is the only lifecycle owner; PID files are never authority.
async function cmdTrigger() {
  const [repo, name, action] = args;
  const outcome = await runTriggerCommand(
    { action, json: asJson, name, repo },
    {
      request: (path, body) =>
        requestPortalMutation(body, {
          url: `http://127.0.0.1:${PORTAL_PORT}${path}`,
        }),
      stderr: (text) => console.error(`error: ${text}`),
      stdout: asJson ? (text) => console.log(text) : ok,
    }
  );
  process.exitCode = outcome.exitCode;
}

// ── setu fetch <repo> ─────────────────────────────────────────────────────────

async function cmdFetch() {
  const [repo] = args;
  if (!repo) {
    die('Usage: setu fetch <repo>');
  }
  const c = cfg();
  execFileSync(
    'git',
    ['-C', join(c.workspace, `${repo}.git`), 'fetch', '--all', '--prune'],
    { stdio: 'inherit' }
  );
}

// ── setu path <repo> <branch> ────────────────────────────────────────────────
// Used by the `wt()` shell function to cd into a worktree — stdout must stay clean.

async function cmdPath() {
  const [repo, name] = args;
  if (!(repo && name)) {
    die('Usage: setu path <repo> <branch>');
  }
  const c = cfg();
  const p = join(c.workspace, repo, name);
  if (!existsSync(p)) {
    die(`No worktree at ${p} — run: setu new ${repo} ${name}`);
  }
  process.stdout.write(`${p}\n`);
}

// ── setu cd <repo> <branch> ──────────────────────────────────────────────────
// Normally intercepted by the setu() shell function before reaching the binary.
// Reaching here means shell integration isn't loaded — still print the path so
// `cd "$(setu cd r b)"` works, and hint on stderr.

async function cmdCd() {
  await cmdPath();
  if (process.stdout.isTTY) {
    console.error(
      `${GR}shell integration not loaded — run: source ~/.zshrc${R}`
    );
  }
}

// ── setu update ───────────────────────────────────────────────────────────────

function setuGit(argv, opts = {}) {
  return execFileSync('git', ['-C', SETU_DIR, ...argv], {
    encoding: 'utf8',
    ...opts,
  });
}

async function cmdUpdate() {
  console.log('Updating setu...');
  const command = createUpdateCommand({
    configPath: CFG_PATH,
    portalUrl: `http://127.0.0.1:${PORTAL_PORT}`,
    repoDir: SETU_DIR,
  });
  try {
    const result = await command.update({
      includeUntracked: flags['include-untracked'] === true,
      restartAuthorized: flags.restart === true,
    });
    (result.ok ? console.log : console.error)(describeUpdate(result));
    if (!result.ok) {
      process.exitCode = 1;
    }
  } catch (error) {
    console.error(`Update refused: ${error.code || 'UPDATE_FAILED'}`);
    process.exitCode = 1;
  }
}

// Once a day: report staleness from the last fetch, then refresh refs in the
// background so tomorrow's check is current. Never blocks, never prompts.
async function updateNudge() {
  try {
    const c = loadConfig();
    if (!existsSync(join(SETU_DIR, '.git'))) {
      return;
    }
    if (Date.now() - (c.lastUpdateCheck ?? 0) < 24 * 60 * 60 * 1000) {
      return;
    }
    installedStateValue(await saveConfig({ lastUpdateCheck: Date.now() }));
    const behind = Number.parseInt(
      setuGit(['rev-list', '--count', 'HEAD..origin/main']).trim(),
      10
    );
    if (behind > 0) {
      console.error(
        `${GR}setu is ${behind} commit${behind > 1 ? 's' : ''} behind — run \`setu update\`${R}`
      );
    }
    const child = spawn('git', ['-C', SETU_DIR, 'fetch', 'origin', '--quiet'], {
      detached: true,
      stdio: 'ignore',
    });
    child.unref();
  } catch {
    // The optional update nudge must not prevent the requested command.
  }
}

// ── setu version ──────────────────────────────────────────────────────────────

function cmdVersion() {
  const pkg = JSON.parse(readFileSync(join(PKG_DIR, 'package.json'), 'utf8'));
  let sha = '';
  try {
    sha = setuGit(['rev-parse', '--short', 'HEAD']).trim();
  } catch {
    // Packaged installations may not contain Git metadata.
  }
  console.log(`setu ${pkg.version}${sha ? ` (${sha})` : ''}`);
}

// ── setu doctor [--json] ──────────────────────────────────────────────────────

// lib.js's spawnText() covers every check below except sudoOk, which needs
// the process exit code to tell "denied" from "allowed". spawnText() only
// returns stdout text, so this stays a thin local variant instead of forcing
// that shape onto every caller.
async function spawnTextCode(cmd, args) {
  try {
    const proc = Bun.spawn([cmd, ...args], {
      stderr: 'ignore',
      stdout: 'pipe',
    });
    const text = await new Response(proc.stdout).text();
    await proc.exited;
    return { code: proc.exitCode, text: text.trim() };
  } catch {
    return { code: 1, text: '' };
  }
}

// `docker ps -a --format '{{.Label "com.docker.compose.project"}}\t{{.State}}'`
// output -> project -> 'running' | 'dead'. A project can own more than one
// container; 'running' wins if any line for that project says so, otherwise
// it's 'dead' the moment a non-running line for it is seen. Pulled out of the
// dead-container doctor check below so that check itself stays simple enough
// to read in one pass.
function composeProjectStates(rawPsOutput) {
  const projectState = new Map();
  for (const line of rawPsOutput.trim().split('\n')) {
    const [project, state] = line.split('\t');
    if (!project) {
      continue;
    }
    if (state === 'running' || state === 'restarting') {
      projectState.set(project, 'running');
    } else if (!projectState.has(project)) {
      projectState.set(project, 'dead');
    }
  }
  return projectState;
}

async function cmdDoctor() {
  const c = loadConfig();
  const workspace = c.workspace ?? '';

  // Shared across multiple checks below — fetch once, not once per check.
  // Bun.spawn (via spawnText), not execFileSync/spawnSync: checks run
  // concurrently (Promise.all) instead of one after another; a blocking exec
  // call per check would serialize them on the event loop regardless of the
  // Promise.all wrapper.
  const [services, digText, caddyAdmin] = await Promise.all([
    spawnText(['brew', 'services', 'list']),
    spawnText([
      'dig',
      '+short',
      '+time=1',
      '+tries=1',
      'test.quivly.local',
      '@127.0.0.1',
    ]),
    fetch('http://localhost:2019/config/', {
      signal: AbortSignal.timeout(1500),
    })
      .then((r) => r.ok)
      .catch(() => false),
  ]);
  const dnsmasqLine =
    services.split('\n').find((l) => l.startsWith('dnsmasq')) ?? '';
  const sudoOk = async (argv) =>
    (await spawnTextCode('sudo', ['-n', '-l', ...argv])).code === 0;

  const checkThunks = [
    ...['caddy', 'cloudflared', 'dnsmasq', 'direnv'].map((pkg) => async () => ({
      fix: `brew install ${pkg}`,
      name: `brew: ${pkg}`,
      ok: brewInstalled(pkg),
    })),
    async () => ({
      fix: 'setu setup',
      name: 'config ~/.setu.json',
      ok: !!(c.workspace && c.domain && c.tunnel),
    }),
    // Optional, not in the brewInstall() hard-fail list above — createWorktree
    // already treats mise as best-effort (`mise trust ... 2>/dev/null`), so a
    // missing binary shouldn't block `setu setup`, just show up here.
    async () => ({
      fix: 'brew install mise',
      name: "mise (optional — auto-trusts a managed project's own mise config)",
      ok: commandExists('mise'),
    }),
    async () => ({
      fix: 'sudo brew services stop dnsmasq && sudo brew services restart dnsmasq',
      name: 'dnsmasq service',
      ok: /^dnsmasq\s+started/.test(dnsmasqLine) && !/error/.test(dnsmasqLine),
    }),
    async () => ({
      fix: 'sudo brew services restart dnsmasq (then re-check)',
      name: 'dnsmasq resolves *.quivly.local',
      ok: digText.includes('127.0.0.1'),
    }),
    async () => ({
      fix: 'setu setup',
      name: '/etc/resolver/quivly.local',
      ok: existsSync('/etc/resolver/quivly.local'),
    }),
    async () => ({
      fix: 'brew services restart caddy',
      name: 'caddy service',
      ok: /^caddy\s+started/m.test(services),
    }),
    async () => ({
      fix: 'brew services restart caddy',
      name: 'caddy admin API (:2019)',
      ok: caddyAdmin,
    }),
    // `setu start` containerizes by default now (real memory/CPU cap) — a
    // missing runtime isn't merely informational, it means plain `setu start`
    // will fail until either the engine is running or `--bare` is passed.
    // Reports whichever engine answered (OrbStack, Docker Desktop, Colima, …)
    // without requiring one specifically — see the containerization plan.
    async () => {
      const rt = containerRuntimeAvailable();
      return {
        fix: rt.available
          ? undefined
          : 'start OrbStack/Docker Desktop — or use `setu start --bare` until then',
        name: 'container runtime (setu start uses it by default)',
        ok: rt.available,
      };
    },
    async () => {
      const cap = engineCapacity();
      if (!(cap.memMb && cap.cpus)) {
        return {
          fix: 'Start the Docker engine to determine effective limits',
          name: 'container resource budget',
          ok: false,
        };
      }
      try {
        const limits = effectiveContainerLimits(c, cap);
        return {
          detail: `${limits.max} containers, ${limits.cpus} CPU and ${limits.memMb}MB each; engine capacity limits admission`,
          name: 'container resource budget',
          ok: limits.max > 0,
        };
      } catch (error) {
        return {
          fix: error.message,
          name: 'container resource budget',
          ok: false,
        };
      }
    },
    async () => ({
      fix: 'setu setup (rewrites /etc/sudoers.d/caddy-setu-*)',
      name: 'sudoers: caddy reload',
      ok:
        !!workspace &&
        (await sudoOk([
          CADDY_BIN,
          'reload',
          '--config',
          join(workspace, 'Caddyfile'),
        ])),
    }),
    async () => ({
      fix: 'setu setup (rewrites /etc/sudoers.d/setu-hosts-*)',
      name: 'sudoers: hosts sync',
      ok: await sudoOk(['/bin/cp', HOSTS_TMP, '/etc/hosts']),
    }),
    async () => ({
      fix: 'setu new <repo> <branch> (or any command that syncs hosts)',
      name: '/etc/hosts quivly block',
      ok: readFileSync('/etc/hosts', 'utf8').includes(HOSTS_START),
    }),
    async () => ({
      fix: 'cloudflared tunnel login',
      name: 'cloudflared cert',
      ok: existsSync(join(HOME, '.cloudflared', 'cert.pem')),
    }),
  ];

  if (c.tunnel) {
    checkThunks.push(async () => {
      const tl = await spawnText([CLOUDFLARED_BIN, 'tunnel', 'list']);
      return {
        fix: `cloudflared tunnel create ${c.tunnel}`,
        name: `tunnel ${c.tunnel} exists`,
        ok: tl.split('\n').some((l) => l.includes(` ${c.tunnel} `)),
      };
    });
  }

  // setu repo hygiene
  if (existsSync(join(SETU_DIR, '.git'))) {
    checkThunks.push(async () => ({
      fix: 'git -C ~/.setu status — commit or stash local edits',
      name: '~/.setu clean',
      ok: setuGit(['status', '--porcelain']).trim() === '',
    }));
    checkThunks.push(async () => {
      let behind = 0;
      try {
        behind = Number.parseInt(
          setuGit(['rev-list', '--count', 'HEAD..origin/main']).trim(),
          10
        );
      } catch {
        // Continue collecting the other independent diagnostic results.
      }
      return { fix: 'setu update', name: 'setu up to date', ok: behind === 0 };
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
    const active = listActivePorts();

    checkThunks.push(async () => {
      const known = new Set(entries.map((e) => e.port));
      const orphanProcs = active.filter((p) => !known.has(p.port));
      return {
        fix: orphanProcs.length
          ? `setu prune  (${orphanProcs.length} found: ${orphanProcs.map((p) => `pid ${p.pid} :${p.port}`).join(', ')})`
          : undefined,
        name: 'no unregistered dev-server processes',
        ok: orphanProcs.length === 0,
      };
    });

    checkThunks.push(async () => {
      const mismatches = [];
      for (const e of entries) {
        const p = active.find((a) => a.port === e.port);
        if (!p) {
          continue;
        }
        const cwd = processCwd(p.pid);
        const expected = resolve(join(workspace, e.repo, e.name));
        // Nx/monorepo dev servers end up with cwd nested inside apps/<app> —
        // only flag it if cwd isn't the worktree root or underneath it.
        if (
          cwd &&
          resolve(cwd) !== expected &&
          !resolve(cwd).startsWith(`${expected}/`)
        ) {
          mismatches.push(`${e.key} :${e.port} is actually serving ${cwd}`);
        }
      }
      return {
        fix: mismatches.join('; ') || undefined,
        name: 'registered ports match their worktree',
        ok: mismatches.length === 0,
      };
    });

    checkThunks.push(async () => {
      const registeredDirs = new Set(
        entries.map((e) => join(workspace, e.repo, e.name))
      );
      const gitWorktreeDirs = new Set();
      for (const repo of Object.keys(loadProjects(workspace))) {
        const repoDir = join(workspace, `${repo}.git`);
        if (!existsSync(repoDir)) {
          continue;
        }
        try {
          const porcelain = git(repoDir, ['worktree', 'list', '--porcelain']);
          for (const wt of porcelain.trim().split('\n\n')) {
            const p = wt.match(/^worktree (.+)$/m)?.[1];
            if (p && p !== repoDir && !p.includes('/.claude/worktrees/')) {
              gitWorktreeDirs.add(p);
            }
          }
        } catch {
          // This repository cannot contribute paths to the best-effort scan.
        }
      }
      const unregistered = [...gitWorktreeDirs].filter(
        (d) => !registeredDirs.has(d)
      );
      return {
        fix: unregistered.length
          ? `setu new for: ${unregistered.join(', ')}  (or setu rm if abandoned)`
          : undefined,
        name: 'all git worktrees are registered with setu',
        ok: unregistered.length === 0,
      };
    });

    // mirror case: registry entries for worktrees removed via raw `git worktree
    // remove` instead of `setu rm` — the port/domain registration outlives the
    // directory it pointed at.
    checkThunks.push(async () => {
      const stale = entries.filter(
        (e) => !existsSync(join(workspace, e.repo, e.name))
      );
      return {
        fix: stale.length
          ? `stale: ${stale.map((e) => e.key).join(', ')}  — releasePort() or setu rm each`
          : undefined,
        name: 'no registry entries for missing worktrees',
        ok: stale.length === 0,
      };
    });

    // A container Setu itself stops always goes through `compose down`
    // (composeDownAsync — confirmed the only teardown path: every stop
    // route, bare or containerized, funnels through stopWorktree, and its
    // container branch always calls stopContainer/composeDownAsync; cmdPrune
    // never touches a registered worktree's port, only unregistered orphans),
    // which REMOVES the container entirely — so any compose-project
    // container still *present* in `docker ps -a` but not running/
    // restarting can only have gotten that way some other way Setu didn't
    // do: an OOM kill, a dev process that crashed past its `restart:
    // on-failure` retry cap, or the container engine's own VM restarting
    // and taking every container down with it (seen live: an OrbStack
    // restart SIGKILLed a container mid-boot, and it sat there as
    // Exited(137) with nothing to surface it — reconcileDevServers only
    // adopts still-alive containers on portal boot, it never flags ones
    // that died silently). Container-mode-history worktrees only (a
    // compose file on disk); anything never containerized is skipped.
    //
    // One `docker ps -a` call for every project at once, not one `docker
    // compose ps` per worktree — keeps this check O(1) docker spawns
    // instead of O(worktrees), matching why every other check here uses
    // spawnText + Promise.all instead of execFileSync in the first place.
    // Compose stamps the `com.docker.compose.project` label on every
    // container it creates, so one pass over `docker ps -a` output already
    // has everything needed to bucket by project.
    checkThunks.push(async () => {
      const containerWorktrees = entries
        .filter((e) =>
          existsSync(dockerComposePath(join(workspace, e.repo, e.name)))
        )
        .map((e) => ({ ...e, project: composeProjectName(e.repo, e.name) }));
      if (!containerWorktrees.length) {
        return {
          name: 'no container-mode worktrees with a dead container',
          ok: true,
        };
      }

      const raw = await spawnText([
        'docker',
        'ps',
        '-a',
        '--format',
        '{{.Label "com.docker.compose.project"}}\t{{.State}}',
      ]);
      const projectState = composeProjectStates(raw);
      const dead = containerWorktrees
        .filter((e) => projectState.get(e.project) === 'dead')
        .map((e) => e.key);
      return {
        // `setu start` only fixes the "engine restarted underneath it" case —
        // a crash-looped app (e.g. exhausted `on-failure:3` on a real error)
        // will just fail again, so point at logs first rather than implying
        // a restart is the fix for both causes.
        fix: dead.length
          ? `dead container(s) setu didn't stop: ${dead.join(', ')}  — check \`docker logs <container>\` for why, then \`setu start\` once resolved`
          : undefined,
        name: 'no container-mode worktrees with a dead container',
        ok: dead.length === 0,
      };
    });
  }

  checkThunks.push(async () => ({
    fix: 'setu portal',
    name: 'portal (:2999)',
    ok: await portalRequest('/api/worktrees')
      .then(() => true)
      .catch(() => false),
  }));

  const checks = (await Promise.all(checkThunks.map((fn) => fn()))).map(
    (r) => ({ ...r, ok: !!r.ok })
  );

  if (asJson) {
    console.log(JSON.stringify(checks, null, 2));
    process.exit(checks.every((x) => x.ok) ? 0 : 1);
  }

  console.log();
  for (const x of checks) {
    if (x.ok) {
      ok(x.name);
    } else {
      console.log(`  ${Y}✗${R} ${x.name}  ${GR}→ ${x.fix}${R}`);
    }
  }
  const bad = checks.filter((x) => !x.ok).length;
  console.log();
  console.log(
    bad === 0
      ? `  ${G}all checks passed${R}\n`
      : `  ${Y}${bad} problem${bad > 1 ? 's' : ''} found${R}\n`
  );
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
    setu sweep                       Find plain git clones outside Setu, not yet registered
    setu sweep --import <name>       Bring one in (bare-clone + register + main worktree)
    setu new   <repo> <branch>       Create worktree (auto port + domain)
    setu new   <repo> <branch> --tunnel   ...and take the public URL
    setu new   <repo> <branch> --start    ...and start its dev server (new worktree → containerized; see below)
    setu new   <repo> <branch> --start --bare   ...force a bare process instead (no memory/CPU cap)
    setu rm    <repo> <branch>       Remove worktree through the running portal
      --operation-id <id>          Resume that pending removal only
      --json                       Print the complete result, including partial failure

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
    setu sync   <repo> <branch>      Merge the resolved base branch in (clean merges only —
                                      aborts and reports what would conflict, never leaves it mid-merge)
    setu trigger <repo> <branch>     Start Trigger through the running portal
    setu trigger <repo> <branch> stop     Stop Trigger through the running portal

  ${C}Portal${R}
    setu portal                      Start web UI at http://quivly.local
    setu portal stop                 Stop portal

  ${C}MCP — let an agent drive Setu directly${R}
    setu mcp install codex           Register Setu's MCP server in ~/.codex/config.toml
    setu mcp install cursor          Register Setu's MCP server in ~/.cursor/mcp.json
                                      Claude Code: claude --plugin-dir <setu>/claude-plugin (already packaged)

  ${C}Meta${R}
    setu update                      Update setu (stash-safe, shows changelog)
    setu version                     Show version + commit
    setu help                        Show this
`);
}
