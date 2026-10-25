import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  approvedDispatchInput,
  createExecutionFixture,
  METERED_PROFILES,
  PROFILE,
  PROVIDER_FIXTURE,
  TARGET,
} from './spans-execution.test-support.js';
import { checkWriter } from './writer-claims.js';

// Process tests. The provider is a local deterministic fixture command, so
// these tests prove how Setu authorizes, supervises and records a child
// process. They are not provider acceptance and make no provider call.

let fx;
afterEach(async () => {
  await fx?.dispose();
  fx = undefined;
});

describe('capability evidence', () => {
  test('only a local probe can make a profile launchable', async () => {
    fx = createExecutionFixture();
    const service = fx.createService();

    const before = await service.capabilities({ profile: PROFILE });
    expect(before).toMatchObject({ launch: { allowed: false }, ok: true });
    expect(before.launch.blockedBy).toContain('session');

    const probed = await service.probe({ profile: PROFILE });
    expect(probed).toMatchObject({ launch: { allowed: true }, ok: true });

    const after = await service.capabilities({ profile: PROFILE });
    expect(after.launch).toEqual({
      allowed: true,
      blockedBy: [],
      unverified: ['effort'],
    });
  });

  test('caller supplied capability JSON is refused and establishes nothing', async () => {
    fx = createExecutionFixture();
    const service = fx.createService();
    const forged = {
      connected: true,
      installed: true,
      session: { id: 'forged', origin: 'fresh' },
    };

    const probed = await service.probe({ evidence: forged, profile: PROFILE });
    expect(probed).toMatchObject({
      code: 'SPANS_EXEC_REQUEST_INVALID',
      ok: false,
    });
    const reviewed = await service.capabilities({
      evidence: forged,
      profile: PROFILE,
    });
    expect(reviewed).toMatchObject({
      code: 'SPANS_EXEC_REQUEST_INVALID',
      ok: false,
    });

    const after = await service.capabilities({ profile: PROFILE });
    expect(after.launch.allowed).toBe(false);
  });
});

const HEX_40 = /^[0-9a-f]{40}$/;
const HEX_64 = /^[0-9a-f]{64}$/;
const DISPATCH_TOKEN = /^spans-dispatch:[0-9a-f]{64}$/;
const ACCEPT_TOKEN = /^spans-accept:[0-9a-f]{64}$/;

const REVIEW = Object.freeze({
  instructions: 'Create fixture-output.txt in the checkout.',
  profile: PROFILE,
  runId: 'run-1',
  spanId: 'build',
  target: TARGET,
  wallClockMs: 30_000,
});

const eventCount = (store) =>
  store.readEvents({ limit: 200, runId: 'run-1' }).events.length;

async function readyService(overrides) {
  fx = createExecutionFixture();
  await fx.completeSetup();
  const service = fx.createService(overrides);
  await service.probe({ profile: PROFILE });
  return service;
}

test.each([
  { readOnly: true },
  { kind: 'imported', readOnly: false, state: 'planned' },
  { state: 'imported' },
])('imported marker %j refuses execution before admission', async (marker) => {
  const service = await readyService();
  const read = fx.store.readRun({ runId: REVIEW.runId });
  expect(
    fx.store.commitRun({
      events: [],
      expectedGeneration: read.generation,
      expectedRevision: read.revision,
      runId: REVIEW.runId,
      view: { ...read.view, ...marker },
    }).ok
  ).toBe(true);
  const events = eventCount(fx.store);
  const providers = fx.providerPids();
  const expected = { code: 'SPANS_EXEC_RUN_READ_ONLY', ok: false };
  expect(await service.review(REVIEW)).toMatchObject(expected);
  expect(await service.dispatch(REVIEW)).toMatchObject(expected);
  expect(eventCount(fx.store)).toBe(events);
  expect((await fx.admission.status()).leases).toEqual([]);
  expect(checkWriter(fx.wtDir, 'anyone').claim).toBeNull();
  expect(fx.providerPids()).toEqual(providers);
});

describe('reviewing a dispatch', () => {
  test('shows the exact binding and changes nothing', async () => {
    const service = await readyService();
    const events = eventCount(fx.store);
    const { revision } = fx.store.readRun({ runId: 'run-1' });

    const reviewed = await service.review(REVIEW);

    expect(reviewed).toMatchObject({ ok: true, status: 'review' });
    expect(reviewed.review).toMatchObject({
      checkout: { dirtyCount: 0 },
      generation: 0,
      planVersion: 1,
      profile: PROFILE,
      runId: 'run-1',
      spanId: 'build',
      target: TARGET,
      wallClockMs: 30_000,
    });
    expect(reviewed.review.checkout.head).toMatch(HEX_40);
    expect(reviewed.review.launch).toEqual({
      allowed: true,
      blockedBy: [],
      unverified: ['effort'],
    });
    expect(reviewed.confirmation).toMatch(DISPATCH_TOKEN);

    // Nothing was written, reserved, claimed or started.
    expect(eventCount(fx.store)).toBe(events);
    expect(fx.store.readRun({ runId: 'run-1' }).revision).toBe(revision);
    expect((await fx.admission.status()).leases).toEqual([]);
    expect(checkWriter(fx.wtDir, 'anyone').claim).toBeNull();
    expect(await service.status({ runId: 'run-1' })).toMatchObject({
      attempts: [],
      ok: true,
    });
  });

  test('is repeatable and binds only what was reviewed', async () => {
    const service = await readyService();
    const first = await service.review(REVIEW);
    const again = await service.review(REVIEW);
    expect(again.confirmation).toBe(first.confirmation);

    const changed = await service.review({ ...REVIEW, wallClockMs: 31_000 });
    expect(changed.confirmation).not.toBe(first.confirmation);
    const other = await service.review({
      ...REVIEW,
      instructions: 'Something else.',
    });
    expect(other.confirmation).not.toBe(first.confirmation);
  });

  test('refuses a request that carries paths, evidence or authorization', async () => {
    const service = await readyService();
    for (const extra of [
      { wtDir: fx.wtDir },
      { repoDir: fx.repoDir },
      { evidence: { installed: true } },
      { authorizationId: 'auth-1' },
      { confirmation: 'spans-dispatch:abc' },
    ]) {
      // biome-ignore lint/performance/noAwaitInLoops: Each step depends on the one before it, so they run in order.
      expect(await service.review({ ...REVIEW, ...extra })).toMatchObject({
        code: 'SPANS_EXEC_REQUEST_INVALID',
        ok: false,
      });
    }
  });

  test('refuses what cannot run: unprobed profile, unknown span, unaccepted dependency, no setup', async () => {
    fx = createExecutionFixture();
    const service = fx.createService();
    await fx.completeSetup();
    expect(await service.review(REVIEW)).toMatchObject({
      code: 'SPANS_EXEC_CAPABILITY_UNVERIFIED',
      ok: false,
    });
    await service.probe({ profile: PROFILE });
    expect(await service.review({ ...REVIEW, spanId: 'nope' })).toMatchObject({
      code: 'SPANS_EXEC_SPAN_NOT_FOUND',
      ok: false,
    });
    expect(await service.review({ ...REVIEW, spanId: 'verify' })).toMatchObject(
      {
        code: 'SPANS_EXEC_DEPENDENCIES_INCOMPLETE',
        ok: false,
      }
    );
    expect(
      await service.review({
        ...REVIEW,
        target: { name: 'ghost', repo: 'demo' },
      })
    ).toMatchObject({ code: 'SPANS_EXEC_TARGET_UNKNOWN', ok: false });
  });

  test('refuses a checkout whose setup never completed', async () => {
    fx = createExecutionFixture();
    const service = fx.createService();
    await service.probe({ profile: PROFILE });
    expect(await service.review(REVIEW)).toMatchObject({
      code: 'SPANS_EXEC_SETUP_NOT_READY',
      ok: false,
    });
  });
});

const dispatchInput = (service, overrides = {}) =>
  approvedDispatchInput(service, { ...REVIEW, ...overrides });

const events = (type) =>
  fx.store
    .readEvents({ limit: 200, runId: 'run-1' })
    .events.filter((event) => event.type === type);

