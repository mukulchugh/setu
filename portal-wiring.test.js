import { expect, test } from 'bun:test';
import { createOperationEvents } from './operation-events.js';
import { createPortalWiring } from './portal-wiring.js';

function fixture(overrides = {}) {
  const calls = [];
  const events = [];
  const target = {
    name: 'topic',
    port: 3201,
    repo: 'r',
    wtDir: '/workspace/r/topic',
  };
  const wiring = createPortalWiring({
    attention: {
      list: () => ({ events: [], ok: true }),
      receive: async () => ({ ok: true }),
      returnToTerminal: async () => ({ ok: true }),
    },
    cache: {
      execute: async () => ({ ok: true, removedPaths: [] }),
      prepare: async () => ({
        manifest: { id: 'm' },
        ok: true,
        registered: true,
      }),
    },
    caches: { list: async () => ({ ok: true, stores: [] }) },
    dependency: {
      inspect: async () => ({ ok: true, state: 'ordinary' }),
      repair: async () => ({ executed: false, ok: true }),
      views: async () => ({ ok: true, views: [] }),
    },
    events: {
      list: () => ({ events, ok: true }),
      record: (event) => {
        try {
          events.push(event);
          return Promise.resolve({ event, ok: true });
        } catch (error) {
          return Promise.reject(error);
        }
      },
    },
    github: {
      dispatch: async (input) => ({ ...input, ok: true }),
      listRuns: async () => ({ ok: true, runs: [] }),
      listWorkflows: async () => ({ ok: true, workflows: [] }),
    },
    headless: {
      cancel: async () => ({ ok: true }),
      get: () => null,
      list: () => [],
      resume: async () => ({ ok: true }),
      start: async () => ({ id: 'run', ok: true, state: 'running' }),
    },
    mcpActions: {
      invoke: async () => ({ ok: true }),
      list: () => ({ actions: [], ok: true }),
      preflight: () => ({ confirmation: {}, ok: true }),
      save: async () => ({ action: {}, ok: true }),
    },
    now: () => 10,
    operationId: () => 'operation-1',
    registeredTarget: (repo, name) =>
      repo === 'r' && name === 'topic' ? target : null,
    sessions: {
      end: async () => ({ ok: true }),
      list: () => [],
      reconcile: async () => ({ ok: true }),
      register: async () => ({ ok: true }),
    },
    setup: {
      list: () => ({ ok: true, records: [] }),
      retry: async () => ({ ok: true }),
    },
    storage: {
      inspect: async () => [{ id: 'worktree:r/topic' }],
      readAll: () => [{ id: 'worktree:r/topic' }],
      roots: () => [{ id: 'worktree:r/topic' }],
    },
    ...overrides,
  });
  return { calls, events, target, wiring };
}

test('portal wiring validates registered targets and records accepted rather than completed async work', async () => {
  const { events, wiring } = fixture();
  await expect(
    wiring.headlessStart({ name: 'topic', prompt: 'review', repo: 'r' }, 'ui')
  ).resolves.toMatchObject({
    ok: true,
    operationId: 'operation-1',
    state: 'running',
  });
  expect(events.at(-1)).toEqual(
    expect.objectContaining({
      kind: 'headless-run',
      source: 'ui',
      state: 'accepted',
      target: { name: 'topic', repo: 'r' },
    })
  );
  await expect(
    wiring.headlessStart({ name: 'missing', prompt: 'review', repo: 'r' }, 'ui')
  ).resolves.toMatchObject({ code: 'WORKTREE_NOT_FOUND', ok: false });
});

test('portal wiring preserves cache confirmation and checkout identity fields unchanged', async () => {
  const { wiring } = fixture({
    cache: {
      execute: async (_manifestId, confirmation) => ({
        confirmation,
        ok: false,
        retryId: 'retry',
      }),
      prepare: async () => ({
        manifest: { id: 'm' },
        ok: true,
        registered: true,
      }),
    },
  });
  const identity = { checkoutPath: '/workspace/r/topic', known: true };
  await expect(
    wiring.cacheExecute(
      {
        checkoutIdentity: identity,
        confirmation: 'confirmed',
        manifestId: 'm',
        name: 'topic',
        repo: 'r',
      },
      'mcp'
    )
  ).resolves.toMatchObject({
    confirmation: 'confirmed',
    ok: false,
    retryId: 'retry',
  });
});

test('portal wiring GET helpers remain reads and do not inspect storage', async () => {
  let inspected = 0;
  const { wiring } = fixture({
    storage: {
      inspect: () => {
        inspected += 1;
        return Promise.resolve([]);
      },
      readAll: () => [],
      roots: () => [],
    },
  });
  await expect(wiring.workspaceStorage()).resolves.toEqual({
    observations: [],
    ok: true,
    roots: [],
  });
  expect(inspected).toBe(0);
});

test('operation recorder failure does not mask a known target result', async () => {
  const { wiring } = fixture({
    events: {
      list: () => ({ events: [], ok: true }),
      record: () => Promise.reject(new Error('state unavailable')),
    },
  });
  await expect(
    wiring.cachePrepare({ name: 'topic', repo: 'r' })
  ).resolves.toMatchObject({ ok: true, outcomeRecorded: false });
});

test('wiring requires a recorder acknowledgment and records saved global actions', async () => {
  const { wiring } = fixture({
    events: {
      list: () => ({ events: [], ok: true }),
      record: async () => undefined,
    },
  });
  expect(await wiring.cachePrepare({ name: 'topic', repo: 'r' })).toMatchObject(
    { ok: true, outcomeRecorded: false }
  );
  const normal = fixture();
  expect(await normal.wiring.saveMcpAction({ source: 'mcp' })).toMatchObject({
    ok: true,
    operationId: 'operation-1',
  });
  expect(normal.events.at(-1)).toMatchObject({
    kind: 'mcp-action-save',
    source: 'mcp',
    state: 'completed',
    target: null,
  });
});

test('a selected worktree filters the durable event query before its result limit', () => {
  const events = createOperationEvents({
    state: {
      read: () => ({
        events: ['topic', 'other'].map((name, index) => ({
          at: index + 1,
          id: name,
          kind: 'start',
          source: 'ui',
          state: 'completed',
          target: { name, repo: 'r' },
        })),
      }),
      update: () => Promise.resolve(),
    },
  });
  const { wiring } = fixture({ events });
  expect(
    wiring.operations({ limit: 1, name: 'topic', repo: 'r' })
  ).toMatchObject({ events: [{ id: 'topic' }], ok: true });
});

test('the composed session lister and end result never expose the capability digest or replaced ids', async () => {
  const record = {
    id: 'session-a',
    launchProofDigest: 'f'.repeat(64),
    name: 'topic',
    nativeConversation: {
      boundAt: 5,
      history: [{ boundAt: 1, id: 'native-old', replacedAt: 5 }],
      id: 'native-now',
      provider: 'claude-code',
    },
    repo: 'r',
    state: 'running',
    tool: 'claude-code',
  };
  const { wiring } = fixture({
    sessions: {
      end: async () => ({ ok: false, session: record }),
      list: () => [record],
      reconcile: async () => ({ ok: true }),
      register: async () => ({ ok: true }),
    },
  });
  const listed = wiring.agentSessions({});
  const ended = await wiring.endAgentSession({
    checkoutIdentity: {},
    name: 'topic',
    repo: 'r',
    sessionId: 'session-a',
  });
  for (const output of [listed, ended]) {
    const text = JSON.stringify(output);
    expect(text).not.toContain('launchProofDigest');
    expect(text).not.toContain('native-old');
    expect(text).toContain('native-now');
  }
});
