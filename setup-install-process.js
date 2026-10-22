import { spawn as nodeSpawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  createOwnedProcessGroup,
  readNativeProcessSnapshot,
} from './owned-process-group.js';

const MAX_INSTALL_MS = 15 * 60 * 1000;
const TERM_GRACE_MS = 2000;
const SETTLE_MS = 2000;
const POLL_MS = 50;
const GATE_TOKEN = 'setu-setup-owner-v1';
const GATE_SCRIPT =
  'IFS= read -r gate || exit 125; [ "$gate" = "setu-setup-owner-v1" ] || exit 125; exec "$@"';
const START_ID =
  /^(Mon|Tue|Wed|Thu|Fri|Sat|Sun) [A-Z][a-z]{2} \d{1,2} \d{2}:\d{2}:\d{2} \d{4}$/;

function operationUnknown(
  message = 'Setup process ownership or settlement is unknown'
) {
  return Object.assign(new Error(message), { code: 'OPERATION_UNKNOWN' });
}

function validStart(value) {
  return typeof value === 'string' && START_ID.test(value);
}

function closeGate(child) {
  try {
    child.stdin?.end();
  } catch {
    // Closing an already-closed gate is harmless; it never authorizes argv.
  }
}

function childOutcome(child) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (code, signal) => {
      if (done) {
        return;
      }
      done = true;
      resolve({ code: Number.isInteger(code) ? code : null, signal });
    };
    child.once('close', finish);
    child.once('error', () => finish(null, null));
  });
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Owns setup installer processes and their complete native process groups.
// The fixed shell only reads a private gate token after an exact PID/start/PGID
// proof; caller argv is always passed as argv and is never shell-interpolated.
export function createSetupInstallProcesses({
  spawnChild = nodeSpawn,
  readSnapshot = readNativeProcessSnapshot,
  createProcessGroup = createOwnedProcessGroup,
  signal = (pid, value) => process.kill(pid, value),
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  now = Date.now,
  sleep = delay,
  pollMs = POLL_MS,
  termGraceMs = TERM_GRACE_MS,
  settleMs = SETTLE_MS,
} = {}) {
  const owners = new Map();
  let closed = false;

  function clearOwnerTimers(owner) {
    if (owner.monitor) {
      clearTimer(owner.monitor);
      owner.monitor = null;
    }
    if (owner.deadline) {
      clearTimer(owner.deadline);
      owner.deadline = null;
    }
  }

  function requireActive(owner) {
    if (owner.state === 'ended') {
      return false;
    }
    if (owner.state !== 'active' || !owner.group) {
      throw operationUnknown();
    }
    return true;
  }

  async function settleOwner(owner, timeoutMs) {
    const end = now() + timeoutMs;
    let observation = owner.group.settled();
    while (observation.state === 'alive' && now() < end) {
      // biome-ignore lint/performance/noAwaitInLoops: Each bounded native snapshot follows the prior one.
      await sleep(Math.min(pollMs, Math.max(1, end - now())));
      observation = owner.group.settled();
    }
    if (observation.state === 'absent') {
      owner.state = 'ended';
      clearOwnerTimers(owner);
      return observation;
    }
    return observation;
  }

  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Stop is an ordered ownership state machine; each branch prevents a signal without a fresh proof or confirmed settlement.
  async function stopProcess(request) {
    if (
      request?.ownedGroup !== true ||
      !Number.isSafeInteger(request.pid) ||
      request.pid <= 0 ||
      typeof request.setupOwnerId !== 'string' ||
      !request.setupOwnerId
    ) {
      throw operationUnknown('The exact setup process owner is required');
    }
    const owner = owners.get(request.setupOwnerId);
    if (!owner || owner.pid !== request.pid) {
      throw operationUnknown();
    }
    if (owner.state === 'ended') {
      return { ok: true, state: 'absent' };
    }
    if (!requireActive(owner)) {
      return { ok: true, state: 'absent' };
    }

    let observation = await settleOwner(owner, 0);
    if (observation.state === 'absent') {
      return { ok: true, state: 'absent' };
    }
    if (observation.state !== 'alive') {
      throw operationUnknown();
    }

    const term = owner.group.signalOwned('SIGTERM');
    if (!term.ok) {
      throw operationUnknown();
    }
    observation = await settleOwner(owner, termGraceMs);
    if (observation.state === 'absent') {
      return { ok: true, state: 'absent' };
    }
    if (observation.state !== 'alive') {
      throw operationUnknown();
    }

    // signalOwned obtains a fresh exact tree proof immediately before KILL.
    const kill = owner.group.signalOwned('SIGKILL');
    if (!kill.ok) {
      throw operationUnknown();
    }
    observation = await settleOwner(owner, settleMs);
    if (observation.state !== 'absent') {
      throw operationUnknown();
    }
    return { ok: true, state: 'absent' };
  }

  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Launch, proof, gate release, monitor setup, and the 15 minute deadline are one ordered ownership transition.
  function spawn(argv, options = {}) {
    if (closed) {
      throw new Error('Setup process owner is closed');
    }
    if (
      !Array.isArray(argv) ||
      argv.length === 0 ||
      argv.some((part) => typeof part !== 'string') ||
      typeof options.cwd !== 'string' ||
      !options.cwd
    ) {
      throw new TypeError(
        'Setup install needs argv and an exact working directory'
      );
    }
    const requestedDeadline = options.timeout ?? MAX_INSTALL_MS;
    if (!(Number.isFinite(requestedDeadline) && requestedDeadline > 0)) {
      throw new TypeError('Setup install deadline must be a positive duration');
    }
    const deadlineMs = Math.min(MAX_INSTALL_MS, requestedDeadline);
    const child = spawnChild(
      '/bin/zsh',
      ['-f', '-c', GATE_SCRIPT, 'setu-setup', ...argv],
      {
        cwd: options.cwd,
        detached: true,
        env: options.env,
        stdio: ['pipe', options.stdout ?? 'ignore', options.stderr ?? 'ignore'],
        windowsHide: true,
      }
    );
    const outcome = childOutcome(child);
    if (!(Number.isSafeInteger(child?.pid) && child.pid > 0)) {
      closeGate(child);
      throw operationUnknown('Setup launcher PID is unavailable');
    }

    const setupOwnerId = randomUUID();
    const owner = {
      deadline: null,
      group: null,
      monitor: null,
      pid: child.pid,
      setupOwnerId,
      state: 'unverified',
    };
    owners.set(setupOwnerId, owner);
    child.stdin?.on?.('error', () => {
      owner.state = 'unknown';
      clearOwnerTimers(owner);
    });
    const exited = outcome.then(({ code, signal: childSignal }) => {
      owner.outcome = { code, signal: childSignal };
      return code;
    });

    let rows;
    try {
      rows = readSnapshot();
    } catch {
      rows = null;
    }
    const root = Array.isArray(rows)
      ? rows.find((row) => row?.pid === child.pid)
      : null;
    if (
      !(
        root &&
        root.groupId === child.pid &&
        validStart(root.processStartIdentity)
      )
    ) {
      closeGate(child);
      return {
        exited,
        get ownershipState() {
          return owner.state;
        },
        pid: child.pid,
        setupOwnerId,
        get signalCode() {
          return owner.outcome?.signal ?? null;
        },
      };
    }

    try {
      owner.group = createProcessGroup({
        groupId: child.pid,
        pid: child.pid,
        processStartIdentity: root.processStartIdentity,
        readSnapshot,
        signal,
      });
      const proof = owner.group.observe();
      if (proof.state !== 'owned') {
        throw operationUnknown();
      }
      owner.state = 'active';
      child.stdin.end(`${GATE_TOKEN}\n`);
    } catch {
      closeGate(child);
      owner.group = null;
      owner.state = 'unverified';
    }

    if (owner.state === 'active') {
      const monitor = () => {
        if (owner.state !== 'active') {
          return;
        }
        let observation;
        try {
          observation = owner.group.settled();
        } catch {
          observation = { state: 'unknown' };
        }
        if (observation.state === 'absent') {
          owner.state = 'ended';
          owner.monitor = null;
          clearTimer(owner.deadline);
          owner.deadline = null;
          return;
        }
        if (observation.state !== 'alive') {
          owner.state = 'unknown';
          owner.monitor = null;
          clearTimer(owner.deadline);
          owner.deadline = null;
          return;
        }
        owner.monitor = setTimer(monitor, pollMs);
        owner.monitor?.unref?.();
      };
      owner.monitor = setTimer(monitor, pollMs);
      owner.monitor?.unref?.();
      owner.deadline = setTimer(() => {
        owner.deadline = null;
        stopProcess({
          ownedGroup: true,
          pid: owner.pid,
          setupOwnerId: owner.setupOwnerId,
        }).catch(() => {
          // The owner stays active/unknown and blocks close after a failed stop.
        });
      }, deadlineMs);
      owner.deadline?.unref?.();
    }

    return {
      exited,
      get ownershipState() {
        return owner.state;
      },
      pid: child.pid,
      setupOwnerId,
      get signalCode() {
        return owner.outcome?.signal ?? null;
      },
    };
  }

  function close() {
    const active = [...owners.values()].some(
      (owner) => owner.state !== 'ended'
    );
    if (active) {
      throw operationUnknown(
        'Cannot close while setup ownership is active or unknown'
      );
    }
    for (const owner of owners.values()) {
      if (owner.monitor) {
        clearTimer(owner.monitor);
      }
      if (owner.deadline) {
        clearTimer(owner.deadline);
      }
    }
    owners.clear();
    closed = true;
  }

  return Object.freeze({
    close,
    hasOwnedWork: () =>
      [...owners.values()].some((owner) => owner.state !== 'ended'),
    spawn,
    stopProcess,
  });
}
