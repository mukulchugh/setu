// Completion proof for a managed session whose root process has disappeared.
// A deterministic fake process world: the only automatic proof is the root
// absent, its proved execution group empty and every retained off-group
// descendant absent. These tests pin each way that proof must NOT be reached.
// The real-process counterparts live in managed-exit.real.test.js.
import { afterEach, expect, test } from 'bun:test';
import fs, { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createAgentSessions,
  maxEscapedDescendants,
  publicSession,
  publicSessionResult,
} from './agent-sessions.js';
import { createWorkspaceState } from './workspace-state.js';

const roots = [];
afterEach(() => {
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { force: true, recursive: true });
  }
});

const checkoutIdentity = { head: 'abc123', known: true };
const launch = {
  checkoutIdentity,
  checkoutPath: '/work/repo/topic',
  id: 'session-1',
  name: 'topic',
  repo: 'repo',
  tool: 'claude-code',
};
const rootStart = 'Mon Sep 21 10:10:00 2026';
const startOf = (pid) =>
  `Mon Sep 21 10:10:${String(pid % 60).padStart(2, '0')} 2026`;
const alive = (pid, processStart = startOf(pid)) => ({
  processId: pid,
  processStartIdentity: processStart,
  state: 'alive',
});

// pid -> identity of every live process; group -> member pids.
function world() {
  const processes = new Map();
  const groups = new Map();
  const w = {
    add(pid, groupId = pid, processStart = startOf(pid)) {
      processes.set(pid, alive(pid, processStart));
      groups.set(groupId, (groups.get(groupId) ?? new Set()).add(pid));
    },
    clock: 0,
    collaborators() {
      return {
        findChildren: () =>
          Promise.resolve({ children: w.tree, state: 'owned' }),
        findEscaped: () => Promise.resolve(w.escapedScan()),
        now: () => {
          w.clock += 1;
          return w.clock;
        },
        observeGroup: (groupId) =>
          w.groupOverride ??
          ([...(groups.get(groupId) ?? [])].some((pid) => processes.has(pid))
            ? 'alive'
            : 'absent'),
        observeProcess: (pid) =>
          Promise.resolve(
            w.observationOverrides.get(pid) ??
              processes.get(pid) ?? { state: 'absent' }
          ),
        proveGroup: () => {
          w.groupProofCalls += 1;
          return Promise.resolve(w.groupProofs());
        },
        signal: (pid, value) => {
          w.signals.push([pid, value]);
          w.onSignal(pid);
        },
      };
    },
    escapedScan: () => ({ escaped: [], state: 'owned' }),
    groupOverride: null,
    groupProofCalls: 0,
    groupProofs: () => ({ escaped: [], state: 'owned' }),
    kill(pid) {
      processes.delete(pid);
    },
    observationOverrides: new Map(),
    onSignal: (pid) => w.kill(pid),
    signals: [],
    tree: [],
  };
  return w;
}

function setup({ proven = true } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'setu-exit-proof-'));
  roots.push(root);
  const state = createWorkspaceState({
    configPath: join(root, 'config.json'),
    setuDir: root,
    workspaceRoot: root,
  });
  const w = world();
  if (!proven) {
    w.groupProofs = () => ({ state: 'unknown' });
  }
  const open = () => createAgentSessions({ ...w.collaborators(), state });
  return { open, sessions: open(), state, w };
}

async function registered(options) {
  const f = setup(options);
  f.w.add(100, 100, rootStart);
  const outcome = await f.sessions.register({
    ...launch,
    pid: 100,
    processStart: rootStart,
  });
  expect(outcome.ok).toBe(true);
  return f;
}

const stateOf = (f) => f.sessions.get('session-1');

test('the proved group, escapees seen at proof and the attempt count are retained and never public', async () => {
  const f = setup();
  f.w.add(100, 100, rootStart);
  f.w.add(200, 200);
  f.w.groupProofs = () => ({
    escaped: [{ pid: 200, processStart: startOf(200) }],
    state: 'owned',
  });
  const { session } = await f.sessions.register({
    ...launch,
    pid: 100,
    processStart: rootStart,
  });
  expect(session.executionGroup).toMatchObject({
    escaped: [{ pid: 200, processStart: startOf(200) }],
    id: 100,
  });
  expect(session.executionGroupAttempts).toBe(1);
  const stopped = await f.sessions.end('session-1', { checkoutIdentity });
  expect(stateOf(f).stopRequestedAt).toBeDefined();
  for (const view of [
    publicSession(stateOf(f)),
    publicSessionResult(stopped).session,
    publicSessionResult({ sessions: [stateOf(f)] }).sessions[0],
  ]) {
    for (const key of [
      'executionGroup',
      'executionGroupAttempts',
      'stopRequestedAt',
    ]) {
      expect(Object.hasOwn(view, key)).toBe(false);
    }
  }
});

