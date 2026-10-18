import { expect, test } from 'bun:test';
import {
  observeProcessGroup,
  observeProcessIdentity,
} from './process-observation.js';

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

test('group observation reads only the presence of a group and never terminates it', () => {
  const calls = [];
  const refuse = (code) => () => {
    throw Object.assign(new Error('fixture signal refused'), { code });
  };
  expect(
    observeProcessGroup(321, {
      signal: (pid, value) => calls.push([pid, value]),
    })
  ).toBe('alive');
  expect(calls).toEqual([[-321, 0]]);
  expect(observeProcessGroup(321, { signal: refuse('ESRCH') })).toBe('absent');
  expect(observeProcessGroup(321, { signal: refuse('EPERM') })).toBe('unknown');
  expect(observeProcessGroup(321, { signal: refuse('EINVAL') })).toBe(
    'unknown'
  );
  // A collaborator that throws something that is not an Error is still just unknown.
  for (const thrown of [null, undefined, 'ESRCH', 0, {}]) {
    expect(
      observeProcessGroup(321, {
        signal: () => {
          throw thrown;
        },
      })
    ).toBe('unknown');
  }
  for (const invalid of [0, -1, 1.5, Number.NaN, '5', null, undefined]) {
    expect(
      observeProcessGroup(invalid, {
        signal: () => {
          throw new Error('an invalid group must not be probed');
        },
      })
    ).toBe('unknown');
  }
});

test('the native group observer sees the presence of the test process group', () => {
  expect(['alive', 'absent', 'unknown']).toContain(
    observeProcessGroup(process.pid)
  );
  expect(observeProcessGroup(2 ** 22 + 12_345)).not.toBe('alive');
});
