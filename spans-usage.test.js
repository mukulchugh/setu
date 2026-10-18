import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openSpansStore } from './spans-store.js';
import { createSpansUsage } from './spans-usage.js';

const roots = [];
const stores = [];
function open(root = mkdtempSync(join(tmpdir(), 'spans-usage-'))) {
  if (!roots.includes(root)) {
    roots.push(root);
  }
  const store = openSpansStore({ root });
  stores.push(store);
  return { root, store };
}
function seed(store) {
  return store.commitRun({
    events: [],
    expectedGeneration: 0,
    expectedRevision: 0,
    runId: 'run-1',
    view: {
      actions: {},
      checkpoint: 0,
      generation: 0,
      runId: 'run-1',
      spans: {},
    },
  });
}
function request(overrides = {}) {
  return {
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
    ...overrides,
  };
}
afterEach(() => {
  for (const store of stores.splice(0)) {
    store.close();
  }
  for (const root of roots.splice(0)) {
    rmSync(root, { force: true, recursive: true });
  }
});

test('real store atomically reserves, retries stale revisions, and reopens held usage', async () => {
  const { root, store } = open();
  expect(seed(store).ok).toBe(true);
  const usage = createSpansUsage({ store });
  const results = await Promise.all([
    usage.reserve(request()),
    usage.reserve(
      request({
        actionId: 'action-2',
        attemptId: 'attempt-2',
        reservationId: 'reservation-2',
        reservationMicro: 60,
      })
    ),
  ]);
  expect(results.filter((result) => result.ok)).toHaveLength(1);
  expect(results.find((result) => !result.ok)).toMatchObject({
    code: 'SPANS_USAGE_CAP',
  });
  const first = results.find((result) => result.ok);
  expect(await usage.reserve(request())).toMatchObject({
    duplicate: true,
    ok: true,
  });
  expect(
    await usage.reserve(request({ attemptId: 'attempt-2' }))
  ).toMatchObject({ code: 'SPANS_USAGE_CONFLICT', ok: false });
  expect(await usage.reserve(request({ generation: 3 }))).toMatchObject({
    code: 'SPANS_USAGE_STALE',
    ok: false,
  });
  expect(
    await usage.reconcile({
      actionId: 'action-1',
      actualMicro: null,
      attemptId: 'attempt-1',
      generation: 0,
      outcome: 'unknown',
      reservationId: 'reservation-1',
      runId: 'run-1',
      terminalPolicy: true,
      verifiedNoEffect: false,
    })
  ).toMatchObject({ code: 'SPANS_USAGE_HELD', held: true, ok: false });
  expect(
    await usage.reconcile({
      actionId: 'action-1',
      actualMicro: 20,
      attemptId: 'attempt-1',
      generation: 0,
      outcome: 'unknown',
      reservationId: 'reservation-1',
      runId: 'run-1',
      terminalPolicy: false,
      verifiedNoEffect: false,
    })
  ).toMatchObject({
    actualMicro: 20,
    code: 'SPANS_USAGE_HELD',
    held: true,
    ok: false,
  });
  expect(
    await usage.reconcile({
      actionId: 'action-1',
      actualMicro: 10,
      attemptId: 'attempt-1',
      generation: 0,
      outcome: 'completed',
      reservationId: 'reservation-1',
      runId: 'run-1',
      terminalPolicy: true,
      verifiedNoEffect: false,
    })
  ).toMatchObject({ code: 'SPANS_USAGE_REGRESSION', ok: false });
  expect(await usage.readAggregate({ runId: 'run-1' })).toMatchObject({
    heldCount: 1,
    knownActualCount: 1,
    ok: true,
    outstandingReservationMicro: 40,
    runActualMicro: 20,
    runExposureMicro: 60,
    runId: 'run-1',
    scope: 'run',
  });
  expect(first.ok).toBe(true);
  stores.pop().close();
  const reopened = open(root).store;
  expect(
    reopened.readRun({ runId: 'run-1' }).view.usage.reservations[
      'reservation-1'
    ]
  ).toMatchObject({ actualMicro: 20, state: 'held' });
});

