import { afterEach, expect, test } from 'bun:test';
import fs, { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createManagedAgentServices } from './managed-agent-services.js';
import { createOperationEvents } from './operation-events.js';
import { createWorkspaceState } from './workspace-state.js';

const roots = [];
const start = 'Mon Oct 5 12:00:00 2026';
const uuid = 'A1B2C3D4-E5F6-4A1B-8C2D-1234567890AB';

function permissionMode(mode) {
  return mode % 0o1000;
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { force: true, recursive: true });
  }
});

function deferred() {
  let resolve;
  return {
    promise: new Promise((done) => {
      resolve = done;
    }),
    resolve,
  };
}

function fixture({
  fallback = false,
  register = true,
  events,
  privateFiles,
  admission: admissionOverride,
  beforeAdmit,
  stateUpdate,
  withTargets,
  nativeAvailability,
  findChildren,
  observeProcess,
} = {}) {
  const root = mkdtempSync(join(tmpdir(), 'setu-managed-agent-'));
  roots.push(root);
  const state = createWorkspaceState({
    configPath: join(root, 'config.json'),
    setuDir: root,
    workspaceRoot: root,
  });
  const identity = { head: 'abc', tree: 'clean' };
  let active = true;
  const leases = new Map();
  const releases = [];
  const native = [];
  const scripts = [];
  const target = {
    checkoutIdentity: identity,
    name: 'topic',
    repo: 'repo',
    wtDir: join(root, 'worktree'),
  };
  fs.mkdirSync(target.wtDir);
  const runDone = deferred();
  let tick;
  let monitorCalls = 0;
  const serviceState =
    stateUpdate || withTargets
      ? {
          read: state.read,
          update: stateUpdate
            ? async (document, work) => stateUpdate({ document, state, work })
            : state.update,
          withTargets: withTargets
            ? (targets, work) => withTargets({ state, target, targets, work })
            : state.withTargets,
        }
      : state;
  const admission = {
    admit: async ({ operationId, ...rest }) => {
      await beforeAdmit?.({ operationId, target });
      const lease = {
        acquiredAt: 1,
        kind: rest.kind,
        operationId,
        owner: { pid: 1, processStart: start },
        target: rest.target,
      };
      leases.set(operationId, lease);
      return { lease, ok: true };
    },
    release: (lease) => {
      try {
        releases.push(lease.operationId);
        leases.delete(lease.operationId);
        return Promise.resolve({ ok: true });
      } catch (error) {
        return Promise.reject(error);
      }
    },
  };
  const service = createManagedAgentServices({
    admission: admissionOverride
      ? { ...admission, ...admissionOverride }
      : admission,
    clearInterval() {
      /* fixture timer cleanup */
    },
    findChildren:
      findChildren ?? (async () => ({ children: [], state: 'owned' })),
    headless: {
      clearTimeout() {
        /* fixture timer cleanup */
      },
      id: () => 'run-1',
      launch: () => ({
        exited: runDone.promise,
        ownedGroup: false,
        pid: 333,
        signalCode: null,
        writeInput() {
          /* fixture child has no input channel */
        },
      }),
      now: () => 1,
      setTimeout: () => 1,
    },
    id: (() => {
      let n = 0;
      return () => {
        const current = n;
        n += 1;
        return current ? `run-${n}` : 'session-1';
      };
    })(),
    // biome-ignore lint/suspicious/useAwait: Launcher failures must reject through the asynchronous service contract.
    launchNative: async (command) => {
      native.push(command);
      if (nativeAvailability) {
        return { availability: nativeAvailability, stdout: '' };
      }
      if (fallback) {
        return { availability: 'unavailable', stdout: '' };
      }
      if (register) {
        const token = command.args.at(-1);
        writeFileSync(
          join(dirname(command.args.at(-3)), 'registration.json'),
          JSON.stringify({
            id: 'session-1',
            launchToken: token,
            pid: 222,
            processStart: start,
          })
        );
      }
      return { availability: 'available', stdout: `SETU:LAUNCHED:${uuid}` };
    },
    // biome-ignore lint/suspicious/useAwait: Registration write failures must reject through the asynchronous launcher contract.
    launchOpen: async (launch) => {
      if (fallback && register) {
        writeFileSync(
          launch.registration.path,
          JSON.stringify({
            id: 'session-1',
            launchToken: 'token_1234567890123456',
            pid: 222,
            processStart: start,
          })
        );
      }
      return { ok: true };
    },
    observeProcess:
      observeProcess ??
      ((pid) => {
        if (pid === 222 && active) {
          return Promise.resolve({
            processId: 222,
            processStartIdentity: start,
            state: 'alive',
          });
        }
        if (pid === 333) {
          return Promise.resolve({
            processId: 333,
            processStartIdentity: start,
            state: 'alive',
          });
        }
        return Promise.resolve({ state: 'absent' });
      }),
    operationEvents:
      events ?? createOperationEvents({ now: () => 1, state: serviceState }),
    privateFiles,
    registrationAttempts: 1,
    resolveTarget: async ({ repo, name }) =>
      repo === target.repo && name === target.name ? { ...target } : null,
    // biome-ignore lint/suspicious/useAwait: The fixture preserves the native runner promise boundary.
    runAppleScript: async (command) => {
      scripts.push(command);
      return { availability: 'available', stdout: `SETU:OK:${uuid}` };
    },
    runtimeDir: root,
    setInterval: (callback) => {
      monitorCalls += 1;
      tick = callback;
      return monitorCalls;
    },
    signal: () => {
      active = false;
      return Promise.resolve();
    },
    state: serviceState,
    token: () => 'token_1234567890123456',
  });
  return {
    active: () => active,
    identity,
    leases,
    monitorCalls: () => monitorCalls,
    native,
    releases,
    root,
    runDone,
    scripts,
    service,
    setActive: (value) => {
      active = value;
    },
    state,
    target,
    tick: () => tick?.(),
  };
}

