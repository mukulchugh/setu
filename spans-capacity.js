import { lstat, readdir } from 'node:fs/promises';
import { isAbsolute, join, relative, sep } from 'node:path';

const DEFAULT_BUDGET_BYTES = 5 * 1024 ** 3;

const ERROR_MESSAGES = {
  BUDGET_INVALID: 'budgetBytes must be a positive safe integer',
  DIRECTORY_NOT_OWNER: 'archive directories must be owned by the current user',
  DIRECTORY_NOT_PRIVATE:
    'archive directory permissions must exclude group and other',
  EACCES: 'archive path is not accessible',
  ENOENT: 'archive path does not exist',
  ENOTDIR: 'archive path contains a non-directory component',
  EPERM: 'archive path is not accessible',
  NONREGULAR_FILE: 'archive must contain only regular files and directories',
  RESERVE_INVALID: 'reservedCaptureBytes must be a nonnegative safe integer',
  ROOT_INVALID: 'archive root must be an explicit existing directory',
  ROOT_NOT_OWNER: 'archive root must be owned by the current user',
  ROOT_NOT_PRIVATE: 'archive root permissions must exclude group and other',
  SIZE_INVALID: 'archive contains an invalid file size',
  SIZE_OVERFLOW: 'archive size exceeds the supported range',
  SYMLINK_UNSUPPORTED: 'archive must not contain symbolic links',
  UNREADABLE: 'archive could not be read',
};

function errorCode(error) {
  const code = error?.code;
  return Object.hasOwn(ERROR_MESSAGES, code) ? code : 'UNREADABLE';
}

function unknownError(error) {
  const code = errorCode(error);
  return unknown(code, ERROR_MESSAGES[code]);
}

function ownedByCurrentUser(stat) {
  return (
    typeof process.getuid !== 'function' ||
    stat.uid === BigInt(process.getuid())
  );
}

function hasPrivatePermissions(stat) {
  return stat.mode % 0o100n === 0n;
}

function unknown(code, error) {
  return { code, error, newLaunchAllowed: false, ok: false, state: 'unknown' };
}

function categoryFor(root, path) {
  const rel = relative(root, path);
  const parts = rel.split(sep);
  const name = parts.at(-1);
  if (parts[0] === 'artifacts') {
    return 'artifactBytes';
  }
  if (parts[0] === 'spool') {
    return 'spoolBytes';
  }
  if (
    parts.length === 1 &&
    [
      'spans.sqlite3',
      'spans.sqlite3-wal',
      'spans.sqlite3-shm',
      'spans.sqlite3-journal',
    ].includes(name)
  ) {
    return 'databaseBytes';
  }
  return 'otherBytes';
}

async function visitArchivePath(path, root, totals, seen) {
  const stat = await lstat(path, { bigint: true });
  if (stat.isSymbolicLink()) {
    throw Object.assign(new Error(`symbolic link encountered: ${path}`), {
      code: 'SYMLINK_UNSUPPORTED',
    });
  }
  if (stat.isDirectory()) {
    if (!ownedByCurrentUser(stat)) {
      throw Object.assign(new Error('Directory owner is invalid.'), {
        code: 'DIRECTORY_NOT_OWNER',
      });
    }
    if (!hasPrivatePermissions(stat)) {
      throw Object.assign(new Error('Directory permissions are not private.'), {
        code: 'DIRECTORY_NOT_PRIVATE',
      });
    }
    const entries = (await readdir(path)).sort();
    await entries.reduce(
      (pending, entry) =>
        pending.then(() =>
          visitArchivePath(join(path, entry), root, totals, seen)
        ),
      Promise.resolve()
    );
    return;
  }
  if (!stat.isFile()) {
    throw Object.assign(new Error(`non-regular file encountered: ${path}`), {
      code: 'NONREGULAR_FILE',
    });
  }
  const size = Number(stat.size);
  if (!Number.isSafeInteger(size) || size < 0) {
    throw Object.assign(new Error(`file size is not a safe integer: ${path}`), {
      code: 'SIZE_INVALID',
    });
  }
  const inode = `${stat.dev}:${stat.ino}`;
  if (seen.has(inode)) {
    return;
  }
  seen.add(inode);
  const key = categoryFor(root, path);
  const next = totals[key] + size;
  if (!Number.isSafeInteger(next)) {
    throw Object.assign(new Error('archive size exceeds safe integer range'), {
      code: 'SIZE_OVERFLOW',
    });
  }
  totals[key] = next;
}

export async function inspectSpansCapacity({
  root,
  budgetBytes = DEFAULT_BUDGET_BYTES,
  reservedCaptureBytes = 0,
} = {}) {
  if (typeof root !== 'string' || !isAbsolute(root)) {
    return unknown('ROOT_INVALID', 'root must be an explicit absolute path');
  }
  if (!Number.isSafeInteger(budgetBytes) || budgetBytes <= 0) {
    return unknown(
      'BUDGET_INVALID',
      'budgetBytes must be a positive safe integer'
    );
  }
  if (!Number.isSafeInteger(reservedCaptureBytes) || reservedCaptureBytes < 0) {
    return unknown(
      'RESERVE_INVALID',
      'reservedCaptureBytes must be a nonnegative safe integer'
    );
  }

  const totals = {
    artifactBytes: 0,
    databaseBytes: 0,
    otherBytes: 0,
    spoolBytes: 0,
  };
  const seen = new Set();

  try {
    const rootStat = await lstat(root, { bigint: true });
    if (rootStat.isSymbolicLink()) {
      return unknown(
        'SYMLINK_UNSUPPORTED',
        'archive root must not be a symbolic link'
      );
    }
    if (!rootStat.isDirectory()) {
      return unknown(
        'ROOT_INVALID',
        'archive root must be an existing directory'
      );
    }
    if (!hasPrivatePermissions(rootStat)) {
      return unknown(
        'ROOT_NOT_PRIVATE',
        'archive root permissions must exclude group and other'
      );
    }
    if (!ownedByCurrentUser(rootStat)) {
      return unknown('ROOT_NOT_OWNER', ERROR_MESSAGES.ROOT_NOT_OWNER);
    }
    await visitArchivePath(root, root, totals, seen);
  } catch (error) {
    return unknownError(error);
  }

  const totalBytes = Object.values(totals).reduce(
    (sum, value) => sum + value,
    0
  );
  const committedAndReserved = totalBytes + reservedCaptureBytes;
  if (
    !(
      Number.isSafeInteger(totalBytes) &&
      Number.isSafeInteger(committedAndReserved)
    )
  ) {
    return unknown(
      'SIZE_OVERFLOW',
      'archive size plus reserved capture exceeds safe integer range'
    );
  }
  return {
    ...totals,
    budgetBytes,
    newLaunchAllowed: committedAndReserved < budgetBytes,
    ok: true,
    reservedCaptureBytes,
    state: 'known',
    totalBytes,
    warning: BigInt(committedAndReserved) * 5n >= BigInt(budgetBytes) * 4n,
  };
}
