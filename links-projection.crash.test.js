import { afterEach, expect, test } from 'bun:test';
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

// Real SIGKILLs of a real worker process around the archive commit. Each
// engine event here is a different first message, so a cursor of N means
// exactly 2N archive events (a message and a status per engine event): the
// cursor and the events must always agree, at whatever instant the worker dies.
const EVENTS = 450;
const fixture = join(import.meta.dir, 'links-projection.crash-fixture.js');
const target = { hint: 'run-1', origin: 'local', runId: 'run-1' };
const key = projectionKeyOf({
  associationId: associationIdOf(target),
  storeId: STORE_ID,
});

const roots = [];
afterEach(() => {
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { force: true, recursive: true });
  }
});

function seedRoot() {
  const root = fs.mkdtempSync(join(tmpdir(), 'setu-links-crash-'));
  roots.push(root);
  const store = openSpansStore({ root });
  createSpansDrafts({ store }).createRun({
    goal: 'g',
    owner: 'codex',
    runId: 'run-1',
    spans: [{ dependencies: [], spanId: 'plan', title: 'Plan' }],
  });
  const links = createLinksAssociations({ isKnownOrigin: () => true, store });
  const { review } = links.preview(target);
  expect(links.approve({ ...target, confirmation: review.token }).ok).toBe(
    true
  );
  store.close();
  return root;
}

function inspect(root) {
  const store = openSpansStore({ root });
  try {
    const events = [];
    let afterSequence = 0;
    for (;;) {
      const page = store.readEvents({
        afterSequence,
        limit: 200,
        runId: 'run-1',
      });
      events.push(...page.events);
      if (!page.hasMore) {
        break;
      }
      afterSequence = page.nextSequence;
    }
    const links = events.filter(
      (e) => e.type === 'links.message' || e.type === 'links.status'
    );
    return {
      ids: links.map((e) => e.eventId),
      offset: store.readSourceCursor(key).offset,
    };
  } finally {
    store.close();
  }
}

async function child(root, killAt, killOn, count = EVENTS) {
  const process_ = Bun.spawn(
    ['bun', fixture, root, String(count), killAt, String(killOn)],
    { stderr: 'ignore', stdout: 'pipe' }
  );
  const code = await process_.exited;
  return code;
}

const consistent = ({ ids, offset }) => {
  // No duplicate, and exactly the events the cursor claims.
  expect(new Set(ids).size).toBe(ids.length);
  expect(ids.length).toBe(offset * 2);
};

async function referenceIds(count = EVENTS) {
  const root = seedRoot();
  const store = openSpansStore({ root });
  const engine = createFakeEngine();
  for (let index = 0; index < count; index += 1) {
    engine.record(`m_${index}`, engineMessage(), 'queued');
  }
  const links = createLinksAssociations({ isKnownOrigin: () => true, store });
  await createLinksProjection({ associations: links, engine, store }).runOnce({
    maxBatches: 1000,
  });
  store.close();
  return inspect(root).ids;
}

for (const [killAt, killOn] of [
  ['read', 1],
  ['read', 3],
  ['before-commit', 1],
  ['before-commit', 3],
  ['after-commit', 1],
  ['after-commit', 3],
  ['after-commit', 5],
]) {
  test(`SIGKILL at ${killAt} #${killOn}: cursor and events agree, and a restart finishes exactly the uninterrupted history`, async () => {
    const root = seedRoot();
    expect(await child(root, killAt, killOn)).not.toBe(0);
    const interrupted = inspect(root);
    consistent(interrupted);
    // The cursor sits at a whole batch (100 engine events), never in the middle of one.
    expect([0, 100, 200, 300, 400, EVENTS]).toContain(interrupted.offset);

    expect(await child(root, 'never', 1)).toBe(0);
    const finished = inspect(root);
    consistent(finished);
    expect(finished.offset).toBe(EVENTS);
    expect(finished.ids).toEqual(await referenceIds());
  });
}

test('SIGKILL at many arbitrary instants, including inside the open archive transaction', async () => {
  const total = 3000;
  const root = seedRoot();
  const delays = [60, 90, 120, 150, 180, 210, 240, 280, 320, 380];
  let killedMidRun = 0;
  for (const delay of delays) {
    const running = Bun.spawn(['bun', fixture, root, String(total)], {
      stderr: 'ignore',
      stdout: 'ignore',
    });
    // biome-ignore lint/performance/noAwaitInLoops: each worker must be killed and inspected before the next starts.
    const finished = await Promise.race([
      running.exited.then(() => true),
      Bun.sleep(delay).then(() => false),
    ]);
    if (!finished) {
      running.kill('SIGKILL');
      await running.exited;
      killedMidRun += 1;
    }
    consistent(inspect(root));
  }
  // The test is only meaningful if workers really were killed while working.
  expect(killedMidRun).toBeGreaterThanOrEqual(3);
  expect(await child(root, 'never', 1, total)).toBe(0);
  const finished = inspect(root);
  consistent(finished);
  expect(finished.offset).toBe(total);
  expect(finished.ids).toEqual(await referenceIds(total));
}, 60_000);
