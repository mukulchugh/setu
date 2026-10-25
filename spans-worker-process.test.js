import { afterEach, expect, test } from 'bun:test';
import { spawn as spawnProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDependencyReceipt } from './dependency-readiness.js';
import { observeProcessIdentity } from './process-observation.js';
import { createResourceAdmission } from './resource-admission.js';
import { createSetupProgress } from './setup-progress.js';
import { createSpansActions } from './spans-actions.js';
import { createSpansArtifacts } from './spans-artifacts.js';
import { targetDigestFor } from './spans-dispatch.js';
import { stopOwnedFixtureCapture } from './spans-execution.test-support.js';
import {
  createCheckoutAdapter,
  createDependencyAdapter,
} from './spans-execution-adapters.js';
import { spansExecutionArchiveReservation } from './spans-execution-archive-policy.js';
import { createSpansExecutionAuthority } from './spans-execution-authority.js';
import { readSpansExecutionRequest } from './spans-execution-binding.js';
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
import { observeTree } from './spans-execution-verifier.js';
import { openSpansStore } from './spans-store.js';
import { createSpansWorkerProcess } from './spans-worker-process.js';
import { createSpansWorkerSpool } from './spans-worker-spool.js';
import { createWorkspaceState } from './workspace-state.js';

const OWN_TEST_DIR = dirname(fileURLToPath(import.meta.url));
const MAX_DESCRIPTOR_BYTES = 128 * 1024;
const FIXTURE_START_ID = 'Mon Jan 1 00:00:00 2024';
const DIGEST_PATTERN = /^[a-f0-9]{64}$/;
const roots = [];
const children = new Map();
const providers = new Set();
const tempRoots = new Set();
const providerMarkers = new Set();
const binding = Object.freeze({
  actionId: 'action-fixture',
  attemptId: 'attempt-fixture',
  generation: 0,
  runId: 'run-fixture',
  spanId: 'span-fixture',
  workerId: 'worker-fixture',
});
const executionReview = Object.freeze({
  approvalDigest: 'd'.repeat(64),
  reviewDigest: 'c'.repeat(64),
  runId: binding.runId,
});
const limits = Object.freeze({
  maxActiveAttempts: 2,
  maxAttemptBytes: 4096,
  maxAttemptChunks: 20,
  maxChunkBytes: 1024,
  maxDeadlineMs: 30_000,
  maxQueueBytes: 2048,
});
const initialView = {
  actions: {},
  checkpoint: 0,
  generation: 0,
  goal: 'Capture the local fixture result.',
  planVersion: 1,
  runId: binding.runId,
  spans: {
    [binding.spanId]: {
      dependencies: [],
      spanId: binding.spanId,
      state: 'ready',
      title: 'Capture fixture result',
    },
  },
};

async function makeFixture({ deferAction = false } = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'setu-spans-process-')));
  chmodSync(root, 0o700);
  roots.push(root);
  const store = openSpansStore({ root });
  expect(
    store.commitRun({
      events: [],
      expectedGeneration: 0,
      expectedRevision: 0,
      runId: binding.runId,
      view: initialView,
    })
  ).toMatchObject({ ok: true });
  if (!deferAction) {
    const actions = createSpansActions({ now: () => Date.now(), store });
    const prepared = await actions.prepareAction({
      actionId: binding.actionId,
      attemptId: binding.attemptId,
      generation: binding.generation,
      inputDigest: 'a'.repeat(64),
      planVersion: 1,
      runId: binding.runId,
      spanId: binding.spanId,
      targetDigest: 'b'.repeat(64),
    });
    expect(prepared).toMatchObject({ ok: true, status: 'intent' });
  }
  store.close();
  const captureRoot = realpathSync(
    mkdtempSync(join(tmpdir(), 'setu-spans-capture-'))
  );
  chmodSync(captureRoot, 0o700);
  tempRoots.add(captureRoot);
  const gitHeadPath = join(captureRoot, 'git-head');
  const gitStatusPath = join(captureRoot, 'git-status');
  writeFileSync(gitHeadPath, `${'a'.repeat(40)}\n`, { mode: 0o600 });
  writeFileSync(gitStatusPath, '', { mode: 0o600 });
  const gitPath = join(captureRoot, 'git');
  writeFileSync(
    gitPath,
    `#!/usr/bin/env node
import { readFileSync } from 'node:fs';
const args = process.argv.slice(2);
const commandIndex = args.indexOf('-C');
const command = args.slice(commandIndex + 2);
if (command.includes('rev-parse')) {
  process.stdout.write(readFileSync(process.env.SETU_FAKE_GIT_HEAD_PATH, 'utf8').trim() + '\\n');
} else if (command.includes('status')) {
  process.stdout.write(readFileSync(process.env.SETU_FAKE_GIT_STATUS_PATH, 'utf8'));
} else if (command.includes('ls-files')) {
  process.stdout.write('bun.lock\\0');
} else {
  process.exit(1);
}
`,
    { mode: 0o700 }
  );
  chmodSync(gitPath, 0o700);
  const psPath = join(captureRoot, 'ps');
  writeFileSync(
    psPath,
    `#!/usr/bin/env node
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
const args = process.argv.slice(2);
const statePath = process.env.SETU_FAKE_PS_STATE;
const start = 'Mon Jan 1 00:00:00 2024';
if (args[0] === '-p') {
  writeFileSync(statePath, args[1]);
  const marker = readFileSync(statePath + '.marker', 'utf8');
  if (existsSync(marker + '.exited')) process.exit(1);
  process.stdout.write(start + '\\n');
} else if (args[0] === '-axo') {
  let pid = 0;
  const marker = readFileSync(statePath + '.marker', 'utf8');
  try {
    pid = Number(readFileSync(statePath, 'utf8'));
    process.kill(pid, 0);
  } catch (error) {
    if (error.code !== 'ESRCH') process.exit(1);
  }
  if (pid > 0 && !existsSync(marker + '.exited')) {
    process.stdout.write(pid + ' 1 ' + pid + ' ' + start + '\\n');
  }
} else {
  process.exit(1);
}
`,
    { mode: 0o700 }
  );
  chmodSync(psPath, 0o700);
  const psStatePath = join(captureRoot, 'ps-state');
  const releasePath = join(captureRoot, 'release');
  writeFileSync(`${psStatePath}.marker`, releasePath, { mode: 0o600 });
  providerMarkers.add(releasePath);
  const makeAdapter = (observer, spawn, resolveArchiveAdmission, review) =>
    createSpansWorkerProcess({
      authorize: async ({ binding: candidate }) => ({
        currentAttempt: JSON.stringify(candidate) === JSON.stringify(binding),
        ok: JSON.stringify(candidate) === JSON.stringify(binding),
      }),
      childPath: join(OWN_TEST_DIR, 'spans-worker-child.js'),
      ...(review ? { executionReview: review } : {}),
      observeProcess:
        observer ??
        (async (pid) => ({
          processId: pid,
          processStartIdentity: `fixture-capture-${pid}`,
          state: 'alive',
        })),
      root,
      spawn: (command, args, options) => {
        const spawnOptions = {
          ...options,
          env: {
            ...options.env,
            PATH: `${captureRoot}:${options.env.PATH ?? ''}`,
            SETU_FAKE_GIT_HEAD_PATH: gitHeadPath,
            SETU_FAKE_GIT_STATUS_PATH: gitStatusPath,
            SETU_FAKE_PS_STATE: psStatePath,
          },
        };
        return spawn
          ? spawn(command, args, spawnOptions)
          : spawnProcess(command, args, spawnOptions);
      },
      tempRoot: captureRoot,
      transportTimeoutMs: 3000,
      ...(resolveArchiveAdmission ? { resolveArchiveAdmission } : {}),
    });
  return {
    captureRoot,
    gitHeadPath,
    gitStatusPath,
    makeAdapter,
    prepareAction: async (targetDigest) => {
      const actionStore = openSpansStore({ create: false, root });
      try {
        const actions = createSpansActions({
          now: () => Date.now(),
          store: actionStore,
        });
        return await actions.prepareAction({
          actionId: binding.actionId,
          attemptId: binding.attemptId,
          generation: binding.generation,
          inputDigest: 'a'.repeat(64),
          planVersion: 1,
          runId: binding.runId,
          spanId: binding.spanId,
          targetDigest,
        });
      } finally {
        actionStore.close();
      }
    },
    releasePath,
    root,
  };
}

