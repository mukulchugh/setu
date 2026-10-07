import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSetupProgress } from './setup-progress.js';
import { createWorkspaceState } from './workspace-state.js';

const roots = [];
afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { force: true, recursive: true });
  }
});

function stateFixture() {
  const root = mkdtempSync(join(tmpdir(), 'setu-progress-test-'));
  roots.push(root);
  const configPath = join(root, 'config.json');
  return {
    configPath,
    root,
    state: createWorkspaceState({
      configPath,
      setuDir: root,
      workspaceRoot: root,
    }),
  };
}

const target = { name: 'topic', repo: 'app' };

test('setup progress persists its stage, checkout identity, log location and terminal outcome', async () => {
  let time = 10;
  const { state } = stateFixture();
  const progress = createSetupProgress({
    newAttemptId: () => 'attempt-1',
    now: () => time,
    state,
  });
  await expect(
    progress.start({
      checkoutIdentity: 'checkout-a',
      logLocation: 'logs/app-topic-setup.log',
      stage: 'dependencies',
      target,
    })
  ).resolves.toMatchObject({
    ok: true,
    record: { attemptId: 'attempt-1', outcome: null },
  });
  time = 11;
  await progress.stage({
    attemptId: 'attempt-1',
    checkoutIdentity: 'checkout-a',
    stage: 'ready-check',
    target,
  });
  time = 12;
  await progress.finish({
    attemptId: 'attempt-1',
    checkoutIdentity: 'checkout-a',
    outcome: 'completed',
    target,
  });
  expect(progress.get(target)).toEqual({
    attemptId: 'attempt-1',
    checkoutIdentity: 'checkout-a',
    finishedAt: 12,
    logLocation: 'logs/app-topic-setup.log',
    outcome: 'completed',
    stage: 'ready-check',
    startedAt: 10,
    state: 'completed',
    target,
    updatedAt: 12,
  });
});

test('restart recovery turns unfinished setup into unknown and a retry reuses its record', async () => {
  let time = 100;
  const { state } = stateFixture();
  const first = createSetupProgress({
    newAttemptId: () => 'attempt-1',
    now: () => time,
    state,
  });
  await first.start({
    checkoutIdentity: 'checkout-a',
    logLocation: 'logs/setup.log',
    stage: 'dependencies',
    target,
  });
  time = 101;
  const restarted = createSetupProgress({
    newAttemptId: () => 'attempt-2',
    now: () => time,
    state,
  });
  await expect(restarted.recover()).resolves.toEqual({
    ok: true,
    recovered: 1,
  });
  expect(restarted.get(target)).toMatchObject({
    outcome: 'unknown',
    state: 'unknown',
  });
  time = 102;
  await expect(
    restarted.retry({
      attemptId: 'attempt-1',
      checkoutIdentity: 'checkout-a',
      logLocation: 'logs/setup-retry.log',
      stage: 'dependencies',
      target,
    })
  ).resolves.toMatchObject({
    ok: true,
    record: { attemptId: 'attempt-2', outcome: null, state: 'running' },
  });
  expect(restarted.get(target)).toMatchObject({
    checkoutIdentity: 'checkout-a',
    logLocation: 'logs/setup-retry.log',
    startedAt: 102,
  });
});

test('progress refuses a different checkout identity and does not execute setup work', async () => {
  const calls = [];
  const { state } = stateFixture();
  const progress = createSetupProgress({
    newAttemptId: () => 'attempt-1',
    now: () => 1,
    run: () => calls.push('run'),
    state,
  });
  await progress.start({
    checkoutIdentity: 'checkout-a',
    logLocation: 'logs/setup.log',
    stage: 'dependencies',
    target,
  });
  await expect(
    progress.stage({
      attemptId: 'attempt-1',
      checkoutIdentity: 'checkout-b',
      stage: 'ready-check',
      target,
    })
  ).resolves.toMatchObject({ code: 'CHECKOUT_IDENTITY_MISMATCH', ok: false });
  expect(calls).toEqual([]);
});

