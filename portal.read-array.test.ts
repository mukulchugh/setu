import { expect, test } from 'bun:test';
import { readArray } from './portal/use-visible-poll';

test('failed or malformed list reads cannot become a confirmed empty configuration', async () => {
  const original = globalThis.fetch;
  try {
    for (const response of [
      new Response('[]', { status: 503 }),
      Response.json({ error: 'unavailable' }),
    ]) {
      globalThis.fetch = (async () => response) as typeof fetch;
      await expect(
        readArray('/controlled-list', new AbortController().signal)
      ).rejects.toThrow();
    }
    globalThis.fetch = (async () => Response.json([])) as typeof fetch;
    expect(
      await readArray('/controlled-list', new AbortController().signal)
    ).toEqual([]);
  } finally {
    globalThis.fetch = original;
  }
});
