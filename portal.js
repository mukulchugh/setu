#!/usr/bin/env bun
// Dev portal — http://quivly.local

import { readFileSync, writeFileSync, appendFileSync, mkdirSync, statSync, renameSync, openSync, existsSync } from 'fs';
import { execFileSync, spawnSync } from 'child_process';
import { tmpdir } from 'os';
import { join, resolve, dirname } from 'path';
// Bun bundles + transpiles the Preact UI referenced by this page at serve time
import indexPage from './portal/index.html';
import {
  HOME, PORTAL_PORT, CLOUDFLARED_BIN,
  requireConfig, localDomain, publicDomain, envLocalPath, tunnelEnabled,
  parseEnvFile, pinnedTriggerVersion, convexDir, slugify,
  configureWorktreeEnv, reloadCaddy, syncHosts,
  portEntries, getPort, activePid, activePidAsync, listActivePorts, listActivePortsAsync, processCwd, loadProjects, registerProject, removeProject,
  createWorktree as libCreateWorktree, removeWorktree as libRemoveWorktree,
  discoverReposAsync, importRepo, cloneBareRepo,
  AGENT_CLIS, detectAgentClis, commandExists, loadSidecars, loadAllSidecars, saveSidecars, killGroup, killGroupAsync,
  loadCustomAgents, saveCustomAgents, loadFileSyncGlobs, saveFileSyncGlobs,
  isSidecarApproved, approveSidecar, seedSidecarApprovalsIfMissing,
  loadArchivedWorktrees, appendArchivedWorktree,
  containerRuntimeAvailable, composeProjectName, dockerComposePath, composeProjectAlive, writeDockerCompose,
  defaultContainerMode, needsMigrationPrompt, markMigrationPrompted, syncWithBase,
  worktreeBranchMap, branchMetadata, saveConfig, macCapacity, engineCapacity,
  spawnText, splitKey, baseBranchRef,
  loadMcpServers, saveMcpServers,
} from './lib.js';
import { connectMcpServer, finishMcpAuth, disconnectMcpServer, mcpStatuses } from './mcp.js';
import { detectPrWalkthroughPlugin, findLatestArtifact, artifactHtmlPath, reviewRunStatus, runDeepReview } from './pr-review.js';
import { handleMcpRequest, initMcpServer } from './mcp-server.js';

let _cfg;
try { _cfg = requireConfig(); }
catch (e) { console.error(`setu portal: ${e.message}`); process.exit(1); }

const WORKSPACE      = _cfg.workspace;
// Runs once per process start, synchronously, before any route can possibly
// be handled, so a start request can never race the migration and see a
// pre-existing sidecar as unapproved. See seedSidecarApprovalsIfMissing's
// own comment in lib.js for why this only ever runs once.
seedSidecarApprovalsIfMissing(WORKSPACE);
const TUNNEL_NAME    = _cfg.tunnel;
const CF_CREDENTIALS_CFG = _cfg.cfCredentials;
const PKG_DIR     = new URL('.', import.meta.url).pathname;
const LOGS        = `${WORKSPACE}/logs`;
const PORT        = PORTAL_PORT;
const LOG_MAX_BYTES = 5 * 1024 * 1024; // rotate at 5 MB

const procs        = new Map();
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

// Same path shape lib.js already builds with join() for the same concept.
// Kept as a template literal here (not join()) only because that's this
// file's existing convention for WORKSPACE-relative paths throughout.
function wtPath(repo, name) { return `${WORKSPACE}/${repo}/${name}`; }
function repoPath(repo)     { return `${WORKSPACE}/${repo}.git`; }

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

// ── Raycast extension dev mode ──────────────────────────────────────────────
// raycast/ lives inside the setu repo itself (PKG_DIR), not a registered
// project under WORKSPACE — it's Setu's own tooling, not something a
// worktree owns. `ray develop` is a long-running watch process (like `next
// dev`), so this is tracked the same shape as a worktree's dev server
// (procs Map elsewhere) rather than treated as a one-shot command.
const RAYCAST_DIR = `${PKG_DIR}raycast`;
let raycastDev = null; // { proc, pid } | null

function raycastLogPath() {
  const dir = `${LOGS}/_raycast`;
  mkdirSync(dir, { recursive: true });
  return `${dir}/dev.log`;
}

function startRaycastDev() {
  if (raycastDev) return { ok: true };
  if (!existsSync(RAYCAST_DIR)) return { ok: false, error: 'raycast/ not found in the setu repo' };
  const path = raycastLogPath();
  rotateLog(path);
  appendFileSync(path, `\n[${new Date().toISOString()}] ── raycast dev start ──\n`);
  const fd = openSync(path, 'a');
  // One script, not two spawns — `npm install` only when node_modules is
  // missing (so toggling dev mode on repeatedly doesn't reinstall every
  // time), then hands off to `ray develop` in the same process tree so a
  // single pid covers both steps for stop/kill purposes.
  const script = `${tmpdir()}/setu-raycast-dev-${Date.now()}.sh`;
  writeFileSync(script,
    `#!/bin/zsh\ncd "${RAYCAST_DIR}"\n[ -d node_modules ] || npm install\nexec npx ray develop\n`,
    { mode: 0o755 });
  const proc = Bun.spawn(['/bin/zsh', script], { cwd: RAYCAST_DIR, stdout: fd, stderr: fd, detached: true });
  raycastDev = { proc, pid: proc.pid };
  proc.exited.then(() => { if (raycastDev?.proc === proc) raycastDev = null; });
  return { ok: true };
}

async function stopRaycastDev() {
  if (!raycastDev) return { ok: true };
  await killGroupAsync(raycastDev.pid);
  raycastDev = null;
  return { ok: true };
}

// ── repo metadata ─────────────────────────────────────────────────────────────

let REPO_META = loadProjects(WORKSPACE);

// ── git metadata cache (last-commit / ahead-behind, batched per repo) ────────
// branchMetadata()+worktreeBranchMap() are each one call per REPO, not per
// worktree (see lib.js) — still worth a short TTL so a full /api/worktrees
// poll (every 800ms while a start is pending) doesn't re-run them needlessly.
// Nothing in the poll path fetches, so this is inherently as stale as the
// last `git fetch` regardless of TTL — the TTL bounds re-parse cost, not staleness.

const gitMetaCache = new Map(); // repo -> { branchMeta, pathToBranch, fetchedAt }
const GIT_META_TTL = 10_000;

function repoGitMeta(repo) {
  const cached = gitMetaCache.get(repo);
  if (cached && Date.now() - cached.fetchedAt < GIT_META_TTL) return cached;
  const repoDir = repoPath(repo);
  let branchMeta = new Map(), pathToBranch = new Map();
  try {
    branchMeta = branchMetadata(repoDir);
    pathToBranch = worktreeBranchMap(repoDir);
  } catch {}
  const entry = { branchMeta, pathToBranch, fetchedAt: Date.now() };
  gitMetaCache.set(repo, entry);
  return entry;
}

// Uncommitted-changes count — genuinely per-worktree (live working-tree
// state, can't be batched from the bare repo like the ref data above).
// Same shape as fetchPR: Bun.spawn (not execFileSync — see fetchPR's own
// comment on why), short TTL cache.
const dirtyCache = new Map();
const DIRTY_TTL  = 5_000;

async function fetchDirty(repo, name) {
  const key    = `${repo}/${name}`;
  const cached = dirtyCache.get(key);
  if (cached && Date.now() - cached.fetchedAt < DIRTY_TTL) return cached.count;
  const wtDir = wtPath(repo, name);
  const raw = await spawnText(['git', '-C', wtDir, '--no-optional-locks', 'status', '--porcelain']);
  const count = raw ? raw.split('\n').length : 0;
  dirtyCache.set(key, { count, fetchedAt: Date.now() });
  return count;
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
  const key    = `${repo}/${name}`;
  const cached = convexConfigCache.get(key);
  if (cached && Date.now() - cached.fetchedAt < CONVEX_CONFIG_TTL) return cached.dir;
  const dir = convexDir(repo, wtDir);
  convexConfigCache.set(key, { dir, fetchedAt: Date.now() });
  return dir;
}

// ── PR cache ──────────────────────────────────────────────────────────────────

const prCache = new Map();
const PR_TTL  = 60_000;

// statusCheckRollup mixes two shapes in the same array (confirmed live on a
// real merged PR that had both): CheckRun (GitHub Actions, status+conclusion)
// and StatusContext (legacy commit statuses, state only). Collapse both into
// one summary rather than surfacing per-check detail, the badge only needs
// passing/failing/pending/none, not a checks list.
function summarizeChecks(rollup) {
  if (!Array.isArray(rollup) || rollup.length === 0) return 'none';
  let sawPending = false;
  for (const c of rollup) {
    if (c.__typename === 'StatusContext') {
      if (c.state === 'FAILURE' || c.state === 'ERROR') return 'failing';
      if (c.state === 'PENDING' || c.state === 'EXPECTED') sawPending = true;
      continue;
    }
    if (c.status !== 'COMPLETED') { sawPending = true; continue; }
    // SKIPPED/NEUTRAL aren't failures, a real run (path-filtered CI) can
    // skip most jobs and still be a passing PR.
    if (c.conclusion === 'FAILURE' || c.conclusion === 'CANCELLED' ||
        c.conclusion === 'TIMED_OUT' || c.conclusion === 'ACTION_REQUIRED') return 'failing';
  }
  return sawPending ? 'pending' : 'passing';
}

