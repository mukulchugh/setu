import { spawn as spawnProcess } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import {
  closeSync,
  existsSync,
  constants as fsConstants,
  fstatSync,
  linkSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { types as utilTypes } from 'node:util';
import { observeProcessIdentity } from './process-observation.js';
import { openSpansStore } from './spans-store.js';
import {
  sameSpansWorkerExecutionReview,
  snapshotSpansWorkerExecutionReview,
} from './spans-worker-authority.js';

const FIELDS = [
  'actionId',
  'attemptId',
  'generation',
  'runId',
  'spanId',
  'workerId',
];
const CHILD_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  'spans-worker-child.js'
);
const MAX_FILE_BYTES = 128 * 1024;
const MAX_WORKERS = 2;
const MAX_ATTEMPT_DEADLINE_MS = 60 * 60 * 1000;
const ENV_KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
const TOKEN_PATTERN = /^[0-9a-f]{64}$/;
const ADMISSION_PATH_FIELDS = ['workspaceRoot', 'configPath', 'setuDir'];
const isRecord = (value) =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const sameBinding = (left, right) =>
  isRecord(left) &&
  isRecord(right) &&
  Reflect.ownKeys(left).length === FIELDS.length &&
  FIELDS.every((field) => left[field] === right[field]);
const safeError = (code) => ({ code, ok: false });

// Both launch and restart use this address; the descriptor still proves its
// full archive/attempt binding before any process or control channel is used.
export function spansWorkerCapturePath({ root, tempRoot, binding }) {
  const key = createHash('sha256')
    .update(
      JSON.stringify([
        'spans.worker.capture',
        root,
        ...FIELDS.map((field) => binding[field]),
      ])
    )
    .digest('hex')
    .slice(0, 48);
  return join(tempRoot, `swp-${key}`, 'capture.json');
}

function readPrivateJson(path, maxBytes = MAX_FILE_BYTES) {
  let descriptor;
  try {
    descriptor = openSync(
      path,
      // biome-ignore lint/suspicious/noBitwiseOperators: POSIX open flags are bitmasks; retain O_NOFOLLOW.
      fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0)
    );
    const stat = fstatSync(descriptor);
    if (
      !stat.isFile() ||
      // biome-ignore lint/suspicious/noBitwiseOperators: POSIX permission bits must be masked to reject group/other access.
      (stat.mode & 0o077) !== 0 ||
      stat.nlink !== 1 ||
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
    descriptor = openSync(
      temporary,
      // biome-ignore lint/suspicious/noBitwiseOperators: POSIX open flags enforce exclusive, private, no-follow creation.
      fsConstants.O_WRONLY |
        fsConstants.O_CREAT |
        fsConstants.O_EXCL |
        (fsConstants.O_NOFOLLOW ?? 0),
      0o600
    );
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
      // The temporary link may already have been removed or never created.
    }
  }
}

function privatePath(path, directory = false) {
  let descriptor;
  try {
    descriptor = openSync(
      path,
      // biome-ignore lint/suspicious/noBitwiseOperators: POSIX open flags are bitmasks; retain directory and no-follow checks.
      fsConstants.O_RDONLY |
        (directory ? (fsConstants.O_DIRECTORY ?? 0) : 0) |
        (fsConstants.O_NOFOLLOW ?? 0)
    );
    const stat = fstatSync(descriptor);
    return (
      (directory ? stat.isDirectory() : stat.isFile()) &&
      // biome-ignore lint/suspicious/noBitwiseOperators: POSIX permission bits must be masked to reject group/other access.
      (stat.mode & 0o077) === 0 &&
      (typeof process.getuid !== 'function' || stat.uid === process.getuid()) &&
      (directory || stat.size <= MAX_FILE_BYTES)
    );
  } catch {
    return false;
  } finally {
    if (descriptor !== undefined) {
      closeSync(descriptor);
    }
  }
}

function readJson(path) {
  return readPrivateJson(path);
}

