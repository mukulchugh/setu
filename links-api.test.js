import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCli } from './cli.js';
import { createLinksClient } from './links-client.js';
import { ensureEngine } from './links-engine-fixture.js';
import { handleMcpRequest, initMcpServer } from './mcp-server.js';
import { createPortalRuntime } from './portal.js';
import { PORTAL_API_ROUTES } from './portal-routes.js';
import { createWorkspaceState } from './workspace-state.js';

// Built before any test runs so a first compile is never charged to a test's own time limit.
const ENGINE = ensureEngine();
const LINKS_WORDS = /links?\b|redeliver|mailbox|inbox/i;

const checkoutIdentity = {
  checkout: { birthtimeNs: '1', dev: '2', ino: '3' },
  known: true,
};
const bound = (id) => ({
  boundAt: 1,
  id,
  provider: 'claude-code',
  state: 'bound',
});
const baseSession = {
  checkoutIdentity,
  id: 'session-1',
  name: 'topic',
  nativeConversation: bound('native-a'),
  ownership: 'owned',
  repo: 'repo',
  state: 'running',
  tool: 'claude-code',
};

const initialExitCode = process.exitCode ?? 0;
const roots = [];
const runtimes = [];
afterEach(async () => {
  process.exitCode = initialExitCode;
  for (const runtime of runtimes.splice(0)) {
    // biome-ignore lint/performance/noAwaitInLoops: Runtimes share one temporary root.
    await runtime.dispose();
  }
  for (const root of roots.splice(0)) {
    rmSync(root, { force: true, recursive: true });
  }
});

function workspace() {
  const root = mkdtempSync(join(tmpdir(), 'links-api-'));
  roots.push(root);
  return root;
}

async function portal(root, sessions = [baseSession]) {
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
    linksEngine: ENGINE,
    linksRoot: join(root, 'links'),
    linksTarget: (repo, name) =>
      repo === 'repo' && name === 'topic'
        ? { checkoutIdentity, name, repo }
        : null,
    managedAgents: {
      dispose: () => Promise.resolve(),
      listSessions: () => Promise.resolve({ ok: true, sessions }),
      recover: () => Promise.resolve(),
    },
    observeProcess: () => Promise.resolve({ state: 'unknown' }),
    port: 43_211,
    projects: {},
    reconcileDevServers: () => Promise.resolve(),
    reconcileTriggerSidecars: () => Promise.resolve(),
    routing: { syncHosts: () => Promise.resolve() },
    seedSidecarApprovals: () => Promise.resolve(),
    serve: () => ({ stop: () => undefined }),
    spansRoot: join(root, 'spans'),
    state,
    timers: { clearInterval: () => undefined, setInterval: () => 1 },
  });
  await runtime.start();
  runtimes.push(runtime);
  const server = {
    requestIP: () => ({ address: '127.0.0.1' }),
    timeout: () => undefined,
  };
  const request = (path, init) =>
    runtime.handle(new Request(`http://localhost:43211${path}`, init), server);
  const post = async (path, body) =>
    (
      await request(path, {
        body: JSON.stringify(body),
        headers: { 'content-type': 'application/json' },
        method: 'POST',
      })
    ).json();
  const get = async (path) => (await request(path)).json();
  return { dispose: () => runtime.dispose(), get, post, request, runtime };
}

const target = { name: 'topic', repo: 'repo', sessionId: 'session-1' };
const query = (values) => `?${new URLSearchParams(values)}`;

test('a message sent through the portal is durable across a portal restart and shows its true status', async () => {
  const root = workspace();
  const first = await portal(root);
  const sent = await first.post('/api/links/send', {
    ...target,
    body: 'hello there',
    idempotencyKey: 'key-1',
  });
  expect(sent).toMatchObject({ ok: true, replayed: false, state: 'queued' });
  await first.dispose();
  runtimes.length = 0;

  const second = await portal(root);
  const inbox = await second.get(`/api/links/inbox${query(target)}`);
  expect(inbox.messages).toHaveLength(1);
  expect(inbox.messages[0]).toMatchObject({
    messageId: sent.messageId,
    state: 'queued',
  });
  expect(
    await second.get(`/api/links/status${query({ messageId: sent.messageId })}`)
  ).toMatchObject({
    attempts: 0,
    state: 'queued',
  });
});

