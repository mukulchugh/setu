import { afterEach, describe, expect, test } from 'bun:test';
import { createSpansArtifacts } from './spans-artifacts.js';
import { targetDigestFor } from './spans-dispatch.js';
import {
  createExecutionFixture,
  PROFILE,
  TARGET,
} from './spans-execution.test-support.js';
import {
  buildSpansExecutionEnvelope,
  buildSpansExecutionReviewBinding,
  readSpansExecutionRequest,
} from './spans-execution-binding.js';
import { canonicalJson, digestOf, sha256 } from './spans-execution-core.js';
import { SPANS_EXEC_DEFAULT_PROFILES } from './spans-execution-provider.js';
import {
  createSpansExecutionReviews,
  SPANS_EXECUTION_REVIEW_PROFILES,
} from './spans-execution-review.js';

let fx;
const DIGEST_PATTERN = /^[a-f0-9]{64}$/;

afterEach(async () => {
  await fx?.dispose();
  fx = undefined;
});

const LUNA_PROFILE = 'codex:gpt-6-luna:high';
const LUNA_DEFINITION = Object.freeze({
  billing: 'subscription',
  effort: 'high',
  model: 'gpt-6-luna',
  provider: 'codex',
});

function selectorFor(run, spanId = 'build', suffix = '') {
  return {
    actionId: `action-${spanId}${suffix}`,
    attemptId: `attempt-${spanId}${suffix}`,
    generation: run.generation,
    planVersion: run.view.planVersion,
    runId: run.view.runId,
    spanId,
  };
}

function makeExpected(fixture) {
  const { repoDir, wtDir } = fixture;
  return {
    dependency: {
      bunVersion: '1.3.14',
      linkerMode: 'isolated',
      lockfileHash: 'b'.repeat(64),
      platformNamespace: 'darwin-arm64',
    },
    dirty: { count: 0, hash: 'a'.repeat(64) },
    head: '0123456789abcdef0123456789abcdef01234567',
    identity: {
      admin: { birthtimeNs: '1', dev: '2', ino: '3' },
      adminPath: `${repoDir}/worktrees/feature`,
      checkout: { birthtimeNs: '4', dev: '5', ino: '6' },
      checkoutPath: wtDir,
      known: true,
      repository: { birthtimeNs: '7', dev: '8', ino: '9' },
      repositoryPath: repoDir,
    },
  };
}

function makeBuilt(fixture, run, overrides = {}) {
  const spanId = overrides.spanId ?? 'build';
  const profile = overrides.profile ?? PROFILE;
  const actionId = overrides.actionId ?? `action-${spanId}`;
  const attemptId = overrides.attemptId ?? `attempt-${spanId}`;
  const target = overrides.target ?? TARGET;
  const acceptance = overrides.acceptance ?? {
    criteria: [],
    requireChange: false,
  };
  const wallClockMs = overrides.wallClockMs ?? 30_000;
  const expected = overrides.expected ?? makeExpected(fixture);
  const targetDigest = targetDigestFor(expected);
  const requiredCapabilities = overrides.requiredCapabilities ?? [
    'launch',
    'model',
    'permissions',
    'tools',
  ];
  const review = {
    acceptance,
    actionId,
    attemptId,
    generation: run.generation,
    instructions: overrides.instructions ?? 'Create fixture-output.txt.',
    planVersion: run.view.planVersion,
    profile,
    requiredCapabilities,
    runId: run.view.runId,
    spanId,
    target,
    wallClockMs,
  };
  if (Object.hasOwn(overrides, 'budgetUsd')) {
    review.budgetUsd = overrides.budgetUsd;
  }
  return {
    budgetMicro: overrides.budgetMicro ?? null,
    dispatchRequest: {
      actionId,
      admissionKind: 'headless-run',
      attemptId,
      checkout: { expected, repoDir: fixture.repoDir, wtDir: fixture.wtDir },
      generation: run.generation,
      planVersion: run.view.planVersion,
      requiredCapabilities,
      runId: run.view.runId,
      spanId,
      target,
      targetDigest,
    },
    profileDigest: 'c'.repeat(64),
    refusal: null,
    review,
  };
}

