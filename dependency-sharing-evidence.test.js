/** biome-ignore-all lint/performance/noAwaitInLoops: Each case mutates its fixture before inspecting the next state. */
import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  inspectDependencyView,
  recordDependencyConsumer,
  repairDependencyView,
  sharedDependencyInstall,
} from './dependency-sharing.js';
import { createWorkspaceState } from './workspace-state.js';

const NAMESPACE = 'darwin-arm64-bun-1.3.14';

function fixture() {
  const dir = realpathSync(
    mkdtempSync(join(tmpdir(), '.setu-store-evidence-'))
  );
  const workspace = join(dir, 'workspace');
  const checkout = join(workspace, 'checkout');
  const storeRoot = join(dir, 'protected-store');
  mkdirSync(workspace);
  mkdirSync(checkout);
  mkdirSync(storeRoot, { mode: 0o700 });
  writeFileSync(join(checkout, 'bun.lock'), '{}');
  writeFileSync(
    join(checkout, 'bunfig.toml'),
    '[install]\nlinker = "isolated"\n'
  );
  const executable = join(dir, 'fixture-bun');
  writeFileSync(
    executable,
    '#!/bin/sh\nprintf \'["1.3.14","darwin","arm64"]\\n\'\n',
    { mode: 0o700 }
  );
  const consumer = {
    bunVersion: '1.3.14',
    checkout: realpathSync(checkout),
    linkerMode: 'isolated',
    lockfileHash: createHash('sha256')
      .update(readFileSync(join(checkout, 'bun.lock')))
      .digest('hex'),
    platformNamespace: NAMESPACE,
  };
  const sharing = {
    consumers: { [consumer.checkout]: consumer },
    enabled: true,
    executable,
    storeIdentity: { device: lstatSync(storeRoot).dev, mountPath: dir },
    storeRoot,
    version: '1.3.14',
    workspaceRoot: workspace,
  };
  function makeView(
    target = join(storeRoot, NAMESPACE, 'links', 'package@1.0.0')
  ) {
    mkdirSync(target, { recursive: true });
    const virtualStore = join(checkout, 'node_modules', '.bun');
    mkdirSync(join(virtualStore, 'node_modules'), { recursive: true });
    symlinkSync(target, join(virtualStore, 'package@1.0.0'));
    return virtualStore;
  }
  return {
    checkout,
    consumer,
    dir,
    dispose: () => rmSync(dir, { force: true, recursive: true }),
    makeView,
    sharing,
    storeRoot,
    workspace,
  };
}

test('view inspection refuses indirect virtual-store roots and stores that lost private ownership', async () => {
  const f = fixture();
  try {
    const virtualStore = f.makeView();
    expect(await inspectDependencyView(f.checkout, f.sharing)).toMatchObject({
      mode: 'isolated',
      ok: true,
      state: 'shared and healthy',
    });

    const movedVirtualStore = join(f.dir, 'moved-virtual-store');
    rmSync(virtualStore, { recursive: true });
    symlinkSync(movedVirtualStore, virtualStore);
    mkdirSync(join(movedVirtualStore, 'node_modules'), { recursive: true });
    symlinkSync(
      join(f.storeRoot, NAMESPACE, 'links', 'package@1.0.0'),
      join(movedVirtualStore, 'package@1.0.0')
    );
    expect(await inspectDependencyView(f.checkout, f.sharing)).toMatchObject({
      ok: true,
      state: 'unknown',
    });

    rmSync(virtualStore);
    f.makeView();
    chmodSync(f.storeRoot, 0o755);
    expect(await inspectDependencyView(f.checkout, f.sharing)).toMatchObject({
      ok: true,
      state: 'unknown',
    });
    chmodSync(f.storeRoot, 0o700);

    const outsideCheckout = join(f.dir, 'sibling-checkout');
    mkdirSync(outsideCheckout);
    writeFileSync(join(outsideCheckout, 'bun.lock'), '{}');
    writeFileSync(
      join(outsideCheckout, 'bunfig.toml'),
      '[install]\nlinker = "isolated"\n'
    );
    expect(
      await inspectDependencyView(outsideCheckout, {
        ...f.sharing,
        consumers: {
          [realpathSync(outsideCheckout)]: {
            ...f.consumer,
            checkout: realpathSync(outsideCheckout),
          },
        },
      })
    ).toMatchObject({ ok: true, state: 'unknown' });
  } finally {
    f.dispose();
  }
});

