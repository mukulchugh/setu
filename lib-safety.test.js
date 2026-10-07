import { expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  allowDirenvAsync,
  assertRemovableWorktree,
  baseBranchRefAsync,
  createWorktree,
  ensureSetuExcludes,
  linkWorktreeEnv,
  PACKAGE_VERSION,
  portalRequestError,
  reloadCaddyAsync,
  SETU_DIR,
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
    ]) {
      writeFileSync(join(f.wt, file), 'generated');
    }
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

test('worktree environment links use a native symlink from main .env.local', () => {
  const root = mkdtempSync(join(tmpdir(), 'setu-worktree-env-'));
  try {
    const mainEnv = join(root, 'repo', 'main', '.env.local');
    const wtEnv = join(root, 'repo', 'topic', '.env.local');
    mkdirSync(join(root, 'repo', 'main'), { recursive: true });
    mkdirSync(join(root, 'repo', 'topic'), { recursive: true });
    writeFileSync(mainEnv, 'SECRET=fixture\n');
    expect(linkWorktreeEnv(mainEnv, wtEnv)).toBe(true);
    expect(lstatSync(wtEnv).isSymbolicLink()).toBe(true);
    expect(readlinkSync(wtEnv)).toBe(mainEnv);
    const occupied = join(root, 'repo', 'topic', 'occupied.env.local');
    writeFileSync(occupied, 'do not replace\n');
    expect(linkWorktreeEnv(mainEnv, occupied)).toBe(false);
    expect(readFileSync(occupied, 'utf8')).toBe('do not replace\n');
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test('async direnv allow leaves the event loop available while the child runs', async () => {
  const root = mkdtempSync(join(tmpdir(), 'setu-direnv-'));
  const bin = join(root, 'bin');
  const previousPath = process.env.PATH;
  try {
    mkdirSync(bin);
    const direnv = join(bin, 'direnv');
    writeFileSync(direnv, '#!/bin/sh\nsleep 0.1\n');
    chmodSync(direnv, 0o755);
    process.env.PATH = `${bin}:${previousPath}`;
    const allowing = allowDirenvAsync('/fixture');
    let served = false;
    await new Promise((resolve) =>
      setTimeout(() => {
        served = true;
        resolve();
      }, 20)
    );
    expect(served).toBe(true);
    await allowing;
  } finally {
    process.env.PATH = previousPath;
    rmSync(root, { force: true, recursive: true });
  }
});

test('async base branch resolution preserves the staging fallback', async () => {
  const calls = [];
  const run = async (_repoDir, args) => {
    calls.push(args);
    if (args[0] === 'show-ref') {
      throw new Error('not found');
    }
    return 'main\n';
  };
  await expect(baseBranchRefAsync('/repo', { run })).resolves.toBe(
    'origin/main'
  );
  expect(calls).toEqual([
    ['show-ref', '--verify', '--quiet', 'refs/heads/staging'],
    ['show-ref', '--verify', '--quiet', 'refs/remotes/origin/staging'],
    ['symbolic-ref', '--short', 'HEAD'],
  ]);
});

test('async caddy reload retains the sync helper success result', async () => {
  const calls = [];
  const state = { withRouting: (task) => task() };
  await expect(
    reloadCaddyAsync('/workspace', {
      run: async (args, options) => {
        calls.push({ args, options });
        return 0;
      },
      state,
    })
  ).resolves.toBe(true);
  expect(calls[0].args.slice(0, 3)).toEqual(['sudo', '-n', expect.any(String)]);
  expect(calls[0].options.timeoutMs).toBe(5000);
});

test('Bun configuration pins 1.3.14 in the package and mise manifests', () => {
  const packageJson = JSON.parse(
    readFileSync(join(process.cwd(), 'package.json'))
  );
  const mise = readFileSync(join(process.cwd(), 'mise.toml'), 'utf8');
  expect(packageJson.engines.bun).toBe('1.3.14');
  expect(mise).toContain('bun = "1.3.14"');
});

test('the installer provisions the pinned Bun release before it invokes Bun', () => {
  const installer = readFileSync(join(process.cwd(), 'install.sh'), 'utf8');
  expect(installer).toContain('BUN_VERSION="1.3.14"');
  expect(installer).toContain('bash -s "bun-v$BUN_VERSION"');
  expect(installer.indexOf('BUN_VERSION="1.3.14"')).toBeLessThan(
    installer.indexOf('exec bun "$SETU_DIR/update-command.js"')
  );
});

test('packaging supplies Raycast typecheck prerequisites from the root install', () => {
  const packageJson = JSON.parse(
    readFileSync(join(process.cwd(), 'package.json'))
  );
  expect(SETU_DIR).toBe(
    dirname(fileURLToPath(new URL('./lib.js', import.meta.url)))
  );
  expect(PACKAGE_VERSION).toBe(packageJson.version);
  expect(packageJson.devDependencies.typescript).toBe('^5.6.0');
  expect(packageJson.devDependencies['@raycast/api']).toBe('^1.104.24');
  expect(packageJson.devDependencies['@raycast/utils']).toBe('^2.3.0');
  expect(packageJson.devDependencies['@types/node']).toBe('^22.0.0');
  expect(packageJson.devDependencies['@types/react']).toBe('^19.0.0');
  expect(packageJson.scripts.typecheck).toContain('node_modules/typescript');
  expect(packageJson.scripts.typecheck).not.toContain('raycast/node_modules');
  const quickOpen = readFileSync(
    join(process.cwd(), 'raycast', 'src', 'quick-open.tsx'),
    'utf8'
  );
  expect(quickOpen).not.toContain('Arguments.QuickOpen');
  expect(quickOpen).toContain('arguments: { query?: string }');
  expect(packageJson.dependencies['@tabler/icons']).toBeUndefined();
  expect(packageJson.dependencies['class-variance-authority']).toBe('0.7.1');
  expect(packageJson.dependencies.clsx).toBe('2.1.1');
  expect(packageJson.dependencies['tailwind-merge']).toBe('3.6.0');
  expect(readFileSync(join(process.cwd(), 'install.sh'), 'utf8')).toContain(
    'bun install --frozen-lockfile'
  );
  expect(
    readFileSync(join(process.cwd(), 'update-command.js'), 'utf8')
  ).toContain("frozenLockfile ? ['--frozen-lockfile'] : []");
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
      { args: [], command: 'bun', name: ' worker ' },
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
