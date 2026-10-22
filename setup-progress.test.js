import { afterEach, expect, test } from 'bun:test';
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createDependencyReceipt,
  observeDependencyInstallInputs,
  validateDependencyInstallInputs,
} from './dependency-readiness.js';
import { createSetupProgress } from './setup-progress.js';
import { createWorkspaceState } from './workspace-state.js';

const roots = [];
afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { force: true, recursive: true });
  }
});

function stateFixture() {
  const root = mkdtempSync(join(tmpdir(), 'setu-progress-test-'));
  roots.push(root);
  const configPath = join(root, 'config.json');
  return {
    configPath,
    root,
    state: createWorkspaceState({
      configPath,
      setuDir: root,
      workspaceRoot: root,
    }),
  };
}

const target = { name: 'topic', repo: 'app' };

test('setup progress persists its stage, checkout identity, log location and terminal outcome', async () => {
  let time = 10;
  const { state } = stateFixture();
  const progress = createSetupProgress({
    newAttemptId: () => 'attempt-1',
    now: () => time,
    state,
  });
  await expect(
    progress.start({
      checkoutIdentity: 'checkout-a',
      logLocation: 'logs/app-topic-setup.log',
      stage: 'dependencies',
      target,
    })
  ).resolves.toMatchObject({
    ok: true,
    record: { attemptId: 'attempt-1', outcome: null },
  });
  time = 11;
  await progress.stage({
    attemptId: 'attempt-1',
    checkoutIdentity: 'checkout-a',
    stage: 'ready-check',
    target,
  });
  time = 12;
  await progress.finish({
    attemptId: 'attempt-1',
    checkoutIdentity: 'checkout-a',
    outcome: 'completed',
    target,
  });
  expect(progress.get(target)).toEqual({
    attemptId: 'attempt-1',
    checkoutIdentity: 'checkout-a',
    finishedAt: 12,
    logLocation: 'logs/app-topic-setup.log',
    outcome: 'completed',
    stage: 'ready-check',
    startedAt: 10,
    state: 'completed',
    target,
    updatedAt: 12,
  });
});

test('restart recovery turns unfinished setup into unknown and a retry reuses its record', async () => {
  let time = 100;
  const { state } = stateFixture();
  const first = createSetupProgress({
    newAttemptId: () => 'attempt-1',
    now: () => time,
    state,
  });
  await first.start({
    checkoutIdentity: 'checkout-a',
    logLocation: 'logs/setup.log',
    stage: 'dependencies',
    target,
  });
  time = 101;
  const restarted = createSetupProgress({
    newAttemptId: () => 'attempt-2',
    now: () => time,
    state,
  });
  await expect(restarted.recover()).resolves.toEqual({
    ok: true,
    recovered: 1,
  });
  expect(restarted.get(target)).toMatchObject({
    outcome: 'unknown',
    state: 'unknown',
  });
  time = 102;
  await expect(
    restarted.retry({
      attemptId: 'attempt-1',
      checkoutIdentity: 'checkout-a',
      logLocation: 'logs/setup-retry.log',
      stage: 'dependencies',
      target,
    })
  ).resolves.toMatchObject({
    ok: true,
    record: { attemptId: 'attempt-2', outcome: null, state: 'running' },
  });
  expect(restarted.get(target)).toMatchObject({
    checkoutIdentity: 'checkout-a',
    logLocation: 'logs/setup-retry.log',
    startedAt: 102,
  });
});

test('progress refuses a different checkout identity and does not execute setup work', async () => {
  const calls = [];
  const { state } = stateFixture();
  const progress = createSetupProgress({
    newAttemptId: () => 'attempt-1',
    now: () => 1,
    run: () => calls.push('run'),
    state,
  });
  await progress.start({
    checkoutIdentity: 'checkout-a',
    logLocation: 'logs/setup.log',
    stage: 'dependencies',
    target,
  });
  await expect(
    progress.stage({
      attemptId: 'attempt-1',
      checkoutIdentity: 'checkout-b',
      stage: 'ready-check',
      target,
    })
  ).resolves.toMatchObject({ code: 'CHECKOUT_IDENTITY_MISMATCH', ok: false });
  expect(calls).toEqual([]);
});

