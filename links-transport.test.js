import { afterEach, expect, test } from 'bun:test';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  ensureEngine,
  reapDaemons,
  temporaryLinksRoot,
  trackDaemon,
} from './links-engine-fixture.js';
import { createLinksTransport } from './links-transport.js';

// Built before any test runs so a first compile is never charged to a test's own time limit.
const ENGINE = ensureEngine();

const cleanups = [];
afterEach(async () => {
  try {
    for (const cleanup of cleanups.splice(0).reverse()) {
      // biome-ignore lint/performance/noAwaitInLoops: Daemons stop before their directories go.
      await cleanup();
    }
  } finally {
    // Whatever a test did or failed to do, a daemon it started does not outlive it.
    await reapDaemons();
  }
});

function setup(options = {}) {
  const { root, cleanup } = temporaryLinksRoot();
  const dataDir = join(root, 'links');
  const created = createLinksTransport({
    dataDir,
    enginePath: ENGINE,
    listen: '127.0.0.1:0',
    ...options,
  });
  const transport = {
    ...created,
    start: async () => {
      const result = await created.start();
      if (result.ok) {
        trackDaemon(result.result.pid, dataDir, ENGINE);
      }
      return result;
    },
  };
  cleanups.push(async () => {
    await transport.stop();
    cleanup();
  });
  return { dataDir, transport };
}

// A process that has been told to stop may take a moment to be reaped; give it that, no more.
async function gone(pid) {
  for (let waited = 0; waited < 3000; waited += 50) {
    if (!alive(pid)) {
      return true;
    }
    // biome-ignore lint/performance/noAwaitInLoops: Waiting for one process to leave.
    await Bun.sleep(50);
  }
  return false;
}

const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

test('asking about a stopped transport starts nothing and creates nothing', async () => {
  const { dataDir, transport } = setup();
  for (let round = 0; round < 3; round += 1) {
    // biome-ignore lint/performance/noAwaitInLoops: Repeated reads are the point.
    expect(await transport.status()).toEqual({
      ok: true,
      result: { running: false },
    });
  }
  expect(existsSync(dataDir)).toBe(false);
});

test('starting twice, even at the same moment, yields one running daemon', async () => {
  const { transport } = setup();
  const [first, second] = await Promise.all([
    transport.start(),
    transport.start(),
  ]);
  expect(first.ok && second.ok).toBe(true);
  expect(first.result.pid).toBe(second.result.pid);
  const again = await transport.start();
  expect(again).toMatchObject({
    ok: true,
    result: { pid: first.result.pid, state: 'already-running' },
  });
  const status = await transport.status();
  expect(status.result).toMatchObject({
    pid: first.result.pid,
    running: true,
  });
  expect(status.result.listen[0]).toMatch(LOOPBACK);
});

const LOOPBACK = /^127\.0\.0\.1:\d+$/;

test('stopping ends the daemon this directory runs, and nothing else', async () => {
  const { transport } = setup();
  const started = await transport.start();
  expect(alive(started.result.pid)).toBe(true);
  expect(await transport.stop()).toMatchObject({
    ok: true,
    result: { state: 'stopped' },
  });
  expect(await gone(started.result.pid)).toBe(true);
  expect(await transport.status()).toEqual({
    ok: true,
    result: { running: false },
  });
});

test('stopping something that is not running signals nobody', async () => {
  const signalled = [];
  const { transport } = setup({ signal: (pid) => signalled.push(pid) });
  expect(await transport.stop()).toMatchObject({
    ok: true,
    result: { state: 'not-running' },
  });
  expect(signalled).toEqual([]);
});

// A harmless process that stands in for an unrelated program that now holds a recycled process ID.
function bystander() {
  const child = Bun.spawn(['sleep', '60'], { stdout: 'ignore' });
  cleanups.push(() => child.kill());
  return child;
}

const claims = (pid, startedAt) => ({
  call: () =>
    Promise.resolve({
      ok: true,
      result: {
        listen: ['127.0.0.1:1'],
        peer_id: 'a'.repeat(64),
        pid,
        running: true,
        started_at: startedAt,
      },
    }),
});

test('a status file naming an unrelated live process makes stop refuse and signal nothing', async () => {
  const other = bystander();
  const signalled = [];
  const { transport } = setup({
    client: claims(other.pid, Date.now()),
    signal: (...args) => signalled.push(args),
  });
  expect(await transport.stop()).toMatchObject({
    code: 'LINKS_TRANSPORT_NOT_OWNED',
    ok: false,
  });
  expect(signalled).toEqual([]);
  expect(alive(other.pid)).toBe(true);
});

