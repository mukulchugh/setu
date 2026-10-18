// Attention requests through the composed services: the real managed-session service, Links service and
// attention composition, over the real engine binary and a disposable state directory. The Ghostty effect and
// process observation are the only stand-ins, and they record every call so a test can say what did NOT
// happen. Contract tests; none of this is provider or Ghostty evidence.
//
// Pending, and not simulated here: a session's own request arriving through the session tools, the engine's
// sender-generation fence, and a peer's request over transport.

import { Database } from 'bun:sqlite';
import { afterEach, expect, test } from 'bun:test';
import { existsSync, mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { canonicalCheckout } from './links-service.js';
import { cleanupFixtures, turnFixture } from './links-turn-fixture.js';
import { createOperationEvents } from './operation-events.js';

afterEach(cleanupFixtures);

const tokenA = 'launch_token_alpha_1234567890';
const tokenS = 'launch_token_sender_123456789';
const tokenC = 'launch_token_gamma_1234567890';

// Session A (the person's, in `topic`) and session S (another session of the same project, in `other`).
async function world({ optIn = true, share = true } = {}) {
  const f = await turnFixture({ names: ['topic', 'other'] });
  await f.startSession({
    id: 'session-a',
    nativeId: 'native-a',
    pid: 501,
    token: tokenA,
  });
  await f.startSession({
    id: 'session-s',
    name: 'other',
    nativeId: 'native-s',
    pid: 502,
    token: tokenS,
  });
  if (share) {
    const review = await f.links.shareEnable({ owner: 'Mukul', repo: 'repo' });
    expect(review.code).toBe('LINKS_CONFIRMATION_REQUIRED');
    expect(
      await f.links.shareEnable({
        confirmation: review.confirmation.token,
        owner: 'Mukul',
        repo: 'repo',
      })
    ).toMatchObject({ ok: true });
  }
  if (share && optIn) {
    await enableAttention(f);
  }
  return f;
}

async function enableAttention(f) {
  const review = await f.links.shareAttention({ enabled: true, repo: 'repo' });
  expect(review.code).toBe('LINKS_CONFIRMATION_REQUIRED');
  const done = await f.links.shareAttention({
    confirmation: review.confirmation.token,
    enabled: true,
    repo: 'repo',
  });
  expect(done).toMatchObject({ changed: true, ok: true });
  return done;
}

// The trusted ingress the session tools will call with an already authenticated caller.
const raise = (f, key, body = 'the build needs your decision', extra = {}) =>
  f.links.attentionSendExact({
    body,
    caller: { sessionId: 'session-s' },
    idempotencyKey: key,
    to: 'session-a',
    ...extra,
  });

// The persisted journal of focus operations for the recipient's worktree, as a later reader sees it.
const focusOutcomes = (f, name = 'topic') =>
  createOperationEvents({ now: () => 1, state: f.state })
    .list({ target: { name, repo: 'repo' } })
    .events.filter((entry) => entry.kind === 'terminal-focus')
    .map(({ code, state }) => ({ code, state }));

// A retained request written straight into the engine's store, for a time or an address no live call could
// make: the store is the engine's, but its rows are what a long-lived portal accumulates.
async function seedRequest(
  f,
  { at, hint = 'session-a', native = 'native-a', id }
) {
  const record = (await f.sessions())['session-a'];
  const db = new Database(join(f.dataDir, 'mailbox.sqlite3'));
  db.run(
    `INSERT INTO messages (id, sender, idempotency_key, payload_digest, kind, body, size, provider, native_id, checkout, session_hint, created_at, project)
     VALUES (?1, 'session:session-s', ?1, 'seed', 'attention', ?1, 6, 'claude-code', ?2, ?3, ?4, ?5, 'repo')`,
    [id, native, canonicalCheckout(record.checkoutIdentity), hint, at]
  );
  db.close();
}

const HOUR = 3_600_000;
const MINUTE = 60_000;

const linksEntries = async (f, input = {}) =>
  (await f.attention.list(input, { withMessage: true })).events.filter(
    (event) => event.source === 'links'
  );

// ---- the receiving person's opt-in ----

test('attention is refused until the person reviews and enables it for the project', async () => {
  const f = await world({ optIn: false });
  expect(await raise(f, 'k1')).toMatchObject({
    code: 'LINKS_ATTENTION_NOT_ENABLED',
    ok: false,
  });
  expect(await linksEntries(f)).toEqual([]);

  // The review changes nothing and says what enabling means.
  const review = await f.links.shareAttention({ enabled: true, repo: 'repo' });
  expect(review).toMatchObject({
    code: 'LINKS_CONFIRMATION_REQUIRED',
    ok: false,
  });
  expect(review.confirmation.effect).toContain('never wakes');
  expect(await raise(f, 'k2')).toMatchObject({ ok: false });

  // Only the exact token enables it; any other text is the same review again.
  for (const wrong of ['attention:repo', `${review.confirmation.token}x`, '']) {
    // biome-ignore lint/performance/noAwaitInLoops: Each wrong token is refused against the same state.
    const refused = await f.links.shareAttention({
      confirmation: wrong,
      enabled: true,
      repo: 'repo',
    });
    expect(refused).toMatchObject({
      code: 'LINKS_CONFIRMATION_REQUIRED',
      ok: false,
    });
  }
  expect(await raise(f, 'k3')).toMatchObject({ ok: false });

  await f.links.shareAttention({
    confirmation: review.confirmation.token,
    enabled: true,
    repo: 'repo',
  });
  expect(await raise(f, 'k4')).toMatchObject({ ok: true, replayed: false });
});

test('switching attention off needs no review and takes effect at once; withdrawing the share starts over', async () => {
  const f = await world();
  expect(await raise(f, 'k1')).toMatchObject({ ok: true });
  expect(
    await f.links.shareAttention({ enabled: false, repo: 'repo' })
  ).toMatchObject({ changed: true, ok: true });
  expect(await raise(f, 'k2')).toMatchObject({
    code: 'LINKS_ATTENTION_NOT_ENABLED',
    ok: false,
  });

  // A token for one scope is void for the next share of the project.
  const stale = await f.links.shareAttention({ enabled: true, repo: 'repo' });
  await f.links.shareDisable({ repo: 'repo' });
  const again = await f.links.shareEnable({ owner: 'Mukul', repo: 'repo' });
  await f.links.shareEnable({
    confirmation: again.confirmation.token,
    owner: 'Mukul',
    repo: 'repo',
  });
  expect(
    await f.links.shareAttention({
      confirmation: stale.confirmation.token,
      enabled: true,
      repo: 'repo',
    })
  ).toMatchObject({ code: 'LINKS_CONFIRMATION_REQUIRED', ok: false });
  expect(await raise(f, 'k3')).toMatchObject({ ok: false });
});

test('enabling attention needs a shared project with a readable policy', async () => {
  const f = await world({ share: false });
  expect(
    await f.links.shareAttention({ enabled: true, repo: 'repo' })
  ).toMatchObject({ code: 'LINKS_NOT_SHARED', ok: false });
  expect(
    await f.links.shareAttention({ enabled: 'yes', repo: 'repo' })
  ).toMatchObject({ code: 'LINKS_INVALID', ok: false });
  expect(
    await f.links.shareAttention({ enabled: true, extra: 1, repo: 'repo' })
  ).toMatchObject({ code: 'LINKS_INVALID', ok: false });
  expect(existsSync(f.dataDir)).toBe(false);
});

// ---- what a request is and is not ----

test('a request appears in the attention list from Links with its sender and message, and changes nothing else', async () => {
  const f = await world();
  const before = await f.sessions();
  const admissions = f.admissions.length;
  const scripts = f.scripts.length;
  const launches = f.launched.length;

  const sent = await raise(f, 'k1');
  expect(sent).toMatchObject({ ok: true, replayed: false });

  const [entry, ...rest] = await linksEntries(f);
  expect(rest).toEqual([]);
  expect(entry).toMatchObject({
    admitted: true,
    id: sent.attentionId,
    kind: 'links-attention',
    message: 'the build needs your decision',
    provider: 'claude-code',
    sender: { id: 'session-s', kind: 'session' },
    source: 'links',
    target: { name: 'topic', repo: 'repo' },
  });
  // It is not a provider event, names no session to focus by id, and carries no permission state.
  expect(entry.sessionId).toBeUndefined();
  expect(entry.session).toBeNull();
  expect(entry.state).not.toBe('permission');

  // Nothing about the recipient's session changed, nothing was launched, typed, admitted or claimed.
  expect(await f.sessions()).toEqual(before);
  expect(f.scripts).toHaveLength(scripts);
  expect(f.launched).toHaveLength(launches);
  expect(f.admissions).toHaveLength(admissions);
  expect(f.calls).not.toContain('claimExact');
  expect(existsSync(join(f.checkouts.topic.admin, 'setu-writer.json'))).toBe(
    false
  );
});

test('a request is never mail: the recipient finds it in no inbox and its next turn carries nothing', async () => {
  const f = await world();
  await raise(f, 'k1', 'please look at this');
  expect(
    (
      await f.links.inbox({
        name: 'topic',
        repo: 'repo',
        sessionId: 'session-a',
      })
    ).messages
  ).toEqual([]);
  const turn = await f.turn('session-a', {
    nativeId: 'native-a',
    token: tokenA,
  });
  expect(turn.exitCode).toBe(0);
  expect(turn.stdout).toBe('');
  // The turn did claim for its conversation, and found nothing to hand over.
  expect(f.engineCalls.some(({ op }) => op === 'claim')).toBe(true);
});

test('five rapid requests are five retained entries and one notifying group', async () => {
  const f = await world();
  for (let n = 0; n < 5; n += 1) {
    // biome-ignore lint/performance/noAwaitInLoops: The requests arrive one after another.
    expect(await raise(f, `k${n}`, `note ${n}`)).toMatchObject({ ok: true });
  }
  const entries = await linksEntries(f);
  expect(entries).toHaveLength(5);
  expect(new Set(entries.map((entry) => entry.group.key)).size).toBe(1);
  expect(entries.every((entry) => entry.group.notifying)).toBe(true);
  const listed = await f.attention.list({});
  expect(listed.links.notifications.groups).toHaveLength(1);
  expect(listed.links.notifications.groups[0]).toMatchObject({
    count: 5,
    countComplete: true,
  });
});

test('routine messages never notify', async () => {
  const f = await world();
  for (let n = 0; n < 3; n += 1) {
    // biome-ignore lint/performance/noAwaitInLoops: The messages are sent one after another.
    await f.send({ body: `routine ${n}`, sessionId: 'session-a' });
  }
  const listed = await f.attention.list({});
  expect(listed.events.filter((event) => event.source === 'links')).toEqual([]);
  expect(listed.links.notifications).toEqual({ groups: [], suppressed: 0 });
});

test('a withdrawn opt-in keeps every request but stops notifying', async () => {
  const f = await world();
  await raise(f, 'k1');
  await raise(f, 'k2');
  await f.links.shareAttention({ enabled: false, repo: 'repo' });
  const listed = await f.attention.list({});
  const entries = listed.events.filter((event) => event.source === 'links');
  expect(entries).toHaveLength(2);
  expect(
    entries.every((entry) => !(entry.admitted || entry.group.notifying))
  ).toBe(true);
  expect(listed.links.notifications.groups).toEqual([]);
});

test('a request is validated at the ingress and a refusal stores nothing', async () => {
  const f = await world();
  const cases = [
    [{ caller: { sessionId: 'nobody' } }, 'LINKS_SESSION_NOT_FOUND'],
    [{ to: 'nobody' }, 'LINKS_SESSION_NOT_FOUND'],
    [{ body: '' }, 'LINKS_INVALID'],
    [{ idempotencyKey: '' }, 'LINKS_INVALID'],
    [{ sender: 'session-x' }, 'LINKS_INVALID'],
    [{ kind: 'permission' }, 'LINKS_INVALID'],
    [{ wake: true }, 'LINKS_INVALID'],
    [{ replyTo: 'm_1' }, 'LINKS_INVALID'],
    [{ body: 'x'.repeat(1025) }, 'LINKS_ATTENTION_TOO_LARGE'],
    [{ body: 'bidi ‮ text' }, 'LINKS_ATTENTION_BODY_INVALID'],
  ];
  for (const [change, code] of cases) {
    // biome-ignore lint/performance/noAwaitInLoops: Each refusal is checked against the same state.
    expect(await raise(f, 'k1', undefined, change)).toMatchObject({
      code,
      ok: false,
    });
  }
  expect(await linksEntries(f)).toEqual([]);
});

test('a request cannot cross projects, reach an ended session or an unverified provider', async () => {
  const f = await world();
  const codex = await f.startSession({
    bind: false,
    id: 'session-x',
    name: 'other',
    pid: 503,
    token: 'launch_token_codex_1234567890',
    tool: 'codex',
  });
  expect(codex.opened.ok).toBe(true);
  expect(await raise(f, 'k1', undefined, { to: 'session-x' })).toMatchObject({
    code: 'LINKS_PROVIDER_UNVERIFIED',
    ok: false,
  });
  await f.endSession(501);
  expect(await raise(f, 'k2')).toMatchObject({
    code: 'LINKS_SESSION_ENDED',
    ok: false,
  });
  expect(
    f.engineCalls.filter(({ op }) => op === 'attention_send')
  ).toHaveLength(0);
});

test('a retry with the same key is one request and a different body under that key conflicts', async () => {
  const f = await world();
  const first = await raise(f, 'k1');
  expect(await raise(f, 'k1')).toMatchObject({
    attentionId: first.attentionId,
    replayed: true,
  });
  expect(await raise(f, 'k1', 'something else')).toMatchObject({
    code: 'LINKS_IDEMPOTENCY_CONFLICT',
    ok: false,
  });
  expect(await linksEntries(f)).toHaveLength(1);
});

// ---- no provider hook creates a Links item, and no Links item satisfies a provider request ----

test('a forged provider hook cannot create a Links item and an item cannot answer a permission request', async () => {
  const f = await world();
  await raise(f, 'k1');
  const before = (await linksEntries(f)).length;
  const cwd = f.checkouts.topic.wtDir;
  const forged = [
    ['PermissionRequest', undefined],
    ['PermissionRequest', 'launch_token_wrong_12345678901234'],
    ['PermissionRequest', tokenS],
    ['Notification', undefined],
  ];
  for (const [event, token] of forged) {
    // biome-ignore lint/performance/noAwaitInLoops: Each forgery is judged against the same state.
    const outcome = await f.managed.receiveHook({
      launchToken: token,
      payload: {
        cwd,
        hook_event_name: event,
        notification_type: 'agent_needs_input',
        session_id: 'native-a',
      },
      provider: 'claude-code',
    });
    expect(outcome.attention.kind).toBe('unknown');
  }
  expect(await linksEntries(f)).toHaveLength(before);
  expect(
    f.engineCalls.filter(({ op }) => op === 'attention_send')
  ).toHaveLength(1);

  // A real permission request is a provider event beside the Links item, never merged into it.
  const real = await f.managed.receiveHook({
    launchToken: tokenA,
    payload: {
      cwd,
      hook_event_name: 'PermissionRequest',
      session_id: 'native-a',
    },
    provider: 'claude-code',
  });
  expect(real.attention.kind).toBe('permission');
  const listed = await f.attention.list({});
  expect(
    listed.events.filter((event) => event.kind === 'permission')
  ).toHaveLength(1);
  expect(
    listed.events
      .filter((event) => event.source === 'links')
      .every((event) => event.kind === 'links-attention')
  ).toBe(true);
});

test('no hook payload field reaches the Links engine', async () => {
  const f = await world();
  const before = f.engineCalls.length;
  await f.managed.receiveHook({
    launchToken: tokenA,
    payload: {
      attention_request: { body: 'look' },
      cwd: f.checkouts.topic.wtDir,
      hook_event_name: 'Stop',
      links: { attention: true },
      session_id: 'native-a',
    },
    provider: 'claude-code',
  });
  expect(
    f.engineCalls.slice(before).filter(({ op }) => op.startsWith('attention'))
  ).toEqual([]);
  expect(await linksEntries(f)).toEqual([]);
});

// ---- reads are passive ----

test('reading the list sends nothing, creates no store and notifies no one', async () => {
  const f = await turnFixture({ names: ['topic'] });
  const listed = await f.attention.list({});
  expect(listed).toMatchObject({ events: [], ok: true });
  expect(listed.links).toMatchObject({ state: 'ok' });
  expect(existsSync(f.dataDir)).toBe(false);
  expect(f.scripts).toEqual([]);
  expect(f.engineCalls.every(({ op }) => op === 'attention_list')).toBe(true);
});

test('when the Links engine is unavailable the provider events still list and the gap is stated', async () => {
  const f = await world();
  await raise(f, 'k1');
  await f.managed.receiveHook({
    launchToken: tokenA,
    payload: {
      cwd: f.checkouts.topic.wtDir,
      hook_event_name: 'PermissionRequest',
      session_id: 'native-a',
    },
    provider: 'claude-code',
  });
  f.setEngine('/nonexistent/setu-links');
  const listed = await f.attention.list({});
  expect(listed.ok).toBe(true);
  expect(listed.events.map((event) => event.kind)).toEqual(['permission']);
  expect(listed.links).toMatchObject({
    code: 'LINKS_ENGINE_UNAVAILABLE',
    state: 'unavailable',
  });
});

test('the list can follow one worktree', async () => {
  const f = await world();
  await raise(f, 'k1');
  expect(await linksEntries(f, { name: 'topic', repo: 'repo' })).toHaveLength(
    1
  );
  expect(await linksEntries(f, { name: 'other', repo: 'repo' })).toEqual([]);
});

test('retained requests page without gaps, and a group count is not the page size', async () => {
  const f = await world();
  for (let n = 0; n < 7; n += 1) {
    // biome-ignore lint/performance/noAwaitInLoops: The requests arrive one after another.
    await raise(f, `k${n}`, `note ${n}`);
  }
  const first = await f.links.attentionList({ limit: 3 });
  expect(first.entries).toHaveLength(3);
  expect(first.hasMore).toBe(true);
  const rest = await f.links.attentionList({ before: first.next, limit: 10 });
  expect(rest.entries).toHaveLength(4);
  expect(rest.hasMore).toBe(false);
  expect(first.notifications.groups[0].count).toBe(7);
  expect(
    new Set([...first.entries, ...rest.entries].map((entry) => entry.id)).size
  ).toBe(7);
});

// ---- opening an item focuses the exact conversation, or says why not ----

test('opening a request focuses the exact verified terminal of the current conversation', async () => {
  const f = await world();
  const sent = await raise(f, 'k1');
  const [entry] = await linksEntries(f);
  expect(entry.open).toEqual({ available: true });
  const scripts = f.scripts.length;
  const opened = await f.attention.open({ attentionId: sent.attentionId });
  expect(opened).toMatchObject({
    action: 'focus',
    ok: true,
    sessionId: 'session-a',
  });
  expect(f.scripts).toHaveLength(scripts + 1);
  expect(f.scripts.at(-1).script).toContain('focus terminalRef');
  expect(f.scripts.at(-1).args).toContain(f.checkouts.topic.wtDir);
});

test('an ended session is reported and nothing is focused', async () => {
  const f = await world();
  const sent = await raise(f, 'k1');
  await f.endSession(501);
  const scripts = f.scripts.length;
  expect(
    await f.attention.open({ attentionId: sent.attentionId })
  ).toMatchObject({
    code: 'LINKS_SESSION_ENDED',
    ok: false,
  });
  expect(f.scripts).toHaveLength(scripts);
  const [entry] = await linksEntries(f);
  expect(entry.open).toMatchObject({
    available: false,
    code: 'LINKS_SESSION_ENDED',
  });
});

test('a replaced conversation is reported, the new one is not focused, and nothing else is', async () => {
  const f = await world();
  const sent = await raise(f, 'k1');
  // /clear in the same terminal: a new native conversation in the same managed record.
  expect(
    await f.hook(tokenA, {
      cwd: f.checkouts.topic.wtDir,
      event: 'SessionStart',
      nativeId: 'native-replacement',
    })
  ).toMatchObject({ ok: true });
  const scripts = f.scripts.length;
  expect(
    await f.attention.open({ attentionId: sent.attentionId })
  ).toMatchObject({
    code: 'LINKS_CONVERSATION_REPLACED',
    ok: false,
  });
  expect(f.scripts).toHaveLength(scripts);
  const [entry] = await linksEntries(f);
  expect(entry.open).toMatchObject({
    available: false,
    code: 'LINKS_CONVERSATION_REPLACED',
  });
  // Still listed under its worktree, and still retained.
  expect(entry.target).toMatchObject({ name: 'topic', repo: 'repo' });
});

test('a conversation replaced between verification and the effect is refused by the focus guard', async () => {
  const f = await world();
  const sent = await raise(f, 'k1');
  f.attentionHooks.beforeFocus = async () => {
    await f.hook(tokenA, {
      cwd: f.checkouts.topic.wtDir,
      event: 'SessionStart',
      nativeId: 'native-replacement',
    });
  };
  const scripts = f.scripts.length;
  const opened = await f.attention.open({ attentionId: sent.attentionId });
  expect(opened).toMatchObject({ code: 'CONVERSATION_CHANGED', ok: false });
  expect(f.scripts).toHaveLength(scripts);
  // The refusal is in the persisted operation journal as a failed focus, like any other refusal.
  expect(focusOutcomes(f)).toEqual([
    { code: 'CONVERSATION_CHANGED', state: 'failed' },
  ]);
});

test('a request opens the same conversation after an exact reviewed resume under a new record', async () => {
  const f = await world();
  const sent = await raise(f, 'k1');
  await f.endSession(501);
  expect(
    await f.attention.open({ attentionId: sent.attentionId })
  ).toMatchObject({
    code: 'LINKS_SESSION_ENDED',
    ok: false,
  });
  const review = await f.resumeSession({
    id: 'session-c',
    nativeId: 'native-a',
    pid: 503,
    token: tokenC,
  });
  await f.resumeSession({
    confirmation: review.confirmation.token,
    id: 'session-c',
    nativeId: 'native-a',
    pid: 503,
    token: tokenC,
  });
  await f.hook(tokenC, {
    cwd: f.checkouts.topic.wtDir,
    event: 'SessionStart',
    nativeId: 'native-a',
  });
  const scripts = f.scripts.length;
  expect(
    await f.attention.open({ attentionId: sent.attentionId })
  ).toMatchObject({
    ok: true,
    sessionId: 'session-c',
  });
  expect(f.scripts).toHaveLength(scripts + 1);
});

test('opening an unknown request is refused without touching a terminal', async () => {
  const f = await world();
  const scripts = f.scripts.length;
  for (const attentionId of ['att_unknown', '', 'a b']) {
    // biome-ignore lint/performance/noAwaitInLoops: Each refusal is checked against the same state.
    const refused = await f.attention.open({ attentionId });
    expect(refused.ok).toBe(false);
  }
  expect(f.scripts).toHaveLength(scripts);
});

// ---- Send now is unavailable, for everyone ----

test('Send now is unavailable with a stable code and starts nothing', async () => {
  const f = await world();
  await f.send({ body: 'queued mail', sessionId: 'session-a' });
  const {
    messages: [mail],
  } = await f.links.inbox({
    name: 'topic',
    repo: 'repo',
    sessionId: 'session-a',
  });
  const before = await f.sessions();
  const scripts = f.scripts.length;
  const admissions = f.admissions.length;
  const launches = f.launched.length;
  const calls = f.engineCalls.length;

  const outcome = await f.links.sendNow({
    messageId: mail.messageId,
    name: 'topic',
    repo: 'repo',
    sessionId: 'session-a',
  });
  expect(outcome).toMatchObject({
    code: 'LINKS_WAKE_UNAVAILABLE',
    ok: false,
    reason: 'no-verified-mechanism',
  });
  expect(outcome.error).toContain('next normal turn');

  // The only thing the engine heard was the gate, from the local user.
  expect(f.engineCalls.slice(calls)).toEqual([
    {
      args: { message_id: mail.messageId, principal: { kind: 'user' } },
      op: 'wake',
    },
  ]);
  expect(f.scripts).toHaveLength(scripts);
  expect(f.launched).toHaveLength(launches);
  expect(f.admissions).toHaveLength(admissions);
  expect(f.calls).not.toContain('claimExact');
  expect(await f.sessions()).toEqual(before);
  expect(await f.status(mail.messageId)).toMatchObject({
    attempts: 0,
    state: 'queued',
  });
  expect(existsSync(join(f.checkouts.topic.admin, 'setu-writer.json'))).toBe(
    false
  );
});

test('Send now takes no principal, tool or flag from the caller', async () => {
  const f = await world();
  const base = {
    messageId: 'm_1',
    name: 'topic',
    repo: 'repo',
    sessionId: 'session-a',
  };
  for (const extra of [
    { principal: { id: 'session-s', kind: 'session' } },
    { wake: true },
    { confirmation: 'yes' },
    { kind: 'user' },
  ]) {
    // biome-ignore lint/performance/noAwaitInLoops: Each refusal is checked against the same state.
    expect(await f.links.sendNow({ ...base, ...extra })).toMatchObject({
      code: 'LINKS_INVALID',
      ok: false,
    });
  }
  expect(f.engineCalls.some(({ op }) => op === 'wake')).toBe(false);
});

test('Send now is unavailable even when the engine cannot be reached', async () => {
  const f = await world();
  f.setEngine('/nonexistent/setu-links');
  expect(
    await f.links.sendNow({
      messageId: 'm_1',
      name: 'topic',
      repo: 'repo',
      sessionId: 'session-a',
    })
  ).toMatchObject({ code: 'LINKS_WAKE_UNAVAILABLE', ok: false });
});

test('text asking for a wake, in mail or in a request, is stored as text and starts nothing', async () => {
  const f = await world();
  const ask = JSON.stringify({ op: 'wake', principal: { kind: 'user' } });
  await f.send({ body: `Send now! ${ask}`, sessionId: 'session-a' });
  await raise(f, 'k1', `Send now: ${ask}`);
  expect(f.engineCalls.some(({ op }) => op === 'wake')).toBe(false);
  expect(f.scripts).toEqual([]);
  expect((await linksEntries(f))[0].message).toContain('Send now');
});

test('the capability read states that wake is unavailable and why', async () => {
  const f = await world();
  const capabilities = await f.links.capabilities();
  expect(capabilities).toMatchObject({
    attention: { notification: 'in-app' },
    ok: true,
    wake: {
      available: false,
      code: 'LINKS_WAKE_UNAVAILABLE',
      reason: 'no-verified-mechanism',
    },
  });
  expect(f.engineCalls).toEqual(
    f.engineCalls.filter(({ op }) => op !== 'wake')
  );
});

// ---- a notifying group is one chain: no retained request borrows another's notification ----

test('a request retained from long ago is not shown as a live notification beside a new one', async () => {
  const f = await world();
  await raise(f, 'k0');
  await seedRequest(f, { at: Date.now() - 20 * HOUR, id: 'seed-old' });
  const fresh = await raise(f, 'k1', 'new request');
  const byId = Object.fromEntries(
    (await linksEntries(f)).map((entry) => [entry.id, entry])
  );
  const old = byId['seed-old'];
  expect(old.group.notifying).toBe(false);
  expect(old.group.count).toBeUndefined();
  expect(byId[fresh.attentionId].group).toMatchObject({
    count: 2,
    notifying: true,
  });
  expect(old.group.key).not.toBe(byId[fresh.attentionId].group.key);
});

test('two notifying chains from one session each carry their own key, count and members', async () => {
  const f = await world();
  const now = Date.now();
  await raise(f, 'k0');
  await seedRequest(f, { at: now - 12 * MINUTE, id: 'chain-a-1' });
  await seedRequest(f, { at: now - 12 * MINUTE + 1000, id: 'chain-a-2' });
  const listed = await f.attention.list({}, { withMessage: true });
  const { groups } = listed.links.notifications;
  expect(groups.map((group) => group.count).sort()).toEqual([1, 2]);
  expect(new Set(groups.map((group) => group.key)).size).toBe(2);
  for (const entry of listed.events.filter(
    (event) => event.source === 'links'
  )) {
    const group = groups.find((candidate) => candidate.key === entry.group.key);
    expect(group.itemIds).toContain(entry.id);
    expect(entry.group.count).toBe(group.count);
    expect(entry.group.notifying).toBe(true);
  }
});

// ---- the message text is asked for by name ----

test('a reader that does not ask for the message text never gets it, and the person’s own view does', async () => {
  const f = await world();
  await raise(f, 'k1', 'DISTINCTIVE-BODY-TEXT');
  const readers = [
    await f.attention.list({}),
    await f.attention.list({}, {}),
    await f.attention.list({}, { withMessage: false }),
    await f.links.attentionList({}),
  ];
  for (const quiet of readers) {
    expect(JSON.stringify(quiet)).not.toContain('DISTINCTIVE-BODY-TEXT');
    expect(
      [...(quiet.events ?? quiet.entries)].some(
        (entry) => entry.source === 'links'
      )
    ).toBe(true);
  }
  expect(
    JSON.stringify(await f.attention.list({}, { withMessage: true }))
  ).toContain('DISTINCTIVE-BODY-TEXT');
});

// ---- paging reaches every retained request, in the worktree asked about ----

test('a request behind many newer ones for another worktree is reachable in its own, and every page is stable', async () => {
  const f = await world();
  await raise(f, 'mine', 'for the topic worktree');
  for (let n = 0; n < 6; n += 1) {
    // biome-ignore lint/performance/noAwaitInLoops: The requests arrive one after another.
    await raise(f, `other${n}`, `for the other worktree ${n}`, {
      caller: { sessionId: 'session-a' },
      to: 'session-s',
    });
  }
  const scoped = await f.attention.list(
    { limit: 2, name: 'topic', repo: 'repo' },
    { withMessage: true }
  );
  expect(
    scoped.events.filter((e) => e.source === 'links').map((e) => e.message)
  ).toEqual(['for the topic worktree']);
  expect(scoped.links).toMatchObject({ hasMore: false, state: 'ok' });

  // Everything, newest first, in pages of two: no gap and no repeat, whatever arrives meanwhile.
  await f.managed.receiveHook({
    launchToken: tokenA,
    payload: {
      cwd: f.checkouts.topic.wtDir,
      hook_event_name: 'PermissionRequest',
      session_id: 'native-a',
    },
    provider: 'claude-code',
  });
  const seen = [];
  let before;
  let providerEvents = 0;
  for (let page = 0; page < 6; page += 1) {
    // biome-ignore lint/performance/noAwaitInLoops: Each page needs the cursor of the one before.
    const listed = await f.attention.list(
      { before, limit: 2 },
      { withMessage: true }
    );
    providerEvents += listed.events.filter((e) => e.source !== 'links').length;
    seen.push(
      ...listed.events.filter((e) => e.source === 'links').map((e) => e.id)
    );
    if (!listed.links.hasMore) {
      break;
    }
    before = listed.links.next;
    if (page === 0) {
      await raise(f, 'late', 'arrives between pages');
    }
  }
  expect(seen).toHaveLength(7);
  expect(new Set(seen).size).toBe(7);
  // The provider's own event is listed once, with the first page.
  expect(providerEvents).toBe(1);
});

test('a retained request no managed session can be tied to stays listed, unresolved, and is not guessed at', async () => {
  const f = await world();
  await seedRequest(f, {
    at: Date.now() - MINUTE,
    hint: 'session-gone',
    id: 'seed-ghost',
    native: 'native-gone',
  });
  const [ghost] = await linksEntries(f);
  expect(ghost).toMatchObject({
    id: 'seed-ghost',
    open: { available: false, code: 'LINKS_SESSION_NOT_FOUND' },
    target: null,
    unresolved: true,
  });
  // A worktree's own view does not guess it into any worktree.
  expect(await linksEntries(f, { name: 'topic', repo: 'repo' })).toEqual([]);
  expect(await linksEntries(f, { name: 'other', repo: 'repo' })).toEqual([]);
  expect(await f.attention.open({ attentionId: 'seed-ghost' })).toMatchObject({
    code: 'LINKS_SESSION_NOT_FOUND',
    ok: false,
  });
});

test('a worktree with no session has nothing to list and asks the engine nothing', async () => {
  const f = await world();
  await raise(f, 'k1');
  const calls = f.engineCalls.length;
  const none = await f.links.attentionList({ name: 'nowhere', repo: 'repo' });
  expect(none).toMatchObject({ entries: [], hasMore: false, ok: true });
  expect(f.engineCalls).toHaveLength(calls);
});

// ---- the reviewed scope is what is changed ----

test('a confirmation cannot enable attention on a share that was made again after the review', async () => {
  const f = await world({ optIn: false });
  const review = await f.links.shareAttention({ enabled: true, repo: 'repo' });
  let moved = false;
  // Between the portal reading the scope and the engine writing: the share is withdrawn and made again.
  f.engineHooks.before = async (op) => {
    if (op === 'share_attention' && !moved) {
      moved = true;
      await f.links.shareDisable({ repo: 'repo' });
      const again = await f.links.shareEnable({ owner: 'Mukul', repo: 'repo' });
      await f.links.shareEnable({
        confirmation: again.confirmation.token,
        owner: 'Mukul',
        repo: 'repo',
      });
    }
  };
  const outcome = await f.links.shareAttention({
    confirmation: review.confirmation.token,
    enabled: true,
    repo: 'repo',
  });
  expect(moved).toBe(true);
  expect(outcome).toMatchObject({ code: 'LINKS_SCOPE_CHANGED', ok: false });
  expect((await f.links.shareStatus({ repo: 'repo' })).policy.attention).toBe(
    false
  );
  expect(await raise(f, 'k1')).toMatchObject({
    code: 'LINKS_ATTENTION_NOT_ENABLED',
  });
});

test('after a withdrawal and a new opt-in, recent retained requests may notify again and the review says so', async () => {
  const f = await world();
  await raise(f, 'k1');
  await f.links.shareDisable({ repo: 'repo' });
  const again = await f.links.shareEnable({ owner: 'Mukul', repo: 'repo' });
  await f.links.shareEnable({
    confirmation: again.confirmation.token,
    owner: 'Mukul',
    repo: 'repo',
  });
  const [off] = await linksEntries(f);
  expect(off).toMatchObject({ admitted: false });
  expect(off.group.notifying).toBe(false);
  const review = await f.links.shareAttention({ enabled: true, repo: 'repo' });
  expect(review.confirmation.effect).toContain('15 minutes');
  await f.links.shareAttention({
    confirmation: review.confirmation.token,
    enabled: true,
    repo: 'repo',
  });
  const [on] = await linksEntries(f);
  expect(on).toMatchObject({ admitted: true, group: { notifying: true } });
});

// ---- the focus effect refuses a world that moved after verification ----

test('a session that ended between verification and the effect is refused, journaled and not focused', async () => {
  const f = await world();
  const sent = await raise(f, 'k1');
  f.attentionHooks.beforeFocus = () => f.endSession(501);
  const scripts = f.scripts.length;
  const opened = await f.attention.open({ attentionId: sent.attentionId });
  expect(opened.ok).toBe(false);
  expect(f.scripts).toHaveLength(scripts);
  const [journaled] = focusOutcomes(f);
  expect(journaled.state).toBe('failed');
});

test('a checkout replaced between verification and the effect is refused, journaled and not focused', async () => {
  const f = await world();
  const sent = await raise(f, 'k1');
  f.attentionHooks.beforeFocus = () => {
    // The directory is replaced by a new one at the same path: a new incarnation of the checkout.
    const { wtDir } = f.checkouts.topic;
    renameSync(wtDir, `${wtDir}.replaced`);
    mkdirSync(wtDir);
    writeFileSync(join(wtDir, '.git'), `gitdir: ${f.checkouts.topic.admin}\n`);
  };
  const scripts = f.scripts.length;
  const opened = await f.attention.open({ attentionId: sent.attentionId });
  expect(opened).toMatchObject({ code: 'TARGET_CHANGED', ok: false });
  expect(f.scripts).toHaveLength(scripts);
  expect(focusOutcomes(f)).toEqual([
    { code: 'TARGET_CHANGED', state: 'failed' },
  ]);
});
