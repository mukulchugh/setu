import { afterEach, expect, test } from 'bun:test';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { inspectCheckoutIdentity } from './checkout-identity.js';
import { createManagedAgentServices } from './managed-agent-services.js';
import { createOperationEvents } from './operation-events.js';
import { dispatchPortalResourceRoute } from './portal-resource-services.js';
import { createWorkspaceState } from './workspace-state.js';

const roots = [];
const servers = [];
const start = 'Mon Oct 5 12:00:00 2026';
const uuid = 'A1B2C3D4-E5F6-4A1B-8C2D-1234567890AB';
const tokenA = 'launch_token_alpha_1234567890';
const tokenB = 'launch_token_bravo_1234567890';

afterEach(() => {
  for (const server of servers.splice(0)) {
    server.stop(true);
  }
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { force: true, recursive: true });
  }
});

// Real filesystem layout, so the checkout incarnation is the production evidence.
async function makeCheckout(root, name) {
  const repoDir = join(root, 'repo.git');
  const wtDir = join(root, 'repo', name);
  const admin = join(repoDir, 'worktrees', name);
  await fsp.mkdir(admin, { recursive: true });
  await fsp.mkdir(wtDir, { recursive: true });
  await fsp.writeFile(join(wtDir, '.git'), `gitdir: ${admin}\n`);
  await fsp.writeFile(join(admin, 'gitdir'), `${wtDir}/.git\n`);
  await fsp.writeFile(join(admin, 'commondir'), '../..\n');
  return { admin, name, repoDir, wtDir };
}

async function fixture(names = ['topic']) {
  const root = fs.realpathSync(
    fs.mkdtempSync(join(tmpdir(), 'setu-session-binding-'))
  );
  roots.push(root);
  const checkouts = {};
  for (const name of names) {
    // biome-ignore lint/performance/noAwaitInLoops: Fixture checkouts are created in a deterministic order.
    checkouts[name] = await makeCheckout(root, name);
  }
  const alive = new Set();
  const reused = new Set();
  let clock = 1000;
  let nextLaunch;
  let failWrites = false;
  let observationGate = null;
  let ingressUrl;
  const launched = [];
  function build() {
    const workspaceState = createWorkspaceState({
      configPath: join(root, 'config.json'),
      setuDir: root,
      workspaceRoot: root,
    });
    const state = {
      read: workspaceState.read,
      update: (...args) =>
        failWrites
          ? Promise.reject(new Error('disk full'))
          : workspaceState.update(...args),
      withTargets: workspaceState.withTargets,
    };
    const service = createManagedAgentServices({
      admission: {
        admit: ({ operationId, ...rest }) =>
          Promise.resolve({
            lease: {
              acquiredAt: 1,
              kind: rest.kind,
              operationId,
              owner: { pid: 1, processStart: start },
              target: rest.target,
            },
            ok: true,
          }),
        release: () => Promise.resolve({ ok: true }),
      },
      clearInterval() {
        /* no monitor in this fixture */
      },
      findChildren: () => Promise.resolve({ children: [], state: 'owned' }),
      // Each fake process leads its own group for as long as it is alive.
      findEscaped: () => Promise.resolve({ escaped: [], state: 'owned' }),
      id: () => nextLaunch.id,
      ingressUrl,
      launchNative: async (command) => {
        launched.push(command);
        await nextLaunch.beforeRegistration?.();
        if (nextLaunch.register !== false) {
          writeFileSyncRegistration(command, nextLaunch);
        }
        return { availability: 'available', stdout: `SETU:LAUNCHED:${uuid}` };
      },
      now: () => clock,
      observeGroup: (groupId) => (alive.has(groupId) ? 'alive' : 'absent'),
      observeProcess: (pid) =>
        Promise.resolve(
          alive.has(pid)
            ? {
                processId: pid,
                processStartIdentity: reused.has(pid)
                  ? 'Tue Oct 6 09:00:00 2026'
                  : start,
                state: 'alive',
              }
            : { state: 'absent' }
        ),
      operationEvents: createOperationEvents({ now: () => 1, state }),
      proveGroup: ({ pid }) =>
        Promise.resolve(
          alive.has(pid)
            ? { escaped: [], state: 'owned' }
            : { state: 'unknown' }
        ),
      registrationAttempts: 1,
      resolveTarget: async ({ repo, name }) => {
        const checkout = checkouts[name];
        if (repo !== 'repo' || !checkout) {
          return null;
        }
        const target = { repoDir: checkout.repoDir, wtDir: checkout.wtDir };
        const gate = observationGate;
        observationGate = null;
        if (gate) {
          gate.entered();
          await gate.released;
        }
        const checkoutIdentity = await inspectCheckoutIdentity(target, fsp);
        return checkoutIdentity.known
          ? { name, repo, ...target, checkoutIdentity }
          : null;
      },
      runAppleScript: () =>
        Promise.resolve({
          availability: 'available',
          stdout: `SETU:OK:${uuid}`,
        }),
      runtimeDir: root,
      setInterval: () => 1,
      signal: (pid) => {
        alive.delete(pid);
        return Promise.resolve();
      },
      state,
      token: () => nextLaunch.token,
    });
    return { service, state };
  }
  let current = build();
  return {
    checkouts,
    exit(pid) {
      alive.delete(pid);
    },
    failStateWrites(value) {
      failWrites = value;
    },
    // Holds the next checkout observation open, as a slow filesystem would.
    holdNextObservation() {
      let entered;
      let release;
      const gate = {
        entered: () => entered(),
        released: new Promise((resolve) => {
          release = resolve;
        }),
      };
      observationGate = gate;
      return {
        entered: new Promise((resolve) => {
          entered = resolve;
        }),
        release,
      };
    },
    // A launch of one managed session through the real open() boundary.
    async launch({
      id,
      name = 'topic',
      beforeRegistration,
      pid,
      register,
      token,
      tool = 'claude-code',
    }) {
      nextLaunch = { beforeRegistration, id, pid, register, token };
      alive.add(pid);
      return await current.service.open({ name, repo: 'repo', tool });
    },
    launched,
    // A portal restart: a new service over the same persistent directory.
    restart() {
      current = build();
    },
    // The pid now belongs to a different process: ownership becomes unknown.
    reusePid(pid) {
      reused.add(pid);
    },
    root,
    // Runs the generated per-launch hook program exactly as Claude would.
    async runGeneratedHook(sessionId, { event, payload, token }) {
      const dir = fs
        .readdirSync(root)
        .find((entry) => entry.startsWith(`setu-agent-${sessionId}-`));
      const child = Bun.spawn(
        ['bun', join(root, dir, 'claude-hook.js'), event],
        {
          env: { ...process.env, SETU_SESSION_TOKEN: token },
          stdin: new Blob([JSON.stringify(payload)]),
          stdout: 'ignore',
        }
      );
      return await child.exited;
    },
    // The portal's real hook route over HTTP, always backed by the current service.
    serve(port = 0) {
      const server = Bun.serve({
        fetch: (request) =>
          dispatchPortalResourceRoute(
            { attentionHook: (input) => current.service.receiveHook(input) },
            request
          ),
        port,
      });
      ingressUrl = `http://127.0.0.1:${server.port}/api/attention/hook`;
      servers.push(server);
      current = build();
      return server;
    },
    get service() {
      return current.service;
    },
    async sessions() {
      const listed = await current.service.listSessions();
      expect(listed.ok).toBe(true);
      return Object.fromEntries(listed.sessions.map((s) => [s.id, s]));
    },
    setClock(value) {
      clock = value;
    },
    get state() {
      return current.state;
    },
  };
}

