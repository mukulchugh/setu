import { afterEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import fsPromises from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inspectCheckoutIdentity } from './checkout-identity.js';
import { createDependencyReceipt } from './dependency-readiness.js';
import { createSetupProgress } from './setup-progress.js';
import {
  createDependencyAdapter,
  createSetupAdapter,
} from './spans-execution-adapters.js';
import { createWorkspaceState } from './workspace-state.js';

const roots = new Set();

afterEach(() => {
  for (const root of roots) {
    rmSync(root, { force: true, recursive: true });
  }
  roots.clear();
});

function git(root, args) {
  execFileSync('git', args, { cwd: root, stdio: 'ignore' });
}

async function fixture({
  dependencies = false,
  receipt = true,
  enrolled = false,
} = {}) {
  const root = realpathSync(
    mkdtempSync(join(tmpdir(), 'setu-e156-readiness-'))
  );
  roots.add(root);
  const repository = join(root, 'repository');
  const checkout = join(root, 'checkout');
  const workspaceRoot = join(root, 'workspace');
  const setuDir = join(root, 'setu');
  const configPath = join(root, 'config.json');
  mkdirSync(workspaceRoot);
  mkdirSync(setuDir);
  execFileSync('git', ['init', '--initial-branch=main', repository], {
    stdio: 'ignore',
  });
  git(repository, ['config', 'user.name', 'Fixture']);
  git(repository, ['config', 'user.email', 'fixture@example.invalid']);

  const packageManifest = {
    name: 'readiness-fixture',
    version: '1.0.0',
    ...(dependencies ? { dependencies: { 'left-pad': '1.3.0' } } : {}),
  };
  writeFileSync(
    join(repository, 'package.json'),
    JSON.stringify(packageManifest)
  );
  if (dependencies) {
    writeFileSync(join(repository, 'bun.lock'), '{"lockfileVersion":1}\n');
  }
  git(repository, [
    'add',
    'package.json',
    ...(dependencies ? ['bun.lock'] : []),
  ]);
  git(repository, ['commit', '-m', 'fixture']);
  execFileSync(
    'git',
    ['-C', repository, 'worktree', 'add', '-b', 'fixture', checkout, 'main'],
    { stdio: 'ignore' }
  );

  if (dependencies) {
    const packageDir = join(checkout, 'node_modules', 'left-pad');
    mkdirSync(packageDir, { recursive: true });
    writeFileSync(
      join(packageDir, 'package.json'),
      JSON.stringify({ name: 'left-pad', version: '1.3.0' })
    );
  }
  if (enrolled) {
    writeFileSync(
      join(checkout, 'bunfig.toml'),
      '[install]\nlinker = "hoisted"\n'
    );
  }

  const state = createWorkspaceState({
    configPath,
    setuDir,
    workspaceRoot,
  });
  const setupProgress = createSetupProgress({
    newAttemptId: () => 'fixture-attempt-1',
    state,
  });
  const target = { name: 'fixture', repo: 'repository' };
  const checkoutIdentity = await inspectCheckoutIdentity(
    { repoDir: join(repository, '.git'), wtDir: checkout },
    fsPromises
  );
  if (checkoutIdentity.known !== true) {
    throw new Error('Local linked checkout identity was not established');
  }
  const started = await setupProgress.start({
    checkoutIdentity,
    logLocation: 'fixture setup log',
    stage: 'install',
    target,
  });
  if (!started.ok) {
    throw new Error('Fixture setup attempt did not start');
  }

  let dependencyReceipt;
  let enrollment;
  if (enrolled) {
    enrollment = {
      checkoutIdentity,
      completedFiles: 1,
      createdAt: 1,
      id: 'a'.repeat(64),
      inputDigest: 'b'.repeat(64),
      logicalCloneBytes: 128,
      mode: 'hoisted-cow',
      name: target.name,
      physicalSavingsBytes: null,
      planId: 'a'.repeat(64),
      repo: target.repo,
      retainedOriginalFiles: 1,
      state: 'completed',
      storeIdentity: {
        device: String(lstatSync(root, { bigint: true }).dev),
        executable: process.execPath,
        mountPath: root,
        namespace: 'hoisted/darwin-arm64-bun-1.3.14',
        root: join(root, 'private-store'),
        version: '1.3.14',
      },
      totalFiles: 1,
      updatedAt: 2,
      version: 1,
    };
    await state.replace('dependencyFiles', {
      operations: { [enrollment.id]: enrollment },
      version: 1,
      views: { 'repository/fixture': enrollment },
    });
    await state.replace('config', {
      dependencySharing: {
        enabled: true,
        executable: process.execPath,
        storeIdentity: {
          device: Number(enrollment.storeIdentity.device),
          mountPath: root,
        },
        storeRoot: enrollment.storeIdentity.root,
        targets: { 'repository/fixture': true },
        version: '1.3.14',
      },
      workspace: workspaceRoot,
    });
  }
  if (receipt) {
    const created = await createDependencyReceipt({
      attemptId: started.record.attemptId,
      bunVersion: Bun.version,
      checkoutIdentity,
      state,
      wtDir: checkout,
      ...(enrolled ? { dependencyFiles: enrollment } : {}),
    });
    if (!created.ok) {
      throw new Error('Fixture dependency receipt could not be created');
    }
    dependencyReceipt = created.receipt;
  }
  const finished = await setupProgress.finish({
    attemptId: started.record.attemptId,
    checkoutIdentity,
    dependencyReceipt,
    outcome: 'completed',
    target,
  });
  if (!finished.ok) {
    throw new Error('Fixture setup attempt did not complete');
  }

  return {
    checkout,
    checkoutIdentity,
    configPath,
    dependencyReceipt,
    enrollment,
    repoDir: join(repository, '.git'),
    resourcePaths: { configPath, setuDir, workspaceRoot },
    setupProgress,
    state,
    target,
    wtDir: checkout,
  };
}

