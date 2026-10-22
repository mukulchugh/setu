import {
  dependencyInstallInputsMatch,
  validateDependencyInstallInputs,
  validateDependencyReceipt,
} from './dependency-readiness.js';

const OPERATION_ID = /^[a-f0-9]{64}$/;
const MAX_ENROLLMENT_BYTES = 256 * 1024;

function validTarget(target) {
  return (
    target &&
    typeof target.repo === 'string' &&
    target.repo &&
    typeof target.name === 'string' &&
    target.name
  );
}

function keyFor(target) {
  return `${target.repo}/${target.name}`;
}

function validText(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 512;
}

function validIdentity(value) {
  return (
    validText(value) ||
    (value && typeof value === 'object' && !Array.isArray(value))
  );
}

function sameIdentity(a, b) {
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
      (key, index) => key === bKeys[index] && sameIdentity(a[key], b[key])
    )
  );
}

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function boundedPlainData(value, depth = 0, budget = { nodes: 0 }) {
  budget.nodes += 1;
  if (depth > 24 || budget.nodes > 20_000) {
    return false;
  }
  if (
    value === null ||
    typeof value === 'boolean' ||
    (typeof value === 'number' && Number.isSafeInteger(value))
  ) {
    return true;
  }
  if (typeof value === 'string') {
    return value.length <= 16_384;
  }
  if (Array.isArray(value)) {
    return (
      value.length <= 4096 &&
      value.every((entry) => boundedPlainData(entry, depth + 1, budget))
    );
  }
  if (!isPlainObject(value) || Object.keys(value).length > 4096) {
    return false;
  }
  return Object.entries(value).every(
    ([key, entry]) =>
      key.length > 0 &&
      key.length <= 256 &&
      !['__proto__', 'prototype', 'constructor'].includes(key) &&
      boundedPlainData(entry, depth + 1, budget)
  );
}

function validInstallInputs(value, bunVersion) {
  return (
    validateDependencyInstallInputs(value) &&
    boundedPlainData(value) &&
    Buffer.byteLength(JSON.stringify(value)) <= MAX_ENROLLMENT_BYTES &&
    value.bunVersion === bunVersion &&
    typeof value.bunVersion === 'string'
  );
}

function validEnrollment(value) {
  const required = [
    'version',
    'admissionOperationId',
    'installerSettled',
    'bunVersion',
  ];
  const optional = ['installInputs', 'operationId', 'planId'];
  if (
    !isPlainObject(value) ||
    Object.keys(value).some(
      (key) => ![...required, ...optional].includes(key)
    ) ||
    required.some((key) => !Object.hasOwn(value, key)) ||
    ![...required, ...optional].every(
      (key) => !Object.hasOwn(value, key) || boundedPlainData(value[key])
    ) ||
    Object.keys(value).length > required.length + optional.length ||
    value.version !== 1 ||
    !validText(value.admissionOperationId) ||
    value.installerSettled !== true ||
    !validText(value.bunVersion) ||
    value.bunVersion.length > 64 ||
    (Object.hasOwn(value, 'installInputs') &&
      !validInstallInputs(value.installInputs, value.bunVersion)) ||
    (Object.hasOwn(value, 'operationId') &&
      !OPERATION_ID.test(value.operationId)) ||
    (Object.hasOwn(value, 'planId') && !OPERATION_ID.test(value.planId)) ||
    Object.hasOwn(value, 'operationId') !== Object.hasOwn(value, 'planId')
  ) {
    return false;
  }
  return true;
}

function sameEnrollmentBase(a, b) {
  return (
    a.version === b.version &&
    a.admissionOperationId === b.admissionOperationId &&
    a.installerSettled === b.installerSettled &&
    a.bunVersion === b.bunVersion &&
    Object.hasOwn(a, 'installInputs') === Object.hasOwn(b, 'installInputs') &&
    (!Object.hasOwn(a, 'installInputs') ||
      sameIdentity(a.installInputs, b.installInputs))
  );
}

