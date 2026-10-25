import { Database } from 'bun:sqlite';
import { afterEach, describe, expect, test } from 'bun:test';
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSpansHistoryImport } from './spans-history-import.js';
import { openSpansStore, SPANS_STORE_DATABASE_FILE } from './spans-store.js';

const roots = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((path) => rm(path, { force: true, recursive: true }))
  );
});

function sourceRecord(index) {
  return {
    payload: {
      content: [
        { text: `Imported conversation message ${index}`, type: 'output_text' },
      ],
      id: `message-${index}`,
      role: index % 2 ? 'assistant' : 'user',
      type: 'message',
    },
    type: 'response_item',
  };
}

async function fixture({ archive = true, count = 1, gate } = {}) {
  const base = await mkdtemp(join(tmpdir(), 'setu-spans-history-import-'));
  roots.push(base);
  const root = join(base, 'archive');
  if (archive) {
    const created = openSpansStore({ root });
    expect(created.close().ok).toBe(true);
  }
  const path = join(base, 'selected.jsonl');
  await writeFile(
    path,
    `${Array.from({ length: count }, (_, i) => JSON.stringify(sourceRecord(i + 1))).join('\n')}\n`
  );
  let admissions = 0;
  const archiveWrite = async (request, effect) => {
    admissions += 1;
    if (gate) {
      return gate(request, effect);
    }
    try {
      return { ok: true, value: await effect() };
    } catch {
      return {
        code: 'SPANS_ARCHIVE_WRITE_UNKNOWN',
        ok: false,
        unknown: true,
      };
    }
  };
  const service = createSpansHistoryImport({ archiveWrite, root });
  return { admissions: () => admissions, base, path, root, service };
}

function events(root, runId) {
  const store = openSpansStore({ create: false, readonly: true, root });
  try {
    const output = [];
    let afterSequence = 0;
    for (;;) {
      const page = store.readEvents({ afterSequence, limit: 200, runId });
      expect(page.ok).toBe(true);
      output.push(...page.events);
      if (!page.hasMore) {
        return output;
      }
      afterSequence = page.nextSequence;
    }
  } finally {
    expect(store.close().ok).toBe(true);
  }
}

