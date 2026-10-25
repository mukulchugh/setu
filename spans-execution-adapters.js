import { execFile } from 'node:child_process';
import fsPromises from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import { promisify, types } from 'node:util';
import { inspectCheckoutIdentity } from './checkout-identity.js';
import { inspectDependencyReadiness } from './dependency-readiness.js';
import { dependencySharingForTarget } from './dependency-sharing.js';
import { createSetupProgress } from './setup-progress.js';
import { inspectSpansCapacity } from './spans-capacity.js';
import {
  canonicalJson,
  exactRequest,
  isRecord,
} from './spans-execution-core.js';
import { createWorkspaceState } from './workspace-state.js';
import {
  checkWriter,
  claimWriter,
  releaseWriter,
  writerBaseline,
} from './writer-claims.js';

// Real adapters for the Spans dispatch coordinator. Each one reads or changes
// an existing Setu owner (checkout identity, setup progress, writer claims,
// archive capacity) and reports what it saw. None of them reports success for
// something it could not observe: an unknown answer is a failure, never a
// default.

const execFileAsync = promisify(execFile);
const GIT_ENV_KEYS = [
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_COMMON_DIR',
  'GIT_INDEX_FILE',
];
const HEAD_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const WRITER_HELD = /^Worktree held by /;
const DIGEST_PATTERN = /^[a-f0-9]{64}$/;
const DECIMAL_PATTERN = /^(0|[1-9][0-9]*)$/;
const SAFE_CODE_PATTERN = /^[A-Z][A-Z0-9_]{0,95}$/;
const DEPENDENCY_REFUSAL = 'Dependency readiness could not be established';
const DEPENDENCY_OPTIONS = [
  'bunVersion',
  'resourcePaths',
  'setupProgress',
  'state',
];
const SETUP_ADAPTER_OPTIONS = [
  'dependencyAdapter',
  'resourcePaths',
  'setupProgress',
  'state',
];
const CHECKOUT_IDENTITY_KEYS = [
  'admin',
  'adminPath',
  'checkout',
  'checkoutPath',
  'known',
  'repository',
  'repositoryPath',
];
const CHECKOUT_STAT_KEYS = ['birthtimeNs', 'dev', 'ino'];

async function gitText(dir, args) {
  const env = { ...process.env };
  for (const key of GIT_ENV_KEYS) {
    delete env[key];
  }
  const { stdout } = await execFileAsync(
    'git',
    ['--no-optional-locks', '-C', dir, ...args],
    { encoding: 'utf8', env, maxBuffer: 16 * 1024 * 1024, timeout: 10_000 }
  );
  return stdout;
}

export function createCheckoutAdapter({
  baseline = writerBaseline,
  fs = fsPromises,
  head = async (dir) =>
    (await gitText(dir, ['rev-parse', '--verify', 'HEAD'])).trim(),
  identity = inspectCheckoutIdentity,
} = {}) {
  return {
    async observe({ repoDir, wtDir }) {
      try {
        const checkoutIdentity = await identity({ repoDir, wtDir }, fs);
        const observedHead = await head(wtDir);
        if (
          !(checkoutIdentity?.known === true && HEAD_PATTERN.test(observedHead))
        ) {
          return { ok: false };
        }
        return {
          dirty: baseline(wtDir),
          head: observedHead,
          identity: checkoutIdentity,
          ok: true,
        };
      } catch {
        return { ok: false };
      }
    },
  };
}

function snapshotArray(value, budget, depth) {
  if (
    Object.getPrototypeOf(value) !== Array.prototype ||
    value.length > 10_000
  ) {
    return null;
  }
  const keys = Reflect.ownKeys(value);
  if (keys.length !== value.length + 1 || !keys.includes('length')) {
    return null;
  }
  const result = [];
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!(descriptor && 'value' in descriptor && descriptor.enumerable)) {
      return null;
    }
    const copied = snapshotData(descriptor.value, budget, depth + 1);
    if (copied === null && descriptor.value !== null) {
      return null;
    }
    result.push(copied);
  }
  return result;
}