function adapterFor(value) {
  return createDependencyAdapter({
    bunVersion: Bun.version,
    setupProgress: value.setupProgress,
    state: value.state,
  });
}

function requestFor(value, overrides = {}) {
  return {
    checkoutIdentity: value.checkoutIdentity,
    target: value.target,
    wtDir: value.wtDir,
    ...overrides,
  };
}

async function readyObservation(value, adapter = adapterFor(value)) {
  const result = await adapter.observe(requestFor(value));
  expect(result.ok).toBe(true);
  expect(result.state).toBe('ready');
  expect(result.identity.version).toBe(2);
  expect(Object.keys(result.identity).sort()).toEqual([
    'inputDigest',
    'receiptDigest',
    'version',
  ]);
  expect(typeof result.checkCurrent).toBe('function');
  return result;
}

describe('dependency readiness adapter', () => {
  test('uses the authoritative hoisted enrollment and fences its journal through release', async () => {
    const value = await fixture({ dependencies: true, enrolled: true });
    const adapter = adapterFor(value);
    const ready = await readyObservation(value, adapter);
    expect(ready.checkCurrent()).toBe(true);
    const history = value.state.read('dependencyFiles');
    for (let index = 0; index < 1000; index += 1) {
      const id = index.toString(16).padStart(64, '0');
      history.operations[id] = { ...value.enrollment, id, planId: id };
    }
    await value.state.replace('dependencyFiles', history);
    expect(ready.checkCurrent()).toBe(true);
    await readyObservation(value, adapter);
    const released = {
      ...value.enrollment,
      retainedOriginalFiles: 0,
      state: 'released',
      updatedAt: 3,
    };
    await value.state.replace('dependencyFiles', {
      operations: { [released.id]: released },
      version: 1,
      views: { 'repository/fixture': released },
    });
    expect(ready.checkCurrent()).toBe(false);
    const current = await readyObservation(value, adapter);
    expect(current.checkCurrent()).toBe(true);
    await value.state.replace('dependencyFiles', {
      operations: { [released.id]: released },
      version: 1,
      views: {},
    });
    expect(current.checkCurrent()).toBe(false);
    expect(await adapter.observe(requestFor(value))).toMatchObject({
      code: 'DEPENDENCY_VIEW_UNKNOWN',
      ok: false,
    });
  });

  test('does not treat a completed legacy setup record as ready', async () => {
    const value = await fixture({ receipt: false });
    const result = await adapterFor(value).observe(requestFor(value));

    expect(result.ok).toBe(false);
    expect(result.code).toBe('DEPENDENCY_READINESS_UNVERIFIED');
    expect(result.state).toBe('unverified');
  });

  test('keeps running, unknown, and failed setup attempts unready', async () => {
    const value = await fixture({ receipt: false });
    const cases = [
      ['running', null],
      ['unknown', 'unknown'],
      ['failed', 'failed'],
    ];
    const results = await Promise.all(
      cases.map(([state, outcome]) => {
        const setupProgress = {
          get: () => ({
            checkoutIdentity: value.checkoutIdentity,
            outcome,
            state,
            target: value.target,
          }),
        };
        const adapter = createDependencyAdapter({
          bunVersion: Bun.version,
          setupProgress,
          state: value.state,
        });
        return adapter.observe(requestFor(value));
      })
    );

    expect(results[0].ok).toBe(false);
    expect(results[0].state).toBe('running');
    expect(results[1].ok).toBe(false);
    expect(results[1].state).toBe('unknown');
    expect(results[2].ok).toBe(false);
    expect(results[2].state).toBe('failed');
  });

  test('requires the core synchronous checkpoint before exposing readiness', async () => {
    const value = await fixture();
    expect(value.dependencyReceipt.inputs.dependencyCount).toBe(0);
    expect(value.dependencyReceipt.inputs.noDependencies).toBe(true);
    expect(value.dependencyReceipt.inputs.installMode).toBe('none');
    expect(
      value.dependencyReceipt.inputs.files.some(
        (file) => file.role === 'lock' && file.present
      )
    ).toBe(false);
    const result = await adapterFor(value).observe(requestFor(value));

    expect(result.ok).toBe(true);
    expect(result.state).toBe('ready');
    expect(result.identity.version).toBe(2);
    expect(typeof result.checkCurrent).toBe('function');
  });

  test('reopens setup progress from explicit paths when no progress adapter is passed', async () => {
    const value = await fixture();
    const detachedAdapter = createDependencyAdapter({
      bunVersion: Bun.version,
      resourcePaths: value.resourcePaths,
    });
    const result = await readyObservation(value, detachedAdapter);

    if (result) {
      expect(result.checkCurrent()).toBe(true);
    }
  });

  test('refuses manifest and installed-view changes against a real receipt', async () => {
    const changedManifest = await fixture();
    writeFileSync(
      join(changedManifest.checkout, 'package.json'),
      JSON.stringify({ name: 'changed', version: '1.0.0' })
    );
    const manifestResult = await adapterFor(changedManifest).observe(
      requestFor(changedManifest)
    );
    expect(manifestResult.ok).toBe(false);
    expect(manifestResult.code).toBe('DEPENDENCY_INPUTS_CHANGED');

    const changedView = await fixture({ dependencies: true });
    expect(
      JSON.parse(
        readFileSync(join(changedView.checkout, 'package.json'), 'utf8')
      ).dependencies
    ).toEqual({ 'left-pad': '1.3.0' });
    expect(changedView.dependencyReceipt.inputs.dependencyCount).toBe(1);
    expect(changedView.dependencyReceipt.inputs.view.length).toBe(1);
    rmSync(join(changedView.checkout, 'node_modules', 'left-pad'), {
      force: true,
      recursive: true,
    });
    const viewResult = await adapterFor(changedView).observe(
      requestFor(changedView)
    );
    expect(viewResult.ok).toBe(false);
    expect(viewResult.code).toBe('DEPENDENCY_PACKAGE_MISSING');
  });

  test('rejects unreadable current sharing configuration instead of assuming private', async () => {
    const value = await fixture();
    writeFileSync(
      value.configPath,
      JSON.stringify({ dependencySharing: null })
    );
    const result = await adapterFor(value).observe(requestFor(value));

    expect(result.ok).toBe(false);
    expect(result.code).toBe('DEPENDENCY_SHARING_UNKNOWN');
  });

  test('rejects malformed request objects without invoking accessors or proxies', async () => {
    const value = await fixture();
    let invoked = 0;
    const target = {};
    Object.defineProperty(target, 'repo', {
      enumerable: true,
      get() {
        invoked += 1;
        return 'repository';
      },
    });
    Object.defineProperty(target, 'name', {
      enumerable: true,
      value: 'fixture',
    });
    const adapter = adapterFor(value);
    const accessorResult = await adapter.observe(requestFor(value, { target }));
    const checkoutIdentity = { ...value.checkoutIdentity };
    Object.defineProperty(checkoutIdentity, 'checkoutPath', {
      enumerable: true,
      get() {
        invoked += 1;
        return value.checkout;
      },
    });
    const identityResult = await adapter.observe(
      requestFor(value, { checkoutIdentity })
    );
    const proxyResult = await adapter.observe(
      requestFor(value, {
        target: new Proxy(value.target, {
          get() {
            invoked += 1;
            return 'repository';
          },
        }),
      })
    );

    expect(accessorResult.ok).toBe(false);
    expect(identityResult.ok).toBe(false);
    expect(proxyResult.ok).toBe(false);
    expect(invoked).toBe(0);
  });

  test('refuses malformed setup records and inaccessible state', async () => {
    const value = await fixture();
    let invoked = 0;
    const maliciousProgress = {
      get() {
        const record = {};
        Object.defineProperty(record, 'state', {
          enumerable: true,
          get() {
            invoked += 1;
            return 'completed';
          },
        });
        return record;
      },
    };
    const malformed = createDependencyAdapter({
      bunVersion: Bun.version,
      setupProgress: maliciousProgress,
      state: value.state,
    });
    const malformedResult = await malformed.observe(requestFor(value));
    expect(malformedResult.ok).toBe(false);
    expect(malformedResult.code).toBe('SETUP_PROGRESS_CORRUPT');
    expect(invoked).toBe(0);

    const unavailableState = {
      read() {
        throw new Error('source unavailable');
      },
    };
    const unavailable = createDependencyAdapter({
      bunVersion: Bun.version,
      setupProgress: value.setupProgress,
      state: unavailableState,
    });
    const unavailableResult = await unavailable.observe(requestFor(value));
    expect(unavailableResult.ok).toBe(false);
    expect(unavailableResult.code).toBe('DEPENDENCY_SHARING_UNKNOWN');

    const noExplicitPaths = createDependencyAdapter({
      bunVersion: Bun.version,
      setupProgress: value.setupProgress,
    });
    const pathlessResult = await noExplicitPaths.observe(requestFor(value));
    expect(pathlessResult.ok).toBe(false);
    expect(pathlessResult.code).toBe('DEPENDENCY_READINESS_UNAVAILABLE');
  });

  test('fresh checkpoint notices manifest, config, receipt, and unrelated-target changes', async () => {
    const changedManifest = await fixture({ dependencies: true });
    const manifestObservation = await readyObservation(changedManifest);
    if (manifestObservation) {
      expect(manifestObservation.checkCurrent()).toBe(true);
      writeFileSync(
        join(changedManifest.checkout, 'package.json'),
        JSON.stringify({
          dependencies: { 'left-pad': '2.0.0' },
          name: 'readiness-fixture',
          version: '1.0.0',
        })
      );
      expect(manifestObservation.checkCurrent()).toBe(false);
    }

    const changedConfig = await fixture();
    const configObservation = await readyObservation(changedConfig);
    if (configObservation) {
      writeFileSync(
        changedConfig.configPath,
        JSON.stringify({ dependencySharing: null })
      );
      expect(configObservation.checkCurrent()).toBe(false);
    }

    const changedView = await fixture({ dependencies: true });
    const viewObservation = await readyObservation(changedView);
    if (viewObservation) {
      rmSync(join(changedView.checkout, 'node_modules', 'left-pad'), {
        force: true,
        recursive: true,
      });
      expect(viewObservation.checkCurrent()).toBe(false);
    }

    const changedReceipt = await fixture();
    const receiptObservation = await readyObservation(changedReceipt);
    if (receiptObservation) {
      await changedReceipt.state.update('setupProgress', (document) => {
        const key = `${changedReceipt.target.repo}/${changedReceipt.target.name}`;
        const record = document.records[key];
        return {
          ...document,
          records: {
            ...document.records,
            [key]: {
              ...record,
              attemptId: 'different-attempt',
            },
          },
        };
      });
      expect(receiptObservation.checkCurrent()).toBe(false);
    }

    const changedCheckout = await fixture();
    const checkoutObservation = await readyObservation(changedCheckout);
    if (checkoutObservation) {
      await changedCheckout.state.update('setupProgress', (document) => {
        const key = `${changedCheckout.target.repo}/${changedCheckout.target.name}`;
        const record = document.records[key];
        return {
          ...document,
          records: {
            ...document.records,
            [key]: {
              ...record,
              checkoutIdentity: {
                ...record.checkoutIdentity,
                checkoutPath: join(changedCheckout.checkout, 'replaced'),
              },
            },
          },
        };
      });
      expect(checkoutObservation.checkCurrent()).toBe(false);
    }

    const unrelatedChange = await fixture();
    const unrelatedObservation = await readyObservation(unrelatedChange);
    if (unrelatedObservation) {
      const other = await unrelatedChange.setupProgress.start({
        checkoutIdentity: unrelatedChange.checkoutIdentity,
        logLocation: 'unrelated setup log',
        stage: 'install',
        target: { name: 'other', repo: 'other' },
      });
      expect(other.ok).toBe(true);
      expect(unrelatedObservation.checkCurrent()).toBe(true);
    }
  });
});

describe('setup readiness adapter', () => {
  test('consumes the shared dependency adapter and never short-circuits completion', async () => {
    const value = await fixture({ receipt: false });
    const dependencyAdapter = adapterFor(value);
    const setup = createSetupAdapter({
      dependencyAdapter,
      setupProgress: value.setupProgress,
      state: value.state,
    });
    const result = await setup.ensure(requestFor(value));

    expect(result.ok).toBe(false);
    expect(result.code).toBe('DEPENDENCY_READINESS_UNVERIFIED');
    expect(result.state).toBe('unverified');
  });

  test('preserves absent setup as a refusal', async () => {
    const value = await fixture({ receipt: false });
    const setup = createSetupAdapter({
      resourcePaths: {
        configPath: value.configPath,
        setuDir: join(value.state.root ?? '', 'unused'),
        workspaceRoot: value.state.workspaceRoot ?? '',
      },
      setupProgress: {
        get: () => null,
      },
      state: value.state,
    });
    const result = await setup.ensure(requestFor(value));

    expect(result.ok).toBe(false);
    expect(result.state).toBe('absent');
  });
});