test('a live process that started after the daemon it is said to be is never signalled', async () => {
  const other = bystander();
  // Everything but the start time is made to look right: the command line names this engine and directory.
  const signalled = [];
  const { dataDir, transport } = setup({
    client: claims(other.pid, Date.now() - 3_600_000),
    commandOf: () => Promise.resolve(`${ENGINE} serve --data-dir ${dataDir}`),
    signal: (...args) => signalled.push(args),
  });
  expect(await transport.stop()).toMatchObject({
    code: 'LINKS_TRANSPORT_NOT_OWNED',
    ok: false,
  });
  expect(signalled).toEqual([]);
  expect(alive(other.pid)).toBe(true);
});

test('a leftover status file after the daemon was killed neither reads as running nor lets stop signal a recycled ID', async () => {
  const { dataDir, transport } = setup();
  const started = await transport.start();
  process.kill(started.result.pid, 'SIGKILL');
  await Bun.sleep(300);
  expect(existsSync(join(dataDir, 'serve.json'))).toBe(true);
  expect(await transport.status()).toEqual({
    ok: true,
    result: { running: false },
  });
  const signalled = [];
  const guarded = createLinksTransport({
    dataDir,
    enginePath: ENGINE,
    signal: (...args) => signalled.push(args),
  });
  expect(await guarded.stop()).toMatchObject({
    ok: true,
    result: { state: 'not-running' },
  });
  expect(signalled).toEqual([]);
});

test('a daemon that cannot be started is reported, not assumed', async () => {
  const { root, cleanup } = temporaryLinksRoot();
  cleanups.push(cleanup);
  const transport = createLinksTransport({
    dataDir: join(root, 'links'),
    enginePath: join(root, 'absent'),
    readyTimeoutMs: 500,
  });
  expect(await transport.start()).toMatchObject({
    code: 'LINKS_TRANSPORT_START_FAILED',
    ok: false,
  });
});

const MODEL_ENGINE = '/engines/links/target/debug/setu-links';

test('only this directory’s exact serve command line is recognised as its daemon', async () => {
  const other = bystander();
  const dataDir = '/tmp/links';
  const verdicts = {};
  const forms = {
    doubledSpace: `${MODEL_ENGINE}  serve --data-dir ${dataDir}`,
    exact: `${MODEL_ENGINE} serve --data-dir ${dataDir}`,
    exactWithListen: `${MODEL_ENGINE} serve --data-dir ${dataDir} --listen 127.0.0.1:0`,
    extraArgument: `${MODEL_ENGINE} serve --data-dir ${dataDir} --other`,
    listenWithSpace: `${MODEL_ENGINE} serve --data-dir ${dataDir} --listen a b`,
    longerPath: `${MODEL_ENGINE} serve --data-dir ${dataDir}/nested`,
    otherEngine: `${MODEL_ENGINE}-other serve --data-dir ${dataDir}`,
    siblingDirectory: `${MODEL_ENGINE} serve --data-dir ${dataDir}-2`,
    twoListens: `${MODEL_ENGINE} serve --data-dir ${dataDir} --listen a --listen b`,
    wrapped: `/bin/sh -c "${MODEL_ENGINE} serve --data-dir ${dataDir}"`,
  };
  for (const [name, command] of Object.entries(forms)) {
    const signalled = [];
    const transport = createLinksTransport({
      client: claims(other.pid, Date.now()),
      commandOf: () => Promise.resolve(command),
      dataDir,
      enginePath: MODEL_ENGINE,
      signal: (...args) => signalled.push(args),
      stopTimeoutMs: 100,
    });
    // biome-ignore lint/performance/noAwaitInLoops: One verdict per command line.
    await transport.stop();
    verdicts[name] = signalled.length === 1;
  }
  expect(verdicts).toEqual({
    doubledSpace: false,
    exact: true,
    exactWithListen: true,
    extraArgument: false,
    listenWithSpace: false,
    longerPath: false,
    otherEngine: false,
    siblingDirectory: false,
    twoListens: false,
    wrapped: false,
  });
});

