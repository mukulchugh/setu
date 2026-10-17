import { expect, test } from 'bun:test';
import { createMcpConfigWriter } from './portal/mcp-config';

test('adding before a successful configuration read cannot replace existing servers', async () => {
  let reads = 0,
    writes = 0;
  const writer = createMcpConfigWriter<string>({
    // biome-ignore lint/suspicious/useAwait: Config reads preserve the asynchronous writer collaborator contract.
    read: async () => {
      reads += 1;
      return ['existing'];
    },
    // biome-ignore lint/suspicious/useAwait: Config writes preserve the asynchronous writer collaborator contract.
    write: async () => {
      writes += 1;
      return { ok: true };
    },
  });
  expect(
    await writer.save(undefined, (rows) => [...rows, 'new'])
  ).toMatchObject({ code: 'CONFIG_NOT_LOADED', ok: false });
  expect(reads).toBe(0);
  expect(writes).toBe(0);
});

test('explicit writes use a fresh list, serialize, and never replay an uncertain replacement', async () => {
  let finish: (result: { ok: boolean; networkUncertain?: boolean }) => void;
  const writes: string[][] = [];
  const writer = createMcpConfigWriter<string>({
    read: () => Promise.resolve(['existing', 'another-tab']),
    write: (rows) => {
      writes.push(rows);
      return new Promise((resolve) => {
        finish = resolve;
      });
    },
  });
  const first = writer.save(['existing'], (rows) => [...rows, 'new']);
  await Promise.resolve();
  await Promise.resolve();
  expect(
    await writer.save(['existing'], (rows) => rows.slice(1))
  ).toMatchObject({ code: 'SAVE_PENDING', ok: false });
  expect(writes).toEqual([['existing', 'another-tab', 'new']]);
  if (!finish) {
    throw new Error('Expected pending write resolver');
  }
  finish({ networkUncertain: true, ok: false });
  expect(await first).toMatchObject({ networkUncertain: true, ok: false });
  expect(writes).toHaveLength(1);
});

test('a failed fresh read preserves the saved configuration without a write', async () => {
  let writes = 0;
  const writer = createMcpConfigWriter<string>({
    read: () => Promise.reject(new Error('offline')),
    // biome-ignore lint/suspicious/useAwait: Config writes preserve the asynchronous writer collaborator contract.
    write: async () => {
      writes += 1;
      return { ok: true };
    },
  });
  expect(await writer.save(['existing'], () => [])).toMatchObject({
    ok: false,
  });
  expect(writes).toBe(0);
});

test('unconfirmed disconnect cannot remove a saved server', async () => {
  let writes = 0;
  const writer = createMcpConfigWriter<string>({
    read: () => Promise.resolve(['existing']),
    // biome-ignore lint/suspicious/useAwait: Config writes preserve the asynchronous writer collaborator contract.
    write: async () => {
      writes += 1;
      return { ok: true };
    },
  });
  expect(
    await writer.save(['existing'], () =>
      Promise.reject(new Error('Disconnect outcome not confirmed'))
    )
  ).toMatchObject({ error: 'Disconnect outcome not confirmed', ok: false });
  expect(writes).toBe(0);
});
