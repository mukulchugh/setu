import { afterEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import {
  lstatSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { associationIdOf, projectionKeyOf } from './links-history.js';
import {
  createLinksHistoryService,
  LINKS_ARCHIVE_WRITE_MAX_BYTES,
} from './links-history-service.js';
import {
  createFakeEngine,
  engineMessage,
  STORE_ID,
} from './links-projection.engine-fixture.js';
import { gateLinksArchiveMutations } from './links-runtime.js';
import { createSpansDrafts } from './spans-drafts.js';
import { openSpansStore } from './spans-store.js';

const roots = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { force: true, recursive: true });
  }
});

function archive() {
  const root = mkdtempSync(join(tmpdir(), 'setu-links-admission-'));
  roots.push(root);
  const store = openSpansStore({ root });
  const drafts = createSpansDrafts({ store });
  const created = drafts.createRun({
    goal: 'Preserve this run',
    owner: 'codex',
    project: 'fixture-project',
    runId: 'run-1',
    spans: [{ dependencies: [], spanId: 'plan', title: 'Plan' }],
    worktree: 'fixture-worktree',
  });
  expect(created.ok).toBe(true);
  store.close();
  return root;
}

function snapshot(root) {
  const entries = [];
  const visit = (directory, prefix = '') => {
    for (const name of readdirSync(directory).sort()) {
      if (name === 'spans.sqlite3-shm') {
        continue;
      }
      const path = join(directory, name);
      const relative = prefix ? `${prefix}/${name}` : name;
      const stat = lstatSync(path);
      if (stat.isDirectory()) {
        entries.push(`${relative}:dir:${stat.mode.toString(8)}`);
        visit(path, relative);
      } else {
        entries.push(
          `${relative}:file:${stat.mode.toString(8)}:${createHash('sha256')
            .update(readFileSync(path))
            .digest('hex')}`
        );
      }
    }
  };
  visit(root);
  return entries;
}

function scriptedClient({ engine, isAdmissionActive } = {}) {
  const calls = [];
  const eventsDuringAdmission = [];
  return {
    call(op, args) {
      calls.push({ args, op });
      if (op === 'events' && engine) {
        if (isAdmissionActive?.()) {
          eventsDuringAdmission.push(args);
        }
        const page = engine.read({
          after: args.after,
          limit: args.limit,
          origin: args.origin,
          runHint: args.run_hint,
        });
        return Promise.resolve({
          ok: true,
          result: {
            events: page.events,
            has_more: page.has_more,
            head: page.head,
            next: page.next,
            store_id: page.store_id,
          },
        });
      }
      if (op === 'show') {
        return Promise.resolve({
          ok: true,
          result: {
            body: 'Record this message safely.',
            created_at: 17,
            kind: 'message',
            message_id: 'message-1',
            recipient: {
              provider: 'claude-code',
              session_hint: 'session-1',
            },
            reply_to: null,
            run_hint: 'run-1',
            sender: { kind: 'user' },
            size: 64,
            span_hint: 'plan',
          },
        });
      }
      return Promise.resolve({
        code: 'LINKS_UNKNOWN_OP',
        error: 'Unknown fixture operation.',
        ok: false,
      });
    },
    calls,
    eventsDuringAdmission,
  };
}

function admissionHarness({ refuse = false, refuseAt = null } = {}) {
  const calls = [];
  const events = [];
  const nestedCalls = [];
  const effectStack = [];
  let active = 0;
  let refusal = refuse;
  let refusalAt = refuseAt;
  const archiveWrite = async (request, effect) => {
    calls.push(request);
    if (active > 0) {
      nestedCalls.push(calls.length);
    }
    const call = calls.length;
    if (refusal || call === refusalAt) {
      events.push({ call, type: 'effect-refused' });
      return {
        code: 'SPANS_ARCHIVE_CAPACITY_REACHED',
        error: 'Fixture admission refused the write.',
        ok: false,
      };
    }
    active += 1;
    effectStack.push(call);
    events.push({ call, type: 'effect-start' });
    try {
      const value = await effect();
      events.push({ call, type: 'effect-return' });
      return { ok: true, value };
    } finally {
      effectStack.pop();
      active -= 1;
    }
  };
  return {
    archiveWrite,
    calls,
    currentCall: () => effectStack.at(-1) ?? null,
    events,
    isActive: () => active > 0,
    nestedCalls,
    refuseAll: (value) => {
      refusal = value;
    },
    refuseAt: (index) => {
      refusalAt = index;
    },
  };
}

