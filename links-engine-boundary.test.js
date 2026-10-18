import { expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MAILBOX_FILE } from './links-client.js';

const root = dirname(fileURLToPath(import.meta.url));
const RUST_DATABASE = /const DATABASE: &str = "([^"]+)";/;
const MAILBOX_FILE_USE = /\bMAILBOX_FILE\b/;
const MAILBOX_PATH_USE = /\bmailboxFile\b/g;
const SOURCE = /\.(?:js|ts|tsx)$/;
const TEST = /\.test\.(?:js|ts|tsx)$/;
// A SQLite module specifier (the `sqlite3` package is named in quotes), not the engine's file name.
const SQLITE_MODULE = /bun:sqlite|node:sqlite|better-sqlite|['"]sqlite3['"]/;
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

// The engine is the only code that opens its database, and its mailbox is the only mailbox. The one place that
// may name the file is the client module, as the engine's path contract: the runtime checks, without opening
// anything, whether that file exists before it starts a lifecycle publication (links-lifecycle-race.test.js pins the
// name to the real engine by finding the file there after a first send).
test('only the Links client names the Links database, and the Links modules use no SQLite at all', () => {
  const database = ['mailbox', 'sqlite3'].join('.');
  expect(files.filter((file) => read(file).includes(database))).toEqual([
    'links-client.js',
  ]);
  expect(linksModules.length).toBeGreaterThan(0);
  expect(linksModules.filter((file) => SQLITE_MODULE.test(read(file)))).toEqual(
    []
  );
});

test("the client's mailbox file name is the engine's own, and the runtime uses it for one existence check only", () => {
  const engine = readFileSync(join(root, 'engines/links/src/store.rs'), 'utf8');
  const declared = RUST_DATABASE.exec(engine)?.[1];
  expect(declared).toBeDefined();
  expect(MAILBOX_FILE).toBe(declared);
  // Metadata only: the name is read by the client module and used by exactly one other module, which asks the
  // filesystem whether the file exists. Nothing opens, reads, writes or creates it.
  const users = files.filter((file) => MAILBOX_FILE_USE.test(read(file)));
  expect(users.sort()).toEqual(['links-client.js', 'links-runtime.js']);
  const runtime = read('links-runtime.js');
  expect(runtime.match(MAILBOX_PATH_USE)).toHaveLength(2);
  expect(runtime).toContain('const mailboxFile = join(root, MAILBOX_FILE);');
  expect(runtime).toContain('existsSync(mailboxFile)');
});

test('no JavaScript defines a second mailbox, queue or delivery table', () => {
  expect(files.filter((file) => MAILBOX_TABLE.test(read(file)))).toEqual([]);
});

test('the Links modules never write files themselves', () => {
  const runtime = linksModules.filter((file) => !file.includes('fixture'));
  expect(runtime.filter((file) => FILE_WRITE.test(read(file)))).toEqual([]);
});
