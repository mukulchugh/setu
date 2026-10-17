import { afterEach, expect, test } from 'bun:test';
import {
  decodeSpansEvents,
  decodeSpansPage,
  readSpansArtifact,
  readSpansEvents,
  readSpansRun,
  readSpansRuns,
} from './portal/spans-read';

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});
const run = (runId: string) => ({
  generation: 0,
  revision: 1,
  runId,
  view: { goal: '<script>inert text</script>' },
});
const event = (sequence: number, runId = 'run-1') => ({
  eventId: `event-${sequence}`,
  payload: { text: 'retained' },
  runId,
  sequence,
  type: 'source.message',
});

test('history rejects cross-run, duplicate, backward and non-advancing pages', () => {
  const page = {
    events: [event(3), event(7)],
    hasMore: true,
    nextSequence: 7,
    ok: true,
  };
  expect(decodeSpansEvents(page, 'run-1', 2).events).toHaveLength(2);
  for (const damaged of [
    { ...page, events: [event(3, 'run-2')] },
    { ...page, events: [event(7), event(3)] },
    { ...page, events: [event(3), event(3)] },
    { ...page, events: [event(1), event(7)] },
    { ...page, nextSequence: 2 },
    { ...page, events: [], nextSequence: 2 },
  ]) {
    expect(() => decodeSpansEvents(damaged, 'run-1', 2)).toThrow(
      'Spans history is unavailable.'
    );
  }
  expect(
    decodeSpansEvents(
      { events: [], hasMore: false, nextSequence: 7, ok: true },
      'run-1',
      7
    ).events
  ).toEqual([]);
});

test('summary pages refuse duplicate identities, wrong cursor and oversized replies', () => {
  const page = {
    hasMore: false,
    nextRunId: 'run-2',
    ok: true,
    records: [run('run-1'), run('run-2')],
  };
  expect(decodeSpansPage(page).records).toHaveLength(2);
  for (const damaged of [
    { ...page, records: [run('run-1'), run('run-1')] },
    { ...page, nextRunId: 'run-9' },
    { ...page, records: [run('run-2'), run('run-1')] },
    { ...page, hasMore: true, records: [] },
    { ...page, records: Array.from({ length: 201 }, (_, i) => run(String(i))) },
  ]) {
    expect(() => decodeSpansPage(damaged)).toThrow(
      'Spans run summaries are unavailable.'
    );
  }
});

test('reads encode identifiers and filters, bound pages and forward cancellation', async () => {
  const calls: { url: URL; signal: AbortSignal | null | undefined }[] = [];
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input), 'http://fixture.invalid');
    calls.push({ signal: init?.signal, url });
    return Promise.resolve(
      Response.json(
        url.pathname.endsWith('/events')
          ? { events: [event(11)], hasMore: false, nextSequence: 11, ok: true }
          : { hasMore: false, nextRunId: null, ok: true, records: [] }
      )
    );
  }) as typeof fetch;
  const { signal } = new AbortController();
  await readSpansRuns('past', 'a&phase=live', '', signal);
  await readSpansEvents('run-1', 10, signal);
  expect(calls[0].url.searchParams.get('query')).toBe('a&phase=live');
  expect(calls[0].url.searchParams.get('phase')).toBe('past');
  expect(calls[0].url.searchParams.get('limit')).toBe('50');
  expect(calls[1].url.searchParams.get('limit')).toBe('100');
  expect(calls[1].url.searchParams.get('afterSequence')).toBe('10');
  expect(calls.every((call) => call.signal === signal)).toBe(true);
});

test('detail and artifact responses cannot cross run or artifact identity', async () => {
  globalThis.fetch = (() =>
    Promise.resolve(
      Response.json({ ok: true, record: run('other') })
    )) as typeof fetch;
  await expect(
    readSpansRun('run-1', new AbortController().signal)
  ).rejects.toThrow('This run is unavailable.');
  const input = { artifactId: `sha256:${'a'.repeat(64)}`, runId: 'run-1' };
  const good = {
    ...input,
    mediaType: 'text/plain',
    ok: true,
    text: '<script>saved text</script>',
  };
  for (const result of [
    { ...good, runId: 'other' },
    { ...good, artifactId: 'other' },
    { ...good, mediaType: 'text/html' },
  ]) {
    globalThis.fetch = (() =>
      Promise.resolve(Response.json(result))) as typeof fetch;
    // biome-ignore lint/performance/noAwaitInLoops: each case owns the global fetch fixture.
    expect((await readSpansArtifact(input)).ok).toBe(false);
  }
  globalThis.fetch = (() =>
    Promise.resolve(Response.json(good))) as typeof fetch;
  expect(await readSpansArtifact(input)).toEqual(good);
  globalThis.fetch = (() =>
    Promise.reject(new Error('/private/secret'))) as typeof fetch;
  expect(JSON.stringify(await readSpansArtifact(input))).not.toContain(
    '/private'
  );
});

test('deep links restore only bounded filters, tabs, cursors and canonical artifact identities', async () => {
  const { parseSpansLocation, spansLocationSearch } = await import(
    './portal/spans-location'
  );
  const artifact = `sha256:${'a'.repeat(64)}`;
  const query = spansLocationSearch('', {
    after: 100,
    artifact,
    phase: 'past',
    query: 'A & B',
    tab: 'Evidence',
  });
  expect(parseSpansLocation(query)).toEqual({
    after: 100,
    artifactId: artifact,
    phase: 'past',
    query: 'A & B',
    tab: 'Evidence',
  });
  expect(
    parseSpansLocation('?after=-1&phase=anything&tab=script&artifact=../x')
  ).toEqual({ after: 0, artifactId: '', phase: 'all', query: '', tab: 'Plan' });
  expect(parseSpansLocation('?after=9007199254740992').after).toBe(0);
  expect(parseSpansLocation(`?query=${'x'.repeat(300)}`).query).toHaveLength(
    256
  );
  expect(
    parseSpansLocation(
      spansLocationSearch(query, { artifact: null, tab: 'Plan' })
    ).artifactId
  ).toBe('');
});
