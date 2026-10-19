import { describe, expect, test } from 'bun:test';
import {
  canAssociate,
  canRevoke,
  decodeLinksAssociations,
  decodeLinksFailure,
  decodeLinksProjection,
  decodeLinksRecovery,
  decodeLinksReview,
  evidenceSpanChoices,
  groupLinksMessages,
  linksMayHaveExpired,
  linksProjectionSummary,
  linksRejectionCopy,
  linksStateTone,
  recoveryEmptyText,
  WHOLE_RUN_CHOICES,
} from './portal/links-history';
import type { SpansEvent } from './portal/spans-types';

const NONE_ON_PAGE = /none on this page.*more/i;
const CANNOT_BE_SAID = /cannot be said/i;
const NO_APPROVAL_RECORDED = /no approval is recorded/i;

const message = (
  sequence: number,
  payload = {},
  messageId = 'm_1'
): SpansEvent => ({
  eventId: `links.message:${sequence}`,
  payload: {
    createdAt: 1000,
    kind: 'message',
    messageId,
    origin: 'peer-A',
    projectionVersion: 1,
    recipient: { provider: 'claude-code', sessionId: 's1' },
    replyTo: null,
    runHint: 'run-9',
    size: 12,
    spanHint: null,
    text: 'Use migration 12 <b>first</b>',
    truncated: false,
    ...payload,
  },
  runId: 'run-1',
  sequence,
  type: 'links.message',
});
const status = (
  sequence: number,
  seq: number,
  state: string,
  payload = {},
  messageId = 'm_1'
): SpansEvent => ({
  eventId: `links.status:${sequence}`,
  payload: {
    at: 1000 + seq,
    attempts: 0,
    backfill: false,
    cancel: 'none',
    expiresAt: 5000,
    messageId,
    projectionVersion: 1,
    reason: null,
    redeliveries: 0,
    remoteState: null,
    seq,
    stage: null,
    state,
    ...payload,
  },
  runId: 'run-1',
  sequence,
  type: 'links.status',
});
const other = (sequence: number): SpansEvent => ({
  eventId: `e${sequence}`,
  payload: { summary: 'hi' },
  runId: 'run-1',
  sequence,
  type: 'source.message',
});

describe('grouping projected messages for the Conversation', () => {
  test('a message and all its status events are one row showing the latest status', () => {
    const items = groupLinksMessages([
      other(1),
      message(2),
      status(3, 4, 'queued'),
      other(4),
      status(5, 9, 'handed-off'),
      status(6, 7, 'handoff-unknown'),
    ]);
    expect(items.map((i) => i.kind)).toEqual([
      'event',
      'links-message',
      'event',
    ]);
    const row = items[1].kind === 'links-message' ? items[1].row : null;
    expect(row).toMatchObject({
      messageId: 'm_1',
      origin: 'peer-A',
      status: { seq: 9, state: 'handed-off' },
      text: 'Use migration 12 <b>first</b>',
    });
    // The history lists every transition in engine order, newest status wins.
    expect((row ? row.history : []).map((h) => h.state)).toEqual([
      'queued',
      'handoff-unknown',
      'handed-off',
    ]);
  });

  test('a message appears once however many status changes follow, and two messages stay apart', () => {
    const items = groupLinksMessages([
      message(1),
      message(2, {}, 'm_2'),
      status(3, 1, 'queued'),
      status(4, 2, 'queued', {}, 'm_2'),
      status(5, 3, 'acknowledged'),
    ]);
    const rows = items.flatMap((i) =>
      i.kind === 'links-message' ? [i.row] : []
    );
    expect(rows.map((r) => [r.messageId, r.status?.state])).toEqual([
      ['m_1', 'acknowledged'],
      ['m_2', 'queued'],
    ]);
  });

  test('a status whose message is on another page is kept, not dropped or invented', () => {
    const items = groupLinksMessages([status(7, 12, 'handed-off')]);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      kind: 'links-status-only',
      messageId: 'm_1',
    });
  });

  test('a message with no status yet says so', () => {
    const [item] = groupLinksMessages([message(1)]);
    expect(item.kind === 'links-message' && item.row.status).toBeNull();
  });

  test('history before the engine log existed is marked unknown', () => {
    const [item] = groupLinksMessages([
      message(1),
      status(2, 3, 'handed-off', { backfill: true }),
    ]);
    expect(item.kind === 'links-message' && item.row.historyBeforeUnknown).toBe(
      true
    );
    const [plain] = groupLinksMessages([message(1), status(2, 3, 'queued')]);
    expect(
      plain.kind === 'links-message' && plain.row.historyBeforeUnknown
    ).toBe(false);
  });

  test('a truncated copy says it is not the full message', () => {
    const [item] = groupLinksMessages([message(1, { truncated: true })]);
    expect(item.kind === 'links-message' && item.row.truncated).toBe(true);
  });

  test('malformed Links events fall back to plain events instead of throwing', () => {
    const broken: SpansEvent[] = [
      { ...message(1), payload: 'nope' },
      { ...message(2), payload: { text: 5 } },
      { ...status(3, 1, 'queued'), payload: { messageId: 7 } },
    ];
    const items = groupLinksMessages(broken);
    expect(items.map((i) => i.kind)).toEqual(['event', 'event', 'event']);
  });

  test('association and evidence events stay ordinary events', () => {
    const events: SpansEvent[] = [
      {
        eventId: 'a',
        payload: {},
        runId: 'run-1',
        sequence: 1,
        type: 'links.association.approved',
      },
      {
        eventId: 'b',
        payload: {},
        runId: 'run-1',
        sequence: 2,
        type: 'links.evidence.attached',
      },
    ];
    expect(groupLinksMessages(events).map((i) => i.kind)).toEqual([
      'event',
      'event',
    ]);
  });

  test('the same event sequence yields the same rows, so a refresh does not reorder them', () => {
    const events = [message(1), status(2, 1, 'queued'), message(3, {}, 'm_2')];
    expect(groupLinksMessages(events)).toEqual(groupLinksMessages([...events]));
  });
});

