// Hoisted dependency sharing for identical worktrees. Before setup installs, a
// worktree with no node_modules gets an APFS clone (`cp -c`, copy-on-write) of
// the node_modules trees of a sibling worktree whose bun.lock is byte-identical.
// The clones share disk blocks until a file changes, so N identical worktrees
// cost one physical copy, and each still has real, independent directories as
// the hoisted linker requires. Setup's ordinary frozen install runs afterwards
// and corrects any drift, so correctness never depends on the clone.
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, readdir, readFile, rename, rm } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const LOCKFILES = ['bun.lock', 'bun.lockb'];
// Workspace members live one level under these; their nested node_modules
// (e.g. packages/ai/node_modules) are cloned too.
const MEMBER_ROOTS = ['apps', 'packages', 'libs', 'services'];

async function isRealDirectory(path) {
  try {
    const info = await lstat(path);
    return info.isDirectory() && !info.isSymbolicLink();
  } catch {
    return false;
  }
}

export async function lockfileHash(wtDir) {
  for (const name of LOCKFILES) {
    try {
      // biome-ignore lint/performance/noAwaitInLoops: the first present lockfile wins.
      const bytes = await readFile(join(wtDir, name));
      return `${name}:${createHash('sha256').update(bytes).digest('hex')}`;
    } catch {
      // Try the next lockfile name.
    }
  }
  return null;
}

// Root node_modules plus each workspace member's own node_modules.
export async function nodeModulesTrees(wtDir) {
  const trees = [];
  if (await isRealDirectory(join(wtDir, 'node_modules'))) {
    trees.push('node_modules');
  }
  for (const root of MEMBER_ROOTS) {
    let members = [];
    try {
      // biome-ignore lint/performance/noAwaitInLoops: a handful of fixed roots.
      members = await readdir(join(wtDir, root), { withFileTypes: true });
    } catch {
      continue;
    }
    const candidates = members
      .filter((member) => member.isDirectory())
      .map((member) => join(root, member.name, 'node_modules'));
    const present = await Promise.all(
      candidates.map((tree) => isRealDirectory(join(wtDir, tree)))
    );
    trees.push(...candidates.filter((_, index) => present[index]));
  }
  return trees;
}

export async function siblingWorktrees(wtDir, run = exec) {
  try {
    const { stdout } = await run(
      'git',
      ['-C', wtDir, 'worktree', 'list', '--porcelain'],
      { timeout: 15_000 }
    );
    return stdout
      .split('\n')
      .filter((line) => line.startsWith('worktree '))
      .map((line) => line.slice('worktree '.length))
      .filter((path) => relative(path, wtDir) !== '');
  } catch {
    return [];
  }
}

// The most recently installed sibling with an identical lockfile, so a fresh
// install is the most likely to already match.
export async function findCloneSource(wtDir, { siblings, hash } = {}) {
  const wanted = hash ?? (await lockfileHash(wtDir));
  if (!wanted) {
    return null;
  }
  const candidates = siblings ?? (await siblingWorktrees(wtDir));
  const observed = await Promise.all(
    candidates.map(async (candidate) => {
      if ((await lockfileHash(candidate)) !== wanted) {
        return null;
      }
      try {
        const installedAt = (await lstat(join(candidate, 'node_modules')))
          .mtimeMs;
        return { installedAt, wtDir: candidate };
      } catch {
        return null;
      }
    })
  );
  const [best] = observed
    .filter(Boolean)
    .sort((a, b) => b.installedAt - a.installedAt);
  return best?.wtDir ?? null;
}

async function cloneTree(source, target, run) {
  const staging = `${target}.setu-clone-${process.pid}`;
  await rm(staging, { force: true, recursive: true });
  try {
    await run('cp', ['-c', '-R', source, staging], {
      maxBuffer: 1024 * 1024,
      timeout: 10 * 60_000,
    });
    await rename(staging, target);
    return true;
  } catch {
    await rm(staging, { force: true, recursive: true });
    return false;
  }
}

// Returns { cloned: false, reason } or { cloned: true, source, trees }.
export async function cloneSiblingNodeModules(
  wtDir,
  { run = exec, siblings, platform = process.platform } = {}
) {
  if (platform !== 'darwin') {
    return { cloned: false, reason: 'clonefile-unsupported' };
  }
  if (await isRealDirectory(join(wtDir, 'node_modules'))) {
    return { cloned: false, reason: 'already-installed' };
  }
  const source = await findCloneSource(wtDir, { siblings });
  if (!source) {
    return { cloned: false, reason: 'no-identical-sibling' };
  }
  const trees = [];
  for (const tree of await nodeModulesTrees(source)) {
    const target = join(wtDir, tree);
    // Never write into a member directory the new checkout does not have, and
    // never replace anything already there. Trees are cloned one at a time to
    // bound disk load.
    if (
      // biome-ignore lint/performance/noAwaitInLoops: sequential by design, see above.
      !(await isRealDirectory(dirname(target))) ||
      (await isRealDirectory(target))
    ) {
      continue;
    }
    if (await cloneTree(join(source, tree), target, run)) {
      trees.push(tree);
    }
  }
  return trees.includes('node_modules')
    ? { cloned: true, source, trees }
    : { cloned: false, reason: 'clone-failed' };
}
