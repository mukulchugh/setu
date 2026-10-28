import { expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  cloneSiblingNodeModules,
  findCloneSource,
  siblingWorktrees,
} from './sibling-clone.js';

const root = () => realpathSync(mkdtempSync(join(tmpdir(), 'setu-clone-')));

function checkout(dir, { lock = 'lock-a', installed = false } = {}) {
  mkdirSync(join(dir, 'packages', 'ai'), { recursive: true });
  writeFileSync(join(dir, 'bun.lock'), lock);
  if (installed) {
    mkdirSync(join(dir, 'node_modules', 'left-pad'), { recursive: true });
    writeFileSync(join(dir, 'node_modules', 'left-pad', 'index.js'), 'x');
    mkdirSync(join(dir, 'node_modules', '@quivly'), { recursive: true });
    symlinkSync(
      '../../packages/ai',
      join(dir, 'node_modules', '@quivly', 'ai')
    );
    mkdirSync(join(dir, 'packages', 'ai', 'node_modules', 'zod'), {
      recursive: true,
    });
    writeFileSync(
      join(dir, 'packages', 'ai', 'node_modules', 'zod', 'i.js'),
      'z'
    );
  }
  return dir;
}

test.if(process.platform === 'darwin')(
  'clones root and member node_modules from an identical sibling, keeping relative links local',
  async () => {
    const r = root();
    const source = checkout(join(r, 'a'), { installed: true });
    const fresh = checkout(join(r, 'b'));
    const outcome = await cloneSiblingNodeModules(fresh, {
      siblings: [source],
    });
    expect(outcome).toEqual({
      cloned: true,
      source,
      trees: ['node_modules', 'packages/ai/node_modules'],
    });
    expect(
      readFileSync(join(fresh, 'node_modules/left-pad/index.js'), 'utf8')
    ).toBe('x');
    expect(existsSync(join(fresh, 'packages/ai/node_modules/zod/i.js'))).toBe(
      true
    );
    const link = join(fresh, 'node_modules/@quivly/ai');
    expect(readlinkSync(link)).toBe('../../packages/ai');
    expect(realpathSync(link)).toBe(join(fresh, 'packages', 'ai'));
    // Independent copies: writing in the clone never changes the source.
    writeFileSync(join(fresh, 'node_modules/left-pad/index.js'), 'changed');
    expect(
      readFileSync(join(source, 'node_modules/left-pad/index.js'), 'utf8')
    ).toBe('x');
  }
);

test('a sibling with a different lockfile is never a source', async () => {
  const r = root();
  const other = checkout(join(r, 'a'), { installed: true, lock: 'lock-b' });
  const fresh = checkout(join(r, 'b'));
  expect(await findCloneSource(fresh, { siblings: [other] })).toBeNull();
  expect(
    await cloneSiblingNodeModules(fresh, {
      platform: 'darwin',
      siblings: [other],
    })
  ).toEqual({ cloned: false, reason: 'no-identical-sibling' });
});

test('an existing node_modules is never replaced', async () => {
  const r = root();
  const source = checkout(join(r, 'a'), { installed: true });
  const fresh = checkout(join(r, 'b'), { installed: true });
  expect(
    await cloneSiblingNodeModules(fresh, {
      platform: 'darwin',
      siblings: [source],
    })
  ).toEqual({ cloned: false, reason: 'already-installed' });
});

test('a failed copy leaves no partial node_modules behind', async () => {
  const r = root();
  const source = checkout(join(r, 'a'), { installed: true });
  const fresh = checkout(join(r, 'b'));
  const outcome = await cloneSiblingNodeModules(fresh, {
    platform: 'darwin',
    run: () => Promise.reject(new Error('cp failed')),
    siblings: [source],
  });
  expect(outcome).toEqual({ cloned: false, reason: 'clone-failed' });
  expect(existsSync(join(fresh, 'node_modules'))).toBe(false);
});

test('non-macOS platforms skip cloning', async () => {
  expect(
    await cloneSiblingNodeModules('/nowhere', { platform: 'linux' })
  ).toEqual({
    cloned: false,
    reason: 'clonefile-unsupported',
  });
});

test('siblings are the other worktrees of the same repository', async () => {
  const r = root();
  const git = (...args) => execFileSync('git', args, { cwd: r, stdio: 'pipe' });
  git('init', '-q', 'main');
  execFileSync(
    'git',
    ['-C', join(r, 'main'), 'commit', '-q', '--allow-empty', '-m', 'x'],
    {
      env: {
        ...process.env,
        GIT_AUTHOR_EMAIL: 't@t',
        GIT_AUTHOR_NAME: 't',
        GIT_COMMITTER_EMAIL: 't@t',
        GIT_COMMITTER_NAME: 't',
      },
    }
  );
  execFileSync('git', [
    '-C',
    join(r, 'main'),
    'worktree',
    'add',
    '-q',
    join(r, 'topic'),
  ]);
  expect(await siblingWorktrees(join(r, 'topic'))).toEqual([join(r, 'main')]);
  expect(lstatSync(join(r, 'topic')).isDirectory()).toBe(true);
});
