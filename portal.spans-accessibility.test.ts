import { test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

test('accessibility fixtures do not mock components in the shared test process', () => {
  const fixturePath = join(
    import.meta.dir,
    'portal.spans-accessibility.fixture.ts'
  );
  const result = spawnSync(process.execPath, [fixturePath], {
    cwd: import.meta.dir,
    encoding: 'utf8',
    timeout: 30_000,
  });

  if (result.error || result.status !== 0 || result.stderr !== '') {
    throw new Error(
      [
        `The isolated accessibility fixture failed (exit ${result.status ?? 'unknown'}${result.signal ? `, signal ${result.signal}` : ''}).`,
        result.error?.message,
        result.stdout && `stdout:\n${result.stdout}`,
        result.stderr && `stderr:\n${result.stderr}`,
      ]
        .filter(Boolean)
        .join('\n')
    );
  }
});
