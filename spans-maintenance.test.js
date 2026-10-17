import { Database } from 'bun:sqlite';
import { afterEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import {
  appendFileSync,
  chmodSync,
  closeSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  truncateSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSpansArtifacts } from './spans-artifacts.js';
import {
  createSpansBackup,
  restoreSpansBackup,
  SPANS_BACKUP_LIMITS,
  SPANS_BACKUP_RECEIPT_FILE,
  SPANS_RESTORE_RECEIPT_FILE,
} from './spans-maintenance.js';
import { openSpansStore } from './spans-store.js';

// Every archive here is synthetic and lives in a private temp directory made by
// the test. Roots are realpath'd because the module refuses symlinked chains
// (on macOS the system temp directory is itself behind a symlink).
const SECRET = 'sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789';
const DATABASE_FILE = 'spans.sqlite3';
const OPTIONS_INVALID = 'SPANS_BACKUP_OPTIONS_INVALID';
const PATH_UNSAFE = 'SPANS_BACKUP_PATH_UNSAFE';
const DESTINATION_EXISTS = 'SPANS_BACKUP_DESTINATION_EXISTS';
const SOURCE_UNAVAILABLE = 'SPANS_BACKUP_SOURCE_UNAVAILABLE';
const INCOMPLETE = 'SPANS_BACKUP_INCOMPLETE';
const MISMATCH = 'SPANS_BACKUP_MISMATCH';
const MANIFEST_INVALID = 'SPANS_BACKUP_MANIFEST_INVALID';
const ARTIFACT_INVALID = 'SPANS_BACKUP_ARTIFACT_INVALID';
const ARTIFACT_MISSING = 'SPANS_BACKUP_ARTIFACT_MISSING';
const SCHEMA_NEWER = 'SPANS_BACKUP_SCHEMA_NEWER';
const SCHEMA_UNSUPPORTED = 'SPANS_BACKUP_SCHEMA_UNSUPPORTED';
const CORRUPT = 'SPANS_BACKUP_CORRUPT';
const HEX_NAME = /^[0-9a-f]{64}$/;

const parents = [];
const stores = [];

function makeParent() {
  const parent = realpathSync(
    mkdtempSync(join(tmpdir(), 'setu-spans-maintenance-'))
  );
  chmodSync(parent, 0o700);
  parents.push(parent);
  return parent;
}

function openStore(root) {
  const store = openSpansStore({ busyTimeoutMs: 50, root });
  stores.push(store);
  return store;
}

afterEach(() => {
  for (const store of stores.splice(0)) {
    expect(store.close().ok).toBe(true);
  }
  for (const parent of parents.splice(0)) {
    rmSync(parent, { force: true, recursive: true });
  }
});

const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const modeOf = (path) => lstatSync(path).mode % 0o1000;
const blobPath = (root, artifactId) =>
  join(root, 'artifacts', artifactId.slice('sha256:'.length));
const receiptPath = (dir) => join(dir, SPANS_BACKUP_RECEIPT_FILE);

function put(root, mediaType, text) {
  const result = createSpansArtifacts({ root }).put({ mediaType, text });
  expect(result.ok).toBe(true);
  return result.artifactId;
}

function event(eventId, runId, payload) {
  return { eventId, payload, runId, type: 'span.recorded' };
}

// One archive touching every table the backup must carry: events (one per
// reference form), a run view, an import cursor and a cache entry. Four
// artifacts are referenced (event, event list, view, cache); one is not.
function seedArchive(parent) {
  const root = join(parent, 'source');
  const store = openStore(root);
  const note = put(root, 'text/plain', `synthetic note token=${SECRET}`);
  const plan = put(root, 'application/json', JSON.stringify({ step: 1 }));
  const view = put(root, 'text/plain', 'synthetic view evidence');
  const cache = put(root, 'text/plain', 'synthetic cache evidence');
  const unreferenced = put(root, 'text/plain', 'saved but never referenced');
  expect(
    store.appendEvent(event('event-1', 'run-a', { artifactId: note })).ok
  ).toBe(true);
  expect(
    store.commitRun({
      events: [event('event-2', 'run-b', { artifactIds: [plan] })],
      expectedGeneration: 0,
      expectedRevision: 0,
      runId: 'run-b',
      view: {
        artifactIds: [view],
        generation: 0,
        goal: 'synthetic goal',
        state: 'running',
      },
    }).ok
  ).toBe(true);
  expect(
    store.commitImport({
      events: [event('event-3', 'run-c', { n: 1 })],
      expectedOffset: 0,
      nextOffset: 42,
      parserVersion: 'parser-1',
      sourceGeneration: 1,
      sourceId: 'source-1',
    }).ok
  ).toBe(true);
  expect(store.writeCache('cache-key', { artifactId: cache }).ok).toBe(true);
  return { artifacts: { cache, note, plan, unreferenced, view }, root, store };
}

function makeBackup(parent) {
  const seeded = seedArchive(parent);
  const backupDir = join(parent, 'backup');
  const result = createSpansBackup({
    destination: backupDir,
    root: seeded.root,
  });
  expect(result.ok).toBe(true);
  return { ...seeded, backupDir };
}

function treeDigest(directory) {
  const hash = createHash('sha256');
  const visit = (path) => {
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      hash.update(`${path}:${entry.name}:${entry.isDirectory()}\n`);
      if (entry.isDirectory()) {
        visit(join(path, entry.name));
      } else {
        hash.update(readFileSync(join(path, entry.name)));
      }
    }
  };
  visit(directory);
  return hash.digest('hex');
}

function allFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory()
      ? allFiles(join(directory, entry.name))
      : [join(directory, entry.name)]
  );
}

function rewriteReceipt(backupDir, change) {
  const receipt = JSON.parse(readFileSync(receiptPath(backupDir), 'utf8'));
  change(receipt);
  writeFileSync(receiptPath(backupDir), `${JSON.stringify(receipt)}\n`);
}

// Makes a hand-edited backup database match its receipt again, so the failure
// under test is the edit itself and not the byte-hash check.
function resealDatabase(backupDir) {
  const bytes = readFileSync(join(backupDir, DATABASE_FILE));
  rewriteReceipt(backupDir, (receipt) => {
    receipt.database = { bytes: bytes.length, sha256: sha(bytes) };
  });
}

function editBackupDatabase(backupDir, statement) {
  const raw = new Database(join(backupDir, DATABASE_FILE), { readwrite: true });
  try {
    raw.run(statement);
  } finally {
    raw.close(true);
  }
  resealDatabase(backupDir);
}

function editDatabase(path, statements) {
  const raw = new Database(path, { readwrite: true });
  try {
    for (const statement of statements) {
      raw.run(statement);
    }
  } finally {
    raw.close(true);
  }
}

// Each entry damages exactly one kind of supported row. The event case has to
// lift the append-only trigger to do it, and puts the same trigger back.
const DAMAGE = {
  cache: ["UPDATE spans_cache SET entry_json = '[1]'"],
  cursor: ['UPDATE spans_sources SET byte_offset = -1'],
  digest: [
    'DROP TRIGGER events_reject_update',
    "UPDATE events SET input_digest = 'bad' WHERE event_id = 'event-1'",
    `CREATE TRIGGER events_reject_update BEFORE UPDATE ON events
      BEGIN SELECT RAISE(ABORT, 'spans events are append-only'); END`,
  ],
  // Keeps artifactIds, so the reference list still matches a backup's receipt.
  view: [
    "UPDATE spans_views SET view_json = json_set(view_json, '$.generation', 9)",
  ],
};

function expectRefused(result, code, parent) {
  expect(result.ok).toBe(false);
  expect(result.code).toBe(code);
  expect(typeof result.error).toBe('string');
  // Results carry fixed text only: no temp path, no content.
  expect(JSON.stringify(result)).not.toContain(parent);
  expect(JSON.stringify(result)).not.toContain(SECRET);
}

function expectIncomplete(result, code, parent, destination) {
  expectRefused(result, code, parent);
  expect(result.incomplete).toBe(true);
  expect(result.error).toContain('incomplete');
  // Kept, never cleaned, and never carrying a completion marker.
  expect(existsSync(destination)).toBe(true);
  const markers = readdirSync(destination).filter(
    (name) =>
      name.startsWith(SPANS_BACKUP_RECEIPT_FILE) ||
      name.startsWith(SPANS_RESTORE_RECEIPT_FILE)
  );
  expect(markers).toEqual([]);
}

function expectPartial(outcome, code, parent) {
  expectIncomplete(outcome.result, code, parent, outcome.destination);
}

describe('exports', () => {
  test('exports plain functions and receipt constants', () => {
    expect(typeof createSpansBackup).toBe('function');
    expect(typeof restoreSpansBackup).toBe('function');
    expect(SPANS_BACKUP_LIMITS.artifacts).toBeGreaterThan(0);
  });
});

