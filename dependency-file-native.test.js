import { afterEach, describe, expect, test } from 'bun:test';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { constants as fsConstants } from 'node:fs';
import {
  lstat,
  mkdir,
  mkdtemp,
  realpath,
  rename,
  rm,
  symlink,
  utimes,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  createDependencyFileNative,
  sameDependencyFile,
} from './dependency-file-native.js';

const roots = new Set();
const HEX_FIELD_PATTERN = /^(?:[a-f0-9]{2})*$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;

async function fixtureRoot() {
  const path = await mkdtemp(join(tmpdir(), 'setu-dependency-file-native-'));
  const canonical = await realpath(path);
  roots.add(canonical);
  return canonical;
}

afterEach(async () => {
  await Promise.all(
    [...roots].map((root) => rm(root, { force: true, recursive: true }))
  );
  roots.clear();
});

function helperOutput(value) {
  return { stderr: '', stdout: `${JSON.stringify(value)}\n` };
}

function nativeRunner({
  attributes = {},
  commandLog = [],
  probeFields = {},
} = {}) {
  return async (command, args, options) => {
    commandLog.push({ args, command, options });
    if (command === '/usr/bin/xattr') {
      if (args[0] === '-s' && args.length === 2) {
        return {
          stderr: '',
          stdout: `${Object.keys(attributes).join('\n')}${Object.keys(attributes).length ? '\n' : ''}`,
        };
      }
      if (args[1] === '-p' && args[2] === '-x') {
        const value = attributes[args[3]];
        if (value === undefined) {
          throw Object.assign(new Error('missing fixture attribute'), {
            code: 'ENOATTR',
          });
        }
        return { stderr: '', stdout: `${value}\n` };
      }
      throw new Error('unexpected xattr command');
    }
    if (command !== '/test/setu-dependency-files') {
      throw new Error('unexpected helper binary');
    }
    if (args[0] === 'version') {
      return helperOutput({
        capabilities: ['stdio', 'xattrs', 'swap', 'forced-clone', 'lease'],
        ok: true,
        protocol: 2,
        version: '2',
      });
    }
    if (args[0] === 'lease-acquire') {
      return helperOutput({
        key: args[2],
        lease: 'acquired',
        ok: true,
        protocol: 2,
      });
    }
    if (args[0] === 'lease-release') {
      return helperOutput({
        key: args[1],
        lease: 'released',
        ok: true,
        protocol: 2,
      });
    }
    if (args[0] === 'probe') {
      const info = await lstat(join(args[1], ...args[2].split('/')), {
        bigint: true,
      });
      const probe = {
        acl: false,
        atimeNs: String(info.atimeNs),
        attributes: [],
        ctimeNs: String(info.ctimeNs),
        device: String(info.dev),
        flags: 0,
        gid: Number(info.gid),
        inode: String(info.ino),
        mode: Number(info.mode),
        mtimeNs: String(info.mtimeNs),
        nlink: Number(info.nlink),
        ok: true,
        protocol: 1,
        regular: info.isFile(),
        size: String(info.size),
        sparse: false,
        uid: Number(info.uid),
        ...probeFields,
      };
      return helperOutput(probe);
    }
    if (args[0] === 'restore-times') {
      const atime = new Date(Number(BigInt(args[3])) / 1_000_000);
      const mtime = new Date(Number(BigInt(args[4])) / 1_000_000);
      await utimes(join(args[1], ...args[2].split('/')), atime, mtime);
      return helperOutput({
        atimeNs: args[3],
        device: args[5],
        inode: args[6],
        mtimeNs: args[4],
        ok: true,
        protocol: 1,
        restored: true,
      });
    }
    if (args[0] === 'swap') {
      return helperOutput({ exchanged: true, ok: true, protocol: 1 });
    }
    throw new Error('unexpected helper command');
  };
}

function makeNative(options = {}) {
  return createDependencyFileNative({
    nativeBinary: '/test/setu-dependency-files',
    processRunner: nativeRunner(options),
  });
}

function fakeWorkerSpawn(onRequest, { requests = [] } = {}) {
  let launches = 0;
  const spawnProcess = (_binary, args, options) => {
    launches += 1;
    expect(args).toEqual(['stdio']);
    expect(options.stdio).toEqual(['pipe', 'pipe', 'ignore']);
    const child = new EventEmitter();
    child.exitCode = null;
    child.signalCode = null;
    child.stdout = new EventEmitter();
    child.stdout.setEncoding = () => undefined;
    child.stdin = {
      end() {
        queueMicrotask(() => child.emit('exit', 0, null));
      },
      on() {
        // The mock stream accepts the production error listener.
      },
      write(frame, _encoding, callback) {
        requests.push(frame);
        expect(Buffer.byteLength(frame)).toBeLessThanOrEqual(64 * 1024);
        queueMicrotask(async () => {
          try {
            const [countText, ...hexFields] = frame.trimEnd().split('\t');
            expect(Number(countText)).toBe(hexFields.length);
            expect(
              hexFields.every((field) => HEX_FIELD_PATTERN.test(field))
            ).toBe(true);
            const fields = hexFields.map((field) =>
              Buffer.from(field, 'hex').toString('utf8')
            );
            const response = await onRequest(fields);
            if (response !== null) {
              child.stdout.emit('data', `${JSON.stringify(response)}\n`);
            }
          } catch (error) {
            child.emit('error', error);
          }
        });
        callback?.();
      },
    };
    child.kill = (signal) => {
      child.signalCode = signal;
      child.exitCode = null;
      queueMicrotask(() => child.emit('exit', null, signal));
      return true;
    };
    return child;
  };
  spawnProcess.launchCount = () => launches;
  return spawnProcess;
}