function authoritativeEnrollment(state, target, checkoutIdentity, enrollment) {
  if (!(enrollment.operationId && enrollment.planId)) {
    return null;
  }
  try {
    const document = state.read('dependencyFiles');
    if (
      !isPlainObject(document) ||
      document.version !== 1 ||
      !isPlainObject(document.operations) ||
      !isPlainObject(document.views)
    ) {
      return null;
    }
    const operation = document.operations[enrollment.operationId];
    const view = document.views[keyFor(target)];
    if (
      !(isPlainObject(operation) && isPlainObject(view)) ||
      operation.id !== enrollment.operationId ||
      view.id !== enrollment.operationId ||
      operation.planId !== enrollment.planId ||
      view.planId !== enrollment.planId ||
      operation.state !== 'completed' ||
      view.state !== 'completed' ||
      operation.repo !== target.repo ||
      view.repo !== target.repo ||
      operation.name !== target.name ||
      view.name !== target.name ||
      !sameIdentity(operation.checkoutIdentity, checkoutIdentity) ||
      !sameIdentity(view.checkoutIdentity, checkoutIdentity) ||
      !sameIdentity(operation.checkoutIdentity, view.checkoutIdentity) ||
      !OPERATION_ID.test(operation.inputDigest ?? '') ||
      operation.inputDigest !== view.inputDigest ||
      !sameIdentity(operation.storeIdentity, view.storeIdentity)
    ) {
      return null;
    }
    return { operation, view };
  } catch {
    return null;
  }
}

function receiptMatchesRecord(record) {
  const receipt = record.dependencyReceipt;
  return (
    receipt === undefined ||
    (record.state === 'completed' &&
      record.outcome === 'completed' &&
      validateDependencyReceipt(receipt) &&
      receipt.attemptId === record.attemptId &&
      sameIdentity(receipt.checkoutIdentity, record.checkoutIdentity))
  );
}

function validRecord(record) {
  const terminal = ['completed', 'failed', 'unknown'];
  return (
    record &&
    validTarget(record.target) &&
    validIdentity(record.checkoutIdentity) &&
    validText(record.logLocation) &&
    validText(record.stage) &&
    Number.isFinite(record.startedAt) &&
    Number.isFinite(record.updatedAt) &&
    ['running', ...terminal].includes(record.state) &&
    (record.attemptId === undefined || validText(record.attemptId)) &&
    ((record.state === 'running' && record.outcome === null) ||
      (terminal.includes(record.state) && record.outcome === record.state)) &&
    (record.finishedAt === undefined || Number.isFinite(record.finishedAt)) &&
    (record.dependencyEnrollment === undefined ||
      validEnrollment(record.dependencyEnrollment)) &&
    receiptMatchesRecord(record)
  );
}

function records(document) {
  if (!Object.hasOwn(document ?? {}, 'records')) {
    return { ok: true, value: {} };
  }
  const value = document.records;
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    !Object.values(value).every(validRecord)
  ) {
    return { ok: false };
  }
  return { ok: true, value };
}

function copyRecord(record) {
  return record ? structuredClone(record) : null;
}

function refusal(code, error) {
  return { code, error, ok: false };
}

function retryableSetup(record, refreshDependencies) {
  return (
    ['failed', 'unknown'].includes(record.outcome) ||
    (record.outcome === 'completed' && refreshDependencies === true)
  );
}

function retryValidation(current, input) {
  if (!current) {
    return refusal(
      'SETUP_PROGRESS_NOT_FOUND',
      'No setup progress record exists'
    );
  }
  if (!sameIdentity(current.checkoutIdentity, input.checkoutIdentity)) {
    return refusal(
      'CHECKOUT_IDENTITY_MISMATCH',
      'The checkout identity does not match'
    );
  }
  if (!current.attemptId) {
    return refusal(
      'SETUP_ATTEMPT_REQUIRED',
      'The setup record has no attempt identity'
    );
  }
  if (!validText(input.attemptId) || current.attemptId !== input.attemptId) {
    return refusal(
      'SETUP_ATTEMPT_MISMATCH',
      'The setup attempt does not match'
    );
  }
  if (!retryableSetup(current, input.refreshDependencies)) {
    return refusal(
      'SETUP_RETRY_UNAVAILABLE',
      'Retry failed or unknown setup, or explicitly refresh completed dependencies'
    );
  }
  return null;
}