describe('backup and restore round trip', () => {
  test('carries a live WAL archive, every table and every referenced artifact', () => {
    const parent = makeParent();
    const seeded = seedArchive(parent);
    // The rows below are committed but still live in the WAL: the store is open.
    expect(existsSync(join(seeded.root, `${DATABASE_FILE}-wal`))).toBe(true);
    const backupDir = join(parent, 'backup');

    const backup = createSpansBackup({
      destination: backupDir,
      root: seeded.root,
    });
    expect(backup).toMatchObject({
      artifacts: 4,
      cacheEntries: 1,
      events: 3,
      ok: true,
      sources: 1,
      views: 1,
    });

    expect(readdirSync(backupDir).sort()).toEqual([
      'artifacts',
      SPANS_BACKUP_RECEIPT_FILE,
      DATABASE_FILE,
    ]);
    expect(modeOf(backupDir)).toBe(0o700);
    expect(modeOf(join(backupDir, 'artifacts'))).toBe(0o700);
    expect(modeOf(join(backupDir, DATABASE_FILE))).toBe(0o600);
    expect(modeOf(receiptPath(backupDir))).toBe(0o600);

    const receiptText = readFileSync(receiptPath(backupDir), 'utf8');
    const receipt = JSON.parse(receiptText);
    expect(receipt.version).toBe(1);
    expect(receipt.database.sha256).toBe(
      sha(readFileSync(join(backupDir, DATABASE_FILE)))
    );
    expect(receipt.artifacts.map((entry) => entry.id)).toEqual(
      [
        seeded.artifacts.cache,
        seeded.artifacts.note,
        seeded.artifacts.plan,
        seeded.artifacts.view,
      ].sort()
    );
    expect(receipt.counts).toMatchObject({ artifacts: 4, events: 3 });
    expect(receiptText).not.toContain(parent);
    for (const file of allFiles(backupDir)) {
      expect(readFileSync(file).includes(SECRET)).toBe(false);
    }

    // Later writes to the source are not part of the earlier backup.
    expect(
      seeded.store.appendEvent(event('event-late', 'run-a', { n: 9 })).ok
    ).toBe(true);
    const before = treeDigest(backupDir);
    const restored = join(parent, 'restored');
    const outcome = restoreSpansBackup({
      backupRoot: backupDir,
      destination: restored,
    });
    expect(outcome).toMatchObject({ artifacts: 4, events: 3, ok: true });
    expect(treeDigest(backupDir)).toBe(before);
    expect(existsSync(join(restored, SPANS_RESTORE_RECEIPT_FILE))).toBe(true);
    expect(modeOf(restored)).toBe(0o700);

    // The restored copy is a normal archive and survives repeated reopening.
    for (let pass = 0; pass < 2; pass += 1) {
      const reopened = openSpansStore({ busyTimeoutMs: 50, root: restored });
      try {
        const runA = reopened.readEvents({ runId: 'run-a' });
        expect(runA.events.map((entry) => entry.eventId)).toEqual(['event-1']);
        expect(reopened.readRun({ runId: 'run-b' })).toMatchObject({
          generation: 0,
          ok: true,
          revision: 1,
          view: { goal: 'synthetic goal' },
        });
        expect(
          reopened.readSourceCursor({
            parserVersion: 'parser-1',
            sourceGeneration: 1,
            sourceId: 'source-1',
          })
        ).toMatchObject({ found: true, offset: 42, ok: true });
        expect(reopened.readCache('cache-key')).toMatchObject({
          entry: { artifactId: seeded.artifacts.cache },
          ok: true,
        });
        expect(
          reopened.getArtifactReference({
            artifactId: seeded.artifacts.note,
            runId: 'run-a',
          })
        ).toMatchObject({ eventId: 'event-1', found: true });
      } finally {
        expect(reopened.close().ok).toBe(true);
      }
    }
    const restoredArtifacts = createSpansArtifacts({ root: restored });
    const note = restoredArtifacts.read({ artifactId: seeded.artifacts.note });
    expect(note.ok).toBe(true);
    expect(note.text).toContain('[REDACTED]');
    expect(note.text).not.toContain(SECRET);
    expect(
      restoredArtifacts.read({ artifactId: seeded.artifacts.unreferenced }).ok
    ).toBe(false);

    // The source archive is still open and writable after being read.
    const sourceRun = seeded.store.readEvents({ runId: 'run-a' });
    expect(sourceRun.events.map((entry) => entry.eventId)).toEqual([
      'event-1',
      'event-late',
    ]);
  });

  test('pages through more events than one page and keeps references from every page', () => {
    const parent = makeParent();
    const root = join(parent, 'source');
    const store = openStore(root);
    const first = put(root, 'text/plain', 'first page evidence');
    const last = put(root, 'text/plain', 'last page evidence');
    const total = 450;
    for (let start = 0; start < total; start += 200) {
      const events = [];
      const end = Math.min(start + 200, total);
      for (let index = start; index < end; index += 1) {
        let payload = { n: index };
        if (index === 0) {
          payload = { artifactId: first };
        } else if (index === total - 1) {
          payload = { artifactId: last };
        }
        events.push(event(`big-${index}`, 'run-big', payload));
      }
      expect(
        store.commitRun({
          events,
          expectedGeneration: 0,
          expectedRevision: start / 200,
          runId: 'run-big',
          view: { generation: 0 },
        }).ok
      ).toBe(true);
    }
    const backupDir = join(parent, 'backup');
    expect(createSpansBackup({ destination: backupDir, root })).toMatchObject({
      artifacts: 2,
      events: total,
      ok: true,
    });
    const restored = join(parent, 'restored');
    expect(
      restoreSpansBackup({ backupRoot: backupDir, destination: restored })
    ).toMatchObject({ artifacts: 2, events: total, ok: true });
    const reopened = openSpansStore({ busyTimeoutMs: 50, root: restored });
    try {
      const page = reopened.readEvents({ limit: 200, runId: 'run-big' });
      expect(page.events).toHaveLength(200);
      expect(page.hasMore).toBe(true);
    } finally {
      reopened.close();
    }
  });

  test('backs up and restores an empty archive', () => {
    const parent = makeParent();
    const root = join(parent, 'source');
    openStore(root);
    const backupDir = join(parent, 'backup');
    expect(createSpansBackup({ destination: backupDir, root })).toMatchObject({
      artifacts: 0,
      events: 0,
      ok: true,
    });
    const restored = join(parent, 'restored');
    expect(
      restoreSpansBackup({ backupRoot: backupDir, destination: restored })
    ).toMatchObject({ artifacts: 0, events: 0, ok: true });
    expect(readdirSync(join(restored, 'artifacts'))).toEqual([]);
  });

  test('copies only referenced artifacts, never unknown files, symlinks or transcripts', () => {
    const parent = makeParent();
    const seeded = seedArchive(parent);
    writeFileSync(join(seeded.root, 'transcript.jsonl'), 'raw transcript', {
      mode: 0o600,
    });
    symlinkSync(join(parent, 'nowhere'), join(seeded.root, 'link'));
    writeFileSync(join(seeded.root, 'artifacts', 'stray.txt'), 'stray', {
      mode: 0o600,
    });
    const backupDir = join(parent, 'backup');
    expect(
      createSpansBackup({ destination: backupDir, root: seeded.root }).ok
    ).toBe(true);
    expect(readdirSync(backupDir).sort()).toEqual([
      'artifacts',
      SPANS_BACKUP_RECEIPT_FILE,
      DATABASE_FILE,
    ]);
    const names = readdirSync(join(backupDir, 'artifacts'));
    expect(names).toHaveLength(4);
    expect(names.every((name) => HEX_NAME.test(name))).toBe(true);
    expect(
      names.includes(seeded.artifacts.unreferenced.slice('sha256:'.length))
    ).toBe(false);
  });
});

