import { afterEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import {
  appendFile,
  mkdtemp,
  open,
  realpath,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSpansArtifacts } from './spans-artifacts.js';
import { createSpansBackup, restoreSpansBackup } from './spans-maintenance.js';
import { readSpansSourcePage } from './spans-source-file.js';
import { importSpansSourceFile } from './spans-source-import.js';
import { openSpansStore } from './spans-store.js';

const fixtureRoots = [];
const realArchives = [];
afterEach(async () => {
  for (const archive of realArchives.splice(0)) {
    expect(archive.store.close().ok).toBe(true);
  }
  await Promise.all(
    fixtureRoots
      .splice(0)
      .map((root) => rm(root, { force: true, recursive: true }))
  );
});

const parserVersion = 'test-parser-1';
const sourceId = 'source-a';
const sourceGeneration = 0;
const runId = 'run-a';

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

function cursorKey(value) {
  return JSON.stringify([
    value.sourceId,
    value.sourceGeneration,
    value.parserVersion,
  ]);
}

function checkpointId(offset, overrides = {}) {
  return createHash('sha256')
    .update(
      JSON.stringify([
        overrides.sourceId ?? sourceId,
        overrides.sourceGeneration ?? sourceGeneration,
        overrides.parserVersion ?? parserVersion,
        offset,
      ]),
      'utf8'
    )
    .digest('hex');
}

function createArchive({ commitFailure = false, state } = {}) {
  const saved = state ?? {
    batches: new Map(),
    cursors: new Map(),
    events: [],
  };
  const calls = {
    commitImport: 0,
    getEventById: 0,
    put: 0,
    readSourceCursor: 0,
  };
  const store = {
    commitImport(batch) {
      calls.commitImport += 1;
      if (commitFailure) {
        return { code: 'STORAGE_FULL', ok: false };
      }
      if (batch.events.length > 200) {
        return { code: 'BATCH_LIMIT', ok: false };
      }
      const key = cursorKey(batch);
      const current = saved.cursors.get(key) ?? 0;
      const batchKey = JSON.stringify([
        key,
        batch.expectedOffset,
        batch.nextOffset,
      ]);
      const serialized = JSON.stringify(batch.events);
      if (saved.batches.get(batchKey) === serialized) {
        return { ok: true, replay: true };
      }
      if (batch.expectedOffset < current) {
        if (saved.batches.get(batchKey) === serialized) {
          return { ok: true, replay: true };
        }
        return { code: 'SOURCE_OFFSET_CONFLICT', ok: false };
      }
      if (
        batch.expectedOffset !== current ||
        batch.nextOffset < batch.expectedOffset
      ) {
        return { code: 'SOURCE_OFFSET_CONFLICT', ok: false };
      }
      if (
        batch.nextOffset === batch.expectedOffset &&
        (!batch.events.every((event) =>
          ['source.gap', 'source.checkpoint'].includes(event.type)
        ) ||
          (batch.events.some((event) => event.type === 'source.checkpoint') &&
            !batch.events.some((event) => event.type === 'source.gap')))
      ) {
        return { code: 'INVALID_ZERO_PROGRESS', ok: false };
      }
      if (
        batch.nextOffset === batch.expectedOffset &&
        batch.events.length === 0
      ) {
        return { ok: true };
      }
      for (const event of batch.events) {
        const existing = saved.events.find(
          (candidate) => candidate.eventId === event.eventId
        );
        if (existing && JSON.stringify(existing) !== JSON.stringify(event)) {
          return { code: 'SOURCE_EVENT_CONFLICT', ok: false };
        }
      }
      saved.batches.set(batchKey, serialized);
      for (const event of batch.events) {
        if (
          !saved.events.some((candidate) => candidate.eventId === event.eventId)
        ) {
          saved.events.push(event);
        }
      }
      saved.cursors.set(key, batch.nextOffset);
      return { ok: true };
    },
    getEventById({ eventId }) {
      calls.getEventById += 1;
      const event = saved.events.find(
        (candidate) => candidate.eventId === eventId
      );
      return event
        ? { event, found: true, ok: true }
        : { event: null, found: false, ok: true };
    },
    readSourceCursor(identity) {
      calls.readSourceCursor += 1;
      const offset = saved.cursors.get(cursorKey(identity));
      return {
        found: offset !== undefined,
        offset: offset ?? 0,
        ok: true,
      };
    },
  };
  const artifacts = {
    onPut: undefined,
    async put(artifact) {
      calls.put += 1;
      // biome-ignore lint/suspicious/noUnnecessaryConditions: The failure test assigns this hook before importing.
      if (artifacts.onPut) {
        await artifacts.onPut();
      }
      const artifactId = createHash('sha256')
        .update(artifact.text, 'utf8')
        .digest('hex');
      artifacts.stored.push({ ...artifact, artifactId });
      return { artifactId, ok: true };
    },
    stored: [],
  };
  return { artifacts, calls, saved, store };
}

async function sourceFile(contents, name = 'session.jsonl') {
  const directory = await mkdtemp(join(tmpdir(), 'setu-spans-source-import-'));
  fixtureRoots.push(directory);
  const path = join(directory, name);
  await writeFile(path, contents);
  return path;
}

async function createRealArchive() {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), 'setu-spans-real-source-import-'))
  );
  fixtureRoots.push(root);
  const storeRoot = join(root, 'archive');
  const archive = {
    artifacts: createSpansArtifacts({ root: storeRoot }),
    root,
    store: openSpansStore({ root: storeRoot }),
    storeRoot,
  };
  realArchives.push(archive);
  return archive;
}

