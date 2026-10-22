import { AsyncLocalStorage } from 'node:async_hooks';
import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import {
  copyFile,
  lstat,
  open,
  realpath,
  stat,
  unlink,
} from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { dependencyFileNativeBinaryPath } from './dependency-file-engine.js';

const exec = promisify(execFile);
const SETU_ROOT = dirname(fileURLToPath(import.meta.url));
const DEFAULT_NATIVE_BINARY = dependencyFileNativeBinaryPath(SETU_ROOT);
const XATTR_BINARY = '/usr/bin/xattr';
const PROCESS_TIMEOUT_MS = 2500;
const HELPER_MAX_OUTPUT_BYTES = 600 * 1024;
const XATTR_LIST_MAX_BYTES = 16 * 1024;
const XATTR_VALUE_MAX_BYTES = 64 * 1024;
const XATTR_TOTAL_MAX_BYTES = 256 * 1024;
const XATTR_MAX_COUNT = 32;
const HASH_CHUNK_BYTES = 64 * 1024;
const SUPPORTED_ATTRIBUTES = new Set([
  'com.apple.provenance',
  'com.apple.quarantine',
]);
const HELPER_FRAME_MAX_BYTES = 64 * 1024;
const HELPER_IDLE_TIMEOUT_MS = 1000;
const SAFE_CODE_PATTERN = /^[A-Z][A-Z0-9_]{0,63}$/;
const UNSIGNED_DECIMAL_PATTERN = /^(0|[1-9][0-9]*)$/;
const SIGNED_DECIMAL_PATTERN = /^-?[0-9]+$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const ATTRIBUTE_HEX_PATTERN = /^(?:[a-fA-F0-9]{2})*$/;
const ATTRIBUTE_NAME_PATTERN = /^[A-Za-z0-9._:-]{1,255}$/;
const WHITESPACE_PATTERN = /\s+/g;
const ATTRIBUTE_LINE_PATTERN = /\r?\n/;

function combineNativeFlags(...flags) {
  // biome-ignore lint/suspicious/noBitwiseOperators: native APIs define flags as bit masks.
  return flags.reduce((combined, flag) => combined | flag, 0);
}

function encodeHelperFrame(args) {
  if (!Array.isArray(args) || args.length < 1 || args.length > 16) {
    throw makeError('NATIVE_FRAME_INVALID', 'Native helper request is invalid');
  }
  const fields = args.map((value) => {
    if (
      typeof value !== 'string' ||
      Buffer.byteLength(value) > 32 * 1024 ||
      value.includes('\0')
    ) {
      throw makeError(
        'NATIVE_FRAME_INVALID',
        'Native helper request is invalid'
      );
    }
    return Buffer.from(value, 'utf8').toString('hex');
  });
  const frame = `${fields.length}\t${fields.join('\t')}\n`;
  if (Buffer.byteLength(frame) > HELPER_FRAME_MAX_BYTES) {
    throw makeError(
      'NATIVE_FRAME_INVALID',
      'Native helper request exceeds its bound'
    );
  }
  return frame;
}

class NativeHelperWorker {
  constructor(binary, spawnProcess = spawn) {
    this.binary = binary;
    this.spawnProcess = spawnProcess;
    this.child = null;
    this.tail = Promise.resolve();
    this.pending = [];
    this.output = '';
    this.idleTimer = null;
    this.closed = false;
    this.closing = false;
    this.generation = 0;
    this.leaseKey = null;
    this.leaseContext = null;
  }

  start() {
    if (this.child) {
      return { child: this.child, generation: this.generation };
    }
    const child = this.spawnProcess(this.binary, ['stdio'], {
      stdio: ['pipe', 'pipe', 'ignore'],
      windowsHide: true,
    });
    this.generation += 1;
    const { generation } = this;
    this.child = child;
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      if (this.isCurrent(child, generation)) {
        this.onData(child, generation, chunk);
      }
    });
    child.on('error', (error) => {
      if (this.isCurrent(child, generation)) {
        this.failAll(
          makeError(
            'NATIVE_HELPER_FAILED',
            'Native helper process failed',
            error
          )
        );
        this.terminate(child, generation);
      }
    });
    child.stdout.on('error', (error) => {
      if (this.isCurrent(child, generation)) {
        this.failAll(
          makeError(
            'NATIVE_HELPER_FAILED',
            'Native helper output stream failed',
            error
          )
        );
        this.terminate(child, generation);
      }
    });
    child.stdin.on('error', (error) => {
      if (this.isCurrent(child, generation)) {
        this.failAll(
          makeError(
            'NATIVE_HELPER_FAILED',
            'Native helper input stream failed',
            error
          )
        );
        this.terminate(child, generation);
      }
    });
    child.on('exit', (code, signal) => {
      if (!this.isCurrent(child, generation)) {
        return;
      }
      this.child = null;
      this.output = '';
      if (this.pending.length) {
        this.failAll(
          makeError(
            'NATIVE_HELPER_FAILED',
            'Native helper exited before replying',
            { code, signal }
          )
        );
      }
      if (this.leaseContext) {
        this.leaseContext.poisoned = true;
        this.leaseContext.poisonReason = 'NATIVE_HELPER_DIED_DURING_LEASE';
        this.leaseContext = null;
        this.leaseKey = null;
      }
    });
    return { child, generation };
  }

  isCurrent(child, generation) {
    return this.child === child && this.generation === generation;
  }

  onData(child, generation, chunk) {
    if (!this.isCurrent(child, generation)) {
      return;
    }
    this.output += chunk;
    if (
      Buffer.byteLength(this.output) > HELPER_MAX_OUTPUT_BYTES + 1 &&
      !this.output.includes('\n')
    ) {
      this.failAll(
        makeError(
          'NATIVE_HELPER_INVALID_RESPONSE',
          'Native helper response exceeds its bound'
        )
      );
      this.terminate(child, generation);
      return;
    }
    let newline;
    while (this.output.includes('\n')) {
      newline = this.output.indexOf('\n');
      const line = this.output.slice(0, newline);
      this.output = this.output.slice(newline + 1);
      if (Buffer.byteLength(line) > HELPER_MAX_OUTPUT_BYTES) {
        this.failAll(
          makeError(
            'NATIVE_HELPER_INVALID_RESPONSE',
            'Native helper response exceeds its bound'
          )
        );
        this.terminate(child, generation);
        return;
      }
      const pending = this.pending.shift();
      if (!pending) {
        this.failAll(
          makeError(
            'NATIVE_HELPER_INVALID_RESPONSE',
            'Native helper sent an unsolicited response'
          )
        );
        this.terminate(child, generation);
        return;
      }
      clearTimeout(pending.timer);
      pending.resolve({ stderr: '', stdout: line });
    }
  }

  failAll(error) {
    for (const pending of this.pending.splice(0)) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
  }

  terminate(expectedChild = this.child, expectedGeneration = this.generation) {
    if (!expectedChild) {
      return;
    }
    if (!this.isCurrent(expectedChild, expectedGeneration)) {
      return;
    }
    const child = expectedChild;
    const { leaseContext } = this;
    if (leaseContext) {
      this.leaseContext.poisoned = true;
      this.leaseContext.poisonReason = 'NATIVE_HELPER_DIED_DURING_LEASE';
    }
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL');
    }
    if (!leaseContext) {
      this.child = null;
    }
    this.output = '';
  }

  run(args, { timeout = PROCESS_TIMEOUT_MS } = {}) {
    const request = async () => {
      if (this.closed || this.closing) {
        throw makeError('NATIVE_HELPER_CLOSED', 'Native helper is closed');
      }
      const frame = encodeHelperFrame(args);
      const { child, generation } = this.start();
      clearTimeout(this.idleTimer);
      const result = await new Promise((resolveRequest, rejectRequest) => {
        const pending = {
          reject: rejectRequest,
          resolve: resolveRequest,
          timer: null,
        };
        pending.timer = setTimeout(() => {
          const index = this.pending.indexOf(pending);
          if (index !== -1) {
            this.pending.splice(index, 1);
          }
          rejectRequest(
            makeError('ETIMEDOUT', 'Native helper request timed out')
          );
          this.failAll(
            makeError(
              'NATIVE_HELPER_FAILED',
              'Native helper was stopped after a timeout'
            )
          );
          this.terminate(child, generation);
        }, timeout);
        this.pending.push(pending);
        child.stdin.write(frame, 'utf8', (error) => {
          if (!error) {
            return;
          }
          const index = this.pending.indexOf(pending);
          if (index !== -1) {
            this.pending.splice(index, 1);
          }
          clearTimeout(pending.timer);
          rejectRequest(
            makeError(
              'NATIVE_HELPER_FAILED',
              'Native helper request could not be written',
              error
            )
          );
          this.terminate(child, generation);
        });
      });
      if (!this.leaseContext) {
        this.idleTimer = setTimeout(
          () => this.terminate(child, generation),
          HELPER_IDLE_TIMEOUT_MS
        );
      }
      return result;
    };
    const result = this.tail.then(request, request);
    this.tail = result.catch(() => undefined);
    return result;
  }

  async close({ terminal = false } = {}) {
    this.closing = true;
    clearTimeout(this.idleTimer);
    await this.tail.catch(() => undefined);
    const { child, generation } = this;
    if (child) {
      child.stdin.end();
      await new Promise((resolveClose) => {
        const timer = setTimeout(() => {
          if (this.isCurrent(child, generation)) {
            child.kill('SIGKILL');
          }
          resolveClose();
        }, 250);
        child.once('exit', () => {
          if (this.generation === generation) {
            clearTimeout(timer);
          }
          resolveClose();
        });
      });
      this.terminate(child, generation);
    }
    this.closed = terminal;
    this.closing = false;
  }

  async abandonLease(context) {
    context.poisoned = true;
    context.poisonReason = 'LEASE_ACQUIRE_UNKNOWN';
    const { child, generation } = this;
    if (
      this.leaseContext !== context ||
      !child ||
      !this.isCurrent(child, generation)
    ) {
      return;
    }
    const exited = new Promise((resolveExit) => {
      child.once('exit', resolveExit);
    });
    this.terminate(child, generation);
    await exited;
  }
}
// These Rust failures are emitted only after the requested mutation may have
// taken effect. Keep them distinct from ordinary precondition refusals even
// when the helper exits nonzero with a structured { ok: false } response.
const MUTATION_EFFECT_UNKNOWN_CODES = new Set([
  'EXCHANGE_PATH_CHANGED',
  'EXCHANGE_SYNC_UNKNOWN',
  'TIMESTAMP_RESTORE_UNKNOWN',
  'TIMESTAMP_SYNC_UNKNOWN',
]);
const HELPER_PROBE_FIELDS = new Set([
  'ok',
  'protocol',
  'regular',
  'device',
  'inode',
  'size',
  'mode',
  'uid',
  'gid',
  'nlink',
  'mtimeNs',
  'ctimeNs',
  'atimeNs',
  'flags',
  'acl',
  'sparse',
  'attributes',
]);
const HELPER_CAPABILITIES = [
  'stdio',
  'xattrs',
  'swap',
  'forced-clone',
  'lease',
];

