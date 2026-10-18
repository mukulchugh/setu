import { createHash, timingSafeEqual } from 'node:crypto';

const sessionStates = new Set(['starting', 'running', 'ended', 'unknown']);
const ownershipStates = new Set(['owned', 'unknown']);

export const maxReplacedHistory = 8;
const digestPattern = /^[0-9a-f]{64}$/;

// Only this digest of a per-launch capability is ever persisted.
export const launchProofDigest = (token) =>
  createHash('sha256').update(token).digest('hex');

// Stable text for an identity object, so equal identities digest equally whatever their key order.
const stable = (value) => {
  if (Array.isArray(value)) {
    return `[${value.map(stable).join(',')}]`;
  }
  if (value && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stable(value[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
};
export const identityDigest = (identity) =>
  createHash('sha256').update(stable(identity)).digest('hex');

const digestMatches = (stored, presented) =>
  digestPattern.test(stored) &&
  digestPattern.test(presented) &&
  timingSafeEqual(Buffer.from(stored, 'hex'), Buffer.from(presented, 'hex'));

// A reviewed resume carried by one fresh launch: which conversation, and which ended records held it.
const validResumeIntent = (intent) =>
  intent === undefined ||
  (validString(intent?.nativeId) &&
    Array.isArray(intent.from) &&
    intent.from.length > 0 &&
    intent.from.length <= maxReplacedHistory &&
    intent.from.every(validString) &&
    validTime(intent.reviewedAt));

const validReplaced = (entry) =>
  validString(entry?.id) &&
  validTime(entry.boundAt) &&
  validTime(entry.replacedAt);

const validResumedFrom = (value) =>
  value === undefined ||
  (Array.isArray(value) &&
    value.length <= maxReplacedHistory &&
    value.every(validString));

// Optional and validated apart from validRecord, so a bad binding never makes
// the whole session list unreadable. An invalid one counts as no binding.
const validBinding = (binding) =>
  validString(binding?.provider) &&
  validResumedFrom(binding.resumedFrom) &&
  validString(binding.id) &&
  validTime(binding.boundAt) &&
  Array.isArray(binding.history) &&
  binding.history.length <= maxReplacedHistory &&
  binding.history.every(validReplaced);

const currentBinding = (record) =>
  validBinding(record.nativeConversation) ? record.nativeConversation : null;

// Same id: unchanged. A new id replaces the current one, which joins the
// bounded history. An id from that history is an exact resume, not a new entry.
function nextBinding(binding, { nativeId, provider, resumedFrom }, at) {
  if (binding?.id === nativeId) {
    return binding;
  }
  const history = (binding?.history ?? []).filter(
    (entry) => entry.id !== nativeId
  );
  if (binding) {
    history.push({ boundAt: binding.boundAt, id: binding.id, replacedAt: at });
  }
  return {
    boundAt: at,
    history: history.slice(-maxReplacedHistory),
    id: nativeId,
    provider,
    // Only an explicit, reviewed resume sets this: the earlier records this conversation was bound under.
    ...(resumedFrom?.length ? { resumedFrom } : {}),
  };
}

const canonicalTool = (tool) => (tool === 'claude' ? 'claude-code' : tool);

const clone = (value) => JSON.parse(JSON.stringify(value));
const validString = (value) => typeof value === 'string' && value.length > 0;
const validPid = (value) => Number.isSafeInteger(value) && value > 0;
const validTime = (value) =>
  validString(value) || (typeof value === 'number' && Number.isFinite(value));
// A hook time is a number of milliseconds: finite (validTime) and positive.
const validHookTime = (value) =>
  typeof value === 'number' && validTime(value) && value > 0;
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
    (value.endReason === undefined || validString(value.endReason)) &&
    (value.lastHookAt === undefined || validHookTime(value.lastHookAt))
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

// The binding's generation is a persisted counter on the record itself. It only moves up, once per
// decision, inside the same document lock that makes the decision. Wall clocks play no part.
const generationOf = (record) =>
  Number.isSafeInteger(record.bindingGeneration) && record.bindingGeneration > 0
    ? record.bindingGeneration
    : 0;

// A decision that ends or voids the binding: the new generation is the one the invalidation is sent at,
// strictly above the binding it ends.
function invalidated(record, reason) {
  const generation = generationOf(record) + 1;
  return {
    ...record,
    bindingGeneration: generation,
    bindingInvalid: { generation, reason },
  };
}

function unknown(record) {
  const next = { ...record, ownership: 'unknown', state: 'unknown' };
  // Repeated observations of an already unknown record are not new decisions.
  return record.state === 'unknown'
    ? next
    : invalidated(next, 'ownership-unknown');
}

function ended(record, now, endReason) {
  return invalidated(
    { ...record, endedAt: now(), endReason, state: 'ended' },
    'ended'
  );
}

// An unknown record observed running again is a decision of its own, so the generation advances past the
// invalidation. Only a record that is still owned has a binding that can be live again.
function verifiedRunning(record) {
  const { bindingInvalid: _voided, ...rest } = record;
  return {
    ...(record.ownership === 'owned' ? rest : record),
    bindingGeneration: generationOf(record) + 1,
    state: 'running',
  };
}

function stateFailure() {
  return {
    code: 'SESSION_STATE_CORRUPT',
    error: 'Session state is malformed',
    ok: false,
  };
}

function sessionRecords(document) {
  const { sessions } = document;
  if (sessions === undefined) {
    return { ok: true, records: [] };
  }
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
  observeCheckout = async () => null,
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

  function storedRecords() {
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
      // biome-ignore lint/suspicious/noUnnecessaryConditions: State collaborators can reject with nullish or non-Error values.
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
      // biome-ignore lint/performance/noAwaitInLoops: The first alive or unknown descendant determines this ownership result.
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
      // biome-ignore lint/performance/noAwaitInLoops: The first alive or unknown descendant determines this ownership result.
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
  const resultWithRecords = (records, result) => ({ records, result });
  const failedSession = (records, code, error) =>
    resultWithRecords(records, { code, error, ok: false });
  const updatedSession = (records, index, session, result) =>
    resultWithRecords(records.with(index, session), result);
  const unknownSession = (records, index, record, code, error) => {
    const session = unknown(record);
    return updatedSession(records, index, session, {
      code,
      error,
      ok: false,
      session,
    });
  };
  function conflictsWithLaunch(existing, launch) {
    return (
      !sameValue(existing.checkoutIdentity, launch.checkoutIdentity) ||
      existing.checkoutPath !== launch.checkoutPath ||
      existing.repo !== launch.repo ||
      existing.name !== launch.name ||
      existing.tool !== launch.tool ||
      (existing.terminal &&
        launch.terminal &&
        !sameValue(existing.terminal, launch.terminal))
    );
  }
  function sessionWithTerminal(session, terminal) {
    return terminal && !session.terminal
      ? { ...session, terminal: clone(terminal) }
      : session;
  }
  function replaceRegisteredSession(records, session) {
    return records.map((record) =>
      record.id === session.id ? session : record
    );
  }
  function registerExistingSession(records, existing, launch, hasProcess) {
    if (conflictsWithLaunch(existing, launch)) {
      return failedSession(
        records,
        'SESSION_ID_CONFLICT',
        'Session id is already in use'
      );
    }
    if (
      !hasProcess ||
      (existing.pid === launch.pid &&
        existing.processStart === launch.processStart)
    ) {
      const session = sessionWithTerminal(existing, launch.terminal);
      return resultWithRecords(replaceRegisteredSession(records, session), {
        ok: true,
        session,
      });
    }
    if (existing.state !== 'starting') {
      return failedSession(
        records,
        'SESSION_ID_CONFLICT',
        'Session is already registered'
      );
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
    return resultWithRecords(replaceRegisteredSession(records, session), {
      ok: true,
      session,
    });
  }
  function newSession(launch, hasProcess) {
    return {
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
      ...(launch.launchProofDigest
        ? { launchProofDigest: launch.launchProofDigest }
        : {}),
      ...(launch.resumeIntent
        ? { resumeIntent: clone(launch.resumeIntent) }
        : {}),
    };
  }
  async function reconciledSession(record) {
    const observation = await observe(record);
    if (observation?.state === 'absent') {
      const children = await inspectChildren(record);
      return children.state === 'absent'
        ? ended(record, now, 'exited')
        : unknown(record);
    }
    if (matches(record, observation)) {
      return record.state === 'unknown'
        ? verifiedRunning(record)
        : { ...record, state: 'running' };
    }
    return unknown(record);
  }
  function endPreflight(records, id, checkoutIdentity) {
    const index = records.findIndex((candidate) => candidate.id === id);
    if (index < 0) {
      return {
        outcome: failedSession(
          records,
          'SESSION_NOT_FOUND',
          'Session was not found'
        ),
      };
    }
    const record = records[index];
    if (!sameValue(record.checkoutIdentity, checkoutIdentity)) {
      return {
        outcome: failedSession(
          records,
          'SESSION_CHECKOUT_CHANGED',
          'Checkout identity changed'
        ),
      };
    }
    if (record.state === 'ended') {
      return {
        outcome: resultWithRecords(records, { ok: true, session: record }),
      };
    }
    if (record.ownership !== 'owned' || record.state !== 'running') {
      return {
        outcome: failedSession(
          records,
          'SESSION_OWNERSHIP_UNKNOWN',
          'Session ownership is unresolved'
        ),
      };
    }
    return { index, record };
  }
  async function endAbsentRoot(records, index, record) {
    const children = await inspectChildren(record);
    const session =
      children.state === 'absent'
        ? ended(record, now, 'exited')
        : unknown(record);
    const result =
      children.state === 'absent'
        ? { ok: true, session }
        : {
            code: 'SESSION_OWNERSHIP_UNKNOWN',
            error: 'Descendant ownership is unresolved',
            ok: false,
            session,
          };
    return updatedSession(records, index, session, result);
  }
  async function ownedChildren(record) {
    let tree;
    try {
      tree = await findChildren({
        pid: record.pid,
        processStart: record.processStart,
      });
    } catch {
      tree = { state: 'unknown' };
    }
    return tree?.state === 'owned' && Array.isArray(tree.children)
      ? tree.children
      : null;
  }
  async function stopChildren(children) {
    for (const child of [...children].reverse()) {
      // biome-ignore lint/performance/noAwaitInLoops: Verify and stop descendants in reverse tree order before signalling their parent.
      const childObservation = await observe(child);
      if (!matches(child, childObservation)) {
        return 'ownership';
      }
      try {
        await signal(child.pid, 'SIGTERM');
      } catch {
        return 'unknown';
      }
    }
    return 'stopped';
  }
  async function endAfterSignal(records, index, record, children) {
    const after = await observe(record);
    const childrenAfter = await inspectListedChildren(children);
    if (after?.state === 'absent' && childrenAfter === 'absent') {
      const session = ended(record, now, 'ended-by-user');
      return updatedSession(records, index, session, { ok: true, session });
    }
    if (matches(record, after) && childrenAfter === 'absent') {
      return resultWithRecords(records, {
        ok: true,
        pending: true,
        session: record,
      });
    }
    return unknownSession(
      records,
      index,
      record,
      'SESSION_END_UNKNOWN',
      'Session stop outcome is unknown'
    );
  }
  async function initialEndOutcome(records, index, record) {
    const root = await observe(record);
    if (root?.state === 'absent') {
      return endAbsentRoot(records, index, record);
    }
    if (root?.state === 'alive' && !matches(record, root)) {
      return unknownSession(
        records,
        index,
        record,
        'SESSION_PROCESS_IDENTITY_CHANGED',
        'Process identity changed'
      );
    }
    return matches(record, root)
      ? null
      : unknownSession(
          records,
          index,
          record,
          'SESSION_OWNERSHIP_UNKNOWN',
          'Session ownership is unresolved'
        );
  }
  async function stopOwnedSession(records, index, record) {
    const children = await ownedChildren(record);
    if (!children) {
      return failedSession(
        records,
        'SESSION_OWNERSHIP_UNKNOWN',
        'Child ownership is unresolved'
      );
    }
    const childStop = await stopChildren(children);
    if (childStop === 'ownership') {
      return failedSession(
        records,
        'SESSION_OWNERSHIP_UNKNOWN',
        'Child ownership is unresolved'
      );
    }
    if (childStop === 'unknown') {
      return unknownSession(
        records,
        index,
        record,
        'SESSION_END_UNKNOWN',
        'Child stop outcome is unknown'
      );
    }
    if (!matches(record, await observe(record))) {
      return unknownSession(
        records,
        index,
        record,
        'SESSION_OWNERSHIP_UNKNOWN',
        'Session ownership is unresolved'
      );
    }
    try {
      await signal(record.pid, 'SIGTERM');
    } catch {
      return unknownSession(
        records,
        index,
        record,
        'SESSION_END_UNKNOWN',
        'Session stop outcome is unknown'
      );
    }
    return endAfterSignal(records, index, record, children);
  }
  function get(id) {
    return validString(id)
      ? (storedRecords().find((record) => record.id === id) ?? null)
      : null;
  }
  function list() {
    return storedRecords();
  }
  async function register(launch) {
    if (
      !(
        launch &&
        ['id', 'repo', 'name', 'checkoutPath', 'tool'].every((key) =>
          validString(launch[key])
        ) &&
        launch.checkoutIdentity !== undefined &&
        validTerminal(launch.terminal) &&
        (launch.launchProofDigest === undefined ||
          digestPattern.test(launch.launchProofDigest)) &&
        validResumeIntent(launch.resumeIntent)
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
    return replace((current) => {
      const existing = current.find((record) => record.id === launch.id);
      if (existing) {
        return registerExistingSession(current, existing, launch, hasProcess);
      }
      const session = newSession(launch, hasProcess);
      return { records: [...current, session], result: { ok: true, session } };
    }).then((outcome) => outcome.result);
  }
  // biome-ignore lint/suspicious/useAwait: Reconciliation remains a public Promise boundary for synchronous state collaborator failures.
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
        // biome-ignore lint/performance/noAwaitInLoops: Preserve session-record order while each observation determines its exact next state.
        next.push(await reconciledSession(record));
      }
      return { records: next, result: { ok: true, sessions: clone(next) } };
    }).then((outcome) => outcome.result);
  }
  // A launch that never reached an external process is a known terminal
  // outcome. Keep this separate from unknown, which retains ownership.
  // biome-ignore lint/suspicious/useAwait: This public state transition must surface synchronous collaborator failures as rejected promises.
  async function fail(id, { checkoutIdentity, reason = 'launch-failed' } = {}) {
    if (!validString(id)) {
      return {
        code: 'SESSION_NOT_FOUND',
        error: 'Session was not found',
        ok: false,
      };
    }
    return replace((currentRecords) => {
      const index = currentRecords.findIndex(
        (candidate) => candidate.id === id
      );
      const record = currentRecords[index];
      if (!record) {
        return {
          records: currentRecords,
          result: {
            code: 'SESSION_NOT_FOUND',
            error: 'Session was not found',
            ok: false,
          },
        };
      }
      if (!sameValue(record.checkoutIdentity, checkoutIdentity)) {
        return {
          records: currentRecords,
          result: {
            code: 'SESSION_CHECKOUT_CHANGED',
            error: 'Checkout identity changed',
            ok: false,
          },
        };
      }
      if (record.state !== 'starting' || record.pid !== null) {
        return {
          records: currentRecords,
          result: {
            code: 'SESSION_FAILURE_UNSAFE',
            error: 'Session process outcome is not known',
            ok: false,
          },
        };
      }
      const session = ended(record, now, reason);
      return {
        records: currentRecords.with(index, session),
        result: { ok: true, session },
      };
    }).then((outcome) => outcome.result);
  }
  // biome-ignore lint/suspicious/useAwait: This public termination API preserves rejected synchronous state and validation failures.
  async function end(id, { checkoutIdentity } = {}) {
    if (!validString(id)) {
      return {
        code: 'SESSION_NOT_FOUND',
        error: 'Session was not found',
        ok: false,
      };
    }
    return replace(async (currentRecords) => {
      const preflight = endPreflight(currentRecords, id, checkoutIdentity);
      if ('outcome' in preflight) {
        return preflight.outcome;
      }
      const { index, record } = preflight;
      const initial = await initialEndOutcome(currentRecords, index, record);
      return initial ?? stopOwnedSession(currentRecords, index, record);
    }).then((outcome) => outcome.result);
  }
  const refusal = (records, reason) =>
    resultWithRecords(records, { ok: false, reason });
  // Only a live owned record currently holding the id is a concurrent owner.
  // Anything else (ended, unconfirmed, or replaced away) is never adopted by itself.
  const conflictReason = (holders, nativeId) =>
    holders.some(
      (holder) =>
        holder.ownership === 'owned' &&
        ['starting', 'running'].includes(holder.state) &&
        holder.nativeConversation.id === nativeId
    )
      ? 'native-conversation-in-use'
      : 'native-conversation-previously-bound';
  // The one way a conversation bound under earlier records binds again: this fresh launch carries a
  // reviewed intent for exactly this ID, and every earlier holder is a record that ended in this same
  // checkout and was named at review. A holder that appeared after review is never adopted.
  function reviewedResume(record, holders, nativeId) {
    const intent = record.resumeIntent;
    if (
      !(
        validResumeIntent(intent) &&
        intent?.nativeId === nativeId &&
        holders.every(
          (holder) =>
            holder.state === 'ended' &&
            holder.repo === record.repo &&
            holder.name === record.name &&
            sameValue(holder.checkoutIdentity, record.checkoutIdentity) &&
            intent.from.includes(holder.id)
        )
      )
    ) {
      return null;
    }
    return holders.map((holder) => holder.id).slice(-maxReplacedHistory);
  }
  async function freshIdentity(record) {
    try {
      return (await observeCheckout(record)) ?? null;
    } catch {
      return null;
    }
  }
  // Native id and cwd only locate; the launch proof authorizes. Reasons are
  // stable, non-secret names for each refusal.
  function sessionProblem(record, { provider, checkoutPath, fresh, states }) {
    if (canonicalTool(record.tool) !== provider) {
      return 'provider-mismatch';
    }
    if (record.ownership !== 'owned') {
      return 'session-not-owned';
    }
    if (record.state === 'ended') {
      return 'session-ended';
    }
    if (!states.includes(record.state)) {
      return 'session-not-running';
    }
    if (record.checkoutPath !== checkoutPath) {
      return 'checkout-path-mismatch';
    }
    if (!fresh) {
      return 'checkout-unverified';
    }
    return sameValue(record.checkoutIdentity, fresh)
      ? null
      : 'checkout-changed';
  }
  // Compare every record so timing does not reveal which digest matched.
  const findByLaunchProof = (records, digest) =>
    records.reduce(
      (found, record) =>
        digestMatches(record.launchProofDigest, digest) ? record : found,
      null
    );
  // The time of the latest authenticated hook event of a running, owned session. Only the hook ingress calls
  // this, after it has verified the launch capability, provider, checkout and lifecycle; nothing else (not a
  // poll, not process liveness) is activity. It never moves backwards and is never set for any other session.
  function recordHookActivity({ id, at }) {
    return replace((current) => {
      const index = current.findIndex((candidate) => candidate.id === id);
      const heard = current[index];
      if (
        !(
          heard &&
          heard.state === 'running' &&
          heard.ownership === 'owned' &&
          validHookTime(at) &&
          at > (heard.lastHookAt ?? 0)
        )
      ) {
        return resultWithRecords(current, { ok: false });
      }
      return updatedSession(
        current,
        index,
        { ...heard, lastHookAt: at },
        { ok: true }
      );
    }).then((outcome) => outcome.result);
  }
  // The judgement a hook's capability must pass, made inside the record lock with the checkout observed
  // there: the capability finds the record, then provider, ownership, lifecycle, checkout path and the
  // checkout's identity are all judged against what is true now. Bind and restore share it so neither can
  // rest on a record or an observation from before they waited for the lock.
  async function judgeUnderLock(
    current,
    { provider, launchProofDigest: digest, checkoutPath, states }
  ) {
    const record = findByLaunchProof(current, digest);
    if (!record) {
      return { reason: 'launch-proof-invalid' };
    }
    const problem = sessionProblem(record, {
      checkoutPath,
      fresh: await freshIdentity(record),
      provider,
      states,
    });
    return problem ? { reason: problem } : { record };
  }
  function bindNativeConversation({
    provider,
    nativeId,
    launchProofDigest: digest,
    checkoutPath,
  }) {
    // The record is read, the checkout observed and the binding written under
    // one document lock, so nothing can change in between. The observer reads
    // the filesystem only and must never take a state or target lock: open()
    // holds the target lock while the start hook arrives.
    return replace(async (current) => {
      const judged = await judgeUnderLock(current, {
        checkoutPath,
        launchProofDigest: digest,
        provider,
        states: ['starting', 'running'],
      });
      if (!judged.record) {
        return refusal(current, judged.reason);
      }
      const { record } = judged;
      const holders = current.filter(
        (other) =>
          other.id !== record.id &&
          currentBinding(other)?.provider === provider &&
          (other.nativeConversation.id === nativeId ||
            other.nativeConversation.history.some(
              (entry) => entry.id === nativeId
            ))
      );
      const resumedFrom = holders.length
        ? reviewedResume(record, holders, nativeId)
        : null;
      if (holders.length && !resumedFrom) {
        return refusal(current, conflictReason(holders, nativeId));
      }
      const index = current.indexOf(record);
      const binding = nextBinding(
        currentBinding(record),
        { nativeId, provider, resumedFrom: resumedFrom ?? undefined },
        now()
      );
      // A new, replaced or resumed conversation is a decision. The same conversation again is not.
      const decided = currentBinding(record)?.id !== binding.id;
      const { bindingInvalid: _voided, ...undecided } = record;
      const session = {
        ...(decided ? undecided : record),
        nativeConversation: binding,
        ...(decided ? { bindingGeneration: generationOf(record) + 1 } : {}),
      };
      return updatedSession(current, index, session, { ok: true, session });
    }).then((outcome) => outcome.result);
  }
  // The checkout is no longer the one the binding was made in. Recorded once per generation: hooks that
  // keep arriving for the same changed checkout do not each advance it.
  async function invalidateBinding(id, reason) {
    return await replace((current) => {
      const index = current.findIndex((candidate) => candidate.id === id);
      const record = current[index];
      if (!(record && currentBinding(record))) {
        return resultWithRecords(current, { ok: false });
      }
      if (record.bindingInvalid) {
        return resultWithRecords(current, { ok: true, session: record });
      }
      const session = invalidated(record, reason);
      return updatedSession(current, index, session, { ok: true, session });
    }).then((outcome) => outcome.result);
  }
  // The one invalidation a hook may undo: the checkout identity this binding was made in has returned
  // (for example the original directory was put back) and the hook proves it with the launch capability.
  // Judged under the record lock exactly as a bind is, and answered only from that judgement: the same
  // conversation must still be bound, the session must still be owned and running in a checkout that is
  // fresh right now, or the answer is the refusal. The generation then advances past the invalidation so
  // the binding can be published again. An ended or unknown session, another reason, or anything the lock
  // finds changed is never recovered this way.
  function restoreBinding({
    provider,
    nativeId,
    launchProofDigest: digest,
    checkoutPath,
  }) {
    return replace(async (current) => {
      const judged = await judgeUnderLock(current, {
        checkoutPath,
        launchProofDigest: digest,
        provider,
        states: ['running'],
      });
      if (!judged.record) {
        return refusal(current, judged.reason);
      }
      const { record } = judged;
      if (currentBinding(record)?.id !== nativeId) {
        return refusal(current, 'conversation-unbound');
      }
      if (record.bindingInvalid?.reason !== 'checkout-changed') {
        // Nothing to undo, and the record is authenticated as just judged.
        return resultWithRecords(current, { ok: true, session: record });
      }
      const {
        bindingAnnounced: _told,
        bindingInvalid: _voided,
        ...live
      } = record;
      const session = { ...live, bindingGeneration: generationOf(record) + 1 };
      return updatedSession(current, current.indexOf(record), session, {
        ok: true,
        session,
      });
    }).then((outcome) => outcome.result);
  }
  // The publisher's own confirmation that it was told this generation's invalidation.
  async function markAnnounced(id, generation) {
    return await replace((current) => {
      const index = current.findIndex((candidate) => candidate.id === id);
      const record = current[index];
      if (!(record && record.bindingInvalid?.generation === generation)) {
        return resultWithRecords(current, { ok: false });
      }
      const session = { ...record, bindingAnnounced: generation };
      return updatedSession(current, index, session, { ok: true, session });
    }).then((outcome) => outcome.result);
  }
  function unlocated(records, nativeId, digest) {
    const owner = findByLaunchProof(records, digest);
    if (!owner) {
      return 'session-unmanaged';
    }
    return currentBinding(owner)?.history.some((entry) => entry.id === nativeId)
      ? 'conversation-replaced'
      : 'conversation-unbound';
  }
  // Finds the current holder of a native id and checks the proof, with the
  // reason for each way it can fail.
  function locateConversation(nativeId, digest) {
    const records = storedRecords();
    // After an explicit resume an ended record and the live one both name the ID: the capability decides.
    const holders = records.filter(
      (candidate) => currentBinding(candidate)?.id === nativeId
    );
    if (holders.length === 0) {
      return { reason: unlocated(records, nativeId, digest) };
    }
    const record = holders.find((candidate) =>
      digestMatches(candidate.launchProofDigest, digest)
    );
    return record ? { record } : { reason: 'launch-proof-invalid' };
  }
  async function resolveNativeConversation({
    provider,
    nativeId,
    launchProofDigest: digest,
    checkoutPath,
  }) {
    const located = locateConversation(nativeId, digest);
    if (!located.record) {
      return { ok: false, reason: located.reason };
    }
    const fresh = await freshIdentity(located.record);
    // The observation awaited, so the record read above may be stale: a
    // replacement, resume or end may have landed. Read and judge it again.
    const current = locateConversation(nativeId, digest);
    if (!current.record) {
      return { ok: false, reason: current.reason };
    }
    if (current.record.id !== located.record.id) {
      return { ok: false, reason: 'conversation-unbound' };
    }
    const problem = sessionProblem(current.record, {
      checkoutPath,
      fresh,
      provider,
      states: ['running'],
    });
    if (problem === 'checkout-changed') {
      await invalidateBinding(current.record.id, 'checkout-changed').catch(
        () => {
          // The next hook records it.
        }
      );
    }
    if (problem) {
      return { ok: false, reason: problem, sessionId: current.record.id };
    }
    if (current.record.bindingInvalid?.reason === 'checkout-changed') {
      // The checkout returned. The restore re-judges everything under the record lock and its answer, a
      // refusal included, is the answer: this function never falls back to the record read above.
      const restored = await restoreBinding({
        checkoutPath,
        launchProofDigest: digest,
        nativeId,
        provider,
      }).catch(() => ({ ok: false, reason: 'binding-unavailable' }));
      return restored.ok
        ? { ok: true, session: restored.session }
        : { ok: false, reason: restored.reason, sessionId: current.record.id };
    }
    return { ok: true, session: current.record };
  }
  return {
    bindNativeConversation,
    end,
    fail,
    get,
    invalidateBinding,
    list,
    markAnnounced,
    reconcile,
    recordHookActivity,
    register,
    resolveNativeConversation,
  };
}

// Public view of the private binding: no digest, no replaced-ID history.
export function nativeConversationView(session) {
  const provider = canonicalTool(session.tool);
  if (provider !== 'claude-code') {
    return { provider, reason: 'provider-unverified', state: 'unavailable' };
  }
  const bound = currentBinding(session);
  if (bound) {
    return {
      boundAt: bound.boundAt,
      id: bound.id,
      provider,
      ...(bound.resumedFrom?.length ? { resumedFrom: bound.resumedFrom } : {}),
      state: 'bound',
    };
  }
  return session.nativeConversation === undefined
    ? { provider, state: 'pending' }
    : { provider, reason: 'binding-invalid', state: 'pending' };
}

// The one serializer for session records that leave Setu: no capability
// digest, no replaced-ID history, no lease. Internal reads keep every field.
export function publicSession(session) {
  if (!session) {
    return null;
  }
  const {
    launchProofDigest: _digest,
    managedLease: _lease,
    nativeConversation: _private,
    resumeIntent: _intent,
    bindingGeneration: _generation,
    bindingInvalid: _invalid,
    bindingAnnounced: _announced,
    ...visible
  } = session;
  return { ...visible, nativeConversation: nativeConversationView(session) };
}

// Results of session operations may carry `session` or `sessions`.
export function publicSessionResult(result) {
  return {
    ...result,
    ...(result?.session ? { session: publicSession(result.session) } : {}),
    ...(Array.isArray(result?.sessions)
      ? { sessions: result.sessions.map(publicSession) }
      : {}),
  };
}
