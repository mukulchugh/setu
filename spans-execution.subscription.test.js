import { afterEach, describe, expect, test } from 'bun:test';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  createExecutionFixture,
  METERED_PROFILES,
  PROFILE,
  PROVIDER_FIXTURE,
  SUBSCRIPTION_PROFILES,
  TARGET,
} from './spans-execution.test-support.js';

// Process tests for the subscription profile. The provider is the local
// fixture command; nothing here talks to a provider, so none of it is
// provider acceptance. It shows what Setu reviews, binds, launches and records
// for a profile that has no dollar budget.

let fx;
afterEach(async () => {
  await fx?.dispose();
  fx = undefined;
});

// The init and result lines of one real subscription task session (not a
// probe: a worker doing work), with paths, ids and provider text removed.
const RECORDED_TASK = join(
  import.meta.dir,
  'spans-execution.recorded-live-subscription-task.jsonl'
);
const RECORDED_METERED = join(
  import.meta.dir,
  'spans-execution.recorded-probe.jsonl'
);
const LOCAL_PATH = /\/Users|\/private|\/var\/|\/tmp\//;
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-/;
const CREDENTIAL = /sk-|Bearer /;
const TOOLS = ['Bash', 'Edit', 'Glob', 'Grep', 'Read', 'Write'];

const REVIEW = Object.freeze({
  instructions: 'Create fixture-output.txt in the checkout.',
  profile: PROFILE,
  runId: 'run-1',
  spanId: 'build',
  target: TARGET,
  wallClockMs: 30_000,
});

const providerOf = (extra = {}) => ({
  command: [process.execPath, PROVIDER_FIXTURE],
  env: {
    SETU_FIXTURE_DELAY_MS: '100',
    SETU_FIXTURE_NO_EFFORT: '1',
    SETU_FIXTURE_PIDFILE: join(fx.root, 'provider-pids'),
    ...extra,
  },
});

// A spawn that replays recorded bytes instead of starting anything.
const replay = (bytes) => () => ({
  exited: Promise.resolve(0),
  kill: () => undefined,
  stdin: { end: () => undefined, write: () => undefined },
  stdout: new Response(bytes).body,
});

async function subscriptionService(options = {}) {
  fx = createExecutionFixture({ profiles: SUBSCRIPTION_PROFILES });
  await fx.completeSetup();
  return fx.createService({
    provider: providerOf(options.env),
    ...options.rest,
  });
}

async function readyService(options) {
  const service = await subscriptionService(options);
  await service.probe({ profile: PROFILE });
  return service;
}

const run = () => fx.store.readRun({ runId: 'run-1' }).view;

async function capturedInit(service) {
  const [attempt] = (await service.status({ runId: 'run-1' })).attempts;
  const read = fx.artifacts.read({ artifactId: attempt.capture.artifactId });
  return read.text
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line))
    .find((line) => line.subtype === 'init');
}

describe('the built-in profile', () => {
  test('is a subscription profile with auto mode, a coding toolset and no sub-agents', () => {
    const definition = SUBSCRIPTION_PROFILES[PROFILE];
    expect(definition).toMatchObject({
      billing: 'subscription',
      effortPolicy: 'requested-unverified',
      model: 'claude-sonnet-5-5',
      permissionMode: 'auto',
    });
    expect([...definition.tools].sort()).toEqual(TOOLS);
    expect(definition.tools).not.toContain('Agent');
    expect(definition.permissionMode).not.toBe('bypassPermissions');
  });
});

describe('the recorded real task session', () => {
  test('keeps no path, id, credential or provider text', () => {
    const text = readFileSync(RECORDED_TASK, 'utf8');
    expect(text).not.toMatch(LOCAL_PATH);
    expect(text).not.toMatch(UUID);
    expect(text).not.toMatch(CREDENTIAL);
    expect(text).not.toContain('"type":"assistant"');
  });
});