test('bounds, unknown price/enforcement, terminal release, retry identity and overflow fail closed', async () => {
  const { store } = open();
  seed(store);
  const usage = createSpansUsage({ store });
  expect(await usage.reserve(request())).toMatchObject({ ok: true });
  expect(
    await usage.reserve(
      request({ reservationMicro: Number.MAX_SAFE_INTEGER + 1 })
    )
  ).toMatchObject({ code: 'SPANS_USAGE_INVALID', ok: false });
  expect(
    await usage.reserve(
      request({
        actionId: 'cap-action',
        attemptId: 'cap-attempt',
        reservationId: 'over-attempt',
        reservationMicro: 90,
      })
    )
  ).toMatchObject({ code: 'SPANS_USAGE_CAP', ok: false });
  expect(
    await usage.reserve(
      request({
        actionId: 'unknown-action',
        attemptId: 'unknown-attempt',
        priceKnown: false,
        reservationId: 'unknown-price',
      })
    )
  ).toMatchObject({ code: 'SPANS_USAGE_HELD', held: true, ok: false });
  expect(
    await usage.reserve(
      request({
        actionId: 'action-2',
        attemptId: 'attempt-2',
        reservationId: 'blocked-by-unknown',
        reservationMicro: 1,
      })
    )
  ).toMatchObject({ code: 'SPANS_USAGE_HELD', ok: false });
  expect(
    await usage.reconcile({
      actionId: 'unknown-action',
      actualMicro: null,
      attemptId: 'unknown-attempt',
      generation: 0,
      outcome: 'unknown',
      reservationId: 'unknown-price',
      runId: 'run-1',
      terminalPolicy: false,
      verifiedNoEffect: true,
    })
  ).toMatchObject({ ok: true, released: true });
  expect(
    await usage.reserve(
      request({
        actionId: 'enforcement-action',
        attemptId: 'enforcement-attempt',
        enforcementAvailable: false,
        reservationId: 'unknown-enforcement',
      })
    )
  ).toMatchObject({ code: 'SPANS_USAGE_HELD', held: true, ok: false });
  expect(
    await usage.reconcile({
      actionId: 'enforcement-action',
      actualMicro: null,
      attemptId: 'enforcement-attempt',
      generation: 0,
      outcome: 'unknown',
      reservationId: 'unknown-enforcement',
      runId: 'run-1',
      terminalPolicy: false,
      verifiedNoEffect: true,
    })
  ).toMatchObject({ ok: true, released: true });
  expect(
    await usage.reconcile({
      actionId: 'action-1',
      actualMicro: 10,
      attemptId: 'attempt-1',
      generation: 0,
      outcome: 'completed',
      reservationId: 'reservation-1',
      runId: 'run-1',
      terminalPolicy: true,
      verifiedNoEffect: false,
    })
  ).toMatchObject({ ok: true, released: true });
  expect(
    await usage.reserve(
      request({
        actionId: 'action-2',
        attemptId: 'attempt-2',
        reservationId: 'retry-1',
        reservationMicro: 80,
      })
    )
  ).toMatchObject({ ok: true });
  expect(
    await usage.reconcile({
      actionId: 'action-2',
      actualMicro: 10,
      attemptId: 'attempt-2',
      generation: 0,
      outcome: 'completed',
      reservationId: 'retry-1',
      runId: 'run-1',
      terminalPolicy: true,
      verifiedNoEffect: false,
    })
  ).toMatchObject({ ok: true });
  expect(
    await usage.reconcile({
      actionId: 'action-2',
      actualMicro: 10,
      attemptId: 'attempt-2',
      generation: 0,
      outcome: 'completed',
      reservationId: 'retry-1',
      runId: 'run-1',
      terminalPolicy: true,
      verifiedNoEffect: false,
    })
  ).toMatchObject({ ok: true, released: true });
  expect(
    await usage.reconcile({
      actionId: 'action-2',
      actualMicro: null,
      attemptId: 'attempt-2',
      generation: 0,
      outcome: 'failed',
      reservationId: 'retry-1',
      runId: 'run-1',
      terminalPolicy: false,
      verifiedNoEffect: false,
    })
  ).toMatchObject({ code: 'SPANS_USAGE_CONTRADICTION', ok: false });
  expect(
    await usage.reconcile({
      actionId: 'action-2',
      actualMicro: 10,
      attemptId: 'attempt-2',
      generation: 0,
      outcome: 'completed',
      reservationId: 'retry-1',
      runId: 'run-1',
      terminalPolicy: true,
      verifiedNoEffect: false,
    })
  ).toMatchObject({ actualMicro: 10, ok: true, released: true });
  expect(
    await usage.reserve(
      request({
        actionId: 'action-3',
        attemptId: 'attempt-3',
        reservationId: 'aggregate-bound',
        reservationMicro: 40,
      })
    )
  ).toMatchObject({ ok: true });
  expect(
    await usage.reserve(
      request({
        actionId: 'action-4',
        attemptId: 'attempt-4',
        reservationId: 'overflow',
        reservationMicro: 41,
      })
    )
  ).toMatchObject({ code: 'SPANS_USAGE_CAP', ok: false });
});

