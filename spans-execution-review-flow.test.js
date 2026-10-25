import { afterEach, expect, test } from 'bun:test';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  createExecutionFixture,
  PROFILE,
  TARGET,
} from './spans-execution.test-support.js';

let fixture;
afterEach(async () => {
  await fixture?.dispose();
  fixture = undefined;
});

const request = {
  instructions: 'Create fixture-output.txt in the checkout.',
  profile: PROFILE,
  runId: 'run-1',
  spanId: 'build',
  target: TARGET,
  wallClockMs: 30_000,
};

async function ready() {
  fixture = createExecutionFixture();
  await fixture.completeSetup();
  const service = fixture.createService();
  expect((await service.probe({ profile: PROFILE })).ok).toBe(true);
  return service;
}

async function approve(service) {
  const prepared = await service.prepare(request);
  expect(prepared).toMatchObject({ ok: true, status: 'prepared' });
  const { reviewDigest } = prepared.review;
  const challenge = await service.approvalChallenge({
    reviewDigest,
    runId: request.runId,
  });
  expect(challenge.ok).toBe(true);
  const approved = await service.approve({
    confirmation: {
      challengeId: challenge.challengeId,
      response: challenge.phrase,
    },
    reviewDigest,
    runId: request.runId,
  });
  expect(approved.ok).toBe(true);
  return prepared;
}

test('a review checksum cannot launch without a durable human receipt', async () => {
  const service = await ready();
  const preview = await service.review(request);
  expect(preview.ok).toBe(true);
  const pids = fixture.providerPids();
  const before = fixture.store.readRun({ runId: request.runId });
  expect(
    await service.dispatch({ ...request, confirmation: preview.confirmation })
  ).toMatchObject({
    code: 'SPANS_EXECUTION_REVIEW_UNAPPROVED',
    ok: false,
  });
  expect(fixture.providerPids()).toEqual(pids);
  expect(fixture.store.readRun({ runId: request.runId })).toEqual(before);
  expect((await fixture.admission.status()).leases).toEqual([]);
});

test('an exact retained input and saved human approval launch one current worker', async () => {
  const service = await ready();
  const prepared = await approve(service);
  const preview = await service.review(request);
  const launched = await service.dispatch({
    ...request,
    confirmation: preview.confirmation,
    reviewDigest: prepared.review.reviewDigest,
  });
  expect(launched).toMatchObject({ ok: true, status: 'launched' });
  await service.idle();
  const run = fixture.store.readRun({ runId: request.runId });
  expect(run.view.executions[launched.actionId].inputArtifact).toEqual(
    prepared.review.binding.inputArtifact
  );
  expect(run.view.executions[launched.actionId].reviewRef.reviewDigest).toBe(
    prepared.review.reviewDigest
  );
  expect(run.view.attempts[launched.attemptId].status).toBe('exited');
});

test('revoking an approved review prevents a new intent or provider launch', async () => {
  const service = await ready();
  const prepared = await approve(service);
  const { reviewDigest } = prepared.review;
  const challenge = await service.approvalChallenge({
    intent: 'revoke',
    reviewDigest,
    runId: request.runId,
  });
  expect(challenge.ok).toBe(true);
  expect(
    await service.revoke({
      confirmation: {
        challengeId: challenge.challengeId,
        response: challenge.phrase,
      },
      reviewDigest,
      runId: request.runId,
    })
  ).toMatchObject({ ok: true });
  const preview = await service.review(request);
  const pids = fixture.providerPids();
  expect(
    await service.dispatch({
      ...request,
      confirmation: preview.confirmation,
      reviewDigest,
    })
  ).toMatchObject({
    code: 'SPANS_EXECUTION_REVIEW_REVOKED',
    ok: false,
  });
  expect(fixture.providerPids()).toEqual(pids);
  expect((await fixture.admission.status()).leases).toEqual([]);
});

