import { createHash } from 'node:crypto';
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  opendirSync,
  openSync,
  readSync,
  realpathSync,
} from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { types as utilTypes } from 'node:util';
import { observeProcessIdentity } from './process-observation.js';
import { redactSpansValue } from './spans-redaction.js';
import { openSpansStore } from './spans-store.js';
import {
  createSpansWorkerProcess,
  spansWorkerCapturePath,
} from './spans-worker-process.js';
import { createSpansWorkerSpool } from './spans-worker-spool.js';

const BINDING_FIELDS = Object.freeze([
  'actionId',
  'attemptId',
  'generation',
  'runId',
  'spanId',
  'workerId',
]);
const MAX_ID_LENGTH = 256;
const CAPTURE_DIRECTORY = /^swp-[a-f0-9]{48}$/;
const MAX_CAPTURE_DIRECTORIES = 4096;
const MAX_DESCRIPTOR_BYTES = 128 * 1024;
const NOFOLLOW = constants.O_NOFOLLOW ?? 0;
const isRecord = (value) =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const fail = (code, extra = {}) => ({ code, ok: false, ...extra });

function sameBinding(left, right) {
  return (
    isRecord(left) &&
    isRecord(right) &&
    Reflect.ownKeys(left).length === BINDING_FIELDS.length &&
    BINDING_FIELDS.every((field) => left[field] === right[field])
  );
}

function attemptDigest(binding) {
  return createHash('sha256')
    .update(
      JSON.stringify([
        'spans.worker.attempt',
        ...BINDING_FIELDS.map((field) => binding[field]),
      ])
    )
    .digest('hex');
}

function privateDirectory(path, canonical = false) {
  try {
    const stat = lstatSync(path);
    return (
      stat.isDirectory() &&
      !stat.isSymbolicLink() &&
      stat.mode % 0o1000 === 0o700 &&
      (typeof process.getuid !== 'function' || stat.uid === process.getuid()) &&
      (!canonical || realpathSync(path) === path)
    );
  } catch {
    return false;
  }
}

function readPrivateJson(path) {
  let descriptor;
  try {
    const before = lstatSync(path);
    if (
      !before.isFile() ||
      before.isSymbolicLink() ||
      before.nlink !== 1 ||
      before.mode % 0o1000 !== 0o600 ||
      before.size > MAX_DESCRIPTOR_BYTES ||
      (typeof process.getuid === 'function' && before.uid !== process.getuid())
    ) {
      return null;
    }
    descriptor = openSync(path, constants.O_RDONLY + NOFOLLOW);
    const opened = fstatSync(descriptor);
    if (
      !opened.isFile() ||
      opened.nlink !== 1 ||
      opened.ino !== before.ino ||
      opened.dev !== before.dev ||
      opened.size !== before.size ||
      opened.mode % 0o1000 !== 0o600 ||
      (typeof process.getuid === 'function' && opened.uid !== process.getuid())
    ) {
      return null;
    }
    const bytes = Buffer.alloc(MAX_DESCRIPTOR_BYTES + 1);
    let byteLength = 0;
    while (byteLength < bytes.byteLength) {
      const count = readSync(
        descriptor,
        bytes,
        byteLength,
        bytes.byteLength - byteLength,
        null
      );
      if (count === 0) {
        break;
      }
      byteLength += count;
    }
    const afterRead = fstatSync(descriptor);
    if (
      byteLength > MAX_DESCRIPTOR_BYTES ||
      byteLength !== opened.size ||
      afterRead.size !== opened.size ||
      afterRead.ino !== opened.ino ||
      afterRead.dev !== opened.dev ||
      afterRead.nlink !== 1 ||
      afterRead.mode % 0o1000 !== 0o600 ||
      (typeof process.getuid === 'function' &&
        afterRead.uid !== process.getuid())
    ) {
      return null;
    }
    return JSON.parse(bytes.subarray(0, byteLength).toString('utf8'));
  } catch {
    return null;
  } finally {
    if (descriptor !== undefined) {
      closeSync(descriptor);
    }
  }
}

function readAttempt(root, runId) {
  let store;
  try {
    store = openSpansStore({ readonly: true, root });
    return store.readRun({ runId });
  } catch {
    return null;
  } finally {
    if (store) {
      store.close();
    }
  }
}

function identityMatches(expected, observed) {
  return (
    isRecord(expected) &&
    Number.isSafeInteger(expected.pid) &&
    expected.pid > 0 &&
    typeof expected.id === 'string' &&
    observed?.state === 'alive' &&
    observed.processId === expected.pid &&
    expected.id === `${expected.pid}:${observed.processStartIdentity}`
  );
}