function writeFileSyncRegistration(command, launch) {
  fs.writeFileSync(
    join(dirname(command.args.at(-3)), 'registration.json'),
    JSON.stringify({
      id: launch.id,
      launchToken: launch.token,
      pid: launch.pid,
      processStart: start,
    })
  );
}

const hook = (f, { token, nativeId, event = 'Stop', cwd }) =>
  f.service.receiveHook({
    launchToken: token,
    payload: {
      cwd: cwd ?? f.checkouts.topic.wtDir,
      hook_event_name: event,
      session_id: nativeId,
    },
    provider: 'claude-code',
  });

test('a managed Claude session lists its native conversation as pending, then bound with its bind time', async () => {
  const f = await fixture();
  f.setClock(1000);
  await f.launch({ id: 'session-a', pid: 501, token: tokenA });
  expect((await f.sessions())['session-a'].nativeConversation).toEqual({
    provider: 'claude-code',
    state: 'pending',
  });

  f.setClock(2000);
  await expect(
    hook(f, { event: 'SessionStart', nativeId: 'native-a', token: tokenA })
  ).resolves.toMatchObject({ ok: true, sessionId: 'session-a' });

  expect((await f.sessions())['session-a'].nativeConversation).toEqual({
    boundAt: 2000,
    id: 'native-a',
    provider: 'claude-code',
    state: 'bound',
  });
});

const resolvedSession = (result) => result.attention?.sessionId;

