import { AsyncResource } from 'node:async_hooks';
import { execFileSync, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import {
  accessSync,
  closeSync,
  constants as fsConstants,
  fstatSync,
  linkSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { createOwnedProcessGroup } from './owned-process-group.js';
import { observeProcessIdentity } from './process-observation.js';
import { createResourceAdmission } from './resource-admission.js';
import { createNativeSessionObserver } from './spans-native-session.js';
import { openSpansStore } from './spans-store.js';
import { snapshotSpansWorkerExecutionReview } from './spans-worker-authority.js';
import { createSpansWorkerHost } from './spans-worker-host.js';
import { createWorkspaceState } from './workspace-state.js';

const MAX_BOOTSTRAP_BYTES = 128 * 1024;
const MAX_REQUEST_BYTES = 64 * 1024;
const MAX_ATTEMPT_DEADLINE_MS = 60 * 60 * 1000;
const TOKEN_PATTERN = /^[0-9a-f]{64}$/;
const PROCESS_IDENTITY_PATTERN =
  /^(Mon|Tue|Wed|Thu|Fri|Sat|Sun) [A-Z][a-z]{2} \d{1,2} \d{2}:\d{2}:\d{2} \d{4}$/;
const REQUEST_ID_PATTERN = /^[0-9a-f]{32}$/;
const REQUEST_FILENAME_PATTERN = /^request-([0-9a-f]{32})\.json$/;
const REQUEST_FILENAME_SCAN_PATTERN = /^request-[0-9a-f]{32}\.json$/;
const PROVIDER_GROUP_OBSERVE_MS = 100;
const PROVIDER_GROUP_TERM_GRACE_MS = 500;
const STOP_GRACE_CELL = new Int32Array(new SharedArrayBuffer(4));
// POSIX open flags are bitmasks; combining them preserves no-follow checks.
function readNoFollowFlags() {
  return combineOpenFlags(fsConstants.O_RDONLY, fsConstants.O_NOFOLLOW ?? 0);
}
function directoryNoFollowFlags() {
  return combineOpenFlags(
    fsConstants.O_RDONLY,
    fsConstants.O_DIRECTORY ?? 0,
    fsConstants.O_NOFOLLOW ?? 0
  );
}
function privateCreateFlags() {
  return combineOpenFlags(
    fsConstants.O_WRONLY,
    fsConstants.O_CREAT,
    fsConstants.O_EXCL,
    fsConstants.O_NOFOLLOW ?? 0
  );
}
function combineOpenFlags(...flags) {
  // Open flags are disjoint POSIX bitmasks and must be combined with bitwise OR.
  // biome-ignore lint/suspicious/noBitwiseOperators: POSIX open flags require bitwise OR.
  return flags.reduce((combined, flag) => combined | flag, 0);
}
function hasGroupOrOtherPermissions(mode) {
  // POSIX mode bits must be masked to enforce private permissions.
  // biome-ignore lint/suspicious/noBitwiseOperators: POSIX mode bits require bitwise AND.
  return (mode & 0o077) !== 0;
}
const FIELDS = [
  'actionId',
  'attemptId',
  'generation',
  'runId',
  'spanId',
  'workerId',
];
const isRecord = (value) =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const sameBinding = (left, right) =>
  isRecord(left) &&
  isRecord(right) &&
  Reflect.ownKeys(left).length === FIELDS.length &&
  FIELDS.every((field) => left[field] === right[field]);

function readBootstrap(path) {
  const descriptor = openSync(path, readNoFollowFlags());
  let value;
  try {
    const stat = fstatSync(descriptor);
    if (
      !stat.isFile() ||
      stat.nlink !== 1 ||
      hasGroupOrOtherPermissions(stat.mode) ||
      stat.size > MAX_BOOTSTRAP_BYTES ||
      (typeof process.getuid === 'function' && stat.uid !== process.getuid())
    ) {
      throw new Error('invalid bootstrap');
    }
    value = JSON.parse(readFileSync(descriptor, 'utf8'));
  } finally {
    closeSync(descriptor);
  }
  const controlFd = openSync(value.controlDir, directoryNoFollowFlags());
  let control;
  try {
    control = fstatSync(controlFd);
  } finally {
    closeSync(controlFd);
  }
  if (
    value.version !== 2 ||
    !TOKEN_PATTERN.test(value.token) ||
    !FIELDS.every((field) => value.start?.[field] === value.binding[field]) ||
    resolve(value.controlDir) !== value.controlDir ||
    dirname(value.controlDir) !== dirname(resolve(path)) ||
    !control.isDirectory() ||
    hasGroupOrOtherPermissions(control.mode) ||
    (typeof process.getuid === 'function' &&
      control.uid !== process.getuid()) ||
    typeof value.root !== 'string' ||
    resolve(value.root) !== value.root ||
    !isRecord(value.limits) ||
    !Number.isSafeInteger(value.limits.maxDeadlineMs) ||
    value.limits.maxDeadlineMs < 1 ||
    value.limits.maxDeadlineMs > MAX_ATTEMPT_DEADLINE_MS ||
    !Number.isSafeInteger(value.start?.deadlineMs) ||
    value.start.deadlineMs < 1 ||
    value.start.deadlineMs > value.limits.maxDeadlineMs ||
    !isRecord(value.source) ||
    typeof value.source.command !== 'string' ||
    value.source.command.length === 0 ||
    !Array.isArray(value.source.args) ||
    !value.source.args.every((arg) => typeof arg === 'string') ||
    typeof value.source.stdin !== 'string' ||
    value.source.stdin.trim().length === 0 ||
    value.source.stdin.includes('\0') ||
    Buffer.from(value.source.stdin, 'utf8').toString('utf8') !==
      value.source.stdin ||
    Buffer.byteLength(value.source.stdin, 'utf8') > MAX_BOOTSTRAP_BYTES
  ) {
    throw new Error('invalid bootstrap');
  }
  if (
    Object.hasOwn(value, 'admissionContext') &&
    !validAdmissionContext(value.admissionContext, value.binding, value.root)
  ) {
    throw new Error('invalid bootstrap');
  }
  const hasExecutionReview = Object.hasOwn(value, 'executionReview');
  const executionReview = hasExecutionReview
    ? snapshotSpansWorkerExecutionReview(value.executionReview)
    : null;
  if (
    (hasExecutionReview && !executionReview) ||
    (Object.hasOwn(value, 'admissionContext') &&
      (!executionReview || executionReview.runId !== value.binding.runId))
  ) {
    throw new Error('invalid bootstrap');
  }
  return value;
}

function validAdmissionContext(context, binding, root) {
  const paths = ['workspaceRoot', 'configPath', 'setuDir'];
  const lease = context?.lease;
  const spansBinding = lease?.spansBinding;
  const reservation = lease?.spansArchiveReservation;
  let canonicalPaths = false;
  try {
    canonicalPaths =
      realpathSync(context.workspaceRoot) === context.workspaceRoot &&
      realpathSync(context.setuDir) === context.setuDir &&
      join(
        realpathSync(dirname(context.configPath)),
        basename(context.configPath)
      ) === context.configPath;
  } catch {
    canonicalPaths = false;
  }
  return (
    isRecord(context) &&
    canonicalPaths &&
    paths.every(
      (field) =>
        typeof context[field] === 'string' &&
        resolve(context[field]) === context[field]
    ) &&
    isRecord(lease) &&
    isRecord(spansBinding) &&
    spansBinding.runId === binding.runId &&
    spansBinding.spanId === binding.spanId &&
    spansBinding.actionId === binding.actionId &&
    spansBinding.attemptId === binding.attemptId &&
    spansBinding.generation === binding.generation &&
    isRecord(spansBinding.target) &&
    isRecord(reservation) &&
    reservation.root === root &&
    resolve(reservation.root) === reservation.root
  );
}

function readPrivateJson(path, maxBytes = MAX_REQUEST_BYTES) {
  let descriptor;
  try {
    descriptor = openSync(path, readNoFollowFlags());
    const stat = fstatSync(descriptor);
    if (
      !stat.isFile() ||
      stat.nlink !== 1 ||
      hasGroupOrOtherPermissions(stat.mode) ||
      stat.size > maxBytes ||
      (typeof process.getuid === 'function' && stat.uid !== process.getuid())
    ) {
      return null;
    }
    return JSON.parse(readFileSync(descriptor, 'utf8'));
  } catch {
    return null;
  } finally {
    if (descriptor !== undefined) {
      closeSync(descriptor);
    }
  }
}

function writePrivateJson(path, value) {
  const temporary = `${path}.${randomBytes(12).toString('hex')}.tmp`;
  let descriptor;
  try {
    descriptor = openSync(temporary, privateCreateFlags(), 0o600);
    writeFileSync(descriptor, JSON.stringify(value));
    closeSync(descriptor);
    descriptor = undefined;
    linkSync(temporary, path);
    return true;
  } catch {
    return false;
  } finally {
    if (descriptor !== undefined) {
      closeSync(descriptor);
    }
    try {
      unlinkSync(temporary);
    } catch {
      // The temporary file may already have been linked or removed.
    }
  }
}

function takeUtf8Prefix(value, maxBytes) {
  let bytes = 0;
  let end = 0;
  for (const character of value) {
    const size = Buffer.byteLength(character);
    if (bytes + size > maxBytes) {
      break;
    }
    bytes += size;
    end += character.length;
  }
  return end || value.length
    ? [value.slice(0, end), value.slice(end)]
    : ['', value];
}

function nativeProcessStart(pid) {
  const identity = execFileSync('ps', ['-p', String(pid), '-o', 'lstart='], {
    encoding: 'utf8',
    env: { ...process.env, LC_ALL: 'C' },
    maxBuffer: 4096,
    timeout: 3000,
  })
    .trim()
    .replace(/\s+/g, ' ');
  if (!PROCESS_IDENTITY_PATTERN.test(identity)) {
    throw new Error('provider process identity unknown');
  }
  return { id: `${pid}:${identity}`, pid };
}

async function main(path) {
  const bootstrap = readBootstrap(path);
  // Provider I/O must reacquire admission, never inherit a released launch lock.
  const captureContext = new AsyncResource('spans-capture');
  let archiveAdmission;
  if (Object.hasOwn(bootstrap, 'admissionContext')) {
    const { configPath, lease, setuDir, workspaceRoot } =
      bootstrap.admissionContext;
    const state = createWorkspaceState({ configPath, setuDir, workspaceRoot });
    const admission = createResourceAdmission({
      hostHealth: async () => ({ availableBytes: 0, state: 'ready' }),
      state,
    });
    if (typeof admission.withSpansArchiveWrite !== 'function') {
      throw new Error('archive admission unavailable');
    }
    archiveAdmission = {
      lease,
      withSpansArchiveWrite: admission.withSpansArchiveWrite,
    };
  }
  let provider = null;
  let providerIdentity = null;
  let providerGroup = null;
  let providerGroupMonitor = null;
  let providerState = 'not-started';
  let providerInputFailed = false;
  let providerInputFailureStop = null;
  let deadlineReached = false;
  let started;
  let sequence = 0;
  let stoppedForCaptureLimit = false;
  let shutdownRequested = false;
  let controlInterval = null;
  let deadlineTimer = null;
  let ownedGroupExitConfirmed = false;
  let terminalObservationRecorded = false;
  let closeTimer = null;
  let pendingProviderObservation = null;
  let finalizationWork = null;

  const hostOptions = {
    clock: { now: Date.now },
    ...(Object.hasOwn(bootstrap, 'admissionContext')
      ? {
          executionAdmissionContext: bootstrap.admissionContext,
          executionLimits: bootstrap.limits,
          executionReview: bootstrap.executionReview,
          executionReviewRequired: true,
          executionSource: bootstrap.source,
          executionStart: bootstrap.start,
        }
      : {}),
    // Keep provider lifecycle callbacks together in their operational order.
    // biome-ignore assist/source/useSortedKeys: launch, stop, then observe follows the provider lifecycle.
    launcher: {
      launch() {
        if (bootstrap.source.command.includes('/')) {
          try {
            accessSync(
              resolve(bootstrap.source.cwd, bootstrap.source.command),
              fsConstants.X_OK
            );
          } catch {
            return {
              code: 'PROVIDER_COMMAND_UNAVAILABLE',
              launched: false,
              ok: false,
            };
          }
        }
        try {
          provider = spawn(bootstrap.source.command, bootstrap.source.args, {
            cwd: bootstrap.source.cwd,
            // A provider has its own group so Stop cannot signal this capture
            // writer, its receipt path, or the archive owner.
            detached: true,
            env: {
              PATH: process.env.PATH ?? '',
              ...(bootstrap.source.env ?? {}),
            },
            stdio: ['pipe', 'pipe', 'pipe'],
          });
          // Consume a later spawn error even when no PID identity can be proven.
          provider.on('error', () => undefined);
          if (!Number.isSafeInteger(provider.pid) || provider.pid <= 0) {
            return { code: 'PROVIDER_IDENTITY_UNKNOWN', ok: false };
          }
          const processStart = nativeProcessStart(provider.pid);
          providerIdentity = processStart;
          providerGroup = createOwnedProcessGroup({
            groupId: provider.pid,
            pid: provider.pid,
            processStartIdentity: processStart.id.slice(
              processStart.id.indexOf(':') + 1
            ),
          });
          if (providerGroup.observe().state !== 'owned') {
            providerState = 'ownership-unknown';
          }
          providerGroupMonitor = setInterval(() => {
            const observation = providerGroup?.settled();
            if (observation?.state === 'unknown') {
              providerState = 'ownership-unknown';
              clearInterval(providerGroupMonitor);
              providerGroupMonitor = null;
            } else if (observation?.state === 'absent') {
              clearInterval(providerGroupMonitor);
              providerGroupMonitor = null;
            }
          }, PROVIDER_GROUP_OBSERVE_MS);
          providerGroupMonitor.unref?.();
          if (!provider.stdin || typeof provider.stdin.end !== 'function') {
            providerState = 'input-unknown';
            return {
              code: 'PROVIDER_STDIN_UNAVAILABLE',
              launched: true,
              ok: false,
              processStart,
            };
          }
          provider.stdin.on('error', () => {
            providerInputFailed = true;
            providerState = 'input-unknown';
            if (started?.ok) {
              stopForInputFailure().catch(() => undefined);
            }
          });
          provider.stdin.end(bootstrap.source.stdin, 'utf8');
          providerState = 'running';
          return { handle: { pid: provider.pid }, ok: true, processStart };
        } catch {
          // The process was created but its native start identity was not
          // proven. Keep the archive attempt unknown and stop only this handle.
          return {
            code: 'PROVIDER_IDENTITY_UNKNOWN',
            launched: true,
            ok: false,
          };
        }
      },
      stop(request) {
        if (
          !(
            provider &&
            providerIdentity &&
            providerGroup &&
            sameBinding(request.binding, bootstrap.binding)
          ) ||
          request.processStartId !== providerIdentity.id ||
          provider.pid !== providerIdentity.pid
        ) {
          return { ok: false };
        }
        const terminated = providerGroup.signalOwned('SIGTERM');
        if (terminated.ok !== true) {
          providerState = 'ownership-unknown';
          return { ok: false };
        }
        if (terminated.absent === true) {
          return { alreadyAbsent: true, ok: true };
        }
        // This effect runs synchronously under the exact attempt transaction.
        // Keep the bounded TERM grace there so escalation retains that same
        // generation fence after a deadline/capture-full hold closes the row.
        Atomics.wait(STOP_GRACE_CELL, 0, 0, PROVIDER_GROUP_TERM_GRACE_MS);
        const escalated = providerGroup.signalOwned('SIGKILL');
        if (escalated.unknown === true) {
          providerState = 'ownership-unknown';
        } else {
          providerState = 'stopping';
        }
        return { ok: true };
      },
      observe: async ({ handle, sink }) => {
        if (!provider || handle?.pid !== provider.pid) {
          providerState = 'unknown';
          return;
        }
        let outputFailed = false;
        const pendingWrites = new Set();
        const append = async (text) => {
          if (deadlineReached) {
            outputFailed = true;
            providerState = 'deadline-reached';
            return;
          }
          const result = await captureContext.runInAsyncScope(() =>
            sink.chunk(text)
          );
          if (result?.ok === true) {
            sequence += 1;
            return;
          }
          outputFailed = true;
          stoppedForCaptureLimit ||= result?.code === 'SPOOL_LIMIT';
          providerState = stoppedForCaptureLimit
            ? 'capture-full'
            : 'capture-unknown';
          if (!stoppedForCaptureLimit && started.ok) {
            const stopped = await captureContext.runInAsyncScope(() =>
              host.cancel({
                ...started.ref,
                coordinatorGeneration: bootstrap.binding.generation,
              })
            );
            if (!stopped.ok) {
              providerState = 'unknown';
            }
          }
        };
        const attach = (stream, watchSession = false) => {
          if (!stream) {
            return;
          }
          stream.setEncoding('utf8');
          const observer = watchSession ? createNativeSessionObserver() : null;
          const observeNative = async (id) => {
            if (!id) {
              return;
            }
            try {
              await captureContext.runInAsyncScope(() => sink.native(id));
            } catch {
              // The archive's nativeId stays unbound if persistence is unconfirmed.
            }
          };
          let pending = '';
          let streamWork = Promise.resolve();
          stream.on('data', (text) => {
            if (outputFailed) {
              stream.resume();
              return;
            }
            stream.pause();
            // Serial awaits preserve bounded stream backpressure and chunk order.
            const work = streamWork
              .then(async () => {
                pending += text;
                while (!outputFailed && pending) {
                  const [piece, rest] = takeUtf8Prefix(
                    pending,
                    bootstrap.limits.maxChunkBytes
                  );
                  if (!piece) {
                    break;
                  }
                  pending = rest;
                  // Keep writes bounded without one archive transaction per output line.
                  // biome-ignore lint/performance/noAwaitInLoops: Serial chunks preserve each stream's output order and bounded backpressure.
                  await append(piece);
                }
                if (!outputFailed) {
                  await observeNative(observer?.push(text));
                }
              })
              .catch(async () => {
                outputFailed = true;
                providerState = stoppedForCaptureLimit
                  ? 'capture-full'
                  : 'capture-unknown';
                if (started.ok && !stoppedForCaptureLimit) {
                  const stopped = await captureContext.runInAsyncScope(() =>
                    host.cancel({
                      ...started.ref,
                      coordinatorGeneration: bootstrap.binding.generation,
                    })
                  );
                  if (!stopped.ok) {
                    providerState = 'unknown';
                  }
                }
              })
              .finally(() => stream.resume());
            streamWork = work;
            pendingWrites.add(work);
            work.then(
              () => pendingWrites.delete(work),
              () => pendingWrites.delete(work)
            );
          });
          stream.on('end', () => {
            const work = streamWork.then(async () => {
              if (outputFailed || !(pending || observer)) {
                return;
              }
              const tail = pending;
              pending = '';
              if (tail) {
                await append(tail);
              }
              if (!outputFailed) {
                await observeNative(observer?.finish());
              }
            });
            streamWork = work;
            pendingWrites.add(work);
            work.then(
              () => pendingWrites.delete(work),
              () => pendingWrites.delete(work)
            );
          });
        };
        attach(provider.stdout, true);
        attach(provider.stderr);
        const exit = await new Promise((resolveExit) => {
          provider.once('close', (code, signal) =>
            resolveExit({ code, signal })
          );
          provider.once('error', () => resolveExit(null));
        });
        await Promise.all([...pendingWrites]);
        await finishProviderObservation(exit, sink, outputFailed);
      },
    },
    limits: bootstrap.limits,
    ...(archiveAdmission
      ? {
          archiveWrite: (request, effect) =>
            archiveAdmission.withSpansArchiveWrite(
              { ...request, lease: archiveAdmission.lease },
              effect
            ),
        }
      : {}),
    preflight: async ({ binding }) => {
      if (!sameBinding(binding, bootstrap.binding)) {
        return { ok: false };
      }
      if (!archiveAdmission) {
        return { ok: true };
      }
      const checked = await archiveAdmission.withSpansArchiveWrite(
        {
          lease: archiveAdmission.lease,
          maxBytes: 1,
          root: bootstrap.root,
        },
        () => true
      );
      return { ok: checked?.ok === true && checked.value === true };
    },
    root: bootstrap.root,
    workerId: bootstrap.binding.workerId,
  };
  // Writable open can create SQLite sidecars, so it shares the same lease gate.
  const opened = archiveAdmission
    ? await archiveAdmission.withSpansArchiveWrite(
        {
          lease: archiveAdmission.lease,
          maxBytes: 2 * 1024 * 1024,
          root: bootstrap.root,
        },
        () => createSpansWorkerHost(hostOptions)
      )
    : { ok: true, value: createSpansWorkerHost(hostOptions) };
  if (!opened.ok) {
    throw new Error('archive open refused');
  }
  const host = opened.value;

  async function finishProviderObservation(exit, sink, captureFailed) {
    if (!exit) {
      providerState = 'unknown';
      return;
    }
    const settled = await providerGroup?.waitForSettlement();
    if (settled?.state !== 'absent') {
      providerState = 'ownership-unknown';
      return;
    }
    ownedGroupExitConfirmed = true;
    if (providerGroupMonitor !== null) {
      clearInterval(providerGroupMonitor);
      providerGroupMonitor = null;
    }
    pendingProviderObservation = { captureFailed, exit, sink };
    await finalizeObservedProviderCapture();
  }

  function captureRequiresHold(captureFailed) {
    return (
      deadlineReached ||
      providerInputFailed ||
      (captureFailed && !stoppedForCaptureLimit)
    );
  }

  async function finalizeObservedProviderCapture() {
    if (finalizationWork) {
      return await finalizationWork;
    }
    if (!(pendingProviderObservation && ownedGroupExitConfirmed)) {
      return;
    }
    const { captureFailed, exit, sink } = pendingProviderObservation;
    const attempt = currentAttempt();
    if (
      captureRequiresHold(captureFailed) &&
      !(
        attempt?.status === 'held' &&
        attempt.cancel?.state === 'delivered' &&
        ['deadline', 'capture-failed', 'spool-limit'].includes(
          attempt.capture?.gap?.reason
        )
      )
    ) {
      providerState = deadlineReached ? 'deadline-held' : 'capture-unknown';
      return;
    }
    finalizationWork = recordProviderCaptureExit(exit, sink);
    try {
      await finalizationWork;
    } finally {
      finalizationWork = null;
    }
  }

  async function recordProviderCaptureExit(exit, sink) {
    if (stoppedForCaptureLimit) {
      providerState = 'capture-full';
    } else if (exit.signal) {
      providerState = 'signaled';
    } else {
      providerState = 'exited';
    }
    const result = await captureContext.runInAsyncScope(() => sink.exit(exit));
    if (result?.ok === true) {
      terminalObservationRecorded = true;
      pendingProviderObservation = null;
      clearTimeout(deadlineTimer);
      // The observation wrapper must unwind before its host can close.
      setTimeout(() => closeAfterOwnedGroupSettles().catch(() => undefined), 0);
    } else {
      providerState = 'unknown';
    }
  }

  started = await host.start(bootstrap.start);
  if (started.ok) {
    providerState =
      providerGroup?.settled().state === 'unknown'
        ? 'ownership-unknown'
        : 'running';
  } else {
    providerState = started.unknown ? 'unknown' : 'start-refused';
  }

  async function stopForInputFailure() {
    if (!started?.ok || providerInputFailureStop) {
      return providerInputFailureStop;
    }
    providerInputFailureStop = captureContext.runInAsyncScope(() =>
      host.cancel({
        ...started.ref,
        coordinatorGeneration: bootstrap.binding.generation,
      })
    );
    const result = await providerInputFailureStop;
    providerState = result?.ok === true ? 'input-unknown' : 'unknown';
    return result;
  }

  if (providerInputFailed && started.ok) {
    await stopForInputFailure();
  }

  function currentAttempt() {
    let store;
    try {
      store = openSpansStore({ readonly: true, root: bootstrap.root });
      const run = store.readRun({ runId: bootstrap.binding.runId });
      const attempt = run?.view?.attempts?.[bootstrap.binding.attemptId];
      return run?.generation === bootstrap.binding.generation &&
        FIELDS.every((field) => attempt?.[field] === bootstrap.binding[field])
        ? attempt
        : null;
    } catch {
      return null;
    } finally {
      store?.close();
    }
  }

  async function enforceProviderDeadline() {
    if (!started.ok) {
      providerState = 'unknown';
      return;
    }
    const attempt = currentAttempt();
    if (attempt?.status !== 'running') {
      return;
    }
    const remainingMs = attempt.deadlineAt - Date.now();
    if (remainingMs > 0) {
      deadlineTimer = setTimeout(() => {
        enforceProviderDeadline().catch(() => undefined);
      }, remainingMs);
      deadlineTimer.unref?.();
      return;
    }
    deadlineReached = true;
    providerState = 'deadline-reached';
    try {
      const stopped =
        attempt.cancel === null
          ? await captureContext.runInAsyncScope(() =>
              host.cancel({
                ...started.ref,
                coordinatorGeneration: bootstrap.binding.generation,
              })
            )
          : { ok: true };
      const held = await captureContext.runInAsyncScope(() =>
        host.enforceDeadline(started.ref)
      );
      if (!stopped.ok || held?.expired !== true) {
        providerState = 'unknown';
      } else {
        await finalizeObservedProviderCapture();
      }
    } catch {
      providerState = 'unknown';
    }
  }

  function scheduleDeadline(delayMs) {
    deadlineTimer = setTimeout(
      () => {
        enforceProviderDeadline().catch(() => undefined);
      },
      Math.max(0, delayMs)
    );
    deadlineTimer.unref?.();
  }

  function writeResponse(requestId, value) {
    if (!REQUEST_ID_PATTERN.test(requestId)) {
      return;
    }
    writePrivateJson(
      `${bootstrap.controlDir}/response-${requestId}.json`,
      value
    );
  }

  function observedProviderState(observed, identity) {
    if (
      observed.state === 'alive' &&
      observed.processStartIdentity ===
        identity.id.slice(identity.id.indexOf(':') + 1)
    ) {
      return providerState;
    }
    const providerExited =
      provider.exitCode !== null || provider.signalCode !== null;
    if (
      observed.state === 'absent' &&
      providerExited &&
      providerGroup?.settled().state === 'absent'
    ) {
      return 'draining';
    }
    return 'unknown';
  }

  // Keep validation, unlink, and response handling ordered as one request transaction.
  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Splitting this ordered request transaction obscures its cleanup and response guarantees.
  async function handleRequest(requestPath) {
    const [, requestId] =
      REQUEST_FILENAME_PATTERN.exec(requestPath.split('/').at(-1)) ?? [];
    if (!requestId) {
      return;
    }
    let request;
    try {
      request = readPrivateJson(requestPath);
      if (!request) {
        return;
      }
    } catch {
      try {
        unlinkSync(requestPath);
      } catch {
        // The request may have been removed by its owner concurrently.
      }
      return;
    }
    try {
      unlinkSync(requestPath);
    } catch {
      // Processing continues only with the already-opened private request.
    }
    if (
      request.requestId !== requestId ||
      request.token !== bootstrap.token ||
      !sameBinding(request.binding, bootstrap.binding)
    ) {
      writeResponse(requestId, {
        code: 'BINDING_OR_TOKEN_MISMATCH',
        ok: false,
      });
      return;
    }
    if (request.operation === 'ready') {
      writeResponse(
        requestId,
        started.ok
          ? { ok: true, status: started.status }
          : {
              code: started.code ?? 'CAPTURE_START_UNKNOWN',
              noProviderEffect: provider === null && started.unknown !== true,
              ok: false,
              unknown: started.unknown === true,
            }
      );
      if (!started.ok && provider === null && host.close()?.ok === true) {
        clearInterval(controlInterval);
        clearTimeout(deadlineTimer);
        process.exit(0);
      }
      return;
    }
    if (request.operation === 'observe') {
      const observed = provider
        ? await observeProcessIdentity(provider.pid)
        : { state: 'unknown' };
      const identity = started.processStart ?? null;
      writeResponse(requestId, {
        nativeId: currentAttempt()?.nativeId ?? null,
        ok: true,
        provider: identity
          ? {
              captureState: providerState,
              processStart: identity,
              state: observedProviderState(observed, identity),
            }
          : null,
        sequence,
        status: started.status ?? 'unknown',
      });
      return;
    }
    if (request.operation === 'cancel') {
      const result = await host.cancel({
        ...started.ref,
        coordinatorGeneration: bootstrap.binding.generation,
      });
      writeResponse(requestId, result);
      return;
    }
    writeResponse(requestId, { code: 'OPERATION_UNSUPPORTED', ok: false });
  }

  let processing = false;
  const scan = () => {
    if (processing) {
      return;
    }
    const name = readdirSync(bootstrap.controlDir).find((entry) =>
      REQUEST_FILENAME_SCAN_PATTERN.test(entry)
    );
    if (!name) {
      return;
    }
    processing = true;
    handleRequest(`${bootstrap.controlDir}/${name}`).then(
      () => {
        processing = false;
      },
      () => {
        // A malformed request must not wedge subsequent control requests.
        processing = false;
      }
    );
  };
  controlInterval = setInterval(scan, 10);
  scan();
  scheduleDeadline(
    Math.max(0, (currentAttempt()?.deadlineAt ?? Date.now()) - Date.now())
  );
  async function closeAfterOwnedGroupSettles() {
    if (!ownedGroupExitConfirmed) {
      const settled = await providerGroup?.waitForSettlement();
      if (settled?.state !== 'absent') {
        providerState = 'ownership-unknown';
        return;
      }
      ownedGroupExitConfirmed = true;
    }
    if (providerGroupMonitor !== null) {
      clearInterval(providerGroupMonitor);
      providerGroupMonitor = null;
    }
    const closed = await host.close();
    if (closed?.ok === true) {
      clearInterval(controlInterval);
      clearTimeout(deadlineTimer);
      process.exit(0);
    } else if (
      terminalObservationRecorded &&
      closed?.code === 'SPANS_WORKER_ATTEMPTS_ACTIVE' &&
      closeTimer === null
    ) {
      closeTimer = setTimeout(() => {
        closeTimer = null;
        closeAfterOwnedGroupSettles().catch(() => undefined);
      }, 100);
    }
  }

  async function shutdown() {
    if (shutdownRequested) {
      return;
    }
    shutdownRequested = true;
    if (deadlineTimer !== null) {
      clearTimeout(deadlineTimer);
      deadlineTimer = null;
    }
    if (
      provider &&
      provider.exitCode === null &&
      provider.signalCode === null
    ) {
      if (!started.ok) {
        providerState = 'unknown';
        return;
      }
      const closeEvent = new Promise((resolveClose) => {
        provider.once('close', resolveClose);
      });
      const result = await host.cancel({
        ...started.ref,
        coordinatorGeneration: bootstrap.binding.generation,
      });
      if (!result.ok) {
        providerState = 'unknown';
        return;
      }
      await closeEvent;
      await closeAfterOwnedGroupSettles();
      return;
    }
    await closeAfterOwnedGroupSettles();
  }
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

main(process.argv[2]).catch(() => {
  process.stderr.write('SPANS_CHILD_START_UNKNOWN\n');
  process.exit(1);
});
