// Natural-turn delivery, composed: the real managed-session service, Links service and engine binary, the
// portal's real hook route over HTTP, and the real generated hook program run as a child process.
//
// CONTRACT TESTS. Hook payloads are recorded fixtures and the "Claude" is a fixture process. Nothing here is
// evidence about a real Claude session or any provider; live acceptance is recorded separately.
import { afterEach, expect, test } from 'bun:test';
import { cleanupFixtures, turnFixture } from './links-turn-fixture.js';

afterEach(cleanupFixtures);

const tokenA = 'launch_token_alpha_1234567890';
const nativeA = 'native-a';

test('a queued message is written into context once at the next normal turn and then reads handed-off', async () => {
  const f = await turnFixture();
  await f.startSession({
    id: 'session-a',
    nativeId: nativeA,
    pid: 501,
    token: tokenA,
  });
  const sent = await f.send({
    body: 'ping from the user',
    sessionId: 'session-a',
  });
  expect(sent).toMatchObject({ ok: true, state: 'queued' });

  const turn = await f.turn('session-a', { nativeId: nativeA, token: tokenA });
  expect(turn.exitCode).toBe(0);
  expect(turn.stdout).toContain('ping from the user');
  expect(turn.stdout).toContain(sent.messageId);
  expect(await f.stateOf(sent.messageId)).toBe('handed-off');

  const next = await f.turn('session-a', { nativeId: nativeA, token: tokenA });
  expect(next.exitCode).toBe(0);
  expect(next.stdout).toBe('');
});

const tokenB = 'launch_token_bravo_1234567890';
const nativeB = 'native-b';

const cwdOf = (f, name = 'topic') => f.checkouts[name].wtDir;
const attention = async (f) => (await f.managed.listAttention({})).events;

// A turn's hook request exactly as the generated program sends it, without the process.
const claimRequest = (f, { token, nativeId }) =>
  f.hook(token, { cwd: cwdOf(f), event: 'UserPromptSubmit', nativeId });

test('a prompt submission never becomes an attention item, and the hook registers only for Claude launches', async () => {
  const f = await turnFixture();
  await f.startSession({
    id: 'session-a',
    nativeId: nativeA,
    pid: 501,
    token: tokenA,
  });
  const before = (await attention(f)).length;
  await f.turn('session-a', { nativeId: nativeA, token: tokenA });
  expect(await attention(f)).toHaveLength(before);

  const runtime = f.launched.at(-1).args.at(-3);
  const settings = JSON.parse(
    await Bun.file(runtime.replace('launch.zsh', 'claude-settings.json')).text()
  );
  expect(Object.keys(settings.hooks).sort()).toEqual([
    'Notification',
    'PermissionRequest',
    'SessionStart',
    'Stop',
    'UserPromptSubmit',
  ]);
  expect(settings.hooks.UserPromptSubmit[0].hooks[0].timeout).toBe(10);
});

test("a second session in the same repo and branch does not receive the first session's mail", async () => {
  const f = await turnFixture();
  await f.startSession({
    id: 'session-a',
    nativeId: nativeA,
    pid: 501,
    token: tokenA,
  });
  await f.startSession({
    id: 'session-b',
    nativeId: nativeB,
    pid: 502,
    token: tokenB,
  });
  const sent = await f.send({ body: 'for A only', sessionId: 'session-a' });

  const b = await f.turn('session-b', { nativeId: nativeB, token: tokenB });
  expect(b.stdout).toBe('');
  expect(await f.stateOf(sent.messageId)).toBe('queued');

  const a = await f.turn('session-a', { nativeId: nativeA, token: tokenA });
  expect(a.stdout).toContain('for A only');
  expect(await f.stateOf(sent.messageId)).toBe('handed-off');
});

