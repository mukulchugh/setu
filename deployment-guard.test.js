import { expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createDeploymentGuard,
  createDeploymentLauncher,
  createProviderResolver,
  installedDeployTool,
} from './deployment-guard.js';
import { createPortalOperationOutcomes } from './portal-operation-outcomes.js';
import { createWorktreeLifecycle } from './worktree-lifecycle.js';

function fixture(options = {}) {
  let branch = 'actual-branch',
    identity = { checkout: { ino: '10' }, known: true },
    deploymentState = null,
    destination = {
      environment: 'production',
      id: 'prj_one',
      label: 'application',
      orgId: 'team_one',
      projectId: 'prj_one',
    };
  const launches = [];
  let finish;
  const completion = new Promise((resolve) => {
    finish = resolve;
  });
  const lifecycle = createWorktreeLifecycle({
    capacity: {},
    clock: { clearTimeout, now: () => 0, setTimeout },
    runtime: {},
    settings: {},
    validateTarget: () => {
      /* No side effect is needed in this fixture. */
      return Promise.resolve();
    },
  });
  const target = {
    key: 'repo/topic',
    name: 'topic',
    repo: 'repo',
    wtDir: '/isolated/topic',
  };
  const guard = createDeploymentGuard({
    branch: async () => branch,
    deploymentState: () => deploymentState,
    identity: async () => identity,
    launch: (launchRequest, binding) => {
      launches.push({ binding, request: launchRequest });
      return Promise.resolve({
        completion,
        result: { deploying: true, ok: true },
      });
    },
    operation: () => lifecycle.operationStatus(target.key),
    resolveProvider: async () => {
      await options.beforeResolve?.();
      return { destination, launch: { args: ['bound', destination.id] } };
    },
    revision: async () => ({ dirty: false, head: 'a'.repeat(40), known: true }),
    startOperation: (operationTarget, operationLaunch) =>
      lifecycle.startOperation(operationTarget, 'deploy', operationLaunch),
    target: () => target,
  });
  const request = {
    name: 'topic',
    provider: 'vercel',
    repo: 'repo',
    target: 'production',
  };
  return {
    change: (values) => {
      branch = values.branch ?? branch;
      identity = values.identity ?? identity;
      destination = values.destination ?? destination;
      deploymentState = values.deploymentState ?? deploymentState;
    },
    finish,
    guard,
    launches,
    lifecycle,
    request,
  };
}

test('production confirmation binds the real HEAD commit and dirty state', async () => {
  const wtDir = mkdtempSync(join(tmpdir(), 'setu-deploy-head-'));
  const git = (args) =>
    execFileSync('git', args, { cwd: wtDir, encoding: 'utf8' });
  git(['init']);
  git(['config', 'user.email', 'test@example.invalid']);
  git(['config', 'user.name', 'Test']);
  writeFileSync(join(wtDir, 'file.txt'), 'first\n');
  git(['add', 'file.txt']);
  git(['commit', '-m', 'first']);
  const target = { key: 'repo/topic', name: 'topic', repo: 'repo', wtDir };
  let launches = 0;
  const guard = createDeploymentGuard({
    branch: async () => 'main',
    deploymentState: () => null,
    identity: async () => ({ known: true }),
    launch: () => {
      launches += 1;
      return Promise.resolve({ ok: true });
    },
    operation: () => null,
    resolveProvider: async () => ({
      destination: { environment: 'production', id: 'target', label: 'target' },
      launch: { command: ['never'] },
    }),
    startOperation: async (_target, work) => work(),
    target: () => target,
  });
  const request = {
    name: 'topic',
    provider: 'vercel',
    repo: 'repo',
    target: 'production',
  };
  const confirmation = await guard.preflight(request);
  expect(confirmation.expectedContext.revision).toMatchObject({
    dirty: false,
    known: true,
  });
  writeFileSync(join(wtDir, 'file.txt'), 'second\n');
  git(['add', 'file.txt']);
  git(['commit', '-m', 'second']);
  expect(
    await guard.dispatch({
      ...request,
      expectedContext: confirmation.expectedContext,
    })
  ).toMatchObject({
    code: 'DEPLOY_CONTEXT_CHANGED',
    ok: false,
  });
  expect(launches).toBe(0);
});