function readyRun(fixture) {
  const run = fixture.store.readRun({ runId: 'run-1' });
  run.view.spans.verify.dependencies = [];
  return run;
}

function makeEnvelope(fixture, run, overrides = {}) {
  return buildSpansExecutionEnvelope({
    built: makeBuilt(fixture, run, overrides),
    run,
  });
}

function storedArtifact(fixture, envelope) {
  const stored = fixture.artifacts.put({
    mediaType: envelope.mediaType,
    text: envelope.text,
  });
  if (!stored.ok) {
    throw new Error(`fixture artifact write failed: ${stored.code}`);
  }
  return {
    artifact: fixture.artifacts.read({ artifactId: stored.artifactId }),
    inputArtifact: {
      digest: stored.artifactId.slice('sha256:'.length),
      id: stored.artifactId,
    },
  };
}

async function bindingFor(fixture, run, envelope, overrides = {}) {
  const { inputArtifact } = storedArtifact(fixture, envelope);
  const status = await fixture.admission.status();
  const built = makeBuilt(fixture, run, overrides);
  const result = buildSpansExecutionReviewBinding({
    admissionLimits: status.limits,
    built,
    definition:
      (overrides.profile ?? PROFILE) === LUNA_PROFILE
        ? LUNA_DEFINITION
        : SPANS_EXEC_DEFAULT_PROFILES[PROFILE],
    inputArtifact,
  });
  return { ...result, artifactInfo: { inputArtifact } };
}