function makeError(code, message, cause) {
  return Object.assign(new Error(message, cause ? { cause } : undefined), {
    code,
  });
}

function makeHelperRefusal(code, message, cause) {
  return Object.assign(makeError(code, message, cause), {
    nativeRefusal: true,
  });
}

function safeCode(value, fallback = 'NATIVE_HELPER_FAILED') {
  return typeof value === 'string' && SAFE_CODE_PATTERN.test(value)
    ? value
    : fallback;
}

function errorCode(error, fallback = 'DEPENDENCY_FILE_FAILED') {
  return safeCode(error?.code, fallback);
}

function toReason(error) {
  const byCode = {
    ACL_PRESENT: 'acl-present',
    ATTRIBUTE_TOO_LARGE: 'large-attribute',
    FILE_FLAGS_PRESENT: 'file-flags-present',
    HARD_LINKED: 'hard-linked-file',
    HELPER_MISSING: 'native-helper-unavailable',
    NATIVE_UNSUPPORTED: 'native-unsupported',
    OWNER_MISMATCH: 'not-owned-by-current-user',
    PATH_NOT_FOUND: 'missing-file',
    ROOT_INVALID: 'root-unavailable',
    SET_ID_MODE: 'setuid-or-setgid',
    SPARSE_FILE: 'sparse-file',
    SYMLINK_ANCESTOR: 'symlink-ancestor',
    SYMLINK_LEAF: 'symlink-leaf',
    UNKNOWN_ATTRIBUTE: 'unknown-attribute',
    UNSAFE_RELATIVE_PATH: 'unsafe-relative-path',
  };
  return byCode[errorCode(error, '')] ?? 'metadata-unavailable';
}

function validateRelativePath(relativePath) {
  if (
    typeof relativePath !== 'string' ||
    relativePath.length === 0 ||
    relativePath.includes('\0') ||
    relativePath.startsWith('/') ||
    relativePath.endsWith('/') ||
    relativePath.includes('\\')
  ) {
    throw makeError(
      'UNSAFE_RELATIVE_PATH',
      'Invalid dependency-file relative path'
    );
  }
  const segments = relativePath.split('/');
  if (
    segments.some(
      (segment) =>
        segment.length === 0 ||
        segment === '.' ||
        segment === '..' ||
        segment.toLowerCase() === '.git'
    )
  ) {
    throw makeError(
      'UNSAFE_RELATIVE_PATH',
      'Invalid dependency-file relative path'
    );
  }
  return segments;
}

async function canonicalDirectory(path) {
  if (typeof path !== 'string' || !isAbsolute(path) || resolve(path) !== path) {
    throw makeError('ROOT_INVALID', 'Expected a canonical absolute directory');
  }

  let resolvedPath;
  let rootInfo;
  try {
    [resolvedPath, rootInfo] = await Promise.all([realpath(path), lstat(path)]);
  } catch (cause) {
    throw makeError(
      'ROOT_INVALID',
      'Directory is missing or unavailable',
      cause
    );
  }
  if (
    resolvedPath !== path ||
    rootInfo.isSymbolicLink() ||
    !rootInfo.isDirectory()
  ) {
    throw makeError(
      'ROOT_INVALID',
      'Directory is not canonical and symlink-free'
    );
  }

  const segments = path.split(sep).filter(Boolean);
  let cursor = sep;
  for (const segment of segments) {
    cursor = join(cursor, segment);
    let info;
    try {
      // biome-ignore lint/performance/noAwaitInLoops: component checks must follow the no-follow traversal order.
      info = await lstat(cursor);
    } catch (cause) {
      throw makeError(
        'ROOT_INVALID',
        'Directory ancestor is unavailable',
        cause
      );
    }
    if (info.isSymbolicLink() || !info.isDirectory()) {
      throw makeError(
        'ROOT_INVALID',
        'Directory has a symlink or non-directory ancestor'
      );
    }
  }
  return path;
}

async function assertNoSymlinkPath(
  root,
  segments,
  { leafMayBeMissing = false } = {}
) {
  let cursor = root;
  for (let index = 0; index < segments.length; index += 1) {
    cursor = join(cursor, segments[index]);
    let info;
    try {
      // biome-ignore lint/performance/noAwaitInLoops: component checks must follow the no-follow traversal order.
      info = await lstat(cursor);
    } catch (cause) {
      if (
        leafMayBeMissing &&
        index === segments.length - 1 &&
        cause.code === 'ENOENT'
      ) {
        return { exists: false, path: cursor };
      }
      if (cause.code === 'ENOENT') {
        throw makeError(
          'PATH_NOT_FOUND',
          'Dependency-file path is missing',
          cause
        );
      }
      throw makeError(
        'PATH_UNAVAILABLE',
        'Dependency-file path is unavailable',
        cause
      );
    }
    if (info.isSymbolicLink()) {
      throw makeError(
        index === segments.length - 1 ? 'SYMLINK_LEAF' : 'SYMLINK_ANCESTOR',
        'Dependency-file path traverses a symbolic link'
      );
    }
    if (index < segments.length - 1 && !info.isDirectory()) {
      throw makeError(
        'PATH_NOT_DIRECTORY',
        'Dependency-file ancestor is not a directory'
      );
    }
    if (index === segments.length - 1) {
      return { exists: true, info, path: cursor };
    }
  }
  throw makeError('UNSAFE_RELATIVE_PATH', 'Dependency-file path has no leaf');
}

