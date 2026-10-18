import { afterEach, expect, test } from 'bun:test';
import { spawn } from 'node:child_process';
import {
  findEscapedDescendants,
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
  ).resolves.toEqual({ escaped: [], members: [10, 11], state: 'owned' });

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

const identityOf = (pid) => ({
  processId: pid,
  processStartIdentity: `Mon Sep 21 10:10:${String(pid % 60).padStart(2, '0')} 2026`,
  state: 'alive',
});
const rootStartText = identityOf(10).processStartIdentity;

test('certified children carry the group the process table reported for them', async () => {
  const result = await findProcessChildren(10, {
    listProcesses: () =>
      Promise.resolve([
        { groupId: 10, parentPid: 1, pid: 10 },
        { groupId: 10, parentPid: 10, pid: 11 },
        { groupId: 12, parentPid: 11, pid: 12 },
      ]),
    observeProcess: (pid) => Promise.resolve(identityOf(pid)),
    processStart: rootStartText,
  });
  expect(result.children).toEqual([
    { groupId: 10, pid: 11, processStart: identityOf(11).processStartIdentity },
    { groupId: 12, pid: 12, processStart: identityOf(12).processStartIdentity },
  ]);
});

test('a child whose group changed between reads is not certified', async () => {
  let reads = 0;
  const result = await findProcessChildren(10, {
    listProcesses: () => {
      reads += 1;
      return Promise.resolve([
        { groupId: 10, parentPid: 1, pid: 10 },
        { groupId: reads === 1 ? 10 : 11, parentPid: 10, pid: 11 },
      ]);
    },
    observeProcess: (pid) => Promise.resolve(identityOf(pid)),
    processStart: rootStartText,
  });
  expect(result).toEqual({ state: 'unknown' });
});

test('escaped descendants are the certified ones outside the root group, by identity', async () => {
  const observed = [];
  const result = await findEscapedDescendants(10, {
    groupId: 10,
    listProcesses: () =>
      Promise.resolve([
        { groupId: 10, parentPid: 1, pid: 10 },
        { groupId: 10, parentPid: 10, pid: 11 },
        { groupId: 12, parentPid: 11, pid: 12 },
        { groupId: 13, parentPid: 12, pid: 13 },
        { groupId: 99, parentPid: 1, pid: 99 },
      ]),
    observeProcess: (pid) => {
      observed.push(pid);
      return Promise.resolve(identityOf(pid));
    },
    processStart: rootStartText,
  });
  expect(result).toEqual({
    escaped: [
      { pid: 12, processStart: identityOf(12).processStartIdentity },
      { pid: 13, processStart: identityOf(13).processStartIdentity },
    ],
    state: 'owned',
  });
  // In-group descendants are covered by the group and are not individually certified.
  expect(observed).not.toContain(11);
});

test('an escaped-descendant scan is unknown whenever the tree or the group cannot be certified', async () => {
  const rows = [
    { groupId: 10, parentPid: 1, pid: 10 },
    { groupId: 12, parentPid: 10, pid: 12 },
  ];
  const base = {
    groupId: 10,
    listProcesses: () => Promise.resolve(rows),
    observeProcess: (pid) => Promise.resolve(identityOf(pid)),
    processStart: rootStartText,
  };
  const unknown = { state: 'unknown' };
  // The root is no longer in the group it was proven to lead.
  await expect(
    findEscapedDescendants(10, {
      ...base,
      listProcesses: () =>
        Promise.resolve([
          { groupId: 77, parentPid: 1, pid: 10 },
          { groupId: 12, parentPid: 10, pid: 12 },
        ]),
    })
  ).resolves.toEqual(unknown);
  // The root changed identity, or the table cannot be read.
  await expect(
    findEscapedDescendants(10, {
      ...base,
      processStart: 'Mon Sep 21 10:11:11 2026',
    })
  ).resolves.toEqual(unknown);
  await expect(
    findEscapedDescendants(10, {
      ...base,
      listProcesses: () => Promise.reject(new Error('ps failed')),
    })
  ).resolves.toEqual(unknown);
  // An uncertain escapee, a duplicate row and an invalid group are never an empty list.
  await expect(
    findEscapedDescendants(10, {
      ...base,
      observeProcess: (pid) =>
        Promise.resolve(pid === 12 ? { state: 'unknown' } : identityOf(pid)),
    })
  ).resolves.toEqual(unknown);
  await expect(
    findEscapedDescendants(10, {
      ...base,
      listProcesses: () =>
        Promise.resolve([...rows, { groupId: 12, parentPid: 10, pid: 12 }]),
    })
  ).resolves.toEqual(unknown);
  await expect(
    findEscapedDescendants(10, { ...base, groupId: 0 })
  ).resolves.toEqual(unknown);
  await expect(
    findEscapedDescendants(10, { ...base, groupId: undefined })
  ).resolves.toEqual(unknown);
});

test('the root leaving its group while descendants are certified is unknown', async () => {
  let reads = 0;
  const result = await findEscapedDescendants(10, {
    groupId: 10,
    listProcesses: () => {
      reads += 1;
      return Promise.resolve([
        { groupId: reads > 2 ? 55 : 10, parentPid: 1, pid: 10 },
        { groupId: 12, parentPid: 10, pid: 12 },
      ]);
    },
    observeProcess: (pid) => Promise.resolve(identityOf(pid)),
    processStart: rootStartText,
  });
  expect(result).toEqual({ state: 'unknown' });
});

test('proving a group also reports descendants already outside it', async () => {
  const rows = [
    { groupId: 10, parentPid: 1, pid: 10 },
    { groupId: 10, parentPid: 10, pid: 11 },
    { groupId: 12, parentPid: 11, pid: 12 },
  ];
  await expect(
    proveProcessGroupOwnership(
      { groupId: 10, pid: 10, processStart: rootStartText },
      {
        listProcesses: () => Promise.resolve(rows),
        observeProcess: (pid) => Promise.resolve(identityOf(pid)),
      }
    )
  ).resolves.toEqual({
    escaped: [{ pid: 12, processStart: identityOf(12).processStartIdentity }],
    members: [10, 11],
    state: 'owned',
  });
});

test('an escaped-descendant scan stops certifying at its limit, while the full tree walker never truncates', async () => {
  const rows = [
    { groupId: 10, parentPid: 1, pid: 10 },
    ...Array.from({ length: 8 }, (_, i) => ({
      groupId: 20 + i,
      parentPid: 10,
      pid: 20 + i,
    })),
  ];
  const observed = [];
  const deps = {
    listProcesses: () => Promise.resolve(rows),
    observeProcess: (pid) => {
      observed.push(pid);
      return Promise.resolve(identityOf(pid));
    },
    processStart: rootStartText,
  };
  const bounded = await findEscapedDescendants(10, {
    ...deps,
    groupId: 10,
    limit: 3,
  });
  expect(bounded.state).toBe('owned');
  expect(bounded.escaped.map((e) => e.pid)).toEqual([20, 21, 22]);
  // Only the first three were individually certified; the rest cost nothing.
  expect(observed.filter((pid) => pid >= 20)).toEqual([20, 21, 22]);

  const whole = await findProcessChildren(10, { ...deps, limit: 1 });
  expect(whole.children).toHaveLength(8);
});
