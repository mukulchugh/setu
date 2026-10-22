/** Recovery contract tests use injected native/store/journal doubles only.
 * They do not verify the shipped helper's atomic exchange implementation.
 */
import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inspectCheckoutIdentity } from './checkout-identity.js';
import { dependencyObjectKey } from './dependency-file-object.js';
import { createDependencyFileSharing } from './dependency-file-sharing.js';

const hash = (value) => createHash('sha256').update(value).digest('hex');
const jsonHash = (value) => hash(JSON.stringify(value));

async function fixture() {
  const root = realpathSync(
    mkdtempSync(join(tmpdir(), 'setu-dependency-file-recovery-'))
  );
  const repoDir = join(root, 'project.git');
  const adminDir = join(repoDir, 'worktrees', 'topic');
  const checkout = join(root, 'workspace', 'project', 'topic');
  const storeRoot = join(root, 'dependency-store');
  const packageDir = join(checkout, 'node_modules', 'fixture-pkg');
  mkdirSync(adminDir, { recursive: true });
  mkdirSync(packageDir, { recursive: true });
  mkdirSync(storeRoot, { mode: 0o700 });
  writeFileSync(join(checkout, '.git'), `gitdir: ${adminDir}\n`);
  writeFileSync(join(adminDir, 'commondir'), '../..\n');
  writeFileSync(join(adminDir, 'gitdir'), `${join(checkout, '.git')}\n`);
  const source = join(packageDir, 'index.js');
  writeFileSync(source, 'export default "recover";\n', { mode: 0o644 });
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
  const timeOverrides = new Map();
  const native = {
    dependencyFileNativeStatus() {
      return { available: true };
    },
    exchangeDependencyFiles(rootPath, targetRelative, stageRelative) {
      const targetPath = join(rootPath, ...targetRelative.split('/'));
      const stagePath = join(rootPath, ...stageRelative.split('/'));
      const temporary = `${targetPath}.test-exchange`;
      // Test-only non-atomic simulation; the actual helper is not executed.
      renameSync(targetPath, temporary);
      renameSync(stagePath, targetPath);
      renameSync(temporary, stagePath);
      return { exchanged: true };
    },
    nativeBinary: '/fixture/native-helper-is-not-run',
    readDependencyFile(rootPath, relativePath) {
      const absolute = join(rootPath, ...relativePath.split('/'));
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
        before.mode % 0o10000n >= 0o1000n
      ) {
        return { eligible: false, reason: 'unsafe fixture file' };
      }
      const bytes = readFileSync(absolute);
      const after = lstatSync(absolute, { bigint: true });
      const contentHash = hash(bytes);
      const time = timeOverrides.get(`${after.dev}:${after.ino}`) ?? {};
      const mode = Number(after.mode % 0o10000n);
      const uid = Number(after.uid);
      const gid = Number(after.gid);
      const mtimeNs = time.mtimeNs ?? String(after.mtimeNs);
      const atimeNs = time.atimeNs ?? String(after.atimeNs);
      const attributes = [];
      const metadataHash = jsonHash({ attributes, gid, mode, mtimeNs, uid });
      const identityHash = jsonHash({
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
    async removeDependencyBackup(rootPath, relativePath, expected) {
      const observed = await this.readDependencyFile(rootPath, relativePath);
      if (
        !(
          observed.eligible &&
          this.sameDependencyFile(expected, observed.fingerprint, {
            identity: true,
          })
        )
      ) {
        throw Object.assign(new Error('backup drift'), {
          code: 'DEPENDENCY_FILE_RELEASE_DRIFT',
        });
      }
      const { unlinkSync } = await import('node:fs');
      unlinkSync(join(rootPath, ...relativePath.split('/')));
      return { removed: true };
    },
    restoreDependencyTimes(rootPath, relativePath, times) {
      const info = lstatSync(join(rootPath, ...relativePath.split('/')), {
        bigint: true,
      });
      timeOverrides.set(`${info.dev}:${info.ino}`, { ...times });
    },
    sameDependencyFile(left, right, { identity = false } = {}) {
      return identity
        ? left?.identityHash === right?.identityHash
        : left?.contentHash === right?.contentHash &&
            left?.metadataHash === right?.metadataHash &&
            left?.size === right?.size;
    },
    syncDependencyDirectory() {
      return { synced: true };
    },
  };
  const plans = new Map();
  const ops = new Map();
  const rows = new Map();
  const releasePlans = new Map();
  const views = new Map();
  let failSwappedBeforeWrite = false;
  let failReleasedBeforeWrite = false;
  const journal = {
    begin(plan) {
      let op = ops.get(plan.id);
      if (!op) {
        op = {
          completedFiles: 0,
          createdAt: 1,
          id: plan.id,
          inputDigest: plan.inputDigest,
          mode: 'hoisted-cow',
          name: plan.name,
          planId: plan.id,
          repo: plan.repo,
          retainedOriginalFiles: 0,
          state: 'prepared',
          storeIdentity: plan.storeIdentity,
          totalFiles: plan.files.length,
          updatedAt: 1,
        };
        ops.set(plan.id, op);
      }
      return structuredClone(op);
    },
    checkpoint(id, index, record) {
      if (record.phase === 'swapped' && failSwappedBeforeWrite) {
        failSwappedBeforeWrite = false;
        throw Object.assign(new Error('checkpoint response lost'), {
          code: 'JOURNAL_WRITE_UNKNOWN',
        });
      }
      if (record.phase === 'released' && failReleasedBeforeWrite) {
        failReleasedBeforeWrite = false;
        throw Object.assign(new Error('release checkpoint response lost'), {
          code: 'JOURNAL_WRITE_UNKNOWN',
        });
      }
      const map = rows.get(id) ?? new Map();
      map.set(index, structuredClone({ ...record, index }));
      rows.set(id, map);
    },
    checkpoints(id) {
      return [...(rows.get(id)?.values() ?? [])].map((row) =>
        structuredClone(row)
      );
    },
    finish(id, patch) {
      const next = { ...ops.get(id), ...structuredClone(patch), updatedAt: 2 };
      ops.set(id, next);
      return structuredClone(next);
    },
    getOperation(id) {
      return structuredClone(ops.get(id) ?? null);
    },
    getPlan(id) {
      return structuredClone(plans.get(id) ?? null);
    },
    getReleasePlan(id) {
      return structuredClone(releasePlans.get(id) ?? null);
    },
    list({ name, repo } = {}) {
      return [...ops.values()].filter(
        (row) => (!name || row.name === name) && (!repo || row.repo === repo)
      );
    },
    loseNextReleasedCheckpoint() {
      failReleasedBeforeWrite = true;
    },
    loseNextSwappedCheckpoint() {
      failSwappedBeforeWrite = true;
    },
    ops,
    rows,
    savePlan(plan) {
      plans.set(plan.id, structuredClone(plan));
    },
    saveReleasePlan(plan) {
      releasePlans.set(plan.id, structuredClone(plan));
    },
    setView(targetValue, summary) {
      views.set(
        `${targetValue.repo}/${targetValue.name}`,
        structuredClone(summary)
      );
    },
  };
  const objectData = new Map();
  const counters = { ensure: 0, exchange: 0, remove: 0, stage: 0 };
  const ensureVersions = [];
  const exchange = native.exchangeDependencyFiles;
  native.exchangeDependencyFiles = (...args) => {
    counters.exchange += 1;
    return exchange(...args);
  };
  const removeBackup = native.removeDependencyBackup;
  native.removeDependencyBackup = (...args) => {
    counters.remove += 1;
    return removeBackup.call(native, ...args);
  };
  const storeIdentity = {
    device: String(lstatSync(storeRoot).dev),
    executable: join(root, 'bun'),
    mountPath: root,
    namespace: 'hoisted/darwin-arm64-bun-1.3.14',
    root: storeRoot,
    version: '1.3.14',
  };
  const store = {
    describe() {
      return { identity: storeIdentity, root: store.root };
    },
    async ensure(fp, rootPath, { version } = {}) {
      counters.ensure += 1;
      ensureVersions.push(version);
      const key = store.objectKey(fp, version);
      const current = await native.readDependencyFile(
        rootPath,
        fp.relativePath
      );
      if (
        !(
          current.eligible &&
          native.sameDependencyFile(fp, current.fingerprint, { identity: true })
        )
      ) {
        throw Object.assign(new Error('source changed'), {
          code: 'DEPENDENCY_FILE_CONFLICT',
        });
      }
      objectData.set(key, readFileSync(join(rootPath, fp.relativePath)));
      const relativePath = `objects/${key.slice(0, 2)}/${key}`;
      return {
        fingerprint: { ...fp, relativePath },
        key,
        relativePath,
      };
    },
    identity: storeIdentity,
    objectKey(fp, version = 2) {
      return dependencyObjectKey(fp, version);
    },
    root: join(storeRoot, ...storeIdentity.namespace.split('/')),
    stage(key, rootPath, relativePath, fp) {
      counters.stage += 1;
      const path = join(rootPath, ...relativePath.split('/'));
      writeFileSync(path, objectData.get(key), { flag: 'wx', mode: fp.mode });
      chmodSync(path, fp.mode);
      return { fingerprint: fp };
    },
    verify(key, fp) {
      return (
        objectData.has(key) &&
        [1, 2].some((version) => key === store.objectKey(fp, version))
      );
    },
  };
  const engine = createDependencyFileSharing({
    assertMutable: async () => true,
    inputs: async (checkoutRoot) => ({
      checkout: checkoutRoot,
      device: lstatSync(checkoutRoot).dev,
      head: 'a'.repeat(40),
      inputDigest: 'c'.repeat(64),
      linker: 'hoisted',
      lockfileHash: 'b'.repeat(64),
      roots: ['node_modules'],
    }),
    journal,
    native,
    now: () => 100,
    randomId: (() => {
      let id = 0;
      return () => {
        id += 1;
        return `recover-${id}`;
      };
    })(),
    sharing: { enabled: true },
    state: { withTargets: async (_targets, work) => work() },
    store,
  });
  return {
    checkout: target.wtDir,
    cleanup: () => rmSync(root, { force: true, recursive: true }),
    counters,
    engine,
    ensureVersions,
    journal,
    source,
    target,
  };
}

test('recover reconciles an exchange whose swapped checkpoint was lost, then apply resumes the same operation without cloning again', async () => {
  const fx = await fixture();
  try {
    const prepared = await fx.engine.prepare(fx.target);
    expect(prepared.plan.version).toBe(2);
    fx.journal.loseNextSwappedCheckpoint();
    const uncertain = await fx.engine.apply(fx.target, {
      confirmation: prepared.planId,
      operationId: prepared.planId,
      planId: prepared.planId,
    });
    expect(uncertain).toMatchObject({
      code: 'JOURNAL_WRITE_UNKNOWN',
      ok: false,
      operationId: prepared.planId,
      planId: prepared.planId,
      state: 'unknown',
    });
    expect(fx.counters).toEqual({
      ensure: 1,
      exchange: 1,
      remove: 0,
      stage: 1,
    });
    expect(fx.ensureVersions).toEqual([2]);

    const recovered = await fx.engine.recover(fx.target, {
      operationId: prepared.planId,
    });
    expect(recovered).toMatchObject({
      ok: true,
      operationId: prepared.planId,
      planId: prepared.planId,
      resumable: true,
      state: 'completed',
    });
    expect((await fx.journal.checkpoints(prepared.planId))[0].phase).toBe(
      'verified'
    );
    const resumed = await fx.engine.apply(fx.target, {
      confirmation: prepared.planId,
      operationId: prepared.planId,
      planId: prepared.planId,
    });
    expect(resumed).toMatchObject({ ok: true, state: 'completed' });
    expect(fx.counters).toEqual({
      ensure: 1,
      exchange: 1,
      remove: 0,
      stage: 1,
    });
    expect(fx.ensureVersions).toEqual([2]);
  } finally {
    fx.cleanup();
  }
});

test('release stops on target drift and leaves the reviewed backup in place', async () => {
  const fx = await fixture();
  try {
    const prepared = await fx.engine.prepare(fx.target);
    const applied = await fx.engine.apply(fx.target, {
      confirmation: prepared.planId,
      planId: prepared.planId,
    });
    expect(applied.ok).toBe(true);
    const review = await fx.engine.prepareRelease(fx.target, {
      operationId: prepared.planId,
    });
    expect(review.ok).toBe(true);
    const [file] = prepared.plan.files;
    const backupPath = join(fx.checkout, file.temporaryRelativePath);
    writeFileSync(join(fx.checkout, file.relativePath), 'target changed\n');
    const result = await fx.engine.release(fx.target, {
      confirmation: review.releaseId,
      releaseId: review.releaseId,
    });
    expect(result).toMatchObject({
      code: 'DEPENDENCY_FILE_RELEASE_DRIFT',
      ok: false,
      releaseId: review.releaseId,
      state: 'completed',
    });
    expect(fx.counters.remove).toBe(0);
    expect(readFileSync(backupPath, 'utf8')).toBe(
      'export default "recover";\n'
    );
  } finally {
    fx.cleanup();
  }
});

test('release intent and identity recover an unlink whose released checkpoint was lost', async () => {
  const fx = await fixture();
  try {
    const prepared = await fx.engine.prepare(fx.target);
    const applied = await fx.engine.apply(fx.target, {
      confirmation: prepared.planId,
      planId: prepared.planId,
    });
    expect(applied.ok).toBe(true);
    const review = await fx.engine.prepareRelease(fx.target, {
      operationId: prepared.planId,
    });
    expect(review.ok).toBe(true);
    const [file] = prepared.plan.files;
    const backupPath = join(fx.checkout, file.temporaryRelativePath);

    fx.journal.loseNextReleasedCheckpoint();
    const uncertain = await fx.engine.release(fx.target, {
      confirmation: review.releaseId,
      releaseId: review.releaseId,
    });
    expect(uncertain).toMatchObject({
      code: 'DEPENDENCY_FILE_OPERATION_UNKNOWN',
      ok: false,
      operationId: prepared.planId,
      planId: prepared.planId,
      releaseId: review.releaseId,
      state: 'unknown',
    });
    expect(fx.counters.remove).toBe(1);
    expect(lstatSync(backupPath, { throwIfNoEntry: false })).toBeUndefined();
    expect((await fx.journal.checkpoints(prepared.planId))[0]).toMatchObject({
      phase: 'verified',
      releasePlanId: review.releaseId,
    });

    const applyAgain = await fx.engine.apply(fx.target, {
      confirmation: prepared.planId,
      planId: prepared.planId,
    });
    expect(applyAgain).toMatchObject({
      code: 'DEPENDENCY_FILE_RELEASE_PENDING',
      ok: false,
      operationId: prepared.planId,
      releaseId: review.releaseId,
    });

    const sameReview = await fx.engine.prepareRelease(fx.target, {
      operationId: prepared.planId,
    });
    expect(sameReview).toMatchObject({
      ok: true,
      releaseId: review.releaseId,
    });
    const recovered = await fx.engine.recover(fx.target, {
      operationId: prepared.planId,
    });
    expect(recovered).toMatchObject({
      ok: true,
      releaseId: review.releaseId,
      state: 'released',
    });
    expect((await fx.journal.checkpoints(prepared.planId))[0]).toMatchObject({
      phase: 'released',
      releasePlanId: review.releaseId,
    });

    const resumed = await fx.engine.release(fx.target, {
      confirmation: review.releaseId,
      releaseId: review.releaseId,
    });
    expect(resumed).toMatchObject({ ok: true, releaseId: review.releaseId });
    expect(fx.counters.remove).toBe(1);
  } finally {
    fx.cleanup();
  }
});
