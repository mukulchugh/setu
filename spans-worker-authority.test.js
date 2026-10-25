import { afterEach, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkoutFingerprint } from './checkout-identity.js';
import { createDependencyReceipt } from './dependency-readiness.js';
import { createSetupProgress } from './setup-progress.js';
import { createSpansActions } from './spans-actions.js';
import { createSpansArtifacts } from './spans-artifacts.js';
import { targetDigestFor } from './spans-dispatch.js';
import { createDependencyAdapter } from './spans-execution-adapters.js';
import { createSpansExecutionAuthority } from './spans-execution-authority.js';
import { createSpansCapability } from './spans-execution-capability.js';
import {
  canonicalJson,
  digestOf,
  sha256,
  spansExecutionInputDigest,
} from './spans-execution-core.js';
import {
  launchModeOf,
  SPANS_EXEC_DEFAULT_PROFILES,
} from './spans-execution-provider.js';
import { SPANS_EXECUTION_REVIEW_PROFILES } from './spans-execution-review.js';
import { openSpansStore } from './spans-store.js';
import { createSpansWorkerAuthority } from './spans-worker-authority.js';
import { createSpansWorkerHost } from './spans-worker-host.js';
import { createWorkspaceState } from './workspace-state.js';

const roots = [];
const rootView = {
  actions: {},
  checkpoint: 0,
  generation: 0,
  goal: 'Build the fixture output.',
  planVersion: 1,
  runId: 'run-worker-authority',
  spans: {
    task: {
      dependencies: [],
      spanId: 'task',
      state: 'ready',
      title: 'Build fixture output',
    },
  },
};
const binding = Object.freeze({
  actionId: 'action-worker-authority',
  attemptId: 'attempt-worker-authority',
  generation: 0,
  runId: rootView.runId,
  spanId: 'task',
  workerId: 'worker-authority',
});
const target = Object.freeze({ name: 'feature', repo: 'demo' });
const profileId = 'claude-code-sonnet';
const profile = SPANS_EXECUTION_REVIEW_PROFILES[profileId];
const digest = (letter) => letter.repeat(64);

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { force: true, recursive: true });
  }
});

function makeRoot() {
  const root = realpathSync(
    mkdtempSync(join(tmpdir(), 'spans-worker-authority-'))
  );
  chmodSync(root, 0o700);
  roots.push(root);
  return root;
}

function executionInput() {
  return {
    context: {
      dependencyEvidence: [],
      goal: 'Build the fixture output.',
      plan: {},
      runId: binding.runId,
      span: {
        dependencies: [],
        spanId: binding.spanId,
        title: 'Build fixture output',
      },
      version: 1,
    },
    request: {
      criteria: [],
      instructions: 'Create the fixture output.',
      profile: profileId,
      requireChange: false,
      runId: binding.runId,
      spanId: binding.spanId,
      target,
      wallClockMs: 30_000,
    },
    version: 1,
  };
}

