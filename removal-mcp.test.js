import { expect, test } from 'bun:test';
import { PACKAGE_VERSION } from './lib.js';
import { readLogTail } from './log-tail.js';
import { handleMcpRequest, initMcpServer } from './mcp-server.js';
import { createWorktreeLifecycle } from './worktree-lifecycle.js';

async function requestMcp(method, params = {}, headers = {}) {
  const response = await handleMcpRequest(
    new Request('http://localhost:2999/mcp', {
      body: JSON.stringify({
        id: 1,
        jsonrpc: '2.0',
        method,
        params,
      }),
      headers: {
        accept: 'application/json, text/event-stream',
        'content-type': 'application/json',
        host: 'localhost:2999',
        ...headers,
      },
      method: 'POST',
    })
  );
  const body = await response.text();
  return JSON.parse(
    body.startsWith('event:')
      ? body
          .split('\n')
          .find((line) => line.startsWith('data: '))
          .slice(6)
      : body
  );
}

function callTool(name, args = {}) {
  return requestMcp('tools/call', { arguments: args, name });
}

function callRemove(args) {
  return callTool('remove_worktree', args);
}

function toolJson(response) {
  expect(response.error).toBeUndefined();
  expect(response.result.isError).not.toBe(true);
  return JSON.parse(response.result.content[0].text);
}

const TOOL_NAMES = [
  'backup_spans_archive',
  'restore_spans_archive',
  'import_spans_history',
  'import_spans_source',
  'list_spans_runs',
  'get_spans_run',
  'get_spans_events',
  'get_spans_integrations',
  'get_spans_artifact',
  'search_spans',
  'list_spans_workflows',
  'preview_spans_workflow',
  'create_spans_workflow',
  'create_spans_draft',
  'revise_spans_plan',
  'get_spans_search_status',
  'adopt_worktree',
  'cancel_headless_run',
  'claim_worktree',
  'create_pr',
  'create_worktree',
  'dispatch_github_workflow',
  'disable_tunnel',
  'end_agent_session',
  'enable_tunnel',
  'execute_worktree_cache_cleanup',
  'get_doctor',
  'get_diff',
  'get_resource_admission',
  'get_logs',
  'get_setup_progress',
  'get_workspace_storage',
  'get_pr_review_status',
  'get_sidecar_logs',
  'focus_agent_session',
  'inspect_workspace_storage',
  'handoff_review_findings',
  'invoke_mcp_action',
  'list_agent_sessions',
  'list_attention',
  'list_claims',
  'list_dependency_sharing',
  'list_github_runs',
  'list_github_workflows',
  'list_headless_runs',
  'list_mcp_actions',
  'list_operations',
  'list_ports',
  'list_projects',
  'list_repo_prs',
  'list_shared_caches',
  'list_sidecars',
  'list_worktrees',
  'pr_ready',
  'plan_dependency_repair',
  'prepare_dependency_release',
  'prepare_dependency_sharing',
  'apply_dependency_sharing',
  'recover_dependency_sharing',
  'release_dependency_originals',
  'preflight_mcp_action',
  'prepare_worktree_cache_cleanup',
  'release_worktree',
  'remove_worktree',
  'resume_headless_run',
  'retry_setup',
  'run_pr_review',
  'save_mcp_action',
  'start_convex',
  'start_headless_run',
  'start_inngest',
  'start_worktree',
  'start_trigger',
  'stop_convex',
  'stop_inngest',
  'stop_worktree',
  'stop_trigger',
  'sync_worktree',
  'verify_dependency_sharing',
];

