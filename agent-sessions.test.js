import { afterEach, expect, test } from 'bun:test';
import { spawn } from 'node:child_process';
import fs, { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAgentSessions } from './agent-sessions.js';
import { observeProcessIdentity } from './process-observation.js';
import { createWorkspaceState } from './workspace-state.js';

const roots = [];
const processes = [];
afterEach(() => {
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { force: true, recursive: true });
  }
  for (const child of processes.splice(0)) {
    child.kill();
  }
});

function fixture({ children, identities } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'setu-agent-sessions-'));
  roots.push(root);
  const state = createWorkspaceState({
    configPath: join(root, 'config.json'),
    setuDir: root,
    workspaceRoot: root,
  });
  const signals = [];
  const sessions = createAgentSessions({
    findChildren: async () => children ?? { children: [], state: 'owned' },
    now: () => '2026-10-05T12:00:00.000Z',
    observeProcess: async (pid) => identities?.get(pid) ?? { state: 'absent' },
    signal: (pid, value) => signals.push([pid, value]),
    state,
  });
  return {
    agentSessionsPath: join(root, '.setu-agent-sessions.json'),
    configPath: join(root, 'config.json'),
    identities,
    sessions,
    signals,
    state,
  };
}

const checkoutIdentity = { head: 'abc123', known: true };
const launch = {
  checkoutIdentity,
  checkoutPath: '/work/repo/topic',
  id: 'session-1',
  name: 'topic',
  repo: 'repo',
  tool: 'codex',
};
const identity = (pid, processStart) => ({
  processId: pid,
  processStartIdentity: processStart,
  state: 'alive',
});

test('a launch without a registration remains durable but becomes unresolved on recovery', async () => {
  const f = fixture();
  await expect(f.sessions.register(launch)).resolves.toMatchObject({
    ok: true,
    session: { ownership: 'owned', state: 'starting' },
  });
  const recovered = createAgentSessions({
    now: () => '2026-10-05T12:01:00.000Z',
    observeProcess: async () => ({ state: 'absent' }),
    signal: () => {
      throw new Error('must not signal');
    },
    state: f.state,
  });
  await recovered.reconcile();
  expect(recovered.get('session-1')).toMatchObject({
    ownership: 'unknown',
    state: 'unknown',
  });
});

test('durable session records leave the user config document byte-for-byte unchanged', async () => {
  const f = fixture();
  fs.writeFileSync(f.configPath, '{\n  "theme": "dark"\n}\n');
  const before = fs.readFileSync(f.configPath, 'utf8');
  await f.sessions.register(launch);
  expect(fs.readFileSync(f.configPath, 'utf8')).toBe(before);
  expect(f.state.read('agentSessions')).toEqual({
    sessions: {
      'session-1': expect.objectContaining({
        id: 'session-1',
        state: 'starting',
      }),
    },
  });
});

test('a Ghostty UUID mapping is durable only when it is a stable UUID and cannot be replaced', async () => {
  const start = 'Mon Sep 21 10:10:00 2026';
  const f = fixture({ identities: new Map([[321, identity(321, start)]]) });
  const terminal = {
    id: 'A1B2C3D4-E5F6-4A1B-8C2D-1234567890AB',
    kind: 'ghostty',
  };
  await expect(
    f.sessions.register({ ...launch, pid: 321, processStart: start, terminal })
  ).resolves.toMatchObject({ ok: true, session: { terminal } });
  await expect(
    f.sessions.register({
      ...launch,
      pid: 321,
      processStart: start,
      terminal: { ...terminal, id: 'B1B2C3D4-E5F6-4A1B-8C2D-1234567890AB' },
    })
  ).resolves.toMatchObject({ code: 'SESSION_ID_CONFLICT', ok: false });
  await expect(
    f.sessions.register({
      ...launch,
      pid: 321,
      processStart: start,
      terminal: { id: '7', kind: 'ghostty' },
    })
  ).resolves.toMatchObject({ code: 'SESSION_INVALID', ok: false });
});

