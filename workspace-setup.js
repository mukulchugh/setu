import { lstatSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  createDependencyReceipt,
  inspectDependencyReadiness,
  observeDependencyInstallInputs,
} from './dependency-readiness.js';
import {
  inspectDependencyView,
  recordDependencyConsumer,
  sharedDependencyInstall,
} from './dependency-sharing.js';
import { assertStorageHeadroom } from './host-health.js';

const worktreePathPattern = /^worktree (.+)$/m;
const worktreeBranchPattern = /^branch refs\/heads\/(.+)$/m;
const HOISTED_ENROLLMENT_STAGE = 'dependency-enrollment';

function dependencyInstallCommand(wtDir, exists) {
  if (exists(join(wtDir, 'package.json'))) {
    return ['bun', ['install']];
  }
  if (
    exists(join(wtDir, 'pyproject.toml')) ||
    exists(join(wtDir, 'requirements.txt'))
  ) {
    return ['uv', ['sync']];
  }
  return null;
}

function setupError(code, message) {
  return Object.assign(new Error(message), { code });
}

function requireProgress(result) {
  if (!result?.ok) {
    throw setupError(
      result?.code ?? 'SETUP_PROGRESS_UNAVAILABLE',
      result?.error ?? 'The durable setup progress record could not be updated'
    );
  }
  return result.record;
}

function sameValue(a, b) {
  if (a === b) {
    return true;
  }
  if (!(a && b && typeof a === 'object' && typeof b === 'object')) {
    return false;
  }
  const aKeys = Object.keys(a).sort();
  const bKeys = Object.keys(b).sort();
  return (
    aKeys.length === bKeys.length &&
    aKeys.every(
      (key, index) => key === bKeys[index] && sameValue(a[key], b[key])
    )
  );
}

function recoveryDetail(error) {
  return {
    code: String(error?.code ?? 'SETUP_PROGRESS_UNAVAILABLE').slice(0, 96),
    message: String(error?.message ?? 'Progress persistence failed').slice(
      0,
      256
    ),
  };
}

function addRecovery(error, persistenceError) {
  if (persistenceError && !error.recovery) {
    error.recovery = { progress: recoveryDetail(persistenceError) };
  }
  return error;
}

function dependencyConsumers(state) {
  let document;
  try {
    document = state?.read?.('dependencyViews');
  } catch (error) {
    throw addRecovery(
      setupError(
        'DEPENDENCY_VIEW_UNKNOWN',
        'Dependency consumer records are unreadable; shared setup was not started'
      ),
      error
    );
  }
  if (!(document && typeof document === 'object' && !Array.isArray(document))) {
    throw setupError(
      'DEPENDENCY_VIEW_UNKNOWN',
      'Dependency consumer records are malformed; shared setup was not started'
    );
  }
  if (!Object.hasOwn(document, 'consumers')) {
    return {};
  }
  const { consumers } = document;
  if (
    !(consumers && typeof consumers === 'object' && !Array.isArray(consumers))
  ) {
    throw setupError(
      'DEPENDENCY_VIEW_UNKNOWN',
      'Dependency consumer records are malformed; shared setup was not started'
    );
  }
  for (const [checkout, consumer] of Object.entries(consumers)) {
    if (
      !(consumer && typeof consumer === 'object' && !Array.isArray(consumer)) ||
      consumer.checkout !== checkout ||
      typeof consumer.bunVersion !== 'string' ||
      typeof consumer.linkerMode !== 'string' ||
      typeof consumer.lockfileHash !== 'string' ||
      typeof consumer.platformNamespace !== 'string'
    ) {
      throw setupError(
        'DEPENDENCY_VIEW_UNKNOWN',
        'Dependency consumer records are malformed; shared setup was not started'
      );
    }
  }
  return consumers;
}

function sharingForSetup(sharing, state) {
  return sharing?.enabled
    ? { ...sharing, consumers: dependencyConsumers(state) }
    : sharing;
}

// A record is created only after the checkout exists and its identity is known.
// Retries read that durable record, so a process restart cannot reuse a stale
// attempt id or silently reinstall an already-completed checkout.
export async function beginSetupAttempt({
  progress,
  target,
  checkoutIdentity,
  logLocation,
  stage = 'preparing',
} = {}) {
  if (!progress) {
    return null;
  }
  if (!(target && checkoutIdentity && logLocation)) {
    throw setupError(
      'SETUP_COORDINATION_INVALID',
      'Durable setup coordination needs target, checkout identity, and log location'
    );
  }
  const current = progress.get(target);
  if (current?.ok === false) {
    requireProgress(current);
  }
  if (!current) {
    return {
      completed: false,
      record: requireProgress(
        await progress.start({ checkoutIdentity, logLocation, stage, target })
      ),
    };
  }
  if (!sameValue(current.checkoutIdentity, checkoutIdentity)) {
    throw setupError(
      'CHECKOUT_IDENTITY_MISMATCH',
      'The checkout identity does not match the recorded setup'
    );
  }
  if (current.state === 'completed') {
    return { completed: true, record: current };
  }
  if (
    current.state === 'unknown' &&
    current.stage?.startsWith(HOISTED_ENROLLMENT_STAGE)
  ) {
    const operationId = current.stage
      .slice(`${HOISTED_ENROLLMENT_STAGE}-unknown:`.length)
      .trim()
      .slice(0, 128);
    const error = setupError(
      'DEPENDENCY_ENROLLMENT_RECONCILIATION_REQUIRED',
      'Fresh hoisted setup already completed its install; reconcile the recorded dependency enrollment before retrying setup'
    );
    error.recovery = {
      dependencySharing: {
        ...(current.stage.startsWith(`${HOISTED_ENROLLMENT_STAGE}-unknown:`) &&
        operationId
          ? { operationId }
          : {}),
        setupId: current.attemptId,
      },
    };
    throw error;
  }
  if (current.state === 'running') {
    throw setupError(
      'SETUP_ALREADY_RUNNING',
      'Setup is already running for this checkout'
    );
  }
  return {
    completed: false,
    record: requireProgress(
      await progress.retry({
        attemptId: current.attemptId,
        checkoutIdentity,
        logLocation,
        stage,
        target,
      })
    ),
  };
}

