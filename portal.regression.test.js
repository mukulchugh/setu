import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { createDevRuntime } from './dev-runtime.js';
import { branchMetadata, worktreeBranchMap } from './lib.js';

// Importing portal.js starts the real portal and reconciles user processes.
// Run its actual functions with explicit substitutes instead; no server or
// workspace is created by this suite.
const source = readFileSync(new URL('./portal.js', import.meta.url), 'utf8');
// Validate the complete module as well as the isolated functions below.
new Bun.Transpiler({ loader: 'js' }).transformSync(source);
function declaration(name) {
  const oneLine = source.match(
    new RegExp(`^(?:async )?function ${name}\\([^\\n]*\\{[^\\n]*\\}$`, 'm')
  );
  const multiline = source.match(
    new RegExp(`^(?:async )?function ${name}\\([^]*?^}`, 'm')
  );
  if (!(oneLine ?? multiline)) {
    throw new Error(`Missing ${name}`);
  }
  return (oneLine ?? multiline)[0];
}
function load(names, deps, state = '') {
  return Function(
    ...Object.keys(deps),
    `${state}\n${names.map(declaration).join('\n')}\nreturn {${names.join(',')}};`
  )(...Object.values(deps));
}
function deferred() {
  let resolve;
  const promise = new Promise((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
// Lifecycle behavior is exercised through the imported production controller and
// runtime in worktree-lifecycle.test.js and dev-runtime.test.js.

test('duplicate log subscription does not leak a timer or subscriber count', () => {
  const wsTopics = new Map();
  const topic = 'logs:r/a/dev';
  let timers = 0,
    cleared = 0;
  const ws = {
    data: new Set(),
    send() {
      /* No side effect is needed in this fixture. */
    },
    subscribe() {
      /* No side effect is needed in this fixture. */
    },
    unsubscribe() {
      /* No side effect is needed in this fixture. */
    },
  };
  const { wsSubscribeLog, wsUnsubscribeLog } = load(
    ['splitLogTopic', 'wsSubscribeLog', 'wsUnsubscribeLog'],
    {
      clearInterval: () => {
        const previous = cleared;
        cleared += 1;
        return previous;
      },
      logPath: () => '/fixture.log',
      setInterval: () => {
        timers += 1;
        return timers;
      },
      wsTickLog: () => {
        /* No side effect is needed in this fixture. */
      },
      wsTopics,
    }
  );
  wsSubscribeLog(ws, topic);
  wsSubscribeLog(ws, topic);
  expect(wsTopics.get(topic).subscriberCount).toBe(1);
  expect(timers).toBe(1);
  wsUnsubscribeLog(ws, topic);
  expect(wsTopics.size).toBe(0);
  expect(cleared).toBe(1);
});

test('Docker teardown propagates failure instead of reporting a removed container', async () => {
  const lib = readFileSync(new URL('./lib.js', import.meta.url), 'utf8');
  const body = lib
    .match(/^export async function composeDownAsync\([\s\S]*?^}/m)[0]
    .replace('export ', '');
  const composeDownAsync = Function(
    'Bun',
    `${body}; return composeDownAsync;`
  )({
    spawn: () => ({
      exited: Promise.resolve(1),
      stderr: new Blob(['daemon refused teardown']).stream(),
    }),
  });
  await expect(composeDownAsync('fixture', '/fixture.yml')).rejects.toThrow(
    'daemon refused teardown'
  );
});

test('GitHub cache misses share work and never exceed four concurrent requests', async () => {
  const gates = [],
    state =
      'const prCache = new Map(), prInFlight = new Map(), prWaiters = []; let activePrRequests = 0;';
  const { fetchPR } = load(
    ['fetchPR'],
    {
      PR_TTL: 60_000,
      REPO_META: {},
      spawnText: () => {
        const gate = deferred();
        gates.push(gate);
        return gate.promise;
      },
      summarizeChecks: () => 'none',
    },
    state
  );
  const same = [fetchPR('r', 'a'), fetchPR('r', 'a')];
  const others = ['b', 'c', 'd', 'e', 'f'].map((branch) =>
    fetchPR('r', branch)
  );
  expect(gates).toHaveLength(4);
  for (let i = 0; i < 6; i += 1) {
    gates[i].resolve('{"number":1,"state":"OPEN"}');
    await Promise.resolve();
    await Promise.resolve();
  }
  await Promise.all([...same, ...others]);
  expect(gates).toHaveLength(6);
});

test('concurrent worktree reads share one computation and clear after completion', async () => {
  const gate = deferred();
  let count = 0;
  const { getWorktrees } = load(
    ['getWorktrees'],
    {
      computeWorktrees: () => {
        count += 1;
        return gate.promise;
      },
    },
    'let worktreesInFlight = null;'
  );
  const first = getWorktrees(),
    second = getWorktrees();
  expect(first).toBe(second);
  expect(count).toBe(1);
  gate.resolve([]);
  await first;
  await getWorktrees();
  expect(count).toBe(2);
});

test('metadata refresh deduplicates asynchronous Git reads and reuses the shared parsers', async () => {
  let calls = 0;
  const { repoGitMeta } = load(
    ['repoGitMeta'],
    {
      branchMetadata,
      GIT_META_TTL: 10_000,
      repoPath: () => '/nonexistent-test-repo',
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
        expect(
          args.some((arg) => arg.includes('ahead-behind:origin/main'))
        ).toBe(true);
        return 'real-branch\t1700000000\t3 7';
      },
      worktreeBranchMap,
    },
    'const gitMetaCache = new Map(), gitMetaInFlight = new Map();'
  );
  const [first, second] = await Promise.all([
    repoGitMeta('r'),
    repoGitMeta('r'),
  ]);
  expect(calls).toBe(4);
  expect(first).toBe(second);
  expect(first.pathToBranch.get('/fixture/alias')).toBe('real-branch');
  expect(first.branchMeta.get('real-branch')).toEqual({
    ahead: 3,
    behind: 7,
    lastCommitAt: 1_700_000_000,
  });
  await repoGitMeta('r');
  expect(calls).toBe(4);
});

test('bare memory includes script-wrapper descendants, but excludes unrelated processes', async () => {
  const { processTree } = load(['processTree'], {
    processMemory: () =>
      Promise.resolve([
        { pgid: 1, pid: 1, ppid: 0, rss: 1000 },
        { pgid: 1, pid: 2, ppid: 1, rss: 23_000 },
        { pgid: 1, pid: 3, ppid: 2, rss: 8000 },
        { pgid: 4, pid: 4, ppid: 0, rss: 90_000 },
      ]),
  });
  const rows = await processTree({ ownedGroup: true, pid: 1 });
  expect(rows.map((row) => row.pid)).toEqual([1, 2, 3]);
  expect(rows.reduce((sum, row) => sum + row.rss, 0) / 1024).toBe(31.25);
  expect(await processTree({ pid: 100 })).toEqual([]);
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
  const processAlive = (pid) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      return error.code !== 'ESRCH';
    }
  };
  const { stopProcess: stopDevProcess } = createDevRuntime({
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
    await stopDevProcess({ ownedGroup: true, pid: proc.pid });
    await proc.exited;
    expect(pids.every((pid) => !processAlive(pid))).toBe(true);
    expect(processAlive(-proc.pid)).toBe(false);
  } finally {
    try {
      if (processAlive(-proc.pid)) {
        process.kill(-proc.pid, 'SIGKILL');
      }
    } catch (error) {
      console.error(
        `Disposable group ${proc.pid} cleanup failed (${error.code}); its 20-second expiry remains active.`
      );
    }
  }
}, 10_000);
