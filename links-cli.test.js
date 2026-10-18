import { afterEach, expect, test } from 'bun:test';
import { runCli } from './cli.js';
import { PORTAL_API_ROUTES } from './portal-routes.js';

const UUID = /^[0-9a-f-]{36}$/;
const initialExitCode = process.exitCode ?? 0;
afterEach(() => {
  process.exitCode = initialExitCode;
});

// Runs the real CLI with the portal request and file reads at their boundaries.
async function links(argv, { reply = { ok: true }, files = {}, fail } = {}) {
  const calls = [];
  const out = [];
  const err = [];
  const originalLog = console.log;
  const originalError = console.error;
  console.log = (text) => out.push(String(text));
  console.error = (text) => err.push(String(text));
  try {
    const code = await runCli(['links', ...argv], {
      readFile: (path) => {
        if (!(path in files)) {
          throw new Error(`unexpected read of ${path}`);
        }
        return files[path];
      },
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

test('send posts the exact recipient, the body from a file, and the caller key', async () => {
  const run = await links(
    [
      'send',
      'repo',
      'topic',
      '--session',
      'session-1',
      '--body-file',
      'note.txt',
      '--idempotency-key',
      'key-1',
      '--json',
    ],
    {
      files: { 'note.txt': 'Can you check the schema?' },
      reply: { messageId: 'm_1', ok: true, state: 'queued' },
    }
  );
  expect(run.code).toBe(0);
  expect(run.calls).toEqual([
    {
      body: {
        body: 'Can you check the schema?',
        idempotencyKey: 'key-1',
        name: 'topic',
        repo: 'repo',
        sessionId: 'session-1',
      },
      method: 'POST',
      path: '/api/links/send',
    },
  ]);
  expect(JSON.parse(run.out)).toMatchObject({
    messageId: 'm_1',
    state: 'queued',
  });
});

test('send without a key makes one and a reply target is passed through', async () => {
  const run = await links(
    [
      'send',
      'repo',
      'topic',
      '--session',
      's1',
      '--body-file',
      '-',
      '--reply-to',
      'm_0',
    ],
    { files: { 0: 'hi' } }
  );
  const { body } = run.calls[0];
  expect(body.idempotencyKey).toMatch(UUID);
  expect(body.replyTo).toBe('m_0');
});

test('inbox, show, status, cancel, ack and redeliver map to their routes', async () => {
  const cases = [
    [
      ['inbox', 'repo', 'topic', '--session', 's1', '--state', 'held'],
      'GET',
      '/api/links/inbox?name=topic&repo=repo&sessionId=s1&state=held',
    ],
    [['show', 'm_1'], 'GET', '/api/links/message?messageId=m_1'],
    [['status', 'm_1'], 'GET', '/api/links/status?messageId=m_1'],
    [['cancel', 'm_1'], 'POST', '/api/links/cancel'],
    [
      ['ack', 'repo', 'topic', '--session', 's1', '--message', 'm_1'],
      'POST',
      '/api/links/ack',
    ],
    [
      [
        'redeliver',
        'repo',
        'topic',
        '--session',
        's1',
        '--message',
        'm_1',
        '--attempt',
        'a_1',
      ],
      'POST',
      '/api/links/redeliver',
    ],
  ];
  for (const [argv, method, path] of cases) {
    // biome-ignore lint/performance/noAwaitInLoops: Each call replaces the shared console.
    const run = await links(argv);
    expect(run.code).toBe(0);
    expect(run.calls.map((call) => `${call.method} ${call.path}`)).toEqual([
      `${method} ${path}`,
    ]);
  }
});

test('the recipient is always chosen by repo, branch and exact session', async () => {
  for (const argv of [
    ['send', 'repo', 'topic', '--body-file', '-'],
    ['send', 'repo', '--session', 's1', '--body-file', '-'],
    ['inbox', 'repo', 'topic'],
    ['ack', 'repo', 'topic', '--session', 's1'],
    ['redeliver', 'repo', 'topic', '--session', 's1', '--message', 'm_1'],
    ['show'],
    ['unknown'],
    ['send', 'repo', 'topic', '--session', 's1', '--body-file', '-', '--wake'],
  ]) {
    // biome-ignore lint/performance/noAwaitInLoops: Each call replaces the shared console.
    const run = await links(argv, { files: { 0: 'x' } });
    expect(run.code).toBe(1);
    expect(run.calls).toEqual([]);
  }
});

test('a refusal prints its stable code and exits non-zero', async () => {
  const run = await links(
    ['send', 'repo', 'topic', '--session', 's1', '--body-file', '-', '--json'],
    {
      files: { 0: 'x' },
      reply: {
        code: 'LINKS_NO_NATIVE_BINDING',
        error: 'The session has no verified native conversation',
        ok: false,
      },
    }
  );
  expect(run.code).toBe(1);
  expect(JSON.parse(run.out).code).toBe('LINKS_NO_NATIVE_BINDING');
});

test('with the portal down the CLI refuses with PORTAL_REQUIRED instead of launching anything', async () => {
  const refused = Object.assign(new Error('connect failed'), {
    code: 'ConnectionRefused',
  });
  const run = await links(
    ['inbox', 'repo', 'topic', '--session', 's1', '--json'],
    { fail: refused }
  );
  expect(run.code).toBe(1);
  expect(JSON.parse(run.out)).toMatchObject({
    code: 'PORTAL_REQUIRED',
    ok: false,
  });
});

test('a send whose outcome the portal never confirmed is reported unknown with the key to repeat it', async () => {
  const run = await links(
    [
      'send',
      'repo',
      'topic',
      '--session',
      's1',
      '--body-file',
      '-',
      '--idempotency-key',
      'key-9',
      '--json',
    ],
    { fail: new Error('socket closed'), files: { 0: 'SECRET-TEXT' } }
  );
  expect(run.code).toBe(1);
  const result = JSON.parse(run.out);
  expect(result).toMatchObject({ code: 'LINKS_OUTCOME_UNKNOWN', ok: false });
  expect(result.error).toContain('key-9');
  expect(run.out + run.err).not.toContain('SECRET-TEXT');
});

test('redeliver submits the reviewed token only when the user passes it, and no other command accepts one', async () => {
  const base = [
    'redeliver',
    'repo',
    'topic',
    '--session',
    's1',
    '--message',
    'm_1',
    '--attempt',
    'a_1',
  ];
  const review = await links(base);
  expect(review.calls[0].body).toEqual({
    attemptId: 'a_1',
    messageId: 'm_1',
    name: 'topic',
    repo: 'repo',
    sessionId: 's1',
  });
  const confirmed = await links([...base, '--confirmation', 'redeliver:m_1']);
  expect(confirmed.calls[0].body.confirmation).toBe('redeliver:m_1');

  const other = await links([
    'ack',
    'repo',
    'topic',
    '--session',
    's1',
    '--message',
    'm_1',
    '--confirmation',
    'x',
  ]);
  expect(other.code).toBe(1);
  expect(other.calls).toEqual([]);
});

test('a refusal that asks for review prints the confirmation for the user to read', async () => {
  const run = await links(
    [
      'redeliver',
      'repo',
      'topic',
      '--session',
      's1',
      '--message',
      'm_1',
      '--attempt',
      'a_1',
      '--json',
    ],
    {
      reply: {
        code: 'LINKS_CONFIRMATION_REQUIRED',
        confirmation: { token: 'redeliver:m_1;attempt:a_1' },
        error: 'Review this message.',
        ok: false,
      },
    }
  );
  expect(run.code).toBe(1);
  expect(JSON.parse(run.out).confirmation.token).toBe(
    'redeliver:m_1;attempt:a_1'
  );
});

test('a send the portal reports as unknown prints the generated key so a retry cannot duplicate it', async () => {
  const run = await links(
    ['send', 'repo', 'topic', '--session', 's1', '--body-file', '-', '--json'],
    {
      files: { 0: 'text' },
      reply: {
        code: 'LINKS_OUTCOME_UNKNOWN',
        error: 'The Links engine did not confirm this send.',
        ok: false,
      },
    }
  );
  const sentKey = run.calls[0].body.idempotencyKey;
  expect(sentKey).toMatch(UUID);
  expect(run.code).toBe(1);
  const result = JSON.parse(run.out);
  expect(result.code).toBe('LINKS_OUTCOME_UNKNOWN');
  expect(result.error).toContain(`--idempotency-key ${sentKey}`);
});

test('an unknown outcome for any other command never suggests an idempotency key', async () => {
  const run = await links(['cancel', 'm_1', '--json'], {
    reply: {
      code: 'LINKS_OUTCOME_UNKNOWN',
      error: 'The Links engine did not confirm this cancel.',
      ok: false,
    },
  });
  expect(run.code).toBe(1);
  expect(JSON.parse(run.out).error).not.toContain('idempotency');
});

test('every Links route has a CLI command and every CLI command has a route', async () => {
  const commands = [
    ['send', 'repo', 'topic', '--session', 's1', '--body-file', '-'],
    ['inbox', 'repo', 'topic', '--session', 's1'],
    ['show', 'm_1'],
    ['status', 'm_1'],
    ['cancel', 'm_1'],
    ['ack', 'repo', 'topic', '--session', 's1', '--message', 'm_1'],
    [
      'redeliver',
      'repo',
      'topic',
      '--session',
      's1',
      '--message',
      'm_1',
      '--attempt',
      'a_1',
    ],
  ];
  commands.push(
    ['share', 'enable', 'repo'],
    ['share', 'disable', 'repo'],
    ['share', 'status', 'repo'],
    ['share', 'attention', 'repo', 'on'],
    ['directory'],
    ['capabilities'],
    ['attention', 'open', 'att_1'],
    ['send-now', 'repo', 'topic', '--session', 's1', '--message', 'm_1']
  );
  const used = new Set();
  for (const argv of commands) {
    // biome-ignore lint/performance/noAwaitInLoops: Each call replaces the shared console.
    const run = await links(argv, { files: { 0: 'x' } });
    used.add(`${run.calls[0].method} ${run.calls[0].path.split('?')[0]}`);
  }
  const routes = PORTAL_API_ROUTES.filter((route) =>
    route.path.startsWith('/api/links/')
  ).flatMap((route) =>
    route.methods.map((method) => `${method} ${route.path}`)
  );
  expect([...used].sort()).toEqual(routes.sort());
});

test('share enable posts only the project until the user passes the reviewed token back, and no other command accepts one', async () => {
  const review = await links(['share', 'enable', 'repo', '--json']);
  expect(review.calls).toEqual([
    { body: { repo: 'repo' }, method: 'POST', path: '/api/links/share/enable' },
  ]);

  const owner = await links([
    'share',
    'enable',
    'repo',
    '--owner',
    'Mukul',
    '--confirmation',
    'share:repo;owner:Mukul',
    '--json',
  ]);
  expect(owner.calls[0].body).toEqual({
    confirmation: 'share:repo;owner:Mukul',
    owner: 'Mukul',
    repo: 'repo',
  });

  for (const argv of [
    ['share', 'disable', 'repo', '--confirmation', 'x'],
    ['share', 'status', 'repo', '--owner', 'x'],
    ['directory', '--confirmation', 'x'],
  ]) {
    // biome-ignore lint/performance/noAwaitInLoops: Each call replaces the shared console.
    const run = await links(argv);
    expect(run.code).toBe(1);
    expect(run.calls).toEqual([]);
  }
});

test('a sharing review is printed for the user to read and exits non-zero so nothing is taken as confirmed', async () => {
  const run = await links(['share', 'enable', 'repo', '--json'], {
    reply: {
      code: 'LINKS_CONFIRMATION_REQUIRED',
      confirmation: {
        fields: [{ field: 'owner', keys: ['owner'], meaning: 'Owner label' }],
        project: 'repo',
        token: 'share:repo;owner:mukul',
      },
      error: 'Nothing has been shared.',
      ok: false,
    },
  });
  expect(run.code).toBe(1);
  const printed = JSON.parse(run.out);
  expect(printed.confirmation.fields[0].field).toBe('owner');
  expect(printed.confirmation.token).toBe('share:repo;owner:mukul');
});

test('share status and the directory take an optional project and read only', async () => {
  const cases = [
    [['share', 'status'], 'GET', '/api/links/share/status'],
    [['share', 'status', 'repo'], 'GET', '/api/links/share/status?repo=repo'],
    [['directory'], 'GET', '/api/links/directory'],
    [['directory', 'repo'], 'GET', '/api/links/directory?repo=repo'],
    [['share', 'disable', 'repo'], 'POST', '/api/links/share/disable'],
  ];
  for (const [argv, method, path] of cases) {
    // biome-ignore lint/performance/noAwaitInLoops: Each call replaces the shared console.
    const run = await links(argv);
    expect(run.calls.map((call) => `${call.method} ${call.path}`)).toEqual([
      `${method} ${path}`,
    ]);
  }
});

test('malformed sharing commands never reach the portal', async () => {
  for (const argv of [
    ['share'],
    ['share', 'enable'],
    ['share', 'enable', 'repo', 'extra'],
    ['share', 'disable'],
    ['share', 'bogus', 'repo'],
    ['share', 'status', 'a', 'b'],
    ['directory', 'a', 'b'],
    ['share', 'enable', 'repo', '--wake'],
  ]) {
    // biome-ignore lint/performance/noAwaitInLoops: Each call replaces the shared console.
    const run = await links(argv);
    expect(run.code).toBe(1);
    expect(run.calls).toEqual([]);
  }
});

test('with the portal down sharing commands refuse with PORTAL_REQUIRED', async () => {
  const refused = Object.assign(new Error('connect failed'), {
    code: 'ConnectionRefused',
  });
  const run = await links(['share', 'enable', 'repo', '--json'], {
    fail: refused,
  });
  expect(JSON.parse(run.out)).toMatchObject({ code: 'PORTAL_REQUIRED' });
});
