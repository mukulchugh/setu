import { afterEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  createDependencyReceipt,
  dependencyInstallInputsMatch,
  inspectDependencyReadiness,
  observeDependencyInputs,
  observeDependencyInstallInputs,
  validateDependencyReceipt,
} from './dependency-readiness.js';

const fixtures = new Set();

function statIdentity(path) {
  const info = lstatSync(path, { bigint: true });
  return {
    birthtimeNs: String(info.birthtimeNs),
    dev: String(info.dev),
    ino: String(info.ino),
  };
}

function createFixture({
  bunfig,
  lock = '{}',
  manifest = {
    dependencies: { 'fixture-package': '^1.0.0' },
    name: 'readiness-fixture',
    version: '1.0.0',
  },
  packages = {
    'fixture-package': { name: 'fixture-package', version: '1.2.0' },
  },
} = {}) {
  const base = realpathSync(
    mkdtempSync(join(tmpdir(), 'setu-readiness-test-'))
  );
  fixtures.add(base);
  const wtDir = join(base, 'checkout');
  mkdirSync(wtDir);
  writeFileSync(join(wtDir, 'package.json'), JSON.stringify(manifest));
  if (lock !== null) {
    writeFileSync(join(wtDir, 'bun.lock'), lock);
  }
  if (bunfig !== undefined) {
    writeFileSync(join(wtDir, 'bunfig.toml'), bunfig);
  }
  for (const [directory, packageManifest] of Object.entries(packages)) {
    const packagePath = join(wtDir, 'node_modules', directory);
    mkdirSync(packagePath, { recursive: true });
    writeFileSync(
      join(packagePath, 'package.json'),
      JSON.stringify(packageManifest)
    );
  }
  const baseIdentity = statIdentity(base);
  const identity = {
    admin: baseIdentity,
    adminPath: base,
    checkout: statIdentity(wtDir),
    checkoutPath: realpathSync(wtDir),
    known: true,
    repository: baseIdentity,
    repositoryPath: base,
  };
  return { base, identity, wtDir };
}

function disposeFixtures() {
  for (const path of fixtures) {
    rmSync(path, { force: true, recursive: true });
  }
  fixtures.clear();
}

function receiptFor(f, extra = {}) {
  return createDependencyReceipt({
    attemptId: 'setup-attempt-1',
    checkoutIdentity: f.identity,
    wtDir: f.wtDir,
    ...extra,
  });
}

function recordFor(f, receipt) {
  return {
    attemptId: receipt.attemptId,
    checkoutIdentity: f.identity,
    dependencyReceipt: receipt,
    outcome: 'completed',
    state: 'completed',
  };
}

function packageJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(value));
}