async function makeApprovedFixture({ realDependencies = false } = {}) {
  const root = makeRoot();
  const checkoutRoot = join(root, 'checkout');
  const repoDir = join(root, 'demo.git');
  mkdirSync(checkoutRoot, { mode: 0o700 });
  mkdirSync(repoDir, { mode: 0o700 });
  const inputText = canonicalJson(executionInput());
  const artifacts = createSpansArtifacts({ root });
  const stored = artifacts.put({
    mediaType: 'application/json',
    text: inputText,
  });
  expect(stored.ok).toBe(true);
  const inputArtifact = {
    digest: stored.artifactId.slice('sha256:'.length),
    id: stored.artifactId,
  };
  const dirtyHash = digest('1');
  const dependencyIdentity = {
    inputDigest: digest('2'),
    receiptDigest: digest('c'),
    version: 2,
  };
  const pathIdentity = { birthtimeNs: '1', dev: '2', ino: '3' };
  const expected = {
    dependency: dependencyIdentity,
    dirty: { count: 0, hash: dirtyHash },
    head: 'a'.repeat(40),
    identity: {
      admin: pathIdentity,
      adminPath: repoDir,
      checkout: checkoutFingerprint(statSync(checkoutRoot, { bigint: true })),
      checkoutPath: checkoutRoot,
      known: true,
      repository: pathIdentity,
      repositoryPath: repoDir,
    },
  };
  let actualDependencies;
  let setupProgress;
  let setupRecord;
  if (realDependencies) {
    writeFileSync(
      join(checkoutRoot, 'package.json'),
      '{"name":"worker-authority-fixture","version":"1.0.0"}'
    );
    const resourcePaths = {
      configPath: join(root, 'config.json'),
      setuDir: root,
      workspaceRoot: root,
    };
    const state = createWorkspaceState(resourcePaths);
    await state.replace('config', { workspace: root });
    let setupAttempt = 0;
    setupProgress = createSetupProgress({
      newAttemptId: () => {
        setupAttempt += 1;
        return `real-dependency-attempt-${setupAttempt}`;
      },
      state,
    });
    const started = await setupProgress.start({
      checkoutIdentity: expected.identity,
      logLocation: join(root, 'setup.log'),
      stage: 'no-dependencies',
      target,
    });
    expect(started.ok).toBe(true);
    const receipt = await createDependencyReceipt({
      attemptId: started.record.attemptId,
      checkoutIdentity: expected.identity,
      wtDir: checkoutRoot,
    });
    expect(receipt.ok).toBe(true);
    expect(
      (
        await setupProgress.finish({
          attemptId: started.record.attemptId,
          checkoutIdentity: expected.identity,
          dependencyReceipt: receipt.receipt,
          outcome: 'completed',
          target,
        })
      ).ok
    ).toBe(true);
    setupRecord = setupProgress.get(target);
    actualDependencies = createDependencyAdapter({
      resourcePaths,
      setupProgress,
      state,
    });
    const observation = await actualDependencies.observe({
      checkoutIdentity: expected.identity,
      target,
      wtDir: checkoutRoot,
    });
    expect(observation.ok).toBe(true);
    expect(observation.checkCurrent()).toBe(true);
    expected.dependency = observation.identity;
  }
  const reviewBinding = {
    actionId: binding.actionId,
    admission: { kind: 'headless-run', policyDigest: digest('3') },
    attemptId: binding.attemptId,
    checkout: { expected, repoDir, wtDir: checkoutRoot },
    digests: {
      dependencies: digestOf(expected.dependency),
      dirty: dirtyHash,
      head: sha256(expected.head),
    },
    executionVersion: 1,
    generation: binding.generation,
    inputArtifact,
    planVersion: 1,
    policy: profile.policy,
    profile: {
      digest: digest('6'),
      effort: profile.effort,
      id: profileId,
      model: profile.model,
      provider: profile.provider,
    },
    requiredCapabilities: ['launch', 'model', 'permissions', 'tools'],
    runId: binding.runId,
    spanId: binding.spanId,
    target,
    targetDigest: targetDigestFor(expected),
  };
  const store = openSpansStore({ root });
  const capabilityEvidence = {
    connected: true,
    cost: { enforcement: 'unavailable' },
    identity: {
      client: SPANS_EXEC_DEFAULT_PROFILES[profileId].client,
      effort: profile.effort,
      model: profile.model,
      provider: profile.provider,
    },
    installed: true,
    observedAt: Date.now(),
    permissions: {
      mode: SPANS_EXEC_DEFAULT_PROFILES[profileId].permissionMode,
      status: 'verified',
    },
    provenance: {
      digest: `sha256:${digest('8')}`,
      probeId: 'probe-worker-authority',
      source: 'fresh-session-probe',
    },
    session: { id: 'session-worker-authority', origin: 'fresh' },
    tools: Object.fromEntries(
      SPANS_EXEC_DEFAULT_PROFILES[profileId].tools.map((tool) => [
        tool,
        'available',
      ])
    ),
  };
  expect(
    store.writeCache(`execution.probe.${profileId}`, {
      evidence: capabilityEvidence,
      observations: {},
      profileId,
    }).ok
  ).toBe(true);
  const capability = createSpansCapability({
    now: Date.now,
    profiles: SPANS_EXEC_DEFAULT_PROFILES,
    store,
  }).verify({ profile: profileId });
  expect(capability.ok).toBe(true);
  reviewBinding.profile.digest = capability.profile.digest;
  expect(
    store.commitRun({
      events: [],
      expectedGeneration: 0,
      expectedRevision: 0,
      runId: rootView.runId,
      view: rootView,
    }).ok
  ).toBe(true);
  const actions = createSpansActions({ now: () => 100, store });
  expect(
    await actions.prepareAction({
      actionId: binding.actionId,
      attemptId: binding.attemptId,
      generation: binding.generation,
      inputDigest: digest('7'),
      planVersion: 1,
      runId: binding.runId,
      spanId: binding.spanId,
      targetDigest: reviewBinding.targetDigest,
    })
  ).toMatchObject({ ok: true, status: 'intent' });

  const reviewAuthority = createSpansExecutionAuthority({
    now: () => new Date('2026-10-20T00:00:00.000Z'),
    resolveBinding: async () => reviewBinding,
    store,
    verifyWritable: async () => true,
    writeArchive: async (effect) => await effect(),
  });
  const prepared = await reviewAuthority.prepare({
    actionId: binding.actionId,
    attemptId: binding.attemptId,
    generation: binding.generation,
    planVersion: 1,
    runId: binding.runId,
    spanId: binding.spanId,
  });
  expect(prepared.ok).toBe(true);
  const [reviewDigest] = Object.keys(
    store.readRun({ runId: binding.runId }).view.execution.reviews
  );
  const checkedReview = await reviewAuthority.read({
    reviewDigest,
    runId: binding.runId,
  });
  expect(checkedReview).toMatchObject({ ok: true });
  const challenge = await reviewAuthority.issue({
    reviewDigest,
    runId: binding.runId,
  });
  expect(challenge).toMatchObject({ ok: true });
  const approved = await reviewAuthority.approve({
    confirmation: {
      challengeId: challenge.challengeId,
      response: challenge.phrase,
    },
    reviewDigest,
    runId: binding.runId,
  });
  expect(approved.ok).toBe(true);

  const selector = {
    actionId: binding.actionId,
    attemptId: binding.attemptId,
    generation: binding.generation,
    planVersion: 1,
    runId: binding.runId,
    spanId: binding.spanId,
  };
  const savedExecution = {
    actionId: binding.actionId,
    approval: approved.approval,
    approvalDigest: digestOf(approved.approval),
    attemptId: binding.attemptId,
    baseline: { digest: digest('9'), files: 0 },
    baselineTree: digest('9'),
    billing: SPANS_EXEC_DEFAULT_PROFILES[profileId].billing,
    budgetMicro: null,
    checkoutIdentity: reviewBinding.checkout.expected.identity,
    criteria: [],
    inputArtifact,
    inputDigest: '',
    instructions: 'Create the fixture output.',
    launchMode: launchModeOf(SPANS_EXEC_DEFAULT_PROFILES[profileId]),
    profile: profileId,
    requireChange: false,
    reviewRef: {
      reviewDigest,
      runId: binding.runId,
    },
    reviewSelector: selector,
    runId: binding.runId,
    spanId: binding.spanId,
    target,
    wallClockMs: 30_000,
  };
  savedExecution.inputDigest = spansExecutionInputDigest(savedExecution);
  const current = store.readRun({ runId: binding.runId });
  const view = structuredClone(current.view);
  view.executions = { [binding.actionId]: savedExecution };
  expect(
    store.commitRun({
      events: [],
      expectedGeneration: current.generation,
      expectedRevision: current.revision,
      runId: binding.runId,
      view,
    }).ok
  ).toBe(true);

  const executionReview = {
    approvalDigest: savedExecution.approvalDigest,
    reviewDigest,
    runId: binding.runId,
  };
  const admissionContext = {
    lease: {
      spansArchiveReservation: { root },
      spansBinding: { ...binding, target },
    },
  };
  const source = {
    args: ['fixture-private-args'],
    command: '/private/fake-provider',
    cwd: checkoutRoot,
    env: {},
    stdin: inputText,
  };

  const dependencyProof = { calls: 0, result: true };
  const dependencyObserveCalls = [];
  return {
    actualDependencies,
    admissionContext,
    approval: approved.approval,
    checkoutRoot,
    dependencyCheckCurrent: () => {
      dependencyProof.calls += 1;
      return typeof dependencyProof.callback === 'function'
        ? dependencyProof.callback()
        : dependencyProof.result;
    },
    dependencyObserveCalls,
    dependencyProof,
    executionReview,
    inputText,
    observations: {
      checkout: {
        dirty: expected.dirty,
        head: expected.head,
        identity: expected.identity,
      },
      dependency: expected.dependency,
      tree: { digest: savedExecution.baselineTree, head: expected.head },
    },
    reviewAuthority,
    reviewBinding,
    root,
    setupProgress,
    setupRecord,
    source,
    store,
    target,
  };
}

