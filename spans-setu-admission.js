import { createHash } from 'node:crypto';
import {
  copySpansArchiveReservation,
  sameSpansArchiveReservation,
} from './resource-admission.js';

const isRecord = (value) =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const safeIdPattern = /^[A-Za-z0-9_-]{1,128}$/;
const unsafePartPattern = /[\\:\s]/;
const safeId = (value) =>
  typeof value === 'string' && safeIdPattern.test(value);
const explicitId = (value) =>
  typeof value === 'string' &&
  value.length > 0 &&
  value.length <= 256 &&
  value.trim() === value &&
  value !== '__proto__' &&
  ![...value].some(
    (character) =>
      character.codePointAt(0) < 32 || character.codePointAt(0) === 127
  );
const safePart = (value) =>
  typeof value === 'string' &&
  value.length > 0 &&
  !value.includes('/') &&
  !unsafePartPattern.test(value) &&
  ![...value].some((character) => character.codePointAt(0) <= 0x20) &&
  !['.', '..'].includes(value) &&
  !value.startsWith('-');

function exactData(value, keys) {
  try {
    if (!isRecord(value)) {
      return null;
    }
    const ownKeys = Reflect.ownKeys(value);
    if (ownKeys.length !== keys.length) {
      return null;
    }
    const copied = {};
    for (const key of keys) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (
        descriptor?.enumerable !== true ||
        !Object.hasOwn(descriptor, 'value')
      ) {
        return null;
      }
      copied[key] = descriptor.value;
    }
    return copied;
  } catch {
    return null;
  }
}

function validTargetParts(target) {
  return (
    safePart(target.repo) &&
    typeof target.name === 'string' &&
    target.name.split('/').every(safePart)
  );
}

function copyTarget(value) {
  const copied = exactData(value, ['repo', 'name']);
  if (!copied) {
    return null;
  }
  return validTargetParts(copied) ? Object.freeze(copied) : null;
}

function copyReservation(value, binding) {
  const candidate = exactData(value, ['root', 'reservedBytes', 'budgetBytes']);
  return candidate
    ? (copySpansArchiveReservation(candidate, binding) ?? null)
    : null;
}

function validTarget(value) {
  return copyTarget(value) !== null;
}

function sameTarget(a, b) {
  return a?.repo === b?.repo && a?.name === b?.name;
}

function operationIdFor(binding) {
  const prefix = 'spans-adm';
  const digest = createHash('sha256')
    .update(
      JSON.stringify([
        prefix,
        binding.runId,
        binding.spanId,
        binding.attemptId,
        binding.actionId,
      ])
    )
    .digest('hex')
    .slice(0, 32);
  return `${prefix}-${digest}`;
}

function validBinding(value) {
  const binding = exactData(value, [
    'runId',
    'spanId',
    'actionId',
    'attemptId',
    'generation',
    'target',
  ]);
  const target = binding && copyTarget(binding.target);
  const idsValid =
    binding &&
    [binding.runId, binding.spanId, binding.actionId, binding.attemptId].every(
      explicitId
    );
  if (
    !(idsValid && Number.isSafeInteger(binding.generation)) ||
    binding.generation < 0 ||
    !target
  ) {
    return null;
  }
  return Object.freeze({
    actionId: binding.actionId,
    attemptId: binding.attemptId,
    generation: binding.generation,
    runId: binding.runId,
    spanId: binding.spanId,
    target,
  });
}

function sameBinding(a, b) {
  return (
    Boolean(a && b) &&
    a.actionId === b.actionId &&
    a.attemptId === b.attemptId &&
    a.generation === b.generation &&
    a.runId === b.runId &&
    a.spanId === b.spanId &&
    sameTarget(a.target, b.target)
  );
}

function admissionRequest(value) {
  try {
    const input = exactData(value, ['kind', 'operationId', 'target']);
    if (!input) {
      return null;
    }
    const { kind, operationId } = input;
    const target = copyTarget(input.target);
    if (
      !(
        ['session', 'headless-run', 'install'].includes(kind) &&
        safeId(operationId) &&
        target
      )
    ) {
      return null;
    }
    return Object.freeze({ kind, operationId, target });
  } catch {
    return null;
  }
}

