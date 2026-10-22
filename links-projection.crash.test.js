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
    [process.execPath, fixture, root, String(count), killAt, String(killOn)],
    { stderr: 'ignore', stdout: 'pipe' }
  );
  const code = await process_.exited;
  return code;
}

function createMessageReader(stream) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffered = '';

  return async function nextMessage() {
    for (;;) {
      const newline = buffered.indexOf('\n');
      if (newline !== -1) {
        const line = buffered.slice(0, newline);
        buffered = buffered.slice(newline + 1);
        return JSON.parse(line);
      }
      // biome-ignore lint/performance/noAwaitInLoops: Read the child protocol one chunk at a time.
      const { done, value } = await reader.read();
      if (done) {
        throw new Error(
          'Crash fixture exited before reporting a read boundary'
        );
      }
      buffered += decoder.decode(value, { stream: true });
    }
  };
}

async function waitForReadBoundary(nextMessage, expectedOffset) {
  let timer;
  try {
    const message = await Promise.race([
      nextMessage(),
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error('Crash fixture read boundary timed out')),
          10_000
        );
      }),
    ]);
    if (message.type !== 'read-ready' || message.after !== expectedOffset) {
      throw new Error(
        `Expected a read boundary at ${expectedOffset}; got ${message.after}`
      );
    }
    return message;
  } finally {
    clearTimeout(timer);
  }
}

function pauseableChild(root, count) {
  const process_ = Bun.spawn(
    [
      process.execPath,
      fixture,
      root,
      String(count),
      'never',
      '1',
      'pause-reads',
    ],
    { stderr: 'ignore', stdin: 'pipe', stdout: 'pipe' }
  );
  return {
    nextMessage: createMessageReader(process_.stdout),
    process: process_,
  };
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

test('SIGKILL live workers at observed page boundaries, then restart to the uninterrupted history', async () => {
  const total = 1000;
  const root = seedRoot();
  const killOffsets = [0, 100, 300, 600, 900];
  for (const killOffset of killOffsets) {
    const running = pauseableChild(root, total);
    try {
      let cursor = inspect(root).offset;
      while (cursor < killOffset) {
        // biome-ignore lint/performance/noAwaitInLoops: Release only the page at the current archive cursor.
        await waitForReadBoundary(running.nextMessage, cursor);
        await running.process.stdin.write('continue\n');
        await running.process.stdin.flush();
        cursor += 100;
      }
      const boundary = await waitForReadBoundary(
        running.nextMessage,
        killOffset
      );
      expect(boundary.count).toBeGreaterThan(0);
      expect(inspect(root).offset).toBe(killOffset);

      // The fixture holds the worker after a real engine page read and before
      // the projection can commit it, so this SIGKILL is deterministic.
      running.process.kill('SIGKILL');
      expect(await running.process.exited).not.toBe(0);
      consistent(inspect(root));
    } finally {
      if (running.process.exitCode === null) {
        running.process.kill('SIGKILL');
      }
      await running.process.exited;
    }
  }

  expect(await child(root, 'never', 1, total)).toBe(0);
  const finished = inspect(root);
  consistent(finished);
  expect(finished.offset).toBe(total);
  expect(finished.ids).toEqual(await referenceIds(total));
}, 60_000);
