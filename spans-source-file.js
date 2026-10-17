import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { validateSpansSourcePath } from './spans-redaction.js';

const DEFAULT_PAGE_BYTES = 256 * 1024;
const MAX_PAGE_BYTES = 4 * 1024 * 1024;
const HASH_CHUNK_BYTES = 64 * 1024;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const DECIMAL_PATTERN = /^\d+$/;
const SIGNED_DECIMAL_PATTERN = /^-?\d+$/;

function resultError(code, error) {
  return { code, error, ok: false };
}

function validOffset(offset) {
  return Number.isSafeInteger(offset) && offset >= 0;
}

function ownDataValue(object, key) {
  const descriptor = Object.getOwnPropertyDescriptor(object, key);
  if (descriptor === undefined) {
    return { found: false, present: false };
  }
  if (!Object.hasOwn(descriptor, 'value')) {
    return { found: false, present: true };
  }
  return { found: true, present: true, value: descriptor.value };
}

function normalizeIdentity(identity) {
  if (
    identity === null ||
    typeof identity !== 'object' ||
    Array.isArray(identity)
  ) {
    return null;
  }

  const device = ownDataValue(identity, 'device');
  const inode = ownDataValue(identity, 'inode');
  const birthtimeNs = ownDataValue(identity, 'birthtimeNs');
  const offset = ownDataValue(identity, 'offset');
  const prefixSha256 = ownDataValue(identity, 'prefixSha256');
  const readObservation = ownDataValue(identity, 'readObservation');
  if (
    !device.found ||
    typeof device.value !== 'string' ||
    !DECIMAL_PATTERN.test(device.value) ||
    !inode.found ||
    typeof inode.value !== 'string' ||
    !DECIMAL_PATTERN.test(inode.value) ||
    !birthtimeNs.found ||
    typeof birthtimeNs.value !== 'string' ||
    !SIGNED_DECIMAL_PATTERN.test(birthtimeNs.value) ||
    !offset.found ||
    !validOffset(offset.value) ||
    !prefixSha256.found ||
    typeof prefixSha256.value !== 'string' ||
    !SHA256_PATTERN.test(prefixSha256.value)
  ) {
    return null;
  }

  const normalized = {
    birthtimeNs: birthtimeNs.value,
    device: device.value,
    inode: inode.value,
    offset: offset.value,
    prefixSha256: prefixSha256.value,
  };
  if (!readObservation.present) {
    return normalized;
  }
  if (!readObservation.found) {
    return null;
  }
  const observation = readObservation.value;
  if (
    observation === null ||
    typeof observation !== 'object' ||
    Array.isArray(observation)
  ) {
    return null;
  }
  const observedOffset = ownDataValue(observation, 'offset');
  const observedPrefixSha256 = ownDataValue(observation, 'prefixSha256');
  if (
    observedOffset.found &&
    validOffset(observedOffset.value) &&
    observedOffset.value >= offset.value &&
    observedPrefixSha256.found &&
    typeof observedPrefixSha256.value === 'string' &&
    SHA256_PATTERN.test(observedPrefixSha256.value)
  ) {
    normalized.readObservation = {
      offset: observedOffset.value,
      prefixSha256: observedPrefixSha256.value,
    };
    return normalized;
  }
  return null;
}

function identityFor(stat, offset, prefixSha256, readObservation) {
  const identity = {
    birthtimeNs: stat.birthtimeNs.toString(),
    device: stat.dev.toString(),
    inode: stat.ino.toString(),
    offset,
    prefixSha256,
  };
  if (readObservation !== undefined) {
    identity.readObservation = readObservation;
  }
  return identity;
}

function stableFileIdentity(stat) {
  return {
    birthtimeNs: stat.birthtimeNs.toString(),
    device: stat.dev.toString(),
    inode: stat.ino.toString(),
  };
}

function sameStableFile(left, right) {
  const a = stableFileIdentity(left);
  const b = stableFileIdentity(right);
  return (
    a.device === b.device &&
    a.inode === b.inode &&
    a.birthtimeNs === b.birthtimeNs
  );
}