test('production needs the exact preflight context and holds admission through completion', async () => {
  const f = fixture();
  expect(await f.guard.dispatch(f.request)).toMatchObject({
    code: 'DEPLOY_PREFLIGHT_REQUIRED',
    ok: false,
  });
  expect(f.launches).toHaveLength(0);
  const preflight = await f.guard.preflight(f.request);
  expect(preflight).toMatchObject({
    expectedContext: {
      branch: 'actual-branch',
      destination: { id: 'prj_one' },
    },
    ok: true,
    requiresConfirmation: true,
  });
  expect(
    await f.guard.dispatch({
      ...f.request,
      expectedContext: preflight.expectedContext,
    })
  ).toMatchObject({ deploying: true, ok: true });
  expect(f.launches[0].binding.args).toEqual(['bound', 'prj_one']);
  expect(
    await f.guard.dispatch({
      ...f.request,
      expectedContext: preflight.expectedContext,
    })
  ).toMatchObject({ ok: false });
  expect(f.launches).toHaveLength(1);
  expect(f.lifecycle.operationStatus('repo/topic')).toMatchObject({
    kind: 'deploy',
    phase: 'running',
  });
  f.finish();
  await f.lifecycle.waitForOperation({ key: 'repo/topic' });
});

test.each([
  { branch: 'different-branch' },
  { identity: { checkout: { ino: '11' }, known: true } },
  {
    destination: {
      environment: 'production',
      id: 'prj_other',
      label: 'replacement',
    },
  },
  { deploymentState: { startedAt: 200 } },
])(
  'changed checkout or deployment state invalidates confirmed intent: %#',
  async (change) => {
    const f = fixture();
    const before = await f.guard.preflight(f.request);
    f.change(change);
    expect(
      await f.guard.dispatch({
        ...f.request,
        expectedContext: before.expectedContext,
      })
    ).toMatchObject({ code: 'DEPLOY_CONTEXT_CHANGED', ok: false });
    expect(f.launches).toHaveLength(0);
  }
);

test('a changed target invalidates confirmed intent', async () => {
  const f = fixture(),
    before = await f.guard.preflight(f.request);
  expect(
    await f.guard.dispatch({
      ...f.request,
      expectedContext: before.expectedContext,
      target: 'preview',
    })
  ).toMatchObject({ code: 'DEPLOY_CONTEXT_CHANGED', ok: false });
  expect(f.launches).toHaveLength(0);
});

test('custom targets resolving to production require confirmation and duplicate admission permits one command', async () => {
  const f = fixture(),
    request = { ...f.request, target: 'custom-alias' };
  expect(await f.guard.dispatch(request)).toMatchObject({
    code: 'DEPLOY_PREFLIGHT_REQUIRED',
    ok: false,
  });
  const before = await f.guard.preflight(request);
  expect(before.requiresConfirmation).toBe(true);
  const attempts = await Promise.all([
    f.guard.dispatch({ ...request, expectedContext: before.expectedContext }),
    f.guard.dispatch({ ...request, expectedContext: before.expectedContext }),
  ]);
  expect(attempts.filter((result) => result.ok)).toHaveLength(1);
  expect(f.launches).toHaveLength(1);
  f.finish();
  await f.lifecycle.waitForOperation({ key: 'repo/topic' });
});

test('unknown checkout identity and unverifiable provider binding perform no deployment command', async () => {
  const f = fixture();
  f.change({ identity: { known: false } });
  expect(await f.guard.preflight(f.request)).toMatchObject({
    code: 'DEPLOY_IDENTITY_UNKNOWN',
    ok: false,
  });
  expect(await f.guard.dispatch(f.request)).toMatchObject({
    code: 'DEPLOY_IDENTITY_UNKNOWN',
    ok: false,
  });
  expect(f.launches).toHaveLength(0);
  let remoteCalls = 0;
  const base = {
    readJson: () =>
      Promise.resolve({ orgId: 'team_one', projectId: 'prj_one' }),
    run: () => {
      remoteCalls += 1;
      return Promise.resolve({
        code: 0,
        stdout: '{"id":"prj_other","accountId":"team_one","name":"wrong"}',
      });
    },
  };
  await expect(
    createProviderResolver({
      ...base,
      tool: () => Promise.resolve({ executable: '/vercel', version: '58.9.1' }),
    })({ provider: 'vercel', target: 'production' }, { wtDir: '/checkout' })
  ).rejects.toMatchObject({ code: 'DEPLOY_TARGET_UNVERIFIED' });
  await expect(
    createProviderResolver({
      ...base,
      tool: () => Promise.resolve({ executable: '/vercel', version: 'future' }),
    })({ provider: 'vercel', target: 'production' }, { wtDir: '/checkout' })
  ).rejects.toMatchObject({ code: 'DEPLOY_TARGET_UNVERIFIED' });
  expect(remoteCalls).toBe(1);
});

