import { expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  linkSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import {
  readdir as readdirAsync,
  readFile as readFileAsync,
  realpath as realpathAsync,
  stat as statAsync,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inspectCheckoutIdentity } from './checkout-identity.js';
import { createManagedAgentServices } from './managed-agent-services.js';
import { handleMcpRequest, initMcpServer } from './mcp-server.js';
import {
  createPortalResourceServices,
  dispatchPortalResourceRoute,
} from './portal-resource-services.js';
import { createResourceAdmission } from './resource-admission.js';
import { createWorkspaceState } from './workspace-state.js';

const commandResult = (stdout = '') => ({
  code: 0,
  stdout,
  timedOut: false,
  truncated: false,
});
const checkoutFs = {
  readFile: readFileAsync,
  realpath: realpathAsync,
  stat: statAsync,
};

function git(args, cwd) {
  return execFileSync('git', args, { cwd, stdio: 'ignore' });
}

async function json(services, path, init = {}) {
  const response = await dispatchPortalResourceRoute(
    services,
    new Request(`http://portal.test${path}`, init)
  );
  expect(response).not.toBeNull();
  return JSON.parse(await response.text());
}

async function mcpTool(name, arguments_) {
  const response = await handleMcpRequest(
    new Request('http://localhost:2999/mcp', {
      body: JSON.stringify({
        id: 1,
        jsonrpc: '2.0',
        method: 'tools/call',
        params: { arguments: arguments_, name },
      }),
      headers: {
        accept: 'application/json, text/event-stream',
        'content-type': 'application/json',
        host: 'localhost:2999',
      },
      method: 'POST',
    })
  );
  const text = await response.text();
  const raw = text.startsWith('event:')
    ? text
        .split('\n')
        .find((line) => line.startsWith('data: '))
        .slice(6)
    : text;
  return JSON.parse(raw);
}

async function fixture(serviceOverrides = {}) {
  const { resourceAdmissionFactory, ...serviceOptions } = serviceOverrides;
  const root = mkdtempSync(join(tmpdir(), 'setu-resource-services-'));
  const workspace = join(root, 'workspace');
  const bare = join(root, 'r.git');
  const seed = join(root, 'seed');
  const topic = join(workspace, 'r', 'topic');
  const other = join(workspace, 'r', 'other');
  const store = join(root, 'shared-store');
  git(['init', '--bare', bare]);
  git(['clone', bare, seed]);
  git(['config', 'user.email', 'test@example.invalid'], seed);
  git(['config', 'user.name', 'Test'], seed);
  writeFileSync(join(seed, 'README.md'), 'fixture\n');
  git(['add', 'README.md'], seed);
  git(['commit', '-m', 'fixture'], seed);
  git(['push', 'origin', 'HEAD:main'], seed);
  git(['symbolic-ref', 'HEAD', 'refs/heads/main'], bare);
  mkdirSync(join(workspace, 'r'), { recursive: true });
  git(['worktree', 'add', '-b', 'topic', topic, 'main'], bare);
  git(['worktree', 'add', '-b', 'other', other, 'main'], bare);
  mkdirSync(store, { mode: 0o700 });
  const canonicalStore = await realpathAsync(store);
  const storeStat = statSync(canonicalStore);
  let currentConfig = {
    dependencySharing: {
      enabled: true,
      executable: '/usr/bin/true',
      storeIdentity: { device: storeStat.dev, mountPath: canonicalStore },
      storeRoot: canonicalStore,
      targets: { 'r/topic': true },
      version: '1.3.14',
      workspaceRoot: workspace,
    },
    workspace,
  };
  const state = createWorkspaceState({
    configPath: join(root, 'config.json'),
    setuDir: root,
    workspaceRoot: workspace,
  });
  await state.replace('ports', [
    { key: 'r/topic', name: 'topic', port: 3101, repo: 'r' },
    { key: 'r/other', name: 'other', port: 3102, repo: 'r' },
  ]);
  const targets = new Map([
    [
      'r/topic',
      {
        key: 'r/topic',
        name: 'topic',
        port: 3101,
        repo: 'r',
        repoDir: bare,
        wtDir: topic,
      },
    ],
    [
      'r/other',
      {
        key: 'r/other',
        name: 'other',
        port: 3102,
        repo: 'r',
        repoDir: bare,
        wtDir: other,
      },
    ],
  ]);
  let registrations = ['r/topic'];
  const calls = [];
  const lifecycle = { snapshot: () => null, snapshots: () => [] };
  const resolveTarget = async (repo, name) => {
    const target = targets.get(`${repo}/${name}`);
    if (!(target && registrations.includes(target.key))) {
      return null;
    }
    const checkoutIdentity = await inspectCheckoutIdentity(target, checkoutFs);
    return checkoutIdentity.known ? { ...target, checkoutIdentity } : null;
  };
  // biome-ignore lint/suspicious/useAwait: The injected command runner rejects unexpected commands through its promise contract.
  const command = async (args) => {
    calls.push(args);
    if (args.slice(0, 3).join(' ') === 'gh workflow list') {
      return commandResult(
        JSON.stringify([
          {
            id: 7,
            name: 'Review',
            path: '.github/workflows/review.yml',
            state: 'active',
          },
        ])
      );
    }
    if (args.slice(0, 3).join(' ') === 'gh workflow view') {
      return commandResult('on:\n  workflow_dispatch:\n');
    }
    if (args.slice(0, 3).join(' ') === 'gh workflow run') {
      return commandResult();
    }
    throw new Error(`unexpected command: ${args.join(' ')}`);
  };
  const services = createPortalResourceServices({
    branch: async (target) => target.name,
    callTool: async () => ({ ok: true }),
    claims: () => [],
    command,
    config: async () => currentConfig,
    entries: async () => registrations.map((key) => targets.get(key)),
    gitHead: async (target) => ({
      state: 'known',
      value: execFileSync('git', ['-C', target.wtDir, 'rev-parse', 'HEAD'], {
        encoding: 'utf8',
      }).trim(),
    }),
    githubTarget: (repo, name) => targets.get(`${repo}/${name}`),
    hostHealth: async () => ({ ok: true }),
    lifecycle,
    mcpTools: () => [],
    nativeRuntime: async () => 'dead',
    operationId: (() => {
      let id = 0;
      return () => {
        id += 1;
        return `op-${id}`;
      };
    })(),
    randomId: (() => {
      let id = 0;
      return () => {
        id += 1;
        return `retry-${id}`;
      };
    })(),
    resolveTarget,
    state,
    trackedPaths: async () => ({ state: 'clean' }),
    ...serviceOptions,
    ...(resourceAdmissionFactory
      ? { resourceAdmission: resourceAdmissionFactory(state) }
      : {}),
  });
  return {
    calls,
    lifecycle,
    other,
    registrations: (value) => {
      registrations = value;
    },
    root,
    services,
    setConfig: (value) => {
      currentConfig = value;
    },
    state,
    store,
    targets,
    topic,
  };
}

test('production resource dispatcher dynamically catalogs registered source and durable shared-store roots', async () => {
  const fx = await fixture();
  try {
    const topic = await fx.targets.get('r/topic');
    const identity = await inspectCheckoutIdentity(topic, checkoutFs);
    await fx.state.replace('dependencyViews', {
      consumers: {
        [identity.checkoutPath]: { checkout: identity.checkoutPath },
      },
    });
    await fx.state.replace('dependencyFiles', {
      operations: {},
      version: 1,
      views: {
        'r/topic': {
          checkoutIdentity: identity,
          completedFiles: 1,
          createdAt: 1,
          id: 'a'.repeat(64),
          inputDigest: 'b'.repeat(64),
          logicalCloneBytes: 10,
          mode: 'hoisted-cow',
          name: 'topic',
          physicalSavingsBytes: null,
          planId: 'a'.repeat(64),
          repo: 'r',
          retainedOriginalFiles: 1,
          state: 'completed',
          storeIdentity: {
            device: String((await statAsync(fx.store)).dev),
            executable: '/opt/setu/bin/bun',
            mountPath: await realpathAsync(fx.root),
            namespace: 'hoisted/darwin-arm64-bun-1.3.14',
            root: await realpathAsync(fx.store),
            version: '1.3.14',
          },
          totalFiles: 1,
          updatedAt: 1,
          version: 1,
        },
      },
    });
    mkdirSync(join(fx.topic, 'node_modules'), { recursive: true });
    mkdirSync(join(fx.topic, '.next', 'cache'), { recursive: true });
    writeFileSync(
      join(fx.topic, 'node_modules', 'package.bin'),
      'dependency bytes'
    );
    linkSync(
      join(fx.topic, 'node_modules', 'package.bin'),
      join(fx.topic, '.next', 'cache', 'shared.bin')
    );
    writeFileSync(
      join(fx.topic, '.next', 'cache', 'generated.bin'),
      'generated bytes'
    );
    const first = await json(fx.services, '/api/workspace-storage');
    expect(first.ok).toBe(true);
    expect(first.roots.map((root) => root.category)).toEqual(
      expect.arrayContaining([
        'source',
        'dependencies',
        'generated',
        'live-store',
      ])
    );
    expect(first.observations).toEqual([]);
    const catalog = await json(fx.services, '/api/shared-caches');
    const canonicalStore = await realpathAsync(fx.store);
    const shared = catalog.stores.find(
      (store) => store.path === canonicalStore
    );
    expect(shared.consumers).toEqual([identity.checkoutPath]);
    expect(shared.id.startsWith('store:')).toBe(true);
    expect(shared.kind).toBe('package-store');
    const inspectedStore = await json(
      fx.services,
      '/api/workspace-storage/inspect',
      {
        body: JSON.stringify({ storeId: shared.id }),
        headers: { 'content-type': 'application/json' },
        method: 'POST',
      }
    );
    expect(inspectedStore.ok).toBe(true);
    expect(inspectedStore.observations[0].id).toBe(shared.id);
    expect(inspectedStore.observations[0].state).toBe('ready');
    const source = await json(fx.services, '/api/workspace-storage/inspect', {
      body: JSON.stringify({ name: 'topic', repo: 'r' }),
      headers: { 'content-type': 'application/json' },
      method: 'POST',
    });
    expect(source.ok).toBe(true);
    expect(source.observations.map((item) => item.category)).toEqual(
      expect.arrayContaining(['source', 'dependencies', 'generated'])
    );
    const dependency = source.observations.find(
      (item) => item.category === 'dependencies'
    );
    const generated = source.observations.find(
      (item) => item.category === 'generated'
    );
    expect(dependency.entries + generated.entries).toBeGreaterThan(0);
    // The dependency file and generated cache hardlink are one batch inode,
    // so selected target inspection must never count them twice.
    expect(dependency.logicalBytes + generated.logicalBytes).toBe(31);
    fx.registrations(['r/topic', 'r/other']);
    const second = await json(fx.services, '/api/workspace-storage');
    expect(second.roots.some((root) => root.category === 'source')).toBe(true);
    const inspectedTarget = await json(
      fx.services,
      '/api/workspace-storage/inspect',
      {
        body: JSON.stringify({ name: 'other', repo: 'r' }),
        headers: { 'content-type': 'application/json' },
        method: 'POST',
      }
    );
    expect(inspectedTarget.ok).toBe(true);
  } finally {
    rmSync(fx.root, { force: true, recursive: true });
  }
});

test('production composition distinguishes clean empty journals from malformed runtime records and locks manifest targets', async () => {
  const fx = await fixture();
  try {
    const prepared = await json(fx.services, '/api/worktree-cache/prepare', {
      body: JSON.stringify({ name: 'topic', repo: 'r' }),
      headers: { 'content-type': 'application/json' },
      method: 'POST',
    });
    expect(prepared).toMatchObject({ ok: true, registered: true });
    await fx.state.replace('agentSessions', { sessions: { malformed: {} } });
    const blocked = await json(fx.services, '/api/worktree-cache/prepare', {
      body: JSON.stringify({ name: 'topic', repo: 'r' }),
      headers: { 'content-type': 'application/json' },
      method: 'POST',
    });
    expect(blocked).toMatchObject({ code: 'RUNTIME_UNKNOWN', ok: false });
    await fx.state.replace('agentSessions', {});
    const endedRun = {
      checkoutIdentity: await inspectCheckoutIdentity(
        fx.targets.get('r/topic'),
        checkoutFs
      ),
      checkoutPath: fx.topic,
      createdAt: 1,
      limits: { maxBudgetUsd: 1, outputBytes: 1024, wallClockMs: 1000 },
      model: null,
      name: 'topic',
      provider: 'claude',
      providerBudget: 'enforced by Claude Code --max-budget-usd',
      repo: 'r',
      resumedFrom: null,
      resumeSession: null,
    };
    await fx.state.replace('headlessRuns', {
      runs: {
        cancelled: { ...endedRun, id: 'cancelled', state: 'cancelled' },
        timed: { ...endedRun, id: 'timed', state: 'timed out' },
      },
    });
    const terminalHistory = await json(
      fx.services,
      '/api/worktree-cache/prepare',
      {
        body: JSON.stringify({ name: 'topic', repo: 'r' }),
        headers: { 'content-type': 'application/json' },
        method: 'POST',
      }
    );
    expect(terminalHistory.ok).toBe(true);
    fx.lifecycle.snapshot = () => ({ phase: 'queued', reserved: false });
    const queued = await json(fx.services, '/api/worktree-cache/prepare', {
      body: JSON.stringify({ name: 'topic', repo: 'r' }),
      headers: { 'content-type': 'application/json' },
      method: 'POST',
    });
    expect(queued.ok).toBe(false);
    fx.lifecycle.snapshot = () => null;
    await fx.state.replace('headlessRuns', {
      runs: {
        corrupt: { ...endedRun, id: 'corrupt', limits: {}, state: 'completed' },
      },
    });
    const corruptEnded = await json(
      fx.services,
      '/api/worktree-cache/prepare',
      {
        body: JSON.stringify({ name: 'topic', repo: 'r' }),
        headers: { 'content-type': 'application/json' },
        method: 'POST',
      }
    );
    expect(corruptEnded).toMatchObject({ code: 'RUNTIME_UNKNOWN', ok: false });
    await fx.state.replace('headlessRuns', {});
    await fx.state.replace('cacheManifests', { manifests: [] });
    const malformedManifests = await json(
      fx.services,
      '/api/worktree-cache/prepare',
      {
        body: JSON.stringify({ name: 'topic', repo: 'r' }),
        headers: { 'content-type': 'application/json' },
        method: 'POST',
      }
    );
    expect(malformedManifests).toMatchObject({
      code: 'MANIFEST_STORE_FAILED',
      ok: false,
    });
    expect(fx.state.read('cacheManifests')).toEqual({ manifests: [] });
    const other = fx.targets.get('r/other');
    const otherIdentity = await inspectCheckoutIdentity(other, checkoutFs);
    await fx.state.replace('cacheManifests', {
      manifests: {
        foreign: {
          checkoutIdentity: otherIdentity,
          id: 'foreign',
          target: other,
        },
      },
    });
    const refused = await json(fx.services, '/api/worktree-cache/execute', {
      body: JSON.stringify({
        confirmation: 'foreign',
        manifestId: 'foreign',
        name: 'topic',
        repo: 'r',
      }),
      headers: { 'content-type': 'application/json' },
      method: 'POST',
    });
    expect(refused).toMatchObject({
      code: 'MANIFEST_TARGET_MISMATCH',
      ok: false,
    });
  } finally {
    rmSync(fx.root, { force: true, recursive: true });
  }
});

test('dependency views use the durable canonical consumer map and reject malformed records', async () => {
  const fx = await fixture();
  try {
    const target = fx.targets.get('r/topic');
    const checkout = await realpathAsync(target.wtDir);
    const namespace = 'darwin-arm64-bun-1.3.14';
    const links = join(fx.store, namespace, 'links');
    mkdirSync(join(links, 'package'), { recursive: true });
    mkdirSync(join(target.wtDir, 'node_modules', '.bun'), { recursive: true });
    writeFileSync(
      join(target.wtDir, 'bunfig.toml'),
      '[install]\nlinker = "isolated"\n'
    );
    writeFileSync(join(target.wtDir, 'bun.lock'), 'lock\n');
    symlinkSync(
      join(links, 'package'),
      join(target.wtDir, 'node_modules', '.bun', 'package')
    );
    await fx.state.replace('dependencyViews', {
      consumers: {
        [checkout]: {
          bunVersion: '1.3.14',
          checkout,
          linkerMode: 'isolated',
          lockfileHash: createHash('sha256').update('lock\n').digest('hex'),
          platformNamespace: namespace,
        },
      },
    });
    const verified = await json(fx.services, '/api/dependency-sharing/verify', {
      body: JSON.stringify({ name: 'topic', repo: 'r' }),
      headers: { 'content-type': 'application/json' },
      method: 'POST',
    });
    expect(verified.ok).toBe(true);
    expect(verified.view).toMatchObject({
      enabled: true,
      name: 'topic',
      repo: 'r',
      state: 'shared and healthy',
    });
    expect(verified.view.reason).toContain('Disk savings are not measured');
    const beforeRepair = await readdirAsync(
      join(target.wtDir, 'node_modules', '.bun')
    );
    const planned = await json(fx.services, '/api/dependency-sharing/repair', {
      body: JSON.stringify({ name: 'topic', repo: 'r' }),
      headers: { 'content-type': 'application/json' },
      method: 'POST',
    });
    expect(planned).toMatchObject({
      code: 'DEPENDENCY_VIEW_NOT_MANAGED',
      executed: false,
      ok: false,
    });
    expect(
      await readdirAsync(join(target.wtDir, 'node_modules', '.bun'))
    ).toEqual(beforeRepair);
    await fx.state.replace('dependencyViews', {
      consumers: { [checkout]: { checkout } },
    });
    const malformed = await json(
      fx.services,
      '/api/dependency-sharing/verify',
      {
        body: JSON.stringify({ name: 'topic', repo: 'r' }),
        headers: { 'content-type': 'application/json' },
        method: 'POST',
      }
    );
    expect(malformed).toMatchObject({
      code: 'DEPENDENCY_VIEW_STATE_CORRUPT',
      ok: false,
    });
    initMcpServer({ dependencyVerify: fx.services.dependencyVerify });
    const mcp = await mcpTool('verify_dependency_sharing', {
      name: 'topic',
      repo: 'r',
    });
    expect(JSON.parse(mcp.result.content[0].text)).toMatchObject({
      code: 'DEPENDENCY_VIEW_STATE_CORRUPT',
      ok: false,
    });
  } finally {
    rmSync(fx.root, { force: true, recursive: true });
  }
});

test('dependency status shares disabled diagnostics across HTTP and MCP without changing an ordinary view', async () => {
  const fx = await fixture();
  try {
    const target = fx.targets.get('r/topic');
    const nodeModules = join(target.wtDir, 'node_modules');
    mkdirSync(nodeModules);
    writeFileSync(
      join(target.wtDir, 'bunfig.toml'),
      '[install]\nlinker = "hoisted"\n'
    );
    writeFileSync(join(nodeModules, 'marker.txt'), 'ordinary fixture view\n');
    const before = await readFileAsync(join(nodeModules, 'marker.txt'), 'utf8');
    fx.setConfig(undefined);

    const http = await json(
      fx.services,
      '/api/dependency-sharing?repo=r&name=topic'
    );
    const view = http.views.find(
      (row) => row.repo === 'r' && row.name === 'topic'
    );
    expect(view).toMatchObject({
      enabled: false,
      ok: true,
      state: 'disabled',
    });
    expect(view.dependencyFiles).toMatchObject({
      enabled: false,
      ok: true,
      state: 'disabled',
    });
    expect(view.reason).toContain('no dependencySharing configuration');
    expect(view.reason).toContain('linker = "hoisted"');
    expect(view.reason).toContain('will be left unchanged');

    initMcpServer({ dependencyViews: fx.services.dependencyViews });
    const mcp = await mcpTool('list_dependency_sharing', {
      name: 'topic',
      repo: 'r',
    });
    const mcpViews = JSON.parse(mcp.result.content[0].text);
    const mcpView = mcpViews.views.find(
      (row) => row.repo === 'r' && row.name === 'topic'
    );
    expect(mcpView.reason).toBe(view.reason);
    expect(await readFileAsync(join(nodeModules, 'marker.txt'), 'utf8')).toBe(
      before
    );

    fx.setConfig({ dependencySharing: '/store' });
    const malformed = await json(
      fx.services,
      '/api/dependency-sharing?repo=r&name=topic'
    );
    expect(malformed).toMatchObject({
      code: 'DEPENDENCY_VIEW_STATE_CORRUPT',
      ok: false,
    });
  } finally {
    rmSync(fx.root, { force: true, recursive: true });
  }
});

// Injected G4 results exercise target guards and portal envelopes only; no native file operation runs.
test('dependency file preparation requires a known bare runtime mode and preserves the G4 result envelope', async () => {
  const digest = 'a'.repeat(64);
  let engineCalls = 0;
  const engineFactory = () => ({
    apply: async () => ({ ok: true }),
    prepare: () => {
      engineCalls += 1;
      return {
        logicalCloneBytes: 8,
        ok: true,
        plan: { id: digest, mode: 'hoisted-cow' },
        skipped: [{ reason: 'metadata-unsupported', relativePath: 'bin/tool' }],
      };
    },
    prepareRelease: async () => ({ ok: true }),
    recover: async () => ({ ok: true }),
    release: async () => ({ ok: true }),
    status: async () => ({ enabled: true, ok: true, state: 'ordinary' }),
  });
  const fx = await fixture({ dependencyFileEngineFactory: engineFactory });
  try {
    const refused = await json(fx.services, '/api/dependency-sharing/prepare', {
      body: JSON.stringify({ name: 'topic', repo: 'r' }),
      headers: { 'content-type': 'application/json' },
      method: 'POST',
    });
    expect(refused).toMatchObject({
      code: 'CONTAINER_MODE_UNKNOWN',
      ok: false,
    });
    expect(engineCalls).toBe(0);
  } finally {
    rmSync(fx.root, { force: true, recursive: true });
  }

  const admitted = await fixture({
    containerMode: async () => 'bare',
    dependencyFileEngineFactory: engineFactory,
  });
  try {
    const result = await json(
      admitted.services,
      '/api/dependency-sharing/prepare',
      {
        body: JSON.stringify({ name: 'topic', repo: 'r' }),
        headers: { 'content-type': 'application/json' },
        method: 'POST',
      }
    );
    expect(result).toMatchObject({
      logicalCloneBytes: 8,
      ok: true,
      plan: { id: digest, mode: 'hoisted-cow' },
      skipped: [{ reason: 'metadata-unsupported', relativePath: 'bin/tool' }],
    });
    expect(engineCalls).toBe(1);
    const inventory = await json(
      admitted.services,
      '/api/dependency-sharing?repo=r&name=topic'
    );
    expect(inventory.views[0].dependencyFiles).toMatchObject({
      enabled: true,
      ok: true,
      state: 'ordinary',
    });
    expect(admitted.state.read('operationEvents').events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: expect.any(String),
          kind: 'dependency-file-prepare',
          state: 'completed',
          target: { name: 'topic', repo: 'r' },
        }),
      ])
    );
  } finally {
    rmSync(admitted.root, { force: true, recursive: true });
  }
});