describe('retained execution envelopes', () => {
  test('retains distinct span and request identities without reading execution maps', () => {
    fx = createExecutionFixture();
    const run = readyRun(fx);
    const first = makeEnvelope(fx, run, { spanId: 'build' });
    const second = makeEnvelope(fx, run, { spanId: 'verify' });
    const changed = makeEnvelope(fx, run, {
      instructions: 'Change the requested work.',
      spanId: 'build',
    });

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    expect(changed.ok).toBe(true);
    expect(
      new Set([first.artifactId, second.artifactId, changed.artifactId]).size
    ).toBe(3);

    Object.defineProperty(run.view, 'execution', {
      configurable: true,
      enumerable: true,
      get() {
        throw new Error('execution slot must not be read');
      },
    });
    run.view.executions = new Proxy(
      {},
      {
        get() {
          throw new Error('execution map must not be read');
        },
        ownKeys() {
          throw new Error('execution map must not be read');
        },
      }
    );
    expect(makeEnvelope(fx, run, { spanId: 'build' })).toMatchObject({
      artifactId: first.artifactId,
      ok: true,
      text: first.text,
    });
  });

  test('includes accepted source dependency evidence in the retained context', () => {
    fx = createExecutionFixture();
    const run = fx.store.readRun({ runId: 'run-1' });
    run.view.spans.build.state = 'completed';
    run.view.spans.build.acceptedActionId = 'action-build';
    run.view.spans.build.acceptedCheckpoint = 1;
    run.view.spans.build.acceptedEvidenceId = 'evidence-build';
    run.view.actions = {
      'action-build': {
        actionId: 'action-build',
        outcomeArtifactIds: ['artifact-build'],
        spanId: 'build',
        state: 'completed',
      },
    };
    const envelope = makeEnvelope(fx, run, { spanId: 'verify' });

    expect(envelope.ok).toBe(true);
    expect(JSON.parse(envelope.text).context.dependencyEvidence).toEqual([
      {
        acceptedActionId: 'action-build',
        acceptedCheckpoint: 1,
        acceptedEvidenceId: 'evidence-build',
        artifactIds: ['artifact-build'],
        spanId: 'build',
        state: 'completed',
        title: 'Build the thing',
      },
    ]);
  });

  test('refuses malformed, unknown-version, approval-bearing and oversized envelopes', async () => {
    fx = createExecutionFixture();
    const run = readyRun(fx);
    const envelope = makeEnvelope(fx, run);
    const bindingResult = await bindingFor(fx, run, envelope);
    expect(bindingResult.ok).toBe(true);
    const { binding } = bindingResult;

    const tampered = JSON.parse(envelope.text);
    tampered.request.instructions = 'tampered';
    const tamperedArtifact = {
      mediaType: envelope.mediaType,
      ok: true,
      text: canonicalJson(tampered),
    };
    expect(
      readSpansExecutionRequest({ artifact: tamperedArtifact, binding }).ok
    ).toBe(false);

    const putVariant = (value) => {
      const put = fx.artifacts.put({
        mediaType: envelope.mediaType,
        text: canonicalJson(value),
      });
      return {
        artifact: fx.artifacts.read({ artifactId: put.artifactId }),
        binding: {
          ...binding,
          inputArtifact: {
            digest: put.artifactId.slice('sha256:'.length),
            id: put.artifactId,
          },
        },
      };
    };

    const unknownVersion = JSON.parse(envelope.text);
    unknownVersion.version = 2;
    const unknown = putVariant(unknownVersion);
    expect(
      readSpansExecutionRequest({
        artifact: unknown.artifact,
        binding: unknown.binding,
      }).ok
    ).toBe(false);

    const withApproval = JSON.parse(envelope.text);
    withApproval.request.approved = true;
    const approval = putVariant(withApproval);
    expect(
      readSpansExecutionRequest({
        artifact: approval.artifact,
        binding: approval.binding,
      }).ok
    ).toBe(false);

    const validStored = storedArtifact(fx, envelope);
    const unrecognizedPolicy = {
      ...binding,
      policy: { ...binding.policy, attemptTimeoutMs: 1234 },
    };
    expect(
      readSpansExecutionRequest({
        artifact: validStored.artifact,
        binding: unrecognizedPolicy,
      }).ok
    ).toBe(false);

    const oversizedRun = readyRun(fx);
    oversizedRun.view.spans.build.title = 'x'.repeat(65_300);
    expect(makeEnvelope(fx, oversizedRun).ok).toBe(false);
  });

  test('decodes the exact request from a reopened private artifact and E93 prepare accepts the binding', async () => {
    fx = createExecutionFixture();
    const run = readyRun(fx);
    const envelope = makeEnvelope(fx, run, {
      acceptance: {
        criteria: ['Keep the API compatible.'],
        requireChange: true,
      },
      instructions: 'Create fixture-output.txt.',
    });
    const bindingResult = await bindingFor(fx, run, envelope);
    expect(bindingResult.ok).toBe(true);

    const selector = selectorFor(run);
    const reviews = createSpansExecutionReviews({
      resolveBinding: async () => bindingResult.binding,
      store: fx.store,
      verifyWritable: async () => true,
    });
    const prepared = await reviews.prepare(selector);
    expect(prepared.ok).toBe(true);

    const retainedRead = createSpansArtifacts({ root: fx.archive }).read({
      artifactId: bindingResult.binding.inputArtifact.id,
    });
    const decoded = readSpansExecutionRequest({
      artifact: retainedRead,
      binding: prepared.review.binding,
    });
    expect(decoded).toEqual({
      ok: true,
      request: {
        criteria: ['Keep the API compatible.'],
        instructions: 'Create fixture-output.txt.',
        profile: PROFILE,
        requireChange: true,
        runId: 'run-1',
        spanId: 'build',
        target: TARGET,
        wallClockMs: 30_000,
      },
    });
    expect(
      fx.store.readRun({ runId: 'run-1' }).view.execution.receipts
    ).toEqual({});
  });

  test('rejects argument accessors and proxies without invoking user traps', async () => {
    fx = createExecutionFixture();
    const run = readyRun(fx);
    const envelope = makeEnvelope(fx, run);
    let calls = 0;
    const accessorArgs = Object.defineProperties(
      {},
      {
        built: { enumerable: true, value: makeBuilt(fx, run) },
        run: {
          enumerable: true,
          get() {
            calls += 1;
            return run;
          },
        },
      }
    );
    expect(buildSpansExecutionEnvelope(accessorArgs).ok).toBe(false);

    const accessorSpan = readyRun(fx);
    Object.defineProperty(accessorSpan.view.spans.build, 'title', {
      configurable: true,
      enumerable: true,
      get() {
        calls += 1;
        return 'must not be read';
      },
    });
    expect(makeEnvelope(fx, accessorSpan).ok).toBe(false);

    const trapped = new Proxy(
      { built: makeBuilt(fx, run), run },
      {
        getPrototypeOf() {
          calls += 1;
          throw new Error('trap');
        },
        ownKeys() {
          calls += 1;
          throw new Error('trap');
        },
      }
    );
    expect(buildSpansExecutionEnvelope(trapped).ok).toBe(false);
    expect(calls).toBe(0);

    const retained = storedArtifact(fx, envelope);
    const bindingResult = await bindingFor(fx, run, envelope);
    expect(bindingResult.ok).toBe(true);
    const status = await fx.admission.status();
    const builtWithAccessor = makeBuilt(fx, run);
    Object.defineProperty(builtWithAccessor.review, 'requiredCapabilities', {
      configurable: true,
      enumerable: true,
      get() {
        calls += 1;
        return ['launch'];
      },
    });
    expect(
      buildSpansExecutionReviewBinding({
        admissionLimits: status.limits,
        built: builtWithAccessor,
        definition: SPANS_EXEC_DEFAULT_PROFILES[PROFILE],
        inputArtifact: bindingResult.artifactInfo.inputArtifact,
      }).ok
    ).toBe(false);

    const trappedReadArgs = new Proxy(
      {
        artifact: retained.artifact,
        binding: bindingResult.binding,
      },
      {
        getPrototypeOf() {
          calls += 1;
          throw new Error('trap');
        },
        ownKeys() {
          calls += 1;
          throw new Error('trap');
        },
      }
    );
    expect(readSpansExecutionRequest(trappedReadArgs).ok).toBe(false);
    expect(calls).toBe(0);
  });
});

