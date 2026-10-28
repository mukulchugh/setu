import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import {
  existsSync,
  promises as fs,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { inspectCheckoutIdentity } from './checkout-identity.js';
import { createDependencyFileJournal } from './dependency-file-journal.js';
import { createDependencyFileService } from './dependency-file-service.js';
import { observeDependencyInstallInputs } from './dependency-readiness.js';
import { createSetupProgress } from './setup-progress.js';
import {
  createAndInstallWorktree,
  installWorktreeDependencies,
  startWorktreeSetupInstall,
} from './workspace-setup.js';
import { createWorkspaceState } from './workspace-state.js';

async function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'setu-hoisted-setup-')));
  const workspace = join(root, 'workspace');
  const wtDir = join(workspace, 'repo', 'topic');
  const storeRoot = join(root, 'store');
  mkdirSync(wtDir, { recursive: true });
  const repositoryPath = join(root, 'repo.git');
  const adminPath = join(repositoryPath, 'worktrees', 'topic');
  mkdirSync(adminPath, { recursive: true });
  writeFileSync(join(wtDir, '.git'), `gitdir: ${adminPath}\n`);
  writeFileSync(join(adminPath, 'commondir'), `${repositoryPath}\n`);
  writeFileSync(join(adminPath, 'gitdir'), `${join(wtDir, '.git')}\n`);
  mkdirSync(storeRoot, { mode: 0o700 });
  writeFileSync(join(wtDir, 'package.json'), '{}\n');
  writeFileSync(join(wtDir, 'bun.lock'), '{}\n');
  writeFileSync(join(wtDir, 'bunfig.toml'), '[install]\nlinker = "hoisted"\n');
  const executable = join(root, 'bun-fixture');
  writeFileSync(
    executable,
    '#!/bin/sh\nprintf \'["1.3.14","darwin","arm64"]\\n\'\n',
    { mode: 0o700 }
  );
  const target = { name: 'topic', repo: 'repo' };
  let dependencyFiles = { operations: {}, version: 1, views: {} };
  const effects = [];
  let record = null;
  const progress = {
    bindEnrollment: (input) => {
      effects.push(['bind-enrollment', input.dependencyEnrollment]);
      record = { ...record, dependencyEnrollment: input.dependencyEnrollment };
      return { ok: true, record };
    },
    finish: (input) => {
      effects.push(['finish', input.outcome]);
      record = { ...record, ...input, state: input.outcome };
      return { ok: true, record };
    },
    finishEnrollment: (input) => {
      const enrollment = record?.dependencyEnrollment;
      const operation = dependencyFiles.operations[input.operationId];
      const view = dependencyFiles.views[`${target.repo}/${target.name}`];
      if (
        input.attemptId !== record?.attemptId ||
        input.operationId !== enrollment?.operationId ||
        input.operationId !== enrollment?.planId ||
        operation?.state !== 'completed' ||
        view?.state !== 'completed' ||
        operation?.id !== view?.id
      ) {
        return { code: 'SETUP_ENROLLMENT_NOT_COMPLETED', ok: false };
      }
      effects.push(['finish-enrollment', input.operationId]);
      record = {
        ...record,
        ...(input.dependencyReceipt
          ? { dependencyReceipt: input.dependencyReceipt }
          : {}),
        outcome: 'completed',
        state: 'completed',
      };
      return { ok: true, record };
    },
    get: (requested) =>
      requested?.repo === target.repo && requested?.name === target.name
        ? record
        : null,
    stage: (input) => {
      effects.push(['stage', input.stage]);
      record = { ...record, ...input };
      return { ok: true, record };
    },
    start: (input) => {
      record = {
        attemptId: 'setup-attempt-1',
        outcome: null,
        startedAt: 1,
        state: 'running',
        updatedAt: 1,
        ...input,
      };
      effects.push(['start']);
      return { ok: true, record };
    },
  };
  const stateWrites = [];
  const state = {
    read(name) {
      if (name === 'dependencyFiles') {
        return dependencyFiles;
      }
      return {};
    },
    update: (name, change) => {
      stateWrites.push(name);
      return change({});
    },
    withTargets: (_targets, work) => work(),
  };
  const checkoutIdentity = await inspectCheckoutIdentity(
    { repoDir: repositoryPath, wtDir },
    fs
  );
  const sharing = {
    enabled: true,
    executable,
    hoistedStrategy: 'hoisted-cow',
    storeIdentity: {
      device: statSync(storeRoot).dev,
      mountPath: realpathSync(root),
    },
    storeRoot,
    version: '1.3.14',
    workspaceRoot: workspace,
  };
  return {
    checkoutIdentity,
    dispose: () => rmSync(root, { force: true, recursive: true }),
    effects,
    enrollSummary: async () => {
      const id = 'a'.repeat(64);
      if (record?.dependencyEnrollment) {
        const binding = await progress.bindEnrollment({
          attemptId: record.attemptId,
          checkoutIdentity,
          dependencyEnrollment: {
            ...record.dependencyEnrollment,
            operationId: id,
            planId: id,
          },
          target,
        });
        expect(binding).toMatchObject({ ok: true });
      }
      const summary = {
        checkoutIdentity,
        completedFiles: 0,
        createdAt: 1,
        id,
        inputDigest: 'b'.repeat(64),
        logicalCloneBytes: 0,
        mode: 'hoisted-cow',
        name: target.name,
        physicalSavingsBytes: null,
        planId: id,
        repo: target.repo,
        retainedOriginalFiles: 0,
        state: 'completed',
        storeIdentity: {
          device: String(statSync(storeRoot).dev),
          executable,
          mountPath: realpathSync(root),
          namespace: 'hoisted/darwin-arm64-bun-1.3.14',
          root: storeRoot,
          version: '1.3.14',
        },
        totalFiles: 0,
        updatedAt: 1,
        version: 1,
      };
      dependencyFiles = {
        ...dependencyFiles,
        operations: { ...dependencyFiles.operations, [id]: summary },
        views: {
          ...dependencyFiles.views,
          [`${target.repo}/${target.name}`]: summary,
        },
      };
      return summary;
    },
    executable,
    logLocation: join(root, 'setup.log'),
    progress,
    releaseSummary: () => {
      const summary = dependencyFiles.views['repo/topic'];
      const released = {
        ...summary,
        state: 'released',
        updatedAt: summary.updatedAt + 1,
      };
      dependencyFiles = {
        ...dependencyFiles,
        operations: { [released.id]: released },
        views: { 'repo/topic': released },
      };
      return released;
    },
    removeCurrentView: () => {
      const { 'repo/topic': _removed, ...views } = dependencyFiles.views;
      dependencyFiles = { ...dependencyFiles, views };
    },
    removeEnrollmentBinding: () => {
      const { dependencyEnrollment: _removed, ...withoutBinding } = record;
      record = withoutBinding;
    },
    sharing,
    state,
    stateWrites,
    target,
    wtDir,
  };
}