test('after a portal restart the binding persists and a valid hook and attention event still resolve', async () => {
  const f = await fixture();
  await f.launch({ id: 'session-a', pid: 501, token: tokenA });
  await hook(f, { event: 'SessionStart', nativeId: 'native-a', token: tokenA });

  f.restart();

  expect((await f.sessions())['session-a'].nativeConversation).toMatchObject({
    id: 'native-a',
    state: 'bound',
  });
  const stop = await hook(f, { nativeId: 'native-a', token: tokenA });
  expect(resolvedSession(stop)).toBe('session-a');
  expect(stop.attention.state).toBe('between-turns');
  const listed = await f.service.listAttention();
  expect(listed.events.at(-1)).toMatchObject({
    session: { id: 'session-a' },
    sessionId: 'session-a',
    state: 'between-turns',
  });
  expect(JSON.stringify(listed)).not.toContain('launchProofDigest');
});

test('a hook with the right native id and cwd but a missing or wrong capability resolves nothing, before and after restart', async () => {
  const f = await fixture();
  await f.launch({ id: 'session-a', pid: 501, token: tokenA });
  await hook(f, { event: 'SessionStart', nativeId: 'native-a', token: tokenA });

  for (const phase of ['before restart', 'after restart']) {
    // biome-ignore lint/performance/noAwaitInLoops: The restart at the end of each pass is the point of the second pass.
    const missing = await hook(f, { nativeId: 'native-a', token: undefined });
    const malformed = await hook(f, { nativeId: 'native-a', token: 'short' });
    const wrong = await hook(f, {
      nativeId: 'native-a',
      token: 'launch_token_wrong_1234567890',
    });
    expect([phase, resolvedSession(missing)]).toEqual([phase, undefined]);
    expect([phase, resolvedSession(malformed)]).toEqual([phase, undefined]);
    expect([phase, resolvedSession(wrong)]).toEqual([phase, undefined]);
    expect(missing.reason).toBe('launch-proof-missing');
    expect(malformed.reason).toBe('launch-proof-missing');
    expect(wrong.reason).toBe('launch-proof-invalid');
    expect(wrong.attention.state).toBe('unknown');
    f.restart();
  }
});

test("one session's capability presented with another session's native id and cwd resolves nothing, after restart", async () => {
  const f = await fixture(['topic', 'other']);
  await f.launch({ id: 'session-a', pid: 501, token: tokenA });
  await f.launch({ id: 'session-b', name: 'other', pid: 502, token: tokenB });
  await hook(f, { event: 'SessionStart', nativeId: 'native-a', token: tokenA });
  await hook(f, {
    cwd: f.checkouts.other.wtDir,
    event: 'SessionStart',
    nativeId: 'native-b',
    token: tokenB,
  });
  f.restart();

  const aWithB = await hook(f, {
    cwd: f.checkouts.other.wtDir,
    nativeId: 'native-b',
    token: tokenA,
  });
  const bWithA = await hook(f, { nativeId: 'native-a', token: tokenB });
  expect(resolvedSession(aWithB)).toBeUndefined();
  expect(resolvedSession(bWithA)).toBeUndefined();
  expect(
    resolvedSession(
      await hook(f, {
        cwd: f.checkouts.other.wtDir,
        nativeId: 'native-b',
        token: tokenB,
      })
    )
  ).toBe('session-b');
  expect(
    resolvedSession(await hook(f, { nativeId: 'native-a', token: tokenA }))
  ).toBe('session-a');
});

test('once the managed session ends its capability and native id resolve nothing, after restart', async () => {
  const f = await fixture();
  const opened = await f.launch({ id: 'session-a', pid: 501, token: tokenA });
  await hook(f, { event: 'SessionStart', nativeId: 'native-a', token: tokenA });
  f.exit(501);
  await f.service.reconcileSessions();
  f.restart();

  const stop = await hook(f, { nativeId: 'native-a', token: tokenA });
  expect(resolvedSession(stop)).toBeUndefined();
  expect(stop.reason).toBe('session-ended');
  expect(opened.session.id).toBe('session-a');
});

