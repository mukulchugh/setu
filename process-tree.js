import { execFile } from 'node:child_process';
import { observeProcessIdentity } from './process-observation.js';

const positiveInteger = (value) => Number.isSafeInteger(value) && value > 0;
const processParent = (value) => Number.isSafeInteger(value) && value >= 0;
const processColumnsPattern = /\s+/;

const readPs = () =>
  new Promise((resolve, reject) => {
    execFile(
      'ps',
      ['-axo', 'pid=,ppid=,pgid='],
      {
        encoding: 'utf8',
        env: { ...process.env, LC_ALL: 'C' },
        maxBuffer: 1024 * 1024,
        timeout: 3000,
      },
      (error, stdout) => (error ? reject(error) : resolve(stdout))
    );
  });

// A snapshot does not establish identity. Callers pair it with the process
// observer before treating a row as an owned child or group member.
export async function readProcessTable({ run = readPs } = {}) {
  const text = await run();
  const rows = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) {
      continue;
    }
    const [pid, parentPid, groupId, ...extra] = line
      .trim()
      .split(processColumnsPattern)
      .map(Number);
    if (
      extra.length ||
      !positiveInteger(pid) ||
      !processParent(parentPid) ||
      !positiveInteger(groupId)
    ) {
      throw new Error('Unusable process table');
    }
    rows.push({ groupId, parentPid, pid });
  }
  return rows;
}

function matches(observation, pid, processStart) {
  return (
    observation?.state === 'alive' &&
    observation.processId === pid &&
    typeof observation.processStartIdentity === 'string' &&
    (processStart === undefined ||
      observation.processStartIdentity === processStart)
  );
}

function snapshotDescendants(rows, rootPid) {
  const byParent = new Map(),
    seenPids = new Set();
  for (const row of rows) {
    if (!(positiveInteger(row?.pid) && processParent(row?.parentPid))) {
      return null;
    }
    if (seenPids.has(row.pid)) {
      return null;
    }
    seenPids.add(row.pid);
    const children = byParent.get(row.parentPid) ?? [];
    children.push(row);
    byParent.set(row.parentPid, children);
  }
  if (!seenPids.has(rootPid)) {
    return null;
  }
  const descendants = [],
    queue = [...(byParent.get(rootPid) ?? [])],
    seen = new Set([rootPid]);
  while (queue.length) {
    const child = queue.shift();
    if (seen.has(child.pid)) {
      return null;
    }
    seen.add(child.pid);
    descendants.push(child);
    queue.push(...(byParent.get(child.pid) ?? []));
  }
  return descendants;
}

// The group a row reports, when it reports one. Fixtures and callers that
// only care about parentage may omit it.
const groupOf = (row) => (positiveInteger(row?.groupId) ? row.groupId : null);

// Pure topology check shared by async ownership proofs and native group
// monitors. Callers must still establish each process incarnation separately.
export function inspectProcessGroupRows(rows, { groupId, pid } = {}) {
  if (!(Array.isArray(rows) && positiveInteger(pid) && groupId === pid)) {
    return { state: 'unknown' };
  }
  if (
    rows.some(
      (row) =>
        !(
          positiveInteger(row?.pid) &&
          processParent(row.parentPid) &&
          positiveInteger(row.groupId)
        )
    )
  ) {
    return { state: 'unknown' };
  }
  const root = rows.find((row) => row?.pid === pid);
  if (groupOf(root) !== groupId) {
    return { state: 'unknown' };
  }
  const descendants = snapshotDescendants(rows, pid);
  if (!descendants) {
    return { state: 'unknown' };
  }
  const members = rows.filter((row) => groupOf(row) === groupId);
  const descendantPids = new Set([pid, ...descendants.map((row) => row.pid)]);
  if (
    !members.some((row) => row.pid === pid) ||
    members.some((row) => !descendantPids.has(row.pid))
  ) {
    return { state: 'unknown' };
  }
  return {
    descendants,
    members: [...new Set(members.map((row) => row.pid))].sort(
      (left, right) => left - right
    ),
    state: 'owned',
  };
}

function hasParentRelation(rows, candidate) {
  const current = snapshotDescendants(rows, candidate.parentPid);
  return current?.some(
    (row) =>
      row.pid === candidate.pid &&
      row.parentPid === candidate.parentPid &&
      groupOf(row) === groupOf(candidate)
  );
}

// The root still reports the group a caller asked about; no group, no demand.
const rootInGroup = (rows, pid, groupId) =>
  groupId === undefined ||
  (Array.isArray(rows) &&
    groupOf(rows.find((row) => row?.pid === pid)) === groupId);

// One candidate, certified by its own identity and a fresh parent (and group)
// relation. `null` means unknown; `'gone'` a candidate already proven absent,
// which cannot make other children unsafe.
async function certifyCandidate(candidate, { listProcesses, observeProcess }) {
  let child, currentRows;
  try {
    child = await observeProcess(candidate.pid);
    // The process-table command itself is commonly a short-lived direct child
    // of the caller. Its already-proven absence cannot make other children
    // unsafe, but an uncertain or live PID still needs a current parent proof.
    if (child?.state === 'absent') {
      return 'gone';
    }
    if (!matches(child, candidate.pid)) {
      return null;
    }
    currentRows = await listProcesses();
  } catch {
    return null;
  }
  return hasParentRelation(currentRows, candidate)
    ? {
        ...(groupOf(candidate) ? { groupId: candidate.groupId } : {}),
        pid: candidate.pid,
        processStart: child.processStartIdentity,
      }
    : null;
}

