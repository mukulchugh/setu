// Test support for natural-turn delivery. Composes the real managed-session service, the real Links
// service and client over the real engine binary in a disposable directory, and the portal's real hook
// route over HTTP. The hook is the real generated program run as a child process.
//
// What this proves is Setu's own behavior, driven by RECORDED Claude hook payloads and a fixture process.
// It is a contract test. It is not evidence about a real Claude session, and no result here may be
// reported as provider acceptance.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { inspectCheckoutIdentity } from './checkout-identity.js';
import { createLinksAttention } from './links-attention.js';
import { createLinksClient } from './links-client.js';
import { ensureEngine } from './links-engine-fixture.js';
import { absentUnlessMailbox } from './links-runtime.js';
import { createLinksService } from './links-service.js';
import { createManagedAgentServices } from './managed-agent-services.js';
import { createOperationEvents } from './operation-events.js';
import { dispatchPortalResourceRoute } from './portal-resource-services.js';
import { createWorkspaceState } from './workspace-state.js';

export const start = 'Mon Oct 5 12:00:00 2026';
const uuid = 'A1B2C3D4-E5F6-4A1B-8C2D-1234567890AB';

const roots = [];
const servers = [];

export function cleanupFixtures() {
  for (const server of servers.splice(0)) {
    server.stop(true);
  }
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { force: true, recursive: true });
  }
}

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

const registrationFile = (command, launch) =>
  fs.writeFileSync(
    join(dirname(command.args.at(-3)), 'registration.json'),
    JSON.stringify({
      id: launch.id,
      launchToken: launch.token,
      pid: launch.pid,
      processStart: start,
    })
  );

// A wrapper around the lifecycle publisher: records every call in order, and can be made to fail, stall or
// answer wrongly. When it answers ok it passes the call on to the real publisher the fixture composes (the Links
// service's own, writing the real engine's snapshot), so delivery still has the snapshot its fence needs; a
// test that wants a publisher which never reaches the engine simply puts it in one of the failing modes.
export function recordingLifecycle() {
  const calls = [];
  // How the publisher behaves: answers ok, answers ok:false, rejects, or never answers at all.
  const outcome = (mode) => {
    switch (mode) {
      case 'not-ok':
        return Promise.resolve({ code: 'LINKS_OUTCOME_UNKNOWN', ok: false });
      // Malformed evidence: none of these is the one reply that means "told".
      case 'null':
        return Promise.resolve(null);
      case 'undefined':
        return Promise.resolve(undefined);
      case 'empty':
        return Promise.resolve({});
      case 'wrong-type':
        return Promise.resolve({ ok: 'true' });
      case 'throw':
        return Promise.reject(new Error('transport down'));
      // Answers only when the test says so: `settle(reply)` answers every call waiting.
      case 'deferred':
        return new Promise((resolve) => {
          lifecycle.waiting.push(resolve);
        });
      case 'hang':
        return new Promise(() => {
          /* never settles */
        });
      default:
        return Promise.resolve({ ok: true });
    }
  };
  // Answers ok: the real publisher's own answer when one is composed, else a bare ok.
  const forwarded = (operation, input) =>
    lifecycle.forward
      ? lifecycle.forward[operation](input)
      : Promise.resolve({ ok: true });
  const lifecycle = {
    calls,
    // The earlier shorthand: a failing publisher refuses invalidations and rejects publishes.
    set failing(value) {
      lifecycle.mode = value ? 'failing' : 'ok';
    },
    invalidate(input) {
      calls.push({ op: 'invalidate', ...input });
      if (lifecycle.mode === 'failing') {
        return Promise.resolve({ code: 'LINKS_OUTCOME_UNKNOWN', ok: false });
      }
      return lifecycle.mode === 'ok'
        ? forwarded('invalidate', input)
        : outcome(lifecycle.mode);
    },
    mode: 'ok',
    publish(input) {
      calls.push({ op: 'publish', ...input });
      if (lifecycle.mode === 'failing') {
        return Promise.reject(new Error('transport down'));
      }
      return lifecycle.mode === 'ok'
        ? forwarded('publish', input)
        : outcome(lifecycle.mode);
    },
    settle(reply) {
      for (const resolve of lifecycle.waiting.splice(0)) {
        resolve(reply);
      }
    },
    waiting: [],
  };
  return lifecycle;
}

export function engineBuilds() {
  return { hooks: ensureEngine({ hooks: true }), plain: ensureEngine() };
}

