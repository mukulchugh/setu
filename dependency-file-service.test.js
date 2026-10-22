import { afterEach, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import {
  chmod,
  copyFile,
  mkdir,
  open,
  readFile as readFileAsync,
  realpath,
  rename,
  stat,
  unlink,
  utimes,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inspectCheckoutIdentity } from './checkout-identity.js';
import { createDependencyFileJournal } from './dependency-file-journal.js';
import { createDependencyFileService } from './dependency-file-service.js';
import { createDependencyFileSharing } from './dependency-file-sharing.js';
import { openDependencyFileStore } from './dependency-file-store.js';
import { createPortalResourceServices } from './portal-resource-services.js';
import { createResourceAdmission } from './resource-admission.js';
import { createSetupProgress } from './setup-progress.js';
import {
  beginSetupAttempt,
  installWorktreeDependencies,
} from './workspace-setup.js';
import { createWorkspaceState } from './workspace-state.js';

const PINNED_BUN = process.env.SETU_TEST_DEPENDENCY_BUN ?? process.execPath;
const DIGEST_PATTERN = /^[a-f0-9]{64}$/;

const digest = 'a'.repeat(64);
const mutableGuardPattern = /mutable-target guard/;
const temporaryRoots = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { force: true, recursive: true });
  }
});

function fixture({
  engineOverrides = {},
  guard,
  admission,
  kernelLease,
  setupProgress,
  targetOverrides = {},
  withTargets,
} = {}) {
  const calls = [];
  const guards = [];
  let engineCreations = 0;
  const target = {
    checkoutIdentity: {
      checkoutPath: '/workspace/r/topic',
      known: true,
      worktreeId: 'worktree-1',
    },
    key: 'r/topic',
    name: 'topic',
    port: 3101,
    repo: 'r',
    repoDir: '/workspace/r.git',
    wtDir: '/workspace/r/topic',
    ...targetOverrides,
  };
  const engine = {
    apply: async (value, input) => ({
      ok: true,
      operationId: input.operationId,
      target: value.key,
    }),
    enrollFresh: async (value) => ({
      ok: true,
      state: 'completed',
      target: value.key,
    }),
    prepare: async (value) => ({
      ok: true,
      plan: { id: digest },
      target: value.key,
    }),
    prepareRelease: async (value, input) => ({
      ok: true,
      operationId: input.operationId,
      releaseId: 'b'.repeat(64),
      target: value.key,
    }),
    recover: async (value, input) => ({
      ok: true,
      operationId: input.operationId,
      target: value.key,
    }),
    release: async (value, input) => ({
      ok: true,
      releaseId: input.releaseId,
      target: value.key,
    }),
    status: async (value) => ({
      enabled: true,
      ok: true,
      state: 'ordinary',
      target: value.key,
    }),
    ...engineOverrides,
  };
  const service = createDependencyFileService({
    assertMutable: (value, details) => {
      guards.push({ key: value.key, ...details });
      return guard?.(value, details);
    },
    config: async () => ({
      dependencySharing: {
        enabled: true,
        executable: '/opt/setu/bin/bun',
        storeRoot: '/private/setu/dependencies',
        targets: { 'r/topic': true },
        version: '1.3.14',
      },
      workspace: '/workspace',
    }),
    engineFactory: (input) => {
      engineCreations += 1;
      calls.push({ input, kind: 'create' });
      return engine;
    },
    ...(admission ? { admission } : {}),
    ...(kernelLease ? { kernelLease } : {}),
    randomId: () => digest,
    resolveTarget: () => ({ ...target }),
    ...(setupProgress ? { setupProgress } : {}),
    state: {
      withTargets: (targets, work) => {
        calls.push({ key: targets[0].key, kind: 'lock' });
        return withTargets ? withTargets(targets, work) : work();
      },
    },
  });
  return {
    calls,
    engineCreations: () => engineCreations,
    guards,
    service,
    target,
  };
}

const hash = (value) => createHash('sha256').update(value).digest('hex');