// A portal retry may be explicitly reviewed and accepted under its target
// lock.  This validates that supplied durable record before any setup effect,
// avoiding a second implicit retry of the now-running replacement attempt.
export function validateSetupAttempt({
  progress,
  target,
  checkoutIdentity,
  logLocation,
  setupAttempt,
} = {}) {
  if (!(progress && setupAttempt) || typeof setupAttempt !== 'object') {
    throw setupError(
      'SETUP_ATTEMPT_INVALID',
      'The supplied setup attempt is invalid'
    );
  }
  const current = progress.get(target);
  if (current?.ok === false) {
    requireProgress(current);
  }
  if (
    current?.state !== 'running' ||
    current.attemptId !== setupAttempt.attemptId ||
    !sameValue(current.target, target) ||
    !sameValue(current.checkoutIdentity, checkoutIdentity) ||
    current.logLocation !== logLocation ||
    !sameValue(setupAttempt.checkoutIdentity, current.checkoutIdentity) ||
    !sameValue(setupAttempt.target, current.target)
  ) {
    throw setupError(
      'SETUP_ATTEMPT_MISMATCH',
      'The supplied setup attempt is stale, forged, or belongs to another checkout'
    );
  }
  return { completed: false, record: current };
}

function resolveSetupAttempt(options) {
  return options.setupAttempt
    ? validateSetupAttempt(options)
    : beginSetupAttempt(options);
}

async function setupStage(progress, setup, stage) {
  if (!(progress && setup)) {
    return;
  }
  requireProgress(
    await progress.stage({
      attemptId: setup.record.attemptId,
      checkoutIdentity: setup.record.checkoutIdentity,
      stage,
      target: setup.record.target,
    })
  );
}

async function setupFinish(progress, setup, outcome, dependencyReceipt) {
  if (!(progress && setup)) {
    return;
  }
  requireProgress(
    await progress.finish({
      attemptId: setup.record.attemptId,
      checkoutIdentity: setup.record.checkoutIdentity,
      ...(dependencyReceipt ? { dependencyReceipt } : {}),
      outcome,
      target: setup.record.target,
    })
  );
}

async function setupBindEnrollment(
  progress,
  setup,
  admissionOperationId,
  bunVersion,
  installInputs
) {
  if (typeof progress?.bindEnrollment !== 'function') {
    throw setupError(
      'DEPENDENCY_ENROLLMENT_BINDING_UNAVAILABLE',
      'Durable setup progress cannot bind dependency enrollment to this install'
    );
  }
  if (typeof admissionOperationId !== 'string' || !admissionOperationId) {
    throw setupError(
      'SETUP_ADMISSION_ID_REQUIRED',
      'Fresh hoisted setup requires its exact admission operation id'
    );
  }
  requireProgress(
    await progress.bindEnrollment({
      attemptId: setup.record.attemptId,
      checkoutIdentity: setup.record.checkoutIdentity,
      dependencyEnrollment: {
        admissionOperationId,
        bunVersion,
        installerSettled: true,
        ...(installInputs === undefined ? {} : { installInputs }),
        version: 1,
      },
      target: setup.record.target,
    })
  );
}

function setupFailure(progress, setup, outcome) {
  return setupFinish(progress, setup, outcome);
}

function requireHoistedFinalizer(finalize, target, progress, setup) {
  if (typeof finalize !== 'function') {
    throw setupError(
      'DEPENDENCY_ENROLLMENT_UNAVAILABLE',
      'Fresh hoisted setup requires the unified dependency enrollment service'
    );
  }
  const setupTarget = setup?.record?.target;
  if (
    !(
      setupTarget &&
      typeof setupTarget.repo === 'string' &&
      setupTarget.repo &&
      typeof setupTarget.name === 'string' &&
      setupTarget.name
    ) ||
    (target && !sameValue(target, setupTarget)) ||
    !(progress && setup?.record) ||
    typeof setup.record.attemptId !== 'string' ||
    !setup.record.attemptId ||
    setup.record.state !== 'running' ||
    setup.record.checkoutIdentity === undefined ||
    setup.record.checkoutIdentity === null
  ) {
    throw setupError(
      'SETUP_COORDINATION_INVALID',
      'Fresh hoisted setup requires a durable target-owned setup attempt'
    );
  }
}

