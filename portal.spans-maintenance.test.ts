import { afterEach, describe, expect, test } from 'bun:test';
import {
  hasUnresolvedDestination,
  loadUnresolvedMaintenance,
  retainUnresolvedMaintenance,
  writeUnresolvedMaintenance,
} from './portal/components/spans-maintenance';
import {
  type MaintenanceInput,
  submitSpansMaintenance,
  validateMaintenanceInput,
} from './portal/spans-maintenance';

const originalFetch = globalThis.fetch;
const counts = {
  artifactBytes: 12,
  artifacts: 2,
  cacheEntries: 3,
  databaseBytes: 24,
  events: 4,
  sources: 1,
  views: 5,
};
const restore: MaintenanceInput = {
  backupRoot: '/backup/archive',
  destination: '/restored/archive',
  operation: 'restore',
};

class MemoryStorage {
  values = new Map<string, string>();

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }
}

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    headers: { 'content-type': 'application/json' },
    status,
  });
}

describe('spans maintenance frontend contract', () => {
  test('submits exact backup and restore requests and decodes safe counts', async () => {
    const calls: { input: RequestInfo | URL; init?: RequestInit }[] = [];
    globalThis.fetch = ((input, init) => {
      calls.push({ init, input });
      return Promise.resolve(response({ ok: true, ...counts }));
    }) as typeof fetch;
    expect(
      await submitSpansMaintenance({
        destination: '/backup/new',
        operation: 'backup',
      })
    ).toEqual({ counts, kind: 'success' });
    expect(await submitSpansMaintenance(restore)).toEqual({
      counts,
      kind: 'success',
    });
    expect(
      calls.map(({ input, init }) => [
        input,
        init?.method,
        JSON.parse(String(init?.body)),
      ])
    ).toEqual([
      ['/api/spans/backup', 'POST', { destination: '/backup/new' }],
      [
        '/api/spans/restore',
        'POST',
        { backupRoot: '/backup/archive', destination: '/restored/archive' },
      ],
    ]);
  });

  test('maps known refusal and retained incomplete or unknown results', async () => {
    const results = [
      {
        code: 'SPANS_BACKUP_DESTINATION_EXISTS',
        error: '/private/path leaked',
        ok: false,
      },
      {
        code: 'SPANS_BACKUP_FAILED',
        error: 'details',
        incomplete: true,
        ok: false,
      },
      {
        code: 'SPANS_BACKUP_WORKER_OUTCOME_UNKNOWN',
        error: 'secret',
        ok: false,
        outcomeUnknown: true,
      },
    ];
    globalThis.fetch = (async () => response(results.shift())) as typeof fetch;
    expect(await submitSpansMaintenance(restore)).toEqual({
      kind: 'refused',
      message: 'The destination already exists.',
    });
    expect(await submitSpansMaintenance(restore)).toEqual({
      kind: 'incomplete',
      message: 'The archive operation could not be completed.',
    });
    expect(await submitSpansMaintenance(restore)).toEqual({
      kind: 'unknown',
      message:
        'The result is unknown. Inspect the destination before acting again.',
    });
  });

  test('treats non-success HTTP, malformed and oversized bodies as unknown', async () => {
    globalThis.fetch = (async () =>
      response({ ok: true, ...counts }, 503)) as typeof fetch;
    expect((await submitSpansMaintenance(restore)).kind).toBe('unknown');
    globalThis.fetch = (async () =>
      response({ ok: true, ...counts, path: '/leak' })) as typeof fetch;
    expect((await submitSpansMaintenance(restore)).kind).toBe('unknown');
    globalThis.fetch = (async () =>
      response({
        code: 'UNRECOGNIZED',
        error: 'secret',
        ok: false,
      })) as typeof fetch;
    expect((await submitSpansMaintenance(restore)).kind).toBe('unknown');
    globalThis.fetch = (async () =>
      new Response('x'.repeat(65 * 1024))) as typeof fetch;
    expect((await submitSpansMaintenance(restore)).kind).toBe('unknown');
    globalThis.fetch = (async () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(
              new TextEncoder().encode(
                '{"ok":false,"code":"SPANS_BACKUP_FAILED"'
              )
            );
            controller.error(new Error('private transport detail'));
          },
        })
      )) as typeof fetch;
    const interrupted = await submitSpansMaintenance(restore);
    expect(interrupted.kind).toBe('unknown');
    expect(JSON.stringify(interrupted)).not.toContain(
      'private transport detail'
    );
  });

  test('transport failures are unknown and never retried or exposed', async () => {
    let attempts = 0;
    globalThis.fetch = (() => {
      attempts += 1;
      return Promise.reject(new Error('secret path /private/archive'));
    }) as typeof fetch;
    const result = await submitSpansMaintenance(restore);
    expect(attempts).toBe(1);
    expect(result).toEqual({
      kind: 'unknown',
      message:
        'The result is unknown. Inspect the destination before acting again.',
    });
    expect(JSON.stringify(result)).not.toContain('/private/archive');
  });

  test('rejects invalid paths locally without sending a request', async () => {
    let attempts = 0;
    globalThis.fetch = (() => {
      attempts += 1;
      return Promise.resolve(response({ ok: true, ...counts }));
    }) as typeof fetch;
    for (const destination of [
      '',
      '   ',
      'relative/path',
      '/a/../b',
      '/a/./b',
      '/a\0b',
      ' /leading-space',
      `/${'x'.repeat(64 * 1024)}`,
    ]) {
      const input = { destination, operation: 'backup' } as MaintenanceInput;
      expect(validateMaintenanceInput(input)).toBeString();
      // biome-ignore lint/performance/noAwaitInLoops: Keep the no-request assertion paired with each input.
      expect((await submitSpansMaintenance(input)).kind).toBe('refused');
    }
    expect(
      validateMaintenanceInput({
        backupRoot: '/backup',
        destination: '/to',
        extra: 'x',
        operation: 'restore',
      } as MaintenanceInput)
    ).toBeNull();
    expect(attempts).toBe(0);
  });
});