test('progress retains a structured checkout identity after atomic persistence', async () => {
  const { state } = stateFixture();
  const progress = createSetupProgress({
    newAttemptId: () => 'attempt-1',
    now: () => 1,
    state,
  });
  const identity = { checkout: { dev: '1', ino: '2' }, known: true };
  await progress.start({
    checkoutIdentity: identity,
    logLocation: 'logs/setup.log',
    stage: 'dependencies',
    target,
  });
  await expect(
    progress.stage({
      attemptId: 'attempt-1',
      checkoutIdentity: { checkout: { dev: '1', ino: '2' }, known: true },
      stage: 'ready-check',
      target,
    })
  ).resolves.toMatchObject({ ok: true, record: { stage: 'ready-check' } });
});

test('setup progress leaves the hand-edited config document byte-for-byte unchanged', async () => {
  const { configPath, state } = stateFixture();
  writeFileSync(configPath, '{\n  "manualSetting": "keep whitespace"\n}\n');
  const before = readFileSync(configPath, 'utf8');
  const progress = createSetupProgress({
    newAttemptId: () => 'attempt-1',
    now: () => 1,
    state,
  });
  await progress.start({
    checkoutIdentity: 'checkout-a',
    logLocation: 'logs/setup.log',
    stage: 'dependencies',
    target,
  });
  expect(readFileSync(configPath, 'utf8')).toBe(before);
  expect(state.read('setupProgress').records['app/topic']).toMatchObject({
    stage: 'dependencies',
  });
});

test('attempt ids reject late updates and terminal records cannot change outcome', async () => {
  const { state } = stateFixture();
  const attempts = ['attempt-1', 'attempt-2'];
  const progress = createSetupProgress({
    newAttemptId: () => attempts.shift(),
    now: () => 1,
    state,
  });
  await progress.start({
    checkoutIdentity: 'checkout-a',
    logLocation: 'logs/setup.log',
    stage: 'dependencies',
    target,
  });
  await progress.finish({
    attemptId: 'attempt-1',
    checkoutIdentity: 'checkout-a',
    outcome: 'failed',
    target,
  });
  await progress.retry({
    attemptId: 'attempt-1',
    checkoutIdentity: 'checkout-a',
    logLocation: 'logs/retry.log',
    stage: 'dependencies',
    target,
  });
  await expect(
    progress.finish({
      attemptId: 'attempt-1',
      checkoutIdentity: 'checkout-a',
      outcome: 'failed',
      target,
    })
  ).resolves.toMatchObject({ code: 'SETUP_ATTEMPT_MISMATCH', ok: false });
  await progress.finish({
    attemptId: 'attempt-2',
    checkoutIdentity: 'checkout-a',
    outcome: 'completed',
    target,
  });
  await expect(
    progress.finish({
      attemptId: 'attempt-2',
      checkoutIdentity: 'checkout-a',
      outcome: 'failed',
      target,
    })
  ).resolves.toMatchObject({ code: 'SETUP_NOT_RUNNING', ok: false });
});

test('malformed setup progress records are refused without changing journal bytes', async () => {
  const { root, state } = stateFixture();
  const documentPath = join(root, '.setu-setup-progress.json');
  writeFileSync(documentPath, '{\n  "records": []\n}\n');
  const before = readFileSync(documentPath, 'utf8');
  const progress = createSetupProgress({
    newAttemptId: () => 'attempt-1',
    now: () => 1,
    state,
  });
  await expect(
    progress.start({
      checkoutIdentity: 'checkout-a',
      logLocation: 'logs/setup.log',
      stage: 'dependencies',
      target,
    })
  ).resolves.toMatchObject({ code: 'SETUP_PROGRESS_CORRUPT', ok: false });
  expect(readFileSync(documentPath, 'utf8')).toBe(before);
});

async function dependencyProgressFixture() {
  const fixture = stateFixture();
  mkdirSync(join(fixture.root, 'checkout'));
  const wtDir = realpathSync(join(fixture.root, 'checkout'));
  writeFileSync(
    join(wtDir, 'package.json'),
    '{"name":"empty-fixture","version":"1.0.0"}'
  );
  const stat = (path) => {
    const info = lstatSync(path, { bigint: true });
    return {
      birthtimeNs: String(info.birthtimeNs),
      dev: String(info.dev),
      ino: String(info.ino),
    };
  };
  const checkoutIdentity = {
    admin: stat(fixture.root),
    adminPath: realpathSync(fixture.root),
    checkout: stat(wtDir),
    checkoutPath: wtDir,
    known: true,
    repository: stat(fixture.root),
    repositoryPath: realpathSync(fixture.root),
  };
  const progress = createSetupProgress({
    newAttemptId: () => 'receipt-attempt',
    state: fixture.state,
  });
  await progress.start({
    checkoutIdentity,
    logLocation: 'logs/empty.log',
    stage: 'no-dependencies',
    target,
  });
  const built = await createDependencyReceipt({
    attemptId: 'receipt-attempt',
    checkoutIdentity,
    wtDir,
  });
  expect(built.ok).toBe(true);
  return { ...fixture, checkoutIdentity, progress, receipt: built.receipt };
}

