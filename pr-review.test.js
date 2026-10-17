import { afterEach, expect, test } from 'bun:test';
import {
  closeSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  rmSync,
  symlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildDeepReviewArgs,
  reviewBashAllowed,
  reviewRunStatus,
  runDeepReview,
} from './pr-review.js';
import { reviewWriteAllowed } from './pr-review-guard.js';

const reviewRoots = [];
let reviewNumber = 0;

function reviewRunFixture({
  exited = Promise.resolve(0),
  log = JSON.stringify({ is_error: false, total_cost_usd: 1, type: 'result' }),
  signalCode = null,
  snapshots = ['', ''],
  spawnError,
  closeError = false,
} = {}) {
  const root = mkdtempSync(join(tmpdir(), 'setu-pr-review-'));
  reviewRoots.push(root);
  const name = `topic-${++reviewNumber}`;
  let completion;
  const started = runDeepReview('repo', name, 'pr-walkthrough', {
    ensureDir: () => {},
    closeLog: (fd) => {
      closeSync(fd);
      if (closeError) {
        throw new Error('fixture close error');
      }
    },
    logFd: openSync(join(root, 'review.log'), 'w'),
    logPath: join(root, 'review.log'),
    onCompletion: (promise) => {
      completion = promise;
    },
    prNumber: 42,
    readLog: () => log,
    slug: 'owner/repo',
    spawn: () => {
      if (spawnError) {
        throw spawnError;
      }
      return { exited, signalCode };
    },
    spawnText: async () => snapshots.shift() ?? '',
    wtDir: root,
  });
  return { completion, name, started };
}

afterEach(() => {
  for (const root of reviewRoots.splice(0)) {
    rmSync(root, { force: true, recursive: true });
  }
});

async function guardExit(kind, args, event) {
  const proc = Bun.spawn(['bun', './pr-review-guard.js', kind, ...args], {
    cwd: import.meta.dir,
    stderr: 'pipe',
    stdin: new Blob([JSON.stringify(event)]).stream(),
    stdout: 'pipe',
  });
  return proc.exited;
}

test('deep-review completion reports confirmed success and bounded known failures', async () => {
  const success = reviewRunFixture();
  expect(success.started).toMatchObject({ ok: true, running: true });
  await expect(success.completion).resolves.toEqual({ ok: true });
  expect(reviewRunStatus('repo', success.name)).toMatchObject({
    exitCode: 'success',
    running: false,
  });

  const modelError = reviewRunFixture({
    log: JSON.stringify({
      is_error: true,
      subtype: 'model_error',
      type: 'result',
    }),
  });
  await expect(modelError.completion).resolves.toMatchObject({
    code: 'REVIEW_FAILED',
    ok: false,
  });

  const nonzero = reviewRunFixture({ exited: Promise.resolve(1) });
  await expect(nonzero.completion).resolves.toMatchObject({
    code: 'REVIEW_EXIT_FAILED',
    ok: false,
  });
  expect(reviewRunStatus('repo', nonzero.name)).toMatchObject({
    exitCode: 'error',
    running: false,
  });

  const timeout = reviewRunFixture({ signalCode: 'SIGTERM' });
  await expect(timeout.completion).resolves.toMatchObject({
    code: 'REVIEW_TIMEOUT',
    ok: false,
  });

  const invalidLog = reviewRunFixture({ log: 'not stream json' });
  await expect(invalidLog.completion).resolves.toMatchObject({
    code: 'REVIEW_LOG_INVALID',
    ok: false,
  });

  const dirty = reviewRunFixture({ snapshots: ['', ' M tracked-file'] });
  await expect(dirty.completion).resolves.toMatchObject({
    code: 'REVIEW_DIRTY_OUTPUT',
    ok: false,
  });
});

test('deep-review completion retains ownership for an unknown exit and reports prelaunch failure', async () => {
  const unknown = reviewRunFixture({
    closeError: true,
    exited: Promise.reject(new Error('fixture exit observation failed')),
  });
  await expect(unknown.completion).rejects.toMatchObject({
    code: 'OPERATION_UNKNOWN',
  });
  expect(reviewRunStatus('repo', unknown.name)).toMatchObject({
    running: true,
  });

  const prelaunch = reviewRunFixture({
    spawnError: new Error('fixture executable unavailable'),
  });
  await expect(prelaunch.completion).resolves.toMatchObject({
    code: 'REVIEW_LAUNCH_FAILED',
    ok: false,
  });
  expect(reviewRunStatus('repo', prelaunch.name)).toMatchObject({
    exitCode: 'error',
    running: false,
  });
  const closeFailure = reviewRunFixture({ closeError: true });
  await expect(closeFailure.completion).resolves.toMatchObject({
    code: 'REVIEW_LOG_CLOSE_FAILED',
    ok: false,
  });
});

