import { AsyncLocalStorage } from 'node:async_hooks';

const memoryPattern = /^(\d+(?:\.\d+)?)\s*(g|m)$/i;

export function parseMemToMb(value) {
  const match = String(value).trim().match(memoryPattern);
  return match
    ? Number(match[1]) * (match[2].toLowerCase() === 'g' ? 1024 : 1)
    : null;
}

export function resourceSettings(config) {
  const maxConcurrentDevServers = Number(config.maxConcurrentDevServers ?? 3);
  const containerCpuLimit = Number(config.containerCpuLimit ?? 2);
  const containerMemoryLimit = String(config.containerMemoryLimit ?? '4g');
  if (
    !Number.isInteger(maxConcurrentDevServers) ||
    maxConcurrentDevServers < 1 ||
    maxConcurrentDevServers > 64
  ) {
    throw new Error('Concurrency must be an integer from 1 to 64');
  }
  if (
    !Number.isFinite(containerCpuLimit) ||
    containerCpuLimit < 0.01 ||
    containerCpuLimit > 1024
  ) {
    throw new Error('CPU limit must be between 0.01 and 1024');
  }
  const mb = parseMemToMb(containerMemoryLimit);
  if (!mb || mb < 64 || mb > 1024 * 1024) {
    throw new Error('Memory limit must be between 64m and 1024g');
  }
  return { containerCpuLimit, containerMemoryLimit, maxConcurrentDevServers };
}

export function effectiveContainerLimits(config, cap) {
  const settings = resourceSettings(config);
  const memMb = Math.min(
    parseMemToMb(settings.containerMemoryLimit),
    cap.memMb ? Math.floor(cap.memMb * 0.9) : Number.POSITIVE_INFINITY
  );
  const cpus = Math.min(
    settings.containerCpuLimit,
    cap.cpus || Number.POSITIVE_INFINITY
  );
  const max = Math.min(
    settings.maxConcurrentDevServers,
    cap.memMb ? Math.floor((cap.memMb * 0.9) / memMb) : 0,
    cap.cpus ? Math.floor((cap.cpus + 1e-9) / cpus) : 0
  );
  return Object.freeze({ cpus, max, memMb });
}