test('a replacement during deferred preflight cannot become confirmable', async () => {
  let release, entered;
  const waiting = new Promise((resolve) => {
    release = resolve;
  });
  const started = new Promise((resolve) => {
    entered = resolve;
  });
  const f = fixture({
    beforeResolve: async () => {
      entered();
      await waiting;
    },
  });
  const preflight = f.guard.preflight(f.request);
  await started;
  f.change({ identity: { checkout: { ino: 'replacement' }, known: true } });
  release();
  expect(await preflight).toMatchObject({
    code: 'DEPLOY_CONTEXT_CHANGED',
    ok: false,
  });
  expect(f.launches).toHaveLength(0);
});

test('explicitly resolved preview needs no production approval and preflight itself dispatches nothing', async () => {
  const f = fixture();
  f.change({
    destination: {
      environment: 'preview',
      id: 'preview-project',
      label: 'preview project',
    },
  });
  const request = { ...f.request, target: 'preview' };
  expect(await f.guard.preflight(request)).toMatchObject({
    ok: true,
    requiresConfirmation: false,
  });
  expect(f.launches).toHaveLength(0);
  expect(await f.guard.dispatch(request)).toMatchObject({
    deploying: true,
    ok: true,
  });
  f.finish();
  await f.lifecycle.waitForOperation({ key: 'repo/topic' });
});

test('unconfirmed deployment process exit retains lifetime ownership with an actionable unknown state', async () => {
  const stores = { vercel: new Map() };
  const launcher = createDeploymentLauncher({
    appendLog: () => {
      /* No side effect is needed in this fixture. */
    },
    closeLog: () => {
      /* No side effect is needed in this fixture. */
    },
    now: () => 1,
    openLog: () => 20,
    spawn: () => ({
      exited: Promise.reject(new Error('exit probe failed')),
      stdout: new Blob(['']).stream(),
    }),
    stores,
    tailError: () => '',
  });
  const result = launcher(
    { name: 'n', provider: 'vercel', repo: 'r', target: 'production' },
    { command: ['/vercel', 'deploy'], cwd: '/checkout' }
  );
  await expect(result.completion).rejects.toMatchObject({
    code: 'OPERATION_UNKNOWN',
  });
  expect(stores.vercel.get('r/n')).toMatchObject({
    deploying: true,
    phase: 'unknown',
  });
});

test('unknown deployment exit returns even while an output pipe remains open', async () => {
  const stores = { vercel: new Map() };
  let pipe, deadline;
  const launcher = createDeploymentLauncher({
    appendLog: () => {
      /* No side effect is needed in this fixture. */
    },
    closeLog: () => {
      /* No side effect is needed in this fixture. */
    },
    now: () => 1,
    openLog: () => 20,
    spawn: () => ({
      exited: Promise.reject(new Error('exit probe failed')),
      stdout: new ReadableStream({
        start(controller) {
          pipe = controller;
        },
      }),
    }),
    stores,
    tailError: () => '',
  });
  const result = launcher(
    { name: 'n', provider: 'vercel', repo: 'r', target: 'production' },
    { command: ['/vercel', 'deploy'], cwd: '/checkout' }
  );
  const settled = result.completion.then(
    () => ({ completed: true }),
    (error) => error
  );
  try {
    const outcome = await Promise.race([
      settled,
      new Promise((_, reject) => {
        deadline = setTimeout(
          () => reject(new Error('Unknown exit waited for output EOF')),
          500
        );
      }),
    ]);
    expect(outcome).toMatchObject({ code: 'OPERATION_UNKNOWN' });
    expect(stores.vercel.get('r/n')).toMatchObject({
      deploying: true,
      phase: 'unknown',
    });
  } finally {
    clearTimeout(deadline);
    pipe.close();
    await settled;
  }
});

