import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, symlinkSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  autoCleanupSettings,
  createAutoCleanup,
  lastUsedAt,
  nextDirectories,
} from './auto-cleanup.js';

const HOUR = 3_600_000;
const NOW = 1000 * HOUR;
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
  const calls = { executed: [], logged: [], nextRemoved: [], removed: [] };
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
    log: (...parts) => calls.logged.push(parts),
    nextDirs: async (dir) => [`${dir}/apps/web/.next`],
    now: () => NOW,
    removeDir: async (path) => {
      calls.nextRemoved.push(path);
    },
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
    nextIdleHours: 24,
    removeIdle: false,
    removeIdleAfterHours: 168,
    removeMerged: false,
    removeMergedAfterHours: 24,
  });
  expect(
    autoCleanupSettings({ autoCleanup: { cacheIdleHours: -1 } })
  ).toMatchObject({
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

test('removes unmerged worktrees only after the longer idle window, when opted in', async () => {
  const worktrees = [
    worktree({ name: 'stale' }),
    worktree({ name: 'week-minus' }),
  ];
  const used = {
    '/w/stale': NOW - 170 * HOUR,
    '/w/week-minus': NOW - 100 * HOUR,
  };
  const merged = { autoCleanup: { removeMerged: true } };
  expect((await run({ config: merged, used, worktrees })).removed).toEqual([]);
  const idle = { autoCleanup: { removeIdle: true } };
  expect((await run({ config: idle, used, worktrees })).removed).toEqual([
    'stale',
  ]);
  expect(
    (await run({ config: idle, unpushed: 2, used, worktrees })).removed
  ).toEqual([]);
});

test('deletes the whole .next after nextIdleHours and logs it, instead of a cache-only clean', async () => {
  const calls = await run({
    used: {
      '/w/day-old': NOW - 30 * HOUR,
      '/w/few-hours': NOW - 5 * HOUR,
    },
    worktrees: [worktree({ name: 'day-old' }), worktree({ name: 'few-hours' })],
  });
  expect(calls.nextRemoved).toEqual(['/w/day-old/apps/web/.next']);
  expect(calls.executed).toEqual(['few-hours']);
  expect(calls.logged).toContainEqual(['next', 'r/day-old', 'removed .next']);
});

test('a claimed worktree keeps its .next however long it is idle', async () => {
  const calls = await run({
    claims: ['/w/held'],
    used: { '/w/held': NOW - 90 * HOUR },
    worktrees: [worktree({ name: 'held' })],
  });
  expect(calls.nextRemoved).toEqual([]);
});

test('nextDirectories finds real .next dirs and skips symlinked ones', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'setu-next-'));
  mkdirSync(join(dir, 'apps', 'web', '.next'), { recursive: true });
  mkdirSync(join(dir, 'apps', 'docs'), { recursive: true });
  mkdirSync(join(dir, 'elsewhere'));
  symlinkSync(join(dir, 'elsewhere'), join(dir, 'apps', 'docs', '.next'));
  expect(await nextDirectories(dir)).toEqual([
    join(dir, 'apps', 'web', '.next'),
  ]);
});

test('cleaning a cache does not count as using the worktree', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'setu-used-'));
  const next = join(dir, 'apps', 'web', '.next');
  mkdirSync(join(next, 'dev', 'cache', 'turbopack'), { recursive: true });
  const old = new Date(Date.now() - 30 * HOUR);
  for (const path of [next, join(next, 'dev')]) {
    utimesSync(path, old, old);
  }
  // A fresh write inside the cache, as a cleanup would cause.
  utimesSync(join(next, 'dev', 'cache', 'turbopack'), new Date(), new Date());
  utimesSync(join(next, 'dev', 'cache'), new Date(), new Date());
  expect(Date.now() - (await lastUsedAt(dir))).toBeGreaterThan(29 * HOUR);
});

test('a removal that does not complete is logged as an error, not a removal', async () => {
  const logged = [];
  const cleanup = createAutoCleanup({
    cacheExecute: async () => ({ ok: true }),
    cachePrepare: async () => ({ manifest: { entries: [] }, ok: true }),
    claims: async () => [],
    config: () => ({ autoCleanup: { removeMerged: true } }),
    getWorktrees: async () => [
      worktree({ name: 'stuck', pr: { state: 'merged' } }),
    ],
    log: (...parts) => logged.push(parts),
    now: () => NOW,
    removeWorktree: async () => ({ code: 'REMOVAL_PENDING', ok: false }),
    unpushed: async () => 0,
    usedAt: async () => NOW - 30 * HOUR,
  });
  await cleanup.tick();
  expect(logged).toEqual([['error', 'r/stuck', 'REMOVAL_PENDING']]);
});
