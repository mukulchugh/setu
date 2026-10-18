import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSpansArtifacts } from './spans-artifacts.js';
import { SPANS_DISPATCH_ADAPTERS } from './spans-dispatch.js';
import { createSpansDrafts } from './spans-drafts.js';
import {
  createSpansExecutionUsage,
  SPANS_EXEC_USAGE_METHODS,
  usageReservationId,
} from './spans-execution-usage.js';
import { openSpansStore } from './spans-store.js';
import { createSpansUsage } from './spans-usage.js';

// Contract tests for the usage adapter that stands behind the dispatch
// coordinator's `usage` slot. The ledger, the store and the artifacts are the
// real modules; only the execution record and the profile facts are supplied.

const RUN = 'run-1';
const ACTION = 'action-1';
const ATTEMPT = 'attempt-1';
const REQUEST = Object.freeze({
  actionId: ACTION,
  attemptId: ATTEMPT,
  profile: 'claude-code-sonnet',
  runId: RUN,
  spanId: 'build',
});
const ENFORCED = Object.freeze({
  enforcementAvailable: true,
  priceKnown: true,
});

let root;
let store;
afterEach(() => {
  store?.close();
  store = undefined;
  rmSync(root, { force: true, recursive: true });
});

function setup({
  facts = ENFORCED,
  ledger,
  limits = { aggregateLimitMicro: 2_000_000, attemptLimitMicro: 1_000_000 },
  budgetMicro = 500_000,
} = {}) {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'setu-usage-contract-')));
  const archive = join(root, 'archive');
  mkdirSync(archive, { mode: 0o700 });
  store = openSpansStore({ root: archive });
  createSpansDrafts({ store }).createRun({
    goal: 'g',
    owner: 'o',
    runId: RUN,
    spans: [{ dependencies: [], spanId: 'build', title: 'Build' }],
  });
  const artifacts = createSpansArtifacts({ root: archive });
  const adapter = createSpansExecutionUsage({
    artifacts,
    executionOf: () => ({ budgetMicro }),
    facts: () => facts,
    ledger: ledger ?? createSpansUsage({ store }),
    limits,
    store,
  });
  return { adapter, artifacts };
}

// Records an exited attempt whose captured output is `text`.
function captured(artifacts, text) {
  const stored = artifacts.put({ mediaType: 'text/plain', text });
  const read = store.readRun({ runId: RUN });
  const view = {
    ...read.view,
    attempts: {
      [ATTEMPT]: { receipt: { capture: { artifactId: stored.artifactId } } },
    },
  };
  const committed = store.commitRun({
    events: [],
    expectedGeneration: read.generation,
    expectedRevision: read.revision,
    runId: RUN,
    view,
  });
  expect(committed.ok).toBe(true);
}

const ledgerRow = () =>
  createSpansUsage({ store }).readAggregate({ runId: RUN });

const resultLine = (cost) =>
  `${JSON.stringify({ is_error: false, subtype: 'success', total_cost_usd: cost, type: 'result' })}\n`;