test('root absent, group empty and every retained escapee absent is the only automatic completion', async () => {
  const f = await registered();
  f.w.kill(100);
  await f.sessions.reconcile();
  expect(stateOf(f)).toMatchObject({
    endReason: 'exited',
    ownership: 'owned',
    state: 'ended',
  });
});

test('a live group member keeps a dead root unknown until the group is empty, and the ended generation is above the unknown one', async () => {
  const f = await registered();
  f.w.add(101, 100);
  f.w.kill(100);
  await f.sessions.reconcile();
  const unknown = stateOf(f);
  expect(unknown).toMatchObject({ ownership: 'unknown', state: 'unknown' });
  expect(unknown.bindingInvalid).toMatchObject({ reason: 'ownership-unknown' });
  await f.sessions.reconcile();
  expect(stateOf(f).bindingGeneration).toBe(unknown.bindingGeneration);
  f.w.kill(101);
  await f.sessions.reconcile();
  const ended = stateOf(f);
  expect(ended.state).toBe('ended');
  expect(ended.bindingGeneration).toBe(unknown.bindingGeneration + 1);
  expect(ended.bindingInvalid).toMatchObject({
    generation: ended.bindingGeneration,
    reason: 'ended',
  });
});

test('a retained escapee outlives the group and root, then its exit completes the session', async () => {
  const f = setup();
  f.w.add(100, 100, rootStart);
  f.w.add(300, 300);
  f.w.groupProofs = () => ({
    escaped: [{ pid: 300, processStart: startOf(300) }],
    state: 'owned',
  });
  await f.sessions.register({ ...launch, pid: 100, processStart: rootStart });
  f.w.kill(100);
  await f.sessions.reconcile();
  expect(stateOf(f).state).toBe('unknown');
  f.w.kill(300);
  await f.sessions.reconcile();
  expect(stateOf(f).state).toBe('ended');
});

test('a scan while the root is live adds new escapees and keeps the earlier ones', async () => {
  const f = await registered();
  f.w.add(300, 300);
  f.w.escapedScan = () => ({
    escaped: [{ pid: 300, processStart: startOf(300) }],
    state: 'owned',
  });
  await f.sessions.reconcile();
  f.w.add(301, 301);
  f.w.escapedScan = () => ({
    escaped: [{ pid: 301, processStart: startOf(301) }],
    state: 'owned',
  });
  await f.sessions.reconcile();
  expect(stateOf(f).executionGroup.escaped.map((e) => e.pid)).toEqual([
    300, 301,
  ]);
  f.w.kill(100);
  f.w.kill(301);
  await f.sessions.reconcile();
  expect(stateOf(f).state).toBe('unknown');
  f.w.kill(300);
  await f.sessions.reconcile();
  expect(stateOf(f).state).toBe('ended');
});

test('a failed scan keeps what was retained, marks it unverified, and a root that dies before a good scan stays unknown', async () => {
  const f = setup();
  f.w.add(100, 100, rootStart);
  f.w.add(300, 300);
  f.w.groupProofs = () => ({
    escaped: [{ pid: 300, processStart: startOf(300) }],
    state: 'owned',
  });
  await f.sessions.register({ ...launch, pid: 100, processStart: rootStart });
  f.w.escapedScan = () => ({ state: 'unknown' });
  await f.sessions.reconcile();
  expect(stateOf(f).executionGroup).toMatchObject({
    escaped: [{ pid: 300, processStart: startOf(300) }],
    unverified: true,
  });
  // Nothing alive remains and the group is empty, yet the scan gap is unproven.
  f.w.kill(100);
  f.w.kill(300);
  await f.sessions.reconcile();
  expect(stateOf(f)).toMatchObject({ ownership: 'unknown', state: 'unknown' });
  await f.sessions.reconcile();
  expect(stateOf(f).state).toBe('unknown');
});

