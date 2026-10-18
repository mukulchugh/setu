import { afterEach, expect, test } from 'bun:test';
import { join } from 'node:path';
import { createLinksClient } from './links-client.js';
import { ensureEngine, temporaryLinksRoot } from './links-engine-fixture.js';

// Built before any test runs so a first compile is never charged to a test's own time limit.
const PLAIN_ENGINE = ensureEngine();
const HOOKS_ENGINE = ensureEngine({ hooks: true });

const cleanups = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) {
    cleanup();
  }
});

function realClient(options = {}) {
  const { root, cleanup } = temporaryLinksRoot();
  cleanups.push(cleanup);
  const dataDir = join(root, 'links');
  return {
    client: createLinksClient({
      dataDir,
      enginePath: PLAIN_ENGINE,
      ...options,
    }),
    dataDir,
  };
}

const recipient = {
  checkout: '{"incarnation":"c1","path":"/work/repo"}',
  native_id: 'native-a',
  provider: 'claude-code',
  session_hint: 'session-1',
};

test('a send reaches the real engine and its status can be read back', async () => {
  const { client } = realClient();
  const sent = await client.call('send', {
    body: 'hello',
    idempotency_key: 'key-1',
    project: 'repo',
    recipient,
    sender: { kind: 'user' },
  });
  expect(sent).toMatchObject({
    ok: true,
    result: { replayed: false, state: 'queued' },
  });

  const status = await client.call('status', {
    message_id: sent.result.message_id,
  });
  expect(status).toMatchObject({
    ok: true,
    result: { attempts: 0, state: 'queued' },
  });
});

const sendArgs = (key = 'key-1', body = 'hello') => ({
  body,
  idempotency_key: key,
  project: 'repo',
  recipient,
  sender: { kind: 'user' },
});

function fakeEngine(program, timeoutMs = 2000) {
  return createLinksClient({
    dataDir: 'unused-fixture-directory',
    enginePath: process.execPath,
    spawn: (_command, options) =>
      Bun.spawn([process.execPath, '-e', program], options),
    timeoutMs,
  });
}

// A real child emits the supplied envelope without shell quote rewriting.
function replying(reply, exitCode = 0) {
  return fakeEngine(`const request = await Bun.stdin.json();
console.log(JSON.stringify({ id: request.id, ...${JSON.stringify(reply)} }));
process.exitCode = ${exitCode};`);
}

test('a missing engine is unavailable for reads and unknown for mutations', async () => {
  const { root, cleanup } = temporaryLinksRoot();
  cleanups.push(cleanup);
  const client = createLinksClient({
    dataDir: join(root, 'links'),
    enginePath: join(root, 'absent'),
  });
  expect(await client.call('status', { message_id: 'm_1' })).toMatchObject({
    code: 'LINKS_ENGINE_UNAVAILABLE',
    ok: false,
  });
  expect(await client.call('send', sendArgs())).toMatchObject({
    code: 'LINKS_OUTCOME_UNKNOWN',
    ok: false,
  });
});

test('an engine reply that is not exactly the protocol shape is never believed', async () => {
  const result = { message_id: 'm', replayed: false, state: 'queued' };
  const valid = { ok: true, protocol: 'setu-links/1', result };
  const clients = [
    fakeEngine("console.log('not-json')"),
    replying({ ...valid, id: 'someone-else' }),
    replying({ ...valid, protocol: 'setu-links/2' }),
    replying({ ok: true, protocol: 'setu-links/1' }),
    replying({ ...valid, extra: 1 }),
    replying({
      error: { code: 'lowercase', message: 'x' },
      ok: false,
      protocol: 'setu-links/1',
    }),
    replying(valid, 3),
  ];
  for (const client of clients) {
    // biome-ignore lint/performance/noAwaitInLoops: Each child receives a different protocol fixture.
    const outcome = await client.call('send', sendArgs());
    expect(outcome).toMatchObject({ code: 'LINKS_OUTCOME_UNKNOWN', ok: false });
    expect(outcome.error).toContain('unusable reply');
  }
});

const answering = (result) =>
  replying({ ok: true, protocol: 'setu-links/1', result });

