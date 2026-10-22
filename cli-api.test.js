import { expect, test } from 'bun:test';
import { createCliApi } from './cli-api.js';

test('reviewed dependency requests outlive ordinary commands while reads remain bounded', async () => {
  const originalFetch = globalThis.fetch;
  const originalTimeout = AbortSignal.timeout;
  const timeouts = [];
  try {
    AbortSignal.timeout = (duration) => {
      timeouts.push(duration);
      return new AbortController().signal;
    };
    globalThis.fetch = () => Promise.resolve(Response.json({ ok: true }));
    const api = createCliApi();
    await api.get('/api/dependency-sharing/status');
    await api.post('/api/dependency-sharing/apply', {});
    await api.post('/api/dependency-sharing/recover', {});
    await api.post('/api/start', {});
    expect(timeouts).toEqual([5000, 3_600_000, 3_600_000, 30_000]);
  } finally {
    globalThis.fetch = originalFetch;
    AbortSignal.timeout = originalTimeout;
  }
});