const failedScans = {
  malformed: () => ({ escaped: 'none', state: 'owned' }),
  missing: () => ({ state: 'owned' }),
  nothing: () => null,
  thrown: () => {
    throw new Error('ps failed');
  },
};
for (const [label, bad] of Object.entries(failedScans)) {
  test(`a scan that is ${label} is a failed scan, not an empty one`, async () => {
    const f = await registered();
    f.w.escapedScan = bad;
    await f.sessions.reconcile();
    expect(stateOf(f).executionGroup.unverified).toBe(true);
    f.w.kill(100);
    await f.sessions.reconcile();
    expect(stateOf(f).state).toBe('unknown');
  });
}

test('a later successful scan while the root identity is live clears the unverified mark', async () => {
  const f = await registered();
  f.w.escapedScan = () => ({ state: 'unknown' });
  await f.sessions.reconcile();
  expect(stateOf(f).executionGroup.unverified).toBe(true);
  f.w.escapedScan = () => ({ escaped: [], state: 'owned' });
  await f.sessions.reconcile();
  expect(stateOf(f).executionGroup.unverified).toBeUndefined();
  f.w.kill(100);
  await f.sessions.reconcile();
  expect(stateOf(f).state).toBe('ended');
});

test('a root that cannot be observed leaves its evidence unverified; running again with a failing scan keeps it so', async () => {
  const f = await registered();
  f.w.observationOverrides.set(100, { state: 'unknown' });
  await f.sessions.reconcile();
  expect(stateOf(f)).toMatchObject({ ownership: 'unknown', state: 'unknown' });
  expect(stateOf(f).executionGroup.unverified).toBe(true);
  f.w.observationOverrides.clear();
  f.w.escapedScan = () => ({ state: 'unknown' });
  await f.sessions.reconcile();
  expect(stateOf(f)).toMatchObject({ ownership: 'unknown', state: 'running' });
  expect(stateOf(f).executionGroup.unverified).toBe(true);
  f.w.kill(100);
  await f.sessions.reconcile();
  expect(stateOf(f).state).toBe('unknown');
});

test('observation-only revalidation restores exit evidence of an ownership-unknown live record without restoring ownership, binding or control', async () => {
  const f = await registered();
  f.w.observationOverrides.set(100, { state: 'unknown' });
  await f.sessions.reconcile();
  const unknown = stateOf(f);
  expect(unknown.executionGroup.unverified).toBe(true);
  // The exact same pid and start identity is observed again and the scan succeeds.
  f.w.observationOverrides.clear();
  f.w.add(300, 300);
  f.w.escapedScan = () => ({
    escaped: [{ pid: 300, processStart: startOf(300) }],
    state: 'owned',
  });
  await f.sessions.reconcile();
  const running = stateOf(f);
  expect(running).toMatchObject({ ownership: 'unknown', state: 'running' });
  expect(running.executionGroup.unverified).toBeUndefined();
  expect(running.executionGroup.escaped.map((e) => e.pid)).toEqual([300]);
  expect(running.bindingInvalid).toEqual(unknown.bindingInvalid);
  expect(running.bindingGeneration).toBeGreaterThan(unknown.bindingGeneration);
  // Control is still refused: observation does not restore ownership.
  await expect(
    f.sessions.end('session-1', { checkoutIdentity })
  ).resolves.toMatchObject({ code: 'SESSION_OWNERSHIP_UNKNOWN', ok: false });
  expect(f.w.signals).toEqual([]);
  // Later ticks keep scanning it, and the restored evidence now gates completion.
  f.w.add(301, 301);
  f.w.escapedScan = () => ({
    escaped: [{ pid: 301, processStart: startOf(301) }],
    state: 'owned',
  });
  await f.sessions.reconcile();
  expect(stateOf(f).executionGroup.escaped.map((e) => e.pid)).toEqual([
    300, 301,
  ]);
  f.w.kill(100);
  await f.sessions.reconcile();
  expect(stateOf(f).state).toBe('unknown');
  f.w.kill(300);
  f.w.kill(301);
  await f.sessions.reconcile();
  expect(stateOf(f)).toMatchObject({ ownership: 'unknown', state: 'ended' });
});

