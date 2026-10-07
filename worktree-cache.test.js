import { afterEach, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createWorkspaceState } from './workspace-state.js';
import { createWorktreeCache } from './worktree-cache.js';

const roots = [];
const git = (args, cwd) =>
  execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

afterEach(() => {
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { force: true, recursive: true });
  }
});

function fixture({
  registered = true,
  remove,
  maxEntries,
  maxScanMs,
  now,
} = {}) {
  const root = fs.mkdtempSync(join(tmpdir(), 'setu-worktree-cache-'));
  roots.push(root);
  const workspace = join(root, 'workspace');
  const bare = join(root, 'repo.git');
  const checkout = join(workspace, 'repo', 'feat');
  fs.mkdirSync(join(workspace, 'repo'), { recursive: true });
  git(['init', '--bare', bare]);
  git(['worktree', 'add', '-b', 'feat', checkout], bare);
  git(['config', 'user.email', 'fixture@example.test'], checkout);
  git(['config', 'user.name', 'Fixture'], checkout);
  fs.writeFileSync(join(checkout, '.gitignore'), '.next/\n');
  fs.writeFileSync(
    join(checkout, 'source.js'),
    'export const source = true;\n'
  );
  git(['add', '.gitignore', 'source.js'], checkout);
  git(['commit', '-m', 'fixture'], checkout);

  const target = {
    key: 'repo/feat',
    name: 'feat',
    port: 3101,
    repo: 'repo',
    repoDir: bare,
    wtDir: checkout,
  };
  const state = createWorkspaceState({
    setuDir: root,
    workspaceRoot: workspace,
  });
  if (registered) {
    fs.writeFileSync(join(workspace, '.ports'), 'repo/feat:3101\n');
  }
  const records = new Map();
  let failCompletionPersistence = false;
  let ownership = { state: 'clear' };
  let runtime = { queued: false, state: 'stopped' };
  const cache = createWorktreeCache({
    gitHead: async (value) => ({
      state: 'known',
      value: git(['rev-parse', 'HEAD'], value.wtDir),
    }),
    manifests: {
      get: async (id) => records.get(id),
      save: async (record) => records.set(record.id, record),
      update: async (id, change) => {
        const current = records.get(id);
        const next = change(current);
        if (failCompletionPersistence && next.status === 'completed') {
          throw Object.assign(new Error('fixture persistence failure'), {
            code: 'EIO',
          });
        }
        records.set(id, next);
        return next;
      },
    },
    now: now ?? (() => 1_700_000_000_000),
    ownership: async () => ownership,
    randomId: () => 'retry-fixture-id',
    runtime: async () => runtime,
    state,
    trackedPaths: async (value, paths) => {
      const stdout = execFileSync(
        'git',
        ['-C', value.wtDir, 'ls-files', '-z', '--', ...paths],
        { encoding: 'utf8' }
      );
      const found = stdout.split('\0').filter(Boolean);
      return found.length
        ? { paths: found, state: 'tracked' }
        : { state: 'clean' };
    },
    ...(maxEntries === undefined ? {} : { maxEntries }),
    ...(maxScanMs === undefined ? {} : { maxScanMs }),
    ...(remove ? { remove } : {}),
  });
  const output = join(checkout, '.next', 'dev', 'cache', 'turbopack');
  return {
    cache,
    checkout,
    failCompletionPersistence: () => {
      failCompletionPersistence = true;
    },
    output,
    records,
    setOwnership: (value) => {
      ownership = value;
    },
    setRuntime: (value) => {
      runtime = value;
    },
    target,
  };
}

