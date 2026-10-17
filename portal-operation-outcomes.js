// Thin portal composition helper. Callers decide when an operation is accepted,
// running, completed, failed, or unknown; this only preserves one id/source and
// makes recorder failure non-fatal.
export function createPortalOperationOutcomes({
  events,
  now = Date.now,
  operationId = () => crypto.randomUUID(),
} = {}) {
  if (!events?.record) {
    throw new TypeError('operation event recorder is required');
  }
  const write = async (entry) => {
    try {
      const result = await events.record({ at: now(), ...entry });
      return result?.ok === true ? {} : { outcomeRecorded: false };
    } catch {
      return { outcomeRecorded: false };
    }
  };
  const stateFor = (result) => {
    if (result?.state === 'unknown' || result?.code?.includes('UNKNOWN')) {
      return 'unknown';
    }
    return result?.ok === false ? 'failed' : 'completed';
  };
  return {
    async accept({
      kind,
      source = 'portal',
      target = null,
      id = operationId(),
    }) {
      return {
        id,
        kind,
        source,
        target,
        ...(await write({
          id,
          kind,
          operationId: id,
          source,
          state: 'accepted',
          target,
        })),
      };
    },
    handle(kind, source, target) {
      return {
        id: operationId(),
        kind,
        source: source ?? 'portal',
        target: target ? { name: target.name, repo: target.repo } : null,
      };
    },
    running(handle) {
      return write({
        id: handle.id,
        kind: handle.kind,
        operationId: handle.id,
        source: handle.source,
        state: 'running',
        target: handle.target,
      });
    },
    async settle(
      handle,
      result,
      { state = stateFor(result), code = result?.code } = {}
    ) {
      const recording = await write({
        ...(code ? { code } : {}),
        id: handle.id,
        kind: handle.kind,
        operationId: handle.id,
        source: handle.source,
        state,
        target: handle.target,
      });
      return {
        ...result,
        operationId: result?.operationId ?? handle.id,
        ...(handle.outcomeRecorded === false ||
        recording.outcomeRecorded === false
          ? { outcomeRecorded: false }
          : {}),
      };
    },
    watch(handle, completion) {
      return Promise.resolve(completion).then(
        (result) => this.settle(handle, result),
        (error) =>
          this.settle(
            handle,
            { code: error?.code, error: error?.message, ok: false },
            {
              code: error?.code,
              state: error?.code === 'OPERATION_UNKNOWN' ? 'unknown' : 'failed',
            }
          )
      );
    },
  };
}