test('retained descendants positively observed absent are pruned, so sequential finished tasks never exhaust the bound', async () => {
  const f = await registered();
  for (let task = 0; task < maxEscapedDescendants + 6; task += 1) {
    const pid = 2000 + task;
    f.w.add(pid, pid);
    f.w.escapedScan = () => ({
      escaped: [{ pid, processStart: startOf(pid) }],
      state: 'owned',
    });
    // biome-ignore lint/performance/noAwaitInLoops: Each tick must observe the previous task finished before the next starts.
    await f.sessions.reconcile();
    f.w.kill(pid);
  }
  f.w.escapedScan = () => ({ escaped: [], state: 'owned' });
  await f.sessions.reconcile();
  expect(stateOf(f).executionGroup.overflow).toBeUndefined();
  expect(stateOf(f).executionGroup.escaped).toEqual([]);
  f.w.kill(100);
  await f.sessions.reconcile();
  expect(stateOf(f).state).toBe('ended');
});

test('pruning keeps live, unobservable and reused identities and drops only the absent', async () => {
  const f = await registered();
  const kept = [400, 401, 402, 403];
  for (const pid of [...kept, 404]) {
    f.w.add(pid, pid);
  }
  f.w.escapedScan = () => ({
    escaped: [...kept, 404].map((pid) => ({ pid, processStart: startOf(pid) })),
    state: 'owned',
  });
  await f.sessions.reconcile();
  expect(stateOf(f).executionGroup.escaped).toHaveLength(5);
  f.w.kill(404);
  f.w.observationOverrides.set(401, { state: 'unknown' });
  f.w.observationOverrides.set(402, alive(402, 'Tue Oct 6 09:00:00 2026'));
  f.w.escapedScan = () => ({ escaped: [], state: 'owned' });
  await f.sessions.reconcile();
  expect(stateOf(f).executionGroup.escaped.map((e) => e.pid)).toEqual([
    400, 401, 402, 403,
  ]);
  // Neither an unobservable nor a reused retained identity proves it is gone.
  f.w.kill(100);
  f.w.kill(400);
  f.w.kill(403);
  await f.sessions.reconcile();
  expect(stateOf(f).state).toBe('unknown');
});

test('an end also prunes retained descendants that are positively gone', async () => {
  const f = setup();
  f.w.add(100, 100, rootStart);
  f.w.add(300, 300);
  f.w.add(301, 301);
  f.w.groupProofs = () => ({
    escaped: [300, 301].map((pid) => ({ pid, processStart: startOf(pid) })),
    state: 'owned',
  });
  await f.sessions.register({ ...launch, pid: 100, processStart: rootStart });
  f.w.kill(300);
  f.w.onSignal = () => undefined;
  // The later scan fails, so only the end's own tree scan can have pruned.
  f.w.escapedScan = () => ({ state: 'unknown' });
  const pending = await f.sessions.end('session-1', { checkoutIdentity });
  expect(pending.pending).toBe(true);
  expect(stateOf(f).executionGroup.escaped.map((e) => e.pid)).toEqual([301]);
});

test('exactly the bound is retained without overflow, and one more is overflow', async () => {
  const entries = (count) =>
    Array.from({ length: count }, (_, i) => ({
      pid: 5000 + i,
      processStart: startOf(5000 + i),
    }));
  const f = await registered();
  for (const entry of entries(maxEscapedDescendants + 1)) {
    f.w.add(entry.pid, entry.pid);
  }
  f.w.escapedScan = () => ({
    escaped: entries(maxEscapedDescendants),
    state: 'owned',
  });
  await f.sessions.reconcile();
  expect(stateOf(f).executionGroup.escaped).toHaveLength(maxEscapedDescendants);
  expect(stateOf(f).executionGroup.overflow).toBeUndefined();
  // A bounded scan reports bound + 1 when more exist; that is overflow, for good.
  f.w.escapedScan = () => ({
    escaped: entries(maxEscapedDescendants + 1),
    state: 'owned',
  });
  await f.sessions.reconcile();
  expect(stateOf(f).executionGroup.overflow).toBe(true);
  expect(stateOf(f).executionGroup.escaped).toHaveLength(maxEscapedDescendants);
});

