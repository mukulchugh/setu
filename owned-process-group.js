import { execFileSync } from 'node:child_process';
import { inspectProcessGroupRows } from './process-tree.js';

const MAX_PROCESS_TABLE_BYTES = 1024 * 1024;
const MAX_PROCESS_TABLE_ROWS = 12_000;
const MAX_INDIVIDUAL_SIGNALS = 256;
const PROCESS_START =
  /^(Mon|Tue|Wed|Thu|Fri|Sat|Sun) [A-Z][a-z]{2} \d{1,2} \d{2}:\d{2}:\d{2} \d{4}$/;
const PROCESS_ROW = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.+?)\s*$/;
const positiveInteger = (value) => Number.isSafeInteger(value) && value > 0;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// This reader is intentionally synchronous because the capture child's stop
// effect runs inside the current-attempt SQLite transaction. Each invocation
// is one bounded native read; it never invokes a shell or loops over PIDs.
export function readNativeProcessSnapshot({ run = execFileSync } = {}) {
  const text = run('ps', ['-axo', 'pid=,ppid=,pgid=,lstart='], {
    encoding: 'utf8',
    env: { ...process.env, LC_ALL: 'C' },
    maxBuffer: MAX_PROCESS_TABLE_BYTES,
    timeout: 3000,
  });
  if (typeof text !== 'string') {
    throw new Error('Unusable process table');
  }
  const rows = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) {
      continue;
    }
    const [, rawPid, rawParentPid, rawGroupId, rawStart] =
      PROCESS_ROW.exec(line) ?? [];
    const pid = Number(rawPid);
    const parentPid = Number(rawParentPid);
    const groupId = Number(rawGroupId);
    const processStartIdentity = rawStart?.trim().replace(/\s+/g, ' ');
    if (
      !(
        positiveInteger(pid) &&
        Number.isSafeInteger(parentPid) &&
        parentPid >= 0 &&
        positiveInteger(groupId) &&
        PROCESS_START.test(processStartIdentity ?? '')
      )
    ) {
      throw new Error('Unusable process table');
    }
    rows.push({ groupId, parentPid, pid, processStartIdentity });
    if (rows.length > MAX_PROCESS_TABLE_ROWS) {
      throw new Error('Process table exceeds its row bound');
    }
  }
  return rows;
}

function startOf(row) {
  return typeof row?.processStartIdentity === 'string' &&
    PROCESS_START.test(row.processStartIdentity)
    ? row.processStartIdentity
    : null;
}

