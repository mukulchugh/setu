import assert from 'node:assert/strict';
import {
  appendFile,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  rename,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  checkpointSpansSource,
  readSpansSourcePage,
} from './spans-source-file.js';

async function sourceFile(contents, name = 'session.jsonl') {
  const directory = await mkdtemp(join(tmpdir(), 'setu-spans-source-'));
  const path = join(directory, name);
  await writeFile(path, contents);
  return path;
}

async function checkpoint(path, offset) {
  const page = await readSpansSourcePage({ offset: 0, path });
  assert.equal(page.ok, true);
  const result = await checkpointSpansSource({
    expectedIdentity: page.observedIdentity,
    offset,
    path,
  });
  assert.equal(result.ok, true);
  return result.identity;
}

test('reads bounded raw bytes and checkpoints only the committed prefix', async () => {
  const path = await sourceFile('first\nsecond\n');
  const page = await readSpansSourcePage({ maxBytes: 12, offset: 0, path });

  assert.equal(page.ok, true);
  assert.deepEqual(page.bytes, Buffer.from('first\nsecond'));
  assert.equal(page.eof, false);
  assert.equal(page.observedIdentity.offset, 0);
  assert.equal(page.observedIdentity.readObservation.offset, 12);

  const result = await checkpointSpansSource({
    expectedIdentity: page.observedIdentity,
    offset: 6,
    path,
  });
  assert.equal(result.ok, true);
  assert.equal(result.identity.offset, 6);
  assert.equal('readObservation' in result.identity, false);

  const resumed = await readSpansSourcePage({
    expectedIdentity: result.identity,
    offset: 6,
    path,
  });
  assert.equal(resumed.ok, true);
  assert.deepEqual(resumed.bytes, Buffer.from('second\n'));
  assert.equal(resumed.eof, true);
});

