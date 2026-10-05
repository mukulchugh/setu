import { expect, test } from 'bun:test';
import { createPortalSocket } from './portal/socket-client';

function harness() {
  let shown = true,
    clock = 0,
    timerId = 0;
  const timers = new Map<number, { at: number; fn: () => void }>();
  const visibility = new Set<() => void>(),
    sockets: any[] = [],
    reads: any[] = [];
  const client = createPortalSocket({
    cancel: (id) => {
      timers.delete(id);
    },
    now: () => clock,
    onVisibility: (cb) => {
      visibility.add(cb);
      return () => visibility.delete(cb);
    },
    openSocket: () => {
      const socket: any = {
        close() {
          this.closed = true;
        },
        readyState: 0,
        send(s: string) {
          this.sent.push(JSON.parse(s));
        },
        sent: [],
      };
      sockets.push(socket);
      return socket;
    },
    readSnapshot: () => new Promise((resolve) => reads.push(resolve)),
    schedule: (fn, ms) => {
      timerId += 1;
      const id = timerId;
      timers.set(id, { at: clock + ms, fn });
      return id;
    },
    visible: () => shown,
  });
  return {
    advance(ms: number) {
      clock += ms;
      for (const [id, task] of [...timers]) {
        if (task.at <= clock) {
          timers.delete(id);
          task.fn();
        }
      }
    },
    client,
    message(data: unknown, topic = 'worktrees', index = sockets.length - 1) {
      sockets[index].onmessage?.({ data: JSON.stringify({ data, topic }) });
    },
    open(index = sockets.length - 1) {
      const socket = sockets[index];
      socket.readyState = 1;
      socket.onopen?.();
      return socket;
    },
    reads,
    show(value: boolean) {
      shown = value;
      for (const cb of visibility) {
        cb();
      }
    },
    sockets,
    timers,
  };
}
const ready = (id = 1) => ({
  checkedAt: 123,
  listenerObservation: { observedAt: 120, state: 'ready' },
  status: {},
  worktrees: [{ id }],
});

test('no socket without visible consumers; hide and final unsubscribe cancel view work', () => {
  const h = harness(),
    values: unknown[] = [],
    onData = (data) => values.push(data);
  expect(h.sockets.length).toBe(0);
  h.show(false);
  h.client.subscribe('worktrees', onData);
  expect(h.sockets.length).toBe(0);
  h.show(true);
  h.show(true);
  expect(h.sockets.length).toBe(1);
  const old = h.sockets[0];
  h.show(false);
  expect(old.closed).toBe(true);
  expect(h.timers.size).toBe(0);
  old.onclose();
  h.advance(100_000);
  expect(h.sockets.length).toBe(1);
  h.show(true);
  h.client.unsubscribe('worktrees', onData);
  expect(h.sockets[1].closed).toBe(true);
  expect(h.timers.size).toBe(0);
});

test('an obsolete socket cannot replace data or disconnect its successor', () => {
  const h = harness(),
    values: any[] = [];
  h.client.subscribe('worktrees', (data) => values.push(data));
  const first = h.open();
  h.message(ready(1));
  h.show(false);
  h.show(true);
  h.open();
  h.message(ready(2));
  first.onmessage({
    data: JSON.stringify({ data: ready(3), topic: 'worktrees' }),
  });
  first.onclose();
  expect(values.map((v) => v.worktrees[0].id)).toEqual([1, 2]);
  expect(h.client.getState().phase).toBe('current');
  expect(h.sockets.length).toBe(2);
});

test('shared log subscriptions send once and resume replaces legacy history', () => {
  const h = harness(),
    a: any[] = [],
    b: any[] = [],
    resets: string[] = [];
  const one = (data) => a.push(data),
    two = (data) => b.push(data);
  h.client.subscribe('logs:r/wt', one, () => resets.push('one'));
  h.client.subscribe('logs:r/wt', two, () => resets.push('two'));
  const first = h.open();
  expect(first.sent).toEqual([{ sub: 'logs:r/wt' }]);
  h.message(['hello'], 'logs:r/wt');
  h.show(false);
  h.show(true);
  const second = h.open();
  h.message(['hello', 'new'], 'logs:r/wt');
  expect(a.at(-1).lines).toEqual(['hello', 'new']);
  expect(resets).toEqual(['one', 'two']);
  h.client.unsubscribe('logs:r/wt', one);
  expect(second.closed).toBeUndefined();
  h.client.unsubscribe('logs:r/wt', two);
  expect(second.closed).toBe(true);
});

