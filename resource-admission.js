import { lstatSync, realpathSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { observeProcessIdentity } from './process-observation.js';
import { inspectSpansCapacity } from './spans-capacity.js';

// Managed setup callers must admit before taking a target lock. The admission
// lease is durable coordination, while the target lock only protects one checkout.

export const DEFAULT_MANAGED_SESSION_LIMIT = 2;
export const DEFAULT_LOW_STORAGE_FLOOR_BYTES = 20 * 1024 ** 3;
export const SPANS_ARCHIVE_BUDGET_BYTES = 5 * 1024 ** 3;

const ADMISSION_DOCUMENT = 'resourceAdmission';
const KINDS = new Set(['install', 'session', 'headless-run']);
const MANAGED_SESSION_KINDS = new Set(['session', 'headless-run']);
const safeIdPattern = /^[a-zA-Z0-9_-]{1,128}$/;
const hasControlCharacter = (value) =>
  [...value].some((character) => {
    const code = character.codePointAt(0);
    return code <= 0x1f || (code >= 0x7f && code <= 0x9f);
  });
const unsafePartPattern = /[/\\:\s]/;
const plainObject = (value) =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const safeId = (value) =>
  typeof value === 'string' && safeIdPattern.test(value);
const hasAsciiControlCharacter = (value) =>
  [...value].some((character) => character.codePointAt(0) <= 0x20);
const safePart = (value) =>
  typeof value === 'string' &&
  value.length > 0 &&
  !unsafePartPattern.test(value) &&
  !hasAsciiControlCharacter(value) &&
  !['.', '..'].includes(value) &&
  !value.startsWith('-');

const explicitId = (value) =>
  typeof value === 'string' &&
  value.length > 0 &&
  value.length <= 256 &&
  value.trim() === value &&
  value !== '__proto__' &&
  ![...value].some((character) => {
    const code = character.codePointAt(0);
    return code < 32 || code === 127;
  });

const hasExactKeys = (value, keys) =>
  plainObject(value) &&
  Reflect.ownKeys(value).length === keys.length &&
  keys.every((key) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return (
      descriptor?.enumerable === true && Object.hasOwn(descriptor, 'value')
    );
  });

function optionalDataProperty(value, key) {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (!descriptor) {
    return { present: false, valid: true };
  }
  if (!(descriptor.enumerable && Object.hasOwn(descriptor, 'value'))) {
    return { present: true, valid: false };
  }
  return { present: true, valid: true, value: descriptor.value };
}

function copySpansBinding(value) {
  if (
    !(
      hasExactKeys(value, [
        'runId',
        'spanId',
        'actionId',
        'attemptId',
        'generation',
        'target',
      ]) &&
      [value.runId, value.spanId, value.actionId, value.attemptId].every(
        explicitId
      ) &&
      Number.isSafeInteger(value.generation)
    ) ||
    value.generation < 0 ||
    !hasExactKeys(value.target, ['repo', 'name'])
  ) {
    return;
  }
  const target = copyTarget(value.target);
  if (target === undefined || target === null) {
    return;
  }
  return {
    actionId: value.actionId,
    attemptId: value.attemptId,
    generation: value.generation,
    runId: value.runId,
    spanId: value.spanId,
    target,
  };
}

export function copySpansArchiveReservation(value, spansBinding) {
  if (
    !(
      spansBinding &&
      hasExactKeys(value, ['root', 'reservedBytes', 'budgetBytes'])
    ) ||
    typeof value.root !== 'string' ||
    !isAbsolute(value.root) ||
    resolve(value.root) !== value.root ||
    hasControlCharacter(value.root) ||
    !Number.isSafeInteger(value.reservedBytes) ||
    value.reservedBytes <= 0 ||
    value.budgetBytes !== SPANS_ARCHIVE_BUDGET_BYTES
  ) {
    return;
  }
  return {
    budgetBytes: SPANS_ARCHIVE_BUDGET_BYTES,
    reservedBytes: value.reservedBytes,
    root: value.root,
  };
}

export function sameSpansArchiveReservation(a, b) {
  return a === undefined
    ? b === undefined
    : b !== undefined &&
        a.root === b.root &&
        a.reservedBytes === b.reservedBytes &&
        a.budgetBytes === b.budgetBytes;
}

function sameArchiveStorage(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string') {
    return false;
  }
  if (left === right) {
    return true;
  }
  try {
    return realpathSync(left) === realpathSync(right);
  } catch {
    // An unresolved root cannot prove that its reservation belongs elsewhere.
    return true;
  }
}

