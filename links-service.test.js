import { afterEach, expect, test } from 'bun:test';
import { chmodSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createLinksClient } from './links-client.js';
import { ensureEngine, temporaryLinksRoot } from './links-engine-fixture.js';
import { createLinksService } from './links-service.js';

// Built before any test runs so a first compile is never charged to a test's own time limit.
const ENGINE = ensureEngine();

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

// The public shape of a managed session record once native conversation binding exists:
// nativeConversation is { state: 'bound', provider, id, boundAt }.
function session(overrides = {}) {
  return {
    checkoutIdentity,
    id: 'session-1',
    name: 'topic',
    nativeConversation: {
      boundAt: 1_760_000_000_000,
      id: 'native-a',
      provider: 'claude-code',
      state: 'bound',
    },
    ownership: 'owned',
    repo: 'repo',
    state: 'running',
    tool: 'claude-code',
    ...overrides,
  };
}

function fixture(initial = [session()]) {
  const { root, cleanup } = temporaryLinksRoot();
  cleanups.push(cleanup);
  const world = {
    sessions: initial,
    target: { checkoutIdentity, name: 'topic', repo: 'repo' },
  };
  const client = createLinksClient({
    dataDir: join(root, 'links'),
    enginePath: ENGINE,
  });
  const service = createLinksService({
    client,
    resolveTarget: ({ repo, name }) =>
      repo === 'repo' && name === 'topic' ? world.target : null,
    sessions: { list: () => ({ ok: true, sessions: world.sessions }) },
  });
  return { client, dataDir: join(root, 'links'), service, world };
}

const send = (overrides = {}) => ({
  body: 'hello there',
  idempotencyKey: 'key-1',
  name: 'topic',
  repo: 'repo',
  sessionId: 'session-1',
  ...overrides,
});

test('a message to a running session with a verified native conversation is queued and listed in its inbox', async () => {
  const { service } = fixture();
  const sent = await service.send(send());
  expect(sent).toMatchObject({ ok: true, replayed: false, state: 'queued' });

  const inbox = await service.inbox({
    name: 'topic',
    repo: 'repo',
    sessionId: 'session-1',
  });
  expect(inbox.messages).toHaveLength(1);
  expect(inbox.messages[0]).toMatchObject({
    messageId: sent.messageId,
    recipient: {
      nativeId: 'native-a',
      provider: 'claude-code',
      sessionId: 'session-1',
    },
    state: 'queued',
  });
  expect(inbox.messages[0].body).toBeUndefined();
});

const rejected = [
  [
    'an unknown session',
    { sessionId: 'nope' },
    undefined,
    'LINKS_SESSION_NOT_FOUND',
  ],
  [
    'an unregistered worktree',
    { name: 'gone' },
    undefined,
    'WORKTREE_NOT_FOUND',
  ],
  [
    'an unbound native conversation',
    {},
    { nativeConversation: { state: 'unbound' } },
    'LINKS_NO_NATIVE_BINDING',
  ],
  [
    'a session with no binding field at all',
    {},
    { nativeConversation: undefined },
    'LINKS_NO_NATIVE_BINDING',
  ],
  ['an ended session', {}, { state: 'ended' }, 'LINKS_SESSION_ENDED'],
  [
    'a session that is not verifiably running',
    {},
    { state: 'unknown' },
    'LINKS_SESSION_NOT_RUNNING',
  ],
  [
    'a session of unverified ownership',
    {},
    { ownership: 'unknown' },
    'LINKS_SESSION_NOT_RUNNING',
  ],
  [
    'a replaced checkout incarnation',
    {},
    {
      checkoutIdentity: {
        ...checkoutIdentity,
        checkout: { birthtimeNs: '9', dev: '2', ino: '3' },
      },
    },
    'LINKS_CHECKOUT_CHANGED',
  ],
  [
    'a Codex session',
    {},
    {
      nativeConversation: {
        boundAt: 1,
        id: 'c-1',
        provider: 'codex',
        state: 'bound',
      },
      tool: 'codex',
    },
    'LINKS_PROVIDER_UNVERIFIED',
  ],
];

