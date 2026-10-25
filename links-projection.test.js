import { Database } from 'bun:sqlite';
import { afterEach, describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLinksAssociations } from './links-associations.js';
import { associationIdOf, projectionKeyOf } from './links-history.js';
import {
  createFakeEngine,
  engineMessage,
  STORE_ID,
} from './links-projection.engine-fixture.js';
import { createLinksProjection } from './links-projection.js';
import { createSpansDrafts } from './spans-drafts.js';
import { openSpansStore } from './spans-store.js';

const LINKS_CODE = /^LINKS_/;
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

function fixture({ engine = createFakeEngine(), wrapStore = (s) => s } = {}) {
  const root = fs.mkdtempSync(join(tmpdir(), 'setu-links-proj-'));
  roots.push(root);
  const store = openSpansStore({ root });
  stores.push(store);
  const drafts = createSpansDrafts({ store });
  const associations = createLinksAssociations({
    isKnownOrigin: () => true,
    store,
  });
  const projection = createLinksProjection({
    associations,
    engine,
    store: wrapStore(store),
  });
  return { associations, drafts, engine, projection, root, store };
}

const newRun = (drafts, runId = 'run-1') =>
  expect(
    drafts.createRun({
      goal: 'Ship it',
      owner: 'codex',
      runId,
      spans: [{ dependencies: [], spanId: 'plan', title: 'Plan' }],
    }).ok
  ).toBe(true);

const target = (patch = {}) => ({
  hint: 'run-1',
  origin: 'local',
  runId: 'run-1',
  ...patch,
});
function approve(associations, patch) {
  const { review } = associations.preview(target(patch));
  const result = associations.approve({
    ...target(patch),
    confirmation: review.token,
  });
  expect(result.ok).toBe(true);
}
const revokeAll = (associations, patch) =>
  expect(associations.revoke(target(patch)).ok).toBe(true);

const allEvents = (store, runId = 'run-1') => {
  const found = [];
  let afterSequence = 0;
  for (;;) {
    const page = store.readEvents({ afterSequence, limit: 200, runId });
    found.push(...page.events);
    if (!page.hasMore) {
      return found;
    }
    afterSequence = page.nextSequence;
  }
};
const linkEvents = (store, runId = 'run-1') =>
  allEvents(store, runId).filter(
    (e) => e.type === 'links.message' || e.type === 'links.status'
  );
const types = (store, runId) => linkEvents(store, runId).map((e) => e.type);
const cursorOffset = (store, patch = {}) =>
  store.readSourceCursor(
    projectionKeyOf({
      associationId: associationIdOf(target(patch)),
      storeId: STORE_ID,
    })
  ).offset;

describe('projecting an approved run-linked message', () => {
  test('send, approve, project: the message appears once with its status', async () => {
    const { associations, drafts, engine, projection, store } = fixture();
    newRun(drafts);
    engine.record('m_1', engineMessage(), 'queued');
    approve(associations);

    const result = await projection.runOnce({ maxBatches: 5 });
    expect(result).toMatchObject({ complete: true, ok: true });
    expect(result.associations).toEqual([
      expect.objectContaining({
        pending: false,
        projected: 2,
        runId: 'run-1',
        state: 'ok',
      }),
    ]);
    expect(types(store)).toEqual(['links.message', 'links.status']);
    expect(cursorOffset(store)).toBe(1);
  });

  test('mail sent before the approval is projected too; approval order does not matter', async () => {
    const early = fixture();
    newRun(early.drafts);
    early.engine.record('m_1', engineMessage(), 'queued');
    early.engine.record('m_1', engineMessage(), 'handed-off', { first: false });
    approve(early.associations);
    await early.projection.runOnce({ maxBatches: 5 });

    const late = fixture();
    newRun(late.drafts);
    approve(late.associations);
    await late.projection.runOnce({ maxBatches: 5 });
    expect(types(late.store)).toEqual([]);
    late.engine.record('m_1', engineMessage(), 'queued');
    late.engine.record('m_1', engineMessage(), 'handed-off', { first: false });
    await late.projection.runOnce({ maxBatches: 5 });

    expect(types(early.store)).toEqual(types(late.store));
    expect(linkEvents(early.store).map((e) => e.eventId)).toEqual(
      linkEvents(late.store).map((e) => e.eventId)
    );
  });

  test('a status change is a new immutable event, never a second message row', async () => {
    const { associations, drafts, engine, projection, store } = fixture();
    newRun(drafts);
    engine.record('m_1', engineMessage(), 'queued');
    approve(associations);
    await projection.runOnce({ maxBatches: 5 });
    const before = linkEvents(store);

    engine.record('m_1', engineMessage(), 'handoff-unknown', { first: false });
    engine.record('m_1', engineMessage(), 'handed-off', { first: false });
    await projection.runOnce({ maxBatches: 5 });
    const after = linkEvents(store);

    expect(types(store)).toEqual([
      'links.message',
      'links.status',
      'links.status',
      'links.status',
    ]);
    // Earlier events are exactly as they were.
    expect(after.slice(0, before.length)).toEqual(before);
    expect(after.filter((e) => e.type === 'links.message')).toHaveLength(1);
    expect(after.map((e) => e.payload.state ?? null)).toEqual([
      null,
      'queued',
      'handoff-unknown',
      'handed-off',
    ]);
  });

  test('running again with nothing new writes nothing', async () => {
    const { associations, drafts, engine, projection, store } = fixture();
    newRun(drafts);
    engine.record('m_1', engineMessage(), 'queued');
    approve(associations);
    await projection.runOnce({ maxBatches: 5 });
    const before = allEvents(store);
    const second = await projection.runOnce({ maxBatches: 5 });
    expect(second.associations[0]).toMatchObject({
      pending: false,
      projected: 0,
    });
    expect(allEvents(store)).toEqual(before);
  });
});

