#!/usr/bin/env bun

// setu — workspace bridge: git worktrees, local domains, Cloudflare tunnels
// quivly internal tool — https://github.com/mukulchugh/setu

import { execFileSync, spawn, spawnSync } from 'node:child_process';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import {
  readFile as readFileAsync,
  realpath as realpathAsync,
  stat as statAsync,
} from 'node:fs/promises';
import { join, resolve } from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { inspectCheckoutIdentity } from './checkout-identity.js';
import { createCliApi } from './cli-api.js';
import {
  caddyfileText,
  cursorConfigText,
  hasCodexServerTable,
  hasIdentifiableWorktreeCwd,
  hasPortalCaddyRoute,
  portalCaddyRoute,
  pruneCandidates,
  startOutcome,
  sudoRuleCovers,
  withSetuBlock,
} from './cli-helpers.js';
import { dependencySharingForTarget } from './dependency-sharing.js';
import { createHostHealth } from './host-health.js';
import {
  AGENT_CLIS,
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
  shellQuote,
  spawnText,
  syncHosts,
  tunnelCredentials,
  tunnelEnabled,
  workspaceState,
  writerClaimPaths,
} from './lib.js';
import { createOperationEvents } from './operation-events.js';
import {
  requestPortalMutation,
  requestRemoval,
  runRemoveCommand,
} from './remove-command.js';
import { createResourceAdmission } from './resource-admission.js';
import { createSetupProgress } from './setup-progress.js';
import { runTriggerCommand } from './trigger-command.js';
import { createUpdateCommand, describeUpdate } from './update-command.js';
import {
  createAndInstallWorktree,
  installWorktreeDependencies,
} from './workspace-setup.js';
import { releaseHeldLocks } from './workspace-state.js';

const PKG_DIR = fileURLToPath(new URL('.', import.meta.url));

const MCP_URL = `http://localhost:${PORTAL_PORT}/mcp`;

