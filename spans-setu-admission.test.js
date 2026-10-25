import { afterEach, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createResourceAdmission,
  SPANS_ARCHIVE_BUDGET_BYTES,
} from './resource-admission.js';
import { createSpansSetuAdmission } from './spans-setu-admission.js';
import { createWorkspaceState } from './workspace-state.js';

const roots = [];
const GiB = 1024 ** 3;
const CAPTURE_LIMIT_BYTES = 64 * 1024;
const METADATA_HEADROOM_BYTES = 8 * 1024;

function operationId(binding) {
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

function readJson(path, fallback) {
  try {
    return JSON.parse(fs.readFileSync(path, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') {
      return fallback;
    }
    throw error;
  }
}

function writeJson(path, value) {
  fs.writeFileSync(path, `${JSON.stringify(value)}\n`, { mode: 0o600 });
  fs.chmodSync(path, 0o600);
}

function sameBinding(left, right) {
  return (
    left.actionId === right.actionId &&
    left.attemptId === right.attemptId &&
    left.generation === right.generation &&
    left.runId === right.runId &&
    left.spanId === right.spanId &&
    left.target.repo === right.target.repo &&
    left.target.name === right.target.name
  );
}

function fixture({ maxManagedSessions = 2, archiveCapacity } = {}) {
  const root = fs.mkdtempSync(join(tmpdir(), 'setu-spans-admission-'));
  roots.push(root);
  const home = join(root, 'home');
  const archive = join(root, 'archive');
  fs.mkdirSync(home, { mode: 0o700 });
  fs.mkdirSync(archive, { mode: 0o700 });
  fs.chmodSync(home, 0o700);
  fs.chmodSync(archive, 0o700);

  const state = createWorkspaceState({
    configPath: join(home, '.setu.json'),
    setuDir: home,
    workspaceRoot: home,
  });
  const reviewsPath = join(home, 'trusted-reviews.json');
  const revocationsPath = join(home, 'approval-revocations.json');
  const resourceAdmission = createResourceAdmission({
    ...(archiveCapacity === undefined ? {} : { archiveCapacity }),
    hostHealth: async () => ({
      availableBytes: 50 * GiB,
      state: 'ready',
    }),
    limits: { lowStorageFloorBytes: 0, maxManagedSessions },
    now: () => 1234,
    observeProcess: async (pid) => ({
      processId: pid,
      processStartIdentity: 'fixture-process-start',
      state: 'alive',
    }),
    state,
  });

  function readReview(id) {
    return readJson(reviewsPath, {})[id] ?? null;
  }

  function writeReview(id, record) {
    const reviews = readJson(reviewsPath, {});
    reviews[id] = record;
    writeJson(reviewsPath, reviews);
  }

  function register(bindingOverrides = {}, reservationOverrides = {}) {
    const binding = {
      actionId: 'action-a',
      attemptId: 'attempt-a',
      generation: 3,
      runId: 'run-a',
      spanId: 'span-a',
      target: { name: 'feat/a', repo: 'setu' },
      ...bindingOverrides,
    };
    const id = operationId(binding);
    const review = {
      binding,
      captureLimitBytes: CAPTURE_LIMIT_BYTES,
      metadataHeadroomBytes: METADATA_HEADROOM_BYTES,
      reservationRoot: fs.realpathSync(archive),
      ...reservationOverrides,
    };
    writeReview(id, review);
    return { binding, id };
  }

  function replaceBinding(id, binding) {
    const review = readReview(id);
    writeReview(id, { ...review, binding });
  }

  function replaceReservation(id, changes) {
    const review = readReview(id);
    writeReview(id, { ...review, ...changes });
  }

  function revokeApproval(id) {
    const rows = readJson(revocationsPath, []);
    if (!rows.includes(id)) {
      rows.push(id);
    }
    writeJson(revocationsPath, rows);
  }

  const resolveOperation = async ({ operationId: id }) =>
    readReview(id)?.binding ?? null;
  const resolveArchiveReservation = ({ binding, operationId: id }) => {
    const review = readReview(id);
    if (!(review && sameBinding(review.binding, binding))) {
      return null;
    }
    return {
      budgetBytes: SPANS_ARCHIVE_BUDGET_BYTES,
      reservedBytes: review.captureLimitBytes + review.metadataHeadroomBytes,
      root: review.reservationRoot,
    };
  };
  const adapter = (authority = resourceAdmission, overrides = {}) =>
    createSpansSetuAdmission({
      resolveArchiveReservation:
        overrides.resolveArchiveReservation ?? resolveArchiveReservation,
      resolveOperation: overrides.resolveOperation ?? resolveOperation,
      resourceAdmission: authority,
    });

  return {
    adapter,
    archive,
    home,
    readReview,
    register,
    replaceBinding,
    replaceReservation,
    resourceAdmission,
    revokeApproval,
    root,
    state,
  };
}

const admissionInput = ({ id, binding }, overrides = {}) => ({
  kind: 'headless-run',
  operationId: id,
  target: binding.target,
  ...overrides,
});

afterEach(() => {
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { force: true, recursive: true });
  }
});