test('progress retains a structured checkout identity after atomic persistence', async () => {
  const { state } = stateFixture();
  const progress = createSetupProgress({
    newAttemptId: () => 'attempt-1',
    now: () => 1,
    state,
  });
  const identity = { checkout: { dev: '1', ino: '2' }, known: true };
  await progress.start({
    checkoutIdentity: identity,
    logLocation: 'logs/setup.log',
    stage: 'dependencies',
    target,
  });
  await expect(
    progress.stage({
      attemptId: 'attempt-1',
      checkoutIdentity: { checkout: { dev: '1', ino: '2' }, known: true },
      stage: 'ready-check',
      target,
    })
  ).resolves.toMatchObject({ ok: true, record: { stage: 'ready-check' } });
});

test('setup progress leaves the hand-edited config document byte-for-byte unchanged', async () => {
  const { configPath, state } = stateFixture();
  writeFileSync(configPath, '{\n  "manualSetting": "keep whitespace"\n}\n');
  const before = readFileSync(configPath, 'utf8');
  const progress = createSetupProgress({
    newAttemptId: () => 'attempt-1',
    now: () => 1,
    state,
  });
  await progress.start({
    checkoutIdentity: 'checkout-a',
    logLocation: 'logs/setup.log',
    stage: 'dependencies',
    target,
  });
  expect(readFileSync(configPath, 'utf8')).toBe(before);
  expect(state.read('setupProgress').records['app/topic']).toMatchObject({
    stage: 'dependencies',
  });
});

test('attempt ids reject late updates and terminal records cannot change outcome', async () => {
  const { state } = stateFixture();
  const attempts = ['attempt-1', 'attempt-2'];
  const progress = createSetupProgress({
    newAttemptId: () => attempts.shift(),
    now: () => 1,
    state,
  });
  await progress.start({
    checkoutIdentity: 'checkout-a',
    logLocation: 'logs/setup.log',
    stage: 'dependencies',
    target,
  });
  await progress.finish({
    attemptId: 'attempt-1',
    checkoutIdentity: 'checkout-a',
    outcome: 'failed',
    target,
  });
  await progress.retry({
    attemptId: 'attempt-1',
    checkoutIdentity: 'checkout-a',
    logLocation: 'logs/retry.log',
    stage: 'dependencies',
    target,
  });
  await expect(
    progress.finish({
      attemptId: 'attempt-1',
      checkoutIdentity: 'checkout-a',
      outcome: 'failed',
      target,
    })
  ).resolves.toMatchObject({ code: 'SETUP_ATTEMPT_MISMATCH', ok: false });
  await progress.finish({
    attemptId: 'attempt-2',
    checkoutIdentity: 'checkout-a',
    outcome: 'completed',
    target,
  });
  await expect(
    progress.finish({
      attemptId: 'attempt-2',
      checkoutIdentity: 'checkout-a',
      outcome: 'failed',
      target,
    })
  ).resolves.toMatchObject({ code: 'SETUP_NOT_RUNNING', ok: false });
});

test('malformed setup progress records are refused without changing journal bytes', async () => {
  const { root, state } = stateFixture();
  const documentPath = join(root, '.setu-setup-progress.json');
  writeFileSync(documentPath, '{\n  "records": []\n}\n');
  const before = readFileSync(documentPath, 'utf8');
  const progress = createSetupProgress({
    newAttemptId: () => 'attempt-1',
    now: () => 1,
    state,
  });
  await expect(
    progress.start({
      checkoutIdentity: 'checkout-a',
      logLocation: 'logs/setup.log',
      stage: 'dependencies',
      target,
    })
  ).resolves.toMatchObject({ code: 'SETUP_PROGRESS_CORRUPT', ok: false });
  expect(readFileSync(documentPath, 'utf8')).toBe(before);
});
