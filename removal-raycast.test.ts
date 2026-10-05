import { afterEach, expect, mock, test } from 'bun:test';

let toast: { style?: string; title?: string; message?: string };
mock.module('@raycast/api', () => ({
  Action: {},
  ActionPanel: {},
  Alert: {},
  Color: {},
  confirmAlert: () => false,
  getPreferenceValues: () => ({ portalUrl: 'http://setu.test' }),
  Icon: {},
  Keyboard: {},
  List: {},
  showToast: async (initial: typeof toast) => {
    toast = { ...initial };
    return toast;
  },
  Toast: {
    Style: { Animated: 'animated', Failure: 'failure', Success: 'success' },
  },
}));
mock.module('@raycast/utils', () => ({
  useCachedPromise: () => {
    throw new Error('UI hook must not run in adapter test');
  },
}));
const { removeWorktree, getStatus, listWorktrees } = await import(
  './raycast/src/lib/api'
);
const { runAction } = await import('./raycast/src/list-worktrees');
const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

test('Raycast sends exact cleanup ID and preserves the complete partial result', async () => {
  const requests: unknown[] = [];
  const result = {
    code: 'REMOVAL_INCOMPLETE',
    completed: ['git'],
    error: 'Worktree was removed; routing cleanup is pending',
    ok: false,
    operationId: 'op-42',
    pendingSteps: ['routing'],
    removed: true,
  };
  globalThis.fetch = (async (_url, init) => {
    requests.push(JSON.parse(String(init?.body)));
    return Response.json(result, { status: 500 });
  }) as typeof fetch;
  expect(await removeWorktree('r', 'topic', 'op-42')).toEqual(result);
  expect(requests).toEqual([
    { name: 'topic', operationId: 'op-42', repo: 'r' },
  ]);
});

test('Raycast never treats HTTP success with malformed JSON as mutation success', async () => {
  globalThis.fetch = (async () =>
    new Response('<html>proxy failure</html>')) as typeof fetch;
  expect(await removeWorktree('r', 'topic')).toMatchObject({
    networkUncertain: true,
    ok: false,
  });
});

test('Raycast rejects missing success fields and contradictory HTTP failures', async () => {
  for (const [body, status] of [
    [null, 200],
    [{ message: 'accepted?' }, 200],
    [{ ok: true }, 500],
  ] as const) {
    globalThis.fetch = (async () =>
      Response.json(body, { status })) as typeof fetch;
    expect(await removeWorktree('r', 'topic')).toMatchObject({
      networkUncertain: true,
      ok: false,
      removed: null,
    });
  }
});

test('Raycast does not replay an uncertain mutation', async () => {
  let calls = 0;
  globalThis.fetch = (async () => {
    calls += 1;
    throw new Error('connection reset after dispatch');
  }) as typeof fetch;
  expect(await removeWorktree('r', 'topic', 'op-42')).toMatchObject({
    networkUncertain: true,
    ok: false,
  });
  expect(calls).toBe(1);
});

test('Raycast callback refreshes worktrees and independent cleanup status after partial deletion', async () => {
  const requests: string[] = [];
  const pending = {
    name: 'topic',
    operationId: 'op-42',
    pendingSteps: ['routing'],
    removed: true,
    repo: 'r',
  };
  globalThis.fetch = (async (url, init) => {
    const path = new URL(String(url)).pathname;
    requests.push(path);
    if (init?.method === 'POST') {
      return Response.json({
        ...pending,
        error: 'Routing cleanup is pending',
        ok: false,
      });
    }
    return Response.json(
      path === '/api/status' ? { pendingRemovals: [pending] } : []
    );
  }) as typeof fetch;
  let rows: unknown, status: unknown;
  await runAction(
    'Remove',
    () => removeWorktree('r', 'topic'),
    async () => {
      [rows, status] = await Promise.all([listWorktrees(), getStatus()]);
    }
  );
  expect(requests).toEqual(['/api/remove', '/api/worktrees', '/api/status']);
  expect(rows).toEqual([]);
  expect(status).toEqual({ pendingRemovals: [pending] });
  expect(toast.style).toBe('failure');
  expect(toast.title).toBe('Worktree removed; cleanup pending');
  expect(toast.message).toContain('op-42');
});

test('Raycast callback reports uncertainty and refreshes once without replay', async () => {
  let calls = 0,
    refreshes = 0;
  globalThis.fetch = (async () => {
    calls += 1;
    throw new Error('timeout');
  }) as typeof fetch;
  await runAction(
    'Cleanup',
    () => removeWorktree('r', 'topic', 'old-id'),
    () => {
      refreshes += 1;
    }
  );
  expect(toast.title).toBe('Outcome not confirmed');
  expect([calls, refreshes]).toEqual([1, 1]);
});

test('Raycast preserves an unknown exact ID failure without starting fresh removal', async () => {
  const bodies: unknown[] = [];
  globalThis.fetch = (async (_url, init) => {
    bodies.push(JSON.parse(String(init?.body)));
    return Response.json({
      code: 'REMOVAL_NOT_FOUND',
      error: 'Unknown operation',
      ok: false,
      removed: false,
    });
  }) as typeof fetch;
  await runAction(
    'Cleanup',
    () => removeWorktree('r', 'topic', 'expired-id'),
    () => {
      /* No side effect is needed in this fixture. */
    }
  );
  expect(bodies).toEqual([
    { name: 'topic', operationId: 'expired-id', repo: 'r' },
  ]);
  expect(toast.style).toBe('failure');
});