describe('what is never attached', () => {
  test('unapproved, unknown, other-origin and revoked hints project nothing', async () => {
    const { associations, drafts, engine, projection, store } = fixture();
    newRun(drafts);
    engine.record(
      'm_unapproved',
      engineMessage({ run_hint: 'run-9' }),
      'queued'
    );
    engine.record('m_peer', engineMessage({ origin: 'peer-A' }), 'queued');
    engine.record('m_unknown', engineMessage({ run_hint: 'nope' }), 'queued');
    expect((await projection.runOnce({ maxBatches: 5 })).associations).toEqual(
      []
    );
    expect(types(store)).toEqual([]);

    approve(associations);
    await projection.runOnce({ maxBatches: 5 });
    // Only the local origin's message for run-1 is there; the peer's identical hint is not.
    expect(linkEvents(store).map((e) => e.payload.messageId)).toEqual([]);
    engine.record('m_mine', engineMessage(), 'queued');
    await projection.runOnce({ maxBatches: 5 });
    expect(linkEvents(store).map((e) => e.payload.messageId)).toEqual([
      'm_mine',
      'm_mine',
    ]);

    revokeAll(associations);
    engine.record('m_after', engineMessage(), 'queued');
    expect((await projection.runOnce({ maxBatches: 5 })).associations).toEqual(
      []
    );
    expect(
      linkEvents(store).filter((e) => e.payload.messageId === 'm_after')
    ).toEqual([]);
  });

  test('identical hints from two origins attach only to their own association', async () => {
    const { associations, drafts, engine, projection, store } = fixture();
    newRun(drafts);
    engine.record('m_local', engineMessage(), 'queued');
    engine.record('m_peer', engineMessage({ origin: 'peer-A' }), 'queued');
    approve(associations, { origin: 'peer-A' });
    await projection.runOnce({ maxBatches: 5 });
    expect(new Set(linkEvents(store).map((e) => e.payload.messageId))).toEqual(
      new Set(['m_peer'])
    );
    approve(associations);
    await projection.runOnce({ maxBatches: 5 });
    expect(new Set(linkEvents(store).map((e) => e.payload.messageId))).toEqual(
      new Set(['m_peer', 'm_local'])
    );
  });

  test('a stale plan generation stops the projection until it is approved again', async () => {
    const { associations, drafts, engine, projection, store } = fixture();
    newRun(drafts);
    approve(associations);
    engine.record('m_1', engineMessage(), 'queued');
    await projection.runOnce({ maxBatches: 5 });
    const read = store.readRun({ runId: 'run-1' });
    expect(
      drafts.revisePlan({
        expectedGeneration: read.generation,
        expectedRevision: read.revision,
        goal: 'Revised',
        runId: 'run-1',
        spans: [{ dependencies: [], spanId: 'plan', title: 'Plan 2' }],
      }).ok
    ).toBe(true);

    engine.record('m_2', engineMessage(), 'queued');
    const result = await projection.runOnce({ maxBatches: 5 });
    expect(result.associations).toEqual([]);
    expect(
      linkEvents(store).filter((e) => e.payload.messageId === 'm_2')
    ).toEqual([]);

    approve(associations);
    await projection.runOnce({ maxBatches: 5 });
    expect(
      linkEvents(store).filter((e) => e.payload.messageId === 'm_2')
    ).toHaveLength(2);
    // Reapproval at a new generation never re-writes history differently.
    expect(
      linkEvents(store).filter((e) => e.payload.messageId === 'm_1')
    ).toHaveLength(2);
  });

  test('a revocation that lands after the association was listed stops that very batch', async () => {
    const { associations, drafts, engine, store } = fixture();
    newRun(drafts);
    engine.record('m_1', engineMessage(), 'queued');
    approve(associations);
    const racing = createLinksProjection({
      associations,
      engine,
      store: {
        commitImport: (input) => {
          revokeAll(associations);
          return store.commitImport(input);
        },
        readRun: store.readRun,
        readSourceCursor: store.readSourceCursor,
      },
    });
    const result = await racing.runOnce({ maxBatches: 5 });
    expect(result.associations[0]).toMatchObject({
      code: 'LINKS_ASSOCIATION_STALE',
      pending: true,
      state: 'stale',
    });
    expect(types(store)).toEqual([]);
    expect(cursorOffset(store)).toBe(0);
  });

  test('a plan revision that lands after the association was listed stops that very batch', async () => {
    const { associations, drafts, engine, store } = fixture();
    newRun(drafts);
    engine.record('m_1', engineMessage(), 'queued');
    approve(associations);
    const racing = createLinksProjection({
      associations,
      engine,
      store: {
        commitImport: (input) => {
          const read = store.readRun({ runId: 'run-1' });
          drafts.revisePlan({
            expectedGeneration: read.generation,
            expectedRevision: read.revision,
            goal: 'Revised',
            runId: 'run-1',
            spans: [{ dependencies: [], spanId: 'plan', title: 'Plan 2' }],
          });
          return store.commitImport(input);
        },
        readRun: store.readRun,
        readSourceCursor: store.readSourceCursor,
      },
    });
    expect(
      (await racing.runOnce({ maxBatches: 5 })).associations[0].state
    ).toBe('stale');
    expect(types(store)).toEqual([]);
    expect(cursorOffset(store)).toBe(0);
  });

  test('a revocation that lands while the engine is still answering writes nothing', async () => {
    const { associations, drafts, engine, projection, store } = fixture();
    newRun(drafts);
    engine.record('m_1', engineMessage(), 'queued');
    approve(associations);
    engine.duringNextReply(() => undefined); // the probe
    engine.duringNextReply(() => revokeAll(associations)); // the page read
    const result = await projection.runOnce({ maxBatches: 5 });
    expect(result.associations[0]).toMatchObject({
      code: 'LINKS_ASSOCIATION_STALE',
      state: 'stale',
    });
    expect(types(store)).toEqual([]);
    expect(cursorOffset(store)).toBe(0);
  });

  test('a plan revision that lands while the engine is still answering writes nothing', async () => {
    const { associations, drafts, engine, projection, store } = fixture();
    newRun(drafts);
    engine.record('m_1', engineMessage(), 'queued');
    approve(associations);
    engine.duringNextReply(() => undefined);
    engine.duringNextReply(() => {
      const read = store.readRun({ runId: 'run-1' });
      expect(
        drafts.revisePlan({
          expectedGeneration: read.generation,
          expectedRevision: read.revision,
          goal: 'Revised',
          runId: 'run-1',
          spans: [{ dependencies: [], spanId: 'plan', title: 'Plan 2' }],
        }).ok
      ).toBe(true);
    });
    const result = await projection.runOnce({ maxBatches: 5 });
    expect(result.associations[0].state).toBe('stale');
    expect(types(store)).toEqual([]);
    expect(cursorOffset(store)).toBe(0);
  });

  test('a revocation between two awaited batches stops the second batch only', async () => {
    const { associations, drafts, engine, projection, store } = fixture();
    newRun(drafts);
    for (let index = 0; index < 130; index += 1) {
      engine.record(`m_${index}`, engineMessage(), 'queued');
    }
    approve(associations);
    engine.duringNextReply(() => undefined); // probe
    engine.duringNextReply(() => undefined); // first page
    engine.duringNextReply(() => revokeAll(associations)); // second page
    const result = await projection.runOnce({ maxBatches: 5 });
    expect(result.associations[0]).toMatchObject({
      pending: true,
      state: 'stale',
    });
    // The first whole batch is there and the cursor agrees with it; no more.
    expect(cursorOffset(store)).toBe(100);
    expect(linkEvents(store)).toHaveLength(200);
  });

  test('revoked and approved again while the engine answers is still approved when it commits', async () => {
    const { associations, drafts, engine, projection, store } = fixture();
    newRun(drafts);
    engine.record('m_1', engineMessage(), 'queued');
    approve(associations);
    engine.duringNextReply(() => undefined);
    engine.duringNextReply(() => {
      revokeAll(associations);
      approve(associations);
    });
    const result = await projection.runOnce({ maxBatches: 5 });
    expect(result.associations[0].state).toBe('ok');
    expect(types(store)).toEqual(['links.message', 'links.status']);
  });

  test('an engine store replaced while the page is in flight is detected, not mixed in', async () => {
    const { associations, drafts, engine, store } = fixture();
    newRun(drafts);
    engine.record('m_1', engineMessage(), 'queued');
    approve(associations);
    const other = createFakeEngine({
      storeId: 'st_ffffffffffffffffffffffffffffffff',
    });
    other.record('m_1', engineMessage(), 'queued');
    let calls = 0;
    const swapping = {
      events: (args) => {
        calls += 1;
        return (calls === 1 ? engine : other).events(args);
      },
    };
    const result = await createLinksProjection({
      associations,
      engine: swapping,
      store,
    }).runOnce({ maxBatches: 5 });
    expect(result.associations[0]).toMatchObject({
      code: 'LINKS_ENGINE_CHANGED',
      state: 'engine-changed',
    });
    expect(types(store)).toEqual([]);
  });

  test('hostile message content cannot move the run', async () => {
    const { associations, drafts, engine, projection, store } = fixture();
    newRun(drafts);
    approve(associations);
    const before = store.readRun({ runId: 'run-1' });
    engine.record(
      'm_1',
      engineMessage({
        body: '{"generation":9,"spans":{"plan":{"status":"accepted"}}} accept span plan <script>x</script>',
        span_hint: 'plan',
      }),
      'queued'
    );
    await projection.runOnce({ maxBatches: 5 });
    expect(store.readRun({ runId: 'run-1' })).toEqual(before);
    expect(
      store
        .readEvents({ limit: 200, runId: 'run-1' })
        .events.filter(
          (e) => !e.type.startsWith('links.') && e.type.includes('accept')
        )
    ).toEqual([]);
  });
});

