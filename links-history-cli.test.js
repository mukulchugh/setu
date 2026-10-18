import { afterEach, expect, test } from 'bun:test';
import { runCli } from './cli.js';

const initialExitCode = process.exitCode ?? 0;
afterEach(() => {
  process.exitCode = initialExitCode;
});

// The real CLI with the portal request at its boundary.
async function links(argv, { reply = { ok: true }, fail, localCommand } = {}) {
  const calls = [];
  const out = [];
  const err = [];
  const originalLog = console.log;
  const originalError = console.error;
  console.log = (text) => out.push(String(text));
  console.error = (text) => err.push(String(text));
  try {
    const code = await runCli(['links', ...argv], {
      ...(localCommand ? { localCommand } : {}),
      request: (call) => {
        calls.push({ body: call.body, method: call.method, path: call.path });
        if (fail) {
          throw fail;
        }
        return Promise.resolve(reply);
      },
    });
    return { calls, code, err: err.join('\n'), out: out.join('\n') };
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }
}

const route = (call) => {
  const url = new URL(call.path, 'http://portal');
  return {
    method: call.method,
    path: url.pathname,
    query: Object.fromEntries(url.searchParams),
  };
};

test('associate previews first, and only a passed-back confirmation approves', async () => {
  const preview = await links(
    [
      'associate',
      'run-1',
      '--origin',
      'peer-A',
      '--hint',
      'remote-9',
      '--json',
    ],
    { reply: { ok: true, review: { token: 'associate:abc' } } }
  );
  expect(preview.calls.map(route)).toEqual([
    {
      method: 'GET',
      path: '/api/links/associations/preview',
      query: { hint: 'remote-9', origin: 'peer-A', runId: 'run-1' },
    },
  ]);
  expect(JSON.parse(preview.out).review.token).toBe('associate:abc');

  const approved = await links([
    'associate',
    'run-1',
    '--origin',
    'peer-A',
    '--hint',
    'remote-9',
    '--confirmation',
    'associate:abc',
    '--json',
  ]);
  expect(approved.calls).toHaveLength(1);
  expect(approved.calls[0].method).toBe('POST');
  expect(approved.calls[0].path).toBe('/api/links/associations/approve');
  expect(approved.calls[0].body).toMatchObject({
    confirmation: 'associate:abc',
    hint: 'remote-9',
    origin: 'peer-A',
    runId: 'run-1',
  });
});

test('dissociate, associations, projection and recovery map to their routes', async () => {
  const cases = [
    [
      ['dissociate', 'run-1', '--origin', 'local', '--hint', 'h'],
      'POST',
      '/api/links/associations/revoke',
    ],
    [['associations', 'run-1'], 'GET', '/api/links/associations'],
    [['projection', 'run-1'], 'GET', '/api/links/projection/status'],
    [
      [
        'recovery',
        '--kind',
        'unassociated',
        '--limit',
        '20',
        '--after',
        'm_1',
        '--run',
        'run-1',
      ],
      'GET',
      '/api/links/recovery',
    ],
  ];
  for (const [argv, method, path] of cases) {
    // biome-ignore lint/performance/noAwaitInLoops: Each call replaces the shared console.
    const run = await links([...argv, '--json']);
    expect(run.calls).toHaveLength(1);
    expect(route(run.calls[0])).toMatchObject({ method, path });
  }
  const recovery = await links([
    'recovery',
    '--kind',
    'unassociated',
    '--limit',
    '20',
    '--after',
    'm_1',
    '--run',
    'run-1',
  ]);
  expect(route(recovery.calls[0]).query).toEqual({
    afterId: 'm_1',
    kind: 'unassociated',
    limit: '20',
    runId: 'run-1',
  });
});