function validateStart(start, binding, limits) {
  return (
    isRecord(start) &&
    FIELDS.every((field) => start[field] === binding[field]) &&
    Number.isSafeInteger(start.deadlineMs) &&
    start.deadlineMs > 0 &&
    start.deadlineMs <= MAX_ATTEMPT_DEADLINE_MS &&
    Number.isSafeInteger(limits.maxActiveAttempts) &&
    limits.maxActiveAttempts > 0 &&
    limits.maxActiveAttempts <= MAX_WORKERS &&
    Number.isSafeInteger(limits.maxAttemptBytes) &&
    limits.maxAttemptBytes > 0 &&
    Number.isSafeInteger(limits.maxAttemptChunks) &&
    limits.maxAttemptChunks > 0 &&
    Number.isSafeInteger(limits.maxChunkBytes) &&
    limits.maxChunkBytes > 0 &&
    Number.isSafeInteger(limits.maxDeadlineMs) &&
    limits.maxDeadlineMs > 0 &&
    limits.maxDeadlineMs <= MAX_ATTEMPT_DEADLINE_MS &&
    start.deadlineMs <= limits.maxDeadlineMs &&
    Number.isSafeInteger(limits.maxQueueBytes) &&
    limits.maxQueueBytes > 0
  );
}

function sourceDescriptors(source) {
  if (!isRecord(source) || utilTypes.isProxy(source)) {
    return null;
  }
  const descriptors = Object.getOwnPropertyDescriptors(source);
  const hasDataProperty = (key) =>
    Object.hasOwn(descriptors, key) && Object.hasOwn(descriptors[key], 'value');
  if (
    !['command', 'args', 'stdin'].every(hasDataProperty) ||
    ['cwd', 'env'].some(
      (key) => Object.hasOwn(descriptors, key) && !hasDataProperty(key)
    )
  ) {
    return null;
  }
  return descriptors;
}

function snapshotArguments(value) {
  if (!Array.isArray(value) || utilTypes.isProxy(value)) {
    return null;
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (
    Reflect.ownKeys(descriptors).length !== value.length + 1 ||
    !Object.hasOwn(descriptors, 'length')
  ) {
    return null;
  }
  const args = [];
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = descriptors[String(index)];
    if (
      !(descriptor && Object.hasOwn(descriptor, 'value')) ||
      typeof descriptor.value !== 'string'
    ) {
      return null;
    }
    args.push(descriptor.value);
  }
  return Object.freeze(args);
}

function snapshotEnvironment(descriptor) {
  if (!descriptor || descriptor.value === undefined) {
    return { valid: true, value: undefined };
  }
  const { value } = descriptor;
  if (!isRecord(value) || utilTypes.isProxy(value)) {
    return { valid: false, value: undefined };
  }
  const env = Object.create(null);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  for (const key of Reflect.ownKeys(descriptors)) {
    const property = descriptors[key];
    if (
      typeof key !== 'string' ||
      !ENV_KEY_PATTERN.test(key) ||
      !Object.hasOwn(property, 'value') ||
      typeof property.value !== 'string'
    ) {
      return { valid: false, value: undefined };
    }
    env[key] = property.value;
  }
  return { valid: true, value: Object.freeze(env) };
}

function snapshotSource(source) {
  try {
    const descriptors = sourceDescriptors(source);
    if (!descriptors) {
      return null;
    }
    const command = descriptors.command.value;
    const stdin = descriptors.stdin.value;
    if (
      typeof command !== 'string' ||
      command.length === 0 ||
      typeof stdin !== 'string' ||
      stdin.trim().length === 0 ||
      stdin.includes('\0') ||
      Buffer.from(stdin, 'utf8').toString('utf8') !== stdin ||
      Buffer.byteLength(stdin, 'utf8') > MAX_FILE_BYTES
    ) {
      return null;
    }
    const args = snapshotArguments(descriptors.args.value);
    if (!args) {
      return null;
    }
    const cwd = Object.hasOwn(descriptors, 'cwd')
      ? descriptors.cwd.value
      : undefined;
    if (
      cwd !== undefined &&
      !(typeof cwd === 'string' && resolve(cwd) === cwd)
    ) {
      return null;
    }
    const environment = snapshotEnvironment(descriptors.env);
    if (!environment.valid) {
      return null;
    }
    return Object.freeze({
      args,
      command,
      ...(cwd === undefined ? {} : { cwd }),
      ...(environment.value === undefined ? {} : { env: environment.value }),
      stdin,
    });
  } catch {
    return null;
  }
}

