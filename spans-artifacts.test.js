import { afterEach, describe, expect, test } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSpansArtifacts } from './spans-artifacts.js';

const roots = [];

function makeRoot() {
  const root = mkdtempSync(join(tmpdir(), 'setu-spans-artifacts-'));
  chmodSync(root, 0o700);
  roots.push(root);
  return root;
}

function digest(mediaType, text) {
  return createHash('sha256')
    .update(mediaType)
    .update('\0')
    .update(text, 'utf8')
    .digest('hex');
}

function blobPath(root, mediaType, text) {
  return join(root, 'artifacts', digest(mediaType, text));
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { force: true, recursive: true });
  }
});

describe('createSpansArtifacts', () => {
  test('requires an explicit absolute private root', () => {
    expect(() => createSpansArtifacts()).toThrow();
    expect(() => createSpansArtifacts({ root: 'relative' })).toThrow();
  });

  test('redacts text and JSON before hashing and storage', () => {
    const root = makeRoot();
    const artifacts = createSpansArtifacts({ root });
    const secret = 'sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789';
    const textResult = artifacts.put({
      mediaType: 'text/plain',
      text: `token=${secret}`,
    });
    const jsonResult = artifacts.put({
      mediaType: 'application/json',
      text: JSON.stringify({ api_key: secret, note: `Bearer ${secret}` }),
    });

    expect(textResult.ok).toBe(true);
    expect(jsonResult.ok).toBe(true);
    const text = artifacts.read({ artifactId: textResult.artifactId });
    const json = artifacts.read({ artifactId: jsonResult.artifactId });
    expect(text.text).not.toContain(secret);
    expect(json.text).not.toContain(secret);
    expect(
      readFileSync(blobPath(root, 'text/plain', text.text), 'utf8')
    ).not.toContain(secret);
    expect(
      readFileSync(blobPath(root, 'application/json', json.text), 'utf8')
    ).not.toContain(secret);
  });

  test('deduplicates fully verified redacted content and distinguishes media types', () => {
    const artifacts = createSpansArtifacts({ root: makeRoot() });
    const first = artifacts.put({
      mediaType: 'text/plain',
      text: 'password=first-secret',
    });
    const same = artifacts.put({
      mediaType: 'text/plain',
      text: 'password=second-secret',
    });
    const differentType = artifacts.put({
      mediaType: 'application/json',
      text: '{"password":"third-secret"}',
    });

    expect(first.ok).toBe(true);
    expect(same).toEqual(first);
    expect(differentType.ok).toBe(true);
    expect(differentType.artifactId).not.toBe(first.artifactId);
  });

  test('validates JSON and supported text media types', () => {
    const artifacts = createSpansArtifacts({ root: makeRoot() });
    expect(
      artifacts.put({ mediaType: 'application/json', text: '{' }).code
    ).toBe('ARTIFACT_JSON_INVALID');
    expect(
      artifacts.put({ mediaType: 'text/html', text: '<script/>' }).code
    ).toBe('ARTIFACT_MEDIA_TYPE_INVALID');
  });

  test('detects corrupt envelopes and refuses to overwrite corrupt prior data', () => {
    const root = makeRoot();
    const artifacts = createSpansArtifacts({ root });
    const prior = artifacts.put({
      mediaType: 'text/plain',
      text: 'durable record',
    });
    const path = blobPath(root, 'text/plain', 'durable record');
    chmodSync(path, 0o600);
    const syntheticErrorContent = '{corrupt secret=never-disclose-this';
    writeFileSync(path, syntheticErrorContent);

    const read = artifacts.read({ artifactId: prior.artifactId });
    expect(read.code).toBe('ARTIFACT_CORRUPT');
    expect(read.error).toBe('Artifact envelope or digest is invalid.');
    expect(read.error).not.toContain('never-disclose-this');
    const retry = artifacts.put({
      mediaType: 'text/plain',
      text: 'durable record',
    });
    expect(retry.ok).toBe(false);
    expect(readFileSync(path, 'utf8')).toBe(syntheticErrorContent);
  });

  test('read does not create an absent artifact directory', () => {
    const root = makeRoot();
    const artifacts = createSpansArtifacts({ root });
    const before = readdirSync(root);
    const result = artifacts.read({ artifactId: `sha256:${'a'.repeat(64)}` });

    expect(result).toEqual({
      code: 'ARTIFACT_DIRECTORY_MISSING',
      error: 'Artifact directory does not exist.',
      ok: false,
    });
    expect(readdirSync(root)).toEqual(before);
  });

  test('rejects malformed IDs, traversal and symlink blobs', () => {
    const root = makeRoot();
    const artifacts = createSpansArtifacts({ root });
    expect(artifacts.read({ artifactId: '../outside' }).code).toBe(
      'ARTIFACT_ID_INVALID'
    );
    expect(
      artifacts.read({ artifactId: `sha256:${'A'.repeat(64)}` }).code
    ).toBe('ARTIFACT_ID_INVALID');

    const text = 'linked artifact';
    const id = `sha256:${digest('text/plain', text)}`;
    mkdirSync(join(root, 'artifacts'), { mode: 0o700 });
    const outside = join(root, `outside-${randomUUID()}`);
    writeFileSync(
      outside,
      JSON.stringify({ mediaType: 'text/plain', text, version: 1 })
    );
    chmodSync(outside, 0o600);
    symlinkSync(outside, join(root, 'artifacts', id.slice(7)));

    expect(artifacts.read({ artifactId: id }).ok).toBe(false);
  });

  test('preserves prior data across interrupted publication leftovers', () => {
    const root = makeRoot();
    const artifacts = createSpansArtifacts({ root });
    const prior = artifacts.put({
      mediaType: 'text/plain',
      text: 'committed before interruption',
    });
    const orphanTemp = join(root, 'artifacts', '.tmp-interrupted-publication');
    writeFileSync(orphanTemp, 'partial envelope', { flag: 'wx', mode: 0o600 });

    const repeated = artifacts.put({
      mediaType: 'text/plain',
      text: 'committed before interruption',
    });
    expect(repeated.ok).toBe(true);
    expect(artifacts.read({ artifactId: prior.artifactId })).toEqual({
      mediaType: 'text/plain',
      ok: true,
      text: 'committed before interruption',
    });
    expect(lstatSync(orphanTemp).isFile()).toBe(true);
  });
});
