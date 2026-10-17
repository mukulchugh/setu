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

function hasParentRelation(rows, pid, parentPid) {
  const current = snapshotDescendants(rows, parentPid);
  return current?.some((row) => row.pid === pid && row.parentPid === parentPid);
}

export async function findProcessChildren(
  pid,
  {
    listProcesses = () => readProcessTable(),
    observeProcess = observeProcessIdentity,
    processStart,
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
  const candidates = snapshotDescendants(rows, pid);
  if (!candidates) {
    return { state: 'unknown' };
  }
  const descendants = [];
  for (const candidate of candidates) {
    let child;
    try {
      // biome-ignore lint/performance/noAwaitInLoops: Each current process identity and parent proof must be established before returning any owned child.
      child = await observeProcess(candidate.pid);
    } catch {
      return { state: 'unknown' };
    }
    // The process-table command itself is commonly a short-lived direct child
    // of the caller. Its already-proven absence cannot make other children
    // unsafe, but an uncertain or live PID still needs a current parent proof.
    if (child?.state === 'absent') {
      continue;
    }
    if (!matches(child, candidate.pid)) {
      return { state: 'unknown' };
    }
    let currentRows;
    try {
      currentRows = await listProcesses();
    } catch {
      return { state: 'unknown' };
    }
    if (!hasParentRelation(currentRows, candidate.pid, candidate.parentPid)) {
      return { state: 'unknown' };
    }
    descendants.push({
      pid: candidate.pid,
      processStart: child.processStartIdentity,
    });
  }
  try {
    root = await observeProcess(pid);
  } catch {
    return { state: 'unknown' };
  }
  if (!matches(root, pid, rootStart)) {
    return { state: 'unknown' };
  }
  return { children: descendants, state: 'owned' };
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
  if (!Array.isArray(rows)) {
    return { state: 'unknown' };
  }
  const members = rows
    .filter((row) => row?.groupId === groupId)
    .map((row) => row.pid);
  const descendants = new Set([
    pid,
    ...tree.children.map((child) => child.pid),
  ]);
  if (
    !members.includes(pid) ||
    members.some(
      (member) => !(positiveInteger(member) && descendants.has(member))
    )
  ) {
    return { state: 'unknown' };
  }
  return {
    members: [...new Set(members)].sort((a, b) => a - b),
    state: 'owned',
  };
}