test('a valid envelope around the wrong result shape is never believed, per operation', async () => {
  expect(
    await answering({ message_id: 'm', replayed: false, state: 'queued' }).call(
      'send',
      {}
    )
  ).toMatchObject({ ok: true });
  const wrong = [
    ['send', {}],
    ['send', { message_id: 5, replayed: false, state: 'queued' }],
    ['send', { message_id: 'm', replayed: 'no', state: 'queued' }],
    ['cancel', { message_id: 'm' }],
    ['acknowledge', { message_id: 'm', state: 7 }],
    ['redeliver', { message_id: 'm' }],
    ['claim', { attempt_id: null, messages: 'none', text: '' }],
    ['claim', { attempt_id: 'a', messages: [{ message_id: 'm' }], text: '' }],
    ['confirm', { confirmed: 'm', superseded: [] }],
    ['reconcile', { held: [] }],
    ['sweep', { expired: {} }],
  ];
  for (const [op, result] of wrong) {
    // biome-ignore lint/performance/noAwaitInLoops: Each child returns one independent protocol fixture.
    const outcome = await answering(result).call(op, {});
    expect(outcome).toMatchObject({ code: 'LINKS_OUTCOME_UNKNOWN', ok: false });
    expect(outcome.error).toContain('unusable reply');
  }
  for (const [op, result] of [
    ['list', {}],
    ['list', { messages: [{ message_id: 'm' }] }],
    ['status', { message_id: 'm' }],
    ['show', { message_id: 'm', state: 'queued' }],
  ]) {
    // biome-ignore lint/performance/noAwaitInLoops: Each child returns one independent protocol fixture.
    const outcome = await answering(result).call(op, {});
    expect(outcome).toMatchObject({
      code: 'LINKS_ENGINE_UNAVAILABLE',
      ok: false,
    });
    expect(outcome.error).toContain('unusable reply');
  }
});

test('an operation the client has no shape for, and a key the shape does not own, are never believed', async () => {
  expect(await answering({}).call('frobnicate', {})).toMatchObject({
    code: 'LINKS_ENGINE_UNAVAILABLE',
    ok: false,
  });
  const inherited = await answering({
    constructor: 1,
    message_id: 'm',
    replayed: false,
    state: 'queued',
  }).call('send', {});
  expect(inherited).toMatchObject({ code: 'LINKS_OUTCOME_UNKNOWN', ok: false });
});

test('an unknown outcome gives the recovery that fits its operation, and only a send mentions a key', async () => {
  const { root, cleanup } = temporaryLinksRoot();
  cleanups.push(cleanup);
  const client = createLinksClient({
    dataDir: join(root, 'links'),
    enginePath: join(root, 'absent'),
  });
  const said = {};
  for (const op of [
    'send',
    'cancel',
    'acknowledge',
    'redeliver',
    'claim',
    'confirm',
    'reconcile',
  ]) {
    // biome-ignore lint/performance/noAwaitInLoops: One missing engine serves every operation.
    const outcome = await client.call(op, {});
    expect(outcome.code).toBe('LINKS_OUTCOME_UNKNOWN');
    said[op] = outcome.error;
  }
  expect(said.send).toContain('same idempotency key');
  for (const op of Object.keys(said).filter((name) => name !== 'send')) {
    expect(said[op]).not.toContain('idempotency');
  }
  expect(said.claim).toContain('handoff-unknown');
  expect(said.claim).toContain('redelivery');
  expect(said.confirm).toContain('exact attempt');
  expect(new Set(Object.values(said)).size).toBe(Object.keys(said).length);
});

test('a well-formed reply from the engine is accepted', async () => {
  const outcome = await answering({
    engine_version: '0',
    protocol: 'setu-links/1',
    schema_version: 1,
    store: 'absent',
  }).call('health');
  expect(outcome).toEqual({
    ok: true,
    result: {
      engine_version: '0',
      protocol: 'setu-links/1',
      schema_version: 1,
      store: 'absent',
    },
  });
});

test('a hung engine is killed at the timeout and a mutation is then unknown', async () => {
  const started = Date.now();
  const outcome = await fakeEngine('await Bun.sleep(3000)', 500).call(
    'send',
    sendArgs()
  );
  expect(outcome).toMatchObject({ code: 'LINKS_OUTCOME_UNKNOWN', ok: false });
  expect(Date.now() - started).toBeLessThan(2500);
});

test('engine refusals keep their stable code and details under the Links namespace', async () => {
  const { client } = realClient();
  const first = await client.call('send', sendArgs());
  const conflict = await client.call('send', sendArgs('key-1', 'different'));
  expect(conflict).toMatchObject({
    code: 'LINKS_IDEMPOTENCY_CONFLICT',
    details: { message_id: first.result.message_id },
    ok: false,
  });
});

test('a send whose reply was lost is retried under the same key to exactly one message', async () => {
  const { root, cleanup } = temporaryLinksRoot();
  cleanups.push(cleanup);
  const dataDir = join(root, 'links');
  const enginePath = HOOKS_ENGINE;
  const dying = createLinksClient({
    dataDir,
    enginePath,
    spawn: (command, options) =>
      Bun.spawn(command, {
        ...options,
        env: { ...process.env, SETU_LINKS_TEST_KILL_AT: 'send:after-commit' },
      }),
  });
  const lost = await dying.call('send', sendArgs());
  expect(lost).toMatchObject({ code: 'LINKS_OUTCOME_UNKNOWN', ok: false });

  const healthy = createLinksClient({ dataDir, enginePath });
  const retry = await healthy.call('send', sendArgs());
  expect(retry).toMatchObject({ ok: true, result: { replayed: true } });
  const inbox = await healthy.call('list', { session_hint: 'session-1' });
  expect(inbox.result.messages).toHaveLength(1);
});

