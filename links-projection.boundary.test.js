import { afterEach, describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLinksAssociations } from './links-associations.js';
import { createLinksClient } from './links-client.js';
import { associationIdOf, projectionKeyOf } from './links-history.js';
import {
  createFakeEngine,
  engineMessage,
  STORE_ID,
} from './links-projection.engine-fixture.js';
import {
  createLinksEventsReader,
  createLinksProjection,
} from './links-projection.js';
import { createSpansDrafts } from './spans-drafts.js';
import { openSpansStore } from './spans-store.js';

// The projection composed the way production composes it: the real Links
// client starts a real child process per operation and the answer comes back
// later over a pipe. The child is a stand-in for the Rust engine's passive
// `events` operation (it speaks the setu-links/1 envelope), so these show the
// projection is correct across a genuine process round trip, not that the Rust
// engine produces these events.
const FIXTURE = join(import.meta.dir, 'links-projection.engine-fixture.js');
const roots = [];
const stores = [];
afterEach(() => {
  for (const store of stores.splice(0)) {
    store.close();
  }
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { force: true, recursive: true });
  }
});

const target = { hint: 'run-1', origin: 'local', runId: 'run-1' };

function childProgram({ delayMs = 40, log, reply }) {
  return `const { readEngineLog } = await import(${JSON.stringify(FIXTURE)});
const request = await Bun.stdin.json();
await Bun.sleep(${delayMs});
${
  reply ??
  `console.log(JSON.stringify({ protocol: 'setu-links/1', id: request.id, ok: true,
  result: readEngineLog({ args: request.args, log: ${JSON.stringify(log)}, storeId: ${JSON.stringify(STORE_ID)} }) }));`
}`;
}

function fixture({ delayMs, onSpawn, reply, timeoutMs = 5000 } = {}) {
  const root = fs.mkdtempSync(join(tmpdir(), 'setu-links-boundary-'));
  roots.push(root);
  const store = openSpansStore({ root });
  stores.push(store);
  const drafts = createSpansDrafts({ store });
  expect(
    drafts.createRun({
      goal: 'g',
      owner: 'codex',
      runId: 'run-1',
      spans: [{ dependencies: [], spanId: 'plan', title: 'Plan' }],
    }).ok
  ).toBe(true);
  const associations = createLinksAssociations({
    isKnownOrigin: () => true,
    store,
  });
  const { review } = associations.preview(target);
  expect(
    associations.approve({ ...target, confirmation: review.token }).ok
  ).toBe(true);
  const engine = createFakeEngine();
  let spawned = 0;
  const client = createLinksClient({
    dataDir: 'unused-fixture-directory',
    enginePath: process.execPath,
    spawn: (_command, options) => {
      spawned += 1;
      const child = Bun.spawn(
        [
          process.execPath,
          '-e',
          childProgram({ delayMs, log: engine.log, reply }),
        ],
        options
      );
      onSpawn?.(spawned, { associations, drafts, store });
      return child;
    },
    timeoutMs,
  });
  const projection = createLinksProjection({
    associations,
    engine: createLinksEventsReader(client),
    store,
  });
  return {
    associations,
    drafts,
    engine,
    projection,
    spawned: () => spawned,
    store,
  };
}

const linkTypes = (store) => {
  const found = [];
  let afterSequence = 0;
  for (;;) {
    const page = store.readEvents({
      afterSequence,
      limit: 200,
      runId: 'run-1',
    });
    found.push(
      ...page.events
        .map((e) => e.type)
        .filter((t) => t.startsWith('links.m') || t === 'links.status')
    );
    if (!page.hasMore) {
      return found;
    }
    afterSequence = page.nextSequence;
  }
};
const cursor = (store) =>
  store.readSourceCursor(
    projectionKeyOf({
      associationId: associationIdOf(target),
      storeId: STORE_ID,
    })
  ).offset;

describe('the events reader over the real client', () => {
  test('projects across a real child-process round trip', async () => {
    const { engine, projection, store } = fixture();
    engine.record('m_1', engineMessage(), 'queued');
    const result = await projection.runOnce({ maxBatches: 5 });
    expect(result).toMatchObject({ complete: true, engine: 'ok', ok: true });
    expect(linkTypes(store)).toEqual(['links.message', 'links.status']);
    expect(cursor(store)).toBe(1);
  });

  test('sends the wire argument names, only the filters it has', async () => {
    const seen = [];
    const reader = createLinksEventsReader({
      call: (op, args) => {
        seen.push({ args, op });
        return Promise.resolve({
          ok: true,
          result: {
            events: [],
            has_more: false,
            head: 0,
            next: 0,
            store_id: null,
          },
        });
      },
    });
    await reader.events({ after: 0, limit: 1 });
    await reader.events({
      after: 4,
      limit: 100,
      origin: 'peer-A',
      runHint: 'run-9',
    });
    expect(seen).toEqual([
      { args: { after: 0, limit: 1 }, op: 'events' },
      {
        args: { after: 4, limit: 100, origin: 'peer-A', run_hint: 'run-9' },
        op: 'events',
      },
    ]);
  });

  test('a failure reply is passed on as a failure, never as an empty page', async () => {
    const reader = createLinksEventsReader({
      call: async () => ({
        code: 'LINKS_ENGINE_UNAVAILABLE',
        error: 'x',
        ok: false,
      }),
    });
    expect(await reader.events({ after: 0, limit: 1 })).toMatchObject({
      code: 'LINKS_ENGINE_UNAVAILABLE',
      ok: false,
    });
  });
});