test('a lost reply to an identity request is an unknown outcome, because it may have made the key', async () => {
  const { root, cleanup } = temporaryLinksRoot();
  cleanups.push(cleanup);
  const { createLinksClient } = await import('./links-client.js');
  const client = createLinksClient({
    dataDir: join(root, 'links'),
    enginePath: join(root, 'absent'),
  });
  expect(await client.call('identity', {})).toMatchObject({
    code: 'LINKS_OUTCOME_UNKNOWN',
    ok: false,
  });
});

test('a start that the engine refuses reports why at once instead of waiting out the timeout', async () => {
  const { dataDir, transport } = setup({ readyTimeoutMs: 20_000 });
  mkdirSync(dataDir, { mode: 0o700, recursive: true });
  writeFileSync(join(dataDir, 'transport.key'), Buffer.alloc(31), {
    mode: 0o600,
  });
  const began = Date.now();
  const refused = await transport.start();
  expect(Date.now() - began).toBeLessThan(5000);
  expect(refused).toMatchObject({
    code: 'LINKS_TRANSPORT_START_FAILED',
    details: { engineCode: 'TRANSPORT_KEY_INVALID' },
    ok: false,
  });
  expect(refused.error).toContain('transport.key');
  expect(existsSync(join(dataDir, 'serve.lock'))).toBe(false);
});

test('the fixture reaps a daemon the owner refused to stop, and touches nothing else', async () => {
  // The owner recognises the daemon while it starts (it must, to call it ready) and stops recognising it afterwards,
  // as a mutated or confused owner might: the fixture must still clean up.
  const flags = new Set();
  const { dataDir, transport } = setup({
    commandOf: (pid) =>
      Promise.resolve(
        flags.has('confused')
          ? 'something else entirely'
          : Bun.spawnSync(['ps', '-p', String(pid), '-o', 'command='])
              .stdout.toString()
              .trim()
      ),
  });
  const started = await transport.start();
  expect(started.ok).toBe(true);
  flags.add('confused');
  expect(await transport.stop()).toMatchObject({
    code: 'LINKS_TRANSPORT_NOT_OWNED',
  });
  expect(alive(started.result.pid)).toBe(true);

  const innocent = bystander();
  trackDaemon(innocent.pid, dataDir, ENGINE);
  await reapDaemons();
  expect(await gone(started.result.pid)).toBe(true);
  // A recorded process that no longer looks like this directory’s daemon is left alone.
  expect(alive(innocent.pid)).toBe(true);
});

// A status source that answers from a script: a stale file from a dead daemon first, then the real one.
function scripted(answers) {
  let calls = 0;
  return {
    call: () => {
      const answer = answers[Math.min(calls, answers.length - 1)];
      calls += 1;
      return Promise.resolve({ ok: true, result: answer });
    },
    calls: () => calls,
  };
}

const exactCommand = (dataDir) => `${ENGINE} serve --data-dir ${dataDir}`;

test('a status file left by a dead daemon is never taken for the daemon that is starting', async () => {
  const dead = Bun.spawnSync(['true']).pid;
  const live = bystander();
  const dataDir = '/tmp/links-race';
  const client = scripted([
    { running: false },
    // The new daemon holds the lock but has not rewritten its file: the old one still names a process that is gone.
    {
      listen: ['127.0.0.1:1'],
      pid: dead,
      running: true,
      started_at: Date.now() - 60_000,
    },
    {
      listen: ['127.0.0.1:2'],
      pid: live.pid,
      running: true,
      started_at: Date.now(),
    },
  ]);
  const transport = createLinksTransport({
    client,
    commandOf: () => Promise.resolve(exactCommand(dataDir)),
    dataDir,
    enginePath: ENGINE,
    readyTimeoutMs: 5000,
    spawn: () => ({ exitCode: null, pid: live.pid, unref: () => undefined }),
  });
  const started = await transport.start();
  expect(started).toEqual({
    ok: true,
    result: { pid: live.pid, state: 'started' },
  });
  expect(client.calls()).toBeGreaterThanOrEqual(3);
});

test('a status file naming a live process that is not this daemon is not ready either', async () => {
  const unrelated = bystander();
  const dataDir = '/tmp/links-race';
  const transport = createLinksTransport({
    client: scripted([
      {
        listen: ['127.0.0.1:1'],
        pid: unrelated.pid,
        running: true,
        started_at: Date.now(),
      },
    ]),
    commandOf: () => Promise.resolve('/bin/sleep 60'),
    dataDir,
    enginePath: ENGINE,
    readyTimeoutMs: 600,
    spawn: () => ({
      exitCode: null,
      pid: unrelated.pid,
      unref: () => undefined,
    }),
  });
  expect(await transport.start()).toMatchObject({
    code: 'LINKS_TRANSPORT_START_FAILED',
    ok: false,
  });
});

