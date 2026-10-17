import { afterEach, expect, test } from 'bun:test';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createWorkspaceStorage } from './workspace-storage.js';

const roots = [];
function root() {
  const path = fs.mkdtempSync(join(tmpdir(), 'setu-storage-test-'));
  roots.push(path);
  return path;
}
function reader(storageRoots, options = {}) {
  return createWorkspaceStorage({
    entryLimit: 25_000,
    roots: storageRoots,
    timeoutMs: 5000,
    ...options,
  });
}
afterEach(() => {
  for (const path of roots.splice(0)) {
    fs.chmodSync(path, 0o700);
    fs.rmSync(path, { force: true, recursive: true });
  }
});

test('measures named roots without double-counting nested roots or hard links', async () => {
  const path = root();
  fs.mkdirSync(join(path, 'node_modules'));
  fs.writeFileSync(join(path, 'source.js'), 'source');
  fs.writeFileSync(join(path, 'node_modules', 'package.js'), 'dependency');
  fs.linkSync(join(path, 'source.js'), join(path, 'source-copy.js'));
  const storage = reader([
    { category: 'source', id: 'checkout', path },
    {
      category: 'dependencies',
      id: 'dependencies',
      path: join(path, 'node_modules'),
    },
    {
      category: 'dependencies',
      consumers: [{ name: 'main', repo: 'r' }],
      id: 'dependencies-again',
      path: join(path, 'node_modules'),
    },
  ]);

  const observations = await storage.observeAll();

  expect(observations).toHaveLength(2);
  const source = observations.find((item) => item.id === 'checkout');
  const dependencies = observations.find((item) => item.id === 'dependencies');
  expect(source).toMatchObject({
    category: 'source',
    complete: true,
    state: 'ready',
  });
  expect(source.logicalBytes).toBe(fs.statSync(join(path, 'source.js')).size);
  expect(dependencies).toMatchObject({
    category: 'dependencies',
    complete: true,
    consumers: [{ name: 'main', repo: 'r' }],
    state: 'ready',
  });
  expect(dependencies.logicalBytes).toBe(
    fs.statSync(join(path, 'node_modules', 'package.js')).size
  );
  expect(source).not.toHaveProperty('reclaimableBytes');
  expect(source).toHaveProperty('logicalBytes');
  expect(source).toHaveProperty('allocatedBytes');
});

test('does not follow a symlink loop', async () => {
  const path = root();
  fs.mkdirSync(join(path, 'child'));
  fs.writeFileSync(join(path, 'child', 'file'), 'ok');
  fs.symlinkSync(path, join(path, 'child', 'loop'));

  const [observation] = await reader([
    { category: 'source', id: 'source', path },
  ]).observeAll();

  expect(observation).toMatchObject({
    complete: true,
    skippedSymlinks: 1,
    state: 'ready',
  });
  expect(observation.entries).toBeLessThan(10);
});

test('does not follow a symbolic named root', async () => {
  const path = root();
  const target = join(path, 'target');
  const link = join(path, 'link');
  fs.mkdirSync(target);
  fs.writeFileSync(join(target, 'file'), 'not measured through the link');
  fs.symlinkSync(target, link);

  const [observation] = await reader([
    { category: 'source', id: 'source', path: link },
  ]).observeAll();

  expect(observation).toMatchObject({
    complete: false,
    logicalBytes: null,
    state: 'unknown',
  });
  expect(observation.errors).toContain('SYMLINK_UNSUPPORTED');
});

test('reports unreadable roots as unknown and unreadable descendants as partial', async () => {
  const path = root();
  const blocked = join(path, 'blocked');
  fs.mkdirSync(blocked);
  fs.writeFileSync(join(blocked, 'private'), 'nope');
  fs.chmodSync(blocked, 0o000);
  const storage = reader([{ category: 'source', id: 'source', path }], {
    // biome-ignore lint/suspicious/useAwait: A denied directory fixture must reject through the filesystem promise contract.
    readdirPath: async (target, options) => {
      if (target === blocked) {
        throw Object.assign(new Error('denied'), { code: 'EACCES' });
      }
      return fs.promises.readdir(target, options);
    },
  });

  const [observation] = await storage.observeAll();

  expect(observation).toMatchObject({ complete: false, state: 'partial' });
  expect(observation.errors).toContain('UNREADABLE');
  fs.chmodSync(blocked, 0o700);
  const missing = await reader([
    { category: 'source', id: 'missing', path: join(path, 'missing') },
  ]).observeAll();
  expect(missing[0]).toMatchObject({
    allocatedBytes: null,
    complete: false,
    logicalBytes: null,
    state: 'unknown',
  });
});

