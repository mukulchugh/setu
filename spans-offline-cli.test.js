import { afterEach, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runCli } from './cli.js';
import { openSpansStore } from './spans-store.js';

const initialExitCode = process.exitCode ?? 0;
afterEach(() => {
  process.exitCode = initialExitCode;
});

async function invoke(argv, localCommand = {}) {
  const output = [];
  const errors = [];
  const requests = [];
  const { log, error } = console;
  console.log = (value) => output.push(String(value));
  console.error = (value) => errors.push(String(value));
  try {
    const status = await runCli(['spans', ...argv, '--json'], {
      localCommand,
      request: (request) => {
        requests.push(request);
        throw new Error('Offline commands must not call the portal.');
      },
    });
    return { errors, output, requests, status };
  } finally {
    console.log = log;
    console.error = error;
  }
}

test('offline backup and restore forward explicit locations without portal requests', async () => {
  const calls = [];
  const localCommand = {
    loadSpansMaintenance: () => ({
      runSpansMaintenanceCommand: (input) => {
        calls.push(input);
        return { artifacts: 1, ok: true };
      },
    }),
  };
  const backup = await invoke(
    [
      'backup',
      '--root',
      '/fixture/archive',
      '--destination',
      '/fixture/backup',
    ],
    localCommand
  );
  const restore = await invoke(
    [
      'restore',
      '--backup-root',
      '/fixture/backup',
      '--destination',
      '/fixture/restored',
    ],
    localCommand
  );
  expect(backup.status).toBe(0);
  expect(restore.status).toBe(0);
  expect([...backup.requests, ...restore.requests]).toEqual([]);
  expect(calls).toEqual([
    {
      destination: '/fixture/backup',
      operation: 'backup',
      root: '/fixture/archive',
    },
    {
      backupRoot: '/fixture/backup',
      destination: '/fixture/restored',
      operation: 'restore',
    },
  ]);
});

test('offline maintenance refuses incomplete and incompatible arguments before loading', async () => {
  let loaded = 0;
  const localCommand = {
    loadSpansMaintenance: () => {
      loaded += 1;
      return {};
    },
  };
  for (const argv of [
    ['backup'],
    ['backup', '--root', '/fixture/archive'],
    ['backup', '--root', 'relative', '--destination', '/fixture/backup'],
    [
      'backup',
      '--root',
      '/fixture/../archive',
      '--destination',
      '/fixture/backup',
    ],
    [
      'restore',
      '--root',
      '/fixture/backup',
      '--destination',
      '/fixture/restored',
    ],
    [
      'restore',
      '--backup-root',
      '/fixture/backup',
      '--destination',
      '/fixture/restored',
      '--force',
    ],
  ]) {
    // biome-ignore lint/performance/noAwaitInLoops: CLI globals require sequential invocations.
    const result = await invoke(argv, localCommand);
    expect(result.status).toBe(1);
    expect(result.requests).toEqual([]);
  }
  expect(loaded).toBe(0);
});

test('offline maintenance preserves unknown outcomes and reports failure', async () => {
  const receipt = {
    code: 'SPANS_BACKUP_OUTCOME_UNKNOWN',
    error: 'Backup completion could not be confirmed.',
    incomplete: true,
    ok: false,
    outcomeUnknown: true,
  };
  const result = await invoke(
    [
      'backup',
      '--root',
      '/fixture/archive',
      '--destination',
      '/fixture/backup',
    ],
    {
      loadSpansMaintenance: () => ({
        runSpansMaintenanceCommand: () => receipt,
      }),
    }
  );
  expect(result.status).toBe(1);
  expect(JSON.parse(result.output.join(''))).toEqual(receipt);
});

