import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const SPANS_ENTRY_MODULES = [
  'spans-cmux-store.js',
  'spans-import.js',
  'spans-history-import.js',
  'spans-import-runtime.js',
  'spans-integration-adapters.js',
  'spans-integration-runtime.js',
  'spans-integration-state.js',
  'spans-client-integrations.js',
  'spans-maintenance-command.js',
  'spans-maintenance-runtime.js',
  'spans-runtime.js',
  'spans-execution.js',
  'spans-execution-runtime.js',
];

const LOCAL_IMPORT = /(?:\bfrom\s*|\bimport\s*(?:\(\s*)?)['"](\.[^'"]+)['"]/g;
const FIXTURE_SOURCE = /(?:fixture|\.test)\.js$/i;

function assertNoFixtureDependencies(root) {
  const pending = [...SPANS_ENTRY_MODULES];
  const visited = new Set();
  while (pending.length > 0) {
    const file = pending.pop();
    if (visited.has(file)) {
      continue;
    }
    visited.add(file);
    const source = readFileSync(join(root, file), 'utf8');
    for (const match of source.matchAll(LOCAL_IMPORT)) {
      const dependency = normalize(join(dirname(file), match[1]));
      expect(dependency).not.toMatch(FIXTURE_SOURCE);
      if (existsSync(join(root, dependency))) {
        pending.push(dependency);
      }
    }
  }
}

test('packaged Spans runtimes load offline and the maintenance child reports a missing archive', () => {
  const packageRoot = fileURLToPath(new URL('.', import.meta.url));
  const manifest = JSON.parse(
    readFileSync(join(packageRoot, 'package.json'), 'utf8')
  );
  const destination = mkdtempSync(join(tmpdir(), 'setu-spans-package-'));

  try {
    copyFileSync(
      join(packageRoot, 'package.json'),
      join(destination, 'package.json')
    );
    for (const file of manifest.files) {
      if (file === 'claude-plugin') {
        cpSync(join(packageRoot, file), join(destination, file), {
          recursive: true,
        });
      } else if (file.endsWith('.js') && !file.includes('/')) {
        copyFileSync(join(packageRoot, file), join(destination, file));
      }
    }

    expect(
      SPANS_ENTRY_MODULES.every((file) => manifest.files.includes(file))
    ).toBe(true);
    expect(
      existsSync(join(destination, 'claude-plugin/skills/setu-spans/SKILL.md'))
    ).toBe(true);
    expect(existsSync(join(destination, 'spans-maintenance-child.js'))).toBe(
      true
    );
    expect(existsSync(join(destination, 'node_modules'))).toBe(false);
    assertNoFixtureDependencies(destination);

    const imports = SPANS_ENTRY_MODULES.map(
      (file) => `await import('./${file}');`
    ).join('\n');
    const loaded = spawnSync(
      process.execPath,
      [
        '--eval',
        `import { join } from 'node:path';
${imports}
const { createSpansMaintenanceRuntime } = await import('./spans-maintenance-runtime.js');
const root = join(process.cwd(), 'missing-archive');
const destination = join(process.cwd(), 'backup-not-created');
const runtime = createSpansMaintenanceRuntime({ root });
const result = await runtime.backup({ destination });
await runtime.close();
console.log(JSON.stringify({ code: result.code, error: result.error, ok: result.ok }));`,
      ],
      {
        cwd: destination,
        encoding: 'utf8',
        env: { ...process.env, NODE_PATH: '' },
        timeout: 30_000,
      }
    );

    expect(loaded.error).toBeUndefined();
    expect(loaded.status).toBe(0);
    expect(loaded.stderr).toBe('');
    expect(JSON.parse(loaded.stdout)).toEqual({
      code: 'SPANS_BACKUP_SOURCE_UNAVAILABLE',
      error: 'The source archive was not found.',
      ok: false,
    });
    expect(existsSync(join(destination, 'missing-archive'))).toBe(false);
    expect(existsSync(join(destination, 'backup-not-created'))).toBe(false);
  } finally {
    rmSync(destination, { force: true, recursive: true });
  }
});
