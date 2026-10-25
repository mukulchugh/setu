import { afterEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  appendFileSync,
  chmodSync,
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
import { fileURLToPath } from 'node:url';
import { createSpansArtifacts } from './spans-artifacts.js';
import {
  SPANS_BACKUP_RECEIPT_FILE,
  SPANS_RESTORE_RECEIPT_FILE,
} from './spans-maintenance.js';
import { runSpansMaintenanceCommand } from './spans-maintenance-command.js';
import { importSpansSourceFile } from './spans-source-import.js';
import { openSpansStore } from './spans-store.js';

const roots = [];
const archives = [];
const secret = 'sk-proj-1234567890abcdefghijkl';

afterEach(() => {
  for (const archive of archives.splice(0)) {
    expect(archive.store.close().ok).toBe(true);
  }
  for (const root of roots.splice(0)) {
    rmSync(root, { force: true, recursive: true });
  }
});

function makeRoot(prefix) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
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
      // SQLite readers update shared-memory locks, not archive content.
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

function conversationLine(text) {
  return `${JSON.stringify({
    payload: {
      content: [{ text, type: 'output_text' }],
      id: 'native-1',
      role: 'assistant',
      type: 'message',
    },
    type: 'response_item',
  })}\n`;
}

async function importedArchive(parent) {
  const root = join(parent, 'live-archive');
  const archive = {
    artifacts: createSpansArtifacts({ root }),
    store: openSpansStore({ root }),
  };
  archives.push(archive);
  const source = join(parent, 'conversation.jsonl');
  writeFileSync(source, conversationLine(`hello token=${secret}`), {
    mode: 0o600,
  });
  const imported = await importSpansSourceFile({
    artifacts: archive.artifacts,
    parserVersion: 'test-parser-1',
    path: source,
    provider: 'codex',
    runId: 'run-a',
    sourceGeneration: 0,
    sourceId: 'session-a',
    store: archive.store,
  });
  expect(imported.ok).toBe(true);
  return { archive, root, source };
}

describe('runSpansMaintenanceCommand', () => {
  test('backs up and restores imported redacted history and evidence without activation', async () => {
    const parent = makeRoot('setu-spans-maintenance-command-');
    const { archive, root } = await importedArchive(parent);
    const sourceBefore = treeDigest(root);
    const backupRoot = join(parent, 'backup');
    const backup = runSpansMaintenanceCommand({
      destination: backupRoot,
      operation: 'backup',
      root,
    });
    expect(backup).toMatchObject({ artifacts: 1, events: 2, ok: true });
    const cleanBackupRoot = join(parent, 'clean-backup');
    expect(
      runSpansMaintenanceCommand({
        destination: cleanBackupRoot,
        operation: 'backup',
        root,
      }).ok
    ).toBe(true);
    expect(readdirSync(backupRoot).sort()).toEqual([
      'artifacts',
      SPANS_BACKUP_RECEIPT_FILE,
      'spans.sqlite3',
    ]);
    for (const entry of readdirSync(join(backupRoot, 'artifacts'))) {
      expect(
        readFileSync(join(backupRoot, 'artifacts', entry), 'utf8')
      ).not.toContain(secret);
    }

    const backupBeforeRestore = treeDigest(backupRoot);
    const restoredRoot = join(parent, 'restored');
    const restored = runSpansMaintenanceCommand({
      backupRoot,
      destination: restoredRoot,
      operation: 'restore',
    });
    expect(restored).toMatchObject({ artifacts: 1, events: 2, ok: true });
    expect(treeDigest(backupRoot)).toBe(backupBeforeRestore);
    expect(treeDigest(root)).toBe(sourceBefore);
    expect(readdirSync(restoredRoot)).toContain(SPANS_RESTORE_RECEIPT_FILE);
    expect(readdirSync(root)).not.toContain(SPANS_RESTORE_RECEIPT_FILE);

    const restoredStore = openSpansStore({ root: restoredRoot });
    try {
      const history = restoredStore.readEvents({ runId: 'run-a' });
      expect(history.ok).toBe(true);
      expect(history.events.map((entry) => entry.type)).toEqual([
        'source.message',
        'source.checkpoint',
      ]);
      const { artifactId } = history.events[0].payload;
      const evidence = createSpansArtifacts({ root: restoredRoot }).read({
        artifactId,
      });
      expect(evidence).toMatchObject({
        mediaType: 'application/json',
        ok: true,
      });
      expect(JSON.parse(evidence.text).text).toBe('hello token=[REDACTED]');
      expect(evidence.text).not.toContain(secret);
    } finally {
      expect(restoredStore.close().ok).toBe(true);
    }
    expect(archive.store.readEvents({ runId: 'run-a' }).events).toHaveLength(2);
  });

  test('rejects a tampered backup and leaves existing destinations and source untouched', async () => {
    const parent = makeRoot('setu-spans-maintenance-command-');
    const { root } = await importedArchive(parent);
    const backupRoot = join(parent, 'backup');
    const cleanBackupRoot = join(parent, 'clean-backup');
    expect(
      runSpansMaintenanceCommand({
        destination: cleanBackupRoot,
        operation: 'backup',
        root,
      }).ok
    ).toBe(true);
    expect(
      runSpansMaintenanceCommand({
        destination: backupRoot,
        operation: 'backup',
        root,
      }).ok
    ).toBe(true);
    const sourceBefore = treeDigest(root);
    const backupDatabase = join(backupRoot, 'spans.sqlite3');
    appendFileSync(backupDatabase, 'tampered');
    const tamperedBefore = treeDigest(backupRoot);

    const refused = runSpansMaintenanceCommand({
      backupRoot,
      destination: join(parent, 'refused-restore'),
      operation: 'restore',
    });
    expect(refused).toMatchObject({ incomplete: true, ok: false });
    expect(refused.code).toBe('SPANS_BACKUP_MISMATCH');
    expect(treeDigest(backupRoot)).toBe(tamperedBefore);
    expect(treeDigest(root)).toBe(sourceBefore);

    const existing = join(parent, 'existing-destination');
    // A private existing directory is protected by the same primitive guard.
    mkdirSync(existing, { mode: 0o700 });
    writeFileSync(join(existing, 'keep.txt'), 'leave me', { mode: 0o600 });
    const existingBefore = treeDigest(existing);
    const existingResult = runSpansMaintenanceCommand({
      backupRoot: cleanBackupRoot,
      destination: existing,
      operation: 'restore',
    });
    expect(existingResult).toMatchObject({
      code: 'SPANS_BACKUP_DESTINATION_EXISTS',
      ok: false,
    });
    expect(treeDigest(existing)).toBe(existingBefore);
  });

  test('validates operation and exact input fields before filesystem effects', () => {
    const parent = makeRoot('setu-spans-maintenance-command-');
    const destination = join(parent, 'must-not-exist');
    expect(
      runSpansMaintenanceCommand({
        destination,
        operation: 'unsupported',
        root: join(parent, 'source'),
      })
    ).toMatchObject({ code: 'SPANS_BACKUP_OPTIONS_INVALID', ok: false });
    expect(
      runSpansMaintenanceCommand({
        destination,
        gate: true,
        operation: 'backup',
        root: join(parent, 'source'),
      })
    ).toMatchObject({ code: 'SPANS_BACKUP_OPTIONS_INVALID', ok: false });
    expect(
      runSpansMaintenanceCommand({
        destination,
        operation: 'backup',
        root: join(parent, 'source'),
      })
    ).toMatchObject({ code: 'SPANS_BACKUP_SOURCE_UNAVAILABLE', ok: false });
    expect(readdirSync(parent)).toEqual([]);
  });

  test('the shipped child accepts the bounded request and returns only summary counts', async () => {
    const parent = makeRoot('setu-spans-maintenance-child-');
    const { root } = await importedArchive(parent);
    const destination = join(parent, 'child-backup');
    const childPath = fileURLToPath(
      new URL('./spans-maintenance-child.js', import.meta.url)
    );
    const child = spawnSync(process.execPath, [childPath], {
      encoding: 'utf8',
      input: JSON.stringify({
        destination,
        operation: 'backup',
        root,
      }),
      timeout: 5000,
    });

    expect(child.error).toBeUndefined();
    expect(child.status).toBe(0);
    expect(child.stderr).toBe('');
    const result = JSON.parse(child.stdout);
    expect(Object.keys(result).sort()).toEqual([
      'artifactBytes',
      'artifacts',
      'cacheEntries',
      'databaseBytes',
      'events',
      'ok',
      'sources',
      'views',
    ]);
    expect(result).toMatchObject({ artifacts: 1, events: 2, ok: true });
    expect(child.stdout).not.toContain(root);
    expect(readdirSync(destination)).toContain(SPANS_BACKUP_RECEIPT_FILE);

    const oversized = spawnSync(process.execPath, [childPath], {
      encoding: 'utf8',
      input: 'x'.repeat(64 * 1024 + 1),
      timeout: 5000,
    });
    expect(oversized.error).toBeUndefined();
    expect(oversized.status).toBe(0);
    expect(JSON.parse(oversized.stdout)).toMatchObject({
      code: 'SPANS_BACKUP_OPTIONS_INVALID',
      ok: false,
    });
    expect(oversized.stdout.length).toBeLessThan(64 * 1024);
  });
});