async function enrollmentFixture() {
  const fixture = await dependencyProgressFixture();
  const { checkoutIdentity, progress, root, state } = fixture;
  await progress.stage({
    attemptId: 'receipt-attempt',
    checkoutIdentity,
    stage: 'dependency-enrollment',
    target,
  });
  const operationId = 'c'.repeat(64);
  const view = {
    checkoutIdentity,
    completedFiles: 0,
    createdAt: 1,
    id: operationId,
    inputDigest: 'd'.repeat(64),
    logicalCloneBytes: 0,
    mode: 'hoisted-cow',
    name: 'topic',
    physicalSavingsBytes: null,
    planId: operationId,
    repo: 'app',
    retainedOriginalFiles: 0,
    state: 'completed',
    storeIdentity: {
      device: String(lstatSync(root, { bigint: true }).dev),
      executable: join(root, 'bun'),
      mountPath: root,
      namespace: 'hoisted/darwin-arm64-bun-1.3.14',
      root: join(root, 'store'),
      version: '1.3.14',
    },
    totalFiles: 0,
    updatedAt: 1,
    version: 1,
  };
  await state.update('dependencyFiles', () => ({
    operations: { [operationId]: view },
    version: 1,
    views: { 'app/topic': view },
  }));
  const observed = await observeDependencyInstallInputs({
    bunVersion: '1.3.14',
    wtDir: realpathSync(join(root, 'checkout')),
  });
  expect(observed.ok).toBe(true);
  expect(validateDependencyInstallInputs(observed.inputs)).toBe(true);
  const dependencyReceipt = await createDependencyReceipt({
    attemptId: 'receipt-attempt',
    bunVersion: '1.3.14',
    checkoutIdentity,
    dependencyFiles: view,
    installInputs: observed.inputs,
    state,
    wtDir: realpathSync(join(root, 'checkout')),
  });
  expect(dependencyReceipt.ok).toBe(true);
  const binding = {
    admissionOperationId: 'setup-lease-1',
    bunVersion: '1.3.14',
    installerSettled: true,
    installInputs: observed.inputs,
    operationId,
    planId: operationId,
    version: 1,
  };
  return {
    ...fixture,
    binding,
    dependencyReceipt: dependencyReceipt.receipt,
    operationId,
    view,
  };
}

test('setup enrollment uses the readiness install-input schema and digest', async () => {
  const { binding, checkoutIdentity, progress } = await enrollmentFixture();
  const base = {
    attemptId: 'receipt-attempt',
    checkoutIdentity,
    target,
  };
  const alteredInputs = {
    ...binding.installInputs,
    unexpected: true,
  };
  expect(validateDependencyInstallInputs(alteredInputs)).toBe(false);
  await expect(
    progress.bindEnrollment({
      ...base,
      dependencyEnrollment: {
        ...binding,
        installInputs: alteredInputs,
      },
    })
  ).resolves.toMatchObject({ code: 'SETUP_ENROLLMENT_INVALID', ok: false });
});

test('enrollment binding is immutable and operation IDs are monotonic', async () => {
  const { checkoutIdentity, progress, binding } = await enrollmentFixture();
  const base = {
    attemptId: 'receipt-attempt',
    checkoutIdentity,
    target,
  };
  await expect(
    progress.bindEnrollment({ ...base, dependencyEnrollment: binding })
  ).resolves.toMatchObject({ ok: true });
  await expect(
    progress.bindEnrollment({ ...base, dependencyEnrollment: binding })
  ).resolves.toMatchObject({ ok: true });
  await expect(
    progress.bindEnrollment({
      ...base,
      dependencyEnrollment: {
        ...binding,
        admissionOperationId: 'different-lease',
      },
    })
  ).resolves.toMatchObject({
    code: 'SETUP_ENROLLMENT_BINDING_CONFLICT',
    ok: false,
  });
  await expect(
    progress.bindEnrollment({
      ...base,
      dependencyEnrollment: {
        ...binding,
        operationId: 'e'.repeat(64),
        planId: 'e'.repeat(64),
      },
    })
  ).resolves.toMatchObject({
    code: 'SETUP_ENROLLMENT_BINDING_CONFLICT',
    ok: false,
  });
});