function leaseWorkerSpawn(onRequest, { commands = [] } = {}) {
  const children = [];
  const spawnProcess = () => {
    const previous = children.at(-1);
    if (previous && !previous.didExit) {
      throw new Error('worker respawned before the previous helper exited');
    }
    const child = new EventEmitter();
    child.exitCode = null;
    child.signalCode = null;
    child.didExit = false;
    child.stdout = new EventEmitter();
    child.stdout.setEncoding = () => undefined;
    child.stdin = new EventEmitter();
    child.stdin.end = () => {
      child.exitCode = 0;
      queueMicrotask(() => {
        child.didExit = true;
        child.emit('exit', 0, null);
      });
    };
    child.stdin.write = (frame, _encoding, callback) => {
      const [countText, ...hexFields] = frame.trimEnd().split('\t');
      const fields = hexFields.map((field) =>
        Buffer.from(field, 'hex').toString('utf8')
      );
      expect(Number(countText)).toBe(fields.length);
      commands.push(fields);
      callback?.();
      queueMicrotask(async () => {
        try {
          const response = await onRequest(fields, child);
          if (
            response !== null &&
            child.exitCode === null &&
            child.signalCode === null
          ) {
            child.stdout.emit('data', `${JSON.stringify(response)}\n`);
          }
        } catch (error) {
          child.emit('error', error);
        }
      });
    };
    child.kill = (signal) => {
      queueMicrotask(() => {
        child.signalCode = signal;
        child.didExit = true;
        child.emit('exit', null, signal);
      });
      return true;
    };
    children.push(child);
    return child;
  };
  spawnProcess.launchCount = () => children.length;
  spawnProcess.children = children;
  return spawnProcess;
}

async function probeResponse(root, relativePath) {
  const info = await lstat(join(root, ...relativePath.split('/')), {
    bigint: true,
  });
  return {
    acl: false,
    atimeNs: String(info.atimeNs),
    attributes: [{ name: 'com.apple.provenance', valueHex: '0001ff' }],
    ctimeNs: String(info.ctimeNs),
    device: String(info.dev),
    flags: 0,
    gid: Number(info.gid),
    inode: String(info.ino),
    mode: Number(info.mode),
    mtimeNs: String(info.mtimeNs),
    nlink: Number(info.nlink),
    ok: true,
    protocol: 1,
    regular: info.isFile(),
    size: String(info.size),
    sparse: false,
    uid: Number(info.uid),
  };
}

describe('sameDependencyFile', () => {
  const left = {
    atimeNs: '12',
    attributes: [],
    contentHash: 'a'.repeat(64),
    ctimeNs: '11',
    device: '1',
    gid: 20,
    identityHash: 'c'.repeat(64),
    inode: '2',
    metadataHash: 'b'.repeat(64),
    mode: 33_188,
    mtimeNs: '10',
    relativePath: 'node_modules/a/index.js',
    size: 5,
    uid: 501,
  };

  test('compares content and preserved metadata without requiring matching inode or path', () => {
    const cloned = {
      ...left,
      atimeNs: '300',
      ctimeNs: '200',
      device: '1',
      identityHash: 'd'.repeat(64),
      inode: '99',
      relativePath: 'node_modules/a/index.js',
    };

    expect(sameDependencyFile(left, cloned)).toBe(true);
    expect(
      sameDependencyFile(left, { ...cloned, metadataHash: 'e'.repeat(64) })
    ).toBe(false);
    expect(sameDependencyFile(left, { ...cloned, size: 6 })).toBe(false);
  });

  test('requires the complete stable identity when identity comparison is requested', () => {
    expect(
      sameDependencyFile(left, { ...left, atimeNs: '999' }, { identity: true })
    ).toBe(true);
    expect(
      sameDependencyFile(left, { ...left, inode: '3' }, { identity: true })
    ).toBe(false);
    expect(
      sameDependencyFile(left, { ...left, ctimeNs: '14' }, { identity: true })
    ).toBe(false);
  });
});

describe('readDependencyFile', () => {
  test('streams a regular single-link file and returns the access-time snapshot from before the read', async () => {
    const root = await fixtureRoot();
    const file = join(root, 'package', 'entry.js');
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, 'contract fixture', { mode: 0o640 });
    const initial = await lstat(file, { bigint: true });
    const native = makeNative();

    const result = await native.readDependencyFile(root, 'package/entry.js');

    expect(result.eligible).toBe(true);
    expect(result.fingerprint).toMatchObject({
      atimeNs: String(initial.atimeNs),
      attributes: [],
      gid: Number(initial.gid),
      mode: Number(initial.mode),
      relativePath: 'package/entry.js',
      size: Buffer.byteLength('contract fixture'),
      uid: Number(initial.uid),
    });
    expect(result.fingerprint.contentHash).toBe(
      createHash('sha256').update('contract fixture').digest('hex')
    );
    expect(result.fingerprint.metadataHash).toMatch(SHA256_PATTERN);
    expect(result.fingerprint.identityHash).toMatch(SHA256_PATTERN);
  });

  test('preserves the digest of the supported provenance attribute', async () => {
    const root = await fixtureRoot();
    await writeFile(join(root, 'entry.js'), 'with provenance');
    const native = makeNative({
      attributes: { 'com.apple.provenance': '00 01 02 ff' },
    });

    const result = await native.readDependencyFile(root, 'entry.js');

    expect(result.eligible).toBe(true);
    expect(result.fingerprint.attributes).toEqual([
      {
        digest: createHash('sha256')
          .update(Buffer.from([0, 1, 2, 255]))
          .digest('hex'),
        name: 'com.apple.provenance',
      },
    ]);
  });

  test('refuses unknown attributes instead of silently dropping them', async () => {
    const root = await fixtureRoot();
    await writeFile(join(root, 'entry.js'), 'unknown metadata');
    const native = makeNative({
      attributes: { 'com.example.unknown': '01 02' },
    });

    const result = await native.readDependencyFile(root, 'entry.js');

    expect(result).toEqual({ eligible: false, reason: 'unknown-attribute' });
  });

  test('refuses unsafe relative paths before invoking native probes', async () => {
    const root = await fixtureRoot();
    const commands = [];
    const native = createDependencyFileNative({
      nativeBinary: '/test/setu-dependency-files',
      processRunner: nativeRunner({ commandLog: commands }),
    });

    const relativePaths = [
      '../secret',
      '/absolute',
      '.git/config',
      '.GIT/config',
      'a/./b',
      'a/../b',
      'a\0b',
    ];
    const results = await Promise.all(
      relativePaths.map((relativePath) =>
        native.readDependencyFile(root, relativePath)
      )
    );
    for (const result of results) {
      expect(result).toEqual({
        eligible: false,
        reason: 'unsafe-relative-path',
      });
    }
    expect(commands).toHaveLength(0);
  });

  test('refuses a symlink ancestor before reading the leaf', async () => {
    const root = await fixtureRoot();
    const outside = await fixtureRoot();
    await writeFile(join(outside, 'entry.js'), 'outside');
    await symlink(outside, join(root, 'linked'));
    const commands = [];
    const native = createDependencyFileNative({
      nativeBinary: '/test/setu-dependency-files',
      processRunner: nativeRunner({ commandLog: commands }),
    });

    const result = await native.readDependencyFile(root, 'linked/entry.js');

    expect(result).toEqual({ eligible: false, reason: 'symlink-ancestor' });
    expect(commands).toHaveLength(0);
  });

  test.each([
    ['hard link', { nlink: 2 }, 'hard-linked-file'],
    ['extended ACL', { acl: true }, 'acl-present'],
    ['file flags', { flags: 1 }, 'file-flags-present'],
    ['sparse data', { sparse: true }, 'sparse-file'],
  ])(
    'refuses %s metadata reported by the descriptor probe',
    async (_label, probeFields, reason) => {
      const root = await fixtureRoot();
      await writeFile(join(root, 'entry.js'), 'metadata fixture');
      const native = makeNative({ probeFields });

      const result = await native.readDependencyFile(root, 'entry.js');

      expect(result).toEqual({ eligible: false, reason });
    }
  );
});

