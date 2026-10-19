import { describe, expect, test } from 'bun:test';
import {
  associationIdOf,
  LINKS_HISTORY_LIMITS,
  mapEngineBatch,
  projectionKeyOf,
  sanitizeMessageText,
} from './links-history.js';

const STORE = 'st_0123456789abcdef0123456789abcdef';
const RUN = 'run-1';
const idPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

const engineEvent = (patch = {}, message = {}) => ({
  at: 1_700_000_000_000,
  attempt_id: null,
  attempts: 0,
  cancel: 'none',
  expires_at: 1_700_600_000_000,
  first: true,
  message: {
    body: 'Which migration should run first?',
    created_at: 1_700_000_000_000,
    kind: 'message',
    origin: 'local',
    recipient: {
      native_id: 'conv-secret-native-id',
      provider: 'claude-code',
      session_hint: 'sess-1',
    },
    reply_to: null,
    run_hint: 'run-1',
    sender: { kind: 'user' },
    size: 33,
    span_hint: 'span-a',
    ...message,
  },
  message_id: 'm_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  reason: null,
  redeliveries: 0,
  remote_state: null,
  seq: 5,
  stage: null,
  state: 'queued',
  ...patch,
});

const map = (events, extra = {}) =>
  mapEngineBatch({
    events,
    expectedOffset: 0,
    next: events.at(-1)?.seq ?? 0,
    runId: RUN,
    storeId: STORE,
    ...extra,
  });

describe('mapping an engine event', () => {
  test('a first event becomes one message event and its first status event', () => {
    const result = map([engineEvent()]);

    expect(result.ok).toBe(true);
    expect(result.nextOffset).toBe(5);
    expect(result.events.map((e) => e.type)).toEqual([
      'links.message',
      'links.status',
    ]);
    const [message, status] = result.events;
    expect(message.runId).toBe(RUN);
    expect(message.payload).toEqual({
      createdAt: 1_700_000_000_000,
      kind: 'message',
      messageId: 'm_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      origin: 'local',
      projectionVersion: 1,
      recipient: { provider: 'claude-code', sessionId: 'sess-1' },
      replyTo: null,
      runHint: 'run-1',
      size: 33,
      spanHint: 'span-a',
      text: 'Which migration should run first?',
      truncated: false,
    });
    expect(status.payload).toEqual({
      at: 1_700_000_000_000,
      attempts: 0,
      backfill: false,
      cancel: 'none',
      expiresAt: 1_700_600_000_000,
      messageId: 'm_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      projectionVersion: 1,
      reason: null,
      redeliveries: 0,
      remoteState: null,
      seq: 5,
      stage: null,
      state: 'queued',
    });
    for (const event of result.events) {
      expect(event.eventId).toMatch(idPattern);
    }
  });

  test('a later event is only a status event; a status change never rewrites the message row', () => {
    const later = engineEvent({ first: false, seq: 9, state: 'handed-off' });
    const result = map([engineEvent(), later]);

    expect(result.events.map((e) => e.type)).toEqual([
      'links.message',
      'links.status',
      'links.status',
    ]);
    expect(result.events[2].payload).toMatchObject({
      seq: 9,
      state: 'handed-off',
    });
    expect(new Set(result.events.map((e) => e.eventId)).size).toBe(3);
    expect(result.nextOffset).toBe(9);
  });

  test('ids are deterministic and independent of any approval: replay and reapproval cannot conflict', () => {
    const once = map([engineEvent()]).events;
    const again = map([engineEvent()]).events;
    expect(again).toEqual(once);

    // A later batch that re-reads the same engine event from offset zero (a new
    // cursor after reapproval or cursor loss) yields byte-identical events.
    const replay = map([engineEvent()], { expectedOffset: 0 }).events;
    expect(JSON.stringify(replay)).toBe(JSON.stringify(once));

    const otherRun = mapEngineBatch({
      events: [engineEvent()],
      expectedOffset: 0,
      next: 5,
      runId: 'run-2',
      storeId: STORE,
    }).events;
    const otherStore = mapEngineBatch({
      events: [engineEvent()],
      expectedOffset: 0,
      next: 5,
      runId: RUN,
      storeId: 'st_ffffffffffffffffffffffffffffffff',
    }).events;
    for (const [index, event] of once.entries()) {
      expect(otherRun[index].eventId).not.toBe(event.eventId);
      expect(otherStore[index].eventId).not.toBe(event.eventId);
    }
  });

  test('the message event id does not depend on the sequence; status ids do', () => {
    const early = map([engineEvent({ seq: 5 })]).events;
    const late = map([engineEvent({ seq: 50 })]).events;
    expect(late[0].eventId).toBe(early[0].eventId);
    expect(late[1].eventId).not.toBe(early[1].eventId);
  });

  test('only named fields are projected: native ids, checkout and unknown peer fields never reach the archive', () => {
    const hostile = engineEvent(
      { generation: 99, view: { spans: 'done' } },
      {
        checkout: '/Users/someone/private/checkout',
        completion: 'accepted',
        spans: { a: 'done' },
      }
    );
    const text = JSON.stringify(map([hostile]).events);
    expect(text).not.toContain('conv-secret-native-id');
    expect(text).not.toContain('/Users/someone');
    expect(text).not.toContain('accepted');
    expect(text).not.toContain('generation');
    expect(text).not.toContain('"view"');
  });

  test('the kind is carried, not assumed to be a plain message', () => {
    const request = map([engineEvent({}, { kind: 'request' })]);
    expect(request.events[0].payload.kind).toBe('request');
  });

  test('a peer origin and its hint stay namespaced in the payload', () => {
    const peer = map([
      engineEvent({}, { origin: 'peer-key-A', run_hint: 'run-1' }),
    ]);
    expect(peer.events[0].payload).toMatchObject({
      origin: 'peer-key-A',
      runHint: 'run-1',
    });
  });
});

