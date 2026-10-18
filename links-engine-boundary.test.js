import { expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
const SOURCE = /\.(?:js|ts|tsx)$/;
const TEST = /\.test\.(?:js|ts|tsx)$/;
const SQLITE_MODULE = /bun:sqlite|node:sqlite|better-sqlite|sqlite3/;
const FILE_WRITE = /writeFile|appendFile|mkdirSync|openSync|createWriteStream/;
const MAILBOX_TABLE =
  /CREATE\s+(?:VIRTUAL\s+)?TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?["`]?(?:inbox|outbox|mailbox|deliveries|message_queue|queued_messages)\b/i;

// Every non-test JavaScript or TypeScript file in the repository, including the portal UI.
function sourceFiles(directory = root, found = []) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (['.git', '.scratch', 'engines', 'node_modules'].includes(entry.name)) {
      continue;
    }
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      sourceFiles(path, found);
    } else if (SOURCE.test(entry.name) && !TEST.test(entry.name)) {
      found.push(relative(root, path));
    }
  }
  return found;
}

const files = sourceFiles();
const read = (file) => readFileSync(join(root, file), 'utf8');
const linksModules = files.filter((file) => file.startsWith('links-'));

// The engine is the only code that opens its database, and its mailbox is the only mailbox.
test('no JavaScript names the Links database, and the Links modules use no SQLite at all', () => {
  const database = ['mailbox', 'sqlite3'].join('.');
  expect(files.filter((file) => read(file).includes(database))).toEqual([]);
  expect(linksModules.length).toBeGreaterThan(0);
  expect(linksModules.filter((file) => SQLITE_MODULE.test(read(file)))).toEqual(
    []
  );
});

test('no JavaScript defines a second mailbox, queue or delivery table', () => {
  expect(files.filter((file) => MAILBOX_TABLE.test(read(file)))).toEqual([]);
});

test('the Links modules never write files themselves', () => {
  const runtime = linksModules.filter((file) => !file.includes('fixture'));
  expect(runtime.filter((file) => FILE_WRITE.test(read(file)))).toEqual([]);
});