// These injected observations exercise refusal paths only, not native runtime or claim verification.
test('dependency file mutation guard refuses active runtimes, writer claims, and setup', async () => {
  const digest = 'a'.repeat(64);
  const engineFactory = () => ({
    apply: async () => ({ ok: true }),
    prepare: async () => ({ ok: true, plan: { id: digest } }),
    prepareRelease: async () => ({ ok: true }),
    recover: async () => ({ ok: true }),
    release: async () => ({ ok: true }),
    status: async () => ({ ok: true }),
  });
  const cases = [
    {
      expected: 'ACTIVE_RUNTIME',
      overrides: {
        containerMode: async () => 'bare',
        dependencyFileEngineFactory: engineFactory,
        lifecycle: {
          operationStatus: () => null,
          snapshot: () => ({ phase: 'running', reserved: true }),
          snapshots: () => [],
        },
      },
    },
    {
      expected: 'TARGET_QUEUED',
      overrides: {
        containerMode: async () => 'bare',
        dependencyFileEngineFactory: engineFactory,
        lifecycle: {
          operationStatus: () => null,
          snapshot: () => ({ phase: 'queued', reserved: false }),
          snapshots: () => [],
        },
      },
    },
    {
      expected: 'TARGET_STARTING',
      overrides: {
        containerMode: async () => 'bare',
        dependencyFileEngineFactory: engineFactory,
        lifecycle: {
          operationStatus: () => null,
          snapshot: () => ({ phase: 'starting', reserved: true }),
          snapshots: () => [],
        },
      },
    },
    {
      expected: 'TARGET_STOPPING',
      overrides: {
        containerMode: async () => 'bare',
        dependencyFileEngineFactory: engineFactory,
        lifecycle: {
          operationStatus: () => null,
          snapshot: () => ({ phase: 'stopping', reserved: true }),
          snapshots: () => [],
        },
      },
    },
    {
      before: async (fx) => {
        const target = fx.targets.get('r/topic');
        const checkoutIdentity = await inspectCheckoutIdentity(
          target,
          checkoutFs
        );
        await fx.state.replace('setupProgress', {
          records: {
            'r/topic': {
              attemptId: 'attempt-1',
              checkoutIdentity,
              logLocation: '/tmp/setup.log',
              outcome: null,
              stage: 'install',
              startedAt: 1,
              state: 'running',
              target: { name: 'topic', repo: 'r' },
              updatedAt: 1,
            },
          },
        });
      },
      expected: 'SETUP_ACTIVE',
      overrides: {
        containerMode: async () => 'bare',
        dependencyFileEngineFactory: engineFactory,
      },
    },
    {
      before: async (fx) => {
        await fx.state.replace('resourceAdmission', { leases: 'malformed' });
      },
      expected: 'ADMISSION_STATE_UNKNOWN',
      overrides: {
        containerMode: async () => 'bare',
        dependencyFileEngineFactory: engineFactory,
      },
    },
    {
      expected: 'CONTAINER_MODE_UNSUPPORTED',
      overrides: {
        containerMode: async () => 'container',
        dependencyFileEngineFactory: engineFactory,
      },
    },
    {
      expected: 'RUNTIME_UNKNOWN',
      overrides: {
        containerMode: async () => 'bare',
        dependencyFileEngineFactory: engineFactory,
        nativeRuntime: async () => 'unknown',
      },
    },
  ];

  await Promise.all(
    cases.map(async (row) => {
      const fx = await fixture(row.overrides);
      try {
        if (row.before) {
          await row.before(fx);
        }
        const result = await json(
          fx.services,
          '/api/dependency-sharing/prepare',
          {
            body: JSON.stringify({ name: 'topic', repo: 'r' }),
            headers: { 'content-type': 'application/json' },
            method: 'POST',
          }
        );
        expect(result).toMatchObject({ code: row.expected, ok: false });
      } finally {
        rmSync(fx.root, { force: true, recursive: true });
      }
    })
  );

  const claim = { wtDir: '' };
  const claimed = await fixture({
    claims: () => [claim],
    containerMode: async () => 'bare',
    dependencyFileEngineFactory: engineFactory,
  });
  claim.wtDir = claimed.topic;
  try {
    const result = await json(
      claimed.services,
      '/api/dependency-sharing/prepare',
      {
        body: JSON.stringify({ name: 'topic', repo: 'r' }),
        headers: { 'content-type': 'application/json' },
        method: 'POST',
      }
    );
    expect(result).toMatchObject({ code: 'ACTIVE_WRITER', ok: false });
  } finally {
    rmSync(claimed.root, { force: true, recursive: true });
  }
});