test('finishEnrollment reconciles unknown setup only from the journal and current completed view', async () => {
  const {
    checkoutIdentity,
    dependencyReceipt,
    operationId,
    progress,
    state,
    binding,
  } = await enrollmentFixture();
  const base = {
    attemptId: 'receipt-attempt',
    checkoutIdentity,
    target,
  };
  await progress.bindEnrollment({ ...base, dependencyEnrollment: binding });
  await expect(progress.recover()).resolves.toMatchObject({ recovered: 1 });
  const input = {
    ...base,
    dependencyReceipt,
    operationId,
  };
  await expect(progress.finishEnrollment(input)).resolves.toMatchObject({
    ok: true,
    record: { outcome: 'completed', state: 'completed' },
  });
  const saved = state.read('setupProgress').records['app/topic'];
  expect(saved.dependencyReceipt.receiptDigest).toBe(
    dependencyReceipt.receiptDigest
  );
  await expect(progress.finishEnrollment(input)).resolves.toMatchObject({
    ok: true,
    record: { outcome: 'completed', state: 'completed' },
  });
});

test('completed enrollment without a saved install observation remains unverified', async () => {
  const { binding, checkoutIdentity, progress, state, view, operationId } =
    await enrollmentFixture();
  const base = {
    attemptId: 'receipt-attempt',
    checkoutIdentity,
    target,
  };
  const { installInputs: _ignored, ...withoutInputs } = binding;
  await progress.bindEnrollment({
    ...base,
    dependencyEnrollment: {
      ...withoutInputs,
      operationId,
      planId: operationId,
    },
  });
  await progress.recover();
  await expect(
    progress.finishEnrollment({ ...base, operationId })
  ).resolves.toMatchObject({ ok: true, record: { state: 'completed' } });
  const saved = state.read('setupProgress').records['app/topic'];
  expect(saved.dependencyReceipt).toBeUndefined();
  expect(saved.dependencyEnrollment.installInputs).toBeUndefined();
  expect(state.read('dependencyFiles').views['app/topic']).toEqual(view);
});

test('finishEnrollment refuses wrong operation, lease binding, checkout, and stale current view', async () => {
  const {
    checkoutIdentity,
    dependencyReceipt,
    operationId,
    progress,
    state,
    binding,
  } = await enrollmentFixture();
  const base = {
    attemptId: 'receipt-attempt',
    checkoutIdentity,
    target,
  };
  await progress.bindEnrollment({ ...base, dependencyEnrollment: binding });
  const completion = {
    ...base,
    dependencyReceipt,
    operationId,
  };
  await expect(
    progress.finishEnrollment({ ...completion, operationId: 'f'.repeat(64) })
  ).resolves.toMatchObject({
    code: 'SETUP_ENROLLMENT_BINDING_REQUIRED',
    ok: false,
  });
  await expect(
    progress.finishEnrollment({
      ...completion,
      checkoutIdentity: { ...checkoutIdentity, checkoutPath: '/stale' },
    })
  ).resolves.toMatchObject({ code: 'CHECKOUT_IDENTITY_MISMATCH', ok: false });
  await state.update('dependencyFiles', (document) => ({
    ...document,
    views: {},
  }));
  await expect(progress.finishEnrollment(completion)).resolves.toMatchObject({
    code: 'SETUP_ENROLLMENT_NOT_COMPLETED',
    ok: false,
  });
});

test('enrollment completion refuses forged receipts and does not reopen unknown setup for retry', async () => {
  const {
    checkoutIdentity,
    dependencyReceipt,
    operationId,
    progress,
    binding,
  } = await enrollmentFixture();
  const base = {
    attemptId: 'receipt-attempt',
    checkoutIdentity,
    target,
  };
  await progress.bindEnrollment({ ...base, dependencyEnrollment: binding });
  await progress.recover();
  const altered = structuredClone(dependencyReceipt);
  altered.attemptId = 'foreign-attempt';
  await expect(
    progress.finishEnrollment({
      ...base,
      dependencyReceipt: altered,
      operationId,
    })
  ).resolves.toMatchObject({
    code: 'SETUP_DEPENDENCY_RECEIPT_INVALID',
    ok: false,
  });
  await expect(
    progress.retry({
      ...base,
      logLocation: 'logs/retry.log',
      stage: 'dependencies',
    })
  ).resolves.toMatchObject({
    code: 'DEPENDENCY_ENROLLMENT_RECONCILIATION_REQUIRED',
    ok: false,
  });
});

