import { lstatSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  inspectDependencyView,
  recordDependencyConsumer,
  sharedDependencyInstall,
} from './dependency-sharing.js';
import { assertStorageHeadroom } from './host-health.js';

function dependencyInstallCommand(wtDir, exists) {
  return exists(join(wtDir, 'package.json'))
    ? ['bun', ['install']]
    : exists(join(wtDir, 'pyproject.toml')) ||
        exists(join(wtDir, 'requirements.txt'))
      ? ['uv', ['sync']]
      : null;
}

function setupError(code, message) {
  return Object.assign(new Error(message), { code });
}

function requireProgress(result) {
  if (!result?.ok) {
    throw setupError(
      result?.code ?? 'SETUP_PROGRESS_UNAVAILABLE',
      result?.error ?? 'The durable setup progress record could not be updated'
    );
  }
  return result.record;
}

function sameValue(a, b) {
  if (a === b) {
    return true;
  }
  if (!(a && b && typeof a === 'object' && typeof b === 'object')) {
    return false;
  }
  const aKeys = Object.keys(a).sort();
  const bKeys = Object.keys(b).sort();
  return (
    aKeys.length === bKeys.length &&
    aKeys.every(
      (key, index) => key === bKeys[index] && sameValue(a[key], b[key])
    )
  );
}

function recoveryDetail(error) {
  return {
    code: String(error?.code ?? 'SETUP_PROGRESS_UNAVAILABLE').slice(0, 96),
    message: String(error?.message ?? 'Progress persistence failed').slice(
      0,
      256
    ),
  };
}

function addRecovery(error, persistenceError) {
  if (persistenceError && !error.recovery) {
    error.recovery = { progress: recoveryDetail(persistenceError) };
  }
  return error;
}

function dependencyConsumers(state) {
  let document;
  try {
    document = state?.read?.('dependencyViews');
  } catch (error) {
    throw addRecovery(
      setupError(
        'DEPENDENCY_VIEW_UNKNOWN',
        'Dependency consumer records are unreadable; shared setup was not started'
      ),
      error
    );
  }
  if (!(document && typeof document === 'object' && !Array.isArray(document))) {
    throw setupError(
      'DEPENDENCY_VIEW_UNKNOWN',
      'Dependency consumer records are malformed; shared setup was not started'
    );
  }
  if (!Object.hasOwn(document, 'consumers')) {
    return {};
  }
  const { consumers } = document;
  if (
    !(consumers && typeof consumers === 'object' && !Array.isArray(consumers))
  ) {
    throw setupError(
      'DEPENDENCY_VIEW_UNKNOWN',
      'Dependency consumer records are malformed; shared setup was not started'
    );
  }
  for (const [checkout, consumer] of Object.entries(consumers)) {
    if (
      !(consumer && typeof consumer === 'object' && !Array.isArray(consumer)) ||
      consumer.checkout !== checkout ||
      typeof consumer.bunVersion !== 'string' ||
      typeof consumer.linkerMode !== 'string' ||
      typeof consumer.lockfileHash !== 'string' ||
      typeof consumer.platformNamespace !== 'string'
    ) {
      throw setupError(
        'DEPENDENCY_VIEW_UNKNOWN',
        'Dependency consumer records are malformed; shared setup was not started'
      );
    }
  }
  return consumers;
}

function sharingForSetup(sharing, state) {
  return sharing?.enabled
    ? { ...sharing, consumers: dependencyConsumers(state) }
    : sharing;
}

// A record is created only after the checkout exists and its identity is known.
// Retries read that durable record, so a process restart cannot reuse a stale
// attempt id or silently reinstall an already-completed checkout.
export async function beginSetupAttempt({
  progress,
  target,
  checkoutIdentity,
  logLocation,
  stage = 'preparing',
} = {}) {
  if (!progress) {
    return null;
  }
  if (!(target && checkoutIdentity && logLocation)) {
    throw setupError(
      'SETUP_COORDINATION_INVALID',
      'Durable setup coordination needs target, checkout identity, and log location'
    );
  }
  const current = progress.get(target);
  if (current?.ok === false) {
    requireProgress(current);
  }
  if (!current) {
    return {
      completed: false,
      record: requireProgress(
        await progress.start({ checkoutIdentity, logLocation, stage, target })
      ),
    };
  }
  if (!sameValue(current.checkoutIdentity, checkoutIdentity)) {
    throw setupError(
      'CHECKOUT_IDENTITY_MISMATCH',
      'The checkout identity does not match the recorded setup'
    );
  }
  if (current.state === 'completed') {
    return { completed: true, record: current };
  }
  if (current.state === 'running') {
    throw setupError(
      'SETUP_ALREADY_RUNNING',
      'Setup is already running for this checkout'
    );
  }
  return {
    completed: false,
    record: requireProgress(
      await progress.retry({
        attemptId: current.attemptId,
        checkoutIdentity,
        logLocation,
        stage,
        target,
      })
    ),
  };
}

