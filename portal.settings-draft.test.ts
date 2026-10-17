import { expect, test } from 'bun:test';
import {
  createResourceDraft,
  type ResourceValues,
  reconcileExplicitDraft,
  validateResource,
} from './portal/settings-draft';

const initial: ResourceValues = {
  containerCpuLimit: 2,
  containerMemoryLimit: '4g',
  maxConcurrentDevServers: 3,
};
const tick = async () => {
  for (let i = 0; i < 8; i += 1) {
    // biome-ignore lint/performance/noAwaitInLoops: Successive microtasks drain serialized writes and readbacks before assertions.
    await Promise.resolve();
  }
};
test('empty and invalid resource text never silently becomes 1', () => {
  expect(validateResource('maxConcurrentDevServers', '')).toBeNull();
  expect(validateResource('maxConcurrentDevServers', '2.5')).toBeNull();
  expect(validateResource('containerMemoryLimit', '0g')).toBeNull();
  expect(validateResource('containerMemoryLimit', '512m')).toBe('512m');
});
test('Enter and blur deduplicate; edits during saving survive old readback and serialize', async () => {
  const requests: {
    patch: Partial<ResourceValues>;
    resolve: (result: any) => void;
  }[] = [];
  let installed = initial;
  const controller = createResourceDraft(initial, {
    publish() {
      /* No side effect is needed in this fixture. */
    },
    read: async () => installed,
    write: (patch) =>
      new Promise((resolve) => requests.push({ patch, resolve })),
  });
  controller.edit('containerCpuLimit', '4');
  controller.save('containerCpuLimit');
  controller.save('containerCpuLimit');
  expect(requests).toHaveLength(1);
  controller.edit('containerCpuLimit', '6');
  installed = { ...initial, containerCpuLimit: 4 };
  requests[0].resolve({ ok: true });
  await tick();
  expect(controller.get().containerCpuLimit.text).toBe('6');
  expect(requests).toHaveLength(2);
  expect(requests[1].patch).toEqual({ containerCpuLimit: 6 });
  installed = { ...initial, containerCpuLimit: 6 };
  requests[1].resolve({ ok: true });
  await tick();
  expect(controller.get().containerCpuLimit.state).toBe('saved');
});
test('failure keeps draft; confirmed durability warning reconciles effective value', async () => {
  let ok = false;
  const controller = createResourceDraft(initial, {
    publish() {
      /* No side effect is needed in this fixture. */
    },
    read: async () => ({ ...initial, containerCpuLimit: 3 }),
    // biome-ignore lint/suspicious/noUnnecessaryConditions: The test changes the captured ok flag between failed and successful saves.
    write: async () => ({ ok, warning: ok ? {} : undefined }),
  });
  controller.edit('containerCpuLimit', '4');
  controller.save('containerCpuLimit');
  await tick();
  expect(controller.get().containerCpuLimit.text).toBe('4');
  expect(controller.get().containerCpuLimit.state).toBe('error');
  ok = true;
  controller.save('containerCpuLimit');
  await tick();
  expect(controller.get().containerCpuLimit.text).toBe('3');
  expect(controller.get().containerCpuLimit.message).toContain('durability');
});
test('multiple edits during one save submit only the latest valid draft next', async () => {
  const writes: { patch: any; resolve: (value: any) => void }[] = [];
  const controller = createResourceDraft(initial, {
    publish() {
      /* No side effect is needed in this fixture. */
    },
    read: async () => initial,
    write: (patch) => new Promise((resolve) => writes.push({ patch, resolve })),
  });
  controller.edit('containerCpuLimit', '4');
  controller.save('containerCpuLimit');
  controller.edit('containerCpuLimit', '6');
  controller.edit('containerCpuLimit', '8');
  writes[0].resolve({ ok: true });
  await tick();
  expect(writes).toHaveLength(2);
  expect(writes[1].patch).toEqual({ containerCpuLimit: 8 });
  controller.stop();
  writes[1].resolve({ ok: true });
  await tick();
});
test('uncertain writes stop queued intent; the first Retry only reconciles', async () => {
  let resolve: (value: any) => void = () => {
      /* No side effect is needed in this fixture. */
    },
    writes = 0,
    reads = 0;
  const controller = createResourceDraft(initial, {
    publish() {
      /* No side effect is needed in this fixture. */
    },
    // biome-ignore lint/suspicious/useAwait: The config reader fixture preserves the asynchronous collaborator contract.
    read: async () => {
      reads += 1;
      return initial;
    },
    write: () => {
      writes += 1;
      return new Promise((done) => {
        resolve = done;
      });
    },
  });
  controller.edit('containerCpuLimit', '4');
  controller.save('containerCpuLimit');
  controller.edit('containerCpuLimit', '6');
  resolve({ networkUncertain: true, ok: false });
  await tick();
  expect(writes).toBe(1);
  expect(controller.get().containerCpuLimit.text).toBe('6');
  expect(controller.get().containerCpuLimit.state).toBe('error');
  controller.save('containerCpuLimit');
  await tick();
  expect(writes).toBe(1);
  expect(reads).toBe(2);
  controller.save('containerCpuLimit');
  expect(writes).toBe(2);
  controller.stop();
  resolve({ ok: true });
  await tick();
});
test('explicit readback adds saved IDs only when no newer draft exists', () => {
  const submitted = [{ id: '', label: 'Agent' }];
  const saved = [{ id: 'agent', label: 'Agent' }];
  expect(
    reconcileExplicitDraft(submitted, submitted, saved, 2, 2, true)
  ).toEqual(saved);
  const newer = [{ id: '', label: 'Renamed while saving' }];
  expect(reconcileExplicitDraft(newer, submitted, saved, 2, 3, true)).toEqual(
    newer
  );
});
test('refreshing saved values preserves an existing unsaved explicit draft', () => {
  expect(
    reconcileExplicitDraft('edited', 'old', 'server update', 4, 4, false)
  ).toBe('edited');
  expect(
    reconcileExplicitDraft('old', 'old', 'server update', 4, 4, false)
  ).toBe('server update');
});
test('reverting to the previous saved value during an in-flight save still queues that intent', async () => {
  const writes: { patch: any; resolve: (value: any) => void }[] = [];
  const controller = createResourceDraft(initial, {
    publish() {
      /* No side effect is needed in this fixture. */
    },
    read: async () => ({ ...initial, containerCpuLimit: 4 }),
    write: (patch) => new Promise((resolve) => writes.push({ patch, resolve })),
  });
  controller.edit('containerCpuLimit', '4');
  controller.save('containerCpuLimit');
  controller.edit('containerCpuLimit', '2');
  writes[0].resolve({ ok: true });
  await tick();
  expect(writes).toHaveLength(2);
  expect(writes[1].patch).toEqual({ containerCpuLimit: 2 });
  controller.stop();
  writes[1].resolve({ ok: true });
  await tick();
});
