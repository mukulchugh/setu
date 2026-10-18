// Builds and tests the Setu Links engine with the pinned Rust toolchain (engines/links/rust-toolchain.toml).
// The cargo to run comes from SETU_LINKS_CARGO, else `cargo` on PATH. A missing toolchain is a failure: a
// check that could not run is never reported as passed.
//
//   bun links-engine.js build   release build of engines/links
//   bun links-engine.js test    Rust tests as shipped, then with the test-only hooks (kill points, clock)
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const engineDir = join(
  dirname(fileURLToPath(import.meta.url)),
  'engines/links'
);
const cargo = process.env.SETU_LINKS_CARGO ?? 'cargo';
const steps = {
  build: [['build', '--locked', '--release']],
  test: [
    ['test', '--locked'],
    [
      'test',
      '--locked',
      '--features',
      'test-hooks',
      '--target-dir',
      'target-hooks',
    ],
  ],
};

const [, , command] = process.argv;
if (!Object.hasOwn(steps, command) || process.argv.length > 3) {
  console.error('Usage: bun links-engine.js build|test');
  process.exit(2);
}

for (const step of steps[command]) {
  let status;
  try {
    status = Bun.spawnSync([cargo, ...step], {
      cwd: engineDir,
      stderr: 'inherit',
      stdout: 'inherit',
    }).exitCode;
  } catch {
    console.error(
      `Rust toolchain not found (${cargo}). Install the toolchain pinned in engines/links/rust-toolchain.toml and set SETU_LINKS_CARGO to its cargo.`
    );
    process.exit(1);
  }
  if (status !== 0) {
    console.error(`Engine ${command} failed: cargo ${step.join(' ')}`);
    process.exit(status ?? 1);
  }
}