describe('createSpansHistoryImport', () => {
  test('creates a read-only imported entry and stores no selected path', async () => {
    const f = await fixture();
    const result = await f.service.importSelected({
      path: f.path,
      provider: 'codex',
    });
    expect(result).toMatchObject({
      hasMore: false,
      ok: true,
      search: { complete: true, ok: true },
      state: 'imported',
    });
    const store = openSpansStore({
      create: false,
      readonly: true,
      root: f.root,
    });
    try {
      const record = store.readRun({ runId: result.runId });
      expect(record.view).toMatchObject({
        actions: {},
        importVersion: 1,
        kind: 'imported',
        provenance: { provider: 'codex', sourceId: result.sourceId },
        readOnly: true,
        spans: {},
        state: 'imported',
      });
      expect(JSON.stringify(record.view)).not.toContain(f.path);
      expect(
        store.search({ limit: 10, query: 'conversation message' }).hits
      ).toHaveLength(1);
    } finally {
      expect(store.close().ok).toBe(true);
    }
    expect(
      events(f.root, result.runId).filter(
        (event) => event.type === 'source.message'
      )
    ).toHaveLength(1);
    await f.service.close();
  });

  test('imports one bounded page and resumes the durable cursor after runtime restart', async () => {
    const f = await fixture({ count: 205 });
    const request = { path: f.path, provider: 'codex' };
    const first = await f.service.importSelected(request);
    expect(first).toMatchObject({
      hasMore: true,
      ok: true,
      state: 'importing',
    });
    expect(first.importedCount).toBeLessThan(205);
    expect(await f.service.close()).toEqual({ ok: true });

    const resumed = createSpansHistoryImport({
      archiveWrite: async (_request, effect) => ({
        ok: true,
        value: await effect(),
      }),
      root: f.root,
    });
    const second = await resumed.importSelected(request);
    expect(second).toMatchObject({
      hasMore: false,
      ok: true,
      runId: first.runId,
      state: 'imported',
    });
    expect(
      events(f.root, first.runId).filter(
        (event) => event.type === 'source.message'
      )
    ).toHaveLength(205);
    const searchable = openSpansStore({
      create: false,
      readonly: true,
      root: f.root,
    });
    try {
      expect(
        searchable.search({
          limit: 10,
          query: 'conversation message 205',
          runId: first.runId,
        })
      ).toMatchObject({
        hits: [{ runId: first.runId }],
        ok: true,
      });
    } finally {
      expect(searchable.close().ok).toBe(true);
    }
    await resumed.close();
  });

  test('attaches to an existing run and refuses an absent destination', async () => {
    const f = await fixture();
    const writer = openSpansStore({ root: f.root });
    expect(
      writer.commitRun({
        events: [],
        expectedGeneration: 0,
        expectedRevision: 0,
        runId: 'existing-run',
        view: { generation: 0, goal: 'Existing run', state: 'completed' },
      }).ok
    ).toBe(true);
    expect(writer.close().ok).toBe(true);

    const absent = await f.service.importSelected({
      existingRunId: 'missing-run',
      path: f.path,
      provider: 'codex',
    });
    expect(absent).toMatchObject({
      code: 'SOURCE_DESTINATION_NOT_FOUND',
      ok: false,
    });
    const attached = await f.service.importSelected({
      existingRunId: 'existing-run',
      path: f.path,
      provider: 'codex',
    });
    expect(attached).toMatchObject({
      hasMore: false,
      ok: true,
      runId: 'existing-run',
    });
    expect(
      events(f.root, 'existing-run').filter(
        (event) => event.type === 'source.message'
      )
    ).toHaveLength(1);
    await f.service.close();
  });

  test('does not reset identity after source replacement or truncation', async () => {
    const f = await fixture({ count: 205 });
    const request = { path: f.path, provider: 'codex' };
    const first = await f.service.importSelected(request);
    expect(first.hasMore).toBe(true);
    await writeFile(f.path, `${JSON.stringify(sourceRecord(1))}\n`);
    const changed = await f.service.importSelected(request);
    expect(changed).toMatchObject({ code: 'SOURCE_TRUNCATED', ok: false });
    expect(changed.sourceId).toBe(first.sourceId);
    await f.service.close();

    const replaced = await fixture({ count: 205 });
    const started = await replaced.service.importSelected({
      path: replaced.path,
      provider: 'codex',
    });
    const replacement = join(replaced.base, 'replacement.jsonl');
    await writeFile(
      replacement,
      `${Array.from({ length: 205 }, (_, i) => JSON.stringify(sourceRecord(i + 1))).join('\n')}\n`
    );
    await rename(replacement, replaced.path);
    expect(
      await replaced.service.importSelected({
        path: replaced.path,
        provider: 'codex',
      })
    ).toMatchObject({
      code: 'SOURCE_REPLACED',
      ok: false,
      sourceId: started.sourceId,
    });
    await replaced.service.close();
  });

  test('initializes an absent archive only under archiveWrite and refuses a corrupt archive', async () => {
    const absent = await fixture({ archive: false });
    expect(
      await absent.service.importSelected({
        path: absent.path,
        provider: 'codex',
      })
    ).toMatchObject({ ok: true });
    expect(absent.admissions()).toBeGreaterThan(0);
    await absent.service.close();

    const corrupt = await fixture({ archive: false });
    await mkdir(corrupt.root, { recursive: true });
    const database = join(corrupt.root, SPANS_STORE_DATABASE_FILE);
    await writeFile(database, 'not a sqlite database');
    const before = await readFile(database);
    expect(
      await corrupt.service.importSelected({
        path: corrupt.path,
        provider: 'codex',
      })
    ).toMatchObject({ ok: false });
    expect(await readFile(database)).toEqual(before);
    expect(corrupt.admissions()).toBe(0);
    await corrupt.service.close();

    const newer = await fixture();
    const db = new Database(join(newer.root, SPANS_STORE_DATABASE_FILE));
    db.query('UPDATE metadata SET value = ? WHERE key = ?').run(
      '999',
      'schema_version'
    );
    db.close();
    const beforeNewer = await readFile(
      join(newer.root, SPANS_STORE_DATABASE_FILE)
    );
    expect(
      await newer.service.importSelected({
        path: newer.path,
        provider: 'codex',
      })
    ).toMatchObject({ ok: false });
    expect(await readFile(join(newer.root, SPANS_STORE_DATABASE_FILE))).toEqual(
      beforeNewer
    );
    expect(newer.admissions()).toBe(0);
    await newer.service.close();
  });

  test('rejects hostile fields without writing and reports concurrent/unknown outcomes conservatively', async () => {
    const f = await fixture();
    expect(
      await f.service.importSelected({
        maxBytes: 100,
        parserVersion: 'caller',
        path: f.path,
        provider: 'codex',
      })
    ).toMatchObject({ code: 'SOURCE_IMPORT_INVALID', ok: false });
    expect(f.admissions()).toBe(0);

    let enterImport;
    let releaseImport;
    const entered = new Promise((resolve) => {
      enterImport = resolve;
    });
    const blocked = new Promise((resolve) => {
      releaseImport = resolve;
    });
    let calls = 0;
    const concurrent = await fixture({
      gate: async (_request, effect) => {
        calls += 1;
        if (calls === 3) {
          enterImport();
          await blocked;
        }
        try {
          return { ok: true, value: await effect() };
        } catch {
          return {
            code: 'SPANS_ARCHIVE_WRITE_UNKNOWN',
            ok: false,
            unknown: true,
          };
        }
      },
    });
    const pending = concurrent.service.importSelected({
      path: concurrent.path,
      provider: 'codex',
    });
    await entered;
    expect(
      await concurrent.service.importSelected({
        path: concurrent.path,
        provider: 'codex',
      })
    ).toMatchObject({ code: 'SPANS_IMPORT_BUSY', ok: false });
    const closing = concurrent.service.close();
    releaseImport();
    expect((await pending).ok).toBe(true);
    expect((await closing).ok).toBe(true);

    // The normal opening/view/import sequence makes the third gated operation the page commit.
    let unknownCalls = 0;
    const unknown = await fixture();
    const uncertain = createSpansHistoryImport({
      archiveWrite: async (_request, effect) => {
        const value = await effect();
        unknownCalls += 1;
        return unknownCalls === 3
          ? { code: 'SPANS_ARCHIVE_WRITE_UNKNOWN', ok: false, unknown: true }
          : { ok: true, value };
      },
      root: unknown.root,
    });
    const first = await uncertain.importSelected({
      path: unknown.path,
      provider: 'codex',
    });
    expect(first).toMatchObject({ ok: false, state: 'unknown', unknown: true });
    expect(
      await uncertain.importSelected({ path: unknown.path, provider: 'codex' })
    ).toMatchObject({ ok: false, unknown: true });
    await uncertain.close();
  });
});

