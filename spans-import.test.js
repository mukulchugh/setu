import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { importSpansSource } from './spans-import.js';

const parserVersion = 'test-parser-1';

function message(text, nativeId = 'native-1') {
  return {
    payload: {
      content: [{ text, type: 'output_text' }],
      id: nativeId,
      role: 'assistant',
      type: 'message',
    },
    type: 'response_item',
  };
}

function line(record) {
  return new TextEncoder().encode(`${JSON.stringify(record)}\n`);
}

function concat(...parts) {
  const result = new Uint8Array(
    parts.reduce((size, part) => size + part.length, 0)
  );
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
}

function createAdapters({
  artifactFailure = false,
  commitFailure = false,
} = {}) {
  const cursors = new Map();
  const batches = new Map();
  const events = [];
  const storedArtifacts = [];
  const calls = { commitImport: 0, put: 0, readSourceCursor: 0 };
  const key = ({ sourceId, sourceGeneration, parserVersion: version }) =>
    JSON.stringify([sourceId, sourceGeneration, version]);
  const store = {
    commitImport(batch) {
      calls.commitImport += 1;
      if (commitFailure) {
        return { code: 'STORAGE_FULL', ok: false };
      }
      const cursorKey = key(batch);
      const current = cursors.get(cursorKey) ?? batch.expectedOffset;
      const batchKey = JSON.stringify([
        cursorKey,
        batch.expectedOffset,
        batch.nextOffset,
      ]);
      const serialized = JSON.stringify(batch.events);
      if (batch.expectedOffset < current) {
        if (batches.get(batchKey) === serialized) {
          return { ok: true, replay: true };
        }
        return { code: 'SOURCE_OFFSET_CONFLICT', ok: false };
      }
      if (batch.expectedOffset !== current) {
        return { code: 'SOURCE_OFFSET_CONFLICT', ok: false };
      }
      if (batch.nextOffset < batch.expectedOffset) {
        return { code: 'SOURCE_OFFSET_CONFLICT', ok: false };
      }
      for (const event of batch.events) {
        const existing = events.find(
          (candidate) => candidate.eventId === event.eventId
        );
        if (existing && JSON.stringify(existing) !== JSON.stringify(event)) {
          return { code: 'SOURCE_OFFSET_CONFLICT', ok: false };
        }
      }
      batches.set(batchKey, serialized);
      for (const event of batch.events) {
        if (!events.some((candidate) => candidate.eventId === event.eventId)) {
          events.push(event);
        }
      }
      cursors.set(cursorKey, batch.nextOffset);
      return { ok: true };
    },
    readSourceCursor(identity) {
      calls.readSourceCursor += 1;
      const offset = cursors.get(key(identity));
      return offset === undefined
        ? { code: 'NOT_FOUND' }
        : { offset, ok: true };
    },
  };
  const artifacts = {
    put(artifact) {
      calls.put += 1;
      if (artifactFailure) {
        return { error: 'SECRET_FROM_ADAPTER_ERROR', ok: false };
      }
      const artifactId = createHash('sha256')
        .update(artifact.text)
        .digest('hex');
      storedArtifacts.push({ ...artifact, artifactId });
      return {
        artifactId,
        bytes: new TextEncoder().encode(artifact.text).length,
        mediaType: artifact.mediaType,
        ok: true,
      };
    },
  };
  return { artifacts, calls, cursors, events, store, storedArtifacts };
}

function args(adapters, overrides = {}) {
  return {
    bytes: new Uint8Array(),
    offset: 0,
    parserVersion,
    provider: 'codex',
    runId: 'run-a',
    sourceGeneration: 0,
    sourceId: 'source-a',
    ...adapters,
    ...overrides,
  };
}