test('consumed usage stays in the run aggregate after release', async () => {
  const { store } = open();
  seed(store);
  const usage = createSpansUsage({ store });
  expect(
    await usage.reserve(
      request({
        aggregateLimitMicro: 100,
        attemptLimitMicro: 100,
        reservationMicro: 90,
      })
    )
  ).toMatchObject({ dispatchAuthorized: true, ok: true });
  expect(
    await usage.reconcile({
      actionId: 'action-1',
      actualMicro: 90,
      attemptId: 'attempt-1',
      generation: 0,
      outcome: 'completed',
      reservationId: 'reservation-1',
      runId: 'run-1',
      terminalPolicy: true,
      verifiedNoEffect: false,
    })
  ).toMatchObject({ ok: true, released: true });
  expect(
    await usage.reserve(
      request({
        actionId: 'action-2',
        aggregateLimitMicro: 100,
        attemptId: 'attempt-2',
        attemptLimitMicro: 100,
        reservationId: 'reservation-2',
        reservationMicro: 90,
      })
    )
  ).toMatchObject({ code: 'SPANS_USAGE_CAP', ok: false });
  expect(await usage.readAggregate({ runId: 'run-1' })).toMatchObject({
    runActualMicro: 90,
    runExposureMicro: 90,
    scope: 'run',
  });
});

test('actual usage above reservation counts and a later attempt stays within the policy', async () => {
  const { store } = open();
  seed(store);
  const usage = createSpansUsage({ store });
  expect(
    await usage.reserve(
      request({
        aggregateLimitMicro: 100,
        attemptLimitMicro: 100,
        reservationMicro: 20,
      })
    )
  ).toMatchObject({ dispatchAuthorized: true, ok: true });
  expect(
    await usage.reconcile({
      actionId: 'action-1',
      actualMicro: 90,
      attemptId: 'attempt-1',
      generation: 0,
      outcome: 'completed',
      reservationId: 'reservation-1',
      runId: 'run-1',
      terminalPolicy: true,
      verifiedNoEffect: false,
    })
  ).toMatchObject({ ok: true, released: true });
  expect(
    await usage.reserve(
      request({
        actionId: 'action-2',
        aggregateLimitMicro: 100,
        attemptId: 'attempt-2',
        attemptLimitMicro: 100,
        reservationId: 'reservation-2',
        reservationMicro: 11,
      })
    )
  ).toMatchObject({ code: 'SPANS_USAGE_CAP', ok: false });
});

