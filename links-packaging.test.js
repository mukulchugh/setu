import { expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const TEST_FILE = /\.test\.js$/;
const JS_FILE = /\.js$/;
const linksFiles = readdirSync(root).filter((file) =>
  file.startsWith('links-')
);

test('every Links test file is in the package test script', () => {
  const tests = linksFiles.filter((file) => TEST_FILE.test(file));
  expect(tests.length).toBeGreaterThan(0);
  for (const file of tests) {
    expect(pkg.scripts.test).toContain(`./${file}`);
  }
});

test('every Links runtime module, the engine source and its legal metadata are packaged', () => {
  const runtime = linksFiles.filter(
    (file) =>
      JS_FILE.test(file) && !TEST_FILE.test(file) && !file.includes('fixture')
  );
  for (const file of runtime) {
    expect(pkg.files).toContain(file);
  }
  for (const path of [
    'engines/links/Cargo.lock',
    'engines/links/Cargo.toml',
    'engines/links/legal',
    'engines/links/rust-toolchain.toml',
    'engines/links/src',
  ]) {
    expect(pkg.files).toContain(path);
  }
});

test('the verification path builds and tests the engine before the JavaScript suite', () => {
  expect(pkg.scripts['engine:test']).toContain(' links-engine.js test');
  expect(pkg.scripts.verify.indexOf('engine:test')).toBeGreaterThanOrEqual(0);
  expect(pkg.scripts.verify.indexOf('engine:test')).toBeLessThan(
    pkg.scripts.verify.indexOf(' run test')
  );
});