test('the public session listing shows when the session was last heard from by an authenticated hook, and only then', async () => {
  const f = fixture();
  await f.service.open({ name: 'topic', repo: 'repo', tool: 'claude' });
  const hook = (event, launchToken) =>
    f.service.receiveHook({
      launchToken,
      payload: {
        cwd: f.target.wtDir,
        hook_event_name: event,
        session_id: 'native-1',
      },
      provider: 'claude-code',
    });
  const listed = async () =>
    (await f.service.listSessions({ name: 'topic', repo: 'repo' })).sessions[0];

  await hook('SessionStart', 'token_1234567890123456');
  expect((await listed()).lastHookAt).toBeUndefined();
  await hook('Stop', undefined);
  await hook('Stop', 'wrong_1234567890123456');
  expect((await listed()).lastHookAt).toBeUndefined();

  await hook('Stop', 'token_1234567890123456');
  const session = await listed();
  expect(Number.isFinite(session.lastHookAt)).toBe(true);
  const text = JSON.stringify(session);
  expect(text).not.toContain('token_1234567890123456');
  expect(text).not.toContain('launchProofDigest');
});

test('composes a token-bound Ghostty launch, trusted Claude hook and exact existing terminal actions', async () => {
  const f = fixture();
  const opened = await f.service.open({
    name: 'topic',
    repo: 'repo',
    tool: 'claude',
  });
  expect(opened).toMatchObject({
    capability: { exactTerminal: true, trustedHooks: true },
    ok: true,
    session: { id: 'session-1', terminal: { id: uuid } },
  });
  expect(f.native).toHaveLength(1);
  const runtime = fs
    .readdirSync(f.root)
    .find((name) => name.startsWith('setu-agent-session-1-'));
  const hook = fs.readFileSync(join(f.root, runtime, 'claude-hook.js'), 'utf8');
  const launcher = fs.readFileSync(join(f.root, runtime, 'launch.zsh'), 'utf8');
  expect(launcher.startsWith('#!/bin/zsh -i\n')).toBe(true);
  expect(launcher).toContain(
    "export SETU_SESSION_TOKEN='token_1234567890123456'"
  );
  // Non-prompt events keep their one-second, fire-and-forget request.
  expect(hook).toContain('AbortSignal.timeout(ms)');
  expect(hook).toContain('payload}, 1000);');
  expect(
    permissionMode(fs.statSync(join(f.root, runtime, 'launch.zsh')).mode)
  ).toBe(0o700);
  expect(
    permissionMode(fs.statSync(join(f.root, runtime, 'registration.json')).mode)
  ).toBe(0o600);

  await expect(
    f.service.receiveHook({
      launchToken: 'token_1234567890123456',
      payload: {
        cwd: f.target.wtDir,
        hook_event_name: 'SessionStart',
        session_id: 'native-1',
      },
      provider: 'claude-code',
    })
  ).resolves.toEqual({ ok: true, sessionId: 'session-1' });
  // A native id and cwd alone only locate a session; they never resolve it.
  await expect(
    f.service.receiveHook({
      payload: {
        cwd: f.target.wtDir,
        hook_event_name: 'Stop',
        session_id: 'native-1',
      },
      provider: 'claude-code',
    })
  ).resolves.toMatchObject({
    attention: { state: 'unknown' },
    ok: true,
    reason: 'launch-proof-missing',
  });
  await expect(
    f.service.receiveHook({
      launchToken: 'token_1234567890123456',
      payload: {
        cwd: f.target.wtDir,
        hook_event_name: 'Stop',
        session_id: 'native-1',
      },
      provider: 'claude-code',
    })
  ).resolves.toMatchObject({
    attention: { sessionId: 'session-1', state: 'between-turns' },
    ok: true,
  });
  expect(JSON.stringify(f.state.read('attention'))).not.toContain('native-1');

  await expect(
    f.service.focus({
      checkoutIdentity: { head: 'abc', tree: 'clean' },
      name: 'topic',
      repo: 'repo',
      sessionId: 'session-1',
    })
  ).resolves.toMatchObject({ ok: true });
  await expect(
    f.service.handoff({
      artifact: { checkoutIdentity: f.identity, headSha: 'abc', prNumber: 1 },
      checkoutIdentity: { head: 'abc', tree: 'clean' },
      findings: [{ context: 'fix it', id: 'one' }],
      name: 'topic',
      repo: 'repo',
      sessionId: 'session-1',
    })
  ).resolves.toMatchObject({ ok: true });
  expect(f.native).toHaveLength(1);
  expect(f.scripts[1].script).toContain('input text');
  expect(f.scripts[1].script).not.toContain('key code');
});