describe('qualified expiry', () => {
  test('queued or held mail past its expiry may have expired; settled mail never', () => {
    const rows = (state: string) => {
      const [item] = groupLinksMessages([message(1), status(2, 1, state)]);
      return item.kind === 'links-message' ? item.row : null;
    };
    expect(linksMayHaveExpired(rows('queued') as never, 6000)).toBe(true);
    expect(linksMayHaveExpired(rows('held') as never, 6000)).toBe(true);
    expect(linksMayHaveExpired(rows('queued') as never, 4000)).toBe(false);
    expect(linksMayHaveExpired(rows('handed-off') as never, 6000)).toBe(false);
    expect(linksMayHaveExpired(rows('expired') as never, 6000)).toBe(false);
  });
});

describe('decoding portal answers', () => {
  test('a failure keeps its code and fixed message', () => {
    expect(
      decodeLinksFailure({
        code: 'LINKS_ENGINE_UNAVAILABLE',
        error: 'down',
        ok: false,
      })
    ).toEqual({
      code: 'LINKS_ENGINE_UNAVAILABLE',
      error: 'down',
      ok: false,
    });
    expect(decodeLinksFailure({ ok: true })).toBeNull();
    expect(decodeLinksFailure('x')).toBeNull();
  });

  test('associations: only well-formed rows, with their status', () => {
    const decoded = decodeLinksAssociations({
      associations: [
        {
          associationId: 'a1',
          epoch: 1,
          generation: 0,
          hint: 'h',
          origin: 'local',
          runId: 'run-1',
          status: 'approved',
        },
      ],
      ok: true,
    });
    expect(decoded[0]).toMatchObject({ origin: 'local', status: 'approved' });
    expect(() =>
      decodeLinksAssociations({ associations: [{ status: 'weird' }], ok: true })
    ).toThrow();
    expect(() => decodeLinksAssociations({ ok: true })).toThrow();
  });

  test('a review needs its token and what it binds', () => {
    const review = decodeLinksReview({
      ok: true,
      review: {
        associationId: 'a1',
        generation: 2,
        hint: 'h',
        origin: 'peer-A',
        revision: 4,
        runId: 'run-1',
        status: 'none',
        token: 'associate:abc',
      },
    });
    expect(review).toMatchObject({ generation: 2, token: 'associate:abc' });
    expect(() =>
      decodeLinksReview({ ok: true, review: { token: 3 } })
    ).toThrow();
  });

  test('recovery items carry state, why they are unassociated, and a way to open the message', () => {
    const decoded = decodeLinksRecovery({
      items: [
        {
          disposition: 'unassociated',
          hint: 'h',
          messageId: 'm_1',
          openPath: '/api/links/message?messageId=m_1',
          origin: 'peer-A',
          reason: null,
          rejection: 'unapproved',
          runIds: [],
          spanHint: null,
          state: 'held',
        },
      ],
      kind: 'delivery',
      moreAfter: 'm_1',
      ok: true,
    });
    expect(decoded.items[0]).toMatchObject({
      rejection: 'unapproved',
      state: 'held',
    });
    expect(decoded.moreAfter).toBe('m_1');
    expect(() =>
      decodeLinksRecovery({
        items: [{ messageId: 3 }],
        kind: 'delivery',
        ok: true,
      })
    ).toThrow();
  });

  test('projection status distinguishes absent, unavailable and pending', () => {
    const base = {
      associationId: 'a1',
      engineHead: 5,
      generation: 0,
      hint: 'h',
      origin: 'local',
      projectedThrough: 2,
      status: 'approved',
    };
    expect(
      linksProjectionSummary(
        decodeLinksProjection({
          associations: [{ ...base, pending: true }],
          engine: 'ok',
          ok: true,
        })
      )
    ).toEqual({
      kind: 'pending',
      pending: 1,
    });
    expect(
      linksProjectionSummary(
        decodeLinksProjection({
          associations: [{ ...base, pending: false }],
          engine: 'ok',
          ok: true,
        })
      )
    ).toEqual({
      kind: 'current',
    });
    expect(
      linksProjectionSummary(
        decodeLinksProjection({ associations: [], engine: 'ok', ok: true })
      )
    ).toEqual({ kind: 'none' });
    expect(
      linksProjectionSummary(
        decodeLinksProjection({ associations: [], engine: 'absent', ok: true })
      )
    ).toEqual({ kind: 'engine-absent' });
    expect(
      linksProjectionSummary(
        decodeLinksProjection({
          associations: [],
          engine: 'unavailable',
          ok: true,
        })
      )
    ).toEqual({ kind: 'engine-unavailable' });
    expect(
      linksProjectionSummary(
        decodeLinksProjection({
          associations: [],
          engine: 'unchecked',
          ok: true,
        })
      )
    ).toEqual({ kind: 'none' });
    expect(() =>
      decodeLinksProjection({ engine: 'sideways', ok: true })
    ).toThrow();
  });
});

