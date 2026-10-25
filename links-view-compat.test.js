import { afterEach, expect, test } from 'bun:test';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLinksAssociations } from './links-associations.js';
import { associationIdOf } from './links-history.js';
import { createSpansActions } from './spans-actions.js';
import { createSpansDrafts } from './spans-drafts.js';
import { createSpansHistoryImport } from './spans-history-import.js';
import { redactSpansValue } from './spans-redaction.js';
import { openSpansStore } from './spans-store.js';
import { createSpansUsage } from './spans-usage.js';

// Associations live in the run view under `linksAssociations`. Every other
// writer of a run view must carry that key through its own commits, or an
// approval would silently vanish. These run the real writers on a real store.

const COMMIT_RUN = /\bcommitRun\(/;
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

const target = { hint: 'run-1', origin: 'peer-A', runId: 'run-1' };
const id = associationIdOf(target);

function approvedRun(view) {
  const root = fs.mkdtempSync(join(tmpdir(), 'setu-links-compat-'));
  roots.push(root);
  const store = openSpansStore({ root });
  stores.push(store);
  expect(
    store.commitRun({
      events: [],
      expectedGeneration: 0,
      expectedRevision: 0,
      runId: 'run-1',
      view,
    }).ok
  ).toBe(true);
  const links = createLinksAssociations({ isKnownOrigin: () => true, store });
  const { review } = links.preview(target);
  expect(links.approve({ ...target, confirmation: review.token }).ok).toBe(
    true
  );
  return { links, store };
}

const stillApproved = (store, generation) => {
  const read = store.readRun({ runId: 'run-1' });
  expect(read.view.linksAssociations[id]).toMatchObject({
    generation,
    origin: 'peer-A',
    status: 'approved',
  });
  return read;
};

const baseView = () => ({
  actions: {},
  checkpoint: 0,
  generation: 1,
  planVersion: 1,
  runId: 'run-1',
  spans: {
    a: { dependencies: [], spanId: 'a', state: 'ready' },
  },
});

test('usage reservations keep the run approvals', async () => {
  const { store } = approvedRun({ ...baseView(), generation: 0 });
  const usage = createSpansUsage({ store });
  const reserved = await usage.reserve({
    actionId: 'action-1',
    aggregateLimitMicro: 100,
    attemptId: 'attempt-1',
    attemptLimitMicro: 80,
    enforcementAvailable: true,
    generation: 0,
    hardCap: true,
    priceKnown: true,
    reservationId: 'reservation-1',
    reservationMicro: 60,
    runId: 'run-1',
  });
  expect(reserved.ok).toBe(true);
  stillApproved(store, 0);
});

test('preparing a Spans action keeps the run approvals', async () => {
  const { store } = approvedRun(baseView());
  const actions = createSpansActions({ store });
  const result = await actions.prepareAction({
    actionId: 'action-a',
    attemptId: 'attempt-1',
    generation: 1,
    inputDigest: 'a'.repeat(64),
    planVersion: 1,
    runId: 'run-1',
    spanId: 'a',
    targetDigest: 'c'.repeat(64),
  });
  expect(result).toMatchObject({ ok: true });
  stillApproved(store, 1);
});

test('revising a plan keeps the approval, now stale for the new generation', () => {
  const root = fs.mkdtempSync(join(tmpdir(), 'setu-links-compat-'));
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
  const links = createLinksAssociations({ isKnownOrigin: () => true, store });
  const { review } = links.preview(target);
  links.approve({ ...target, confirmation: review.token });
  const read = store.readRun({ runId: 'run-1' });
  expect(
    drafts.revisePlan({
      expectedGeneration: read.generation,
      expectedRevision: read.revision,
      goal: 'g2',
      runId: 'run-1',
      spans: [{ dependencies: [], spanId: 'plan', title: 'Plan 2' }],
    }).ok
  ).toBe(true);
  expect(links.listForRun({ runId: 'run-1' }).associations[0]).toMatchObject({
    generation: 0,
    status: 'stale',
  });
});

test('a writer that redacts the whole view leaves an approval byte-identical', () => {
  const { store } = approvedRun({ ...baseView(), generation: 0 });
  const { view } = store.readRun({ runId: 'run-1' });
  expect(redactSpansValue(view).linksAssociations).toEqual(
    view.linksAssociations
  );
});

test('resuming imported history preserves its existing Links approval', async () => {
  const root = fs.mkdtempSync(join(tmpdir(), 'setu-history-links-'));
  roots.push(root);
  const archive = join(root, 'archive');
  const path = join(root, 'selected.jsonl');
  fs.writeFileSync(
    path,
    `${JSON.stringify({
      payload: {
        content: [{ text: 'retained message', type: 'output_text' }],
        role: 'assistant',
        type: 'message',
      },
      type: 'response_item',
    })}\n`
  );
  const importer = createSpansHistoryImport({
    archiveWrite: async (_request, effect) => ({
      ok: true,
      value: await effect(),
    }),
    root: archive,
  });
  try {
    const input = { path, provider: 'codex' };
    const imported = await importer.importSelected(input);
    expect(imported.ok).toBe(true);
    const store = openSpansStore({ create: false, root: archive });
    stores.push(store);
    const links = createLinksAssociations({ isKnownOrigin: () => true, store });
    const linkedTarget = { ...target, runId: imported.runId };
    const preview = links.preview(linkedTarget);
    expect(preview.ok).toBe(true);
    expect(
      links.approve({ ...linkedTarget, confirmation: preview.review.token }).ok
    ).toBe(true);
    const approved = store.readRun({ runId: imported.runId }).view
      .linksAssociations;
    expect((await importer.importSelected(input)).ok).toBe(true);
    expect(
      store.readRun({ runId: imported.runId }).view.linksAssociations
    ).toEqual(approved);
  } finally {
    await importer.close();
  }
});

// Any new code that commits a run view must be reviewed against the key above.
test('only the reviewed modules commit run views', () => {
  const reviewed = new Set([
    'links-associations.js',
    'spans-actions.js',
    'spans-cmux-store.js',
    'spans-drafts.js',
    'spans-execution-review.js',
    'spans-execution.js',
    'spans-history-import.js',
    'spans-model-store.js',
    'spans-planning-runtime.js',
    'spans-usage.js',
    'spans-worker-host.js',
    'spans-worker.js',
  ]);
  const writers = fs
    .readdirSync(import.meta.dir)
    .filter((name) => name.endsWith('.js') && !name.includes('.test'))
    .filter(
      (name) => !(name.includes('fixture') || name.includes('test-support'))
    )
    .filter((name) =>
      COMMIT_RUN.test(fs.readFileSync(join(import.meta.dir, name), 'utf8'))
    );
  expect(writers.filter((name) => !reviewed.has(name))).toEqual([]);
});
