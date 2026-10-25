import { afterEach, describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { targetDigestFor } from './spans-dispatch.js';
import { createSpansDrafts } from './spans-drafts.js';
import { createSpansExecutionConfirmation } from './spans-execution-confirmation.js';
import { createSpansExecutionReviews } from './spans-execution-review.js';
import { openSpansStore } from './spans-store.js';

const CHALLENGE_ID = /^[a-f0-9]{64}$/;
const roots = new Set();
const stores = new Set();

afterEach(() => {
  for (const store of stores) {
    store.close();
    stores.delete(store);
  }
  for (const root of roots) {
    fs.rmSync(root, { force: true, recursive: true });
    roots.delete(root);
  }
});

function nextRandomBytes() {
  let next = 1;
  return (length) => {
    const current = next;
    next += 1;
    return Buffer.alloc(length, current);
  };
}

function binding(selector) {
  const expected = {
    dependency: {
      bunVersion: '1.3.14',
      linkerMode: 'isolated',
      lockfileHash: '1'.repeat(64),
      platformNamespace: 'darwin-arm64',
    },
    dirty: { count: 0, hash: '2'.repeat(64) },
    head: 'a'.repeat(40),
    identity: {
      admin: { birthtimeNs: '1', dev: '1', ino: '1' },
      adminPath: '/tmp/fixture/repo/worktrees/feat/spans',
      checkout: { birthtimeNs: '2', dev: '1', ino: '2' },
      checkoutPath: '/tmp/fixture/repo/feat/spans',
      known: true,
      repository: { birthtimeNs: '3', dev: '1', ino: '3' },
      repositoryPath: '/tmp/fixture/repo',
    },
  };
  return {
    actionId: selector.actionId,
    admission: { kind: 'headless-run', policyDigest: '3'.repeat(64) },
    attemptId: selector.attemptId,
    checkout: {
      expected,
      repoDir: '/tmp/fixture/repo',
      wtDir: '/tmp/fixture/repo/feat/spans',
    },
    digests: {
      dependencies: '4'.repeat(64),
      dirty: '2'.repeat(64),
      head: '6'.repeat(64),
      lockfile: '1'.repeat(64),
    },
    executionVersion: 1,
    generation: selector.generation,
    inputArtifact: { digest: '8'.repeat(64), id: `sha256:${'9'.repeat(64)}` },
    planVersion: selector.planVersion,
    policy: {
      attempt: 0,
      attemptTimeoutMs: 1_800_000,
      capture: 'full-stop',
      effort: 'high',
      maxWorkers: 2,
      model: 'gpt-6-luna',
      provider: 'codex',
      retries: 0,
      subscriptionOnly: true,
    },
    profile: {
      digest: 'a'.repeat(64),
      effort: 'high',
      id: 'codex:gpt-6-luna:high',
      model: 'gpt-6-luna',
      provider: 'codex',
    },
    requiredCapabilities: ['run'],
    runId: selector.runId,
    spanId: selector.spanId,
    target: { name: 'feat/spans', repo: 'setu' },
    targetDigest: targetDigestFor(expected),
  };
}

function createService(store, verifyConfirmation, verifyRevocation) {
  return createSpansExecutionReviews({
    resolveBinding: async (selector) => binding(selector),
    store,
    verifyConfirmation,
    verifyRevocation,
    verifyWritable: async () => true,
  });
}

function serviceWithAdapter(store, { now, randomBytes, readReview } = {}) {
  let service;
  const adapter = createSpansExecutionConfirmation({
    now,
    randomBytes,
    readReview: readReview ?? ((request) => service.read(request)),
    store,
  });
  service = createService(store, adapter.verify, adapter.verifyRevocation);
  return { adapter, service };
}

function fixture() {
  const root = fs.mkdtempSync(
    join(tmpdir(), 'setu-spans-execution-confirmation-')
  );
  roots.add(root);
  let store = openSpansStore({ root });
  stores.add(store);
  const drafts = createSpansDrafts({ store });
  drafts.createRun({
    goal: 'Review safely',
    owner: 'test',
    runId: 'confirmation-run',
    spans: [{ dependencies: [], spanId: 'ship', title: 'Ship' }],
  });
  let currentTime = new Date('2026-10-20T10:00:00.000Z');
  const now = () => new Date(currentTime);
  const randomBytes = nextRandomBytes();
  const connected = serviceWithAdapter(store, { now, randomBytes });
  const selector = {
    actionId: 'action-1',
    attemptId: 'attempt-0',
    generation: 0,
    planVersion: 1,
    runId: 'confirmation-run',
    spanId: 'ship',
  };
  return {
    ...connected,
    now,
    randomBytes,
    reopen() {
      store.close();
      store = openSpansStore({ root });
      stores.add(store);
      return store;
    },
    root,
    selector,
    setCurrentTime(value) {
      currentTime = new Date(value);
    },
    get store() {
      return store;
    },
  };
}

async function preparedReview(f) {
  const prepared = await f.service.prepare(f.selector);
  expect(prepared.ok).toBe(true);
  return prepared.review;
}

describe('volatile Spans execution confirmation', () => {
  test('issues an exact typed phrase and returns trusted provenance once without writing', async () => {
    const f = fixture();
    const review = await preparedReview(f);
    const before = f.store.readRun({ runId: f.selector.runId });

    const issued = await f.adapter.issue({
      reviewDigest: review.reviewDigest,
      runId: f.selector.runId,
    });

    expect(issued).toMatchObject({
      ok: true,
      phrase: `Approve ${review.reviewDigest.slice(0, 12)}`,
      reviewDigest: review.reviewDigest,
    });
    expect(issued.challengeId).toMatch(CHALLENGE_ID);
    expect(issued.expiresAt).toBe('2026-10-20T10:05:00.000Z');
    const confirmation = {
      challengeId: issued.challengeId,
      response: issued.phrase,
    };
    const verified = await f.adapter.verify({
      confirmation,
      reviewDigest: review.reviewDigest,
      runId: f.selector.runId,
    });
    expect(verified).toEqual({
      confirmedAt: '2026-10-20T10:00:00.000Z',
      reference: issued.challengeId,
      source: 'portal-human-confirmation',
    });
    expect(
      await f.adapter.verify({
        confirmation,
        reviewDigest: review.reviewDigest,
        runId: f.selector.runId,
      })
    ).toBeNull();
    expect(f.store.readRun({ runId: f.selector.runId }).revision).toBe(
      before.revision
    );
  });

  test('consumes mismatched and expired first-use proofs', async () => {
    const f = fixture();
    const review = await preparedReview(f);
    const issued = await f.adapter.issue({
      reviewDigest: review.reviewDigest,
      runId: f.selector.runId,
    });
    const proof = { challengeId: issued.challengeId, response: issued.phrase };

    expect(
      await f.adapter.verify({
        confirmation: proof,
        reviewDigest: 'f'.repeat(64),
        runId: f.selector.runId,
      })
    ).toBeNull();
    expect(
      await f.adapter.verify({
        confirmation: proof,
        reviewDigest: review.reviewDigest,
        runId: f.selector.runId,
      })
    ).toBeNull();

    const expired = await f.adapter.issue({
      reviewDigest: review.reviewDigest,
      runId: f.selector.runId,
    });
    f.setCurrentTime('2026-10-20T10:05:00.001Z');
    expect(
      await f.adapter.verify({
        confirmation: {
          challengeId: expired.challengeId,
          response: expired.phrase,
        },
        reviewDigest: review.reviewDigest,
        runId: f.selector.runId,
      })
    ).toBeNull();
  });

  test('a proof racing two verifiers is consumed before review I/O', async () => {
    const f = fixture();
    const review = await preparedReview(f);
    let reviewCalls = 0;
    let unblockReview;
    const reviewGate = new Promise((resolve) => {
      unblockReview = resolve;
    });
    const adapter = createSpansExecutionConfirmation({
      now: f.now,
      randomBytes: nextRandomBytes(),
      readReview: async (request) => {
        reviewCalls += 1;
        if (reviewCalls > 1) {
          await reviewGate;
        }
        return f.service.read(request);
      },
      store: f.store,
    });
    const issued = await adapter.issue({
      reviewDigest: review.reviewDigest,
      runId: f.selector.runId,
    });
    const input = {
      confirmation: {
        challengeId: issued.challengeId,
        response: issued.phrase,
      },
      reviewDigest: review.reviewDigest,
      runId: f.selector.runId,
    };
    const first = adapter.verify(input);
    expect(await adapter.verify(input)).toBeNull();
    unblockReview();
    expect(await first).toMatchObject({
      reference: issued.challengeId,
      source: 'portal-human-confirmation',
    });
  });

  test('rejects hostile request objects, caller-shaped provenance and changed review records', async () => {
    const f = fixture();
    const review = await preparedReview(f);
    let getterCalls = 0;
    const accessorInput = {
      reviewDigest: review.reviewDigest,
      get runId() {
        getterCalls += 1;
        return f.selector.runId;
      },
    };
    expect(await f.adapter.issue(accessorInput)).toMatchObject({ ok: false });
    const proxyInput = new Proxy(
      { reviewDigest: review.reviewDigest, runId: f.selector.runId },
      {
        get() {
          getterCalls += 1;
        },
        ownKeys() {
          getterCalls += 1;
          return [];
        },
      }
    );
    expect(await f.adapter.issue(proxyInput)).toMatchObject({ ok: false });
    expect(getterCalls).toBe(0);

    const forged = {
      confirmedAt: '2026-10-20T10:00:00.000Z',
      reference: 'a'.repeat(64),
      source: 'portal-human-confirmation',
    };
    expect(
      await f.adapter.verify({
        confirmation: forged,
        reviewDigest: review.reviewDigest,
        runId: f.selector.runId,
      })
    ).toBeNull();
    expect(
      await f.service.approve({
        confirmation: forged,
        reviewDigest: review.reviewDigest,
        runId: f.selector.runId,
      })
    ).toMatchObject({ ok: false });

    const changedAdapter = createSpansExecutionConfirmation({
      now: f.now,
      randomBytes: nextRandomBytes(),
      readReview: async (request) => {
        const result = await f.service.read(request);
        if (!result.ok) {
          return result;
        }
        return {
          ...result,
          review: {
            ...result.review,
            binding: { ...result.review.binding, actionId: 'changed-action' },
          },
        };
      },
      store: f.store,
    });
    expect(
      await changedAdapter.issue({
        reviewDigest: review.reviewDigest,
        runId: f.selector.runId,
      })
    ).toMatchObject({ ok: false });
  });

  test('persists through the review primitive and replays only its exact receipt after restart', async () => {
    const f = fixture();
    const review = await preparedReview(f);
    const issued = await f.adapter.issue({
      reviewDigest: review.reviewDigest,
      runId: f.selector.runId,
    });
    const approved = await f.service.approve({
      confirmation: {
        challengeId: issued.challengeId,
        response: issued.phrase,
      },
      reviewDigest: review.reviewDigest,
      runId: f.selector.runId,
    });
    expect(approved).toMatchObject({ ok: true });
    const persisted = approved.approval.confirmation;
    expect(persisted).toEqual({
      confirmedAt: '2026-10-20T10:00:00.000Z',
      reference: issued.challengeId,
      source: 'portal-human-confirmation',
    });
    expect(
      await f.service.authorize({
        ...f.selector,
        reviewDigest: review.reviewDigest,
      })
    ).toMatchObject({ ok: true });

    const restartedStore = f.reopen();
    const restarted = serviceWithAdapter(restartedStore, {
      now: f.now,
      randomBytes: nextRandomBytes(),
    });
    expect(
      await restarted.adapter.verify({
        confirmation: persisted,
        reviewDigest: review.reviewDigest,
        runId: f.selector.runId,
      })
    ).toEqual(persisted);
    expect(
      await restarted.service.authorize({
        ...f.selector,
        reviewDigest: review.reviewDigest,
      })
    ).toMatchObject({ ok: true });
    expect(
      await restarted.adapter.verify({
        confirmation: { ...persisted, source: 'caller-claimed' },
        reviewDigest: review.reviewDigest,
        runId: f.selector.runId,
      })
    ).toBeNull();
    expect(
      await restarted.adapter.verify({
        confirmation: persisted,
        reviewDigest: 'f'.repeat(64),
        runId: f.selector.runId,
      })
    ).toBeNull();

    const changedAdapter = createSpansExecutionConfirmation({
      now: f.now,
      randomBytes: nextRandomBytes(),
      readReview: async (request) => {
        const result = await restarted.service.read(request);
        if (!result.ok) {
          return result;
        }
        return {
          ...result,
          review: {
            ...result.review,
            binding: { ...result.review.binding, actionId: 'changed-action' },
          },
        };
      },
      store: restartedStore,
    });
    expect(
      await changedAdapter.verify({
        confirmation: persisted,
        reviewDigest: review.reviewDigest,
        runId: f.selector.runId,
      })
    ).toBeNull();
  });

  test('binds one-use challenges to approve or revoke intent and emits separate proof sources', async () => {
    const f = fixture();
    const review = await preparedReview(f);
    const approveChallenge = await f.adapter.issue({
      reviewDigest: review.reviewDigest,
      runId: f.selector.runId,
    });
    const approveProof = {
      challengeId: approveChallenge.challengeId,
      response: approveChallenge.phrase,
    };
    expect(approveChallenge).toMatchObject({
      intent: 'approve',
      phrase: `Approve ${review.reviewDigest.slice(0, 12)}`,
    });
    expect(
      await f.adapter.verifyRevocation({
        confirmation: approveProof,
        intent: 'revoke',
        reviewDigest: review.reviewDigest,
        runId: f.selector.runId,
      })
    ).toBeNull();
    expect(
      await f.adapter.verify({
        confirmation: approveProof,
        reviewDigest: review.reviewDigest,
        runId: f.selector.runId,
      })
    ).toBeNull();

    const approval = await f.adapter.issue({
      reviewDigest: review.reviewDigest,
      runId: f.selector.runId,
    });
    expect(
      await f.service.approve({
        confirmation: {
          challengeId: approval.challengeId,
          response: approval.phrase,
        },
        reviewDigest: review.reviewDigest,
        runId: f.selector.runId,
      })
    ).toMatchObject({ ok: true });

    const revokeChallenge = await f.adapter.issue({
      intent: 'revoke',
      reviewDigest: review.reviewDigest,
      runId: f.selector.runId,
    });
    expect(revokeChallenge).toMatchObject({
      intent: 'revoke',
      phrase: `Revoke ${review.reviewDigest.slice(0, 12)}`,
    });
    const revokeProof = {
      challengeId: revokeChallenge.challengeId,
      response: revokeChallenge.phrase,
    };
    expect(
      await f.adapter.verify({
        confirmation: revokeProof,
        intent: 'approve',
        reviewDigest: review.reviewDigest,
        runId: f.selector.runId,
      })
    ).toBeNull();
    expect(
      await f.adapter.verifyRevocation({
        confirmation: revokeProof,
        intent: 'revoke',
        reviewDigest: review.reviewDigest,
        runId: f.selector.runId,
      })
    ).toBeNull();

    const finalChallenge = await f.adapter.issue({
      intent: 'revoke',
      reviewDigest: review.reviewDigest,
      runId: f.selector.runId,
    });
    const revoked = await f.service.revoke({
      confirmation: {
        challengeId: finalChallenge.challengeId,
        response: finalChallenge.phrase,
      },
      reviewDigest: review.reviewDigest,
      runId: f.selector.runId,
    });
    expect(revoked).toMatchObject({ ok: true, replayed: false });
    const receipt = f.store.readRun({ runId: f.selector.runId }).view.execution
      .receipts[review.reviewDigest];
    expect(receipt.revocations).toEqual([
      {
        at: '2026-10-20T10:00:00.000Z',
        reference: finalChallenge.challengeId,
        source: 'portal-human-revocation',
        version: 1,
      },
    ]);
    const { events } = f.store.readEvents({
      afterSequence: 0,
      limit: 100,
      runId: f.selector.runId,
    });
    expect(
      events.find((event) => event.type === 'spans.execution-review.revoked')
        ?.payload
    ).toMatchObject({
      reference: finalChallenge.challengeId,
      revokedAt: '2026-10-20T10:00:00.000Z',
      source: 'portal-human-revocation',
    });
  });

  test('close invalidates outstanding challenges and prevents later issuance', async () => {
    const f = fixture();
    const review = await preparedReview(f);
    const issued = await f.adapter.issue({
      reviewDigest: review.reviewDigest,
      runId: f.selector.runId,
    });
    f.adapter.close();
    expect(
      await f.adapter.verify({
        confirmation: {
          challengeId: issued.challengeId,
          response: issued.phrase,
        },
        reviewDigest: review.reviewDigest,
        runId: f.selector.runId,
      })
    ).toBeNull();
    expect(
      await f.adapter.issue({
        reviewDigest: review.reviewDigest,
        runId: f.selector.runId,
      })
    ).toMatchObject({
      code: 'SPANS_EXECUTION_CONFIRMATION_CLOSED',
      ok: false,
    });
  });
});
