import { afterEach, expect, test } from 'bun:test';
import {
  attentionReview,
  type LinksTarget,
  matchesRedelivery,
  readCapabilities,
  readDirectory,
  readInbox,
  readManagedSessions,
  readMessage,
  redeliveryReview,
  sendFingerprint,
  shareReview,
} from './portal/links-read';

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

const target: LinksTarget = {
  name: 'feat/links',
  repo: 'setu',
  sessionId: 'session-a',
};
const message = (messageId = 'message-a') => ({
  attemptId: 'attempt-a',
  attempts: 1,
  body: 'hello',
  createdAt: 1,
  expiresAt: 2,
  messageId,
  reason: null,
  recipient: {
    nativeId: 'must-not-reach-ui',
    provider: 'claude-code',
    sessionId: 'session-a',
  },
  redeliveries: 0,
  replyTo: null,
  runHint: 'run-1',
  sender: { kind: 'user' },
  size: 5,
  state: 'handoff-unknown',
  storedState: 'handoff-unknown',
  updatedAt: 2,
});

test('Links readers preserve the selected target and omit native session data', async () => {
  const calls: { signal?: AbortSignal | null; url: URL }[] = [];
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input), 'http://fixture.invalid');
    calls.push({ signal: init?.signal, url });
    if (url.pathname === '/api/agent-sessions') {
      return Promise.resolve(
        Response.json({
          ok: true,
          sessions: [
            {
              checkoutIdentity: { private: 'must-not-reach-ui' },
              id: 'session-a',
              name: 'feat/links',
              nativeConversation: {
                id: 'must-not-reach-ui',
                provider: 'claude-code',
                state: 'bound',
              },
              ownership: 'owned',
              repo: 'setu',
              state: 'running',
              tool: 'claude-code',
            },
          ],
        })
      );
    }
    return Promise.resolve(Response.json({ messages: [message()], ok: true }));
  }) as typeof fetch;
  const controller = new AbortController();
  const sessions = await readManagedSessions(controller.signal);
  const inbox = await readInbox(target, controller.signal);
  expect(calls[1]?.url.searchParams.get('repo')).toBe('setu');
  expect(calls[1]?.url.searchParams.get('name')).toBe('feat/links');
  expect(calls[1]?.url.searchParams.get('sessionId')).toBe('session-a');
  expect(calls.every((call) => call.signal === controller.signal)).toBe(true);
  expect(JSON.stringify(sessions)).not.toContain('must-not-reach-ui');
  expect(JSON.stringify(inbox)).not.toContain('must-not-reach-ui');
  expect(inbox).toMatchObject({ messages: [{ runHint: 'run-1' }], ok: true });
});

test('message reads reject a stale response for another selected message', async () => {
  globalThis.fetch = (() =>
    Promise.resolve(
      Response.json({ ...message('other-message'), ok: true })
    )) as typeof fetch;
  await expect(
    readMessage('message-a', new AbortController().signal)
  ).rejects.toThrow('This Links message is unavailable.');
});

test('recovery keys and redelivery consent bind the exact target and input', () => {
  const first = sendFingerprint(target, 'hello', 'reply-a');
  expect(sendFingerprint(target, 'hello', 'reply-a')).toBe(first);
  expect(sendFingerprint(target, 'changed', 'reply-a')).not.toBe(first);
  expect(
    sendFingerprint({ ...target, sessionId: 'session-b' }, 'hello', 'reply-a')
  ).not.toBe(first);
  const review = redeliveryReview({
    attemptId: 'attempt-a',
    messageId: 'message-a',
    recipient: {
      nativeId: 'not-rendered',
      provider: 'claude-code',
      sessionId: 'session-a',
    },
    token: 'review-token',
  });
  if (!review) {
    throw new Error('Expected a redelivery review.');
  }
  expect(matchesRedelivery(review, target, message())).toBe(true);
  expect(
    matchesRedelivery(review, { ...target, sessionId: 'session-b' }, message())
  ).toBe(false);
  expect(
    matchesRedelivery(review, target, { ...message(), attemptId: 'attempt-b' })
  ).toBe(false);
  expect(JSON.stringify(review)).not.toContain('not-rendered');
});

test('Links reads parse directory and capability responses, and reject malformed disclosures', async () => {
  globalThis.fetch = ((input: string | URL | Request) => {
    const url = new URL(String(input), 'http://fixture.invalid');
    if (url.pathname === '/api/links/directory') {
      return Promise.resolve(
        Response.json({
          entries: [
            {
              activityAt: null,
              observedAt: 1,
              owner: 'Mukul',
              project: 'setu',
              reachability: { reason: 'ended', state: 'unreachable' },
              sessionId: 'session-a',
              stale: true,
              task: 'Review Links',
              taskAt: 1,
              taskStale: false,
            },
          ],
          ok: true,
          problems: [],
          staleAfterMs: 120_000,
        })
      );
    }
    return Promise.resolve(
      Response.json({
        ok: true,
        wake: {
          available: false,
          code: 'LINKS_WAKE_UNAVAILABLE',
          error: 'No verified mechanism',
          reason: 'no-verified-mechanism',
        },
      })
    );
  }) as typeof fetch;
  expect(await readDirectory(new AbortController().signal)).toMatchObject({
    entries: [{ reachability: { state: 'unreachable' }, stale: true }],
    ok: true,
  });
  expect(await readCapabilities(new AbortController().signal)).toMatchObject({
    ok: true,
    wake: { available: false, code: 'LINKS_WAKE_UNAVAILABLE' },
  });
  expect(
    shareReview({
      fields: [{ field: 'owner', keys: ['owner'], meaning: 'shown to peers' }],
      never: ['paths'],
      owner: 'Mukul',
      permissions: {
        attention: false,
        interrupt: false,
        receive: true,
        visibility: true,
      },
      project: 'setu',
      token: 'share-token',
    })
  ).toMatchObject({ project: 'setu', token: 'share-token' });
  expect(shareReview({ project: 'setu', token: 'missing-terms' })).toBeNull();
  expect(
    attentionReview({
      effect: 'Adds an attention item but never wakes an agent.',
      never: ['wake', 'work'],
      project: 'setu',
      token: 'attention-token',
    })
  ).toMatchObject({ project: 'setu', token: 'attention-token' });
  expect(
    attentionReview({ never: [], project: 'setu', token: 'bad' })
  ).toBeNull();
});
