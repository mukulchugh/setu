import { afterEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createSpansArtifacts } from './spans-artifacts.js';
import { SPANS_BACKUP_RECEIPT_FILE } from './spans-maintenance.js';
import { createSpansMaintenanceRuntime } from './spans-maintenance-runtime.js';
import { importSpansSourceFile } from './spans-source-import.js';
import { openSpansStore } from './spans-store.js';

const roots = [];
const archives = [];
const secret = 'sk-proj-1234567890abcdefghijkl';

afterEach(() => {
  for (const archive of archives.splice(0)) {
    expect(archive.close().ok).toBe(true);
  }
  for (const root of roots.splice(0)) {
    rmSync(root, { force: true, recursive: true });
  }
});

function makeRoot(prefix) {
  const root = realpathSync(mkdtempSync(join(realpathSync(tmpdir()), prefix)));
  chmodSync(root, 0o700);
  roots.push(root);
  return root;
}

function treeDigest(directory) {
  const hash = createHash('sha256');
  const visit = (path) => {
    const entries = readdirSync(path, { withFileTypes: true }).sort((a, b) =>
      a.name.localeCompare(b.name)
    );
    for (const entry of entries) {
      // A SQLite reader may update lock metadata in the shared-memory file.
      if (entry.name === 'spans.sqlite3-shm') {
        continue;
      }
      hash.update(`${entry.name}:${entry.isDirectory()}\n`);
      const child = join(path, entry.name);
      if (entry.isDirectory()) {
        visit(child);
      } else {
        hash.update(readFileSync(child));
      }
    }
  };
  visit(directory);
  return hash.digest('hex');
}

function makeRuntimeFixture(parent, childSource) {
  const directory = join(parent, 'runtime-fixture');
  mkdirSync(directory, { mode: 0o700 });
  writeFileSync(
    join(directory, 'spans-maintenance-runtime.js'),
    readFileSync(
      fileURLToPath(new URL('./spans-maintenance-runtime.js', import.meta.url))
    ),
    { mode: 0o600 }
  );
  writeFileSync(join(directory, 'spans-maintenance-child.js'), childSource, {
    mode: 0o600,
  });
  return import(pathToFileURL(join(directory, 'spans-maintenance-runtime.js')));
}

async function seedArchive(parent) {
  const root = join(parent, 'archive');
  const store = openSpansStore({ root });
  archives.push(store);
  const artifacts = createSpansArtifacts({ root });
  const source = join(parent, 'source.jsonl');
  writeFileSync(
    source,
    `${JSON.stringify({
      payload: {
        content: [{ text: `imported token=${secret}`, type: 'output_text' }],
        id: 'native-1',
        role: 'assistant',
        type: 'message',
      },
      type: 'response_item',
    })}\n`,
    { mode: 0o600 }
  );
  const imported = await importSpansSourceFile({
    artifacts,
    parserVersion: 'runtime-parser-1',
    path: source,
    provider: 'codex',
    runId: 'run-a',
    sourceGeneration: 0,
    sourceId: 'source-a',
    store,
  });
  expect(imported.ok).toBe(true);
  return { artifacts, root, store };
}

