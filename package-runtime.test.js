import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const manifest = JSON.parse(
  fs.readFileSync(new URL('./package.json', import.meta.url), 'utf8')
);
const BUN_TEST_BANNER = /^bun test v\d+\.\d+\.\d+ \([a-f0-9]+\)$/;

function fixture(scripts, work) {
  const root = fs.mkdtempSync(join(tmpdir(), 'setu-package-runtime-'));
  try {
    fs.writeFileSync(join(root, 'package.json'), JSON.stringify({ scripts }));
    fs.mkdirSync(join(root, 'node_modules/.bin'), { recursive: true });
    fs.writeFileSync(
      join(root, 'node_modules/.bin/bun'),
      '#!/bin/sh\nexit 91\n',
      { mode: 0o755 }
    );
    fs.writeFileSync(
      join(root, 'report.mjs'),
      'console.log(JSON.stringify({args:process.argv.slice(2),execPath:process.execPath}));'
    );
    return work(root);
  } finally {
    fs.rmSync(root, { force: true, recursive: true });
  }
}

function run(root, script) {
  const child = spawnSync(process.execPath, ['run', '--silent', script], {
    cwd: root,
    encoding: 'utf8',
    timeout: 10_000,
  });
  expect(child.error).toBeUndefined();
  expect(child.status).toBe(0);
  const observations = child.stdout
    .trim()
    .split('\n')
    .filter((line) => !BUN_TEST_BANNER.test(line))
    .map((line) => JSON.parse(line));
  for (const row of observations) {
    expect(fs.realpathSync(row.execPath)).toBe(
      fs.realpathSync(process.execPath)
    );
  }
  return observations;
}

test('typecheck retains the launching Bun despite a dependency binary with the same name', () => {
  fixture({ typecheck: manifest.scripts.typecheck }, (root) => {
    const target = join(root, 'node_modules/typescript/bin/tsc');
    fs.mkdirSync(join(target, '..'), { recursive: true });
    fs.copyFileSync(join(root, 'report.mjs'), target);
    expect(run(root, 'typecheck').map((row) => row.args)).toEqual([
      ['--noEmit', '-p', 'tsconfig.json'],
      ['--noEmit', '-p', 'raycast/tsconfig.json'],
      ['--noEmit', '-p', 'tsconfig.backend.json'],
    ]);
  });
});

test('nested verification retains Bun and engine, test, types ordering', () => {
  fixture(
    {
      'engine:test': '"$npm_execpath" report.mjs engine',
      test: '"$npm_execpath" report.mjs test',
      typecheck: '"$npm_execpath" report.mjs types',
      verify: manifest.scripts.verify,
    },
    (root) => {
      expect(run(root, 'verify').map((row) => row.args)).toEqual([
        ['engine'],
        ['test'],
        ['types'],
      ]);
    }
  );
});

test('the complete test script keeps the launching Bun for bare child calls and standalone checks', () => {
  fixture({ test: manifest.scripts.test }, (root) => {
    const files = [
      ...manifest.scripts.test.matchAll(/\.\/([\w.-]+\.test\.[jt]sx?)/g),
    ].map((match) => match[1]);
    expect(files.length).toBeGreaterThan(200);
    for (const file of files) {
      fs.writeFileSync(join(root, file), '');
    }
    fs.writeFileSync(
      join(root, files[0]),
      `
import { expect, test } from 'bun:test';
test('nested bare Bun retains the selected interpreter', () => {
  const child = Bun.spawnSync(['bun', 'report.mjs', 'nested']);
  expect(child.exitCode).toBe(0);
  process.stdout.write(child.stdout);
});
`
    );
    for (const file of ['agent.test.js', 'lib.agent-compose.test.js']) {
      fs.copyFileSync(join(root, 'report.mjs'), join(root, file));
    }
    expect(run(root, 'test').map((row) => row.args)).toEqual([
      ['nested'],
      [],
      [],
    ]);
  });
});