function validAdmissionContext(context, binding, root) {
  if (
    !(
      isRecord(context) &&
      ADMISSION_PATH_FIELDS.every(
        (field) =>
          typeof context[field] === 'string' &&
          resolve(context[field]) === context[field]
      ) &&
      isRecord(context.lease)
    )
  ) {
    return false;
  }
  try {
    if (
      realpathSync(context.workspaceRoot) !== context.workspaceRoot ||
      realpathSync(context.setuDir) !== context.setuDir ||
      join(
        realpathSync(dirname(context.configPath)),
        basename(context.configPath)
      ) !== context.configPath
    ) {
      return false;
    }
  } catch {
    return false;
  }
  const { lease } = context;
  const { spansBinding, spansArchiveReservation: reservation } = lease;
  return (
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

function requestLocalFile(controlDir, payload, timeoutMs, terminalRecorded) {
  return new Promise((resolveRequest) => {
    const requestId = randomBytes(16).toString('hex');
    const requestPath = join(controlDir, `request-${requestId}.json`);
    const responsePath = join(controlDir, `response-${requestId}.json`);
    let settled = false;
    const finish = (value) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      clearInterval(interval);
      try {
        unlinkSync(requestPath);
      } catch {
        // Best-effort request cleanup after the response has settled.
      }
      try {
        unlinkSync(responsePath);
      } catch {
        // Best-effort response cleanup after the response has settled.
      }
      resolveRequest(value);
    };
    const receive = () => {
      if (!existsSync(responsePath)) {
        if (terminalRecorded?.() === true) {
          finish(safeError('CAPTURE_TERMINAL_RECORDED'));
        }
        return;
      }
      const response = readJson(responsePath);
      if (response !== null) {
        finish(response);
      }
    };
    const timer = setTimeout(() => finish(null), timeoutMs);
    let interval;
    try {
      if (!writePrivateJson(requestPath, { ...payload, requestId })) {
        throw new Error('request publish failed');
      }
      interval = setInterval(receive, 10);
      receive();
    } catch {
      finish(null);
    }
  });
}

function readDescriptor(
  path,
  expectedBinding,
  tempRoot,
  root,
  requireAdmissionContext = false
) {
  const canonicalTempRoot = resolve(tempRoot);
  try {
    if (
      resolve(path) !== path ||
      !path.startsWith(`${canonicalTempRoot}/`) ||
      !realpathSync(dirname(path)).startsWith(
        `${realpathSync(canonicalTempRoot)}/`
      )
    ) {
      return null;
    }
  } catch {
    return null;
  }
  const descriptor = readJson(path);
  const identity = readJson(join(dirname(path), 'capture-process.json'));
  const controlDir = descriptor?.controlDir;
  if (
    descriptor?.version !== 2 ||
    !sameBinding(descriptor.binding, expectedBinding) ||
    typeof descriptor.token !== 'string' ||
    !TOKEN_PATTERN.test(descriptor.token) ||
    descriptor.root !== root ||
    (requireAdmissionContext &&
      !validAdmissionContext(
        descriptor.admissionContext,
        expectedBinding,
        root
      )) ||
    (Object.hasOwn(descriptor ?? {}, 'executionReview') &&
      (!snapshotSpansWorkerExecutionReview(descriptor.executionReview) ||
        descriptor.executionReview.runId !== expectedBinding.runId)) ||
    (requireAdmissionContext &&
      (!snapshotSpansWorkerExecutionReview(descriptor.executionReview) ||
        descriptor.executionReview.runId !== expectedBinding.runId)) ||
    controlDir !== join(dirname(path), 'control') ||
    !privatePath(dirname(path), true) ||
    !privatePath(controlDir, true) ||
    !identity?.captureProcess ||
    !Number.isSafeInteger(identity.captureProcess.pid) ||
    identity.captureProcess.pid <= 0 ||
    typeof identity.captureProcess.processStartIdentity !== 'string'
  ) {
    return null;
  }
  return { ...descriptor, captureProcess: identity.captureProcess };
}

export function createSpansWorkerProcess({
  root,
  authorize,
  executionReview: rawExecutionReview,
  resolveArchiveAdmission,
  observeProcess = observeProcessIdentity,
  spawn = spawnProcess,
  childPath = CHILD_PATH,
  transportTimeoutMs,
  tempRoot = tmpdir(),
} = {}) {
  const configuredExecutionReview =
    rawExecutionReview === undefined
      ? null
      : snapshotSpansWorkerExecutionReview(rawExecutionReview);
  if (
    typeof authorize !== 'function' ||
    (resolveArchiveAdmission !== undefined &&
      typeof resolveArchiveAdmission !== 'function') ||
    typeof observeProcess !== 'function' ||
    !Number.isSafeInteger(transportTimeoutMs) ||
    transportTimeoutMs < 1 ||
    typeof root !== 'string' ||
    resolve(root) !== root ||
    (rawExecutionReview !== undefined && !configuredExecutionReview)
  ) {
    throw new TypeError(
      'A canonical archive root, trusted authorizer, process observer, and transport timeout are required.'
    );
  }
  let closed = false;

  async function captureResponse(controlDir, payload) {
    let reader;
    let nextReadAt = 0;
    const terminalRecorded = () => {
      if (Date.now() < nextReadAt) {
        return false;
      }
      nextReadAt = Date.now() + 50;
      try {
        reader ??= openSpansStore({ create: false, readonly: true, root });
        const read = reader.readRun({ runId: payload.binding.runId });
        const attempt = read.view?.attempts?.[payload.binding.attemptId];
        return (
          read.ok === true &&
          FIELDS.every(
            (field) => attempt?.[field] === payload.binding[field]
          ) &&
          ['exited', 'held'].includes(attempt.status) &&
          isRecord(attempt.exit)
        );
      } catch {
        return false;
      }
    };
    try {
      return await requestLocalFile(
        controlDir,
        payload,
        transportTimeoutMs,
        terminalRecorded
      );
    } finally {
      reader?.close();
    }
  }

  async function authorized(operation, binding) {
    if (closed) {
      return false;
    }
    try {
      const result = await authorize({
        binding: Object.fromEntries(FIELDS.map((key) => [key, binding[key]])),
        operation,
      });
      return result?.ok === true && result.currentAttempt === true;
    } catch {
      return false;
    }
  }

  async function verifyCapture(descriptor, binding) {
    if (!(descriptor && sameBinding(descriptor.binding, binding))) {
      return safeError('CAPTURE_DESCRIPTOR_INVALID');
    }
    let observed;
    try {
      observed = await observeProcess(descriptor.captureProcess.pid);
    } catch {
      observed = { state: 'unknown' };
    }
    if (observed?.state !== 'alive') {
      return safeError(
        observed?.state === 'absent'
          ? 'CAPTURE_PROCESS_ABSENT'
          : 'CAPTURE_PROCESS_UNKNOWN'
      );
    }
    if (
      observed.processId !== descriptor.captureProcess.pid ||
      observed.processStartIdentity !==
        descriptor.captureProcess.processStartIdentity
    ) {
      return safeError('CAPTURE_PROCESS_IDENTITY_MISMATCH');
    }
    return { ok: true };
  }

  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Keep ordered authorization, archive proof, launch, and identity checks in one auditable lifecycle.
  async function start(input = {}) {
    const { binding, start: startRequest, limits, source } = input;
    const suppliedReview = (() => {
      if (!isRecord(input) || utilTypes.isProxy(input)) {
        return { invalid: true, value: null };
      }
      const descriptor = Object.getOwnPropertyDescriptor(
        input,
        'executionReview'
      );
      if (!descriptor) {
        return { invalid: false, value: null };
      }
      if (!(Object.hasOwn(descriptor, 'value') && descriptor.enumerable)) {
        return { invalid: true, value: null };
      }
      const value = snapshotSpansWorkerExecutionReview(descriptor.value);
      return { invalid: !value, value };
    })();
    const executionReview = suppliedReview.value ?? configuredExecutionReview;
    const sourceSnapshot = snapshotSource(source);
    if (
      !(
        !suppliedReview.invalid &&
        sameBinding(binding, binding) &&
        validateStart(startRequest, binding, limits) &&
        sourceSnapshot &&
        !(
          suppliedReview.value &&
          configuredExecutionReview &&
          !sameSpansWorkerExecutionReview(
            suppliedReview.value,
            configuredExecutionReview
          )
        ) &&
        (!executionReview || executionReview.runId === binding.runId)
      )
    ) {
      return safeError('CAPTURE_START_INVALID');
    }
    if (!(await authorized('start', binding))) {
      return safeError('ATTEMPT_AUTHORIZATION_REFUSED');
    }
    let admissionContext;
    if (resolveArchiveAdmission) {
      try {
        admissionContext = await resolveArchiveAdmission({
          binding: Object.fromEntries(FIELDS.map((key) => [key, binding[key]])),
        });
      } catch {
        return safeError('ARCHIVE_ADMISSION_REFUSED');
      }
      try {
        admissionContext = JSON.parse(JSON.stringify(admissionContext));
      } catch {
        return safeError('ARCHIVE_ADMISSION_REFUSED');
      }
      let validContext = false;
      try {
        validContext = validAdmissionContext(admissionContext, binding, root);
      } catch {
        validContext = false;
      }
      if (!validContext) {
        return safeError('ARCHIVE_ADMISSION_REFUSED');
      }
      if (!executionReview) {
        return safeError('EXECUTION_REVIEW_REQUIRED');
      }
    }
    try {
      if (!privatePath(root, true)) {
        return safeError('CAPTURE_ROOT_UNSAFE');
      }
      const existing = openSpansStore({ readonly: true, root });
      let run;
      try {
        run = existing.readRun({ runId: binding.runId });
      } finally {
        existing.close();
      }
      if (!run?.ok || run.generation !== binding.generation) {
        return safeError('ATTEMPT_AUTHORITY_UNKNOWN');
      }
      const action = run.view?.actions?.[binding.actionId];
      const attempt = run.view?.attempts?.[binding.attemptId];
      if (attempt) {
        return safeError('ATTEMPT_ALREADY_STARTED');
      }
      if (
        action?.state !== 'intent' ||
        action.attemptId !== binding.attemptId ||
        action.spanId !== binding.spanId
      ) {
        return safeError('ACTION_INTENT_NOT_CONFIRMED');
      }
      const descriptorPath = spansWorkerCapturePath({
        binding,
        root,
        tempRoot,
      });
      const attemptDir = dirname(descriptorPath);
      const controlDir = join(attemptDir, 'control');
      const token = randomBytes(32).toString('hex');
      const descriptor = {
        ...(admissionContext ? { admissionContext } : {}),
        binding,
        controlDir,
        ...(executionReview ? { executionReview } : {}),
        limits,
        root,
        source: sourceSnapshot,
        start: startRequest,
        token,
        version: 2,
      };
      if (
        Buffer.byteLength(JSON.stringify(descriptor), 'utf8') > MAX_FILE_BYTES
      ) {
        return safeError('CAPTURE_START_INVALID');
      }
      mkdirSync(attemptDir, { mode: 0o700 });
      mkdirSync(controlDir, { mode: 0o700 });
      if (!writePrivateJson(descriptorPath, descriptor)) {
        return safeError('CAPTURE_DESCRIPTOR_PUBLISH_FAILED');
      }
      const child = spawn(process.execPath, [childPath, descriptorPath], {
        detached: true,
        env: {
          HOME: process.env.HOME ?? '',
          PATH: process.env.PATH ?? '',
          TMPDIR: process.env.TMPDIR ?? tmpdir(),
        },
        stdio: 'ignore',
      });
      child.unref();
      if (!Number.isSafeInteger(child.pid) || child.pid <= 0) {
        return safeError('CAPTURE_LAUNCH_UNKNOWN');
      }
      const observed = await observeProcess(child.pid);
      if (
        observed?.state !== 'alive' ||
        observed.processId !== child.pid ||
        typeof observed.processStartIdentity !== 'string'
      ) {
        return {
          ...safeError('CAPTURE_PROCESS_IDENTITY_UNKNOWN'),
          binding,
          captureProcess: { pid: child.pid, processStartIdentity: null },
          descriptorPath,
          unknown: true,
        };
      }
      const captureProcess = {
        pid: child.pid,
        processStartIdentity: observed.processStartIdentity,
      };
      if (
        !writePrivateJson(join(attemptDir, 'capture-process.json'), {
          captureProcess,
        })
      ) {
        return {
          ...safeError('CAPTURE_PROCESS_IDENTITY_UNKNOWN'),
          binding,
          captureProcess,
          descriptorPath,
          unknown: true,
        };
      }
      const ready = await captureResponse(controlDir, {
        binding,
        operation: 'ready',
        token,
      });
      if (ready?.ok !== true) {
        if (ready?.noProviderEffect === true) {
          return {
            binding,
            captureProcess,
            code: 'CAPTURE_PROVIDER_REFUSED',
            descriptorPath,
            dispatched: false,
            noProviderEffect: true,
            ok: false,
          };
        }
        return {
          ...safeError('CAPTURE_READY_UNKNOWN'),
          binding,
          captureProcess,
          descriptorPath,
          unknown: true,
        };
      }
      return {
        binding,
        captureProcess,
        descriptorPath,
        ok: true,
        status: ready.status,
      };
    } catch {
      return safeError('CAPTURE_START_UNKNOWN');
    }
  }

  async function reconnect({ binding, descriptorPath } = {}) {
    if (
      typeof descriptorPath !== 'string' ||
      resolve(descriptorPath) !== descriptorPath ||
      !(await authorized('reconnect', binding))
    ) {
      return safeError('ATTEMPT_AUTHORIZATION_REFUSED');
    }
    const descriptor = readDescriptor(
      descriptorPath,
      binding,
      tempRoot,
      root,
      Boolean(resolveArchiveAdmission)
    );
    const verified = await verifyCapture(descriptor, binding);
    if (!verified.ok) {
      return verified;
    }
    const observation = await captureResponse(descriptor.controlDir, {
      binding,
      operation: 'observe',
      token: descriptor.token,
    });
    if (!observation?.ok) {
      return safeError(observation?.code ?? 'CAPTURE_PROCESS_UNKNOWN');
    }
    let archive;
    try {
      const store = openSpansStore({ readonly: true, root: descriptor.root });
      try {
        archive = store.readRun({ runId: binding.runId });
      } finally {
        store.close();
      }
    } catch {
      return safeError('ARCHIVE_STATUS_UNKNOWN');
    }
    if (!archive?.ok) {
      return safeError('ARCHIVE_STATUS_UNKNOWN');
    }
    return {
      archive,
      binding: descriptor.binding,
      captureProcess: descriptor.captureProcess,
      descriptorPath,
      observation,
      ok: true,
    };
  }

  async function cancel({ binding, descriptorPath } = {}) {
    if (!(await authorized('cancel', binding))) {
      return safeError('ATTEMPT_AUTHORIZATION_REFUSED');
    }
    const descriptor = readDescriptor(
      descriptorPath,
      binding,
      tempRoot,
      root,
      Boolean(resolveArchiveAdmission)
    );
    const verified = await verifyCapture(descriptor, binding);
    if (!verified.ok) {
      return verified;
    }
    const result = await captureResponse(descriptor.controlDir, {
      binding,
      operation: 'cancel',
      token: descriptor.token,
    });
    return result?.ok === true
      ? result
      : safeError(result?.code ?? 'CAPTURE_CANCEL_UNKNOWN');
  }

  return Object.freeze({
    cancel,
    close: () => {
      closed = true;
      return { ok: true };
    },
    reconnect,
    start,
  });
}
