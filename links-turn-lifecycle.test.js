// The managed session record is the only authority for a binding's generation: a persisted counter that
// only moves up, on every decision (bind, replacement, resume, end, ownership unknown, verified running
// again, checkout change). These tests drive the trusted publisher seam with a recording publisher. They do
// not test the transport; they pin exactly what it will be told, and in what order.
import { afterEach, expect, test } from 'bun:test';
import {
  cleanupFixtures,
  recordingLifecycle,
  turnFixture,
} from './links-turn-fixture.js';

afterEach(cleanupFixtures);

const tokenA = 'launch_token_alpha_1234567890';
const tokenB = 'launch_token_bravo_1234567890';
const nativeX = 'native-x';

const cwd = (f) => f.checkouts.topic.wtDir;
const start = (f, nativeId) =>
  f.hook(tokenA, { cwd: cwd(f), event: 'SessionStart', nativeId });
// A prompt submission's turn request, without the hook process.
const claimRequest = (f, { token, nativeId }) =>
  f.hook(token, { cwd: cwd(f), event: 'UserPromptSubmit', nativeId });
const generations = (lifecycle, op) =>
  lifecycle.calls
    .filter((call) => call.op === op)
    .map((call) => call.generation);
const sessionA = (f) => {
  const state = f.state.read('agentSessions');
  return state.sessions['session-a'];
};

async function world({ noMailbox = false, ...options } = {}) {
  const lifecycle = recordingLifecycle();
  const f = await turnFixture({ lifecycle, ...options });
  if (!noMailbox) {
    await f.mailbox();
  }
  await f.startSession({
    id: 'session-a',
    nativeId: nativeX,
    pid: 501,
    token: tokenA,
  });
  return { f, lifecycle };
}

test('a first bind publishes generation 1 for exactly the verified conversation, with the repo as its local project', async () => {
  const { f, lifecycle } = await world();
  expect(lifecycle.calls).toHaveLength(1);
  expect(lifecycle.calls[0]).toMatchObject({
    generation: 1,
    op: 'publish',
    project: 'repo',
    recipient: {
      nativeId: nativeX,
      provider: 'claude-code',
      sessionId: 'session-a',
    },
    resumedFrom: [],
  });
  expect(lifecycle.calls[0].recipient.checkoutIdentity).toEqual(
    (await f.sessions())['session-a'].checkoutIdentity
  );
});

test('a repeated start of the same conversation and every normal turn heartbeat at the same generation', async () => {
  const { f, lifecycle } = await world({ lifecycleHeartbeatMs: 0 });
  await start(f, nativeX);
  await f.turn('session-a', { nativeId: nativeX, token: tokenA });
  await f.turn('session-a', { nativeId: nativeX, token: tokenA });
  expect(new Set(generations(lifecycle, 'publish'))).toEqual(new Set([1]));
  expect(generations(lifecycle, 'publish').length).toBeGreaterThanOrEqual(4);
  expect(lifecycle.calls.every((call) => call.op === 'publish')).toBe(true);
});

test('heartbeats are throttled: a turn inside the interval does not publish again', async () => {
  const { f, lifecycle } = await world({ lifecycleHeartbeatMs: 60_000 });
  f.setClock(2000);
  await f.turn('session-a', { nativeId: nativeX, token: tokenA });
  expect(lifecycle.calls).toHaveLength(1);
  f.setClock(1000 + 60_000 + 1);
  await f.turn('session-a', { nativeId: nativeX, token: tokenA });
  expect(lifecycle.calls).toHaveLength(2);
  expect(generations(lifecycle, 'publish')).toEqual([1, 1]);
});