for (const phase of ['before', 'after']) {
  test(`a request with a missing, wrong, cross-session, ended or replaced capability returns no mail, ${phase} a portal restart`, async () => {
    const f = await turnFixture();
    await f.startSession({
      id: 'session-a',
      nativeId: nativeA,
      pid: 501,
      token: tokenA,
    });
    await f.startSession({
      id: 'session-b',
      nativeId: nativeB,
      pid: 502,
      token: tokenB,
    });
    const toA = await f.send({ body: 'for A', sessionId: 'session-a' });
    const toB = await f.send({ body: 'for B', sessionId: 'session-b' });
    if (phase === 'after') {
      f.restart();
    }

    const attempts = [
      { nativeId: nativeA, token: undefined },
      { nativeId: nativeA, token: 'short' },
      { nativeId: nativeA, token: 'launch_token_wrong_1234567890' },
      { nativeId: nativeA, token: tokenB },
      { nativeId: nativeB, token: tokenA },
    ];
    for (const attempt of attempts) {
      // biome-ignore lint/performance/noAwaitInLoops: Each refusal is checked against the same untouched queue.
      const refused = await claimRequest(f, attempt);
      expect(refused.ok).toBe(false);
      expect(JSON.stringify(refused)).not.toContain('for A');
      expect(JSON.stringify(refused)).not.toContain('for B');
    }
    // The generated program with a wrong capability prints nothing either.
    const wrong = await f.turn('session-a', {
      nativeId: nativeA,
      token: 'launch_token_wrong_1234567890',
    });
    expect(wrong).toMatchObject({ exitCode: 0, stdout: '' });
    expect(await f.stateOf(toA.messageId)).toBe('queued');
    expect(await f.stateOf(toB.messageId)).toBe('queued');

    // Replaced: the old capability's native ID resolves nothing once the record moved to another.
    await f.hook(tokenA, {
      cwd: cwdOf(f),
      event: 'SessionStart',
      nativeId: 'native-a-new',
    });
    const replaced = await claimRequest(f, {
      nativeId: nativeA,
      token: tokenA,
    });
    expect(replaced.ok).toBe(false);
    expect(replaced.reason).toBe('conversation-replaced');

    // Ended: its capability resolves nothing, and its mail is not handed over.
    f.exit(502);
    await f.managed.reconcileSessions();
    const ended = await claimRequest(f, { nativeId: nativeB, token: tokenB });
    expect(ended.ok).toBe(false);
    expect(await f.stateOf(toB.messageId)).toBe('queued');
  });
}

test("a replacement conversation in the same managed session does not receive the old conversation's mail, which is held", async () => {
  const f = await turnFixture();
  await f.startSession({
    id: 'session-a',
    nativeId: nativeA,
    pid: 501,
    token: tokenA,
  });
  const sent = await f.send({
    body: 'meant for the first conversation',
    sessionId: 'session-a',
  });

  await f.hook(tokenA, {
    cwd: cwdOf(f),
    event: 'SessionStart',
    nativeId: 'native-a-new',
  });
  const turn = await f.turn('session-a', {
    nativeId: 'native-a-new',
    token: tokenA,
  });
  expect(turn).toMatchObject({ exitCode: 0, stdout: '' });
  expect(await f.status(sent.messageId)).toMatchObject({
    reason: 'conversation-replaced',
    state: 'held',
    storedState: 'held',
  });
});

