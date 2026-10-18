// Real-process regressions for managed session completion. Every process here
// is a harmless sh/sleep/python fixture started by this file; each is signalled
// only by pid or by its own group, and all are reaped after every test. The
// guarantee under test is a cooperative group lifecycle, not a sandbox: it
// accounts for the proved execution group and for descendants observed outside
// it while the root was live, and for nothing else.
import { afterEach, expect, test } from 'bun:test';
import { spawn } from 'node:child_process';
import fs, { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildAgentSessionLaunch,
  parseSessionRegistration,
} from './agent-session-launcher.js';
import { createAgentSessions } from './agent-sessions.js';
import {
  observeProcessGroup,
  observeProcessIdentity,
} from './process-observation.js';
import {
  findEscapedDescendants,
  findProcessChildren,
  proveProcessGroupOwnership,
} from './process-tree.js';
import { createWorkspaceState } from './workspace-state.js';

const marker = `SETUEXIT${process.pid}X${Date.now().toString(36)}`;
const checkoutIdentity = { head: 'abc123', known: true };
const launch = {
  checkoutIdentity,
  checkoutPath: '/work/repo/topic',
  id: 'session-1',
  name: 'topic',
  repo: 'repo',
  tool: 'claude-code',
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const roots = [];
const children = [];
const registeredLeaders = new Set();

// A python escapee: leaves the root's group and session, sleeps, exits.
const escapee = (seconds) =>
  `python3 -c "import os,time;os.setsid();time.sleep(${seconds})" ${marker}`;

async function until(check, label, ms = 10_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    // biome-ignore lint/performance/noAwaitInLoops: Poll sequentially until the observed condition holds.
    const value = await check();
    if (value) {
      return value;
    }
    await sleep(40);
  }
  throw new Error(`timed out: ${label}`);
}

// Our own fixtures carry the marker in their command line.
function markedProcesses() {
  const table = Bun.spawnSync(['ps', '-axo', 'pid=,command=']);
  return new TextDecoder()
    .decode(table.stdout)
    .split('\n')
    .filter((line) => line.includes(marker) && !line.includes('ps -axo'))
    .map((line) => Number(line.trim().split(whitespace)[0]));
}

afterEach(async () => {
  for (const child of children.splice(0)) {
    try {
      process.kill(-child.pid, 'SIGKILL');
    } catch {
      // Already gone.
    }
  }
  for (const pid of registeredLeaders) {
    try {
      process.kill(-pid, 'SIGKILL');
    } catch {
      // Already gone.
    }
  }
  registeredLeaders.clear();
  for (const pid of markedProcesses()) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // Already gone.
    }
  }
  await until(() => markedProcesses().length === 0, 'fixtures reaped', 5000);
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { force: true, recursive: true });
  }
});

const whitespace = /\s+/;
function groupOf(pid) {
  const row = Bun.spawnSync(['ps', '-o', 'pgid=', '-p', String(pid)]);
  return Number(new TextDecoder().decode(row.stdout).trim());
}

// A root of its own group, as the launcher's job control makes it under a tty.
function leader(script) {
  const child = spawn('/bin/sh', ['-c', `${script} # ${marker}`], {
    detached: true,
    stdio: 'ignore',
  });
  children.push(child);
  const exited = new Promise((resolve) => child.once('exit', resolve));
  return { child, exited, pid: child.pid };
}

function setup() {
  const root = mkdtempSync(join(tmpdir(), 'setu-exit-real-'));
  roots.push(root);
  const state = createWorkspaceState({
    configPath: join(root, 'config.json'),
    setuDir: root,
    workspaceRoot: root,
  });
  const signals = [];
  const open = () =>
    createAgentSessions({
      findChildren: ({ pid, processStart }) =>
        findProcessChildren(pid, { processStart }),
      findEscaped: ({ groupId, pid, processStart }) =>
        findEscapedDescendants(pid, { groupId, processStart }),
      now: () => Date.now(),
      observeGroup: observeProcessGroup,
      observeProcess: observeProcessIdentity,
      proveGroup: proveProcessGroupOwnership,
      signal: (pid, value) => {
        // Only a registered fixture, or one in a registered fixture's own group.
        if (
          !(registeredLeaders.has(pid) || registeredLeaders.has(groupOf(pid)))
        ) {
          throw new Error(`refusing to signal pid ${pid}`);
        }
        signals.push([pid, value]);
        process.kill(pid, value);
      },
      state,
    });
  return { open, sessions: open(), signals, state };
}