// OS seam: exercises the production factories and journal protocol while
// replacing the unavailable native helper's clone/exchange/lease operations.
function dependencyFileOsSeam() {
  async function fingerprint(root, relativePath) {
    const path = join(root, ...relativePath.split('/'));
    const info = await stat(path, { bigint: true });
    const contentHash = hash(readFileSync(path));
    const mode = Number(info.mode);
    const uid = Number(info.uid);
    const gid = Number(info.gid);
    const mtimeNs = String(info.mtimeNs);
    const ctimeNs = String(info.ctimeNs);
    const atimeNs = String(info.atimeNs);
    const attributes = [];
    const metadataHash = hash(
      JSON.stringify([mode, uid, gid, mtimeNs, attributes])
    );
    const identityHash = hash(
      JSON.stringify([
        String(info.dev),
        String(info.ino),
        Number(info.size),
        mtimeNs,
        ctimeNs,
        contentHash,
        metadataHash,
      ])
    );
    return {
      atimeNs,
      attributes,
      contentHash,
      ctimeNs,
      device: String(info.dev),
      gid,
      identityHash,
      inode: String(info.ino),
      metadataHash,
      mode,
      mtimeNs,
      relativePath,
      size: Number(info.size),
      uid,
    };
  }

  const sameDependencyFile = (left, right, { identity = false } = {}) =>
    left.contentHash === right.contentHash &&
    left.metadataHash === right.metadataHash &&
    (!identity ||
      (left.device === right.device &&
        left.inode === right.inode &&
        left.identityHash === right.identityHash));

  return {
    async cloneDependencyFile(
      sourceRoot,
      sourcePath,
      destinationRoot,
      destinationPath
    ) {
      const source = join(sourceRoot, ...sourcePath.split('/'));
      const destination = join(destinationRoot, ...destinationPath.split('/'));
      await mkdir(join(destination, '..'), { recursive: true });
      await copyFile(source, destination, 1);
      const info = await stat(source);
      await chmod(destination, info.mode % 0o1_0000);
      await utimes(destination, info.atime, info.mtime);
      return fingerprint(destinationRoot, destinationPath);
    },
    dependencyFileNativeStatus() {
      return { available: true };
    },
    async exchangeDependencyFiles(root, targetPath, temporaryPath) {
      const target = join(root, ...targetPath.split('/'));
      const temporary = join(root, ...temporaryPath.split('/'));
      const displaced = `${temporary}.os-seam`;
      await rename(temporary, displaced);
      await rename(target, temporary);
      await rename(displaced, target);
      return { exchanged: true };
    },
    async readDependencyFile(root, relativePath) {
      try {
        return {
          eligible: true,
          fingerprint: await fingerprint(root, relativePath),
        };
      } catch {
        return { eligible: false, reason: 'missing-file' };
      }
    },
    async removeDependencyBackup(root, relativePath, expected) {
      const current = await fingerprint(root, relativePath);
      if (!sameDependencyFile(current, expected, { identity: true })) {
        throw Object.assign(new Error('backup identity changed'), {
          code: 'BACKUP_CHANGED',
        });
      }
      await unlink(join(root, ...relativePath.split('/')));
      return { removed: true };
    },
    async restoreDependencyTimes(root, relativePath, { atimeNs, mtimeNs }) {
      const path = join(root, ...relativePath.split('/'));
      await utimes(
        path,
        Number(BigInt(atimeNs)) / 1e9,
        Number(BigInt(mtimeNs)) / 1e9
      );
      return { atimeNs, mtimeNs, restored: true };
    },
    sameDependencyFile,
    async syncDependencyDirectory(path) {
      // G4 currently supplies both paths and directories here; sync the parent
      // when the supplied path is a file, while keeping the seam explicit.
      const candidate = await stat(path).then((info) =>
        info.isDirectory() ? path : join(path, '..')
      );
      const handle = await open(candidate, 'r');
      await handle.sync();
      await handle.close();
    },
    async withDependencyFileLease(_storeRoot, _checkoutPath, work) {
      return await work();
    },
  };
}

