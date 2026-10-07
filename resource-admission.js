import { observeProcessIdentity } from './process-observation.js';

// Managed setup callers must admit before taking a target lock. The admission
// lease is durable coordination, while the target lock only protects one checkout.

export const DEFAULT_MANAGED_SESSION_LIMIT = 2;
export const DEFAULT_LOW_STORAGE_FLOOR_BYTES = 20 * 1024 ** 3;

const ADMISSION_DOCUMENT = 'resourceAdmission';
const KINDS = new Set(['install', 'session', 'headless-run']);
const MANAGED_SESSION_KINDS = new Set(['session', 'headless-run']);
const plainObject = (value) =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const safeId = (value) =>
  typeof value === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(value);
const safePart = (value) =>
  typeof value === 'string' &&
  /^[^/\\\s:\x00-\x20]+$/.test(value) &&
  !['.', '..'].includes(value) &&
  !value.startsWith('-');

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
  if (target === undefined) {
    return;
  }
  return {
    acquiredAt: value.acquiredAt,
    kind: value.kind,
    operationId: value.operationId,
    owner: { pid: value.owner.pid, processStart: value.owner.processStart },
    target,
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
    target: lease.target && Object.freeze({ ...lease.target }),
  });
}

function refusal(code, error, extra = {}) {
  return Object.freeze({ code, error, ok: false, ...extra });
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
  return target === undefined
    ? undefined
    : { kind: request.kind, operationId: request.operationId, target };
}

// This factory does not admit Stop, end-session, or recovery actions: those
// callers must never route those actions through new-work admission.
export function createResourceAdmission({
  hostHealth,
  state,
  now = Date.now,
  limits,
  observeProcess = observeProcessIdentity,
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
    } catch {}
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
      return refusal(
        'STORAGE_LOW',
        'Storage is below the managed-work reserve; new work was not admitted.',
        {
          availableBytes: health.availableBytes,
          minimumAvailableBytes: configured.lowStorageFloorBytes,
        }
      );
    }
    return { ok: true };
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
          if (
            existing.kind === candidate.kind &&
            sameTarget(existing.target, candidate.target)
          ) {
            const existingLease = await view(existing, observeProcess);
            if (sameOwner(existing.owner, callerOwner)) {
              result = Object.freeze({
                existing: true,
                lease: existingLease,
                ok: true,
              });
            } else if (existingLease.ownership === 'uncertain') {
              result = refusal(
                'LEASE_UNCERTAIN',
                'This operation lease has an unconfirmed owner and needs recovery.',
                { lease: existingLease }
              );
            } else {
              result = refusal(
                'LEASE_OWNED_BY_ANOTHER',
                'This operation id is owned by another managed operation.',
                { lease: existingLease }
              );
            }
          } else {
            result = refusal(
              'OPERATION_ID_CONFLICT',
              'This operation id already owns a different admission lease.'
            );
          }
          return document;
        }
        const active = Object.values(leases);
        if (
          candidate.kind === 'install' &&
          active.some((lease) => lease.kind === 'install')
        ) {
          result = refusal(
            'INSTALL_IN_PROGRESS',
            'Another managed dependency installation holds the shared install lane.'
          );
          return document;
        }
        if (
          MANAGED_SESSION_KINDS.has(candidate.kind) &&
          active.filter((lease) => MANAGED_SESSION_KINDS.has(lease.kind))
            .length >= configured.maxManagedSessions
        ) {
          result = refusal(
            'SESSION_CAPACITY_REACHED',
            'The managed session limit has been reached.',
            { reason: 'session-capacity' }
          );
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
        };
        leases[lease.operationId] = lease;
        result = Object.freeze({
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

  async function release(leaseInput) {
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
          !sameTarget(current.target, lease.target)
        ) {
          result = refusal(
            'LEASE_MISMATCH',
            'The admission lease does not match this operation.'
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

  return Object.freeze({ admit, release, status });
}
