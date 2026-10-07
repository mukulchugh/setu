import { afterEach, expect, test } from 'bun:test';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHeadlessRun } from './headless-run.js';
import { createWorkspaceState } from './workspace-state.js';

const roots = [];
const children = [];

async function waitForMarker(stream, marker) {
  const decoder = new TextDecoder();
  let text = '';
  for await (const chunk of stream) {
    text += decoder.decode(chunk, { stream: true });
    if (text.includes(marker)) {
      return;
    }
  }
  throw new Error(`fixture marker not received: ${marker}`);
}

function fixture() {
  const root = fs.mkdtempSync(join(tmpdir(), 'setu-headless-run-'));
  roots.push(root);
  const state = createWorkspaceState({
    configPath: join(root, 'config.json'),
    setuDir: root,
    workspaceRoot: root,
  });
  const runner = createHeadlessRun({
    admit: async () => ({ lease: { id: 'lease' }, ok: true }),
    launch: ({ onOutput }) => {
      const child = Bun.spawn(
        [
          process.execPath,
          '-e',
          "console.log(JSON.stringify({session_id:'session-1'})); console.error('stderr'); setTimeout(() => process.exit(0), 20)",
        ],
        { stderr: 'pipe', stdout: 'pipe' }
      );
      children.push(child);
      onOutput?.(child.stdout, child.stderr);
      return child;
    },
    now: () => Date.now(),
    observeProcess: async (pid) => ({
      processId: pid,
      processStartIdentity: `start-${pid}`,
      state: 'alive',
    }),
    state,
  });
  return { root, runner, state };
}

const target = {
  checkoutIdentity: { head: 'abc123', path: '/tmp/worktree' },
  checkoutPath: '/tmp/worktree',
  name: 'topic',
  repo: 'repo',
};

function storedRun(id, details = {}) {
  return {
    checkoutIdentity: target.checkoutIdentity,
    checkoutPath: target.checkoutPath,
    createdAt: 1,
    id,
    limits: { maxBudgetUsd: 1, outputBytes: 1024, wallClockMs: 1000 },
    model: null,
    name: target.name,
    provider: 'claude',
    providerBudget: 'enforced by Claude Code --max-budget-usd',
    repo: target.repo,
    resumedFrom: null,
    resumeSession: null,
    state: 'completed',
    ...details,
  };
}

function deferredChild(pid = 4242, details = {}) {
  let resolveExit;
  return {
    child: {
      exited: new Promise((resolve) => {
        resolveExit = resolve;
      }),
      pid,
      ...details,
    },
    exit: (code = 0) => resolveExit(code),
  };
}

afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null) {
      child.kill();
    }
    await child.exited;
  }
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { force: true, recursive: true });
  }
});

test('starts one Claude run, persists its identity, output bound and completed result', async () => {
  const { runner, state } = fixture();
  const started = await runner.start({
    ...target,
    id: 'run-1',
    prompt: 'do the bounded test task',
    wallClockMs: 1000,
  });
  expect(started).toMatchObject({ id: 'run-1', ok: true, state: 'running' });
  expect(started.budget).toBe('enforced by Claude Code --max-budget-usd');
  await runner.wait('run-1');
  const record = state.read('headlessRuns').runs['run-1'];
  expect(record).toMatchObject({
    checkoutIdentity: target.checkoutIdentity,
    id: 'run-1',
    provider: 'claude',
    state: 'completed',
  });
  expect(record).not.toHaveProperty('prompt');
  expect(runner.getLog('run-1').text).toContain('session-1');
});

test('accepts a normal slash-containing branch name', async () => {
  const { runner } = fixture();
  await expect(
    runner.start({
      ...target,
      id: 'run-slash',
      name: 'feat/headless-run',
      prompt: 'branch',
      wallClockMs: 1000,
    })
  ).resolves.toMatchObject({ ok: true });
  await runner.wait('run-slash');
});