describe('importSpansSource', () => {
  test('duplicate exact batch replay keeps one event with a stable ID', async () => {
    const adapters = createAdapters();
    const bytes = line(message('hello'));
    const first = await importSpansSource(args(adapters, { bytes }));
    const replay = await importSpansSource(args(adapters, { bytes }));
    expect(first.ok).toBe(true);
    expect(replay.ok).toBe(true);
    expect(first.events[0].eventId).toBe(replay.events[0].eventId);
    expect(adapters.events).toHaveLength(1);
  });

  test('holds exact partial UTF-8 and JSON bytes until the line is complete', async () => {
    const adapters = createAdapters();
    const complete = line(message('café — done'));
    const split = complete.indexOf(0xc3) + 1;
    const firstBytes = complete.slice(0, split);
    const secondBytes = complete.slice(split);
    const first = await importSpansSource(
      args(adapters, { bytes: firstBytes })
    );
    expect(first.ok).toBe(true);
    expect(first.nextOffset).toBe(0);
    expect(first.pendingBytes).toEqual(firstBytes);
    expect(adapters.cursors.size).toBe(1);
    expect(adapters.cursors.values().next().value).toBe(0);
    const second = await importSpansSource(
      args(adapters, { bytes: concat(first.pendingBytes, secondBytes) })
    );
    expect(second.ok).toBe(true);
    expect(second.nextOffset).toBe(complete.length);
    expect(JSON.parse(adapters.storedArtifacts[0].text).text).toBe(
      'café — done'
    );
  });

  test('stops at the first malformed complete record and keeps later lines pending', async () => {
    const adapters = createAdapters();
    const bytes = concat(
      new TextEncoder().encode('{broken}\n'),
      line(message('must not pass'))
    );
    const result = await importSpansSource(args(adapters, { bytes }));
    expect(result.ok).toBe(false);
    expect(result.code).toBe('SOURCE_RECORD_INVALID');
    expect(result.nextOffset).toBe(0);
    expect(result.pendingBytes).toEqual(bytes);
    expect(result.gap.type).toBe('source.gap');
    expect(
      adapters.events.some((event) => event.type === 'source.message')
    ).toBe(false);
    expect(
      adapters.cursors.get(JSON.stringify(['source-a', 0, parserVersion]))
    ).toBe(0);
  });

  test('artifact failure leaves the cursor unchanged and exposes no adapter error text', async () => {
    const adapters = createAdapters({ artifactFailure: true });
    const result = await importSpansSource(
      args(adapters, { bytes: line(message('hello')) })
    );
    expect(result.code).toBe('SOURCE_ARTIFACT_WRITE_FAILED');
    expect(result.error).not.toContain('SECRET_FROM_ADAPTER_ERROR');
    expect(adapters.cursors.size).toBe(0);
    expect(adapters.events).toHaveLength(0);
  });

  test('replaces adapter error codes outside the safe code format', async () => {
    const cursorAdapters = createAdapters();
    cursorAdapters.store.readSourceCursor = () => ({
      code: 'SECRET FROM CURSOR ADAPTER',
      ok: false,
    });
    const cursorResult = await importSpansSource(args(cursorAdapters));
    expect(cursorResult.code).toBe('SOURCE_CURSOR_READ_FAILED');

    const commitAdapters = createAdapters();
    commitAdapters.store.commitImport = () => ({
      code: 'secret from commit adapter',
      ok: false,
    });
    const commitResult = await importSpansSource(args(commitAdapters));
    expect(commitResult.code).toBe('SOURCE_IMPORT_COMMIT_FAILED');
  });

  test('commit failure leaves cursor and event log unchanged', async () => {
    const adapters = createAdapters({ commitFailure: true });
    const result = await importSpansSource(
      args(adapters, { bytes: line(message('hello')) })
    );
    expect(result.code).toBe('STORAGE_FULL');
    expect(adapters.cursors.size).toBe(0);
    expect(adapters.events).toHaveLength(0);
  });

  test('reordered sources have independent cursors', async () => {
    const adapters = createAdapters();
    const sourceA = args(adapters, {
      bytes: line(message('A')),
      sourceId: 'a',
    });
    const sourceB = args(adapters, {
      bytes: line(message('B')),
      sourceId: 'b',
    });
    const b = await importSpansSource(sourceB);
    const a = await importSpansSource(sourceA);
    expect(a.ok && b.ok).toBe(true);
    expect(adapters.cursors.get(JSON.stringify(['a', 0, parserVersion]))).toBe(
      sourceA.bytes.length
    );
    expect(adapters.cursors.get(JSON.stringify(['b', 0, parserVersion]))).toBe(
      sourceB.bytes.length
    );
  });

  test('source generations distinguish identical native IDs', async () => {
    const adapters = createAdapters();
    const bytes = line(message('hello', 'same-native-id'));
    const first = await importSpansSource(
      args(adapters, { bytes, sourceGeneration: 0 })
    );
    const second = await importSpansSource(
      args(adapters, { bytes, sourceGeneration: 1 })
    );
    expect(first.events[0].eventId).not.toBe(second.events[0].eventId);
    expect(adapters.events).toHaveLength(2);
  });

  test('redacts seeded secrets before artifacts and store events', async () => {
    const adapters = createAdapters();
    const secret = 'sk-proj-1234567890abcdefghijkl';
    const result = await importSpansSource(
      args(adapters, {
        bytes: line(message(`apiKey=${secret} and ${secret}`)),
      })
    );
    expect(result.ok).toBe(true);
    expect(JSON.stringify(adapters.storedArtifacts)).not.toContain(secret);
    expect(JSON.stringify(adapters.events)).not.toContain(secret);
    expect(JSON.stringify(result.events)).not.toContain(secret);
  });

  test('approval-like records are retained only as inert coverage gaps', async () => {
    const adapters = createAdapters();
    const approval = {
      action: 'deploy',
      approved: true,
      token: 'DO_NOT_EXECUTE',
      type: 'approval',
    };
    const result = await importSpansSource(
      args(adapters, { bytes: line(approval) })
    );
    expect(result.ok).toBe(false);
    expect(result.code).toBe('SOURCE_RECORD_UNSUPPORTED');
    expect(result.events).toHaveLength(1);
    expect(result.events[0].type).toBe('source.gap');
    expect(result.events[0].payload.coverage.state).toBe('unsupported');
    expect(result.nextOffset).toBe(0);
    expect(adapters.storedArtifacts).toHaveLength(0);
    expect(JSON.stringify(adapters.events)).not.toContain('DO_NOT_EXECUTE');
  });

  test('empty chunk commits no offset advancement', async () => {
    const adapters = createAdapters();
    const result = await importSpansSource(args(adapters));
    expect(result.ok).toBe(true);
    expect(result.nextOffset).toBe(0);
    expect(result.pendingBytes).toEqual(new Uint8Array());
    expect(
      adapters.cursors.get(JSON.stringify(['source-a', 0, parserVersion]))
    ).toBe(0);
  });

  test('new source refuses a nonzero starting offset', async () => {
    const adapters = createAdapters();
    const result = await importSpansSource(
      args(adapters, { bytes: line(message('skip')), offset: 12 })
    );
    expect(result.ok).toBe(false);
    expect(result.code).toBe('SOURCE_OFFSET_CONFLICT');
    expect(result.expectedOffset).toBe(0);
    expect(result.pendingBytes).toEqual(line(message('skip')));
    expect(adapters.calls.readSourceCursor).toBe(1);
    expect(adapters.calls.commitImport).toBe(0);
    expect(adapters.calls.put).toBe(0);
  });

  test('rejects an unsafe offset plus chunk length before adapter calls', async () => {
    const adapters = createAdapters();
    const result = await importSpansSource(
      args(adapters, {
        bytes: new Uint8Array([0x0a]),
        offset: Number.MAX_SAFE_INTEGER,
      })
    );
    expect(result.ok).toBe(false);
    expect(result.code).toBe('SOURCE_OFFSET_INVALID');
    expect(adapters.calls).toEqual({
      commitImport: 0,
      put: 0,
      readSourceCursor: 0,
    });
  });

  test('rejects an oversized batch before adapter calls', async () => {
    const adapters = createAdapters();
    const result = await importSpansSource(
      args(adapters, { bytes: new Uint8Array(4 * 1024 * 1024 + 1) })
    );
    expect(result.ok).toBe(false);
    expect(result.code).toBe('SOURCE_BATCH_TOO_LARGE');
    expect(adapters.calls).toEqual({
      commitImport: 0,
      put: 0,
      readSourceCursor: 0,
    });
  });

  test('uses the default 200-record page limit', async () => {
    const adapters = createAdapters();
    const records = Array.from({ length: 205 }, (_, index) =>
      line(message(`message ${index}`, `native-${index}`))
    );
    const bytes = concat(...records);
    const result = await importSpansSource(args(adapters, { bytes }));

    expect(result.ok).toBe(true);
    expect(result.events).toHaveLength(200);
    expect(result.nextOffset).toBe(
      records.slice(0, 200).reduce((total, record) => total + record.length, 0)
    );
  });

  test('validates optional maxRecords bounds before adapter calls', async () => {
    for (const maxRecords of [0, 201, 1.5]) {
      const adapters = createAdapters();
      // biome-ignore lint/performance/noAwaitInLoops: Keep negative cases independent and failure locations clear.
      const result = await importSpansSource(
        args(adapters, { bytes: line(message('hello')), maxRecords })
      );

      expect(result.ok).toBe(false);
      expect(result.code).toBe('SOURCE_IMPORT_INVALID');
      expect(adapters.calls).toEqual({
        commitImport: 0,
        put: 0,
        readSourceCursor: 0,
      });
    }
  });

  test('returns a fixed refusal for throwing accessors and proxies', async () => {
    const secret = 'provider-token-do-not-leak';
    const accessor = {};
    Object.defineProperty(accessor, 'bytes', {
      get() {
        throw new Error(secret);
      },
    });
    const proxy = new Proxy(
      {},
      {
        getOwnPropertyDescriptor() {
          throw new Error(secret);
        },
      }
    );

    for (const input of [accessor, proxy]) {
      // biome-ignore lint/performance/noAwaitInLoops: Verify each hostile input independently.
      const result = await importSpansSource(input);
      expect(result).toEqual({
        code: 'SOURCE_IMPORT_INVALID',
        error: 'Invalid source import arguments.',
        ok: false,
      });
      expect(JSON.stringify(result)).not.toContain(secret);
    }

    const adapters = createAdapters();
    const proxiedBytes = new Proxy(new Uint8Array([0x0a]), {
      get() {
        throw new Error(secret);
      },
    });
    const nestedProxy = await importSpansSource(
      args(adapters, { bytes: proxiedBytes })
    );
    expect(nestedProxy.code).toBe('SOURCE_IMPORT_INVALID');
    expect(JSON.stringify(nestedProxy)).not.toContain(secret);
    expect(adapters.calls).toEqual({
      commitImport: 0,
      put: 0,
      readSourceCursor: 0,
    });
  });
});

test('keeps the adapter error contract for missing or throwing adapters', async () => {
  const adapters = createAdapters();
  const broken = { readSourceCursor: undefined };
  const result = await importSpansSource(
    args(adapters, { bytes: line(message('hello')), store: broken })
  );
  expect(result.code).toBe('SOURCE_IMPORT_ADAPTER_INVALID');
  const throwing = Object.defineProperty({}, 'readSourceCursor', {
    get() {
      throw new Error('private adapter failure');
    },
  });
  const refused = await importSpansSource(
    args(adapters, { bytes: line(message('hello')), store: throwing })
  );
  expect(refused.code).toBe('SOURCE_IMPORT_ADAPTER_INVALID');
  expect(JSON.stringify(refused)).not.toContain('private adapter failure');
});