test('evidence previews, then attaches only with the reviewed confirmation', async () => {
  const preview = await links([
    'evidence',
    'run-1',
    '--message',
    'm_1',
    '--span',
    'plan',
  ]);
  expect(route(preview.calls[0])).toEqual({
    method: 'GET',
    path: '/api/links/evidence/preview',
    query: { messageId: 'm_1', runId: 'run-1', spanId: 'plan' },
  });
  const attach = await links([
    'evidence',
    'run-1',
    '--message',
    'm_1',
    '--confirmation',
    'evidence:abc',
  ]);
  expect(attach.calls[0].method).toBe('POST');
  expect(attach.calls[0].path).toBe('/api/links/evidence/attach');
  expect(attach.calls[0].body).toMatchObject({
    confirmation: 'evidence:abc',
    messageId: 'm_1',
    runId: 'run-1',
  });
});

test('bad arguments are refused before any request', async () => {
  for (const argv of [
    ['associate', 'run-1', '--hint', 'h'],
    ['associate', 'run-1', '--origin', 'local'],
    ['associate', '--origin', 'local', '--hint', 'h'],
    ['associate', 'run-1', '--origin', 'local', '--hint', 'h', '--wake'],
    [
      'dissociate',
      'run-1',
      '--origin',
      'local',
      '--hint',
      'h',
      '--confirmation',
      'x',
    ],
    ['evidence', 'run-1'],
    ['evidence', 'run-1', '--message', 'm_1', '--origin', 'peer-A'],
    ['recovery', '--limit', '0'],
    ['recovery', '--limit', '201'],
    ['recovery', 'extra'],
    ['projection'],
    ['associations'],
  ]) {
    // biome-ignore lint/performance/noAwaitInLoops: Each call replaces the shared console.
    const run = await links(argv);
    expect(run.code).toBe(1);
    expect(run.calls).toEqual([]);
  }
});

test('with the portal down these refuse with PORTAL_REQUIRED', async () => {
  const refused = Object.assign(new Error('connect failed'), {
    code: 'ConnectionRefused',
  });
  for (const argv of [
    ['associations', 'run-1'],
    ['recovery'],
    ['projection', 'run-1'],
  ]) {
    // biome-ignore lint/performance/noAwaitInLoops: Each call replaces the shared console.
    const run = await links([...argv, '--json'], { fail: refused });
    expect(run.code).toBe(1);
    expect(JSON.parse(run.out)).toMatchObject({ code: 'PORTAL_REQUIRED' });
  }
});

test('project runs offline: no portal request, the roots and batch bound passed through', async () => {
  const seen = [];
  const localCommand = {
    createLinksHistoryService: (roots) => {
      seen.push(roots);
      return {
        project: (input) => {
          seen.push(input);
          return Promise.resolve({
            associations: [],
            complete: true,
            engine: 'ok',
            ok: true,
          });
        },
      };
    },
  };
  const run = await links(
    [
      'project',
      '--spans-root',
      '/data/spans',
      '--links-root',
      '/data/links',
      '--max-batches',
      '7',
      '--json',
    ],
    { localCommand }
  );
  expect(run.calls).toEqual([]);
  expect(run.code).toBe(0);
  expect(seen).toEqual([
    { linksRoot: '/data/links', spansRoot: '/data/spans' },
    { maxBatches: 7 },
  ]);
  expect(JSON.parse(run.out)).toMatchObject({ complete: true, ok: true });
});

test('project refuses relative or traversing roots and a result that did not complete is a failure exit only when it errors', async () => {
  const localCommand = {
    createLinksHistoryService: () => {
      throw new Error('must not be built');
    },
  };
  for (const root of ['relative/spans', '/data/../spans']) {
    // biome-ignore lint/performance/noAwaitInLoops: Each call replaces the shared console.
    const run = await links(['project', '--spans-root', root], {
      localCommand,
    });
    expect(run.code).toBe(1);
  }
  const failing = await links(['project', '--json'], {
    localCommand: {
      createLinksHistoryService: () => ({
        project: async () => ({
          code: 'LINKS_ARCHIVE_UNAVAILABLE',
          error: 'There is no Spans archive to read or change yet.',
          ok: false,
        }),
      }),
    },
  });
  expect(failing.code).toBe(1);
  expect(JSON.parse(failing.out).code).toBe('LINKS_ARCHIVE_UNAVAILABLE');
});
