// Sharing and the directory, through the Links service over the real engine binary and a real database.

import { Database } from 'bun:sqlite';
import { afterEach, expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createLinksClient } from './links-client.js';
import { ensureEngine, temporaryLinksRoot } from './links-engine-fixture.js';
import { createLinksService } from './links-service.js';

// Built before any test runs so a first compile is never charged to a test's own time limit.
const ENGINE = ensureEngine();
const HOOKS_ENGINE = ensureEngine({ hooks: true });

const cleanups = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) {
    cleanup();
  }
});

const checkoutIdentity = {
  checkout: { birthtimeNs: '1', dev: '2', ino: '3' },
  known: true,
};
const SECRET_PATH = '/Users/someone/very-private-checkout-path';
const SECRET_NATIVE = 'native-conversation-secret-id';

function session(overrides = {}) {
  return {
    checkoutIdentity,
    checkoutPath: SECRET_PATH,
    id: 'session-1',
    name: 'topic',
    nativeConversation: {
      boundAt: 1,
      id: SECRET_NATIVE,
      provider: 'claude-code',
      state: 'bound',
    },
    ownership: 'owned',
    pid: 4242,
    repo: 'repo',
    state: 'running',
    terminal: { id: 'terminal-secret' },
    tool: 'claude-code',
    ...overrides,
  };
}

function world(initial = [session()], { engine = ENGINE, now } = {}) {
  const { root, cleanup } = temporaryLinksRoot();
  cleanups.push(cleanup);
  const dataDir = join(root, 'links');
  const state = {
    projects: new Set(['repo', 'other']),
    sessions: initial,
    tasks: {},
  };
  const spawn = (command, options) =>
    Bun.spawn(command, {
      ...options,
      env: {
        ...process.env,
        ...(now ? { SETU_LINKS_TEST_NOW_MS: String(now()) } : {}),
      },
    });
  const make = () => {
    const client = createLinksClient({ dataDir, enginePath: engine, spawn });
    const service = createLinksService({
      client,
      defaultOwner: () => 'mukul',
      isProject: (repo) => state.projects.has(repo),
      resolveTarget: ({ repo, name }) =>
        name === 'topic' || name === 'topic-2'
          ? { checkoutIdentity, name, repo }
          : null,
      sessions: { list: () => ({ ok: true, sessions: state.sessions }) },
      taskLabel: (record) => state.tasks[record.id] ?? null,
    });
    return { client, service };
  };
  return { ...make(), dataDir, make, state };
}

const enable = async (service, repo = 'repo', extra = {}) => {
  const review = await service.shareEnable({ repo, ...extra });
  expect(review.code).toBe('LINKS_CONFIRMATION_REQUIRED');
  return service.shareEnable({
    confirmation: review.confirmation.token,
    repo,
    ...extra,
  });
};

test('enabling first shows the exact public fields and changes nothing until the reviewed token comes back', async () => {
  const { dataDir, service } = world();
  const review = await service.shareEnable({ repo: 'repo' });
  expect(review).toMatchObject({
    code: 'LINKS_CONFIRMATION_REQUIRED',
    ok: false,
  });
  expect(review.confirmation.project).toBe('repo');
  expect(review.confirmation.owner).toBe('mukul');
  expect(review.confirmation.fields.map((field) => field.field)).toEqual([
    'owner',
    'task',
    'reachability',
    'freshness',
    'session',
  ]);
  expect(review.confirmation.never).toEqual([
    'transcripts',
    'paths',
    'environment',
    'provider context',
  ]);
  expect(review.confirmation.permissions).toEqual({
    attention: false,
    interrupt: false,
    receive: true,
    visibility: true,
  });
  // Nothing was written, not even a store.
  expect(existsSync(dataDir)).toBe(false);
  expect(await service.shareStatus({ repo: 'repo' })).toMatchObject({
    ok: true,
    shared: false,
  });
  expect(existsSync(dataDir)).toBe(false);
});