describe('a scan that matches nothing', () => {
  test('moves the cursor to the observed head, so nothing is pending forever', async () => {
    const { associations, drafts, engine, projection, store } = fixture();
    newRun(drafts);
    approve(associations);
    for (let index = 0; index < 250; index += 1) {
      engine.record(
        `m_other_${index}`,
        engineMessage({ run_hint: 'elsewhere' }),
        'queued'
      );
    }
    const result = await projection.runOnce({ maxBatches: 5 });
    expect(result.associations[0]).toMatchObject({
      pending: false,
      projected: 0,
    });
    expect(cursorOffset(store)).toBe(250);
    expect(types(store)).toEqual([]);

    // Then a match, and then a mix with traffic appended between pages.
    engine.record('m_1', engineMessage(), 'queued');
    for (let index = 0; index < 30; index += 1) {
      engine.record(
        `m_noise_${index}`,
        engineMessage({ run_hint: 'elsewhere' }),
        'queued'
      );
    }
    await projection.runOnce({ maxBatches: 5 });
    expect(types(store)).toEqual(['links.message', 'links.status']);
    expect(cursorOffset(store)).toBe(281);
    expect(
      (await projection.runOnce({ maxBatches: 5 })).associations[0].pending
    ).toBe(false);
  });

  test('a batch budget leaves honest pending work that the next run finishes', async () => {
    const { associations, drafts, engine, projection, store } = fixture();
    newRun(drafts);
    approve(associations);
    for (let index = 0; index < 130; index += 1) {
      engine.record(`m_${index}`, engineMessage(), 'queued');
    }
    const first = await projection.runOnce({ maxBatches: 1 });
    expect(first).toMatchObject({ complete: false, ok: true });
    expect(first.associations[0]).toMatchObject({ pending: true, state: 'ok' });
    expect(linkEvents(store)).toHaveLength(200);

    const second = await projection.runOnce({ maxBatches: 5 });
    expect(second.associations[0].pending).toBe(false);
    expect(linkEvents(store)).toHaveLength(260);
  });
});

