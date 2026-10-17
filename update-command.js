import { execFile, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import nativeFs from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isConnectionRefused } from './connection-refused.js';
import { assertStorageHeadroom } from './host-health.js';
import { observeProcessIdentity } from './process-observation.js';
import { runUpdateTransaction } from './update-transaction.js';
import { createWorkspaceState } from './workspace-state.js';

function execute(command, args, options) {
  return new Promise((resolve, reject) =>
    execFile(
      command,
      args,
      {
        ...options,
        encoding: 'utf8',
        maxBuffer: 4 * 1024 * 1024,
        timeout: 120_000,
      },
      (error, stdout) => {
        if (error) {
          reject(new Error('Command did not complete successfully'));
        } else {
          resolve(stdout);
        }
      }
    )
  );
}

export function createUpdateCommand({
  repoDir,
  configPath,
  portalUrl = 'http://127.0.0.1:2999',
  fs = nativeFs,
  run = execute,
  assertStorage = assertStorageHeadroom,
  fetchImpl = fetch,
  observeProcess = observeProcessIdentity,
  now = () => performance.now(),
  sleep = (ms) => new Promise((done) => setTimeout(done, ms)),
  operationId = randomUUID,
  startPortal = (directory) =>
    new Promise((resolve, reject) => {
      const child = spawn(
        process.execPath,
        ['run', join(directory, 'portal.js')],
        { cwd: directory, detached: true, stdio: 'ignore' }
      );
      child.once('error', reject);
      child.once('spawn', () => {
        child.unref();
        resolve();
      });
    }),
} = {}) {
  async function request(path, body) {
    try {
      const response = await fetchImpl(`${portalUrl}${path}`, {
        method: body === undefined ? 'GET' : 'POST',
        ...(body === undefined
          ? {}
          : {
              body: JSON.stringify(body),
              headers: { 'content-type': 'application/json' },
            }),
        redirect: 'error',
        signal: AbortSignal.timeout(5000),
      });
      const value = await response.json();
      return response.ok || value?.protocol === 1
        ? value
        : { state: 'unknown' };
    } catch (error) {
      if (isConnectionRefused(error)) {
        return { state: 'absent' };
      }
      return { state: 'unknown' };
    }
  }
  async function inspectPortal() {
    const result = await request('/api/update/capabilities');
    if (result.state === 'absent') {
      return result;
    }
    if (
      result.protocol !== 1 ||
      typeof result.instanceId !== 'string' ||
      !result.instanceId ||
      !Number.isSafeInteger(result.processId) ||
      result.processId <= 0 ||
      typeof result.processStartIdentity !== 'string' ||
      !result.processStartIdentity
    ) {
      return { state: 'unknown' };
    }
    const observed = await observeProcess(result.processId).catch(() => ({
      state: 'unknown',
    }));
    return observed.state === 'alive' &&
      observed.processId === result.processId &&
      observed.processStartIdentity === result.processStartIdentity
      ? { ...result, state: 'ready' }
      : { state: 'unknown' };
  }
  async function originalPortalStopped(owner) {
    const status = await inspectPortal();
    if (status.state === 'ready' && status.instanceId !== owner.instanceId) {
      throw new Error('Portal identity changed before confirmed stop');
    }
    const observed = await observeProcess(owner.processId).catch(() => ({
      state: 'unknown',
    }));
    const originalGone =
      observed.state === 'absent' ||
      (observed.state === 'alive' &&
        observed.processId === owner.processId &&
        typeof observed.processStartIdentity === 'string' &&
        observed.processStartIdentity &&
        observed.processStartIdentity !== owner.processStartIdentity);
    return status.state === 'absent' && originalGone;
  }

  async function waitForOriginalPortalStop(owner) {
    const deadline = now() + 10_000;
    while (now() < deadline) {
      // biome-ignore lint/performance/noAwaitInLoops: Each stop poll must observe the prior portal and process identities before the next retry.
      if (await originalPortalStopped(owner)) {
        return;
      }
      await sleep(100);
    }
    throw new Error(
      'Original portal process exit was not confirmed; no replacement was started'
    );
  }

  async function waitForReplacementPortal(owner) {
    const readyDeadline = now() + 10_000;
    while (now() < readyDeadline) {
      // biome-ignore lint/performance/noAwaitInLoops: Readiness must be observed after the prior launch/poll before retrying.
      const status = await inspectPortal();
      if (status.state === 'ready' && status.instanceId !== owner.instanceId) {
        return;
      }
      await sleep(100);
    }
    throw new Error('New portal readiness could not be confirmed');
  }

  async function restart(owner) {
    const stopped = await request('/api/update/stop', {
      instanceId: owner.instanceId,
      token: owner.token,
    });
    if (!stopped.ok || stopped.instanceId !== owner.instanceId) {
      throw new Error('Owner-held portal stop was not confirmed');
    }
    await waitForOriginalPortalStop(owner);
    await startPortal(repoDir);
    await waitForReplacementPortal(owner);
  }
  async function update(options) {
    if (
      !(repoDir && configPath && isAbsolute(repoDir) && isAbsolute(configPath))
    ) {
      throw new Error('Explicit absolute update paths are required');
    }
    const directory = fs.realpathSync(repoDir);
    if (!fs.existsSync(join(directory, '.git'))) {
      return {
        code: 'UPDATE_CHECKOUT_REQUIRED',
        error:
          'Guarded update requires an existing Git checkout; use the installer for a fresh installation',
        ok: false,
        stage: 'preflight',
      };
    }
    try {
      await assertStorage(directory);
    } catch (error) {
      return {
        code: error.code || 'STORAGE_UNKNOWN',
        error: error.message,
        ok: false,
        stage: 'preflight',
      };
    }
    const state = createWorkspaceState({
      configPath,
      fs,
      now,
      setuDir: directory,
      sleep,
    });
    return state.withUpdate(() => {
      state.read('config'); // Fail on corrupt policy storage before changing loaded source.
      const git = (args) =>
        run('git', ['-C', directory, ...args], { cwd: directory });
      return runUpdateTransaction(
        {
          checkStorage: () => assertStorage(directory),
          git,
          inProgress: async () => {
            for (const name of [
              'MERGE_HEAD',
              'CHERRY_PICK_HEAD',
              'REVERT_HEAD',
              'rebase-merge',
              'rebase-apply',
              'BISECT_LOG',
            ]) {
              const path =
                // biome-ignore lint/performance/noAwaitInLoops: Git-path probes preserve the recovery-marker priority and stop at the first present marker.
                (await git(['rev-parse', '--git-path', name])).trim();
              if (
                fs.existsSync(isAbsolute(path) ? path : join(directory, path))
              ) {
                return true;
              }
            }
            return false;
          },
          inspectPortal,
          install: ({ frozenLockfile } = {}) =>
            run(
              process.execPath,
              ['install', ...(frozenLockfile ? ['--frozen-lockfile'] : [])],
              { cwd: directory }
            ),
          link: () => run(process.execPath, ['link'], { cwd: directory }),
          operationId,
          quiesce: async (portal) => ({
            ...(await request('/api/update/quiesce', {
              instanceId: portal.instanceId,
              ownerProcessId: process.pid,
            })),
            processId: portal.processId,
            processStartIdentity: portal.processStartIdentity,
          }),
          rebaseInProgress: async () => {
            for (const name of ['rebase-merge', 'rebase-apply']) {
              const path =
                // biome-ignore lint/performance/noAwaitInLoops: Rebase-marker probes preserve the established priority before deciding recovery state.
                (await git(['rev-parse', '--git-path', name])).trim();
              if (
                fs.existsSync(isAbsolute(path) ? path : join(directory, path))
              ) {
                return true;
              }
            }
            return false;
          },
          reopen: (owner) =>
            request('/api/update/reopen', {
              coherent: true,
              instanceId: owner.instanceId,
              token: owner.token,
            }),
          restart,
          writeCheck: () =>
            state.update('config', (current) => ({
              ...current,
              lastUpdateCheck: Date.now(),
            })),
        },
        options
      );
    });
  }
  return { inspectPortal, update };
}