test('unknown registration retains admission and never treats a Ghostty window as coding start', async () => {
  const f = fixture({ register: false });
  await expect(
    f.service.open({ name: 'topic', repo: 'repo' })
  ).resolves.toMatchObject({ code: 'SESSION_REGISTRATION_UNKNOWN', ok: false });
  expect(f.releases).toEqual([]);
  expect(f.state.read('agentSessions').sessions['session-1']).toMatchObject({
    ownership: 'unknown',
    state: 'unknown',
  });
  expect(
    f.state.read('agentSessions').managedLeases['session-1']
  ).toBeDefined();
});

test('Codex launches with a verified process but never claims trusted hook binding', async () => {
  const f = fixture();
  await expect(
    f.service.open({ name: 'topic', repo: 'repo', tool: 'codex' })
  ).resolves.toMatchObject({
    capability: { exactTerminal: true, trustedHooks: false },
    ok: true,
  });
  expect(f.leases.size).toBe(1);
  expect(f.native).toHaveLength(1);
});

test('open-na fallback can register a coding process but leaves exact focus and handoff unsupported', async () => {
  const f = fixture({ fallback: true });
  await expect(
    f.service.open({ name: 'topic', repo: 'repo' })
  ).resolves.toMatchObject({
    capability: { exactTerminal: false, trustedHooks: true },
    ok: true,
  });
  await expect(
    f.service.focus({
      checkoutIdentity: f.identity,
      name: 'topic',
      repo: 'repo',
      sessionId: 'session-1',
    })
  ).resolves.toMatchObject({ code: 'GHOSTTY_TERMINAL_UNAVAILABLE', ok: false });
  expect(f.native).toHaveLength(1);
});

test('wrong targets refuse exact actions and a proven session end releases its own lease', async () => {
  const f = fixture();
  await f.service.open({ name: 'topic', repo: 'repo' });
  f.target.checkoutIdentity = { head: 'replaced' };
  await expect(
    f.service.focus({
      checkoutIdentity: f.identity,
      name: 'topic',
      repo: 'repo',
      sessionId: 'session-1',
    })
  ).resolves.toMatchObject({ code: 'TARGET_CHANGED', ok: false });
  f.target.checkoutIdentity = f.identity;
  await expect(
    f.service.endSession({
      checkoutIdentity: f.identity,
      name: 'topic',
      repo: 'repo',
      sessionId: 'session-1',
    })
  ).resolves.toMatchObject({ ok: true, session: { state: 'ended' } });
  expect(f.releases).toEqual(['session-1']);
});