async function runProcess(command, args, options = {}) {
  const result = await exec(command, args, {
    encoding: 'utf8',
    killSignal: 'SIGKILL',
    maxBuffer: options.maxBuffer ?? HELPER_MAX_OUTPUT_BYTES,
    timeout: options.timeout ?? PROCESS_TIMEOUT_MS,
    windowsHide: true,
  });
  return { stderr: result.stderr, stdout: result.stdout };
}

function parseJsonOutput(stdout) {
  if (
    typeof stdout !== 'string' ||
    Buffer.byteLength(stdout) > HELPER_MAX_OUTPUT_BYTES
  ) {
    throw makeError(
      'NATIVE_HELPER_INVALID_RESPONSE',
      'Native helper response is invalid'
    );
  }
  try {
    const value = JSON.parse(stdout.trim());
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error('not an object');
    }
    return value;
  } catch (cause) {
    throw makeError(
      'NATIVE_HELPER_INVALID_RESPONSE',
      'Native helper response is invalid',
      cause
    );
  }
}

async function invokeHelper(
  processRunner,
  nativeBinary,
  args,
  platform = process.platform
) {
  if (platform !== 'darwin') {
    throw makeError(
      'NATIVE_UNSUPPORTED',
      'Native dependency-file operations require macOS'
    );
  }
  if (typeof nativeBinary !== 'string' || !isAbsolute(nativeBinary)) {
    throw makeError(
      'NATIVE_HELPER_PATH_INVALID',
      'Native helper path must be absolute'
    );
  }

  let result;
  try {
    result = await processRunner(nativeBinary, args, {
      maxBuffer: HELPER_MAX_OUTPUT_BYTES,
      timeout: PROCESS_TIMEOUT_MS,
    });
  } catch (cause) {
    throw nativeHelperProcessFailure(cause);
  }

  const response = parseJsonOutput(result.stdout);
  if (response.protocol !== 1 && response.protocol !== 2) {
    throw makeError(
      'NATIVE_PROTOCOL_UNSUPPORTED',
      'Native helper protocol is unsupported'
    );
  }
  if (response.ok !== true) {
    throw makeHelperRefusal(
      safeCode(response.code),
      'Native helper refused the operation'
    );
  }
  return response;
}

function nativeHelperProcessFailure(cause) {
  const partial = typeof cause.stdout === 'string' ? cause.stdout : '';
  if (!partial) {
    const code =
      cause.code === 'ENOENT'
        ? 'HELPER_MISSING'
        : safeCode(cause.code, 'NATIVE_HELPER_FAILED');
    return makeError(code, 'Native helper operation failed', cause);
  }

  let response;
  try {
    response = parseJsonOutput(partial);
  } catch {
    const code =
      cause.code === 'ENOENT'
        ? 'HELPER_MISSING'
        : safeCode(cause.code, 'NATIVE_HELPER_FAILED');
    return makeError(code, 'Native helper operation failed', cause);
  }
  if (
    (response.protocol === 1 || response.protocol === 2) &&
    response.ok === false
  ) {
    return makeHelperRefusal(
      safeCode(response.code),
      'Native helper refused the operation',
      cause
    );
  }
  const code =
    cause.code === 'ENOENT'
      ? 'HELPER_MISSING'
      : safeCode(cause.code, 'NATIVE_HELPER_FAILED');
  return makeError(code, 'Native helper operation failed', cause);
}

async function invokeMutationHelper(
  processRunner,
  nativeBinary,
  args,
  unknownCode,
  message,
  platform = process.platform
) {
  try {
    return await invokeHelper(processRunner, nativeBinary, args, platform);
  } catch (error) {
    if (
      (error.nativeRefusal === true &&
        !MUTATION_EFFECT_UNKNOWN_CODES.has(error.code)) ||
      [
        'HELPER_MISSING',
        'NATIVE_UNSUPPORTED',
        'NATIVE_HELPER_PATH_INVALID',
      ].includes(error.code)
    ) {
      throw error;
    }
    throw makeError(unknownCode, message, error);
  }
}

function validateProbe(value) {
  if (
    Object.keys(value).some((key) => !HELPER_PROBE_FIELDS.has(key)) ||
    value.protocol !== 1 ||
    value.ok !== true ||
    typeof value.regular !== 'boolean' ||
    typeof value.acl !== 'boolean' ||
    typeof value.sparse !== 'boolean' ||
    (value.attributes !== undefined &&
      (!Array.isArray(value.attributes) ||
        value.attributes.length > XATTR_MAX_COUNT)) ||
    !Number.isSafeInteger(value.mode) ||
    !Number.isSafeInteger(value.uid) ||
    !Number.isSafeInteger(value.gid) ||
    !Number.isSafeInteger(value.nlink) ||
    !Number.isSafeInteger(value.flags) ||
    !UNSIGNED_DECIMAL_PATTERN.test(value.device ?? '') ||
    !UNSIGNED_DECIMAL_PATTERN.test(value.inode ?? '') ||
    !UNSIGNED_DECIMAL_PATTERN.test(value.size ?? '') ||
    !SIGNED_DECIMAL_PATTERN.test(value.mtimeNs ?? '') ||
    !SIGNED_DECIMAL_PATTERN.test(value.ctimeNs ?? '') ||
    !SIGNED_DECIMAL_PATTERN.test(value.atimeNs ?? '')
  ) {
    throw makeError(
      'NATIVE_HELPER_INVALID_RESPONSE',
      'Native metadata response is incomplete'
    );
  }
  const size = Number(value.size);
  if (!Number.isSafeInteger(size) || size < 0) {
    throw makeError(
      'FILE_SIZE_UNSUPPORTED',
      'Dependency file size is not safely representable'
    );
  }
  return { ...value, size };
}

function statRecord(info) {
  if (
    typeof info.dev !== 'bigint' ||
    typeof info.ino !== 'bigint' ||
    typeof info.size !== 'bigint' ||
    typeof info.mtimeNs !== 'bigint' ||
    typeof info.ctimeNs !== 'bigint' ||
    typeof info.atimeNs !== 'bigint'
  ) {
    throw makeError(
      'METADATA_UNAVAILABLE',
      'Nanosecond file metadata is unavailable'
    );
  }
  const size = Number(info.size);
  const mode = Number(info.mode);
  const uid = Number(info.uid);
  const gid = Number(info.gid);
  const nlink = Number(info.nlink);
  if (![size, mode, uid, gid, nlink].every(Number.isSafeInteger) || size < 0) {
    throw makeError(
      'METADATA_UNAVAILABLE',
      'File metadata is not safely representable'
    );
  }
  return {
    atimeNs: String(info.atimeNs),
    ctimeNs: String(info.ctimeNs),
    device: String(info.dev),
    gid,
    inode: String(info.ino),
    mode,
    mtimeNs: String(info.mtimeNs),
    nlink,
    size,
    uid,
  };
}

function sameStableStat(left, right, { includeAtime = false } = {}) {
  return (
    left.device === right.device &&
    left.inode === right.inode &&
    left.size === right.size &&
    left.mode === right.mode &&
    left.uid === right.uid &&
    left.gid === right.gid &&
    left.nlink === right.nlink &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs &&
    (!includeAtime || left.atimeNs === right.atimeNs)
  );
}

function ineligibleProbeReason(probe) {
  if (!probe.regular) {
    return 'not-regular-file';
  }
  if (probe.nlink !== 1) {
    return 'hard-linked-file';
  }
  if (process.getuid && probe.uid !== process.getuid()) {
    return 'not-owned-by-current-user';
  }
  // biome-ignore lint/suspicious/noBitwiseOperators: Unix mode bits use bit masks.
  if ((probe.mode & 0o6000) !== 0) {
    return 'setuid-or-setgid';
  }
  if (probe.acl) {
    return 'acl-present';
  }
  if (probe.flags !== 0) {
    return 'file-flags-present';
  }
  if (probe.sparse) {
    return 'sparse-file';
  }
  return null;
}

