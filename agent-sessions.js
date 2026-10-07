const sessionStates = new Set(['starting', 'running', 'ended', 'unknown']);
const ownershipStates = new Set(['owned', 'unknown']);

const clone = (value) => JSON.parse(JSON.stringify(value));
const validString = (value) => typeof value === 'string' && value.length > 0;
const validPid = (value) => Number.isSafeInteger(value) && value > 0;
const validTime = (value) =>
  validString(value) || (typeof value === 'number' && Number.isFinite(value));
const ghosttyTerminalId =
  /^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}$/i;
const validTerminal = (value) =>
  value === undefined ||
  (value && value.kind === 'ghostty' && ghosttyTerminalId.test(value.id));

function sameValue(a, b) {
  if (a === b) {
    return true;
  }
  if (!(a && b && typeof a === 'object' && typeof b === 'object')) {
    return false;
  }
  const aKeys = Object.keys(a).sort(),
    bKeys = Object.keys(b).sort();
  return (
    aKeys.length === bKeys.length &&
    aKeys.every(
      (key, index) => key === bKeys[index] && sameValue(a[key], b[key])
    )
  );
}

function validRecord(value) {
  return (
    value &&
    typeof value === 'object' &&
    ['id', 'repo', 'name', 'checkoutPath', 'tool'].every((key) =>
      validString(value[key])
    ) &&
    'checkoutIdentity' in value &&
    validTime(value.launchedAt) &&
    (value.pid === null || validPid(value.pid)) &&
    (value.processStart === null || validString(value.processStart)) &&
    sessionStates.has(value.state) &&
    ownershipStates.has(value.ownership) &&
    validTerminal(value.terminal) &&
    (value.endedAt === undefined || validTime(value.endedAt)) &&
    (value.endReason === undefined || validString(value.endReason))
  );
}

export { validRecord as validAgentSessionRecord };

function matches(record, observation) {
  return (
    observation?.state === 'alive' &&
    observation.processId === record.pid &&
    observation.processStartIdentity === record.processStart
  );
}

function unknown(record) {
  return { ...record, ownership: 'unknown', state: 'unknown' };
}

function ended(record, now, endReason) {
  return { ...record, endedAt: now(), endReason, state: 'ended' };
}

function stateFailure() {
  return {
    code: 'SESSION_STATE_CORRUPT',
    error: 'Session state is malformed',
    ok: false,
  };
}

function sessionRecords(document) {
  if (document.sessions === undefined) {
    return { ok: true, records: [] };
  }
  const sessions = document.sessions;
  if (
    !(
      sessions &&
      typeof sessions === 'object' &&
      !Array.isArray(sessions) &&
      Object.entries(sessions).every(
        ([id, record]) => id === record?.id && validRecord(record)
      )
    )
  ) {
    return { ok: false };
  }
  return { ok: true, records: Object.values(sessions) };
}