describe('probing a subscription profile', () => {
  test('is one short reply with no budget flag, the reviewed mode and toolset', async () => {
    fx = createExecutionFixture({ profiles: SUBSCRIPTION_PROFILES });
    const argvs = [];
    const service = fx.createService({
      provider: providerOf(),
      spawn: (command, spawnOptions) => {
        argvs.push(command);
        return Bun.spawn(command, spawnOptions);
      },
    });
    await service.probe({ profile: PROFILE });

    const [argv] = argvs;
    expect(argv).not.toContain('--max-budget-usd');
    // Isolated from ambient settings, hooks and memory, probe and worker alike.
    const flag = argv.indexOf('--setting-sources');
    expect(argv.indexOf('--restricted')).toBeGreaterThan(-1);
    expect(argv[flag + 1]).toBe('');
    expect(argv).toEqual(
      expect.arrayContaining([
        '--strict-mcp-config',
        '--permission-mode',
        'auto',
        '--permission-prompts',
        'none',
        '--tools',
        TOOLS.join(','),
      ])
    );
    expect(argv).not.toContain('bypassPermissions');
    expect(argv.join(' ')).not.toContain('Agent');
    expect(argv).not.toContain('--mcp-config');
  });

  test('can launch without a cost cap or an observed effort, and says so', async () => {
    fx = createExecutionFixture({ profiles: SUBSCRIPTION_PROFILES });
    const service = fx.createService({ provider: providerOf() });
    const probed = await service.probe({ profile: PROFILE });

    expect(probed.launch).toEqual({
      allowed: true,
      blockedBy: [],
      unverified: ['effort'],
    });
    expect(probed.observations.effort).toEqual({
      observed: null,
      perTurnEffortActive: true,
      policy: 'requested-unverified',
      requested: 'medium',
    });
    expect(probed.observations.billing).toBe('subscription');
    // No budget was set, so no cap is claimed anywhere.
    expect(probed.observations.budget).toBeUndefined();
    expect(JSON.stringify(probed)).not.toContain('"enforced"');
  });

  test('records its usage as an estimate, never as a charge', async () => {
    fx = createExecutionFixture({ profiles: SUBSCRIPTION_PROFILES });
    const service = fx.createService({ provider: providerOf() });
    const probed = await service.probe({ profile: PROFILE });

    expect(probed.observations.usage).toEqual({
      apiEquivalentUsd: 0.010_300_9,
      billed: 'unknown',
      costCheck: 'self-consistent',
      tokens: { cacheCreation: 2548, cacheRead: 0, input: 3, output: 5 },
    });
    expect(probed.probeSpend).toEqual({
      estimatedApiEquivalentMicro: 10_301,
      estimatedTokens: 2556,
      probes: 1,
      subscriptionProbes: 1,
      totalMicro: 0,
      unpriced: 0,
    });
  });

  test('a reported effort that differs from the request still blocks', async () => {
    fx = createExecutionFixture({ profiles: SUBSCRIPTION_PROFILES });
    const service = fx.createService({
      provider: providerOf({
        SETU_FIXTURE_EFFORT: 'high',
        SETU_FIXTURE_NO_EFFORT: '',
      }),
    });
    const probed = await service.probe({ profile: PROFILE });
    expect(probed.launch.allowed).toBe(false);
    expect(probed.launch.blockedBy).toContain('effort');
    expect(probed.launch.unverified).toBeUndefined();
  });

  test('a session in another permission mode or with extra tools blocks', async () => {
    // A script file, so the provider flags reach it and not the runtime.
    const stub = (init) => {
      const file = join(fx.root, 'stub-provider.js');
      writeFileSync(
        file,
        "console.log(JSON.stringify({type:'system',subtype:'init',model:'claude-sonnet-5-5',session_id:'s',...JSON.parse(process.env.STUB_INIT)}));console.log(JSON.stringify({type:'result',subtype:'success',is_error:false,total_cost_usd:0.01}));"
      );
      return {
        command: [process.execPath, file],
        env: { STUB_INIT: JSON.stringify(init) },
      };
    };
    const cases = [
      [{ permissionMode: 'acceptEdits', tools: TOOLS }, 'permissions'],
      [{ permissionMode: 'auto', tools: [...TOOLS, 'Agent'] }, 'tools'],
    ];
    for (const [init, blocker] of cases) {
      fx = createExecutionFixture({ profiles: SUBSCRIPTION_PROFILES });
      const service = fx.createService({ provider: stub(init) });
      // biome-ignore lint/performance/noAwaitInLoops: Each case builds its own fixture, so they run in order.
      const probed = await service.probe({ profile: PROFILE });
      expect(probed.launch.allowed).toBe(false);
      expect(probed.launch.blockedBy).toContain(blocker);
      await fx.dispose();
      fx = undefined;
    }
  });

  test('a probe that hit a budget stop is not a successful subscription probe', async () => {
    fx = createExecutionFixture({ profiles: SUBSCRIPTION_PROFILES });
    const service = fx.createService({
      spawn: replay(readFileSync(RECORDED_METERED, 'utf8')),
    });
    expect(await service.probe({ profile: PROFILE })).toMatchObject({
      code: 'SPANS_EXEC_PROBE_INCONCLUSIVE',
      ok: false,
    });
  });

  test('a real task session reports no effort, so it passes only by the explicit policy (init and result shape only)', async () => {
    fx = createExecutionFixture({ profiles: SUBSCRIPTION_PROFILES });
    const service = fx.createService({
      spawn: replay(readFileSync(RECORDED_TASK, 'utf8')),
    });
    const probed = await service.probe({ profile: PROFILE });
    expect(probed.launch).toEqual({
      allowed: true,
      blockedBy: [],
      unverified: ['effort'],
    });
    expect(probed.observations.effort).toMatchObject({
      observed: null,
      perTurnEffortActive: true,
    });
    expect(probed.observations.usage.tokens).toEqual({
      cacheCreation: 1580,
      cacheRead: 13_132,
      input: 4,
      output: 212,
    });

    // The same evidence under a profile with the default policy stays blocked.
    const strict = fx.createService({
      profiles: {
        [PROFILE]: {
          ...SUBSCRIPTION_PROFILES[PROFILE],
          effortPolicy: undefined,
        },
      },
      spawn: replay(readFileSync(RECORDED_TASK, 'utf8')),
    });
    const blocked = await strict.probe({ profile: PROFILE });
    expect(blocked.launch.allowed).toBe(false);
    expect(blocked.launch.blockedBy).toContain('effort');
  });
});

