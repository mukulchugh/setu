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

import { closeSync, readFileSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';
import { HOME } from './lib.js';

const RUN_TIMEOUT_MS = 20 * 60 * 1000; // wall-clock cap on a single run
const MAX_BUDGET_USD = 2.0; // real money on the user's account per click

// ── plugin detection ────────────────────────────────────────────────────────

const PLUGIN_KEY = 'pr-walkthrough@mukulchugh-skills';

// scope: "user" resolves everywhere; scope: "project" only resolves when
// Claude Code launches with that exact projectPath as cwd — a naive
// "installed anywhere" check would show the button for a worktree where
// only a mismatched project-scoped install exists, and the invocation would
// then fail to resolve /pr-walkthrough at all.
export function detectPrWalkthroughPlugin(wtDir) {
  try {
    const raw = readFileSync(
      `${HOME}/.claude/plugins/installed_plugins.json`,
      'utf8'
    );
    const installs = JSON.parse(raw).plugins?.[PLUGIN_KEY] ?? [];
    return installs.some(
      (i) =>
        i.scope === 'user' || (i.scope === 'project' && i.projectPath === wtDir)
    );
  } catch {
    return false;
  }
}

// ── artifact lookup ──────────────────────────────────────────────────────────

const SKILL_DIR = { 'pr-brief': 'briefs', 'pr-walkthrough': 'reviews' };
const DATA_ROOT = `${HOME}/.local/share/pr-walkthrough`;
const plainPathSegmentPattern = /^[^/\\]+$/;
const unsafeShellPattern = /[;&|`$<>\\'"\n\r]/;
const whitespacePattern = /\s+/;

function plainPathSegment(value) {
  return (
    typeof value === 'string' &&
    value !== '.' &&
    value !== '..' &&
    plainPathSegmentPattern.test(value)
  );
}

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
  try {
    latest = JSON.parse(readFileSync(`${base}/latest.json`, 'utf8'));
  } catch {
    return null;
  }
  if (!plainPathSegment(latest.snapshot)) {
    return null;
  }

  let manifest;
  try {
    manifest = JSON.parse(
      readFileSync(`${base}/${latest.snapshot}/manifest.json`, 'utf8')
    );
  } catch {
    return null;
  }

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
  if (
    !(
      SKILL_DIR[skill] &&
      plainPathSegment(snapshot) &&
      plainPathSegment(htmlFile)
    )
  ) {
    return null;
  }
  const dataDir = resolve(DATA_ROOT, SKILL_DIR[skill], slug, `pr-${prNumber}`);
  const path = resolve(dataDir, snapshot, htmlFile);
  const pathRelative = relative(dataDir, path);
  if (
    pathRelative === '..' ||
    pathRelative.startsWith('../') ||
    isAbsolute(pathRelative)
  ) {
    return null;
  }
  return path;
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

// The old deny patterns were verified empirically to match only a PREFIX:
// `Bash(git push*)` worked, while a wildcard in the middle did not. That
// evidence still matters here: a permissive prefix such as `Bash(git status
// *)` would also accept a compound command. The per-call PreToolUse guard
// below parses the full command and fails closed against its read-only list;
// it is the primary Bash guard, not permission mode or the plugin hook.
const REVIEW_GUARD = new URL('./pr-review-guard.js', import.meta.url).pathname;

const reviewGitFlags = {
  diff: new Set([
    '--cached',
    '--stat',
    '--name-only',
    '--name-status',
    '--no-ext-diff',
    '--no-textconv',
    '--',
  ]),
  log: new Set(['--oneline', '--decorate', '--']),
  'ls-files': new Set(['--cached', '--others', '--exclude-standard', '--']),
  'rev-parse': new Set(['--verify', '--quiet']),
  show: new Set([
    '--stat',
    '--name-only',
    '--no-ext-diff',
    '--no-textconv',
    '--',
  ]),
  status: new Set([
    '--porcelain',
    '--short',
    '--untracked-files=no',
    '--untracked-files=normal',
    '--untracked-files=all',
  ]),
};

const flagsOnly = (values, allowed) =>
  values.every((word) => !word.startsWith('-') || allowed.has(word));

function gitReviewAllowed(words) {
  const [, command] = words;
  const allowed = reviewGitFlags[command];
  if (!allowed) {
    return (
      words.length === 3 &&
      command === 'branch' &&
      words[2] === '--show-current'
    );
  }
  const values = words.slice(2);
  if (!flagsOnly(values, allowed)) {
    return false;
  }
  const separator = values.indexOf('--');
  const options = separator < 0 ? values : values.slice(0, separator);
  return (
    !['diff', 'show'].includes(command) ||
    (options.includes('--no-ext-diff') && options.includes('--no-textconv'))
  );
}

function ghReviewAllowed(words) {
  return (
    words[1] === 'pr' &&
    ['view', 'diff', 'checks'].includes(words[2]) &&
    flagsOnly(words.slice(3), new Set(['--json', '--jq', '--repo']))
  );
}

async function confirmedReviewExit(proc, unknownExit) {
  try {
    const exitCode = await proc?.exited;
    if (Number.isInteger(exitCode) && exitCode >= 0) {
      return exitCode;
    }
  } catch {
    // Process failure is intentionally reduced to the existing unknown-exit result.
  }
  throw unknownExit();
}

export function reviewBashAllowed(command) {
  if (
    typeof command !== 'string' ||
    !command.trim() ||
    unsafeShellPattern.test(command)
  ) {
    return false;
  }
  const words = command.trim().split(whitespacePattern);
  if (words[0] === 'git') {
    return gitReviewAllowed(words);
  }
  if (words[0] === 'gh') {
    return ghReviewAllowed(words);
  }
  if (words[0] === 'pwd') {
    return words.length === 1;
  }
  if (words[0] === 'rg') {
    return flagsOnly(
      words.slice(1),
      new Set(['--line-number', '--glob', '--files', '--hidden'])
    );
  }
  if (words[0] === 'grep') {
    return flagsOnly(
      words.slice(1),
      new Set(['-n', '-r', '--line-number', '--recursive'])
    );
  }
  if (words[0] === 'ls') {
    return flagsOnly(words.slice(1), new Set(['-a', '-l', '-la', '--all']));
  }
  if (['cat', 'head', 'tail', 'wc'].includes(words[0])) {
    return flagsOnly(words.slice(1), new Set(['-n', '-l', '-w', '-c']));
  }
  return false;
}

export function buildDeepReviewArgs(skill, slug, prNumber) {
  const reportDir = `${DATA_ROOT}/${SKILL_DIR[skill]}/${slug}/pr-${prNumber}`;
  const settings = JSON.stringify({
    hooks: {
      PreToolUse: [
        {
          hooks: [
            { args: [REVIEW_GUARD, 'bash'], command: 'bun', type: 'command' },
          ],
          matcher: 'Bash',
        },
        {
          hooks: [
            {
              args: [REVIEW_GUARD, 'write', reportDir],
              command: 'bun',
              type: 'command',
            },
          ],
          matcher: 'Write',
        },
      ],
    },
  });
  return [
    '-p',
    `/${skill} ${slug}#${prNumber}\nFor git diff or git show, include both --no-ext-diff and --no-textconv.`,
    '--permission-mode',
    'acceptEdits',
    '--tools',
    'Read,Grep,Glob,Bash,Write',
    '--settings',
    settings,
    '--permission-prompts',
    'none',
    '--output-format',
    'stream-json',
    '--verbose',
    '--max-budget-usd',
    String(MAX_BUDGET_USD),
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
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i].trim();
    if (!line) {
      continue;
    }
    try {
      const d = JSON.parse(line);
      if (d.type === 'result') {
        return {
          costUsd: d.total_cost_usd ?? null,
          isError: !!d.is_error,
          subtype: d.subtype ?? null,
          valid:
            typeof d.is_error === 'boolean' &&
            (d.total_cost_usd === undefined ||
              d.total_cost_usd === null ||
              (typeof d.total_cost_usd === 'number' &&
                Number.isFinite(d.total_cost_usd))) &&
            (d.subtype === undefined ||
              d.subtype === null ||
              typeof d.subtype === 'string'),
        };
      }
    } catch {
      // An unreadable result line falls through to the explicit error result.
    }
    break;
  }
  return { costUsd: null, isError: true, subtype: null, valid: false };
}

// wtDir/slug/prNumber/logFd/logPath/spawnText are all resolved by the
// caller (portal.js's prReviewRoutes) from REPO_META/fetchPR/openLogFd/
// spawnText — this file stays unaware of the worktree registry or HTTP
// routing, mirroring mcp.js's own split (connectMcpServer takes plain
// values, not portal.js internals).
export function runDeepReview(
  repo,
  name,
  skill,
  {
    wtDir,
    slug,
    prNumber,
    logFd,
    logPath,
    spawnText,
    onCompletion,
    spawn = Bun.spawn,
    readLog = readFileSync,
    closeLog = closeSync,
  }
) {
  const key = `${repo}/${name}`;
  if (runs.get(key)?.running) {
    closeLog(logFd);
    return {
      error: 'a pr-review run is already in flight for this worktree',
      ok: false,
    };
  }

  runs.set(key, {
    costUsd: null,
    dirtyAfter: null,
    error: null,
    exitCode: null,
    running: true,
    skill,
    startedAt: Date.now(),
  });

  const completion = (async () => {
    // --untracked-files=no: the worktree's own dev server (Next.js .next/,
    // log files, generated artifacts) can freely add/remove untracked paths
    // while a multi-minute review runs alongside it — that's unrelated
    // churn, not evidence the review touched the tree. Scoping to tracked
    // files only, and comparing as a sorted set (not a raw string) so a
    // same-lines-different-order porcelain dump doesn't false-positive
    // either, keeps this tripwire meaningful instead of firing on noise.
    const statusArgs = [
      'git',
      '-C',
      wtDir,
      '--no-optional-locks',
      'status',
      '--porcelain',
      '--untracked-files=no',
    ];
    const snapshot = async () =>
      new Set((await spawnText(statusArgs)).split('\n').filter(Boolean));
    const setsEqual = (a, b) =>
      a.size === b.size && [...a].every((l) => b.has(l));

    const failed = (code, error) => ({ code, error, ok: false });
    const updateRun = ({
      costUsd: nextCostUsd = null,
      dirtyAfter: nextDirtyAfter,
      error: nextError,
      exitCode: nextExitCode,
    }) => {
      const current = runs.get(key);
      runs.set(key, {
        costUsd: nextCostUsd,
        dirtyAfter: nextDirtyAfter,
        error: nextError,
        exitCode: nextExitCode,
        running: false,
        skill,
        startedAt: current?.startedAt ?? Date.now(),
      });
    };
    const unknownExit = () =>
      Object.assign(
        new Error('The review process exit could not be confirmed.'),
        {
          code: 'OPERATION_UNKNOWN',
        }
      );
    const before = await snapshot();
    const proc = spawn(
      ['claude', ...buildDeepReviewArgs(skill, slug, prNumber)],
      {
        cwd: wtDir,
        stderr: logFd,
        stdin: 'ignore',
        stdout: logFd,
        timeout: RUN_TIMEOUT_MS,
      }
    );
    const exitCode = await confirmedReviewExit(proc, unknownExit);
    const timedOut = proc.signalCode === 'SIGTERM';
    let after;
    try {
      after = await snapshot();
    } catch {
      updateRun({
        dirtyAfter: null,
        error: 'Tracked-file review output could not be checked.',
        exitCode: 'error',
      });
      return failed(
        'REVIEW_STATUS_FAILED',
        'Tracked-file review output could not be checked.'
      );
    }
    const dirtyAfter = !setsEqual(before, after);

    if (timedOut) {
      updateRun({
        dirtyAfter,
        error: 'timed out after 20 minutes',
        exitCode: 'timeout',
      });
      return failed('REVIEW_TIMEOUT', 'Review timed out after 20 minutes.');
    }
    if (exitCode !== 0 || proc.signalCode) {
      updateRun({
        dirtyAfter,
        error: 'Claude Code exited with a nonzero status.',
        exitCode: 'error',
      });
      return failed(
        'REVIEW_EXIT_FAILED',
        'Claude Code exited with a nonzero status.'
      );
    }
    let text = '';
    try {
      text = readLog(logPath, 'utf8');
    } catch {
      updateRun({
        dirtyAfter,
        error: 'Review output could not be read.',
        exitCode: 'error',
      });
      return failed('REVIEW_LOG_INVALID', 'Review output could not be read.');
    }
    const { costUsd, isError, subtype, valid } = parseResult(text);
    if (!valid) {
      updateRun({
        costUsd,
        dirtyAfter,
        error: 'Review output has no valid terminal result.',
        exitCode: 'error',
      });
      return failed(
        'REVIEW_LOG_INVALID',
        'Review output has no valid terminal result.'
      );
    }
    if (isError) {
      const error = subtype ?? 'run failed';
      updateRun({ costUsd, dirtyAfter, error, exitCode: 'error' });
      return failed('REVIEW_FAILED', error);
    }
    if (dirtyAfter) {
      updateRun({
        costUsd,
        dirtyAfter,
        error: 'Review changed tracked files.',
        exitCode: 'error',
      });
      return failed('REVIEW_DIRTY_OUTPUT', 'Review changed tracked files.');
    }
    updateRun({ costUsd, dirtyAfter, error: null, exitCode: 'success' });
    return { ok: true };
  })()
    .catch((error) => {
      if (error?.code === 'OPERATION_UNKNOWN') {
        runs.set(key, {
          ...runs.get(key),
          error: 'The review process exit could not be confirmed.',
          exitCode: null,
          running: true,
        });
        throw error;
      }
      runs.set(key, {
        ...runs.get(key),
        error: 'Claude Code could not be launched.',
        exitCode: 'error',
        running: false,
      });
      return {
        code: 'REVIEW_LAUNCH_FAILED',
        error: 'Claude Code could not be launched.',
        ok: false,
      };
    })
    .then(
      (result) => {
        try {
          closeLog(logFd);
        } catch {
          runs.set(key, {
            ...runs.get(key),
            error: 'Review log could not be closed.',
            exitCode: 'error',
          });
          return {
            code: 'REVIEW_LOG_CLOSE_FAILED',
            error: 'Review log could not be closed.',
            ok: false,
          };
        }
        return result;
      },
      (error) => {
        try {
          closeLog(logFd);
        } catch {
          /* Unknown process ownership takes precedence over cleanup. */
        }
        throw error;
      }
    );

  onCompletion?.(completion);

  return { ok: true, running: true, skill };
}
