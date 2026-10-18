// A mailbox written by the first engine release candidate (schema 1) under a portal that is then restarted
// on the current code: passive reads work and write nothing, and the first real turn upgrades it and
// delivers the old message. Contract test with a recorded payload and a fixture process.
import { Database } from 'bun:sqlite';
import { afterEach, expect, test } from 'bun:test';
import { chmodSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { canonicalCheckout } from './links-service.js';
import { cleanupFixtures, turnFixture } from './links-turn-fixture.js';

afterEach(cleanupFixtures);

const token = 'launch_token_alpha_1234567890';

// The schema exactly as the first release candidate created it, with its CHECK, indexes, triggers and
// foreign keys. It is read from the one frozen copy the Rust upgrade and crash tests share, so there is no
// second hand-written version to drift (JS cannot import Rust, but it can read the same text).
function frozenSchema1() {
  const source = readFileSync(
    join(import.meta.dir, 'engines/links/tests/common/mod.rs'),
    'utf8'
  );
  const start = source.indexOf('pub const SCHEMA_1: &str = "');
  const body = source.slice(
    start + 'pub const SCHEMA_1: &str = "'.length,
    source.indexOf('\n";', start)
  );
  return body;
}
const SCHEMA_1 = frozenSchema1();

function seedEarlierStore(dataDir, { checkout, nativeId, sessionId }) {
  mkdirSync(dataDir, { mode: 0o700, recursive: true });
  chmodSync(dataDir, 0o700);
  const path = join(dataDir, 'mailbox.sqlite3');
  const db = new Database(path, { create: true });
  db.exec('PRAGMA journal_mode = WAL');
  db.exec(SCHEMA_1);
  db.run(
    "INSERT INTO messages VALUES ('m_old', 'user', 'k-old', 'digest', 'message', 'sent before the upgrade', 23, NULL, NULL, NULL, 'claude-code', ?, ?, ?, 1000)",
    [nativeId, checkout, sessionId]
  );
  db.run(
    "INSERT INTO deliveries (message_id, state, expires_at, updated_at) VALUES ('m_old', 'queued', 4102444800000, 1000)"
  );
  db.exec('PRAGMA user_version = 1');
  db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  db.close();
  chmodSync(path, 0o600);
  return path;
}

const userVersion = (path) => {
  const db = new Database(path, { readonly: true });
  const { user_version: version } = db.query('PRAGMA user_version').get();
  db.close();
  return version;
};

test('the earlier schema used here is the original: its CHECK, indexes, triggers and foreign keys are all present', () => {
  expect(SCHEMA_1).toContain('CHECK (state IN');
  expect(SCHEMA_1).toContain('CREATE INDEX messages_recipient');
  expect(SCHEMA_1).toContain('CREATE INDEX messages_session');
  expect(SCHEMA_1).toContain('CREATE INDEX deliveries_state');
  expect(SCHEMA_1).toContain('CREATE TRIGGER messages_immutable');
  expect(SCHEMA_1).toContain('CREATE TRIGGER messages_permanent');
  expect(SCHEMA_1.match(/REFERENCES/g)).toHaveLength(3);
  const db = new Database(':memory:');
  db.exec(SCHEMA_1);
  const objects = db
    .query(
      "SELECT type, name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'"
    )
    .all();
  db.close();
  expect(
    objects
      .filter((o) => o.type === 'trigger')
      .map((o) => o.name)
      .sort()
  ).toEqual(['messages_immutable', 'messages_permanent']);
  expect(
    objects.filter((o) => o.type === 'index').length
  ).toBeGreaterThanOrEqual(3);
});

test('an earlier-schema mailbox is read passively, then upgraded by the first turn that delivers its mail', async () => {
  const f = await turnFixture();
  await f.startSession({
    id: 'session-a',
    nativeId: 'native-a',
    pid: 501,
    token,
  });
  const record = (await f.sessions())['session-a'];
  const path = seedEarlierStore(f.dataDir, {
    checkout: canonicalCheckout(record.checkoutIdentity),
    nativeId: 'native-a',
    sessionId: 'session-a',
  });
  f.restart();
  const before = readFileSync(path);

  const inbox = await f.links.inbox({
    name: 'topic',
    repo: 'repo',
    sessionId: 'session-a',
  });
  expect(inbox.messages.map((m) => [m.messageId, m.state])).toEqual([
    ['m_old', 'queued'],
  ]);
  expect((await f.status('m_old')).recipient.currentSessionId).toBe(
    'session-a'
  );
  expect(readFileSync(path).equals(before)).toBe(true);
  expect(userVersion(path)).toBe(1);

  const turn = await f.turn('session-a', { nativeId: 'native-a', token });
  expect(turn.stdout).toContain('sent before the upgrade');
  expect(await f.stateOf('m_old')).toBe('handed-off');
  // The turn publishes its binding before it claims, and that write is what migrates the mailbox (to the
  // transport schema, which includes the directory schema before it).
  expect(userVersion(path)).toBe(3);
  expect(
    (await f.turn('session-a', { nativeId: 'native-a', token })).stdout
  ).toBe('');
});