// This injected engine verifies G6 orchestration only; it is not native clone evidence.
test('dependency file service composes one injected G4 engine and preserves reviewed identities', async () => {
  const fx = fixture();
  const { target } = fx;

  await expect(fx.service.prepare(target)).resolves.toMatchObject({
    ok: true,
    plan: { id: digest },
  });
  await expect(
    fx.service.apply(target, { confirmation: digest, planId: digest })
  ).resolves.toMatchObject({
    ok: true,
    operationId: digest,
  });
  await expect(
    fx.service.recover(target, { operationId: digest })
  ).resolves.toMatchObject({
    ok: true,
    operationId: digest,
  });
  await expect(
    fx.service.prepareRelease(target, { operationId: digest })
  ).resolves.toMatchObject({
    ok: true,
    operationId: digest,
    releaseId: 'b'.repeat(64),
  });
  await expect(
    fx.service.release(target, {
      confirmation: 'b'.repeat(64),
      releaseId: 'b'.repeat(64),
    })
  ).resolves.toMatchObject({ ok: true, releaseId: 'b'.repeat(64) });
  await expect(fx.service.status(target)).resolves.toMatchObject({
    enabled: true,
    ok: true,
    state: 'ordinary',
  });

  expect(fx.engineCreations()).toBe(1);
  expect(fx.guards).toHaveLength(5);
  expect(fx.calls.filter((call) => call.kind === 'lock')).toHaveLength(5);
  expect(fx.calls.find((call) => call.kind === 'create').input).toMatchObject({
    sharing: {
      enabled: true,
      storeRoot: '/private/setu/dependencies',
      version: '1.3.14',
    },
  });
});

test('release keeps release review identity separate when the owning operation is unknown', async () => {
  const releaseId = 'b'.repeat(64);
  const fx = fixture({
    engineOverrides: {
      release: () =>
        Promise.reject(
          new Error('engine response was lost before operation lookup')
        ),
    },
  });
  const result = await fx.service.release(fx.target, {
    confirmation: releaseId,
    releaseId,
  });

  expect(result).toMatchObject({
    code: 'DEPENDENCY_FILE_OUTCOME_UNKNOWN',
    ok: false,
    releaseId,
  });
  expect(result).not.toHaveProperty('operationId');
  expect(fx.guards.at(-1)).not.toHaveProperty('operationId');
});

test('release preserves the known owning operation through a lost service response', async () => {
  const releaseId = 'b'.repeat(64);
  const operationId = 'c'.repeat(64);
  const fx = fixture({
    engineOverrides: {
      release: async () => ({ ok: true, operationId, releaseId }),
    },
    withTargets: async (_targets, work) => {
      await work();
      throw new Error('caller response was lost');
    },
  });
  const result = await fx.service.release(fx.target, {
    confirmation: releaseId,
    releaseId,
  });

  expect(result).toMatchObject({
    code: 'DEPENDENCY_FILE_OUTCOME_UNKNOWN',
    ok: false,
    operationId,
    releaseId,
  });
  expect(result.operationId).not.toBe(releaseId);
});

test('dependency file service rejects unknown fields, path input and mismatched confirmation at the boundary', async () => {
  let resolved = 0;
  const fx = fixture();
  const service = createDependencyFileService({
    assertMutable: () => null,
    config: async () => ({
      dependencySharing: {
        enabled: true,
        executable: '/opt/setu/bin/bun',
        storeRoot: '/private/setu/dependencies',
        targets: { 'r/topic': true },
        version: '1.3.14',
      },
      workspace: '/workspace',
    }),
    engineFactory: () => {
      throw new Error('must not construct the engine');
    },
    resolveTarget: (..._args) => {
      resolved += 1;
      return fx.target;
    },
    state: { withTargets: (_targets, work) => work() },
  });

  await expect(
    service.prepare(fx.target, { checkoutPath: '/tmp/other' })
  ).resolves.toMatchObject({
    code: 'DEPENDENCY_FILE_INPUT_INVALID',
    ok: false,
  });
  await expect(
    service.prepare(fx.target, { path: '/tmp/other' })
  ).resolves.toMatchObject({
    code: 'DEPENDENCY_FILE_INPUT_INVALID',
    ok: false,
  });
  await expect(
    service.apply(fx.target, { confirmation: 'b'.repeat(64), planId: digest })
  ).resolves.toMatchObject({
    code: 'DEPENDENCY_FILE_INPUT_INVALID',
    ok: false,
  });
  await expect(
    service.apply(fx.target, {
      confirmation: digest,
      operationId: 'b'.repeat(64),
      planId: digest,
    })
  ).resolves.toMatchObject({
    code: 'DEPENDENCY_FILE_INPUT_INVALID',
    ok: false,
  });
  expect(resolved).toBe(0);
});