function canonicalJson(value) {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(',')}]`;
  }
  if (value && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function resign(manifest) {
  const immutable = {
    checkoutIdentity: manifest.checkoutIdentity,
    entries: manifest.entries,
    head: manifest.head,
    ownership: manifest.ownership,
    registered: manifest.registered,
    roots: manifest.roots,
    runtime: manifest.runtime,
    target: manifest.target,
    version: manifest.version,
  };
  const id = createHash('sha256')
    .update(canonicalJson(immutable))
    .digest('hex');
  return { ...manifest, id, immutableHash: id };
}

function generated(fixture, files = { 'a.cache': 'a', 'b.cache': 'b' }) {
  for (const [name, content] of Object.entries(files)) {
    const path = join(fixture.output, name);
    fs.mkdirSync(join(path, '..'), { recursive: true });
    fs.writeFileSync(path, content);
  }
}

test('prepare rejects a symlink planted inside the exact Turbopack directory', async () => {
  const f = fixture();
  generated(f, { 'entry.cache': 'generated' });
  fs.symlinkSync(join(f.checkout, 'source.js'), join(f.output, 'source-link'));

  await expect(f.cache.prepare(f.target)).resolves.toMatchObject({
    code: 'SYMLINK_REJECTED',
    ok: false,
  });
});

test('execute refuses a file added after prepare without touching the manifest paths', async () => {
  const f = fixture();
  generated(f);
  const prepared = await f.cache.prepare(f.target);
  fs.writeFileSync(join(f.output, 'new.cache'), 'new');

  await expect(
    f.cache.execute(prepared.manifest.id, prepared.manifest.id)
  ).resolves.toMatchObject({
    code: 'CACHE_CHANGED',
    ok: false,
  });
  expect(fs.existsSync(join(f.output, 'a.cache'))).toBe(true);
  expect(fs.existsSync(join(f.output, 'new.cache'))).toBe(true);
});

test('execute refuses a manifest when HEAD moved since prepare', async () => {
  const f = fixture();
  generated(f);
  const prepared = await f.cache.prepare(f.target);
  fs.writeFileSync(
    join(f.checkout, 'source.js'),
    'export const source = false;\n'
  );
  git(['add', 'source.js'], f.checkout);
  git(['commit', '-m', 'advance fixture'], f.checkout);

  await expect(
    f.cache.execute(prepared.manifest.id, prepared.manifest.id)
  ).resolves.toMatchObject({
    code: 'HEAD_CHANGED',
    ok: false,
  });
  expect(fs.existsSync(join(f.output, 'a.cache'))).toBe(true);
});

test('execute holds on an active writer rather than clearing its generated output', async () => {
  const f = fixture();
  generated(f);
  const prepared = await f.cache.prepare(f.target);
  f.setOwnership({ state: 'active' });

  await expect(
    f.cache.execute(prepared.manifest.id, prepared.manifest.id)
  ).resolves.toMatchObject({
    code: 'ACTIVE_WRITER',
    ok: false,
  });
  expect(fs.existsSync(join(f.output, 'a.cache'))).toBe(true);
});

test('prepare refuses active, unknown, and queued ownership without persisting a manifest', async () => {
  const cases = [
    { code: 'ACTIVE_WRITER', ownership: { state: 'active' } },
    { code: 'UNKNOWN_WRITER', ownership: { state: 'unknown' } },
    { code: 'TARGET_QUEUED', runtime: { queued: true, state: 'stopped' } },
  ];
  for (const scenario of cases) {
    const f = fixture();
    generated(f, { 'entry.cache': 'generated' });
    if (scenario.ownership) {
      f.setOwnership(scenario.ownership);
    }
    if (scenario.runtime) {
      f.setRuntime(scenario.runtime);
    }

    await expect(f.cache.prepare(f.target)).resolves.toMatchObject({
      code: scenario.code,
      ok: false,
    });
    expect(f.records.size).toBe(0);
  }
});

test('a completed manifest cannot execute a second time', async () => {
  const f = fixture();
  generated(f);
  const prepared = await f.cache.prepare(f.target);

  await expect(
    f.cache.execute(prepared.manifest.id, prepared.manifest.id)
  ).resolves.toMatchObject({
    ok: true,
    removedPaths: expect.arrayContaining([
      '.next/dev/cache/turbopack/a.cache',
      '.next/dev/cache/turbopack/b.cache',
    ]),
  });
  await expect(
    f.cache.execute(prepared.manifest.id, prepared.manifest.id)
  ).resolves.toMatchObject({
    code: 'MANIFEST_ALREADY_EXECUTED',
    ok: false,
  });
});

test('a deletion failure records only completed paths and a retry identity', async () => {
  let failed = false;
  const f = fixture({
    remove: async (entry, fsOps) => {
      if (!failed && entry.path.endsWith('/b.cache')) {
        failed = true;
        throw Object.assign(new Error('fixture failure'), { code: 'EIO' });
      }
      return entry.type === 'file'
        ? fsOps.unlink(entry.path)
        : fsOps.rmdir(entry.path);
    },
  });
  generated(f);
  const prepared = await f.cache.prepare(f.target);

  const result = await f.cache.execute(
    prepared.manifest.id,
    prepared.manifest.id
  );
  expect(result).toMatchObject({
    code: 'CLEANUP_PARTIAL',
    ok: false,
    removedPaths: ['.next/dev/cache/turbopack/a.cache'],
    retryId: 'retry-fixture-id',
  });
  expect(fs.existsSync(join(f.output, 'a.cache'))).toBe(false);
  expect(fs.existsSync(join(f.output, 'b.cache'))).toBe(true);
  await expect(
    f.cache.execute(prepared.manifest.id, {
      manifestId: prepared.manifest.id,
      retryId: result.retryId,
    })
  ).resolves.toMatchObject({
    ok: true,
    removedPaths: [
      '.next/dev/cache/turbopack/a.cache',
      '.next/dev/cache/turbopack/b.cache',
      '.next/dev/cache/turbopack',
    ],
  });
});

test('an unregistered checkout can be described but never executed', async () => {
  const f = fixture({ registered: false });
  generated(f, { 'entry.cache': 'generated' });
  const prepared = await f.cache.prepare(f.target);
  expect(prepared).toMatchObject({ ok: true, registered: false });

  await expect(
    f.cache.execute(prepared.manifest.id, prepared.manifest.id)
  ).resolves.toMatchObject({
    code: 'UNREGISTERED_CHECKOUT',
    ok: false,
  });
  expect(fs.existsSync(join(f.output, 'entry.cache'))).toBe(true);
});

test('a malformed but re-signed root never reaches a path outside the checkout', async () => {
  const f = fixture();
  generated(f, { 'entry.cache': 'generated' });
  const prepared = await f.cache.prepare(f.target);
  const outside = join(f.checkout, '..', 'outside.cache');
  fs.writeFileSync(outside, 'keep');
  const corrupt = resign({
    ...prepared.manifest,
    roots: [{ exists: true, path: '../../outside' }],
  });
  f.records.set(corrupt.id, corrupt);

  await expect(f.cache.execute(corrupt.id, corrupt.id)).resolves.toMatchObject({
    code: 'MANIFEST_INVALID',
    ok: false,
  });
  expect(fs.readFileSync(outside, 'utf8')).toBe('keep');
  expect(fs.existsSync(join(f.output, 'entry.cache'))).toBe(true);
});

test('a malformed retry state is refused before any unlink', async () => {
  const f = fixture();
  generated(f, { 'entry.cache': 'generated' });
  const prepared = await f.cache.prepare(f.target);
  const corrupt = {
    ...prepared.manifest,
    removedPaths: ['../../outside'],
    retryId: 'retry-fixture-id',
    status: 'partial',
  };
  f.records.set(prepared.manifest.id, corrupt);

  await expect(
    f.cache.execute(prepared.manifest.id, {
      manifestId: prepared.manifest.id,
      retryId: 'retry-fixture-id',
    })
  ).resolves.toMatchObject({
    code: 'MANIFEST_INVALID',
    ok: false,
  });
  expect(fs.existsSync(join(f.output, 'entry.cache'))).toBe(true);
});

test('a malformed but re-signed entry path is refused before deletion', async () => {
  const f = fixture();
  generated(f, { 'entry.cache': 'generated' });
  const prepared = await f.cache.prepare(f.target);
  const corrupt = resign({
    ...prepared.manifest,
    entries: prepared.manifest.entries.map((entry) =>
      entry.type === 'file'
        ? { ...entry, path: '.next/dev/cache/turbopack/../../outside' }
        : entry
    ),
  });
  f.records.set(corrupt.id, corrupt);

  await expect(f.cache.execute(corrupt.id, corrupt.id)).resolves.toMatchObject({
    code: 'MANIFEST_INVALID',
    ok: false,
  });
  expect(fs.existsSync(join(f.output, 'entry.cache'))).toBe(true);
});

test('retry accepts an already-removed first generated root after failure in the second', async () => {
  let failed = false;
  const f = fixture({
    remove: async (entry, fsOps) => {
      if (!failed && entry.path.endsWith('/turbopack/b.cache')) {
        failed = true;
        throw Object.assign(new Error('fixture failure'), { code: 'EIO' });
      }
      return entry.type === 'file'
        ? fsOps.unlink(entry.path)
        : fsOps.rmdir(entry.path);
    },
  });
  fs.mkdirSync(join(f.checkout, '.next', 'cache'), { recursive: true });
  fs.writeFileSync(join(f.checkout, '.next', 'cache', 'first.cache'), 'first');
  generated(f);
  const prepared = await f.cache.prepare(f.target);
  const partial = await f.cache.execute(
    prepared.manifest.id,
    prepared.manifest.id
  );
  expect(partial).toMatchObject({ code: 'CLEANUP_PARTIAL', ok: false });
  expect(fs.existsSync(join(f.checkout, '.next', 'cache'))).toBe(false);
  expect(fs.existsSync(join(f.output, 'b.cache'))).toBe(true);

  await expect(
    f.cache.execute(prepared.manifest.id, {
      manifestId: prepared.manifest.id,
      retryId: partial.retryId,
    })
  ).resolves.toMatchObject({ ok: true });
  expect(fs.existsSync(join(f.output))).toBe(false);
});

test('final manifest persistence failure reports an unknown outcome with known removed paths', async () => {
  const f = fixture();
  generated(f, { 'entry.cache': 'generated' });
  const prepared = await f.cache.prepare(f.target);
  f.failCompletionPersistence();

  await expect(
    f.cache.execute(prepared.manifest.id, prepared.manifest.id)
  ).resolves.toMatchObject({
    code: 'CLEANUP_OUTCOME_UNKNOWN',
    ok: false,
    removedPaths: [
      '.next/dev/cache/turbopack/entry.cache',
      '.next/dev/cache/turbopack',
    ],
  });
  expect(fs.existsSync(join(f.output))).toBe(false);
});

test('an entry-count bound produces no executable manifest', async () => {
  const f = fixture({ maxEntries: 1 });
  generated(f);

  await expect(f.cache.prepare(f.target)).resolves.toMatchObject({
    code: 'SCAN_INCOMPLETE',
    ok: false,
  });
  expect(f.records.size).toBe(0);
});

test('a time bound produces no executable manifest', async () => {
  let tick = 0;
  const f = fixture({ maxScanMs: 1, now: () => ++tick * 10 });
  generated(f, { 'entry.cache': 'generated' });

  await expect(f.cache.prepare(f.target)).resolves.toMatchObject({
    code: 'SCAN_INCOMPLETE',
    ok: false,
  });
  expect(f.records.size).toBe(0);
});

test('a verification time bound refuses execution before deleting a prepared path', async () => {
  let verifying = false;
  let tick = 0;
  const f = fixture({
    maxScanMs: 1,
    now: () => (verifying ? ++tick * 10 : 0),
  });
  generated(f, { 'entry.cache': 'generated' });
  const prepared = await f.cache.prepare(f.target);
  verifying = true;

  await expect(
    f.cache.execute(prepared.manifest.id, prepared.manifest.id)
  ).resolves.toMatchObject({
    code: 'SCAN_INCOMPLETE',
    ok: false,
  });
  expect(fs.existsSync(join(f.output, 'entry.cache'))).toBe(true);
});