test('exact resume of the same conversation in the same record emits pending mail once and never re-emits handed-off or unknown mail', async () => {
  const f = await turnFixture();
  await f.startSession({
    id: 'session-a',
    nativeId: nativeA,
    pid: 501,
    token: tokenA,
  });
  const delivered = await f.send({
    body: 'already delivered',
    sessionId: 'session-a',
  });
  await f.turn('session-a', { nativeId: nativeA, token: tokenA });
  expect(await f.stateOf(delivered.messageId)).toBe('handed-off');

  const unknown = await f.send({
    body: 'claimed but never confirmed',
    sessionId: 'session-a',
  });
  await claimRequest(f, { nativeId: nativeA, token: tokenA });
  expect(await f.stateOf(unknown.messageId)).toBe('handoff-unknown');

  const pending = await f.send({
    body: 'waiting for the return',
    sessionId: 'session-a',
  });
  await f.hook(tokenA, {
    cwd: cwdOf(f),
    event: 'SessionStart',
    nativeId: 'native-a-new',
  });
  expect(await f.stateOf(pending.messageId)).toBe('held');

  await f.hook(tokenA, {
    cwd: cwdOf(f),
    event: 'SessionStart',
    nativeId: nativeA,
  });
  expect(await f.stateOf(pending.messageId)).toBe('queued');
  const turn = await f.turn('session-a', { nativeId: nativeA, token: tokenA });
  expect(turn.stdout).toContain('waiting for the return');
  expect(turn.stdout).not.toContain('already delivered');
  expect(turn.stdout).not.toContain('claimed but never confirmed');
  const again = await f.turn('session-a', { nativeId: nativeA, token: tokenA });
  expect(again.stdout).toBe('');
  expect(await f.stateOf(delivered.messageId)).toBe('handed-off');
  expect(await f.stateOf(unknown.messageId)).toBe('handoff-unknown');
  expect(await f.stateOf(pending.messageId)).toBe('handed-off');
});

// ---- The binding moves between authentication and the engine handoff. ----

const replaceConversation = (f, token, nativeId) =>
  f.hook(token, { cwd: cwdOf(f), event: 'SessionStart', nativeId });

for (const moment of ['before', 'after']) {
  test(`the conversation is replaced ${moment} the engine claim: the old hook gets nothing and the new conversation's mail is untouched`, async () => {
    const f = await turnFixture();
    await f.startSession({
      id: 'session-a',
      nativeId: nativeA,
      pid: 501,
      token: tokenA,
    });
    const old = await f.send({
      body: 'for the old conversation',
      key: 'k-old',
      sessionId: 'session-a',
    });

    let moved = false;
    f.engineHooks[moment] = async (op) => {
      if (op === 'claim' && !moved) {
        moved = true;
        await replaceConversation(f, tokenA, 'native-a-new');
      }
    };
    // The old conversation's hook authenticated, then lost its binding mid-handoff.
    const oldHook = await f.turn('session-a', {
      nativeId: nativeA,
      token: tokenA,
    });
    expect(moved).toBe(true);
    expect(oldHook).toMatchObject({ exitCode: 0, stdout: '' });
    f.engineHooks[moment] = undefined;

    // Held when the replacement landed first; unknown (claimed, never shown) when the claim got there first.
    expect(await f.stateOf(old.messageId)).toBe(
      moment === 'before' ? 'held' : 'handoff-unknown'
    );

    const fresh = await f.send({
      body: 'for the new conversation',
      key: 'k-new',
      sessionId: 'session-a',
    });
    const newHook = await f.turn('session-a', {
      nativeId: 'native-a-new',
      token: tokenA,
    });
    expect(newHook.stdout).toContain('for the new conversation');
    expect(newHook.stdout).not.toContain('for the old conversation');
    expect(await f.stateOf(fresh.messageId)).toBe('handed-off');
    expect(await f.stateOf(old.messageId)).not.toBe('handed-off');
  });
}

test('a report from a conversation that has since been replaced confirms nothing', async () => {
  const f = await turnFixture();
  await f.startSession({
    id: 'session-a',
    nativeId: nativeA,
    pid: 501,
    token: tokenA,
  });
  const sent = await f.send({
    body: 'claimed then replaced',
    sessionId: 'session-a',
  });
  const claimed = await claimRequest(f, { nativeId: nativeA, token: tokenA });
  expect(claimed.ok).toBe(true);
  await replaceConversation(f, tokenA, 'native-a-new');

  const late = await f.hook(tokenA, {
    cwd: cwdOf(f),
    event: 'UserPromptSubmit',
    nativeId: nativeA,
    report: { attemptId: claimed.attemptId },
  });
  expect(late.ok).toBe(false);
  expect(await f.stateOf(sent.messageId)).toBe('handoff-unknown');
});