describe('races across the awaited child process', () => {
  test('a revocation landing while the child is answering writes nothing', async () => {
    const { associations, engine, projection, store } = fixture({
      onSpawn: (count) => {
        if (count === 2) {
          expect(associations.revoke(target).ok).toBe(true);
        }
      },
    });
    engine.record('m_1', engineMessage(), 'queued');
    const result = await projection.runOnce({ maxBatches: 5 });
    expect(result.associations[0]).toMatchObject({
      code: 'LINKS_ASSOCIATION_STALE',
      state: 'stale',
    });
    expect(linkTypes(store)).toEqual([]);
    expect(cursor(store)).toBe(0);
  });

  test('a plan revision landing while the child is answering writes nothing', async () => {
    const { engine, projection, store } = fixture({
      onSpawn: (count, { drafts, store: archive }) => {
        if (count === 2) {
          const read = archive.readRun({ runId: 'run-1' });
          expect(
            drafts.revisePlan({
              expectedGeneration: read.generation,
              expectedRevision: read.revision,
              goal: 'Revised',
              runId: 'run-1',
              spans: [{ dependencies: [], spanId: 'plan', title: 'Plan 2' }],
            }).ok
          ).toBe(true);
        }
      },
    });
    engine.record('m_1', engineMessage(), 'queued');
    const result = await projection.runOnce({ maxBatches: 5 });
    expect(result.associations[0].state).toBe('stale');
    expect(linkTypes(store)).toEqual([]);
  });

  test('the event loop is not blocked while the child works', async () => {
    const { engine, projection } = fixture({ delayMs: 120 });
    engine.record('m_1', engineMessage(), 'queued');
    let ticks = 0;
    const timer = setInterval(() => {
      ticks += 1;
    }, 10);
    await projection.runOnce({ maxBatches: 5 });
    clearInterval(timer);
    // Two round trips of ~120ms each: a blocking adapter would tick almost never.
    expect(ticks).toBeGreaterThan(8);
  });
});

describe('engine failures at the boundary', () => {
  test('a child that is too slow is unavailable, with nothing written', async () => {
    const { engine, projection, store } = fixture({
      delayMs: 2000,
      timeoutMs: 100,
    });
    engine.record('m_1', engineMessage(), 'queued');
    const result = await projection.runOnce({ maxBatches: 5 });
    expect(result).toMatchObject({
      complete: false,
      engine: 'unavailable',
      ok: true,
    });
    expect(linkTypes(store)).toEqual([]);
  });

  test('a child that dies or answers garbage is unavailable', async () => {
    for (const reply of ['process.exit(3);', "console.log('not json');"]) {
      const { engine, projection, store } = fixture({ reply });
      engine.record('m_1', engineMessage(), 'queued');
      // biome-ignore lint/performance/noAwaitInLoops: Each case builds its own child process and archive.
      const result = await projection.runOnce({ maxBatches: 5 });
      expect(result).toMatchObject({ engine: 'unavailable', ok: true });
      expect(linkTypes(store)).toEqual([]);
    }
  });

  test('a reply with an unexpected shape is refused rather than trusted', async () => {
    const reply = `console.log(JSON.stringify({ protocol: 'setu-links/1', id: request.id, ok: true,
      result: { events: [{ seq: 1, surprise: true }], has_more: false, head: 1, next: 1, store_id: ${JSON.stringify(STORE_ID)} } }));`;
    const { projection, store } = fixture({ reply });
    const result = await projection.runOnce({ maxBatches: 5 });
    expect(result).toMatchObject({ engine: 'unavailable', ok: true });
    expect(linkTypes(store)).toEqual([]);
  });

  test('an engine error envelope is reported as unavailable, not as no mail', async () => {
    const reply = `console.log(JSON.stringify({ protocol: 'setu-links/1', id: request.id, ok: false,
      error: { code: 'SCHEMA_UNSUPPORTED', message: 'newer store', retryable: false } }));`;
    const { projection } = fixture({ reply });
    expect(await projection.runOnce({ maxBatches: 5 })).toMatchObject({
      engine: 'unavailable',
      ok: true,
    });
  });
});