async function rememberCapture(pid) {
  const observed = await observeProcessIdentity(pid);
  if (observed.state === 'alive' && observed.processId === pid) {
    children.set(pid, observed.processStartIdentity);
  } else if (observed.state !== 'absent') {
    throw new Error('Capture fixture ownership could not be recorded.');
  }
}

const observeFixtureProcessIdentity = (pid) =>
  observeProcessIdentity(pid, { run: async () => FIXTURE_START_ID });

async function makeRealAdmission(fixture, activeLimits = limits) {
  const canonicalRoot = realpathSync(fixture.captureRoot);
  const state = createWorkspaceState({
    configPath: join(canonicalRoot, 'config.json'),
    setuDir: canonicalRoot,
    workspaceRoot: canonicalRoot,
  });
  const admission = createResourceAdmission({
    hostHealth: async () => ({
      availableBytes: 50 * 1024 ** 3,
      state: 'ready',
    }),
    observeProcess: async (pid) => ({
      processId: pid,
      processStartIdentity: `fixture-process-${pid}`,
      state: 'alive',
    }),
    state,
  });
  const result = await admission.admit({
    kind: 'session',
    operationId: 'spans-archive-test',
    spansArchiveReservation: spansExecutionArchiveReservation({
      limits: activeLimits,
      root: fixture.root,
    }),
    spansBinding: {
      actionId: binding.actionId,
      attemptId: binding.attemptId,
      generation: binding.generation,
      runId: binding.runId,
      spanId: binding.spanId,
      target: { name: 'fixture', repo: 'spans' },
    },
    target: { name: 'fixture', repo: 'spans' },
  });
  expect(result).toMatchObject({ ok: true });
  return {
    admission,
    context: {
      configPath: join(canonicalRoot, 'config.json'),
      lease: result.lease,
      setuDir: canonicalRoot,
      workspaceRoot: canonicalRoot,
    },
  };
}

