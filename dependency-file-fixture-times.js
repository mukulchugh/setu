import { dlopen, ptr } from 'bun:ffi';
import { closeSync, constants, openSync } from 'node:fs';

// Test-only OS clock seam. Floating-point utimes cannot retain arbitrary nanoseconds.
export function setFixtureTimesNs(path, atimeNs, mtimeNs) {
  const library = dlopen(
    process.platform === 'darwin' ? '/usr/lib/libSystem.B.dylib' : 'libc.so.6',
    { futimens: { args: ['i32', 'ptr'], returns: 'i32' } }
  );
  let fd;
  try {
    // biome-ignore lint/suspicious/noBitwiseOperators: Do not follow fixture symlinks.
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const times = Buffer.alloc(32);
    for (const [index, value] of [atimeNs, mtimeNs].entries()) {
      const ns = BigInt(value);
      times.writeBigInt64LE(ns / 1_000_000_000n, index * 16);
      times.writeBigInt64LE(ns % 1_000_000_000n, index * 16 + 8);
    }
    if (library.symbols.futimens(fd, ptr(times)) !== 0) {
      throw new Error('Fixture nanosecond timestamp restoration failed');
    }
  } finally {
    if (fd !== undefined) {
      closeSync(fd);
    }
    library.close();
  }
}