test('refuses a replaced inode when resuming', async () => {
  const path = await sourceFile('prefix\nrest\n');
  const identity = await checkpoint(path, 7);
  const oldPath = `${path}.old`;
  await rename(path, oldPath);
  await writeFile(path, 'prefix\nrest\n');

  const result = await readSpansSourcePage({
    expectedIdentity: identity,
    offset: identity.offset,
    path,
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'SOURCE_REPLACED');
  assert.equal(JSON.stringify(result).includes(path), false);
});

test('refuses truncation below a committed checkpoint', async () => {
  const path = await sourceFile('abcdef');
  const identity = await checkpoint(path, 4);
  await writeFile(path, 'ab');

  const result = await readSpansSourcePage({
    expectedIdentity: identity,
    offset: identity.offset,
    path,
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'SOURCE_TRUNCATED');
});

test('detects same-inode rewrites of the committed prefix', async () => {
  const path = await sourceFile('abcdef');
  const identity = await checkpoint(path, 3);
  const before = await lstat(path, { bigint: true });
  const handle = await open(path, 'r+');
  await handle.write(Buffer.from('xyz'), 0, 3, 0);
  await handle.close();
  const after = await lstat(path, { bigint: true });
  assert.equal(before.ino, after.ino);

  const result = await readSpansSourcePage({
    expectedIdentity: identity,
    offset: identity.offset,
    path,
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'SOURCE_PREFIX_CHANGED');
});

test('refuses a changed page before creating its committed checkpoint', async () => {
  const path = await sourceFile('abcdef');
  const page = await readSpansSourcePage({ offset: 0, path });
  assert.equal(page.ok, true);
  const handle = await open(path, 'r+');
  await handle.write(Buffer.from('z'), 0, 1, 5);
  await handle.close();

  const result = await checkpointSpansSource({
    expectedIdentity: page.observedIdentity,
    offset: 3,
    path,
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'SOURCE_PREFIX_CHANGED');
});

test('allows append-only growth after a checkpoint', async () => {
  const path = await sourceFile('old');
  const identity = await checkpoint(path, 3);
  await appendFile(path, '+new');

  const result = await readSpansSourcePage({
    expectedIdentity: identity,
    offset: identity.offset,
    path,
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.bytes, Buffer.from('+new'));
  assert.equal(result.eof, true);
});

test('preserves partial UTF-8 bytes exactly across page boundaries', async () => {
  const contents = Buffer.from([0x61, 0xf0, 0x9f, 0x92, 0xa9, 0x62]);
  const path = await sourceFile(contents);
  const first = await readSpansSourcePage({ maxBytes: 3, offset: 0, path });
  assert.equal(first.ok, true);
  assert.deepEqual(first.bytes, new Uint8Array([0x61, 0xf0, 0x9f]));

  const result = await checkpointSpansSource({
    expectedIdentity: first.observedIdentity,
    offset: 1,
    path,
  });
  assert.equal(result.ok, true);
  const second = await readSpansSourcePage({
    expectedIdentity: result.identity,
    maxBytes: 5,
    offset: 1,
    path,
  });
  assert.equal(second.ok, true);
  assert.deepEqual(
    second.bytes,
    new Uint8Array([0xf0, 0x9f, 0x92, 0xa9, 0x62])
  );
  assert.deepEqual(await readFile(path), contents);
});

test('refuses symlink and credential-file selections without echoing paths', async () => {
  const target = await sourceFile('safe');
  const symlinkPath = `${target}.link`;
  await symlink(target, symlinkPath);

  const symlinkResult = await readSpansSourcePage({
    offset: 0,
    path: symlinkPath,
  });
  assert.equal(symlinkResult.ok, false);
  assert.equal(symlinkResult.code, 'SOURCE_SYMLINK');
  assert.equal(JSON.stringify(symlinkResult).includes(symlinkPath), false);

  const credentialPath = await sourceFile('secret', '.credentials.json');
  const credentialResult = await readSpansSourcePage({
    offset: 0,
    path: credentialPath,
  });
  assert.equal(credentialResult.ok, false);
  assert.equal(credentialResult.code, 'CREDENTIAL_SOURCE');
  assert.equal(
    JSON.stringify(credentialResult).includes(credentialPath),
    false
  );

  const directory = await mkdtemp(join(tmpdir(), 'setu-spans-source-dir-'));
  const directoryResult = await readSpansSourcePage({
    offset: 0,
    path: directory,
  });
  assert.equal(directoryResult.ok, false);
  assert.equal(directoryResult.code, 'SOURCE_NOT_REGULAR');
});

test('requires an absolute source path', async () => {
  const result = await readSpansSourcePage({
    offset: 0,
    path: 'relative/session.jsonl',
  });

  assert.equal(result.ok, false);
  assert.equal(result.code, 'SOURCE_PATH_INVALID');
});

test('refuses a safe-looking alias whose canonical parent is .ssh', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'setu-spans-source-alias-'));
  const credentialsDirectory = join(directory, '.ssh');
  await mkdir(credentialsDirectory);
  await writeFile(
    join(credentialsDirectory, 'session.jsonl'),
    'harmless fixture'
  );

  const aliasDirectory = join(directory, 'selected-source');
  await symlink(credentialsDirectory, aliasDirectory, 'dir');
  const result = await readSpansSourcePage({
    offset: 0,
    path: join(aliasDirectory, 'session.jsonl'),
  });

  assert.equal(result.ok, false);
  assert.equal(result.code, 'CREDENTIAL_SOURCE');
  assert.equal(JSON.stringify(result).includes(directory), false);
});

test('enforces page-size bounds and uses a bounded default page', async () => {
  const path = await sourceFile(Buffer.alloc(256 * 1024 + 16, 0x61));
  const oversized = await readSpansSourcePage({
    maxBytes: 4 * 1024 * 1024 + 1,
    offset: 0,
    path,
  });
  assert.equal(oversized.ok, false);
  assert.equal(oversized.code, 'SOURCE_PAGE_SIZE_INVALID');

  const zero = await readSpansSourcePage({ maxBytes: 0, offset: 0, path });
  assert.equal(zero.ok, false);
  assert.equal(zero.code, 'SOURCE_PAGE_SIZE_INVALID');

  const page = await readSpansSourcePage({ offset: 0, path });
  assert.equal(page.ok, true);
  assert.equal(page.bytes.length, 256 * 1024);
  assert.equal(page.eof, false);
});

test('resumes from a JSON-serialized checkpoint identity', async () => {
  const path = await sourceFile('line-1\nline-2\n');
  const first = await readSpansSourcePage({ maxBytes: 7, offset: 0, path });
  assert.equal(first.ok, true);
  const saved = await checkpointSpansSource({
    expectedIdentity: first.observedIdentity,
    offset: 7,
    path,
  });
  assert.equal(saved.ok, true);

  const restoredIdentity = JSON.parse(JSON.stringify(saved.identity));
  const resumed = await readSpansSourcePage({
    expectedIdentity: restoredIdentity,
    offset: 7,
    path,
  });
  assert.equal(resumed.ok, true);
  assert.deepEqual(resumed.bytes, Buffer.from('line-2\n'));
  assert.equal(resumed.eof, true);
});

test('requires the exact checkpoint offset on resumed reads', async () => {
  const path = await sourceFile('some bytes');
  const identity = await checkpoint(path, 4);
  const result = await readSpansSourcePage({
    expectedIdentity: identity,
    offset: 3,
    path,
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'SOURCE_OFFSET_CONFLICT');
});

test('handles an empty source and rejects invalid arguments', async () => {
  const path = await sourceFile('');
  const page = await readSpansSourcePage({ offset: 0, path });
  assert.equal(page.ok, true);
  assert.equal(page.bytes.length, 0);
  assert.equal(page.eof, true);

  const saved = await checkpointSpansSource({
    expectedIdentity: page.observedIdentity,
    offset: 0,
    path,
  });
  assert.equal(saved.ok, true);
  assert.equal(saved.identity.offset, 0);

  const invalidOffset = await readSpansSourcePage({ offset: -1, path });
  assert.equal(invalidOffset.ok, false);
  assert.equal(invalidOffset.code, 'SOURCE_READ_INVALID');

  const missingIdentity = await readSpansSourcePage({ offset: 1, path });
  assert.equal(missingIdentity.ok, false);
  assert.equal(missingIdentity.code, 'SOURCE_IDENTITY_REQUIRED');

  const accessorInput = { offset: 0, path };
  Object.defineProperty(accessorInput, 'maxBytes', {
    get() {
      throw new Error('fixture-only accessor');
    },
  });
  const accessorResult = await readSpansSourcePage(accessorInput);
  assert.equal(accessorResult.ok, false);
  assert.equal(accessorResult.code, 'SOURCE_READ_INVALID');
});
