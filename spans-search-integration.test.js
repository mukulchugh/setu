import { Database } from 'bun:sqlite';
import { afterEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createSpansArtifacts } from './spans-artifacts.js';
import { importSpansSource } from './spans-import.js';
import { createSpansBackup, restoreSpansBackup } from './spans-maintenance.js';
import { createSpansRuntime } from './spans-runtime.js';
import { SPANS_SEARCH_TEXT_LIMITS } from './spans-search-text.js';
import { createSpansService, SPANS_SERVICE_LIMITS } from './spans-service.js';
import { openSpansStore, SPANS_STORE_DATABASE_FILE } from './spans-store.js';

const parents = [];
const stores = [];

afterEach(() => {
  for (const store of stores.splice(0).reverse()) {
    store.close();
  }
  for (const parent of parents.splice(0)) {
    rmSync(parent, { force: true, recursive: true });
  }
});

// The backup helpers require canonical roots, and tmpdir() is a symlink on macOS.
function newRoot() {
  const parent = realpathSync(mkdtempSync(join(tmpdir(), 'spans-search-int-')));
  parents.push(parent);
  return join(parent, 'archive');
}

function openArchive(root, options = {}) {
  const store = openSpansStore({ root, ...options });
  stores.push(store);
  return { artifacts: createSpansArtifacts({ root }), root, store };
}

const secretText =
  'Authorization: Bearer abcdefghijklmnop key sk-proj-abcdefghijklmnop';

function codexLine(text, id) {
  return JSON.stringify({
    payload: {
      content: [{ text, type: 'output_text' }],
      id,
      role: 'assistant',
      type: 'message',
    },
    type: 'response_item',
  });
}

async function importLines(archive, lines, { runId = 'run-a' } = {}) {
  const result = await importSpansSource({
    artifacts: archive.artifacts,
    bytes: new TextEncoder().encode(`${lines.join('\n')}\n`),
    offset: 0,
    parserVersion: 'parser-1',
    provider: 'codex',
    runId,
    sourceGeneration: 0,
    sourceId: 'source-a',
    store: archive.store,
  });
  expect(result.ok).toBe(true);
  return result.events;
}

const importMessages = (archive, texts, options) =>
  importLines(
    archive,
    texts.map((text, index) => codexLine(text, `native-${index}`)),
    options
  );

function note(store, eventId, payload, runId = 'run-a') {
  expect(
    store.appendEvent({ eventId, payload, runId, type: 'run.note' }).ok
  ).toBe(true);
}

function rawRows(root, sql) {
  const db = new Database(join(root, SPANS_STORE_DATABASE_FILE), {
    readonly: true,
    strict: true,
  });
  try {
    return db.query(sql).all();
  } finally {
    db.close(true);
  }
}

const searchObjects = (root) =>
  rawRows(
    root,
    "SELECT name FROM sqlite_master WHERE name LIKE 'spans_search%'"
  );

const searchBodies = (root) =>
  rawRows(root, 'SELECT body FROM spans_search ORDER BY rowid').map(
    (row) => row.body
  );

function fingerprint(root) {
  return [SPANS_STORE_DATABASE_FILE, `${SPANS_STORE_DATABASE_FILE}-wal`]
    .map((name) => {
      try {
        return createHash('sha256')
          .update(readFileSync(join(root, name)))
          .digest('hex');
      } catch {
        return 'absent';
      }
    })
    .join();
}

function artifactPath(root, artifactId) {
  return join(root, 'artifacts', artifactId.slice('sha256:'.length));
}

// An envelope that passes the artifact helper's digest check but was never
// redacted, to prove the index redacts again instead of trusting the file.
function plantArtifact(root, record) {
  const text = JSON.stringify(record);
  const digest = createHash('sha256')
    .update('application/json')
    .update('\0')
    .update(text, 'utf8')
    .digest('hex');
  const directory = join(root, 'artifacts');
  mkdirSync(directory, { mode: 0o700, recursive: true });
  chmodSync(directory, 0o700);
  const path = join(directory, digest);
  writeFileSync(
    path,
    JSON.stringify({ mediaType: 'application/json', text, version: 1 }),
    { mode: 0o600 }
  );
  chmodSync(path, 0o600);
  return `sha256:${digest}`;
}