test('reviewed identity must match the durable and freshly resolved checkout regardless of key order', async () => {
  const f = fixture();
  await f.service.open({ name: 'topic', repo: 'repo' });
  await expect(
    f.service.focus({
      checkoutIdentity: { head: 'wrong', tree: 'clean' },
      name: 'topic',
      repo: 'repo',
      sessionId: 'session-1',
    })
  ).resolves.toMatchObject({ code: 'TARGET_CHANGED', ok: false });
  await expect(
    f.service.focus({
      checkoutIdentity: { head: 'abc', tree: 'clean' },
      name: 'topic',
      repo: 'repo',
      sessionId: 'session-1',
    })
  ).resolves.toMatchObject({ ok: true });
});

test('owned monitor records natural exit and releases only after descendants are proven absent', async () => {
  const f = fixture();
  await f.service.open({ name: 'topic', repo: 'repo' });
  f.setActive(false);
  f.tick();
  await Bun.sleep(0);
  expect(f.state.read('agentSessions').sessions['session-1']).toMatchObject({
    state: 'ended',
  });
  expect(f.releases).toEqual(['session-1']);
});

test('lists are read-only and cancel refuses a run after checkout replacement', async () => {
  const f = fixture();
  await f.service.open({ name: 'topic', repo: 'repo' });
  await f.service.startRun({
    id: 'run-1',
    name: 'topic',
    prompt: 'private prompt',
    repo: 'repo',
  });
  const before = f.native.length;
  await expect(f.service.listSessions()).resolves.toMatchObject({ ok: true });
  await expect(f.service.listAttention()).resolves.toMatchObject({ ok: true });
  await expect(f.service.listRuns()).resolves.toMatchObject({ ok: true });
  expect(f.native).toHaveLength(before);
  f.target.checkoutIdentity = { head: 'replaced' };
  await expect(
    f.service.cancelRun({
      checkoutIdentity: f.identity,
      name: 'topic',
      repo: 'repo',
      runId: 'run-1',
    })
  ).resolves.toMatchObject({ code: 'TARGET_CHANGED', ok: false });
  f.runDone.resolve(0);
});

test('headless listing refuses a malformed journal without rewriting its bytes', async () => {
  const f = fixture();
  const path = join(f.root, '.setu-headless-runs.json');
  writeFileSync(path, '{\n  "runs": []\n}\n');
  const before = fs.readFileSync(path, 'utf8');
  await expect(f.service.listRuns()).resolves.toMatchObject({
    code: 'HEADLESS_RUN_JOURNAL_INVALID',
    ok: false,
  });
  expect(fs.readFileSync(path, 'utf8')).toBe(before);
});

test('headless start records running, then only records completion after its owned process completes', async () => {
  const f = fixture();
  const started = await f.service.startRun({
    id: 'run-1',
    name: 'topic',
    prompt: 'private prompt',
    repo: 'repo',
    source: 'cli',
  });
  expect(started).toMatchObject({ id: 'run-1', ok: true, state: 'running' });
  expect(f.state.read('operationEvents').events).toEqual([
    expect.objectContaining({ id: 'headless-run-1', state: 'running' }),
  ]);
  expect(JSON.stringify(f.state.read('headlessRuns'))).not.toContain(
    'private prompt'
  );
  f.runDone.resolve(0);
  await Bun.sleep(0);
  await Bun.sleep(0);
  expect(f.state.read('headlessRuns').runs['run-1'].state).toBe('completed');
  expect(f.state.read('operationEvents').events).toEqual([
    expect.objectContaining({
      id: 'headless-run-1',
      source: 'cli',
      state: 'completed',
    }),
  ]);
  expect(f.releases).toEqual(['run-1']);
});

test('a refused event write is surfaced without masking a valid MCP headless start', async () => {
  const f = fixture({
    events: {
      record: async () => ({
        code: 'OPERATION_EVENT_UNAVAILABLE',
        error: 'read-only fixture',
        ok: false,
      }),
    },
  });
  await expect(
    f.service.startRun({
      id: 'run-1',
      name: 'topic',
      prompt: 'private prompt',
      repo: 'repo',
      source: 'mcp',
    })
  ).resolves.toMatchObject({
    ok: true,
    operationId: 'headless-run-1',
    recording: { ok: false },
  });
  f.runDone.resolve(0);
});

