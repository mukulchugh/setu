import { expect, test } from 'bun:test';
import { createCommandRunner, createDevRuntime } from './dev-runtime.js';

test('a rejected command exit observation is unknown even when output streams completed', async () => {
  const run = createCommandRunner(() => ({
    exited: Promise.reject(new Error('exit observer failed')),
    signalCode: null,
    stderr: null,
    stdout: new Blob(['partial']).stream(),
  }));
  await expect(run(['fixture'])).rejects.toMatchObject({
    code: 'OPERATION_UNKNOWN',
  });
});

test('an unknown exit returns while output remains open and an invalid exit code is also unknown', async () => {
  const run = createCommandRunner(() => ({
    exited: Promise.reject(new Error('observer failed')),
    stderr: null,
    stdout: new ReadableStream({
      start() {
        /* No side effect is needed in this fixture. */
      },
    }),
  }));
  await expect(run(['fixture'])).rejects.toMatchObject({
    code: 'OPERATION_UNKNOWN',
  });
  const invalid = createCommandRunner(() => ({
    exited: Promise.resolve(null),
    stderr: null,
    stdout: null,
  }));
  await expect(invalid(['fixture'])).rejects.toMatchObject({
    code: 'OPERATION_UNKNOWN',
  });
});

test('a failed output stream does not release command ownership before known exit', async () => {
  let finish,
    returned = false;
  const exited = new Promise((resolve) => {
    finish = resolve;
  });
  const run = createCommandRunner(() => ({
    exited,
    stderr: null,
    stdout: new ReadableStream({
      start(controller) {
        controller.error(new Error('output failed'));
      },
    }),
  }));
  const outcome = run(['fixture']).catch((error) => {
    returned = true;
    return error;
  });
  for (let i = 0; i < 10; i += 1) {
    await Promise.resolve();
  }
  expect(returned).toBe(false);
  finish(1);
  expect((await outcome).message).toBe('output failed');
});

const t = {
  key: 'r/a',
  name: 'a',
  port: 3301,
  project: 'setu-r-a-exact',
  repo: 'r',
  wtDir: '/isolated/r/a',
};

function platform(overrides = {}) {
  let time = 0;
  const alive = new Set();
  const signals = [],
    launches = [],
    closed = [];
  const deps = {
    clock: {
      now: () => time,
      sleep: async (ms) => {
        time += ms;
      },
    },
    closeLog: (fd) => closed.push(fd),
    composeDown: () => {
      /* No side effect is needed in this fixture. */
      return Promise.resolve();
    },
    containerState: () => Promise.resolve('dead'),
    discover: () => Promise.resolve({ state: 'dead' }),
    openLog: () => 99,
    prepareBare: () => Promise.resolve({ PORT: '3301' }),
    prepareContainer: () =>
      Promise.resolve('/isolated/r/a/docker-compose.setu.yml'),
    sidecarStops: [],
    signal(pid, signal) {
      if (!alive.has(Math.abs(pid))) {
        throw Object.assign(new Error('absent'), { code: 'ESRCH' });
      }
      if (signal !== 0) {
        signals.push([pid, signal]);
        alive.delete(Math.abs(pid));
      }
    },
    spawn(args, options) {
      const proc = {
        exited: new Promise(() => {
          /* The pending operation is controlled by this test. */
        }),
        pid: 101,
      };
      alive.add(101);
      launches.push({ args, options });
      return proc;
    },
    startSidecars: () => Promise.resolve([]),
    ...overrides,
  };
  return {
    alive,
    closed,
    deps,
    launches,
    runtime: createDevRuntime(deps),
    signals,
  };
}

