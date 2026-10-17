import { afterEach, expect, test } from 'bun:test';
import {
  chmodSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inspectSpansCapacity } from './spans-capacity.js';

const roots = [];
function makeRoot() {
  const root = mkdtempSync(join(tmpdir(), 'setu-spans-capacity-'));
  roots.push(root);
  return root;
}

function makePrivateTree(root, ...segments) {
  let path = root;
  for (const segment of segments) {
    path = join(path, segment);
    mkdirSync(path, { mode: 0o700 });
    chmodSync(path, 0o700);
  }
  return path;
}

function snapshot(path) {
  const stat = lstatSync(path);
  const entry = {
    mode: stat.mode,
    mtimeMs: stat.mtimeMs,
    path,
    size: stat.size,
  };
  if (stat.isDirectory()) {
    entry.children = readdirSync(path)
      .sort()
      .map((name) => snapshot(join(path, name)));
  }
  return entry;
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { force: true, recursive: true });
  }
});

test('counts database sidecars, nested artifacts, spool and remaining files', async () => {
  const root = makeRoot();
  const nestedArtifacts = makePrivateTree(root, 'artifacts', 'nested');
  const pendingSpool = makePrivateTree(root, 'spool', 'pending');
  writeFileSync(join(root, 'spans.sqlite3'), 'db');
  writeFileSync(join(root, 'spans.sqlite3-wal'), 'wal!');
  writeFileSync(join(root, 'spans.sqlite3-shm'), 'shm');
  writeFileSync(join(root, 'spans.sqlite3-journal'), 'journal');
  writeFileSync(join(nestedArtifacts, 'orphan.tmp'), 'orphan');
  writeFileSync(join(pendingSpool, 'capture'), 'spool');
  writeFileSync(join(root, 'index.json'), 'other');

  const result = await inspectSpansCapacity({ root });

  expect(result).toMatchObject({
    artifactBytes: 6,
    databaseBytes: 16,
    otherBytes: 5,
    spoolBytes: 5,
    state: 'known',
    totalBytes: 32,
  });
});

test('counts a hard-linked artifact only once', async () => {
  const root = makeRoot();
  makePrivateTree(root, 'artifacts');
  writeFileSync(join(root, 'artifacts', 'content'), 'content-addressed');
  linkSync(
    join(root, 'artifacts', 'content'),
    join(root, 'artifacts', '.publish-temp')
  );

  const result = await inspectSpansCapacity({ root });

  expect(result).toMatchObject({ artifactBytes: 17, totalBytes: 17 });
});

test('assigns a cross-category hard link to the first sorted archive path', async () => {
  const root = makeRoot();
  makePrivateTree(root, 'artifacts');
  makePrivateTree(root, 'spool');
  writeFileSync(join(root, 'artifacts', 'content'), 'bytes');
  linkSync(
    join(root, 'artifacts', 'content'),
    join(root, 'spool', 'capture-link')
  );

  const result = await inspectSpansCapacity({ root });

  expect(result).toMatchObject({
    artifactBytes: 5,
    spoolBytes: 0,
    totalBytes: 5,
  });
});

test('warns at 80 percent and allows a launch below the budget', async () => {
  const root = makeRoot();
  writeFileSync(join(root, 'data'), '12345678');

  const result = await inspectSpansCapacity({ budgetBytes: 10, root });

  expect(result).toMatchObject({
    newLaunchAllowed: true,
    totalBytes: 8,
    warning: true,
  });
});

test('refuses a launch at the budget and includes the owner-provided reserve', async () => {
  const root = makeRoot();
  writeFileSync(join(root, 'data'), '1234567');

  const result = await inspectSpansCapacity({
    budgetBytes: 10,
    reservedCaptureBytes: 3,
    root,
  });

  expect(result).toMatchObject({
    newLaunchAllowed: false,
    reservedCaptureBytes: 3,
    totalBytes: 7,
    warning: true,
  });
});

test('reports missing roots and invalid limits as unknown', async () => {
  const root = makeRoot();
  const missing = join(root, 'private-root-name-missing');

  const missingResult = await inspectSpansCapacity({ root: missing });
  expect(missingResult).toMatchObject({
    code: 'ENOENT',
    error: 'archive path does not exist',
    newLaunchAllowed: false,
    ok: false,
    state: 'unknown',
  });
  expect(JSON.stringify(missingResult)).not.toContain(root);
  await expect(
    inspectSpansCapacity({ root: 'relative/archive' })
  ).resolves.toMatchObject({
    code: 'ROOT_INVALID',
    newLaunchAllowed: false,
    state: 'unknown',
  });
  await expect(
    inspectSpansCapacity({ budgetBytes: 0, root })
  ).resolves.toMatchObject({
    code: 'BUDGET_INVALID',
    newLaunchAllowed: false,
    state: 'unknown',
  });
  await expect(
    inspectSpansCapacity({ reservedCaptureBytes: -1, root })
  ).resolves.toMatchObject({
    code: 'RESERVE_INVALID',
    newLaunchAllowed: false,
    state: 'unknown',
  });
});

test('sanitizes inaccessible filesystem errors without exposing the root', async () => {
  const root = makeRoot();
  writeFileSync(join(root, 'not-a-directory'), 'private');
  const inaccessible = join(root, 'not-a-directory', 'archive');

  const result = await inspectSpansCapacity({ root: inaccessible });

  expect(result).toMatchObject({
    code: 'ENOTDIR',
    error: 'archive path contains a non-directory component',
    newLaunchAllowed: false,
    ok: false,
    state: 'unknown',
  });
  expect(JSON.stringify(result)).not.toContain(root);
});

test('refuses symlinks without following them', async () => {
  const root = makeRoot();
  const outside = makeRoot();
  writeFileSync(join(outside, 'secret'), 'private');
  symlinkSync(outside, join(root, 'linked-directory'));

  await expect(inspectSpansCapacity({ root })).resolves.toMatchObject({
    code: 'SYMLINK_UNSUPPORTED',
    newLaunchAllowed: false,
    state: 'unknown',
  });
});

test('requires private permissions on the explicit root', async () => {
  const root = makeRoot();
  chmodSync(root, 0o755);

  await expect(inspectSpansCapacity({ root })).resolves.toMatchObject({
    code: 'ROOT_NOT_PRIVATE',
    newLaunchAllowed: false,
    state: 'unknown',
  });
});

test('requires nested directories to remain private', async () => {
  const root = makeRoot();
  const nested = join(root, 'private-nested-name');
  mkdirSync(nested);
  chmodSync(nested, 0o755);

  const result = await inspectSpansCapacity({ root });

  expect(result).toMatchObject({
    code: 'DIRECTORY_NOT_PRIVATE',
    error: 'archive directory permissions must exclude group and other',
    newLaunchAllowed: false,
    ok: false,
    state: 'unknown',
  });
  expect(JSON.stringify(result)).not.toContain(root);
});

test('does not mutate the archive while inspecting it', async () => {
  const root = makeRoot();
  makePrivateTree(root, 'artifacts');
  makePrivateTree(root, 'spool');
  writeFileSync(join(root, 'spans.sqlite3'), 'db');
  writeFileSync(join(root, 'artifacts', 'artifact'), 'evidence');
  writeFileSync(join(root, 'spool', 'capture'), 'pending');
  const before = snapshot(root);

  await inspectSpansCapacity({ root });

  expect(snapshot(root)).toEqual(before);
});
