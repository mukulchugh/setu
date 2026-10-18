// `setu sessions resume`: the receiving user's explicit, reviewed resume of one native conversation under a
// new managed record. The real CLI with the portal request at its boundary.
import { afterEach, expect, test } from 'bun:test';
import { runCli } from './cli.js';
import { PORTAL_API_ROUTES } from './portal-routes.js';

const initialExitCode = process.exitCode ?? 0;
afterEach(() => {
  process.exitCode = initialExitCode;
});

async function sessions(argv, { reply = { ok: true }, fail } = {}) {
  const calls = [];
  const out = [];
  const err = [];
  const originalLog = console.log;
  const originalError = console.error;
  console.log = (text) => out.push(String(text));
  console.error = (text) => err.push(String(text));
  try {
    const code = await runCli(['sessions', ...argv], {
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

test('resume without a confirmation asks the portal for the review of the exact conversation', async () => {
  const run = await sessions(
    ['resume', 'repo', 'topic', '--native', 'native-x', '--json'],
    {
      reply: {
        code: 'RESUME_CONFIRMATION_REQUIRED',
        confirmation: {
          nativeId: 'native-x',
          token: 'resume:native-x;from:s1',
        },
        ok: false,
      },
    }
  );
  expect(run.calls).toEqual([
    {
      body: { name: 'topic', nativeId: 'native-x', repo: 'repo' },
      method: 'POST',
      path: '/api/agent-sessions/resume',
    },
  ]);
  // A review is not an accepted action: it exits non-zero and shows the token to confirm with.
  expect(process.exitCode).toBe(1);
  expect(JSON.parse(run.out).confirmation.token).toBe(
    'resume:native-x;from:s1'
  );
});

test('resume passes only the token the user supplies, never one it made up', async () => {
  const run = await sessions([
    'resume',
    'repo',
    'topic',
    '--native',
    'native-x',
    '--confirmation',
    'resume:native-x;from:s1',
  ]);
  expect(run.code).toBe(0);
  expect(run.calls[0].body).toEqual({
    confirmation: 'resume:native-x;from:s1',
    name: 'topic',
    nativeId: 'native-x',
    repo: 'repo',
  });
});

test('resume needs a repo, a branch and a conversation, and refuses flags it does not define', async () => {
  for (const argv of [
    ['resume', 'repo', 'topic'],
    ['resume', 'repo', '--native', 'native-x'],
    ['resume', 'repo', 'topic', '--native', 'native-x', '--session', 's1'],
  ]) {
    // biome-ignore lint/performance/noAwaitInLoops: Each call replaces the shared console.
    const run = await sessions(argv).catch((error) => ({ calls: [], error }));
    expect(run.calls).toEqual([]);
  }
});

test('with the portal down, resume refuses rather than launching anything', async () => {
  const run = await sessions(
    ['resume', 'repo', 'topic', '--native', 'native-x', '--json'],
    {
      fail: Object.assign(new Error('Unable to connect'), {
        code: 'ConnectionRefused',
      }),
    }
  );
  expect(process.exitCode).toBe(1);
  expect(JSON.parse(run.out)).toMatchObject({ ok: false });
});

test('the resume route is in the public route table as a POST', () => {
  expect(PORTAL_API_ROUTES).toContainEqual({
    methods: ['POST'],
    path: '/api/agent-sessions/resume',
  });
});