function enrollmentRecovery(current) {
  if (
    current.state !== 'unknown' ||
    !current.stage.startsWith('dependency-enrollment')
  ) {
    return null;
  }
  const [, operationId] = current.stage.split(':');
  return {
    ...refusal(
      'DEPENDENCY_ENROLLMENT_RECONCILIATION_REQUIRED',
      'Installation already finished; reconcile the recorded dependency enrollment before retrying setup'
    ),
    recovery: {
      dependencySharing: {
        ...(OPERATION_ID.test(operationId ?? '') ? { operationId } : {}),
        setupId: current.attemptId,
      },
    },
  };
}

function nextAttemptRecord(current, input, newAttempt, clock) {
  const { dependencyReceipt, finishedAt, ...unfinished } = current;
  const attemptId = newAttempt();
  if (!attemptId || attemptId === current.attemptId) {
    return refusal(
      'SETUP_ATTEMPT_ID_INVALID',
      'The new setup attempt id must differ from the previous attempt'
    );
  }
  const at = clock();
  return {
    ok: true,
    record: {
      ...unfinished,
      attemptId,
      logLocation: input.logLocation,
      outcome: null,
      stage: input.stage,
      startedAt: at,
      state: 'running',
      updatedAt: at,
    },
  };
}

function canBindEnrollmentIdsWhileUnknown(current, previous, proposed) {
  return Boolean(
    previous &&
      current.stage.startsWith('dependency-enrollment') &&
      !previous.operationId &&
      !previous.planId &&
      proposed.operationId &&
      proposed.planId
  );
}

function bindEnrollmentRecord(current, input, proposed, clock) {
  if (!current) {
    return refusal(
      'SETUP_PROGRESS_NOT_FOUND',
      'No setup progress record exists'
    );
  }
  if (!sameIdentity(current.checkoutIdentity, input.checkoutIdentity)) {
    return refusal(
      'CHECKOUT_IDENTITY_MISMATCH',
      'The checkout identity does not match'
    );
  }
  if (!current.attemptId) {
    return refusal(
      'SETUP_ATTEMPT_REQUIRED',
      'The setup record has no attempt identity'
    );
  }
  if (current.attemptId !== input.attemptId) {
    return refusal(
      'SETUP_ATTEMPT_MISMATCH',
      'The setup attempt does not match'
    );
  }
  const previous = current.dependencyEnrollment;
  if (previous && !sameEnrollmentBase(previous, proposed)) {
    return refusal(
      'SETUP_ENROLLMENT_BINDING_CONFLICT',
      'The immutable dependency enrollment binding cannot be changed'
    );
  }
  if (previous?.operationId) {
    if (
      previous.operationId !== proposed.operationId ||
      previous.planId !== proposed.planId
    ) {
      return refusal(
        'SETUP_ENROLLMENT_BINDING_CONFLICT',
        'The dependency operation and plan IDs cannot be changed'
      );
    }
    return { ok: true, record: current };
  }
  if (current.state === 'unknown') {
    if (!canBindEnrollmentIdsWhileUnknown(current, previous, proposed)) {
      return refusal(
        'SETUP_NOT_RUNNING',
        'Unknown setup can bind dependency IDs only from its saved enrollment base'
      );
    }
    return {
      ok: true,
      record: {
        ...current,
        dependencyEnrollment: proposed,
        updatedAt: clock(),
      },
    };
  }
  if (current.state !== 'running') {
    return refusal(
      'SETUP_NOT_RUNNING',
      'Only a running setup can bind dependency enrollment'
    );
  }
  if (!current.stage.startsWith('dependency-enrollment')) {
    return refusal(
      'SETUP_ENROLLMENT_STAGE_REQUIRED',
      'Setup is not in its dependency enrollment stage'
    );
  }
  if (
    previous &&
    (proposed.operationId || proposed.planId) &&
    (previous.operationId || previous.planId)
  ) {
    return refusal(
      'SETUP_ENROLLMENT_BINDING_CONFLICT',
      'The dependency operation and plan IDs can only be bound once'
    );
  }
  return {
    ok: true,
    record: {
      ...current,
      dependencyEnrollment: proposed,
      updatedAt: clock(),
    },
  };
}

