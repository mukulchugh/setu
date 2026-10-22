import { expect, test } from 'bun:test';
import { createOwnedProcessGroup } from './owned-process-group.js';

const start = (second) =>
  `Mon Oct 20 09:00:${String(second).padStart(2, '0')} 2026`;
const row = (pid, parentPid, groupId, second = pid - 10) => ({
  groupId,
  parentPid,
  pid,
  processStartIdentity: start(second),
});

test('changed PID incarnation refuses signaling without targeting the replacement', () => {
  let rows = [row(10, 1, 10, 0), row(11, 10, 10, 1)];
  const signals = [];
  const group = createOwnedProcessGroup({
    groupId: 10,
    pid: 10,
    processStartIdentity: start(0),
    readSnapshot: () => rows,
    signal: (...args) => signals.push(args),
  });
  expect(group.observe().state).toBe('owned');
  rows = [row(10, 1, 10, 0), row(11, 10, 10, 9)];
  expect(group.signalOwned('SIGTERM')).toEqual({ ok: false, unknown: true });
  expect(signals).toEqual([]);
});

test('an unrelated member of the owned group makes the whole proof unknown', () => {
  const rows = [row(10, 1, 10, 0), row(11, 10, 10, 1), row(12, 1, 10, 2)];
  const group = createOwnedProcessGroup({
    groupId: 10,
    pid: 10,
    processStartIdentity: start(0),
    readSnapshot: () => rows,
    signal: () => {
      throw new Error('must not signal an unproven group');
    },
  });
  expect(group.observe()).toEqual({ state: 'unknown' });
  expect(group.signalOwned('SIGTERM')).toEqual({ ok: false, unknown: true });
});

test('observed escaped descendants remain individually owned after root exit', () => {
  let rows = [
    row(10, 1, 10, 0),
    row(11, 10, 10, 1),
    row(12, 11, 12, 2),
    row(13, 12, 13, 3),
  ];
  const signals = [];
  const group = createOwnedProcessGroup({
    groupId: 10,
    pid: 10,
    processStartIdentity: start(0),
    readSnapshot: () => rows,
    signal: (...args) => signals.push(args),
  });
  expect(group.observe().escaped).toEqual([
    { groupId: 12, pid: 12, processStart: start(2) },
    { groupId: 13, pid: 13, processStart: start(3) },
  ]);

  rows = [row(12, 1, 12, 2), row(13, 12, 13, 3)];
  expect(group.settled()).toEqual({ state: 'alive' });
  expect(group.signalOwned('SIGTERM')).toEqual({ ok: true });
  expect(signals).toEqual([
    [12, 'SIGTERM'],
    [13, 'SIGTERM'],
  ]);
});