function common(f) {
  return {
    admissionOperationId: 'setup-admission-fixture',
    assertStorage: () => Promise.resolve(),
    assertStoreStorage: () => Promise.resolve(),
    checkoutIdentity: f.checkoutIdentity,
    exists: existsSync,
    logLocation: f.logLocation,
    prepareHoistedDependencySharing: () => ({ ok: true }),
    progress: f.progress,
    sharing: f.sharing,
    state: f.state,
    target: f.target,
  };
}

function canonical(value) {
  if (Array.isArray(value)) {
    return `[${value.map(canonical).join(',')}]`;
  }
  if (value && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function digest(value) {
  return createHash('sha256').update(value).digest('hex');
}

test('synchronous fresh setup enrolls only after the ordinary install and before setup completion', async () => {
  const f = await fixture();
  const originalInstallInputs = await observeDependencyInstallInputs({
    bunVersion: '1.3.14',
    wtDir: f.wtDir,
  });
  const events = [];
  try {
    const result = await installWorktreeDependencies(f.wtDir, {
      ...common(f),
      admissionOperationId: 'admission-install-1',
      finalizeHoistedDependencySharing: async (target, setupContext) => {
        events.push(['finalize', target, setupContext]);
        f.effects.push(['finalize']);
        expect(existsSync(join(f.wtDir, 'node_modules'))).toBe(true);
        expect(setupContext).toEqual({
          admissionOperationId: 'admission-install-1',
          attemptId: 'setup-attempt-1',
          checkoutIdentity: f.checkoutIdentity,
          installerSettled: true,
          target: f.target,
        });
        await f.enrollSummary();
        return {
          ok: true,
          operationId: 'dependency-operation-1',
          state: 'completed',
        };
      },
      prepareHoistedDependencySharing: (target, setupContext) => {
        events.push(['preflight', target, setupContext]);
        expect(setupContext).toEqual({
          admissionOperationId: 'admission-install-1',
          attemptId: 'setup-attempt-1',
          checkoutIdentity: f.checkoutIdentity,
          installerSettled: false,
          target: f.target,
        });
        return { ok: true };
      },
      run: (executable, args, options) => {
        events.push(['install', executable, args, options]);
        expect(executable).toBe(f.executable);
        expect(args).toEqual([
          'install',
          '--frozen-lockfile',
          '--linker',
          'hoisted',
        ]);
        expect(options.env.BUN_INSTALL_GLOBAL_STORE).toBeUndefined();
        mkdirSync(join(f.wtDir, 'node_modules'));
        return { status: 0 };
      },
    });

    expect(result).toEqual({ installed: true });
    expect(events.map(([kind]) => kind)).toEqual([
      'preflight',
      'install',
      'finalize',
    ]);
    expect(events[0][1]).toEqual(f.target);
    expect(f.effects.findIndex(([kind]) => kind === 'finalize')).toBeLessThan(
      f.effects.findIndex(([kind]) => kind === 'finish-enrollment')
    );
    expect(
      f.effects.findIndex(([kind]) => kind === 'bind-enrollment')
    ).toBeLessThan(f.effects.findIndex(([kind]) => kind === 'finalize'));
    expect(f.effects.at(-1)).toEqual(['finish-enrollment', 'a'.repeat(64)]);
    expect(f.progress.get(f.target).dependencyEnrollment).toMatchObject({
      admissionOperationId: 'admission-install-1',
      bunVersion: '1.3.14',
      installerSettled: true,
      version: 1,
    });
    expect(f.progress.get(f.target).dependencyEnrollment.installInputs).toEqual(
      originalInstallInputs.inputs
    );
    expect(f.progress.get(f.target).dependencyReceipt).toMatchObject({
      bunVersion: '1.3.14',
      dependencyFiles: { id: 'a'.repeat(64), state: 'completed' },
      outcome: 'completed',
    });
    expect(
      f.progress.get(f.target).dependencyReceipt.installInputs
    ).toBeUndefined();
    expect(f.stateWrites).toEqual([]);
  } finally {
    f.dispose();
  }
});

// The G6 service is real; its injected engine is only an orchestration seam,
// so this test does not claim native clone or exchange coverage.
test('fresh setup composes through the real G6 service and native status seam', async () => {
  const f = await fixture();
  const serviceTarget = {
    checkoutIdentity: f.checkoutIdentity,
    key: 'repo/topic',
    name: 'topic',
    repo: 'repo',
    wtDir: f.wtDir,
  };
  const native = {
    dependencyFileNativeStatus: () => Promise.resolve({ available: true }),
  };
  const service = createDependencyFileService({
    assertMutable: (_target, details) => {
      expect(details.setupContext).toEqual({
        admissionOperationId: 'setup-admission-real-service',
        attemptId: 'setup-attempt-1',
        checkoutIdentity: serviceTarget.checkoutIdentity,
        installerSettled: true,
        target: f.target,
      });
      return { ok: true };
    },
    config: () => ({
      dependencySharing: {
        enabled: true,
        executable: f.executable,
        hoistedStrategy: 'hoisted-cow',
        storeRoot: f.sharing.storeRoot,
        targets: { 'repo/topic': true },
        version: '1.3.14',
      },
      workspace: f.sharing.workspaceRoot,
    }),
    engineFactory: ({ native: receivedNative }) => {
      expect(receivedNative).toBe(native);
      return {
        apply: () => Promise.resolve({ ok: true }),
        enrollFresh: async (_target, { onPlan }) => {
          await onPlan({ id: 'a'.repeat(64) });
          await f.enrollSummary();
          return {
            ok: true,
            operationId: 'a'.repeat(64),
            state: 'completed',
          };
        },
        prepare: () => Promise.resolve({ ok: true }),
        prepareRelease: () => Promise.resolve({ ok: true }),
        recover: () => Promise.resolve({ ok: true }),
        release: () => Promise.resolve({ ok: true }),
        status: async () => ({
          native: await receivedNative.dependencyFileNativeStatus(),
          ok: true,
        }),
      };
    },
    native,
    randomId: () => 'operation-id',
    resolveTarget: () => Promise.resolve(serviceTarget),
    setupProgress: f.progress,
    state: { withTargets: (_targets, work) => work() },
  });
  try {
    const result = await installWorktreeDependencies(f.wtDir, {
      ...common(f),
      admissionOperationId: 'setup-admission-real-service',
      checkoutIdentity: serviceTarget.checkoutIdentity,
      finalizeHoistedDependencySharing: (target, setupContext) =>
        service.enrollFresh(target, setupContext),
      prepareHoistedDependencySharing: async (target) => {
        const status = await service.status({ ...serviceTarget, ...target });
        return status.native?.available ? { ok: true } : status;
      },
      run: () => {
        mkdirSync(join(f.wtDir, 'node_modules'));
        return { status: 0 };
      },
    });
    expect(result).toEqual({ installed: true });
    expect(f.progress.get(f.target)).toMatchObject({ state: 'completed' });
  } finally {
    f.dispose();
  }
});

// Real G10 progress and G3 journal factories prove that setup completion is
// bound to the journal's operation and current view. The finalizer supplies an
// explicit filesystem/native-action seam; this does not prove clone/exchange.
test('hoisted setup finishes through the bound real journal operation', async () => {
  const f = await fixture();
  const workspace = f.sharing.workspaceRoot;
  const state = createWorkspaceState({
    configPath: join(dirname(workspace), 'setu.json'),
    setuDir: dirname(workspace),
    workspaceRoot: workspace,
  });
  const progress = createSetupProgress({
    newAttemptId: () => 'real-journal-setup-attempt',
    now: () => 20,
    state,
  });
  const journal = createDependencyFileJournal({
    now: () => 20,
    randomId: () => 'real-journal-random',
    state,
    storeRoot: f.sharing.storeRoot,
  });

  try {
    const result = await installWorktreeDependencies(f.wtDir, {
      admissionOperationId: 'real-journal-admission',
      assertStorage: () => Promise.resolve(),
      assertStoreStorage: () => Promise.resolve(),
      checkoutIdentity: f.checkoutIdentity,
      exists: existsSync,
      finalizeHoistedDependencySharing: async (target) => {
        const plan = {
          checkoutIdentity: f.checkoutIdentity,
          createdAt: 20,
          files: [],
          head: 'a'.repeat(40),
          id: '',
          inputDigest: digest('real-journal-inputs'),
          lockfileHash: digest('real-journal-lockfile'),
          logicalCloneBytes: 0,
          mode: 'hoisted-cow',
          name: target.name,
          physicalSavingsBytes: null,
          repo: target.repo,
          skipped: [],
          storeIdentity: {
            device: String(statSync(f.sharing.storeRoot).dev),
            executable: f.executable,
            mountPath: realpathSync(dirname(workspace)),
            namespace: 'hoisted/darwin-arm64-bun-1.3.14',
            root: f.sharing.storeRoot,
            version: '1.3.14',
          },
          version: 1,
        };
        plan.id = digest(
          canonical(
            Object.fromEntries(
              Object.entries(plan).filter(
                ([key]) => !['id', 'createdAt'].includes(key)
              )
            )
          )
        );
        await journal.savePlan(plan);
        const bound = progress.get(f.target);
        const binding = await progress.bindEnrollment({
          attemptId: bound.attemptId,
          checkoutIdentity: f.checkoutIdentity,
          dependencyEnrollment: {
            ...bound.dependencyEnrollment,
            operationId: plan.id,
            planId: plan.id,
          },
          target: f.target,
        });
        expect(binding.ok).toBe(true);
        await journal.begin(plan);
        await journal.finish(plan.id, { state: 'running' });
        const summary = await journal.finish(plan.id, { state: 'completed' });
        await journal.setView(f.target, summary);
        return { ...summary, ok: true };
      },
      logLocation: join(dirname(workspace), 'real-journal-setup.log'),
      prepareHoistedDependencySharing: () => ({ ok: true }),
      progress,
      run: () => {
        mkdirSync(join(f.wtDir, 'node_modules'));
        return { status: 0 };
      },
      sharing: f.sharing,
      state,
      target: f.target,
    });

    expect(result).toEqual({ installed: true });
    expect(progress.get(f.target)).toMatchObject({
      dependencyEnrollment: {
        operationId: progress.get(f.target).dependencyEnrollment.planId,
        planId: expect.any(String),
      },
      state: 'completed',
    });
    expect(progress.get(f.target).dependencyReceipt.dependencyFiles).toEqual(
      state.read('dependencyFiles').views['repo/topic']
    );
    expect(
      state.read('dependencyFiles').operations[
        progress.get(f.target).dependencyEnrollment.operationId
      ]
    ).toMatchObject({ state: 'completed' });
  } finally {
    f.dispose();
  }
});

test('completed hoisted setup stays ready after legitimate original release', async () => {
  const f = await fixture();
  try {
    const install = await installWorktreeDependencies(f.wtDir, {
      ...common(f),
      finalizeHoistedDependencySharing: async () => {
        await f.enrollSummary();
        return {
          ok: true,
          operationId: 'dependency-operation-release',
          state: 'completed',
        };
      },
      run: () => {
        mkdirSync(join(f.wtDir, 'node_modules'));
        return { status: 0 };
      },
    });
    expect(install).toEqual({ installed: true });
    const completed = f.state.read('dependencyFiles').views['repo/topic'];
    expect(completed.state).toBe('completed');
    f.removeEnrollmentBinding();
    f.releaseSummary();
    const result = await createAndInstallWorktree({
      checkoutIdentity: async () => f.checkoutIdentity,
      create: async () => ({ wtDir: f.wtDir }),
      install: () => {
        throw new Error('completed setup must not reinstall');
      },
      logLocation: f.logLocation,
      name: f.target.name,
      operationId: 'setup-admission-fixture',
      progress: f.progress,
      repo: f.target.repo,
      state: f.state,
    });
    expect(result).toMatchObject({ setup: 'ready' });
    f.removeCurrentView();
    const missingView = await createAndInstallWorktree({
      checkoutIdentity: async () => f.checkoutIdentity,
      create: async () => ({ wtDir: f.wtDir }),
      install: () => {
        throw new Error('completed setup must not reinstall');
      },
      logLocation: f.logLocation,
      name: f.target.name,
      operationId: 'setup-admission-fixture',
      progress: f.progress,
      repo: f.target.repo,
      state: f.state,
    });
    expect(missingView).toMatchObject({ setup: 'unverified' });
  } finally {
    f.dispose();
  }
});

test('no-dependency setup stores a valid readiness receipt', async () => {
  const f = await fixture();
  try {
    rmSync(join(f.wtDir, 'package.json'));
    rmSync(join(f.wtDir, 'bun.lock'));
    const result = await installWorktreeDependencies(f.wtDir, common(f));
    expect(result).toEqual({ installed: false });
    expect(f.progress.get(f.target)).toMatchObject({
      dependencyReceipt: { outcome: 'completed' },
      outcome: 'completed',
      state: 'completed',
    });
  } finally {
    f.dispose();
  }
});

test('Python setup has no Bun receipt and receipt failure preserves known install outcome', async () => {
  const python = await fixture();
  try {
    rmSync(join(python.wtDir, 'package.json'));
    rmSync(join(python.wtDir, 'bun.lock'));
    writeFileSync(
      join(python.wtDir, 'pyproject.toml'),
      '[project]\nname="fixture"\n'
    );
    const result = await installWorktreeDependencies(python.wtDir, {
      ...common(python),
      run: () => ({ status: 0 }),
    });
    expect(result).toEqual({ installed: true });
    expect(python.progress.get(python.target)).toMatchObject({
      outcome: 'completed',
      state: 'completed',
    });
    expect(
      python.progress.get(python.target).dependencyReceipt
    ).toBeUndefined();
  } finally {
    python.dispose();
  }

  const failedReceipt = await fixture();
  try {
    const result = await installWorktreeDependencies(failedReceipt.wtDir, {
      ...common(failedReceipt),
      run: () => {
        writeFileSync(
          join(failedReceipt.wtDir, 'bun.lock'),
          '{"changed":true}\n'
        );
        mkdirSync(join(failedReceipt.wtDir, 'node_modules'));
        return { status: 0 };
      },
      sharing: { enabled: false },
    });
    expect(result).toEqual({ installed: true });
    expect(failedReceipt.progress.get(failedReceipt.target)).toMatchObject({
      outcome: 'completed',
      state: 'completed',
    });
    expect(
      failedReceipt.progress.get(failedReceipt.target).dependencyReceipt
    ).toBeUndefined();
  } finally {
    failedReceipt.dispose();
  }
});

test('missing unified enrollment fails before running install scripts', async () => {
  const f = await fixture();
  let installs = 0;
  try {
    await expect(
      installWorktreeDependencies(f.wtDir, {
        ...common(f),
        run: () => {
          installs += 1;
          return { status: 0 };
        },
      })
    ).rejects.toMatchObject({ code: 'DEPENDENCY_ENROLLMENT_UNAVAILABLE' });
    expect(installs).toBe(0);
    expect(f.progress.get(f.target)).toMatchObject({
      outcome: 'failed',
      state: 'failed',
    });
    expect(f.stateWrites).toEqual([]);
  } finally {
    f.dispose();
  }
});

test('missing enrollment preflight fails closed before running install scripts', async () => {
  const f = await fixture();
  let installs = 0;
  try {
    await expect(
      installWorktreeDependencies(f.wtDir, {
        ...common(f),
        finalizeHoistedDependencySharing: () => ({ ok: true }),
        prepareHoistedDependencySharing: undefined,
        run: () => {
          installs += 1;
          return { status: 0 };
        },
      })
    ).rejects.toMatchObject({ code: 'DEPENDENCY_ENROLLMENT_UNAVAILABLE' });
    expect(installs).toBe(0);
    expect(f.progress.get(f.target)).toMatchObject({ state: 'failed' });
  } finally {
    f.dispose();
  }
});

test('missing durable enrollment binding fails before running install scripts', async () => {
  const f = await fixture();
  let installs = 0;
  try {
    f.progress.bindEnrollment = undefined;
    await expect(
      installWorktreeDependencies(f.wtDir, {
        ...common(f),
        finalizeHoistedDependencySharing: () => ({
          ok: true,
          state: 'completed',
        }),
        run: () => {
          installs += 1;
          return { status: 0 };
        },
      })
    ).rejects.toMatchObject({
      code: 'DEPENDENCY_ENROLLMENT_BINDING_UNAVAILABLE',
    });
    expect(installs).toBe(0);
    expect(f.progress.get(f.target)).toMatchObject({ state: 'failed' });
  } finally {
    f.dispose();
  }
});

test('uncertain durable binding preserves unknown setup and never reruns scripts', async () => {
  const f = await fixture();
  let installs = 0;
  let finalizations = 0;
  try {
    f.progress.bindEnrollment = () => ({
      code: 'JOURNAL_WRITE_UNKNOWN',
      error: 'binding response was lost',
      ok: false,
    });
    await expect(
      installWorktreeDependencies(f.wtDir, {
        ...common(f),
        finalizeHoistedDependencySharing: () => {
          finalizations += 1;
          return { ok: true, state: 'completed' };
        },
        run: () => {
          installs += 1;
          mkdirSync(join(f.wtDir, 'node_modules'));
          return { status: 0 };
        },
      })
    ).rejects.toMatchObject({ code: 'OPERATION_UNKNOWN' });
    expect(installs).toBe(1);
    expect(finalizations).toBe(0);
    expect(f.progress.get(f.target)).toMatchObject({
      outcome: 'unknown',
      stage: 'dependency-enrollment-unknown',
      state: 'unknown',
    });
  } finally {
    f.dispose();
  }
});

test('uncertain enrollment keeps setup unknown with the original operation identity', async () => {
  const f = await fixture();
  let installs = 0,
    finalizations = 0;
  try {
    await expect(
      installWorktreeDependencies(f.wtDir, {
        ...common(f),
        finalizeHoistedDependencySharing: () => {
          finalizations += 1;
          return {
            code: 'DEPENDENCY_FILE_OPERATION_UNKNOWN',
            error: 'The durable operation needs reconciliation',
            ok: false,
            operationId: 'dependency-operation-unknown',
            state: 'unknown',
          };
        },
        run: () => {
          installs += 1;
          mkdirSync(join(f.wtDir, 'node_modules'));
          return { status: 0 };
        },
      })
    ).rejects.toMatchObject({
      code: 'OPERATION_UNKNOWN',
      recovery: {
        dependencySharing: {
          code: 'DEPENDENCY_FILE_OPERATION_UNKNOWN',
          operationId: 'dependency-operation-unknown',
          state: 'unknown',
        },
      },
    });
    expect(installs).toBe(1);
    expect(finalizations).toBe(1);
    expect(f.progress.get(f.target)).toMatchObject({
      outcome: 'unknown',
      stage: 'dependency-enrollment-unknown:dependency-operation-unknown',
      state: 'unknown',
    });
    expect(f.stateWrites).toEqual([]);
    await expect(
      installWorktreeDependencies(f.wtDir, {
        ...common(f),
        finalizeHoistedDependencySharing: () => {
          finalizations += 1;
          return { ok: true, operationId: 'different-operation' };
        },
        run: () => {
          installs += 1;
          return { status: 0 };
        },
      })
    ).rejects.toMatchObject({
      code: 'DEPENDENCY_ENROLLMENT_RECONCILIATION_REQUIRED',
      recovery: {
        dependencySharing: {
          operationId: 'dependency-operation-unknown',
          setupId: 'setup-attempt-1',
        },
      },
    });
    expect(installs).toBe(1);
    expect(finalizations).toBe(1);
  } finally {
    f.dispose();
  }
});

test('uncertain enrollment-stage persistence never retries installer scripts', async () => {
  const f = await fixture();
  const { stage } = f.progress;
  let installs = 0;
  let finalizations = 0;
  f.progress.stage = (input) => {
    if (input.stage === 'dependency-enrollment') {
      throw Object.assign(new Error('setup stage response was lost'), {
        code: 'JOURNAL_WRITE_UNKNOWN',
      });
    }
    return stage(input);
  };
  try {
    await expect(
      installWorktreeDependencies(f.wtDir, {
        ...common(f),
        finalizeHoistedDependencySharing: () => {
          finalizations += 1;
          return { ok: true, state: 'completed' };
        },
        run: () => {
          installs += 1;
          mkdirSync(join(f.wtDir, 'node_modules'));
          return { status: 0 };
        },
      })
    ).rejects.toMatchObject({ code: 'OPERATION_UNKNOWN' });
    expect(installs).toBe(1);
    expect(finalizations).toBe(0);
    expect(f.progress.get(f.target)).toMatchObject({
      outcome: 'unknown',
      stage: 'dependency-enrollment-unknown',
      state: 'unknown',
    });
  } finally {
    f.dispose();
  }
});

test('a queued enrollment response cannot mark fresh setup ready', async () => {
  const f = await fixture();
  try {
    await expect(
      installWorktreeDependencies(f.wtDir, {
        ...common(f),
        finalizeHoistedDependencySharing: () => ({
          ok: true,
          position: 1,
          queued: true,
        }),
        run: () => {
          mkdirSync(join(f.wtDir, 'node_modules'));
          return { status: 0 };
        },
      })
    ).rejects.toMatchObject({ code: 'OPERATION_UNKNOWN' });
    expect(f.progress.get(f.target)).toMatchObject({
      outcome: 'unknown',
      state: 'unknown',
    });
  } finally {
    f.dispose();
  }
});

test('an unconfirmed success envelope cannot mark fresh setup ready', async () => {
  const f = await fixture();
  try {
    await expect(
      installWorktreeDependencies(f.wtDir, {
        ...common(f),
        finalizeHoistedDependencySharing: () => ({ ok: true }),
        run: () => {
          mkdirSync(join(f.wtDir, 'node_modules'));
          return { status: 0 };
        },
      })
    ).rejects.toMatchObject({
      code: 'OPERATION_UNKNOWN',
      recovery: {},
    });
    expect(f.progress.get(f.target)).toMatchObject({
      outcome: 'unknown',
      stage: 'dependency-enrollment-unknown',
      state: 'unknown',
    });
  } finally {
    f.dispose();
  }
});

test('existing hoisted roots are refused before installation or finalization', async () => {
  const f = await fixture();
  const nodeModules = join(f.wtDir, 'node_modules');
  mkdirSync(nodeModules);
  writeFileSync(join(nodeModules, 'keep.txt'), 'ordinary existing view\n');
  let installs = 0,
    finalizations = 0;
  try {
    await expect(
      installWorktreeDependencies(f.wtDir, {
        ...common(f),
        finalizeHoistedDependencySharing: () => {
          finalizations += 1;
          return { ok: true };
        },
        run: () => {
          installs += 1;
          return { status: 0 };
        },
      })
    ).rejects.toMatchObject({ code: 'DEPENDENCY_VIEW_UNSAFE' });
    expect(installs).toBe(0);
    expect(finalizations).toBe(0);
    expect(f.progress.get(f.target)).toMatchObject({ state: 'failed' });
    expect(existsSync(join(nodeModules, 'keep.txt'))).toBe(true);
    expect(f.stateWrites).toEqual([]);
  } finally {
    f.dispose();
  }
});

test('portal setup waits for owned process-group settlement before hoisted enrollment and readiness', async () => {
  const f = await fixture();
  const context = {
    ready: false,
    res: {
      localDom: 'topic.setu.local',
      port: 3301,
      wtDir: f.wtDir,
    },
  };
  const events = [];
  const { bindEnrollment } = f.progress;
  f.progress.bindEnrollment = (input) => {
    events.push(['bind-enrollment', input]);
    return bindEnrollment(input);
  };
  let finish;
  const exited = new Promise((resolve) => {
    finish = resolve;
  });
  try {
    const pending = await startWorktreeSetupInstall(context, {
      ...common(f),
      admissionOperationId: 'portal-lease-operation',
      closeLog: () => events.push(['close-log']),
      finalizeHoistedDependencySharing: async (target, setupContext) => {
        events.push(['finalize', target, setupContext]);
        f.effects.push(['finalize']);
        expect(context.ready).toBe(false);
        expect(setupContext).toEqual({
          admissionOperationId: 'portal-lease-operation',
          attemptId: 'setup-attempt-1',
          checkoutIdentity: f.checkoutIdentity,
          installerSettled: true,
          target: f.target,
        });
        await f.enrollSummary();
        return {
          ok: true,
          operationId: 'dependency-operation-portal',
          state: 'completed',
        };
      },
      openLog: () => 7,
      spawn: (argv, options) => {
        events.push(['spawn', argv, options]);
        return {
          exited,
          pid: 712,
          setupOwnerId: 'owned-setup-712',
        };
      },
      stopProcess: (owner) => {
        events.push(['stop', owner]);
      },
    });
    expect(context.ready).toBe(false);
    expect(pending.result).toMatchObject({ ok: true, setup: 'installing' });
    expect(events.find(([kind]) => kind === 'spawn')?.[1]).toEqual([
      f.executable,
      'install',
      '--frozen-lockfile',
      '--linker',
      'hoisted',
    ]);
    expect(
      events.find(([kind]) => kind === 'spawn')?.[2].env
        .BUN_INSTALL_GLOBAL_STORE
    ).toBeUndefined();

    mkdirSync(join(f.wtDir, 'node_modules'));
    finish(0);
    await pending.completion;

    expect(events.find(([kind]) => kind === 'stop')?.[1]).toEqual({
      ownedGroup: true,
      pid: 712,
      setupOwnerId: 'owned-setup-712',
    });
    const kinds = events.map(([kind]) => kind);
    expect(kinds.indexOf('stop')).toBeLessThan(kinds.indexOf('finalize'));
    expect(kinds.indexOf('stop')).toBeLessThan(
      kinds.indexOf('bind-enrollment')
    );
    expect(kinds.indexOf('bind-enrollment')).toBeLessThan(
      kinds.indexOf('finalize')
    );
    expect(
      events.find(([kind]) => kind === 'bind-enrollment')?.[1]
    ).toMatchObject({
      dependencyEnrollment: {
        admissionOperationId: 'portal-lease-operation',
        bunVersion: '1.3.14',
        installerSettled: true,
      },
    });
    expect(f.effects.findIndex(([kind]) => kind === 'finalize')).toBeLessThan(
      f.effects.findIndex(([kind]) => kind === 'finish-enrollment')
    );
    expect(f.effects.at(-1)).toEqual(['finish-enrollment', 'a'.repeat(64)]);
    expect(context.ready).toBe(true);
    expect(f.stateWrites).toEqual([]);
  } finally {
    finish?.(0);
    f.dispose();
  }
});