test("a report for another conversation's attempt is refused by the engine", async () => {
  const f = await turnFixture();
  await f.startSession({
    id: 'session-a',
    nativeId: nativeA,
    pid: 501,
    token: tokenA,
  });
  await f.startSession({
    id: 'session-b',
    nativeId: nativeB,
    pid: 502,
    token: tokenB,
  });
  const sent = await f.send({ body: 'for A', sessionId: 'session-a' });
  const claimed = await claimRequest(f, { nativeId: nativeA, token: tokenA });
  const forged = await f.hook(tokenB, {
    cwd: cwdOf(f),
    event: 'UserPromptSubmit',
    nativeId: nativeB,
    report: { attemptId: claimed.attemptId },
  });
  expect(forged).toMatchObject({ code: 'LINKS_RECIPIENT_MISMATCH', ok: false });
  expect(await f.stateOf(sent.messageId)).toBe('handoff-unknown');
});

test('a malformed report is refused and an unreported claim stays unknown', async () => {
  const f = await turnFixture();
  await f.startSession({
    id: 'session-a',
    nativeId: nativeA,
    pid: 501,
    token: tokenA,
  });
  const sent = await f.send({ body: 'for A', sessionId: 'session-a' });
  await claimRequest(f, { nativeId: nativeA, token: tokenA });
  for (const report of [null, {}, { attemptId: 7 }, { attemptId: '../x' }]) {
    // biome-ignore lint/performance/noAwaitInLoops: Each malformed report is judged against the same state.
    const refused = await f.hook(tokenA, {
      cwd: cwdOf(f),
      event: 'UserPromptSubmit',
      nativeId: nativeA,
      report,
    });
    expect(refused.ok).toBe(false);
  }
  expect(await f.stateOf(sent.messageId)).toBe('handoff-unknown');
});

test("the hook sends the portal identity fields only: the user's prompt text never leaves the hook process", async () => {
  const f = await turnFixture();
  await f.startSession({
    id: 'session-a',
    nativeId: nativeA,
    pid: 501,
    token: tokenA,
  });
  await f.send({ body: 'mail', sessionId: 'session-a' });
  const seen = [];
  f.restartServing({
    intercept: async (request, respond) => {
      seen.push(await request.clone().text());
      return respond();
    },
  });
  const secretPrompt = 'my private prompt: rotate the production keys';
  const turn = await f.turn('session-a', {
    nativeId: nativeA,
    prompt: secretPrompt,
    token: tokenA,
  });
  expect(turn.stdout).toContain('mail');
  expect(seen).toHaveLength(2); // the turn request and the report
  for (const body of seen) {
    expect(body).not.toContain('rotate the production keys');
    expect(body).not.toContain('transcript_path');
  }
});

// ---- The directory's activity clock: only an authenticated prompt submission counts. ----

test('an exactly authenticated prompt submission records the portal clock once, and nothing else does', async () => {
  const seen = [];
  const f = await turnFixture({
    recordHookActivity: (input) => {
      seen.push(input);
    },
  });
  await f.startSession({
    id: 'session-a',
    nativeId: nativeA,
    pid: 501,
    token: tokenA,
  });
  await f.startSession({
    id: 'session-b',
    nativeId: nativeB,
    pid: 502,
    token: tokenB,
  });
  // Binding, polling and reconciliation are not activity.
  await f.managed.reconcileSessions();
  await f.managed.recover();
  expect(seen).toEqual([]);

  f.setClock(7777);
  await f.send({ body: 'mail', sessionId: 'session-a' });
  const turn = await f.turn('session-a', { nativeId: nativeA, token: tokenA });
  expect(turn.stdout).toContain('mail');
  // One turn is one record, although the hook also posts its report.
  expect(seen).toEqual([{ at: 7777, id: 'session-a' }]);
});