test('each failed resolution returns its own non-secret reason and resolves nothing', async () => {
  const f = await fixture();
  await f.launch({ id: 'session-a', pid: 501, token: tokenA });
  await hook(f, { event: 'SessionStart', nativeId: 'native-a', token: tokenA });
  const { admin } = f.checkouts.topic;

  // Commits and branch switches change HEAD inside one incarnation.
  fs.writeFileSync(join(admin, 'HEAD'), 'ref: refs/heads/other\n');
  expect(
    resolvedSession(await hook(f, { nativeId: 'native-a', token: tokenA }))
  ).toBe('session-a');

  const reasons = {
    differentDirectory: await hook(f, {
      cwd: join(f.root, 'elsewhere'),
      nativeId: 'native-a',
      token: tokenA,
    }),
    unboundConversation: await hook(f, {
      nativeId: 'native-new',
      token: tokenA,
    }),
    unmanaged: await hook(f, {
      nativeId: 'native-unknown',
      token: 'launch_token_nobody_1234567890',
    }),
    wrongProvider: await f.service.receiveHook({
      launchToken: tokenA,
      payload: {
        cwd: f.checkouts.topic.wtDir,
        hook_event_name: 'Stop',
        session_id: 'native-a',
      },
      provider: 'codex',
    }),
  };
  expect(
    Object.fromEntries(
      Object.entries(reasons).map(([key, value]) => [key, value.reason])
    )
  ).toEqual({
    differentDirectory: 'checkout-path-mismatch',
    unboundConversation: 'conversation-unbound',
    unmanaged: 'session-unmanaged',
    wrongProvider: 'provider-mismatch',
  });
  for (const value of Object.values(reasons)) {
    expect(resolvedSession(value)).toBeUndefined();
  }

  // Recreating the checkout directory is a different incarnation.
  const { wtDir } = f.checkouts.topic;
  await fsp.rename(wtDir, `${wtDir}-old`);
  await fsp.mkdir(wtDir);
  await fsp.writeFile(join(wtDir, '.git'), `gitdir: ${admin}\n`);
  const recreated = await hook(f, { nativeId: 'native-a', token: tokenA });
  expect(resolvedSession(recreated)).toBeUndefined();
  expect(recreated.reason).toBe('checkout-changed');
});

test('a session whose process was never confirmed cannot bind a native conversation', async () => {
  const f = await fixture();
  await f.launch({ id: 'session-a', pid: 501, register: false, token: tokenA });
  const refused = await hook(f, {
    event: 'SessionStart',
    nativeId: 'native-a',
    token: tokenA,
  });
  expect(refused).toMatchObject({ ok: false, reason: 'session-not-owned' });
  expect((await f.sessions())['session-a'].nativeConversation.state).toBe(
    'pending'
  );
});

test('SessionStart without the capability, or with a wrong one, binds nothing', async () => {
  const f = await fixture();
  await f.launch({ id: 'session-a', pid: 501, token: tokenA });
  const missing = await hook(f, {
    event: 'SessionStart',
    nativeId: 'native-a',
  });
  const wrong = await hook(f, {
    event: 'SessionStart',
    nativeId: 'native-a',
    token: tokenB,
  });
  expect(missing).toMatchObject({ ok: false, reason: 'launch-proof-missing' });
  expect(wrong).toMatchObject({ ok: false, reason: 'launch-proof-invalid' });
  expect((await f.sessions())['session-a'].nativeConversation.state).toBe(
    'pending'
  );
});

test('a relaunch after the session ends gets its own capability; the old capability and native id stay dead, after restart', async () => {
  const f = await fixture();
  await f.launch({ id: 'session-a', pid: 501, token: tokenA });
  await hook(f, { event: 'SessionStart', nativeId: 'native-a', token: tokenA });
  f.exit(501);
  await f.service.reconcileSessions();
  await f.launch({ id: 'session-c', pid: 503, token: tokenB });
  await hook(f, { event: 'SessionStart', nativeId: 'native-c', token: tokenB });
  f.restart();

  expect(
    resolvedSession(await hook(f, { nativeId: 'native-a', token: tokenA }))
  ).toBeUndefined();
  expect(
    resolvedSession(await hook(f, { nativeId: 'native-a', token: tokenB }))
  ).toBeUndefined();
  expect(
    resolvedSession(await hook(f, { nativeId: 'native-c', token: tokenA }))
  ).toBeUndefined();
  expect(
    resolvedSession(await hook(f, { nativeId: 'native-c', token: tokenB }))
  ).toBe('session-c');
});

test('a second start event with a new native id is a replacement; the old id stops resolving and an exact resume brings it back', async () => {
  const f = await fixture();
  await f.launch({ id: 'session-a', pid: 501, token: tokenA });
  f.setClock(1000);
  await hook(f, { event: 'SessionStart', nativeId: 'native-1', token: tokenA });

  f.setClock(2000);
  await expect(
    hook(f, { event: 'SessionStart', nativeId: 'native-2', token: tokenA })
  ).resolves.toEqual({ ok: true, sessionId: 'session-a' });
  const replaced = (await f.sessions())['session-a'];
  expect(replaced.nativeConversation).toEqual({
    boundAt: 2000,
    id: 'native-2',
    provider: 'claude-code',
    state: 'bound',
  });
  expect(JSON.stringify(replaced)).not.toContain('native-1');
  expect(
    resolvedSession(await hook(f, { nativeId: 'native-1', token: tokenA }))
  ).toBeUndefined();
  expect((await hook(f, { nativeId: 'native-1', token: tokenA })).reason).toBe(
    'conversation-replaced'
  );
  f.restart();
  expect(
    resolvedSession(await hook(f, { nativeId: 'native-2', token: tokenA }))
  ).toBe('session-a');

  f.setClock(3000);
  await hook(f, { event: 'SessionStart', nativeId: 'native-1', token: tokenA });
  expect((await f.sessions())['session-a'].nativeConversation).toEqual({
    boundAt: 3000,
    id: 'native-1',
    provider: 'claude-code',
    state: 'bound',
  });
  expect(
    resolvedSession(await hook(f, { nativeId: 'native-1', token: tokenA }))
  ).toBe('session-a');
  expect(
    resolvedSession(await hook(f, { nativeId: 'native-2', token: tokenA }))
  ).toBeUndefined();
});

