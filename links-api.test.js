import { Database } from 'bun:sqlite';
import { afterEach, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
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
import { createLinksClient } from './links-client.js';
import { ensureEngine } from './links-engine-fixture.js';
import { canonicalCheckout } from './links-service.js';
import { handleMcpRequest, initMcpServer } from './mcp-server.js';
import { createPortalRuntime } from './portal.js';
import { PORTAL_API_ROUTES } from './portal-routes.js';
import { createWorkspaceState } from './workspace-state.js';
import { claimWriter } from './writer-claims.js';

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

async function portal(root, sessions = [baseSession], extra = {}) {
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
    linksEngine: extra.linksEngine ?? ENGINE,
    linksRoot: join(root, 'links'),
    linksTarget: (repo, name) =>
      repo === 'repo' && (name === 'topic' || name === 'other')
        ? { checkoutIdentity, name, repo }
        : null,
    managedAgents: {
      dispose: () => Promise.resolve(),
      listSessions:
        extra.listSessions ?? (() => Promise.resolve({ ok: true, sessions })),
      recover: () => Promise.resolve(),
      ...extra.managedAgents,
    },
    ...(extra.initializeMcp ? { initializeMcp: extra.initializeMcp } : {}),
    observeProcess: () => Promise.resolve({ state: 'unknown' }),
    port: 43_211,
    ...(extra.registry
      ? {
          loadProjects: () => state.read('projects'),
          removeProject: (_workspace, name) =>
            state.update('projects', (projects) => {
              const { [name]: _removed, ...rest } = projects;
              return rest;
            }),
        }
      : { projects: { repo: { label: 'repo' } } }),
    reconcileDevServers: () => Promise.resolve(),
    reconcileTriggerSidecars: () => Promise.resolve(),
    routing: { syncHosts: () => Promise.resolve() },
    seedSidecarApprovals: () => Promise.resolve(),
    serve: () => ({ stop: () => undefined }),
    spansRoot: join(root, 'spans'),
    state,
    timers: extra.timers ?? {
      clearInterval: () => undefined,
      setInterval: () => 1,
    },
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
  return {
    dispose: () => runtime.dispose(),
    get,
    post,
    request,
    runtime,
    state,
  };
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
    'GET /api/links/capabilities',
    'GET /api/links/directory',
    'GET /api/links/inbox',
    'GET /api/links/message',
    'GET /api/links/share/status',
    'GET /api/links/status',
    'POST /api/links/ack',
    'POST /api/links/attention/open',
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
    'POST /api/links/send-now',
    'POST /api/links/share/attention',
    'POST /api/links/share/disable',
    'POST /api/links/share/enable',
  ]);
  // Listing everything shared is a complete request; every other route needs its target.
  const listings = new Set([
    '/api/links/capabilities',
    '/api/links/directory',
    '/api/links/share/status',
    '/api/links/recovery',
  ]);
  for (const route of links) {
    // biome-ignore lint/performance/noAwaitInLoops: Requests share one portal.
    const response = await api.request(route.path, {
      body: route.methods[0] === 'POST' ? '{}' : undefined,
      headers: { 'content-type': 'application/json' },
      method: route.methods[0],
    });
    expect(await response.json()).toMatchObject(
      listings.has(route.path)
        ? { ok: true }
        : { code: 'LINKS_INVALID', ok: false }
    );
  }
  for (const hookOnly of [
    'claim',
    'confirm',
    'attention',
    'attention/send',
    'attention/raise',
  ]) {
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

// ── sharing and the directory ──────────────────────────────────────────────────────────────────────

const enableOver = async (api, repo = 'repo') => {
  const review = await api.post('/api/links/share/enable', { repo });
  expect(review).toMatchObject({
    code: 'LINKS_CONFIRMATION_REQUIRED',
    ok: false,
  });
  return api.post('/api/links/share/enable', {
    confirmation: review.confirmation.token,
    repo,
  });
};

test('enabling over HTTP shows the fields first, lists the project’s sessions after, and withdraws on disable', async () => {
  const root = workspace();
  const api = await portal(root);
  const review = await api.post('/api/links/share/enable', { repo: 'repo' });
  expect(review.confirmation.fields.map((field) => field.field)).toEqual([
    'owner',
    'task',
    'reachability',
    'freshness',
    'session',
  ]);
  expect(existsSync(join(root, 'links'))).toBe(false);
  expect(await api.get('/api/links/directory')).toMatchObject({
    entries: [],
    ok: true,
  });

  expect(await enableOver(api)).toMatchObject({
    changed: true,
    ok: true,
    presence: { published: 1 },
  });
  const listed = await api.get('/api/links/directory');
  expect(listed.entries).toHaveLength(1);
  expect(listed.entries[0]).toMatchObject({
    project: 'repo',
    reachability: { state: 'reachable' },
    sessionId: 'session-1',
    stale: false,
  });
  expect(
    await api.get(`/api/links/share/status${query({ repo: 'repo' })}`)
  ).toMatchObject({ shared: true, state: 'enabled' });

  expect(
    await api.post('/api/links/share/disable', { repo: 'repo' })
  ).toMatchObject({
    ok: true,
    removed: true,
  });
  expect((await api.get('/api/links/directory')).entries).toEqual([]);
});

test('a portal restart keeps the policy and the engine still decides for other principals', async () => {
  const root = workspace();
  let api = await portal(root);
  await enableOver(api);
  await api.dispose();
  runtimes.length = 0;

  api = await portal(root);
  expect(
    await api.get(`/api/links/share/status${query({ repo: 'repo' })}`)
  ).toMatchObject({ shared: true });
  const engine = createLinksClient({
    dataDir: join(root, 'links'),
    enginePath: ENGINE,
  });
  const deposit = (key) =>
    engine.call('send', {
      body: 'from a session',
      idempotency_key: key,
      project: 'repo',
      recipient: {
        checkout: 'c',
        native_id: 'native-a',
        provider: 'claude-code',
        session_hint: 'session-1',
      },
      sender: { id: 'other-session', kind: 'session' },
    });
  expect((await deposit('k1')).ok).toBe(true);
  await api.post('/api/links/share/disable', { repo: 'repo' });
  expect(await deposit('k2')).toMatchObject({ code: 'LINKS_NOT_SHARED' });
});

test('a corrupt policy is reported over HTTP as recoverable and the route recovers on disable', async () => {
  const root = workspace();
  const api = await portal(root);
  await enableOver(api);
  const db = new Database(join(root, 'links', 'mailbox.sqlite3'));
  db.run('UPDATE sharing_policies SET version = 99');
  db.close();

  expect(
    await api.get(`/api/links/share/status${query({ repo: 'repo' })}`)
  ).toMatchObject({
    code: 'LINKS_POLICY_INVALID',
    ok: false,
    reason: 'unsupported-version',
  });
  const listed = await api.get('/api/links/directory');
  expect(listed.entries).toEqual([]);
  expect(listed.problems[0]).toMatchObject({ code: 'LINKS_POLICY_INVALID' });
  expect(
    await api.post('/api/links/share/disable', { repo: 'repo' })
  ).toMatchObject({
    ok: true,
    removed: true,
  });
  expect(
    await api.get(`/api/links/share/status${query({ repo: 'repo' })}`)
  ).toMatchObject({ ok: true, shared: false });
});

test('enabling or disabling leaves the worktree’s writer claim and resource admission exactly as they were, and the claim supplies the task', async () => {
  const root = workspace();
  const checkout = join(root, 'checkout');
  mkdirSync(checkout);
  execFileSync('git', ['init', '--quiet', checkout]);
  claimWriter(checkout, {
    agent: 'claude-code',
    pid: process.pid,
    session: 'session-1',
    task: 'Fix the login redirect',
  });
  const claimFile = join(checkout, '.git', 'setu-writer.json');
  const claimBefore = readFileSync(claimFile, 'utf8');

  const api = await portal(root, [{ ...baseSession, checkoutPath: checkout }]);
  const admissionBefore = await api.get('/api/resource-admission');
  await enableOver(api);
  const listed = await api.get('/api/links/directory');
  expect(listed.entries[0].task).toBe('Fix the login redirect');
  expect(JSON.stringify(listed)).not.toContain(checkout);
  await api.post('/api/links/share/disable', { repo: 'repo' });

  expect(readFileSync(claimFile, 'utf8')).toBe(claimBefore);
  expect(await api.get('/api/resource-admission')).toEqual(admissionBefore);
});

test('another session’s writer claim is not offered as this session’s task', async () => {
  const root = workspace();
  const checkout = join(root, 'checkout');
  mkdirSync(checkout);
  execFileSync('git', ['init', '--quiet', checkout]);
  claimWriter(checkout, {
    agent: 'codex',
    pid: process.pid,
    session: 'someone-else',
    task: 'Not yours',
  });
  const api = await portal(root, [{ ...baseSession, checkoutPath: checkout }]);
  await enableOver(api);
  expect((await api.get('/api/links/directory')).entries[0].task).toBeNull();
});

test('presence is published by an interval the portal owns, which stops when the portal is disposed', async () => {
  const root = workspace();
  const intervals = [];
  const cleared = [];
  const timers = {
    clearInterval: (id) => cleared.push(id),
    setInterval: (callback, ms) => {
      intervals.push({ callback, ms });
      return intervals.length;
    },
  };
  const sessions = [{ ...baseSession }];
  const api = await portal(root, sessions, { timers });
  const presence = intervals.find((entry) => entry.ms === 30_000);
  expect(presence).toBeDefined();

  // Nothing is shared: a round writes nothing and creates no store.
  await presence.callback();
  expect(existsSync(join(root, 'links'))).toBe(false);

  await enableOver(api);
  sessions.push({ ...baseSession, id: 'session-2' });
  await presence.callback();
  expect(
    (await api.get('/api/links/directory')).entries.map(
      (entry) => entry.sessionId
    )
  ).toEqual(['session-1', 'session-2']);

  await api.dispose();
  runtimes.length = 0;
  expect(cleared).toContain(intervals.indexOf(presence) + 1);
  // A round after disposal does nothing, whoever calls it.
  sessions.push({ ...baseSession, id: 'session-3' });
  await presence.callback();
  const after = await portal(root, sessions);
  expect(
    (await after.get('/api/links/directory')).entries.map(
      (entry) => entry.sessionId
    )
  ).toEqual(['session-1', 'session-2']);
});

test('a presence round that fails never escapes the interval or overlaps itself', async () => {
  const root = workspace();
  const intervals = [];
  const timers = {
    clearInterval: () => undefined,
    setInterval: (callback, ms) => {
      intervals.push({ callback, ms });
      return intervals.length;
    },
  };
  let calls = 0;
  let list = () => Promise.resolve({ ok: true, sessions: [baseSession] });
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const api = await portal(root, [baseSession], {
    listSessions: () => {
      calls += 1;
      return list();
    },
    timers,
  });
  await enableOver(api);
  const presence = intervals.find((entry) => entry.ms === 30_000);
  calls = 0;
  list = async () => {
    await gate;
    throw new Error('boom');
  };
  const first = presence.callback();
  const second = presence.callback();
  release();
  await expect(Promise.all([first, second])).resolves.toBeDefined();
  expect(calls).toBe(1);
  // The next round runs again.
  list = () => Promise.resolve({ ok: true, sessions: [baseSession] });
  await presence.callback();
  expect(calls).toBe(2);
});

// ── removing and re-adding a project ───────────────────────────────────────────────────────────────

const registerRepo = (state) =>
  state.update('projects', (projects) => ({
    ...projects,
    repo: { base: 3000, label: 'repo', slug: '' },
  }));
const registered = (state) => Object.hasOwn(state.read('projects'), 'repo');
const scopeOf = async (root) => {
  const engine = createLinksClient({
    dataDir: join(root, 'links'),
    enginePath: ENGINE,
  });
  const status = await engine.call('share_status', { project: 'repo' });
  return status.result.projects[0].policy?.scope ?? null;
};

test('removing a project through the portal withdraws its sharing, and adding it again starts from nothing', async () => {
  const root = workspace();
  const checkout = join(root, 'checkout');
  mkdirSync(checkout);
  execFileSync('git', ['init', '--quiet', checkout]);
  claimWriter(checkout, {
    agent: 'claude-code',
    pid: process.pid,
    session: 'session-1',
    task: 'Fix the login redirect',
  });
  const claimFile = join(checkout, '.git', 'setu-writer.json');
  const claimBefore = readFileSync(claimFile, 'utf8');
  const api = await portal(root, [{ ...baseSession, checkoutPath: checkout }], {
    registry: true,
  });
  await registerRepo(api.state);
  await enableOver(api);
  const firstScope = await scopeOf(root);
  expect((await api.get('/api/links/directory')).entries).toHaveLength(1);
  const admissionBefore = await api.get('/api/resource-admission');

  const removed = await api.post('/api/project/remove', { name: 'repo' });
  expect(removed).toMatchObject({ ok: true });
  expect(registered(api.state)).toBe(false);
  expect(await scopeOf(root)).toBeNull();
  expect((await api.get('/api/links/directory')).entries).toEqual([]);
  expect(readFileSync(claimFile, 'utf8')).toBe(claimBefore);
  expect(await api.get('/api/resource-admission')).toEqual(admissionBefore);

  // The name comes back: nothing is shared until the user confirms again, and the scope is new.
  await registerRepo(api.state);
  expect(
    await api.get(`/api/links/share/status${query({ repo: 'repo' })}`)
  ).toMatchObject({ shared: false });
  expect((await api.get('/api/links/directory')).entries).toEqual([]);
  expect(
    await api.post('/api/links/share/enable', { repo: 'repo' })
  ).toMatchObject({ code: 'LINKS_CONFIRMATION_REQUIRED' });
  expect(await enableOver(api)).toMatchObject({ ok: true });
  expect(await scopeOf(root)).not.toBe(firstScope);
});

test('a project whose sharing cannot be confirmed withdrawn is not removed', async () => {
  const root = workspace();
  const first = await portal(root, [baseSession], { registry: true });
  await registerRepo(first.state);
  await enableOver(first);
  const scope = await scopeOf(root);
  await first.dispose();
  runtimes.length = 0;

  const broken = join(root, 'broken-engine');
  writeFileSync(broken, '#!/bin/sh\nexit 1\n', { mode: 0o755 });
  const api = await portal(root, [baseSession], {
    linksEngine: broken,
    registry: true,
  });
  const refused = await api.post('/api/project/remove', { name: 'repo' });
  expect(refused).toMatchObject({ code: 'LINKS_OUTCOME_UNKNOWN', ok: false });
  expect(refused.error).toContain('was not removed');
  expect(registered(api.state)).toBe(true);
  await api.dispose();
  runtimes.length = 0;

  // The policy is exactly as it was, and with the engine back the removal goes through.
  expect(await scopeOf(root)).toBe(scope);
  const again = await portal(root, [baseSession], { registry: true });
  expect(
    await again.post('/api/project/remove', { name: 'repo' })
  ).toMatchObject({
    ok: true,
  });
  expect(registered(again.state)).toBe(false);
});

test('removing a project nothing was ever shared for needs no engine at all', async () => {
  const root = workspace();
  const api = await portal(root, [baseSession], {
    linksEngine: join(root, 'no-such-engine'),
    registry: true,
  });
  await registerRepo(api.state);
  expect(await api.post('/api/project/remove', { name: 'repo' })).toMatchObject(
    {
      ok: true,
    }
  );
  expect(registered(api.state)).toBe(false);
  expect(existsSync(join(root, 'links'))).toBe(false);
});

test('a project that has left the registry is not listed or published even if its policy remains', async () => {
  const root = workspace();
  const intervals = [];
  const api = await portal(root, [baseSession], {
    registry: true,
    timers: {
      clearInterval: () => undefined,
      setInterval: (callback, ms) => {
        intervals.push({ callback, ms });
        return intervals.length;
      },
    },
  });
  await registerRepo(api.state);
  await enableOver(api);
  // The registry is edited behind the portal's back (not through the supported removal).
  await api.state.update('projects', () => ({}));
  expect((await api.get('/api/links/directory')).entries).toEqual([]);
  expect(
    await api.get(`/api/links/share/status${query({ repo: 'repo' })}`)
  ).toMatchObject({ registered: false, shared: true });
  const presence = intervals.find((timer) => timer.ms === 30_000);
  await presence.callback();
  await registerRepo(api.state);
  const [entry] = (await api.get('/api/links/directory')).entries;
  expect(entry.sessionId).toBe('session-1');
  expect(entry.observedAt).toBeLessThan(Date.now());
});

test('a writer claim that has gone stale still shows its task, marked old', async () => {
  const root = workspace();
  const checkout = join(root, 'checkout');
  mkdirSync(checkout);
  execFileSync('git', ['init', '--quiet', checkout]);
  claimWriter(checkout, {
    agent: 'claude-code',
    pid: process.pid,
    session: 'session-1',
    task: 'Fix the login redirect',
  });
  // Three hours without a heartbeat, held by a process that no longer exists: the claim is stale.
  const dead = Bun.spawnSync(['true']).pid;
  const claimFile = join(checkout, '.git', 'setu-writer.json');
  const heartbeat = Date.now() - 3 * 60 * 60 * 1000;
  const claim = JSON.parse(readFileSync(claimFile, 'utf8'));
  writeFileSync(
    claimFile,
    JSON.stringify({
      ...claim,
      heartbeat: new Date(heartbeat).toISOString(),
      pid: dead,
    })
  );

  const api = await portal(root, [{ ...baseSession, checkoutPath: checkout }]);
  await enableOver(api);
  const [entry] = (await api.get('/api/links/directory')).entries;
  expect(entry).toMatchObject({
    task: 'Fix the login redirect',
    taskAt: heartbeat,
    taskStale: true,
  });
  expect(entry.stale).toBe(false);
});

test('removing a project whose registered name the engine cannot hold still works', async () => {
  const root = workspace();
  const api = await portal(root, [baseSession], { registry: true });
  // Another project is shared, so the engine has a store and a withdrawal really is asked for.
  await registerRepo(api.state);
  await enableOver(api);
  for (const name of ['a\u007fb', 'a\u0085b']) {
    // biome-ignore lint/performance/noAwaitInLoops: Calls share one portal.
    await api.state.update('projects', (projects) => ({
      ...projects,
      [name]: { base: 3100, label: name, slug: '' },
    }));
    expect(await api.post('/api/project/remove', { name })).toMatchObject({
      ok: true,
    });
    expect(Object.hasOwn(api.state.read('projects'), name)).toBe(false);
  }
});

// ---- attention requests and Send now over the front doors ----

const checkoutOf = canonicalCheckout(checkoutIdentity);
const NO_ATTENTION_ENTRY = /wake|sendNow|attentionOpen|attentionSend|raise/i;

// The engine's own operation, standing in for the session tools that will call the trusted ingress. Nothing
// reachable over HTTP, the CLI or MCP can do this.
async function raiseThroughEngine(
  root,
  key,
  body = 'the build needs you',
  { hint = 'session-1', native = 'native-a' } = {}
) {
  const client = createLinksClient({
    dataDir: join(root, 'links'),
    enginePath: ENGINE,
  });
  return await client.call('attention_send', {
    body,
    idempotency_key: key,
    project: 'repo',
    recipient: {
      checkout: checkoutOf,
      native_id: native,
      provider: 'claude-code',
      session_hint: hint,
    },
    sender: { id: 'session-other', kind: 'session' },
  });
}

async function optIn(api) {
  const review = await api.post('/api/links/share/attention', {
    enabled: true,
    repo: 'repo',
  });
  expect(review).toMatchObject({
    code: 'LINKS_CONFIRMATION_REQUIRED',
    ok: false,
  });
  return await api.post('/api/links/share/attention', {
    confirmation: review.confirmation.token,
    enabled: true,
    repo: 'repo',
  });
}

function focusing() {
  const calls = [];
  return {
    calls,
    managedAgents: {
      focus: (input) => {
        calls.push(input);
        return Promise.resolve({
          action: 'focus',
          ok: true,
          sessionId: input.sessionId,
        });
      },
      listAttention: () =>
        Promise.resolve({
          events: [
            {
              at: 1,
              expiresAt: 2,
              kind: 'permission',
              provider: 'claude-code',
              sessionId: 'session-1',
              state: 'permission',
            },
          ],
          ok: true,
        }),
    },
  };
}

test('attention is reviewed and enabled over HTTP, listed beside provider events, and opened through the exact focus', async () => {
  const root = workspace();
  const hooks = focusing();
  const api = await portal(root, [baseSession], {
    managedAgents: hooks.managedAgents,
  });
  await enableOver(api);
  // Off by default: the engine refuses a request until the person enabled it.
  expect((await raiseThroughEngine(root, 'k0')).code).toBe(
    'LINKS_ATTENTION_NOT_ENABLED'
  );
  expect(await optIn(api)).toMatchObject({
    changed: true,
    ok: true,
    policy: { attention: true },
  });

  const raised = await raiseThroughEngine(root, 'k1');
  expect(raised.ok).toBe(true);
  const listed = await api.get('/api/attention');
  expect(listed.events.map((event) => event.source ?? 'provider')).toEqual([
    'provider',
    'links',
  ]);
  const entry = listed.events.find((event) => event.source === 'links');
  expect(entry).toMatchObject({
    id: raised.result.attention_id,
    message: 'the build needs you',
    open: { available: true },
    sender: { id: 'session-other', kind: 'session' },
    target: { name: 'topic', repo: 'repo' },
  });
  expect(entry.sessionId).toBeUndefined();
  expect(listed.links.notifications.groups).toHaveLength(1);
  expect(
    (
      await api.get(`/api/attention${query({ name: 'other', repo: 'repo' })}`)
    ).events.filter((event) => event.source === 'links')
  ).toEqual([]);

  const opened = await api.post('/api/links/attention/open', {
    attentionId: entry.id,
  });
  expect(opened).toMatchObject({
    action: 'focus',
    ok: true,
    sessionId: 'session-1',
  });
  expect(hooks.calls).toHaveLength(1);
  expect(hooks.calls[0]).toMatchObject({
    expectConversation: { nativeId: 'native-a', provider: 'claude-code' },
    name: 'topic',
    repo: 'repo',
    sessionId: 'session-1',
  });
  expect(hooks.calls[0].source).toBeDefined();
});

test('the same request cannot be opened once its conversation was replaced, and nothing is focused', async () => {
  const root = workspace();
  const hooks = focusing();
  let sessions = [baseSession];
  const api = await portal(root, [baseSession], {
    listSessions: () => Promise.resolve({ ok: true, sessions }),
    managedAgents: hooks.managedAgents,
  });
  await enableOver(api);
  await optIn(api);
  const raised = await raiseThroughEngine(root, 'k1');
  sessions = [{ ...baseSession, nativeConversation: bound('native-new') }];
  expect(
    await api.post('/api/links/attention/open', {
      attentionId: raised.result.attention_id,
    })
  ).toMatchObject({ code: 'LINKS_CONVERSATION_REPLACED', ok: false });
  sessions = [{ ...baseSession, state: 'ended' }];
  expect(
    await api.post('/api/links/attention/open', {
      attentionId: raised.result.attention_id,
    })
  ).toMatchObject({ code: 'LINKS_SESSION_ENDED', ok: false });
  expect(hooks.calls).toEqual([]);
});

test('reading the attention list or the capabilities creates no store and sends no notification', async () => {
  const root = workspace();
  const hooks = focusing();
  const api = await portal(root, [baseSession], {
    managedAgents: hooks.managedAgents,
  });
  expect(await api.get('/api/attention')).toMatchObject({
    links: { state: 'ok' },
    ok: true,
  });
  expect(await api.get('/api/links/capabilities')).toMatchObject({
    ok: true,
    wake: { available: false, code: 'LINKS_WAKE_UNAVAILABLE' },
  });
  expect(existsSync(join(root, 'links'))).toBe(false);
  expect(hooks.calls).toEqual([]);
});

test('Send now answers the same stable code over HTTP and the CLI, and starts nothing', async () => {
  const root = workspace();
  const hooks = focusing();
  const api = await portal(root, [baseSession], {
    managedAgents: hooks.managedAgents,
  });
  const body = { ...target, messageId: 'm_1' };
  const http = await api.post('/api/links/send-now', body);
  expect(http).toMatchObject({
    code: 'LINKS_WAKE_UNAVAILABLE',
    ok: false,
    reason: 'no-verified-mechanism',
  });

  const out = [];
  const original = console.log;
  const originalError = console.error;
  console.log = (text) => out.push(String(text));
  console.error = () => undefined;
  let code;
  try {
    code = await runCli(
      [
        'links',
        'send-now',
        'repo',
        'topic',
        '--session',
        'session-1',
        '--message',
        'm_1',
        '--json',
      ],
      {
        request: async ({ body: requestBody, method, path }) =>
          (
            await api.request(path, {
              body:
                requestBody === undefined
                  ? undefined
                  : JSON.stringify(requestBody),
              headers: { 'content-type': 'application/json' },
              method,
            })
          ).json(),
      }
    );
  } finally {
    console.log = original;
    console.error = originalError;
  }
  expect(code).toBe(1);
  expect(JSON.parse(out.join('\n'))).toMatchObject({
    code: 'LINKS_WAKE_UNAVAILABLE',
    ok: false,
  });
  expect(hooks.calls).toEqual([]);
  expect(existsSync(join(root, 'links'))).toBe(false);
  // A body that names a principal, a tool or a flag is not a wake request, it is an invalid one.
  for (const extra of [
    { principal: { kind: 'session' } },
    { wake: true },
    { tool: 'send_session_message' },
  ]) {
    // biome-ignore lint/performance/noAwaitInLoops: Each refusal is checked against the same portal.
    const refused = await api.post('/api/links/send-now', {
      ...body,
      ...extra,
    });
    expect(refused).toMatchObject({ code: 'LINKS_INVALID', ok: false });
  }
});

test('the CLI reviews, enables and switches off attention and opens a request', async () => {
  const root = workspace();
  const hooks = focusing();
  const api = await portal(root, [baseSession], {
    managedAgents: hooks.managedAgents,
  });
  await enableOver(api);
  const cli = async (argv) => {
    const out = [];
    const original = console.log;
    const originalError = console.error;
    console.log = (text) => out.push(String(text));
    console.error = () => undefined;
    try {
      const code = await runCli([...argv, '--json'], {
        request: async ({ body, method, path }) =>
          (
            await api.request(path, {
              body: body === undefined ? undefined : JSON.stringify(body),
              headers: { 'content-type': 'application/json' },
              method,
            })
          ).json(),
      });
      return { code, result: JSON.parse(out.join('\n')) };
    } finally {
      console.log = original;
      console.error = originalError;
    }
  };
  const review = await cli(['links', 'share', 'attention', 'repo', 'on']);
  expect(review.code).toBe(1);
  expect(review.result).toMatchObject({ code: 'LINKS_CONFIRMATION_REQUIRED' });
  const on = await cli([
    'links',
    'share',
    'attention',
    'repo',
    'on',
    '--confirmation',
    review.result.confirmation.token,
  ]);
  expect(on).toMatchObject({ code: 0, result: { changed: true, ok: true } });

  const raised = await raiseThroughEngine(root, 'k1');
  const listed = await cli(['attention', 'list']);
  expect(listed.code).toBe(0);
  expect(listed.result.events.some((event) => event.source === 'links')).toBe(
    true
  );
  const opened = await cli([
    'links',
    'attention',
    'open',
    raised.result.attention_id,
  ]);
  expect(opened).toMatchObject({
    code: 0,
    result: { action: 'focus', ok: true },
  });

  const off = await cli(['links', 'share', 'attention', 'repo', 'off']);
  expect(off).toMatchObject({ code: 0, result: { changed: true, ok: true } });
  expect((await raiseThroughEngine(root, 'k2')).code).toBe(
    'LINKS_ATTENTION_NOT_ENABLED'
  );
});

// One real MCP tools/call through the server the portal initialised with its production dependencies.
async function mcpCall(name, argumentsObject = {}) {
  const response = await handleMcpRequest(
    new Request('http://localhost:2999/mcp', {
      body: JSON.stringify({
        id: 1,
        jsonrpc: '2.0',
        method: 'tools/call',
        params: { arguments: argumentsObject, name },
      }),
      headers: {
        accept: 'application/json, text/event-stream',
        'content-type': 'application/json',
        host: 'localhost:2999',
      },
      method: 'POST',
    })
  );
  return await response.text();
}

test('an agent reading attention over MCP sees who and when, never the message, and no tool opens or wakes', async () => {
  const root = workspace();
  const hooks = focusing();
  let deps;
  const api = await portal(root, [baseSession], {
    // The portal's own dependencies, handed to the real MCP server exactly as production does.
    initializeMcp: (given) => {
      deps = given;
      initMcpServer(given);
    },
    managedAgents: hooks.managedAgents,
  });
  await enableOver(api);
  await optIn(api);
  await raiseThroughEngine(root, 'k1', 'SECRET-MESSAGE-TEXT');
  const called = await mcpCall('list_attention');
  expect(called).toContain('session-other');
  expect(called).toContain('links-attention');
  expect(called).not.toContain('SECRET-MESSAGE-TEXT');
  // The same through the tool with a worktree filter.
  const filtered = await mcpCall('list_attention', {
    name: 'topic',
    repo: 'repo',
  });
  expect(filtered).toContain('session-other');
  expect(filtered).not.toContain('SECRET-MESSAGE-TEXT');
  // The portal's own reader does carry it.
  expect(JSON.stringify(await api.get('/api/attention'))).toContain(
    'SECRET-MESSAGE-TEXT'
  );
  // No dependency handed to MCP can open a request, send now, or raise one.
  for (const name of Object.keys(deps)) {
    expect(name).not.toMatch(NO_ATTENTION_ENTRY);
  }
});

test('over HTTP and the CLI, a request behind many newer ones for another worktree is reachable and paging is exact', async () => {
  const root = workspace();
  const hooks = focusing();
  const other = {
    ...baseSession,
    id: 'session-2',
    name: 'other',
    nativeConversation: bound('native-b'),
  };
  const api = await portal(root, [baseSession, other], {
    managedAgents: hooks.managedAgents,
  });
  await enableOver(api);
  await optIn(api);
  const mine = await raiseThroughEngine(root, 'mine', 'for topic');
  for (let n = 0; n < 5; n += 1) {
    // biome-ignore lint/performance/noAwaitInLoops: The requests arrive one after another.
    await raiseThroughEngine(root, `o${n}`, `for other ${n}`, {
      hint: 'session-2',
      native: 'native-b',
    });
  }
  const linksOf = (listed) =>
    listed.events.filter((event) => event.source === 'links');

  // The asked-about worktree's first page holds its request, though five newer ones belong elsewhere.
  const scoped = await api.get(
    `/api/attention${query({ limit: 2, name: 'topic', repo: 'repo' })}`
  );
  expect(linksOf(scoped).map((event) => event.id)).toEqual([
    mine.result.attention_id,
  ]);
  expect(scoped.links).toMatchObject({ hasMore: false, state: 'ok' });

  // The unscoped list pages by cursor; the provider's event is listed once, with the first page.
  const ids = [];
  let before;
  let provider = 0;
  for (let page = 0; page < 5; page += 1) {
    // biome-ignore lint/performance/noAwaitInLoops: Each page needs the cursor of the one before.
    const listed = await api.get(
      `/api/attention${query({ limit: 2, ...(before ? { before } : {}) })}`
    );
    provider += listed.events.filter(
      (event) => event.source !== 'links'
    ).length;
    ids.push(...linksOf(listed).map((event) => event.id));
    if (!listed.links.hasMore) {
      break;
    }
    before = listed.links.next;
  }
  expect(ids).toHaveLength(6);
  expect(new Set(ids).size).toBe(6);
  expect(provider).toBe(1);
  expect(await api.get(`/api/attention${query({ limit: 'x' })}`)).toMatchObject(
    {
      code: 'LINKS_INVALID',
      ok: false,
    }
  );

  // The CLI pages the same way: the second page by the first page's cursor is the page HTTP gives.
  const firstPage = await api.get(`/api/attention${query({ limit: 2 })}`);
  const cursor = firstPage.links.next;
  const second = await api.get(
    `/api/attention${query({ before: cursor, limit: 2 })}`
  );
  const out = [];
  const original = console.log;
  console.log = (text) => out.push(String(text));
  try {
    const code = await runCli(
      ['attention', 'list', '--limit', '2', '--before', cursor, '--json'],
      {
        request: async ({ body, method, path }) =>
          (
            await api.request(path, {
              body: body === undefined ? undefined : JSON.stringify(body),
              headers: { 'content-type': 'application/json' },
              method,
            })
          ).json(),
      }
    );
    expect(code).toBe(0);
  } finally {
    console.log = original;
  }
  const paged = JSON.parse(out.join('\n'));
  expect(linksOf(paged).map((event) => event.id)).toEqual(
    linksOf(second).map((event) => event.id)
  );
  expect(linksOf(paged)).toHaveLength(2);
  expect(
    linksOf(paged).some((event) =>
      linksOf(firstPage)
        .map((e) => e.id)
        .includes(event.id)
    )
  ).toBe(false);
  expect(paged.events.every((event) => event.source === 'links')).toBe(true);
});

test('a worktree with very many sessions is listed completely, and one too large to name says so instead of being cut', async () => {
  const root = workspace();
  const hooks = focusing();
  const crowd = (count, prefix) =>
    Array.from({ length: count }, (_, n) => ({
      ...baseSession,
      id: `${prefix}${n}`,
      name: 'other',
      nativeConversation: bound(`native-${prefix}${n}`),
    }));
  // 300 sessions in one worktree, the request addressed to the last of them.
  const api = await portal(root, [baseSession, ...crowd(300, 's')], {
    managedAgents: hooks.managedAgents,
  });
  await enableOver(api);
  await optIn(api);
  await raiseThroughEngine(root, 'last', 'for the last of many', {
    hint: 's299',
    native: 'native-s299',
  });
  const scoped = await api.get(
    `/api/attention${query({ name: 'other', repo: 'repo' })}`
  );
  expect(
    scoped.events
      .filter((event) => event.source === 'links')
      .map((event) => event.message)
  ).toEqual(['for the last of many']);
  expect(JSON.stringify(scoped)).not.toContain('scopeLimited');

  // So many that naming them would exceed the engine's request bound: said plainly, never the first few.
  const huge = await portal(
    workspace(),
    [baseSession, ...crowd(9000, 'x'.repeat(118))],
    {
      managedAgents: hooks.managedAgents,
    }
  );
  const refused = await huge.get(
    `/api/attention${query({ name: 'other', repo: 'repo' })}`
  );
  expect(refused.ok).toBe(true);
  expect(refused.links).toMatchObject({
    code: 'LINKS_SCOPE_TOO_LARGE',
    state: 'unavailable',
  });
  expect(refused.links.error).toContain('setu attention list');
  expect(refused.events.filter((event) => event.source === 'links')).toEqual(
    []
  );
  // The unscoped list is the recovery and leaves nothing out.
  expect((await huge.get('/api/attention')).links).toMatchObject({
    state: 'ok',
  });
});