function finalizationRecovery(error) {
  const result = error?.result;
  const recovery = {};
  const operationId =
    (typeof result?.operationId === 'string' && result.operationId) ||
    (typeof error?.operationId === 'string' && error.operationId);
  const code =
    (typeof result?.code === 'string' && result.code) ||
    (typeof error?.code === 'string' && error.code);
  const state =
    (typeof result?.state === 'string' && result.state) ||
    (typeof error?.state === 'string' && error.state);
  if (operationId || code || state) {
    recovery.dependencySharing = {
      ...(code ? { code: code.slice(0, 96) } : {}),
      ...(operationId ? { operationId: operationId.slice(0, 128) } : {}),
      ...(state ? { state: state.slice(0, 48) } : {}),
    };
  }
  return recovery;
}

function freshHoistedSetupContext(
  target,
  setup,
  admissionOperationId,
  installerSettled
) {
  return {
    admissionOperationId: admissionOperationId ?? null,
    attemptId: setup.record.attemptId,
    checkoutIdentity: setup.record.checkoutIdentity,
    installerSettled,
    target: { name: target.name, repo: target.repo },
  };
}

async function preflightFreshHoisted(
  prepare,
  finalize,
  target,
  setup,
  admissionOperationId
) {
  const preflight = prepare ?? finalize?.preflight;
  if (typeof preflight !== 'function') {
    throw setupError(
      'DEPENDENCY_ENROLLMENT_UNAVAILABLE',
      'Fresh hoisted setup requires dependency enrollment capability preflight before installation'
    );
  }
  const result = await preflight(
    { name: target.name, repo: target.repo },
    freshHoistedSetupContext(target, setup, admissionOperationId, false)
  );
  if (result?.ok !== true) {
    throw setupError(
      result?.code ?? 'DEPENDENCY_ENROLLMENT_UNAVAILABLE',
      result?.error ??
        'Dependency enrollment capability preflight did not confirm availability'
    );
  }
}

async function prepareFreshHoistedEnrollment({
  admissionOperationId,
  finalize,
  prepare,
  progress,
  setup,
  target,
}) {
  requireHoistedFinalizer(finalize, target, progress, setup);
  if (typeof progress?.bindEnrollment !== 'function') {
    throw setupError(
      'DEPENDENCY_ENROLLMENT_BINDING_UNAVAILABLE',
      'Durable setup progress cannot bind dependency enrollment to this install'
    );
  }
  if (typeof admissionOperationId !== 'string' || !admissionOperationId) {
    throw setupError(
      'SETUP_ADMISSION_ID_REQUIRED',
      'Fresh hoisted setup requires its exact admission operation id'
    );
  }
  await setupStage(progress, setup, 'dependency-enrollment-preflight');
  await preflightFreshHoisted(
    prepare,
    finalize,
    setup.record.target,
    setup,
    admissionOperationId
  );
}

async function finishDependencyInstall({
  admissionOperationId,
  bunVersion,
  finalize,
  installInputs,
  progress,
  setup,
  shared,
  state,
  sharing,
  wtDir,
}) {
  if (shared?.strategy === 'hoisted-cow') {
    try {
      await setupStage(progress, setup, HOISTED_ENROLLMENT_STAGE);
      await setupBindEnrollment(
        progress,
        setup,
        admissionOperationId,
        bunVersion,
        installInputs
      );
      await finalizeFreshHoisted(
        finalize,
        setup.record.target,
        setup,
        admissionOperationId
      );
      const document = state?.read?.('dependencyFiles');
      const summary =
        document?.views?.[
          `${setup.record.target.repo}/${setup.record.target.name}`
        ];
      if (!summary) {
        throw setupError(
          'DEPENDENCY_VIEW_UNKNOWN',
          'Completed dependency enrollment has no authoritative view summary'
        );
      }
      return { dependencyFiles: summary };
    } catch (error) {
      throw await unknownFinalizationOutcome(progress, setup, error);
    }
  } else if (shared) {
    try {
      await recordDependencyConsumer(
        state,
        wtDir,
        sharingForSetup(sharing, state),
        shared
      );
    } catch (error) {
      throw await preserveKnownFailure(progress, setup, error);
    }
  }
  return {};
}

async function finishCompletedSetup(progress, setup, dependencyReceipt) {
  const currentRecord = progress.get(setup.record.target);
  const { dependencyEnrollment } = currentRecord ?? {};
  if (dependencyEnrollment) {
    const { operationId } = dependencyEnrollment;
    if (
      typeof operationId !== 'string' ||
      typeof progress.finishEnrollment !== 'function'
    ) {
      throw setupError(
        'DEPENDENCY_ENROLLMENT_BINDING_REQUIRED',
        'Completed dependency enrollment requires its durable operation binding'
      );
    }
    try {
      requireProgress(
        await progress.finishEnrollment({
          attemptId: setup.record.attemptId,
          checkoutIdentity: setup.record.checkoutIdentity,
          ...(dependencyReceipt ? { dependencyReceipt } : {}),
          operationId,
          target: setup.record.target,
        })
      );
    } catch (cause) {
      const error = setupError(
        'DEPENDENCY_ENROLLMENT_COMPLETION_UNKNOWN',
        'Dependency enrollment completed, but setup completion was not durably confirmed'
      );
      error.operationId = operationId;
      error.cause = cause;
      throw await unknownFinalizationOutcome(progress, setup, error);
    }
  } else {
    await setupFinish(progress, setup, 'completed', dependencyReceipt);
  }
}