describe('createSpansMaintenanceRuntime', () => {
  test('backs up and restores imported redacted records without activating the destination', async () => {
    const parent = makeRoot('setu-spans-maintenance-runtime-');
    const { root, store } = await seedArchive(parent);
    const beforeEvents = store.readEvents({ runId: 'run-a' }).events;
    const runtime = createSpansMaintenanceRuntime({ root });
    const backupRoot = join(parent, 'backup');

    expect(await runtime.backup({ destination: backupRoot })).toMatchObject({
      artifacts: 1,
      events: 2,
      ok: true,
    });
    const backupBeforeRestore = treeDigest(backupRoot);
    const restoredRoot = join(parent, 'restored');
    expect(
      await runtime.restore({ backupRoot, destination: restoredRoot })
    ).toMatchObject({
      artifacts: 1,
      events: 2,
      ok: true,
    });
    expect(treeDigest(backupRoot)).toBe(backupBeforeRestore);
    expect(readdirSync(restoredRoot)).toContain('spans-restore.json');
    expect(readdirSync(root)).not.toContain('spans-restore.json');

    const restoredStore = openSpansStore({
      readonly: true,
      root: restoredRoot,
    });
    try {
      const history = restoredStore.readEvents({ runId: 'run-a' });
      expect(history.ok).toBe(true);
      expect(history.events.map((entry) => entry.type)).toEqual([
        'source.message',
        'source.checkpoint',
      ]);
      const evidence = createSpansArtifacts({ root: restoredRoot }).read({
        artifactId: history.events[0].payload.artifactId,
      });
      expect(evidence).toMatchObject({
        mediaType: 'application/json',
        ok: true,
      });
      expect(JSON.parse(evidence.text).text).toBe('imported token=[REDACTED]');
      expect(evidence.text).not.toContain(secret);
    } finally {
      expect(restoredStore.close().ok).toBe(true);
    }
    expect(store.readEvents({ runId: 'run-a' }).events).toEqual(beforeEvents);
    expect(await runtime.close()).toEqual({ ok: true });
  });

  test('keeps existing and tampered destinations unchanged on refusal', async () => {
    const parent = makeRoot('setu-spans-maintenance-runtime-');
    const { root } = await seedArchive(parent);
    const runtime = createSpansMaintenanceRuntime({ root });
    const backupRoot = join(parent, 'backup');
    expect((await runtime.backup({ destination: backupRoot })).ok).toBe(true);

    const existing = join(parent, 'existing');
    mkdirSync(existing, { mode: 0o700 });
    writeFileSync(join(existing, 'keep.txt'), 'keep', { mode: 0o600 });
    const existingBefore = treeDigest(existing);
    expect(
      await runtime.restore({ backupRoot, destination: existing })
    ).toMatchObject({
      code: 'SPANS_BACKUP_DESTINATION_EXISTS',
      ok: false,
    });
    expect(treeDigest(existing)).toBe(existingBefore);

    appendFileSync(join(backupRoot, 'spans.sqlite3'), 'tampered');
    const tamperedBefore = treeDigest(backupRoot);
    const refusedDestination = join(parent, 'refused');
    expect(
      await runtime.restore({ backupRoot, destination: refusedDestination })
    ).toMatchObject({
      code: 'SPANS_BACKUP_MISMATCH',
      incomplete: true,
      ok: false,
    });
    expect(treeDigest(backupRoot)).toBe(tamperedBefore);
    expect(readdirSync(refusedDestination)).not.toContain(
      SPANS_BACKUP_RECEIPT_FILE
    );
  });

  test('rejects authority overrides, accessors, symbols, prototypes, and aliases before writes', async () => {
    const parent = makeRoot('setu-spans-maintenance-runtime-');
    const { root } = await seedArchive(parent);
    const runtime = createSpansMaintenanceRuntime({ root });
    const before = readdirSync(parent).sort();
    const destination = join(parent, 'not-created');
    let getterCalled = false;
    const accessor = Object.defineProperty({}, 'destination', {
      get() {
        getterCalled = true;
        return destination;
      },
    });
    const symbol = { destination };
    symbol[Symbol('extra')] = true;

    const invalidResults = await Promise.all(
      [
        null,
        { destination, root },
        Object.assign(Object.create({ inherited: true }), { destination }),
        accessor,
        symbol,
        { destination: `${parent}/../not-created` },
      ].map((input) => runtime.backup(input))
    );
    for (const result of invalidResults) {
      expect(result).toMatchObject({
        code: 'SPANS_BACKUP_OPTIONS_INVALID',
        ok: false,
      });
    }
    expect(
      await runtime.restore({ backupRoot: root, destination, root })
    ).toMatchObject({ code: 'SPANS_BACKUP_OPTIONS_INVALID', ok: false });
    if (parent.startsWith('/private/var/')) {
      const alias = parent.replace('/private/var/', '/var/');
      expect(
        await runtime.backup({ destination: join(alias, 'alias-not-created') })
      ).toMatchObject({ code: 'SPANS_BACKUP_PATH_UNSAFE', ok: false });
      const aliased = createSpansMaintenanceRuntime({
        root: root.replace('/private/var/', '/var/'),
      });
      expect(await aliased.backup({ destination })).toMatchObject({
        code: 'SPANS_BACKUP_PATH_UNSAFE',
        ok: false,
      });
    }
    expect(getterCalled).toBe(false);
    expect(readdirSync(parent).sort()).toEqual(before);

    for (const invalidRoot of [
      {},
      { root: `${parent}/../archive` },
      { extra: true, root },
      Object.defineProperty({}, 'root', { get: () => root }),
    ]) {
      expect(() => createSpansMaintenanceRuntime(invalidRoot)).toThrow(
        'Spans maintenance root must be a canonical absolute path.'
      );
    }
  });

  test('returns bounded primitive failures without exposing paths', async () => {
    const parent = makeRoot('setu-spans-maintenance-runtime-');
    const { root } = await seedArchive(parent);
    const runtime = createSpansMaintenanceRuntime({ root });
    const sourceBefore = treeDigest(root);
    const result = await runtime.backup({ destination: join(root, 'backup') });
    expect(result).toMatchObject({
      code: 'SPANS_BACKUP_PATH_UNSAFE',
      ok: false,
    });
    expect(JSON.stringify(result)).not.toContain(parent);
    expect(result.outcomeUnknown).toBeUndefined();
    expect(treeDigest(root)).toBe(sourceBefore);
  });
});