describe('real archive search lifecycle', () => {
  test('large artifact text indexes through its tail and survives reopen and backup', async () => {
    const root = newRoot();
    const parent = dirname(root);
    let archive = openArchive(root);
    const tailMatch = 'distinctiveartifacttailneedle';
    const largeText = `${'ordinary searchable words '.repeat(12_000)} ${tailMatch}`;
    const [message] = await importMessages(archive, [largeText]);
    note(archive.store, 'following-note', { summary: 'normal event follows' });
    expect(message.payload.artifactId.startsWith('sha256:')).toBe(true);
    expect(largeText.indexOf(tailMatch)).toBeGreaterThan(262_144);

    expect(archive.store.initializeSearch()).toEqual({ ok: true, version: 1 });
    expect(archive.store.indexSearchPage({ limit: 10 })).toMatchObject({
      coverage: { complete: true, indexedSequence: 2, latestSequence: 2 },
      hasMore: false,
      indexed: 2,
      ok: true,
    });
    const found = archive.store.search({ limit: 10, query: tailMatch });
    expect(found.hits.map((hit) => hit.eventId)).toEqual([message.eventId]);

    expect(archive.store.close()).toEqual({ ok: true });
    archive = openArchive(root);
    expect(archive.store.search({ limit: 10, query: tailMatch })).toEqual(
      found
    );
    expect(archive.store.close()).toEqual({ ok: true });

    const backup = join(parent, 'large-backup');
    const restored = join(parent, 'large-restored');
    expect(createSpansBackup({ destination: backup, root })).toMatchObject({
      ok: true,
    });
    expect(
      restoreSpansBackup({ backupRoot: backup, destination: restored })
    ).toMatchObject({ ok: true });
    const restoredArchive = openArchive(restored, { readonly: true });
    expect(
      restoredArchive.store.search({ limit: 10, query: tailMatch })
    ).toEqual(found);
  });

  test('initialize, index, query and reopen use the real store', async () => {
    const root = newRoot();
    let archive = openArchive(root);
    note(archive.store, 'note-1', {
      rawTranscript: 'raw transcript words',
      sourcePath: '/Users/example/private/session.jsonl',
      summary: 'visible note needle',
    });
    const imported = await importMessages(archive, [
      'alpha needle one',
      `beta needle two ${secretText}`,
    ]);
    expect(archive.store.initializeSearch()).toEqual({ ok: true, version: 1 });
    expect(archive.store.searchStatus()).toMatchObject({
      coverage: {
        complete: false,
        indexedSequence: 0,
        latestSequence: 3,
        stale: true,
      },
      generation: 0,
      ok: true,
    });
    expect(archive.store.indexSearchPage({ limit: 2 })).toMatchObject({
      coverage: { indexedSequence: 2, latestSequence: 3 },
      hasMore: true,
      indexed: 2,
      ok: true,
    });
    expect(archive.store.indexSearchPage({ limit: 2 })).toMatchObject({
      coverage: {
        complete: true,
        indexedSequence: 3,
        latestSequence: 3,
        stale: false,
      },
      hasMore: false,
      indexed: 1,
      ok: true,
    });

    const eventIds = ['note-1', ...imported.map((event) => event.eventId)];
    const found = archive.store.search({ limit: 10, query: 'needle' });
    expect(found.hits.map((hit) => hit.eventId)).toEqual(eventIds);
    expect(found.hits.every((hit) => hit.historical === true)).toBe(true);

    // Source paths, raw unknown payloads and secrets never reach the index.
    for (const query of [
      'transcript',
      'Users',
      'private',
      'abcdefghijklmnop',
    ]) {
      expect(archive.store.search({ limit: 10, query }).hits).toEqual([]);
    }
    const bodies = searchBodies(root).join('\n');
    expect(bodies).toContain('[REDACTED]');
    expect(bodies).not.toContain('abcdefghijklmnop');
    expect(bodies).not.toContain('raw transcript');
    expect(bodies).not.toContain('/Users/example');

    expect(archive.store.close()).toEqual({ ok: true });
    archive = openArchive(root);
    expect(archive.store.searchStatus()).toMatchObject({
      coverage: { complete: true, indexedSequence: 3, latestSequence: 3 },
      ok: true,
    });
    expect(archive.store.search({ limit: 10, query: 'needle' })).toEqual(found);
    expect(archive.store.indexSearchPage({ limit: 5 })).toMatchObject({
      indexed: 0,
      ok: true,
    });
  });

  test('tool-call records contribute no searchable text', async () => {
    const root = newRoot();
    const archive = openArchive(root);
    await importLines(archive, [
      JSON.stringify({
        payload: {
          arguments: '{"cmd":"toolargumentword"}',
          call_id: 'call-1',
          id: 'tool-1',
          name: 'shell',
          type: 'function_call',
        },
        type: 'response_item',
      }),
      codexLine('prose survivor', 'native-1'),
    ]);
    archive.store.initializeSearch();
    expect(archive.store.indexSearchPage({ limit: 10 })).toMatchObject({
      coverage: { complete: true },
      indexed: 2,
      ok: true,
    });
    expect(
      archive.store.search({ limit: 10, query: 'toolargumentword' }).hits
    ).toEqual([]);
    expect(
      archive.store.search({ limit: 10, query: 'survivor' }).hits
    ).toHaveLength(1);
    expect(searchBodies(root)).toEqual(['prose survivor']);
  });

  test('ordinary open, queries and runtime reads never create or index the schema', async () => {
    const root = newRoot();
    const { store } = openArchive(root);
    note(store, 'note-1', { summary: 'needle' });
    const before = fingerprint(root);
    for (const result of [
      store.search({ limit: 1, query: 'needle' }),
      store.searchStatus(),
      store.indexSearchPage({ limit: 1 }),
      store.invalidateSearch(),
    ]) {
      expect(result).toEqual({
        code: 'SPANS_SEARCH_UNAVAILABLE',
        error: 'Spans search is unavailable.',
        ok: false,
      });
    }
    const runtime = createSpansRuntime({ root });
    expect(
      await runtime.spansSearch({ limit: 1, query: 'needle' })
    ).toMatchObject({
      code: 'SPANS_SERVICE_UNAVAILABLE',
      ok: false,
    });
    expect(await runtime.spansSearchStatus()).toMatchObject({
      code: 'SPANS_SERVICE_UNAVAILABLE',
      ok: false,
    });
    expect(runtime.close().ok).toBe(true);
    expect(searchObjects(root)).toEqual([]);
    expect(
      rawRows(
        root,
        "SELECT key FROM metadata WHERE key = 'search_schema_version'"
      )
    ).toEqual([]);
    expect(fingerprint(root)).toBe(before);
  });

  test('a runtime over an absent archive stays absent for search', async () => {
    const root = newRoot();
    const runtime = createSpansRuntime({ root });
    expect(
      await runtime.spansSearch({ limit: 1, query: 'needle' })
    ).toMatchObject({
      code: 'SPANS_ARCHIVE_NOT_INITIALIZED',
      ok: false,
    });
    expect(await runtime.spansSearchStatus()).toMatchObject({ ok: false });
    expect(runtime.close().ok).toBe(true);
    expect(() => readFileSync(join(root, SPANS_STORE_DATABASE_FILE))).toThrow();
  });

  test('a read-only store queries but refuses every search write without touching the file', () => {
    const root = newRoot();
    const writer = openArchive(root);
    note(writer.store, 'note-1', { summary: 'needle one' });
    note(writer.store, 'note-2', { summary: 'needle two' });
    writer.store.initializeSearch();
    writer.store.indexSearchPage({ limit: 1 });
    // The writer stays open so no connection closes and rewrites the files.
    const before = fingerprint(root);
    const readonly = openArchive(root, { readonly: true });
    expect(readonly.store.search({ limit: 10, query: 'needle' })).toMatchObject(
      {
        coverage: {
          complete: false,
          indexedSequence: 1,
          latestSequence: 2,
          stale: true,
        },
        hits: [{ eventId: 'note-1' }],
        ok: true,
      }
    );
    expect(readonly.store.searchStatus()).toMatchObject({ ok: true });
    for (const result of [
      readonly.store.initializeSearch(),
      readonly.store.indexSearchPage({ limit: 1 }),
      readonly.store.invalidateSearch(),
    ]) {
      expect(result).toEqual({
        code: 'SPANS_SEARCH_READONLY',
        error: 'Spans search cannot be changed on a read-only archive.',
        ok: false,
      });
    }
    expect(readonly.store.close()).toEqual({ ok: true });
    expect(fingerprint(root)).toBe(before);
    expect(searchBodies(root)).toEqual(['needle one']);
  });

  test('a read-only store cannot create the schema and reports search unavailable', () => {
    const root = newRoot();
    const writer = openArchive(root);
    note(writer.store, 'note-1', { summary: 'needle' });
    const readonly = openArchive(root, { readonly: true });
    expect(readonly.store.initializeSearch()).toMatchObject({
      code: 'SPANS_SEARCH_READONLY',
    });
    expect(readonly.store.search({ limit: 1, query: 'needle' })).toMatchObject({
      code: 'SPANS_SEARCH_UNAVAILABLE',
    });
    expect(searchObjects(root)).toEqual([]);
  });

  test('newer and partial search schemas are refused safely by every operation', () => {
    for (const [prepare, code] of [
      [
        (db) =>
          db
            .query('INSERT INTO metadata (key, value) VALUES (?, ?)')
            .run('search_schema_version', '2'),
        'SPANS_STORE_SCHEMA_NEWER',
      ],
      [
        (db) =>
          db.run('CREATE TABLE spans_search_progress (singleton INTEGER)'),
        'SPANS_STORE_SCHEMA_UNSUPPORTED',
      ],
    ]) {
      const root = newRoot();
      const { store } = openArchive(root);
      note(store, 'note-1', { summary: 'needle' });
      const raw = new Database(join(root, SPANS_STORE_DATABASE_FILE), {
        readwrite: true,
        strict: true,
      });
      try {
        prepare(raw);
      } finally {
        raw.close(true);
      }
      const objects = rawRows(
        root,
        'SELECT name, sql FROM sqlite_master ORDER BY name'
      );
      const metadata = rawRows(
        root,
        'SELECT key, value FROM metadata ORDER BY key'
      );
      for (const result of [
        store.initializeSearch(),
        store.indexSearchPage({ limit: 1 }),
        store.search({ limit: 1, query: 'needle' }),
        store.searchStatus(),
        store.invalidateSearch(),
      ]) {
        expect(result).toMatchObject({ code, ok: false });
        expect(Object.keys(result).sort()).toEqual(['code', 'error', 'ok']);
      }
      expect(
        rawRows(root, 'SELECT name, sql FROM sqlite_master ORDER BY name')
      ).toEqual(objects);
      expect(
        rawRows(root, 'SELECT key, value FROM metadata ORDER BY key')
      ).toEqual(metadata);
    }
  });
});