async function completeDependencySetup({
  bunVersion,
  dependencyFiles,
  installInputs,
  progress,
  receiptEligible = true,
  setup,
  sharing,
  state,
  wtDir,
}) {
  if (!(progress && setup)) {
    return true;
  }
  let dependencyReceipt;
  if (receiptEligible) {
    try {
      const receipt = await createDependencyReceipt({
        attemptId: setup.record.attemptId,
        bunVersion,
        checkoutIdentity: setup.record.checkoutIdentity,
        ...(dependencyFiles ? { dependencyFiles, sharing: undefined } : {}),
        installInputs,
        sharing: dependencyFiles ? undefined : sharing,
        state,
        wtDir,
      });
      if (receipt.ok) {
        dependencyReceipt = receipt.receipt;
      }
    } catch {
      // Installation and enrollment already completed; a receipt failure leaves
      // readiness unverified without rewriting that known outcome.
    }
  }
  await finishCompletedSetup(progress, setup, dependencyReceipt);
  if (!dependencyReceipt) {
    return false;
  }
  const record = progress.get(setup.record.target);
  const readiness = await inspectDependencyReadiness({
    bunVersion,
    checkoutIdentity: setup.record.checkoutIdentity,
    ...(dependencyFiles ? { dependencyFiles, sharing: undefined } : {}),
    record,
    sharing: dependencyFiles ? undefined : sharing,
    state,
    wtDir,
  });
  return readiness.ok === true && readiness.checkCurrent();
}

async function completedSetupIsReady({
  setup,
  progress,
  sharing,
  state,
  wtDir,
}) {
  if (!(progress && setup?.record)) {
    return true;
  }
  const record = progress.get(setup.record.target);
  let dependencyFiles;
  if (record?.dependencyReceipt?.dependencyFiles) {
    try {
      const document = state?.read?.('dependencyFiles');
      dependencyFiles =
        document?.version === 1 &&
        document?.views &&
        typeof document.views === 'object'
          ? (document.views[
              `${setup.record.target.repo}/${setup.record.target.name}`
            ] ?? null)
          : null;
    } catch {
      dependencyFiles = null;
    }
    if (!dependencyFiles) {
      return false;
    }
  } else {
    dependencyFiles = undefined;
  }
  const readiness = await inspectDependencyReadiness({
    bunVersion:
      record?.dependencyReceipt?.bunVersion ??
      record?.dependencyEnrollment?.bunVersion ??
      Bun.version,
    checkoutIdentity: setup.record.checkoutIdentity,
    ...(dependencyFiles ? { dependencyFiles, sharing: undefined } : {}),
    record,
    sharing: dependencyFiles ? undefined : sharing,
    state,
    wtDir,
  });
  return readiness.ok === true && readiness.checkCurrent();
}

async function captureBunInstallInputs(wtDir, bunVersion) {
  try {
    const observed = await observeDependencyInstallInputs({
      bunVersion,
      wtDir: realpathSync(wtDir),
    });
    return observed.ok ? observed.inputs : undefined;
  } catch {
    // The install result remains useful even when the pre-install snapshot is
    // unavailable; readiness then stays unverified because no receipt is made.
  }
}

function bunVersionForInstall(bunInstaller, shared) {
  if (!bunInstaller) {
    return;
  }
  return shared?.bunVersion ?? Bun.version;
}

async function finalizeFreshHoisted(
  finalize,
  target,
  setup,
  admissionOperationId
) {
  const setupContext = freshHoistedSetupContext(
    target,
    setup,
    admissionOperationId,
    true
  );
  let result;
  try {
    result = await finalize(
      { name: target.name, repo: target.repo },
      setupContext
    );
  } catch (cause) {
    const error = setupError(
      'DEPENDENCY_ENROLLMENT_FAILED',
      'Unified dependency enrollment did not confirm completion'
    );
    const details =
      cause && (typeof cause === 'object' || typeof cause === 'function')
        ? cause
        : {};
    error.operationId = details.operationId;
    error.state = details.state;
    error.result = details.result;
    error.cause = cause;
    throw error;
  }
  if (
    result?.ok !== true ||
    result.state !== 'completed' ||
    result.queued === true ||
    [
      'conflict',
      'partial',
      'prepared',
      'released',
      'running',
      'unknown',
    ].includes(result.state)
  ) {
    const error = setupError(
      result?.code ?? 'DEPENDENCY_ENROLLMENT_FAILED',
      result?.error ??
        'Unified dependency enrollment did not confirm completion'
    );
    error.operationId = result?.operationId;
    error.state = result?.state;
    error.result = result;
    throw error;
  }
  return result;
}

async function unknownFinalizationOutcome(progress, setup, cause) {
  const recovery = finalizationRecovery(cause);
  const operationId = recovery.dependencySharing?.operationId;
  let stageError;
  try {
    await setupStage(
      progress,
      setup,
      operationId
        ? `${HOISTED_ENROLLMENT_STAGE}-unknown:${operationId}`
        : `${HOISTED_ENROLLMENT_STAGE}-unknown`
    );
  } catch (stageFailure) {
    stageError = stageFailure;
  }
  const error = await unknownOutcome(
    progress,
    setup,
    'Unified dependency enrollment outcome is unconfirmed; retry the recorded enrollment after recovery'
  );
  if (Object.keys(recovery).length) {
    error.recovery = { ...error.recovery, ...recovery };
  }
  if (stageError) {
    addRecovery(error, stageError);
  }
  return error;
}