test('fresh enrollment refuses until the portal supplies durable setup binding', async () => {
  const digest = 'a'.repeat(64);
  const engineCalls = [];
  const fx = await fixture({
    containerMode: async () => 'bare',
    dependencyFileEngineFactory: ({ assertMutable }) => ({
      apply: async () => ({ ok: true }),
      enrollFresh: async (target) => {
        engineCalls.push(target.key);
        await assertMutable(target, { phase: 'enroll-fresh' });
        return { ok: true, operationId: digest, state: 'completed' };
      },
      prepare: async () => ({ ok: true }),
      prepareRelease: async () => ({ ok: true }),
      recover: async () => ({ ok: true }),
      release: async () => ({ ok: true }),
      status: async () => ({ ok: true }),
    }),
    hostHealth: async () => ({
      availableBytes: Number.MAX_SAFE_INTEGER,
      state: 'ready',
    }),
    lifecycle: {
      operationStatus: () => ({ kind: 'setup', phase: 'running' }),
      snapshot: () => ({ phase: 'running', reserved: true }),
      snapshots: () => [],
    },
    resourceAdmission: {
      status: async () => ({
        leases: [
          {
            kind: 'install',
            operationId: 'admission-install-exact',
            ownership: 'confirmed',
            recoveryRequired: false,
            target: { name: 'topic', repo: 'r' },
          },
        ],
        ok: true,
      }),
    },
  });
  try {
    const target = await fx.targets.get('r/topic');
    const checkoutIdentity = await inspectCheckoutIdentity(target, checkoutFs);
    const setupContext = {
      admissionOperationId: 'admission-install-exact',
      attemptId: 'attempt-settled-1',
      checkoutIdentity,
      installerSettled: true,
      target: { name: 'topic', repo: 'r' },
    };
    await fx.state.replace('setupProgress', {
      records: {
        topic: {
          attemptId: setupContext.attemptId,
          checkoutIdentity,
          logLocation: '/fixture/setup.log',
          outcome: null,
          stage: 'dependency-enrollment',
          startedAt: 1,
          state: 'running',
          target: setupContext.target,
          updatedAt: 2,
        },
      },
    });
    const enrolled = await fx.services.dependencyFiles.enrollFresh(
      { name: 'topic', repo: 'r' },
      setupContext
    );
    expect(enrolled).toMatchObject({
      code: 'DEPENDENCY_FILE_SETUP_BINDING_REQUIRED',
      ok: false,
    });
    expect(engineCalls).toEqual([]);

    const changed = await fx.services.dependencyFiles.enrollFresh(
      { name: 'topic', repo: 'r' },
      { ...setupContext, attemptId: 'different-attempt' }
    );
    expect(changed).toMatchObject({
      code: 'DEPENDENCY_FILE_SETUP_CONTEXT_INVALID',
      ok: false,
    });
    expect(engineCalls).toHaveLength(0);
    const pathInjection = await fx.services.dependencyFiles.enrollFresh(
      { name: 'topic', repo: 'r', wtDir: target.wtDir },
      setupContext
    );
    expect(pathInjection).toMatchObject({
      code: 'DEPENDENCY_FILE_SETUP_CONTEXT_INVALID',
      ok: false,
    });
  } finally {
    rmSync(fx.root, { force: true, recursive: true });
  }
});

