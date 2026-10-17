#!/usr/bin/env bun

// Dev portal — http://quivly.local

import {
  appendFileSync,
  closeSync,
  existsSync,
  ftruncateSync,
  mkdirSync,
  openSync,
  readSync,
  realpathSync,
  statSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import identityFs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { agentStatus } from './agent.js';
import { inspectCheckoutIdentity } from './checkout-identity.js';
import { getCostsSummary } from './costs.js';
import { dependencySharingForTarget } from './dependency-sharing.js';
import {
  createDeploymentGuard,
  createDeploymentLauncher,
  createProviderResolver,
  installedDeployTool,
} from './deployment-guard.js';
import { createCommandRunner, createDevRuntime } from './dev-runtime.js';
import { assertStorageHeadroom, createHostHealth } from './host-health.js';
import {
  AGENT_CLIS,
  activePidAsync,
  approveSidecar,
  assertRemovableWorktree,
  assignPort,
  baseBranchRefAsync,
  branchMetadata,
  CLOUDFLARED_BIN,
  caddySnippetPath,
  cloneBareRepoAsync,
  commandExists,
  composeDownAsync,
  composeProjectName,
  configureWorktreeEnv,
  convexDir,
  defaultContainerMode,
  detectAgentClis,
  discoverReposAsync,
  dockerComposePath,
  envLocalPath,
  getPort,
  HOME,
  HOSTS_END,
  HOSTS_START,
  HOSTS_TMP,
  importRepo,
  installedStateValue,
  isSidecarApproved,
  createWorktree as libCreateWorktree,
  loadAllSidecars,
  loadArchivedWorktrees,
  loadCustomAgents,
  loadFileSyncGlobs,
  loadMcpServers,
  loadProjects,
  loadSidecars,
  localDomain,
  macCapacity,
  managedWorktreePath,
  markMigrationPrompted,
  needsMigrationPrompt,
  PORTAL_PORT,
  parseEnvFile,
  pinnedTriggerVersion,
  portalRequestError,
  portEntries,
  publicDomain,
  registerProject,
  reloadCaddyAsync,
  removeProject,
  requireConfig,
  resourceSettings,
  saveCustomAgents,
  saveFileSyncGlobs,
  saveMcpServers,
  saveSidecars,
  seedSidecarApprovalsIfMissing,
  shellQuote,
  spawnText,
  splitKey,
  syncWithBase,
  tunnelEnabled,
  validateWorktreeNames,
  workspaceInventoryRegistry,
  workspaceState,
  worktreeBranchMap,
  writeCaddy,
  writeDockerCompose,
  writerClaimPaths,
} from './lib.js';
import {
  createListenerObservation,
  probeListeningPorts,
} from './listener-observation.js';
import { readLogSnapshot, readLogTail } from './log-tail.js';
import { createManagedAgentServices } from './managed-agent-services.js';
import {
  callConnectedMcpTool,
  connectMcpServer,
  disconnectMcpServer,
  finishMcpAuth,
  mcpHasOwnedWork,
  mcpStatuses,
} from './mcp.js';
import { handleMcpRequest, initMcpServer } from './mcp-server.js';
import {
  pruneDeadEntries,
  watchOwnedProcessExit,
} from './owned-process-map.js';
import { createWorktreeAdoption } from './portal-adoption.js';
import { createPortalOperationOutcomes } from './portal-operation-outcomes.js';
import {
  createPortalResourceServices,
  dispatchPortalResourceRoute,
} from './portal-resource-services.js';
import { portalApiRoute } from './portal-routes.js';
import { createPortalRouting } from './portal-routing.js';
import { readPortalStatus } from './portal-status.js';
import {
  createPortalUpdateControl,
  drainPortalForUpdate,
} from './portal-update.js';
import {
  artifactHtmlPath,
  detectPrWalkthroughPlugin,
  findLatestArtifact,
  reviewRunStatus,
  runDeepReview,
} from './pr-review.js';
import { observeProcessIdentity } from './process-observation.js';
import {
  applyTunnelConfiguration,
  claimTunnelOwner,
  createRemovalRouting,
} from './removal-routing.js';
import { createSetupProgress } from './setup-progress.js';
import { createSpansRuntime } from './spans-runtime.js';
import {
  createWorkspaceInventory,
  parseLinkedWorktrees,
} from './workspace-inventory.js';
import {
  startWorktreeSetupInstall,
  withSetupAdmission,
} from './workspace-setup.js';
import { releaseHeldLocks, safeStateCauseCode } from './workspace-state.js';
import { createWorktreeLifecycle } from './worktree-lifecycle.js';
import {
  createRemovalController,
  observeRemovalCheckout,
  validateRemovalRecords,
} from './worktree-removal.js';
import {
  createWorktreeStream,
  readFreshWorktreeSnapshot,
} from './worktree-stream.js';
import {
  claimWriter,
  listWriterClaims,
  releaseWriter,
  writerWorktree,
} from './writer-claims.js';

const LOG_TYPE_RE =
  /^(dev|setup|inngest|trigger|convex|vercel|netlify|tunnel|pr-review|sidecar-[a-zA-Z0-9_-]+)$/;
const ORIGIN_PREFIX_RE = /^origin\//;
const DIFF_HEADER_RE = /^a\/(.*) b\/(.*)$/;
const BINARY_DIFF_RE = /^Binary files (.+) and (.+) differ$/;
const OLD_DIFF_PATH_PREFIX_RE = /^a\//;
const NEW_DIFF_PATH_PREFIX_RE = /^b\//;
const DIFF_HUNK_RE = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;
const WHITESPACE_RE = /\s+/;
const MEMORY_USAGE_RE = /^([\d.]+)\s*(MiB|GiB)/;
const PID_RE = /^\d+$/;
const TRIGGER_PROCESS_RE = /^\s*(\d+)\s+.*\.bin\/trigger dev\b/;
const CONVEX_PROCESS_RE = /^\s*(\d+)\s+.*\bconvex dev\b/;
const GITHUB_HTTPS_PREFIX_RE = /^https?:\/\/github\.com\//;
const GITHUB_SSH_PREFIX_RE = /^git@github\.com:/;
const GIT_SUFFIX_RE = /\.git$/;
const FOOTPRINT_RE = /phys_footprint:\s*([\d.]+)\s*(KB|MB|GB)/i;

/**
 * Builds an unstarted portal runtime.  Importing this module deliberately does
 * not read user configuration, touch a workspace, or install process hooks.
 * The small collaborators here keep acceptance tests isolated without making
 * the route implementation depend on a test framework.
 */
// biome-ignore lint/suspicious/useAwait: callers await this factory, so synchronous configuration or collaborator failures must reject its Promise.
export async function createPortalRuntime(options = {}) {
  let _cfg = options.config ?? requireConfig();
  if (options.workspace) {
    _cfg = { ..._cfg, workspace: options.workspace };
  }
  let configReconciled = true;

  const WORKSPACE = _cfg.workspace;
  const portalState = options.state ?? workspaceState(WORKSPACE);
  const runText = options.spawnText ?? spawnText;
  const runtimeTimers = options.timers ?? { clearInterval, setInterval };
  const ADOPTIONS_PATH = join(WORKSPACE, '.setu-adoptions.json');
  const portalRouting =
    options.routing ??
    createPortalRouting({
      hostsEnd: HOSTS_END,
      hostsStart: HOSTS_START,
      localDomain,
      readFile: identityFs.readFile,
      reloadCaddy: () => reloadCaddyAsync(WORKSPACE),
      run: (args, spawnOptions) => Bun.spawn(args, spawnOptions),
      stagingPath: HOSTS_TMP,
      state: portalState,
      writeCaddy: (repo, name, port) =>
        writeCaddy(_cfg, repo, name, port, false),
    });
  const readHostHealth = options.hostHealth ?? createHostHealth(WORKSPACE);
  const TUNNEL_NAME = _cfg.tunnel;
  const CF_CREDENTIALS_CFG = _cfg.cfCredentials;
  const PKG_DIR = new URL('.', import.meta.url).pathname;
  const LOGS = `${WORKSPACE}/logs`;
  const PORT = options.port ?? PORTAL_PORT;
  const LOG_MAX_BYTES = 5 * 1024 * 1024; // rotate at 5 MB

  const inngestProcs = new Map();
  const triggerProcs = new Map();
  const convexDevProcs = new Map(); // `npx convex dev` per worktree, same shape as triggerProcs (no local port to cross-check)
  const sidecarProcs = new Map(); // key: `${repo}/${name}/${sidecar.name}`

  // Idle-timeout tracking (see checkIdleTimeouts near the bottom for the full
  // design). key -> ms epoch of the last real, user-driven activity touching
  // this worktree. Deliberately NOT touched by the passive GET /api/worktrees
  // list poll: app.tsx's refresh() loop hits it for every worktree every
  // 800ms-3s regardless of what's on screen, even from a backgrounded browser
  // tab. Touching it there would make a worktree look active forever just
  // because the dashboard exists somewhere, which defeats the point of an
  // idle timeout.
  const lastSeenAt = new Map();

  function touchLastSeen(repo, name) {
    lastSeenAt.set(`${repo}/${name}`, Date.now());
  }

  const INNGEST_CLI = 'inngest-cli';
  const INNGEST_OFFSET = 5288; // app port 3000 → inngest 8288, 3001 → 8289, …

  const CF_CREDENTIALS = CF_CREDENTIALS_CFG;
  const TUNNEL_CONF_DIR = `${WORKSPACE}/tunnel.d`;
  const MERGED_CONF = `${TUNNEL_CONF_DIR}/merged.yml`;
  const TUNNEL_LOG = `${LOGS}/cloudflared/tunnel.log`;

  // One cloudflared process with a merged ingress config.
  // Replicas of the same tunnel are load-balanced by Cloudflare's edge — each replica
  // applies its own local ingress rules, so two replicas with different ingress maps
  // will randomly 404 each other's subdomains. Single process avoids this entirely.
  const activeTunnelMap = new Map(); // key → { pubDom, port }
  let tunnelProc = null;
  let tunnelTeardownUnknown = false;

  function inngestPort(appPort) {
    return appPort + INNGEST_OFFSET;
  }

  // Same path shape lib.js already builds with join() for the same concept.
  // Kept as a template literal here (not join()) only because that's this
  // file's existing convention for WORKSPACE-relative paths throughout.
  function wtPath(repo, name) {
    return managedWorktreePath(WORKSPACE, repo, name);
  }
  function repoPath(repo) {
    validateWorktreeNames(repo, 'main');
    return `${WORKSPACE}/${repo}.git`;
  }

  // ── logging ───────────────────────────────────────────────────────────────────

  function logDir(repo, name) {
    const dir = `${LOGS}/${repo}/${name}`;
    mkdirSync(dir, { recursive: true });
    return dir;
  }

  function logPath(repo, name, type = 'dev') {
    if (options.logPath) {
      return options.logPath(repo, name, type);
    }
    wtPath(repo, name);
    if (!LOG_TYPE_RE.test(type)) {
      throw new Error('Unknown log type');
    }
    if (type === 'tunnel') {
      return TUNNEL_LOG;
    }
    return `${logDir(repo, name)}/${type}.log`;
  }

  const openLogPaths = new Set();

  function trimLog(path, keep = LOG_MAX_BYTES / 2) {
    let fd;
    try {
      const { size } = statSync(path);
      if (size <= LOG_MAX_BYTES) {
        return;
      }
      fd = openSync(path, 'r+');
      const buffer = Buffer.alloc(keep);
      const read = readSync(fd, buffer, 0, keep, size - keep);
      // Keep the inode: children hold O_APPEND descriptors across portal restarts.
      // ponytail: copytruncate can lose a concurrent line at rotation; use a
      // dedicated log collector if lossless diagnostic retention becomes necessary.
      ftruncateSync(fd, 0);
      writeSync(fd, buffer, 0, read, 0);
    } catch (error) {
      if (error.code !== 'ENOENT') {
        console.error('Log retention failed:', path, error.message);
      }
    } finally {
      if (fd !== undefined) {
        closeSync(fd);
      }
    }
  }

  let logRetentionTimer = null;

  function rotateLog(path) {
    openLogPaths.add(path);
    trimLog(path);
    trimLog(`${path}.old`, LOG_MAX_BYTES);
  }

  function spawnWithLog(command, spawnOptions, fd) {
    try {
      return Bun.spawn(command, {
        ...spawnOptions,
        stderr: fd,
        stdout: fd,
      });
    } finally {
      closeSync(fd);
    }
  }

  function openLogFd(repo, name, type = 'dev') {
    const path = logPath(repo, name, type);
    rotateLog(path);
    appendFileSync(
      path,
      `\n[${new Date().toISOString()}] ── session start ──\n`
    );
    return openSync(path, 'a');
  }

  // biome-ignore lint/style/useDefaultParameterLast: existing route and MCP callers pass the positional `previous` cursor after optional type and line arguments.
  function tailLog(repo, name, type = 'dev', lines = 150, previous) {
    return readLogTail(logPath(repo, name, type), lines, { previous });
  }

  // ── Raycast extension dev mode ──────────────────────────────────────────────
  // raycast/ lives inside the setu repo itself (PKG_DIR), not a registered
  // project under WORKSPACE — it's Setu's own tooling, not something a
  // worktree owns. `ray develop` is a long-running watch process (like `next
  // dev`), so this is tracked the same shape as a worktree's dev server
  // (procs Map elsewhere) rather than treated as a one-shot command.
  const RAYCAST_DIR = `${PKG_DIR}raycast`;
  let raycastDev = null; // { proc, pid } | null
  let raycastLogSnapshot;

  function raycastLogPath() {
    const dir = `${LOGS}/_raycast`;
    mkdirSync(dir, { recursive: true });
    return `${dir}/dev.log`;
  }

  function startRaycastDev() {
    if (raycastDev) {
      return { ok: true };
    }
    if (!existsSync(RAYCAST_DIR)) {
      return { error: 'raycast/ not found in the setu repo', ok: false };
    }
    const path = raycastLogPath();
    rotateLog(path);
    appendFileSync(
      path,
      `\n[${new Date().toISOString()}] ── raycast dev start ──\n`
    );
    const fd = openSync(path, 'a');
    // One script, not two spawns — `npm install` only when node_modules is
    // missing (so toggling dev mode on repeatedly doesn't reinstall every
    // time), then hands off to `ray develop` in the same process tree so a
    // single pid covers both steps for stop/kill purposes.
    const script = `${tmpdir()}/setu-raycast-dev-${Date.now()}.sh`;
    writeFileSync(
      script,
      `#!/bin/zsh\ncd "${RAYCAST_DIR}"\n[ -d node_modules ] || bun install\nexec bunx ray develop\n`,
      { mode: 0o755 }
    );
    const proc = spawnWithLog(
      ['/bin/zsh', script],
      { cwd: RAYCAST_DIR, detached: true },
      fd
    );
    raycastDev = { pid: proc.pid, proc };
    proc.exited.then(
      () => {
        if (raycastDev?.proc === proc) {
          raycastDev = null;
        }
      },
      () => {
        /* Unknown exit retains ownership. */
      }
    );
    return { ok: true };
  }

  async function stopRaycastDev() {
    if (!raycastDev) {
      return { ok: true };
    }
    const entry = raycastDev;
    await devRuntime.stopProcess({ ...entry, ownedGroup: true });
    if (raycastDev === entry) {
      raycastDev = null;
    }
    return { ok: true };
  }

  // ── repo metadata ─────────────────────────────────────────────────────────────

  let REPO_META = options.projects ?? {};

  // ── git metadata cache (last-commit / ahead-behind, batched per repo) ────────
  // branchMetadata()+worktreeBranchMap() are each one call per REPO, not per
  // worktree (see lib.js) — still worth a short TTL so a full /api/worktrees
  // poll (every 800ms while a start is pending) doesn't re-run them needlessly.
  // Nothing in the poll path fetches, so this is inherently as stale as the
  // last `git fetch` regardless of TTL — the TTL bounds re-parse cost, not staleness.

  const gitMetaCache = new Map(); // repo -> { branchMeta, pathToBranch, fetchedAt }
  const GIT_META_TTL = 10_000;

  const gitMetaInFlight = new Map();
  // biome-ignore lint/suspicious/useAwait: getWorktrees callers await this cache boundary, which must turn synchronous path/configuration failures into Promise rejections.
  async function repoGitMeta(repo, background = false) {
    const cached = gitMetaCache.get(repo);
    if (cached && Date.now() - cached.fetchedAt < GIT_META_TTL) {
      return cached;
    }
    if (gitMetaInFlight.has(repo)) {
      return background && cached ? cached : gitMetaInFlight.get(repo);
    }
    const pending = (async () => {
      const repoDir = repoPath(repo);
      const read = (args) =>
        runText(['git', '-C', repoDir, ...args], { timeoutMs: 5000 });
      const [staging, head, porcelain] = await Promise.all([
        read([
          'for-each-ref',
          '--format=%(refname)',
          'refs/heads/staging',
          'refs/remotes/origin/staging',
        ]),
        read(['symbolic-ref', '--short', 'HEAD']),
        read(['worktree', 'list', '--porcelain']),
      ]);
      const hasStaging = staging
        .split('\n')
        .some(
          (ref) =>
            ref === 'refs/heads/staging' ||
            ref === 'refs/remotes/origin/staging'
        );
      const base = hasStaging ? 'origin/staging' : `origin/${head}`;
      const raw = await read([
        'for-each-ref',
        `--format=%(refname:short)\t%(committerdate:unix)\t%(ahead-behind:${base})`,
        'refs/heads/',
      ]);
      const entry = {
        branchMeta: branchMetadata(repoDir, raw),
        fetchedAt: Date.now(),
        pathToBranch: worktreeBranchMap(repoDir, porcelain),
      };
      gitMetaCache.set(repo, entry);
      return entry;
    })().finally(() => gitMetaInFlight.delete(repo));
    gitMetaInFlight.set(repo, pending);
    return background && cached ? cached : pending;
  }

  // Uncommitted-changes count — genuinely per-worktree (live working-tree
  // state, can't be batched from the bare repo like the ref data above).
  // Same shape as fetchPR: Bun.spawn (not execFileSync — see fetchPR's own
  // comment on why), short TTL cache.
  const dirtyCache = new Map();
  const DIRTY_TTL = 15_000;
  let dirtyChecks = 0;
  const dirtyQueue = [];

  function drainDirtyQueue() {
    while (dirtyChecks < 4 && dirtyQueue.length) {
      dirtyChecks += 1;
      const task = dirtyQueue.shift();
      Promise.resolve()
        .then(task)
        .catch((error) => {
          console.error('Dirty metadata refresh failed:', error);
        })
        .finally(() => {
          dirtyChecks -= 1;
          drainDirtyQueue();
        });
    }
  }

  // biome-ignore lint/suspicious/useAwait: getWorktrees callers await this background-cache API, including synchronous validation failures.
  async function fetchDirty(repo, name) {
    const key = `${repo}/${name}`;
    const cached = dirtyCache.get(key);
    if (
      cached?.pending ||
      (cached && Date.now() - cached.fetchedAt < DIRTY_TTL)
    ) {
      return cached?.count ?? null;
    }
    const record = {
      count: cached?.count ?? null,
      fetchedAt: 0,
      pending: true,
    };
    dirtyCache.set(key, record);
    // Dirty badges are background metadata. Fresh deletion checks never use this cache.
    dirtyQueue.push(() =>
      Promise.resolve()
        .then(() => wtPath(repo, name))
        .then((path) =>
          spawnRun(
            path,
            ['git', '--no-optional-locks', 'status', '--porcelain'],
            5000
          )
        )
        .then((raw) => {
          record.count = raw.trim() ? raw.trim().split('\n').length : 0;
        })
        .catch(() => {
          record.count = null;
        })
        .finally(() => {
          record.pending = false;
          record.fetchedAt = Date.now();
        })
    );
    drainDirtyQueue();
    return record.count;
  }

  // convexDir() reads + regex-parses up to two directories' worth of env files
  // per worktree -- measured ~1ms/worktree, ~50ms synchronously across the
  // full ~47-worktree registry this portal actually runs against. Unlike the
  // async per-worktree work elsewhere in getWorktrees, that's a single
  // uninterrupted block on the event loop every poll (as often as every
  // 800ms while a start is pending), so it gets the same TTL-cache treatment
  // as dirtyCache above and gitMetaCache below -- Convex configuration
  // essentially never changes mid-session, same justification as those. Only
  // used from the getWorktrees poll path; startConvexDev/deployToConvex below
  // call convexDir() directly so a user action always sees a fresh answer.
  const convexConfigCache = new Map(); // key: `${repo}/${name}` -> { dir, fetchedAt }
  const CONVEX_CONFIG_TTL = 10_000;

  function cachedConvexDir(repo, name, wtDir) {
    const key = `${repo}/${name}`;
    const cached = convexConfigCache.get(key);
    if (cached && Date.now() - cached.fetchedAt < CONVEX_CONFIG_TTL) {
      return cached.dir;
    }
    const dir = convexDir(repo, wtDir);
    convexConfigCache.set(key, { dir, fetchedAt: Date.now() });
    return dir;
  }

  // ── PR cache ──────────────────────────────────────────────────────────────────

  const prCache = new Map();
  const PR_TTL = 60_000;

  // statusCheckRollup mixes two shapes in the same array (confirmed live on a
  // real merged PR that had both): CheckRun (GitHub Actions, status+conclusion)
  // and StatusContext (legacy commit statuses, state only). Collapse both into
  // one summary rather than surfacing per-check detail, the badge only needs
  // passing/failing/pending/none, not a checks list.
  function statusContextSummary(check) {
    if (check.state === 'FAILURE' || check.state === 'ERROR') {
      return 'failing';
    }
    return check.state === 'PENDING' || check.state === 'EXPECTED'
      ? 'pending'
      : 'passing';
  }
  function checkRunSummary(check) {
    if (check.status !== 'COMPLETED') {
      return 'pending';
    }
    // SKIPPED/NEUTRAL aren't failures, a real run (path-filtered CI) can
    // skip most jobs and still be a passing PR.
    return ['FAILURE', 'CANCELLED', 'TIMED_OUT', 'ACTION_REQUIRED'].includes(
      check.conclusion
    )
      ? 'failing'
      : 'passing';
  }
  function summarizeChecks(rollup) {
    if (!Array.isArray(rollup) || rollup.length === 0) {
      return 'none';
    }
    let sawPending = false;
    for (const check of rollup) {
      const summary =
        check.__typename === 'StatusContext'
          ? statusContextSummary(check)
          : checkRunSummary(check);
      if (summary === 'failing') {
        return summary;
      }
      sawPending ||= summary === 'pending';
    }
    return sawPending ? 'pending' : 'passing';
  }

  function prState(pr) {
    if (pr.state === 'MERGED') {
      return 'merged';
    }
    if (pr.state === 'CLOSED') {
      return 'closed';
    }
    return pr.isDraft ? 'draft' : 'open';
  }

  const prInFlight = new Map();
  const prWaiters = [];
  let activePrRequests = 0;

  // biome-ignore lint/suspicious/useAwait: getWorktrees and prReviewStatus await this cache API and rely on synchronous setup failures rejecting.
  async function fetchPR(repo, name) {
    const key = `${repo}/${name}`;
    const cached = prCache.get(key);
    if (cached && Date.now() - cached.fetchedAt < PR_TTL) {
      return cached;
    }
    if (prInFlight.has(key)) {
      return prInFlight.get(key);
    }
    const pending = (async () => {
      if (activePrRequests >= 4) {
        await new Promise((release) => prWaiters.push(release));
      } else {
        activePrRequests += 1;
      }
      try {
        const raw = await runText(
          [
            'gh',
            'pr',
            'view',
            name,
            '--repo',
            REPO_META[repo]?.slug ?? repo,
            '--json',
            'number,title,url,state,isDraft,statusCheckRollup',
          ],
          { timeoutMs: 15_000 }
        );
        const pr = JSON.parse(raw);
        const state = prState(pr);
        const entry = {
          checks: summarizeChecks(pr.statusCheckRollup),
          fetchedAt: Date.now(),
          number: pr.number,
          state,
          title: pr.title,
          url: pr.url,
        };
        prCache.set(key, entry);
        return entry;
      } catch {
        const entry = { ...cached, fetchedAt: Date.now() };
        prCache.set(key, entry);
        return entry;
      } finally {
        prInFlight.delete(key);
        const next = prWaiters.shift();
        if (next) {
          next();
        } else {
          activePrRequests -= 1;
        }
      }
    })();
    prInFlight.set(key, pending);
    return pending;
  }

  // Repo-scoped sibling of fetchPR above -- one `gh pr list` call covers every
  // open PR on a repo (cheaper than the per-worktree `gh pr view` calls fetchPR
  // already makes). Deliberately its own Map, not folded into prCache: key
  // collision with prCache's `repo/name` keys is impossible (repo names can't
  // contain '/', see splitKey's own comment), but the value shapes differ
  // (single PR object vs {prs:[...]}), so a shared Map would just be a
  // readability trap. Unlike fetchPR, this is an explicit user-triggered
  // browse action (not a passive per-worktree badge), so "gh failed" and
  // "genuinely zero open PRs" need to stay distinguishable -- error is its own
  // field, not folded into an empty prs array.
  const repoPrsCache = new Map();

  async function fetchRepoPRs(repo) {
    const slug = REPO_META[repo]?.slug;
    if (!slug) {
      return { error: 'no GitHub repo configured for this project', prs: [] };
    }
    const cached = repoPrsCache.get(repo);
    if (cached && Date.now() - cached.fetchedAt < PR_TTL) {
      return cached;
    }
    // spawnText swallows a bad binary/non-zero exit/timeout into an empty
    // string rather than throwing (see its own comment in lib.js) and drops
    // stderr entirely, so a genuine `gh` failure never yields the real reason
    // -- only that it's not valid JSON. `gh pr list` printing zero PRs is
    // still a well-formed `[]`, so that case parses fine and never reaches
    // this branch; only a real call failure (bad auth, unreachable repo,
    // timeout) does, which is exactly the case worth a clear, actionable
    // message instead of a raw JSON syntax error.
    const raw = await runText([
      'gh',
      'pr',
      'list',
      '--repo',
      slug,
      '--state',
      'open',
      '--json',
      'number,title,url,headRefName,isDraft,statusCheckRollup,updatedAt,author',
      '--limit',
      '50',
    ]);
    let list;
    try {
      list = JSON.parse(raw);
    } catch {
      const entry = {
        error: `gh pr list failed for ${slug} -- check "gh auth status" and that the repo is reachable`,
        fetchedAt: Date.now(),
        prs: [],
      };
      repoPrsCache.set(repo, entry);
      return entry;
    }
    const entry = {
      error: null,
      fetchedAt: Date.now(),
      prs: list.map((p) => ({
        author: p.author?.login ?? null,
        branch: p.headRefName,
        checks: summarizeChecks(p.statusCheckRollup),
        isDraft: p.isDraft,
        number: p.number,
        title: p.title,
        updatedAt: p.updatedAt,
        url: p.url,
      })),
    };
    repoPrsCache.set(repo, entry);
    return entry;
  }

  // ── GitHub actions (create PR, draft/ready toggle) ───────────────────────────
  // Bun.spawn, not execFileSync/spawnSync -- same reason as everything else
  // converted this session (a blocking subprocess call freezes the whole
  // portal for every concurrent request, not just this one). Unlike
  // spawnText, this doesn't swallow a failure into '': create/ready are
  // mutating, user-triggered actions, so a real error (no commits to PR,
  // PR already exists, gh not authenticated) needs to surface as a message,
  // not silently look like nothing happened.
  async function spawnRun(cwd, args, timeout = 120_000) {
    const result = await checkedCommand(args, { cwd, timeoutMs: timeout });
    if (result.code !== 0 || result.timedOut || result.truncated) {
      throw new Error(
        result.stderr || `${args[0]} failed or returned incomplete output`
      );
    }
    return result.stdout;
  }

  // biome-ignore lint/suspicious/useAwait: HTTP and MCP mutation callers require synchronous target validation to reject through their Promise boundary.
  async function createPr(repo, name, source = 'portal') {
    return recordPortalMutation('pr-create', repo, name, source, () =>
      lifecycle.runOperation(worktreeTarget(repo, name), 'pr', async () => {
        const slug = REPO_META[repo]?.slug;
        if (!slug) {
          throw new Error('no GitHub repo configured for this project');
        }
        const wtDir = wtPath(repo, name);
        const branch = await worktreeBranch(repo, name, true);
        const base = await baseBranchRefAsync(repoPath(repo));
        const ahead = Number.parseInt(
          await spawnRun(wtDir, [
            'git',
            'rev-list',
            '--count',
            `${base}..HEAD`,
          ]),
          10
        );
        if (!Number.isFinite(ahead) || ahead < 1) {
          throw new Error(
            `no commits ahead of ${base} to open as a pull request`
          );
        }
        const existing = JSON.parse(
          await spawnRun(wtDir, [
            'gh',
            'pr',
            'list',
            '--repo',
            slug,
            '--head',
            branch,
            '--json',
            'url',
            '--limit',
            '1',
          ])
        );
        if (Array.isArray(existing) && existing.length) {
          throw new Error(`a pull request already exists for ${branch}`);
        }
        // gh pr create prompts interactively when the branch isn't fully pushed
        // yet -- with stdin ignored that would just hang, so push explicitly
        // first rather than relying on gh's own interactive fallback.
        await spawnRun(wtDir, ['git', 'push', '-u', 'origin', branch]);
        const url = await spawnRun(wtDir, [
          'gh',
          'pr',
          'create',
          '--fill',
          '--repo',
          slug,
          '--head',
          branch,
          '--base',
          base.replace(ORIGIN_PREFIX_RE, ''),
        ]);
        prCache.delete(`${repo}/${branch}`);
        return { ok: true, url };
      })
    );
  }

  // biome-ignore lint/suspicious/useAwait: HTTP and MCP mutation callers require synchronous target validation to reject through their Promise boundary.
  async function setPrReady(repo, name, ready, source = 'portal') {
    return recordPortalMutation('pr-ready', repo, name, source, () =>
      lifecycle.runOperation(worktreeTarget(repo, name), 'pr', async () => {
        const slug = REPO_META[repo]?.slug;
        if (!slug) {
          throw new Error('no GitHub repo configured for this project');
        }
        const branch = await worktreeBranch(repo, name, true);
        const args = ['pr', 'ready', branch, '--repo', slug];
        if (!ready) {
          args.push('--undo');
        }
        await spawnRun(wtPath(repo, name), ['gh', ...args]);
        prCache.delete(`${repo}/${branch}`);
        return { ok: true };
      })
    );
  }

  async function worktreeBranch(repo, name, mutation = false) {
    const wtDir = wtPath(repo, name);
    const branch = await spawnRun(wtDir, [
      'git',
      'symbolic-ref',
      '--short',
      'HEAD',
    ]);
    if (!branch || branch.startsWith('-')) {
      throw new Error('A checked-out branch is required');
    }
    if (mutation) {
      const defaultBranch = await spawnRun(repoPath(repo), [
        'git',
        'symbolic-ref',
        '--short',
        'HEAD',
      ]);
      if (new Set(['main', 'master', 'staging', defaultBranch]).has(branch)) {
        throw new Error('PR mutations require a feature branch');
      }
    }
    return branch;
  }

  // ── diff viewer (per-worktree, computed on demand, no cache unlike the
  // TTL'd caches above: this is fetched once when a human opens the Diff
  // section and on an explicit manual refresh, never on a poll loop, so
  // there's no repeated-request volume to protect against) ────────────────────

  // Guards against a genuinely huge diff hanging the request or the browser
  // that renders it, not a feature to make configurable:
  // - a single autogenerated file (a lockfile, a bundled build artifact) can
  //   run tens of thousands of changed lines; past this, show its real +/-
  //   counts but drop the hunk content instead of shipping it to the browser.
  const DIFF_FILE_LINE_CAP = 2000;
  // - a diff spanning hundreds of files (a wide rebase, a vendored directory)
  //   is already unreviewable as a flat list; cap what's sent and say how
  //   many more there are, rather than an unbounded array.
  const DIFF_MAX_FILES = 300;

  function readBinaryDiffHeader(cur, line) {
    cur.binary = true;
    const m = line.match(BINARY_DIFF_RE);
    if (m) {
      const a = m[1].replace(OLD_DIFF_PATH_PREFIX_RE, ''),
        b = m[2].replace(NEW_DIFF_PATH_PREFIX_RE, '');
      cur.file = b === '/dev/null' ? a : b; // deleted binary file, show the old path
    }
  }

  function readDiffFileHeader(cur, line) {
    if (line.startsWith('Binary files ')) {
      readBinaryDiffHeader(cur, line);
      return true;
    }
    if (!cur.sawHunk && line.startsWith('--- ')) {
      const p = line.slice(4).replace(OLD_DIFF_PATH_PREFIX_RE, '');
      if (p !== '/dev/null') {
        cur._oldPath = p;
      }
      return true;
    }
    if (!cur.sawHunk && line.startsWith('+++ ')) {
      const p = line.slice(4).replace(NEW_DIFF_PATH_PREFIX_RE, '');
      cur.file = p === '/dev/null' ? (cur._oldPath ?? cur.file) : p; // deleted file, show the old path
      return true;
    }
    return false;
  }

  function newDiffFile(line, seenFiles) {
    // "a/<path> b/<path>": greedy match backtracks to the rightmost
    // " b/", which is correct for the common case (identical paths, or a
    // path that doesn't itself contain the literal substring " b/").
    const m = line.slice('diff --git '.length).match(DIFF_HEADER_RE);
    return {
      additions: 0,
      deletions: 0,
      file: m ? m[2] : line.slice('diff --git '.length),
      hunks: [],
      sawHunk: false,
      // A file past DIFF_MAX_FILES gets sliced out of the response by
      // summarizeDiff regardless, so reuse the same skip-building path an
      // individually oversized file already takes below: count its real
      // additions/deletions for the summary total, don't materialize its
      // hunk content just to discard it a moment later.
      tooLarge: seenFiles > DIFF_MAX_FILES,
    };
  }

  // Hand-rolled unified-diff parser: no diff-parsing dependency in this
  // project, and the format is regular enough not to need one. Single
  // line-by-line state machine: `cur` is the file entry being built, `hunk`
  // the current hunk within it. `cur.sawHunk` disambiguates the one place the
  // format is genuinely ambiguous: a real content line that happens to start
  // with "--- " or "+++ " (e.g. removing a line of literal "-- foo") would
  // otherwise be mistaken for the file-header lines, which only ever appear
  // once, before the first "@@" of a file.
  function parseUnifiedDiff(raw) {
    if (!raw) {
      return [];
    }
    const files = [];
    let cur = null,
      hunk = null,
      oldLine = 0,
      newLine = 0,
      seenFiles = 0;

    function flushHunk() {
      // Once a file is flagged tooLarge its hunks are dropped at render time
      // anyway, so skip retaining them here: an oversized file's content
      // shouldn't sit in memory for the rest of the parse.
      if (cur && hunk && !cur.tooLarge) {
        cur.hunks.push(hunk);
      }
      hunk = null;
    }
    function flushFile() {
      flushHunk();
      if (cur) {
        files.push(cur);
      }
      cur = null;
    }

    function readDiffHunkLine(line) {
      // Counts and line numbers keep advancing even past the size cap (an
      // oversized file should still report an accurate total), only the
      // per-line array stops growing.
      if (line.startsWith('+')) {
        cur.additions += 1;
        if (cur.tooLarge) {
          newLine += 1;
        } else {
          hunk.lines.push({
            content: line.slice(1),
            newLine,
            type: 'add',
          });
          newLine += 1;
        }
      } else if (line.startsWith('-')) {
        cur.deletions += 1;
        if (cur.tooLarge) {
          oldLine += 1;
        } else {
          hunk.lines.push({
            content: line.slice(1),
            oldLine,
            type: 'remove',
          });
          oldLine += 1;
        }
      } else if (line.startsWith(' ')) {
        if (cur.tooLarge) {
          oldLine += 1;
          newLine += 1;
        } else {
          hunk.lines.push({
            content: line.slice(1),
            newLine,
            oldLine,
            type: 'context',
          });
          newLine += 1;
          oldLine += 1;
        }
      }
      // A "\ No newline at end of file" marker matches none of the above and is dropped, as intended.

      if (!cur.tooLarge && cur.additions + cur.deletions > DIFF_FILE_LINE_CAP) {
        cur.tooLarge = true;
      }
    }

    for (const line of raw.split('\n')) {
      if (line.startsWith('diff --git ')) {
        flushFile();
        seenFiles += 1;
        cur = newDiffFile(line, seenFiles);
        continue;
      }
      if (!cur) {
        continue; // stray output before the first file header, shouldn't happen
      }

      if (readDiffFileHeader(cur, line)) {
        continue;
      }
      const hm = line.match(DIFF_HUNK_RE);
      if (hm) {
        flushHunk();
        cur.sawHunk = true;
        oldLine = Number.parseInt(hm[1], 10);
        newLine = Number.parseInt(hm[2], 10);
        hunk = { header: line, lines: [] };
        continue;
      }
      if (!hunk) {
        continue; // metadata between file header and first hunk (index/mode/rename lines)
      }

      readDiffHunkLine(line);
    }
    flushFile();

    // Strip internal-only bookkeeping before handing back to the caller.
    return files.map(({ sawHunk, _oldPath, tooLarge, hunks, ...f }) =>
      tooLarge ? { ...f, hunks: [], tooLarge: true } : { ...f, hunks }
    );
  }

  // additions/deletions are summed across ALL parsed files (before the
  // DIFF_MAX_FILES slice) so the summary line stays accurate even when the
  // file list itself is truncated.
  function summarizeDiff(raw) {
    const all = parseUnifiedDiff(raw);
    let additions = 0,
      deletions = 0;
    for (const f of all) {
      additions += f.additions;
      deletions += f.deletions;
    }
    return {
      additions,
      deletions,
      files: all.slice(0, DIFF_MAX_FILES),
      totalFiles: all.length,
      truncatedFileCount: Math.max(0, all.length - DIFF_MAX_FILES),
    };
  }

  // Two separate diffs, not one merged one: they answer different questions.
  // "committed" is what this branch will actually contribute if merged, a
  // merge-base (three-dot) diff against the same base baseBranchRefAsync() already
  // resolves for ahead/behind, so it only shows what THIS branch did, not
  // whatever base moved on to since divergence. "uncommitted" is what's sitting
  // in the working tree right now and would be lost on a stash/checkout. `git
  // diff HEAD` alone covers both staged and unstaged changes in one pass, since
  // it compares the working tree directly against HEAD regardless of index state.
  async function computeDiff(repo, name) {
    const wtDir = wtPath(repo, name);
    const repoDir = repoPath(repo);
    const base = await baseBranchRefAsync(repoDir);

    // baseBranchRefAsync always returns a ref name, but that ref may not actually
    // resolve (origin/<default> never fetched, a stale remote-tracking branch).
    // spawnText swallows git's non-zero exit into an empty string the same way
    // a genuinely empty diff would come back, so without this check an
    // unresolvable base is indistinguishable from "this branch is fully
    // merged", so the UI would tell a worktree that's 60 commits ahead that it
    // has no changes. Check explicitly and let the frontend say so.
    const baseResolved = !!(await runText([
      'git',
      '-C',
      wtDir,
      'rev-parse',
      '--verify',
      '--quiet',
      base,
    ]));

    const [committedRaw, uncommittedRaw, untrackedRaw] = await Promise.all([
      baseResolved
        ? runText(['git', '-C', wtDir, 'diff', `${base}...HEAD`])
        : Promise.resolve(''),
      runText(['git', '-C', wtDir, 'diff', 'HEAD']),
      runText([
        'git',
        '-C',
        wtDir,
        'ls-files',
        '--others',
        '--exclude-standard',
      ]),
    ]);

    return {
      base,
      baseResolved,
      committed: summarizeDiff(committedRaw),
      uncommitted: {
        ...summarizeDiff(uncommittedRaw),
        untracked: untrackedRaw.split('\n').filter(Boolean),
      },
    };
  }

  // ── helpers ───────────────────────────────────────────────────────────────────

  // ponytail: ports.js's activePid() call in getWorktrees() used to run once per
  // worktree, every poll (3s idle / 800ms mid-start) — same execFileSync-freezes-the-
  // event-loop bug fetchPR() already had. Batch + short TTL cache, shared with /api/ports.
  const listenerObservation =
    options.listenerObservation ??
    createListenerObservation(probeListeningPorts);

  // biome-ignore lint/suspicious/useAwait: listPortsWithWorktree awaits injected listener observations, including synchronous probe failures.
  async function activePortsCached() {
    return listenerObservation.read();
  }

  // Shared by /api/ports and mcp-server.js's list_ports tool.
  async function listPortsWithWorktree() {
    const ports = await activePortsCached();
    if (listenerObservation.observation().state !== 'ready') {
      throw Object.assign(
        new Error(
          'Current listeners could not be checked. Previous ports are retained.'
        ),
        { code: 'LISTENER_PROBE_FAILED' }
      );
    }
    const registry = Object.fromEntries(
      portEntries(WORKSPACE).map((e) => [e.port, e.key])
    );
    return ports.map((p) => ({ ...p, worktree: registry[p.port] ?? null }));
  }

  function isPrunablePort(port) {
    return (
      Number.isInteger(port) &&
      ((port >= 3000 && port <= 3999) || (port >= 8288 && port <= 9287))
    );
  }

  function portOwnerChanged(pids, expected) {
    return expected !== null && pids.length > 0 && !pids.includes(expected);
  }

  async function killPort(port, expectedPid) {
    if (!isPrunablePort(port)) {
      return { error: 'port must be in 3000-3999 or 8288-9287', ok: false };
    }
    // lsof prints one pid per line when several processes hold the socket.
    const pids = (await (options.activePid ?? activePidAsync)(port))
      .split(WHITESPACE_RE)
      .filter(Boolean);
    const expected = expectedPid === undefined ? null : String(expectedPid);
    if (portOwnerChanged(pids, expected)) {
      return {
        code: 'PORT_OWNER_CHANGED',
        error: `port ${port} is now held by process ${pids.join(', ')}`,
        ok: false,
      };
    }
    // A container-published port's host-side "process" is the engine's own
    // port-forwarding helper, not the dev server itself — signaling it directly
    // isn't scoped to one container (reconcileDevServers hits this exact hazard
    // and already branches container-first for the same reason). Route through
    // the real stop path whenever the port belongs to a known, container-backed
    // worktree; the raw PID-kill fallback below stays for bare processes and for
    // genuinely-unregistered ports (setu prune's orphan-killing case).
    const owner = portEntries(WORKSPACE).find((e) => e.port === port);
    if (owner) {
      const stopped = await stopWorktree(owner.repo, owner.name, port);
      // Stop can fail because Setu cannot tie the listener to this worktree. The
      // caller named the exact process it saw, so signal that one process, but
      // never while a container may be publishing the port: that listener is the
      // engine's forwarding helper.
      if (
        stopped?.ok !== false ||
        expected === null ||
        !pids.includes(expected) ||
        (await containerState(composeProjectName(owner.repo, owner.name))) !==
          'dead'
      ) {
        return stopped;
      }
    }
    const pid = expected ?? pids[0];
    if (!pid) {
      return { error: 'nothing on that port', ok: false };
    }
    try {
      (options.signalProcess ?? process.kill)(
        Number.parseInt(pid, 10),
        'SIGTERM'
      );
      return { ok: true, pid: Number.parseInt(pid, 10) };
    } catch (e) {
      return { error: String(e), ok: false };
    }
  }

  // Resource usage — only ever called for `active` worktrees (no point
  // measuring what isn't running), so this never scales with the full 45+
  // worktree registry, only with maxConcurrentDevServers (default 3).
  const memorySamples = new Map();
  // biome-ignore lint/suspicious/useAwait: computeWorktrees awaits this sample boundary so synchronous injected memory probes reject consistently.
  async function activeMemMb(entry, key) {
    if (!entry) {
      return null;
    }
    let sample = memorySamples.get(key);
    if (!sample || sample.generation !== entry.generation) {
      sample = { generation: entry.generation };
      memorySamples.set(key, sample);
    }
    if (!sample.pending && (!sample.at || Date.now() - sample.at > 10_000)) {
      sample.at = Date.now();
      sample.pending = measureActiveMemMb(entry, key)
        .then((value) => {
          sample.memMb = value;
        })
        .catch(() => {
          sample.memMb = null;
        })
        .finally(() => {
          sample.pending = null;
        });
    }
    return sample.memMb ?? null;
  }

  async function measureActiveMemMb(entry, key) {
    if (!entry) {
      return null;
    }
    if (entry.container) {
      const [id] = (
        await runText(
          ['docker', 'compose', '-p', entry.container, 'ps', '-q'],
          { timeoutMs: 3000 }
        )
      ).split('\n')[0];
      if (!id) {
        return null;
      }
      const raw = await runText(
        ['docker', 'stats', '--no-stream', '--format', '{{.MemUsage}}', id],
        { timeoutMs: 3000 }
      );
      // "123.4MiB / 4GiB" — only the used side matters here
      const m = raw.match(MEMORY_USAGE_RE);
      if (!m) {
        return null;
      }
      return m[2] === 'GiB'
        ? Number.parseFloat(m[1]) * 1024
        : Number.parseFloat(m[1]);
    }
    if (entry.pid) {
      const rows = await worktreeProcessTree(key, entry);
      return rows.length
        ? rows.reduce((sum, row) => sum + row.rss, 0) / 1024
        : null;
    }
    return null;
  }

  let worktreesInFlight = null;
  function getWorktrees() {
    if (!worktreesInFlight) {
      worktreesInFlight = (
        options.computeWorktrees ?? computeWorktrees
      )().finally(() => {
        worktreesInFlight = null;
      });
    }
    return worktreesInFlight;
  }

  function worktreeBranchStatus(
    repo,
    name,
    wtDir,
    meta,
    branchMeta,
    pathToBranch
  ) {
    // Worktree directory name isn't reliably the branch name — join through
    // the real path->branch map, not an assumption (see
    // worktreeBranchMap's comment in lib.js for the confirmed live case
    // where this bit us).
    const branch = pathToBranch.get(resolve(wtDir)) ?? name;
    const branchUrl = meta.github ? `${meta.github}/tree/${branch}` : null;
    // Badges refresh in the background; an offline GitHub must not hold up
    // local start/stop state. fetchPR bounds and deduplicates the work.
    if (branch !== 'main') {
      fetchPR(repo, branch);
    }
    return {
      branch,
      branchUrl,
      gm: branchMeta.get(branch) ?? {
        ahead: 0,
        behind: 0,
        lastCommitAt: null,
      },
      pr: branch === 'main' ? null : prCache.get(`${repo}/${branch}`),
    };
  }

  async function computeWorktrees() {
    const activePorts = new Set((await activePortsCached()).map((p) => p.port));
    return Promise.all(
      portEntries(WORKSPACE).map(async ({ key, repo, name, port }) => {
        const slug = name.replace(/\//g, '-');
        const domain = localDomain(repo, name);
        const wtDir = wtPath(repo, name);
        const tunnelOn = tunnelEnabled(wtDir, _cfg);
        const meta = REPO_META[repo] ?? { github: null, label: repo };

        const iPort = inngestPort(port);
        const active = activePorts.has(port);
        const procEntry = lifecycle.snapshot(key);

        const { branchMeta, pathToBranch } = await repoGitMeta(repo, true);
        const { branch, branchUrl, gm, pr } = worktreeBranchStatus(
          repo,
          name,
          wtDir,
          meta,
          branchMeta,
          pathToBranch
        );
        const [dirty, memMb] = await Promise.all([
          fetchDirty(repo, name),
          active ? activeMemMb(procEntry, key) : Promise.resolve(null),
        ]);

        return {
          active,
          agent: agentStatus(repo, name),
          ahead: gm.ahead,
          behind: gm.behind,
          branch,
          branchUrl,
          container: procEntry?.container ?? null,
          convexActive: convexDevProcs.has(key),
          // Gate for whether the Convex section renders at all -- unlike
          // Inngest/Trigger (assumed available to every worktree), Convex is
          // only relevant to worktrees that actually have it configured.
          convexConfigured: cachedConvexDir(repo, name, wtDir) !== null,
          convexDeploy: convexDeployStatus(repo, name),
          // Directory birthtime, not a subprocess — statSync is essentially
          // free (no spawn) and APFS supports real birthtime. This is
          // creation time, not last-activity — don't conflate the two in the
          // UI (lastCommitAt is the "worked on" signal).
          createdAt: (() => {
            try {
              return Math.floor(statSync(wtDir).birthtimeMs / 1000);
            } catch {
              return null;
            }
          })(),
          dirty,
          domain,
          inngestActive: inngestProcs.has(key) || activePorts.has(iPort),
          inngestPort: iPort,
          key,
          label: meta.label,
          lastCommitAt: gm.lastCommitAt,
          lifecycleError: procEntry?.lastError ?? null,
          memMb,
          name,
          needsMigrationPrompt: needsMigrationPrompt(WORKSPACE, repo, name),
          netlifyDeploy: netlifyStatus(repo, name),
          // What a plain Start (no explicit --container/--bare) would resolve
          // to right now — lets the UI show this *before* the click instead of
          // the user finding out after, which is the exact blind spot that let
          // an established worktree get silently switched to a container.
          nextStartMode: defaultContainerMode(WORKSPACE, repo, name)
            ? 'container'
            : 'bare',
          operation: lifecycle.operationStatus(key),
          phase: procEntry?.phase ?? 'stopped',
          port,
          pr: pr?.url
            ? {
                checks: pr.checks,
                number: pr.number,
                state: pr.state,
                title: pr.title,
                url: pr.url,
              }
            : null,
          pubDomain: publicDomain(_cfg),
          queued: queuePosition(key) !== null,
          queuePosition: queuePosition(key),
          queueReason:
            lifecycle.queueSnapshot().find((item) => item.key === key)
              ?.reason ?? null,
          repo,
          // Configured custom sidecars (sidecars.json, repo-scoped) and
          // whether each is actually running for THIS worktree right now --
          // previously tracked correctly in sidecarProcs but never surfaced
          // to any client, so there was no way to see one was alive short of
          // reading its raw log file.
          sidecars: loadSidecars(WORKSPACE, repo).map((s) => ({
            active: sidecarProcs.has(`${key}/${s.name}`),
            name: s.name,
          })),
          slug,
          starting: !!procEntry?.reserved && !procEntry.stopping && !active,
          stopping: !!procEntry?.stopping,
          triggerActive: triggerProcs.has(key),
          tunnelOn,
          tunnelRunning: tunnelProc !== null && activeTunnelMap.has(key),
          vercelDeploy: vercelStatus(repo, name),
          wtDir,
        };
      })
    );
  }

  // ── dev server ────────────────────────────────────────────────────────────────
  function worktreeTarget(
    repo,
    name,
    port = getPort(WORKSPACE, repo, name),
    { registered = true } = {}
  ) {
    return Object.freeze({
      key: `${repo}/${name}`,
      name,
      port,
      project: composeProjectName(repo, name),
      repo,
      repoDir: repoPath(repo),
      wtDir: managedWorktreePath(WORKSPACE, repo, name, { registered }),
    });
  }

  function projectSetupTarget(name) {
    validateWorktreeNames(name, 'main');
    return Object.freeze({
      key: `${name}/main`,
      name: 'main',
      port: null,
      project: composeProjectName(name, 'main'),
      repo: name,
      repoDir: repoPath(name),
      wtDir: join(WORKSPACE, name, 'main'),
    });
  }

  // The observation must distinguish command failure from confirmed absence.
  const checkedCommand =
    options.command ??
    createCommandRunner((args, spawnOptions) => Bun.spawn(args, spawnOptions));

  async function readInventoryRuntime() {
    const ports = await listenerObservation.read().catch(() => []);
    const known = listenerObservation.observation().state === 'ready';
    const listening = new Set(ports.map((entry) => entry.port));
    const sidecarKeys = new Set(
      [...sidecarProcs.keys()].map((key) => key.slice(0, key.lastIndexOf('/')))
    );
    return new Map(
      portEntries(WORKSPACE).map(({ key, port }) => {
        const owned = lifecycle.snapshot(key);
        const supporting =
          inngestProcs.has(key) ||
          triggerProcs.has(key) ||
          convexDevProcs.has(key) ||
          sidecarKeys.has(key);
        let active;
        if (owned?.reserved || supporting) {
          active = true;
        } else if (known) {
          active = listening.has(port);
        } else {
          active = null;
        }
        return [
          key,
          {
            active,
            lastPortalActivityAt: lastSeenAt.get(key) ?? null,
            operation:
              queuePosition(key) === null
                ? lifecycle.operationStatus(key)
                : { kind: 'start', phase: 'queued' },
          },
        ];
      })
    );
  }

  const workspaceInventory =
    options.workspaceInventory ??
    createWorkspaceInventory({
      readRegistry: () => workspaceInventoryRegistry(WORKSPACE),
      readRuntime: readInventoryRuntime,
      run: checkedCommand,
    });

  async function linkedWorktree(repo, checkoutPath) {
    const result = await checkedCommand(
      ['git', '-C', repoPath(repo), 'worktree', 'list', '--porcelain', '-z'],
      { maxOutputBytes: 2 * 1024 * 1024, timeoutMs: 5000 }
    );
    if (result.code !== 0 || result.timedOut || result.truncated) {
      return false;
    }
    try {
      return parseLinkedWorktrees(result.stdout).some(
        (worktree) => worktree.path === resolve(checkoutPath)
      );
    } catch {
      return false;
    }
  }

  async function readAdoptionRecords() {
    try {
      const stat = await identityFs.lstat(ADOPTIONS_PATH);
      if (stat.isSymbolicLink() || !stat.isFile()) {
        throw new Error('Adoption state is not a regular file');
      }
      return JSON.parse(await identityFs.readFile(ADOPTIONS_PATH, 'utf8'));
    } catch (error) {
      if (error.code === 'ENOENT') {
        return {};
      }
      throw error;
    }
  }

  function writeAdoptionRecords(records) {
    return portalState.replaceText(
      ADOPTIONS_PATH,
      `${JSON.stringify(records, null, 2)}\n`,
      { mode: 0o600 }
    );
  }

  const worktreeAdoption = createWorktreeAdoption({
    assignPort: (repo, name) => assignPort(WORKSPACE, repo, name),
    inspectIdentity: async (repo, name, wtDir) =>
      inspectCheckoutIdentity(
        { name, repo, repoDir: repoPath(repo), wtDir },
        identityFs
      ),
    isLinkedWorktree: linkedWorktree,
    isRegisteredProject: (repo) => Object.hasOwn(loadProjects(WORKSPACE), repo),
    readRecords: readAdoptionRecords,
    registeredPort: (repo, name) => getPort(WORKSPACE, repo, name),
    validateTarget: (repo, name) =>
      worktreeTarget(repo, name, null, { registered: false }),
    withRecords: (task) => portalRouting.withRouting(task),
    withTarget: (target, task) => lifecycle.runOperation(target, 'adopt', task),
    writeRecords: writeAdoptionRecords,
    writeRouting: (repo, name, port) =>
      portalRouting.writeAdoptionRouting(repo, name, port),
  });

  function adoptWorktree(repo, name, path, source = 'portal') {
    return recordPortalMutation('worktree-adopt', repo, name, source, () =>
      worktreeAdoption.adopt({ name, path, repo })
    );
  }

  async function processEvidence(pid) {
    const [started, location] = await Promise.all([
      checkedCommand(['ps', '-p', String(pid), '-o', 'lstart=']),
      checkedCommand(['lsof', '-a', '-p', String(pid), '-d', 'cwd', '-Fn']),
    ]);
    const cwd = location.stdout
      .split('\n')
      .find((cwdLine) => cwdLine.startsWith('n'))
      ?.slice(1);
    if (
      started.code !== 0 ||
      location.code !== 0 ||
      !started.stdout ||
      !cwd ||
      started.timedOut ||
      location.timedOut
    ) {
      return null;
    }
    return { cwd: await identityFs.realpath(cwd), startedAt: started.stdout };
  }

  async function containerState(project) {
    try {
      const result = await checkedCommand([
        'docker',
        'ps',
        '--filter',
        `label=com.docker.compose.project=${project}`,
        '--format',
        '{{.ID}}',
      ]);
      if (result.code !== 0 || result.timedOut) {
        return 'unknown';
      }
      return result.stdout ? 'alive' : 'dead';
    } catch {
      return 'unknown';
    }
  }

  function worktreeContains(root, candidate) {
    const pathRelative = relative(root, candidate);
    return !(
      pathRelative === '..' ||
      pathRelative.startsWith(`..${sep}`) ||
      isAbsolute(pathRelative)
    );
  }

  async function discoverContainerRuntime(target) {
    if (!existsSync(dockerComposePath(target.wtDir))) {
      return null;
    }
    const state = await containerState(target.project);
    if (
      state !== 'alive' &&
      !(state === 'unknown' && (await activePidAsync(target.port)))
    ) {
      return null;
    }
    return {
      handle: {
        container: target.project,
        observedState: state,
        ownedGroup: false,
        pid: null,
      },
      state,
    };
  }

  function listenerRuntime(listener) {
    if (listener.code === 1 && !listener.stdout && !listener.stderr) {
      return 'dead';
    }
    if (listener.code !== 0 || listener.timedOut) {
      return 'unknown';
    }
    const pids = [
      ...new Set(listener.stdout.split(WHITESPACE_RE).filter(Boolean)),
    ];
    if (pids.length !== 1 || !PID_RE.test(pids[0])) {
      return 'unknown';
    }
    return Number(pids[0]);
  }

  async function discoverDevRuntime(target) {
    const container = await discoverContainerRuntime(target);
    if (container) {
      return container;
    }
    try {
      const listener = await checkedCommand([
        'lsof',
        '-nP',
        `-iTCP:${target.port}`,
        '-sTCP:LISTEN',
        '-t',
      ]);
      const runtime = listenerRuntime(listener);
      if (typeof runtime !== 'number') {
        return { state: runtime };
      }
      const pid = runtime;
      const cwd = await checkedCommand([
        'lsof',
        '-a',
        '-p',
        String(pid),
        '-d',
        'cwd',
        '-Fn',
      ]);
      const directory = cwd.stdout
        .split('\n')
        .find((cwdLine) => cwdLine.startsWith('n'))
        ?.slice(1);
      const root = await identityFs.realpath(target.wtDir);
      const listenerDir = directory && (await identityFs.realpath(directory));
      if (
        cwd.code !== 0 ||
        !listenerDir ||
        !worktreeContains(root, listenerDir)
      ) {
        return { state: 'unknown' };
      }
      const evidence = await processEvidence(pid);
      const evidenceDir =
        evidence?.cwd && (await identityFs.realpath(evidence.cwd));
      if (!(evidence && evidenceDir && worktreeContains(root, evidenceDir))) {
        return { state: 'unknown' };
      }
      return { handle: { evidence, ownedGroup: false, pid }, state: 'alive' };
    } catch {
      return { state: 'unknown' };
    }
  }

  const devRuntime =
    options.devRuntime ??
    createDevRuntime({
      clock: { now: () => performance.now(), sleep: (ms) => Bun.sleep(ms) },
      closeLog: closeSync,
      composeDown: composeDownAsync,
      containerState,
      discover: discoverDevRuntime,
      openLog: (target) => {
        touchLastSeen(target.repo, target.name);
        return openLogFd(target.repo, target.name, 'dev');
      },
      prepareBare: (target) => ({
        ...process.env,
        PORT: String(target.port),
        ...parseEnvFile(join(target.wtDir, '.envrc')),
      }),
      prepareContainer: (target, spec) =>
        writeDockerCompose(
          _cfg,
          target.repo,
          target.name,
          target.port,
          undefined,
          spec
        ),
      sidecarStops: [
        (target) => stopInngest(target.repo, target.name, target.port),
        (target) => stopTrigger(target.repo, target.name),
        (target) => stopConvexDev(target.repo, target.name),
        (target) => stopSidecars(target.repo, target.name),
      ],
      signal: (pid, signal) => process.kill(pid, signal),
      spawn: (args, spawnOptions) => Bun.spawn(args, spawnOptions),
      startSidecars: (target) =>
        startSidecars(target.repo, target.name, target.port),
      verifyHandle: async (runtimeHandle) => {
        if (!runtimeHandle.evidence) {
          return false;
        }
        try {
          return (
            JSON.stringify(await processEvidence(runtimeHandle.pid)) ===
            JSON.stringify(runtimeHandle.evidence)
          );
        } catch {
          return false;
        }
      },
    });

  async function observeSidecarEntry(entry) {
    if (!entry?.pid || entry.ownedGroup) {
      return devRuntime.observe(null, entry);
    }
    try {
      process.kill(entry.pid, 0);
    } catch (error) {
      if (error.code === 'ESRCH') {
        return 'dead';
      }
      return 'unknown';
    }
    if (entry.evidence) {
      const current = await processEvidence(entry.pid);
      if (
        current &&
        JSON.stringify(current) !== JSON.stringify(entry.evidence)
      ) {
        return 'dead';
      }
    }
    return devRuntime.observe(null, entry);
  }

  const lifecycle =
    options.lifecycle ??
    createWorktreeLifecycle({
      assertStorage: () => assertStorageHeadroom(WORKSPACE, readHostHealth),
      capacity: {
        refresh: async () => {
          const result = await checkedCommand([
            'docker',
            'info',
            '--format',
            '{{.ServerVersion}}|{{.OperatingSystem}}|{{.NCPU}}|{{.MemTotal}}',
          ]);
          const [version, engine, cpus, bytes] = result.stdout.split('|');
          return {
            available: result.code === 0 && !result.timedOut && !!version,
            cpus: Number(cpus) || null,
            engine: version ? engine || 'docker' : null,
            memMb: Math.floor(Number(bytes) / 1024 / 1024) || null,
          };
        },
      },
      clock: { clearTimeout, now: () => performance.now(), setTimeout },
      hasSupportingWork: supportingWorkActive,
      runtime: devRuntime,
      settings: _cfg,
      validateTarget: async (target, { kind } = {}) => {
        if (!configReconciled) {
          throw new Error(
            'Installed configuration is unresolved; retry settings recovery before mutation'
          );
        }
        if (kind === 'remove') {
          return;
        }
        await removals.assertCanMutate(target, { kind });
        if (
          [
            'start',
            'setup',
            'project-setup',
            'deploy',
            'sidecar-start',
            'sync',
            'review',
          ].includes(kind)
        ) {
          await assertStorageHeadroom(WORKSPACE, readHostHealth);
        }
        if (kind === 'project-setup') {
          return;
        }
        if (kind === 'setup') {
          if (!loadProjects(WORKSPACE)[target.repo]) {
            throw new Error('Project is not registered');
          }
          return;
        }
        if (kind === 'adopt') {
          return;
        }
        if (
          !target.port ||
          getPort(WORKSPACE, target.repo, target.name) !== target.port ||
          !existsSync(target.wtDir)
        ) {
          throw new Error('Worktree registration changed; refresh and retry');
        }
      },
      withTarget: (target, task) => portalState.withTargets([target], task),
    });

  function supportingWorkActive() {
    return (
      !configReconciled ||
      removals.pending().length > 0 ||
      memoryCheckRunning ||
      !!raycastDev ||
      !!tunnelProc ||
      tunnelTeardownUnknown ||
      activeTunnelMap.size > 0 ||
      mcpHasOwnedWork() ||
      [inngestProcs, triggerProcs, convexDevProcs, sidecarProcs].some(
        (map) => map.size > 0
      )
    );
  }
  let updateControl = createPortalUpdateControl({
    hasSupportingWork: supportingWorkActive,
    lifecycle,
    processIdentity: {},
  });
  const portalSockets = new Set();
  let updateShutdown = null;

  function stopPortalForUpdate(portalServer) {
    if (updateShutdown) {
      return;
    }
    // Admission is already owner-closed. Drain the acknowledgement and current
    // reads, close our own WebSockets, then exit. No unrelated daemon is signalled.
    updateShutdown = drainPortalForUpdate({
      closeConnections: () => {
        for (const socket of [...portalSockets]) {
          close(socket);
          socket.close(1001, 'Portal update');
        }
      },
      dispose: () => {
        runtimeTimers.clearInterval(logRetentionTimer);
        runtimeTimers.clearInterval(memoryCheckTimer);
        runtimeTimers.clearInterval(idleCheckTimer);
        managedAgents.dispose();
        lifecycle.dispose();
      },
      exit: (code) => process.exit(code),
      stopServer: () => portalServer.stop(false),
    }).catch(() => {
      console.error(
        'Portal update stop is unconfirmed; admission remains closed.'
      );
    });
  }

  function queuePosition(key) {
    const index = lifecycle
      .queueSnapshot()
      .findIndex((item) => item.key === key);
    return index === -1 ? null : index + 1;
  }

  // Boot adoption finishes before request handling begins. Unknown Docker state
  // keeps its project reservation; the engine's forwarding PID is never adopted.
  async function reconcileDevServers() {
    const entries = portEntries(WORKSPACE);
    for (let index = 0; index < entries.length; index += 8) {
      // biome-ignore lint/performance/noAwaitInLoops: each bounded observation batch must settle before the next to retain the eight-runtime concurrency cap.
      await Promise.all(
        entries.slice(index, index + 8).map(async ({ repo, name, port }) => {
          const target = worktreeTarget(repo, name, port);
          const found = await discoverDevRuntime(target);
          if (found.state === 'dead') {
            return;
          }
          // biome-ignore lint/suspicious/noUnnecessaryConditions: discovery is an injected runtime observer and may omit a handle for an unknown observation.
          const runtimeHandle = found.handle ?? {
            observedState: 'unknown',
            ownedGroup: false,
            pid: null,
          };
          lifecycle.adopt(target, runtimeHandle);
          openLogPaths.add(logPath(repo, name));
          touchLastSeen(repo, name);
        })
      );
    }
  }

  function startWorktree(repo, name, port, container = true) {
    return lifecycle.start(worktreeTarget(repo, name, port), container);
  }
  function stopWorktree(repo, name, port) {
    return lifecycle.stop(worktreeTarget(repo, name, port));
  }

  // Port + container-mode resolution wrapped around startWorktree/stopWorktree
  // so /api/start, /api/stop, and mcp-server.js's start_worktree/stop_worktree
  // tools share one implementation instead of three copies of this logic.
  // biome-ignore lint/suspicious/useAwait: HTTP and MCP start callers require synchronous target and lifecycle failures to reject their Promise.
  async function startWorktreeByName(repo, name, container, source = 'portal') {
    const port = getPort(WORKSPACE, repo, name);
    if (!port) {
      return { ok: false };
    }
    const useContainer =
      container === undefined
        ? defaultContainerMode(WORKSPACE, repo, name)
        : container !== false;
    if (
      container !== undefined &&
      needsMigrationPrompt(WORKSPACE, repo, name)
    ) {
      markMigrationPrompted(WORKSPACE, repo, name);
    }
    return recordPortalMutation(
      'worktree-start',
      repo,
      name,
      source,
      () => startWorktree(repo, name, port, useContainer),
      {
        pending: (result) =>
          result?.ok
            ? lifecycle.waitForStart(worktreeTarget(repo, name, port))
            : null,
      }
    );
  }

  // biome-ignore lint/suspicious/useAwait: HTTP and MCP stop callers require synchronous target and lifecycle failures to reject their Promise.
  async function stopWorktreeByName(repo, name, source = 'portal') {
    const port = getPort(WORKSPACE, repo, name);
    if (!port) {
      return { ok: false };
    }
    return recordPortalMutation('worktree-stop', repo, name, source, () =>
      stopWorktree(repo, name, port)
    );
  }

  // Shared by /api/sync and mcp-server.js's sync_worktree tool.
  // biome-ignore lint/suspicious/useAwait: HTTP and MCP sync callers require synchronous target and lifecycle failures to reject their Promise.
  async function syncWorktreeByName(repo, name, source = 'portal') {
    return recordPortalMutation('worktree-sync', repo, name, source, () =>
      lifecycle.runOperation(worktreeTarget(repo, name), 'sync', () =>
        syncWithBase(wtPath(repo, name), repoPath(repo))
      )
    );
  }

  // ── configurable per-project sidecars (workspace/sidecars.json) ──────────────
  // Generic version of what startInngest/startTrigger already do, for anything
  // project-specific that isn't Inngest or Trigger — a plain cloudflared tunnel,
  // a queue worker, whatever a future project needs. Not hardcoded to quivly-app.

  // Returns the names of any sidecars skipped for lacking approval, so the
  // start path (spawnWorktree/spawnContainer -> startWorktree) can surface it
  // to whoever asked for the start, instead of just silently not running.
  async function startSidecars(repo, name, port) {
    const wtDir = wtPath(repo, name);
    const skipped = [];
    for (const s of loadSidecars(WORKSPACE, repo)) {
      const key = `${repo}/${name}/${s.name}`;
      if (sidecarProcs.has(key)) {
        continue;
      }
      // New or edited since it was last approved: skip only this one sidecar,
      // the dev server and every other already-approved sidecar still start.
      // s.name guarded truthy: a nameless row (settings UI allows adding one
      // with a command but no name yet) still gets gated, just not reported by
      // an empty string the toast would render as "sidecar '' needs approval".
      if (!isSidecarApproved(WORKSPACE, repo, s)) {
        if (s.name) {
          skipped.push(s.name);
        }
        continue;
      }
      // biome-ignore lint/performance/noAwaitInLoops: each storage check follows the prior launch so later sidecars observe the current admitted state.
      await assertStorageHeadroom(WORKSPACE, readHostHealth);
      const fd = openLogFd(repo, name, `sidecar-${s.name}`);
      const env = { ...process.env, PORT: String(port), ...s.env };
      const proc = spawnWithLog(
        [s.command, ...(s.args ?? [])],
        { cwd: wtDir, detached: true, env },
        fd
      );
      const entry = wrapProc(proc);
      sidecarProcs.set(key, entry);
      watchOwnedProcessExit(
        sidecarProcs,
        key,
        entry,
        proc.exited,
        (ownedHandle) => devRuntime.observe(null, ownedHandle)
      );
    }
    return skipped;
  }

  async function stopSidecars(repo, name) {
    const prefix = `${repo}/${name}/`;
    const keys = [...sidecarProcs.keys()].filter((k) => k.startsWith(prefix));
    const results = await Promise.allSettled(
      keys.map(async (key) => {
        const entry = sidecarProcs.get(key);
        if (!entry.ownedGroup) {
          if ((await devRuntime.observe(null, entry)) === 'dead') {
            sidecarProcs.delete(key);
            return;
          }
          throw Object.assign(
            new Error(
              'Sidecar ownership is unconfirmed; stop it through its original owner, then retry Stop.'
            ),
            { code: 'SUPPORTING_PROCESS_UNOWNED' }
          );
        }
        await devRuntime.stopProcess(entry);
        if (sidecarProcs.get(key) === entry) {
          sidecarProcs.delete(key);
        }
      })
    );
    const failure = results.find((result) => result.status === 'rejected');
    if (failure) {
      throw failure.reason;
    }
  }

  // Uniform wrapper for both freshly-spawned (native Bun.Subprocess) and reconciled
  // (discovered-at-startup, PID only) sidecar entries — lets stop paths kill either
  // the same way, and lets a portal restart re-adopt a still-live sidecar instead of
  // losing track of it (inngestProcs/triggerProcs start as empty Maps every restart).
  function wrapProc(proc) {
    return { native: proc, ownedGroup: true, pid: proc.pid };
  }
  function wrapPid(pid) {
    return { native: null, ownedGroup: false, pid };
  }
  // ── inngest dev server ────────────────────────────────────────────────────────

  async function startInngest(repo, name, port) {
    const key = `${repo}/${name}`;
    if (inngestProcs.has(key)) {
      return { error: 'already running', ok: false };
    }
    const iPort = inngestPort(port);
    if (await activePidAsync(iPort)) {
      return {
        error: `port ${iPort} already in use (untracked process)`,
        ok: false,
      };
    }
    const fd = openLogFd(repo, name, 'inngest');
    const proc = spawnWithLog(
      [
        INNGEST_CLI,
        'dev',
        '-p',
        String(iPort),
        '-u',
        `http://localhost:${port}/api/inngest`,
        '--no-discovery',
      ],
      { detached: true },
      fd
    );
    const entry = wrapProc(proc);
    inngestProcs.set(key, entry);
    watchOwnedProcessExit(
      inngestProcs,
      key,
      entry,
      proc.exited,
      (ownedHandle) => devRuntime.observe(null, ownedHandle)
    );
    return { ok: true, port: iPort };
  }

  async function stopInngest(repo, name, port) {
    const key = `${repo}/${name}`;
    const entry = inngestProcs.get(key);
    if (entry) {
      if (entry.ownedGroup) {
        await devRuntime.stopProcess(entry);
      } else if ((await devRuntime.observe(null, entry)) === 'dead') {
        inngestProcs.delete(key);
      } else {
        throw Object.assign(
          new Error(
            'Inngest ownership is unconfirmed; stop it through its original owner, then retry Stop.'
          ),
          { code: 'SUPPORTING_PROCESS_UNOWNED' }
        );
      }
    }
    if (inngestProcs.get(key) === entry) {
      inngestProcs.delete(key);
    }
    // fall back to whatever's actually bound to the inngest port, same pattern as
    // stopWorktree — the tracked entry can be stale after a portal restart
    const iPort =
      port === null || port === undefined ? null : inngestPort(port);
    const pid = iPort ? await activePidAsync(iPort) : null;
    if (pid) {
      throw new Error(
        'Inngest listener ownership is unconfirmed; stop it through its original owner, then retry Stop.'
      );
    }
    if (!(entry || pid)) {
      return { error: 'not running', ok: false };
    }
    return { ok: true };
  }

  // ── trigger.dev dev server (per worktree, like inngest) ──────────────────────

  // trigger.dev doesn't bind a local port (it's a websocket client to the cloud
  // backend), so unlike inngest its "is this actually running" state can't be
  // cross-checked against lsof — startup reconciliation (below) is what keeps this
  // accurate across a portal restart instead.
  const TRIGGER_MAX_CONCURRENT_RUNS = 2;

  async function startTrigger(repo, name) {
    const key = `${repo}/${name}`;
    await (options.reconcileTriggerSidecars ?? reconcileTriggerSidecars)();
    if (triggerProcs.has(key)) {
      return { error: 'already running', ok: false };
    }
    const wtDir = wtPath(repo, name);
    const fd = openLogFd(repo, name, 'trigger');
    // trigger tasks import Supabase keys etc. from the shared .env.local at load time
    const env = { ...process.env, ...parseEnvFile(envLocalPath(repo, wtDir)) };
    const proc = spawnWithLog(
      [
        'bunx',
        `trigger.dev@${pinnedTriggerVersion(wtDir)}`,
        'dev',
        '--max-concurrent-runs',
        String(TRIGGER_MAX_CONCURRENT_RUNS),
      ],
      { cwd: wtDir, detached: true, env },
      fd
    );
    const entry = wrapProc(proc);
    triggerProcs.set(key, entry);
    watchOwnedProcessExit(
      triggerProcs,
      key,
      entry,
      proc.exited,
      (ownedHandle) => devRuntime.observe(null, ownedHandle)
    );
    return { ok: true };
  }

  async function stopTrigger(repo, name) {
    const key = `${repo}/${name}`;
    const entry = triggerProcs.get(key);
    if (!entry) {
      return { error: 'not running', ok: false };
    }
    if (!entry.ownedGroup) {
      if ((await devRuntime.observe(null, entry)) === 'dead') {
        if (triggerProcs.get(key) === entry) {
          triggerProcs.delete(key);
        }
        return { ok: true };
      }
      throw Object.assign(
        new Error(
          'Trigger ownership is unconfirmed; stop it through its original owner, then retry Stop.'
        ),
        { code: 'SUPPORTING_PROCESS_UNOWNED' }
      );
    }
    // group-kill, not entry.native?.kill() — trigger.dev v4.5.3's own SIGTERM handler
    // races ahead of and defeats the code path that would dispose its esbuild child
    // (source-verified), so signal the whole process group directly instead
    await devRuntime.stopProcess(entry);
    if (triggerProcs.get(key) === entry) {
      triggerProcs.delete(key);
    }
    return { ok: true };
  }

  // Startup-only: discover trigger dev processes already running (from before this
  // portal instance started) and adopt them into triggerProcs, keyed by matching
  // their cwd against a known worktree. Cheap because it only runs once at boot.
  function cwdFromProbe(probe) {
    if (probe.code !== 0) {
      return null;
    }
    return probe.stdout
      .split('\n')
      .find((cwdLine) => cwdLine.startsWith('n'))
      ?.slice(1);
  }

  async function reconcileTriggerSidecars() {
    let raw;
    const probe = await checkedCommand(['ps', '-eo', 'pid=,command=']);
    if (probe.code !== 0 || probe.timedOut || probe.truncated) {
      throw new Error(
        'Supporting-process discovery is unavailable; admission cannot open safely'
      );
    }
    raw = probe.stdout;
    const dirToKey = new Map(
      portEntries(WORKSPACE).map(({ key, repo, name }) => [
        wtPath(repo, name),
        key,
      ])
    );
    for (const line of raw.split('\n')) {
      const m = line.match(TRIGGER_PROCESS_RE);
      if (!m) {
        continue;
      }
      const pid = +m[1];
      // biome-ignore lint/performance/noAwaitInLoops: triggerProcs adoption is ordered; each cwd result can claim its key before a later PID is considered.
      const cwdProbe = await checkedCommand([
        'lsof',
        '-a',
        '-p',
        String(pid),
        '-d',
        'cwd',
        '-Fn',
      ]);
      const cwd = cwdFromProbe(cwdProbe);
      const key = cwd && dirToKey.get(cwd);
      if (key && !triggerProcs.has(key)) {
        const evidence = await processEvidence(pid);
        if (!evidence || evidence.cwd !== (await identityFs.realpath(cwd))) {
          throw new Error(
            'Trigger process identity is unknown; retry after reconciliation'
          );
        }
        triggerProcs.set(key, { ...wrapPid(pid), evidence });
      }
    }
  }

  // ── convex dev + deploy (per worktree) ──────────────────────────────────────
  // Architecturally different from every provider on either side of this
  // section: `npx convex dev` is a persistent watch process against a cloud dev
  // deployment, no local port to bind or cross-check, the same shape trigger.dev
  // has above -- while `npx convex deploy` is a separate, occasional one-shot
  // action, the same shape vercel/netlify have below. Modeled as both instead
  // of forced into either shape alone. No startup reconciliation (unlike
  // trigger's block above): matching an `npx convex dev` process back to its
  // worktree needs a regex loose enough to also match unrelated processes
  // sharing the same command line, and adopting the wrong pid means killGroup
  // later signals a process this portal never started. No reconciliation is
  // safer than a wrong one, so a convex dev process started before a portal
  // restart just shows as stopped until manually restarted -- startConvexDev's
  // own untracked-process guard below stops that from silently double-spawning
  // a second dev process against the same deployment when Start gets clicked.
  const convexDeploys = new Map(); // key: `${repo}/${name}` -> { deploying, ok, error, target, startedAt }

  function convexDeployStatus(repo, name) {
    return convexDeploys.get(`${repo}/${name}`) ?? null;
  }

  // Best-effort duplicate-start guard, not the same thing as the reconciliation
  // this section's own comment above says it deliberately skips: this never
  // adopts a pid into convexDevProcs and never kills anything, it only blocks
  // a Start click with an error, so a loose regex here can't cause the harm a
  // loose regex in an adopt-then-kill path could. Needed because convexDevProcs
  // alone can't see a dev process still alive from before a portal restart
  // (the Map starts empty every restart) -- same problem inngest's own
  // `activePid(iPort)` check on its bound port solves for itself, but convex
  // dev has no local port to check instead.
  async function convexDevAlreadyRunning(dir) {
    let raw;
    const probe = await checkedCommand(['ps', '-eo', 'pid=,command=']);
    if (probe.code !== 0 || probe.timedOut || probe.truncated) {
      throw new Error(
        'Supporting-process discovery is unknown; retry before Start'
      );
    }
    raw = probe.stdout;
    for (const line of raw.split('\n')) {
      const m = line.match(CONVEX_PROCESS_RE);
      if (!m) {
        continue;
      }
      // biome-ignore lint/performance/noAwaitInLoops: preserve ps-order failure and first-match behavior before deciding whether this worktree is already running.
      const cwd = await checkedCommand([
        'lsof',
        '-a',
        '-p',
        m[1],
        '-d',
        'cwd',
        '-Fn',
      ]);
      if (cwd.code !== 0) {
        throw new Error(
          'Supporting-process ownership is unknown; retry before Start'
        );
      }
      if (cwd.stdout.split('\n').includes(`n${dir}`)) {
        return true;
      }
    }
    return false;
  }

  async function startConvexDev(repo, name) {
    const key = `${repo}/${name}`;
    if (convexDevProcs.has(key)) {
      return { error: 'already running', ok: false };
    }
    const wtDir = wtPath(repo, name);
    const dir = convexDir(repo, wtDir);
    if (!dir) {
      return { error: 'Convex is not configured in this worktree', ok: false };
    }
    if (!commandExists('bunx')) {
      return { error: 'bunx not found on PATH', ok: false };
    }
    if (await convexDevAlreadyRunning(dir)) {
      return {
        error: `a convex dev process already appears to be running in ${dir} (untracked, likely from before a portal restart)`,
        ok: false,
      };
    }
    const fd = openLogFd(repo, name, 'convex');
    // stdin: 'ignore', not inherited -- detection only proves convex/ or
    // CONVEX_DEPLOYMENT exist, not that the saved auth token is still valid. A
    // stale token makes `convex dev` prompt to re-authenticate, the same
    // failure mode the vercel deploy block below spends its own comment on:
    // with no terminal attached, an inherited stdin would hang forever with
    // convexActive stuck true and an empty log, instead of failing the prompt
    // and exiting so the log actually explains what happened.
    const proc = spawnWithLog(
      ['bunx', 'convex', 'dev'],
      { cwd: dir, detached: true, stdin: 'ignore' },
      fd
    );
    const entry = wrapProc(proc);
    convexDevProcs.set(key, entry);
    watchOwnedProcessExit(
      convexDevProcs,
      key,
      entry,
      proc.exited,
      (ownedHandle) => devRuntime.observe(null, ownedHandle)
    );
    return { ok: true };
  }

  async function stopConvexDev(repo, name) {
    const key = `${repo}/${name}`;
    const entry = convexDevProcs.get(key);
    if (!entry) {
      const dir = convexDir(repo, wtPath(repo, name));
      if (dir && (await convexDevAlreadyRunning(dir))) {
        throw Object.assign(
          new Error(
            'An untracked Convex process still uses this worktree; stop it through its original owner, then retry Stop.'
          ),
          { code: 'SUPPORTING_PROCESS_UNOWNED' }
        );
      }
      return { error: 'not running', ok: false };
    }
    if (!entry.ownedGroup) {
      if ((await devRuntime.observe(null, entry)) === 'dead') {
        convexDevProcs.delete(key);
        return { ok: true };
      }
      throw Object.assign(
        new Error(
          'Convex ownership is unconfirmed; stop it through its original owner, then retry Stop.'
        ),
        { code: 'SUPPORTING_PROCESS_UNOWNED' }
      );
    }
    await devRuntime.stopProcess(entry);
    if (convexDevProcs.get(key) === entry) {
      convexDevProcs.delete(key);
    }
    return { ok: true };
  }

  // Deployment status outlives the one-shot CLI process. Admission and exact
  // destination comparison are owned by deploymentGuard before a launcher runs.
  const vercelDeploys = new Map();
  const netlifyDeploys = new Map();
  const deploymentEpoch = crypto.randomUUID();
  function vercelStatus(repo, name) {
    return vercelDeploys.get(`${repo}/${name}`) ?? null;
  }
  function netlifyStatus(repo, name) {
    return netlifyDeploys.get(`${repo}/${name}`) ?? null;
  }

  const launchDeployment = createDeploymentLauncher({
    appendLog: (repo, name, provider, text) =>
      appendFileSync(logPath(repo, name, provider), text),
    closeLog: closeSync,
    now: Date.now,
    onCompletion: ({ completion, request }) => {
      if (request.operationOutcome) {
        watchOutcome(request.operationOutcome, completion);
      }
    },
    openLog: openLogFd,
    spawn: (args, spawnOptions) => Bun.spawn(args, spawnOptions),
    stores: {
      convex: convexDeploys,
      netlify: netlifyDeploys,
      vercel: vercelDeploys,
    },
    tailError: (repo, name, provider) =>
      tailLog(repo, name, provider, 20)
        .lines.filter((line) => line.trim())
        .at(-1),
  });
  const providerResolver = createProviderResolver({
    // Project-local settings intentionally win over the inherited portal
    // environment. The key stays inside the launch binding and is never
    // returned by preflight/status or written to a log.
    // biome-ignore lint/suspicious/useAwait: provider resolution awaits this injected adapter and must receive synchronous file/path errors as rejections.
    convexDeployKey: async (checkout) => {
      const directory =
        convexDir(checkout.repo, checkout.wtDir) ??
        dirname(envLocalPath(checkout.repo, checkout.wtDir));
      const env = {
        ...process.env,
        ...parseEnvFile(join(directory, '.env')),
        ...parseEnvFile(join(directory, '.env.local')),
      };
      return typeof env.CONVEX_DEPLOY_KEY === 'string' &&
        env.CONVEX_DEPLOY_KEY.length > 0
        ? { value: env.CONVEX_DEPLOY_KEY }
        : null;
    },
    readJson: async (path) =>
      JSON.parse(await identityFs.readFile(path, 'utf8')),
    run: checkedCommand,
    tool: installedDeployTool,
  });
  const deploymentGuard = createDeploymentGuard({
    branch: async (target) => {
      const result = await checkedCommand([
        'git',
        '-C',
        target.wtDir,
        'symbolic-ref',
        '--quiet',
        '--short',
        'HEAD',
      ]);
      return result.code === 0 && !result.timedOut && !result.truncated
        ? result.stdout.trim()
        : null;
    },
    deploymentState: (target) => ({
      epoch: deploymentEpoch,
      providers: Object.fromEntries(
        Object.entries({
          convex: convexDeploys,
          netlify: netlifyDeploys,
          vercel: vercelDeploys,
        }).map(([provider, store]) => {
          const entry = store.get(target.key);
          return [
            provider,
            entry
              ? {
                  deploying: entry.deploying,
                  phase: entry.phase ?? null,
                  startedAt: entry.startedAt,
                  target: entry.target,
                }
              : null,
          ];
        })
      ),
    }),
    identity: (target) => inspectCheckoutIdentity(target, identityFs),
    launch: async (...args) => {
      await assertStorageHeadroom(WORKSPACE, readHostHealth);
      return launchDeployment(...args);
    },
    operation: (target) => lifecycle.operationStatus(target.key),
    resolveProvider: (request, target) => {
      const cwd =
        request.provider === 'convex'
          ? (convexDir(target.repo, target.wtDir) ?? target.wtDir)
          : target.wtDir;
      return providerResolver(request, {
        ...target,
        checkoutRoot: target.wtDir,
        wtDir: cwd,
      });
    },
    startOperation: (target, launch) =>
      lifecycle.startOperation(target, 'deploy', launch),
    target: worktreeTarget,
    validate: (target) => removals.assertCanMutate(target, { kind: 'deploy' }),
  });

  async function deployWithOutcome(
    provider,
    repo,
    name,
    target,
    expectedContext,
    source = 'portal'
  ) {
    const outcomeHandle = await operationOutcomes.accept({
      kind: `${provider}-deploy`,
      source,
      target: { name, repo },
    });
    const result = await deploymentGuard.dispatch({
      expectedContext,
      name,
      operationOutcome: outcomeHandle,
      provider,
      repo,
      target,
    });
    if (result?.deploying) {
      const running = await operationOutcomes.running(outcomeHandle);
      return {
        ...result,
        operationId: outcomeHandle.id,
        ...(outcomeHandle.outcomeRecorded === false ||
        running.outcomeRecorded === false
          ? { outcomeRecorded: false }
          : {}),
      };
    }
    return operationOutcomes.settle(outcomeHandle, result);
  }
  function deployToConvex(repo, name, target, expectedContext, source) {
    return deployWithOutcome(
      'convex',
      repo,
      name,
      target,
      expectedContext,
      source
    );
  }
  function deployToVercel(repo, name, target, expectedContext, source) {
    return deployWithOutcome(
      'vercel',
      repo,
      name,
      target,
      expectedContext,
      source
    );
  }
  function deployToNetlify(repo, name, target, expectedContext, source) {
    return deployWithOutcome(
      'netlify',
      repo,
      name,
      target,
      expectedContext,
      source
    );
  }

  // ── single cloudflared process with merged ingress ────────────────────────────

  async function writeMergedConf() {
    mkdirSync(TUNNEL_CONF_DIR, { recursive: true });
    const rules = [...activeTunnelMap.values()]
      .map(
        ({ pubDom, port }) =>
          `  - hostname: ${pubDom}\n    service: http://localhost:${port}`
      )
      .join('\n');
    installedStateValue(
      await portalState.replaceText(
        MERGED_CONF,
        `${[
          `tunnel: ${TUNNEL_NAME}`,
          `credentials-file: ${CF_CREDENTIALS}`,
          'protocol: http2',
          'ingress:',
          rules,
          '  - service: http_status:404',
        ].join('\n')}\n`
      )
    );
  }

  function openTunnelLog() {
    const dir = `${LOGS}/cloudflared`;
    mkdirSync(dir, { recursive: true });
    rotateLog(TUNNEL_LOG);
    appendFileSync(
      TUNNEL_LOG,
      `\n[${new Date().toISOString()}] ── session start ──\n`
    );
    return openSync(TUNNEL_LOG, 'a');
  }

  async function waitForTunnelExit(pattern) {
    const deadline = performance.now() + 5000;
    for (;;) {
      // biome-ignore lint/performance/noAwaitInLoops: Each pgrep result decides whether the next absence poll may run; parallel polls cannot confirm teardown.
      const remaining = await checkedCommand(['pgrep', '-f', pattern]);
      if (
        remaining.code === 1 &&
        !remaining.stdout &&
        !remaining.timedOut &&
        !remaining.truncated
      ) {
        return;
      }
      if (
        remaining.code !== 0 ||
        remaining.timedOut ||
        remaining.truncated ||
        performance.now() >= deadline
      ) {
        throw new Error(
          'Tunnel exit is unconfirmed; retry Disable before update cutover'
        );
      }
      // Wait only after a confirmed live process before the next serial absence poll.
      await Bun.sleep(50);
    }
  }

  // biome-ignore lint/suspicious/useAwait: tunnel callers await routing serialization and must receive synchronous state failures as rejections.
  async function restartTunnel() {
    return portalState.withRouting(async () => {
      tunnelTeardownUnknown = true;
      if (tunnelProc) {
        tunnelProc.kill();
      }
      // reap orphaned cloudflared from a previous portal — two replicas of the same
      // tunnel serve divergent ingress maps and randomly 404 (see comment above)
      const pattern = `(^|/)cloudflared --config ${MERGED_CONF.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}( |$)`;
      const reaped = await checkedCommand(['pkill', '-f', pattern]);
      if (![0, 1].includes(reaped.code) || reaped.timedOut) {
        throw new Error('Previous tunnel process teardown is unconfirmed');
      }
      await waitForTunnelExit(pattern);
      tunnelProc = null;
      tunnelTeardownUnknown = false;
      if (activeTunnelMap.size === 0) {
        return;
      }
      await writeMergedConf();
      const fd = openTunnelLog();
      try {
        tunnelProc = Bun.spawn(
          [
            CLOUDFLARED_BIN,
            '--config',
            MERGED_CONF,
            'tunnel',
            'run',
            TUNNEL_NAME,
          ],
          { stderr: fd, stdout: fd }
        );
      } finally {
        closeSync(fd);
      }
      const proc = tunnelProc;
      proc.exited.then(
        () => {
          if (tunnelProc === proc) {
            tunnelProc = null;
          }
        },
        () => {
          tunnelTeardownUnknown = true;
        }
      );
    });
  }

  // biome-ignore lint/suspicious/useAwait: routing callers await this mutation boundary so synchronous state errors reject consistently.
  async function addTunnelRoute(repo, name, pubDom, port) {
    return portalState.withRouting(async () => {
      activeTunnelMap.set(`${repo}/${name}`, { port, pubDom });
      await restartTunnel();
      return { ok: true };
    });
  }

  // biome-ignore lint/suspicious/useAwait: routing callers await this mutation boundary so synchronous state errors reject consistently.
  async function removeTunnelRoute(repo, name) {
    return portalState.withRouting(async () => {
      activeTunnelMap.delete(`${repo}/${name}`);
      await restartTunnel();
      return { ok: true };
    });
  }

  // ── per-worktree tunnel toggle ────────────────────────────────────────────────

  // The shared URL is serialized outside per-target admission. Internal helpers
  // do not reacquire this serializer, including when one enable evicts another.
  let tunnelChange = Promise.resolve();
  function serializeTunnel(change) {
    const result = tunnelChange.then(change);
    tunnelChange = result.catch(() => undefined);
    return result;
  }
  // biome-ignore lint/suspicious/useAwait: enable/disable callers await this serialized mutation boundary and require synchronous failures as rejections.
  async function changeTunnel(repo, name, port, enabled) {
    const target = worktreeTarget(repo, name, port);
    const apply = () =>
      applyTunnelConfiguration(enabled, {
        addRoute: () => addTunnelRoute(repo, name, publicDomain(_cfg), port),
        configure: () => configureWorktreeEnv(_cfg, repo, name, port, enabled),
        reload: () => reloadCaddyAsync(WORKSPACE),
        removeRoute: () => removeTunnelRoute(repo, name),
      });
    return lifecycle.snapshot(target.key)?.reserved
      ? lifecycle.restart(target, apply)
      : lifecycle.runOperation(target, 'tunnel', apply);
  }
  function withTunnelOwner(repo, name, claim) {
    return claimTunnelOwner(
      `${repo}/${name}`,
      {
        release: (key, { port: previousPort }) => {
          const previous = splitKey(key);
          return changeTunnel(
            previous.repo,
            previous.name,
            previousPort,
            false
          );
        },
        routes: () => activeTunnelMap.entries(),
        serialize: serializeTunnel,
      },
      claim
    );
  }
  function enableTunnel(repo, name, port) {
    return withTunnelOwner(repo, name, () =>
      changeTunnel(repo, name, port, true)
    );
  }
  function disableTunnel(repo, name, port) {
    return serializeTunnel(() => changeTunnel(repo, name, port, false));
  }

  function registeredWorktreePort(repo, name) {
    const port = getPort(WORKSPACE, repo, name);
    if (!port) {
      return {
        code: 'WORKTREE_NOT_FOUND',
        error: `No registered worktree for ${repo}/${name}`,
        ok: false,
      };
    }
    return port;
  }

  // biome-ignore lint/suspicious/useAwait: HTTP and MCP callers await this target-validation boundary and require rejected synchronous failures.
  async function enableTunnelByName(repo, name, source = 'portal') {
    const port = registeredWorktreePort(repo, name);
    return typeof port === 'number'
      ? recordPortalMutation('tunnel-enable', repo, name, source, () =>
          enableTunnel(repo, name, port)
        )
      : port;
  }

  // biome-ignore lint/suspicious/useAwait: HTTP and MCP callers await this target-validation boundary and require rejected synchronous failures.
  async function disableTunnelByName(repo, name, source = 'portal') {
    const port = registeredWorktreePort(repo, name);
    return typeof port === 'number'
      ? recordPortalMutation('tunnel-disable', repo, name, source, () =>
          disableTunnel(repo, name, port)
        )
      : port;
  }

  // biome-ignore lint/suspicious/useAwait: HTTP and MCP callers await this sidecar mutation boundary and require rejected synchronous failures.
  async function startInngestByName(repo, name, source = 'portal') {
    return recordPortalMutation(
      'inngest-start',
      repo,
      name,
      source,
      // biome-ignore lint/suspicious/useAwait: recordPortalMutation awaits this callback to convert synchronous worktree lookup failures into rejection.
      async () => {
        const port = registeredWorktreePort(repo, name);
        return typeof port === 'number'
          ? lifecycle.runOperation(
              worktreeTarget(repo, name, port),
              'sidecar-start',
              () => startInngest(repo, name, port)
            )
          : port;
      }
    );
  }

  // biome-ignore lint/suspicious/useAwait: HTTP and MCP callers await this sidecar mutation boundary and require rejected synchronous failures.
  async function stopInngestByName(repo, name, source = 'portal') {
    return recordPortalMutation(
      'inngest-stop',
      repo,
      name,
      source,
      // biome-ignore lint/suspicious/useAwait: recordPortalMutation awaits this callback to convert synchronous worktree lookup failures into rejection.
      async () => {
        const port = registeredWorktreePort(repo, name);
        return typeof port === 'number' ? stopInngest(repo, name, port) : port;
      }
    );
  }

  function startTriggerByName(repo, name, source = 'portal') {
    return recordPortalMutation(
      'trigger-start',
      repo,
      name,
      source,
      // biome-ignore lint/suspicious/useAwait: recordPortalMutation awaits this callback to convert synchronous worktree lookup failures into rejection.
      async () => {
        const port = registeredWorktreePort(repo, name);
        if (typeof port !== 'number') {
          return Promise.resolve(port);
        }
        return lifecycle.runOperation(
          worktreeTarget(repo, name),
          'sidecar-start',
          () => startTrigger(repo, name)
        );
      }
    );
  }

  function startConvexByName(repo, name, source = 'portal') {
    return recordPortalMutation(
      'convex-start',
      repo,
      name,
      source,
      // biome-ignore lint/suspicious/useAwait: recordPortalMutation awaits this callback to convert synchronous worktree lookup failures into rejection.
      async () => {
        const port = registeredWorktreePort(repo, name);
        if (typeof port !== 'number') {
          return Promise.resolve(port);
        }
        return lifecycle.runOperation(
          worktreeTarget(repo, name),
          'sidecar-start',
          () => startConvexDev(repo, name)
        );
      }
    );
  }

  // biome-ignore lint/suspicious/useAwait: HTTP and MCP callers await this sidecar mutation boundary and require rejected synchronous failures.
  async function stopTriggerByName(repo, name, source = 'portal') {
    return recordPortalMutation(
      'trigger-stop',
      repo,
      name,
      source,
      // biome-ignore lint/suspicious/useAwait: recordPortalMutation awaits this callback to convert synchronous worktree lookup failures into rejection.
      async () => {
        const port = registeredWorktreePort(repo, name);
        return typeof port === 'number' ? stopTrigger(repo, name) : port;
      }
    );
  }

  // biome-ignore lint/suspicious/useAwait: HTTP and MCP callers await this sidecar mutation boundary and require rejected synchronous failures.
  async function stopConvexByName(repo, name, source = 'portal') {
    return recordPortalMutation(
      'convex-stop',
      repo,
      name,
      source,
      // biome-ignore lint/suspicious/useAwait: recordPortalMutation awaits this callback to convert synchronous worktree lookup failures into rejection.
      async () => {
        const port = registeredWorktreePort(repo, name);
        return typeof port === 'number' ? stopConvexDev(repo, name) : port;
      }
    );
  }

  function listSidecarsForWorktree(repo, name) {
    const port = registeredWorktreePort(repo, name);
    if (typeof port !== 'number') {
      throw Object.assign(new Error(port.error), { code: port.code });
    }
    const key = `${repo}/${name}`;
    return loadSidecars(WORKSPACE, repo).map((sidecar) => ({
      active: sidecarProcs.has(`${key}/${sidecar.name}`),
      approved: isSidecarApproved(WORKSPACE, repo, sidecar),
      enabled: sidecar.enabled !== false,
      name: sidecar.name,
    }));
  }

  function sidecarLogs(repo, name, sidecar, lines) {
    const port = registeredWorktreePort(repo, name);
    if (typeof port !== 'number') {
      return { code: port.code, lines: [], state: 'read-error' };
    }
    if (
      !loadSidecars(WORKSPACE, repo).some((entry) => entry.name === sidecar)
    ) {
      return { code: 'SIDECAR_NOT_FOUND', lines: [], state: 'read-error' };
    }
    return tailLog(repo, name, `sidecar-${sidecar}`, lines);
  }

  // ── create / remove worktree ──────────────────────────────────────────────────

  const setupContexts = new Map();

  async function setupContextFor(target, repo, name, tunnel) {
    let context = setupContexts.get(target.key);
    if (context) {
      const current = await inspectCheckoutIdentity(target, identityFs);
      if (!(current.known && sameCheckoutIdentity(current, context.identity))) {
        throw new Error(
          'Setup checkout identity changed; automatic retry is blocked'
        );
      }
      if (context.tunnel !== !!tunnel) {
        throw new Error('Retry setup with the original tunnel choice');
      }
      if (context.ready) {
        return {
          kind: 'ready',
          result: {
            domain: context.res.localDom,
            ok: true,
            port: context.res.port,
            setup: 'ready',
          },
        };
      }
      return { context, kind: 'setup' };
    }
    if (getPort(WORKSPACE, repo, name)) {
      throw new Error(
        'Worktree is already registered; existing setup cannot be replayed without its original operation'
      );
    }
    context = { identity: null, ready: false, res: null, tunnel: !!tunnel };
    return { context, kind: 'setup' };
  }

  async function createSetupCheckout(context, target, repo, name, tunnel) {
    if (context.res) {
      return;
    }
    try {
      context.res = await libCreateWorktree(_cfg, repo, name, {
        readStorage: readHostHealth,
        tunnel,
      });
    } catch (error) {
      context.identity = await inspectCheckoutIdentity(target, identityFs);
      if (context.identity.known) {
        setupContexts.set(target.key, context);
      }
      throw error;
    }
    context.identity = await inspectCheckoutIdentity(target, identityFs);
    setupContexts.set(target.key, context);
  }

  async function createWorktree(repo, name, tunnel, source = 'portal') {
    const target = worktreeTarget(repo, name, null, { registered: false });
    const sharing = dependencySharingForTarget(_cfg, repo, name);
    const outcome = await operationOutcomes.accept({
      kind: 'setup-create',
      source,
      target: { name, repo },
    });
    const create = () =>
      withSetupAdmission({
        admission: portalB205.admission,
        operationId: outcome.id,
        target: { name, repo },
        task: async () => {
          const prepared = await setupContextFor(target, repo, name, tunnel);
          if (prepared.kind === 'ready') {
            return prepared.result;
          }
          const { context } = prepared;
          await createSetupCheckout(context, target, repo, name, tunnel);
          const { res } = context;
          if (tunnel) {
            await addTunnelRoute(repo, name, publicDomain(_cfg), res.port);
          }

          const launched = await startWorktreeSetupInstall(context, {
            assertStorage: () =>
              assertStorageHeadroom(WORKSPACE, readHostHealth),
            checkoutIdentity: context.identity,
            closeLog: closeSync,
            exists: existsSync,
            logLocation: logPath(repo, name, 'setup'),
            openLog: () => openLogFd(repo, name, 'setup'),
            progress: setupProgress,
            sharing,
            spawn: (args, spawnOptions) => Bun.spawn(args, spawnOptions),
            state: b205State,
            stopProcess: devRuntime.stopProcess,
            target: { name, repo },
          });
          // biome-ignore lint/suspicious/noUnnecessaryConditions: setup launch is collaborator output and completion is absent for immediate results.
          if (launched?.completion?.then) {
            const recording = await operationOutcomes.running(outcome);
            watchOutcome({ ...outcome, ...recording }, launched.completion);
          }
          return launched;
        },
        // Admission is obtained before this lifecycle lock. The lifecycle keeps
        // the target reserved through a known setup completion.
        withTarget: (_target, task) =>
          lifecycle.startOperation(target, 'setup', task),
      });
    // A completed setup retry only validates/returns its existing result. It must
    // not evict whichever checkout acquired the public URL after setup finished.
    let result;
    try {
      result = await (tunnel && !setupContexts.get(target.key)?.ready
        ? withTunnelOwner(repo, name, create)
        : create());
    } catch (error) {
      return operationOutcomes.settle(outcome, {
        // biome-ignore lint/suspicious/noUnnecessaryConditions: caught values are untrusted and can be null, primitives, or Error-like objects.
        code: error?.code,
        // biome-ignore lint/suspicious/noUnnecessaryConditions: caught values are untrusted and can be null, primitives, or Error-like objects.
        error: error?.message ?? String(error),
        ok: false,
      });
    }
    // A child setup completion is observed above. Refusals and synchronous
    // ready paths have an immediate known outcome.
    return result?.setup === 'installing'
      ? {
          ...result,
          operationId: outcome.id,
          ...(outcome.outcomeRecorded === false
            ? { outcomeRecorded: false }
            : {}),
        }
      : operationOutcomes.settle(outcome, result);
  }

  const removals =
    options.removals ??
    createRemovalController({
      admit: (target, task) =>
        lifecycle.runOperation(target, 'remove', async (controls) => {
          // Older standalone Trigger processes may have appeared after boot.
          await (
            options.reconcileTriggerSidecars ?? reconcileTriggerSidecars
          )();
          return task(controls);
        }),
      assertClean: (target, force) =>
        assertRemovableWorktree(_cfg, target.repo, target.name, { force }),
      capture: async (target, reason) => ({
        archive: {
          branch:
            (await repoGitMeta(target.repo)).pathToBranch.get(
              resolve(target.wtDir)
            ) ?? target.name,
          label: REPO_META[target.repo]?.label ?? target.repo,
          name: target.name,
          prUrl: prCache.get(target.key)?.url ?? null,
          reason: reason === 'merged' ? 'merged' : 'manual',
          removedAt: Math.floor(Date.now() / 1000),
          repo: target.repo,
        },
        identity: await inspectCheckoutIdentity(target, identityFs),
      }),
      now: () => Date.now(),
      observe: (record) =>
        observeRemovalCheckout(
          record,
          worktreeTarget(record.repo, record.name, record.port, {
            registered: false,
          }),
          { fs: identityFs, run: checkedCommand }
        ),
      randomId: () => crypto.randomUUID(),
      removeVolumes: async (record) => {
        const wtDir = managedWorktreePath(WORKSPACE, record.repo, record.name, {
          registered: false,
        });
        const path = dockerComposePath(wtDir);
        try {
          const stat = await identityFs.lstat(path);
          if (stat.isSymbolicLink() || !stat.isFile()) {
            throw new Error(
              'Compose output identity changed; volume cleanup is blocked'
            );
          }
        } catch (error) {
          if (error.code === 'ENOENT') {
            return;
          }
          throw error;
        }
        await composeDownAsync(
          composeProjectName(record.repo, record.name),
          path,
          ['-v']
        );
      },
      serialize: serializeTunnel,
      state: portalState,
      ...createRemovalRouting({
        fs: identityFs,
        onRemoved: (record) => {
          prCache.delete(record.key);
          lastSeenAt.delete(record.key);
          setupContexts.delete(record.key);
        },
        reloadCaddy:
          options.removalRouting?.reloadCaddy ??
          (() => reloadCaddyAsync(WORKSPACE)),
        removeTunnelRoute:
          options.removalRouting?.removeTunnelRoute ?? removeTunnelRoute,
        snippetPath: (record) =>
          caddySnippetPath(WORKSPACE, record.repo, record.name),
        syncHosts: () => portalRouting.syncHosts(),
        withRouting: (task) => portalState.withRouting(task),
      }),
      removeGit: async (record, force) => {
        const result = await checkedCommand(
          [
            'git',
            '-C',
            record.identity.repositoryPath,
            'worktree',
            'remove',
            ...(force ? ['--force'] : []),
            record.identity.checkoutPath,
          ],
          { timeoutMs: 120_000 }
        );
        if (result.code !== 0 || result.timedOut) {
          throw new Error(
            result.stderr || 'Git worktree removal failed or timed out'
          );
        }
      },
    });

  // biome-ignore lint/suspicious/useAwait: CLI and MCP removal callers await this mutation boundary and require synchronous target failures as rejections.
  async function removeWorktree(
    repo,
    name,
    // biome-ignore lint/style/useDefaultParameterLast: positional callers supply reason before force and operationId to preserve recorded-removal retry semantics.
    reason = 'manual',
    // biome-ignore lint/style/useDefaultParameterLast: positional callers supply force before operationId, whose omission selects normal removal behavior.
    force = false,
    operationId,
    source = 'portal'
  ) {
    return recordPortalMutation('worktree-remove', repo, name, source, () =>
      removals.remove(
        worktreeTarget(repo, name, getPort(WORKSPACE, repo, name), {
          registered: false,
        }),
        { force, operationId, reason }
      )
    );
  }

  // ── project registration ──────────────────────────────────────────────────────

  // biome-ignore lint/suspicious/useAwait: project-route callers await this lifecycle boundary and require synchronous validation failures as rejections.
  async function addProject({ github = '', name: nameArg = '', label = '' }) {
    // Normalise GitHub input → org/repo slug
    const slug = github
      .trim()
      .replace(GITHUB_HTTPS_PREFIX_RE, '')
      .replace(GITHUB_SSH_PREFIX_RE, '')
      .replace(GIT_SUFFIX_RE, '');

    const name = (nameArg.trim() || slug.split('/').at(-1) || '').replace(
      /[^a-zA-Z0-9._-]/g,
      '-'
    );
    if (!name) {
      return { error: 'repo name required', ok: false };
    }

    const label_ = label.trim() || name;
    const repoDir = repoPath(name);

    return lifecycle.runOperation(
      projectSetupTarget(name),
      'project-setup',
      async () => {
        if (loadProjects(WORKSPACE)[name]) {
          return { error: `${name} is already registered`, ok: false };
        }

        // Bare clone (existing) or bare init (new)
        mkdirSync(WORKSPACE, { recursive: true });
        if (slug && !existsSync(repoDir)) {
          // stdio: 'pipe' (cloneBareRepo's default is 'inherit', for the CLI path):
          // this is headless, there's no terminal to show clone progress to.
          await cloneBareRepoAsync(
            repoDir,
            `git@github.com:${slug}.git`,
            slug,
            {
              readStorage: readHostHealth,
            }
          );
        } else if (!slug) {
          mkdirSync(repoDir, { recursive: true });
          const initialized = await checkedCommand(
            ['git', '-C', repoDir, 'init', '--bare'],
            { timeoutMs: 120_000 }
          );
          if (initialized.code !== 0 || initialized.timedOut) {
            throw new Error(
              initialized.stderr || 'Bare repository initialization failed'
            );
          }
        }

        const base = await registerProject(WORKSPACE, {
          label: label_,
          name,
          slug,
        });
        REPO_META = loadProjects(WORKSPACE);

        return { base, label: label_, name, ok: true, slug: slug || null };
      }
    );
  }

  // ── open in Ghostty ───────────────────────────────────────────────────────────
  // Which coding CLIs to offer isn't hardcoded to one fixed list — AGENT_CLIS
  // (lib.js) is detected live via `which`, so this works for whatever's actually
  // installed on this machine, not just the tools one project happened to use.

  function openInGhostty(wtDir, tool) {
    const cmd =
      AGENT_CLIS[tool]?.bin ??
      loadCustomAgents(WORKSPACE).find((a) => a.id === tool)?.command;
    if (!cmd) {
      return { error: 'unknown tool', ok: false };
    }
    const script = `${tmpdir()}/qdev-${Date.now()}.sh`;
    writeFileSync(
      script,
      `#!/bin/zsh\nsource "$HOME/.zshrc"\ncd -- ${shellQuote(wtDir)} || exit\n${cmd}\nexec zsh -l\n`,
      { mode: 0o700 }
    );
    // Not a raw `ghostty` spawn — Ghostty's own --help is explicit that launching
    // the terminal from the CLI isn't supported on macOS ("use open -na
    // Ghostty.app"). The raw binary silently spawns a process with zero children
    // and never runs the script; /api/open still returned {ok:true} throughout
    // since Bun.spawn not throwing synchronously was the only check — confirmed
    // live via a marker-file test that only the `open -na` form actually executes.
    Bun.spawn(
      [
        'open',
        '-na',
        'Ghostty',
        '--args',
        `--working-directory=${wtDir}`,
        `--command=${script}`,
      ],
      { detached: true, stdio: ['ignore', 'ignore', 'ignore'] }
    );
    return { ok: true };
  }

  // Second-wave resource services use the same production composition for HTTP
  // and MCP. Terminal/session wiring joins this object in a later round.
  const b205State = portalState;
  const b205Target = async (repo, name) => {
    let port;
    try {
      port = getPort(WORKSPACE, repo, name);
      if (!port) {
        return null;
      }
      const target = worktreeTarget(repo, name, port);
      const checkoutIdentity = await inspectCheckoutIdentity(
        target,
        identityFs
      );
      return checkoutIdentity.known
        ? { ...target, checkoutIdentity }
        : {
            code: 'CHECKOUT_IDENTITY_UNKNOWN',
            error: 'Checkout identity could not be verified',
            ok: false,
          };
    } catch {
      return null;
    }
  };
  const portalB205 = createPortalResourceServices({
    branch: (target) => worktreeBranch(target.repo, target.name),
    callTool: callConnectedMcpTool,
    claims: () =>
      listWriterClaims(writerClaimPaths(WORKSPACE), { includeStale: true }),
    command: checkedCommand,
    config: async () => _cfg,
    entries: () =>
      portEntries(WORKSPACE).map((row) => ({
        ...row,
        wtDir: wtPath(row.repo, row.name),
      })),
    gitHead: async (target) => {
      const result = await checkedCommand([
        'git',
        '-C',
        target.wtDir,
        'rev-parse',
        'HEAD',
      ]);
      return result.code === 0 && !result.timedOut
        ? { state: 'known', value: result.stdout.trim() }
        : { state: 'unknown' };
    },
    githubTarget: (repo, name) => worktreeTarget(repo, name),
    hostHealth: readHostHealth,
    lifecycle,
    mcpTools: (serverId) => mcpStatuses()[serverId]?.tools ?? [],
    nativeRuntime: async (target) => {
      const matches = [
        inngestProcs.get(target.key),
        triggerProcs.get(target.key),
        convexDevProcs.get(target.key),
        ...[...sidecarProcs.entries()]
          .filter(([key]) => key.startsWith(`${target.key}/`))
          .map(([, entry]) => entry),
      ].filter(Boolean);
      for (const entry of matches) {
        // biome-ignore lint/performance/noAwaitInLoops: native runtime status is the first known observation in the established map order; parallel probes could change unknown/alive precedence.
        const observed = await observeSidecarEntry(entry);
        if (observed === 'unknown') {
          return 'unknown';
        }
        if (observed !== 'dead') {
          return 'alive';
        }
      }
      const listeners = await listenerObservation.read().catch(() => null);
      if (!Array.isArray(listeners)) {
        return 'unknown';
      }
      if (listeners.some((entry) => entry.port === target.port)) {
        return 'alive';
      }
      return 'dead';
    },
    resolveTarget: b205Target,
    state: b205State,
    trackedPaths: async (target, roots) => {
      const result = await checkedCommand([
        'git',
        '-C',
        target.wtDir,
        'ls-files',
        '--',
        ...roots,
      ]);
      return result.code === 0 && !result.timedOut
        ? { state: result.stdout.trim() ? 'tracked' : 'clean' }
        : { state: 'unknown' };
    },
  });
  const operationOutcomes = createPortalOperationOutcomes({
    events: portalB205.events,
  });
  const pendingOutcomes = new Set();
  function watchOutcome(outcomeHandle, completion) {
    const done = operationOutcomes.watch(outcomeHandle, completion);
    pendingOutcomes.add(done);
    done.finally(() => pendingOutcomes.delete(done));
    return done;
  }
  async function recordPortalMutation(
    kind,
    repo,
    name,
    source,
    invoke,
    { pending } = {}
  ) {
    const target =
      typeof repo === 'string' && typeof name === 'string'
        ? { name, repo }
        : null;
    const outcomeHandle = await operationOutcomes.accept({
      kind,
      source,
      target,
    });
    let result;
    try {
      result = await invoke(outcomeHandle.id);
    } catch (error) {
      return operationOutcomes.settle(outcomeHandle, {
        // biome-ignore lint/suspicious/noUnnecessaryConditions: caught values are untrusted and can be null, primitives, or Error-like objects.
        code: error?.code,
        // biome-ignore lint/suspicious/noUnnecessaryConditions: caught values are untrusted and can be null, primitives, or Error-like objects.
        error: error?.message ?? String(error),
        ok: false,
      });
    }
    const completion = pending?.(result);
    if (completion?.then) {
      const running = result?.queued
        ? await operationOutcomes.settle(outcomeHandle, result, {
            state: 'queued',
          })
        : await operationOutcomes.running(outcomeHandle);
      watchOutcome({ ...outcomeHandle, ...running }, completion);
      return {
        ...result,
        operationId: result?.operationId ?? outcomeHandle.id,
        ...(outcomeHandle.outcomeRecorded === false ||
        running.outcomeRecorded === false
          ? { outcomeRecorded: false }
          : {}),
      };
    }
    if (result?.queued) {
      return operationOutcomes.settle(outcomeHandle, result, {
        state: 'queued',
      });
    }
    return operationOutcomes.settle(outcomeHandle, result);
  }
  function sameCheckoutIdentity(left, right) {
    if (left === right) {
      return true;
    }
    if (Array.isArray(left) || Array.isArray(right)) {
      return (
        Array.isArray(left) &&
        Array.isArray(right) &&
        left.length === right.length &&
        left.every((value, index) => sameCheckoutIdentity(value, right[index]))
      );
    }
    if (
      !(left && right && typeof left === 'object' && typeof right === 'object')
    ) {
      return false;
    }
    const leftKeys = Object.keys(left).sort();
    const rightKeys = Object.keys(right).sort();
    return (
      leftKeys.length === rightKeys.length &&
      leftKeys.every(
        (key, index) =>
          key === rightKeys[index] &&
          sameCheckoutIdentity(left[key], right[key])
      )
    );
  }
  // Setup and managed-agent work intentionally share the resource composition's
  // admission and outcome journal.  Their factories are imported directly: the
  // older portal-wiring prototype adapters never own a runtime route.
  const setupProgress = createSetupProgress({
    newAttemptId: () => crypto.randomUUID(),
    state: b205State,
  });
  let setupRecovery = { ok: true };
  const managedAgents =
    options.managedAgents ??
    createManagedAgentServices({
      admission: portalB205.admission,
      operationEvents: portalB205.events,
      resolveTarget: async ({ repo, name }) => b205Target(repo, name),
      runtimeDir: join(WORKSPACE, '.setu-agent-runtime'),
      state: b205State,
    });
  const spans = createSpansRuntime({ root: options.spansRoot });
  const portalB205Composition = Object.freeze({
    ...spans,
    ...portalB205,
    agentSessions: (input) => managedAgents.listSessions(input),
    attention: (input) => managedAgents.listAttention(input),
    attentionFocus: (input) => managedAgents.focus(input),
    attentionHook: (input) => managedAgents.receiveHook(input),
    endAgentSession: (input) => managedAgents.endSession(input),
    handoffReview: (input) => managedAgents.handoff(input),
    headlessCancel: (input) => managedAgents.cancelRun(input),
    headlessResume: (input) => managedAgents.resumeRun(input),
    headlessRuns: (input) => managedAgents.listRuns(input),
    headlessStart: (input) => managedAgents.startRun(input),
  });

  async function retrySetupProgress(body, source = 'portal') {
    if (!setupRecovery.ok) {
      return setupRecovery;
    }
    const fresh = await b205Target(body.repo, body.name);
    if (!fresh) {
      return {
        code: 'WORKTREE_NOT_FOUND',
        error: 'No registered worktree matches this request',
        ok: false,
      };
    }
    const previous = setupProgress.get({ name: fresh.name, repo: fresh.repo });
    if (previous?.ok === false) {
      return previous;
    }
    if (!previous) {
      return {
        code: 'SETUP_PROGRESS_NOT_FOUND',
        error: 'No setup progress record exists',
        ok: false,
      };
    }
    const outcome = await operationOutcomes.accept({
      kind: 'setup-retry',
      source,
      target: { name: fresh.name, repo: fresh.repo },
    });
    const operationId = outcome.id;
    let completion;
    let recording = {};
    let result;
    try {
      result = await withSetupAdmission({
        admission: portalB205.admission,
        operationId,
        target: { name: fresh.name, repo: fresh.repo },
        task: async () => {
          const locked = await b205Target(body.repo, body.name);
          if (
            !(
              locked &&
              sameCheckoutIdentity(
                locked.checkoutIdentity,
                fresh.checkoutIdentity
              )
            )
          ) {
            return {
              code: 'CHECKOUT_IDENTITY_MISMATCH',
              error: 'The checkout identity changed before retry',
              ok: false,
            };
          }
          const accepted = await setupProgress.retry({
            attemptId: body.attemptId,
            checkoutIdentity: body.checkoutIdentity,
            logLocation: logPath(locked.repo, locked.name, 'setup'),
            stage: 'preparing',
            target: { name: locked.name, repo: locked.repo },
          });
          if (!accepted.ok) {
            return accepted;
          }
          const context = {
            identity: locked.checkoutIdentity,
            ready: false,
            res: {
              localDom: localDomain(locked.repo, locked.name),
              port: locked.port,
              wtDir: locked.wtDir,
            },
            tunnel: false,
          };
          const launched = await startWorktreeSetupInstall(context, {
            assertStorage: () =>
              assertStorageHeadroom(WORKSPACE, readHostHealth),
            checkoutIdentity: locked.checkoutIdentity,
            closeLog: closeSync,
            exists: existsSync,
            logLocation: logPath(locked.repo, locked.name, 'setup'),
            openLog: () => openLogFd(locked.repo, locked.name, 'setup'),
            progress: setupProgress,
            setupAttempt: accepted.record,
            sharing: dependencySharingForTarget(_cfg, locked.repo, locked.name),
            spawn: (args, spawnOptions) => Bun.spawn(args, spawnOptions),
            state: b205State,
            stopProcess: devRuntime.stopProcess,
            target: { name: locked.name, repo: locked.repo },
          });
          // biome-ignore lint/suspicious/noUnnecessaryConditions: setup launch is collaborator output and completion is absent for immediate results.
          if (launched?.completion?.then) {
            const { completion: launchedCompletion } = launched;
            completion = launchedCompletion;
            recording = await operationOutcomes.running(outcome);
            watchOutcome({ ...outcome, ...recording }, completion);
          }
          return launched;
        },
        withTarget: (_target, task) =>
          lifecycle.startOperation(fresh, 'setup', task),
      });
    } catch (error) {
      return operationOutcomes.settle(outcome, {
        // biome-ignore lint/suspicious/noUnnecessaryConditions: caught values are untrusted and can be null, primitives, or Error-like objects.
        code: error?.code,
        // biome-ignore lint/suspicious/noUnnecessaryConditions: caught values are untrusted and can be null, primitives, or Error-like objects.
        error: error?.message ?? 'Setup retry could not complete',
        ok: false,
      });
    }
    if (completion) {
      return {
        ...result,
        operationId,
        ...(outcome.outcomeRecorded === false ||
        recording.outcomeRecorded === false
          ? { outcomeRecorded: false }
          : {}),
      };
    }
    return operationOutcomes.settle(outcome, result);
  }

  // ── router ────────────────────────────────────────────────────────────────────

  // Collapses the try/catch-into-500 pattern repeated across the route
  // branches below. fn can be sync or async: `await` on a plain value is a
  // no-op, so this works uniformly for both.
  async function jsonTry(fn) {
    try {
      return Response.json(await fn());
    } catch (e) {
      return Response.json(
        {
          error: String(e),
          ok: false,
          ...(e.code ? { code: e.code } : {}),
          ...(typeof e.committed === 'boolean'
            ? { committed: e.committed }
            : {}),
          ...(e.phase ? { phase: e.phase } : {}),
          ...(typeof e.reconciled === 'boolean'
            ? { reconciled: e.reconciled }
            : {}),
          ...(safeStateCauseCode(e.causeCode)
            ? { causeCode: e.causeCode }
            : {}),
        },
        { status: 500 }
      );
    }
  }

  async function updateRoutes(req, pathname, method, portalServer) {
    if (pathname === '/api/update/capabilities' && method === 'GET') {
      return Response.json(updateControl.capabilities());
    }
    if (
      ![
        '/api/update/quiesce',
        '/api/update/reopen',
        '/api/update/stop',
      ].includes(pathname) ||
      method !== 'POST'
    ) {
      return null;
    }
    const body = await req.json().catch(() => null);
    let result;
    if (pathname.endsWith('/quiesce')) {
      result = updateControl.quiesce(body);
    } else if (pathname.endsWith('/reopen')) {
      result = await updateControl.reopen(body);
    } else {
      result = updateControl.prepareStop(body);
    }
    if (result.ok && pathname.endsWith('/stop')) {
      setImmediate(() => stopPortalForUpdate(portalServer));
    }
    return Response.json(result, { status: result.ok ? 200 : 409 });
  }

  function persistedAction(result) {
    installedStateValue(result);
    return {
      committed: result.committed,
      ok: true,
      reconciled: true,
      status: result.status,
      ...(result.warning ? { warning: result.warning } : {}),
    };
  }

  // Shared by /api/projects and mcp-server.js's list_projects tool.
  function listProjectsSummary() {
    return Object.entries(loadProjects(WORKSPACE)).map(([name, m]) => ({
      github: m.github,
      label: m.label,
      name,
    }));
  }

  // Each domain router below returns a Response for a route it owns, or null
  // to fall through to the next one. handle() tries them in order and 404s
  // if none match. Split by domain (worktree lifecycle, project/sweep,
  // settings, raycast) for size, not by rewriting the dispatch logic itself.
  async function projectRoutes(req, pathname, method, portalServer) {
    if (pathname === '/api/projects') {
      return Response.json(listProjectsSummary());
    }

    if (method === 'POST' && pathname === '/api/project/add') {
      const body = await req.json().catch(() => ({}));
      return jsonTry(() => addProject(body));
    }

    if (method === 'POST' && pathname === '/api/project/remove') {
      const body = await req.json().catch(() => ({}));
      return jsonTry(async () =>
        persistedAction(await removeProject(WORKSPACE, body.name))
      );
    }

    // Sweep: finds plain git clones already on disk that were never brought
    // into Setu's bare+worktree layout. GET runs the (async, batched) home
    // directory walk — see discoverReposAsync's own comment for why this can't
    // be the synchronous execFileSync path the CLI uses. POST imports one.
    if (pathname === '/api/sweep') {
      // Bun.serve's default idleTimeout is 10s — a full $HOME walk (especially
      // over iCloud-hosted repos, which stall on materialization) genuinely
      // takes longer than that. Without this, Bun silently drops the
      // connection mid-scan and the client sees an empty response, not an
      // error (confirmed live: curl got "Empty reply from server" at ~9s
      // while the scan kept running server-side unharmed).
      portalServer?.timeout(req, 0);
      return jsonTry(() => discoverReposAsync(HOME));
    }

    if (method === 'POST' && pathname === '/api/sweep/import') {
      const body = await req.json().catch(() => ({}));
      const { name, remoteUrl, label } = body;
      if (!(name && remoteUrl)) {
        return Response.json({
          error: 'name and remoteUrl required',
          ok: false,
        });
      }
      // Same guard addProject() already uses — a conflicting candidate should
      // never reach here (the UI disables those rows), but importRepo() itself
      // would otherwise silently no-op against the wrong existing project.
      if (loadProjects(WORKSPACE)[name]) {
        return Response.json({
          error: `${name} is already registered`,
          ok: false,
        });
      }
      return jsonTry(() =>
        lifecycle.runOperation(
          projectSetupTarget(name),
          'project-setup',
          async () => {
            if (loadProjects(WORKSPACE)[name]) {
              return { error: `${name} is already registered`, ok: false };
            }
            await importRepo(
              _cfg,
              { label, name, remoteUrl },
              { readStorage: readHostHealth }
            );
            REPO_META = loadProjects(WORKSPACE);
            return { ok: true };
          }
        )
      );
    }

    return null;
  }

  async function saveSettingsRequest(req) {
    const body = await req.json().catch(() => ({}));
    try {
      const patch = Object.fromEntries(
        ['maxConcurrentDevServers', 'containerMemoryLimit', 'containerCpuLimit']
          .filter((key) => body[key] !== null && body[key] !== undefined)
          .map((key) => [key, body[key]])
      );
      resourceSettings({ ..._cfg, ...patch });
      const committed = await portalState.update('config', (current) => {
        const next = { ...current, ...patch };
        resourceSettings(next);
        return next;
      });
      configReconciled = committed.reconciled === true;
      _cfg = installedStateValue(committed);
      await lifecycle.updateSettings(_cfg);
      return Response.json({
        ...persistedAction(committed),
        settings: {
          containerCpuLimit: _cfg.containerCpuLimit,
          containerMemoryLimit: _cfg.containerMemoryLimit,
          maxConcurrentDevServers: _cfg.maxConcurrentDevServers,
        },
      });
    } catch (error) {
      return Response.json(
        {
          error: error.message,
          ok: false,
          ...(error.code ? { code: error.code } : {}),
          ...(typeof error.committed === 'boolean'
            ? { committed: error.committed }
            : {}),
          ...(error.phase ? { phase: error.phase } : {}),
          ...(safeStateCauseCode(error.causeCode)
            ? { causeCode: error.causeCode }
            : {}),
        },
        { status: 400 }
      );
    }
  }

  async function settingsResource(req, method) {
    if (method === 'GET') {
      if (!configReconciled) {
        const installed = portalState.read('config');
        resourceSettings(installed);
        if (installed.workspace !== WORKSPACE) {
          throw new Error(
            'Configured workspace changed; a reviewed portal restart is required.'
          );
        }
        _cfg = installed;
        configReconciled = true;
        try {
          await lifecycle.updateSettings(installed);
        } catch (error) {
          configReconciled = false;
          throw error;
        }
      }
      return Response.json({
        containerCpuLimit: _cfg.containerCpuLimit ?? 2,
        containerMemoryLimit: _cfg.containerMemoryLimit ?? '4g',
        docker: await cachedContainerRuntime(),
        mac: macCapacity(),
        maxConcurrentDevServers: lifecycle.status().max,
      });
    }
    if (method === 'POST') {
      return saveSettingsRequest(req);
    }
    return null;
  }

  async function sidecarSettingsResource(req, method) {
    const p = new URL(req.url).searchParams;
    if (method === 'GET') {
      const repo = p.get('repo') ?? '';
      // `approved` is computed, not stored on the sidecar itself, so the
      // settings UI can show a per-row badge without a second request.
      return Response.json(
        loadAllSidecars(WORKSPACE, repo).map((s) => ({
          ...s,
          approved: isSidecarApproved(WORKSPACE, repo, s),
        }))
      );
    }
    if (method === 'POST') {
      const body = await req.json().catch(() => ({}));
      return jsonTry(async () => {
        // Strip the computed `approved` field the GET above adds, in case
        // the caller round-trips what it fetched. sidecars.json only ever
        // owns name/enabled/command/args/env, approval lives in its own file.
        const sidecars = (body.sidecars ?? []).map(({ approved, ...s }) => s);
        return persistedAction(
          await saveSidecars(WORKSPACE, body.repo, sidecars)
        );
      });
    }
    return null;
  }

  async function approveSidecarRequest(req) {
    const body = await req.json().catch(() => ({}));
    if (typeof body.command !== 'string') {
      return Response.json({
        error: 'Sidecar command is required for approval',
        ok: false,
      });
    }
    return jsonTry(async () =>
      persistedAction(
        await approveSidecar(
          WORKSPACE,
          body.repo,
          body.name,
          body.command,
          body.args
        )
      )
    );
  }

  async function fileSyncSettingsResource(req, method) {
    const p = new URL(req.url).searchParams;
    if (method === 'GET') {
      return Response.json(loadFileSyncGlobs(WORKSPACE, p.get('repo') ?? ''));
    }
    if (method === 'POST') {
      const body = await req.json().catch(() => ({}));
      return jsonTry(async () =>
        persistedAction(
          await saveFileSyncGlobs(WORKSPACE, body.repo, body.globs ?? [])
        )
      );
    }
    return null;
  }

  async function customAgentsResource(req, method) {
    if (method === 'GET') {
      return Response.json(loadCustomAgents(WORKSPACE));
    }
    if (method === 'POST') {
      const body = await req.json().catch(() => ({}));
      return jsonTry(async () =>
        persistedAction(await saveCustomAgents(WORKSPACE, body.agents ?? []))
      );
    }
    return null;
  }

  async function mcpServersResource(req, method) {
    if (method === 'GET') {
      const statuses = mcpStatuses();
      return Response.json(
        loadMcpServers(WORKSPACE).map((s) => ({
          ...s,
          ...(statuses[s.id] ?? {
            error: null,
            status: 'disconnected',
            stderrTail: [],
            tools: [],
          }),
        }))
      );
    }
    if (method === 'POST') {
      const body = await req.json().catch(() => ({}));
      return jsonTry(async () =>
        persistedAction(await saveMcpServers(WORKSPACE, body.servers ?? []))
      );
    }
    return null;
  }

  async function connectMcpRequest(req) {
    const body = await req.json().catch(() => ({}));
    const server = loadMcpServers(WORKSPACE).find((s) => s.id === body.id);
    if (!server) {
      return Response.json(
        { error: 'server not found', ok: false },
        { status: 404 }
      );
    }
    const source = ['ui', 'cli', 'raycast'].includes(
      req.headers.get('x-setu-source')
    )
      ? req.headers.get('x-setu-source')
      : 'portal';
    let completion;
    return Response.json(
      await recordPortalMutation(
        'mcp-connect',
        null,
        null,
        source,
        () => {
          completion = connectMcpServer(server, WORKSPACE).then(() => {
            const status = mcpStatuses()[server.id];
            if (status?.status === 'connected') {
              return { ok: true };
            }
            if (status?.status === 'error') {
              return { code: 'MCP_CONNECT_FAILED', ok: false };
            }
            return {
              code: 'MCP_CONNECTION_PENDING',
              ok: false,
              state: 'unknown',
            };
          });
          return { ok: true, state: 'running' };
        },
        { pending: () => completion }
      )
    );
  }

  async function mcpCallbackRequest(req, pathname) {
    const serverId = pathname.slice('/api/mcp/oauth/callback/'.length);
    const p = new URL(req.url).searchParams;
    if (p.get('error')) {
      return mcpCallbackHtml(
        'Authorization denied',
        `The authorization server reported: ${p.get('error_description') ?? p.get('error')}. You can close this tab and try again from Setu.`
      );
    }
    const code = p.get('code');
    const state = p.get('state');
    if (!(code && state)) {
      return mcpCallbackHtml(
        'Bad callback',
        'Missing code or state parameter. You can close this tab and try again from Setu.'
      );
    }
    const server = loadMcpServers(WORKSPACE).find((s) => s.id === serverId);
    if (!server) {
      return mcpCallbackHtml(
        'Unknown server',
        'This server is no longer configured in Setu. You can close this tab.'
      );
    }
    const result = await recordPortalMutation(
      'mcp-authorize',
      null,
      null,
      'portal',
      () => finishMcpAuth(server, code, state)
    );
    if (!result.ok) {
      return mcpCallbackHtml(
        'Authorization failed',
        `${result.error} You can close this tab and try again from Setu.`
      );
    }
    return mcpCallbackHtml(
      'Authorized',
      'You can close this tab and return to Setu.'
    );
  }

  function prReviewStatusRequest(req) {
    const p = new URL(req.url).searchParams;
    const repo = p.get('repo'),
      name = p.get('name');
    if (!(repo && name)) {
      return Response.json(
        { error: 'repo and name required', ok: false },
        { status: 400 }
      );
    }
    return jsonTry(() => prReviewStatus(repo, name));
  }

  async function prReviewRunRequest(req) {
    const body = await req.json().catch(() => ({}));
    const { repo, name, skill } = body;
    if (!(repo && name)) {
      return Response.json(
        { error: 'repo and name required', ok: false },
        { status: 400 }
      );
    }
    if (!PR_REVIEW_SKILLS.has(skill)) {
      return Response.json(
        { error: 'unknown skill', ok: false },
        { status: 400 }
      );
    }
    const source = ['ui', 'cli', 'raycast'].includes(
      req.headers.get('x-setu-source')
    )
      ? req.headers.get('x-setu-source')
      : 'portal';
    return jsonTry(() => prReviewRun(repo, name, skill, source));
  }

  async function prReviewArtifactRequest(req) {
    const p = new URL(req.url).searchParams;
    const repo = p.get('repo'),
      name = p.get('name'),
      skill = p.get('skill');
    if (!(repo && name)) {
      return Response.json(
        { error: 'repo and name required', ok: false },
        { status: 400 }
      );
    }
    if (!PR_REVIEW_SKILLS.has(skill)) {
      return Response.json(
        { error: 'unknown skill', ok: false },
        { status: 400 }
      );
    }
    const pr = await fetchPR(repo, await worktreeBranch(repo, name));
    if (!pr.number) {
      return new Response('No pull request for this worktree', {
        status: 404,
      });
    }
    const slug = REPO_META[repo]?.slug ?? repo;
    const artifact = findLatestArtifact(slug, pr.number, skill, null);
    const path =
      artifact &&
      artifactHtmlPath(
        slug,
        pr.number,
        skill,
        artifact.snapshot,
        artifact.htmlFile
      );
    if (!(path && existsSync(path))) {
      return new Response('No report generated yet', { status: 404 });
    }
    return new Response(Bun.file(path), {
      headers: {
        'Content-Security-Policy':
          "sandbox allow-scripts; connect-src 'none'; form-action 'none'; base-uri 'none'",
      },
    });
  }

  // biome-ignore lint/suspicious/useAwait: Preserve the route handler's rejected-promise error boundary.
  async function settingsRoutes(req, pathname, method, portalServer) {
    if (pathname === '/api/agents') {
      return Response.json(detectAgentClis(WORKSPACE));
    }

    // Anthropic/OpenAI cost_report calls are real external network round
    // trips (2 providers, each potentially paginated) — same idleTimeout
    // override /api/sweep documents, for the same reason.
    if (pathname === '/api/costs' && method === 'GET') {
      portalServer?.timeout(req, 0);
      return jsonTry(() => getCostsSummary());
    }

    // Both GET (read current values + real hardware/Docker capacity for the
    // settings UI's ranges) and POST (persist a change) live on one path.
    // Handled here, before worktreeRoutes' generic POST block, so a POST to
    // this path returns from here and never falls through to it.
    if (pathname === '/api/settings') {
      return settingsResource(req, method);
    }

    // Sidecars: GET returns every entry (including disabled) for the settings
    // UI to edit; POST replaces the whole per-repo list — the caller always
    // sends the full array back (add/remove/toggle are all client-side edits
    // to that array), matching saveSidecars()'s per-repo-overwrite shape.
    if (pathname === '/api/sidecars') {
      return sidecarSettingsResource(req, method);
    }

    // Records the CURRENT command/args for one sidecar as approved, looked up
    // fresh from sidecars.json rather than trusted from the request body, so a
    // stale client can't approve a command it no longer matches.
    if (pathname === '/api/sidecar-approvals/approve' && method === 'POST') {
      return approveSidecarRequest(req);
    }

    // File sync globs: same per-repo GET/POST shape as sidecars above — GET
    // returns the repo's glob list for the settings UI to edit, POST replaces
    // it wholesale. Read by createWorktree on the next worktree it creates for
    // this repo, not retroactively applied to worktrees that already exist.
    if (pathname === '/api/file-sync-globs') {
      return fileSyncSettingsResource(req, method);
    }

    // Custom agents: same shape as sidecars above — GET for the settings UI to
    // edit, POST replaces the whole (global, not per-repo) list.
    if (pathname === '/api/custom-agents') {
      return customAgentsResource(req, method);
    }

    return null;
  }

  function mcpCallbackHtml(title, body) {
    const escapeHtml = (value) =>
      String(value).replace(
        /[&<>'"]/g,
        (char) =>
          ({
            "'": '&#39;',
            '"': '&quot;',
            '&': '&amp;',
            '<': '&lt;',
            '>': '&gt;',
          })[char]
      );
    return new Response(
      `<!doctype html><html><head><title>${escapeHtml(title)}</title><style>body{font:15px system-ui;max-width:32rem;margin:4rem auto;padding:0 1.5rem;color:#27272a}</style></head><body><h2>${escapeHtml(title)}</h2><p>${escapeHtml(body)}</p></body></html>`,
      {
        headers: {
          'content-security-policy':
            "default-src 'none'; style-src 'unsafe-inline'",
          'content-type': 'text/html',
          'x-content-type-options': 'nosniff',
          'x-frame-options': 'DENY',
        },
      }
    );
  }

  // No WebSocket topic for MCP -- RaycastSection's plain setInterval poll is
  // the precedent (status badge + live refresh, no WS), and connect/authorize
  // is either a fast local spawn or a real browser OAuth round-trip the user
  // is already watching, not something that needs sub-second push. mcpRoutes
  // must run before worktreeRoutes, same ordering constraint as every other
  // domain here (see worktreeRoutes' own comment on why).
  async function mcpRoutes(req, pathname, method) {
    // GET returns config joined with live status from mcp.js, same
    // "computed field appended to the response" shape /api/sidecars uses for
    // its approved field. POST replaces the whole (global) list -- connecting
    // is a separate action below, saving config never connects anything.
    if (pathname === '/api/mcp-servers') {
      return mcpServersResource(req, method);
    }

    // Fire-and-forget, matching deployToVercel/deployToNetlify's shape: a
    // stdio connect is fast, but an HTTP+OAuth one involves a real browser
    // round-trip the user could take minutes to complete, so this can't block
    // the HTTP response. The actual outcome (connected/awaiting-auth/error)
    // shows up on the next /api/mcp-servers poll via mcp.js's own status map.
    if (pathname === '/api/mcp/connect' && method === 'POST') {
      return connectMcpRequest(req);
    }

    if (pathname === '/api/mcp/disconnect' && method === 'POST') {
      const body = await req.json().catch(() => ({}));
      return jsonTry(() => disconnectMcpServer(body.id));
    }

    // Hit by a real browser tab redirected here by the authorization server,
    // not the SPA -- returns human-readable HTML on every leg, not JSON. This
    // is the one route in this domain that doesn't go through jsonTry.
    if (pathname.startsWith('/api/mcp/oauth/callback/') && method === 'GET') {
      return mcpCallbackRequest(req, pathname);
    }

    return null;
  }

  async function raycastRoutes(req, pathname, method) {
    if (pathname === '/api/raycast/status') {
      return Response.json({
        dirExists: existsSync(RAYCAST_DIR),
        running: !!raycastDev,
      });
    }
    if (pathname === '/api/raycast/log') {
      const n = Number(new URL(req.url).searchParams.get('n') ?? 150);
      raycastLogSnapshot = readLogTail(`${LOGS}/_raycast/dev.log`, n, {
        previous: raycastLogSnapshot,
      });
      return Response.json(raycastLogSnapshot);
    }
    if (method === 'POST' && pathname === '/api/raycast/start') {
      return jsonTry(async () => {
        await assertStorageHeadroom(RAYCAST_DIR);
        return startRaycastDev();
      });
    }
    if (method === 'POST' && pathname === '/api/raycast/stop') {
      return Response.json(await stopRaycastDev());
    }

    return null;
  }

  // skill is the only piece of the pr-review API surface that ever selects a
  // filesystem path branch (reviews/ vs briefs/) — repo/name are already safe
  // because they resolve through REPO_META/wtPath, but skill comes straight
  // off the query string / POST body, so every route here validates it
  // against this exact allowlist before it ever reaches pr-review.js.
  const PR_REVIEW_SKILLS = new Set(['pr-walkthrough', 'pr-brief']);

  // Shared by /api/pr-review/status and mcp-server.js's get_pr_review_status
  // tool (direct call, not a self-fetch — see initMcpServer below).
  async function prReviewStatus(repo, name) {
    const wtDir = wtPath(repo, name);
    const pluginInstalled = detectPrWalkthroughPlugin(wtDir);
    const pr = await fetchPR(repo, await worktreeBranch(repo, name));
    if (!pr.number) {
      return { artifacts: {}, pluginInstalled, pr: null, run: null };
    }
    const slug = REPO_META[repo]?.slug ?? repo;
    const headSha =
      (await runText(['git', '-C', wtDir, 'rev-parse', 'HEAD'])).trim() || null;
    const artifacts = {};
    for (const skill of PR_REVIEW_SKILLS) {
      artifacts[skill] = findLatestArtifact(slug, pr.number, skill, headSha);
    }
    return {
      artifacts,
      pluginInstalled,
      pr: { number: pr.number },
      run: reviewRunStatus(repo, name),
    };
  }

  // Shared by /api/pr-review/run and mcp-server.js's run_pr_review tool.
  async function prReviewRun(repo, name, skill, source = 'portal') {
    const outcome = await operationOutcomes.accept({
      kind: 'pr-review',
      source,
      target: { name, repo },
    });
    const result = await lifecycle.startOperation(
      worktreeTarget(repo, name),
      'review',
      async () => {
        if (!PR_REVIEW_SKILLS.has(skill)) {
          throw new Error('unknown skill');
        }
        const pr = await fetchPR(repo, await worktreeBranch(repo, name));
        if (!pr.number) {
          return {
            error: 'no pull request associated with this worktree',
            ok: false,
          };
        }
        const slug = REPO_META[repo]?.slug ?? repo;
        touchLastSeen(repo, name);
        const fd = openLogFd(repo, name, 'pr-review');
        let completion;
        const reviewResult = runDeepReview(repo, name, skill, {
          logFd: fd,
          logPath: logPath(repo, name, 'pr-review'),
          onCompletion: async (promise) => {
            completion = promise;
            const recording = await operationOutcomes.running(outcome);
            watchOutcome({ ...outcome, ...recording }, completion);
          },
          prNumber: pr.number,
          slug,
          spawnText: runText,
          wtDir: wtPath(repo, name),
        });
        return { completion, result: reviewResult };
      }
    );
    return result?.ok === false
      ? operationOutcomes.settle(outcome, result)
      : {
          ...result,
          operationId: outcome.id,
          ...(outcome.outcomeRecorded ? { outcomeRecorded: false } : {}),
        };
  }

  // prReviewRoutes must run before worktreeRoutes, same ordering constraint
  // as every other domain here (see worktreeRoutes' own comment on why).
  // biome-ignore lint/suspicious/useAwait: Preserve the route handler's rejected-promise error boundary.
  async function prReviewRoutes(req, pathname, method) {
    if (pathname === '/api/pr-review/status' && method === 'GET') {
      return prReviewStatusRequest(req);
    }

    if (pathname === '/api/pr-review/run' && method === 'POST') {
      return prReviewRunRequest(req);
    }

    // Serves the report HTML directly (a genuinely self-contained file, only
    // external refs are Google Fonts <link> tags) — a new tab, not an iframe,
    // matching the existing "Open in browser" pattern for worktree URLs.
    if (pathname === '/api/pr-review/artifact' && method === 'GET') {
      return prReviewArtifactRequest(req);
    }

    return null;
  }

  // The generic `if (method === 'POST')` block below consumes the request
  // body for ANY POST pathname, not just the ones it recognizes, unlike every
  // other domain above, which gates its own req.json() on a specific pathname
  // match first. That's why worktreeRoutes runs last in handle(): a body can
  // only be read once, and if this ran first it would swallow the body meant
  // for e.g. a POST to /api/settings before settingsRoutes ever saw it.
  async function worktreeActionRequest(req, pathname, source) {
    const body = await req.json().catch(() => ({}));
    const { repo, name, tool, tunnel, container, target, reason } = body;
    // Any POST action referencing a specific worktree (start/stop/sync/
    // tunnel/inngest/trigger/open) is real, user-driven activity. Touch it
    // once here rather than at each branch below.
    if (repo && name) {
      touchLastSeen(repo, name);
    }

    switch (pathname) {
      case '/api/create': {
        return jsonTry(() => createWorktree(repo, name, !!tunnel, source));
      }
      case '/api/remove': {
        return jsonTry(() =>
          removeWorktree(
            repo,
            name,
            reason,
            body.force ?? false,
            body.operationId,
            source
          )
        );
      }
      case '/api/remove/cancel': {
        return Response.json(await removals.cancel(body.operationId));
      }
      case '/api/start': {
        // Container is the default for dev servers, not opt-in — but ONLY when
        // nobody expressed a preference. `container` explicitly true/false
        // (a CLI --container/--bare flag) always wins. Omitted entirely (a
        // plain `setu start`, or the portal UI's Start button, which never
        // sends this field) falls back to defaultContainerMode's sticky,
        // per-worktree default — found live: applying the flat global default
        // unconditionally silently switched an established, always-bare
        // worktree into a container the moment it needed a restart, with no
        // one having asked for that. Native stays for the tooling around it
        // (portal, Caddy, dnsmasq, git) regardless — this only governs how the
        // dev server process itself runs.
        return Response.json(
          await startWorktreeByName(repo, name, container, source)
        );
      }
      case '/api/stop': {
        return Response.json(await stopWorktreeByName(repo, name, source));
      }
      case '/api/sync': {
        return jsonTry(() => syncWorktreeByName(repo, name, source));
      }
      case '/api/pr/create': {
        return jsonTry(() => createPr(repo, name, source));
      }
      case '/api/pr/ready': {
        return jsonTry(() => setPrReady(repo, name, !!body.ready, source));
      }
      case '/api/tunnel/enable': {
        return Response.json(await enableTunnelByName(repo, name, source));
      }
      case '/api/tunnel/disable': {
        return Response.json(await disableTunnelByName(repo, name, source));
      }
      case '/api/inngest/start': {
        return Response.json(await startInngestByName(repo, name, source));
      }
      case '/api/inngest/stop': {
        return Response.json(await stopInngestByName(repo, name, source));
      }
      case '/api/trigger/start': {
        return Response.json(await startTriggerByName(repo, name, source));
      }
      case '/api/trigger/stop': {
        return Response.json(await stopTriggerByName(repo, name, source));
      }
      case '/api/convex/start': {
        return Response.json(await startConvexByName(repo, name, source));
      }
      case '/api/convex/stop': {
        return Response.json(await stopConvexByName(repo, name, source));
      }
      case '/api/convex/deploy': {
        if (!target) {
          return Response.json({
            code: 'INVALID_DEPLOY_TARGET',
            error: 'target required',
            ok: false,
          });
        }
        return jsonTry(() =>
          deployToConvex(repo, name, target, body.expectedContext, source)
        );
      }
      case '/api/vercel/deploy': {
        if (!target) {
          return Response.json({
            code: 'INVALID_DEPLOY_TARGET',
            error: 'target required',
            ok: false,
          });
        }
        return jsonTry(() =>
          deployToVercel(repo, name, target, body.expectedContext, source)
        );
      }
      case '/api/netlify/deploy': {
        if (!target) {
          return Response.json({
            code: 'INVALID_DEPLOY_TARGET',
            error: 'target required',
            ok: false,
          });
        }
        return jsonTry(() =>
          deployToNetlify(repo, name, target, body.expectedContext, source)
        );
      }
      case '/api/open': {
        if (['claude', 'claude-code', 'codex'].includes(tool)) {
          return Response.json(
            await managedAgents.open({ name, repo, source, tool })
          );
        }
        return Response.json(
          await recordPortalMutation('terminal-open', repo, name, source, () =>
            openInGhostty(wtPath(repo, name), tool)
          )
        );
      }
      case '/api/ports/kill': {
        const { pid, port } = body;
        return Response.json(await killPort(port, pid));
      }
      default:
        return null;
    }
  }

  function setupProgressResponse(query) {
    if (!setupRecovery.ok) {
      return Response.json(setupRecovery);
    }
    const records = [];
    for (const row of portEntries(WORKSPACE)) {
      if (
        (query.repo && query.repo !== row.repo) ||
        (query.name && query.name !== row.name)
      ) {
        continue;
      }
      const record = setupProgress.get({ name: row.name, repo: row.repo });
      if (record?.ok === false) {
        return Response.json(record);
      }
      if (record) {
        records.push(record);
      }
    }
    return Response.json({ ok: true, records });
  }

  function worktreeLogsResponse(req) {
    const p = new URL(req.url).searchParams;
    const repo = p.get('repo'),
      name = p.get('name');
    // Polling this endpoint only happens while a LogModal/LiveLog panel is
    // actually mounted for this worktree (portal/components/logs.tsx). That's
    // a real "someone is watching" signal, unlike the always-on
    // /api/worktrees list poll. Counts toward the idle-timeout clock below.
    if (repo && name) {
      touchLastSeen(repo, name);
    }
    const res = tailLog(
      repo,
      name,
      p.get('type') ?? 'dev',
      Number(p.get('n') ?? 150)
    );
    return Response.json(res);
  }

  function worktreeDiffResponse(req) {
    const p = new URL(req.url).searchParams;
    const repo = p.get('repo'),
      name = p.get('name');
    if (!(repo && name)) {
      return Response.json(
        { error: 'repo and name required', ok: false },
        { status: 400 }
      );
    }
    touchLastSeen(repo, name);
    return jsonTry(() => computeDiff(repo, name));
  }

  async function worktreeDataRequest(req, pathname, portalServer) {
    switch (pathname) {
      case '/api/worktrees': {
        // Same idleTimeout hazard /api/sweep already documents and fixes (see
        // its own comment) -- 45+ worktrees each potentially needing an
        // uncached `gh pr view` subprocess (fetchPR's 60s TTL, cold right after
        // a portal restart) can genuinely exceed Bun's default 10s idle timeout
        // for a real HTTP client (web UI, Raycast) hitting this route directly.
        portalServer?.timeout(req, 0);
        return Response.json(
          new URL(req.url).searchParams.get('snapshot') === '1'
            ? await getWorktreeSnapshot()
            : await getWorktrees()
        );
      }

      // Full list, most-recent-first: same client-side-pagination convention
      // /api/worktrees already uses (the frontend slices into pages, not this
      // endpoint), so the archive view stays consistent with the main list
      // instead of inventing server-side pagination just for itself.
      case '/api/worktrees/archived': {
        return Response.json([...loadArchivedWorktrees(WORKSPACE)].reverse());
      }

      case '/api/status': {
        return Response.json(
          await computeStatus(
            new URL(req.url).searchParams.get('refresh') === '1'
          )
        );
      }

      case '/api/logs': {
        return worktreeLogsResponse(req);
      }

      // Deploy status is also folded into /api/worktrees (vercelDeploy field,
      // same convention as pr/tunnelRunning) for the poll loop the UI already
      // runs. This exists alongside that fold for a caller that wants just one
      // worktree's deploy state without fetching the whole list.
      case '/api/vercel/status': {
        const p = new URL(req.url).searchParams;
        return Response.json(vercelStatus(p.get('repo'), p.get('name')));
      }

      // Same "also reachable standalone" convention as /api/vercel/status above.
      case '/api/netlify/status': {
        const p = new URL(req.url).searchParams;
        return Response.json(netlifyStatus(p.get('repo'), p.get('name')));
      }

      // Same "also reachable standalone" convention as /api/vercel/status above.
      case '/api/convex/status': {
        const p = new URL(req.url).searchParams;
        return Response.json(convexDeployStatus(p.get('repo'), p.get('name')));
      }

      // Manual-fetch, not polled (see DiffViewer): a human actually looking at a
      // worktree's diff is real activity, same as opening its log viewer above.
      case '/api/diff': {
        return worktreeDiffResponse(req);
      }

      // Repo-scoped, not worktree-scoped -- no touchLastSeen call, unlike every
      // other route in this block (there's no single worktree this action is
      // "about"). GET-only, so it's safe to sit inside worktreeRoutes despite
      // that function's own POST-body-consuming hazard (see worktreeRoutes'
      // comment above) -- a GET never reads req.json().
      case '/api/repo-prs': {
        const repo = new URL(req.url).searchParams.get('repo');
        if (!repo) {
          return Response.json(
            { error: 'repo required', ok: false },
            { status: 400 }
          );
        }
        return jsonTry(() => fetchRepoPRs(repo));
      }
      default:
        return null;
    }
  }

  async function worktreeRoutes(req, pathname, method, portalServer) {
    const source = ['ui', 'cli', 'raycast'].includes(
      req.headers.get('x-setu-source')
    )
      ? req.headers.get('x-setu-source')
      : 'portal';
    const query = Object.fromEntries(new URL(req.url).searchParams);
    const resourceResponse = await dispatchPortalResourceRoute(
      portalB205Composition,
      req
    );
    if (resourceResponse) {
      return resourceResponse;
    }
    switch (`${method} ${pathname}`) {
      case 'GET /api/setup-progress': {
        return setupProgressResponse(query);
      }
      case 'POST /api/setup-progress/retry': {
        const body = await req.json().catch(() => ({}));
        return Response.json(await retrySetupProgress(body, source));
      }
      case 'GET /api/workspace-inventory': {
        portalServer?.timeout(req, 0);
        return Response.json(await workspaceInventory.read());
      }
      case 'POST /api/worktrees/adopt': {
        const body = await req.json().catch(() => ({}));
        const adoptionSource = ['ui', 'cli', 'raycast'].includes(
          req.headers.get('x-setu-source')
        )
          ? req.headers.get('x-setu-source')
          : 'portal';
        return jsonTry(() =>
          adoptWorktree(body.repo, body.name, body.path, adoptionSource)
        );
      }
      case 'GET /api/deploy/preflight': {
        const p = new URL(req.url).searchParams;
        return Response.json(
          await deploymentGuard.preflight({
            name: p.get('name'),
            provider: p.get('provider'),
            repo: p.get('repo'),
            target: p.get('target'),
          })
        );
      }

      default:
        break;
    }
    switch (pathname) {
      case '/api/worktrees':
      case '/api/worktrees/archived':
      case '/api/status':
      case '/api/logs':
      case '/api/vercel/status':
      case '/api/netlify/status':
      case '/api/convex/status':
      case '/api/diff':
      case '/api/repo-prs':
        return worktreeDataRequest(req, pathname, portalServer);
      default:
        break;
    }

    if (method === 'POST') {
      const response = await worktreeActionRequest(req, pathname, source);
      if (response) {
        return response;
      }
    }

    if (pathname === '/api/ports') {
      return Response.json(await listPortsWithWorktree());
    }

    return null;
  }

  // ── action log ────────────────────────────────────────────────────────────────
  // A structured record of every mutating request this portal serves: route,
  // repo/name (when present), and whether it succeeded. This is the exact gap
  // a real incident hit (google-calendar-meeting-prep silently switched from
  // bare to a container mid-use) -- portal.js logged nothing about its own
  // requests anywhere retrievable, so root-causing it meant correlating three
  // separate external log sources by hand (OrbStack's own log, Caddy's log,
  // the worktree's own dev.log) instead of one grep. GET routes aren't logged
  // here -- they're reads, not actions, and the list/status polls alone
  // (800ms-3s intervals) would drown out everything else at that volume.
  const ACTIONS_LOG = `${LOGS}/actions.log`;

  // These synchronous actions are not already recorded by a shared service.
  const routeOutcomeKinds = {
    '/api/custom-agents': 'agents-save',
    '/api/file-sync-globs': 'file-sync-save',
    '/api/mcp-servers': 'mcp-servers-save',
    '/api/mcp/disconnect': 'mcp-disconnect',
    '/api/ports/kill': 'port-stop',
    '/api/project/add': 'project-add',
    '/api/project/remove': 'project-remove',
    '/api/raycast/start': 'raycast-start',
    '/api/raycast/stop': 'raycast-stop',
    '/api/remove/cancel': 'removal-cancel',
    '/api/settings': 'settings-save',
    '/api/sidecar-approvals/approve': 'sidecar-approve',
    '/api/sidecars': 'sidecars-save',
    '/api/sweep/import': 'project-import',
    '/api/update/quiesce': 'update-quiesce',
    '/api/update/reopen': 'update-reopen',
    '/api/update/stop': 'update-stop',
  };

  function logAction(pathname, body, ok, error) {
    rotateLog(ACTIONS_LOG);
    const entry = {
      name: body?.name ?? null,
      ok,
      repo: body?.repo ?? null,
      route: pathname,
      ts: new Date().toISOString(),
      ...(error ? { error: String(error).slice(0, 500) } : {}),
    };
    try {
      appendFileSync(ACTIONS_LOG, `${JSON.stringify(entry)}\n`);
    } catch {
      // Logging cannot replace the action's already established result.
    }
  }

  async function completeMutationResponse(routed, pathname, body, outcome) {
    const res =
      routed instanceof Response
        ? routed
        : Response.json(routed, { status: 409 });
    const resBody = await res
      .clone()
      .json()
      .catch(() => null);
    logAction(
      pathname,
      body,
      res.status < 400 && resBody?.ok !== false,
      resBody?.error
    );
    if (!outcome) {
      return res;
    }
    const result = await operationOutcomes.settle(outcome, {
      ...resBody,
      ok: res.status < 400 && resBody?.ok !== false,
    });
    return Response.json(result, { headers: res.headers, status: res.status });
  }

  async function handleMutationRequest(req, portalServer, pathname, method) {
    // Request bodies can only be read once and every route handler below
    // already does its own req.json() internally -- clone before routing so
    // this wrapper can independently read the same body for the log entry.
    const bodyClone = req.clone();
    const body = await bodyClone.json().catch(() => null);
    const outcome = routeOutcomeKinds[pathname]
      ? await operationOutcomes.accept({
          kind: routeOutcomeKinds[pathname],
          source: ['ui', 'cli', 'raycast'].includes(
            req.headers.get('x-setu-source')
          )
            ? req.headers.get('x-setu-source')
            : 'portal',
          target:
            typeof body?.repo === 'string' && typeof body?.name === 'string'
              ? { name: body.name, repo: body.repo }
              : null,
        })
      : null;
    let routed;
    try {
      routed = pathname.startsWith('/api/update/')
        ? await routeRequest(req, portalServer, pathname, method)
        : await updateControl.mutate(
            () => routeRequest(req, portalServer, pathname, method),
            {
              recovery: [
                '/api/stop',
                '/api/inngest/stop',
                '/api/trigger/stop',
                '/api/convex/stop',
                '/api/raycast/stop',
                '/api/mcp/disconnect',
              ].includes(pathname),
            }
          );
    } catch (error) {
      logAction(pathname, body, false, error);
      const result = {
        error: String(error),
        ok: false,
        // biome-ignore lint/suspicious/noUnnecessaryConditions: route mutations may reject with null, primitives, or Error-like values.
        ...(error?.code ? { code: error.code } : {}),
      };
      return Response.json(
        outcome ? await operationOutcomes.settle(outcome, result) : result,
        { status: 500 }
      );
    }
    return completeMutationResponse(routed, pathname, body, outcome);
  }

  async function handle(req, portalServer) {
    const denied = portalRequestError(
      req,
      portalServer.requestIP(req)?.address,
      PORT
    );
    if (denied) {
      return Response.json({ error: denied, ok: false }, { status: 403 });
    }
    const { pathname } = new URL(req.url);
    const { method } = req;

    if (method === 'POST' && pathname.startsWith('/api/')) {
      portalServer?.timeout(req, 0);
    }

    // OAuth's redirect is a GET, but its callback exchanges and persists tokens.
    if (method === 'GET' && pathname.startsWith('/api/mcp/oauth/callback/')) {
      const result = await updateControl.mutate(() =>
        routeRequest(req, portalServer, pathname, method)
      );
      return result instanceof Response
        ? result
        : Response.json(result, { status: 409 });
    }

    // The legacy actions.log only covers HTTP POST routes. Shared services
    // separately record MCP and HTTP outcomes in the durable operation journal.
    if (method !== 'POST' || !pathname.startsWith('/api/')) {
      return routeRequest(req, portalServer, pathname, method);
    }

    return handleMutationRequest(req, portalServer, pathname, method);
  }

  async function routeRequest(req, portalServer, pathname, method) {
    // A successful upgrade must not fall through to the route handlers below,
    // hence the early return before the loop even starts. data seeds ws.data
    // with the per-connection Set that open/message/close use to track which
    // logs:* topics this connection currently holds, populated at upgrade
    // time rather than reassigned later since ServerWebSocket.data is meant
    // to be set this way, not written to after the fact.
    if (pathname === '/ws') {
      if (portalServer.upgrade(req, { data: new Set() })) {
        return;
      }
      return new Response('Upgrade failed', { status: 400 });
    }

    // Setu-as-an-MCP-server (the reverse of mcp.js, which connects Setu TO
    // other servers) -- mounted here rather than folded into mcpRoutes below,
    // which handles that opposite direction and would be a confusing place to
    // also register this. A plain HTTP route, not an upgrade, but still needs
    // `server` directly: tools call straight into this file's own functions
    // (initMcpServer below wires that up -- no self-fetch back into this
    // server, deliberately, after that pattern was found to hang the whole
    // portal during live testing). Some of those calls are still genuinely
    // slow (list_worktrees over 45+ worktrees with a cold PR cache), so this
    // request itself still needs the same idleTimeout override /api/sweep and
    // /api/worktrees already document.
    if (pathname === '/mcp') {
      portalServer?.timeout(req, 0);
      return handleMcpRequest(req, PORT);
    }

    if (pathname.startsWith('/api/') && !portalApiRoute(pathname, method)) {
      return new Response('Not found', { status: 404 });
    }

    // worktreeRoutes must run last, see its own comment for why.
    for (const routes of [
      updateRoutes,
      projectRoutes,
      settingsRoutes,
      mcpRoutes,
      prReviewRoutes,
      raycastRoutes,
      worktreeRoutes,
    ]) {
      // biome-ignore lint/performance/noAwaitInLoops: route order is contractual and handlers may consume the request body, so only the prior miss may fall through.
      const res = await routes(req, pathname, method, portalServer);
      if (res) {
        return res;
      }
    }
    return new Response('Not found', { status: 404 });
  }

  // No upstream config (Next.js/Node/Turbopack) can cap Turbopack's native-side memory
  // growth — NODE_OPTIONS=--max-old-space-size only bounds the V8/JS heap, confirmed via
  // docs + vercel/next.js#92052. This is the backstop: restart any tracked dev server
  // whose *physical* footprint (not just RSS — this box compresses most of a Node/Bun
  // heap, so RSS alone hid a 17GB-footprint process behind a ~2.6GB RSS reading) crosses
  // a ceiling. Even on Next.js ≥16.3.0 (memory eviction default-on), eviction is
  // best-effort, not a hard cap.
  const DEV_MEM_CEILING_MB = _cfg.devMemCeilingMb ?? 8192;
  const MEM_CHECK_INTERVAL = 60_000;

  async function processFootprintMb(pid) {
    const out = await runText(['footprint', String(pid)], { timeoutMs: 3000 });
    const match = out.match(FOOTPRINT_RE);
    if (match) {
      return (
        Number(match[1]) *
        { GB: 1024, KB: 1 / 1024, MB: 1 }[match[2].toUpperCase()]
      );
    }
    return null;
  }

  // UI refresh uses one cheap process table, including children of Bun's
  // script wrapper. Footprint sampling stays in the minute-scale watchdog.
  let processMemoryCache = null;
  let processMemoryAt = 0;
  // biome-ignore lint/suspicious/useAwait: process-tree callers await this cache boundary and must receive synchronous command failures as rejections.
  async function processMemory() {
    if (!processMemoryCache || Date.now() - processMemoryAt > 5000) {
      processMemoryAt = Date.now();
      processMemoryCache = runText(['ps', '-axo', 'pid=,ppid=,pgid=,rss='], {
        timeoutMs: 2000,
      }).then((raw) =>
        raw
          .split('\n')
          .filter(Boolean)
          .map((line) => {
            const [pid, ppid, pgid, rss] = line
              .trim()
              .split(WHITESPACE_RE)
              .map(Number);
            return { pgid, pid, ppid, rss };
          })
      );
    }
    return processMemoryCache;
  }

  async function processTree(entry) {
    const rows = await (options.processMemory ?? processMemory)();
    const pids = new Set([entry.pid]);
    // Adopted processes have no owned group, so walk their descendants only.
    let added;
    do {
      added = false;
      for (const row of rows) {
        if (
          !pids.has(row.pid) &&
          (pids.has(row.ppid) || (entry.ownedGroup && row.pgid === entry.pid))
        ) {
          pids.add(row.pid);
          added = true;
        }
      }
    } while (added);
    return rows.filter((row) => pids.has(row.pid));
  }

  async function worktreeProcessTree(key, entry) {
    const roots = entry?.pid ? [entry] : [];
    for (const map of [inngestProcs, triggerProcs, convexDevProcs]) {
      const sidecar = map.get(key);
      if (sidecar?.pid) {
        roots.push(sidecar);
      }
    }
    for (const [name, sidecar] of sidecarProcs) {
      if (name.startsWith(`${key}/`) && sidecar.pid) {
        roots.push(sidecar);
      }
    }
    const rows = (await Promise.all(roots.map(processTree))).flat();
    return [...new Map(rows.map((row) => [row.pid, row])).values()];
  }

  async function sampledMemory(rows) {
    let mb = 0;
    for (let i = 0; i < rows.length; i += 4) {
      // biome-ignore lint/performance/noAwaitInLoops: process-footprint batches are intentionally capped at four before the next batch to bound probe pressure.
      const samples = await Promise.all(
        rows
          .slice(i, i + 4)
          .map(
            async (row) => (await processFootprintMb(row.pid)) ?? row.rss / 1024
          )
      );
      mb += samples.reduce((sum, value) => sum + value, 0);
    }
    return mb;
  }

  function activeSidecarKeys() {
    return new Set([
      ...inngestProcs.keys(),
      ...triggerProcs.keys(),
      ...convexDevProcs.keys(),
      ...[...sidecarProcs.keys()].map((key) =>
        key.slice(0, key.lastIndexOf('/'))
      ),
    ]);
  }

  async function checkSidecarMemory() {
    for (const key of activeSidecarKeys()) {
      const entry = lifecycle.snapshot(key);
      if (entry?.reserved && !entry.container) {
        continue;
      }
      // biome-ignore lint/performance/noAwaitInLoops: stopping a prior over-limit sidecar changes shared lifecycle admission before the next key is measured.
      const mb = await sampledMemory(await worktreeProcessTree(key, null));
      if (mb <= DEV_MEM_CEILING_MB) {
        continue;
      }
      const { repo, name } = splitKey(key);
      console.warn(
        `${key} native sidecars exceed ${DEV_MEM_CEILING_MB}MB; stopping sidecars`
      );
      const settled = await Promise.allSettled([
        stopInngest(repo, name, getPort(WORKSPACE, repo, name)),
        stopTrigger(repo, name),
        stopConvexDev(repo, name),
        stopSidecars(repo, name),
      ]);
      const failed = settled.find((item) => item.status === 'rejected');
      if (failed) {
        console.error(`${key} sidecar stop failed:`, failed.reason);
      }
    }
  }

  function currentBareRuntime(current, entry) {
    return (
      current?.reserved &&
      current.generation === entry.generation &&
      !current.stopping &&
      current.phase !== 'unknown' &&
      !current.container
    );
  }

  function currentGeneration(latest, entry) {
    return (
      latest?.reserved &&
      latest.generation === entry.generation &&
      !latest.stopping
    );
  }

  async function checkDevMemory() {
    for (const entry of lifecycle.snapshots()) {
      if (!entry.reserved || entry.stopping) {
        continue;
      }
      const { key } = entry;
      // biome-ignore lint/performance/noAwaitInLoops: reconciliation establishes the generation checked below and must finish before restart eligibility is evaluated.
      await lifecycle.reconcile(key, entry.generation);
      const current = lifecycle.snapshot(key);
      if (!currentBareRuntime(current, entry)) {
        continue;
      }
      const mb = await sampledMemory(await worktreeProcessTree(key, current));
      const latest = lifecycle.snapshot(key);
      if (!currentGeneration(latest, entry)) {
        continue;
      }
      if (mb > DEV_MEM_CEILING_MB) {
        console.warn(
          `${key} dev server at ${Math.round(mb)}MB exceeds ${DEV_MEM_CEILING_MB}MB; restarting`
        );
        const result = await lifecycle.restart(latest.target);
        if (!result.ok) {
          console.error(result.error);
        }
      }
    }
  }

  async function checkMemoryCeilings() {
    await Promise.all(
      [inngestProcs, triggerProcs, convexDevProcs, sidecarProcs].map((map) =>
        pruneDeadEntries(map, observeSidecarEntry)
      )
    );
    for (const entry of lifecycle.snapshots()) {
      if (entry.phase === 'unknown' && !entry.reserved) {
        // biome-ignore lint/performance/noAwaitInLoops: reconciliation mutates shared lifecycle state; preserve the snapshot's established order.
        await lifecycle.reconcile(entry.key, entry.generation);
      }
    }
    await checkSidecarMemory();
    await checkDevMemory();
  }

  let memoryCheckRunning = false;
  let memoryCheckTimer = null;

  // ── idle-timeout auto-stop ───────────────────────────────────────────────────
  // Opt-in (0 = disabled) companion to checkMemoryCeilings above: stops a bare
  // dev server that's been running with no real activity for longer than a
  // configurable window, so a forgotten worktree doesn't sit there burning a
  // concurrency slot (and memory) indefinitely. Disabled by default, since
  // this changes running-server behavior and shouldn't kick in for anyone who
  // hasn't explicitly opted in via .setu.json's idleTimeoutMs.
  //
  // "Activity" = lastSeenAt (set near the top, by the procs Map declarations),
  // which is only touched by genuine user-driven signals: a bare dev server
  // (re)starting (spawnWorktree, reconcileDevServers), any POST action naming
  // this worktree (start/stop/sync/tunnel/inngest/trigger/open), or a poll of
  // its live log viewer (GET /api/logs, which only fires while a LogModal/
  // LiveLog panel is actually open for it). It is deliberately NOT touched by
  // the passive GET /api/worktrees list poll, which the frontend's main loop
  // fires for every worktree every 800ms-3s regardless of whether its card is
  // even visible, let alone whether the browser tab is focused. Keying
  // idleness off that endpoint would mean a worktree never times out just
  // because the dashboard happens to be open somewhere.
  //
  // Verified LiveLog is scoped correctly for this to work: app.tsx only
  // mounts it inside WorktreePage, which only renders for the single worktree
  // on the current /worktree/:repo/:name route (route.page === 'detail'), not
  // in the list/card view. So GET /api/logs only fires for the one worktree a
  // human actually navigated to, not for every running worktree the way the
  // list poll does.
  //
  // Known limitation, not hidden: browsers throttle but don't fully stop
  // timers in an unfocused, backgrounded tab, so a detail page left open in a
  // background tab can keep polling /api/logs (and therefore keep touching
  // lastSeenAt) even once nobody is actually looking at it. There's no
  // session/viewer/visibility tracking in this portal today. Accepted gap for
  // v1, not a claim of perfect accuracy.
  const IDLE_TIMEOUT_MS = _cfg.idleTimeoutMs ?? 0; // 0 = disabled
  const IDLE_CHECK_INTERVAL = 60_000;
  // Floor under IDLE_TIMEOUT_MS itself: a worktree younger than this never
  // gets reaped even if someone configures a very small timeout, so a dev
  // server that's still booting can't get stopped mid-start.
  const IDLE_MIN_UPTIME_MS = 2 * 60_000;

  function idleDuration(entry, now, threshold) {
    if (!entry.reserved || entry.stopping || entry.container) {
      return null;
    }
    if (activeTunnelMap.has(entry.key)) {
      return null;
    }
    const seenAt = lastSeenAt.get(entry.key);
    if (seenAt === null || seenAt === undefined) {
      return null; // no baseline yet, nothing to measure against
    }
    const idleMs = now - seenAt;
    return idleMs < threshold ? null : idleMs;
  }

  function checkIdleTimeouts() {
    if (!IDLE_TIMEOUT_MS) {
      return;
    }
    const now = Date.now();
    const threshold = Math.max(IDLE_TIMEOUT_MS, IDLE_MIN_UPTIME_MS);
    for (const entry of lifecycle.snapshots()) {
      const { key } = entry;
      // Container-mode worktrees already have Docker's own lifecycle (restart
      // policy, plus checkMemoryCeilings' dead-container reap above). This
      // check is bare-process-only.
      // A worktree with an active public tunnel route can be getting real
      // traffic from outside this portal entirely (someone hitting the public
      // URL) — none of that shows up as a portal-side request, so lastSeenAt
      // can't see it. Leave tunneled worktrees out of idle-timeout scope
      // rather than risk stopping a server that's actually serving traffic.
      const idleMs = idleDuration(entry, now, threshold);
      if (idleMs === null) {
        continue;
      }
      const { repo, name } = splitKey(key);
      const port = getPort(WORKSPACE, repo, name);
      console.warn(
        `⚠ ${key} idle for ${Math.round(idleMs / 60_000)}m, exceeds ${Math.round(IDLE_TIMEOUT_MS / 60_000)}m idle timeout — stopping`
      );
      // Not awaited: stopWorktree is async now, but nothing here depends on
      // its kill actually finishing before the next line — unlike the memory-
      // ceiling restart path, there's no immediate respawn to race.
      stopWorktree(repo, name, port).catch((error) => console.error(error));
      lastSeenAt.delete(key);
    }
  }

  let idleCheckTimer = null;

  // ── WebSocket push (real-time sync) ─────────────────────────────────────────
  // Replaces client HTTP polling of /api/worktrees, /api/status and /api/logs
  // with server push over one shared connection. Two kinds of topic share the
  // same tracking Map, same shape as this file's other subscriber-tracked
  // state (vercelDeploys/netlifyDeploys/sidecarProcs above): 'worktrees' (auto
  // subscribed by every connection, driven by open/close) and one
  // `logs:${repo}/${name}/${type}` per open log viewer (subscriber count
  // driven by client {sub}/{unsub} messages instead, since a client only
  // wants a log topic while that viewer is actually mounted). Every entry
  // carries both lastBroadcast (worktrees only, the last published JSON
  // string, so an unchanged tick never republishes) and lastTotal (logs only,
  // tailLog's line count as of the last tick, same idea) so either kind of
  // tick can be a cheap no-op instead of always publishing.
  const wsTopics = new Map(); // topic -> { interval, subscriberCount, lastBroadcast, lastTotal }

  // Exactly what GET /api/status already returns, factored out so the HTTP
  // route and the WS tick below can never drift apart from each other.
  function cachedContainerRuntime() {
    return lifecycle.refreshCapacity();
  }

  // biome-ignore lint/suspicious/useAwait: status routes and stream snapshots await this boundary and require synchronous collaborator failures as rejections.
  async function computeStatus(refreshHealth = false) {
    return readPortalStatus(
      {
        config: _cfg,
        lifecycle,
        pendingRemovals: () => removals.pending(),
        readHostHealth,
      },
      refreshHealth
    );
  }

  let snapshotInFlight = null;
  function getWorktreeSnapshot() {
    if (!snapshotInFlight) {
      snapshotInFlight = (async () => {
        // A composition that started before this read may contain an older listener set.
        if (worktreesInFlight) {
          await worktreesInFlight.catch(() => undefined);
        }
        return readFreshWorktreeSnapshot({
          listeners: listenerObservation,
          status: computeStatus,
          worktrees: getWorktrees,
        });
      })().finally(() => {
        snapshotInFlight = null;
      });
    }
    return snapshotInFlight;
  }
  const worktreeStream = createWorktreeStream({
    publish: (topic, payload) => server?.publish(topic, payload),
    readSnapshot: getWorktreeSnapshot,
  });

  // repo never contains a slash (same assumption splitKey in lib.js makes for
  // the plain `repo/name` key), but name can, e.g. a branch called
  // "feature/foo", so repo comes from the first slash, type from the last
  // slash, and name is whatever sits between the two.
  function splitLogTopic(topic) {
    const rest = topic.slice('logs:'.length);
    const firstSlash = rest.indexOf('/');
    const lastSlash = rest.lastIndexOf('/');
    if (firstSlash === -1 || firstSlash === lastSlash) {
      return null; // not repo/name/type shaped
    }
    return {
      name: rest.slice(firstSlash + 1, lastSlash),
      repo: rest.slice(0, firstSlash),
      type: rest.slice(lastSlash + 1),
    };
  }

  function wsTickLog(topic, repo, name, type) {
    const entry = wsTopics.get(topic);
    if (!entry) {
      return;
    }
    const snapshot = readLogSnapshot(entry, () => logPath(repo, name, type));
    if (snapshot) {
      server?.publish(topic, JSON.stringify({ data: snapshot, topic }));
    }
  }

  function wsSubscribeLog(ws, topic) {
    if (!topic.startsWith('logs:') || ws.data.has(topic)) {
      return;
    }
    const parsed = splitLogTopic(topic);
    if (!parsed) {
      return;
    }
    const { repo, name, type } = parsed;
    try {
      logPath(repo, name, type);
    } catch {
      return;
    }
    let entry = wsTopics.get(topic);
    if (!entry) {
      entry = {
        interval: null,
        signature: null,
        snapshot: null,
        subscriberCount: 0,
      };
      wsTopics.set(topic, entry);
      entry.interval = runtimeTimers.setInterval(() => {
        try {
          wsTickLog(topic, repo, name, type);
        } catch (error) {
          console.error('Log stream tick failed:', error);
        }
      }, 1000);
    }
    // Flush pending changes to existing subscribers before the new socket
    // joins, then give it the identical bounded snapshot.
    wsTickLog(topic, repo, name, type);
    ws.subscribe(topic);
    ws.data.add(topic);
    entry.subscriberCount += 1;
    ws.send(JSON.stringify({ data: entry.snapshot, topic }));
  }

  function wsUnsubscribeLog(ws, topic) {
    if (!ws.data.has(topic)) {
      return; // not actually subscribed, nothing to do
    }
    ws.unsubscribe(topic);
    ws.data.delete(topic);
    const entry = wsTopics.get(topic);
    if (!entry) {
      return;
    }
    entry.subscriberCount -= 1;
    if (entry.subscriberCount <= 0) {
      runtimeTimers.clearInterval(entry.interval);
      wsTopics.delete(topic);
    }
  }

  async function open(ws) {
    if (updateControl.stopping()) {
      ws.close(1001, 'Portal update');
      return;
    }
    portalSockets.add(ws);
    await worktreeStream.open(ws);
  }

  function message(ws, raw) {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    } // a stray non-JSON frame must not crash the connection
    if (!msg || typeof msg !== 'object') {
      return;
    }
    if (typeof msg.sub === 'string') {
      wsSubscribeLog(ws, msg.sub);
    } else if (typeof msg.unsub === 'string') {
      wsUnsubscribeLog(ws, msg.unsub);
    }
  }

  function close(ws) {
    portalSockets.delete(ws);
    for (const topic of [...ws.data]) {
      wsUnsubscribeLog(ws, topic);
    }
    worktreeStream.close(ws);
  }

  // Wires mcp-server.js's tools straight to this file's own functions --
  // direct in-process calls, not HTTP, so /mcp never opens a second request
  // back into this same server. Function declarations are hoisted, so every
  // name here is already defined despite most living further up the file.
  function writerPath(repo, name) {
    if (!getPort(WORKSPACE, repo, name)) {
      throw new Error(`No registered worktree for ${repo}/${name}`);
    }
    const path = realpathSync(wtPath(repo, name));
    if (writerWorktree(path).wtDir !== path) {
      throw new Error(`Not a worktree root: ${path}`);
    }
    return path;
  }

  function readSetupProgress(repo, name) {
    if (!setupRecovery.ok) {
      return setupRecovery;
    }
    const records = [];
    for (const row of portEntries(WORKSPACE)) {
      if ((repo && row.repo !== repo) || (name && row.name !== name)) {
        continue;
      }
      const record = setupProgress.get({ name: row.name, repo: row.repo });
      if (record?.ok === false) {
        return record;
      }
      if (record) {
        records.push(record);
      }
    }
    return { ok: true, records };
  }

  function installMcpTools() {
    (options.initializeMcp ?? initMcpServer)({
      admissionStatus: () => portalB205.admissionStatus(),
      adoptWorktree: (repo, name, path) =>
        adoptWorktree(repo, name, path, 'mcp'),
      agentSessions: (input) => managedAgents.listSessions(input),
      attention: (input) => managedAgents.listAttention(input),
      attentionFocus: (input) =>
        managedAgents.focus({ ...input, source: 'mcp' }),
      cacheExecute: (input) => portalB205.cacheExecute(input),
      cachePrepare: (input) => portalB205.cachePrepare(input),
      claimWriter: (repo, name, owner) =>
        claimWriter(writerPath(repo, name), owner),
      computeDiff,
      createPr: (repo, name) => createPr(repo, name, 'mcp'),
      createWorktree: (repo, name, tunnel) =>
        createWorktree(repo, name, tunnel, 'mcp'),
      dependencyRepair: (input) => portalB205.dependencyRepair(input),
      dependencyVerify: (input) => portalB205.dependencyVerify(input),
      dependencyViews: (input) => portalB205.dependencyViews(input),
      disableTunnel: (repo, name) => disableTunnelByName(repo, name, 'mcp'),
      doctorReport: () => computeStatus(true),
      enableTunnel: (repo, name) => enableTunnelByName(repo, name, 'mcp'),
      endAgentSession: (input) =>
        managedAgents.endSession({ ...input, source: 'mcp' }),
      fetchRepoPRs,
      getSidecarLogs: sidecarLogs,
      getWorktrees,
      githubDispatch: (input) => portalB205.githubDispatch(input),
      githubRuns: (input) => portalB205.githubRuns(input),
      githubWorkflows: (input) => portalB205.githubWorkflows(input),
      handoffReview: (input) =>
        managedAgents.handoff({ ...input, source: 'mcp' }),
      headlessCancel: (input) =>
        managedAgents.cancelRun({ ...input, source: 'mcp' }),
      headlessResume: (input) =>
        managedAgents.resumeRun({ ...input, source: 'mcp' }),
      headlessRuns: (input) => managedAgents.listRuns(input),
      headlessStart: (input) =>
        managedAgents.startRun({ ...input, source: 'mcp' }),
      invokeMcpAction: (input) => portalB205.invokeMcpAction(input),
      listPorts: listPortsWithWorktree,
      listProjects: listProjectsSummary,
      listSidecars: listSidecarsForWorktree,
      listWriterClaims: () => listWriterClaims(writerClaimPaths(WORKSPACE)),
      mcpActions: () => portalB205.mcpActions(),
      operations: (input) => portalB205.operations(input),
      preflightMcpAction: (input) => portalB205.preflightMcpAction(input),
      prReviewRun: (repo, name, skill) => prReviewRun(repo, name, skill, 'mcp'),
      prReviewStatus,
      releaseWriter: (repo, name, session) =>
        releaseWriter(writerPath(repo, name), session),
      removeWorktree: (repo, name, reason, force, operationId) =>
        removeWorktree(repo, name, reason, force, operationId, 'mcp'),
      saveMcpAction: (input) => portalB205.saveMcpAction(input),
      setPrReady: (repo, name, ready) => setPrReady(repo, name, ready, 'mcp'),
      // Keep this async so synchronous progress-store failures reject through MCP.
      setupProgress: async ({ repo, name } = {}) =>
        readSetupProgress(repo, name),
      setupRetry: (input) => retrySetupProgress(input, 'mcp'),
      sharedCaches: () => portalB205.sharedCaches(),
      spansArtifact: spans.spansArtifact,
      spansDraftCreate: spans.spansDraftCreate,
      spansEvents: spans.spansEvents,
      spansPlanRevise: spans.spansPlanRevise,
      spansRun: spans.spansRun,
      spansRuns: spans.spansRuns,
      spansSearch: spans.spansSearch,
      spansSearchStatus: spans.spansSearchStatus,
      spansWorkflowCreate: spans.spansWorkflowCreate,
      spansWorkflowPreview: spans.spansWorkflowPreview,
      spansWorkflows: spans.spansWorkflows,
      startConvex: (repo, name) => startConvexByName(repo, name, 'mcp'),
      startInngest: (repo, name) => startInngestByName(repo, name, 'mcp'),
      startTrigger: (repo, name) => startTriggerByName(repo, name, 'mcp'),
      startWorktree: (repo, name, container) =>
        startWorktreeByName(repo, name, container, 'mcp'),
      stopConvex: (repo, name) => stopConvexByName(repo, name, 'mcp'),
      stopInngest: (repo, name) => stopInngestByName(repo, name, 'mcp'),
      stopTrigger: (repo, name) => stopTriggerByName(repo, name, 'mcp'),
      stopWorktree: (repo, name) => stopWorktreeByName(repo, name, 'mcp'),
      syncWorktree: (repo, name) => syncWorktreeByName(repo, name, 'mcp'),
      tailLog,
      workspaceStorage: () => portalB205.workspaceStorage(),
      workspaceStorageInspect: (input) =>
        portalB205.workspaceStorageInspect(input),
    });
  }

  let server = null;
  let startPromise = null;
  let disposed = false;
  const processHooks = new Map();

  async function boot() {
    // These are startup work, never import work: the migration writes state,
    // and the remaining calls inspect processes and machine routing.
    await (options.seedSidecarApprovals ?? seedSidecarApprovalsIfMissing)(
      WORKSPACE
    );
    REPO_META = options.projects ?? loadProjects(WORKSPACE);
    setupRecovery = await setupProgress.recover();
    await managedAgents.recover().catch(() => {
      // Keep portal recovery access available if managed-agent reconciliation fails.
    });
    updateControl = createPortalUpdateControl({
      hasSupportingWork: supportingWorkActive,
      lifecycle,
      processIdentity: await (options.observeProcess ?? observeProcessIdentity)(
        process.pid
      ),
    });
    const pending = validateRemovalRecords(portalState.read('removals'));
    await portalRouting.syncHosts();
    await (options.reconcileDevServers ?? reconcileDevServers)();
    await (options.reconcileTriggerSidecars ?? reconcileTriggerSidecars)();
    const worktrees = await getWorktrees().catch(() => []);
    for (const worktree of worktrees) {
      const recovery = Object.values(pending).find(
        (row) => row.key === worktree.key
      );
      const detached =
        recovery?.completed?.includes('tunnel') ||
        recovery?.attempting === 'tunnel' ||
        recovery?.attempting === 'git';
      if (worktree.tunnelOn && !detached) {
        activeTunnelMap.set(worktree.key, {
          port: worktree.port,
          pubDom: worktree.pubDomain,
        });
      }
    }
    if (activeTunnelMap.size > 0) {
      await restartTunnel();
    }
  }

  function startTimers() {
    logRetentionTimer = runtimeTimers.setInterval(() => {
      try {
        for (const path of openLogPaths) {
          trimLog(path);
        }
      } catch (error) {
        console.error('Log retention failed:', error);
      }
    }, 5000);
    logRetentionTimer.unref?.();
    memoryCheckTimer = runtimeTimers.setInterval(() => {
      (async () => {
        if (memoryCheckRunning) {
          return;
        }
        memoryCheckRunning = true;
        try {
          if (!updateControl.stopping()) {
            await checkMemoryCeilings();
          }
        } catch (error) {
          console.error('Memory ceiling check failed:', error);
        } finally {
          memoryCheckRunning = false;
        }
      })();
    }, MEM_CHECK_INTERVAL);
    idleCheckTimer = runtimeTimers.setInterval(() => {
      try {
        if (!updateControl.stopping()) {
          checkIdleTimeouts();
        }
      } catch (error) {
        console.error('Idle timeout check failed:', error);
      }
    }, IDLE_CHECK_INTERVAL);
  }

  function start() {
    if (disposed) {
      return Promise.reject(new Error('Portal runtime is disposed'));
    }
    if (startPromise) {
      return startPromise;
    }
    startPromise = (async () => {
      await boot();
      const indexPage =
        options.indexPage ?? (await import('./portal/index.html')).default;
      if (disposed) {
        throw new Error('Portal runtime was disposed during startup');
      }
      server = (options.serve ?? Bun.serve)({
        development: false,
        fetch: handle,
        hostname: '127.0.0.1',
        port: PORT,
        routes: {
          '/': indexPage,
          '/archived': indexPage,
          '/costs': indexPage,
          '/help': indexPage,
          '/inventory': indexPage,
          '/ports': indexPage,
          '/repo/:repo': indexPage,
          '/settings': indexPage,
          '/spans': indexPage,
          '/spans/:runId': indexPage,
          '/worktree/:repo/:name': indexPage,
        },
        websocket: { close, message, open },
      });
      installMcpTools();
      startTimers();
      processHooks.set('unhandledRejection', (error) =>
        console.error('Unhandled promise rejection:', error)
      );
      processHooks.set('uncaughtException', (error) =>
        console.error('Uncaught exception:', error)
      );
      for (const signal of ['SIGINT', 'SIGTERM']) {
        processHooks.set(signal, () => {
          releaseHeldLocks();
          dispose().finally(() => process.exit(0));
        });
      }
      for (const [event, listener] of processHooks) {
        process.on(event, listener);
      }
      return server;
    })().catch(async (error) => {
      await dispose();
      throw error;
    });
    return startPromise;
  }

  async function dispose() {
    disposed = true;
    for (const [event, listener] of processHooks) {
      process.off(event, listener);
    }
    processHooks.clear();
    for (const timer of [logRetentionTimer, memoryCheckTimer, idleCheckTimer]) {
      if (timer !== null) {
        runtimeTimers.clearInterval(timer);
      }
    }
    for (const entry of wsTopics.values()) {
      if (entry.interval !== null && entry.interval !== undefined) {
        runtimeTimers.clearInterval(entry.interval);
      }
    }
    wsTopics.clear();
    for (const socket of portalSockets) {
      worktreeStream.close(socket);
      socket.close();
    }
    portalSockets.clear();
    lifecycle.dispose();
    const boundServer = server;
    server = null;
    try {
      spans.close();
      await managedAgents.dispose();
    } finally {
      await boundServer?.stop(true);
    }
  }

  return {
    close,
    dispose,
    handle,
    internals: {
      createPr,
      dirtyCache,
      fetchDirty,
      fetchPR,
      getWorktrees,
      killPort,
      mcpCallbackHtml,
      processTree,
      projectSetupTarget,
      readInventoryRuntime,
      repoGitMeta,
      runtimeState: {
        convexDevProcs,
        inngestProcs,
        lastSeenAt,
        sidecarProcs,
        triggerProcs,
      },
      setPrReady,
      settingsRoutes,
      trimLog,
      waitForOutcomes: () => Promise.all([...pendingOutcomes]),
      worktreeContains,
      worktreeProcessTree,
      worktreeRoutes,
    },
    message,
    open,
    routeRequest,
    start,
    wsSubscribeLog,
    wsUnsubscribeLog,
  };
}

if (import.meta.main) {
  createPortalRuntime()
    .then(async (runtime) => {
      await runtime.start();
      console.log(`Portal → http://quivly.local  (localhost:${PORTAL_PORT})`);
    })
    .catch((error) => {
      console.error(`setu portal: ${error.message}`);
      process.exitCode = 1;
    });
}