async function checkArchiveCapacity(candidate, leases, archiveCapacity) {
  const reservation = candidate.spansArchiveReservation;
  if (!reservation) {
    return { ok: true };
  }
  if (
    Object.values(leases).some(
      (lease) =>
        lease.spansBinding !== undefined &&
        lease.spansArchiveReservation === undefined
    )
  ) {
    return {
      ok: false,
      refusal: refusal(
        'SPANS_ARCHIVE_CAPACITY_UNKNOWN',
        'A legacy Spans lease has no archive root; archive capacity is unknown.'
      ),
    };
  }
  let observation;
  try {
    observation =
      typeof archiveCapacity === 'function'
        ? await archiveCapacity({
            budgetBytes: SPANS_ARCHIVE_BUDGET_BYTES,
            root: reservation.root,
          })
        : undefined;
  } catch {
    observation = undefined;
  }
  const measuredBytes = observation?.totalBytes;
  let outstandingBytes = 0;
  for (const lease of Object.values(leases)) {
    const activeReservation = lease.spansArchiveReservation;
    if (sameArchiveStorage(activeReservation?.root, reservation.root)) {
      outstandingBytes += activeReservation.reservedBytes;
    }
  }
  const committedBytes = measuredBytes + outstandingBytes;
  const totalWithCandidate = committedBytes + reservation.reservedBytes;
  if (
    observation?.ok !== true ||
    observation.state !== 'known' ||
    !Number.isSafeInteger(measuredBytes) ||
    measuredBytes < 0 ||
    !Number.isSafeInteger(outstandingBytes) ||
    !Number.isSafeInteger(committedBytes) ||
    !Number.isSafeInteger(totalWithCandidate)
  ) {
    return {
      ok: false,
      refusal: refusal(
        'SPANS_ARCHIVE_CAPACITY_UNKNOWN',
        'Spans archive capacity is unknown; the archive reservation was not admitted.'
      ),
    };
  }
  if (totalWithCandidate > SPANS_ARCHIVE_BUDGET_BYTES) {
    return {
      ok: false,
      refusal: refusal(
        'SPANS_ARCHIVE_CAPACITY_REACHED',
        'The Spans archive budget cannot fit this capture reservation.',
        {
          budgetBytes: SPANS_ARCHIVE_BUDGET_BYTES,
          committedBytes,
          measuredBytes,
          outstandingReservedBytes: outstandingBytes,
          requestedReservedBytes: reservation.reservedBytes,
        }
      ),
    };
  }
  return {
    ok: true,
    spansArchiveCapacity: Object.freeze({
      budgetBytes: SPANS_ARCHIVE_BUDGET_BYTES,
      committedBytes,
      measuredBytes,
      outstandingReservedBytes: outstandingBytes,
      reservedBytes: reservation.reservedBytes,
      totalWithCandidate,
      warning:
        BigInt(totalWithCandidate) * 5n >=
        BigInt(SPANS_ARCHIVE_BUDGET_BYTES) * 4n,
    }),
  };
}

function sameSpansBinding(a, b) {
  return a === undefined
    ? b === undefined
    : b !== undefined &&
        a.runId === b.runId &&
        a.spanId === b.spanId &&
        a.actionId === b.actionId &&
        a.attemptId === b.attemptId &&
        a.generation === b.generation &&
        sameTarget(a.target, b.target);
}

function copyTarget(target) {
  if (target === null) {
    return null;
  }
  if (
    !(plainObject(target) && safePart(target.repo)) ||
    typeof target.name !== 'string' ||
    !target.name.split('/').every(safePart)
  ) {
    return;
  }
  return { name: target.name, repo: target.repo };
}

function sameTarget(a, b) {
  return a === null
    ? b === null
    : b !== null && a.repo === b.repo && a.name === b.name;
}

const sameOwner = (a, b) =>
  a.pid === b.pid && a.processStart === b.processStart;
const sameLease = (a, b) =>
  a.operationId === b.operationId &&
  a.acquiredAt === b.acquiredAt &&
  a.kind === b.kind &&
  sameTarget(a.target, b.target) &&
  sameOwner(a.owner, b.owner);