function makeHost(
  fixture,
  launcher,
  preflight = async () => ({ ok: true }),
  patch = {},
  start = startRequest()
) {
  return createSpansWorkerHost({
    clock: { now: () => 200 },
    executionAdmissionContext: fixture.admissionContext,
    executionCheckoutAdapter: {
      observe() {
        return { ...fixture.observations.checkout, ok: true };
      },
    },
    executionDependencyAdapter: fixtureDependencyAdapter(fixture),
    executionLimits: {
      maxActiveAttempts: 2,
      maxAttemptBytes: 4096,
      maxAttemptChunks: 20,
      maxChunkBytes: 1024,
      maxDeadlineMs: 60_000,
      maxQueueBytes: 2048,
    },
    executionObserveTree: async () => ({
      ...fixture.observations.tree,
      ok: true,
    }),
    executionReview: fixture.executionReview,
    executionReviewRequired: true,
    executionSource: fixture.source,
    executionStart: start,
    launcher,
    limits: {
      maxActiveAttempts: 2,
      maxAttemptBytes: 4096,
      maxAttemptChunks: 20,
      maxChunkBytes: 1024,
      maxDeadlineMs: 60_000,
      maxQueueBytes: 2048,
    },
    preflight,
    root: fixture.root,
    workerId: binding.workerId,
    ...patch,
  });
}