for (const [label, request, sessionChange, code] of rejected) {
  test(`a send to ${label} is refused with ${code} and nothing is stored`, async () => {
    const { service, world } = fixture([session(sessionChange)]);
    expect(await service.send(send(request))).toMatchObject({
      code,
      ok: false,
    });

    // Later evidence does not retroactively attach or release anything, because nothing was kept.
    world.sessions = [session()];
    const inbox = await service.inbox({
      name: 'topic',
      repo: 'repo',
      sessionId: 'session-1',
    });
    expect(inbox.messages).toEqual([]);
  });
}

test('a repeated send returns the same message and a changed payload under the same key conflicts', async () => {
  const { service } = fixture();
  const first = await service.send(send());
  const again = await service.send(send());
  expect(again).toMatchObject({
    messageId: first.messageId,
    ok: true,
    replayed: true,
  });
  expect(await service.send(send({ body: 'something else' }))).toMatchObject({
    code: 'LINKS_IDEMPOTENCY_CONFLICT',
    ok: false,
  });
  const inbox = await service.inbox({
    name: 'topic',
    repo: 'repo',
    sessionId: 'session-1',
  });
  expect(inbox.messages).toHaveLength(1);
});

test('mail for a conversation the session has since replaced is held and the new conversation never gets it', async () => {
  const { service, world } = fixture();
  const old = await service.send(send());

  world.sessions = [
    session({
      nativeConversation: {
        boundAt: 2,
        id: 'native-b',
        provider: 'claude-code',
        state: 'bound',
      },
    }),
  ];
  await service.send(
    send({ body: 'for the new one', idempotencyKey: 'key-2' })
  );
  expect(
    await service.claim({ name: 'topic', repo: 'repo', sessionId: 'session-1' })
  ).toMatchObject({
    messages: [{ body: 'for the new one' }],
    ok: true,
  });

  const shown = await service.status({ messageId: old.messageId });
  expect(shown).toMatchObject({
    reason: 'conversation-replaced',
    state: 'held',
  });
});

test('show returns the body, status and the inbox do not, and cancel retracts unhandled mail', async () => {
  const { service } = fixture();
  const sent = await service.send(send());
  expect(await service.show({ messageId: sent.messageId })).toMatchObject({
    body: 'hello there',
    ok: true,
  });
  expect(
    (await service.status({ messageId: sent.messageId })).body
  ).toBeUndefined();

  expect(await service.cancel({ messageId: sent.messageId })).toMatchObject({
    ok: true,
    state: 'cancelled',
  });
  expect(
    await service.claim({ name: 'topic', repo: 'repo', sessionId: 'session-1' })
  ).toMatchObject({ messages: [], ok: true });
  expect(await service.status({ messageId: 'm_missing' })).toMatchObject({
    code: 'LINKS_MESSAGE_NOT_FOUND',
    ok: false,
  });
});

test('a handoff stays unknown until its exact attempt is confirmed, then the recipient can acknowledge', async () => {
  const { service } = fixture();
  const sent = await service.send(send());
  const target = { name: 'topic', repo: 'repo', sessionId: 'session-1' };
  const claim = await service.claim(target);
  expect(claim.text).toContain('hello there');
  expect(await service.status({ messageId: sent.messageId })).toMatchObject({
    attempts: 1,
    state: 'handoff-unknown',
  });
  expect(
    await service.ack({ ...target, messageId: sent.messageId })
  ).toMatchObject({ code: 'LINKS_INVALID_STATE', ok: false });

  expect(
    await service.confirm({ ...target, attemptId: claim.attemptId })
  ).toMatchObject({ confirmed: [sent.messageId], ok: true });
  expect(
    await service.ack({ ...target, messageId: sent.messageId })
  ).toMatchObject({ ok: true, state: 'acknowledged' });
});

test('only the addressed conversation can acknowledge or redeliver its mail', async () => {
  const { service } = fixture([
    session(),
    session({
      id: 'session-2',
      nativeConversation: {
        boundAt: 1,
        id: 'native-z',
        provider: 'claude-code',
        state: 'bound',
      },
    }),
  ]);
  const sent = await service.send(send());
  const claim = await service.claim({
    name: 'topic',
    repo: 'repo',
    sessionId: 'session-1',
  });
  await service.confirm({
    attemptId: claim.attemptId,
    name: 'topic',
    repo: 'repo',
    sessionId: 'session-1',
  });

  const other = { name: 'topic', repo: 'repo', sessionId: 'session-2' };
  expect(
    await service.ack({ ...other, messageId: sent.messageId })
  ).toMatchObject({ code: 'LINKS_RECIPIENT_MISMATCH', ok: false });
  expect(await service.status({ messageId: sent.messageId })).toMatchObject({
    state: 'handed-off',
  });
});

