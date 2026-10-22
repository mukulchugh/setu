export interface DependencyFileTarget {
  name: string;
  repo: string;
}

export interface DependencyFileFingerprintSummary {
  identityHash: string;
  size: number;
}

export interface HoistedDependencyFile {
  fingerprint: DependencyFileFingerprintSummary;
  index: number;
  objectKey: string;
  relativePath: string;
  temporaryRelativePath: string;
}

export interface SkippedDependencyFile {
  reason: string;
  relativePath: string;
}

export interface HoistedDependencyPlan {
  files: HoistedDependencyFile[];
  head: string | null;
  id: string;
  inputDigest: string;
  lockfileHash: string;
  logicalCloneBytes: number;
  mode: 'hoisted-cow';
  name: string;
  physicalSavingsBytes: null;
  repo: string;
  skipped: SkippedDependencyFile[];
  source: Record<string, unknown>;
}

export interface DependencyReleaseFile {
  fingerprints: { identityHash: string; label: string; size: number }[];
  relativePath: string;
}

export interface DependencyReleasePlan {
  files: DependencyReleaseFile[];
  id: string;
  operationId: string;
  source: Record<string, unknown>;
}

export interface DependencyFileOperation {
  code?: string;
  completedFiles?: number;
  files?: DependencyFileCheckpoint[];
  id: string;
  inputDigest?: string;
  logicalCloneBytes?: number;
  mode?: string;
  name?: string;
  physicalSavingsBytes?: null;
  planId?: string;
  releaseId?: string;
  repo?: string;
  resumable?: boolean;
  retainedOriginalFiles?: number;
  state: string;
  totalFiles?: number;
  updatedAt?: number;
}

export interface DependencyFileCheckpoint {
  phase: string;
  relativePath: string;
  retainedFingerprint?: DependencyFileFingerprintObservation;
  targetFingerprint?: DependencyFileFingerprintObservation;
  temporaryRelativePath?: string;
}

export interface DependencyFileFingerprintObservation {
  contentHash?: string;
  identityHash: string;
  metadataHash?: string;
  size?: number;
}

export interface DependencyFileSnapshot {
  enrollmentState: string | null;
  mode: string | null;
  native: Record<string, unknown> | null;
  operation: DependencyFileOperation | null;
  reason: string | null;
  skipped: SkippedDependencyFile[];
  statusFailure: { code: string | null; error: string } | null;
}

export interface DependencyFilePageState {
  identity: string;
  page: number;
}

export interface DependencyFilePage {
  end: number;
  identity: string;
  page: number;
  pageCount: number;
  start: number;
}

export const DEPENDENCY_FILE_PAGE_SIZE = 100;

export function dependencyFilePage(
  state: DependencyFilePageState,
  identity: string,
  total: number,
  pageSize = DEPENDENCY_FILE_PAGE_SIZE
): DependencyFilePage {
  const pageCount = Math.ceil(total / pageSize);
  const page =
    state.identity === identity
      ? Math.min(Math.max(0, state.page), Math.max(0, pageCount - 1))
      : 0;
  const start = page * pageSize;
  return {
    end: Math.min(total, start + pageSize),
    identity,
    page,
    pageCount,
    start,
  };
}

export function changeDependencyFilePage(
  state: DependencyFilePageState,
  identity: string,
  total: number,
  pageSize: number,
  requestedPage: number
): DependencyFilePageState {
  const current = dependencyFilePage(state, identity, total, pageSize);
  return {
    identity,
    page: Math.min(
      Math.max(0, requestedPage),
      Math.max(0, current.pageCount - 1)
    ),
  };
}

const digestPattern = /^[a-f\d]{64}$/i;

export function createDependencyActionGuard() {
  let generation = 0;
  let currentTargetKey: string | null = null;

  return {
    begin(targetKey: string) {
      if (currentTargetKey !== targetKey) {
        currentTargetKey = targetKey;
        generation += 1;
      }
      generation += 1;
      return { generation, targetKey };
    },
    isCurrent(
      action: { generation: number; targetKey: string },
      targetKey: string
    ) {
      return (
        action.targetKey === targetKey &&
        action.generation === generation &&
        currentTargetKey === targetKey
      );
    },
    targetChanged(targetKey: string) {
      if (currentTargetKey !== targetKey) {
        currentTargetKey = targetKey;
        generation += 1;
      }
    },
  };
}

