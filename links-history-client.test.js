import { describe, expect, test } from 'bun:test';
import { createLinksClient } from './links-client.js';

// The client's reply shapes for the operations Links history reads. A real
// child process stands in for the engine and emits the envelope; nothing here
// shows the Rust engine produces these replies.
function replying(result) {
  const program = `const request = await Bun.stdin.json();
console.log(JSON.stringify({ protocol: 'setu-links/1', id: request.id, ok: true, result: ${JSON.stringify(result)} }));`;
  return createLinksClient({
    dataDir: 'unused-fixture-directory',
    enginePath: process.execPath,
    spawn: (_command, options) =>
      Bun.spawn([process.execPath, '-e', program], options),
    timeoutMs: 5000,
  });
}

const message = (patch = {}) => ({
  attempt_id: null,
  attempts: 0,
  created_at: 1,
  expires_at: 2,
  kind: 'message',
  message_id: 'm_1',
  reason: null,
  recipient: {
    checkout: 'c',
    native_id: 'n',
    provider: 'claude-code',
    session_hint: 's',
  },
  redeliveries: 0,
  reply_to: null,
  run_hint: 'run-1',
  sender: { kind: 'user' },
  size: 3,
  span_hint: null,
  state: 'held',
  stored_state: 'held',
  updated_at: 1,
  ...patch,
});

describe('list', () => {
  test('keeps accepting the baseline reply', async () => {
    const reply = await replying({ messages: [message()] }).call('list', {});
    expect(reply.ok).toBe(true);
  });

  test('accepts the run-linked listing: origin per message and a page cursor', async () => {
    const reply = await replying({
      has_more: true,
      messages: [message({ origin: 'peer-A' })],
      next_after: 'm_1',
    }).call('list', { has_run_hint: true, limit: 50 });
    expect(reply).toMatchObject({ ok: true, result: { next_after: 'm_1' } });
  });

  test('refuses what neither shape allows', async () => {
    for (const result of [
      { messages: [message({ surprise: 1 })] },
      { has_more: true, messages: [message()] },
      { messages: [message()], next_after: 7 },
      { messages: [message({ origin: 5 })] },
    ]) {
      // biome-ignore lint/performance/noAwaitInLoops: Each reply is its own child process.
      const reply = await replying(result).call('list', {});
      expect(reply).toMatchObject({
        code: 'LINKS_ENGINE_UNAVAILABLE',
        ok: false,
      });
    }
  });
});

describe('peer_list', () => {
  test('is read loosely: peers with an id, whatever else the roster carries', async () => {
    const reply = await replying({
      peers: [{ label: 'a', peer_id: 'peer-A' }],
    }).call('peer_list', {});
    expect(reply).toMatchObject({ ok: true });
  });

  test('refuses a roster without peer ids', async () => {
    const reply = await replying({ peers: [{ label: 'a' }] }).call(
      'peer_list',
      {}
    );
    expect(reply).toMatchObject({
      code: 'LINKS_ENGINE_UNAVAILABLE',
      ok: false,
    });
  });
});

describe('events', () => {
  const event = (patch = {}) => ({
    at: 1,
    attempt_id: null,
    attempts: 0,
    backfill: false,
    cancel: 'none',
    expires_at: 2,
    first: true,
    message: {
      body: 'b',
      created_at: 1,
      kind: 'message',
      origin: `peer:${'a'.repeat(64)}`,
      recipient: { provider: 'claude-code', session_hint: 's' },
      reply_to: null,
      run_hint: 'run-1',
      sender: { kind: 'peer' },
      size: 1,
      span_hint: null,
    },
    message_id: 'm_1',
    reason: 'peer-not-authorized',
    redeliveries: 0,
    remote_state: null,
    seq: 1,
    stage: 'rejected',
    state: 'rejected',
    ...patch,
  });
  const page = (events) => ({
    events,
    has_more: false,
    head: 1,
    next: 1,
    store_id: 'st_x',
  });

  test('a rejected outbound message is a state of its own, with the outbox stage beside it', async () => {
    const reply = await replying(page([event()])).call('events', {
      after: 0,
      limit: 1,
    });
    expect(reply).toMatchObject({ ok: true });
    expect(reply.result.events[0]).toMatchObject({
      stage: 'rejected',
      state: 'rejected',
    });
  });

  test('an unknown state is refused rather than mapped to something that sounds delivered', async () => {
    const reply = await replying(page([event({ state: 'delivered' })])).call(
      'events',
      {}
    );
    expect(reply).toMatchObject({
      code: 'LINKS_ENGINE_UNAVAILABLE',
      ok: false,
    });
  });

  test('a peer origin keeps its peer: spelling through the client', async () => {
    const reply = await replying(
      page([event({ stage: 'pending', state: 'queued' })])
    ).call('events', {});
    expect(reply.result.events[0].message.origin).toBe(
      `peer:${'a'.repeat(64)}`
    );
  });
});

describe('engine refusals keep their stable codes', () => {
  function refusing(code) {
    const program = `const request = await Bun.stdin.json();
console.log(JSON.stringify({ protocol: 'setu-links/1', id: request.id, ok: false, error: { code: ${JSON.stringify(code)}, message: 'no', retryable: false } }));`;
    return createLinksClient({
      dataDir: 'unused-fixture-directory',
      enginePath: process.execPath,
      spawn: (_command, options) =>
        Bun.spawn([process.execPath, '-e', program], options),
      timeoutMs: 5000,
    });
  }

  test('the codes the history service treats as "engine too old" are exactly what the client produces', async () => {
    for (const [wire, expected] of [
      ['FIELD_UNSUPPORTED', 'LINKS_FIELD_UNSUPPORTED'],
      ['REQUEST_INVALID', 'LINKS_REQUEST_INVALID'],
      ['UNKNOWN_OP', 'LINKS_UNKNOWN_OP'],
    ]) {
      // biome-ignore lint/performance/noAwaitInLoops: Each code is its own child process.
      expect(await refusing(wire).call('list', {})).toMatchObject({
        code: expected,
        ok: false,
      });
    }
  });
});