test('definitely prelaunch file and starting-record failures have a terminal result, operation id, and one release attempt', async () => {
  const createFailure = fixture({
    privateFiles: {
      create: () => Promise.reject(new Error('no private directory')),
    },
  });
  const files = await createFailure.service.open({
    name: 'topic',
    repo: 'repo',
    source: 'cli',
  });
  expect(files).toMatchObject({
    code: 'SESSION_FILES_FAILED',
    ok: false,
    operationId: 'session-session-1',
  });
  expect(createFailure.releases).toEqual(['session-1']);
  expect(createFailure.state.read('operationEvents').events).toEqual([
    expect.objectContaining({
      id: 'session-session-1',
      source: 'cli',
      state: 'failed',
    }),
  ]);

  let updates = 0;
  const registerFailure = fixture({
    // biome-ignore lint/suspicious/useAwait: Injected persistence failures must reject rather than throw synchronously.
    stateUpdate: async ({ document, state, work }) => {
      if (document === 'agentSessions') {
        const currentUpdate = updates;
        updates += 1;
        if (currentUpdate === 0) {
          throw new Error('disk refused');
        }
      }
      return state.update(document, work);
    },
  });
  const starting = await registerFailure.service.open({
    name: 'topic',
    repo: 'repo',
  });
  expect(starting).toMatchObject({
    code: 'SESSION_START_WRITE_FAILED',
    ok: false,
    operationId: 'session-session-1',
  });
  expect(registerFailure.releases).toEqual(['session-1']);
  expect(registerFailure.native).toHaveLength(0);
});

test('lease persistence and release failures preserve the original prelaunch classification without duplicate release', async () => {
  let agentUpdates = 0;
  const leaseFailure = fixture({
    // biome-ignore lint/suspicious/useAwait: Injected persistence failures must reject rather than throw synchronously.
    stateUpdate: async ({ document, state, work }) => {
      if (document === 'agentSessions') {
        agentUpdates += 1;
        if (agentUpdates === 2) {
          throw new Error('lease write refused');
        }
      }
      return state.update(document, work);
    },
  });
  await expect(
    leaseFailure.service.open({ name: 'topic', repo: 'repo' })
  ).resolves.toMatchObject({
    code: 'SESSION_LEASE_WRITE_FAILED',
    ok: false,
    operationId: 'session-session-1',
  });
  expect(leaseFailure.releases).toEqual(['session-1']);
  expect(leaseFailure.native).toHaveLength(0);

  const releaseFailure = fixture({
    admission: {
      release: async (lease) => ({ code: 'RELEASE_REFUSED', lease, ok: false }),
    },
    privateFiles: {
      create: () => Promise.reject(new Error('no files')),
    },
  });
  await expect(
    releaseFailure.service.open({ name: 'topic', repo: 'repo' })
  ).resolves.toMatchObject({
    code: 'SESSION_FILES_FAILED',
    leaseRetained: true,
    ok: false,
    operationId: 'session-session-1',
  });
});

test('post-launch unknown outcomes retain ownership, have an operation id, and recover monitoring', async () => {
  const f = fixture({ nativeAvailability: 'unknown' });
  await expect(
    f.service.open({ name: 'topic', repo: 'repo', source: 'mcp' })
  ).resolves.toMatchObject({
    code: 'TERMINAL_LAUNCH_UNKNOWN',
    leaseRetained: true,
    ok: false,
    operationId: 'session-session-1',
  });
  expect(f.releases).toEqual([]);
  expect(f.state.read('operationEvents').events).toEqual([
    expect.objectContaining({
      id: 'session-session-1',
      source: 'mcp',
      state: 'unknown',
    }),
  ]);
  expect(f.monitorCalls()).toBe(1);
  await f.service.dispose();
  await f.service.recover();
  expect(f.monitorCalls()).toBe(2);
});