describe('reviewing a subscription dispatch', () => {
  test('binds mode, toolset and billing, and discloses that no money is capped', async () => {
    const service = await readyService();
    const reviewed = await service.review(REVIEW);

    expect(reviewed.ok).toBe(true);
    const { review } = reviewed;
    expect(review.budgetUsd).toBeUndefined();
    expect(review.cost).toMatchObject({
      billing: 'subscription',
      enforcement: 'none',
      monetaryCap: null,
    });
    expect(review.mode).toEqual({
      billing: 'subscription',
      effort: {
        observed: null,
        policy: 'requested-unverified',
        requested: 'medium',
        status: 'requested, not verified',
      },
      isolation: { restricted: true, settingSources: 'none' },
      model: 'claude-sonnet-5-5',
      permissionMode: 'auto',
      tools: TOOLS,
    });
    expect(review.requiredCapabilities).toEqual([
      'launch',
      'model',
      'permissions',
      'tools',
    ]);
    expect(review.launch.unverified).toEqual(['effort']);
  });

  test('a changed toolset or permission mode is a different review', async () => {
    fx = createExecutionFixture({ profiles: SUBSCRIPTION_PROFILES });
    await fx.completeSetup();
    const first = await fx.createService({ provider: providerOf() });
    await first.probe({ profile: PROFILE });
    const baseline = (await first.review(REVIEW)).confirmation;

    const narrower = fx.createService({
      profiles: {
        [PROFILE]: {
          ...SUBSCRIPTION_PROFILES[PROFILE],
          tools: ['Edit', 'Read', 'Write'],
        },
      },
      provider: providerOf(),
    });
    await narrower.probe({ profile: PROFILE });
    const changed = await narrower.review(REVIEW);
    expect(changed.ok).toBe(true);
    expect(changed.confirmation).not.toBe(baseline);
    expect(changed.review.mode.tools).toEqual(['Edit', 'Read', 'Write']);
  });

  test('a dollar budget cannot be set on a subscription profile', async () => {
    const service = await readyService();
    expect(await service.review({ ...REVIEW, budgetUsd: 1 })).toMatchObject({
      code: 'SPANS_EXEC_BUDGET_NOT_APPLICABLE',
      ok: false,
    });
    const reviewed = await service.review(REVIEW);
    expect(
      await service.dispatch({
        ...REVIEW,
        budgetUsd: 1,
        confirmation: reviewed.confirmation,
      })
    ).toMatchObject({ code: 'SPANS_EXEC_BUDGET_NOT_APPLICABLE', ok: false });
    expect(run().executions).toBeUndefined();
  });

  test('a metered Claude profile needs a budget and can never launch: its budget stop is not a hard cap', async () => {
    fx = createExecutionFixture({ profiles: METERED_PROFILES });
    await fx.completeSetup();
    const service = fx.createService({ profiles: METERED_PROFILES });
    const probed = await service.probe({ profile: PROFILE });
    expect(probed.launch.allowed).toBe(false);
    expect(probed.launch.blockedBy).toContain('hardCostCap');
    expect(await service.review(REVIEW)).toMatchObject({
      code: 'SPANS_EXEC_BUDGET_REQUIRED',
      ok: false,
    });
    expect(await service.review({ ...REVIEW, budgetUsd: 0.5 })).toMatchObject({
      blockedBy: expect.arrayContaining(['hardCostCap']),
      code: 'SPANS_EXEC_CAPABILITY_UNVERIFIED',
      ok: false,
    });
  });
});

