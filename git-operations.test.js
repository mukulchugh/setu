import { expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gitFetchAsync, syncWithBase, writeSetuAgentMarkers } from './lib.js';

test('checked Git commands preserve unknown exit instead of releasing their caller as a known failure', async () => {
  const spawned = [];
  await expect(
    gitFetchAsync('/isolated/checkout', ['fetch', 'origin', 'main'], {
      spawn: (args, options) => {
        spawned.push({ args, options });
        return {
          exited: Promise.reject(new Error('observer unavailable')),
          stderr: new Blob(['']).stream(),
          stdout: new Blob(['partial']).stream(),
        };
      },
    })
  ).rejects.toMatchObject({ code: 'OPERATION_UNKNOWN' });
  expect(spawned[0].args).toEqual([
    'git',
    '-C',
    '/isolated/checkout',
    'fetch',
    'origin',
    'main',
  ]);
  expect(spawned[0].options).toMatchObject({
    killSignal: 'SIGKILL',
    stdin: 'ignore',
    timeout: 120_000,
  });
});

test('marker staging retains unknown completion while known staging failures remain best effort', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'setu-marker-test-'));
  try {
    await expect(
      writeSetuAgentMarkers('fixture', directory, {
        stage: async () => {
          throw Object.assign(new Error('unknown stage'), {
            code: 'OPERATION_UNKNOWN',
          });
        },
      })
    ).rejects.toMatchObject({ code: 'OPERATION_UNKNOWN' });
    await writeSetuAgentMarkers('fixture', directory, {
      stage: () => Promise.reject(new Error('known stage failure')),
    });
  } finally {
    await rm(directory, { recursive: true });
  }
});

test('unknown Sync merge completion propagates without launching status or abort', async () => {
  const calls = [];
  const runGit = async (_dir, args) => {
    calls.push(args);
    if (args[0] === 'merge') {
      throw Object.assign(new Error('merge exit unknown'), {
        code: 'OPERATION_UNKNOWN',
      });
    }
    return '';
  };
  await expect(
    syncWithBase('/isolated/checkout', '/isolated/repo.git', {
      exists: () => true,
      resolveBase: () => 'origin/staging',
      runGit,
    })
  ).rejects.toMatchObject({ code: 'OPERATION_UNKNOWN' });
  expect(calls).toEqual([
    ['symbolic-ref', '--quiet', '--short', 'HEAD'],
    ['symbolic-ref', '--short', 'HEAD'],
    ['fetch', 'origin', 'staging'],
    ['status', '--porcelain'],
    ['merge', 'origin/staging', '--no-edit'],
  ]);
});

test('sync accepts an async base resolver for portal request paths', async () => {
  const calls = [];
  const runGit = async (_dir, args) => {
    calls.push(args);
    if (args[0] === 'status') {
      return '';
    }
    if (args[0] === 'symbolic-ref') {
      return args.includes('--quiet') ? 'topic\n' : 'main\n';
    }
    return '';
  };
  await expect(
    syncWithBase('/isolated/checkout', '/isolated/repo.git', {
      resolveBase: async () => 'origin/staging',
      runGit,
    })
  ).resolves.toEqual({ base: 'origin/staging', ok: true });
  expect(calls).toContainEqual(['merge', 'origin/staging', '--no-edit']);
});

test('a known conflicting merge reports unchanged only after its abort has completed', async () => {
  const calls = [];
  let finish,
    statusReads = 0,
    settled = false;
  const abort = new Promise((resolve) => {
    finish = resolve;
  });
  const runGit = async (_dir, args) => {
    calls.push(args);
    if (args[0] === 'status') {
      const priorReads = statusReads;
      statusReads += 1;
      return priorReads ? 'UU conflicted.js\n' : '';
    }
    if (args[0] === 'rev-parse') {
      return '/isolated/admin/MERGE_HEAD';
    }
    if (args[0] === 'merge' && args[1] === '--abort') {
      return abort;
    }
    if (args[0] === 'merge') {
      throw new Error('known merge conflict');
    }
    return '';
  };
  const outcome = syncWithBase('/isolated/checkout', '/isolated/repo.git', {
    exists: () => true,
    resolveBase: () => 'origin/staging',
    runGit,
  }).then((value) => {
    settled = true;
    return value;
  });
  for (let i = 0; i < 12; i += 1) {
    await Promise.resolve();
  }
  expect(calls.at(-1)).toEqual(['merge', '--abort']);
  expect(settled).toBe(false);
  finish('');
  expect(await outcome).toMatchObject({
    conflicts: ['conflicted.js'],
    ok: false,
  });
  expect((await outcome).error).toContain('merge aborted, worktree unchanged');
});

test('unknown abort completion cannot become a cleanly aborted result', async () => {
  let statusReads = 0;
  const runGit = async (_dir, args) => {
    if (args[0] === 'status') {
      const priorReads = statusReads;
      statusReads += 1;
      return priorReads ? 'UU conflicted.js' : '';
    }
    if (args[0] === 'rev-parse') {
      return '/isolated/admin/MERGE_HEAD';
    }
    if (args[0] === 'merge' && args[1] === '--abort') {
      throw Object.assign(new Error('abort exit unknown'), {
        code: 'OPERATION_UNKNOWN',
      });
    }
    if (args[0] === 'merge') {
      throw new Error('known conflict');
    }
    return '';
  };
  await expect(
    syncWithBase('/isolated/checkout', '/isolated/repo.git', {
      exists: () => true,
      resolveBase: () => 'origin/staging',
      runGit,
    })
  ).rejects.toMatchObject({ code: 'OPERATION_UNKNOWN' });
});