test('one attempt binds to one reservation and per-run limits cannot change', async () => {
  const { store } = open();
  seed(store);
  const usage = createSpansUsage({ store });
  expect(await usage.reserve(request())).toMatchObject({
    dispatchAuthorized: true,
    ok: true,
  });
  expect(
    await usage.reserve(request({ reservationId: 'second-reservation' }))
  ).toMatchObject({ code: 'SPANS_USAGE_CONFLICT', ok: false });
  expect(
    await usage.reserve(
      request({
        actionId: 'action-2',
        aggregateLimitMicro: 101,
        attemptId: 'attempt-2',
        reservationId: 'another-attempt',
      })
    )
  ).toMatchObject({ code: 'SPANS_USAGE_CONFLICT', ok: false });
  expect(
    await usage.reserve(
      request({
        actionId: 'action-2',
        attemptId: 'attempt-2',
        hardCap: false,
        reservationId: 'different-hard-cap',
      })
    )
  ).toMatchObject({ code: 'SPANS_USAGE_CONFLICT', ok: false });
  expect(await usage.reserve(request())).toMatchObject({
    dispatchAuthorized: false,
    duplicate: true,
    ok: true,
  });
});

test('malformed usage state refuses reads and writes', async () => {
  const { store } = open();
  seed(store);
  const current = store.readRun({ runId: 'run-1' });
  expect(
    store.commitRun({
      events: [],
      expectedGeneration: 0,
      expectedRevision: current.revision,
      runId: 'run-1',
      view: { ...current.view, usage: 'corrupt' },
    }).ok
  ).toBe(true);
  const usage = createSpansUsage({ store });
  expect(await usage.readAggregate({ runId: 'run-1' })).toMatchObject({
    code: 'SPANS_USAGE_READ',
    ok: false,
  });
  expect(await usage.reserve(request())).toMatchObject({
    code: 'SPANS_USAGE_READ',
    ok: false,
  });
});

test('verified no effect cannot contradict positive usage', async () => {
  const { store } = open();
  seed(store);
  const usage = createSpansUsage({ store });
  expect(await usage.reserve(request())).toMatchObject({ ok: true });
  expect(
    await usage.reconcile({
      actionId: 'action-1',
      actualMicro: 1,
      attemptId: 'attempt-1',
      generation: 0,
      outcome: 'completed',
      reservationId: 'reservation-1',
      runId: 'run-1',
      terminalPolicy: true,
      verifiedNoEffect: true,
    })
  ).toMatchObject({ code: 'SPANS_USAGE_CONTRADICTION', ok: false });
});

test('released usage accepts monotonic actual updates and rejects a conflicting outcome', async () => {
  const { store } = open();
  seed(store);
  const usage = createSpansUsage({ store });
  expect(await usage.reserve(request())).toMatchObject({ ok: true });
  const receipt = {
    actionId: 'action-1',
    actualMicro: 10,
    attemptId: 'attempt-1',
    generation: 0,
    outcome: 'completed',
    reservationId: 'reservation-1',
    runId: 'run-1',
    terminalPolicy: true,
    verifiedNoEffect: false,
  };
  expect(await usage.reconcile(receipt)).toMatchObject({
    actualMicro: 10,
    ok: true,
    released: true,
  });
  expect(await usage.reconcile({ ...receipt, actualMicro: 15 })).toMatchObject({
    actualMicro: 15,
    ok: true,
    released: true,
  });
  expect(
    await usage.reconcile({ ...receipt, actualMicro: 20, outcome: 'failed' })
  ).toMatchObject({ code: 'SPANS_USAGE_CONTRADICTION', ok: false });
  expect(await usage.readAggregate({ runId: 'run-1' })).toMatchObject({
    runActualMicro: 15,
    runExposureMicro: 15,
    scope: 'run',
  });
});