test('a declined or interrupted confirmation is simply never submitted, and a token for other terms is void', async () => {
  const { dataDir, service } = world();
  const first = await service.shareEnable({ repo: 'repo' });
  // Another owner label is a different disclosure: the earlier token does not cover it.
  const other = await service.shareEnable({
    confirmation: first.confirmation.token,
    owner: 'someone else',
    repo: 'repo',
  });
  expect(other.code).toBe('LINKS_CONFIRMATION_REQUIRED');
  expect(other.confirmation.token).not.toBe(first.confirmation.token);
  for (const confirmation of ['yes', 'true', `${first.confirmation.token}x`]) {
    // biome-ignore lint/performance/noAwaitInLoops: Calls share one world.
    const refused = await service.shareEnable({ confirmation, repo: 'repo' });
    expect(refused.code).toBe('LINKS_CONFIRMATION_REQUIRED');
  }
  // A token for one project does not enable another.
  const wrongProject = await service.shareEnable({
    confirmation: first.confirmation.token,
    repo: 'other',
  });
  expect(wrongProject.code).toBe('LINKS_CONFIRMATION_REQUIRED');
  expect(existsSync(dataDir)).toBe(false);
});

test('a confirmed enable records the policy, which a restart preserves, and status reports it', async () => {
  const { make, service } = world();
  const enabled = await enable(service);
  expect(enabled).toMatchObject({
    changed: true,
    ok: true,
    policy: {
      attention: false,
      interrupt: false,
      owner: 'mukul',
      receive: true,
      visibility: true,
    },
    project: 'repo',
  });
  const restarted = make().service;
  expect(await restarted.shareStatus({ repo: 'repo' })).toMatchObject({
    ok: true,
    policy: { owner: 'mukul', receive: true, visibility: true },
    shared: true,
    state: 'enabled',
  });
  const all = await restarted.shareStatus({});
  expect(all.projects.map((entry) => entry.project)).toEqual(['repo']);
  expect(JSON.stringify(all)).not.toContain('ps_');
});

test('only a registered project can be shared, and refusing creates nothing', async () => {
  const { dataDir, service } = world();
  const refused = await service.shareEnable({ repo: 'unknown' });
  expect(refused).toMatchObject({ code: 'LINKS_PROJECT_NOT_FOUND', ok: false });
  for (const repo of ['', '../escape', 'a b', 'x'.repeat(200)]) {
    // biome-ignore lint/performance/noAwaitInLoops: Calls share one world.
    expect((await service.shareEnable({ repo })).code).toBe('LINKS_INVALID');
  }
  for (const owner of ['', 'two\nlines', 'x'.repeat(100), '  padded']) {
    // biome-ignore lint/performance/noAwaitInLoops: Calls share one world.
    expect((await service.shareEnable({ owner, repo: 'repo' })).code).toBe(
      'LINKS_INVALID'
    );
  }
  expect(existsSync(dataDir)).toBe(false);
});

test('the directory lists only the shared project’s managed sessions, never other projects or observed-only sessions', async () => {
  const { service, state } = world();
  state.sessions = [
    session(),
    session({ id: 'session-2', name: 'topic-2' }),
    session({ id: 'observed', ownership: 'observed' }),
    session({ id: 'elsewhere', repo: 'other' }),
  ];
  state.tasks = {
    'session-1': { at: Date.now() - 60_000, text: 'Fix the login redirect' },
  };
  await enable(service);
  expect(await service.publishPresence()).toMatchObject({ ok: true });

  const listed = await service.directory({});
  expect(listed.ok).toBe(true);
  expect(listed.entries.map((entry) => entry.sessionId)).toEqual([
    'session-1',
    'session-2',
  ]);
  expect(listed.entries[0]).toEqual({
    activityAt: null,
    observedAt: expect.any(Number),
    owner: 'mukul',
    project: 'repo',
    reachability: { reason: null, state: 'reachable' },
    sessionId: 'session-1',
    stale: false,
    task: 'Fix the login redirect',
    taskAt: state.tasks['session-1'].at,
    taskStale: false,
  });
  expect(listed.problems).toEqual([]);
  expect((await service.directory({ repo: 'other' })).entries).toEqual([]);
});

test('the review lists exactly the fields a directory entry carries', async () => {
  const { service } = world();
  const review = await service.shareEnable({ repo: 'repo' });
  const disclosed = review.confirmation.fields.flatMap((field) => field.keys);
  await enable(service);
  await service.publishPresence();
  const [entry] = (await service.directory({})).entries;
  expect([...disclosed, 'project'].sort()).toEqual(Object.keys(entry).sort());
});