export function dependencyOperationPanelState(
  operation: DependencyFileOperation,
  busy: string | null
) {
  return {
    ariaBusy: busy !== null,
    canReconcile: operation.state !== 'released',
    canResumeApply:
      (operation.state === 'partial' || operation.state === 'completed') &&
      operation.resumable === true,
  };
}

export function dependencyStatusAllowsNewPlan(
  snapshot: DependencyFileSnapshot
) {
  return snapshot.statusFailure === null;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);

const recordValue = (value: unknown) => (isRecord(value) ? value : null);

const isDigest = (value: unknown): value is string =>
  typeof value === 'string' && digestPattern.test(value);

const isCount = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

const isRelativeFilePath = (value: unknown): value is string => {
  if (
    typeof value !== 'string' ||
    !value ||
    value.startsWith('/') ||
    value.includes('\0')
  ) {
    return false;
  }
  const segments = value.split('/');
  return segments.every(
    (segment) => segment !== '' && segment !== '.' && segment !== '..'
  );
};

function skippedFiles(value: unknown): SkippedDependencyFile[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.flatMap((entry) => {
    if (
      !(isRecord(entry) && isRelativeFilePath(entry.relativePath)) ||
      typeof entry.reason !== 'string' ||
      !entry.reason.trim()
    ) {
      return [];
    }
    return [{ reason: entry.reason, relativePath: entry.relativePath }];
  });
}

function operationFrom(value: unknown): DependencyFileOperation | null {
  if (!isRecord(value)) {
    return null;
  }
  const id = typeof value.id === 'string' ? value.id : value.operationId;
  if (!isDigest(id) || typeof value.state !== 'string') {
    return null;
  }
  return {
    ...(typeof value.code === 'string' ? { code: value.code } : {}),
    ...(isCount(value.completedFiles)
      ? { completedFiles: value.completedFiles }
      : {}),
    id,
    ...(isDigest(value.inputDigest) ? { inputDigest: value.inputDigest } : {}),
    ...(isCount(value.logicalCloneBytes)
      ? { logicalCloneBytes: value.logicalCloneBytes }
      : {}),
    ...(typeof value.mode === 'string' ? { mode: value.mode } : {}),
    physicalSavingsBytes: null,
    ...(isDigest(value.planId) ? { planId: value.planId } : {}),
    ...(isDigest(value.releaseId) ? { releaseId: value.releaseId } : {}),
    ...(typeof value.repo === 'string' ? { repo: value.repo } : {}),
    ...(typeof value.name === 'string' ? { name: value.name } : {}),
    ...(isCount(value.retainedOriginalFiles)
      ? { retainedOriginalFiles: value.retainedOriginalFiles }
      : {}),
    state: value.state,
    ...(isCount(value.totalFiles) ? { totalFiles: value.totalFiles } : {}),
    ...(isCount(value.updatedAt) ? { updatedAt: value.updatedAt } : {}),
    ...(typeof value.resumable === 'boolean'
      ? { resumable: value.resumable }
      : {}),
    ...(Array.isArray(value.files)
      ? {
          files: value.files.flatMap((entry) => {
            if (
              !isRecord(entry) ||
              typeof entry.phase !== 'string' ||
              !isRelativeFilePath(entry.relativePath)
            ) {
              return [];
            }
            const targetFingerprint = fingerprintObservation(
              entry.targetFingerprint
            );
            const retainedFingerprint = fingerprintObservation(
              entry.retainedFingerprint
            );
            return [
              {
                phase: entry.phase,
                relativePath: entry.relativePath,
                ...(targetFingerprint ? { targetFingerprint } : {}),
                ...(retainedFingerprint ? { retainedFingerprint } : {}),
                ...(isRelativeFilePath(entry.temporaryRelativePath)
                  ? { temporaryRelativePath: entry.temporaryRelativePath }
                  : {}),
              },
            ];
          }),
        }
      : {}),
  };
}