test('owned Compose launch attaches both output streams and Stop signals its wrapper group without deleting volumes', async () => {
  const downs = [];
  const f = platform({ composeDown: async (...args) => downs.push(args) });
  let handle;
  await f.runtime.launch(
    t,
    {
      container: true,
      limits: { cpus: 2, memMb: 1024 },
      port: 3301,
      project: t.project,
    },
    (value) => {
      handle = value;
    }
  );
  expect(f.launches[0].args).toEqual([
    'docker',
    'compose',
    '-p',
    t.project,
    '-f',
    '/isolated/r/a/docker-compose.setu.yml',
    'up',
    '--build',
    '--no-color',
  ]);
  expect(f.launches[0].options).toMatchObject({
    detached: true,
    stderr: 99,
    stdout: 99,
  });
  expect(f.closed).toEqual([99]);
  await f.runtime.stop(t, handle);
  expect(f.signals).toEqual([[-101, 'SIGTERM']]);
  expect(downs).toEqual([[t.project, '/isolated/r/a/docker-compose.setu.yml']]);
});

test('adopted listeners signal only the exact PID and every sidecar stop settles on failure', async () => {
  let settle;
  const pending = new Promise((resolve) => {
    settle = resolve;
  });
  let completed = false;
  const f = platform({
    sidecarStops: [
      () => {
        return Promise.reject(new Error('sidecar exit unknown'));
      },
      async () => {
        await pending;
        completed = true;
      },
    ],
  });
  f.alive.add(303);
  const stopping = f.runtime.stop(t, { ownedGroup: false, pid: 303 });
  await Promise.resolve();
  expect(completed).toBe(false);
  settle();
  await expect(stopping).resolves.toEqual({
    warnings: ['sidecar exit unknown'],
  });
  expect(completed).toBe(true);
  expect(f.signals).toEqual([[303, 'SIGTERM']]);
});

test('a dead attached process does not release an alive or unknown container', async () => {
  let state = 'alive';
  const f = platform({ containerState: async () => state });
  const handle = { container: t.project, ownedGroup: true, pid: 303 };
  expect(await f.runtime.observe(t, handle)).toBe('alive');
  state = 'unknown';
  expect(await f.runtime.observe(t, handle)).toBe('unknown');
  await expect(f.runtime.stop(t, handle)).rejects.toThrow(
    'exit is not confirmed'
  );
  expect(f.signals).toEqual([]);
});

test('unresolved boot ownership without a PID never becomes a confirmed dead runtime', async () => {
  const f = platform({ discover: () => Promise.resolve({ state: 'unknown' }) });
  expect(
    await f.runtime.observe(t, { observedState: 'unknown', pid: null })
  ).toBe('unknown');
  await expect(
    f.runtime.stop(t, { observedState: 'unknown', pid: null })
  ).rejects.toThrow(`process on port ${t.port}`);
});

test('a replaced adopted PID is never signalled', async () => {
  const f = platform({ verifyHandle: () => Promise.resolve(false) });
  f.alive.add(303);
  expect(await f.runtime.observe(t, { ownedGroup: false, pid: 303 })).toBe(
    'unknown'
  );
  await expect(
    f.runtime.stop(t, { ownedGroup: false, pid: 303 })
  ).rejects.toThrow('identity changed');
  expect(f.signals).toEqual([]);
  f.alive.delete(303);
  expect(await f.runtime.observe(t, { ownedGroup: false, pid: 303 })).toBe(
    'dead'
  );
});

test('Stop waits through transient post-signal unknown until the owned group is confirmed absent', async () => {
  let state = 'alive',
    now = 0;
  const signals = [];
  const runtime = createDevRuntime({
    clock: {
      now: () => now,
      sleep: async (ms) => {
        now += ms;
        state = 'dead';
      },
    },
    signal(pid, value) {
      if (state !== 'alive') {
        throw Object.assign(new Error(), {
          code: state === 'dead' ? 'ESRCH' : 'EPERM',
        });
      }
      if (value !== 0) {
        signals.push([pid, value]);
        state = 'unknown';
      }
    },
  });
  await runtime.stopProcess({ ownedGroup: true, pid: 123 });
  expect(signals).toEqual([[-123, 'SIGTERM']]);
  expect(now).toBe(50);
});