function sameObservedStat(left, right) {
  return (
    sameStableFile(left, right) &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}

function safeFileStat(stat) {
  return (
    stat.isFile() &&
    stat.size >= 0n &&
    stat.size <= BigInt(Number.MAX_SAFE_INTEGER)
  );
}

function isSymlinkError(error) {
  return error?.code === 'ELOOP';
}

function mapOpenError(error) {
  if (isSymlinkError(error)) {
    return resultError(
      'SOURCE_SYMLINK',
      'Source path must not resolve to a symbolic link.'
    );
  }
  return resultError('SOURCE_UNAVAILABLE', 'Source file could not be opened.');
}

function sameJsonIdentity(left, right) {
  return (
    left.device === right.device &&
    left.inode === right.inode &&
    left.birthtimeNs === right.birthtimeNs
  );
}

function pathStat(path) {
  return lstat(path, { bigint: true });
}

async function verifyPathStillNamesFile(path, descriptorStat) {
  let currentPathStat;
  try {
    currentPathStat = await pathStat(path);
  } catch {
    return false;
  }
  return (
    !currentPathStat.isSymbolicLink() &&
    currentPathStat.isFile() &&
    sameStableFile(currentPathStat, descriptorStat)
  );
}

async function readExact(handle, buffer, position) {
  let total = 0;
  while (total < buffer.length) {
    // Reads stay sequential because a short read advances file position.
    // biome-ignore lint/performance/noAwaitInLoops: Each read uses prior progress.
    const result = await handle.read(
      buffer,
      total,
      buffer.length - total,
      position + total
    );
    if (result.bytesRead === 0) {
      return total;
    }
    total += result.bytesRead;
  }
  return total;
}

async function hashPrefixes(handle, offsets) {
  const checkpoints = [...new Set(offsets)].sort((left, right) => left - right);
  const hashes = new Map();
  const hash = createHash('sha256');
  const buffer = Buffer.allocUnsafe(HASH_CHUNK_BYTES);
  let position = 0;
  for (const endOffset of checkpoints) {
    while (position < endOffset) {
      const length = Math.min(HASH_CHUNK_BYTES, endOffset - position);
      // Prefix hashing depends on each preceding chunk being read first.
      // biome-ignore lint/performance/noAwaitInLoops: Hash chunks require file order.
      const bytesRead = await readExact(
        handle,
        buffer.subarray(0, length),
        position
      );
      if (bytesRead !== length) {
        return null;
      }
      hash.update(buffer.subarray(0, length));
      position += length;
    }
    hashes.set(endOffset, hash.copy());
  }
  return hashes;
}

function validPath(path) {
  if (typeof path !== 'string' || !isAbsolute(path)) {
    return resultError('SOURCE_PATH_INVALID', 'Source path must be absolute.');
  }
  const validation = validateSpansSourcePath(path);
  return validation.ok ? null : resultError(validation.code, validation.error);
}

function validateExpectedIdentity(expectedIdentity, offset) {
  if (!expectedIdentity.present) {
    return offset === 0
      ? { identity: undefined, ok: true }
      : resultError(
          'SOURCE_IDENTITY_REQUIRED',
          'A checkpoint identity is required to resume a source read.'
        );
  }
  if (!expectedIdentity.found) {
    return resultError(
      'SOURCE_IDENTITY_INVALID',
      'Source checkpoint identity is invalid.'
    );
  }

  const identity = normalizeIdentity(expectedIdentity.value);
  if (identity === null) {
    return resultError(
      'SOURCE_IDENTITY_INVALID',
      'Source checkpoint identity is invalid.'
    );
  }
  if (identity.offset !== offset) {
    return resultError(
      'SOURCE_OFFSET_CONFLICT',
      'Requested offset does not match the checkpoint identity.'
    );
  }
  return { identity, ok: true };
}

function validReadInput(input) {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    return resultError('SOURCE_READ_INVALID', 'Invalid source read arguments.');
  }
  const path = ownDataValue(input, 'path');
  const offset = ownDataValue(input, 'offset');
  const expectedIdentity = ownDataValue(input, 'expectedIdentity');
  const maxBytesInput = ownDataValue(input, 'maxBytes');
  if (!(path.found && offset.found && validOffset(offset.value))) {
    return resultError('SOURCE_READ_INVALID', 'Invalid source read arguments.');
  }

  const pathError = validPath(path.value);
  if (pathError) {
    return pathError;
  }

  const identityValidation = validateExpectedIdentity(
    expectedIdentity,
    offset.value
  );
  if (!identityValidation.ok) {
    return identityValidation;
  }

  if (maxBytesInput.present && !maxBytesInput.found) {
    return resultError('SOURCE_READ_INVALID', 'Invalid source read arguments.');
  }
  const maxBytes =
    !maxBytesInput.found || maxBytesInput.value === undefined
      ? DEFAULT_PAGE_BYTES
      : maxBytesInput.value;
  if (
    !Number.isSafeInteger(maxBytes) ||
    maxBytes < 1 ||
    maxBytes > MAX_PAGE_BYTES
  ) {
    return resultError(
      'SOURCE_PAGE_SIZE_INVALID',
      'Source page size must be between 1 byte and 4 MiB.'
    );
  }
  return {
    expectedIdentity: identityValidation.identity,
    hasExpectedIdentity: expectedIdentity.present,
    maxBytes,
    offset: offset.value,
    ok: true,
    path: path.value,
  };
}

