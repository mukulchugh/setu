// The handoff failure matrix for natural-turn delivery: the hook, the portal and the engine are each made
// to fail at every boundary, and what is left in the engine is asserted. Contract tests with recorded
// payloads and a fixture process; none of this is provider acceptance.

import { afterEach, expect, test } from 'bun:test';
import { chmodSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ensureEngine } from './links-engine-fixture.js';
import { cleanupFixtures, turnFixture } from './links-turn-fixture.js';

afterEach(cleanupFixtures);

const token = 'launch_token_alpha_1234567890';
const nativeId = 'native-a';
const session = 'session-a';
const text = 'text only the hook may write';
const sender = { name: 'topic', repo: 'repo', sessionId: session };

async function running(options) {
  const f = await turnFixture(options);
  await f.startSession({ id: session, nativeId, pid: 501, token });
  const sent = await f.send({ body: text, sessionId: session });
  return { f, id: sent.messageId };
}

const turn = (f) => f.turn(session, { nativeId, token });

// The explicit, reviewed redelivery the receiving user performs: review first, then the exact token.
async function redeliver(f, id) {
  const before = await f.status(id);
  const review = await f.links.redeliver({
    ...sender,
    attemptId: before.attemptId,
    messageId: id,
  });
  expect(review.code).toBe('LINKS_CONFIRMATION_REQUIRED');
  return f.links.redeliver({
    ...sender,
    attemptId: before.attemptId,
    confirmation: review.confirmation.token,
    messageId: id,
  });
}

// Whatever left the mail unknown, nothing re-emits it, and only an explicit redelivery makes one new,
// counted attempt, which the next normal turn carries once.
async function expectUnknownUntilRedelivered(f, id) {
  expect(await f.stateOf(id)).toBe('handoff-unknown');
  const next = await turn(f);
  expect(next).toMatchObject({ exitCode: 0, stdout: '' });
  expect(await f.stateOf(id)).toBe('handoff-unknown');

  expect(await redeliver(f, id)).toMatchObject({ ok: true, state: 'queued' });
  const again = await turn(f);
  expect(again.stdout.split(text)).toHaveLength(2);
  expect(await f.status(id)).toMatchObject({
    attempts: 2,
    redeliveries: 1,
    state: 'handed-off',
  });
  expect((await turn(f)).stdout).toBe('');
}

// A request that is never answered.
const never = () =>
  new Promise(() => {
    /* never settles */
  });

const bodyOf = async (request) => {
  try {
    return await request.clone().json();
  } catch {
    return {};
  }
};
const reply = (request, respond, { claim, report }) =>
  bodyOf(request).then((body) => (body.report ? report : claim)(respond));

// ---- Failures before the claim: mail stays queued, nothing is emitted, the turn proceeds. ----

test('portal down: nothing is emitted, the turn proceeds and the mail stays queued', async () => {
  const { f, id } = await running();
  f.stopServing();
  expect(await turn(f)).toMatchObject({ exitCode: 0, stdout: '' });
  f.restartServing();
  expect(await f.stateOf(id)).toBe('queued');
  expect((await turn(f)).stdout).toContain(text);
});

test('a bad credential emits nothing and leaves the mail queued', async () => {
  const { f, id } = await running();
  const wrong = await f.turn(session, {
    nativeId,
    token: 'launch_token_wrong_1234567890',
  });
  expect(wrong).toMatchObject({ exitCode: 0, stdout: '' });
  expect(await f.stateOf(id)).toBe('queued');
});

test('engine unavailable: nothing is emitted and the mail stays queued', async () => {
  const { f, id } = await running();
  f.setEngine(join(f.root, 'no-such-engine'));
  expect(await turn(f)).toMatchObject({ exitCode: 0, stdout: '' });
  f.setEngine();
  expect(await f.stateOf(id)).toBe('queued');
});

test('engine too slow before any claim began: nothing is emitted and the mail stays queued', async () => {
  const { f, id } = await running({ engineTimeoutMs: 300 });
  const hang = join(f.root, 'hang-engine');
  writeFileSync(hang, '#!/bin/sh\nexec sleep 30\n');
  chmodSync(hang, 0o755);
  f.setEngine(hang);
  expect(await turn(f)).toMatchObject({ exitCode: 0, stdout: '' });
  f.setEngine();
  expect(await f.stateOf(id)).toBe('queued');
});

// ---- At or after the claim: handoff-unknown, never queued, never re-emitted. ----

const hooksEngine = () => ensureEngine({ hooks: true });

test('engine killed just before the claim commits: nothing was claimed, so the mail stays queued', async () => {
  const { f, id } = await running({ enginePath: hooksEngine() });
  f.killEngineAt('claim:before-commit');
  expect(await turn(f)).toMatchObject({ exitCode: 0, stdout: '' });
  f.killEngineAt(null);
  expect(await f.stateOf(id)).toBe('queued');
});

test('engine killed just after the claim commits: handoff-unknown, nothing emitted, only redelivery makes a new attempt', async () => {
  const { f, id } = await running({ enginePath: hooksEngine() });
  f.killEngineAt('claim:after-commit');
  expect(await turn(f)).toMatchObject({ exitCode: 0, stdout: '' });
  f.killEngineAt(null);
  await expectUnknownUntilRedelivered(f, id);
});