function finishEnrollmentRecord(current, input, receipt, authoritative, clock) {
  if (!current) {
    return refusal(
      'SETUP_PROGRESS_NOT_FOUND',
      'No setup progress record exists'
    );
  }
  if (!sameIdentity(current.checkoutIdentity, input.checkoutIdentity)) {
    return refusal(
      'CHECKOUT_IDENTITY_MISMATCH',
      'The checkout identity does not match'
    );
  }
  if (!current.attemptId) {
    return refusal(
      'SETUP_ATTEMPT_REQUIRED',
      'The setup record has no attempt identity'
    );
  }
  if (current.attemptId !== input.attemptId) {
    return refusal(
      'SETUP_ATTEMPT_MISMATCH',
      'The setup attempt does not match'
    );
  }
  const enrollment = current.dependencyEnrollment;
  if (
    !validEnrollment(enrollment) ||
    enrollment.operationId !== input.operationId ||
    !enrollment.planId
  ) {
    return refusal(
      'SETUP_ENROLLMENT_BINDING_REQUIRED',
      'The setup record has no matching durable dependency enrollment binding'
    );
  }
  if (!authoritative) {
    return refusal(
      'SETUP_ENROLLMENT_NOT_COMPLETED',
      'The dependency journal and current view do not prove completed enrollment'
    );
  }
  if (
    receipt !== undefined &&
    (receipt.attemptId !== current.attemptId ||
      receipt.bunVersion !== enrollment.bunVersion ||
      !Object.hasOwn(enrollment, 'installInputs') ||
      !dependencyInstallInputsMatch(enrollment.installInputs, receipt.inputs) ||
      !sameIdentity(receipt.dependencyFiles, authoritative.view))
  ) {
    return refusal(
      'SETUP_DEPENDENCY_RECEIPT_INVALID',
      'The dependency receipt does not match the original enrollment observation'
    );
  }
  if (current.state === 'completed') {
    if (!sameIdentity(current.dependencyReceipt, receipt)) {
      return refusal(
        'SETUP_ENROLLMENT_COMPLETION_CONFLICT',
        'The completed setup has a different dependency receipt'
      );
    }
    return { ok: true, record: current };
  }
  if (!['running', 'unknown'].includes(current.state)) {
    return refusal(
      'SETUP_NOT_RUNNING',
      'The setup cannot complete dependency enrollment from this state'
    );
  }
  if (
    current.state === 'running' &&
    !current.stage.startsWith('dependency-enrollment')
  ) {
    return refusal(
      'SETUP_ENROLLMENT_STAGE_REQUIRED',
      'Setup is not in its dependency enrollment stage'
    );
  }
  const at = clock();
  return {
    ok: true,
    record: {
      ...current,
      ...(receipt === undefined
        ? {}
        : { dependencyReceipt: structuredClone(receipt) }),
      finishedAt: current.finishedAt ?? at,
      outcome: 'completed',
      state: 'completed',
      updatedAt: at,
    },
  };
}

function finishSetupRecord(current, input, receipt, clock) {
  if (!current) {
    return refusal(
      'SETUP_PROGRESS_NOT_FOUND',
      'No setup progress record exists'
    );
  }
  if (!sameIdentity(current.checkoutIdentity, input.checkoutIdentity)) {
    return refusal(
      'CHECKOUT_IDENTITY_MISMATCH',
      'The checkout identity does not match'
    );
  }
  if (!current.attemptId) {
    return refusal(
      'SETUP_ATTEMPT_REQUIRED',
      'The setup record has no attempt identity'
    );
  }
  if (current.attemptId !== input.attemptId) {
    return refusal(
      'SETUP_ATTEMPT_MISMATCH',
      'The setup attempt does not match'
    );
  }
  if (current.state !== 'running') {
    return refusal('SETUP_NOT_RUNNING', 'The setup is not running');
  }
  if (current.dependencyEnrollment && input.outcome === 'completed') {
    return refusal(
      'SETUP_ENROLLMENT_FINISH_REQUIRED',
      'Bound dependency enrollment must finish through finishEnrollment'
    );
  }
  const at = clock();
  return {
    ok: true,
    record: {
      ...current,
      ...(receipt === undefined
        ? {}
        : { dependencyReceipt: structuredClone(receipt) }),
      finishedAt: at,
      outcome: input.outcome,
      state: input.outcome,
      updatedAt: at,
    },
  };
}