describe('a rejected outbound message', () => {
  test('keeps its own state and outbox stage and is never recorded as handed off', () => {
    const result = map([
      engineEvent({
        reason: 'peer-not-authorized',
        stage: 'rejected',
        state: 'rejected',
      }),
    ]);
    expect(result.ok).toBe(true);
    expect(result.events[1].payload).toMatchObject({
      reason: 'peer-not-authorized',
      stage: 'rejected',
      state: 'rejected',
    });
  });
});

describe('history before the event log existed', () => {
  test('a backfilled event is marked, so display can say earlier history is unknown', () => {
    const result = map([engineEvent({ backfill: true, state: 'handed-off' })]);
    expect(result.events.map((e) => e.type)).toEqual([
      'links.message',
      'links.status',
    ]);
    expect(result.events[1].payload).toMatchObject({
      backfill: true,
      state: 'handed-off',
    });
    expect(result.events[0].payload).not.toHaveProperty('backfill');
  });

  test('the flag must be a boolean when present', () => {
    expect(map([engineEvent({ backfill: 'yes' })]).ok).toBe(false);
    expect(
      map([engineEvent({ backfill: undefined })]).events[1].payload.backfill
    ).toBe(false);
  });
});

describe('inert, redacted, bounded text', () => {
  test('control characters, escape sequences and bidi overrides are removed; markup stays literal', () => {
    const { text } = sanitizeMessageText(
      'a\u0000b\u001b[31mred\u0007‮evil⁦x\u009f\r\nline2\tTab <script>alert(1)</script> [x](javascript:y)'
    );
    expect(text).toBe(
      'ab[31mredevilx\nline2\tTab <script>alert(1)</script> [x](javascript:y)'
    );
  });

  test('secrets are redacted before storage', () => {
    const key = 'sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789';
    const { text } = sanitizeMessageText(
      `use token=hunter2 and ${key} and Authorization: Bearer abcdef123456`
    );
    expect(text).not.toContain('hunter2');
    expect(text).not.toContain(key);
    expect(text).not.toContain('abcdef123456');
    expect(text).toContain('[REDACTED]');
  });

  test('the text is bounded in bytes at a character boundary and the cut is flagged', () => {
    const body = 'é'.repeat(5000);
    const result = sanitizeMessageText(body);
    expect(Buffer.byteLength(result.text, 'utf8')).toBeLessThanOrEqual(
      LINKS_HISTORY_LIMITS.textBytes
    );
    expect(result.truncated).toBe(true);
    expect(result.text).toBe('é'.repeat(LINKS_HISTORY_LIMITS.textBytes / 2));
    expect(sanitizeMessageText('short')).toEqual({
      text: 'short',
      truncated: false,
    });
    // A surrogate pair is never split.
    const pairs = sanitizeMessageText('😀'.repeat(2000));
    expect(pairs.text).toBe('😀'.repeat(LINKS_HISTORY_LIMITS.textBytes / 4));
  });

  test('a secret cut by the bound is never stored in part', () => {
    const body = `${'x'.repeat(4090)} password=supersecretvalue`;
    const { text } = sanitizeMessageText(body);
    expect(text).not.toContain('supersecret');
  });

  test('a private key block that is never closed is still redacted', () => {
    const { text } = sanitizeMessageText(
      `look\n-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAA${'A'.repeat(900)}`
    );
    expect(text).toBe('look\n[REDACTED]');
  });

  test('an oversized legacy body is bounded before any processing', () => {
    const started = performance.now();
    const result = sanitizeMessageText('a'.repeat(5_000_000));
    expect(result.truncated).toBe(true);
    expect(result.text.length).toBe(LINKS_HISTORY_LIMITS.textBytes);
    expect(performance.now() - started).toBeLessThan(500);
  });

  test('reasons and hints are one printable redacted line', () => {
    const result = map([
      engineEvent(
        { reason: 'bad\u001b[0m\ntoken=abc123 reason' },
        { run_hint: 'run-1' }
      ),
    ]);
    const { reason } = result.events[1].payload;
    expect(reason).not.toContain('\n');
    expect(reason).not.toContain('abc123');
  });
});

