import { AsyncLocalStorage } from 'node:async_hooks';
import { realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, resolve } from 'node:path';
import { sameSpansArchiveReservation } from './resource-admission.js';
import { admissionOperationId } from './spans-dispatch.js';
import {
  spansExecutionArchiveReservation,
  spansExecutionArchiveWriteBytes,
  spansExecutionArchiveWriteContext,
} from './spans-execution-archive-policy.js';
import { createSpansSetuAdmission } from './spans-setu-admission.js';

const refused = (code = 'SPANS_EXEC_RESOURCE_UNKNOWN') => ({
  code,
  ok: false,
});
const record = (value) =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const sameTarget = (a, b) => a?.repo === b?.repo && a?.name === b?.name;

function bindingOf(execution) {
  const generation = execution?.reviewSelector?.generation;
  if (
    !(record(execution) && Number.isSafeInteger(generation)) ||
    generation < 0 ||
    !['runId', 'spanId', 'actionId', 'attemptId'].every(
      (key) => typeof execution[key] === 'string' && execution[key]
    ) ||
    !record(execution.target)
  ) {
    return null;
  }
  return {
    actionId: execution.actionId,
    attemptId: execution.attemptId,
    generation,
    runId: execution.runId,
    spanId: execution.spanId,
    target: { name: execution.target.name, repo: execution.target.repo },
  };
}

function executionFor(store, binding) {
  try {
    const read = store.readRun({ runId: binding.runId });
    const execution =
      read?.ok === true ? read.view?.executions?.[binding.actionId] : null;
    if (
      read?.generation !== binding.generation ||
      !record(execution) ||
      execution.actionId !== binding.actionId ||
      execution.attemptId !== binding.attemptId ||
      execution.spanId !== binding.spanId ||
      execution.runId !== binding.runId ||
      !sameTarget(execution.target, binding.target) ||
      execution.reviewSelector?.generation !== binding.generation
    ) {
      return null;
    }
    const action = read.view.actions?.[binding.actionId];
    const attempt = read.view.attempts?.[binding.attemptId];
    if (
      (action &&
        (action.actionId !== binding.actionId ||
          action.attemptId !== binding.attemptId ||
          action.spanId !== binding.spanId)) ||
      (attempt &&
        (attempt.actionId !== binding.actionId ||
          attempt.attemptId !== binding.attemptId ||
          attempt.generation !== binding.generation))
    ) {
      return null;
    }
    return { action, attempt, execution, read };
  } catch {
    return null;
  }
}

function pathIsCanonical(path, directory) {
  if (typeof path !== 'string' || !isAbsolute(path) || resolve(path) !== path) {
    return false;
  }
  try {
    return directory ? realpathSync(path) === path : joinConfig(path) === path;
  } catch {
    return false;
  }
}

function joinConfig(path) {
  return `${realpathSync(dirname(path))}/${basename(path)}`;
}

function pairFor(event) {
  const payload = event?.payload;
  if (!record(payload)) {
    return { invalid: true };
  }
  const hasAction = Object.hasOwn(payload, 'actionId');
  const hasAttempt = Object.hasOwn(payload, 'attemptId');
  if (!(hasAction || hasAttempt)) {
    return null;
  }
  if (
    !hasAction ||
    typeof payload.actionId !== 'string' ||
    !payload.actionId ||
    (hasAttempt &&
      (typeof payload.attemptId !== 'string' || !payload.attemptId))
  ) {
    return { invalid: true };
  }
  return {
    actionId: payload.actionId,
    attemptId: hasAttempt ? payload.attemptId : null,
  };
}

function eventPair(method, payload) {
  if (method === 'appendEvent') {
    return pairFor(payload);
  }
  const events = payload?.events;
  if (!Array.isArray(events)) {
    return { invalid: true };
  }
  const pairs = [];
  for (const event of events) {
    const pair = pairFor(event);
    if (pair?.invalid) {
      return pair;
    }
    if (pair) {
      pairs.push(pair);
    }
  }
  if (pairs.length === 0) {
    return null;
  }
  const first = pairs.find((pair) => pair.attemptId !== null) ?? pairs[0];
  return pairs.every(
    (pair) =>
      pair.actionId === first.actionId &&
      (pair.attemptId === null || pair.attemptId === first.attemptId)
  )
    ? first
    : { invalid: true };
}

function hasOpenExecution(store, runId, proposedView) {
  if (typeof runId !== 'string') {
    return true;
  }
  const read = store.readRun({ runId });
  if (read?.ok !== true) {
    return true;
  }
  const view = proposedView ?? read.view;
  for (const execution of Object.values(view.executions ?? {})) {
    const binding = bindingOf(execution);
    if (!binding) {
      return true;
    }
    const action = view.actions?.[binding.actionId];
    const attempt = view.attempts?.[binding.attemptId];
    if (
      (action && !['completed', 'failed'].includes(action.state)) ||
      (attempt &&
        !['exited', 'failed', 'refused', 'completed'].includes(attempt.status))
    ) {
      return true;
    }
  }
  return false;
}

