import { randomUUID } from 'node:crypto';

export async function drainPortalForUpdate({
  dispose,
  closeConnections,
  stopServer,
  exit,
}) {
  dispose();
  closeConnections();
  await stopServer();
  exit(0);
}

// The HTTP token never exposes the lifecycle's private Symbol. Construction is
// inert; the portal supplies its existing owner and supporting-work observation.
export function createPortalUpdateControl({
  lifecycle,
  processIdentity = {},
  hasSupportingWork = () => false,
  randomId = randomUUID,
}) {
  const instanceId = randomId();
  let owner = null,
    mutations = 0,
    unknownMutation = false;
  const { processId, processStartIdentity } = processIdentity;
  const envelope = (result) => ({
    instanceId,
    processId,
    processStartIdentity,
    protocol: 1,
    ...result,
  });
  const refused = (code, error) => envelope({ code, error, ok: false });
  const matches = (body) =>
    owner && body?.instanceId === instanceId && body?.token === owner.token;
  function busy() {
    try {
      return mutations > 0 || unknownMutation || hasSupportingWork();
    } catch {
      return true;
    }
  }
  async function mutate(task, { recovery = false } = {}) {
    if (owner && (!recovery || owner.stopping)) {
      return refused(
        'ADMISSION_CLOSED',
        'Update cutover has closed mutation admission'
      );
    }
    mutations += 1;
    try {
      return await task();
    } catch (error) {
      if (error.code === 'OPERATION_UNKNOWN') {
        unknownMutation = true;
      }
      throw error;
    } finally {
      mutations -= 1;
    }
  }
  function quiesce(body) {
    if (body?.instanceId !== instanceId) {
      return refused(
        'PORTAL_INSTANCE_CHANGED',
        'Refresh update capabilities before requesting cutover'
      );
    }
    if (owner) {
      return refused('ADMISSION_CLOSED', 'Another cutover owns admission');
    }
    const token = randomId();
    const result = lifecycle.quiesce();
    if (!result.token) {
      return envelope(result);
    }
    owner = {
      lifecycleToken: result.token,
      reopening: false,
      stopping: false,
      token,
    };
    const blocked = !result.ok || busy();
    // A busy result still owns closure. Its caller may reopen only before it has
    // changed source/dependencies, or keep closure while diagnosing uncertainty.
    return envelope({
      ok: !blocked,
      token,
      ...(blocked
        ? {
            code: result.code ?? 'OWNED_WORK_ACTIVE',
            error:
              'Active or unknown work blocks cutover; stop Raycast and disable the shared tunnel explicitly before retrying',
          }
        : {}),
    });
  }
  async function reopen(body) {
    if (
      !matches(body) ||
      body.coherent !== true ||
      owner.stopping ||
      owner.reopening
    ) {
      return refused(
        'UPDATE_OWNER_REQUIRED',
        'Only the coherent cutover owner may reopen admission'
      );
    }
    owner.reopening = true;
    try {
      const result = await lifecycle.reopen(owner.lifecycleToken, {
        coherent: true,
      });
      if (result.ok) {
        owner = null;
      }
      return envelope(result);
    } finally {
      if (owner) {
        owner.reopening = false;
      }
    }
  }
  function prepareStop(body) {
    if (!matches(body) || owner.reopening) {
      return refused(
        'UPDATE_OWNER_REQUIRED',
        "Only this portal instance's cutover owner may stop it"
      );
    }
    if (owner.stopping) {
      return envelope({ ok: true });
    }
    const current = lifecycle.quiescenceStatus(owner.lifecycleToken);
    if (!current.ok || busy()) {
      return refused(
        current.code ?? 'OWNED_WORK_ACTIVE',
        'Active or unknown work still blocks portal stop'
      );
    }
    owner.stopping = true;
    return envelope({ ok: true });
  }
  return Object.freeze({
    capabilities: () => envelope({}),
    mutate,
    prepareStop,
    quiesce,
    reopen,
    stopping: () => owner?.stopping === true,
  });
}
