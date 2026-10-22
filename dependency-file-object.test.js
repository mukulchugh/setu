import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import {
  dependencyObjectKey,
  sameDependencyObject,
} from './dependency-file-object.js';

const hash = (value) => createHash('sha256').update(value).digest('hex');

function fingerprint(overrides = {}) {
  return {
    atimeNs: '100',
    attributes: [{ digest: hash('xattr'), name: 'user.note' }],
    contentHash: hash('bytes'),
    ctimeNs: '200',
    device: '7',
    gid: 20,
    identityHash: hash('identity'),
    inode: '9',
    metadataHash: hash('legacy metadata'),
    mode: 0o10_0644,
    mtimeNs: '300',
    relativePath: 'node_modules/pkg.js',
    size: 5,
    uid: 501,
    ...overrides,
  };
}

test('version 2 object identity reuses stable file metadata across different mtimes', () => {
  const first = fingerprint();
  const second = fingerprint({
    atimeNs: '900',
    ctimeNs: '800',
    device: '8',
    identityHash: hash('other identity'),
    inode: '10',
    metadataHash: hash('other legacy metadata'),
    mtimeNs: '700',
    relativePath: 'node_modules/other.js',
  });

  expect(dependencyObjectKey(first)).toBe(dependencyObjectKey(second));
  expect(sameDependencyObject(first, second)).toBe(true);
  expect(dependencyObjectKey(first)).toBe(
    hash(
      `setu-dependency-object-v2\0${JSON.stringify([
        first.contentHash,
        first.size,
        first.mode,
        first.uid,
        first.gid,
        [['user.note', hash('xattr')]],
      ])}`
    )
  );
  expect(dependencyObjectKey(first, 1)).toBe(
    hash(`${first.contentHash}${first.metadataHash}`)
  );
});

test('object identity rejects malformed fingerprints and unsupported versions', () => {
  expect(() =>
    dependencyObjectKey(
      fingerprint({ attributes: [{ digest: 'bad', name: 'x' }] })
    )
  ).toThrow();
  expect(() =>
    dependencyObjectKey(
      fingerprint({
        attributes: [
          { digest: hash('one'), name: 'x' },
          { digest: hash('two'), name: 'x' },
        ],
      })
    )
  ).toThrow();
  expect(() => dependencyObjectKey(fingerprint(), 3)).toThrow();
  expect(sameDependencyObject(fingerprint(), null)).toBe(false);
});