async function register(f, pid) {
  const identity = await observeProcessIdentity(pid);
  expect(identity.state).toBe('alive');
  registeredLeaders.add(pid);
  const outcome = await f.sessions.register({
    ...launch,
    pid,
    processStart: identity.processStartIdentity,
  });
  expect(outcome.ok).toBe(true);
  return outcome.session;
}

const groupAlive = (pid) => observeProcessGroup(pid) === 'alive';
const record = (sessions) => sessions.get('session-1');

// A root with one long-lived child and no short-lived ones, so a stop never
// races a vanishing child. On TERM it starts \`onTerm\` (run by sh) and only
// then exits, 0.3 s later: a NEW process created after any pre-signal snapshot.
const termRootCode = (onTerm) =>
  [
    'import os, signal, subprocess, sys, time',
    "kid = subprocess.Popen(['sleep', '60'])",
    'def stop(*_):',
    `    subprocess.Popen(['/bin/sh', '-c', ${JSON.stringify(onTerm)}])`,
    '    time.sleep(0.3)',
    '    sys.exit(0)',
    'signal.signal(signal.SIGTERM, stop)',
    // Only a root that has installed its handler may be stopped by a test.
    "open(os.environ['SETU_READY'], 'w').close()",
    'while True:',
    '    kid.poll()',
    '    time.sleep(0.1)',
    '',
  ].join('\n');
// The new process stays in the root's group for \`seconds\`.
const delayedTermCode = (seconds) => termRootCode(`exec sleep ${seconds}`);

// A childless root that exits the moment it is told to stop. Stopping it races
// whatever the session does right after the signal, so it is repeated.
const fastTermCode = [
  'import os, signal, sys',
  'def stop(*_):',
  '    sys.exit(0)',
  'signal.signal(signal.SIGTERM, stop)',
  "open(os.environ['SETU_READY'], 'w').close()",
  'while True:',
  '    signal.pause()',
  '',
].join('\n');

function readyFile() {
  const root = mkdtempSync(join(tmpdir(), 'setu-exit-ready-'));
  roots.push(root);
  return join(root, 'ready');
}

async function pythonLeader(code) {
  const ready = readyFile();
  const child = spawn('python3', ['-c', code, marker], {
    detached: true,
    env: { ...process.env, SETU_READY: ready },
    stdio: 'ignore',
  });
  children.push(child);
  const exited = new Promise((resolve) => child.once('exit', resolve));
  await until(() => fs.existsSync(ready), 'root ready');
  return { child, exited, pid: child.pid };
}

test('a delayed TERM that starts a new in-group child is neither ended by the stale snapshot nor by the dead root', async () => {
  const f = setup();
  const root = await pythonLeader(delayedTermCode(2));
  const session = await register(f, root.pid);
  expect(session.executionGroup).toMatchObject({ escaped: [], id: root.pid });

  // What a pre-signal snapshot alone would have certified.
  const identity = await observeProcessIdentity(root.pid);
  const stale = await findProcessChildren(root.pid, {
    processStart: identity.processStartIdentity,
  });
  expect(stale.state).toBe('owned');

  const pending = await f.sessions.end('session-1', { checkoutIdentity });
  expect(pending).toMatchObject({ ok: true, pending: true });
  expect(record(f.sessions)).toMatchObject({
    ownership: 'owned',
    state: 'running',
  });
  expect(record(f.sessions).stopRequestedAt).toBeDefined();

  await root.exited;
  // Every snapshot child is gone and the root is gone; only the group knows.
  const staleStates = await Promise.all(
    stale.children.map((child) => observeProcessIdentity(child.pid))
  );
  expect(staleStates.every((observed) => observed.state === 'absent')).toBe(
    true
  );
  expect(groupAlive(root.pid)).toBe(true);
  await f.sessions.reconcile();
  expect(record(f.sessions)).toMatchObject({
    ownership: 'unknown',
    state: 'unknown',
  });
  expect(groupAlive(root.pid)).toBe(true);

  await until(() => !groupAlive(root.pid), 'new child exit');
  await f.sessions.reconcile();
  expect(record(f.sessions)).toMatchObject({
    endReason: 'ended-by-user',
    state: 'ended',
  });
  // The root was signalled last; the signal guard allows nothing outside its group.
  expect(f.signals.at(-1)).toEqual([root.pid, 'SIGTERM']);
}, 30_000);