test('reachability says why a session cannot receive mail, including that it has ended', async () => {
  const { service, state } = world();
  state.sessions = [
    session({ id: 'a', nativeConversation: { state: 'pending' } }),
    session({ id: 'b', state: 'unknown' }),
    session({ id: 'c', tool: 'codex' }),
    session({ endedAt: Date.now(), id: 'd', state: 'ended' }),
    session({
      checkoutIdentity: {
        ...checkoutIdentity,
        checkout: { birthtimeNs: '9', dev: '2', ino: '3' },
      },
      id: 'e',
    }),
  ];
  await enable(service);
  await service.publishPresence();
  const reasons = Object.fromEntries(
    (await service.directory({})).entries.map((entry) => [
      entry.sessionId,
      entry.reachability.reason,
    ])
  );
  expect(reasons).toEqual({
    a: 'no-native-binding',
    b: 'not-running',
    c: 'provider-unverified',
    d: 'ended',
    e: 'checkout-changed',
  });
});

test('no transcript, path, environment, terminal or provider context reaches the directory or the stored presence', async () => {
  const { dataDir, service, state } = world();
  state.tasks = { 'session-1': { at: Date.now(), text: 'Review the schema' } };
  await enable(service);
  await service.publishPresence();
  const output = JSON.stringify(await service.directory({}));
  for (const secret of [
    SECRET_PATH,
    SECRET_NATIVE,
    'terminal-secret',
    '4242',
    'claude-code',
    'birthtimeNs',
  ]) {
    expect(output).not.toContain(secret);
  }
  // Nor is any of it anywhere in the database: nothing was sent, so nothing should hold a conversation.
  const stored = readFileSync(join(dataDir, 'mailbox.sqlite3')).toString(
    'latin1'
  );
  for (const secret of [SECRET_PATH, SECRET_NATIVE, 'terminal-secret']) {
    expect(stored).not.toContain(secret);
  }
});

test('stale presence stays listed and marked, and is never shown as reachable', async () => {
  let clock = 1_760_000_000_000;
  const { service } = world([session()], {
    engine: HOOKS_ENGINE,
    now: () => clock,
  });
  await enable(service);
  await service.publishPresence();
  clock += 120_001;
  const stale = (await service.directory({})).entries;
  expect(stale).toHaveLength(1);
  expect(stale[0]).toMatchObject({
    reachability: { reason: 'stale', state: 'unknown' },
    sessionId: 'session-1',
    stale: true,
  });
  await service.publishPresence();
  expect((await service.directory({})).entries[0].stale).toBe(false);
});

test('disabling removes the sessions from the directory and the engine then refuses other principals', async () => {
  const { client, service } = world();
  await enable(service);
  await service.publishPresence();
  const deposit = (key) =>
    client.call('send', {
      body: 'from a session',
      idempotency_key: key,
      project: 'repo',
      recipient: {
        checkout: 'c',
        native_id: 'native-a',
        provider: 'claude-code',
        session_hint: 'session-1',
      },
      sender: { id: 'sender-session', kind: 'session' },
    });
  expect((await deposit('k1')).ok).toBe(true);

  expect(await service.shareDisable({ repo: 'repo' })).toMatchObject({
    ok: true,
    removed: true,
  });
  expect((await service.directory({})).entries).toEqual([]);
  expect(await deposit('k2')).toMatchObject({
    code: 'LINKS_NOT_SHARED',
    ok: false,
  });
  expect(await service.shareStatus({ repo: 'repo' })).toMatchObject({
    shared: false,
  });
  // Disabling again is harmless.
  expect(await service.shareDisable({ repo: 'repo' })).toMatchObject({
    ok: true,
    removed: false,
  });
});

test('the local user’s own sessions stay reachable without sharing; sending is unchanged', async () => {
  const { service } = world();
  const sent = await service.send({
    body: 'hello',
    idempotencyKey: 'k1',
    name: 'topic',
    repo: 'repo',
    sessionId: 'session-1',
  });
  expect(sent).toMatchObject({ ok: true, state: 'queued' });
});