function observedOpenStore({
  admission,
  events,
  failWritableClose = () => false,
}) {
  let nextStoreId = 0;
  return (options) => {
    nextStoreId += 1;
    const storeId = nextStoreId;
    const store = openSpansStore(options);
    events.push({
      admissionCall: admission.currentCall(),
      options: { ...options },
      storeId,
      type: 'store-open',
    });
    return {
      ...store,
      close() {
        events.push({
          admissionCall: admission.currentCall(),
          storeId,
          type: 'store-close',
        });
        const result = store.close();
        if (failWritableClose(options, storeId)) {
          return { ok: false };
        }
        return result;
      },
      commitImport(input) {
        events.push({
          admissionCall: admission.currentCall(),
          expectedOffset: input.expectedOffset,
          fence: input.fence,
          nextOffset: input.nextOffset,
          storeId,
          type: 'commit-import',
        });
        return store.commitImport(input);
      },
      readSourceCursor(...args) {
        const cursor = store.readSourceCursor(...args);
        events.push({
          admissionCall: admission.currentCall(),
          found: cursor.found,
          offset: cursor.offset,
          storeId,
          type: 'source-cursor-read',
        });
        return cursor;
      },
    };
  };
}

const approveTarget = {
  hint: 'run-1',
  origin: 'local',
  runId: 'run-1',
};

async function approveAssociation(history) {
  const preview = await history.associationPreview(approveTarget);
  expect(preview.ok).toBe(true);
  return await history.associationApprove({
    ...approveTarget,
    confirmation: preview.review.token,
  });
}

function projectionState(spansRoot) {
  const store = openSpansStore({ readonly: true, root: spansRoot });
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
    const associationId = associationIdOf(approveTarget);
    const cacheKey = `links-assoc-index:${createHash('sha256')
      .update(JSON.stringify(['local', 'run-1']), 'utf8')
      .digest('hex')}`;
    return {
      cache: store.readCache(cacheKey),
      cursor: store.readSourceCursor(
        projectionKeyOf({ associationId, storeId: STORE_ID })
      ),
      events: events.filter(
        (event) =>
          event.type === 'links.message' || event.type === 'links.status'
      ),
    };
  } finally {
    store.close();
  }
}