test('one durable resource authority enforces concurrency and exact replay reuses the lease', async () => {
  const f = fixture({ maxManagedSessions: 1 });
  const a = f.register();
  const b = f.register({
    actionId: 'action-b',
    attemptId: 'attempt-b',
    spanId: 'span-b',
  });
  const adapter = f.adapter();

  const [first, concurrent] = await Promise.all([
    adapter.admit(admissionInput(a)),
    adapter.admit(admissionInput(b)),
  ]);
  expect(first.ok).toBe(true);
  expect(concurrent).toMatchObject({
    code: 'SESSION_CAPACITY_REACHED',
    ok: false,
  });

  const retry = await adapter.admit(admissionInput(a));
  expect(retry).toMatchObject({ existing: true, ok: true });
  expect(retry.lease).toEqual(first.lease);
  expect((await f.resourceAdmission.status()).leases).toHaveLength(1);
});

test('the first preintent lookup can use a prepared binding, then revalidation and restart use the durable review', async () => {
  const f = fixture();
  const request = f.register();
  let reads = 0;
  const first = f.adapter(f.resourceAdmission, {
    resolveOperation: ({ operationId: id }) => {
      reads += 1;
      return reads === 1 && id === request.id
        ? request.binding
        : (f.readReview(id)?.binding ?? null);
    },
  });

  const admitted = await first.admit(admissionInput(request));
  expect(admitted.ok).toBe(true);
  expect(reads).toBeGreaterThanOrEqual(2);
  await expect(f.adapter().status()).resolves.toMatchObject({
    leases: [expect.objectContaining({ spansBinding: request.binding })],
    ok: true,
  });
});

test('the trusted persisted review derives an exact reservation reusable by the shared archive gate', async () => {
  const f = fixture();
  const request = f.register();
  const adapter = f.adapter();
  const admitted = await adapter.admit(admissionInput(request));
  const expectedReservation = {
    budgetBytes: SPANS_ARCHIVE_BUDGET_BYTES,
    reservedBytes: CAPTURE_LIMIT_BYTES + METADATA_HEADROOM_BYTES,
    root: fs.realpathSync(f.archive),
  };
  expect(admitted.ok).toBe(true);
  expect(admitted.lease.spansBinding).toEqual(request.binding);
  expect(admitted.lease.spansArchiveReservation).toEqual(expectedReservation);

  let writes = 0;
  await expect(
    f.resourceAdmission.withSpansArchiveWrite(
      {
        lease: admitted.lease,
        maxBytes: CAPTURE_LIMIT_BYTES,
        root: expectedReservation.root,
      },
      () => {
        writes += 1;
        fs.writeFileSync(join(f.archive, 'spool-capture.bin'), 'capture');
        return 'captured';
      }
    )
  ).resolves.toMatchObject({ ok: true, value: 'captured' });
  expect(writes).toBe(1);

  let foreignWrites = 0;
  await expect(
    f.resourceAdmission.withSpansArchiveWrite(
      {
        lease: {
          ...admitted.lease,
          spansArchiveReservation: {
            ...expectedReservation,
            reservedBytes: expectedReservation.reservedBytes + 1,
          },
        },
        maxBytes: CAPTURE_LIMIT_BYTES,
        root: expectedReservation.root,
      },
      () => {
        foreignWrites += 1;
      }
    )
  ).resolves.toMatchObject({ code: 'LEASE_MISMATCH', ok: false });
  expect(foreignWrites).toBe(0);
});

