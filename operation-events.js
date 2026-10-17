const sources = new Set(['ui', 'cli', 'mcp', 'raycast', 'portal']);
const states = new Set([
  'accepted',
  'queued',
  'running',
  'completed',
  'failed',
  'unknown',
]);
const identifier = /^[a-zA-Z0-9._:-]{1,128}$/;
const code = /^[A-Z][A-Z0-9_]{0,127}$/;

function target(value) {
  if (value === null) {
    return null;
  }
  if (
    !value ||
    typeof value.repo !== 'string' ||
    !value.repo ||
    typeof value.name !== 'string' ||
    !value.name
  ) {
    return;
  }
  return { name: value.name, repo: value.repo };
}

function event(value) {
  if (
    !value ||
    typeof value.id !== 'string' ||
    !identifier.test(value.id) ||
    typeof value.kind !== 'string' ||
    !identifier.test(value.kind) ||
    !sources.has(value.source) ||
    !states.has(value.state) ||
    !Number.isSafeInteger(value.at) ||
    value.at < 0
  ) {
    return;
  }
  const normalizedTarget = target(value.target);
  if (normalizedTarget === undefined) {
    return;
  }
  if (value.operationId !== undefined && !identifier.test(value.operationId)) {
    return;
  }
  if (value.code !== undefined && !code.test(value.code)) {
    return;
  }
  if (
    value.summary !== undefined &&
    (typeof value.summary !== 'string' || value.summary.length > 500)
  ) {
    return;
  }
  return {
    ...(value.code === undefined ? {} : { code: value.code }),
    ...(value.operationId === undefined
      ? {}
      : { operationId: value.operationId }),
    ...(value.summary === undefined ? {} : { summary: value.summary }),
    at: value.at,
    id: value.id,
    kind: value.kind,
    source: value.source,
    state: value.state,
    target: normalizedTarget,
  };
}

function history(value) {
  if (
    value === undefined ||
    (value !== null &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      Object.keys(value).length === 0)
  ) {
    return [];
  }
  if (!(value && Array.isArray(value.events) && value.events.every(event))) {
    throw new Error('invalid operation history');
  }
  return value.events;
}

export function createOperationEvents({
  state,
  now: _now = Date.now,
  limit = 200,
} = {}) {
  if (
    !state ||
    typeof state.read !== 'function' ||
    typeof state.update !== 'function'
  ) {
    throw new TypeError('workspace state is required');
  }
  if (!(Number.isInteger(limit) && limit > 0 && limit <= 1000)) {
    throw new TypeError(
      'limit must be a positive integer no greater than 1000'
    );
  }
  return {
    list({ since, target: requestedTarget, limit: requestedLimit } = {}) {
      if (since !== undefined && (!Number.isSafeInteger(since) || since < 0)) {
        return {
          code: 'OPERATION_EVENT_INVALID',
          error: 'Invalid operation event query.',
          ok: false,
        };
      }
      const normalizedTarget =
        requestedTarget === undefined ? undefined : target(requestedTarget);
      if (normalizedTarget === undefined && requestedTarget !== undefined) {
        return {
          code: 'OPERATION_EVENT_INVALID',
          error: 'Invalid operation event query.',
          ok: false,
        };
      }
      if (
        requestedLimit !== undefined &&
        (!Number.isInteger(requestedLimit) ||
          requestedLimit < 1 ||
          requestedLimit > limit)
      ) {
        return {
          code: 'OPERATION_EVENT_INVALID',
          error: 'Invalid operation event query.',
          ok: false,
        };
      }
      try {
        let events = history(state.read('operationEvents'));
        if (since !== undefined) {
          events = events.filter((item) => item.at >= since);
        }
        if (normalizedTarget !== undefined) {
          events = events.filter((item) =>
            normalizedTarget === null
              ? item.target === null
              : item.target?.repo === normalizedTarget.repo &&
                item.target?.name === normalizedTarget.name
          );
        }
        return { events: events.slice(-(requestedLimit ?? limit)), ok: true };
      } catch {
        return {
          code: 'OPERATION_EVENT_UNAVAILABLE',
          error: 'Operation outcomes could not be read.',
          ok: false,
        };
      }
    },
    async record(input) {
      const next = event(input);
      if (!next) {
        return {
          code: 'OPERATION_EVENT_INVALID',
          error: 'Invalid operation event.',
          ok: false,
        };
      }
      try {
        let recorded;
        let preserved = false;
        await state.update('operationEvents', (record) => {
          const events = history(record);
          const index = events.findIndex((item) => item.id === next.id);
          if (
            index >= 0 &&
            ((events[index].state === 'completed' &&
              next.state !== 'completed') ||
              (['failed', 'unknown'].includes(events[index].state) &&
                ['accepted', 'queued', 'running'].includes(next.state)))
          ) {
            recorded = events[index];
            preserved = true;
            return record;
          }
          const replacement =
            index < 0
              ? [...events, next]
              : events.map((item, itemIndex) =>
                  itemIndex === index ? next : item
                );
          recorded = next;
          return { events: replacement.slice(-limit) };
        });
        return {
          event: recorded,
          ok: true,
          ...(preserved ? { preserved: true } : {}),
        };
      } catch {
        return {
          code: 'OPERATION_EVENT_UNAVAILABLE',
          error: 'Operation outcome could not be recorded.',
          ok: false,
        };
      }
    },
  };
}