function copyLeaseData(value) {
  if (!isRecord(value)) {
    return null;
  }
  let ownKeys;
  try {
    ownKeys = Reflect.ownKeys(value);
  } catch {
    return null;
  }
  const required = [
    'acquiredAt',
    'kind',
    'operationId',
    'owner',
    'target',
    'spansBinding',
    'spansArchiveReservation',
  ];
  const optional = ['ownership', 'recoveryRequired'];
  if (required.some((key) => !ownKeys.includes(key))) {
    return null;
  }
  const data = {};
  for (const key of ownKeys) {
    if (!(required.includes(key) || optional.includes(key))) {
      return null;
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!(descriptor?.enumerable && Object.hasOwn(descriptor, 'value'))) {
      return null;
    }
    data[key] = descriptor.value;
  }
  const { acquiredAt, kind, operationId, owner } = data;
  const target = copyTarget(data.target);
  const binding = validBinding(data.spansBinding);
  const ownerCopy = exactData(owner, ['pid', 'processStart']);
  const reservation = copyReservation(data.spansArchiveReservation, binding);
  if (
    !Number.isSafeInteger(acquiredAt) ||
    acquiredAt < 0 ||
    !['session', 'headless-run', 'install'].includes(kind) ||
    !safeId(operationId) ||
    !target ||
    !ownerCopy ||
    !Number.isSafeInteger(ownerCopy.pid) ||
    ownerCopy.pid < 1 ||
    typeof ownerCopy.processStart !== 'string' ||
    !ownerCopy.processStart ||
    !binding ||
    !sameTarget(binding.target, target) ||
    !reservation ||
    operationIdFor(binding) !== operationId
  ) {
    return null;
  }
  const { ownership, recoveryRequired } = data;
  if (
    (ownership !== undefined &&
      !['confirmed', 'uncertain'].includes(ownership)) ||
    (recoveryRequired !== undefined && typeof recoveryRequired !== 'boolean')
  ) {
    return null;
  }
  return Object.freeze({
    acquiredAt,
    kind,
    operationId,
    owner: Object.freeze({
      pid: ownerCopy.pid,
      processStart: ownerCopy.processStart,
    }),
    spansArchiveReservation: Object.freeze(reservation),
    spansBinding: binding,
    target,
  });
}

function copyLease(value) {
  try {
    return copyLeaseData(value);
  } catch {
    return null;
  }
}

const refusal = (code, error) => ({ code, error, ok: false });