test('redelivery needs the named unknown attempt and makes a new, counted attempt', async () => {
  const { service } = fixture();
  const target = { name: 'topic', repo: 'repo', sessionId: 'session-1' };
  const sent = await service.send(send());
  const first = await service.claim(target);

  expect(
    await service.redeliver({
      ...target,
      attemptId: 'a_wrong',
      messageId: sent.messageId,
    })
  ).toMatchObject({ code: 'LINKS_ATTEMPT_MISMATCH', ok: false });
  const reviewed = await service.redeliver({
    ...target,
    attemptId: first.attemptId,
    messageId: sent.messageId,
  });
  expect(reviewed).toMatchObject({
    code: 'LINKS_CONFIRMATION_REQUIRED',
    ok: false,
  });
  expect(
    await service.redeliver({
      ...target,
      attemptId: first.attemptId,
      confirmation: reviewed.confirmation.token,
      messageId: sent.messageId,
    })
  ).toMatchObject({ ok: true, state: 'queued' });
  const second = await service.claim(target);
  expect(second.attemptId).not.toBe(first.attemptId);
  expect(await service.status({ messageId: sent.messageId })).toMatchObject({
    attempts: 2,
    redeliveries: 1,
  });
  expect(
    await service.confirm({ ...target, attemptId: first.attemptId })
  ).toMatchObject({ confirmed: [], ok: true, superseded: [sent.messageId] });
});

test('malformed requests are refused before the engine is asked, without echoing the message', async () => {
  const { service } = fixture();
  for (const bad of [
    send({ body: '' }),
    send({ body: 5 }),
    send({ idempotencyKey: undefined }),
    send({ sessionId: undefined }),
    { ...send(), wake: true },
  ]) {
    // biome-ignore lint/performance/noAwaitInLoops: Cases share one temporary engine directory.
    expect(await service.send(bad)).toMatchObject({
      code: 'LINKS_INVALID',
      ok: false,
    });
  }
  const secret = await service.send(
    send({ body: 'SECRET-PAYLOAD', idempotencyKey: 'k'.repeat(300) })
  );
  expect(JSON.stringify(secret)).not.toContain('SECRET-PAYLOAD');
});

test('unreadable session state is reported as itself, not as a missing session', async () => {
  const broken = createLinksService({
    client: {
      call: () => Promise.reject(new Error('the engine must not be asked')),
    },
    resolveTarget: () => ({ checkoutIdentity, name: 'topic', repo: 'repo' }),
    sessions: {
      list: () => ({
        code: 'SESSION_STATE_CORRUPT',
        error: 'Session state is malformed',
        ok: false,
      }),
    },
  });
  expect(await broken.send(send())).toMatchObject({
    code: 'SESSION_STATE_CORRUPT',
    ok: false,
  });
});

const target = { name: 'topic', repo: 'repo', sessionId: 'session-1' };
const binding = (id) => ({
  boundAt: 2,
  id,
  provider: 'claude-code',
  state: 'bound',
});
const rebind = (world, id) => {
  world.sessions = [session({ nativeConversation: binding(id) })];
};

test('a replacement is visible to inbox, status and show with no later send or claim, and the read writes nothing', async () => {
  const { client, service, world } = fixture();
  const sent = await service.send(send());
  expect(await service.status({ messageId: sent.messageId })).toMatchObject({
    observed: true,
    state: 'queued',
    storedState: 'queued',
  });

  rebind(world, 'native-b');
  expect(await service.status({ messageId: sent.messageId })).toMatchObject({
    observed: true,
    reason: 'conversation-replaced',
    state: 'held',
    storedState: 'queued',
  });
  expect(await service.show({ messageId: sent.messageId })).toMatchObject({
    body: 'hello there',
    state: 'held',
    storedState: 'queued',
  });
  expect(await service.inbox(target)).toMatchObject({
    messages: [{ state: 'held', storedState: 'queued' }],
    observed: true,
  });
  // Reading persisted nothing: the engine still holds the mail as queued.
  expect(
    (await client.call('status', { message_id: sent.messageId })).result.state
  ).toBe('queued');

  // Only an explicit send or claim persists the transition.
  await service.claim(target);
  expect(
    (await client.call('status', { message_id: sent.messageId })).result.state
  ).toBe('held');
  rebind(world, 'native-c');
  const inbox = await service.inbox(target);
  expect(inbox.messages.map((message) => message.state)).toEqual(['held']);
});

