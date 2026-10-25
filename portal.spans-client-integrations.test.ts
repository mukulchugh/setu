import { expect, test } from 'bun:test';
import {
  createSpansClientIntegrationsTransport,
  hasUnknownSpansIntegrationApplyOutcome,
  isCurrentSpansIntegrationReview,
  isCurrentSpansIntegrationRevision,
  needsSpansIntegrationReconciliation,
  type SpansClientIntegrationsSummary,
} from './portal/spans-client-integrations';

const digest = `sha256:${'a'.repeat(64)}`;
const summary: SpansClientIntegrationsSummary = {
  clients: ['claude', 'codex', 'cursor'],
  conflicts: [],
  groupDigest: digest,
  operations: [
    {
      client: 'codex',
      consumers: ['codex', 'cursor'],
      digest,
      kind: 'update',
      path: '/fake-home/.agents/skills/setu-spans/SKILL.md',
      version: 'codex-skills-v1',
    },
  ],
  previewDigest: digest,
  ready: true,
  sourceDigest: digest,
  statuses: [
    {
      client: 'claude',
      connected: 'unknown',
      freshSession: 'unknown',
      installed: false,
      skillActivated: 'unknown',
    },
    {
      client: 'codex',
      connected: true,
      freshSession: false,
      installed: true,
      skillActivated: false,
    },
    {
      client: 'cursor',
      connected: false,
      freshSession: 'unknown',
      installed: true,
      skillActivated: 'unknown',
    },
  ],
};

function response(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), {
    headers: { 'content-type': 'application/json' },
    status,
  });
}

function captureFetch(result: Response | Error) {
  const calls: { input: RequestInfo | URL; init?: RequestInit }[] = [];
  const fetcher: typeof fetch = (input, init) => {
    calls.push({ init, input });
    if (result instanceof Error) {
      return Promise.reject(result);
    }
    return Promise.resolve(result);
  };
  return { calls, fetcher };
}

function captureFetchSequence(results: Array<Response | Error>) {
  const calls: { input: RequestInfo | URL; init?: RequestInit }[] = [];
  const fetcher: typeof fetch = (input, init) => {
    calls.push({ init, input });
    const result = results.shift();
    if (result instanceof Error) {
      return Promise.reject(result);
    }
    if (!result) {
      return Promise.reject(new Error('unexpected fetch'));
    }
    return Promise.resolve(result);
  };
  return { calls, fetcher };
}

test('default status uses the GET contract and returns only the summary projection', async () => {
  const { calls, fetcher } = captureFetch(
    response({
      ok: true,
      receipt: { content: 'must not reach the UI' },
      summary: { ...summary, privateContent: 'also omitted' },
    })
  );
  const result =
    await createSpansClientIntegrationsTransport(fetcher).getStatus();

  expect(result.ok).toBe(true);
  expect(String(calls[0]?.input)).toBe('/api/spans/integrations');
  expect(calls[0]?.init?.method).toBe('GET');
  expect(calls[0]?.init?.body).toBeUndefined();
  if (result.ok) {
    expect(result.summary.statuses[0]).toMatchObject({
      connected: 'unknown',
      freshSession: 'unknown',
      installed: false,
      skillActivated: 'unknown',
    });
    expect(result).not.toHaveProperty('receipt');
    expect(result.summary).not.toHaveProperty('privateContent');
  }
});

test('default review sends an empty selection and keeps the phrase challenge typed', async () => {
  const { calls, fetcher } = captureFetch(
    response({
      expiresAt: '2030-01-01T00:00:00.000Z',
      ok: true,
      phrase: 'Apply reviewed Setu integration',
      reviewId: 'b'.repeat(64),
      summary,
    })
  );
  const result = await createSpansClientIntegrationsTransport(fetcher).review();

  expect(String(calls[0]?.input)).toBe('/api/spans/integrations/review');
  expect(calls[0]?.init?.method).toBe('POST');
  expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({});
  expect(calls[0]?.init?.headers).toMatchObject({
    'content-type': 'application/json',
    'x-setu-source': 'ui',
  });
  expect(result.ok && result.phrase).toBe('Apply reviewed Setu integration');
});

test('shared removal names both consumers and the explicit shared-artifact flag', async () => {
  const { calls, fetcher } = captureFetch(
    response({
      expiresAt: '2030-01-01T00:00:00.000Z',
      ok: true,
      phrase: 'Remove shared Codex and Cursor artifact',
      reviewId: 'c'.repeat(64),
      summary,
    })
  );
  await createSpansClientIntegrationsTransport(fetcher).review({
    clients: ['codex', 'cursor'],
    removeSharedArtifact: true,
  });

  expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({
    clients: ['codex', 'cursor'],
    removeSharedArtifact: true,
  });
});

