// Test support: builds the real Setu Links engine and gives each test its own data directory.
// A missing toolchain fails loudly; it never skips.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isServeCommand } from './links-transport.js';

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

// Daemons a test started, by the process ID it recorded, the engine it ran and the directory it served. A test may
// stop only these, and only while the process is exactly that engine serving exactly that directory.
const started = new Map();

export function trackDaemon(pid, dataDir, enginePath) {
  started.set(pid, { dataDir, enginePath });
}

function commandLine(pid) {
  const shown = Bun.spawnSync(['ps', '-p', String(pid), '-o', 'command='], {
    stderr: 'ignore',
    stdout: 'pipe',
  });
  return shown.exitCode === 0 ? shown.stdout.toString().trim() : '';
}

// The same exact command-line test production uses, not a substring: a sibling directory is not this one.
const stillOurs = (pid, { dataDir, enginePath }) =>
  isServeCommand(commandLine(pid), enginePath, dataDir);

// Runs after every test, whatever the test did or failed to do (a refused stop, a thrown assertion).
export async function reapDaemons() {
  for (const [pid, recorded] of [...started]) {
    started.delete(pid);
    if (!stillOurs(pid, recorded)) {
      continue;
    }
    try {
      process.kill(pid, 'SIGTERM');
    } catch {
      continue;
    }
    for (
      let waited = 0;
      waited < 3000 && stillOurs(pid, recorded);
      waited += 50
    ) {
      // biome-ignore lint/performance/noAwaitInLoops: Waiting for one process to leave.
      await Bun.sleep(50);
    }
    if (stillOurs(pid, recorded)) {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        // Already gone.
      }
    }
  }
}
