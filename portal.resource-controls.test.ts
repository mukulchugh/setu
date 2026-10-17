import { expect, test } from 'bun:test';
import { createGithubActions } from './github-actions.js';
import { createMcpActions } from './mcp-actions.js';
import {
  attentionFocusBody,
  cleanupExecutionBody,
  confirmationToken,
  createReviewGeneration,
  dependencyRepairPlan,
  handoffFindings,
  readResource,
  resourceAction,
  resourceReadUrl,
  storageBytes,
  workflowValue,
} from './portal/components/resource-controls';
import { createReviewHandoff } from './review-handoff.js';
import { createTerminalAttention } from './terminal-attention.js';

test('attention focus uses the verified session joined to an actual hook event', async () => {
  const session = {
    checkoutIdentity: { checkoutPath: '/fixture/topic', inode: 42 },
    checkoutPath: '/fixture/topic',
    id: 'session-1',
    name: 'topic',
    ownership: 'owned',
    repo: 'app',
    state: 'running',
    terminal: { id: 'terminal-1', kind: 'ghostty' },
    tool: 'claude-code',
  };
  let document = {};
  const attention = createTerminalAttention({
    clock: () => 1,
    resolveHookSession: () => ({
      checkoutIdentity: session.checkoutIdentity,
      sessionId: session.id,
    }),
    sessions: { get: () => session },
    state: {
      read: () => document,
      // biome-ignore lint/suspicious/useAwait: State mutation failures must reject through the asynchronous store contract.
      update: async (_name: string, change: (value: object) => object) => {
        document = change(document);
      },
    },
  });
  const received = await attention.receive({
    payload: {
      cwd: session.checkoutPath,
      hook_event_name: 'Stop',
      session_id: 'native-1',
    },
    provider: 'claude-code',
  });
  expect(received.ok).toBeTrue();
  const event = {
    ...received.attention,
    session,
    target: { name: 'topic', repo: 'app' },
  };
  expect(event).not.toHaveProperty('checkoutIdentity');
  expect(attentionFocusBody(event, 'app', 'topic')).toEqual({
    checkoutIdentity: session.checkoutIdentity,
    name: 'topic',
    repo: 'app',
    sessionId: 'session-1',
  });
  expect(
    attentionFocusBody({ ...event, session: null }, 'app', 'topic')
  ).toBeNull();
  expect(attentionFocusBody(event, 'app', 'replaced')).toBeNull();
  expect(
    attentionFocusBody({ ...event, state: 'unknown' }, 'app', 'topic')
  ).toBeNull();
});

test('resource reads retain their target and reject malformed successful responses', async () => {
  const original = globalThis.fetch;
  try {
    expect(resourceReadUrl('/api/github/workflows', 'repo/a', 'feat/x')).toBe(
      '/api/github/workflows?name=feat%2Fx&repo=repo%2Fa'
    );
    globalThis.fetch = (async () =>
      Response.json({ ok: true, runs: [] })) as typeof fetch;
    expect(
      await readResource('/api/headless-runs', new AbortController().signal)
    ).toEqual({ ok: true, runs: [] });
    globalThis.fetch = (async () =>
      Response.json({ runs: [] })) as typeof fetch;
    await expect(
      readResource('/api/headless-runs', new AbortController().signal)
    ).rejects.toThrow('Malformed resource response');
  } finally {
    globalThis.fetch = original;
  }
});

test('resource mutations are attributed to the UI and preserve backend recovery fields', async () => {
  const original = globalThis.fetch;
  try {
    let request: RequestInit | undefined;
    // biome-ignore lint/suspicious/useAwait: The fetch fixture preserves rejected response-construction failures.
    globalThis.fetch = (async (_input, init) => {
      request = init;
      return Response.json({
        ok: false,
        operationId: 'cleanup-1',
        removedPaths: ['.next/cache/a'],
        retryId: 'retry-1',
      });
    }) as typeof fetch;
    const result = await resourceAction('/api/worktree-cache/execute', {
      confirmation: 'manifest-1',
      manifestId: 'manifest-1',
      name: 'feat/x',
      repo: 'repo/a',
    });
    expect(result).toMatchObject({
      ok: false,
      operationId: 'cleanup-1',
      removedPaths: ['.next/cache/a'],
      retryId: 'retry-1',
    });
    expect(new Headers(request?.headers).get('x-setu-source')).toBe('ui');
    expect(JSON.parse(request?.body as string)).toEqual({
      confirmation: 'manifest-1',
      manifestId: 'manifest-1',
      name: 'feat/x',
      repo: 'repo/a',
    });
  } finally {
    globalThis.fetch = original;
  }
});