function fingerprintObservation(
  value: unknown
): DependencyFileFingerprintObservation | null {
  if (!(isRecord(value) && isDigest(value.identityHash))) {
    return null;
  }
  return {
    identityHash: value.identityHash,
    ...(isDigest(value.contentHash) ? { contentHash: value.contentHash } : {}),
    ...(isDigest(value.metadataHash)
      ? { metadataHash: value.metadataHash }
      : {}),
    ...(isCount(value.size) ? { size: value.size } : {}),
  };
}

function releaseFingerprints(value: Record<string, unknown>) {
  const found: { identityHash: string; label: string; size: number }[] = [];
  const visit = (entry: unknown, label: string, depth: number) => {
    if (!isRecord(entry) || depth > 4) {
      return;
    }
    if (label.toLowerCase().includes('fingerprint')) {
      if (isDigest(entry.identityHash) && isCount(entry.size)) {
        found.push({
          identityHash: entry.identityHash,
          label,
          size: entry.size,
        });
      }
      return;
    }
    for (const [key, nested] of Object.entries(entry)) {
      visit(nested, label ? `${label}.${key}` : key, depth + 1);
    }
  };
  visit(value, '', 0);
  return found.sort((a, b) => a.label.localeCompare(b.label));
}

export const dependencyFileRoutes = {
  apply: '/api/dependency-sharing/apply',
  prepare: '/api/dependency-sharing/prepare',
  prepareRelease: '/api/dependency-sharing/prepare-release',
  recover: '/api/dependency-sharing/recover',
  release: '/api/dependency-sharing/release',
} as const;

export function parseHoistedDependencyPlan(
  value: unknown,
  target: DependencyFileTarget
): HoistedDependencyPlan | null {
  const response = isRecord(value) ? value : null;
  const source = isRecord(response?.plan) ? response.plan : null;
  if (
    (source?.version !== 1 && source?.version !== 2) ||
    source?.mode !== 'hoisted-cow' ||
    source?.repo !== target.repo ||
    source?.name !== target.name ||
    !isDigest(source?.id) ||
    !isDigest(source?.inputDigest) ||
    !isDigest(source?.lockfileHash) ||
    !(typeof source?.head === 'string' || source?.head === null) ||
    !isCount(source?.logicalCloneBytes) ||
    source?.physicalSavingsBytes !== null ||
    !Array.isArray(source.files) ||
    !Array.isArray(source.skipped) ||
    source.files.length === 0
  ) {
    return null;
  }
  const files = source.files.flatMap((entry) => {
    if (!(isRecord(entry) && isCount(entry.index))) {
      return [];
    }
    if (
      !(
        isRelativeFilePath(entry.relativePath) &&
        isDigest(entry.objectKey) &&
        isRelativeFilePath(entry.temporaryRelativePath) &&
        isRecord(entry.fingerprint)
      )
    ) {
      return [];
    }
    if (
      !(
        isDigest(entry.fingerprint.identityHash) &&
        isCount(entry.fingerprint.size)
      )
    ) {
      return [];
    }
    return [
      {
        fingerprint: {
          identityHash: entry.fingerprint.identityHash,
          size: entry.fingerprint.size,
        },
        index: entry.index,
        objectKey: entry.objectKey,
        relativePath: entry.relativePath,
        temporaryRelativePath: entry.temporaryRelativePath,
      },
    ];
  });
  const skipped = skippedFiles(source.skipped);
  if (
    files.length !== source.files.length ||
    skipped.length !== source.skipped.length
  ) {
    return null;
  }
  return {
    files,
    head: source.head,
    id: source.id,
    inputDigest: source.inputDigest,
    lockfileHash: source.lockfileHash,
    logicalCloneBytes: source.logicalCloneBytes,
    mode: 'hoisted-cow',
    name: target.name,
    physicalSavingsBytes: null,
    repo: target.repo,
    skipped,
    source,
  };
}