// Redelivery accepts a possible duplicate, so it is the receiving user's choice: no agent tool may offer it.
test('no MCP tool exposes Links mail, acknowledgement or redelivery to an agent', async () => {
  initMcpServer({});
  const response = await handleMcpRequest(
    new Request('http://localhost:2999/mcp', {
      body: JSON.stringify({
        id: 1,
        jsonrpc: '2.0',
        method: 'tools/list',
        params: {},
      }),
      headers: {
        accept: 'application/json, text/event-stream',
        'content-type': 'application/json',
        host: 'localhost:2999',
      },
      method: 'POST',
    })
  );
  const body = await response.text();
  const listed = JSON.parse(
    body.startsWith('event:')
      ? body
          .split('\n')
          .find((line) => line.startsWith('data: '))
          .slice(6)
      : body
  ).result.tools;
  expect(listed.length).toBeGreaterThan(10);
  expect(
    listed.filter((tool) =>
      LINKS_WORDS.test(`${tool.name} ${tool.description}`)
    )
  ).toEqual([]);
});

test('every registered Links route is served, and the hook-only operations are not routes', async () => {
  const api = await portal(workspace());
  const links = PORTAL_API_ROUTES.filter((route) =>
    route.path.startsWith('/api/links/')
  );
  expect(
    links.map((route) => `${route.methods[0]} ${route.path}`).sort()
  ).toEqual([
    'GET /api/links/associations',
    'GET /api/links/associations/preview',
    'GET /api/links/evidence/preview',
    'GET /api/links/inbox',
    'GET /api/links/message',
    'GET /api/links/projection/status',
    'GET /api/links/recovery',
    'GET /api/links/status',
    'POST /api/links/ack',
    'POST /api/links/associations/approve',
    'POST /api/links/associations/revoke',
    'POST /api/links/cancel',
    'POST /api/links/evidence/attach',
    'POST /api/links/redeliver',
    'POST /api/links/send',
  ]);
  for (const route of links) {
    // A recovery listing is a valid request with no arguments; it is exercised
    // against an engine that supports run-linked listing, not here.
    if (route.path === '/api/links/recovery') {
      continue;
    }
    // biome-ignore lint/performance/noAwaitInLoops: Requests share one portal.
    const response = await api.request(route.path, {
      body: route.methods[0] === 'POST' ? '{}' : undefined,
      headers: { 'content-type': 'application/json' },
      method: route.methods[0],
    });
    expect(await response.json()).toMatchObject({
      code: 'LINKS_INVALID',
      ok: false,
    });
  }
  for (const hookOnly of ['claim', 'confirm']) {
    // biome-ignore lint/performance/noAwaitInLoops: Requests share one portal.
    const response = await api.request(`/api/links/${hookOnly}`, {
      body: '{}',
      method: 'POST',
    });
    expect(response.status).toBe(404);
  }
});

test('a refused send over HTTP says why and stores nothing', async () => {
  const api = await portal(workspace(), [
    { ...baseSession, nativeConversation: { state: 'unbound' } },
  ]);
  expect(
    await api.post('/api/links/send', {
      ...target,
      body: 'hi',
      idempotencyKey: 'k',
    })
  ).toMatchObject({
    code: 'LINKS_NO_NATIVE_BINDING',
    ok: false,
  });
  expect((await api.get(`/api/links/inbox${query(target)}`)).messages).toEqual(
    []
  );
});

test('acknowledge and redeliver go through the portal once the hook has claimed the mail', async () => {
  const root = workspace();
  const api = await portal(root);
  const sent = await api.post('/api/links/send', {
    ...target,
    body: 'one',
    idempotencyKey: 'k1',
  });

  // The provider hook (a later ticket) is the only caller of claim and confirm.
  const checkout =
    '{"checkout":{"birthtimeNs":"1","dev":"2","ino":"3"},"known":true}';
  const hook = createLinksClient({
    dataDir: join(root, 'links'),
    enginePath: ENGINE,
  });
  const claim = await hook.call('claim', {
    recipient: {
      checkout,
      native_id: 'native-a',
      provider: 'claude-code',
      session_hint: 'session-1',
    },
  });
  expect(claim.result.messages).toHaveLength(1);
  expect(
    await api.get(`/api/links/status${query({ messageId: sent.messageId })}`)
  ).toMatchObject({
    state: 'handoff-unknown',
  });

  const redeliverRequest = {
    ...target,
    attemptId: claim.result.attempt_id,
    messageId: sent.messageId,
  };
  const reviewed = await api.post('/api/links/redeliver', redeliverRequest);
  expect(reviewed).toMatchObject({
    code: 'LINKS_CONFIRMATION_REQUIRED',
    ok: false,
  });
  expect(
    await api.get(`/api/links/status${query({ messageId: sent.messageId })}`)
  ).toMatchObject({ state: 'handoff-unknown' });
  const redelivered = await api.post('/api/links/redeliver', {
    ...redeliverRequest,
    confirmation: reviewed.confirmation.token,
  });
  expect(redelivered).toMatchObject({ ok: true, state: 'queued' });
  const second = await hook.call('claim', {
    recipient: {
      checkout,
      native_id: 'native-a',
      provider: 'claude-code',
      session_hint: 'session-1',
    },
  });
  await hook.call('confirm', {
    attempt_id: second.result.attempt_id,
    recipient: {
      checkout,
      native_id: 'native-a',
      provider: 'claude-code',
      session_hint: 'session-1',
    },
  });
  expect(
    await api.post('/api/links/ack', { ...target, messageId: sent.messageId })
  ).toMatchObject({
    ok: true,
    state: 'acknowledged',
  });
  expect(
    await api.get(`/api/links/message${query({ messageId: sent.messageId })}`)
  ).toMatchObject({
    attempts: 2,
    body: 'one',
    redeliveries: 1,
    state: 'acknowledged',
  });
});