const DEV_TUNNEL_PREFIX_RE = /^dev-/;
const CADDY_SERVICE_STARTED_RE = /^caddy\s+started/m;
const HEADLESS_MODEL_RE = /^[a-zA-Z0-9._-]{1,128}$/;
const DNSMASQ_SERVICE_STARTED_RE = /^dnsmasq\s+started/;
const ERROR_RE = /error/;
const TRAILING_NEWLINES_RE = /\n*$/;
const WORKTREE_LIST_ENTRY_RE = /^worktree (.+)$/m;

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
  process.stderr.write(`${Y}✗ ${label}${R}\n`);
}
function die(msg) {
  console.error(`${Y}error:${R} ${msg}`);
  if (dispatching) {
    throw Object.assign(new Error(msg), { exitCode: 1 });
  }
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

export function parseArgs(argv) {
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

let args = [];
let flags = {};
let asJson = false;
let cliApi = createCliApi();
let cliReadFile = readFileSync;
let dispatching = false;
let newCommandOverrides = {};
let localCommandOverrides = {};
let lifecycleCommandOverrides = {};

export const commandHandlers = {
  actions: cmdActions,
  admission: cmdAdmission,
  adopt: cmdAdopt,
  attention: cmdAttention,
  caches: cmdCaches,
  cd: cmdCd,
  dependencies: cmdDependencies,
  diff: cmdDiff,
  doctor: cmdDoctor,
  fetch: cmdFetch,
  headless: cmdHeadless,
  help: cmdHelp,
  init: cmdInit,
  logs: cmdLogs,
  ls: cmdLs,
  mcp: cmdMcp,
  new: cmdNew,
  operations: cmdOperations,
  path: cmdPath,
  portal: cmdPortal,
  ports: cmdPorts,
  pr: cmdPr,
  prune: cmdPrune,
  review: cmdReview,
  rm: cmdRm,
  sessions: cmdSessions,
  setup: cmdSetup,
  'setup-progress': cmdSetupProgress,
  'shared-caches': cmdSharedCaches,
  start: cmdStart,
  status: cmdLs,
  stop: cmdStop,
  storage: cmdStorage,
  sweep: cmdSweep,
  sync: cmdSync,
  trigger: cmdTrigger,
  tunnel: cmdTunnel,
  update: cmdUpdate,
  version: cmdVersion,
  workflows: cmdWorkflows,
};

export async function runCli(
  argv = process.argv.slice(2),
  { lifecycleCommand, localCommand, newCommand, request, readFile } = {}
) {
  const previousApi = cliApi;
  const previousReadFile = cliReadFile;
  const previousDispatching = dispatching;
  const previousNewCommandOverrides = newCommandOverrides;
  const previousLocalCommandOverrides = localCommandOverrides;
  const previousLifecycleCommandOverrides = lifecycleCommandOverrides;
  const injectedRequest =
    typeof request === 'function' ||
    !!lifecycleCommand ||
    !!newCommand ||
    !!localCommand;
  if (request) {
    cliApi = createCliApi({ request });
  }
  if (readFile) {
    cliReadFile = readFile;
  }
  if (newCommand) {
    newCommandOverrides = newCommand;
  }
  if (localCommand) {
    localCommandOverrides = localCommand;
  }
  if (lifecycleCommand) {
    lifecycleCommandOverrides = lifecycleCommand;
  }
  dispatching = true;
  try {
    process.exitCode = 0;
    const [cmdRaw, ...rest] = argv;
    const cmd = { '--version': 'version', '-v': 'version' }[cmdRaw] ?? cmdRaw;
    ({ args, flags } = parseArgs(rest));
    asJson = !!flags.json;

    // Writer claims intentionally bypass the update nudge.
    if (['claim', 'release', 'claims', 'claim-check'].includes(cmd)) {
      const { runWriterCommand } = await import('./writer-claims-cli.js');
      process.exitCode = await runWriterCommand(cmd, rest);
      return process.exitCode;
    }

    const handler = commandHandlers[cmd];
    if (!handler) {
      if (cmd === undefined) {
        cmdHelp();
        return 0;
      }
      console.error(`${Y}error:${R} Unknown command '${cmd}'. Run: setu help`);
      process.exitCode = 1;
      return 1;
    }

    if (
      !(
        injectedRequest ||
        [
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
      )
    ) {
      await updateNudge();
    }
    await (cmd === 'setup' ? handler(rest) : handler());
    return process.exitCode ?? 0;
  } catch (error) {
    // biome-ignore lint/suspicious/noUnnecessaryConditions: Command handlers may reject non-Error or nullish values.
    if (error?.exitCode === 1) {
      process.exitCode = 1;
      return 1;
    }
    throw error;
  } finally {
    cliApi = previousApi;
    cliReadFile = previousReadFile;
    newCommandOverrides = previousNewCommandOverrides;
    localCommandOverrides = previousLocalCommandOverrides;
    lifecycleCommandOverrides = previousLifecycleCommandOverrides;
    dispatching = previousDispatching;
  }
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

function writeAtomic(path, text) {
  const temp = `${path}.${process.pid}.tmp`;
  writeFileSync(temp, text);
  renameSync(temp, path);
}

// Collapses the `.catch(e => ({ok:false,error:String(e)}))` -> `if (!res.ok)
// die(...)` pattern repeated across most portalRequest call sites below.
// Not every call site wants this: some warn and continue instead of dying,
// so those stay on portalRequest directly.
async function portalCall(path, body, failMsg) {
  const res = await (body === undefined
    ? cliApi.get(path)
    : cliApi.post(path, body)
  ).catch((e) => ({
    error: String(e),
    ok: false,
  }));
  if (!res.ok) {
    die(res.error ?? failMsg);
  }
  return res;
}

// biome-ignore lint/suspicious/useAwait: Portal and tunnel callers await this boundary; synchronous startup failures must reject.
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
        // biome-ignore lint/performance/noAwaitInLoops: A readiness probe must fail before the next retry delay and probe.
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

function autoInstall(wtDir, sharing, stdio, options = {}) {
  return installWorktreeDependencies(wtDir, {
    exists: existsSync,
    run: spawnSync,
    sharing,
    ...(stdio ? { stdio } : {}),
    ...options,
  });
}

// ── setu setup [--name x] [--workspace p] [--zone z] [--yes] ─────────────────

async function cmdSetup(setupArgs) {
  box('setu setup');
  const interactive = process.stdin.isTTY && !flags.yes;

  function setupDependencies() {
    // 1. deps
    step(1, 9, 'Dependencies');
    if (!commandExists('brew')) {
      spin('Homebrew');
      try {
        const installer = execFileSync(
          'curl',
          [
            '-fsSL',
            'https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh',
          ],
          { encoding: 'utf8' }
        );
        // As the published one-liner does: the script is bash's -c argument, so
        // stdin stays the terminal and the installer can ask for a password.
        execFileSync('/bin/bash', ['-c', installer], { stdio: 'inherit' });
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
      console.log(
        `  ${GR}setu setup ${setupArgs.map(shellQuote).join(' ')}${R}\n`
      );
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
  }
  setupDependencies();

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
  async function setupContainerEngine() {
    step(2, 9, 'Container engine');
    const rt = containerRuntimeAvailable();
    if (rt.available) {
      ok(`${rt.engine} already running`);
    } else {
      async function selectEngine() {
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
              // biome-ignore lint/performance/noAwaitInLoops: Each invalid answer must be received before prompting again.
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
        return engine;
      }

      function installEngine(runtime) {
        function installColima() {
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
        }
        function installDesktopEngine(engine) {
          const cask = engine === 'orbstack' ? 'orbstack' : 'docker-desktop';
          const appName = engine === 'orbstack' ? 'OrbStack' : 'Docker';
          spin(cask);
          try {
            execFileSync('brew', ['install', '--cask', cask], {
              stdio: 'ignore',
            });
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
        }
        if (runtime === 'skip') {
          console.log(
            `  ${GR}○${R} skipped — use \`setu start --bare\` until an engine is set up`
          );
        } else if (runtime === 'colima') {
          installColima();
        } else if (runtime === 'orbstack' || runtime === 'docker') {
          installDesktopEngine(runtime);
        } else {
          fail(
            `unknown engine '${runtime}' — pass --engine orbstack|docker|colima|skip`
          );
        }
      }
      const selectedEngine = await selectEngine();
      installEngine(selectedEngine);
    }
    console.log();
  }
  await setupContainerEngine();

  // 3. configure — flags first, prompts only for what's missing (agents pass flags)
  async function setupConfiguration() {
    step(3, 9, 'Configuration');
    const existing = loadConfig();
    let name =
      flags.name ??
      (existing.tunnel
        ? existing.tunnel.replace(DEV_TUNNEL_PREFIX_RE, '')
        : '');
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
        name = await ask(
          rl,
          'Your name (e.g. "alice" → tunnel dev-alice)',
          name
        );
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
    return input;
  }
  const input = await setupConfiguration();

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
          caddyfileText(input.workspace)
        )
      );
    }
  });
  await workspaceState(input.workspace).withRouting(async () => {
    installedStateValue(
      await workspaceState(input.workspace).replaceText(
        join(input.workspace, 'caddy.d', 'portal.caddy'),
        portalCaddyRoute(PORTAL_PORT)
      )
    );
  });
  done();

  spin('caddy service');
  const services = execFileSync('brew', ['services', 'list'], {
    encoding: 'utf8',
  });
  if (CADDY_SERVICE_STARTED_RE.test(services)) {
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
  await reloadCaddy(input.workspace);
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
    writeFileSync(zshrc, withSetuBlock(current, block, START, END));
  } else {
    appendFileSync(zshrc, `\n${block}\n`);
  }
  done();
  console.log();

  // 7. first hosts sync
  step(8, 9, 'Verify');
  if (await syncHosts(input.workspace)) {
    ok('/etc/hosts synced');
  } else {
    fail('/etc/hosts sync');
  }
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

function createNewOutcomeTracker(operationTarget, operationId) {
  let events;
  let outcomeRecorded = true;
  const recordOutcome = async (state, code) => {
    try {
      const recorded = await events?.record({
        ...(code ? { code } : {}),
        at: Date.now(),
        id: operationId,
        kind: 'setup',
        operationId,
        source: 'cli',
        state,
        target: operationTarget,
      });
      if (recorded?.ok !== true) {
        outcomeRecorded = false;
      }
    } catch {
      outcomeRecorded = false;
    }
  };
  const outcomeMetadata = () => ({
    operationId,
    ...(outcomeRecorded ? {} : { outcomeRecorded: false }),
  });
  return {
    outcomeMetadata,
    recordOutcome,
    reportFailure: async (result, state) => {
      await recordOutcome(state, result.code);
      process.exitCode = 1;
      if (asJson) {
        console.log(JSON.stringify({ ...result, ...outcomeMetadata() }));
      } else {
        console.error(`${Y}error:${R} ${result.code}: ${result.error}`);
      }
    },
    setEvents: (value) => {
      events = value;
    },
  };
}

function newFailureState(result) {
  return result?.state === 'unknown' ||
    String(result?.code ?? '').endsWith('UNKNOWN')
    ? 'unknown'
    : 'failed';
}

function newSetupFailureResult(error) {
  return {
    ...(error?.recovery === undefined ? {} : { recovery: error.recovery }),
    code: error?.code ?? 'SETUP_FAILED',
    error: error?.message ?? String(error),
    ok: false,
  };
}

async function createNewWorktreeResult({
  c,
  deps,
  name,
  operationId,
  operationTarget,
  repo,
  tracker,
  withTunnel,
}) {
  const sharing = (
    deps.dependencySharingForTarget ?? dependencySharingForTarget
  )(c, repo, name);
  const state = (deps.workspaceState ?? workspaceState)(c.workspace);
  tracker.setEvents(
    (deps.createOperationEvents ?? createOperationEvents)({ state })
  );
  const admission = (deps.createResourceAdmission ?? createResourceAdmission)({
    hostHealth: (deps.createHostHealth ?? createHostHealth)(c.workspace),
    state,
  });
  const progress = (deps.createSetupProgress ?? createSetupProgress)({
    newAttemptId: () => crypto.randomUUID(),
    state,
  });
  const logLocation = join(c.workspace, 'logs', repo, name, 'setup.log');
  await tracker.recordOutcome('accepted');
  return (deps.createAndInstallWorktree ?? createAndInstallWorktree)({
    admission,
    checkoutIdentity: async (wtDir) => {
      const identity = await (
        deps.inspectCheckoutIdentity ?? inspectCheckoutIdentity
      )(
        { repoDir: join(c.workspace, `${repo}.git`), wtDir },
        { readFile: readFileAsync, realpath: realpathAsync, stat: statAsync }
      );
      if (!identity.known) {
        throw Object.assign(new Error(identity.reason), {
          code: 'CHECKOUT_IDENTITY_UNKNOWN',
        });
      }
      return identity;
    },
    create: (options) =>
      (deps.createWorktree ?? createWorktree)(c, repo, name, options),
    enableTunnel: async () => {
      await (deps.ensureTunnel ?? ensureTunnel)(c, repo, name);
      return publicDomain(c);
    },
    install: (wtDir, setup) =>
      autoInstall(wtDir, sharing, asJson ? ['ignore', 2, 2] : undefined, {
        ...setup,
        state,
      }),
    logLocation,
    name,
    operationId,
    progress,
    repo,
    state,
    target: operationTarget,
    tunnel: withTunnel,
    withTarget: (lockedTarget, task) => state.withTargets([lockedTarget], task),
  });
}

async function startNewWorktree(deps, c, repo, name, result) {
  if (!flags.start) {
    return false;
  }
  await (deps.ensurePortal ?? ensurePortal)(c);
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
  const startResult = await cliApi
    .post('/api/start', startBody)
    .catch((error) => ({ error: String(error), ok: false }));
  const outcome = startOutcome(startResult);
  if (outcome.started) {
    return true;
  }
  if (outcome.queued) {
    console.log(
      `  ${GR}○${R} dev server queued at position ${outcome.position} (${outcome.reason})`
    );
  } else {
    fail(`dev server start failed: ${startResult.error ?? 'unknown'}`);
    process.exitCode = 1;
  }
  Object.assign(result, outcome);
  return false;
}

function reportNewWorktree(result, started, withTunnel, outcomeMetadata) {
  if (asJson) {
    console.log(JSON.stringify({ ...result, started, ...outcomeMetadata() }));
    return;
  }
  console.log(`\n  ${G}✓${R} worktree  ${result.wtDir}`);
  console.log(`  ${G}✓${R} port      :${result.port}`);
  console.log(`  ${G}✓${R} local     http://${result.localDom}`);
  if (withTunnel) {
    console.log(`  ${G}✓${R} public    https://${result.pubDom}`);
  }
  if (started) {
    console.log(`  ${G}✓${R} dev server started`);
  }
  console.log();
}

async function cmdNew() {
  const [repo, name] = args;
  if (!(repo && name)) {
    die(
      'Usage: setu new <repo> <branch> [--tunnel] [--start] [--container|--bare] [--json]'
    );
  }
  const deps = newCommandOverrides;
  const c = (deps.config ?? cfg)();
  const withTunnel = !!flags.tunnel;
  const operationTarget = { name, repo };
  const operationId = (
    deps.operationId ?? (() => `setup-${crypto.randomUUID()}`)
  )();
  const tracker = createNewOutcomeTracker(operationTarget, operationId);
  let res;
  try {
    res = await createNewWorktreeResult({
      c,
      deps,
      name,
      operationId,
      operationTarget,
      repo,
      tracker,
      withTunnel,
    });
  } catch (error) {
    const result = newSetupFailureResult(error);
    await tracker.reportFailure(result, newFailureState(result));
    return;
  }

  if (res?.ok === false) {
    await tracker.reportFailure(res, newFailureState(res));
    return;
  }

  await tracker.recordOutcome('completed');

  const started = await startNewWorktree(deps, c, repo, name, res);
  reportNewWorktree(res, started, withTunnel, tracker.outcomeMetadata);
}

// ── setu rm <repo> <branch> ───────────────────────────────────────────────────

async function cmdRm() {
  const [repo, name] = args;
  const deps = lifecycleCommandOverrides;
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
        (deps.requestRemoval ?? requestRemoval)(body, {
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
  const deps = lifecycleCommandOverrides;
  const c = (deps.cfg ?? cfg)();
  if (!(deps.getPort ?? getPort)(c.workspace, repo, name)) {
    die(`No worktree for ${repo}/${name} — run: setu new ${repo} ${name}`);
  }
  await (deps.ensurePortal ?? ensurePortal)(c);
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
  if (res.queued) {
    ok(`queued ${repo}/${name} at position ${res.position} (${res.reason})`);
  } else {
    ok(
      `started ${repo}/${name}${res.container ? ' (containerized)' : ' (bare)'}`
    );
  }
}

async function cmdStop() {
  const [repo, name] = args;
  if (!(repo && name)) {
    die('Usage: setu stop <repo> <branch>');
  }
  if (!(lifecycleCommandOverrides.portalPid ?? portalPid)()) {
    die('PORTAL_REQUIRED: Portal must be running to stop a worktree.');
  }
  await portalCall('/api/stop', { name, repo }, 'stop failed');
  ok(`stopped ${repo}/${name}`);
}

function createLocalWorkspaceOperation(c, kind, operationTarget = null) {
  const deps = localCommandOverrides;
  const operationId = (
    deps.operationId ?? ((name) => `${name}-${crypto.randomUUID()}`)
  )(kind);
  let events;
  try {
    const state = (deps.workspaceState ?? workspaceState)(c.workspace);
    events = (deps.createOperationEvents ?? createOperationEvents)({ state });
  } catch {
    // Recording must not prevent the requested local operation.
  }
  const record = async (state, code) => {
    try {
      await events?.record({
        ...(code ? { code } : {}),
        at: Date.now(),
        id: operationId,
        kind,
        operationId,
        source: 'cli',
        state,
        target: operationTarget,
      });
    } catch {
      // The child outcome remains authoritative if recording is unavailable.
    }
  };
  return { record };
}

function operationFailureState(error) {
  return String(error?.code ?? '').endsWith('UNKNOWN') ? 'unknown' : 'failed';
}

function importFailureState(error) {
  return ['REMOVAL_PENDING', 'STORAGE_LOW', 'STORAGE_UNKNOWN'].includes(
    error?.code
  )
    ? 'failed'
    : 'unknown';
}

// ── setu prune [--force] ──────────────────────────────────────────────────────
// Finds dev-server processes that are listening but not in setu's own registry —
// the "orb" pattern found in production: a worktree fully running and consuming
// memory, invisible to `setu ls`/the portal because portEntries() only knows
// about what .ports already has. Dry-run by default; --force actually kills.

async function cmdPrune() {
  const deps = localCommandOverrides;
  const c = (deps.config ?? cfg)();
  const active = (deps.listActivePorts ?? listActivePorts)();
  const orphans = (deps.pruneCandidates ?? pruneCandidates)(
    (deps.portEntries ?? portEntries)(c.workspace),
    active,
    deps.processCwd ?? processCwd,
    c.workspace
  );

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

  const operation = createLocalWorkspaceOperation(c, 'prune');
  await operation.record('accepted');
  let failures = 0;

  // Raw single-pid kill, not killGroup() (lib.js): these pids come from a
  // live lsof scan, not anything setu spawned, so there's no spawn record to
  // say whether the pid owns its own process group. killGroup would still
  // "work" (fall back to a single kill) if it doesn't, but blasting the group
  // on a pid we have zero attribution for risks killing an unrelated process
  // that just happens to share it (e.g. an interactive shell's foreground
  // job). A raw single-pid kill matches exactly what --force authorized.
  for (const p of orphans) {
    try {
      (deps.execFileSync ?? execFileSync)('kill', [p.pid]);
      ok(`killed pid ${p.pid} (:${p.port})`);
    } catch (e) {
      failures += 1;
      fail(`pid ${p.pid}: ${e.message}`);
    }
  }
  if (failures) {
    const code = failures === orphans.length ? 'PRUNE_FAILED' : 'PRUNE_PARTIAL';
    await operation.record('failed', code);
    process.exitCode = 1;
    return;
  }
  await operation.record('completed');
}

// ── setu ls [repo] [--json] ───────────────────────────────────────────────────

// biome-ignore lint/suspicious/useAwait: runCli and direct command callers require synchronous validation failures as rejected command promises.
async function cmdLs() {
  const [repo] = args;
  const c = cfg();
  const entries = portEntries(c.workspace).filter(
    (e) => !repo || e.repo === repo
  );
  if (!entries.length) {
    if (asJson) {
      console.log('[]');
    } else {
      console.log('No worktrees yet.');
    }
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
  const deps = localCommandOverrides;
  const c = (deps.config ?? cfg)();
  const repo = slug.split('/').pop();

  if (!existsSync(join(c.workspace, `${repo}.git`))) {
    console.log(`  Cloning ${slug}...`);
  }
  const operation = createLocalWorkspaceOperation(c, 'import', {
    name: 'main',
    repo,
  });
  await operation.record('accepted');
  try {
    await (deps.importRepo ?? importRepo)(c, {
      label,
      name: repo,
      remoteUrl: `git@github.com:${slug}.git`,
    });
  } catch (e) {
    const state = importFailureState(e);
    await operation.record(
      state,
      state === 'unknown' ? 'IMPORT_UNKNOWN' : 'IMPORT_FAILED'
    );
    // biome-ignore lint/suspicious/noUnnecessaryConditions: The import collaborator can reject an untrusted non-Error value.
    die(`${e?.code ? `${e.code}: ` : ''}${e.message}`);
  }
  await operation.record('completed');

  args.length = 0;
  args.push(repo, 'main');
  await cmdNew();
}

// ── setu sweep [--import <name>] [--json] ─────────────────────────────────────
// Finds plain git clones already on disk that were never brought into Setu's
// bare-repo+worktree layout, and can bring one in on request. Read-only
// until --import is passed.

function sweepStatusLabel(candidate) {
  if (candidate.status === 'importable') {
    return `${G}importable${R}`;
  }
  if (candidate.status === 'no-remote') {
    return `${GR}no remote${R}`;
  }
  return `${Y}conflict with ${candidate.conflictWith}${R}`;
}

function reportSweepCandidates(candidates) {
  if (asJson) {
    console.log(JSON.stringify(candidates, null, 2));
    return;
  }
  if (!candidates.length) {
    console.log('Nothing to sweep in, everything found is already registered.');
    return;
  }
  console.log();
  for (const candidate of candidates) {
    const remote = candidate.remoteUrl ?? 'no remote';
    const dirtyFlag = candidate.dirty ? `${Y}dirty${R}` : `${GR}clean${R}`;
    console.log(`  ${B}${candidate.name}${R}  ${GR}${candidate.path}${R}`);
    console.log(`    ${remote}  ${dirtyFlag}  ${sweepStatusLabel(candidate)}`);
  }
  console.log(
    `\n  ${candidates.length} candidate${candidates.length === 1 ? '' : 's'} found. Use --import <name> to bring one in.\n`
  );
}

async function importSweepCandidate(c, deps, candidate) {
  const operation = createLocalWorkspaceOperation(c, 'import', {
    name: 'main',
    repo: candidate.name,
  });
  await operation.record('accepted');
  try {
    await (deps.importRepo ?? importRepo)(c, {
      label: candidate.name,
      name: candidate.name,
      remoteUrl: candidate.remoteUrl,
    });
  } catch (error) {
    const state = importFailureState(error);
    await operation.record(
      state,
      state === 'unknown' ? 'IMPORT_UNKNOWN' : 'IMPORT_FAILED'
    );
    // biome-ignore lint/suspicious/noUnnecessaryConditions: The import collaborator can reject an untrusted non-Error value.
    die(`${error?.code ? `${error.code}: ` : ''}${error.message}`);
  }
  await operation.record('completed');
}

async function cmdSweep() {
  const deps = localCommandOverrides;
  const c = (deps.config ?? cfg)();
  // Not just cosmetic: a $HOME with old clones sitting on iCloud Drive can
  // take a while on a cold cache (each git call is capped, see
  // SWEEP_GIT_TIMEOUT_MS in lib.js, but a few dozen capped calls still add
  // up) — without this, a slow scan looks identical to a hung one.
  if (!asJson) {
    spin(`Scanning ${HOME} for git repos`);
  }
  const candidates = (deps.discoverRepos ?? discoverRepos)(HOME);
  if (!asJson) {
    done();
  }

  if (!flags.import) {
    reportSweepCandidates(candidates);
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
  await importSweepCandidate(c, deps, cand);
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
// URL with whichever client's own config file/format expects it. Codex and
// Cursor are configured by editing their files; Claude Code, Grok and OpenCode
// through their own `mcp add` commands. Claude Code also has the installable
// plugin in claude-plugin/.

// TOML, confirmed against OpenAI's own config reference (developers.openai.com/codex/config-reference):
// mcp_servers.<id> with a bare `url` field selects Streamable HTTP -- no
// separate transport/type key needed, `command` is what would select stdio
// instead. Appended, not parsed+rewritten: a hand-rolled TOML parser risks
// mangling real config (model settings, other mcp_servers) for a one-block
// addition; a new top-level table appended at file end is valid TOML
// regardless of what's above it, and the regex guard below makes this safe
// to re-run without duplicating the block.
export function mcpInstallCodex({
  home = HOME,
  codexHome = process.env.CODEX_HOME,
} = {}) {
  const dir = codexHome || join(home, '.codex');
  const path = join(dir, 'config.toml');
  mkdirSync(dir, { recursive: true });
  const text = existsSync(path) ? readFileSync(path, 'utf8') : '';
  if (hasCodexServerTable(text)) {
    ok(`Already configured in ${path}`);
    return;
  }
  writeAtomic(
    path,
    `${text.replace(TRAILING_NEWLINES_RE, '\n')}\n[mcp_servers.setu]\nurl = "${MCP_URL}"\n`
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
export function mcpInstallCursor({ home = HOME } = {}) {
  const dir = join(home, '.cursor');
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
  if (conf === null || typeof conf !== 'object' || Array.isArray(conf)) {
    die(`${path} must contain a plain object`);
  }
  conf.mcpServers ??= {};
  if (conf.mcpServers.setu) {
    ok(`Already configured in ${path}`);
    return;
  }
  writeAtomic(path, cursorConfigText(conf, MCP_URL));
  ok(`Added Setu MCP server to ${path}`);
  console.log('  Restart Cursor (or reload its MCP servers) to pick it up.');
}

function mcpInstallCli(bin, argv) {
  const result = spawnSync(bin, argv, { stdio: 'inherit' });
  if (result.status !== 0) {
    die(`${bin} did not confirm the Setu MCP server was added`);
  }
}

// A client that already lists the server is left alone, so a second run and
// `--all` never fail on "already exists".
function mcpInstallViaClient(id, argv) {
  if (mcpClientStatus(id) === 'configured') {
    ok(`Already configured in ${id}`);
    return;
  }
  mcpInstallCli(AGENT_CLIS[id].bin, argv);
  ok(`Added Setu MCP server to ${id}`);
}

function mcpInstallClaude() {
  mcpInstallViaClient('claude', [
    'mcp',
    'add',
    '--transport',
    'http',
    '--scope',
    'user',
    'setu',
    MCP_URL,
  ]);
}

function mcpInstallGrok() {
  mcpInstallViaClient('grok', [
    'mcp',
    'add',
    '--transport',
    'http',
    '--scope',
    'user',
    'setu',
    MCP_URL,
  ]);
}

function mcpInstallOpenCode() {
  mcpInstallViaClient('opencode', ['mcp', 'add', 'setu', '--url', MCP_URL]);
}

const verifiedMcpInstallers = {
  claude: mcpInstallClaude,
  codex: mcpInstallCodex,
  cursor: mcpInstallCursor,
  grok: mcpInstallGrok,
  opencode: mcpInstallOpenCode,
};

function genericMcpConfig(client) {
  console.log(
    `${client} could not be verified on this machine. Add this Streamable HTTP MCP entry using its configuration UI or documentation:\n` +
      `${JSON.stringify({ mcpServers: { setu: { type: 'http', url: MCP_URL } } }, null, 2)}`
  );
}

function codexConfigured() {
  const path = join(
    process.env.CODEX_HOME || join(HOME, '.codex'),
    'config.toml'
  );
  return existsSync(path) && hasCodexServerTable(readFileSync(path, 'utf8'));
}

function cursorConfigured() {
  const path = join(HOME, '.cursor', 'mcp.json');
  if (!existsSync(path)) {
    return false;
  }
  try {
    return !!JSON.parse(readFileSync(path, 'utf8')).mcpServers?.setu;
  } catch {
    return false;
  }
}

function mcpClientStatus(id) {
  const { bin } = AGENT_CLIS[id];
  if (!commandExists(bin)) {
    return 'unknown';
  }
  const result = spawnSync(bin, ['mcp', 'list'], { encoding: 'utf8' });
  if (result.status !== 0) {
    return 'unknown';
  }
  return `${result.stdout ?? ''}\n${result.stderr ?? ''}`.includes('setu')
    ? 'configured'
    : 'not configured';
}

function mcpStatus() {
  for (const id of Object.keys(AGENT_CLIS)) {
    if (id === 'codex') {
      console.log(
        `codex: ${codexConfigured() ? 'configured' : mcpClientStatus(id)}`
      );
    } else if (id === 'cursor') {
      console.log(
        `cursor: ${cursorConfigured() ? 'configured' : mcpClientStatus(id)}`
      );
    } else if (verifiedMcpInstallers[id]) {
      console.log(`${id}: ${mcpClientStatus(id)}`);
    } else {
      console.log(`${id}: unknown`);
    }
  }
}

// biome-ignore lint/suspicious/useAwait: runCli and direct command callers require synchronous validation failures as rejected command promises.
async function cmdMcp() {
  const [sub, targetArg] = args;
  const clientTarget = targetArg ?? (flags.all ? '--all' : undefined);
  if (sub === 'status' && !clientTarget) {
    mcpStatus();
    return;
  }
  if (sub !== 'install' || !clientTarget) {
    die('Usage: setu mcp install <client|--all> | setu mcp status');
  }
  if (clientTarget === '--all') {
    for (const [id, install] of Object.entries(verifiedMcpInstallers)) {
      if (
        ['codex', 'cursor'].includes(id) ||
        commandExists(AGENT_CLIS[id].bin)
      ) {
        install();
      }
    }
    return;
  }
  if (verifiedMcpInstallers[clientTarget]) {
    return verifiedMcpInstallers[clientTarget]();
  }
  if (Object.hasOwn(AGENT_CLIS, clientTarget)) {
    return genericMcpConfig(clientTarget);
  }
  die(
    `Unknown target '${clientTarget}'. Supported: ${Object.keys(AGENT_CLIS).join(', ')}, --all.`
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

// ── setu logs / diff / ports / pr ────────────────────────────────────────────

function portalQuery(path, values) {
  return cliApi.get(path, values);
}

async function readPortal(path, values, failure) {
  try {
    return await portalQuery(path, values);
  } catch (error) {
    die(error.message || failure);
  }
}

async function cmdLogs() {
  const [repo, name] = args;
  if (!(repo && name)) {
    die(
      'Usage: setu logs <repo> <branch> [--type dev|inngest|trigger|...] [--lines N] [--json]'
    );
  }
  const lines = flags.lines === undefined ? undefined : Number(flags.lines);
  if (lines !== undefined && (!Number.isInteger(lines) || lines < 1)) {
    die('--lines must be a positive integer');
  }
  const result = await readPortal(
    '/api/logs',
    { n: lines, name, repo, type: flags.type },
    'logs failed'
  );
  console.log(
    asJson ? JSON.stringify(result, null, 2) : (result.lines ?? []).join('\n')
  );
}

async function cmdDiff() {
  const [repo, name] = args;
  if (!(repo && name)) {
    die('Usage: setu diff <repo> <branch> [--verbose] [--json]');
  }
  const result = await readPortal('/api/diff', { name, repo }, 'diff failed');
  if (asJson || flags.verbose) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  console.log(
    `${repo}/${name} against ${result.base}: ${result.committed?.totalFiles ?? 0} committed file(s), ${result.uncommitted?.totalFiles ?? 0} uncommitted file(s)`
  );
}

async function cmdPorts() {
  const result = await readPortal('/api/ports', {}, 'ports failed');
  if (asJson) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  for (const port of result) {
    console.log(
      `:${port.port}  pid ${port.pid ?? 'unknown'}  ${port.cmd ?? ''}`.trim()
    );
  }
}

async function cmdPr() {
  const [action, repo, name] = args;
  if (!(repo && name && ['create', 'ready', 'status'].includes(action))) {
    die('Usage: setu pr create|ready|status <repo> <branch> [--json]');
  }
  if (action === 'status') {
    const result = await readPortal(
      '/api/pr-review/status',
      { name, repo },
      'PR status failed'
    );
    console.log(
      asJson ? JSON.stringify(result, null, 2) : JSON.stringify(result)
    );
    return;
  }
  const result = await portalCall(
    action === 'create' ? '/api/pr/create' : '/api/pr/ready',
    action === 'create' ? { name, repo } : { name, ready: true, repo },
    `PR ${action} failed`
  );
  console.log(
    asJson
      ? JSON.stringify(result, null, 2)
      : `PR ${action} accepted for ${repo}/${name}`
  );
}

function target() {
  const [repo, name] = args;
  if (!(repo && name)) {
    die('repo and branch are required');
  }
  return { name, repo };
}

function validateCommand({ allowedFlags = [], argCounts, usage }) {
  if (!argCounts.includes(args.length)) {
    die(`Usage: ${usage}`);
  }
  validateFlags(allowedFlags, usage);
}

function validateFlags(allowedFlags, usage) {
  for (const flag of Object.keys(flags)) {
    if (!['json', ...allowedFlags].includes(flag)) {
      die(`Usage: ${usage}`);
    }
  }
}

function optionalFlag(name) {
  if (flags[name] === undefined) {
    return;
  }
  return requireFlag(name);
}

function requireFlag(name) {
  const value = flags[name];
  if (typeof value !== 'string' || !value) {
    die(`--${name} is required`);
  }
  return value;
}

function jsonInput(name = 'input') {
  const source = requireFlag(name);
  const text =
    source === '-' ? cliReadFile(0, 'utf8') : cliReadFile(source, 'utf8');
  try {
    return JSON.parse(text);
  } catch {
    die(`--${name} must contain JSON`);
  }
}

function textInput(name) {
  const source = requireFlag(name);
  return source === '-' ? cliReadFile(0, 'utf8') : cliReadFile(source, 'utf8');
}

function checkoutIdentity() {
  const value = jsonInput('checkout');
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    die('--checkout must contain a checkout identity JSON object');
  }
  return value;
}

function positiveNumber(
  name,
  { integer = false, maximum = Number.POSITIVE_INFINITY } = {}
) {
  if (flags[name] === undefined) {
    return;
  }
  const value = Number(flags[name]);
  if (
    !Number.isFinite(value) ||
    value <= 0 ||
    value > maximum ||
    (integer && !Number.isInteger(value))
  ) {
    die(
      `--${name} must be a positive${integer ? ' integer' : ' number'} no greater than ${maximum}`
    );
  }
  return value;
}

async function apiResult(call) {
  try {
    const result = await call();
    if (
      !result ||
      result.ok === false ||
      result.state === 'unknown' ||
      String(result.code ?? '').endsWith('UNKNOWN')
    ) {
      const error =
        result?.error ?? result?.code ?? 'Portal action was not accepted';
      if (asJson) {
        console.log(JSON.stringify(result));
      } else {
        console.error(JSON.stringify({ ...result, error }, null, 2));
      }
      process.exitCode = 1;
      return null;
    }
    console.log(JSON.stringify(result, null, 2));
    return result;
  } catch (error) {
    const result = {
      code: 'PORTAL_UNAVAILABLE',
      error: error.message,
      ok: false,
    };
    if (asJson) {
      console.log(JSON.stringify(result));
    } else {
      console.error(JSON.stringify(result, null, 2));
    }
    process.exitCode = 1;
    return null;
  }
}

// biome-ignore lint/suspicious/useAwait: runCli and direct command callers require synchronous validation failures as rejected command promises.
async function cmdStorage() {
  validateCommand({
    allowedFlags: ['store'],
    argCounts: [0, 1, 3],
    usage:
      'setu storage [inspect <repo> <branch> | inspect --store <id>] [--json]',
  });
  const [action, repo, name] = args;
  if (!action) {
    validateFlags(
      [],
      'setu storage [inspect <repo> <branch> | inspect --store <id>] [--json]'
    );
    return apiResult(() => cliApi.get('/api/workspace-storage'));
  }
  if (action !== 'inspect') {
    die(
      'Usage: setu storage [inspect <repo> <branch> | inspect --store <id>] [--json]'
    );
  }
  const storeId = optionalFlag('store');
  if (storeId !== undefined && (repo || name)) {
    die('storage inspect accepts either <repo> <branch> or --store <id>');
  }
  if (storeId === undefined) {
    validateFlags([], 'setu storage inspect <repo> <branch> [--json]');
  }
  const body = storeId ? { storeId } : { name, repo };
  if (!(body.storeId || (body.repo && body.name))) {
    die('storage inspect requires <repo> <branch> or --store <id>');
  }
  return apiResult(() => cliApi.post('/api/workspace-storage/inspect', body));
}

// biome-ignore lint/suspicious/useAwait: runCli and direct command callers require synchronous validation failures as rejected command promises.
async function cmdOperations() {
  validateCommand({
    allowedFlags: ['limit', 'since'],
    argCounts: [0, 2],
    usage: 'setu operations [repo branch] [--since <ISO> --limit <N>] [--json]',
  });
  const [repo, name] = args;
  return apiResult(() =>
    cliApi.get('/api/operations', {
      limit: positiveNumber('limit', { integer: true }),
      name,
      repo,
      since: optionalFlag('since'),
    })
  );
}

// biome-ignore lint/suspicious/useAwait: runCli and direct command callers require synchronous validation failures as rejected command promises.
async function cmdSessions() {
  validateCommand({
    allowedFlags: ['checkout', 'session'],
    argCounts: [0, 1, 3],
    usage:
      'setu sessions [list [repo branch] | end <repo> <branch> --session <id> --checkout <file|->] [--json]',
  });
  const [action, repo, name] = args;
  if (!action) {
    return apiResult(() => cliApi.get('/api/agent-sessions'));
  }
  if (action === 'list') {
    validateFlags([], 'setu sessions list [repo branch] [--json]');
    if ((repo && !name) || (!repo && name)) {
      die('Usage: setu sessions list [repo branch] [--json]');
    }
    return apiResult(() => cliApi.get('/api/agent-sessions', { name, repo }));
  }
  if (action !== 'end') {
    die(
      'Usage: setu sessions [list [repo branch] | end <repo> <branch> --session <id> --checkout <identity>] [--json]'
    );
  }
  return apiResult(() =>
    cliApi.post('/api/agent-sessions/end', {
      checkoutIdentity: checkoutIdentity(),
      name,
      repo,
      sessionId: requireFlag('session'),
    })
  );
}

// biome-ignore lint/suspicious/useAwait: runCli and direct command callers require synchronous validation failures as rejected command promises.
async function cmdCaches() {
  validateCommand({
    allowedFlags: ['confirmation', 'manifest', 'retry'],
    argCounts: [3],
    usage:
      'setu caches prepare <repo> <branch> | execute <repo> <branch> --manifest <id> --confirmation <token> [--json]',
  });
  const [action, repo, name] = args;
  if (!(['prepare', 'execute'].includes(action) && repo && name)) {
    die(
      'Usage: setu caches prepare <repo> <branch> | execute <repo> <branch> --manifest <id> --confirmation <token> [--json]'
    );
  }
  const body = { name, repo };
  if (action === 'execute') {
    const retry = flags.retry === undefined ? undefined : jsonInput('retry');
    if (retry !== undefined && flags.confirmation !== undefined) {
      die('Use either --confirmation or --retry, not both');
    }
    if (retry !== undefined && flags.manifest !== undefined) {
      die('Use either --manifest or --retry, not both');
    }
    if (
      retry !== undefined &&
      !(
        retry &&
        typeof retry === 'object' &&
        typeof retry.manifestId === 'string' &&
        typeof retry.retryId === 'string'
      )
    ) {
      die('--retry must contain {"manifestId":"...","retryId":"..."}');
    }
    Object.assign(body, {
      confirmation: retry ?? requireFlag('confirmation'),
      manifestId: retry?.manifestId ?? requireFlag('manifest'),
    });
  } else {
    validateFlags([], 'setu caches prepare <repo> <branch> [--json]');
  }
  return apiResult(() => cliApi.post(`/api/worktree-cache/${action}`, body));
}

// biome-ignore lint/suspicious/useAwait: runCli and direct command callers require synchronous validation failures as rejected command promises.
async function cmdAdmission() {
  validateCommand({ argCounts: [0], usage: 'setu admission [--json]' });
  return apiResult(() => cliApi.get('/api/resource-admission'));
}

// biome-ignore lint/suspicious/useAwait: runCli and direct command callers require synchronous validation failures as rejected command promises.
async function cmdSetupProgress() {
  validateCommand({
    allowedFlags: ['attempt', 'checkout'],
    argCounts: [0, 1, 3],
    usage:
      'setu setup-progress [list [repo branch] | retry <repo> <branch> --checkout <file|-> --attempt <id>] [--json]',
  });
  const [action, repo, name] = args;
  if (!action || action === 'list') {
    validateFlags([], 'setu setup-progress list [repo branch] [--json]');
    if ((repo && !name) || (!repo && name)) {
      die('Usage: setu setup-progress list [repo branch] [--json]');
    }
    return apiResult(() =>
      cliApi.get('/api/setup-progress', {
        name: action ? name : undefined,
        repo: action ? repo : undefined,
      })
    );
  }
  if (action !== 'retry' || !(repo && name)) {
    die(
      'Usage: setu setup-progress [list [repo branch] | retry <repo> <branch> --checkout <identity> --attempt <id>] [--json]'
    );
  }
  return apiResult(() =>
    cliApi.post('/api/setup-progress/retry', {
      attemptId: requireFlag('attempt'),
      checkoutIdentity: checkoutIdentity(),
      name,
      repo,
    })
  );
}

// biome-ignore lint/suspicious/useAwait: runCli and direct command callers require synchronous validation failures as rejected command promises.
async function cmdAttention() {
  validateCommand({
    allowedFlags: ['checkout', 'session'],
    argCounts: [0, 1, 3],
    usage:
      'setu attention [list [repo branch] | focus <repo> <branch> --session <id> --checkout <file|->] [--json]',
  });
  const [action, repo, name] = args;
  if (!action || action === 'list') {
    validateFlags([], 'setu attention list [repo branch] [--json]');
    if ((repo && !name) || (!repo && name)) {
      die('Usage: setu attention list [repo branch] [--json]');
    }
    return apiResult(() =>
      cliApi.get('/api/attention', {
        name: action ? name : undefined,
        repo: action ? repo : undefined,
      })
    );
  }
  if (action !== 'focus' || !(repo && name)) {
    die(
      'Usage: setu attention [list [repo branch] | focus <repo> <branch> --session <id> --checkout <identity>] [--json]'
    );
  }
  return apiResult(() =>
    cliApi.post('/api/attention/focus', {
      checkoutIdentity: checkoutIdentity(),
      name,
      repo,
      sessionId: requireFlag('session'),
    })
  );
}

function headlessLimits() {
  const model = optionalFlag('model');
  if (model !== undefined && !HEADLESS_MODEL_RE.test(model)) {
    die('--model must be a valid headless model name');
  }
  return {
    maxBudgetUsd: positiveNumber('budget', { maximum: 2 }),
    model,
    outputBytes: positiveNumber('output-bytes', {
      integer: true,
      maximum: 64 * 1024,
    }),
    wallClockMs: positiveNumber('wall-clock-ms', {
      integer: true,
      maximum: 60 * 60 * 1000,
    }),
  };
}

// biome-ignore lint/suspicious/useAwait: runCli and direct command callers require synchronous validation failures as rejected command promises.
async function cmdHeadless() {
  validateCommand({
    allowedFlags: [
      'budget',
      'checkout',
      'model',
      'output-bytes',
      'prompt-file',
      'run',
      'wall-clock-ms',
    ],
    argCounts: [0, 1, 3],
    usage:
      'setu headless list [repo branch] | start <repo> <branch> --prompt-file <file|-> [--model <name> --budget <USD> --wall-clock-ms <N> --output-bytes <N>] | cancel <repo> <branch> --run <id> --checkout <file|-> | resume <repo> <branch> --run <id> --prompt-file <file|-> [--model <name> --budget <USD> --wall-clock-ms <N> --output-bytes <N>] [--json]',
  });
  const [action, repo, name] = args;
  if (!action || action === 'list') {
    validateFlags([], 'setu headless list [repo branch] [--json]');
    if ((repo && !name) || (!repo && name)) {
      die('Usage: setu headless list [repo branch] [--json]');
    }
    return apiResult(() =>
      cliApi.get('/api/headless-runs', {
        name: action ? name : undefined,
        repo: action ? repo : undefined,
      })
    );
  }
  if (!(repo && name && ['start', 'cancel', 'resume'].includes(action))) {
    die(
      'Usage: setu headless list [repo branch] | start <repo> <branch> --prompt-file <file|-> [--model M --budget N --wall-clock-ms N --output-bytes N] | cancel <repo> <branch> --run <id> --checkout <identity> | resume <repo> <branch> --run <id> --prompt-file <file|-> [--model M --budget N --wall-clock-ms N --output-bytes N] [--json]'
    );
  }
  const body = { name, repo };
  if (action === 'cancel') {
    validateFlags(
      ['checkout', 'run'],
      'setu headless cancel <repo> <branch> --run <id> --checkout <file|-> [--json]'
    );
    Object.assign(body, {
      checkoutIdentity: checkoutIdentity(),
      runId: requireFlag('run'),
    });
  } else {
    validateFlags(
      action === 'resume'
        ? [
            'budget',
            'model',
            'output-bytes',
            'prompt-file',
            'run',
            'wall-clock-ms',
          ]
        : ['budget', 'model', 'output-bytes', 'prompt-file', 'wall-clock-ms'],
      action === 'resume'
        ? 'setu headless resume <repo> <branch> --run <id> --prompt-file <file|-> [--model <name> --budget <USD> --wall-clock-ms <N> --output-bytes <N>] [--json]'
        : 'setu headless start <repo> <branch> --prompt-file <file|-> [--model <name> --budget <USD> --wall-clock-ms <N> --output-bytes <N>] [--json]'
    );
    Object.assign(
      body,
      headlessLimits(),
      { prompt: textInput('prompt-file') },
      action === 'resume' ? { runId: requireFlag('run') } : {}
    );
  }
  return apiResult(() => cliApi.post(`/api/headless-runs/${action}`, body));
}

// biome-ignore lint/suspicious/useAwait: runCli and direct command callers require synchronous validation failures as rejected command promises.
async function cmdDependencies() {
  validateCommand({
    argCounts: [0, 1, 2, 3],
    usage:
      'setu dependencies [status [repo branch] | verify|repair <repo> <branch>] [--json]',
  });
  let [action, repo, name] = args;
  if (args.length === 2) {
    [repo, name] = args;
    action = 'status';
  } else if (!action) {
    action = 'status';
  }
  if (action === 'status') {
    return apiResult(() =>
      cliApi.get('/api/dependency-sharing', { name, repo })
    );
  }
  if (!(['verify', 'repair'].includes(action) && repo && name)) {
    die(
      'Usage: setu dependencies [status [repo branch] | verify|repair <repo> <branch>] [--json]'
    );
  }
  return apiResult(() =>
    cliApi.post(`/api/dependency-sharing/${action}`, { name, repo })
  );
}

// biome-ignore lint/suspicious/useAwait: runCli and direct command callers require synchronous validation failures as rejected command promises.
async function cmdSharedCaches() {
  validateCommand({ argCounts: [0], usage: 'setu shared-caches [--json]' });
  return apiResult(() => cliApi.get('/api/shared-caches'));
}

// biome-ignore lint/suspicious/useAwait: runCli and direct command callers require synchronous validation failures as rejected command promises.
async function cmdWorkflows() {
  validateCommand({
    allowedFlags: ['confirmation', 'inputs', 'ref', 'workflow'],
    argCounts: [3],
    usage:
      'setu workflows list|runs <repo> <branch> | dispatch <repo> <branch> --workflow <id> --ref <ref> --inputs <file|-> [--confirmation <token>] [--json]',
  });
  const [action, repo, name] = args;
  if (!(['list', 'runs', 'dispatch'].includes(action) && repo && name)) {
    die(
      'Usage: setu workflows list|runs <repo> <branch> | dispatch <repo> <branch> --workflow <id> --ref <ref> --inputs <file|-> [--confirmation <token>] [--json]'
    );
  }
  if (action !== 'dispatch') {
    validateFlags([], `setu workflows ${action} <repo> <branch> [--json]`);
    return apiResult(() =>
      cliApi.get(`/api/github/${action === 'list' ? 'workflows' : 'runs'}`, {
        name,
        repo,
      })
    );
  }
  return apiResult(() =>
    cliApi.post('/api/github/dispatch', {
      confirmation: optionalFlag('confirmation'),
      inputs: jsonInput('inputs'),
      name,
      ref: requireFlag('ref'),
      repo,
      workflow: requireFlag('workflow'),
    })
  );
}

// biome-ignore lint/suspicious/useAwait: runCli and direct command callers require synchronous validation failures as rejected command promises.
async function cmdActions() {
  validateCommand({
    allowedFlags: ['action', 'confirmation', 'input'],
    argCounts: [1],
    usage:
      'setu actions list | save --input <file|-> | preflight --action <id> --input <file|-> | invoke --action <id> --input <file|-> --confirmation <token> [--json]',
  });
  const [action] = args;
  if (action === 'list') {
    validateFlags([], 'setu actions list [--json]');
    return apiResult(() => cliApi.get('/api/mcp-actions'));
  }
  if (!['save', 'preflight', 'invoke'].includes(action)) {
    die(
      'Usage: setu actions list | save --input <file|-> | preflight --action <id> --input <file|-> | invoke --action <id> --input <file|-> --confirmation <token> [--json]'
    );
  }
  let allowedFlags, usage;
  if (action === 'save') {
    allowedFlags = ['input'];
    usage = 'setu actions save --input <file|-> [--json]';
  } else if (action === 'preflight') {
    allowedFlags = ['action', 'input'];
    usage = 'setu actions preflight --action <id> --input <file|-> [--json]';
  } else {
    allowedFlags = ['action', 'confirmation', 'input'];
    usage =
      'setu actions invoke --action <id> --input <file|-> --confirmation <token> [--json]';
  }
  validateFlags(allowedFlags, usage);
  const body =
    action === 'save'
      ? jsonInput()
      : {
          actionId: requireFlag('action'),
          input: jsonInput(),
          ...(action === 'invoke'
            ? { confirmation: requireFlag('confirmation') }
            : {}),
        };
  return apiResult(() => cliApi.post(`/api/mcp-actions/${action}`, body));
}

// biome-ignore lint/suspicious/useAwait: runCli and direct command callers require synchronous validation failures as rejected command promises.
async function cmdAdopt() {
  validateCommand({
    allowedFlags: ['path'],
    argCounts: [2],
    usage: 'setu adopt <repo> <branch> --path <linked-checkout> [--json]',
  });
  const { repo, name } = target();
  return apiResult(() =>
    cliApi.post('/api/worktrees/adopt', {
      name,
      path: requireFlag('path'),
      repo,
    })
  );
}

// biome-ignore lint/suspicious/useAwait: runCli and direct command callers require synchronous validation failures as rejected command promises.
async function cmdReview() {
  validateCommand({
    allowedFlags: ['artifact', 'checkout', 'findings', 'session'],
    argCounts: [3],
    usage:
      'setu review handoff <repo> <branch> --session <id> --checkout <file|-> --artifact <file|-> --findings <file|-> [--json]',
  });
  const [action, repo, name] = args;
  if (action !== 'handoff' || !(repo && name)) {
    die(
      'Usage: setu review handoff <repo> <branch> --session <id> --checkout <file|-> --artifact <file|-> --findings <file|-> [--json]'
    );
  }
  const artifact = jsonInput('artifact'),
    findings = jsonInput('findings');
  if (
    !(
      artifact &&
      typeof artifact === 'object' &&
      !Array.isArray(artifact) &&
      typeof artifact.headSha === 'string' &&
      Number.isInteger(artifact.prNumber)
    )
  ) {
    die('--artifact must contain review metadata with headSha and prNumber');
  }
  if (
    !(
      Array.isArray(findings) &&
      findings.length &&
      findings.every(
        (finding) =>
          finding && typeof finding === 'object' && !Array.isArray(finding)
      )
    )
  ) {
    die('--findings must contain a nonempty JSON array of selected records');
  }
  return apiResult(() =>
    cliApi.post('/api/pr-review/handoff', {
      artifact,
      checkoutIdentity: checkoutIdentity(),
      findings,
      name,
      repo,
      sessionId: requireFlag('session'),
    })
  );
}

// ── setu fetch <repo> ─────────────────────────────────────────────────────────

async function cmdFetch() {
  const [repo] = args;
  if (!repo) {
    die('Usage: setu fetch <repo>');
  }
  const deps = localCommandOverrides;
  const c = (deps.config ?? cfg)();
  const operation = createLocalWorkspaceOperation(c, 'fetch');
  await operation.record('accepted');
  try {
    (deps.execFileSync ?? execFileSync)(
      'git',
      ['-C', join(c.workspace, `${repo}.git`), 'fetch', '--all', '--prune'],
      { stdio: 'inherit' }
    );
  } catch (error) {
    const state = operationFailureState(error);
    await operation.record(
      state,
      state === 'unknown' ? 'FETCH_UNKNOWN' : 'FETCH_FAILED'
    );
    // biome-ignore lint/suspicious/noUnnecessaryConditions: The Git command can throw an untrusted non-Error value.
    die(`${error?.code ? `${error.code}: ` : ''}${error.message}`);
  }
  await operation.record('completed');
}

// ── setu path <repo> <branch> ────────────────────────────────────────────────
// Used by the `wt()` shell function to cd into a worktree — stdout must stay clean.

// biome-ignore lint/suspicious/useAwait: runCli and direct command callers require synchronous validation failures as rejected command promises.
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
async function spawnTextCode(command, argv) {
  try {
    const proc = Bun.spawn([command, ...argv], {
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

function registeredPortMismatch(entry, active, workspace, projectState) {
  const process = active.find((candidate) => candidate.port === entry.port);
  if (!process) {
    return;
  }
  const cwd = processCwd(process.pid);
  const expected = resolve(join(workspace, entry.repo, entry.name));
  if (
    projectState.get(composeProjectName(entry.repo, entry.name)) ===
      'running' ||
    !hasIdentifiableWorktreeCwd(cwd)
  ) {
    return;
  }
  // Nx/monorepo dev servers end up with cwd nested inside apps/<app> — only
  // flag a cwd that is neither the worktree root nor a descendant of it.
  if (
    cwd &&
    resolve(cwd) !== expected &&
    !resolve(cwd).startsWith(`${expected}/`)
  ) {
    return `${entry.key} :${entry.port} is actually serving ${cwd}`;
  }
}

async function registeredPortWorktreeCheck(entries, active, workspace) {
  const raw = await spawnText([
    'docker',
    'ps',
    '--format',
    '{{.Label "com.docker.compose.project"}}\t{{.State}}',
  ]);
  const projectState = composeProjectStates(raw);
  const mismatches = entries
    .map((entry) =>
      registeredPortMismatch(entry, active, workspace, projectState)
    )
    .filter(Boolean);
  return {
    fix: mismatches.join('; ') || undefined,
    name: 'registered ports match their worktree',
    ok: mismatches.length === 0,
  };
}

function gitWorktreePaths(repoDir) {
  try {
    return git(repoDir, ['worktree', 'list', '--porcelain'])
      .trim()
      .split('\n\n')
      .flatMap((worktree) => {
        const path = worktree.match(WORKTREE_LIST_ENTRY_RE)?.[1];
        return path && path !== repoDir && !path.includes('/.claude/worktrees/')
          ? [path]
          : [];
      });
  } catch {
    // This repository cannot contribute paths to the best-effort scan.
    return [];
  }
}

function unregisteredWorktreeCheck(entries, workspace) {
  const registeredDirs = new Set(
    entries.map((entry) => join(workspace, entry.repo, entry.name))
  );
  const gitWorktreeDirs = new Set(
    Object.keys(loadProjects(workspace)).flatMap((repo) => {
      const repoDir = join(workspace, `${repo}.git`);
      return existsSync(repoDir) ? gitWorktreePaths(repoDir) : [];
    })
  );
  const unregistered = [...gitWorktreeDirs].filter(
    (directory) => !registeredDirs.has(directory)
  );
  return {
    fix: unregistered.length
      ? `setu new for: ${unregistered.join(', ')}  (or setu rm if abandoned)`
      : undefined,
    name: 'all git worktrees are registered with setu',
    ok: unregistered.length === 0,
  };
}

async function cmdDoctor() {
  const c = loadConfig();
  const workspace = c.workspace ?? '';
  const { writerClaimChecks } = await import('./writer-claims.js');

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
  // One listing serves both checks. Given a command, `sudo -l` prints only
  // that command and never the NOPASSWD tag, so list everything instead.
  let sudoListing;
  const sudoOk = async (argv) => {
    sudoListing ??= spawnTextCode('sudo', ['-n', '-l']);
    const { code, text } = await sudoListing;
    return code === 0 && sudoRuleCovers(text, argv);
  };

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
      ok:
        DNSMASQ_SERVICE_STARTED_RE.test(dnsmasqLine) &&
        !ERROR_RE.test(dnsmasqLine),
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
      ok: CADDY_SERVICE_STARTED_RE.test(services),
    }),
    async () => ({
      fix: 'brew services restart caddy',
      name: 'caddy admin API (:2019)',
      ok: caddyAdmin,
    }),
    async () => ({
      fix: 'setu setup',
      name: 'quivly.local portal route',
      ok:
        !!workspace &&
        existsSync(join(workspace, 'caddy.d', 'portal.caddy')) &&
        hasPortalCaddyRoute(
          readFileSync(join(workspace, 'caddy.d', 'portal.caddy'), 'utf8'),
          PORTAL_PORT
        ),
    }),
    // `setu start` containerizes by default now (real memory/CPU cap) — a
    // missing runtime isn't merely informational, it means plain `setu start`
    // will fail until either the engine is running or `--bare` is passed.
    // Reports whichever engine answered (OrbStack, Docker Desktop, Colima, …)
    // without requiring one specifically — see the containerization plan.
    // biome-ignore lint/suspicious/useAwait: checkThunks are invoked by Promise.all below, so synchronous probe failures must reject.
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
    // biome-ignore lint/suspicious/useAwait: checkThunks are invoked by Promise.all below, so synchronous probe failures must reject.
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
    checkThunks.push(
      // biome-ignore lint/suspicious/useAwait: checkThunks are invoked by Promise.all below, so synchronous probe failures must reject.
      async () => {
        let behind = 0;
        try {
          behind = Number.parseInt(
            setuGit(['rev-list', '--count', 'HEAD..origin/main']).trim(),
            10
          );
        } catch {
          // Continue collecting the other independent diagnostic results.
        }
        return {
          fix: 'setu update',
          name: 'setu up to date',
          ok: behind === 0,
        };
      }
    );
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

    checkThunks.push(
      // biome-ignore lint/suspicious/useAwait: checkThunks are invoked by Promise.all below, so synchronous probe failures must reject.
      async () => {
        const locks = workspaceState(workspace).inspectLocks();
        const bad = locks.filter(
          (lock) => lock.retained || lock.alive === false
        );
        return {
          fix: bad.length
            ? `${bad.map((lock) => lock.path).join(', ')}${bad.some((lock) => lock.alive === false) ? ' — it is safe to delete a lock whose process is dead' : ''}`
            : undefined,
          name: 'no stale Setu locks',
          ok: bad.length === 0,
        };
      }
    );

    checkThunks.push(
      // biome-ignore lint/suspicious/useAwait: checkThunks are invoked by Promise.all below, so synchronous probe failures must reject.
      async () => {
        const orphanProcs = pruneCandidates(
          entries,
          active,
          processCwd,
          workspace
        );
        return {
          fix: orphanProcs.length
            ? `setu prune  (${orphanProcs.length} found: ${orphanProcs.map((p) => `pid ${p.pid} :${p.port}`).join(', ')})`
            : undefined,
          name: 'no unregistered dev-server processes',
          ok: orphanProcs.length === 0,
        };
      }
    );

    checkThunks.push(() =>
      registeredPortWorktreeCheck(entries, active, workspace)
    );

    checkThunks.push(async () => unregisteredWorktreeCheck(entries, workspace));

    // mirror case: registry entries for worktrees removed via raw `git worktree
    // remove` instead of `setu rm` — the port/domain registration outlives the
    // directory it pointed at.
    checkThunks.push(
      // biome-ignore lint/suspicious/useAwait: checkThunks are invoked by Promise.all below, so synchronous probe failures must reject.
      async () => {
        const stale = entries.filter(
          (e) => !existsSync(join(workspace, e.repo, e.name))
        );
        return {
          fix: stale.length
            ? `stale: ${stale.map((e) => e.key).join(', ')}  — setu rm <repo> <branch>`
            : undefined,
          name: 'no registry entries for missing worktrees',
          ok: stale.length === 0,
        };
      }
    );

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
  checkThunks.push(async () => writerClaimChecks(writerClaimPaths(workspace)));

  const checks = (await Promise.all(checkThunks.map((fn) => fn())))
    .flat()
    .map((r) => ({ ...r, ok: !!r.ok }));

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
    setu rm    <repo> <branch> [--force]  Remove worktree through the running portal
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
    setu logs  <repo> <branch> [--type dev|inngest|trigger|...] [--lines N] [--json]
    setu diff  <repo> <branch> [--verbose] [--json]
    setu ports [--json]             List active local ports through the portal
    setu pr create|ready|status <repo> <branch> [--json]

  ${C}Workspace operations${R}
    setu storage [inspect <repo> <branch> | inspect --store <id>] [--json]
    setu operations [repo branch] [--since <ISO> --limit <N>] [--json]
    setu sessions [list [repo branch] | end <repo> <branch> --session <id> --checkout <file|->] [--json]
    setu caches prepare <repo> <branch> [--json]
    setu caches execute <repo> <branch> --manifest <id> --confirmation <token> [--json]
    setu caches execute <repo> <branch> --retry <file|-> [--json]
                                      Retry input contains the returned manifestId and retryId
    setu admission [--json]
    setu setup-progress [list [repo branch] | retry <repo> <branch> --checkout <file|-> --attempt <id>] [--json]
    setu attention [list [repo branch] | focus <repo> <branch> --session <id> --checkout <file|->] [--json]
    setu headless list [repo branch] [--json]
    setu headless start <repo> <branch> --prompt-file <file|-> [--model <name> --budget <USD> --wall-clock-ms <N> --output-bytes <N>] [--json]
    setu headless cancel <repo> <branch> --run <id> --checkout <file|-> [--json]
    setu headless resume <repo> <branch> --run <id> --prompt-file <file|-> [--model <name> --budget <USD> --wall-clock-ms <N> --output-bytes <N>] [--json]
    setu dependencies [status [repo branch] | verify|repair <repo> <branch>] [--json]
    setu shared-caches [--json]
    setu workflows list|runs <repo> <branch> [--json]
    setu workflows dispatch <repo> <branch> --workflow <id> --ref <ref> --inputs <file|-> [--confirmation <token>] [--json]
    setu actions list [--json]
    setu actions save --input <file|-> [--json]
    setu actions preflight --action <id> --input <file|-> [--json]
    setu actions invoke --action <id> --input <file|-> --confirmation <token> [--json]
    setu adopt <repo> <branch> --path <linked-checkout> [--json]
    setu review handoff <repo> <branch> --session <id> --checkout <file|-> --artifact <file|-> --findings <file|-> [--json]

  ${C}Portal${R}
    setu portal                      Start web UI at http://quivly.local
    setu portal stop                 Stop portal

  ${C}Writer claims${R}
    setu claim [worktree] --agent X --session Y --task "..." [--pid N] [--json]
                                      Claim or refresh this session's writer slot (default: cwd)
    setu release [worktree] --session Y [--json]   Release only this session's claim
    setu claims [--json]             List active claims across known worktrees
    setu claim-check <path> --session Y [--json]  Read-only hook check: 0 allowed, 2 blocked

  ${C}MCP — let an agent drive Setu directly${R}
    setu mcp install codex           Register Setu's MCP server in ~/.codex/config.toml
    setu mcp install cursor          Register Setu's MCP server in ~/.cursor/mcp.json
    setu mcp install <client>        Configure a supported local agent client
    setu mcp install --all           Configure every verified installed client
    setu mcp status                  List each client as configured, not configured, or unknown

  ${C}Meta${R}
    setu update [--restart] [--include-untracked]  Update setu safely
    setu version                     Show version + commit
    setu help                        Show this
`);
}

export {
  cmdActions,
  cmdAdmission,
  cmdAdopt,
  cmdAttention,
  cmdCaches,
  cmdCd,
  cmdDependencies,
  cmdDiff,
  cmdDoctor,
  cmdFetch,
  cmdHeadless,
  cmdHelp,
  cmdInit,
  cmdLogs,
  cmdLs,
  cmdMcp,
  cmdNew,
  cmdOperations,
  cmdPath,
  cmdPortal,
  cmdPorts,
  cmdPr,
  cmdPrune,
  cmdReview,
  cmdRm,
  cmdSessions,
  cmdSetup,
  cmdSetupProgress,
  cmdSharedCaches,
  cmdStart,
  cmdStop,
  cmdStorage,
  cmdSweep,
  cmdSync,
  cmdTrigger,
  cmdTunnel,
  cmdUpdate,
  cmdVersion,
  cmdWorkflows,
};

// Entry point. This stays the last statement in the file: runCli must not run
// before every top-level constant above has been initialised.
if (import.meta.main) {
  process.on('SIGINT', () => {
    releaseHeldLocks();
    process.exit(130);
  });
  process.on('SIGTERM', () => {
    releaseHeldLocks();
    process.exit(143);
  });
  await runCli();
}