// A portal retry may be explicitly reviewed and accepted under its target
// lock.  This validates that supplied durable record before any setup effect,
// avoiding a second implicit retry of the now-running replacement attempt.
export function validateSetupAttempt({
  progress,
  target,
  checkoutIdentity,
  logLocation,
  setupAttempt,
} = {}) {
  if (!(progress && setupAttempt) || typeof setupAttempt !== 'object') {
    throw setupError(
      'SETUP_ATTEMPT_INVALID',
      'The supplied setup attempt is invalid'
    );
  }
  const current = progress.get(target);
  if (current?.ok === false) {
    requireProgress(current);
  }
  if (
    !current ||
    current.state !== 'running' ||
    current.attemptId !== setupAttempt.attemptId ||
    !sameValue(current.target, target) ||
    !sameValue(current.checkoutIdentity, checkoutIdentity) ||
    current.logLocation !== logLocation ||
    !sameValue(setupAttempt.checkoutIdentity, current.checkoutIdentity) ||
    !sameValue(setupAttempt.target, current.target)
  ) {
    throw setupError(
      'SETUP_ATTEMPT_MISMATCH',
      'The supplied setup attempt is stale, forged, or belongs to another checkout'
    );
  }
  return { completed: false, record: current };
}

async function resolveSetupAttempt(options) {
  return options.setupAttempt
    ? validateSetupAttempt(options)
    : beginSetupAttempt(options);
}

async function setupStage(progress, setup, stage) {
  if (!(progress && setup)) {
    return;
  }
  requireProgress(
    await progress.stage({
      attemptId: setup.record.attemptId,
      checkoutIdentity: setup.record.checkoutIdentity,
      stage,
      target: setup.record.target,
    })
  );
}

async function setupFinish(progress, setup, outcome) {
  if (!(progress && setup)) {
    return;
  }
  requireProgress(
    await progress.finish({
      attemptId: setup.record.attemptId,
      checkoutIdentity: setup.record.checkoutIdentity,
      outcome,
      target: setup.record.target,
    })
  );
}

async function setupFailure(progress, setup, outcome) {
  try {
    await setupFinish(progress, setup, outcome);
  } catch (error) {
    // A late completion must not overwrite a newer attempt.  Preserve the
    // precise mismatch rather than replacing the durable record again.
    throw error;
  }
}

async function preserveKnownFailure(progress, setup, error) {
  try {
    await setupFailure(progress, setup, 'failed');
  } catch (persistenceError) {
    addRecovery(error, persistenceError);
  }
  return error;
}

async function unknownOutcome(progress, setup, message) {
  const error = setupError('OPERATION_UNKNOWN', message);
  try {
    await setupFailure(progress, setup, 'unknown');
  } catch (persistenceError) {
    addRecovery(error, persistenceError);
  }
  return error;
}

function requireFreshSharedView(view, sharing, wtDir) {
  let checkout;
  try {
    checkout = realpathSync(wtDir);
  } catch {
    checkout = wtDir;
  }
  let absent = view?.state === 'absent';
  if (
    !(absent || sharing?.consumers?.[checkout]) &&
    view?.state === 'unknown'
  ) {
    try {
      lstatSync(join(checkout, 'node_modules'));
    } catch (error) {
      absent = error?.code === 'ENOENT';
    }
  }
  if (!absent || sharing?.consumers?.[checkout]) {
    throw setupError(
      'DEPENDENCY_VIEW_UNSAFE',
      `Shared setup requires a fresh absent dependency view; found ${view?.state ?? 'unknown'}`
    );
  }
}

