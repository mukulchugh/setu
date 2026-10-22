import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { runCli } from './cli.js';
import { handleMcpRequest, initMcpServer } from './mcp-server.js';
import {
  createPortalResourceServices,
  dispatchPortalResourceRoute,
} from './portal-resource-services.js';
import { createWorkspaceState } from './workspace-state.js';

const MCP_EVENT = /^data: (.+)$/m;

function writeCheckout(path, linker) {
  mkdirSync(join(path, 'node_modules', 'fixture-package'), { recursive: true });
  writeFileSync(join(path, 'bun.lock'), 'lock fixture\n');
  writeFileSync(join(path, 'bunfig.toml'), `[install]\nlinker = "${linker}"\n`);
  writeFileSync(
    join(path, 'node_modules', 'fixture-package', 'index.js'),
    'export default "ordinary fixture";\n'
  );
}

function checkoutTarget(path) {
  return {
    checkoutIdentity: { checkoutPath: path, known: true },
    key: 'project/topic',
    name: 'topic',
    port: 3101,
    repo: 'project',
    wtDir: path,
  };
}

function fixture() {
  const root = mkdtempSync(
    join(process.cwd(), '.dependency-sharing-frontdoors-')
  );
  chmodSync(root, 0o700);
  const workspace = join(root, 'workspace');
  const storeRoot = join(root, 'dependency-store');
  const original = join(workspace, 'project', 'topic');
  const replacement = join(workspace, 'project', 'topic-replacement');
  const executable = join(root, 'fixture-installer');
  writeFileSync(
    executable,
    '#!/bin/sh\nprintf \'["1.3.14","darwin","arm64"]\\n\'\n',
    { mode: 0o700 }
  );
  mkdirSync(workspace, { recursive: true });
  mkdirSync(storeRoot, { mode: 0o700 });
  chmodSync(storeRoot, 0o700);
  writeCheckout(original, 'hoisted');
  writeCheckout(replacement, 'isolated');

  const storeIdentity = {
    device: statSync(storeRoot).dev,
    mountPath: realpathSync(storeRoot),
  };
  const state = createWorkspaceState({
    configPath: join(root, 'setu.json'),
    setuDir: root,
    workspaceRoot: workspace,
  });
  let currentConfig = { workspace };
  let currentTarget = checkoutTarget(original);
  let resolveCalls = 0;
  let nextOperationId = 0;
  const services = createPortalResourceServices({
    branch: async (target) => target.name,
    callTool: async () => ({ ok: true }),
    claims: () => [],
    command: () => {
      throw new Error('unexpected command');
    },
    config: async () => currentConfig,
    entries: async () => [checkoutTarget(original)],
    gitHead: async () => ({ state: 'unknown' }),
    githubTarget: () => null,
    hostHealth: async () => ({ ok: true }),
    lifecycle: { snapshot: () => null, snapshots: () => [] },
    mcpTools: () => [],
    operationId: () => {
      nextOperationId += 1;
      return `frontdoors-operation-${nextOperationId}`;
    },
    randomId: () => `frontdoors-random-${nextOperationId}`,
    resolveTarget: (repo, name) => {
      resolveCalls += 1;
      if (repo !== 'project' || name !== 'topic') {
        return null;
      }
      return currentTarget;
    },
    state,
    trackedPaths: async () => ({ state: 'clean' }),
  });

  return {
    executable,
    original,
    replacement,
    resolveCallCount: () => resolveCalls,
    root,
    services,
    setConfig(value) {
      currentConfig = value;
    },
    setTarget(path) {
      currentTarget = checkoutTarget(path);
    },
    state,
    storeIdentity,
    storeRoot,
    workspace,
  };
}

function snapshotTree(root) {
  const files = [];
  function visit(directory, relative = '') {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort(
      (left, right) => left.name.localeCompare(right.name)
    )) {
      const path = join(directory, entry.name);
      const key = relative ? `${relative}/${entry.name}` : entry.name;
      const info = lstatSync(path);
      if (info.isSymbolicLink()) {
        files.push([key, `symlink:${readlinkSync(path)}`]);
      } else if (info.isDirectory()) {
        visit(path, key);
      } else {
        files.push([key, readFileSync(path, 'utf8')]);
      }
    }
  }
  visit(root);
  return files;
}

function snapshotDependencies(fx) {
  return {
    original: snapshotTree(fx.original),
    replacement: snapshotTree(fx.replacement),
    store: snapshotTree(fx.storeRoot),
  };
}