async function preserveKnownFailure(progress, setup, error) {
  try {
    await setupFailure(progress, setup, 'failed');
  } catch (persistenceError) {
    addRecovery(error, persistenceError);
  }
  return error;
}

async function unknownOutcome(progress, setup, message) {
  const error = setupError('OPERATION_UNKNOWN', message);
  try {
    await setupFailure(progress, setup, 'unknown');
  } catch (persistenceError) {
    addRecovery(error, persistenceError);
  }
  return error;
}

function requireFreshSharedView(
  view,
  sharing,
  wtDir,
  refreshDependencies = false
) {
  if (
    refreshDependencies &&
    view?.ok === true &&
    view.state === 'shared and healthy'
  ) {
    return;
  }
  let checkout;
  try {
    checkout = realpathSync(wtDir);
  } catch {
    checkout = wtDir;
  }
  let absent = view?.state === 'absent';
  if (
    !(absent || sharing?.consumers?.[checkout]) &&
    view?.state === 'unknown'
  ) {
    try {
      lstatSync(join(checkout, 'node_modules'));
    } catch (error) {
      // biome-ignore lint/suspicious/noUnnecessaryConditions: Filesystem adapters can throw non-Error values while probing an untrusted path.
      absent = error?.code === 'ENOENT';
    }
  }
  if (!absent || sharing?.consumers?.[checkout]) {
    throw setupError(
      'DEPENDENCY_VIEW_UNSAFE',
      `Shared setup requires a fresh absent dependency view; found ${view?.state ?? 'unknown'}`
    );
  }
}

// Admission is deliberately outside the target lock.  For portal callers the
// supplied lifecycle keeps the target lock through `completion`; this wrapper
// keeps the exact lease through that same known completion.
export async function withSetupAdmission({
  admission,
  operationId,
  target,
  withTarget = async (_target, work) => work(),
  task,
} = {}) {
  if (typeof task !== 'function' || typeof withTarget !== 'function') {
    throw setupError(
      'SETUP_COORDINATION_INVALID',
      'Setup admission needs task and target-lock collaborators'
    );
  }
  if (!admission) {
    return withTarget(target, () => task({ lease: null }));
  }
  const admitted = await admission.admit({
    kind: 'install',
    operationId,
    target,
  });
  if (!admitted?.ok) {
    return admitted;
  }
  const { lease } = admitted;
  let releasePromise;
  const release = () => {
    releasePromise ??= (async () => {
      const released = await admission.release(lease);
      if (!released?.ok) {
        throw setupError(
          released?.code ?? 'LEASE_RELEASE_FAILED',
          released?.error ?? 'The setup admission lease could not be released'
        );
      }
    })();
    return releasePromise;
  };
  const preserveOperationError = async (error) => {
    if (error?.code !== 'OPERATION_UNKNOWN') {
      try {
        await release();
      } catch (releaseError) {
        addRecovery(error, releaseError);
      }
    }
    throw error;
  };
  try {
    return await withTarget(target, async () => {
      const launched = await task({ lease });
      if (!launched?.completion?.then) {
        await release();
        return launched;
      }
      return {
        ...launched,
        completion: Promise.resolve(launched.completion).then(async (value) => {
          await release();
          return value;
        }, preserveOperationError),
      };
    });
  } catch (error) {
    return preserveOperationError(error);
  }
}

async function prepareSetupInstall({
  admissionOperationId,
  assertStorage,
  assertStoreStorage,
  bunInstaller,
  command,
  finalizeHoistedDependencySharing,
  prepareHoistedDependencySharing,
  progress,
  refreshDependencies,
  res,
  setup,
  sharing,
  state,
  target,
}) {
  try {
    await setupStage(progress, setup, 'storage-check');
    await assertStorage(res.wtDir);
    let shared;
    if (bunInstaller && sharing?.enabled) {
      const resolvedSharing = sharingForSetup(sharing, state);
      const view = await inspectDependencyView(res.wtDir, resolvedSharing);
      await setupStage(progress, setup, `dependency-view:${view.state}`);
      requireFreshSharedView(
        view,
        resolvedSharing,
        res.wtDir,
        refreshDependencies
      );
      shared = await sharedDependencyInstall(
        res.wtDir,
        resolvedSharing,
        assertStoreStorage,
        { refreshOwnedView: refreshDependencies }
      );
      if (shared?.strategy === 'hoisted-cow') {
        await prepareFreshHoistedEnrollment({
          admissionOperationId,
          finalize: finalizeHoistedDependencySharing,
          prepare: prepareHoistedDependencySharing,
          progress,
          setup,
          target,
        });
      }
    }
    const selectedBunVersion = bunVersionForInstall(bunInstaller, shared);
    const installInputs = selectedBunVersion
      ? await captureBunInstallInputs(res.wtDir, selectedBunVersion)
      : undefined;
    const installCommand = shared?.command ?? command;
    await setupStage(progress, setup, 'installing');
    return { installCommand, installInputs, shared };
  } catch (error) {
    throw await preserveKnownFailure(progress, setup, error);
  }
}