test('refuses a second run for the same worktree while the first is unresolved', async () => {
  const { runner } = fixture();
  await runner.start({
    ...target,
    id: 'run-1',
    prompt: 'first',
    wallClockMs: 1000,
  });
  await expect(
    runner.start({
      ...target,
      id: 'run-2',
      prompt: 'second',
      wallClockMs: 1000,
    })
  ).resolves.toMatchObject({ code: 'HEADLESS_RUN_ACTIVE', ok: false });
  await runner.wait('run-1');
});

test('returns the claimed run id and durable state for refused or uncertain admission', async () => {
  const uncertain = fixture();
  const uncertainRunner = createHeadlessRun({
    admit: async () => {
      throw new Error('fixture admission unavailable');
    },
    state: uncertain.state,
  });
  await expect(
    uncertainRunner.start({
      ...target,
      id: 'run-admission-unknown',
      prompt: 'admission',
    })
  ).resolves.toMatchObject({
    code: 'ADMISSION_FAILED',
    id: 'run-admission-unknown',
    ok: false,
    state: 'unknown',
  });
  expect(
    uncertain.state.read('headlessRuns').runs['run-admission-unknown'].state
  ).toBe('unknown');

  const refused = fixture();
  const refusedRunner = createHeadlessRun({
    admit: async () => ({ code: 'ADMISSION_REFUSED', ok: false }),
    state: refused.state,
  });
  await expect(
    refusedRunner.start({
      ...target,
      id: 'run-admission-refused',
      prompt: 'admission',
    })
  ).resolves.toMatchObject({
    code: 'ADMISSION_REFUSED',
    id: 'run-admission-refused',
    ok: false,
    state: 'failed',
  });
  expect(
    refused.state.read('headlessRuns').runs['run-admission-refused'].state
  ).toBe('failed');
});

test('a deadline signals only a process with the recorded start identity and never reports success', async () => {
  const { runner, state } = fixture();
  const signals = [];
  const stuck = Bun.spawn([
    process.execPath,
    '-e',
    'setInterval(() => {}, 1000)',
  ]);
  children.push(stuck);
  const bounded = createHeadlessRun({
    admit: async () => ({ ok: true }),
    launch: () => stuck,
    observeProcess: async (pid) => ({
      processId: pid,
      processStartIdentity: `start-${pid}`,
      state: 'alive',
    }),
    signal: (pid, value) => {
      signals.push([pid, value]);
      process.kill(pid, value);
    },
    state,
  });
  await bounded.start({
    ...target,
    id: 'run-timeout',
    prompt: 'wait',
    wallClockMs: 10,
  });
  await bounded.wait('run-timeout');
  expect(signals).toEqual([[stuck.pid, 'SIGTERM']]);
  expect(state.read('headlessRuns').runs['run-timeout'].state).toBe(
    'timed out'
  );
});

test('resume refuses a record with no documented provider session reference', async () => {
  const { runner, state } = fixture();
  await state.update('headlessRuns', (document) => ({
    ...document,
    runs: {
      old: storedRun('old'),
    },
  }));
  await expect(
    runner.resume({
      ...target,
      id: 'resumed',
      prompt: 'continue',
      runId: 'old',
    })
  ).resolves.toMatchObject({ code: 'RESUME_UNAVAILABLE', ok: false });
});

test('cancel confirms the recorded process before signalling it and settles cancelled', async () => {
  const { state } = fixture();
  const signals = [];
  const child = Bun.spawn([
    process.execPath,
    '-e',
    'setInterval(() => {}, 1000)',
  ]);
  children.push(child);
  const runner = createHeadlessRun({
    admit: async () => ({ ok: true }),
    launch: () => child,
    observeProcess: async (pid) => ({
      processId: pid,
      processStartIdentity: `start-${pid}`,
      state: 'alive',
    }),
    signal: (pid, value) => {
      signals.push([pid, value]);
      process.kill(pid, value);
    },
    state,
  });
  await runner.start({
    ...target,
    id: 'run-cancel',
    prompt: 'wait',
    wallClockMs: 1000,
  });
  await expect(
    runner.cancel({
      checkoutIdentity: {
        head: target.checkoutIdentity.head,
        path: target.checkoutIdentity.path,
      },
      id: 'run-cancel',
    })
  ).resolves.toMatchObject({ ok: true, state: 'cancelling' });
  await runner.wait('run-cancel');
  expect(signals).toEqual([[child.pid, 'SIGTERM']]);
  expect(state.read('headlessRuns').runs['run-cancel'].state).toBe('cancelled');
});