// Bridges spans-dispatch to the single resource-admission authority. The root
// resolver supplies an immutable attempt/review identity; it may use its
// operation-local prepared binding for first preintent admission, then must
// resolve persisted identity for revalidation and restart. The trusted
// reservation resolver derives capture max plus metadata headroom and returns
// the canonical archive root. Neither resolver accepts request assertions.
// The root coordinator checks current approval before admission and launch;
// identity resolution stays available for exact cleanup after revocation.
export function createSpansSetuAdmission({
  resourceAdmission,
  resolveOperation,
  resolveArchiveReservation,
  releaseGuard,
} = {}) {
  const configured =
    resourceAdmission &&
    typeof resourceAdmission.admit === 'function' &&
    typeof resourceAdmission.release === 'function' &&
    typeof resourceAdmission.status === 'function' &&
    typeof resourceAdmission.withSpansArchiveWrite === 'function' &&
    typeof resolveOperation === 'function' &&
    typeof resolveArchiveReservation === 'function';

  async function resolve(operationId, target) {
    if (!(configured && safeId(operationId) && validTarget(target))) {
      return null;
    }
    try {
      const binding = validBinding(
        await resolveOperation(
          Object.freeze({ operationId, target: copyTarget(target) })
        )
      );
      return binding &&
        operationIdFor(binding) === operationId &&
        sameTarget(binding.target, target)
        ? binding
        : null;
    } catch {
      return null;
    }
  }

  async function reservationFor(binding, operationId) {
    try {
      const reservation = copyReservation(
        await resolveArchiveReservation(
          Object.freeze({ binding, operationId })
        ),
        binding
      );
      return reservation ? Object.freeze(reservation) : null;
    } catch {
      return null;
    }
  }

  function matchesReservation(lease, binding, expected) {
    if (!(isRecord(lease) && expected)) {
      return false;
    }
    const stored = copyReservation(lease.spansArchiveReservation, binding);
    return Boolean(stored && sameSpansArchiveReservation(expected, stored));
  }

  function matchesAdmissionLease(lease, input, binding) {
    return (
      isRecord(lease) &&
      lease.operationId === input.operationId &&
      lease.kind === input.kind &&
      sameTarget(lease.target, input.target) &&
      sameBinding(lease.spansBinding, binding)
    );
  }

  function uncertain() {
    return refusal(
      'LEASE_BINDING_UNKNOWN',
      'The action and generation binding could not be confirmed; the lease was retained.'
    );
  }

  async function admit(input) {
    if (!configured) {
      return refusal(
        'ADMISSION_UNAVAILABLE',
        'Resource admission and the Spans archive write gate are not configured safely.'
      );
    }
    const parsed = admissionRequest(input);
    if (!parsed) {
      return refusal(
        'INVALID_ADMISSION_REQUEST',
        'Admission request is invalid.'
      );
    }
    const binding = await resolve(parsed.operationId, parsed.target);
    if (!binding) {
      return uncertain();
    }
    const reservation = await reservationFor(binding, parsed.operationId);
    if (reservation === null) {
      return uncertain();
    }
    let result;
    try {
      result = await resourceAdmission.admit({
        kind: parsed.kind,
        operationId: parsed.operationId,
        spansArchiveReservation: reservation,
        spansBinding: binding,
        target: parsed.target,
      });
    } catch {
      return refusal(
        'ADMISSION_STATE_UNKNOWN',
        'Admission could not be confirmed.'
      );
    }
    if (!result?.ok) {
      return result?.code === 'OPERATION_ID_CONFLICT' ? uncertain() : result;
    }
    return verifyAdmitted(result, parsed, binding, reservation);
  }

  async function verifyAdmitted(result, input, binding, reservation) {
    // Admission is awaited and the run generation can advance during that
    // wait. A changed binding cannot be released or reported as belonging to
    // the old generation, so leave the durable lease untouched.
    const afterAdmission = await resolve(input.operationId, input.target);
    if (!(afterAdmission && sameBinding(binding, afterAdmission))) {
      return uncertain();
    }
    const afterReservation = await reservationFor(
      afterAdmission,
      input.operationId
    );
    if (!sameSpansArchiveReservation(reservation, afterReservation)) {
      return uncertain();
    }
    const lease = copyLease(result?.lease);
    if (!(lease && matchesReservation(lease, binding, reservation))) {
      return uncertain();
    }
    if (!matchesAdmissionLease(lease, input, binding)) {
      return refusal(
        'ADMISSION_STATE_UNKNOWN',
        'Admission lease could not be confirmed.'
      );
    }
    return { ...result, lease };
  }

  async function release(lease) {
    const copied = copyLease(lease);
    if (!(configured && copied)) {
      return refusal(
        'LEASE_MISMATCH',
        'The admission lease does not match this operation.'
      );
    }
    const current = await resolve(copied.operationId, copied.target);
    if (!(current && sameBinding(copied.spansBinding, current))) {
      return uncertain();
    }
    const reservation = await reservationFor(current, copied.operationId);
    if (!matchesReservation(copied, current, reservation)) {
      return uncertain();
    }
    let result;
    try {
      result = await resourceAdmission.release(
        copied,
        releaseGuard === undefined
          ? undefined
          : () => releaseGuard(copied.spansBinding) === true
      );
    } catch {
      return refusal(
        'ADMISSION_STATE_UNKNOWN',
        'Admission release could not be confirmed; the lease was retained.'
      );
    }
    return result;
  }

  async function verifyListedLease(value) {
    if (!isRecord(value)) {
      return false;
    }
    const operationProperty = Object.getOwnPropertyDescriptor(
      value,
      'operationId'
    );
    if (
      !(
        operationProperty?.enumerable &&
        Object.hasOwn(operationProperty, 'value')
      ) ||
      typeof operationProperty.value !== 'string'
    ) {
      return false;
    }
    if (!operationProperty.value.startsWith('spans-adm-')) {
      return null;
    }
    const lease = copyLease(value);
    if (!lease) {
      return false;
    }
    const current = await resolve(lease.operationId, lease.target);
    if (!(current && sameBinding(lease.spansBinding, current))) {
      return false;
    }
    const reservation = await reservationFor(current, lease.operationId);
    return matchesReservation(lease, current, reservation) ? lease : false;
  }

  async function status() {
    if (!configured) {
      return refusal(
        'ADMISSION_UNAVAILABLE',
        'Resource admission is not configured safely.'
      );
    }
    let result;
    try {
      result = await resourceAdmission.status();
    } catch {
      return refusal(
        'ADMISSION_STATE_UNKNOWN',
        'Admission state could not be read.'
      );
    }
    if (!(result?.ok && Array.isArray(result.leases))) {
      return result;
    }
    const leases = [];
    const verified = await Promise.all(result.leases.map(verifyListedLease));
    if (verified.includes(false)) {
      return uncertain();
    }
    leases.push(...verified.filter(Boolean));
    return { ...result, leases };
  }

  return Object.freeze({ admit, release, status });
}