test('replacement and exact return each take a strictly higher generation, even when the clock goes backwards', async () => {
  const { f, lifecycle } = await world();
  f.setClock(5_000_000);
  await start(f, 'native-y');
  f.setClock(10);
  await start(f, nativeX);
  f.setClock(1);
  await start(f, 'native-z');
  const published = generations(lifecycle, 'publish');
  expect(published).toEqual([1, 2, 3, 4]);
  expect(lifecycle.calls.map((call) => call.recipient.nativeId)).toEqual([
    nativeX,
    'native-y',
    nativeX,
    'native-z',
  ]);
  expect((await sessionA(f)).bindingGeneration).toBe(4);
});

test('ending a session invalidates at a generation strictly above its last publish, once confirmed, never again', async () => {
  const { f, lifecycle } = await world();
  await f.endSession(501);
  expect(
    lifecycle.calls.map((call) => [
      call.op,
      call.generation,
      call.reason ?? null,
    ])
  ).toEqual([
    ['publish', 1, null],
    ['invalidate', 2, 'ended'],
  ]);
  await f.managed.reconcileSessions();
  await f.managed.reconcileSessions();
  expect(lifecycle.calls).toHaveLength(2);
  expect((await sessionA(f)).bindingGeneration).toBe(2);
});

test('an invalidation the transport did not confirm is retried at the same generation until it is, and a publish never follows it', async () => {
  const { f, lifecycle } = await world();
  lifecycle.failing = true;
  await f.endSession(501);
  await f.managed.reconcileSessions();
  lifecycle.failing = false;
  await f.managed.reconcileSessions();
  await f.managed.reconcileSessions();
  const invalidations = lifecycle.calls.filter(
    (call) => call.op === 'invalidate'
  );
  expect(invalidations.length).toBeGreaterThanOrEqual(3);
  expect(new Set(invalidations.map((call) => call.generation))).toEqual(
    new Set([2])
  );
  expect(lifecycle.calls.at(-1).op).toBe('invalidate');
  // Confirmed now: nothing more is sent.
  const count = lifecycle.calls.length;
  await f.managed.reconcileSessions();
  expect(lifecycle.calls).toHaveLength(count);
  expect(lifecycle.calls.filter((call) => call.op === 'publish').length).toBe(
    1
  );
});

test('ownership becoming unknown invalidates once; verified running again advances the generation, so it can publish later', async () => {
  const { f, lifecycle } = await world();
  f.reusePid(501);
  await f.managed.reconcileSessions();
  await f.managed.reconcileSessions();
  expect(
    lifecycle.calls
      .filter((call) => call.op === 'invalidate')
      .map((call) => [call.generation, call.reason])
  ).toEqual([[2, 'ownership-unknown']]);
  expect((await sessionA(f)).bindingGeneration).toBe(2);

  // The same process is observed again: that is a decision of its own, strictly above the fence.
  f.reusePid(501, false);
  await f.managed.reconcileSessions();
  expect((await sessionA(f)).bindingGeneration).toBe(3);
  // Ownership stays unknown, so nothing is published for it: a heartbeat for an unverified owner is refused.
  expect(lifecycle.calls.filter((call) => call.op === 'publish')).toHaveLength(
    1
  );
  const before = lifecycle.calls.length;
  await f.managed.reconcileSessions();
  expect(lifecycle.calls).toHaveLength(before);
  expect((await sessionA(f)).bindingGeneration).toBe(3);
});

test('a checkout that was replaced invalidates exactly once, whatever number of hooks keep arriving', async () => {
  const { f, lifecycle } = await world({ names: ['topic'] });
  // The worktree directory is replaced by a new incarnation.
  const fs = await import('node:fs');
  const dir = f.checkouts.topic.wtDir;
  const gitFile = fs.readFileSync(`${dir}/.git`, 'utf8');
  fs.rmSync(dir, { force: true, recursive: true });
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(`${dir}/.git`, gitFile);

  const turn = await f.turn('session-a', { nativeId: nativeX, token: tokenA });
  expect(turn.stdout).toBe('');
  await f.turn('session-a', { nativeId: nativeX, token: tokenA });
  await f.managed.reconcileSessions();
  const invalidations = lifecycle.calls.filter(
    (call) => call.op === 'invalidate'
  );
  expect(invalidations.map((call) => [call.generation, call.reason])).toEqual([
    [2, 'checkout-changed'],
  ]);
});

