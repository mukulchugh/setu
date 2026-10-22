import { expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { dependencyFileInputs } from './dependency-file-inputs.js';

const HEAD_PATTERN = /^[a-f0-9]{40,64}$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;

function git(checkout, args) {
  return execFileSync('git', ['-C', checkout, ...args], { encoding: 'utf8' });
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'setu-inputs-'));
  const checkout = join(root, 'checkout with spaces');
  mkdirSync(checkout);
  gitInit(checkout);
  writeFileSync(
    join(checkout, 'package.json'),
    JSON.stringify({ name: 'fixture-root', workspaces: ['packages/*'] })
  );
  writeFileSync(
    join(checkout, 'bun.lock'),
    [
      '{',
      '  // Bun-generated lock comment',
      '  "lockfileVersion": 1,',
      '  "workspaces": { "": { "dependencies": {}, }, },',
      '}',
      '',
    ].join('\n')
  );
  writeFileSync(
    join(checkout, 'bunfig.toml'),
    '[install]\nlinker = "hoisted"\n'
  );
  writeFileSync(join(checkout, '.gitignore'), 'ignored/\n');
  git(checkout, ['add', '--all']);
  git(checkout, [
    '-c',
    'user.name=fixture',
    '-c',
    'user.email=fixture@example.invalid',
    'commit',
    '--quiet',
    '-m',
    'fixture',
  ]);
  return {
    checkout,
    dispose: () => rmSync(root, { force: true, recursive: true }),
    root,
  };
}

function gitInit(checkout) {
  execFileSync('git', ['-C', checkout, 'init', '--quiet']);
}

function writeManifest(checkout, relativeDirectory, name) {
  const directory = join(checkout, relativeDirectory);
  mkdirSync(directory, { recursive: true });
  writeFileSync(
    join(directory, 'package.json'),
    JSON.stringify({ name, version: '1.0.0' })
  );
  return directory;
}

test('discovers root and nested installed views from committed and untracked manifests with spaces', async () => {
  const f = fixture();
  try {
    const nested = writeManifest(
      f.checkout,
      'packages/widget core',
      'widget-core'
    );
    const untracked = writeManifest(
      f.checkout,
      'apps/renderer view',
      'renderer'
    );
    const ignored = writeManifest(f.checkout, 'ignored/secret', 'ignored');
    for (const directory of [f.checkout, nested, untracked, ignored]) {
      mkdirSync(join(directory, 'node_modules'));
    }

    const result = await dependencyFileInputs(f.checkout);

    expect(result.checkout).toBe(realpathSync(f.checkout));
    expect(result.linker).toBe('hoisted');
    expect(result.roots).toEqual([
      'apps/renderer view/node_modules',
      'node_modules',
      'packages/widget core/node_modules',
    ]);
    expect(result.head).toMatch(HEAD_PATTERN);
    expect(result.device).toBe(lstatSync(f.checkout).dev);
    expect(result.lockfileHash).toBe(
      createHash('sha256')
        .update(
          [
            '{',
            '  // Bun-generated lock comment',
            '  "lockfileVersion": 1,',
            '  "workspaces": { "": { "dependencies": {}, }, },',
            '}',
            '',
          ].join('\n')
        )
        .digest('hex')
    );
    expect(result.inputDigest).toMatch(SHA256_PATTERN);
  } finally {
    f.dispose();
  }
});

test('refuses malformed Bun JSONC locks', async () => {
  const f = fixture();
  try {
    writeFileSync(join(f.checkout, 'bun.lock'), '{ /* unterminated');
    await expect(dependencyFileInputs(f.checkout)).rejects.toMatchObject({
      code: 'DEPENDENCY_INPUT_JSON_INVALID',
    });
  } finally {
    f.dispose();
  }
});

