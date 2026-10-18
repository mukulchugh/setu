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
    linksRoot: join(root, 'links'),
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

test('portal, CLI and MCP preview and save the same offline workflow without dispatch', async () => {
  await fixture(async ({ request, store }) => {
    const input = {
      owner: 'fixture',
      runId: 'planned-workflow',
      substitutions: {
        behavior: 'a retained draft',
        change: 'offline planning',
        scope: 'fixture only',
      },
      templateId: 'engineering.feature',
      templateVersion: 1,
    };
    const send = (path, body) =>
      request(path, {
        body: JSON.stringify(body),
        headers: { 'content-type': 'application/json' },
        method: 'POST',
      });
    const workflows = await (await request('/api/spans/workflows')).json();
    expect(workflows.ok).toBe(true);
    expect(
      (await callMcp(request, 'list_spans_workflows', {})).result
        .structuredContent
    ).toEqual(workflows);
    const preview = await (
      await send('/api/spans/workflows/preview', input)
    ).json();
    expect(preview.ok).toBe(true);
    expect(store.listRuns().runs).toEqual([]);
    expect(
      (await callMcp(request, 'preview_spans_workflow', { input })).result
        .structuredContent
    ).toEqual(preview);
    const save = { ...input, digest: preview.digest };
    let cliResult;
    expect(
      await runCli(
        ['spans', 'create-workflow', '--input', JSON.stringify(save), '--json'],
        {
          request: async ({ path, body }) => {
            cliResult = await (await send(path, body)).json();
            return cliResult;
          },
        }
      )
    ).toBe(0);
    expect(cliResult).toMatchObject({
      ok: true,
      replayed: false,
      run: { actions: {}, state: 'planned' },
    });
    const replay = (
      await callMcp(request, 'create_spans_workflow', { input: save })
    ).result;
    expect(replay.isError).toBe(false);
    expect(replay.structuredContent).toMatchObject({
      ok: true,
      replayed: true,
      revision: 1,
    });
    expect(
      store.readEvents({ runId: input.runId }).events.map((event) => event.type)
    ).toEqual(['spans.plan.created']);
    const revised = {
      expectedGeneration: 0,
      expectedRevision: 1,
      goal: 'Revised offline goal',
      runId: input.runId,
      spans: [
        { dependencies: [], spanId: 'review', title: 'Review the fixture' },
      ],
    };
    expect(
      (await callMcp(request, 'revise_spans_plan', { input: revised })).result
        .structuredContent
    ).toMatchObject({ generation: 1, ok: true, planVersion: 2 });
    expect((await send('/api/spans/plans/revise', revised)).status).toBe(200);
    const stale = (
      await callMcp(request, 'revise_spans_plan', { input: revised })
    ).result;
    expect(stale.isError).toBe(true);
    expect(stale.structuredContent.code).toBe('SPANS_DRAFT_STALE');
  });
});

test('planning front doors refuse malformed and approval-bearing requests without writes', async () => {
  await fixture(async ({ request, store }) => {
    const draft = {
      goal: 'Fixture plan',
      owner: 'fixture',
      runId: 'invalid-plan',
      spans: [],
    };
    const rejected = await callMcp(request, 'create_spans_draft', {
      input: { ...draft, approved: true },
    });
    expect(rejected.result.isError).toBe(true);
    expect(rejected.result.structuredContent.code).toBe('SPANS_DRAFT_INVALID');
    for (const body of ['{', 'null', '[]', 'x'.repeat(1024 * 1024 + 1)]) {
      // biome-ignore lint/performance/noAwaitInLoops: Exercise sequential body refusals against the same isolated archive.
      const response = await request('/api/spans/drafts/create', {
        body,
        method: 'POST',
      });
      expect(response.status).toBe(400);
    }
    let calls = 0;
    const previousExitCode = process.exitCode;
    try {
      expect(
        await runCli(['spans', 'create-draft', '--input', '{', '--json'], {
          request: () => {
            calls += 1;
            return { ok: true };
          },
        })
      ).toBe(1);
    } finally {
      process.exitCode = previousExitCode;
    }
    expect(calls).toBe(0);
    expect(store.listRuns().runs).toEqual([]);
    const created = await callMcp(request, 'create_spans_draft', {
      input: draft,
    });
    expect(created.result.isError).toBe(false);
    expect(created.result.structuredContent.run.state).toBe('planned');
  });
});