describe('buildSpansExecutionReviewBinding', () => {
  test('keeps the current profile ceilings, policy values, and trusted admission limits', async () => {
    fx = createExecutionFixture();
    const run = readyRun(fx);
    const status = await fx.admission.status();
    let retainedInputArtifact;

    for (const [profile, definition, boundary] of [
      [PROFILE, SPANS_EXEC_DEFAULT_PROFILES[PROFILE], 60 * 60 * 1000],
      [LUNA_PROFILE, LUNA_DEFINITION, 30 * 60 * 1000],
    ]) {
      const built = makeBuilt(fx, run, { profile, wallClockMs: boundary });
      const envelope = makeEnvelope(fx, run, {
        profile,
        wallClockMs: boundary,
      });
      expect(envelope).toMatchObject({ ok: true });
      const artifact = storedArtifact(fx, envelope);
      retainedInputArtifact ??= artifact.inputArtifact;
      const result = buildSpansExecutionReviewBinding({
        admissionLimits: status.limits,
        built,
        definition,
        inputArtifact: artifact.inputArtifact,
      });
      expect(result.ok).toBe(true);
      expect(result.binding.policy).toEqual(
        SPANS_EXECUTION_REVIEW_PROFILES[profile].policy
      );
      expect(result.binding.admission.policyDigest).toMatch(DIGEST_PATTERN);
      expect(result.binding.profile).toMatchObject({ id: profile });
      expect(result.binding.digests).toEqual({
        dependencies: digestOf(result.binding.checkout.expected.dependency),
        dirty: result.binding.checkout.expected.dirty.hash,
        head: sha256(result.binding.checkout.expected.head),
        lockfile: result.binding.checkout.expected.dependency.lockfileHash,
      });
      expect(result.binding.targetDigest).toBe(
        built.dispatchRequest.targetDigest
      );
    }

    const over = makeBuilt(fx, run, { wallClockMs: 60 * 60 * 1000 + 1 });
    expect(
      buildSpansExecutionReviewBinding({
        admissionLimits: status.limits,
        built: over,
        definition: SPANS_EXEC_DEFAULT_PROFILES[PROFILE],
        inputArtifact: retainedInputArtifact,
      }).ok
    ).toBe(false);

    const lunaOver = makeBuilt(fx, run, {
      profile: LUNA_PROFILE,
      wallClockMs: 30 * 60 * 1000 + 1,
    });
    expect(
      buildSpansExecutionReviewBinding({
        admissionLimits: status.limits,
        built: lunaOver,
        definition: LUNA_DEFINITION,
        inputArtifact: retainedInputArtifact,
      }).ok
    ).toBe(false);
  });

  test('rejects unknown profiles and metered definitions', async () => {
    fx = createExecutionFixture();
    const run = readyRun(fx);
    const status = await fx.admission.status();
    const unknown = makeBuilt(fx, run, { profile: 'future-profile' });
    const unknownEnvelope = makeEnvelope(fx, run, {
      profile: 'future-profile',
    });
    expect(unknownEnvelope.ok).toBe(false);

    const envelope = makeEnvelope(fx, run);
    const artifact = storedArtifact(fx, envelope);
    expect(
      buildSpansExecutionReviewBinding({
        admissionLimits: status.limits,
        built: unknown,
        definition: SPANS_EXEC_DEFAULT_PROFILES[PROFILE],
        inputArtifact: artifact.inputArtifact,
      }).ok
    ).toBe(false);

    const metered = makeBuilt(fx, run);
    expect(
      buildSpansExecutionReviewBinding({
        admissionLimits: status.limits,
        built: metered,
        definition: {
          ...SPANS_EXEC_DEFAULT_PROFILES[PROFILE],
          billing: 'metered',
        },
        inputArtifact: artifact.inputArtifact,
      }).ok
    ).toBe(false);
  });
});