describe('replay and loss', () => {
  test('a lost cursor replays into identical events, with no duplicate', async () => {
    const { associations, drafts, engine, projection, root, store } = fixture();
    newRun(drafts);
    engine.record('m_1', engineMessage(), 'queued');
    engine.record('m_1', engineMessage(), 'handed-off', { first: false });
    approve(associations);
    await projection.runOnce({ maxBatches: 5 });
    const once = allEvents(store);

    const db = new Database(join(root, 'spans.sqlite3'));
    db.run('DELETE FROM spans_sources');
    db.close();
    expect(cursorOffset(store)).toBe(0);

    const result = await projection.runOnce({ maxBatches: 5 });
    expect(result.associations[0].state).toBe('ok');
    expect(allEvents(store)).toEqual(once);
    expect(cursorOffset(store)).toBe(2);
  });

  test('revoke, then approve again at the same or a new generation, never conflicts', async () => {
    const { associations, drafts, engine, projection, store } = fixture();
    newRun(drafts);
    engine.record('m_1', engineMessage(), 'queued');
    approve(associations);
    await projection.runOnce({ maxBatches: 5 });
    revokeAll(associations);
    engine.record('m_1', engineMessage(), 'handed-off', { first: false });
    approve(associations);
    const result = await projection.runOnce({ maxBatches: 5 });
    expect(result.associations[0].state).toBe('ok');
    expect(types(store)).toEqual([
      'links.message',
      'links.status',
      'links.status',
    ]);
  });

  test('a replaced engine store starts a clean cursor and cannot collide with the old events', async () => {
    const { associations, drafts, projection, store, engine } = fixture();
    newRun(drafts);
    engine.record('m_1', engineMessage(), 'queued');
    approve(associations);
    await projection.runOnce({ maxBatches: 5 });

    const replaced = createFakeEngine({
      storeId: 'st_ffffffffffffffffffffffffffffffff',
    });
    replaced.record('m_1', engineMessage(), 'queued');
    const next = createLinksProjection({
      associations,
      engine: replaced,
      store,
    });
    expect((await next.runOnce({ maxBatches: 5 })).associations[0].state).toBe(
      'ok'
    );
    // The same message id under another store is another history, not a replay.
    expect(types(store)).toEqual([
      'links.message',
      'links.status',
      'links.message',
      'links.status',
    ]);
  });
});

