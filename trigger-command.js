export async function runTriggerCommand(
  { repo, name, action = 'start', json = false },
  io
) {
  const finish = (result, exitCode) => {
    if (json) {
      io.stdout(JSON.stringify(result));
    }
    return { exitCode, result };
  };
  if (!(repo && name && ['start', 'stop'].includes(action))) {
    const result = {
      code: 'INVALID_ARGUMENT',
      error: 'Usage: setu trigger <repo> <branch> [stop] [--json]',
      ok: false,
    };
    io.stderr(result.error);
    return finish(result, 1);
  }
  try {
    const result = await io.request(`/api/trigger/${action}`, { name, repo });
    if (!result || typeof result.ok !== 'boolean') {
      throw new Error('Unconfirmed portal response');
    }
    if (!result.ok) {
      io.stderr(result.error || 'Trigger action was not accepted.');
      return finish(result, 1);
    }
    if (!json) {
      io.stdout(`Trigger ${action} accepted for ${repo}/${name} (via portal)`);
    }
    return finish(result, 0);
  } catch (error) {
    const refused = ['ECONNREFUSED', 'ConnectionRefused'].includes(
      error?.code ?? error?.cause?.code
    );
    const result = {
      code: refused ? 'PORTAL_REQUIRED' : 'TRIGGER_OUTCOME_UNKNOWN',
      error: refused
        ? 'The Setu portal is required to start or stop Trigger. No local process was spawned or signaled. Start the portal, then retry.'
        : 'Trigger outcome is not confirmed. Inspect portal status before trying again.',
      ok: false,
    };
    io.stderr(result.error);
    return finish(result, 1);
  }
}
