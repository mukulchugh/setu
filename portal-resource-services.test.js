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

async function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'setu-resource-services-'));
  const bare = join(root, 'r.git');
  const seed = join(root, 'seed');
  const topic = join(root, 'r', 'topic');
  const other = join(root, 'r', 'other');
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
  mkdirSync(join(root, 'r'), { recursive: true });
  git(['worktree', 'add', '-b', 'topic', topic, 'main'], bare);
  git(['worktree', 'add', '-b', 'other', other, 'main'], bare);
  mkdirSync(store);
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
      workspaceRoot: root,
    },
    workspace: root,
  };
  const state = createWorkspaceState({
    configPath: join(root, 'config.json'),
    setuDir: root,
    workspaceRoot: root,
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