test('a prompt submission that fails authentication records no activity', async () => {
  const seen = [];
  const f = await turnFixture({
    recordHookActivity: (input) => {
      seen.push(input);
    },
  });
  await f.startSession({
    id: 'session-a',
    nativeId: nativeA,
    pid: 501,
    token: tokenA,
  });
  await f.startSession({
    id: 'session-b',
    nativeId: nativeB,
    pid: 502,
    token: tokenB,
  });
  for (const attempt of [
    { nativeId: nativeA, token: undefined },
    { nativeId: nativeA, token: 'launch_token_wrong_1234567890' },
    { nativeId: nativeA, token: tokenB },
    { nativeId: nativeB, token: tokenA },
  ]) {
    // biome-ignore lint/performance/noAwaitInLoops: Each refusal is judged against the same untouched state.
    await claimRequest(f, attempt);
  }
  // A forged report and a plain Stop-style payload are not turns.
  await f.hook(tokenA, {
    cwd: cwdOf(f),
    event: 'UserPromptSubmit',
    nativeId: nativeA,
    report: { attemptId: 'a_1' },
  });
  await f.hook(tokenA, { cwd: cwdOf(f), event: 'Stop', nativeId: nativeA });
  // Replaced and ended conversations.
  await replaceConversation(f, tokenA, 'native-a-new');
  await claimRequest(f, { nativeId: nativeA, token: tokenA });
  f.exit(502);
  await f.managed.reconcileSessions();
  await claimRequest(f, { nativeId: nativeB, token: tokenB });
  expect(seen).toEqual([]);
});

test('a failing or never-answering activity callback never delays or loses a delivery', async () => {
  for (const callback of [
    () => {
      throw new Error('disk full');
    },
    () => Promise.reject(new Error('disk full')),
    () =>
      new Promise(() => {
        /* never settles */
      }),
  ]) {
    // biome-ignore lint/performance/noAwaitInLoops: Each callback needs its own world.
    const f = await turnFixture({ recordHookActivity: callback });
    await f.startSession({
      id: 'session-a',
      nativeId: nativeA,
      pid: 501,
      token: tokenA,
    });
    const sent = await f.send({
      body: 'still delivered',
      sessionId: 'session-a',
    });
    const turn = await f.turn('session-a', {
      nativeId: nativeA,
      token: tokenA,
    });
    expect(turn.stdout).toContain('still delivered');
    expect(await f.stateOf(sent.messageId)).toBe('handed-off');
  }
});

test('an authenticated normal turn updates the real directory activity clock, while a refused hook and passive polls do not', async () => {
  const f = await turnFixture();
  await f.startSession({
    id: 'session-a',
    nativeId: nativeA,
    pid: 501,
    token: tokenA,
  });
  const review = await f.links.shareEnable({ owner: 'Owner', repo: 'repo' });
  expect(
    await f.links.shareEnable({
      confirmation: review.confirmation.token,
      owner: 'Owner',
      repo: 'repo',
    })
  ).toMatchObject({ ok: true });
  const before = (await f.links.directory({})).entries[0].activityAt;
  f.setClock(3000);
  expect(
    (await f.turn('session-a', { nativeId: nativeA, token: tokenA })).exitCode
  ).toBe(0);
  expect(await f.links.publishPresence()).toMatchObject({ ok: true });
  expect((await f.links.directory({})).entries[0]).toMatchObject({
    activityAt: 3000,
    sessionId: 'session-a',
  });
  expect(before).not.toBe(3000);
  f.setClock(4000);
  expect(
    (
      await claimRequest(f, {
        nativeId: nativeA,
        token: 'launch_token_wrong_1234567890',
      })
    ).ok
  ).toBe(false);
  expect(await f.links.publishPresence()).toMatchObject({ ok: true });
  expect((await f.links.directory({})).entries[0].activityAt).toBe(3000);
});