test('keeps an output tail bounded even when provider output has no newline', async () => {
  const { state } = fixture();
  const runner = createHeadlessRun({
    admit: async () => ({ ok: true }),
    launch: () => {
      const child = Bun.spawn(
        [process.execPath, '-e', "process.stdout.write('x'.repeat(100))"],
        { stderr: 'pipe', stdout: 'pipe' }
      );
      children.push(child);
      return child;
    },
    observeProcess: async (pid) => ({
      processId: pid,
      processStartIdentity: `start-${pid}`,
      state: 'alive',
    }),
    state,
  });
  await runner.start({
    ...target,
    id: 'run-output',
    outputBytes: 16,
    prompt: 'print',
    wallClockMs: 1000,
  });
  await runner.wait('run-output');
  const output = runner.getLog('run-output');
  expect(Buffer.byteLength(output.text)).toBeLessThanOrEqual(16);
  expect(output.truncated).toBe(true);
});

test('reconciliation leaves an unconfirmed pre-restart run unknown and blocks replacement', async () => {
  const { runner, state } = fixture();
  await state.update('headlessRuns', (document) => ({
    ...document,
    runs: {
      stranded: {
        ...storedRun('stranded'),
        pid: 999_999,
        processStart: 'old-start',
        state: 'running',
      },
    },
  }));
  await expect(runner.reconcile()).resolves.toEqual({
    ok: true,
    unknown: ['stranded'],
  });
  expect(state.read('headlessRuns').runs.stranded.state).toBe('unknown');
  await expect(
    runner.start({
      ...target,
      id: 'replacement',
      prompt: 'again',
      wallClockMs: 1000,
    })
  ).resolves.toMatchObject({ code: 'HEADLESS_RUN_ACTIVE', ok: false });
});

test('refuses malformed run journals without effects, including corruption under the claim lock', async () => {
  const corruptions = [
    ['null runs', { runs: null }],
    ['array runs', { runs: [] }],
    ['unknown state', { runs: { bad: storedRun('bad', { state: 'paused' }) } }],
    [
      'missing identity',
      { runs: { bad: storedRun('bad', { checkoutIdentity: undefined }) } },
    ],
    [
      'missing checkout path',
      { runs: { bad: storedRun('bad', { checkoutPath: undefined }) } },
    ],
    [
      'missing provider',
      { runs: { bad: storedRun('bad', { provider: undefined }) } },
    ],
    [
      'missing created time',
      { runs: { bad: storedRun('bad', { createdAt: undefined }) } },
    ],
    [
      'missing limits',
      { runs: { bad: storedRun('bad', { limits: undefined }) } },
    ],
    [
      'partial process identity',
      { runs: { bad: storedRun('bad', { pid: 42 }) } },
    ],
  ];
  for (const [, document] of corruptions) {
    const { root, state } = fixture();
    const path = join(root, '.setu-headless-runs.json');
    const bytes = `${JSON.stringify(document, null, 2)}\n`;
    fs.writeFileSync(path, bytes);
    let admits = 0,
      launches = 0,
      signals = 0;
    const runner = createHeadlessRun({
      admit: async () => {
        admits += 1;
        return { ok: true };
      },
      launch: () => {
        launches += 1;
      },
      signal: () => {
        signals += 1;
      },
      state,
    });
    await expect(
      runner.start({ ...target, id: 'run-corrupt', prompt: 'do not run' })
    ).resolves.toMatchObject({
      code: 'HEADLESS_RUN_JOURNAL_INVALID',
      ok: false,
    });
    expect(fs.readFileSync(path, 'utf8')).toBe(bytes);
    expect([admits, launches, signals]).toEqual([0, 0, 0]);
  }

  const { root, state } = fixture();
  const path = join(root, '.setu-headless-runs.json');
  const bytes = '{\n  "runs": null\n}\n';
  let writes = 0,
    admits = 0,
    launches = 0,
    signals = 0;
  const runner = createHeadlessRun({
    admit: async () => {
      admits += 1;
      return { ok: true };
    },
    launch: () => {
      launches += 1;
    },
    signal: () => {
      signals += 1;
    },
    state: {
      ...state,
      update(name, mutate) {
        if (name === 'headlessRuns' && writes++ === 0) {
          fs.writeFileSync(path, bytes);
        }
        return state.update(name, mutate);
      },
    },
  });
  await expect(
    runner.start({ ...target, id: 'run-raced-corrupt', prompt: 'do not run' })
  ).resolves.toMatchObject({
    code: 'HEADLESS_RUN_JOURNAL_INVALID',
    ok: false,
  });
  expect(fs.readFileSync(path, 'utf8')).toBe(bytes);
  expect([admits, launches, signals]).toEqual([0, 0, 0]);
});