// Owns one detached provider process group. Group signals are issued only
// after a fresh process-table snapshot proves every member is the root or one
// of its currently observed descendants. Escaped descendants are signaled by
// their exact previously observed incarnation, never by a recycled PID.
export function createOwnedProcessGroup({
  groupId,
  pid,
  processStartIdentity,
  readSnapshot = () => readNativeProcessSnapshot(),
  signal = (target, value) => process.kill(target, value),
} = {}) {
  if (
    !(positiveInteger(pid) && groupId === pid) ||
    typeof processStartIdentity !== 'string' ||
    !PROCESS_START.test(processStartIdentity) ||
    typeof readSnapshot !== 'function' ||
    typeof signal !== 'function'
  ) {
    throw new TypeError(
      'An exact process identity and group reader are required.'
    );
  }

  const knownMembers = new Map([[pid, processStartIdentity]]);
  const escaped = new Map();
  let observationGap = false;

  function readRows() {
    try {
      const rows = readSnapshot();
      if (
        !(
          Array.isArray(rows) &&
          rows.length <= MAX_PROCESS_TABLE_ROWS &&
          rows.every(
            (row) =>
              positiveInteger(row?.pid) &&
              Number.isSafeInteger(row.parentPid) &&
              row.parentPid >= 0 &&
              positiveInteger(row.groupId) &&
              startOf(row) !== null
          )
        )
      ) {
        return null;
      }
      const pids = new Set(rows.map((row) => row.pid));
      return pids.size === rows.length ? rows : null;
    } catch {
      return null;
    }
  }

  function rememberLiveTree(rows) {
    const topology = inspectProcessGroupRows(rows, { groupId, pid });
    if (topology.state !== 'owned') {
      return null;
    }
    const byPid = new Map(rows.map((row) => [row.pid, row]));
    const root = byPid.get(pid);
    if (startOf(root) !== processStartIdentity) {
      return null;
    }
    const currentMembers = [{ pid, processStart: processStartIdentity }];
    const currentDescendantPids = new Set([pid]);
    for (const child of topology.descendants) {
      const row = byPid.get(child.pid);
      const start = startOf(row);
      if (!start) {
        return null;
      }
      const previous =
        knownMembers.get(child.pid) ?? escaped.get(child.pid)?.processStart;
      if (previous && previous !== start) {
        return null;
      }
      currentDescendantPids.add(child.pid);
      if (child.groupId === groupId) {
        currentMembers.push({ pid: child.pid, processStart: start });
      } else {
        escaped.set(child.pid, {
          groupId: child.groupId,
          processStart: start,
        });
      }
    }
    for (const member of currentMembers) {
      knownMembers.set(member.pid, member.processStart);
    }
    // Keep signaling escaped identities that were observed earlier, even if
    // they have since been reparented out of the provider's current tree.
    // inspectEscaped verifies their exact incarnation and requires their
    // current parent chain to lead through owned identities or PID 1.
    const liveEscaped = inspectEscaped(rows, currentDescendantPids);
    if (!liveEscaped) {
      return null;
    }
    return {
      escaped: liveEscaped,
      members: currentMembers,
      state: 'owned',
    };
  }

  function observe() {
    const rows = readRows();
    const result = rows && rememberLiveTree(rows);
    if (!result) {
      observationGap = true;
      return { state: 'unknown' };
    }
    return result;
  }

  function inspectCurrentMembers(rows) {
    const currentMembers = rows.filter((row) => row?.groupId === groupId);
    const liveMembers = [];
    for (const row of currentMembers) {
      const start = startOf(row);
      const known =
        knownMembers.get(row.pid) ?? escaped.get(row.pid)?.processStart;
      if (!(start && known === start)) {
        return null;
      }
      liveMembers.push({ pid: row.pid, processStart: start });
    }
    return liveMembers;
  }

  function previouslyOwnedProcesses() {
    const previouslyOwned = new Map(
      [...knownMembers]
        .filter(([childPid]) => childPid !== pid)
        .map(([childPid, processStart]) => [childPid, { processStart }])
    );
    for (const [childPid, expected] of escaped) {
      previouslyOwned.set(childPid, expected);
    }
    return previouslyOwned;
  }

  function verifyOwnedRows(byPid, previouslyOwned) {
    const ownedRows = new Map();
    for (const [childPid, expected] of previouslyOwned) {
      const row = byPid.get(childPid);
      if (!row) {
        // The bounded full process table is the absence observation. A reused
        // PID is present in the table and fails the exact-start check below.
        continue;
      }
      if (startOf(row) !== expected.processStart) {
        return null;
      }
      ownedRows.set(childPid, row);
    }
    return ownedRows;
  }

  function hasOwnedParentChain(
    row,
    currentDescendantPids,
    ownedRows,
    seen = new Set()
  ) {
    if (row.parentPid === 1 || currentDescendantPids?.has(row.parentPid)) {
      return true;
    }
    if (seen.has(row.pid)) {
      return false;
    }
    const parent = ownedRows.get(row.parentPid);
    if (!parent) {
      return false;
    }
    const nextSeen = new Set(seen);
    nextSeen.add(row.pid);
    return hasOwnedParentChain(
      parent,
      currentDescendantPids,
      ownedRows,
      nextSeen
    );
  }

  function inspectEscaped(rows, currentDescendantPids = null) {
    const byPid = new Map(rows.map((row) => [row.pid, row]));
    const previouslyOwned = previouslyOwnedProcesses();
    const ownedRows = verifyOwnedRows(byPid, previouslyOwned);
    if (!ownedRows) {
      return null;
    }
    const liveEscaped = new Map();
    for (const [childPid, expected] of previouslyOwned) {
      const row = byPid.get(childPid);
      if (!row || row.groupId === groupId) {
        continue;
      }
      if (
        !(
          currentDescendantPids?.has(childPid) ||
          hasOwnedParentChain(row, currentDescendantPids, ownedRows)
        )
      ) {
        return null;
      }
      liveEscaped.set(childPid, {
        groupId: row.groupId,
        pid: childPid,
        processStart: expected.processStart,
      });
    }
    return [...liveEscaped.values()];
  }

  function inspectAfterRootExit(rows) {
    const liveMembers = inspectCurrentMembers(rows);
    const liveEscaped = inspectEscaped(rows);
    if (!(liveMembers && liveEscaped)) {
      return null;
    }
    return {
      escaped: liveEscaped,
      members: liveMembers,
      state: 'owned',
    };
  }

  function inspectCurrent() {
    const rows = readRows();
    if (!rows) {
      observationGap = true;
      return null;
    }
    const rootRow = rows.find((row) => row?.pid === pid);
    if (!rootRow || startOf(rootRow) === processStartIdentity) {
      const live = rootRow
        ? rememberLiveTree(rows)
        : inspectAfterRootExit(rows);
      if (!live) {
        observationGap = true;
      }
      return live;
    }
    observationGap = true;
    return null;
  }

  function signalIndividually(value) {
    const current = inspectCurrent();
    if (!current) {
      return { ok: false, unknown: true };
    }
    const targets = [
      ...current.members.filter((member) => member.pid !== pid),
      ...current.escaped,
      ...current.members.filter((member) => member.pid === pid),
    ];
    if (targets.length === 0) {
      return { absent: true, ok: true };
    }
    if (targets.length > MAX_INDIVIDUAL_SIGNALS) {
      return { ok: false, unknown: true };
    }
    try {
      for (const target of targets) {
        signal(target.pid, value);
      }
    } catch {
      return { ok: false, unknown: true };
    }
    return { ok: true };
  }

  function signalOwned(value) {
    if (observationGap) {
      return { ok: false, unknown: true };
    }
    const proof = inspectCurrent();
    if (!proof) {
      return { ok: false, unknown: true };
    }
    if (proof.members.length === 0 && proof.escaped.length === 0) {
      return { absent: true, ok: true };
    }
    try {
      if (proof.members.length > 0) {
        // The fresh proof above ensures this group contains only exact owned
        // descendants; the group ID is the provider's own detached PID.
        signal(-groupId, value);
      }
      for (const child of proof.escaped) {
        signal(child.pid, value);
      }
      return { ok: proof.members.length > 0 || proof.escaped.length > 0 };
    } catch {
      // Some hosts refuse negative-PID signaling even for a proven group. A
      // fresh proof permits a bounded per-incarnation fallback; descendants
      // receive the signal before the root so it cannot exit ahead of them.
      return signalIndividually(value);
    }
  }

  function settled() {
    const proof = inspectCurrent();
    if (!proof) {
      return { state: 'unknown' };
    }
    if (observationGap) {
      return { state: 'unknown' };
    }
    const live = proof.members.length > 0 || proof.escaped.length > 0;
    if (live) {
      return { state: 'alive' };
    }
    return { state: 'absent' };
  }

  async function waitForSettlement({ pollMs = 50, timeoutMs = 5000 } = {}) {
    const end = Date.now() + timeoutMs;
    let result = settled();
    while (result.state === 'alive' && Date.now() < end) {
      // biome-ignore lint/performance/noAwaitInLoops: Each bounded native snapshot follows the prior one.
      await sleep(Math.min(pollMs, Math.max(1, end - Date.now())));
      result = settled();
    }
    return result;
  }

  return Object.freeze({
    observe,
    settled,
    signalOwned,
    waitForSettlement,
  });
}
