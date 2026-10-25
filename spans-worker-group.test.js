import { afterEach, expect, test } from 'bun:test';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createOwnedProcessGroup } from './owned-process-group.js';
import { observeProcessIdentity } from './process-observation.js';

const START = 'Mon Sep 21 10:10:00 2026';
const children = new Set();
const groupOwners = new Set();
const tempDirs = new Set();
const fixturePath = join(
  dirname(fileURLToPath(import.meta.url)),
  'spans-worker-process.fixture.js'
);

function processRow(pid, parentPid, groupId, processStartIdentity = START) {
  return { groupId, parentPid, pid, processStartIdentity };
}

function signalFixture(getRows, sent) {
  return (target, value) => {
    if (value === 0) {
      const id = Math.abs(target);
      const exists =
        target < 0
          ? getRows().some((row) => row.groupId === id)
          : getRows().some((row) => row.pid === id);
      if (!exists) {
        throw Object.assign(new Error('absent'), { code: 'ESRCH' });
      }
      return;
    }
    sent.push({ signal: value, target });
  };
}

async function waitFor(check, label, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    // biome-ignore lint/performance/noAwaitInLoops: This polls native process lifecycle state serially.
    const value = await check();
    if (value) {
      return value;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

afterEach(() => {
  for (const owner of groupOwners) {
    owner.signalOwned('SIGKILL');
  }
  groupOwners.clear();
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null) {
      try {
        child.kill('SIGUSR2');
      } catch {
        // The native fixture may already have exited.
      }
    }
  }
  children.clear();
  for (const path of tempDirs) {
    rmSync(path, { force: true, recursive: true });
  }
  tempDirs.clear();
});

test('injected snapshots signal only the proven group and observed escaped descendants', () => {
  const rows = [
    processRow(10, 1, 10),
    processRow(11, 10, 10),
    processRow(12, 11, 12),
  ];
  const sent = [];
  const owner = createOwnedProcessGroup({
    groupId: 10,
    pid: 10,
    processStartIdentity: START,
    readSnapshot: () => rows,
    signal: signalFixture(() => rows, sent),
  });

  expect(owner.observe().state).toBe('owned');
  expect(owner.signalOwned('SIGTERM')).toEqual({ ok: true });
  expect(sent).toEqual([
    { signal: 'SIGTERM', target: -10 },
    { signal: 'SIGTERM', target: 12 },
  ]);
  // Signal delivery leaves settlement alive until fresh evidence says otherwise.
  expect(owner.settled()).toEqual({ state: 'alive' });
});

test('injected snapshots refuse PID reuse, foreign membership and unknown observation', () => {
  const sent = [];
  let rows = [processRow(10, 1, 10)];
  const owner = createOwnedProcessGroup({
    groupId: 10,
    pid: 10,
    processStartIdentity: START,
    readSnapshot: () => rows,
    signal: signalFixture(() => rows, sent),
  });
  expect(owner.observe().state).toBe('owned');

  rows = [processRow(10, 1, 10, 'Tue Sep 22 10:10:00 2026')];
  expect(owner.signalOwned('SIGTERM')).toMatchObject({ ok: false });
  expect(sent).toEqual([]);

  rows = [processRow(10, 1, 10), processRow(99, 1, 10)];
  const foreign = createOwnedProcessGroup({
    groupId: 10,
    pid: 10,
    processStartIdentity: START,
    readSnapshot: () => rows,
    signal: signalFixture(() => rows, sent),
  });
  expect(foreign.signalOwned('SIGTERM')).toMatchObject({ ok: false });

  const unknown = createOwnedProcessGroup({
    groupId: 10,
    pid: 10,
    processStartIdentity: START,
    readSnapshot: () => {
      throw new Error('snapshot unavailable');
    },
    signal: signalFixture(() => rows, sent),
  });
  expect(unknown.signalOwned('SIGTERM')).toMatchObject({ ok: false });
  expect(sent).toEqual([]);
});

test('an exactly observed group that has already disappeared needs no signal', () => {
  let rows = [processRow(10, 1, 10)];
  const sent = [];
  const owner = createOwnedProcessGroup({
    groupId: 10,
    pid: 10,
    processStartIdentity: START,
    readSnapshot: () => rows,
    signal: signalFixture(() => rows, sent),
  });
  expect(owner.observe().state).toBe('owned');
  rows = [];
  expect(owner.signalOwned('SIGTERM')).toEqual({ absent: true, ok: true });
  expect(owner.signalOwned('SIGKILL')).toEqual({ absent: true, ok: true });
  expect(owner.settled()).toEqual({ state: 'absent' });
  expect(sent).toEqual([]);
});

test('injected snapshots re-prove provider identity before KILL escalation', () => {
  let rows = [processRow(10, 1, 10)];
  const sent = [];
  const owner = createOwnedProcessGroup({
    groupId: 10,
    pid: 10,
    processStartIdentity: START,
    readSnapshot: () => rows,
    signal: signalFixture(() => rows, sent),
  });
  expect(owner.observe().state).toBe('owned');
  expect(owner.signalOwned('SIGTERM')).toEqual({ ok: true });
  rows = [processRow(10, 1, 10, 'Tue Sep 22 10:10:00 2026')];
  expect(owner.signalOwned('SIGKILL')).toMatchObject({
    ok: false,
    unknown: true,
  });
  expect(sent).toEqual([{ signal: 'SIGTERM', target: -10 }]);
});

