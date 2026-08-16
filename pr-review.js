// pr-review.js — Tier 2 "deep review": invokes the installed pr-walkthrough/
// pr-brief Claude Code plugin headlessly via `claude -p` and manages its
// artifacts. Mirrors mcp.js's split: protocol/invocation logic lives here,
// deliberately unaware of HTTP routing or worktree-registry lookups;
// portal.js's prReviewRoutes resolves repo/worktree/PR context (REPO_META,
// fetchPR, wtPath, openLogFd) and calls straight into the exports below.
//
// Security model verified empirically via 10 real `claude -p` runs before
// this file was written, not assumed from --help text (see the plan's Step 0
// findings): --permission-mode acceptEdits is the only one of manual/
// dontAsk/acceptEdits where the skill's own Write calls actually succeed
// (manual/dontAsk deny Write outright, even with --allowedTools). Neither
// acceptEdits nor the other two modes categorically gates Bash — a harmless
// command executed unconfirmed under every mode tested — so
// --disallowedTools deny patterns are the PRIMARY guard against GH/git
// write-shaped commands here, not defense-in-depth. --tools dropping Edit
// entirely is unaffected by any of this: a hard capability removal, not a
// permission check. --output-format stream-json requires --verbose in
// --print mode (undocumented, confirmed via a hard CLI error).

import { readFileSync } from 'fs';
import { HOME } from './lib.js';

const RUN_TIMEOUT_MS = 20 * 60 * 1000; // wall-clock cap on a single run
const MAX_BUDGET_USD = 2.00;           // real money on the user's account per click

// ── plugin detection ────────────────────────────────────────────────────────

const PLUGIN_KEY = 'pr-walkthrough@mukulchugh-skills';

// scope: "user" resolves everywhere; scope: "project" only resolves when
// Claude Code launches with that exact projectPath as cwd — a naive
// "installed anywhere" check would show the button for a worktree where
// only a mismatched project-scoped install exists, and the invocation would
// then fail to resolve /pr-walkthrough at all.
export function detectPrWalkthroughPlugin(wtDir) {
  try {
    const raw = readFileSync(`${HOME}/.claude/plugins/installed_plugins.json`, 'utf8');
    const installs = JSON.parse(raw).plugins?.[PLUGIN_KEY] ?? [];
    return installs.some(i => i.scope === 'user' || (i.scope === 'project' && i.projectPath === wtDir));
  } catch { return false; }
}

// ── artifact lookup ──────────────────────────────────────────────────────────

const SKILL_DIR = { 'pr-brief': 'briefs', 'pr-walkthrough': 'reviews' };
const DATA_ROOT = `${HOME}/.local/share/pr-walkthrough`;

// slug is "owner/repo" (same format REPO_META[repo].slug already uses).
// Reads latest.json (which snapshot is current) then that snapshot's own
// manifest.json — NOT guide.json/brief.json, which run 10-20MB on a real PR
// and would make every status poll re-parse a huge file for nothing.
// manifest.json is a few KB and already carries stats.findings plus the
// real artifact filename (artifacts.html), so nothing here hardcodes
// "review.html"/"brief.html" by convention — confirmed live those are in
// fact the current names, but reading them from manifest.json is what makes
// this survive the skill renaming its own output file.
export function findLatestArtifact(slug, prNumber, skill, currentHeadSha) {
  const dir = SKILL_DIR[skill];
  const base = `${DATA_ROOT}/${dir}/${slug}/pr-${prNumber}`;
  let latest;
  try { latest = JSON.parse(readFileSync(`${base}/latest.json`, 'utf8')); }
  catch { return null; }

  let manifest;
  try { manifest = JSON.parse(readFileSync(`${base}/${latest.snapshot}/manifest.json`, 'utf8')); }
  catch { return null; }

  return {
    findings: manifest.stats?.findings ?? null,
    generatedAt: latest.generated_at,
    headSha: latest.head_sha,
    htmlFile: manifest.artifacts?.html ?? null,
    snapshot: latest.snapshot,
    stale: !!currentHeadSha && currentHeadSha !== latest.head_sha,
  };
}

// skill is validated against SKILL_DIR's own keys by the caller before this
// ever runs (portal.js's artifact route allowlists it) — repeated here as a
// guard since this resolves a real filesystem path.
export function artifactHtmlPath(slug, prNumber, skill, snapshot, htmlFile) {
  if (!SKILL_DIR[skill] || !htmlFile) return null;
  return `${DATA_ROOT}/${SKILL_DIR[skill]}/${slug}/pr-${prNumber}/${snapshot}/${htmlFile}`;
}

// ── deep review runs ─────────────────────────────────────────────────────────

// key: `${repo}/${name}` -> { running, skill, startedAt, exitCode, costUsd,
// error, dirtyAfter }. Keyed by worktree only, not per-skill: pr-walkthrough
// and pr-brief share one log file and one single-flight slot, so running
// both at once for the same worktree would otherwise interleave their
// output into one confusing log stream.
const runs = new Map();

export function reviewRunStatus(repo, name) {
  return runs.get(`${repo}/${name}`) ?? null;
}