export function createSetupProgress({ state, now, newAttemptId }) {
  const clock = now ?? (() => Date.now());

  function newAttempt() {
    const value = newAttemptId?.();
    return validText(value) ? value : null;
  }

  function get(target) {
    if (!validTarget(target)) {
      return null;
    }
    const current = records(state.read('setupProgress'));
    return current.ok
      ? copyRecord(current.value[keyFor(target)])
      : refusal(
          'SETUP_PROGRESS_CORRUPT',
          'The setup progress journal is invalid'
        );
  }

  async function write(target, mutate) {
    const initial = records(state.read('setupProgress'));
    if (!initial.ok) {
      return refusal(
        'SETUP_PROGRESS_CORRUPT',
        'The setup progress journal is invalid'
      );
    }
    let result;
    let saved;
    try {
      saved = await state.update('setupProgress', (document) => {
        const current = records(document);
        if (!current.ok) {
          result = refusal(
            'SETUP_PROGRESS_CORRUPT',
            'The setup progress journal is invalid'
          );
          return document;
        }
        const all = current.value;
        result = mutate(copyRecord(all[keyFor(target)]));
        if (!result.ok) {
          return document;
        }
        return {
          ...document,
          records: { ...all, [keyFor(target)]: result.record },
        };
      });
    } catch {
      return refusal(
        'SETUP_PROGRESS_OUTCOME_UNKNOWN',
        'The setup progress write could not be confirmed'
      );
    }
    if (!result) {
      return refusal(
        'SETUP_PROGRESS_OUTCOME_UNKNOWN',
        'The setup progress write could not be confirmed'
      );
    }
    if (
      result.ok &&
      (saved?.committed !== true ||
        saved?.reconciled !== true ||
        saved?.status !== 'committed')
    ) {
      return refusal(
        'SETUP_PROGRESS_OUTCOME_UNKNOWN',
        'The setup progress write could not be confirmed'
      );
    }
    return result;
  }

  function inputIsValid({
    target,
    checkoutIdentity,
    logLocation,
    stage: currentStage,
  }) {
    return (
      validTarget(target) &&
      validIdentity(checkoutIdentity) &&
      validText(logLocation) &&
      validText(currentStage)
    );
  }

  // biome-ignore lint/suspicious/useAwait: The public progress API must reject synchronous state failures consistently with its Promise-returning callers.
  async function start(input) {
    if (!inputIsValid(input)) {
      return refusal(
        'SETUP_PROGRESS_INVALID',
        'The setup progress record is invalid'
      );
    }
    return write(input.target, (current) => {
      if (current) {
        return refusal(
          'SETUP_PROGRESS_EXISTS',
          'A setup progress record already exists'
        );
      }
      const at = clock();
      const attemptId = newAttempt();
      if (!attemptId) {
        return refusal(
          'SETUP_ATTEMPT_ID_INVALID',
          'The setup attempt id is invalid'
        );
      }
      return {
        ok: true,
        record: {
          attemptId,
          checkoutIdentity: input.checkoutIdentity,
          logLocation: input.logLocation,
          outcome: null,
          stage: input.stage,
          startedAt: at,
          state: 'running',
          target: { ...input.target },
          updatedAt: at,
        },
      };
    });
  }

  // biome-ignore lint/suspicious/useAwait: The public progress API must reject synchronous state failures consistently with its Promise-returning callers.
  async function stage({
    target,
    checkoutIdentity,
    attemptId,
    stage: nextStage,
  }) {
    if (
      !(
        validTarget(target) &&
        validIdentity(checkoutIdentity) &&
        validText(attemptId) &&
        validText(nextStage)
      )
    ) {
      return refusal(
        'SETUP_PROGRESS_INVALID',
        'The setup progress update is invalid'
      );
    }
    return write(target, (current) => {
      if (!current) {
        return refusal(
          'SETUP_PROGRESS_NOT_FOUND',
          'No setup progress record exists'
        );
      }
      if (!sameIdentity(current.checkoutIdentity, checkoutIdentity)) {
        return refusal(
          'CHECKOUT_IDENTITY_MISMATCH',
          'The checkout identity does not match'
        );
      }
      if (!current.attemptId) {
        return refusal(
          'SETUP_ATTEMPT_REQUIRED',
          'The setup record has no attempt identity'
        );
      }
      if (current.attemptId !== attemptId) {
        return refusal(
          'SETUP_ATTEMPT_MISMATCH',
          'The setup attempt does not match'
        );
      }
      if (current.state !== 'running') {
        return refusal('SETUP_NOT_RUNNING', 'The setup is not running');
      }
      return {
        ok: true,
        record: { ...current, stage: nextStage, updatedAt: clock() },
      };
    });
  }

  // Persist the original install observation before the dependency journal may
  // begin mutating installed files. Operation and plan IDs may be added later,
  // once the immutable plan has been saved.
  // biome-ignore lint/suspicious/useAwait: Public progress mutations consistently return promises.
  async function bindEnrollment(input) {
    if (
      !isPlainObject(input) ||
      Object.keys(input).some(
        (key) =>
          ![
            'target',
            'checkoutIdentity',
            'attemptId',
            'dependencyEnrollment',
          ].includes(key)
      ) ||
      Object.keys(input).length !== 4 ||
      !validTarget(input.target) ||
      !validIdentity(input.checkoutIdentity) ||
      !validText(input.attemptId) ||
      !validEnrollment(input.dependencyEnrollment)
    ) {
      return refusal(
        'SETUP_ENROLLMENT_INVALID',
        'The dependency enrollment binding is invalid'
      );
    }
    let proposed;
    try {
      proposed = structuredClone(input.dependencyEnrollment);
      if (Buffer.byteLength(JSON.stringify(proposed)) > MAX_ENROLLMENT_BYTES) {
        throw new Error('Enrollment binding exceeds its size bound');
      }
    } catch {
      return refusal(
        'SETUP_ENROLLMENT_INVALID',
        'The dependency enrollment binding is not bounded plain data'
      );
    }
    return write(input.target, (current) =>
      bindEnrollmentRecord(current, input, proposed, clock)
    );
  }

  // biome-ignore lint/suspicious/useAwait: Public progress mutations consistently return promises.
  async function finishEnrollment(input) {
    if (
      !isPlainObject(input) ||
      Object.keys(input).some(
        (key) =>
          ![
            'target',
            'checkoutIdentity',
            'attemptId',
            'operationId',
            'dependencyReceipt',
          ].includes(key)
      ) ||
      ![4, 5].includes(Object.keys(input).length) ||
      !validTarget(input.target) ||
      !validIdentity(input.checkoutIdentity) ||
      !validText(input.attemptId) ||
      !OPERATION_ID.test(input.operationId ?? '')
    ) {
      return refusal(
        'SETUP_ENROLLMENT_INVALID',
        'The dependency enrollment completion is invalid'
      );
    }
    let receipt;
    try {
      receipt =
        input.dependencyReceipt === undefined
          ? undefined
          : structuredClone(input.dependencyReceipt);
      if (receipt !== undefined && !validateDependencyReceipt(receipt)) {
        throw new Error('Receipt does not match this setup attempt');
      }
      if (
        receipt !== undefined &&
        Buffer.byteLength(JSON.stringify(receipt)) > MAX_ENROLLMENT_BYTES * 8
      ) {
        throw new Error('Receipt exceeds its size bound');
      }
    } catch {
      return refusal(
        'SETUP_DEPENDENCY_RECEIPT_INVALID',
        'The dependency receipt does not certify this setup attempt'
      );
    }
    return write(input.target, (current) => {
      if (
        current &&
        !sameIdentity(current.checkoutIdentity, input.checkoutIdentity)
      ) {
        return refusal(
          'CHECKOUT_IDENTITY_MISMATCH',
          'The checkout identity does not match'
        );
      }
      if (current?.attemptId && current.attemptId !== input.attemptId) {
        return refusal(
          'SETUP_ATTEMPT_MISMATCH',
          'The setup attempt does not match'
        );
      }
      if (
        current &&
        !receiptMatchesRecord({
          attemptId: input.attemptId,
          checkoutIdentity: input.checkoutIdentity,
          dependencyReceipt: receipt,
          outcome: 'completed',
          state: 'completed',
        })
      ) {
        return refusal(
          'SETUP_DEPENDENCY_RECEIPT_INVALID',
          'The dependency receipt does not certify this setup attempt'
        );
      }
      const enrollment = current?.dependencyEnrollment;
      const authoritative = validEnrollment(enrollment)
        ? authoritativeEnrollment(
            state,
            input.target,
            input.checkoutIdentity,
            enrollment
          )
        : null;
      return finishEnrollmentRecord(
        current,
        input,
        receipt,
        authoritative,
        clock
      );
    });
  }

  // biome-ignore lint/suspicious/useAwait: The public progress API must reject synchronous state failures consistently with its Promise-returning callers.
  async function finish({
    target,
    checkoutIdentity,
    attemptId,
    outcome,
    dependencyReceipt,
  }) {
    if (
      !(
        validTarget(target) &&
        validIdentity(checkoutIdentity) &&
        validText(attemptId) &&
        ['completed', 'failed', 'unknown'].includes(outcome)
      )
    ) {
      return refusal('SETUP_PROGRESS_INVALID', 'The setup outcome is invalid');
    }
    let receipt;
    try {
      receipt =
        dependencyReceipt === undefined
          ? undefined
          : structuredClone(dependencyReceipt);
    } catch {
      return refusal(
        'SETUP_DEPENDENCY_RECEIPT_INVALID',
        'The dependency receipt is not plain data'
      );
    }
    if (
      !receiptMatchesRecord({
        attemptId,
        checkoutIdentity,
        dependencyReceipt: receipt,
        outcome,
        state: outcome,
      })
    ) {
      return refusal(
        'SETUP_DEPENDENCY_RECEIPT_INVALID',
        'The dependency receipt does not certify this setup outcome'
      );
    }
    return write(target, (current) =>
      finishSetupRecord(
        current,
        { attemptId, checkoutIdentity, outcome },
        receipt,
        clock
      )
    );
  }

  async function recover() {
    const initial = records(state.read('setupProgress'));
    if (!initial.ok) {
      return refusal(
        'SETUP_PROGRESS_CORRUPT',
        'The setup progress journal is invalid'
      );
    }
    let recovered = 0;
    await state.update('setupProgress', (document) => {
      const current = records(document);
      if (!current.ok) {
        throw Object.assign(new Error('setup progress journal is invalid'), {
          code: 'SETUP_PROGRESS_CORRUPT',
        });
      }
      const all = current.value;
      const next = Object.fromEntries(
        Object.entries(all).map(([key, record]) => {
          if (record?.state !== 'running') {
            return [key, record];
          }
          recovered += 1;
          const at = clock();
          return [
            key,
            {
              ...record,
              finishedAt: at,
              outcome: 'unknown',
              state: 'unknown',
              updatedAt: at,
            },
          ];
        })
      );
      return recovered ? { ...document, records: next } : document;
    });
    return { ok: true, recovered };
  }

  // biome-ignore lint/suspicious/useAwait: The public progress API must reject synchronous state failures consistently with its Promise-returning callers.
  async function retry(input) {
    if (
      !inputIsValid(input) ||
      (Object.hasOwn(input, 'refreshDependencies') &&
        typeof input.refreshDependencies !== 'boolean')
    ) {
      return refusal(
        'SETUP_PROGRESS_INVALID',
        'The setup retry record is invalid'
      );
    }
    return write(input.target, (current) => {
      const invalid = retryValidation(current, input);
      if (invalid) {
        return invalid;
      }
      const recovery = enrollmentRecovery(current);
      return recovery ?? nextAttemptRecord(current, input, newAttempt, clock);
    });
  }

  return {
    bindEnrollment,
    finish,
    finishEnrollment,
    get,
    recover,
    retry,
    stage,
    start,
  };
}