test('unknown price holds a finite reservation when hard caps are disabled', async () => {
  const { store } = open();
  seed(store);
  const usage = createSpansUsage({ store });
  expect(
    await usage.reserve(request({ hardCap: false, priceKnown: false }))
  ).toMatchObject({ code: 'SPANS_USAGE_HELD', held: true, ok: false });
  expect(
    store.readRun({ runId: 'run-1' }).view.usage.reservations['reservation-1']
  ).toMatchObject({ held: true, state: 'held' });
});

test('validated reservation values are snapshotted before asynchronous store reads', async () => {
  const { store } = open();
  seed(store);
  let releaseRead;
  const gatedStore = {
    commitRun: (...args) => store.commitRun(...args),
    readRun: (...args) =>
      new Promise((resolve) => {
        releaseRead = () => resolve(store.readRun(...args));
      }),
  };
  const usage = createSpansUsage({ store: gatedStore });
  const requestInput = request();
  const pending = usage.reserve(requestInput);
  requestInput.reservationMicro = 1;
  requestInput.aggregateLimitMicro = 1;
  requestInput.hardCap = false;
  releaseRead();
  expect(await pending).toMatchObject({ dispatchAuthorized: true, ok: true });
  expect(
    store.readRun({ runId: 'run-1' }).view.usage.reservations['reservation-1']
  ).toMatchObject({ reservationMicro: 60 });
  expect(store.readRun({ runId: 'run-1' }).view.usage.policy).toMatchObject({
    aggregateLimitMicro: 100,
    hardCap: true,
  });
});

test('verified no effect cannot erase previously observed positive usage', async () => {
  const { store } = open();
  seed(store);
  const usage = createSpansUsage({ store });
  expect(await usage.reserve(request())).toMatchObject({ ok: true });
  expect(
    await usage.reconcile({
      actionId: 'action-1',
      actualMicro: 4,
      attemptId: 'attempt-1',
      generation: 0,
      outcome: 'unknown',
      reservationId: 'reservation-1',
      runId: 'run-1',
      terminalPolicy: false,
      verifiedNoEffect: false,
    })
  ).toMatchObject({ code: 'SPANS_USAGE_HELD', held: true, ok: false });
  expect(
    await usage.reconcile({
      actionId: 'action-1',
      actualMicro: null,
      attemptId: 'attempt-1',
      generation: 0,
      outcome: 'failed',
      reservationId: 'reservation-1',
      runId: 'run-1',
      terminalPolicy: true,
      verifiedNoEffect: true,
    })
  ).toMatchObject({ code: 'SPANS_USAGE_CONTRADICTION', ok: false });
  expect(await usage.readAggregate({ runId: 'run-1' })).toMatchObject({
    heldCount: 1,
    runActualMicro: 4,
  });
});

test('malformed reservation rows and missing policy fail closed before reservation decisions', async () => {
  const malformed = [
    {
      policy: {
        aggregateLimitMicro: 100,
        attemptLimitMicro: 80,
        hardCap: true,
      },
      reservations: {
        bad: {
          actionId: 'action-old',
          actualMicro: null,
          attemptId: 'attempt-old',
          fingerprint: [
            'run-1',
            'action-old',
            'attempt-old',
            null,
            100,
            80,
            true,
            true,
            true,
          ],
          held: false,
          reservationMicro: null,
          state: 'reserved',
        },
      },
    },
    {
      reservations: {
        bad: {
          actionId: 'action-old',
          actualMicro: null,
          attemptId: 'attempt-old',
          fingerprint: [
            'run-1',
            'action-old',
            'attempt-old',
            10,
            100,
            80,
            true,
            true,
            true,
          ],
          held: false,
          reservationMicro: 10,
          state: 'reserved',
        },
      },
    },
  ];
  await Promise.all(
    malformed.map(async (usageState) => {
      const { store } = open();
      seed(store);
      const current = store.readRun({ runId: 'run-1' });
      expect(
        store.commitRun({
          events: [],
          expectedGeneration: 0,
          expectedRevision: current.revision,
          runId: 'run-1',
          view: { ...current.view, usage: usageState },
        }).ok
      ).toBe(true);
      const usage = createSpansUsage({ store });
      expect(
        await usage.reserve(request({ reservationId: 'bad' }))
      ).toMatchObject({ code: 'SPANS_USAGE_READ', ok: false });
      expect(await usage.readAggregate({ runId: 'run-1' })).toMatchObject({
        code: 'SPANS_USAGE_READ',
        ok: false,
      });
    })
  );
});

