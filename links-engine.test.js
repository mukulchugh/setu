import { expect, test } from 'bun:test';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const driver = join(dirname(fileURLToPath(import.meta.url)), 'links-engine.js');
const run = (args, env) =>
  Bun.spawnSync(['bun', driver, ...args], {
    env: { ...process.env, ...env },
    stderr: 'pipe',
    stdout: 'pipe',
  });

test('a missing Rust toolchain fails the engine check loudly instead of passing', () => {
  for (const command of ['build', 'test']) {
    const result = run([command], { SETU_LINKS_CARGO: '/nonexistent/cargo' });
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr.toString()).toContain('Rust toolchain');
  }
});

test('an unknown engine command is refused', () => {
  const result = run(['publish'], {});
  expect(result.exitCode).not.toBe(0);
  expect(result.stderr.toString()).toContain('Usage');
});
