import { Database } from 'bun:sqlite';
import { afterEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import {
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
import { submitSpansMaintenance } from './portal/spans-maintenance';
import { createPortalRuntime } from './portal.js';
import { createSpansArtifacts } from './spans-artifacts.js';
import {
  SPANS_BACKUP_RECEIPT_FILE,
  SPANS_RESTORE_RECEIPT_FILE,
} from './spans-maintenance.js';
import { importSpansSourceFile } from './spans-source-import.js';
import { openSpansStore } from './spans-store.js';
import { createWorkspaceState } from './workspace-state.js';

const SECRET = 'sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789';
const parents = [];
const stores = [];

function makeParent() {
  const root = realpathSync(
    mkdtempSync(join(tmpdir(), 'spans-maintenance-api-'))
  );
  chmodSync(root, 0o700);
  parents.push(root);
  return root;
}

function digestTree(directory) {
  const hash = createHash('sha256');
  const visit = (path) => {
    for (const entry of readdirSync(path, { withFileTypes: true }).sort(
      (a, b) => a.name.localeCompare(b.name)
    )) {
      hash.update(`${entry.name}:${entry.isDirectory()}\n`);
      const child = join(path, entry.name);
      if (entry.isDirectory()) {
        visit(child);
      } else {
        if (entry.name.endsWith('-shm')) {
          continue;
        }
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
      id: 'native-history-1',
      role: 'assistant',
      type: 'message',
    },
    type: 'response_item',
  })}\n`;
}

async function fixture(work) {
  const parent = makeParent();
  const archive = join(parent, 'trusted-archive');
  mkdirSync(archive, { mode: 0o700 });
  const store = openSpansStore({ root: archive });
  stores.push(store);
  const state = createWorkspaceState({
    configPath: join(parent, 'config.json'),
    setuDir: parent,
    workspaceRoot: parent,
  });
  const config = { tunnel: 'fixture', workspace: parent };
  await state.replace('config', config);
  const runtime = await createPortalRuntime({
    computeWorktrees: () => Promise.resolve([]),
    config,
    indexPage: new Response('fixture'),
    managedAgents: {
      dispose: () => Promise.resolve(),
      recover: () => Promise.resolve(),
    },
    observeProcess: () => Promise.resolve({ state: 'unknown' }),
    port: 43_210,
    projects: {},
    reconcileDevServers: () => Promise.resolve(),
    reconcileTriggerSidecars: () => Promise.resolve(),
    routing: { syncHosts: () => Promise.resolve() },
    seedSidecarApprovals: () => Promise.resolve(),
    serve: () => ({ stop: () => undefined }),
    spansRoot: archive,
    state,
    timers: { clearInterval: () => undefined, setInterval: () => 1 },
  });
  await runtime.start();
  let disposed = false;
  const dispose = async () => {
    if (disposed) {
      return;
    }
    disposed = true;
    await runtime.dispose();
  };
  const server = {
    requestIP: () => ({ address: '127.0.0.1' }),
    timeout: () => undefined,
  };
  const request = (path, init) =>
    runtime.handle(new Request(`http://localhost:43210${path}`, init), server);
  try {
    const source = join(parent, 'conversation.jsonl');
    writeFileSync(source, conversationLine(`fixture history token=${SECRET}`), {
      mode: 0o600,
    });
    const imported = await importSpansSourceFile({
      artifacts: createSpansArtifacts({ root: archive }),
      parserVersion: 'maintenance-api-test-1',
      path: source,
      provider: 'codex',
      runId: 'history-run',
      sourceGeneration: 0,
      sourceId: 'history-source',
      store,
    });
    expect(imported.ok).toBe(true);
    await work({ archive, dispose, parent, request, runtime, state, store });
  } finally {
    await dispose();
  }
}

function post(request, path, body) {
  return request(path, {
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
    method: 'POST',
  });
}

async function callMcp(request, name, input) {
  const response = await request('/mcp', {
    body: JSON.stringify({
      id: 1,
      jsonrpc: '2.0',
      method: 'tools/call',
      params: { arguments: input, name },
    }),
    headers: {
      accept: 'application/json, text/event-stream',
      'content-type': 'application/json',
      host: 'localhost:43210',
    },
    method: 'POST',
  });
  const text = await response.text();
  const raw = text.startsWith('event:')
    ? text
        .split('\n')
        .find((line) => line.startsWith('data: '))
        .slice(6)
    : text;
  return JSON.parse(raw);
}

function output(result) {
  const content = result?.result?.content?.find(
    (entry) => entry.type === 'text'
  );
  const value = content
    ? JSON.parse(content.text)
    : result?.result?.structuredContent;
  expect(result.result.isError).toBe(value.ok !== true);
  return value;
}

afterEach(() => {
  for (const store of stores.splice(0)) {
    expect(store.close().ok).toBe(true);
  }
  for (const parent of parents.splice(0)) {
    rmSync(parent, { force: true, recursive: true });
  }
});

describe('Spans maintenance portal API', () => {
  test('browser transport roundtrips a backup and inactive restore through real portal handlers', async () => {
    await fixture(async ({ archive, parent, request, state }) => {
      const previousFetch = globalThis.fetch;
      const configBefore = await state.read('config');
      const sourceBefore = digestTree(archive);
      const backup = join(parent, 'browser-backup');
      const restored = join(parent, 'browser-restored');
      globalThis.fetch = (path, init) => request(String(path), init);
      try {
        const copied = await submitSpansMaintenance({
          destination: backup,
          operation: 'backup',
        });
        expect(copied).toMatchObject({
          counts: { artifacts: 1, events: 2 },
          kind: 'success',
        });
        const recovered = await submitSpansMaintenance({
          backupRoot: backup,
          destination: restored,
          operation: 'restore',
        });
        expect(recovered).toMatchObject({
          counts: { artifacts: 1, events: 2 },
          kind: 'success',
        });
        const occupied = await submitSpansMaintenance({
          destination: backup,
          operation: 'backup',
        });
        expect(occupied.kind).toBe('refused');
        const capabilities = await (
          await request('/api/update/capabilities')
        ).json();
        const owner = await (
          await post(request, '/api/update/quiesce', capabilities)
        ).json();
        expect(owner.token).toBeString();
        const blocked = join(parent, 'browser-cutover-blocked');
        expect(
          await submitSpansMaintenance({
            destination: blocked,
            operation: 'backup',
          })
        ).toEqual({
          kind: 'refused',
          message: 'Setu is updating. Wait for the update to finish.',
        });
        expect(existsSync(blocked)).toBe(false);
        expect(digestTree(archive)).toBe(sourceBefore);
        expect(await state.read('config')).toEqual(configBefore);
        expect(existsSync(join(restored, SPANS_RESTORE_RECEIPT_FILE))).toBe(
          true
        );
      } finally {
        globalThis.fetch = previousFetch;
      }
    });
  });

  test('update cutover refuses MCP archive writes before filesystem effects', async () => {
    await fixture(async ({ parent, request }) => {
      const capabilities = await (
        await request('/api/update/capabilities')
      ).json();
      const owner = await (
        await post(request, '/api/update/quiesce', capabilities)
      ).json();
      expect(owner.token).toBeString();
      const destination = join(parent, 'closed-cutover-backup');
      const result = output(
        await callMcp(request, 'backup_spans_archive', {
          input: { destination },
        })
      );
      expect(result).toMatchObject({ code: 'ADMISSION_CLOSED', ok: false });
      expect(existsSync(destination)).toBe(false);
      const refusals = await Promise.all(
        [
          'restore_spans_archive',
          'import_spans_source',
          'import_spans_history',
          'create_spans_draft',
          'revise_spans_plan',
          'create_spans_workflow',
        ].map((name) => callMcp(request, name, { input: {} }))
      );
      for (const refusal of refusals) {
        expect(output(refusal)).toMatchObject({
          code: 'ADMISSION_CLOSED',
          ok: false,
        });
      }
    });
  });

  test('keeps portal reads responsive during an owned backup and waits for it on dispose', async () => {
    await fixture(
      async ({ archive, dispose, parent, request, state, store }) => {
        const configBefore = await state.read('config');
        const bulkArtifact = createSpansArtifacts({ root: archive }).put({
          mediaType: 'text/plain',
          text: 'x'.repeat(8 * 1024 * 1024),
        });
        expect(bulkArtifact.ok).toBe(true);
        expect(
          store.appendEvent({
            eventId: 'bulk-evidence',
            payload: { artifactId: bulkArtifact.artifactId },
            runId: 'history-run',
            type: 'span.recorded',
          }).ok
        ).toBe(true);
        expect(store.close().ok).toBe(true);
        const lock = new Database(join(archive, 'spans.sqlite3'));
        lock.exec('PRAGMA journal_mode=DELETE');
        const archiveBefore = digestTree(archive);
        lock.exec('BEGIN EXCLUSIVE');
        const backupRoot = join(parent, 'active-backup');
        let backupPromise;
        let disposing;
        let disposed = false;
        try {
          backupPromise = post(request, '/api/spans/backup', {
            destination: backupRoot,
          });
          await new Promise((resolve) => setImmediate(resolve));
          const busy = await post(request, '/api/spans/backup', {
            destination: join(parent, 'second-backup'),
          });
          expect(await busy.json()).toMatchObject({
            code: 'SPANS_BACKUP_BUSY',
            error:
              'A Spans maintenance operation is already active in this runtime.',
            ok: false,
          });
          const read = await request('/api/spans/workflows');
          expect(read.status).toBe(200);
          expect(await read.json()).toMatchObject({ ok: true });
          disposing = dispose().then(() => {
            disposed = true;
          });
          await new Promise((resolve) => setImmediate(resolve));
          expect(disposed).toBe(false);
          expect(existsSync(join(backupRoot, SPANS_BACKUP_RECEIPT_FILE))).toBe(
            false
          );
        } finally {
          lock.exec('ROLLBACK');
          lock.close();
        }
        await disposing;
        expect(disposed).toBe(true);
        const result = await backupPromise;
        expect(result.status).toBe(200);
        expect(await result.json()).toMatchObject({
          artifacts: 2,
          events: 3,
          ok: true,
        });
        expect(existsSync(join(backupRoot, SPANS_BACKUP_RECEIPT_FILE))).toBe(
          true
        );
        expect(digestTree(archive)).toBe(archiveBefore);
        expect(await state.read('config')).toEqual(configBefore);
        expect(readdirSync(archive)).not.toContain(SPANS_RESTORE_RECEIPT_FILE);
      }
    );
  });

  test('backs up redacted imported history over HTTP and restores it through MCP without activation', async () => {
    await fixture(async ({ archive, parent, request, state, store }) => {
      const configBefore = await state.read('config');
      const archiveBefore = digestTree(archive);
      const backupRoot = join(parent, 'backup');
      const backupResponse = await post(request, '/api/spans/backup', {
        destination: backupRoot,
      });
      expect(backupResponse.status).toBe(200);
      expect(await backupResponse.json()).toMatchObject({
        events: 2,
        ok: true,
      });
      expect(readdirSync(backupRoot).sort()).toEqual([
        'artifacts',
        SPANS_BACKUP_RECEIPT_FILE,
        'spans.sqlite3',
      ]);
      const [artifactFile] = readdirSync(join(backupRoot, 'artifacts'));
      expect(
        readFileSync(join(backupRoot, 'artifacts', artifactFile), 'utf8')
      ).not.toContain(SECRET);

      const restoredRoot = join(parent, 'restored');
      const restored = output(
        await callMcp(request, 'restore_spans_archive', {
          input: { backupRoot, destination: restoredRoot },
        })
      );
      expect(restored).toMatchObject({ events: 2, ok: true });
      expect(readdirSync(restoredRoot)).toContain(SPANS_RESTORE_RECEIPT_FILE);
      expect(existsSync(join(restoredRoot, 'spans.sqlite3'))).toBe(true);
      const restoredStore = openSpansStore({ root: restoredRoot });
      try {
        const history = restoredStore.readEvents({ runId: 'history-run' });
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
        expect(JSON.parse(evidence.text).text).toBe(
          'fixture history token=[REDACTED]'
        );
        expect(evidence.text).not.toContain(SECRET);
      } finally {
        expect(restoredStore.close().ok).toBe(true);
      }

      const secondBackup = join(parent, 'mcp-backup');
      const mcpBackup = await callMcp(request, 'backup_spans_archive', {
        input: { destination: secondBackup },
      });
      expect(mcpBackup.result.isError).toBe(false);
      expect(output(mcpBackup)).toMatchObject({ events: 2, ok: true });
      const httpRestore = await post(request, '/api/spans/restore', {
        backupRoot: secondBackup,
        destination: join(parent, 'http-restored'),
      });
      expect(httpRestore.status).toBe(200);
      expect(await httpRestore.json()).toMatchObject({ events: 2, ok: true });
      const secondRestored = openSpansStore({
        readonly: true,
        root: join(parent, 'http-restored'),
      });
      try {
        expect(
          secondRestored.readEvents({ runId: 'history-run' }).events
        ).toHaveLength(2);
      } finally {
        expect(secondRestored.close().ok).toBe(true);
      }

      expect(digestTree(archive)).toBe(archiveBefore);
      expect(await state.read('config')).toEqual(configBefore);
      expect(store.readEvents({ runId: 'history-run' }).events).toHaveLength(2);
      expect(readdirSync(archive)).not.toContain(SPANS_RESTORE_RECEIPT_FILE);
    });
  });

  test('refuses existing backup and restore destinations without changing sentinels', async () => {
    await fixture(async ({ parent, request }) => {
      const occupiedBackup = join(parent, 'occupied-backup');
      mkdirSync(occupiedBackup, { mode: 0o700 });
      writeFileSync(join(occupiedBackup, 'sentinel'), 'keep backup');
      const backupBefore = digestTree(occupiedBackup);
      const backup = await post(request, '/api/spans/backup', {
        destination: occupiedBackup,
      });
      expect(backup.status).toBe(200);
      expect(await backup.json()).toMatchObject({
        code: 'SPANS_BACKUP_DESTINATION_EXISTS',
        ok: false,
      });
      expect(digestTree(occupiedBackup)).toBe(backupBefore);

      const freshBackup = join(parent, 'backup');
      expect(
        (
          await (
            await post(request, '/api/spans/backup', {
              destination: freshBackup,
            })
          ).json()
        ).ok
      ).toBe(true);
      const occupiedRestore = join(parent, 'occupied-restore');
      mkdirSync(occupiedRestore, { mode: 0o700 });
      writeFileSync(join(occupiedRestore, 'sentinel'), 'keep restore');
      const restoreBefore = digestTree(occupiedRestore);
      const restore = output(
        await callMcp(request, 'restore_spans_archive', {
          input: { backupRoot: freshBackup, destination: occupiedRestore },
        })
      );
      expect(restore).toMatchObject({
        code: 'SPANS_BACKUP_DESTINATION_EXISTS',
        ok: false,
      });
      expect(digestTree(occupiedRestore)).toBe(restoreBefore);
    });
  });

  test('rejects malformed requests without creating destinations', async () => {
    await fixture(async ({ parent, request }) => {
      const backupDestination = join(parent, 'malformed-backup');
      const restoreDestination = join(parent, 'malformed-restore');
      for (const [path, body] of [
        ['/api/spans/backup', null],
        ['/api/spans/backup', { destination: backupDestination, extra: true }],
        ['/api/spans/restore', { backupRoot: join(parent, 'missing') }],
      ]) {
        // biome-ignore lint/performance/noAwaitInLoops: Keep malformed cases sequential to isolate whether any request creates a destination.
        const response = await post(request, path, body);
        expect(response.status).toBe(400);
      }
      expect(existsSync(backupDestination)).toBe(false);
      expect(existsSync(restoreDestination)).toBe(false);
      const malformedMcp = await callMcp(request, 'backup_spans_archive', {
        input: {
          destination: backupDestination,
          root: join(parent, 'untrusted'),
        },
      });
      expect(malformedMcp.result.isError).toBe(true);
      expect(existsSync(backupDestination)).toBe(false);
      expect(existsSync(join(parent, 'untrusted'))).toBe(false);
    });
  });

  test('a request cannot redirect backup away from the portal-bound archive root', async () => {
    await fixture(async ({ archive, parent, request }) => {
      const untrusted = join(parent, 'untrusted-archive');
      mkdirSync(untrusted, { mode: 0o700 });
      const attackerStore = openSpansStore({ root: untrusted });
      stores.push(attackerStore);
      const attackerPath = join(parent, 'attacker.jsonl');
      writeFileSync(attackerPath, conversationLine('attacker-only'));
      const attackerHistory = await importSpansSourceFile({
        artifacts: createSpansArtifacts({ root: untrusted }),
        parserVersion: 'maintenance-api-test-1',
        path: attackerPath,
        provider: 'codex',
        runId: 'attacker-run',
        sourceGeneration: 0,
        sourceId: 'attacker-source',
        store: attackerStore,
      });
      expect(attackerHistory.ok).toBe(true);
      const attackerBefore = digestTree(untrusted);
      const archiveBefore = digestTree(archive);
      const destination = join(parent, 'bound-root-backup');
      const result = await post(request, '/api/spans/backup', {
        destination,
        root: untrusted,
      });
      const body = await result.json();
      expect(body).toMatchObject({
        code: 'SPANS_BACKUP_OPTIONS_INVALID',
        ok: false,
      });
      expect(result.status).toBe(400);
      expect(existsSync(destination)).toBe(false);
      expect(digestTree(archive)).toBe(archiveBefore);
      expect(digestTree(untrusted)).toBe(attackerBefore);
    });
  });

  test('refuses a tampered backup and preserves the backup and live archive', async () => {
    await fixture(async ({ archive, parent, request }) => {
      const backupRoot = join(parent, 'tampered-backup');
      expect(
        (
          await (
            await post(request, '/api/spans/backup', {
              destination: backupRoot,
            })
          ).json()
        ).ok
      ).toBe(true);
      writeFileSync(join(backupRoot, 'spans.sqlite3'), 'tampered', {
        flag: 'a',
      });
      const backupBefore = digestTree(backupRoot);
      const archiveBefore = digestTree(archive);
      const destination = join(parent, 'tampered-restore');
      const result = output(
        await callMcp(request, 'restore_spans_archive', {
          input: { backupRoot, destination },
        })
      );
      expect(result).toMatchObject({
        code: 'SPANS_BACKUP_MISMATCH',
        ok: false,
      });
      expect(result.incomplete).toBe(true);
      expect(digestTree(backupRoot)).toBe(backupBefore);
      expect(digestTree(archive)).toBe(archiveBefore);
      expect(existsSync(destination)).toBe(true);
    });
  });
});
