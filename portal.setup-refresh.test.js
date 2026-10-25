import { expect, test } from 'bun:test';
import { readFileSync, symlinkSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { createPortalRuntime } from './portal.js';
import {
  createExecutionFixture,
  TARGET,
} from './spans-execution.test-support.js';

// Calls the unstarted runtime directly. There is no listener or live portal request.
test('portal dependency refresh holds readiness until its exact owned install settles', async () => {
  const f = createExecutionFixture();
  const workspace = join(f.root, 'workspace');
  let finishGroup;
  let groupEntered;
  const settled = new Promise((resolve) => {
    finishGroup = resolve;
  });
  const stopping = new Promise((resolve) => {
    groupEntered = resolve;
  });
  let active = false;
  let launches = 0;
  let portal;
  try {
    symlinkSync(f.repoDir, join(workspace, 'demo.git'), 'dir');
    await f.state.replace('ports', [
      { key: 'demo/feature', ...TARGET, port: 3301 },
    ]);
    await f.completeSetup();
    const previous = f.setupProgress.get(TARGET);
    expect(previous.dependencyReceipt).toBeDefined();
    portal = await createPortalRuntime({
      config: { tunnel: 'fixture', workspace },
      hostHealth: () =>
        Promise.resolve({ availableBytes: 30 * 1024 ** 3, state: 'ready' }),
      linksRoot: join(f.root, 'links'),
      loadProjects: () => ({ demo: {} }),
      port: 43_210,
      setupInstallProcesses: {
        close() {
          expect(active).toBe(false);
        },
        hasOwnedWork: () => active,
        spawn(argv, options) {
          launches += 1;
          expect(argv).toEqual([process.execPath, 'install']);
          expect(options.cwd).toBe(f.wtDir);
          writeSync(options.stdout, 'fixture refreshed dependencies\n');
          active = true;
          return {
            exited: Promise.resolve(0),
            pid: 4321,
            setupOwnerId: 'portal-refresh-owner',
            signalCode: null,
          };
        },
        async stopProcess(owner) {
          expect(owner).toEqual({
            ownedGroup: true,
            pid: 4321,
            setupOwnerId: 'portal-refresh-owner',
          });
          groupEntered();
          await settled;
          active = false;
        },
      },
      spansExecutionResourcePaths: {
        configPath: join(f.root, 'config.json'),
        setuDir: f.root,
        workspaceRoot: workspace,
      },
      spansRoot: f.archive,
      state: f.state,
      workspace,
    });
    const request = async (body) => {
      const response = await portal.handle(
        new Request('http://localhost:43210/api/setup-progress/retry', {
          body: JSON.stringify(body),
          headers: {
            'content-type': 'application/json',
            host: 'localhost:43210',
            'x-setu-source': 'cli',
          },
          method: 'POST',
        }),
        {
          requestIP: () => ({ address: '127.0.0.1' }),
          timeout: () => undefined,
        }
      );
      return response.json();
    };
    const { dependencyReceipt, ...legacyFields } = previous;
    const legacy = { ...legacyFields, checkoutIdentity: f.wtDir };
    await f.state.update('setupProgress', (document) => ({
      ...document,
      records: { ...document.records, 'demo/feature': legacy },
    }));
    const beforeLegacy = JSON.stringify(f.state.read('setupProgress'));
    expect(
      await request({
        ...TARGET,
        attemptId: legacy.attemptId,
        checkoutIdentity: legacy.checkoutIdentity,
        refreshDependencies: true,
      })
    ).toMatchObject({ code: 'CHECKOUT_IDENTITY_MISMATCH', ok: false });
    expect(JSON.stringify(f.state.read('setupProgress'))).toBe(beforeLegacy);
    expect(launches).toBe(0);
    await f.state.update('setupProgress', (document) => ({
      ...document,
      records: { ...document.records, 'demo/feature': previous },
    }));
    const input = {
      ...TARGET,
      attemptId: previous.attemptId,
      checkoutIdentity: previous.checkoutIdentity,
    };
    expect(await request(input)).toMatchObject({
      code: 'SETUP_RETRY_UNAVAILABLE',
      ok: false,
    });
    expect(
      await request({ ...input, refreshDependencies: 'true' })
    ).toMatchObject({ code: 'SETUP_PROGRESS_INVALID', ok: false });
    expect(
      await request({ ...input, attemptId: 'stale', refreshDependencies: true })
    ).toMatchObject({ code: 'SETUP_ATTEMPT_MISMATCH', ok: false });
    expect(launches).toBe(0);
    const result = await request({ ...input, refreshDependencies: true });
    expect(result).toMatchObject({ ok: true });
    expect(launches).toBe(1);
    await stopping;
    const pending = f.setupProgress.get(TARGET);
    expect(pending.state).toBe('running');
    expect(pending.attemptId).not.toBe(previous.attemptId);
    expect(pending.dependencyReceipt).toBeUndefined();
    expect((await f.admission.status()).leases).toHaveLength(1);
    finishGroup();
    const deadline = Date.now() + 1500;
    while (
      (f.setupProgress.get(TARGET).state === 'running' ||
        // biome-ignore lint/performance/noAwaitInLoops: Observe owned lease release within the bounded deadline.
        (await f.admission.status()).leases.length !== 0) &&
      Date.now() < deadline
    ) {
      await Bun.sleep(5);
    }
    const completed = f.setupProgress.get(TARGET);
    expect(completed.state).toBe('completed');
    expect(completed.dependencyReceipt.attemptId).toBe(pending.attemptId);
    expect(completed.dependencyReceipt.receiptDigest).not.toBe(
      previous.dependencyReceipt.receiptDigest
    );
    expect(
      readFileSync(
        join(workspace, 'logs', 'demo', 'feature', 'setup.log'),
        'utf8'
      )
    ).toEndWith('fixture refreshed dependencies\n');
    expect(
      await request({ ...input, refreshDependencies: true })
    ).toMatchObject({ code: 'SETUP_ATTEMPT_MISMATCH', ok: false });
    expect(launches).toBe(1);
    expect((await f.admission.status()).leases).toHaveLength(0);
  } finally {
    finishGroup();
    await settled;
    if (portal) {
      await portal.dispose();
    }
    await f.dispose();
  }
});
