import { describe, expect, test } from 'bun:test';
import { createVisiblePoll } from './portal/visible-poll';

function fixture(
  immediate = true,
  intervalMs: number | null = 3000,
  refreshOnVisible = true
) {
  let visible = true,
    listener = () => {
      /* No side effect is needed in this fixture. */
    },
    id = 0;
  const timers = new Map<number, () => void>();
  const reads: {
    resolve: (data: string) => void;
    reject: () => void;
    signal: AbortSignal;
  }[] = [];
  const values: string[] = [];
  let failures = 0;
  const poll = createVisiblePoll({
    accept: (data) => values.push(data),
    cancel: (key) => timers.delete(key),
    immediate,
    intervalMs,
    refreshOnVisible,
    onVisibility(cb) {
      listener = cb;
      return () => {
        listener = () => {
          /* No side effect is needed in this fixture. */
        };
      };
    },
    read: (signal) =>
      new Promise<string>((resolve, reject) =>
        reads.push({
          reject: () => reject(new Error('offline')),
          resolve,
          signal,
        })
      ),
    reject: () => {
      const previous = failures;
      failures += 1;
      return previous;
    },
    schedule(cb) {
      id += 1;
      const key = id;
      timers.set(key, cb);
      return key;
    },
    visible: () => visible,
  });
  return {
    failures: () => failures,
    poll,
    reads,
    tick() {
      for (const [key, callback] of [...timers]) {
        timers.delete(key);
        callback();
      }
    },
    timers,
    values,
    visibility(next: boolean) {
      visible = next;
      listener();
    },
  };
}
const flush = async () => {
  await Promise.resolve();
  await Promise.resolve();
};

describe('visible read lifecycle', () => {
  test('one-shot reads keep success on failure and schedule no recurring work', async () => {
    const f = fixture(true, null);
    f.reads[0].resolve('saved');
    await flush();
    expect(f.timers.size).toBe(0);
    f.poll.refresh();
    f.poll.refresh();
    expect(f.reads).toHaveLength(2);
    f.reads[1].reject();
    await flush();
    expect(f.values).toEqual(['saved']);
    expect(f.failures()).toBe(1);
    expect(f.timers.size).toBe(0);
    f.poll.stop();
  });
  test('switching read identity cannot install the old diff after the new one', async () => {
    const old = fixture(true, null);
    old.poll.stop();
    const next = fixture(true, null);
    next.reads[0].resolve('new worktree');
    await flush();
    old.reads[0].resolve('old worktree');
    await flush();
    expect(old.values).toEqual([]);
    expect(next.values).toEqual(['new worktree']);
    next.poll.stop();
  });
  test('slow reads and repeated Retry never overlap; cadence starts after completion', async () => {
    const f = fixture();
    f.poll.refresh();
    f.poll.refresh();
    f.tick();
    expect(f.reads).toHaveLength(1);
    expect(f.timers.size).toBe(0);
    f.reads[0].resolve('first');
    await flush();
    expect(f.values).toEqual(['first']);
    expect(f.timers.size).toBe(1);
    f.tick();
    expect(f.reads).toHaveLength(2);
    f.poll.stop();
  });
  test('hide aborts, ignores late completion, and resume runs once after it settles', async () => {
    const f = fixture();
    f.visibility(false);
    expect(f.reads[0].signal.aborted).toBe(true);
    f.visibility(true);
    f.visibility(false);
    f.visibility(true);
    expect(f.reads).toHaveLength(1);
    f.reads[0].resolve('obsolete');
    await flush();
    expect(f.values).toEqual([]);
    expect(f.reads).toHaveLength(2);
    f.reads[1].resolve('fresh');
    await flush();
    expect(f.values).toEqual(['fresh']);
    f.visibility(false);
    f.tick();
    expect(f.reads).toHaveLength(2);
    f.poll.stop();
  });
  test('failed reads retain last accepted data; stopped callers cannot publish', async () => {
    const f = fixture();
    f.reads[0].resolve('kept');
    await flush();
    f.tick();
    f.reads[1].reject();
    await flush();
    expect(f.values).toEqual(['kept']);
    expect(f.failures()).toBe(1);
    f.poll.refresh();
    f.poll.stop();
    f.reads[2].resolve('late');
    await flush();
    expect(f.values).toEqual(['kept']);
    expect(f.timers.size).toBe(0);
  });
  test('rotations wait a full interval at mount and resume and stay idle while hidden', async () => {
    const f = fixture(false);
    expect(f.reads).toHaveLength(0);
    f.visibility(false);
    f.tick();
    expect(f.reads).toHaveLength(0);
    f.visibility(true);
    expect(f.reads).toHaveLength(0);
    f.tick();
    expect(f.reads).toHaveLength(1);
    f.poll.stop();
  });
  test('one-shot diff reads do not refetch when the tab becomes visible', async () => {
    const f = fixture(true, null, false);
    f.reads[0].resolve('saved diff');
    await flush();
    f.visibility(false);
    f.visibility(true);
    expect(f.reads).toHaveLength(1);
    f.poll.refresh();
    expect(f.reads).toHaveLength(2);
    f.poll.stop();
  });
});