test('the same native id announced again changes nothing, including its bind time', async () => {
  const f = await fixture();
  await f.launch({ id: 'session-a', pid: 501, token: tokenA });
  f.setClock(1000);
  await hook(f, { event: 'SessionStart', nativeId: 'native-1', token: tokenA });
  f.setClock(2000);
  await expect(
    hook(f, { event: 'SessionStart', nativeId: 'native-1', token: tokenA })
  ).resolves.toEqual({ ok: true, sessionId: 'session-a' });
  expect((await f.sessions())['session-a'].nativeConversation.boundAt).toBe(
    1000
  );
});

test('replaced native ids are remembered privately, bounded to eight', async () => {
  const f = await fixture();
  await f.launch({ id: 'session-a', pid: 501, token: tokenA });
  for (let n = 1; n <= 11; n += 1) {
    f.setClock(n * 100);
    // biome-ignore lint/performance/noAwaitInLoops: Each replacement depends on the previous binding.
    await hook(f, {
      event: 'SessionStart',
      nativeId: `native-${n}`,
      token: tokenA,
    });
  }
  const privateRecord = f.state.read('agentSessions').sessions['session-a'];
  expect(privateRecord.nativeConversation.id).toBe('native-11');
  expect(
    privateRecord.nativeConversation.history.map((entry) => entry.id)
  ).toEqual([
    'native-3',
    'native-4',
    'native-5',
    'native-6',
    'native-7',
    'native-8',
    'native-9',
    'native-10',
  ]);
  expect(privateRecord.nativeConversation.history.at(-1)).toEqual({
    boundAt: 1000,
    id: 'native-10',
    replacedAt: 1100,
  });
  const publicText = JSON.stringify((await f.sessions())['session-a']);
  expect(publicText).not.toContain('native-10');
  expect(publicText).not.toContain('history');
  expect(publicText).not.toContain('launchProofDigest');
});

test('a native conversation cannot be bound to two live managed sessions, even when both start at once', async () => {
  const f = await fixture(['topic', 'other']);
  await f.launch({ id: 'session-a', pid: 501, token: tokenA });
  await f.launch({ id: 'session-b', name: 'other', pid: 502, token: tokenB });
  const other = f.checkouts.other.wtDir;

  const results = await Promise.all([
    hook(f, { event: 'SessionStart', nativeId: 'native-x', token: tokenA }),
    hook(f, {
      cwd: other,
      event: 'SessionStart',
      nativeId: 'native-x',
      token: tokenB,
    }),
  ]);
  expect(results.filter((result) => result.ok)).toHaveLength(1);
  const refused = results.find((result) => !result.ok);
  expect(refused.reason).toBe('native-conversation-in-use');

  const sessions = await f.sessions();
  const states = [sessions['session-a'], sessions['session-b']].map(
    (session) => session.nativeConversation.state
  );
  expect(states.sort()).toEqual(['bound', 'pending']);
});

test('a live session cannot adopt a native id that an ended or unconfirmed session once held', async () => {
  const f = await fixture();
  await f.launch({ id: 'session-a', pid: 501, token: tokenA });
  await hook(f, { event: 'SessionStart', nativeId: 'native-a', token: tokenA });
  f.exit(501);
  await f.service.reconcileSessions();
  const endedRecord = f.state.read('agentSessions').sessions['session-a'];

  await f.launch({ id: 'session-c', pid: 503, token: tokenB });
  const adopted = await hook(f, {
    event: 'SessionStart',
    nativeId: 'native-a',
    token: tokenB,
  });
  expect(adopted).toMatchObject({
    ok: false,
    reason: 'native-conversation-previously-bound',
  });
  expect((await f.sessions())['session-c'].nativeConversation.state).toBe(
    'pending'
  );
  expect(f.state.read('agentSessions').sessions['session-a']).toEqual(
    endedRecord
  );
});