test('the generation survives a portal restart and never repeats or goes down', async () => {
  const { f, lifecycle } = await world();
  await start(f, 'native-y');
  f.restart();
  await start(f, nativeX);
  await f.endSession(501);
  expect(generations(lifecycle, 'publish')).toEqual([1, 2, 3]);
  expect(generations(lifecycle, 'invalidate')).toEqual([4]);
  expect((await sessionA(f)).bindingGeneration).toBe(4);
});

test('a resumed record has its own generation, tells the publisher where the conversation came from, and the ended one stays fenced', async () => {
  const { f, lifecycle } = await world();
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
  await f.hook(tokenB, {
    cwd: cwd(f),
    event: 'SessionStart',
    nativeId: nativeX,
  });

  const forB = lifecycle.calls.filter(
    (call) =>
      call.recipient?.sessionId === 'session-b' ||
      call.sessionId === 'session-b'
  );
  expect(forB).toHaveLength(1);
  expect(forB[0]).toMatchObject({
    generation: 1,
    op: 'publish',
    project: 'repo',
    resumedFrom: ['session-a'],
  });
  const forA = lifecycle.calls.filter(
    (call) => (call.recipient?.sessionId ?? call.sessionId) === 'session-a'
  );
  expect(forA.map((call) => [call.op, call.generation])).toEqual([
    ['publish', 1],
    ['invalidate', 2],
  ]);
});

test('a publisher that is down or throws never blocks the bind or the turn, and fails delivery closed until it is back', async () => {
  const lifecycle = recordingLifecycle();
  lifecycle.failing = true;
  const f = await turnFixture({ lifecycle });
  await f.mailbox();
  await f.startSession({
    id: 'session-a',
    nativeId: nativeX,
    pid: 501,
    token: tokenA,
  });
  const sent = await f.send({
    body: 'still delivered',
    sessionId: 'session-a',
  });
  // The turn answers at once with nothing: no snapshot of this conversation was ever published, so the
  // engine fence refuses the claim and the message is neither claimed nor attempted.
  const turn = await f.turn('session-a', { nativeId: nativeX, token: tokenA });
  expect(turn.stdout).toBe('');
  expect(await f.stateOf(sent.messageId)).toBe('queued');
  // The publisher recovers: the next turn publishes first, and only then is the mail delivered.
  lifecycle.failing = false;
  const later = await f.turn('session-a', { nativeId: nativeX, token: tokenA });
  expect(later.stdout).toContain('still delivered');
  expect(await f.stateOf(sent.messageId)).toBe('handed-off');
});

test('no counter, history, proof or invalidation detail appears in any public session view', async () => {
  const { f } = await world();
  await start(f, 'native-y');
  await f.endSession(501);
  const text = JSON.stringify(await f.sessions());
  for (const hidden of [
    'bindingGeneration',
    'bindingInvalid',
    'bindingAnnounced',
    'launchProofDigest',
    'history',
    tokenA,
  ]) {
    expect(text).not.toContain(hidden);
  }
});

test('without a publisher composed in, nothing is announced and the generation still advances in the record', async () => {
  const f = await turnFixture();
  await f.startSession({
    id: 'session-a',
    nativeId: nativeX,
    pid: 501,
    token: tokenA,
  });
  await start(f, 'native-y');
  expect((await sessionA(f)).bindingGeneration).toBe(2);
});

// ---- A publisher that hangs or answers badly never holds up a turn or the monitor. ----