test('an unreadable policy disables sharing for its project with a recoverable error, across a restart', async () => {
  const { client, dataDir, make, service, state } = world();
  state.sessions = [
    session(),
    session({ id: 'o', name: 'topic-2', repo: 'other' }),
  ];
  await enable(service);
  await enable(service, 'other');
  await service.publishPresence();
  const db = new Database(join(dataDir, 'mailbox.sqlite3'));
  db.run(
    "UPDATE sharing_policies SET policy = '{broken' WHERE project = 'repo'"
  );
  db.close();

  for (const current of [service, make().service]) {
    // biome-ignore lint/performance/noAwaitInLoops: Calls share one world.
    const status = await current.shareStatus({ repo: 'repo' });
    expect(status).toMatchObject({
      code: 'LINKS_POLICY_INVALID',
      ok: false,
      project: 'repo',
    });
    expect(status.recovery).toContain('share disable');
    const listed = await current.directory({});
    expect(listed.entries.map((entry) => entry.project)).toEqual(['other']);
    expect(listed.problems[0]).toMatchObject({
      code: 'LINKS_POLICY_INVALID',
      project: 'repo',
    });
    expect(listed.problems[0].recovery).toContain('share disable');
  }
  const refused = await client.call('send', {
    body: 'x',
    idempotency_key: 'k',
    project: 'repo',
    recipient: {
      checkout: 'c',
      native_id: 'n',
      provider: 'claude-code',
      session_hint: 'session-1',
    },
    sender: { id: 'someone', kind: 'session' },
  });
  expect(refused.code).toBe('LINKS_POLICY_INVALID');

  // Recovery: disabling clears it, and enabling again after confirmation shares afresh.
  expect(await service.shareDisable({ repo: 'repo' })).toMatchObject({
    ok: true,
    removed: true,
  });
  expect(await service.shareStatus({ repo: 'repo' })).toMatchObject({
    shared: false,
  });
  expect(await enable(service)).toMatchObject({ ok: true });
});

test('status, directory and a presence round with nothing shared create no store and write nothing', async () => {
  const { dataDir, service } = world();
  await service.shareStatus({});
  await service.shareStatus({ repo: 'repo' });
  expect(await service.directory({})).toMatchObject({ entries: [], ok: true });
  expect(await service.publishPresence()).toMatchObject({
    ok: true,
    published: 0,
  });
  expect(existsSync(dataDir)).toBe(false);

  await enable(service);
  await service.publishPresence();
  const file = join(dataDir, 'mailbox.sqlite3');
  const before = readFileSync(file);
  await service.shareStatus({});
  await service.directory({});
  expect(readFileSync(file).equals(before)).toBe(true);
});

test('a presence round stores a row only for the shared project’s managed sessions', async () => {
  const { dataDir, service, state } = world();
  state.sessions = [session(), session({ id: 'o', repo: 'other' })];
  await enable(service);
  await service.publishPresence();
  const db = new Database(join(dataDir, 'mailbox.sqlite3'));
  const rows = db.query('SELECT project, session_id FROM presence').all();
  db.close();
  expect(rows).toEqual([{ project: 'repo', session_id: 'session-1' }]);
});

test('malformed Links sharing requests are refused before the engine is asked', async () => {
  const { dataDir, service } = world();
  for (const call of [
    () => service.shareEnable(null),
    () => service.shareEnable({ repo: 'repo', wake: true }),
    () => service.shareDisable({}),
    () => service.shareDisable({ force: true, repo: 'repo' }),
    () => service.shareStatus({ repo: 5 }),
    () => service.directory({ path: '/x', repo: 'repo' }),
  ]) {
    // biome-ignore lint/performance/noAwaitInLoops: Calls share one world.
    expect((await call()).code).toBe('LINKS_INVALID');
  }
  expect(existsSync(dataDir)).toBe(false);
});