test('fresh enrollment blocks unresolved admission ownership and a sibling install lease', async () => {
  const cases = [
    { expected: 'ADMISSION_STATE_UNKNOWN', kind: 'unknown-owner' },
    { expected: 'ACTIVE_ADMISSION', kind: 'sibling-install' },
  ];
  await Promise.all(
    cases.map(async (row) => {
      const fx = await fixture({
        containerMode: async () => 'bare',
        hostHealth: async () => ({
          availableBytes: Number.MAX_SAFE_INTEGER,
          state: 'ready',
        }),
        lifecycle: {
          operationStatus: () => ({ kind: 'setup', phase: 'running' }),
          snapshot: () => null,
          snapshots: () => [],
        },
        // OS seam: the real admission factory receives a deterministic process
        // identity observation so the test can exercise unknown-owner handling.
        resourceAdmissionFactory: (state) =>
          createResourceAdmission({
            hostHealth: async () => ({
              availableBytes: Number.MAX_SAFE_INTEGER,
              state: 'ready',
            }),
            limits: { lowStorageFloorBytes: 0 },
            observeProcess: async (pid) => ({
              processId: pid,
              processStartIdentity: 'observed-process-incarnation',
              state: 'alive',
            }),
            state,
          }),
      });
      try {
        const target = await fx.targets.get('r/topic');
        const checkoutIdentity = await inspectCheckoutIdentity(
          target,
          checkoutFs
        );
        const admissionOperationId = 'admission-setup-exact';
        const setupContext = {
          admissionOperationId,
          attemptId: 'attempt-guarded-setup',
          checkoutIdentity,
          installerSettled: true,
          target: { name: 'topic', repo: 'r' },
        };
        await fx.state.replace('setupProgress', {
          records: {
            'r/topic': {
              attemptId: setupContext.attemptId,
              checkoutIdentity,
              dependencyEnrollment: {
                admissionOperationId,
                bunVersion: '1.3.14',
                installerSettled: true,
                version: 1,
              },
              logLocation: '/fixture/setup.log',
              outcome: null,
              stage: 'dependency-enrollment',
              startedAt: 1,
              state: 'running',
              target: setupContext.target,
              updatedAt: 2,
            },
          },
        });
        const exactLease = {
          acquiredAt: 1,
          kind: 'install',
          operationId: admissionOperationId,
          owner: {
            pid: process.pid,
            processStart: 'observed-process-incarnation',
          },
          target: { name: 'topic', repo: 'r' },
        };
        const leases = { [admissionOperationId]: exactLease };
        if (row.kind === 'unknown-owner') {
          leases[admissionOperationId].owner.processStart = 'stale-incarnation';
        } else {
          leases['admission-sibling-install'] = {
            ...exactLease,
            operationId: 'admission-sibling-install',
            target: { name: 'other', repo: 'r' },
          };
        }
        await fx.state.replace('resourceAdmission', { leases });

        const result = await fx.services.dependencyFiles.enrollFresh(
          { name: 'topic', repo: 'r' },
          setupContext
        );
        expect(result).toMatchObject({ code: row.expected, ok: false });
      } finally {
        rmSync(fx.root, { force: true, recursive: true });
      }
    })
  );
});

