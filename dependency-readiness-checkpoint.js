import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import asyncFs from 'node:fs/promises';

// Reuse the asynchronous inspector's exact observations at the synchronous
// launch fence. Checkpoints are private process memory, never durable proof.
const active = new AsyncLocalStorage();
const MAX_PROBES = 16_384;
const MAX_READ_BYTES = 64 * 1024 * 1024;
const READ_CHUNK = 64 * 1024;
// biome-ignore lint/suspicious/noBitwiseOperators: Open flags require both read-only access and symlink refusal.
const READ_FLAGS = fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW;
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');

function statSignature(value) {
  const values = ['dev', 'ino', 'mode', 'uid', 'gid'].map((key) =>
    String(value[key])
  );
  values.push(String(value.birthtimeNs ?? value.birthtimeMs));
  if (!value.isDirectory()) {
    values.push(
      String(value.size),
      String(value.mtimeNs ?? value.mtimeMs),
      String(value.ctimeNs ?? value.ctimeMs)
    );
  }
  return JSON.stringify(values);
}

function entriesSignature(values) {
  return JSON.stringify(
    values
      .map((value) =>
        typeof value === 'string'
          ? value
          : [value.name, value.isDirectory(), value.isSymbolicLink()]
      )
      .sort((left, right) =>
        JSON.stringify(left).localeCompare(JSON.stringify(right))
      )
  );
}

function remember(key, signature, inspect) {
  const context = active.getStore();
  if (!context) {
    return;
  }
  if (context.probes.size >= MAX_PROBES) {
    throw new Error('Dependency inspection exceeds its checkpoint bound');
  }
  const previous = context.probes.get(key);
  if (previous && previous.signature !== signature) {
    throw new Error('Dependency inputs changed during inspection');
  }
  context.probes.set(key, { inspect, signature });
}

async function observe(kind, path, options, signature) {
  const context = active.getStore();
  if (!context) {
    return asyncFs[kind](path, options);
  }
  const key = `${kind}:${String(path)}:${JSON.stringify(options)}`;
  let value;
  try {
    value = await asyncFs[kind](path, options);
  } catch (error) {
    if (error.code === 'ENOENT') {
      remember(key, 'absent', () => {
        try {
          fs[`${kind}Sync`](path, options);
          return 'present';
        } catch (current) {
          return current.code === 'ENOENT' ? 'absent' : 'unknown';
        }
      });
    }
    throw error;
  }
  remember(key, signature(value), () =>
    signature(fs[`${kind}Sync`](path, options))
  );
  return value;
}

export const lstat = (path, options) =>
  observe('lstat', path, options, statSignature);
export const stat = (path, options) =>
  observe('stat', path, options, statSignature);
export const realpath = (path, options) =>
  observe('realpath', path, options, String);
export const readlink = (path, options) =>
  observe('readlink', path, options, String);
export const readdir = (path, options) =>
  observe('readdir', path, options, entriesSignature);

function readFileSyncBounded(path, limit) {
  const fd = fs.openSync(path, READ_FLAGS);
  try {
    const initial = fs.fstatSync(fd, { bigint: true });
    if (!initial.isFile() || initial.size > BigInt(limit)) {
      throw new Error('Dependency file exceeds its read bound');
    }
    const hash = createHash('sha256');
    const chunk = Buffer.alloc(Math.min(READ_CHUNK, limit + 1));
    let total = 0;
    for (;;) {
      const size = fs.readSync(
        fd,
        chunk,
        0,
        Math.min(chunk.length, limit + 1 - total)
      );
      total += size;
      if (total > limit) {
        throw new Error('Dependency file exceeds its read bound');
      }
      if (size === 0) {
        break;
      }
      hash.update(chunk.subarray(0, size));
    }
    const after = fs.fstatSync(fd, { bigint: true });
    const current = fs.lstatSync(path, { bigint: true });
    if (
      statSignature(initial) !== statSignature(after) ||
      statSignature(initial) !== statSignature(current)
    ) {
      throw new Error('Dependency file changed during inspection');
    }
    return hash.digest('hex');
  } finally {
    fs.closeSync(fd);
  }
}

export function rememberDependencyFile(path, bytes) {
  const context = active.getStore();
  if (!context) {
    return;
  }
  const key = `contents:${String(path)}`;
  if (!context.probes.has(key)) {
    context.bytes += bytes.byteLength;
  }
  if (context.bytes > MAX_READ_BYTES) {
    throw new Error('Dependency inspection exceeds its total read bound');
  }
  remember(key, digest(bytes), () =>
    readFileSyncBounded(path, bytes.byteLength)
  );
}

export async function readFile(path, options) {
  if (!active.getStore()) {
    return asyncFs.readFile(path, options);
  }
  const encoding = typeof options === 'string' ? options : options?.encoding;
  const handle = await asyncFs.open(path, READ_FLAGS);
  try {
    const before = await handle.stat({ bigint: true });
    if (!before.isFile() || before.size > BigInt(MAX_READ_BYTES)) {
      throw new Error('Dependency file exceeds its read bound');
    }
    const buffers = [];
    const chunk = Buffer.alloc(READ_CHUNK);
    let total = 0;
    for (;;) {
      // biome-ignore lint/performance/noAwaitInLoops: Reuse one bounded buffer in file order.
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, null);
      total += bytesRead;
      if (total > MAX_READ_BYTES) {
        throw new Error('Dependency file exceeds its read bound');
      }
      if (bytesRead === 0) {
        break;
      }
      buffers.push(Buffer.from(chunk.subarray(0, bytesRead)));
    }
    const after = await handle.stat({ bigint: true });
    const current = await lstat(path, { bigint: true });
    if (
      statSignature(before) !== statSignature(after) ||
      statSignature(before) !== statSignature(current)
    ) {
      throw new Error('Dependency file changed during inspection');
    }
    const bytes = Buffer.concat(buffers);
    rememberDependencyFile(path, bytes);
    return encoding ? bytes.toString(encoding) : bytes;
  } finally {
    await handle.close();
  }
}

export function rememberDependencyGuard(key, check) {
  remember(`guard:${key}`, true, check);
}

export async function withDependencyCheckpoint(inspect) {
  const context = { bytes: 0, probes: new Map() };
  const result = await active.run(context, inspect);
  if (result?.ok !== true) {
    return result;
  }
  return {
    ...result,
    checkCurrent() {
      try {
        return [...context.probes.values()].every(
          (probe) => probe.inspect() === probe.signature
        );
      } catch {
        return false;
      }
    },
  };
}
