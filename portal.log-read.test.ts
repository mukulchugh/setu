import { expect, test } from 'bun:test';
import {
  acceptLogSnapshot,
  createLogFollow,
  initialLogRead,
} from './portal/log-read';

test('an initial failed read is never an empty success', () => {
  expect(
    acceptLogSnapshot(initialLogRead, { lines: [], state: 'read-error' }, 20)
  ).toEqual({ lines: null, state: 'read-error' });
});
test('read errors retain the previous successful content and timestamp', () => {
  const previous = acceptLogSnapshot(
    initialLogRead,
    { lines: ['kept'], observedAt: 10, state: 'ready' },
    20
  );
  expect(
    acceptLogSnapshot(
      previous,
      { lines: [], observedAt: 30, state: 'read-error' },
      40
    )
  ).toEqual({ lines: ['kept'], state: 'read-error', successfulAt: 10 });
});
test('server retained history is usable on first subscription; a new empty snapshot replaces it', () => {
  const retained = acceptLogSnapshot(
    initialLogRead,
    {
      lines: ['retained'],
      retained: true,
      state: 'read-error',
      successfulAt: 10,
    },
    20
  );
  expect(retained.lines).toEqual(['retained']);
  expect(
    acceptLogSnapshot(
      retained,
      { lines: [], state: 'empty', successfulAt: 30 },
      40
    )
  ).toEqual({ lines: [], state: 'empty', successfulAt: 30 });
});
test('legacy snapshots remain readable and reconnect snapshots replace rather than append', () => {
  const first = acceptLogSnapshot(
    initialLogRead,
    { lines: ['old', 'tail'] },
    10
  );
  expect(
    acceptLogSnapshot(first, { lines: ['tail', 'new'] }, 20).lines
  ).toEqual(['tail', 'new']);
  expect(
    acceptLogSnapshot(first, { lines: [], state: 'missing' }, 20).state
  ).toBe('missing');
});

function followHarness() {
  const applied: string[][] = [];
  const events: string[] = [];
  const control = createLogFollow({
    apply: (snapshot) => applied.push(snapshot.lines ?? []),
    following: (enabled) => events.push(enabled ? 'follow' : 'pause'),
    holding: (held) => events.push(held ? 'held' : 'released'),
  });
  return { applied, control, events };
}
test('paused logs keep the displayed tail and apply only the latest held snapshot on resume', () => {
  const { applied, control, events } = followHarness();
  control.accept({ lines: ['a'] });
  control.follow(false);
  control.accept({ lines: ['a', 'b'] });
  control.accept({ lines: ['b', 'c'] });
  expect(applied).toEqual([['a']]);
  control.follow(true);
  expect(applied).toEqual([['a'], ['b', 'c']]);
  control.follow(true);
  expect(applied).toHaveLength(2);
  expect(events).toEqual(['pause', 'held', 'follow', 'released']);
});
test('switching log source drops a held tail instead of applying it', () => {
  const { applied, control, events } = followHarness();
  control.follow(false);
  control.accept({ lines: ['old source'] });
  control.reset();
  expect(control.following).toBe(true);
  expect(applied).toEqual([]);
  control.accept({ lines: ['new source'] });
  expect(applied).toEqual([['new source']]);
  expect(events).toEqual(['pause', 'held', 'released', 'follow']);
});