test('reads create no store, and a session with nothing sent reads as empty', async () => {
  const { dataDir, service } = fixture();
  expect(await service.inbox(target)).toMatchObject({
    messages: [],
    observed: true,
  });
  expect(await service.status({ messageId: 'm_none' })).toMatchObject({
    code: 'LINKS_MESSAGE_NOT_FOUND',
  });
  expect(existsSync(dataDir)).toBe(false);
  expect(await service.claim(target)).toMatchObject({ messages: [], ok: true });
  expect(existsSync(dataDir)).toBe(false);
});

test('a fresh look at the checkout decides checkout-changed, and a read never claims what it did not observe', async () => {
  const { client, service, world } = fixture();
  const sent = await service.send(send());

  world.target = {
    ...world.target,
    checkoutIdentity: { checkout: { birthtimeNs: '9', dev: '2', ino: '3' } },
  };
  expect(await service.status({ messageId: sent.messageId })).toMatchObject({
    observed: true,
    reason: 'checkout-changed',
    state: 'held',
    storedState: 'queued',
  });
  expect(await service.send(send({ idempotencyKey: 'k2' }))).toMatchObject({
    code: 'LINKS_CHECKOUT_CHANGED',
  });
  expect(
    (await client.call('status', { message_id: sent.messageId })).result.state
  ).toBe('queued');

  // A session that is not verifiably running, or whose target cannot be seen, is not observed.
  world.target = { checkoutIdentity, name: 'topic', repo: 'repo' };
  for (const changed of [
    { state: 'ended' },
    { ownership: 'unknown' },
    { state: 'starting' },
  ]) {
    world.sessions = [
      session({ ...changed, nativeConversation: binding('native-b') }),
    ];
    // biome-ignore lint/performance/noAwaitInLoops: Each variation reads the same message.
    expect(await service.status({ messageId: sent.messageId })).toMatchObject({
      observed: false,
      state: 'queued',
      storedState: 'queued',
    });
  }
});

test('held mail is eligible again only when its exact conversation is the authoritative one, and is then delivered once', async () => {
  const { service, world } = fixture();
  const sent = await service.send(send());

  rebind(world, 'native-b');
  expect(await service.claim(target)).toMatchObject({
    messages: [],
    ok: true,
  });
  // A different conversation appearing never releases it.
  rebind(world, 'native-c');
  expect(await service.status({ messageId: sent.messageId })).toMatchObject({
    state: 'held',
  });
  rebind(world, 'native-b');
  expect(await service.claim(target)).toMatchObject({ messages: [] });

  rebind(world, 'native-a');
  expect(await service.status({ messageId: sent.messageId })).toMatchObject({
    observed: true,
    reason: null,
    state: 'queued',
    storedState: 'held',
  });
  const claim = await service.claim(target);
  expect(claim.messages.map((message) => message.messageId)).toEqual([
    sent.messageId,
  ]);
  await service.confirm({ ...target, attemptId: claim.attemptId });

  // Handed-off mail is never replayed by later replacements and resumes.
  rebind(world, 'native-b');
  await service.status({ messageId: sent.messageId });
  rebind(world, 'native-a');
  expect(await service.claim(target)).toMatchObject({ messages: [] });
  expect(await service.status({ messageId: sent.messageId })).toMatchObject({
    attempts: 1,
    state: 'handed-off',
  });
});

test('a claim for the wrong conversation neither delivers nor holds anything', async () => {
  const { client, service } = fixture();
  const sent = await service.send(send());
  const checkout = JSON.stringify({
    checkout: { birthtimeNs: '1', dev: '2', ino: '3' },
    known: true,
  });
  // A caller that bypasses the service and presents a conversation the session is not running.
  const wrong = await client.call('claim', {
    recipient: {
      checkout,
      native_id: 'native-x',
      provider: 'claude-code',
      session_hint: 'session-1',
    },
  });
  expect(wrong).toMatchObject({ ok: true, result: { messages: [] } });
  expect(await service.status({ messageId: sent.messageId })).toMatchObject({
    reason: null,
    state: 'queued',
  });

  // Another session's authoritative claim cannot take or hold this session's mail either.
  const { service: other } = fixture([
    session({ id: 'session-2', nativeConversation: binding('native-z') }),
  ]);
  expect(
    await other.claim({ ...target, sessionId: 'session-2' })
  ).toMatchObject({ messages: [], ok: true });
});