test('readers reject malformed successful lists, retain zero measurements, and preserve refusals', async () => {
  const original = globalThis.fetch;
  try {
    globalThis.fetch = (async () =>
      Response.json({ ok: true, sessions: 'not-a-list' })) as typeof fetch;
    await expect(
      readResource('/api/agent-sessions', new AbortController().signal)
    ).rejects.toThrow('sessions');
    globalThis.fetch = (async () =>
      Response.json({
        code: 'SESSION_STATE_CORRUPT',
        error: 'Unreadable',
        ok: false,
      })) as typeof fetch;
    await expect(
      readResource('/api/agent-sessions', new AbortController().signal)
    ).resolves.toMatchObject({ code: 'SESSION_STATE_CORRUPT', ok: false });
    expect(storageBytes(0)).toBe('0');
    expect(workflowValue(42)).toBe('42');
  } finally {
    globalThis.fetch = original;
  }
});

test('dependency repair displays the returned command only as an unexecuted plan', () => {
  const result = {
    command: ['bun', 'install', '--frozen-lockfile'],
    env: { BUN_INSTALL_CACHE_DIR: '/fixture/cache' },
    executed: false,
    mode: 'isolated',
    ok: true,
  };
  expect(dependencyRepairPlan(result)).toEqual({
    command: result.command,
    env: result.env,
    mode: 'isolated',
  });
  expect(dependencyRepairPlan({ ...result, ok: false })).toBeNull();
  expect(dependencyRepairPlan({ ...result, executed: true })).toBeNull();
});

test('GitHub review takes the module-issued refusal token and dispatches only after confirmation', async () => {
  const calls: string[][] = [];
  const actions = createGithubActions({
    branch: async () => 'feature/ui',
    readWorkflow: async () => 'on: workflow_dispatch\n',
    // biome-ignore lint/suspicious/useAwait: The workflow command fixture preserves the asynchronous runner contract.
    run: async (argv: string[]) => {
      calls.push(argv);
      if (argv.slice(1, 3).join(' ') === 'workflow list') {
        return {
          code: 0,
          stdout: JSON.stringify([
            {
              id: 42,
              name: 'Release',
              path: '.github/workflows/release.yml',
              state: 'active',
            },
          ]),
        };
      }
      if (argv.slice(1, 3).join(' ') === 'workflow run') {
        return { code: 0, stdout: '' };
      }
      throw new Error(`unexpected runner call ${argv.join(' ')}`);
    },
    target: () => ({ wtDir: '/fixture' }),
  });
  const workflow = workflowValue(42);
  if (!workflow) {
    throw new Error('Expected workflow value');
  }
  const request = {
    inputs: { channel: 'stable' },
    name: 'feature/ui',
    ref: 'feature/ui',
    repo: 'app',
    workflow,
  };
  const review = await actions.dispatch(request);
  expect(review).toMatchObject({
    code: 'GITHUB_DISPATCH_CONFIRMATION_REQUIRED',
    ok: false,
  });
  const token = confirmationToken(review);
  if (!token) {
    throw new Error('Expected confirmation token');
  }
  expect(calls).toHaveLength(0);
  await expect(
    actions.dispatch({ ...request, confirmation: token })
  ).resolves.toMatchObject({ dispatched: true, ok: true });
  expect(calls.at(-1)).toContain('42');
});