describe('root and destination refusals', () => {
  test('refuses an existing destination and leaves it untouched', () => {
    const parent = makeParent();
    const seeded = seedArchive(parent);
    const existing = join(parent, 'existing');
    mkdirSync(existing, { mode: 0o700 });
    writeFileSync(join(existing, 'sentinel'), 'keep me', { mode: 0o600 });
    const before = treeDigest(existing);

    const result = createSpansBackup({
      destination: existing,
      root: seeded.root,
    });
    expectRefused(result, DESTINATION_EXISTS, parent);
    expect(result.incomplete).toBeUndefined();
    expect(treeDigest(existing)).toBe(before);

    const file = join(parent, 'file');
    writeFileSync(file, 'a file', { mode: 0o600 });
    expectRefused(
      createSpansBackup({ destination: file, root: seeded.root }),
      DESTINATION_EXISTS,
      parent
    );
    expect(readFileSync(file, 'utf8')).toBe('a file');

    const dangling = join(parent, 'dangling');
    symlinkSync(join(parent, 'missing-target'), dangling);
    expectRefused(
      createSpansBackup({ destination: dangling, root: seeded.root }),
      DESTINATION_EXISTS,
      parent
    );
    expect(existsSync(join(parent, 'missing-target'))).toBe(false);
  });

  test('restore never replaces an existing archive or newer evidence', () => {
    const parent = makeParent();
    const seeded = makeBackup(parent);
    const newer = join(parent, 'newer');
    const store = openStore(newer);
    expect(store.appendEvent(event('newer-1', 'run-n', { n: 1 })).ok).toBe(
      true
    );
    store.close();
    const before = treeDigest(newer);
    expectRefused(
      restoreSpansBackup({ backupRoot: seeded.backupDir, destination: newer }),
      DESTINATION_EXISTS,
      parent
    );
    expect(treeDigest(newer)).toBe(before);
  });

  test('refuses source equal to, inside, or around the destination', () => {
    const parent = makeParent();
    const seeded = seedArchive(parent);
    expectRefused(
      createSpansBackup({ destination: seeded.root, root: seeded.root }),
      PATH_UNSAFE,
      parent
    );
    const inside = join(seeded.root, 'child');
    expectRefused(
      createSpansBackup({ destination: inside, root: seeded.root }),
      PATH_UNSAFE,
      parent
    );
    expect(existsSync(inside)).toBe(false);
    expectRefused(
      createSpansBackup({ destination: parent, root: seeded.root }),
      PATH_UNSAFE,
      parent
    );
  });

  test('rejects relative, malformed and missing options with no live fallback', () => {
    const parent = makeParent();
    const seeded = seedArchive(parent);
    const destination = join(parent, 'backup');
    const bad = [
      undefined,
      null,
      'text',
      {},
      { destination },
      { root: seeded.root },
      { destination, root: 'relative/source' },
      { destination: 'relative/backup', root: seeded.root },
      { destination, root: `${seeded.root}/` },
      { destination: `${parent}/x/../y`, root: seeded.root },
      { destination, extra: true, root: seeded.root },
      { destination, root: `${seeded.root}\0` },
    ];
    for (const options of bad) {
      expectRefused(createSpansBackup(options), OPTIONS_INVALID, parent);
    }
    expectRefused(
      restoreSpansBackup({ destination: join(parent, 'restored') }),
      OPTIONS_INVALID,
      parent
    );
    expectRefused(restoreSpansBackup(), OPTIONS_INVALID, parent);
    expect(existsSync(destination)).toBe(false);
    expect(existsSync(join(parent, 'restored'))).toBe(false);
  });

  test('refuses symlinked and non-private roots', () => {
    const parent = makeParent();
    const seeded = seedArchive(parent);

    const linkedRoot = join(parent, 'linked-source');
    symlinkSync(seeded.root, linkedRoot);
    const linkedOut = join(parent, 'linked-out');
    expectRefused(
      createSpansBackup({ destination: linkedOut, root: linkedRoot }),
      PATH_UNSAFE,
      parent
    );
    expect(existsSync(linkedOut)).toBe(false);

    const alias = join(parent, 'alias');
    symlinkSync(parent, alias);
    expectRefused(
      createSpansBackup({
        destination: join(alias, 'via-alias'),
        root: seeded.root,
      }),
      PATH_UNSAFE,
      parent
    );
    expect(existsSync(join(parent, 'via-alias'))).toBe(false);

    chmodSync(seeded.root, 0o755);
    expectRefused(
      createSpansBackup({
        destination: join(parent, 'open-source'),
        root: seeded.root,
      }),
      PATH_UNSAFE,
      parent
    );
    chmodSync(seeded.root, 0o700);

    const database = join(seeded.root, DATABASE_FILE);
    chmodSync(database, 0o644);
    expectRefused(
      createSpansBackup({
        destination: join(parent, 'open-database'),
        root: seeded.root,
      }),
      PATH_UNSAFE,
      parent
    );
    chmodSync(database, 0o600);

    const openParent = join(parent, 'open-parent');
    mkdirSync(openParent, { mode: 0o755 });
    chmodSync(openParent, 0o755);
    expectRefused(
      createSpansBackup({
        destination: join(openParent, 'backup'),
        root: seeded.root,
      }),
      PATH_UNSAFE,
      parent
    );
    expectRefused(
      createSpansBackup({
        destination: join(parent, 'missing-parent', 'backup'),
        root: seeded.root,
      }),
      PATH_UNSAFE,
      parent
    );
    expect(existsSync(join(openParent, 'backup'))).toBe(false);
    for (const name of ['open-source', 'open-database', 'missing-parent']) {
      expect(existsSync(join(parent, name))).toBe(false);
    }
  });

  test('a missing source or database is refused without creating anything', () => {
    const parent = makeParent();
    const empty = join(parent, 'empty-source');
    mkdirSync(empty, { mode: 0o700 });
    chmodSync(empty, 0o700);
    expectRefused(
      createSpansBackup({ destination: join(parent, 'one'), root: empty }),
      SOURCE_UNAVAILABLE,
      parent
    );
    expect(readdirSync(empty)).toEqual([]);
    expectRefused(
      createSpansBackup({
        destination: join(parent, 'two'),
        root: join(parent, 'absent'),
      }),
      SOURCE_UNAVAILABLE,
      parent
    );
    expect(existsSync(join(parent, 'one'))).toBe(false);
    expect(existsSync(join(parent, 'two'))).toBe(false);
  });

  test('restore treats a live archive root and a symlinked or open backup as invalid', () => {
    const parent = makeParent();
    const seeded = makeBackup(parent);
    expectRefused(
      restoreSpansBackup({
        backupRoot: seeded.root,
        destination: join(parent, 'from-live'),
      }),
      INCOMPLETE,
      parent
    );
    expect(existsSync(join(parent, 'from-live'))).toBe(false);

    const link = join(parent, 'backup-link');
    symlinkSync(seeded.backupDir, link);
    expectRefused(
      restoreSpansBackup({
        backupRoot: link,
        destination: join(parent, 'from-link'),
      }),
      PATH_UNSAFE,
      parent
    );

    chmodSync(seeded.backupDir, 0o755);
    expectRefused(
      restoreSpansBackup({
        backupRoot: seeded.backupDir,
        destination: join(parent, 'from-open'),
      }),
      PATH_UNSAFE,
      parent
    );
    chmodSync(seeded.backupDir, 0o700);
    expectRefused(
      restoreSpansBackup({
        backupRoot: seeded.backupDir,
        destination: seeded.backupDir,
      }),
      PATH_UNSAFE,
      parent
    );
    expect(existsSync(join(parent, 'from-link'))).toBe(false);
    expect(existsSync(join(parent, 'from-open'))).toBe(false);
  });
});