async function portalRequest(services, method, path, body, headers = {}) {
  const request = new Request(`http://portal.test${path}`, {
    headers: {
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...headers,
    },
    method,
    ...(body === undefined
      ? {}
      : { body: typeof body === 'string' ? body : JSON.stringify(body) }),
  });
  const response = await dispatchPortalResourceRoute(services, request);
  return { body: await response.json(), response };
}

async function cliCommand(fx, argv) {
  const output = [];
  const errors = [];
  const requests = [];
  const priorLog = console.log;
  const priorError = console.error;
  const priorExitCode = process.exitCode;
  console.log = (value) => output.push(String(value));
  console.error = (value) => errors.push(String(value));
  try {
    const code = await runCli(argv, {
      request: async (call) => {
        requests.push(call);
        const { body } = await portalRequest(
          fx.services,
          call.method,
          call.path,
          call.body,
          call.headers
        );
        return body;
      },
    });
    return {
      code,
      errors,
      output,
      requests,
      value: output[0] ? JSON.parse(output[0]) : undefined,
    };
  } finally {
    console.log = priorLog;
    console.error = priorError;
    process.exitCode = priorExitCode;
  }
}

async function mcpCall(services, name, args) {
  const port = 34_000 + (process.pid % 1000);
  initMcpServer(services);
  try {
    const request = new Request(`http://localhost:${port}/mcp`, {
      body: JSON.stringify({
        id: 1,
        jsonrpc: '2.0',
        method: 'tools/call',
        params: { arguments: args, name },
      }),
      headers: {
        accept: 'application/json, text/event-stream',
        'content-type': 'application/json',
        host: `localhost:${port}`,
        origin: `http://localhost:${port}`,
      },
      method: 'POST',
    });
    const response = await handleMcpRequest(request, port);
    const event = (await response.text()).match(MCP_EVENT)?.[1];
    if (!event) {
      throw new Error('MCP in-memory handler returned no message event');
    }
    return { response, rpc: JSON.parse(event) };
  } finally {
    initMcpServer(null);
  }
}

function mcpValue(rpc) {
  const { result } = rpc;
  if (result?.structuredContent) {
    return result.structuredContent;
  }
  const message = result?.content?.find((entry) => entry.type === 'text')?.text;
  return message ? JSON.parse(message) : undefined;
}

function enabledConfig(fx) {
  return {
    dependencySharing: {
      enabled: true,
      executable: fx.executable,
      storeIdentity: fx.storeIdentity,
      storeRoot: fx.storeRoot,
      targets: { 'project/topic': true },
      version: '1.3.14',
    },
    workspace: fx.workspace,
  };
}

async function recordManagedConsumer(fx, checkout) {
  const canonical = realpathSync(checkout);
  const lockfileHash = createHash('sha256')
    .update(readFileSync(join(canonical, 'bun.lock')))
    .digest('hex');
  await fx.state.replace('dependencyViews', {
    consumers: {
      [canonical]: {
        bunVersion: '1.3.14',
        checkout: canonical,
        linkerMode: 'isolated',
        lockfileHash,
        platformNamespace: 'darwin-arm64-bun-1.3.14',
      },
    },
  });
}

test('disabled dependency reason matches through portal, CLI, and MCP', async () => {
  const fx = fixture();
  try {
    const api = await portalRequest(
      fx.services,
      'GET',
      '/api/dependency-sharing?name=topic&repo=project'
    );
    expect(api.body.views).toHaveLength(1);

    const cli = await cliCommand(fx, [
      'dependencies',
      'status',
      'project',
      'topic',
      '--json',
    ]);
    expect(cli.code).toBe(0);
    expect(cli.requests).toEqual([
      expect.objectContaining({
        headers: { 'x-setu-source': 'cli' },
        method: 'GET',
        path: '/api/dependency-sharing?name=topic&repo=project',
      }),
    ]);

    const mcp = await mcpCall(fx.services, 'list_dependency_sharing', {
      name: 'topic',
      repo: 'project',
    });
    expect(mcp.response.status).toBe(200);
    const mcpResult = mcpValue(mcp.rpc);
    const { reason } = api.body.views[0];
    expect(reason).toContain('hoisted');
    expect(api.body.views[0]).toMatchObject({
      enabled: false,
      state: 'disabled',
    });
    expect(cli.value.views[0].reason).toBe(reason);
    expect(mcpResult.views[0].reason).toBe(reason);
  } finally {
    rmSync(fx.root, { force: true, recursive: true });
  }
});

