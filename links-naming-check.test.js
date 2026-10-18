import { afterEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { scanNaming } from './links-naming-check.js';

// Assembled so this file does not contain the names it checks for.
const inherited = ['reason', 'network'].join('-');
const roots = [];
afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { force: true, recursive: true });
  }
});

function tree(files) {
  const root = mkdtempSync(join(tmpdir(), 'links-naming-'));
  roots.push(root);
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return root;
}

test('an inherited product name in source, config, docs or env names is reported with its file', () => {
  const root = tree({
    'engines/links/Cargo.toml': `name = "${inherited.toUpperCase()}"`,
    'engines/links/src/main.rs': `std::env::var("${inherited.replace('-', '_').toUpperCase()}_HOME")`,
    'ok.js': 'const links = "setu-links";',
    'README.md': `Run ${inherited} first`,
  });
  expect(
    scanNaming({ root })
      .map((hit) => hit.file)
      .sort()
  ).toEqual([
    'README.md',
    'engines/links/Cargo.toml',
    'engines/links/src/main.rs',
  ]);
});

test('only the legal metadata is exempt, and generated output is not scanned', () => {
  const root = tree({
    'engines/links/legal/NOTICE': `This includes ${inherited}`,
    'engines/links/legal/sub/PROVENANCE.md': `${inherited}`,
    'engines/links/src/legal-notes.rs': `// ${inherited}`,
    'engines/links/target/debug/build.log': `${inherited}`,
    'node_modules/dep/index.js': `${inherited}`,
  });
  expect(scanNaming({ root }).map((hit) => hit.file)).toEqual([
    'engines/links/src/legal-notes.rs',
  ]);
});

test('the first-party source of this repository uses Setu names only', () => {
  const root = dirname(fileURLToPath(import.meta.url));
  expect(scanNaming({ root })).toEqual([]);
});
