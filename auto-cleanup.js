// Background disk hygiene for idle worktrees. Two jobs, both read from
// ~/.setu.json "autoCleanup" on every tick so edits apply without a restart:
//   1. Generated caches (.next, turbopack) of stopped worktrees idle for
//      cacheIdleHours go through the reviewed worktree-cache prepare/execute.
//   2. The whole .next output of worktrees stopped for nextIdleHours
//      (default 24) is deleted; Next rebuilds it on the next dev start.
//   3. Opt-in: clean, fully pushed, unclaimed, stopped worktrees are removed
//      once idle for removeMergedAfterHours (PR merged) or
//      removeIdleAfterHours (any other state). The branch itself is kept.
import { execFile } from 'node:child_process';
import { lstat, readdir, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const HOUR = 3_600_000;

export const AUTO_CLEANUP_DEFAULTS = Object.freeze({
  cacheIdleHours: 2,
  enabled: true,
  nextIdleHours: 24,
  removeIdle: false,
  removeIdleAfterHours: 168,
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
    nextIdleHours: hours(
      raw.nextIdleHours,
      AUTO_CLEANUP_DEFAULTS.nextIdleHours
    ),
    removeIdle: raw.removeIdle === true,
    removeIdleAfterHours: hours(
      raw.removeIdleAfterHours,
      AUTO_CLEANUP_DEFAULTS.removeIdleAfterHours
    ),
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

// Real .next directories at the root and under apps/*; symlinks are skipped
// so a link can never redirect deletion outside the checkout.
export async function nextDirectories(wtDir) {
  const candidates = [join(wtDir, '.next')];
  try {
    for (const app of await readdir(join(wtDir, 'apps'))) {
      candidates.push(join(wtDir, 'apps', app, '.next'));
    }
  } catch {
    // No apps/ directory: a single-app repo.
  }
  const found = await Promise.all(
    candidates.map(async (path) => {
      try {
        const info = await lstat(path);
        return info.isDirectory() && !info.isSymbolicLink() ? path : null;
      } catch {
        return null;
      }
    })
  );
  return found.filter(Boolean);
}

// A running dev server keeps writing into .next itself (event files) and
// .next/dev (trace, manifests), so their newest mtime tracks when it was last
// used. Cache directories are deliberately not part of the signal: cleaning
// them would otherwise reset the idle clock it is measured by.
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
      mtimeMs(join(root, 'dev')),
      mtimeMs(join(root, 'dev', 'trace')),
      mtimeMs(join(root, 'trace')),
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
  nextDirs = nextDirectories,
  removeDir = (path) => rm(path, { force: true, recursive: true }),
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

  // Returns the removal reason, or null when the worktree must stay.
  async function removalReason(worktree, settings, claimed, used) {
    const merged = worktree.pr?.state === 'merged';
    const afterHours = merged
      ? settings.removeMerged && settings.removeMergedAfterHours
      : settings.removeIdle && settings.removeIdleAfterHours;
    if (
      afterHours === false ||
      worktree.name === 'main' ||
      worktree.dirty !== 0 ||
      claimed.has(worktree.wtDir) ||
      now() - Math.max(used, (worktree.lastCommitAt ?? 0) * 1000) <
        afterHours * HOUR ||
      (await unpushed(worktree.wtDir)) !== 0
    ) {
      return null;
    }
    return merged ? 'merged and idle' : 'idle';
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
          const reason = await removalReason(worktree, settings, claimed, used);
          if (reason) {
            const removed = await removeWorktree(
              worktree.repo,
              worktree.name,
              reason === 'idle' ? 'manual' : 'merged'
            );
            if (removed && removed.ok === false) {
              log(
                'error',
                worktree.key,
                removed.error ?? removed.code ?? 'removal not completed'
              );
            } else {
              log('remove', worktree.key, reason);
            }
            continue;
          }
          const idleFor = now() - used;
          if (used > 0 && !claimed.has(worktree.wtDir)) {
            if (idleFor >= settings.nextIdleHours * HOUR) {
              for (const dir of await nextDirs(worktree.wtDir)) {
                // biome-ignore lint/performance/noAwaitInLoops: at most a few app directories per worktree.
                await removeDir(dir);
              }
              log('next', worktree.key, 'removed .next');
            } else if (idleFor >= settings.cacheIdleHours * HOUR) {
              await cleanCache(worktree);
            }
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
