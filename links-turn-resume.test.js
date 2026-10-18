// Explicit exact resume of one native conversation under a new managed session record, end to end:
// the receiving user's reviewed operation, a fresh owned launch with its own capability, binding only on
// that launch's proof, and the conversation's mail following the conversation. Contract tests with
// recorded payloads and a fixture process; not provider acceptance.
import { afterEach, expect, test } from 'bun:test';
import { cleanupFixtures, turnFixture } from './links-turn-fixture.js';

afterEach(cleanupFixtures);

const tokenA = 'launch_token_alpha_1234567890';
const tokenB = 'launch_token_bravo_1234567890';
const tokenC = 'launch_token_gamma_1234567890';
const nativeX = 'native-x';
const sender = { name: 'topic', repo: 'repo' };

// Session A held X and then went away.
async function endedWithMail(options) {
  const f = await turnFixture(options);
  await f.startSession({
    id: 'session-a',
    nativeId: nativeX,
    pid: 501,
    token: tokenA,
  });
  const sent = await f.send({ body: 'waiting for X', sessionId: 'session-a' });
  await f.endSession(501);
  return { f, id: sent.messageId };
}

async function reviewed(f, extra = {}) {
  const review = await f.resumeSession({
    id: 'session-b',
    nativeId: nativeX,
    pid: 502,
    token: tokenB,
    ...extra,
  });
  expect(review).toMatchObject({
    code: 'RESUME_CONFIRMATION_REQUIRED',
    ok: false,
  });
  return review.confirmation.token;
}

test('resume is two steps: the review launches nothing, and only the exact reviewed token launches a fresh record', async () => {
  const { f } = await endedWithMail();
  const launches = f.launched.length;
  const token = await reviewed(f);
  expect(f.launched).toHaveLength(launches);
  expect(token).toContain(nativeX);

  for (const wrong of ['resume:made-up', `${token}x`, '']) {
    // biome-ignore lint/performance/noAwaitInLoops: Each wrong token is refused against the same state.
    const refused = await f.resumeSession({
      confirmation: wrong,
      id: 'session-b',
      nativeId: nativeX,
      pid: 502,
      token: tokenB,
    });
    expect(refused).toMatchObject({
      code: 'RESUME_CONFIRMATION_REQUIRED',
      ok: false,
    });
  }
  expect(f.launched).toHaveLength(launches);

  const resumed = await f.resumeSession({
    confirmation: token,
    id: 'session-b',
    nativeId: nativeX,
    pid: 502,
    token: tokenB,
  });
  expect(resumed).toMatchObject({ ok: true, session: { id: 'session-b' } });
  expect(f.launched).toHaveLength(launches + 1);
  const script = await Bun.file(f.launched.at(-1).args.at(-3)).text();
  expect(script).toContain("--resume 'native-x'");
  expect(script).toContain(tokenB);
});

test("the resumed conversation binds only through the new launch's capability, and its mail follows it exactly once", async () => {
  const { f, id } = await endedWithMail();
  const confirmation = await reviewed(f);
  await f.resumeSession({
    confirmation,
    id: 'session-b',
    nativeId: nativeX,
    pid: 502,
    token: tokenB,
  });

  const bound = await f.hook(tokenB, {
    cwd: f.checkouts.topic.wtDir,
    event: 'SessionStart',
    nativeId: nativeX,
  });
  expect(bound).toMatchObject({ ok: true, sessionId: 'session-b' });
  expect((await f.sessions())['session-b'].nativeConversation).toMatchObject({
    id: nativeX,
    state: 'bound',
  });
  // The mail is now located at the new record; the original locator and recipient are kept.
  expect(await f.status(id)).toMatchObject({
    recipient: {
      currentSessionId: 'session-b',
      nativeId: nativeX,
      sessionId: 'session-a',
    },
    state: 'queued',
  });
  const inbox = await f.links.inbox({ ...sender, sessionId: 'session-b' });
  expect(inbox.messages.map((m) => m.messageId)).toEqual([id]);

  const turn = await f.turn('session-b', { nativeId: nativeX, token: tokenB });
  expect(turn.stdout).toContain('waiting for X');
  expect(await f.stateOf(id)).toBe('handed-off');
  expect(
    (await f.turn('session-b', { nativeId: nativeX, token: tokenB })).stdout
  ).toBe('');
  // The ended record's capability still resolves nothing (its private launch files are gone with it).
  const ended = await f.hook(tokenA, {
    cwd: f.checkouts.topic.wtDir,
    event: 'UserPromptSubmit',
    nativeId: nativeX,
  });
  expect(ended).toMatchObject({ ok: false, reason: 'session-ended' });
});

