import { isConnectionRefused } from './connection-refused.js';

export async function requestPortalMutation(
  body,
  { url, fetch: send = globalThis.fetch }
) {
  const response = await send(url, {
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json', 'x-setu-source': 'cli' },
    method: 'POST',
    redirect: 'error',
    signal: AbortSignal.timeout(5 * 60_000),
  });
  let result;
  try {
    result = await response.json();
  } catch {
    throw new Error('Portal response could not be read');
  }
  if (
    !result ||
    typeof result.ok !== 'boolean' ||
    (!response.ok && result.ok)
  ) {
    throw new Error('Unconfirmed portal response');
  }
  return result;
}
export const requestRemoval = requestPortalMutation;

export async function runRemoveCommand(
  { repo, name, force = false, operationId, json = false },
  io
) {
  const finish = (result, exitCode) => {
    if (json) {
      io.stdout(JSON.stringify(result));
    }
    return { exitCode, result };
  };
  if (
    !(repo && name) ||
    typeof force !== 'boolean' ||
    (operationId !== undefined &&
      (typeof operationId !== 'string' || !operationId.trim()))
  ) {
    const result = {
      code: 'INVALID_ARGUMENT',
      error:
        'Usage: setu rm <repo> <branch> [--force] [--operation-id <id>] [--json]',
      ok: false,
    };
    io.stderr(result.error);
    return finish(result, 1);
  }
  try {
    const result = await io.request({
      force,
      name,
      repo,
      ...(operationId === undefined ? {} : { operationId }),
    });
    if (!result || typeof result.ok !== 'boolean') {
      throw new Error('Unconfirmed removal response');
    }
    if (result?.ok === false) {
      io.stderr(
        result.error ??
          'Removal failed. Inspect worktree status before retrying.'
      );
      if (result.operationId) {
        const quote = (value) => `'${String(value).replaceAll("'", "'\\''")}'`;
        io.stderr(
          `Operation ${result.operationId}; pending: ${(Array.isArray(result.pendingSteps) ? result.pendingSteps : []).join(', ') || 'inspect status'}. Refresh the portal's Cleanup pending list. Retry only this operation: setu rm ${quote(repo)} ${quote(name)} --operation-id ${quote(result.operationId)}`
        );
      }
      return finish(result, 1);
    }
    if (!json) {
      io.stdout(
        operationId
          ? `removal operation ${operationId} complete for ${repo}/${name}`
          : `removed ${repo}/${name}`
      );
    }
    return finish(result, 0);
  } catch (error) {
    const refused = isConnectionRefused(error);
    const result = {
      code: refused ? 'PORTAL_REQUIRED' : 'REMOVAL_OUTCOME_UNKNOWN',
      ok: false,
      removed: refused ? false : null,
      ...(operationId === undefined ? {} : { operationId }),
      error: refused
        ? 'No files were removed. Start the Setu portal, then retry.'
        : `Removal outcome is unknown. Check GET /api/status for pendingRemovals, then retry only this operation with setu rm ${repo} ${name}${operationId ? ` --operation-id ${operationId}` : ' --operation-id <id>'}.`,
    };
    io.stderr(result.error);
    return finish(result, 1);
  }
}