test('a current exact lease releases after approval revocation because review identity remains resolvable', async () => {
  const f = fixture();
  const request = f.register();
  const adapter = f.adapter();
  const admitted = await adapter.admit(admissionInput(request));
  expect(admitted.ok).toBe(true);

  // The immutable review identity is stored separately from approval events.
  // The bridge resolves identity only; the root coordinator checks current
  // approval before any new admission or launch.
  f.revokeApproval(request.id);
  expect(fs.existsSync(join(f.home, 'approval-revocations.json'))).toBe(true);
  await expect(adapter.release(admitted.lease)).resolves.toEqual({ ok: true });
  expect((await f.resourceAdmission.status()).leases).toEqual([]);
});

test('recreated adapters revalidate the persisted binding and release the same durable lease', async () => {
  const f = fixture();
  const request = f.register();
  const admitted = await f.adapter().admit(admissionInput(request));
  expect(admitted.ok).toBe(true);

  const restarted = f.adapter();
  await expect(restarted.status()).resolves.toMatchObject({
    leases: [expect.objectContaining({ spansBinding: request.binding })],
    ok: true,
  });
  await expect(restarted.admit(admissionInput(request))).resolves.toMatchObject(
    {
      existing: true,
      lease: expect.objectContaining({ spansBinding: request.binding }),
      ok: true,
    }
  );
  await expect(restarted.release(admitted.lease)).resolves.toEqual({
    ok: true,
  });
  expect((await f.resourceAdmission.status()).leases).toEqual([]);
});

test('generation movement refuses stale release and retains the authoritative lease', async () => {
  const f = fixture();
  const request = f.register();
  const adapter = f.adapter();
  const admitted = await adapter.admit(admissionInput(request));
  f.replaceBinding(request.id, {
    ...request.binding,
    generation: request.binding.generation + 1,
  });

  await expect(adapter.release(admitted.lease)).resolves.toMatchObject({
    code: 'LEASE_BINDING_UNKNOWN',
    ok: false,
  });
  expect((await f.resourceAdmission.status()).leases).toHaveLength(1);
});

test('generation movement during awaited admission retains the late lease as unknown', async () => {
  const f = fixture();
  const request = f.register();
  const authority = {
    ...f.resourceAdmission,
    async admit(input) {
      const result = await f.resourceAdmission.admit(input);
      f.replaceBinding(request.id, {
        ...request.binding,
        generation: request.binding.generation + 1,
      });
      return result;
    },
  };
  const adapter = f.adapter(authority);

  await expect(adapter.admit(admissionInput(request))).resolves.toMatchObject({
    code: 'LEASE_BINDING_UNKNOWN',
    ok: false,
  });
  await expect(adapter.status()).resolves.toMatchObject({
    code: 'LEASE_BINDING_UNKNOWN',
    ok: false,
  });
  expect((await f.resourceAdmission.status()).leases).toHaveLength(1);
});

test('reservation changes during admission retain the durable lease as unknown', async () => {
  const f = fixture();
  const request = f.register();
  let reads = 0;
  const adapter = f.adapter(f.resourceAdmission, {
    resolveArchiveReservation: ({ binding, operationId: id }) => {
      reads += 1;
      if (reads === 2) {
        f.replaceReservation(id, { metadataHeadroomBytes: 16 * 1024 });
      }
      const review = f.readReview(id);
      return review?.binding && sameBinding(review.binding, binding)
        ? {
            budgetBytes: SPANS_ARCHIVE_BUDGET_BYTES,
            reservedBytes:
              review.captureLimitBytes + review.metadataHeadroomBytes,
            root: review.reservationRoot,
          }
        : null;
    },
  });
  expect(await adapter.admit(admissionInput(request))).toMatchObject({
    code: 'LEASE_BINDING_UNKNOWN',
    ok: false,
  });
  expect((await f.resourceAdmission.status()).leases).toHaveLength(1);
});

