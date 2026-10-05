import { expect, test } from 'bun:test';
import fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inspectCheckoutIdentity } from './checkout-identity.js';

test('identity proves the checkout/admin relationship and changes when the same path is recreated', async () => {
  const root = await fs.mkdtemp(join(tmpdir(), 'setu-identity-'));
  try {
    const repoDir = join(root, 'repo.git'),
      wtDir = join(root, 'repo', 'branch'),
      admin = join(repoDir, 'worktrees', 'branch');
    await fs.mkdir(admin, { recursive: true });
    await fs.mkdir(wtDir, { recursive: true });
    await fs.writeFile(join(wtDir, '.git'), `gitdir: ${admin}\n`);
    await fs.writeFile(join(admin, 'gitdir'), `${wtDir}/.git\n`);
    await fs.writeFile(join(admin, 'commondir'), '../..\n');
    const before = await inspectCheckoutIdentity({ repoDir, wtDir }, fs);
    expect(before.known).toBe(true);
    await fs.writeFile(join(admin, 'HEAD'), 'ref: refs/heads/changed\n');
    expect(await inspectCheckoutIdentity({ repoDir, wtDir }, fs)).toEqual(
      before
    );
    await fs.rename(wtDir, `${wtDir}-old`);
    await fs.mkdir(wtDir);
    await fs.writeFile(join(wtDir, '.git'), `gitdir: ${admin}\n`);
    expect(
      (await inspectCheckoutIdentity({ repoDir, wtDir }, fs)).checkout
    ).not.toEqual(before.checkout);
    await fs.writeFile(join(admin, 'commondir'), '/unrelated\n');
    expect((await inspectCheckoutIdentity({ repoDir, wtDir }, fs)).known).toBe(
      false
    );
  } finally {
    await fs.rm(root, { force: true, recursive: true });
  }
});

test('unavailable identity evidence is unknown, without a weaker path-only identity', async () => {
  expect(
    await inspectCheckoutIdentity(
      { repoDir: '/absent', wtDir: '/absent' },
      {
        realpath: () => {
          return Promise.reject(new Error('unreadable'));
        },
      }
    )
  ).toMatchObject({ known: false });
});