test('pre-admission target replacement is refused inside the target lock without native launch', async () => {
  const f = fixture({
    // biome-ignore lint/suspicious/useAwait: The admission hook preserves its promise boundary around target mutation.
    beforeAdmit: async ({ target }) => {
      target.checkoutIdentity = { head: 'changed', tree: 'clean' };
    },
  });
  await expect(
    f.service.open({ name: 'topic', repo: 'repo' })
  ).resolves.toMatchObject({
    code: 'TARGET_CHANGED',
    ok: false,
    operationId: 'session-session-1',
  });
  expect(f.native).toHaveLength(0);
  expect(f.releases).toEqual(['session-1']);
});

test('focus records each invocation with a distinct operation id, including event failure metadata', async () => {
  const f = fixture({
    events: {
      record: async () => ({
        code: 'OPERATION_EVENT_UNAVAILABLE',
        error: 'readonly',
        ok: false,
      }),
    },
  });
  await f.service.open({ name: 'topic', repo: 'repo' });
  const first = await f.service.focus({
    checkoutIdentity: f.identity,
    name: 'topic',
    repo: 'repo',
    sessionId: 'session-1',
  });
  const second = await f.service.focus({
    checkoutIdentity: f.identity,
    name: 'topic',
    repo: 'repo',
    sessionId: 'session-1',
  });
  expect(first).toMatchObject({ ok: true, recording: { ok: false } });
  expect(second).toMatchObject({ ok: true, recording: { ok: false } });
  expect(first.operationId).not.toBe(second.operationId);
});

test('end surfaces an event-write failure without changing its observed completion', async () => {
  let unavailable = true,
    recorder;
  const f = fixture({
    events: {
      record: async (event) =>
        // biome-ignore lint/suspicious/noUnnecessaryConditions: The test changes this captured flag between service calls.
        unavailable
          ? {
              code: 'OPERATION_EVENT_UNAVAILABLE',
              error: 'readonly',
              ok: false,
            }
          : recorder.record(event),
    },
  });
  recorder = createOperationEvents({ now: () => 1, state: f.state });
  await f.service.open({ name: 'topic', repo: 'repo', source: 'mcp' });
  await expect(
    f.service.endSession({
      checkoutIdentity: f.identity,
      name: 'topic',
      repo: 'repo',
      sessionId: 'session-1',
      source: 'portal',
    })
  ).resolves.toMatchObject({
    ok: true,
    operationId: 'session-session-1',
    recording: { ok: false },
    session: { state: 'ended' },
  });
  expect(f.releases).toEqual(['session-1']);
  expect(
    f.state.read('agentSessions').managedLeases['session-1'].pendingOutcome
      .source
  ).toBe('mcp');
  unavailable = false;
  await f.service.reconcileSessions();
  expect(f.releases).toEqual(['session-1']);
  expect(
    f.state.read('agentSessions').managedLeases['session-1']
  ).toBeUndefined();
  expect(f.state.read('operationEvents').events).toEqual([
    expect.objectContaining({ source: 'mcp', state: 'completed' }),
  ]);
});

test('malformed session journals return structured failures without normalizing bytes', async () => {
  const f = fixture();
  const path = join(f.root, '.setu-agent-sessions.json');
  writeFileSync(path, '{\n  "sessions": []\n}\n');
  const before = fs.readFileSync(path, 'utf8');
  await expect(f.service.listSessions()).resolves.toMatchObject({
    code: 'SESSION_STATE_CORRUPT',
    ok: false,
  });
  await expect(f.service.recover()).resolves.toMatchObject({
    ok: false,
    sessions: { code: 'SESSION_STATE_CORRUPT' },
  });
  expect(fs.readFileSync(path, 'utf8')).toBe(before);
});

test('a target-lock acquisition failure has a terminal failed operation and releases exactly once before launch', async () => {
  const f = fixture({
    withTargets: () => Promise.reject(new Error('lock unavailable')),
  });
  await expect(
    f.service.open({ name: 'topic', repo: 'repo' })
  ).resolves.toMatchObject({
    code: 'TARGET_LOCK_FAILED',
    ok: false,
    operationId: 'session-session-1',
  });
  expect(f.native).toHaveLength(0);
  expect(f.releases).toEqual(['session-1']);
});

test('a lock release error after native launch is unknown, never reclassified as acquisition failure', async () => {
  const f = fixture({
    withTargets: async ({ state, targets, work }) =>
      state.withTargets(targets, async () => {
        await work();
        throw new Error('unlock failed');
      }),
  });
  await expect(
    f.service.open({ name: 'topic', repo: 'repo' })
  ).resolves.toMatchObject({
    code: 'SESSION_LAUNCH_UNKNOWN',
    leaseRetained: true,
    ok: false,
    operationId: 'session-session-1',
  });
  expect(f.native).toHaveLength(1);
  expect(f.releases).toEqual([]);
});

