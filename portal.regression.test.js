import { expect, test } from 'bun:test';
import { createDevRuntime } from './dev-runtime.js';
import { composeDownAsync } from './lib.js';
import { createPortalRuntime } from './portal.js';

const config = {
  tunnel: 'fixture',
  workspace: '/private/tmp/setu-portal-tests',
};
const runtime = (options = {}) => createPortalRuntime({ config, ...options });
const deferred = () => {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
};

test('duplicate log subscription does not leak a timer or subscriber count', async () => {
  let timers = 0;
  let cleared = 0;
  const portal = await runtime({
    logPath: () => '/fixture.log',
    timers: {
      clearInterval: () => {
        cleared += 1;
      },
      setInterval: () => ++timers,
    },
  });
  const ws = { data: new Set(), send() {}, subscribe() {}, unsubscribe() {} };
  portal.wsSubscribeLog(ws, 'logs:r/a/dev');
  portal.wsSubscribeLog(ws, 'logs:r/a/dev');
  expect(timers).toBe(1);
  portal.wsUnsubscribeLog(ws, 'logs:r/a/dev');
  expect(cleared).toBe(1);
  await portal.dispose();
});

test('Docker teardown propagates failure instead of reporting a removed container', async () => {
  await expect(
    composeDownAsync('fixture', '/fixture.yml', [], {
      spawn: () => ({
        exited: Promise.resolve(1),
        stderr: new Blob(['daemon refused teardown']).stream(),
      }),
    })
  ).rejects.toThrow('daemon refused teardown');
});

test('GitHub cache misses share work and never exceed four concurrent requests', async () => {
  const gates = [];
  const portal = await runtime({
    projects: {},
    spawnText: () => {
      const gate = deferred();
      gates.push(gate);
      return gate.promise;
    },
  });
  const { fetchPR } = portal.internals;
  const same = [fetchPR('r', 'a'), fetchPR('r', 'a')];
  const others = ['b', 'c', 'd', 'e', 'f'].map((branch) =>
    fetchPR('r', branch)
  );
  expect(gates).toHaveLength(4);
  for (let index = 0; index < 6; index += 1) {
    gates[index].resolve('{"number":1,"state":"OPEN"}');
    await Promise.resolve();
    await Promise.resolve();
  }
  await Promise.all([...same, ...others]);
  expect(gates).toHaveLength(6);
  await portal.dispose();
});

test('concurrent worktree reads share one computation and clear after completion', async () => {
  const gate = deferred();
  let count = 0;
  const portal = await runtime({
    computeWorktrees: () => {
      count += 1;
      return gate.promise;
    },
  });
  const first = portal.internals.getWorktrees();
  expect(portal.internals.getWorktrees()).toBe(first);
  expect(count).toBe(1);
  gate.resolve([]);
  await first;
  await portal.internals.getWorktrees();
  expect(count).toBe(2);
  await portal.dispose();
});

test('metadata refresh deduplicates asynchronous Git reads and reuses the shared parsers', async () => {
  let calls = 0;
  const portal = await runtime({
    spawnText: async (args) => {
      calls += 1;
      if (args.includes('symbolic-ref')) {
        return 'main';
      }
      if (args.includes('worktree')) {
        return 'worktree /fixture/alias\nbranch refs/heads/real-branch\n';
      }
      if (args.includes('--format=%(refname)')) {
        return 'refs/heads/staging/subbranch';
      }
      expect(args.some((arg) => arg.includes('ahead-behind:origin/main'))).toBe(
        true
      );
      return 'real-branch\t1700000000\t3 7';
    },
  });
  const [first, second] = await Promise.all([
    portal.internals.repoGitMeta('r'),
    portal.internals.repoGitMeta('r'),
  ]);
  expect(calls).toBe(4);
  expect(first).toBe(second);
  expect(first.pathToBranch.get('/fixture/alias')).toBe('real-branch');
  expect(first.branchMeta.get('real-branch')).toEqual({
    ahead: 3,
    behind: 7,
    lastCommitAt: 1_700_000_000,
  });
  await portal.internals.repoGitMeta('r');
  expect(calls).toBe(4);
  await portal.dispose();
});

test('bare memory includes script-wrapper descendants, but excludes unrelated processes', async () => {
  const portal = await runtime({
    processMemory: async () => [
      { pgid: 1, pid: 1, ppid: 0, rss: 1000 },
      { pgid: 1, pid: 2, ppid: 1, rss: 23_000 },
      { pgid: 1, pid: 3, ppid: 2, rss: 8000 },
      { pgid: 4, pid: 4, ppid: 0, rss: 90_000 },
    ],
  });
  const rows = await portal.internals.processTree({ ownedGroup: true, pid: 1 });
  expect(rows.map((row) => row.pid)).toEqual([1, 2, 3]);
  expect(rows.reduce((sum, row) => sum + row.rss, 0) / 1024).toBe(31.25);
  expect(await portal.internals.processTree({ pid: 100 })).toEqual([]);
  await portal.dispose();
});

test('real detached process and child both exit on Stop without a listening port', async () => {
  const childCode =
    'console.log(process.pid); setTimeout(() => process.exit(0), 20000);';
  const parentCode = `Bun.spawn([process.execPath, '-e', ${JSON.stringify(childCode)}], {stdout:'inherit', stderr:'ignore'}); console.log(process.pid); setTimeout(() => process.exit(0), 20000);`;
  const proc = Bun.spawn([process.execPath, '-e', parentCode], {
    detached: true,
    stderr: 'ignore',
    stdout: 'pipe',
  });
  const alive = (pid) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      return error.code !== 'ESRCH';
    }
  };
  const { stopProcess } = createDevRuntime({
    clock: { now: () => performance.now(), sleep: (ms) => Bun.sleep(ms) },
    signal: (pid, signal) => process.kill(pid, signal),
  });
  try {
    const reader = proc.stdout.getReader();
    let output = '';
    while (output.trim().split('\n').length < 2) {
      const { value, done } = await reader.read();
      if (done) {
        break;
      }
      output += new TextDecoder().decode(value);
    }
    const pids = output.trim().split('\n').map(Number);
    expect(pids).toHaveLength(2);
    await stopProcess({ ownedGroup: true, pid: proc.pid });
    await proc.exited;
    expect(pids.every((pid) => !alive(pid))).toBe(true);
  } finally {
    try {
      if (alive(-proc.pid)) {
        process.kill(-proc.pid, 'SIGKILL');
      }
    } catch {}
  }
}, 10_000);
