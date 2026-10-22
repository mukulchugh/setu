import { expect, test } from 'bun:test';
import {
  applyDependencyFilesBody,
  changeDependencyFilePage,
  createDependencyActionGuard,
  dependencyFileOperationFrom,
  dependencyFilePage,
  dependencyFileRoutes,
  dependencyFileSnapshot,
  dependencyOperationPanelState,
  dependencyOutcomeUnknown,
  dependencyPlanConfirmation,
  dependencyPlanReviewKey,
  dependencyReleaseConfirmation,
  dependencyReleaseResumeReviewKey,
  dependencyReleaseReviewKey,
  dependencyResumeReviewKey,
  dependencyStatusAllowsNewPlan,
  parseDependencyReleasePlan,
  parseHoistedDependencyPlan,
  prepareDependencyReleaseBody,
  recoverDependencyFilesBody,
  releaseDependencyFilesBody,
  resumeDependencyFilesBody,
  resumeDependencyReleaseBody,
} from './portal/dependency-file-state';

const target = { name: 'feat/hoisted-store', repo: 'setu/demo' };
const digest = (letter: string) => letter.repeat(64);

test('the review accepts current and legacy plans and refuses unsupported versions', () => {
  for (const version of [1, 2]) {
    expect(
      parseHoistedDependencyPlan(hoistedPlan({ version }), target)
    ).not.toBeNull();
  }
  for (const version of [0, 3, '2', null]) {
    expect(
      parseHoistedDependencyPlan(hoistedPlan({ version }), target)
    ).toBeNull();
  }
});

test('dependency file pages keep every boundary reachable and reset or clamp on identity changes', () => {
  const pageSize = 100;
  const identity = 'repo\0target-a\0plan\0plan-a';
  const first = dependencyFilePage(
    { identity: '', page: 0 },
    identity,
    250_000,
    pageSize
  );
  expect(first).toMatchObject({ end: 100, page: 0, pageCount: 2500, start: 0 });

  const lastState = changeDependencyFilePage(
    { identity, page: 0 },
    identity,
    250_000,
    pageSize,
    2499
  );
  expect(
    dependencyFilePage(lastState, identity, 250_000, pageSize)
  ).toMatchObject({
    end: 250_000,
    page: 2499,
    pageCount: 2500,
    start: 249_900,
  });

  const nextPlan = dependencyFilePage(
    lastState,
    'repo\0target-a\0plan\0plan-b',
    250_000,
    pageSize
  );
  expect(nextPlan).toMatchObject({ end: 100, page: 0, start: 0 });

  const nextTarget = dependencyFilePage(
    lastState,
    'repo\0target-b\0plan\0plan-a',
    120,
    pageSize
  );
  expect(nextTarget).toMatchObject({ end: 100, page: 0, start: 0 });

  expect(dependencyFilePage(lastState, identity, 120, pageSize)).toMatchObject({
    end: 120,
    page: 1,
    pageCount: 2,
    start: 100,
  });
});

function hoistedPlan(overrides: Record<string, unknown> = {}) {
  return {
    ok: true,
    plan: {
      createdAt: 10,
      files: [
        {
          fingerprint: { identityHash: digest('b'), size: 4096 },
          index: 0,
          objectKey: digest('c'),
          relativePath: 'node_modules/pkg/index.js',
          temporaryRelativePath: 'node_modules/pkg/.setu-stage-1',
        },
      ],
      head: digest('d'),
      id: digest('a'),
      inputDigest: digest('e'),
      lockfileHash: digest('f'),
      logicalCloneBytes: 4096,
      mode: 'hoisted-cow',
      name: target.name,
      physicalSavingsBytes: null,
      repo: target.repo,
      skipped: [
        {
          reason: 'Metadata did not match',
          relativePath: 'node_modules/pkg/native.node',
        },
      ],
      storeIdentity: { device: '1', id: 'store-1' },
      version: 1,
      ...overrides,
    },
  };
}