describe('history that continues on a later page', () => {
  test('rows carry that their status may be newer only when more history exists', () => {
    const events = [message(1), status(2, 1, 'queued')];
    const [partial] = groupLinksMessages(events, { more: true });
    const [whole] = groupLinksMessages(events, { more: false });
    const [plain] = groupLinksMessages(events);
    expect(
      partial.kind === 'links-message' && partial.row.statusMayBeNewer
    ).toBe(true);
    expect(whole.kind === 'links-message' && whole.row.statusMayBeNewer).toBe(
      false
    );
    expect(plain.kind === 'links-message' && plain.row.statusMayBeNewer).toBe(
      false
    );
  });

  test('a message with no status on a page that continues says nothing is known yet, not that it is pending forever', () => {
    const [item] = groupLinksMessages([message(1)], { more: true });
    expect(item.kind === 'links-message' && item.row.status).toBeNull();
    expect(item.kind === 'links-message' && item.row.statusMayBeNewer).toBe(
      true
    );
  });
});

describe('choosing an evidence target', () => {
  test('offers the run itself first and only spans the run really has', () => {
    const view = {
      spans: {
        plan: { spanId: 'plan', title: 'Plan the work' },
        review: { spanId: 'review', title: 'Review' },
      },
    } as unknown as Record<string, never>;
    expect(evidenceSpanChoices(view)).toEqual([
      { id: null, label: 'The run as a whole' },
      { id: 'plan', label: 'plan — Plan the work' },
      { id: 'review', label: 'review — Review' },
    ]);
    expect(evidenceSpanChoices({} as never)).toEqual([
      { id: null, label: 'The run as a whole' },
    ]);
    expect(evidenceSpanChoices({ spans: 'nope' } as never)).toEqual([
      { id: null, label: 'The run as a whole' },
    ]);
  });

  test('stays bounded and says how many spans it left out', () => {
    const spans = Object.fromEntries(
      Array.from({ length: 500 }, (_, i) => [`s${i}`, { title: 't' }])
    );
    const choices = evidenceSpanChoices({ spans } as never);
    expect(choices.length).toBe(102);
    expect(choices[0]).toEqual({ id: null, label: 'The run as a whole' });
    expect(
      choices.slice(1, 101).every((c) => c.id !== null && !c.disabled)
    ).toBe(true);
    const note = choices.at(-1);
    expect(note).toMatchObject({ disabled: true, id: null });
    expect(note?.label).toContain('400 more spans are not listed');
  });

  test('exactly at the bound there is nothing to disclose', () => {
    const spans = Object.fromEntries(
      Array.from({ length: 100 }, (_, i) => [`s${i}`, { title: 't' }])
    );
    const choices = evidenceSpanChoices({ spans } as never);
    expect(choices).toHaveLength(101);
    expect(choices.some((c) => c.disabled)).toBe(false);
  });

  test('a caller that supplies no choices still defaults to the whole run', () => {
    expect(WHOLE_RUN_CHOICES).toEqual([
      { id: null, label: 'The run as a whole' },
    ]);
    expect(WHOLE_RUN_CHOICES).toEqual(evidenceSpanChoices({} as never));
  });
});

