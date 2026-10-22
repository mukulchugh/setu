/** Contract tests use injected filesystem/store/journal doubles. They verify
 * G4 orchestration only; the mocked exchange is not proof of native atomicity.
 */
import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inspectCheckoutIdentity } from './checkout-identity.js';
import { createDependencyFileJournal } from './dependency-file-journal.js';
import { dependencyObjectKey } from './dependency-file-object.js';
import { createDependencyFileSharing } from './dependency-file-sharing.js';
import { createWorkspaceState } from './workspace-state.js';

const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const digestJson = (value) => sha256(JSON.stringify(value));
const SHA256_PATTERN = /^[a-f0-9]{64}$/;

function canonicalJson(value) {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(',')}]`;
  }
  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function withoutAccessTimes(value) {
  if (Array.isArray(value)) {
    return value.map(withoutAccessTimes);
  }
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([key]) => key !== 'atimeNs')
        .map(([key, child]) => [key, withoutAccessTimes(child)])
    );
  }
  return value;
}

function createJournal() {
  const plans = new Map();
  const operations = new Map();
  const checkpoints = new Map();
  const releasePlans = new Map();
  const views = new Map();
  let checkpointReadCount = 0;
  let failBeforeSwappedCheckpoint = false;
  return {
    begin(plan) {
      let current = operations.get(plan.id);
      if (!current) {
        current = {
          checkoutIdentity: plan.checkoutIdentity,
          completedFiles: 0,
          createdAt: 1,
          id: plan.id,
          inputDigest: plan.inputDigest,
          logicalCloneBytes: plan.logicalCloneBytes,
          mode: 'hoisted-cow',
          name: plan.name,
          physicalSavingsBytes: null,
          planId: plan.id,
          repo: plan.repo,
          retainedOriginalFiles: 0,
          state: 'prepared',
          storeIdentity: plan.storeIdentity,
          totalFiles: plan.files.length,
          updatedAt: 1,
          version: 1,
        };
        operations.set(plan.id, current);
      }
      return structuredClone(current);
    },
    checkpoint(id, index, record) {
      if (failBeforeSwappedCheckpoint && record.phase === 'swapped') {
        failBeforeSwappedCheckpoint = false;
        throw Object.assign(new Error('lost checkpoint response'), {
          code: 'JOURNAL_WRITE_UNKNOWN',
        });
      }
      const map = checkpoints.get(id) ?? new Map();
      map.set(index, structuredClone({ ...record, index }));
      checkpoints.set(id, map);
      return structuredClone(record);
    },
    checkpointReadCount: () => checkpointReadCount,
    checkpoints(id) {
      checkpointReadCount += 1;
      return [...(checkpoints.get(id)?.values() ?? [])].map((row) =>
        structuredClone(row)
      );
    },
    checkpointsFor() {
      return [];
    },
    failSwappedCheckpointOnce() {
      failBeforeSwappedCheckpoint = true;
    },
    finish(id, patch) {
      const current = operations.get(id);
      if (!current) {
        throw Object.assign(new Error('missing operation'), {
          code: 'DEPENDENCY_FILE_OPERATION_NOT_FOUND',
        });
      }
      const rows = [...(checkpoints.get(id)?.values() ?? [])];
      const next = {
        ...current,
        completedFiles: rows.filter((row) =>
          ['verified', 'released'].includes(row.phase)
        ).length,
        retainedOriginalFiles: rows.filter(
          (row) => row.retainedFingerprint && row.phase !== 'released'
        ).length,
        ...structuredClone(patch),
        updatedAt: 2,
      };
      const allowed = [
        'state',
        'code',
        'operationId',
        'mode',
        'completedFiles',
        'retainedOriginalFiles',
        'totalFiles',
        'logicalCloneBytes',
        'physicalSavingsBytes',
        'updatedAt',
      ];
      if (Object.keys(patch).some((key) => !allowed.includes(key))) {
        throw Object.assign(new Error('strict journal finish schema'), {
          code: 'DEPENDENCY_FILE_JOURNAL_INVALID',
        });
      }
      const expected = {
        completedFiles: rows.filter((row) =>
          ['verified', 'released'].includes(row.phase)
        ).length,
        logicalCloneBytes: current.logicalCloneBytes,
        mode: current.mode,
        operationId: id,
        physicalSavingsBytes: null,
        retainedOriginalFiles: rows.filter(
          (row) => row.retainedFingerprint && row.phase !== 'released'
        ).length,
        totalFiles: current.totalFiles,
      };
      if (
        Object.entries(patch).some(
          ([key, value]) => key in expected && value !== expected[key]
        )
      ) {
        throw Object.assign(new Error('checkpoint-derived progress mismatch'), {
          code: 'DEPENDENCY_FILE_JOURNAL_INVALID',
        });
      }
      operations.set(id, next);
      return structuredClone(next);
    },
    getOperation(id) {
      return structuredClone(operations.get(id) ?? null);
    },
    getPlan(id) {
      return structuredClone(plans.get(id) ?? null);
    },
    getReleasePlan(id) {
      return structuredClone(releasePlans.get(id) ?? null);
    },
    list({ name, repo } = {}) {
      return [...operations.values()]
        .filter(
          (row) => (!name || row.name === name) && (!repo || row.repo === repo)
        )
        .map((row) => structuredClone(row));
    },
    operations,
    plans,
    releasePlans,
    savePlan(plan) {
      const existing = plans.get(plan.id);
      if (existing && JSON.stringify(existing) !== JSON.stringify(plan)) {
        throw Object.assign(new Error('plan collision'), {
          code: 'DEPENDENCY_FILE_PLAN_CONFLICT',
        });
      }
      plans.set(plan.id, structuredClone(plan));
      return structuredClone(plan);
    },
    saveReleasePlan(plan) {
      releasePlans.set(plan.id, structuredClone(plan));
      return structuredClone(plan);
    },
    setView(target, summary) {
      views.set(`${target.repo}/${target.name}`, structuredClone(summary));
    },
    views,
  };
}

async function createFixture({
  base = tmpdir(),
  onBeforeExchange,
  nativeAvailable = true,
  realJournal = false,
  targetLockAvailable = true,
  mutableGuardAvailable = true,
} = {}) {
  const tempRoot = realpathSync(
    mkdtempSync(join(base, 'setu-dependency-file-contract-'))
  );
  const repoDir = join(tempRoot, 'project.git');
  const adminDir = join(repoDir, 'worktrees', 'topic');
  const checkout = join(tempRoot, 'workspace', 'project', 'topic');
  const storeRoot = join(tempRoot, 'dependency-store');
  mkdirSync(adminDir, { recursive: true });
  mkdirSync(checkout, { recursive: true });
  mkdirSync(storeRoot, { mode: 0o700 });
  writeFileSync(join(checkout, '.git'), `gitdir: ${adminDir}\n`);
  writeFileSync(join(adminDir, 'commondir'), '../..\n');
  writeFileSync(join(adminDir, 'gitdir'), `${join(checkout, '.git')}\n`);
  const packageDir = join(checkout, 'node_modules', 'fixture-pkg');
  mkdirSync(packageDir, { recursive: true });
  const sourcePath = join(packageDir, 'index.js');
  writeFileSync(sourcePath, 'export default "fixture";\n', { mode: 0o644 });
  const target = {
    name: 'topic',
    repo: 'project',
    repoDir,
    wtDir: realpathSync(checkout),
  };
  target.checkoutIdentity = await inspectCheckoutIdentity(target, {
    readFile: readFileSync,
    realpath: realpathSync,
    stat: statSync,
  });
  expect(target.checkoutIdentity).toMatchObject({ known: true });

  const timeOverrides = new Map();
  const native = {
    dependencyFileNativeStatus() {
      return Promise.resolve(
        nativeAvailable
          ? { available: true, code: null }
          : { available: false, code: 'NATIVE_HELPER_MISSING' }
      );
    },
    async exchangeDependencyFiles(root, targetPath, stagePath) {
      await onBeforeExchange?.(root, targetPath, stagePath);
      const targetAbs = join(root, ...targetPath.split('/'));
      const stageAbs = join(root, ...stagePath.split('/'));
      const holdAbs = `${targetAbs}.contract-hold`;
      // Test double only: this sequence emulates the postcondition for G4
      // contract tests and is not an atomic exchange implementation.
      renameSync(targetAbs, holdAbs);
      renameSync(stageAbs, targetAbs);
      renameSync(holdAbs, stageAbs);
      return { exchanged: true };
    },
    nativeBinary: '/fixture/no-native-helper-used',
    readDependencyFile(root, relativePath) {
      const absolute = join(root, ...relativePath.split('/'));
      let before;
      try {
        before = lstatSync(absolute, { bigint: true });
      } catch (error) {
        if (error.code === 'ENOENT') {
          return { eligible: false, reason: 'missing' };
        }
        throw error;
      }
      if (
        before.isSymbolicLink() ||
        !before.isFile() ||
        before.nlink !== 1n ||
        Number(before.uid) !== process.getuid() ||
        before.mode % 0o10000n >= 0o1000n
      ) {
        return { eligible: false, reason: 'unsafe fixture metadata' };
      }
      const bytes = readFileSync(absolute);
      const after = lstatSync(absolute, { bigint: true });
      if (
        before.dev !== after.dev ||
        before.ino !== after.ino ||
        before.size !== after.size ||
        before.mtimeNs !== after.mtimeNs ||
        before.ctimeNs !== after.ctimeNs
      ) {
        return { eligible: false, reason: 'changed while reading' };
      }
      const contentHash = sha256(bytes);
      const times = timeOverrides.get(`${after.dev}:${after.ino}`) ?? {};
      const mode = Number(after.mode % 0o10000n);
      const uid = Number(after.uid);
      const gid = Number(after.gid);
      const mtimeNs = times.mtimeNs ?? String(after.mtimeNs);
      const atimeNs = times.atimeNs ?? String(after.atimeNs);
      const attributes = [];
      const metadataHash = digestJson({ attributes, gid, mode, mtimeNs, uid });
      const identityHash = digestJson({
        contentHash,
        ctimeNs: String(after.ctimeNs),
        device: String(after.dev),
        inode: String(after.ino),
        metadataHash,
        mtimeNs,
        size: Number(after.size),
      });
      return {
        eligible: true,
        fingerprint: {
          atimeNs,
          attributes,
          contentHash,
          ctimeNs: String(after.ctimeNs),
          device: String(after.dev),
          gid,
          identityHash,
          inode: String(after.ino),
          metadataHash,
          mode,
          mtimeNs,
          relativePath,
          size: Number(after.size),
          uid,
        },
      };
    },
    async removeDependencyBackup(root, relativePath, expectedFingerprint) {
      counters.removeBackup += 1;
      const absolute = join(root, ...relativePath.split('/'));
      const current = await this.readDependencyFile(root, relativePath);
      if (
        !(
          current.eligible &&
          this.sameDependencyFile(expectedFingerprint, current.fingerprint, {
            identity: true,
          })
        )
      ) {
        throw Object.assign(new Error('backup identity changed'), {
          code: 'DEPENDENCY_FILE_RELEASE_DRIFT',
        });
      }
      unlinkSync(absolute);
      return { removed: true };
    },
    restoreDependencyTimes(root, relativePath, times) {
      const absolute = join(root, ...relativePath.split('/'));
      const info = lstatSync(absolute, { bigint: true });
      timeOverrides.set(`${info.dev}:${info.ino}`, { ...times });
    },
    sameDependencyFile(left, right, { identity = false } = {}) {
      return identity
        ? left?.identityHash === right?.identityHash
        : left?.contentHash === right?.contentHash &&
            left?.metadataHash === right?.metadataHash &&
            left?.size === right?.size;
    },
    setTimesForTest: timeOverrides,
    syncDependencyDirectory() {
      return { synced: true };
    },
  };
  let state;
  if (realJournal) {
    state = createWorkspaceState({
      configPath: join(tempRoot, 'setu.json'),
      setuDir: tempRoot,
      workspaceRoot: tempRoot,
    });
  } else if (targetLockAvailable) {
    state = {
      withTargets: (_targets, work) => {
        targetLockCalls += 1;
        return work();
      },
    };
  } else {
    state = {};
  }
  const journal = realJournal
    ? createDependencyFileJournal({ now: () => 100, state, storeRoot })
    : createJournal();
  const counters = { ensure: 0, exchange: 0, removeBackup: 0, stage: 0 };
  const ensureVersions = [];
  const objects = new Map();
  const realExchange = native.exchangeDependencyFiles;
  native.exchangeDependencyFiles = (...args) => {
    counters.exchange += 1;
    return realExchange(...args);
  };
  const storeIdentity = {
    device: String(lstatSync(storeRoot).dev),
    executable: join(tempRoot, 'bun'),
    mountPath: tempRoot,
    namespace: 'hoisted/darwin-arm64-bun-1.3.14',
    root: storeRoot,
    version: '1.3.14',
  };
  const store = {
    describe() {
      return { identity: storeIdentity, root: store.root };
    },
    async ensure(fingerprint, checkoutRoot, { version } = {}) {
      counters.ensure += 1;
      ensureVersions.push(version);
      const current = await native.readDependencyFile(
        checkoutRoot,
        fingerprint.relativePath
      );
      if (
        !(
          current.eligible &&
          native.sameDependencyFile(fingerprint, current.fingerprint, {
            identity: true,
          })
        )
      ) {
        throw Object.assign(new Error('source changed'), {
          code: 'DEPENDENCY_FILE_CONFLICT',
        });
      }
      const key = store.objectKey(fingerprint, version);
      objects.set(
        key,
        readFileSync(join(checkoutRoot, fingerprint.relativePath))
      );
      const relativePath = `objects/${key.slice(0, 2)}/${key}`;
      const canonicalFingerprint = {
        ...fingerprint,
        ...(version === 2
          ? {
              atimeNs: `${BigInt(fingerprint.atimeNs) + 10n}`,
              ctimeNs: `${BigInt(fingerprint.ctimeNs) + 20n}`,
              identityHash: 'd'.repeat(64),
              metadataHash: 'e'.repeat(64),
              mtimeNs: `${BigInt(fingerprint.mtimeNs) + 30n}`,
            }
          : {}),
        relativePath,
      };
      const returnedFingerprint = store.canonicalOverride
        ? store.canonicalOverride(canonicalFingerprint)
        : canonicalFingerprint;
      return {
        fingerprint: returnedFingerprint,
        key,
        relativePath,
      };
    },
    identity: storeIdentity,
    objectKey(fingerprint, version = 2) {
      return dependencyObjectKey(fingerprint, version);
    },
    root: join(storeRoot, ...storeIdentity.namespace.split('/')),
    stage(key, checkoutRoot, relativePath, expectedFingerprint) {
      counters.stage += 1;
      const destination = join(checkoutRoot, ...relativePath.split('/'));
      writeFileSync(destination, objects.get(key), {
        flag: 'wx',
        mode: expectedFingerprint.mode,
      });
      chmodSync(destination, expectedFingerprint.mode);
      return { fingerprint: expectedFingerprint };
    },
    verify(key, fingerprint) {
      return (
        objects.has(key) &&
        [1, 2].some((version) => key === store.objectKey(fingerprint, version))
      );
    },
  };
  const inputState = { digest: 'c'.repeat(64) };
  let inputCalls = 0;
  const guardPhases = [];
  let targetLockCalls = 0;
  const engine = createDependencyFileSharing({
    assertMutable: mutableGuardAvailable
      ? (_target, { phase }) => {
          guardPhases.push(phase);
          return true;
        }
      : undefined,
    inputs: (root) => {
      inputCalls += 1;
      return {
        checkout: root,
        device: lstatSync(root).dev,
        head: 'a'.repeat(40),
        inputDigest: inputState.digest,
        linker: 'hoisted',
        lockfileHash: 'b'.repeat(64),
        roots: ['node_modules'],
      };
    },
    journal,
    native,
    now: () => 100,
    randomId: (() => {
      let next = 0;
      return () => {
        next += 1;
        return `fixture-${next}`;
      };
    })(),
    sharing: { enabled: true },
    state,
    store,
  });
  const cleanup = () => rmSync(tempRoot, { force: true, recursive: true });
  return {
    checkout: target.wtDir,
    cleanup,
    counters,
    engine,
    ensureVersions,
    guardPhases,
    inputCalls: () => inputCalls,
    inputState,
    journal,
    native,
    packageDir,
    repoDir,
    sourcePath,
    store,
    storeRoot,
    target,
    targetLockCalls: () => targetLockCalls,
  };
}

test('prepare records a relative review and does not populate the store or replace checkout files', async () => {
  const fx = await createFixture();
  try {
    const hardlink = join(fx.packageDir, 'linked.js');
    const symlink = join(fx.packageDir, 'workspace-link.js');
    const outside = join(fx.checkout, 'outside.js');
    writeFileSync(outside, 'outside\n');
    // Both exclusions are synthetic fixture evidence, not native-helper tests.
    linkSync(outside, hardlink);
    symlinkSync(outside, symlink);
    const before = readFileSync(fx.sourcePath, 'utf8');
    const result = await fx.engine.prepare(fx.target);
    expect(result).toMatchObject({
      confirmation: result.planId,
      fileCount: 1,
      ok: true,
      physicalSavingsBytes: null,
    });
    expect(result.plan).toMatchObject({
      id: result.planId,
      mode: 'hoisted-cow',
      name: 'topic',
      repo: 'project',
      version: 2,
    });
    expect(result.plan.checkoutIdentity).toEqual(fx.target.checkoutIdentity);
    expect(result.plan.files[0].relativePath).toBe(
      'node_modules/fixture-pkg/index.js'
    );
    expect(
      result.plan.files[0].temporaryRelativePath.startsWith(
        'node_modules/fixture-pkg/.setu-dependency-'
      )
    ).toBe(true);
    expect(result.plan.files[0].temporaryRelativePath).not.toContain(
      fx.checkout
    );
    expect(Object.isFrozen(fx.store.identity)).toBe(false);
    expect(result.plan.skipped.map((row) => row.relativePath)).toContain(
      'node_modules/fixture-pkg/linked.js'
    );
    expect(result.plan.skipped.map((row) => row.relativePath)).toContain(
      'node_modules/fixture-pkg/workspace-link.js'
    );
    expect(fx.counters).toEqual({
      ensure: 0,
      exchange: 0,
      removeBackup: 0,
      stage: 0,
    });
    expect(fx.targetLockCalls()).toBe(1);
    expect(readFileSync(fx.sourcePath, 'utf8')).toBe(before);
  } finally {
    fx.cleanup();
  }
});

test('new plans use v2 canonical object keys while a saved v1 plan resumes with legacy validation', async () => {
  const fx = await createFixture();
  try {
    const prepared = await fx.engine.prepare(fx.target);
    expect(prepared.ok).toBe(true);
    expect(prepared.plan.version).toBe(2);
    expect(prepared.plan.files[0].objectKey).toBe(
      dependencyObjectKey(prepared.plan.files[0].fingerprint, 2)
    );

    // Simulate an immutable v1 plan written by an earlier Setu version. Keep
    // its original source fingerprint and stage path while restoring the
    // exact legacy key and stable plan digest.
    const legacy = structuredClone(prepared.plan);
    const previousId = legacy.id;
    legacy.version = 1;
    for (const file of legacy.files) {
      file.objectKey = dependencyObjectKey(file.fingerprint, 1);
    }
    const { createdAt: _createdAt, id: _id, ...legacyBody } = legacy;
    legacy.id = sha256(canonicalJson(withoutAccessTimes(legacyBody)));
    fx.journal.plans.delete(previousId);
    fx.journal.plans.set(legacy.id, legacy);

    fx.journal.failSwappedCheckpointOnce();
    const uncertain = await fx.engine.apply(fx.target, {
      confirmation: legacy.id,
      operationId: legacy.id,
      planId: legacy.id,
    });
    expect(uncertain).toMatchObject({ ok: false, planId: legacy.id });
    const recovered = await fx.engine.recover(fx.target, {
      operationId: legacy.id,
    });
    expect(recovered).toMatchObject({ ok: true, operationId: legacy.id });
    const resumed = await fx.engine.apply(fx.target, {
      confirmation: legacy.id,
      operationId: legacy.id,
      planId: legacy.id,
    });
    expect(resumed).toMatchObject({ ok: true, planId: legacy.id });
    expect(fx.ensureVersions).toEqual([1]);
  } finally {
    fx.cleanup();
  }
});

test('v2 canonical validation rejects stable metadata drift while allowing only timestamp drift', async () => {
  for (const change of [
    (fp) => ({ ...fp, contentHash: 'f'.repeat(64) }),
    (fp) => ({ ...fp, mode: fp.mode + 1 }),
    (fp) => ({ ...fp, uid: fp.uid + 1 }),
    (fp) => ({
      ...fp,
      attributes: [{ digest: 'a'.repeat(64), name: 'user.setu-test' }],
    }),
  ]) {
    // biome-ignore lint/performance/noAwaitInLoops: Dispose each fixture before allocating the next metadata-refusal case.
    const fx = await createFixture();
    try {
      const prepared = await fx.engine.prepare(fx.target);
      fx.store.canonicalOverride = change;
      const result = await fx.engine.apply(fx.target, {
        confirmation: prepared.planId,
        planId: prepared.planId,
      });
      expect(result).toMatchObject({
        code: 'DEPENDENCY_FILE_STORE_RESULT_INVALID',
        ok: false,
      });
      expect(fx.counters.stage).toBe(0);
      expect(fx.counters.exchange).toBe(0);
    } finally {
      fx.cleanup();
    }
  }
});

test('real workspace state and dependency journal accept G4 apply and separate release records (exchange is a labeled filesystem seam)', async () => {
  const fx = await createFixture({ realJournal: true });
  try {
    const prepared = await fx.engine.prepare(fx.target);
    expect(prepared.ok, JSON.stringify(prepared)).toBe(true);
    const applied = await fx.engine.apply(fx.target, {
      confirmation: prepared.planId,
      planId: prepared.planId,
    });
    expect(applied).toMatchObject({
      completedFiles: 1,
      id: prepared.planId,
      mode: 'hoisted-cow',
      ok: true,
      retainedOriginalFiles: 1,
      state: 'completed',
    });
    const review = await fx.engine.prepareRelease(fx.target, {
      operationId: prepared.planId,
    });
    expect(review).toMatchObject({ ok: true, releaseId: review.confirmation });
    const released = await fx.engine.release(fx.target, {
      confirmation: review.releaseId,
      releaseId: review.releaseId,
    });
    expect(released).toMatchObject({
      id: prepared.planId,
      ok: true,
      retainedOriginalFiles: 0,
      state: 'released',
    });
  } finally {
    fx.cleanup();
  }
});

test('Data-volume firmlink supports prepare, apply, recovery and separate release through real journal (exchange seam)', async () => {
  if (process.platform !== 'darwin') {
    return;
  }
  const fx = await createFixture({ base: process.cwd(), realJournal: true });
  const mountPath = realpathSync('/System/Volumes/Data');
  expect(fx.storeRoot.startsWith(`${mountPath}/`)).toBe(false);
  expect(statSync(fx.storeRoot).dev).toBe(statSync(mountPath).dev);
  fx.store.identity.mountPath = mountPath;
  try {
    const prepared = await fx.engine.prepare(fx.target);
    expect(prepared.ok, JSON.stringify(prepared)).toBe(true);
    const applied = await fx.engine.apply(fx.target, {
      confirmation: prepared.planId,
      planId: prepared.planId,
    });
    expect(applied).toMatchObject({
      completedFiles: 1,
      id: prepared.planId,
      mode: 'hoisted-cow',
      ok: true,
      retainedOriginalFiles: 1,
      state: 'completed',
    });
    const recovered = await fx.engine.recover(fx.target, {
      operationId: prepared.planId,
    });
    expect(recovered).toMatchObject({ ok: true, state: 'completed' });
    const review = await fx.engine.prepareRelease(fx.target, {
      operationId: prepared.planId,
    });
    expect(review).toMatchObject({ ok: true, releaseId: review.confirmation });
    const released = await fx.engine.release(fx.target, {
      confirmation: review.releaseId,
      releaseId: review.releaseId,
    });
    expect(released).toMatchObject({
      id: prepared.planId,
      ok: true,
      retainedOriginalFiles: 0,
      state: 'released',
    });
  } finally {
    fx.cleanup();
  }
});

test('store mount identity refuses symlink aliases and a different device before plan writes', async () => {
  const fx = await createFixture({ realJournal: true });
  try {
    const alias = join(fx.checkout, 'mount-alias');
    symlinkSync(fx.store.identity.mountPath, alias);
    fx.store.identity.mountPath = alias;
    expect(await fx.engine.prepare(fx.target)).toMatchObject({
      code: 'DEPENDENCY_FILE_STORE_CHANGED',
      ok: false,
    });
    if (String(statSync('/').dev) !== fx.store.identity.device) {
      fx.store.identity.mountPath = '/';
      expect(await fx.engine.prepare(fx.target)).toMatchObject({
        code: 'DEPENDENCY_FILE_STORE_CHANGED',
        ok: false,
      });
    }
    expect(existsSync(join(fx.storeRoot, 'dependency-files'))).toBe(false);
    expect(fx.counters.ensure).toBe(0);
  } finally {
    fx.cleanup();
  }
});

test('review id and sibling stage path stay stable when reads change only access time', async () => {
  const fx = await createFixture();
  try {
    const first = await fx.engine.prepare(fx.target);
    const [file] = first.plan.files;
    const before = await fx.native.readDependencyFile(
      fx.checkout,
      file.relativePath
    );
    fx.native.setTimesForTest.set(
      `${before.fingerprint.device}:${before.fingerprint.inode}`,
      {
        atimeNs: `${BigInt(before.fingerprint.atimeNs) + 1_000_000n}`,
      }
    );

    const second = await fx.engine.prepare(fx.target);

    expect(second.ok).toBe(true);
    expect(second.planId).toBe(first.planId);
    expect(second.plan.files[0].temporaryRelativePath).toBe(
      file.temporaryRelativePath
    );
    expect(second.plan.files[0].fingerprint.atimeNs).toBe(
      file.fingerprint.atimeNs
    );
  } finally {
    fx.cleanup();
  }
});

test('prepare refuses a deterministic stage path already occupied by an entry', async () => {
  const fx = await createFixture();
  try {
    const first = await fx.engine.prepare(fx.target);
    const collision = join(
      fx.checkout,
      first.plan.files[0].temporaryRelativePath
    );
    writeFileSync(collision, 'preexisting entry\n', { flag: 'wx' });

    const second = await fx.engine.prepare(fx.target);

    expect(second).toMatchObject({
      code: 'DEPENDENCY_FILE_STAGE_PATH_CONFLICT',
      ok: false,
    });
    expect(fx.journal.plans.size).toBe(1);
    expect(fx.counters).toEqual({
      ensure: 0,
      exchange: 0,
      removeBackup: 0,
      stage: 0,
    });
  } finally {
    fx.cleanup();
  }
});

test('prepare refuses a retained operation before scanning while the same plan can resume', async () => {
  let interruptExchange = true;
  const fx = await createFixture({
    onBeforeExchange() {
      if (interruptExchange) {
        interruptExchange = false;
        throw Object.assign(new Error('injected exchange interruption'), {
          code: 'TEST_EXCHANGE_INTERRUPTED',
        });
      }
    },
    realJournal: true,
  });
  try {
    const reviewed = await fx.engine.prepare(fx.target);
    const interrupted = await fx.engine.apply(fx.target, {
      confirmation: reviewed.planId,
      operationId: reviewed.planId,
      planId: reviewed.planId,
    });
    expect(interrupted).toMatchObject({ ok: false, state: 'unknown' });

    const inputCallsBeforeRetry = fx.inputCalls();
    const refused = await fx.engine.prepare(fx.target);
    expect(refused).toMatchObject({
      code: 'DEPENDENCY_FILE_OPERATION_EXISTS',
      ok: false,
      operationId: reviewed.planId,
      planId: reviewed.planId,
    });
    expect(fx.inputCalls()).toBe(inputCallsBeforeRetry);

    const resumed = await fx.engine.apply(fx.target, {
      confirmation: reviewed.planId,
      operationId: reviewed.planId,
      planId: reviewed.planId,
    });
    expect(resumed).toMatchObject({ ok: true, state: 'completed' });
  } finally {
    fx.cleanup();
  }
});

test('apply requires the exact plan confirmation and keeps the original until a separate release review', async () => {
  const fx = await createFixture();
  try {
    const prepared = await fx.engine.prepare(fx.target);
    const refused = await fx.engine.apply(fx.target, {
      confirmation: 'yes',
      planId: prepared.planId,
    });
    expect(refused).toMatchObject({
      code: 'CONFIRMATION_REQUIRED',
      ok: false,
    });
    expect(fx.journal.operations.size).toBe(0);
    const applied = await fx.engine.apply(fx.target, {
      confirmation: prepared.planId,
      operationId: prepared.planId,
      planId: prepared.planId,
    });
    expect(applied).toMatchObject({
      completedFiles: 1,
      id: prepared.planId,
      ok: true,
      physicalSavingsBytes: null,
      planId: prepared.planId,
      retainedOriginalFiles: 1,
      state: 'completed',
    });
    expect(applied).toMatchObject(fx.journal.views.get('project/topic'));
    const [file] = prepared.plan.files;
    expect(existsSync(join(fx.checkout, file.temporaryRelativePath))).toBe(
      true
    );
    expect(readFileSync(join(fx.checkout, file.relativePath), 'utf8')).toBe(
      'export default "fixture";\n'
    );
    expect(fx.counters).toEqual({
      ensure: 1,
      exchange: 1,
      removeBackup: 0,
      stage: 1,
    });
    expect((await fx.journal.checkpoints(prepared.planId))[0].phase).toBe(
      'verified'
    );

    const releaseReview = await fx.engine.prepareRelease(fx.target, {
      operationId: prepared.planId,
    });
    expect(releaseReview).toMatchObject({
      ok: true,
      releaseId: releaseReview.confirmation,
      retainedOriginalFiles: 1,
    });
    expect(releaseReview.releasePlan).toMatchObject({
      files: [
        {
          installedFingerprint: { relativePath: file.relativePath },
          originalFingerprint: { relativePath: file.temporaryRelativePath },
        },
      ],
      mode: 'hoisted-cow',
      operationId: prepared.planId,
      planId: prepared.planId,
    });
    expect(Object.keys(releaseReview.releasePlan).sort()).toEqual([
      'checkoutIdentity',
      'createdAt',
      'files',
      'id',
      'inputDigest',
      'manifestDigest',
      'mode',
      'name',
      'operationId',
      'planId',
      'repo',
      'storeIdentity',
      'version',
    ]);
    expect(existsSync(join(fx.checkout, file.temporaryRelativePath))).toBe(
      true
    );
    const wrongRelease = await fx.engine.release(fx.target, {
      confirmation: 'yes',
      releaseId: releaseReview.releaseId,
    });
    expect(wrongRelease).toMatchObject({
      code: 'CONFIRMATION_REQUIRED',
      ok: false,
      releaseId: releaseReview.releaseId,
    });
    expect(existsSync(join(fx.checkout, file.temporaryRelativePath))).toBe(
      true
    );
    const release = await fx.engine.release(fx.target, {
      confirmation: releaseReview.releaseId,
      releaseId: releaseReview.releaseId,
    });
    expect(release).toMatchObject({
      ok: true,
      physicalSavingsBytes: null,
      retainedOriginalFiles: 0,
      state: 'released',
    });
    expect(release).toMatchObject(fx.journal.views.get('project/topic'));
    expect(existsSync(join(fx.checkout, file.temporaryRelativePath))).toBe(
      false
    );
    expect(readFileSync(join(fx.checkout, file.relativePath), 'utf8')).toBe(
      'export default "fixture";\n'
    );
    expect(fx.counters.removeBackup).toBe(1);
    expect(
      fx.guardPhases.filter((phase) => phase === 'apply').length
    ).toBeGreaterThan(2);
    expect(fx.targetLockCalls()).toBe(6);
  } finally {
    fx.cleanup();
  }
});

test('large apply revalidates inputs at batch boundaries and reads checkpoints as a bounded scan', async () => {
  const fx = await createFixture();
  try {
    for (let index = 0; index < 64; index += 1) {
      writeFileSync(
        join(fx.packageDir, `extra-${index}.js`),
        `export const n = ${index};\n`
      );
    }
    const prepared = await fx.engine.prepare(fx.target);
    expect(prepared.fileCount).toBe(65);
    const inputCallsBeforeApply = fx.inputCalls();
    const checkpointReadsBeforeApply = fx.journal.checkpointReadCount();
    const applied = await fx.engine.apply(fx.target, {
      confirmation: prepared.planId,
      planId: prepared.planId,
    });
    expect(applied).toMatchObject({ completedFiles: 65, ok: true });
    expect(fx.inputCalls() - inputCallsBeforeApply).toBeLessThanOrEqual(6);
    expect(
      fx.journal.checkpointReadCount() - checkpointReadsBeforeApply
    ).toBeLessThanOrEqual(3);
  } finally {
    fx.cleanup();
  }
});

test('a late writer produces a conflict and leaves both exchanged entries in place', async () => {
  let writerFile;
  const fx = await createFixture({
    onBeforeExchange: () => {
      writeFileSync(writerFile, 'late writer\n');
    },
  });
  try {
    writerFile = fx.sourcePath;
    const prepared = await fx.engine.prepare(fx.target);
    const [file] = prepared.plan.files;
    const applied = await fx.engine.apply(fx.target, {
      confirmation: prepared.planId,
      planId: prepared.planId,
    });
    expect(applied).toMatchObject({
      code: 'DEPENDENCY_FILE_CONFLICT',
      ok: false,
      state: 'conflict',
    });
    expect(readFileSync(join(fx.checkout, file.relativePath), 'utf8')).toBe(
      'export default "fixture";\n'
    );
    expect(
      readFileSync(join(fx.checkout, file.temporaryRelativePath), 'utf8')
    ).toBe('late writer\n');
    expect(existsSync(join(fx.checkout, file.relativePath))).toBe(true);
    expect(existsSync(join(fx.checkout, file.temporaryRelativePath))).toBe(
      true
    );
  } finally {
    fx.cleanup();
  }
});

test('a missing native helper refuses plan creation before input or journal mutation', async () => {
  const fx = await createFixture({ nativeAvailable: false });
  try {
    const prepared = await fx.engine.prepare(fx.target);
    expect(prepared).toMatchObject({
      code: 'DEPENDENCY_FILE_NATIVE_UNAVAILABLE',
      ok: false,
    });
    expect(fx.journal.operations.size).toBe(0);
    expect(fx.journal.plans.size).toBe(0);
    expect(fx.inputCalls()).toBe(0);
    expect(fx.counters.exchange).toBe(0);
  } finally {
    fx.cleanup();
  }
});

test('status reads the durable summary and native capability without rescanning dependency inputs', async () => {
  const fx = await createFixture();
  try {
    const prepared = await fx.engine.prepare(fx.target);
    const callsBeforeStatus = fx.inputCalls();
    const result = await fx.engine.status(fx.target);
    expect(result).toMatchObject({
      native: { available: true },
      ok: true,
      state: 'unshared',
    });
    expect(fx.inputCalls()).toBe(callsBeforeStatus);
    expect(result.operations).toEqual([]);
    expect(prepared.ok).toBe(true);
  } finally {
    fx.cleanup();
  }
});

test('changed dependency inputs invalidate a reviewed plan before store or checkout mutation', async () => {
  const fx = await createFixture();
  try {
    const prepared = await fx.engine.prepare(fx.target);
    fx.inputState.digest = 'd'.repeat(64);
    const applied = await fx.engine.apply(fx.target, {
      confirmation: prepared.planId,
      planId: prepared.planId,
    });
    expect(applied).toMatchObject({
      code: 'DEPENDENCY_FILE_PLAN_CHANGED',
      ok: false,
    });
    expect(fx.counters).toEqual({
      ensure: 0,
      exchange: 0,
      removeBackup: 0,
      stage: 0,
    });
    expect(fx.journal.operations.size).toBe(0);
  } finally {
    fx.cleanup();
  }
});

test('a changed configured store identity refuses apply with the same plan id', async () => {
  const fx = await createFixture();
  try {
    const prepared = await fx.engine.prepare(fx.target);
    fx.store.identity.device = -1;
    const applied = await fx.engine.apply(fx.target, {
      confirmation: prepared.planId,
      planId: prepared.planId,
    });
    expect(applied).toMatchObject({
      code: 'DEPENDENCY_FILE_STORE_CHANGED',
      ok: false,
      operationId: prepared.planId,
      planId: prepared.planId,
    });
    expect(fx.counters).toEqual({
      ensure: 0,
      exchange: 0,
      removeBackup: 0,
      stage: 0,
    });
    expect(fx.journal.operations.size).toBe(0);
  } finally {
    fx.cleanup();
  }
});

test('mutations fail closed without the required target lock or mutability guard', async () => {
  const noTargetLock = await createFixture({ targetLockAvailable: false });
  try {
    expect(
      await noTargetLock.engine.prepare(noTargetLock.target)
    ).toMatchObject({
      code: 'DEPENDENCY_FILE_TARGET_LOCK_REQUIRED',
      ok: false,
    });
  } finally {
    noTargetLock.cleanup();
  }

  const noGuard = await createFixture({ mutableGuardAvailable: false });
  try {
    expect(await noGuard.engine.prepare(noGuard.target)).toMatchObject({
      code: 'DEPENDENCY_FILE_GUARD_REQUIRED',
      ok: false,
    });
    expect(noGuard.journal.plans.size).toBe(0);
  } finally {
    noGuard.cleanup();
  }
});

test('fresh enrollment uses setup ownership guards and refuses a second enrollment intent', async () => {
  const fx = await createFixture();
  try {
    const enrolled = await fx.engine.enrollFresh(fx.target);
    expect(enrolled).toMatchObject({
      ok: true,
      state: 'completed',
      totalFiles: 1,
    });
    expect(fx.guardPhases.length).toBeGreaterThan(3);
    expect(new Set(fx.guardPhases)).toEqual(new Set(['enroll-fresh']));
    expect(fx.journal.operations.size).toBe(1);
    const counters = { ...fx.counters };

    const second = await fx.engine.enrollFresh(fx.target);
    expect(second).toMatchObject({
      code: 'DEPENDENCY_FILE_ALREADY_ENROLLED',
      ok: false,
    });
    expect(fx.journal.operations.size).toBe(1);
    expect(fx.counters).toEqual(counters);
  } finally {
    fx.cleanup();
  }
});

test('fresh enrollment awaits its immutable saved-plan callback before beginning the operation', async () => {
  const fx = await createFixture();
  try {
    let callbackPlan;
    const enrolled = await fx.engine.enrollFresh(fx.target, {
      onPlan: async (plan) => {
        await Promise.resolve();
        callbackPlan = plan;
        expect(Object.isFrozen(plan)).toBe(true);
        expect(fx.journal.plans.get(plan.id)).toEqual(plan);
        expect(fx.journal.operations.size).toBe(0);
        expect(fx.counters).toEqual({
          ensure: 0,
          exchange: 0,
          removeBackup: 0,
          stage: 0,
        });
      },
    });
    expect(enrolled).toMatchObject({ ok: true, state: 'completed' });
    expect(callbackPlan.id).toBe(enrolled.planId);
    expect(fx.journal.operations.size).toBe(1);
  } finally {
    fx.cleanup();
  }
});

test('an ambiguous fresh-enrollment callback failure returns the saved plan and operation identities without beginning', async () => {
  const fx = await createFixture();
  try {
    const enrolled = await fx.engine.enrollFresh(fx.target, {
      onPlan: async (_plan) => {
        await Promise.resolve();
        throw Object.assign(new Error('commit outcome unknown'), {
          code: 'DEPENDENCY_FILE_OPERATION_UNKNOWN',
        });
      },
    });
    expect(enrolled).toMatchObject({
      code: 'DEPENDENCY_FILE_OPERATION_UNKNOWN',
      ok: false,
    });
    expect(enrolled.planId).toMatch(SHA256_PATTERN);
    expect(enrolled.operationId).toBe(enrolled.planId);
    expect(fx.journal.plans.has(enrolled.planId)).toBe(true);
    expect(fx.journal.operations.size).toBe(0);
    expect(fx.counters).toEqual({
      ensure: 0,
      exchange: 0,
      removeBackup: 0,
      stage: 0,
    });
  } finally {
    fx.cleanup();
  }
});

test('real journal recovers a saved plan after the enrollment callback response is lost without changing originals', async () => {
  // The G4 engine and durable G3 journal are real. Native file operations use
  // this suite's labeled filesystem seam; this does not prove helper exchange.
  const fx = await createFixture({ realJournal: true });
  try {
    const original = lstatSync(fx.sourcePath, { bigint: true });
    const lost = await fx.engine.enrollFresh(fx.target, {
      onPlan: async (savedPlan) => {
        expect(await fx.journal.getPlan(savedPlan.id)).toEqual(savedPlan);
        expect(await fx.journal.getOperation(savedPlan.id)).toBeNull();
        throw Object.assign(new Error('plan response was lost'), {
          code: 'DEPENDENCY_FILE_OPERATION_UNKNOWN',
        });
      },
    });
    expect(lost).toMatchObject({
      code: 'DEPENDENCY_FILE_OPERATION_UNKNOWN',
      ok: false,
      operationId: lost.planId,
      planId: lost.planId,
    });
    const plan = await fx.journal.getPlan(lost.planId);
    const [file] = plan.files;
    expect(await fx.journal.getOperation(lost.operationId)).toBeNull();
    expect(lstatSync(fx.sourcePath, { bigint: true }).ino).toBe(original.ino);
    expect(
      lstatSync(join(fx.checkout, file.temporaryRelativePath), {
        throwIfNoEntry: false,
      })
    ).toBeUndefined();
    expect(fx.counters).toEqual({
      ensure: 0,
      exchange: 0,
      removeBackup: 0,
      stage: 0,
    });

    const recovered = await fx.engine.recover(fx.target, {
      operationId: lost.operationId,
    });
    expect(recovered).toMatchObject({
      allFilesPrepared: true,
      files: [{ phase: 'prepared', relativePath: file.relativePath }],
      ok: true,
      operationId: lost.operationId,
      planId: lost.planId,
      resumable: true,
      state: 'partial',
    });
    expect(await fx.journal.getOperation(lost.operationId)).toBeNull();
    expect(lstatSync(fx.sourcePath, { bigint: true }).ino).toBe(original.ino);
    expect(fx.counters).toEqual({
      ensure: 0,
      exchange: 0,
      removeBackup: 0,
      stage: 0,
    });

    const applied = await fx.engine.apply(fx.target, {
      confirmation: lost.planId,
      operationId: lost.operationId,
      planId: lost.planId,
    });
    expect(applied).toMatchObject({ ok: true, state: 'completed' });
    expect(
      lstatSync(join(fx.checkout, file.temporaryRelativePath), {
        bigint: true,
      }).ino
    ).toBe(original.ino);
    expect(fx.counters.exchange).toBe(1);
  } finally {
    fx.cleanup();
  }
});

test('unbegun recovery refuses an unexpected staged entry without guessing or journaling', async () => {
  const fx = await createFixture({ realJournal: true });
  try {
    const lost = await fx.engine.enrollFresh(fx.target, {
      onPlan: () => {
        throw Object.assign(new Error('plan response was lost'), {
          code: 'DEPENDENCY_FILE_OPERATION_UNKNOWN',
        });
      },
    });
    const plan = await fx.journal.getPlan(lost.planId);
    const [file] = plan.files;
    const stagePath = join(fx.checkout, file.temporaryRelativePath);
    writeFileSync(stagePath, 'unexpected staged data\n', { flag: 'wx' });

    const recovered = await fx.engine.recover(fx.target, {
      operationId: lost.operationId,
    });
    expect(recovered).toMatchObject({
      code: 'DEPENDENCY_FILE_CONFLICT',
      ok: false,
      operationId: lost.operationId,
    });
    expect(await fx.journal.getOperation(lost.operationId)).toBeNull();
    expect(readFileSync(stagePath, 'utf8')).toBe('unexpected staged data\n');
    expect(fx.counters).toEqual({
      ensure: 0,
      exchange: 0,
      removeBackup: 0,
      stage: 0,
    });
  } finally {
    fx.cleanup();
  }
});

test('a lost real release-plan save response returns distinct exact operation and release identities', async () => {
  // The durable journal writes the review before the wrapper simulates a lost
  // response. The injected native filesystem remains the labeled OS seam.
  const fx = await createFixture({ realJournal: true });
  try {
    const prepared = await fx.engine.prepare(fx.target);
    const applied = await fx.engine.apply(fx.target, {
      confirmation: prepared.planId,
      operationId: prepared.planId,
      planId: prepared.planId,
    });
    expect(applied.ok).toBe(true);
    const saveReleasePlan = fx.journal.saveReleasePlan.bind(fx.journal);
    fx.journal.saveReleasePlan = async (plan) => {
      await saveReleasePlan(plan);
      throw Object.assign(new Error('release save response was lost'), {
        code: 'JOURNAL_WRITE_UNKNOWN',
      });
    };

    const review = await fx.engine.prepareRelease(fx.target, {
      operationId: prepared.planId,
    });
    expect(review).toMatchObject({
      code: 'JOURNAL_WRITE_UNKNOWN',
      ok: false,
      operationId: prepared.planId,
      planId: prepared.planId,
    });
    expect(review.releaseId).toMatch(SHA256_PATTERN);
    expect(review.releaseId).not.toBe(review.operationId);
    expect((await fx.journal.getReleasePlan(review.releaseId)).id).toBe(
      review.releaseId
    );
  } finally {
    fx.cleanup();
  }
});

test('service mutations hold the native checkout lease around their work (injected OS seam)', async () => {
  const fx = await createFixture();
  try {
    let leaseArgs;
    fx.native.withDependencyFileLease = (...args) => {
      leaseArgs = args.slice(0, 2);
      return args[2]();
    };
    const prepared = await fx.engine.prepare(fx.target);
    expect(prepared.ok).toBe(true);
    expect(leaseArgs).toEqual([fx.store.identity.root, fx.target.wtDir]);
  } finally {
    fx.cleanup();
  }
});

test('internal apply and recovery guard phases are forwarded unchanged', async () => {
  const fx = await createFixture();
  try {
    const prepared = await fx.engine.prepare(fx.target);
    fx.guardPhases.length = 0;
    const applied = await fx.engine.apply(
      fx.target,
      { confirmation: prepared.planId, planId: prepared.planId },
      'enroll-fresh'
    );
    expect(applied.ok).toBe(true);
    expect(new Set(fx.guardPhases)).toEqual(new Set(['enroll-fresh']));

    fx.guardPhases.length = 0;
    const recovered = await fx.engine.recover(
      fx.target,
      { operationId: prepared.planId },
      'enroll-fresh'
    );
    expect(recovered.ok).toBe(true);
    expect(new Set(fx.guardPhases)).toEqual(new Set(['enroll-fresh']));
  } finally {
    fx.cleanup();
  }
});

test('a replaced checkout incarnation refuses the same reviewed plan before mutation', async () => {
  const fx = await createFixture();
  try {
    const prepared = await fx.engine.prepare(fx.target);
    renameSync(fx.checkout, `${fx.checkout}-moved`);
    mkdirSync(fx.checkout, { recursive: true });
    const applied = await fx.engine.apply(fx.target, {
      confirmation: prepared.planId,
      planId: prepared.planId,
    });
    expect(applied).toMatchObject({
      code: 'CHECKOUT_CHANGED',
      ok: false,
      operationId: prepared.planId,
      planId: prepared.planId,
    });
    expect(fx.journal.operations.size).toBe(0);
    expect(fx.counters).toEqual({
      ensure: 0,
      exchange: 0,
      removeBackup: 0,
      stage: 0,
    });
  } finally {
    fx.cleanup();
  }
});