function releasePlan(overrides: Record<string, unknown> = {}) {
  return {
    ok: true,
    releasePlan: {
      files: [
        {
          installedFingerprint: { identityHash: digest('8'), size: 4096 },
          relativePath: 'node_modules/pkg/index.js',
          retainedFingerprint: { identityHash: digest('9'), size: 4096 },
        },
      ],
      id: digest('7'),
      name: target.name,
      operationId: digest('a'),
      repo: target.repo,
      version: 1,
      ...overrides,
    },
  };
}

test('a hoisted plan is accepted only when it is a complete, target-bound server review', () => {
  const plan = parseHoistedDependencyPlan(hoistedPlan(), target);
  expect(plan).toMatchObject({
    files: [
      {
        fingerprint: { identityHash: digest('b'), size: 4096 },
        relativePath: 'node_modules/pkg/index.js',
      },
    ],
    id: digest('a'),
    logicalCloneBytes: 4096,
    mode: 'hoisted-cow',
    physicalSavingsBytes: null,
    skipped: [
      {
        reason: 'Metadata did not match',
        relativePath: 'node_modules/pkg/native.node',
      },
    ],
  });
  expect(
    parseHoistedDependencyPlan(hoistedPlan(), { ...target, name: 'other' })
  ).toBeNull();
  const escapingPlan = hoistedPlan();
  const escapingSource = escapingPlan.plan as Record<string, unknown>;
  const escapingFiles = escapingSource.files as Record<string, unknown>[];
  expect(
    parseHoistedDependencyPlan(
      {
        ...escapingPlan,
        plan: {
          ...escapingSource,
          files: [{ ...escapingFiles[0], relativePath: '../escape' }],
        },
      },
      target
    )
  ).toBeNull();
  expect(
    parseHoistedDependencyPlan(
      hoistedPlan({ physicalSavingsBytes: 4096 }),
      target
    )
  ).toBeNull();
  expect(
    parseHoistedDependencyPlan(hoistedPlan({ files: [] }), target)
  ).toBeNull();
});

test('a delayed request cannot clear the new target action or its pending review', () => {
  const guard = createDependencyActionGuard();
  const firstTarget = `${target.repo}\0${target.name}`;
  const secondTarget = `${target.repo}\0another-branch`;
  let pending = { action: 'prepare', targetKey: firstTarget };
  let review = 'review for another-branch';
  let refreshes = 0;

  guard.targetChanged(firstTarget);
  const previousAction = guard.begin(firstTarget);
  guard.targetChanged(secondTarget);
  pending = { action: 'apply', targetKey: secondTarget };
  review = 'current apply review';
  const currentAction = guard.begin(secondTarget);

  if (guard.isCurrent(previousAction, firstTarget)) {
    pending = { action: '', targetKey: firstTarget };
    review = '';
    refreshes += 1;
  }
  expect(guard.isCurrent(previousAction, firstTarget)).toBeFalse();
  expect(pending).toEqual({ action: 'apply', targetKey: secondTarget });
  expect(review).toBe('current apply review');
  expect(refreshes).toBe(0);
  expect(guard.isCurrent(currentAction, secondTarget)).toBeTrue();
});

test('apply confirmation follows the displayed plan and carries the same durable operation identity', () => {
  const plan = parseHoistedDependencyPlan(hoistedPlan(), target);
  expect(plan).not.toBeNull();
  if (!plan) {
    return;
  }
  const reviewKey = dependencyPlanReviewKey(plan, target);
  expect(dependencyPlanConfirmation(plan, target, reviewKey)).toBe(plan.id);
  expect(
    dependencyPlanConfirmation(plan, target, `${reviewKey}:changed`)
  ).toBeNull();
  expect(
    dependencyPlanConfirmation(plan, { ...target, repo: 'other' }, reviewKey)
  ).toBeNull();
  expect(
    applyDependencyFilesBody(target, plan, `${reviewKey}:changed`)
  ).toBeNull();
  expect(applyDependencyFilesBody(target, plan, reviewKey)).toEqual({
    confirmation: plan.id,
    name: target.name,
    operationId: plan.id,
    planId: plan.id,
    repo: target.repo,
  });

  const changedPlan = parseHoistedDependencyPlan(
    hoistedPlan({
      skipped: [
        {
          reason: 'Different reason',
          relativePath: 'node_modules/pkg/native.node',
        },
      ],
    }),
    target
  );
  expect(changedPlan).not.toBeNull();
  expect(changedPlan && dependencyPlanReviewKey(changedPlan, target)).not.toBe(
    reviewKey
  );
});