test('inbound MCP initializes and discovers every supported tool without invoking a backend', async () => {
  initMcpServer({});
  const initialized = await requestMcp('initialize', {
    capabilities: {},
    clientInfo: { name: 'isolated-contract', version: '1' },
    protocolVersion: '2025-06-18',
  });
  expect(initialized.result.serverInfo.name).toBe('setu');
  expect(initialized.result.serverInfo.version).toBe(PACKAGE_VERSION);
  expect(initialized.result.instructions).toContain('sticky per-worktree');
  expect(initialized.result.instructions).toContain('real API budget');
  const discovered = await requestMcp('tools/list');
  expect(discovered.result.tools.map((tool) => tool.name).sort()).toEqual(
    TOOL_NAMES.slice().sort()
  );
  const schema = Object.fromEntries(
    discovered.result.tools.map((tool) => [tool.name, tool.inputSchema])
  );
  expect(schema.import_spans_source.required).toEqual(['input']);
  expect(
    discovered.result.tools.find((tool) => tool.name === 'import_spans_source')
      .annotations.readOnlyHint
  ).toBe(false);
  expect(schema.start_worktree.required.sort()).toEqual(['name', 'repo']);
  expect(schema.start_worktree.properties.container.type).toBe('boolean');
  expect(schema.remove_worktree.properties.operationId.minLength).toBe(1);
  expect(schema.run_pr_review.properties.skill.enum).toEqual([
    'pr-walkthrough',
    'pr-brief',
  ]);
  expect(schema.pr_ready.required.sort()).toEqual(['name', 'ready', 'repo']);
  expect(schema.claim_worktree.required.sort()).toEqual([
    'agent',
    'name',
    'pid',
    'repo',
    'session',
    'task',
  ]);
});

test('MCP runtime tools forward portal operations and preserve mutation recovery fields', async () => {
  const calls = [];
  const accepted = { ok: true, operationId: 'op-runtime', queued: false };
  initMcpServer({
    adoptWorktree: (...args) => {
      calls.push(['adoptWorktree', ...args]);
      return accepted;
    },
    disableTunnel: (...args) => {
      calls.push(['disableTunnel', ...args]);
      return accepted;
    },
    doctorReport: () => [{ name: 'portal', ok: true }],
    enableTunnel: (...args) => {
      calls.push(['enableTunnel', ...args]);
      return accepted;
    },
    getSidecarLogs: (...args) => {
      calls.push(['getSidecarLogs', ...args]);
      return { lines: ['ready'], state: 'ok' };
    },
    listSidecars: (...args) => {
      calls.push(['listSidecars', ...args]);
      return [{ active: true, approved: true, name: 'worker' }];
    },
    startConvex: (...args) => {
      calls.push(['startConvex', ...args]);
      return accepted;
    },
    startInngest: (...args) => {
      calls.push(['startInngest', ...args]);
      return accepted;
    },
    startTrigger: (...args) => {
      calls.push(['startTrigger', ...args]);
      return accepted;
    },
    stopConvex: (...args) => {
      calls.push(['stopConvex', ...args]);
      return accepted;
    },
    stopInngest: (...args) => {
      calls.push(['stopInngest', ...args]);
      return accepted;
    },
    stopTrigger: (...args) => {
      calls.push(['stopTrigger', ...args]);
      return accepted;
    },
  });

  for (const name of [
    'enable_tunnel',
    'disable_tunnel',
    'start_inngest',
    'stop_inngest',
    'start_trigger',
    'stop_trigger',
    'start_convex',
    'stop_convex',
  ]) {
    // biome-ignore lint/performance/noAwaitInLoops: MCP calls share the server singleton and the test asserts their recorded forwarding order.
    const response = await callTool(name, { name: 'topic', repo: 'r' });
    expect(response.result.structuredContent).toEqual(accepted);
  }
  expect(
    (
      await callTool('adopt_worktree', {
        name: 'topic',
        path: '/workspace/r/topic',
        repo: 'r',
      })
    ).result.structuredContent
  ).toEqual(accepted);
  expect(
    toolJson(await callTool('list_sidecars', { name: 'topic', repo: 'r' }))
  ).toEqual([{ active: true, approved: true, name: 'worker' }]);
  expect(
    (
      await callTool('get_sidecar_logs', {
        name: 'topic',
        repo: 'r',
        sidecar: 'worker',
      })
    ).result.structuredContent
  ).toEqual({ lines: ['ready'], state: 'ok' });
  expect(toolJson(await callTool('get_doctor'))).toEqual([
    { name: 'portal', ok: true },
  ]);
  expect(calls).toEqual([
    ['enableTunnel', 'r', 'topic'],
    ['disableTunnel', 'r', 'topic'],
    ['startInngest', 'r', 'topic'],
    ['stopInngest', 'r', 'topic'],
    ['startTrigger', 'r', 'topic'],
    ['stopTrigger', 'r', 'topic'],
    ['startConvex', 'r', 'topic'],
    ['stopConvex', 'r', 'topic'],
    ['adoptWorktree', 'r', 'topic', '/workspace/r/topic'],
    ['listSidecars', 'r', 'topic'],
    ['getSidecarLogs', 'r', 'topic', 'worker', 150],
  ]);
});