test('untrusted admission extras and accessor data are rejected before resource writes', async () => {
  const f = fixture();
  const request = f.register();
  const adapter = f.adapter();
  const calls = [];
  const input = admissionInput(request);
  const accessor = { ...input };
  Object.defineProperty(accessor, 'operationId', {
    enumerable: true,
    get() {
      calls.push('operationId');
      return request.id;
    },
  });
  const symbolInput = { ...input, [Symbol('approval')]: true };
  const extraTarget = {
    ...input,
    target: { ...input.target, displayName: 'trusted-looking' },
  };
  await expect(adapter.admit(accessor)).resolves.toMatchObject({
    code: 'INVALID_ADMISSION_REQUEST',
    ok: false,
  });
  await expect(
    adapter.admit({ ...input, approved: true })
  ).resolves.toMatchObject({ code: 'INVALID_ADMISSION_REQUEST', ok: false });
  await expect(
    adapter.admit({
      ...input,
      spansArchiveReservation: {
        budgetBytes: SPANS_ARCHIVE_BUDGET_BYTES,
        reservedBytes: 1,
        root: fs.realpathSync(f.archive),
      },
    })
  ).resolves.toMatchObject({ code: 'INVALID_ADMISSION_REQUEST', ok: false });
  await expect(adapter.admit(symbolInput)).resolves.toMatchObject({
    code: 'INVALID_ADMISSION_REQUEST',
    ok: false,
  });
  await expect(adapter.admit(extraTarget)).resolves.toMatchObject({
    code: 'INVALID_ADMISSION_REQUEST',
    ok: false,
  });
  expect(calls).toEqual([]);
  expect((await f.resourceAdmission.status()).leases).toEqual([]);
});

test('resolver bindings and persisted targets require exact data-only identity', async () => {
  const f = fixture();
  const request = f.register();
  let getterCalls = 0;
  const accessor = { ...request.binding };
  Object.defineProperty(accessor, 'runId', {
    enumerable: true,
    get() {
      getterCalls += 1;
      return request.binding.runId;
    },
  });
  const badBinding = f.adapter(f.resourceAdmission, {
    resolveOperation: async () => accessor,
  });
  await expect(
    badBinding.admit(admissionInput(request))
  ).resolves.toMatchObject({
    code: 'LEASE_BINDING_UNKNOWN',
    ok: false,
  });
  expect(getterCalls).toBe(0);

  const badTarget = f.adapter(f.resourceAdmission, {
    resolveOperation: async () => ({
      ...request.binding,
      target: { ...request.binding.target, extra: true },
    }),
  });
  await expect(badTarget.admit(admissionInput(request))).resolves.toMatchObject(
    {
      code: 'LEASE_BINDING_UNKNOWN',
      ok: false,
    }
  );
  expect((await f.resourceAdmission.status()).leases).toEqual([]);
});

test('invalid reservation roots or unknown archive capacity fail closed without creating the archive', async () => {
  const unknown = fixture({
    archiveCapacity: async () => ({ ok: false, state: 'unknown' }),
  });
  const unknownRequest = unknown.register();
  await expect(
    unknown.adapter().admit(admissionInput(unknownRequest))
  ).resolves.toMatchObject({
    code: 'SPANS_ARCHIVE_CAPACITY_UNKNOWN',
    ok: false,
  });
  expect((await unknown.resourceAdmission.status()).leases).toEqual([]);

  const missing = fixture();
  const missingRequest = missing.register();
  const absentArchive = join(missing.root, 'not-created');
  missing.replaceReservation(missingRequest.id, {
    reservationRoot: absentArchive,
  });
  await expect(
    missing.adapter().admit(admissionInput(missingRequest))
  ).resolves.toMatchObject({
    code: 'SPANS_ARCHIVE_CAPACITY_UNKNOWN',
    ok: false,
  });
  expect(fs.existsSync(absentArchive)).toBe(false);
  expect((await missing.resourceAdmission.status()).leases).toEqual([]);

  const nonCanonical = fixture();
  const nonCanonicalRequest = nonCanonical.register();
  nonCanonical.replaceReservation(nonCanonicalRequest.id, {
    reservationRoot: `${nonCanonical.archive}/../archive`,
  });
  await expect(
    nonCanonical.adapter().admit(admissionInput(nonCanonicalRequest))
  ).resolves.toMatchObject({ code: 'LEASE_BINDING_UNKNOWN', ok: false });
  expect((await nonCanonical.resourceAdmission.status()).leases).toEqual([]);
});

