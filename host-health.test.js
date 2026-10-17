import { expect, test } from 'bun:test';
import { assertStorageHeadroom, createHostHealth } from './host-health.js';
import { cloneBareRepoAsync } from './lib.js';

test('repository cloning refuses critically low space before its first command', async () => {
  const commands = [];
  await expect(
    cloneBareRepoAsync(
      '/isolated/workspace/repo.git',
      'git@example/repo',
      null,
      {
        readStorage: async () => ({
          availableBytes: 116 * 1024 ** 2,
          state: 'ready',
        }),
        // biome-ignore lint/suspicious/useAwait: The injected command runner must preserve its promise result contract.
        run: async (args) => {
          commands.push(args);
          return { code: 0, stderr: '', stdout: '' };
        },
      }
    )
  ).rejects.toMatchObject({ code: 'STORAGE_LOW' });
  expect(commands).toEqual([]);
});

test('health distinguishes the 20 GiB warning from the 10 GiB admission minimum', async () => {
  const read = createHostHealth('/isolated/workspace', {
    observe: async () => ({ availableBytes: 15 * 1024 ** 3 }),
  });
  expect(await read()).toMatchObject({
    critical: false,
    low: true,
    lowThresholdBytes: 20 * 1024 ** 3,
    minimumAvailableBytes: 10 * 1024 ** 3,
  });
});

test('admission refreshes a cached healthy observation and rejects unknown or invalid measurements', async () => {
  let availableBytes = 30 * 1024 ** 3,
    reads = 0;
  const read = createHostHealth('/isolated/workspace', {
    // biome-ignore lint/suspicious/useAwait: The observer fixture models asynchronous health reads while counting invocation order.
    observe: async () => {
      reads += 1;
      return { availableBytes };
    },
  });
  await read();
  availableBytes = 116 * 1024 ** 2;
  await expect(
    assertStorageHeadroom('/isolated/workspace', read)
  ).rejects.toMatchObject({ code: 'STORAGE_LOW' });
  expect(reads).toBe(2);
  availableBytes = 10 * 1024 ** 3;
  expect(
    (await assertStorageHeadroom('/isolated/workspace', read)).critical
  ).toBe(false);
});

test.each([
  { state: 'unknown' },
  ...[Number.NaN, Number.POSITIVE_INFINITY, -1, undefined, '999999999999'].map(
    (value) => ({
      availableBytes: value,
      state: 'ready',
    })
  ),
])('invalid storage observation is refused: %#', async (health) => {
  await expect(
    assertStorageHeadroom('/isolated/workspace', async () => health)
  ).rejects.toMatchObject({ code: 'STORAGE_UNKNOWN' });
});

test('filesystem status shares pending reads and caches without a background timer', async () => {
  let calls = 0,
    clock = 0,
    resolve;
  const timers = new Set();
  const read = createHostHealth('/owned', {
    cancel: (cb) => timers.delete(cb),
    now: () => clock,
    observe: () => {
      calls += 1;
      return new Promise((r) => {
        resolve = r;
      });
    },
    schedule: (cb) => {
      timers.add(cb);
      return cb;
    },
  });
  const a = read(),
    b = read();
  await Promise.resolve();
  expect(calls).toBe(1);
  resolve({
    availableBytes: 30 * 1024 ** 3,
    totalBytes: 10 * 1024 ** 3,
    volumeId: '1',
    workspacePath: '/owned',
  });
  expect(await a).toEqual(await b);
  expect((await a).low).toBe(false);
  expect(timers.size).toBe(0);
  clock = 59_999;
  await read();
  expect(calls).toBe(1);
  const refreshing = read({ refresh: true });
  await Promise.resolve();
  expect(calls).toBe(2);
  resolve({ availableBytes: 1024 });
  expect((await refreshing).low).toBe(true);
});

test('failure and timeout report unknown, never free/healthy; hung probes do not overlap', async () => {
  const failed = createHostHealth('/owned', {
    observe: () => Promise.reject(new Error('private path')),
  });
  expect(await failed()).toMatchObject({
    code: 'FILESYSTEM_UNAVAILABLE',
    dockerVm: { state: 'unknown' },
    state: 'unknown',
  });
  let timeout,
    calls = 0,
    time = 0;
  const read = createHostHealth('/owned', {
    cancel() {
      /* No side effect is needed in this fixture. */
    },
    now: () => time,
    observe: () => {
      calls += 1;
      return new Promise(() => {
        /* The pending operation is controlled by this test. */
      });
    },
    schedule: (cb) => {
      timeout = cb;
      return 1;
    },
  });
  const first = read();
  await Promise.resolve();
  timeout();
  expect(await first).toMatchObject({
    code: 'PROBE_TIMEOUT',
    state: 'unknown',
  });
  time = 100_000;
  const next = await read({ refresh: true });
  expect(next.availableBytes).toBeUndefined();
  expect(calls).toBe(1);
});