test('a session whose process ownership became unknown keeps its native id off limits and resolves nothing', async () => {
  const f = await fixture();
  await f.launch({ id: 'session-a', pid: 501, token: tokenA });
  await hook(f, { event: 'SessionStart', nativeId: 'native-a', token: tokenA });
  f.reusePid(501);
  await f.service.reconcileSessions();
  const listed = (await f.sessions())['session-a'];
  expect(listed).toMatchObject({
    nativeConversation: { id: 'native-a', state: 'bound' },
    ownership: 'unknown',
    state: 'unknown',
  });
  expect((await hook(f, { nativeId: 'native-a', token: tokenA })).reason).toBe(
    'session-not-owned'
  );

  await f.launch({ id: 'session-c', pid: 503, token: tokenB });
  expect(
    await hook(f, {
      event: 'SessionStart',
      nativeId: 'native-a',
      token: tokenB,
    })
  ).toMatchObject({
    ok: false,
    reason: 'native-conversation-previously-bound',
  });
});

test('only a digest of the capability is persisted, in the owner-only managed-session store', async () => {
  const f = await fixture();
  const logs = [];
  const original = {
    error: console.error,
    log: console.log,
    warn: console.warn,
  };
  const capture = (...args) => logs.push(args.join(' '));
  console.log = capture;
  console.error = capture;
  console.warn = capture;
  try {
    await f.launch({ id: 'session-a', pid: 501, token: tokenA });
    await hook(f, {
      event: 'SessionStart',
      nativeId: 'native-a',
      token: tokenA,
    });
    await hook(f, { nativeId: 'native-a', token: tokenA });
    await hook(f, { nativeId: 'native-a', token: tokenB });
    f.restart();
    await hook(f, { nativeId: 'native-a', token: tokenA });
  } finally {
    Object.assign(console, original);
  }

  const storePath = join(f.root, '.setu-agent-sessions.json');
  expect(fs.statSync(storePath).mode % 0o1000).toBe(0o600);
  expect(
    f.state.read('agentSessions').sessions['session-a'].launchProofDigest
  ).toBe('0dba49a282db47a1e80d96cd9fa54cdf5d2ca924f9334808b36e004df31ca1c9');

  // State documents and diagnostics hold no capability. The 0700 launcher in
  // the runtime directory is the one intended carrier and is excluded.
  const stateFiles = fs
    .readdirSync(f.root, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => fs.readFileSync(join(f.root, entry.name), 'utf8'));
  expect(stateFiles.length).toBeGreaterThan(0);
  for (const text of [...stateFiles, ...logs]) {
    expect(text).not.toContain(tokenA);
    expect(text).not.toContain(tokenB);
  }
  expect(JSON.stringify(await f.service.listAttention())).not.toContain(tokenA);
});

const legacyRecord = (f, overrides = {}) => ({
  checkoutIdentity: { legacy: true },
  checkoutPath: f.checkouts.topic.wtDir,
  id: 'legacy-1',
  launchedAt: 5,
  name: 'topic',
  ownership: 'owned',
  pid: 900,
  processStart: start,
  repo: 'repo',
  state: 'running',
  tool: 'claude-code',
  ...overrides,
});

test('records written before bindings existed still list as pending and survive other sessions binding', async () => {
  const f = await fixture();
  const legacy = legacyRecord(f, { futureField: { keep: 'me' } });
  await f.state.update('agentSessions', (document) => ({
    ...document,
    sessions: { 'legacy-1': legacy },
  }));
  f.restart();
  expect((await f.sessions())['legacy-1'].nativeConversation).toEqual({
    provider: 'claude-code',
    state: 'pending',
  });

  await f.launch({ id: 'session-a', pid: 501, token: tokenA });
  await hook(f, { event: 'SessionStart', nativeId: 'native-a', token: tokenA });
  expect(f.state.read('agentSessions').sessions['legacy-1']).toEqual(legacy);
  expect((await hook(f, { nativeId: 'native-a', token: tokenB })).reason).toBe(
    'launch-proof-invalid'
  );
});

test('a corrupt binding fails closed to pending with a recoverable reason, without touching the stored bytes', async () => {
  const f = await fixture();
  await f.launch({ id: 'session-a', pid: 501, token: tokenA });
  await f.state.update('agentSessions', (document) => ({
    ...document,
    sessions: {
      ...document.sessions,
      'session-a': {
        ...document.sessions['session-a'],
        nativeConversation: { id: 7, provider: 'claude-code' },
      },
    },
  }));
  f.restart();
  const storePath = join(f.root, '.setu-agent-sessions.json');
  const before = fs.readFileSync(storePath, 'utf8');

  const listed = await f.sessions();
  expect(listed['session-a'].nativeConversation).toEqual({
    provider: 'claude-code',
    reason: 'binding-invalid',
    state: 'pending',
  });
  expect(
    resolvedSession(await hook(f, { nativeId: '7', token: tokenA }))
  ).toBeUndefined();
  expect(fs.readFileSync(storePath, 'utf8')).toBe(before);

  // An authenticated start event repairs it.
  f.setClock(4000);
  await hook(f, { event: 'SessionStart', nativeId: 'native-a', token: tokenA });
  expect((await f.sessions())['session-a'].nativeConversation).toEqual({
    boundAt: 4000,
    id: 'native-a',
    provider: 'claude-code',
    state: 'bound',
  });
  expect(
    resolvedSession(await hook(f, { nativeId: 'native-a', token: tokenA }))
  ).toBe('session-a');
});