test('a read without a managed binding to compare reports the stored state and says it was not observed', async () => {
  const { service, world } = fixture();
  const sent = await service.send(send());

  world.sessions = [session({ nativeConversation: { state: 'unbound' } })];
  expect(await service.status({ messageId: sent.messageId })).toMatchObject({
    observed: false,
    state: 'queued',
  });
  world.sessions = [];
  expect(await service.inbox(target)).toMatchObject({ ok: false });
});

test('an unavailable session list does not hide the stored status, and says it was not observed', async () => {
  const { client, world } = fixture();
  const service = createLinksService({
    client,
    resolveTarget: () => world.target,
    sessions: {
      list: () =>
        world.down
          ? { code: 'SESSIONS_DOWN', error: 'down', ok: false }
          : { ok: true, sessions: world.sessions },
    },
  });
  const sent = await service.send(send());
  world.down = true;
  expect(await service.status({ messageId: sent.messageId })).toMatchObject({
    observed: false,
    state: 'queued',
  });
});

test('redelivery is only reviewed until the exact reviewed message, attempt and recipient are confirmed', async () => {
  const { service, world } = fixture();
  const sent = await service.send(send());
  const first = await service.claim(target);
  const ask = (extra = {}) =>
    service.redeliver({
      ...target,
      attemptId: first.attemptId,
      messageId: sent.messageId,
      ...extra,
    });

  const reviewed = await ask();
  expect(reviewed).toMatchObject({
    code: 'LINKS_CONFIRMATION_REQUIRED',
    confirmation: {
      attemptId: first.attemptId,
      messageId: sent.messageId,
      recipient: { nativeId: 'native-a', sessionId: 'session-1' },
    },
    ok: false,
  });
  expect(reviewed.confirmation.token).toContain(first.attemptId);
  expect(await service.status({ messageId: sent.messageId })).toMatchObject({
    state: 'handoff-unknown',
  });

  // Nothing the caller says about itself is permission.
  expect(await ask({ source: 'user' })).toMatchObject({
    code: 'LINKS_CONFIRMATION_REQUIRED',
  });
  for (const claimed of [
    { confirmed: true },
    { confirmedBy: 'user' },
    { approve: true },
  ]) {
    // biome-ignore lint/performance/noAwaitInLoops: Each refusal is checked against the same message.
    expect(await ask(claimed)).toMatchObject({ code: 'LINKS_INVALID' });
  }
  expect(await ask({ confirmation: 'redeliver:anything' })).toMatchObject({
    code: 'LINKS_CONFIRMATION_REQUIRED',
  });
  expect(await service.status({ messageId: sent.messageId })).toMatchObject({
    state: 'handoff-unknown',
  });

  // The token binds the recipient: the same token is useless once another conversation is the session's.
  rebind(world, 'native-b');
  expect(
    await ask({ confirmation: reviewed.confirmation.token })
  ).toMatchObject({
    code: 'LINKS_RECIPIENT_MISMATCH',
    ok: false,
  });
  rebind(world, 'native-a');

  expect(
    await ask({ confirmation: reviewed.confirmation.token })
  ).toMatchObject({
    ok: true,
    state: 'queued',
  });
  // The token was for that attempt: a new unknown attempt needs a fresh review.
  const second = await service.claim(target);
  expect(
    await service.redeliver({
      ...target,
      attemptId: second.attemptId,
      confirmation: reviewed.confirmation.token,
      messageId: sent.messageId,
    })
  ).toMatchObject({ code: 'LINKS_CONFIRMATION_REQUIRED' });
});