test('constructing maintenance for a missing archive is inert and backup refuses without initializing it', async () => {
  const parent = makeRoot('setu-maintenance-missing-');
  const root = join(parent, 'missing');
  const destination = join(parent, 'backup');
  const runtime = createSpansMaintenanceRuntime({ root });
  expect(existsSync(root)).toBe(false);
  expect(await runtime.backup({ destination })).toMatchObject({
    code: 'SPANS_BACKUP_SOURCE_UNAVAILABLE',
    ok: false,
  });
  expect(existsSync(root)).toBe(false);
  expect(existsSync(destination)).toBe(false);
  expect(await runtime.close()).toEqual({ ok: true });
});

test('child work leaves the event loop responsive, caps concurrency, and close waits without killing it', async () => {
  const parent = makeRoot('setu-maintenance-runtime-child-');
  const childSource = `
    for await (const chunk of process.stdin) { void chunk; }
    await new Promise((resolve) => setTimeout(resolve, 180));
    process.stdout.write(JSON.stringify({ ok: true, artifactBytes: 0, artifacts: 0, cacheEntries: 0, databaseBytes: 0, events: 0, sources: 0, views: 0 }));
  `;
  const { createSpansMaintenanceRuntime: createFixtureRuntime } =
    await makeRuntimeFixture(parent, childSource);
  const runtime = createFixtureRuntime({ root: join(parent, 'missing') });
  let ticks = 0;
  const timer = setInterval(() => {
    ticks += 1;
  }, 5);
  const operation = runtime.backup({ destination: join(parent, 'backup') });
  expect(await runtime.backup({ destination: join(parent, 'second') })).toEqual(
    {
      code: 'SPANS_BACKUP_BUSY',
      error: 'A Spans maintenance operation is already active in this runtime.',
      ok: false,
    }
  );
  const closing = runtime.close();
  expect(
    await runtime.backup({ destination: join(parent, 'after-close') })
  ).toEqual({
    code: 'SPANS_BACKUP_RUNTIME_CLOSED',
    error: 'Spans maintenance runtime is closed.',
    ok: false,
  });
  expect(await operation).toMatchObject({ events: 0, ok: true });
  expect(await closing).toEqual({ ok: true });
  clearInterval(timer);
  expect(ticks).toBeGreaterThan(5);
  expect(await runtime.close()).toEqual({ ok: true });
});

test('malformed and oversized inputs are refused before a worker starts', async () => {
  const parent = makeRoot('setu-maintenance-runtime-input-');
  const marker = join(parent, 'spawned');
  const { createSpansMaintenanceRuntime: createFixtureRuntime } =
    await makeRuntimeFixture(
      parent,
      `
        process.stdout.write(JSON.stringify({ ok: true }));
        await import('node:fs/promises').then(({ writeFile }) => writeFile(${JSON.stringify(marker)}, 'started'));
      `
    );
  const runtime = createFixtureRuntime({ root: join(parent, 'missing') });
  let coerced = false;
  const results = await Promise.all(
    [
      { destination: 'relative' },
      { destination: null },
      {
        destination: {
          toJSON() {
            coerced = true;
            return join(parent, 'coerced');
          },
        },
      },
      { destination: join(parent, 'extra'), extra: true },
      { destination: join(parent, 'x').padEnd(70_000, 'x') },
    ].map((input) => runtime.backup(input))
  );
  for (const result of results) {
    expect(result).toMatchObject({
      code: 'SPANS_BACKUP_OPTIONS_INVALID',
      ok: false,
    });
  }
  expect(existsSync(marker)).toBe(false);
  expect(coerced).toBe(false);
  expect(await runtime.close()).toEqual({ ok: true });
});