test('mail held when the old record replaced the conversation returns when it resumes under the new record', async () => {
  const f = await turnFixture();
  await f.startSession({
    id: 'session-a',
    nativeId: nativeX,
    pid: 501,
    token: tokenA,
  });
  const sent = await f.send({
    body: 'held then resumed',
    sessionId: 'session-a',
  });
  await f.hook(tokenA, {
    cwd: f.checkouts.topic.wtDir,
    event: 'SessionStart',
    nativeId: 'native-y',
  });
  expect(await f.stateOf(sent.messageId)).toBe('held');
  await f.endSession(501);

  const confirmation = await reviewed(f);
  await f.resumeSession({
    confirmation,
    id: 'session-b',
    nativeId: nativeX,
    pid: 502,
    token: tokenB,
  });
  await f.hook(tokenB, {
    cwd: f.checkouts.topic.wtDir,
    event: 'SessionStart',
    nativeId: nativeX,
  });
  expect(await f.stateOf(sent.messageId)).toBe('queued');
  expect(
    (await f.turn('session-b', { nativeId: nativeX, token: tokenB })).stdout
  ).toContain('held then resumed');
});

test('handed-off and unknown mail is not re-emitted after a resume, and the unknown one is redelivered only by explicit review', async () => {
  const f = await turnFixture();
  await f.startSession({
    id: 'session-a',
    nativeId: nativeX,
    pid: 501,
    token: tokenA,
  });
  const delivered = await f.send({
    body: 'delivered before',
    sessionId: 'session-a',
  });
  await f.turn('session-a', { nativeId: nativeX, token: tokenA });
  const unknown = await f.send({
    body: 'claimed, never confirmed',
    sessionId: 'session-a',
  });
  await f.hook(tokenA, {
    cwd: f.checkouts.topic.wtDir,
    event: 'UserPromptSubmit',
    nativeId: nativeX,
  });
  expect(await f.stateOf(unknown.messageId)).toBe('handoff-unknown');
  await f.endSession(501);

  const confirmation = await reviewed(f);
  await f.resumeSession({
    confirmation,
    id: 'session-b',
    nativeId: nativeX,
    pid: 502,
    token: tokenB,
  });
  await f.hook(tokenB, {
    cwd: f.checkouts.topic.wtDir,
    event: 'SessionStart',
    nativeId: nativeX,
  });
  const turn = await f.turn('session-b', { nativeId: nativeX, token: tokenB });
  expect(turn.stdout).toBe('');
  expect(await f.stateOf(delivered.messageId)).toBe('handed-off');
  expect(await f.stateOf(unknown.messageId)).toBe('handoff-unknown');

  // Redelivery through the new record: reviewed, explicit, one new attempt.
  const attempt = (await f.status(unknown.messageId)).attemptId;
  const review = await f.links.redeliver({
    ...sender,
    attemptId: attempt,
    messageId: unknown.messageId,
    sessionId: 'session-b',
  });
  expect(review.code).toBe('LINKS_CONFIRMATION_REQUIRED');
  const done = await f.links.redeliver({
    ...sender,
    attemptId: attempt,
    confirmation: review.confirmation.token,
    messageId: unknown.messageId,
    sessionId: 'session-b',
  });
  expect(done).toMatchObject({ ok: true, state: 'queued' });
  expect(
    (await f.turn('session-b', { nativeId: nativeX, token: tokenB })).stdout
  ).toContain('claimed, never confirmed');
});

test('a conversation is never adopted without the reviewed launch: not by an unrelated start, a live holder, a changed checkout or an unknown ID', async () => {
  const { f, id } = await endedWithMail({ names: ['topic', 'other'] });

  // An unrelated managed launch announcing X is refused: no automatic historical ID adoption.
  await f.startSession({
    bind: false,
    id: 'session-c',
    pid: 503,
    token: tokenC,
  });
  const stray = await f.hook(tokenC, {
    cwd: f.checkouts.topic.wtDir,
    event: 'SessionStart',
    nativeId: nativeX,
  });
  expect(stray).toMatchObject({
    ok: false,
    reason: 'native-conversation-previously-bound',
  });
  expect(await f.stateOf(id)).toBe('queued');

  // An ID no ended record ever held cannot be resumed.
  const unknown = await f.resumeSession({
    id: 'session-d',
    nativeId: 'native-never',
    pid: 504,
    token: tokenB,
  });
  expect(unknown).toMatchObject({ code: 'RESUME_NATIVE_UNKNOWN', ok: false });

  // A different checkout of the same repo is not the conversation's checkout.
  const elsewhere = await f.managed.resume({
    name: 'other',
    nativeId: nativeX,
    repo: 'repo',
  });
  expect(elsewhere).toMatchObject({
    code: 'RESUME_CHECKOUT_CHANGED',
    ok: false,
  });

  // While a live record holds the conversation, nobody can resume it.
  const live = await turnFixture();
  await live.startSession({
    id: 'session-a',
    nativeId: nativeX,
    pid: 501,
    token: tokenA,
  });
  const refused = await live.resumeSession({
    id: 'session-b',
    nativeId: nativeX,
    pid: 502,
    token: tokenB,
  });
  expect(refused).toMatchObject({
    code: 'RESUME_CONVERSATION_IN_USE',
    ok: false,
  });
});