describe('a worker that dies', () => {
  const killAfter =
    (method, times = 1) =>
    (store) => {
      let remaining = times;
      return {
        commitImport: (input) => {
          remaining -= 1;
          if (method === 'before' && remaining === 0) {
            throw new Error('killed before commit');
          }
          const result = store.commitImport(input);
          if (method === 'after' && remaining === 0) {
            throw new Error('killed after commit');
          }
          return result;
        },
        readRun: store.readRun,
        readSourceCursor: store.readSourceCursor,
      };
    };

  function seed(engine, count = 130) {
    for (let index = 0; index < count; index += 1) {
      engine.record(`m_${index}`, engineMessage(), 'queued');
    }
  }
  async function reference() {
    const clean = fixture();
    newRun(clean.drafts);
    seed(clean.engine);
    approve(clean.associations);
    await clean.projection.runOnce({ maxBatches: 9 });
    return linkEvents(clean.store).map((e) => e.eventId);
  }

  for (const [name, method, times] of [
    ['before the first commit', 'before', 1],
    ['after the first commit, before it returns', 'after', 1],
    ['before the second commit', 'before', 2],
    ['after the second commit', 'after', 2],
  ]) {
    test(`killed ${name}: a restart converges with no duplicate and no skip`, async () => {
      const { associations, drafts, engine, store } = fixture();
      newRun(drafts);
      seed(engine);
      approve(associations);
      const dying = createLinksProjection({
        associations,
        engine,
        store: killAfter(method, times)(store),
      });
      await expect(dying.runOnce({ maxBatches: 9 })).rejects.toThrow('killed');

      const restarted = createLinksProjection({ associations, engine, store });
      await restarted.runOnce({ maxBatches: 9 });
      expect(linkEvents(store).map((e) => e.eventId)).toEqual(
        await reference()
      );
    });
  }

  test('two workers at once: the loser re-reads its cursor and nothing is duplicated', async () => {
    const { associations, drafts, engine, projection, store } = fixture();
    newRun(drafts);
    seed(engine);
    approve(associations);
    const intruder = createLinksProjection({ associations, engine, store });
    // The intruder finishes the whole stream while the first worker's engine
    // answer is still in flight; the first worker then commits an offset the
    // archive no longer expects.
    // The first reply is the probe; the intruder lands on the page read after it.
    engine.duringNextReply(() => undefined);
    engine.duringNextReply(() => intruder.runOnce({ maxBatches: 9 }));
    const result = await projection.runOnce({ maxBatches: 9 });
    expect(result.associations[0].state).toBe('ok');
    expect(linkEvents(store).map((e) => e.eventId)).toEqual(await reference());
  });

  test('the same worker started twice at once projects each event once', async () => {
    const { associations, drafts, engine, projection, store } = fixture();
    newRun(drafts);
    seed(engine);
    approve(associations);
    const [first, second] = await Promise.all([
      projection.runOnce({ maxBatches: 9 }),
      projection.runOnce({ maxBatches: 9 }),
    ]);
    expect(first.associations[0].state).toBe('ok');
    expect(second.associations[0].state).toBe('ok');
    expect(linkEvents(store).map((e) => e.eventId)).toEqual(await reference());
  });
});