async function capturedOutput(service) {
  const [attempt] = (await service.status({ runId: 'run-1' })).attempts;
  const read = fx.artifacts.read({ artifactId: attempt.capture.artifactId });
  return read.text
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

describe('dispatching a reviewed span', () => {
  test('runs one real worker process and captures what it printed', async () => {
    const service = await readyService();
    const launched = await service.dispatch(await dispatchInput(service));

    expect(launched).toMatchObject({
      accepted: false,
      ok: true,
      status: 'launched',
    });
    // While it runs, the resources are held by exactly one owner each.
    const { leases } = await fx.admission.status();
    expect(leases).toHaveLength(1);
    expect(leases[0]).toMatchObject({ kind: 'headless-run', target: TARGET });
    expect(checkWriter(fx.wtDir, 'someone-else').claim).toMatchObject({
      agent: 'spans',
    });
    expect((await service.usage({ runId: 'run-1' })).heldCount).toBe(1);

    await service.idle();

    const [attempt] = (await service.status({ runId: 'run-1' })).attempts;
    expect(attempt).toMatchObject({
      actionId: launched.actionId,
      capture: { complete: true },
      exit: { code: 0, signal: null },
      spanId: 'build',
      status: 'exited',
    });
    const lines = await capturedOutput(service);
    const init = lines.find((line) => line.subtype === 'init');
    expect(init.cwd).toBe(fx.wtDir);
    expect(JSON.parse(init.stdin).request.instructions).toBe(
      REVIEW.instructions
    );
    expect(JSON.parse(init.stdin)).toMatchObject({
      request: { instructions: REVIEW.instructions },
      version: 1,
    });
    expect(init.args).toEqual(
      expect.arrayContaining([
        '--restricted',
        '--setting-sources',
        '',
        '--strict-mcp-config',
        '--permission-mode',
        'auto',
        '--permission-prompts',
        'none',
        '--tools',
        'Bash,Edit,Glob,Grep,Read,Write',
        '--model',
        'claude-sonnet-5-5',
        '--effort',
        'medium',
      ])
    );
    // The first two flags come before everything else, and no budget is sent.
    expect(init.args.indexOf('--restricted')).toBeLessThan(
      init.args.indexOf('--strict-mcp-config')
    );
    expect(init.args).not.toContain('--max-budget-usd');
    expect(
      readFileSync(join(fx.wtDir, 'fixture-output.txt'), 'utf8')
    ).toContain('work done');
    // One launch, one admission lease, one reservation: nothing doubled.
    expect(events('spans.worker.launched')).toHaveLength(1);
    expect(events('spans.worker.exited')).toHaveLength(1);
    expect(events('spans.execution.captured')).toHaveLength(1);
  });

  test('does not accept the span or ready its dependents when the process exits', async () => {
    const service = await readyService();
    await service.dispatch(await dispatchInput(service));
    await service.idle();
    const run = fx.store.readRun({ runId: 'run-1' }).view;
    expect(run.spans.build.state).toBe('planned');
    expect(run.spans.verify.state).toBe('planned');
    expect(run.checkpoint).toBe(0);
  });

  test('asks for a review instead of acting when there is no confirmation', async () => {
    const service = await readyService();
    const result = await service.dispatch(REVIEW);
    expect(result).toMatchObject({
      code: 'SPANS_EXEC_CONFIRMATION_REQUIRED',
      ok: false,
    });
    expect(result.confirmation).toMatch(DISPATCH_TOKEN);
    expect((await fx.admission.status()).leases).toEqual([]);
    expect(checkWriter(fx.wtDir, 'x').claim).toBeNull();
    expect(events('spans.worker.intent')).toHaveLength(0);
  });

  test('a preview checksum alone does not count as human approval', async () => {
    const service = await readyService();
    const preview = await service.review(REVIEW);
    const before = fx.store.readRun({ runId: REVIEW.runId });
    const providers = fx.providerPids();

    expect(
      await service.dispatch({ ...REVIEW, confirmation: preview.confirmation })
    ).toMatchObject({ code: 'SPANS_EXECUTION_REVIEW_UNAPPROVED', ok: false });

    expect(fx.providerPids()).toEqual(providers);
    expect(fx.store.readRun({ runId: REVIEW.runId })).toEqual(before);
    expect((await fx.admission.status()).leases).toEqual([]);
    expect(checkWriter(fx.wtDir, 'x').claim).toBeNull();
    expect(events('spans.worker.intent')).toHaveLength(0);
  });

  test('refuses a confirmation that does not match what is dispatched now', async () => {
    const service = await readyService();
    const approved = await dispatchInput(service);
    const reviewed = await service.review(REVIEW);
    const refusals = [
      { ...REVIEW, criteria: ['something else'] },
      { ...REVIEW, instructions: 'Do something else.' },
      { ...REVIEW, wallClockMs: 31_000 },
    ];
    for (const request of refusals) {
      // biome-ignore lint/performance/noAwaitInLoops: Each step depends on the one before it, so they run in order.
      const result = await service.dispatch({
        ...approved,
        ...request,
        confirmation: reviewed.confirmation,
      });
      expect(result).toMatchObject({
        code: 'SPANS_EXEC_REVIEW_CHANGED',
        ok: false,
      });
    }
    // A checkout that changed after the review is a changed target.
    await Bun.write(join(fx.wtDir, 'drift.txt'), 'changed after review\n');
    const drifted = await service.dispatch({
      ...approved,
      confirmation: reviewed.confirmation,
    });
    expect(drifted).toMatchObject({
      code: 'SPANS_EXEC_REVIEW_CHANGED',
      ok: false,
    });
    expect((await fx.admission.status()).leases).toEqual([]);
    expect(events('spans.worker.intent')).toHaveLength(0);
    expect(events('spans.execution.authorized')).toHaveLength(0);
  });

  test('two concurrent dispatches start one process', async () => {
    const service = await readyService();
    const input = await dispatchInput(service);
    const results = await Promise.all([
      service.dispatch(input),
      service.dispatch(input),
    ]);
    expect(
      results.filter((result) => result.status === 'launched')
    ).toHaveLength(1);
    await service.idle();
    expect(events('spans.worker.launched')).toHaveLength(1);
    expect(events('spans.execution.authorized')).toHaveLength(1);
    expect(existsSync(join(fx.wtDir, 'fixture-output.txt'))).toBe(true);
  });

  test('another writer on the checkout stops the dispatch before anything is reserved', async () => {
    const service = await readyService();
    const input = await dispatchInput(service);
    const { claimWriter } = await import('./writer-claims.js');
    claimWriter(fx.wtDir, {
      agent: 'codex',
      pid: process.pid,
      session: 'other-session',
      task: 'editing',
    });
    const result = await service.dispatch(input);
    expect(result).toMatchObject({ code: 'WRITER_BUSY', ok: false });
    expect((await fx.admission.status()).leases).toEqual([]);
    expect(
      (await service.usage({ runId: 'run-1' })).outstandingReservationMicro
    ).toBe(0);
    expect(events('spans.worker.intent')).toHaveLength(0);
  });

  test('a provider command that cannot start releases what the dispatch reserved', async () => {
    fx = createExecutionFixture();
    await fx.completeSetup();
    const service = fx.createService({
      provider: { command: ['/nonexistent/provider'] },
    });
    // The probe cannot run either, so evidence comes from a working command.
    const working = fx.createService();
    await working.probe({ profile: PROFILE });
    const input = await dispatchInput(service);
    const result = await service.dispatch(input);
    expect(result).toMatchObject({ code: 'LAUNCH_REFUSED', ok: false });
    expect((await fx.admission.status()).leases).toEqual([]);
    expect(
      (await service.usage({ runId: 'run-1' })).outstandingReservationMicro
    ).toBe(0);
    // The refusal is recorded as a failed action, so a new review can retry.
    const actions = Object.values(
      fx.store.readRun({ runId: 'run-1' }).view.actions
    );
    expect(actions.map((action) => action.state)).toEqual(['failed']);
  });
});

async function waitFor(check, label, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    // biome-ignore lint/performance/noAwaitInLoops: Each step depends on the one before it, so they run in order.
    const value = await check();
    if (value) {
      return value;
    }
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${label}`);
    }
    await Bun.sleep(20);
  }
}

const attemptOf = async (service) =>
  (await service.status({ runId: 'run-1' })).attempts[0];

const isAlive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

describe('cancelling an attempt', () => {
  test('delivery is not an exit, and a cancelled attempt is not completion', async () => {
    const service = await readyService();
    const launched = await service.dispatch(
      await dispatchInput(service, { instructions: 'MODE:stubborn' })
    );
    expect(launched.status).toBe('launched');
    await waitFor(
      async () => (await attemptOf(service))?.status === 'running',
      'running'
    );
    const { pid } = (await attemptOf(service)).processStart;

    const cancelled = await service.cancel({
      attemptId: launched.attemptId,
      runId: 'run-1',
    });
    expect(cancelled).toMatchObject({
      cancel: 'delivered',
      ok: true,
      terminal: false,
    });

    // Delivery grants no completion; resources stay held until the durable exit.
    const afterDelivery = await attemptOf(service);
    if (afterDelivery.exit === null) {
      expect((await fx.admission.status()).leases).toHaveLength(1);
      expect(fx.store.readRun({ runId: 'run-1' }).view.spans.build.state).toBe(
        'planned'
      );
    } else {
      expect(afterDelivery.receipt.exit).toEqual(afterDelivery.exit);
    }
    expect((await service.idle()).ok).toBe(true);
    expect(await attemptOf(service)).toMatchObject({
      cancel: { state: 'delivered' },
      exit: { code: null, signal: 'SIGKILL' },
      status: 'exited',
    });
    expect(isAlive(pid)).toBe(false);
    const run = fx.store.readRun({ runId: 'run-1' }).view;
    expect(run.spans.build.state).toBe('planned');
  });

  test('refuses an attempt that is not the exact owned one', async () => {
    const service = await readyService();
    await service.dispatch(
      await dispatchInput(service, { instructions: 'MODE:hang' })
    );
    await waitFor(
      async () => (await attemptOf(service))?.status === 'running',
      'running'
    );
    expect(
      await service.cancel({ attemptId: 'someone-elses', runId: 'run-1' })
    ).toMatchObject({ ok: false });
    expect(
      await service.cancel({
        attemptId: (await attemptOf(service)).attemptId,
        extra: 1,
        runId: 'run-1',
      })
    ).toMatchObject({ code: 'SPANS_EXEC_REQUEST_INVALID', ok: false });
    expect((await attemptOf(service)).cancel).toBeNull();
    await service.cancel({
      attemptId: (await attemptOf(service)).attemptId,
      runId: 'run-1',
    });
    await service.idle();
  });
});

describe('the wall-clock deadline', () => {
  test('holds an overdue attempt as unknown, stops its process and keeps its resources', async () => {
    const service = await readyService();
    await service.dispatch(
      await dispatchInput(service, {
        instructions: 'MODE:hang',
        wallClockMs: 1000,
      })
    );
    await waitFor(
      async () => (await attemptOf(service))?.status === 'running',
      'running'
    );
    const { pid } = (await attemptOf(service)).processStart;

    // Before the deadline nothing happens.
    expect(await service.enforceDeadlines()).toMatchObject({
      held: [],
      ok: true,
    });
    expect((await attemptOf(service)).status).toBe('running');

    await waitFor(
      async () => (await attemptOf(service))?.status === 'held',
      'the detached child deadline'
    );
    expect((await service.enforceDeadlines()).ok).toBe(true);
    expect(await attemptOf(service)).toMatchObject({
      receipt: { outcome: 'unknown', reason: 'deadline' },
      status: 'held',
    });
    await waitFor(() => !isAlive(pid), 'process to stop');
    await service.idle();

    // Unknown work keeps everything it owns until it is resolved.
    expect((await fx.admission.status()).leases).toHaveLength(1);
    expect(checkWriter(fx.wtDir, 'x').claim).toMatchObject({ agent: 'spans' });
    expect((await service.usage({ runId: 'run-1' })).heldCount).toBe(1);
    const [action] = Object.values(
      fx.store.readRun({ runId: 'run-1' }).view.actions
    );
    expect(action.state).toBe('unknown');
  });
});

describe('the deadline driver', () => {
  test('holds an overdue attempt on its own timer, with no caller asking', async () => {
    const service = await readyService();
    const launched = await service.dispatch(
      await dispatchInput(service, {
        instructions: 'MODE:hang',
        wallClockMs: 1000,
      })
    );
    const { pid } = await waitFor(async () => {
      const attempt = await attemptOf(service);
      return attempt?.status === 'running' ? attempt.processStart : null;
    }, 'running');
    await waitFor(
      async () => (await attemptOf(service))?.status === 'held',
      'the driver to hold the attempt',
      8000
    );
    expect(await attemptOf(service)).toMatchObject({
      receipt: { outcome: 'unknown', reason: 'deadline' },
    });
    await waitFor(() => !isAlive(pid), 'the process to stop');
    await waitFor(
      () => run().actions[launched.actionId].state === 'unknown',
      'the parent to record the child hold'
    );
    expect(run().actions[launched.actionId].state).toBe('unknown');
    expect((await fx.admission.status()).leases).toHaveLength(1);
  });
});

describe('an unknown launch', () => {
  test('holds every reservation and is never launched again', async () => {
    // The process starts, but its identity cannot be proven.
    const service = await readyService({
      observeProcess: () => Promise.resolve({ state: 'unknown' }),
    });
    const input = await dispatchInput(service);
    const result = await service.dispatch(input);
    expect(result).toMatchObject({
      code: 'LAUNCH_UNKNOWN',
      ok: false,
      status: 'held',
    });
    expect(result.resources).toEqual({
      admission: 'held',
      usage: 'held',
      writer: 'held',
    });
    await service.idle();
    expect((await fx.admission.status()).leases).toHaveLength(1);
    expect(checkWriter(fx.wtDir, 'x').claim).toMatchObject({ agent: 'spans' });
    expect((await service.usage({ runId: 'run-1' })).heldCount).toBe(1);

    // A second dispatch for the span is refused: the action is unresolved.
    const again = await service.dispatch(input);
    expect(again).toMatchObject({ code: 'SPANS_EXEC_ACTION_OPEN', ok: false });
    expect(events('spans.worker.launched')).toHaveLength(0);
    expect(events('spans.action.intent')).toHaveLength(1);
  });
});

describe('bounded capture', () => {
  test('redacts secrets before anything is stored', async () => {
    const service = await readyService();
    await service.dispatch(
      await dispatchInput(service, { instructions: 'MODE:secret' })
    );
    await service.idle();
    const [attempt] = (await service.status({ runId: 'run-1' })).attempts;
    const { text } = fx.artifacts.read({
      artifactId: attempt.capture.artifactId,
    });
    expect(text).not.toContain('sk-abcdefghijklmnopqrstuvwxyz0123');
    expect(text).toContain('[REDACTED]');
  });

  test('captures output larger than one read completely and in order', async () => {
    const service = await readyService();
    await service.dispatch(
      await dispatchInput(service, { instructions: 'MODE:chatty' })
    );
    await service.idle();
    const [attempt] = (await service.status({ runId: 'run-1' })).attempts;
    expect(attempt).toMatchObject({
      capture: { complete: true },
      status: 'exited',
    });
    const { text } = fx.artifacts.read({
      artifactId: attempt.capture.artifactId,
    });
    const numbered = text
      .split('\n')
      .filter((line) => line.startsWith('line '));
    expect(numbered).toHaveLength(400);
    expect(numbered[0]).toStartWith('line 0 ');
    expect(numbered[399]).toStartWith('line 399 ');
  });

  test('holds an attempt whose output passes the capture limit', async () => {
    const service = await readyService({
      workerLimits: { maxAttemptBytes: 20_000, maxChunkBytes: 4096 },
    });
    await service.dispatch(
      await dispatchInput(service, { instructions: 'MODE:chatty' })
    );
    await service.idle();
    expect(await attemptOf(service)).toMatchObject({
      receipt: { outcome: 'unknown', reason: 'spool-limit' },
      status: 'held',
    });
    expect((await attemptOf(service)).capture.bytes).toBeLessThanOrEqual(
      20_000
    );
    expect((await fx.admission.status()).leases).toHaveLength(1);
  });
});

describe('a single supervisor', () => {
  test('a second service cannot supervise the same archive', async () => {
    const first = await readyService();
    const second = fx.createService();
    const input = await dispatchInput(first);
    expect((await first.dispatch(input)).status).toBe('launched');

    expect(await second.dispatch(input)).toMatchObject({
      code: 'SPANS_EXEC_OWNED_ELSEWHERE',
      ok: false,
    });
    expect(
      await second.cancel({
        attemptId: (await attemptOf(first)).attemptId,
        runId: 'run-1',
      })
    ).toMatchObject({ code: 'SPANS_EXEC_OWNED_ELSEWHERE', ok: false });
    expect(await second.enforceDeadlines()).toMatchObject({
      code: 'SPANS_EXEC_OWNED_ELSEWHERE',
      ok: false,
    });
    expect((await fx.admission.status()).leases).toHaveLength(1);
    expect(events('spans.worker.intent')).toHaveLength(1);
    await first.idle();

    // Releasing the owner lets another service take over.
    await first.close();
    const third = fx.createService();
    expect(await third.enforceDeadlines()).toMatchObject({ ok: true });
  });
});

const run = () => fx.store.readRun({ runId: 'run-1' }).view;
const claimOf = () => checkWriter(fx.wtDir, 'observer').claim;

async function finishedService(instructions, overrides) {
  const service = await readyService(overrides);
  const launched = await service.dispatch(
    await dispatchInput(service, {
      instructions: instructions ?? REVIEW.instructions,
    })
  );
  expect(launched.status).toBe('launched');
  await service.idle();
  return { launched, service };
}

describe('verified completion', () => {
  test('an exit with evidence records the outcome, settles usage and frees admission but not the writer', async () => {
    const { launched, service } = await finishedService();

    const action = run().actions[launched.actionId];
    expect(action).toMatchObject({
      outcomeArtifactIds: [expect.any(String)],
      state: 'completed',
    });
    expect((await fx.admission.status()).leases).toEqual([]);
    expect(await service.usage({ runId: 'run-1' })).toMatchObject({
      actualComplete: true,
      outstandingReservationMicro: 0,
      runActualMicro: 0,
      unmeteredCount: 1,
    });
    // What the provider reported is an estimate beside the record, not money.
    expect(run().completions[launched.actionId].reported.usage).toMatchObject({
      apiEquivalentMicro: 12_500,
      billed: 'unknown',
    });
    // The tree is not accepted yet, so the writer claim still guards it.
    expect(claimOf()).toMatchObject({ agent: 'spans' });
    // Nothing is accepted and nothing downstream became ready.
    expect(run().spans.build.state).toBe('planned');
    expect(run().spans.verify.state).toBe('planned');
    expect(run().checkpoint).toBe(0);
    expect(events('spans.completion.accepted')).toHaveLength(0);

    const status = await service.status({ runId: 'run-1' });
    expect(status.executions[0]).toMatchObject({
      acceptance: 'pending',
      action: 'completed',
      completion: { outcome: 'completed' },
      resources: { admission: 'released' },
    });
    expect(status.executions[0].completion.tree.digest).toMatch(HEX_64);
  });

  test('a failed run is recorded as failed and never as completion', async () => {
    const { launched, service } = await finishedService('MODE:fail');
    expect(run().actions[launched.actionId].state).toBe('failed');
    expect((await fx.admission.status()).leases).toEqual([]);
    expect((await service.usage({ runId: 'run-1' })).unmeteredCount).toBe(1);
    expect(run().spans.build.state).toBe('planned');
    expect(
      await service.accept({ actionId: launched.actionId, runId: 'run-1' })
    ).toMatchObject({
      ok: false,
    });
  });

  test('a model saying it is done, with a clean exit and no result, is not completion', async () => {
    const { launched, service } = await finishedService('MODE:claim-done');
    const [attempt] = (await service.status({ runId: 'run-1' })).attempts;
    expect(attempt.exit).toEqual({ code: 0, signal: null });
    expect(
      fx.artifacts.read({ artifactId: attempt.capture.artifactId }).text
    ).toContain('I am done.');
    expect(run().actions[launched.actionId].state).toBe('failed');
    expect(run().spans.build.state).toBe('planned');
    expect(run().spans.verify.state).toBe('planned');
  });

  test('a cancelled attempt is a failed outcome, not completion', async () => {
    const service = await readyService();
    const launched = await service.dispatch(
      await dispatchInput(service, { instructions: 'MODE:stubborn' })
    );
    await waitFor(
      async () => (await attemptOf(service))?.status === 'running',
      'running'
    );
    await service.cancel({ attemptId: launched.attemptId, runId: 'run-1' });
    await service.idle();
    expect(run().actions[launched.actionId].state).toBe('failed');
    expect(run().spans.build.state).toBe('planned');
  }, 20_000);

  test('completion can be retried by name and changes nothing the second time', async () => {
    const { launched, service } = await finishedService();
    const before = events('spans.action.outcome').length;
    expect(
      await service.complete({ actionId: launched.actionId, runId: 'run-1' })
    ).toMatchObject({ ok: true });
    expect(events('spans.action.outcome')).toHaveLength(before);
    expect((await service.usage({ runId: 'run-1' })).unmeteredCount).toBe(1);
  });
});

describe('after a failed attempt', () => {
  test('the writer claim stays, and a new reviewed dispatch is a new action', async () => {
    const { launched, service } = await finishedService('MODE:fail');
    expect(run().actions[launched.actionId].state).toBe('failed');
    // The failed tree is unreviewed, so its claim stays until someone decides.
    expect(claimOf()).toMatchObject({ agent: 'spans' });
    const status = await service.status({ runId: 'run-1' });
    expect(status.executions[0].resources.writer).toEqual({
      session: claimOf().session,
    });

    const retry = await service.dispatch(await dispatchInput(service));
    expect(retry).toMatchObject({ ok: true, status: 'launched' });
    expect(retry.actionId).not.toBe(launched.actionId);
    await service.idle();
    expect(run().actions[retry.actionId].state).toBe('completed');
    expect(run().actions[launched.actionId].state).toBe('failed');
    expect(events('spans.worker.launched')).toHaveLength(2);
  }, 20_000);
});

describe('accepting a completion', () => {
  async function completed() {
    const finished = await finishedService();
    return {
      ...finished,
      input: { actionId: finished.launched.actionId, runId: 'run-1' },
    };
  }

  test('shows what it would accept and does nothing without the confirmation', async () => {
    const { input, service } = await completed();
    const asked = await service.accept(input);
    expect(asked).toMatchObject({
      code: 'SPANS_EXEC_ACCEPTANCE_CONFIRMATION_REQUIRED',
      ok: false,
    });
    expect(asked.confirmation).toMatch(ACCEPT_TOKEN);
    expect(asked.review).toMatchObject({
      actionId: input.actionId,
      outcome: 'completed',
      spanId: 'build',
    });
    expect(run().spans.build.state).toBe('planned');
    expect(claimOf()).toMatchObject({ agent: 'spans' });
  });

  test('accepts only on the exact confirmation, readies dependents and releases the writer', async () => {
    const { input, service } = await completed();
    const { confirmation } = await service.accept(input);

    expect(
      await service.accept({ ...input, confirmation: 'spans-accept:nope' })
    ).toMatchObject({ code: 'SPANS_EXEC_REVIEW_CHANGED', ok: false });
    expect(run().spans.build.state).toBe('planned');

    const accepted = await service.accept({ ...input, confirmation });
    expect(accepted).toMatchObject({
      accepted: true,
      ok: true,
      readySpanIds: ['verify'],
      status: 'accepted',
    });
    expect(run().spans.build).toMatchObject({
      acceptedActionId: input.actionId,
      state: 'completed',
    });
    expect(run().spans.verify.state).toBe('ready');
    expect(events('spans.completion.accepted')).toHaveLength(1);
    // Acceptance releases the writer claim and nothing else is left held.
    expect(claimOf()).toBeNull();
    expect((await fx.admission.status()).leases).toEqual([]);

    // The dependent can now be reviewed for its own dispatch.
    expect(await service.review({ ...REVIEW, spanId: 'verify' })).toMatchObject(
      {
        ok: true,
        status: 'review',
      }
    );
    // Accepting again is idempotent.
    expect(await service.accept({ ...input, confirmation })).toMatchObject({
      ok: true,
    });
    expect(events('spans.completion.accepted')).toHaveLength(1);
  });

  test('refuses when the tree is not exactly the one that was completed', async () => {
    const { input, service } = await completed();
    const { confirmation } = await service.accept(input);
    await Bun.write(
      join(fx.wtDir, 'fixture-output.txt'),
      'edited after the worker finished\n'
    );
    expect(await service.accept({ ...input, confirmation })).toMatchObject({
      code: 'SPANS_EXEC_TREE_CHANGED',
      ok: false,
    });
    expect(run().spans.build.state).toBe('planned');
    expect(run().spans.verify.state).toBe('planned');
    expect(claimOf()).toMatchObject({ agent: 'spans' });
  });

  test('refuses evidence the caller supplies', async () => {
    const { input, service } = await completed();
    for (const extra of [
      { evidence: { verified: true } },
      { tree: 'abc' },
      { verified: true },
    ]) {
      // biome-ignore lint/performance/noAwaitInLoops: Each step depends on the one before it, so they run in order.
      expect(await service.accept({ ...input, ...extra })).toMatchObject({
        code: 'SPANS_EXEC_REQUEST_INVALID',
        ok: false,
      });
    }
  });
});

describe('reported outcomes and late generations', () => {
  test('a reported done is an observation and never completion', async () => {
    const service = await readyService();
    const launched = await service.dispatch(
      await dispatchInput(service, { instructions: 'MODE:hang' })
    );
    await waitFor(
      async () => (await attemptOf(service))?.status === 'running',
      'running'
    );
    const reported = await service.report({
      actionId: launched.actionId,
      generation: 0,
      outcome: 'completed',
      runId: 'run-1',
    });
    expect(reported).toMatchObject({
      advanced: false,
      ok: true,
      status: 'reported',
    });
    expect(events('spans.execution.reported')).toHaveLength(1);
    expect(run().actions[launched.actionId].state).toBe('intent');
    expect(run().spans.build.state).toBe('planned');
    expect(
      await service.accept({ actionId: launched.actionId, runId: 'run-1' })
    ).toMatchObject({
      code: 'SPANS_EXEC_NOT_COMPLETED',
      ok: false,
    });
    expect((await fx.admission.status()).leases).toHaveLength(1);
    await service.cancel({ attemptId: launched.attemptId, runId: 'run-1' });
    await service.idle();
  });

  test("a report cannot make another run's output readable through this run", async () => {
    const service = await readyService();
    const launched = await service.dispatch(await dispatchInput(service));
    await service.idle();
    const { capture } = await attemptOf(service);
    const stranger = fx.artifacts.put({
      mediaType: 'text/plain',
      text: 'private elsewhere',
    });
    const base = {
      actionId: launched.actionId,
      generation: 0,
      outcome: 'completed',
      runId: 'run-1',
    };
    expect(
      await service.report({ ...base, artifactIds: [stranger.artifactId] })
    ).toMatchObject({ code: 'SPANS_EXEC_REQUEST_INVALID', ok: false });
    expect(
      fx.store.getArtifactReference({
        artifactId: stranger.artifactId,
        runId: 'run-1',
      }).found
    ).toBe(false);
    // Its own captured output may be named, and is not newly exposed by doing so.
    expect(
      await service.report({ ...base, artifactIds: [capture.artifactId] })
    ).toMatchObject({ ok: true, status: 'reported' });
  });

  // Another coordinator taking over is a generation step on the run view.
  function takeOver() {
    const read = fx.store.readRun({ runId: 'run-1' });
    const committed = fx.store.commitRun({
      events: [],
      expectedGeneration: read.generation,
      expectedRevision: read.revision,
      runId: 'run-1',
      view: { ...read.view, generation: read.generation + 1 },
    });
    expect(committed.ok).toBe(true);
  }

  test('a report from an older generation stays history and advances nothing', async () => {
    const service = await readyService();
    const launched = await service.dispatch(
      await dispatchInput(service, { instructions: 'MODE:hang' })
    );
    takeOver();
    const stale = await service.report({
      actionId: launched.actionId,
      generation: 0,
      outcome: 'completed',
      runId: 'run-1',
    });
    expect(stale).toMatchObject({
      advanced: false,
      historical: true,
      ok: true,
      status: 'historical',
    });
    expect(events('spans.action.outcome.historical')).toHaveLength(1);
    expect(run().actions[launched.actionId].state).toBe('intent');
    expect(run().spans.build.state).toBe('planned');
    expect(run().checkpoint).toBe(0);
    // A generation that is not the current one's past is refused outright.
    expect(
      await service.report({
        actionId: launched.actionId,
        generation: 9,
        outcome: 'completed',
        runId: 'run-1',
      })
    ).toMatchObject({ code: 'SPANS_EXEC_GENERATION_AHEAD', ok: false });
    await service
      .cancel({ attemptId: launched.attemptId, runId: 'run-1' })
      .catch(() => undefined);
  });

  test('an attempt that finishes after a takeover cannot complete the span', async () => {
    const service = await readyService();
    const launched = await service.dispatch(await dispatchInput(service));
    takeOver();
    await service.idle();
    // The late supervisor was fenced out: nothing recorded, nothing settled.
    expect((await attemptOf(service)).status).toBe('running');
    expect(run().actions[launched.actionId].state).toBe('intent');
    expect(run().spans.build.state).toBe('planned');
    expect(events('spans.completion.accepted')).toHaveLength(0);
    expect((await fx.admission.status()).leases).toHaveLength(1);
    expect(
      await service.complete({ actionId: launched.actionId, runId: 'run-1' })
    ).toMatchObject({ ok: false });
  });
});

describe('capability honesty', () => {
  const probeWith = async (env, overrides = {}) => {
    fx = createExecutionFixture();
    const service = fx.createService({
      provider: {
        command: [process.execPath, PROVIDER_FIXTURE],
        env: { SETU_FIXTURE_DELAY_MS: '50', ...env },
      },
      ...overrides,
    });
    return { probed: await service.probe({ profile: PROFILE }), service };
  };

  test('a model other than the one requested blocks the launch', async () => {
    const { probed } = await probeWith({
      SETU_FIXTURE_MODEL: 'some-other-model',
    });
    expect(probed.launch.allowed).toBe(false);
    expect(probed.launch.blockedBy).toContain('model');
  });

  test('a provider that did not stop at its budget has no enforced cap', async () => {
    const { probed } = await probeWith(
      { SETU_FIXTURE_PROBE: 'uncapped' },
      { profiles: METERED_PROFILES }
    );
    expect(probed.launch.allowed).toBe(false);
    expect(probed.launch.blockedBy).toContain('hardCostCap');
  });

  test('a command that cannot run records no evidence at all', async () => {
    fx = createExecutionFixture();
    const service = fx.createService({
      provider: { command: ['/nonexistent/provider'] },
    });
    expect(await service.probe({ profile: PROFILE })).toMatchObject({
      code: 'SPANS_EXEC_PROBE_FAILED',
      ok: false,
    });
    expect(
      (await service.capabilities({ profile: PROFILE })).launch.allowed
    ).toBe(false);
  });

  test('evidence goes stale and a launch then needs a new probe', async () => {
    const clock = { t: 1_000_000 };
    const service = await readyService({ now: () => clock.t });
    expect(
      (await service.capabilities({ profile: PROFILE })).launch.allowed
    ).toBe(true);
    clock.t += 7 * 60 * 60 * 1000;
    expect(
      (await service.capabilities({ profile: PROFILE })).launch.allowed
    ).toBe(false);
    expect(await service.review(REVIEW)).toMatchObject({
      code: 'SPANS_EXEC_CAPABILITY_UNVERIFIED',
      ok: false,
    });
  });
});

describe('spend and trust boundaries', () => {
  test('refuses a budget, time or instruction outside what may be reviewed', async () => {
    const service = await readyService();
    for (const override of [
      { budgetUsd: 2.5 },
      { budgetUsd: 0 },
      { budgetUsd: 0.000_000_1 },
      { wallClockMs: 3_600_001 },
      { wallClockMs: 10 },
      { instructions: '' },
      { instructions: 'use sk-abcdefghijklmnopqrstuvwxyz0123 here' },
      { profile: 'not-a-profile' },
      { target: { name: '../escape', repo: 'demo' } },
      { target: { extra: 1, name: 'feature', repo: 'demo' } },
    ]) {
      // biome-ignore lint/performance/noAwaitInLoops: Each step depends on the one before it, so they run in order.
      const result = await service.review({ ...REVIEW, ...override });
      expect(result.ok).toBe(false);
    }
    expect((await fx.admission.status()).leases).toEqual([]);
  });

  test('the headless ceilings and these ceilings are the same numbers', async () => {
    const { DEFAULT_MAX_BUDGET_USD, RUN_TIMEOUT_MS } = await import(
      './agent.js'
    );
    const { SPANS_EXEC_LIMITS } = await import('./spans-execution.js');
    expect(SPANS_EXEC_LIMITS.maxBudgetUsd).toBe(DEFAULT_MAX_BUDGET_USD);
    expect(SPANS_EXEC_LIMITS.maxWallClockMs).toBe(RUN_TIMEOUT_MS);
  });

  test('a recorded authorization that does not match the dispatch authorizes nothing', async () => {
    const service = await readyService();
    const input = await dispatchInput(service);
    // Someone writes an authorization for this action with a different binding.
    const read = fx.store.readRun({ runId: 'run-1' });
    const reviewed = await service.review(REVIEW);
    const forged = {
      actionId: reviewed.review.actionId,
      attemptId: reviewed.review.attemptId,
      authorizationId: 'spans-auth-forged',
      bindingDigest: 'f'.repeat(64),
      budgetMicro: 9_000_000,
      instructions: 'something else entirely',
      runId: 'run-1',
      spanId: 'build',
    };
    fx.store.commitRun({
      events: [],
      expectedGeneration: read.generation,
      expectedRevision: read.revision,
      runId: 'run-1',
      view: { ...read.view, executions: { [forged.actionId]: forged } },
    });
    const result = await service.dispatch(input);
    expect(result).toMatchObject({
      code: 'SPANS_EXEC_AUTHORIZATION_NOT_RECORDED',
      ok: false,
    });
    expect(events('spans.worker.intent')).toHaveLength(0);
    expect((await fx.admission.status()).leases).toEqual([]);
  });

  test('reads and reviews never start a worker', async () => {
    const service = await readyService();
    const baseline = fx.providerPids().length;
    await service.review(REVIEW);
    await service.capabilities({ profile: PROFILE });
    await service.status({ runId: 'run-1' });
    await service.usage({ runId: 'run-1' });
    await service.dispatch(REVIEW);
    expect(fx.providerPids()).toHaveLength(baseline);
    expect(events('spans.worker.intent')).toHaveLength(0);
  });

  test('a result with no cost figure still completes on a subscription and records no estimate', async () => {
    const { launched, service } = await finishedService('MODE:nocost');
    expect(run().actions[launched.actionId].state).toBe('completed');
    expect((await fx.admission.status()).leases).toEqual([]);
    expect(await service.usage({ runId: 'run-1' })).toMatchObject({
      heldCount: 0,
      unmeteredCount: 1,
    });
    expect(run().completions[launched.actionId].reported.usage).toMatchObject({
      apiEquivalentMicro: null,
      billed: 'unknown',
      costCheck: 'absent',
    });
    const status = await service.status({ runId: 'run-1' });
    expect(status.executions[0].resources.usage).toBe('released');
  });
});

describe('the whole plan', () => {
  test('a dependent span runs after the first is accepted, and the run ends complete', async () => {
    const { launched, service } = await finishedService();
    const asked = await service.accept({
      actionId: launched.actionId,
      runId: 'run-1',
    });
    await service.accept({
      actionId: launched.actionId,
      confirmation: asked.confirmation,
      runId: 'run-1',
    });
    expect(run().spans.verify.state).toBe('ready');

    const second = await service.dispatch(
      await dispatchInput(service, { spanId: 'verify' })
    );
    expect(second).toMatchObject({ ok: true, status: 'launched' });
    expect(second.actionId).not.toBe(launched.actionId);
    await service.idle();
    const again = await service.accept({
      actionId: second.actionId,
      runId: 'run-1',
    });
    const accepted = await service.accept({
      actionId: second.actionId,
      confirmation: again.confirmation,
      runId: 'run-1',
    });
    expect(accepted).toMatchObject({
      accepted: true,
      checkpoint: 2,
      readySpanIds: [],
    });
    expect(run().spans.build.state).toBe('completed');
    expect(run().spans.verify.state).toBe('completed');
    expect(claimOf()).toBeNull();
    expect((await fx.admission.status()).leases).toEqual([]);
    expect(await service.usage({ runId: 'run-1' })).toMatchObject({
      outstandingReservationMicro: 0,
      runActualMicro: 0,
      unmeteredCount: 2,
    });
  }, 20_000);

  test('a new probe invalidates a confirmation reviewed against the old one', async () => {
    const service = await readyService();
    const approved = await dispatchInput(service);
    await service.probe({ profile: PROFILE });
    const result = await service.dispatch(approved);
    expect(result).toMatchObject({
      code: 'SPANS_EXEC_REVIEW_CHANGED',
      ok: false,
    });
    expect((await fx.admission.status()).leases).toEqual([]);
  });

  test('a target that cannot be resolved is refused, not thrown', async () => {
    const service = await readyService({
      resolveTarget: () => Promise.reject(new Error('registry unavailable')),
    });
    expect(await service.review(REVIEW)).toMatchObject({
      code: 'SPANS_EXEC_TARGET_UNKNOWN',
      ok: false,
    });
  });
});

describe('stored inputs', () => {
  test('instructions changed after authorization are never run', async () => {
    fx = createExecutionFixture();
    await fx.completeSetup();
    // Right after the intent is durable, the stored instructions are altered.
    const tampering = {
      ...fx.store,
      commitRun(request) {
        const result = fx.store.commitRun(request);
        if (
          result.ok &&
          request.events.some((e) => e.type === 'spans.action.intent')
        ) {
          const read = fx.store.readRun({ runId: 'run-1' });
          const [record] = Object.values(read.view.executions);
          fx.store.commitRun({
            events: [],
            expectedGeneration: read.generation,
            expectedRevision: read.revision,
            runId: 'run-1',
            view: {
              ...read.view,
              executions: {
                [record.actionId]: {
                  ...record,
                  instructions: 'rm -rf everything',
                },
              },
            },
          });
        }
        return result;
      },
    };
    const service = fx.createService({ archive: { store: tampering } });
    await service.probe({ profile: PROFILE });
    const result = await service.dispatch(await dispatchInput(service));
    expect(result).toMatchObject({ code: 'LAUNCH_REFUSED', ok: false });
    expect(events('spans.worker.launched')).toHaveLength(0);
    expect(fx.providerPids()).toHaveLength(1);
    expect((await fx.admission.status()).leases).toEqual([]);
  });
});

describe('independent review: cancellation then a clean exit', () => {
  test('a delivered cancel followed by exit 0 and a success result is never completion', async () => {
    const service = await readyService({ escalationMs: 5000 });
    const launched = await service.dispatch(
      await dispatchInput(service, { instructions: 'MODE:graceful-stop' })
    );
    await waitFor(
      async () => (await attemptOf(service))?.status === 'running',
      'running'
    );
    await Bun.sleep(300);
    const cancelled = await service.cancel({
      attemptId: launched.attemptId,
      runId: 'run-1',
    });
    expect(cancelled).toMatchObject({ cancel: 'delivered', ok: true });
    await service.idle();

    // The process really did exit cleanly after reporting success.
    expect(await attemptOf(service)).toMatchObject({
      cancel: { state: 'delivered' },
      exit: { code: 0, signal: null },
      status: 'exited',
    });
    const lines = await capturedOutput(service);
    expect(lines.at(-1)).toMatchObject({ subtype: 'success', type: 'result' });

    expect(run().actions[launched.actionId].state).toBe('failed');
    expect(run().completions[launched.actionId].outcome).toBe('failed');
    const input = { actionId: launched.actionId, runId: 'run-1' };
    expect(await service.accept(input)).toMatchObject({
      code: 'SPANS_EXEC_NOT_COMPLETED',
      ok: false,
    });
    expect(run().spans.build.state).toBe('planned');
    expect(run().spans.verify.state).toBe('planned');
    expect(
      (await service.status({ runId: 'run-1' })).executions[0].acceptance
    ).toBe('none');
  });
});

describe('independent review: a refused dispatch before intent', () => {
  const OTHER = {
    agent: 'codex',
    pid: process.pid,
    session: 'other-session',
    task: 'editing',
  };

  test('a safely refused authorization does not block a newly reviewed, changed dispatch', async () => {
    const service = await readyService();
    const { claimWriter, releaseWriter } = await import('./writer-claims.js');
    claimWriter(fx.wtDir, OTHER);
    const first = await service.dispatch(await dispatchInput(service));
    expect(first).toMatchObject({ code: 'WRITER_BUSY', ok: false });
    expect(events('spans.worker.intent')).toHaveLength(0);

    releaseWriter(fx.wtDir, OTHER.session);
    const changed = { instructions: 'Create a different file, please.' };
    const second = await service.dispatch(
      await dispatchInput(service, changed)
    );
    expect(second).toMatchObject({ ok: true, status: 'launched' });
    await service.idle();
    expect(events('spans.worker.launched')).toHaveLength(1);
    const [attempt] = (await service.status({ runId: 'run-1' })).attempts;
    expect(
      fx.artifacts.read({ artifactId: attempt.capture.artifactId }).text
    ).toContain('Create a different file');
  });

  test('the same input still retries, and a refusal is recorded as withdrawn', async () => {
    const service = await readyService();
    const { claimWriter, releaseWriter } = await import('./writer-claims.js');
    claimWriter(fx.wtDir, OTHER);
    const input = await dispatchInput(service);
    expect(await service.dispatch(input)).toMatchObject({
      code: 'WRITER_BUSY',
    });
    expect(events('spans.execution.authorization-withdrawn')).toHaveLength(1);
    expect(run().executions).toEqual({});
    releaseWriter(fx.wtDir, OTHER.session);
    expect(await service.dispatch(input)).toMatchObject({ status: 'launched' });
    await service.idle();
  });

  test('a refusal that keeps the writer claim says exactly what is held, and a retry reuses it', async () => {
    fx = createExecutionFixture();
    await fx.completeSetup();
    const refusals = ['STORAGE_LOW'];
    const service = fx.createService({
      admission: new Proxy(
        {},
        {
          get: (_, key) =>
            key === 'admit'
              ? (value) =>
                  refusals.length > 0
                    ? Promise.resolve({ code: refusals.pop(), ok: false })
                    : fx.admission.admit(value)
              : fx.admission[key],
        }
      ),
    });
    await service.probe({ profile: PROFILE });
    const input = await dispatchInput(service);
    const refused = await service.dispatch(input);

    expect(refused).toMatchObject({ code: 'ADMISSION_REFUSED', ok: false });
    expect(refused.resources.writer).toBe('held');
    // Recovery is data: the checkout and the session to give to `setu release`.
    const { session } = claimOf();
    expect(refused.recovery).toEqual({
      writer: { checkoutPath: fx.wtDir, session },
    });
    // Nothing was released behind the caller's back.
    expect(claimOf()).toMatchObject({ agent: 'spans' });
    expect(run().executions).toEqual({});

    // The same span is dispatched again and reuses the claim.
    expect(await service.dispatch(input)).toMatchObject({ status: 'launched' });
    await service.idle();
  });

  test('an authorization that reached intent is never withdrawn or replaced', async () => {
    const service = await readyService();
    const input = await dispatchInput(service, { instructions: 'MODE:hang' });
    const launched = await service.dispatch(input);
    expect(launched.status).toBe('launched');
    const before = run().executions[launched.actionId];
    // Same action id is not reachable for a new dispatch while it is open.
    const again = await service.dispatch({
      ...input,
      instructions: 'MODE:hang changed',
    });
    expect(again.ok).toBe(false);
    expect(run().executions[launched.actionId]).toEqual(before);
    expect(events('spans.execution.authorization-withdrawn')).toHaveLength(0);
    await service.cancel({ attemptId: launched.attemptId, runId: 'run-1' });
    await service.idle();
  });
});

describe('independent review: status reports what dispatch really holds', () => {
  test('a running attempt shows its admission lease, usage reservation and writer as held', async () => {
    const service = await readyService();
    const launched = await service.dispatch(
      await dispatchInput(service, { instructions: 'MODE:hang' })
    );
    expect(launched.status).toBe('launched');
    const { leases } = await fx.admission.status();
    expect(leases).toHaveLength(1);
    const [execution] = (await service.status({ runId: 'run-1' })).executions;
    // The ids status derives are the ones dispatch used, so none reads released.
    expect(execution.resources).toEqual({
      admission: 'held',
      usage: 'reserved',
      writer: { session: claimOf().session },
    });
    await service.cancel({ attemptId: launched.attemptId, runId: 'run-1' });
    await service.idle();
  });
});

describe('independent review: what the live probe shape really proves', () => {
  const RECORDED = join(
    import.meta.dir,
    'spans-execution.recorded-probe.jsonl'
  );

  // A spawn that replays recorded bytes instead of starting anything. It is the
  // shape of one live Claude Code session, with paths and ids removed.
  const replay = (bytes) => () => ({
    exited: Promise.resolve(0),
    kill: () => undefined,
    stdin: { end: () => undefined, write: () => undefined },
    stdout: new Response(bytes).body,
  });

  test('the recorded metered shape has no observed effort and no hard cap, so nothing can launch', async () => {
    fx = createExecutionFixture();
    const service = fx.createService({
      profiles: METERED_PROFILES,
      spawn: replay(readFileSync(RECORDED, 'utf8')),
    });
    const probed = await service.probe({ profile: PROFILE });

    expect(probed.launch.allowed).toBe(false);
    expect(probed.launch.blockedBy).toEqual(
      expect.arrayContaining(['effort', 'hardCostCap'])
    );
    // The flag we send and the session's per-turn self-report are shown as
    // what they are; neither becomes an observed effort.
    expect(probed.observations.effort).toEqual({
      observed: null,
      perTurnEffortActive: true,
      policy: 'observed',
      requested: 'medium',
    });
    expect(probed.observations.budget).toMatchObject({
      capUsd: 0.0001,
      costCheck: 'self-consistent',
      costUsd: 0.010_300_9,
      overshot: true,
      stop: true,
    });
    await fx.completeSetup();
    expect(await service.review({ ...REVIEW, budgetUsd: 0.5 })).toMatchObject({
      code: 'SPANS_EXEC_CAPABILITY_UNVERIFIED',
      ok: false,
    });
  });

  // Claude Code's budget stop happens after the response that crosses it, so
  // no sample of it, under, at or over the cap, is a hard cap.
  test.each([
    ['under', undefined],
    ['at', 'equal'],
    ['over', 'soft'],
  ])('a budget stop %s the cap is never an enforced cap', async (_, mode) => {
    fx = createExecutionFixture();
    const service = fx.createService({
      profiles: METERED_PROFILES,
      provider: {
        command: [process.execPath, PROVIDER_FIXTURE],
        env: {
          SETU_FIXTURE_DELAY_MS: '50',
          SETU_FIXTURE_PIDFILE: join(fx.root, 'provider-pids'),
          ...(mode ? { SETU_FIXTURE_PROBE: mode } : {}),
        },
      },
    });
    const probed = await service.probe({ profile: PROFILE });
    expect(probed.launch.allowed).toBe(false);
    expect(probed.launch.blockedBy).toContain('hardCostCap');
    expect(probed.observations.budget.stop).toBe(true);
    await fx.completeSetup();
    expect(await service.review({ ...REVIEW, budgetUsd: 0.5 })).toMatchObject({
      code: 'SPANS_EXEC_CAPABILITY_UNVERIFIED',
      ok: false,
    });
  });

  test('a stop after overspending the cap is not an enforced cap', async () => {
    fx = createExecutionFixture();
    const service = fx.createService({
      profiles: METERED_PROFILES,
      provider: {
        command: [process.execPath, PROVIDER_FIXTURE],
        env: {
          SETU_FIXTURE_DELAY_MS: '50',
          SETU_FIXTURE_PIDFILE: join(fx.root, 'provider-pids'),
          SETU_FIXTURE_PROBE: 'soft',
        },
      },
    });
    const probed = await service.probe({ profile: PROFILE });
    expect(probed.launch.blockedBy).toContain('hardCostCap');
    expect(probed.observations.budget.overshot).toBe(true);
  });

  test('every probe is accounted, including its overspend', async () => {
    fx = createExecutionFixture();
    const service = fx.createService({
      profiles: METERED_PROFILES,
      provider: {
        command: [process.execPath, PROVIDER_FIXTURE],
        env: {
          SETU_FIXTURE_DELAY_MS: '50',
          SETU_FIXTURE_PIDFILE: join(fx.root, 'provider-pids'),
          SETU_FIXTURE_PROBE: 'soft',
        },
      },
    });
    expect((await service.capabilities({ profile: PROFILE })).probeSpend).toBe(
      undefined
    );
    await service.probe({ profile: PROFILE });
    await service.probe({ profile: PROFILE });
    const { probeSpend } = await service.capabilities({ profile: PROFILE });
    expect(probeSpend).toMatchObject({
      probes: 2,
      subscriptionProbes: 0,
      totalMicro: 20_602,
      unpriced: 0,
    });
  });

  test('provider figures that disagree with each other are shown as a mismatch, not an amount', async () => {
    fx = createExecutionFixture();
    await fx.completeSetup();
    const service = fx.createService({
      provider: {
        command: [process.execPath, PROVIDER_FIXTURE],
        env: {
          SETU_FIXTURE_DELAY_MS: '250',
          SETU_FIXTURE_MODEL_COST: '0.5',
          SETU_FIXTURE_NO_EFFORT: '1',
          SETU_FIXTURE_PIDFILE: join(fx.root, 'provider-pids'),
        },
      },
    });
    await service.probe({ profile: PROFILE });
    const launched = await service.dispatch(await dispatchInput(service));
    expect(launched.status).toBe('launched');
    await service.idle();
    const completion = fx.store.readRun({ runId: 'run-1' }).view.completions[
      launched.actionId
    ];
    expect(completion.reported.usage).toMatchObject({
      apiEquivalentMicro: null,
      billed: 'unknown',
      costCheck: 'mismatch',
    });
    expect((await service.usage({ runId: 'run-1' })).runActualMicro).toBe(0);
  });
});

describe('independent review: completion evidence', () => {
  const withInstructions = (instructions, extra = {}) => ({
    instructions,
    ...extra,
  });

  async function finish(instructions, extra) {
    const service = await readyService();
    const launched = await service.dispatch(
      await dispatchInput(
        service,
        withInstructions(instructions ?? REVIEW.instructions, extra)
      )
    );
    expect(launched.status).toBe('launched');
    await service.idle();
    return {
      input: { actionId: launched.actionId, runId: 'run-1' },
      launched,
      service,
    };
  }

  function bumpGeneration() {
    const read = fx.store.readRun({ runId: 'run-1' });
    const committed = fx.store.commitRun({
      events: [],
      expectedGeneration: read.generation,
      expectedRevision: read.revision,
      runId: 'run-1',
      view: { ...read.view, generation: read.generation + 1 },
    });
    expect(committed.ok).toBe(true);
  }

  function editCompletion(actionId, change) {
    const read = fx.store.readRun({ runId: 'run-1' });
    const view = structuredClone(read.view);
    change(view.completions[actionId]);
    expect(
      fx.store.commitRun({
        events: [],
        expectedGeneration: read.generation,
        expectedRevision: read.revision,
        runId: 'run-1',
        view,
      }).ok
    ).toBe(true);
  }

  test('the review binds the exact tree the work will start from', async () => {
    const service = await readyService();
    const input = await dispatchInput(service);
    const reviewed = await service.review(REVIEW);
    expect(reviewed.review.checkout.tree.digest).toMatch(HEX_64);
    expect(reviewed.review.acceptance).toEqual({
      criteria: [],
      requireChange: false,
    });
    // An edit to a tracked file changes nothing in HEAD or the dirty count's
    // shape the first time, but it changes the tree, and so the confirmation.
    await Bun.write(join(fx.wtDir, 'README.md'), 'edited after the review\n');
    const result = await service.dispatch(input);
    expect(result).toMatchObject({
      code: 'SPANS_EXEC_REVIEW_CHANGED',
      ok: false,
    });
    expect(events('spans.worker.intent')).toHaveLength(0);
    expect(fx.providerPids()).toHaveLength(1); // the probe only
    const again = await service.review(REVIEW);
    expect(again.review.checkout.tree.digest).not.toBe(
      reviewed.review.checkout.tree.digest
    );
  });

  test('a tree that changes after confirmation, before launch, starts nothing', async () => {
    let calls = 0;
    const armed = new Set();
    const service = await readyService({
      resolveTarget: (target) => {
        calls += 1;
        // The first look is the dispatch's own review; any later look is the
        // launch boundary, after the confirmation was already matched.
        if (armed.has('launch-boundary') && calls >= 2) {
          writeFileSync(
            join(fx.wtDir, 'README.md'),
            'changed at the last moment\n'
          );
        }
        return Promise.resolve(
          target.repo === TARGET.repo && target.name === TARGET.name
            ? { repoDir: fx.repoDir, wtDir: fx.wtDir }
            : null
        );
      },
    });
    const input = await dispatchInput(service);
    const probes = fx.providerPids().length;
    calls = 0;
    armed.add('launch-boundary');
    const result = await service.dispatch(input);
    await Bun.sleep(100);
    expect(result.ok).toBe(false);
    expect(fx.providerPids()).toHaveLength(probes);
    expect(events('spans.worker.launched')).toHaveLength(0);
    expect((await fx.admission.status()).leases).toEqual([]);
  });

  test('a run that changes nothing can complete a verification span when the review allows it', async () => {
    const { input, service } = await finish('MODE:noop');
    expect(run().completions[input.actionId]).toMatchObject({
      change: { headMoved: false, treeChanged: false },
      checks: { cancel: 'none', exit: 'clean', requireChange: 'not-required' },
      independentValidation: false,
      outcome: 'completed',
      reported: { providerResult: 'success' },
    });
    const asked = await service.accept(input);
    expect(asked.review).toMatchObject({
      accepted: false,
      after: { digest: asked.review.before.digest },
      independentValidation: false,
      reported: { providerResult: 'success' },
      validation: 'owner-judgement',
      verified: { exit: 'clean', requireChange: 'not-required' },
    });
    const accepted = await service.accept({
      ...input,
      confirmation: asked.confirmation,
    });
    expect(accepted).toMatchObject({ accepted: true, ok: true });
    expect(run().spans.verify.state).toBe('ready');
  });

  test('a reviewed requirement to change the tree fails a run that changed nothing', async () => {
    const { input, launched, service } = await finish('MODE:noop', {
      requireChange: true,
    });
    expect(run().actions[launched.actionId].state).toBe('failed');
    expect(run().completions[input.actionId]).toMatchObject({
      checks: { requireChange: 'unmet' },
      outcome: 'failed',
    });
    expect(await service.accept(input)).toMatchObject({
      code: 'SPANS_EXEC_NOT_COMPLETED',
      ok: false,
    });
    expect(run().spans.build.state).toBe('planned');
  });

  test('an empty commit moves HEAD but is not a change of content', async () => {
    const { input, service } = await finish('MODE:commit', {
      requireChange: true,
    });
    expect(run().completions[input.actionId]).toMatchObject({
      change: { headMoved: true, treeChanged: false },
      outcome: 'failed',
    });
    expect(await service.accept(input)).toMatchObject({ ok: false });
  });

  test('the acceptance review shows before and after, the paths, the criteria and the artifacts', async () => {
    const criteria = ['fixture-output.txt exists', 'nothing else changed'];
    const { input, service } = await finish(REVIEW.instructions, {
      criteria,
      requireChange: true,
    });
    const { review } = await service.accept(input);
    expect(review.before.digest).not.toBe(review.after.digest);
    expect(review.before.head).toBe(review.after.head);
    expect(review.change).toEqual({ headMoved: false, treeChanged: true });
    expect(review.changedPaths).toEqual({
      paths: ['fixture-output.txt'],
      total: 1,
      truncated: false,
    });
    expect(review.criteria).toEqual(criteria);
    expect(review.artifactIds).toHaveLength(1);
    expect(review.verified.requireChange).toBe('met');
    expect(review.reported.costCheck).toBe('single-field');
    const status = await service.status({ runId: 'run-1' });
    expect(status.executions[0].completion).toMatchObject({
      independentValidation: false,
      recordIntact: true,
    });
  });

  test('criteria and the change requirement are bound by the confirmation', async () => {
    const service = await readyService();
    const one = await service.review(REVIEW);
    const withCriteria = await service.review({
      ...REVIEW,
      criteria: ['it works'],
    });
    const required = await service.review({ ...REVIEW, requireChange: true });
    expect(
      new Set([
        one.confirmation,
        withCriteria.confirmation,
        required.confirmation,
      ]).size
    ).toBe(3);
    expect(await service.review({ ...REVIEW, criteria: [''] })).toMatchObject({
      code: 'SPANS_EXEC_REQUEST_INVALID',
    });
    expect(
      await service.review({ ...REVIEW, requireChange: 'yes' })
    ).toMatchObject({ code: 'SPANS_EXEC_REQUEST_INVALID' });
  });

  test('a completion record edited after the fact is refused, even if made to match the tree', async () => {
    const { input, service } = await finish();
    const { confirmation } = await service.accept(input);
    await Bun.write(join(fx.wtDir, 'fixture-output.txt'), 'edited later\n');
    const observed = await (
      await import('./spans-execution-verifier.js')
    ).observeTree(fx.wtDir);
    editCompletion(input.actionId, (completion) => {
      completion.tree.digest = observed.digest;
    });
    expect(await service.accept({ ...input, confirmation })).toMatchObject({
      code: 'SPANS_EXEC_EVIDENCE_INVALID',
      ok: false,
    });
    expect(run().spans.build.state).toBe('planned');
    expect(
      (await service.status({ runId: 'run-1' })).executions[0].acceptance
    ).toBe('none');
  });

  test('a completion whose outcome or artifacts were edited is refused', async () => {
    const { input, service } = await finish();
    editCompletion(input.actionId, (completion) => {
      completion.checks.requireChange = 'met';
    });
    expect(await service.accept(input)).toMatchObject({
      code: 'SPANS_EXEC_EVIDENCE_INVALID',
    });
    editCompletion(input.actionId, (completion) => {
      completion.artifactIds = ['art-forged'];
    });
    expect(await service.accept(input)).toMatchObject({
      code: 'SPANS_EXEC_EVIDENCE_INVALID',
    });
    expect(run().spans.build.state).toBe('planned');
  });

  test('a confirmation reviewed before the generation moved on is stale', async () => {
    const { input, service } = await finish();
    const { confirmation } = await service.accept(input);
    bumpGeneration();
    const stale = await service.accept({ ...input, confirmation });
    expect(stale).toMatchObject({
      code: 'SPANS_EXEC_REVIEW_CHANGED',
      ok: false,
    });
    expect(run().spans.build.state).toBe('planned');
    expect(events('spans.completion.accepted')).toHaveLength(0);
  });

  test('a cancelled attempt cannot be accepted, whatever it printed', async () => {
    const service = await readyService({ escalationMs: 5000 });
    const launched = await service.dispatch(
      await dispatchInput(service, { instructions: 'MODE:graceful-stop' })
    );
    await waitFor(
      async () => (await attemptOf(service))?.status === 'running',
      'running'
    );
    await Bun.sleep(300);
    await service.cancel({ attemptId: launched.attemptId, runId: 'run-1' });
    await service.idle();
    const input = { actionId: launched.actionId, runId: 'run-1' };
    expect(await service.accept(input)).toMatchObject({ ok: false });
    expect(
      await service.accept({ ...input, confirmation: 'spans-accept:forged' })
    ).toMatchObject({ ok: false });
    expect(run().completions[launched.actionId].checks.cancel).toBe(
      'cancelled'
    );
    expect(run().spans.build.state).toBe('planned');
  });
});