describe('the dispatch usage contract', () => {
  test('implements exactly the methods the coordinator requires', () => {
    const { adapter } = setup();
    for (const method of SPANS_DISPATCH_ADAPTERS.usage) {
      expect(typeof adapter[method]).toBe('function');
    }
    expect([...SPANS_EXEC_USAGE_METHODS].sort()).toEqual(
      [...SPANS_DISPATCH_ADAPTERS.usage].sort()
    );
  });

  test('reserve holds one reservation and a repeat reports the existing one', async () => {
    const { adapter } = setup();
    const first = await adapter.reserve({
      ...REQUEST,
      operationId: 'op-1',
      profileDigest: 'd',
    });
    expect(first).toEqual({
      cap: 'enforced',
      existing: false,
      ok: true,
      reservationId: usageReservationId(RUN, ACTION),
    });
    const again = await adapter.reserve({
      ...REQUEST,
      operationId: 'op-1',
      profileDigest: 'd',
    });
    expect(again).toMatchObject({ existing: true, ok: true });
    expect(await ledgerRow()).toMatchObject({
      outstandingReservationMicro: 500_000,
    });
  });

  test('reserve fails, never succeeds, when spend cannot be bound', async () => {
    const overAttempt = setup({ budgetMicro: 1_500_000 });
    expect(await overAttempt.adapter.reserve({ ...REQUEST })).toEqual({
      code: 'BUDGET_EXCEEDED',
      ok: false,
    });
    store.close();
    rmSync(root, { force: true, recursive: true });

    const unenforced = setup({
      facts: { enforcementAvailable: false, priceKnown: true },
    });
    expect(await unenforced.adapter.reserve({ ...REQUEST })).toEqual({
      code: 'PRICE_UNKNOWN',
      ok: false,
    });
    store.close();
    rmSync(root, { force: true, recursive: true });

    const unpriced = setup({
      facts: { enforcementAvailable: true, priceKnown: false },
    });
    expect(await unpriced.adapter.reserve({ ...REQUEST })).toMatchObject({
      ok: false,
    });
  });

  test('reserve fails when the run total would pass its explicit bound', async () => {
    const { adapter } = setup({
      limits: { aggregateLimitMicro: 600_000, attemptLimitMicro: 1_000_000 },
    });
    expect((await adapter.reserve({ ...REQUEST })).ok).toBe(true);
    const second = await adapter.reserve({
      ...REQUEST,
      actionId: 'action-2',
      attemptId: 'attempt-2',
    });
    expect(second).toEqual({ code: 'BUDGET_EXCEEDED', ok: false });
  });

  test('release of a launch that never happened frees the reservation, repeatably', async () => {
    const { adapter } = setup();
    await adapter.reserve({ ...REQUEST });
    expect(await adapter.release({ ...REQUEST, reason: 'unlaunched' })).toEqual(
      { ok: true }
    );
    expect(await ledgerRow()).toMatchObject({
      outstandingReservationMicro: 0,
      runActualMicro: 0,
    });
    expect(await adapter.release({ ...REQUEST, reason: 'unlaunched' })).toEqual(
      { ok: true }
    );
  });

  test('a released reservation is finished accounting: reserving it again is refused and changes nothing', async () => {
    const { adapter } = setup();
    await adapter.reserve({ ...REQUEST });
    await adapter.release({ ...REQUEST, reason: 'unlaunched' });
    const before = JSON.stringify(store.readRun({ runId: RUN }).view.usage);

    expect(await adapter.reserve({ ...REQUEST })).toEqual({
      code: 'RESERVATION_CONFLICT',
      ok: false,
    });
    expect(JSON.stringify(store.readRun({ runId: RUN }).view.usage)).toBe(
      before
    );
  });

  test('settle records the cost the captured output reported and frees the reservation', async () => {
    const { adapter, artifacts } = setup();
    await adapter.reserve({ ...REQUEST });
    captured(artifacts, `noise\n${resultLine(0.0125)}`);
    const settled = await adapter.settle({
      ...REQUEST,
      evidenceId: 'evidence-1',
      outcome: 'completed',
    });
    expect(settled).toEqual({ actualMicro: 12_500, ok: true });
    expect(await ledgerRow()).toMatchObject({
      actualComplete: true,
      outstandingReservationMicro: 0,
      runActualMicro: 12_500,
    });
  });

  test('settle fails and keeps the reservation when no cost can be verified', async () => {
    const { adapter, artifacts } = setup();
    await adapter.reserve({ ...REQUEST });
    // No attempt record at all, then an artifact without a reported cost.
    expect(
      await adapter.settle({
        ...REQUEST,
        evidenceId: 'e',
        outcome: 'completed',
      })
    ).toEqual({ ok: false });
    captured(artifacts, 'the model said it was done\n');
    expect(
      await adapter.settle({
        ...REQUEST,
        evidenceId: 'e',
        outcome: 'completed',
      })
    ).toEqual({ ok: false });
    expect(await ledgerRow()).toMatchObject({
      actualComplete: false,
      outstandingReservationMicro: 500_000,
    });
  });

  test('a ledger that cannot answer is a failure, not a no-op', async () => {
    const broken = {
      readAggregate: () => ({ ok: false }),
      reconcile: () => Promise.reject(new Error('disk gone')),
      reserve: () => Promise.resolve(undefined),
    };
    const { adapter, artifacts } = setup({ ledger: broken });
    captured(artifacts, resultLine(0.01));
    expect((await adapter.reserve({ ...REQUEST })).ok).toBe(false);
    expect(await adapter.release({ ...REQUEST })).toEqual({ ok: false });
    expect(
      await adapter.settle({
        ...REQUEST,
        evidenceId: 'e',
        outcome: 'completed',
      })
    ).toEqual({ ok: false });
  });

  test('every method refuses a stale or unknown run', async () => {
    const { adapter } = setup();
    const ghost = { ...REQUEST, runId: 'ghost' };
    expect((await adapter.reserve(ghost)).ok).toBe(false);
    expect(await adapter.release(ghost)).toEqual({ ok: false });
    expect(
      await adapter.settle({ ...ghost, evidenceId: 'e', outcome: 'completed' })
    ).toEqual({
      ok: false,
    });
  });
});