test('a dispatch whose process identity cannot be persisted remains unknown after it exits', async () => {
  const { state } = fixture();
  let updates = 0;
  const flakyState = {
    ...state,
    update(...args) {
      updates += 1;
      if (updates === 2) {
        throw new Error('fixture identity write failed');
      }
      return state.update(...args);
    },
  };
  const runner = createHeadlessRun({
    admit: async () => ({ ok: true }),
    launch: () => {
      const child = Bun.spawn([
        process.execPath,
        '-e',
        'setTimeout(() => process.exit(0), 10)',
      ]);
      children.push(child);
      return child;
    },
    observeProcess: async (pid) => ({
      processId: pid,
      processStartIdentity: `start-${pid}`,
      state: 'alive',
    }),
    state: flakyState,
  });
  await expect(
    runner.start({
      ...target,
      id: 'run-persistence',
      prompt: 'short',
      wallClockMs: 1000,
    })
  ).resolves.toMatchObject({
    code: 'STATE_WRITE_FAILED',
    id: 'run-persistence',
    ok: false,
    state: 'unknown',
  });
  await runner.wait('run-persistence');
  expect(state.read('headlessRuns').runs['run-persistence'].state).toBe(
    'unknown'
  );
});

test('resume creates a new Claude attempt only from its recorded provider session', async () => {
  const { runner, state } = fixture();
  await runner.start({
    ...target,
    id: 'first',
    prompt: 'first task',
    wallClockMs: 1000,
  });
  await runner.wait('first');
  expect(state.read('headlessRuns').runs.first.resumeSession).toBe('session-1');
  await expect(
    runner.resume({
      ...target,
      id: 'second',
      prompt: 'follow up',
      runId: 'first',
      wallClockMs: 1000,
    })
  ).resolves.toMatchObject({ id: 'second', ok: true });
  await runner.wait('second');
  expect(state.read('headlessRuns').runs.second).toMatchObject({
    resumedFrom: 'first',
    resumeSession: 'session-1',
    state: 'completed',
  });
});

test('runtime writes leave the user config document byte-for-byte unchanged', async () => {
  const { root, runner } = fixture();
  const configPath = join(root, 'config.json');
  fs.writeFileSync(configPath, '{\n  "theme": "manual"\n}\n');
  const before = fs.readFileSync(configPath);
  await runner.start({
    ...target,
    id: 'config-isolation',
    prompt: 'short',
    wallClockMs: 1000,
  });
  await runner.wait('config-isolation');
  expect(fs.readFileSync(configPath)).toEqual(before);
});

test('an unobservable launched child is drained and remains unresolved without releasing admission', async () => {
  const { state } = fixture();
  let released = 0;
  const child = Bun.spawn(
    [
      process.execPath,
      '-e',
      "process.stdout.write('drained'); setTimeout(() => process.exit(0), 20)",
    ],
    { stderr: 'pipe', stdout: 'pipe' }
  );
  children.push(child);
  const runner = createHeadlessRun({
    admit: async () => ({ lease: { id: 'lease' }, ok: true }),
    launch: () => child,
    observeProcess: async () => {
      throw new Error('fixture cannot observe');
    },
    release: async () => {
      released += 1;
    },
    state,
  });
  await expect(
    runner.start({
      ...target,
      id: 'run-unobservable',
      prompt: 'short',
      wallClockMs: 1000,
    })
  ).resolves.toMatchObject({
    code: 'RUN_PROCESS_UNKNOWN',
    id: 'run-unobservable',
    ok: false,
    state: 'unknown',
  });
  await runner.wait('run-unobservable');
  expect(runner.getLog('run-unobservable').text).toContain('drained');
  expect(state.read('headlessRuns').runs['run-unobservable'].state).toBe(
    'unknown'
  );
  expect(released).toBe(0);
});