test('initial unknown receives no signal and persistent post-TERM unknown never escalates', async () => {
  for (const initial of ['unknown', 'alive']) {
    let state = initial,
      now = 0;
    const signals = [];
    const runtime = createDevRuntime({
      clock: {
        now: () => now,
        sleep: async (ms) => {
          now += ms;
        },
      },
      signal(pid, value) {
        if (state === 'unknown') {
          throw Object.assign(new Error(), { code: 'EPERM' });
        }
        if (value !== 0) {
          signals.push([pid, value]);
          state = 'unknown';
        }
      },
    });
    await expect(
      runtime.stopProcess({ ownedGroup: true, pid: 123 })
    ).rejects.toThrow('unknown');
    expect(signals).toEqual(initial === 'unknown' ? [] : [[-123, 'SIGTERM']]);
    expect(now).toBe(initial === 'unknown' ? 0 : 5000);
  }
});

test('a delayed command leaves unrelated reads responsive and preserves bounded failure diagnostics', async () => {
  let finish;
  const exited = new Promise((resolve) => {
    finish = resolve;
  });
  const run = createCommandRunner(() => ({
    exited,
    signalCode: null,
    stderr: new Blob(['failure']).stream(),
    stdout: new Blob(['x'.repeat(40)]).stream(),
  }));
  let settled = false;
  const result = run(['git', 'clone'], { maxOutputBytes: 16 }).then((value) => {
    settled = true;
    return value;
  });
  expect(await Promise.resolve('status')).toBe('status');
  expect(settled).toBe(false);
  finish(2);
  expect(await result).toMatchObject({
    code: 2,
    stderr: 'failure',
    stdout: 'x'.repeat(16),
    truncated: true,
  });
});

test('command success with truncated stderr does not report truncated stdout', async () => {
  const run = createCommandRunner((args, options) => Bun.spawn(args, options));
  const result = await run(
    [process.execPath, '-e', "process.stderr.write('x'.repeat(9000))"],
    { maxOutputBytes: 16 }
  );
  expect(result).toMatchObject({
    code: 0,
    stderrTruncated: true,
    truncated: false,
  });
});

test('a placeholder handle observes a fresh discovery result and Stop gives a port-specific recovery action', async () => {
  const f = platform({ discover: () => Promise.resolve({ state: 'dead' }) });
  expect(
    await f.runtime.observe(t, { observedState: 'unknown', pid: null })
  ).toBe('dead');
  const unknown = platform({
    discover: () => Promise.resolve({ state: 'unknown' }),
  });
  await expect(
    unknown.runtime.stop(t, { observedState: 'unknown', pid: null })
  ).rejects.toThrow(`process on port ${t.port}`);
});

test('a gone owned process group is never signalled after its first ESRCH probe', async () => {
  const f = platform();
  const handle = { ownedGroup: true, pid: 303 };
  expect(await f.runtime.observe(t, handle)).toBe('dead');
  expect(handle.groupGone).toBe(true);
  f.alive.add(303);
  await f.runtime.stopProcess(handle);
  expect(f.signals).toEqual([]);
});

test('a successful main Stop returns rejected sidecars as warnings', async () => {
  const f = platform({
    sidecarStops: [() => Promise.reject(new Error('Trigger could not stop'))],
  });
  f.alive.add(303);
  await expect(
    f.runtime.stop(t, { ownedGroup: false, pid: 303 })
  ).resolves.toEqual({ warnings: ['Trigger could not stop'] });
});

test('restart lifecycle calls runtime without sidecars', async () => {
  const f = platform();
  let handle;
  await f.runtime.launch(
    t,
    { container: false, limits: null, port: t.port, project: t.project },
    (value) => {
      handle = value;
    },
    { sidecars: false }
  );
  await f.runtime.stop(t, handle, { sidecars: false });
  expect(f.signals).toEqual([[-101, 'SIGTERM']]);
});