describe('failures are reported, not hidden', () => {
  test('an absent engine is not an error and writes nothing', async () => {
    const { associations, drafts, projection, store } = fixture({
      engine: createFakeEngine({ absent: true }),
    });
    newRun(drafts);
    approve(associations);
    const result = await projection.runOnce({ maxBatches: 5 });
    expect(result).toMatchObject({
      complete: true,
      engine: 'absent',
      ok: true,
    });
    expect(types(store)).toEqual([]);
  });

  test('an engine that fails is unavailable, with the cursor untouched', async () => {
    const { associations, drafts, engine, store } = fixture();
    newRun(drafts);
    engine.record('m_1', engineMessage(), 'queued');
    approve(associations);
    const broken = createLinksProjection({
      associations,
      engine: {
        events: async () => ({ code: 'LINKS_ENGINE_UNAVAILABLE', ok: false }),
      },
      store,
    });
    expect(await broken.runOnce({ maxBatches: 5 })).toMatchObject({
      engine: 'unavailable',
      ok: true,
    });
    expect(types(store)).toEqual([]);
  });

  test('a malformed engine event blocks that association and moves nothing', async () => {
    const { associations, drafts, store } = fixture();
    newRun(drafts);
    approve(associations);
    const engine = {
      events: async () => ({
        events: [{ first: true, message_id: '../bad', seq: 1 }],
        has_more: false,
        head: 1,
        next: 1,
        ok: true,
        store_id: STORE_ID,
      }),
    };
    const result = await createLinksProjection({
      associations,
      engine,
      store,
    }).runOnce({
      maxBatches: 5,
    });
    expect(result.associations[0]).toMatchObject({
      code: 'LINKS_EVENT_INVALID',
      state: 'blocked',
    });
    expect(cursorOffset(store)).toBe(0);
    expect(types(store)).toEqual([]);
  });

  test('a misrouted page is blocked atomically before any archive import', async () => {
    const peer = `peer:${'a'.repeat(64)}`;
    for (const records of [
      [['m_bad', engineMessage({ origin: peer })]],
      [['m_bad', engineMessage({ run_hint: 'other-run' })]],
      [
        ['m_good', engineMessage()],
        ['m_bad', engineMessage({ origin: peer, run_hint: 'other-run' })],
      ],
    ]) {
      const actual = createFakeEngine();
      for (const [messageId, message] of records) {
        actual.record(messageId, message, 'queued');
      }
      const engine = {
        events: ({ after, limit }) => actual.events({ after, limit }),
      };
      const { associations, drafts, projection, store } = fixture({ engine });
      newRun(drafts);
      approve(associations);

      // biome-ignore lint/performance/noAwaitInLoops: Each malformed engine has its own archive.
      const result = await projection.runOnce({ maxBatches: 5 });
      expect(result.associations[0]).toMatchObject({
        code: 'LINKS_EVENT_INVALID',
        pending: true,
        state: 'blocked',
      });
      expect(types(store)).toEqual([]);
      expect(cursorOffset(store)).toBe(0);
    }
  });

  test('a correctly filtered page still projects unchanged', async () => {
    const { associations, drafts, engine, projection, store } = fixture();
    newRun(drafts);
    engine.record('m_1', engineMessage(), 'queued');
    approve(associations);

    await projection.runOnce({ maxBatches: 5 });
    expect(types(store)).toEqual(['links.message', 'links.status']);
    expect(cursorOffset(store)).toBe(1);
  });

  test('an event id that already exists with different content blocks the association and skips nothing', async () => {
    const { associations, drafts, engine, projection, store } = fixture();
    newRun(drafts);
    engine.record('m_1', engineMessage(), 'queued');
    approve(associations);
    await projection.runOnce({ maxBatches: 5 });
    const settled = allEvents(store);

    // The same message is claimed to start again with different text, in the
    // same store: the archive refuses to rewrite history.
    const rewritten = {
      events: async () => ({
        events: [
          {
            ...engine.log[0],
            message: engineMessage({ body: 'rewritten history' }),
            seq: 2,
          },
          { ...engine.log[0], first: false, seq: 3 },
        ],
        has_more: false,
        head: 3,
        next: 3,
        ok: true,
        store_id: STORE_ID,
      }),
    };
    const result = await createLinksProjection({
      associations,
      engine: rewritten,
      store,
    }).runOnce({ maxBatches: 5 });
    expect(result.associations[0]).toMatchObject({
      code: 'LINKS_PROJECTION_CONFLICT',
      pending: true,
      state: 'blocked',
    });
    expect(cursorOffset(store)).toBe(1);
    expect(allEvents(store)).toEqual(settled);
  });
});