function validCheckpointInput(input) {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    return resultError(
      'SOURCE_CHECKPOINT_INVALID',
      'Invalid source checkpoint arguments.'
    );
  }

  const path = ownDataValue(input, 'path');
  const offset = ownDataValue(input, 'offset');
  const expectedIdentity = ownDataValue(input, 'expectedIdentity');
  if (!(path.found && offset.found && validOffset(offset.value))) {
    return resultError(
      'SOURCE_CHECKPOINT_INVALID',
      'Invalid source checkpoint arguments.'
    );
  }
  const pathError = validPath(path.value);
  if (pathError) {
    return pathError;
  }
  const normalizedExpectedIdentity = expectedIdentity.found
    ? normalizeIdentity(expectedIdentity.value)
    : null;
  if (!normalizedExpectedIdentity?.readObservation) {
    return resultError(
      'SOURCE_CHECKPOINT_INVALID',
      'Invalid source checkpoint arguments.'
    );
  }
  return {
    expectedIdentity: normalizedExpectedIdentity,
    observation: normalizedExpectedIdentity.readObservation,
    offset: offset.value,
    ok: true,
    path: path.value,
  };
}

async function openSelectedFile(path) {
  let beforeOpen;
  try {
    beforeOpen = await pathStat(path);
  } catch {
    return resultError('SOURCE_UNAVAILABLE', 'Source file is unavailable.');
  }
  if (beforeOpen.isSymbolicLink()) {
    return resultError(
      'SOURCE_SYMLINK',
      'Source path must not resolve to a symbolic link.'
    );
  }
  if (!beforeOpen.isFile()) {
    return resultError(
      'SOURCE_NOT_REGULAR',
      'Source path must name a regular file.'
    );
  }

  let canonicalPath;
  try {
    canonicalPath = await realpath(path);
  } catch {
    return resultError('SOURCE_UNAVAILABLE', 'Source file is unavailable.');
  }
  const canonicalPathError = validPath(canonicalPath);
  if (canonicalPathError) {
    return canonicalPathError;
  }

  let handle;
  try {
    handle = await open(
      path,
      constants.O_RDONLY + constants.O_NOFOLLOW + constants.O_NONBLOCK
    );
  } catch (error) {
    return mapOpenError(error);
  }

  let stat;
  try {
    stat = await handle.stat({ bigint: true });
  } catch {
    await handle.close();
    return resultError('SOURCE_UNAVAILABLE', 'Source file could not be read.');
  }
  if (!safeFileStat(stat)) {
    await handle.close();
    return resultError(
      stat.isFile() ? 'SOURCE_SIZE_UNSAFE' : 'SOURCE_NOT_REGULAR',
      stat.isFile()
        ? 'Source file size exceeds the safe byte range.'
        : 'Source path must name a regular file.'
    );
  }
  if (!sameStableFile(beforeOpen, stat)) {
    await handle.close();
    return resultError('SOURCE_CHANGED', 'Source file changed while opening.');
  }
  return { canonicalPath, handle, ok: true, stat };
}

async function finishRead(handle, path, canonicalPath, beforeStat) {
  let afterStat;
  try {
    afterStat = await handle.stat({ bigint: true });
  } catch {
    return resultError('SOURCE_CHANGED', 'Source file changed while reading.');
  }
  if (
    !(
      sameObservedStat(beforeStat, afterStat) &&
      (await verifyPathStillNamesFile(path, afterStat)) &&
      (await verifyPathStillNamesFile(canonicalPath, afterStat))
    )
  ) {
    return resultError('SOURCE_CHANGED', 'Source file changed while reading.');
  }
  return { ok: true };
}

function checkExpectedIdentity(expectedIdentity, stat) {
  if (!expectedIdentity) {
    return null;
  }
  if (!sameJsonIdentity(expectedIdentity, stableFileIdentity(stat))) {
    return resultError(
      'SOURCE_REPLACED',
      'Source file identity no longer matches its checkpoint.'
    );
  }
  if (stat.size < BigInt(expectedIdentity.offset)) {
    return resultError(
      'SOURCE_TRUNCATED',
      'Source file is shorter than its checkpoint.'
    );
  }
  return null;
}