test('a lost enrollment binding cannot be synthesized after setup becomes unknown', async () => {
  const { checkoutIdentity, progress, binding, state } =
    await enrollmentFixture();
  const base = {
    attemptId: 'receipt-attempt',
    checkoutIdentity,
    target,
  };
  const lostWrite = createSetupProgress({
    state: {
      read: (name) => state.read(name),
      update: (name) =>
        name === 'setupProgress'
          ? Promise.resolve({
              committed: false,
              reconciled: false,
              status: 'not-committed',
            })
          : state.update(name, (document) => document),
    },
  });
  await expect(
    lostWrite.bindEnrollment({ ...base, dependencyEnrollment: binding })
  ).resolves.toMatchObject({
    code: 'SETUP_PROGRESS_OUTCOME_UNKNOWN',
    ok: false,
  });
  expect(progress.get(target).dependencyEnrollment).toBeUndefined();
  await progress.recover();
  await expect(
    progress.bindEnrollment({ ...base, dependencyEnrollment: binding })
  ).resolves.toMatchObject({ code: 'SETUP_NOT_RUNNING', ok: false });
  await expect(
    progress.finishEnrollment({ ...base, operationId: binding.operationId })
  ).resolves.toMatchObject({
    code: 'SETUP_ENROLLMENT_BINDING_REQUIRED',
    ok: false,
  });
});

test('unknown enrollment can fill paired IDs only from its immutable saved base', async () => {
  const { checkoutIdentity, progress, binding, state } =
    await enrollmentFixture();
  const base = {
    attemptId: 'receipt-attempt',
    checkoutIdentity,
    target,
  };
  const {
    operationId: _operationId,
    planId: _planId,
    ...originalBase
  } = binding;
  await progress.bindEnrollment({
    ...base,
    dependencyEnrollment: originalBase,
  });
  await progress.recover();

  await expect(
    progress.bindEnrollment({ ...base, dependencyEnrollment: binding })
  ).resolves.toMatchObject({
    ok: true,
    record: {
      dependencyEnrollment: {
        operationId: binding.operationId,
        planId: binding.planId,
      },
      state: 'unknown',
    },
  });
  expect(
    state.read('setupProgress').records['app/topic'].dependencyEnrollment
  ).toEqual(binding);
  await expect(
    progress.bindEnrollment({ ...base, dependencyEnrollment: binding })
  ).resolves.toMatchObject({ ok: true, record: { state: 'unknown' } });
  await expect(
    progress.bindEnrollment({
      ...base,
      dependencyEnrollment: {
        ...binding,
        operationId: 'e'.repeat(64),
        planId: 'e'.repeat(64),
      },
    })
  ).resolves.toMatchObject({
    code: 'SETUP_ENROLLMENT_BINDING_CONFLICT',
    ok: false,
  });
});

test('unknown enrollment ID continuation rejects a changed base or wrong stage', async () => {
  const { checkoutIdentity, progress, binding } = await enrollmentFixture();
  const base = {
    attemptId: 'receipt-attempt',
    checkoutIdentity,
    target,
  };
  const {
    operationId: _operationId,
    planId: _planId,
    ...originalBase
  } = binding;
  await progress.bindEnrollment({
    ...base,
    dependencyEnrollment: originalBase,
  });
  await progress.recover();
  await expect(
    progress.bindEnrollment({
      ...base,
      dependencyEnrollment: {
        ...binding,
        admissionOperationId: 'different-lease',
      },
    })
  ).resolves.toMatchObject({
    code: 'SETUP_ENROLLMENT_BINDING_CONFLICT',
    ok: false,
  });

  const wrongStage = await enrollmentFixture();
  const wrongBase = {
    attemptId: 'receipt-attempt',
    checkoutIdentity: wrongStage.checkoutIdentity,
    target,
  };
  await wrongStage.progress.bindEnrollment({
    ...wrongBase,
    dependencyEnrollment: originalBase,
  });
  await wrongStage.progress.stage({
    ...wrongBase,
    stage: 'ready-check',
  });
  await wrongStage.progress.recover();
  await expect(
    wrongStage.progress.bindEnrollment({
      ...wrongBase,
      dependencyEnrollment: wrongStage.binding,
    })
  ).resolves.toMatchObject({ code: 'SETUP_NOT_RUNNING', ok: false });
});

