// Background disk hygiene for idle worktrees. Two jobs, both read from
// ~/.setu.json "autoCleanup" on every tick so edits apply without a restart:
//   1. Generated caches (.next, turbopack) of stopped worktrees idle for
//      cacheIdleHours go through the reviewed worktree-cache prepare/execute.
//   2. Opt-in: merged, clean, fully pushed, unclaimed, stopped worktrees idle
//      for removeMergedAfterHours are removed (the branch itself is kept).
import { execFile } from 'node:child_process';
import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const HOUR = 3_600_000;

export const AUTO_CLEANUP_DEFAULTS = Object.freeze({
  cacheIdleHours: 2,
  enabled: true,
  removeMerged: false,
  removeMergedAfterHours: 24,
});

export function autoCleanupSettings(config) {
  const raw = config?.autoCleanup ?? {};
  const hours = (value, fallback) =>
    Number.isFinite(value) && value >= 0 ? value : fallback;
  return {
    cacheIdleHours: hours(
      raw.cacheIdleHours,
      AUTO_CLEANUP_DEFAULTS.cacheIdleHours
    ),
    enabled: raw.enabled !== false,
    removeMerged: raw.removeMerged === true,
    removeMergedAfterHours: hours(
      raw.removeMergedAfterHours,
      AUTO_CLEANUP_DEFAULTS.removeMergedAfterHours
    ),
  };
}

async function mtimeMs(path) {
  try {
    return (await stat(path)).mtimeMs;
  } catch {
    return 0;
  }
}

// A running dev server keeps writing into .next, so the newest mtime of the
// worktree's .next dirs (root and apps/*) tracks when it was last used.
export async function lastUsedAt(wtDir) {
  const roots = [join(wtDir, '.next')];
  try {
    for (const app of await readdir(join(wtDir, 'apps'))) {
      roots.push(join(wtDir, 'apps', app, '.next'));
    }
  } catch {
    // No apps/ directory: a single-app repo.
  }
  const times = await Promise.all(
    roots.flatMap((root) => [
      mtimeMs(root),
      mtimeMs(join(root, 'dev', 'cache', 'turbopack')),
      mtimeMs(join(root, 'cache')),
    ])
  );
  return Math.max(...times);
}

async function unpushedCommits(wtDir) {
  try {
    const { stdout } = await exec(
      'git',
      ['-C', wtDir, 'rev-list', '--count', 'HEAD', '--not', '--remotes'],
      { timeout: 15_000 }
    );
    return Number(stdout.trim());
  } catch {
    return Number.NaN;
  }
}

const idle = (worktree) =>
  worktree.phase === 'stopped' &&
  !worktree.active &&
  !worktree.starting &&
  !worktree.stopping &&
  !worktree.queued;

export function createAutoCleanup({
  config,
  getWorktrees,
  claims,
  cachePrepare,
  cacheExecute,
  removeWorktree,
  now = Date.now,
  usedAt = lastUsedAt,
  unpushed = unpushedCommits,
  log = () => {},
}) {
  let running = false;

  async function cleanCache(worktree) {
    const target = { name: worktree.name, repo: worktree.repo };
    const prepared = await cachePrepare(target);
    const id = prepared?.manifest?.id;
    if (!(prepared?.ok && id) || prepared.manifest.entries.length === 0) {
      return;
    }
    const result = await cacheExecute({
      ...target,
      confirmation: id,
      manifestId: id,
    });
    log('cache', worktree.key, result?.ok ? 'cleaned' : result?.code);
  }

  async function removable(worktree, settings, claimed, used) {
    return (
      worktree.name !== 'main' &&
      worktree.pr?.state === 'merged' &&
      worktree.dirty === 0 &&
      !claimed.has(worktree.wtDir) &&
      now() - Math.max(used, (worktree.lastCommitAt ?? 0) * 1000) >=
        settings.removeMergedAfterHours * HOUR &&
      (await unpushed(worktree.wtDir)) === 0
    );
  }

  async function tick() {
    if (running) {
      return;
    }
    running = true;
    try {
      const settings = autoCleanupSettings(config());
      if (!settings.enabled) {
        return;
      }
      const claimed = new Set((await claims()).map((claim) => claim.wtDir));
      for (const worktree of await getWorktrees()) {
        if (!(idle(worktree) && worktree.wtDir)) {
          continue;
        }
        // biome-ignore lint/performance/noAwaitInLoops: one worktree at a time keeps disk and git load low.
        const used = await usedAt(worktree.wtDir);
        try {
          if (
            settings.removeMerged &&
            (await removable(worktree, settings, claimed, used))
          ) {
            await removeWorktree(worktree.repo, worktree.name);
            log('remove', worktree.key, 'merged and idle');
            continue;
          }
          if (
            used > 0 &&
            !claimed.has(worktree.wtDir) &&
            now() - used >= settings.cacheIdleHours * HOUR
          ) {
            await cleanCache(worktree);
          }
        } catch (error) {
          log('error', worktree.key, error?.message ?? String(error));
        }
      }
    } finally {
      running = false;
    }
  }

  return { tick };
}