// Admission is deliberately outside the target lock.  For portal callers the
// supplied lifecycle keeps the target lock through `completion`; this wrapper
// keeps the exact lease through that same known completion.
export async function withSetupAdmission({
  admission,
  operationId,
  target,
  withTarget = async (_target, task) => task(),
  task,
} = {}) {
  if (typeof task !== 'function' || typeof withTarget !== 'function') {
    throw setupError(
      'SETUP_COORDINATION_INVALID',
      'Setup admission needs task and target-lock collaborators'
    );
  }
  if (!admission) {
    return withTarget(target, () => task({ lease: null }));
  }
  const admitted = await admission.admit({
    kind: 'install',
    operationId,
    target,
  });
  if (!admitted?.ok) {
    return admitted;
  }
  const { lease } = admitted;
  let releasePromise;
  const release = () => {
    releasePromise ??= (async () => {
      const released = await admission.release(lease);
      if (!released?.ok) {
        throw setupError(
          released?.code ?? 'LEASE_RELEASE_FAILED',
          released?.error ?? 'The setup admission lease could not be released'
        );
      }
    })();
    return releasePromise;
  };
  const preserveOperationError = async (error) => {
    if (error?.code !== 'OPERATION_UNKNOWN') {
      try {
        await release();
      } catch (releaseError) {
        addRecovery(error, releaseError);
      }
    }
    throw error;
  };
  try {
    return await withTarget(target, async () => {
      const launched = await task({ lease });
      if (!launched?.completion?.then) {
        await release();
        return launched;
      }
      return {
        ...launched,
        completion: Promise.resolve(launched.completion).then(async (value) => {
          await release();
          return value;
        }, preserveOperationError),
      };
    });
  } catch (error) {
    return preserveOperationError(error);
  }
}

export async function startWorktreeSetupInstall(
  context,
  {
    exists,
    spawn,
    openLog,
    closeLog,
    stopProcess,
    assertStorage = assertStorageHeadroom,
    sharing,
    assertStoreStorage,
    state,
    progress,
    target,
    checkoutIdentity,
    logLocation,
    setupAttempt,
  }
) {
  const { res } = context;
  const result = (setup) => ({
    domain: res.localDom,
    ok: true,
    port: res.port,
    setup,
  });
  let command = dependencyInstallCommand(res.wtDir, exists);
  const setup = await resolveSetupAttempt({
    checkoutIdentity,
    logLocation,
    progress,
    setupAttempt,
    target,
  });
  if (setup?.completed) {
    context.ready = true;
    return result('ready');
  }
  if (!command) {
    await setupStage(progress, setup, 'no-dependencies');
    await setupFinish(progress, setup, 'completed');
    context.ready = true;
    return result('ready');
  }
  let shared;
  try {
    await setupStage(progress, setup, 'storage-check');
    await assertStorage(res.wtDir);
    if (command[0] === 'bun' && sharing?.enabled) {
      const resolvedSharing = sharingForSetup(sharing, state);
      const view = await inspectDependencyView(res.wtDir, resolvedSharing);
      await setupStage(progress, setup, `dependency-view:${view.state}`);
      requireFreshSharedView(view, resolvedSharing, res.wtDir);
      shared = await sharedDependencyInstall(
        res.wtDir,
        resolvedSharing,
        assertStoreStorage
      );
    }
    command = shared?.command ?? command;
    await setupStage(progress, setup, 'installing');
  } catch (error) {
    throw await preserveKnownFailure(progress, setup, error);
  }
  let fd;
  try {
    fd = openLog();
  } catch (error) {
    throw await preserveKnownFailure(progress, setup, error);
  }
  let proc,
    closeFailed = false;
  try {
    proc = spawn(
      [
        'zsh',
        '-c',
        'mise trust "$PWD" 2>/dev/null; exec "$@"',
        'setu-setup',
        command[0],
        ...command[1],
      ],
      {
        cwd: res.wtDir,
        ...(shared ? { env: shared.env } : {}),
        detached: true,
        stderr: fd,
        stdin: 'ignore',
        stdout: fd,
        timeout: 15 * 60 * 1000,
      }
    );
  } catch (error) {
    try {
      closeLog(fd);
    } catch (closeError) {
      addRecovery(error, closeError);
    }
    throw await preserveKnownFailure(progress, setup, error);
  }
  try {
    if (!(proc?.exited?.then && Number.isInteger(proc.pid)) || proc.pid < 1) {
      throw await unknownOutcome(
        progress,
        setup,
        'Setup process ownership is unconfirmed; admission remains blocked'
      );
    }
  } finally {
    try {
      closeLog(fd);
    } catch {
      closeFailed = true;
    }
  }
  const completion = proc.exited.then(
    async (code) => {
      try {
        await stopProcess({ ownedGroup: true, pid: proc.pid });
      } catch {
        throw await unknownOutcome(
          progress,
          setup,
          'Setup process group exit is unconfirmed; admission remains blocked'
        );
      }
      if (code !== 0 || proc.signalCode) {
        throw await preserveKnownFailure(
          progress,
          setup,
          new Error(
            'Dependency installation failed; inspect the setup log before retrying'
          )
        );
      }
      if (closeFailed) {
        throw await preserveKnownFailure(
          progress,
          setup,
          new Error(
            'Dependency installation finished but its setup log descriptor could not be closed'
          )
        );
      }
      if (shared) {
        try {
          await recordDependencyConsumer(
            state,
            res.wtDir,
            sharingForSetup(sharing, state),
            shared
          );
        } catch (error) {
          throw await preserveKnownFailure(progress, setup, error);
        }
      }
      await setupFinish(progress, setup, 'completed');
      context.ready = true;
    },
    async () => {
      throw await unknownOutcome(
        progress,
        setup,
        'Setup process outcome is unknown; admission remains blocked'
      );
    }
  );
  return { completion, result: result('installing') };
}

