import { afterEach, expect, test } from 'bun:test';
import { observeProcessIdentity } from './process-observation.js';
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
const refused = { code: 'SPANS_ARCHIVE_CAPACITY_EXCEEDED', ok: false };
const observeFixtureOwner = (processId) =>
  processId === process.pid
    ? Promise.resolve({
        processId,
        processStartIdentity: `fixture-owner-${processId}`,
        state: 'alive',
      })
    : observeProcessIdentity(processId);

test('archive capacity refusal prevents a probe before any provider process or evidence write', async () => {
  fixture = createExecutionFixture();
  const before = fixture.store.readRun({ runId: 'run-1' });
  const service = fixture.createService({
    admission: {
      ...fixture.admission,
      withSpansArchiveWrite: () => Promise.resolve(refused),
    },
  });
  expect(await service.probe({ profile: PROFILE })).toMatchObject({
    code: 'SPANS_EXEC_PROBE_NOT_RECORDED',
    ok: false,
  });
  expect(fixture.providerPids()).toEqual([]);
  expect(fixture.store.readRun({ runId: 'run-1' })).toEqual(before);
  expect(
    (await service.capabilities({ profile: PROFILE })).launch.allowed
  ).toBe(false);
});

test('archive refusal after approved preparation prevents authorization, admission and worker launch', async () => {
  fixture = createExecutionFixture();
  await fixture.completeSetup();
  const deniedWrites = new Set();
  let writes = 0;
  const service = fixture.createService({
    admission: {
      ...fixture.admission,
      withSpansArchiveWrite: (input, effect) => {
        if (deniedWrites.has('archive')) {
          return Promise.resolve(refused);
        }
        writes += 1;
        return fixture.admission.withSpansArchiveWrite(input, effect);
      },
    },
    observeProcess: observeFixtureOwner,
  });
  expect((await service.probe({ profile: PROFILE })).ok).toBe(true);
  expect(writes).toBeGreaterThan(0);
  const prepared = await service.prepare(request);
  expect(prepared).toMatchObject({ ok: true, status: 'prepared' });
  const { reviewDigest } = prepared.review;
  const challenge = await service.approvalChallenge({
    reviewDigest,
    runId: request.runId,
  });
  expect(challenge.ok).toBe(true);
  expect(
    await service.approve({
      confirmation: {
        challengeId: challenge.challengeId,
        response: challenge.phrase,
      },
      reviewDigest,
      runId: request.runId,
    })
  ).toMatchObject({ ok: true });
  const pids = fixture.providerPids();
  const before = fixture.store.readRun({ runId: 'run-1' });
  deniedWrites.add('archive');
  expect(
    await service.dispatch({
      ...request,
      confirmation: prepared.confirmation,
      reviewDigest,
    })
  ).toMatchObject({
    code: 'SPANS_ARCHIVE_CAPACITY_EXCEEDED',
    ok: false,
  });
  expect(fixture.providerPids()).toEqual(pids);
  expect(fixture.store.readRun({ runId: 'run-1' })).toEqual(before);
  expect((await fixture.admission.status()).leases).toEqual([]);
});

test('concurrent probes retain both subscription usage observations', async () => {
  fixture = createExecutionFixture();
  const pending = [];
  const pairedGate = (input, effect) =>
    new Promise((resolve) => {
      pending.push({ effect, input, resolve });
      if (pending.length === 2) {
        for (const entry of pending.splice(0)) {
          fixture.admission
            .withSpansArchiveWrite(entry.input, entry.effect)
            .then(entry.resolve);
        }
      }
    });
  const service = fixture.createService({
    admission: { ...fixture.admission, withSpansArchiveWrite: pairedGate },
  });
  const results = await Promise.all([
    service.probe({ profile: PROFILE }),
    service.probe({ profile: PROFILE }),
  ]);
  expect(results.every((result) => result.ok)).toBe(true);
  const status = await service.capabilities({ profile: PROFILE });
  expect(status.probeSpend.probes).toBe(2);
  expect(status.probeSpend.subscriptionProbes).toBe(2);
});