test('input digest changes when a manifest or patch input changes', async () => {
  const f = fixture();
  try {
    const pkg = writeManifest(f.checkout, 'packages/local', 'local');
    const beforeManifest = await dependencyFileInputs(f.checkout);
    writeFileSync(
      join(pkg, 'package.json'),
      JSON.stringify({ name: 'local', version: '2.0.0' })
    );
    const afterManifest = await dependencyFileInputs(f.checkout);
    expect(afterManifest.inputDigest).not.toBe(beforeManifest.inputDigest);

    const beforeLockChange = await dependencyFileInputs(f.checkout);
    writeFileSync(join(f.checkout, 'bun.lock'), '{"configVersion":0}\n');
    const afterLockChange = await dependencyFileInputs(f.checkout);
    expect(afterLockChange.inputDigest).not.toBe(beforeLockChange.inputDigest);
    expect(afterLockChange.lockfileHash).not.toBe(
      beforeLockChange.lockfileHash
    );

    const patches = join(f.checkout, 'patches');
    mkdirSync(patches);
    writeFileSync(join(patches, 'local.patch'), 'diff --git a/x b/x\n');
    const beforePatchChange = await dependencyFileInputs(f.checkout);
    writeFileSync(
      join(patches, 'local.patch'),
      'diff --git a/x b/x\n+change\n'
    );
    const afterPatchChange = await dependencyFileInputs(f.checkout);
    expect(afterPatchChange.inputDigest).not.toBe(
      beforePatchChange.inputDigest
    );
  } finally {
    f.dispose();
  }
});

test('does not follow a workspace symlink when a tracked package manifest moves behind it', async () => {
  const f = fixture();
  const external = join(f.root, 'external workspace');
  try {
    const packageDirectory = writeManifest(
      f.checkout,
      'packages/local',
      'local'
    );
    git(f.checkout, ['add', '--all']);
    git(f.checkout, [
      '-c',
      'user.name=fixture',
      '-c',
      'user.email=fixture@example.invalid',
      'commit',
      '--quiet',
      '-m',
      'workspace manifest',
    ]);
    mkdirSync(external);
    writeManifest(external, '', 'outside');
    mkdirSync(join(external, 'node_modules'));
    rmSync(packageDirectory, { recursive: true });
    symlinkSync(external, packageDirectory, 'dir');

    await expect(dependencyFileInputs(f.checkout)).rejects.toMatchObject({
      code: 'DEPENDENCY_INPUT_SYMLINK',
    });
  } finally {
    f.dispose();
  }
});

test('refuses a missing lock, unknown linker, and unsupported linker instead of guessing', async () => {
  const f = fixture();
  try {
    rmSync(join(f.checkout, 'bun.lock'));
    await expect(dependencyFileInputs(f.checkout)).rejects.toMatchObject({
      code: 'DEPENDENCY_INPUT_LOCK_MISSING',
    });
    writeFileSync(join(f.checkout, 'bun.lock'), '{}');
    writeFileSync(
      join(f.checkout, 'bunfig.toml'),
      '[install]\nregistry = "https://registry.npmjs.org"\n'
    );
    await expect(dependencyFileInputs(f.checkout)).rejects.toMatchObject({
      code: 'DEPENDENCY_INPUT_LINKER_UNKNOWN',
    });
    writeFileSync(
      join(f.checkout, 'bunfig.toml'),
      '[install]\nlinker = "isolated"\n'
    );
    await expect(dependencyFileInputs(f.checkout)).rejects.toMatchObject({
      code: 'DEPENDENCY_INPUT_LINKER_UNSUPPORTED',
    });
  } finally {
    f.dispose();
  }
});

test('refuses ignored patch inputs and package-manager config without reading their contents', async () => {
  const f = fixture();
  try {
    writeFileSync(
      join(f.checkout, '.gitignore'),
      'ignored/\n/patches/private.patch\n/.npmrc\n'
    );
    mkdirSync(join(f.checkout, 'patches'));
    writeFileSync(join(f.checkout, 'patches/private.patch'), 'private patch');
    await expect(dependencyFileInputs(f.checkout)).rejects.toMatchObject({
      code: 'DEPENDENCY_INPUT_PATCH_IGNORED',
    });

    rmSync(join(f.checkout, 'patches'), { recursive: true });
    writeFileSync(
      join(f.checkout, '.npmrc'),
      'registry=https://example.invalid'
    );
    await expect(dependencyFileInputs(f.checkout)).rejects.toMatchObject({
      code: 'DEPENDENCY_INPUT_CONFIG_UNSUPPORTED',
    });
  } finally {
    f.dispose();
  }
});