export function parseDependencyReleasePlan(
  value: unknown,
  target: DependencyFileTarget,
  expectedOperationId: string
): DependencyReleasePlan | null {
  const response = isRecord(value) ? value : null;
  const source = isRecord(response?.releasePlan) ? response.releasePlan : null;
  if (
    !source ||
    source.repo !== target.repo ||
    source.name !== target.name ||
    source.operationId !== expectedOperationId ||
    !isDigest(source.id) ||
    typeof source.operationId !== 'string' ||
    !source.operationId ||
    !Array.isArray(source.files)
  ) {
    return null;
  }
  const files = source.files.flatMap((entry) => {
    if (!(isRecord(entry) && isRelativeFilePath(entry.relativePath))) {
      return [];
    }
    const fingerprints = releaseFingerprints(entry);
    return fingerprints.length >= 2
      ? [{ fingerprints, relativePath: entry.relativePath }]
      : [];
  });
  if (!files.length || files.length !== source.files.length) {
    return null;
  }
  return { files, id: source.id, operationId: source.operationId, source };
}

export function dependencyPlanReviewKey(
  plan: HoistedDependencyPlan,
  target: DependencyFileTarget
) {
  if (plan.repo !== target.repo || plan.name !== target.name) {
    return null;
  }
  return JSON.stringify({
    files: plan.files.map((file) => ({
      identityHash: file.fingerprint.identityHash,
      index: file.index,
      relativePath: file.relativePath,
      size: file.fingerprint.size,
    })),
    head: plan.head,
    id: plan.id,
    inputDigest: plan.inputDigest,
    intent: 'apply-hoisted-file-plan',
    lockfileHash: plan.lockfileHash,
    logicalCloneBytes: plan.logicalCloneBytes,
    mode: plan.mode,
    physicalSavingsBytes: null,
    skipped: plan.skipped.map((file) => ({
      reason: file.reason,
      relativePath: file.relativePath,
    })),
    target,
  });
}

export function dependencyPlanConfirmation(
  plan: HoistedDependencyPlan,
  target: DependencyFileTarget,
  displayedPlanKey: string | null
) {
  const currentKey = dependencyPlanReviewKey(plan, target);
  return currentKey && currentKey === displayedPlanKey ? plan.id : null;
}

export function dependencyReleaseReviewKey(
  plan: DependencyReleasePlan,
  target: DependencyFileTarget
) {
  if (plan.source.repo !== target.repo || plan.source.name !== target.name) {
    return null;
  }
  return JSON.stringify({
    files: plan.files.map((file) => ({
      fingerprints: file.fingerprints,
      relativePath: file.relativePath,
    })),
    id: plan.id,
    intent: 'release-retained-originals',
    operationId: plan.operationId,
    target,
  });
}

export function dependencyReleaseConfirmation(
  plan: DependencyReleasePlan,
  target: DependencyFileTarget,
  displayedPlanKey: string | null
) {
  const reviewKey = dependencyReleaseReviewKey(plan, target);
  return reviewKey && reviewKey === displayedPlanKey ? plan.id : null;
}

export function dependencyResumeReviewKey(
  operation: DependencyFileOperation,
  target: DependencyFileTarget
) {
  if (
    (operation.repo !== undefined && operation.repo !== target.repo) ||
    (operation.name !== undefined && operation.name !== target.name) ||
    (operation.state !== 'partial' && operation.state !== 'completed') ||
    operation.resumable !== true ||
    !isDigest(operation.id) ||
    (operation.planId !== undefined && operation.planId !== operation.id)
  ) {
    return null;
  }
  return JSON.stringify({
    completedFiles: operation.completedFiles ?? null,
    files: operation.files ?? [],
    id: operation.id,
    inputDigest: operation.inputDigest ?? null,
    intent: 'resume-hoisted-file-plan',
    logicalCloneBytes: operation.logicalCloneBytes ?? null,
    mode: operation.mode ?? 'hoisted-cow',
    name: target.name,
    physicalSavingsBytes: null,
    repo: target.repo,
    retainedOriginalFiles: operation.retainedOriginalFiles ?? null,
    state: operation.state,
    totalFiles: operation.totalFiles ?? null,
  });
}

