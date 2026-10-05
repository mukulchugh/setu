import { join, resolve } from 'node:path';
import { sharedDependencyInstall } from './dependency-sharing.js';
import { assertStorageHeadroom } from './host-health.js';

function dependencyInstallCommand(wtDir, exists) {
  return exists(join(wtDir, 'package.json'))
    ? ['bun', ['install']]
    : exists(join(wtDir, 'pyproject.toml')) ||
        exists(join(wtDir, 'requirements.txt'))
      ? ['uv', ['sync']]
      : null;
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
  if (!command) {
    context.ready = true;
    return result('ready');
  }
  await assertStorage(res.wtDir);
  const shared =
    command[0] === 'bun'
      ? await sharedDependencyInstall(res.wtDir, sharing, assertStoreStorage)
      : null;
  command = shared?.command ?? command;
  const fd = openLog();
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
        throw Object.assign(
          new Error(
            'Setup process group exit is unconfirmed; admission remains blocked'
          ),
          { code: 'OPERATION_UNKNOWN' }
        );
      }
      if (code !== 0 || proc.signalCode) {
        throw new Error(
          'Dependency installation failed; inspect the setup log before retrying'
        );
      }
      if (closeFailed) {
        throw new Error(
          'Dependency installation finished but its setup log descriptor could not be closed'
        );
      }
      context.ready = true;
    },
    () => {
      throw Object.assign(
        new Error(
          'Setup process outcome is unknown; admission remains blocked'
        ),
        { code: 'OPERATION_UNKNOWN' }
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
  }
) {
  let command = dependencyInstallCommand(wtDir, exists);
  if (!command) {
    return;
  }
  await assertStorage(wtDir);
  const shared =
    command[0] === 'bun'
      ? await sharedDependencyInstall(wtDir, sharing, assertStoreStorage)
      : null;
  command = shared?.command ?? command;
  const result = run(...command, {
    cwd: wtDir,
    stdio: 'inherit',
    ...(shared ? { env: shared.env } : {}),
  });
  if (!Number.isInteger(result?.status) && result?.pid > 0 && !result.signal) {
    throw Object.assign(
      new Error(
        'Dependency installation exit is unconfirmed; checkout ownership is retained'
      ),
      { code: 'OPERATION_UNKNOWN' }
    );
  }
  if (result?.status !== 0 || result.error) {
    throw new Error(
      'Dependency installation failed; inspect its output before retrying'
    );
  }
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
}) {
  const result = await state.withTargets([{ name, repo }], async () => {
    const result = await create({ tunnel: false });
    await install(result.wtDir);
    return result;
  });
  if (!tunnel) {
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
  if (exists) {
    return;
  }
  const list = await git(['worktree', 'list', '--porcelain']);
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