function hashJson(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function attributesEqual(left, right) {
  if (!Array.isArray(left)) {
    return false;
  }
  if (!Array.isArray(right)) {
    return false;
  }
  if (left.length !== right.length) {
    return false;
  }
  const sort = (items) =>
    [...items].sort((a, b) => String(a?.name).localeCompare(String(b?.name)));
  return sort(left).every((item, index) => {
    const other = sort(right)[index];
    return item?.name === other?.name && item?.digest === other?.digest;
  });
}

function validFingerprint(value) {
  return Boolean(
    value &&
      typeof value === 'object' &&
      Number.isSafeInteger(value.size) &&
      value.size >= 0 &&
      Number.isSafeInteger(value.mode) &&
      value.mode >= 0 &&
      Number.isSafeInteger(value.uid) &&
      value.uid >= 0 &&
      Number.isSafeInteger(value.gid) &&
      value.gid >= 0 &&
      UNSIGNED_DECIMAL_PATTERN.test(value.device ?? '') &&
      UNSIGNED_DECIMAL_PATTERN.test(value.inode ?? '') &&
      SIGNED_DECIMAL_PATTERN.test(value.mtimeNs ?? '') &&
      SIGNED_DECIMAL_PATTERN.test(value.ctimeNs ?? '') &&
      SIGNED_DECIMAL_PATTERN.test(value.atimeNs ?? '') &&
      SHA256_PATTERN.test(value.contentHash ?? '') &&
      SHA256_PATTERN.test(value.metadataHash ?? '') &&
      SHA256_PATTERN.test(value.identityHash ?? '') &&
      Array.isArray(value.attributes) &&
      value.attributes.length <= XATTR_MAX_COUNT &&
      new Set(value.attributes.map((attribute) => attribute?.name)).size ===
        value.attributes.length &&
      value.attributes.every(
        (attribute) =>
          SUPPORTED_ATTRIBUTES.has(attribute?.name) &&
          SHA256_PATTERN.test(attribute.digest ?? '')
      )
  );
}

export function sameDependencyFile(left, right, { identity = false } = {}) {
  if (!validFingerprint(left)) {
    return false;
  }
  if (!validFingerprint(right)) {
    return false;
  }
  const sameMetadata =
    left.size === right.size &&
    left.mode === right.mode &&
    left.uid === right.uid &&
    left.gid === right.gid &&
    left.mtimeNs === right.mtimeNs &&
    left.contentHash === right.contentHash &&
    left.metadataHash === right.metadataHash &&
    attributesEqual(left.attributes, right.attributes);
  if (!sameMetadata) {
    return false;
  }
  return (
    !identity ||
    (left.device === right.device &&
      left.inode === right.inode &&
      left.ctimeNs === right.ctimeNs &&
      left.identityHash === right.identityHash)
  );
}

function fingerprintFrom(probe, relativePath, contentHash, attributes) {
  const attributeRows = [...attributes].sort((a, b) =>
    a.name.localeCompare(b.name)
  );
  const metadataHash = hashJson([
    probe.mode,
    probe.uid,
    probe.gid,
    probe.mtimeNs,
    attributeRows,
  ]);
  const identityHash = hashJson([
    probe.device,
    probe.inode,
    probe.size,
    probe.mtimeNs,
    probe.ctimeNs,
    contentHash,
    metadataHash,
  ]);
  return {
    atimeNs: probe.atimeNs,
    attributes: attributeRows,
    contentHash,
    ctimeNs: probe.ctimeNs,
    device: probe.device,
    gid: probe.gid,
    identityHash,
    inode: probe.inode,
    metadataHash,
    mode: probe.mode,
    mtimeNs: probe.mtimeNs,
    relativePath,
    size: probe.size,
    uid: probe.uid,
  };
}

function decodeAttributeHex(output) {
  if (typeof output !== 'string') {
    throw makeError(
      'ATTRIBUTE_UNREADABLE',
      'Extended attribute could not be read'
    );
  }
  const compact = output.replace(WHITESPACE_PATTERN, '');
  if (!ATTRIBUTE_HEX_PATTERN.test(compact)) {
    throw makeError(
      'ATTRIBUTE_UNREADABLE',
      'Extended attribute encoding is invalid'
    );
  }
  const value = Buffer.from(compact, 'hex');
  if (value.byteLength > XATTR_VALUE_MAX_BYTES) {
    throw makeError(
      'ATTRIBUTE_TOO_LARGE',
      'Extended attribute exceeds the supported bound'
    );
  }
  return value;
}

async function readAttributes(processRunner, filePath) {
  let listed;
  try {
    listed = await processRunner(XATTR_BINARY, ['-s', filePath], {
      maxBuffer: XATTR_LIST_MAX_BYTES,
      timeout: PROCESS_TIMEOUT_MS,
    });
  } catch (cause) {
    throw makeError(
      'ATTRIBUTE_UNREADABLE',
      'Extended attributes could not be enumerated',
      cause
    );
  }
  const { stdout } = listed;
  if (
    typeof stdout !== 'string' ||
    Buffer.byteLength(stdout) > XATTR_LIST_MAX_BYTES
  ) {
    throw makeError(
      'ATTRIBUTE_TOO_LARGE',
      'Extended attribute list exceeds the supported bound'
    );
  }
  const names = stdout.split(ATTRIBUTE_LINE_PATTERN).filter(Boolean);
  if (names.length > XATTR_MAX_COUNT) {
    throw makeError('ATTRIBUTE_TOO_LARGE', 'Too many extended attributes');
  }
  if (new Set(names).size !== names.length) {
    throw makeError(
      'ATTRIBUTE_UNREADABLE',
      'Extended attribute list contains duplicate names'
    );
  }
  if (names.some((name) => !ATTRIBUTE_NAME_PATTERN.test(name))) {
    throw makeError(
      'UNKNOWN_ATTRIBUTE',
      'Extended attribute name is unsupported'
    );
  }
  names.sort();
  if (names.some((name) => !SUPPORTED_ATTRIBUTES.has(name))) {
    throw makeError(
      'UNKNOWN_ATTRIBUTE',
      'Extended attribute name is unsupported'
    );
  }

  let totalBytes = 0;
  const attributes = [];
  for (const name of names) {
    let result;
    try {
      // biome-ignore lint/performance/noAwaitInLoops: bounded xattr reads remain sequential and preserve attribute order.
      result = await processRunner(
        XATTR_BINARY,
        ['-s', '-p', '-x', name, filePath],
        {
          maxBuffer: XATTR_VALUE_MAX_BYTES * 2 + 1024,
          timeout: PROCESS_TIMEOUT_MS,
        }
      );
    } catch (cause) {
      throw makeError(
        'ATTRIBUTE_UNREADABLE',
        'Extended attribute value could not be read',
        cause
      );
    }
    if (
      typeof result?.stdout !== 'string' ||
      Buffer.byteLength(result.stdout) > XATTR_VALUE_MAX_BYTES * 2 + 1024
    ) {
      throw makeError(
        'ATTRIBUTE_TOO_LARGE',
        'Extended attribute output exceeds the supported bound'
      );
    }
    const value = decodeAttributeHex(result?.stdout);
    totalBytes += value.byteLength;
    if (totalBytes > XATTR_TOTAL_MAX_BYTES) {
      throw makeError(
        'ATTRIBUTE_TOO_LARGE',
        'Extended attribute data exceeds the supported bound'
      );
    }
    attributes.push({
      digest: createHash('sha256').update(value).digest('hex'),
      name,
    });
  }
  return attributes;
}

function digestProbeAttributes(rows) {
  if (!Array.isArray(rows) || rows.length > XATTR_MAX_COUNT) {
    throw makeError(
      'ATTRIBUTE_UNREADABLE',
      'Extended attribute response is invalid'
    );
  }
  let totalBytes = 0;
  const attributes = rows.map((row) => {
    if (
      !row ||
      typeof row.name !== 'string' ||
      !SUPPORTED_ATTRIBUTES.has(row.name)
    ) {
      throw makeError(
        'UNKNOWN_ATTRIBUTE',
        'Extended attribute name is unsupported'
      );
    }
    const value = decodeAttributeHex(row.valueHex);
    totalBytes += value.byteLength;
    if (totalBytes > XATTR_TOTAL_MAX_BYTES) {
      throw makeError(
        'ATTRIBUTE_TOO_LARGE',
        'Extended attribute data exceeds the supported bound'
      );
    }
    return {
      digest: createHash('sha256').update(value).digest('hex'),
      name: row.name,
    };
  });
  if (new Set(attributes.map(({ name }) => name)).size !== attributes.length) {
    throw makeError(
      'ATTRIBUTE_UNREADABLE',
      'Extended attribute list contains duplicate names'
    );
  }
  return attributes;
}

async function hashFileHandle(handle, size) {
  const hash = createHash('sha256');
  const buffer = Buffer.allocUnsafe(
    Math.min(HASH_CHUNK_BYTES, Math.max(1, size))
  );
  let position = 0;
  while (position < size) {
    const length = Math.min(buffer.byteLength, size - position);
    // biome-ignore lint/performance/noAwaitInLoops: streamed chunks must be read in file order.
    const { bytesRead } = await handle.read(buffer, 0, length, position);
    if (bytesRead <= 0) {
      throw makeError(
        'FILE_CHANGED',
        'Dependency file ended before its saved size'
      );
    }
    hash.update(buffer.subarray(0, bytesRead));
    position += bytesRead;
  }
  return hash.digest('hex');
}

function assertEligibleProbe(probe) {
  const reason = ineligibleProbeReason(probe);
  if (reason) {
    const codeByReason = {
      'acl-present': 'ACL_PRESENT',
      'file-flags-present': 'FILE_FLAGS_PRESENT',
      'hard-linked-file': 'HARD_LINKED',
      'not-owned-by-current-user': 'OWNER_MISMATCH',
      'setuid-or-setgid': 'SET_ID_MODE',
      'sparse-file': 'SPARSE_FILE',
    };
    throw makeError(
      codeByReason[reason] ?? 'NOT_REGULAR_FILE',
      'Dependency file metadata is unsupported'
    );
  }
}

function statsMatchProbe(stats, probe, includeAtime) {
  const record = statRecord(stats);
  return sameStableStat(record, probe, { includeAtime });
}

function throwOperation(code, message, cause) {
  throw makeError(code, message, cause);
}

async function copyDependencyFileStrictly(sourcePath, destinationPath, flags) {
  try {
    await copyFile(sourcePath, destinationPath, flags);
  } catch (cause) {
    let destinationExists = false;
    try {
      await lstat(destinationPath);
      destinationExists = true;
    } catch (inspectError) {
      if (inspectError.code !== 'ENOENT') {
        throw makeError(
          'CLONE_UNKNOWN',
          'Strict clone failed and destination state is uncertain',
          inspectError
        );
      }
    }
    if (destinationExists) {
      throw makeError(
        'CLONE_UNKNOWN',
        'Strict clone failed after creating a destination; the entry was retained',
        cause
      );
    }
    throw makeError(
      errorCode(cause, 'STRICT_CLONE_FAILED'),
      'Strict copy-on-write clone failed',
      cause
    );
  }
}

function assertCloneCopyMatches({ cloned, expected, source, sourceAfter }) {
  if (!cloned.eligible) {
    throwOperation(
      'CLONE_VERIFICATION_FAILED',
      'Clone or source changed during verification'
    );
  }
  if (cloned.fingerprint.device !== source.fingerprint.device) {
    throwOperation(
      'CLONE_VERIFICATION_FAILED',
      'Clone or source changed during verification'
    );
  }
  if (cloned.fingerprint.inode === source.fingerprint.inode) {
    throwOperation(
      'CLONE_VERIFICATION_FAILED',
      'Clone or source changed during verification'
    );
  }
  if (!sameDependencyFile(cloned.fingerprint, expected)) {
    throwOperation(
      'CLONE_VERIFICATION_FAILED',
      'Clone or source changed during verification'
    );
  }
  if (!sourceAfter.eligible) {
    throwOperation(
      'CLONE_VERIFICATION_FAILED',
      'Clone or source changed during verification'
    );
  }
  if (
    !sameDependencyFile(sourceAfter.fingerprint, expected, { identity: true })
  ) {
    throwOperation(
      'CLONE_VERIFICATION_FAILED',
      'Clone or source changed during verification'
    );
  }
}

function assertRestoredCloneRead(restored, cloned, expected) {
  if (!restored.eligible) {
    throwOperation(
      'CLONE_VERIFICATION_FAILED',
      'Clone changed after timestamp restoration'
    );
  }
  if (restored.fingerprint.device !== cloned.fingerprint.device) {
    throwOperation(
      'CLONE_VERIFICATION_FAILED',
      'Clone changed after timestamp restoration'
    );
  }
  if (restored.fingerprint.inode !== cloned.fingerprint.inode) {
    throwOperation(
      'CLONE_VERIFICATION_FAILED',
      'Clone changed after timestamp restoration'
    );
  }
  if (!sameDependencyFile(restored.fingerprint, expected)) {
    throwOperation(
      'CLONE_VERIFICATION_FAILED',
      'Clone changed after timestamp restoration'
    );
  }
}

function assertRestoredCloneMetadata(
  restoredProbe,
  clonedFingerprint,
  expected
) {
  assertEligibleProbe(restoredProbe);
  if (restoredProbe.device !== clonedFingerprint.device) {
    throwOperation(
      'CLONE_METADATA_MISMATCH',
      'Clone metadata changed during timestamp restoration'
    );
  }
  if (restoredProbe.inode !== clonedFingerprint.inode) {
    throwOperation(
      'CLONE_METADATA_MISMATCH',
      'Clone metadata changed during timestamp restoration'
    );
  }
  if (restoredProbe.size !== clonedFingerprint.size) {
    throwOperation(
      'CLONE_METADATA_MISMATCH',
      'Clone metadata changed during timestamp restoration'
    );
  }
  if (restoredProbe.mode !== clonedFingerprint.mode) {
    throwOperation(
      'CLONE_METADATA_MISMATCH',
      'Clone metadata changed during timestamp restoration'
    );
  }
  if (restoredProbe.uid !== clonedFingerprint.uid) {
    throwOperation(
      'CLONE_METADATA_MISMATCH',
      'Clone metadata changed during timestamp restoration'
    );
  }
  if (restoredProbe.gid !== clonedFingerprint.gid) {
    throwOperation(
      'CLONE_METADATA_MISMATCH',
      'Clone metadata changed during timestamp restoration'
    );
  }
  if (restoredProbe.mtimeNs !== expected.mtimeNs) {
    throwOperation(
      'CLONE_METADATA_MISMATCH',
      'Clone metadata changed during timestamp restoration'
    );
  }
  if (restoredProbe.atimeNs !== expected.atimeNs) {
    throwOperation(
      'CLONE_METADATA_MISMATCH',
      'Clone metadata changed during timestamp restoration'
    );
  }
}

async function verifyClonedDependencyFile({
  clonedRead,
  destinationRelativePath,
  destinationRoot,
  expectedFingerprint,
  probe,
  readDependencyFile,
  restoreDependencyTimes,
  sameSourceRead,
  source,
}) {
  assertCloneCopyMatches({
    cloned: clonedRead,
    expected: expectedFingerprint,
    source,
    sourceAfter: sameSourceRead,
  });
  await restoreDependencyTimes(destinationRoot, destinationRelativePath, {
    atimeNs: expectedFingerprint.atimeNs,
    mtimeNs: expectedFingerprint.mtimeNs,
  });
  const restoredRead = await readDependencyFile(
    destinationRoot,
    destinationRelativePath
  );
  assertRestoredCloneRead(restoredRead, clonedRead, expectedFingerprint);
  await restoreDependencyTimes(destinationRoot, destinationRelativePath, {
    atimeNs: expectedFingerprint.atimeNs,
    mtimeNs: expectedFingerprint.mtimeNs,
  });
  const restoredProbe = await probe(destinationRoot, destinationRelativePath);
  assertRestoredCloneMetadata(
    restoredProbe,
    clonedRead.fingerprint,
    expectedFingerprint
  );
  return fingerprintFrom(
    restoredProbe,
    destinationRelativePath,
    clonedRead.fingerprint.contentHash,
    clonedRead.fingerprint.attributes
  );
}

export function createDependencyFileNative({
  nativeBinary = DEFAULT_NATIVE_BINARY,
  processRunner = runProcess,
  versionRunner = processRunner,
  spawnProcess = spawn,
  // Explicit OS and one-shot seams let tests exercise the real stdio worker off macOS.
  workerTimeoutMs = PROCESS_TIMEOUT_MS,
  platformForTesting = process.platform,
} = {}) {
  const worker =
    processRunner === runProcess
      ? new NativeHelperWorker(nativeBinary, spawnProcess)
      : null;
  const leaseStorage = new AsyncLocalStorage();
  const factoryIdentity = {};
  let leaseTail = Promise.resolve();
  // Injected runners are a test seam only; production locking requires the stdio worker.
  const productionWorker = Boolean(worker);
  const runHelper = (binary, args, options) => {
    const context = leaseStorage.getStore();
    if (args[0] === 'version') {
      return versionRunner(binary, args, options);
    }
    if (
      context?.factory === factoryIdentity &&
      (context.poisoned ||
        (worker &&
          (worker.leaseContext !== context ||
            (context.acquiring && args[0] !== 'lease-acquire'))))
    ) {
      return Promise.reject(
        makeError('LEASE_POISONED', 'Native helper lease is no longer valid')
      );
    }
    if (
      worker?.leaseContext &&
      (context?.factory !== factoryIdentity ||
        context !== worker.leaseContext ||
        context.poisoned)
    ) {
      return Promise.reject(
        makeError('LEASE_BUSY', 'Native helper is held by another lease')
      );
    }
    return worker && binary === nativeBinary && args[0] !== 'version'
      ? worker.run(args, { ...options, timeout: workerTimeoutMs })
      : processRunner(binary, args, options);
  };

  function assertMutationLease() {
    if (!productionWorker) {
      return; // Explicit processRunner injection is a nonproduction test seam.
    }
    const context = leaseStorage.getStore();
    if (
      !context ||
      context.factory !== factoryIdentity ||
      context !== worker.leaseContext ||
      !context.acquired ||
      context.acquiring ||
      context.poisoned ||
      context.key !== worker.leaseKey
    ) {
      throw makeError(
        context?.poisoned ? 'LEASE_POISONED' : 'LEASE_REQUIRED',
        'Native file mutations require the active helper lease'
      );
    }
  }

  async function withDependencyFileLease(
    storeRootInput,
    checkoutPathInput,
    work
  ) {
    if (typeof work !== 'function') {
      throw makeError(
        'LEASE_CALLBACK_INVALID',
        'Lease work must be a function'
      );
    }
    const parentContext = leaseStorage.getStore();
    const storeRoot = await canonicalDirectory(storeRootInput);
    const checkoutPath = await canonicalDirectory(checkoutPathInput);
    const storeInfo = await lstat(storeRoot);
    if (
      (typeof process.getuid === 'function' &&
        storeInfo.uid !== process.getuid()) ||
      // biome-ignore lint/suspicious/noBitwiseOperators: POSIX permission bits require a mask.
      (storeInfo.mode & 0o077) !== 0 ||
      !storeInfo.isDirectory()
    ) {
      throw makeError(
        'LEASE_ROOT_PRIVATE_REQUIRED',
        'Lease store root must be a private directory owned by the current user'
      );
    }
    const key = createHash('sha256').update(checkoutPath).digest('hex');
    if (parentContext?.factory === factoryIdentity) {
      if (parentContext.key !== key || parentContext.storeRoot !== storeRoot) {
        throw makeError(
          'LEASE_NESTED_CROSS_KEY',
          'A native lease cannot be nested for another checkout'
        );
      }
      if (parentContext.poisoned) {
        throw makeError('LEASE_POISONED', 'Native helper lease is poisoned');
      }
      return work();
    }
    const runLease = async () => {
      const context = {
        acquired: false,
        acquiring: false,
        factory: factoryIdentity,
        key,
        poisoned: false,
        storeRoot,
        worker,
      };
      const status = await dependencyFileNativeStatus();
      if (!status.available) {
        throw makeError(status.code, status.reason);
      }
      return leaseStorage.run(context, () => executeLease(context, work));
    };
    const result = leaseTail.then(runLease, runLease);
    leaseTail = result.catch(() => undefined);
    return result;
  }

  async function executeLease(context, work) {
    const outcome = await captureLeaseWork(context, work);
    if (context.acquired && !context.poisoned) {
      try {
        await releaseLease(context);
      } catch (error) {
        context.poisoned = true;
        context.poisonReason = 'LEASE_RELEASE_UNKNOWN';
        if (worker) {
          await worker.abandonLease(context);
        }
        throw error;
      }
    } else if (context.acquired && worker) {
      await worker.abandonLease(context);
    }
    if (!outcome.ok) {
      throw outcome.error;
    }
    return outcome.value;
  }

  async function captureLeaseWork(context, work) {
    try {
      await acquireLease(context);
      return { ok: true, value: await work() };
    } catch (error) {
      return { error, ok: false };
    }
  }

  async function acquireLease(context) {
    if (worker) {
      clearTimeout(worker.idleTimer);
      worker.leaseContext = context;
      worker.leaseKey = context.key;
    }
    context.acquiring = true;
    try {
      const response = await invokeHelper(
        runHelper,
        nativeBinary,
        ['lease-acquire', context.storeRoot, context.key],
        platformForTesting
      );
      if (
        response.protocol !== 2 ||
        response.lease !== 'acquired' ||
        response.key !== context.key
      ) {
        throw makeError(
          'NATIVE_HELPER_INVALID_RESPONSE',
          'Native helper did not confirm the lease'
        );
      }
      context.acquired = true;
      context.acquiring = false;
    } catch (error) {
      context.acquiring = false;
      context.poisoned = true;
      context.poisonReason = 'LEASE_ACQUIRE_UNKNOWN';
      if (worker) {
        await worker.abandonLease(context);
      }
      throw error;
    }
  }

  async function releaseLease(context) {
    const response = await invokeHelper(
      runHelper,
      nativeBinary,
      ['lease-release', context.key],
      platformForTesting
    );
    if (
      response.protocol !== 2 ||
      response.lease !== 'released' ||
      response.key !== context.key
    ) {
      throw makeError(
        'LEASE_RELEASE_UNKNOWN',
        'Native helper did not confirm lease release'
      );
    }
    if (worker) {
      worker.leaseContext = null;
      worker.leaseKey = null;
      const { child: current, generation } = worker;
      if (current) {
        worker.idleTimer = setTimeout(
          () => worker.terminate(current, generation),
          HELPER_IDLE_TIMEOUT_MS
        );
      }
    }
  }

  async function probe(root, relativePath) {
    const response = await invokeHelper(
      runHelper,
      nativeBinary,
      ['probe', root, relativePath],
      platformForTesting
    );
    const probeValue = validateProbe(response);
    if (worker && !Array.isArray(probeValue.attributes)) {
      throw makeError(
        'NATIVE_HELPER_INVALID_RESPONSE',
        'Native metadata response omits attributes'
      );
    }
    return probeValue;
  }

  async function readDependencyFile(rootInput, relativePath) {
    let handle;
    try {
      const segments = validateRelativePath(relativePath);
      const root = await canonicalDirectory(rootInput);
      const target = await assertNoSymlinkPath(root, segments);
      const before = await probe(root, relativePath);
      assertEligibleProbe(before);
      const noFollow = fsConstants.O_NOFOLLOW;
      if (!Number.isInteger(noFollow)) {
        throw makeError(
          'NATIVE_UNSUPPORTED',
          'No-follow file opens are unavailable'
        );
      }
      handle = await open(
        target.path,
        combineNativeFlags(fsConstants.O_RDONLY, noFollow)
      );
      const descriptorBefore = await handle.stat({ bigint: true });
      if (!descriptorBefore.isFile()) {
        throw makeError(
          'FILE_CHANGED',
          'Dependency file changed before it could be read'
        );
      }
      if (!statsMatchProbe(descriptorBefore, before, true)) {
        throw makeError(
          'FILE_CHANGED',
          'Dependency file changed before it could be read'
        );
      }
      const contentHash = await hashFileHandle(handle, before.size);
      const descriptorAfter = await handle.stat({ bigint: true });
      if (!statsMatchProbe(descriptorAfter, before, false)) {
        throw makeError(
          'FILE_CHANGED',
          'Dependency file changed while it was read'
        );
      }
      const attributes = worker
        ? digestProbeAttributes(before.attributes)
        : await readAttributes(processRunner, target.path);
      const after = await probe(root, relativePath);
      if (!sameStableStat(before, after)) {
        throw makeError(
          'FILE_CHANGED',
          'Dependency file changed while metadata was read'
        );
      }
      assertEligibleProbe(after);
      return {
        eligible: true,
        fingerprint: fingerprintFrom(
          before,
          relativePath,
          contentHash,
          attributes
        ),
      };
    } catch (error) {
      return { eligible: false, reason: toReason(error) };
    } finally {
      await handle?.close().catch(() => undefined);
    }
  }

  async function restoreDependencyTimes(
    rootInput,
    relativePath,
    { atimeNs, mtimeNs } = {}
  ) {
    assertMutationLease();
    const segments = validateRelativePath(relativePath);
    const root = await canonicalDirectory(rootInput);
    await assertNoSymlinkPath(root, segments);
    if (!SIGNED_DECIMAL_PATTERN.test(atimeNs ?? '')) {
      throwOperation('TIMESTAMP_INVALID', 'Nanosecond timestamps are invalid');
    }
    if (!SIGNED_DECIMAL_PATTERN.test(mtimeNs ?? '')) {
      throwOperation('TIMESTAMP_INVALID', 'Nanosecond timestamps are invalid');
    }
    const before = await probe(root, relativePath);
    assertEligibleProbe(before);
    const attributesBefore = worker
      ? digestProbeAttributes(before.attributes)
      : await readAttributes(processRunner, join(root, ...segments));
    const response = await invokeMutationHelper(
      runHelper,
      nativeBinary,
      [
        'restore-times',
        root,
        relativePath,
        atimeNs,
        mtimeNs,
        before.device,
        before.inode,
        String(before.size),
        before.ctimeNs,
      ],
      'TIMESTAMP_RESTORE_UNKNOWN',
      'Timestamp restoration may have completed without a confirmed result',
      platformForTesting
    );
    const attributesAfter = worker
      ? digestProbeAttributes((await probe(root, relativePath)).attributes)
      : await readAttributes(processRunner, join(root, ...segments));
    const after = await probe(root, relativePath);
    assertEligibleProbe(after);
    if (
      response.restored !== true ||
      response.atimeNs !== atimeNs ||
      response.mtimeNs !== mtimeNs ||
      response.device !== before.device ||
      response.inode !== before.inode ||
      after.device !== before.device ||
      after.inode !== before.inode ||
      after.size !== before.size ||
      after.atimeNs !== atimeNs ||
      after.mtimeNs !== mtimeNs ||
      !attributesEqual(attributesBefore, attributesAfter)
    ) {
      throwOperation(
        'TIMESTAMP_RESTORE_UNKNOWN',
        'Native helper did not confirm exact timestamp restoration'
      );
    }
    return { atimeNs, mtimeNs, restored: true };
  }

  async function dependencyFileNativeStatus({
    nativeBinary: binary = nativeBinary,
  } = {}) {
    if (platformForTesting !== 'darwin') {
      return {
        available: false,
        code: 'NATIVE_UNSUPPORTED',
        reason: 'Native dependency-file operations require macOS',
      };
    }
    try {
      const response = await invokeHelper(
        runHelper,
        binary,
        ['version'],
        platformForTesting
      );
      if (
        response.protocol !== 2 ||
        response.version !== '2' ||
        !Array.isArray(response.capabilities) ||
        response.capabilities.length !== HELPER_CAPABILITIES.length ||
        response.capabilities.some(
          (capability, index) => capability !== HELPER_CAPABILITIES[index]
        )
      ) {
        return {
          available: false,
          code: 'NATIVE_VERSION_UNSUPPORTED',
          reason: 'Installed helper version is unsupported',
        };
      }
      return { available: true };
    } catch (error) {
      const code = errorCode(error, 'NATIVE_HELPER_UNAVAILABLE');
      let statusCode = code;
      let reason = 'Installed native helper is unavailable or incompatible';
      if (code === 'HELPER_MISSING') {
        statusCode = 'NATIVE_HELPER_MISSING';
        reason = 'Native helper has not been built or installed';
      } else if (code === 'NATIVE_UNSUPPORTED') {
        reason = 'Native dependency-file operations require macOS';
      }
      return {
        available: false,
        code: statusCode,
        reason,
      };
    }
  }

  async function cloneDependencyFile(
    sourceRootInput,
    sourceRelativePath,
    destinationRootInput,
    destinationRelativePath,
    expectedFingerprint
  ) {
    assertMutationLease();
    const sourceSegments = validateRelativePath(sourceRelativePath);
    const destinationSegments = validateRelativePath(destinationRelativePath);
    const [sourceRoot, destinationRoot] = await Promise.all([
      canonicalDirectory(sourceRootInput),
      canonicalDirectory(destinationRootInput),
    ]);
    const sourceTarget = await assertNoSymlinkPath(sourceRoot, sourceSegments);
    const destinationTarget = await assertNoSymlinkPath(
      destinationRoot,
      destinationSegments,
      {
        leafMayBeMissing: true,
      }
    );
    if (destinationTarget.exists) {
      throwOperation('EEXIST', 'Clone destination already exists');
    }
    if (!validFingerprint(expectedFingerprint)) {
      throwOperation(
        'EXPECTED_FINGERPRINT_INVALID',
        'Expected source fingerprint is invalid'
      );
    }

    const source = await readDependencyFile(sourceRoot, sourceRelativePath);
    if (!source.eligible) {
      throwOperation(
        'SOURCE_CHANGED',
        'Clone source no longer matches its reviewed identity'
      );
    }
    if (
      !sameDependencyFile(source.fingerprint, expectedFingerprint, {
        identity: true,
      })
    ) {
      throwOperation(
        'SOURCE_CHANGED',
        'Clone source no longer matches its reviewed identity'
      );
    }
    const [sourceParent, destinationParent] = await Promise.all([
      stat(dirname(sourceTarget.path), { bigint: true }),
      stat(dirname(destinationTarget.path), { bigint: true }),
    ]);
    if (sourceParent.dev !== destinationParent.dev) {
      throwOperation(
        'EXDEV',
        'Strict clone source and destination are on different volumes'
      );
    }
    if (fsConstants.COPYFILE_FICLONE_FORCE === undefined) {
      throwOperation(
        'NATIVE_UNSUPPORTED',
        'Forced copy-on-write clone flags are unavailable'
      );
    }
    if (fsConstants.COPYFILE_EXCL === undefined) {
      throwOperation(
        'NATIVE_UNSUPPORTED',
        'Exclusive copy-on-write clone flags are unavailable'
      );
    }
    const cloneFlags = combineNativeFlags(
      fsConstants.COPYFILE_FICLONE_FORCE,
      fsConstants.COPYFILE_EXCL
    );
    await copyDependencyFileStrictly(
      sourceTarget.path,
      destinationTarget.path,
      cloneFlags
    );

    const [clonedRead, sameSourceRead] = await Promise.all([
      readDependencyFile(destinationRoot, destinationRelativePath),
      readDependencyFile(sourceRoot, sourceRelativePath),
    ]);
    return verifyClonedDependencyFile({
      clonedRead,
      destinationRelativePath,
      destinationRoot,
      expectedFingerprint,
      probe,
      readDependencyFile,
      restoreDependencyTimes,
      sameSourceRead,
      source,
    });
  }

  async function exchangeDependencyFiles(
    rootInput,
    targetRelativePath,
    temporaryRelativePath,
    { nativeBinary: binary = nativeBinary, parentDevice, parentInode } = {}
  ) {
    assertMutationLease();
    const targetSegments = validateRelativePath(targetRelativePath);
    const temporarySegments = validateRelativePath(temporaryRelativePath);
    const root = await canonicalDirectory(rootInput);
    if (
      targetSegments.length !== temporarySegments.length ||
      targetSegments.slice(0, -1).join('/') !==
        temporarySegments.slice(0, -1).join('/') ||
      targetSegments.at(-1) === temporarySegments.at(-1)
    ) {
      throwOperation(
        'EXCHANGE_PATH_INVALID',
        'Atomic exchange requires two distinct sibling entries'
      );
    }
    const target = await assertNoSymlinkPath(root, targetSegments);
    const temporary = await assertNoSymlinkPath(root, temporarySegments);
    if (!target.info.isFile()) {
      throwOperation(
        'EXCHANGE_FILE_INVALID',
        'Atomic exchange entries must be regular files'
      );
    }
    if (!temporary.info.isFile()) {
      throwOperation(
        'EXCHANGE_FILE_INVALID',
        'Atomic exchange entries must be regular files'
      );
    }
    if (!UNSIGNED_DECIMAL_PATTERN.test(parentDevice ?? '')) {
      throwOperation(
        'PARENT_IDENTITY_INVALID',
        'Atomic exchange parent identity is invalid'
      );
    }
    if (!UNSIGNED_DECIMAL_PATTERN.test(parentInode ?? '')) {
      throwOperation(
        'PARENT_IDENTITY_INVALID',
        'Atomic exchange parent identity is invalid'
      );
    }
    const parentPath = dirname(target.path);
    const parentInfo = await lstat(parentPath, { bigint: true });
    if (
      String(parentInfo.dev) !== parentDevice ||
      String(parentInfo.ino) !== parentInode ||
      parentInfo.isSymbolicLink() ||
      !parentInfo.isDirectory()
    ) {
      throwOperation(
        'PARENT_CHANGED',
        'Atomic exchange parent no longer matches its reviewed identity'
      );
    }
    const response = await invokeMutationHelper(
      runHelper,
      binary,
      [
        'swap',
        root,
        targetRelativePath,
        temporaryRelativePath,
        parentDevice,
        parentInode,
      ],
      'EXCHANGE_UNKNOWN',
      'Atomic exchange may have completed without a confirmed result',
      platformForTesting
    );
    if (response.exchanged !== true) {
      throwOperation(
        'EXCHANGE_UNKNOWN',
        'Native helper did not confirm the atomic exchange'
      );
    }
    return { exchanged: true };
  }

  async function syncDependencyDirectory(path) {
    const canonical = await canonicalDirectory(path);
    if (!Number.isInteger(fsConstants.O_DIRECTORY)) {
      throwOperation(
        'NATIVE_UNSUPPORTED',
        'No-follow directory opens are unavailable'
      );
    }
    if (!Number.isInteger(fsConstants.O_NOFOLLOW)) {
      throwOperation(
        'NATIVE_UNSUPPORTED',
        'No-follow directory opens are unavailable'
      );
    }
    const handle = await open(
      canonical,
      combineNativeFlags(
        fsConstants.O_RDONLY,
        fsConstants.O_DIRECTORY,
        fsConstants.O_NOFOLLOW
      )
    );
    try {
      const before = await handle.stat({ bigint: true });
      if (!before.isDirectory()) {
        throwOperation(
          'NOT_DIRECTORY',
          'Durability sync target is not a directory'
        );
      }
      await handle.sync();
      const after = await handle.stat({ bigint: true });
      if (before.dev !== after.dev || before.ino !== after.ino) {
        throwOperation(
          'DIRECTORY_CHANGED',
          'Directory identity changed during durability sync'
        );
      }
    } catch (cause) {
      if (cause.code) {
        throw cause;
      }
      throw makeError(
        'DIRECTORY_SYNC_UNKNOWN',
        'Directory durability sync did not complete',
        cause
      );
    } finally {
      await handle.close().catch(() => undefined);
    }
  }

  async function removeDependencyBackup(
    rootInput,
    relativePath,
    expectedFingerprint
  ) {
    assertMutationLease();
    if (!validFingerprint(expectedFingerprint)) {
      throwOperation(
        'EXPECTED_FINGERPRINT_INVALID',
        'Expected backup fingerprint is invalid'
      );
    }
    const segments = validateRelativePath(relativePath);
    const root = await canonicalDirectory(rootInput);
    const target = await assertNoSymlinkPath(root, segments);
    if (!target.info.isFile()) {
      throwOperation(
        'BACKUP_NOT_REGULAR',
        'Reviewed backup is no longer a regular file'
      );
    }
    const current = await readDependencyFile(root, relativePath);
    if (!current.eligible) {
      throwOperation(
        'BACKUP_CHANGED',
        'Reviewed backup no longer matches its saved identity'
      );
    }
    if (
      !sameDependencyFile(current.fingerprint, expectedFingerprint, {
        identity: true,
      })
    ) {
      throwOperation(
        'BACKUP_CHANGED',
        'Reviewed backup no longer matches its saved identity'
      );
    }
    try {
      await unlink(target.path);
    } catch (cause) {
      throw makeError(
        errorCode(cause, 'BACKUP_REMOVE_UNKNOWN'),
        'Reviewed backup removal is uncertain',
        cause
      );
    }
    try {
      await syncDependencyDirectory(dirname(target.path));
    } catch (cause) {
      throw makeError(
        'BACKUP_REMOVE_UNKNOWN',
        'Backup was unlinked but directory sync is uncertain',
        cause
      );
    }
    return { removed: true };
  }

  return {
    [Symbol.asyncDispose]: () =>
      worker ? worker.close({ terminal: true }) : Promise.resolve(),
    cloneDependencyFile,
    close: () => (worker ? worker.close() : Promise.resolve()),
    dependencyFileNativeStatus,
    exchangeDependencyFiles,
    readDependencyFile,
    removeDependencyBackup,
    restoreDependencyTimes,
    sameDependencyFile,
    syncDependencyDirectory,
    withDependencyFileLease,
  };
}

const defaultNative = createDependencyFileNative();
const defaultReadDependencyFile = defaultNative.readDependencyFile;
const defaultCloneDependencyFile = defaultNative.cloneDependencyFile;
const defaultExchangeDependencyFiles = defaultNative.exchangeDependencyFiles;
const defaultSyncDependencyDirectory = defaultNative.syncDependencyDirectory;
const defaultRemoveDependencyBackup = defaultNative.removeDependencyBackup;
const defaultDependencyFileNativeStatus =
  defaultNative.dependencyFileNativeStatus;
const defaultRestoreDependencyTimes = defaultNative.restoreDependencyTimes;
const closeDependencyFileNative = defaultNative.close;
const defaultWithDependencyFileLease = defaultNative.withDependencyFileLease;

export {
  closeDependencyFileNative,
  defaultCloneDependencyFile as cloneDependencyFile,
  defaultDependencyFileNativeStatus as dependencyFileNativeStatus,
  defaultExchangeDependencyFiles as exchangeDependencyFiles,
  defaultReadDependencyFile as readDependencyFile,
  defaultRemoveDependencyBackup as removeDependencyBackup,
  defaultRestoreDependencyTimes as restoreDependencyTimes,
  defaultSyncDependencyDirectory as syncDependencyDirectory,
  defaultWithDependencyFileLease as withDependencyFileLease,
};