test('MCP exact retry returns complete partial removal as structured tool error', async () => {
  const called = [];
  const result = {
    code: 'REMOVAL_INCOMPLETE',
    completed: ['git'],
    error: 'Worktree was removed; routing cleanup is pending',
    ok: false,
    operationId: 'op-42',
    pendingSteps: ['routing'],
    removed: true,
  };
  initMcpServer({
    removeWorktree: (...args) => {
      called.push(args);
      return result;
    },
  });
  const response = await callRemove({
    name: 'topic',
    operationId: 'op-42',
    repo: 'r',
  });
  expect(called).toEqual([['r', 'topic', 'manual', false, 'op-42']]);
  expect(response.result.isError).toBe(true);
  expect(response.result.structuredContent).toEqual(result);
  expect(JSON.parse(response.result.content[0].text)).toEqual(result);
});

test('MCP rejects an empty operation ID without invoking removal', async () => {
  let calls = 0;
  initMcpServer({
    removeWorktree: () => {
      calls += 1;
      return { ok: true };
    },
  });
  const response = await callRemove({
    name: 'topic',
    operationId: '',
    repo: 'r',
  });
  expect(calls).toBe(0);
  expect(response.result.isError).toBe(true);
});

test('MCP preserves thrown structured uncertainty instead of losing recovery fields', async () => {
  initMcpServer({
    removeWorktree: () => {
      throw Object.assign(new Error('Inspect pending cleanup'), {
        causeCode: 'OPERATION_UNKNOWN',
        code: 'REMOVAL_OUTCOME_UNKNOWN',
        completedStages: ['stop', 'volumes', 'tunnel'],
        operationId: 'op-42',
        pendingSteps: ['git'],
        removed: null,
      });
    },
  });
  const response = await callRemove({ name: 'topic', repo: 'r' });
  expect(response.result.isError).toBe(true);
  expect(response.result.structuredContent).toEqual({
    causeCode: 'OPERATION_UNKNOWN',
    code: 'REMOVAL_OUTCOME_UNKNOWN',
    completedStages: ['stop', 'volumes', 'tunnel'],
    error: 'Inspect pending cleanup',
    ok: false,
    operationId: 'op-42',
    pendingSteps: ['git'],
    removed: null,
  });
});

test('MCP malformed results cannot report success', async () => {
  initMcpServer({
    removeWorktree: () => Promise.resolve({ message: 'accepted?' }),
  });
  const response = await callRemove({ name: 'topic', repo: 'r' });
  expect(response.result.isError).toBe(true);
  expect(response.result.structuredContent).toMatchObject({
    code: 'REMOVAL_OUTCOME_UNKNOWN',
    ok: false,
    removed: null,
  });
});

test('MCP unknown operation stays exact and returns its structured refusal', async () => {
  const calls = [];
  const result = {
    code: 'REMOVAL_NOT_FOUND',
    error: 'Unknown operation',
    ok: false,
    removed: false,
  };
  initMcpServer({
    removeWorktree: (...args) => {
      calls.push(args);
      return result;
    },
  });
  const response = await callRemove({
    name: 'topic',
    operationId: 'expired-id',
    repo: 'r',
  });
  expect(calls).toEqual([['r', 'topic', 'manual', false, 'expired-id']]);
  expect(response.result.structuredContent).toEqual(result);
});

