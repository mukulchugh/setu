import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { createSpansDrafts } from './spans-drafts.js';
import { openSpansStore } from './spans-store.js';

const RUN_COUNT = 1000;
const APPENDED_EVENTS_PER_RUN = 99;
const EVENTS_PER_RUN = APPENDED_EVENTS_PER_RUN + 1;
const EVENT_COUNT = RUN_COUNT * EVENTS_PER_RUN;
const INDEX_PAGE_SIZE = 200;
const SEARCH_PAGE_SIZE = 80;
const PARTIAL_INDEX_PAGES = 11;
const MATCH = 'ScaleNeedle';
const roots = [];
const stores = [];

function closeTrackedStore(store) {
  const index = stores.indexOf(store);
  expect(store.close().ok).toBe(true);
  if (index !== -1) {
    stores.splice(index, 1);
  }
}

afterEach(() => {
  for (const store of stores.splice(0)) {
    expect(store.close().ok).toBe(true);
  }
  for (const root of roots.splice(0)) {
    rmSync(root, { force: true, recursive: true });
  }
});

test('search indexes 1,000 runs and 100,000 events in resumable bounded pages', () => {
  const root = mkdtempSync(join(tmpdir(), 'setu-spans-search-scale-'));
  roots.push(root);
  let store = openSpansStore({ root });
  stores.push(store);
  const drafts = createSpansDrafts({ store });
  const startedAt = performance.now();

  for (let runIndex = 0; runIndex < RUN_COUNT; runIndex += 1) {
    const runId = `search-scale-${String(runIndex).padStart(4, '0')}`;
    const created = drafts.createRun({
      goal: `Synthetic search scale run ${runIndex}`,
      owner: 'offline-search-scale-fixture',
      project: 'synthetic-search-scale',
      runId,
      spans: [
        { dependencies: [], spanId: 'fixture', title: 'Synthetic fixture' },
      ],
      worktree: null,
    });
    expect(created.ok).toBe(true);

    const events = Array.from(
      { length: APPENDED_EVENTS_PER_RUN },
      (_, index) => ({
        eventId: `${runId}-event-${String(index).padStart(3, '0')}`,
        payload: {
          ordinal: index,
          text:
            index === 17
              ? `${MATCH} synthetic searchable event ${runIndex}`
              : `Synthetic event ${index}`,
        },
        runId,
        type: 'fixture.event',
      })
    );
    const committed = store.commitRun({
      events,
      expectedGeneration: 0,
      expectedRevision: created.revision,
      runId,
      view: {
        ...created.run,
        state: ['planned', 'running', 'completed'][runIndex % 3],
      },
    });
    expect(committed.ok).toBe(true);
    expect(committed.revision).toBe(created.revision + 1);
  }
  const fixtureWriteMs = Number((performance.now() - startedAt).toFixed(3));

  const initialized = store.initializeSearch();
  expect(initialized).toEqual({ ok: true, version: 1 });
  const initialCoverage = store.searchStatus();
  expect(initialCoverage.ok).toBe(true);
  expect(initialCoverage.coverage.indexedSequence).toBe(0);
  expect(initialCoverage.coverage.latestSequence).toBe(EVENT_COUNT);
  expect(initialCoverage.coverage.complete).toBe(false);

  const indexStartedAt = performance.now();
  let indexedPages = 0;
  let indexedEvents = 0;
  let lastIndexedSequence = 0;
  for (;;) {
    const page = store.indexSearchPage({ limit: INDEX_PAGE_SIZE });
    expect(page.ok).toBe(true);
    expect(page.indexed).toBeGreaterThan(0);
    expect(page.indexed).toBeLessThanOrEqual(INDEX_PAGE_SIZE);
    expect(page.nextSequence).toBeGreaterThan(lastIndexedSequence);
    indexedPages += 1;
    indexedEvents += page.indexed;
    lastIndexedSequence = page.nextSequence;
    if (indexedPages === PARTIAL_INDEX_PAGES) {
      expect(page.coverage.complete).toBe(false);
      expect(page.coverage.indexedSequence).toBe(lastIndexedSequence);
      break;
    }
  }

  closeTrackedStore(store);
  store = openSpansStore({ root });
  stores.push(store);
  const resumedFrom = store.searchStatus();
  expect(resumedFrom.ok).toBe(true);
  expect(resumedFrom.coverage.complete).toBe(false);
  expect(resumedFrom.coverage.indexedSequence).toBe(lastIndexedSequence);

  for (;;) {
    const page = store.indexSearchPage({ limit: INDEX_PAGE_SIZE });
    expect(page.ok).toBe(true);
    expect(page.indexed).toBeGreaterThan(0);
    expect(page.indexed).toBeLessThanOrEqual(INDEX_PAGE_SIZE);
    expect(page.nextSequence).toBeGreaterThan(lastIndexedSequence);
    indexedPages += 1;
    indexedEvents += page.indexed;
    lastIndexedSequence = page.nextSequence;
    if (!page.hasMore) {
      expect(page.coverage.complete).toBe(true);
      break;
    }
  }
  const indexMs = Number((performance.now() - indexStartedAt).toFixed(3));
  expect(indexedEvents).toBe(EVENT_COUNT);
  expect(lastIndexedSequence).toBe(EVENT_COUNT);
  const completeCoverage = store.searchStatus();
  expect(completeCoverage.ok).toBe(true);
  expect(completeCoverage.coverage).toEqual({
    complete: true,
    generation: 0,
    indexedSequence: EVENT_COUNT,
    latestSequence: EVENT_COUNT,
    stale: false,
  });

  const searchStartedAt = performance.now();
  const first = store.search({ limit: SEARCH_PAGE_SIZE, query: MATCH });
  expect(first.ok).toBe(true);
  expect(first.hits).toHaveLength(SEARCH_PAGE_SIZE);
  expect(first.hasMore).toBe(true);
  expect(first.coverage.complete).toBe(true);
  expect(store.search({ limit: SEARCH_PAGE_SIZE, query: MATCH })).toEqual(
    first
  );

  const hits = [...first.hits];
  let cursor = first.nextSequence;
  while (hits.length < RUN_COUNT) {
    const page = store.search({
      afterSequence: cursor,
      expectedGeneration: first.generation,
      limit: SEARCH_PAGE_SIZE,
      query: MATCH,
      throughSequence: first.throughSequence,
    });
    expect(page.ok).toBe(true);
    expect(page.generation).toBe(first.generation);
    expect(page.throughSequence).toBe(first.throughSequence);
    expect(page.hits.length).toBeGreaterThan(0);
    expect(page.hits.length).toBeLessThanOrEqual(SEARCH_PAGE_SIZE);
    expect(page.hits[0].sequence).toBeGreaterThan(cursor);
    hits.push(...page.hits);
    cursor = page.nextSequence;
    expect(page.hasMore).toBe(hits.length < RUN_COUNT);
  }
  expect(hits).toHaveLength(RUN_COUNT);
  expect(new Set(hits.map((hit) => hit.eventId)).size).toBe(RUN_COUNT);
  expect(hits.map((hit) => hit.runId)).toEqual(
    Array.from(
      { length: RUN_COUNT },
      (_, index) => `search-scale-${String(index).padStart(4, '0')}`
    )
  );
  expect(hits.every((hit) => hit.eventId.endsWith('-event-017'))).toBe(true);

  const scoped = store.search({
    limit: 10,
    query: MATCH,
    runId: 'search-scale-0420',
  });
  expect(scoped.ok).toBe(true);
  expect(scoped.hits).toHaveLength(1);
  expect(scoped.hits[0].runId).toBe('search-scale-0420');
  expect(scoped.hits[0].eventId).toBe('search-scale-0420-event-017');
  const searchMs = Number((performance.now() - searchStartedAt).toFixed(3));

  const lastRunId = `search-scale-${String(RUN_COUNT - 1).padStart(4, '0')}`;
  const tail = store.readEvents({
    afterSequence: EVENT_COUNT - 1,
    limit: 2,
    runId: lastRunId,
  });
  expect(tail.ok).toBe(true);
  expect(tail.events).toHaveLength(1);
  expect(tail.events[0].eventId).toBe(`${lastRunId}-event-098`);
  closeTrackedStore(store);

  const readonlyStartedAt = performance.now();
  const readonlyStore = openSpansStore({ readonly: true, root });
  stores.push(readonlyStore);
  const readonlyCoverage = readonlyStore.searchStatus();
  expect(readonlyCoverage.ok).toBe(true);
  expect(readonlyCoverage.coverage.complete).toBe(true);
  const readonlyHits = readonlyStore.search({
    limit: 1,
    query: MATCH,
    runId: lastRunId,
  });
  expect(readonlyHits.ok).toBe(true);
  expect(readonlyHits.hits[0].eventId).toBe(`${lastRunId}-event-017`);
  expect(
    readonlyStore.indexSearchPage({ limit: INDEX_PAGE_SIZE })
  ).toMatchObject({
    code: 'SPANS_SEARCH_READONLY',
    ok: false,
  });
  const readonlyReopenMs = Number(
    (performance.now() - readonlyStartedAt).toFixed(3)
  );

  console.log(
    JSON.stringify({
      bunVersion: Bun.version,
      fixture: { eventCount: EVENT_COUNT, runCount: RUN_COUNT },
      metrics: {
        fixtureWriteMs,
        indexedPages,
        indexMs,
        readonlyReopenAndReadMs: readonlyReopenMs,
        searchPaginationMs: searchMs,
      },
      partialIndex: {
        indexedSequence: resumedFrom.coverage.indexedSequence,
        pagesBeforeReopen: PARTIAL_INDEX_PAGES,
      },
    })
  );
}, 120_000);