function fixtureDependencyAdapter(fixture) {
  if (fixture.actualDependencies) {
    return fixture.actualDependencies;
  }
  return {
    observe(input) {
      fixture.dependencyObserveCalls.push(structuredClone(input));
      return {
        checkCurrent: fixture.dependencyCheckCurrent,
        identity: structuredClone(fixture.observations.dependency),
        ok: true,
      };
    },
  };
}

function makeAuthority(fixture) {
  return createSpansWorkerAuthority({
    admissionContext: fixture.admissionContext,
    checkoutAdapter: {
      observe: async () => ({ ...fixture.observations.checkout, ok: true }),
    },
    dependencyAdapter: fixtureDependencyAdapter(fixture),
    executionLimits: { maxDeadlineMs: 60_000 },
    executionReview: fixture.executionReview,
    executionStart: startRequest(),
    observeTree: async () => ({ ...fixture.observations.tree, ok: true }),
    root: fixture.root,
    source: fixture.source,
    store: fixture.store,
  });
}

function fakeLauncher(calls) {
  return {
    launch() {
      calls.launches += 1;
      return {
        handle: { id: 'fake-provider' },
        ok: true,
        processStart: { id: 'fake-provider-process', pid: 4242 },
      };
    },
    stop() {
      calls.stops += 1;
      return { ok: true };
    },
  };
}

function replaceCapabilityEvidence(fixture, changes) {
  const key = `execution.probe.${profileId}`;
  const current = fixture.store.readCache(key);
  expect(current.ok).toBe(true);
  expect(
    fixture.store.writeCache(key, {
      ...current.entry,
      evidence: { ...current.entry.evidence, ...changes },
    }).ok
  ).toBe(true);
}

function startRequest(deadlineMs = 30_000) {
  return {
    actionId: binding.actionId,
    attemptId: binding.attemptId,
    deadlineMs,
    generation: binding.generation,
    runId: binding.runId,
    spanId: binding.spanId,
    workerId: binding.workerId,
  };
}

async function revoke(fixture) {
  const challenge = await fixture.reviewAuthority.issue({
    intent: 'revoke',
    reviewDigest: fixture.executionReview.reviewDigest,
    runId: binding.runId,
  });
  expect(challenge.ok).toBe(true);
  return await fixture.reviewAuthority.revoke({
    confirmation: {
      challengeId: challenge.challengeId,
      response: challenge.phrase,
    },
    reviewDigest: fixture.executionReview.reviewDigest,
    runId: binding.runId,
  });
}