test('MCP discovery reads dispatch independently and keep compact PR state', async () => {
  const calls = [];
  const worktree = {
    active: true,
    ahead: 2,
    behind: 1,
    branch: 'feature/a',
    container: 'setu-a',
    dirty: null,
    domain: 'a.setu.local',
    label: 'Example',
    memMb: 900,
    name: 'a',
    port: 3301,
    pr: {
      checks: 'pass',
      number: 7,
      state: 'OPEN',
      title: 'Large title',
      url: 'https://example.invalid/7',
    },
    queued: false,
    queuePosition: null,
    repo: 'r',
    starting: false,
    stopping: false,
    wtDir: '/not-exposed',
  };
  const reads = {
    fetchRepoPRs: [{ isDraft: true, number: 7 }],
    getWorktrees: [worktree],
    listPorts: [{ name: 'a', port: 3301, repo: 'r' }],
    listProjects: [{ label: 'Example', name: 'r', slug: 'example/r' }],
    prReviewStatus: {
      artifacts: {},
      pluginInstalled: true,
      run: { running: false },
    },
  };
  initMcpServer(
    Object.fromEntries(
      Object.entries(reads).map(([name, value]) => [
        name,
        (...args) => {
          calls.push([name, ...args]);
          return value;
        },
      ])
    )
  );
  const listed = toolJson(await callTool('list_worktrees'));
  const { memMb, wtDir, ...expected } = worktree;
  expect(listed).toEqual([
    {
      ...expected,
      pr: {
        checks: 'pass',
        number: 7,
        state: 'OPEN',
        url: 'https://example.invalid/7',
      },
    },
  ]);
  expect(toolJson(await callTool('list_ports'))).toEqual(reads.listPorts);
  expect(toolJson(await callTool('list_projects'))).toEqual(reads.listProjects);
  expect(toolJson(await callTool('list_repo_prs', { repo: 'r' }))).toEqual(
    reads.fetchRepoPRs
  );
  expect(
    toolJson(await callTool('get_pr_review_status', { name: 'a', repo: 'r' }))
  ).toEqual(reads.prReviewStatus);
  expect(calls).toEqual([
    ['getWorktrees'],
    ['listPorts'],
    ['listProjects'],
    ['fetchRepoPRs', 'r'],
    ['prReviewStatus', 'r', 'a'],
  ]);
});

test('MCP lifecycle preserves sticky or explicit mode, queued acceptance and Stop forwarding', async () => {
  const starts = [],
    stops = [];
  initMcpServer({
    startWorktree: (...args) => {
      starts.push(args);
      return args[2] === false
        ? { container: false, ok: true }
        : { container: true, ok: true, position: 2, queued: true };
    },
    stopWorktree: (...args) => {
      stops.push(args);
      return { ok: true };
    },
  });
  expect(
    toolJson(await callTool('start_worktree', { name: 'a', repo: 'r' }))
  ).toEqual({ container: true, ok: true, position: 2, queued: true });
  expect(
    toolJson(
      await callTool('start_worktree', {
        container: false,
        name: 'a',
        repo: 'r',
      })
    )
  ).toEqual({ container: false, ok: true });
  expect(
    toolJson(
      await callTool('start_worktree', {
        container: true,
        name: 'a',
        repo: 'r',
      })
    )
  ).toEqual({ container: true, ok: true, position: 2, queued: true });
  expect(
    toolJson(await callTool('stop_worktree', { name: 'a', repo: 'r' }))
  ).toEqual({ ok: true });
  expect(
    toolJson(await callTool('stop_worktree', { name: 'queued', repo: 'r' }))
  ).toEqual({ ok: true });
  expect(starts).toEqual([
    ['r', 'a', undefined],
    ['r', 'a', false],
    ['r', 'a', true],
  ]);
  expect(stops).toEqual([
    ['r', 'a'],
    ['r', 'queued'],
  ]);
});