test('paired-ID binding survives a lost response and retries idempotently', async () => {
  const { checkoutIdentity, progress, binding, state } =
    await enrollmentFixture();
  const base = {
    attemptId: 'receipt-attempt',
    checkoutIdentity,
    target,
  };
  const {
    operationId: _operationId,
    planId: _planId,
    ...originalBase
  } = binding;
  await progress.bindEnrollment({
    ...base,
    dependencyEnrollment: originalBase,
  });
  await progress.recover();
  const lostResponse = createSetupProgress({
    state: {
      read: (name) => state.read(name),
      update: async (name, update) => {
        await state.update(name, update);
        return name === 'setupProgress'
          ? {
              committed: false,
              reconciled: false,
              status: 'unknown',
            }
          : state.update(name, (document) => document);
      },
    },
  });
  await expect(
    lostResponse.bindEnrollment({ ...base, dependencyEnrollment: binding })
  ).resolves.toMatchObject({
    code: 'SETUP_PROGRESS_OUTCOME_UNKNOWN',
    ok: false,
  });
  expect(progress.get(target).dependencyEnrollment).toEqual(binding);
  await expect(
    progress.bindEnrollment({ ...base, dependencyEnrollment: binding })
  ).resolves.toMatchObject({ ok: true, record: { state: 'unknown' } });
});

test('the setup owner atomically completes its exact attempt with a dependency receipt', async () => {
  const { checkoutIdentity, progress, receipt, state } =
    await dependencyProgressFixture();
  const result = await progress.finish({
    attemptId: 'receipt-attempt',
    checkoutIdentity,
    dependencyReceipt: receipt,
    outcome: 'completed',
    target,
  });
  expect(result.ok).toBe(true);
  const saved = state.read('setupProgress').records['app/topic'];
  expect(saved.state).toBe('completed');
  expect(saved.dependencyReceipt.receiptDigest).toBe(receipt.receiptDigest);
  const read = progress.get(target);
  read.dependencyReceipt.inputs.files[0].present =
    !read.dependencyReceipt.inputs.files[0].present;
  expect(progress.get(target).dependencyReceipt.receiptDigest).toBe(
    receipt.receiptDigest
  );
  expect(progress.get(target).dependencyReceipt.inputs.files).toEqual(
    receipt.inputs.files
  );
});

test('setup progress stores a hoisted enrollment receipt without isolated consumer context', async () => {
  const { checkoutIdentity, progress, root, state } =
    await dependencyProgressFixture();
  const view = {
    checkoutIdentity,
    completedFiles: 0,
    createdAt: 1,
    id: 'c'.repeat(64),
    inputDigest: 'd'.repeat(64),
    logicalCloneBytes: 0,
    mode: 'hoisted-cow',
    name: 'topic',
    physicalSavingsBytes: null,
    planId: 'c'.repeat(64),
    repo: 'app',
    retainedOriginalFiles: 0,
    state: 'completed',
    storeIdentity: {
      device: String(lstatSync(root, { bigint: true }).dev),
      executable: join(root, 'bun'),
      mountPath: root,
      namespace: 'hoisted/darwin-arm64-bun-1.3.14',
      root: join(root, 'store'),
      version: '1.3.14',
    },
    totalFiles: 0,
    updatedAt: 1,
    version: 1,
  };
  writeFileSync(
    join(root, 'checkout', 'bunfig.toml'),
    '[install]\nlinker = "hoisted"\n'
  );
  await state.update('dependencyFiles', () => ({
    operations: { [view.id]: view },
    version: 1,
    views: { 'app/topic': view },
  }));
  const built = await createDependencyReceipt({
    attemptId: 'receipt-attempt',
    checkoutIdentity,
    dependencyFiles: view,
    state,
    wtDir: realpathSync(join(root, 'checkout')),
  });
  expect(built.ok).toBe(true);
  expect(built.receipt.inputs.linkerMode).toBe('hoisted');
  expect(built.receipt.inputs.installMode).toBe('none');
  expect(built.receipt.inputs.sharedConsumerDigest).toBeNull();
  await expect(
    progress.finish({
      attemptId: 'receipt-attempt',
      checkoutIdentity,
      dependencyReceipt: built.receipt,
      outcome: 'completed',
      target,
    })
  ).resolves.toMatchObject({ ok: true });
  expect(
    state.read('setupProgress').records['app/topic'].dependencyReceipt
  ).toEqual(built.receipt);
});

test('failed, altered, or foreign-attempt receipts cannot certify setup', async () => {
  const { checkoutIdentity, progress, receipt } =
    await dependencyProgressFixture();
  const input = {
    attemptId: 'receipt-attempt',
    checkoutIdentity,
    dependencyReceipt: receipt,
    outcome: 'completed',
    target,
  };
  expect((await progress.finish({ ...input, outcome: 'failed' })).ok).toBe(
    false
  );
  const altered = structuredClone(receipt);
  altered.attemptId = 'foreign-attempt';
  expect(
    (await progress.finish({ ...input, dependencyReceipt: altered })).ok
  ).toBe(false);
  expect(progress.get(target).state).toBe('running');
  expect(Object.hasOwn(progress.get(target), 'dependencyReceipt')).toBe(false);
});

