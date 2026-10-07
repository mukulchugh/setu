import { expect, test } from 'bun:test';
import { createPortalOperationOutcomes } from './portal-operation-outcomes.js';

test('completion-aware outcome recorder preserves accepted/running/final states and recorder failures', async () => {
  const events = [];
  const outcomes = createPortalOperationOutcomes({
    events: {
      record: async (event) => {
        events.push(event);
        return { ok: true };
      },
    },
    now: () => 1,
    operationId: () => 'op-1',
  });
  const handle = await outcomes.accept({
    kind: 'setup-create',
    source: 'ui',
    target: { name: 'topic', repo: 'r' },
  });
  await outcomes.running(handle);
  await outcomes.watch(handle, Promise.resolve({ ok: true }));
  expect(events.map((event) => event.state)).toEqual([
    'accepted',
    'running',
    'completed',
  ]);
  expect(
    events.every((event) => event.id === 'op-1' && event.source === 'ui')
  ).toBe(true);

  const unavailable = createPortalOperationOutcomes({
    events: {
      record: async () => {
        throw new Error('journal unavailable');
      },
    },
    operationId: () => 'op-2',
  });
  const failed = await unavailable.accept({
    kind: 'deploy',
    source: 'mcp',
    target: { name: 'topic', repo: 'r' },
  });
  const result = await unavailable.settle(failed, { ok: true });
  expect(result).toMatchObject({
    ok: true,
    operationId: 'op-2',
    outcomeRecorded: false,
  });
});

test('unknown completion remains unknown instead of becoming a successful HTTP outcome', async () => {
  const events = [];
  const outcomes = createPortalOperationOutcomes({
    events: {
      record: async (event) => {
        events.push(event);
        return { ok: true };
      },
    },
    operationId: () => 'op-3',
  });
  const handle = await outcomes.accept({
    kind: 'pr-review',
    source: 'mcp',
    target: { name: 'topic', repo: 'r' },
  });
  await outcomes.watch(
    handle,
    Promise.reject(
      Object.assign(new Error('unknown'), { code: 'OPERATION_UNKNOWN' })
    )
  );
  expect(events.at(-1)).toMatchObject({ source: 'mcp', state: 'unknown' });
  await outcomes.watch(
    handle,
    Promise.resolve({ ok: false, state: 'unknown' })
  );
  expect(events.at(-1).state).toBe('unknown');
});

test('an absent recorder acknowledgment cannot claim persistence', async () => {
  const outcomes = createPortalOperationOutcomes({
    events: { record: async () => undefined },
  });
  const handle = await outcomes.accept({ kind: 'start' });
  expect(
    await outcomes.watch(handle, Promise.resolve({ ok: true }))
  ).toMatchObject({ ok: true, outcomeRecorded: false });
});