test('a managed Codex session reports its native conversation as unavailable and can never bind one', async () => {
  const f = await fixture();
  await f.launch({ id: 'session-x', pid: 601, token: tokenA, tool: 'codex' });
  const expected = {
    provider: 'codex',
    reason: 'provider-unverified',
    state: 'unavailable',
  };
  expect((await f.sessions())['session-x'].nativeConversation).toEqual(
    expected
  );
  const started = await f.service.receiveHook({
    launchToken: tokenA,
    payload: {
      cwd: f.checkouts.topic.wtDir,
      hook_event_name: 'SessionStart',
      session_id: 'native-x',
    },
    provider: 'codex',
  });
  expect(started.ok).toBe(false);
  expect((await f.sessions())['session-x'].nativeConversation).toEqual(
    expected
  );
});

test('a failed state write during bind leaves the previous binding intact and a retry succeeds', async () => {
  const f = await fixture();
  await f.launch({ id: 'session-a', pid: 501, token: tokenA });
  f.setClock(1000);
  await hook(f, { event: 'SessionStart', nativeId: 'native-1', token: tokenA });

  f.failStateWrites(true);
  const failed = await hook(f, {
    event: 'SessionStart',
    nativeId: 'native-2',
    token: tokenA,
  });
  expect(failed).toMatchObject({ ok: false, reason: 'binding-unavailable' });
  f.failStateWrites(false);
  f.restart();
  expect((await f.sessions())['session-a'].nativeConversation).toMatchObject({
    boundAt: 1000,
    id: 'native-1',
  });

  f.setClock(2000);
  await hook(f, { event: 'SessionStart', nativeId: 'native-2', token: tokenA });
  expect((await f.sessions())['session-a'].nativeConversation).toMatchObject({
    boundAt: 2000,
    id: 'native-2',
  });
});

test('the generated hook program binds and resolves through the real route, across a portal restart', async () => {
  const f = await fixture();
  let server = f.serve();
  await f.launch({ id: 'session-a', pid: 501, token: tokenA });
  const payload = (event, nativeId) => ({
    cwd: f.checkouts.topic.wtDir,
    hook_event_name: event,
    session_id: nativeId,
  });

  expect(
    await f.runGeneratedHook('session-a', {
      event: 'SessionStart',
      payload: payload('SessionStart', 'native-a'),
      token: tokenA,
    })
  ).toBe(0);
  expect((await f.sessions())['session-a'].nativeConversation).toMatchObject({
    id: 'native-a',
    state: 'bound',
  });

  // Portal restart: stop the server, rebuild the service, serve the same port.
  const { port } = server;
  server.stop(true);
  f.restart();
  server = f.serve(port);

  await f.runGeneratedHook('session-a', {
    event: 'Stop',
    payload: payload('Stop', 'native-a'),
    token: tokenA,
  });
  await f.runGeneratedHook('session-a', {
    event: 'Stop',
    payload: payload('Stop', 'native-a'),
    token: tokenB,
  });
  const { events } = await f.service.listAttention();
  expect(events.map((event) => [event.state, event.sessionId])).toEqual([
    ['between-turns', 'session-a'],
    ['unknown', undefined],
  ]);
});

test('a start event that arrives before the launcher registration is read still binds and survives registration', async () => {
  const f = await fixture();
  let early;
  const opened = await f.launch({
    beforeRegistration: async () => {
      early = await hook(f, {
        event: 'SessionStart',
        nativeId: 'native-a',
        token: tokenA,
      });
    },
    id: 'session-a',
    pid: 501,
    token: tokenA,
  });
  expect(early).toEqual({ ok: true, sessionId: 'session-a' });
  expect(opened.session.state).toBe('running');
  expect((await f.sessions())['session-a']).toMatchObject({
    nativeConversation: { id: 'native-a', state: 'bound' },
    state: 'running',
  });
  expect(
    resolvedSession(await hook(f, { nativeId: 'native-a', token: tokenA }))
  ).toBe('session-a');
});