test('overflow stays set even after pruning', async () => {
  const f = await registered();
  const many = Array.from({ length: maxEscapedDescendants + 1 }, (_, i) => ({
    pid: 3000 + i,
    processStart: startOf(3000 + i),
  }));
  f.w.escapedScan = () => ({ escaped: many, state: 'owned' });
  await f.sessions.reconcile();
  f.w.escapedScan = () => ({ escaped: [], state: 'owned' });
  await f.sessions.reconcile();
  expect(stateOf(f).executionGroup).toMatchObject({
    escaped: [],
    overflow: true,
  });
  f.w.kill(100);
  await f.sessions.reconcile();
  expect(stateOf(f).state).toBe('unknown');
});

test('a refused end still persists the escapees it just observed', async () => {
  const f = await registered();
  f.w.add(300, 300);
  f.w.tree = [{ groupId: 300, pid: 300, processStart: startOf(300) }];
  // The child cannot be confirmed when the stop reaches it: nothing is signalled.
  f.w.observationOverrides.set(300, { state: 'unknown' });
  const refused = await f.sessions.end('session-1', { checkoutIdentity });
  expect(refused).toMatchObject({
    code: 'SESSION_OWNERSHIP_UNKNOWN',
    ok: false,
  });
  expect(f.w.signals).toEqual([]);
  expect(stateOf(f)).toMatchObject({ ownership: 'owned', state: 'running' });
  expect(stateOf(f).executionGroup.escaped).toEqual([
    { pid: 300, processStart: startOf(300) },
  ]);
  expect(stateOf(f).stopRequestedAt).toBeUndefined();
  // Once it is observable the retained descendant gates the later completion.
  f.w.observationOverrides.clear();
  f.w.kill(100);
  await f.sessions.reconcile();
  expect(stateOf(f).state).toBe('unknown');
  f.w.kill(300);
  await f.sessions.reconcile();
  expect(stateOf(f).state).toBe('ended');
});

test('an end whose child scan fails leaves the evidence unverified', async () => {
  const f = await registered();
  const blind = createAgentSessions({
    ...f.w.collaborators(),
    findChildren: () => Promise.resolve({ state: 'unknown' }),
    state: f.state,
  });
  const refused = await blind.end('session-1', { checkoutIdentity });
  expect(refused).toMatchObject({
    code: 'SESSION_OWNERSHIP_UNKNOWN',
    ok: false,
  });
  expect(f.w.signals).toEqual([]);
  expect(blind.get('session-1').executionGroup.unverified).toBe(true);
  f.w.kill(100);
  await blind.reconcile();
  expect(blind.get('session-1').state).toBe('unknown');
});

const lapses = {
  'a malformed live observation': { processId: 100, state: 'alive' },
  'an unknown observation': { state: 'unknown' },
};
for (const [label, observation] of Object.entries(lapses)) {
  test(`an end refused on ${label} of the root leaves the evidence unverified`, async () => {
    const f = await registered();
    f.w.observationOverrides.set(100, observation);
    const refused = await f.sessions.end('session-1', { checkoutIdentity });
    expect(refused.ok).toBe(false);
    expect(stateOf(f).executionGroup.unverified).toBe(true);
    expect(f.w.signals).toEqual([]);
  });
}

test('a confirmed pid replacement of the root is distinguished from a lapse in observation', async () => {
  const f = await registered();
  f.w.observationOverrides.set(100, alive(100, 'Tue Oct 6 09:00:00 2026'));
  const refused = await f.sessions.end('session-1', { checkoutIdentity });
  expect(refused).toMatchObject({
    code: 'SESSION_PROCESS_IDENTITY_CHANGED',
    ok: false,
  });
  expect(stateOf(f).executionGroup.unverified).toBeUndefined();
  expect(f.w.signals).toEqual([]);
});

test('a root observed unknown after the stop signals leaves the evidence unverified', async () => {
  const f = await registered();
  f.w.onSignal = (pid) => {
    if (pid === 100) {
      f.w.observationOverrides.set(100, { state: 'unknown' });
    }
  };
  const outcome = await f.sessions.end('session-1', { checkoutIdentity });
  expect(outcome).toMatchObject({ code: 'SESSION_END_UNKNOWN', ok: false });
  expect(stateOf(f).executionGroup.unverified).toBe(true);
  expect(stateOf(f).stopRequestedAt).toBeDefined();
});