function descriptorMatches(descriptor, root, binding, directory) {
  return (
    isRecord(descriptor) &&
    descriptor.version === 2 &&
    descriptor.root === root &&
    sameBinding(descriptor.binding, binding) &&
    descriptor.controlDir === join(directory, 'control')
  );
}

function descriptorCandidate(tempRoot, name, root, binding) {
  if (!CAPTURE_DIRECTORY.test(name)) {
    return { kind: 'skip' };
  }
  const directory = join(tempRoot, name);
  if (!privateDirectory(directory)) {
    return { kind: 'unknown' };
  }
  const descriptorPath = join(directory, 'capture.json');
  try {
    lstatSync(descriptorPath);
  } catch (error) {
    return error.code === 'ENOENT' ? { kind: 'skip' } : { kind: 'unknown' };
  }
  const descriptor = readPrivateJson(descriptorPath);
  if (descriptor === null) {
    return { kind: 'unknown' };
  }
  return descriptorMatches(descriptor, root, binding, directory)
    ? { descriptorPath, kind: 'match' }
    : { kind: 'skip' };
}

function findDescriptor(tempRoot, root, binding) {
  if (!privateDirectory(tempRoot, true)) {
    return {
      ok: false,
      result: fail('CAPTURE_ROOT_UNSAFE', { unknown: true }),
    };
  }
  const directPath = spansWorkerCapturePath({ binding, root, tempRoot });
  const directoryName = basename(dirname(directPath));
  try {
    lstatSync(dirname(directPath));
    const direct = descriptorCandidate(tempRoot, directoryName, root, binding);
    return direct.kind === 'match'
      ? { descriptorPath: direct.descriptorPath, ok: true }
      : {
          ok: false,
          result: fail('CAPTURE_DESCRIPTOR_UNKNOWN', { unknown: true }),
        };
  } catch (error) {
    if (error.code !== 'ENOENT') {
      return {
        ok: false,
        result: fail('CAPTURE_DESCRIPTOR_UNKNOWN', { unknown: true }),
      };
    }
  }
  // Older captures used random directory names. Keep their bounded recovery
  // path without making new attempts scan unrelated retained captures.
  let directory;
  try {
    directory = opendirSync(tempRoot);
  } catch {
    return {
      ok: false,
      result: fail('CAPTURE_ROOT_UNKNOWN', { unknown: true }),
    };
  }
  const matching = [];
  let failure = null;
  let scanned = 0;
  try {
    let entry = directory.readSync();
    while (entry !== null) {
      scanned += 1;
      if (scanned > MAX_CAPTURE_DIRECTORIES) {
        failure = 'CAPTURE_ROOT_LIMIT';
        break;
      }
      const candidate = descriptorCandidate(
        tempRoot,
        entry.name,
        root,
        binding
      );
      if (candidate.kind === 'unknown') {
        failure = 'CAPTURE_DESCRIPTOR_UNKNOWN';
        break;
      }
      if (candidate.kind === 'match') {
        matching.push(candidate.descriptorPath);
      }
      entry = directory.readSync();
    }
  } catch {
    failure = 'CAPTURE_ROOT_UNKNOWN';
  }
  try {
    directory.closeSync();
  } catch {
    failure ??= 'CAPTURE_ROOT_UNKNOWN';
  }
  if (failure) {
    return {
      ok: false,
      result: fail(failure, { unknown: true }),
    };
  }
  if (matching.length !== 1) {
    return {
      ok: false,
      result: fail(
        matching.length === 0
          ? 'RECONNECT_DESCRIPTOR_NOT_FOUND'
          : 'RECONNECT_DESCRIPTOR_AMBIGUOUS',
        { unknown: true }
      ),
    };
  }
  return { descriptorPath: matching[0], ok: true };
}

/**
 * Compose path-free restart recovery for the detached worker process adapter.
 * `root` is the exact existing archive/spool root. `tempRoot` is the same
 * private capture directory supplied to the worker process adapter at launch.
 * The random descriptor directory is found by its persisted exact binding;
 * callers never supply or persist a claimed descriptor path.
 * The returned `start` takes the worker-process start DTO; `reconnect` takes
 * only `{ runId, attemptId, generation }` from the durable attempt record.
 */