test('works in a browser without a Node Buffer global', async () => {
  const buffer = globalThis.Buffer;
  const reply = response({ ok: true, ...counts });
  globalThis.fetch = (async () => reply) as typeof fetch;
  try {
    Object.defineProperty(globalThis, 'Buffer', {
      configurable: true,
      value: undefined,
      writable: true,
    });
    expect(await submitSpansMaintenance(restore)).toEqual({
      counts,
      kind: 'success',
    });
  } finally {
    Object.defineProperty(globalThis, 'Buffer', {
      configurable: true,
      value: buffer,
      writable: true,
    });
  }
});

test('preserves uncertainty ahead of refusal codes and rejects malformed outcome flags', async () => {
  globalThis.fetch = (() =>
    Promise.resolve(
      response({ code: 'SPANS_BACKUP_BUSY', ok: false, outcomeUnknown: true })
    )) as typeof fetch;
  expect(await submitSpansMaintenance(restore)).toEqual({
    kind: 'unknown',
    message:
      'The result is unknown. Inspect the destination before acting again.',
  });
  globalThis.fetch = (() =>
    Promise.resolve(
      response({ code: 'SPANS_BACKUP_BUSY', incomplete: 'false', ok: false })
    )) as typeof fetch;
  expect((await submitSpansMaintenance(restore)).kind).toBe('unknown');
  globalThis.fetch = (() =>
    Promise.resolve(
      response({ code: 'SPANS_BACKUP_WORKER_UNAVAILABLE', ok: false }, 503)
    )) as typeof fetch;
  expect((await submitSpansMaintenance(restore)).kind).toBe('refused');
});

test('an unresolved destination cannot be reviewed again while a different destination remains available', () => {
  const review = {
    backupRoot: '',
    destination: '/backups/uncertain',
    operation: 'backup' as const,
  };
  for (const kind of ['unknown', 'incomplete'] as const) {
    const observed = { result: { kind, message: 'retained' }, review };
    expect(hasUnresolvedDestination(observed, review.destination)).toBe(true);
    expect(hasUnresolvedDestination(observed, '/backups/new')).toBe(false);
  }
  expect(
    hasUnresolvedDestination(
      { result: { kind: 'refused', message: 'refused before write' }, review },
      review.destination
    )
  ).toBe(false);
  expect(hasUnresolvedDestination(null, review.destination)).toBe(false);
});

