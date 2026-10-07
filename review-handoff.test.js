import { expect, test } from 'bun:test';
import { createReviewHandoff } from './review-handoff.js';

const target = { name: 'topic', repo: 'app' };
const artifact = { headSha: 'abc123', prNumber: 42, snapshot: 'review-1' };

test('selected findings are delivered to the verified owned session in a bounded editable payload', async () => {
  const delivered = [];
  const session = {
    checkoutIdentity: 'checkout-a',
    id: 'session-1',
    name: 'topic',
    ownership: 'owned',
    repo: 'app',
    state: 'running',
  };
  const handoff = createReviewHandoff({
    deliver: async (message) => {
      delivered.push(message);
      return {
        checkoutIdentity: 'checkout-a',
        ok: true,
        sessionId: 'session-1',
      };
    },
    maxChars: 500,
    sessions: {
      get: (id) => (id === 'session-1' ? session : null),
    },
    verifySession: async () => ({ ok: true, session }),
  });
  const result = await handoff.deliver({
    artifact,
    checkoutIdentity: 'checkout-a',
    findings: [
      {
        context: 'retry output is discarded',
        file: 'workspace-setup.js:73',
        id: 'F-7',
        outcome: 'preserve the failed output',
      },
    ],
    sessionId: 'session-1',
    target,
  });

  expect(result).toMatchObject({
    handoff: { sessionId: 'session-1' },
    ok: true,
  });
  expect(delivered).toHaveLength(1);
  expect(delivered[0].sessionId).toBe('session-1');
  expect(delivered[0].text.length).toBeLessThanOrEqual(500);
  expect(delivered[0].text).toContain('Do not commit, push, or deploy.');
  expect(delivered[0].text).toContain('F-7');
});

test('handoff requires an exact selected session rather than choosing among matching sessions', async () => {
  let delivered = false;
  const handoff = createReviewHandoff({
    deliver: async () => {
      delivered = true;
    },
    sessions: {
      get: () => null,
    },
  });
  await expect(
    handoff.deliver({
      artifact,
      checkoutIdentity: 'checkout-a',
      findings: [{ id: 'F-1', outcome: 'fix it' }],
      target,
    })
  ).resolves.toMatchObject({ code: 'SESSION_SELECTION_REQUIRED', ok: false });
  expect(delivered).toBe(false);
});

test('handoff refuses an artifact that identifies a different checkout', async () => {
  const handoff = createReviewHandoff({
    deliver: async () => {
      throw new Error('must not deliver');
    },
    sessions: {
      get: () => ({
        checkoutIdentity: 'checkout-a',
        id: 'session-1',
        name: 'topic',
        ownership: 'owned',
        repo: 'app',
        state: 'running',
      }),
    },
  });
  await expect(
    handoff.deliver({
      artifact: { ...artifact, checkoutIdentity: 'checkout-b' },
      checkoutIdentity: 'checkout-a',
      findings: [{ id: 'F-1', outcome: 'fix it' }],
      sessionId: 'session-1',
      target,
    })
  ).resolves.toMatchObject({ code: 'CHECKOUT_IDENTITY_MISMATCH', ok: false });
});

test('handoff is bounded even when selected context is oversized', async () => {
  let delivered;
  const session = {
    checkoutIdentity: 'checkout-a',
    id: 'session-1',
    name: 'topic',
    ownership: 'owned',
    repo: 'app',
    state: 'running',
  };
  const handoff = createReviewHandoff({
    deliver: async (message) => {
      delivered = message;
      return {
        checkoutIdentity: 'checkout-a',
        ok: true,
        sessionId: 'session-1',
      };
    },
    maxChars: 220,
    sessions: {
      get: () => session,
    },
    verifySession: async () => ({ ok: true, session }),
  });
  await handoff.deliver({
    artifact,
    checkoutIdentity: 'checkout-a',
    findings: [{ context: 'x'.repeat(2000), id: 'F-1', outcome: 'fix it' }],
    sessionId: 'session-1',
    target,
  });
  expect(delivered.text.length).toBeLessThanOrEqual(220);
  expect(delivered.text).toContain('Do not commit, push, or deploy.');
});

test('handoff refuses a session whose ownership changed during immediate verification', async () => {
  let delivered = false;
  const session = {
    checkoutIdentity: 'checkout-a',
    id: 'session-1',
    name: 'topic',
    ownership: 'owned',
    repo: 'app',
    state: 'running',
  };
  const handoff = createReviewHandoff({
    deliver: async () => {
      delivered = true;
    },
    sessions: { get: () => session },
    verifySession: async () => ({
      ok: true,
      session: { ...session, ownership: 'unknown', state: 'unknown' },
    }),
  });
  await expect(
    handoff.deliver({
      artifact,
      checkoutIdentity: 'checkout-a',
      findings: [{ id: 'F-1', outcome: 'fix it' }],
      sessionId: 'session-1',
      target,
    })
  ).resolves.toMatchObject({ code: 'SESSION_OWNERSHIP_UNKNOWN', ok: false });
  expect(delivered).toBe(false);
});

test('handoff is explicitly unsupported without a reconciliation or delivery adapter', async () => {
  const session = {
    checkoutIdentity: 'checkout-a',
    id: 'session-1',
    name: 'topic',
    ownership: 'owned',
    repo: 'app',
    state: 'running',
  };
  const handoff = createReviewHandoff({
    sessions: { get: () => session },
  });
  await expect(
    handoff.deliver({
      artifact,
      checkoutIdentity: 'checkout-a',
      findings: [{ id: 'F-1', outcome: 'fix it' }],
      sessionId: 'session-1',
      target,
    })
  ).resolves.toMatchObject({
    code: 'SESSION_VERIFICATION_UNAVAILABLE',
    ok: false,
  });
});

test('handoff refuses an adapter that cannot confirm the exact terminal delivery', async () => {
  const session = {
    checkoutIdentity: 'checkout-a',
    id: 'session-1',
    name: 'topic',
    ownership: 'owned',
    repo: 'app',
    state: 'running',
  };
  const handoff = createReviewHandoff({
    deliver: async () => ({ ok: true, sessionId: 'other-session' }),
    sessions: { get: () => session },
    verifySession: async () => ({ ok: true, session }),
  });
  await expect(
    handoff.deliver({
      artifact,
      checkoutIdentity: 'checkout-a',
      findings: [{ id: 'F-1', outcome: 'fix it' }],
      sessionId: 'session-1',
      target,
    })
  ).resolves.toMatchObject({ code: 'HANDOFF_DELIVERY_UNCONFIRMED', ok: false });
});
