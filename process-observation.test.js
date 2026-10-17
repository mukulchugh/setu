import { expect, test } from 'bun:test';
import { observeProcessIdentity } from './process-observation.js';

const processStartPattern = /\d{2}:\d{2}:\d{2} \d{4}$/;

test('process observation distinguishes proven absence, unknown access and a stable start identity without signalling', async () => {
  const calls = [];
  const options = {
    run: () => Promise.resolve(' Mon Sep 21 10:11:12 2026\n'),
    signal: (pid, signal) => calls.push([pid, signal]),
  };
  expect(await observeProcessIdentity(321, options)).toEqual({
    processId: 321,
    processStartIdentity: 'Mon Sep 21 10:11:12 2026',
    state: 'alive',
  });
  expect(calls.every(([, signal]) => signal === 0)).toBe(true);
  expect(
    await observeProcessIdentity(321, {
      ...options,
      signal: () => {
        throw Object.assign(new Error('fixture signal refused'), {
          code: 'ESRCH',
        });
      },
    })
  ).toEqual({ state: 'absent' });
  expect(
    await observeProcessIdentity(321, {
      ...options,
      signal: () => {
        throw Object.assign(new Error('fixture signal refused'), {
          code: 'EPERM',
        });
      },
    })
  ).toEqual({ state: 'unknown' });
  expect(
    await observeProcessIdentity(321, {
      ...options,
      run: () => Promise.resolve(''),
    })
  ).toEqual({ state: 'unknown' });
});

test('the native observation adapter reads only the current isolated test process', async () => {
  const result = await observeProcessIdentity(process.pid);
  expect(result).toMatchObject({ processId: process.pid, state: 'alive' });
  expect(result.processStartIdentity).toMatch(processStartPattern);
});
