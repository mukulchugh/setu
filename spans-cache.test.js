import { expect, test } from 'bun:test';
import { createSpansCache } from './spans-cache.js';

const request = (overrides = {}) => ({
  dependencies: [
    { digest: 'sha256:abc', id: 'source', kind: 'content', validUntil: 9000 },
    { digest: 'sha256:def', generation: 'g1', id: 'corpus', kind: 'corpus' },
  ],
  fill: () =>
    Promise.resolve({ ok: true, value: { answer: 'fixture result' } }),
  input: { question: 'offline summary' },
  readOnly: true,
  scope: { access: 'owner', environment: 'test', project: '/fixture/project' },
  versions: { parser: '3', skill: '2', tool: '1' },
  ...overrides,
});

function runSequentially(items, callback) {
  return items.reduce(
    (previous, item) => previous.then(() => callback(item)),
    Promise.resolve()
  );
}

function memoryCache(options = {}) {
  const entries = new Map();
  let writes = 0;
  const cache = createSpansCache({
    now: () => 1000,
    readEntry: (key) => Promise.resolve(entries.get(key) ?? null),
    writeEntry: (key, entry) => {
      writes += 1;
      entries.set(key, structuredClone(entry));
      return Promise.resolve();
    },
    ...options,
  });
  return {
    cache,
    entries,
    get writes() {
      return writes;
    },
  };
}

test('coalesces concurrent identical fills and stores one complete entry', async () => {
  const store = memoryCache();
  let fills = 0;
  let release;
  const wait = new Promise((resolve) => {
    release = resolve;
  });
  const input = request({
    fill: async () => {
      fills += 1;
      await wait;
      return { ok: true, value: 'value' };
    },
  });
  const first = store.cache.getOrFill(input);
  const second = store.cache.getOrFill(input);
  await Promise.resolve();
  release();
  const [a, b] = await Promise.all([first, second]);
  expect(fills).toBe(1);
  expect(a).toEqual(b);
  a.cache.manifest.scope.project = 'changed';
  expect(b.cache.manifest.scope.project).not.toBe('changed');
  expect(store.writes).toBe(1);
  expect([...store.entries.values()][0]).toMatchObject({
    createdAt: 1000,
    validUntil: 9000,
    value: 'value',
  });
});

test('does not cache a failed fill and allows a later retry', async () => {
  const store = memoryCache();
  let fills = 0;
  const first = await store.cache.getOrFill(
    request({
      fill: () => {
        fills += 1;
        return Promise.resolve({
          code: 'SOURCE_FAILED',
          error: 'offline',
          ok: false,
        });
      },
    })
  );
  const second = await store.cache.getOrFill(
    request({
      fill: () => {
        fills += 1;
        return Promise.resolve({ ok: true, value: 'recovered' });
      },
    })
  );
  expect(first).toMatchObject({ code: 'SOURCE_FAILED', ok: false });
  expect(second).toMatchObject({
    cache: { hit: false },
    ok: true,
    value: 'recovered',
  });
  expect(fills).toBe(2);
  expect(store.writes).toBe(1);
});

test('expired entry is refreshed and the replacement is durable', async () => {
  let current = 1000;
  const store = memoryCache({ now: () => current });
  await store.cache.getOrFill(request());
  current = 9000;
  let fills = 0;
  const result = await store.cache.getOrFill(
    request({
      fill: () => {
        fills += 1;
        return Promise.resolve({ ok: true, value: 'fresh' });
      },
    })
  );
  expect(result).toMatchObject({
    cache: { hit: false },
    ok: true,
    value: 'fresh',
  });
  expect(fills).toBe(1);
  expect(store.writes).toBe(2);
});

test('scope, input content and corpus generation changes each miss', async () => {
  const store = memoryCache();
  await store.cache.getOrFill(request());
  await runSequentially(
    [
      request({
        scope: {
          access: 'owner',
          environment: 'test',
          project: '/fixture/other',
        },
      }),
      request({ input: { question: 'changed' } }),
      request({
        dependencies: [
          {
            digest: 'sha256:abc',
            id: 'source',
            kind: 'content',
            validUntil: 9000,
          },
          {
            digest: 'sha256:def',
            generation: 'g2',
            id: 'corpus',
            kind: 'corpus',
          },
        ],
      }),
    ],
    async (changed) => {
      const result = await store.cache.getOrFill(changed);
      expect(result.cache.hit).toBe(false);
    }
  );
  expect(store.writes).toBe(4);
});

