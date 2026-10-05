import { expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  assertRemovableWorktree,
  createWorktree,
  ensureSetuExcludes,
  portalRequestError,
  saveSidecars,
  syncWithBase,
} from './lib.js';

function git(dir, args) {
  return execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' }).trim();
}

function repoFixture() {
  const root = mkdtempSync(join(tmpdir(), 'setu-lib-safety-'));
  const repo = join(root, 'repo');
  execFileSync('git', ['init', '-b', 'main', repo]);
  git(repo, ['config', 'user.email', 'test@example.com']);
  git(repo, ['config', 'user.name', 'Test']);
  writeFileSync(join(repo, '.gitignore'), '.env.local\ncache/\n');
  writeFileSync(join(repo, 'README.md'), 'seed\n');
  git(repo, ['add', '.']);
  git(repo, ['commit', '-m', 'seed']);
  const wt = join(root, 'repo', 'feature');
  git(repo, ['worktree', 'add', '-b', 'feature', wt]);
  writeFileSync(join(root, '.ports'), 'repo/feature:3000\n');
  return { c: { workspace: root }, repo: 'repo', root, wt };
}

test('removal refuses main, ignored regular env files, and unreachable detached commits', async () => {
  const f = repoFixture();
  try {
    await expect(
      assertRemovableWorktree(f.c, f.repo, 'main')
    ).rejects.toMatchObject({ code: 'MAIN_WORKTREE' });
    writeFileSync(join(f.wt, '.env.local'), 'secret');
    await expect(
      assertRemovableWorktree(f.c, f.repo, 'feature')
    ).rejects.toMatchObject({ code: 'WORKTREE_DIRTY' });
    rmSync(join(f.wt, '.env.local'));
    git(f.wt, ['checkout', '--detach']);
    writeFileSync(join(f.wt, 'detached.txt'), 'commit');
    git(f.wt, ['add', 'detached.txt']);
    git(f.wt, ['commit', '-m', 'detached']);
    await expect(
      assertRemovableWorktree(f.c, f.repo, 'feature')
    ).rejects.toMatchObject({ code: 'WORKTREE_DIRTY' });
    await expect(
      assertRemovableWorktree(f.c, f.repo, 'feature', { force: true })
    ).resolves.toBeUndefined();
  } finally {
    rmSync(f.root, { force: true, recursive: true });
  }
});

test('removal allows ignored env symlinks and generated Setu excludes keep git clean', async () => {
  const f = repoFixture();
  try {
    const target = join(f.root, 'env-target');
    writeFileSync(target, 'secret');
    symlinkSync(target, join(f.wt, '.env.local'));
    await expect(
      assertRemovableWorktree(f.c, f.repo, 'feature')
    ).resolves.toBeUndefined();
    ensureSetuExcludes(join(f.root, 'repo', '.git'));
    for (const file of [
      '.envrc',
      'docker-compose.setu.yml',
      'docker-compose.setu-agent.yml',
      '.setu-migration-prompted',
    ])
      writeFileSync(join(f.wt, file), 'generated');
    expect(git(f.wt, ['status', '--porcelain'])).toBe('');
  } finally {
    rmSync(f.root, { force: true, recursive: true });
  }
});

test('removal does not walk inside ignored directories such as node_modules', async () => {
  const f = repoFixture();
  try {
    // An ignored directory is one entry to git. Listing every file inside it
    // takes minutes on a real checkout, so its contents never count.
    mkdirSync(join(f.wt, 'cache'));
    writeFileSync(join(f.wt, 'cache', '.env'), 'inside an ignored directory');
    await expect(
      assertRemovableWorktree(f.c, f.repo, 'feature')
    ).resolves.toBeUndefined();
  } finally {
    rmSync(f.root, { force: true, recursive: true });
  }
});

test('sync refuses the default branch before merging', async () => {
  const f = repoFixture();
  try {
    await expect(
      syncWithBase(join(f.root, 'repo'), join(f.root, 'repo', '.git'))
    ).resolves.toMatchObject({ code: 'SYNC_BASE_BRANCH', ok: false });
  } finally {
    rmSync(f.root, { force: true, recursive: true });
  }
});

test('portal request guard rejects remote, cross-site, Host and Origin requests', () => {
  const request = (path, headers = {}) =>
    new Request(`http://localhost:2999${path}`, { headers });
  expect(portalRequestError(request('/api/worktrees'), '10.0.0.2')).toContain(
    'local'
  );
  expect(
    portalRequestError(
      request('/api/worktrees', { 'sec-fetch-site': 'cross-site' }),
      '127.0.0.1'
    )
  ).toContain('Cross-site');
  expect(
    portalRequestError(
      request('/api/mcp/oauth/callback/x', { 'sec-fetch-site': 'cross-site' }),
      '127.0.0.1'
    )
  ).toBeNull();
  expect(
    portalRequestError(
      request('/api/worktrees', { host: 'evil.test' }),
      '127.0.0.1'
    )
  ).toBe('Untrusted Host');
  expect(
    portalRequestError(
      request('/api/worktrees', { origin: 'http://evil.test' }),
      '127.0.0.1'
    )
  ).toBe('Untrusted Origin');
});

test('sidecar names are trimmed and invalid names are refused', async () => {
  const root = mkdtempSync(join(tmpdir(), 'setu-sidecar-'));
  try {
    const saved = await saveSidecars(root, 'repo', [
      { command: 'bun', name: ' worker ', args: [] },
    ]);
    expect(saved.value.repo[0].name).toBe('worker');
    expect(() =>
      saveSidecars(root, 'repo', [{ command: 'bun', name: 'bad name' }])
    ).toThrow(expect.objectContaining({ code: 'SIDECAR_NAME_INVALID' }));
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test('worktree creation refuses a local-domain collision before checkout setup', async () => {
  const root = mkdtempSync(join(tmpdir(), 'setu-domain-collision-'));
  try {
    execFileSync('git', ['init', '--bare', join(root, 'repo.git')]);
    writeFileSync(join(root, '.projects'), 'repo:3000::Repository\n');
    writeFileSync(join(root, '.ports'), 'other/topic:3000\n');
    await expect(
      createWorktree(
        { domain: 'quivly.local', workspace: root },
        'repo',
        'topic'
      )
    ).rejects.toMatchObject({ code: 'DOMAIN_COLLISION' });
    expect(existsSync(join(root, 'repo', 'topic'))).toBe(false);
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});
