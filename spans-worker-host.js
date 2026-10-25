import { resolve } from 'node:path';
import { types as utilTypes } from 'node:util';
import { observeProcessIdentity } from './process-observation.js';
import {
  spansExecutionArchiveWriteBytes,
  spansExecutionArchiveWriteContext,
} from './spans-execution-archive-policy.js';
import { openSpansStore } from './spans-store.js';
import { createSpansWorker } from './spans-worker.js';
import {
  createSpansWorkerAuthority,
  snapshotSpansWorkerExecutionReview,
} from './spans-worker-authority.js';
import { createSpansWorkerSpool } from './spans-worker-spool.js';

const isRecord = (value) =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const MAX_RECOVERY_ID_LENGTH = 256;

function snapshotRecoveryInput(input) {
  if (utilTypes.isProxy(input)) {
    return { safe: false };
  }
  try {
    if (!isRecord(input)) {
      return { input: null, safe: true };
    }
    const descriptors = Object.getOwnPropertyDescriptors(input);
    if (
      Reflect.ownKeys(descriptors).some(
        (key) => !Object.hasOwn(descriptors[key], 'value')
      )
    ) {
      return { safe: false };
    }
    if (
      !['runId', 'attemptId', 'generation'].every((key) =>
        Object.hasOwn(descriptors, key)
      )
    ) {
      return { input: null, safe: true };
    }
    const { attemptId, generation, runId } = Object.fromEntries(
      ['runId', 'attemptId', 'generation'].map((key) => [
        key,
        descriptors[key].value,
      ])
    );
    if (
      typeof runId !== 'string' ||
      runId.length === 0 ||
      runId.length > MAX_RECOVERY_ID_LENGTH ||
      typeof attemptId !== 'string' ||
      attemptId.length === 0 ||
      attemptId.length > MAX_RECOVERY_ID_LENGTH ||
      !Number.isSafeInteger(generation) ||
      generation < 0
    ) {
      return { input: null, safe: true };
    }
    return {
      input: Object.freeze({ attemptId, generation, runId }),
      safe: true,
    };
  } catch {
    return { safe: false };
  }
}

function assertHostOptions(options) {
  const executionReviewRequired = options?.executionReviewRequired ?? false;
  if (
    !isRecord(options) ||
    typeof options.root !== 'string' ||
    !options.root.startsWith('/') ||
    resolve(options.root) !== options.root ||
    typeof options.workerId !== 'string' ||
    !isRecord(options.limits) ||
    !isRecord(options.launcher) ||
    typeof options.launcher.launch !== 'function' ||
    typeof options.clock?.now !== 'function' ||
    typeof options.preflight !== 'function'
  ) {
    throw new TypeError(
      'A canonical archive root, explicit worker settings, launcher, clock, and preflight are required.'
    );
  }
  if (
    typeof executionReviewRequired !== 'boolean' ||
    (executionReviewRequired &&
      (!(
        snapshotSpansWorkerExecutionReview(options.executionReview) &&
        isRecord(options.executionSource) &&
        isRecord(options.executionStart) &&
        isRecord(options.executionLimits) &&
        Number.isSafeInteger(options.executionLimits.maxDeadlineMs) &&
        options.executionLimits.maxDeadlineMs > 0
      ) ||
        typeof options.executionSource.stdin !== 'string' ||
        typeof options.executionSource.cwd !== 'string' ||
        !Number.isSafeInteger(options.executionStart.deadlineMs) ||
        !isRecord(options.executionAdmissionContext)))
  ) {
    throw new TypeError(
      'A production capture requires its exact saved execution review and source.'
    );
  }
  if (
    options.launcher.stop !== undefined &&
    typeof options.launcher.stop !== 'function'
  ) {
    throw new TypeError('launcher.stop must be a function.');
  }
  if (
    options.launcher.observe !== undefined &&
    typeof options.launcher.observe !== 'function'
  ) {
    throw new TypeError('launcher.observe must be a function.');
  }
  if (
    options.observeProcess !== undefined &&
    typeof options.observeProcess !== 'function'
  ) {
    throw new TypeError('observeProcess must be a function when supplied.');
  }
  if (
    options.archiveWrite !== undefined &&
    typeof options.archiveWrite !== 'function'
  ) {
    throw new TypeError('archiveWrite must be a function when supplied.');
  }
}

function synchronousResult(value) {
  return !value || typeof value.then !== 'function';
}

const archiveWriteUnknown = () => ({
  code: 'SPANS_ARCHIVE_WRITE_UNKNOWN',
  ok: false,
  unknown: true,
});

function archiveWriteLimit(limits, method, payload, store) {
  const context = spansExecutionArchiveWriteContext(store, method, payload);
  if (context === null && ['commitRun', 'appendEvent'].includes(method)) {
    return;
  }
  return spansExecutionArchiveWriteBytes({
    limits,
    method:
      method === 'finalize' && payload?.complete === false
        ? 'heldFinalize'
        : method,
    payload: context,
  });
}