test('a later successful operation retains earlier unresolved destinations', () => {
  const review = {
    backupRoot: '',
    destination: '/backups/unknown',
    operation: 'backup' as const,
  };
  const prior = retainUnresolvedMaintenance([], {
    result: { kind: 'unknown', message: 'unconfirmed' },
    review,
  });
  const afterSuccess = retainUnresolvedMaintenance(prior, {
    result: { counts, kind: 'success' },
    review: { ...review, destination: '/backups/completed' },
  });
  expect(afterSuccess).toEqual(prior);
  expect(
    afterSuccess.some((item) =>
      hasUnresolvedDestination(item, '/backups/unknown')
    )
  ).toBe(true);
});

test('a submitted destination stays unknown across reload without storing archive content or response text', () => {
  const storage = new MemoryStorage();
  const pending = {
    result: {
      kind: 'unknown' as const,
      message: 'private response text must not be persisted',
    },
    review: {
      backupRoot: '',
      destination: '/backups/interrupted',
      operation: 'backup' as const,
    },
  };

  expect(writeUnresolvedMaintenance(storage, [pending])).toBe(true);
  const persisted = storage.getItem('setu.spans-maintenance.recovery.v1');
  expect(persisted).not.toBeNull();
  expect(persisted).not.toContain('private response text');
  expect(persisted).not.toContain('artifactBytes');
  expect(persisted).not.toContain('archive bytes');

  const reloaded = loadUnresolvedMaintenance(storage);
  expect(reloaded).toEqual({
    observations: [
      {
        result: {
          kind: 'unknown',
          message:
            'The result is unknown. Inspect the destination before acting again.',
        },
        review: pending.review,
      },
    ],
    ok: true,
  });
  expect(
    hasUnresolvedDestination(
      reloaded.ok ? reloaded.observations[0] : null,
      pending.review.destination
    )
  ).toBe(true);
});

test('recovery storage fails closed on malformed, duplicate, oversized, or unavailable state', () => {
  const storage = new MemoryStorage();
  const key = 'setu.spans-maintenance.recovery.v1';
  storage.values.set(key, '{');
  expect(loadUnresolvedMaintenance(storage).ok).toBe(false);

  const validItem = {
    backupRoot: '',
    destination: '/backups/recovery',
    operation: 'backup',
    status: 'unknown',
  };
  storage.values.set(
    key,
    JSON.stringify({ items: [validItem, validItem], version: 1 })
  );
  expect(loadUnresolvedMaintenance(storage).ok).toBe(false);

  storage.values.set(key, JSON.stringify({ items: [validItem], version: 2 }));
  expect(loadUnresolvedMaintenance(storage).ok).toBe(false);

  storage.values.set(key, 'x'.repeat(64 * 1024 + 1));
  expect(loadUnresolvedMaintenance(storage).ok).toBe(false);

  const unavailable = {
    getItem() {
      throw new Error('storage unavailable');
    },
    setItem() {
      throw new Error('storage unavailable');
    },
  };
  expect(loadUnresolvedMaintenance(unavailable).ok).toBe(false);
  expect(writeUnresolvedMaintenance(unavailable, [])).toBe(false);
  expect(
    writeUnresolvedMaintenance(storage, [
      {
        result: { kind: 'unknown', message: 'uncertain' },
        review: { ...validItem, operation: 'backup' },
      },
    ])
  ).toBe(false);
});

test('clearing a confirmed outcome preserves other unresolved destinations', () => {
  const storage = new MemoryStorage();
  const earlier = {
    result: { kind: 'incomplete' as const, message: 'inspect' },
    review: {
      backupRoot: '/backup/one',
      destination: '/restore/one',
      operation: 'restore' as const,
    },
  };
  const pending = {
    result: { kind: 'unknown' as const, message: 'unconfirmed' },
    review: {
      backupRoot: '',
      destination: '/backup/current',
      operation: 'backup' as const,
    },
  };
  expect(writeUnresolvedMaintenance(storage, [earlier, pending])).toBe(true);
  expect(writeUnresolvedMaintenance(storage, [earlier])).toBe(true);
  expect(loadUnresolvedMaintenance(storage)).toMatchObject({
    observations: [
      {
        result: { kind: 'incomplete' },
        review: { destination: '/restore/one' },
      },
    ],
    ok: true,
  });
});

test('inherited object keys cannot become rendered error messages', async () => {
  globalThis.fetch = (() =>
    Promise.resolve(
      response({ code: '__proto__', incomplete: true, ok: false })
    )) as typeof fetch;
  expect(await submitSpansMaintenance(restore)).toEqual({
    kind: 'incomplete',
    message: 'The incomplete destination was retained.',
  });
});