test('aggregate exposes unknown usage coverage and does not report unbounded exposure as zero', async () => {
  const { store } = open();
  seed(store);
  const usage = createSpansUsage({ store });
  expect(
    await usage.reserve(request({ enforcementAvailable: false }))
  ).toMatchObject({ held: true, ok: false });
  expect(await usage.readAggregate({ runId: 'run-1' })).toMatchObject({
    actualComplete: false,
    knownActualCount: 0,
    outstandingReservationMicro: 60,
    runExposureMicro: null,
    unknownActualCount: 1,
  });
  const { store: unboundedStore } = open();
  seed(unboundedStore);
  const unboundedUsage = createSpansUsage({ store: unboundedStore });
  expect(
    await unboundedUsage.reserve(request({ reservationMicro: null }))
  ).toMatchObject({ held: true, ok: false });
  expect(await unboundedUsage.readAggregate({ runId: 'run-1' })).toMatchObject({
    actualComplete: false,
    runExposureMicro: null,
    unknownActualCount: 1,
  });
});

test('aggregate refuses overflow while summing outstanding reservations', async () => {
  const { store } = open();
  seed(store);
  const current = store.readRun({ runId: 'run-1' });
  const reservation = (actionId, attemptId) => ({
    actionId,
    actualMicro: null,
    attemptId,
    fingerprint: [
      'run-1',
      actionId,
      attemptId,
      Number.MAX_SAFE_INTEGER,
      Number.MAX_SAFE_INTEGER,
      Number.MAX_SAFE_INTEGER,
      true,
      true,
      true,
    ],
    held: false,
    reservationMicro: Number.MAX_SAFE_INTEGER,
    state: 'reserved',
  });
  const usageState = {
    policy: {
      aggregateLimitMicro: Number.MAX_SAFE_INTEGER,
      attemptLimitMicro: Number.MAX_SAFE_INTEGER,
      hardCap: true,
    },
    reservations: {
      first: reservation('action-first', 'attempt-first'),
      second: reservation('action-second', 'attempt-second'),
    },
  };
  expect(
    store.commitRun({
      events: [],
      expectedGeneration: 0,
      expectedRevision: current.revision,
      runId: 'run-1',
      view: { ...current.view, usage: usageState },
    }).ok
  ).toBe(true);
  expect(
    await createSpansUsage({ store }).readAggregate({ runId: 'run-1' })
  ).toMatchObject({ code: 'SPANS_USAGE_READ', ok: false });
});

test('secret field names cannot become reservation keys and corrupt the run', async () => {
  const { store } = open();
  expect(seed(store).ok).toBe(true);
  const usage = createSpansUsage({ store });
  const before = store.readRun({ runId: 'run-1' });
  expect(
    await usage.reserve(request({ reservationId: 'password' }))
  ).toMatchObject({
    code: 'SPANS_USAGE_INVALID',
    ok: false,
  });
  expect(store.readRun({ runId: 'run-1' })).toEqual(before);
  expect(await usage.reserve(request())).toMatchObject({
    dispatchAuthorized: true,
    ok: true,
  });
});

