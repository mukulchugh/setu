// The managed authority's lifecycle publication against the real composed runtime and the real engine. Nothing
// here fakes an ordering: the runtime is `createLinksRuntime`, the engine is the real program, and a publication
// is stalled by holding the actual engine process (a wrapper that waits on a gate file before running it), so the
// race is a real one between real processes.
import { afterEach, expect, test } from 'bun:test';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { createLinksClient, MAILBOX_FILE } from './links-client.js';
import { ensureEngine, temporaryLinksRoot } from './links-engine-fixture.js';
import { createLinksRuntime } from './links-runtime.js';

const ENGINE = ensureEngine();
const FENCE_REFUSAL = /^LINKS_BINDING_/;
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
const conversation = (sessionId, nativeId) => ({
  checkoutIdentity,
  nativeId,
  provider: 'claude-code',
  sessionId,
});
const record = (id, nativeId) => ({
  checkoutIdentity,
  checkoutPath: '/nowhere',
  id,
  name: 'topic',
  nativeConversation: {
    boundAt: 1,
    id: nativeId,
    provider: 'claude-code',
    state: 'bound',
  },
  ownership: 'owned',
  pid: 4242,
  repo: 'repo',
  state: 'running',
  tool: 'claude-code',
});

// The real engine, except that while the gate's `hold` file exists a binding publication waits (and says so by
// leaving a marker) before the engine runs it. Every other operation runs at once.
function world() {
  const { root, cleanup } = temporaryLinksRoot();
  cleanups.push(cleanup);
  const dataDir = join(root, 'links');
  const gate = join(root, 'gate');
  mkdirSync(gate);
  const wrapper = join(root, 'engine-wrapper.sh');
  writeFileSync(
    wrapper,
    `#!/bin/sh
input=$(cat)
case "$input" in
  *'"op":"binding_publish"'*)
    if [ -e '${gate}/hold' ]; then
      : > "${gate}/started.$$"
      while [ -e '${gate}/hold' ]; do sleep 0.02; done
    fi;;
esac
printf '%s' "$input" | exec '${ENGINE}' "$@"
`
  );
  chmodSync(wrapper, 0o700);
  const sessions = [record('session-a', 'native-x')];
  const runtime = createLinksRuntime({
    enginePath: wrapper,
    isProject: (repo) => repo === 'repo',
    resolveTarget: ({ repo, name }) => ({ checkoutIdentity, name, repo }),
    root: dataDir,
    sessions: { list: () => ({ ok: true, sessions }) },
    taskLabel: () => null,
    timeoutMs: 30_000,
  });
  const direct = createLinksClient({ dataDir, enginePath: ENGINE });
  return {
    dataDir,
    direct,
    hold: () => writeFileSync(join(gate, 'hold'), ''),
    release: () => rmSync(join(gate, 'hold'), { force: true }),
    runtime,
    sessions,
    started: () =>
      readdirSync(gate).filter((name) => name.startsWith('started.')).length,
  };
}

async function untilStarted(w, count) {
  const deadline = Date.now() + 10_000;
  while (w.started() < count) {
    if (Date.now() > deadline) {
      throw new Error('the held engine process never started');
    }
    // biome-ignore lint/performance/noAwaitInLoops: Polling for a real process to reach its gate.
    await Bun.sleep(10);
  }
}

const shown = async (w, sessionId) =>
  (await w.direct.call('binding_show', { session_hint: sessionId })).result;

test('a data directory that exists without a mailbox is no mailbox: neither lifecycle call starts an engine or creates one', async () => {
  const w = world();
  // The engine keeps other state in its directory (its identity, transport state), and a first write can fail
  // after the directory was made. None of that is a mailbox.
  mkdirSync(w.dataDir, { mode: 0o700 });
  writeFileSync(join(w.dataDir, 'identity.key'), 'not a mailbox');
  w.hold();

  const publish = await w.runtime.lifecycle.publish({
    generation: 1,
    project: 'repo',
    recipient: conversation('session-a', 'native-x'),
  });
  const invalidate = await w.runtime.lifecycle.invalidate({
    generation: 2,
    reason: 'ended',
    sessionId: 'session-a',
  });
  for (const outcome of [publish, invalidate]) {
    expect(outcome).toMatchObject({ code: 'LINKS_STORE_ABSENT', ok: false });
  }
  // Not even a held process: nothing was launched for the publication that could be stalled outside the engine.
  expect(w.started()).toBe(0);
  expect(existsSync(join(w.dataDir, MAILBOX_FILE))).toBe(false);
});

