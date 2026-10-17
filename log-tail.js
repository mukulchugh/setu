import fs from 'node:fs';

const MAX_BYTES = 256 * 1024;
const UTF8_CONTINUATION_BYTE_MIN = 0x80;
const UTF8_CONTINUATION_BYTE_MAX = 0xc0;
const SAFE_CODES = new Set([
  'EACCES',
  'EPERM',
  'EIO',
  'EISDIR',
  'EMFILE',
  'ENFILE',
  'LOG_CHANGED',
]);

function readError(error, previous, observedAt) {
  if (error.code === 'ENOENT') {
    return {
      lines: [],
      observedAt,
      retained: false,
      state: 'missing',
      total: 0,
    };
  }
  const retained = Number.isFinite(previous?.successfulAt);
  return {
    code: SAFE_CODES.has(error.code) ? error.code : 'READ_FAILED',
    lines: retained ? previous.lines : [],
    observedAt,
    state: 'read-error',
    total: retained ? previous.total : 0,
    ...(retained
      ? { successfulAt: previous.successfulAt, truncated: previous.truncated }
      : {}),
    retained,
  };
}

export function readLogTail(
  path,
  lines = 150,
  { files = fs, now = Date.now, previous } = {}
) {
  const limit = Number.isFinite(lines)
    ? Math.max(1, Math.min(2000, Math.floor(lines)))
    : 150;
  let fd;
  try {
    fd = files.openSync(path, 'r');
    const { size } = files.fstatSync(fd);
    const offset = Math.max(0, size - MAX_BYTES);
    const buffer = Buffer.alloc(Math.min(size, MAX_BYTES));
    const count = buffer.length
      ? files.readSync(fd, buffer, 0, buffer.length, offset)
      : 0;
    if (count !== buffer.length) {
      throw Object.assign(new Error('Log changed during read'), {
        code: 'LOG_CHANGED',
      });
    }
    let start = 0;
    if (offset) {
      while (
        start < count &&
        buffer[start] >= UTF8_CONTINUATION_BYTE_MIN &&
        buffer[start] < UTF8_CONTINUATION_BYTE_MAX
      ) {
        start += 1;
      }
    }
    let text = buffer.subarray(start, count).toString('utf8');
    if (offset) {
      const end = text.indexOf('\n');
      text = end < 0 ? `[long line truncated] ${text}` : text.slice(end + 1);
    }
    if (text.endsWith('\n')) {
      text = text.slice(0, -1);
    }
    const all = text ? text.split('\n') : [];
    const tail = all.slice(-limit),
      observedAt = now();
    return {
      lines: tail,
      observedAt,
      retained: false,
      state: count ? 'ready' : 'empty',
      successfulAt: observedAt,
      total: tail.length,
      truncated: offset > 0 || all.length > limit,
    };
  } catch (error) {
    return readError(error, previous, now());
  } finally {
    if (fd !== undefined) {
      try {
        files.closeSync(fd);
      } catch {
        // Closing the read descriptor cannot replace the captured read outcome.
      }
    }
  }
}

export function logSignature(path, files = fs) {
  try {
    const { ino, mtimeMs, size } = files.statSync(path);
    return `${ino}:${size}:${mtimeMs}`;
  } catch (error) {
    return error.code === 'ENOENT' ? 'missing' : null;
  }
}

export function readLogSnapshot(entry, path, options = {}) {
  let resolvedPath = path;
  try {
    if (typeof resolvedPath === 'function') {
      resolvedPath = resolvedPath();
    }
  } catch (error) {
    entry.signature = null;
    entry.snapshot = readError(
      error,
      entry.snapshot,
      (options.now ?? Date.now)()
    );
    return entry.snapshot;
  }
  const signature = logSignature(resolvedPath, options.files);
  if (
    signature !== null &&
    signature === entry.signature &&
    entry.snapshot?.state !== 'read-error'
  ) {
    return null;
  }
  entry.snapshot = readLogTail(resolvedPath, 150, {
    ...options,
    previous: entry.snapshot,
  });
  entry.signature = entry.snapshot.state === 'read-error' ? null : signature;
  return entry.snapshot;
}