describe('artifact text', () => {
  test('a corrupt, missing or oversized artifact holds progress and recovers when restored', async () => {
    const root = newRoot();
    const archive = openArchive(root);
    const imported = await importMessages(archive, [
      'first needle',
      'second needle',
    ]);
    archive.store.initializeSearch();
    const second = artifactPath(root, imported[1].payload.artifactId);
    const original = readFileSync(second);

    const held = () => {
      expect(archive.store.indexSearchPage({ limit: 10 })).toEqual({
        code: 'SPANS_SEARCH_SOURCE_FAILED',
        error: 'Searchable text could not be read; the page was not committed.',
        ok: false,
      });
      expect(archive.store.searchStatus()).toMatchObject({
        coverage: {
          complete: false,
          indexedSequence: 0,
          latestSequence: 2,
          stale: true,
        },
        ok: true,
      });
      expect(searchBodies(root)).toEqual([]);
    };

    // Corrupt: the digest no longer matches. The whole page rolls back, so the
    // healthy first message is not indexed ahead of the broken one.
    writeFileSync(second, 'not an artifact envelope');
    held();
    // Missing.
    unlinkSync(second);
    held();
    // Oversized: refused by size before the helper reads it.
    writeFileSync(
      second,
      'x'.repeat(SPANS_SEARCH_TEXT_LIMITS.artifactBytes + 1),
      {
        mode: 0o600,
      }
    );
    held();

    unlinkSync(second);
    writeFileSync(second, original, { mode: 0o600 });
    chmodSync(second, 0o600);
    expect(archive.store.indexSearchPage({ limit: 10 })).toMatchObject({
      coverage: { complete: true, indexedSequence: 2 },
      indexed: 2,
      ok: true,
    });
    expect(
      archive.store.search({ limit: 10, query: 'needle' }).hits
    ).toHaveLength(2);
  });

  test('an artifact that belongs to a different source record is refused', async () => {
    const root = newRoot();
    const archive = openArchive(root);
    const [event] = await importMessages(archive, ['real needle']);
    const foreign = plantArtifact(root, {
      contentBlocks: [],
      kind: 'message',
      nativeId: 'native-0',
      parserVersion: 'parser-1',
      provider: 'codex',
      role: 'assistant',
      sourceGeneration: 0,
      sourceId: 'another-source',
      text: 'foreign needle',
      toolBlocks: [],
    });
    expect(
      archive.store.appendEvent({
        eventId: 'forged-1',
        payload: { ...event.payload, artifactId: foreign },
        runId: 'run-a',
        type: 'source.message',
      }).ok
    ).toBe(true);
    archive.store.initializeSearch();
    expect(archive.store.indexSearchPage({ limit: 10 })).toMatchObject({
      code: 'SPANS_SEARCH_SOURCE_FAILED',
      ok: false,
    });
    expect(archive.store.searchStatus()).toMatchObject({
      coverage: { indexedSequence: 0, latestSequence: 2 },
    });
  });

  test('unredacted artifact text is redacted again before it is stored or returned', () => {
    const root = newRoot();
    const { store } = openArchive(root);
    const artifactId = plantArtifact(root, {
      contentBlocks: [],
      kind: 'message',
      nativeId: 'native-0',
      parserVersion: 'parser-1',
      provider: 'codex',
      role: 'assistant',
      sourceGeneration: 0,
      sourceId: 'source-a',
      text: `planted needle ${secretText}`,
      toolBlocks: [],
    });
    expect(
      store.appendEvent({
        eventId: 'planted-1',
        payload: {
          artifactId,
          nativeId: 'native-0',
          parserVersion: 'parser-1',
          provider: 'codex',
          sourceGeneration: 0,
          sourceId: 'source-a',
          summary: 'planted summary',
        },
        runId: 'run-a',
        type: 'source.message',
      }).ok
    ).toBe(true);
    store.initializeSearch();
    expect(store.indexSearchPage({ limit: 1 })).toMatchObject({
      indexed: 1,
      ok: true,
    });
    const [body] = searchBodies(root);
    expect(body).toContain('planted needle');
    expect(body).toContain('[REDACTED]');
    expect(body).not.toContain('abcdefghijklmnop');
    expect(
      JSON.stringify(store.search({ limit: 5, query: 'planted' }))
    ).not.toContain('abcdefghijklmnop');
  });
});