test('a reviewed launch binds only the conversation it was reviewed for, never another historical one', async () => {
  const f = await turnFixture();
  await f.startSession({
    id: 'session-a',
    nativeId: nativeX,
    pid: 501,
    token: tokenA,
  });
  await f.hook(tokenA, {
    cwd: f.checkouts.topic.wtDir,
    event: 'SessionStart',
    nativeId: 'native-z',
  });
  await f.endSession(501);

  const confirmation = await reviewed(f);
  await f.resumeSession({
    confirmation,
    id: 'session-b',
    nativeId: nativeX,
    pid: 502,
    token: tokenB,
  });
  // The launch announces Z, also a historical ID of A, which was never reviewed.
  const other = await f.hook(tokenB, {
    cwd: f.checkouts.topic.wtDir,
    event: 'SessionStart',
    nativeId: 'native-z',
  });
  expect(other).toMatchObject({
    ok: false,
    reason: 'native-conversation-previously-bound',
  });
});

test('the public session view shows where a resumed conversation came from and nothing private', async () => {
  const { f } = await endedWithMail();
  const confirmation = await reviewed(f);
  await f.resumeSession({
    confirmation,
    id: 'session-b',
    nativeId: nativeX,
    pid: 502,
    token: tokenB,
  });
  await f.hook(tokenB, {
    cwd: f.checkouts.topic.wtDir,
    event: 'SessionStart',
    nativeId: nativeX,
  });

  const b = (await f.sessions())['session-b'];
  expect(b.nativeConversation).toMatchObject({
    id: nativeX,
    resumedFrom: ['session-a'],
    state: 'bound',
  });
  const text = JSON.stringify(await f.sessions());
  expect(text).not.toContain('resumeIntent');
  expect(text).not.toContain('launchProofDigest');
  expect(text).not.toContain(tokenB);
});

test('a stored resume intent that no longer matches the ended records, or is corrupt, adopts nothing', async () => {
  for (const corrupt of [
    (intent) => ({ ...intent, from: ['some-other-record'] }),
    (intent) => ({ ...intent, nativeId: 'native-other' }),
    (intent) => ({ ...intent, from: [] }),
    () => 'garbage',
  ]) {
    // biome-ignore lint/performance/noAwaitInLoops: Each corruption needs its own fresh world.
    const { f, id } = await endedWithMail();
    const confirmation = await reviewed(f);
    await f.resumeSession({
      confirmation,
      id: 'session-b',
      nativeId: nativeX,
      pid: 502,
      token: tokenB,
    });
    await f.state.update('agentSessions', (document) => ({
      ...document,
      sessions: {
        ...document.sessions,
        'session-b': {
          ...document.sessions['session-b'],
          resumeIntent: corrupt(document.sessions['session-b'].resumeIntent),
        },
      },
    }));
    const bound = await f.hook(tokenB, {
      cwd: f.checkouts.topic.wtDir,
      event: 'SessionStart',
      nativeId: nativeX,
    });
    expect(bound).toMatchObject({
      ok: false,
      reason: 'native-conversation-previously-bound',
    });
    expect(await f.stateOf(id)).toBe('queued');
    expect((await f.sessions())['session-b'].nativeConversation.state).toBe(
      'pending'
    );
  }
});

test('a resumed conversation resumed again later brings its mail along each time', async () => {
  const { f, id } = await endedWithMail();
  const first = await reviewed(f);
  await f.resumeSession({
    confirmation: first,
    id: 'session-b',
    nativeId: nativeX,
    pid: 502,
    token: tokenB,
  });
  await f.hook(tokenB, {
    cwd: f.checkouts.topic.wtDir,
    event: 'SessionStart',
    nativeId: nativeX,
  });
  await f.endSession(502);

  const second = await f.resumeSession({
    id: 'session-c',
    nativeId: nativeX,
    pid: 503,
    token: tokenC,
  });
  expect(second.confirmation.from.sort()).toEqual(['session-a', 'session-b']);
  await f.resumeSession({
    confirmation: second.confirmation.token,
    id: 'session-c',
    nativeId: nativeX,
    pid: 503,
    token: tokenC,
  });
  await f.hook(tokenC, {
    cwd: f.checkouts.topic.wtDir,
    event: 'SessionStart',
    nativeId: nativeX,
  });
  expect((await f.status(id)).recipient).toMatchObject({
    currentSessionId: 'session-c',
    sessionId: 'session-a',
  });
  expect(
    (await f.turn('session-c', { nativeId: nativeX, token: tokenC })).stdout
  ).toContain('waiting for X');
});