test('response lost on the way to the hook: handoff-unknown, nothing emitted', async () => {
  const { f, id } = await running();
  f.restartServing({
    intercept: (request, respond) =>
      reply(request, respond, {
        claim: async (go) => {
          await go();
          // The portal dies with the answer unsent: the connection drops with no reply.
          f.stopServing();
          return never();
        },
        report: (go) => go(),
      }),
  });
  expect(await turn(f)).toMatchObject({ exitCode: 0, stdout: '' });
  f.restartServing();
  await expectUnknownUntilRedelivered(f, id);
});

test('hook killed after the claim and before it wrote anything: handoff-unknown, nothing emitted', async () => {
  const { f, id } = await running();
  let claimed;
  const reached = new Promise((resolve) => {
    claimed = resolve;
  });
  let release;
  const proceed = new Promise((resolve) => {
    release = resolve;
  });
  f.restartServing({
    intercept: (request, respond) =>
      reply(request, respond, {
        claim: async (go) => {
          const answer = await go();
          claimed();
          await proceed;
          return answer;
        },
        report: (go) => go(),
      }),
  });
  const running_ = f.startTurn(session, { nativeId, token });
  await reached;
  running_.child.kill('SIGKILL');
  const outcome = await running_.done;
  release();
  expect(outcome.stdout).toBe('');
  expect(outcome.exitCode).not.toBe(0);
  f.restartServing();
  await expectUnknownUntilRedelivered(f, id);
});

test('output written, then the hook is killed before its report arrives: handoff-unknown, not queued, not re-emitted', async () => {
  const { f, id } = await running();
  let reportSeen;
  const arrived = new Promise((resolve) => {
    reportSeen = resolve;
  });
  f.restartServing({
    intercept: (request, respond) =>
      reply(request, respond, {
        claim: (go) => go(),
        report: async () => {
          reportSeen();
          await never();
        },
      }),
  });
  const hook = f.startTurn(session, { nativeId, token });
  await arrived;
  hook.child.kill('SIGKILL');
  const outcome = await hook.done;
  // The text did reach the provider's pipe: a failed hook is never presumed to have written nothing.
  expect(outcome.stdout).toContain(text);
  f.restartServing();
  await expectUnknownUntilRedelivered(f, id);
});

test('output written, then the report is refused: handoff-unknown, the next turn does not re-emit it', async () => {
  const { f, id } = await running();
  f.restartServing({
    intercept: (request, respond) =>
      reply(request, respond, {
        claim: (go) => go(),
        report: () => new Response('unavailable', { status: 503 }),
      }),
  });
  const outcome = await turn(f);
  expect(outcome).toMatchObject({ exitCode: 0 });
  expect(outcome.stdout).toContain(text);
  f.restartServing();
  await expectUnknownUntilRedelivered(f, id);
});

test("output written, then the report never gets an answer: handoff-unknown, within the hook's own deadline", async () => {
  const { f, id } = await running();
  f.restartServing({
    intercept: (request, respond) =>
      reply(request, respond, {
        claim: (go) => go(),
        report: () => never(),
      }),
  });
  const started = Date.now();
  const outcome = await turn(f);
  expect(Date.now() - started).toBeLessThan(6500);
  expect(outcome.exitCode).toBe(0);
  expect(outcome.stdout).toContain(text);
  f.restartServing();
  await expectUnknownUntilRedelivered(f, id);
});

test('report received: handed-off, and the same mail is never emitted again', async () => {
  const { f, id } = await running();
  const first = await turn(f);
  expect(first.stdout).toContain(text);
  expect(await f.stateOf(id)).toBe('handed-off');
  expect((await turn(f)).stdout).toBe('');
});

test('portal restarted between the claim and the report: the report is accepted and the mail is handed-off', async () => {
  const { f, id } = await running();
  f.restartServing({
    intercept: (request, respond) =>
      reply(request, respond, {
        claim: (go) => go(),
        report: (go) => {
          // A new portal process over the same disk and engine store answers the report.
          f.restartServing();
          return go();
        },
      }),
  });
  const outcome = await turn(f);
  expect(outcome.stdout).toContain(text);
  expect(await f.stateOf(id)).toBe('handed-off');
});

test("redelivery needs the receiving user's reviewed token: without it nothing is requeued", async () => {
  const { f, id } = await running({ enginePath: hooksEngine() });
  f.killEngineAt('claim:after-commit');
  await turn(f);
  f.killEngineAt(null);
  const before = await f.status(id);
  const refused = await f.links.redeliver({
    ...sender,
    attemptId: before.attemptId,
    confirmation: 'redeliver:made-up',
    messageId: id,
  });
  expect(refused).toMatchObject({
    code: 'LINKS_CONFIRMATION_REQUIRED',
    ok: false,
  });
  expect(await f.stateOf(id)).toBe('handoff-unknown');
});

test("the provider's pipe is closed before the hook can write: no report is sent, so the mail is handoff-unknown", async () => {
  const { f, id } = await running();
  const hook = f.startTurn(session, { closeStdout: true, nativeId, token });
  const outcome = await hook.done;
  expect(outcome.exitCode).toBe(0);
  await expectUnknownUntilRedelivered(f, id);
});

test('a portal that never answers: the hook gives up inside its own deadline, the turn proceeds, and the unreached claim leaves the mail queued', async () => {
  const { f, id } = await running();
  f.restartServing({ intercept: () => never() });
  const started = Date.now();
  const outcome = await turn(f);
  const took = Date.now() - started;
  expect(outcome).toMatchObject({ exitCode: 0, stdout: '' });
  // Claim request cap 3 s, overall deadline 6 s, provider timeout 10 s: well inside the provider's.
  expect(took).toBeLessThan(5000);
  f.restartServing();
  expect(await f.stateOf(id)).toBe('queued');
});