describe('generation fence and shared reads', () => {
  test('invalidation fences continuations through the store, service and runtime', async () => {
    const root = newRoot();
    const archive = openArchive(root);
    await importMessages(archive, ['shared one', 'shared two']);
    archive.store.initializeSearch();
    archive.store.indexSearchPage({ limit: 10 });
    const first = archive.store.search({ limit: 1, query: 'shared' });
    expect(first).toMatchObject({ generation: 0, hasMore: true, ok: true });
    const next = {
      afterSequence: first.nextSequence,
      expectedGeneration: first.generation,
      limit: 1,
      query: 'shared',
      throughSequence: first.throughSequence,
    };
    expect(archive.store.search(next)).toMatchObject({ ok: true });
    // A continuation without its generation is refused rather than guessed.
    expect(
      archive.store.search({ afterSequence: 1, limit: 1, query: 'shared' })
    ).toMatchObject({ code: 'SPANS_SEARCH_QUERY_INVALID', ok: false });

    expect(archive.store.invalidateSearch()).toMatchObject({
      generation: 1,
      ok: true,
    });
    expect(archive.store.search(next)).toMatchObject({
      code: 'SPANS_SEARCH_STALE_GENERATION',
      ok: false,
    });
    const service = createSpansService({
      artifacts: archive.artifacts,
      store: archive.store,
    });
    expect(await service.getSearch(next)).toEqual({
      code: 'SPANS_SERVICE_STALE',
      error: 'Spans search results changed; restart from the first page.',
      ok: false,
    });
    expect(await service.getSearchStatus()).toMatchObject({
      coverage: {
        complete: false,
        generation: 1,
        indexedSequence: 0,
        stale: true,
      },
      generation: 1,
      ok: true,
    });

    // Rebuilding is explicit; the runtime never indexes on its own.
    const runtime = createSpansRuntime({ root });
    expect(
      (await runtime.spansSearch({ limit: 5, query: 'shared' })).hits
    ).toEqual([]);
    archive.store.indexSearchPage({ limit: 10 });
    const rebuilt = await runtime.spansSearch({ limit: 5, query: 'shared' });
    expect(rebuilt).toMatchObject({
      coverage: { complete: true, generation: 1 },
      generation: 1,
      ok: true,
    });
    expect(rebuilt.hits).toHaveLength(2);
    expect(runtime.close().ok).toBe(true);
  });

  test('the runtime reports new events as stale until an explicit index pass', async () => {
    const root = newRoot();
    const { store } = openArchive(root);
    note(store, 'note-1', { summary: 'old needle' });
    store.initializeSearch();
    store.indexSearchPage({ limit: 10 });
    const runtime = createSpansRuntime({ root });
    expect(await runtime.spansSearchStatus()).toMatchObject({
      coverage: { complete: true },
      ok: true,
    });
    note(store, 'note-2', { summary: 'new needle' });
    expect(await runtime.spansSearchStatus()).toMatchObject({
      coverage: {
        complete: false,
        indexedSequence: 1,
        latestSequence: 2,
        stale: true,
      },
    });
    expect(
      (await runtime.spansSearch({ limit: 5, query: 'needle' })).hits
    ).toHaveLength(1);
    expect(runtime.close().ok).toBe(true);
  });

  test('service hits are redacted again and invalid input is refused before the store', async () => {
    const root = newRoot();
    const archive = openArchive(root);
    note(archive.store, 'note-1', { summary: 'safe fixture needle' });
    archive.store.initializeSearch();
    archive.store.indexSearchPage({ limit: 10 });
    const raw = new Database(join(root, SPANS_STORE_DATABASE_FILE), {
      readwrite: true,
      strict: true,
    });
    try {
      raw
        .query('UPDATE spans_search SET body = ? WHERE event_id = ?')
        .run('needle Bearer abcdefghijklmnop', 'note-1');
    } finally {
      raw.close(true);
    }
    const service = createSpansService({
      artifacts: archive.artifacts,
      store: archive.store,
    });
    const found = await service.getSearch({ query: 'needle' });
    expect(found.ok).toBe(true);
    expect(JSON.stringify(found)).not.toContain('abcdefghijklmnop');
    const invalidResults = await Promise.all(
      [
        {},
        { query: 'needle', sourcePath: '/Users/example' },
        { limit: 101, query: 'needle' },
        { limit: 'ten', query: 'needle' },
        { query: '*** ---' },
        { afterSequence: 1, query: 'needle' },
        null,
        [],
      ].map((input) => service.getSearch(input))
    );
    for (const result of invalidResults) {
      expect(result).toEqual({
        code: 'SPANS_SERVICE_INVALID',
        error: 'Invalid spans request.',
        ok: false,
      });
    }
  });
});

