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
const uuid = (value) =>
  typeof value === 'string' &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
const object = (value) =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const evidence = (value) =>
  object(value) &&
  ['dev', 'ino', 'birthtimeNs'].every(
    (key) => typeof value[key] === 'string' && /^\d+$/.test(value[key])
  ) &&
  value.ino !== '0' &&
  value.birthtimeNs !== '0';
const identityValid = (value) =>
  value?.known === true &&
  ['checkoutPath', 'repositoryPath', 'adminPath'].every(
    (key) => typeof value[key] === 'string' && isAbsolute(value[key])
  ) &&
  ['checkout', 'repository', 'admin'].every((key) => evidence(value[key]));
function problem(code, message) {
  return Object.assign(new Error(message), { code });
}

export async function observeRemovalCheckout(record, target, { fs, run }) {
  const fingerprint = (stat) => ({
    birthtimeNs: String(stat.birthtimeNs),
    dev: String(stat.dev),
    ino: String(stat.ino),
  });
  async function canonical(path) {
    const suffix = [];
    while (true) {
      try {
        return resolve(await fs.realpath(path), ...suffix.reverse());
      } catch (error) {
        if (error.code !== 'ENOENT' || dirname(path) === path) {
          throw error;
        }
        suffix.push(basename(path));
        path = dirname(path);
      }
    }
  }
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
    if ((await canonical(target.wtDir)) !== record.identity.checkoutPath) {
      return { state: 'conflict' };
    }
    let exists = true;
    try {
      const stat = await fs.lstat(target.wtDir);
      if (stat.isSymbolicLink() || !stat.isDirectory()) {
        return { state: 'conflict' };
      }
    } catch (error) {
      if (error.code !== 'ENOENT') {
        throw error;
      }
      exists = false;
    }
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
    const paths = await Promise.all(
      list.stdout
        .split('\0')
        .filter((line) => line.startsWith('worktree '))
        .map((line) => canonical(line.slice(9)))
    );
    const registered = paths.includes(record.identity.checkoutPath);
    if (!exists && registered) {
      return { state: 'missing-checkout' };
    }
    if (!(exists || registered)) {
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
    if (!current.known) {
      return { state: 'unknown' };
    }
    return {
      state:
        isDeepStrictEqual(current, record.identity)
          ? 'original'
          : 'conflict',
    };
  } catch {
    return { state: 'unknown' };
  }
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
          /[\\\s:]/.test(part)
      ) ||
      !Number.isInteger(row.port) ||
      row.port < 1 ||
      row.port > 65_535 ||
      !identityValid(row.identity) ||
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
  async function stores() {
    return state.withWorkspace(['removals', 'archive'], (scope) => ({
      archive: scope.read('archive'),
      pending: validateRemovalRecords(scope.read('removals')),
    }));
  }
  async function checkpoint(record, stage) {
    return mutate(record, (current) => ({
      ...current,
      attempting: null,
      completed: current.completed.includes(stage)
        ? current.completed
        : [...current.completed, stage],
      removed: stage === 'git' ? true : current.removed,
    }));
  }
  async function mutate(record, change) {
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
  async function execute(
    target,
    { operationId, force = false, reason = 'manual' } = {}
  ) {
    let record,
      removed = false;
    try {
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
      record = operationId
        ? saved.pending[operationId]
        : Object.values(saved.pending).find((row) => row.key === target.key);
      if (!record && operationId) {
        const archived = saved.archive.find(
          (row) =>
            row.operationId === operationId && row.removalComplete === true
        );
        if (archived && `${archived.repo}/${archived.name}` === target.key) {
          return done(operationId);
        }
        throw problem(
          'REMOVAL_NOT_FOUND',
          'Unknown or expired removal operation; no new removal was started'
        );
      }
      if (record && record.key !== target.key) {
        throw problem(
          'REMOVAL_IDENTITY_CHANGED',
          'Removal operation belongs to a different worktree'
        );
      }
      if (record) {
        removed = record.completed.includes('git')
          ? true
          : record.attempting === 'git'
            ? null
            : false;
      }
      const outcome = await serialize(() =>
        admit(target, async (controls) => {
          try {
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
                  return done(record.operationId);
                }
                throw problem(
                  'REMOVAL_NOT_FOUND',
                  'Removal recovery state changed while waiting for admission'
                );
              }
              record = current;
            }
            record ??= await prepare(target, reason, force);
            removed = record.removed;
            const observation = await observe(record);
            removed = record.completed.includes('git')
              ? true
              : observation.state === 'original'
                ? false
                : observation.state === 'absent'
                  ? true
                  : null;
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
            if (observation.state === 'absent') {
              removed = true;
              if (
                !['stop', 'volumes', 'tunnel'].every((stage) =>
                  record.completed.includes(stage)
                )
              ) {
                throw problem(
                  'REMOVAL_INCOMPLETE',
                  'Checkout is gone but prior teardown is unconfirmed; diagnosed cleanup is required'
                );
              }
              if (!record.completed.includes('git')) {
                record = await checkpoint(record, 'git');
              }
            } else if (record.completed.includes('git')) {
              throw problem(
                'REMOVAL_IDENTITY_CHANGED',
                'A checkout exists after confirmed removal; cleanup is blocked'
              );
            }
            if (!record.completed.includes('git')) {
              await assertClean(target, force);
              for (const [stage, effect] of [
                [
                  'stop',
                  async () => {
                    const result = await controls.stop();
                    if (!result.ok) {
                      throw problem(
                        result.code ?? 'STOP_FAILED',
                        result.error ?? 'Runtime stop failed'
                      );
                    }
                  },
                ],
                ['volumes', () => removeVolumes(record)],
                ['tunnel', () => detachTunnel(record)],
              ]) {
                if (record.completed.includes(stage)) {
                  continue;
                }
                await assertOriginal(record);
                record = await mutate(record, (current) => ({
                  ...current,
                  attempting: stage,
                }));
                await effect();
                record = await checkpoint(record, stage);
              }
              await assertOriginal(record);
              await assertClean(target, force);
              record = await mutate(record, (current) => ({
                ...current,
                attempting: 'git',
              }));
              try {
                await removeGit(record, force);
              } catch (error) {
                if (error.code === 'OPERATION_UNKNOWN') {
                  removed = null;
                  throw error;
                }
                const after = await observe(record);
                if (after.state !== 'absent') {
                  removed = after.state === 'original' ? false : null;
                  throw error;
                }
              }
              const after = await observe(record);
              if (after.state !== 'absent') {
                removed = after.state === 'original' ? false : null;
                throw problem(
                  'REMOVAL_OUTCOME_UNKNOWN',
                  'Git deletion could not be confirmed'
                );
              }
              removed = true;
              record = await checkpoint(record, 'git');
            }
            if (!record.completed.includes('archive')) {
              await assertAbsent(record);
              await writeArchive(record, false);
              record = await checkpoint(record, 'archive');
            }
            if (!record.completed.includes('registry')) {
              await assertAbsent(record);
              await state.withWorkspace(['ports', 'removals'], (scope) => {
                const pending = validateRemovalRecords(scope.read('removals'));
                if (!pending[record.operationId]) {
                  throw problem(
                    'REMOVAL_IDENTITY_CHANGED',
                    'Recovery record disappeared before registry cleanup'
                  );
                }
                const ports = scope.read('ports'),
                  current = ports.find((row) => row.key === record.key);
                if (current && current.port !== record.port) {
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
          } catch (error) {
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
      const code =
        error.code === 'REMOVAL_IDENTITY_CHANGED'
          ? error.code
          : removed === null
            ? 'REMOVAL_OUTCOME_UNKNOWN'
            : removed === true
              ? 'REMOVAL_INCOMPLETE'
              : (error.code ?? 'REMOVAL_FAILED');
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
  async function writeArchive(record, complete) {
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
        removed: row.completed.includes('git')
          ? true
          : row.attempting === 'git'
            ? null
            : false,
        repo: row.repo,
      })
    );
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
        !isDeepStrictEqual(fresh[record.operationId], record) ||
        !scope
          .read('ports')
          .some((row) => row.key === record.key && row.port === record.port)
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
  return Object.freeze({ assertCanMutate, pending, remove });
}