describe('recovery wording and actions', () => {
  test('an empty page with more pages does not claim there is nothing', () => {
    expect(recoveryEmptyText('delivery', null)).toBe(
      'No held or uncertain deliveries.'
    );
    expect(recoveryEmptyText('delivery', 'm_9')).toMatch(NONE_ON_PAGE);
    expect(recoveryEmptyText('unassociated', null)).toBe(
      'No messages are waiting for an approval.'
    );
    expect(recoveryEmptyText('unassociated', 'm_9')).toMatch(NONE_ON_PAGE);
  });

  test('Associate is offered for anything not attached, including stale and revoked ones', () => {
    const item = (patch = {}) => ({
      disposition: 'unassociated' as const,
      hint: 'h',
      messageId: 'm_1',
      openPath: '/x',
      origin: 'peer:abc',
      reason: null,
      runIds: [] as string[],
      spanHint: null,
      state: 'held',
      ...patch,
    });
    expect(canAssociate(item())).toBe(true);
    expect(
      canAssociate(item({ rejection: 'stale-generation', runIds: ['run-1'] }))
    ).toBe(true);
    expect(
      canAssociate(item({ rejection: 'revoked', runIds: ['run-1'] }))
    ).toBe(true);
    expect(canAssociate(item({ rejection: 'index-incomplete' }))).toBe(true);
    expect(
      canAssociate(item({ disposition: 'attached', runIds: ['run-1'] }))
    ).toBe(false);
    expect(canAssociate(item({ origin: null }))).toBe(false);
    expect(canAssociate(item({ hint: null }))).toBe(false);
  });

  test('a stale approval can be revoked as well as an approved one', () => {
    expect(canRevoke({ status: 'approved' })).toBe(true);
    expect(canRevoke({ status: 'stale' })).toBe(true);
    expect(canRevoke({ status: 'revoked' })).toBe(false);
  });

  test('every rejection has its own honest words, and an incomplete lookup says it is unknown', () => {
    for (const key of [
      'unapproved',
      'revoked',
      'stale-generation',
      'unknown-run',
      'origin-unknown',
      'index-incomplete',
    ]) {
      expect(linksRejectionCopy(key).length).toBeGreaterThan(10);
    }
    expect(linksRejectionCopy('index-incomplete')).toMatch(CANNOT_BE_SAID);
    expect(linksRejectionCopy('index-incomplete')).not.toMatch(
      NO_APPROVAL_RECORDED
    );
  });
});

describe('state tones', () => {
  test('a rejected message is never shown with a delivered tone', () => {
    expect(linksStateTone('rejected')).toBe('red');
    expect(linksStateTone('handed-off')).toBe('emerald');
    expect(linksStateTone('handoff-unknown')).toBe('amber');
    expect(linksStateTone('something-new')).toBe('zinc');
  });
});