describe('backup, restore and close', () => {
  test('a backup and restore of an indexed archive keep search readable and resumable', async () => {
    const root = newRoot();
    const parent = dirname(root);
    const archive = openArchive(root);
    await importMessages(archive, [
      'alpha needle',
      `beta needle ${secretText}`,
    ]);
    archive.store.initializeSearch();
    archive.store.indexSearchPage({ limit: 10 });
    const before = archive.store.search({ limit: 10, query: 'needle' });
    expect(before.hits).toHaveLength(2);
    expect(archive.store.close()).toEqual({ ok: true });

    const backup = join(parent, 'backup');
    const restored = join(parent, 'restored');
    expect(createSpansBackup({ destination: backup, root })).toMatchObject({
      ok: true,
    });
    expect(
      restoreSpansBackup({ backupRoot: backup, destination: restored })
    ).toMatchObject({
      ok: true,
    });

    const readonly = openArchive(restored, { readonly: true });
    expect(readonly.store.search({ limit: 10, query: 'needle' })).toEqual(
      before
    );
    expect(readonly.store.indexSearchPage({ limit: 1 })).toMatchObject({
      code: 'SPANS_SEARCH_READONLY',
    });
    expect(readonly.store.close()).toEqual({ ok: true });

    const writable = openArchive(restored);
    note(writable.store, 'after-restore', { summary: 'fresh arrival' });
    expect(writable.store.searchStatus()).toMatchObject({
      coverage: { complete: false, indexedSequence: 2, latestSequence: 3 },
    });
    expect(writable.store.indexSearchPage({ limit: 5 })).toMatchObject({
      indexed: 1,
      ok: true,
    });
    expect(
      writable.store.search({ limit: 5, query: 'fresh' }).hits
    ).toHaveLength(1);
  });

  test('a backup of an archive without a search schema restores without one', () => {
    const root = newRoot();
    const parent = dirname(root);
    const archive = openArchive(root);
    note(archive.store, 'note-1', { summary: 'needle' });
    expect(archive.store.close()).toEqual({ ok: true });
    const backup = join(parent, 'backup');
    const restored = join(parent, 'restored');
    expect(createSpansBackup({ destination: backup, root })).toMatchObject({
      ok: true,
    });
    expect(
      restoreSpansBackup({ backupRoot: backup, destination: restored })
    ).toMatchObject({
      ok: true,
    });
    const readonly = openArchive(restored, { readonly: true });
    expect(readonly.store.search({ limit: 1, query: 'needle' })).toMatchObject({
      code: 'SPANS_SEARCH_UNAVAILABLE',
    });
    expect(searchObjects(restored)).toEqual([]);
  });

  test('closing finalizes owned search statements before the connection releases the file', () => {
    for (const readonly of [false, true]) {
      const root = newRoot();
      const writer = openArchive(root);
      note(writer.store, 'note-1', { summary: 'needle' });
      writer.store.initializeSearch();
      writer.store.indexSearchPage({ limit: 5 });
      let { store } = writer;
      if (readonly) {
        expect(store.close()).toEqual({ ok: true });
        ({ store } = openArchive(root, { readonly: true }));
      }
      // Constructs the lazily prepared search statements on this connection.
      expect(store.search({ limit: 1, query: 'needle' }).ok).toBe(true);
      expect(store.searchStatus().ok).toBe(true);
      expect(store.close()).toEqual({ ok: true });
      expect(store.close()).toEqual({ ok: true });
      for (const result of [
        store.search({ limit: 1, query: 'needle' }),
        store.searchStatus(),
        store.indexSearchPage({ limit: 1 }),
        store.invalidateSearch(),
        store.initializeSearch(),
      ]) {
        expect(result).toMatchObject({ code: 'SPANS_STORE_CLOSED', ok: false });
      }
      // Leaving WAL mode needs the only connection; a statement kept alive past
      // close would leave the file locked and the mode unchanged or busy.
      const db = new Database(join(root, SPANS_STORE_DATABASE_FILE), {
        readwrite: true,
        strict: true,
      });
      try {
        expect(db.query('PRAGMA journal_mode = DELETE').values()[0][0]).toBe(
          'delete'
        );
      } finally {
        db.close(true);
      }
    }
  });
});