test('MCP write tools forward explicit choices once without extra work or replay', async () => {
  const calls = [];
  const record =
    (method) =>
    (...args) => {
      calls.push([method, ...args]);
      return { method, ok: true };
    };
  initMcpServer(
    Object.fromEntries(
      [
        'createWorktree',
        'syncWorktree',
        'prReviewRun',
        'createPr',
        'setPrReady',
        'removeWorktree',
      ].map((name) => [name, record(name)])
    )
  );
  const cases = [
    ['create_worktree', { name: 'a', repo: 'r' }, 'createWorktree'],
    [
      'create_worktree',
      { name: 'a', repo: 'r', tunnel: true },
      'createWorktree',
    ],
    ['sync_worktree', { name: 'a', repo: 'r' }, 'syncWorktree'],
    [
      'run_pr_review',
      { name: 'a', repo: 'r', skill: 'pr-walkthrough' },
      'prReviewRun',
    ],
    [
      'run_pr_review',
      { name: 'a', repo: 'r', skill: 'pr-brief' },
      'prReviewRun',
    ],
    ['create_pr', { name: 'a', repo: 'r' }, 'createPr'],
    ['pr_ready', { name: 'a', ready: false, repo: 'r' }, 'setPrReady'],
    ['pr_ready', { name: 'a', ready: true, repo: 'r' }, 'setPrReady'],
    [
      'remove_worktree',
      {
        force: true,
        name: 'a',
        operationId: 'exact-operation',
        reason: 'merged',
        repo: 'r',
      },
      'removeWorktree',
    ],
  ];
  for (const [tool, args, method] of cases) {
    // biome-ignore lint/performance/noAwaitInLoops: Verify each ordered call against the same substituted backend before dispatching the next.
    expect(toolJson(await callTool(tool, args))).toEqual({ method, ok: true });
  }
  expect(calls).toEqual([
    ['createWorktree', 'r', 'a', false],
    ['createWorktree', 'r', 'a', true],
    ['syncWorktree', 'r', 'a'],
    ['prReviewRun', 'r', 'a', 'pr-walkthrough'],
    ['prReviewRun', 'r', 'a', 'pr-brief'],
    ['createPr', 'r', 'a'],
    ['setPrReady', 'r', 'a', false],
    ['setPrReady', 'r', 'a', true],
    ['removeWorktree', 'r', 'a', 'merged', true, 'exact-operation'],
  ]);
});

test('MCP diff defaults to filenames and bounds verbose hunks independently for both groups', async () => {
  const calls = [];
  const files = Array.from({ length: 23 }, (_, i) => ({
    additions: 1,
    deletions: 0,
    file: `file-${i}.ts`,
    hunks: [{ lines: ['+content'] }],
  }));
  initMcpServer({
    computeDiff: (...args) => {
      calls.push(args);
      return {
        base: 'origin/staging',
        baseResolved: false,
        committed: {
          additions: 23,
          deletions: 0,
          files,
          totalFiles: 27,
          truncatedFileCount: 4,
        },
        uncommitted: {
          additions: 23,
          deletions: 0,
          files,
          totalFiles: 23,
          untracked: ['new-file.ts'],
        },
      };
    },
  });
  const summary = toolJson(
    await callTool('get_diff', { name: 'a', repo: 'r' })
  );
  expect(summary.baseResolved).toBe(false);
  expect(summary.committed.totalFiles).toBe(27);
  expect(summary.committed.files).toHaveLength(23);
  expect(summary.committed.files[0]).toEqual({
    additions: 1,
    binary: false,
    deletions: 0,
    file: 'file-0.ts',
  });
  expect(summary.uncommitted.untracked).toEqual(['new-file.ts']);
  const verbose = toolJson(
    await callTool('get_diff', { name: 'a', repo: 'r', verbose: true })
  );
  expect(verbose.base).toBe('origin/staging');
  expect(verbose.committed.files).toHaveLength(20);
  expect(verbose.committed.files.at(-1).file).toBe('file-19.ts');
  expect(verbose.committed.files[0].hunks).toEqual([{ lines: ['+content'] }]);
  expect(verbose.committed.truncatedFileCount).toBe(7);
  expect(verbose.uncommitted.files).toHaveLength(20);
  expect(verbose.uncommitted.truncatedFileCount).toBe(3);
  expect(verbose.uncommitted.untracked).toEqual(['new-file.ts']);
  expect(calls).toEqual([
    ['r', 'a'],
    ['r', 'a'],
  ]);
});

test('MCP diff caps verbose text at 200 KiB with an explicit marker', async () => {
  initMcpServer({
    computeDiff: () => ({
      base: 'origin/main',
      baseResolved: true,
      committed: {
        additions: 1,
        deletions: 0,
        files: Array.from({ length: 20 }, (_, i) => ({
          additions: 1,
          deletions: 0,
          file: `large-${i}.txt`,
          hunks: [{ lines: ['x'.repeat(20_000)] }],
        })),
        totalFiles: 20,
      },
      uncommitted: {
        additions: 0,
        deletions: 0,
        files: [],
        totalFiles: 0,
        untracked: ['new.txt'],
      },
    }),
  });
  const response = await callTool('get_diff', {
    name: 'a',
    repo: 'r',
    verbose: true,
  });
  const { text } = response.result.content[0];
  expect(Buffer.byteLength(text)).toBeLessThanOrEqual(200 * 1024);
  expect(JSON.parse(text)).toMatchObject({
    truncation: 'Output truncated at 200 KB.',
  });
});