function policy(limits = {}) {
  const maxManagedSessions = Number(
    limits.maxManagedSessions ?? DEFAULT_MANAGED_SESSION_LIMIT
  );
  const lowStorageFloorBytes = Number(
    limits.lowStorageFloorBytes ?? DEFAULT_LOW_STORAGE_FLOOR_BYTES
  );
  if (
    !Number.isInteger(maxManagedSessions) ||
    maxManagedSessions < 1 ||
    maxManagedSessions > 64 ||
    !Number.isSafeInteger(lowStorageFloorBytes) ||
    lowStorageFloorBytes < 0
  ) {
    return null;
  }
  return { lowStorageFloorBytes, maxManagedSessions };
}

function copyLease(value) {
  if (
    !(
      plainObject(value) &&
      KINDS.has(value.kind) &&
      safeId(value.operationId) &&
      Number.isSafeInteger(value.acquiredAt)
    ) ||
    value.acquiredAt < 0 ||
    !plainObject(value.owner) ||
    !Number.isSafeInteger(value.owner.pid) ||
    value.owner.pid < 1 ||
    typeof value.owner.processStart !== 'string' ||
    !value.owner.processStart
  ) {
    return;
  }
  const target = copyTarget(value.target);
  const spansBinding = Object.hasOwn(value, 'spansBinding')
    ? copySpansBinding(value.spansBinding)
    : undefined;
  const archiveProperty = optionalDataProperty(
    value,
    'spansArchiveReservation'
  );
  const spansArchiveReservation =
    archiveProperty.valid && archiveProperty.present
      ? copySpansArchiveReservation(archiveProperty.value, spansBinding)
      : undefined;
  if (
    target === undefined ||
    (Object.hasOwn(value, 'spansBinding') &&
      (spansBinding === undefined ||
        !sameTarget(spansBinding.target, target))) ||
    (archiveProperty.present &&
      (!archiveProperty.valid || spansArchiveReservation === undefined))
  ) {
    return;
  }
  return {
    acquiredAt: value.acquiredAt,
    kind: value.kind,
    operationId: value.operationId,
    owner: { pid: value.owner.pid, processStart: value.owner.processStart },
    target,
    ...(spansBinding === undefined ? {} : { spansBinding }),
    ...(spansArchiveReservation === undefined
      ? {}
      : { spansArchiveReservation }),
  };
}

function leasesFrom(document) {
  if (!plainObject(document)) {
    return;
  }
  if (document.leases === undefined) {
    return {};
  }
  if (!plainObject(document.leases)) {
    return;
  }
  const leases = {};
  for (const [operationId, value] of Object.entries(document.leases)) {
    const lease = copyLease(value);
    if (!(safeId(operationId) && lease) || lease.operationId !== operationId) {
      return;
    }
    leases[operationId] = lease;
  }
  return leases;
}

const writeLeases = (leases) => ({ leases });

async function ownership(lease, observeProcess) {
  try {
    const observed = await observeProcess(lease.owner.pid);
    return observed?.state === 'alive' &&
      observed.processId === lease.owner.pid &&
      observed.processStartIdentity === lease.owner.processStart
      ? 'confirmed'
      : 'uncertain';
  } catch {
    return 'uncertain';
  }
}

async function view(lease, observeProcess) {
  const ownerState = await ownership(lease, observeProcess);
  return Object.freeze({
    ...lease,
    owner: Object.freeze({ ...lease.owner }),
    ownership: ownerState,
    recoveryRequired: ownerState === 'uncertain',
    ...(lease.spansBinding === undefined
      ? {}
      : {
          spansBinding: Object.freeze({
            ...lease.spansBinding,
            target: Object.freeze({ ...lease.spansBinding.target }),
          }),
        }),
    ...(lease.spansArchiveReservation === undefined
      ? {}
      : {
          spansArchiveReservation: Object.freeze({
            ...lease.spansArchiveReservation,
          }),
        }),
    target: lease.target && Object.freeze({ ...lease.target }),
  });
}

function refusal(code, error, extra = {}) {
  return Object.freeze({ code, error, ok: false, ...extra });
}

function sameLeaseProof(current, supplied) {
  return (
    current !== undefined &&
    current.kind === supplied.kind &&
    current.operationId === supplied.operationId &&
    current.acquiredAt === supplied.acquiredAt &&
    current.owner.pid === supplied.owner.pid &&
    current.owner.processStart === supplied.owner.processStart &&
    sameTarget(current.target, supplied.target) &&
    sameSpansBinding(current.spansBinding, supplied.spansBinding) &&
    sameSpansArchiveReservation(
      current.spansArchiveReservation,
      supplied.spansArchiveReservation
    )
  );
}