test('a failed lease-forget keeps recovery evidence without masking a known file failure', async () => {
  let updates = 0;
  const privateFiles = {
    create: async () => ({
      hookPath: 'hook',
      launcherPath: 'launcher',
      registrationPath: 'registration',
      remove: () => Promise.resolve(),
      settingsPath: 'settings',
      write: () => Promise.reject(new Error('write refused')),
    }),
  };
  const f = fixture({
    privateFiles,
    // biome-ignore lint/suspicious/useAwait: Injected persistence failures must reject rather than throw synchronously.
    stateUpdate: async ({ document, state, work }) => {
      if (document === 'agentSessions') {
        updates += 1;
        if (updates === 4) {
          throw new Error('forget refused');
        }
      }
      return state.update(document, work);
    },
  });
  await expect(
    f.service.open({ name: 'topic', repo: 'repo' })
  ).resolves.toMatchObject({
    code: 'SESSION_FILES_FAILED',
    leaseRetained: true,
    ok: false,
    operationId: 'session-session-1',
  });
  expect(f.releases).toEqual(['session-1']);
  expect(
    f.state.read('agentSessions').managedLeases['session-1']
  ).toBeDefined();
  expect(f.state.read('agentSessions').sessions['session-1']).toMatchObject({
    state: 'ended',
  });
  await f.service.reconcileSessions();
  expect(f.releases).toEqual(['session-1']);
});

test('unknown descendants retain the lease and the original launch source survives a later lifecycle completion', async () => {
  const f = fixture({
    findChildren: async () => ({
      children: [{ pid: 444, processStart: start }],
      state: 'owned',
    }),
    observeProcess: async (pid) =>
      pid === 222 ? { state: 'absent' } : { state: 'unknown' },
  });
  // The initial registration needs a live root; this fixture represents the
  // post-launch observation boundary, so seed a valid running record first.
  await f.state.update('agentSessions', (document) => ({
    ...document,
    managedLeases: {
      'session-1': {
        lease: {
          acquiredAt: 1,
          kind: 'session',
          operationId: 'session-1',
          owner: { pid: 1, processStart: start },
          target: { name: 'topic', repo: 'repo' },
        },
        source: 'cli',
      },
    },
    sessions: {
      'session-1': {
        checkoutIdentity: f.identity,
        checkoutPath: f.target.wtDir,
        id: 'session-1',
        launchedAt: 1,
        name: 'topic',
        ownership: 'owned',
        pid: 222,
        processStart: start,
        repo: 'repo',
        state: 'running',
        terminal: { id: uuid, kind: 'ghostty' },
        tool: 'claude-code',
      },
    },
  }));
  await expect(f.service.reconcileSessions()).resolves.toMatchObject({
    ok: true,
  });
  expect(f.state.read('agentSessions').sessions['session-1']).toMatchObject({
    state: 'unknown',
  });
  expect(f.releases).toEqual([]);

  const normal = fixture();
  await normal.service.open({ name: 'topic', repo: 'repo', source: 'cli' });
  await normal.service.endSession({
    checkoutIdentity: normal.identity,
    name: 'topic',
    repo: 'repo',
    sessionId: 'session-1',
    source: 'portal',
  });
  expect(normal.state.read('operationEvents').events).toEqual([
    expect.objectContaining({
      id: 'session-session-1',
      source: 'cli',
      state: 'completed',
    }),
  ]);
});

test('an unknown session later records proven completion with its original source', async () => {
  let childrenUnknown = false,
    unavailable = false,
    recorder;
  const f = fixture({
    events: {
      record: async (event) =>
        // biome-ignore lint/suspicious/noUnnecessaryConditions: The test changes this captured flag between reconciliations.
        unavailable ? { ok: false } : recorder.record(event),
    },
    findChildren: async () =>
      // biome-ignore lint/suspicious/noUnnecessaryConditions: The test changes this captured flag between reconciliations.
      childrenUnknown ? { state: 'unknown' } : { children: [], state: 'owned' },
  });
  recorder = createOperationEvents({ now: () => 1, state: f.state });
  await f.service.open({ name: 'topic', repo: 'repo', source: 'cli' });
  f.setActive(false);
  childrenUnknown = true;
  unavailable = true;
  await f.service.reconcileSessions();
  expect(f.state.read('agentSessions').sessions['session-1'].state).toBe(
    'unknown'
  );
  expect(f.releases).toEqual([]);
  childrenUnknown = false;
  unavailable = false;
  await f.service.reconcileSessions();
  expect(f.state.read('operationEvents').events).toEqual([
    expect.objectContaining({ source: 'cli', state: 'completed' }),
  ]);
  expect(f.releases).toEqual(['session-1']);
});