function hasArchivedProcessIdentity(attempt) {
  const processStart = attempt?.processStart;
  return Boolean(
    isRecord(attempt) &&
      isRecord(processStart) &&
      Number.isSafeInteger(processStart.pid) &&
      processStart.pid > 0 &&
      typeof processStart.id === 'string' &&
      processStart.id.length > 0
  );
}

/**
 * Compose the worker engine with an existing archive and its durable spool.
 * `launcher.launch` and `launcher.stop` are trusted synchronous effect
 * functions. `launcher.observe`, when supplied, is asynchronous and receives
 * the resulting handle plus the worker sink; observation never holds the
 * SQLite authority transaction open.
 */
export function createSpansWorkerHost(options = {}) {
  assertHostOptions(options);
  const {
    archiveWrite,
    clock,
    launcher,
    limits,
    observeProcess = observeProcessIdentity,
    preflight,
    root,
    workerId,
  } = options;

  // Existing-only writer refuses missing files and unsupported schemas.
  const store = openSpansStore({ create: false, root });
  try {
    const executionReviewGuard = options.executionReviewRequired
      ? createSpansWorkerAuthority({
          admissionContext: options.executionAdmissionContext,
          checkoutAdapter: options.executionCheckoutAdapter,
          dependencyAdapter: options.executionDependencyAdapter,
          executionLimits: options.executionLimits,
          executionReview: options.executionReview,
          executionStart: options.executionStart,
          now: options.executionNow,
          observeTree: options.executionObserveTree,
          root,
          source: options.executionSource,
          store,
        })
      : null;
    const checkedPreflight = async ({ binding }) => {
      if (
        executionReviewGuard &&
        executionReviewGuard.checkCurrent(binding)?.ok !== true
      ) {
        return { code: 'EXECUTION_REVIEW_REFUSED', ok: false };
      }
      let result;
      try {
        result = await preflight({ binding });
      } catch {
        return { ok: false };
      }
      if (result?.ok !== true) {
        return result;
      }
      if (
        executionReviewGuard &&
        (await executionReviewGuard.checkPreflight(binding))?.ok !== true
      ) {
        return { code: 'EXECUTION_REVIEW_REFUSED', ok: false };
      }
      return result;
    };
    const gatedWrite = async (method, payload, effect) => {
      if (!archiveWrite) {
        return effect();
      }
      let result;
      try {
        result = await archiveWrite(
          { maxBytes: archiveWriteLimit(limits, method, payload, store), root },
          effect
        );
      } catch {
        return archiveWriteUnknown();
      }
      if (
        !(
          isRecord(result) &&
          result.ok === true &&
          Object.hasOwn(result, 'value')
        )
      ) {
        return isRecord(result) && result.ok === false
          ? result
          : archiveWriteUnknown();
      }
      return result.value;
    };

    const gatedStore = archiveWrite
      ? {
          ...store,
          commitRun: (input) =>
            gatedWrite('commitRun', input, () => store.commitRun(input)),
        }
      : store;
    const spool = createSpansWorkerSpool({
      maxAttemptBytes: limits.maxAttemptBytes,
      maxAttemptChunks: limits.maxAttemptChunks,
      maxChunkBytes: limits.maxChunkBytes,
      root,
      withCurrentAttempt: store.withCurrentAttempt.bind(store),
    });
    const gatedSpool = archiveWrite
      ? {
          ...spool,
          append: (payload) =>
            gatedWrite('append', payload, () => spool.append(payload)),
          finalize: (payload) =>
            gatedWrite('finalize', payload, () => spool.finalize(payload)),
        }
      : spool;

    let closed = false;
    let observing = 0;
    const liveAttempts = new Set();
    const attemptKey = (binding) =>
      JSON.stringify([binding.runId, binding.attemptId]);
    const fencedLauncher = {
      launch(request) {
        if (closed) {
          return { code: 'HOST_CLOSED', launched: false, ok: false };
        }
        let effectResult;
        let invoked = false;
        const key = attemptKey(request.binding);
        const sink = Object.freeze({
          ...request.sink,
          exit: async (exit) => {
            const result = await request.sink.exit(exit);
            if (
              result?.ok === true &&
              (result.status === 'exited' || result.processExited === true)
            ) {
              liveAttempts.delete(key);
            }
            return result;
          },
        });
        const authority = store.withCurrentAttempt(request.binding, () => {
          if (
            executionReviewGuard &&
            executionReviewGuard.checkLaunch(request.binding)?.ok !== true
          ) {
            effectResult = {
              code: 'EXECUTION_REVIEW_REFUSED',
              launched: false,
              ok: false,
            };
            return effectResult;
          }
          invoked = true;
          liveAttempts.add(key);
          effectResult = launcher.launch({ ...request, sink });
          return effectResult;
        });
        if (!invoked) {
          return (
            effectResult ?? {
              code: authority?.code ?? 'ATTEMPT_AUTHORIZATION_REFUSED',
              launched: false,
              ok: false,
            }
          );
        }
        if (!synchronousResult(effectResult)) {
          Promise.resolve(effectResult).catch(() => {
            // Contract violation stays unknown; consume rejection without retrying.
          });
        }
        if (authority !== effectResult || !synchronousResult(effectResult)) {
          // Once an injected effect was entered, a broken async contract cannot
          // be called a refusal: its provider-side outcome is unresolved.
          return { code: 'LAUNCH_OUTCOME_UNKNOWN', ok: false };
        }
        if (effectResult?.ok === false && effectResult.launched === false) {
          liveAttempts.delete(key);
        }
        if (effectResult?.ok === true && launcher.observe) {
          observing += 1;
          Promise.resolve()
            .then(() =>
              launcher.observe({
                binding: { ...request.binding },
                handle: effectResult.handle,
                sink,
              })
            )
            .catch(() => undefined)
            .finally(() => {
              observing -= 1;
            });
        }
        return effectResult;
      },
    };

    if (launcher.stop) {
      fencedLauncher.stop = (request) => {
        if (closed) {
          return { ok: false };
        }
        let effectResult;
        let invoked = false;
        const authority = store.withCurrentAttempt(request.binding, () => {
          invoked = true;
          effectResult = launcher.stop({ ...request });
          return effectResult;
        });
        if (!synchronousResult(effectResult)) {
          Promise.resolve(effectResult).catch(() => {
            // A broken stop contract must remain unknown without crashing capture.
          });
        }
        if (
          !invoked ||
          authority !== effectResult ||
          !synchronousResult(effectResult)
        ) {
          return { ok: false };
        }
        return effectResult;
      };
    }

    const worker = createSpansWorker({
      clock,
      launcher: archiveWrite
        ? {
            ...fencedLauncher,
            launch: (request) =>
              gatedWrite('authority', null, () =>
                fencedLauncher.launch(request)
              ),
            stop: (request) =>
              gatedWrite('authority', null, () => fencedLauncher.stop(request)),
          }
        : fencedLauncher,
      limits,
      preflight: checkedPreflight,
      spool: gatedSpool,
      store: gatedStore,
      workerId,
    });
    async function recoverKnownRequest(request) {
      try {
        const archived = store.readRun({ runId: request.runId });
        if (!archived?.ok || archived.generation !== request.generation) {
          return {
            code: 'RECOVERY_AUTHORITY_UNKNOWN',
            ok: false,
            unknown: true,
          };
        }
        const attempt = archived.view?.attempts?.[request.attemptId];
        if (!hasArchivedProcessIdentity(attempt)) {
          return {
            code: 'RECOVERY_IDENTITY_UNKNOWN',
            ok: false,
            unknown: true,
          };
        }
        const { processStart } = attempt;
        let observation;
        try {
          observation = await observeProcess(processStart.pid);
        } catch {
          observation = { state: 'unknown' };
        }
        if (observation?.state === 'alive') {
          if (
            observation.processId !== processStart.pid ||
            processStart.id !==
              `${processStart.pid}:${observation.processStartIdentity}`
          ) {
            return {
              code: 'RECOVERY_PROCESS_IDENTITY_MISMATCH',
              ok: false,
              unknown: true,
            };
          }
          return {
            decision: 'reattach-required',
            ok: true,
            status: 'worker-alive',
          };
        }
        if (observation?.state !== 'absent') {
          return {
            code: 'RECOVERY_PROCESS_UNKNOWN',
            ok: false,
            unknown: true,
          };
        }
        // A confirmed absence closes capture as held. It does not prove a
        // provider outcome or release dispatch, admission, usage or writer
        // ownership retained by their separate authorities.
        const result = await worker.recover({
          actionId: attempt.actionId,
          attemptId: request.attemptId,
          generation: request.generation,
          runId: request.runId,
          spanId: attempt.spanId,
          workerId: attempt.workerId,
        });
        return result;
      } catch {
        return { code: 'RECOVERY_UNKNOWN', ok: false, unknown: true };
      }
    }
    const workerWithOwnership = {
      ...worker,
      observeExit: async (input) => {
        const result = await worker.observeExit(input);
        if (
          isRecord(input) &&
          result?.ok === true &&
          (result.status === 'exited' || result.processExited === true)
        ) {
          liveAttempts.delete(attemptKey(input));
        }
        return result;
      },
      recover: async (input) => {
        if (closed) {
          return { code: 'HOST_CLOSED', ok: false };
        }
        const snapshot = snapshotRecoveryInput(input);
        if (!snapshot.safe) {
          return { code: 'RECOVERY_UNKNOWN', ok: false, unknown: true };
        }
        if (!snapshot.input) {
          return { code: 'RECOVERY_INPUT_INVALID', ok: false };
        }
        observing += 1;
        try {
          return await recoverKnownRequest(snapshot.input);
        } finally {
          observing -= 1;
        }
      },
    };

    function close() {
      if (closed) {
        return { ok: true };
      }
      if (
        liveAttempts.size > 0 ||
        worker.inspect().activeAttempts > 0 ||
        observing > 0
      ) {
        return { code: 'SPANS_WORKER_ATTEMPTS_ACTIVE', ok: false };
      }
      const result = store.close();
      if (result?.ok === true) {
        closed = true;
      }
      return result;
    }

    return Object.freeze({
      ...workerWithOwnership,
      close,
      inspect: worker.inspect,
    });
  } catch (error) {
    store.close();
    throw error;
  }
}