test('cancellation rechecks ownership after the state write before signalling', async () => {
  const { state } = fixture();
  const child = Bun.spawn([
    process.execPath,
    '-e',
    'setInterval(() => {}, 1000)',
  ]);
  children.push(child);
  const signals = [];
  let checks = 0;
  const runner = createHeadlessRun({
    admit: async () => ({ ok: true }),
    launch: () => child,
    observeProcess: async (pid) => {
      checks += 1;
      return checks < 3
        ? {
            processId: pid,
            processStartIdentity: `start-${pid}`,
            state: 'alive',
          }
        : { state: 'unknown' };
    },
    signal: (...args) => signals.push(args),
    state,
  });
  await runner.start({
    ...target,
    id: 'run-recheck',
    prompt: 'wait',
    wallClockMs: 1000,
  });
  await expect(
    runner.cancel({
      checkoutIdentity: target.checkoutIdentity,
      id: 'run-recheck',
    })
  ).resolves.toMatchObject({ code: 'RUN_PROCESS_UNKNOWN', ok: false });
  expect(signals).toEqual([]);
  expect(state.read('headlessRuns').runs['run-recheck'].state).toBe('unknown');
});

test('a TERM-resistant owned child receives bounded group escalation', async () => {
  const { state } = fixture();
  const child = Bun.spawn(
    [
      process.execPath,
      '-e',
      "process.on('SIGTERM', () => {}); process.stdout.write('ready\\n'); setInterval(() => {}, 1000)",
    ],
    { stdout: 'pipe' }
  );
  children.push(child);
  await waitForMarker(child.stdout, 'ready\n');
  const signals = [];
  const runner = createHeadlessRun({
    admit: async () => ({ ok: true }),
    escalationMs: 10,
    launch: () => ({
      exited: child.exited,
      ownedGroup: true,
      pid: child.pid,
    }),
    observeGroup: async () =>
      signals.some(([, value]) => value === 'SIGKILL') ? 'absent' : 'alive',
    observeProcess: async (pid) => ({
      processId: pid,
      processStartIdentity: `start-${pid}`,
      state: 'alive',
    }),
    signal: (pid, value) => {
      signals.push([pid, value]);
      process.kill(Math.abs(pid), value);
    },
    state,
  });
  await runner.start({
    ...target,
    id: 'run-escalate',
    prompt: 'wait',
    wallClockMs: 10,
  });
  await runner.wait('run-escalate');
  expect(signals).toEqual([
    [-child.pid, 'SIGTERM'],
    [-child.pid, 'SIGKILL'],
  ]);
  expect(state.read('headlessRuns').runs['run-escalate'].state).toBe(
    'timed out'
  );
});

test('passes a validated model and rejects unsafe permission modes, excessive limits and malformed journals', async () => {
  const { state } = fixture();
  let args;
  const runner = createHeadlessRun({
    admit: async () => ({ ok: true }),
    launch: (input) => {
      args = input.args;
      const child = Bun.spawn([process.execPath, '-e', 'process.exit(0)']);
      children.push(child);
      return child;
    },
    observeProcess: async (pid) => ({
      processId: pid,
      processStartIdentity: `start-${pid}`,
      state: 'alive',
    }),
    state,
  });
  await runner.start({
    ...target,
    id: 'run-model',
    model: 'claude-sonnet-4-5',
    prompt: 'model',
    wallClockMs: 1000,
  });
  await runner.wait('run-model');
  expect(args).toContain('--model');
  expect(args).toContain('claude-sonnet-4-5');
  await expect(
    runner.start({
      ...target,
      id: 'bad-mode',
      permissionMode: 'bypassPermissions',
      prompt: 'no',
      wallClockMs: 1000,
    })
  ).resolves.toMatchObject({ code: 'PERMISSION_MODE_INVALID', ok: false });
  await expect(
    runner.start({ ...target, id: 'bad-limit', prompt: 'no', wallClockMs: 9e9 })
  ).resolves.toMatchObject({ code: 'HEADLESS_RUN_LIMIT_INVALID', ok: false });
  await state.update('headlessRuns', () => ({ runs: [] }));
  await expect(
    runner.start({
      ...target,
      id: 'bad-journal',
      prompt: 'no',
      wallClockMs: 1000,
    })
  ).resolves.toMatchObject({ code: 'HEADLESS_RUN_JOURNAL_INVALID', ok: false });
});