async function finishOwnedSetupInstall({
  admissionOperationId,
  bunInstaller,
  closeFailed,
  code,
  context,
  finalizeHoistedDependencySharing,
  installInputs,
  progress,
  proc,
  setup,
  sharing,
  shared,
  state,
  stopProcess,
  wtDir,
}) {
  try {
    await stopProcess({
      ownedGroup: true,
      pid: proc.pid,
      ...(proc.setupOwnerId ? { setupOwnerId: proc.setupOwnerId } : {}),
    });
  } catch {
    // biome-ignore lint/style/useErrorCause: Preserve the unknown process outcome contract.
    throw await unknownOutcome(
      progress,
      setup,
      'Setup process group exit is unconfirmed; admission remains blocked'
    );
  }
  if (code !== 0 || proc.signalCode) {
    throw await preserveKnownFailure(
      progress,
      setup,
      new Error(
        'Dependency installation failed; inspect the setup log before retrying'
      )
    );
  }
  if (closeFailed) {
    throw await preserveKnownFailure(
      progress,
      setup,
      new Error(
        'Dependency installation finished but its setup log descriptor could not be closed'
      )
    );
  }
  const enrollment = await finishDependencyInstall({
    admissionOperationId,
    bunVersion: bunVersionForInstall(bunInstaller, shared),
    finalize: finalizeHoistedDependencySharing,
    installInputs,
    progress,
    setup,
    shared,
    sharing,
    state,
    wtDir,
  });
  context.ready = await completeDependencySetup({
    bunVersion: bunVersionForInstall(bunInstaller, shared),
    dependencyFiles: enrollment.dependencyFiles,
    installInputs,
    progress,
    receiptEligible: bunInstaller && installInputs !== undefined,
    setup,
    sharing:
      shared?.strategy === 'isolated'
        ? sharingForSetup(sharing, state)
        : undefined,
    state,
    wtDir,
  });
}

export async function startWorktreeSetupInstall(
  context,
  {
    exists,
    spawn,
    openLog,
    closeLog,
    stopProcess,
    assertStorage = assertStorageHeadroom,
    sharing,
    assertStoreStorage,
    state,
    progress,
    target,
    checkoutIdentity,
    logLocation,
    setupAttempt,
    refreshDependencies = false,
    prepareHoistedDependencySharing,
    finalizeHoistedDependencySharing,
    admissionOperationId,
  }
) {
  const { res } = context;
  const setupResult = (setupState) => ({
    domain: res.localDom,
    ok: true,
    port: res.port,
    setup: setupState,
  });
  const command = dependencyInstallCommand(res.wtDir, exists);
  const setup = await resolveSetupAttempt({
    checkoutIdentity,
    logLocation,
    progress,
    setupAttempt,
    target,
  });
  if (setup?.completed) {
    context.ready = await completedSetupIsReady({
      progress,
      setup,
      sharing: sharing?.enabled ? sharingForSetup(sharing, state) : undefined,
      state,
      wtDir: res.wtDir,
    });
    return setupResult(context.ready ? 'ready' : 'unverified');
  }
  if (!command) {
    await setupStage(progress, setup, 'no-dependencies');
    context.ready = await completeDependencySetup({
      bunVersion: Bun.version,
      progress,
      setup,
      state,
      wtDir: res.wtDir,
    });
    return setupResult(context.ready ? 'ready' : 'unverified');
  }
  const bunInstaller = command[0] === 'bun';
  const prepared = await prepareSetupInstall({
    admissionOperationId,
    assertStorage,
    assertStoreStorage,
    bunInstaller,
    command,
    finalizeHoistedDependencySharing,
    prepareHoistedDependencySharing,
    progress,
    refreshDependencies,
    res,
    setup,
    sharing,
    state,
    target,
  });
  let fd;
  try {
    fd = openLog();
  } catch (error) {
    throw await preserveKnownFailure(progress, setup, error);
  }
  let proc,
    closeFailed = false;
  try {
    proc = spawn([prepared.installCommand[0], ...prepared.installCommand[1]], {
      cwd: res.wtDir,
      ...(prepared.shared?.env ? { env: prepared.shared.env } : {}),
      detached: true,
      stderr: fd,
      stdin: 'ignore',
      stdout: fd,
      timeout: 15 * 60 * 1000,
    });
  } catch (error) {
    try {
      closeLog(fd);
    } catch (closeError) {
      addRecovery(error, closeError);
    }
    throw await preserveKnownFailure(progress, setup, error);
  }
  try {
    if (!(proc?.exited?.then && Number.isInteger(proc.pid)) || proc.pid < 1) {
      throw await unknownOutcome(
        progress,
        setup,
        'Setup process ownership is unconfirmed; admission remains blocked'
      );
    }
  } finally {
    try {
      closeLog(fd);
    } catch {
      closeFailed = true;
    }
  }
  const completion = proc.exited.then(
    (code) =>
      finishOwnedSetupInstall({
        admissionOperationId,
        bunInstaller,
        closeFailed,
        code,
        context,
        finalizeHoistedDependencySharing,
        installInputs: prepared.installInputs,
        proc,
        progress,
        setup,
        shared: prepared.shared,
        sharing,
        state,
        stopProcess,
        wtDir: res.wtDir,
      }),
    async () => {
      throw await unknownOutcome(
        progress,
        setup,
        'Setup process outcome is unknown; admission remains blocked'
      );
    }
  );
  return { completion, result: setupResult('installing') };
}

