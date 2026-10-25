import { createHash } from 'node:crypto';
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { createSpansArtifacts } from './spans-artifacts.js';
import { redactSpansValue } from './spans-redaction.js';

const PRIVATE_MODE = 0o700;
const FILE_MODE = 0o600;
const NOFOLLOW = constants.O_NOFOLLOW ?? 0;
const HASH = /^[a-f0-9]{64}$/;
const ATTEMPT = /^[a-f0-9]{64}$/;
const CHUNK_NAME = /^chunk-(\d{8})\.json$/;
const MAX_CHUNK_BYTES = 4 * 1024 * 1024;
// The existing artifact writer takes a complete string, so cap materialization.
const MAX_ATTEMPT_BYTES = 64 * 1024 * 1024;
const MAX_ATTEMPT_CHUNKS = 65_536;
const LOCK_WAIT_MS = 2000;
const SAFE = Object.freeze({
  SPOOL_AUTHORITY_REQUIRED:
    'A serialized current-attempt authority is required for spool mutations.',
  SPOOL_CONFLICT: 'Spool sequence or finalization conflicts with stored data.',
  SPOOL_INVALID: 'Spool path or persisted record is unsafe.',
  SPOOL_IO: 'Spool operation could not be completed.',
  SPOOL_LIMIT: 'Spool size limit was reached.',
  SPOOL_MISMATCH: 'Spool request does not match its immutable attempt binding.',
});
const failure = (code) => ({ code, error: SAFE[code], ok: false });
const hash = (value) => createHash('sha256').update(value).digest('hex');
const digestBinding = (binding) =>
  hash(
    JSON.stringify([
      'spans.worker.attempt',
      binding.actionId,
      binding.attemptId,
      binding.generation,
      binding.runId,
      binding.spanId,
      binding.workerId,
    ])
  );
const bindingKeys = [
  'actionId',
  'attemptId',
  'generation',
  'runId',
  'spanId',
  'workerId',
];
const invalid = () =>
  Object.assign(new Error('Spool path or persisted record is unsafe.'), {
    code: 'SPOOL_INVALID',
  });
const conflict = () =>
  Object.assign(
    new Error('Spool sequence or finalization conflicts with stored data.'),
    { code: 'SPOOL_CONFLICT' }
  );

function privateDir(path) {
  const stat = lstatSync(path);
  return (
    stat.isDirectory() &&
    !stat.isSymbolicLink() &&
    stat.mode % 0o1000 === PRIVATE_MODE &&
    (typeof process.getuid !== 'function' || stat.uid === process.getuid())
  );
}

function ensureDir(path) {
  try {
    mkdirSync(path, { mode: PRIVATE_MODE });
  } catch (error) {
    if (error.code !== 'EEXIST') {
      throw error;
    }
  }
  if (!privateDir(path)) {
    throw invalid();
  }
}

