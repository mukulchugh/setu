import { Database } from 'bun:sqlite';
import { afterEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSpansImportRuntime } from './spans-import-runtime.js';
import { openSpansStore, SPANS_STORE_DATABASE_FILE } from './spans-store.js';

const roots = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { force: true, recursive: true }))
  );
});

const sourceRecord = (provider, index = 1) =>
  provider === 'codex'
    ? {
        payload: {
          content: [{ text: `Codex imported ${index}`, type: 'output_text' }],
          id: `codex-${index}`,
          role: 'assistant',
          type: 'message',
        },
        type: 'response_item',
      }
    : {
        message: {
          content: [{ text: `Claude imported ${index}`, type: 'text' }],
          role: 'assistant',
        },
        type: 'assistant',
        uuid: `claude-${index}`,
      };

async function fixture(provider, records = [sourceRecord(provider)]) {
  const base = await mkdtemp(join(tmpdir(), 'setu-spans-import-runtime-'));
  roots.push(base);
  const archive = join(base, 'archive');
  const initialized = openSpansStore({ root: archive });
  expect(initialized.close().ok).toBe(true);
  const path = join(base, `${provider}.jsonl`);
  await writeFile(
    path,
    `${records.map((record) => JSON.stringify(record)).join('\n')}\n`
  );
  let gates = 0;
  const runtime = createSpansImportRuntime({
    archiveWrite: async (_request, effect) => {
      gates += 1;
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
    root: archive,
  });
  return { archive, base, gates: () => gates, path, runtime };
}

const importInput = (path, provider, overrides = {}) => ({
  parserVersion: 'runtime-parser-1',
  path,
  provider,
  runId: `run-${provider}`,
  sourceGeneration: 0,
  sourceId: `source-${provider}`,
  ...overrides,
});

function readEvents(root, runId) {
  const store = openSpansStore({ create: false, readonly: true, root });
  try {
    const events = [];
    let afterSequence = 0;
    for (;;) {
      const result = store.readEvents({ afterSequence, limit: 200, runId });
      expect(result.ok).toBe(true);
      events.push(...result.events);
      if (!result.hasMore) {
        return events;
      }
      afterSequence = result.nextSequence;
    }
  } finally {
    expect(store.close().ok).toBe(true);
  }
}

describe('createSpansImportRuntime', () => {
  test('retains an opened SQLite adapter when artifact construction and close fail', async () => {
    const f = await fixture('codex');
    const script = `
      import { Database } from 'bun:sqlite';
      import { mock } from 'bun:test';
      import * as fs from 'node:fs';
      import { join } from 'node:path';

      const root = ${JSON.stringify(f.archive)};
      const sourcePath = ${JSON.stringify(f.path)};
      const realArtifacts = await import('./spans-artifacts.js?real-fixture');
      fs.writeFileSync(join(root, 'artifacts'), 'not a directory');
      let artifactConstructions = 0;
      mock.module(process.cwd() + '/spans-artifacts.js', () => ({
        createSpansArtifacts({ root: artifactRoot }) {
          artifactConstructions += 1;
          if (artifactConstructions < 3) {
            return realArtifacts.createSpansArtifacts({ root: artifactRoot });
          }
          const result = realArtifacts.createSpansArtifacts({ root: artifactRoot })
            .put({ mediaType: 'text/plain', text: 'fixture' });
          if (result.code !== 'ARTIFACT_DIRECTORY_INVALID') {
            throw new Error('expected actual artifact directory failure');
          }
          throw new Error('artifact construction failed');
        },
      }));
      const { createSpansImportRuntime } = await import(
        './spans-import-runtime.js?failure-fixture'
      );
      const originalClose = Database.prototype.close;
      let closeCalls = 0;
      let failClose = true;
      const runtime = createSpansImportRuntime({
        archiveWrite: async (_request, effect) => {
          Database.prototype.close = function interruptedClose(...args) {
            closeCalls += 1;
            if (failClose) {
              failClose = false;
              throw new Error('fixture close interrupted');
            }
            return originalClose.apply(this, args);
          };
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
        root,
      });
      const imported = await runtime.importSelected({
        parserVersion: 'runtime-parser-1',
        path: sourcePath,
        provider: 'codex',
        runId: 'run-codex',
        sourceGeneration: 0,
        sourceId: 'source-codex',
      });
      const firstClose = await runtime.close();
      const secondClose = await runtime.close();
      Database.prototype.close = originalClose;
      console.log(
        JSON.stringify({
          artifactConstructions,
          closeCalls,
          firstClose,
          imported,
          secondClose,
        })
      );
    `;
    const child = spawnSync(process.execPath, ['--eval', script], {
      cwd: import.meta.dir,
      encoding: 'utf8',
    });
    expect(child.status).toBe(0);
    expect(child.stderr).toBe('');
    expect(JSON.parse(child.stdout)).toMatchObject({
      closeCalls: 2,
      firstClose: { ok: false },
      imported: { ok: false, unknown: true },
      secondClose: { ok: true },
    });
  });

  test('a failed close retains its handle and can be retried without reopening imports', async () => {
    const f = await fixture('codex');
    expect(
      (await f.runtime.importSelected(importInput(f.path, 'codex'))).ok
    ).toBe(true);
    const originalClose = Database.prototype.close;
    let failures = 0;
    Database.prototype.close = function interruptedClose(...args) {
      failures += 1;
      if (failures === 1) {
        throw new Error('fixture close interrupted');
      }
      return originalClose.apply(this, args);
    };
    try {
      expect((await f.runtime.close()).ok).toBe(false);
      expect(
        await f.runtime.importSelected(importInput(f.path, 'codex'))
      ).toMatchObject({
        code: 'SPANS_IMPORT_RUNTIME_CLOSED',
        ok: false,
      });
      expect((await f.runtime.close()).ok).toBe(true);
      expect(failures).toBe(2);
    } finally {
      Database.prototype.close = originalClose;
      await f.runtime.close();
    }
  });
  test.each(['codex', 'claude'])(
    'imports selected %s source and resumes safely',
    async (provider) => {
      const f = await fixture(
        provider,
        Array.from({ length: 205 }, (_, index) =>
          sourceRecord(provider, index + 1)
        )
      );
      const input = importInput(f.path, provider);
      const original = await readFile(f.path);
      const first = await f.runtime.importSelected(input);
      expect(first).toMatchObject({
        hasMore: true,
        importedCount: 199,
        ok: true,
      });
      const second = await f.runtime.importSelected(input);
      expect(second).toMatchObject({
        hasMore: false,
        importedCount: 6,
        ok: true,
      });
      const repeated = await f.runtime.importSelected(input);
      expect(repeated).toMatchObject({
        hasMore: false,
        importedCount: 0,
        ok: true,
      });
      expect(
        (await readEvents(f.archive, input.runId)).filter(
          (event) => event.type === 'source.message'
        )
      ).toHaveLength(205);
      expect(await readFile(f.path)).toEqual(original);
      expect(f.gates()).toBe(4); // adapter construction plus one gate per page call
      expect((await f.runtime.close()).ok).toBe(true);
    }
  );

  test('missing archive remains absent and an invalid request has no filesystem effect', async () => {
    const base = await mkdtemp(join(tmpdir(), 'setu-spans-import-missing-'));
    roots.push(base);
    const archive = join(base, 'absent');
    const path = join(base, 'source.jsonl');
    await writeFile(path, `${JSON.stringify(sourceRecord('codex'))}\n`);
    let gateCalls = 0;
    const runtime = createSpansImportRuntime({
      archiveWrite: async (_request, effect) => {
        gateCalls += 1;
        return { ok: true, value: await effect() };
      },
      root: archive,
    });
    const invalid = await runtime.importSelected({
      ...importInput(path, 'codex'),
      store: {},
    });
    expect(invalid.code).toBe('SOURCE_IMPORT_INVALID');
    expect(
      await runtime.importSelected(importInput(path, 'codex'))
    ).toMatchObject({
      code: 'SPANS_ARCHIVE_NOT_INITIALIZED',
      ok: false,
    });
    expect(gateCalls).toBe(0);
    await expect(readFile(archive)).rejects.toMatchObject({ code: 'ENOENT' });
    expect((await runtime.close()).ok).toBe(true);
  });

  test('rejects override keys and accessor input without invoking admission', async () => {
    const f = await fixture('codex');
    let calls = 0;
    const runtime = createSpansImportRuntime({
      archiveWrite: async (_request, effect) => {
        calls += 1;
        return { ok: true, value: await effect() };
      },
      root: f.archive,
    });
    const input = importInput(f.path, 'codex');
    Object.defineProperty(input, 'store', { enumerable: true, value: {} });
    expect(await runtime.importSelected(input)).toMatchObject({ ok: false });
    const accessor = importInput(f.path, 'codex');
    Object.defineProperty(accessor, 'sourceId', {
      enumerable: true,
      get() {
        throw new Error('no');
      },
    });
    expect(await runtime.importSelected(accessor)).toMatchObject({ ok: false });
    expect(calls).toBe(0);
    await runtime.close();
  });

  test('admission refusal occurs before writable adapter construction or import effects', async () => {
    const f = await fixture('codex');
    const databasePath = join(f.archive, SPANS_STORE_DATABASE_FILE);
    const before = await readFile(databasePath);
    let calls = 0;
    const runtime = createSpansImportRuntime({
      archiveWrite: () => {
        calls += 1;
        return { code: 'SPANS_ARCHIVE_CAPACITY_REACHED', ok: false };
      },
      root: f.archive,
    });
    await expect(
      runtime.importSelected(importInput(f.path, 'codex'))
    ).resolves.toMatchObject({
      code: 'SPANS_ARCHIVE_CAPACITY_REACHED',
      ok: false,
    });
    expect(calls).toBe(1);
    expect(await readFile(databasePath)).toEqual(before);
    expect(await readEvents(f.archive, 'run-codex')).toEqual([]);
    await runtime.close();
  });

  test('post-effect unknown result is preserved with no retry offset or automatic retry', async () => {
    const f = await fixture('codex');
    let calls = 0;
    const runtime = createSpansImportRuntime({
      archiveWrite: async (_request, effect) => {
        calls += 1;
        if (calls === 1) {
          return { ok: true, value: await effect() };
        }
        await effect();
        return {
          code: 'SPANS_ARCHIVE_WRITE_UNKNOWN',
          ok: false,
          unknown: true,
        };
      },
      root: f.archive,
    });
    const result = await runtime.importSelected(importInput(f.path, 'codex'));
    expect(result).toMatchObject({
      nextOffset: null,
      ok: false,
      unknown: true,
    });
    expect(calls).toBe(2);
    expect(
      await runtime.importSelected(importInput(f.path, 'codex'))
    ).toMatchObject({ nextOffset: null, ok: false, unknown: true });
    expect(calls).toBe(2);
    expect(
      (await readEvents(f.archive, 'run-codex')).some(
        (event) => event.type === 'source.message'
      )
    ).toBe(true);
    await runtime.close();
  });

  test('close waits for an active import and rejects later invocations', async () => {
    const f = await fixture('codex');
    let releaseGate;
    let signalGate;
    const entered = new Promise((resolve) => {
      signalGate = resolve;
    });
    let gateCalls = 0;
    const runtime = createSpansImportRuntime({
      archiveWrite: async (_request, effect) => {
        gateCalls += 1;
        if (gateCalls === 1) {
          await new Promise((resolve) => {
            releaseGate = resolve;
            signalGate();
          });
        }
        return { ok: true, value: await effect() };
      },
      root: f.archive,
    });
    const pending = runtime.importSelected(importInput(f.path, 'codex'));
    await entered;
    const closing = runtime.close();
    expect(
      await runtime.importSelected(importInput(f.path, 'codex'))
    ).toMatchObject({
      code: 'SPANS_IMPORT_RUNTIME_CLOSED',
      ok: false,
    });
    let settled = false;
    closing.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    releaseGate();
    expect((await pending).ok).toBe(true);
    expect((await closing).ok).toBe(true);
  });
});
