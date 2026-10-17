import { basename, dirname, isAbsolute, resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { inspectCheckoutIdentity } from './checkout-identity.js';

const stages = [
  'stop',
  'volumes',
  'tunnel',
  'git',
  'archive',
  'registry',
  'routing',
];
const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const decimalPattern = /^\d+$/;
const unsafeWorktreePartPattern = /[\\\s:]/;
const uuid = (value) => typeof value === 'string' && uuidPattern.test(value);
const object = (value) =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const evidence = (value) =>
  object(value) &&
  ['dev', 'ino', 'birthtimeNs'].every(
    (key) => typeof value[key] === 'string' && decimalPattern.test(value[key])
  ) &&
  value.ino !== '0' &&
  value.birthtimeNs !== '0';
const identityValid = (value) =>
  value?.known === true &&
  ['checkoutPath', 'repositoryPath', 'adminPath'].every(
    (key) => typeof value[key] === 'string' && isAbsolute(value[key])
  ) &&
  ['checkout', 'repository', 'admin'].every((key) => evidence(value[key]));
const absentIdentity = (value) => value?.absent === true;
function problem(code, message) {
  return Object.assign(new Error(message), { code });
}
function removalState(record) {
  if (record.completed.includes('git')) {
    return true;
  }
  return record.attempting === 'git' ? null : false;
}
function removalStateAfterObservation(record, observation) {
  if (record.completed.includes('git')) {
    return true;
  }
  if (observation.state === 'original') {
    return false;
  }
  return observation.state === 'absent' ? true : null;
}
function removalFailureCode(error, removed) {
  if (error.code === 'REMOVAL_IDENTITY_CHANGED') {
    return error.code;
  }
  if (removed === null) {
    return 'REMOVAL_OUTCOME_UNKNOWN';
  }
  if (removed === true) {
    return 'REMOVAL_INCOMPLETE';
  }
  return error.code ?? 'REMOVAL_FAILED';
}
const fingerprint = (stat) => ({
  birthtimeNs: String(stat.birthtimeNs),
  dev: String(stat.dev),
  ino: String(stat.ino),
});
async function canonicalPath(fs, path) {
  let currentPath = path;
  const suffix = [];
  for (;;) {
    try {
      // biome-ignore lint/performance/noAwaitInLoops: A missing child determines the next parent path, so canonicalization must ascend one component at a time.
      return resolve(await fs.realpath(currentPath), ...suffix.reverse());
    } catch (error) {
      if (error.code !== 'ENOENT' || dirname(currentPath) === currentPath) {
        throw error;
      }
      suffix.push(basename(currentPath));
      currentPath = dirname(currentPath);
    }
  }
}
async function worktreeRegistration(target, run) {
  const list = await run([
    'git',
    '-C',
    target.repoDir,
    'worktree',
    'list',
    '--porcelain',
    '-z',
  ]);
  if (list.code !== 0 || list.timedOut || list.truncated) {
    return { state: 'unknown' };
  }
  const paths = list.stdout
    .split('\0')
    .filter((line) => line.startsWith('worktree '))
    .map((line) => line.slice(9));
  return { paths, state: 'known' };
}
async function observeAbsentCheckout(_record, target, { fs, run }) {
  const canonical = (path) => canonicalPath(fs, path);
  try {
    await fs.lstat(target.wtDir);
    return { state: 'conflict' };
  } catch (error) {
    if (error.code !== 'ENOENT') {
      return { state: 'unknown' };
    }
  }
  try {
    await fs.stat(target.repoDir);
  } catch (error) {
    return { state: error.code === 'ENOENT' ? 'absent' : 'unknown' };
  }
  try {
    const registration = await worktreeRegistration(target, run);
    if (registration.state === 'unknown') {
      return registration;
    }
    const checkout = await canonical(target.wtDir);
    const paths = await Promise.all(registration.paths.map(canonical));
    return {
      state: paths.includes(checkout) ? 'missing-checkout' : 'absent',
    };
  } catch {
    return { state: 'unknown' };
  }
}
async function repositoryState(record, target, fs) {
  try {
    const repository = await fs.stat(target.repoDir, { bigint: true });
    if (
      typeof repository.birthtimeNs !== 'bigint' ||
      repository.birthtimeNs <= 0n
    ) {
      return { state: 'unknown' };
    }
    if (
      (await fs.realpath(target.repoDir)) !== record.identity.repositoryPath ||
      !isDeepStrictEqual(fingerprint(repository), record.identity.repository)
    ) {
      return { state: 'conflict' };
    }
    return { state: 'original' };
  } catch {
    return { state: 'unknown' };
  }
}
async function checkoutPresence(target, fs) {
  try {
    const stat = await fs.lstat(target.wtDir);
    return stat.isSymbolicLink() || !stat.isDirectory()
      ? { state: 'conflict' }
      : { exists: true };
  } catch (error) {
    if (error.code !== 'ENOENT') {
      throw error;
    }
    return { exists: false };
  }
}
async function observeKnownCheckout(record, target, { fs, run }) {
  try {
    const repository = await repositoryState(record, target, fs);
    if (repository.state !== 'original') {
      return repository;
    }
    const canonical = (path) => canonicalPath(fs, path);
    if ((await canonical(target.wtDir)) !== record.identity.checkoutPath) {
      return { state: 'conflict' };
    }
    const checkout = await checkoutPresence(target, fs);
    if ('state' in checkout) {
      return checkout;
    }
    const registration = await worktreeRegistration(target, run);
    if (registration.state === 'unknown') {
      return registration;
    }
    const paths = await Promise.all(registration.paths.map(canonical));
    const registered = paths.includes(record.identity.checkoutPath);
    if (!checkout.exists && registered) {
      return { state: 'missing-checkout' };
    }
    if (!(checkout.exists || registered)) {
      try {
        await fs.lstat(record.identity.adminPath);
        return { state: 'unknown' };
      } catch (error) {
        return { state: error.code === 'ENOENT' ? 'absent' : 'unknown' };
      }
    }
    if (!registered) {
      return { state: 'conflict' };
    }
    const current = await inspectCheckoutIdentity(target, fs);
    return current.known
      ? {
          state: isDeepStrictEqual(current, record.identity)
            ? 'original'
            : 'conflict',
        }
      : { state: 'unknown' };
  } catch {
    return { state: 'unknown' };
  }
}

// biome-ignore lint/suspicious/useAwait: The exported observer preserves its Promise rejection boundary for callers that await identity observation.
export async function observeRemovalCheckout(record, target, dependencies) {
  if (absentIdentity(record.identity)) {
    return observeAbsentCheckout(record, target, dependencies);
  }
  return observeKnownCheckout(record, target, dependencies);
}

export function validateRemovalRecords(records) {
  if (!object(records)) {
    throw problem('STATE_CORRUPT', 'Removal recovery state is invalid');
  }
  const keys = new Set();
  for (const [id, row] of Object.entries(records)) {
    if (
      !object(row) ||
      row.version !== 1 ||
      row.operationId !== id ||
      !uuid(id) ||
      row.key !== `${row.repo}/${row.name}` ||
      typeof row.repo !== 'string' ||
      typeof row.name !== 'string' ||
      !row.repo ||
      !row.name ||
      row.repo.includes('/') ||
      [...row.repo.split('/'), ...row.name.split('/')].some(
        (part) =>
          !part ||
          part === '.' ||
          part === '..' ||
          part.startsWith('-') ||
          unsafeWorktreePartPattern.test(part)
      ) ||
      !Number.isInteger(row.port) ||
      row.port < 1 ||
      row.port > 65_535 ||
      !(identityValid(row.identity) || absentIdentity(row.identity)) ||
      !object(row.archive) ||
      row.archive.repo !== row.repo ||
      row.archive.name !== row.name ||
      typeof row.archive.branch !== 'string' ||
      !Number.isFinite(row.archive.removedAt) ||
      !Number.isFinite(row.createdAt) ||
      !Array.isArray(row.completed) ||
      row.completed.some((stage, index) => stage !== stages[index]) ||
      (row.attempting !== null &&
        row.attempting !== stages[row.completed.length]) ||
      (row.completed.includes('git') && row.removed !== true) ||
      ![false, true, null].includes(row.removed) ||
      keys.has(row.key)
    ) {
      throw problem(
        'STATE_CORRUPT',
        'Removal recovery record is invalid; no cleanup was attempted'
      );
    }
    keys.add(row.key);
  }
  return records;
}

export function createRemovalController({
  state,
  now,
  randomId,
  admit,
  serialize,
  capture,
  observe,
  assertClean,
  removeVolumes,
  detachTunnel,
  removeGit,
  cleanupRouting,
}) {
  const inFlight = new Map();
  function installed(result) {
    if (!result.reconciled) {
      throw Object.assign(
        problem(
          'STATE_RECONCILIATION_REQUIRED',
          'Installed removal state could not be reconciled'
        ),
        { committed: result.committed }
      );
    }
    return result.value;
  }
  const pendingSteps = (record) => [
    ...stages.filter((stage) => !record.completed.includes(stage)),
    'finalize',
  ];
  const done = (operationId) => ({
    completedStages: [...stages, 'finalize'],
    ok: true,
    operationId,
    pendingSteps: [],
    removed: true,
  });
  function stores() {
    return state.withWorkspace(['removals', 'archive'], (scope) => ({
      archive: scope.read('archive'),
      pending: validateRemovalRecords(scope.read('removals')),
    }));
  }
  function checkpoint(record, stage) {
    return mutate(record, (current) => ({
      ...current,
      attempting: null,
      completed: current.completed.includes(stage)
        ? current.completed
        : [...current.completed, stage],
      removed: stage === 'git' ? true : current.removed,
    }));
  }
  function mutate(record, change) {
    return state.withWorkspace(['removals'], (scope) => {
      const all = validateRemovalRecords(scope.read('removals'));
      const current = all[record.operationId];
      if (
        !current ||
        current.key !== record.key ||
        current.port !== record.port ||
        !isDeepStrictEqual(current.identity, record.identity)
      ) {
        throw problem(
          'REMOVAL_IDENTITY_CHANGED',
          'Removal recovery record changed'
        );
      }
      const next = change(current);
      validateRemovalRecords({ ...all, [record.operationId]: next });
      installed(
        scope.replace('removals', { ...all, [record.operationId]: next })
      );
      return next;
    });
  }
  async function prepare(target, reason, force) {
    const absent = {
      archive: {
        branch: target.name,
        label: target.repo,
        name: target.name,
        reason: reason === 'merged' ? 'merged' : 'manual',
        removedAt: now(),
        repo: target.repo,
      },
      attempting: null,
      completed: ['stop', 'volumes', 'tunnel', 'git'],
      createdAt: now(),
      identity: { absent: true },
      key: target.key,
      name: target.name,
      operationId: randomId(),
      port: target.port,
      removed: true,
      repo: target.repo,
      version: 1,
    };
    if ((await observe(absent)).state === 'absent') {
      return installPrepared(target, absent);
    }
    await assertClean(target, force);
    const details = await capture(target, reason);
    if (!identityValid(details.identity)) {
      throw problem(
        'REMOVAL_IDENTITY_UNKNOWN',
        'Checkout incarnation cannot be established; removal is blocked'
      );
    }
    const record = {
      archive: details.archive,
      attempting: null,
      completed: [],
      createdAt: now(),
      identity: details.identity,
      key: target.key,
      name: target.name,
      operationId: randomId(),
      port: target.port,
      removed: false,
      repo: target.repo,
      version: 1,
    };
    return installPrepared(target, record);
  }
  function installPrepared(target, record) {
    return state.withWorkspace(['removals', 'ports'], (scope) => {
      const all = validateRemovalRecords(scope.read('removals'));
      const existing = Object.values(all).find((row) => row.key === target.key);
      if (existing) {
        return existing;
      }
      if (
        !scope
          .read('ports')
          .some((row) => row.key === target.key && row.port === target.port)
      ) {
        throw problem(
          'REMOVAL_IDENTITY_CHANGED',
          'Worktree registration changed before removal'
        );
      }
      validateRemovalRecords({ ...all, [record.operationId]: record });
      try {
        installed(
          scope.replace('removals', { ...all, [record.operationId]: record })
        );
      } catch (error) {
        if (error.committed) {
          error.preparedRecord = record;
        }
        throw error;
      }
      return record;
    });
  }
  async function assertOriginal(record) {
    const observation = await observe(record);
    if (observation.state !== 'original') {
      throw problem(
        observation.state === 'conflict'
          ? 'REMOVAL_IDENTITY_CHANGED'
          : 'REMOVAL_OUTCOME_UNKNOWN',
        'Checkout identity or Git registration is not the original known state'
      );
    }
  }
  async function assertAbsent(record) {
    const observation = await observe(record);
    if (observation.state !== 'absent') {
      throw problem(
        observation.state === 'original' || observation.state === 'conflict'
          ? 'REMOVAL_IDENTITY_CHANGED'
          : 'REMOVAL_OUTCOME_UNKNOWN',
        'Checkout absence changed before cleanup; no replacement will be modified'
      );
    }
  }
  async function initialRemoval(target, { force, operationId }) {
    if (typeof force !== 'boolean') {
      throw problem('INVALID_FORCE', 'force must be a boolean');
    }
    if (operationId !== undefined && !uuid(operationId)) {
      throw problem(
        'REMOVAL_NOT_FOUND',
        'Unknown or expired removal operation; no new removal was started'
      );
    }
    const saved = await stores();
    const record = operationId
      ? saved.pending[operationId]
      : Object.values(saved.pending).find((row) => row.key === target.key);
    if (!record && operationId) {
      const archived = saved.archive.find(
        (row) => row.operationId === operationId && row.removalComplete === true
      );
      if (archived && `${archived.repo}/${archived.name}` === target.key) {
        return { outcome: done(operationId) };
      }
      throw problem(
        'REMOVAL_NOT_FOUND',
        'Unknown or expired removal operation; no new removal was started'
      );
    }
    return { record };
  }
  async function admittedRemoval(
    existingRecord,
    target,
    reason,
    force,
    progress
  ) {
    let record = existingRecord;
    if (record) {
      const latest = await stores();
      const current = latest.pending[record.operationId];
      if (!current) {
        if (
          latest.archive.some(
            (row) =>
              row.operationId === record.operationId &&
              row.removalComplete === true
          )
        ) {
          return { outcome: done(record.operationId) };
        }
        throw problem(
          'REMOVAL_NOT_FOUND',
          'Removal recovery state changed while waiting for admission'
        );
      }
      record = current;
    }
    record ??= await prepare(target, reason, force);
    progress.record = record;
    let { removed } = record;
    progress.removed = removed;
    const observation = await observe(record);
    removed = removalStateAfterObservation(record, observation);
    progress.removed = removed;
    if (observation.state === 'conflict') {
      throw problem(
        'REMOVAL_IDENTITY_CHANGED',
        'A replacement checkout or registration exists; cleanup is blocked'
      );
    }
    if (observation.state === 'missing-checkout') {
      throw problem(
        'REMOVAL_OUTCOME_UNKNOWN',
        'Checkout is absent but Git registration remains; diagnosed repair is required'
      );
    }
    if (!['original', 'absent'].includes(observation.state)) {
      throw problem(
        'REMOVAL_OUTCOME_UNKNOWN',
        'Removal outcome is unknown; retry only this operation after checking its state'
      );
    }
    return { observation, record, removed };
  }
  async function stageEffect(stage, record, controls) {
    if (stage === 'volumes') {
      return removeVolumes(record);
    }
    if (stage === 'tunnel') {
      return detachTunnel(record);
    }
    const result = await controls.stop();
    if (!result.ok) {
      throw problem(
        result.code ?? 'STOP_FAILED',
        result.error ?? 'Runtime stop failed'
      );
    }
  }
  async function completeTeardown(
    initialRecord,
    controls,
    requireOriginal,
    progress
  ) {
    let record = initialRecord;
    for (const stage of ['stop', 'volumes', 'tunnel']) {
      if (record.completed.includes(stage)) {
        continue;
      }
      if (requireOriginal) {
        // biome-ignore lint/performance/noAwaitInLoops: Re-observe the checkout before every irreversible stage; each checkpoint becomes the next stage's input.
        await assertOriginal(record);
      }
      record = await mutate(record, (current) => ({
        ...current,
        attempting: stage,
      }));
      progress.record = record;
      await stageEffect(stage, record, controls);
      record = await checkpoint(record, stage);
      progress.record = record;
    }
    return record;
  }
  async function completeGitRemoval(initialRecord, target, force, progress) {
    let record = initialRecord;
    await assertOriginal(record);
    await assertClean(target, force);
    record = await mutate(record, (current) => ({
      ...current,
      attempting: 'git',
    }));
    progress.record = record;
    try {
      await removeGit(record, force);
    } catch (error) {
      if (error.code === 'OPERATION_UNKNOWN') {
        progress.removed = null;
        throw error;
      }
      const afterFailure = await observe(record);
      if (afterFailure.state !== 'absent') {
        progress.removed = afterFailure.state === 'original' ? false : null;
        throw error;
      }
    }
    const after = await observe(record);
    if (after.state !== 'absent') {
      progress.removed = after.state === 'original' ? false : null;
      throw problem(
        'REMOVAL_OUTCOME_UNKNOWN',
        'Git deletion could not be confirmed'
      );
    }
    progress.removed = true;
    record = await checkpoint(record, 'git');
    progress.record = record;
    return record;
  }
  async function finishRemoval(initialRecord, progress) {
    let record = initialRecord;
    if (!record.completed.includes('archive')) {
      await assertAbsent(record);
      await writeArchive(record, false);
      record = await checkpoint(record, 'archive');
      progress.record = record;
    }
    if (!record.completed.includes('registry')) {
      await assertAbsent(record);
      await state.withWorkspace(['ports', 'removals'], (scope) => {
        const pendingRecords = validateRemovalRecords(scope.read('removals'));
        if (!pendingRecords[record.operationId]) {
          throw problem(
            'REMOVAL_IDENTITY_CHANGED',
            'Recovery record disappeared before registry cleanup'
          );
        }
        const ports = scope.read('ports');
        const portEntry = ports.find((row) => row.key === record.key);
        if (portEntry && portEntry.port !== record.port) {
          throw problem(
            'REMOVAL_IDENTITY_CHANGED',
            'Port registration belongs to a replacement'
          );
        }
        installed(
          scope.replace(
            'ports',
            ports.filter((row) => row.key !== record.key)
          )
        );
      });
      record = await checkpoint(record, 'registry');
      progress.record = record;
    }
    if (!record.completed.includes('routing')) {
      await assertAbsent(record);
      const result = await cleanupRouting(record);
      if (result === false) {
        throw problem(
          'ROUTING_FAILED',
          'Routing reload failed; the original port remains reserved'
        );
      }
      record = await checkpoint(record, 'routing');
      progress.record = record;
    }
    await assertAbsent(record);
    await writeArchive(record, true);
    await state.withWorkspace(['removals', 'archive'], (scope) => {
      const all = validateRemovalRecords(scope.read('removals'));
      if (
        !scope
          .read('archive')
          .some(
            (row) =>
              row.operationId === record.operationId &&
              row.removalComplete === true
          )
      ) {
        throw problem(
          'REMOVAL_INCOMPLETE',
          'Final archive completion is not confirmed'
        );
      }
      const { [record.operationId]: cleared, ...remaining } = all;
      installed(scope.replace('removals', remaining));
    });
    return done(record.operationId);
  }
  async function runAdmittedRemoval(progress, target, reason, force, controls) {
    const admitted = await admittedRemoval(
      progress.record,
      target,
      reason,
      force,
      progress
    );
    if ('outcome' in admitted) {
      return admitted.outcome;
    }
    let { record, observation } = admitted;
    if (observation.state === 'absent') {
      progress.removed = true;
      record = await completeTeardown(record, controls, false, progress);
      if (!record.completed.includes('git')) {
        record = await checkpoint(record, 'git');
        progress.record = record;
      }
    } else if (record.completed.includes('git')) {
      throw problem(
        'REMOVAL_IDENTITY_CHANGED',
        'A checkout exists after confirmed removal; cleanup is blocked'
      );
    }
    if (!record.completed.includes('git')) {
      await assertClean(target, force);
      record = await completeTeardown(record, controls, true, progress);
      record = await completeGitRemoval(record, target, force, progress);
    }
    return finishRemoval(record, progress);
  }
  async function execute(
    target,
    { operationId, force = false, reason = 'manual' } = {}
  ) {
    let record,
      removed = false;
    try {
      const initial = await initialRemoval(target, { force, operationId });
      if ('outcome' in initial) {
        return initial.outcome;
      }
      ({ record } = initial);
      if (record && record.key !== target.key) {
        throw problem(
          'REMOVAL_IDENTITY_CHANGED',
          'Removal operation belongs to a different worktree'
        );
      }
      if (record) {
        removed = removalState(record);
      }
      const outcome = await serialize(() =>
        admit(target, async (controls) => {
          const progress = { record, removed };
          try {
            const result = await runAdmittedRemoval(
              progress,
              target,
              reason,
              force,
              controls
            );
            ({ record, removed } = progress);
            return result;
          } catch (error) {
            ({ record, removed } = progress);
            if (error.code === 'OPERATION_UNKNOWN') {
              throw error;
            }
            return failed(error);
          }
        })
      );
      return outcome?.ok === false && !('removed' in outcome)
        ? failed(
            Object.assign(
              problem(outcome.code ?? 'REMOVAL_FAILED', outcome.error),
              outcome
            )
          )
        : outcome;
    } catch (error) {
      return failed(error);
    }
    function failed(error) {
      record ??= error.preparedRecord;
      const code = removalFailureCode(error, removed);
      return {
        code,
        error: `${removed === true ? 'Worktree removed; cleanup remains. ' : ''}${error.message ?? error}`,
        ok: false,
        removed,
        ...(record
          ? {
              completedStages: [...record.completed],
              operationId: record.operationId,
              pendingSteps: pendingSteps(record),
            }
          : {}),
        ...(typeof error.committed === 'boolean'
          ? { committed: error.committed }
          : {}),
        ...(error.phase ? { phase: error.phase } : {}),
        ...(error.causeCode || error.code === 'OPERATION_UNKNOWN'
          ? { causeCode: error.causeCode ?? error.code }
          : {}),
      };
    }
  }
  function writeArchive(record, complete) {
    return state.withWorkspace(['archive', 'removals'], (scope) => {
      if (!validateRemovalRecords(scope.read('removals'))[record.operationId]) {
        throw problem('REMOVAL_IDENTITY_CHANGED', 'Recovery record is missing');
      }
      const rows = scope.read('archive'),
        existing = rows.find((row) => row.operationId === record.operationId);
      const next = {
        ...record.archive,
        ...existing,
        operationId: record.operationId,
        ...(complete ? { completedAt: now(), removalComplete: true } : {}),
      };
      const updated = existing
        ? rows.map((row) =>
            row.operationId === record.operationId ? next : row
          )
        : [...rows, next];
      installed(scope.replace('archive', updated.slice(-500)));
    });
  }
  function remove(target, options = {}) {
    const current = inFlight.get(target.key);
    if (current) {
      if (options.operationId !== undefined) {
        const record = validateRemovalRecords(state.read('removals'))[
          options.operationId
        ];
        if (!record || record.key !== target.key) {
          return Promise.resolve({
            code: 'REMOVAL_NOT_FOUND',
            error:
              'Unknown or expired removal operation; no new removal was started',
            ok: false,
            removed: false,
          });
        }
      }
      return current;
    }
    const promise = execute(target, options).finally(() => {
      if (inFlight.get(target.key) === promise) {
        inFlight.delete(target.key);
      }
    });
    inFlight.set(target.key, promise);
    return promise;
  }
  function pending() {
    return Object.values(validateRemovalRecords(state.read('removals'))).map(
      (row) => ({
        completedStages: [...row.completed],
        name: row.name,
        operationId: row.operationId,
        pendingSteps: pendingSteps(row),
        removed: removalState(row),
        repo: row.repo,
      })
    );
  }
  async function cancelPending(operationId) {
    if (!uuid(operationId)) {
      return {
        code: 'REMOVAL_NOT_FOUND',
        error: 'Unknown or expired removal operation',
        ok: false,
      };
    }
    const record = validateRemovalRecords(state.read('removals'))[operationId];
    if (!record) {
      return {
        code: 'REMOVAL_NOT_FOUND',
        error: 'Unknown or expired removal operation',
        ok: false,
      };
    }
    if (inFlight.has(record.key)) {
      return {
        code: 'REMOVAL_IN_FLIGHT',
        error: 'Removal is still in flight and cannot be cancelled',
        ok: false,
      };
    }
    const observation = await observe(record);
    if (observation.state !== 'original') {
      return {
        code: 'REMOVAL_NOT_CANCELLABLE',
        error:
          'Removal cannot be cancelled after checkout removal or an unknown outcome',
        ok: false,
      };
    }
    await state.withWorkspace(['removals', 'ports'], (scope) => {
      const all = validateRemovalRecords(scope.read('removals'));
      if (!isDeepStrictEqual(all[operationId], record)) {
        throw problem(
          'REMOVAL_IDENTITY_CHANGED',
          'Removal changed before cancellation'
        );
      }
      const { [operationId]: discarded, ...remaining } = all;
      installed(scope.replace('removals', remaining));
    });
    return { ok: true };
  }
  async function cancel(operationId) {
    try {
      return await cancelPending(operationId);
    } catch (error) {
      return {
        code: error.code ?? 'REMOVAL_CANCEL_FAILED',
        error: error.message ?? String(error),
        ok: false,
      };
    }
  }
  async function assertCanMutate(target, { kind } = {}) {
    const all = validateRemovalRecords(state.read('removals'));
    const record = Object.values(all).find((row) =>
      kind === 'project-setup'
        ? row.repo === target.repo
        : row.key === target.key
    );
    if (!record) {
      return;
    }
    const prepareOnly =
      record.completed.every((stage) => stage === 'stop') &&
      [null, 'stop'].includes(record.attempting);
    if (kind !== 'start' || !prepareOnly || inFlight.has(target.key)) {
      throw problem(
        'REMOVAL_PENDING',
        'This worktree has pending removal cleanup; retry that operation first'
      );
    }
    await assertOriginal(record);
    await state.withWorkspace(['removals', 'ports'], (scope) => {
      const fresh = validateRemovalRecords(scope.read('removals'));
      if (
        !(
          isDeepStrictEqual(fresh[record.operationId], record) &&
          scope
            .read('ports')
            .some((row) => row.key === record.key && row.port === record.port)
        )
      ) {
        throw problem(
          'REMOVAL_IDENTITY_CHANGED',
          'Removal preparation changed before Start'
        );
      }
      const { [record.operationId]: abandoned, ...remaining } = fresh;
      installed(scope.replace('removals', remaining));
    });
  }
  return Object.freeze({ assertCanMutate, cancel, pending, remove });
}