test('selected import uses the trusted archive gate and closes after its one page', async () => {
  const input = {
    path: '/fixture/selected.jsonl',
    provider: 'codex',
    runId: 'run-1',
  };
  const calls = [];
  const archiveWrite = () => ({ ok: true });
  const result = await invoke(
    ['import', '--root', '/fixture/archive', '--input', JSON.stringify(input)],
    {
      loadSpansImportRuntime: () => ({
        createSpansImportRuntime: (options) => {
          calls.push(options);
          return {
            close: () => {
              calls.push('closed');
              return { ok: true };
            },
            importSelected: (selected) => {
              calls.push(selected);
              return { nextOffset: 100, ok: true };
            },
          };
        },
      }),
      spansArchiveWrite: archiveWrite,
    }
  );
  expect(result.status).toBe(0);
  expect(result.requests).toEqual([]);
  expect(calls).toEqual([
    { archiveWrite, root: '/fixture/archive' },
    input,
    'closed',
  ]);
  expect(JSON.parse(result.output[0])).toEqual({ nextOffset: 100, ok: true });
});

test('selected import never reports a retry offset after close failure', async () => {
  const result = await invoke(
    ['import', '--root', '/fixture/archive', '--input', '{}'],
    {
      loadSpansImportRuntime: () => ({
        createSpansImportRuntime: () => ({
          close: () => ({ ok: false }),
          importSelected: () => ({ nextOffset: 100, ok: true }),
        }),
      }),
      spansArchiveWrite: () => ({ ok: true }),
    }
  );
  expect(result.status).toBe(1);
  expect(JSON.parse(result.output[0])).toMatchObject({
    code: 'SPANS_IMPORT_CLOSE_FAILED',
    nextOffset: null,
    ok: false,
    outcomeUnknown: true,
  });
});

test('native CLI imports a selected source, backs it up and restores the same history', () => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'setu-offline-cli-')));
  const root = join(base, 'archive');
  const home = join(base, 'home');
  const workspace = join(base, 'workspace');
  mkdirSync(home, { mode: 0o700 });
  mkdirSync(workspace, { mode: 0o700 });
  const config = JSON.stringify({ workspace });
  writeFileSync(join(home, '.setu.json'), config);
  const initial = openSpansStore({ root });
  expect(initial.close().ok).toBe(true);
  const path = join(base, 'selected.jsonl');
  const source = `${JSON.stringify({
    payload: {
      content: [{ text: 'selected fixture', type: 'output_text' }],
      id: 'native-1',
      role: 'assistant',
      type: 'message',
    },
    type: 'response_item',
  })}\n`;
  writeFileSync(path, source);
  const cliPath = fileURLToPath(new URL('./cli.js', import.meta.url));
  const call = (args) => {
    const result = spawnSync(
      process.execPath,
      [cliPath, 'spans', ...args, '--json'],
      {
        encoding: 'utf8',
        env: {
          ...process.env,
          BUN_RUNTIME_TRANSPILER_CACHE_PATH: '0',
          HOME: home,
          PATH: `${dirname(process.execPath)}:/usr/bin:/bin`,
        },
        timeout: 30_000,
      }
    );
    expect({ error: result.stderr, status: result.status }).toEqual({
      error: '',
      status: 0,
    });
    return JSON.parse(result.stdout);
  };
  try {
    const input = JSON.stringify({
      parserVersion: 'fixture-1',
      path,
      provider: 'codex',
      runId: 'run-1',
      sourceGeneration: 0,
      sourceId: 'source-1',
    });
    expect(call(['import', '--root', root, '--input', input])).toMatchObject({
      importedCount: 1,
      ok: true,
    });
    expect(call(['import', '--root', root, '--input', input])).toMatchObject({
      importedCount: 0,
      ok: true,
    });
    const backup = join(base, 'backup');
    const restored = join(base, 'restored');
    expect(call(['backup', '--root', root, '--destination', backup]).ok).toBe(
      true
    );
    expect(
      call(['restore', '--backup-root', backup, '--destination', restored]).ok
    ).toBe(true);
    const originalStore = openSpansStore({ readonly: true, root });
    const restoredStore = openSpansStore({ readonly: true, root: restored });
    try {
      expect(restoredStore.readEvents({ runId: 'run-1' })).toEqual(
        originalStore.readEvents({ runId: 'run-1' })
      );
    } finally {
      expect(originalStore.close().ok).toBe(true);
      expect(restoredStore.close().ok).toBe(true);
    }
    expect(readFileSync(path, 'utf8')).toBe(source);
    expect(readFileSync(join(home, '.setu.json'), 'utf8')).toBe(config);
  } finally {
    rmSync(base, { force: true, recursive: true });
  }
}, 60_000);