test('starting again right after a daemon was killed always reports the daemon that is actually running', async () => {
  const { transport } = setup();
  for (let round = 0; round < 8; round += 1) {
    // biome-ignore lint/performance/noAwaitInLoops: Each round depends on the one before.
    const started = await transport.start();
    expect(started.ok).toBe(true);
    const status = await transport.status();
    expect(status.result.pid).toBe(started.result.pid);
    expect(alive(started.result.pid)).toBe(true);
    process.kill(started.result.pid, 'SIGKILL');
    await gone(started.result.pid);
  }
});

test('the fixture never reaps a process whose command line merely starts like the recorded daemon', async () => {
  const first = setup();
  const second = setup();
  const near = await second.transport.start();
  expect(near.ok).toBe(true);
  // Recorded under the wrong directory: its real command line names another directory, so it is not this one.
  trackDaemon(near.result.pid, first.dataDir, ENGINE);
  await reapDaemons();
  expect((await second.transport.status()).result.running).toBe(true);
  // And a directory that is a prefix of the real one is not the real one. (A signalled daemon can linger as a
  // zombie that still answers signal 0, so what is asked is whether the daemon still holds its lock.)
  trackDaemon(near.result.pid, second.dataDir.slice(0, -1), ENGINE);
  await reapDaemons();
  expect((await second.transport.status()).result.running).toBe(true);
});

test('an observer that throws or answers with nonsense leaves ownership unknown instead of rejecting start or stop', async () => {
  const live = bystander();
  const dataDir = '/tmp/links-observer';
  const running = {
    listen: ['127.0.0.1:1'],
    pid: live.pid,
    running: true,
    started_at: Date.now(),
  };
  const observers = {
    aliveWithoutAStart: () => Promise.resolve({ state: 'alive' }),
    emptyObject: () => Promise.resolve({}),
    nothing: () => Promise.resolve(undefined),
    nullAnswer: () => Promise.resolve(null),
    rejects: () => Promise.reject(new Error('ps is unavailable')),
    throwsAtOnce: () => {
      throw new Error('no such helper');
    },
    unreadableStart: () =>
      Promise.resolve({ processStartIdentity: 42, state: 'alive' }),
  };
  for (const [name, observe] of Object.entries(observers)) {
    const signalled = [];
    const transport = createLinksTransport({
      client: scripted([running]),
      commandOf: () => Promise.resolve(exactCommand(dataDir)),
      dataDir,
      enginePath: ENGINE,
      observe,
      readyTimeoutMs: 300,
      signal: (...args) => signalled.push(args),
      spawn: () => ({ exitCode: null, pid: live.pid, unref: () => undefined }),
    });
    // biome-ignore lint/performance/noAwaitInLoops: One verdict per observer.
    const stopped = await transport.stop();
    expect(stopped, name).toMatchObject({
      code: 'LINKS_TRANSPORT_NOT_OWNED',
      ok: false,
    });
    expect(signalled, name).toEqual([]);
    const started = await transport.start();
    expect(started, name).toMatchObject({
      code: 'LINKS_TRANSPORT_START_FAILED',
      ok: false,
    });
  }
});

test('a command-line reader that fails or answers with nonsense also leaves ownership unknown', async () => {
  const live = bystander();
  const running = {
    listen: ['127.0.0.1:1'],
    pid: live.pid,
    running: true,
    started_at: Date.now(),
  };
  const readers = {
    nothing: () => Promise.resolve(undefined),
    number: () => Promise.resolve(42),
    rejects: () => Promise.reject(new Error('ps is unavailable')),
    throwsAtOnce: () => {
      throw new Error('no such helper');
    },
  };
  for (const [name, commandOf] of Object.entries(readers)) {
    const signalled = [];
    const transport = createLinksTransport({
      client: scripted([running]),
      commandOf,
      dataDir: '/tmp/links-reader',
      enginePath: ENGINE,
      signal: (...args) => signalled.push(args),
    });
    // biome-ignore lint/performance/noAwaitInLoops: One verdict per reader.
    expect(await transport.stop(), name).toMatchObject({
      code: 'LINKS_TRANSPORT_NOT_OWNED',
      ok: false,
    });
    expect(signalled, name).toEqual([]);
  }
});