test('a root that stops being confirmed between the child stop and its own signal leaves the evidence unverified', async () => {
  const f = await registered();
  f.w.add(300, 300);
  f.w.tree = [{ groupId: 300, pid: 300, processStart: startOf(300) }];
  f.w.onSignal = (pid) => {
    f.w.kill(pid);
    f.w.observationOverrides.set(100, { state: 'unknown' });
  };
  const outcome = await f.sessions.end('session-1', { checkoutIdentity });
  expect(outcome).toMatchObject({
    code: 'SESSION_OWNERSHIP_UNKNOWN',
    ok: false,
  });
  expect(stateOf(f).executionGroup.unverified).toBe(true);
  expect(f.w.signals).toEqual([[300, 'SIGTERM']]);
});

test('more escapees than the bound set overflow for good and the session never completes automatically', async () => {
  const f = await registered();
  const many = Array.from({ length: maxEscapedDescendants + 1 }, (_, i) => ({
    pid: 1000 + i,
    processStart: startOf(1000 + i),
  }));
  f.w.escapedScan = () => ({ escaped: many, state: 'owned' });
  await f.sessions.reconcile();
  expect(stateOf(f).executionGroup).toMatchObject({ overflow: true });
  expect(stateOf(f).executionGroup.escaped).toHaveLength(maxEscapedDescendants);
  f.w.escapedScan = () => ({ escaped: [], state: 'owned' });
  await f.sessions.reconcile();
  expect(stateOf(f).executionGroup.overflow).toBe(true);
  f.w.kill(100);
  await f.sessions.reconcile();
  expect(stateOf(f).state).toBe('unknown');
});

for (const path of ['natural', 'immediate', 'pending']) {
  test(`without a group proof a dead root is never ended: ${path} exit`, async () => {
    const f = await registered({ proven: false });
    expect(stateOf(f).executionGroup).toBeUndefined();
    if (path === 'immediate') {
      // Every snapshot child exits at once and the root follows.
      f.w.tree = [{ groupId: 100, pid: 101, processStart: startOf(101) }];
      f.w.add(101, 100);
    } else if (path === 'pending') {
      f.w.onSignal = () => undefined;
    }
    if (path !== 'natural') {
      await f.sessions.end('session-1', { checkoutIdentity });
    }
    f.w.kill(100);
    f.w.kill(101);
    await f.sessions.reconcile();
    // An attempted stop only attributes; it never completes.
    expect(stateOf(f).state).toBe('unknown');
  });
}

test('stopRequestedAt and a snapshot of absent children never complete a session by themselves', async () => {
  const f = await registered({ proven: false });
  f.w.tree = [{ groupId: 100, pid: 101, processStart: startOf(101) }];
  f.w.add(101, 100);
  const result = await f.sessions.end('session-1', { checkoutIdentity });
  expect(result.session.state).toBe('unknown');
  expect(f.w.signals).toEqual([
    [101, 'SIGTERM'],
    [100, 'SIGTERM'],
  ]);
  await f.sessions.reconcile();
  expect(stateOf(f).state).toBe('unknown');
});

test('a late group proof is attempted a bounded number of times', async () => {
  const f = await registered({ proven: false });
  expect(f.w.groupProofCalls).toBe(1);
  for (const _tick of new Array(6).fill(0)) {
    // biome-ignore lint/performance/noAwaitInLoops: Each reconcile is a separate monitor tick and must settle before the next.
    await f.sessions.reconcile();
  }
  // One at registration plus two more; the third attempt count is reached.
  expect(f.w.groupProofCalls).toBe(3);
  expect(stateOf(f).executionGroupAttempts).toBe(3);
  f.w.groupProofs = () => ({ escaped: [], state: 'owned' });
  await f.sessions.reconcile();
  expect(stateOf(f).executionGroup).toBeUndefined();
});

test('a late proof, when one succeeds, makes completion possible', async () => {
  const f = await registered({ proven: false });
  f.w.groupProofs = () => ({ escaped: [], state: 'owned' });
  await f.sessions.reconcile();
  expect(stateOf(f).executionGroup).toMatchObject({ id: 100 });
  f.w.kill(100);
  await f.sessions.reconcile();
  expect(stateOf(f).state).toBe('ended');
});