test('invalid expiry runs readonly fill without storing', async () => {
  const store = memoryCache();
  let fills = 0;
  const result = await store.cache.getOrFill(
    request({
      dependencies: [
        {
          digest: 'sha256:abc',
          id: 'source',
          kind: 'content',
          validUntil: 'tomorrow',
        },
      ],
      fill: () => {
        fills += 1;
        return Promise.resolve({ ok: true, value: 'uncached' });
      },
    })
  );
  expect(result).toMatchObject({
    cache: { hit: false, key: null },
    ok: true,
    value: 'uncached',
  });
  expect(result.cache.missReason).toBe('DEPENDENCY_EXPIRY_INVALID_OR_UNKNOWN');
  expect(fills).toBe(1);
  expect(store.writes).toBe(0);
});

test('strict ISO expiries are parsed and the earliest dependency expiry is used', async () => {
  const store = memoryCache();
  const result = await store.cache.getOrFill(
    request({
      dependencies: [
        {
          digest: 'sha256:later',
          id: 'later',
          kind: 'content',
          validUntil: '1970-01-01T00:00:09.000Z',
        },
        {
          digest: 'sha256:earlier',
          id: 'earlier',
          kind: 'content',
          validUntil: 8000,
        },
      ],
    })
  );
  expect(result.ok).toBe(true);
  expect([...store.entries.values()][0].validUntil).toBe(8000);
});

test('unknown dependency misses without cache success and explains the miss', async () => {
  const store = memoryCache();
  const result = await store.cache.getOrFill(
    request({
      dependencies: [
        { digest: 'sha256:abc', id: 'source', kind: 'content', known: false },
      ],
    })
  );
  expect(result).toMatchObject({
    cache: {
      hit: false,
      key: null,
      missReason: 'DEPENDENCY_INCOMPLETE',
    },
    ok: true,
    value: { answer: 'fixture result' },
  });
  expect(store.writes).toBe(0);
});

test('non-readonly or unspecified request refuses before fill', async () => {
  const store = memoryCache();
  let fills = 0;
  const result = await store.cache.getOrFill(
    request({
      fill: () => {
        fills += 1;
        return Promise.resolve({ ok: true });
      },
      readOnly: undefined,
    })
  );
  expect(result).toMatchObject({ code: 'CACHE_READ_ONLY_REQUIRED', ok: false });
  expect(fills).toBe(0);
  expect(store.writes).toBe(0);
});

test('failed write is visible and does not report a completed cached result', async () => {
  const cache = createSpansCache({
    now: () => 1000,
    readEntry: () => Promise.resolve(null),
    writeEntry: () => Promise.reject(new Error('disk full')),
  });
  const result = await cache.getOrFill(request());
  expect(result).toEqual({
    code: 'CACHE_WRITE_FAILED',
    error: 'Cache storage write failed',
    ok: false,
  });
});

test('read failure is visible instead of being treated as a cache miss', async () => {
  const cache = createSpansCache({
    now: () => 1000,
    readEntry: () => Promise.reject(new Error('storage unavailable')),
    writeEntry: () => Promise.resolve(),
  });
  let fills = 0;
  const result = await cache.getOrFill(
    request({
      fill: () => {
        fills += 1;
        return Promise.resolve({ ok: true, value: 'unexpected' });
      },
    })
  );
  expect(result).toEqual({
    code: 'CACHE_READ_FAILED',
    error: 'Cache storage read failed',
    ok: false,
  });
  expect(fills).toBe(0);
});

test('backend and fill errors use fixed text and retain only a known failure code', async () => {
  const secret = 'sk-proj-abcdefghijklmnop';
  const readFailure = createSpansCache({
    now: () => 1000,
    readEntry: () => Promise.reject(new Error(`api_key=${secret}`)),
    writeEntry: () => Promise.resolve(),
  });
  expect(await readFailure.getOrFill(request())).toEqual({
    code: 'CACHE_READ_FAILED',
    error: 'Cache storage read failed',
    ok: false,
  });

  const writeFailure = createSpansCache({
    now: () => 1000,
    readEntry: () => Promise.resolve(null),
    writeEntry: () => Promise.reject(new Error(`password=${secret}`)),
  });
  expect(await writeFailure.getOrFill(request())).toEqual({
    code: 'CACHE_WRITE_FAILED',
    error: 'Cache storage write failed',
    ok: false,
  });

  const fillFailure = await memoryCache().cache.getOrFill(
    request({
      fill: () =>
        Promise.resolve({
          code: 'SOURCE_FAILED',
          error: `Bearer ${secret}`,
          ok: false,
        }),
    })
  );
  expect(fillFailure).toEqual({
    code: 'SOURCE_FAILED',
    error: 'Read-only fill failed',
    ok: false,
  });
});