async function fetchPR(repo, name) {
  const key    = `${repo}/${name}`;
  const cached = prCache.get(key);
  if (cached && Date.now() - cached.fetchedAt < PR_TTL) return cached;
  try {
    // ponytail: Bun.spawn (via spawnText) keeps event loop unblocked; execFileSync froze it with 10+ parallel calls
    // `gh pr view <branch>` instead of `pr list --head`: one call gets
    // state/isDraft/statusCheckRollup alongside number/title/url, where list
    // only ever returned the bare three.
    const raw = await spawnText(['gh', 'pr', 'view', name,
      '--repo', REPO_META[repo]?.slug ?? repo,
      '--json', 'number,title,url,state,isDraft,statusCheckRollup',
    ]);
    const raw2 = JSON.parse(raw);
    // gh's `state` is a real three-value enum (OPEN/CLOSED/MERGED), not a
    // boolean plus a separate merged flag, confirmed live against several
    // merged and closed PRs. MERGED/CLOSED are terminal and take precedence
    // over isDraft: a closed PR can still carry isDraft:true (confirmed live),
    // but "draft" as a display state only makes sense while still open.
    const state = raw2.state === 'MERGED' ? 'merged'
      : raw2.state === 'CLOSED' ? 'closed'
      : raw2.isDraft ? 'draft' : 'open';
    const entry = {
      number: raw2.number, title: raw2.title, url: raw2.url,
      state, checks: summarizeChecks(raw2.statusCheckRollup),
      fetchedAt: Date.now(),
    };
    prCache.set(key, entry);
    return entry;
  } catch {
    // Empty stdout (no PR for this branch, or `gh` failing) fails JSON.parse
    // the same way `pr list` returning `[]` used to, same fallback shape.
    const entry = { fetchedAt: Date.now() };
    prCache.set(key, entry);
    return entry;
  }
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
  if (!slug) return { prs: [], error: 'no GitHub repo configured for this project' };
  const cached = repoPrsCache.get(repo);
  if (cached && Date.now() - cached.fetchedAt < PR_TTL) return cached;
  // spawnText swallows a bad binary/non-zero exit/timeout into an empty
  // string rather than throwing (see its own comment in lib.js) and drops
  // stderr entirely, so a genuine `gh` failure never yields the real reason
  // -- only that it's not valid JSON. `gh pr list` printing zero PRs is
  // still a well-formed `[]`, so that case parses fine and never reaches
  // this branch; only a real call failure (bad auth, unreachable repo,
  // timeout) does, which is exactly the case worth a clear, actionable
  // message instead of a raw JSON syntax error.
  const raw = await spawnText(['gh', 'pr', 'list', '--repo', slug, '--state', 'open',
    '--json', 'number,title,url,headRefName,isDraft,statusCheckRollup,updatedAt,author', '--limit', '50']);
  let list;
  try { list = JSON.parse(raw); }
  catch {
    const entry = { prs: [], error: `gh pr list failed for ${slug} -- check "gh auth status" and that the repo is reachable`, fetchedAt: Date.now() };
    repoPrsCache.set(repo, entry);
    return entry;
  }
  const entry = {
    prs: list.map(p => ({
      number: p.number, title: p.title, url: p.url, branch: p.headRefName,
      isDraft: p.isDraft, checks: summarizeChecks(p.statusCheckRollup),
      updatedAt: p.updatedAt, author: p.author?.login ?? null,
    })),
    error: null, fetchedAt: Date.now(),
  };
  repoPrsCache.set(repo, entry);
  return entry;
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

// Hand-rolled unified-diff parser: no diff-parsing dependency in this
// project, and the format is regular enough not to need one. Single
// line-by-line state machine: `cur` is the file entry being built, `hunk`
// the current hunk within it. `cur.sawHunk` disambiguates the one place the
// format is genuinely ambiguous: a real content line that happens to start
// with "--- " or "+++ " (e.g. removing a line of literal "-- foo") would
// otherwise be mistaken for the file-header lines, which only ever appear
// once, before the first "@@" of a file.
function parseUnifiedDiff(raw) {
  if (!raw) return [];
  const files = [];
  let cur = null, hunk = null, oldLine = 0, newLine = 0, seenFiles = 0;

  function flushHunk() {
    // Once a file is flagged tooLarge its hunks are dropped at render time
    // anyway, so skip retaining them here: an oversized file's content
    // shouldn't sit in memory for the rest of the parse.
    if (cur && hunk && !cur.tooLarge) cur.hunks.push(hunk);
    hunk = null;
  }
  function flushFile() {
    flushHunk();
    if (cur) files.push(cur);
    cur = null;
  }

  for (const line of raw.split('\n')) {
    if (line.startsWith('diff --git ')) {
      flushFile();
      seenFiles++;
      // "a/<path> b/<path>": greedy match backtracks to the rightmost
      // " b/", which is correct for the common case (identical paths, or a
      // path that doesn't itself contain the literal substring " b/").
      const m = line.slice('diff --git '.length).match(/^a\/(.*) b\/(.*)$/);
      cur = {
        file: m ? m[2] : line.slice('diff --git '.length), additions: 0, deletions: 0, hunks: [], sawHunk: false,
        // A file past DIFF_MAX_FILES gets sliced out of the response by
        // summarizeDiff regardless, so reuse the same skip-building path an
        // individually oversized file already takes below: count its real
        // additions/deletions for the summary total, don't materialize its
        // hunk content just to discard it a moment later.
        tooLarge: seenFiles > DIFF_MAX_FILES,
      };
      continue;
    }
    if (!cur) continue; // stray output before the first file header, shouldn't happen

    if (line.startsWith('Binary files ')) {
      cur.binary = true;
      const m = line.match(/^Binary files (.+) and (.+) differ$/);
      if (m) {
        const a = m[1].replace(/^a\//, ''), b = m[2].replace(/^b\//, '');
        cur.file = b !== '/dev/null' ? b : a; // deleted binary file, show the old path
      }
      continue;
    }
    if (!cur.sawHunk && line.startsWith('--- ')) {
      const p = line.slice(4).replace(/^a\//, '');
      if (p !== '/dev/null') cur._oldPath = p;
      continue;
    }
    if (!cur.sawHunk && line.startsWith('+++ ')) {
      const p = line.slice(4).replace(/^b\//, '');
      cur.file = p !== '/dev/null' ? p : (cur._oldPath ?? cur.file); // deleted file, show the old path
      continue;
    }
    const hm = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hm) {
      flushHunk();
      cur.sawHunk = true;
      oldLine = parseInt(hm[1], 10);
      newLine = parseInt(hm[2], 10);
      hunk = { header: line, lines: [] };
      continue;
    }
    if (!hunk) continue; // metadata between file header and first hunk (index/mode/rename lines)

    // Counts and line numbers keep advancing even past the size cap (an
    // oversized file should still report an accurate total), only the
    // per-line array stops growing.
    if (line.startsWith('+')) {
      cur.additions++;
      if (!cur.tooLarge) hunk.lines.push({ type: 'add', content: line.slice(1), newLine: newLine++ }); else newLine++;
    } else if (line.startsWith('-')) {
      cur.deletions++;
      if (!cur.tooLarge) hunk.lines.push({ type: 'remove', content: line.slice(1), oldLine: oldLine++ }); else oldLine++;
    } else if (line.startsWith(' ')) {
      if (!cur.tooLarge) hunk.lines.push({ type: 'context', content: line.slice(1), oldLine: oldLine++, newLine: newLine++ });
      else { oldLine++; newLine++; }
    }
    // A "\ No newline at end of file" marker matches none of the above and is dropped, as intended.

    if (!cur.tooLarge && cur.additions + cur.deletions > DIFF_FILE_LINE_CAP) cur.tooLarge = true;
  }
  flushFile();

  // Strip internal-only bookkeeping before handing back to the caller.
  return files.map(({ sawHunk, _oldPath, tooLarge, hunks, ...f }) =>
    tooLarge ? { ...f, hunks: [], tooLarge: true } : { ...f, hunks });
}

// additions/deletions are summed across ALL parsed files (before the
// DIFF_MAX_FILES slice) so the summary line stays accurate even when the
// file list itself is truncated.
function summarizeDiff(raw) {
  const all = parseUnifiedDiff(raw);
  let additions = 0, deletions = 0;
  for (const f of all) { additions += f.additions; deletions += f.deletions; }
  return {
    files: all.slice(0, DIFF_MAX_FILES),
    additions, deletions,
    totalFiles: all.length,
    truncatedFileCount: Math.max(0, all.length - DIFF_MAX_FILES),
  };
}

// Two separate diffs, not one merged one: they answer different questions.
// "committed" is what this branch will actually contribute if merged, a
// merge-base (three-dot) diff against the same base baseBranchRef() already
// resolves for ahead/behind, so it only shows what THIS branch did, not
// whatever base moved on to since divergence. "uncommitted" is what's sitting
// in the working tree right now and would be lost on a stash/checkout. `git
// diff HEAD` alone covers both staged and unstaged changes in one pass, since
// it compares the working tree directly against HEAD regardless of index state.
async function computeDiff(repo, name) {
  const wtDir   = wtPath(repo, name);
  const repoDir = repoPath(repo);
  const base    = baseBranchRef(repoDir);

  // baseBranchRef always returns a ref name, but that ref may not actually
  // resolve (origin/<default> never fetched, a stale remote-tracking branch).
  // spawnText swallows git's non-zero exit into an empty string the same way
  // a genuinely empty diff would come back, so without this check an
  // unresolvable base is indistinguishable from "this branch is fully
  // merged", so the UI would tell a worktree that's 60 commits ahead that it
  // has no changes. Check explicitly and let the frontend say so.
  const baseResolved = !!(await spawnText(['git', '-C', wtDir, 'rev-parse', '--verify', '--quiet', base]));

  const [committedRaw, uncommittedRaw] = await Promise.all([
    baseResolved ? spawnText(['git', '-C', wtDir, 'diff', `${base}...HEAD`]) : Promise.resolve(''),
    spawnText(['git', '-C', wtDir, 'diff', 'HEAD']),
  ]);

  return { base, baseResolved, committed: summarizeDiff(committedRaw), uncommitted: summarizeDiff(uncommittedRaw) };
}

// ── helpers ───────────────────────────────────────────────────────────────────

// ponytail: ports.js's activePid() call in getWorktrees() used to run once per
// worktree, every poll (3s idle / 800ms mid-start) — same execFileSync-freezes-the-
// event-loop bug fetchPR() already had. Batch + short TTL cache, shared with /api/ports.
let _portsCache = null, _portsCacheAt = 0;
const PORTS_TTL = 1500;

async function activePortsCached() {
  const now = Date.now();
  if (_portsCache && now - _portsCacheAt < PORTS_TTL) return _portsCache;
  _portsCache = await listActivePortsAsync();
  _portsCacheAt = now;
  return _portsCache;
}

// Shared by /api/ports and mcp-server.js's list_ports tool.
async function listPortsWithWorktree() {
  const ports = await activePortsCached();
  const registry = Object.fromEntries(portEntries(WORKSPACE).map(e => [e.port, e.key]));
  return ports.map(p => ({ ...p, worktree: registry[p.port] ?? null }));
}

async function killPort(port) {
  // A container-published port's host-side "process" is the engine's own
  // port-forwarding helper, not the dev server itself — signaling it directly
  // isn't scoped to one container (reconcileDevServers hits this exact hazard
  // and already branches container-first for the same reason). Route through
  // the real stop path whenever the port belongs to a known, container-backed
  // worktree; the raw PID-kill fallback below stays for bare processes and for
  // genuinely-unregistered ports (setu prune's orphan-killing case).
  const owner = portEntries(WORKSPACE).find(e => e.port === port);
  const entry = owner && procs.get(owner.key);
  if (entry?.container) {
    stopContainer(owner.repo, owner.name, entry.container);
    if (procs.get(owner.key) === entry) procs.delete(owner.key);
    drainQueue();
    return { ok: true };
  }
  const pid = await activePidAsync(port);
  if (!pid) return { ok: false, error: 'nothing on that port' };
  try { process.kill(parseInt(pid), 'SIGTERM'); return { ok: true }; }
  catch (e) { return { ok: false, error: String(e) }; }
}

// Resource usage — only ever called for `active` worktrees (no point
// measuring what isn't running), so this never scales with the full 45+
// worktree registry, only with maxConcurrentDevServers (default 3).
async function activeMemMb(entry) {
  if (!entry) return null;
  if (entry.container) {
    const id = (await spawnText(['docker', 'compose', '-p', entry.container, 'ps', '-q'])).split('\n')[0];
    if (!id) return null;
    const raw = await spawnText(['docker', 'stats', '--no-stream', '--format', '{{.MemUsage}}', id]);
    // "123.4MiB / 4GiB" — only the used side matters here
    const m = raw.match(/^([\d.]+)\s*(MiB|GiB)/);
    if (!m) return null;
    return m[2] === 'GiB' ? parseFloat(m[1]) * 1024 : parseFloat(m[1]);
  }
  if (entry.pid) return processFootprintMb(entry.pid);
  return null;
}

async function getWorktrees() {
  const activePorts = new Set((await activePortsCached()).map(p => p.port));
  return Promise.all(
    portEntries(WORKSPACE).map(async ({ key, repo, name, port }) => {
      const slug     = name.replace(/\//g, '-');
      const domain   = localDomain(repo, name);
      const wtDir    = wtPath(repo, name);
      const tunnelOn = tunnelEnabled(wtDir, _cfg);
      const meta     = REPO_META[repo] ?? { label: repo, github: null };
      const branchUrl = meta.github ? `${meta.github}/tree/${name}` : null;
      const pr        = name !== 'main' ? await fetchPR(repo, name) : null;
      const iPort = inngestPort(port);
      const active = activePorts.has(port);
      const procEntry = procs.get(key);

      // Worktree directory name isn't reliably the branch name — join
      // through the real path->branch map, not an assumption (see
      // worktreeBranchMap's comment in lib.js for the confirmed live case
      // where this bit us).
      const { branchMeta, pathToBranch } = repoGitMeta(repo);
      const branch = pathToBranch.get(resolve(wtDir)) ?? name;
      const gm = branchMeta.get(branch) ?? { lastCommitAt: null, ahead: 0, behind: 0 };
      const [dirty, memMb] = await Promise.all([
        fetchDirty(repo, name),
        active ? activeMemMb(procEntry) : Promise.resolve(null),
      ]);

      return {
        key, repo, name, slug, port, domain, pubDomain: publicDomain(_cfg), tunnelOn,
        active,
        container:     procEntry?.container ?? null,
        // What a plain Start (no explicit --container/--bare) would resolve
        // to right now — lets the UI show this *before* the click instead of
        // the user finding out after, which is the exact blind spot that let
        // an established worktree get silently switched to a container.
        nextStartMode: defaultContainerMode(WORKSPACE, repo, name) ? 'container' : 'bare',
        needsMigrationPrompt: needsMigrationPrompt(WORKSPACE, repo, name),
        queued:        queuePosition(key) !== null,
        queuePosition: queuePosition(key),
        tunnelRunning: tunnelProc !== null && activeTunnelMap.has(key),
        label:         meta.label,
        branch,
        branchUrl,
        pr:            pr?.url ? { url: pr.url, number: pr.number, title: pr.title, state: pr.state, checks: pr.checks } : null,
        vercelDeploy:  vercelStatus(repo, name),
        netlifyDeploy: netlifyStatus(repo, name),
        inngestActive: inngestProcs.has(key) || activePorts.has(iPort),
        inngestPort:   iPort,
        triggerActive: triggerProcs.has(key),
        // Gate for whether the Convex section renders at all -- unlike
        // Inngest/Trigger (assumed available to every worktree), Convex is
        // only relevant to worktrees that actually have it configured.
        convexConfigured: cachedConvexDir(repo, name, wtDir) !== null,
        convexActive:     convexDevProcs.has(key),
        convexDeploy:     convexDeployStatus(repo, name),
        // Configured custom sidecars (sidecars.json, repo-scoped) and
        // whether each is actually running for THIS worktree right now --
        // previously tracked correctly in sidecarProcs but never surfaced
        // to any client, so there was no way to see one was alive short of
        // reading its raw log file.
        sidecars: loadSidecars(WORKSPACE, repo).map(s => ({
          name: s.name, active: sidecarProcs.has(`${key}/${s.name}`),
        })),
        lastCommitAt:  gm.lastCommitAt,
        ahead:         gm.ahead,
        behind:        gm.behind,
        dirty,
        memMb,
        // Directory birthtime, not a subprocess — statSync is essentially
        // free (no spawn) and APFS supports real birthtime. This is
        // creation time, not last-activity — don't conflate the two in the
        // UI (lastCommitAt is the "worked on" signal).
        createdAt: (() => { try { return Math.floor(statSync(wtDir).birthtimeMs / 1000); } catch { return null; } })(),
      };
    })
  );
}

// ── dev server ────────────────────────────────────────────────────────────────
// Each next-server can still be several hundred MB to low-GB even after the
// Turbopack-eviction fix (Next.js ≥16.3.0) — unbounded concurrent starts is
// exactly the failure mode this whole portal exists to prevent. Cap concurrent
// dev servers; anything beyond the cap queues and starts automatically as a
// slot frees up (a worktree stopping, or exiting on its own).
// `let`, not `const` — the settings page (POST /api/settings) updates this
// in-memory so a concurrency-cap change takes effect immediately, not only
// after the portal process restarts. Persisted to ~/.setu.json via
// saveConfig() at the same time so it survives a real restart too.
let MAX_CONCURRENT_DEV = _cfg.maxConcurrentDevServers ?? 3;
const startQueue = []; // [{ key, repo, name, port }], FIFO

function queuePosition(key) {
  const i = startQueue.findIndex(q => q.key === key);
  return i === -1 ? null : i + 1;
}

function drainQueue() {
  while (startQueue.length && procs.size < MAX_CONCURRENT_DEV) {
    const next = startQueue.shift();
    if (procs.has(next.key)) continue; // started some other way already
    if (next.container) spawnContainer(next.repo, next.name, next.port);
    else spawnWorktree(next.repo, next.name, next.port);
  }
}

function spawnWorktree(repo, name, port) {
  const key   = `${repo}/${name}`;
  const wtDir = wtPath(repo, name);
  const env  = { ...process.env, PORT: String(port), ...parseEnvFile(join(wtDir, '.envrc')) };
  const fd   = openLogFd(repo, name, 'dev');
  const proc = Bun.spawn(['bun', 'dev'], { cwd: wtDir, env, stdout: fd, stderr: fd });
  const entry = wrapProc(proc);
  procs.set(key, entry);
  lastSeenAt.set(key, Date.now()); // idle-timeout baseline: clock starts at spawn, not at zero
  proc.exited.then(() => { if (procs.get(key) === entry) { procs.delete(key); drainQueue(); } });
  return { skippedSidecars: startSidecars(repo, name, port) };
}

// Container path: `docker compose up -d --build` returns as soon as containers
// are created and detached — the slow part (bun install && bun run dev) runs
// INSIDE the container afterward, so this is not a blocking start any more than
// the bare path is. Readiness is observed the same way as bare processes: once
// the container's published port opens, getWorktrees()'s existing lsof-based
// scan sees it — no container-specific polling needed there.
function spawnContainer(repo, name, port) {
  const key   = `${repo}/${name}`;
  const wtDir = wtPath(repo, name);
  writeDockerCompose(_cfg, repo, name, port);
  const project = composeProjectName(repo, name);
  const fd = openLogFd(repo, name, 'dev');
  const proc = Bun.spawn(
    ['docker', 'compose', '-p', project, '-f', dockerComposePath(wtDir), 'up', '-d', '--build'],
    { cwd: wtDir, stdout: fd, stderr: fd });
  const entry = wrapContainer(project);
  procs.set(key, entry);
  proc.exited.then((code) => {
    // Only `up -d` itself failing (bad compose file, daemon unreachable) lands
    // here fast — the app's own boot happens after this exits, inside the
    // container. A nonzero exit means no container is actually running, so
    // don't leave a phantom "running" entry blocking the concurrency slot.
    if (code !== 0 && procs.get(key) === entry) { procs.delete(key); drainQueue(); }
  });
  return { skippedSidecars: startSidecars(repo, name, port) };
}

function stopContainer(repo, name, project) {
  const wtDir = wtPath(repo, name);
  // No -v: the node_modules named volume survives, so the next `up` skips
  // `bun install` unless the compose file's volume was ever pruned separately.
  try { execFileSync('docker', ['compose', '-p', project, '-f', dockerComposePath(wtDir), 'down'], { stdio: 'ignore' }); }
  catch {}
}

// Boot-time only: procs starts empty on every portal restart, same blind spot
// reconcileTriggerSidecars() fixes for Trigger — without this, a dev server
// that predates this portal instance (e.g. still running from before a
// restart) doesn't count against MAX_CONCURRENT_DEV, so the cap silently
// undercounts real concurrent servers. Container-backed worktrees are checked
// FIRST via `docker compose ps` — falling through to the generic port scan for
// them would misidentify the engine's own port-forwarding helper process as
// "the dev server pid" and a later stop would try to kill it directly, which
// isn't safe (that helper isn't scoped to one container).
function reconcileDevServers() {
  const activePorts = new Map(listActivePorts().map(p => [p.port, p.pid]));
  for (const { key, repo, name, port } of portEntries(WORKSPACE)) {
    if (procs.has(key)) continue;
    const wtDir = wtPath(repo, name);
    if (existsSync(dockerComposePath(wtDir))) {
      const project = composeProjectName(repo, name);
      if (composeProjectAlive(project)) { procs.set(key, wrapContainer(project)); continue; }
    }
    const pid = activePorts.get(port);
    if (pid) {
      procs.set(key, wrapPid(+pid));
      // True start time is unknown for a process discovered already running
      // (it predates this portal instance). Use portal-restart time as a
      // conservative idle-timeout baseline rather than leaving it untracked.
      lastSeenAt.set(key, Date.now());
    }
  }
}

function startWorktree(repo, name, port, container = true) {
  const key = `${repo}/${name}`;
  if (procs.has(key)) return { ok: false, error: 'already running' };
  if (queuePosition(key)) return { ok: true, queued: true, position: queuePosition(key) };
  if (container) {
    const rt = containerRuntimeAvailable();
    // Fail loud, not silently downgrade to bare — a caller expecting a hard
    // memory/CPU cap getting a silently-uncapped process instead would defeat
    // the entire point. Explicit --bare is the escape hatch, not a fallback
    // this function reaches for on its own.
    if (!rt.available) return { ok: false, error: 'no Docker-compatible daemon reachable (docker info failed) — start OrbStack/Docker Desktop, or pass --bare to run natively instead' };
  }
  if (procs.size >= MAX_CONCURRENT_DEV) {
    startQueue.push({ key, repo, name, port, container });
    return { ok: true, queued: true, position: startQueue.length, container };
  }
  const spawned = container ? spawnContainer(repo, name, port) : spawnWorktree(repo, name, port);
  const result = { ok: true, container };
  // Only present when something was actually skipped. Every other caller
  // of /api/start keeps getting the exact response shape it already handles.
  if (spawned?.skippedSidecars?.length) result.skippedSidecars = spawned.skippedSidecars;
  return result;
}

// drain=false is for callers that stop a worktree only to immediately respawn
// the SAME one (a restart, not a real vacancy) — checkMemoryCeilings' restart
// path and the tunnel toggle below. Defaulting drain=true here and letting
// drainQueue() run unconditionally used to admit a queued worktree into the
// slot in the moment between stop and respawn, and then the caller's respawn
// added the original worktree back on top — procs.size silently exceeding
// MAX_CONCURRENT_DEV, the exact thing the cap exists to prevent. If the
// respawn itself later fails, spawnWorktree/spawnContainer's own `.then`
// handlers already drain the queue — so skipping the drain here never leaves
// a slot stuck, it only avoids double-counting during a same-worktree restart.
async function stopWorktree(repo, name, port, { drain = true } = {}) {
  const key = `${repo}/${name}`;
  const qi = startQueue.findIndex(q => q.key === key);
  if (qi !== -1) startQueue.splice(qi, 1);
  const entry = procs.get(key);
  procs.delete(key);
  if (entry?.container) {
    stopContainer(repo, name, entry.container);
  } else {
    // Raw single-pid kill, not killGroup() (lib.js): spawnWorktree() below
    // spawns the dev server without detached:true, so it shares this portal
    // process's own pgid rather than leading its own. killGroup would look
    // that pgid up, see pgid !== pid, and fall back to this exact same
    // single-pid kill anyway (verified empirically), so this is already
    // equivalent, not an inconsistency to fix.
    const pid = await activePidAsync(port);
    if (pid) { try { execFileSync('kill', [pid]); } catch {} }
  }
  await Promise.all([
    stopInngest(repo, name, port),
    stopTrigger(repo, name),
    stopConvexDev(repo, name),
    stopSidecars(repo, name),
  ]);
  if (drain) drainQueue();
}

// Port + container-mode resolution wrapped around startWorktree/stopWorktree
// so /api/start, /api/stop, and mcp-server.js's start_worktree/stop_worktree
// tools share one implementation instead of three copies of this logic.
function startWorktreeByName(repo, name, container) {
  const port = getPort(WORKSPACE, repo, name);
  if (!port) return { ok: false };
  const useContainer = container === undefined ? defaultContainerMode(WORKSPACE, repo, name) : container !== false;
  if (container !== undefined && needsMigrationPrompt(WORKSPACE, repo, name)) markMigrationPrompted(WORKSPACE, repo, name);
  return startWorktree(repo, name, port, useContainer);
}

async function stopWorktreeByName(repo, name) {
  const port = getPort(WORKSPACE, repo, name);
  if (!port) return { ok: false };
  await stopWorktree(repo, name, port);
  return { ok: true };
}

// Shared by /api/sync and mcp-server.js's sync_worktree tool.
async function syncWorktreeByName(repo, name) {
  return syncWithBase(wtPath(repo, name), repoPath(repo));
}

// ── configurable per-project sidecars (workspace/sidecars.json) ──────────────
// Generic version of what startInngest/startTrigger already do, for anything
// project-specific that isn't Inngest or Trigger — a plain cloudflared tunnel,
// a queue worker, whatever a future project needs. Not hardcoded to quivly-app.

// Returns the names of any sidecars skipped for lacking approval, so the
// start path (spawnWorktree/spawnContainer -> startWorktree) can surface it
// to whoever asked for the start, instead of just silently not running.
function startSidecars(repo, name, port) {
  const wtDir = wtPath(repo, name);
  const skipped = [];
  for (const s of loadSidecars(WORKSPACE, repo)) {
    const key = `${repo}/${name}/${s.name}`;
    if (sidecarProcs.has(key)) continue;
    // New or edited since it was last approved: skip only this one sidecar,
    // the dev server and every other already-approved sidecar still start.
    // s.name guarded truthy: a nameless row (settings UI allows adding one
    // with a command but no name yet) still gets gated, just not reported by
    // an empty string the toast would render as "sidecar '' needs approval".
    if (!isSidecarApproved(WORKSPACE, repo, s)) { if (s.name) skipped.push(s.name); continue; }
    const fd  = openLogFd(repo, name, `sidecar-${s.name}`);
    const env = { ...process.env, PORT: String(port), ...s.env };
    const proc = Bun.spawn([s.command, ...(s.args ?? [])], { cwd: wtDir, env, stdout: fd, stderr: fd, detached: true });
    const entry = wrapProc(proc);
    sidecarProcs.set(key, entry);
    proc.exited.then(() => { if (sidecarProcs.get(key) === entry) sidecarProcs.delete(key); });
  }
  return skipped;
}

async function stopSidecars(repo, name) {
  const prefix = `${repo}/${name}/`;
  const keys = [...sidecarProcs.keys()].filter(k => k.startsWith(prefix));
  await Promise.all(keys.map(k => killGroupAsync(sidecarProcs.get(k).pid)));
  for (const k of keys) sidecarProcs.delete(k);
}

// Uniform wrapper for both freshly-spawned (native Bun.Subprocess) and reconciled
// (discovered-at-startup, PID only) sidecar entries — lets stop paths kill either
// the same way, and lets a portal restart re-adopt a still-live sidecar instead of
// losing track of it (inngestProcs/triggerProcs start as empty Maps every restart).
function wrapProc(proc) { return { pid: proc.pid, native: proc }; }
function wrapPid(pid)   { return { pid, native: null }; }
// Container-backed entries have no OS pid Setu owns directly (the tracked
// process is `docker compose up -d`, which exits once containers are
// created) — `container` holds the compose project name instead, and
// stop/reconcile paths branch on its presence.
function wrapContainer(project) { return { pid: null, native: null, container: project }; }

// ── inngest dev server ────────────────────────────────────────────────────────

async function startInngest(repo, name, port) {
  const key   = `${repo}/${name}`;
  if (inngestProcs.has(key)) return { ok: false, error: 'already running' };
  const iPort = inngestPort(port);
  if (await activePidAsync(iPort)) return { ok: false, error: `port ${iPort} already in use (untracked process)` };
  const fd    = openLogFd(repo, name, 'inngest');
  const proc  = Bun.spawn(
    [INNGEST_CLI, 'dev', '-p', String(iPort), '-u', `http://localhost:${port}/api/inngest`, '--no-discovery'],
    { stdout: fd, stderr: fd, detached: true }
  );
  const entry = wrapProc(proc);
  inngestProcs.set(key, entry);
  proc.exited.then(() => { if (inngestProcs.get(key) === entry) inngestProcs.delete(key); });
  return { ok: true, port: iPort };
}

async function stopInngest(repo, name, port) {
  const key   = `${repo}/${name}`;
  const entry = inngestProcs.get(key);
  if (entry) await killGroupAsync(entry.pid);
  inngestProcs.delete(key);
  // fall back to whatever's actually bound to the inngest port, same pattern as
  // stopWorktree — the tracked entry can be stale after a portal restart
  const iPort = port != null ? inngestPort(port) : null;
  const pid   = iPort ? await activePidAsync(iPort) : null;
  if (pid) await killGroupAsync(pid);
  if (!entry && !pid) return { ok: false, error: 'not running' };
  return { ok: true };
}

// ── trigger.dev dev server (per worktree, like inngest) ──────────────────────

// trigger.dev doesn't bind a local port (it's a websocket client to the cloud
// backend), so unlike inngest its "is this actually running" state can't be
// cross-checked against lsof — startup reconciliation (below) is what keeps this
// accurate across a portal restart instead.
const TRIGGER_MAX_CONCURRENT_RUNS = 2;

function startTrigger(repo, name) {
  const key = `${repo}/${name}`;
  if (triggerProcs.has(key)) return { ok: false, error: 'already running' };
  const wtDir = wtPath(repo, name);
  const fd    = openLogFd(repo, name, 'trigger');
  // trigger tasks import Supabase keys etc. from the shared .env.local at load time
  const env   = { ...process.env, ...parseEnvFile(envLocalPath(repo, wtDir)) };
  const proc  = Bun.spawn(
    ['bunx', `trigger.dev@${pinnedTriggerVersion(wtDir)}`, 'dev', '--max-concurrent-runs', String(TRIGGER_MAX_CONCURRENT_RUNS)],
    { cwd: wtDir, env, stdout: fd, stderr: fd, detached: true });
  const entry = wrapProc(proc);
  triggerProcs.set(key, entry);
  proc.exited.then(() => { if (triggerProcs.get(key) === entry) triggerProcs.delete(key); });
  return { ok: true };
}

async function stopTrigger(repo, name) {
  const key   = `${repo}/${name}`;
  const entry = triggerProcs.get(key);
  if (!entry) return { ok: false, error: 'not running' };
  // group-kill, not entry.native?.kill() — trigger.dev v4.5.3's own SIGTERM handler
  // races ahead of and defeats the code path that would dispose its esbuild child
  // (source-verified), so signal the whole process group directly instead
  await killGroupAsync(entry.pid);
  triggerProcs.delete(key);
  return { ok: true };
}

// Startup-only: discover trigger dev processes already running (from before this
// portal instance started) and adopt them into triggerProcs, keyed by matching
// their cwd against a known worktree. Cheap because it only runs once at boot.
function reconcileTriggerSidecars() {
  let raw;
  try { raw = execFileSync('ps', ['-eo', 'pid=,command='], { encoding: 'utf8' }); }
  catch { return; }
  const dirToKey = new Map(
    portEntries(WORKSPACE).map(({ key, repo, name }) => [wtPath(repo, name), key])
  );
  for (const line of raw.split('\n')) {
    const m = line.match(/^\s*(\d+)\s+.*\.bin\/trigger dev\b/);
    if (!m) continue;
    const pid = +m[1];
    const cwd = processCwd(pid);
    const key = cwd && dirToKey.get(cwd);
    if (key && !triggerProcs.has(key)) triggerProcs.set(key, wrapPid(pid));
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
function convexDevAlreadyRunning(dir) {
  let raw;
  try { raw = execFileSync('ps', ['-eo', 'pid=,command='], { encoding: 'utf8' }); }
  catch { return false; }
  for (const line of raw.split('\n')) {
    const m = line.match(/^\s*(\d+)\s+.*\bconvex dev\b/);
    if (m && processCwd(+m[1]) === dir) return true;
  }
  return false;
}

function startConvexDev(repo, name) {
  const key = `${repo}/${name}`;
  if (convexDevProcs.has(key)) return { ok: false, error: 'already running' };
  const wtDir = wtPath(repo, name);
  const dir = convexDir(repo, wtDir);
  if (!dir) return { ok: false, error: 'Convex is not configured in this worktree' };
  if (!commandExists('npx')) return { ok: false, error: 'npx not found on PATH' };
  if (convexDevAlreadyRunning(dir)) {
    return { ok: false, error: `a convex dev process already appears to be running in ${dir} (untracked, likely from before a portal restart)` };
  }
  const fd = openLogFd(repo, name, 'convex');
  // stdin: 'ignore', not inherited -- detection only proves convex/ or
  // CONVEX_DEPLOYMENT exist, not that the saved auth token is still valid. A
  // stale token makes `convex dev` prompt to re-authenticate, the same
  // failure mode the vercel deploy block below spends its own comment on:
  // with no terminal attached, an inherited stdin would hang forever with
  // convexActive stuck true and an empty log, instead of failing the prompt
  // and exiting so the log actually explains what happened.
  const proc = Bun.spawn(['npx', 'convex', 'dev'],
    { cwd: dir, stdout: fd, stderr: fd, stdin: 'ignore', detached: true });
  const entry = wrapProc(proc);
  convexDevProcs.set(key, entry);
  proc.exited.then(() => { if (convexDevProcs.get(key) === entry) convexDevProcs.delete(key); });
  return { ok: true };
}

async function stopConvexDev(repo, name) {
  const key   = `${repo}/${name}`;
  const entry = convexDevProcs.get(key);
  if (!entry) return { ok: false, error: 'not running' };
  await killGroupAsync(entry.pid);
  convexDevProcs.delete(key);
  return { ok: true };
}

// preview/production are the only two convex deploy modes -- unlike vercel's
// or netlify's third named-custom-target option, convex's preview-vs-prod
// split really is just whether --preview-create is passed, so there's
// nothing a third option would add here. The preview name comes from the
// worktree's real branch, not the worktree directory name (those two can
// differ -- see the branch-resolution comment in getWorktrees above), run
// through the same slugify() every local domain already uses, so one preview
// deployment always maps to the same branch without the user typing or
// remembering a name.
function deployToConvex(repo, name, target) {
  // Reserved to exactly these two words, not treated as a free-text custom
  // target the way vercelArgs/netlifyArgs above treat anything that isn't
  // 'production'/'preview' -- convex genuinely only has two deploy modes (see
  // this function's own comment above), so an unrecognized target is a
  // caller mistake, not a third mode to fall through to. Without this guard
  // a typo like 'staging' would silently run (and store) a preview deploy
  // under the wrong label instead of failing loudly.
  if (target !== 'preview' && target !== 'production') {
    return { ok: false, error: "target must be 'preview' or 'production'" };
  }
  const key = `${repo}/${name}`;
  if (convexDeploys.get(key)?.deploying) return { ok: false, error: 'a deploy is already running for this worktree' };
  const wtDir = wtPath(repo, name);
  const dir = convexDir(repo, wtDir);
  if (!dir) return { ok: false, error: 'Convex is not configured in this worktree' };
  if (!commandExists('npx')) return { ok: false, error: 'npx not found on PATH' };

  const { pathToBranch } = repoGitMeta(repo);
  const branch = pathToBranch.get(resolve(wtDir)) ?? name;
  const args = target === 'production' ? ['deploy'] : ['deploy', '--preview-create', slugify(branch)];

  convexDeploys.set(key, { deploying: true, ok: false, error: null, target, startedAt: Date.now() });
  // Piped, not the shared 'convex' log fd directly: startConvexDev above may
  // already hold that fd open for the persistent dev process, and
  // openLogFd's own rotateLog call (past 5MB) renames the log path out from
  // under whichever fd was opened first -- the dev process would keep
  // writing to the renamed, no-longer-tailed file. Captured here and
  // appended once at exit instead, so a deploy can never collide with the
  // dev process's log lifecycle. Tradeoff: no live streaming of deploy
  // progress in the log tab, only the full output once it finishes --
  // acceptable for an occasional, normally-short action, unlike the dev
  // process's own log.
  const proc = Bun.spawn(['npx', 'convex', ...args],
    { cwd: dir, stdout: 'pipe', stderr: 'pipe', stdin: 'ignore', timeout: 15 * 60 * 1000 });

  (async () => {
    const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
    const code = await proc.exited;
    const finishedAt = convexDeploys.get(key)?.startedAt ?? Date.now();
    const combined = `${out}${err}`.trim();
    appendFileSync(logPath(repo, name, 'convex'), `\n[deploy ${target}]\n${combined}\n`);
    if (code === 0) {
      convexDeploys.set(key, { deploying: false, ok: true, error: null, target, startedAt: finishedAt });
    } else {
      const reason = combined.split('\n').filter(l => l.trim()).at(-1) ?? `convex deploy exited ${code}`;
      convexDeploys.set(key, { deploying: false, ok: false, error: reason, target, startedAt: finishedAt });
    }
  })();

  return { ok: true, deploying: true, target };
}

// ── vercel deploy (per worktree, one-shot, not long-running like a dev
// server) ──────────────────────────────────────────────────────────────────
// Tracked separately from procs/inngestProcs/triggerProcs: those all model
// "is a process currently running," but a deploy's interesting state is what
// it produced (a URL) or why it failed, which outlives the process itself.
const vercelDeploys = new Map(); // key: `${repo}/${name}` -> { deploying, url, error, target, startedAt }

function vercelStatus(repo, name) {
  return vercelDeploys.get(`${repo}/${name}`) ?? null;
}

// preview/production/custom-target are mutually exclusive vercel deploy
// flags. 'production' and 'preview' are reserved regardless of which path
// called this (the picker menu or a typed custom name) so a user can't
// accidentally shadow --prod behind --target=production.
function vercelArgs(target) {
  if (target === 'production') return ['deploy', '--yes', '--prod'];
  if (target === 'preview') return ['deploy', '--yes'];
  return ['deploy', '--yes', `--target=${target}`];
}

function deployToVercel(repo, name, target) {
  const key = `${repo}/${name}`;
  if (vercelDeploys.get(key)?.deploying) return { ok: false, error: 'a deploy is already running for this worktree' };
  if (!commandExists('vercel')) return { ok: false, error: 'vercel CLI not found on PATH, install it first' };
  const wtDir = wtPath(repo, name);
  if (!existsSync(join(wtDir, '.vercel', 'project.json'))) {
    return { ok: false, error: `this worktree isn't linked to a Vercel project, run "vercel link" in ${wtDir} first` };
  }

  const fd = openLogFd(repo, name, 'vercel');
  vercelDeploys.set(key, { deploying: true, url: null, error: null, target, startedAt: Date.now() });
  // stdin: 'ignore', not inherited: --yes skips vercel's own prompts, but a
  // stale/expired auth token can still make it prompt anyway. Inherited
  // stdin would then block forever with no terminal attached, wedging
  // `deploying: true` permanently. Ignored stdin makes that prompt hit EOF
  // and the process exit (nonzero) instead, so the timeout below is a
  // backstop for a different failure mode (a genuinely hung network call),
  // not the only guard against this one.
  const proc = Bun.spawn(['vercel', ...vercelArgs(target)],
    { cwd: wtDir, stdout: 'pipe', stderr: fd, stdin: 'ignore', timeout: 15 * 60 * 1000 });

  (async () => {
    const url = (await new Response(proc.stdout).text()).trim();
    const code = await proc.exited;
    const finishedAt = vercelDeploys.get(key)?.startedAt ?? Date.now();
    if (code === 0 && url) {
      appendFileSync(logPath(repo, name, 'vercel'), `\n${url}\n`);
      vercelDeploys.set(key, { deploying: false, url, error: null, target, startedAt: finishedAt });
    } else {
      // The real reason (bad auth, project mismatch, build failure) went to
      // the log fd above, not to stdout, which is why this reads it back
      // instead of settling for a bare exit code.
      const reason = tailLog(repo, name, 'vercel', 20).lines.filter(l => l.trim()).at(-1) ?? `vercel exited ${code}`;
      appendFileSync(logPath(repo, name, 'vercel'), `\n[deploy failed] ${reason}\n`);
      vercelDeploys.set(key, { deploying: false, url: null, error: reason, target, startedAt: finishedAt });
    }
  })();

  return { ok: true, deploying: true, target };
}

// ── netlify deploy (per worktree, one-shot, mirrors the vercel block above)
const netlifyDeploys = new Map(); // key: `${repo}/${name}` -> { deploying, url, error, target, startedAt }

function netlifyStatus(repo, name) {
  return netlifyDeploys.get(`${repo}/${name}`) ?? null;
}

// preview/production/branch-custom are mutually exclusive netlify deploy
// modes, same convention as vercelArgs above. netlify deploy has no --yes or
// --auto flag to skip its own prompts (checked netlify-cli's own commander
// option list directly, nothing like that exists) -- see deployToNetlify's
// own comment below for why stdin: 'ignore' is enough on its own.
function netlifyArgs(target) {
  if (target === 'production') return ['deploy', '--json', '--prod'];
  if (target === 'preview') return ['deploy', '--json'];
  return ['deploy', '--json', '--context', `branch:${target}`];
}

// netlify deploy --json prints exactly one pretty-printed JSON object to
// stdout and nothing else (netlify-cli's own log() helper is a no-op once
// --json is anywhere in argv, confirmed in its source), but a misbehaving
// local build step could still write noise ahead of it, so this takes the
// last top-level object in the captured text instead of assuming the whole
// stream is clean. Works because the real payload is a flat object (no
// nested braces), so its own opening brace is always the last "{" in the
// text -- verified against a synthetic noisy sample before wiring this in.
function parseNetlifyJson(text) {
  const trimmed = text.trim();
  try { return JSON.parse(trimmed); } catch {}
  const idx = trimmed.lastIndexOf('{');
  if (idx === -1) return null;
  try { return JSON.parse(trimmed.slice(idx)); } catch { return null; }
}

function deployToNetlify(repo, name, target) {
  const key = `${repo}/${name}`;
  if (netlifyDeploys.get(key)?.deploying) return { ok: false, error: 'a deploy is already running for this worktree' };
  if (!commandExists('netlify')) return { ok: false, error: 'netlify CLI not found on PATH, install it first' };
  const wtDir = wtPath(repo, name);
  // .netlify/state.json is netlify link's output, same role .vercel/project.json
  // plays above -- but its mere existence only proves this worktree was linked
  // at some point, not that the site id it names is still valid. The linked id
  // read here gets compared against the deploy result's own site_id below,
  // because a stale or reauthorized netlify token doesn't fail the same way a
  // bad vercel token does: netlify-cli's own site-resolution logic treats that
  // as "not linked, not interactive" and silently auto-creates a new site to
  // deploy to instead of erroring out.
  let linkedSiteId = null;
  try { linkedSiteId = JSON.parse(readFileSync(join(wtDir, '.netlify', 'state.json'), 'utf8')).siteId ?? null; } catch {}
  if (!linkedSiteId) {
    return { ok: false, error: `this worktree isn't linked to a Netlify site, run "netlify link" in ${wtDir} first` };
  }

  const fd = openLogFd(repo, name, 'netlify');
  netlifyDeploys.set(key, { deploying: true, url: null, error: null, target, startedAt: Date.now() });
  // stdin: 'ignore', not inherited: with no --yes/--auto flag to lean on, the
  // thing standing between this and a wedged prompt is netlify-cli's own
  // isInteractive() gate (checked directly in its source), which requires
  // stdin.isTTY && stdout.isTTY before it will ever call inquirer.prompt.
  // Ignored stdin makes that false, so every prompt path it has (missing
  // publish directory, a locked production site, an unlinked project) takes
  // its non-interactive fallback or fails cleanly instead of hanging with no
  // terminal attached. The timeout below is a backstop for a different
  // failure mode (a genuinely hung network call or local build step).
  const proc = Bun.spawn(['netlify', ...netlifyArgs(target)],
    { cwd: wtDir, stdout: 'pipe', stderr: fd, stdin: 'ignore', timeout: 15 * 60 * 1000 });

  (async () => {
    const out = await new Response(proc.stdout).text();
    const code = await proc.exited;
    const finishedAt = netlifyDeploys.get(key)?.startedAt ?? Date.now();
    const data = code === 0 ? parseNetlifyJson(out) : null;
    // A clean exit with a parseable result naming a DIFFERENT site than the
    // one this worktree is linked to (see the comment above linkedSiteId)
    // means netlify picked a site on its own -- don't trust that url.
    const ok = code === 0 && data && data.site_id === linkedSiteId;
    const url = ok ? (data.url || data.deploy_url || null) : null;

    if (ok && url) {
      appendFileSync(logPath(repo, name, 'netlify'), `\n${url}\n`);
      netlifyDeploys.set(key, { deploying: false, url, error: null, target, startedAt: finishedAt });
      return;
    }

    let reason;
    if (code === 0 && data && data.site_id !== linkedSiteId) {
      reason = `netlify deployed to a different site (${data.site_id}) than the one linked here (${linkedSiteId}), not trusting the result, check the netlify auth token`;
      appendFileSync(logPath(repo, name, 'netlify'), `\n[deploy failed] ${reason}\n`);
    } else if (code === 0 && !data) {
      // Exited clean but the --json payload didn't parse -- the log fd above
      // only captured stderr, and stdout (where the payload actually lands)
      // is otherwise lost, so dump it here or the log won't explain why.
      appendFileSync(logPath(repo, name, 'netlify'), `\n[deploy failed] could not parse --json output:\n${out}\n`);
      reason = 'could not parse netlify --json output, see the log';
    } else {
      // The real reason (bad auth, build failure, project mismatch) went to
      // the log fd above, not to stdout, which is why this reads it back
      // instead of settling for a bare exit code.
      reason = tailLog(repo, name, 'netlify', 20).lines.filter(l => l.trim()).at(-1) ?? `netlify exited ${code}`;
      appendFileSync(logPath(repo, name, 'netlify'), `\n[deploy failed] ${reason}\n`);
    }
    netlifyDeploys.set(key, { deploying: false, url: null, error: reason, target, startedAt: finishedAt });
  })();

  return { ok: true, deploying: true, target };
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
  // reap orphaned cloudflared from a previous portal — two replicas of the same
  // tunnel serve divergent ingress maps and randomly 404 (see comment above)
  spawnSync('pkill', ['-f', `cloudflared --config ${MERGED_CONF}`]);
  if (activeTunnelMap.size === 0) return;
  writeMergedConf();
  const fd = openTunnelLog();
  tunnelProc = Bun.spawn(
    [CLOUDFLARED_BIN, '--config', MERGED_CONF, 'tunnel', 'run', TUNNEL_NAME],
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

// Resumes a worktree in whatever mode it was actually running before —
// container or bare — instead of always spawnWorktree (bare). Always-bare
// used to silently strip a containerized worktree's memory/CPU cap on every
// tunnel toggle, with nothing telling the user it happened.
function respawnAsBefore(repo, name, port, wasContainer) {
  if (wasContainer) spawnContainer(repo, name, port); else spawnWorktree(repo, name, port);
}

async function enableTunnel(repo, name, port) {
  // Only one worktree can use the shared tunnel URL — evict any currently active one
  for (const [key, { port: p }] of activeTunnelMap.entries()) {
    if (key === `${repo}/${name}`) continue;
    const { repo: kRepo, name: kName } = splitKey(key);
    await disableTunnel(kRepo, kName, p);
  }
  const key = `${repo}/${name}`;
  const wasContainer = !!procs.get(key)?.container;
  const wasRunning = !!(await activePidAsync(port));
  const pubDom = publicDomain(_cfg);
  // drain: false — this is a same-worktree restart, not a real vacancy; see
  // stopWorktree's comment. Captured wasContainer before stopping since
  // stopWorktree deletes the procs entry.
  if (wasRunning) await stopWorktree(repo, name, port, { drain: false });
  configureWorktreeEnv(_cfg, repo, name, port, true);
  reloadCaddy(WORKSPACE);
  addTunnelRoute(repo, name, pubDom, port);
  // spawnContainer/spawnWorktree directly, not startWorktree — this is
  // resuming something that was already running a moment ago, not a fresh
  // admission decision, so it shouldn't get stuck behind the concurrency queue.
  if (wasRunning) respawnAsBefore(repo, name, port, wasContainer);
  return { ok: true };
}

async function disableTunnel(repo, name, port) {
  const key = `${repo}/${name}`;
  const wasContainer = !!procs.get(key)?.container;
  const wasRunning = !!(await activePidAsync(port));
  if (wasRunning) await stopWorktree(repo, name, port, { drain: false });
  removeTunnelRoute(repo, name);
  configureWorktreeEnv(_cfg, repo, name, port, false);
  reloadCaddy(WORKSPACE);
  if (wasRunning) respawnAsBefore(repo, name, port, wasContainer);
  return { ok: true };
}

// ── create / remove worktree ──────────────────────────────────────────────────

async function createWorktree(repo, name, tunnel) {
  const res = await libCreateWorktree(_cfg, repo, name, { tunnel });
  if (tunnel) addTunnelRoute(repo, name, publicDomain(_cfg), res.port);

  // mise trust + bun install (background — takes a while)
  const setupFd = openLogFd(repo, name, 'setup');
  Bun.spawn(['zsh', '-c', `mise trust "${res.wtDir}" 2>/dev/null; cd "${res.wtDir}" && bun install`],
    { stdout: setupFd, stderr: setupFd });

  return { ok: true, port: res.port, domain: res.localDom };
}

async function removeWorktree(repo, name, reason = 'manual') {
  // stop dev server and tunnel route first
  const port = getPort(WORKSPACE, repo, name);
  if (port) await stopWorktree(repo, name, port);
  if (activeTunnelMap.has(`${repo}/${name}`)) removeTunnelRoute(repo, name);

  // The worktree is being permanently removed, not just stopped — unlike a
  // normal stop (stopContainer's `down` deliberately keeps the node_modules
  // volume so a later start skips reinstalling), there's no later start
  // coming. Without this, the volume leaks forever with nothing left
  // pointing at it — the exact kind of disk bloat this tool exists to avoid.
  // Must run before libRemoveWorktree deletes the directory (and the compose
  // file with it) below.
  const wtDir = wtPath(repo, name);
  if (existsSync(dockerComposePath(wtDir))) {
    try {
      execFileSync('docker',
        ['compose', '-p', composeProjectName(repo, name), '-f', dockerComposePath(wtDir), 'down', '-v'],
        { stdio: 'ignore' });
    } catch {}
  }

  // Read everything the archive record needs while the worktree (and its PR
  // cache entry) still exist, since libRemoveWorktree below deletes the
  // directory and the key is cleared from prCache right after. Not written
  // yet: only append once removal actually succeeds, so a failed `git
  // worktree remove` never leaves a phantom archive entry for a worktree
  // that's still there.
  const archiveRecord = {
    repo, name,
    label:  REPO_META[repo]?.label ?? repo,
    branch: repoGitMeta(repo).pathToBranch.get(resolve(wtDir)) ?? name,
    prUrl:  prCache.get(`${repo}/${name}`)?.url ?? null,
    removedAt: Math.floor(Date.now() / 1000),
    reason: reason === 'merged' ? 'merged' : 'manual',
  };

  try { libRemoveWorktree(_cfg, repo, name); }
  catch (e) { return { ok: false, error: String(e) }; }

  appendArchivedWorktree(WORKSPACE, archiveRecord);
  prCache.delete(`${repo}/${name}`);
  lastSeenAt.delete(`${repo}/${name}`);
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
  const repoDir = repoPath(name);

  if (loadProjects(WORKSPACE)[name]) {
    return { ok: false, error: `${name} is already registered` };
  }

  // Bare clone (existing) or bare init (new)
  mkdirSync(WORKSPACE, { recursive: true });
  if (slug && !existsSync(repoDir)) {
    // stdio: 'pipe' (cloneBareRepo's default is 'inherit', for the CLI path):
    // this is headless, there's no terminal to show clone progress to.
    cloneBareRepo(repoDir, `git@github.com:${slug}.git`, slug, { stdio: 'pipe' });
  } else if (!slug) {
    mkdirSync(repoDir, { recursive: true });
    execFileSync('git', ['-C', repoDir, 'init', '--bare']);
  }

  const base = registerProject(WORKSPACE, { name, slug, label: label_ });
  REPO_META = loadProjects(WORKSPACE);

  return { ok: true, name, base, slug: slug || null, label: label_ };
}

// ── open in Ghostty ───────────────────────────────────────────────────────────
// Which coding CLIs to offer isn't hardcoded to one fixed list — AGENT_CLIS
// (lib.js) is detected live via `which`, so this works for whatever's actually
// installed on this machine, not just the tools one project happened to use.

function openInGhostty(wtDir, tool) {
  const cmd = AGENT_CLIS[tool]?.bin
    ?? loadCustomAgents(WORKSPACE).find(a => a.id === tool)?.command;
  if (!cmd) return { ok: false, error: 'unknown tool' };
  const script = `${tmpdir()}/qdev-${Date.now()}.sh`;
  writeFileSync(script, `#!/bin/zsh\nsource "$HOME/.zshrc"\ncd "${wtDir}"\n${cmd}\nexec zsh -l\n`, { mode: 0o755 });
  // Not a raw `ghostty` spawn — Ghostty's own --help is explicit that launching
  // the terminal from the CLI isn't supported on macOS ("use open -na
  // Ghostty.app"). The raw binary silently spawns a process with zero children
  // and never runs the script; /api/open still returned {ok:true} throughout
  // since Bun.spawn not throwing synchronously was the only check — confirmed
  // live via a marker-file test that only the `open -na` form actually executes.
  Bun.spawn(['open', '-na', 'Ghostty', '--args', `--working-directory=${wtDir}`, `--command=${script}`],
    { detached: true, stdio: ['ignore', 'ignore', 'ignore'] });
  return { ok: true };
}

// ── router ────────────────────────────────────────────────────────────────────

// Collapses the try/catch-into-500 pattern repeated across the route
// branches below. fn can be sync or async: `await` on a plain value is a
// no-op, so this works uniformly for both.
async function jsonTry(fn) {
  try { return Response.json(await fn()); }
  catch (e) { return Response.json({ ok: false, error: String(e) }, { status: 500 }); }
}

// Shared by /api/projects and mcp-server.js's list_projects tool.
function listProjectsSummary() {
  return Object.entries(loadProjects(WORKSPACE)).map(([name, m]) => ({ name, label: m.label, github: m.github }));
}

// Each domain router below returns a Response for a route it owns, or null
// to fall through to the next one. handle() tries them in order and 404s
// if none match. Split by domain (worktree lifecycle, project/sweep,
// settings, raycast) for size, not by rewriting the dispatch logic itself.
async function projectRoutes(req, pathname, method, server) {
  if (pathname === '/api/projects') return Response.json(listProjectsSummary());

  if (method === 'POST' && pathname === '/api/project/add') {
    const body = await req.json().catch(() => ({}));
    return jsonTry(() => addProject(body));
  }

  if (method === 'POST' && pathname === '/api/project/remove') {
    const body = await req.json().catch(() => ({}));
    return jsonTry(() => { removeProject(WORKSPACE, body.name); return { ok: true }; });
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
    server?.timeout(req, 0);
    return jsonTry(() => discoverReposAsync(HOME));
  }

  if (method === 'POST' && pathname === '/api/sweep/import') {
    const body = await req.json().catch(() => ({}));
    const { name, remoteUrl, label } = body;
    if (!name || !remoteUrl) return Response.json({ ok: false, error: 'name and remoteUrl required' });
    // Same guard addProject() already uses — a conflicting candidate should
    // never reach here (the UI disables those rows), but importRepo() itself
    // would otherwise silently no-op against the wrong existing project.
    if (loadProjects(WORKSPACE)[name]) return Response.json({ ok: false, error: `${name} is already registered` });
    return jsonTry(async () => {
      await importRepo(_cfg, { name, remoteUrl, label });
      REPO_META = loadProjects(WORKSPACE);
      return { ok: true };
    });
  }

  return null;
}

async function settingsRoutes(req, pathname, method) {
  if (pathname === '/api/agents') return Response.json(detectAgentClis(WORKSPACE));

  // Both GET (read current values + real hardware/Docker capacity for the
  // settings UI's ranges) and POST (persist a change) live on one path.
  // Handled here, before worktreeRoutes' generic POST block, so a POST to
  // this path returns from here and never falls through to it.
  if (pathname === '/api/settings') {
    if (method === 'GET') {
      return Response.json({
        maxConcurrentDevServers: MAX_CONCURRENT_DEV,
        containerMemoryLimit: _cfg.containerMemoryLimit ?? '4g',
        containerCpuLimit: _cfg.containerCpuLimit ?? 2,
        mac: macCapacity(),
        docker: engineCapacity(),
      });
    }
    if (method === 'POST') {
      const body = await req.json().catch(() => ({}));
      if (body.maxConcurrentDevServers != null) {
        MAX_CONCURRENT_DEV = Math.max(1, Number(body.maxConcurrentDevServers) || 1);
        _cfg.maxConcurrentDevServers = MAX_CONCURRENT_DEV;
        drainQueue(); // a raised cap should immediately start anything already queued
      }
      if (body.containerMemoryLimit != null) _cfg.containerMemoryLimit = String(body.containerMemoryLimit);
      if (body.containerCpuLimit != null) _cfg.containerCpuLimit = Number(body.containerCpuLimit) || 1;
      saveConfig(_cfg);
      return Response.json({ ok: true });
    }
  }

  // Sidecars: GET returns every entry (including disabled) for the settings
  // UI to edit; POST replaces the whole per-repo list — the caller always
  // sends the full array back (add/remove/toggle are all client-side edits
  // to that array), matching saveSidecars()'s per-repo-overwrite shape.
  if (pathname === '/api/sidecars') {
    const p = new URL(req.url).searchParams;
    if (method === 'GET') {
      const repo = p.get('repo') ?? '';
      // `approved` is computed, not stored on the sidecar itself, so the
      // settings UI can show a per-row badge without a second request.
      return Response.json(loadAllSidecars(WORKSPACE, repo).map(s => ({ ...s, approved: isSidecarApproved(WORKSPACE, repo, s) })));
    }
    if (method === 'POST') {
      const body = await req.json().catch(() => ({}));
      return jsonTry(() => {
        // Strip the computed `approved` field the GET above adds, in case
        // the caller round-trips what it fetched. sidecars.json only ever
        // owns name/enabled/command/args/env, approval lives in its own file.
        const sidecars = (body.sidecars ?? []).map(({ approved, ...s }) => s);
        saveSidecars(WORKSPACE, body.repo, sidecars);
        return { ok: true };
      });
    }
  }

  // Records the CURRENT command/args for one sidecar as approved, looked up
  // fresh from sidecars.json rather than trusted from the request body, so a
  // stale client can't approve a command it no longer matches.
  if (pathname === '/api/sidecar-approvals/approve' && method === 'POST') {
    const body = await req.json().catch(() => ({}));
    return jsonTry(() => {
      const s = loadAllSidecars(WORKSPACE, body.repo).find(x => x.name === body.name);
      if (!s) throw new Error(`sidecar '${body.name}' not found for ${body.repo}`);
      approveSidecar(WORKSPACE, body.repo, s.name, s.command, s.args);
      return { ok: true };
    });
  }

  // File sync globs: same per-repo GET/POST shape as sidecars above — GET
  // returns the repo's glob list for the settings UI to edit, POST replaces
  // it wholesale. Read by createWorktree on the next worktree it creates for
  // this repo, not retroactively applied to worktrees that already exist.
  if (pathname === '/api/file-sync-globs') {
    const p = new URL(req.url).searchParams;
    if (method === 'GET') return Response.json(loadFileSyncGlobs(WORKSPACE, p.get('repo') ?? ''));
    if (method === 'POST') {
      const body = await req.json().catch(() => ({}));
      return jsonTry(() => { saveFileSyncGlobs(WORKSPACE, body.repo, body.globs ?? []); return { ok: true }; });
    }
  }

  // Custom agents: same shape as sidecars above — GET for the settings UI to
  // edit, POST replaces the whole (global, not per-repo) list.
  if (pathname === '/api/custom-agents') {
    if (method === 'GET') return Response.json(loadCustomAgents(WORKSPACE));
    if (method === 'POST') {
      const body = await req.json().catch(() => ({}));
      return jsonTry(() => { saveCustomAgents(WORKSPACE, body.agents ?? []); return { ok: true }; });
    }
  }

  return null;
}

function mcpCallbackHtml(title, body) {
  return new Response(
    `<!doctype html><html><head><title>${title}</title><style>body{font:15px system-ui;max-width:32rem;margin:4rem auto;padding:0 1.5rem;color:#27272a}</style></head><body><h2>${title}</h2><p>${body}</p></body></html>`,
    { headers: { 'content-type': 'text/html' } },
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
    if (method === 'GET') {
      const statuses = mcpStatuses();
      return Response.json(loadMcpServers(WORKSPACE).map(s => ({ ...s, ...(statuses[s.id] ?? { status: 'disconnected', tools: [], stderrTail: [], error: null }) })));
    }
    if (method === 'POST') {
      const body = await req.json().catch(() => ({}));
      return jsonTry(() => { saveMcpServers(WORKSPACE, body.servers ?? []); return { ok: true }; });
    }
  }

  // Fire-and-forget, matching deployToVercel/deployToNetlify's shape: a
  // stdio connect is fast, but an HTTP+OAuth one involves a real browser
  // round-trip the user could take minutes to complete, so this can't block
  // the HTTP response. The actual outcome (connected/awaiting-auth/error)
  // shows up on the next /api/mcp-servers poll via mcp.js's own status map.
  if (pathname === '/api/mcp/connect' && method === 'POST') {
    const body = await req.json().catch(() => ({}));
    const server = loadMcpServers(WORKSPACE).find(s => s.id === body.id);
    if (!server) return Response.json({ ok: false, error: 'server not found' }, { status: 404 });
    connectMcpServer(server, WORKSPACE).catch(() => {}); // internal errors are already caught and recorded in mcp.js's own status map
    return Response.json({ ok: true });
  }

  if (pathname === '/api/mcp/disconnect' && method === 'POST') {
    const body = await req.json().catch(() => ({}));
    disconnectMcpServer(body.id);
    return Response.json({ ok: true });
  }

  // Hit by a real browser tab redirected here by the authorization server,
  // not the SPA -- returns human-readable HTML on every leg, not JSON. This
  // is the one route in this domain that doesn't go through jsonTry.
  if (pathname.startsWith('/api/mcp/oauth/callback/') && method === 'GET') {
    const serverId = pathname.slice('/api/mcp/oauth/callback/'.length);
    const p = new URL(req.url).searchParams;
    if (p.get('error')) {
      return mcpCallbackHtml('Authorization denied', `The authorization server reported: ${p.get('error_description') ?? p.get('error')}. You can close this tab and try again from Setu.`);
    }
    const code = p.get('code');
    const state = p.get('state');
    if (!code || !state) return mcpCallbackHtml('Bad callback', 'Missing code or state parameter. You can close this tab and try again from Setu.');
    const server = loadMcpServers(WORKSPACE).find(s => s.id === serverId);
    if (!server) return mcpCallbackHtml('Unknown server', 'This server is no longer configured in Setu. You can close this tab.');
    const result = await finishMcpAuth(server, code, state);
    if (!result.ok) return mcpCallbackHtml('Authorization failed', `${result.error} You can close this tab and try again from Setu.`);
    return mcpCallbackHtml('Authorized', 'You can close this tab and return to Setu.');
  }

  return null;
}

async function raycastRoutes(req, pathname, method) {
  if (pathname === '/api/raycast/status') {
    return Response.json({ running: !!raycastDev, dirExists: existsSync(RAYCAST_DIR) });
  }
  if (pathname === '/api/raycast/log') {
    const n = Number(new URL(req.url).searchParams.get('n') ?? 150);
    try {
      const all = readFileSync(raycastLogPath(), 'utf8').split('\n');
      return Response.json({ lines: all.slice(-n) });
    } catch { return Response.json({ lines: [] }); }
  }
  if (method === 'POST' && pathname === '/api/raycast/start') return Response.json(startRaycastDev());
  if (method === 'POST' && pathname === '/api/raycast/stop') return Response.json(await stopRaycastDev());

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
  const pr = await fetchPR(repo, name);
  if (!pr.number) return { pluginInstalled, pr: null, run: null, artifacts: {} };
  const slug = REPO_META[repo]?.slug ?? repo;
  const headSha = (await spawnText(['git', '-C', wtDir, 'rev-parse', 'HEAD'])).trim() || null;
  const artifacts = {};
  for (const skill of PR_REVIEW_SKILLS) artifacts[skill] = findLatestArtifact(slug, pr.number, skill, headSha);
  return { pluginInstalled, pr: { number: pr.number }, run: reviewRunStatus(repo, name), artifacts };
}

// Shared by /api/pr-review/run and mcp-server.js's run_pr_review tool.
async function prReviewRun(repo, name, skill) {
  if (!PR_REVIEW_SKILLS.has(skill)) throw new Error('unknown skill');
  const pr = await fetchPR(repo, name);
  if (!pr.number) return { ok: false, error: 'no pull request associated with this worktree' };
  const slug = REPO_META[repo]?.slug ?? repo;
  touchLastSeen(repo, name);
  const fd = openLogFd(repo, name, 'pr-review');
  return runDeepReview(repo, name, skill, {
    wtDir: wtPath(repo, name), slug, prNumber: pr.number,
    logFd: fd, logPath: logPath(repo, name, 'pr-review'), spawnText,
  });
}

// prReviewRoutes must run before worktreeRoutes, same ordering constraint
// as every other domain here (see worktreeRoutes' own comment on why).
async function prReviewRoutes(req, pathname, method) {
  if (pathname === '/api/pr-review/status' && method === 'GET') {
    const p = new URL(req.url).searchParams;
    const repo = p.get('repo'), name = p.get('name');
    if (!repo || !name) return Response.json({ ok: false, error: 'repo and name required' }, { status: 400 });
    return jsonTry(() => prReviewStatus(repo, name));
  }

  if (pathname === '/api/pr-review/run' && method === 'POST') {
    const body = await req.json().catch(() => ({}));
    const { repo, name, skill } = body;
    if (!repo || !name) return Response.json({ ok: false, error: 'repo and name required' }, { status: 400 });
    if (!PR_REVIEW_SKILLS.has(skill)) return Response.json({ ok: false, error: 'unknown skill' }, { status: 400 });
    return jsonTry(() => prReviewRun(repo, name, skill));
  }

  // Serves the report HTML directly (a genuinely self-contained file, only
  // external refs are Google Fonts <link> tags) — a new tab, not an iframe,
  // matching the existing "Open in browser" pattern for worktree URLs.
  if (pathname === '/api/pr-review/artifact' && method === 'GET') {
    const p = new URL(req.url).searchParams;
    const repo = p.get('repo'), name = p.get('name'), skill = p.get('skill');
    if (!repo || !name) return Response.json({ ok: false, error: 'repo and name required' }, { status: 400 });
    if (!PR_REVIEW_SKILLS.has(skill)) return Response.json({ ok: false, error: 'unknown skill' }, { status: 400 });
    const pr = await fetchPR(repo, name);
    if (!pr.number) return new Response('No pull request for this worktree', { status: 404 });
    const slug = REPO_META[repo]?.slug ?? repo;
    const artifact = findLatestArtifact(slug, pr.number, skill, null);
    const path = artifact && artifactHtmlPath(slug, pr.number, skill, artifact.snapshot, artifact.htmlFile);
    if (!path || !existsSync(path)) return new Response('No report generated yet', { status: 404 });
    return new Response(Bun.file(path));
  }

  return null;
}

// The generic `if (method === 'POST')` block below consumes the request
// body for ANY POST pathname, not just the ones it recognizes, unlike every
// other domain above, which gates its own req.json() on a specific pathname
// match first. That's why worktreeRoutes runs last in handle(): a body can
// only be read once, and if this ran first it would swallow the body meant
// for e.g. a POST to /api/settings before settingsRoutes ever saw it.
async function worktreeRoutes(req, pathname, method, server) {
  if (pathname === '/api/worktrees') {
    // Same idleTimeout hazard /api/sweep already documents and fixes (see
    // its own comment) -- 45+ worktrees each potentially needing an
    // uncached `gh pr view` subprocess (fetchPR's 60s TTL, cold right after
    // a portal restart) can genuinely exceed Bun's default 10s idle timeout
    // for a real HTTP client (web UI, Raycast) hitting this route directly.
    server?.timeout(req, 0);
    return Response.json(await getWorktrees());
  }

  // Full list, most-recent-first: same client-side-pagination convention
  // /api/worktrees already uses (the frontend slices into pages, not this
  // endpoint), so the archive view stays consistent with the main list
  // instead of inventing server-side pagination just for itself.
  if (pathname === '/api/worktrees/archived') {
    return Response.json([...loadArchivedWorktrees(WORKSPACE)].reverse());
  }

  if (pathname === '/api/status') {
    return Response.json(computeStatus());
  }

  if (pathname === '/api/logs') {
    const p    = new URL(req.url).searchParams;
    const repo = p.get('repo'), name = p.get('name');
    // Polling this endpoint only happens while a LogModal/LiveLog panel is
    // actually mounted for this worktree (portal/components/logs.tsx). That's
    // a real "someone is watching" signal, unlike the always-on
    // /api/worktrees list poll. Counts toward the idle-timeout clock below.
    if (repo && name) touchLastSeen(repo, name);
    const res  = tailLog(repo, name, p.get('type') ?? 'dev', Number(p.get('n') ?? 150));
    return Response.json(res);
  }

  // Deploy status is also folded into /api/worktrees (vercelDeploy field,
  // same convention as pr/tunnelRunning) for the poll loop the UI already
  // runs. This exists alongside that fold for a caller that wants just one
  // worktree's deploy state without fetching the whole list.
  if (pathname === '/api/vercel/status') {
    const p = new URL(req.url).searchParams;
    return Response.json(vercelStatus(p.get('repo'), p.get('name')));
  }

  // Same "also reachable standalone" convention as /api/vercel/status above.
  if (pathname === '/api/netlify/status') {
    const p = new URL(req.url).searchParams;
    return Response.json(netlifyStatus(p.get('repo'), p.get('name')));
  }

  // Same "also reachable standalone" convention as /api/vercel/status above.
  if (pathname === '/api/convex/status') {
    const p = new URL(req.url).searchParams;
    return Response.json(convexDeployStatus(p.get('repo'), p.get('name')));
  }

  // Manual-fetch, not polled (see DiffViewer): a human actually looking at a
  // worktree's diff is real activity, same as opening its log viewer above.
  if (pathname === '/api/diff') {
    const p    = new URL(req.url).searchParams;
    const repo = p.get('repo'), name = p.get('name');
    if (!repo || !name) return Response.json({ ok: false, error: 'repo and name required' }, { status: 400 });
    touchLastSeen(repo, name);
    return jsonTry(() => computeDiff(repo, name));
  }

  // Repo-scoped, not worktree-scoped -- no touchLastSeen call, unlike every
  // other route in this block (there's no single worktree this action is
  // "about"). GET-only, so it's safe to sit inside worktreeRoutes despite
  // that function's own POST-body-consuming hazard (see worktreeRoutes'
  // comment above) -- a GET never reads req.json().
  if (pathname === '/api/repo-prs') {
    const repo = new URL(req.url).searchParams.get('repo');
    if (!repo) return Response.json({ ok: false, error: 'repo required' }, { status: 400 });
    return jsonTry(() => fetchRepoPRs(repo));
  }

  if (method === 'POST') {
    const body = await req.json().catch(() => ({}));
    const { repo, name, tool, tunnel, container, target, reason } = body;
    const wtPort = () => getPort(WORKSPACE, repo, name);
    // Any POST action referencing a specific worktree (start/stop/sync/
    // tunnel/inngest/trigger/open) is real, user-driven activity. Touch it
    // once here rather than at each branch below.
    if (repo && name) touchLastSeen(repo, name);

    if (pathname === '/api/create') {
      return jsonTry(() => createWorktree(repo, name, !!tunnel));
    }
    if (pathname === '/api/remove') {
      return Response.json(await removeWorktree(repo, name, reason));
    }
    if (pathname === '/api/start') {
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
      return Response.json(startWorktreeByName(repo, name, container));
    }
    if (pathname === '/api/stop') {
      return Response.json(await stopWorktreeByName(repo, name));
    }
    if (pathname === '/api/sync') {
      return jsonTry(() => syncWorktreeByName(repo, name));
    }
    if (pathname === '/api/tunnel/enable') {
      const port = wtPort(); if (!port) return Response.json({ ok: false }, { status: 404 });
      return Response.json(await enableTunnel(repo, name, port));
    }
    if (pathname === '/api/tunnel/disable') {
      const port = wtPort(); if (!port) return Response.json({ ok: false }, { status: 404 });
      return Response.json(await disableTunnel(repo, name, port));
    }
    if (pathname === '/api/inngest/start') {
      const port = wtPort(); if (!port) return Response.json({ ok: false }, { status: 404 });
      return Response.json(await startInngest(repo, name, port));
    }
    if (pathname === '/api/inngest/stop') {
      return Response.json(await stopInngest(repo, name, wtPort()));
    }
    if (pathname === '/api/trigger/start') {
      return Response.json(startTrigger(repo, name));
    }
    if (pathname === '/api/trigger/stop') {
      return Response.json(await stopTrigger(repo, name));
    }
    if (pathname === '/api/convex/start') {
      return Response.json(startConvexDev(repo, name));
    }
    if (pathname === '/api/convex/stop') {
      return Response.json(await stopConvexDev(repo, name));
    }
    if (pathname === '/api/convex/deploy') {
      if (!target) return Response.json({ ok: false, error: 'target required' });
      return jsonTry(() => deployToConvex(repo, name, target));
    }
    if (pathname === '/api/vercel/deploy') {
      if (!target) return Response.json({ ok: false, error: 'target required' });
      return jsonTry(() => deployToVercel(repo, name, target));
    }
    if (pathname === '/api/netlify/deploy') {
      if (!target) return Response.json({ ok: false, error: 'target required' });
      return jsonTry(() => deployToNetlify(repo, name, target));
    }
    if (pathname === '/api/open') {
      return Response.json(openInGhostty(wtPath(repo, name), tool));
    }
    if (pathname === '/api/ports/kill') {
      const { port } = body;
      return Response.json(await killPort(port));
    }
  }

  if (pathname === '/api/ports') {
    return Response.json(await listPortsWithWorktree());
  }

  return null;
}

async function handle(req, server) {
  const { pathname } = new URL(req.url);
  const method = req.method;

  // A successful upgrade must not fall through to the route handlers below,
  // hence the early return before the loop even starts. data seeds ws.data
  // with the per-connection Set that open/message/close use to track which
  // logs:* topics this connection currently holds, populated at upgrade
  // time rather than reassigned later since ServerWebSocket.data is meant
  // to be set this way, not written to after the fact.
  if (pathname === '/ws') {
    if (server.upgrade(req, { data: new Set() })) return;
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
    server?.timeout(req, 0);
    return handleMcpRequest(req);
  }

  // worktreeRoutes must run last, see its own comment for why.
  for (const routes of [projectRoutes, settingsRoutes, mcpRoutes, prReviewRoutes, raycastRoutes, worktreeRoutes]) {
    const res = await routes(req, pathname, method, server);
    if (res) return res;
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

function processFootprintMb(pid) {
  try {
    const out = execFileSync('footprint', [String(pid)], { encoding: 'utf8' });
    const m = out.match(/phys_footprint:\s*([\d.]+)\s*(MB|GB)/);
    if (!m) return 0;
    return m[2] === 'GB' ? parseFloat(m[1]) * 1024 : parseFloat(m[1]);
  } catch { return 0; }
}

const deadContainerStrikes = new Map(); // key -> consecutive "not alive" readings

async function checkMemoryCeilings() {
  for (const [key, entry] of procs.entries()) {
    if (entry.container) {
      // Docker's own cgroup limit + `restart: on-failure:3` already enforce
      // and retry the memory ceiling — nothing in Setu needs to restart a
      // container itself. But `docker compose up -d` exits successfully the
      // moment containers are created, long before a crash-loop plays out, so
      // nothing else ever notices a container that permanently gave up after
      // exhausting its retries — without this, its concurrency slot stays
      // occupied forever (verified live: a memory limit too small for the
      // app to ever boot left a dead entry in `procs` indefinitely).
      if (composeProjectAlive(entry.container)) {
        deadContainerStrikes.delete(key);
      } else {
        // Require two consecutive misses, not one — a single "not alive"
        // reading can be a transient window during a legitimate recreate
        // (a tunnel toggle or manual restart respawning the same worktree),
        // not just a container that's genuinely given up for good. Treating
        // one miss as final risked freeing a slot — and losing container
        // tracking — for a worktree that was actually fine a moment later.
        const strikes = (deadContainerStrikes.get(key) ?? 0) + 1;
        if (strikes >= 2) {
          console.warn(`⚠ ${key} container exited and is not restarting — freeing its slot`);
          procs.delete(key);
          deadContainerStrikes.delete(key);
          drainQueue();
        } else {
          deadContainerStrikes.set(key, strikes);
        }
      }
      continue;
    }
    const mb = processFootprintMb(entry.pid);
    if (mb > DEV_MEM_CEILING_MB) {
      const { repo, name } = splitKey(key);
      const port = getPort(WORKSPACE, repo, name);
      console.warn(`⚠ ${key} dev server at ${Math.round(mb)}MB, exceeds ${DEV_MEM_CEILING_MB}MB ceiling — restarting`);
      // Awaited, not fire-and-forget: stopWorktree's kill is now async
      // (activePidAsync/killGroupAsync), and spawnWorktree respawning on the
      // same port before the old process is actually gone would race it.
      await stopWorktree(repo, name, port, { drain: false });
      if (port) spawnWorktree(repo, name, port);
    }
  }
}

setInterval(checkMemoryCeilings, MEM_CHECK_INTERVAL);

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
const IDLE_TIMEOUT_MS     = _cfg.idleTimeoutMs ?? 0; // 0 = disabled
const IDLE_CHECK_INTERVAL = 60_000;
// Floor under IDLE_TIMEOUT_MS itself: a worktree younger than this never
// gets reaped even if someone configures a very small timeout, so a dev
// server that's still booting can't get stopped mid-start.
const IDLE_MIN_UPTIME_MS = 2 * 60_000;

function checkIdleTimeouts() {
  if (!IDLE_TIMEOUT_MS) return;
  const now = Date.now();
  const threshold = Math.max(IDLE_TIMEOUT_MS, IDLE_MIN_UPTIME_MS);
  for (const [key, entry] of procs.entries()) {
    // Container-mode worktrees already have Docker's own lifecycle (restart
    // policy, plus checkMemoryCeilings' dead-container reap above). This
    // check is bare-process-only.
    if (entry.container) continue;
    // A worktree with an active public tunnel route can be getting real
    // traffic from outside this portal entirely (someone hitting the public
    // URL) — none of that shows up as a portal-side request, so lastSeenAt
    // can't see it. Leave tunneled worktrees out of idle-timeout scope
    // rather than risk stopping a server that's actually serving traffic.
    if (activeTunnelMap.has(key)) continue;
    const seenAt = lastSeenAt.get(key);
    if (seenAt == null) continue; // no baseline yet, nothing to measure against
    const idleMs = now - seenAt;
    if (idleMs < threshold) continue;
    const { repo, name } = splitKey(key);
    const port = getPort(WORKSPACE, repo, name);
    console.warn(`⚠ ${key} idle for ${Math.round(idleMs / 60_000)}m, exceeds ${Math.round(IDLE_TIMEOUT_MS / 60_000)}m idle timeout — stopping`);
    // Not awaited: stopWorktree is async now, but nothing here depends on
    // its kill actually finishing before the next line — unlike the memory-
    // ceiling restart path, there's no immediate respawn to race.
    stopWorktree(repo, name, port);
    lastSeenAt.delete(key);
  }
}

setInterval(checkIdleTimeouts, IDLE_CHECK_INTERVAL);

// Rebuild merged ingress and restart the single tunnel process for all enabled worktrees
;(async () => {
  syncHosts(WORKSPACE);
  reconcileDevServers();
  reconcileTriggerSidecars();
  const wts = await getWorktrees().catch(() => []);
  for (const w of wts) {
    if (w.tunnelOn) activeTunnelMap.set(w.key, { pubDom: w.pubDomain, port: w.port });
  }
  if (activeTunnelMap.size > 0) restartTunnel();
})();

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
function computeStatus() {
  const rt = containerRuntimeAvailable();
  return {
    concurrency: { active: procs.size, max: MAX_CONCURRENT_DEV, queued: startQueue.length },
    container: {
      engineAvailable: rt.available, engine: rt.engine,
      memoryLimit: _cfg.containerMemoryLimit ?? '4g',
      cpuLimit: _cfg.containerCpuLimit ?? 2,
    },
  };
}

async function wsTickWorktrees() {
  const entry = wsTopics.get('worktrees');
  if (!entry) return; // last subscriber left between the tick firing and it actually running
  // null, not [], on failure: the client does an unconditional setWorktrees
  // on every push, so broadcasting an empty list here would blank out its
  // last good state instead of just skipping this tick like a failed poll
  // used to.
  const worktrees = await getWorktrees().catch(() => null);
  if (!worktrees) return;
  const payload = { worktrees, status: computeStatus() };
  const json = JSON.stringify(payload);
  if (json === entry.lastBroadcast) return;
  entry.lastBroadcast = json;
  server.publish('worktrees', JSON.stringify({ topic: 'worktrees', data: payload }));
}

// repo never contains a slash (same assumption splitKey in lib.js makes for
// the plain `repo/name` key), but name can, e.g. a branch called
// "feature/foo", so repo comes from the first slash, type from the last
// slash, and name is whatever sits between the two.
function splitLogTopic(topic) {
  const rest = topic.slice('logs:'.length);
  const firstSlash = rest.indexOf('/');
  const lastSlash = rest.lastIndexOf('/');
  if (firstSlash === -1 || firstSlash === lastSlash) return null; // not repo/name/type shaped
  return {
    repo: rest.slice(0, firstSlash),
    name: rest.slice(firstSlash + 1, lastSlash),
    type: rest.slice(lastSlash + 1),
  };
}

function wsTickLog(topic, repo, name, type) {
  const entry = wsTopics.get(topic);
  if (!entry) return; // last subscriber left between the tick firing and it actually running
  const { lines, total } = tailLog(repo, name, type);
  if (total === entry.lastTotal) return; // nothing new since the last tick
  const rotated = total < entry.lastTotal; // rotateLog renamed the file out from under the cursor
  const delta = total - entry.lastTotal;
  const newLines = rotated || delta > lines.length ? lines : lines.slice(-delta);
  entry.lastTotal = total;
  server.publish(topic, JSON.stringify({ topic, data: newLines }));
}

function wsSubscribeLog(ws, topic) {
  if (!topic.startsWith('logs:')) return; // only logs:* topics are sub/unsub driven, see 'worktrees' handling in open/close
  const parsed = splitLogTopic(topic);
  if (!parsed) return; // malformed topic, ignore silently same as a malformed frame
  const { repo, name, type } = parsed;
  ws.subscribe(topic);
  ws.data.add(topic);
  let entry = wsTopics.get(topic);
  if (!entry) {
    entry = { interval: null, subscriberCount: 0, lastBroadcast: null, lastTotal: null };
    wsTopics.set(topic, entry);
  }
  entry.subscriberCount++;
  const { lines, total } = tailLog(repo, name, type);
  if (entry.subscriberCount === 1) {
    // First subscriber starts the tick, baselined on this same tailLog call
    // (not zero), so the first 1000ms tick diffs against real state instead
    // of re-publishing everything as "new" a second time. This connection's
    // catch-up is the whole window tailLog just returned.
    entry.lastTotal = total;
    entry.interval = setInterval(() => wsTickLog(topic, repo, name, type), 1000);
    ws.send(JSON.stringify({ topic, data: lines }));
  } else {
    // A later subscriber joining an already-ticking topic. Lines beyond the
    // shared entry.lastTotal baseline are about to go out to everyone (this
    // connection included, it's already ws.subscribe()'d above) on the next
    // regular tick, so trim them out of this one-time catch-up. Otherwise
    // the client's accumulate-by-concat log view would see them twice, once
    // here and once from that tick's publish.
    const pending = total - entry.lastTotal;
    const catchUp = pending > 0 ? lines.slice(0, lines.length - pending) : lines;
    ws.send(JSON.stringify({ topic, data: catchUp }));
  }
}

function wsUnsubscribeLog(ws, topic) {
  if (!ws.data.has(topic)) return; // not actually subscribed, nothing to do
  ws.unsubscribe(topic);
  ws.data.delete(topic);
  const entry = wsTopics.get(topic);
  if (!entry) return;
  entry.subscriberCount--;
  if (entry.subscriberCount <= 0) {
    clearInterval(entry.interval);
    wsTopics.delete(topic);
  }
}

async function open(ws) {
  // ws.data (a Set of logs:* topics this connection currently holds) was
  // already seeded at server.upgrade(req, { data: new Set() }) in handle().
  // 'worktrees' isn't tracked in it since every connection always holds
  // exactly one, unconditionally, so close() below decrements it directly.
  ws.subscribe('worktrees');
  let entry = wsTopics.get('worktrees');
  if (!entry) {
    entry = { interval: null, subscriberCount: 0, lastBroadcast: null, lastTotal: null };
    wsTopics.set('worktrees', entry);
  }
  entry.subscriberCount++;
  if (entry.subscriberCount === 1) entry.interval = setInterval(wsTickWorktrees, 3000);
  // Always send this connection its own immediate snapshot, independent of
  // the shared tick's diff-guard. Without this, a tab whose WS drops and
  // reconnects while other tabs stay connected would sit on stale state
  // until entry.lastBroadcast (shared across every subscriber) next
  // actually changes -- the diff-guard exists to skip redundant broadcasts
  // to already-synced connections, not to gate a brand new one's first sync.
  const worktrees = await getWorktrees().catch(() => null);
  if (worktrees) ws.send(JSON.stringify({ topic: 'worktrees', data: { worktrees, status: computeStatus() } }));
}

function message(ws, raw) {
  let msg;
  try { msg = JSON.parse(raw); } catch { return; } // a stray non-JSON frame must not crash the connection
  if (!msg || typeof msg !== 'object') return;
  if (typeof msg.sub === 'string') wsSubscribeLog(ws, msg.sub);
  else if (typeof msg.unsub === 'string') wsUnsubscribeLog(ws, msg.unsub);
}

function close(ws) {
  for (const topic of [...ws.data]) wsUnsubscribeLog(ws, topic);
  const entry = wsTopics.get('worktrees');
  if (!entry) return;
  entry.subscriberCount--;
  if (entry.subscriberCount <= 0) {
    clearInterval(entry.interval);
    wsTopics.delete('worktrees');
  }
}

// Wires mcp-server.js's tools straight to this file's own functions --
// direct in-process calls, not HTTP, so /mcp never opens a second request
// back into this same server. Function declarations are hoisted, so every
// name here is already defined despite most living further up the file.
initMcpServer({
  getWorktrees, createWorktree, removeWorktree,
  startWorktree: startWorktreeByName, stopWorktree: stopWorktreeByName,
  syncWorktree: syncWorktreeByName,
  computeDiff, tailLog,
  listPorts: listPortsWithWorktree, listProjects: listProjectsSummary,
  fetchRepoPRs, prReviewStatus, prReviewRun,
});

const server = Bun.serve({
  port: PORT,
  // Both routes serve the identical SPA shell — the client-side router (app.tsx)
  // reads location.pathname itself. Needed so a hard refresh or a direct link
  // to /worktree/:repo/:name doesn't 404 (client-side pushState alone only
  // handles in-app navigation, not a fresh page load hitting the server).
  routes: { '/': indexPage, '/worktree/:repo/:name': indexPage, '/repo/:repo': indexPage, '/settings': indexPage, '/help': indexPage, '/ports': indexPage, '/archived': indexPage },
  fetch: handle,
  websocket: { open, message, close },
  development: false,
});
console.log(`Portal → http://quivly.local  (localhost:${PORT})`);