test('dependency file service refuses stale checkout identity before lock or engine execution', async () => {
  const fx = fixture();
  const service = createDependencyFileService({
    assertMutable: () => null,
    config: async () => ({
      dependencySharing: {
        enabled: true,
        executable: '/opt/setu/bin/bun',
        storeRoot: '/private/setu/dependencies',
        targets: { 'r/topic': true },
        version: '1.3.14',
      },
      workspace: '/workspace',
    }),
    engineFactory: () => {
      throw new Error('must not construct the engine');
    },
    resolveTarget: () => ({
      ...fx.target,
      checkoutIdentity: {
        ...fx.target.checkoutIdentity,
        worktreeId: 'replacement',
      },
    }),
    state: {
      withTargets: () => {
        throw new Error('must not take the target lock');
      },
    },
  });

  await expect(service.prepare(fx.target)).resolves.toMatchObject({
    code: 'CHECKOUT_IDENTITY_CHANGED',
    ok: false,
  });
});

test('dependency file service requires a mutable-target guard and preserves unknown outcomes', async () => {
  expect(() =>
    createDependencyFileService({
      config: async () => ({}),
      resolveTarget: async () => null,
      state: { withTargets: (_targets, work) => work() },
    })
  ).toThrow(mutableGuardPattern);

  const fx = fixture({
    engineOverrides: {
      apply: () => {
        throw new Error('simulated lost result');
      },
    },
  });
  await expect(
    fx.service.apply(fx.target, { confirmation: digest, planId: digest })
  ).resolves.toMatchObject({
    code: 'DEPENDENCY_FILE_OUTCOME_UNKNOWN',
    ok: false,
    operationId: digest,
  });
});

test('fresh enrollment refuses before the engine when durable setup binding is unavailable', async () => {
  const seen = [];
  const target = { name: 'topic', repo: 'r' };
  const setupContext = {
    admissionOperationId: 'setup-install-operation-1',
    attemptId: 'setup-attempt-1',
    checkoutIdentity: {
      checkoutPath: '/workspace/r/topic',
      known: true,
      worktreeId: 'worktree-1',
    },
    installerSettled: true,
    target,
  };
  const fx = fixture({
    guard: async (_target, details) => seen.push(details),
  });

  await expect(
    fx.service.enrollFresh(target, setupContext)
  ).resolves.toMatchObject({
    code: 'DEPENDENCY_FILE_SETUP_BINDING_UNAVAILABLE',
    ok: false,
  });
  expect(seen).toEqual([
    {
      operationId: setupContext.admissionOperationId,
      phase: 'enroll-fresh',
      setupContext,
    },
  ]);
  expect(fx.guards).toHaveLength(1);
  expect(fx.calls.filter((call) => call.kind === 'lock')).toHaveLength(1);
  await expect(
    fx.service.enrollFresh(target, { ...setupContext, installerSettled: false })
  ).resolves.toMatchObject({
    code: 'DEPENDENCY_FILE_SETUP_CONTEXT_INVALID',
    ok: false,
  });
  await expect(
    fx.service.enrollFresh({ ...target, wtDir: '/untrusted' }, setupContext)
  ).resolves.toMatchObject({
    code: 'DEPENDENCY_FILE_SETUP_CONTEXT_INVALID',
    ok: false,
  });
});

