import { expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { acquire, heavyJobLimit, release, runHeavy, tryAcquire } from './heavy-gate.js';

const tempDir = () => mkdtempSync(join(tmpdir(), 'setu-heavy-'));

test('the limit comes from heavyJobs.max and falls back to 2', () => {
  expect(heavyJobLimit({ heavyJobs: { max: 3 } })).toBe(3);
  expect(heavyJobLimit({ heavyJobs: { max: 0 } })).toBe(2);
  expect(heavyJobLimit({})).toBe(2);
});

test('no more than max slots are held at once, and a released slot is reused', () => {
  const dir = tempDir();
  const alive = () => true;
  const a = tryAcquire({ alive, dir, max: 2, pid: 11 });
  const b = tryAcquire({ alive, dir, max: 2, pid: 12 });
  expect(a).not.toBeNull();
  expect(b).not.toBeNull();
  expect(tryAcquire({ alive, dir, max: 2, pid: 13 })).toBeNull();
  release(a);
  expect(tryAcquire({ alive, dir, max: 2, pid: 13 })).toBe(a);
});

test('a slot whose owner died is reclaimed', () => {
  const dir = tempDir();
  const slot = tryAcquire({ alive: () => true, dir, max: 1, pid: 99 });
  writeFileSync(join(slot, 'pid'), '99');
  expect(tryAcquire({ alive: () => true, dir, max: 1, pid: 5 })).toBeNull();
  expect(tryAcquire({ alive: (pid) => pid !== 99, dir, max: 1, pid: 5 })).toBe(
    slot
  );
});

test('acquire waits until a slot frees up', async () => {
  const dir = tempDir();
  const held = tryAcquire({ alive: () => true, dir, max: 1, pid: 1 });
  let waits = 0;
  const slot = await acquire(
    { alive: () => true, dir, max: 1, pid: 2 },
    {
      onWait: () => {
        waits += 1;
      },
      sleep: async () => release(held),
    }
  );
  expect(waits).toBe(1);
  expect(slot).toBe(held);
});

test('runHeavy returns the command exit code and frees its slot', async () => {
  const dir = tempDir();
  expect(
    await runHeavy(['sh', '-c', 'exit 3'], {
      dir,
      log: () => {},
      max: 1,
      stdio: 'ignore',
    })
  ).toBe(3);
  expect(tryAcquire({ dir, max: 1 })).not.toBeNull();
});