test('failed output reading waits for confirmed exit before releasing deployment ownership', async () => {
  let finish, readFailed;
  const exited = new Promise((resolve) => {
    finish = resolve;
  });
  const observedReadFailure = new Promise((resolve) => {
    readFailed = resolve;
  });
  const stores = { vercel: new Map() };
  const launcher = createDeploymentLauncher({
    appendLog: () => {
      /* No side effect is needed in this fixture. */
    },
    closeLog: () => {
      /* No side effect is needed in this fixture. */
    },
    now: () => 1,
    openLog: () => 20,
    spawn: () => ({
      exited,
      stdout: {
        getReader: () => ({
          read: () => Promise.reject(new Error('pipe failed')),
          releaseLock: readFailed,
        }),
      },
    }),
    stores,
    tailError: () => '',
  });
  const result = launcher(
    { name: 'n', provider: 'vercel', repo: 'r', target: 'production' },
    { command: ['/vercel', 'deploy'], cwd: '/checkout' }
  );
  await observedReadFailure;
  expect(stores.vercel.get('r/n')).toMatchObject({
    deploying: true,
    error: null,
  });
  finish(0);
  await result.completion;
  expect(stores.vercel.get('r/n')).toMatchObject({
    deploying: false,
    error:
      'Deployment finished but its output could not be read; inspect provider status',
  });
});

test('provider result handling retains Netlify site checks and Convex success without a URL', async () => {
  const stores = { convex: new Map(), netlify: new Map() },
    spawns = [];
  let output = '{"site_id":"unexpected","url":"https://wrong.invalid"}';
  const recorded = [];
  const outcomes = createPortalOperationOutcomes({
    events: {
      record: (event) => {
        recorded.push(event);
        return Promise.resolve({ ok: true });
      },
    },
  });
  const launcher = createDeploymentLauncher({
    appendLog: () => {
      /* No side effect is needed in this fixture. */
    },
    closeLog: () => {
      /* No side effect is needed in this fixture. */
    },
    env: { CONVEX_DEPLOY_KEY: 'inherited-key', PATH: '/fixture/bin' },
    now: () => 1,
    openLog: () => 20,
    spawn: (command, options) => {
      spawns.push({ command, options });
      return {
        exited: Promise.resolve(0),
        stderr: new Blob(['']).stream(),
        stdout: new Blob([output]).stream(),
      };
    },
    stores,
    tailError: () => 'CLI failed',
  });
  const request = {
    name: 'topic',
    provider: 'netlify',
    repo: 'repo',
    target: 'preview',
  };
  const first = await launcher(request, {
    command: ['netlify', 'deploy'],
    cwd: '/checkout',
    linkedSiteId: 'expected',
  });
  const handle = await outcomes.accept({ kind: 'deploy' });
  expect(await outcomes.watch(handle, first.completion)).toMatchObject({
    code: 'DEPLOY_FAILED',
    ok: false,
  });
  expect(recorded.at(-1).state).toBe('failed');
  expect(stores.netlify.get('repo/topic')).toMatchObject({
    deploying: false,
    url: null,
  });
  expect(stores.netlify.get('repo/topic').error).toContain('different site');
  output = 'Deployment complete';
  const second = await launcher(
    { ...request, provider: 'convex', target: 'production' },
    {
      command: ['/installed/convex', 'deploy'],
      cwd: '/checkout',
      env: { CONVEX_DEPLOY_KEY: 'project-key' },
    }
  );
  await expect(second.completion).resolves.toMatchObject({ ok: true });
  expect(stores.convex.get('repo/topic')).toMatchObject({
    deploying: false,
    ok: true,
  });
  expect(spawns[1].command).toEqual(['/installed/convex', 'deploy']);
  expect(spawns[1].options.stdin).toBe('ignore');
  expect(spawns[1].options.env).toEqual({
    CONVEX_DEPLOY_KEY: 'project-key',
    PATH: '/fixture/bin',
  });
});

