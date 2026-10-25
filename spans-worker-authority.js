import { realpathSync, statSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { types as utilTypes } from 'node:util';
import { checkoutFingerprint } from './checkout-identity.js';
import { createSetupProgress } from './setup-progress.js';
import { createSpansArtifacts } from './spans-artifacts.js';
import { parseSpansDependencyBinding } from './spans-dependency-binding.js';
import {
  createCheckoutAdapter,
  createDependencyAdapter,
} from './spans-execution-adapters.js';
import { readSpansExecutionRequest } from './spans-execution-binding.js';
import { createSpansCapability } from './spans-execution-capability.js';
import {
  canonicalJson,
  digestOf,
  isRecord,
  sha256,
  spansExecutionInputDigest,
} from './spans-execution-core.js';
import { buildSpansExecutionInput } from './spans-execution-input.js';
import {
  launchModeOf,
  SPANS_EXEC_DEFAULT_PROFILES,
} from './spans-execution-provider.js';
import {
  createSpansExecutionReviews,
  SPANS_EXECUTION_REVIEW_PROFILES,
} from './spans-execution-review.js';
import { observeTree as observeSpansTree } from './spans-execution-verifier.js';
import { createWorkspaceState } from './workspace-state.js';

const REFERENCE_KEYS = ['approvalDigest', 'reviewDigest', 'runId'];
const SELECTOR_KEYS = [
  'actionId',
  'attemptId',
  'generation',
  'planVersion',
  'runId',
  'spanId',
];
const CAPTURE_KEYS = [
  'actionId',
  'attemptId',
  'generation',
  'runId',
  'spanId',
  'workerId',
];
const START_KEYS = [...CAPTURE_KEYS, 'deadlineMs'];
const DIGEST = /^[a-f0-9]{64}$/;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const REFUSAL = Object.freeze({
  code: 'EXECUTION_REVIEW_REFUSED',
  ok: false,
});
const HEAD = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;

function exactDataRecord(value, keys) {
  if (
    !isRecord(value) ||
    utilTypes.isProxy(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value))
  ) {
    return null;
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (
    Reflect.ownKeys(descriptors).length !== keys.length ||
    keys.some(
      (key) =>
        !(
          Object.hasOwn(descriptors, key) &&
          Object.hasOwn(descriptors[key], 'value') &&
          descriptors[key].enumerable
        )
    )
  ) {
    return null;
  }
  return Object.fromEntries(keys.map((key) => [key, descriptors[key].value]));
}

export function snapshotSpansWorkerExecutionReview(value) {
  const reference = exactDataRecord(value, REFERENCE_KEYS);
  if (
    !reference ||
    typeof reference.runId !== 'string' ||
    !ID.test(reference.runId) ||
    typeof reference.reviewDigest !== 'string' ||
    !DIGEST.test(reference.reviewDigest) ||
    typeof reference.approvalDigest !== 'string' ||
    !DIGEST.test(reference.approvalDigest)
  ) {
    return null;
  }
  return Object.freeze(reference);
}

export function sameSpansWorkerExecutionReview(left, right) {
  return Boolean(REFERENCE_KEYS.every((key) => left?.[key] === right?.[key]));
}

function matchesCaptureBinding(value, binding, requireWorkerId = false) {
  return (
    isRecord(value) &&
    CAPTURE_KEYS.filter((key) => key !== 'workerId').every((key) =>
      Object.hasOwn(binding ?? {}, key) ? value[key] === binding[key] : true
    ) &&
    (value.workerId === undefined || value.workerId === binding?.workerId) &&
    (!requireWorkerId || value.workerId === binding?.workerId)
  );
}

function sameCanonical(left, right) {
  try {
    return canonicalJson(left) === canonicalJson(right);
  } catch {
    return false;
  }
}

function exactStart(value, binding) {
  const start = exactDataRecord(value, START_KEYS);
  return Boolean(
    start &&
      CAPTURE_KEYS.filter(
        (key) => key !== 'workerId' || binding?.workerId !== undefined
      ).every((key) => start[key] === binding?.[key]) &&
      Number.isSafeInteger(start.deadlineMs) &&
      start.deadlineMs > 0
  );
}

function validExpectedCheckout(expected, digests) {
  const dependency = parseSpansDependencyBinding(expected?.dependency);
  return Boolean(
    isRecord(expected) &&
      isRecord(expected.identity) &&
      expected.identity.known === true &&
      isRecord(expected.dirty) &&
      Number.isSafeInteger(expected.dirty.count) &&
      expected.dirty.count >= 0 &&
      DIGEST.test(expected.dirty.hash) &&
      typeof expected.head === 'string' &&
      HEAD.test(expected.head) &&
      dependency &&
      isRecord(digests) &&
      digests.dependencies === digestOf(dependency) &&
      digests.dirty === expected.dirty.hash &&
      digests.head ===
        (expected.head.length === 40 ? sha256(expected.head) : expected.head) &&
      (dependency.version === 2
        ? !Object.hasOwn(digests, 'lockfile')
        : digests.lockfile === dependency.lockfileHash)
  );
}

function defaultDependencyAdapter(admissionContext) {
  const resourcePaths = {
    configPath: admissionContext?.configPath,
    setuDir: admissionContext?.setuDir,
    workspaceRoot: admissionContext?.workspaceRoot,
  };
  if (
    !Object.values(resourcePaths).every(
      (path) =>
        typeof path === 'string' && isAbsolute(path) && resolve(path) === path
    )
  ) {
    return { observe: async () => ({ ok: false }) };
  }
  try {
    const state = createWorkspaceState(resourcePaths);
    const setupProgress = createSetupProgress({ state });
    return createDependencyAdapter({ resourcePaths, setupProgress, state });
  } catch {
    return { observe: async () => ({ ok: false }) };
  }
}

function launchProofKey(binding, reviewBinding, dependency, executionReview) {
  const capture = exactDataRecord(binding, CAPTURE_KEYS);
  if (
    !capture ||
    CAPTURE_KEYS.some((key) => capture[key] === undefined) ||
    dependency?.version !== 2
  ) {
    return null;
  }
  try {
    return canonicalJson({
      approvalDigest: executionReview.approvalDigest,
      capture,
      checkoutIdentity: reviewBinding.checkout.expected.identity,
      dependency,
      reviewDigest: executionReview.reviewDigest,
      runId: executionReview.runId,
      target: reviewBinding.target,
      wtDir: reviewBinding.checkout.wtDir,
    });
  } catch {
    return null;
  }
}

function matchesCheckoutObservation(checkout, execution, expected) {
  return (
    checkout?.ok === true &&
    sameCanonical(checkout.identity, execution.checkoutIdentity) &&
    sameCanonical(checkout.identity, expected.identity) &&
    checkout.head === expected.head &&
    sameCanonical(checkout.dirty, expected.dirty)
  );
}

function currentDependencyProof(dependency, expected) {
  if (
    dependency?.ok !== true ||
    typeof dependency.checkCurrent !== 'function'
  ) {
    return null;
  }
  const identity = parseSpansDependencyBinding(dependency.identity);
  if (identity?.version !== 2 || !sameCanonical(identity, expected)) {
    return null;
  }
  return { checkCurrent: dependency.checkCurrent, identity };
}

function matchesTreeObservation(tree, head, baselineTree) {
  return (
    tree?.ok === true && tree.head === head && tree.digest === baselineTree
  );
}

function validSavedExecution({
  capability,
  execution,
  executionLimits,
  executionReview,
  executionStart,
  leaseBinding,
  read,
  retained,
  reviewBinding,
  source,
}) {
  if (
    !isRecord(execution) ||
    execution.runId !== leaseBinding.runId ||
    execution.actionId !== leaseBinding.actionId ||
    execution.attemptId !== leaseBinding.attemptId ||
    execution.spanId !== leaseBinding.spanId ||
    typeof execution.inputDigest !== 'string' ||
    !DIGEST.test(execution.inputDigest) ||
    spansExecutionInputDigest(execution) !== execution.inputDigest ||
    execution.approvalDigest !== executionReview.approvalDigest ||
    digestOf(execution.approval) !== executionReview.approvalDigest ||
    !isRecord(execution.reviewRef) ||
    Reflect.ownKeys(execution.reviewRef).length !== 2 ||
    execution.reviewRef.runId !== executionReview.runId ||
    execution.reviewRef.reviewDigest !== executionReview.reviewDigest ||
    !isRecord(execution.reviewSelector) ||
    Reflect.ownKeys(execution.reviewSelector).length !== SELECTOR_KEYS.length ||
    !SELECTOR_KEYS.every((key) =>
      Object.hasOwn(execution.reviewSelector, key)
    ) ||
    !matchesCaptureBinding(execution.reviewSelector, leaseBinding) ||
    execution.reviewSelector.planVersion !== read.view.planVersion ||
    !isRecord(execution.inputArtifact) ||
    !isRecord(reviewBinding) ||
    reviewBinding.generation !== read.generation ||
    reviewBinding.planVersion !== read.view.planVersion ||
    !matchesCaptureBinding(reviewBinding, leaseBinding) ||
    !sameCanonical(execution.inputArtifact, reviewBinding.inputArtifact) ||
    !sameCanonical(execution.target, reviewBinding.target) ||
    !sameCanonical(leaseBinding.target, reviewBinding.target) ||
    execution.profile !== reviewBinding.profile?.id ||
    execution.profile !== retained.profile ||
    !sameCanonical(execution.target, retained.target) ||
    source.cwd !== reviewBinding.checkout?.wtDir ||
    execution.instructions !== retained.instructions ||
    !sameCanonical(execution.criteria, retained.criteria) ||
    execution.requireChange !== retained.requireChange ||
    execution.wallClockMs !== retained.wallClockMs ||
    executionStart.deadlineMs !== execution.wallClockMs ||
    executionStart.deadlineMs !== retained.wallClockMs ||
    executionStart.deadlineMs > executionLimits.maxDeadlineMs ||
    executionStart.deadlineMs > reviewBinding.policy?.attemptTimeoutMs ||
    !isRecord(execution.launchMode) ||
    execution.billing !== capability.definition.billing ||
    !sameCanonical(execution.launchMode, launchModeOf(capability.definition)) ||
    !validExpectedCheckout(
      reviewBinding.checkout?.expected,
      reviewBinding.digests
    ) ||
    !sameCanonical(
      execution.checkoutIdentity,
      reviewBinding.checkout.expected.identity
    ) ||
    typeof reviewBinding.checkout?.repoDir !== 'string' ||
    typeof reviewBinding.checkout?.wtDir !== 'string' ||
    reviewBinding.checkout.wtDir !== execution.checkoutIdentity.checkoutPath ||
    reviewBinding.checkout.repoDir !==
      execution.checkoutIdentity.repositoryPath ||
    typeof execution.baselineTree !== 'string' ||
    !DIGEST.test(execution.baselineTree)
  ) {
    return false;
  }
  if (
    retained.budgetUsd === undefined
      ? execution.budgetMicro !== null
      : execution.budgetMicro !== Math.round(retained.budgetUsd * 1_000_000)
  ) {
    return false;
  }
  const approvedCapabilities = new Set(capability.proof.verified);
  return (
    Array.isArray(reviewBinding.requiredCapabilities) &&
    reviewBinding.requiredCapabilities.length > 0 &&
    reviewBinding.requiredCapabilities.every((name) =>
      approvedCapabilities.has(name)
    ) &&
    capability.proof.profile.id === execution.profile &&
    capability.proof.profile.digest === reviewBinding.profile?.digest
  );
}

/**
 * The descriptor gives this guard one exact execution and start tuple. The
 * asynchronous checkout proof runs before the attempt transaction. The final
 * `checkLaunch` is synchronous for the actual launcher effect.
 */
export function createSpansWorkerAuthority({
  admissionContext,
  checkoutAdapter = createCheckoutAdapter(),
  dependencyAdapter: suppliedDependencyAdapter,
  executionLimits,
  executionReview: rawExecutionReview,
  executionStart,
  now = Date.now,
  observeTree = observeSpansTree,
  root,
  source,
  store,
} = {}) {
  const dependencyAdapter =
    suppliedDependencyAdapter ?? defaultDependencyAdapter(admissionContext);
  const executionReview =
    snapshotSpansWorkerExecutionReview(rawExecutionReview);
  const leaseBinding = admissionContext?.lease?.spansBinding;
  const configured = Boolean(
    executionReview &&
      typeof root === 'string' &&
      isRecord(source) &&
      typeof source.stdin === 'string' &&
      typeof source.cwd === 'string' &&
      isRecord(executionLimits) &&
      Number.isSafeInteger(executionLimits.maxDeadlineMs) &&
      executionLimits.maxDeadlineMs > 0 &&
      exactStart(executionStart, leaseBinding) &&
      isRecord(leaseBinding) &&
      isRecord(store) &&
      typeof store.readRun === 'function' &&
      typeof store.getEventById === 'function' &&
      typeof store.commitRun === 'function' &&
      typeof store.readCache === 'function' &&
      typeof checkoutAdapter?.observe === 'function' &&
      typeof dependencyAdapter?.observe === 'function' &&
      typeof observeTree === 'function' &&
      typeof now === 'function'
  );
  const artifacts = configured ? createSpansArtifacts({ root }) : null;
  // This verifier only reads the existing cache. No probe or provider action
  // is exposed to the capture child.
  const capability = configured
    ? createSpansCapability({
        now,
        profiles: SPANS_EXEC_DEFAULT_PROFILES,
        store,
      })
    : null;
  // The dummy verifier only satisfies the primitive's configuration check.
  // This capture guard never exposes authorize() or calls that verifier.
  const checkApprovalCurrent = configured
    ? createSpansExecutionReviews({
        store,
        verifyConfirmation: () => null,
      }).checkApprovalCurrent
    : null;
  let preflightRevision = 0;
  let cachedLaunchProof = null;

  function loadCurrent(binding) {
    try {
      if (
        !configured ||
        executionReview.runId !== binding?.runId ||
        executionReview.runId !== leaseBinding.runId ||
        !matchesCaptureBinding(leaseBinding, binding) ||
        !exactStart(executionStart, binding) ||
        leaseBinding.target === undefined ||
        admissionContext.lease.spansArchiveReservation?.root !== root
      ) {
        return null;
      }
      const read = store.readRun({ runId: executionReview.runId });
      if (
        read?.ok !== true ||
        read.generation !== binding.generation ||
        read.view?.readOnly === true ||
        read.view?.imported === true ||
        read.view?.kind === 'imported' ||
        read.view?.state === 'imported' ||
        read.view?.sourceId !== undefined
      ) {
        return null;
      }
      const execution = read.view.executions?.[binding.actionId];
      const review =
        read.view.execution?.reviews?.[executionReview.reviewDigest];
      const reviewBinding = review?.binding;
      const definition = SPANS_EXEC_DEFAULT_PROFILES[execution?.profile];
      const reviewProfile = SPANS_EXECUTION_REVIEW_PROFILES[execution?.profile];
      if (
        !(definition && reviewProfile) ||
        review?.reviewDigest !== executionReview.reviewDigest ||
        !isRecord(reviewBinding) ||
        !matchesCaptureBinding(reviewBinding, binding) ||
        !sameCanonical(reviewBinding.policy, reviewProfile.policy) ||
        !sameCanonical(reviewBinding.profile, {
          digest: reviewBinding.profile?.digest,
          effort: definition.effort,
          id: execution?.profile,
          model: definition.model,
          provider: definition.provider,
        })
      ) {
        return null;
      }
      const proof = capability.verify({ profile: execution.profile });
      if (proof?.ok !== true) {
        return null;
      }
      const artifact = artifacts.read({
        artifactId: reviewBinding.inputArtifact?.id,
      });
      const retained = readSpansExecutionRequest({
        artifact,
        binding: reviewBinding,
      });
      const currentInput = buildSpansExecutionInput({
        run: read,
        selector: execution?.reviewSelector,
      });
      if (
        artifact.ok !== true ||
        artifact.mediaType !== 'application/json' ||
        artifact.text !== source.stdin ||
        retained.ok !== true ||
        currentInput.ok !== true ||
        canonicalJson(JSON.parse(artifact.text).context) !==
          currentInput.text ||
        !validSavedExecution({
          capability: { definition, proof },
          execution,
          executionLimits,
          executionReview,
          executionStart,
          leaseBinding,
          read,
          retained: retained.request,
          reviewBinding,
          source,
        })
      ) {
        return null;
      }
      const checkoutPath = reviewBinding.checkout.wtDir;
      const identity = execution.checkoutIdentity;
      if (
        realpathSync(checkoutPath) !== checkoutPath ||
        realpathSync(reviewBinding.checkout.repoDir) !==
          reviewBinding.checkout.repoDir ||
        !sameCanonical(
          checkoutFingerprint(statSync(checkoutPath, { bigint: true })),
          identity.checkout
        )
      ) {
        return null;
      }
      return { execution, reviewBinding };
    } catch {
      return null;
    }
  }

  function currentApproval(execution) {
    try {
      const selector = {
        ...execution.reviewSelector,
        reviewDigest: executionReview.reviewDigest,
      };
      return checkApprovalCurrent(selector, execution.approval);
    } catch {
      return REFUSAL;
    }
  }

  function currentWithApproval(binding) {
    const current = loadCurrent(binding);
    if (!current) {
      return null;
    }
    const approval = currentApproval(current.execution);
    return approval?.ok === true && approval.current === true ? current : null;
  }

  function checkCurrent(binding) {
    return currentWithApproval(binding) ? { ok: true } : REFUSAL;
  }

  function checkLaunch(binding) {
    const proof = cachedLaunchProof;
    cachedLaunchProof = null;
    if (!proof) {
      return REFUSAL;
    }
    const before = loadCurrent(binding);
    const beforeDependency = parseSpansDependencyBinding(
      before?.reviewBinding?.checkout?.expected?.dependency
    );
    const beforeKey =
      before &&
      beforeDependency?.version === 2 &&
      launchProofKey(
        binding,
        before.reviewBinding,
        beforeDependency,
        executionReview
      );
    if (
      !(before && beforeKey) ||
      proof.key !== beforeKey ||
      proof.revision !== preflightRevision
    ) {
      return REFUSAL;
    }
    let currentProof;
    try {
      currentProof = proof.checkCurrent();
    } catch {
      return REFUSAL;
    }
    if (currentProof !== true) {
      return REFUSAL;
    }
    // The filesystem validator runs first; durable approval, revocation,
    // retained input and checkout identity are re-read last before launch.
    const current = loadCurrent(binding);
    const currentDependency = parseSpansDependencyBinding(
      current?.reviewBinding?.checkout?.expected?.dependency
    );
    const currentKey =
      current &&
      currentDependency?.version === 2 &&
      launchProofKey(
        binding,
        current.reviewBinding,
        currentDependency,
        executionReview
      );
    if (!current || currentKey !== proof.key) {
      return REFUSAL;
    }
    const approval = currentApproval(current.execution);
    return approval?.ok === true && approval.current === true
      ? { ok: true }
      : REFUSAL;
  }

  async function checkPreflight(binding) {
    preflightRevision += 1;
    const revision = preflightRevision;
    cachedLaunchProof = null;
    const current = currentWithApproval(binding);
    if (!current) {
      return REFUSAL;
    }
    try {
      const { execution, reviewBinding } = current;
      const { repoDir, wtDir, expected } = reviewBinding.checkout;
      const expectedDependency = parseSpansDependencyBinding(
        expected.dependency
      );
      if (expectedDependency?.version !== 2) {
        return REFUSAL;
      }
      const checkout = await checkoutAdapter.observe({ repoDir, wtDir });
      if (!matchesCheckoutObservation(checkout, execution, expected)) {
        return REFUSAL;
      }
      const [dependency, tree] = await Promise.all([
        dependencyAdapter.observe({
          checkoutIdentity: structuredClone(checkout.identity),
          target: structuredClone(reviewBinding.target),
          wtDir,
        }),
        observeTree(wtDir),
      ]);
      const dependencyProof = currentDependencyProof(
        dependency,
        expectedDependency
      );
      if (
        !(
          dependencyProof &&
          matchesTreeObservation(tree, expected.head, execution.baselineTree)
        )
      ) {
        return REFUSAL;
      }
      const key = launchProofKey(
        binding,
        reviewBinding,
        dependencyProof.identity,
        executionReview
      );
      if (!key) {
        return REFUSAL;
      }
      let dependencyCurrent;
      try {
        dependencyCurrent = dependencyProof.checkCurrent();
      } catch {
        return REFUSAL;
      }
      if (dependencyCurrent !== true) {
        return REFUSAL;
      }
      const finalCurrent = currentWithApproval(binding);
      if (!(finalCurrent && revision === preflightRevision)) {
        return REFUSAL;
      }
      cachedLaunchProof = {
        checkCurrent: dependencyProof.checkCurrent,
        key,
        revision,
      };
      return { ok: true };
    } catch {
      return REFUSAL;
    }
  }

  return Object.freeze({ checkCurrent, checkLaunch, checkPreflight });
}