test('an attachment cannot initialize a missing archive or consume the write gate', async () => {
  const f = await fixture({ archive: false });
  try {
    expect(
      await f.service.importSelected({
        existingRunId: 'missing-run',
        path: f.path,
        provider: 'codex',
      })
    ).toMatchObject({ code: 'SPANS_ARCHIVE_NOT_INITIALIZED', ok: false });
    expect(f.admissions()).toBe(0);
    await expect(access(f.root)).rejects.toThrow();
  } finally {
    await f.service.close();
  }
});

test('an orphaned archive directory is not silently initialized', async () => {
  const f = await fixture({ archive: false });
  try {
    await mkdir(f.root, { mode: 0o700 });
    await writeFile(join(f.root, 'retained-evidence'), 'retained');
    expect(
      (await f.service.importSelected({ path: f.path, provider: 'codex' })).ok
    ).toBe(false);
    expect(f.admissions()).toBe(0);
    await expect(
      access(join(f.root, SPANS_STORE_DATABASE_FILE))
    ).rejects.toThrow();
    expect(await readFile(join(f.root, 'retained-evidence'), 'utf8')).toBe(
      'retained'
    );
  } finally {
    await f.service.close();
  }
});

test('incomplete trailing source bytes remain visible as unfinished import progress', async () => {
  const f = await fixture();
  try {
    await writeFile(f.path, `${JSON.stringify(sourceRecord(1))}\n{"type":`);
    const result = await f.service.importSelected({
      path: f.path,
      provider: 'codex',
    });
    expect(result).toMatchObject({
      hasMore: false,
      ok: true,
      state: 'importing',
    });
    expect(result.pendingByteCount).toBeGreaterThan(0);
    const store = openSpansStore({
      create: false,
      readonly: true,
      root: f.root,
    });
    try {
      expect(
        store.readRun({ runId: result.runId }).view.importProgress
      ).toMatchObject({
        hasMore: false,
        pendingByteCount: result.pendingByteCount,
      });
    } finally {
      store.close();
    }
  } finally {
    await f.service.close();
  }
});

test('failure to save progress after committed source events is unknown and blocks replay', async () => {
  let calls = 0;
  const f = await fixture({
    gate: async (_request, effect) => {
      calls += 1;
      if (calls === 4) {
        return { code: 'ADMISSION_CLOSED', ok: false };
      }
      return { ok: true, value: await effect() };
    },
  });
  try {
    const input = { path: f.path, provider: 'codex' };
    const result = await f.service.importSelected(input);
    expect(result).toMatchObject({ ok: false, unknown: true });
    expect(
      events(f.root, result.runId).filter(
        (event) => event.type === 'source.message'
      )
    ).toHaveLength(1);
    expect(await f.service.importSelected(input)).toMatchObject({
      ok: false,
      unknown: true,
    });
    expect(calls).toBe(4);
  } finally {
    await f.service.close();
  }
});

test('an uncertain search page preserves import success and retries from durable index progress', async () => {
  let calls = 0;
  const f = await fixture({
    gate: async (_request, effect) => {
      calls += 1;
      const value = await effect();
      if (calls === 6) {
        return {
          code: 'SPANS_ARCHIVE_WRITE_UNKNOWN',
          ok: false,
          unknown: true,
        };
      }
      return { ok: true, value };
    },
  });
  try {
    const input = { path: f.path, provider: 'codex' };
    const first = await f.service.importSelected(input);
    expect(first).toMatchObject({
      ok: true,
      search: { ok: false, unknown: true },
      state: 'imported',
    });
    expect(
      events(f.root, first.runId).filter(
        (event) => event.type === 'source.message'
      )
    ).toHaveLength(1);

    const retried = await f.service.importSelected(input);
    expect(retried).toMatchObject({
      ok: true,
      search: { complete: true, indexed: 0, ok: true },
    });
    expect(
      events(f.root, first.runId).filter(
        (event) => event.type === 'source.message'
      )
    ).toHaveLength(1);
  } finally {
    await f.service.close();
  }
});
