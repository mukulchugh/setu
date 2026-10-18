// The managed lifecycle and the engine's claim fence, composed over the real managed-session service, Links
// service and engine: the moments where a hook, a send or a resume holds an older view of a conversation than the
// engine now has. Every refusal is checked for what it left alone (messages and attempts), not only for what it
// withheld. Contract tests with recorded payloads and a fixture process; not provider acceptance.
import { afterEach, expect, test } from 'bun:test';
import { canonicalCheckout } from './links-service.js';
import { cleanupFixtures, turnFixture } from './links-turn-fixture.js';

afterEach(cleanupFixtures);

const tokenA = 'launch_token_alpha_1234567890';
const tokenB = 'launch_token_bravo_1234567890';
const nativeX = 'native-x';
const nativeY = 'native-y';
const FENCE_REFUSAL = /^LINKS_BINDING_/;

const cwd = (f, name = 'topic') => f.checkouts[name].wtDir;
const sessionStart = (f, token, nativeId, name) =>
  f.hook(token, { cwd: cwd(f, name), event: 'SessionStart', nativeId });
const tupleOf = async (f, sessionId, nativeId) => ({
  checkoutIdentity: (await f.sessions())[sessionId].checkoutIdentity,
  nativeId,
  provider: 'claude-code',
  sessionId,
});
const generationOf = (f, sessionId) =>
  f.state.read('agentSessions').sessions[sessionId].bindingGeneration;
const statuses = async (f, ids) => Promise.all(ids.map((id) => f.status(id)));

async function started(options) {
  const f = await turnFixture(options);
  await f.mailbox();
  await f.startSession({
    id: 'session-a',
    nativeId: nativeX,
    pid: 501,
    token: tokenA,
  });
  return f;
}

test('a hook that authenticated as X and claims after the session moved to Y is refused, and leaves every message and attempt as it was', async () => {
  const f = await started();
  const forX = await f.send({ body: 'for X', sessionId: 'session-a' });
  const staleGeneration = generationOf(f, 'session-a');
  const x = await tupleOf(f, 'session-a', nativeX);

  await sessionStart(f, tokenA, nativeY);
  // The turn for Y publishes Y, so the snapshot is Y at a higher generation; then mail for Y arrives.
  await f.turn('session-a', { nativeId: nativeY, token: tokenA });
  const forY = await f.send({ body: 'for Y', sessionId: 'session-a' });
  expect(generationOf(f, 'session-a')).toBeGreaterThan(staleGeneration);

  const before = await statuses(f, [forX.messageId, forY.messageId]);
  expect(before.map((m) => m.state)).toEqual(['held', 'queued']);

  // The stale hook's claim, as X at X's generation, and also as X at the generation now current.
  const refusals = await Promise.all(
    [staleGeneration, generationOf(f, 'session-a')].map((expectedGeneration) =>
      f.links.claimExact({ expectedGeneration, recipient: x })
    )
  );
  for (const refused of refusals) {
    expect(refused).toMatchObject({ ok: false });
    expect(refused.text).toBeUndefined();
  }
  // The same stale proof for Y's tuple at X's generation fares no better.
  expect(
    await f.links.claimExact({
      expectedGeneration: staleGeneration,
      recipient: await tupleOf(f, 'session-a', nativeY),
    })
  ).toMatchObject({ ok: false });

  expect(await statuses(f, [forX.messageId, forY.messageId])).toEqual(before);
  // Y's own hook still receives exactly its mail, once.
  const turn = await f.turn('session-a', { nativeId: nativeY, token: tokenA });
  expect(turn.stdout).toContain('for Y');
  expect(turn.stdout).not.toContain('for X');
});

test('X, then Y, then X again: a hook proof from the first X cannot claim after the return, only the current generation can', async () => {
  const f = await started();
  const forX = await f.send({ body: 'for X', sessionId: 'session-a' });
  const first = generationOf(f, 'session-a');
  const x = await tupleOf(f, 'session-a', nativeX);

  await sessionStart(f, tokenA, nativeY);
  const second = generationOf(f, 'session-a');
  await sessionStart(f, tokenA, nativeX);
  const third = generationOf(f, 'session-a');
  expect(first < second && second < third).toBe(true);
  // The return released X's mail: it is queued again, and it is still unclaimed.
  expect(await f.stateOf(forX.messageId)).toBe('queued');
  // A turn publishes the returned conversation at its new generation, which is what the fence checks.
  const before = await statuses(f, [forX.messageId]);

  const refusals = await Promise.all(
    [first, second].map((stale) =>
      f.links.claimExact({ expectedGeneration: stale, recipient: x })
    )
  );
  for (const refused of refusals) {
    expect(refused).toMatchObject({ ok: false });
  }
  expect(await statuses(f, [forX.messageId])).toEqual(before);

  const turn = await f.turn('session-a', { nativeId: nativeX, token: tokenA });
  expect(turn.stdout).toContain('for X');
  expect(await f.stateOf(forX.messageId)).toBe('handed-off');
});

