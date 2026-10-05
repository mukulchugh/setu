import { expect, test } from 'bun:test';
import { createDevRuntime } from './dev-runtime.js';
import { watchOwnedProcessExit } from './owned-process-map.js';
import { createWorktreeLifecycle } from './worktree-lifecycle.js';

test('sidecar parent exit retains alive or unknown group ownership and blocks cutover', async () => {
  for (const state of ['alive', 'unknown']) {
    const entry = { ownedGroup: true, pid: 42 };
    const map = new Map([['r/topic', entry]]),
      probes = [];
    const runtime = createDevRuntime({
      signal: (pid, signal) => {
        probes.push([pid, signal]);
        if (state === 'unknown') {
          throw Object.assign(new Error('not observable'), { code: 'EPERM' });
        }
      },
    });
    const lifecycle = createWorktreeLifecycle({
      hasSupportingWork: () => map.size > 0,
      settings: {},
    });
    const exited =
      state === 'unknown'
        ? Promise.reject(new Error('exit observation failed'))
        : Promise.resolve(1);
    await watchOwnedProcessExit(map, 'r/topic', entry, exited, (handle) =>
      runtime.observe(null, handle)
    );
    expect(map.get('r/topic')).toBe(entry);
    expect(probes).toEqual([[-42, 0]]);
    expect(lifecycle.quiesce()).toMatchObject({
      code: 'OWNED_WORK_ACTIVE',
      ok: false,
    });
  }
});

test('sidecar ownership clears only after shared runtime confirms group absence', async () => {
  const entry = { ownedGroup: true, pid: 42 },
    map = new Map([['r/topic', entry]]);
  const runtime = createDevRuntime({
    signal: () => {
      throw Object.assign(new Error('gone'), { code: 'ESRCH' });
    },
  });
  await watchOwnedProcessExit(
    map,
    'r/topic',
    entry,
    Promise.resolve(0),
    (handle) => runtime.observe(null, handle)
  );
  expect(map.size).toBe(0);
});

test('a delayed old sidecar observation cannot delete replacement ownership', async () => {
  let finish, entered;
  const observed = new Promise((resolve) => {
    entered = resolve;
  });
  const entry = { pid: 42 },
    replacement = { pid: 99 },
    map = new Map([['r/topic', entry]]);
  const completion = watchOwnedProcessExit(
    map,
    'r/topic',
    entry,
    Promise.resolve(0),
    () => {
      entered();
      return new Promise((resolve) => {
        finish = resolve;
      });
    }
  );
  await observed;
  map.set('r/topic', replacement);
  finish('dead');
  await completion;
  expect(map.get('r/topic')).toBe(replacement);
});