test('mail from another session names its sender, is held when sharing is withdrawn, and returns when it is shared again', async () => {
  const { client, service } = world();
  await enable(service);
  const recipient = await service.send({
    body: 'mine',
    idempotencyKey: 'mine',
    name: 'topic',
    repo: 'repo',
    sessionId: 'session-1',
  });
  const theirs = await client.call('send', {
    body: 'theirs',
    idempotency_key: 'k1',
    project: 'repo',
    recipient: {
      checkout: JSON.stringify({
        checkout: { birthtimeNs: '1', dev: '2', ino: '3' },
        known: true,
      }),
      native_id: SECRET_NATIVE,
      provider: 'claude-code',
      session_hint: 'session-1',
    },
    sender: { id: 'sender-session', kind: 'session' },
  });
  expect(theirs.ok).toBe(true);
  const inbox = async () =>
    Object.fromEntries(
      (
        await service.inbox({
          name: 'topic',
          repo: 'repo',
          sessionId: 'session-1',
        })
      ).messages.map((message) => [
        message.messageId,
        [message.sender, message.state, message.reason],
      ])
    );
  expect(await inbox()).toEqual({
    [recipient.messageId]: [{ kind: 'user' }, 'queued', null],
    [theirs.result.message_id]: [
      { id: 'sender-session', kind: 'session' },
      'queued',
      null,
    ],
  });

  await service.shareDisable({ repo: 'repo' });
  expect(await inbox()).toMatchObject({
    [recipient.messageId]: [{ kind: 'user' }, 'queued', null],
    [theirs.result.message_id]: [
      { id: 'sender-session', kind: 'session' },
      'held',
      'policy-disabled',
    ],
  });
  // The recipient's own claim gets only what the user sent.
  const claimed = await service.claim({
    name: 'topic',
    repo: 'repo',
    sessionId: 'session-1',
  });
  expect(claimed.messages.map((message) => message.messageId)).toEqual([
    recipient.messageId,
  ]);

  await enable(service);
  expect((await inbox())[theirs.result.message_id][1]).toBe('queued');
});

// ── review fixes: ended sessions, privacy, freshness, batching, registry ──────────────────────────────

const PRIVATE_TASK =
  'Fix /Users/example/private/src/auth.js using $HOME/.ssh token=synthetic-secret';
const PRIVATE_PARTS = [
  '/Users/example',
  'private/src',
  'auth.js',
  '$HOME',
  '.ssh',
  'synthetic-secret',
];

function storedPresence(dataDir) {
  const db = new Database(join(dataDir, 'mailbox.sqlite3'));
  const rows = db.query('SELECT * FROM presence').all();
  db.close();
  return JSON.stringify(rows);
}

test('a session that ends is listed unreachable as ended at once, and later rounds do not refresh the end', async () => {
  const { service, state } = world();
  await enable(service);
  await service.publishPresence();
  expect((await service.directory({})).entries[0].reachability.state).toBe(
    'reachable'
  );

  state.sessions = [session({ endedAt: Date.now(), state: 'ended' })];
  await service.publishPresence();
  const [ended] = (await service.directory({})).entries;
  expect(ended).toMatchObject({
    reachability: { reason: 'ended', state: 'unreachable' },
    sessionId: 'session-1',
    stale: false,
  });
  await Bun.sleep(15);
  await service.publishPresence();
  expect((await service.directory({})).entries[0].observedAt).toBe(
    ended.observedAt
  );
});

test('a session that ended long ago is not published at all, so old history never becomes presence', async () => {
  const { service, state } = world();
  state.sessions = [
    session({ endedAt: Date.now() - 8 * 24 * 60 * 60 * 1000, state: 'ended' }),
    session({ endedAt: Date.now() - 60_000, id: 'recent', state: 'ended' }),
  ];
  await enable(service);
  await service.publishPresence();
  expect(
    (await service.directory({})).entries.map((entry) => entry.sessionId)
  ).toEqual(['recent']);
});

test('a task label with a path, environment reference or secret reaches neither the directory nor the database', async () => {
  const { client, dataDir, service, state } = world();
  state.tasks = { 'session-1': { at: Date.now(), text: PRIVATE_TASK } };
  await enable(service);
  await service.publishPresence();

  const listed = await service.directory({});
  const [entry] = listed.entries;
  expect(entry.task).toStartWith('Fix ');
  expect(entry.task).toContain('using');
  for (const part of PRIVATE_PARTS) {
    expect(JSON.stringify(listed)).not.toContain(part);
    expect(storedPresence(dataDir)).not.toContain(part);
    expect(
      readFileSync(join(dataDir, 'mailbox.sqlite3')).toString('latin1')
    ).not.toContain(part);
  }

  // The engine refuses to keep it even from a caller that skips the service.
  await client.call('presence_publish', {
    project: 'repo',
    sessions: [
      {
        reachability: { state: 'reachable' },
        session_id: 'session-1',
        task: PRIVATE_TASK,
        task_at: Date.now(),
      },
    ],
  });
  expect((await service.directory({})).entries[0].task).toBeNull();
  for (const part of PRIVATE_PARTS) {
    expect(storedPresence(dataDir)).not.toContain(part);
  }
});