async function finish(fixture, host, started) {
  if (started?.ok) {
    await host.observeExit({
      ...started.ref,
      exit: { code: 0, signal: null },
    });
  }
  expect(host.close()).toEqual({ ok: true });
  await fixture.reviewAuthority.close();
  fixture.store.close();
}

test('a current typed approval and its exact retained input launch one fake provider', async () => {
  const fixture = await makeApprovedFixture();
  const calls = { launches: 0, stops: 0 };
  const host = makeHost(fixture, fakeLauncher(calls));
  const started = await host.start(startRequest());
  expect(started).toMatchObject({ ok: true, status: 'running' });
  expect(calls.launches).toBe(1);
  expect(fixture.dependencyProof.calls).toBe(2);
  expect(fixture.dependencyObserveCalls).toEqual([
    {
      checkoutIdentity: fixture.observations.checkout.identity,
      target,
      wtDir: fixture.checkoutRoot,
    },
  ]);
  await finish(fixture, host, started);
});

test('missing or legacy dependency final proof refuses before the launcher', async () => {
  const cases = [
    {
      label: 'missing final validator',
      observe(fixture) {
        return {
          identity: structuredClone(fixture.observations.dependency),
          ok: true,
        };
      },
    },
    {
      label: 'legacy dependency identity',
      observe() {
        return {
          checkCurrent: () => true,
          identity: {
            bunVersion: '1.3.14',
            linkerMode: 'node-modules',
            lockfileHash: digest('a'),
            platformNamespace: 'darwin-arm64',
          },
          ok: true,
        };
      },
    },
  ];
  for (const item of cases) {
    // Each malformed proof gets an isolated archive and approval.
    // biome-ignore lint/performance/noAwaitInLoops: Keep every refusal fixture isolated and close it before creating the next.
    const fixture = await makeApprovedFixture();
    const calls = { launches: 0, stops: 0 };
    const host = makeHost(fixture, fakeLauncher(calls), undefined, {
      executionDependencyAdapter: {
        observe(input) {
          fixture.dependencyObserveCalls.push(structuredClone(input));
          return item.observe(fixture);
        },
      },
    });
    const result = await host.start(startRequest());
    expect(result.ok).toBe(false);
    expect(calls.launches).toBe(0);
    expect(fixture.dependencyProof.calls).toBe(0, item.label);
    expect(host.close()).toEqual({ ok: true });
    await fixture.reviewAuthority.close();
    fixture.store.close();
  }
});

test('a current dependency proof cannot be borrowed by another attempt or generation', async () => {
  const cases = [
    { label: 'wrong generation', patch: { generation: 1 } },
    { label: 'wrong attempt', patch: { attemptId: 'other-attempt' } },
  ];
  for (const item of cases) {
    // Each proof is consumed against an isolated review binding.
    // biome-ignore lint/performance/noAwaitInLoops: Keep each guard and store isolated.
    const fixture = await makeApprovedFixture();
    const authority = makeAuthority(fixture);
    expect((await authority.checkPreflight(binding)).ok).toBe(true);
    expect(authority.checkLaunch({ ...binding, ...item.patch }).ok).toBe(false);
    expect(authority.checkLaunch(binding).ok).toBe(false);
    expect(fixture.dependencyProof.calls).toBe(1, item.label);
    await fixture.reviewAuthority.close();
    fixture.store.close();
  }
});

test('a receipt change after successful preflight refuses at the synchronous launcher fence', async () => {
  const fixture = await makeApprovedFixture();
  let validatorCalls = 0;
  fixture.dependencyProof.callback = () => {
    validatorCalls += 1;
    return validatorCalls === 1;
  };
  const calls = { launches: 0, stops: 0 };
  const host = makeHost(fixture, fakeLauncher(calls));
  const result = await host.start(startRequest());
  expect(result.ok).toBe(false);
  expect(fixture.dependencyProof.calls).toBe(2);
  expect(calls.launches).toBe(0);
  expect(host.close()).toEqual({ ok: true });
  await fixture.reviewAuthority.close();
  fixture.store.close();
});

