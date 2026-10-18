import { afterEach, describe, expect, test } from 'bun:test';
import {
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createExecutionOwner } from './spans-execution-owner.js';

// Process-free tests of the supervisor owner file. The processes it names are
// described by an injected observer, so the race below is deterministic.

let root;
afterEach(() => {
  rmSync(root, { force: true, recursive: true });
});

const DEAD = 999_001;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// A process table where DEAD is gone and every other pid is alive.
// Looking at the dead owner takes `delayMs`; looking at oneself is immediate.
const observe =
  (delayMs = 0) =>
  async (pid) => {
    if (pid === DEAD) {
      await sleep(delayMs);
    }
    return pid === DEAD
      ? { state: 'absent' }
      : {
          processId: pid,
          processStartIdentity: `start-${pid}`,
          state: 'alive',
        };
  };

const ownerOf = (pid, delayMs) =>
  createExecutionOwner({ observeProcess: observe(delayMs), pid, root });

function leaveDeadOwner() {
  root = mkdtempSync(join(tmpdir(), 'setu-owner-'));
  writeFileSync(
    join(root, 'execution.owner.1'),
    JSON.stringify({ pid: DEAD, processStart: 'start-dead' })
  );
}

describe('the supervisor owner file', () => {
  test('two contenders reclaiming a dead owner at once leave exactly one owner', async () => {
    leaveDeadOwner();
    // The second contender looks at the dead owner for longer, so it acts on
    // that old observation after the first has already taken over.
    const first = ownerOf(101, 10);
    const second = ownerOf(102, 80);
    const results = await Promise.all([first.acquire(), second.acquire()]);
    expect(results.filter((result) => result.ok)).toHaveLength(1);
    const winner = results[0].ok ? first : second;
    // The loser cannot take it back while the winner is alive, and the winner
    // keeps answering as the owner.
    expect((await (results[0].ok ? second : first).acquire()).ok).toBe(false);
    expect((await winner.acquire()).ok).toBe(true);
  });

  test('many simultaneous contenders still yield one owner', async () => {
    leaveDeadOwner();
    const owners = Array.from({ length: 8 }, (_, index) =>
      ownerOf(200 + index, 5 * (index % 3))
    );
    const results = await Promise.all(owners.map((owner) => owner.acquire()));
    expect(results.filter((result) => result.ok)).toHaveLength(1);
  });

  test('a live owner is never replaced', async () => {
    root = mkdtempSync(join(tmpdir(), 'setu-owner-'));
    const first = ownerOf(301);
    expect((await first.acquire()).ok).toBe(true);
    const other = ownerOf(302);
    expect((await other.acquire()).ok).toBe(false);
    expect((await first.acquire()).ok).toBe(true);
  });

  test('an owner whose process cannot be identified is not replaced', async () => {
    root = mkdtempSync(join(tmpdir(), 'setu-owner-'));
    writeFileSync(join(root, 'execution.owner.1'), 'not json');
    expect((await ownerOf(401).acquire()).ok).toBe(false);
  });

  test('release leaves only a released tombstone, and the next contender takes over', async () => {
    root = mkdtempSync(join(tmpdir(), 'setu-owner-'));
    const first = ownerOf(501);
    await first.acquire();
    await first.release();
    const files = readdirSync(root).filter((name) =>
      name.startsWith('execution.owner')
    );
    expect(files).toHaveLength(1);
    expect(
      JSON.parse(readFileSync(join(root, files[0]), 'utf8'))
    ).toMatchObject({ released: true });
    expect((await ownerOf(502).acquire()).ok).toBe(true);
  });

  test('an observer that read an owner before it released cannot take over beside the new owner', async () => {
    root = mkdtempSync(join(tmpdir(), 'setu-owner-'));
    const alive = new Set([3101, 3102, 3103]);
    const view = (pid) =>
      alive.has(pid)
        ? { processId: pid, processStartIdentity: `s-${pid}`, state: 'alive' }
        : { state: 'absent' };
    let entered;
    let resume;
    const observing = new Promise((resolve) => {
      entered = resolve;
    });
    const gate = new Promise((resolve) => {
      resume = resolve;
    });
    const a = createExecutionOwner({
      observeProcess: (pid) => Promise.resolve(view(pid)),
      pid: 3101,
      root,
    });
    // B has read A as the owner and is still looking at its process.
    const b = createExecutionOwner({
      observeProcess: async (pid) => {
        if (pid === 3101) {
          entered();
          await gate;
        }
        return view(pid);
      },
      pid: 3102,
      root,
    });
    const c = createExecutionOwner({
      observeProcess: (pid) => Promise.resolve(view(pid)),
      pid: 3103,
      root,
    });
    expect((await a.acquire()).ok).toBe(true);
    const pending = b.acquire();
    await observing;
    await a.release();
    alive.delete(3101);
    const cResult = await c.acquire();
    resume();
    const bResult = await pending;

    expect(cResult.ok).toBe(true);
    expect(bResult.ok).toBe(false);
    // The live successor's file was not pruned or replaced, and it still
    // answers as the one owner.
    expect((await c.acquire()).ok).toBe(true);
    expect((await b.acquire()).ok).toBe(false);
    await a.release();
    await b.release();
    await c.release();
  });

  test('a number freed behind a newer owner cannot be taken by a stale creator', async () => {
    leaveDeadOwner();
    let entered;
    let resume;
    const observing = new Promise((resolve) => {
      entered = resolve;
    });
    const gate = new Promise((resolve) => {
      resume = resolve;
    });
    // B has read the dead file 0 and is still looking at that process.
    const stale = createExecutionOwner({
      observeProcess: async (pid) => {
        if (pid === DEAD) {
          entered();
          await gate;
        }
        return observe()(pid);
      },
      pid: 701,
      root,
    });
    const pending = stale.acquire();
    await observing;

    // While it waits, one owner takes number 1 and releases it (a tombstone at
    // 2), and the next takes 3: numbers 0, 1 and 2 are all pruned and free.
    const second = ownerOf(702);
    expect((await second.acquire()).ok).toBe(true);
    await second.release();
    const third = ownerOf(703);
    expect((await third.acquire()).ok).toBe(true);
    expect(
      readdirSync(root).filter((name) => name.startsWith('execution.owner'))
    ).toEqual(['execution.owner.4']);

    resume();
    // Number 1 is free for the stale creator, but it is not the newest file.
    expect((await pending).ok).toBe(false);
    expect(
      readdirSync(root).filter((name) => name.startsWith('execution.owner'))
    ).toEqual(['execution.owner.4']);
    expect((await third.acquire()).ok).toBe(true);
    await third.release();
  });
});

