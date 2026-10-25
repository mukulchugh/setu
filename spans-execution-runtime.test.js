import { afterEach, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSpansExecutionRuntime } from './spans-execution-runtime.js';
import { openSpansStore, SPANS_STORE_DATABASE_FILE } from './spans-store.js';

const roots = [];
afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { force: true, recursive: true });
  }
});

function makeRoot() {
  const parent = realpathSync(
    mkdtempSync(join(tmpdir(), 'setu-exec-runtime-'))
  );
  roots.push(parent);
  return parent;
}

function runtime(archive, admission = {}) {
  return createSpansExecutionRuntime({
    admission,
    config: { spansExecution: { enabled: true } },
    resolveTarget: () => Promise.resolve(null),
    root: archive,
  });
}

test('enabled execution reads never create an archive or reopen after close', async () => {
  const archive = join(makeRoot(), 'missing');
  const execution = runtime(archive);
  const capability = await execution.services.spansExecutionCapabilities({
    profile: 'claude-code-sonnet',
  });
  expect(capability.launch.allowed).toBe(false);
  expect(
    (await execution.services.spansExecutionStatus({ runId: 'missing' })).ok
  ).toBe(false);
  expect(existsSync(archive)).toBe(false);
  await execution.close();
  expect(
    await execution.services.spansExecutionCapabilities({
      profile: 'claude-code-sonnet',
    })
  ).toEqual({ code: 'SPANS_EXEC_RUNTIME_CLOSED', ok: false });
  expect(await execution.recover()).toEqual({
    code: 'SPANS_EXEC_RUNTIME_CLOSED',
    ok: false,
  });
  expect(existsSync(archive)).toBe(false);
});

test('enabled execution reads leave an uninitialized database unchanged', async () => {
  const archive = join(makeRoot(), 'empty-archive');
  mkdirSync(archive, { mode: 0o700 });
  const database = join(archive, SPANS_STORE_DATABASE_FILE);
  writeFileSync(database, '', { mode: 0o600 });
  const execution = runtime(archive);
  expect(
    (
      await execution.services.spansExecutionCapabilities({
        profile: 'claude-code-sonnet',
      })
    ).launch.allowed
  ).toBe(false);
  expect(statSync(database).size).toBe(0);
  await execution.close();
  expect(statSync(database).size).toBe(0);
});

test('archive capacity refusal prevents the production runtime from opening for writes', () => {
  const parent = makeRoot();
  const archive = join(parent, 'archive');
  const initialized = openSpansStore({ root: archive });
  initialized.close();
  const fakeBin = join(parent, 'bin');
  mkdirSync(fakeBin);
  const child = spawnSync(
    process.execPath,
    [
      '--eval',
      `import { createSpansExecutionRuntime } from './spans-execution-runtime.js';
let admissions = 0;
const runtime = createSpansExecutionRuntime({
  admission: { withSpansArchiveWrite: async () => {
    admissions += 1;
    return { code: 'SPANS_ARCHIVE_CAPACITY_REACHED', ok: false };
  } },
  config: { spansExecution: { enabled: true } },
  resolveTarget: () => Promise.resolve(null),
  root: process.env.SETU_TEST_ARCHIVE
});
const result = await runtime.services.spansExecutionProbe({ profile: 'claude-code-sonnet' });
await runtime.close();
console.log(JSON.stringify({ admissions, result }));`,
    ],
    {
      cwd: import.meta.dir,
      encoding: 'utf8',
      env: {
        ...process.env,
        HOME: parent,
        PATH: fakeBin,
        SETU_TEST_ARCHIVE: archive,
      },
      timeout: 5000,
    }
  );
  expect(child.status).toBe(0);
  expect(child.stderr).toBe('');
  expect(JSON.parse(child.stdout)).toEqual({
    admissions: 1,
    result: {
      code: 'SPANS_EXEC_PROBE_NOT_RECORDED',
      error:
        'Probe evidence could not be recorded. Inspect the archive before another probe.',
      ok: false,
    },
  });
});