test('deployment preflight resolves an installed monorepo CLI without executing it', async () => {
  const root = mkdtempSync(join(tmpdir(), 'setu-deploy-tool-'));
  try {
    const app = join(root, 'apps', 'web');
    const bin = join(root, 'node_modules', '.bin');
    const pkg = join(root, 'node_modules', 'convex');
    mkdirSync(app, { recursive: true });
    mkdirSync(bin, { recursive: true });
    mkdirSync(pkg, { recursive: true });
    writeFileSync(
      join(pkg, 'package.json'),
      JSON.stringify({ name: 'convex', version: '1.42.0' })
    );
    const executable = join(pkg, 'cli.js');
    writeFileSync(executable, '#!/bin/sh\nexit 99\n');
    chmodSync(executable, 0o755);
    symlinkSync(executable, join(bin, 'convex'));
    const installed = await installedDeployTool(
      'convex',
      { checkoutRoot: root, wtDir: app },
      { which: () => null }
    );
    expect(installed).toEqual({
      executable: realpathSync(executable),
      version: '1.42.0',
    });
    const resolver = createProviderResolver({
      convexDeployKey: async () => ({
        value: 'preview:team:project|private-test-key',
      }),
      tool: (provider, checkout) =>
        installedDeployTool(provider, checkout, { which: () => null }),
    });
    const resolved = await resolver(
      { provider: 'convex', target: 'topic' },
      { checkoutRoot: root, wtDir: app }
    );
    expect(resolved.launch).toMatchObject({
      command: [realpathSync(executable), 'deploy', '--preview-name', 'topic'],
      cwd: app,
      env: { CONVEX_DEPLOY_KEY: 'preview:team:project|private-test-key' },
    });
    expect(
      JSON.stringify({
        binding: resolved.binding,
        destination: resolved.destination,
      })
    ).not.toContain('private-test-key');
    expect(
      await installedDeployTool('convex', { wtDir: app }, { which: () => null })
    ).toBeNull();
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test('a log-close error after spawn still retains completion ownership', async () => {
  let finish;
  const exited = new Promise((resolve) => {
    finish = resolve;
  });
  const stores = { vercel: new Map() };
  const launcher = createDeploymentLauncher({
    appendLog: () => {
      /* No side effect is needed in this fixture. */
    },
    closeLog: () => {
      throw new Error('close failed');
    },
    now: () => 1,
    openLog: () => 20,
    spawn: () => ({
      exited,
      stdout: new Blob(['https://deployment.invalid']).stream(),
    }),
    stores,
    tailError: () => '',
  });
  const launched = launcher(
    { name: 'n', provider: 'vercel', repo: 'r', target: 'production' },
    { command: ['vercel', 'deploy'], cwd: '/checkout' }
  );
  expect(launched.result.ok).toBe(true);
  expect(stores.vercel.get('r/n').deploying).toBe(true);
  finish(0);
  await launched.completion;
  expect(stores.vercel.get('r/n')).toMatchObject({
    deploying: false,
    error: 'Deployment finished but its log descriptor could not be closed',
  });
});

test('a diagnostic read failure after confirmed exit clears only its own active status', async () => {
  const stores = { vercel: new Map() };
  const launcher = createDeploymentLauncher({
    appendLog: () => {
      /* No side effect is needed in this fixture. */
    },
    closeLog: () => {
      /* No side effect is needed in this fixture. */
    },
    now: () => 1,
    openLog: () => 20,
    spawn: () => ({
      exited: Promise.resolve(1),
      stdout: new Blob(['']).stream(),
    }),
    stores,
    tailError: () => {
      throw new Error('diagnostic unavailable');
    },
  });
  const launched = launcher(
    { name: 'n', provider: 'vercel', repo: 'r', target: 'production' },
    { command: ['vercel', 'deploy'], cwd: '/checkout' }
  );
  await expect(launched.completion).rejects.toThrow();
  expect(stores.vercel.get('r/n')).toMatchObject({
    deploying: false,
    error:
      'Deployment exited but its result could not be recorded; inspect provider status',
  });
});

test('Vercel resolves authority read-only and binds explicit project, owner and preview', async () => {
  const calls = [];
  const resolver = createProviderResolver({
    readJson: () =>
      Promise.resolve({ orgId: 'team_one', projectId: 'prj_one' }),
    run: (args, options) => {
      calls.push({ args, options });
      return Promise.resolve({
        code: 0,
        stdout: JSON.stringify({
          accountId: 'team_one',
          id: 'prj_one',
          name: 'actual-project',
        }),
      });
    },
    tool: () =>
      Promise.resolve({ executable: '/installed/vercel', version: '58.9.1' }),
  });
  const result = await resolver(
    { provider: 'vercel', target: 'preview' },
    { wtDir: '/checkout' }
  );
  expect(calls[0].args).toEqual([
    '/installed/vercel',
    'api',
    '/v9/projects/prj_one?teamId=team_one',
    '--method',
    'GET',
    '--raw',
    '--scope',
    'team_one',
  ]);
  expect(result.destination).toEqual({
    environment: 'preview',
    id: 'prj_one',
    label: 'actual-project',
    orgId: 'team_one',
    projectId: 'prj_one',
  });
  expect(result.launch.command).toEqual([
    '/installed/vercel',
    'deploy',
    '--yes',
    '--target=preview',
    '--project',
    'prj_one',
    '--scope',
    'team_one',
  ]);
});

test('unknown provider inspection command completion remains unknown to the lifecycle owner', async () => {
  const resolver = createProviderResolver({
    readJson: () =>
      Promise.resolve({ orgId: 'team_one', projectId: 'prj_one' }),
    run: () =>
      Promise.reject(
        Object.assign(new Error('inspection exit unknown'), {
          code: 'OPERATION_UNKNOWN',
        })
      ),
    tool: () =>
      Promise.resolve({ executable: '/installed/vercel', version: '58.9.1' }),
  });
  await expect(
    resolver(
      { provider: 'vercel', target: 'production' },
      { wtDir: '/checkout' }
    )
  ).rejects.toMatchObject({ code: 'OPERATION_UNKNOWN' });
});

test('Netlify binds production and explicit aliases to its linked site, and Convex remains refused without a verified key identity', async () => {
  let probes = 0;
  const resolver = createProviderResolver({
    readJson: () =>
      Promise.resolve({ siteId: '11111111-2222-3333-4444-555555555555' }),
    run: () => {
      probes += 1;
      return Promise.resolve();
    },
    tool: () =>
      Promise.resolve({
        executable: '/installed/netlify',
        version: 'unknown',
      }),
  });
  const result = await resolver(
    { provider: 'netlify', target: 'preview' },
    { wtDir: '/checkout' }
  );
  expect(result.destination.environment).toBe('preview');
  expect(result.launch.command).toEqual([
    '/installed/netlify',
    'deploy',
    '--json',
    '--site',
    '11111111-2222-3333-4444-555555555555',
  ]);
  expect(result.launch.linkedSiteId).toBe(
    '11111111-2222-3333-4444-555555555555'
  );
  const production = await resolver(
    { provider: 'netlify', target: 'production' },
    { wtDir: '/checkout' }
  );
  expect(production.destination).toMatchObject({
    environment: 'production',
    id: '11111111-2222-3333-4444-555555555555',
  });
  expect(production.launch.command).toContain('--prod');
  const alias = await resolver(
    { provider: 'netlify', target: 'review-42' },
    { wtDir: '/checkout' }
  );
  expect(alias.destination).toMatchObject({
    environment: 'custom',
    label: '11111111-2222-3333-4444-555555555555 alias review-42',
  });
  expect(alias.launch.command).toContain('--alias');
  expect(alias.launch.command).toContain('review-42');
  await expect(
    resolver({ provider: 'convex', target: 'preview' }, {})
  ).rejects.toMatchObject({ code: 'DEPLOY_TARGET_UNVERIFIED' });
  expect(probes).toBe(0);
});

test('Convex binds production keys and explicit preview names without provider discovery', async () => {
  const resolver = createProviderResolver({
    convexDeployKey: () =>
      Promise.resolve({ value: 'preview:team-one:project-one|secret' }),
    readJson: () => Promise.resolve({}),
    run: () => Promise.reject(new Error('no discovery')),
    tool: () =>
      Promise.resolve({ executable: '/installed/convex', version: '1.0.0' }),
  });
  const preview = await resolver(
    { provider: 'convex', target: 'review-42' },
    { wtDir: '/checkout' }
  );
  expect(preview.destination).toMatchObject({
    environment: 'custom',
    id: 'team-one/project-one/review-42',
  });
  expect(preview.launch.command).toEqual([
    '/installed/convex',
    'deploy',
    '--preview-name',
    'review-42',
  ]);
  const production = createProviderResolver({
    convexDeployKey: async () => ({
      value: 'prod:qualified-jaguar-123|secret',
    }),
    readJson: async () => ({}),
    run: async () => ({}),
    tool: async () => ({ executable: '/installed/convex', version: '1.0.0' }),
  });
  expect(
    (
      await production(
        { provider: 'convex', target: 'production' },
        { wtDir: '/checkout' }
      )
    ).launch.command
  ).toEqual(['/installed/convex', 'deploy']);
});