test('release review binds target, operation, retained files and both file identities', () => {
  const release = parseDependencyReleasePlan(
    releasePlan(),
    target,
    digest('a')
  );
  expect(release).toMatchObject({
    files: [
      {
        fingerprints: [
          {
            identityHash: digest('8'),
            label: 'installedFingerprint',
            size: 4096,
          },
          {
            identityHash: digest('9'),
            label: 'retainedFingerprint',
            size: 4096,
          },
        ],
        relativePath: 'node_modules/pkg/index.js',
      },
    ],
    id: digest('7'),
    operationId: digest('a'),
  });
  expect(
    parseDependencyReleasePlan(
      releasePlan(),
      { ...target, repo: 'other' },
      digest('a')
    )
  ).toBeNull();
  expect(
    parseDependencyReleasePlan(releasePlan(), target, digest('0'))
  ).toBeNull();
  expect(
    parseDependencyReleasePlan(
      releasePlan({ files: [{ relativePath: 'node_modules/pkg/index.js' }] }),
      target,
      digest('a')
    )
  ).toBeNull();

  if (!release) {
    return;
  }
  const reviewKey = dependencyReleaseReviewKey(release, target);
  expect(dependencyReleaseConfirmation(release, target, reviewKey)).toBe(
    release.id
  );
  expect(
    dependencyReleaseConfirmation(release, target, `${reviewKey}:changed`)
  ).toBeNull();
  expect(releaseDependencyFilesBody(target, release, reviewKey)).toEqual({
    confirmation: release.id,
    name: target.name,
    releaseId: release.id,
    repo: target.repo,
  });
  expect(
    releaseDependencyFilesBody(target, release, `${reviewKey}:changed`)
  ).toBeNull();
});

test('all workflow calls use the fixed routes and reconciliation reuses the exact operation id', () => {
  expect(dependencyFileRoutes).toEqual({
    apply: '/api/dependency-sharing/apply',
    prepare: '/api/dependency-sharing/prepare',
    prepareRelease: '/api/dependency-sharing/prepare-release',
    recover: '/api/dependency-sharing/recover',
    release: '/api/dependency-sharing/release',
  });
  expect(recoverDependencyFilesBody(target, digest('a'))).toEqual({
    name: target.name,
    operationId: digest('a'),
    repo: target.repo,
  });
  expect(prepareDependencyReleaseBody(target, digest('a'))).toEqual({
    name: target.name,
    operationId: digest('a'),
    repo: target.repo,
  });
  expect(recoverDependencyFilesBody(target, null)).toBeNull();
  expect(prepareDependencyReleaseBody(target, null)).toBeNull();
  expect(
    dependencyOutcomeUnknown({
      networkUncertain: true,
      ok: false,
      operationId: digest('a'),
    })
  ).toBeTrue();
  expect(
    dependencyFileOperationFrom({
      ok: false,
      operation: { id: digest('a'), state: 'unknown' },
    })?.id
  ).toBe(digest('a'));
});