test('observes a named file root', async () => {
  const path = root();
  const file = join(path, 'artifact');
  fs.writeFileSync(file, 'artifact');

  const [observation] = await reader([
    { category: 'generated', id: 'artifact', path: file },
  ]).observeAll();

  expect(observation).toMatchObject({
    complete: true,
    entries: 0,
    logicalBytes: fs.statSync(file).size,
    state: 'ready',
  });
});

test('stops at the configured entry limit', async () => {
  const path = root();
  for (let index = 0; index < 4; index += 1) {
    fs.writeFileSync(join(path, `file-${index}`), 'x');
  }

  const [observation] = await reader(
    [{ category: 'source', id: 'source', path }],
    { entryLimit: 2 }
  ).observeAll();

  expect(observation).toMatchObject({
    complete: false,
    entries: 2,
    state: 'partial',
  });
  expect(observation.errors).toContain('ENTRY_LIMIT');
});

test('returns a partial observation when a directory read exceeds its time limit', async () => {
  const path = root();
  fs.writeFileSync(join(path, 'file'), 'x');
  const [observation] = await reader(
    [{ category: 'source', id: 'source', path }],
    {
      readdirPath: async (target, options) => {
        await new Promise((resolve) => setTimeout(resolve, 25));
        return fs.promises.readdir(target, options);
      },
      timeoutMs: 1,
    }
  ).observeAll();

  expect(observation).toMatchObject({ complete: false, state: 'partial' });
  expect(observation.errors).toContain('TIME_LIMIT');
});

test('shares one in-flight observation per root and reads cache without scanning', async () => {
  const path = root();
  fs.writeFileSync(join(path, 'file'), 'x');
  let scans = 0;
  let release;
  const wait = new Promise((resolve) => {
    release = resolve;
  });
  const storage = reader([{ category: 'source', id: 'source', path }], {
    readdirPath: async (target, options) => {
      scans += 1;
      await wait;
      return fs.promises.readdir(target, options);
    },
  });

  const first = storage.observe('source');
  const second = storage.observe('source');
  expect(storage.read('source')).toBeUndefined();
  release();
  const [a, b] = await Promise.all([first, second]);

  expect(scans).toBe(1);
  expect(a).toEqual(b);
  expect(storage.read('source')).toEqual(a);
});

test('refreshes all roots together so mixed warm and cold observations deduplicate consistently', async () => {
  const path = root();
  const a = join(path, 'a');
  const b = join(path, 'b');
  fs.mkdirSync(a);
  fs.mkdirSync(b);
  fs.writeFileSync(join(a, 'payload'), 'shared');
  fs.linkSync(join(a, 'payload'), join(b, 'payload'));
  const storageRoots = [
    { category: 'source', id: 'a', path: a },
    { category: 'generated', id: 'b', path: b },
  ];
  const warm = reader(storageRoots);
  await warm.observe('a');
  const mixed = await warm.observeAll();
  const cold = await reader(storageRoots).observeAll();

  expect(mixed.map((item) => item.logicalBytes)).toEqual(
    cold.map((item) => item.logicalBytes)
  );
  expect(mixed.map((item) => item.logicalBytes)).toEqual([
    fs.statSync(join(a, 'payload')).size,
    0,
  ]);
});

test('labels concurrent single-root observations as not cross-root physical totals', async () => {
  const path = root();
  const a = join(path, 'a');
  const b = join(path, 'b');
  fs.mkdirSync(a);
  fs.mkdirSync(b);
  fs.writeFileSync(join(a, 'payload'), 'shared');
  fs.linkSync(join(a, 'payload'), join(b, 'payload'));
  const storage = reader([
    { category: 'source', id: 'a', path: a },
    { category: 'generated', id: 'b', path: b },
  ]);

  const [first, second] = await Promise.all([
    storage.observe('a'),
    storage.observe('b'),
  ]);

  expect(first.crossRootPhysicalBytes).toBeNull();
  expect(second.crossRootPhysicalBytes).toBeNull();
  expect(first.logicalBytes + second.logicalBytes).toBe(
    fs.statSync(join(a, 'payload')).size * 2
  );
});

test('keeps a timed-out root single-flight until its filesystem call settles', async () => {
  const path = root();
  let scans = 0;
  let release;
  const blocked = new Promise((resolve) => {
    release = resolve;
  });
  const storage = reader([{ category: 'source', id: 'source', path }], {
    readdirPath: async (target, options) => {
      scans += 1;
      await blocked;
      return fs.promises.readdir(target, options);
    },
    timeoutMs: 1,
  });

  const first = await storage.observe('source');
  const second = await Promise.race([
    storage.observe('source'),
    new Promise((resolve) => setTimeout(() => resolve('waited too long'), 25)),
  ]);
  release();

  expect(first).toMatchObject({ errors: ['TIME_LIMIT'], state: 'partial' });
  expect(second).toEqual(first);
  expect(scans).toBe(1);
});