const PEER = 'a'.repeat(64);
const PUBLIC_KEY = /^[0-9a-f]{64}$/;

test('the transport operations round-trip through the real engine with strict result shapes', async () => {
  const { client } = realClient();
  const identity = await client.call('identity', {});
  expect(identity).toMatchObject({ ok: true });
  expect(identity.result.peer_id).toMatch(PUBLIC_KEY);
  expect(await client.call('transport_status', {})).toEqual({
    ok: true,
    result: { running: false },
  });

  const key = identity.result.peer_id;
  expect(
    await client.call('peer_add', {
      addresses: ['127.0.0.1:4000'],
      label: 'laptop',
      peer_id: key,
    })
  ).toEqual({ ok: true, result: { peer_id: key } });
  expect(
    await client.call('peer_grant', {
      capability: 'send',
      peer_id: key,
      scope: { kind: 'peer' },
    })
  ).toMatchObject({ ok: true });
  const listed = await client.call('peer_list', {});
  expect(listed.result.peers[0]).toMatchObject({
    addresses: ['127.0.0.1:4000'],
    grants: [{ capability: 'send', scope: { kind: 'peer' } }],
    label: 'laptop',
    published: [],
  });

  const published = await client.call('binding_publish', {
    generation: 1,
    recipient,
    valid_for_ms: 60_000,
  });
  expect(published).toMatchObject({
    ok: true,
    result: { held: [], released: [] },
  });
  expect(
    await client.call('binding_show', { session_hint: 'session-1' })
  ).toMatchObject({ ok: true, result: { generation: 1, state: 'valid' } });
  expect(
    await client.call('binding_invalidate', {
      generation: 2,
      reason: 'ownership-unknown',
      session_hint: 'session-1',
    })
  ).toEqual({ ok: true, result: { held: [], stored: true } });
});

test('a mutation of the roster or the snapshots whose reply is lost is unknown, and repeating it is safe', async () => {
  const { root, cleanup } = temporaryLinksRoot();
  cleanups.push(cleanup);
  const client = createLinksClient({
    dataDir: join(root, 'links'),
    enginePath: join(root, 'absent'),
  });
  for (const op of [
    'peer_add',
    'peer_remove',
    'peer_grant',
    'peer_grant_remove',
    'binding_publish',
    'binding_invalidate',
  ]) {
    // biome-ignore lint/performance/noAwaitInLoops: One missing engine per operation.
    const outcome = await client.call(op, {});
    expect(outcome).toMatchObject({ code: 'LINKS_OUTCOME_UNKNOWN', ok: false });
    expect(outcome.error).toContain('Repeating it is safe');
  }
});

test('a claim of peer mail names the peer, and a malformed sender is still never believed', async () => {
  const message = {
    attempt: 1,
    body: 'hi',
    created_at: 1,
    message_id: 'm_1',
    reply_to: null,
  };
  const claim = (sender) =>
    replying({
      ok: true,
      protocol: 'setu-links/1',
      result: {
        attempt_id: 'a_1',
        messages: [{ ...message, sender }],
        text: 'framed',
      },
    });
  expect(
    await claim({ id: PEER, kind: 'peer' }).call('claim', {})
  ).toMatchObject({ ok: true });
  for (const sender of [
    { kind: 'peer' },
    { id: 1, kind: 'peer' },
    { extra: 1, id: PEER, kind: 'user' },
  ]) {
    // biome-ignore lint/performance/noAwaitInLoops: One fixture engine per sender shape.
    expect(await claim(sender).call('claim', {})).toMatchObject({
      code: 'LINKS_OUTCOME_UNKNOWN',
      ok: false,
    });
  }
});

test('the sender view of a message sent to a peer keeps the outbox stage and the cancel stage explicit', async () => {
  const status = (transport) => ({
    attempt_id: null,
    attempts: 0,
    created_at: 1,
    expires_at: 2,
    kind: 'message',
    locator: 'locator-1',
    message_id: 'm_1',
    project: null,
    reason: null,
    recipient,
    redeliveries: 0,
    reply_to: null,
    run_hint: null,
    sender: { kind: 'user' },
    size: 2,
    span_hint: null,
    state: 'queued',
    stored_state: 'queued',
    transport,
    updated_at: 3,
  });
  const good = {
    attempts: 1,
    cancel: 'requested',
    last_error: null,
    outbox: 'pending',
    peer_id: PEER,
    remote_reason: null,
    remote_state: null,
    remote_updated_at: null,
  };
  const reply = (transport) =>
    replying({
      ok: true,
      protocol: 'setu-links/1',
      result: status(transport),
    });
  expect(await reply(good).call('status', {})).toMatchObject({ ok: true });
  expect(
    await reply({ ...good, outbox: undefined }).call('status', {})
  ).toMatchObject({ ok: false });
  expect(await reply({ ...good, extra: 1 }).call('status', {})).toMatchObject({
    ok: false,
  });
});