export async function installWorktreeDependencies(
  wtDir,
  {
    exists,
    run,
    assertStorage = assertStorageHeadroom,
    sharing,
    assertStoreStorage,
    stdio = 'inherit',
    state,
    progress,
    target,
    checkoutIdentity,
    logLocation,
    setup: suppliedSetup,
    setupAttempt,
    prepareHoistedDependencySharing,
    finalizeHoistedDependencySharing,
    admissionOperationId,
  }
) {
  let command = dependencyInstallCommand(wtDir, exists);
  const setup = suppliedSetup
    ? validateSetupAttempt({
        checkoutIdentity,
        logLocation,
        progress,
        setupAttempt: suppliedSetup.record ?? suppliedSetup,
        target,
      })
    : await resolveSetupAttempt({
        checkoutIdentity,
        logLocation,
        progress,
        setupAttempt,
        target,
      });
  if (setup?.completed) {
    return { alreadyCompleted: true };
  }
  if (!command) {
    await setupStage(progress, setup, 'no-dependencies');
    await completeDependencySetup({
      bunVersion: Bun.version,
      progress,
      setup,
      state,
      wtDir,
    });
    return { installed: false };
  }
  const bunInstaller = command[0] === 'bun';
  let shared, result;
  let installInputs;
  try {
    await setupStage(progress, setup, 'storage-check');
    await assertStorage(wtDir);
    if (command[0] === 'bun' && sharing?.enabled) {
      const resolvedSharing = sharingForSetup(sharing, state);
      const view = await inspectDependencyView(wtDir, resolvedSharing);
      await setupStage(progress, setup, `dependency-view:${view.state}`);
      requireFreshSharedView(view, resolvedSharing, wtDir);
      shared = await sharedDependencyInstall(
        wtDir,
        resolvedSharing,
        assertStoreStorage
      );
      if (shared?.strategy === 'hoisted-cow') {
        await prepareFreshHoistedEnrollment({
          admissionOperationId,
          finalize: finalizeHoistedDependencySharing,
          prepare: prepareHoistedDependencySharing,
          progress,
          setup,
          target,
        });
      }
    }
    if (command[0] === 'bun') {
      installInputs = await captureBunInstallInputs(
        wtDir,
        bunVersionForInstall(bunInstaller, shared)
      );
    }
    command = shared?.command ?? command;
    await setupStage(progress, setup, 'installing');
    result = run(...command, {
      cwd: wtDir,
      stdio,
      ...(shared?.env ? { env: shared.env } : {}),
    });
  } catch (error) {
    throw await preserveKnownFailure(progress, setup, error);
  }
  if (!Number.isInteger(result?.status) && result?.pid > 0 && !result.signal) {
    throw await unknownOutcome(
      progress,
      setup,
      'Dependency installation exit is unconfirmed; checkout ownership is retained'
    );
  }
  if (result?.status !== 0 || result.error) {
    throw await preserveKnownFailure(
      progress,
      setup,
      new Error(
        'Dependency installation failed; inspect its output before retrying'
      )
    );
  }
  const enrollment = await finishDependencyInstall({
    admissionOperationId,
    bunVersion: bunVersionForInstall(bunInstaller, shared),
    finalize: finalizeHoistedDependencySharing,
    installInputs,
    progress,
    setup,
    shared,
    sharing,
    state,
    wtDir,
  });
  await completeDependencySetup({
    bunVersion: bunVersionForInstall(bunInstaller, shared),
    dependencyFiles: enrollment.dependencyFiles,
    installInputs,
    progress,
    receiptEligible: bunInstaller && installInputs !== undefined,
    setup,
    sharing:
      shared?.strategy === 'isolated'
        ? sharingForSetup(sharing, state)
        : undefined,
    state,
    wtDir,
  });
  return { installed: true };
}

// CLI setup owns the checkout across both Git preparation and dependency work.
// Public routing is claimed through the portal only after this lease releases.
export async function createAndInstallWorktree({
  state,
  repo,
  name,
  create,
  install,
  tunnel = false,
  enableTunnel,
  admission,
  operationId,
  progress,
  sharing,
  checkoutIdentity,
  logLocation,
  withTarget,
  finalizeHoistedDependencySharing,
  prepareHoistedDependencySharing,
}) {
  const target = { name, repo };
  const lock = withTarget ?? ((_, task) => state.withTargets([target], task));
  const result = await withSetupAdmission({
    admission,
    operationId,
    target,
    task: async ({ lease }) =>
      installCreatedWorktree({
        admissionOperationId: lease?.operationId ?? operationId ?? null,
        checkoutIdentity,
        create,
        finalizeHoistedDependencySharing,
        install,
        logLocation,
        name,
        prepareHoistedDependencySharing,
        progress,
        sharing,
        state,
        target,
      }),
    withTarget: lock,
  });
  if (result?.ok === false) {
    return result;
  }
  if (!tunnel) {
    return result;
  }
  // A durable completed retry is validation only.  It must not move the
  // shared tunnel away from a later owner.
  if (['ready', 'unverified'].includes(result?.setup)) {
    return result;
  }
  const pubDom = await enableTunnel();
  return { ...result, pubDom };
}