export async function turnFixture({
  names = ['topic'],
  enginePath: initialEngine = ensureEngine(),
  engineTimeoutMs,
  composeLinks = true,
  lifecycle = null,
  lifecycleHeartbeatMs,
  lifecycleTimeoutMs,
  recordHookActivity,
} = {}) {
  let enginePath = initialEngine;
  const root = fs.realpathSync(
    fs.mkdtempSync(join(tmpdir(), 'setu-links-turn-'))
  );
  roots.push(root);
  const checkouts = {};
  for (const name of names) {
    // biome-ignore lint/performance/noAwaitInLoops: Fixture checkouts are created in a deterministic order.
    checkouts[name] = await makeCheckout(root, name);
  }
  const alive = new Set();
  const reused = new Set();
  const launched = [];
  const calls = [];
  // Every terminal automation the portal asked for, every admission it granted and every engine operation it
  // made, so a test can say what a feature did NOT do.
  const scripts = [];
  const admissions = [];
  const engineCalls = [];
  const attentionHooks = {};
  let clock = 1000;
  let nextLaunch;
  let ingressUrl;
  let lastPort = 0;
  const engineHooks = {};
  const stateHooks = {};
  let killAt = null;
  let current;
  const dataDir = join(root, 'links');

  function build() {
    const workspaceState = createWorkspaceState({
      configPath: join(root, 'config.json'),
      setuDir: root,
      workspaceRoot: root,
    });
    const resolveTarget = async ({ repo, name }) => {
      const checkout = checkouts[name];
      if (repo !== 'repo' || !checkout) {
        return null;
      }
      const target = { repoDir: checkout.repoDir, wtDir: checkout.wtDir };
      const checkoutIdentity = await inspectCheckoutIdentity(target, fsp);
      return checkoutIdentity.known
        ? { name, repo, ...target, checkoutIdentity }
        : null;
    };
    const client = createLinksClient({
      dataDir,
      enginePath,
      spawn: (command, options) => {
        const point = killAt;
        return Bun.spawn(command, {
          ...options,
          env: {
            ...process.env,
            ...(point ? { SETU_LINKS_TEST_KILL_AT: point } : {}),
          },
        });
      },
      timeoutMs: engineTimeoutMs,
    });
    // Lets a test move the world while the engine call is in flight, as a concurrent portal request would.
    const watched = {
      async call(op, args) {
        engineCalls.push({ args, op });
        await engineHooks.before?.(op, args);
        const outcome = await client.call(op, args);
        await engineHooks.after?.(op, outcome);
        return outcome;
      },
    };
    const links = createLinksService({
      client: watched,
      isProject: (repo) => repo === 'repo',
      resolveTarget,
      sessions: { list: () => managed.listSessions({}) },
    });
    const callLog = (name, fn) => (input) => {
      calls.push(name);
      return fn(input);
    };
    const exactLinks = {
      claimExact: callLog('claimExact', links.claimExact),
      confirmExact: callLog('confirmExact', links.confirmExact),
    };
    // The managed authority's one way to the engine: the same guarded Links lifecycle the portal composes. A
    // test's recording wrapper, if it brought one, sits in front and forwards to this.
    const realLifecycle = {
      invalidate: absentUnlessMailbox(dataDir, links.invalidateBinding),
      publish: absentUnlessMailbox(dataDir, links.publishBinding),
    };
    if (lifecycle) {
      lifecycle.forward = realLifecycle;
    }
    const managed = createManagedAgentServices({
      admission: {
        admit: ({ operationId, ...rest }) => {
          admissions.push(operationId);
          return Promise.resolve({
            lease: {
              acquiredAt: 1,
              kind: rest.kind,
              operationId,
              owner: { pid: 1, processStart: start },
              target: rest.target,
            },
            ok: true,
          });
        },
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
      launchNative: (command) => {
        launched.push(command);
        if (nextLaunch.register !== false) {
          registrationFile(command, nextLaunch);
        }
        return Promise.resolve({
          availability: 'available',
          stdout: `SETU:LAUNCHED:${uuid}`,
        });
      },
      ...(composeLinks ? { links: exactLinks } : {}),
      lifecycle: lifecycle ?? realLifecycle,
      ...(lifecycleTimeoutMs === undefined ? {} : { lifecycleTimeoutMs }),
      ...(recordHookActivity ? { recordHookActivity } : {}),
      ...(lifecycleHeartbeatMs === undefined ? {} : { lifecycleHeartbeatMs }),
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
      operationEvents: createOperationEvents({
        now: () => 1,
        state: workspaceState,
      }),
      proveGroup: ({ pid }) =>
        Promise.resolve(
          alive.has(pid)
            ? { escaped: [], state: 'owned' }
            : { state: 'unknown' }
        ),
      registrationAttempts: 1,
      resolveTarget,
      runAppleScript: (script) => {
        scripts.push(script);
        return Promise.resolve({
          availability: 'available',
          stdout: `SETU:OK:${uuid}`,
        });
      },
      runtimeDir: root,
      setInterval: () => 1,
      signal: (pid) => {
        alive.delete(pid);
        return Promise.resolve();
      },
      state: {
        read: workspaceState.read,
        // Lets a test land a change in the moment a record update waits for its lock.
        update: async (...args) => {
          await stateHooks.beforeUpdate?.(args[0]);
          return await workspaceState.update(...args);
        },
        withTargets: workspaceState.withTargets,
      },
      token: () => nextLaunch.token,
    });
    // The attention composition the portal builds: the same module, the real services, and a seam just before
    // the focus effect where a test can move the world.
    const attention = createLinksAttention({
      focus: async (input) => {
        await attentionHooks.beforeFocus?.(input);
        return await managed.focus(input);
      },
      links,
      listProvider: (input) => managed.listAttention(input),
    });
    return { attention, client, links, managed, workspaceState };
  }

  const fixture = {
    admissions,
    get attention() {
      return current.attention;
    },
    attentionHooks,
    calls,
    checkouts,
    // The engine client the services use, for a test that must speak to the engine as another sender would.
    get client() {
      return current.client;
    },
    dataDir,
    // The session's process is gone and the portal has observed it.
    async endSession(pid) {
      alive.delete(pid);
      return await current.managed.reconcileSessions();
    },
    engineCalls,
    engineHooks,
    exit(pid) {
      alive.delete(pid);
    },
    // The real hook entrypoint, through the real route: what Claude would do for one event.
    hook(token, { event, nativeId, cwd, report }) {
      return current.managed.receiveHook({
        launchToken: token,
        payload: {
          cwd,
          hook_event_name: event,
          session_id: nativeId,
        },
        provider: 'claude-code',
        ...(report === undefined ? {} : { report }),
      });
    },
    // Every engine process dies when it reaches this commit point (such as `claim:after-commit`); other
    // operations are unaffected. Null stops it. Needs the test-hooks engine build.
    killEngineAt(point) {
      killAt = point;
    },
    launched,
    get links() {
      return current.links;
    },
    // The portal's real hook route over HTTP, always backed by the current services. `intercept` lets a
    // test observe or break one request without touching Setu's code.
    listen({ intercept, port = 0 } = {}) {
      const server = Bun.serve({
        fetch: (request) => {
          const respond = () =>
            dispatchPortalResourceRoute(
              {
                attentionHook: (input) => current.managed.receiveHook(input),
                linksAck: (input) => current.links.ack(input),
                linksInbox: (input) => current.links.inbox(input),
                linksRedeliver: (input) => current.links.redeliver(input),
                linksSend: (input) => current.links.send(input),
                linksShow: (input) => current.links.show(input),
                linksStatus: (input) => current.links.status(input),
              },
              request
            );
          return intercept ? intercept(request, respond) : respond();
        },
        hostname: '127.0.0.1',
        port,
      });
      servers.push(server);
      lastPort = server.port;
      ingressUrl = `http://127.0.0.1:${server.port}/api/attention/hook`;
      return server;
    },
    // The mailbox exists from here on, as it does once the first message was ever sent. (Lifecycle publication
    // never creates one: until then a publisher is told "no mailbox" and tries again.)
    async mailbox() {
      return await current.client.call('sweep', {});
    },
    get managed() {
      return current.managed;
    },
    // A recorded UserPromptSubmit payload: only the fields Claude documents for this event.
    promptPayload({ nativeId, name = 'topic', prompt = 'a user prompt' }) {
      return {
        cwd: checkouts[name].wtDir,
        hook_event_name: 'UserPromptSubmit',
        permission_mode: 'default',
        prompt,
        session_id: nativeId,
        transcript_path: '/nonexistent/recorded-payload.jsonl',
      };
    },
    // A portal restart: new services over the same state directory and the same engine store.
    restart() {
      current = build();
    },
    // The same portal address answering again, over services rebuilt from disk.
    restartServing({ intercept } = {}) {
      const port = fixture.stopServing();
      fixture.listen({ intercept, port });
      current = build();
    },
    // The receiving user's explicit, reviewed resume: a fresh launch of a new managed record. Without the
    // reviewed token it only returns the review.
    async resumeSession({
      id,
      pid,
      token,
      nativeId,
      confirmation,
      name = 'topic',
    }) {
      nextLaunch = { id, pid, token };
      alive.add(pid);
      return await current.managed.resume({
        confirmation,
        name,
        nativeId,
        repo: 'repo',
      });
    },
    // The pid now belongs to a different process (ownership becomes unknown); false puts it right again.
    reusePid(pid, value = true) {
      if (value) {
        reused.add(pid);
      } else {
        reused.delete(pid);
      }
    },
    root,
    async runGeneratedHook(sessionId, options) {
      return await fixture.spawnHook(sessionId, options).done;
    },
    scripts,
    send({ sessionId, body, key, name = 'topic' }) {
      return current.links.send({
        body,
        idempotencyKey: key ?? crypto.randomUUID(),
        name,
        repo: 'repo',
        sessionId,
      });
    },
    serve(options) {
      fixture.listen(options);
      current = build();
    },
    async sessions() {
      const listed = await current.managed.listSessions({});
      return Object.fromEntries(listed.sessions.map((s) => [s.id, s]));
    },
    setClock(value) {
      clock = value;
    },
    // Points the Links client at another engine program (a missing or hanging one), or the real one again.
    setEngine(path = initialEngine) {
      enginePath = path;
      current = build();
    },
    // Starts the generated per-launch hook program exactly as Claude would, with a recorded payload, and
    // returns a handle so a test can kill it at a chosen moment.
    spawnHook(
      sessionId,
      {
        event = 'UserPromptSubmit',
        payload,
        token,
        timeoutMs = 15_000,
        env,
        closeStdout = false,
      }
    ) {
      const dir = fs
        .readdirSync(root)
        .find((entry) => entry.startsWith(`setu-agent-${sessionId}-`));
      const hook = ['bun', join(root, dir, 'claude-hook.js'), event];
      // The reader of the hook's output has already gone: writing to the pipe fails with EPIPE, as it would
      // if the provider stopped reading. (A merely closed descriptor does not model it.)
      const command = closeStdout
        ? [
            'bash',
            '-c',
            'set -o pipefail; "$0" "$@" | { exec 0<&-; :; }',
            ...hook,
          ]
        : hook;
      const child = Bun.spawn(command, {
        env: { ...process.env, SETU_SESSION_TOKEN: token, ...env },
        stderr: 'pipe',
        stdin: new Blob([JSON.stringify(payload)]),
        stdout: 'pipe',
      });
      const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
      const done = Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]).then(([stdout, stderr, exitCode]) => {
        clearTimeout(timer);
        return { exitCode, stderr, stdout };
      });
      return { child, done };
    },
    // One managed session launched through the real open() boundary, bound by its recorded SessionStart.
    async startSession({
      id,
      pid,
      token,
      nativeId,
      name = 'topic',
      bind = true,
      tool = 'claude-code',
    }) {
      nextLaunch = { id, pid, token };
      alive.add(pid);
      const opened = await current.managed.open({
        name,
        repo: 'repo',
        tool,
      });
      if (opened.ok && bind && nativeId) {
        const bound = await fixture.hook(token, {
          cwd: checkouts[name].wtDir,
          event: 'SessionStart',
          nativeId,
        });
        return { bound, opened };
      }
      return { opened };
    },
    // The same turn, started but not awaited.
    startTurn(
      sessionId,
      { token, nativeId, name, prompt, env, timeoutMs, closeStdout }
    ) {
      return fixture.spawnHook(sessionId, {
        closeStdout,
        env,
        payload: fixture.promptPayload({ name, nativeId, prompt }),
        timeoutMs,
        token,
      });
    },
    get state() {
      return current.workspaceState;
    },
    stateHooks,
    async stateOf(messageId) {
      return (await fixture.status(messageId)).state;
    },
    status(messageId) {
      return current.links.status({ messageId });
    },
    // The portal process is gone: nothing answers on its port.
    stopServing() {
      for (const server of servers.splice(0)) {
        server.stop(true);
      }
      return lastPort;
    },
    // One normal user turn in a session.
    turn(sessionId, { token, nativeId, name, prompt, env, timeoutMs }) {
      return fixture.runGeneratedHook(sessionId, {
        env,
        payload: fixture.promptPayload({ name, nativeId, prompt }),
        timeoutMs,
        token,
      });
    },
  };
  fixture.serve();
  return fixture;
}