function args(adapters, path, overrides = {}) {
  return {
    artifacts: adapters.artifacts,
    parserVersion,
    path,
    provider: 'codex',
    runId,
    sourceGeneration,
    sourceId,
    store: adapters.store,
    ...overrides,
  };
}

function storedOffset(adapters) {
  return (
    adapters.saved.cursors.get(
      JSON.stringify([sourceId, sourceGeneration, parserVersion])
    ) ?? 0
  );
}

describe('importSpansSourceFile', () => {
  test('commits at most 199 records plus a checkpoint per page', async () => {
    const records = Array.from({ length: 205 }, (_, index) =>
      line(message(`message ${index}`, `native-${index}`))
    );
    const path = await sourceFile(
      Buffer.concat(records.map((record) => Buffer.from(record)))
    );
    const adapters = createArchive();

    const first = await importSpansSourceFile(args(adapters, path));
    const firstOffset = records
      .slice(0, 199)
      .reduce((total, record) => total + record.length, 0);
    expect(first.ok).toBe(true);
    expect(first.importedCount).toBe(199);
    expect(first.nextOffset).toBe(firstOffset);
    expect(first.hasMore).toBe(true);
    expect(
      adapters.saved.events.filter(
        (event) => event.type === 'source.checkpoint'
      )
    ).toHaveLength(1);
    expect(adapters.saved.events).toHaveLength(200);
    expect(adapters.saved.events.at(-1).payload.offset).toBe(firstOffset);
    expect(
      'readObservation' in adapters.saved.events.at(-1).payload.identity
    ).toBe(false);

    const second = await importSpansSourceFile(args(adapters, path));
    expect(second.ok).toBe(true);
    expect(second.importedCount).toBe(6);
    expect(second.nextOffset).toBe(
      records.reduce((total, record) => total + record.length, 0)
    );
    expect(second.hasMore).toBe(false);
    expect(
      adapters.saved.events.filter(
        (event) => event.type === 'source.checkpoint'
      )
    ).toHaveLength(2);
    expect(adapters.saved.events).toHaveLength(207);
    expect(adapters.saved.events.every((event) => event.runId === runId)).toBe(
      true
    );
  });

  test('imports 205 records through the real store and artifacts across reopen', async () => {
    const secret = 'sk-proj-1234567890abcdefghijkl';
    const records = Array.from({ length: 205 }, (_, index) =>
      line(
        message(
          index === 0 ? `first ${secret}` : `message ${index}`,
          `native-${index}`
        )
      )
    );
    const path = await sourceFile(
      Buffer.concat(records.map((record) => Buffer.from(record)))
    );
    const archive = await createRealArchive();

    const first = await importSpansSourceFile(args(archive, path));
    const firstOffset = records
      .slice(0, 199)
      .reduce((total, record) => total + record.length, 0);
    expect(first.ok).toBe(true);
    expect(first.importedCount).toBe(199);
    expect(first.nextOffset).toBe(firstOffset);
    expect(first.hasMore).toBe(true);

    const firstPage = archive.store.readEvents({ limit: 200, runId });
    expect(firstPage.ok).toBe(true);
    expect(firstPage.events).toHaveLength(200);
    expect(firstPage.events.at(-1).type).toBe('source.checkpoint');
    expect(JSON.stringify(firstPage.events)).not.toContain(secret);
    const firstMessage = firstPage.events.find(
      (event) => event.type === 'source.message'
    );
    const artifact = archive.artifacts.read({
      artifactId: firstMessage.payload.artifactId,
    });
    expect(artifact.ok).toBe(true);
    expect(artifact.text).not.toContain(secret);

    expect(archive.store.close().ok).toBe(true);
    archive.store = openSpansStore({ root: archive.storeRoot });
    expect(
      archive.store.readSourceCursor({
        parserVersion,
        sourceGeneration,
        sourceId,
      })
    ).toMatchObject({ found: true, offset: firstOffset, ok: true });

    const second = await importSpansSourceFile(args(archive, path));
    expect(second.ok).toBe(true);
    expect(second.importedCount).toBe(6);
    expect(second.nextOffset).toBe(
      records.reduce((total, record) => total + record.length, 0)
    );
    expect(second.hasMore).toBe(false);
    const finalPage = archive.store.readEvents({
      afterSequence: 200,
      limit: 200,
      runId,
    });
    expect(finalPage.ok).toBe(true);
    expect(finalPage.events).toHaveLength(7);
    expect(
      [...firstPage.events, ...finalPage.events].filter(
        (event) => event.type === 'source.checkpoint'
      )
    ).toHaveLength(2);
    expect(archive.store.close().ok).toBe(true);
  });

  test('a zero-progress malformed record binds identity and replays once', async () => {
    const malformed = new TextEncoder().encode('{broken}\n');
    const path = await sourceFile(malformed);
    const archive = await createRealArchive();

    const first = await importSpansSourceFile(args(archive, path));
    expect(first.ok).toBe(false);
    expect(first.code).toBe('SOURCE_RECORD_INVALID');
    expect(first.nextOffset).toBe(0);
    expect(first.pendingByteCount).toBe(malformed.length);
    expect(first.hasMore).toBe(false);
    const storedFirst = archive.store.readEvents({ limit: 10, runId });
    expect(storedFirst.events.map((event) => event.type)).toEqual([
      'source.gap',
      'source.checkpoint',
    ]);
    const originalGapId = storedFirst.events[0].eventId;
    expect(storedFirst.events[1].eventId).toBe(checkpointId(0));
    expect(storedFirst.events[1].payload).toMatchObject({
      offset: 0,
      parserVersion,
      sourceGeneration,
      sourceId,
    });
    expect(storedFirst.events[1].payload.identity.offset).toBe(0);
    const originalDigest = archive.store.readSourceCursor({
      parserVersion,
      sourceGeneration,
      sourceId,
    }).batchDigest;

    const replay = await importSpansSourceFile(args(archive, path));
    expect(replay.ok).toBe(false);
    expect(replay.code).toBe('SOURCE_RECORD_INVALID');
    expect(replay.gapCount).toBe(1);
    const storedReplay = archive.store.readEvents({ limit: 10, runId });
    expect(storedReplay.events).toHaveLength(2);
    expect(storedReplay.events[0].eventId).toBe(originalGapId);
    expect(
      archive.store.readSourceCursor({
        parserVersion,
        sourceGeneration,
        sourceId,
      }).batchDigest
    ).toBe(originalDigest);

    const differentRun = await importSpansSourceFile(
      args(archive, path, { runId: 'run-b' })
    );
    expect(differentRun.ok).toBe(false);
    expect(differentRun.code).toBe('SOURCE_RUN_CONFLICT');

    await rename(path, `${path}.old`);
    await writeFile(path, malformed);
    const replacement = await importSpansSourceFile(args(archive, path));
    expect(replacement.ok).toBe(false);
    expect(replacement.code).toBe('SOURCE_REPLACED');
    expect(archive.store.readEvents({ limit: 10, runId }).events).toHaveLength(
      2
    );
    expect(archive.store.close().ok).toBe(true);
  });

  test('a too-small page reports pending bytes without claiming progress', async () => {
    const path = await sourceFile(line(message('can progress later')));
    const adapters = createArchive();

    const small = await importSpansSourceFile(
      args(adapters, path, { maxBytes: 1 })
    );
    expect(small.ok).toBe(true);
    expect(small.nextOffset).toBe(0);
    expect(small.pendingByteCount).toBe(1);
    expect(small.hasMore).toBe(false);
    expect(adapters.saved.events).toHaveLength(0);

    const larger = await importSpansSourceFile(args(adapters, path));
    expect(larger.ok).toBe(true);
    expect(larger.nextOffset).toBeGreaterThan(0);
    expect(larger.importedCount).toBe(1);
    expect(larger.pendingByteCount).toBe(0);
  });

  test('holds partial UTF-8 and JSON bytes until append completes the record', async () => {
    const complete = line(message('café — done'));
    const split = complete.indexOf(0xc3) + 1;
    const path = await sourceFile(complete.slice(0, split));
    const adapters = createArchive();

    const first = await importSpansSourceFile(args(adapters, path));
    expect(first.ok).toBe(true);
    expect(first.nextOffset).toBe(0);
    expect(first.importedCount).toBe(0);
    expect(first.pendingByteCount).toBe(complete.slice(0, split).length);
    expect(first.hasMore).toBe(false);
    expect(adapters.saved.events).toHaveLength(0);
    expect(storedOffset(adapters)).toBe(0);

    await appendFile(path, complete.slice(split));
    const second = await importSpansSourceFile(args(adapters, path));
    expect(second.ok).toBe(true);
    expect(second.nextOffset).toBe(complete.length);
    expect(second.importedCount).toBe(1);
    expect(JSON.parse(adapters.artifacts.stored[0].text).text).toBe(
      'café — done'
    );
  });

  test('keeps a malformed middle record at the first bad byte without duplicate gaps', async () => {
    const first = line(message('before gap', 'first'));
    const malformed = new TextEncoder().encode('{broken}\n');
    const later = line(message('after gap', 'later'));
    const path = await sourceFile(Buffer.concat([first, malformed, later]));
    const adapters = createArchive();

    const initial = await importSpansSourceFile(args(adapters, path));
    expect(initial.ok).toBe(false);
    expect(initial.code).toBe('SOURCE_RECORD_INVALID');
    expect(initial.nextOffset).toBe(first.length);
    expect(initial.importedCount).toBe(1);
    expect(initial.gapCount).toBe(1);
    expect(storedOffset(adapters)).toBe(first.length);

    const replay = await importSpansSourceFile(args(adapters, path));
    expect(replay.ok).toBe(false);
    expect(replay.nextOffset).toBe(first.length);
    expect(replay.gapCount).toBe(1);
    expect(
      adapters.saved.events.filter((event) => event.type === 'source.gap')
    ).toHaveLength(1);
    expect(storedOffset(adapters)).toBe(first.length);
  });

  test('refuses replacement, truncation and committed-prefix rewrites', async () => {
    for (const mutation of ['replacement', 'truncation', 'prefix']) {
      const bytes = line(message('committed', 'same-id'));
      // biome-ignore lint/performance/noAwaitInLoops: Each mutation checks an ordered read, change and refusal.
      const path = await sourceFile(bytes);
      const adapters = createArchive();
      const first = await importSpansSourceFile(args(adapters, path));
      expect(first.ok).toBe(true);
      const committedOffset = storedOffset(adapters);

      if (mutation === 'replacement') {
        await rename(path, `${path}.old`);
        await writeFile(path, bytes);
      } else if (mutation === 'truncation') {
        await writeFile(path, bytes.slice(0, Math.max(0, bytes.length - 2)));
      } else {
        const handle = await open(path, 'r+');
        await handle.write(Buffer.from('!'), 0, 1, 0);
        await handle.close();
      }

      const refused = await importSpansSourceFile(args(adapters, path));
      expect(refused.ok).toBe(false);
      expect(refused.code).toBe(
        {
          prefix: 'SOURCE_PREFIX_CHANGED',
          replacement: 'SOURCE_REPLACED',
          truncation: 'SOURCE_TRUNCATED',
        }[mutation]
      );
      expect(storedOffset(adapters)).toBe(committedOffset);
    }
  });

  test('fails checkpoint verification after a page changes and before archive commit', async () => {
    const bytes = line(message('read then changed'));
    const path = await sourceFile(bytes);
    const adapters = createArchive();
    adapters.artifacts.onPut = async () => {
      adapters.artifacts.onPut = undefined;
      const handle = await open(path, 'r+');
      await handle.write(Buffer.from('!'), 0, 1, 0);
      await handle.close();
    };

    const result = await importSpansSourceFile(args(adapters, path));
    expect(result.ok).toBe(false);
    expect(result.code).toBe('SOURCE_PREFIX_CHANGED');
    expect(storedOffset(adapters)).toBe(0);
    expect(adapters.saved.events).toHaveLength(0);
  });

  test('commit failure leaves events and the checkpoint absent', async () => {
    const path = await sourceFile(line(message('commit failure')));
    const adapters = createArchive({ commitFailure: true });
    const result = await importSpansSourceFile(args(adapters, path));

    expect(result.ok).toBe(false);
    expect(result.code).toBe('STORAGE_FULL');
    expect(storedOffset(adapters)).toBe(0);
    expect(adapters.saved.events).toHaveLength(0);
    expect(adapters.artifacts.stored).toHaveLength(1);
    expect(
      adapters.store.getEventById({
        eventId: checkpointId(line(message('commit failure')).length),
      })
    ).toEqual({ event: null, found: false, ok: true });
  });

  test('resumes from the stored checkpoint after constructing a fresh coordinator call', async () => {
    const first = line(message('first', 'first'));
    const second = line(message('second', 'second'));
    const path = await sourceFile(Buffer.concat([first, second]));
    const adapters = createArchive();
    const firstPage = await importSpansSourceFile(
      args(adapters, path, { maxBytes: first.length })
    );
    expect(firstPage.ok).toBe(true);
    expect(firstPage.nextOffset).toBe(first.length);

    // A new adapter wrapper over the same committed archive has no page cache.
    const reopened = createArchive({ state: adapters.saved });
    const resumed = await importSpansSourceFile(args(reopened, path));
    expect(resumed.ok).toBe(true);
    expect(resumed.expectedOffset).toBe(first.length);
    expect(resumed.importedCount).toBe(1);
    expect(resumed.nextOffset).toBe(first.length + second.length);
  });

  test('refuses a nonzero cursor without its checkpoint event', async () => {
    const path = await sourceFile(line(message('must not restart')));
    const adapters = createArchive();
    adapters.saved.cursors.set(
      JSON.stringify([sourceId, sourceGeneration, parserVersion]),
      7
    );

    const result = await importSpansSourceFile(args(adapters, path));
    expect(result.ok).toBe(false);
    expect(result.code).toBe('SOURCE_CHECKPOINT_MISSING');
    expect(result.nextOffset).toBe(7);
    expect(storedOffset(adapters)).toBe(7);
    expect(adapters.calls.put).toBe(0);
  });

  test('refuses to reuse an existing source checkpoint from another run', async () => {
    const path = await sourceFile(line(message('first run')));
    const adapters = createArchive();
    const first = await importSpansSourceFile(args(adapters, path));
    expect(first.ok).toBe(true);

    const otherRun = await importSpansSourceFile(
      args(adapters, path, { runId: 'run-b' })
    );
    expect(otherRun.ok).toBe(false);
    expect(otherRun.code).toBe('SOURCE_RUN_CONFLICT');
    expect(otherRun.nextOffset).toBe(first.nextOffset);
    expect(adapters.calls.put).toBe(1);
  });

  test('concurrent different pages have one CAS winner and one offset conflict', async () => {
    const first = line(message('first', 'first'));
    const second = line(message('second', 'second'));
    const path = await sourceFile(Buffer.concat([first, second]));
    const adapters = createArchive();

    const results = await Promise.all([
      importSpansSourceFile(args(adapters, path, { maxBytes: first.length })),
      importSpansSourceFile(args(adapters, path)),
    ]);

    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(
      results.filter((result) => result.code === 'SOURCE_OFFSET_CONFLICT')
    ).toHaveLength(1);
    expect(
      adapters.saved.events.filter(
        (event) => event.type === 'source.checkpoint'
      )
    ).toHaveLength(1);
  });

  test('concurrent exact pages replay the same atomic event batch once', async () => {
    const bytes = line(message('same page'));
    const path = await sourceFile(bytes);
    const adapters = createArchive();

    const results = await Promise.all([
      importSpansSourceFile(args(adapters, path)),
      importSpansSourceFile(args(adapters, path)),
    ]);

    expect(results.every((result) => result.ok)).toBe(true);
    expect(adapters.saved.events).toHaveLength(2);
    expect(
      adapters.saved.events.filter((event) => event.type === 'source.message')
    ).toHaveLength(1);
    expect(
      adapters.saved.events.filter(
        (event) => event.type === 'source.checkpoint'
      )
    ).toHaveLength(1);
  });

  test('a stored zero-offset checkpoint still binds the selected file identity', async () => {
    const bytes = line(message('zero offset'));
    const path = await sourceFile(bytes);
    const page = await readSpansSourcePage({ offset: 0, path });
    const adapters = createArchive();
    const { readObservation: _readObservation, ...identity } =
      page.observedIdentity;
    adapters.saved.events.push({
      eventId: checkpointId(0),
      payload: {
        identity,
        offset: 0,
        parserVersion,
        provider: 'codex',
        sourceGeneration,
        sourceId,
      },
      runId,
      type: 'source.checkpoint',
    });
    await rename(path, `${path}.old`);
    await writeFile(path, bytes);

    const result = await importSpansSourceFile(args(adapters, path));
    expect(result.ok).toBe(false);
    expect(result.code).toBe('SOURCE_REPLACED');
    expect(storedOffset(adapters)).toBe(0);
    expect(adapters.calls.put).toBe(0);
  });

  test('requires an explicit absolute selected path and returns no source bytes', async () => {
    const adapters = createArchive();
    const invalid = await importSpansSourceFile(
      args(adapters, 'relative.jsonl')
    );
    expect(invalid.ok).toBe(false);
    expect(invalid.code).toBe('SOURCE_IMPORT_INVALID');
    const path = await sourceFile(line(message('bounded result')));
    const result = await importSpansSourceFile(args(adapters, path));
    expect(JSON.stringify(result)).not.toContain('pendingBytes');
    expect(JSON.stringify(result)).not.toContain('bounded result');
    expect(JSON.stringify(result)).not.toContain(path);
  });

  test('returns a fixed refusal for throwing accessors and proxies', async () => {
    const secret = '/private/session-secret.jsonl';
    const accessor = {};
    Object.defineProperty(accessor, 'path', {
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
      const result = await importSpansSourceFile(input);
      expect(result).toEqual({
        code: 'SOURCE_IMPORT_INVALID',
        eof: null,
        error: 'Invalid source file import arguments.',
        expectedOffset: null,
        gapCount: 0,
        hasMore: false,
        importedCount: 0,
        nextOffset: null,
        ok: false,
        pendingByteCount: null,
      });
      expect(JSON.stringify(result)).not.toContain(secret);
    }
  });
});

test('a stored checkpoint cannot be resumed with another provider parser', async () => {
  const path = await sourceFile(line(message('bound provider')));
  const archive = await createRealArchive();
  const first = await importSpansSourceFile(args(archive, path));
  expect(first.ok).toBe(true);
  const changed = await importSpansSourceFile(
    args(archive, path, { provider: 'claude' })
  );
  expect(changed.code).toBe('SOURCE_CHECKPOINT_INVALID');
  expect(changed.nextOffset).toBe(first.nextOffset);
});

test('a restored archive retains artifacts and resumes from the atomic source checkpoint', async () => {
  const path = await sourceFile(line(message('before backup', 'first')));
  const archive = await createRealArchive();
  const first = await importSpansSourceFile(args(archive, path));
  expect(first.ok).toBe(true);
  const backupRoot = join(archive.root, 'backup');
  expect(
    createSpansBackup({ destination: backupRoot, root: archive.storeRoot }).ok
  ).toBe(true);
  const restoredRoot = join(archive.root, 'restored');
  expect(restoreSpansBackup({ backupRoot, destination: restoredRoot }).ok).toBe(
    true
  );
  const restored = {
    artifacts: createSpansArtifacts({ root: restoredRoot }),
    store: openSpansStore({ root: restoredRoot }),
  };
  realArchives.push(restored);
  const before = restored.store.readEvents({ runId });
  const { artifactId } = before.events.find(
    (event) => event.type === 'source.message'
  ).payload;
  expect(restored.artifacts.read({ artifactId }).ok).toBe(true);
  await appendFile(path, line(message('after restore', 'second')));
  const resumed = await importSpansSourceFile(args(restored, path));
  expect(resumed.ok).toBe(true);
  expect(resumed.expectedOffset).toBe(first.nextOffset);
  expect(resumed.importedCount).toBe(1);
  expect(restored.store.readEvents({ runId }).events).toHaveLength(4);
  expect(archive.store.readEvents({ runId }).events).toHaveLength(2);
});