describe('schema and database refusals on backup', () => {
  test('refuses a newer or unknown schema before creating a destination', () => {
    const parent = makeParent();
    const seeded = seedArchive(parent);
    const edit = (statement) => {
      const raw = new Database(join(seeded.root, DATABASE_FILE), {
        readwrite: true,
      });
      try {
        raw.run(statement);
      } finally {
        raw.close(true);
      }
    };
    const attempt = (name) =>
      createSpansBackup({
        destination: join(parent, name),
        root: seeded.root,
      });

    edit("UPDATE metadata SET value = '2' WHERE key = 'schema_version'");
    expectRefused(attempt('newer-store'), SCHEMA_NEWER, parent);
    edit("UPDATE metadata SET value = '1' WHERE key = 'schema_version'");

    edit("UPDATE metadata SET value = '2' WHERE key = 'model_schema_version'");
    expectRefused(attempt('newer-model'), SCHEMA_NEWER, parent);
    edit("UPDATE metadata SET value = '1' WHERE key = 'model_schema_version'");

    edit("UPDATE metadata SET value = 'garbage' WHERE key = 'schema_version'");
    expectRefused(attempt('unknown'), SCHEMA_UNSUPPORTED, parent);
    edit("UPDATE metadata SET value = '1' WHERE key = 'schema_version'");

    for (const name of ['newer-store', 'newer-model', 'unknown']) {
      expect(existsSync(join(parent, name))).toBe(false);
    }
    // Once the metadata is whole again the same archive backs up normally.
    expect(attempt('fixed').ok).toBe(true);
  });

  test('refuses a database that is not SQLite or has no Spans schema', () => {
    const parent = makeParent();
    const garbage = join(parent, 'garbage');
    mkdirSync(garbage, { mode: 0o700 });
    chmodSync(garbage, 0o700);
    writeFileSync(
      join(garbage, DATABASE_FILE),
      'this is definitely not sqlite data',
      { mode: 0o600 }
    );
    expectRefused(
      createSpansBackup({ destination: join(parent, 'one'), root: garbage }),
      CORRUPT,
      parent
    );

    const blank = join(parent, 'blank');
    mkdirSync(blank, { mode: 0o700 });
    chmodSync(blank, 0o700);
    writeFileSync(join(blank, DATABASE_FILE), '', { mode: 0o600 });
    expectRefused(
      createSpansBackup({ destination: join(parent, 'two'), root: blank }),
      SCHEMA_UNSUPPORTED,
      parent
    );
    expect(existsSync(join(parent, 'one'))).toBe(false);
    expect(existsSync(join(parent, 'two'))).toBe(false);
  });
});