export async function installWorktreeDependencies(
  wtDir,
  {
    exists,
    run,
    assertStorage = assertStorageHeadroom,
    sharing,
    assertStoreStorage,
    stdio = 'inherit',
    state,
    progress,
    target,
    checkoutIdentity,
    logLocation,
    setup: suppliedSetup,
    setupAttempt,
  }
) {
  let command = dependencyInstallCommand(wtDir, exists);
  const setup = suppliedSetup
    ? validateSetupAttempt({
        checkoutIdentity,
        logLocation,
        progress,
        setupAttempt: suppliedSetup.record ?? suppliedSetup,
        target,
      })
    : await resolveSetupAttempt({
        checkoutIdentity,
        logLocation,
        progress,
        setupAttempt,
        target,
      });
  if (setup?.completed) {
    return { alreadyCompleted: true };
  }
  if (!command) {
    await setupStage(progress, setup, 'no-dependencies');
    await setupFinish(progress, setup, 'completed');
    return { installed: false };
  }
  let shared, result;
  try {
    await setupStage(progress, setup, 'storage-check');
    await assertStorage(wtDir);
    if (command[0] === 'bun' && sharing?.enabled) {
      const resolvedSharing = sharingForSetup(sharing, state);
      const view = await inspectDependencyView(wtDir, resolvedSharing);
      await setupStage(progress, setup, `dependency-view:${view.state}`);
      requireFreshSharedView(view, resolvedSharing, wtDir);
      shared = await sharedDependencyInstall(
        wtDir,
        resolvedSharing,
        assertStoreStorage
      );
    }
    command = shared?.command ?? command;
    await setupStage(progress, setup, 'installing');
    result = run(...command, {
      cwd: wtDir,
      stdio,
      ...(shared ? { env: shared.env } : {}),
    });
  } catch (error) {
    throw await preserveKnownFailure(progress, setup, error);
  }
  if (!Number.isInteger(result?.status) && result?.pid > 0 && !result.signal) {
    throw await unknownOutcome(
      progress,
      setup,
      'Dependency installation exit is unconfirmed; checkout ownership is retained'
    );
  }
  if (result?.status !== 0 || result.error) {
    throw await preserveKnownFailure(
      progress,
      setup,
      new Error(
        'Dependency installation failed; inspect its output before retrying'
      )
    );
  }
  if (shared) {
    try {
      await recordDependencyConsumer(
        state,
        wtDir,
        sharingForSetup(sharing, state),
        shared
      );
    } catch (error) {
      throw await preserveKnownFailure(progress, setup, error);
    }
  }
  await setupFinish(progress, setup, 'completed');
  return { installed: true };
}

// CLI setup owns the checkout across both Git preparation and dependency work.
// Public routing is claimed through the portal only after this lease releases.
export async function createAndInstallWorktree({
  state,
  repo,
  name,
  create,
  install,
  tunnel = false,
  enableTunnel,
  admission,
  operationId,
  progress,
  checkoutIdentity,
  logLocation,
  withTarget,
}) {
  const target = { name, repo };
  const lock = withTarget ?? ((_, task) => state.withTargets([target], task));
  const result = await withSetupAdmission({
    admission,
    operationId,
    target,
    task: async () => {
      const result = await create({ tunnel: false });
      const identity = checkoutIdentity
        ? await checkoutIdentity(result.wtDir)
        : undefined;
      const setup = await beginSetupAttempt({
        checkoutIdentity: identity,
        logLocation,
        progress,
        target,
      });
      if (setup?.completed) {
        return { ...result, setup: 'ready' };
      }
      try {
        await install(result.wtDir, {
          checkoutIdentity: identity,
          logLocation,
          progress,
          setup,
          target,
        });
        // Legacy collaborators may not know about durable setup records yet.
        // Finish their known, synchronous result here; the current installer
        // has already completed its own record, so it is left untouched.
        if (progress && setup && progress.get(target)?.state === 'running') {
          await setupFinish(progress, setup, 'completed');
        }
      } catch (error) {
        try {
          if (progress && setup && progress.get(target)?.state === 'running') {
            await setupFailure(
              progress,
              setup,
              error?.code === 'OPERATION_UNKNOWN' ? 'unknown' : 'failed'
            );
          }
        } catch (persistenceError) {
          addRecovery(error, persistenceError);
        }
        throw error;
      }
      return result;
    },
    withTarget: lock,
  });
  if (result?.ok === false) {
    return result;
  }
  if (!tunnel) {
    return result;
  }
  // A durable completed retry is validation only.  It must not move the
  // shared tunnel away from a later owner.
  if (result?.setup === 'ready') {
    return result;
  }
  const pubDom = await enableTunnel();
  return { ...result, pubDom };
}

