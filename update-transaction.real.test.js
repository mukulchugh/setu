import { afterEach, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runUpdateTransaction } from './update-transaction.js';

const roots = [];
const git = (cwd, args) =>
  execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' });

function repository() {
  const root = fs.mkdtempSync(join(tmpdir(), 'setu-update-real-'));
  roots.push(root);
  const origin = join(root, 'origin.git');
  const seed = join(root, 'seed');
  const checkout = join(root, 'checkout');
  execFileSync('git', ['init', '--bare', origin]);
  execFileSync('git', ['init', '--initial-branch=main', seed]);
  git(seed, ['config', 'user.email', 'test@example.com']);
  git(seed, ['config', 'user.name', 'Test']);
  fs.writeFileSync(join(seed, 'source.txt'), 'base\n');
  git(seed, ['add', '.']);
  git(seed, ['commit', '-m', 'base']);
  git(seed, ['remote', 'add', 'origin', origin]);
  git(seed, ['push', '-u', 'origin', 'main']);
  execFileSync('git', ['clone', '--branch', 'main', origin, checkout]);
  git(checkout, ['config', 'user.email', 'test@example.com']);
  git(checkout, ['config', 'user.name', 'Test']);
  return { checkout, origin, root, seed };
}

function remoteChange(repo, text) {
  const other = join(repo.root, `other-${text}`);
  execFileSync('git', ['clone', '--branch', 'main', repo.origin, other]);
  git(other, ['config', 'user.email', 'test@example.com']);
  git(other, ['config', 'user.name', 'Test']);
  fs.writeFileSync(join(other, 'source.txt'), `${text}\n`);
  git(other, ['add', '.']);
  git(other, ['commit', '-m', text]);
  git(other, ['push']);
}

function transaction(
  repo,
  { portal = 'absent', failInstall = false, failRestart = false } = {}
) {
  let reopened = 0;
  const deps = {
    git: async (args) => git(repo.checkout, args),
    inProgress: async () => false,
    rebaseInProgress: async () =>
      fs.existsSync(join(repo.checkout, '.git', 'rebase-merge')) ||
      fs.existsSync(join(repo.checkout, '.git', 'rebase-apply')),
    inspectPortal: async () =>
      portal === 'ready'
        ? { instanceId: 'portal', protocol: 1, state: 'ready' }
        : { state: 'absent' },
    install: async () => {
      if (failInstall) {
        throw new Error('install failed');
      }
    },
    link: async () => {},
    operationId: () => 'real-fixture',
    quiesce: async () => ({
      instanceId: 'portal',
      ok: true,
      protocol: 1,
      token: 'owner',
    }),
    reopen: async () => {
      reopened += 1;
      return { ok: true };
    },
    restart: async () => {
      if (failRestart) {
        throw new Error('replacement portal was not confirmed');
      }
    },
    writeCheck: async () => ({ committed: true, reconciled: true }),
  };
  return { deps, reopened: () => reopened };
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { force: true, recursive: true });
  }
});

test('real Git clean fast-forward updates main', async () => {
  const repo = repository();
  const before = git(repo.checkout, ['rev-parse', 'HEAD']).trim();
  remoteChange(repo, 'remote');
  const t = transaction(repo);
  const result = await runUpdateTransaction(t.deps);
  expect(result).toMatchObject({ before, ok: true });
  expect(git(repo.checkout, ['rev-parse', 'HEAD']).trim()).not.toBe(before);
});

test('real Git rebase conflict aborts, restores HEAD, and reopens admission', async () => {
  const repo = repository();
  fs.writeFileSync(join(repo.checkout, 'source.txt'), 'local\n');
  git(repo.checkout, ['commit', '-am', 'local']);
  const before = git(repo.checkout, ['rev-parse', 'HEAD']).trim();
  remoteChange(repo, 'remote');
  const t = transaction(repo, { portal: 'ready' });
  const result = await runUpdateTransaction(t.deps, {
    restartAuthorized: true,
  });
  expect(result).toMatchObject({
    admissionClosed: false,
    ok: false,
    stage: 'rebase',
  });
  expect(git(repo.checkout, ['rev-parse', 'HEAD']).trim()).toBe(before);
  expect(fs.existsSync(join(repo.checkout, '.git', 'rebase-merge'))).toBe(
    false
  );
  expect(t.reopened()).toBe(1);
});

test('a conflicting stash restore returns to before, reapplies the retained stash, and reopens', async () => {
  const repo = repository();
  const before = git(repo.checkout, ['rev-parse', 'HEAD']).trim();
  fs.writeFileSync(join(repo.checkout, 'source.txt'), 'local edit\n');
  remoteChange(repo, 'remote');
  const t = transaction(repo, { portal: 'ready' });
  const result = await runUpdateTransaction(t.deps, {
    restartAuthorized: true,
  });
  expect(result).toMatchObject({
    admissionClosed: false,
    ok: false,
    recovery: { revisionRestored: true, stashApplied: true },
    stage: 'restore',
  });
  expect(git(repo.checkout, ['rev-parse', 'HEAD']).trim()).toBe(before);
  expect(fs.readFileSync(join(repo.checkout, 'source.txt'), 'utf8')).toBe(
    'local edit\n'
  );
  expect(git(repo.checkout, ['status', '--porcelain'])).toContain('source.txt');
  expect(git(repo.checkout, ['stash', 'list'])).toContain(
    'setu-update real-fixture'
  );
  expect(t.reopened()).toBe(1);
});

test('non-main checkout refuses before fetch or mutation', async () => {
  const repo = repository();
  git(repo.checkout, ['checkout', '-b', 'topic']);
  const t = transaction(repo);
  await expect(runUpdateTransaction(t.deps)).resolves.toMatchObject({
    code: 'UPDATE_BRANCH_UNSUPPORTED',
    ok: false,
  });
});

test('a failed portal restart keeps the installed revision and does not roll back', async () => {
  const repo = repository();
  const before = git(repo.checkout, ['rev-parse', 'HEAD']).trim();
  remoteChange(repo, 'remote');
  const t = transaction(repo, { failRestart: true, portal: 'ready' });
  const result = await runUpdateTransaction(t.deps, {
    restartAuthorized: true,
  });
  expect(result).toMatchObject({ ok: false, stage: 'restart' });
  expect(result.recovery.revisionRestored).toBe(false);
  expect(result.recovery.warnings.join(' ')).toContain('setu portal');
  // The update itself succeeded, so the checkout stays on the new revision.
  expect(git(repo.checkout, ['rev-parse', 'HEAD']).trim()).not.toBe(before);
  expect(fs.readFileSync(join(repo.checkout, 'source.txt'), 'utf8')).toBe(
    'remote\n'
  );
  // The portal was asked to stop; reopening admission on it is meaningless.
  expect(t.reopened()).toBe(0);
});

test('a failed install rolls the source back and reopens admission with a dependency warning', async () => {
  const repo = repository();
  const before = git(repo.checkout, ['rev-parse', 'HEAD']).trim();
  remoteChange(repo, 'remote');
  const t = transaction(repo, { failInstall: true, portal: 'ready' });
  const result = await runUpdateTransaction(t.deps, {
    restartAuthorized: true,
  });
  expect(result).toMatchObject({
    admissionClosed: false,
    ok: false,
    stage: 'install',
  });
  expect(git(repo.checkout, ['rev-parse', 'HEAD']).trim()).toBe(before);
  expect(result.recovery.warnings.join(' ')).toContain(
    'Dependencies may have changed'
  );
  expect(t.reopened()).toBe(1);
});