function snapshotObject(value, budget, depth) {
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    return null;
  }
  const keys = Reflect.ownKeys(value);
  if (keys.some((key) => typeof key !== 'string')) {
    return null;
  }
  const result = {};
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!(descriptor && 'value' in descriptor && descriptor.enumerable)) {
      return null;
    }
    const copied = snapshotData(descriptor.value, budget, depth + 1);
    if (copied === null && descriptor.value !== null) {
      return null;
    }
    Object.defineProperty(result, key, {
      configurable: true,
      enumerable: true,
      value: copied,
      writable: true,
    });
  }
  return result;
}

function snapshotData(value, budget = { count: 0 }, depth = 0) {
  budget.count += 1;
  if (budget.count > 20_000 || depth > 32 || types.isProxy(value)) {
    return null;
  }
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'boolean'
  ) {
    return value;
  }
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null;
  }
  if (Array.isArray(value)) {
    return snapshotArray(value, budget, depth);
  }
  return typeof value === 'object'
    ? snapshotObject(value, budget, depth)
    : null;
}

function hasControlCharacter(value) {
  for (const character of value) {
    const code = character.codePointAt(0);
    if (code < 32 || code === 127) {
      return true;
    }
  }
  return false;
}

function exactOptions(input, allowed) {
  return input === undefined ? {} : exactRequest(input, [], allowed);
}

function exactTarget(value) {
  const target = exactRequest(value, ['repo', 'name']);
  if (!target) {
    return null;
  }
  return ['repo', 'name'].every(
    (key) =>
      typeof target[key] === 'string' &&
      target[key].length > 0 &&
      target[key].length <= 512 &&
      !hasControlCharacter(target[key])
  )
    ? target
    : null;
}

function exactCheckoutIdentity(value) {
  const identity = exactRequest(value, CHECKOUT_IDENTITY_KEYS);
  if (
    identity?.known !== true ||
    ![identity.checkoutPath, identity.repositoryPath, identity.adminPath].every(
      (path) =>
        typeof path === 'string' &&
        path.length > 0 &&
        path.length <= 4096 &&
        isAbsolute(path)
    )
  ) {
    return null;
  }
  const result = { ...identity };
  for (const key of ['admin', 'checkout', 'repository']) {
    const stat = exactRequest(identity[key], CHECKOUT_STAT_KEYS);
    if (
      !stat ||
      CHECKOUT_STAT_KEYS.some(
        (field) =>
          typeof stat[field] !== 'string' ||
          stat[field].length > 32 ||
          !DECIMAL_PATTERN.test(stat[field])
      )
    ) {
      return null;
    }
    result[key] = stat;
  }
  return result;
}

function normalizeReadinessRequest(input, optional = []) {
  const request = exactRequest(
    input,
    ['checkoutIdentity', 'target', 'wtDir'],
    optional
  );
  if (!request) {
    return null;
  }
  const target = exactTarget(request.target);
  const checkoutIdentity = exactCheckoutIdentity(request.checkoutIdentity);
  if (
    !(target && checkoutIdentity) ||
    typeof request.wtDir !== 'string' ||
    request.wtDir.length > 4096 ||
    !isAbsolute(request.wtDir)
  ) {
    return null;
  }
  return { checkoutIdentity, target, wtDir: request.wtDir };
}

function exactResourcePaths(value) {
  const paths = exactRequest(value, ['configPath', 'setuDir', 'workspaceRoot']);
  if (
    !paths ||
    Object.values(paths).some(
      (path) =>
        typeof path !== 'string' || !isAbsolute(path) || resolve(path) !== path
    )
  ) {
    return null;
  }
  return paths;
}

function ownMethod(value, name) {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    types.isProxy(value)
  ) {
    return null;
  }
  const descriptor = Object.getOwnPropertyDescriptor(value, name);
  return descriptor &&
    'value' in descriptor &&
    typeof descriptor.value === 'function'
    ? descriptor.value
    : null;
}

function createReadContext({
  resourcePaths,
  setupProgress: inputProgress,
  state: inputState,
}) {
  let state = inputState;
  if (state === undefined) {
    const paths = exactResourcePaths(resourcePaths);
    if (!paths) {
      return null;
    }
    try {
      state = createWorkspaceState(paths);
    } catch {
      return null;
    }
  }
  if (!ownMethod(state, 'read')) {
    return null;
  }
  let setupProgress = inputProgress;
  if (setupProgress === undefined) {
    try {
      setupProgress = createSetupProgress({ state });
    } catch {
      return null;
    }
  }
  if (!ownMethod(setupProgress, 'get')) {
    return null;
  }
  return { setupProgress, state };
}