test('a fast exit waits for gated startup publication and is not resurrected as running', async () => {
  const { state } = fixture();
  let releaseObserve,
    released = 0;
  const observed = new Promise((resolve) => {
    releaseObserve = resolve;
  });
  const runner = createHeadlessRun({
    admit: async () => ({ lease: { id: 'lease' }, ok: true }),
    launch: () => ({ exited: Promise.resolve(0), pid: 4242 }),
    observeProcess: async (pid) => {
      await observed;
      return {
        processId: pid,
        processStartIdentity: 'gated-start',
        state: 'alive',
      };
    },
    release: async () => {
      released += 1;
    },
    state,
  });
  const started = runner.start({
    ...target,
    id: 'run-gated-exit',
    prompt: 'short',
    wallClockMs: 1000,
  });
  await Promise.resolve();
  releaseObserve();
  await expect(started).resolves.toMatchObject({ ok: true });
  await runner.wait('run-gated-exit');
  expect(state.read('headlessRuns').runs['run-gated-exit'].state).toBe(
    'completed'
  );
  expect(released).toBe(1);
});

test('a gated unknown startup outcome is not overwritten by late running publication', async () => {
  const { state } = fixture();
  let releaseObserve;
  const observed = new Promise((resolve) => {
    releaseObserve = resolve;
  });
  const runner = createHeadlessRun({
    admit: async () => ({ ok: true }),
    launch: () => ({ exited: Promise.resolve(0), pid: 4243 }),
    observeProcess: async () => {
      await observed;
      return { state: 'unknown' };
    },
    state,
  });
  const started = runner.start({
    ...target,
    id: 'run-gated-unknown',
    prompt: 'short',
    wallClockMs: 1000,
  });
  await Promise.resolve();
  releaseObserve();
  await expect(started).resolves.toMatchObject({
    code: 'RUN_PROCESS_UNKNOWN',
    id: 'run-gated-unknown',
    ok: false,
    state: 'unknown',
  });
  await runner.wait('run-gated-unknown');
  expect(state.read('headlessRuns').runs['run-gated-unknown'].state).toBe(
    'unknown'
  );
});

test('an input write failure retains the launched child for monitored unknown cleanup', async () => {
  const { state } = fixture();
  let released = 0;
  const child = Bun.spawn(
    [
      process.execPath,
      '-e',
      "process.stdout.write('still drained'); setTimeout(() => process.exit(0), 20)",
    ],
    { stderr: 'pipe', stdout: 'pipe' }
  );
  children.push(child);
  const runner = createHeadlessRun({
    admit: async () => ({ lease: { id: 'lease' }, ok: true }),
    launch: () => ({
      exited: child.exited,
      pid: child.pid,
      stderr: child.stderr,
      stdout: child.stdout,
      writeInput() {
        throw new Error('fixture stdin write failed');
      },
    }),
    observeProcess: async (pid) => ({
      processId: pid,
      processStartIdentity: `start-${pid}`,
      state: 'alive',
    }),
    release: async () => {
      released += 1;
    },
    state,
  });
  await expect(
    runner.start({
      ...target,
      id: 'run-input-failed',
      prompt: 'short',
      wallClockMs: 1000,
    })
  ).resolves.toMatchObject({
    code: 'RUN_INPUT_FAILED',
    id: 'run-input-failed',
    ok: false,
    state: 'unknown',
  });
  await runner.wait('run-input-failed');
  expect(runner.getLog('run-input-failed').text).toContain('still drained');
  expect(state.read('headlessRuns').runs['run-input-failed'].state).toBe(
    'unknown'
  );
  expect(released).toBe(1);
});