export function resumeDependencyFilesBody(
  target: DependencyFileTarget,
  operation: DependencyFileOperation,
  displayedReviewKey: string | null
) {
  const currentKey = dependencyResumeReviewKey(operation, target);
  return currentKey && currentKey === displayedReviewKey
    ? {
        confirmation: operation.id,
        name: target.name,
        operationId: operation.id,
        planId: operation.planId ?? operation.id,
        repo: target.repo,
      }
    : null;
}

export function dependencyReleaseResumeReviewKey(
  operation: DependencyFileOperation,
  target: DependencyFileTarget
) {
  if (
    !isDigest(operation.releaseId) ||
    (operation.repo !== undefined && operation.repo !== target.repo) ||
    (operation.name !== undefined && operation.name !== target.name) ||
    !['partial', 'completed'].includes(operation.state)
  ) {
    return null;
  }
  return JSON.stringify({
    id: operation.releaseId,
    intent: 'resume-retained-original-release',
    name: target.name,
    operationId: operation.id,
    repo: target.repo,
    state: operation.state,
  });
}

export function resumeDependencyReleaseBody(
  target: DependencyFileTarget,
  operation: DependencyFileOperation,
  displayedReviewKey: string | null
) {
  const currentKey = dependencyReleaseResumeReviewKey(operation, target);
  return currentKey && currentKey === displayedReviewKey && operation.releaseId
    ? {
        confirmation: operation.releaseId,
        name: target.name,
        releaseId: operation.releaseId,
        repo: target.repo,
      }
    : null;
}

export function applyDependencyFilesBody(
  target: DependencyFileTarget,
  plan: HoistedDependencyPlan,
  displayedPlanKey: string | null
) {
  const token = dependencyPlanConfirmation(plan, target, displayedPlanKey);
  return token
    ? {
        confirmation: token,
        name: target.name,
        operationId: plan.id,
        planId: plan.id,
        repo: target.repo,
      }
    : null;
}

export function recoverDependencyFilesBody(
  target: DependencyFileTarget,
  operationId: string | null
) {
  return operationId
    ? { name: target.name, operationId, repo: target.repo }
    : null;
}

export function prepareDependencyReleaseBody(
  target: DependencyFileTarget,
  operationId: string | null
) {
  return operationId
    ? { name: target.name, operationId, repo: target.repo }
    : null;
}

export function releaseDependencyFilesBody(
  target: DependencyFileTarget,
  plan: DependencyReleasePlan,
  displayedPlanKey: string | null
) {
  const token = dependencyReleaseConfirmation(plan, target, displayedPlanKey);
  return token
    ? {
        confirmation: token,
        name: target.name,
        releaseId: plan.id,
        repo: target.repo,
      }
    : null;
}

export function dependencyFileOperationFrom(
  value: unknown
): DependencyFileOperation | null {
  const response = recordValue(value);
  const dependencyFiles = recordValue(response?.dependencyFiles);
  const status =
    recordValue(response?.dependencyFileStatus) ??
    recordValue(dependencyFiles?.dependencyFileStatus);
  const summaries = [
    ...(Array.isArray(response?.operations) ? response.operations : []),
    ...(Array.isArray(dependencyFiles?.operations)
      ? dependencyFiles.operations
      : []),
    ...(Array.isArray(status?.operations) ? status.operations : []),
  ]
    .map(operationFrom)
    .filter((entry): entry is DependencyFileOperation => entry !== null);
  summaries.sort(
    (left, right) => (right.updatedAt ?? 0) - (left.updatedAt ?? 0)
  );
  return (
    operationFrom(response?.operation) ??
    operationFrom(dependencyFiles?.operation) ??
    operationFrom(status?.operation) ??
    operationFrom(response?.summary) ??
    summaries[0] ??
    operationFrom(response)
  );
}

