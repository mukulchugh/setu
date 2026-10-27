import { expect, test } from 'bun:test';
import { autoCleanupSettings, createAutoCleanup } from './auto-cleanup.js';

const HOUR = 3_600_000;
const NOW = 100 * HOUR;
const worktree = (over) => ({
  dirty: 0,
  key: `r/${over.name}`,
  lastCommitAt: 0,
  phase: 'stopped',
  pr: { state: 'open' },
  repo: 'r',
  wtDir: `/w/${over.name}`,
  ...over,
});

function run({ config = {}, worktrees, used = {}, claims = [], unpushed = 0 }) {
  const calls = { executed: [], removed: [] };
  const cleanup = createAutoCleanup({
    cacheExecute: async (input) => {
      calls.executed.push(input.name);
      return { ok: true };
    },
    cachePrepare: async ({ name }) => ({
      manifest: { entries: [{}], id: `m-${name}` },
      ok: true,
    }),
    claims: async () => claims.map((wtDir) => ({ wtDir })),
    config: () => config,
    getWorktrees: async () => worktrees,
    now: () => NOW,
    removeWorktree: async (_repo, name) => {
      calls.removed.push(name);
    },
    unpushed: async () => unpushed,
    usedAt: async (dir) => used[dir] ?? 0,
  });
  return cleanup.tick().then(() => calls);
}

test('settings default to cache cleanup on, merged removal off', () => {
  expect(autoCleanupSettings({})).toEqual({
    cacheIdleHours: 2,
    enabled: true,
    removeMerged: false,
    removeMergedAfterHours: 24,
  });
  expect(autoCleanupSettings({ autoCleanup: { cacheIdleHours: -1 } })).toMatchObject({
    cacheIdleHours: 2,
  });
});

test('cleans caches only for stopped, unclaimed worktrees idle past the threshold', async () => {
  const calls = await run({
    claims: ['/w/claimed'],
    used: {
      '/w/claimed': NOW - 5 * HOUR,
      '/w/fresh': NOW - HOUR,
      '/w/idle': NOW - 3 * HOUR,
      '/w/running': NOW - 5 * HOUR,
    },
    worktrees: [
      worktree({ name: 'idle' }),
      worktree({ name: 'fresh' }),
      worktree({ name: 'claimed' }),
      worktree({ active: true, name: 'running', phase: 'running' }),
    ],
  });
  expect(calls.executed).toEqual(['idle']);
  expect(calls.removed).toEqual([]);
});

test('removes merged worktrees only when opted in, clean, pushed and idle long enough', async () => {
  const merged = { pr: { state: 'merged' } };
  const worktrees = [
    worktree({ ...merged, name: 'old' }),
    worktree({ ...merged, dirty: 2, name: 'dirty' }),
    worktree({ ...merged, name: 'main' }),
    worktree({ ...merged, lastCommitAt: (NOW - HOUR) / 1000, name: 'recent' }),
  ];
  const used = Object.fromEntries(
    worktrees.map((w) => [w.wtDir, NOW - 30 * HOUR])
  );
  expect((await run({ used, worktrees })).removed).toEqual([]);
  const optedIn = { autoCleanup: { removeMerged: true } };
  expect((await run({ config: optedIn, used, worktrees })).removed).toEqual([
    'old',
  ]);
  expect(
    (await run({ config: optedIn, unpushed: 1, used, worktrees })).removed
  ).toEqual([]);
});

test('disabled config does nothing', async () => {
  const calls = await run({
    config: { autoCleanup: { enabled: false } },
    used: { '/w/idle': NOW - 9 * HOUR },
    worktrees: [worktree({ name: 'idle' })],
  });
  expect(calls.executed).toEqual([]);
});