test('MCP logs use the production reader with a 256 KiB window and 2000 line ceiling', async () => {
  const content = Buffer.from(
    `${'x'.repeat(400_000)}\n${Array.from({ length: 2100 }, (_, i) => `line-${i}`).join('\n')}\n`
  );
  const calls = [],
    reads = [],
    closed = [];
  const files = {
    closeSync: (fd) => closed.push(fd),
    fstatSync: () => ({ size: content.length }),
    openSync: () => 3,
    readSync: (_fd, buffer, offset, length, position) => {
      reads.push({ length, position });
      return content.copy(buffer, offset, position, position + length);
    },
  };
  initMcpServer({
    tailLog: (...args) => {
      calls.push(args);
      return readLogTail('substituted.log', args[3], { files, now: () => 123 });
    },
  });
  const ordinary = (
    await callTool('get_logs', { name: 'a', repo: 'r' })
  ).result.content[0].text.split('\n');
  expect(ordinary).toHaveLength(150);
  expect(ordinary[0]).toBe('line-1950');
  expect(ordinary.at(-1)).toBe('line-2099');
  const large = (
    await callTool('get_logs', {
      lines: 10_000,
      name: 'a',
      repo: 'r',
      type: 'pr-review',
    })
  ).result.content[0].text.split('\n');
  expect(large).toHaveLength(2000);
  expect(large[0]).toBe('line-100');
  expect(calls).toEqual([
    ['r', 'a', 'dev', 150],
    ['r', 'a', 'pr-review', 10_000],
  ]);
  expect(reads).toEqual([
    { length: 262_144, position: content.length - 262_144 },
    { length: 262_144, position: content.length - 262_144 },
  ]);
  expect(closed).toEqual([3, 3]);
});

test('MCP rejects malformed tool arguments and foreign Host before backend dispatch', async () => {
  let calls = 0;
  initMcpServer(
    new Proxy(
      {},
      {
        get: () => () => {
          calls += 1;
          return { ok: true };
        },
      }
    )
  );
  const cases = [
    ['start_worktree', { container: null, name: 'a', repo: 'r' }],
    ['get_logs', { lines: 0, name: 'a', repo: 'r' }],
    ['get_logs', { lines: 1.5, name: 'a', repo: 'r' }],
    ['run_pr_review', { name: 'a', repo: 'r', skill: 'arbitrary-command' }],
    ['pr_ready', { name: 'a', ready: 'yes', repo: 'r' }],
    ['remove_worktree', { force: 'yes', name: 'a', repo: 'r' }],
  ];
  for (const [tool, args] of cases) {
    // biome-ignore lint/performance/noAwaitInLoops: Each refused call must complete before checking that the shared backend was never invoked.
    expect((await callTool(tool, args)).result.isError).toBe(true);
  }
  const rejected = await requestMcp(
    'tools/call',
    { arguments: {}, name: 'list_projects' },
    { host: 'untrusted.invalid' }
  );
  expect(rejected.error.message).toContain('Invalid Host');
  expect(calls).toBe(0);
});

test('MCP preserves structured lifecycle refusal and never retries an uncertain mutation', async () => {
  let calls = 0;
  const refusal = {
    causeCode: 'EIO',
    code: 'OPERATION_UNKNOWN',
    committed: true,
    error: 'Completion could not be observed',
    ok: false,
    phase: 'unknown',
  };
  initMcpServer({
    startWorktree: () => {
      calls += 1;
      return refusal;
    },
  });
  const response = await callTool('start_worktree', { name: 'a', repo: 'r' });
  expect(calls).toBe(1);
  expect(response.result.isError).toBe(true);
  expect(response.result.structuredContent).toEqual(refusal);
  expect(JSON.parse(response.result.content[0].text)).toEqual(refusal);
});

