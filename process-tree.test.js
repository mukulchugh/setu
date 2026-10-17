import { afterEach, expect, test } from 'bun:test';
import { spawn } from 'node:child_process';
import {
  findProcessChildren,
  proveProcessGroupOwnership,
} from './process-tree.js';

const children = [];
afterEach(() => {
  for (const child of children.splice(0)) {
    child.kill();
  }
});

test('a child tree retains only identities proven by process observation', async () => {
  const starts = new Map([
    [10, 'Mon Sep 21 10:10:00 2026'],
    [11, 'Mon Sep 21 10:10:01 2026'],
    [12, 'Mon Sep 21 10:10:02 2026'],
  ]);
  const result = await findProcessChildren(10, {
    listProcesses: async () => [
      { parentPid: 1, pid: 10 },
      { parentPid: 10, pid: 11 },
      { parentPid: 11, pid: 12 },
      { parentPid: 1, pid: 99 },
    ],
    observeProcess: async (pid) => ({
      processId: pid,
      processStartIdentity: starts.get(pid),
      state: 'alive',
    }),
    processStart: starts.get(10),
  });

  expect(result).toEqual({
    children: [
      { pid: 11, processStart: starts.get(11) },
      { pid: 12, processStart: starts.get(12) },
    ],
    state: 'owned',
  });
});

test('a missing observation or changed root identity leaves child ownership unknown', async () => {
  const result = await findProcessChildren(10, {
    listProcesses: async () => [{ parentPid: 1, pid: 10 }],
    observeProcess: async () => ({
      processId: 10,
      processStartIdentity: 'Mon Sep 21 10:10:01 2026',
      state: 'alive',
    }),
    processStart: 'Mon Sep 21 10:10:00 2026',
  });
  expect(result).toEqual({ state: 'unknown' });
});

test('a vanished snapshot-only child does not poison other proven children', async () => {
  const starts = new Map([
    [10, 'Mon Sep 21 10:10:00 2026'],
    [12, 'Mon Sep 21 10:10:02 2026'],
  ]);
  const result = await findProcessChildren(10, {
    listProcesses: async () => [
      { parentPid: 1, pid: 10 },
      { parentPid: 10, pid: 11 },
      { parentPid: 10, pid: 12 },
    ],
    observeProcess: async (pid) =>
      pid === 11
        ? { state: 'absent' }
        : {
            processId: pid,
            processStartIdentity: starts.get(pid),
            state: 'alive',
          },
    processStart: starts.get(10),
  });

  expect(result).toEqual({
    children: [{ pid: 12, processStart: starts.get(12) }],
    state: 'owned',
  });
});

test('an uncertain snapshot child remains an ownership refusal', async () => {
  const result = await findProcessChildren(10, {
    listProcesses: async () => [
      { parentPid: 1, pid: 10 },
      { parentPid: 10, pid: 11 },
    ],
    observeProcess: async (pid) =>
      pid === 11
        ? { state: 'unknown' }
        : {
            processId: pid,
            processStartIdentity: 'Mon Sep 21 10:10:00 2026',
            state: 'alive',
          },
    processStart: 'Mon Sep 21 10:10:00 2026',
  });
  expect(result).toEqual({ state: 'unknown' });
});

test('a live pid whose current parent relation changed is not certified as a child', async () => {
  let reads = 0;
  const result = await findProcessChildren(10, {
    // biome-ignore lint/suspicious/useAwait: Process-list fixtures preserve the asynchronous observer contract.
    listProcesses: async () => {
      reads += 1;
      return reads === 1
        ? [
            { parentPid: 1, pid: 10 },
            { parentPid: 10, pid: 11 },
          ]
        : [
            { parentPid: 1, pid: 10 },
            { parentPid: 99, pid: 11 },
          ];
    },
    observeProcess: async (pid) => ({
      processId: pid,
      processStartIdentity: `Mon Sep 21 10:10:0${pid - 10} 2026`,
      state: 'alive',
    }),
    processStart: 'Mon Sep 21 10:10:00 2026',
  });
  expect(result).toEqual({ state: 'unknown' });
});

test('the root identity is re-observed before ownership is certified', async () => {
  let rootObservations = 0;
  const result = await findProcessChildren(10, {
    listProcesses: async () => [{ parentPid: 1, pid: 10 }],
    // biome-ignore lint/suspicious/useAwait: Identity observation fixtures preserve their asynchronous result contract.
    observeProcess: async (pid) => {
      if (pid === 10) {
        rootObservations += 1;
      }
      return {
        processId: pid,
        processStartIdentity:
          rootObservations > 1
            ? 'Mon Sep 21 10:11:00 2026'
            : 'Mon Sep 21 10:10:00 2026',
        state: 'alive',
      };
    },
    processStart: 'Mon Sep 21 10:10:00 2026',
  });
  expect(result).toEqual({ state: 'unknown' });
});

test('a process group is owned only when every member is the root or its proven descendant', async () => {
  const rows = [
    { groupId: 10, parentPid: 1, pid: 10 },
    { groupId: 10, parentPid: 10, pid: 11 },
  ];
  const deps = {
    listProcesses: async () => rows,
    observeProcess: async (pid) => ({
      processId: pid,
      processStartIdentity: `Mon Sep 21 10:10:0${pid - 10} 2026`,
      state: 'alive',
    }),
  };
  await expect(
    proveProcessGroupOwnership(
      {
        groupId: 10,
        pid: 10,
        processStart: 'Mon Sep 21 10:10:00 2026',
      },
      deps
    )
  ).resolves.toEqual({ members: [10, 11], state: 'owned' });

  rows.push({ groupId: 10, parentPid: 1, pid: 12 });
  await expect(
    proveProcessGroupOwnership(
      {
        groupId: 10,
        pid: 10,
        processStart: 'Mon Sep 21 10:10:00 2026',
      },
      deps
    )
  ).resolves.toEqual({ state: 'unknown' });
});

test('the native reader can observe an owned harmless child when ps is permitted', async () => {
  const child = spawn('sleep', ['2']);
  children.push(child);
  const result = await findProcessChildren(process.pid, {
    processStart: undefined,
  });
  expect(result.state).toBe('owned');
  expect(result.children.some((row) => row.pid === child.pid)).toBe(true);
});