test('ordinary task text survives and a long one is cut with a mark', async () => {
  const { service, state } = world();
  await enable(service);
  state.tasks = {
    'session-1': { at: Date.now(), text: 'Review CI/CD and/or the v2 plan' },
  };
  await service.publishPresence();
  expect((await service.directory({})).entries[0].task).toBe(
    'Review CI/CD and/or the v2 plan'
  );
  state.tasks = {
    'session-1': { at: Date.now(), text: `Fix ${'word '.repeat(80)}` },
  };
  await service.publishPresence();
  const { task } = (await service.directory({})).entries[0];
  expect([...task].length).toBeLessThanOrEqual(120);
  expect(task).toEndWith('…');
});

test('an owner label with a path, environment reference or secret is refused at review, not renamed', async () => {
  const { dataDir, service } = world();
  for (const owner of ['/Users/someone', 'me@$HOME', 'token=abc', '~/me']) {
    // biome-ignore lint/performance/noAwaitInLoops: Calls share one world.
    expect(await service.shareEnable({ owner, repo: 'repo' })).toMatchObject({
      code: 'LINKS_UNSAFE_LABEL',
      ok: false,
    });
  }
  expect(existsSync(dataDir)).toBe(false);
  expect(
    (await service.shareEnable({ owner: 'Mukul (work)', repo: 'repo' })).code
  ).toBe('LINKS_CONFIRMATION_REQUIRED');
});

test('the review describes the short filtered label and says what the freshness fields are', async () => {
  const { service } = world();
  const { confirmation } = await service.shareEnable({ repo: 'repo' });
  const task = confirmation.fields.find((field) => field.field === 'task');
  expect(task.meaning).toContain('replaced');
  expect(task.meaning).not.toContain('as written');
  const freshness = confirmation.fields.find(
    (field) => field.field === 'freshness'
  );
  expect(freshness.keys).toEqual([
    'observedAt',
    'taskAt',
    'taskStale',
    'activityAt',
    'stale',
  ]);
});

test('task time is the claim’s own heartbeat and activity is the last trusted hook, never the polling time', async () => {
  const { service, state } = world();
  const heartbeat = Date.now() - 90 * 60 * 1000;
  const hook = Date.now() - 45_000;
  state.tasks = {
    'session-1': { at: heartbeat, text: 'Fix the login redirect' },
  };
  state.sessions = [
    session({ lastHookAt: hook }),
    session({ id: 'quiet', lastHookAt: undefined }),
    session({ id: 'bogus', lastHookAt: Date.now() + 3_600_000 }),
  ];
  await enable(service);
  await service.publishPresence();
  const byId = Object.fromEntries(
    (await service.directory({})).entries.map((entry) => [
      entry.sessionId,
      entry,
    ])
  );
  expect(byId['session-1']).toMatchObject({
    activityAt: hook,
    taskAt: heartbeat,
  });
  expect(byId['session-1'].observedAt).toBeGreaterThan(hook);
  expect(byId.quiet).toMatchObject({
    activityAt: null,
    task: null,
    taskAt: null,
  });
  // A value the service cannot trust is unknown, and does not stop the round.
  expect(byId.bogus.activityAt).toBeNull();
});

test('more sessions than one engine call takes are all published in bounded batches', async () => {
  const { dataDir, make, state } = world();
  const calls = [];
  const { client } = make();
  const counting = {
    call: (op, args) => {
      if (op === 'presence_publish') {
        calls.push(args.sessions.length);
      }
      return client.call(op, args);
    },
  };
  const service = createLinksService({
    client: counting,
    defaultOwner: () => 'mukul',
    isProject: (repo) => state.projects.has(repo),
    resolveTarget: () => ({ checkoutIdentity }),
    sessions: { list: () => ({ ok: true, sessions: state.sessions }) },
  });
  state.sessions = Array.from({ length: 300 }, (_, index) =>
    session({ id: `s${String(index).padStart(3, '0')}` })
  );
  await enable(service);
  expect(await service.publishPresence()).toMatchObject({
    ok: true,
    published: 300,
  });
  expect(calls.every((size) => size <= 256)).toBe(true);
  expect(calls.reduce((sum, size) => sum + size, 0)).toBe(300 * 2);
  const ids = (await service.directory({})).entries.map(
    (entry) => entry.sessionId
  );
  expect(ids).toHaveLength(300);
  expect(ids).toContain('s299');
  expect(existsSync(dataDir)).toBe(true);
});