/** Read one bounded page from a caller-selected native source file. */
export async function readSpansSourcePage(input) {
  let validation;
  try {
    validation = validReadInput(input);
  } catch {
    return resultError('SOURCE_READ_INVALID', 'Invalid source read arguments.');
  }
  if (!validation.ok) {
    return validation;
  }

  const opened = await openSelectedFile(validation.path);
  if (!opened.ok) {
    return opened;
  }
  const { canonicalPath, handle, stat } = opened;
  try {
    const expectedIdentity = validation.hasExpectedIdentity
      ? validation.expectedIdentity
      : null;
    const identityError = checkExpectedIdentity(expectedIdentity, stat);
    if (identityError) {
      return identityError;
    }
    if (validation.offset > Number(stat.size)) {
      return resultError(
        'SOURCE_TRUNCATED',
        'Source file is shorter than its offset.'
      );
    }

    const prefixHashes = await hashPrefixes(handle, [validation.offset]);
    if (prefixHashes === null) {
      return resultError(
        'SOURCE_CHANGED',
        'Source file changed while hashing.'
      );
    }
    const prefixHash = prefixHashes.get(validation.offset);
    const prefixSha256 = prefixHash.copy().digest('hex');
    if (expectedIdentity && prefixSha256 !== expectedIdentity.prefixSha256) {
      return resultError(
        'SOURCE_PREFIX_CHANGED',
        'Source content before the checkpoint has changed.'
      );
    }

    const pageLength = Math.min(
      validation.maxBytes,
      Number(stat.size) - validation.offset
    );
    if (!Number.isSafeInteger(validation.offset + pageLength)) {
      return resultError('SOURCE_SIZE_UNSAFE', 'Source byte range is unsafe.');
    }
    const bytes = new Uint8Array(pageLength);
    if (
      pageLength > 0 &&
      (await readExact(handle, bytes, validation.offset)) !== pageLength
    ) {
      return resultError(
        'SOURCE_CHANGED',
        'Source file changed while reading.'
      );
    }

    const finished = await finishRead(
      handle,
      validation.path,
      canonicalPath,
      stat
    );
    if (!finished.ok) {
      return finished;
    }

    const pageHash = prefixHash.copy();
    pageHash.update(bytes);
    const observedIdentity = identityFor(
      stat,
      validation.offset,
      prefixSha256,
      {
        offset: validation.offset + bytes.length,
        prefixSha256: pageHash.digest('hex'),
      }
    );
    return {
      bytes,
      eof: validation.offset + bytes.length === Number(stat.size),
      observedIdentity,
      ok: true,
    };
  } catch {
    return resultError(
      'SOURCE_READ_FAILED',
      'Source file could not be read safely.'
    );
  } finally {
    await handle.close().catch(() => undefined);
  }
}

/** Create a checkpoint identity through the byte offset already committed. */
export async function checkpointSpansSource(input) {
  let validation;
  try {
    validation = validCheckpointInput(input);
  } catch {
    return resultError(
      'SOURCE_CHECKPOINT_INVALID',
      'Invalid source checkpoint arguments.'
    );
  }
  if (!validation.ok) {
    return validation;
  }
  const { expectedIdentity, observation, offset, path } = validation;
  if (expectedIdentity.offset > offset || offset > observation.offset) {
    return resultError(
      'SOURCE_OFFSET_CONFLICT',
      'Committed offset is outside the observed source page.'
    );
  }

  const opened = await openSelectedFile(path);
  if (!opened.ok) {
    return opened;
  }
  const { canonicalPath, handle, stat } = opened;
  try {
    const identityError = checkExpectedIdentity(expectedIdentity, stat);
    if (identityError) {
      return identityError;
    }
    if (stat.size < BigInt(observation.offset)) {
      return resultError(
        'SOURCE_TRUNCATED',
        'Source file is shorter than the observed page.'
      );
    }

    const hashes = await hashPrefixes(handle, [
      expectedIdentity.offset,
      offset,
      observation.offset,
    ]);
    if (hashes === null) {
      return resultError(
        'SOURCE_CHANGED',
        'Source file changed while hashing.'
      );
    }
    const checkpointPrefixSha256 = hashes
      .get(expectedIdentity.offset)
      .copy()
      .digest('hex');
    if (checkpointPrefixSha256 !== expectedIdentity.prefixSha256) {
      return resultError(
        'SOURCE_PREFIX_CHANGED',
        'Source content before the checkpoint has changed.'
      );
    }
    const observedPrefixSha256 = hashes
      .get(observation.offset)
      .copy()
      .digest('hex');
    if (observedPrefixSha256 !== observation.prefixSha256) {
      return resultError(
        'SOURCE_PREFIX_CHANGED',
        'Source content read from the selected page has changed.'
      );
    }

    const prefixSha256 = hashes.get(offset).copy().digest('hex');
    const finished = await finishRead(handle, path, canonicalPath, stat);
    if (!finished.ok) {
      return finished;
    }
    return {
      identity: identityFor(stat, offset, prefixSha256),
      ok: true,
    };
  } catch {
    return resultError(
      'SOURCE_CHECKPOINT_FAILED',
      'Source checkpoint could not be computed safely.'
    );
  } finally {
    await handle.close().catch(() => undefined);
  }
}