function syncDir(path) {
  const fd = openSync(path, constants.O_RDONLY + NOFOLLOW);
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function readPrivate(path, maxBytes) {
  const before = lstatSync(path);
  if (
    !before.isFile() ||
    before.isSymbolicLink() ||
    before.nlink !== 1 ||
    before.mode % 0o1000 !== FILE_MODE ||
    before.size > maxBytes ||
    (typeof process.getuid === 'function' && before.uid !== process.getuid())
  ) {
    throw invalid();
  }
  const fd = openSync(path, constants.O_RDONLY + NOFOLLOW);
  try {
    const opened = fstatSync(fd);
    if (
      !opened.isFile() ||
      opened.nlink !== 1 ||
      opened.ino !== before.ino ||
      opened.dev !== before.dev ||
      opened.size !== before.size ||
      opened.mode % 0o1000 !== FILE_MODE ||
      (typeof process.getuid === 'function' && opened.uid !== process.getuid())
    ) {
      throw invalid();
    }
    const bytes = readFileSync(fd);
    if (bytes.byteLength !== opened.size || bytes.byteLength > maxBytes) {
      throw invalid();
    }
    return bytes;
  } finally {
    closeSync(fd);
  }
}

function writeOnce(path, data) {
  const fd = openSync(
    path,
    constants.O_WRONLY + constants.O_CREAT + constants.O_EXCL + NOFOLLOW,
    FILE_MODE
  );
  try {
    writeFileSync(fd, data);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

// The lock is deliberately fail-closed after a process crash. Reclaiming a
// lock from a PID alone can mistake a reused PID for the original owner.
function withProcessLock(dir, work) {
  const path = join(dir, 'effect.lock');
  const deadline = Date.now() + LOCK_WAIT_MS;
  let fd;
  while (fd === undefined) {
    try {
      fd = openSync(
        path,
        constants.O_WRONLY + constants.O_CREAT + constants.O_EXCL + NOFOLLOW,
        FILE_MODE
      );
      const record = Buffer.from(`${process.pid}\n${Date.now()}\n`);
      writeFileSync(fd, record);
      fsyncSync(fd);
      syncDir(dir);
    } catch (error) {
      if (fd !== undefined) {
        try {
          closeSync(fd);
        } catch {
          // Closing a partially opened lock is best effort; preserve the original failure.
        }
        fd = undefined;
      }
      if (error.code !== 'EEXIST') {
        throw error;
      }
      if (Date.now() >= deadline) {
        throw conflict();
      }
      // These operations are synchronous by contract. Yield briefly so a
      // second local process can finish its short critical section.
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
    }
  }
  const opened = fstatSync(fd);
  try {
    return work();
  } finally {
    closeSync(fd);
    const current = lstatSync(path);
    // The lock identity check must override a successful callback if ownership changed.
    if (
      !current.isFile() ||
      current.isSymbolicLink() ||
      current.ino !== opened.ino ||
      current.dev !== opened.dev
    ) {
      // biome-ignore lint/correctness/noUnsafeFinally: fail closed if the lock path was replaced.
      throw invalid();
    }
    unlinkSync(path);
    syncDir(dir);
  }
}

// link() publishes a complete synced record without replacing an existing one.
// The temporary file has two links only during this controlled publish window.
function publish(dir, name, data, maxBytes, validateExisting) {
  const tmp = join(
    dir,
    `.tmp-${process.pid}-${hash(`${Date.now()}-${Math.random()}`).slice(0, 24)}`
  );
  try {
    writeOnce(tmp, data);
    try {
      linkSync(tmp, join(dir, name));
    } catch (error) {
      if (error.code !== 'EEXIST') {
        throw error;
      }
      const existing = readPrivate(join(dir, name), maxBytes);
      if (!validateExisting(existing)) {
        throw conflict();
      }
    }
    syncDir(dir);
  } finally {
    try {
      unlinkSync(tmp);
    } catch (error) {
      if (error.code !== 'ENOENT') {
        // biome-ignore lint/correctness/noUnsafeFinally: failed temp cleanup must not be hidden.
        throw error;
      }
    }
  }
  syncDir(dir);
}

function safeError(error) {
  return failure(
    [
      'SPOOL_INVALID',
      'SPOOL_MISMATCH',
      'SPOOL_CONFLICT',
      'SPOOL_LIMIT',
    ].includes(error?.code)
      ? error.code
      : 'SPOOL_IO'
  );
}

/** Durable filesystem implementation of spans-worker.js's append/finalize/stat contract. */
export function createSpansWorkerSpool({
  root,
  withCurrentAttempt,
  maxChunkBytes = MAX_CHUNK_BYTES,
  maxAttemptBytes = MAX_ATTEMPT_BYTES,
  maxAttemptChunks = MAX_ATTEMPT_CHUNKS,
} = {}) {
  if (
    typeof root !== 'string' ||
    !root.startsWith('/') ||
    root.includes('\0') ||
    !Number.isSafeInteger(maxChunkBytes) ||
    maxChunkBytes < 1 ||
    maxChunkBytes > MAX_CHUNK_BYTES ||
    !Number.isSafeInteger(maxAttemptBytes) ||
    maxAttemptBytes < maxChunkBytes ||
    maxAttemptBytes > MAX_ATTEMPT_BYTES ||
    !Number.isSafeInteger(maxAttemptChunks) ||
    maxAttemptChunks < 1 ||
    maxAttemptChunks > MAX_ATTEMPT_CHUNKS
  ) {
    throw new TypeError(
      'createSpansWorkerSpool requires an absolute private root and bounded limits.'
    );
  }
  const base = resolve(root);
  const spoolRoot = join(base, 'worker-spool');
  const artifacts = createSpansArtifacts({ root: base });

  function dirs(digest, create = false) {
    if (typeof digest !== 'string' || !ATTEMPT.test(digest)) {
      throw Object.assign(
        new Error(
          'Spool request does not match its immutable attempt binding.'
        ),
        { code: 'SPOOL_MISMATCH' }
      );
    }
    if (!privateDir(base)) {
      throw invalid();
    }
    if (create) {
      ensureDir(spoolRoot);
      ensureDir(join(spoolRoot, digest));
    } else if (
      !(privateDir(spoolRoot) && privateDir(join(spoolRoot, digest)))
    ) {
      throw invalid();
    }
    return join(spoolRoot, digest);
  }

  function parseBinding(value, attemptDigest) {
    if (
      !value ||
      typeof value !== 'object' ||
      Array.isArray(value) ||
      value.version !== 1 ||
      !value.binding ||
      typeof value.binding !== 'object' ||
      Array.isArray(value.binding) ||
      Object.keys(value.binding).sort().join(',') !==
        [...bindingKeys].sort().join(',') ||
      !Number.isSafeInteger(value.generation) ||
      value.generation < 0 ||
      value.binding.generation !== value.generation ||
      bindingKeys.some(
        (key) =>
          key !== 'generation' &&
          (typeof value.binding[key] !== 'string' ||
            redactSpansValue(value.binding[key]) !== value.binding[key])
      ) ||
      digestBinding(value.binding) !== attemptDigest
    ) {
      throw invalid();
    }
    return value;
  }

  function readBinding(dir, attemptDigest) {
    const raw = readPrivate(join(dir, 'binding.json'), 4096);
    let parsed;
    try {
      parsed = JSON.parse(raw.toString('utf8'));
    } catch (error) {
      throw Object.assign(invalid(), { cause: error });
    }
    return parseBinding(parsed, attemptDigest);
  }

  function identity(payload, create = false) {
    if (
      !(payload?.binding && Number.isSafeInteger(payload.generation)) ||
      payload.generation < 0 ||
      payload.binding.generation !== payload.generation ||
      Object.keys(payload.binding).sort().join(',') !==
        [...bindingKeys].sort().join(',') ||
      bindingKeys.some(
        (key) =>
          key !== 'generation' &&
          (typeof payload.binding[key] !== 'string' ||
            redactSpansValue(payload.binding[key]) !== payload.binding[key])
      ) ||
      digestBinding(payload.binding) !== payload.attemptDigest
    ) {
      throw Object.assign(
        new Error(
          'Spool request does not match its immutable attempt binding.'
        ),
        { code: 'SPOOL_MISMATCH' }
      );
    }
    const dir = dirs(payload.attemptDigest, create);
    const binding = Object.fromEntries(
      bindingKeys.map((key) => [key, payload.binding[key]])
    );
    const bytes = Buffer.from(
      JSON.stringify({ binding, generation: payload.generation, version: 1 }),
      'utf8'
    );
    publish(dir, 'binding.json', bytes, 4096, (old) => old.equals(bytes));
    const persisted = readBinding(dir, payload.attemptDigest);
    if (
      persisted.generation !== payload.generation ||
      JSON.stringify(persisted.binding) !== JSON.stringify(binding)
    ) {
      throw Object.assign(
        new Error(
          'Spool request does not match its immutable attempt binding.'
        ),
        { code: 'SPOOL_MISMATCH' }
      );
    }
    return dir;
  }

  function readChunk(dir, seq) {
    const raw = readPrivate(
      join(dir, `chunk-${String(seq).padStart(8, '0')}.json`),
      maxChunkBytes * 8 + 4096
    );
    let parsed;
    try {
      parsed = JSON.parse(raw.toString('utf8'));
    } catch (error) {
      throw Object.assign(invalid(), { cause: error });
    }
    if (
      !parsed ||
      typeof parsed !== 'object' ||
      Array.isArray(parsed) ||
      Object.keys(parsed).sort().join(',') !==
        'bytes,digest,seq,text,version' ||
      parsed.version !== 1 ||
      parsed.seq !== seq ||
      !Number.isSafeInteger(parsed.bytes) ||
      parsed.bytes < 1 ||
      parsed.bytes > maxChunkBytes ||
      typeof parsed.text !== 'string' ||
      Buffer.byteLength(parsed.text, 'utf8') !== parsed.bytes ||
      typeof parsed.digest !== 'string' ||
      !HASH.test(parsed.digest) ||
      hash(parsed.text) !== parsed.digest ||
      redactSpansValue(parsed.text) !== parsed.text
    ) {
      throw invalid();
    }
    return parsed;
  }

  function scanChunks(dir) {
    const names = readdirSync(dir);
    const seqs = [];
    for (const name of names) {
      if (
        name === 'binding.json' ||
        name === 'finalized.json' ||
        name === 'effect.lock' ||
        name.startsWith('.tmp-')
      ) {
        continue;
      }
      const match = CHUNK_NAME.exec(name);
      if (!match) {
        throw invalid();
      }
      const seq = Number(match[1]);
      if (!Number.isSafeInteger(seq) || seq >= maxAttemptChunks) {
        throw invalid();
      }
      seqs.push(seq);
    }
    seqs.sort((a, b) => a - b);
    if (seqs.some((seq, index) => seq !== index)) {
      throw invalid();
    }
    return seqs.map((seq) => readChunk(dir, seq));
  }

  function readManifest(dir) {
    try {
      const raw = readPrivate(join(dir, 'finalized.json'), 4096);
      const manifest = JSON.parse(raw.toString('utf8'));
      if (
        !manifest ||
        typeof manifest !== 'object' ||
        Array.isArray(manifest) ||
        Object.keys(manifest).sort().join(',') !==
          'bytes,chainDigest,chunks,complete,version' ||
        manifest.version !== 1 ||
        !Number.isSafeInteger(manifest.bytes) ||
        manifest.bytes < 0 ||
        manifest.bytes > maxAttemptBytes ||
        !Number.isSafeInteger(manifest.chunks) ||
        manifest.chunks < 0 ||
        manifest.chunks > maxAttemptChunks ||
        typeof manifest.complete !== 'boolean' ||
        typeof manifest.chainDigest !== 'string' ||
        !HASH.test(manifest.chainDigest)
      ) {
        throw invalid();
      }
      return manifest;
    } catch (error) {
      if (error.code === 'ENOENT') {
        return null;
      }
      throw error;
    }
  }

  function summarize(dir, attemptDigest) {
    readBinding(dir, attemptDigest);
    const chunks = scanChunks(dir);
    const bytes = chunks.reduce((sum, chunk) => sum + chunk.bytes, 0);
    if (bytes > maxAttemptBytes) {
      throw invalid();
    }
    const manifest = readManifest(dir);
    if (manifest && !matchesManifest(manifest, chunks, bytes)) {
      throw invalid();
    }
    return { bytes, chunks, manifest };
  }

  function matchesManifest(manifest, chunks, bytes) {
    return (
      manifest.bytes === bytes &&
      manifest.chunks === chunks.length &&
      manifest.chainDigest ===
        hash(chunks.map((chunk) => chunk.digest).join('\n'))
    );
  }

  // `withCurrentAttempt(binding, effect)` must hold the coordinator's current
  // generation and open-attempt serialization boundary until `effect` ends,
  // and must invoke it at most once. It is synchronous: a point-in-time read
  // or a promise that releases the callback after returning is insufficient.
  function serializedEffect(payload, effect) {
    if (typeof withCurrentAttempt !== 'function') {
      return failure('SPOOL_AUTHORITY_REQUIRED');
    }
    let invoked = false;
    let gateOpen = true;
    let effectResult;
    try {
      const result = withCurrentAttempt({ ...payload.binding }, () => {
        if (!gateOpen || invoked) {
          throw conflict();
        }
        invoked = true;
        const dir = identity(payload, true);
        effectResult = withProcessLock(dir, effect);
        return effectResult;
      });
      if (result && typeof result.then === 'function') {
        // Consume a later rejection while refusing the unsupported async
        // authority contract. The gate closes synchronously in `finally`.
        Promise.resolve(result).catch(() => {
          // Async authorities are refused; consume later rejection to prevent an unhandled promise.
        });
        return failure('SPOOL_AUTHORITY_REQUIRED');
      }
      if (!invoked) {
        return result || failure('SPOOL_AUTHORITY_REQUIRED');
      }
      if (result !== effectResult) {
        return failure('SPOOL_IO');
      }
      if (result?.ok !== true) {
        return result || failure('SPOOL_IO');
      }
      return result;
    } catch (error) {
      return safeError(error);
    } finally {
      gateOpen = false;
    }
  }

  async function append(payload) {
    try {
      // Reject hostile sequence/size inputs before creating any path or allocating by seq.
      if (
        !(payload && Number.isSafeInteger(payload.seq)) ||
        payload.seq < 0 ||
        typeof payload.text !== 'string' ||
        !Number.isSafeInteger(payload.bytes) ||
        payload.bytes < 1 ||
        payload.bytes > maxChunkBytes ||
        payload.seq >= maxAttemptChunks ||
        Buffer.byteLength(payload.text, 'utf8') !== payload.bytes ||
        typeof payload.digest !== 'string' ||
        !HASH.test(payload.digest) ||
        hash(payload.text) !== payload.digest ||
        redactSpansValue(payload.text) !== payload.text
      ) {
        return failure(
          payload?.seq >= maxAttemptChunks ? 'SPOOL_LIMIT' : 'SPOOL_MISMATCH'
        );
      }
      // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: one bounded guard rejects invalid input before any spool I/O.
      return await serializedEffect(payload, () => {
        const dir = dirs(payload.attemptDigest, false);
        const state = summarize(dir, payload.attemptDigest);
        if (state.manifest) {
          return failure('SPOOL_CONFLICT');
        }
        if (payload.seq < state.chunks.length) {
          const old = state.chunks[payload.seq];
          return old.digest === payload.digest && old.text === payload.text
            ? { ok: true }
            : failure('SPOOL_CONFLICT');
        }
        if (payload.seq !== state.chunks.length) {
          return failure('SPOOL_CONFLICT');
        }
        if (state.bytes + payload.bytes > maxAttemptBytes) {
          return failure('SPOOL_LIMIT');
        }
        const record = {
          bytes: payload.bytes,
          digest: payload.digest,
          seq: payload.seq,
          text: payload.text,
          version: 1,
        };
        const data = Buffer.from(JSON.stringify(record), 'utf8');
        publish(
          dir,
          `chunk-${String(payload.seq).padStart(8, '0')}.json`,
          data,
          maxChunkBytes * 8 + 4096,
          (old) => old.equals(data)
        );
        const after = summarize(dir, payload.attemptDigest);
        if (
          after.manifest ||
          after.chunks.length !== payload.seq + 1 ||
          after.chunks[payload.seq].digest !== payload.digest
        ) {
          return failure('SPOOL_CONFLICT');
        }
        return { ok: true };
      });
    } catch (error) {
      return safeError(error);
    }
  }

  async function finalize(payload) {
    try {
      // Bound before directory access and before the chunk loop/materialization.
      if (
        !(payload && Number.isSafeInteger(payload.bytes)) ||
        payload.bytes < 0 ||
        payload.bytes > maxAttemptBytes ||
        !Number.isSafeInteger(payload.chunks) ||
        payload.chunks < 0 ||
        payload.chunks > maxAttemptChunks ||
        typeof payload.complete !== 'boolean' ||
        typeof payload.chainDigest !== 'string' ||
        !HASH.test(payload.chainDigest)
      ) {
        return failure(
          (payload?.bytes ?? 0) > maxAttemptBytes ||
            (payload?.chunks ?? 0) > maxAttemptChunks
            ? 'SPOOL_LIMIT'
            : 'SPOOL_MISMATCH'
        );
      }
      return await serializedEffect(payload, () => {
        const dir = dirs(payload.attemptDigest, false);
        const state = summarize(dir, payload.attemptDigest);
        if (
          state.chunks.length !== payload.chunks ||
          state.bytes !== payload.bytes ||
          hash(state.chunks.map((chunk) => chunk.digest).join('\n')) !==
            payload.chainDigest
        ) {
          return failure('SPOOL_MISMATCH');
        }
        const manifest = {
          bytes: payload.bytes,
          chainDigest: payload.chainDigest,
          chunks: payload.chunks,
          complete: payload.complete,
          version: 1,
        };
        const manifestBytes = Buffer.from(JSON.stringify(manifest), 'utf8');
        publish(dir, 'finalized.json', manifestBytes, 4096, (old) =>
          old.equals(manifestBytes)
        );
        const finalized = readManifest(dir);
        const after = summarize(dir, payload.attemptDigest);
        if (
          !(
            finalized && matchesManifest(finalized, after.chunks, after.bytes)
          ) ||
          finalized.complete !== payload.complete ||
          finalized.chainDigest !== payload.chainDigest
        ) {
          return failure('SPOOL_CONFLICT');
        }
        const text = after.chunks.map((chunk) => chunk.text).join('');
        const artifact = artifacts.put({ mediaType: 'text/plain', text });
        if (!artifact.ok) {
          return artifact;
        }
        return { artifactId: artifact.artifactId, ok: true };
      });
    } catch (error) {
      return safeError(error);
    }
  }

  function stat({ attemptDigest } = {}) {
    try {
      const dir = dirs(attemptDigest, false);
      const state = summarize(dir, attemptDigest);
      return { bytes: state.bytes, chunks: state.chunks.length, ok: true };
    } catch (error) {
      return safeError(error);
    }
  }

  return Object.freeze({ append, finalize, stat });
}