describe('backup snapshot file', () => {
  test('is created by SQLite for a quoted path, private, flushed to a single rollback-journal file', () => {
    const parent = makeParent();
    const seeded = seedArchive(parent);
    // A quote in the name proves the destination is bound, not spliced into SQL.
    const backupDir = join(parent, "it's a backup");
    expect(existsSync(backupDir)).toBe(false);
    expect(
      createSpansBackup({ destination: backupDir, root: seeded.root }).ok
    ).toBe(true);

    const database = join(backupDir, DATABASE_FILE);
    expect(modeOf(database)).toBe(0o600);
    expect(lstatSync(database).nlink).toBe(1);
    const bytes = readFileSync(database);
    // File-format write/read versions: 1 is rollback journal, 2 would be WAL.
    expect([bytes[18], bytes[19]]).toEqual([1, 1]);
    expect(readdirSync(backupDir).sort()).toEqual([
      'artifacts',
      SPANS_BACKUP_RECEIPT_FILE,
      DATABASE_FILE,
    ]);
    // The recorded hash is of the final file, taken after verification closed.
    const receipt = JSON.parse(readFileSync(receiptPath(backupDir), 'utf8'));
    expect(receipt.database).toEqual({
      bytes: bytes.length,
      sha256: sha(bytes),
    });
    // The snapshot stays a usable archive.
    const reopened = openSpansStore({ busyTimeoutMs: 50, root: backupDir });
    try {
      expect(reopened.readEvents({ runId: 'run-a' }).events).toHaveLength(1);
    } finally {
      reopened.close();
    }
  });
});

describe('backup verifies the snapshot before completing', () => {
  for (const [name, statements] of Object.entries(DAMAGE)) {
    test(`a damaged ${name} row is never given a completion receipt`, () => {
      const parent = makeParent();
      const seeded = seedArchive(parent);
      editDatabase(join(seeded.root, DATABASE_FILE), statements);
      const destination = join(parent, 'backup');
      const result = createSpansBackup({ destination, root: seeded.root });
      expectIncomplete(result, CORRUPT, parent, destination);
      expect(existsSync(receiptPath(destination))).toBe(false);
      // Nothing is cleaned up, and the partial backup cannot be restored.
      expectRefused(
        restoreSpansBackup({
          backupRoot: destination,
          destination: join(parent, 'restored'),
        }),
        INCOMPLETE,
        parent
      );
      expect(existsSync(join(parent, 'restored'))).toBe(false);
    });
  }
});

describe('artifact failures during backup', () => {
  test('a missing referenced artifact invalidates the backup and keeps the partial destination', () => {
    const parent = makeParent();
    const seeded = seedArchive(parent);
    unlinkSync(blobPath(seeded.root, seeded.artifacts.plan));
    const destination = join(parent, 'backup');
    const result = createSpansBackup({ destination, root: seeded.root });
    expectIncomplete(result, ARTIFACT_MISSING, parent, destination);
    expect(readdirSync(destination)).toContain(DATABASE_FILE);
    // Nothing is cleaned up, and the same destination is not reused.
    expectRefused(
      createSpansBackup({ destination, root: seeded.root }),
      DESTINATION_EXISTS,
      parent
    );
    // A partial backup is not restorable.
    expectRefused(
      restoreSpansBackup({
        backupRoot: destination,
        destination: join(parent, 'restored'),
      }),
      INCOMPLETE,
      parent
    );
    expect(existsSync(join(parent, 'restored'))).toBe(false);
  });

  test('a corrupt, replaced, unsafe or oversized artifact invalidates the backup', () => {
    const parent = makeParent();
    const seeded = seedArchive(parent);
    const attempt = (name) => {
      const destination = join(parent, name);
      return {
        destination,
        result: createSpansBackup({ destination, root: seeded.root }),
      };
    };

    const note = blobPath(seeded.root, seeded.artifacts.note);
    const original = readFileSync(note);
    writeFileSync(
      note,
      JSON.stringify({ mediaType: 'text/plain', text: 'tampered', version: 1 })
    );
    expectPartial(attempt('corrupt'), ARTIFACT_INVALID, parent);
    writeFileSync(note, original);

    unlinkSync(note);
    symlinkSync(blobPath(seeded.root, seeded.artifacts.plan), note);
    expectPartial(attempt('symlinked'), ARTIFACT_INVALID, parent);
    unlinkSync(note);
    writeFileSync(note, original, { mode: 0o600 });

    chmodSync(note, 0o644);
    expectPartial(attempt('open-mode'), ARTIFACT_INVALID, parent);
    chmodSync(note, 0o600);

    truncateSync(note, SPANS_BACKUP_LIMITS.artifactBytes + 1);
    expectPartial(
      attempt('oversized'),
      'SPANS_BACKUP_ARTIFACT_TOO_LARGE',
      parent
    );
    writeFileSync(note, original);

    // With every blob restored the archive backs up cleanly again.
    expect(attempt('healthy').result.ok).toBe(true);
  });
});