// Commands are explicit dependencies so setup can be checked without Git,
// network access, or a real repository. Registration belongs to the caller.
export async function cloneBareRepository(repoDir, remoteUrl, ghSlug, { run }) {
  const requireSuccess = async (args) => {
    const result = await run(args, { timeoutMs: 120_000 });
    if (result.code !== 0 || result.timedOut) {
      throw new Error(
        result.stderr ||
          `${args[0]} failed or timed out during repository setup`
      );
    }
    return result;
  };
  let useGh = false;
  if (ghSlug) {
    try {
      const auth = await run(['gh', 'auth', 'status']);
      useGh = auth.code === 0 && !auth.timedOut;
    } catch (error) {
      if (error.code === 'OPERATION_UNKNOWN') {
        throw error; /* Git can use its own configured credentials after a known failure. */
      }
    }
  }
  await requireSuccess(
    useGh
      ? ['gh', 'repo', 'clone', ghSlug, repoDir, '--', '--bare']
      : ['git', 'clone', '--bare', remoteUrl, repoDir]
  );
  await requireSuccess([
    'git',
    '-C',
    repoDir,
    'config',
    'remote.origin.fetch',
    '+refs/heads/*:refs/remotes/origin/*',
  ]);
  await requireSuccess(['git', '-C', repoDir, 'fetch', '--all', '--prune']);
}

export async function prepareWorktreeCheckout(
  { repoDir, wtDir, name, exists },
  { run }
) {
  const git = async (args) => {
    const result = await run(['git', '-C', repoDir, ...args], {
      timeoutMs: 120_000,
    });
    if (result.code !== 0 || result.timedOut || result.truncated) {
      throw new Error(
        result.stderr ||
          'Git setup failed, timed out, or returned incomplete output'
      );
    }
    return result.stdout;
  };
  const hasBranch = async (branch) => {
    for (const ref of [
      `refs/heads/${branch}`,
      `refs/remotes/origin/${branch}`,
    ]) {
      const result = await run([
        'git',
        '-C',
        repoDir,
        'show-ref',
        '--verify',
        '--quiet',
        ref,
      ]);
      if (result.code === 0 && !result.timedOut) {
        return true;
      }
      if (result.code !== 1 || result.timedOut) {
        throw new Error('Branch lookup failed during repository setup');
      }
    }
    return false;
  };
  await git(['fetch', '--all', '--prune']);
  await git(['worktree', 'prune']);
  const list = await git(['worktree', 'list', '--porcelain']);
  if (exists) {
    // git records real paths; the workspace itself may sit behind a symlink.
    const real = (path) => {
      try {
        return realpathSync(path);
      } catch {
        return resolve(path);
      }
    };
    const linked = list
      .trim()
      .split('\n\n')
      .some((entry) => {
        const path = entry.match(/^worktree (.+)$/m)?.[1];
        return !!path && real(path) === real(wtDir);
      });
    if (!linked) {
      throw new Error(
        `Existing path '${wtDir}' is not a linked worktree of this repository`
      );
    }
    return;
  }
  for (const entry of list.trim().split('\n\n')) {
    const path = entry.match(/^worktree (.+)$/m)?.[1];
    const branch = entry.match(/^branch refs\/heads\/(.+)$/m)?.[1];
    if (branch === name && path && resolve(path) !== resolve(wtDir)) {
      throw new Error(`Branch '${name}' is already checked out at ${path}`);
    }
  }
  if (await hasBranch(name)) {
    await git(['worktree', 'add', wtDir, name]);
  } else {
    const base = (await hasBranch('staging'))
      ? 'origin/staging'
      : `origin/${(await git(['symbolic-ref', '--short', 'HEAD'])).trim()}`;
    await git(['worktree', 'add', '-b', name, wtDir, base]);
  }
}