test.each([
  ['malformed JSON', "process.stdout.write('{');"],
  ['incomplete success', 'process.stdout.write(JSON.stringify({ok:true}));'],
  [
    'contradictory success',
    'process.stdout.write(JSON.stringify({ok:true, outcomeUnknown:true}));',
  ],
  ['oversized JSON', "process.stdout.write('x'.repeat(1024 * 1024 + 1));"],
])('post-start %s response is an unknown outcome', async (_label, response) => {
  const parent = makeRoot('setu-maintenance-runtime-transport-');
  const childSource = `
    for await (const chunk of process.stdin) { void chunk; }
    ${response}
  `;
  const { createSpansMaintenanceRuntime: createFixtureRuntime } =
    await makeRuntimeFixture(parent, childSource);
  const runtime = createFixtureRuntime({ root: join(parent, 'missing') });
  expect(
    await runtime.backup({ destination: join(parent, 'backup') })
  ).toMatchObject({
    code: 'SPANS_BACKUP_WORKER_OUTCOME_UNKNOWN',
    ok: false,
    outcomeUnknown: true,
  });
  expect(await runtime.close()).toEqual({ ok: true });
});

test('post-start child exit reports unknown and retains a completed destination', async () => {
  const parent = makeRoot('setu-maintenance-runtime-unknown-');
  const { root } = await seedArchive(parent);
  const commandModule = pathToFileURL(
    fileURLToPath(new URL('./spans-maintenance-command.js', import.meta.url))
  ).href;
  const childSource = `
    const { runSpansMaintenanceCommand } = await import(${JSON.stringify(commandModule)});
    let request = '';
    for await (const chunk of process.stdin) request += chunk.toString();
    runSpansMaintenanceCommand(JSON.parse(request));
    process.exit(9);
  `;
  const { createSpansMaintenanceRuntime: createFixtureRuntime } =
    await makeRuntimeFixture(parent, childSource);
  const runtime = createFixtureRuntime({ root });
  const destination = join(parent, 'retained-backup');
  expect(await runtime.backup({ destination })).toEqual({
    code: 'SPANS_BACKUP_WORKER_OUTCOME_UNKNOWN',
    error:
      'The Spans maintenance worker ended without a confirmed result. The destination was kept and may exist; the outcome is unknown.',
    ok: false,
    outcomeUnknown: true,
  });
  expect(existsSync(destination)).toBe(true);
  expect(readdirSync(destination)).toContain('spans-backup.json');
  expect(await runtime.close()).toEqual({ ok: true });
});

test('a failed executable start is unavailable rather than an uncertain write', () => {
  const parent = makeRoot('setu-maintenance-prestart-');
  const moduleUrl = new URL('./spans-maintenance-runtime.js', import.meta.url)
    .href;
  const child = spawnSync(
    process.execPath,
    [
      '--eval',
      `
    const { createSpansMaintenanceRuntime } = await import(${JSON.stringify(moduleUrl)});
    const runtime = createSpansMaintenanceRuntime({ root: ${JSON.stringify(join(parent, 'archive'))} });
    process.execPath = ${JSON.stringify(join(parent, 'missing-bun'))};
    const result = await runtime.backup({ destination: ${JSON.stringify(join(parent, 'backup'))} });
    const closed = await runtime.close();
    console.log(JSON.stringify({ closed, result }));
  `,
    ],
    { encoding: 'utf8', timeout: 5000 }
  );
  expect(child.status).toBe(0);
  expect(child.stderr).toBe('');
  expect(JSON.parse(child.stdout)).toMatchObject({
    closed: { ok: true },
    result: { code: 'SPANS_BACKUP_WORKER_UNAVAILABLE', ok: false },
  });
  expect(existsSync(join(parent, 'backup'))).toBe(false);
});