describe('restore verification', () => {
  test('a backup without a completion receipt is incomplete and creates nothing', () => {
    const parent = makeParent();
    const seeded = makeBackup(parent);
    const partial = `${receiptPath(seeded.backupDir)}.partial`;
    writeFileSync(partial, readFileSync(receiptPath(seeded.backupDir)), {
      mode: 0o600,
    });
    unlinkSync(receiptPath(seeded.backupDir));
    const destination = join(parent, 'restored');
    expectRefused(
      restoreSpansBackup({ backupRoot: seeded.backupDir, destination }),
      INCOMPLETE,
      parent
    );
    expect(existsSync(destination)).toBe(false);
  });

  test('a corrupt or inconsistent receipt is refused before anything is written', () => {
    const parent = makeParent();
    const seeded = makeBackup(parent);
    const original = readFileSync(receiptPath(seeded.backupDir));
    const destination = join(parent, 'restored');
    const attempt = () =>
      restoreSpansBackup({ backupRoot: seeded.backupDir, destination });

    writeFileSync(receiptPath(seeded.backupDir), '{ not json');
    expectRefused(attempt(), MANIFEST_INVALID, parent);

    writeFileSync(receiptPath(seeded.backupDir), original);
    rewriteReceipt(seeded.backupDir, (receipt) => {
      receipt.version = 2;
    });
    expectRefused(attempt(), MANIFEST_INVALID, parent);

    writeFileSync(receiptPath(seeded.backupDir), original);
    rewriteReceipt(seeded.backupDir, (receipt) => {
      receipt.artifacts.pop();
    });
    expectRefused(attempt(), MANIFEST_INVALID, parent);

    writeFileSync(receiptPath(seeded.backupDir), original);
    rewriteReceipt(seeded.backupDir, (receipt) => {
      receipt.artifacts[0].id = 'sha256:nothex';
    });
    expectRefused(attempt(), MANIFEST_INVALID, parent);

    writeFileSync(receiptPath(seeded.backupDir), original);
    rewriteReceipt(seeded.backupDir, (receipt) => {
      receipt.schema.store = 2;
    });
    expectRefused(attempt(), SCHEMA_NEWER, parent);
    expect(existsSync(destination)).toBe(false);

    writeFileSync(receiptPath(seeded.backupDir), original);
    expect(attempt().ok).toBe(true);
  });

  test('missing, extra and unknown backup files are refused before anything is written', () => {
    const parent = makeParent();
    const seeded = makeBackup(parent);
    const destination = join(parent, 'restored');
    const attempt = () =>
      restoreSpansBackup({ backupRoot: seeded.backupDir, destination });

    const blob = blobPath(seeded.backupDir, seeded.artifacts.plan);
    const saved = readFileSync(blob);
    unlinkSync(blob);
    expectRefused(attempt(), MISMATCH, parent);
    writeFileSync(blob, saved, { mode: 0o600 });

    const stray = join(seeded.backupDir, 'artifacts', 'stray');
    writeFileSync(stray, 'x', { mode: 0o600 });
    expectRefused(attempt(), MISMATCH, parent);
    unlinkSync(stray);

    const transcript = join(seeded.backupDir, 'transcript.jsonl');
    writeFileSync(transcript, 'raw', { mode: 0o600 });
    expectRefused(attempt(), MISMATCH, parent);
    unlinkSync(transcript);

    writeFileSync(join(seeded.backupDir, `${DATABASE_FILE}-wal`), '', {
      mode: 0o600,
    });
    expectRefused(attempt(), MISMATCH, parent);
    expect(existsSync(destination)).toBe(false);
  });

  test('a tampered artifact fails verification and leaves an incomplete destination', () => {
    const parent = makeParent();
    const seeded = makeBackup(parent);
    const blob = blobPath(seeded.backupDir, seeded.artifacts.plan);
    const bytes = readFileSync(blob);
    // biome-ignore lint/suspicious/noBitwiseOperators: Flip one fixture bit to verify corruption detection.
    bytes[10] ^= 0x01;
    writeFileSync(blob, bytes);
    const destination = join(parent, 'restored');
    const result = restoreSpansBackup({
      backupRoot: seeded.backupDir,
      destination,
    });
    expectIncomplete(result, ARTIFACT_INVALID, parent, destination);
    expectRefused(
      restoreSpansBackup({ backupRoot: seeded.backupDir, destination }),
      DESTINATION_EXISTS,
      parent
    );
  });

  test('the receipt binds exact bytes, not just parsed content', () => {
    const parent = makeParent();
    const seeded = makeBackup(parent);
    const blob = blobPath(seeded.backupDir, seeded.artifacts.plan);
    const envelope = JSON.parse(readFileSync(blob, 'utf8'));
    writeFileSync(blob, JSON.stringify(envelope, null, 1));
    const destination = join(parent, 'restored');
    expectIncomplete(
      restoreSpansBackup({ backupRoot: seeded.backupDir, destination }),
      MISMATCH,
      parent,
      destination
    );
  });

  test('a changed database fails its hash, and a corrupt resealed one fails integrity', () => {
    const parent = makeParent();
    const seeded = makeBackup(parent);
    const database = join(seeded.backupDir, DATABASE_FILE);
    const fd = openSync(database, 'r+');
    try {
      writeSync(fd, Buffer.from('XXXXXXXXXXXXXXXX'), 0, 16, 0);
    } finally {
      closeSync(fd);
    }
    const first = join(parent, 'restored-one');
    expectIncomplete(
      restoreSpansBackup({ backupRoot: seeded.backupDir, destination: first }),
      MISMATCH,
      parent,
      first
    );

    resealDatabase(seeded.backupDir);
    const second = join(parent, 'restored-two');
    expectIncomplete(
      restoreSpansBackup({ backupRoot: seeded.backupDir, destination: second }),
      CORRUPT,
      parent,
      second
    );
  });

  test('a backup whose database claims a newer or unknown schema is refused', () => {
    const parent = makeParent();
    const seeded = makeBackup(parent);
    editBackupDatabase(
      seeded.backupDir,
      "UPDATE metadata SET value = '2' WHERE key = 'schema_version'"
    );
    const newer = join(parent, 'restored-newer');
    expectIncomplete(
      restoreSpansBackup({ backupRoot: seeded.backupDir, destination: newer }),
      SCHEMA_NEWER,
      parent,
      newer
    );

    editBackupDatabase(
      seeded.backupDir,
      "UPDATE metadata SET value = '1' WHERE key = 'schema_version'"
    );
    editBackupDatabase(
      seeded.backupDir,
      "UPDATE metadata SET value = '2' WHERE key = 'model_schema_version'"
    );
    const model = join(parent, 'restored-model');
    expectIncomplete(
      restoreSpansBackup({ backupRoot: seeded.backupDir, destination: model }),
      SCHEMA_NEWER,
      parent,
      model
    );
  });

  test('a resealed backup with a damaged supported row is refused', () => {
    // A damaged cache entry here also loses its artifact reference, which the
    // receipt comparison reports first, so it is covered on the backup side only.
    const kinds = Object.entries(DAMAGE).filter(([name]) => name !== 'cache');
    for (const [name, statements] of kinds) {
      const parent = makeParent();
      const seeded = makeBackup(parent);
      editDatabase(join(seeded.backupDir, DATABASE_FILE), statements);
      resealDatabase(seeded.backupDir);
      const destination = join(parent, `restored-${name}`);
      expectIncomplete(
        restoreSpansBackup({ backupRoot: seeded.backupDir, destination }),
        CORRUPT,
        parent,
        destination
      );
    }
  });

  test('a database that disagrees with the receipt counts is refused', () => {
    const parent = makeParent();
    const seeded = makeBackup(parent);
    rewriteReceipt(seeded.backupDir, (receipt) => {
      receipt.counts.events += 1;
    });
    const destination = join(parent, 'restored');
    expectIncomplete(
      restoreSpansBackup({ backupRoot: seeded.backupDir, destination }),
      MISMATCH,
      parent,
      destination
    );
  });
});