describe('the supervisor owner file across real processes', () => {
  test('simultaneous processes reclaiming a dead owner yield one owner each round', async () => {
    const fixture = join(import.meta.dir, 'spans-execution.owner-fixture.js');
    for (let round = 0; round < 3; round += 1) {
      root = mkdtempSync(join(tmpdir(), 'setu-owner-'));
      // A real process that has exited stands in for the crashed supervisor.
      const gone = Bun.spawn(['true']);
      // biome-ignore lint/performance/noAwaitInLoops: Each round starts from a fresh directory, in order.
      await gone.exited;
      writeFileSync(
        join(root, 'execution.owner.1'),
        JSON.stringify({ pid: gone.pid, processStart: 'long-gone' })
      );
      const startAt = Date.now() + 800;
      const children = Array.from({ length: 6 }, () =>
        Bun.spawn([process.execPath, fixture, root, String(startAt)], {
          stdin: 'pipe',
          stdout: 'pipe',
        })
      );
      const answers = await Promise.all(
        children.map(async (child) => {
          const reader = child.stdout.getReader();
          const { value } = await reader.read();
          return JSON.parse(new TextDecoder().decode(value));
        })
      );
      expect(answers.filter((answer) => answer.ok)).toHaveLength(1);
      for (const child of children) {
        child.stdin.end();
        // biome-ignore lint/performance/noAwaitInLoops: Children are released one by one.
        await child.exited;
      }
      rmSync(root, { force: true, recursive: true });
    }
    root = mkdtempSync(join(tmpdir(), 'setu-owner-'));
  });
});