test('a claim at a generation the engine never saw published, or for a session that never published, changes nothing', async () => {
  const f = await started({ lifecycleHeartbeatMs: 0 });
  const sent = await f.send({
    body: 'still-waiting-text',
    sessionId: 'session-a',
  });
  const x = await tupleOf(f, 'session-a', nativeX);
  const before = await statuses(f, [sent.messageId]);
  expect(
    await f.links.claimExact({
      expectedGeneration: generationOf(f, 'session-a') + 5,
      recipient: x,
    })
  ).toMatchObject({ ok: false });
  expect(
    await f.links.claimExact({
      expectedGeneration: 1,
      recipient: { ...x, sessionId: 'session-never' },
    })
  ).toMatchObject({ ok: false });
  expect(await statuses(f, [sent.messageId])).toEqual(before);
});

test('a user send whose conversation was replaced while it was in flight does not disturb mail already queued for the newer conversation', async () => {
  const f = await started();
  await sessionStart(f, tokenA, nativeY);
  await f.turn('session-a', { nativeId: nativeY, token: tokenA });
  // The send below resolves its recipient as Y; Y is then replaced by Z, whose mail is already waiting.
  let moved = false;
  let newer;
  f.engineHooks.before = async (op) => {
    if (op === 'send' && !moved) {
      moved = true;
      await sessionStart(f, tokenA, 'native-z');
      await f.turn('session-a', { nativeId: 'native-z', token: tokenA });
      newer = await f.send({
        body: 'for Z',
        key: 'k-z',
        sessionId: 'session-a',
      });
    }
  };
  const late = await f.send({
    body: 'for Y, too late',
    key: 'k-y',
    sessionId: 'session-a',
  });
  f.engineHooks.before = undefined;
  expect(moved).toBe(true);
  expect(late.ok).toBe(true);
  expect(newer.ok).toBe(true);

  // The late mail names Y, so it is not Z's: it never queues for Z, and Z's mail is untouched.
  expect(await f.stateOf(late.messageId)).toBe('held');
  expect(await f.stateOf(newer.messageId)).toBe('queued');
  const turn = await f.turn('session-a', {
    nativeId: 'native-z',
    token: tokenA,
  });
  expect(turn.stdout).toContain('for Z');
  expect(turn.stdout).not.toContain('too late');
  expect(await f.stateOf(late.messageId)).toBe('held');
});

test('two sessions in one checkout branch each receive only their own mail, and one session ending holds only its own', async () => {
  const f = await started();
  await f.startSession({
    id: 'session-b',
    nativeId: 'native-b',
    pid: 502,
    token: tokenB,
  });
  const toA = await f.send({ body: 'only for A', sessionId: 'session-a' });
  const toB = await f.send({ body: 'only for B', sessionId: 'session-b' });

  await f.endSession(501);
  expect(await f.stateOf(toA.messageId)).toBe('held');
  expect(await f.stateOf(toB.messageId)).toBe('queued');
  const turn = await f.turn('session-b', {
    nativeId: 'native-b',
    token: tokenB,
  });
  expect(turn.stdout).toContain('only for B');
  expect(turn.stdout).not.toContain('only for A');
  expect(await f.stateOf(toA.messageId)).toBe('held');
});

// Mail from another session of the same machine, through the engine as that sender would send it.
async function mailFromOtherSession(f, body, key) {
  const identity = (await f.sessions())['session-a'].checkoutIdentity;
  const outcome = await f.client.call('send', {
    body,
    idempotency_key: key,
    project: 'repo',
    recipient: {
      checkout: canonicalCheckout(identity),
      native_id: nativeX,
      provider: 'claude-code',
      session_hint: 'session-a',
    },
    sender: { id: 'sender-session', kind: 'session' },
  });
  expect(outcome.ok).toBe(true);
  return outcome.result.message_id;
}

async function shareProject(f, enable) {
  if (!enable) {
    return await f.links.shareDisable({ repo: 'repo' });
  }
  const review = await f.links.shareEnable({ owner: 'tester', repo: 'repo' });
  expect(review.code).toBe('LINKS_CONFIRMATION_REQUIRED');
  return await f.links.shareEnable({
    confirmation: review.confirmation.token,
    owner: 'tester',
    repo: 'repo',
  });
}