test('a directory flush failure after publication reports unknown and retains the receipt', () => {
  const parent = makeParent();
  const seeded = seedArchive(parent);
  const destination = join(parent, 'backup');
  const script = `
    import { mock } from 'bun:test';
    import * as fs from 'node:fs';
    const actual = { ...fs };
    const destination = ${JSON.stringify(destination)};
    mock.module('node:fs', () => ({ ...actual, fsyncSync(fd) {
      if (actual.existsSync(destination + '/spans-backup.json') && actual.fstatSync(fd).isDirectory()) {
        throw Object.assign(new Error('synthetic private failure'), { code: 'EIO' });
      }
      return actual.fsyncSync(fd);
    }}));
    const { createSpansBackup } = await import('./spans-maintenance.js');
    console.log(JSON.stringify(createSpansBackup({ root: ${JSON.stringify(seeded.root)}, destination })));
  `;
  const child = Bun.spawnSync([process.execPath, '-e', script], {
    cwd: import.meta.dir,
    stderr: 'pipe',
    stdout: 'pipe',
  });
  expect(child.exitCode).toBe(0);
  const result = JSON.parse(child.stdout.toString());
  expect(result).toMatchObject({
    code: 'SPANS_BACKUP_OUTCOME_UNKNOWN',
    ok: false,
    outcomeUnknown: true,
  });
  expect(result.incomplete).toBeUndefined();
  expect(JSON.stringify(result)).not.toContain(parent);
  expect(JSON.stringify(result)).not.toContain('synthetic private failure');
  expect(existsSync(receiptPath(destination))).toBe(true);
  expect(
    restoreSpansBackup({
      backupRoot: destination,
      destination: join(parent, 'restored'),
    }).ok
  ).toBe(true);
});

test('backs up a valid artifact with an interrupted temporary hardlink', () => {
  const parent = makeParent();
  const seeded = seedArchive(parent);
  const source = blobPath(seeded.root, seeded.artifacts.note);
  linkSync(source, join(seeded.root, 'artifacts', '.tmp-interrupted'));
  expect(lstatSync(source).nlink).toBe(2);
  const destination = join(parent, 'backup');
  expect(createSpansBackup({ destination, root: seeded.root }).ok).toBe(true);
  expect(lstatSync(source).nlink).toBe(2);
  expect(lstatSync(blobPath(destination, seeded.artifacts.note)).nlink).toBe(1);
  expect(
    createSpansArtifacts({ root: destination }).read({
      artifactId: seeded.artifacts.note,
    }).ok
  ).toBe(true);
});

test('refuses unsafe SQLite sidecars before creating the backup destination', () => {
  const parent = makeParent();
  const seeded = seedArchive(parent);
  expect(seeded.store.close().ok).toBe(true);
  const target = join(parent, 'sidecar-target');
  writeFileSync(target, 'keep', { mode: 0o600 });
  symlinkSync(target, join(seeded.root, 'spans.sqlite3-journal'));
  const destination = join(parent, 'backup');
  expectRefused(
    createSpansBackup({ destination, root: seeded.root }),
    PATH_UNSAFE,
    parent
  );
  expect(existsSync(destination)).toBe(false);
  expect(readFileSync(target, 'utf8')).toBe('keep');
});

test('refuses an oversized restore database before copying its bytes', () => {
  const parent = makeParent();
  const seeded = makeBackup(parent);
  appendFileSync(join(seeded.backupDir, DATABASE_FILE), 'excess');
  const destination = join(parent, 'restored');
  expectIncomplete(
    restoreSpansBackup({ backupRoot: seeded.backupDir, destination }),
    MISMATCH,
    parent,
    destination
  );
  expect(existsSync(join(destination, DATABASE_FILE))).toBe(false);
});

test('a case-alias destination cannot write inside the source archive', () => {
  const parent = makeParent();
  const seeded = seedArchive(parent);
  const destination = join(parent, 'SOURCE', 'snapshot');
  const result = createSpansBackup({ destination, root: seeded.root });
  expect(result.ok).toBe(false);
  expect(existsSync(join(seeded.root, 'snapshot'))).toBe(false);
});
