import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { createSpansArtifacts } from './spans-artifacts.js';
import { createSpansDrafts } from './spans-drafts.js';
import { createSpansService } from './spans-service.js';
import { openSpansStore } from './spans-store.js';

const RUN_COUNT = 1000;
const APPENDED_EVENTS_PER_RUN = 99;
const TOTAL_EVENTS_PER_RUN = APPENDED_EVENTS_PER_RUN + 1;
const EVENT_COUNT = RUN_COUNT * TOTAL_EVENTS_PER_RUN;
const RUN_PAGE_SIZE = 50;
const EVENT_PAGE_SIZE = 64;
const QUERY = 'Needle%_Alpha';
const roots = [];
const stores = [];

afterEach(() => {
  for (const store of stores.splice(0)) {
    expect(store.close().ok).toBe(true);
  }
  for (const root of roots.splice(0)) {
    rmSync(root, { force: true, recursive: true });
  }
});

test('real offline archive and shared reads page 1,000 runs and 100,000 events', async () => {
  const root = mkdtempSync(join(tmpdir(), 'setu-spans-scale-'));
  roots.push(root);
  const store = openSpansStore({ root });
  stores.push(store);
  const artifacts = createSpansArtifacts({ root });
  const drafts = createSpansDrafts({ store });
  let payloadBytes = 0;

  for (let index = 0; index < RUN_COUNT; index += 1) {
    const id = `scale-run-${String(index).padStart(4, '0')}`;
    const goal =
      index % 100 === 0
        ? `Synthetic ${QUERY} run ${index}`
        : `Synthetic scale run ${index}`;
    const created = drafts.createRun({
      goal,
      owner: 'offline-scale-fixture',
      project: 'synthetic-scale',
      runId: id,
      spans: [
        { dependencies: [], spanId: 'fixture', title: 'Synthetic fixture' },
      ],
      worktree: null,
    });
    expect(created.ok).toBe(true);

    const state = ['planned', 'running', 'completed'][index % 3];
    const events = Array.from(
      { length: APPENDED_EVENTS_PER_RUN },
      (_, eventIndex) => {
        const event = {
          eventId: `${id}-event-${String(eventIndex).padStart(3, '0')}`,
          payload: {
            ordinal: eventIndex,
            text: `Synthetic event ${eventIndex}`,
          },
          runId: id,
          type: 'fixture.event',
        };
        const bytes = Buffer.byteLength(JSON.stringify(event), 'utf8');
        expect(bytes).toBeLessThanOrEqual(256);
        payloadBytes += bytes;
        return event;
      }
    );
    const committed = store.commitRun({
      events,
      expectedGeneration: 0,
      expectedRevision: created.revision,
      runId: id,
      view: { ...created.run, state },
    });
    expect(committed.ok).toBe(true);
    expect(committed.revision).toBe(created.revision + 1);
  }

  const service = createSpansService({ artifacts, store });
  let readStarted = performance.now();
  const first = await service.listRuns({ limit: RUN_PAGE_SIZE });
  const firstListMs = Number((performance.now() - readStarted).toFixed(3));
  expect(first.records).toHaveLength(RUN_PAGE_SIZE);
  expect(first.hasMore).toBe(true);
  expect(first.nextRunId).toBe(
    `scale-run-${String(RUN_PAGE_SIZE - 1).padStart(4, '0')}`
  );
  for (const record of first.records) {
    expect(Object.keys(record).sort()).toEqual([
      'generation',
      'revision',
      'runId',
      'view',
    ]);
    expect(
      Object.keys(record.view).every((key) =>
        [
          'checkpoint',
          'goal',
          'owner',
          'planVersion',
          'project',
          'state',
          'worktree',
        ].includes(key)
      )
    ).toBe(true);
    expect(record.view.actions).toBeUndefined();
    expect(record.view.spans).toBeUndefined();
  }

  readStarted = performance.now();
  const warmed = await service.listRuns({ limit: RUN_PAGE_SIZE });
  const warmedListMs = Number((performance.now() - readStarted).toFixed(3));
  expect(warmed).toEqual(first);

  readStarted = performance.now();
  const filtered = await service.listRuns({
    limit: RUN_PAGE_SIZE,
    phase: 'planned',
    query: QUERY,
  });
  const filteredPlannedLiteralSummaryMs = Number(
    (performance.now() - readStarted).toFixed(3)
  );
  expect(filtered.records.map((record) => record.runId)).toEqual([
    'scale-run-0000',
    'scale-run-0300',
    'scale-run-0600',
    'scale-run-0900',
  ]);
  expect(filtered.hasMore).toBe(false);
  expect(
    filtered.records.every((record) => record.view.state === 'planned')
  ).toBe(true);

  readStarted = performance.now();
  const samplePage = await service.getEvents({
    limit: EVENT_PAGE_SIZE,
    runId: 'scale-run-0000',
  });
  const oneEventPageMs = Number((performance.now() - readStarted).toFixed(3));
  expect(samplePage.events).toHaveLength(EVENT_PAGE_SIZE);
  expect(samplePage.hasMore).toBe(true);
  expect(
    await service.getEvents({ limit: EVENT_PAGE_SIZE, runId: 'scale-run-0000' })
  ).toEqual(samplePage);
  expect(
    samplePage.events.every(
      (event) =>
        Object.keys(event).sort().join(',') ===
        'eventId,payload,runId,sequence,type'
    )
  ).toBe(true);

  const runIds = [];
  const eventIds = new Set();
  let afterRunId;
  let countedEvents = 0;
  let lastRunPage;
  for (;;) {
    // biome-ignore lint/performance/noAwaitInLoops: Each page requires the preceding cursor.
    const page = await service.listRuns({
      ...(afterRunId === undefined ? {} : { afterRunId }),
      limit: RUN_PAGE_SIZE,
    });
    expect(page.ok).toBe(true);
    expect(page.records.length).toBeLessThanOrEqual(RUN_PAGE_SIZE);
    expect(page.records.length).toBeGreaterThan(0);
    for (const record of page.records) {
      expect(Object.keys(record).sort()).toEqual([
        'generation',
        'revision',
        'runId',
        'view',
      ]);
      expect(
        Object.keys(record.view).every((key) =>
          [
            'checkpoint',
            'goal',
            'owner',
            'planVersion',
            'project',
            'state',
            'worktree',
          ].includes(key)
        )
      ).toBe(true);
      expect(record.view.actions).toBeUndefined();
      expect(record.view.spans).toBeUndefined();
      runIds.push(record.runId);
      let afterSequence = 0;
      for (;;) {
        // biome-ignore lint/performance/noAwaitInLoops: Each page requires the preceding cursor.
        const eventPage = await service.getEvents({
          afterSequence,
          limit: EVENT_PAGE_SIZE,
          runId: record.runId,
        });
        expect(eventPage.ok).toBe(true);
        expect(eventPage.events.length).toBeLessThanOrEqual(EVENT_PAGE_SIZE);
        for (const event of eventPage.events) {
          expect(event.runId).toBe(record.runId);
          expect(eventIds.has(event.eventId)).toBe(false);
          eventIds.add(event.eventId);
          countedEvents += 1;
        }
        if (!eventPage.hasMore) {
          expect(eventPage.events).toHaveLength(
            TOTAL_EVENTS_PER_RUN % EVENT_PAGE_SIZE || EVENT_PAGE_SIZE
          );
          expect(eventPage.nextSequence).toBeGreaterThanOrEqual(afterSequence);
          break;
        }
        expect(eventPage.nextSequence).toBeGreaterThan(afterSequence);
        afterSequence = eventPage.nextSequence;
      }
    }
    lastRunPage = page;
    if (!page.hasMore) {
      break;
    }
    expect(page.nextRunId).toBe(page.records.at(-1).runId);
    expect(page.nextRunId > (afterRunId ?? '')).toBe(true);
    afterRunId = page.nextRunId;
  }
  expect(runIds).toHaveLength(RUN_COUNT);
  expect(new Set(runIds).size).toBe(RUN_COUNT);
  expect(runIds).toEqual(
    Array.from(
      { length: RUN_COUNT },
      (_, index) => `scale-run-${String(index).padStart(4, '0')}`
    )
  );
  expect(lastRunPage.records).toHaveLength(
    RUN_COUNT % RUN_PAGE_SIZE || RUN_PAGE_SIZE
  );
  expect(lastRunPage.hasMore).toBe(false);
  expect(countedEvents).toBe(EVENT_COUNT);
  expect(eventIds.size).toBe(EVENT_COUNT);
  expect(payloadBytes).toBeLessThan(EVENT_COUNT * 256);

  const lastRunId = `scale-run-${String(RUN_COUNT - 1).padStart(4, '0')}`;
  const beforeReopen = store.readEvents({ limit: 1, runId: lastRunId });
  expect(beforeReopen.events[0].type).toBe('spans.plan.created');
  expect(store.close().ok).toBe(true);
  stores.splice(stores.indexOf(store), 1);
  const reopenedStore = openSpansStore({ root });
  stores.push(reopenedStore);
  const reopenedService = createSpansService({
    artifacts: createSpansArtifacts({ root }),
    store: reopenedStore,
  });
  const reopenedRun = await reopenedService.getRun({ runId: lastRunId });
  expect(reopenedRun.ok).toBe(true);
  expect(reopenedRun.record.view.state).toBe('planned');
  let reopenedCursor = 0;
  let reopenedTail;
  for (;;) {
    // biome-ignore lint/performance/noAwaitInLoops: Each page requires the preceding cursor.
    reopenedTail = await reopenedService.getEvents({
      afterSequence: reopenedCursor,
      limit: EVENT_PAGE_SIZE,
      runId: lastRunId,
    });
    if (!reopenedTail.hasMore) {
      break;
    }
    expect(reopenedTail.nextSequence).toBeGreaterThan(reopenedCursor);
    reopenedCursor = reopenedTail.nextSequence;
  }
  expect(reopenedTail.events).toHaveLength(
    TOTAL_EVENTS_PER_RUN % EVENT_PAGE_SIZE
  );
  expect(reopenedTail.events.at(-1).eventId).toBe(`${lastRunId}-event-098`);
  expect(reopenedTail.hasMore).toBe(false);

  const memory =
    typeof process.memoryUsage === 'function'
      ? process.memoryUsage()
      : undefined;
  console.log(
    JSON.stringify({
      bunVersion: Bun.version,
      fixture: { eventCount: EVENT_COUNT, payloadBytes, runCount: RUN_COUNT },
      metrics: {
        filteredPlannedLiteralSummaryMs,
        firstListPageMs: firstListMs,
        oneEventPageMs,
        warmedListPageMs: warmedListMs,
      },
      observedMemoryBytes: memory
        ? {
            arrayBuffers: memory.arrayBuffers,
            external: memory.external,
            heapUsed: memory.heapUsed,
            rss: memory.rss,
          }
        : null,
    })
  );
}, 30_000);