test('a resume under a new record moves every located state to it without replay, and policy holds stay held until sharing returns', async () => {
  const f = await started();
  expect((await shareProject(f, true)).ok).toBe(true);
  const delivered = await f.send({
    body: 'earlier-handed-off-text',
    sessionId: 'session-a',
  });
  await f.turn('session-a', { nativeId: nativeX, token: tokenA });
  const unknown = await f.send({
    body: 'earlier-unknown-text',
    sessionId: 'session-a',
  });
  await f.hook(tokenA, {
    cwd: cwd(f),
    event: 'UserPromptSubmit',
    nativeId: nativeX,
  });
  const waiting = await f.send({
    body: 'still-waiting-text',
    sessionId: 'session-a',
  });
  const shared = await mailFromOtherSession(f, 'from another session', 'k-s');
  expect((await shareProject(f, false)).ok).toBe(true);
  expect(await f.stateOf(delivered.messageId)).toBe('handed-off');
  expect(await f.stateOf(unknown.messageId)).toBe('handoff-unknown');
  expect(await f.stateOf(waiting.messageId)).toBe('queued');
  expect(await f.status(shared)).toMatchObject({
    reason: 'policy-disabled',
    state: 'held',
  });
  await f.endSession(501);

  const review = await f.resumeSession({
    id: 'session-b',
    nativeId: nativeX,
    pid: 502,
    token: tokenB,
  });
  await f.resumeSession({
    confirmation: review.confirmation.token,
    id: 'session-b',
    nativeId: nativeX,
    pid: 502,
    token: tokenB,
  });
  await sessionStart(f, tokenB, nativeX);

  // Every located state now reads as session B's, and none of them was replayed or released by the move.
  const all = [
    delivered.messageId,
    unknown.messageId,
    waiting.messageId,
    shared,
  ];
  for (const message of await statuses(f, all)) {
    expect(message.recipient.currentSessionId).toBe('session-b');
  }
  expect(await f.stateOf(delivered.messageId)).toBe('handed-off');
  expect(await f.stateOf(unknown.messageId)).toBe('handoff-unknown');
  // Held in the store itself, not merely shown as held: the move did not release the policy hold.
  expect(await f.status(shared)).toMatchObject({
    reason: 'policy-disabled',
    state: 'held',
    storedState: 'held',
  });
  const turn = await f.turn('session-b', { nativeId: nativeX, token: tokenB });
  expect(turn.stdout).toContain('still-waiting-text');
  expect(turn.stdout).not.toContain('earlier-handed-off-text');
  expect(turn.stdout).not.toContain('earlier-unknown-text');
  expect(turn.stdout).not.toContain('from another session');
  expect(await f.status(shared)).toMatchObject({ state: 'held' });

  // Sharing returns: only now does the held mail queue, and it reaches B once, naming its sender.
  expect((await shareProject(f, true)).ok).toBe(true);
  expect(await f.stateOf(shared)).toBe('queued');
  const later = await f.turn('session-b', { nativeId: nativeX, token: tokenB });
  expect(later.stdout).toContain('from another session');
  expect(later.stdout).toContain('sender-session');
});

test('with no mailbox yet, a passive read creates nothing, and the first send is delivered at the first turn after it', async () => {
  const f = await turnFixture();
  await f.startSession({
    id: 'session-a',
    nativeId: nativeX,
    pid: 501,
    token: tokenA,
  });
  const { existsSync } = await import('node:fs');
  const { join } = await import('node:path');
  const { MAILBOX_FILE } = await import('./links-client.js');
  const file = join(f.dataDir, MAILBOX_FILE);
  // A turn with no mail, an inbox read and an ended session create no mailbox at all.
  expect(
    (await f.turn('session-a', { nativeId: nativeX, token: tokenA })).stdout
  ).toBe('');
  await f.links.inbox({ name: 'topic', repo: 'repo', sessionId: 'session-a' });
  expect(existsSync(file)).toBe(false);

  // The first send creates it; the next turn publishes its binding before it claims, so the mail arrives.
  const sent = await f.send({ body: 'the very first', sessionId: 'session-a' });
  expect(existsSync(file)).toBe(true);
  const turn = await f.turn('session-a', { nativeId: nativeX, token: tokenA });
  expect(turn.stdout).toContain('the very first');
  expect(await f.stateOf(sent.messageId)).toBe('handed-off');
});

test('an invalidation sent before any mailbox is retried until the mailbox exists, and then holds what arrived in between', async () => {
  const f = await turnFixture();
  await f.startSession({
    id: 'session-a',
    nativeId: nativeX,
    pid: 501,
    token: tokenA,
  });
  await f.startSession({
    id: 'session-b',
    nativeId: 'native-b',
    pid: 502,
    token: tokenB,
  });
  await f.endSession(501);
  const record = () => f.state.read('agentSessions').sessions['session-a'];
  // No mailbox: the invalidation cannot land, so it is not considered told, however often it is tried.
  await f.managed.reconcileSessions();
  expect(record().bindingAnnounced).toBeUndefined();

  // B's first send creates the mailbox. A's old publication (the bind, before the end) never landed.
  const toB = await f.send({ body: 'for B', sessionId: 'session-b' });
  expect(toB.ok).toBe(true);
  await f.managed.reconcileSessions();
  expect(record().bindingAnnounced).toBe(record().bindingGeneration);
  const shown = await f.client.call('binding_show', {
    session_hint: 'session-a',
  });
  expect(shown.result).toMatchObject({
    generation: record().bindingGeneration,
    state: 'invalid',
  });
  // A republish at the generation it had before the end is refused by the fence.
  const old = await f.client.call('binding_publish', {
    generation: 1,
    project: 'repo',
    recipient: {
      checkout: canonicalCheckout(
        (await f.sessions())['session-a'].checkoutIdentity
      ),
      native_id: nativeX,
      provider: 'claude-code',
      session_hint: 'session-a',
    },
    valid_for_ms: 60_000,
  });
  expect(old.ok).toBe(false);
  expect(old.code).toMatch(FENCE_REFUSAL);
});