test('a publisher that never answers neither hangs a turn nor piles up calls, and the mail stays queued', async () => {
  const lifecycle = recordingLifecycle();
  lifecycle.mode = 'hang';
  const f = await turnFixture({
    lifecycle,
    lifecycleHeartbeatMs: 0,
    lifecycleTimeoutMs: 50,
  });
  await f.mailbox();
  await f.startSession({
    id: 'session-a',
    nativeId: nativeX,
    pid: 501,
    token: tokenA,
  });
  const sent = await f.send({
    body: 'not delivered without a snapshot',
    sessionId: 'session-a',
  });

  const started = Date.now();
  const turn = await f.turn('session-a', { nativeId: nativeX, token: tokenA });
  // A stalled publisher fails closed: the turn is prompt and empty, and the mail is neither claimed nor lost.
  expect(turn.stdout).toBe('');
  expect(await f.stateOf(sent.messageId)).toBe('queued');
  // Many more turns and monitor ticks: still the single unresolved call, no accumulating queue.
  for (let n = 0; n < 5; n += 1) {
    // biome-ignore lint/performance/noAwaitInLoops: Each turn follows the last.
    await f.turn('session-a', { nativeId: nativeX, token: tokenA });
    await f.managed.reconcileSessions();
  }
  expect(Date.now() - started).toBeLessThan(5000);
  expect(lifecycle.calls.filter((call) => call.op === 'publish')).toHaveLength(
    1
  );
});

test('a publish that never settles stays the single outstanding call for the whole uptime', async () => {
  const lifecycle = recordingLifecycle();
  lifecycle.mode = 'hang';
  const f = await turnFixture({
    lifecycle,
    lifecycleHeartbeatMs: 0,
    lifecycleTimeoutMs: 20,
  });
  f.setClock(10_000);
  await f.startSession({
    id: 'session-a',
    nativeId: nativeX,
    pid: 501,
    token: tokenA,
  });
  // Hours of turns and monitor ticks go by; nothing is abandoned, nothing is queued behind it.
  for (let hour = 1; hour <= 6; hour += 1) {
    f.setClock(10_000 + hour * 3_600_000);
    // biome-ignore lint/performance/noAwaitInLoops: Time moves forward one step at a time.
    await f.turn('session-a', { nativeId: nativeX, token: tokenA });
    await f.managed.reconcileSessions();
  }
  expect(lifecycle.calls.filter((call) => call.op === 'publish')).toHaveLength(
    1
  );
});

test('an invalidation is sent promptly while a publish is still unresolved, at a generation that fences it', async () => {
  const lifecycle = recordingLifecycle();
  lifecycle.mode = 'hang';
  const f = await turnFixture({
    lifecycle,
    lifecycleHeartbeatMs: 0,
    lifecycleTimeoutMs: 20,
  });
  await f.startSession({
    id: 'session-a',
    nativeId: nativeX,
    pid: 501,
    token: tokenA,
  });
  const started = Date.now();
  await f.endSession(501);
  expect(Date.now() - started).toBeLessThan(3000);
  const publishes = lifecycle.calls.filter((call) => call.op === 'publish');
  const invalidations = lifecycle.calls.filter(
    (call) => call.op === 'invalidate'
  );
  expect(publishes).toHaveLength(1);
  expect(invalidations.map((call) => call.reason)).toEqual(['ended']);
  // Strictly above the publish still in flight, so a fenced publisher refuses it whenever it lands.
  expect(invalidations[0].generation).toBeGreaterThan(publishes[0].generation);
  // Repeated ticks while that invalidation is itself unresolved do not accumulate more.
  for (let n = 0; n < 5; n += 1) {
    // biome-ignore lint/performance/noAwaitInLoops: Each tick follows the last.
    await f.managed.reconcileSessions();
  }
  expect(
    lifecycle.calls.filter((call) => call.op === 'invalidate')
  ).toHaveLength(1);
});

