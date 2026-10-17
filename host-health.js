import { realpath, stat, statfs } from 'node:fs/promises';

const LOW_BYTES = 20 * 1024 ** 3;
const MINIMUM_BYTES = 10 * 1024 ** 3;

export async function assertStorageHeadroom(
  workspace,
  read = createHostHealth(workspace)
) {
  let health;
  try {
    health = await read({ refresh: true });
  } catch {
    // Admission needs a current observation; a failed read is not spare capacity.
  }
  if (
    health?.state !== 'ready' ||
    !Number.isSafeInteger(health.availableBytes) ||
    health.availableBytes < 0
  ) {
    throw Object.assign(
      new Error(
        'Workspace storage could not be verified; new disk-heavy work was not started. Refresh storage health before retrying.'
      ),
      { code: 'STORAGE_UNKNOWN', minimumAvailableBytes: MINIMUM_BYTES }
    );
  }
  if (health.availableBytes < MINIMUM_BYTES) {
    throw Object.assign(
      new Error(
        `Workspace storage is critically low (${(health.availableBytes / 1024 ** 3).toFixed(2)} GiB free; at least 10 GiB required). New disk-heavy work was not started; Stop and removal remain available.`
      ),
      {
        availableBytes: health.availableBytes,
        code: 'STORAGE_LOW',
        minimumAvailableBytes: MINIMUM_BYTES,
      }
    );
  }
  return health;
}
export async function observeHostFilesystem(workspace) {
  const workspacePath = await realpath(workspace);
  const [identity, space] = await Promise.all([
    stat(workspacePath, { bigint: true }),
    statfs(workspacePath, { bigint: true }),
  ]);
  const availableBytes = Number(space.bavail * space.bsize),
    totalBytes = Number(space.blocks * space.bsize);
  if (
    ![availableBytes, totalBytes].every(
      (value) => Number.isSafeInteger(value) && value >= 0
    )
  ) {
    throw new Error('Unsupported filesystem size');
  }
  return {
    availableBytes,
    totalBytes,
    volumeId: String(identity.dev),
    workspacePath,
  };
}

export function createHostHealth(
  workspace,
  {
    observe = observeHostFilesystem,
    now = Date.now,
    schedule = setTimeout,
    cancel = clearTimeout,
  } = {}
) {
  let pending = null,
    cached = null,
    task = null;
  const unknown = (code) => ({
    code,
    dockerVm: { state: 'unknown' },
    lowThresholdBytes: LOW_BYTES,
    minimumAvailableBytes: MINIMUM_BYTES,
    observedAt: now(),
    state: 'unknown',
  });
  return async function read({ refresh = false } = {}) {
    if (pending) {
      return pending;
    }
    if (cached && (!refresh || task) && now() - cached.observedAt < 60_000) {
      return cached;
    }
    if (task) {
      return cached ?? unknown('PROBE_PENDING');
    }
    let timeout;
    task = Promise.resolve()
      .then(() => observe(workspace))
      .then((value) => ({
        ...value,
        critical: value.availableBytes < MINIMUM_BYTES,
        dockerVm: { state: 'unknown' },
        low: value.availableBytes < LOW_BYTES,
        lowThresholdBytes: LOW_BYTES,
        minimumAvailableBytes: MINIMUM_BYTES,
        observedAt: now(),
        state: 'ready',
      }))
      .catch(() => unknown('FILESYSTEM_UNAVAILABLE'));
    const current = task;
    task.finally(() => {
      if (task === current) {
        task = null;
      }
    });
    pending = Promise.race([
      task,
      new Promise((resolve) => {
        timeout = schedule(() => resolve(unknown('PROBE_TIMEOUT')), 2000);
      }),
    ])
      .then((value) => {
        cached = value;
        return value;
      })
      .finally(() => {
        cancel(timeout);
        pending = null;
      });
    return await pending;
  };
}