test('real setup and admission factories refuse unknown enrollment without its durable operation binding', async () => {
  const root = mkdtempSync(join(tmpdir(), 'setu-dependency-recovery-'));
  temporaryRoots.push(root);
  const state = createWorkspaceState({
    configPath: join(root, 'config.json'),
    setuDir: root,
    workspaceRoot: root,
  });
  const setupProgress = createSetupProgress({
    newAttemptId: () => 'setup-attempt-recovery',
    now: () => 10,
    state,
  });
  const admission = createResourceAdmission({
    hostHealth: async () => ({ availableBytes: 1024 ** 3, state: 'ready' }),
    now: () => 11,
    state,
  });
  // Explicit OS seam: a missing durable binding must refuse before kernel locking.
  const fx = fixture({
    admission,
    kernelLease: (_storeRoot, _checkoutPath, work) => {
      throw new Error(`recovery must not acquire a kernel lease: ${work}`);
    },
    setupProgress,
  });
  await setupProgress.start({
    checkoutIdentity: fx.target.checkoutIdentity,
    logLocation: '/private/tmp/setup.log',
    stage: 'dependency-enrollment',
    target: { name: fx.target.name, repo: fx.target.repo },
  });
  await setupProgress.finish({
    attemptId: 'setup-attempt-recovery',
    checkoutIdentity: fx.target.checkoutIdentity,
    outcome: 'unknown',
    target: { name: fx.target.name, repo: fx.target.repo },
  });

  await expect(
    fx.service.recover(fx.target, { operationId: digest })
  ).resolves.toMatchObject({
    code: 'DEPENDENCY_FILE_SETUP_BINDING_REQUIRED',
    ok: false,
    operationId: digest,
  });
});

test('setup planning continuation refuses missing bindings and routes bound IDs to reconciliation', async () => {
  const attemptId = 'setup-attempt-planning';
  const record = {
    attemptId,
    checkoutIdentity: {
      checkoutPath: '/workspace/r/topic',
      known: true,
      worktreeId: 'worktree-1',
    },
    dependencyEnrollment: {
      admissionOperationId: 'install-admission',
      bunVersion: '1.3.14',
      installerSettled: true,
      version: 1,
    },
    outcome: 'unknown',
    stage: 'dependency-enrollment-unknown',
    state: 'unknown',
    target: { name: 'topic', repo: 'r' },
  };
  const fx = fixture({
    admission: {
      recoverLease: () => {
        throw new Error('planning refusal must precede admission recovery');
      },
    },
    setupProgress: {
      get: () => record,
    },
  });

  await expect(
    fx.service.resumeSetupEnrollment(fx.target, {
      attemptId,
      checkoutIdentity: { ...record.checkoutIdentity, worktreeId: 'replaced' },
    })
  ).resolves.toMatchObject({
    code: 'CHECKOUT_IDENTITY_MISMATCH',
    ok: false,
  });

  record.dependencyEnrollment = undefined;
  await expect(
    fx.service.resumeSetupEnrollment(fx.target, {
      attemptId,
      checkoutIdentity: record.checkoutIdentity,
    })
  ).resolves.toMatchObject({
    code: 'DEPENDENCY_FILE_SETUP_BINDING_REQUIRED',
    ok: false,
  });

  record.dependencyEnrollment = {
    admissionOperationId: 'install-admission',
    bunVersion: '1.3.14',
    installerSettled: true,
    version: 1,
  };
  record.dependencyEnrollment.operationId = digest;
  record.dependencyEnrollment.planId = digest;
  await expect(
    fx.service.resumeSetupEnrollment(fx.target, {
      attemptId,
      checkoutIdentity: record.checkoutIdentity,
    })
  ).resolves.toMatchObject({
    code: 'DEPENDENCY_ENROLLMENT_RECONCILIATION_REQUIRED',
    ok: false,
    operationId: digest,
    planId: digest,
  });
});