test('several sessions with unresolved calls are waited on together, not one after another', async () => {
  const lifecycle = recordingLifecycle();
  const f = await turnFixture({
    lifecycle,
    lifecycleHeartbeatMs: 1000,
    lifecycleTimeoutMs: 200,
  });
  f.setClock(1000);
  for (const [id, pid, nativeId, token] of [
    ['session-a', 501, 'native-a', tokenA],
    ['session-b', 502, 'native-b', tokenB],
    ['session-c', 503, 'native-c', 'launch_token_gamma_1234567890'],
  ]) {
    // biome-ignore lint/performance/noAwaitInLoops: Sessions start in a fixed order.
    await f.startSession({ id, nativeId, pid, token });
  }
  lifecycle.mode = 'hang';
  f.setClock(1_000_000);
  const started = Date.now();
  await f.managed.reconcileSessions();
  const took = Date.now() - started;
  expect(
    lifecycle.calls.filter(
      (call) => call.op === 'publish' && call.generation === 1
    )
  ).toHaveLength(6);
  // Three hung calls cost one wait (200 ms), not three.
  expect(took).toBeLessThan(450);
});

test('a monitor tick returns promptly while an invalidation is unanswered, it is not confirmed, and it is retried only once it settled', async () => {
  const lifecycle = recordingLifecycle();
  const f = await turnFixture({ lifecycle, lifecycleTimeoutMs: 50 });
  await f.mailbox();
  await f.startSession({
    id: 'session-a',
    nativeId: nativeX,
    pid: 501,
    token: tokenA,
  });
  lifecycle.mode = 'deferred';
  const started = Date.now();
  await f.endSession(501);
  await f.managed.reconcileSessions();
  await f.managed.reconcileSessions();
  expect(Date.now() - started).toBeLessThan(3000);
  expect(
    lifecycle.calls.filter((call) => call.op === 'invalidate')
  ).toHaveLength(1);
  expect((await sessionA(f)).bindingAnnounced).toBeUndefined();

  // It answers, but not with "told": the next tick sends it again, at the same generation, and only
  // an answer of ok:true confirms it.
  lifecycle.settle({ ok: false });
  await Bun.sleep(10);
  lifecycle.mode = 'ok';
  await f.managed.reconcileSessions();
  const invalidations = lifecycle.calls.filter(
    (call) => call.op === 'invalidate'
  );
  expect(invalidations.map((call) => call.generation)).toEqual([2, 2]);
  expect((await sessionA(f)).bindingAnnounced).toBe(2);
});

for (const mode of ['not-ok', 'null', 'undefined', 'empty', 'wrong-type']) {
  test(`a publish answered with ${mode} is not a heartbeat: the next turn tries again at once`, async () => {
    const lifecycle = recordingLifecycle();
    lifecycle.mode = mode;
    const f = await turnFixture({ lifecycle, lifecycleHeartbeatMs: 60_000 });
    await f.mailbox();
    await f.startSession({
      id: 'session-a',
      nativeId: nativeX,
      pid: 501,
      token: tokenA,
    });
    await f.turn('session-a', { nativeId: nativeX, token: tokenA });
    await f.turn('session-a', { nativeId: nativeX, token: tokenA });
    expect(
      lifecycle.calls.filter((call) => call.op === 'publish')
    ).toHaveLength(3);
    // Only the one reply that says it was told counts, and then the interval throttles.
    lifecycle.mode = 'ok';
    await f.turn('session-a', { nativeId: nativeX, token: tokenA });
    await f.turn('session-a', { nativeId: nativeX, token: tokenA });
    expect(
      lifecycle.calls.filter((call) => call.op === 'publish')
    ).toHaveLength(4);
  });

  test(`an invalidation answered with ${mode} is not confirmed and is retried at the same generation`, async () => {
    const lifecycle = recordingLifecycle();
    const f = await turnFixture({ lifecycle });
    await f.mailbox();
    await f.startSession({
      id: 'session-a',
      nativeId: nativeX,
      pid: 501,
      token: tokenA,
    });
    lifecycle.mode = mode;
    await f.endSession(501);
    await f.managed.reconcileSessions();
    expect((await sessionA(f)).bindingAnnounced).toBeUndefined();
    const invalidations = lifecycle.calls.filter(
      (call) => call.op === 'invalidate'
    );
    expect(invalidations.length).toBeGreaterThanOrEqual(2);
    expect(new Set(invalidations.map((call) => call.generation))).toEqual(
      new Set([2])
    );
    lifecycle.mode = 'ok';
    await f.managed.reconcileSessions();
    expect((await sessionA(f)).bindingAnnounced).toBe(2);
  });
}