function fixedRefusal(code, state) {
  const result = {
    code:
      typeof code === 'string' && SAFE_CODE_PATTERN.test(code)
        ? code
        : 'DEPENDENCY_READINESS_UNAVAILABLE',
    error: DEPENDENCY_REFUSAL,
    ok: false,
  };
  if (
    ['absent', 'running', 'unknown', 'failed', 'unverified'].includes(state)
  ) {
    result.state = state;
  }
  return result;
}

function readSetupRecord(setupProgress, target) {
  const get = ownMethod(setupProgress, 'get');
  if (!get) {
    return { code: 'SETUP_PROGRESS_UNAVAILABLE', ok: false, state: 'unknown' };
  }
  let raw;
  try {
    raw = get.call(setupProgress, target);
  } catch {
    return { code: 'SETUP_PROGRESS_UNAVAILABLE', ok: false, state: 'unknown' };
  }
  if (raw === null || raw === undefined) {
    return { code: 'SETUP_NOT_COMPLETED', ok: false, state: 'absent' };
  }
  const record = snapshotData(raw);
  if (!isRecord(record)) {
    return { code: 'SETUP_PROGRESS_CORRUPT', ok: false, state: 'unknown' };
  }
  if (record.ok === false) {
    return {
      code: 'SETUP_PROGRESS_UNAVAILABLE',
      ok: false,
      state: 'unknown',
    };
  }
  const recordTarget = exactTarget(record.target);
  if (!recordTarget || canonicalJson(recordTarget) !== canonicalJson(target)) {
    return { code: 'SETUP_PROGRESS_CORRUPT', ok: false, state: 'unknown' };
  }
  if (record.state === 'running') {
    return { code: 'SETUP_NOT_COMPLETED', ok: false, state: 'running' };
  }
  if (record.state === 'unknown') {
    return { code: 'OPERATION_UNKNOWN', ok: false, state: 'unknown' };
  }
  if (record.state === 'failed') {
    return { code: 'SETUP_NOT_COMPLETED', ok: false, state: 'failed' };
  }
  if (record.state !== 'completed' || record.outcome !== 'completed') {
    return { code: 'SETUP_PROGRESS_CORRUPT', ok: false, state: 'unknown' };
  }
  return { ok: true, record };
}

function readSelectedSharing(state, target) {
  const read = ownMethod(state, 'read');
  if (!read) {
    return { code: 'DEPENDENCY_SHARING_UNKNOWN', ok: false };
  }
  let raw;
  try {
    raw = read.call(state, 'config');
  } catch {
    return { code: 'DEPENDENCY_SHARING_UNKNOWN', ok: false };
  }
  const config = snapshotData(raw);
  if (!isRecord(config)) {
    return { code: 'DEPENDENCY_SHARING_UNKNOWN', ok: false };
  }
  let sharing;
  try {
    sharing = dependencySharingForTarget(config, target.repo, target.name);
  } catch {
    return { code: 'DEPENDENCY_SHARING_UNKNOWN', ok: false };
  }
  if (sharing === undefined) {
    return { ok: true, sharing: undefined };
  }
  const copied = snapshotData(sharing);
  return copied
    ? { ok: true, sharing: copied }
    : { code: 'DEPENDENCY_SHARING_UNKNOWN', ok: false };
}

function validReadinessProof(value, identityVersion = 1) {
  const proof = exactRequest(value, [
    'checkCurrent',
    'identity',
    'ok',
    'state',
  ]);
  if (
    proof?.ok !== true ||
    proof.state !== 'ready' ||
    typeof proof.checkCurrent !== 'function'
  ) {
    return null;
  }
  const identity = exactRequest(proof.identity, [
    'inputDigest',
    'receiptDigest',
    'version',
  ]);
  if (
    identity?.version !== identityVersion ||
    !DIGEST_PATTERN.test(identity.inputDigest) ||
    !DIGEST_PATTERN.test(identity.receiptDigest)
  ) {
    return null;
  }
  return { checkCurrent: proof.checkCurrent, identity };
}

