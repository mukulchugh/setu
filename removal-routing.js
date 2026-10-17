// Routing effects stay behind the portal's existing owned-tunnel and routing locks.
export function createRemovalRouting({
  removeTunnelRoute,
  withRouting,
  snippetPath,
  fs,
  syncHosts,
  reloadCaddy,
  onRemoved,
}) {
  return {
    cleanupRouting: (record) =>
      withRouting(async () => {
        const path = snippetPath(record);
        try {
          const stat = await fs.lstat(path);
          if (stat.isSymbolicLink() || !stat.isFile()) {
            throw new Error(
              'Routing output identity changed; cleanup is blocked'
            );
          }
          const contents = await fs.readFile(path, 'utf8');
          if (!contents.includes(`reverse_proxy localhost:${record.port}\n`)) {
            throw new Error(
              'Routing output belongs to a different port; cleanup is blocked'
            );
          }
          await fs.unlink(path);
        } catch (error) {
          if (error.code !== 'ENOENT') {
            throw error;
          }
        }
        if ((await syncHosts()) !== true) {
          throw new Error(
            'Hosts update failed; the removed worktree port remains reserved'
          );
        }
        if ((await reloadCaddy()) !== true) {
          throw new Error(
            'Caddy reload failed; the removed worktree port remains reserved'
          );
        }
        onRemoved(record);
      }),
    // The durable controller calls this only for an unfinished tunnel stage.
    // An empty process-local route map cannot prove a previous teardown finished.
    detachTunnel: (record) => removeTunnelRoute(record.repo, record.name),
  };
}

export async function applyTunnelConfiguration(
  enabled,
  { removeRoute, configure, reload, addRoute }
) {
  if (!enabled) {
    await removeRoute();
  }
  await configure();
  if ((await reload()) !== true) {
    throw new Error(
      'Caddy reload failed; tunnel configuration did not complete'
    );
  }
  if (enabled) {
    await addRoute();
  }
  return { ok: true };
}

// Claim the shared public URL before entering the new target's setup/restart
// gate. Eviction may need another target's gate and cannot run beneath it.
export function claimTunnelOwner(key, { serialize, routes, release }, claim) {
  return serialize(async () => {
    for (const [previous, route] of [...routes()]) {
      if (previous === key) {
        continue;
      }
      // biome-ignore lint/performance/noAwaitInLoops: Shared-tunnel eviction is ordered; a failed earlier release must prevent later route mutations.
      const result = await release(previous, route);
      if (!result.ok) {
        return result;
      }
    }
    return claim();
  });
}