test('the shared 5 GiB reservation boundary is serialized across Spans contenders', async () => {
  const f = fixture();
  const exactFit = f.register(
    { actionId: 'action-full', attemptId: 'attempt-full', spanId: 'full' },
    {
      captureLimitBytes: SPANS_ARCHIVE_BUDGET_BYTES - 4096,
      metadataHeadroomBytes: 4096,
    }
  );
  const overCapacity = f.register(
    { actionId: 'action-next', attemptId: 'attempt-next', spanId: 'next' },
    { captureLimitBytes: 1, metadataHeadroomBytes: 1 }
  );
  const adapter = f.adapter();

  const first = await adapter.admit(admissionInput(exactFit));
  expect(first).toMatchObject({
    ok: true,
    spansArchiveCapacity: {
      totalWithCandidate: SPANS_ARCHIVE_BUDGET_BYTES,
    },
  });
  await expect(
    adapter.admit(admissionInput(overCapacity))
  ).resolves.toMatchObject({
    code: 'SPANS_ARCHIVE_CAPACITY_REACHED',
    ok: false,
  });
  expect((await f.resourceAdmission.status()).leases).toHaveLength(1);
});

test('an unbound generic lease with the same operation id is never adopted', async () => {
  const f = fixture();
  const request = f.register();
  await f.resourceAdmission.admit({
    kind: 'headless-run',
    operationId: request.id,
    target: request.binding.target,
  });
  await expect(
    f.adapter().admit(admissionInput(request))
  ).resolves.toMatchObject({ code: 'LEASE_BINDING_UNKNOWN', ok: false });
  const status = await f.resourceAdmission.status();
  expect(status.leases).toHaveLength(1);
  expect(status.leases[0].spansBinding).toBeUndefined();
});

test('foreign bindings, targets, reservations, and child owners cannot release another lease', async () => {
  const f = fixture();
  const request = f.register();
  const adapter = f.adapter();
  const admitted = await adapter.admit(admissionInput(request));
  expect(admitted.ok).toBe(true);

  const forged = [
    { ...admitted.lease, spansBinding: { ...request.binding, actionId: 'x' } },
    { ...admitted.lease, target: { ...admitted.lease.target, name: 'other' } },
    {
      ...admitted.lease,
      spansArchiveReservation: {
        ...admitted.lease.spansArchiveReservation,
        reservedBytes: admitted.lease.spansArchiveReservation.reservedBytes + 1,
      },
    },
    {
      ...admitted.lease,
      owner: { ...admitted.lease.owner, processStart: 'different-child' },
    },
  ];
  await Promise.all(
    forged.map((lease) =>
      expect(adapter.release(lease)).resolves.toMatchObject({ ok: false })
    )
  );
  expect((await f.resourceAdmission.status()).leases).toHaveLength(1);
});

test('missing reservation resolver or shared archive gate fails before admission', async () => {
  const f = fixture();
  const request = f.register();
  const noResolver = createSpansSetuAdmission({
    resolveOperation: async () => request.binding,
    resourceAdmission: f.resourceAdmission,
  });
  await expect(
    noResolver.admit(admissionInput(request))
  ).resolves.toMatchObject({ code: 'ADMISSION_UNAVAILABLE', ok: false });

  const noGateAuthority = {
    admit: f.resourceAdmission.admit,
    release: f.resourceAdmission.release,
    status: f.resourceAdmission.status,
  };
  const noGate = f.adapter(noGateAuthority);
  await expect(noGate.admit(admissionInput(request))).resolves.toMatchObject({
    code: 'ADMISSION_UNAVAILABLE',
    ok: false,
  });
  expect((await f.resourceAdmission.status()).leases).toEqual([]);
});

test('unrelated shared leases remain under resource admission but stay out of Spans status', async () => {
  const f = fixture();
  const request = f.register();
  await f.resourceAdmission.admit({
    kind: 'session',
    operationId: 'managed-session-1',
    target: { name: 'other', repo: 'setu' },
  });
  const admitted = await f.adapter().admit(admissionInput(request));
  expect(admitted.ok).toBe(true);
  await expect(f.adapter().status()).resolves.toMatchObject({
    leases: [admitted.lease],
    ok: true,
  });
  expect((await f.resourceAdmission.status()).leases).toHaveLength(2);
});
