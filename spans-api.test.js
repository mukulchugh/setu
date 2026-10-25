import { expect, test } from 'bun:test';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCli } from './cli.js';
import { decodeSpansSearch } from './portal/spans-search';
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
    await work({ request, root, runtime, state, store });
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

test('portal, CLI and MCP retain real cache evidence and update cutover refuses new fills', async () => {
  await fixture(async ({ request, store }) => {
    expect(
      store.appendEvent({
        eventId: 'cache-evidence-1',
        payload: { summary: 'cachefixture retained history' },
        runId: 'run-cache',
        type: 'run.note',
      }).ok
    ).toBe(true);
    expect(store.initializeSearch().ok).toBe(true);
    expect(store.indexSearchPage({ limit: 200 }).ok).toBe(true);
    const first = await (
      await request('/api/spans/search?query=cachefixture')
    ).json();
    expect(first.ok).toBe(true);
    expect(first.cache.hit).toBe(false);
    expect(first.cache.persisted).toBe(true);
    const mcp = await callMcp(request, 'search_spans', {
      query: 'cachefixture',
    });
    expect(mcp.result.isError).toBe(false);
    expect(mcp.result.structuredContent.cache.hit).toBe(true);
    expect(mcp.result.structuredContent.cache.key).toBe(first.cache.key);
    const decoded = decodeSpansSearch(mcp.result.structuredContent, {
      query: 'cachefixture',
    });
    expect(decoded.cache.kind).toBe('available');
    expect(decoded.cache.hit).toBe(true);
    expect(decoded.cache.key).toBe(first.cache.key);
    expect(decoded.cache.source.corpusGeneration).toBe(
      `${decoded.generation}:${decoded.coverage.indexedSequence}:${decoded.coverage.latestSequence}`
    );
    let cliResult;
    const originalLog = console.log;
    console.log = () => undefined;
    try {
      const code = await runCli(['spans', 'search', 'cachefixture', '--json'], {
        request: async ({ path }) => {
          cliResult = await (await request(path)).json();
          return cliResult;
        },
      });
      expect(code).toBe(0);
      expect(cliResult.cache.hit).toBe(true);
      expect(cliResult.cache.key).toBe(first.cache.key);
    } finally {
      console.log = originalLog;
    }

    const capabilities = await (
      await request('/api/update/capabilities')
    ).json();
    const quiesced = await (
      await request('/api/update/quiesce', {
        body: JSON.stringify(capabilities),
        headers: { 'content-type': 'application/json', 'x-setu-source': 'ui' },
        method: 'POST',
      })
    ).json();
    expect(typeof quiesced.token).toBe('string');
    const uncached = await (
      await request('/api/spans/search?query=absentcachefixture')
    ).json();
    expect(uncached.ok).toBe(true);
    expect(uncached.hits).toEqual([]);
    expect(uncached.cache.hit).toBe(false);
    expect(uncached.cache.persisted).toBe(false);
    expect(uncached.cache.persistenceReason).toBe('ARCHIVE_WRITE_REFUSED');
    expect(store.readCache(uncached.cache.key)).toEqual({
      code: 'SPANS_MODEL_NOT_FOUND',
      error: 'Spans model record was not found.',
      ok: false,
    });
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

test.each(['codex', 'claude'])(
  'selected %s import resumes across HTTP and MCP through shared archive admission',
  async (provider) => {
    await fixture(async ({ request, root, store }) => {
      expect(
        createSpansDrafts({ store }).createRun({
          goal: 'Retained history fixture',
          owner: 'fixture',
          runId: 'retained-run',
          spans: [],
        }).ok
      ).toBe(true);
      const path = join(root, `${provider}.jsonl`);
      const records = Array.from({ length: 205 }, (_, index) =>
        provider === 'codex'
          ? {
              payload: {
                content: [
                  { text: `Retained message ${index}`, type: 'output_text' },
                ],
                id: `message-${index}`,
                role: 'assistant',
                type: 'message',
              },
              type: 'response_item',
            }
          : {
              message: {
                content: [{ text: `Retained message ${index}`, type: 'text' }],
                role: 'assistant',
              },
              type: 'assistant',
              uuid: `message-${index}`,
            }
      );
      const source = `${records.map((record) => JSON.stringify(record)).join('\n')}\n`;
      writeFileSync(path, source);
      const input = {
        parserVersion: 'parser-1',
        path,
        provider,
        runId: 'retained-run',
        sourceGeneration: 0,
        sourceId: 'selected-source',
      };
      const first = await request('/api/spans/import', {
        body: JSON.stringify(input),
        method: 'POST',
      });
      expect(first.status).toBe(200);
      expect(await first.json()).toMatchObject({
        hasMore: true,
        importedCount: 199,
        ok: true,
      });
      const second = (await callMcp(request, 'import_spans_source', { input }))
        .result;
      expect(second.isError).toBe(false);
      expect(second.structuredContent).toMatchObject({
        hasMore: false,
        importedCount: 6,
        ok: true,
      });
      const replay = (await callMcp(request, 'import_spans_source', { input }))
        .result;
      expect(replay.isError).toBe(false);
      expect(replay.structuredContent).toMatchObject({
        hasMore: false,
        importedCount: 0,
        ok: true,
      });
      expect(readFileSync(path, 'utf8')).toBe(source);
      const listed = await (await request('/api/spans/runs')).json();
      expect(listed.records.map((record) => record.runId)).toContain(
        'retained-run'
      );
      expect(
        (await (await request('/api/spans/run?runId=retained-run')).json())
          .record.runId
      ).toBe('retained-run');
      const events = await (
        await request('/api/spans/events?runId=retained-run&limit=200')
      ).json();
      expect(events.ok).toBe(true);
      expect(
        events.events.filter((event) => event.type === 'source.message')
      ).toHaveLength(199);
      expect(events.hasMore).toBe(true);
      expect(
        store
          .readEvents({
            afterSequence: events.nextSequence,
            runId: 'retained-run',
          })
          .events.filter((event) => event.type === 'source.message')
      ).toHaveLength(6);
    });
  }
);

test('selected import rejects authority overrides and malformed bodies without writes', async () => {
  await fixture(async ({ request, root, store }) => {
    const input = {
      parserVersion: 'parser-1',
      path: join(root, 'not-read.jsonl'),
      provider: 'codex',
      root,
      runId: 'refused-run',
      sourceGeneration: 0,
      sourceId: 'refused-source',
    };
    const rejected = (await callMcp(request, 'import_spans_source', { input }))
      .result;
    expect(rejected.isError).toBe(true);
    expect(rejected.structuredContent).toMatchObject({
      code: 'SOURCE_IMPORT_INVALID',
      ok: false,
    });
    for (const body of ['{', 'null', '[]', 'x'.repeat(1024 * 1024 + 1)]) {
      // biome-ignore lint/performance/noAwaitInLoops: Validate each bounded request against one unchanged fixture.
      const response = await request('/api/spans/import', {
        body,
        method: 'POST',
      });
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({
        code: 'SOURCE_IMPORT_INVALID',
        ok: false,
      });
    }
    expect(store.readEvents({ runId: 'refused-run' }).events).toEqual([]);
    expect(existsSync(input.path)).toBe(false);
  });
});

test('portal disposal closes selected imports and refuses subsequent import effects', async () => {
  await fixture(async ({ request, root, runtime }) => {
    await runtime.dispose();
    const { result } = await callMcp(request, 'import_spans_source', {
      input: {
        parserVersion: 'parser-1',
        path: join(root, 'not-read.jsonl'),
        provider: 'codex',
        runId: 'closed-run',
        sourceGeneration: 0,
        sourceId: 'closed-source',
      },
    });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      code: 'SPANS_IMPORT_RUNTIME_CLOSED',
      ok: false,
    });
  });
});

test('portal shutdown waits for an admitted import before closing its archive', async () => {
  await fixture(async ({ request, root, runtime, state, store }) => {
    const path = join(root, 'selected.jsonl');
    writeFileSync(
      path,
      `${JSON.stringify({ message: { content: [{ text: 'Retain this message', type: 'text' }], role: 'assistant' }, type: 'assistant', uuid: 'message' })}\n`
    );
    let entered;
    const admitted = new Promise((resolve) => {
      entered = resolve;
    });
    let release;
    const held = new Promise((resolve) => {
      release = resolve;
    });
    const { update } = state;
    state.update = async (...args) => {
      entered();
      await held;
      return update(...args);
    };
    const importing = request('/api/spans/import', {
      body: JSON.stringify({
        parserVersion: 'parser-1',
        path,
        provider: 'claude',
        runId: 'shutdown-run',
        sourceGeneration: 0,
        sourceId: 'shutdown-source',
      }),
      method: 'POST',
    });
    await admitted;
    let finished = false;
    const disposing = runtime.dispose().then(() => {
      finished = true;
    });
    try {
      await new Promise((resolve) => setImmediate(resolve));
      expect(finished).toBe(false);
    } finally {
      release();
      state.update = update;
      await disposing;
    }
    expect(await (await importing).json()).toMatchObject({
      importedCount: 1,
      ok: true,
    });
    expect(finished).toBe(true);
    expect(
      store
        .readEvents({ runId: 'shutdown-run' })
        .events.filter((event) => event.type === 'source.message')
    ).toHaveLength(1);
  });
});

test('selected historical entries are read-only Past records shared by HTTP, CLI and MCP', async () => {
  await fixture(async ({ request, root, store }) => {
    const sourcePath = join(root, 'selected-history.jsonl');
    const source = `${Array.from({ length: 205 }, (_, index) =>
      JSON.stringify({
        payload: {
          content: [{ text: `History ${index}`, type: 'output_text' }],
          id: `history-${index}`,
          role: 'assistant',
          type: 'message',
        },
        type: 'response_item',
      })
    ).join('\n')}\n`;
    writeFileSync(sourcePath, source);
    const input = { path: sourcePath, provider: 'codex' };
    const first = await (
      await request('/api/spans/history/import', {
        body: JSON.stringify(input),
        method: 'POST',
      })
    ).json();
    expect(first).toMatchObject({
      hasMore: true,
      importedCount: 199,
      ok: true,
    });
    const pastWhileImporting = await (
      await request('/api/spans/runs?phase=past')
    ).json();
    expect(pastWhileImporting.records.map((record) => record.runId)).toContain(
      first.runId
    );
    const { submitSpansHistoryImport } = await import(
      './portal/spans-history.ts'
    );
    const originalFetch = globalThis.fetch;
    try {
      globalThis.fetch = (path, init) => {
        expect(path).toBe('/api/spans/history/import');
        return request(path, init);
      };
      expect(await submitSpansHistoryImport(input)).toMatchObject({
        hasMore: false,
        importedCount: 6,
        kind: 'success',
        runId: first.runId,
        state: 'imported',
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
    const searchable = await (
      await request(
        `/api/spans/search?query=History%20204&runId=${first.runId}`
      )
    ).json();
    expect(searchable).toMatchObject({
      hits: [{ runId: first.runId }],
      ok: true,
    });
    const next = (await callMcp(request, 'import_spans_history', { input }))
      .result;
    expect(next.isError).toBe(false);
    expect(next.structuredContent).toMatchObject({
      hasMore: false,
      importedCount: 0,
      ok: true,
      runId: first.runId,
    });
    let replay;
    const status = await runCli(
      ['spans', 'import-history', '--input', JSON.stringify(input), '--json'],
      {
        request: async ({ path, body }) => {
          replay = await (
            await request(path, { body: JSON.stringify(body), method: 'POST' })
          ).json();
          return replay;
        },
      }
    );
    expect(status).toBe(0);
    expect(replay).toMatchObject({
      importedCount: 0,
      ok: true,
      runId: first.runId,
    });
    const read = await (
      await request(`/api/spans/run?runId=${first.runId}`)
    ).json();
    expect(read.ok).toBe(true);
    expect(store.readRun({ runId: first.runId }).view).toMatchObject({
      kind: 'imported',
      readOnly: true,
    });
    expect(readFileSync(sourcePath, 'utf8')).toBe(source);
    expect(
      JSON.stringify(store.readRun({ runId: first.runId }).view)
    ).not.toContain(sourcePath);
    const forbidden = (
      await callMcp(request, 'import_spans_history', {
        input: { ...input, sourceId: 'caller-authority' },
      })
    ).result;
    expect(forbidden.isError).toBe(true);
  });
});
