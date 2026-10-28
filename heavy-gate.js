// `setu heavy <command...>`: a machine-wide cap on concurrent heavy jobs
// (typecheck, lint, test). Parallel agents each running a 3-6 GB `tsc` is what
// pushes the machine into swap, so excess jobs wait for a slot instead.
// Slots are directories created atomically under `dir`; a slot whose owner
// process is gone is reclaimed. Max comes from ~/.setu.json "heavyJobs.max".
import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const DEFAULT_HEAVY_JOBS = 2;
// A freshly created slot has no owner file for an instant; don't steal it.
const CLAIM_GRACE_MS = 10_000;

const isAlive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
};

export function heavyJobLimit(config) {
  const max = Number(config?.heavyJobs?.max);
  return Number.isInteger(max) && max >= 1 ? max : DEFAULT_HEAVY_JOBS;
}

function stale(slot, alive, now) {
  try {
    const pid = Number(readFileSync(join(slot, 'pid'), 'utf8'));
    return !(Number.isInteger(pid) && pid > 0 && alive(pid));
  } catch {
    try {
      return now() - statSync(slot).mtimeMs > CLAIM_GRACE_MS;
    } catch {
      return true;
    }
  }
}

export function tryAcquire({
  dir,
  max,
  pid = process.pid,
  alive = isAlive,
  now = Date.now,
}) {
  mkdirSync(dir, { recursive: true });
  for (let index = 0; index < max; index += 1) {
    const slot = join(dir, `slot-${index}`);
    try {
      mkdirSync(slot);
    } catch (error) {
      if (error.code !== 'EEXIST' || !stale(slot, alive, now)) {
        continue;
      }
      rmSync(slot, { force: true, recursive: true });
      try {
        mkdirSync(slot);
      } catch {
        continue;
      }
    }
    writeFileSync(join(slot, 'pid'), String(pid));
    return slot;
  }
  return null;
}

export async function acquire(options, { sleep, onWait = () => {} } = {}) {
  const wait =
    sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  let waited = false;
  for (;;) {
    const slot = tryAcquire(options);
    if (slot) {
      return slot;
    }
    if (!waited) {
      onWait();
      waited = true;
    }
    // biome-ignore lint/performance/noAwaitInLoops: polling for a free slot is inherently sequential.
    await wait(2000);
  }
}

export function release(slot) {
  rmSync(slot, { force: true, recursive: true });
}

export async function runHeavy(
  argv,
  { dir, max, log = console.error, stdio = 'inherit' }
) {
  if (argv.length === 0) {
    log('Usage: setu heavy <command> [args...]');
    return 2;
  }
  const slot = await acquire(
    { dir, max },
    { onWait: () => log(`setu heavy: waiting for one of ${max} slots...`) }
  );
  const child = spawn(argv[0], argv.slice(1), { stdio });
  const forward = (signal) => child.kill(signal);
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    process.on(signal, forward);
  }
  try {
    return await new Promise((resolve) => {
      child.on('error', (error) => {
        log(`setu heavy: ${error.message}`);
        resolve(127);
      });
      child.on('exit', (code, signal) => resolve(code ?? (signal ? 1 : 0)));
    });
  } finally {
    for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
      process.off(signal, forward);
    }
    release(slot);
  }
}