test('status displays only the target view and keeps logical progress separate from savings', () => {
  const status = dependencyFileSnapshot(
    {
      ok: true,
      views: [
        {
          dependencyFiles: {
            mode: 'hoisted-cow',
            native: { available: false, reason: 'Helper is unavailable.' },
            operation: {
              completedFiles: 2,
              id: digest('a'),
              logicalCloneBytes: 8192,
              mode: 'hoisted-cow',
              physicalSavingsBytes: null,
              retainedOriginalFiles: 2,
              state: 'partial',
              totalFiles: 4,
              updatedAt: 12,
            },
            skipped: [
              { reason: 'Unsafe metadata', relativePath: 'node_modules/pkg/x' },
            ],
            state: 'partial',
          },
          name: target.name,
          repo: target.repo,
        },
        {
          dependencyFiles: { mode: 'wrong-target', state: 'completed' },
          name: 'other',
          repo: target.repo,
        },
      ],
    },
    target
  );
  expect(status).toMatchObject({
    enrollmentState: 'partial',
    mode: 'hoisted-cow',
    native: { available: false },
    operation: {
      completedFiles: 2,
      id: digest('a'),
      logicalCloneBytes: 8192,
      physicalSavingsBytes: null,
      retainedOriginalFiles: 2,
      state: 'partial',
      totalFiles: 4,
    },
    skipped: [
      { reason: 'Unsafe metadata', relativePath: 'node_modules/pkg/x' },
    ],
  });
  expect(status.operation?.physicalSavingsBytes).toBeNull();
});

test('reads the assembled service envelope and its journal operation summaries', () => {
  const status = dependencyFileSnapshot(
    {
      ok: true,
      views: [
        {
          dependencyFileStatus: {
            native: { available: true },
            operations: [
              {
                completedFiles: 1,
                id: digest('a'),
                inputDigest: digest('b'),
                logicalCloneBytes: 8192,
                mode: 'hoisted-cow',
                name: target.name,
                physicalSavingsBytes: null,
                planId: digest('a'),
                repo: target.repo,
                retainedOriginalFiles: 1,
                state: 'running',
                totalFiles: 3,
                updatedAt: 20,
              },
            ],
            state: 'in-progress',
            views: [
              {
                completedFiles: 1,
                id: digest('a'),
                logicalCloneBytes: 8192,
                mode: 'hoisted-cow',
                name: target.name,
                physicalSavingsBytes: null,
                planId: digest('a'),
                repo: target.repo,
                retainedOriginalFiles: 1,
                state: 'running',
                totalFiles: 3,
                updatedAt: 20,
              },
            ],
          },
          name: target.name,
          repo: target.repo,
        },
      ],
    },
    target
  );
  expect(status).toMatchObject({
    mode: 'hoisted-cow',
    native: { available: true },
    operation: {
      completedFiles: 1,
      id: digest('a'),
      planId: digest('a'),
      retainedOriginalFiles: 1,
      state: 'running',
      totalFiles: 3,
    },
  });
});

test('nested status failures stay unknown, keep their code and reason, and retain known operation identity', () => {
  const operationId = digest('a');
  const status = dependencyFileSnapshot(
    {
      ok: true,
      views: [
        {
          dependencyFiles: {
            code: 'DEPENDENCY_FILE_JOURNAL_UNAVAILABLE',
            error: 'The dependency file journal could not be read.',
            ok: false,
            operation: {
              id: operationId,
              planId: operationId,
              resumable: true,
              state: 'completed',
            },
          },
          name: target.name,
          repo: target.repo,
        },
      ],
    },
    target
  );

  expect(status).toMatchObject({
    operation: {
      id: operationId,
      planId: operationId,
      resumable: true,
      state: 'completed',
    },
    reason: 'The dependency file journal could not be read.',
    statusFailure: {
      code: 'DEPENDENCY_FILE_JOURNAL_UNAVAILABLE',
      error: 'The dependency file journal could not be read.',
    },
  });
  expect(dependencyStatusAllowsNewPlan(status)).toBeFalse();
});