export function dependencyFileSnapshot(
  responseValue: unknown,
  target: DependencyFileTarget
): DependencyFileSnapshot {
  const response = recordValue(responseValue);
  const views = Array.isArray(response?.views)
    ? response.views.filter(isRecord)
    : [];
  const matchingView = matchingRecord(views, target, true);
  const nested =
    recordValue(response?.dependencyFiles) ??
    recordValue(matchingView?.dependencyFiles) ??
    recordValue(matchingView?.dependencyFileStatus);
  const status = recordValue(nested?.dependencyFileStatus) ?? nested;
  const journalViews = Array.isArray(status?.views)
    ? status.views.filter(isRecord)
    : [];
  const matchingJournalView = matchingRecord(journalViews, target, true);
  const view = recordValue(nested?.view) ?? matchingJournalView ?? status;
  const operations = operationList(status?.operations);
  const operationCandidates = [
    operationFrom(nested?.operation),
    operationFrom(status?.operation),
    operationFrom(response?.operation),
    operationFrom(view?.operation),
    operationFrom(view),
    ...operations,
  ].filter((entry): entry is DependencyFileOperation => entry !== null);
  operationCandidates.sort(
    (left, right) => (right.updatedAt ?? 0) - (left.updatedAt ?? 0)
  );
  const operation = operationCandidates[0] ?? null;
  const native =
    recordValue(nested?.native) ??
    recordValue(status?.native) ??
    recordValue(response?.native);
  const skipped = skippedFiles(view?.skipped ?? nested?.skipped);
  const enrollmentState =
    stringValue(view?.enrollmentState) ?? stringValue(view?.state);
  const statusFailure = dependencyFileStatusFailure(nested, status);
  return {
    enrollmentState,
    mode: stringValue(view?.mode),
    native,
    operation,
    reason:
      statusFailure?.error ??
      (typeof view?.reason === 'string' && view.reason.trim()
        ? view.reason
        : null),
    skipped,
    statusFailure,
  };
}

function dependencyFileStatusFailure(
  nested: Record<string, unknown> | null,
  status: Record<string, unknown> | null
) {
  let failureSource: Record<string, unknown> | null = null;
  if (nested?.ok === false) {
    failureSource = nested;
  } else if (status?.ok === false) {
    failureSource = status;
  }
  if (!failureSource) {
    return null;
  }
  return {
    code: typeof failureSource.code === 'string' ? failureSource.code : null,
    error:
      typeof failureSource.error === 'string' && failureSource.error.trim()
        ? failureSource.error
        : 'Dependency file status could not be confirmed.',
  };
}

function matchingRecord(
  entries: Record<string, unknown>[],
  target: DependencyFileTarget,
  allowSingleUntargeted: boolean
) {
  const matching = entries.find(
    (entry) => entry.repo === target.repo && entry.name === target.name
  );
  if (matching) {
    return matching;
  }
  if (
    allowSingleUntargeted &&
    entries.length === 1 &&
    entries[0].repo === undefined &&
    entries[0].name === undefined
  ) {
    return entries[0];
  }
  return null;
}

function operationList(value: unknown) {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map(operationFrom)
    .filter((entry): entry is DependencyFileOperation => entry !== null)
    .sort((left, right) => (right.updatedAt ?? 0) - (left.updatedAt ?? 0));
}

function stringValue(value: unknown) {
  return typeof value === 'string' ? value : null;
}

export function dependencyOutcomeUnknown(value: unknown) {
  const response = isRecord(value) ? value : null;
  const operation = operationFrom(response?.operation);
  return (
    response?.networkUncertain === true ||
    response?.unknown === true ||
    response?.state === 'unknown' ||
    operation?.state === 'unknown' ||
    (typeof response?.code === 'string' && response.code.includes('UNKNOWN'))
  );
}

export function dependencyOperationState(value: unknown) {
  return dependencyFileOperationFrom(value)?.state;
}

export function dependencyFileNativeReason(snapshot: DependencyFileSnapshot) {
  const { native } = snapshot;
  return native?.available === false && typeof native.reason === 'string'
    ? native.reason
    : null;
}

export function dependencyFileRelativePath(value: unknown) {
  return isRelativeFilePath(value);
}