test('current approval is reread after the final dependency validator', async () => {
  const fixture = await makeApprovedFixture();
  const authority = makeAuthority(fixture);
  expect((await authority.checkPreflight(binding)).ok).toBe(true);
  fixture.dependencyProof.callback = () => {
    if (fixture.dependencyProof.calls === 1) {
      return true;
    }
    const current = fixture.store.readRun({ runId: binding.runId });
    const view = structuredClone(current.view);
    const { reviewDigest } = fixture.executionReview;
    const type = 'spans.execution-review.revoked';
    const revocation = {
      at: '2026-10-20T10:00:00.000Z',
      reference: 'revoked-after-final-dependency-proof',
      source: 'fixture',
      version: 1,
    };
    view.execution.receipts[reviewDigest] = {
      ...view.execution.receipts[reviewDigest],
      revocations: [revocation],
    };
    const eventId = createHash('sha256')
      .update(
        JSON.stringify([
          'spans.execution-review',
          type,
          binding.runId,
          reviewDigest,
          revocation.reference,
        ])
      )
      .digest('hex');
    const committed = fixture.store.commitRun({
      events: [
        {
          eventId,
          payload: {
            executionVersion: 1,
            reference: revocation.reference,
            reviewDigest,
            revokedAt: revocation.at,
            source: revocation.source,
          },
          runId: binding.runId,
          type,
        },
      ],
      expectedGeneration: current.generation,
      expectedRevision: current.revision,
      runId: binding.runId,
      view,
    });
    expect(committed.ok).toBe(true);
    return true;
  };
  expect(authority.checkLaunch(binding).ok).toBe(false);
  expect(fixture.dependencyProof.calls).toBe(2);
  await fixture.reviewAuthority.close();
  fixture.store.close();
});

test('the synchronous dependency validator refuses Promise and thrown results', async () => {
  const cases = [
    {
      callback: () => Promise.resolve(true),
      label: 'Promise result',
    },
    {
      callback: () => {
        throw new Error('fixture validator failure');
      },
      label: 'thrown result',
    },
  ];
  for (const item of cases) {
    // Each callback result gets a clean archive and approval.
    // biome-ignore lint/performance/noAwaitInLoops: Keep each callback fixture isolated.
    const fixture = await makeApprovedFixture();
    fixture.dependencyProof.callback = item.callback;
    const calls = { launches: 0, stops: 0 };
    const host = makeHost(fixture, fakeLauncher(calls));
    const result = await host.start(startRequest());
    expect(result.ok).toBe(false, item.label);
    expect(fixture.dependencyProof.calls).toBe(1, item.label);
    expect(calls.launches).toBe(0, item.label);
    expect(host.close()).toEqual({ ok: true });
    await fixture.reviewAuthority.close();
    fixture.store.close();
  }
});

test('a changed retained goal with unchanged plan counters refuses at the child launch boundary', async () => {
  const fixture = await makeApprovedFixture();
  const calls = { launches: 0, stops: 0 };
  const host = makeHost(fixture, fakeLauncher(calls), () => {
    const current = fixture.store.readRun({ runId: binding.runId });
    const view = {
      ...current.view,
      goal: 'A different objective after approval.',
    };
    expect(
      fixture.store.commitRun({
        events: [],
        expectedGeneration: current.generation,
        expectedRevision: current.revision,
        runId: binding.runId,
        view,
      }).ok
    ).toBe(true);
    return { ok: true };
  });
  const started = await host.start(startRequest());
  try {
    expect(started.ok).toBe(false);
    expect(calls.launches).toBe(0);
  } finally {
    await finish(fixture, host, started);
  }
});

