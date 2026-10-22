import { afterEach, expect, test } from 'bun:test';
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  lstat,
  readdir,
  readFile,
  readlink,
  withDependencyCheckpoint,
} from './dependency-readiness-checkpoint.js';

const roots = [];
afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { force: true, recursive: true });
  }
});
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'setu-readiness-checkpoint-'));
  roots.push(root);
  return root;
}

test('a final synchronous check refuses changed contents after async readiness', async () => {
  const root = fixture();
  const path = join(root, 'package.json');
  writeFileSync(path, '{"name":"one"}');
  const result = await withDependencyCheckpoint(async () => {
    await lstat(path, { bigint: true });
    await readFile(path, 'utf8');
    return { identity: 'receipt', ok: true };
  });
  expect(result.ok).toBe(true);
  expect(result.checkCurrent()).toBe(true);
  expect(result.checkCurrent()).not.toBeInstanceOf(Promise);
  writeFileSync(path, '{"name":"two"}');
  expect(result.checkCurrent()).toBe(false);
});

test('a missing input becoming present invalidates the exact observation', async () => {
  const path = join(fixture(), 'bunfig.toml');
  const result = await withDependencyCheckpoint(async () => {
    await lstat(path).catch((error) => {
      expect(error.code).toBe('ENOENT');
    });
    return { ok: true };
  });
  expect(result.checkCurrent()).toBe(true);
  writeFileSync(path, '[install]');
  expect(result.checkCurrent()).toBe(false);
});

test('workspace discovery and link target changes invalidate final readiness', async () => {
  const root = fixture();
  mkdirSync(join(root, 'one'));
  mkdirSync(join(root, 'two'));
  const link = join(root, 'link');
  symlinkSync('one', link);
  const result = await withDependencyCheckpoint(async () => {
    await readdir(root, { withFileTypes: true });
    await readlink(link);
    return { ok: true };
  });
  expect(result.checkCurrent()).toBe(true);
  unlinkSync(link);
  symlinkSync('two', link);
  expect(result.checkCurrent()).toBe(false);
});

test('failed inspection never provides a successful final checkpoint', async () => {
  const failed = await withDependencyCheckpoint(() => ({ ok: false }));
  expect(Object.hasOwn(failed, 'checkCurrent')).toBe(false);
});