test.each(['exchange', 'planning'])(
  'real resource/store/setup recovery preserves one installer run after %s interruption',
  async (phase) => {
    const root = realpathSync(
      mkdtempSync(join(tmpdir(), 'setu-dependency-service-recovery-'))
    );
    temporaryRoots.push(root);
    const workspace = join(root, 'workspace');
    const project = join(workspace, 'r');
    const checkout = join(project, 'topic');
    const seed = join(root, 'seed');
    const repoDir = join(root, 'r.git');
    const storeRoot = join(root, 'store');
    mkdirSync(project, { recursive: true });
    mkdirSync(storeRoot, { mode: 0o700 });
    chmodSync(storeRoot, 0o700);
    execFileSync('git', ['init', '--quiet', '--initial-branch=main', seed]);
    writeFileSync(join(seed, 'README.md'), 'fixture\n');
    execFileSync('git', ['-C', seed, 'add', 'README.md']);
    execFileSync('git', [
      '-C',
      seed,
      '-c',
      'user.name=Setu fixture',
      '-c',
      'user.email=setu-fixture@invalid',
      'commit',
      '--quiet',
      '-m',
      'fixture',
    ]);
    execFileSync('git', ['clone', '--quiet', '--bare', seed, repoDir]);
    execFileSync('git', [
      '--git-dir',
      repoDir,
      'worktree',
      'add',
      '--quiet',
      '-b',
      'topic',
      checkout,
      'main',
    ]);
    writeFileSync(join(checkout, 'package.json'), '{"name":"fixture"}\n');
    writeFileSync(join(checkout, 'bun.lock'), '{"lockfileVersion":1}\n');
    writeFileSync(
      join(checkout, 'bunfig.toml'),
      '[install]\nlinker = "hoisted"\n'
    );
    const installedDependency = join(
      checkout,
      'node_modules',
      'fixture',
      'index.js'
    );

    const target = {
      key: 'r/topic',
      name: 'topic',
      port: 3101,
      repo: 'r',
      repoDir,
      wtDir: checkout,
    };
    target.checkoutIdentity = await inspectCheckoutIdentity(target, {
      readFile: readFileAsync,
      realpath,
      stat,
    });
    expect(target.checkoutIdentity.known).toBe(true);

    const state = createWorkspaceState({
      configPath: join(root, 'config.json'),
      setuDir: root,
      workspaceRoot: workspace,
    });
    const setupProgress = createSetupProgress({
      newAttemptId: () => 'attempt-fresh-recovery',
      now: () => 20,
      state,
    });
    const processObservation = async (pid) => ({
      processId: pid,
      processStartIdentity: 'test-owner',
      state: 'alive',
    });
    const admission = createResourceAdmission({
      hostHealth: async () => ({ availableBytes: 1024 ** 3, state: 'ready' }),
      limits: { lowStorageFloorBytes: 0 },
      now: () => 21,
      observeProcess: processObservation,
      state,
    });
    const admissionOperationId = 'admission-install-recovery';
    const admitted = await admission.admit({
      kind: 'install',
      operationId: admissionOperationId,
      target: { name: target.name, repo: target.repo },
    });
    expect(admitted.ok).toBe(true);
    const setupIdentity = target.checkoutIdentity;
    const setupTarget = { name: target.name, repo: target.repo };
    const setup = await beginSetupAttempt({
      checkoutIdentity: setupIdentity,
      logLocation: join(root, 'setup.log'),
      progress: setupProgress,
      target: setupTarget,
    });
    expect(setup.completed).toBe(false);

    const sharing = {
      enabled: true,
      executable: PINNED_BUN,
      storeIdentity: {
        device: statSync(storeRoot).dev,
        mountPath: root,
      },
      storeRoot,
      targets: { 'r/topic': true },
      version: '1.3.14',
      workspaceRoot: workspace,
    };
    await state.replace('ports', [
      {
        key: target.key,
        name: target.name,
        port: target.port,
        repo: target.repo,
      },
    ]);
    let exchangeCalls = 0;
    const native = dependencyFileOsSeam();
    const recoveryLeaseState = new Map([['busy', true]]);
    native.withDependencyFileLease = (_storeRoot, _checkoutPath, work) => {
      if (
        setupProgress.get(setupTarget)?.state === 'unknown' &&
        recoveryLeaseState.get('busy') === true
      ) {
        throw Object.assign(new Error('native helper lease is busy'), {
          code: 'LEASE_BUSY',
        });
      }
      return work();
    };
    const exchange = native.exchangeDependencyFiles;
    native.exchangeDependencyFiles = async (...args) => {
      exchangeCalls += 1;
      const result = await exchange(...args);
      if (phase === 'exchange' && exchangeCalls === 1) {
        throw Object.assign(new Error('exchange response was lost'), {
          code: 'EXCHANGE_UNKNOWN',
        });
      }
      return result;
    };
    const guardCalls = [];
    let planBoundBeforeBegin = false;
    const resources = createPortalResourceServices({
      claims: () => [],
      config: async () => ({ dependencySharing: sharing, workspace }),
      containerMode: () => 'bare',
      dependencyFileEngineFactory: async (options) => {
        const store = await openDependencyFileStore(sharing, { native });
        const journal = createDependencyFileJournal({
          now: options.now,
          randomId: options.randomId,
          state,
          storeRoot: store.identity.root,
        });
        const journalWithObservedBegin = new Proxy(journal, {
          get(journalTarget, property) {
            const value = Reflect.get(journalTarget, property, journalTarget);
            if (property === 'begin') {
              return (plan) => {
                const enrollment =
                  setupProgress.get(setupTarget)?.dependencyEnrollment;
                planBoundBeforeBegin =
                  enrollment?.operationId === plan.id &&
                  enrollment?.planId === plan.id;
                return journalTarget.begin(plan);
              };
            }
            return typeof value === 'function'
              ? value.bind(journalTarget)
              : value;
          },
        });
        return createDependencyFileSharing({
          ...options,
          assertMutable: (value, details) => {
            guardCalls.push(details);
            return options.assertMutable(value, details);
          },
          journal: journalWithObservedBegin,
          native,
          store,
        });
      },
      dependencyFileNative: native,
      entries: () => [{ ...target }],
      gitHead: async () => ({
        state: 'known',
        value: execFileSync('git', ['-C', checkout, 'rev-parse', 'HEAD'], {
          encoding: 'utf8',
        }).trim(),
      }),
      lifecycle: {
        operationStatus: () => ({ kind: 'setup', phase: 'running' }),
      },
      nativeRuntime: async () => 'dead',
      randomId: () => 'unused-random-id',
      resolveTarget: async () => target,
      resourceAdmission: admission,
      setupProgress,
      state,
      trackedPaths: async () => ({ state: 'clean' }),
      withSetupRecoveryTarget: (_value, work) =>
        state.withTargets([target], work),
    });

    const service = resources.dependencyFiles;
    let installerRuns = 0;
    let setupFailure;
    try {
      await installWorktreeDependencies(checkout, {
        admissionOperationId,
        assertStorage: () => Promise.resolve(),
        assertStoreStorage: () => Promise.resolve(),
        checkoutIdentity: setupIdentity,
        exists: existsSync,
        finalizeHoistedDependencySharing: (value, context) => {
          if (phase === 'planning') {
            throw Object.assign(new Error('crash before planning'), {
              code: 'OPERATION_UNKNOWN',
            });
          }
          return service.enrollFresh(value, context);
        },
        logLocation: setup.record.logLocation,
        prepareHoistedDependencySharing: (value, context) =>
          service.preflight(value, context),
        progress: setupProgress,
        run: (..._args) => {
          installerRuns += 1;
          mkdirSync(join(checkout, 'node_modules', 'fixture'), {
            recursive: true,
          });
          writeFileSync(
            installedDependency,
            'module.exports = "installed once";\n'
          );
          utimesSync(
            installedDependency,
            new Date('2026-01-01T00:00:00.000Z'),
            new Date('2026-01-01T00:00:00.000Z')
          );
          return { status: 0 };
        },
        setupAttempt: setup.record,
        sharing,
        state,
        target: setupTarget,
      });
    } catch (error) {
      setupFailure = error;
    }
    expect(setupFailure?.code).toBe('OPERATION_UNKNOWN');
    const bound = setupProgress.get(setupTarget);
    let operationId = bound?.dependencyEnrollment?.operationId;
    let applied;
    if (phase === 'planning') {
      expect(operationId).toBeUndefined();
      expect((await service.status(target)).operations).toEqual([]);
      const request = {
        attemptId: bound.attemptId,
        checkoutIdentity: setupIdentity,
      };
      expect(
        await service.resumeSetupEnrollment(setupTarget, request)
      ).toMatchObject({ code: 'LEASE_BUSY', ok: false });
      expect(exchangeCalls).toBe(0);
      recoveryLeaseState.set('busy', false);
      applied = await service.resumeSetupEnrollment(setupTarget, request);
      ({ operationId } = applied);
    } else {
      expect(operationId).toMatch(DIGEST_PATTERN);
      expect((await service.status(target)).operations).toContainEqual(
        expect.objectContaining({ id: operationId, state: 'unknown' })
      );
      expect(exchangeCalls).toBe(1);
      expect(planBoundBeforeBegin).toBe(true);
      expect(await service.recover(target, { operationId })).toMatchObject({
        code: 'LEASE_BUSY',
        ok: false,
      });
      recoveryLeaseState.set('busy', false);
      expect(await service.recover(target, { operationId })).toMatchObject({
        ok: true,
        operationId,
        setupRecoveryComplete: false,
      });
      applied = await service.apply(target, {
        confirmation: operationId,
        operationId,
        planId: operationId,
      });
    }
    expect(installerRuns).toBe(1);
    expect(planBoundBeforeBegin).toBe(true);
    expect(await readFileAsync(installedDependency, 'utf8')).toContain(
      'installed once'
    );
    expect(applied).toMatchObject({
      ok: true,
      operationId,
      setupRecoveryComplete: true,
      state: 'completed',
    });
    expect(guardCalls).toContainEqual(
      expect.objectContaining({
        operationId,
        phase: 'enroll-fresh',
      })
    );
    expect(exchangeCalls).toBe(1);
    expect(setupProgress.get(setupTarget).dependencyReceipt).toBeDefined();
    expect((await admission.status()).leases).toEqual([]);
    expect(setupProgress.get(setupTarget)).toMatchObject({
      dependencyEnrollment: {
        operationId,
        planId: operationId,
      },
      outcome: 'completed',
      state: 'completed',
    });
  }
);