export function createSpansWorkerReconnect({
  authorize,
  childPath,
  observeProcess = observeProcessIdentity,
  root,
  spawn,
  tempRoot,
  transportTimeoutMs,
} = {}) {
  if (
    typeof root !== 'string' ||
    !root.startsWith('/') ||
    root.includes('\0') ||
    resolve(root) !== root ||
    !privateDirectory(root, true) ||
    typeof tempRoot !== 'string' ||
    !tempRoot.startsWith('/') ||
    tempRoot.includes('\0') ||
    resolve(tempRoot) !== tempRoot ||
    !privateDirectory(tempRoot, true) ||
    typeof authorize !== 'function' ||
    typeof observeProcess !== 'function' ||
    !Number.isSafeInteger(transportTimeoutMs) ||
    transportTimeoutMs < 1
  ) {
    throw new TypeError(
      'A canonical archive root, private capture root, authorizer, process observer, and transport timeout are required.'
    );
  }
  const processAdapter = createSpansWorkerProcess({
    authorize,
    childPath,
    observeProcess,
    root,
    spawn,
    tempRoot,
    transportTimeoutMs,
  });
  const spool = createSpansWorkerSpool({ root });

  function loadCurrent(runId, attemptId, generation) {
    const archive = readAttempt(root, runId);
    if (!archive?.ok || archive.generation !== generation) {
      return {
        ok: false,
        result: fail('RECONNECT_AUTHORITY_UNKNOWN', { unknown: true }),
      };
    }
    const attempt = archive.view?.attempts?.[attemptId];
    if (!isRecord(attempt)) {
      return {
        ok: false,
        result: fail('RECONNECT_ATTEMPT_UNKNOWN', { unknown: true }),
      };
    }
    const binding = {
      actionId: attempt.actionId,
      attemptId,
      generation: attempt.generation,
      runId,
      spanId: attempt.spanId,
      workerId: attempt.workerId,
    };
    if (
      !validBinding(binding) ||
      attempt.generation !== generation ||
      attempt.attemptDigest !== attemptDigest(binding)
    ) {
      return {
        ok: false,
        result: fail('RECONNECT_BINDING_MISMATCH', { unknown: true }),
      };
    }
    if (attempt.status !== 'running') {
      return {
        ok: false,
        result: fail('RECONNECT_ATTEMPT_NOT_RUNNING', { unknown: true }),
      };
    }
    if (!validProcessStart(attempt.processStart)) {
      return {
        ok: false,
        result: fail('RECONNECT_PROCESS_IDENTITY_UNKNOWN', { unknown: true }),
      };
    }
    return { attempt, binding, ok: true };
  }

  function validBinding(binding) {
    return BINDING_FIELDS.every((field) => {
      if (field === 'generation') {
        return (
          Number.isSafeInteger(binding.generation) && binding.generation >= 0
        );
      }
      return isExplicitId(binding[field]) && !holdsSecret(binding[field]);
    });
  }

  function isExplicitId(value) {
    if (
      typeof value !== 'string' ||
      value.length === 0 ||
      value.length > MAX_ID_LENGTH ||
      value.trim() !== value ||
      value === '__proto__'
    ) {
      return false;
    }
    for (let index = 0; index < value.length; index += 1) {
      const code = value.charCodeAt(index);
      if (code < 32 || code === 127) {
        return false;
      }
    }
    return true;
  }

  function holdsSecret(value) {
    return (
      redactSpansValue(value) !== value ||
      redactSpansValue({ [value]: 0 })[value] !== 0
    );
  }

  function normalizeReconnectInput(input) {
    try {
      if (!isRecord(input) || utilTypes.isProxy(input)) {
        return null;
      }
      const keys = Reflect.ownKeys(input);
      const allowed = ['attemptId', 'generation', 'runId'];
      if (
        keys.length !== allowed.length ||
        keys.some((key) => !allowed.includes(key))
      ) {
        return null;
      }
      const request = {};
      for (const key of allowed) {
        const descriptor = Object.getOwnPropertyDescriptor(input, key);
        if (!(descriptor?.enumerable && Object.hasOwn(descriptor, 'value'))) {
          return null;
        }
        request[key] = descriptor.value;
      }
      return isExplicitId(request.runId) &&
        !holdsSecret(request.runId) &&
        isExplicitId(request.attemptId) &&
        !holdsSecret(request.attemptId) &&
        Number.isSafeInteger(request.generation) &&
        request.generation >= 0
        ? request
        : null;
    } catch {
      return null;
    }
  }

  function validProcessStart(value) {
    return (
      isRecord(value) &&
      Number.isSafeInteger(value.pid) &&
      value.pid > 0 &&
      typeof value.id === 'string' &&
      value.id.length > 0
    );
  }

  function providerIdentity(observation) {
    const processStart = observation?.provider?.processStart;
    if (
      !validProcessStart(processStart) ||
      observation.provider.state !== 'running'
    ) {
      return null;
    }
    return {
      processId: processStart.pid,
      processStartIdentity: processStart.id.slice(
        processStart.id.indexOf(':') + 1
      ),
      state: 'alive',
    };
  }

  function archivedAttemptMatches(archive, binding, expected) {
    const attempt = archive?.view?.attempts?.[binding.attemptId];
    return (
      archive?.ok === true &&
      archive.generation === binding.generation &&
      isRecord(attempt) &&
      attempt.status === 'running' &&
      BINDING_FIELDS.every((field) => attempt[field] === binding[field]) &&
      attempt.attemptDigest === expected.attemptDigest &&
      attempt.processStart?.id === expected.processStart.id &&
      attempt.processStart?.pid === expected.processStart.pid
    );
  }

  async function observeWorker(attempt) {
    let observed;
    try {
      observed = await observeProcess(attempt.processStart.pid);
    } catch {
      observed = { state: 'unknown' };
    }
    if (observed?.state !== 'alive') {
      return {
        ok: false,
        result: fail(
          observed?.state === 'absent'
            ? 'RECONNECT_WORKER_ABSENT'
            : 'RECONNECT_WORKER_UNKNOWN',
          { unknown: true }
        ),
      };
    }
    return identityMatches(attempt.processStart, observed)
      ? { ok: true }
      : {
          ok: false,
          result: fail('RECONNECT_PROCESS_IDENTITY_MISMATCH', {
            unknown: true,
          }),
        };
  }

  async function connectDescriptor(binding, descriptorPath, attempt) {
    let attached;
    try {
      attached = await processAdapter.reconnect({ binding, descriptorPath });
    } catch {
      return {
        ok: false,
        result: fail('RECONNECT_TRANSPORT_UNKNOWN', { unknown: true }),
      };
    }
    if (
      attached?.ok !== true ||
      !sameBinding(attached.binding, binding) ||
      !archivedAttemptMatches(attached.archive, binding, attempt) ||
      !identityMatches(
        attempt.processStart,
        providerIdentity(attached.observation)
      )
    ) {
      return {
        ok: false,
        result: fail('RECONNECT_INCARNATION_MISMATCH', { unknown: true }),
      };
    }
    return { attached, ok: true };
  }

  async function reconnect(input = {}) {
    const request = normalizeReconnectInput(input);
    if (!request) {
      return fail('RECONNECT_INPUT_INVALID');
    }
    const current = loadCurrent(
      request.runId,
      request.attemptId,
      request.generation
    );
    if (!current.ok) {
      return current.result;
    }
    const { attempt, binding } = current;
    const observed = await observeWorker(attempt);
    if (!observed.ok) {
      return observed.result;
    }
    const stat = spool.stat({ attemptDigest: attempt.attemptDigest });
    if (stat?.ok !== true) {
      return fail('RECONNECT_SPOOL_UNKNOWN', { unknown: true });
    }
    const located = findDescriptor(tempRoot, root, binding);
    if (!located.ok) {
      return located.result;
    }
    const connection = await connectDescriptor(
      binding,
      located.descriptorPath,
      attempt
    );
    if (!connection.ok) {
      return connection.result;
    }
    const latest = loadCurrent(
      request.runId,
      request.attemptId,
      request.generation
    );
    if (!latest.ok) {
      return fail('RECONNECT_ATTEMPT_CHANGED', { unknown: true });
    }
    if (
      !sameBinding(latest.binding, binding) ||
      latest.attempt.attemptDigest !== attempt.attemptDigest ||
      latest.attempt.processStart.id !== attempt.processStart.id ||
      latest.attempt.processStart.pid !== attempt.processStart.pid ||
      latest.attempt.updatedAt !== attempt.updatedAt
    ) {
      return fail('RECONNECT_ATTEMPT_CHANGED', { unknown: true });
    }
    return {
      archive: connection.attached.archive,
      binding,
      captureProcess: connection.attached.captureProcess,
      observation: connection.attached.observation,
      ok: true,
      spool: stat,
    };
  }

  async function start(input = {}) {
    let result;
    try {
      result = await processAdapter.start(input);
    } catch {
      return fail('CAPTURE_START_UNKNOWN', { unknown: true });
    }
    if (!isRecord(result)) {
      return fail('CAPTURE_START_UNKNOWN', { unknown: true });
    }
    const { descriptorPath, ...publicResult } = result;
    return publicResult;
  }

  return Object.freeze({
    close: processAdapter.close,
    reconnect,
    start,
  });
}