describe('cloneDependencyFile', () => {
  test('forces an exclusive CoW clone, restores saved times, and verifies independent bytes', async () => {
    const root = await fixtureRoot();
    const sourceRoot = join(root, 'source');
    const destinationRoot = join(root, 'destination');
    await mkdir(sourceRoot);
    await mkdir(destinationRoot);
    await writeFile(join(sourceRoot, 'package.js'), 'clone-only content', {
      mode: 0o640,
    });
    const savedTime = new Date('2024-03-04T05:06:07.123Z');
    await utimes(join(sourceRoot, 'package.js'), savedTime, savedTime);
    const commands = [];
    const native = createDependencyFileNative({
      nativeBinary: '/test/setu-dependency-files',
      processRunner: nativeRunner({ commandLog: commands }),
    });
    const source = await native.readDependencyFile(sourceRoot, 'package.js');

    const clone = await native.cloneDependencyFile(
      sourceRoot,
      'package.js',
      destinationRoot,
      'package.js',
      source.fingerprint
    );

    expect(clone.inode).not.toBe(source.fingerprint.inode);
    expect(sameDependencyFile(source.fingerprint, clone)).toBe(true);
    expect(
      commands.some(
        ({ command, args }) =>
          command === '/test/setu-dependency-files' &&
          args[0] === 'restore-times' &&
          args[3] === source.fingerprint.atimeNs &&
          args[4] === source.fingerprint.mtimeNs
      )
    ).toBe(true);
    expect(fsConstants.COPYFILE_FICLONE_FORCE).toBeDefined();

    await writeFile(
      join(destinationRoot, 'package.js'),
      'changed destination bytes'
    );
    expect(await Bun.file(join(sourceRoot, 'package.js')).text()).toBe(
      'clone-only content'
    );
    expect(await Bun.file(join(destinationRoot, 'package.js')).text()).toBe(
      'changed destination bytes'
    );
  });

  test('does not overwrite an existing destination', async () => {
    const root = await fixtureRoot();
    const sourceRoot = join(root, 'source');
    const destinationRoot = join(root, 'destination');
    await mkdir(sourceRoot);
    await mkdir(destinationRoot);
    await writeFile(join(sourceRoot, 'entry.js'), 'source');
    await writeFile(join(destinationRoot, 'entry.js'), 'keep destination');
    const native = makeNative();
    const source = await native.readDependencyFile(sourceRoot, 'entry.js');

    await expect(
      native.cloneDependencyFile(
        sourceRoot,
        'entry.js',
        destinationRoot,
        'entry.js',
        source.fingerprint
      )
    ).rejects.toMatchObject({ code: 'EEXIST' });
    expect(await Bun.file(join(destinationRoot, 'entry.js')).text()).toBe(
      'keep destination'
    );
  });

  test('refuses a stale expected source identity before creating the destination', async () => {
    const root = await fixtureRoot();
    const sourceRoot = join(root, 'source');
    const destinationRoot = join(root, 'destination');
    await mkdir(sourceRoot);
    await mkdir(destinationRoot);
    await writeFile(join(sourceRoot, 'entry.js'), 'reviewed source');
    const native = makeNative();
    const reviewed = await native.readDependencyFile(sourceRoot, 'entry.js');
    await writeFile(join(sourceRoot, 'entry.js'), 'changed after review');

    await expect(
      native.cloneDependencyFile(
        sourceRoot,
        'entry.js',
        destinationRoot,
        'entry.js',
        reviewed.fingerprint
      )
    ).rejects.toMatchObject({ code: 'SOURCE_CHANGED' });
    await expect(
      lstat(join(destinationRoot, 'entry.js'))
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });
});

describe('native helper boundaries', () => {
  test('helper source pins restart-safe lease and exact capability protocol', async () => {
    const nativeSource = await Bun.file(
      new URL('./dependency-file-native.js', import.meta.url)
    ).text();
    const helperSource = await Bun.file(
      new URL('./engines/dependency-files/src/main.rs', import.meta.url)
    ).text();

    expect(nativeSource).toContain('withDependencyFileLease');
    expect(nativeSource).toContain('context !== worker.leaseContext');
    expect(nativeSource).toContain('context.poisoned');
    expect(nativeSource).toContain("'forced-clone'");
    expect(helperSource).toContain(
      'use std::io::{self, BufRead, Read, Write};'
    );
    expect(helperSource).toContain(
      'flock(file.as_raw_fd(), LOCK_EX | LOCK_NB)'
    );
    expect(helperSource).toContain('lease-acquire');
    expect(helperSource).toContain('lease-release');
    expect(helperSource).toContain('LEASE_STDIO_REQUIRED');
    expect(helperSource).toContain('LEASE_ROOT_REPLACED');
    expect(helperSource).toContain('validate_leases()?');
    expect(helperSource).toContain('O_NOFOLLOW');
  });

  test('status invokes only the installed helper version command and never starts a build', async () => {
    const commands = [];
    const native = createDependencyFileNative({
      nativeBinary: '/test/setu-dependency-files',
      processRunner: nativeRunner({ commandLog: commands }),
    });

    expect(await native.dependencyFileNativeStatus()).toEqual({
      available: true,
    });
    expect(commands.map(({ args }) => args[0])).toEqual(['version']);
  });

  test('protocol 1 helpers cannot report lease-capable status', async () => {
    const native = createDependencyFileNative({
      nativeBinary: '/test/setu-dependency-files',
      processRunner: async () =>
        helperOutput({ ok: true, protocol: 1, version: '1' }),
    });

    expect(await native.dependencyFileNativeStatus()).toEqual({
      available: false,
      code: 'NATIVE_VERSION_UNSUPPORTED',
      reason: 'Installed helper version is unsupported',
    });
  });

  test('injected processRunner lease seam serializes nesting without proving kernel locking', async () => {
    const storeRoot = await fixtureRoot();
    const checkoutRoot = await fixtureRoot();
    const otherCheckoutRoot = await fixtureRoot();
    const commands = [];
    const native = createDependencyFileNative({
      nativeBinary: '/test/setu-dependency-files',
      processRunner: nativeRunner({ commandLog: commands }),
    });

    await native.withDependencyFileLease(storeRoot, checkoutRoot, async () => {
      const nested = await native.withDependencyFileLease(
        storeRoot,
        checkoutRoot,
        () => Promise.resolve('nested')
      );
      expect(nested).toBe('nested');
      await expect(
        native.withDependencyFileLease(storeRoot, otherCheckoutRoot, () =>
          Promise.resolve()
        )
      ).rejects.toMatchObject({ code: 'LEASE_NESTED_CROSS_KEY' });
    });

    expect(commands.map(({ args }) => args[0])).toEqual([
      'version',
      'lease-acquire',
      'lease-release',
    ]);
    expect(commands[1].args[2]).toMatch(SHA256_PATTERN);
  });

  test('production worker reserves ownership before acquire and allows held status reads', async () => {
    const storeRoot = await fixtureRoot();
    const checkoutRoot = await fixtureRoot();
    const alternateStoreRoot = await fixtureRoot();
    const otherCheckoutRoot = await fixtureRoot();
    await writeFile(join(checkoutRoot, 'installed.js'), 'installed');
    await writeFile(join(checkoutRoot, 'stage.js'), 'staged');
    const commands = [];
    let versionReads = 0;
    const spawnProcess = leaseWorkerSpawn(
      ([command, ...args]) => {
        if (command === 'lease-acquire') {
          return {
            key: args[1],
            lease: 'acquired',
            ok: true,
            protocol: 2,
          };
        }
        if (command === 'swap') {
          return { exchanged: true, ok: true, protocol: 1 };
        }
        if (command === 'lease-release') {
          return {
            key: args[0],
            lease: 'released',
            ok: true,
            protocol: 2,
          };
        }
        return null;
      },
      { commands }
    );
    const native = createDependencyFileNative({
      nativeBinary: '/fixture/setu-dependency-files',
      platformForTesting: 'darwin',
      spawnProcess,
      versionRunner: () => {
        versionReads += 1;
        return helperOutput({
          capabilities: ['stdio', 'xattrs', 'swap', 'forced-clone', 'lease'],
          ok: true,
          protocol: 2,
          version: '2',
        });
      },
    });

    await native.withDependencyFileLease(storeRoot, checkoutRoot, async () => {
      const nested = await native.withDependencyFileLease(
        storeRoot,
        checkoutRoot,
        () => Promise.resolve('nested')
      );
      expect(nested).toBe('nested');
      await expect(
        native.withDependencyFileLease(alternateStoreRoot, checkoutRoot, () =>
          Promise.resolve()
        )
      ).rejects.toMatchObject({ code: 'LEASE_NESTED_CROSS_KEY' });
      await expect(
        native.withDependencyFileLease(storeRoot, otherCheckoutRoot, () =>
          Promise.resolve()
        )
      ).rejects.toMatchObject({ code: 'LEASE_NESTED_CROSS_KEY' });
      expect(await native.dependencyFileNativeStatus()).toEqual({
        available: true,
      });
      await expect(
        native.exchangeDependencyFiles(
          checkoutRoot,
          'installed.js',
          'stage.js',
          {
            parentDevice: String(
              (await lstat(checkoutRoot, { bigint: true })).dev
            ),
            parentInode: String(
              (await lstat(checkoutRoot, { bigint: true })).ino
            ),
          }
        )
      ).resolves.toEqual({ exchanged: true });
    });

    const parent = await lstat(checkoutRoot, { bigint: true });
    await expect(
      native.exchangeDependencyFiles(checkoutRoot, 'installed.js', 'stage.js', {
        parentDevice: String(parent.dev),
        parentInode: String(parent.ino),
      })
    ).rejects.toMatchObject({ code: 'LEASE_REQUIRED' });
    expect(versionReads).toBe(2);
    expect(commands.map(([command]) => command)).toEqual([
      'lease-acquire',
      'swap',
      'lease-release',
    ]);
    await native.close();
  });

  test('production worker kills and reaps an uncertain acquire before a later lease', async () => {
    const storeRoot = await fixtureRoot();
    const checkoutRoot = await fixtureRoot();
    const commands = [];
    let acquisitionCount = 0;
    const spawnProcess = leaseWorkerSpawn(
      ([command, ...args]) => {
        if (command === 'lease-acquire') {
          acquisitionCount += 1;
          if (acquisitionCount === 1) {
            // Model the helper taking its kernel lock but returning an invalid reply.
            return { key: 'wrong', lease: 'acquired', ok: true, protocol: 2 };
          }
          return {
            key: args[1],
            lease: 'acquired',
            ok: true,
            protocol: 2,
          };
        }
        if (command === 'lease-release') {
          return {
            key: args[0],
            lease: 'released',
            ok: true,
            protocol: 2,
          };
        }
        return null;
      },
      { commands }
    );
    const native = createDependencyFileNative({
      nativeBinary: '/fixture/setu-dependency-files',
      platformForTesting: 'darwin',
      spawnProcess,
      versionRunner: () =>
        helperOutput({
          capabilities: ['stdio', 'xattrs', 'swap', 'forced-clone', 'lease'],
          ok: true,
          protocol: 2,
          version: '2',
        }),
    });

    await expect(
      native.withDependencyFileLease(storeRoot, checkoutRoot, () =>
        Promise.resolve('must not run')
      )
    ).rejects.toMatchObject({ code: 'NATIVE_HELPER_INVALID_RESPONSE' });
    await expect(
      native.withDependencyFileLease(storeRoot, checkoutRoot, () =>
        Promise.resolve('recovered')
      )
    ).resolves.toBe('recovered');

    expect(spawnProcess.launchCount()).toBe(2);
    expect(spawnProcess.children[0].signalCode).toBe('SIGKILL');
    expect(spawnProcess.children[0].didExit).toBe(true);
    expect(commands.map(([command]) => command)).toEqual([
      'lease-acquire',
      'lease-acquire',
      'lease-release',
    ]);
    await native.close();
  });

  test('production worker timeout poisons the context and reaps before retry', async () => {
    const storeRoot = await fixtureRoot();
    const checkoutRoot = await fixtureRoot();
    let acquisitionCount = 0;
    const spawnProcess = leaseWorkerSpawn(([command, ...args]) => {
      if (command === 'lease-acquire') {
        acquisitionCount += 1;
        if (acquisitionCount === 1) {
          return null;
        }
        return {
          key: args[1],
          lease: 'acquired',
          ok: true,
          protocol: 2,
        };
      }
      if (command === 'lease-release') {
        return {
          key: args[0],
          lease: 'released',
          ok: true,
          protocol: 2,
        };
      }
      return null;
    });
    const native = createDependencyFileNative({
      nativeBinary: '/fixture/setu-dependency-files',
      platformForTesting: 'darwin',
      spawnProcess,
      versionRunner: () =>
        helperOutput({
          capabilities: ['stdio', 'xattrs', 'swap', 'forced-clone', 'lease'],
          ok: true,
          protocol: 2,
          version: '2',
        }),
      workerTimeoutMs: 10,
    });

    await expect(
      native.withDependencyFileLease(storeRoot, checkoutRoot, () =>
        Promise.resolve('must not run')
      )
    ).rejects.toMatchObject({ code: 'ETIMEDOUT' });
    await expect(
      native.withDependencyFileLease(storeRoot, checkoutRoot, () =>
        Promise.resolve('recovered')
      )
    ).resolves.toBe('recovered');
    expect(spawnProcess.launchCount()).toBe(2);
    expect(spawnProcess.children[0].signalCode).toBe('SIGKILL');
    expect(spawnProcess.children[0].didExit).toBe(true);
    await native.close();
  });

  test('production worker death during acquire is joined before the next worker starts', async () => {
    const storeRoot = await fixtureRoot();
    const checkoutRoot = await fixtureRoot();
    let acquisitionCount = 0;
    const spawnProcess = leaseWorkerSpawn(([command, ...args], child) => {
      if (command === 'lease-acquire') {
        acquisitionCount += 1;
        if (acquisitionCount === 1) {
          queueMicrotask(() => {
            child.exitCode = 23;
            child.didExit = true;
            child.emit('exit', 23, null);
          });
          return null;
        }
        return {
          key: args[1],
          lease: 'acquired',
          ok: true,
          protocol: 2,
        };
      }
      if (command === 'lease-release') {
        return {
          key: args[0],
          lease: 'released',
          ok: true,
          protocol: 2,
        };
      }
      return null;
    });
    const native = createDependencyFileNative({
      nativeBinary: '/fixture/setu-dependency-files',
      platformForTesting: 'darwin',
      spawnProcess,
      versionRunner: () =>
        helperOutput({
          capabilities: ['stdio', 'xattrs', 'swap', 'forced-clone', 'lease'],
          ok: true,
          protocol: 2,
          version: '2',
        }),
    });

    await expect(
      native.withDependencyFileLease(storeRoot, checkoutRoot, () =>
        Promise.resolve('must not run')
      )
    ).rejects.toMatchObject({ code: 'NATIVE_HELPER_FAILED' });
    await expect(
      native.withDependencyFileLease(storeRoot, checkoutRoot, () =>
        Promise.resolve('recovered')
      )
    ).resolves.toBe('recovered');
    expect(spawnProcess.launchCount()).toBe(2);
    expect(spawnProcess.children[0].didExit).toBe(true);
    await native.close();
  });

  test('production reads reuse one serialized helper and digest descriptor attributes in JavaScript', async () => {
    const root = await fixtureRoot();
    await writeFile(join(root, 'one.js'), 'one');
    await writeFile(join(root, 'two.js'), 'two');
    const requests = [];
    let active = 0;
    let maxActive = 0;
    const spawnProcess = fakeWorkerSpawn(
      async ([command, requestRoot, relativePath]) => {
        active += 1;
        maxActive = Math.max(active, maxActive);
        await new Promise((resolve) => setTimeout(resolve, 5));
        const result =
          command === 'probe'
            ? await probeResponse(requestRoot, relativePath)
            : null;
        active -= 1;
        return result;
      },
      { requests }
    );
    const native = createDependencyFileNative({
      nativeBinary: '/fixture/setu-dependency-files',
      spawnProcess,
    });

    const [first, second] = await Promise.all([
      native.readDependencyFile(root, 'one.js'),
      native.readDependencyFile(root, 'two.js'),
    ]);

    expect(first.eligible).toBe(true);
    expect(second.eligible).toBe(true);
    expect(first.fingerprint.attributes[0].digest).toBe(
      createHash('sha256')
        .update(Buffer.from([0, 1, 255]))
        .digest('hex')
    );
    expect(spawnProcess.launchCount()).toBe(1);
    expect(requests).toHaveLength(4);
    expect(maxActive).toBe(1);
    await native.close();
  });

  test('production worker mutations refuse calls outside their active lease', async () => {
    const root = await fixtureRoot();
    await writeFile(join(root, 'entry.js'), 'timestamp fixture');
    const requests = [];
    const spawnProcess = fakeWorkerSpawn(
      async ([command, requestRoot, relativePath, atimeNs, mtimeNs]) => {
        if (command === 'probe') {
          return probeResponse(requestRoot, relativePath);
        }
        if (command === 'restore-times') {
          await utimes(
            join(requestRoot, relativePath),
            new Date(Number(BigInt(atimeNs)) / 1e6),
            new Date(Number(BigInt(mtimeNs)) / 1e6)
          );
          return null;
        }
        return null;
      },
      { requests }
    );
    const native = createDependencyFileNative({
      nativeBinary: '/fixture/setu-dependency-files',
      spawnProcess,
    });
    const current = await native.readDependencyFile(root, 'entry.js');

    await expect(
      native.restoreDependencyTimes(root, 'entry.js', {
        atimeNs: current.fingerprint.atimeNs,
        mtimeNs: current.fingerprint.mtimeNs,
      })
    ).rejects.toMatchObject({ code: 'LEASE_REQUIRED' });
    expect(
      requests.filter((frame) =>
        frame.includes(Buffer.from('restore-times').toString('hex'))
      )
    ).toHaveLength(0);
    await native.close();
  });

  test('ignores delayed events from a timed-out worker and closes only its replacement', async () => {
    const root = await fixtureRoot();
    await writeFile(join(root, 'entry.js'), 'stream fixture');
    const writes = [];
    const children = [];
    const spawnProcess = () => {
      const child = new EventEmitter();
      child.exitCode = null;
      child.signalCode = null;
      child.stdout = new EventEmitter();
      child.stdout.setEncoding = () => undefined;
      child.kills = [];
      child.stdin = new EventEmitter();
      child.stdin.end = () => undefined;
      child.stdin.write = async (frame, _encoding, callback) => {
        const [count, ...encoded] = frame.trimEnd().split('\t');
        const fields = encoded.map((field) =>
          Buffer.from(field, 'hex').toString('utf8')
        );
        const [, requestRoot, relativePath] = fields;
        writes.push({ child, fields });
        callback?.();
        if (child !== children[0]) {
          const response = await probeResponse(requestRoot, relativePath);
          if (writes.filter((item) => item.child === child).length > 1) {
            child.stdout.emit('data', `${JSON.stringify(response)}\n`);
          }
        }
        expect(Number(count)).toBe(fields.length);
      };
      child.kill = (signal) => {
        child.kills.push(signal);
        child.signalCode = signal;
        queueMicrotask(() => child.emit('exit', null, signal));
        return true;
      };
      children.push(child);
      return child;
    };
    const native = createDependencyFileNative({
      nativeBinary: '/fixture/setu-dependency-files',
      spawnProcess,
      workerTimeoutMs: 15,
    });
    const waitUntil = (predicate) =>
      new Promise((resolve) => {
        const check = () => {
          if (predicate()) {
            resolve();
          } else {
            setTimeout(check, 1);
          }
        };
        check();
      });
    const waitForWrite = (child) =>
      waitUntil(() => writes.some((item) => item.child === child));

    const timedOut = native.readDependencyFile(root, 'entry.js');
    await waitUntil(() => children.length !== 0);
    const [workerA] = children;
    await waitForWrite(workerA);
    expect(await timedOut).toMatchObject({ eligible: false });
    expect(workerA.kills).toEqual(['SIGKILL']);

    const replacement = native.readDependencyFile(root, 'entry.js');
    await waitUntil(() => children.length >= 2);
    const [, workerB] = children;
    await waitForWrite(workerB);
    workerA.emit('exit', 1, null);
    workerA.stdout.emit('data', '{"ok":true,"protocol":1}\n');
    workerA.stdout.emit('error', new Error('late worker output failure'));
    workerA.emit('error', new Error('late worker failure'));
    workerB.stdout.emit(
      'data',
      `${JSON.stringify(await probeResponse(root, 'entry.js'))}\n`
    );

    expect(await replacement).toMatchObject({ eligible: true });
    expect(children).toHaveLength(2);
    await native.close();
    expect(workerA.kills).toEqual(['SIGKILL']);
    expect(workerB.kills).toEqual(['SIGKILL']);
  });

  test('preserves the post-effect timestamp-restore-unknown protocol code', async () => {
    const root = await fixtureRoot();
    const file = join(root, 'entry.js');
    await writeFile(file, 'timestamp protocol fixture');
    const commands = [];
    const baseRunner = nativeRunner({ commandLog: commands });
    const processRunner = async (command, args, options) => {
      if (args[0] !== 'restore-times') {
        return baseRunner(command, args, options);
      }
      commands.push({ args, command, options });
      await utimes(
        file,
        new Date(Number(BigInt(args[3])) / 1e6),
        new Date(Number(BigInt(args[4])) / 1e6)
      );
      throw Object.assign(new Error('post-effect metadata read failed'), {
        stdout: '{"ok":false,"protocol":1,"code":"TIMESTAMP_RESTORE_UNKNOWN"}',
      });
    };
    const native = createDependencyFileNative({
      nativeBinary: '/test/setu-dependency-files',
      processRunner,
    });
    const current = await native.readDependencyFile(root, 'entry.js');

    await expect(
      native.restoreDependencyTimes(root, 'entry.js', {
        atimeNs: current.fingerprint.atimeNs,
        mtimeNs: current.fingerprint.mtimeNs,
      })
    ).rejects.toMatchObject({ code: 'TIMESTAMP_RESTORE_UNKNOWN' });
    expect(
      commands.filter(({ args }) => args[0] === 'restore-times')
    ).toHaveLength(1);
  });

  test('status remains one-shot and does not launch the persistent worker', async () => {
    const commands = [];
    const native = createDependencyFileNative({
      nativeBinary: '/fixture/setu-dependency-files',
      processRunner: (_binary, args) => {
        commands.push(args[0]);
        return helperOutput({
          capabilities: ['stdio', 'xattrs', 'swap', 'forced-clone', 'lease'],
          ok: true,
          protocol: 2,
          version: '2',
        });
      },
      spawnProcess: () => {
        throw new Error('status must not start a worker');
      },
    });

    expect(await native.dependencyFileNativeStatus()).toEqual({
      available: true,
    });
    expect(commands).toEqual(['version']);
    await native.close();
  });

  test('missing helper is visible as unavailable and does not trigger a build', async () => {
    const commands = [];
    const native = createDependencyFileNative({
      nativeBinary: '/test/setu-dependency-files',
      processRunner: (_command, args) => {
        commands.push(args[0]);
        throw Object.assign(new Error('fixture missing helper'), {
          code: 'ENOENT',
        });
      },
    });

    expect(await native.dependencyFileNativeStatus()).toEqual({
      available: false,
      code: 'NATIVE_HELPER_MISSING',
      reason: 'Native helper has not been built or installed',
    });
    expect(commands).toEqual(['version']);
  });

  test('surfaces a lost helper response after timestamp mutation as unknown', async () => {
    const root = await fixtureRoot();
    await writeFile(join(root, 'entry.js'), 'timestamp fixture');
    const delegate = nativeRunner();
    const native = createDependencyFileNative({
      nativeBinary: '/test/setu-dependency-files',
      processRunner: (command, args, options) => {
        if (
          command === '/test/setu-dependency-files' &&
          args[0] === 'restore-times'
        ) {
          throw Object.assign(new Error('helper response lost'), {
            code: 'ETIMEDOUT',
          });
        }
        return delegate(command, args, options);
      },
    });
    const current = await native.readDependencyFile(root, 'entry.js');

    await expect(
      native.restoreDependencyTimes(root, 'entry.js', {
        atimeNs: current.fingerprint.atimeNs,
        mtimeNs: current.fingerprint.mtimeNs,
      })
    ).rejects.toMatchObject({ code: 'TIMESTAMP_RESTORE_UNKNOWN' });
  });

  test('classifies structured post-effect helper errors as unknown even on nonzero exit', async () => {
    await Promise.all(
      ['TIMESTAMP_SYNC_UNKNOWN', 'TIMESTAMP_RESTORE_UNKNOWN'].map(
        async (code) => {
          const root = await fixtureRoot();
          const path = join(root, 'entry.js');
          await writeFile(path, 'timestamp fixture');
          const delegate = nativeRunner();
          const native = createDependencyFileNative({
            nativeBinary: '/test/setu-dependency-files',
            processRunner: async (command, args, options) => {
              if (
                command === '/test/setu-dependency-files' &&
                args[0] === 'restore-times'
              ) {
                const atime = new Date(Number(BigInt(args[3])) / 1_000_000);
                const mtime = new Date(Number(BigInt(args[4])) / 1_000_000);
                await utimes(path, atime, mtime);
                throw Object.assign(
                  new Error('helper exited after changing timestamps'),
                  {
                    code: 1,
                    stderr: '',
                    stdout: `${JSON.stringify({ code, ok: false, protocol: 1 })}\n`,
                  }
                );
              }
              return delegate(command, args, options);
            },
          });
          const current = await native.readDependencyFile(root, 'entry.js');

          await expect(
            native.restoreDependencyTimes(root, 'entry.js', {
              atimeNs: current.fingerprint.atimeNs,
              mtimeNs: current.fingerprint.mtimeNs,
            })
          ).rejects.toMatchObject({ code: 'TIMESTAMP_RESTORE_UNKNOWN' });
        }
      )
    );

    await Promise.all(
      ['EXCHANGE_SYNC_UNKNOWN', 'EXCHANGE_PATH_CHANGED'].map(async (code) => {
        const root = await fixtureRoot();
        const target = join(root, 'installed.js');
        const temporary = join(root, 'stage.js');
        const displaced = join(root, 'displaced.js');
        await writeFile(target, 'installed');
        await writeFile(temporary, 'staged');
        const parent = await lstat(root, { bigint: true });
        const native = createDependencyFileNative({
          nativeBinary: '/test/setu-dependency-files',
          processRunner: async (_command, args) => {
            expect(args[0]).toBe('swap');
            await rename(target, displaced);
            await rename(temporary, target);
            await rename(displaced, temporary);
            throw Object.assign(
              new Error('helper exited after exchanging entries'),
              {
                code: 1,
                stderr: '',
                stdout: `${JSON.stringify({ code, ok: false, protocol: 1 })}\n`,
              }
            );
          },
        });

        await expect(
          native.exchangeDependencyFiles(root, 'installed.js', 'stage.js', {
            parentDevice: String(parent.dev),
            parentInode: String(parent.ino),
          })
        ).rejects.toMatchObject({ code: 'EXCHANGE_UNKNOWN' });
        expect(await Bun.file(target).text()).toBe('staged');
        expect(await Bun.file(temporary).text()).toBe('installed');
      })
    );
  });

  test('exchange validates sibling paths and sends parent identity to the native atomic swap', async () => {
    const root = await fixtureRoot();
    const parent = join(root, 'node_modules', 'pkg');
    await mkdir(parent, { recursive: true });
    await writeFile(join(parent, 'entry.js'), 'installed');
    await writeFile(join(parent, '.entry.js.setu-stage'), 'staged');
    const parentInfo = await lstat(parent, { bigint: true });
    const commands = [];
    const native = createDependencyFileNative({
      nativeBinary: '/test/setu-dependency-files',
      processRunner: nativeRunner({ commandLog: commands }),
    });

    const result = await native.exchangeDependencyFiles(
      root,
      'node_modules/pkg/entry.js',
      'node_modules/pkg/.entry.js.setu-stage',
      {
        nativeBinary: '/test/setu-dependency-files',
        parentDevice: String(parentInfo.dev),
        parentInode: String(parentInfo.ino),
      }
    );

    expect(result).toEqual({ exchanged: true });
    expect(commands.at(-1).args).toEqual([
      'swap',
      root,
      'node_modules/pkg/entry.js',
      'node_modules/pkg/.entry.js.setu-stage',
      String(parentInfo.dev),
      String(parentInfo.ino),
    ]);
  });

  test('surfaces a lost helper response after swap as an unknown exchange', async () => {
    const root = await fixtureRoot();
    await writeFile(join(root, 'installed.js'), 'installed');
    await writeFile(join(root, 'stage.js'), 'staged');
    const delegate = nativeRunner();
    const native = createDependencyFileNative({
      nativeBinary: '/test/setu-dependency-files',
      processRunner: (command, args, options) => {
        if (command === '/test/setu-dependency-files' && args[0] === 'swap') {
          throw Object.assign(new Error('helper response lost'), {
            code: 'ETIMEDOUT',
          });
        }
        return delegate(command, args, options);
      },
    });
    const parent = await lstat(root, { bigint: true });

    await expect(
      native.exchangeDependencyFiles(root, 'installed.js', 'stage.js', {
        parentDevice: String(parent.dev),
        parentInode: String(parent.ino),
      })
    ).rejects.toMatchObject({ code: 'EXCHANGE_UNKNOWN' });
  });

  test('backup removal validates the reviewed identity and removes only the regular leaf', async () => {
    const root = await fixtureRoot();
    await writeFile(join(root, 'backup.js'), 'reviewed backup');
    const native = makeNative();
    const backup = await native.readDependencyFile(root, 'backup.js');

    const result = await native.removeDependencyBackup(
      root,
      'backup.js',
      backup.fingerprint
    );

    expect(result).toEqual({ removed: true });
    await expect(lstat(join(root, 'backup.js'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });
});

// Opt-in hardware acceptance. A missing helper must fail when explicitly selected.
const nativeAcceptance =
  process.env.SETU_DEPENDENCY_FILE_NATIVE_ACCEPTANCE === '1' ? test : test.skip;

nativeAcceptance(
  'real native helpers exclude a competing process and reacquire after release',
  async () => {
    const root = await fixtureRoot();
    const store = join(root, 'store');
    await mkdir(store, { mode: 0o700 });
    await writeFile(join(root, 'entry.js'), 'fixture', { mode: 0o600 });
    const first = createDependencyFileNative();
    const second = createDependencyFileNative();
    let competingWork = false;
    try {
      await first.withDependencyFileLease(store, root, async () => {
        await expect(
          second.withDependencyFileLease(store, root, () => {
            competingWork = true;
          })
        ).rejects.toMatchObject({ code: 'LEASE_BUSY' });
        expect(competingWork).toBe(false);
        expect(
          (await first.readDependencyFile(root, 'entry.js')).eligible
        ).toBe(true);
      });
      await second.withDependencyFileLease(store, root, async () => {
        expect(
          (await second.readDependencyFile(root, 'entry.js')).eligible
        ).toBe(true);
      });
    } finally {
      await Promise.all([first.close(), second.close()]);
    }
  },
  30_000
);

nativeAcceptance(
  'killing the real leased helper poisons that context and frees its kernel lease',
  async () => {
    const root = await fixtureRoot();
    const store = join(root, 'store');
    await mkdir(store, { mode: 0o700 });
    await writeFile(join(root, 'entry.js'), 'fixture', { mode: 0o600 });
    let helper;
    let helperClosed;
    const first = createDependencyFileNative({
      spawnProcess: (...args) => {
        helper = spawn(...args);
        helperClosed = new Promise((resolve) => helper.once('close', resolve));
        return helper;
      },
    });
    const second = createDependencyFileNative();
    try {
      await expect(
        first.withDependencyFileLease(store, root, async () => {
          expect(Number.isSafeInteger(helper?.pid)).toBe(true);
          expect(helper.kill('SIGKILL')).toBe(true);
          await helperClosed;
          // The production worker must refuse reuse rather than silently respawn inside this lease.
          await first.restoreDependencyTimes(root, 'entry.js', {
            atimeNs: '0',
            mtimeNs: '0',
          });
        })
      ).rejects.toMatchObject({ code: 'LEASE_POISONED' });
      await second.withDependencyFileLease(store, root, async () => {
        expect(
          (await second.readDependencyFile(root, 'entry.js')).eligible
        ).toBe(true);
      });
    } finally {
      await Promise.all([first.close(), second.close()]);
    }
  },
  30_000
);