test('only direct package links into the configured namespace can be healthy; local data is explicit', async () => {
  const f = fixture();
  try {
    const virtualStore = f.makeView();
    mkdirSync(join(virtualStore, 'workspace-package@workspace'), {
      recursive: true,
    });
    writeFileSync(join(virtualStore, 'local-metadata.txt'), 'local fixture');
    const mixed = await inspectDependencyView(f.checkout, f.sharing);
    expect(mixed).toMatchObject({
      mode: 'isolated',
      state: 'shared and healthy',
    });
    expect(mixed.reason).toContain('some dependency data remains local');
    expect(mixed.reason).toContain(
      'complete dependency closure are not verified'
    );

    rmSync(virtualStore, { recursive: true });
    f.makeView(join(f.storeRoot, 'nested', 'links', 'package@1.0.0'));
    const nestedStore = await inspectDependencyView(f.checkout, f.sharing);
    expect(nestedStore).toMatchObject({ ok: true, state: 'unknown' });

    rmSync(virtualStore, { recursive: true });
    const siblingStore = join(f.dir, 'sibling-store', 'package@1.0.0');
    mkdirSync(siblingStore, { recursive: true });
    f.makeView(siblingStore);
    expect(await inspectDependencyView(f.checkout, f.sharing)).toMatchObject({
      ok: true,
      state: 'unknown',
    });

    rmSync(virtualStore, { recursive: true });
    const workspaceStore = join(f.workspace, 'nested-store');
    mkdirSync(workspaceStore, { mode: 0o700 });
    f.makeView(join(workspaceStore, NAMESPACE, 'links', 'package@1.0.0'));
    expect(
      await inspectDependencyView(f.checkout, {
        ...f.sharing,
        storeRoot: workspaceStore,
      })
    ).toMatchObject({ ok: true, state: 'unknown' });

    rmSync(virtualStore, { recursive: true });
    mkdirSync(join(f.checkout, 'node_modules', '.bun', 'node_modules'), {
      recursive: true,
    });
    symlinkSync(
      join(f.storeRoot, NAMESPACE, 'links', 'absent-package'),
      join(f.checkout, 'node_modules', '.bun', 'broken-package')
    );
    expect(await inspectDependencyView(f.checkout, f.sharing)).toMatchObject({
      ok: true,
      state: 'dangling',
    });
  } finally {
    f.dispose();
  }
});

