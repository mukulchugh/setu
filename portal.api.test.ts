import { expect, test } from 'bun:test';
import { post } from './portal/api';

test('malformed or contradictory mutation responses remain uncertain, never successful', async () => {
  const original = globalThis.fetch;
  try {
    for (const response of [
      Response.json(null),
      Response.json({}),
      Response.json({ ok: 'true' }),
      Response.json({ ok: true }, { status: 503 }),
      new Response('<html>Unavailable</html>'),
    ]) {
      let calls = 0;
      globalThis.fetch = (() => {
        calls += 1;
        return Promise.resolve(response);
      }) as typeof fetch;
      expect(await post('/controlled-action', {})).toMatchObject({
        ok: false,
        networkUncertain: true,
      });
      expect(calls).toBe(1);
    }
  } finally {
    globalThis.fetch = original;
  }
});

test('partial removal and committed save warnings retain their recovery identity', async () => {
  const original = globalThis.fetch;
  try {
    for (const value of [
      {
        ok: false,
        removed: true,
        operationId: 'same-operation',
        pendingSteps: ['routing'],
        error: 'Cleanup pending',
      },
      {
        ok: true,
        committed: true,
        reconciled: true,
        warning: { code: 'STATE_DURABILITY_UNCONFIRMED' },
      },
    ]) {
      globalThis.fetch = (() =>
        Promise.resolve(
          Response.json(value, { status: value.ok ? 200 : 409 })
        )) as typeof fetch;
      expect(await post('/controlled-action', {})).toEqual(value);
    }
  } finally {
    globalThis.fetch = original;
  }
});