function archiveRootMissing(root, observation) {
  if (observation?.code !== 'ENOENT') {
    return false;
  }
  try {
    lstatSync(root);
  } catch (error) {
    return error.code === 'ENOENT';
  }
  return false;
}

async function checkArchiveWriteCapacity(
  root,
  maxBytes,
  leases,
  omittedReservation,
  archiveCapacity
) {
  if (
    Object.values(leases).some(
      (lease) =>
        lease.spansBinding !== undefined &&
        lease.spansArchiveReservation === undefined
    )
  ) {
    return refusal(
      'SPANS_ARCHIVE_CAPACITY_UNKNOWN',
      'A legacy Spans lease has no archive root; archive capacity is unknown.'
    );
  }
  let observation;
  try {
    observation =
      typeof archiveCapacity === 'function'
        ? await archiveCapacity({
            budgetBytes: SPANS_ARCHIVE_BUDGET_BYTES,
            root,
          })
        : undefined;
  } catch {
    observation = undefined;
  }
  const missing =
    omittedReservation === undefined &&
    !Object.values(leases).some((lease) =>
      sameArchiveStorage(lease.spansArchiveReservation?.root, root)
    ) &&
    archiveRootMissing(root, observation);
  const measuredBytes = missing ? 0 : observation?.totalBytes;
  let outstandingBytes = 0;
  for (const lease of Object.values(leases)) {
    const reservation = lease.spansArchiveReservation;
    if (
      sameArchiveStorage(reservation?.root, root) &&
      lease !== omittedReservation
    ) {
      outstandingBytes += reservation.reservedBytes;
    }
  }
  const committedBytes = measuredBytes + outstandingBytes;
  const totalWithWrite = committedBytes + maxBytes;
  if (
    (!missing && (observation?.ok !== true || observation.state !== 'known')) ||
    !Number.isSafeInteger(measuredBytes) ||
    measuredBytes < 0 ||
    !Number.isSafeInteger(outstandingBytes) ||
    !Number.isSafeInteger(committedBytes) ||
    !Number.isSafeInteger(totalWithWrite)
  ) {
    return refusal(
      'SPANS_ARCHIVE_CAPACITY_UNKNOWN',
      'Spans archive capacity is unknown; the archive write was not run.'
    );
  }
  if (totalWithWrite > SPANS_ARCHIVE_BUDGET_BYTES) {
    return refusal(
      'SPANS_ARCHIVE_CAPACITY_REACHED',
      'The Spans archive budget cannot fit this write.',
      {
        budgetBytes: SPANS_ARCHIVE_BUDGET_BYTES,
        committedBytes,
        measuredBytes,
        outstandingReservedBytes: outstandingBytes,
        requestedBytes: maxBytes,
      }
    );
  }
  return {
    ok: true,
    spansArchiveCapacity: Object.freeze({
      budgetBytes: SPANS_ARCHIVE_BUDGET_BYTES,
      committedBytes,
      measuredBytes,
      outstandingReservedBytes: outstandingBytes,
      reservedBytes: maxBytes,
      totalWithCandidate: totalWithWrite,
      warning:
        BigInt(totalWithWrite) * 5n >= BigInt(SPANS_ARCHIVE_BUDGET_BYTES) * 4n,
    }),
  };
}

function validRequest(request) {
  if (
    !(
      plainObject(request) &&
      KINDS.has(request.kind) &&
      safeId(request.operationId)
    )
  ) {
    return;
  }
  const target = copyTarget(request.target);
  const spansBinding = Object.hasOwn(request, 'spansBinding')
    ? copySpansBinding(request.spansBinding)
    : undefined;
  const archiveProperty = optionalDataProperty(
    request,
    'spansArchiveReservation'
  );
  const spansArchiveReservation =
    archiveProperty.valid && archiveProperty.present
      ? copySpansArchiveReservation(archiveProperty.value, spansBinding)
      : undefined;
  return target === undefined ||
    (Object.hasOwn(request, 'spansBinding') &&
      (spansBinding === undefined ||
        !sameTarget(spansBinding.target, target))) ||
    (archiveProperty.present &&
      (!archiveProperty.valid || spansArchiveReservation === undefined))
    ? undefined
    : {
        kind: request.kind,
        operationId: request.operationId,
        target,
        ...(spansBinding === undefined ? {} : { spansBinding }),
        ...(spansArchiveReservation === undefined
          ? {}
          : { spansArchiveReservation }),
      };
}