test('lock cleanup cannot mask an already-known prelaunch refusal or terminal delivery', async () => {
  const unlockFailure = async ({ state, targets, work }) =>
    state.withTargets(targets, async () => {
      await work();
      throw new Error('unlock failed');
    });
  const refused = fixture({
    privateFiles: {
      create: () => Promise.reject(new Error('no files')),
    },
    withTargets: unlockFailure,
  });
  await expect(
    refused.service.open({ name: 'topic', repo: 'repo' })
  ).resolves.toMatchObject({
    cleanup: { targetLockRelease: 'unavailable' },
    code: 'SESSION_FILES_FAILED',
    operationId: 'session-session-1',
  });
  expect(refused.releases).toEqual(['session-1']);
  let failUnlock = false;
  const f = fixture({
    withTargets: async (input) =>
      // biome-ignore lint/suspicious/noUnnecessaryConditions: The test enables this captured failure after opening the session.
      failUnlock
        ? unlockFailure(input)
        : input.state.withTargets(input.targets, input.work),
  });
  await f.service.open({ name: 'topic', repo: 'repo' });
  failUnlock = true;
  await expect(
    f.service.focus({
      checkoutIdentity: f.identity,
      name: 'topic',
      repo: 'repo',
      sessionId: 'session-1',
    })
  ).resolves.toMatchObject({
    ok: true,
    recovery: { targetLockRelease: 'unavailable' },
  });
  expect(f.scripts).toHaveLength(1);
  expect(
    f.state
      .read('operationEvents')
      .events.find((event) => event.kind === 'terminal-focus')?.state
  ).toBe('completed');
});

test('target replacement inside the shared lock refuses focus, handoff, end and cancel before their effects', async () => {
  let replaceInside = false;
  const f = fixture({
    withTargets: async ({ state, target, targets, work }) =>
      // biome-ignore lint/suspicious/useAwait: Work failures must reject through the target-lock callback contract.
      state.withTargets(targets, async () => {
        // biome-ignore lint/suspicious/noUnnecessaryConditions: The test enables replacement after the initial open and run.
        if (replaceInside) {
          target.checkoutIdentity = { head: 'replaced', tree: 'clean' };
        }
        return work();
      }),
  });
  await f.service.open({ name: 'topic', repo: 'repo' });
  await f.service.startRun({
    id: 'run-1',
    name: 'topic',
    prompt: 'private',
    repo: 'repo',
  });
  replaceInside = true;
  await expect(
    f.service.focus({
      checkoutIdentity: f.identity,
      name: 'topic',
      repo: 'repo',
      sessionId: 'session-1',
    })
  ).resolves.toMatchObject({ code: 'TARGET_CHANGED', ok: false });
  await expect(
    f.service.handoff({
      artifact: { checkoutIdentity: f.identity, headSha: 'abc', prNumber: 1 },
      checkoutIdentity: f.identity,
      findings: [{ context: 'fix', id: 'one' }],
      name: 'topic',
      repo: 'repo',
      sessionId: 'session-1',
    })
  ).resolves.toMatchObject({ code: 'TARGET_CHANGED', ok: false });
  await expect(
    f.service.endSession({
      checkoutIdentity: f.identity,
      name: 'topic',
      repo: 'repo',
      sessionId: 'session-1',
    })
  ).resolves.toMatchObject({ code: 'TARGET_CHANGED', ok: false });
  await expect(
    f.service.cancelRun({
      checkoutIdentity: f.identity,
      name: 'topic',
      repo: 'repo',
      runId: 'run-1',
    })
  ).resolves.toMatchObject({ code: 'TARGET_CHANGED', ok: false });
  expect(f.scripts).toHaveLength(0);
});