test('reconcile keeps checkpoint identity and resumes only the same plan or release', () => {
  const recovered = dependencyFileOperationFrom({
    files: [
      {
        phase: 'verified',
        relativePath: 'node_modules/pkg/index.js',
        temporaryRelativePath: 'node_modules/pkg/.setu-stage-a',
      },
      {
        phase: 'prepared',
        relativePath: 'node_modules/pkg/other.js',
        temporaryRelativePath: 'node_modules/pkg/.setu-stage-b',
      },
    ],
    operationId: digest('a'),
    planId: digest('a'),
    releaseId: digest('c'),
    resumable: true,
    state: 'partial',
  });
  expect(recovered).toMatchObject({
    files: [
      { phase: 'verified', relativePath: 'node_modules/pkg/index.js' },
      { phase: 'prepared', relativePath: 'node_modules/pkg/other.js' },
    ],
    id: digest('a'),
    planId: digest('a'),
    releaseId: digest('c'),
    resumable: true,
  });
  if (!recovered) {
    return;
  }
  const applyReview = dependencyResumeReviewKey(recovered, target);
  expect(applyReview).not.toBeNull();
  expect(resumeDependencyFilesBody(target, recovered, applyReview)).toEqual({
    confirmation: digest('a'),
    name: target.name,
    operationId: digest('a'),
    planId: digest('a'),
    repo: target.repo,
  });
  expect(
    resumeDependencyFilesBody(target, recovered, `${applyReview}:stale`)
  ).toBeNull();
  const releaseReview = dependencyReleaseResumeReviewKey(recovered, target);
  expect(resumeDependencyReleaseBody(target, recovered, releaseReview)).toEqual(
    {
      confirmation: digest('c'),
      name: target.name,
      releaseId: digest('c'),
      repo: target.repo,
    }
  );
  expect(
    resumeDependencyReleaseBody(target, recovered, `${releaseReview}:stale`)
  ).toBeNull();
});

test('completed resumable recovery keeps the exact Apply path and conflict observations', () => {
  const recovered = dependencyFileOperationFrom({
    files: [
      {
        phase: 'conflict',
        relativePath: 'node_modules/pkg/index.js',
        retainedFingerprint: {
          contentHash: digest('b'),
          identityHash: digest('c'),
          metadataHash: digest('d'),
          size: 4096,
        },
        targetFingerprint: {
          contentHash: digest('e'),
          identityHash: digest('f'),
          metadataHash: digest('1'),
          size: 8192,
        },
        temporaryRelativePath: 'node_modules/pkg/.setu-stage-a',
      },
    ],
    operationId: digest('a'),
    planId: digest('a'),
    resumable: true,
    state: 'completed',
  });
  expect(recovered?.files).toEqual([
    {
      phase: 'conflict',
      relativePath: 'node_modules/pkg/index.js',
      retainedFingerprint: {
        contentHash: digest('b'),
        identityHash: digest('c'),
        metadataHash: digest('d'),
        size: 4096,
      },
      targetFingerprint: {
        contentHash: digest('e'),
        identityHash: digest('f'),
        metadataHash: digest('1'),
        size: 8192,
      },
      temporaryRelativePath: 'node_modules/pkg/.setu-stage-a',
    },
  ]);
  expect(recovered).not.toBeNull();
  if (!recovered) {
    return;
  }
  const panel = dependencyOperationPanelState(recovered, 'prepare-release');
  expect(panel).toEqual({
    ariaBusy: true,
    canReconcile: true,
    canResumeApply: true,
  });
  for (const action of [
    'apply',
    'prepare',
    'prepare-release',
    'reconcile',
    'release',
    'resume',
    'resume-release',
  ]) {
    expect(
      dependencyOperationPanelState(recovered, action).ariaBusy
    ).toBeTrue();
  }
  expect(dependencyOperationPanelState(recovered, null).ariaBusy).toBeFalse();

  const review = dependencyResumeReviewKey(recovered, target);
  expect(resumeDependencyFilesBody(target, recovered, review)).toEqual({
    confirmation: digest('a'),
    name: target.name,
    operationId: digest('a'),
    planId: digest('a'),
    repo: target.repo,
  });
  expect(
    dependencyOperationPanelState({ ...recovered, state: 'released' }, null)
      .canReconcile
  ).toBeFalse();
});