// Certifies the live descendants of `pid`, each by its own process identity and
// current parent (and group) relation. `include` narrows which candidates are
// certified; a skipped candidate is simply not reported. `rootGroupId`, when
// given, also requires the root itself to still be in that group. `limit`
// stops certifying once that many have been certified, for callers that treat
// anything beyond it as one overflow and gain nothing from more.
async function certifyDescendants(
  pid,
  {
    include = () => true,
    limit = Number.POSITIVE_INFINITY,
    listProcesses = () => readProcessTable(),
    observeProcess = observeProcessIdentity,
    processStart,
    rootGroupId,
  } = {}
) {
  if (!positiveInteger(pid)) {
    return { state: 'unknown' };
  }
  let root, rows, rootStart;
  try {
    root = await observeProcess(pid);
    if (!matches(root, pid, processStart)) {
      return { state: 'unknown' };
    }
    rootStart = root.processStartIdentity;
    rows = await listProcesses();
  } catch {
    return { state: 'unknown' };
  }
  if (!(Array.isArray(rows) && rows.some((row) => row?.pid === pid))) {
    return { state: 'unknown' };
  }
  if (!rootInGroup(rows, pid, rootGroupId)) {
    return { state: 'unknown' };
  }
  const candidates = snapshotDescendants(rows, pid);
  if (!candidates) {
    return { state: 'unknown' };
  }
  const descendants = [];
  for (const candidate of candidates.filter(include)) {
    if (descendants.length >= limit) {
      break;
    }
    // biome-ignore lint/performance/noAwaitInLoops: Each current process identity and parent proof must be established before returning any owned child.
    const child = await certifyCandidate(candidate, {
      listProcesses,
      observeProcess,
    });
    if (!child) {
      return { state: 'unknown' };
    }
    if (child !== 'gone') {
      descendants.push(child);
    }
  }
  try {
    root = await observeProcess(pid);
    if (
      rootGroupId !== undefined &&
      !rootInGroup(await listProcesses(), pid, rootGroupId)
    ) {
      return { state: 'unknown' };
    }
  } catch {
    return { state: 'unknown' };
  }
  if (!matches(root, pid, rootStart)) {
    return { state: 'unknown' };
  }
  return { children: descendants, state: 'owned' };
}

// The whole tree, never truncated: stopping a session signals every one of these.
export function findProcessChildren(
  pid,
  { listProcesses, observeProcess, processStart } = {}
) {
  return certifyDescendants(pid, {
    listProcesses,
    observeProcess,
    processStart,
  });
}

// The live descendants of a group-leading root that are no longer in its
// group: the ones a group-wide check cannot see. The group is a cooperative
// lifecycle boundary, not a sandbox, so only descendants observed here (while
// the root identity is live) can ever be accounted for after the root exits.
// An optional \`limit\` bounds how many are certified.
export async function findEscapedDescendants(
  pid,
  { groupId, ...options } = {}
) {
  if (!positiveInteger(groupId)) {
    return { state: 'unknown' };
  }
  const tree = await certifyDescendants(pid, {
    ...options,
    include: (row) => groupOf(row) !== groupId,
    rootGroupId: groupId,
  });
  return tree.state === 'owned'
    ? {
        escaped: tree.children.map(({ pid: childPid, processStart }) => ({
          pid: childPid,
          processStart,
        })),
        state: 'owned',
      }
    : { state: 'unknown' };
}

export async function proveProcessGroupOwnership(
  { groupId, pid, processStart } = {},
  {
    listProcesses = () => readProcessTable(),
    observeProcess = observeProcessIdentity,
  } = {}
) {
  if (!(positiveInteger(pid) && groupId === pid)) {
    return { state: 'unknown' };
  }
  const tree = await findProcessChildren(pid, {
    listProcesses,
    observeProcess,
    processStart,
  });
  if (tree.state !== 'owned') {
    return { state: 'unknown' };
  }
  let rows;
  try {
    rows = await listProcesses();
  } catch {
    return { state: 'unknown' };
  }
  const topology = inspectProcessGroupRows(rows, { groupId, pid });
  if (topology.state !== 'owned') {
    return { state: 'unknown' };
  }
  const certified = new Map(tree.children.map((child) => [child.pid, child]));
  for (const candidate of topology.descendants) {
    if (candidate.pid === pid) {
      continue;
    }
    const child = certified.get(candidate.pid);
    if (
      !child ||
      child.groupId !== groupOf(candidate) ||
      child.processStart.length === 0
    ) {
      return { state: 'unknown' };
    }
  }
  return {
    // Descendants already outside the group when it is proven.
    escaped: tree.children
      .filter((child) => child.groupId !== groupId)
      .map(({ pid: childPid, processStart: childStart }) => ({
        pid: childPid,
        processStart: childStart,
      })),
    members: topology.members,
    state: 'owned',
  };
}