test('the portal shows a replaced conversation as held, and restores it on an exact resume, across a restart', async () => {
  const root = workspace();
  const sessions = [{ ...baseSession }];
  let api = await portal(root, sessions);
  const sent = await api.post('/api/links/send', {
    ...target,
    body: 'for native-a',
    idempotencyKey: 'k1',
  });
  const statusPath = `/api/links/status${query({ messageId: sent.messageId })}`;

  sessions[0].nativeConversation = bound('native-b');
  expect(await api.get(statusPath)).toMatchObject({
    reason: 'conversation-replaced',
    state: 'held',
  });
  await api.dispose();
  runtimes.length = 0;

  api = await portal(root, sessions);
  expect(
    (await api.get(`/api/links/inbox${query(target)}`)).messages[0]
  ).toMatchObject({ state: 'held' });
  sessions[0].nativeConversation = bound('native-a');
  expect(await api.get(statusPath)).toMatchObject({
    reason: null,
    state: 'queued',
  });
});

test('the CLI, the portal and the engine agree from send to cancel, across a portal restart', async () => {
  const root = workspace();
  let api = await portal(root);
  const cli = async (argv, files = {}) => {
    const out = [];
    const original = console.log;
    const originalError = console.error;
    console.log = (text) => out.push(String(text));
    console.error = () => undefined;
    try {
      const code = await runCli(['links', ...argv, '--json'], {
        readFile: (path) => files[path],
        request: async ({ body, method, path }) =>
          (
            await api.request(path, {
              body: body === undefined ? undefined : JSON.stringify(body),
              headers: { 'content-type': 'application/json' },
              method,
            })
          ).json(),
      });
      return {
        code,
        result: out.length > 0 ? JSON.parse(out.join('\n')) : null,
      };
    } finally {
      console.log = original;
      console.error = originalError;
    }
  };

  const sent = await cli(
    [
      'send',
      'repo',
      'topic',
      '--session',
      'session-1',
      '--body-file',
      'note',
      '--idempotency-key',
      'cli-key',
    ],
    { note: 'review the migration' }
  );
  expect(sent).toMatchObject({
    code: 0,
    result: { ok: true, replayed: false, state: 'queued' },
  });
  const again = await cli(
    [
      'send',
      'repo',
      'topic',
      '--session',
      'session-1',
      '--body-file',
      'note',
      '--idempotency-key',
      'cli-key',
    ],
    { note: 'review the migration' }
  );
  expect(again.result).toMatchObject({
    messageId: sent.result.messageId,
    replayed: true,
  });

  await api.dispose();
  runtimes.length = 0;
  api = await portal(root);

  const inbox = await cli(['inbox', 'repo', 'topic', '--session', 'session-1']);
  expect(inbox.result.messages.map((message) => message.messageId)).toEqual([
    sent.result.messageId,
  ]);
  expect((await cli(['show', sent.result.messageId])).result.body).toBe(
    'review the migration'
  );
  expect(
    (await cli(['status', sent.result.messageId])).result.body
  ).toBeUndefined();
  expect((await cli(['cancel', sent.result.messageId])).result).toMatchObject({
    ok: true,
    state: 'cancelled',
  });
  const refused = await cli(['cancel', sent.result.messageId, 'extra']);
  expect(refused.code).toBe(1);
});