describe('versioned installed-dependency execution bindings', () => {
  test('binds the Setu receipt and input digest without inventing a zero-dependency lock hash', async () => {
    fx = createExecutionFixture();
    const run = readyRun(fx);
    const expected = makeExpected(fx);
    expected.dependency = {
      inputDigest: '1'.repeat(64),
      receiptDigest: '2'.repeat(64),
      version: 2,
    };
    const envelope = makeEnvelope(fx, run, { expected });
    expect(envelope.ok).toBe(true);
    const result = await bindingFor(fx, run, envelope, { expected });
    expect(result.ok).toBe(true);
    expect(result.binding.checkout.expected.dependency).toEqual(
      expected.dependency
    );
    expect(result.binding.digests.dependencies).toBe(
      digestOf(expected.dependency)
    );
    expect(Object.hasOwn(result.binding.digests, 'lockfile')).toBe(false);
    const reviews = createSpansExecutionReviews({
      resolveBinding: async () => result.binding,
      store: fx.store,
      verifyWritable: async () => true,
    });
    const prepared = await reviews.prepare(selectorFor(run));
    expect(prepared.ok).toBe(true);
    result.binding.digests.dependencies = '3'.repeat(64);
    expect((await reviews.prepare(selectorFor(run))).ok).toBe(false);
  });

  test('refuses a receipt binding whose dependency digest disagrees with its identity', async () => {
    fx = createExecutionFixture();
    const run = readyRun(fx);
    const expected = makeExpected(fx);
    expected.dependency = {
      inputDigest: '1'.repeat(64),
      receiptDigest: '2'.repeat(64),
      version: 2,
    };
    const envelope = makeEnvelope(fx, run, { expected });
    const result = await bindingFor(fx, run, envelope, { expected });
    expect(result.ok).toBe(true);
    result.binding.digests.dependencies = '3'.repeat(64);
    const reviews = createSpansExecutionReviews({
      resolveBinding: async () => result.binding,
      store: fx.store,
      verifyWritable: async () => true,
    });
    expect((await reviews.prepare(selectorFor(run))).ok).toBe(false);
  });

  test('changes the exact target binding when a successful setup receipt changes', () => {
    fx = createExecutionFixture();
    const expected = makeExpected(fx);
    expected.dependency = {
      inputDigest: '1'.repeat(64),
      receiptDigest: '2'.repeat(64),
      version: 2,
    };
    const before = targetDigestFor(expected);
    expect(before).toMatch(DIGEST_PATTERN);
    expected.dependency.receiptDigest = '3'.repeat(64);
    const after = targetDigestFor(expected);
    expect(after).toMatch(DIGEST_PATTERN);
    expect(after).not.toBe(before);
    expected.dependency.lockfileHash = '4'.repeat(64);
    expect(targetDigestFor(expected)).toBeNull();
  });
});