test('in-process MCP release preserves distinct review and known operation ids and leaves unknown ownership unset', async () => {
  // Real G6 resource, service, wiring and MCP factories; the injected G4 engine
  // isolates identity transport and does not claim native-operation coverage.
  const releaseId = 'b'.repeat(64);
  const operationId = 'c'.repeat(64);
  async function assertMcpRelease(outcome) {
    const fx = await fixture({
      containerMode: async () => 'bare',
      dependencyFileEngineFactory: () => ({
        apply: async () => ({ ok: true }),
        enrollFresh: async () => ({ ok: true }),
        prepare: async () => ({ ok: true }),
        prepareRelease: async () => ({ ok: true }),
        recover: async () => ({ ok: true }),
        release: () =>
          outcome instanceof Error
            ? Promise.reject(outcome)
            : Promise.resolve({ ok: true, ...outcome }),
        status: async () => ({ ok: true }),
      }),
    });
    try {
      initMcpServer({ dependencyRelease: fx.services.dependencyRelease });
      const mcp = await mcpTool('release_dependency_originals', {
        confirmation: releaseId,
        name: 'topic',
        releaseId,
        repo: 'r',
      });
      const result = JSON.parse(mcp.result.content[0].text);
      expect(result.releaseId).toBe(releaseId);
      if (outcome instanceof Error) {
        expect(result).toMatchObject({ ok: false });
        expect(result).not.toHaveProperty('operationId');
      } else {
        expect(result).toMatchObject({ ok: true, operationId, releaseId });
        expect(result.operationId).not.toBe(releaseId);
      }
    } finally {
      rmSync(fx.root, { force: true, recursive: true });
    }
  }

  await assertMcpRelease({ operationId, releaseId });
  await assertMcpRelease(
    new Error('engine lost the response before loading the owning operation')
  );
});