test('a project that is no longer registered is neither published nor listed, and its policy is still reported', async () => {
  const { service, state } = world();
  await enable(service);
  await service.publishPresence();
  state.projects.delete('repo');
  state.sessions = [session(), session({ id: 'late' })];
  await service.publishPresence();

  expect(await service.directory({})).toMatchObject({
    entries: [],
    problems: [],
  });
  expect(await service.shareStatus({ repo: 'repo' })).toMatchObject({
    ok: true,
    registered: false,
    shared: true,
  });
  // Registered again, only what was already observed is there: nothing was published while it was away.
  state.projects.add('repo');
  expect(
    (await service.directory({})).entries.map((entry) => entry.sessionId)
  ).toEqual(['session-1']);
});

test('every name the project registry accepts can be shared, inspected and withdrawn, and no other name can', async () => {
  const { service, state } = world();
  for (const repo of ['my+repo', '@scope', '_x', 'repo.name', 'Üñï', 'a-b_c']) {
    state.projects.add(repo);
    // biome-ignore lint/performance/noAwaitInLoops: Calls share one world.
    const review = await service.shareEnable({ repo });
    expect(review.code).toBe('LINKS_CONFIRMATION_REQUIRED');
    expect(await service.shareStatus({ repo })).toMatchObject({ ok: true });
    expect(await service.shareDisable({ repo })).toMatchObject({ ok: true });
  }
  for (const repo of ['a/b', 'a b', '..', '-x', 'a:b', 'x'.repeat(200)]) {
    // biome-ignore lint/performance/noAwaitInLoops: Calls share one world.
    expect((await service.shareStatus({ repo })).code).toBe('LINKS_INVALID');
  }
});

test('a project name with a control character the registry allows is refused at review and has nothing to withdraw', async () => {
  const { dataDir, service, state } = world();
  for (const repo of ['a\u007fb', 'a\u0085b', 'a\u009fb', 'a\u0001b']) {
    state.projects.add(repo);
    // biome-ignore lint/performance/noAwaitInLoops: Calls share one world.
    expect((await service.shareEnable({ repo })).code).toBe('LINKS_INVALID');
    expect((await service.shareStatus({ repo })).code).toBe('LINKS_INVALID');
    expect(await service.withdrawSharing(repo)).toMatchObject({
      ok: true,
      removed: false,
    });
  }
  expect(existsSync(dataDir)).toBe(false);
});

test('an ended session is reported without reading its checkout or its claim', async () => {
  const { make, state } = world();
  const { client } = make();
  const reads = [];
  const service = createLinksService({
    client,
    defaultOwner: () => 'mukul',
    isProject: (repo) => state.projects.has(repo),
    resolveTarget: (target) => {
      reads.push(['checkout', target.name]);
      return { checkoutIdentity };
    },
    sessions: { list: () => ({ ok: true, sessions: state.sessions }) },
    taskLabel: (record) => {
      reads.push(['claim', record.id]);
      return { at: Date.now(), text: 'Fix the login redirect' };
    },
  });
  state.sessions = [
    session({
      endedAt: Date.now() - 1000,
      id: 'done',
      lastHookAt: Date.now() - 5000,
      state: 'ended',
    }),
    session({ id: 'live' }),
  ];
  await enable(service);
  reads.length = 0;
  await service.publishPresence();
  expect(reads).toEqual([
    ['checkout', 'topic'],
    ['claim', 'live'],
  ]);
  const byId = Object.fromEntries(
    (await service.directory({})).entries.map((entry) => [
      entry.sessionId,
      entry,
    ])
  );
  expect(byId.done).toMatchObject({
    reachability: { reason: 'ended', state: 'unreachable' },
    task: null,
  });
  expect(byId.done.activityAt).toEqual(expect.any(Number));
});