test('deep review arguments fail closed for write-shaped Bash commands', async () => {
  const args = buildDeepReviewArgs('pr-walkthrough', 'owner/repo', 42);
  expect(args).toContain('--settings');
  expect(args[args.indexOf('--settings') + 1]).toContain('pr-review-guard.js');
  expect(args[args.indexOf('--settings') + 1]).toContain(
    '/reviews/owner/repo/pr-42'
  );
  expect(args[args.indexOf('-p') + 1]).toContain(
    '--no-ext-diff and --no-textconv'
  );
  for (const command of [
    'gh pr merge 42',
    'gh pr close 42',
    'gh pr edit 42 --title changed',
    'git -C . push',
    'git status && git push',
  ]) {
    expect(reviewBashAllowed(command)).toBe(false);
    expect(args).not.toContain(`Bash(${command})`);
  }
  expect(reviewBashAllowed('git status')).toBe(true);
  expect(reviewBashAllowed('git log --oneline -3 origin/staging..HEAD')).toBe(
    true
  );
  expect(reviewBashAllowed('gh pr view 19 -R owner/repo --json files')).toBe(
    true
  );
  expect(reviewBashAllowed('git diff -3 --no-ext-diff --no-textconv')).toBe(
    false
  );
  for (const command of [
    'git diff --stat',
    'git show --name-only',
    'git diff -- --no-ext-diff --no-textconv',
  ]) {
    expect(reviewBashAllowed(command)).toBe(false);
    expect(await guardExit('bash', [], { tool_input: { command } })).toBe(2);
  }
  for (const command of [
    'git diff --no-ext-diff --no-textconv --stat',
    'git show --no-ext-diff --no-textconv --name-only',
  ]) {
    expect(reviewBashAllowed(command)).toBe(true);
    expect(await guardExit('bash', [], { tool_input: { command } })).toBe(0);
  }
  for (const command of [
    "sed -n 'w /tmp/output' file",
    'sort --output=/tmp/output file',
    'rg --pre command pattern file',
    'git diff --output=/tmp/output',
  ]) {
    expect(reviewBashAllowed(command)).toBe(false);
    expect(await guardExit('bash', [], { tool_input: { command } })).toBe(2);
  }
});

test('review write guard rejects existing, dangling, and intermediate symlink ancestors', async () => {
  const root = mkdtempSync(join(tmpdir(), 'setu-review-guard-'));
  const report = join(root, 'report');
  const outside = join(root, 'outside');
  const inside = join(report, 'inside');
  mkdirSync(report);
  mkdirSync(outside);
  mkdirSync(inside);
  symlinkSync(outside, join(report, 'escape'));
  symlinkSync(join(outside, 'does-not-exist'), join(report, 'dangling'));
  symlinkSync(inside, join(report, 'intermediate'));
  expect(reviewWriteAllowed(join(report, 'result.html'), report)).toBe(true);
  expect(
    reviewWriteAllowed(join(report, 'escape', 'result.html'), report)
  ).toBe(false);
  expect(
    reviewWriteAllowed(join(report, 'dangling', 'result.html'), report)
  ).toBe(false);
  expect(
    reviewWriteAllowed(join(report, 'intermediate', 'result.html'), report)
  ).toBe(false);
  expect(
    await guardExit('write', [report], {
      tool_input: { file_path: join(report, 'escape', 'result.html') },
    })
  ).toBe(2);
  expect(
    await guardExit('write', [report], {
      tool_input: { file_path: join(report, 'dangling', 'result.html') },
    })
  ).toBe(2);
  expect(
    await guardExit('write', [report], {
      tool_input: { file_path: join(report, 'intermediate', 'result.html') },
    })
  ).toBe(2);
});

test('guard explicitly approves allowlisted commands for the prompt-less run', async () => {
  const proc = Bun.spawn(['bun', './pr-review-guard.js', 'bash'], {
    cwd: import.meta.dir,
    stdin: new Blob([
      JSON.stringify({ tool_input: { command: 'git status' } }),
    ]).stream(),
    stdout: 'pipe',
  });
  const out = JSON.parse(await new Response(proc.stdout).text());
  expect(await proc.exited).toBe(0);
  expect(out.hookSpecificOutput.permissionDecision).toBe('allow');
});

test('guard allows only the installed plugin scripts', () => {
  const root = '/plugins/pr-walkthrough/1.4.0';
  expect(
    reviewBashAllowed(
      `python3 ${root}/skills/pr-walkthrough/scripts/render_review.py --list-reviews`,
      root
    )
  ).toBe(true);
  expect(
    reviewBashAllowed('python3 /tmp/evil/scripts/render_review.py', root)
  ).toBe(false);
  expect(
    reviewBashAllowed(
      `python3 ${root}/skills/pr-walkthrough/scripts/render_review.py`
    )
  ).toBe(false);
});