test('malformed session state is refused without rewriting its bytes', async () => {
  const f = fixture();
  fs.writeFileSync(f.agentSessionsPath, '{"sessions":[]}\n');
  const before = fs.readFileSync(f.agentSessionsPath, 'utf8');
  await expect(f.sessions.register(launch)).resolves.toMatchObject({
    code: 'SESSION_STATE_CORRUPT',
    ok: false,
  });
  expect(fs.readFileSync(f.agentSessionsPath, 'utf8')).toBe(before);
  expect(() => f.sessions.list()).toThrow('SESSION_STATE_CORRUPT');
});

test('a registered actual coding process survives a launcher-wrapper exit and persists through recreation', async () => {
  const start = 'Mon Sep 21 10:10:00 2026';
  const f = fixture({ identities: new Map([[321, identity(321, start)]]) });
  await f.sessions.register({ ...launch, pid: 321, processStart: start });
  const recovered = createAgentSessions({
    now: () => '2026-10-05T12:01:00.000Z',
    observeProcess: async (pid) => f.identities.get(pid),
    signal: () => {},
    state: f.state,
  });
  await recovered.reconcile();
  expect(recovered.list()).toEqual([
    expect.objectContaining({
      ownership: 'owned',
      pid: 321,
      processStart: start,
      state: 'running',
    }),
  ]);
});

test('pid reuse or an unreadable owner refuses every signal', async () => {
  const start = 'Mon Sep 21 10:10:00 2026';
  const identities = new Map([[321, identity(321, start)]]);
  const f = fixture({ identities });
  await f.sessions.register({ ...launch, pid: 321, processStart: start });
  identities.set(321, identity(321, 'Mon Sep 21 10:11:00 2026'));
  await expect(
    f.sessions.end('session-1', { checkoutIdentity })
  ).resolves.toMatchObject({
    code: 'SESSION_PROCESS_IDENTITY_CHANGED',
    ok: false,
  });
  expect(f.signals).toEqual([]);
  expect(f.sessions.get('session-1')).toMatchObject({
    ownership: 'unknown',
    state: 'unknown',
  });
});

test('ending signals only the owned child tree and root, leaving sibling sessions untouched', async () => {
  const start = 'Mon Sep 21 10:10:00 2026';
  const childStart = 'Mon Sep 21 10:10:01 2026';
  const siblingStart = 'Mon Sep 21 10:10:02 2026';
  const identities = new Map([
    [321, identity(321, start)],
    [322, identity(322, childStart)],
    [400, identity(400, siblingStart)],
  ]);
  const f = fixture({
    children: {
      children: [{ pid: 322, processStart: childStart }],
      state: 'owned',
    },
    identities,
  });
  f.sessions = createAgentSessions({
    findChildren: async () => ({
      children: [{ pid: 322, processStart: childStart }],
      state: 'owned',
    }),
    now: () => '2026-10-05T12:00:00.000Z',
    observeProcess: async (pid) => identities.get(pid) ?? { state: 'absent' },
    signal: (pid, value) => {
      f.signals.push([pid, value]);
      identities.delete(pid);
    },
    state: f.state,
  });
  await f.sessions.register({ ...launch, pid: 321, processStart: start });
  await expect(
    f.sessions.end('session-1', { checkoutIdentity })
  ).resolves.toMatchObject({ ok: true, session: { state: 'ended' } });
  expect(f.signals).toEqual([
    [322, 'SIGTERM'],
    [321, 'SIGTERM'],
  ]);
  expect(identities.get(400)).toEqual(identity(400, siblingStart));
});

test('a changed checkout identity blocks an otherwise owned session before signalling', async () => {
  const start = 'Mon Sep 21 10:10:00 2026';
  const f = fixture({ identities: new Map([[321, identity(321, start)]]) });
  await f.sessions.register({ ...launch, pid: 321, processStart: start });
  await expect(
    f.sessions.end('session-1', {
      checkoutIdentity: { head: 'changed', known: true },
    })
  ).resolves.toMatchObject({ code: 'SESSION_CHECKOUT_CHANGED', ok: false });
  expect(f.signals).toEqual([]);
});