test('apply sends only the review ID and typed response', async () => {
  const applied = captureFetch(
    response({
      applied: [
        {
          client: 'codex',
          digest,
          operationId: 'private-operation-id',
          path: '/fake-home/.agents/skills/setu-spans/SKILL.md',
          status: 'applied',
        },
      ],
      idempotent: false,
      ok: true,
      receipt: { content: 'must not reach the UI' },
    })
  );
  const transport = createSpansClientIntegrationsTransport(applied.fetcher);
  const applyResult = await transport.apply({
    response: 'I reviewed the exact artifact',
    reviewId: 'd'.repeat(64),
  });

  expect(String(applied.calls[0]?.input)).toBe('/api/spans/integrations/apply');
  expect(JSON.parse(String(applied.calls[0]?.init?.body))).toEqual({
    response: 'I reviewed the exact artifact',
    reviewId: 'd'.repeat(64),
  });
  expect(applyResult.ok && applyResult.applied[0]).not.toHaveProperty(
    'receipt'
  );
});

test('reconcile reads the raw reconciliation rows, then gets the refreshed status', async () => {
  const reconciled = captureFetchSequence([
    response({
      ok: true,
      reconciled: [{ operationId: 'receipt-1', status: 'applied' }],
      summary: { untrusted: true },
    }),
    response({ ok: true, summary }),
  ]);
  const result = await createSpansClientIntegrationsTransport(
    reconciled.fetcher
  ).reconcile();

  expect(reconciled.calls.map(({ input }) => String(input))).toEqual([
    '/api/spans/integrations/reconcile',
    '/api/spans/integrations',
  ]);
  expect(reconciled.calls[0]?.init?.method).toBe('POST');
  expect(JSON.parse(String(reconciled.calls[0]?.init?.body))).toEqual({});
  expect(reconciled.calls[1]?.init?.method).toBe('GET');
  expect(reconciled.calls[1]?.init?.body).toBeUndefined();
  expect(result.ok).toBe(true);
  if (result.ok) {
    expect(result.reconciled).toEqual([
      { operationId: 'receipt-1', status: 'applied' },
    ]);
    expect(result.summary).toEqual(summary);
    expect(result).not.toHaveProperty('untrusted');
  }
});

test('unknown reconciliation rows keep the outcome blocked without a status readback', async () => {
  const reconciled = captureFetchSequence([
    response({
      ok: true,
      reconciled: [{ operationId: 'receipt-2', status: 'unknown' }],
    }),
  ]);
  const result = await createSpansClientIntegrationsTransport(
    reconciled.fetcher
  ).reconcile();

  expect(result).toMatchObject({ ok: false, unknown: true });
  expect(reconciled.calls).toHaveLength(1);
});

test('reconcile readback failure remains an unknown outcome', async () => {
  const reconciled = captureFetchSequence([
    response({
      ok: true,
      reconciled: [{ operationId: 'receipt-3', status: 'removed' }],
    }),
    response({ code: 'STATUS_UNAVAILABLE', ok: false }, 503),
  ]);
  const result = await createSpansClientIntegrationsTransport(
    reconciled.fetcher
  ).reconcile();

  expect(result).toMatchObject({
    code: 'STATUS_UNAVAILABLE',
    ok: false,
    unknown: true,
  });
  expect(reconciled.calls.map(({ input }) => String(input))).toEqual([
    '/api/spans/integrations/reconcile',
    '/api/spans/integrations',
  ]);
});

test('ambiguous apply transport failures require reconciliation and cannot be replayed as the same review', async () => {
  const { fetcher } = captureFetch(new Error('offline'));
  const result = await createSpansClientIntegrationsTransport(fetcher).apply({
    response: 'typed phrase',
    reviewId: 'e'.repeat(64),
  });

  expect(hasUnknownSpansIntegrationApplyOutcome(result)).toBe(true);
  expect(isCurrentSpansIntegrationReview('e'.repeat(64), 'e'.repeat(64))).toBe(
    true
  );
  expect(isCurrentSpansIntegrationReview('e'.repeat(64), 'f'.repeat(64))).toBe(
    false
  );
  expect(isCurrentSpansIntegrationRevision(4, 4)).toBe(true);
  expect(isCurrentSpansIntegrationRevision(4, 5)).toBe(false);
});

test('a reconciliation conflict remains a hard block', () => {
  expect(
    needsSpansIntegrationReconciliation({
      ...summary,
      conflicts: [
        {
          client: 'codex',
          code: 'RECONCILIATION_REQUIRED',
          path: '/fake-home/.agents/skills/setu-spans/SKILL.md',
        },
      ],
    })
  ).toBe(true);
});