test('MCP preflight returns an object but invocation receives only its production token', async () => {
  let document: Record<string, unknown> = {};
  const invocations: unknown[] = [];
  const schema = { additionalProperties: false, type: 'object' };
  const actions = createMcpActions({
    // biome-ignore lint/suspicious/useAwait: Tool invocation fixtures preserve the asynchronous MCP transport contract.
    callTool: async (_server: string, _tool: string, input: unknown) => {
      invocations.push(input);
      return { ok: true, result: { delivered: true } };
    },
    eventRecorder: { record: async () => ({ ok: true }) },
    id: () => 'event-1',
    state: {
      read: () => document,
      // biome-ignore lint/suspicious/useAwait: State mutation failures must reject through the asynchronous store contract.
      update: async (
        _name: string,
        change: (value: Record<string, unknown>) => Record<string, unknown>
      ) => {
        document = change(document);
      },
    },
    tools: () => [{ inputSchema: schema, name: 'echo' }],
  });
  const saved = await actions.save({
    inputSchema: schema,
    mutates: true,
    serverId: 'local',
    title: 'Echo',
    tool: 'echo',
  });
  const review = actions.preflight(saved.action.id, {});
  const token = confirmationToken(review);
  expect(review).toMatchObject({ ok: true });
  if (!token) {
    throw new Error('Expected confirmation token');
  }
  await expect(
    actions.invoke(saved.action.id, {}, token)
  ).resolves.toMatchObject({ ok: true });
  expect(invocations).toEqual([{}]);
});

test('review generations reject delayed confirmations after input edits and cleanup retry retains exact recovery identity', () => {
  const review = createReviewGeneration();
  const delayed = review.begin();
  review.invalidate();
  expect(review.isCurrent(delayed)).toBeFalse();
  const partial = {
    code: 'CLEANUP_PARTIAL',
    ok: false,
    removedPaths: ['.next/cache/a'],
    retryId: 'retry-9',
  };
  expect(partial.removedPaths).toEqual(['.next/cache/a']);
  expect(cleanupExecutionBody('manifest-3', partial.retryId)).toEqual({
    confirmation: { manifestId: 'manifest-3', retryId: 'retry-9' },
    manifestId: 'manifest-3',
    retryId: 'retry-9',
  });
  expect(cleanupExecutionBody('manifest-3')).toEqual({
    confirmation: 'manifest-3',
    manifestId: 'manifest-3',
  });
});

test('handoff accepts selected finding records and refuses unavailable delivery without launching a session', async () => {
  expect(handoffFindings('  ')).toEqual([]);
  expect(handoffFindings('x'.repeat(801))).toEqual([]);
  let delivered = 0;
  const session = {
    checkoutIdentity: 'checkout-1',
    id: 'session-1',
    name: 'topic',
    ownership: 'owned',
    repo: 'app',
    state: 'running',
  };
  const handoff = createReviewHandoff({
    // biome-ignore lint/suspicious/useAwait: Delivery fixtures preserve the asynchronous session handoff contract.
    deliver: async () => {
      delivered += 1;
      return {
        checkoutIdentity: 'checkout-1',
        ok: true,
        sessionId: 'session-1',
      };
    },
    sessions: { get: () => session },
    verifySession: async () => ({ ok: true, session }),
  });
  await expect(
    handoff.deliver({
      artifact: {
        checkoutIdentity: 'checkout-1',
        headSha: 'abc',
        prNumber: 9,
        stale: false,
      },
      checkoutIdentity: 'checkout-1',
      findings: handoffFindings(
        'Check portal.tsx: preserve the selected checkout before applying the fix.'
      ),
      sessionId: 'session-1',
      target: { name: 'topic', repo: 'app' },
    })
  ).resolves.toMatchObject({ ok: true });
  expect(delivered).toBe(1);
  const unavailable = createReviewHandoff({
    sessions: { get: () => session },
    verifySession: async () => ({ ok: true, session }),
  });
  await expect(
    unavailable.deliver({
      artifact: {},
      checkoutIdentity: 'checkout-1',
      findings: [{ id: 'F-1' }],
      sessionId: 'session-1',
      target: { name: 'topic', repo: 'app' },
    })
  ).resolves.toMatchObject({ code: 'HANDOFF_DELIVERY_UNAVAILABLE', ok: false });
});