describe('a bad batch is rejected whole', () => {
  const rejected = (events, extra) => {
    const result = map(events, extra);
    expect(result).toMatchObject({ code: 'LINKS_EVENT_INVALID', ok: false });
    expect(result.events).toBeUndefined();
  };

  test('malformed fields', () => {
    rejected([engineEvent({ seq: -1 })]);
    rejected([engineEvent({ seq: 1.5 })]);
    rejected([engineEvent({ message_id: '../x' })]);
    rejected([engineEvent({ message_id: undefined })]);
    rejected([engineEvent({ state: 'Queued!' })]);
    rejected([engineEvent({ attempts: -1 })]);
    rejected([engineEvent({ first: 'yes' })]);
    rejected([engineEvent({}, { origin: '' })]);
    rejected([engineEvent({}, { run_hint: 7 })]);
    rejected([engineEvent({}, { body: 7 })]);
    rejected([engineEvent({ message: null })]);
    rejected([null]);
  });

  test('sequence order and the reported next offset', () => {
    rejected([engineEvent({ seq: 5 }), engineEvent({ first: false, seq: 5 })]);
    rejected([engineEvent({ seq: 9 }), engineEvent({ first: false, seq: 7 })]);
    rejected([engineEvent({ seq: 5 })], { expectedOffset: 5 });
    rejected([engineEvent({ seq: 5 })], { next: 4 });
    rejected([engineEvent({ seq: 5 })], { next: 2 ** 60 });
  });

  test('a batch past the archive batch bound', () => {
    const many = Array.from({ length: 101 }, (_, index) =>
      engineEvent({ first: false, seq: index + 1 })
    );
    rejected(many);
  });
});

describe('a scan that matched nothing still advances', () => {
  test('no events with a larger next offset is a cursor-only advance', () => {
    expect(map([], { expectedOffset: 10, next: 40 })).toEqual({
      events: [],
      nextOffset: 40,
      ok: true,
    });
    expect(map([], { expectedOffset: 10, next: 10 })).toMatchObject({
      events: [],
      nextOffset: 10,
      ok: true,
    });
    expect(map([], { expectedOffset: 10, next: 3 }).ok).toBe(false);
  });
});

describe('identities', () => {
  test('association ids are namespaced by origin and run', () => {
    const a = associationIdOf({ hint: 'h', origin: 'peer-A', runId: RUN });
    const b = associationIdOf({ hint: 'h', origin: 'peer-B', runId: RUN });
    const c = associationIdOf({ hint: 'h', origin: 'local', runId: RUN });
    const d = associationIdOf({ hint: 'h', origin: 'local', runId: 'run-2' });
    expect(new Set([a, b, c, d]).size).toBe(4);
    for (const id of [a, b, c, d]) {
      expect(id).toMatch(idPattern);
    }
    // Delimiter games cannot make two different triples equal.
    expect(associationIdOf({ hint: 'b:c', origin: 'a', runId: 'r' })).not.toBe(
      associationIdOf({ hint: 'c', origin: 'a:b', runId: 'r' })
    );
  });

  test('the archive cursor is keyed by engine store and association, so a replaced store starts clean', () => {
    const assoc = associationIdOf({ hint: 'h', origin: 'local', runId: RUN });
    const one = projectionKeyOf({ associationId: assoc, storeId: STORE });
    const two = projectionKeyOf({
      associationId: assoc,
      storeId: 'st_ffffffffffffffffffffffffffffffff',
    });
    expect(one.sourceId).not.toBe(two.sourceId);
    expect(one.sourceId).toMatch(idPattern);
    expect(one).toMatchObject({
      parserVersion: 'links-projection-1',
      sourceGeneration: 0,
    });
  });
});