// The same native conversation can be bound in a different managed record than the one a message was
// addressed through (an exact resume). The engine identifies the recipient by provider, native ID and
// checkout alone, so the review must too: nothing reaches the engine's redeliver without a matching token.
test('a redelivery through another managed record of the same conversation is still reviewed, and refusals never reach the engine', async () => {
  const { client, world } = fixture([
    session(),
    session({ id: 'session-2' }),
    session({ id: 'session-3', nativeConversation: binding('native-z') }),
  ]);
  const calls = [];
  const service = createLinksService({
    client: {
      call: (op, args) => {
        calls.push(op);
        return client.call(op, args);
      },
    },
    resolveTarget: () => world.target,
    sessions: { list: () => ({ ok: true, sessions: world.sessions }) },
  });
  const sent = await service.send(send());
  const first = await service.claim(target);
  const viaOld = { ...target, sessionId: 'session-2' };
  const ask = (extra = {}, who = viaOld) =>
    service.redeliver({
      ...who,
      attemptId: first.attemptId,
      messageId: sent.messageId,
      ...extra,
    });
  const redelivers = () => calls.filter((op) => op === 'redeliver').length;

  const reviewed = await ask();
  expect(reviewed).toMatchObject({ code: 'LINKS_CONFIRMATION_REQUIRED' });
  expect(redelivers()).toBe(0);

  // Each refusal is the engine's own code, produced without asking the engine to redeliver.
  expect(await ask({ attemptId: 'a_other' })).toMatchObject({
    code: 'LINKS_ATTEMPT_MISMATCH',
  });
  expect(await ask({}, { ...target, sessionId: 'session-3' })).toMatchObject({
    code: 'LINKS_RECIPIENT_MISMATCH',
  });
  expect(await ask({ confirmation: 'redeliver:forged' })).toMatchObject({
    code: 'LINKS_CONFIRMATION_REQUIRED',
  });
  expect(redelivers()).toBe(0);

  expect(
    await ask({ confirmation: reviewed.confirmation.token })
  ).toMatchObject({ ok: true, state: 'queued' });
  expect(redelivers()).toBe(1);
  // Nothing in flight any more: a repeat is an invalid state, again without a second engine redeliver.
  expect(
    await ask({ confirmation: reviewed.confirmation.token })
  ).toMatchObject({ code: 'LINKS_INVALID_STATE' });
  expect(redelivers()).toBe(1);
});

test('a send that is not confirmed carries its idempotency key, and the other unknown outcomes carry none', async () => {
  const { root, cleanup } = temporaryLinksRoot();
  cleanups.push(cleanup);
  const service = createLinksService({
    client: createLinksClient({
      dataDir: join(root, 'links'),
      enginePath: join(root, 'absent'),
    }),
    resolveTarget: () => ({ checkoutIdentity, name: 'topic', repo: 'repo' }),
    sessions: { list: () => ({ ok: true, sessions: [session()] }) },
  });
  const sent = await service.send(send({ idempotencyKey: 'key-77' }));
  expect(sent).toMatchObject({
    code: 'LINKS_OUTCOME_UNKNOWN',
    idempotencyKey: 'key-77',
    ok: false,
  });
  const claimed = await service.claim(target);
  expect(claimed.code).toBe('LINKS_OUTCOME_UNKNOWN');
  expect(claimed.idempotencyKey).toBeUndefined();
  expect(claimed.error).not.toContain('idempotency');
});

test('an engine reply with the wrong result shape is reported as such, never dereferenced', async () => {
  const { root, cleanup } = temporaryLinksRoot();
  cleanups.push(cleanup);
  const enginePath = join(root, 'fake-engine');
  writeFileSync(
    enginePath,
    `#!/bin/sh\nid=$(sed -n 's/.*"id":"\\([^"]*\\)".*/\\1/p'); echo "{\\"protocol\\":\\"setu-links/1\\",\\"id\\":\\"$id\\",\\"ok\\":true,\\"result\\":{\\"messages\\":\\"not a list\\"}}"\n`
  );
  chmodSync(enginePath, 0o755);
  const service = createLinksService({
    client: createLinksClient({ dataDir: join(root, 'links'), enginePath }),
    resolveTarget: () => ({ checkoutIdentity, name: 'topic', repo: 'repo' }),
    sessions: { list: () => ({ ok: true, sessions: [session()] }) },
  });
  expect(await service.inbox(target)).toMatchObject({
    code: 'LINKS_ENGINE_UNAVAILABLE',
    ok: false,
  });
  expect(await service.send(send())).toMatchObject({
    code: 'LINKS_OUTCOME_UNKNOWN',
    ok: false,
  });
});