// ---- A checkout whose identity returns ----

// The directory is swapped for a different incarnation, then the original is put back. The filesystem
// identity is the same one again, so a hook that proves it with the capability may resume the binding.
async function swapCheckout(f) {
  const fs = await import('node:fs');
  const dir = f.checkouts.topic.wtDir;
  const gitFile = fs.readFileSync(`${dir}/.git`, 'utf8');
  fs.renameSync(dir, `${dir}.away`);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(`${dir}/.git`, gitFile);
  return () => {
    fs.rmSync(dir, { force: true, recursive: true });
    fs.renameSync(`${dir}.away`, dir);
  };
}

test('a checkout that returns clears only its own invalidation: the generation advances and the binding publishes again', async () => {
  const { f, lifecycle } = await world();
  const sent = await f.send({
    body: 'waiting out the swap',
    sessionId: 'session-a',
  });
  const putBack = await swapCheckout(f);

  expect(
    await f.turn('session-a', { nativeId: nativeX, token: tokenA })
  ).toMatchObject({ stdout: '' });
  expect(
    lifecycle.calls
      .filter((call) => call.op === 'invalidate')
      .map((call) => [call.generation, call.reason])
  ).toEqual([[2, 'checkout-changed']]);
  // A passive read says so while a different checkout stands in; nothing was handed off.
  expect(await f.status(sent.messageId)).toMatchObject({
    reason: 'checkout-changed',
    state: 'held',
  });

  putBack();
  const turn = await f.turn('session-a', { nativeId: nativeX, token: tokenA });
  expect(turn.stdout).toContain('waiting out the swap');
  const publishes = lifecycle.calls.filter((call) => call.op === 'publish');
  expect(publishes.map((call) => call.generation)).toEqual([1, 3]);
  expect(publishes.at(-1).recipient.nativeId).toBe(nativeX);
  const record = await sessionA(f);
  expect(record.bindingGeneration).toBe(3);
  expect(record.bindingInvalid).toBeUndefined();
  // Further turns heartbeat at the new generation; nothing else advances it.
  await f.turn('session-a', { nativeId: nativeX, token: tokenA });
  expect((await sessionA(f)).bindingGeneration).toBe(3);
});

test('swapping the checkout again after it returned invalidates again, higher still', async () => {
  const { f, lifecycle } = await world();
  let putBack = await swapCheckout(f);
  await f.turn('session-a', { nativeId: nativeX, token: tokenA });
  putBack();
  await f.turn('session-a', { nativeId: nativeX, token: tokenA });
  putBack = await swapCheckout(f);
  await f.turn('session-a', { nativeId: nativeX, token: tokenA });
  expect(generations(lifecycle, 'invalidate')).toEqual([2, 4]);
  expect(generations(lifecycle, 'publish')).toEqual([1, 3]);
  putBack();
});

test('a hook alone never recovers an ended or unknown session, even when its checkout is fine', async () => {
  const { f, lifecycle } = await world();
  f.reusePid(501);
  await f.managed.reconcileSessions();
  f.reusePid(501, false);
  await f.managed.reconcileSessions();
  const turn = await f.hook(tokenA, {
    cwd: cwd(f),
    event: 'UserPromptSubmit',
    nativeId: nativeX,
  });
  expect(turn).toMatchObject({ ok: false, reason: 'session-not-owned' });
  expect(generations(lifecycle, 'publish')).toEqual([1]);
});

