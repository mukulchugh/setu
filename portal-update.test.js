import { expect, test } from 'bun:test';
import {
  createPortalUpdateControl,
  drainPortalForUpdate,
} from './portal-update.js';
import { createWorktreeLifecycle } from './worktree-lifecycle.js';

const identity = {
  processId: 321,
  processStartIdentity: 'Mon Sep 21 10:11:12 2026',
};
function fixture() {
  let supportive = false,
    sequence = 0;
  const lifecycle = createWorktreeLifecycle({
    capacity: { refresh: () => Promise.resolve({ available: false }) },
    clock: { clearTimeout, now: () => 0, setTimeout },
    runtime: {},
    settings: {},
    validateTarget: () => {
      /* No side effect is needed in this fixture. */
      return Promise.resolve();
    },
  });
  const control = createPortalUpdateControl({
    hasSupportingWork: () => supportive,
    lifecycle,
    processIdentity: identity,
    randomId: () => {
      sequence += 1;
      return `opaque-${sequence}`;
    },
  });
  return {
    control,
    lifecycle,
    setSupportive: (value) => {
      supportive = value;
    },
  };
}

test('capabilities bind the loaded instance to its observed process identity', () => {
  expect(fixture().control.capabilities()).toEqual({
    instanceId: 'opaque-1',
    protocol: 1,
    ...identity,
  });
});

test('portal shutdown disposes recurring work and waits for response drain before exiting', async () => {
  let drained;
  const calls = [];
  const drain = new Promise((resolve) => {
    drained = resolve;
  });
  const completion = drainPortalForUpdate({
    closeConnections: () => calls.push('close-sockets'),
    dispose: () => calls.push('dispose'),
    exit: (code) => calls.push(`exit ${code}`),
    stopServer: async () => {
      calls.push('drain');
      await drain;
    },
  });
  expect(calls).toEqual(['dispose', 'close-sockets', 'drain']);
  drained();
  await completion;
  expect(calls).toEqual(['dispose', 'close-sockets', 'drain', 'exit 0']);
  calls.length = 0;
  await expect(
    drainPortalForUpdate({
      closeConnections() {
        /* No side effect is needed in this fixture. */
      },
      dispose() {
        /* No side effect is needed in this fixture. */
      },
      exit: () => calls.push('exit'),
      stopServer: () => Promise.reject(new Error('drain unconfirmed')),
    })
  ).rejects.toThrow('drain unconfirmed');
  expect(calls).toEqual([]);
});

test('cutover closes ordinary mutation admission atomically while an admitted request remains busy', async () => {
  const { control } = fixture();
  let finish,
    called = false;
  const held = new Promise((resolve) => {
    finish = resolve;
  });
  const mutation = control.mutate(() => held);
  const owner = control.quiesce(control.capabilities());
  expect(owner).toMatchObject({
    blockers: ['portal mutation in flight'],
    code: 'OWNED_WORK_ACTIVE',
    ok: false,
    token: 'opaque-2',
  });
  expect(
    await control.mutate(() => {
      called = true;
    })
  ).toMatchObject({ code: 'ADMISSION_CLOSED', ok: false });
  expect(called).toBe(false);
  expect(control.prepareStop(owner).ok).toBe(false);
  finish({ ok: true });
  await mutation;
  expect(control.prepareStop(owner).ok).toBe(true);
  expect(
    await control.mutate(() => ({ ok: true }), { recovery: true })
  ).toMatchObject({ code: 'ADMISSION_CLOSED', ok: false });
});

test('stable supporting processes and unknown work block cutover; only the unchanged-source owner can reopen', async () => {
  const f = fixture();
  f.setSupportive(true);
  const owner = f.control.quiesce(f.control.capabilities());
  expect(owner.ok).toBe(false);
  expect(JSON.stringify(owner)).not.toContain('Symbol');
  expect(f.control.quiesce(f.control.capabilities())).toMatchObject({
    code: 'ADMISSION_CLOSED',
    ok: false,
  });
  expect(f.control.prepareStop({ ...owner, token: 'another-owner' }).ok).toBe(
    false
  );
  expect((await f.control.reopen({ ...owner, coherent: false })).ok).toBe(
    false
  );
  expect((await f.control.reopen({ ...owner, coherent: true })).ok).toBe(true);
  f.setSupportive(false);
  expect((await f.control.mutate(() => ({ ok: true }))).ok).toBe(true);
  await expect(
    f.control.mutate(() => {
      throw Object.assign(new Error('unconfirmed'), {
        code: 'OPERATION_UNKNOWN',
      });
    })
  ).rejects.toMatchObject({ code: 'OPERATION_UNKNOWN' });
  expect(f.control.quiesce(f.control.capabilities()).ok).toBe(false);
});

test('already-admitted lifecycle work blocks cutover and new direct backend work is rejected', async () => {
  const f = fixture();
  const target = { key: 'repo/topic', name: 'topic', repo: 'repo' };
  let finish, entered;
  const active = new Promise((resolve) => {
    entered = resolve;
  });
  const held = new Promise((resolve) => {
    finish = resolve;
  });
  const operation = f.lifecycle.runOperation(target, 'review', async () => {
    entered();
    await held;
    return { ok: true };
  });
  await active;
  const owner = f.control.quiesce(f.control.capabilities());
  expect(owner.ok).toBe(false);
  expect(
    await f.lifecycle.runOperation(
      { ...target, key: 'repo/other' },
      'setup',
      () => ({ ok: true })
    )
  ).toMatchObject({ code: 'ADMISSION_CLOSED' });
  finish();
  await operation;
  expect(
    f.control.prepareStop({ ...owner, instanceId: 'stale-instance' }).ok
  ).toBe(false);
  expect(f.control.prepareStop(owner).ok).toBe(true);
  expect((await f.control.reopen({ ...owner, coherent: true })).ok).toBe(false);
});

test('a dead quiesce owner is reopened before a new owner is admitted', () => {
  const lifecycle = createWorktreeLifecycle({
    capacity: {},
    clock: { clearTimeout, now: () => 0, setTimeout },
    runtime: {},
    settings: {},
    validateTarget: () => Promise.resolve(),
  });
  let sequence = 0;
  const control = createPortalUpdateControl({
    lifecycle,
    ownerProcessAlive: (pid) => pid !== 123,
    processIdentity: identity,
    randomId: () => {
      sequence += 1;
      return `owner-${sequence}`;
    },
  });
  const first = control.quiesce({
    ...control.capabilities(),
    ownerProcessId: 123,
  });
  expect(first.ok).toBe(true);
  const second = control.quiesce({
    ...control.capabilities(),
    ownerProcessId: 456,
  });
  expect(second).toMatchObject({ ok: true, token: 'owner-3' });
});