describe('search sees projected messages only after the explicit index', () => {
  test('coverage is reduced before indexing and a GET never builds an index', async () => {
    const { associations, drafts, engine, projection, store } = fixture();
    newRun(drafts);
    engine.record(
      'm_1',
      engineMessage({ body: 'zebrafish migration plan' }),
      'queued'
    );
    approve(associations);
    await projection.runOnce({ maxBatches: 5 });

    expect(store.searchStatus().ok).toBe(false);
    expect(store.initializeSearch().ok).toBe(true);
    const before = store.search({ limit: 10, query: 'zebrafish' });
    expect(before.coverage?.complete).toBe(false);
    expect(before.hits ?? []).toEqual([]);

    let page;
    do {
      page = store.indexSearchPage({ limit: 50 });
      expect(page.ok).toBe(true);
    } while (page.hasMore);
    const after = store.search({ limit: 10, query: 'zebrafish' });
    expect(after.coverage.complete).toBe(true);
    expect(after.hits).toHaveLength(1);
    expect(after.hits[0]).toMatchObject({ runId: 'run-1' });
  });
});

describe('projection status is passive and honest', () => {
  test('reports pending work without writing anything, then none once projected', async () => {
    const { associations, drafts, engine, projection, store } = fixture();
    newRun(drafts);
    engine.record('m_1', engineMessage(), 'queued');
    approve(associations);

    const before = allEvents(store);
    const pending = await projection.status({ runId: 'run-1' });
    expect(pending).toMatchObject({ engine: 'ok', ok: true });
    expect(pending.associations).toEqual([
      expect.objectContaining({
        engineHead: 1,
        origin: 'local',
        pending: true,
        projectedThrough: 0,
        status: 'approved',
      }),
    ]);
    expect(allEvents(store)).toEqual(before);
    expect(cursorOffset(store)).toBe(0);

    await projection.runOnce({ maxBatches: 5 });
    const done = await projection.status({ runId: 'run-1' });
    expect(done.associations[0]).toMatchObject({
      pending: false,
      projectedThrough: 1,
    });
  });

  test('a stale or revoked approval is reported as such and reads nothing from the engine', async () => {
    const { associations, drafts, engine, projection } = fixture();
    newRun(drafts);
    engine.record('m_1', engineMessage(), 'queued');
    approve(associations);
    revokeAll(associations);
    const callsBefore = engine.calls.length;
    const result = await projection.status({ runId: 'run-1' });
    expect(result.associations[0]).toMatchObject({
      pending: false,
      status: 'revoked',
    });
    // Nothing approved: the engine is not asked at all.
    expect(result).toMatchObject({ engine: 'unchecked', ok: true });
    expect(engine.calls.length - callsBefore).toBe(0);
  });

  test('a run with no approval never depends on the engine', async () => {
    const { drafts, projection } = fixture({
      engine: {
        events: async () => ({ code: 'LINKS_ENGINE_UNAVAILABLE', ok: false }),
      },
    });
    newRun(drafts);
    expect(await projection.status({ runId: 'run-1' })).toEqual({
      associations: [],
      engine: 'unchecked',
      ok: true,
    });
  });

  test('distinguishes an absent engine from an unavailable one', async () => {
    const absent = fixture({ engine: createFakeEngine({ absent: true }) });
    newRun(absent.drafts);
    approve(absent.associations);
    expect(await absent.projection.status({ runId: 'run-1' })).toMatchObject({
      engine: 'absent',
      ok: true,
    });
    const { associations, drafts, store } = fixture();
    newRun(drafts);
    approve(associations);
    const down = createLinksProjection({
      associations,
      engine: {
        events: async () => ({ code: 'LINKS_ENGINE_UNAVAILABLE', ok: false }),
      },
      store,
    });
    expect(await down.status({ runId: 'run-1' })).toMatchObject({
      engine: 'unavailable',
      ok: true,
    });
  });

  test('does not report a misrouted page as healthy', async () => {
    const actual = createFakeEngine();
    actual.record(
      'm_bad',
      engineMessage({
        origin: `peer:${'a'.repeat(64)}`,
        run_hint: 'other-run',
      }),
      'queued'
    );
    const engine = {
      events: ({ after, limit }) => actual.events({ after, limit }),
    };
    const { associations, drafts, projection, store } = fixture({ engine });
    newRun(drafts);
    approve(associations);

    expect(await projection.status({ runId: 'run-1' })).toMatchObject({
      associations: [],
      code: 'LINKS_EVENT_INVALID',
      engine: 'unavailable',
      ok: true,
    });
    expect(types(store)).toEqual([]);
    expect(cursorOffset(store)).toBe(0);
  });

  test('refuses an unknown or malformed run and an unknown run is not an empty answer', async () => {
    const { projection } = fixture();
    expect(await projection.status({ runId: 'nope' })).toMatchObject({
      code: 'LINKS_RUN_UNKNOWN',
      ok: false,
    });
    expect(await projection.status({ runId: '../x' })).toMatchObject({
      code: 'LINKS_INVALID',
      ok: false,
    });
  });
});

