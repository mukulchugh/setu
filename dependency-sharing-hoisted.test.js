import { expect, test } from 'bun:test';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  inspectDependencyView,
  repairDependencyView,
  sharedDependencyInstall,
} from './dependency-sharing.js';

function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'setu-hoisted-share-')));
  const workspace = join(root, 'workspace');
  const checkout = join(workspace, 'repo', 'topic');
  const storeRoot = join(root, 'store');
  mkdirSync(checkout, { recursive: true });
  mkdirSync(storeRoot, { mode: 0o700 });
  writeFileSync(join(checkout, 'package.json'), '{}\n');
  writeFileSync(join(checkout, 'bun.lock'), '{}\n');
  writeFileSync(
    join(checkout, 'bunfig.toml'),
    '[install]\nlinker = "hoisted"\n'
  );
  const executable = join(root, 'bun-fixture');
  writeFileSync(
    executable,
    '#!/bin/sh\nprintf \'["1.3.14","darwin","arm64"]\\n\'\n',
    { mode: 0o700 }
  );
  return {
    checkout,
    dispose: () => rmSync(root, { force: true, recursive: true }),
    sharing: {
      enabled: true,
      executable,
      storeIdentity: {
        device: statSync(storeRoot).dev,
        mountPath: realpathSync(root),
      },
      storeRoot,
      version: '1.3.14',
      workspaceRoot: workspace,
    },
    storeRoot,
  };
}

test('hoisted setup plan is pinned and frozen, retains the linker, and does not select an isolated global store', async () => {
  const f = fixture();
  try {
    const plan = await sharedDependencyInstall(f.checkout, f.sharing, () =>
      Promise.resolve()
    );
    expect(plan).toMatchObject({
      command: [
        f.sharing.executable,
        ['install', '--frozen-lockfile', '--linker', 'hoisted'],
      ],
      linker: 'hoisted',
      mode: 'hoisted-cow',
      namespace: 'hoisted/darwin-arm64-bun-1.3.14',
      strategy: 'hoisted-cow',
    });
    expect(plan.env.BUN_INSTALL_GLOBAL_STORE).toBeUndefined();
    expect(existsSync(join(f.storeRoot, 'darwin-arm64-bun-1.3.14'))).toBe(
      false
    );
    expect(existsSync(join(f.storeRoot, 'hoisted'))).toBe(false);
    expect((await inspectDependencyView(f.checkout, f.sharing)).state).toBe(
      'absent'
    );
  } finally {
    f.dispose();
  }
});

test('configured canonical data-volume anchor accepts same-device roots outside its textual path prefix', async () => {
  const f = fixture();
  try {
    const dataVolume = realpathSync('/System/Volumes/Data');
    const dataInfo = statSync(dataVolume);
    if (dataInfo.dev !== statSync(f.storeRoot).dev) {
      return;
    }
    f.sharing.storeIdentity = {
      device: dataInfo.dev,
      mountPath: dataVolume,
    };
    const plan = await sharedDependencyInstall(f.checkout, f.sharing, () =>
      Promise.resolve()
    );
    expect(plan.bunVersion).toBe('1.3.14');
    expect(realpathSync(f.storeRoot).startsWith(`${dataVolume}/`)).toBe(false);
  } finally {
    f.dispose();
  }
});

test('existing hoisted views remain ordinary and repair never adopts or replaces them', async () => {
  const f = fixture();
  try {
    const nodeModules = join(f.checkout, 'node_modules');
    mkdirSync(nodeModules);
    const marker = join(nodeModules, 'keep.txt');
    writeFileSync(marker, 'untouched existing install\n');
    const before = readFileSync(marker, 'utf8');

    expect(await inspectDependencyView(f.checkout, f.sharing)).toMatchObject({
      ok: true,
      reason: expect.stringContaining('remains ordinary'),
      state: 'ordinary',
    });
    expect(await repairDependencyView(f.checkout, f.sharing)).toMatchObject({
      code: 'DEPENDENCY_VIEW_NOT_MANAGED',
      ok: false,
      state: 'ordinary',
    });
    await expect(
      sharedDependencyInstall(f.checkout, f.sharing, () => Promise.resolve())
    ).rejects.toThrow('migration is not automatic');
    await expect(
      sharedDependencyInstall(f.checkout, f.sharing, () => Promise.resolve(), {
        refreshOwnedView: true,
      })
    ).rejects.toMatchObject({ code: 'DEPENDENCY_VIEW_UNSAFE' });
    expect(lstatSync(nodeModules).isDirectory()).toBe(true);
    expect(readFileSync(marker, 'utf8')).toBe(before);
  } finally {
    f.dispose();
  }
});

test('existing hoisted symlinks are refused without following or replacing the view', async () => {
  const f = fixture();
  try {
    const nodeModules = join(f.checkout, 'node_modules');
    symlinkSync(join(f.storeRoot, 'absent-target'), nodeModules);
    await expect(
      sharedDependencyInstall(f.checkout, f.sharing, () => Promise.resolve())
    ).rejects.toThrow('migration is not automatic');
    expect(lstatSync(nodeModules).isSymbolicLink()).toBe(true);
    expect(existsSync(join(f.storeRoot, 'hoisted'))).toBe(false);
  } finally {
    f.dispose();
  }
});