test('the sessions API response carries the public binding only, never the digest or replaced ids', async () => {
  const f = await fixture();
  await f.launch({ id: 'session-a', pid: 501, token: tokenA });
  f.setClock(1500);
  await hook(f, { event: 'SessionStart', nativeId: 'native-1', token: tokenA });
  await hook(f, { event: 'SessionStart', nativeId: 'native-2', token: tokenA });

  const response = await dispatchPortalResourceRoute(
    { agentSessions: (input) => f.service.listSessions(input) },
    new Request('http://portal.test/api/agent-sessions?repo=repo&name=topic')
  );
  const body = await response.json();
  expect(body.sessions).toHaveLength(1);
  expect(body.sessions[0].nativeConversation).toEqual({
    boundAt: 1500,
    id: 'native-2',
    provider: 'claude-code',
    state: 'bound',
  });
  const text = JSON.stringify(body);
  expect(text).not.toContain('launchProofDigest');
  expect(text).not.toContain('history');
  expect(text).not.toContain('native-1');
  expect(text).not.toContain(
    '0dba49a282db47a1e80d96cd9fa54cdf5d2ca924f9334808b36e004df31ca1c9'
  );
});

test('a conversation replaced while a hook awaits checkout observation is not authorized afterwards', async () => {
  const f = await fixture();
  await f.launch({ id: 'session-a', pid: 501, token: tokenA });
  await hook(f, { event: 'SessionStart', nativeId: 'native-1', token: tokenA });

  const hold = f.holdNextObservation();
  const inFlight = hook(f, { nativeId: 'native-1', token: tokenA });
  await hold.entered;
  await hook(f, { event: 'SessionStart', nativeId: 'native-2', token: tokenA });
  hold.release();

  const stop = await inFlight;
  expect(resolvedSession(stop)).toBeUndefined();
  expect(stop.reason).toBe('conversation-replaced');
  const { events } = await f.service.listAttention();
  expect(events.at(-1)).toMatchObject({ state: 'unknown' });
  expect(events.at(-1).sessionId).toBeUndefined();
});

test('a session that ends while a hook awaits checkout observation is not authorized afterwards', async () => {
  const f = await fixture();
  await f.launch({ id: 'session-a', pid: 501, token: tokenA });
  await hook(f, { event: 'SessionStart', nativeId: 'native-1', token: tokenA });

  const hold = f.holdNextObservation();
  const inFlight = hook(f, { nativeId: 'native-1', token: tokenA });
  await hold.entered;
  f.exit(501);
  await f.service.reconcileSessions();
  hold.release();

  const stop = await inFlight;
  expect(resolvedSession(stop)).toBeUndefined();
  expect(stop.reason).toBe('session-ended');
});

test('every public session output omits the digest and replaced ids, including end responses', async () => {
  const f = await fixture();
  const opened = await f.launch({ id: 'session-a', pid: 501, token: tokenA });
  await hook(f, { event: 'SessionStart', nativeId: 'native-1', token: tokenA });
  await hook(f, { event: 'SessionStart', nativeId: 'native-2', token: tokenA });
  const { checkoutIdentity } = (await f.sessions())['session-a'];
  const endRoute = async () =>
    (
      await dispatchPortalResourceRoute(
        { endAgentSession: (input) => f.service.endSession(input) },
        new Request('http://portal.test/api/agent-sessions/end', {
          body: JSON.stringify({
            checkoutIdentity,
            name: 'topic',
            repo: 'repo',
            sessionId: 'session-a',
          }),
          method: 'POST',
        })
      )
    ).json();
  const outputs = {
    ended: await endRoute(),
    endedAgain: await endRoute(),
    opened,
    reconciled: await f.service.reconcileSessions(),
    recovered: await f.service.recover(),
  };
  expect(outputs.ended).toMatchObject({
    ok: true,
    session: { nativeConversation: { id: 'native-2', state: 'bound' } },
  });
  expect(outputs.endedAgain.session.state).toBe('ended');

  // Error-shaped responses that carry a session record.
  const g = await fixture();
  await g.launch({ id: 'session-a', pid: 501, token: tokenA });
  await hook(g, { event: 'SessionStart', nativeId: 'native-1', token: tokenA });
  await hook(g, { event: 'SessionStart', nativeId: 'native-2', token: tokenA });
  g.reusePid(501);
  const unknown = await g.service.endSession({
    checkoutIdentity: (await g.sessions())['session-a'].checkoutIdentity,
    name: 'topic',
    repo: 'repo',
    sessionId: 'session-a',
  });
  expect(unknown).toMatchObject({ ok: false, session: { state: 'unknown' } });
  outputs.unknown = unknown;

  for (const [label, output] of Object.entries(outputs)) {
    const text = JSON.stringify(output);
    expect([label, text.includes('launchProofDigest')]).toEqual([label, false]);
    expect([label, text.includes('history')]).toEqual([label, false]);
    expect([label, text.includes('native-1')]).toEqual([label, false]);
  }
  // Private reads still keep the fields.
  expect(
    f.state.read('agentSessions').sessions['session-a'].launchProofDigest
  ).toHaveLength(64);
});