describe('an unreadable run is isolated', () => {
  const corrupt = (root, runId) => {
    const db = new Database(join(root, 'spans.sqlite3'));
    db.run('UPDATE spans_views SET view_json = ? WHERE run_id = ?', [
      '{not json',
      runId,
    ]);
    db.close();
  };

  test('later runs are still projected and the bad one is named, not skipped silently', async () => {
    const { associations, drafts, engine, projection, root, store } = fixture();
    newRun(drafts, 'run-1');
    newRun(drafts, 'run-2');
    approve(associations, { hint: 'run-1', runId: 'run-1' });
    approve(associations, { hint: 'run-2', runId: 'run-2' });
    engine.record('m_1', engineMessage({ run_hint: 'run-1' }), 'queued');
    engine.record('m_2', engineMessage({ run_hint: 'run-2' }), 'queued');
    corrupt(root, 'run-1');

    const result = await projection.runOnce({ maxBatches: 5 });
    expect(result.complete).toBe(false);
    expect(result.associations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: expect.stringMatching(LINKS_CODE),
          pending: true,
          runId: 'run-1',
          state: 'run-unreadable',
        }),
        expect.objectContaining({ runId: 'run-2', state: 'ok' }),
      ])
    );
    expect(types(store, 'run-2')).toEqual(['links.message', 'links.status']);
  });

  test('it never starves later runs across repeated runs and pages', async () => {
    const { associations, drafts, engine, projection, root, store } = fixture();
    for (const id of ['run-1', 'run-2', 'run-3']) {
      newRun(drafts, id);
      approve(associations, { hint: id, runId: id });
      engine.record(`m_${id}`, engineMessage({ run_hint: id }), 'queued');
    }
    corrupt(root, 'run-1');
    const small = createLinksProjection({
      associations,
      batchEvents: 100,
      engine,
      store,
    });
    for (let round = 0; round < 2; round += 1) {
      // biome-ignore lint/performance/noAwaitInLoops: Rounds are sequential by definition.
      const result = await small.runOnce({ maxBatches: 5 });
      expect(
        result.associations.filter((r) => r.state === 'run-unreadable')
      ).toHaveLength(1);
    }
    expect(types(store, 'run-2')).toEqual(['links.message', 'links.status']);
    expect(types(store, 'run-3')).toEqual(['links.message', 'links.status']);
    expect(projection).toBeDefined();
  });
});