test('restart reloads the retained request and receipt without another approval', async () => {
  const first = await ready();
  const prepared = await approve(first);
  await first.close();
  const restarted = fixture.createService();
  const launched = await restarted.dispatch({
    ...request,
    confirmation: prepared.confirmation,
    reviewDigest: prepared.review.reviewDigest,
  });
  expect(launched).toMatchObject({ ok: true, status: 'launched' });
  await restarted.idle();
  const run = fixture.store.readRun({ runId: request.runId });
  expect(run.view.spans.build.state).not.toBe('completed');
  expect(
    run.view.execution.receipts[prepared.review.reviewDigest].approvals
  ).toHaveLength(1);
});

test('changing retained plan context invalidates approval before admission', async () => {
  const service = await ready();
  const prepared = await approve(service);
  const read = fixture.store.readRun({ runId: request.runId });
  const view = structuredClone(read.view);
  view.goal = 'A different goal with the same plan counter.';
  expect(
    fixture.store.commitRun({
      events: [],
      expectedGeneration: read.generation,
      expectedRevision: read.revision,
      runId: request.runId,
      view,
    }).ok
  ).toBe(true);
  const pids = fixture.providerPids();
  expect(
    await service.dispatch({
      ...request,
      confirmation: prepared.confirmation,
      reviewDigest: prepared.review.reviewDigest,
    })
  ).toMatchObject({ code: 'SPANS_EXECUTION_REVIEW_CHANGED', ok: false });
  expect(fixture.providerPids()).toEqual(pids);
  expect((await fixture.admission.status()).leases).toEqual([]);
});

test('a damaged input blocks launch but cannot prevent human revocation', async () => {
  const service = await ready();
  const prepared = await approve(service);
  const { reviewDigest, binding } = prepared.review;
  writeFileSync(
    join(fixture.archive, 'artifacts', binding.inputArtifact.digest),
    'broken fixture artifact'
  );
  const pids = fixture.providerPids();
  expect(
    (
      await service.dispatch({
        ...request,
        confirmation: prepared.confirmation,
        reviewDigest,
      })
    ).ok
  ).toBe(false);
  const challenge = await service.approvalChallenge({
    intent: 'revoke',
    reviewDigest,
    runId: request.runId,
  });
  expect(challenge.ok).toBe(true);
  expect(
    await service.revoke({
      confirmation: {
        challengeId: challenge.challengeId,
        response: challenge.phrase,
      },
      reviewDigest,
      runId: request.runId,
    })
  ).toMatchObject({ ok: true });
  expect(fixture.providerPids()).toEqual(pids);
});

test('the detached launch fence refuses approval removed after source resolution', async () => {
  fixture = createExecutionFixture();
  await fixture.completeSetup();
  const pending = new Set(['revoke']);
  const service = fixture.createService({
    admission: {
      ...fixture.admission,
      async status() {
        const status = await fixture.admission.status();
        const read = fixture.store.readRun({ runId: request.runId });
        const intent = Object.values(read.view.actions).some(
          (action) => action.state === 'intent'
        );
        if (intent && pending.delete('revoke')) {
          const view = structuredClone(read.view);
          view.execution.receipts = {};
          expect(
            fixture.store.commitRun({
              events: [],
              expectedGeneration: read.generation,
              expectedRevision: read.revision,
              runId: request.runId,
              view,
            }).ok
          ).toBe(true);
        }
        return status;
      },
    },
  });
  expect((await service.probe({ profile: PROFILE })).ok).toBe(true);
  const prepared = await approve(service);
  const pids = fixture.providerPids();
  const launched = await service.dispatch({
    ...request,
    confirmation: prepared.confirmation,
    reviewDigest: prepared.review.reviewDigest,
  });
  expect(launched.ok).toBe(false);
  expect(pending.size).toBe(0);
  expect(fixture.providerPids()).toEqual(pids);
  expect((await fixture.admission.status()).leases).toEqual([]);
});