async function makeApprovedCaptureReview(fixture, source) {
  const target = { name: 'fixture', repo: 'spans' };
  const profileId = 'claude-code-sonnet';
  const profile = SPANS_EXECUTION_REVIEW_PROFILES[profileId];
  const definition = SPANS_EXEC_DEFAULT_PROFILES[profileId];
  const checkoutRoot = join(fixture.root, 'checkout');
  const repoDir = join(fixture.root, 'demo.git');
  const adminPath = join(repoDir, 'worktrees', 'feature');
  mkdirSync(checkoutRoot, { mode: 0o700 });
  mkdirSync(adminPath, { mode: 0o700, recursive: true });
  writeFileSync(join(checkoutRoot, '.git'), `gitdir: ${adminPath}\n`);
  writeFileSync(join(checkoutRoot, 'bun.lock'), '{"lockfileVersion":1}\n');
  writeFileSync(
    join(checkoutRoot, 'package.json'),
    JSON.stringify({ name: 'capture-fixture', version: '1.0.0' })
  );
  writeFileSync(join(adminPath, 'gitdir'), `${join(checkoutRoot, '.git')}\n`);
  writeFileSync(join(adminPath, 'commondir'), '../..\n');
  const head = 'a'.repeat(40);
  writeFileSync(fixture.gitHeadPath, `${head}\n`);
  writeFileSync(fixture.gitStatusPath, '');

  const oldPath = process.env.PATH;
  const oldHeadPath = process.env.SETU_FAKE_GIT_HEAD_PATH;
  const oldStatusPath = process.env.SETU_FAKE_GIT_STATUS_PATH;
  let observedCheckout;
  let dependency;
  let tree;
  try {
    process.env.PATH = `${fixture.captureRoot}:${oldPath ?? ''}`;
    process.env.SETU_FAKE_GIT_HEAD_PATH = fixture.gitHeadPath;
    process.env.SETU_FAKE_GIT_STATUS_PATH = fixture.gitStatusPath;
    observedCheckout = await createCheckoutAdapter().observe({
      repoDir,
      wtDir: checkoutRoot,
    });
    const resourcePaths = {
      configPath: join(fixture.captureRoot, 'config.json'),
      setuDir: fixture.captureRoot,
      workspaceRoot: fixture.captureRoot,
    };
    const state = createWorkspaceState(resourcePaths);
    const setupProgress = createSetupProgress({
      newAttemptId: () => 'capture-setup',
      state,
    });
    const setup = await setupProgress.start({
      checkoutIdentity: observedCheckout.identity,
      logLocation: join(fixture.captureRoot, 'setup.log'),
      stage: 'no-dependencies',
      target,
    });
    expect(setup.ok).toBe(true);
    const observed = await createDependencyReceipt({
      attemptId: setup.record.attemptId,
      checkoutIdentity: observedCheckout.identity,
      wtDir: checkoutRoot,
    });
    expect(observed.ok).toBe(true);
    const completed = await setupProgress.finish({
      attemptId: setup.record.attemptId,
      checkoutIdentity: observedCheckout.identity,
      dependencyReceipt: observed.receipt,
      outcome: 'completed',
      target,
    });
    expect(completed.ok).toBe(true);
    dependency = await createDependencyAdapter({
      resourcePaths,
      setupProgress,
      state,
    }).observe({
      checkoutIdentity: observedCheckout.identity,
      target,
      wtDir: checkoutRoot,
    });
    tree = await observeTree(checkoutRoot);
  } finally {
    if (oldPath === undefined) {
      delete process.env.PATH;
    } else {
      process.env.PATH = oldPath;
    }
    if (oldHeadPath === undefined) {
      delete process.env.SETU_FAKE_GIT_HEAD_PATH;
    } else {
      process.env.SETU_FAKE_GIT_HEAD_PATH = oldHeadPath;
    }
    if (oldStatusPath === undefined) {
      delete process.env.SETU_FAKE_GIT_STATUS_PATH;
    } else {
      process.env.SETU_FAKE_GIT_STATUS_PATH = oldStatusPath;
    }
  }
  expect(observedCheckout.ok).toBe(true);
  expect(dependency.ok).toBe(true);
  expect(tree.ok).toBe(true);
  const expected = {
    dependency: dependency.identity,
    dirty: observedCheckout.dirty,
    head: observedCheckout.head,
    identity: observedCheckout.identity,
  };
  expect(expected.head).toBe(head);

  const inputText = canonicalJson({
    context: {
      dependencyEvidence: [],
      goal: 'Capture the local fixture result.',
      plan: {},
      runId: binding.runId,
      span: {
        dependencies: [],
        spanId: binding.spanId,
        title: 'Capture fixture result',
      },
      version: 1,
    },
    request: {
      criteria: [],
      instructions: 'Create a local fixture result.',
      profile: profileId,
      requireChange: false,
      runId: binding.runId,
      spanId: binding.spanId,
      target,
      wallClockMs: 20_000,
    },
    version: 1,
  });
  const stored = createSpansArtifacts({ root: fixture.root }).put({
    mediaType: 'application/json',
    text: inputText,
  });
  expect(stored.ok).toBe(true);
  const inputArtifact = {
    digest: stored.artifactId.slice('sha256:'.length),
    id: stored.artifactId,
  };
  const checkoutSource = { ...source, cwd: checkoutRoot };
  const reviewBinding = {
    actionId: binding.actionId,
    admission: { kind: 'session', policyDigest: '3'.repeat(64) },
    attemptId: binding.attemptId,
    checkout: { expected, repoDir, wtDir: checkoutRoot },
    digests: {
      dependencies: digestOf(expected.dependency),
      dirty: expected.dirty.hash,
      head: sha256(expected.head),
    },
    executionVersion: 1,
    generation: binding.generation,
    inputArtifact,
    planVersion: 1,
    policy: profile.policy,
    profile: {
      digest: '',
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
  expect(reviewBinding.targetDigest).toMatch(DIGEST_PATTERN);
  expect(await fixture.prepareAction(reviewBinding.targetDigest)).toMatchObject(
    {
      ok: true,
      status: 'intent',
    }
  );
  const store = openSpansStore({ root: fixture.root });
  const capabilityEvidence = {
    connected: true,
    cost: { enforcement: 'unavailable' },
    identity: {
      client: definition.client,
      effort: definition.effort,
      model: definition.model,
      provider: definition.provider,
    },
    installed: true,
    observedAt: Date.now(),
    permissions: { mode: definition.permissionMode, status: 'verified' },
    provenance: {
      digest: `sha256:${'f'.repeat(64)}`,
      probeId: 'probe-capture-fixture',
      source: 'fresh-session-probe',
    },
    session: { id: 'session-capture-fixture', origin: 'fresh' },
    tools: Object.fromEntries(
      definition.tools.map((tool) => [tool, 'available'])
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
    readSpansExecutionRequest({
      artifact: createSpansArtifacts({ root: fixture.root }).read({
        artifactId: inputArtifact.id,
      }),
      binding: reviewBinding,
    })
  ).toMatchObject({ ok: true });
  const authority = createSpansExecutionAuthority({
    now: () => new Date('2026-10-20T00:00:00.000Z'),
    resolveBinding: async () => reviewBinding,
    store,
    verifyWritable: async () => true,
    writeArchive: async (effect) => await effect(),
  });
  const prepared = await authority.prepare({
    actionId: binding.actionId,
    attemptId: binding.attemptId,
    generation: binding.generation,
    planVersion: 1,
    runId: binding.runId,
    spanId: binding.spanId,
  });
  if (!prepared.ok) {
    throw new Error(
      `fixture review prepare failed: ${JSON.stringify(prepared)}`
    );
  }
  const [reviewDigest] = Object.keys(
    store.readRun({ runId: binding.runId }).view.execution.reviews
  );
  const challenge = await authority.issue({
    reviewDigest,
    runId: binding.runId,
  });
  expect(challenge.ok).toBe(true);
  const approved = await authority.approve({
    confirmation: {
      challengeId: challenge.challengeId,
      response: challenge.phrase,
    },
    reviewDigest,
    runId: binding.runId,
  });
  expect(approved.ok).toBe(true);
  const reviewSelector = {
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
    baseline: { digest: tree.digest, files: tree.files },
    baselineTree: tree.digest,
    billing: definition.billing,
    budgetMicro: null,
    checkoutIdentity: expected.identity,
    criteria: [],
    inputArtifact,
    inputDigest: '',
    instructions: 'Create a local fixture result.',
    launchMode: launchModeOf(definition),
    profile: profileId,
    requireChange: false,
    reviewRef: { reviewDigest, runId: binding.runId },
    reviewSelector,
    runId: binding.runId,
    spanId: binding.spanId,
    target,
    wallClockMs: 20_000,
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
  return {
    executionReview: {
      approvalDigest: savedExecution.approvalDigest,
      reviewDigest,
      runId: binding.runId,
    },
    reviewAuthority: authority,
    source: { ...checkoutSource, stdin: inputText },
    store,
  };
}

test('configured archive admission fails closed before capture launch', async () => {
  const fixture = await makeFixture();
  const adapter = fixture.makeAdapter(undefined, undefined, async () => null);
  const started = await adapter.start({
    binding,
    limits,
    source: fixtureSource(fixture.releasePath),
    start: startRequest(),
  });
  expect(started).toEqual({ code: 'ARCHIVE_ADMISSION_REFUSED', ok: false });
  expect(existsSync(`${fixture.releasePath}.ready`)).toBe(false);
  await adapter.close();
});

test('production admission requires an exact saved execution review before capture launch', async () => {
  const fixture = await makeFixture();
  const durable = await makeRealAdmission(fixture);
  expect(await durable.admission.release(durable.context.lease)).toEqual({
    ok: true,
  });
  const adapter = fixture.makeAdapter(
    async (pid) => ({
      processId: pid,
      processStartIdentity: `fixture-capture-${pid}`,
      state: 'alive',
    }),
    undefined,
    async () => durable.context
  );
  const started = await adapter.start({
    binding,
    limits,
    source: fixtureSource(fixture.releasePath),
    start: startRequest(),
  });
  if (started.captureProcess?.pid) {
    await rememberCapture(started.captureProcess.pid);
  }
  expect(started).toMatchObject({
    code: 'EXECUTION_REVIEW_REQUIRED',
    ok: false,
  });
  expect(existsSync(`${fixture.releasePath}.ready`)).toBe(false);
  await adapter.close();
});

test('captures one exact execution review reference in the private bootstrap', async () => {
  const fixture = await makeFixture();
  const adapter = fixture.makeAdapter(
    undefined,
    undefined,
    undefined,
    executionReview
  );
  expect(
    await adapter.start({
      binding,
      executionReview: { ...executionReview, reviewDigest: 'e'.repeat(64) },
      limits,
      source: fixtureSource(fixture.releasePath),
      start: startRequest(),
    })
  ).toEqual({ code: 'CAPTURE_START_INVALID', ok: false });
  expect(existsSync(`${fixture.releasePath}.ready`)).toBe(false);

  const started = await adapter.start({
    binding,
    limits,
    source: fixtureSource(fixture.releasePath),
    start: startRequest(),
  });
  if (started.captureProcess?.pid) {
    await rememberCapture(started.captureProcess.pid);
  }
  expect(started).toMatchObject({ ok: true, status: 'running' });
  expect(
    JSON.parse(readFileSync(started.descriptorPath, 'utf8')).executionReview
  ).toEqual(executionReview);
});

test('foreign and stale admission bindings refuse before capture launch', async () => {
  const cases = await Promise.all([
    makeFixture().then(async (fixture) => ({
      change: (lease) => ({
        ...lease,
        spansBinding: { ...lease.spansBinding, spanId: 'foreign-span' },
      }),
      durable: await makeRealAdmission(fixture),
      fixture,
    })),
    makeFixture().then(async (fixture) => ({
      change: (lease) => ({
        ...lease,
        spansBinding: {
          ...lease.spansBinding,
          generation: binding.generation + 1,
        },
      }),
      durable: await makeRealAdmission(fixture),
      fixture,
    })),
  ]);
  await Promise.all(
    cases.map(async ({ change, durable, fixture }) => {
      const context = {
        ...durable.context,
        lease: change(durable.context.lease),
      };
      const adapter = fixture.makeAdapter(
        undefined,
        undefined,
        async () => context
      );
      const result = await adapter.start({
        binding,
        limits,
        source: fixtureSource(fixture.releasePath),
        start: startRequest(),
      });
      expect(result).toEqual({ code: 'ARCHIVE_ADMISSION_REFUSED', ok: false });
      expect(existsSync(`${fixture.releasePath}.ready`)).toBe(false);
      await adapter.close();
      await durable.admission.release(durable.context.lease);
    })
  );
});

const startRequest = () => ({ ...binding, deadlineMs: 20_000 });
const fixtureSource = (releasePath) => ({
  args: [join(OWN_TEST_DIR, 'spans-worker-process.fixture.js'), releasePath],
  command: process.execPath,
  cwd: resolve(OWN_TEST_DIR),
  env: {},
  stdin: 'Create a fixture result.\n',
});

test('pipes the exact bounded reviewed stdin into the detached provider', async () => {
  const fixture = await makeFixture();
  const adapter = fixture.makeAdapter();
  const stdin = 'Create a file with café and 🧪.\nKeep this spacing.  \n';
  const started = await adapter.start({
    binding,
    limits,
    source: { ...fixtureSource(fixture.releasePath), stdin },
    start: startRequest(),
  });
  if (started.captureProcess?.pid) {
    await rememberCapture(started.captureProcess.pid);
  }
  expect(started).toMatchObject({ ok: true, status: 'running' });
  await waitFor(
    () => existsSync(`${fixture.releasePath}.stdin`),
    'provider stdin end'
  );
  expect(readFileSync(`${fixture.releasePath}.stdin`)).toEqual(
    Buffer.from(stdin, 'utf8')
  );
  expect(
    JSON.parse(readFileSync(started.descriptorPath, 'utf8')).source.stdin
  ).toBe(stdin);
});

test('rejects missing, empty, oversized and descriptor-expanding stdin before spawn', async () => {
  const fixture = await makeFixture();
  let spawnCalls = 0;
  const adapter = fixture.makeAdapter(undefined, (...args) => {
    spawnCalls += 1;
    return spawnProcess(...args);
  });
  const source = fixtureSource(fixture.releasePath);
  let accessorReads = 0;
  const accessorSource = { ...source };
  Object.defineProperty(accessorSource, 'stdin', {
    get() {
      accessorReads += 1;
      throw new Error('stdin accessor must not run');
    },
  });
  const malformed = [
    Object.fromEntries(
      Object.entries(source).filter(([key]) => key !== 'stdin')
    ),
    accessorSource,
    { ...source, stdin: '' },
    { ...source, stdin: String.fromCharCode(0xd8_00) },
    { ...source, stdin: 'x'.repeat(MAX_DESCRIPTOR_BYTES + 1) },
    { ...source, stdin: 'x'.repeat(MAX_DESCRIPTOR_BYTES - 1) },
  ];
  for (const candidate of malformed) {
    // biome-ignore lint/performance/noAwaitInLoops: These malformed inputs are checked one at a time against the same adapter.
    const result = await adapter.start({
      binding,
      limits,
      source: candidate,
      start: startRequest(),
    });
    expect(result).toEqual({ code: 'CAPTURE_START_INVALID', ok: false });
  }
  expect(accessorReads).toBe(0);
  expect(spawnCalls).toBe(0);
  expect(existsSync(`${fixture.releasePath}.pid`)).toBe(false);
});

test('trusted profile deadlines accept their exact ceiling and reject one millisecond over', async () => {
  const profiles = [
    { id: 'accepted-luna-high', maxDeadlineMs: 30 * 60 * 1000 },
    { id: 'claude-subscription', maxDeadlineMs: 60 * 60 * 1000 },
  ];
  for (const profile of profiles) {
    // biome-ignore lint/performance/noAwaitInLoops: Each profile owns isolated filesystem state and child cleanup.
    const fixture = await makeFixture();
    let spawnCalls = 0;
    const adapter = fixture.makeAdapter(undefined, (...args) => {
      spawnCalls += 1;
      return spawnProcess(...args);
    });
    const trustedLimits = { ...limits, maxDeadlineMs: profile.maxDeadlineMs };
    const source = fixtureSource(fixture.releasePath);
    const started = await adapter.start({
      binding,
      limits: trustedLimits,
      source,
      start: { ...binding, deadlineMs: profile.maxDeadlineMs },
    });
    if (started.captureProcess?.pid) {
      await rememberCapture(started.captureProcess.pid);
    }
    expect(started).toMatchObject({ ok: true, status: 'running' });
    expect(spawnCalls).toBe(1);
    expect(
      await adapter.start({
        binding,
        limits: trustedLimits,
        source,
        start: { ...binding, deadlineMs: profile.maxDeadlineMs + 1 },
      })
    ).toEqual({ code: 'CAPTURE_START_INVALID', ok: false });
    expect(spawnCalls).toBe(1);
  }
});

function liveSpoolChunks(root) {
  const store = openSpansStore({ readonly: true, root });
  let attempt;
  try {
    attempt = store.readRun({ runId: binding.runId }).view.attempts[
      binding.attemptId
    ];
  } finally {
    store.close();
  }
  if (!attempt?.attemptDigest) {
    return null;
  }
  return createSpansWorkerSpool({
    maxAttemptBytes: limits.maxAttemptBytes,
    maxAttemptChunks: limits.maxAttemptChunks,
    maxChunkBytes: limits.maxChunkBytes,
    root,
  }).stat({ attemptDigest: attempt.attemptDigest });
}

async function waitFor(check, label) {
  const end = Date.now() + 6000;
  while (Date.now() < end) {
    // biome-ignore lint/performance/noAwaitInLoops: Poll serially until the expected fixture state appears or the deadline expires.
    const result = await check();
    if (result) {
      return result;
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 20));
  }
  throw new Error(`timed out waiting for ${label}`);
}

function rawRequest(controlDir, payload) {
  const requestId = randomBytes(16).toString('hex');
  const requestPath = join(controlDir, `request-${requestId}.json`);
  const responsePath = join(controlDir, `response-${requestId}.json`);
  return new Promise((resolveRequest, reject) => {
    const finish = (error, value) => {
      clearInterval(interval);
      clearTimeout(timeout);
      try {
        unlinkSync(requestPath);
      } catch {
        // The request may already have been consumed by the child.
      }
      try {
        unlinkSync(responsePath);
      } catch {
        // The response may not have been published before a timeout.
      }
      if (error) {
        reject(error);
      } else {
        resolveRequest(value);
      }
    };
    const receive = () => {
      if (!existsSync(responsePath)) {
        return;
      }
      try {
        finish(null, JSON.parse(readFileSync(responsePath, 'utf8')));
      } catch (error) {
        finish(error);
      }
    };
    const timeout = setTimeout(
      () => finish(new Error('timed out waiting for child reply')),
      3000
    );
    const interval = setInterval(receive, 10);
    try {
      writeFileSync(requestPath, JSON.stringify({ ...payload, requestId }), {
        flag: 'wx',
        mode: 0o600,
      });
      receive();
    } catch (error) {
      finish(error);
    }
  });
}

test('the detached child records only the first stdout native session and retains it across reconnect', async () => {
  const fixture = await makeFixture();
  const source = fixtureSource(fixture.releasePath);
  const adapter = fixture.makeAdapter();
  const started = await adapter.start({
    binding,
    limits,
    source: { ...source, args: [...source.args, 'native-session'] },
    start: startRequest(),
  });
  if (started.captureProcess?.pid) {
    await rememberCapture(started.captureProcess.pid);
  }
  expect(started.ok).toBe(true);
  const store = openSpansStore({ readonly: true, root: fixture.root });
  const reconnected = fixture.makeAdapter();
  try {
    await waitFor(
      () =>
        store.readRun({ runId: binding.runId }).view.attempts[binding.attemptId]
          ?.nativeId === 'native-fixture',
      'durable native session'
    );
    await adapter.close();
    const resumed = await reconnected.reconnect({
      binding,
      descriptorPath: started.descriptorPath,
    });
    expect(resumed.ok).toBe(true);
    expect(resumed.observation.nativeId).toBe('native-fixture');
    expect(resumed.archive.view.attempts[binding.attemptId].nativeId).toBe(
      'native-fixture'
    );
    const pid = Number(readFileSync(`${fixture.releasePath}.pid`, 'utf8'));
    process.kill(pid, 'SIGUSR2');
    const exited = await waitFor(() => {
      const attempt = store.readRun({ runId: binding.runId }).view.attempts[
        binding.attemptId
      ];
      return attempt?.status === 'exited' ? attempt : null;
    }, 'captured native fixture exit');
    const artifact = createSpansArtifacts({ root: fixture.root }).read({
      artifactId: exited.capture.artifactId,
    });
    expect(artifact.ok).toBe(true);
    expect(artifact.text).toContain('stderr-native');
    expect(artifact.text).toContain('later-native');
    expect(exited.nativeId).toBe('native-fixture');
  } finally {
    await adapter.close();
    await reconnected.close();
    store.close();
  }
});

afterEach(async () => {
  const fixturePids = new Set();
  for (const marker of providerMarkers) {
    try {
      const pid = Number(readFileSync(`${marker}.pid`, 'utf8'));
      if (Number.isSafeInteger(pid) && pid > 0) {
        fixturePids.add(pid);
        process.kill(pid, 'SIGUSR2');
      }
    } catch {
      // The marker may be absent if the fixture failed before launch.
    }
  }
  for (const pid of providers) {
    try {
      process.kill(pid, 'SIGTERM');
    } catch {
      // The provider may already have exited after its final chunk.
    }
  }
  const fixtureDeadline = Date.now() + 2000;
  while (fixturePids.size && Date.now() < fixtureDeadline) {
    for (const pid of fixturePids) {
      try {
        process.kill(pid, 0);
      } catch (error) {
        if (error.code === 'ESRCH') {
          fixturePids.delete(pid);
        }
      }
    }
    if (fixturePids.size) {
      // biome-ignore lint/performance/noAwaitInLoops: Wait serially for owned fixture processes to exit before removing their files.
      await new Promise((resolveWait) => setTimeout(resolveWait, 25));
    }
  }
  await Promise.all(
    [...children].map(async ([pid, processStartIdentity]) => {
      await stopOwnedFixtureCapture({ pid, processStartIdentity });
      children.delete(pid);
    })
  );
  const safeToRemove = children.size === 0;
  children.clear();
  providers.clear();
  if (safeToRemove) {
    for (const path of [...roots, ...tempRoots]) {
      rmSync(path, { force: true, recursive: true });
    }
  }
  roots.length = 0;
  tempRoots.clear();
  providerMarkers.clear();
});

test('one detached child owns host start and durable capture across coordinator reconnect', async () => {
  const fixture = await makeFixture();
  let captureStarts = 0;
  const spawnCapture = (...args) => {
    if (
      args[0] === process.execPath &&
      args[1]?.[0] === join(OWN_TEST_DIR, 'spans-worker-child.js')
    ) {
      captureStarts += 1;
    }
    return spawnProcess(...args);
  };
  const first = fixture.makeAdapter(undefined, spawnCapture);
  const started = await first.start({
    binding,
    limits,
    source: fixtureSource(fixture.releasePath),
    start: startRequest(),
  });
  if (started.captureProcess?.pid) {
    await rememberCapture(started.captureProcess.pid);
  }
  expect(started).toMatchObject({ ok: true, status: 'running' });
  const processDir = dirname(started.descriptorPath);
  const captureIdentity = JSON.parse(
    readFileSync(join(processDir, 'capture-process.json'), 'utf8')
  ).captureProcess;
  expect(captureIdentity.pid).toBe(started.captureProcess.pid);
  await waitFor(
    () => existsSync(`${fixture.releasePath}.ready`),
    'fixture provider launch'
  );
  const firstConnection = await first.reconnect({
    binding,
    descriptorPath: started.descriptorPath,
  });
  expect(firstConnection.ok).toBe(true);
  const providerProcess = firstConnection.observation.provider.processStart;
  expect(Number.isSafeInteger(providerProcess.pid)).toBe(true);
  providers.add(providerProcess.pid);
  await waitFor(() => {
    const stat = liveSpoolChunks(fixture.root);
    return stat?.ok === true && stat.chunks === 1;
  }, 'first durable chunk');

  expect(await first.close()).toEqual({ ok: true });
  expect(
    await observeFixtureProcessIdentity(started.captureProcess.pid)
  ).toMatchObject({ state: 'alive' });
  process.kill(providerProcess.pid, 'SIGUSR1');
  await waitFor(
    () => existsSync(`${fixture.releasePath}.second`),
    'offline provider output'
  );

  const second = fixture.makeAdapter(undefined, spawnCapture);
  const reconnected = await second.reconnect({
    binding,
    descriptorPath: started.descriptorPath,
  });
  expect(reconnected.ok).toBe(true);
  await waitFor(() => {
    const stat = liveSpoolChunks(fixture.root);
    return stat?.ok === true && stat.chunks === 2;
  }, 'second durable chunk');
  expect(
    await second.start({
      binding,
      limits,
      source: fixtureSource(fixture.releasePath),
      start: startRequest(),
    })
  ).toMatchObject({ code: 'ATTEMPT_ALREADY_STARTED', ok: false });
  expect(captureStarts).toBe(1);
  process.kill(providerProcess.pid, 'SIGUSR2');
  const terminalStore = openSpansStore({
    create: false,
    readonly: true,
    root: fixture.root,
  });
  const final = await waitFor(() => {
    const read = terminalStore.readRun({ runId: binding.runId });
    const attempt = read?.view?.attempts?.[binding.attemptId];
    return attempt?.status === 'exited' ? { attempt } : null;
  }, 'canonical final artifact receipt');
  terminalStore.close();
  expect(final.attempt.capture).toMatchObject({ chunks: 2, complete: true });
  expect(captureStarts).toBe(1);
  expect(
    createSpansArtifacts({ root: fixture.root }).read({
      artifactId: final.attempt.capture.artifactId,
    })
  ).toMatchObject({
    ok: true,
    text: 'first token=[REDACTED]\nsecond fixture chunk\n',
  });
  const closed = openSpansStore({ readonly: true, root: fixture.root });
  expect(
    closed.readRun({ runId: binding.runId }).view.attempts[binding.attemptId]
      .status
  ).toBe('exited');
  closed.close();
  await second.close();
});

test('wrong token, binding, generation and capture identity refuse without relaunch', async () => {
  const fixture = await makeFixture();
  const adapter = fixture.makeAdapter();
  const started = await adapter.start({
    binding,
    limits,
    source: fixtureSource(fixture.releasePath),
    start: startRequest(),
  });
  if (started.captureProcess?.pid) {
    await rememberCapture(started.captureProcess.pid);
  }
  expect(started.ok).toBe(true);
  await waitFor(
    () => existsSync(`${fixture.releasePath}.ready`),
    'fixture provider launch'
  );
  const descriptor = JSON.parse(readFileSync(started.descriptorPath, 'utf8'));
  expect(
    await rawRequest(descriptor.controlDir, {
      binding,
      operation: 'observe',
      token: `${descriptor.token[0] === '0' ? '1' : '0'}${descriptor.token.slice(1)}`,
    })
  ).toEqual({ code: 'BINDING_OR_TOKEN_MISMATCH', ok: false });
  expect(
    await adapter.reconnect({
      binding: { ...binding, generation: 3 },
      descriptorPath: started.descriptorPath,
    })
  ).toMatchObject({ code: 'ATTEMPT_AUTHORIZATION_REFUSED', ok: false });
  const unknown = fixture.makeAdapter(
    async () => ({ state: 'unknown' }),
    () => {
      throw new Error('reconnect must not launch');
    }
  );
  expect(
    await unknown.reconnect({ binding, descriptorPath: started.descriptorPath })
  ).toMatchObject({ code: 'CAPTURE_PROCESS_UNKNOWN', ok: false });
  const mismatch = fixture.makeAdapter(async (pid) => ({
    processId: pid,
    processStartIdentity: 'different-start',
    state: 'alive',
  }));
  expect(
    await mismatch.reconnect({
      binding,
      descriptorPath: started.descriptorPath,
    })
  ).toMatchObject({ code: 'CAPTURE_PROCESS_IDENTITY_MISMATCH', ok: false });
  expect(
    await adapter.cancel({
      binding: { ...binding, generation: 3 },
      descriptorPath: started.descriptorPath,
    })
  ).toMatchObject({ code: 'ATTEMPT_AUTHORIZATION_REFUSED', ok: false });
  expect(await adapter.close()).toEqual({ ok: true });
});

test('unknown capture identity stays unknown and cannot be mistaken for successful start', async () => {
  const fixture = await makeFixture();
  const adapter = fixture.makeAdapter(async () => ({ state: 'unknown' }));
  const started = await adapter.start({
    binding,
    limits,
    source: fixtureSource(fixture.releasePath),
    start: startRequest(),
  });
  if (started.captureProcess?.pid) {
    await rememberCapture(started.captureProcess.pid);
  }
  expect(started).toMatchObject({
    code: 'CAPTURE_PROCESS_IDENTITY_UNKNOWN',
    ok: false,
    unknown: true,
  });
  expect(started).not.toMatchObject({ ok: true, status: 'running' });
  await adapter.close();
});

test('the child rejects a stale-generation cancel despite an unchanged coordinator authorizer', async () => {
  const fixture = await makeFixture();
  const adapter = fixture.makeAdapter();
  const started = await adapter.start({
    binding,
    limits,
    source: fixtureSource(fixture.releasePath),
    start: startRequest(),
  });
  if (started.captureProcess?.pid) {
    await rememberCapture(started.captureProcess.pid);
  }
  expect(started.ok).toBe(true);
  await waitFor(
    () => liveSpoolChunks(fixture.root)?.chunks === 1,
    'first durable chunk'
  );
  const connected = await adapter.reconnect({
    binding,
    descriptorPath: started.descriptorPath,
  });
  const providerPid = connected.observation.provider.processStart.pid;
  providers.add(providerPid);
  const store = openSpansStore({ create: false, root: fixture.root });
  const current = store.readRun({ runId: binding.runId });
  expect(
    store.commitRun({
      events: [],
      expectedGeneration: 0,
      expectedRevision: current.revision,
      runId: binding.runId,
      view: { ...current.view, generation: 1 },
    }).ok
  ).toBe(true);
  store.close();
  expect(
    await adapter.cancel({ binding, descriptorPath: started.descriptorPath })
  ).toMatchObject({ code: 'STALE_GENERATION', ok: false });
  expect((await observeFixtureProcessIdentity(providerPid)).state).toBe(
    'alive'
  );
  expect(existsSync(`${fixture.releasePath}.exited`)).toBe(false);
  expect(() => process.kill(providerPid, 0)).not.toThrow();
  expect(liveSpoolChunks(fixture.root).chunks).toBe(1);
  await adapter.close();
});

test('detached capture uses a durable archive lease for output and finalization', async () => {
  const fixture = await makeFixture({ deferAction: true });
  const approved = await makeApprovedCaptureReview(
    fixture,
    fixtureSource(fixture.releasePath)
  );
  const durable = await makeRealAdmission(fixture);
  const adapter = fixture.makeAdapter(
    undefined,
    undefined,
    async () => durable.context,
    approved.executionReview
  );
  const started = await adapter.start({
    binding,
    limits,
    source: approved.source,
    start: startRequest(),
  });
  if (started.captureProcess?.pid) {
    await rememberCapture(started.captureProcess.pid);
  }
  if (!started.ok) {
    throw new Error(`approved capture start failed: ${started.code}`);
  }
  const captured = await waitFor(async () => {
    const result = await adapter.reconnect({
      binding,
      descriptorPath: started.descriptorPath,
    });
    const spool = liveSpoolChunks(fixture.root);
    return result.ok && spool?.chunks >= 1 ? spool : null;
  }, 'leased capture');
  expect(captured.bytes).toBeGreaterThan(0);
  const pid = Number(readFileSync(`${fixture.releasePath}.pid`, 'utf8'));
  process.kill(pid, 'SIGUSR2');
  const finished = await waitFor(() => {
    const read = approved.store.readRun({ runId: binding.runId });
    const attempt = read?.view?.attempts?.[binding.attemptId];
    return attempt?.status === 'exited' ? attempt : null;
  }, 'leased finalization');
  expect(finished.capture.complete).toBe(true);
  expect(finished.receipt.capture).toEqual(finished.capture);
  expect(finished.receipt.exit).toEqual(finished.exit);
  expect((await durable.admission.status()).leases).toHaveLength(1);
  await adapter.close();
  await approved.reviewAuthority.close();
  approved.store.close();
}, 20_000);

test('native capture exhaustion confirms exit without accepting incomplete work or releasing its lease', async () => {
  const fixture = await makeFixture({ deferAction: true });
  const approved = await makeApprovedCaptureReview(
    fixture,
    fixtureSource(fixture.releasePath)
  );
  const activeLimits = { ...limits, maxAttemptChunks: 1 };
  const durable = await makeRealAdmission(fixture, activeLimits);
  const adapter = fixture.makeAdapter(
    undefined,
    undefined,
    async () => durable.context,
    approved.executionReview
  );
  const started = await adapter.start({
    binding,
    limits: activeLimits,
    source: approved.source,
    start: startRequest(),
  });
  if (started.captureProcess?.pid) {
    await rememberCapture(started.captureProcess.pid);
  }
  expect(started.ok).toBe(true);
  await waitFor(
    () => liveSpoolChunks(fixture.root)?.chunks === 1,
    'first bounded chunk'
  );
  const pid = Number(readFileSync(`${fixture.releasePath}.pid`, 'utf8'));
  process.kill(pid, 'SIGUSR1');
  const finished = await waitFor(() => {
    // The capture child can exit immediately after its terminal commit.
    const result = approved.store.readRun({ runId: binding.runId });
    const attempt = result.view?.attempts?.[binding.attemptId];
    return attempt?.exit !== null && attempt?.exit !== undefined
      ? attempt
      : null;
  }, 'bounded provider exit');
  expect(finished).toMatchObject({
    cancel: { state: 'delivered' },
    capture: { complete: false, gap: { reason: 'spool-limit' } },
    exit: { code: 0, signal: null },
    receipt: { workAccepted: false },
    status: 'held',
  });
  expect((await durable.admission.status()).leases).toHaveLength(1);
  await adapter.close();
  await approved.reviewAuthority.close();
  approved.store.close();
}, 20_000);

test('deadline holds incomplete capture before stopping the owned provider group', async () => {
  const fixture = await makeFixture();
  const adapter = fixture.makeAdapter();
  const started = await adapter.start({
    binding,
    limits,
    source: fixtureSource(fixture.releasePath),
    start: { ...binding, deadlineMs: 500 },
  });
  if (started.captureProcess?.pid) {
    await rememberCapture(started.captureProcess.pid);
  }
  expect(started).toMatchObject({ ok: true, status: 'running' });
  await waitFor(
    () => existsSync(`${fixture.releasePath}.ready`),
    'deadline provider'
  );
  const providerPid = Number(
    readFileSync(`${fixture.releasePath}.pid`, 'utf8')
  );
  providers.add(providerPid);
  const archive = openSpansStore({ create: false, root: fixture.root });
  const held = await waitFor(() => {
    // Terminal evidence remains readable after the capture controller exits.
    const state = archive.readRun({ runId: binding.runId });
    const attempt = state.view?.attempts?.[binding.attemptId];
    return attempt?.status === 'held' && attempt.cancel?.state === 'delivered'
      ? attempt
      : null;
  }, 'deadline hold and stop');
  archive.close();
  expect(held).toMatchObject({
    cancel: { state: 'delivered' },
    capture: { complete: false, gap: { reason: 'deadline' } },
    receipt: { workAccepted: false },
    status: 'held',
  });
  await waitFor(
    async () =>
      (await observeFixtureProcessIdentity(providerPid)).state === 'absent',
    'deadline provider group exit'
  );
  await adapter.close();
}, 20_000);

test('low-level raw capture fixture stdin failure stays incomplete through owned stop and deadline', async () => {
  const fixture = await makeFixture();
  const source = fixtureSource(fixture.releasePath);
  const adapter = fixture.makeAdapter();
  const started = await adapter.start({
    binding,
    limits,
    source: {
      ...source,
      args: [...source.args, 'reject-stdin'],
      stdin: 'x'.repeat(120 * 1024),
    },
    start: { ...binding, deadlineMs: 800 },
  });
  if (started.captureProcess?.pid) {
    await rememberCapture(started.captureProcess.pid);
  }
  expect(started).toMatchObject({ ok: true, status: 'running' });
  await waitFor(
    () => existsSync(`${fixture.releasePath}.stdin-rejected`),
    'provider stdin rejection'
  );
  await waitFor(
    () => existsSync(`${fixture.releasePath}.exited`),
    'stdin failure provider exit'
  );
  const terminalStore = openSpansStore({
    create: false,
    readonly: true,
    root: fixture.root,
  });
  const held = await waitFor(() => {
    const read = terminalStore.readRun({ runId: binding.runId });
    const attempt = read?.view?.attempts?.[binding.attemptId];
    return attempt?.status === 'held' && attempt.exit !== null ? attempt : null;
  }, 'stdin failure held exit');
  terminalStore.close();
  expect(held).toMatchObject({
    cancel: { state: 'delivered' },
    capture: { complete: false, gap: { reason: 'deadline' } },
    exit: { code: 0, signal: null },
    receipt: { outcome: 'unknown', workAccepted: false },
    status: 'held',
  });
  await adapter.close();
}, 20_000);