async function installCreatedWorktree({
  admissionOperationId,
  checkoutIdentity,
  create,
  finalizeHoistedDependencySharing,
  install,
  logLocation,
  prepareHoistedDependencySharing,
  progress,
  sharing,
  state,
  target,
}) {
  const created = await create({ tunnel: false });
  const identity = checkoutIdentity
    ? await checkoutIdentity(created.wtDir)
    : undefined;
  const setup = await beginSetupAttempt({
    checkoutIdentity: identity,
    logLocation,
    progress,
    target,
  });
  if (setup?.completed) {
    const ready = await completedSetupIsReady({
      progress,
      setup,
      sharing: sharing?.enabled ? sharingForSetup(sharing, state) : undefined,
      state,
      wtDir: created.wtDir,
    });
    return { ...created, setup: ready ? 'ready' : 'unverified' };
  }
  try {
    await install(created.wtDir, {
      checkoutIdentity: identity,
      logLocation,
      progress,
      setup,
      target,
      ...(finalizeHoistedDependencySharing
        ? { finalizeHoistedDependencySharing }
        : {}),
      ...(prepareHoistedDependencySharing
        ? { prepareHoistedDependencySharing }
        : {}),
      admissionOperationId,
    });
    if (progress && setup && progress.get(target)?.state === 'running') {
      await setupFinish(progress, setup, 'completed');
    }
  } catch (error) {
    try {
      if (progress && setup && progress.get(target)?.state === 'running') {
        await setupFailure(
          progress,
          setup,
          error.code === 'OPERATION_UNKNOWN' ? 'unknown' : 'failed'
        );
      }
    } catch (persistenceError) {
      addRecovery(error, persistenceError);
    }
    throw error;
  }
  return created;
}

// Commands are explicit dependencies so setup can be checked without Git,
// network access, or a real repository. Registration belongs to the caller.
export async function cloneBareRepository(repoDir, remoteUrl, ghSlug, { run }) {
  const requireSuccess = async (args) => {
    const result = await run(args, { timeoutMs: 120_000 });
    if (result.code !== 0 || result.timedOut) {
      throw new Error(
        result.stderr ||
          `${args[0]} failed or timed out during repository setup`
      );
    }
    return result;
  };
  let useGh = false;
  if (ghSlug) {
    try {
      const auth = await run(['gh', 'auth', 'status']);
      useGh = auth.code === 0 && !auth.timedOut;
    } catch (error) {
      if (error.code === 'OPERATION_UNKNOWN') {
        throw error; /* Git can use its own configured credentials after a known failure. */
      }
    }
  }
  await requireSuccess(
    useGh
      ? ['gh', 'repo', 'clone', ghSlug, repoDir, '--', '--bare']
      : ['git', 'clone', '--bare', remoteUrl, repoDir]
  );
  await requireSuccess([
    'git',
    '-C',
    repoDir,
    'config',
    'remote.origin.fetch',
    '+refs/heads/*:refs/remotes/origin/*',
  ]);
  await requireSuccess(['git', '-C', repoDir, 'fetch', '--all', '--prune']);
}

export async function prepareWorktreeCheckout(
  { repoDir, wtDir, name, exists },
  { run }
) {
  const git = async (args) => {
    const result = await run(['git', '-C', repoDir, ...args], {
      timeoutMs: 120_000,
    });
    if (result.code !== 0 || result.timedOut || result.truncated) {
      throw new Error(
        result.stderr ||
          'Git setup failed, timed out, or returned incomplete output'
      );
    }
    return result.stdout;
  };
  const hasBranch = async (branch) => {
    for (const ref of [
      `refs/heads/${branch}`,
      `refs/remotes/origin/${branch}`,
    ]) {
      // biome-ignore lint/performance/noAwaitInLoops: Local branch lookup must precede the remote fallback and preserve its error result.
      const result = await run([
        'git',
        '-C',
        repoDir,
        'show-ref',
        '--verify',
        '--quiet',
        ref,
      ]);
      if (result.code === 0 && !result.timedOut) {
        return true;
      }
      if (result.code !== 1 || result.timedOut) {
        throw new Error('Branch lookup failed during repository setup');
      }
    }
    return false;
  };
  await git(['fetch', '--all', '--prune']);
  await git(['worktree', 'prune']);
  const list = await git(['worktree', 'list', '--porcelain']);
  if (exists) {
    // git records real paths; the workspace itself may sit behind a symlink.
    const real = (path) => {
      try {
        return realpathSync(path);
      } catch {
        return resolve(path);
      }
    };
    const linked = list
      .trim()
      .split('\n\n')
      .some((entry) => {
        const path = entry.match(worktreePathPattern)?.[1];
        return !!path && real(path) === real(wtDir);
      });
    if (!linked) {
      throw new Error(
        `Existing path '${wtDir}' is not a linked worktree of this repository`
      );
    }
    return;
  }
  for (const entry of list.trim().split('\n\n')) {
    const path = entry.match(worktreePathPattern)?.[1];
    const branch = entry.match(worktreeBranchPattern)?.[1];
    if (branch === name && path && resolve(path) !== resolve(wtDir)) {
      throw new Error(`Branch '${name}' is already checked out at ${path}`);
    }
  }
  if (await hasBranch(name)) {
    await git(['worktree', 'add', wtDir, name]);
  } else {
    const base = (await hasBranch('staging'))
      ? 'origin/staging'
      : `origin/${(await git(['symbolic-ref', '--short', 'HEAD'])).trim()}`;
    await git(['worktree', 'add', '-b', name, wtDir, base]);
  }
}