function bunLockHash(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

afterEach(disposeFixtures);

describe('dependency readiness evidence', () => {
  test('covers root and workspace manifests, direct packages, npm aliases and internal workspace links', async () => {
    const f = createFixture({
      manifest: {
        dependencies: {
          '@fixture/shared': 'workspace:*',
          'fixture-package': '^1.0.0',
        },
        name: 'readiness-root',
        version: '1.0.0',
        workspaces: ['packages/*'],
      },
      packages: {
        'fixture-package': {
          name: 'fixture-package',
          version: '1.2.0',
        },
      },
    });
    const workspace = join(f.wtDir, 'packages', 'shared');
    packageJson(join(workspace, 'package.json'), {
      dependencies: { 'fixture-alias': 'npm:real-fixture@^3.0.0' },
      name: '@fixture/shared',
      version: '2.0.0',
    });
    mkdirSync(join(f.wtDir, 'node_modules', '@fixture'), { recursive: true });
    symlinkSync(workspace, join(f.wtDir, 'node_modules', '@fixture', 'shared'));
    const alias = join(f.wtDir, 'node_modules', 'fixture-alias');
    mkdirSync(alias, { recursive: true });
    packageJson(join(alias, 'package.json'), {
      name: 'real-fixture',
      version: '3.2.0',
    });

    const observed = await observeDependencyInputs({ wtDir: f.wtDir });
    expect(observed.ok).toBe(true);
    expect(observed.inputs.dependencyCount).toBe(3);
    expect(observed.inputs.workspaceCount).toBe(1);
    expect(observed.inputs.installMode).toBe('private');
    expect(observed.inputs.noDependencies).toBe(false);
    expect(
      observed.inputs.files.filter((row) => row.role === 'manifest').length
    ).toBe(2);
    expect(
      observed.inputs.view.every((row) => row.status === 'installed')
    ).toBe(true);

    const made = await receiptFor(f, { inputs: observed.inputs });
    expect(made.ok).toBe(true);
    expect(validateDependencyReceipt(made.receipt)).toBe(true);
    const ready = await inspectDependencyReadiness({
      checkoutIdentity: f.identity,
      record: recordFor(f, made.receipt),
      wtDir: f.wtDir,
    });
    expect(ready.ok).toBe(true);
    expect(ready.state).toBe('ready');
    expect(ready.identity.version).toBe(1);
    expect(ready.identity.inputDigest).toBe(made.receipt.inputDigest);
  });

  test('accepts an explicit zero-dependency receipt without inventing a lock hash', async () => {
    const f = createFixture({
      lock: null,
      manifest: { name: 'empty-project', version: '1.0.0' },
      packages: {},
    });
    const observed = await observeDependencyInputs({ wtDir: f.wtDir });
    expect(observed.ok).toBe(true);
    expect(observed.inputs.noDependencies).toBe(true);
    expect(observed.inputs.dependencyCount).toBe(0);
    expect(observed.inputs.view.length).toBe(0);
    expect(
      observed.inputs.files.filter((row) => row.role === 'lock').length
    ).toBe(6);
    expect(
      observed.inputs.files
        .filter((row) => row.role === 'lock')
        .every((row) => row.present === false && row.sha256 === null)
    ).toBe(true);

    const made = await receiptFor(f, { inputs: observed.inputs });
    expect(made.ok).toBe(true);
    const ready = await inspectDependencyReadiness({
      checkoutIdentity: f.identity,
      record: recordFor(f, made.receipt),
      wtDir: f.wtDir,
    });
    expect(ready.ok).toBe(true);

    const noManifest = createFixture({
      lock: null,
      manifest: null,
      packages: {},
    });
    rmSync(join(noManifest.wtDir, 'package.json'));
    const noProject = await observeDependencyInputs({
      wtDir: noManifest.wtDir,
    });
    expect(noProject.ok).toBe(true);
    expect(noProject.inputs.noDependencies).toBe(true);
    expect(
      noProject.inputs.files.some(
        (row) => row.role === 'manifest' && row.present === false
      )
    ).toBe(true);
  });

  test('permits a private hoisted view and records the configured linker', async () => {
    const f = createFixture({ bunfig: '[install]\nlinker = "hoisted"\n' });
    const observed = await observeDependencyInputs({ wtDir: f.wtDir });
    expect(observed.ok).toBe(true);
    expect(observed.inputs.linkerMode).toBe('hoisted');
    expect(observed.inputs.installMode).toBe('private');
  });

  test('binds a hoisted readiness receipt to the enrolled dependencyFiles view', async () => {
    const f = createFixture({ bunfig: '[install]\nlinker = "hoisted"\n' });
    const view = {
      checkoutIdentity: f.identity,
      completedFiles: 1,
      createdAt: 1,
      id: 'a'.repeat(64),
      inputDigest: 'b'.repeat(64),
      logicalCloneBytes: 128,
      mode: 'hoisted-cow',
      name: 'topic',
      physicalSavingsBytes: null,
      planId: 'a'.repeat(64),
      repo: 'fixture',
      retainedOriginalFiles: 1,
      state: 'completed',
      storeIdentity: {
        device: String(lstatSync(f.base, { bigint: true }).dev),
        executable: join(f.base, 'bun'),
        mountPath: f.base,
        namespace: 'hoisted/darwin-arm64-bun-1.3.14',
        root: join(f.base, 'private-store'),
        version: '1.3.14',
      },
      totalFiles: 1,
      updatedAt: 2,
      version: 1,
    };
    let document = {
      operations: { [view.id]: view },
      version: 1,
      views: { 'fixture/topic': view },
    };
    const state = {
      read: (key) => (key === 'dependencyFiles' ? document : {}),
    };
    const made = await receiptFor(f, { dependencyFiles: view, state });
    expect(made.ok).toBe(true);
    expect(made.receipt.inputs.installMode).toBe('private');
    expect(made.receipt.inputs.sharedConsumerDigest).toBeNull();
    expect(made.receipt.dependencyFiles).toEqual(view);
    expect(validateDependencyReceipt(made.receipt)).toBe(true);

    const record = recordFor(f, made.receipt);
    const ready = await inspectDependencyReadiness({
      checkoutIdentity: f.identity,
      dependencyFiles: view,
      record,
      state,
      wtDir: f.wtDir,
    });
    expect(ready.ok).toBe(true);
    expect(ready.state).toBe('ready');

    const missingEnrollment = await inspectDependencyReadiness({
      checkoutIdentity: f.identity,
      record,
      wtDir: f.wtDir,
    });
    expect(missingEnrollment).toMatchObject({
      code: 'DEPENDENCY_VIEW_UNKNOWN',
      ok: false,
    });
    const changedView = { ...view, completedFiles: 0 };
    const changedEnrollment = await inspectDependencyReadiness({
      checkoutIdentity: f.identity,
      dependencyFiles: changedView,
      record,
      state,
      wtDir: f.wtDir,
    });
    expect(changedEnrollment).toMatchObject({
      code: 'DEPENDENCY_VIEW_UNKNOWN',
      ok: false,
    });
    document = { ...document, views: {} };
    expect(ready.checkCurrent()).toBe(false);
    expect(
      await receiptFor(f, {
        dependencyFiles: { ...view, state: 'running' },
        state,
      })
    ).toMatchObject({ code: 'DEPENDENCY_VIEW_UNKNOWN', ok: false });
  });

  test('keeps a real completed receipt ready after the authoritative enrollment is legitimately released', async () => {
    const f = createFixture({ bunfig: '[install]\nlinker = "hoisted"\n' });
    const view = {
      checkoutIdentity: f.identity,
      completedFiles: 1,
      createdAt: 1,
      id: 'e'.repeat(64),
      inputDigest: 'f'.repeat(64),
      logicalCloneBytes: 128,
      mode: 'hoisted-cow',
      name: 'topic',
      physicalSavingsBytes: null,
      planId: 'e'.repeat(64),
      repo: 'fixture',
      retainedOriginalFiles: 1,
      state: 'completed',
      storeIdentity: {
        device: String(lstatSync(f.base, { bigint: true }).dev),
        executable: join(f.base, 'bun'),
        mountPath: f.base,
        namespace: 'hoisted/darwin-arm64-bun-1.3.14',
        root: join(f.base, 'private-store'),
        version: '1.3.14',
      },
      totalFiles: 1,
      updatedAt: 2,
      version: 1,
    };
    let current = view;
    let operation = view;
    const state = {
      read: (key) =>
        key === 'dependencyFiles'
          ? {
              operations: { [view.id]: operation },
              version: 1,
              views: { 'fixture/topic': current },
            }
          : {},
    };
    const made = await receiptFor(f, { dependencyFiles: view, state });
    expect(made.ok).toBe(true);
    expect(validateDependencyReceipt(made.receipt)).toBe(true);
    const record = recordFor(f, made.receipt);
    const inspect = (dependencyFiles = current) =>
      inspectDependencyReadiness({
        checkoutIdentity: f.identity,
        dependencyFiles,
        record,
        state,
        wtDir: f.wtDir,
      });

    const completed = await inspect();
    expect(completed.ok).toBe(true);
    expect(completed.checkCurrent()).toBe(true);

    current = {
      ...view,
      retainedOriginalFiles: 0,
      state: 'released',
      updatedAt: 3,
    };
    operation = current;
    const releasedReadiness = await inspect();
    expect(releasedReadiness.ok).toBe(true);
    expect(releasedReadiness.state).toBe('ready');
    expect(releasedReadiness.checkCurrent()).toBe(true);

    const immutableDrifts = [
      { ...current, id: '1'.repeat(64), planId: '1'.repeat(64) },
      { ...current, inputDigest: '2'.repeat(64) },
      {
        ...current,
        storeIdentity: {
          ...current.storeIdentity,
          root: join(f.base, 'other-store'),
        },
      },
      { ...current, completedFiles: 2, totalFiles: 2 },
      { ...current, logicalCloneBytes: 129 },
      { ...current, physicalSavingsBytes: 1 },
      { ...current, createdAt: 0 },
      { ...current, repo: 'other' },
      { ...current, name: 'other' },
      { ...current, mode: 'other' },
      {
        ...current,
        checkoutIdentity: {
          ...f.identity,
          checkoutPath: join(f.base, 'other'),
        },
      },
    ];
    for (const drift of immutableDrifts) {
      current = drift;
      operation = drift;
      // biome-ignore lint/performance/noAwaitInLoops: Each invalid authoritative enrollment is checked independently.
      expect(await inspect()).toMatchObject({
        code: 'DEPENDENCY_VIEW_UNKNOWN',
        ok: false,
      });
    }

    const releasedSummary = {
      ...view,
      retainedOriginalFiles: 0,
      state: 'released',
      updatedAt: 3,
    };
    for (const invalid of [
      { ...releasedSummary, state: 'unknown' },
      { ...releasedSummary, state: 'partial' },
      { ...releasedSummary, retainedOriginalFiles: 1 },
    ]) {
      current = invalid;
      operation = invalid;
      // biome-ignore lint/performance/noAwaitInLoops: Each nonterminal summary is checked independently.
      expect(await inspect()).toMatchObject({
        code: 'DEPENDENCY_VIEW_UNKNOWN',
        ok: false,
      });
    }
    current = releasedSummary;
    operation = { ...releasedSummary, inputDigest: '3'.repeat(64) };
    expect(await inspect()).toMatchObject({
      code: 'DEPENDENCY_VIEW_UNKNOWN',
      ok: false,
    });
    operation = releasedSummary;
    const conflicting = {
      ...releasedSummary,
      code: 'DEPENDENCY_FILE_CONFLICT',
    };
    current = conflicting;
    operation = conflicting;
    expect(await inspect()).toMatchObject({
      code: 'DEPENDENCY_VIEW_UNKNOWN',
      ok: false,
    });

    current = releasedSummary;
    operation = releasedSummary;
    const staleCheckpoint = await inspect();
    current = { ...releasedSummary, updatedAt: 4 };
    operation = current;
    expect(staleCheckpoint.checkCurrent()).toBe(false);
  });

  test('resolves private isolated package links only through the checkout virtual store', async () => {
    const f = createFixture({
      bunfig: '[install]\nlinker = "isolated"\n',
      packages: {},
    });
    const packagePath = join(
      f.wtDir,
      'node_modules',
      '.bun',
      'fixture-package@1.2.0',
      'node_modules',
      'fixture-package'
    );
    packageJson(join(packagePath, 'package.json'), {
      name: 'fixture-package',
      version: '1.2.0',
    });
    symlinkSync(
      '.bun/fixture-package@1.2.0/node_modules/fixture-package',
      join(f.wtDir, 'node_modules', 'fixture-package')
    );
    const observed = await observeDependencyInputs({ wtDir: f.wtDir });
    expect(observed.ok).toBe(true);
    expect(observed.inputs.linkerMode).toBe('isolated');
    expect(observed.inputs.installMode).toBe('private');
  });

  test('refuses missing required packages and accepts explicitly optional omissions', async () => {
    const missing = createFixture({ packages: {} });
    const required = await observeDependencyInputs({ wtDir: missing.wtDir });
    expect(required.ok).toBe(false);
    expect(required.code).toBe('DEPENDENCY_PACKAGE_MISSING');

    const optional = createFixture({
      manifest: {
        name: 'optional-project',
        optionalDependencies: { 'platform-package': '^1.0.0' },
        version: '1.0.0',
      },
      packages: {},
    });
    const observed = await observeDependencyInputs({ wtDir: optional.wtDir });
    expect(observed.ok).toBe(true);
    expect(observed.inputs.view[0].status).toBe('optional-omitted');
  });

  test('records platform-skipped optional packages and rejects an incompatible required package', async () => {
    const optional = createFixture({
      manifest: {
        name: 'platform-project',
        optionalDependencies: { 'platform-package': '^1.0.0' },
        version: '1.0.0',
      },
      packages: {
        'platform-package': {
          name: 'platform-package',
          os: [`!${process.platform}`],
          version: '1.0.0',
        },
      },
    });
    const observed = await observeDependencyInputs({ wtDir: optional.wtDir });
    expect(observed.ok).toBe(true);
    expect(observed.inputs.view[0].status).toBe('platform-skipped');

    const required = createFixture({
      manifest: {
        dependencies: { 'platform-package': '^1.0.0' },
        name: 'platform-project',
        version: '1.0.0',
      },
      packages: {
        'platform-package': {
          cpu: [`!${process.arch}`],
          name: 'platform-package',
          version: '1.0.0',
        },
      },
    });
    const refused = await observeDependencyInputs({ wtDir: required.wtDir });
    expect(refused.ok).toBe(false);
    expect(refused.code).toBe('DEPENDENCY_PACKAGE_UNSAFE');
  });

  test('detects manifest and lock drift after a completed install receipt', async () => {
    const f = createFixture();
    const made = await receiptFor(f);
    expect(made.ok).toBe(true);
    const record = recordFor(f, made.receipt);

    writeFileSync(join(f.wtDir, 'bun.lock'), '{"changed":true}');
    const lockChanged = await inspectDependencyReadiness({
      checkoutIdentity: f.identity,
      record,
      wtDir: f.wtDir,
    });
    expect(lockChanged.ok).toBe(false);
    expect(lockChanged.code).toBe('DEPENDENCY_INPUTS_CHANGED');

    writeFileSync(join(f.wtDir, 'bun.lock'), '{}');
    writeFileSync(
      join(f.wtDir, 'package.json'),
      JSON.stringify({ name: 'readiness-fixture', version: '1.0.0' })
    );
    const manifestChanged = await inspectDependencyReadiness({
      checkoutIdentity: f.identity,
      record,
      wtDir: f.wtDir,
    });
    expect(manifestChanged.ok).toBe(false);
    expect(manifestChanged.code).toBe('DEPENDENCY_INPUTS_CHANGED');
  });

  test('detects config drift and refuses stale pre-observed inputs', async () => {
    const f = createFixture({ bunfig: '[install]\nlinker = "hoisted"\n' });
    const observed = await observeDependencyInputs({ wtDir: f.wtDir });
    expect(observed.ok).toBe(true);
    const stale = observed.inputs;
    writeFileSync(
      join(f.wtDir, 'bunfig.toml'),
      '[install]\nlinker = "hoisted"\n# changed input\n'
    );
    const made = await receiptFor(f, { inputs: stale });
    expect(made.ok).toBe(false);
    expect(made.code).toBe('DEPENDENCY_INPUTS_CHANGED');

    const initial = await receiptFor(f);
    expect(initial.ok).toBe(true);
    const record = recordFor(f, initial.receipt);
    writeFileSync(
      join(f.wtDir, 'bunfig.toml'),
      '[install]\nlinker = "hoisted"\n'
    );
    const changed = await inspectDependencyReadiness({
      checkoutIdentity: f.identity,
      record,
      wtDir: f.wtDir,
    });
    expect(changed.ok).toBe(false);
    expect(changed.code).toBe('DEPENDENCY_INPUTS_CHANGED');
  });

  test('detects a disappeared package and broken or outside-checkout package links', async () => {
    const missing = createFixture();
    const made = await receiptFor(missing);
    expect(made.ok).toBe(true);
    rmSync(join(missing.wtDir, 'node_modules', 'fixture-package'), {
      force: true,
      recursive: true,
    });
    const disappeared = await inspectDependencyReadiness({
      checkoutIdentity: missing.identity,
      record: recordFor(missing, made.receipt),
      wtDir: missing.wtDir,
    });
    expect(disappeared.ok).toBe(false);
    expect(disappeared.code).toBe('DEPENDENCY_PACKAGE_MISSING');

    const broken = createFixture({ packages: {} });
    mkdirSync(join(broken.wtDir, 'node_modules'), { recursive: true });
    symlinkSync(
      join(broken.wtDir, 'missing-target'),
      join(broken.wtDir, 'node_modules', 'fixture-package')
    );
    const brokenLink = await observeDependencyInputs({ wtDir: broken.wtDir });
    expect(brokenLink.ok).toBe(false);
    expect(brokenLink.code).toBe('DEPENDENCY_PACKAGE_UNSAFE');

    const outside = createFixture({ packages: {} });
    const externalPackage = join(outside.base, 'external-package');
    mkdirSync(externalPackage);
    packageJson(join(externalPackage, 'package.json'), {
      name: 'fixture-package',
      version: '1.0.0',
    });
    mkdirSync(join(outside.wtDir, 'node_modules'), { recursive: true });
    symlinkSync(
      externalPackage,
      join(outside.wtDir, 'node_modules', 'fixture-package')
    );
    const unowned = await observeDependencyInputs({ wtDir: outside.wtDir });
    expect(unowned.ok).toBe(false);
    expect(unowned.code).toBe('DEPENDENCY_PACKAGE_UNSAFE');
  });

  test('refuses unsupported workspace forms and non-Bun dependency managers', async () => {
    const workspace = createFixture({
      manifest: {
        name: 'workspace-project',
        version: '1.0.0',
        workspaces: ['packages/**'],
      },
    });
    const unsupportedGlob = await observeDependencyInputs({
      wtDir: workspace.wtDir,
    });
    expect(unsupportedGlob.ok).toBe(false);
    expect(unsupportedGlob.code).toBe('WORKSPACE_INVALID');

    const workspaceConfig = createFixture({
      manifest: {
        name: 'workspace-config-project',
        version: '1.0.0',
        workspaces: ['packages/*'],
      },
      packages: {},
    });
    const member = join(workspaceConfig.wtDir, 'packages', 'member');
    packageJson(join(member, 'package.json'), {
      name: 'workspace-config-member',
      version: '1.0.0',
    });
    writeFileSync(
      join(member, 'bunfig.toml'),
      '[install]\nlinker = "isolated"\n'
    );
    const ambiguousLinker = await observeDependencyInputs({
      wtDir: workspaceConfig.wtDir,
    });
    expect(ambiguousLinker.ok).toBe(false);
    expect(ambiguousLinker.code).toBe('DEPENDENCY_MANAGER_UNSUPPORTED');

    const python = createFixture({
      lock: null,
      manifest: null,
      packages: {},
    });
    rmSync(join(python.wtDir, 'package.json'));
    writeFileSync(join(python.wtDir, 'pyproject.toml'), '[project]\n');
    const unsupportedManager = await observeDependencyInputs({
      wtDir: python.wtDir,
    });
    expect(unsupportedManager.ok).toBe(false);
    expect(unsupportedManager.code).toBe('DEPENDENCY_MANAGER_UNSUPPORTED');
    const unsupportedPreflight = await observeDependencyInstallInputs({
      wtDir: python.wtDir,
    });
    expect(unsupportedPreflight.ok).toBe(false);
    expect(unsupportedPreflight.code).toBe('DEPENDENCY_MANAGER_UNSUPPORTED');
  });

  test('captures pre-install inputs and permits one generated root Bun lock', async () => {
    const expectedKeys = [
      'bunVersion',
      'dependencyCount',
      'digest',
      'files',
      'linkerMode',
      'platform',
      'version',
      'workspaceCount',
    ];
    await Promise.all(
      ['bun.lock', 'bun.lockb'].map(async (lockName) => {
        const f = createFixture({ lock: null, packages: {} });
        const before = await observeDependencyInstallInputs({ wtDir: f.wtDir });
        expect(before.ok).toBe(true);
        expect(Object.keys(before.inputs).sort()).toEqual(expectedKeys);
        expect(before.inputs.version).toBe(1);
        expect(before.inputs.files.length <= 2048).toBe(true);
        expect(
          before.inputs.files.some((file) => file.role === 'manifest')
        ).toBe(true);
        expect(JSON.parse(JSON.stringify(before.inputs))).toEqual(
          before.inputs
        );

        packageJson(
          join(f.wtDir, 'node_modules', 'fixture-package', 'package.json'),
          {
            name: 'fixture-package',
            version: '1.2.0',
          }
        );
        writeFileSync(join(f.wtDir, lockName), '{}');
        const after = await observeDependencyInputs({ wtDir: f.wtDir });
        expect(after.ok).toBe(true);
        expect(dependencyInstallInputsMatch(before.inputs, after.inputs)).toBe(
          true
        );
        const made = await receiptFor(f, { installInputs: before.inputs });
        expect(made.ok).toBe(true);
        expect(validateDependencyReceipt(made.receipt)).toBe(true);

        const malformed = structuredClone(before.inputs);
        malformed.unrecognized = true;
        expect(dependencyInstallInputsMatch(malformed, after.inputs)).toBe(
          false
        );
      })
    );

    const empty = createFixture({
      lock: null,
      manifest: { name: 'empty-install', version: '1.0.0' },
      packages: {},
    });
    const emptyBefore = await observeDependencyInstallInputs({
      wtDir: empty.wtDir,
    });
    const emptyAfter = await observeDependencyInputs({ wtDir: empty.wtDir });
    expect(emptyBefore.ok).toBe(true);
    expect(emptyAfter.ok).toBe(true);
    expect(
      dependencyInstallInputsMatch(emptyBefore.inputs, emptyAfter.inputs)
    ).toBe(true);
    const emptyReceipt = await receiptFor(empty, {
      installInputs: emptyBefore.inputs,
    });
    expect(emptyReceipt.ok).toBe(true);
    const emptyReady = await inspectDependencyReadiness({
      checkoutIdentity: empty.identity,
      record: recordFor(empty, emptyReceipt.receipt),
      wtDir: empty.wtDir,
    });
    expect(emptyReady.ok).toBe(true);
    expect(emptyReady.checkCurrent()).toBe(true);
  });

  test('rejects changed pre-existing lock and manifest fingerprints after install', async () => {
    const lockFixture = createFixture();
    const lockBefore = await observeDependencyInstallInputs({
      wtDir: lockFixture.wtDir,
    });
    expect(lockBefore.ok).toBe(true);
    writeFileSync(join(lockFixture.wtDir, 'bun.lock'), '{"changed":true}');
    const lockAfter = await observeDependencyInputs({
      wtDir: lockFixture.wtDir,
    });
    expect(lockAfter.ok).toBe(true);
    expect(
      dependencyInstallInputsMatch(lockBefore.inputs, lockAfter.inputs)
    ).toBe(false);
    const lockReceipt = await receiptFor(lockFixture, {
      installInputs: lockBefore.inputs,
    });
    expect(lockReceipt.ok).toBe(false);
    expect(lockReceipt.code).toBe('DEPENDENCY_INPUTS_CHANGED');

    const manifestFixture = createFixture();
    const manifestBefore = await observeDependencyInstallInputs({
      wtDir: manifestFixture.wtDir,
    });
    writeFileSync(
      join(manifestFixture.wtDir, 'package.json'),
      JSON.stringify({
        dependencies: { 'fixture-package': '^1.0.0' },
        name: 'readiness-fixture',
        version: '2.0.0',
      })
    );
    const manifestAfter = await observeDependencyInputs({
      wtDir: manifestFixture.wtDir,
    });
    expect(manifestAfter.ok).toBe(true);
    expect(
      dependencyInstallInputsMatch(manifestBefore.inputs, manifestAfter.inputs)
    ).toBe(false);
    const manifestReceipt = await receiptFor(manifestFixture, {
      installInputs: manifestBefore.inputs,
    });
    expect(manifestReceipt.ok).toBe(false);
    expect(manifestReceipt.code).toBe('DEPENDENCY_INPUTS_CHANGED');

    const configFixture = createFixture({
      bunfig: '[install]\nlinker = "hoisted"\n',
    });
    const configBefore = await observeDependencyInstallInputs({
      wtDir: configFixture.wtDir,
    });
    writeFileSync(
      join(configFixture.wtDir, 'bunfig.toml'),
      '[install]\nlinker = "hoisted"\n# changed install input\n'
    );
    const configAfter = await observeDependencyInputs({
      wtDir: configFixture.wtDir,
    });
    expect(configAfter.ok).toBe(true);
    expect(
      dependencyInstallInputsMatch(configBefore.inputs, configAfter.inputs)
    ).toBe(false);
  });

  test('rejects workspace membership changes and non-Bun or workspace lock additions', async () => {
    const makeWorkspace = (members) => {
      const f = createFixture({
        lock: null,
        manifest: {
          name: 'workspace-inputs',
          version: '1.0.0',
          workspaces: ['packages/*'],
        },
        packages: {},
      });
      for (const member of members) {
        packageJson(join(f.wtDir, 'packages', member, 'package.json'), {
          name: `workspace-${member}`,
          version: '1.0.0',
        });
      }
      return f;
    };

    const added = makeWorkspace(['one']);
    const beforeAdd = await observeDependencyInstallInputs({
      wtDir: added.wtDir,
    });
    const addReceipt = await receiptFor(added);
    const addReady = await inspectDependencyReadiness({
      checkoutIdentity: added.identity,
      record: recordFor(added, addReceipt.receipt),
      wtDir: added.wtDir,
    });
    expect(addReady.ok).toBe(true);
    packageJson(join(added.wtDir, 'packages', 'two', 'package.json'), {
      name: 'workspace-two',
      version: '1.0.0',
    });
    expect(addReady.checkCurrent()).toBe(false);
    const afterAdd = await observeDependencyInputs({ wtDir: added.wtDir });
    expect(afterAdd.ok).toBe(true);
    expect(
      dependencyInstallInputsMatch(beforeAdd.inputs, afterAdd.inputs)
    ).toBe(false);

    const removed = makeWorkspace(['one', 'two']);
    const beforeRemove = await observeDependencyInstallInputs({
      wtDir: removed.wtDir,
    });
    const removeReceipt = await receiptFor(removed);
    const removeReady = await inspectDependencyReadiness({
      checkoutIdentity: removed.identity,
      record: recordFor(removed, removeReceipt.receipt),
      wtDir: removed.wtDir,
    });
    expect(removeReady.ok).toBe(true);
    rmSync(join(removed.wtDir, 'packages', 'two'), {
      force: true,
      recursive: true,
    });
    expect(removeReady.checkCurrent()).toBe(false);
    const afterRemove = await observeDependencyInputs({ wtDir: removed.wtDir });
    expect(afterRemove.ok).toBe(true);
    expect(
      dependencyInstallInputsMatch(beforeRemove.inputs, afterRemove.inputs)
    ).toBe(false);

    const rootForeignLock = makeWorkspace(['one']);
    const beforeForeign = await observeDependencyInstallInputs({
      wtDir: rootForeignLock.wtDir,
    });
    writeFileSync(join(rootForeignLock.wtDir, 'package-lock.json'), '{}');
    const afterForeign = await observeDependencyInputs({
      wtDir: rootForeignLock.wtDir,
    });
    expect(afterForeign.ok).toBe(true);
    expect(
      dependencyInstallInputsMatch(beforeForeign.inputs, afterForeign.inputs)
    ).toBe(false);

    const workspaceLock = makeWorkspace(['one']);
    const beforeWorkspaceLock = await observeDependencyInstallInputs({
      wtDir: workspaceLock.wtDir,
    });
    writeFileSync(
      join(workspaceLock.wtDir, 'packages', 'one', 'bun.lock'),
      '{}'
    );
    const afterWorkspaceLock = await observeDependencyInputs({
      wtDir: workspaceLock.wtDir,
    });
    expect(afterWorkspaceLock.ok).toBe(true);
    expect(
      dependencyInstallInputsMatch(
        beforeWorkspaceLock.inputs,
        afterWorkspaceLock.inputs
      )
    ).toBe(false);

    const twoRootLocks = createFixture({ lock: null, packages: {} });
    const beforeTwoLocks = await observeDependencyInstallInputs({
      wtDir: twoRootLocks.wtDir,
    });
    packageJson(
      join(
        twoRootLocks.wtDir,
        'node_modules',
        'fixture-package',
        'package.json'
      ),
      {
        name: 'fixture-package',
        version: '1.2.0',
      }
    );
    writeFileSync(join(twoRootLocks.wtDir, 'bun.lock'), '{}');
    writeFileSync(join(twoRootLocks.wtDir, 'bun.lockb'), '{}');
    const afterTwoLocks = await observeDependencyInputs({
      wtDir: twoRootLocks.wtDir,
    });
    expect(afterTwoLocks.ok).toBe(true);
    expect(
      dependencyInstallInputsMatch(beforeTwoLocks.inputs, afterTwoLocks.inputs)
    ).toBe(false);
  });

  test('allows preflight without installed packages but refuses a missing package at receipt time', async () => {
    const f = createFixture({ lock: null, packages: {} });
    const before = await observeDependencyInstallInputs({ wtDir: f.wtDir });
    expect(before.ok).toBe(true);
    writeFileSync(join(f.wtDir, 'bun.lock'), '{}');
    const made = await receiptFor(f, { installInputs: before.inputs });
    expect(made.ok).toBe(false);
    expect(made.code).toBe('DEPENDENCY_PACKAGE_MISSING');
  });

  test('provides a synchronous final fence that ignores unrelated files and catches lock drift', async () => {
    const f = createFixture();
    const made = await receiptFor(f);
    const ready = await inspectDependencyReadiness({
      checkoutIdentity: f.identity,
      record: recordFor(f, made.receipt),
      wtDir: f.wtDir,
    });
    expect(ready.ok).toBe(true);
    expect(typeof ready.checkCurrent).toBe('function');
    const current = ready.checkCurrent();
    expect(typeof current).toBe('boolean');
    expect(current).toBe(true);
    expect(JSON.stringify(ready).includes('checkCurrent')).toBe(false);
    writeFileSync(join(f.wtDir, 'unrelated.txt'), 'not read by readiness');
    expect(ready.checkCurrent()).toBe(true);
    writeFileSync(join(f.wtDir, 'bun.lock'), '{"changed":true}');
    expect(ready.checkCurrent()).toBe(false);
    const drifted = await inspectDependencyReadiness({
      checkoutIdentity: f.identity,
      record: recordFor(f, made.receipt),
      wtDir: f.wtDir,
    });
    expect(drifted.ok).toBe(false);
    expect(drifted.code).toBe('DEPENDENCY_INPUTS_CHANGED');
  });

  test('the final fence catches optional package appearance and installed link changes', async () => {
    const optional = createFixture({
      manifest: {
        name: 'optional-fence',
        optionalDependencies: { 'platform-package': '^1.0.0' },
        version: '1.0.0',
      },
      packages: {},
    });
    const optionalReceipt = await receiptFor(optional);
    expect(optionalReceipt.ok).toBe(true);
    const optionalReady = await inspectDependencyReadiness({
      checkoutIdentity: optional.identity,
      record: recordFor(optional, optionalReceipt.receipt),
      wtDir: optional.wtDir,
    });
    expect(optionalReady.ok).toBe(true);
    expect(optionalReady.checkCurrent()).toBe(true);
    packageJson(
      join(optional.wtDir, 'node_modules', 'platform-package', 'package.json'),
      { name: 'platform-package', version: '1.0.0' }
    );
    expect(optionalReady.checkCurrent()).toBe(false);

    const linked = createFixture({
      manifest: {
        dependencies: { 'fixture-package': 'file:./local-one' },
        name: 'link-fence',
        version: '1.0.0',
      },
      packages: {},
    });
    const installBefore = await observeDependencyInstallInputs({
      wtDir: linked.wtDir,
    });
    packageJson(join(linked.wtDir, 'local-one', 'package.json'), {
      name: 'fixture-package',
      version: '1.0.0',
    });
    mkdirSync(join(linked.wtDir, 'node_modules'), { recursive: true });
    symlinkSync(
      '../local-one',
      join(linked.wtDir, 'node_modules', 'fixture-package')
    );
    const linkReceipt = await receiptFor(linked, {
      installInputs: installBefore.inputs,
    });
    expect(linkReceipt.ok).toBe(true);
    const linkReady = await inspectDependencyReadiness({
      checkoutIdentity: linked.identity,
      record: recordFor(linked, linkReceipt.receipt),
      wtDir: linked.wtDir,
    });
    expect(linkReady.ok).toBe(true);
    expect(linkReady.checkCurrent()).toBe(true);
    packageJson(join(linked.wtDir, 'local-two', 'package.json'), {
      name: 'fixture-package',
      version: '2.0.0',
    });
    rmSync(join(linked.wtDir, 'node_modules', 'fixture-package'));
    symlinkSync(
      '../local-two',
      join(linked.wtDir, 'node_modules', 'fixture-package')
    );
    expect(linkReady.checkCurrent()).toBe(false);
  });

  test('keeps legacy completions unverified and validates exact attempt and receipt shape', async () => {
    const f = createFixture();
    const legacy = await inspectDependencyReadiness({
      checkoutIdentity: f.identity,
      record: {
        attemptId: 'old-attempt',
        checkoutIdentity: f.identity,
        outcome: 'completed',
        state: 'completed',
      },
      wtDir: f.wtDir,
    });
    expect(legacy.ok).toBe(false);
    expect(legacy.code).toBe('DEPENDENCY_READINESS_UNVERIFIED');

    const incomplete = await inspectDependencyReadiness({
      checkoutIdentity: f.identity,
      record: {
        attemptId: 'running-attempt',
        checkoutIdentity: f.identity,
        outcome: null,
        state: 'running',
      },
      wtDir: f.wtDir,
    });
    expect(incomplete.ok).toBe(false);
    expect(incomplete.code).toBe('SETUP_NOT_COMPLETED');

    const made = await receiptFor(f);
    expect(made.ok).toBe(true);
    const wrongAttempt = recordFor(f, made.receipt);
    wrongAttempt.attemptId = 'replacement-attempt';
    const mismatch = await inspectDependencyReadiness({
      checkoutIdentity: f.identity,
      record: wrongAttempt,
      wtDir: f.wtDir,
    });
    expect(mismatch.ok).toBe(false);
    expect(mismatch.code).toBe('SETUP_ATTEMPT_MISMATCH');

    const altered = structuredClone(made.receipt);
    altered.inputs.files[0].sha256 = 'a'.repeat(64);
    expect(validateDependencyReceipt(altered)).toBe(false);
    const extra = { ...made.receipt, unrecognized: true };
    expect(validateDependencyReceipt(extra)).toBe(false);
    const malformedRecord = recordFor(f, altered);
    const malformed = await inspectDependencyReadiness({
      checkoutIdentity: f.identity,
      record: malformedRecord,
      wtDir: f.wtDir,
    });
    expect(malformed.ok).toBe(false);
    expect(malformed.code).toBe('DEPENDENCY_RECEIPT_INVALID');
  });

  test('refuses a replaced checkout incarnation', async () => {
    const f = createFixture();
    const made = await receiptFor(f);
    expect(made.ok).toBe(true);
    rmSync(f.wtDir, { force: true, recursive: true });
    mkdirSync(f.wtDir);
    writeFileSync(
      join(f.wtDir, 'package.json'),
      JSON.stringify({ name: 'replacement' })
    );
    writeFileSync(join(f.wtDir, 'replacement-marker'), 'new incarnation');
    const changed = await inspectDependencyReadiness({
      checkoutIdentity: f.identity,
      record: recordFor(f, made.receipt),
      wtDir: f.wtDir,
    });
    expect(changed.ok).toBe(false);
    expect(['CHECKOUT_CHANGED', 'DEPENDENCY_INPUTS_CHANGED']).toContain(
      changed.code
    );
  });

  test('uses dependency-sharing inspection and consumer ownership for shared views', async () => {
    const f = createFixture({
      bunfig: '[install]\nlinker = "isolated"\n',
      packages: {},
    });
    const storeRoot = realpathSync(
      mkdtempSync(join(tmpdir(), 'setu-readiness-store-'))
    );
    fixtures.add(storeRoot);
    chmodSync(storeRoot, 0o700);
    const platformNamespace = 'darwin-arm64-bun-1.3.14';
    const storePackage = join(
      storeRoot,
      platformNamespace,
      'links',
      'fixture-package@1.2.0',
      'node_modules',
      'fixture-package'
    );
    packageJson(join(storePackage, 'package.json'), {
      name: 'fixture-package',
      version: '1.2.0',
    });
    const bunLinks = join(storeRoot, platformNamespace, 'links');
    mkdirSync(join(f.wtDir, 'node_modules', '.bun'), { recursive: true });
    symlinkSync(
      join(bunLinks, 'fixture-package@1.2.0'),
      join(f.wtDir, 'node_modules', '.bun', 'fixture-package@1.2.0')
    );
    symlinkSync(
      '.bun/fixture-package@1.2.0/node_modules/fixture-package',
      join(f.wtDir, 'node_modules', 'fixture-package')
    );
    const consumer = {
      bunVersion: Bun.version,
      checkout: realpathSync(f.wtDir),
      linkerMode: 'isolated',
      lockfileHash: bunLockHash(join(f.wtDir, 'bun.lock')),
      platformNamespace,
    };
    const sharing = {
      enabled: true,
      executable: join(f.base, 'unused-bun'),
      storeIdentity: {
        device: Number(lstatSync(storeRoot, { bigint: true }).dev),
        mountPath: realpathSync(tmpdir()),
      },
      storeRoot,
      version: '1.3.14',
      workspaceRoot: f.base,
    };
    let consumers = { [consumer.checkout]: consumer };
    const state = { read: () => ({ consumers }) };
    const observed = await observeDependencyInputs({
      sharing,
      state,
      wtDir: f.wtDir,
    });
    if (Bun.version === '1.3.14') {
      expect(observed.ok).toBe(true);
      expect(observed.inputs.installMode).toBe('shared');
      expect(observed.inputs.sharedView).toBe('shared and healthy');
      const made = await receiptFor(f, { sharing, state });
      expect(made.ok).toBe(true);
      expect(Object.isFrozen(made.receipt)).toBe(true);
      expect(Object.isFrozen(made.receipt.inputs)).toBe(true);
      const ready = await inspectDependencyReadiness({
        checkoutIdentity: f.identity,
        record: recordFor(f, made.receipt),
        sharing,
        state,
        wtDir: f.wtDir,
      });
      expect(ready.ok).toBe(true);
      expect(typeof ready.checkCurrent).toBe('function');
      expect(ready.checkCurrent()).toBe(true);
      consumers = {
        ...consumers,
        '/unrelated/checkout': {
          ...consumer,
          checkout: '/unrelated/checkout',
        },
      };
      expect(ready.checkCurrent()).toBe(true);
      consumers = {
        ...consumers,
        [consumer.checkout]: { ...consumer, lockfileHash: 'changed' },
      };
      expect(ready.checkCurrent()).toBe(false);
      consumers = { [consumer.checkout]: consumer };
      rmSync(storeRoot, { force: true, recursive: true });
      const missingStore = await observeDependencyInputs({
        sharing,
        state,
        wtDir: f.wtDir,
      });
      expect(missingStore.ok).toBe(false);
      expect(missingStore.code).toBe('DEPENDENCY_VIEW_UNKNOWN');
    } else {
      expect(observed.ok).toBe(false);
      expect(observed.code).toBe('DEPENDENCY_VIEW_UNKNOWN');
    }
    rmSync(join(f.wtDir, 'node_modules', 'fixture-package'));
    const missingLink = await observeDependencyInputs({
      sharing,
      state,
      wtDir: f.wtDir,
    });
    expect(missingLink.ok).toBe(false);
    expect(['DEPENDENCY_PACKAGE_MISSING', 'DEPENDENCY_VIEW_UNKNOWN']).toContain(
      missingLink.code
    );
  });
});