const invalidEvidence = {
  'bad flag': { escaped: [], id: 100, overflow: 'yes', provenAt: 1 },
  'bad unverified': { escaped: [], id: 100, provenAt: 1, unverified: false },
  'malformed entry': {
    escaped: [{ pid: 'x', processStart: 'y' }],
    id: 100,
    provenAt: 1,
  },
  'missing time': { escaped: [], id: 100 },
  'not a group': 'group',
  'not an array': { escaped: 'none', id: 100, provenAt: 1 },
  'null group': null,
  'over the bound': {
    escaped: new Array(maxEscapedDescendants + 1).fill({
      pid: 5,
      processStart: 'x',
    }),
    id: 100,
    provenAt: 1,
  },
  'wrong leader': { escaped: [], id: 999, provenAt: 1 },
};
for (const [label, executionGroup] of Object.entries(invalidEvidence)) {
  test(`invalid persisted evidence (${label}) is no proof and never makes the list unreadable`, async () => {
    const f = await registered();
    await f.state.update('agentSessions', (document) => ({
      ...document,
      sessions: {
        ...document.sessions,
        'session-1': { ...document.sessions['session-1'], executionGroup },
      },
    }));
    f.w.kill(100);
    await f.sessions.reconcile();
    expect(f.sessions.list()).toHaveLength(1);
    expect(stateOf(f).state).toBe('unknown');
  });
}

test('a reused root pid, and a reused escapee pid, are unknown and are never signalled', async () => {
  const f = await registered();
  f.w.observationOverrides.set(100, alive(100, 'Tue Oct 6 09:00:00 2026'));
  await f.sessions.reconcile();
  expect(stateOf(f).state).toBe('unknown');
  expect(f.w.signals).toEqual([]);
  // The original identity is not that process, and reuse does not unverify what was seen.
  const g = setup();
  g.w.add(100, 100, rootStart);
  g.w.add(300, 300);
  g.w.groupProofs = () => ({
    escaped: [{ pid: 300, processStart: startOf(300) }],
    state: 'owned',
  });
  await g.sessions.register({ ...launch, pid: 100, processStart: rootStart });
  g.w.kill(100);
  g.w.kill(300);
  g.w.observationOverrides.set(300, alive(300, 'Tue Oct 6 09:00:00 2026'));
  await g.sessions.reconcile();
  expect(g.sessions.get('session-1').state).toBe('unknown');
});

for (const override of ['unknown', 'alive', 'garbage']) {
  test(`a group observed as ${override} is not an empty group`, async () => {
    const f = await registered();
    f.w.kill(100);
    f.w.groupOverride = override;
    await f.sessions.reconcile();
    expect(stateOf(f).state).toBe('unknown');
  });
}

test('an erroring group observer is unknown, not empty', async () => {
  const g = await registered();
  g.w.kill(100);
  const collaborators = g.w.collaborators();
  const throwing = createAgentSessions({
    ...collaborators,
    observeGroup: () => {
      throw new Error('kill failed');
    },
    state: g.state,
  });
  await throwing.reconcile();
  expect(throwing.get('session-1').state).toBe('unknown');
  g.w.groupOverride = null;
  await g.sessions.reconcile();
  expect(stateOf(g).state).toBe('ended');
});

test('a stop in progress retains the live tree and a group member born during the stop keeps the session unknown', async () => {
  const f = await registered();
  f.w.add(300, 300);
  f.w.tree = [
    { groupId: 100, pid: 101, processStart: startOf(101) },
    { groupId: 300, pid: 300, processStart: startOf(300) },
  ];
  f.w.add(101, 100);
  // The root does not die at once (delayed TERM); the children do.
  f.w.onSignal = (pid) => {
    if (pid === 101) {
      f.w.kill(pid);
    }
  };
  const pending = await f.sessions.end('session-1', { checkoutIdentity });
  expect(pending).toMatchObject({ ok: true, pending: true });
  expect(stateOf(f)).toMatchObject({ ownership: 'owned', state: 'running' });
  expect(stateOf(f).executionGroup.escaped).toEqual([
    { pid: 300, processStart: startOf(300) },
  ]);
  expect(stateOf(f).stopRequestedAt).toBeDefined();
  // The trap handler starts a new in-group child, then the root exits.
  f.w.add(400, 100);
  f.w.kill(100);
  // A restarted service sees the same state.
  const restarted = f.open();
  await restarted.reconcile();
  expect(restarted.get('session-1')).toMatchObject({
    ownership: 'unknown',
    state: 'unknown',
  });
  f.w.kill(400);
  await restarted.reconcile();
  // The retained off-group descendant still gates completion.
  expect(restarted.get('session-1').state).toBe('unknown');
  f.w.kill(300);
  await restarted.reconcile();
  expect(restarted.get('session-1')).toMatchObject({
    endReason: 'ended-by-user',
    state: 'ended',
  });
});