function sameSetupReceipt(current, observed) {
  return (
    current.ok === true &&
    current.record.state === 'completed' &&
    current.record.outcome === 'completed' &&
    current.record.attemptId === observed.attemptId &&
    canonicalJson(current.record.checkoutIdentity) ===
      canonicalJson(observed.checkoutIdentity) &&
    canonicalJson(current.record.dependencyReceipt) ===
      canonicalJson(observed.dependencyReceipt)
  );
}

function makeCheckCurrent({
  context,
  coreCheckCurrent,
  observedRecord,
  request,
  selectedSharing,
}) {
  return () => {
    try {
      if (coreCheckCurrent() !== true) {
        return false;
      }
      const current = readSetupRecord(context.setupProgress, request.target);
      if (!sameSetupReceipt(current, observedRecord)) {
        return false;
      }
      const currentSharing = readSelectedSharing(context.state, request.target);
      return (
        currentSharing.ok === true &&
        canonicalJson(currentSharing.sharing ?? null) ===
          canonicalJson(selectedSharing ?? null)
      );
    } catch {
      return false;
    }
  };
}

async function inspectDependency({ context, bunVersion, request }) {
  const progress = readSetupRecord(context.setupProgress, request.target);
  if (!progress.ok) {
    return fixedRefusal(progress.code, progress.state);
  }
  if (
    canonicalJson(progress.record.checkoutIdentity) !==
    canonicalJson(request.checkoutIdentity)
  ) {
    return fixedRefusal('CHECKOUT_IDENTITY_MISMATCH', 'unknown');
  }
  const selected = readSelectedSharing(context.state, request.target);
  if (!selected.ok) {
    return fixedRefusal(selected.code, 'unknown');
  }
  let inspected;
  try {
    const enrolled = Object.hasOwn(
      progress.record.dependencyReceipt ?? {},
      'dependencyFiles'
    );
    const dependencyFiles = enrolled
      ? snapshotData(
          context.state.read('dependencyFiles')?.views?.[
            `${request.target.repo}/${request.target.name}`
          ]
        )
      : undefined;
    inspected = await inspectDependencyReadiness({
      bunVersion,
      checkoutIdentity: request.checkoutIdentity,
      dependencyFiles,
      record: progress.record,
      sharing: enrolled ? undefined : selected.sharing,
      state: context.state,
      wtDir: request.wtDir,
    });
  } catch {
    return fixedRefusal('DEPENDENCY_READINESS_UNAVAILABLE', 'unknown');
  }
  const proof = validReadinessProof(inspected);
  if (!proof) {
    const result = snapshotData(inspected);
    return fixedRefusal(
      isRecord(result) && typeof result.code === 'string'
        ? result.code
        : 'DEPENDENCY_CHECKPOINT_UNAVAILABLE',
      progress.record.dependencyReceipt === undefined ? 'unverified' : 'unknown'
    );
  }
  return {
    ok: true,
    progressRecord: progress.record,
    proof,
    sharing: selected.sharing,
  };
}

// A dependency binding names the Setu receipt and its inspected input set. The
// filesystem checkpoint stays private to this observation and is never stored.
export function createDependencyAdapter(options = {}) {
  const parsed = exactOptions(options, DEPENDENCY_OPTIONS);
  const context = parsed && createReadContext(parsed);
  const bunVersion = parsed?.bunVersion ?? Bun.version;
  const configured = Boolean(
    parsed &&
      context &&
      typeof bunVersion === 'string' &&
      bunVersion.length > 0 &&
      bunVersion.length <= 64
  );

  return {
    async observe(input) {
      const request = normalizeReadinessRequest(input);
      if (!request) {
        return fixedRefusal('DEPENDENCY_INPUTS_UNKNOWN', 'unknown');
      }
      if (!configured) {
        return fixedRefusal('DEPENDENCY_READINESS_UNAVAILABLE', 'unknown');
      }
      const inspected = await inspectDependency({
        bunVersion,
        context,
        request,
      });
      if (!inspected.ok) {
        return inspected;
      }
      const identity = Object.freeze({
        inputDigest: inspected.proof.identity.inputDigest,
        receiptDigest: inspected.proof.identity.receiptDigest,
        version: 2,
      });
      const checkCurrent = makeCheckCurrent({
        context,
        coreCheckCurrent: inspected.proof.checkCurrent,
        observedRecord: inspected.progressRecord,
        request,
        selectedSharing: inspected.sharing,
      });
      return { checkCurrent, identity, ok: true, state: 'ready' };
    },
  };
}