describe('running a subscription dispatch', () => {
  async function finished(wanted, options) {
    const instructions = wanted ?? REVIEW.instructions;
    const service = await readyService(options);
    const reviewed = await service.review({ ...REVIEW, instructions });
    const launched = await service.dispatch({
      ...REVIEW,
      confirmation: reviewed.confirmation,
      instructions,
    });
    expect(launched.status).toBe('launched');
    await service.idle();
    return { launched, service };
  }

  test('launches with no budget flag and edits a file in the checkout', async () => {
    const { launched, service } = await finished();

    const init = await capturedInit(service);
    expect(init.args).not.toContain('--max-budget-usd');
    expect(init.args).toEqual(
      expect.arrayContaining([
        '--permission-mode',
        'auto',
        '--tools',
        TOOLS.join(','),
        '--strict-mcp-config',
      ])
    );
    expect(init.args).not.toContain('bypassPermissions');
    // The work really happened: the file exists with the fixture's content and
    // the tree differs from the reviewed one.
    expect(readFileSync(join(fx.wtDir, 'fixture-output.txt'), 'utf8')).toBe(
      'work done by the process fixture\n'
    );
    expect(fx.git(['status', '--porcelain'])).toContain('fixture-output.txt');

    const completion = run().completions[launched.actionId];
    expect(completion).toMatchObject({
      change: { treeChanged: true },
      checks: { requireChange: 'not-required', session: 'match' },
      costMicro: null,
      outcome: 'completed',
    });
    expect(completion.changedPaths.paths).toContain('fixture-output.txt');
    expect(completion.tree.digest).not.toBe(completion.baseline.digest);
  });

  test('reports usage as a provider estimate and settles no money', async () => {
    const { launched, service } = await finished();

    const completion = run().completions[launched.actionId];
    expect(completion.reported.usage).toEqual({
      apiEquivalentMicro: 12_500,
      basis: 'provider-reported estimate',
      billed: 'unknown',
      costCheck: 'single-field',
      tokens: null,
    });
    expect(completion.reported.session).toMatchObject({
      effort: null,
      model: 'claude-sonnet-5-5',
      permissionMode: 'auto',
      tools: TOOLS,
    });

    // The ledger holds nothing monetary: the reservation is released with no
    // amount, and the totals say they measured none.
    const usage = await service.usage({ runId: 'run-1' });
    expect(usage).toMatchObject({
      actualComplete: true,
      heldCount: 0,
      outstandingReservationMicro: 0,
      runActualMicro: 0,
      unmeteredCount: 1,
    });
    const [reservation] = Object.values(run().usage.reservations);
    expect(reservation).toMatchObject({
      actualMicro: null,
      reservationMicro: null,
      state: 'released',
    });
    expect(run().usage.policy).toEqual({
      aggregateLimitMicro: null,
      attemptLimitMicro: null,
      hardCap: false,
    });
    expect((await fx.admission.status()).leases).toEqual([]);
  });

  test('while it runs the reservation holds no amount and claims no cap', async () => {
    const service = await readyService({
      env: { SETU_FIXTURE_DELAY_MS: '600' },
    });
    const reviewed = await service.review(REVIEW);
    const launched = await service.dispatch({
      ...REVIEW,
      confirmation: reviewed.confirmation,
    });
    expect(launched.status).toBe('launched');
    expect(launched.resources.usage).toBe('held');
    // The ledger row carries no amount and the policy no limit and no hard cap.
    expect(Object.values(run().usage.reservations)[0]).toMatchObject({
      reservationMicro: null,
      state: 'reserved',
    });
    expect(run().usage.policy.hardCap).toBe(false);
    const usage = await service.usage({ runId: 'run-1' });
    expect(usage.outstandingReservationMicro).toBe(0);
    expect(usage.runExposureMicro).toBeNull();
    await service.idle();
  });

  test('acceptance shows the reviewed mode, the estimate and the distinction', async () => {
    const { launched, service } = await finished();
    const input = { actionId: launched.actionId, runId: 'run-1' };
    const shown = await service.accept(input);
    expect(shown.code).toBe('SPANS_EXEC_ACCEPTANCE_CONFIRMATION_REQUIRED');
    expect(shown.review).toMatchObject({
      independentValidation: false,
      mode: { billing: 'subscription', permissionMode: 'auto', tools: TOOLS },
      reported: {
        costMicro: null,
        usage: { billed: 'unknown' },
      },
      verified: { session: 'match' },
    });
    const accepted = await service.accept({
      ...input,
      confirmation: shown.confirmation,
    });
    expect(accepted).toMatchObject({ accepted: true, ok: true });
    expect(run().spans.build.state).toBe('completed');
  });

  test('a session that ran with another toolset is not completed work', async () => {
    const { launched, service } = await finished(
      'MODE:wrong-session do the work'
    );
    const completion = run().completions[launched.actionId];
    expect(completion).toMatchObject({
      checks: { session: 'mismatch' },
      outcome: 'failed',
    });
    expect(
      await service.accept({ actionId: launched.actionId, runId: 'run-1' })
    ).toMatchObject({ code: 'SPANS_EXEC_NOT_COMPLETED', ok: false });
  });

  test('cancellation still stops the one worker and is never completion', async () => {
    const service = await readyService({
      env: { SETU_FIXTURE_DELAY_MS: '250' },
    });
    const reviewed = await service.review({
      ...REVIEW,
      instructions: 'MODE:hang keep running',
    });
    const launched = await service.dispatch({
      ...REVIEW,
      confirmation: reviewed.confirmation,
      instructions: 'MODE:hang keep running',
    });
    expect(launched.status).toBe('launched');
    const [attempt] = (await service.status({ runId: 'run-1' })).attempts;
    expect(
      await service.cancel({ attemptId: attempt.attemptId, runId: 'run-1' })
    ).toMatchObject({ ok: true });
    await service.idle();
    const completion = run().completions[launched.actionId];
    expect(completion.outcome).toBe('failed');
    expect(
      await service.accept({ actionId: launched.actionId, runId: 'run-1' })
    ).toMatchObject({ ok: false });
  });
});