test('a childless root that exits at once on TERM is ended every time, with no scan racing its exit', async () => {
  for (const trial of new Array(8).fill(0).keys()) {
    const f = setup();
    // biome-ignore lint/performance/noAwaitInLoops: Each trial is an independent root that must be reaped before the next starts.
    const root = await pythonLeader(fastTermCode);
    await register(f, root.pid);
    const outcome = await f.sessions.end('session-1', { checkoutIdentity });
    expect([trial, outcome.ok]).toEqual([trial, true]);
    await root.exited;
    await f.sessions.reconcile();
    expect([trial, record(f.sessions).state]).toEqual([trial, 'ended']);
    expect(record(f.sessions).endReason).toBe('ended-by-user');
    expect(groupAlive(root.pid)).toBe(false);
  }
}, 30_000);

test('a restarted service reaches the same verdicts from persisted evidence alone', async () => {
  const f = setup();
  const root = await pythonLeader(delayedTermCode(2));
  await register(f, root.pid);
  await f.sessions.end('session-1', { checkoutIdentity });
  await root.exited;

  const restarted = f.open();
  await restarted.reconcile();
  expect(record(restarted)).toMatchObject({
    ownership: 'unknown',
    state: 'unknown',
  });
  const unknownGeneration = record(restarted).bindingGeneration;
  await until(() => !groupAlive(root.pid), 'new child exit');
  const again = f.open();
  await again.reconcile();
  expect(record(again)).toMatchObject({
    endReason: 'ended-by-user',
    state: 'ended',
  });
  expect(record(again).bindingGeneration).toBe(unknownGeneration + 1);
}, 30_000);

test('a natural exit is ended only once the whole group has left', async () => {
  const f = setup();
  const root = leader('sleep 2 & sleep 0.4');
  await sleep(150);
  await register(f, root.pid);
  await root.exited;
  await f.sessions.reconcile();
  expect(record(f.sessions)).toMatchObject({ state: 'unknown' });
  await until(() => !groupAlive(root.pid), 'group exit');
  await f.sessions.reconcile();
  expect(record(f.sessions)).toMatchObject({
    endReason: 'exited',
    ownership: 'unknown',
    state: 'ended',
  });
}, 30_000);

test('a group that was already empty makes a natural exit immediately provable', async () => {
  const f = setup();
  const root = leader('sleep 0.6');
  await sleep(150);
  await register(f, root.pid);
  await root.exited;
  await f.sessions.reconcile();
  expect(record(f.sessions).state).toBe('ended');
}, 30_000);

test('an escapee seen outside the group while the root was live gates completion after the group is empty', async () => {
  const f = setup();
  const root = leader(`${escapee(3)} & sleep 1.5`);
  await sleep(500);
  const session = await register(f, root.pid);
  // Observed at proof: one descendant already outside the group.
  expect(session.executionGroup.escaped).toHaveLength(1);
  const [seen] = session.executionGroup.escaped;
  await root.exited;
  await until(() => !groupAlive(root.pid), 'root group empty');
  expect((await observeProcessIdentity(seen.pid)).state).toBe('alive');
  await f.sessions.reconcile();
  expect(record(f.sessions)).toMatchObject({ state: 'unknown' });
  await until(
    async () => (await observeProcessIdentity(seen.pid)).state === 'absent',
    'escapee exit',
    6000
  );
  await f.sessions.reconcile();
  expect(record(f.sessions).state).toBe('ended');
}, 30_000);