test('the imported dispatcher and MCP expose the same managed-service malformed-journal refusal', async () => {
  const fx = await fixture();
  try {
    const managed = createManagedAgentServices({
      admission: fx.services.admission,
      operationEvents: fx.services.events,
      resolveTarget: async ({ repo, name }) => {
        const target = fx.targets.get(`${repo}/${name}`);
        if (!target) {
          return null;
        }
        const checkoutIdentity = await inspectCheckoutIdentity(
          target,
          checkoutFs
        );
        return checkoutIdentity.known ? { ...target, checkoutIdentity } : null;
      },
      state: fx.state,
    });
    const composition = {
      ...fx.services,
      headlessRuns: (input) => managed.listRuns(input),
    };
    await fx.state.replace('headlessRuns', { runs: [] });
    const http = await json(composition, '/api/headless-runs');
    expect(http).toMatchObject({
      code: 'HEADLESS_RUN_JOURNAL_INVALID',
      ok: false,
    });
    initMcpServer({ headlessRuns: (input) => managed.listRuns(input) });
    const mcp = await mcpTool('list_headless_runs', {});
    expect(JSON.parse(mcp.result.content[0].text)).toMatchObject({
      code: 'HEADLESS_RUN_JOURNAL_INVALID',
      ok: false,
    });
  } finally {
    rmSync(fx.root, { force: true, recursive: true });
  }
});