test('missing approval reference, another approval digest, changed generation, and changed source input refuse before launch', async () => {
  const cases = [
    {
      label: 'missing reference',
      patch: { executionReview: undefined },
    },
    {
      change: (fixture) => {
        fixture.executionReview = {
          ...fixture.executionReview,
          approvalDigest: digest('e'),
        };
      },
      label: 'different approval digest',
    },
    {
      change: (fixture) => {
        fixture.source = { ...fixture.source, stdin: `${fixture.inputText} ` };
      },
      label: 'changed source artifact',
    },
    {
      change: (fixture) => {
        const current = fixture.store.readRun({ runId: binding.runId });
        const view = structuredClone(current.view);
        view.executions[binding.actionId].instructions +=
          ' Altered after approval.';
        expect(
          fixture.store.commitRun({
            events: [],
            expectedGeneration: current.generation,
            expectedRevision: current.revision,
            runId: binding.runId,
            view,
          }).ok
        ).toBe(true);
      },
      label: 'changed saved execution under its old input digest',
    },
    {
      change: (fixture) => {
        const current = fixture.store.readRun({ runId: binding.runId });
        const view = structuredClone(current.view);
        view.generation = 1;
        expect(
          fixture.store.commitRun({
            events: [],
            expectedGeneration: current.generation,
            expectedRevision: current.revision,
            runId: binding.runId,
            view,
          }).ok
        ).toBe(true);
      },
      label: 'changed generation',
    },
  ];

  for (const item of cases) {
    // Each refusal case uses a separate archive and review receipt.
    // biome-ignore lint/performance/noAwaitInLoops: Clean each independent store before creating the next fixture.
    const fixture = await makeApprovedFixture();
    item.change?.(fixture);
    const calls = { launches: 0, stops: 0 };
    let host;
    if (item.label === 'missing reference') {
      expect(() =>
        makeHost(fixture, fakeLauncher(calls), undefined, item.patch)
      ).toThrow('production capture requires its exact saved execution review');
    } else {
      host = makeHost(fixture, fakeLauncher(calls));
      const result = await host.start(startRequest());
      expect(result.ok).toBe(false);
      expect(calls.launches).toBe(0);
      expect(host.close()).toEqual({ ok: true });
    }
    await fixture.reviewAuthority.close();
    fixture.store.close();
  }
});

test('the approved wall clock must match the actual start and every saved ceiling', async () => {
  const fixture = await makeApprovedFixture();
  const calls = { launches: 0, stops: 0 };
  const start = startRequest(31_000);
  const host = makeHost(fixture, fakeLauncher(calls), undefined, {}, start);
  const result = await host.start(start);
  expect(result.ok).toBe(false);
  expect(calls.launches).toBe(0);
  expect(host.close()).toEqual({ ok: true });
  await fixture.reviewAuthority.close();
  fixture.store.close();
});

test('a changed target, same-path checkout replacement, or changed HEAD during preflight refuses before launch', async () => {
  const targetFixture = await makeApprovedFixture();
  targetFixture.admissionContext.lease.spansBinding.target = {
    name: 'different-feature',
    repo: 'demo',
  };
  const targetCalls = { launches: 0, stops: 0 };
  const targetHost = makeHost(targetFixture, fakeLauncher(targetCalls));
  expect((await targetHost.start(startRequest())).ok).toBe(false);
  expect(targetCalls.launches).toBe(0);
  expect(targetHost.close()).toEqual({ ok: true });
  await targetFixture.reviewAuthority.close();
  targetFixture.store.close();

  const replacementFixture = await makeApprovedFixture();
  const oldPath = `${replacementFixture.checkoutRoot}-old`;
  renameSync(replacementFixture.checkoutRoot, oldPath);
  mkdirSync(replacementFixture.checkoutRoot, { mode: 0o700 });
  const replacementCalls = { launches: 0, stops: 0 };
  const replacementHost = makeHost(
    replacementFixture,
    fakeLauncher(replacementCalls)
  );
  expect((await replacementHost.start(startRequest())).ok).toBe(false);
  expect(replacementCalls.launches).toBe(0);
  expect(replacementHost.close()).toEqual({ ok: true });
  await replacementFixture.reviewAuthority.close();
  replacementFixture.store.close();

  const headFixture = await makeApprovedFixture();
  const headCalls = { launches: 0, stops: 0 };
  const headHost = makeHost(headFixture, fakeLauncher(headCalls), () => {
    headFixture.observations.checkout.head = 'b'.repeat(40);
    return { ok: true };
  });
  expect((await headHost.start(startRequest())).ok).toBe(false);
  expect(headCalls.launches).toBe(0);
  expect(headHost.close()).toEqual({ ok: true });
  await headFixture.reviewAuthority.close();
  headFixture.store.close();

  const inputFixture = await makeApprovedFixture();
  const inputCalls = { launches: 0, stops: 0 };
  const inputHost = makeHost(inputFixture, fakeLauncher(inputCalls), () => {
    inputFixture.source.stdin = `${inputFixture.inputText} changed during preflight`;
    return { ok: true };
  });
  expect((await inputHost.start(startRequest())).ok).toBe(false);
  expect(inputCalls.launches).toBe(0);
  expect(inputHost.close()).toEqual({ ok: true });
  await inputFixture.reviewAuthority.close();
  inputFixture.store.close();
});