// This factory does not admit Stop, end-session, or recovery actions: those
// callers must never route those actions through new-work admission.
export function createResourceAdmission({
  hostHealth,
  state,
  now = Date.now,
  limits,
  observeProcess = observeProcessIdentity,
  archiveCapacity = inspectSpansCapacity,
} = {}) {
  const configured = policy(limits);
  const dependenciesValid =
    typeof hostHealth === 'function' &&
    state &&
    typeof state.read === 'function' &&
    typeof state.update === 'function' &&
    typeof now === 'function' &&
    typeof observeProcess === 'function';

  async function currentOwner() {
    try {
      const observed = await observeProcess(process.pid);
      return observed?.state === 'alive' &&
        observed.processId === process.pid &&
        typeof observed.processStartIdentity === 'string' &&
        observed.processStartIdentity
        ? { pid: process.pid, processStart: observed.processStartIdentity }
        : undefined;
    } catch {
      // An unconfirmed owner identity must not admit managed work.
    }
  }

  async function freshStorage() {
    let health;
    try {
      health = await hostHealth({ refresh: true });
    } catch {
      return refusal(
        'STORAGE_UNKNOWN',
        'Storage is unknown; new managed work was not admitted.'
      );
    }
    if (
      health?.state !== 'ready' ||
      !Number.isSafeInteger(health.availableBytes) ||
      health.availableBytes < 0
    ) {
      return refusal(
        'STORAGE_UNKNOWN',
        'Storage is unknown; new managed work was not admitted.'
      );
    }
    if (health.availableBytes < configured.lowStorageFloorBytes) {
      const gib = (bytes) => (bytes / 1024 ** 3).toFixed(1);
      return refusal(
        'STORAGE_LOW',
        `Storage is below the managed-work reserve (${gib(health.availableBytes)} GiB free, ${gib(configured.lowStorageFloorBytes)} GiB required); new work was not admitted. Free space, or register an existing linked checkout with \`setu adopt\`, which installs nothing.`,
        {
          availableBytes: health.availableBytes,
          minimumAvailableBytes: configured.lowStorageFloorBytes,
        }
      );
    }
    return { ok: true };
  }

  async function existingAdmission(existing, candidate, callerOwner) {
    if (
      existing.kind !== candidate.kind ||
      !sameTarget(existing.target, candidate.target) ||
      !sameSpansBinding(existing.spansBinding, candidate.spansBinding) ||
      !sameSpansArchiveReservation(
        existing.spansArchiveReservation,
        candidate.spansArchiveReservation
      )
    ) {
      return refusal(
        'OPERATION_ID_CONFLICT',
        'This operation id already owns a different admission lease.'
      );
    }
    const existingLease = await view(existing, observeProcess);
    if (sameOwner(existing.owner, callerOwner)) {
      return Object.freeze({ existing: true, lease: existingLease, ok: true });
    }
    return existingLease.ownership === 'uncertain'
      ? refusal(
          'LEASE_UNCERTAIN',
          'This operation lease has an unconfirmed owner and needs recovery.',
          { lease: existingLease }
        )
      : refusal(
          'LEASE_OWNED_BY_ANOTHER',
          'This operation id is owned by another managed operation.',
          { lease: existingLease }
        );
  }

  function capacityRefusal(candidate, leases) {
    const active = Object.values(leases);
    if (
      candidate.kind === 'install' &&
      active.some((activeLease) => activeLease.kind === 'install')
    ) {
      return refusal(
        'INSTALL_IN_PROGRESS',
        'Another managed dependency installation holds the shared install lane.'
      );
    }
    if (
      candidate.spansBinding !== undefined &&
      active.filter((lease) => lease.spansBinding !== undefined).length >= 2
    ) {
      return refusal(
        'SESSION_CAPACITY_REACHED',
        'The Spans worker limit has been reached.',
        { reason: 'session-capacity' }
      );
    }
    if (
      MANAGED_SESSION_KINDS.has(candidate.kind) &&
      active.filter((activeLease) =>
        MANAGED_SESSION_KINDS.has(activeLease.kind)
      ).length >= configured.maxManagedSessions
    ) {
      return refusal(
        'SESSION_CAPACITY_REACHED',
        'The managed session limit has been reached.',
        { reason: 'session-capacity' }
      );
    }
    return null;
  }

  async function admit(request) {
    if (!(dependenciesValid && configured)) {
      return refusal(
        'ADMISSION_UNAVAILABLE',
        'Resource admission is not configured safely.'
      );
    }
    const candidate = validRequest(request);
    if (!candidate) {
      return refusal(
        'INVALID_ADMISSION_REQUEST',
        'Admission request is invalid.'
      );
    }
    const storage = await freshStorage();
    if (!storage.ok) {
      return storage;
    }
    const callerOwner = await currentOwner();
    if (!callerOwner) {
      return refusal(
        'OWNER_IDENTITY_UNKNOWN',
        'The managed operation owner could not be confirmed.'
      );
    }
    let result;
    try {
      // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Replay, reservation and lease publication must stay in one serialized mutation.
      await state.update(ADMISSION_DOCUMENT, async (document) => {
        const leases = leasesFrom(document);
        if (!leases) {
          result = refusal(
            'ADMISSION_STATE_UNKNOWN',
            'Resource admission state is unreadable; new work was not admitted.'
          );
          return document;
        }
        const existing = leases[candidate.operationId];
        if (existing) {
          result = await existingAdmission(existing, candidate, callerOwner);
          return document;
        }
        // Lock order: callers must never enter admission while holding the
        // current-attempt SQLite write transaction. The capacity callback
        // runs inside workspace-state's shared admission update lock.
        const archiveCheck = await checkArchiveCapacity(
          candidate,
          leases,
          archiveCapacity
        );
        if (!archiveCheck.ok) {
          result = archiveCheck.refusal;
          return document;
        }
        const capacity = capacityRefusal(candidate, leases);
        if (capacity) {
          result = capacity;
          return document;
        }
        const acquiredAt = now();
        if (!Number.isSafeInteger(acquiredAt) || acquiredAt < 0) {
          result = refusal(
            'ADMISSION_UNAVAILABLE',
            'Resource admission clock is not configured safely.'
          );
          return document;
        }
        const lease = {
          acquiredAt,
          kind: candidate.kind,
          operationId: candidate.operationId,
          owner: callerOwner,
          target: candidate.target,
          ...(candidate.spansBinding === undefined
            ? {}
            : { spansBinding: candidate.spansBinding }),
          ...(candidate.spansArchiveReservation === undefined
            ? {}
            : {
                spansArchiveReservation: candidate.spansArchiveReservation,
              }),
        };
        leases[lease.operationId] = lease;
        result = Object.freeze({
          ...(archiveCheck.spansArchiveCapacity === undefined
            ? {}
            : { spansArchiveCapacity: archiveCheck.spansArchiveCapacity }),
          lease: await view(lease, observeProcess),
          ok: true,
        });
        return writeLeases(leases);
      });
      return result;
    } catch {
      return refusal(
        'ADMISSION_STATE_UNKNOWN',
        'Resource admission state could not be updated; new work was not admitted.'
      );
    }
  }

  async function release(leaseInput, guard) {
    const lease = copyLease(leaseInput);
    if (!(dependenciesValid && lease)) {
      return refusal(
        'LEASE_MISMATCH',
        'The admission lease does not match a managed operation.'
      );
    }
    let result;
    try {
      await state.update(ADMISSION_DOCUMENT, (document) => {
        const leases = leasesFrom(document);
        if (!leases) {
          result = refusal(
            'ADMISSION_STATE_UNKNOWN',
            'Resource admission state is unreadable; the lease was retained.'
          );
          return document;
        }
        const current = leases[lease.operationId];
        if (!current) {
          result = refusal(
            'LEASE_NOT_FOUND',
            'The admission lease is no longer present.'
          );
          return document;
        }
        if (
          current.kind !== lease.kind ||
          current.acquiredAt !== lease.acquiredAt ||
          current.owner.pid !== lease.owner.pid ||
          current.owner.processStart !== lease.owner.processStart ||
          !sameTarget(current.target, lease.target) ||
          !sameSpansBinding(current.spansBinding, lease.spansBinding) ||
          !sameSpansArchiveReservation(
            current.spansArchiveReservation,
            lease.spansArchiveReservation
          )
        ) {
          result = refusal(
            'LEASE_MISMATCH',
            'The admission lease does not match this operation.'
          );
          return document;
        }
        // Archive writers share this lock, so their generation cannot move here.
        if (
          guard !== undefined &&
          (typeof guard !== 'function' || guard() !== true)
        ) {
          result = refusal(
            'LEASE_BINDING_UNKNOWN',
            'The operation binding changed; the admission lease was retained.'
          );
          return document;
        }
        delete leases[lease.operationId];
        result = Object.freeze({ ok: true });
        return writeLeases(leases);
      });
      return result;
    } catch {
      return refusal(
        'ADMISSION_STATE_UNKNOWN',
        'Resource admission state could not be updated; the lease was retained.'
      );
    }
  }

  async function withSpansArchiveWrite(options, effect) {
    if (!(dependenciesValid && configured)) {
      return refusal(
        'ADMISSION_UNAVAILABLE',
        'Resource admission is not configured safely.'
      );
    }
    if (!plainObject(options)) {
      return refusal(
        'SPANS_ARCHIVE_WRITE_INVALID',
        'Spans archive write request is invalid.'
      );
    }
    const rootProperty = optionalDataProperty(options, 'root');
    const maxBytesProperty = optionalDataProperty(options, 'maxBytes');
    const leaseProperty = optionalDataProperty(options, 'lease');
    const root = rootProperty.value;
    const maxBytes = maxBytesProperty.value;
    if (
      !(rootProperty.valid && maxBytesProperty.valid && leaseProperty.valid) ||
      typeof root !== 'string' ||
      !isAbsolute(root) ||
      resolve(root) !== root ||
      hasControlCharacter(root) ||
      !Number.isSafeInteger(maxBytes) ||
      maxBytes <= 0 ||
      maxBytes > SPANS_ARCHIVE_BUDGET_BYTES ||
      typeof effect !== 'function'
    ) {
      return refusal(
        'SPANS_ARCHIVE_WRITE_INVALID',
        'Spans archive write request is invalid.'
      );
    }
    const hasLease = leaseProperty.present;
    const suppliedLease = hasLease ? copyLease(leaseProperty.value) : undefined;
    if (hasLease && !suppliedLease) {
      return refusal(
        'LEASE_MISMATCH',
        'The admission lease does not match a managed operation.'
      );
    }

    let result;
    let effectThrew = false;
    try {
      // Lock order: this shared admission lock is acquired before SQLite. Never
      // call this gate from inside withCurrentAttempt or another SQLite fence.
      // The trusted effect runs while the lock is held; it may be async.
      // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: lease validation, capacity checks and the write must share one locked transaction.
      await state.update(ADMISSION_DOCUMENT, async (document) => {
        const leases = leasesFrom(document);
        if (!leases) {
          result = refusal(
            'ADMISSION_STATE_UNKNOWN',
            'Resource admission state is unreadable; the archive write was not run.'
          );
          return document;
        }
        if (
          Object.values(leases).some(
            (lease) =>
              lease.spansBinding !== undefined &&
              lease.spansArchiveReservation === undefined
          )
        ) {
          result = refusal(
            'SPANS_ARCHIVE_CAPACITY_UNKNOWN',
            'A legacy Spans lease has no archive root; archive capacity is unknown.'
          );
          return document;
        }

        let omittedReservation;
        if (hasLease) {
          const current = leases[suppliedLease.operationId];
          if (
            !sameLeaseProof(current, suppliedLease) ||
            current.spansArchiveReservation?.root !== root ||
            maxBytes > current.spansArchiveReservation.reservedBytes
          ) {
            result = refusal(
              'LEASE_MISMATCH',
              'The admission lease does not match this archive reservation.'
            );
            return document;
          }
          omittedReservation = current;
        }

        const capacity = await checkArchiveWriteCapacity(
          root,
          maxBytes,
          leases,
          omittedReservation,
          archiveCapacity
        );
        if (!capacity.ok) {
          result = capacity;
          return document;
        }

        let value;
        try {
          value = await effect();
        } catch (error) {
          effectThrew = true;
          throw error;
        }
        const after = await checkArchiveWriteCapacity(
          root,
          0,
          leases,
          omittedReservation,
          archiveCapacity
        );
        if (
          !after.ok ||
          after.spansArchiveCapacity.measuredBytes >
            capacity.spansArchiveCapacity.measuredBytes + maxBytes
        ) {
          result = refusal(
            'SPANS_ARCHIVE_WRITE_UNKNOWN',
            'Archive write growth could not be confirmed within its allocation.',
            { unknown: true }
          );
          return document;
        }
        result = Object.freeze({
          ok: true,
          spansArchiveCapacity: capacity.spansArchiveCapacity,
          value,
        });
        return document;
      });
      return result;
    } catch {
      if (effectThrew) {
        return refusal(
          'SPANS_ARCHIVE_WRITE_UNKNOWN',
          'Archive write outcome is unknown; its reservation was retained.',
          { unknown: true }
        );
      }
      return refusal(
        'ADMISSION_STATE_UNKNOWN',
        'Resource admission state could not be updated; the archive write outcome is unknown.'
      );
    }
  }

  async function recoverLease(leaseInput) {
    const lease = copyLease(leaseInput);
    if (!(dependenciesValid && configured && lease)) {
      return refusal(
        'LEASE_MISMATCH',
        'The admission lease does not match a managed operation.'
      );
    }

    // Recovery hands off one existing lease; it does not re-run admission.
    let current;
    try {
      current = copyLease(
        state.read(ADMISSION_DOCUMENT)?.leases?.[lease.operationId]
      );
    } catch {
      return refusal(
        'ADMISSION_STATE_UNKNOWN',
        'Resource admission state is unreadable; the lease was retained.'
      );
    }
    if (!(current && sameLease(current, lease))) {
      return refusal(
        current ? 'LEASE_MISMATCH' : 'LEASE_NOT_FOUND',
        'The admission lease does not match the current operation.'
      );
    }

    const callerOwner = await currentOwner();
    if (!callerOwner) {
      return refusal(
        'OWNER_IDENTITY_UNKNOWN',
        'The recovery owner could not be confirmed; the lease was retained.'
      );
    }

    async function oldOwnerIsRecoverable() {
      try {
        const observed = await observeProcess(lease.owner.pid);
        if (observed?.state === 'absent') {
          return true;
        }
        return (
          observed?.state === 'alive' &&
          observed.processId === lease.owner.pid &&
          typeof observed.processStartIdentity === 'string' &&
          observed.processStartIdentity.length > 0 &&
          observed.processStartIdentity !== lease.owner.processStart
        );
      } catch {
        return false;
      }
    }

    const sameAsCaller = sameOwner(lease.owner, callerOwner);
    if (!(sameAsCaller || (await oldOwnerIsRecoverable()))) {
      return refusal(
        'LEASE_OWNER_NOT_RECOVERABLE',
        'The previous lease owner is alive or could not be confirmed; the lease was retained.'
      );
    }

    let result;
    try {
      await state.update(ADMISSION_DOCUMENT, async (document) => {
        const leases = leasesFrom(document);
        if (!leases) {
          result = refusal(
            'ADMISSION_STATE_UNKNOWN',
            'Resource admission state is unreadable; the lease was retained.'
          );
          return document;
        }
        const stored = leases[lease.operationId];
        if (!(stored && sameLease(stored, lease))) {
          result = refusal(
            stored ? 'LEASE_MISMATCH' : 'LEASE_NOT_FOUND',
            'The admission lease changed during recovery; it was retained.'
          );
          return document;
        }

        // Repeat both incarnation proofs within the serialized state update.
        const confirmedCaller = await currentOwner();
        if (!(confirmedCaller && sameOwner(confirmedCaller, callerOwner))) {
          result = refusal(
            'OWNER_IDENTITY_UNKNOWN',
            'The recovery owner changed during recovery; the lease was retained.'
          );
          return document;
        }
        if (!(sameAsCaller || (await oldOwnerIsRecoverable()))) {
          result = refusal(
            'LEASE_OWNER_NOT_RECOVERABLE',
            'The previous lease owner is alive or could not be confirmed; the lease was retained.'
          );
          return document;
        }

        const transferred = { ...stored, owner: confirmedCaller };
        leases[lease.operationId] = transferred;
        result = Object.freeze({
          lease: await view(transferred, observeProcess),
          ok: true,
        });
        return writeLeases(leases);
      });
      return result;
    } catch {
      return refusal(
        'ADMISSION_STATE_UNKNOWN',
        'Resource admission state could not be updated; the lease was retained.'
      );
    }
  }

  async function status() {
    if (!(dependenciesValid && configured)) {
      return refusal(
        'ADMISSION_UNAVAILABLE',
        'Resource admission is not configured safely.'
      );
    }
    try {
      const leases = leasesFrom(state.read(ADMISSION_DOCUMENT));
      if (!leases) {
        return refusal(
          'ADMISSION_STATE_UNKNOWN',
          'Resource admission state is unreadable.'
        );
      }
      const listed = await Promise.all(
        Object.values(leases).map((lease) => view(lease, observeProcess))
      );
      return Object.freeze({
        leases: Object.freeze(listed),
        limits: Object.freeze({ ...configured }),
        ok: true,
      });
    } catch {
      return refusal(
        'ADMISSION_STATE_UNKNOWN',
        'Resource admission state is unreadable.'
      );
    }
  }

  return Object.freeze({
    admit,
    recoverLease,
    release,
    status,
    withSpansArchiveWrite,
  });
}