// ---- The restore is judged under the record lock, like a bind ----
//
// A hook whose checkout returned is authenticated only by what is true when the record is updated. Each
// race below lands once, inside the wait for that update, and the answer must be a refusal for exactly
// that reason: never the pre-wait record, never an ended or replaced record read back as authenticated.

// The checkout was swapped away (invalidated), then put back; `race` lands once at the restore's update.
async function returnedCheckout(f, race) {
  await f.send({ body: 'waiting out the race', sessionId: 'session-a' });
  const putBack = await swapCheckout(f);
  await f.turn('session-a', { nativeId: nativeX, token: tokenA });
  putBack();
  f.stateHooks.beforeUpdate = async (key) => {
    if (key !== 'agentSessions') {
      return;
    }
    f.stateHooks.beforeUpdate = undefined;
    await race();
  };
}

const races = [
  {
    name: 'the session ends',
    race: (f) => f.endSession(501),
    reason: 'session-ended',
  },
  {
    name: 'ownership becomes unknown',
    race: async (f) => {
      f.reusePid(501);
      await f.managed.reconcileSessions();
    },
    reason: 'session-not-owned',
  },
  {
    name: 'the conversation is replaced',
    race: (f) => start(f, 'native-y'),
    reason: 'conversation-unbound',
  },
  {
    name: 'the checkout is swapped away again',
    race: async (f) => {
      await swapCheckout(f);
    },
    reason: 'checkout-changed',
  },
];

for (const { name, race, reason } of races) {
  test(`${name} while a returned checkout is being restored: the answer is that refusal, no stale success`, async () => {
    const { f, lifecycle } = await world();
    await returnedCheckout(f, () => race(f));
    const generationBefore = (await sessionA(f)).bindingGeneration;

    const answer = await claimRequest(f, { nativeId: nativeX, token: tokenA });
    expect(answer).toMatchObject({
      code: 'HOOK_BINDING_UNAUTHORIZED',
      ok: false,
      reason,
    });
    // The restore advanced nothing for this conversation: it was published once, at generation 1, and
    // never again after the invalidation (a replacement publishes only the new conversation).
    const forOld = lifecycle.calls.filter(
      (call) => call.op === 'publish' && call.recipient.nativeId === nativeX
    );
    expect(forOld.map((call) => call.generation)).toEqual([1]);
    expect((await sessionA(f)).bindingGeneration).toBeLessThanOrEqual(
      generationBefore + 1
    );
  });
}

test('the same race on the attention and report paths attributes nothing to the ended session', async () => {
  const { f } = await world();
  const sent = await f.send({
    body: 'claimed before the swap',
    sessionId: 'session-a',
  });
  const claimed = await claimRequest(f, { nativeId: nativeX, token: tokenA });
  expect(claimed.ok).toBe(true);
  const putBack = await swapCheckout(f);
  await f.turn('session-a', { nativeId: nativeX, token: tokenA });
  putBack();
  let landed = false;
  f.stateHooks.beforeUpdate = async (key) => {
    if (key === 'agentSessions' && !landed) {
      landed = true;
      await f.endSession(501);
    }
  };
  const report = await f.hook(tokenA, {
    cwd: cwd(f),
    event: 'UserPromptSubmit',
    nativeId: nativeX,
    report: { attemptId: claimed.attemptId },
  });
  expect(report).toMatchObject({ ok: false, reason: 'session-ended' });
  expect(await f.stateOf(sent.messageId)).toBe('handoff-unknown');

  const stop = await f.hook(tokenA, {
    cwd: cwd(f),
    event: 'Stop',
    nativeId: nativeX,
  });
  expect(stop.attention.sessionId).toBeUndefined();
});