describe('Links archive admission', () => {
  test('refusal changes no archive files; accepted gate wraps real approval and evidence writes', async () => {
    const spansRoot = archive();
    const client = scriptedClient();
    const history = createLinksHistoryService({ client, spansRoot });
    const refusalGate = admissionHarness({ refuse: true });
    const refusing = gateLinksArchiveMutations(history, {
      archiveWrite: refusalGate.archiveWrite,
      spansRoot,
    });

    const preview = await refusing.associationPreview(approveTarget);
    expect(preview.ok).toBe(true);
    const beforeRefusal = snapshot(spansRoot);
    const refused = await refusing.associationApprove({
      ...approveTarget,
      confirmation: preview.review.token,
    });
    expect(refused).toMatchObject({
      code: 'SPANS_ARCHIVE_CAPACITY_REACHED',
      ok: false,
    });
    expect(refusalGate.calls).toEqual([
      { maxBytes: LINKS_ARCHIVE_WRITE_MAX_BYTES, root: spansRoot },
    ]);
    expect(snapshot(spansRoot)).toEqual(beforeRefusal);

    const acceptedGate = admissionHarness();
    const guarded = gateLinksArchiveMutations(history, {
      archiveWrite: acceptedGate.archiveWrite,
      spansRoot,
    });
    expect(
      await guarded.associationApprove({
        ...approveTarget,
        confirmation: preview.review.token,
        source: 'ui',
      })
    ).toMatchObject({ ok: true, replayed: false });
    expect(acceptedGate.calls).toHaveLength(1);
    expect(acceptedGate.calls[0]).toEqual({
      maxBytes: LINKS_ARCHIVE_WRITE_MAX_BYTES,
      root: spansRoot,
    });

    const afterApproval = snapshot(spansRoot);
    const approvalRead = await guarded.associations({ runId: 'run-1' });
    expect(approvalRead).toMatchObject({
      associations: [
        { generation: 0, hint: 'run-1', origin: 'local', status: 'approved' },
      ],
      ok: true,
    });
    expect(snapshot(spansRoot)).toEqual(afterApproval);
    expect(acceptedGate.calls).toHaveLength(1);

    const evidencePreview = await guarded.evidencePreview({
      messageId: 'message-1',
      runId: 'run-1',
      spanId: 'plan',
    });
    expect(evidencePreview.ok).toBe(true);
    expect(acceptedGate.calls).toHaveLength(1);
    expect(snapshot(spansRoot)).toEqual(afterApproval);
    const beforeAttach = snapshot(spansRoot);
    const attached = await guarded.evidenceAttach({
      confirmation: evidencePreview.review.token,
      messageId: 'message-1',
      runId: 'run-1',
      source: 'ui',
      spanId: 'plan',
    });
    expect(attached).toMatchObject({
      evidence: {
        associationId: approvalRead.associations[0].associationId,
        messageId: 'message-1',
        origin: 'local',
        spanId: 'plan',
        targetGeneration: 0,
        targetRevision: 2,
      },
      ok: true,
      replayed: false,
    });
    expect(snapshot(spansRoot)).not.toEqual(beforeAttach);
    expect(acceptedGate.calls).toHaveLength(2);

    const store = openSpansStore({ readonly: true, root: spansRoot });
    try {
      const run = store.readRun({ runId: 'run-1' });
      expect(run.view).toMatchObject({
        goal: 'Preserve this run',
        linksAssociations: {
          [approvalRead.associations[0].associationId]: {
            generation: 0,
            hint: 'run-1',
            origin: 'local',
            status: 'approved',
          },
        },
        owner: 'codex',
        planVersion: 1,
        project: 'fixture-project',
        spans: { plan: { title: 'Plan' } },
        worktree: 'fixture-worktree',
      });
      const evidenceEvents = store
        .readEvents({ limit: 200, runId: 'run-1' })
        .events.filter((event) => event.type === 'links.evidence.attached');
      expect(evidenceEvents).toHaveLength(1);
      expect(evidenceEvents[0].payload).toMatchObject({
        artifactId: attached.evidence.artifactId,
        associationId: approvalRead.associations[0].associationId,
        messageId: 'message-1',
        origin: 'local',
        spanId: 'plan',
        targetGeneration: 0,
        targetRevision: 2,
      });
    } finally {
      store.close();
    }

    const beforeRevoke = snapshot(spansRoot);
    expect(
      await guarded.associationRevoke({
        ...approveTarget,
        source: 'ui',
      })
    ).toMatchObject({
      association: { origin: 'local', status: 'revoked' },
      ok: true,
      replayed: false,
    });
    expect(snapshot(spansRoot)).not.toEqual(beforeRevoke);
    expect(acceptedGate.calls).toHaveLength(3);
    expect(acceptedGate.nestedCalls).toEqual([]);
  });

  test('missing archive authority refuses mutations and projection before effects', async () => {
    const spansRoot = archive();
    const client = scriptedClient();
    const history = createLinksHistoryService({ client, spansRoot });
    const before = snapshot(spansRoot);
    const guarded = gateLinksArchiveMutations(history, { spansRoot });

    const preview = await guarded.associationPreview(approveTarget);
    expect(preview.ok).toBe(true);
    expect(
      await guarded.associationApprove({
        ...approveTarget,
        confirmation: preview.review.token,
      })
    ).toMatchObject({ code: 'ADMISSION_UNAVAILABLE', ok: false });
    expect(await guarded.project({ maxBatches: 1 })).toMatchObject({
      code: 'LINKS_ARCHIVE_ADMISSION_UNAVAILABLE',
      ok: false,
    });
    expect(client.calls.some(({ op }) => op === 'events')).toBe(false);
    expect(snapshot(spansRoot)).toEqual(before);
  });

  test('accepted projection admits each write and advances the exact event cursor', async () => {
    const spansRoot = archive();
    const engine = createFakeEngine();
    engine.record('message-1', engineMessage(), 'queued');
    const gate = admissionHarness();
    const client = scriptedClient({
      engine,
      isAdmissionActive: gate.isActive,
    });
    const history = createLinksHistoryService({
      archiveWrite: gate.archiveWrite,
      client,
      spansRoot,
    });
    const guarded = gateLinksArchiveMutations(history, {
      archiveWrite: gate.archiveWrite,
      spansRoot,
    });
    expect(await approveAssociation(guarded)).toMatchObject({ ok: true });

    const beforeReads = snapshot(spansRoot);
    const callsBeforeReads = gate.calls.length;
    expect(await guarded.associations({ runId: 'run-1' })).toMatchObject({
      ok: true,
    });
    expect(await guarded.projectionStatus({ runId: 'run-1' })).toMatchObject({
      ok: true,
    });
    expect(
      await guarded.evidencePreview({
        messageId: 'message-1',
        runId: 'run-1',
        spanId: 'plan',
      })
    ).toMatchObject({ ok: true });
    expect(gate.calls).toHaveLength(callsBeforeReads);
    expect(snapshot(spansRoot)).toEqual(beforeReads);

    const projected = await guarded.project({ maxBatches: 5 });
    expect(projected).toMatchObject({
      associations: [
        {
          pending: false,
          projected: 2,
          projectedThrough: 1,
          runId: 'run-1',
          state: 'ok',
        },
      ],
      complete: true,
      ok: true,
    });
    const state = projectionState(spansRoot);
    expect(state.cursor).toMatchObject({ found: true, offset: 1, ok: true });
    expect(state.events.map((event) => event.type)).toEqual([
      'links.message',
      'links.status',
    ]);
    expect(state.events[0].payload.messageId).toBe('message-1');
    expect(gate.calls).toHaveLength(callsBeforeReads + 2);
    expect(gate.calls.slice(-2)).toEqual([
      { maxBytes: LINKS_ARCHIVE_WRITE_MAX_BYTES, root: spansRoot },
      { maxBytes: LINKS_ARCHIVE_WRITE_MAX_BYTES, root: spansRoot },
    ]);
    expect(gate.nestedCalls).toEqual([]);
    expect(client.eventsDuringAdmission).toEqual([]);
  });

  test('a refused import changes no cache, cursor or events and an explicit retry succeeds', async () => {
    const spansRoot = archive();
    const engine = createFakeEngine();
    engine.record('message-1', engineMessage(), 'queued');
    const client = scriptedClient({ engine });
    const gate = admissionHarness();
    const history = createLinksHistoryService({
      archiveWrite: gate.archiveWrite,
      client,
      spansRoot,
    });
    const guarded = gateLinksArchiveMutations(history, {
      archiveWrite: gate.archiveWrite,
      spansRoot,
    });
    expect(await approveAssociation(guarded)).toMatchObject({ ok: true });
    const before = projectionState(spansRoot);
    const beforeFiles = snapshot(spansRoot);

    // Refusing the derived-index cache write stops before reading engine pages.
    const eventCallsBeforeIndexRefusal = client.calls.filter(
      ({ op }) => op === 'events'
    ).length;
    gate.refuseAt(gate.calls.length + 1);
    expect(await guarded.project({ maxBatches: 5 })).toMatchObject({
      code: 'SPANS_ARCHIVE_CAPACITY_REACHED',
      ok: false,
    });
    expect(projectionState(spansRoot)).toEqual(before);
    expect(snapshot(spansRoot)).toEqual(beforeFiles);
    expect(client.calls.filter(({ op }) => op === 'events')).toHaveLength(
      eventCallsBeforeIndexRefusal
    );

    // The index refresh is admitted; the following import commit is refused.
    gate.refuseAt(gate.calls.length + 2);
    const refused = await guarded.project({ maxBatches: 5 });
    expect(refused).toMatchObject({
      associations: [
        {
          code: 'SPANS_ARCHIVE_CAPACITY_REACHED',
          pending: true,
          projected: 0,
          projectedThrough: 0,
          state: 'admission-refused',
        },
      ],
      complete: false,
      ok: true,
    });
    expect(projectionState(spansRoot)).toEqual(before);
    expect(gate.nestedCalls).toEqual([]);

    gate.refuseAt(null);
    const retried = await guarded.project({ maxBatches: 5 });
    expect(retried).toMatchObject({ complete: true, ok: true });
    expect(projectionState(spansRoot)).toMatchObject({
      cursor: { found: true, offset: 1, ok: true },
      events: [
        { payload: { messageId: 'message-1' }, type: 'links.message' },
        { type: 'links.status' },
      ],
    });
  });

  test('a refused later batch keeps earlier progress and resumes at its exact cursor', async () => {
    const spansRoot = archive();
    const engine = createFakeEngine();
    for (let index = 1; index <= 101; index += 1) {
      engine.record(`message-${index}`, engineMessage(), 'queued');
    }
    const client = scriptedClient({ engine });
    const gate = admissionHarness();
    const history = createLinksHistoryService({
      archiveWrite: gate.archiveWrite,
      client,
      spansRoot,
    });
    const guarded = gateLinksArchiveMutations(history, {
      archiveWrite: gate.archiveWrite,
      spansRoot,
    });
    expect(await approveAssociation(guarded)).toMatchObject({ ok: true });

    // Cache refresh and the first 100-event import are admitted; batch two is refused.
    gate.refuseAt(gate.calls.length + 3);
    const partial = await guarded.project({ maxBatches: 5 });
    expect(partial).toMatchObject({
      associations: [
        {
          code: 'SPANS_ARCHIVE_CAPACITY_REACHED',
          pending: true,
          projected: 200,
          projectedThrough: 100,
          state: 'admission-refused',
        },
      ],
      complete: false,
      ok: true,
    });
    const firstBatch = projectionState(spansRoot);
    expect(firstBatch.cursor).toMatchObject({
      found: true,
      offset: 100,
      ok: true,
    });
    expect(firstBatch.events).toHaveLength(200);
    const firstEventIds = firstBatch.events.map((event) => event.eventId);

    gate.refuseAt(null);
    const resumed = await guarded.project({ maxBatches: 5 });
    expect(resumed).toMatchObject({
      associations: [
        {
          pending: false,
          projected: 2,
          projectedThrough: 101,
          state: 'ok',
        },
      ],
      complete: true,
      ok: true,
    });
    const final = projectionState(spansRoot);
    expect(final.cursor).toMatchObject({ found: true, offset: 101, ok: true });
    expect(final.events).toHaveLength(202);
    expect(final.events.slice(0, 200).map((event) => event.eventId)).toEqual(
      firstEventIds
    );
    expect(final.events.at(-2).payload.messageId).toBe('message-101');
    expect(gate.nestedCalls).toEqual([]);
  });

  test('projection admits existing-only writer opens and resumes on the same fences', async () => {
    const spansRoot = archive();
    const engine = createFakeEngine();
    for (let index = 1; index <= 101; index += 1) {
      engine.record(`message-${index}`, engineMessage(), 'queued');
    }
    const seed = createLinksHistoryService({
      client: scriptedClient(),
      spansRoot,
    });
    expect(await approveAssociation(seed)).toMatchObject({ ok: true });

    const gate = admissionHarness();
    const client = scriptedClient({ engine });
    const history = createLinksHistoryService({
      archiveWrite: gate.archiveWrite,
      client,
      openStore: observedOpenStore({
        admission: gate,
        events: gate.events,
      }),
      spansRoot,
    });
    const guarded = gateLinksArchiveMutations(history, {
      archiveWrite: gate.archiveWrite,
      spansRoot,
    });

    const before = projectionState(spansRoot);
    gate.refuseAt(1);
    expect(await guarded.project({ maxBatches: 5 })).toMatchObject({
      code: 'SPANS_ARCHIVE_CAPACITY_REACHED',
      ok: false,
    });
    expect(
      gate.events
        .filter(({ type }) => type === 'store-open')
        .some(({ options }) => options.readonly === true)
    ).toBe(true);
    expect(
      gate.events
        .filter(({ type }) => type === 'store-open')
        .some(({ options }) => options.readonly !== true)
    ).toBe(false);
    expect(projectionState(spansRoot)).toEqual(before);
    expect(client.calls.some(({ op }) => op === 'events')).toBe(false);

    // Cache refresh and the first batch commit; the second batch is refused.
    gate.refuseAt(4);
    const partial = await guarded.project({ maxBatches: 5 });
    expect(partial).toMatchObject({
      associations: [
        {
          code: 'SPANS_ARCHIVE_CAPACITY_REACHED',
          pending: true,
          projected: 200,
          projectedThrough: 100,
          state: 'admission-refused',
        },
      ],
      complete: false,
      ok: true,
    });
    expect(projectionState(spansRoot).cursor).toMatchObject({
      found: true,
      offset: 100,
      ok: true,
    });

    gate.refuseAt(null);
    const resumed = await guarded.project({ maxBatches: 5 });
    expect(resumed).toMatchObject({ complete: true, ok: true });
    const final = projectionState(spansRoot);
    expect(final.cursor).toMatchObject({ found: true, offset: 101, ok: true });
    expect(final.events).toHaveLength(202);

    const opens = gate.events.filter(({ type }) => type === 'store-open');
    const writers = opens.filter(({ options }) => options.readonly !== true);
    expect(writers.length).toBeGreaterThan(0);
    expect(
      writers.every(
        ({ admissionCall, options }) =>
          admissionCall !== null && options.create === false
      )
    ).toBe(true);
    expect(writers.some(({ admissionCall }) => admissionCall === 4)).toBe(
      false
    );
    for (const writer of writers) {
      const openedAt = gate.events.indexOf(writer);
      const closedAt = gate.events.findIndex(
        (event) =>
          event.type === 'store-close' && event.storeId === writer.storeId
      );
      const returnedAt = gate.events.findIndex(
        (event) =>
          event.type === 'effect-return' && event.call === writer.admissionCall
      );
      expect(openedAt).toBeLessThan(closedAt);
      expect(closedAt).toBeLessThan(returnedAt);
    }

    const readers = opens.filter(({ options }) => options.readonly === true);
    expect(readers.every(({ options }) => options.create === false)).toBe(true);
    const [, partialReader] = readers;
    expect(
      gate.events
        .filter(
          ({ storeId, type }) =>
            type === 'source-cursor-read' && storeId === partialReader.storeId
        )
        .map(({ offset }) => offset)
    ).toEqual([0, 100]);

    const expectedFence = {
      associationId: associationIdOf(approveTarget),
      generation: 0,
      runId: 'run-1',
    };
    expect(
      gate.events
        .filter(({ type }) => type === 'commit-import')
        .map(({ expectedOffset, fence, nextOffset }) => ({
          expectedOffset,
          fence,
          nextOffset,
        }))
    ).toEqual([
      { expectedOffset: 0, fence: expectedFence, nextOffset: 100 },
      { expectedOffset: 100, fence: expectedFence, nextOffset: 101 },
    ]);
    expect(gate.nestedCalls).toEqual([]);
  });

  test('a writable close failure after cache mutation reports an unknown outcome', async () => {
    const spansRoot = archive();
    const seed = createLinksHistoryService({
      client: scriptedClient(),
      spansRoot,
    });
    expect(await approveAssociation(seed)).toMatchObject({ ok: true });

    const gate = admissionHarness();
    const history = createLinksHistoryService({
      archiveWrite: gate.archiveWrite,
      client: scriptedClient(),
      openStore: observedOpenStore({
        admission: gate,
        events: gate.events,
        failWritableClose: (options) => options.readonly !== true,
      }),
      spansRoot,
    });
    const guarded = gateLinksArchiveMutations(history, {
      archiveWrite: gate.archiveWrite,
      spansRoot,
    });

    expect(await guarded.project({ maxBatches: 1 })).toMatchObject({
      code: 'SPANS_ARCHIVE_WRITE_UNKNOWN',
      ok: false,
    });
    expect(projectionState(spansRoot).cache).toMatchObject({ ok: true });
    expect(gate.nestedCalls).toEqual([]);
  });
});