// Process ownership lives here; callers receive immutable observations only.
export function createWorktreeLifecycle({
  runtime,
  validateTarget,
  assertStorage = () => Promise.resolve(),
  settings,
  capacity,
  clock,
  withTarget = async (_target, task) => task(),
  hasSupportingWork = () => false,
  onChange = () => undefined,
}) {
  const cleanAsyncContext = AsyncLocalStorage.snapshot();
  const records = new Map();
  const queued = [];
  const operations = new Map();
  const background = new Map();
  const operationResults = new Map();
  const startWaiters = new Map();
  let generation = 0;
  let policy = resourceSettings(settings);
  let draining = null;
  let capacityValue = Object.freeze({
    available: false,
    cpus: null,
    memMb: null,
  });
  let capacityInFlight = null;
  let capacityCheckedAt = Number.NEGATIVE_INFINITY;
  let queueTimer = null;
  let disposed = false;
  let closedBy = null;

  const failure = (code, error) =>
    Object.freeze({
      code: error?.code ?? code,
      error: String(error?.message ?? error),
      ok: false,
      ...(typeof error?.committed === 'boolean'
        ? { committed: error.committed }
        : {}),
      ...(error?.phase ? { phase: error.phase } : {}),
      ...(error?.causeCode ? { causeCode: error.causeCode } : {}),
    });
  const activeCount = () =>
    [...records.values()].filter((record) => record.reserved).length;
  function usage(excluding = null) {
    let cpus = 0,
      memMb = 0,
      count = 0;
    for (const record of records.values()) {
      if (!record.reserved || record === excluding) {
        continue;
      }
      count += 1;
      if (!record.spec?.container) {
        continue;
      }
      cpus +=
        record.spec.limits?.cpus ??
        capacityValue.cpus ??
        Number.POSITIVE_INFINITY;
      memMb +=
        record.spec.limits?.memMb ??
        capacityValue.memMb ??
        Number.POSITIVE_INFINITY;
    }
    return { count, cpus, memMb };
  }
  function launchSpec(record, container) {
    return Object.freeze({
      container,
      limits: container
        ? effectiveContainerLimits(policy, capacityValue)
        : null,
      port: record.target.port,
      project: record.target.project,
    });
  }
  function admissionReason(spec, excluding = null) {
    const used = usage(excluding);
    if (used.count >= policy.maxConcurrentDevServers) {
      return 'concurrency';
    }
    if (
      spec.container &&
      (!capacityValue.available ||
        capacityValue.cpus <= 0 ||
        capacityValue.memMb <= 0 ||
        used.cpus + spec.limits.cpus > capacityValue.cpus + 1e-9 ||
        used.memMb + spec.limits.memMb > Math.floor(capacityValue.memMb * 0.9))
    ) {
      return 'container-capacity';
    }
    return null;
  }
  function canAdmit(spec, excluding = null) {
    return admissionReason(spec, excluding) === null;
  }
  // biome-ignore lint/suspicious/useAwait: Cached capacity is an object; this helper intentionally normalizes every branch to the Promise contract awaited by start, restart, and refreshCapacity.
  async function readCapacity(force = false) {
    if (capacityInFlight) {
      return capacityInFlight;
    }
    if (!force && clock.now() - capacityCheckedAt < 30_000) {
      return capacityValue;
    }
    capacityInFlight = Promise.resolve()
      .then(() => capacity.refresh())
      .then(
        (value) => {
          capacityValue = Object.freeze({
            ...value,
            available:
              value.available === true && value.cpus > 0 && value.memMb > 0,
          });
          return capacityValue;
        },
        () => {
          capacityValue = Object.freeze({ ...capacityValue, available: false });
          return capacityValue;
        }
      )
      .finally(() => {
        capacityCheckedAt = clock.now();
        capacityInFlight = null;
      });
    return capacityInFlight;
  }
  function armQueueTimer() {
    const needsRefresh =
      !disposed && queued.some((record) => record.spec.container);
    if (!needsRefresh && queueTimer !== null) {
      clock.clearTimeout(queueTimer);
      queueTimer = null;
    }
    if (needsRefresh && queueTimer === null) {
      queueTimer = clock.setTimeout(
        () =>
          cleanAsyncContext(async () => {
            queueTimer = null;
            await readCapacity(true);
            await drain();
            armQueueTimer();
          }),
        Math.max(1, 30_000 - (clock.now() - capacityCheckedAt))
      );
    }
  }
  const view = (record) =>
    record
      ? Object.freeze({
          container: record.spec?.container
            ? (record.spec.project ?? true)
            : null,
          generation: record.generation,
          key: record.target.key,
          lastError: record.lastError ?? null,
          launchSpec: record.spec,
          limits: record.spec?.limits ?? null,
          ownedGroup: record.handle?.ownedGroup === true,
          phase: record.phase,
          pid: record.handle?.pid ?? null,
          reason: record.queueReason ?? null,
          reserved: record.reserved,
          startedAt: record.startedAt ?? null,
          stopping:
            record.phase === 'stopping' || record.phase === 'restarting',
          target: record.target,
        })
      : null;
  function startOutcome(record) {
    if (disposed || records.get(record.target.key) !== record) {
      return Object.freeze({ ok: false, state: 'unknown' });
    }
    if (record.phase === 'running') {
      return Object.freeze({ ok: true, state: 'running' });
    }
    if (record.phase === 'unknown') {
      return Object.freeze({ ok: false, state: 'unknown' });
    }
    if (record.phase === 'stopped') {
      if (record.lastError) {
        return Object.freeze({
          ...record.lastError,
          ok: false,
          state: 'failed',
        });
      }
      return Object.freeze({
        ok: false,
        state: record.stopIntent ? 'cancelled' : 'stopped',
      });
    }
    return null;
  }
  function settleStartWaiters() {
    for (const [record, waiter] of startWaiters) {
      const outcome = startOutcome(record);
      if (outcome) {
        startWaiters.delete(record);
        waiter.resolve(outcome);
      }
    }
  }
  function publish() {
    settleStartWaiters();
    try {
      onChange();
    } catch {
      /* Observers cannot release ownership. */
    }
  }
  function makeRecord(target) {
    generation += 1;
    const record = {
      generation,
      handle: null,
      operation: null,
      phase: 'admitting',
      queueReason: null,
      reserved: false,
      spec: null,
      stopIntent: false,
      target: Object.freeze({ ...target }),
    };
    records.set(target.key, record);
    settleStartWaiters();
    return record;
  }
  function operate(record, operation) {
    const promise = Promise.resolve()
      .then(() => withTarget(record.target, operation))
      .catch((error) => {
        record.lastError = failure('ADMISSION_FAILED', error);
        record.reserved = !!record.handle;
        record.phase = record.handle ? 'unknown' : 'stopped';
        return record.lastError;
      })
      .finally(() => {
        if (record.operation === promise) {
          record.operation = null;
        }
        publish();
      });
    record.operation = promise;
    return promise;
  }
  async function launch(record, options) {
    record.reserved = true;
    record.queueReason = null;
    await assertStorage(record.target);
    if (record.stopIntent) {
      return { ok: true, stopped: true };
    }
    record.phase = 'starting';
    generation += 1;
    record.generation = generation;
    record.deadObservations = 0;
    record.startedAt = clock.now();
    const result = await runtime.launch(
      record.target,
      record.spec,
      (handle) => {
        if (record.handle) {
          throw new Error('Runtime registered a second owned handle');
        }
        record.handle = handle;
        watchExit(record, handle);
      },
      options
    );
    publish();
    return {
      container: record.spec.container,
      ok: true,
      ...(result?.skippedSidecars?.length
        ? { skippedSidecars: result.skippedSidecars }
        : {}),
    };
  }
  function watchExit(record, handle) {
    if (!handle.exited?.then) {
      return;
    }
    const capturedGeneration = record.generation;
    cleanAsyncContext(() => {
      Promise.resolve(handle.exited)
        .catch(() => undefined)
        .then(async () => {
          if (record.operation) {
            await record.operation;
          }
          await reconcile(record.target.key, capturedGeneration);
        })
        .catch(() => {
          /* A failed observation never discards ownership. */
        });
    });
  }
  async function observedRuntimeState(record, handle) {
    try {
      return await runtime.observe(record.target, handle);
    } catch {
      return 'unknown';
    }
  }
  function observationStillCurrent(record, key, expectedGeneration) {
    return (
      records.get(key) === record &&
      record.generation === expectedGeneration &&
      !record.operation &&
      !record.stopPromise
    );
  }
  function applyObservation(record, state) {
    if (!record.reserved) {
      if (record.phase === 'unknown' && state === 'dead') {
        record.phase = 'stopped';
        record.lastError = null;
        publish();
      }
      return { state };
    }
    if (state !== 'dead') {
      record.deadObservations = 0;
      record.phase = state === 'alive' ? 'running' : 'unknown';
      publish();
      return { state };
    }
    record.deadObservations = (record.deadObservations ?? 0) + 1;
    if (record.spec.container && record.deadObservations < 2) {
      return { retained: true, state: 'dead' };
    }
    return stop(record.target);
  }
  // biome-ignore lint/suspicious/useAwait: Early observation outcomes are values while an in-flight observation is a Promise; callers (watchExit, portal reconciliation, and lifecycle tests) rely on one Promise boundary.
  async function reconcile(key, expectedGeneration) {
    const record = records.get(key);
    if (
      !record ||
      record.generation !== expectedGeneration ||
      record.operation ||
      record.stopPromise ||
      // An unreserved record is only worth observing while its state is unknown.
      !(record.reserved || record.phase === 'unknown')
    ) {
      return { state: 'unchanged' };
    }
    if (record.observing) {
      return record.observing;
    }
    const capturedHandle = record.handle;
    record.observing = (async () => {
      const state = await observedRuntimeState(record, capturedHandle);
      if (!observationStillCurrent(record, key, expectedGeneration)) {
        return { state: 'unchanged' };
      }
      return applyObservation(record, state);
    })().finally(() => {
      record.observing = null;
    });
    return record.observing;
  }
  // biome-ignore lint/suspicious/useAwait: Draining exposes one Promise completion boundary to start, stop, capacity refresh, and the queue timer while sharing the in-flight drain.
  async function drain() {
    if (draining) {
      return draining;
    }
    draining = (async () => {
      while (!(closedBy || disposed) && queued.length) {
        let index = -1;
        for (let candidate = 0; candidate < queued.length; candidate += 1) {
          const record = queued[candidate];
          const spec = launchSpec(record, record.spec.container);
          record.queueReason = admissionReason(spec);
          if (
            !operations.has(record.target.key) &&
            record.queueReason === null
          ) {
            index = candidate;
            break;
          }
        }
        if (index === -1) {
          break;
        }
        const [record] = queued.splice(index, 1);
        record.spec = launchSpec(record, record.spec.container);
        record.reserved = true;
        record.phase = 'admitting';
        // biome-ignore lint/performance/noAwaitInLoops: Queue admission is result-dependent: each completed launch changes the capacity available to the next FIFO candidate.
        await operate(record, async () => {
          try {
            await validateTarget(record.target, { kind: 'start' });
            if (record.stopIntent) {
              return { ok: true, stopped: true };
            }
            return await launch(record);
          } catch (error) {
            record.lastError = failure('START_FAILED', error);
            record.phase = record.handle ? 'unknown' : 'stopped';
            record.reserved = !!record.handle;
            return record.lastError;
          }
        });
      }
    })().finally(() => {
      draining = null;
      armQueueTimer();
    });
    return draining;
  }
  async function prepareStart(record, container) {
    await validateTarget(record.target, { kind: 'start' });
    if (record.reserved) {
      const observed = await runtime
        .observe(record.target, record.handle)
        .catch(() => 'unknown');
      if (observed !== 'dead') {
        return failure(
          observed === 'unknown' ? 'RUNTIME_UNKNOWN' : 'ALREADY_RUNNING',
          'Runtime is already running or its liveness is unknown'
        );
      }
      await runtime.stop(record.target, record.handle);
      record.handle = null;
      record.reserved = false;
    }
    if (container) {
      await readCapacity();
      if (!capacityValue.available) {
        throw new Error(
          'Docker capacity is unavailable; start the engine or choose bare mode.'
        );
      }
    }
    record.spec = launchSpec(record, container);
    if (record.stopIntent) {
      record.phase = 'stopped';
      return { ok: true, stopped: true };
    }
    const reason = admissionReason(record.spec);
    if (reason) {
      record.phase = 'queued';
      record.queueReason = reason;
      queued.push(record);
      armQueueTimer();
      publish();
      return {
        container,
        ok: true,
        position: queued.length,
        queued: true,
        reason,
      };
    }
    return launch(record);
  }
  async function startRecord(record, container) {
    try {
      return await prepareStart(record, container);
    } catch (error) {
      record.lastError = failure('START_FAILED', error);
      record.phase = record.handle ? 'unknown' : 'stopped';
      record.reserved = !!record.handle;
      return record.lastError;
    }
  }
  async function start(target, container = true) {
    if (closedBy || disposed) {
      return failure('ADMISSION_CLOSED', 'Lifecycle admission is closed');
    }
    if (operations.has(target.key)) {
      return failure('TARGET_BUSY', 'Another operation owns this worktree');
    }
    const current = records.get(target.key);
    if (current?.phase === 'unknown' && !current.handle) {
      return failure(
        'RUNTIME_UNKNOWN',
        'Previous teardown is unresolved; retry Stop before Start'
      );
    }
    if (current?.phase === 'queued') {
      return {
        container: current.spec.container,
        ok: true,
        position: queued.indexOf(current) + 1,
        queued: true,
        reason: current.queueReason,
      };
    }
    if (current?.operation || current?.stopPromise) {
      return failure(
        'ALREADY_RUNNING',
        'already running, starting or stopping'
      );
    }
    const record = current?.reserved ? current : makeRecord(target);
    record.stopIntent = false;
    const result = await operate(record, () => startRecord(record, container));
    if (!record.reserved && record.phase !== 'queued' && !record.stopPromise) {
      await drain();
    }
    return result;
  }
  // biome-ignore lint/suspicious/useAwait: Stop is the lifecycle's public Promise API; early state setup must reject rather than synchronously throw for portal and removal callers.
  async function stop(target, { drain: shouldDrain = true } = {}) {
    let record = records.get(target.key);
    if (!record) {
      record = makeRecord(target);
    }
    if (record.stopPromise) {
      return record.stopPromise;
    }
    record.stopIntent = true;
    const pending = record.operation;
    const index = queued.indexOf(record);
    if (index !== -1) {
      queued.splice(index, 1);
    }
    armQueueTimer();
    record.phase = 'stopping';
    const promise = (async () => {
      if (pending) {
        await pending;
      }
      record.phase = 'stopping';
      try {
        const result = await runtime.stop(record.target, record.handle);
        record.handle = null;
        record.reserved = false;
        record.phase = 'stopped';
        record.lastError = null;
        if (shouldDrain) {
          await drain();
        }
        return {
          ok: true,
          ...(result?.warnings?.length ? { warnings: result.warnings } : {}),
        };
      } catch (error) {
        record.phase = 'unknown';
        record.lastError = failure('STOP_FAILED', error);
        return record.lastError;
      } finally {
        record.stopPromise = null;
        publish();
      }
    })();
    record.stopPromise = promise;
    return promise;
  }
  async function prepareRestart(record, priorPhase, change) {
    await validateTarget(record.target, { kind: 'restart' });
    if (record.spec.container) {
      await readCapacity(true);
    }
    const replacement =
      record.spec.container && !record.spec.limits
        ? launchSpec(record, true)
        : record.spec;
    if (!canAdmit(replacement, record)) {
      record.phase = priorPhase;
      return {
        result: failure(
          'RESTART_CAPACITY_UNAVAILABLE',
          'Current capacity cannot admit this restart; the existing runtime was left unchanged.'
        ),
      };
    }
    try {
      await assertStorage(record.target);
    } catch (error) {
      record.phase = priorPhase;
      record.lastError = failure('RESTART_FAILED', error);
      return { result: record.lastError };
    }
    await change();
    return { replacement };
  }
  async function restartRecord(record, priorPhase, priorHandle, change) {
    let tornDown = false;
    try {
      const prepared = await prepareRestart(record, priorPhase, change);
      if ('result' in prepared) {
        return prepared.result;
      }
      if (record.stopIntent) {
        return { ok: true, stopped: true };
      }
      // Once teardown is attempted its outcome decides the phase, not the
      // state before it.
      tornDown = true;
      await runtime.stop(record.target, record.handle, { sidecars: false });
      record.handle = null;
      record.spec = prepared.replacement;
      return record.stopIntent
        ? { ok: true, stopped: true }
        : await launch(record, { sidecars: false });
    } catch (error) {
      record.lastError = failure('RESTART_FAILED', error);
      if (!tornDown && record.handle === priorHandle) {
        record.phase = priorPhase;
        record.reserved = true;
      } else {
        record.phase = record.handle ? 'unknown' : 'stopped';
        record.reserved = !!record.handle;
      }
      return record.lastError;
    }
  }
  async function restart(target, change = () => Promise.resolve()) {
    if (closedBy || disposed) {
      return failure('ADMISSION_CLOSED', 'Lifecycle admission is closed');
    }
    if (operations.has(target.key)) {
      return failure('TARGET_BUSY', 'Another operation owns this worktree');
    }
    const record = records.get(target.key);
    if (!record?.reserved) {
      return failure('NOT_RUNNING', 'No owned runtime to restart');
    }
    if (record.operation || record.stopPromise) {
      return failure(
        'TARGET_BUSY',
        'A lifecycle operation is already in progress'
      );
    }
    const priorPhase = record.phase;
    const priorHandle = record.handle;
    record.phase = 'restarting';
    record.stopIntent = false;
    const result = await operate(record, () =>
      restartRecord(record, priorPhase, priorHandle, change)
    );
    if (!record.reserved) {
      await drain();
    }
    return result;
  }
  async function updateSettings(next) {
    policy = resourceSettings(next);
    await drain();
    return Object.freeze({ ...policy });
  }
  async function refreshCapacity() {
    const value = await readCapacity();
    await drain();
    return value;
  }
  // biome-ignore lint/suspicious/useAwait: Busy and closed failures are values, while task execution is deferred; callers uniformly await this public operation boundary.
  async function runOperation(target, kind, task) {
    if (closedBy || disposed) {
      return failure('ADMISSION_CLOSED', 'Lifecycle admission is closed');
    }
    const record = records.get(target.key);
    if (
      operations.has(target.key) ||
      record?.operation ||
      record?.stopPromise ||
      (record?.phase === 'unknown' && kind !== 'remove')
    ) {
      return failure(
        'TARGET_BUSY',
        'Another operation or unresolved teardown owns this worktree'
      );
    }
    if ((kind === 'setup' || kind === 'project-setup') && record?.reserved) {
      return failure(
        'TARGET_BUSY',
        'Stop the owned runtime before changing setup'
      );
    }
    const token = Symbol(kind);
    operations.set(target.key, { kind, token });
    let uncertain;
    const unknownOutcome = new Promise((resolve) => {
      uncertain = resolve;
    });
    const completion = Promise.resolve()
      .then(() =>
        withTarget(target, async () => {
          try {
            await validateTarget(target, { kind });
            // Teardown belongs to this operation; drain only after its target lock is released.
            return await task(
              Object.freeze({
                snapshot: () => view(records.get(target.key)),
                stop: () => stop(target, { drain: false }),
              })
            );
          } catch (error) {
            if (error.code === 'OPERATION_UNKNOWN') {
              if (operations.get(target.key)?.token === token) {
                operations.get(target.key).phase = 'unknown';
              }
              uncertain(failure('OPERATION_UNKNOWN', error));
              publish();
              // Returning an error must not release a lock while a process may still
              // use the checkout. This lock needs diagnosed reconciliation; never
              // silently steal or release it because an observation failed.
              await new Promise(() => {
                // Diagnosed recovery, rather than an elapsed timer, owns this lease.
              });
            }
            throw error;
          }
        })
      )
      .catch((error) => failure('OPERATION_FAILED', error))
      .then(async (result) => {
        if (operations.get(target.key)?.token === token) {
          operations.delete(target.key);
        }
        await drain();
        publish();
        return result;
      });
    return Promise.race([completion, unknownOutcome]);
  }
  function startOperation(target, kind, launchOperation) {
    let accept;
    const accepted = new Promise((resolve) => {
      accept = resolve;
    });
    const done = runOperation(target, kind, async (controls) => {
      const launched = await launchOperation(controls);
      if (!launched?.completion?.then) {
        return launched?.result ?? launched;
      }
      operationResults.set(
        target.key,
        Object.freeze({ kind, phase: 'running' })
      );
      accept(launched.result);
      await launched.completion;
      operationResults.set(
        target.key,
        Object.freeze({ kind, phase: 'complete' })
      );
      return { ok: true };
    })
      .then((result) => {
        if (result?.ok === false) {
          operationResults.set(
            target.key,
            Object.freeze({ error: result.error, kind, phase: 'failed' })
          );
        }
        accept(result);
        return result;
      })
      .finally(() => {
        if (background.get(target.key) === done) {
          background.delete(target.key);
        }
      });
    if (!background.has(target.key)) {
      background.set(target.key, done);
    }
    return accepted;
  }
  function adopt(
    target,
    handle,
    spec = {
      container: !!handle.container,
      limits: null,
      port: target.port,
      project: handle.container,
    }
  ) {
    if (
      records.get(target.key)?.reserved ||
      records.get(target.key)?.operation ||
      records.get(target.key)?.phase === 'queued' ||
      operations.has(target.key)
    ) {
      throw new Error('Target already has an owner');
    }
    const record = makeRecord(target);
    record.handle = handle;
    record.spec = Object.freeze({
      ...spec,
      limits: spec.limits ? Object.freeze({ ...spec.limits }) : null,
    });
    record.reserved = true;
    record.phase = handle.observedState === 'unknown' ? 'unknown' : 'running';
    record.startedAt = clock.now();
    watchExit(record, handle);
    publish();
    return view(record);
  }
  function dispose() {
    disposed = true;
    settleStartWaiters();
    armQueueTimer();
  }
  function waitForStart(target) {
    const record = records.get(target.key);
    if (!record) {
      return Promise.resolve(Object.freeze({ ok: false, state: 'unknown' }));
    }
    const outcome = startOutcome(record);
    if (outcome) {
      return Promise.resolve(outcome);
    }
    let waiter = startWaiters.get(record);
    if (!waiter) {
      let resolve;
      waiter = {
        promise: new Promise((done) => {
          resolve = done;
        }),
        resolve,
      };
      startWaiters.set(record, waiter);
    }
    return waiter.promise;
  }
  function quiescenceStatus(token) {
    if (!closedBy || token !== closedBy) {
      return failure(
        'ADMISSION_CLOSED',
        'Only the current cutover owner may inspect closed admission'
      );
    }
    const busy =
      queued.length > 0 ||
      operations.size > 0 ||
      hasSupportingWork() ||
      [...records.values()].some(
        (record) =>
          record.reserved ||
          record.operation ||
          record.stopPromise ||
          record.phase === 'unknown'
      );
    return Object.freeze({
      ok: !busy,
      ...(busy
        ? {
            code: 'OWNED_WORK_ACTIVE',
            error: 'Active or unknown work blocks cutover',
          }
        : {}),
    });
  }
  function quiesce() {
    if (closedBy) {
      return failure('ADMISSION_CLOSED', 'Another cutover owns admission');
    }
    closedBy = Symbol('quiescence');
    return Object.freeze({ ...quiescenceStatus(closedBy), token: closedBy });
  }
  async function reopen(token, { coherent = false } = {}) {
    if (!closedBy || token !== closedBy || !coherent || disposed) {
      return failure(
        'ADMISSION_CLOSED',
        'Only the coherent cutover owner may reopen admission'
      );
    }
    closedBy = null;
    await drain();
    return { ok: true };
  }
  return Object.freeze({
    adopt,
    dispose,
    operationStatus: (key) =>
      operations.has(key)
        ? Object.freeze({
            kind: operations.get(key).kind,
            phase: operations.get(key).phase ?? 'running',
          })
        : (operationResults.get(key) ?? null),
    queueSnapshot: () => Object.freeze(queued.map(view)),
    quiesce,
    quiescenceStatus,
    reconcile,
    refreshCapacity,
    reopen,
    restart,
    runOperation,
    snapshot: (key) => view(records.get(key)),
    snapshots: () => Object.freeze([...records.values()].map(view)),
    start,
    startOperation,
    status: () =>
      Object.freeze({
        active: activeCount(),
        capacity: capacityValue,
        container: Object.freeze({ cpus: usage().cpus, memMb: usage().memMb }),
        max: policy.maxConcurrentDevServers,
        queued: queued.length,
      }),
    stop,
    updateSettings,
    waitForOperation: (target) =>
      background.get(target.key) ?? Promise.resolve(),
    waitForStart,
  });
}