test('setup preflight uses the resolved target lock and setup-owned guard without enrollment', async () => {
  const target = { name: 'topic', repo: 'r' };
  const setupContext = {
    admissionOperationId: 'setup-install-operation-1',
    attemptId: 'setup-attempt-1',
    checkoutIdentity: {
      checkoutPath: '/workspace/r/topic',
      known: true,
      worktreeId: 'worktree-1',
    },
    installerSettled: false,
    target,
  };
  const fx = fixture({
    engineOverrides: {
      status: async () => ({ native: { available: false }, ok: true }),
    },
  });
  await expect(
    fx.service.preflight(target, setupContext)
  ).resolves.toMatchObject({
    code: 'DEPENDENCY_FILE_NATIVE_UNAVAILABLE',
    ok: false,
  });
  expect(fx.guards).toEqual([
    {
      key: 'r/topic',
      operationId: setupContext.admissionOperationId,
      phase: 'enroll-preflight',
      setupContext,
    },
  ]);
  expect(fx.calls.filter((call) => call.kind === 'lock')).toHaveLength(1);
});

test.each([
  'DEPENDENCY_FILE_STORE_UNAVAILABLE',
  'DEPENDENCY_FILE_JOURNAL_INVALID',
])(
  'setup preflight preserves %s rather than reporting a native failure',
  async (code) => {
    const target = { name: 'topic', repo: 'r' };
    const setupContext = {
      admissionOperationId: 'admission-preflight',
      attemptId: 'attempt-preflight',
      checkoutIdentity: {
        checkoutPath: '/workspace/r/topic',
        known: true,
        worktreeId: 'worktree-1',
      },
      installerSettled: false,
      target,
    };
    const fx = fixture({
      engineOverrides: {
        status: async () => ({
          code,
          error: 'specific durable status failure',
          ok: false,
        }),
      },
    });
    expect(await fx.service.preflight(target, setupContext)).toMatchObject({
      code,
      ok: false,
    });
  }
);
