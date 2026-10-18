// Test support: builds the real Setu Links engine and gives each test its own data directory.
// A missing toolchain fails loudly; it never skips.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ENGINE_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  'engines/links'
);
const built = new Map();

// The shipped build (no test hooks) and the test-hooks build, which can be killed at commit points.
export function ensureEngine({ hooks = false } = {}) {
  const key = hooks ? 'hooks' : 'plain';
  if (built.has(key)) {
    return built.get(key);
  }
  const targetDir = hooks ? 'target-hooks' : 'target';
  const result = Bun.spawnSync(
    [
      process.env.SETU_LINKS_CARGO ?? 'cargo',
      'build',
      '--locked',
      '--quiet',
      '--target-dir',
      join(ENGINE_DIR, targetDir),
      ...(hooks ? ['--features', 'test-hooks'] : []),
    ],
    { cwd: ENGINE_DIR, stderr: 'pipe', stdout: 'pipe' }
  );
  if (result.exitCode !== 0) {
    throw new Error(
      `The Setu Links engine did not build (exit ${result.exitCode}): ${result.stderr.toString().slice(-2000)}`
    );
  }
  const path = join(ENGINE_DIR, targetDir, 'debug/setu-links');
  built.set(key, path);
  return path;
}

export function temporaryLinksRoot() {
  const root = mkdtempSync(join(tmpdir(), 'setu-links-js-'));
  return {
    cleanup: () => rmSync(root, { force: true, recursive: true }),
    root,
  };
}