test('MCP marks refused review runs as tool errors with their original metadata', async () => {
  const refusal = {
    code: 'TARGET_BUSY',
    error: 'Another operation owns this worktree',
    ok: false,
  };
  initMcpServer({ prReviewRun: async () => refusal });
  const response = await callTool('run_pr_review', {
    name: 'a',
    repo: 'r',
    skill: 'pr-brief',
  });
  expect(response.result.isError).toBe(true);
  expect(response.result.structuredContent).toEqual(refusal);
});

test('MCP log errors remain distinguishable from empty or missing logs and retain bounded text', async () => {
  const snapshot = {
    code: 'EACCES',
    lines: ['last good line'],
    observedAt: 200,
    retained: true,
    state: 'read-error',
    successfulAt: 100,
    total: 1,
    truncated: false,
  };
  initMcpServer({ tailLog: () => snapshot });
  const response = await callTool('get_logs', { name: 'a', repo: 'r' });
  expect(response.result.isError).toBe(true);
  expect(response.result.structuredContent).toEqual(snapshot);
  expect(response.result.content[0].text).toContain('last good line');
});

test('MCP worktree discovery preserves unknown ownership and the reason Stop failed', async () => {
  const status = {
    lifecycleError: {
      code: 'STOP_FAILED',
      error: 'Process exit was not observed',
    },
    operation: { kind: 'deploy', phase: 'unknown' },
    phase: 'unknown',
  };
  initMcpServer({
    getWorktrees: async () => [
      { active: false, name: 'a', repo: 'r', ...status },
    ],
  });
  expect(toolJson(await callTool('list_worktrees'))[0]).toMatchObject(status);
});

test('MCP Stop cancels the actual lifecycle queue so a later vacancy cannot launch it', async () => {
  const launched = [],
    stopped = [];
  const target = (repo, name) => ({
    key: `${repo}/${name}`,
    name,
    port: name === 'a' ? 3301 : 3302,
    repo,
    wtDir: `/isolated/${repo}/${name}`,
  });
  const lifecycle = createWorktreeLifecycle({
    capacity: {
      refresh: async () => ({ available: true, cpus: 4, memMb: 8192 }),
    },
    clock: { clearTimeout: () => undefined, now: () => 0, setTimeout: () => 1 },
    runtime: {
      launch: (entry, _spec, register) => {
        launched.push(entry.key);
        register({ ownedGroup: true });
        return {};
      },
      observe: async () => 'alive',
      stop: (entry) => {
        stopped.push(entry.key);
      },
    },
    settings: { maxConcurrentDevServers: 1 },
    validateTarget: async () => true,
  });
  initMcpServer({
    startWorktree: (repo, name, container) =>
      lifecycle.start(target(repo, name), container),
    stopWorktree: (repo, name) => lifecycle.stop(target(repo, name)),
  });
  try {
    expect(
      toolJson(
        await callTool('start_worktree', {
          container: false,
          name: 'a',
          repo: 'r',
        })
      )
    ).toEqual({ container: false, ok: true });
    expect(
      toolJson(
        await callTool('start_worktree', {
          container: false,
          name: 'b',
          repo: 'r',
        })
      )
    ).toEqual({
      container: false,
      ok: true,
      position: 1,
      queued: true,
      reason: 'concurrency',
    });
    expect(lifecycle.queueSnapshot().map((entry) => entry.key)).toEqual([
      'r/b',
    ]);
    expect(
      toolJson(await callTool('stop_worktree', { name: 'b', repo: 'r' }))
    ).toEqual({ ok: true });
    expect(lifecycle.queueSnapshot()).toEqual([]);
    expect(lifecycle.snapshot('r/b').phase).toBe('stopped');
    expect(
      toolJson(await callTool('stop_worktree', { name: 'a', repo: 'r' }))
    ).toEqual({ ok: true });
    expect(launched).toEqual(['r/a']);
    expect(stopped).toEqual(['r/b', 'r/a']);
    expect(lifecycle.status().active).toBe(0);
  } finally {
    lifecycle.dispose();
  }
});