test('an escapee that first appears while the root is live is retained by a later scan', async () => {
  const f = setup();
  const root = leader(`sleep 0.8; ${escapee(4)} & sleep 2.2`);
  await sleep(300);
  const session = await register(f, root.pid);
  expect(session.executionGroup.escaped).toEqual([]);
  await until(
    async () => {
      await f.sessions.reconcile();
      return record(f.sessions).executionGroup.escaped.length === 1;
    },
    'scan retains the escapee',
    5000
  );
  const [seen] = record(f.sessions).executionGroup.escaped;
  await root.exited;
  await until(() => !groupAlive(root.pid), 'root group empty');
  await f.sessions.reconcile();
  expect(record(f.sessions).state).toBe('unknown');
  expect((await observeProcessIdentity(seen.pid)).state).toBe('alive');
  await until(
    async () => (await observeProcessIdentity(seen.pid)).state === 'absent',
    'escapee exit',
    6000
  );
  await f.sessions.reconcile();
  expect(record(f.sessions).state).toBe('ended');
}, 30_000);

test('the cooperative limit: an escapee never observed is outside the guarantee', async () => {
  // Documents the boundary, it does not endorse it. The root starts a
  // descendant outside its group after the last observation and exits; the
  // group is empty, so completion is proved for the managed group only.
  const f = setup();
  const root = await pythonLeader(termRootCode(escapee(2)));
  await register(f, root.pid);
  await f.sessions.end('session-1', { checkoutIdentity });
  await root.exited;
  await until(() => markedProcesses().length > 0, 'unobserved escapee');
  await f.sessions.reconcile();
  expect(record(f.sessions).state).toBe('ended');
  expect(markedProcesses().length).toBeGreaterThan(0);
}, 30_000);

test('a root that does not lead its own group has no proof, so no exit ever ends it', async () => {
  const f = setup();
  const child = spawn('/bin/sh', ['-c', `sleep 0.6 # ${marker}`], {
    stdio: 'ignore',
  });
  const exited = new Promise((resolve) => child.once('exit', resolve));
  children.push(child);
  await sleep(150);
  const session = await register(f, child.pid);
  expect(session.executionGroup).toBeUndefined();
  await exited;
  await f.sessions.reconcile();
  expect(record(f.sessions)).toMatchObject({
    ownership: 'unknown',
    state: 'unknown',
  });
  for (const _tick of new Array(2).fill(0)) {
    // biome-ignore lint/performance/noAwaitInLoops: Each reconcile is a separate monitor tick.
    await f.sessions.reconcile();
    expect(record(f.sessions).state).toBe('unknown');
  }
}, 30_000);

// The generated launcher under a pty: the registered agent heads its own group.
function ptyRunner(root) {
  const path = join(root, 'pty-runner.py');
  fs.writeFileSync(
    path,
    [
      'import os, pty, select, sys, time',
      'pid, terminal = pty.fork()',
      'if pid == 0:',
      '    os.execvpe(sys.argv[1], [sys.argv[1]], os.environ)',
      'deadline = time.monotonic() + 40',
      'while time.monotonic() < deadline and not os.path.exists(sys.argv[2]):',
      '    ready, _, _ = select.select([terminal], [], [], 0.1)',
      '    if ready:',
      '        try:',
      '            os.read(terminal, 4096)',
      '        except OSError:',
      '            break',
      'try:',
      '    os.killpg(pid, 9)',
      'except OSError:',
      '    pass',
      'os.waitpid(pid, 0)',
      '',
    ].join('\n')
  );
  return path;
}