test('GitHub routes and MCP use the same reviewed service without recording GET mutations', async () => {
  const fx = await fixture();
  try {
    const workflows = await json(
      fx.services,
      '/api/github/workflows?repo=r&name=topic'
    );
    expect(workflows).toEqual({
      ok: true,
      workflows: [
        { id: 7, name: 'Review', path: '.github/workflows/review.yml' },
      ],
    });
    expect(fx.services.operations({})).toEqual({ events: [], ok: true });
    await fx.services.events.record({
      at: 2000,
      id: 'old',
      kind: 'github-dispatch',
      source: 'ui',
      state: 'completed',
      target: { name: 'topic', repo: 'r' },
    });
    await fx.services.events.record({
      at: 4000,
      id: 'new',
      kind: 'github-dispatch',
      source: 'raycast',
      state: 'accepted',
      target: { name: 'topic', repo: 'r' },
    });
    const since = await json(
      fx.services,
      '/api/operations?repo=r&name=topic&since=1970-01-01T00:00:03.000Z&limit=1'
    );
    expect(since.events.map((event) => event.id)).toEqual(['new']);
    const reviewInput = {
      inputs: {},
      name: 'topic',
      ref: 'topic',
      repo: 'r',
      workflow: '7',
    };
    const review = await json(fx.services, '/api/github/dispatch', {
      body: JSON.stringify(reviewInput),
      headers: { 'content-type': 'application/json' },
      method: 'POST',
    });
    expect(review.code).toBe('GITHUB_DISPATCH_CONFIRMATION_REQUIRED');
    expect(typeof review.confirmation?.token).toBe('string');
    expect(
      fx.calls.some((args) => args.slice(0, 3).join(' ') === 'gh workflow run')
    ).toBe(false);
    const dispatchInput = {
      confirmation: review.confirmation.token,
      inputs: {},
      name: 'topic',
      ref: 'topic',
      repo: 'r',
      workflow: '7',
    };
    const direct = await fx.services.githubDispatch(dispatchInput);
    expect(direct).toMatchObject({ dispatched: true, ok: true });
    const dispatched = await json(fx.services, '/api/github/dispatch', {
      body: JSON.stringify(dispatchInput),
      headers: { 'content-type': 'application/json' },
      method: 'POST',
    });
    expect(dispatched).toMatchObject({
      dispatched: true,
      ok: true,
      operationId: expect.any(String),
    });
    expect(
      fx.calls.some((args) => args.slice(0, 3).join(' ') === 'gh workflow run')
    ).toBe(true);
    initMcpServer({
      githubWorkflows: fx.services.githubWorkflows,
      operations: fx.services.operations,
    });
    const mcp = await mcpTool('list_github_workflows', {
      name: 'topic',
      repo: 'r',
    });
    expect(JSON.parse(mcp.result.content[0].text)).toEqual(workflows);
    const mcpOperations = await mcpTool('list_operations', {
      name: 'topic',
      repo: 'r',
      since: '1970-01-01T00:00:03.000Z',
    });
    const mcpIds = JSON.parse(mcpOperations.result.content[0].text).events.map(
      (event) => event.id
    );
    expect(mcpIds).toContain('new');
    expect(mcpIds).not.toContain('old');
  } finally {
    rmSync(fx.root, { force: true, recursive: true });
  }
});
