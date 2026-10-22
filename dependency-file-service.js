import { randomUUID } from 'node:crypto';
import { stat } from 'node:fs/promises';
import { createDependencyReceipt } from './dependency-readiness.js';
import { dependencySharingForTarget } from './dependency-sharing.js';

const object = (value) =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const digestPattern = /^[a-f0-9]{64}$/;
const serviceCodePattern = /^[A-Z][A-Z0-9_]{0,127}$/;
const repositoryPartPattern = /^[^/\\\s:]+$/;
const failure = (code, error, extra = {}) => ({
  code,
  error,
  ok: false,
  ...extra,
});
const errorField = (error, key) =>
  error !== null && typeof error === 'object' ? error[key] : undefined;

const inputKeys = Object.freeze({
  apply: ['repo', 'name', 'planId', 'confirmation', 'operationId'],
  prepare: ['repo', 'name'],
  prepareRelease: ['repo', 'name', 'operationId'],
  recover: ['repo', 'name', 'operationId'],
  release: ['repo', 'name', 'releaseId', 'confirmation'],
});

function canonicalJson(value) {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(',')}]`;
  }
  if (object(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function validPart(value) {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 256 &&
    repositoryPartPattern.test(value) &&
    !['.', '..'].includes(value) &&
    !value.startsWith('-') &&
    ![...value].some((character) => character.codePointAt(0) <= 0x20)
  );
}

function validBranch(value) {
  return (
    typeof value === 'string' &&
    value.length <= 512 &&
    value.split('/').every(validPart)
  );
}

function validateDependencyFileInput(action, input) {
  const keys = inputKeys[action];
  if (
    !(keys && object(input)) ||
    Object.keys(input).some((key) => !keys.includes(key)) ||
    !validPart(input.repo) ||
    !validBranch(input.name)
  ) {
    return failure(
      'DEPENDENCY_FILE_INPUT_INVALID',
      'Dependency file request must name a registered repository and worktree and contain only supported fields'
    );
  }

  const required = {
    apply: ['planId', 'confirmation'],
    prepare: [],
    prepareRelease: ['operationId'],
    recover: ['operationId'],
    release: ['releaseId', 'confirmation'],
  }[action];
  if (required.some((key) => !Object.hasOwn(input, key))) {
    return failure(
      'DEPENDENCY_FILE_INPUT_INVALID',
      'Dependency file request is missing a required review or recovery identity'
    );
  }

  for (const key of ['planId', 'operationId', 'releaseId']) {
    if (
      Object.hasOwn(input, key) &&
      (typeof input[key] !== 'string' || !digestPattern.test(input[key]))
    ) {
      return failure(
        'DEPENDENCY_FILE_INPUT_INVALID',
        'Dependency file review and recovery identities must be lowercase SHA-256 digests'
      );
    }
  }
  if (
    Object.hasOwn(input, 'confirmation') &&
    (typeof input.confirmation !== 'string' ||
      !digestPattern.test(input.confirmation))
  ) {
    return failure(
      'DEPENDENCY_FILE_INPUT_INVALID',
      'Confirmation must be the exact reviewed SHA-256 identity'
    );
  }
  if (action === 'apply' && input.confirmation !== input.planId) {
    return failure(
      'DEPENDENCY_FILE_INPUT_INVALID',
      'Apply confirmation must match the reviewed plan id'
    );
  }
  if (
    action === 'apply' &&
    input.operationId !== undefined &&
    input.operationId !== input.planId
  ) {
    return failure(
      'DEPENDENCY_FILE_INPUT_INVALID',
      'Apply recovery identity must match the reviewed plan id'
    );
  }
  if (action === 'release' && input.confirmation !== input.releaseId) {
    return failure(
      'DEPENDENCY_FILE_INPUT_INVALID',
      'Release confirmation must match the reviewed release id'
    );
  }
  return { ok: true, value: input };
}

function same(left, right) {
  if (left === right) {
    return true;
  }
  if (Array.isArray(left) || Array.isArray(right)) {
    return (
      Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((value, index) => same(value, right[index]))
    );
  }
  if (!(object(left) && object(right))) {
    return false;
  }
  const leftKeys = Object.keys(left).sort();
  const rightKeys = Object.keys(right).sort();
  return (
    leftKeys.length === rightKeys.length &&
    leftKeys.every(
      (key, index) => key === rightKeys[index] && same(left[key], right[key])
    )
  );
}

function completedSetupState(
  status,
  target,
  operationId,
  planId,
  checkoutIdentity
) {
  const operations = Array.isArray(status?.operations)
    ? status.operations.filter(
        (row) =>
          row?.id === operationId &&
          row?.planId === planId &&
          row?.state === 'completed' &&
          row?.repo === target.repo &&
          row?.name === target.name &&
          same(row.checkoutIdentity, checkoutIdentity)
      )
    : [];
  const views = Array.isArray(status?.views)
    ? status.views.filter(
        (row) =>
          row?.repo === target.repo &&
          row?.name === target.name &&
          row?.planId === planId
      )
    : [];
  if (operations.length !== 1 || views.length !== 1) {
    return null;
  }
  const [operation] = operations;
  const [view] = views;
  return view.state === 'completed' &&
    view.inputDigest === operation.inputDigest &&
    view.storeIdentity &&
    same(view.storeIdentity, operation.storeIdentity) &&
    same(view.checkoutIdentity, operation.checkoutIdentity)
    ? { operation, view }
    : null;
}

function operationIdentity(action, input) {
  if (action === 'apply') {
    return input.operationId ?? input.planId;
  }
  if (action === 'recover' || action === 'prepareRelease') {
    return input.operationId;
  }
}

function targetRequestFailure(target, request) {
  if (Object.hasOwn(request ?? {}, 'repo') && request.repo !== target?.repo) {
    return failure(
      'DEPENDENCY_FILE_INPUT_INVALID',
      'Dependency file target does not match the registered worktree'
    );
  }
  if (Object.hasOwn(request ?? {}, 'name') && request.name !== target?.name) {
    return failure(
      'DEPENDENCY_FILE_INPUT_INVALID',
      'Dependency file target does not match the registered worktree'
    );
  }
  return null;
}

function unknownMutationResult(action, input, invoked, knownResult, error) {
  const code = invoked
    ? 'DEPENDENCY_FILE_OUTCOME_UNKNOWN'
    : 'TARGET_LOCK_UNAVAILABLE';
  const knownOperationId =
    typeof knownResult?.operationId === 'string'
      ? knownResult.operationId
      : undefined;
  const thrownOperationId = errorField(error, 'operationId');
  const operationId =
    knownOperationId ??
    (typeof thrownOperationId === 'string' ? thrownOperationId : undefined) ??
    operationIdentity(action, input);
  return failure(code, serviceError(code).message, {
    ...(operationId ? { operationId } : {}),
    ...(action === 'release' ? { releaseId: input.releaseId } : {}),
  });
}

async function defaultEngineFactory(options) {
  let module;
  try {
    module = await import('./dependency-file-sharing.js');
  } catch (cause) {
    throw Object.assign(
      new Error('The dependency file engine is unavailable'),
      {
        cause,
        code: 'DEPENDENCY_FILE_ENGINE_UNAVAILABLE',
      }
    );
  }
  if (typeof module.createDependencyFileSharing !== 'function') {
    throw Object.assign(
      new Error('The dependency file engine is unavailable'),
      {
        code: 'DEPENDENCY_FILE_ENGINE_UNAVAILABLE',
      }
    );
  }
  return module.createDependencyFileSharing(options);
}

function serviceError(code) {
  const messages = {
    CHECKOUT_IDENTITY_CHANGED:
      'The registered checkout changed since this request was resolved',
    CHECKOUT_IDENTITY_UNKNOWN: 'Checkout identity could not be verified',
    DEPENDENCY_FILE_ENGINE_UNAVAILABLE:
      'Dependency file sharing is unavailable until its engine is integrated',
    DEPENDENCY_FILE_OUTCOME_UNKNOWN:
      'Dependency file operation outcome is uncertain; recover with the same identity',
    DEPENDENCY_FILE_POLICY_UNKNOWN:
      'Dependency file sharing policy could not be verified',
    DEPENDENCY_FILE_SERVICE_INVALID:
      'Dependency file service is not configured with required safeguards',
    DEPENDENCY_FILE_SHARING_DISABLED:
      'Dependency file sharing is not enabled for this worktree',
    TARGET_LOCK_UNAVAILABLE: 'Worktree operation lock could not be acquired',
    WORKTREE_NOT_FOUND: 'No registered worktree matches this request',
  };
  return new Error(messages[code] ?? 'Dependency file operation was refused');
}

function normalizedTarget(target, fresh) {
  return (
    object(target) &&
    object(fresh) &&
    target.repo === fresh.repo &&
    target.name === fresh.name &&
    target.key === `${target.repo}/${target.name}` &&
    fresh.key === target.key &&
    target.wtDir === fresh.wtDir &&
    target.repoDir === fresh.repoDir &&
    target.port === fresh.port &&
    target.checkoutIdentity?.known === true &&
    fresh.checkoutIdentity?.known === true &&
    same(target.checkoutIdentity, fresh.checkoutIdentity)
  );
}

function publicOptions(action, input) {
  const options = {};
  for (const key of ['planId', 'confirmation', 'operationId', 'releaseId']) {
    if (Object.hasOwn(input, key)) {
      options[key] = input[key];
    }
  }
  if (action === 'apply' && options.operationId === undefined) {
    options.operationId = options.planId;
  }
  return options;
}

function resultWithIdentity(result, action, input) {
  if (!object(result) || typeof result.ok !== 'boolean') {
    const identity = operationIdentity(action, input);
    return failure(
      'DEPENDENCY_FILE_OUTCOME_UNKNOWN',
      serviceError('DEPENDENCY_FILE_OUTCOME_UNKNOWN').message,
      {
        ...(identity ? { operationId: identity } : {}),
        ...(action === 'release' && input.releaseId
          ? { releaseId: input.releaseId }
          : {}),
      }
    );
  }
  const identity = operationIdentity(action, input);
  return {
    ...result,
    ...(identity && result.operationId === undefined
      ? { operationId: identity }
      : {}),
    ...(action === 'release' && result.releaseId === undefined
      ? { releaseId: input.releaseId }
      : {}),
  };
}

function validSetupContext(context, installerSettled) {
  const keys = [
    'admissionOperationId',
    'attemptId',
    'checkoutIdentity',
    'installerSettled',
    'target',
  ];
  return (
    object(context) &&
    Object.keys(context).length === keys.length &&
    Object.keys(context).every((key) => keys.includes(key)) &&
    typeof context.attemptId === 'string' &&
    context.attemptId.length > 0 &&
    typeof context.admissionOperationId === 'string' &&
    context.admissionOperationId.length > 0 &&
    context.installerSettled === installerSettled &&
    object(context.checkoutIdentity) &&
    context.checkoutIdentity.known === true &&
    object(context.target) &&
    Object.keys(context.target).length === 2 &&
    typeof context.target.repo === 'string' &&
    typeof context.target.name === 'string'
  );
}

// This is the one composition boundary for G4. HTTP, CLI and MCP callers use
// the same engine instance for a given central store policy.
export function createDependencyFileService({
  admission,
  assertMutable,
  config,
  engineFactory,
  kernelLease,
  native,
  now = Date.now,
  randomId = randomUUID,
  resolveTarget,
  setupProgress,
  state,
  withSetupRecoveryTarget,
} = {}) {
  if (
    !(
      state?.withTargets &&
      typeof config === 'function' &&
      typeof resolveTarget === 'function' &&
      typeof assertMutable === 'function' &&
      typeof now === 'function' &&
      typeof randomId === 'function'
    )
  ) {
    throw new TypeError(
      'Dependency file service requires state, policy, registered target resolution, and a mutable-target guard'
    );
  }

  const buildEngine = engineFactory ?? defaultEngineFactory;
  const engines = new Map();
  const setupEnrollments = new Map();
  const setupRecoveries = new Map();
  const setupPlanningRecoveries = new Map();

  async function freshTarget(target) {
    if (
      !(
        object(target) &&
        validPart(target.repo) &&
        validBranch(target.name) &&
        target.key === `${target.repo}/${target.name}`
      )
    ) {
      return {
        error: failure(
          'WORKTREE_NOT_FOUND',
          serviceError('WORKTREE_NOT_FOUND').message
        ),
      };
    }
    let fresh;
    try {
      fresh = await resolveTarget(target.repo, target.name);
    } catch {
      return {
        error: failure(
          'CHECKOUT_IDENTITY_UNKNOWN',
          serviceError('CHECKOUT_IDENTITY_UNKNOWN').message
        ),
      };
    }
    if (!fresh) {
      return {
        error: failure(
          'WORKTREE_NOT_FOUND',
          serviceError('WORKTREE_NOT_FOUND').message
        ),
      };
    }
    if (fresh.ok === false) {
      const code =
        fresh.code === 'CHECKOUT_IDENTITY_UNKNOWN'
          ? fresh.code
          : 'WORKTREE_NOT_FOUND';
      return { error: failure(code, serviceError(code).message) };
    }
    if (fresh.checkoutIdentity?.known !== true) {
      return {
        error: failure(
          'CHECKOUT_IDENTITY_UNKNOWN',
          serviceError('CHECKOUT_IDENTITY_UNKNOWN').message
        ),
      };
    }
    if (!normalizedTarget(target, fresh)) {
      return {
        error: failure(
          'CHECKOUT_IDENTITY_CHANGED',
          serviceError('CHECKOUT_IDENTITY_CHANGED').message
        ),
      };
    }
    return { target: fresh };
  }

  async function resolveNamedTarget(target) {
    if (
      !(object(target) && validPart(target.repo) && validBranch(target.name))
    ) {
      return {
        error: failure(
          'WORKTREE_NOT_FOUND',
          serviceError('WORKTREE_NOT_FOUND').message
        ),
      };
    }
    let fresh;
    try {
      fresh = await resolveTarget(target.repo, target.name);
    } catch {
      return {
        error: failure(
          'CHECKOUT_IDENTITY_UNKNOWN',
          serviceError('CHECKOUT_IDENTITY_UNKNOWN').message
        ),
      };
    }
    if (
      !object(fresh) ||
      fresh.repo !== target.repo ||
      fresh.name !== target.name ||
      fresh.key !== `${target.repo}/${target.name}`
    ) {
      return {
        error: failure(
          fresh?.checkoutIdentity?.known === false
            ? 'CHECKOUT_IDENTITY_UNKNOWN'
            : 'WORKTREE_NOT_FOUND',
          serviceError(
            fresh?.checkoutIdentity?.known === false
              ? 'CHECKOUT_IDENTITY_UNKNOWN'
              : 'WORKTREE_NOT_FOUND'
          ).message
        ),
      };
    }
    if (fresh.checkoutIdentity?.known !== true) {
      return {
        error: failure(
          'CHECKOUT_IDENTITY_UNKNOWN',
          serviceError('CHECKOUT_IDENTITY_UNKNOWN').message
        ),
      };
    }
    return { target: fresh };
  }

  async function configuredSharing(target) {
    let currentConfig;
    try {
      currentConfig = await config();
      const sharing = dependencySharingForTarget(
        currentConfig,
        target.repo,
        target.name
      );
      if (!sharing?.enabled) {
        const code = 'DEPENDENCY_FILE_SHARING_DISABLED';
        return { error: failure(code, serviceError(code).message) };
      }
      return { sharing };
    } catch {
      const code = 'DEPENDENCY_FILE_POLICY_UNKNOWN';
      return { error: failure(code, serviceError(code).message) };
    }
  }

  async function buildEngineFor(sharing, key) {
    try {
      const engine = await buildEngine({
        assertMutable: (guardTarget, details = {}) => {
          const setupContext = setupEnrollments.get(guardTarget?.key);
          const recovery = setupRecoveries.get(guardTarget?.key);
          const planningRecovery = setupPlanningRecoveries.get(
            guardTarget?.key
          );
          return assertMutable(guardTarget, {
            ...details,
            ...(setupContext ? { setupContext } : {}),
            ...(planningRecovery
              ? {
                  recoveryAttemptId: planningRecovery.attemptId,
                  setupContext: planningRecovery.setupContext,
                }
              : {}),
            ...(recovery?.setupContext
              ? {
                  recoveryOperationId: recovery.recoveryOperationId,
                  setupContext: recovery.setupContext,
                }
              : {}),
          });
        },
        ...(native === undefined ? {} : { native }),
        now,
        randomId,
        sharing,
        state,
      });
      const requiredMethods = [
        'prepare',
        'apply',
        'recover',
        'prepareRelease',
        'release',
        'status',
      ];
      if (
        !(
          engine &&
          requiredMethods.every(
            (method) => typeof engine[method] === 'function'
          )
        )
      ) {
        const code = 'DEPENDENCY_FILE_SERVICE_INVALID';
        return { error: failure(code, serviceError(code).message) };
      }
      engines.set(key, engine);
      return { engine };
    } catch (error) {
      const code =
        errorField(error, 'code') === 'DEPENDENCY_FILE_ENGINE_UNAVAILABLE'
          ? errorField(error, 'code')
          : 'DEPENDENCY_FILE_SERVICE_INVALID';
      return { error: failure(code, serviceError(code).message) };
    }
  }

  async function engineFor(target) {
    const configured = await configuredSharing(target);
    if (Object.hasOwn(configured, 'error')) {
      return configured;
    }
    const { sharing } = configured;
    let key;
    try {
      key = canonicalJson(sharing);
    } catch {
      const code = 'DEPENDENCY_FILE_POLICY_UNKNOWN';
      return { error: failure(code, serviceError(code).message) };
    }
    if (!engines.has(key)) {
      return buildEngineFor(sharing, key);
    }
    return { engine: engines.get(key) };
  }

  async function mutationGuard(target, details, identity, internal = {}) {
    try {
      const guard = await assertMutable(target, {
        ...details,
        ...(internal.setupContext
          ? { setupContext: internal.setupContext }
          : {}),
        ...(internal.recoveryOperationId
          ? { recoveryOperationId: internal.recoveryOperationId }
          : {}),
      });
      if (guard?.ok !== false) {
        return null;
      }
      return identity && guard.operationId === undefined
        ? { ...guard, operationId: identity }
        : guard;
    } catch (error) {
      const caughtCode = errorField(error, 'code');
      const code =
        typeof caughtCode === 'string' && serviceCodePattern.test(caughtCode)
          ? caughtCode
          : 'DEPENDENCY_FILE_SERVICE_INVALID';
      return failure(
        code,
        errorField(error, 'publicMessage') ?? serviceError(code).message,
        identity ? { operationId: identity } : {}
      );
    }
  }

  function invokeEngineAction(engine, action, target, options, guardPhase) {
    switch (action) {
      case 'prepare':
        return engine.prepare(target);
      case 'apply':
        return engine.apply(target, options, guardPhase);
      case 'recover':
        return engine.recover(target, options, guardPhase);
      case 'prepareRelease':
        return engine.prepareRelease(target, options);
      default:
        return engine.release(target, options);
    }
  }

  async function runLocked(
    action,
    target,
    parsed,
    options,
    onInvoke,
    internal = {}
  ) {
    const lockedTarget = await freshTarget(target);
    if (Object.hasOwn(lockedTarget, 'error')) {
      return { invoked: false, result: lockedTarget.error };
    }
    const identity = operationIdentity(action, parsed.value);
    const guardDetails = { phase: action };
    if (identity) {
      guardDetails.operationId = identity;
    }
    const guardResult = await mutationGuard(
      lockedTarget.target,
      guardDetails,
      identity,
      internal
    );
    if (guardResult) {
      return { invoked: false, result: guardResult };
    }
    const built = await engineFor(lockedTarget.target);
    if (Object.hasOwn(built, 'error')) {
      return { invoked: false, result: built.error };
    }
    onInvoke?.();
    const internalRecovery =
      typeof internal.recoveryOperationId === 'string' &&
      internal.recoveryOperationId === identity;
    const result = await invokeEngineAction(
      built.engine,
      action,
      lockedTarget.target,
      options,
      internalRecovery ? 'enroll-fresh' : undefined
    );
    return {
      invoked: true,
      result: resultWithIdentity(result, action, parsed.value),
    };
  }

  async function run(action, target, request = {}) {
    const targetError = targetRequestFailure(target, request);
    if (targetError !== null) {
      return targetError;
    }
    const parsed = validateDependencyFileInput(action, {
      ...request,
      name: target?.name,
      repo: target?.repo,
    });
    if (!parsed.ok) {
      return parsed;
    }
    const resolved = await freshTarget(target);
    if (Object.hasOwn(resolved, 'error')) {
      return resolved.error;
    }
    const options = publicOptions(action, parsed.value);
    const recovery =
      action === 'recover' || action === 'apply'
        ? setupRecoveryBinding(
            resolved.target,
            parsed.value.operationId ?? parsed.value.planId
          )
        : null;
    if (recovery?.error) {
      return recovery.error;
    }
    if (recovery?.binding) {
      return runSetupRecovery(
        action,
        resolved.target,
        parsed,
        options,
        recovery.binding
      );
    }
    let invoked = false;
    let knownResult;
    try {
      return await state.withTargets([resolved.target], async () => {
        const outcome = await runLocked(
          action,
          resolved.target,
          parsed,
          options,
          () => {
            invoked = true;
          }
        );
        ({ invoked } = outcome);
        knownResult = outcome.result;
        return outcome.result;
      });
    } catch (error) {
      return unknownMutationResult(
        action,
        parsed.value,
        invoked,
        knownResult,
        error
      );
    }
  }

  function setupRecord(target) {
    if (typeof setupProgress?.get !== 'function') {
      return null;
    }
    try {
      return setupProgress.get({ name: target.name, repo: target.repo });
    } catch {
      return null;
    }
  }

  function validEnrollmentBinding(record, target, requestedOperationId) {
    const enrollment = record?.dependencyEnrollment;
    return (
      ((record?.state === 'unknown' && record?.outcome === 'unknown') ||
        (record?.state === 'completed' && record?.outcome === 'completed')) &&
      record?.attemptId &&
      record?.target?.repo === target.repo &&
      record?.target?.name === target.name &&
      same(record.checkoutIdentity, target.checkoutIdentity) &&
      object(enrollment) &&
      enrollment.version === 1 &&
      enrollment.installerSettled === true &&
      typeof enrollment.admissionOperationId === 'string' &&
      typeof enrollment.operationId === 'string' &&
      digestPattern.test(enrollment.operationId) &&
      typeof enrollment.planId === 'string' &&
      digestPattern.test(enrollment.planId) &&
      enrollment.operationId === requestedOperationId &&
      enrollment.planId === requestedOperationId &&
      typeof enrollment.bunVersion === 'string' &&
      enrollment.bunVersion.length > 0
    );
  }

  function setupRecoveryBinding(target, requestedOperationId) {
    if (typeof setupProgress?.get !== 'function') {
      return { binding: null };
    }
    const record = setupRecord(target);
    if (!(record && ['unknown', 'completed'].includes(record.state))) {
      return { binding: null };
    }
    if (
      record.state === 'completed' &&
      record.dependencyEnrollment?.operationId !== requestedOperationId
    ) {
      return { binding: null };
    }
    if (!validEnrollmentBinding(record, target, requestedOperationId)) {
      return {
        error: failure(
          'DEPENDENCY_FILE_SETUP_BINDING_REQUIRED',
          'Recovery requires the exact unknown setup enrollment identity',
          { operationId: requestedOperationId }
        ),
      };
    }
    if (typeof admission?.recoverLease !== 'function') {
      return {
        error: failure(
          'DEPENDENCY_FILE_RECOVERY_UNAVAILABLE',
          'Exact setup admission recovery is unavailable'
        ),
      };
    }
    return {
      binding: {
        admissionOperationId: record.dependencyEnrollment.admissionOperationId,
        attemptId: record.attemptId,
        checkoutIdentity: record.checkoutIdentity,
        completed: record.state === 'completed',
        dependencyEnrollment: record.dependencyEnrollment,
        record,
        setupContext: {
          admissionOperationId:
            record.dependencyEnrollment.admissionOperationId,
          attemptId: record.attemptId,
          checkoutIdentity: record.checkoutIdentity,
          installerSettled: true,
          target: { name: target.name, repo: target.repo },
        },
      },
    };
  }

  function setupPlanningRecoveryBinding(target, request) {
    if (
      !object(request) ||
      Object.keys(request).length !== 2 ||
      typeof request.attemptId !== 'string' ||
      !request.attemptId ||
      !object(request.checkoutIdentity)
    ) {
      return {
        error: failure(
          'SETUP_PROGRESS_INVALID',
          'Setup recovery identity is invalid'
        ),
      };
    }
    const record = setupRecord(target);
    const enrollment = record?.dependencyEnrollment;
    if (
      record?.state === 'unknown' &&
      record?.outcome === 'unknown' &&
      String(record.stage ?? '').startsWith('dependency-enrollment') &&
      record.attemptId === request.attemptId &&
      same(record.checkoutIdentity, request.checkoutIdentity) &&
      same(record.target, { name: target.name, repo: target.repo }) &&
      object(enrollment) &&
      enrollment.operationId !== undefined &&
      enrollment.planId !== undefined
    ) {
      return {
        error: failure(
          'DEPENDENCY_ENROLLMENT_RECONCILIATION_REQUIRED',
          'The bound enrollment operation must be recovered by its existing identity',
          {
            operationId: enrollment.operationId,
            planId: enrollment.planId,
          }
        ),
      };
    }
    if (
      !(
        record?.state === 'unknown' &&
        record?.outcome === 'unknown' &&
        String(record.stage ?? '').startsWith('dependency-enrollment')
      ) ||
      record.attemptId !== request.attemptId ||
      !same(record.checkoutIdentity, request.checkoutIdentity) ||
      !same(record.target, { name: target.name, repo: target.repo }) ||
      !object(enrollment) ||
      enrollment.version !== 1 ||
      enrollment.installerSettled !== true ||
      typeof enrollment.admissionOperationId !== 'string' ||
      !enrollment.admissionOperationId ||
      typeof enrollment.bunVersion !== 'string' ||
      !enrollment.bunVersion ||
      Object.hasOwn(enrollment, 'operationId') ||
      Object.hasOwn(enrollment, 'planId')
    ) {
      return {
        error: failure(
          'DEPENDENCY_FILE_SETUP_BINDING_REQUIRED',
          'Planning recovery requires the exact unknown setup attempt with a settled installer and no enrollment IDs'
        ),
      };
    }
    if (typeof admission?.recoverLease !== 'function') {
      return {
        error: failure(
          'DEPENDENCY_FILE_RECOVERY_UNAVAILABLE',
          'Exact setup admission recovery is unavailable'
        ),
      };
    }
    return {
      binding: {
        admissionOperationId: enrollment.admissionOperationId,
        attemptId: record.attemptId,
        checkoutIdentity: record.checkoutIdentity,
        dependencyEnrollment: enrollment,
        record,
        setupContext: {
          admissionOperationId: enrollment.admissionOperationId,
          attemptId: record.attemptId,
          checkoutIdentity: record.checkoutIdentity,
          installerSettled: true,
          target: { name: target.name, repo: target.repo },
        },
      },
    };
  }

  async function bindPlanningRecoveryPlan(target, binding, context, plan) {
    if (
      !object(plan) ||
      typeof plan.id !== 'string' ||
      !digestPattern.test(plan.id) ||
      (plan.operationId !== undefined && plan.operationId !== plan.id)
    ) {
      return failure(
        'DEPENDENCY_FILE_SETUP_BINDING_INVALID',
        'Enrollment plan identity is invalid'
      );
    }
    const record = setupRecord(target);
    if (
      !(record?.state === 'unknown' && record?.outcome === 'unknown') ||
      record.attemptId !== binding.attemptId ||
      !same(record.checkoutIdentity, binding.checkoutIdentity) ||
      !same(record.dependencyEnrollment, binding.dependencyEnrollment)
    ) {
      return failure(
        'DEPENDENCY_FILE_SETUP_BINDING_CONFLICT',
        'The original setup enrollment binding changed'
      );
    }
    const bound = await setupProgress.bindEnrollment({
      attemptId: binding.attemptId,
      checkoutIdentity: binding.checkoutIdentity,
      dependencyEnrollment: {
        ...binding.dependencyEnrollment,
        operationId: plan.id,
        planId: plan.id,
      },
      target: { name: target.name, repo: target.repo },
    });
    if (
      bound?.ok !== true ||
      bound.record?.dependencyEnrollment?.operationId !== plan.id ||
      bound.record?.dependencyEnrollment?.planId !== plan.id
    ) {
      return failure(
        bound?.code ?? 'DEPENDENCY_FILE_SETUP_BINDING_UNKNOWN',
        bound?.error ?? 'Enrollment plan identity could not be bound'
      );
    }
    setupPlanningRecoveries.delete(target.key);
    setupRecoveries.set(target.key, {
      recoveryOperationId: plan.id,
      setupContext: context,
    });
    return { ok: true, operationId: plan.id };
  }

  async function setupStatusIsUnshared(target) {
    const built = await engineFor(target);
    if (Object.hasOwn(built, 'error')) {
      return { error: built.error };
    }
    const before = await built.engine.status(target);
    if (before?.ok !== true || !Array.isArray(before.operations)) {
      return {
        error: failure(
          'DEPENDENCY_FILE_STATUS_UNKNOWN',
          'Existing dependency operations could not be ruled out'
        ),
      };
    }
    if (before.operations.length !== 0) {
      return {
        error: failure(
          'DEPENDENCY_FILE_OPERATION_RECONCILIATION_REQUIRED',
          'An existing dependency operation requires exact reconciliation before setup can continue',
          { operations: before.operations }
        ),
      };
    }
    if (before.state !== 'unshared') {
      return {
        error: failure(
          'DEPENDENCY_FILE_STATUS_UNKNOWN',
          'Existing dependency operations could not be ruled out'
        ),
      };
    }
    return { engine: built.engine };
  }

  async function finishPlanningRecovery(
    target,
    binding,
    lease,
    result,
    planId
  ) {
    if (result?.ok !== true || result.state !== 'completed') {
      return {
        ...result,
        ...(planId ? { operationId: planId, planId } : {}),
        setupRecoveryComplete: false,
      };
    }
    if (!planId) {
      return failure(
        'DEPENDENCY_FILE_SETUP_BINDING_UNKNOWN',
        'Enrollment completed without a durable setup identity',
        { setupRecoveryComplete: false }
      );
    }
    const finished = await finishSetupRecovery(
      {
        ...binding,
        dependencyEnrollment: {
          ...binding.dependencyEnrollment,
          operationId: planId,
          planId,
        },
      },
      target,
      planId
    );
    if (finished.ok !== true) {
      return { ...finished, setupRecoveryComplete: false };
    }
    const released = await admission.release(lease);
    if (released?.ok !== true && !(await confirmAdmissionReleased(binding))) {
      return failure(
        released?.code ?? 'ADMISSION_RELEASE_UNKNOWN',
        released?.error ?? 'Exact setup admission release is unresolved',
        { operationId: planId, setupRecoveryComplete: false }
      );
    }
    if (!(await confirmAdmissionReleased(binding))) {
      return failure(
        'ADMISSION_RELEASE_UNKNOWN',
        'Exact setup admission release is unresolved',
        { operationId: planId, setupRecoveryComplete: false }
      );
    }
    return { ...finished, setupRecoveryComplete: true, state: 'completed' };
  }

  async function continuePlanningRecovery(target, binding, context, lease) {
    const statusResult = await setupStatusIsUnshared(target);
    if (Object.hasOwn(statusResult, 'error')) {
      return statusResult.error;
    }
    const guard = await assertMutable(target, {
      phase: 'enroll-fresh',
      recoveryAttemptId: binding.attemptId,
      setupContext: context,
    });
    if (guard === false || guard?.ok === false) {
      return guard?.ok === false
        ? guard
        : failure('DEPENDENCY_FILE_TARGET_BUSY', 'Setup target is busy');
    }
    setupPlanningRecoveries.set(target.key, {
      attemptId: binding.attemptId,
      setupContext: context,
    });
    let planIdentity;
    const result = await statusResult.engine.enrollFresh(
      target,
      {
        onPlan: async (plan) => {
          const bound = await bindPlanningRecoveryPlan(
            target,
            binding,
            context,
            plan
          );
          if (bound.ok) {
            planIdentity = bound.operationId;
          }
          return bound;
        },
      },
      'enroll-fresh'
    );
    return finishPlanningRecovery(target, binding, lease, result, planIdentity);
  }

  async function resumeSetupEnrollment(target, request) {
    const targetError = targetRequestFailure(target, request);
    if (targetError !== null) {
      return targetError;
    }
    const resolved = await resolveNamedTarget(target);
    if (Object.hasOwn(resolved, 'error')) {
      return resolved.error;
    }
    if (!same(request?.checkoutIdentity, resolved.target.checkoutIdentity)) {
      return failure(
        'CHECKOUT_IDENTITY_MISMATCH',
        'The setup recovery checkout identity does not match the registered worktree'
      );
    }
    const bindingResult = setupPlanningRecoveryBinding(
      resolved.target,
      request
    );
    if (!('binding' in bindingResult)) {
      return bindingResult.error;
    }
    const { binding } = bindingResult;
    const configured = await configuredSharing(resolved.target);
    if (Object.hasOwn(configured, 'error')) {
      return configured.error;
    }
    const context = {
      ...binding.setupContext,
      recoveryAttemptId: binding.attemptId,
      recoveryEnrollment: binding.dependencyEnrollment,
    };
    const underTargetLock = async () => {
      const lease = await exactAdmissionLease(binding, resolved.target);
      if (!lease) {
        throw Object.assign(
          new Error('Exact setup admission lease is missing'),
          {
            code: 'ADMISSION_LEASE_MISSING',
          }
        );
      }
      const recovered = await admission.recoverLease(lease);
      if (recovered?.ok !== true) {
        throw Object.assign(new Error('Setup admission recovery was refused'), {
          code: recovered?.code ?? 'ADMISSION_RECOVERY_UNKNOWN',
        });
      }
      setupPlanningRecoveries.set(resolved.target.key, {
        attemptId: binding.attemptId,
        setupContext: context,
      });
      try {
        const guard = await assertMutable(resolved.target, {
          phase: 'enroll-fresh',
          recoveryAttemptId: binding.attemptId,
          setupContext: context,
        });
        if (guard === false || guard?.ok === false) {
          return guard?.ok === false
            ? guard
            : failure('DEPENDENCY_FILE_TARGET_BUSY', 'Setup target is busy');
        }
        return await continuePlanningRecovery(
          resolved.target,
          binding,
          context,
          recovered.lease ?? lease
        );
      } finally {
        setupPlanningRecoveries.delete(resolved.target.key);
        setupRecoveries.delete(resolved.target.key);
      }
    };
    try {
      return typeof withSetupRecoveryTarget === 'function'
        ? await withSetupRecoveryTarget(resolved.target, () =>
            withKernelRecoveryLease(
              configured,
              resolved.target,
              underTargetLock
            )
          )
        : await state.withTargets([resolved.target], () =>
            withKernelRecoveryLease(
              configured,
              resolved.target,
              underTargetLock
            )
          );
    } catch (error) {
      const code =
        errorField(error, 'code') ?? 'DEPENDENCY_FILE_OUTCOME_UNKNOWN';
      return failure(code, serviceError(code).message, {
        setupRecoveryComplete: false,
      });
    }
  }

  async function exactAdmissionLease(binding, target) {
    const admissionStatus = await admission.status();
    if (
      admissionStatus?.ok !== true ||
      !Array.isArray(admissionStatus.leases)
    ) {
      throw Object.assign(new Error('Admission state is unresolved'), {
        code: 'ADMISSION_STATE_UNKNOWN',
      });
    }
    const matches = admissionStatus.leases.filter(
      (row) => row?.operationId === binding.admissionOperationId
    );
    if (matches.length === 0 && binding.completed) {
      return null;
    }
    if (matches.length !== 1) {
      throw Object.assign(new Error('Exact setup admission lease is missing'), {
        code: 'ADMISSION_LEASE_MISSING',
      });
    }
    const [lease] = matches;
    if (
      lease.kind !== 'install' ||
      lease.target?.repo !== target.repo ||
      lease.target?.name !== target.name
    ) {
      throw Object.assign(new Error('Setup admission lease identity changed'), {
        code: 'ADMISSION_LEASE_MISMATCH',
      });
    }
    return lease;
  }

  async function recoverSetupAdmission(binding, target) {
    const lease = await exactAdmissionLease(binding, target);
    if (lease === null) {
      return null;
    }
    const recovered = await admission.recoverLease(lease);
    if (recovered?.ok !== true) {
      throw Object.assign(
        new Error('Setup admission lease recovery was refused'),
        {
          code: recovered?.code ?? 'ADMISSION_RECOVERY_UNKNOWN',
        }
      );
    }
    return recovered.lease ?? lease;
  }

  async function confirmAdmissionReleased(binding) {
    const admissionStatus = await admission.status();
    if (
      admissionStatus?.ok !== true ||
      !Array.isArray(admissionStatus.leases)
    ) {
      return false;
    }
    return !admissionStatus.leases.some(
      (row) => row?.operationId === binding.admissionOperationId
    );
  }

  async function finishSetupRecovery(binding, target, operationId) {
    const built = await engineFor(target);
    if (Object.hasOwn(built, 'error')) {
      return built.error;
    }
    const current = await built.engine.status(target);
    const completed = completedSetupState(
      current,
      target,
      operationId,
      binding.dependencyEnrollment.planId,
      binding.checkoutIdentity
    );
    if (!completed) {
      return failure(
        'DEPENDENCY_FILE_COMPLETION_UNCONFIRMED',
        'The bound dependency enrollment is not durably complete',
        { operationId }
      );
    }
    const { view } = completed;
    let dependencyReceipt;
    const { installInputs } = binding.record.dependencyEnrollment;
    if (installInputs !== undefined) {
      try {
        const receipt = await createDependencyReceipt({
          attemptId: binding.attemptId,
          bunVersion: binding.record.dependencyEnrollment.bunVersion,
          checkoutIdentity: binding.checkoutIdentity,
          dependencyFiles: view,
          installInputs,
          state,
          wtDir: target.wtDir,
        });
        if (receipt.ok === true) {
          dependencyReceipt = receipt.receipt;
        }
      } catch {
        // Completed enrollment remains usable but unverified without its saved observation.
      }
    }
    const finished = await setupProgress.finishEnrollment({
      attemptId: binding.attemptId,
      checkoutIdentity: binding.checkoutIdentity,
      operationId,
      ...(dependencyReceipt ? { dependencyReceipt } : {}),
      target: { name: target.name, repo: target.repo },
    });
    if (finished?.ok !== true) {
      return failure(
        finished?.code ?? 'SETUP_COMPLETION_UNKNOWN',
        finished?.error ?? 'Setup enrollment completion could not be confirmed',
        { operationId }
      );
    }
    return { ok: true, operationId, setupVerified: Boolean(dependencyReceipt) };
  }

  async function validateCompletedSetupBinding(binding, target) {
    const built = await engineFor(target);
    if (Object.hasOwn(built, 'error')) {
      return built.error;
    }
    const current = await built.engine.status(target);
    return completedSetupState(
      current,
      target,
      binding.dependencyEnrollment.operationId,
      binding.dependencyEnrollment.planId,
      binding.checkoutIdentity
    )
      ? null
      : failure(
          'DEPENDENCY_FILE_COMPLETION_UNCONFIRMED',
          'The setup completion binding no longer matches its durable dependency view',
          {
            operationId: binding.dependencyEnrollment.operationId,
            setupRecoveryComplete: false,
          }
        );
  }

  function completedSetupRecoveryGuard(binding, target) {
    return mutationGuard(
      target,
      {
        operationId: binding.dependencyEnrollment.operationId,
        phase: 'recover',
      },
      binding.dependencyEnrollment.operationId,
      {
        recoveryOperationId: binding.dependencyEnrollment.operationId,
        setupContext: binding.setupContext,
      }
    );
  }

  async function releaseSetupAdmissionLease(binding, target, lease) {
    const recovered = await admission.recoverLease(lease);
    if (recovered?.ok !== true) {
      return failure(
        recovered?.code ?? 'ADMISSION_RECOVERY_UNKNOWN',
        recovered?.error ??
          'The exact setup admission lease could not be recovered'
      );
    }
    const guard = await completedSetupRecoveryGuard(binding, target);
    if (guard) {
      return guard;
    }
    const released = await admission.release(recovered.lease ?? lease);
    if (released?.ok !== true && !(await confirmAdmissionReleased(binding))) {
      return failure(
        released?.code ?? 'ADMISSION_RELEASE_UNKNOWN',
        released?.error ?? 'The exact setup admission release is unresolved'
      );
    }
    return (await confirmAdmissionReleased(binding))
      ? { ok: true }
      : failure(
          'ADMISSION_RELEASE_UNKNOWN',
          'The exact setup admission release is unresolved'
        );
  }

  async function releaseCompletedSetupAdmission(binding, target) {
    if (await confirmAdmissionReleased(binding)) {
      const guard = await completedSetupRecoveryGuard(binding, target);
      return guard ?? { ok: true };
    }
    const lease = await exactAdmissionLease(binding, target);
    if (!lease) {
      return failure(
        'ADMISSION_STATE_UNKNOWN',
        'The exact setup admission lease state is unresolved'
      );
    }
    return releaseSetupAdmissionLease(binding, target, lease);
  }

  async function completePreviouslyFinishedSetup(binding, target) {
    const invalid = await validateCompletedSetupBinding(binding, target);
    if (invalid) {
      return invalid;
    }
    const released = await releaseCompletedSetupAdmission(binding, target);
    return released.ok === true
      ? {
          ok: true,
          operationId: binding.dependencyEnrollment.operationId,
          setupRecoveryComplete: true,
          state: 'completed',
        }
      : failure(released.code, released.error, {
          operationId: binding.dependencyEnrollment.operationId,
          setupRecoveryComplete: false,
        });
  }

  async function resumeUnknownSetup(action, target, parsed, options, binding) {
    const lease = await recoverSetupAdmission(binding, target);
    const internal = {
      recoveryOperationId: binding.dependencyEnrollment.operationId,
      setupContext: binding.setupContext,
    };
    setupRecoveries.set(target.key, internal);
    try {
      const { result } = await runLocked(
        action,
        target,
        parsed,
        options,
        undefined,
        internal
      );
      if (
        action === 'recover' ||
        result?.ok !== true ||
        result.state !== 'completed'
      ) {
        return { ...result, setupRecoveryComplete: false };
      }
      const finished = await finishSetupRecovery(
        binding,
        target,
        binding.dependencyEnrollment.operationId
      );
      if (finished.ok !== true) {
        return { ...finished, setupRecoveryComplete: false };
      }
      const released = await admission.release(lease);
      if (released?.ok !== true && !(await confirmAdmissionReleased(binding))) {
        return failure(
          released?.code ?? 'ADMISSION_RELEASE_UNKNOWN',
          released?.error ?? 'Exact setup admission release is unresolved',
          { operationId: binding.dependencyEnrollment.operationId }
        );
      }
      if (!(await confirmAdmissionReleased(binding))) {
        return failure(
          'ADMISSION_RELEASE_UNKNOWN',
          'Exact setup admission release is unresolved',
          { operationId: binding.dependencyEnrollment.operationId }
        );
      }
      return { ...finished, setupRecoveryComplete: true, state: 'completed' };
    } finally {
      setupRecoveries.delete(target.key);
    }
  }

  async function withKernelRecoveryLease(configured, target, work) {
    let withLease = kernelLease ?? native?.withDependencyFileLease;
    if (withLease === undefined) {
      try {
        ({ withDependencyFileLease: withLease } = await import(
          './dependency-file-native.js'
        ));
      } catch {
        withLease = null;
      }
    }
    if (typeof withLease !== 'function') {
      return failure(
        'DEPENDENCY_FILE_LEASE_UNAVAILABLE',
        'Kernel dependency-file lease support is unavailable'
      );
    }
    try {
      return await withLease(configured.sharing.storeRoot, target.wtDir, work);
    } catch (error) {
      const code =
        errorField(error, 'code') ?? 'DEPENDENCY_FILE_OUTCOME_UNKNOWN';
      return failure(code, serviceError(code).message, {
        operationId: errorField(error, 'operationId'),
        setupRecoveryComplete: false,
      });
    }
  }

  async function runSetupRecovery(action, target, parsed, options, binding) {
    const configured = await configuredSharing(target);
    if (Object.hasOwn(configured, 'error')) {
      return configured.error;
    }
    const underTargetLock = () =>
      withKernelRecoveryLease(configured, target, async () =>
        binding.completed
          ? completePreviouslyFinishedSetup(binding, target)
          : resumeUnknownSetup(action, target, parsed, options, binding)
      );
    try {
      return typeof withSetupRecoveryTarget === 'function'
        ? await withSetupRecoveryTarget(target, underTargetLock)
        : await state.withTargets([target], underTargetLock);
    } catch (error) {
      const code = errorField(error, 'code') ?? 'TARGET_LOCK_UNAVAILABLE';
      return failure(code, serviceError(code).message, {
        operationId: binding.dependencyEnrollment.operationId,
        setupRecoveryComplete: false,
      });
    }
  }

  async function status(target) {
    const resolved = await freshTarget(target);
    if (Object.hasOwn(resolved, 'error')) {
      return resolved.error;
    }
    const built = await engineFor(resolved.target);
    if (Object.hasOwn(built, 'error')) {
      if (built.error.code === 'DEPENDENCY_FILE_SHARING_DISABLED') {
        return { enabled: false, ok: true, state: 'disabled' };
      }
      return built.error;
    }
    try {
      const result = await built.engine.status(resolved.target);
      return object(result) && typeof result.ok === 'boolean'
        ? result
        : failure(
            'DEPENDENCY_FILE_STATUS_UNKNOWN',
            'Dependency file status could not be confirmed'
          );
    } catch {
      return failure(
        'DEPENDENCY_FILE_STATUS_UNKNOWN',
        'Dependency file status could not be confirmed'
      );
    }
  }

  function validFreshSetupRequest(target, setupContext, installerSettled) {
    return (
      object(target) &&
      Object.keys(target).length === 2 &&
      Object.keys(target).every((key) => ['repo', 'name'].includes(key)) &&
      validSetupContext(setupContext, installerSettled) &&
      same(setupContext.target, target)
    );
  }

  async function resolveFreshSetupTarget(target, setupContext) {
    const resolved = await resolveNamedTarget(target);
    if (Object.hasOwn(resolved, 'error')) {
      return resolved;
    }
    if (
      !same(setupContext.checkoutIdentity, resolved.target.checkoutIdentity)
    ) {
      return {
        error: failure(
          'CHECKOUT_IDENTITY_CHANGED',
          serviceError('CHECKOUT_IDENTITY_CHANGED').message
        ),
      };
    }
    return resolved;
  }

  async function guardFreshSetupTarget(target, setupContext, phase) {
    try {
      const guard = await assertMutable(target, {
        operationId: setupContext.admissionOperationId,
        phase,
        setupContext,
      });
      return guard?.ok === false ? guard : null;
    } catch (error) {
      const code =
        typeof errorField(error, 'code') === 'string' &&
        serviceCodePattern.test(errorField(error, 'code'))
          ? errorField(error, 'code')
          : 'DEPENDENCY_FILE_SERVICE_INVALID';
      return failure(
        code,
        errorField(error, 'publicMessage') ?? serviceError(code).message
      );
    }
  }

  async function withFreshSetupTarget(target, setupContext, phase, work) {
    const resolved = await resolveFreshSetupTarget(target, setupContext);
    if (Object.hasOwn(resolved, 'error')) {
      return resolved.error;
    }
    return state.withTargets([resolved.target], async () => {
      const current = await resolveFreshSetupTarget(target, setupContext);
      if (Object.hasOwn(current, 'error')) {
        return current.error;
      }
      const guard = await guardFreshSetupTarget(
        current.target,
        setupContext,
        phase
      );
      return guard ?? work(current.target);
    });
  }

  async function freshEnrollmentSetup(target, setupContext) {
    const built = await engineFor(target);
    if (Object.hasOwn(built, 'error')) {
      return built.error;
    }
    if (typeof built.engine.enrollFresh !== 'function') {
      return failure(
        'DEPENDENCY_FILE_SERVICE_INVALID',
        serviceError('DEPENDENCY_FILE_SERVICE_INVALID').message
      );
    }
    if (typeof setupProgress?.bindEnrollment !== 'function') {
      return failure(
        'DEPENDENCY_FILE_SETUP_BINDING_UNAVAILABLE',
        'Durable setup enrollment binding is unavailable'
      );
    }
    const currentRecord = setupRecord(target);
    if (
      !object(currentRecord) ||
      currentRecord.state !== 'running' ||
      currentRecord.attemptId !== setupContext.attemptId ||
      !same(currentRecord.checkoutIdentity, setupContext.checkoutIdentity) ||
      !object(currentRecord.dependencyEnrollment) ||
      currentRecord.dependencyEnrollment.installerSettled !== true ||
      currentRecord.dependencyEnrollment.admissionOperationId !==
        setupContext.admissionOperationId
    ) {
      return failure(
        'DEPENDENCY_FILE_SETUP_BINDING_REQUIRED',
        'Fresh enrollment requires the exact durable installer settlement'
      );
    }
    return { currentRecord, engine: built.engine };
  }

  async function invokeFreshEnrollment(
    target,
    setupContext,
    currentRecord,
    engine
  ) {
    let enrollmentIdentity;
    try {
      const result = await engine.enrollFresh(
        target,
        {
          onPlan: async (plan) => {
            enrollmentIdentity = await bindFreshEnrollmentPlan(
              target,
              setupContext,
              currentRecord,
              plan
            );
          },
        },
        'enroll-fresh'
      );
      return object(result) && typeof result.ok === 'boolean'
        ? {
            ...result,
            ...(enrollmentIdentity
              ? { operationId: enrollmentIdentity, planId: enrollmentIdentity }
              : {}),
          }
        : failure(
            'DEPENDENCY_FILE_OUTCOME_UNKNOWN',
            serviceError('DEPENDENCY_FILE_OUTCOME_UNKNOWN').message,
            enrollmentIdentity
              ? { operationId: enrollmentIdentity, planId: enrollmentIdentity }
              : {}
          );
    } catch (error) {
      const code =
        errorField(error, 'code') ?? 'DEPENDENCY_FILE_OUTCOME_UNKNOWN';
      const persistedEnrollment = setupRecord(target)?.dependencyEnrollment;
      const knownIdentity =
        enrollmentIdentity ??
        (persistedEnrollment?.operationId === persistedEnrollment?.planId &&
        digestPattern.test(persistedEnrollment?.operationId)
          ? persistedEnrollment.operationId
          : undefined);
      return failure(
        code,
        serviceError(code).message,
        knownIdentity
          ? { operationId: knownIdentity, planId: knownIdentity }
          : {}
      );
    }
  }

  async function enrollFreshLocked(target, setupContext, markInvoked) {
    const setup = await freshEnrollmentSetup(target, setupContext);
    if (setup.ok === false) {
      return setup;
    }
    setupEnrollments.set(target.key, setupContext);
    markInvoked();
    try {
      return await invokeFreshEnrollment(
        target,
        setupContext,
        setup.currentRecord,
        setup.engine
      );
    } finally {
      if (setupEnrollments.get(target.key) === setupContext) {
        setupEnrollments.delete(target.key);
      }
    }
  }

  async function bindFreshEnrollmentPlan(
    target,
    setupContext,
    currentRecord,
    plan
  ) {
    if (
      !(object(plan) && digestPattern.test(plan.id)) ||
      (plan.operationId !== undefined && plan.id !== plan.operationId)
    ) {
      throw Object.assign(new Error('Enrollment plan identity is invalid'), {
        code: 'DEPENDENCY_FILE_SETUP_BINDING_INVALID',
      });
    }
    const dependencyEnrollment = {
      ...currentRecord.dependencyEnrollment,
      operationId: plan.id,
      planId: plan.id,
    };
    const bound = await setupProgress.bindEnrollment({
      attemptId: setupContext.attemptId,
      checkoutIdentity: setupContext.checkoutIdentity,
      dependencyEnrollment,
      target: { name: target.name, repo: target.repo },
    });
    if (
      bound?.ok !== true ||
      bound.record?.dependencyEnrollment?.operationId !== plan.id ||
      bound.record?.dependencyEnrollment?.planId !== plan.id
    ) {
      throw Object.assign(
        new Error('Enrollment identity could not be durably bound'),
        { code: bound?.code ?? 'DEPENDENCY_FILE_SETUP_BINDING_UNKNOWN' }
      );
    }
    return plan.id;
  }

  async function enrollFresh(target, setupContext) {
    if (!validFreshSetupRequest(target, setupContext, true)) {
      return failure(
        'DEPENDENCY_FILE_SETUP_CONTEXT_INVALID',
        'Fresh enrollment requires a confirmed durable setup settlement'
      );
    }
    let invoked = false;
    try {
      return await withFreshSetupTarget(
        target,
        setupContext,
        'enroll-fresh',
        (lockedTarget) =>
          enrollFreshLocked(lockedTarget, setupContext, () => {
            invoked = true;
          })
      );
    } catch (error) {
      const persistedEnrollment = setupRecord({
        name: setupContext.target.name,
        repo: setupContext.target.repo,
      })?.dependencyEnrollment;
      const operationId =
        errorField(error, 'operationId') ??
        (persistedEnrollment?.operationId === persistedEnrollment?.planId &&
        digestPattern.test(persistedEnrollment?.operationId)
          ? persistedEnrollment.operationId
          : undefined);
      return failure(
        invoked ? 'DEPENDENCY_FILE_OUTCOME_UNKNOWN' : 'TARGET_LOCK_UNAVAILABLE',
        serviceError(
          invoked
            ? 'DEPENDENCY_FILE_OUTCOME_UNKNOWN'
            : 'TARGET_LOCK_UNAVAILABLE'
        ).message,
        typeof operationId === 'string' && digestPattern.test(operationId)
          ? { operationId }
          : {}
      );
    }
  }

  async function verifyFreshSetupCapability(target) {
    const built = await engineFor(target);
    if (Object.hasOwn(built, 'error')) {
      return built.error;
    }
    const capability = await built.engine.status(target);
    if (capability?.ok !== true) {
      return failure(
        typeof capability?.code === 'string' &&
          serviceCodePattern.test(capability.code)
          ? capability.code
          : 'DEPENDENCY_FILE_STATUS_UNKNOWN',
        'Dependency store or journal preflight could not be confirmed'
      );
    }
    if (capability.native?.available !== true) {
      return failure(
        capability?.native?.code ?? 'DEPENDENCY_FILE_NATIVE_UNAVAILABLE',
        'Native dependency-file helper is unavailable'
      );
    }
    const currentConfig = await config();
    const sharing = dependencySharingForTarget(
      currentConfig,
      target.repo,
      target.name
    );
    if (!sharing?.enabled || typeof sharing.storeRoot !== 'string') {
      return failure(
        'DEPENDENCY_FILE_SHARING_DISABLED',
        serviceError('DEPENDENCY_FILE_SHARING_DISABLED').message
      );
    }
    const [checkoutInfo, storeInfo] = await Promise.all([
      stat(target.wtDir),
      stat(sharing.storeRoot),
    ]);
    if (
      checkoutInfo.dev !== storeInfo.dev ||
      (sharing.storeIdentity?.device !== undefined &&
        sharing.storeIdentity.device !== storeInfo.dev)
    ) {
      return failure(
        'DEPENDENCY_FILE_VOLUME_MISMATCH',
        'Checkout and dependency store are not on the configured volume'
      );
    }
    return { native: capability.native, ok: true, target: target.key };
  }

  async function preflight(target, setupContext) {
    if (!validFreshSetupRequest(target, setupContext, false)) {
      return failure(
        'DEPENDENCY_FILE_SETUP_CONTEXT_INVALID',
        'Fresh setup preflight requires the exact active setup identity'
      );
    }
    try {
      return await withFreshSetupTarget(
        target,
        setupContext,
        'enroll-preflight',
        verifyFreshSetupCapability
      );
    } catch {
      return failure(
        'TARGET_LOCK_UNAVAILABLE',
        serviceError('TARGET_LOCK_UNAVAILABLE').message
      );
    }
  }

  return Object.freeze({
    apply: (target, input) => run('apply', target, input),
    enrollFresh,
    preflight,
    prepare: (target, input) => run('prepare', target, input),
    prepareRelease: (target, input) => run('prepareRelease', target, input),
    recover: (target, input) => run('recover', target, input),
    release: (target, input) => run('release', target, input),
    resumeSetupEnrollment,
    status,
  });
}

export { validateDependencyFileInput };