test.each([
  ['create_worktree', 'createWorktree', {}],
  ['start_worktree', 'startWorktree', {}],
  ['stop_worktree', 'stopWorktree', {}],
  ['sync_worktree', 'syncWorktree', {}],
  ['run_pr_review', 'prReviewRun', { skill: 'pr-walkthrough' }],
  ['create_pr', 'createPr', {}],
  ['pr_ready', 'setPrReady', { ready: false }],
])(
  'MCP %s retains a thrown state error without retry or internal error leakage',
  async (tool, method, extra) => {
    let calls = 0;
    initMcpServer({
      [method]: () => {
        calls += 1;
        return Promise.reject(
          Object.assign(new Error('Installed state requires reconciliation'), {
            causeCode: 'ENOSPC',
            code: 'STATE_RECONCILIATION_REQUIRED',
            committed: true,
            internalPath: '/private/fixture',
            phase: 'readback',
            reconciled: false,
          })
        );
      },
    });
    const response = await callTool(tool, { name: 'a', repo: 'r', ...extra });
    expect(calls).toBe(1);
    expect(response.result.isError).toBe(true);
    expect(response.result.structuredContent).toEqual({
      causeCode: 'ENOSPC',
      code: 'STATE_RECONCILIATION_REQUIRED',
      committed: true,
      error: 'Installed state requires reconciliation',
      ok: false,
      phase: 'readback',
      reconciled: false,
    });
  }
);

test.each([
  ['list_worktrees', 'getWorktrees', {}],
  ['list_ports', 'listPorts', {}],
  ['list_projects', 'listProjects', {}],
  ['list_repo_prs', 'fetchRepoPRs', { repo: 'r' }],
  ['get_pr_review_status', 'prReviewStatus', { name: 'a', repo: 'r' }],
  ['get_diff', 'computeDiff', { name: 'a', repo: 'r' }],
])(
  'MCP %s does not turn a failed read into an empty success',
  async (tool, method, args) => {
    let calls = 0;
    initMcpServer({
      [method]: () => {
        calls += 1;
        throw new Error('Read unavailable');
      },
    });
    const response = await callTool(tool, args);
    expect(calls).toBe(1);
    expect(response.result.isError).toBe(true);
    expect(response.result.content[0].text).toContain('Read unavailable');
  }
);

test.each(['empty', 'missing'])(
  'MCP %s log status is explicit without an invented error or successful read',
  async (state) => {
    const snapshot = {
      lines: [],
      observedAt: 200,
      retained: false,
      state,
      total: 0,
      ...(state === 'empty' ? { successfulAt: 200 } : {}),
    };
    initMcpServer({ tailLog: () => snapshot });
    const response = await callTool('get_logs', { name: 'a', repo: 'r' });
    expect(response.result.isError).not.toBe(true);
    expect(response.result.structuredContent).toEqual(snapshot);
    expect(response.result.content[0].text).not.toBe('');
  }
);

test('MCP dirty removal refusal preserves not-removed state without force or retry', async () => {
  const calls = [];
  const refusal = {
    code: 'WORKTREE_DIRTY',
    error: 'Uncommitted work must be preserved',
    ok: false,
    removed: false,
  };
  initMcpServer({
    removeWorktree: (...args) => {
      calls.push(args);
      return refusal;
    },
  });
  const response = await callRemove({ name: 'a', repo: 'r' });
  expect(response.result.isError).toBe(true);
  expect(response.result.structuredContent).toEqual(refusal);
  expect(calls).toEqual([['r', 'a', 'manual', false, undefined]]);
});

test('MCP setup refresh preserves its explicit choice and rejects malformed refresh flags before dispatch', async () => {
  const calls = [];
  initMcpServer({
    setupRetry: (request) => {
      calls.push(request);
      return { ok: true, operationId: 'refresh-operation' };
    },
  });
  const input = {
    attemptId: 'completed-attempt',
    checkoutIdentity: { known: true },
    name: 'topic',
    refreshDependencies: true,
    repo: 'fixture',
  };
  expect(toolJson(await callTool('retry_setup', input))).toMatchObject({
    ok: true,
    operationId: 'refresh-operation',
  });
  expect(calls).toEqual([{ ...input, source: 'mcp' }]);
  const malformed = await callTool('retry_setup', {
    ...input,
    refreshDependencies: 'true',
  });
  expect(malformed.result.isError).toBe(true);
  expect(calls).toHaveLength(1);
});