test('a signal failure after cancelling marks the run unknown without a second signal', async () => {
  const { state } = fixture();
  const child = Bun.spawn([
    process.execPath,
    '-e',
    'setInterval(() => {}, 1000)',
  ]);
  children.push(child);
  let calls = 0;
  const runner = createHeadlessRun({
    admit: async () => ({ ok: true }),
    launch: () => child,
    observeProcess: async (pid) => ({
      processId: pid,
      processStartIdentity: `start-${pid}`,
      state: 'alive',
    }),
    signal: () => {
      calls += 1;
      throw new Error('fixture signal failed');
    },
    state,
  });
  await runner.start({
    ...target,
    id: 'run-signal-failed',
    prompt: 'wait',
    wallClockMs: 1000,
  });
  await expect(
    runner.cancel({
      checkoutIdentity: target.checkoutIdentity,
      id: 'run-signal-failed',
    })
  ).resolves.toMatchObject({ code: 'RUN_PROCESS_UNKNOWN', ok: false });
  expect(calls).toBe(1);
  expect(state.read('headlessRuns').runs['run-signal-failed'].state).toBe(
    'unknown'
  );
});

test('does not launch when the checkout changes while acquiring the target lock', async () => {
  const { state } = fixture();
  let launches = 0,
    releases = 0;
  const runner = createHeadlessRun({
    admit: async () => ({ lease: { id: 'lease' }, ok: true }),
    launch: () => {
      launches += 1;
    },
    release: async () => {
      releases += 1;
    },
    state,
    withTargetLock: async (_input, work) =>
      work({ ...target, checkoutIdentity: { head: 'replaced' } }),
  });
  await expect(
    runner.start({ ...target, id: 'run-replaced', prompt: 'do not launch' })
  ).resolves.toMatchObject({
    code: 'CHECKOUT_REPLACED',
    id: 'run-replaced',
    ok: false,
    state: 'failed',
  });
  expect(launches).toBe(0);
  expect(releases).toBe(1);
});

test('keeps a returned child tracked when target-lock release fails after launch', async () => {
  const { state } = fixture();
  const { child, exit } = deferredChild(4243);
  let releases = 0;
  const runner = createHeadlessRun({
    admit: async () => ({ lease: { id: 'lease' }, ok: true }),
    launch: () => child,
    observeGroup: async () => 'absent',
    observeProcess: async (pid) => ({
      processId: pid,
      processStartIdentity: `start-${pid}`,
      state: 'alive',
    }),
    release: async () => {
      releases += 1;
    },
    state,
    withTargetLock: async (_input, work) => {
      await work(target);
      throw new Error('fixture lock release failed');
    },
  });
  await expect(
    runner.start({ ...target, id: 'run-lock-release', prompt: 'track child' })
  ).resolves.toMatchObject({
    code: 'RUN_PROCESS_UNKNOWN',
    id: 'run-lock-release',
    ok: false,
    state: 'unknown',
  });
  expect(state.read('headlessRuns').runs['run-lock-release'].state).toBe(
    'unknown'
  );
  expect(releases).toBe(0);
  const completion = runner.wait('run-lock-release');
  exit();
  await completion;
  expect(state.read('headlessRuns').runs['run-lock-release'].state).toBe(
    'unknown'
  );
  expect(releases).toBe(1);
});

test('monitors a child with malformed ownership metadata without certifying the launch', async () => {
  const { state } = fixture();
  const { child, exit } = deferredChild(4244, { ownedGroup: 'unknown' });
  let releases = 0;
  const runner = createHeadlessRun({
    admit: async () => ({ lease: { id: 'lease' }, ok: true }),
    launch: () => child,
    observeProcess: async (pid) => ({
      processId: pid,
      processStartIdentity: `start-${pid}`,
      state: 'alive',
    }),
    release: async () => {
      releases += 1;
    },
    state,
  });
  await expect(
    runner.start({
      ...target,
      id: 'run-malformed-owner',
      prompt: 'track child',
    })
  ).resolves.toMatchObject({
    code: 'RUN_PROCESS_UNKNOWN',
    id: 'run-malformed-owner',
    ok: false,
    state: 'unknown',
  });
  const completion = runner.wait('run-malformed-owner');
  exit();
  await completion;
  expect(state.read('headlessRuns').runs['run-malformed-owner'].state).toBe(
    'unknown'
  );
  expect(releases).toBe(1);
});