test('malformed dependency inputs are refused before a target action', async () => {
  const fx = fixture();
  try {
    const before = snapshotDependencies(fx);
    const resolveCalls = fx.resolveCallCount();
    const api = await portalRequest(
      fx.services,
      'POST',
      '/api/dependency-sharing/verify',
      '{not-json'
    );
    expect(api.body).toMatchObject({
      code: 'WORKTREE_NOT_FOUND',
      ok: false,
    });
    expect(fx.resolveCallCount()).toBe(resolveCalls);

    const mcp = await mcpCall(fx.services, 'verify_dependency_sharing', {
      repo: 'project',
    });
    expect(mcp.response.status).toBe(200);
    expect(mcp.rpc.result.isError).toBe(true);
    expect(mcp.rpc.result.content[0].text).toContain('Invalid input');
    expect(fx.resolveCallCount()).toBe(resolveCalls);

    const cli = await cliCommand(fx, [
      'dependencies',
      'verify',
      'project',
      '--json',
    ]);
    expect(cli.requests).toHaveLength(0);
    expect(cli.code).toBe(1);
    expect(fx.resolveCallCount()).toBe(resolveCalls);
    expect(snapshotDependencies(fx)).toEqual(before);
  } finally {
    rmSync(fx.root, { force: true, recursive: true });
  }
});

test.each(['repair', 'status'])(
  'incomplete dependency %s is refused before forwarding',
  async (action) => {
    const fx = fixture();
    try {
      const result = await cliCommand(fx, [
        'dependencies',
        action,
        'project',
        '--json',
      ]);
      expect(result.code).toBe(1);
      expect(result.requests).toHaveLength(0);
      expect(fx.resolveCallCount()).toBe(0);
    } finally {
      rmSync(fx.root, { force: true, recursive: true });
    }
  }
);

test('dependency status retains the implicit repo and branch form', async () => {
  const fx = fixture();
  try {
    const result = await cliCommand(fx, [
      'dependencies',
      'project',
      'topic',
      '--json',
    ]);
    expect(result.code).toBe(0);
    expect(result.requests).toHaveLength(1);
    expect(result.requests[0].path).toBe(
      '/api/dependency-sharing?name=topic&repo=project'
    );
    expect(result.value.views[0].state).toBe('disabled');
  } finally {
    rmSync(fx.root, { force: true, recursive: true });
  }
});

test('repair stays a plan across front doors and a replacement checkout gets no stale plan', async () => {
  const fx = fixture();
  try {
    writeFileSync(
      join(fx.original, 'bunfig.toml'),
      '[install]\nlinker = "isolated"\n'
    );
    fx.setConfig(enabledConfig(fx));
    await recordManagedConsumer(fx, fx.original);
    const before = snapshotDependencies(fx);

    const api = await portalRequest(
      fx.services,
      'POST',
      '/api/dependency-sharing/repair',
      { name: 'topic', repo: 'project' }
    );
    expect(api.body).toMatchObject({
      executed: false,
      mode: 'isolated',
      ok: true,
    });
    expect(api.body.command[1]).toEqual(
      expect.arrayContaining([
        'install',
        '--frozen-lockfile',
        '--linker',
        'isolated',
      ])
    );

    const cli = await cliCommand(fx, [
      'dependencies',
      'repair',
      'project',
      'topic',
      '--json',
    ]);
    expect(cli.code).toBe(0);
    expect(cli.requests[0]).toMatchObject({
      headers: {
        'content-type': 'application/json',
        'x-setu-source': 'cli',
      },
      method: 'POST',
      path: '/api/dependency-sharing/repair',
    });
    expect(cli.value).toMatchObject({
      executed: false,
      mode: 'isolated',
      ok: true,
    });

    const mcp = await mcpCall(fx.services, 'plan_dependency_repair', {
      name: 'topic',
      repo: 'project',
    });
    expect(mcp.response.status).toBe(200);
    expect(mcpValue(mcp.rpc)).toMatchObject({
      executed: false,
      mode: 'isolated',
      ok: true,
    });
    expect(snapshotDependencies(fx)).toEqual(before);

    fx.setTarget(fx.replacement);
    const replacementPlan = await portalRequest(
      fx.services,
      'POST',
      '/api/dependency-sharing/repair',
      { name: 'topic', repo: 'project' }
    );
    expect(replacementPlan.body).toMatchObject({
      code: 'DEPENDENCY_VIEW_NOT_MANAGED',
      executed: false,
      ok: false,
    });
    expect(replacementPlan.body.command).toBeUndefined();
    expect(snapshotDependencies(fx)).toEqual(before);
  } finally {
    rmSync(fx.root, { force: true, recursive: true });
  }
});