test('injected snapshots keep an observed escaped descendant owned after root exit', () => {
  let rows = [processRow(10, 1, 10), processRow(11, 10, 10)];
  const sent = [];
  const owner = createOwnedProcessGroup({
    groupId: 10,
    pid: 10,
    processStartIdentity: START,
    readSnapshot: () => rows,
    signal: signalFixture(() => rows, sent),
  });
  expect(owner.observe().state).toBe('owned');
  rows = [processRow(11, 1, 11)];
  expect(owner.settled()).toEqual({ state: 'alive' });
  expect(owner.signalOwned('SIGTERM')).toEqual({ ok: true });
  expect(sent).toEqual([{ signal: 'SIGTERM', target: 11 }]);
});

test('retains a reparented escaped descendant for TERM and KILL while the root lives', () => {
  let rows = [
    processRow(10, 1, 10),
    processRow(11, 10, 10),
    processRow(12, 11, 12),
  ];
  const sent = [];
  const owner = createOwnedProcessGroup({
    groupId: 10,
    pid: 10,
    processStartIdentity: START,
    readSnapshot: () => rows,
    signal: signalFixture(() => rows, sent),
  });

  expect(owner.observe().state).toBe('owned');
  rows = [processRow(10, 1, 10), processRow(12, 1, 12)];
  expect(owner.settled()).toEqual({ state: 'alive' });
  expect(owner.signalOwned('SIGTERM')).toEqual({ ok: true });
  expect(owner.signalOwned('SIGKILL')).toEqual({ ok: true });
  expect(sent).toEqual([
    { signal: 'SIGTERM', target: -10 },
    { signal: 'SIGTERM', target: 12 },
    { signal: 'SIGKILL', target: -10 },
    { signal: 'SIGKILL', target: 12 },
  ]);
});

test('changed escaped incarnations block both TERM and KILL', () => {
  const sent = [];
  for (const signal of ['SIGTERM', 'SIGKILL']) {
    let rows = [
      processRow(10, 1, 10),
      processRow(11, 10, 10),
      processRow(12, 11, 12),
    ];
    const owner = createOwnedProcessGroup({
      groupId: 10,
      pid: 10,
      processStartIdentity: START,
      readSnapshot: () => rows,
      signal: signalFixture(() => rows, sent),
    });

    expect(owner.observe().state).toBe('owned');
    rows = [
      processRow(10, 1, 10),
      processRow(12, 1, 12, 'Tue Sep 22 10:10:00 2026'),
    ];
    expect(owner.signalOwned(signal)).toMatchObject({
      ok: false,
      unknown: true,
    });
  }
  expect(sent).toEqual([]);
});

test('a retained escaped identity with a foreign parent blocks group signals', () => {
  const sent = [];
  for (const signal of ['SIGTERM', 'SIGKILL']) {
    let rows = [
      processRow(10, 1, 10),
      processRow(11, 10, 10),
      processRow(12, 11, 12),
    ];
    const owner = createOwnedProcessGroup({
      groupId: 10,
      pid: 10,
      processStartIdentity: START,
      readSnapshot: () => rows,
      signal: signalFixture(() => rows, sent),
    });

    expect(owner.observe().state).toBe('owned');
    rows = [processRow(10, 1, 10), processRow(12, 99, 12)];
    expect(owner.signalOwned(signal)).toMatchObject({
      ok: false,
      unknown: true,
    });
  }
  expect(sent).toEqual([]);
});

if (process.env.SETU_RUN_NATIVE_PROCESS_GROUP_TESTS === '1') {
  test('native ps holds a detached provider group after its parent exits until inherited pipes close', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'setu-spans-group-native-'));
    tempDirs.add(directory);
    const marker = join(directory, 'provider');
    const child = spawn(
      process.execPath,
      [fixturePath, 'group-parent', marker],
      {
        detached: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      }
    );
    children.add(child);
    let closeSeen = false;
    let parentExited = false;
    child.on('close', () => {
      closeSeen = true;
    });
    child.on('exit', () => {
      parentExited = true;
    });
    await waitFor(
      () => existsSync(`${marker}.descendant-ready`),
      'descendant start'
    );
    const identity = await observeProcessIdentity(child.pid);
    expect(identity.state).toBe('alive');
    const owner = createOwnedProcessGroup({
      groupId: child.pid,
      pid: child.pid,
      processStartIdentity: identity.processStartIdentity,
    });
    groupOwners.add(owner);
    const observed = owner.observe();
    expect(observed.state).toBe('owned');
    const descendantPid = Number(
      readFileSync(`${marker}.descendant.pid`, 'utf8')
    );
    expect(observed.members.map((member) => member.pid)).toContain(
      descendantPid
    );
    await waitFor(() => parentExited, 'provider parent exit');
    expect(closeSeen).toBe(false);
    expect(owner.settled()).toEqual({ state: 'alive' });

    expect(owner.signalOwned('SIGTERM')).toEqual({ ok: true });
    await waitFor(() => closeSeen, 'inherited pipe close');
    await expect(owner.waitForSettlement()).resolves.toEqual({
      state: 'absent',
    });
  });
}
