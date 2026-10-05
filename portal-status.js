import { effectiveContainerLimits } from './worktree-lifecycle.js';

// HTTP and WebSocket status reads share this boundary. Target setup ownership
// never becomes a global read lock; runtime capacity remains lifecycle-owned.
export async function readPortalStatus(
  { lifecycle, config, readHostHealth, pendingRemovals },
  refreshHealth = false
) {
  const [rt, hostHealth] = await Promise.all([
    lifecycle.refreshCapacity(),
    readHostHealth({ refresh: refreshHealth }),
  ]);
  const limits = effectiveContainerLimits(config, rt);
  const { active, max, queued } = lifecycle.status();
  return {
    concurrency: { active, max, queued },
    container: {
      configuredCpuLimit: config.containerCpuLimit ?? 2,
      configuredMemoryLimit: config.containerMemoryLimit ?? '4g',
      cpuLimit: limits.cpus,
      engine: rt.engine,
      engineAvailable: rt.available,
      maxConcurrent: limits.max,
      memoryLimit: `${limits.memMb}m`,
    },
    hostHealth,
    pendingRemovals: pendingRemovals(),
  };
}
