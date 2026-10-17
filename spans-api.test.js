import { expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCli } from './cli.js';
import { createPortalRuntime } from './portal.js';
import { createSpansDrafts } from './spans-drafts.js';
import { createSpansRuntime } from './spans-runtime.js';
import { openSpansStore } from './spans-store.js';
import { createWorkspaceState } from './workspace-state.js';

async function fixture(work) {
  const root = mkdtempSync(join(tmpdir(), 'spans-api-'));
  const archive = join(root, 'archive');
  mkdirSync(archive, { mode: 0o700 });
  const store = openSpansStore({ root: archive });
  const state = createWorkspaceState({
    configPath: join(root, 'config.json'),
    setuDir: root,
    workspaceRoot: root,
  });
  const config = { tunnel: 'fixture', workspace: root };
  await state.replace('config', config);
  const runtime = await createPortalRuntime({
    computeWorktrees: () => Promise.resolve([]),
    config,
    indexPage: new Response('fixture'),
    managedAgents: {
      dispose: () => Promise.resolve(),
      recover: () => Promise.resolve(),
    },
    observeProcess: () => Promise.resolve({ state: 'unknown' }),
    port: 43_210,
    projects: {},
    reconcileDevServers: () => Promise.resolve(),
    reconcileTriggerSidecars: () => Promise.resolve(),
    routing: { syncHosts: () => Promise.resolve() },
    seedSidecarApprovals: () => Promise.resolve(),
    serve: () => ({ stop: () => undefined }),
    spansRoot: archive,
    state,
    timers: { clearInterval: () => undefined, setInterval: () => 1 },
  });
  await runtime.start();
  const server = {
    requestIP: () => ({ address: '127.0.0.1' }),
    timeout: () => undefined,
  };
  const request = (path, init) =>
    runtime.handle(new Request(`http://localhost:43210${path}`, init), server);
  try {
    await work({ request, store });
  } finally {
    await runtime.dispose();
    store.close();
    rmSync(root, { force: true, recursive: true });
  }
}

async function callMcp(request, name, input) {
  const response = await request('/mcp', {
    body: JSON.stringify({
      id: 1,
      jsonrpc: '2.0',
      method: 'tools/call',
      params: { arguments: input, name },
    }),
    headers: {
      accept: 'application/json, text/event-stream',
      'content-type': 'application/json',
      host: 'localhost:43210',
    },
    method: 'POST',
  });
  const text = await response.text();
  const raw = text.startsWith('event:')
    ? text
        .split('\n')
        .find((line) => line.startsWith('data: '))
        .slice(6)
    : text;
  return JSON.parse(raw);
}

test('real portal, MCP and CLI share the offline archive reads without listening on a port', async () => {
  await fixture(async ({ request, store }) => {
    const drafts = createSpansDrafts({ store });
    expect(
      drafts.createRun({
        goal: 'Fixture work',
        owner: 'fixture',
        runId: 'run-1',
        spans: [],
      }).ok
    ).toBe(true);
    const response = await request('/api/spans/runs?limit=1');
    expect(response.status).toBe(200);
    const page = await response.json();
    expect(page.records[0].runId).toBe('run-1');
    const mcp = await callMcp(request, 'list_spans_runs', { limit: 1 });
    expect(mcp.result.isError).toBe(false);
    expect(mcp.result.structuredContent).toEqual(page);
    const missing = await callMcp(request, 'get_spans_run', {
      runId: 'missing',
    });
    expect(missing.result.isError).toBe(true);
    expect(missing.result.structuredContent.code).toBe(
      'SPANS_SERVICE_NOT_FOUND'
    );
    let cliResult;
    const status = await runCli(['spans', 'list', '--limit', '1', '--json'], {
      request: async ({ path }) => {
        cliResult = await (await request(path)).json();
        return cliResult;
      },
    });
    expect(status).toBe(0);
    expect(cliResult).toEqual(page);
    expect(
      (
        await (
          await request('/api/spans/events?runId=run-1&afterSequence=0')
        ).json()
      ).events
    ).toHaveLength(1);
  });
});

test('opening the read runtime does not create an archive, including after failed reads', async () => {
  const parent = mkdtempSync(join(tmpdir(), 'spans-uninitialized-'));
  const root = join(parent, 'absent');
  const runtime = createSpansRuntime({ root });
  try {
    expect(existsSync(root)).toBe(false);
    expect((await runtime.spansRuns({})).ok).toBe(false);
    expect(existsSync(root)).toBe(false);
    expect(runtime.close().ok).toBe(true);
  } finally {
    rmSync(parent, { force: true, recursive: true });
  }
});