export function createAgentSessions({
  state,
  observeProcess,
  signal,
  now,
  findChildren = async () => ({ state: 'unknown' }),
} = {}) {
  if (
    !(
      state &&
      typeof state.read === 'function' &&
      typeof state.update === 'function'
    )
  ) {
    throw new TypeError('Agent sessions need workspace state');
  }
  if (
    ![
      ['observeProcess', observeProcess],
      ['signal', signal],
      ['now', now],
    ].every(([, value]) => typeof value === 'function')
  ) {
    throw new TypeError('Agent sessions need process and clock collaborators');
  }

  function records() {
    const current = sessionRecords(state.read('agentSessions'));
    if (!current.ok) {
      const error = new Error('SESSION_STATE_CORRUPT');
      error.code = 'SESSION_STATE_CORRUPT';
      throw error;
    }
    return clone(current.records);
  }
  async function replace(mutate) {
    if (!sessionRecords(state.read('agentSessions')).ok) {
      return { result: stateFailure() };
    }
    let result;
    try {
      await state.update('agentSessions', async (document) => {
        const current = sessionRecords(document);
        if (!current.ok) {
          const error = new Error('SESSION_STATE_CORRUPT');
          error.code = 'SESSION_STATE_CORRUPT';
          throw error;
        }
        result = await mutate(clone(current.records));
        return {
          ...document,
          sessions: Object.fromEntries(
            result.records.map((record) => [record.id, record])
          ),
        };
      });
    } catch (error) {
      if (error?.code === 'SESSION_STATE_CORRUPT') {
        return { result: stateFailure() };
      }
      throw error;
    }
    return result;
  }
  async function observe(record) {
    try {
      return await observeProcess(record.pid);
    } catch {
      return { state: 'unknown' };
    }
  }
  async function inspectChildren(record) {
    let tree;
    try {
      tree = await findChildren({
        pid: record.pid,
        processStart: record.processStart,
      });
    } catch {
      return { state: 'unknown' };
    }
    if (tree?.state !== 'owned' || !Array.isArray(tree.children)) {
      return { state: 'unknown' };
    }
    for (const child of tree.children) {
      const childObservation = await observe(child);
      if (matches(child, childObservation)) {
        return { state: 'alive' };
      }
      if (childObservation?.state !== 'absent') {
        return { state: 'unknown' };
      }
    }
    return { state: 'absent', tree };
  }
  async function inspectListedChildren(children) {
    for (const child of children) {
      const childObservation = await observe(child);
      if (matches(child, childObservation)) {
        return 'alive';
      }
      if (childObservation?.state !== 'absent') {
        return 'unknown';
      }
    }
    return 'absent';
  }
  function get(id) {
    return validString(id)
      ? (records().find((record) => record.id === id) ?? null)
      : null;
  }
  function list() {
    return records();
  }
  async function register(launch) {
    if (
      !(
        launch &&
        ['id', 'repo', 'name', 'checkoutPath', 'tool'].every((key) =>
          validString(launch[key])
        ) &&
        launch.checkoutIdentity !== undefined &&
        validTerminal(launch.terminal)
      )
    ) {
      return {
        code: 'SESSION_INVALID',
        error: 'Session details are invalid',
        ok: false,
      };
    }
    const hasProcess =
      launch.pid !== undefined || launch.processStart !== undefined;
    if (
      hasProcess &&
      !(validPid(launch.pid) && validString(launch.processStart))
    ) {
      return {
        code: 'SESSION_INVALID',
        error: 'Process identity is invalid',
        ok: false,
      };
    }
    let observation;
    if (hasProcess) {
      try {
        observation = await observeProcess(launch.pid);
      } catch {
        observation = { state: 'unknown' };
      }
      if (
        !matches(
          { pid: launch.pid, processStart: launch.processStart },
          observation
        )
      ) {
        return {
          code: 'SESSION_PROCESS_IDENTITY_UNKNOWN',
          error: 'Coding process identity cannot be confirmed',
          ok: false,
        };
      }
    }
    return replace(async (current) => {
      const existing = current.find((record) => record.id === launch.id);
      if (existing) {
        if (
          !sameValue(existing.checkoutIdentity, launch.checkoutIdentity) ||
          existing.checkoutPath !== launch.checkoutPath ||
          existing.repo !== launch.repo ||
          existing.name !== launch.name ||
          existing.tool !== launch.tool ||
          (existing.terminal &&
            launch.terminal &&
            !sameValue(existing.terminal, launch.terminal))
        ) {
          return {
            records: current,
            result: {
              code: 'SESSION_ID_CONFLICT',
              error: 'Session id is already in use',
              ok: false,
            },
          };
        }
        if (
          !hasProcess ||
          (existing.pid === launch.pid &&
            existing.processStart === launch.processStart)
        ) {
          const session =
            launch.terminal && !existing.terminal
              ? { ...existing, terminal: clone(launch.terminal) }
              : existing;
          return {
            records: current.map((record) =>
              record.id === session.id ? session : record
            ),
            result: { ok: true, session },
          };
        }
        if (existing.state !== 'starting') {
          return {
            records: current,
            result: {
              code: 'SESSION_ID_CONFLICT',
              error: 'Session is already registered',
              ok: false,
            },
          };
        }
        const session = {
          ...existing,
          ownership: 'owned',
          pid: launch.pid,
          processStart: launch.processStart,
          state: 'running',
          ...(launch.terminal && !existing.terminal
            ? { terminal: clone(launch.terminal) }
            : {}),
        };
        return {
          records: current.map((record) =>
            record.id === session.id ? session : record
          ),
          result: { ok: true, session },
        };
      }
      const session = {
        checkoutIdentity: clone(launch.checkoutIdentity),
        checkoutPath: launch.checkoutPath,
        id: launch.id,
        launchedAt: launch.launchedAt ?? now(),
        name: launch.name,
        ownership: 'owned',
        pid: hasProcess ? launch.pid : null,
        processStart: hasProcess ? launch.processStart : null,
        repo: launch.repo,
        state: hasProcess ? 'running' : 'starting',
        ...(launch.terminal ? { terminal: clone(launch.terminal) } : {}),
        tool: launch.tool,
      };
      return { records: [...current, session], result: { ok: true, session } };
    }).then((outcome) => outcome.result);
  }
  async function reconcile() {
    return replace(async (current) => {
      const next = [];
      for (const record of current) {
        if (record.state === 'ended') {
          next.push(record);
          continue;
        }
        if (!(validPid(record.pid) && validString(record.processStart))) {
          next.push(unknown(record));
          continue;
        }
        const observation = await observe(record);
        if (observation?.state === 'absent') {
          const children = await inspectChildren(record);
          next.push(
            children.state === 'absent'
              ? ended(record, now, 'exited')
              : unknown(record)
          );
        } else if (matches(record, observation)) {
          next.push({ ...record, state: 'running' });
        } else {
          next.push(unknown(record));
        }
      }
      return { records: next, result: { ok: true, sessions: clone(next) } };
    }).then((outcome) => outcome.result);
  }
  // A launch that never reached an external process is a known terminal
  // outcome. Keep this separate from unknown, which retains ownership.
  async function fail(id, { checkoutIdentity, reason = 'launch-failed' } = {}) {
    if (!validString(id)) {
      return {
        code: 'SESSION_NOT_FOUND',
        error: 'Session was not found',
        ok: false,
      };
    }
    return replace(async (current) => {
      const index = current.findIndex((record) => record.id === id);
      const record = current[index];
      if (!record) {
        return {
          records: current,
          result: {
            code: 'SESSION_NOT_FOUND',
            error: 'Session was not found',
            ok: false,
          },
        };
      }
      if (!sameValue(record.checkoutIdentity, checkoutIdentity)) {
        return {
          records: current,
          result: {
            code: 'SESSION_CHECKOUT_CHANGED',
            error: 'Checkout identity changed',
            ok: false,
          },
        };
      }
      if (record.state !== 'starting' || record.pid !== null) {
        return {
          records: current,
          result: {
            code: 'SESSION_FAILURE_UNSAFE',
            error: 'Session process outcome is not known',
            ok: false,
          },
        };
      }
      const session = ended(record, now, reason);
      return {
        records: current.with(index, session),
        result: { ok: true, session },
      };
    }).then((outcome) => outcome.result);
  }
  async function end(id, { checkoutIdentity } = {}) {
    if (!validString(id)) {
      return {
        code: 'SESSION_NOT_FOUND',
        error: 'Session was not found',
        ok: false,
      };
    }
    return replace(async (current) => {
      const index = current.findIndex((record) => record.id === id);
      if (index < 0) {
        return {
          records: current,
          result: {
            code: 'SESSION_NOT_FOUND',
            error: 'Session was not found',
            ok: false,
          },
        };
      }
      const record = current[index];
      if (!sameValue(record.checkoutIdentity, checkoutIdentity)) {
        return {
          records: current,
          result: {
            code: 'SESSION_CHECKOUT_CHANGED',
            error: 'Checkout identity changed',
            ok: false,
          },
        };
      }
      if (record.state === 'ended') {
        return { records: current, result: { ok: true, session: record } };
      }
      if (record.ownership !== 'owned' || record.state !== 'running') {
        return {
          records: current,
          result: {
            code: 'SESSION_OWNERSHIP_UNKNOWN',
            error: 'Session ownership is unresolved',
            ok: false,
          },
        };
      }
      let root = await observe(record);
      if (root?.state === 'absent') {
        const children = await inspectChildren(record);
        const session =
          children.state === 'absent'
            ? ended(record, now, 'exited')
            : unknown(record);
        const records = current.with(index, session);
        return {
          records,
          result:
            children.state === 'absent'
              ? { ok: true, session }
              : {
                  code: 'SESSION_OWNERSHIP_UNKNOWN',
                  error: 'Descendant ownership is unresolved',
                  ok: false,
                  session,
                },
        };
      }
      if (root?.state === 'alive' && !matches(record, root)) {
        const session = unknown(record);
        const records = current.with(index, session);
        return {
          records,
          result: {
            code: 'SESSION_PROCESS_IDENTITY_CHANGED',
            error: 'Process identity changed',
            ok: false,
            session,
          },
        };
      }
      if (!matches(record, root)) {
        const session = unknown(record);
        const records = current.with(index, session);
        return {
          records,
          result: {
            code: 'SESSION_OWNERSHIP_UNKNOWN',
            error: 'Session ownership is unresolved',
            ok: false,
            session,
          },
        };
      }
      let tree;
      try {
        tree = await findChildren({
          pid: record.pid,
          processStart: record.processStart,
        });
      } catch {
        tree = { state: 'unknown' };
      }
      if (tree?.state !== 'owned' || !Array.isArray(tree.children)) {
        return {
          records: current,
          result: {
            code: 'SESSION_OWNERSHIP_UNKNOWN',
            error: 'Child ownership is unresolved',
            ok: false,
          },
        };
      }
      for (const child of [...tree.children].reverse()) {
        const childObservation = await observe(child);
        if (!matches(child, childObservation)) {
          return {
            records: current,
            result: {
              code: 'SESSION_OWNERSHIP_UNKNOWN',
              error: 'Child ownership is unresolved',
              ok: false,
            },
          };
        }
        try {
          await signal(child.pid, 'SIGTERM');
        } catch {
          const session = unknown(record);
          const records = current.with(index, session);
          return {
            records,
            result: {
              code: 'SESSION_END_UNKNOWN',
              error: 'Child stop outcome is unknown',
              ok: false,
              session,
            },
          };
        }
      }
      root = await observe(record);
      if (!matches(record, root)) {
        const session = unknown(record);
        const records = current.with(index, session);
        return {
          records,
          result: {
            code: 'SESSION_OWNERSHIP_UNKNOWN',
            error: 'Session ownership is unresolved',
            ok: false,
            session,
          },
        };
      }
      try {
        await signal(record.pid, 'SIGTERM');
      } catch {
        const session = unknown(record);
        const records = current.with(index, session);
        return {
          records,
          result: {
            code: 'SESSION_END_UNKNOWN',
            error: 'Session stop outcome is unknown',
            ok: false,
            session,
          },
        };
      }
      const after = await observe(record);
      const childrenAfter = await inspectListedChildren(tree.children);
      if (after?.state === 'absent' && childrenAfter === 'absent') {
        const session = ended(record, now, 'ended-by-user');
        const records = current.with(index, session);
        return { records, result: { ok: true, session } };
      }
      if (matches(record, after) && childrenAfter === 'absent') {
        return {
          records: current,
          result: { ok: true, pending: true, session: record },
        };
      }
      const session = unknown(record);
      const records = current.with(index, session);
      return {
        records,
        result: {
          code: 'SESSION_END_UNKNOWN',
          error: 'Session stop outcome is unknown',
          ok: false,
          session,
        },
      };
    }).then((outcome) => outcome.result);
  }
  return { end, fail, get, list, reconcile, register };
}