// Mirrors publish_gate.py's own regexes (read directly from the installed
// plugin at ~/.claude/plugins/cache/mukulchugh-skills/pr-walkthrough/1.4.0/
// hooks/publish_gate.py, not assumed) as far as a prefix-glob permission
// pattern can. --disallowedTools matches by PREFIX only, confirmed
// empirically: a real `gh api --help`/`git push --help` invocation is
// reliably denied by `Bash(gh api*)`/`Bash(git push*)`, but a pattern with a
// wildcard in the MIDDLE of the string (`Bash(gh api * --method POST*)`,
// the original design here) silently fails to match at all — verified with
// the same canary method, twice, before shipping this list. Because a
// prefix-only pattern can't selectively allow `gh api` GETs while blocking
// POST/PATCH/PUT/DELETE, this blocks `gh api` entirely rather than trying
// to (silently, incorrectly) discriminate by method — the skill's own
// SKILL.md never references a raw `gh api` call, only `gh pr`-shaped ones,
// so nothing here is lost. This is the PRIMARY guard against GH/git write
// commands, not a backup: Step 0 found permission-mode alone doesn't gate
// Bash for commands its built-in classifier doesn't judge as risky (a
// harmless command ran unconfirmed under every mode tested), and the
// plugin's own hook only fires while a pending-review marker happens to
// exist.
const DISALLOWED_BASH = [
  'Bash(gh pr review*)',
  'Bash(gh pr comment*)',
  'Bash(gh issue create*)',
  'Bash(gh api*)',
  'Bash(git push*)',
];

function claudeArgs(skill, slug, prNumber) {
  return [
    '-p', `/${skill} ${slug}#${prNumber}`,
    '--permission-mode', 'acceptEdits',
    '--tools', 'Read,Grep,Glob,Bash,Write,Task',
    '--disallowedTools', ...DISALLOWED_BASH,
    '--output-format', 'stream-json',
    '--verbose',
    '--max-budget-usd', String(MAX_BUDGET_USD),
  ];
}

// Parses the log for the final result line's total_cost_usd/is_error — the
// only stream-json line that carries them (confirmed empirically: every
// intermediate line is an assistant/tool_use/system event, only the
// terminal `result` line has cost/status). Scans from the end and stops at
// the first non-blank line: if that line isn't a result event, the process
// was killed/crashed mid-stream, not "still parsing" — no reason to look
// further back.
function parseResult(logText) {
  const lines = logText.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line) continue;
    try {
      const d = JSON.parse(line);
      if (d.type === 'result') return { costUsd: d.total_cost_usd ?? null, isError: !!d.is_error, subtype: d.subtype ?? null };
    } catch {}
    break;
  }
  return { costUsd: null, isError: true, subtype: null };
}

// wtDir/slug/prNumber/logFd/logPath/spawnText are all resolved by the
// caller (portal.js's prReviewRoutes) from REPO_META/fetchPR/openLogFd/
// spawnText — this file stays unaware of the worktree registry or HTTP
// routing, mirroring mcp.js's own split (connectMcpServer takes plain
// values, not portal.js internals).
export function runDeepReview(repo, name, skill, { wtDir, slug, prNumber, logFd, logPath, spawnText }) {
  const key = `${repo}/${name}`;
  if (runs.get(key)?.running) return { error: 'a pr-review run is already in flight for this worktree', ok: false };

  runs.set(key, { costUsd: null, dirtyAfter: null, error: null, exitCode: null, running: true, skill, startedAt: Date.now() });

  (async () => {
    // --untracked-files=no: the worktree's own dev server (Next.js .next/,
    // log files, generated artifacts) can freely add/remove untracked paths
    // while a multi-minute review runs alongside it — that's unrelated
    // churn, not evidence the review touched the tree. Scoping to tracked
    // files only, and comparing as a sorted set (not a raw string) so a
    // same-lines-different-order porcelain dump doesn't false-positive
    // either, keeps this tripwire meaningful instead of firing on noise.
    const statusArgs = ['git', '-C', wtDir, '--no-optional-locks', 'status', '--porcelain', '--untracked-files=no'];
    const snapshot = async () => new Set((await spawnText(statusArgs)).split('\n').filter(Boolean));
    const setsEqual = (a, b) => a.size === b.size && [...a].every(l => b.has(l));

    const before = await snapshot();
    const proc = Bun.spawn(['claude', ...claudeArgs(skill, slug, prNumber)], {
      cwd: wtDir, stderr: logFd, stdin: 'ignore', stdout: logFd, timeout: RUN_TIMEOUT_MS,
    });
    await proc.exited;
    const timedOut = proc.signalCode === 'SIGTERM';
    const after = await snapshot();
    const dirtyAfter = !setsEqual(before, after);

    if (timedOut) {
      runs.set(key, { costUsd: null, dirtyAfter, error: 'timed out after 20 minutes', exitCode: 'timeout', running: false, skill, startedAt: runs.get(key).startedAt });
      return;
    }
    let text = '';
    try { text = readFileSync(logPath, 'utf8'); } catch {}
    const { costUsd, isError, subtype } = parseResult(text);
    runs.set(key, {costUsd,
      dirtyAfter,
      error: isError ? (subtype ?? 'run failed') : null,
      exitCode: isError ? 'error' : 'success', 
      running: false, skill, startedAt: runs.get(key).startedAt,
    });
  })();

  return { ok: true, running: true, skill };
}