test('a changed current profile or expired capability proof refuses before launch', async () => {
  const profileFixture = await makeApprovedFixture();
  replaceCapabilityEvidence(profileFixture, {
    identity: {
      ...profileFixture.store.readCache(`execution.probe.${profileId}`).entry
        .evidence.identity,
      model: 'unreviewed-model',
    },
  });
  const profileCalls = { launches: 0, stops: 0 };
  const profileHost = makeHost(profileFixture, fakeLauncher(profileCalls));
  expect((await profileHost.start(startRequest())).ok).toBe(false);
  expect(profileCalls.launches).toBe(0);
  expect(profileHost.close()).toEqual({ ok: true });
  await profileFixture.reviewAuthority.close();
  profileFixture.store.close();

  const expiredFixture = await makeApprovedFixture();
  replaceCapabilityEvidence(expiredFixture, {
    observedAt: Date.now() - 7 * 60 * 60 * 1000,
  });
  const expiredCalls = { launches: 0, stops: 0 };
  const expiredHost = makeHost(expiredFixture, fakeLauncher(expiredCalls));
  expect((await expiredHost.start(startRequest())).ok).toBe(false);
  expect(expiredCalls.launches).toBe(0);
  expect(expiredHost.close()).toEqual({ ok: true });
  await expiredFixture.reviewAuthority.close();
  expiredFixture.store.close();
});

test('revocation during asynchronous preflight is caught at the actual launch fence', async () => {
  const fixture = await makeApprovedFixture();
  const calls = { launches: 0, stops: 0 };
  let resumePreflight;
  let signalPreflight;
  const preflightEntered = new Promise((resolve) => {
    signalPreflight = resolve;
  });
  const preflight = async () => {
    signalPreflight();
    await new Promise((resolve) => {
      resumePreflight = resolve;
    });
    return { ok: true };
  };
  const host = makeHost(fixture, fakeLauncher(calls), preflight);
  const pending = host.start(startRequest());
  await preflightEntered;
  expect((await revoke(fixture)).ok).toBe(true);
  resumePreflight();
  const result = await pending;
  expect(result.ok).toBe(false);
  expect(calls.launches).toBe(0);
  expect(host.close()).toEqual({ ok: true });
  await fixture.reviewAuthority.close();
  fixture.store.close();
});

test('revocation does not block capture or owned stop for an already running provider', async () => {
  const fixture = await makeApprovedFixture();
  const calls = { launches: 0, stops: 0 };
  const host = makeHost(fixture, fakeLauncher(calls));
  const started = await host.start(startRequest());
  expect(started).toMatchObject({ ok: true, status: 'running' });
  expect((await revoke(fixture)).ok).toBe(true);
  expect(
    await host.captureChunk({ ...started.ref, seq: 0, text: 'after revoke\n' })
  ).toMatchObject({ ok: true });
  const stopped = await host.cancel({
    ...started.ref,
    coordinatorGeneration: binding.generation,
  });
  expect(stopped.ok).toBe(true);
  expect(calls).toEqual({ launches: 1, stops: 1 });
  await finish(fixture, host, started);
});

test.each(['manifest', 'setup-attempt'])(
  'actual %s mutation after async preflight prevents the launcher effect',
  async (kind) => {
    const fixture = await makeApprovedFixture({ realDependencies: true });
    const calls = { launches: 0, stops: 0 };
    const host = makeHost(fixture, fakeLauncher(calls), async () => {
      if (kind === 'manifest') {
        writeFileSync(
          join(fixture.checkoutRoot, 'package.json'),
          '{"name":"worker-authority-fixture","version":"2.0.0"}'
        );
      } else {
        const record = fixture.setupRecord;
        expect(
          (
            await fixture.setupProgress.retry({
              attemptId: record.attemptId,
              checkoutIdentity: record.checkoutIdentity,
              logLocation: record.logLocation,
              refreshDependencies: true,
              stage: 'preparing',
              target,
            })
          ).ok
        ).toBe(true);
      }
      return { ok: true };
    });
    try {
      expect((await host.start(startRequest())).ok).toBe(false);
      expect(calls.launches).toBe(0);
    } finally {
      expect(host.close()).toEqual({ ok: true });
      await fixture.reviewAuthority.close();
      fixture.store.close();
    }
  }
);