test('a caller cannot change receipt evidence while the journal waits for its write lock', async () => {
  const { checkoutIdentity, progress, receipt } =
    await dependencyProgressFixture();
  const mutable = structuredClone(receipt);
  const finished = progress.finish({
    attemptId: 'receipt-attempt',
    checkoutIdentity,
    dependencyReceipt: mutable,
    outcome: 'completed',
    target,
  });
  mutable.inputDigest = 'f'.repeat(64);
  expect((await finished).ok).toBe(true);
  expect(progress.get(target).dependencyReceipt.inputDigest).toBe(
    receipt.inputDigest
  );
});

test('completed setup refresh requires the explicit flag and preserves default retry refusal', async () => {
  const { checkoutIdentity, progress, receipt, root } =
    await dependencyProgressFixture();
  await progress.finish({
    attemptId: 'receipt-attempt',
    checkoutIdentity,
    dependencyReceipt: receipt,
    outcome: 'completed',
    target,
  });
  const documentPath = join(root, '.setu-setup-progress.json');
  const before = readFileSync(documentPath, 'utf8');

  await expect(
    progress.retry({
      attemptId: 'receipt-attempt',
      checkoutIdentity,
      logLocation: 'logs/refresh.log',
      stage: 'dependencies',
      target,
    })
  ).resolves.toMatchObject({ code: 'SETUP_RETRY_UNAVAILABLE', ok: false });
  await expect(
    progress.retry({
      attemptId: 'receipt-attempt',
      checkoutIdentity,
      logLocation: 'logs/refresh.log',
      refreshDependencies: false,
      stage: 'dependencies',
      target,
    })
  ).resolves.toMatchObject({ code: 'SETUP_RETRY_UNAVAILABLE', ok: false });
  expect(readFileSync(documentPath, 'utf8')).toBe(before);
  expect(progress.get(target).dependencyReceipt.receiptDigest).toBe(
    receipt.receiptDigest
  );
});

test('dependency refresh validates its opt-in and exact current attempt and checkout before writing', async () => {
  const { checkoutIdentity, progress, receipt, root, state } =
    await dependencyProgressFixture();
  await progress.finish({
    attemptId: 'receipt-attempt',
    checkoutIdentity,
    dependencyReceipt: receipt,
    outcome: 'completed',
    target,
  });
  const documentPath = join(root, '.setu-setup-progress.json');
  const before = readFileSync(documentPath, 'utf8');
  const base = {
    attemptId: 'receipt-attempt',
    checkoutIdentity,
    logLocation: 'logs/refresh.log',
    stage: 'dependencies',
    target,
  };

  for (const refreshDependencies of [null, 1, 'true']) {
    // biome-ignore lint/performance/noAwaitInLoops: Each refusal is checked before the next attempt against the same journal.
    await expect(
      progress.retry({ ...base, refreshDependencies })
    ).resolves.toMatchObject({ code: 'SETUP_PROGRESS_INVALID', ok: false });
  }
  await expect(
    progress.retry({
      ...base,
      attemptId: 'forged-attempt',
      refreshDependencies: true,
    })
  ).resolves.toMatchObject({ code: 'SETUP_ATTEMPT_MISMATCH', ok: false });
  await expect(
    progress.retry({
      ...base,
      checkoutIdentity: { ...checkoutIdentity, checkoutPath: '/stale' },
      refreshDependencies: true,
    })
  ).resolves.toMatchObject({ code: 'CHECKOUT_IDENTITY_MISMATCH', ok: false });
  expect(readFileSync(documentPath, 'utf8')).toBe(before);
  expect(state.read('setupProgress').records['app/topic'].attemptId).toBe(
    'receipt-attempt'
  );
});

