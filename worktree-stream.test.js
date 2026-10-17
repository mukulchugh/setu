import { expect, test } from 'bun:test';
import { createWorktreeStream } from './worktree-stream.js';

const payload = (checkedAt = 1) => ({
  checkedAt,
  listenerObservation: { observedAt: checkedAt, state: 'ready' },
  status: {},
  worktrees: [{ key: 'r/a' }],
});
const socket = () => ({
  send(s) {
    this.sent.push(JSON.parse(s));
  },
  sent: [],
  subscribe() {
    /* No side effect is needed in this fixture. */
  },
});

test('an old topic lifecycle cannot publish or deliver into a replacement lifecycle', async () => {
  const reads = [],
    timers = new Set(),
    broadcasts = [];
  const stream = createWorktreeStream({
    cancel: (cb) => timers.delete(cb),
    publish: (...args) => broadcasts.push(args),
    readSnapshot: () => new Promise((resolve) => reads.push(resolve)),
    schedule: (cb) => {
      timers.add(cb);
      return cb;
    },
  });
  const first = socket(),
    second = socket();
  const opening = stream.open(first);
  const [oldTick] = timers;
  oldTick();
  oldTick();
  expect(reads.length).toBe(2);
  stream.close(first);
  expect(timers.size).toBe(0);
  const replacement = stream.open(second);
  reads[0](payload());
  reads[1](payload());
  reads[2](payload());
  await opening;
  await replacement;
  expect(first.sent).toEqual([]);
  expect(second.sent.length).toBe(1);
  expect(broadcasts).toEqual([]);
  expect(timers.size).toBe(1);
  stream.close(second);
  expect(timers.size).toBe(0);
});

test('every connection receives immediately; unchanged ticks send a small check at most every 30 seconds', async () => {
  let clock = 0,
    tick;
  const broadcasts = [];
  const stream = createWorktreeStream({
    cancel() {
      /* No side effect is needed in this fixture. */
    },
    now: () => clock,
    publish: (_topic, data) => broadcasts.push(JSON.parse(data)),
    readSnapshot: async () => payload(clock),
    schedule: (cb) => {
      tick = cb;
      return 1;
    },
  });
  const first = socket(),
    second = socket();
  await stream.open(first);
  await tick();
  await Promise.resolve();
  await stream.open(second);
  expect(first.sent.length).toBe(1);
  expect(second.sent.length).toBe(1);
  clock = 29_999;
  await tick();
  await Promise.resolve();
  expect(broadcasts.length).toBe(1);
  clock = 30_000;
  await tick();
  await Promise.resolve();
  expect(broadcasts.map((v) => v.topic)).toEqual([
    'worktrees',
    'worktrees:checked',
  ]);
  clock = 30_001;
  await tick();
  await Promise.resolve();
  expect(broadcasts.length).toBe(2);
  expect(broadcasts[1].data.worktrees).toBeUndefined();
});

test('cold composition refreshes expired listeners before certifying its rows', async () => {
  const { readFreshWorktreeSnapshot } = await import('./worktree-stream.js');
  let clock = 0,
    observedAt = 0,
    reads = 0,
    compositions = 0;
  const result = await readFreshWorktreeSnapshot({
    listeners: {
      observation: () => ({ observedAt, state: 'ready' }),
      // biome-ignore lint/suspicious/useAwait: Listener observations preserve the asynchronous refresh contract.
      read: async () => {
        reads += 1;
        observedAt = clock;
      },
    },
    now: () => clock,
    status: () => Promise.resolve({}),
    // biome-ignore lint/suspicious/useAwait: Worktree composition preserves the asynchronous snapshot contract.
    worktrees: async () => {
      compositions += 1;
      if (compositions === 1) {
        clock = 10_000;
      }
      return [{ active: compositions > 1 }];
    },
  });
  expect(result.worktrees).toEqual([{ active: true }]);
  expect(reads).toBe(2);
  expect(result.listenerObservation).toEqual({
    observedAt: 10_000,
    state: 'ready',
  });
});