test('an old publish tried before the first send, a newer invalidation, the first send, and the old publish tried again: the fence lands first and the old one never does', async () => {
  const w = world();
  mkdirSync(w.dataDir, { mode: 0o700 });
  writeFileSync(join(w.dataDir, 'identity.key'), 'not a mailbox');
  w.hold();

  const old = {
    generation: 1,
    project: 'repo',
    recipient: conversation('session-a', 'native-x'),
  };
  const newer = { generation: 2, reason: 'ended', sessionId: 'session-a' };
  // Before any mailbox: both are told "no mailbox", so neither is considered done and neither is in flight.
  expect((await w.runtime.lifecycle.publish(old)).ok).toBe(false);
  expect((await w.runtime.lifecycle.invalidate(newer)).ok).toBe(false);
  expect(w.started()).toBe(0);

  // The first send creates the mailbox, through the same runtime.
  const sent = await w.runtime.linksSend({
    body: 'first',
    idempotencyKey: 'k1',
    name: 'topic',
    repo: 'repo',
    sessionId: 'session-a',
  });
  expect(sent.ok).toBe(true);
  expect(existsSync(join(w.dataDir, MAILBOX_FILE))).toBe(true);
  // The mailbox now has no snapshot for the session, and the mail waits.
  expect(await shown(w, 'session-a')).toMatchObject({ state: 'absent' });

  // The invalidation is retried until it lands; only then is the old publication tried again, and it is refused.
  expect(await w.runtime.lifecycle.invalidate(newer)).toMatchObject({
    ok: true,
  });
  w.release();
  const again = await w.runtime.lifecycle.publish(old);
  expect(again.ok).toBe(false);
  expect(again.code).toMatch(FENCE_REFUSAL);
  expect(await shown(w, 'session-a')).toMatchObject({
    generation: 2,
    state: 'invalid',
  });
  // And the mail the send queued is held, not delivered to anyone.
  expect(
    (await w.direct.call('status', { message_id: sent.messageId })).result
  ).toMatchObject({ state: 'held' });
});

test('with a mailbox, a publish stalled inside its engine process is overtaken by a newer invalidation, and when it finally runs it is refused', async () => {
  const w = world();
  // The mailbox exists from the first send.
  expect(
    (
      await w.runtime.linksSend({
        body: 'first',
        idempotencyKey: 'k1',
        name: 'topic',
        repo: 'repo',
        sessionId: 'session-a',
      })
    ).ok
  ).toBe(true);
  w.hold();

  const late = w.runtime.lifecycle.publish({
    generation: 1,
    project: 'repo',
    recipient: conversation('session-a', 'native-x'),
  });
  await untilStarted(w, 1);

  // The invalidation does not wait for the stalled publication: it lands, and fences generation 1 for good.
  const invalidated = await w.runtime.lifecycle.invalidate({
    generation: 2,
    reason: 'ended',
    sessionId: 'session-a',
  });
  expect(invalidated).toMatchObject({ ok: true });
  expect(await shown(w, 'session-a')).toMatchObject({
    generation: 2,
    state: 'invalid',
  });

  w.release();
  const outcome = await late;
  expect(outcome.ok).toBe(false);
  expect(outcome.code).toMatch(FENCE_REFUSAL);
  expect(await shown(w, 'session-a')).toMatchObject({
    generation: 2,
    state: 'invalid',
  });
  // Nothing the late publication did can be claimed against.
  expect(
    await w.runtime.delivery.claimExact({
      expectedGeneration: 1,
      recipient: conversation('session-a', 'native-x'),
    })
  ).toMatchObject({ ok: false });
});
