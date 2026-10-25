import { createHash, randomUUID } from 'node:crypto';
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { redactSpansValue } from './spans-redaction.js';

const MEDIA_TYPES = new Set(['text/plain', 'application/json']);
const PRIVATE_MODE = 0o700;
const FILE_MODE = 0o600;
const NOFOLLOW = constants.O_NOFOLLOW ?? 0;
const TEMP_ARTIFACT_PATTERN = /^\.tmp-[0-9a-f-]+$/;
const ARTIFACT_ID_PATTERN = /^sha256:[a-f0-9]{64}$/;

const SAFE_ERRORS = new Map([
  ['ARTIFACT_TEXT_INVALID', 'Artifact text must be a string.'],
  [
    'ARTIFACT_MEDIA_TYPE_INVALID',
    'Media type must be text/plain or application/json.',
  ],
  ['ARTIFACT_JSON_INVALID', 'JSON artifacts must contain valid JSON.'],
  [
    'ARTIFACT_ID_INVALID',
    'Artifact ID must be sha256 followed by 64 lowercase hexadecimal characters.',
  ],
  ['ARTIFACT_ROOT_INVALID', 'Artifact root must be an owner-only directory.'],
  [
    'ARTIFACT_DIRECTORY_INVALID',
    'Artifact directory must be an owner-only directory.',
  ],
  ['ARTIFACT_DIRECTORY_MISSING', 'Artifact directory does not exist.'],
  ['ARTIFACT_INVALID', 'Artifact blob is not a private regular file.'],
  ['ARTIFACT_CORRUPT', 'Artifact envelope or digest is invalid.'],
  ['ARTIFACT_NOT_FOUND', 'Artifact was not found.'],
  ['ARTIFACT_WRITE_FAILED', 'Artifact could not be written.'],
  ['ARTIFACT_READ_FAILED', 'Artifact could not be read.'],
]);

function failure(code, recoveryArtifact) {
  const safeCode = SAFE_ERRORS.has(code) ? code : 'ARTIFACT_READ_FAILED';
  const result = {
    code: safeCode,
    error: SAFE_ERRORS.get(safeCode),
    ok: false,
  };
  if (
    typeof recoveryArtifact === 'string' &&
    TEMP_ARTIFACT_PATTERN.test(recoveryArtifact)
  ) {
    result.recoveryArtifact = recoveryArtifact;
  }
  return result;
}

function safeFailure(error, operation) {
  if (error?.code === 'ARTIFACT_DIRECTORY_MISSING') {
    return failure(error.code);
  }
  if (
    error?.code === 'ARTIFACT_ROOT_INVALID' ||
    error?.code === 'ARTIFACT_DIRECTORY_INVALID' ||
    error?.code === 'ARTIFACT_INVALID' ||
    error?.code === 'ARTIFACT_CORRUPT'
  ) {
    return failure(error.code);
  }
  if (error?.code === 'ENOENT') {
    return failure(
      operation === 'read' ? 'ARTIFACT_NOT_FOUND' : 'ARTIFACT_WRITE_FAILED'
    );
  }
  return failure(
    operation === 'read' ? 'ARTIFACT_READ_FAILED' : 'ARTIFACT_WRITE_FAILED'
  );
}

function privateDirectory(path) {
  const stat = lstatSync(path);
  return (
    stat.isDirectory() &&
    !stat.isSymbolicLink() &&
    stat.mode % 0o1000 === PRIVATE_MODE &&
    (typeof process.getuid !== 'function' || stat.uid === process.getuid())
  );
}

function ensureArtifactDirectory(root) {
  if (!privateDirectory(root)) {
    throw Object.assign(
      new Error('Artifact root must be an owner-only directory.'),
      { code: 'ARTIFACT_ROOT_INVALID' }
    );
  }
  const directory = join(root, 'artifacts');
  try {
    mkdirSync(directory, { mode: PRIVATE_MODE });
  } catch (error) {
    if (error.code !== 'EEXIST') {
      throw error;
    }
  }
  if (!privateDirectory(directory)) {
    throw Object.assign(
      new Error('Artifact directory must be an owner-only directory.'),
      { code: 'ARTIFACT_DIRECTORY_INVALID' }
    );
  }
  return directory;
}

function validateArtifactDirectory(root) {
  if (!privateDirectory(root)) {
    throw Object.assign(new Error('Artifact root is invalid.'), {
      code: 'ARTIFACT_ROOT_INVALID',
    });
  }
  const directory = join(root, 'artifacts');
  let exists = false;
  try {
    exists = privateDirectory(directory);
  } catch (error) {
    if (error.code !== 'ENOENT') {
      throw error;
    }
  }
  if (!exists) {
    let present = false;
    try {
      lstatSync(directory);
      present = true;
    } catch (error) {
      if (error.code !== 'ENOENT') {
        throw error;
      }
    }
    if (!present) {
      throw Object.assign(new Error('Artifact directory is missing.'), {
        code: 'ARTIFACT_DIRECTORY_MISSING',
      });
    }
    throw Object.assign(new Error('Artifact directory is invalid.'), {
      code: 'ARTIFACT_DIRECTORY_INVALID',
    });
  }
  return directory;
}

export function hashArtifact(mediaType, text) {
  return createHash('sha256')
    .update(mediaType)
    .update('\0')
    .update(text, 'utf8')
    .digest('hex');
}