test('retains an uncertain thrown launch with its returned child handle', async () => {
  const { state } = fixture();
  const { child, exit } = deferredChild(4245);
  let releases = 0;
  const runner = createHeadlessRun({
    admit: async () => ({ lease: { id: 'lease' }, ok: true }),
    launch: () => {
      throw Object.assign(new Error('spawn outcome unknown'), {
        child,
        launchAttempt: 'uncertain',
      });
    },
    observeGroup: async () => 'absent',
    observeProcess: async (pid) => ({
      processId: pid,
      processStartIdentity: `start-${pid}`,
      state: 'alive',
    }),
    release: async () => {
      releases += 1;
    },
    state,
  });
  await expect(
    runner.start({
      ...target,
      id: 'run-uncertain-launch',
      prompt: 'track child',
    })
  ).resolves.toMatchObject({
    code: 'RUN_PROCESS_UNKNOWN',
    id: 'run-uncertain-launch',
    ok: false,
    state: 'unknown',
  });
  expect(releases).toBe(0);
  const completion = runner.wait('run-uncertain-launch');
  exit();
  await completion;
  expect(releases).toBe(1);
});

test('keeps monitoring a launched child after its identity journal write fails', async () => {
  const { state } = fixture();
  const { child, exit } = deferredChild(4246);
  let updates = 0,
    releases = 0;
  const runner = createHeadlessRun({
    admit: async () => ({ lease: { id: 'lease' }, ok: true }),
    launch: () => child,
    observeGroup: async () => 'absent',
    observeProcess: async (pid) => ({
      processId: pid,
      processStartIdentity: `start-${pid}`,
      state: 'alive',
    }),
    release: async () => {
      releases += 1;
    },
    state: {
      ...state,
      update(...args) {
        updates += 1;
        if (updates === 2) {
          throw new Error('fixture journal write failed');
        }
        return state.update(...args);
      },
    },
  });
  await expect(
    runner.start({
      ...target,
      id: 'run-journal-after-launch',
      prompt: 'track child',
    })
  ).resolves.toMatchObject({
    code: 'STATE_WRITE_FAILED',
    id: 'run-journal-after-launch',
    ok: false,
    state: 'unknown',
  });
  const completion = runner.wait('run-journal-after-launch');
  exit();
  await completion;
  expect(
    state.read('headlessRuns').runs['run-journal-after-launch'].state
  ).toBe('unknown');
  expect(releases).toBe(1);
});

test('reports an explicit prelaunch refusal despite failed outcome persistence and release', async () => {
  const { state } = fixture();
  let updates = 0,
    releases = 0;
  const runner = createHeadlessRun({
    admit: async () => ({ lease: { id: 'lease' }, ok: true }),
    launch: () => {
      throw Object.assign(new Error('spawn refused'), {
        launchAttempt: 'prelaunch',
      });
    },
    release: async () => {
      releases += 1;
      throw new Error('fixture release failed');
    },
    state: {
      ...state,
      update(...args) {
        updates += 1;
        if (updates === 2) {
          throw new Error('fixture failed outcome write');
        }
        return state.update(...args);
      },
    },
  });
  await expect(
    runner.start({ ...target, id: 'run-prelaunch-refused', prompt: 'refused' })
  ).resolves.toMatchObject({
    code: 'RUN_LAUNCH_FAILED',
    id: 'run-prelaunch-refused',
    leaseRetained: true,
    ok: false,
    recovery: {
      release: 'ADMISSION_RELEASE_UNAVAILABLE',
      state: 'unavailable',
    },
    state: 'failed',
  });
  expect(releases).toBe(1);
  expect(state.read('headlessRuns').runs['run-prelaunch-refused'].state).toBe(
    'starting'
  );
});