export function describeUpdate(result) {
  const lines = [
    result.ok ? 'Setu updated.' : `${result.code}: ${result.error}`,
  ];
  if (result.before) {
    lines.push(`Original revision: ${result.before}`);
  }
  if (result.stashId) {
    lines.push(`Recovery stash retained: ${result.stashId}`);
  }
  if (result.recovery?.revisionRestored) {
    lines.push('Original revision restored.');
  }
  if (result.recovery?.stashApplied) {
    lines.push('Recovery stash reapplied; the stash was retained.');
  }
  for (const warning of result.recovery?.warnings ?? []) {
    lines.push(`Recovery warning: ${warning}`);
  }
  if (result.warning) {
    lines.push(
      `${result.warning.code}: settings were committed; durability is unconfirmed.`
    );
  }
  if (result.admissionClosed === true) {
    lines.push(
      'Portal admission remains closed. Inspect the checkout and recovery state before a guarded restart.'
    );
  }
  if (result.admissionClosed === null) {
    lines.push(
      'Portal cutover state is unconfirmed. Do not retry the complete update automatically.'
    );
  }
  return lines.join('\n');
}

export async function runUpdateCli({
  moduleUrl = import.meta.url,
  home = homedir(),
  args = process.argv.slice(2),
  createCommand = createUpdateCommand,
  output = console.log,
  errorOutput = console.error,
} = {}) {
  const command = createCommand({
    configPath: join(home, '.setu.json'),
    repoDir: dirname(fileURLToPath(moduleUrl)),
  });
  try {
    const result = await command.update({
      includeUntracked: args.includes('--include-untracked'),
      restartAuthorized: args.includes('--restart'),
    });
    (result.ok ? output : errorOutput)(describeUpdate(result));
    return result.ok ? 0 : 1;
  } catch (error) {
    errorOutput(`Update refused: ${error.code || 'UPDATE_FAILED'}`);
    return 1;
  }
}

if (import.meta.main) {
  process.exitCode = await runUpdateCli();
}
