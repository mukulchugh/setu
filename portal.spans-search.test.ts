import { afterEach, describe, expect, test } from 'bun:test';
import {
  canAcceptSpansSearchResponse,
  decodeSpansSearch,
  decodeSpansSearchStatus,
  readSpansSearch,
  SpansSearchReadError,
  type SpansSearchRequest,
} from './portal/spans-search';

const request: SpansSearchRequest = { limit: 2, query: 'deployment' };
const hit = (sequence: number, runId = 'run-1') => ({
  eventId: `event-${sequence}`,
  historical: true,
  runId,
  sequence,
  snippet: `saved event ${sequence}`,
});
const response = (hits = [hit(3)], extra: Record<string, unknown> = {}) => ({
  coverage: {
    complete: true,
    generation: 4,
    indexedSequence: 8,
    latestSequence: 8,
    stale: false,
  },
  generation: 4,
  hasMore: false,
  hits,
  nextSequence: hits.at(-1)?.sequence ?? 0,
  ok: true,
  throughSequence: 8,
  ...extra,
});

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('decodeSpansSearch', () => {
  test('decodes a valid page and keeps snippets as plain strings', () => {
    const decoded = decodeSpansSearch(response(), request);
    expect(decoded.hits[0]?.snippet).toBe('saved event 3');
    expect(decoded.coverage.complete).toBe(true);
  });

  const validCache = () => ({
    ageMs: 2500.5,
    createdAt: 1_700_000_000_000,
    hit: true,
    key: `sha256:${'a'.repeat(64)}`,
    manifest: {
      dependencies: [
        {
          digest: `sha256:${'b'.repeat(64)}`,
          generation: '4:8:8',
          kind: 'corpus',
        },
      ],
      scope: { environment: '/private/archive/path' },
      versions: { parser: 'parser-v2', tool: 'tool-v3' },
    },
    persisted: true,
  });

  test('decodes a cache hit with matching source evidence without exposing private scope', () => {
    const cache = validCache();
    const decoded = decodeSpansSearch(response([hit(3)], { cache }), request);
    expect(decoded.cache?.kind).toBe('available');
    if (decoded.cache?.kind !== 'available') {
      throw new Error('Expected a current cache receipt');
    }
    expect(decoded.cache.hit).toBe(true);
    expect(decoded.cache.ageMs).toBe(2500.5);
    expect(decoded.cache.persisted).toBe(true);
    expect(decoded.cache.source?.corpusGeneration).toBe('4:8:8');
    expect(decoded.cache.source?.toolVersion).toBe('tool-v3');
    expect(decoded.cache.key).toBe(cache.key);
    expect(JSON.stringify(decoded.cache)).not.toContain(
      '/private/archive/path'
    );
  });

  test('keeps an empty fresh result when cache persistence was refused', () => {
    const decoded = decodeSpansSearch(
      response([], {
        cache: {
          hit: false,
          persisted: false,
          persistenceReason: 'ARCHIVE_WRITE_REFUSED',
        },
      }),
      request
    );
    expect(decoded.hits).toEqual([]);
    expect(decoded.cache).toEqual({
      ageMs: null,
      createdAt: null,
      hit: false,
      key: null,
      kind: 'available',
      missReason: null,
      persisted: false,
      persistenceReason: 'ARCHIVE_WRITE_REFUSED',
      source: null,
    });
  });

  test('keeps unknown age unknown for an otherwise complete hit', () => {
    const cache = { ...validCache(), ageMs: 'recent', createdAt: 'yesterday' };
    const decoded = decodeSpansSearch(response([hit(3)], { cache }), request);
    expect(decoded.cache).toMatchObject({
      ageMs: null,
      createdAt: null,
      hit: true,
      persisted: true,
    });
  });

  test('does not infer a hit from incomplete or contradictory cache evidence', () => {
    const cache = validCache();
    for (const bad of [
      { ...cache, key: null },
      { ...cache, manifest: null },
      { ...cache, hit: 'yes' },
      { ...cache, persisted: 'unknown' },
      { ...cache, persisted: false },
      {
        ...cache,
        manifest: {
          ...cache.manifest,
          dependencies: [
            { ...cache.manifest.dependencies[0], generation: '5:8:8' },
          ],
        },
      },
      { cacheMeta: cache, persisted: true },
    ]) {
      const decoded = decodeSpansSearch(
        response([hit(3)], { cache: bad }),
        request
      );
      expect(decoded.hits).toHaveLength(1);
      expect(decoded.cache).toEqual({ kind: 'unavailable' });
    }
  });

  test('an unconfirmed save stays unknown and cannot invalidate valid search results', () => {
    const decoded = decodeSpansSearch(
      response([hit(3)], {
        cache: {
          ageMs: null,
          hit: false,
          persisted: 'unknown',
          persistenceReason: 'ARCHIVE_WRITE_UNKNOWN',
        },
      }),
      request
    );
    expect(decoded.hits).toHaveLength(1);
    expect(decoded.cache).toMatchObject({
      ageMs: null,
      hit: false,
      persisted: 'unknown',
    });
  });

  test('invalid creation dates cannot reach date rendering', () => {
    const decoded = decodeSpansSearch(
      response([hit(3)], {
        cache: { ...validCache(), createdAt: Number.MAX_SAFE_INTEGER },
      }),
      request
    );
    expect(decoded.cache).toMatchObject({ createdAt: null, hit: true });
  });

  test('rejects malformed responses and hits from a different requested run', () => {
    expect(() => decodeSpansSearch({ ok: true }, request)).toThrow();
    expect(() =>
      decodeSpansSearch(response([hit(3, 'other-run')]), {
        ...request,
        runId: 'run-1',
      })
    ).toThrow();
  });

  test('enforces bounded query and page inputs', () => {
    const maxQuery = 'q'.repeat(512);
    expect(
      decodeSpansSearch(response(), { limit: 100, query: maxQuery }).hits
    ).toHaveLength(1);
    expect(() =>
      decodeSpansSearch(response(), { query: 'q'.repeat(513) })
    ).toThrow();
    expect(() =>
      decodeSpansSearch(response(), { limit: 101, query: request.query })
    ).toThrow();
    expect(() =>
      decodeSpansSearch(response(), { limit: 0, query: request.query })
    ).toThrow();
  });

  test('rejects out of order, repeated, or beyond-snapshot hits', () => {
    expect(() =>
      decodeSpansSearch(
        response([hit(5), hit(4)], {
          nextSequence: 4,
        }),
        request
      )
    ).toThrow();
    expect(() =>
      decodeSpansSearch(
        response([hit(9)], {
          nextSequence: 9,
        }),
        request
      )
    ).toThrow();
  });

  test('requires continuation cursor and generation to match the first page', () => {
    const continuation = {
      afterSequence: 3,
      expectedGeneration: 4,
      query: request.query,
      throughSequence: 8,
    };
    expect(
      decodeSpansSearch(response([hit(6)], { nextSequence: 6 }), continuation)
        .nextSequence
    ).toBe(6);
    expect(() =>
      decodeSpansSearch(response([hit(6)], { generation: 5 }), continuation)
    ).toThrow();
    expect(() =>
      decodeSpansSearch(
        response([hit(6)], { throughSequence: 9 }),
        continuation
      )
    ).toThrow();
    expect(() =>
      decodeSpansSearch(response([hit(6)], { nextSequence: 6 }), {
        afterSequence: 3,
        query: request.query,
        throughSequence: 8,
      })
    ).toThrow();
  });

  test('requires coverage flags to agree with indexed coverage', () => {
    expect(() =>
      decodeSpansSearch(
        response([], {
          coverage: {
            complete: true,
            generation: 4,
            indexedSequence: 5,
            latestSequence: 8,
            stale: true,
          },
        }),
        { query: request.query }
      )
    ).toThrow();
    expect(() =>
      decodeSpansSearchStatus({
        coverage: {
          complete: true,
          generation: 4,
          indexedSequence: 5,
          latestSequence: 8,
          stale: false,
        },
        generation: 4,
        ok: true,
      })
    ).toThrow();
  });

  test('rejects contradictory incomplete and stale coverage flags', () => {
    for (const coverage of [
      {
        complete: false,
        generation: 4,
        indexedSequence: 8,
        latestSequence: 8,
        stale: false,
      },
      {
        complete: false,
        generation: 4,
        indexedSequence: 5,
        latestSequence: 8,
        stale: false,
      },
    ]) {
      expect(() =>
        decodeSpansSearch(response([], { coverage }), request)
      ).toThrow();
      expect(() =>
        decodeSpansSearchStatus({ coverage, generation: 4, ok: true })
      ).toThrow();
    }
  });

  test('keeps the continuation sequence equal to the last delivered hit or incoming cursor', () => {
    const continuation = {
      afterSequence: 3,
      expectedGeneration: 4,
      query: request.query,
      throughSequence: 8,
    };
    expect(
      decodeSpansSearch(
        response([], {
          hasMore: false,
          nextSequence: 3,
        }),
        continuation
      ).nextSequence
    ).toBe(3);
    expect(() =>
      decodeSpansSearch(
        response([], {
          hasMore: false,
          nextSequence: 0,
        }),
        continuation
      )
    ).toThrow();
    expect(() =>
      decodeSpansSearch(
        response([hit(6)], {
          hasMore: true,
          nextSequence: 5,
        }),
        continuation
      )
    ).toThrow();
  });

  test('accepts malicious markup only as inert snippet text', () => {
    const markup = '<img src=x onerror=alert(1)>';
    expect(
      decodeSpansSearch(response([{ ...hit(3), snippet: markup }]), request)
        .hits[0]?.snippet
    ).toBe(markup);
  });

  test('surfaces stale-generation failures as a restart condition', () => {
    expect(() =>
      decodeSpansSearch(
        {
          code: 'SPANS_SERVICE_STALE',
          error: 'fixed message',
          ok: false,
        },
        request
      )
    ).toThrow(SpansSearchReadError);
  });

  test('decodes explicit index coverage and refuses a missing index result', () => {
    expect(
      decodeSpansSearchStatus({
        coverage: {
          complete: false,
          generation: 4,
          indexedSequence: 5,
          latestSequence: 8,
          stale: true,
        },
        generation: 4,
        ok: true,
      }).coverage.complete
    ).toBe(false);
    expect(() =>
      decodeSpansSearchStatus({ code: 'SPANS_SERVICE_UNAVAILABLE', ok: false })
    ).toThrow();
  });

  test('passes cancellation through to fetch', async () => {
    globalThis.fetch = ((_input: RequestInfo | URL, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () =>
          reject(new DOMException('Aborted', 'AbortError'))
        );
      })) as typeof fetch;
    const controller = new AbortController();
    const pending = readSpansSearch(request, controller.signal);
    controller.abort();
    await expect(pending).rejects.toHaveProperty('name', 'AbortError');
  });

  test('sends the snapshot fence even when the pinned first page cursor is zero', async () => {
    let requestedUrl = '';
    globalThis.fetch = ((input: RequestInfo | URL) => {
      requestedUrl = String(input);
      return Promise.resolve(
        new Response(JSON.stringify(response()), { status: 200 })
      );
    }) as typeof fetch;
    const pinnedFirstPage = {
      afterSequence: 0,
      expectedGeneration: 4,
      query: request.query,
      throughSequence: 8,
    };

    await readSpansSearch(pinnedFirstPage, new AbortController().signal);

    const params = new URL(requestedUrl, 'http://localhost').searchParams;
    expect(params.get('afterSequence')).toBe('0');
    expect(params.get('expectedGeneration')).toBe('4');
    expect(params.get('throughSequence')).toBe('8');
  });

  test('does not accept an older response after a newer query becomes current', () => {
    const controller = new AbortController();
    expect(
      canAcceptSpansSearchResponse(
        'query-a/page-1',
        'query-b/page-1',
        controller.signal
      )
    ).toBe(false);
    expect(
      canAcceptSpansSearchResponse(
        'query-b/page-1',
        'query-b/page-1',
        controller.signal
      )
    ).toBe(true);
  });
});