export function createSpansExecutionResources({
  admission: resourceAdmission,
  root,
  store,
  limits,
  resourcePaths,
} = {}) {
  const scope = new AsyncLocalStorage();
  const validRoot =
    typeof root === 'string' && isAbsolute(root) && resolve(root) === root;
  const basePaths =
    record(resourcePaths) &&
    pathIsCanonical(resourcePaths.workspaceRoot, true) &&
    pathIsCanonical(resourcePaths.configPath, false) &&
    pathIsCanonical(resourcePaths.setuDir, true)
      ? {
          configPath: resourcePaths.configPath,
          setuDir: resourcePaths.setuDir,
          workspaceRoot: resourcePaths.workspaceRoot,
        }
      : null;
  // path validation is intentionally performed once over trusted constructor inputs.

  async function currentBinding(operationId, target) {
    const active = scope.getStore();
    const prepared = active && bindingOf(active);
    if (
      prepared &&
      admissionOperationId(prepared) === operationId &&
      sameTarget(prepared.target, target)
    ) {
      return executionFor(store, prepared) ? prepared : null;
    }
    let status;
    try {
      status = await resourceAdmission.status();
    } catch {
      return null;
    }
    if (!(status?.ok === true && Array.isArray(status.leases))) {
      return null;
    }
    const lease = status.leases.find(
      (item) => item?.operationId === operationId
    );
    const candidate = lease?.spansBinding;
    if (
      !(record(candidate) && sameTarget(candidate.target, target)) ||
      admissionOperationId(candidate) !== operationId ||
      !executionFor(store, candidate)
    ) {
      return null;
    }
    return candidate;
  }

  function reservationFor(binding, operationId) {
    if (
      !validRoot ||
      operationId !== admissionOperationId(binding) ||
      !executionFor(store, binding)
    ) {
      return null;
    }
    return spansExecutionArchiveReservation({ limits, root });
  }

  const admission = createSpansSetuAdmission({
    releaseGuard: (binding) => executionFor(store, binding) !== null,
    resolveArchiveReservation: ({ binding, operationId }) =>
      reservationFor(binding, operationId),
    resolveOperation: async ({ operationId, target }) => {
      const binding = await currentBinding(operationId, target);
      return binding && sameTarget(binding.target, target) ? binding : null;
    },
    resourceAdmission,
  });

  function sameBinding(leaseBinding, binding) {
    return (
      leaseBinding?.generation === binding.generation &&
      leaseBinding?.actionId === binding.actionId &&
      leaseBinding?.attemptId === binding.attemptId &&
      leaseBinding?.runId === binding.runId &&
      leaseBinding?.spanId === binding.spanId &&
      sameTarget(leaseBinding?.target, binding.target)
    );
  }

  async function authorityStatus(authority) {
    try {
      const result = await authority.status();
      return result?.ok === true && Array.isArray(result.leases)
        ? result
        : null;
    } catch {
      return null;
    }
  }

  async function verifiedLease(binding) {
    if (!(binding && executionFor(store, binding))) {
      return { state: 'unknown' };
    }
    const raw = await authorityStatus(resourceAdmission);
    if (!raw) {
      return { state: 'unknown' };
    }

    const operationId = admissionOperationId(binding);
    const candidate = raw.leases.find(
      (item) => item?.operationId === operationId
    );
    if (!candidate) {
      const matching = raw.leases.some((item) =>
        sameBinding(item?.spansBinding, binding)
      );
      return matching ? { state: 'mismatch' } : { state: 'absent' };
    }
    const expected = spansExecutionArchiveReservation({ limits, root });
    if (
      !(
        sameBinding(candidate.spansBinding, binding) &&
        sameTarget(candidate.target, binding.target) &&
        expected &&
        sameSpansArchiveReservation(expected, candidate.spansArchiveReservation)
      )
    ) {
      return { state: 'mismatch' };
    }

    const checked = await authorityStatus(admission);
    if (!checked) {
      return { state: 'unknown' };
    }
    const lease = checked.leases.find(
      (item) => item.operationId === operationId
    );
    return lease && sameBinding(lease.spansBinding, binding)
      ? { lease, state: 'present' }
      : { state: 'mismatch' };
  }

  function savedBinding(runId, pair) {
    const read = typeof runId === 'string' ? store.readRun({ runId }) : null;
    const execution =
      read?.ok === true ? read.view?.executions?.[pair.actionId] : null;
    const binding = bindingOf(execution);
    return binding &&
      binding.runId === runId &&
      binding.actionId === pair.actionId &&
      (pair.attemptId === null || binding.attemptId === pair.attemptId) &&
      executionFor(store, binding)
      ? binding
      : null;
  }

  function allowedWithoutLease(binding) {
    const current = executionFor(store, binding);
    const preintent = current && !(current.action || current.attempt);
    const terminal =
      ['completed', 'failed'].includes(current?.action?.state) &&
      (!current.attempt ||
        ['exited', 'failed', 'refused', 'completed'].includes(
          current.attempt.status
        ));
    return Boolean(preintent || terminal);
  }

  function writeAllocation(method, payload, lease) {
    const context = spansExecutionArchiveWriteContext(store, method, payload);
    if (!context) {
      return refused('LEASE_BINDING_UNKNOWN');
    }
    const maxBytes = spansExecutionArchiveWriteBytes({
      limits,
      method,
      payload: context,
    });
    if (!(Number.isSafeInteger(maxBytes) && maxBytes > 0)) {
      return refused('SPANS_ARCHIVE_WRITE_INVALID');
    }
    const reservation = lease?.spansArchiveReservation;
    if (
      reservation &&
      (reservation.root !== root || maxBytes > reservation.reservedBytes)
    ) {
      return refused('LEASE_MISMATCH');
    }
    return {
      ok: true,
      request: { ...(lease ? { lease } : {}), maxBytes, root },
    };
  }

  function firstAuthorization(method, payload, pair) {
    if (
      method !== 'commitRun' ||
      payload.events?.length !== 1 ||
      payload.events[0].type !== 'spans.execution.authorized'
    ) {
      return false;
    }
    const read = store.readRun({ runId: payload.runId });
    const binding = bindingOf(payload.view?.executions?.[pair.actionId]);
    return Boolean(
      read?.ok === true &&
        binding &&
        binding.runId === payload.runId &&
        binding.actionId === pair.actionId &&
        binding.attemptId === pair.attemptId &&
        binding.generation === read.generation &&
        payload.expectedGeneration === read.generation &&
        payload.expectedRevision === read.revision &&
        !read.view.executions?.[pair.actionId] &&
        !read.view.actions?.[pair.actionId] &&
        !read.view.attempts?.[pair.attemptId]
    );
  }

  function writeWithoutBinding(method, payload) {
    if (
      method === 'commitRun' &&
      (hasOpenExecution(store, payload.runId) ||
        hasOpenExecution(store, payload.runId, payload.view))
    ) {
      return refused('LEASE_BINDING_UNKNOWN');
    }
    return writeAllocation(method, payload);
  }

  function isHistoricalReport(method, event) {
    if (
      method !== 'appendEvent' ||
      event.type !== 'spans.action.outcome.historical' ||
      event.view !== undefined ||
      event.payload?.historical !== true
    ) {
      return false;
    }
    const read = store.readRun({ runId: event.runId });
    const { payload } = event;
    const action =
      read?.ok === true ? read.view.actions?.[payload.actionId] : null;
    return Boolean(
      action &&
        action.spanId === payload.spanId &&
        Number.isSafeInteger(payload.reportedGeneration) &&
        payload.reportedGeneration >= 0 &&
        payload.reportedGeneration < read.generation
    );
  }

  async function writeRequest({ method, payload } = {}) {
    if (!(['appendEvent', 'commitRun'].includes(method) && record(payload))) {
      return refused('SPANS_ARCHIVE_WRITE_INVALID');
    }
    // Late reports append inert history under the ordinary capacity gate, never the old lease.
    if (isHistoricalReport(method, payload)) {
      return writeAllocation(method, payload);
    }
    const pair = eventPair(method, payload);
    if (pair?.invalid) {
      return refused('LEASE_BINDING_UNKNOWN');
    }
    // Authorization is saved before admission; its CAS still uses the shared gate.
    if (pair && firstAuthorization(method, payload, pair)) {
      return writeAllocation(method, payload);
    }
    if (!pair) {
      return writeWithoutBinding(method, payload);
    }
    const binding = savedBinding(payload.runId, pair);
    if (!binding) {
      return refused('LEASE_BINDING_UNKNOWN');
    }
    const state = await verifiedLease(binding);
    if (state.state === 'unknown' || state.state === 'mismatch') {
      return refused('LEASE_BINDING_UNKNOWN');
    }
    if (state.state === 'absent' && !allowedWithoutLease(binding)) {
      return refused('LEASE_BINDING_UNKNOWN');
    }
    return writeAllocation(method, payload, state.lease);
  }

  async function captureContext(binding) {
    const valid = bindingOf({
      ...binding,
      reviewSelector: { generation: binding?.generation },
      target: binding?.target,
    });
    if (!(valid && basePaths && validRoot)) {
      return refused('LEASE_BINDING_UNKNOWN');
    }
    const exact = executionFor(store, valid);
    if (!exact) {
      return refused('LEASE_BINDING_UNKNOWN');
    }
    const result = await verifiedLease(valid);
    if (
      result.state !== 'present' ||
      result.lease.spansArchiveReservation.root !== root
    ) {
      return refused('LEASE_BINDING_UNKNOWN');
    }
    return { ...basePaths, lease: result.lease };
  }

  return Object.freeze({
    admission,
    captureContext,
    withExecution: (execution, effect) => {
      const binding = bindingOf(execution);
      if (!binding || typeof effect !== 'function') {
        return Promise.resolve(refused('LEASE_BINDING_UNKNOWN'));
      }
      return scope.run(execution, effect);
    },
    writeRequest,
  });
}