test('an end whose root dies at once is ended only with the group empty and the escapees gone', async () => {
  const f = await registered();
  f.w.add(300, 300);
  f.w.tree = [{ groupId: 300, pid: 300, processStart: startOf(300) }];
  // Root dies at once but the escapee ignores the stop.
  f.w.onSignal = (pid) => {
    if (pid === 100) {
      f.w.kill(100);
    }
  };
  const first = await f.sessions.end('session-1', { checkoutIdentity });
  expect(first).toMatchObject({ code: 'SESSION_END_UNKNOWN', ok: false });
  expect(stateOf(f).state).toBe('unknown');
  f.w.kill(300);
  await f.sessions.reconcile();
  expect(stateOf(f)).toMatchObject({
    endReason: 'ended-by-user',
    state: 'ended',
  });
});

test('a pending stop keeps the complete pre-signal evidence and does not rescan the dying root', async () => {
  const f = await registered();
  f.w.add(300, 300);
  f.w.tree = [{ groupId: 300, pid: 300, processStart: startOf(300) }];
  f.w.onSignal = (pid) => {
    if (pid === 300) {
      f.w.kill(pid);
    }
  };
  let scans = 0;
  f.w.escapedScan = () => {
    scans += 1;
    return { state: 'unknown' };
  };
  const pending = await f.sessions.end('session-1', { checkoutIdentity });
  expect(pending).toMatchObject({ ok: true, pending: true });
  // Evidence taken by the end's own complete tree scan before the signal.
  expect(scans).toBe(0);
  expect(stateOf(f).executionGroup).toMatchObject({
    escaped: [{ pid: 300, processStart: startOf(300) }],
    id: 100,
  });
  expect(stateOf(f).executionGroup.unverified).toBeUndefined();
  // The root now exits, and with the group empty the stop completes.
  f.w.kill(100);
  await f.sessions.reconcile();
  expect(stateOf(f)).toMatchObject({
    endReason: 'ended-by-user',
    state: 'ended',
  });
});

test('a pending stop still lets a retained off-group descendant block completion', async () => {
  const f = await registered();
  f.w.add(300, 300);
  f.w.tree = [{ groupId: 300, pid: 300, processStart: startOf(300) }];
  f.w.onSignal = () => undefined;
  const pending = await f.sessions.end('session-1', { checkoutIdentity });
  expect(pending.pending).toBe(true);
  expect(stateOf(f).executionGroup.escaped.map((e) => e.pid)).toEqual([300]);
  f.w.kill(100);
  await f.sessions.reconcile();
  expect(stateOf(f).state).toBe('unknown');
  f.w.kill(300);
  await f.sessions.reconcile();
  expect(stateOf(f).state).toBe('ended');
});

test('a failed monitor scan of a live root after a pending stop unverifies the evidence, so its later exit stays unknown', async () => {
  const f = await registered();
  f.w.onSignal = () => undefined;
  const pending = await f.sessions.end('session-1', { checkoutIdentity });
  expect(pending.pending).toBe(true);
  expect(stateOf(f).executionGroup.unverified).toBeUndefined();
  // The ordinary monitor tick scans the still-live root and the scan fails.
  f.w.escapedScan = () => ({ state: 'unknown' });
  await f.sessions.reconcile();
  expect(stateOf(f)).toMatchObject({ ownership: 'owned', state: 'running' });
  expect(stateOf(f).executionGroup.unverified).toBe(true);
  f.w.kill(100);
  await f.sessions.reconcile();
  expect(stateOf(f)).toMatchObject({ ownership: 'unknown', state: 'unknown' });
});

test('a pending stop whose root is then observed unknown is unverified, not forgiven', async () => {
  const f = await registered();
  f.w.onSignal = () => undefined;
  await f.sessions.end('session-1', { checkoutIdentity });
  f.w.observationOverrides.set(100, { state: 'unknown' });
  await f.sessions.reconcile();
  expect(stateOf(f).executionGroup.unverified).toBe(true);
  f.w.observationOverrides.clear();
  f.w.kill(100);
  await f.sessions.reconcile();
  expect(stateOf(f).state).toBe('unknown');
});
