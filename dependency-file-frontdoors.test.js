import { expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import {
  readFile as readFileAsync,
  realpath,
  stat as statAsync,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inspectCheckoutIdentity } from './checkout-identity.js';
import { classifyDependencyRuntime, runCli } from './cli.js';
import {
  cloneDependencyFile,
  exchangeDependencyFiles,
  readDependencyFile,
  removeDependencyBackup,
  restoreDependencyTimes,
  sameDependencyFile,
  syncDependencyDirectory,
  withDependencyFileLease,
} from './dependency-file-native.js';
import { handleMcpRequest, initMcpServer } from './mcp-server.js';
import { createResourceAdmission } from './resource-admission.js';
import { createSetupInstallProcesses } from './setup-install-process.js';
import { createSetupProgress } from './setup-progress.js';
import { createWorkspaceState } from './workspace-state.js';

const MCP_EVENT = /^data: (.+)$/m;

function stoppedRuntimeRow(overrides = {}) {
  return {
    active: false,
    convexActive: false,
    inngestActive: false,
    operation: null,
    phase: 'stopped',
    queued: false,
    sidecars: [],
    starting: false,
    stopping: false,
    triggerActive: false,
    ...overrides,
  };
}

async function runCliCaptured(argv, response = { ok: true }) {
  const calls = [];
  const output = [];
  const errors = [];
  const previousLog = console.log;
  const previousError = console.error;
  const previousExitCode = process.exitCode;
  console.log = (value) => output.push(String(value));
  console.error = (value) => errors.push(String(value));
  try {
    const code = await runCli(argv, {
      request: (request) => {
        calls.push(request);
        return typeof response === 'function' ? response(request) : response;
      },
    });
    return {
      calls,
      code,
      errors,
      output,
      value: output[0] ? JSON.parse(output[0]) : undefined,
    };
  } finally {
    console.log = previousLog;
    console.error = previousError;
    process.exitCode = previousExitCode;
  }
}

async function mcpRequest(name, args, port) {
  const request = new Request(`http://localhost:${port}/mcp`, {
    body: JSON.stringify({
      id: 1,
      jsonrpc: '2.0',
      method: 'tools/call',
      params: { arguments: args, name },
    }),
    headers: {
      accept: 'application/json, text/event-stream',
      'content-type': 'application/json',
      host: `localhost:${port}`,
      origin: `http://localhost:${port}`,
    },
    method: 'POST',
  });
  const response = await handleMcpRequest(request, port);
  const event = (await response.text()).match(MCP_EVENT)?.[1];
  if (!event) {
    throw new Error('In-memory MCP request returned no message event');
  }
  return { response, rpc: JSON.parse(event) };
}

function mcpValue(rpc) {
  const { result } = rpc;
  if (result?.structuredContent) {
    return result.structuredContent;
  }
  const message = result?.content?.find((entry) => entry.type === 'text')?.text;
  return message ? JSON.parse(message) : undefined;
}

test('CLI setup waits for the real owned-process factory to confirm group settlement through an OS seam', async () => {
  const root = mkdtempSync(join(tmpdir(), 'setu-cli-owned-install-'));
  const wtDir = join(root, 'repo', 'topic');
  const target = { name: 'topic', repo: 'repo' };
  const identity = { checkoutPath: wtDir, known: true };
  const logLocation = join(root, 'logs', 'setup.log');
  const state = createWorkspaceState({
    configPath: join(root, 'setu.json'),
    setuDir: root,
    workspaceRoot: root,
  });
  const progress = createSetupProgress({
    newAttemptId: () => 'cli-owned-install-attempt',
    state,
  });
  await progress.start({
    checkoutIdentity: identity,
    logLocation,
    stage: 'installing',
    target,
  });
  const checkout = wtDir;
  mkdirSync(checkout, { recursive: true });
  writeFileSync(join(checkout, 'package.json'), '{"name":"fixture"}');

  const child = new EventEmitter();
  child.pid = 43_124;
  child.stdin = {
    end() {
      // The fixture only needs the real owner's gate interface.
    },
    on() {
      // This deterministic child never emits stream errors.
    },
  };
  const startIdentity = 'Mon Sep 15 12:34:56 2025';
  let rows = [
    {
      groupId: child.pid,
      parentPid: 1,
      pid: child.pid,
      processStartIdentity: startIdentity,
    },
  ];
  const signals = [];
  let processManager;
  const previousLog = console.log;
  const previousError = console.error;
  const previousExitCode = process.exitCode;
  console.log = () => {
    // Keep the CLI's success JSON out of test output.
  };
  console.error = previousError;
  try {
    const code = await runCli(['new', 'repo', 'topic', '--bare', '--json'], {
      newCommand: {
        config: () => ({ workspace: root }),
        createAndInstallWorktree: ({ install }) =>
          install(checkout, {
            assertStorage: async () => {
              // No real storage work is needed for this process ownership test.
            },
            checkoutIdentity: identity,
            logLocation,
            progress,
            setup: { record: progress.get(target) },
            target,
          }).then(() => ({
            localDom: 'topic.setu.local',
            port: 3101,
            wtDir: checkout,
          })),
        createSetupInstallProcesses: () => {
          processManager = createSetupInstallProcesses({
            readSnapshot: () => rows,
            signal: (_pid, value) => {
              signals.push(value);
              rows = [];
            },
            spawnChild: () => {
              queueMicrotask(() => child.emit('close', 0, null));
              return child;
            },
          });
          return processManager;
        },
        dependencySharingForTarget: () => ({ enabled: false }),
        operationId: () => 'cli-owned-install-operation',
        workspaceState: () => state,
      },
    });
    expect(code).toBe(0);
    expect(signals).toEqual(['SIGTERM']);
    expect(progress.get(target)).toMatchObject({ state: 'completed' });
    expect(() => processManager.spawn(['fixture'], { cwd: checkout })).toThrow(
      'Setup process owner is closed'
    );
  } finally {
    console.log = previousLog;
    console.error = previousError;
    process.exitCode = previousExitCode;
    rmSync(root, { force: true, recursive: true });
  }
});

test('CLI new owns only its factory and closes it after the awaited setup tail', async () => {
  const root = mkdtempSync(join(tmpdir(), 'setu-cli-native-lifetime-'));
  const state = createWorkspaceState({
    configPath: join(root, 'setu.json'),
    setuDir: root,
    workspaceRoot: root,
  });
  const previousLog = console.log;
  const previousError = console.error;
  const previousExitCode = process.exitCode;
  let runNumber = 0;
  const makeFactory = (close) => ({
    close,
  });
  const run = async ({ borrowed, close, failTail = false } = {}) => {
    const events = [];
    const factory = makeFactory(async () => {
      events.push('close');
      await close?.();
    });
    const newCommand = {
      autoInstall: () => {
        events.push('install-settled');
      },
      config: () => ({ workspace: root }),
      createAndInstallWorktree: async ({ install }) => {
        await install(join(root, 'repo', 'topic'), {});
        events.push('setup-tail');
        if (failTail) {
          throw new Error('setup tail failed');
        }
        return { localDom: 'topic.setu.local', port: 3101, wtDir: root };
      },
      dependencySharingForTarget: () => ({ enabled: true }),
      operationId: () => {
        runNumber += 1;
        return `native-lifetime-${runNumber}`;
      },
      workspaceState: () => state,
      ...(borrowed
        ? { dependencyFileNative: factory }
        : { createDependencyFileNative: () => factory }),
    };
    const code = await runCli(['new', 'repo', 'topic', '--bare', '--json'], {
      newCommand,
    });
    return { code, events };
  };

  try {
    console.log = () => {
      // Suppress the CLI result for this ownership-focused test.
    };
    console.error = () => {
      // Suppress the expected failure output for this ownership-focused test.
    };

    const success = await run();
    expect(success.code).toBe(0);
    expect(success.events).toEqual(['install-settled', 'setup-tail', 'close']);

    const failedTail = await run({ failTail: true });
    expect(failedTail.code).toBe(1);
    expect(failedTail.events).toEqual([
      'install-settled',
      'setup-tail',
      'close',
    ]);

    const borrowed = await run({ borrowed: true });
    expect(borrowed.code).toBe(0);
    expect(borrowed.events).toEqual(['install-settled', 'setup-tail']);

    const uncertainClose = await run({
      close: () => Promise.reject(new Error('native helper did not settle')),
    });
    expect(uncertainClose.code).toBe(1);
    expect(uncertainClose.events).toEqual([
      'install-settled',
      'setup-tail',
      'close',
    ]);
  } finally {
    console.log = previousLog;
    console.error = previousError;
    process.exitCode = previousExitCode;
    rmSync(root, { force: true, recursive: true });
  }
});

test('dependencies CLI preserves reads and maps all five reviewed operations exactly', async () => {
  const cases = [
    {
      argv: ['dependencies', '--json'],
      method: 'GET',
      path: '/api/dependency-sharing',
    },
    {
      argv: ['dependencies', 'project', 'topic', '--json'],
      method: 'GET',
      path: '/api/dependency-sharing?name=topic&repo=project',
    },
    {
      argv: ['dependencies', 'verify', 'project', 'topic', '--json'],
      body: { name: 'topic', repo: 'project' },
      method: 'POST',
      path: '/api/dependency-sharing/verify',
    },
    {
      argv: ['dependencies', 'repair', 'project', 'topic', '--json'],
      body: { name: 'topic', repo: 'project' },
      method: 'POST',
      path: '/api/dependency-sharing/repair',
    },
    {
      argv: ['dependencies', 'prepare', 'project', 'topic', '--json'],
      body: { name: 'topic', repo: 'project' },
      method: 'POST',
      path: '/api/dependency-sharing/prepare',
    },
    {
      argv: [
        'dependencies',
        'apply',
        'project',
        'topic',
        '--plan-id',
        'plan-7',
        '--confirm',
        'review-7',
        '--json',
      ],
      body: {
        confirmation: 'review-7',
        name: 'topic',
        planId: 'plan-7',
        repo: 'project',
      },
      method: 'POST',
      path: '/api/dependency-sharing/apply',
    },
    {
      argv: [
        'dependencies',
        'recover',
        'project',
        'topic',
        '--operation-id',
        'operation-8',
        '--json',
      ],
      body: { name: 'topic', operationId: 'operation-8', repo: 'project' },
      method: 'POST',
      path: '/api/dependency-sharing/recover',
    },
    {
      argv: [
        'dependencies',
        'prepare-release',
        'project',
        'topic',
        '--operation-id',
        'operation-9',
        '--json',
      ],
      body: { name: 'topic', operationId: 'operation-9', repo: 'project' },
      method: 'POST',
      path: '/api/dependency-sharing/prepare-release',
    },
    {
      argv: [
        'dependencies',
        'release',
        'project',
        'topic',
        '--release-id',
        'release-10',
        '--confirm',
        'review-10',
        '--json',
      ],
      body: {
        confirmation: 'review-10',
        name: 'topic',
        releaseId: 'release-10',
        repo: 'project',
      },
      method: 'POST',
      path: '/api/dependency-sharing/release',
    },
  ];

  for (const { argv, ...expected } of cases) {
    // Each run resets the CLI's module-level parser state before the next command.
    // biome-ignore lint/performance/noAwaitInLoops: Each command resets shared CLI parser state before the next run.
    const result = await runCliCaptured(argv, { ok: true });
    expect(result.code).toBe(0);
    expect(result.calls).toHaveLength(1);
    expect(result.calls[0]).toMatchObject({
      ...expected,
      headers: expect.objectContaining({ 'x-setu-source': 'cli' }),
    });
  }
});

test('dependencies CLI requires exact operation identifiers and rejects generic confirmation flags', async () => {
  const invalidCommands = [
    [
      'dependencies',
      'apply',
      'project',
      'topic',
      '--operation-id',
      'op-1',
      '--confirm',
      'review-1',
    ],
    [
      'dependencies',
      'apply',
      'project',
      'topic',
      '--plan-id',
      'plan-1',
      '--operation-id',
      'op-1',
    ],
    ['dependencies', 'recover', 'project', 'topic'],
    ['dependencies', 'prepare-release', 'project', 'topic'],
    [
      'dependencies',
      'release',
      'project',
      'topic',
      '--release-id',
      'release-1',
    ],
    ['dependencies', 'release', 'project', 'topic', '--confirm', 'review-1'],
    ['dependencies', 'prepare', 'project', 'topic', '--yes'],
    [
      'dependencies',
      'apply',
      'project',
      'topic',
      '--plan-id',
      'plan-1',
      '--operation-id',
      'op-1',
      '--confirm',
      'review-1',
      '--yes',
    ],
  ];

  for (const argv of invalidCommands) {
    // biome-ignore lint/performance/noAwaitInLoops: Each command resets shared CLI parser state before the next run.
    const result = await runCliCaptured(argv);
    expect(result.code).toBe(1);
    expect(result.calls).toHaveLength(0);
    expect(result.errors.join('\n')).toContain('error:');
  }
});

test('dependencies CLI preserves unknown operation outcomes and recovery identity', async () => {
  const unknown = {
    code: 'DEPENDENCY_OPERATION_UNKNOWN',
    ok: false,
    operationId: 'operation-11',
    recovery: { operationId: 'operation-11' },
    state: 'unknown',
  };
  const result = await runCliCaptured(
    [
      'dependencies',
      'apply',
      'project',
      'topic',
      '--plan-id',
      'plan-11',
      '--operation-id',
      'operation-11',
      '--confirm',
      'review-11',
      '--json',
    ],
    unknown
  );
  expect(result.code).toBe(1);
  expect(result.value).toEqual(unknown);
});

test('fresh CLI preflight grants temporary setup authority and reaches the production native capability check', async () => {
  const root = await realpath(
    mkdtempSync(join(tmpdir(), 'setu-fresh-enrollment-'))
  );
  const workspace = join(root, 'workspace');
  const repoDir = join(workspace, 'repo.git');
  const seedDir = join(root, 'seed');
  const checkout = join(workspace, 'repo', 'topic');
  const storeRoot = join(root, 'shared-store');
  const target = { name: 'topic', repo: 'repo' };
  const runGit = (args, cwd) =>
    execFileSync('git', args, { cwd, stdio: 'ignore' });
  runGit(['init', '--bare', repoDir]);
  runGit(['clone', repoDir, seedDir]);
  runGit(['config', 'user.email', 'fixture@example.invalid'], seedDir);
  runGit(['config', 'user.name', 'Fixture'], seedDir);
  writeFileSync(join(seedDir, 'package.json'), '{"name":"fixture"}');
  runGit(['add', 'package.json'], seedDir);
  runGit(['commit', '-m', 'fixture'], seedDir);
  runGit(['push', 'origin', 'HEAD:main'], seedDir);
  runGit(['symbolic-ref', 'HEAD', 'refs/heads/main'], repoDir);
  mkdirSync(join(workspace, 'repo'), { recursive: true });
  runGit(['worktree', 'add', '-b', 'topic', checkout, 'main'], repoDir);
  mkdirSync(storeRoot, { mode: 0o700 });
  const canonicalStore = await realpath(storeRoot);
  const storeStat = statSync(canonicalStore);
  const state = createWorkspaceState({
    configPath: join(root, 'setu.json'),
    setuDir: root,
    workspaceRoot: workspace,
  });
  await state.replace('ports', [
    { key: 'repo/topic', name: 'topic', port: 3101, repo: 'repo' },
  ]);
  const previousLog = console.log;
  const previousError = console.error;
  const previousExitCode = process.exitCode;
  const output = [];
  const errors = [];
  let installerStarted = false;
  let nativeCapabilityChecks = 0;
  let nativeCapabilityAvailable = false;
  let progress;
  const identity = await inspectCheckoutIdentity(
    {
      repoDir,
      wtDir: checkout,
    },
    {
      readFile: readFileAsync,
      realpath,
      stat: statAsync,
    }
  );
  const dependencySharing = {
    enabled: true,
    executable: await realpath(
      process.env.SETU_TEST_DEPENDENCY_BUN ?? process.execPath
    ),
    storeIdentity: { device: storeStat.dev, mountPath: root },
    storeRoot: canonicalStore,
    targets: { 'repo/topic': true },
    version: '1.3.14',
    workspaceRoot: workspace,
  };
  const native = {
    cloneDependencyFile,
    dependencyFileNativeStatus: () => {
      nativeCapabilityChecks += 1;
      return { available: nativeCapabilityAvailable };
    },
    exchangeDependencyFiles,
    readDependencyFile,
    removeDependencyBackup,
    restoreDependencyTimes,
    sameDependencyFile,
    syncDependencyDirectory,
    withDependencyFileLease,
  };
  try {
    console.log = (value) => output.push(String(value));
    console.error = (value) => errors.push(String(value));
    const code = await runCli(['new', 'repo', 'topic', '--bare', '--json'], {
      newCommand: {
        autoInstall: async (path, _sharing, _stdio, options) => {
          const context = {
            admissionOperationId: 'lease-1',
            attemptId: progress.get(target).attemptId,
            checkoutIdentity: identity,
            installerSettled: false,
            target,
          };
          await expect(
            options.prepareHoistedDependencySharing(target, {
              ...context,
              checkoutIdentity: {
                ...identity,
                checkoutPath: '/stale/checkout',
              },
            })
          ).rejects.toMatchObject({ code: 'ADMISSION_STATE_UNKNOWN' });
          await expect(
            options.prepareHoistedDependencySharing(target, context)
          ).rejects.toMatchObject({
            code: 'DEPENDENCY_FILE_NATIVE_UNAVAILABLE',
          });
          nativeCapabilityAvailable = true;
          await expect(
            options.prepareHoistedDependencySharing(target, context)
          ).resolves.toMatchObject({ ok: true });
          installerStarted = true;
          expect(path).toBe(checkout);
        },
        config: () => ({ dependencySharing, workspace }),
        createAndInstallWorktree: async ({ admission, install }) => {
          const lease = await admission.admit({
            kind: 'install',
            operationId: 'lease-1',
            target,
          });
          if (!lease.ok) {
            throw new Error(JSON.stringify(lease));
          }
          await progress.start({
            checkoutIdentity: identity,
            logLocation: join(root, 'setup.log'),
            stage: 'dependency-enrollment-preflight',
            target,
          });
          await install(checkout, { record: progress.get(target) });
          return { ok: true, wtDir: checkout };
        },
        createHostHealth: () => async () => ({
          availableBytes: Number.MAX_SAFE_INTEGER,
          state: 'ready',
        }),
        createResourceAdmission: (options) =>
          createResourceAdmission({
            ...options,
            observeProcess: async (pid) => ({
              processId: pid,
              processStartIdentity: 'fixture-process-start',
              state: 'alive',
            }),
          }),
        createSetupProgress: (options) => {
          progress = createSetupProgress(options);
          return progress;
        },
        dependencyFileNative: native,
        operationId: () => 'new-setup-1',
        workspaceState: () => state,
      },
      request: (request) => {
        expect(request.method).toBe('GET');
        expect(request.path).toBe('/api/worktrees?snapshot=1');
        return {
          checkedAt: Date.now(),
          listenerObservation: { observedAt: Date.now(), state: 'ready' },
          status: {},
          worktrees: [
            {
              ...stoppedRuntimeRow(),
              name: 'topic',
              nextStartMode: 'bare',
              repo: 'repo',
            },
          ],
        };
      },
    });
    expect(JSON.parse(output[0])).toMatchObject({ ok: true });
    expect(code).toBe(0);
    expect(installerStarted).toBe(true);
    expect(nativeCapabilityChecks).toBeGreaterThan(0);
    expect(JSON.parse(output[0])).toMatchObject({ ok: true, wtDir: checkout });
    expect(errors).toEqual([]);
  } finally {
    console.log = previousLog;
    console.error = previousError;
    process.exitCode = previousExitCode;
    rmSync(root, { force: true, recursive: true });
  }
});

test('fresh CLI enrollment refuses an unknown portal listener snapshot before starting the installer', async () => {
  const root = mkdtempSync(join(tmpdir(), 'setu-fresh-enrollment-unknown-'));
  const state = createWorkspaceState({
    configPath: join(root, 'setu.json'),
    setuDir: root,
    workspaceRoot: root,
  });
  const previousLog = console.log;
  const previousError = console.error;
  const previousExitCode = process.exitCode;
  const output = [];
  let installerStarted = false;
  try {
    console.log = (value) => output.push(String(value));
    console.error = () => {
      // The CLI reports the expected fail-closed setup result as JSON.
    };
    const code = await runCli(['new', 'repo', 'topic', '--bare', '--json'], {
      newCommand: {
        autoInstall: async (_path, _sharing, _stdio, options) => {
          await options.prepareHoistedDependencySharing(
            { name: 'topic', repo: 'repo' },
            {
              admissionOperationId: 'lease-2',
              attemptId: 'attempt-2',
              checkoutIdentity: { known: true },
              target: { name: 'topic', repo: 'repo' },
            }
          );
          installerStarted = true;
        },
        config: () => ({ workspace: root }),
        createAndInstallWorktree: ({ install }) =>
          install(join(root, 'repo', 'topic'), {}),
        dependencySharingForTarget: () => ({
          enabled: true,
          strategy: 'hoisted-cow',
        }),
        operationId: () => 'new-setup-2',
        workspaceState: () => state,
      },
      request: async () => ({
        checkedAt: Date.now(),
        listenerObservation: { observedAt: Date.now(), state: 'unknown' },
        status: {},
        worktrees: [{ name: 'topic', nextStartMode: 'bare', repo: 'repo' }],
      }),
    });
    expect(code).toBe(1);
    expect(installerStarted).toBe(false);
    expect(JSON.parse(output[0])).toMatchObject({
      code: 'CONTAINER_MODE_UNKNOWN',
      ok: false,
      operationId: 'new-setup-2',
    });
  } finally {
    console.log = previousLog;
    console.error = previousError;
    process.exitCode = previousExitCode;
    rmSync(root, { force: true, recursive: true });
  }
});

test('fresh CLI enrollment refuses a stale portal snapshot before starting the installer', async () => {
  const root = mkdtempSync(join(tmpdir(), 'setu-fresh-enrollment-stale-'));
  const state = createWorkspaceState({
    configPath: join(root, 'setu.json'),
    setuDir: root,
    workspaceRoot: root,
  });
  const previousLog = console.log;
  const previousError = console.error;
  const previousExitCode = process.exitCode;
  const output = [];
  let installerStarted = false;
  try {
    console.log = (value) => output.push(String(value));
    console.error = () => {
      // The CLI emits the expected fail-closed result as JSON.
    };
    const code = await runCli(['new', 'repo', 'topic', '--bare', '--json'], {
      newCommand: {
        autoInstall: async (_path, _sharing, _stdio, options) => {
          await options.prepareHoistedDependencySharing(
            { name: 'topic', repo: 'repo' },
            {
              admissionOperationId: 'lease-3',
              attemptId: 'attempt-3',
              checkoutIdentity: { known: true },
              target: { name: 'topic', repo: 'repo' },
            }
          );
          installerStarted = true;
        },
        config: () => ({ workspace: root }),
        createAndInstallWorktree: ({ install }) =>
          install(join(root, 'repo', 'topic'), {}),
        dependencySharingForTarget: () => ({
          enabled: true,
          strategy: 'hoisted-cow',
        }),
        operationId: () => 'new-setup-3',
        workspaceState: () => state,
      },
      request: async () => ({
        checkedAt: Date.now() - 2000,
        listenerObservation: { observedAt: Date.now(), state: 'ready' },
        status: {},
        worktrees: [{ name: 'topic', nextStartMode: 'bare', repo: 'repo' }],
      }),
    });
    expect(code).toBe(1);
    expect(installerStarted).toBe(false);
    expect(JSON.parse(output[0])).toMatchObject({
      code: 'CONTAINER_MODE_UNKNOWN',
      ok: false,
      operationId: 'new-setup-3',
    });
  } finally {
    console.log = previousLog;
    console.error = previousError;
    process.exitCode = previousExitCode;
    rmSync(root, { force: true, recursive: true });
  }
});

test('fresh enrollment runtime observation refuses unknown lifecycle phases', () => {
  for (const row of [
    stoppedRuntimeRow({ phase: 'unknown' }),
    stoppedRuntimeRow({ operation: { kind: 'start', phase: 'unknown' } }),
    stoppedRuntimeRow({ phase: 'not-a-portal-phase' }),
    stoppedRuntimeRow({
      operation: { kind: 'start', phase: 'not-a-portal-phase' },
    }),
  ]) {
    expect(classifyDependencyRuntime(row)).toBe('unknown');
  }
  expect(classifyDependencyRuntime(stoppedRuntimeRow())).toBe('dead');
  expect(
    classifyDependencyRuntime(
      stoppedRuntimeRow({ operation: { kind: 'start', phase: 'running' } })
    )
  ).toBe('alive');
});

test('MCP dependency tools use exact service methods, reject broad inputs, and retain unknown outcomes', async () => {
  const calls = [];
  const services = {
    dependencyApply: (input) => {
      calls.push({ input, method: 'dependencyApply' });
      if (input.operationId === undefined) {
        return { ok: true, planId: input.planId };
      }
      return {
        code: 'DEPENDENCY_OPERATION_UNKNOWN',
        ok: false,
        operationId: input.operationId,
        recovery: { operationId: input.operationId },
        state: 'unknown',
      };
    },
    dependencyPrepare: (input) => {
      calls.push({ input, method: 'dependencyPrepare' });
      return { ok: true, planId: 'plan-12' };
    },
    dependencyPrepareRelease: (input) => {
      calls.push({ input, method: 'dependencyPrepareRelease' });
      return { ok: true, releaseId: 'release-14' };
    },
    dependencyRecover: (input) => {
      calls.push({ input, method: 'dependencyRecover' });
      return { ok: true, operationId: input.operationId, state: 'partial' };
    },
    dependencyRelease: (input) => {
      calls.push({ input, method: 'dependencyRelease' });
      const error = new Error('release result is unknown');
      Object.assign(error, {
        code: 'DEPENDENCY_OPERATION_UNKNOWN',
        operationId: 'operation-15',
        phase: 'release',
        recovery: {
          operationId: 'operation-15',
          releaseId: input.releaseId,
        },
        releaseId: input.releaseId,
        state: 'unknown',
      });
      throw error;
    },
  };
  const operations = [
    {
      args: { name: 'topic', repo: 'project' },
      expected: {
        input: { name: 'topic', repo: 'project', source: 'mcp' },
        method: 'dependencyPrepare',
      },
      result: { ok: true, planId: 'plan-12' },
      tool: 'prepare_dependency_sharing',
    },
    {
      args: {
        confirmation: 'review-13',
        name: 'topic',
        operationId: 'operation-13',
        planId: 'plan-13',
        repo: 'project',
      },
      expected: {
        input: {
          confirmation: 'review-13',
          name: 'topic',
          operationId: 'operation-13',
          planId: 'plan-13',
          repo: 'project',
          source: 'mcp',
        },
        method: 'dependencyApply',
      },
      result: {
        code: 'DEPENDENCY_OPERATION_UNKNOWN',
        ok: false,
        operationId: 'operation-13',
        recovery: { operationId: 'operation-13' },
        state: 'unknown',
      },
      tool: 'apply_dependency_sharing',
    },
    {
      args: { name: 'topic', operationId: 'operation-14', repo: 'project' },
      expected: {
        input: {
          name: 'topic',
          operationId: 'operation-14',
          repo: 'project',
          source: 'mcp',
        },
        method: 'dependencyRecover',
      },
      result: { ok: true, operationId: 'operation-14', state: 'partial' },
      tool: 'recover_dependency_sharing',
    },
    {
      args: { name: 'topic', operationId: 'operation-15', repo: 'project' },
      expected: {
        input: {
          name: 'topic',
          operationId: 'operation-15',
          repo: 'project',
          source: 'mcp',
        },
        method: 'dependencyPrepareRelease',
      },
      result: { ok: true, releaseId: 'release-14' },
      tool: 'prepare_dependency_release',
    },
    {
      args: {
        confirmation: 'review-16',
        name: 'topic',
        releaseId: 'release-16',
        repo: 'project',
      },
      expected: {
        input: {
          confirmation: 'review-16',
          name: 'topic',
          releaseId: 'release-16',
          repo: 'project',
          source: 'mcp',
        },
        method: 'dependencyRelease',
      },
      result: {
        code: 'DEPENDENCY_OPERATION_UNKNOWN',
        error: 'release result is unknown',
        ok: false,
        operationId: 'operation-15',
        phase: 'release',
        recovery: {
          operationId: 'operation-15',
          releaseId: 'release-16',
        },
        releaseId: 'release-16',
        state: 'unknown',
      },
      tool: 'release_dependency_originals',
    },
  ];
  const port = 35_000 + (process.pid % 1000);
  initMcpServer(services);
  try {
    for (const [index, operation] of operations.entries()) {
      // Requests use the in-memory Web Request handler and do not open a socket.
      // biome-ignore lint/performance/noAwaitInLoops: Ordered calls verify each operation's identity and response envelope.
      const { response, rpc } = await mcpRequest(
        operation.tool,
        operation.args,
        port
      );
      expect(response.status).toBe(200);
      expect(calls[index]).toEqual(operation.expected);
      expect(mcpValue(rpc)).toEqual(operation.result);
      expect(rpc.result.isError).toBe(operation.result.ok === false);
    }

    const missingConfirmation = await mcpRequest(
      'apply_dependency_sharing',
      {
        name: 'topic',
        operationId: 'operation-17',
        planId: 'plan-17',
        repo: 'project',
      },
      port
    );
    expect(missingConfirmation.rpc.result.isError).toBe(true);
    expect(missingConfirmation.rpc.result.content[0].text).toContain(
      'validation'
    );

    const defaultOperationId = await mcpRequest(
      'apply_dependency_sharing',
      {
        confirmation: 'plan-18',
        name: 'topic',
        planId: 'plan-18',
        repo: 'project',
      },
      port
    );
    expect(defaultOperationId.rpc.result.isError).toBe(false);
    expect(calls.at(-1).input).not.toHaveProperty('operationId');
    const callCount = calls.length;

    const extraPath = await mcpRequest(
      'prepare_dependency_sharing',
      { checkoutPath: '/arbitrary/path', name: 'topic', repo: 'project' },
      port
    );
    expect(extraPath.rpc.result.isError).toBe(true);
    expect(extraPath.rpc.result.content[0].text).toContain('validation');
    expect(calls).toHaveLength(callCount);
  } finally {
    initMcpServer(null);
  }
});
