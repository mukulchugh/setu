import { afterEach, describe, expect, test } from 'bun:test';
import {
  consumeHistoryImportToken,
  invalidateHistoryImportReview,
  sameHistoryImportInput,
} from './portal/components/spans-history-import';
import {
  type SpansHistoryImportInput,
  submitSpansHistoryImport,
  validateSpansHistoryImportInput,
} from './portal/spans-history';

const originalFetch = globalThis.fetch;
const input: SpansHistoryImportInput = {
  path: '/Users/test/Library/Codex/session.jsonl',
  provider: 'codex',
};

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function response(
  body: unknown,
  status = 200,
  headers?: HeadersInit
): Response {
  return new Response(JSON.stringify(body), {
    headers: { 'content-type': 'application/json', ...headers },
    status,
  });
}

const page = {
  eof: false,
  expectedOffset: 0,
  gapCount: 0,
  hasMore: true,
  importedCount: 200,
  nextOffset: 4096,
  ok: true,
  pendingByteCount: 0,
  runId: 'import-run-123',
  sourceId: 'a'.repeat(64),
  state: 'importing',
};

describe('selected Spans history import client', () => {
  test('validates locally and posts only the explicit public input', async () => {
    const calls: { url: RequestInfo | URL; init?: RequestInit }[] = [];
    globalThis.fetch = ((url, init) => {
      calls.push({ init, url });
      return Promise.resolve(response(page));
    }) as typeof fetch;

    expect(
      validateSpansHistoryImportInput({ ...input, parserVersion: 'fake' })
    ).toBeTruthy();
    expect(
      await submitSpansHistoryImport({ ...input, path: 'relative.jsonl' })
    ).toMatchObject({ kind: 'refused' });
    expect(
      await submitSpansHistoryImport({ ...input, path: '/tmp/../secret' })
    ).toMatchObject({ kind: 'refused' });
    expect(
      await submitSpansHistoryImport({ ...input, path: `/${'x'.repeat(4096)}` })
    ).toMatchObject({ kind: 'refused' });
    expect(calls).toHaveLength(0);

    expect(
      await submitSpansHistoryImport({ ...input, existingRunId: 'run-9' })
    ).toMatchObject({
      expectedOffset: 0,
      gapCount: 0,
      hasMore: true,
      importedCount: 200,
      kind: 'success',
      pendingByteCount: 0,
      state: 'importing',
    });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('/api/spans/history/import');
    expect(calls[0].init?.method).toBe('POST');
    expect(calls[0].init?.headers).toEqual({
      'content-type': 'application/json',
    });
    expect(calls[0].init?.body).toBe(
      `{"path":"${input.path}","provider":"codex","existingRunId":"run-9"}`
    );
    expect(String(calls[0].init?.body)).not.toContain('parserVersion');
    expect(String(calls[0].init?.body)).not.toContain('sourceId');
  });

  test('snapshots own data properties and rejects coercion and accessors safely', async () => {
    let calls = 0;
    globalThis.fetch = (() => {
      calls += 1;
      return Promise.resolve(response(page));
    }) as typeof fetch;

    const providerCoercion = {
      path: input.path,
      provider: { toString: () => 'codex' },
    };
    const accessor = { provider: 'codex' } as Record<string, unknown>;
    Object.defineProperty(accessor, 'path', {
      enumerable: true,
      get() {
        throw new Error('getter must not run');
      },
    });
    const customPrototype = Object.assign(
      Object.create({ extra: true }),
      input
    );
    const symbolKey = { ...input, [Symbol('extra')]: 1 };

    await Promise.all(
      [providerCoercion, accessor, customPrototype, symbolKey].map(
        async (hostile) => {
          expect(validateSpansHistoryImportInput(hostile)).toBeTruthy();
          await expect(
            submitSpansHistoryImport(hostile as SpansHistoryImportInput)
          ).resolves.toMatchObject({ kind: 'refused' });
        }
      )
    );
    expect(calls).toBe(0);
  });

  test('accepts a partial page with an incomplete trailing record', async () => {
    globalThis.fetch = (() =>
      Promise.resolve(
        response({
          ...page,
          expectedOffset: 4096,
          hasMore: false,
          importedCount: 3,
          nextOffset: 4096,
          pendingByteCount: 27,
          state: 'importing',
        })
      )) as typeof fetch;
    expect(await submitSpansHistoryImport(input)).toMatchObject({
      hasMore: false,
      importedCount: 3,
      kind: 'success',
      pendingByteCount: 27,
      state: 'importing',
    });
  });

  test('reports page progress and end-of-file separately', async () => {
    globalThis.fetch = (async () => response(page)) as typeof fetch;
    expect(await submitSpansHistoryImport(input)).toMatchObject({
      eof: false,
      expectedOffset: 0,
      hasMore: true,
      importedCount: 200,
      nextOffset: 4096,
      state: 'importing',
    });

    globalThis.fetch = (() =>
      Promise.resolve(
        response({
          ...page,
          eof: true,
          expectedOffset: 4096,
          gapCount: 2,
          hasMore: false,
          importedCount: 5,
          nextOffset: 8192,
          state: 'imported',
        })
      )) as typeof fetch;
    expect(await submitSpansHistoryImport(input)).toMatchObject({
      eof: true,
      gapCount: 2,
      hasMore: false,
      importedCount: 5,
      nextOffset: 8192,
      state: 'imported',
    });
  });

  test('reports complete and partial search coverage without changing import success', async () => {
    globalThis.fetch = (() =>
      Promise.resolve(
        response({
          ...page,
          hasMore: false,
          nextOffset: 4096,
          search: {
            complete: true,
            coverage: { indexedSequence: 12, latestSequence: 12 },
            hasMore: false,
            indexed: 12,
            ok: true,
            pages: 1,
            targetSequence: 12,
          },
          state: 'imported',
        })
      )) as typeof fetch;
    await expect(submitSpansHistoryImport(input)).resolves.toMatchObject({
      kind: 'success',
      search: { indexed: 12, kind: 'complete', pages: 1, targetSequence: 12 },
    });

    globalThis.fetch = (() =>
      Promise.resolve(
        response({
          ...page,
          search: {
            code: 'SPANS_SEARCH_UNAVAILABLE',
            complete: false,
            error: '/private/path must never be displayed',
            indexed: 0,
            ok: false,
          },
        })
      )) as typeof fetch;
    await expect(submitSpansHistoryImport(input)).resolves.toMatchObject({
      kind: 'success',
      search: { kind: 'pending' },
    });
  });

  test('degrades legacy, malformed, and unknown search status safely', async () => {
    const expectUnverified = async (search: unknown) => {
      globalThis.fetch = (() =>
        Promise.resolve(response({ ...page, search }))) as typeof fetch;
      await expect(submitSpansHistoryImport(input)).resolves.toMatchObject({
        kind: 'success',
        search: { kind: 'unverified' },
      });
    };
    await expectUnverified(undefined);
    await expectUnverified({
      complete: true,
      error: '/private/path',
      ok: true,
    });
    await expectUnverified({
      complete: true,
      coverage: { indexedSequence: 12, latestSequence: 12 },
      hasMore: false,
      indexed: 12,
      ok: true,
      pages: 1,
      targetSequence: Number.MAX_SAFE_INTEGER + 1,
    });

    globalThis.fetch = (() =>
      Promise.resolve(
        response({
          ...page,
          search: { complete: false, ok: false, unknown: true },
        })
      )) as typeof fetch;
    await expect(submitSpansHistoryImport(input)).resolves.toMatchObject({
      kind: 'success',
      search: { kind: 'unknown' },
    });
  });

  test('rejects impossible batch, offset, and state combinations as unknown', async () => {
    await Promise.all(
      [
        { ...page, importedCount: 201 },
        { ...page, gapCount: 201 },
        { ...page, expectedOffset: 4097 },
        { ...page, nextOffset: 0 },
        { ...page, hasMore: false },
        { ...page, hasMore: true, nextOffset: 0 },
      ].map(async (invalid) => {
        globalThis.fetch = (() =>
          Promise.resolve(response(invalid))) as typeof fetch;
        expect((await submitSpansHistoryImport(input)).kind).toBe('unknown');
      })
    );
  });

  test('uses fixed refusal copy, including recognized non-success HTTP responses', async () => {
    globalThis.fetch = (() =>
      Promise.resolve(
        response(
          {
            code: 'SOURCE_REPLACED',
            error: '/private/path and arbitrary details',
            ok: false,
          },
          409
        )
      )) as typeof fetch;
    expect(await submitSpansHistoryImport(input)).toEqual({
      kind: 'refused',
      message:
        'The selected source file changed. Review the current file before importing again.',
    });

    globalThis.fetch = (() =>
      Promise.resolve(response({ ...page, ok: true }, 500))) as typeof fetch;
    expect((await submitSpansHistoryImport(input)).kind).toBe('unknown');
  });

  test('treats transport, malformed, oversized, and unknown outcomes conservatively', async () => {
    globalThis.fetch = (() => {
      throw new Error('transport failed');
    }) as typeof fetch;
    expect((await submitSpansHistoryImport(input)).kind).toBe('unknown');

    globalThis.fetch = (() =>
      Promise.resolve(
        response({ ...page, runId: '__proto__' })
      )) as typeof fetch;
    expect((await submitSpansHistoryImport(input)).kind).toBe('unknown');

    globalThis.fetch = (() =>
      Promise.resolve(
        response({ ...page, runId: null, unknown: true })
      )) as typeof fetch;
    expect((await submitSpansHistoryImport(input)).kind).toBe('unknown');

    globalThis.fetch = (() =>
      Promise.resolve(new Response('x'.repeat(65 * 1024)))) as typeof fetch;
    expect((await submitSpansHistoryImport(input)).kind).toBe('unknown');

    globalThis.fetch = (() =>
      Promise.resolve(
        response({ code: 'SOURCE_UNAVAILABLE', ok: false }, 409, {
          'content-length': String(65 * 1024),
        })
      )) as typeof fetch;
    expect((await submitSpansHistoryImport(input)).kind).toBe('unknown');

    let attempts = 0;
    globalThis.fetch = (() => {
      attempts += 1;
      return Promise.resolve(response({ ...page, unknown: true }));
    }) as typeof fetch;
    expect((await submitSpansHistoryImport(input)).kind).toBe('unknown');
    expect(attempts).toBe(1);
  });

  test('consumes confirm and continuation tokens once; edits invalidate review only', () => {
    const review = { input };
    const activeReview = { current: review as typeof review | null };
    expect(consumeHistoryImportToken(activeReview, review)).toBe(true);
    expect(consumeHistoryImportToken(activeReview, review)).toBe(false);

    const submitted = { ...input };
    const activeContinuation = {
      current: submitted as typeof submitted | null,
    };
    expect(consumeHistoryImportToken(activeContinuation, submitted)).toBe(true);
    expect(consumeHistoryImportToken(activeContinuation, submitted)).toBe(
      false
    );

    const nextReview = { input: { ...input, path: '/tmp/edited.jsonl' } };
    const editedReview = { current: nextReview as typeof nextReview | null };
    const oldContinuation = { ...input };
    const boundContinuation = {
      current: oldContinuation as typeof oldContinuation | null,
    };
    invalidateHistoryImportReview(editedReview);
    expect(editedReview.current).toBeNull();
    expect(boundContinuation.current).toBe(oldContinuation);
    expect(boundContinuation.current?.path).toBe(input.path);
    const continuingInput = boundContinuation.current;
    expect(continuingInput).not.toBeNull();
    if (continuingInput) {
      expect(sameHistoryImportInput(continuingInput, nextReview.input)).toBe(
        false
      );
    }
  });

  test('compares all user-controlled fields in review snapshots', () => {
    expect(sameHistoryImportInput(input, { ...input })).toBe(true);
    expect(
      sameHistoryImportInput(input, { ...input, provider: 'claude' })
    ).toBe(false);
    expect(
      sameHistoryImportInput(input, { ...input, existingRunId: 'run-9' })
    ).toBe(false);
  });
});