describe('service search contract with injected stores', () => {
  const coverage = {
    complete: true,
    generation: 0,
    indexedSequence: 2,
    latestSequence: 2,
    stale: false,
  };
  const page = (overrides = {}) => ({
    coverage,
    generation: 0,
    hasMore: false,
    hits: [
      {
        eventId: 'event-1',
        historical: true,
        runId: 'run-a',
        sequence: 1,
        snippet: 'needle Bearer abcdefghijklmnop',
        sourcePath: '/Users/example/private',
      },
    ],
    nextSequence: 1,
    ok: true,
    throughSequence: 2,
    ...overrides,
  });
  function serviceFor(search, searchStatus = () => ({ ok: true, ...page() })) {
    const calls = [];
    const service = createSpansService({
      artifacts: { read: () => ({ code: 'ARTIFACT_NOT_FOUND', ok: false }) },
      store: {
        listRuns: () => ({ hasMore: false, ok: true, runs: [] }),
        readEvents: () => ({ events: [], hasMore: false, ok: true }),
        readRun: () => ({ code: 'SPANS_MODEL_NOT_FOUND', ok: false }),
        search: (input) => {
          calls.push(input);
          return search(input);
        },
        searchStatus,
      },
    });
    return { calls, service };
  }

  test('search readers are exposed only when the store has them', () => {
    const bare = createSpansService({
      artifacts: { read: () => ({}) },
      store: {
        listRuns: () => ({}),
        readEvents: () => ({}),
        readRun: () => ({}),
      },
    });
    expect('getSearch' in bare).toBe(false);
    expect('getSearchStatus' in bare).toBe(false);
    const { service } = serviceFor(() => page());
    expect(Object.keys(service).sort()).toEqual([
      'getArtifact',
      'getEvents',
      'getRun',
      'getSearch',
      'getSearchStatus',
      'listRuns',
    ]);
    expect(Object.isFrozen(service)).toBe(true);
  });

  test('requests are forwarded with a default limit and results are rebuilt and redacted', async () => {
    const { calls, service } = serviceFor(() => page());
    const result = await service.getSearch({
      query: 'needle',
      runId: undefined,
    });
    expect(calls).toEqual([{ limit: 50, query: 'needle' }]);
    expect(result.ok).toBe(true);
    expect(Object.keys(result).sort()).toEqual([
      'coverage',
      'generation',
      'hasMore',
      'hits',
      'nextSequence',
      'ok',
      'throughSequence',
    ]);
    expect(Object.keys(result.hits[0]).sort()).toEqual([
      'eventId',
      'historical',
      'runId',
      'sequence',
      'snippet',
    ]);
    expect(result.hits[0].snippet).toBe('needle Bearer [REDACTED]');
    expect(JSON.stringify(result)).not.toContain('/Users/example');
  });

  test('invalid requests never reach the store', async () => {
    const { calls, service } = serviceFor(() => page());
    const withGetter = {};
    Object.defineProperty(withGetter, 'query', {
      enumerable: true,
      get() {
        throw new Error('getter must not run');
      },
    });
    const results = await Promise.all(
      [{ extra: 1, query: 'a' }, withGetter, 'needle', undefined].map((input) =>
        service.getSearch(input)
      )
    );
    for (const result of results) {
      expect(result).toMatchObject({
        code: 'SPANS_SERVICE_INVALID',
        ok: false,
      });
    }
    expect(calls).toEqual([]);
    expect(SPANS_SERVICE_LIMITS.searchPageLimit).toBe(100);
    expect(
      await service.getSearch({ limit: 101, query: 'needle' })
    ).toMatchObject({
      code: 'SPANS_SERVICE_INVALID',
      ok: false,
    });
    expect(calls).toEqual([]);
  });

  test('store failures map to fixed codes and never forward adapter text', async () => {
    const cases = [
      ['SPANS_SEARCH_STALE_GENERATION', 'SPANS_SERVICE_STALE'],
      ['SPANS_SEARCH_QUERY_INVALID', 'SPANS_SERVICE_INVALID'],
      ['SPANS_SEARCH_BUSY', 'SPANS_SERVICE_BUSY'],
      ['SPANS_SEARCH_CORRUPT', 'SPANS_SERVICE_CORRUPT'],
      ['SPANS_SEARCH_UNAVAILABLE', 'SPANS_SERVICE_UNAVAILABLE'],
      ['SPANS_STORE_SCHEMA_NEWER', 'SPANS_SERVICE_UNAVAILABLE'],
      ['SPANS_SEARCH_CLOSED', 'SPANS_SERVICE_UNAVAILABLE'],
      ['SOMETHING_ELSE', 'SPANS_SERVICE_UNAVAILABLE'],
    ];
    const results = await Promise.all(
      cases.map(([code]) => {
        const { service } = serviceFor(() => ({
          code,
          error: '/private/path secret=do-not-return',
          ok: false,
        }));
        return service.getSearch({ query: 'needle' });
      })
    );
    for (const [index, result] of results.entries()) {
      const [, mapped] = cases[index];
      expect(result.code).toBe(mapped);
      expect(Object.keys(result).sort()).toEqual(['code', 'error', 'ok']);
      expect(result.error).not.toContain('/private');
    }
    const thrown = serviceFor(() => {
      throw new Error('/private/path secret=do-not-return');
    });
    expect(await thrown.service.getSearch({ query: 'needle' })).toMatchObject({
      code: 'SPANS_SERVICE_UNAVAILABLE',
    });
    expect(
      await serviceFor(() => null).service.getSearch({ query: 'needle' })
    ).toMatchObject({
      code: 'SPANS_SERVICE_CORRUPT',
    });
  });

  test('search pagination cursors stay on the returned snapshot', async () => {
    const { service } = serviceFor(() =>
      page({
        coverage: {
          complete: true,
          generation: 0,
          indexedSequence: 7,
          latestSequence: 7,
          stale: false,
        },
        hits: [],
        nextSequence: 7,
        throughSequence: 7,
      })
    );
    expect(
      await service.getSearch({
        afterSequence: 7,
        expectedGeneration: 0,
        query: 'needle',
        throughSequence: 7,
      })
    ).toMatchObject({
      generation: 0,
      hasMore: false,
      hits: [],
      nextSequence: 7,
      ok: true,
      throughSequence: 7,
    });
  });

  test('a store result that disagrees with the request or itself is corrupt', async () => {
    const hit = (overrides) => ({ ...page().hits[0], ...overrides });
    const bad = [
      {
        request: { limit: 1, query: 'needle', runId: 'run-a' },
        result: page({
          hits: [hit({}), hit({ eventId: 'event-2', sequence: 2 })],
        }),
      },
      {
        request: { limit: 1, query: 'needle', runId: 'run-a' },
        result: page({ hits: [hit({ sequence: 0 })] }),
      },
      {
        request: { limit: 1, query: 'needle', runId: 'run-a' },
        result: page({ hits: [hit({ runId: 'other-run' })] }),
      },
      {
        request: { limit: 1, query: 'needle', runId: 'run-a' },
        result: page({ hits: [hit({ eventId: 'sk-proj-abcdefghijklmnop' })] }),
      },
      {
        request: { limit: 1, query: 'needle', runId: 'run-a' },
        result: page({ hits: [hit({ historical: false })] }),
      },
      {
        request: { limit: 1, query: 'needle', runId: 'run-a' },
        result: page({ hits: 'none' }),
      },
      {
        request: { limit: 1, query: 'needle', runId: 'run-a' },
        result: page({ generation: 1 }),
      },
      {
        request: { limit: 1, query: 'needle', runId: 'run-a' },
        result: page({ coverage: { ...coverage, generation: 1 } }),
      },
      {
        request: { limit: 1, query: 'needle', runId: 'run-a' },
        result: page({ coverage: { ...coverage, indexedSequence: 3 } }),
      },
      {
        request: { limit: 1, query: 'needle', runId: 'run-a' },
        result: page({
          coverage: { ...coverage, complete: false, stale: true },
        }),
      },
      {
        request: { limit: 1, query: 'needle', runId: 'run-a' },
        result: page({ coverage: { ...coverage, stale: true } }),
      },
      {
        request: { limit: 1, query: 'needle', runId: 'run-a' },
        result: page({ throughSequence: 3 }),
      },
      {
        request: { limit: 1, query: 'needle', runId: 'run-a' },
        result: page({ hasMore: 'no' }),
      },
      {
        request: { limit: 1, query: 'needle', runId: 'run-a' },
        result: page({ nextSequence: -1 }),
      },
      {
        request: { limit: 1, query: 'needle', runId: 'run-a' },
        result: page({ nextSequence: 2 }),
      },
      {
        request: { limit: 1, query: 'needle', runId: 'run-a' },
        result: page({ hasMore: true, hits: [], nextSequence: 0 }),
      },
      {
        request: {
          limit: 1,
          query: 'needle',
          runId: 'run-a',
          throughSequence: 1,
        },
        result: page({
          hits: [hit({ sequence: 2 })],
          nextSequence: 2,
          throughSequence: 1,
        }),
      },
      {
        request: {
          expectedGeneration: 1,
          limit: 1,
          query: 'needle',
          runId: 'run-a',
        },
        result: page(),
      },
      {
        request: {
          limit: 1,
          query: 'needle',
          runId: 'run-a',
          throughSequence: 1,
        },
        result: page(),
      },
      {
        request: { limit: 1, query: 'needle', runId: 'run-a' },
        result: page({
          hits: [hit({ snippet: 'x'.repeat(4097) })],
        }),
      },
    ];
    const results = await Promise.all(
      bad.map(({ request, result }) => {
        const { service } = serviceFor(() => result);
        return service.getSearch(request);
      })
    );
    for (const result of results) {
      expect(result).toMatchObject({
        code: 'SPANS_SERVICE_CORRUPT',
        ok: false,
      });
    }
  });

  test('status is validated and accepts only an empty request', async () => {
    const { service } = serviceFor(
      () => page(),
      () => ({
        coverage: { ...coverage, generation: 3 },
        generation: 3,
        ok: true,
        secret: 'dropped',
      })
    );
    expect(await service.getSearchStatus()).toEqual({
      coverage: { ...coverage, generation: 3 },
      generation: 3,
      ok: true,
    });
    expect(await service.getSearchStatus({ unexpected: true })).toMatchObject({
      code: 'SPANS_SERVICE_INVALID',
    });
    const mismatched = serviceFor(
      () => page(),
      () => ({
        coverage,
        generation: 1,
        ok: true,
      })
    );
    expect(await mismatched.service.getSearchStatus()).toMatchObject({
      code: 'SPANS_SERVICE_CORRUPT',
    });
  });
});