test('thrown fill is sanitized, not stored, and a later call can retry', async () => {
  const store = memoryCache();
  let fills = 0;
  const failed = await store.cache.getOrFill(
    request({
      fill: () => {
        fills += 1;
        return Promise.reject(new Error('api_key=sk-proj-abcdefghijklmnop'));
      },
    })
  );
  const recovered = await store.cache.getOrFill(
    request({
      fill: () => {
        fills += 1;
        return Promise.resolve({ ok: true, value: 'recovered' });
      },
    })
  );
  expect(failed).toEqual({
    code: 'CACHE_FILL_FAILED',
    error: 'Read-only fill failed',
    ok: false,
  });
  expect(recovered).toMatchObject({
    cache: { hit: false },
    ok: true,
    value: 'recovered',
  });
  expect(fills).toBe(2);
  expect(store.writes).toBe(1);
});

test('successful fills require an own JSON-compatible value and never store invalid outcomes', async () => {
  const store = memoryCache();
  await runSequentially(
    [
      () => Promise.resolve({ ok: true }),
      () =>
        Promise.resolve(
          Object.create(
            { value: 'inherited' },
            { ok: { enumerable: true, value: true } }
          )
        ),
      () => Promise.resolve({ ok: true, value: { bad: undefined } }),
      () => Promise.resolve({ ok: true, value: 1n }),
    ],
    async (fill) => {
      const result = await store.cache.getOrFill(request({ fill }));
      expect(result).toEqual({
        code: 'CACHE_FILL_VALUE_INVALID',
        error: 'Read-only fill returned an invalid value',
        ok: false,
      });
    }
  );
  expect(store.writes).toBe(0);
});

test('redacts fill values before persistence and returns detached values on fills and hits', async () => {
  const store = memoryCache();
  const first = await store.cache.getOrFill(
    request({
      fill: () =>
        Promise.resolve({
          ok: true,
          value: {
            answer: 'safe',
            api_key: 'sk-proj-abcdefghijklmnop',
            note: 'Bearer abc.def',
          },
        }),
    })
  );
  expect(first.value).toEqual({
    answer: 'safe',
    api_key: '[REDACTED]',
    note: 'Bearer [REDACTED]',
  });
  first.value.answer = 'caller mutation';
  first.value.api_key = 'caller secret';
  const [retained] = store.entries.values();
  expect(retained.value).toEqual({
    answer: 'safe',
    api_key: '[REDACTED]',
    note: 'Bearer [REDACTED]',
  });

  const hit = await store.cache.getOrFill(
    request({
      fill: () => Promise.reject(new Error('unexpected fill')),
    })
  );
  expect(hit.cache.hit).toBe(true);
  expect(hit.value).toEqual({
    answer: 'safe',
    api_key: '[REDACTED]',
    note: 'Bearer [REDACTED]',
  });
  hit.value.answer = 'mutated hit';
  const laterHit = await store.cache.getOrFill(
    request({
      fill: () => Promise.reject(new Error('unexpected fill')),
    })
  );
  expect(laterHit.value.answer).toBe('safe');
});

test('fill results are detached from the object passed to the write callback', async () => {
  let retained;
  const cache = createSpansCache({
    now: () => 1000,
    readEntry: () => Promise.resolve(null),
    writeEntry: (_key, entry) => {
      retained = entry;
      return Promise.resolve();
    },
  });
  const result = await cache.getOrFill(
    request({
      fill: async () => ({ ok: true, value: { answer: 'stored' } }),
    })
  );
  result.value.answer = 'mutated';
  expect(retained.value.answer).toBe('stored');
});

test('a complete entry remains usable after cache instance reopens', async () => {
  const entries = new Map();
  const first = createSpansCache({
    now: () => 1000,
    readEntry: (key) => Promise.resolve(entries.get(key) ?? null),
    writeEntry: (key, entry) => {
      entries.set(key, structuredClone(entry));
      return Promise.resolve();
    },
  });
  await first.getOrFill(request());
  const reopened = createSpansCache({
    now: () => 1001,
    readEntry: (key) => Promise.resolve(entries.get(key) ?? null),
    writeEntry: (key, entry) => {
      entries.set(key, structuredClone(entry));
      return Promise.resolve();
    },
  });
  const result = await reopened.getOrFill(
    request({
      fill: () => Promise.reject(new Error('should not fill')),
    })
  );
  expect(result).toMatchObject({
    cache: { createdAt: 1000, hit: true },
    ok: true,
    value: { answer: 'fixture result' },
  });
});