// A policy with no limits and no hard cap measures no money: a subscription
// run reserves nothing and claims no cap. Callers that give limits or require a
// hard cap keep every rule above.
const UNMETERED = {
  aggregateLimitMicro: null,
  attemptLimitMicro: null,
  enforcementAvailable: false,
  hardCap: false,
  priceKnown: false,
  reservationMicro: null,
};
const settleInput = (overrides = {}) => ({
  actionId: 'action-1',
  actualMicro: null,
  attemptId: 'attempt-1',
  generation: 0,
  outcome: 'completed',
  reservationId: 'reservation-1',
  runId: 'run-1',
  terminalPolicy: true,
  verifiedNoEffect: false,
  ...overrides,
});

test('an unmetered reservation needs no amount, price or cap, and a terminal outcome releases it', async () => {
  const { store } = open();
  seed(store);
  const usage = createSpansUsage({ store });

  const reserved = await usage.reserve(request(UNMETERED));
  expect(reserved).toMatchObject({
    dispatchAuthorized: true,
    held: false,
    ok: true,
  });
  const active = await usage.readAggregate({ runId: 'run-1' });
  expect(active).toMatchObject({
    actualComplete: false,
    outstandingReservationMicro: 0,
    runExposureMicro: null,
    unknownActualCount: 1,
  });

  // An unknown outcome still keeps it held.
  expect(
    await usage.reconcile(settleInput({ outcome: 'unknown' }))
  ).toMatchObject({ code: 'SPANS_USAGE_HELD', held: true, ok: false });

  expect(await usage.reconcile(settleInput())).toMatchObject({
    actualMicro: null,
    ok: true,
    released: true,
  });
  // The totals say how many reservations measured no money.
  expect(await usage.readAggregate({ runId: 'run-1' })).toMatchObject({
    actualComplete: true,
    runActualMicro: 0,
    unmeteredCount: 1,
  });
});

test('limits or a hard cap keep every strict rule, with or without an amount', async () => {
  const strict = [
    // A hard cap with no amount is held, as before.
    [
      {
        ...UNMETERED,
        enforcementAvailable: true,
        hardCap: true,
        priceKnown: true,
      },
      'held',
    ],
    // Explicit limits with no amount cannot be checked, so they are refused.
    [
      {
        ...UNMETERED,
        aggregateLimitMicro: 100,
        attemptLimitMicro: 80,
        priceKnown: true,
      },
      'SPANS_USAGE_CAP',
    ],
    // One limit given and one not does not make the policy unmetered.
    [
      { ...UNMETERED, aggregateLimitMicro: 100, priceKnown: true },
      'SPANS_USAGE_CAP',
    ],
  ];
  for (const [overrides, expected] of strict) {
    const { store } = open();
    seed(store);
    const usage = createSpansUsage({ store });
    // biome-ignore lint/performance/noAwaitInLoops: Each case uses its own store, so they run in order.
    const result = await usage.reserve(request(overrides));
    if (expected === 'held') {
      expect(result).toMatchObject({ held: true, ok: false });
    } else {
      expect(result).toMatchObject({ code: expected, ok: false });
    }
  }
});

test('an unmetered policy cannot be mixed with a limited one, and a no-amount release stays in the old rules', async () => {
  const { store } = open();
  seed(store);
  const usage = createSpansUsage({ store });
  await usage.reserve(request(UNMETERED));
  expect(
    await usage.reserve(
      request({
        actionId: 'action-2',
        attemptId: 'attempt-2',
        reservationId: 'reservation-2',
      })
    )
  ).toMatchObject({ code: 'SPANS_USAGE_CONFLICT', ok: false });

  // A metered run still cannot release without an amount.
  const metered = open();
  seed(metered.store);
  const limited = createSpansUsage({ store: metered.store });
  await limited.reserve(request());
  expect(await limited.reconcile(settleInput())).toMatchObject({
    code: 'SPANS_USAGE_HELD',
    ok: false,
  });
});