// Setup remains read-only here. Only the shared Setu readiness inspector can
// return ready, and its synchronous checkpoint is required by this adapter.
export function createSetupAdapter(options = {}) {
  const parsed = exactOptions(options, SETUP_ADAPTER_OPTIONS);
  if (!parsed) {
    return {
      ensure: async () =>
        fixedRefusal('DEPENDENCY_READINESS_UNAVAILABLE', 'unknown'),
    };
  }
  const dependencyAdapter =
    parsed.dependencyAdapter ?? createDependencyAdapter(parsed);
  const observe = ownMethod(dependencyAdapter, 'observe');
  if (!observe) {
    return {
      ensure: async () =>
        fixedRefusal('DEPENDENCY_READINESS_UNAVAILABLE', 'unknown'),
    };
  }
  return {
    async ensure(input) {
      const request = normalizeReadinessRequest(input, [
        'operationId',
        'repoDir',
        'session',
      ]);
      if (!request) {
        return fixedRefusal('DEPENDENCY_INPUTS_UNKNOWN', 'unknown');
      }
      let result;
      try {
        result = await observe.call(dependencyAdapter, request);
      } catch {
        return fixedRefusal('DEPENDENCY_READINESS_UNAVAILABLE', 'unknown');
      }
      const proof = validReadinessProof(result, 2);
      if (!proof) {
        const refusal = snapshotData(result);
        return fixedRefusal(
          isRecord(refusal) && typeof refusal.code === 'string'
            ? refusal.code
            : 'DEPENDENCY_CHECKPOINT_UNAVAILABLE',
          isRecord(refusal) ? refusal.state : 'unknown'
        );
      }
      return result;
    },
  };
}

export function createArchiveAdapter({ budgetBytes, root }) {
  return {
    capacity: () => inspectSpansCapacity({ budgetBytes, root }),
  };
}

// Reads the committed run view for the coordinator's fenced checks.
export function createRunStateAdapter({ store }) {
  return {
    read({ actionId, runId }) {
      const read = store.readRun({ runId });
      if (read?.ok !== true || !isRecord(read.view)) {
        return { ok: false };
      }
      const { view } = read;
      const action = isRecord(view.actions?.[actionId])
        ? view.actions[actionId]
        : null;
      const span =
        action && isRecord(view.spans?.[action.spanId])
          ? view.spans[action.spanId]
          : null;
      return {
        action,
        generation: read.generation,
        ok: true,
        planVersion: view.planVersion,
        span,
      };
    },
  };
}

function heldByAnother(error) {
  return WRITER_HELD.test(String(error?.message));
}

// Writer claims are cooperative coordination owned by writer-claims.js. The
// release is fenced to an accepted span here, at the effect: the committed
// run view must still show this exact acceptance before the claim file goes.
export function createWriterAdapter({
  check = checkWriter,
  claim = claimWriter,
  pid = process.pid,
  release = releaseWriter,
  store,
}) {
  function acceptedFor(binding) {
    const read = store.readRun({ runId: binding.runId });
    if (read?.ok !== true || read.generation !== binding.generation) {
      return false;
    }
    const span = read.view?.spans?.[binding.spanId];
    const action = read.view?.actions?.[binding.actionId];
    return (
      isRecord(span) &&
      isRecord(action) &&
      action.state === 'completed' &&
      span.state === 'completed' &&
      span.acceptedActionId === binding.actionId &&
      span.acceptedEvidenceId === binding.acceptedEvidenceId
    );
  }

  return {
    check({ checkoutPath, session }) {
      try {
        return check(checkoutPath, session);
      } catch {
        return { ok: false };
      }
    },
    claim({ checkoutPath, owner }) {
      try {
        return claim(checkoutPath, { ...owner, pid });
      } catch (error) {
        if (heldByAnother(error)) {
          return { code: 'WRITER_BUSY', ok: false };
        }
        throw error;
      }
    },
    release({ binding, checkoutPath, session }) {
      if (
        !acceptedFor(binding) ||
        binding.checkoutIdentity?.checkoutPath === undefined
      ) {
        return { code: 'ACCEPTANCE_PENDING', ok: false };
      }
      try {
        return release(checkoutPath, session);
      } catch {
        return { ok: false };
      }
    },
  };
}
