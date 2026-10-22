import { expect, test } from 'bun:test';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCli } from './cli.js';
import {
  createPortalResourceServices,
  dispatchPortalResourceRoute,
} from './portal-resource-services.js';
import { createWorkspaceState } from './workspace-state.js';

const bun = process.execPath;
const CONFIG_REASON = /config|setting/;

function fixture() {
  const workspace = realpathSync(
    mkdtempSync(join(tmpdir(), 'setu-sharing-diagnostics-'))
  );
  const checkout = join(workspace, 'project', 'topic');
  let storeRoot = join(
    tmpdir(),
    `setu-sharing-store-${process.pid}-${Date.now()}`
  );
  mkdirSync(join(workspace, 'project'), { recursive: true });
  mkdirSync(checkout, { recursive: true });
  mkdirSync(storeRoot, { mode: 0o700 });
  chmodSync(storeRoot, 0o700);
  storeRoot = realpathSync(storeRoot);

  const files = [
    [join(workspace, 'bun.lock'), 'workspace lock\n'],
    [
      join(workspace, 'node_modules', 'workspace-package', 'index.js'),
      'workspace package\n',
    ],
    [join(checkout, 'bun.lock'), 'checkout lock\n'],
    [
      join(checkout, 'node_modules', 'checkout-package', 'index.js'),
      'checkout package\n',
    ],
    [join(checkout, 'bunfig.toml'), '[install]\nlinker = "hoisted"\n'],
  ];
  for (const [path, content] of files) {
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, content);
  }

  const identity = { device: statSync(storeRoot).dev, mountPath: storeRoot };
  let currentConfig;
  const target = {
    checkoutIdentity: { checkoutPath: checkout, known: true },
    key: 'project/topic',
    name: 'topic',
    port: 3101,
    repo: 'project',
    wtDir: checkout,
  };
  const state = createWorkspaceState({
    configPath: join(workspace, 'setu.json'),
    setuDir: workspace,
    workspaceRoot: workspace,
  });
  const services = createPortalResourceServices({
    branch: async (value) => value.name,
    callTool: async () => ({ ok: true }),
    claims: () => [],
    command: (args) => {
      throw new Error(`unexpected command: ${args.join(' ')}`);
    },
    config: async () => currentConfig,
    entries: async () => [target],
    gitHead: async () => ({ state: 'unknown' }),
    githubTarget: () => null,
    hostHealth: async () => ({ ok: true }),
    lifecycle: { snapshot: () => null, snapshots: () => [] },
    mcpTools: () => [],
    operationId: () => 'diagnostic-test-operation',
    randomId: () => 'diagnostic-test-random',
    resolveTarget: async () => target,
    state,
    trackedPaths: async () => ({ state: 'clean' }),
  });
  return {
    checkout,
    files,
    identity,
    services,
    setConfig: (value) => {
      currentConfig = value;
    },
    state,
    storeRoot,
    target,
    workspace,
  };
}

function fileSnapshot(paths) {
  return paths.map(([path]) => [path, readFileSync(path, 'utf8')]);
}

function enabledConfig(fx) {
  return {
    dependencySharing: {
      enabled: true,
      executable: bun,
      storeIdentity: fx.identity,
      storeRoot: fx.storeRoot,
      targets: { 'project/topic': true },
      version: '1.3.14',
      workspaceRoot: fx.workspace,
    },
    workspace: fx.workspace,
  };
}

test('disabled and incompatible dependency diagnostics explain blockers without changing ordinary views', async () => {
  const fx = fixture();
  try {
    const before = fileSnapshot(fx.files);
    await fx.state.replace('dependencyViews', {});

    fx.setConfig({ workspace: fx.workspace });
    const disabled = await fx.services.dependencyViews({
      name: 'topic',
      repo: 'project',
    });
    expect(disabled).toMatchObject({ ok: true });
    expect(disabled.views).toHaveLength(1);
    expect(disabled.views[0]).toMatchObject({
      enabled: false,
      state: 'disabled',
    });
    expect(disabled.views[0].reason).toEqual(expect.any(String));
    expect(disabled.views[0].reason.trim().length).toBeGreaterThan(0);
    expect(disabled.views[0].reason.toLowerCase()).toMatch(CONFIG_REASON);
    expect(disabled.views[0].state).not.toBe('shared and healthy');

    fx.setConfig(enabledConfig(fx));
    const hoisted = await fx.services.dependencyViews({
      name: 'topic',
      repo: 'project',
    });
    expect(hoisted).toMatchObject({ ok: true });
    expect(hoisted.views[0].state).not.toBe('shared and healthy');
    expect(hoisted.views[0].reason).toEqual(expect.any(String));
    expect(hoisted.views[0].reason.toLowerCase()).toContain('hoisted');

    const verified = await fx.services.dependencyVerify({
      name: 'topic',
      repo: 'project',
    });
    expect(verified).toMatchObject({ ok: true, view: { enabled: true } });
    expect(verified.view.state).not.toBe('shared and healthy');

    const repair = await fx.services.dependencyRepair({
      name: 'topic',
      repo: 'project',
    });
    expect(repair.executed).toBe(false);
    expect(repair.ok).toBe(false);
    expect(fileSnapshot(fx.files)).toEqual(before);

    fx.setConfig({ dependencySharing: [], workspace: fx.workspace });
    const malformedConfig = await fx.services.dependencyVerify({
      name: 'topic',
      repo: 'project',
    });
    expect(malformedConfig.ok).toBe(false);
    expect(malformedConfig.view?.state).not.toBe('shared and healthy');
    expect(fileSnapshot(fx.files)).toEqual(before);
  } finally {
    rmSync(fx.workspace, { force: true, recursive: true });
    rmSync(fx.storeRoot, { force: true, recursive: true });
  }
});

test('CLI dependency status preserves the real service explanation without network access', async () => {
  const fx = fixture();
  const output = [];
  const originalLog = console.log;
  const originalExitCode = process.exitCode;
  console.log = (value) => output.push(String(value));
  try {
    fx.setConfig({ workspace: fx.workspace });
    const code = await runCli(
      ['dependencies', 'status', 'project', 'topic', '--json'],
      {
        request: async (call) => {
          expect(call.method).toBe('GET');
          expect(call.path).toBe(
            '/api/dependency-sharing?name=topic&repo=project'
          );
          const response = await dispatchPortalResourceRoute(
            fx.services,
            new Request(`http://portal.test${call.path}`)
          );
          return response.json();
        },
      }
    );
    expect(code).toBe(0);
    const result = JSON.parse(output[0]);
    expect(result.views[0].reason).toContain('linker = "hoisted"');
    expect(result.views[0]).toMatchObject({
      enabled: false,
      state: 'disabled',
    });
  } finally {
    console.log = originalLog;
    process.exitCode = originalExitCode;
    rmSync(fx.workspace, { force: true, recursive: true });
    rmSync(fx.storeRoot, { force: true, recursive: true });
  }
});