test('unknown inputs never become absence or a repair plan, while an empty recorded view stays plan-only', async () => {
  const f = fixture();
  try {
    const virtualStore = f.makeView();
    expect((await inspectDependencyView(f.checkout, f.sharing)).state).toBe(
      'shared and healthy'
    );

    writeFileSync(join(f.checkout, 'bun.lock'), '{"changed":true}');
    expect(await inspectDependencyView(f.checkout, f.sharing)).toMatchObject({
      ok: true,
      state: 'unknown',
    });
    writeFileSync(join(f.checkout, 'bun.lock'), '{}');

    expect(
      await inspectDependencyView(f.checkout, {
        ...f.sharing,
        version: '1.3.4',
      })
    ).toMatchObject({ ok: true, state: 'unknown' });
    expect(
      await inspectDependencyView(f.checkout, {
        enabled: true,
        storeRoot: f.storeRoot,
      })
    ).toMatchObject({ ok: true, state: 'unknown' });
    expect(
      await inspectDependencyView(f.checkout, {
        ...f.sharing,
        consumers: {
          [f.consumer.checkout]: { ...f.consumer, linkerMode: 'hoisted' },
        },
      })
    ).toMatchObject({ ok: true, state: 'unknown' });
    expect(
      await inspectDependencyView(f.checkout, {
        ...f.sharing,
        storeRoot: join(f.dir, 'missing-store'),
      })
    ).toMatchObject({ ok: true, state: 'unknown' });

    rmSync(join(f.checkout, 'bun.lock'));
    mkdirSync(join(f.checkout, 'bun.lock'));
    expect(await inspectDependencyView(f.checkout, f.sharing)).toMatchObject({
      ok: true,
      state: 'unknown',
    });
    expect(await repairDependencyView(f.checkout, f.sharing)).toMatchObject({
      code: 'DEPENDENCY_VIEW_NOT_MANAGED',
      ok: false,
      state: 'unknown',
    });
    rmSync(join(f.checkout, 'bun.lock'), { recursive: true });
    writeFileSync(join(f.checkout, 'bun.lock'), '{}');

    rmSync(virtualStore, { recursive: true });
    mkdirSync(join(f.checkout, 'node_modules', '.bun'), { recursive: true });
    writeFileSync(join(f.checkout, 'node_modules', 'keep.txt'), 'preserve me');
    const before = readFileSync(
      join(f.checkout, 'node_modules', 'keep.txt'),
      'utf8'
    );
    const plan = await repairDependencyView(f.checkout, f.sharing);
    expect(plan).toMatchObject({ mode: 'isolated', ok: true });
    expect(plan.command[1]).toContain('--cache-dir');
    expect(
      readFileSync(join(f.checkout, 'node_modules', 'keep.txt'), 'utf8')
    ).toBe(before);
    expect(
      lstatSync(join(f.checkout, 'node_modules', '.bun')).isDirectory()
    ).toBe(true);
    expect(await inspectDependencyView(f.checkout, f.sharing)).toMatchObject({
      ok: true,
      state: 'shared but replaced by an ordinary install',
    });
  } finally {
    f.dispose();
  }
});

test('consumer recording rejects a changed lock and malformed install plan without writing evidence', async () => {
  const f = fixture();
  try {
    const state = createWorkspaceState({
      configPath: join(f.dir, 'setu.json'),
      setuDir: f.dir,
      workspaceRoot: f.workspace,
    });
    const plan = await sharedDependencyInstall(f.checkout, f.sharing);
    writeFileSync(join(f.checkout, 'bun.lock'), '{"changed":true}');
    await expect(
      recordDependencyConsumer(state, f.checkout, f.sharing, plan)
    ).rejects.toMatchObject({ code: 'DEPENDENCY_VIEW_LOCK_CHANGED' });
    expect(state.read('dependencyViews')).toEqual({});

    writeFileSync(join(f.checkout, 'bun.lock'), '{}');
    await expect(
      recordDependencyConsumer(state, f.checkout, f.sharing, {
        ...plan,
        namespace: 'sibling-store',
      })
    ).rejects.toMatchObject({ code: 'DEPENDENCY_VIEW_PLAN_INVALID' });
    await expect(
      recordDependencyConsumer(state, f.checkout, f.sharing, {
        ...plan,
        env: { ...plan.env, BUN_INSTALL_CACHE_DIR: join(f.dir, 'other-store') },
      })
    ).rejects.toMatchObject({ code: 'DEPENDENCY_VIEW_PLAN_INVALID' });
    expect(state.read('dependencyViews')).toEqual({});

    const currentPlan = await sharedDependencyInstall(f.checkout, f.sharing);
    const recorded = await recordDependencyConsumer(
      state,
      f.checkout,
      f.sharing,
      currentPlan
    );
    expect(Object.keys(recorded.consumer).sort()).toEqual([
      'bunVersion',
      'checkout',
      'linkerMode',
      'lockfileHash',
      'platformNamespace',
    ]);
    expect(recorded.consumer.lockfileHash).toBe(
      createHash('sha256').update('{}').digest('hex')
    );
  } finally {
    f.dispose();
  }
});