test('dependency refresh clears prior completion data and accepts only a new attempt receipt', async () => {
  let time = 200;
  const { checkoutIdentity, progress, receipt, root, state } =
    await dependencyProgressFixture();
  await progress.finish({
    attemptId: 'receipt-attempt',
    checkoutIdentity,
    dependencyReceipt: receipt,
    outcome: 'completed',
    target,
  });
  const refreshed = createSetupProgress({
    newAttemptId: () => 'refreshed-attempt',
    now: () => {
      const at = time;
      time += 1;
      return at;
    },
    state,
  });

  await expect(
    refreshed.retry({
      attemptId: 'receipt-attempt',
      checkoutIdentity,
      logLocation: 'logs/refreshed.log',
      refreshDependencies: true,
      stage: 'dependencies',
      target,
    })
  ).resolves.toMatchObject({
    ok: true,
    record: {
      attemptId: 'refreshed-attempt',
      outcome: null,
      stage: 'dependencies',
      state: 'running',
    },
  });
  const running = refreshed.get(target);
  expect(running.logLocation).toBe('logs/refreshed.log');
  expect(Object.hasOwn(running, 'finishedAt')).toBe(false);
  expect(Object.hasOwn(running, 'dependencyReceipt')).toBe(false);

  const next = await createDependencyReceipt({
    attemptId: 'refreshed-attempt',
    checkoutIdentity,
    wtDir: realpathSync(join(root, 'checkout')),
  });
  expect(next.ok).toBe(true);
  await expect(
    refreshed.finish({
      attemptId: 'refreshed-attempt',
      checkoutIdentity,
      dependencyReceipt: next.receipt,
      outcome: 'completed',
      target,
    })
  ).resolves.toMatchObject({ ok: true });
  expect(refreshed.get(target)).toMatchObject({
    attemptId: 'refreshed-attempt',
    dependencyReceipt: { attemptId: 'refreshed-attempt' },
    finishedAt: expect.any(Number),
    state: 'completed',
  });
});

test('dependency refresh cannot retry a running attempt', async () => {
  const { checkoutIdentity, progress, root, state } =
    await dependencyProgressFixture();
  const documentPath = join(root, '.setu-setup-progress.json');
  const before = readFileSync(documentPath, 'utf8');
  await expect(
    progress.retry({
      attemptId: 'receipt-attempt',
      checkoutIdentity,
      logLocation: 'logs/refresh.log',
      refreshDependencies: true,
      stage: 'dependencies',
      target,
    })
  ).resolves.toMatchObject({ code: 'SETUP_RETRY_UNAVAILABLE', ok: false });
  expect(readFileSync(documentPath, 'utf8')).toBe(before);
  expect(state.read('setupProgress').records['app/topic'].state).toBe(
    'running'
  );
});

test('a refresh cannot reuse the completed attempt ID', async () => {
  const { checkoutIdentity, progress, receipt, state, root } =
    await dependencyProgressFixture();
  expect(
    (
      await progress.finish({
        attemptId: 'receipt-attempt',
        checkoutIdentity,
        dependencyReceipt: receipt,
        outcome: 'completed',
        target,
      })
    ).ok
  ).toBe(true);
  const before = readFileSync(join(root, '.setu-setup-progress.json'), 'utf8');
  const reused = createSetupProgress({
    newAttemptId: () => 'receipt-attempt',
    state,
  });
  expect(
    await reused.retry({
      attemptId: 'receipt-attempt',
      checkoutIdentity,
      logLocation: 'refresh.log',
      refreshDependencies: true,
      stage: 'preparing',
      target,
    })
  ).toMatchObject({ code: 'SETUP_ATTEMPT_ID_INVALID', ok: false });
  expect(readFileSync(join(root, '.setu-setup-progress.json'), 'utf8')).toBe(
    before
  );
});

test('setup retry preserves enrollment-only recovery instead of replacing the install attempt', async () => {
  await Promise.all(
    [
      'dependency-enrollment',
      `dependency-enrollment-unknown:${'a'.repeat(64)}`,
    ].map(async (stage) => {
      const { state } = stateFixture();
      let attempts = 0;
      const progress = createSetupProgress({
        newAttemptId: () => {
          attempts += 1;
          return `attempt-${attempts}`;
        },
        state,
      });
      const input = {
        checkoutIdentity: 'checkout-a',
        logLocation: 'logs/setup.log',
        stage,
        target,
      };
      await progress.start(input);
      await progress.recover();
      const before = progress.get(target);
      const result = await progress.retry({
        ...input,
        attemptId: 'attempt-1',
        stage: 'preparing',
      });
      expect(result).toMatchObject({
        code: 'DEPENDENCY_ENROLLMENT_RECONCILIATION_REQUIRED',
        ok: false,
        recovery: { dependencySharing: { setupId: 'attempt-1' } },
      });
      expect(result.recovery.dependencySharing.operationId).toBe(
        stage.includes(':') ? 'a'.repeat(64) : undefined
      );
      expect(progress.get(target)).toEqual(before);
      expect(attempts).toBe(1);
    })
  );
});
