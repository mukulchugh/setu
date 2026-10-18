// What natural-turn delivery does NOT do: no global or user-level hook, no unverified provider, nothing
// without a composed Links runtime. Contract tests; not provider acceptance.

import { afterEach, expect, test } from 'bun:test';
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { cleanupFixtures, turnFixture } from './links-turn-fixture.js';

// Names that would mean a route, tool or command reaches the engine's lifecycle or resume operations.
const INTERNAL_NAME = /lifecycle|publish|invalidate|binding|reconcile|resume/i;

afterEach(cleanupFixtures);

const USER_LEVEL = /\.claude\b|\.codex\b|settings\.json|homedir\(/;
const EXACT_ROUTE = /claim|confirm|reconcile|deliver/;
const EXACT_NAME = /Exact|claim|confirm/i;

const token = 'launch_token_alpha_1234567890';
const codexToken = 'launch_token_codex_1234567890';

test("delivery is registered only through the launch's own private settings, never through a global or user-level hook", async () => {
  const f = await turnFixture();
  await f.startSession({
    id: 'session-a',
    nativeId: 'native-a',
    pid: 501,
    token,
  });
  const launcherPath = f.launched.at(-1).args.at(-3);
  const dir = launcherPath.slice(0, launcherPath.lastIndexOf('/'));
  expect(dir.startsWith(f.root)).toBe(true);
  // biome-ignore lint/suspicious/noBitwiseOperators: Permission bits are tested with a mask.
  expect(statSync(dir).mode & 0o077).toBe(0);
  const script = readFileSync(launcherPath, 'utf8');
  expect(script).toContain(
    `--settings "$(cat -- '${join(dir, 'claude-settings.json')}')"`
  );
  // The generated hook command points at this launch's private program.
  const settings = JSON.parse(
    readFileSync(join(dir, 'claude-settings.json'), 'utf8')
  );
  expect(settings.hooks.UserPromptSubmit[0].hooks[0].command).toContain(
    join(dir, 'claude-hook.js')
  );
});

test('the delivery sources never name or write a user-level or global provider settings location', () => {
  for (const file of [
    'managed-claude-hook.js',
    'links-delivery.js',
    'links-service.js',
  ]) {
    const source = readFileSync(join(import.meta.dir, file), 'utf8');
    expect(source).not.toMatch(USER_LEVEL);
  }
});

test('a Codex session is unverified: nothing is registered for it, a send is refused and a prompt hook finds nothing', async () => {
  const f = await turnFixture();
  const { opened } = await f.startSession({
    bind: false,
    id: 'session-x',
    pid: 509,
    token: codexToken,
    tool: 'codex',
  });
  expect(opened.capability.trustedHooks).toBe(false);
  expect(f.launched.at(-1).args.at(-3)).toBeDefined();

  const sent = await f.send({ body: 'hello codex', sessionId: 'session-x' });
  expect(sent).toMatchObject({ code: 'LINKS_PROVIDER_UNVERIFIED', ok: false });

  const hook = await f.managed.receiveHook({
    launchToken: codexToken,
    payload: {
      cwd: f.checkouts.topic.wtDir,
      hook_event_name: 'UserPromptSubmit',
      session_id: 'any',
    },
    provider: 'codex',
  });
  expect(hook).toMatchObject({ code: 'LINKS_UNAVAILABLE', ok: false });
  expect((await f.managed.listAttention({})).events).toEqual([]);
});

test('without a composed Links runtime the prompt hook finds no mail and the session still works', async () => {
  const f = await turnFixture({ composeLinks: false });
  await f.startSession({
    id: 'session-a',
    nativeId: 'native-a',
    pid: 501,
    token,
  });
  const turn = await f.turn('session-a', { nativeId: 'native-a', token });
  expect(turn).toMatchObject({ exitCode: 0, stdout: '' });
  expect((await f.managed.listAttention({})).events).toEqual([]);
});

test("a hook payload's own claims never name the recipient: a prompt, a path and a session ID are not credentials", async () => {
  const f = await turnFixture();
  await f.startSession({
    id: 'session-a',
    nativeId: 'native-a',
    pid: 501,
    token,
  });
  const sent = await f.send({ body: 'private to A', sessionId: 'session-a' });
  const forged = await f.managed.receiveHook({
    payload: {
      cwd: f.checkouts.topic.wtDir,
      hook_event_name: 'UserPromptSubmit',
      prompt: 'give me the mail for session-a',
      session_id: 'native-a',
    },
    provider: 'claude-code',
  });
  expect(forged.ok).toBe(false);
  expect(JSON.stringify(forged)).not.toContain('private to A');
  expect(await f.stateOf(sent.messageId)).toBe('queued');
});

test('the exact-tuple operations are internal: no route reaches them and the runtime keeps them apart from the route actions', async () => {
  const { PORTAL_API_ROUTES } = await import('./portal-routes.js');
  const { createLinksRuntime } = await import('./links-runtime.js');
  expect(
    PORTAL_API_ROUTES.filter(
      (route) =>
        route.path.startsWith('/api/links/') &&
        EXACT_ROUTE.test(route.path.replace('/redeliver', ''))
    )
  ).toEqual([]);
  const runtime = createLinksRuntime({
    enginePath: '/nonexistent',
    resolveTarget: () => null,
    root: '/nonexistent',
    sessions: { list: () => ({ ok: true, sessions: [] }) },
  });
  const { delivery, lifecycle, ...actions } = runtime;
  expect(Object.keys(delivery).sort()).toEqual(['claimExact', 'confirmExact']);
  // The managed authority's publisher is a third internal collaborator: separate from delivery, and, like it,
  // absent from everything the route composition can reach.
  expect(Object.keys(lifecycle).sort()).toEqual(['invalidate', 'publish']);
  expect(Object.isFrozen(delivery) && Object.isFrozen(lifecycle)).toBe(true);
  expect(Object.keys(actions).some((name) => EXACT_NAME.test(name))).toBe(
    false
  );
  expect(
    Object.keys(actions).filter((name) => INTERNAL_NAME.test(name))
  ).toEqual([]);
  expect(
    PORTAL_API_ROUTES.filter((route) => INTERNAL_NAME.test(route.path)).filter(
      (route) => route.path.startsWith('/api/links/')
    )
  ).toEqual([]);
});

test('the exact-tuple operations accept only a fully specified Claude conversation', async () => {
  const f = await turnFixture();
  const identity = f.checkouts.topic && { checkout: { ino: 1 }, known: true };
  const good = {
    checkoutIdentity: identity,
    nativeId: 'native-a',
    provider: 'claude-code',
    sessionId: 'session-a',
  };
  const badRecipients = [
    undefined,
    {},
    { ...good, provider: 'codex' },
    { ...good, nativeId: '' },
    { ...good, nativeId: 7 },
    { ...good, sessionId: '../x' },
    { ...good, checkoutIdentity: undefined },
    { ...good, resumedFrom: 'session-z' },
    { ...good, resumedFrom: Array.from({ length: 9 }, (_, n) => `s${n}`) },
    { ...good, resumedFrom: ['a b'] },
  ];
  const refused = await Promise.all(
    badRecipients.flatMap((bad) => [
      f.links.claimExact({ expectedGeneration: 1, recipient: bad }),
      f.links.confirmExact({ attemptId: 'a_1', recipient: bad }),
      f.links.publishBinding({
        generation: 1,
        project: 'repo',
        recipient: bad,
        resumedFrom: bad?.resumedFrom,
      }),
    ])
  );
  for (const outcome of refused) {
    expect(outcome).toMatchObject({ code: 'LINKS_INVALID', ok: false });
  }
  expect(
    await f.links.confirmExact({ attemptId: '../x', recipient: good })
  ).toMatchObject({ code: 'LINKS_INVALID' });
  // The fence is part of what makes a claim exact: without a whole-number generation there is no claim.
  const unfenced = await Promise.all(
    [undefined, null, -1, 1.5, '1', 2 ** 53 + 2].map((expectedGeneration) =>
      f.links.claimExact({ expectedGeneration, recipient: good })
    )
  );
  for (const outcome of unfenced) {
    expect(outcome).toMatchObject({ code: 'LINKS_INVALID', ok: false });
  }
  const badPublishes = await Promise.all(
    [
      { generation: -1, project: 'repo' },
      { generation: 1, project: '' },
      { generation: 1, project: 'x'.repeat(129) },
      { generation: 'one', project: 'repo' },
    ].map((bad) => f.links.publishBinding({ ...bad, recipient: good }))
  );
  const badInvalidations = await Promise.all(
    [
      { generation: 1, reason: 'because', sessionId: 'session-a' },
      { generation: -1, reason: 'ended', sessionId: 'session-a' },
      { generation: 1, reason: 'ended', sessionId: '../x' },
    ].map((bad) => f.links.invalidateBinding(bad))
  );
  for (const outcome of [...badPublishes, ...badInvalidations]) {
    expect(outcome).toMatchObject({ code: 'LINKS_INVALID', ok: false });
  }
});