test('unknown child ownership blocks every signal', async () => {
  const start = 'Mon Sep 21 10:10:00 2026';
  const f = fixture({ identities: new Map([[321, identity(321, start)]]) });
  f.sessions = createAgentSessions({
    findChildren: async () => ({ state: 'unknown' }),
    now: () => '2026-10-05T12:00:00.000Z',
    observeProcess: async (pid) => f.identities.get(pid) ?? { state: 'absent' },
    signal: (pid, value) => f.signals.push([pid, value]),
    state: f.state,
  });
  await f.sessions.register({ ...launch, pid: 321, processStart: start });
  await expect(
    f.sessions.end('session-1', { checkoutIdentity })
  ).resolves.toMatchObject({ code: 'SESSION_OWNERSHIP_UNKNOWN', ok: false });
  expect(f.signals).toEqual([]);
});

test('end rechecks root identity after child signals and refuses a changed root', async () => {
  const start = 'Mon Sep 21 10:10:00 2026';
  const childStart = 'Mon Sep 21 10:10:01 2026';
  let rootChecks = 0;
  const f = fixture();
  f.sessions = createAgentSessions({
    findChildren: async () => ({
      children: [{ pid: 322, processStart: childStart }],
      state: 'owned',
    }),
    now: () => '2026-10-05T12:00:00.000Z',
    observeProcess: async (pid) => {
      if (pid === 322) {
        return identity(322, childStart);
      }
      rootChecks += 1;
      return identity(
        321,
        rootChecks <= 2 ? start : 'Mon Sep 21 10:11:00 2026'
      );
    },
    signal: (pid, value) => f.signals.push([pid, value]),
    state: f.state,
  });
  await f.sessions.register({ ...launch, pid: 321, processStart: start });
  await expect(
    f.sessions.end('session-1', { checkoutIdentity })
  ).resolves.toMatchObject({ code: 'SESSION_OWNERSHIP_UNKNOWN', ok: false });
  expect(f.signals).toEqual([[322, 'SIGTERM']]);
});

test('reconcile leaves a root-ended session unknown when a proven descendant survives', async () => {
  const start = 'Mon Sep 21 10:10:00 2026';
  const childStart = 'Mon Sep 21 10:10:01 2026';
  const identities = new Map([
    [321, identity(321, start)],
    [322, identity(322, childStart)],
  ]);
  const f = fixture();
  f.sessions = createAgentSessions({
    findChildren: async () => ({
      children: [{ pid: 322, processStart: childStart }],
      state: 'owned',
    }),
    now: () => '2026-10-05T12:00:00.000Z',
    observeProcess: async (pid) => identities.get(pid) ?? { state: 'absent' },
    signal: () => {},
    state: f.state,
  });
  await f.sessions.register({ ...launch, pid: 321, processStart: start });
  identities.delete(321);
  await f.sessions.reconcile();
  expect(f.sessions.get('session-1')).toMatchObject({
    ownership: 'unknown',
    state: 'unknown',
  });
});

test('an owned harmless coding child can be ended without touching a sibling process', async () => {
  const coding = spawn('sleep', ['5']);
  const sibling = spawn('sleep', ['5']);
  processes.push(coding, sibling);
  const observed = await observeProcessIdentity(coding.pid);
  expect(observed).toMatchObject({ processId: coding.pid, state: 'alive' });
  const f = fixture();
  const sessions = createAgentSessions({
    findChildren: async () => ({ children: [], state: 'owned' }),
    now: () => '2026-10-05T12:00:00.000Z',
    observeProcess: observeProcessIdentity,
    signal: (pid, value) => process.kill(pid, value),
    state: f.state,
  });
  await sessions.register({
    ...launch,
    pid: coding.pid,
    processStart: observed.processStartIdentity,
  });
  const exited = new Promise((resolve) => coding.once('exit', resolve));
  await expect(
    sessions.end('session-1', { checkoutIdentity })
  ).resolves.toMatchObject({ ok: true });
  await exited;
  await sessions.reconcile();
  expect(sessions.get('session-1')).toMatchObject({ state: 'ended' });
  expect((await observeProcessIdentity(sibling.pid)).state).toBe('alive');
});