function readBlob(path, expectedHash) {
  const stat = lstatSync(path);
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.mode % 0o1000 !== FILE_MODE ||
    (typeof process.getuid === 'function' && stat.uid !== process.getuid())
  ) {
    throw Object.assign(
      new Error('Artifact blob is not a private regular file.'),
      { code: 'ARTIFACT_INVALID' }
    );
  }
  const fd = openSync(path, constants.O_RDONLY + NOFOLLOW);
  let bytes;
  try {
    const opened = fstatSync(fd);
    if (
      !opened.isFile() ||
      opened.mode % 0o1000 !== FILE_MODE ||
      opened.ino !== stat.ino ||
      opened.dev !== stat.dev ||
      (typeof process.getuid === 'function' && opened.uid !== process.getuid())
    ) {
      throw Object.assign(
        new Error('Artifact changed while it was being opened.'),
        { code: 'ARTIFACT_INVALID' }
      );
    }
    bytes = readFileSync(fd);
  } finally {
    closeSync(fd);
  }

  let envelope;
  try {
    envelope = JSON.parse(bytes.toString('utf8'));
  } catch (error) {
    throw Object.assign(
      new Error('Artifact envelope is corrupt.', { cause: error }),
      { code: 'ARTIFACT_CORRUPT' }
    );
  }
  if (
    !envelope ||
    typeof envelope !== 'object' ||
    Array.isArray(envelope) ||
    envelope.version !== 1 ||
    !MEDIA_TYPES.has(envelope.mediaType) ||
    typeof envelope.text !== 'string' ||
    Object.keys(envelope).sort().join(',') !== 'mediaType,text,version' ||
    hashArtifact(envelope.mediaType, envelope.text) !== expectedHash
  ) {
    throw Object.assign(new Error('Artifact digest or envelope is invalid.'), {
      code: 'ARTIFACT_CORRUPT',
    });
  }
  return envelope;
}

function syncDirectory(path) {
  const fd = openSync(path, constants.O_RDONLY);
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

/** Create a content-addressed artifact store inside an existing private root. */
export function createSpansArtifacts({ root } = {}) {
  if (
    typeof root !== 'string' ||
    root.length === 0 ||
    !root.startsWith('/') ||
    root.includes('\0')
  ) {
    throw new TypeError(
      'createSpansArtifacts requires an absolute private root path.'
    );
  }
  const canonicalRoot = resolve(root);

  function directory() {
    return ensureArtifactDirectory(canonicalRoot);
  }

  function existingDirectory() {
    return validateArtifactDirectory(canonicalRoot);
  }

  function normalizeText(text, mediaType) {
    if (mediaType !== 'application/json') {
      return redactSpansValue(text);
    }
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      return failure('ARTIFACT_JSON_INVALID');
    }
    return JSON.stringify(redactSpansValue(parsed));
  }

  function findExisting(target, digest, artifactId) {
    try {
      const existing = readBlob(target, digest);
      return {
        artifactId,
        bytes: Buffer.byteLength(existing.text, 'utf8'),
        mediaType: existing.mediaType,
        ok: true,
      };
    } catch (error) {
      if (error.code !== 'ENOENT') {
        throw error;
      }
      return null;
    }
  }

  function publishTemp(
    tempPath,
    target,
    targetDir,
    envelope,
    digest,
    mediaType,
    safeText
  ) {
    const fd = openSync(
      tempPath,
      constants.O_WRONLY + constants.O_CREAT + constants.O_EXCL + NOFOLLOW,
      FILE_MODE
    );
    try {
      writeFileSync(fd, envelope);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }

    try {
      linkSync(tempPath, target);
    } catch (error) {
      if (error.code !== 'EEXIST') {
        throw error;
      }
      const existing = readBlob(target, digest);
      if (existing.mediaType !== mediaType || existing.text !== safeText) {
        throw Object.assign(
          new Error('Existing artifact does not match its content address.'),
          {
            code: 'ARTIFACT_CORRUPT',
          }
        );
      }
    }
    syncDirectory(targetDir);
    unlinkSync(tempPath);
    syncDirectory(targetDir);
  }

  function put({ text, mediaType } = {}) {
    let tempPath;
    try {
      if (typeof text !== 'string') {
        return failure('ARTIFACT_TEXT_INVALID');
      }
      if (!MEDIA_TYPES.has(mediaType)) {
        return failure('ARTIFACT_MEDIA_TYPE_INVALID');
      }
      const safeText = normalizeText(text, mediaType);
      if (typeof safeText !== 'string') {
        return safeText;
      }
      const digest = hashArtifact(mediaType, safeText);
      const artifactId = `sha256:${digest}`;
      const targetDir = directory();
      const target = join(targetDir, digest);

      const existing = findExisting(target, digest, artifactId);
      if (existing) {
        return existing;
      }

      const envelope = Buffer.from(
        JSON.stringify({ mediaType, text: safeText, version: 1 }),
        'utf8'
      );
      tempPath = join(targetDir, `.tmp-${randomUUID()}`);
      publishTemp(
        tempPath,
        target,
        targetDir,
        envelope,
        digest,
        mediaType,
        safeText
      );
      tempPath = undefined;
      return {
        artifactId,
        bytes: Buffer.byteLength(safeText, 'utf8'),
        mediaType,
        ok: true,
      };
    } catch (error) {
      // A temp left by an interrupted publication is intentionally preserved for recovery.
      const result = safeFailure(error, 'write');
      if (tempPath) {
        result.recoveryArtifact = tempPath.slice(tempPath.lastIndexOf('/') + 1);
      }
      return result;
    }
  }

  function read({ artifactId } = {}) {
    if (
      typeof artifactId !== 'string' ||
      !ARTIFACT_ID_PATTERN.test(artifactId)
    ) {
      return failure('ARTIFACT_ID_INVALID');
    }
    try {
      const digest = artifactId.slice('sha256:'.length);
      const envelope = readBlob(join(existingDirectory(), digest), digest);
      return { mediaType: envelope.mediaType, ok: true, text: envelope.text };
    } catch (error) {
      return safeFailure(error, 'read');
    }
  }

  return { put, read };
}