function launcherFixture(root, agentCode) {
  const home = join(root, 'home');
  const checkoutPath = join(root, 'checkout');
  fs.mkdirSync(home);
  fs.mkdirSync(checkoutPath);
  fs.writeFileSync(join(home, '.zshrc'), '');
  const agentPath = join(root, 'agent');
  fs.writeFileSync(agentPath, `#!/usr/bin/env python3\n${agentCode}`, {
    mode: 0o755,
  });
  const launcherPath = join(root, 'launch.zsh');
  const registrationPath = join(root, 'registration.json');
  const built = buildAgentSessionLaunch({
    checkoutPath,
    command: agentPath,
    launcherPath,
    registrationPath,
    sessionId: 'session-1',
  });
  fs.writeFileSync(launcherPath, built.script, { mode: 0o700 });
  return { home, launcherPath, registrationPath };
}

const readRegistration = (path) =>
  fs.existsSync(path)
    ? parseSessionRegistration(fs.readFileSync(path, 'utf8'), 'session-1')
    : null;

test('under a pty the launcher-registered agent leads a provable group, and a delayed TERM that starts a child keeps it unknown until the group empties', async () => {
  const f = setup();
  const root = mkdtempSync(join(tmpdir(), 'setu-exit-pty-'));
  roots.push(root);
  const fixtureFiles = launcherFixture(root, delayedTermCode(2));
  const stopPath = join(root, 'stop');
  const ready = readyFile();
  const runner = spawn(
    'python3',
    ['-I', ptyRunner(root), fixtureFiles.launcherPath, stopPath],
    {
      env: { ...process.env, HOME: fixtureFiles.home, SETU_READY: ready },
      stdio: 'ignore',
    }
  );
  try {
    const registration = await until(
      () => readRegistration(fixtureFiles.registrationPath),
      'launcher registration'
    );
    await until(() => fs.existsSync(ready), 'agent ready');
    const session = await register(f, registration.pid);
    expect(session.executionGroup).toMatchObject({
      escaped: [],
      id: registration.pid,
    });
    expect(session.processStart).toBe(registration.processStart);

    const pending = await f.sessions.end('session-1', { checkoutIdentity });
    expect(pending).toMatchObject({ ok: true, pending: true });
    await until(
      async () =>
        (await observeProcessIdentity(registration.pid)).state === 'absent',
      'agent exit'
    );
    expect(groupAlive(registration.pid)).toBe(true);
    await f.sessions.reconcile();
    expect(record(f.sessions)).toMatchObject({
      ownership: 'unknown',
      state: 'unknown',
    });
    await until(() => !groupAlive(registration.pid), 'new child exit');
    await f.sessions.reconcile();
    expect(record(f.sessions)).toMatchObject({
      endReason: 'ended-by-user',
      state: 'ended',
    });
  } finally {
    fs.writeFileSync(stopPath, '');
    await new Promise((resolve) => runner.once('exit', resolve));
  }
}, 30_000);

test('without a tty the same launcher gives no group proof, so the old non-tty harness stays unknown', async () => {
  const f = setup();
  const root = mkdtempSync(join(tmpdir(), 'setu-exit-notty-'));
  roots.push(root);
  const fixtureFiles = launcherFixture(root, delayedTermCode(1));
  const ready = readyFile();
  const shell = spawn('/bin/zsh', ['-i', fixtureFiles.launcherPath], {
    detached: true,
    env: { ...process.env, HOME: fixtureFiles.home, SETU_READY: ready },
    stdio: ['pipe', 'ignore', 'ignore'],
  });
  children.push(shell);
  // Without job control the agent shares the launcher shell's group, which is ours.
  registeredLeaders.add(shell.pid);
  const registration = await until(
    () => readRegistration(fixtureFiles.registrationPath),
    'launcher registration'
  );
  await until(() => fs.existsSync(ready), 'agent ready');
  const session = await register(f, registration.pid);
  expect(session.executionGroup).toBeUndefined();
  await f.sessions.end('session-1', { checkoutIdentity });
  await until(
    async () =>
      (await observeProcessIdentity(registration.pid)).state === 'absent',
    'agent exit'
  );
  await sleep(1500);
  await f.sessions.reconcile();
  expect(record(f.sessions)).toMatchObject({
    ownership: 'unknown',
    state: 'unknown',
  });
}, 30_000);