test('unchanged checks refresh only connection state and expire after 75 visible seconds', () => {
  const h = harness(),
    values: any[] = [];
  h.client.subscribe('worktrees', (data) => values.push(data));
  h.open();
  h.message(ready());
  h.advance(70_000);
  h.message(ready(), 'worktrees:checked');
  expect(values.length).toBe(1);
  h.advance(74_999);
  expect(h.client.getState().phase).toBe('current');
  h.advance(1);
  expect(h.client.getState().phase).toBe('stale');
  h.show(false);
  h.advance(1_000_000);
  expect(h.client.getState().phase).toBe('paused');
  h.show(true);
  expect(h.client.getState().phase).toBe('refreshing');
});

test('legacy silence never invents staleness and unknown observations cannot clear refreshing', () => {
  const h = harness();
  h.client.subscribe('worktrees', () => {
    /* No side effect is needed in this fixture. */
  });
  h.open();
  h.message([]);
  h.advance(1_000_000);
  expect(h.client.getState().phase).toBe('last-received');
  h.show(false);
  h.show(true);
  h.open();
  h.message({
    ...ready(),
    listenerObservation: {
      code: 'PROBE_FAILED',
      observedAt: 120,
      state: 'unknown',
    },
  });
  expect(h.client.getState().phase).toBe('refreshing');
});

test('visibility cycles keep one fallback in flight and ignore its obsolete result', async () => {
  const h = harness(),
    values: any[] = [];
  h.client.subscribe('worktrees', (data) => values.push(data));
  h.open();
  h.advance(5000);
  expect(h.reads.length).toBe(1);
  for (let i = 0; i < 3; i += 1) {
    h.show(false);
    h.show(true);
    h.open();
    h.advance(5000);
  }
  expect(h.reads.length).toBe(1);
  h.reads[0](ready(1));
  await Promise.resolve();
  await Promise.resolve();
  expect(values).toEqual([]);
  h.advance(5000);
  expect(h.reads.length).toBe(2);
  h.message(ready(3));
  h.reads[1](ready(2));
  await Promise.resolve();
  await Promise.resolve();
  expect(values.map((v) => v.worktrees[0].id)).toEqual([3]);
});

test('quick socket failures do not postpone the first HTTP read forever', () => {
  const h = harness();
  h.client.subscribe('worktrees', () => {
    /* No side effect is needed in this fixture. */
  });
  for (let i = 0; i < 4; i += 1) {
    h.sockets.at(-1).onclose();
    h.advance(1000);
  }
  h.advance(1000);
  expect(h.reads.length).toBe(1);
});

test('second log viewer receives existing history while legacy deltas stay bounded', () => {
  const h = harness(),
    first: any[] = [],
    second: any[] = [];
  const a = (data) => first.push(data),
    b = (data) => second.push(data);
  h.client.subscribe('logs:r/a/dev', a);
  h.open();
  h.message({ lines: ['existing'] }, 'logs:r/a/dev');
  h.client.subscribe('logs:r/a/dev', b);
  expect(second).toEqual([{ lines: ['existing'] }]);
  for (let i = 0; i < 200; i += 1) {
    h.message(['tick'], 'logs:r/a/dev');
  }
  expect(first.at(-1).lines).toHaveLength(150);
  h.client.unsubscribe('logs:r/a/dev', a);
  h.client.unsubscribe('logs:r/a/dev', b);
});

test('expired or malformed listener observations cannot certify a current snapshot', () => {
  const h = harness();
  h.client.subscribe('worktrees', () => {
    /* No side effect is needed in this fixture. */
  });
  h.open();
  h.message({
    ...ready(),
    checkedAt: 10_000,
    listenerObservation: { observedAt: 0, state: 'ready' },
  });
  expect(h.client.getState().phase).toBe('refreshing');
  h.message({
    ...ready(),
    listenerObservation: { observedAt: null, state: 'ready' },
  });
  expect(h.client.getState().phase).toBe('refreshing');
});

test('a fresh HTTP result keeps the missing stream qualified', async () => {
  const h = harness();
  h.client.subscribe('worktrees', () => {
    /* No side effect is needed in this fixture. */
  });
  h.advance(5000);
  h.reads[0](ready());
  await Promise.resolve();
  await Promise.resolve();
  expect(h.client.getState().phase).toBe('reconnecting');
  expect(h.client.getState().error).toContain('live updates');
});
