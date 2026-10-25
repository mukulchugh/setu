import { afterEach, expect, test } from 'bun:test';
import { spawn } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { observeProcessIdentity } from './process-observation.js';
import { createSpansActions } from './spans-actions.js';
import { stopOwnedFixtureCapture } from './spans-execution.test-support.js';
import { openSpansStore } from './spans-store.js';
import { createSpansWorkerHost } from './spans-worker-host.js';
import { createSpansWorkerReconnect } from './spans-worker-reconnect.js';
import { createSpansWorkerSpool } from './spans-worker-spool.js';

const OWN_TEST_DIR = dirname(fileURLToPath(import.meta.url));
const CAPTURE_NAME = /^swp-[a-f0-9]{48}$/;
const MAX_CAPTURE_DIRECTORIES = 4096;
const FIXTURE_START_ID = 'Mon Jan 1 00:00:00 2024';
const roots = [];
const tempRoots = [];
const capturePids = new Map();
const providerPids = new Set();
const adapters = new Set();
const binding = Object.freeze({
  actionId: 'action-reconnect',
  attemptId: 'attempt-reconnect',
  generation: 0,
  runId: 'run-reconnect',
  spanId: 'span-reconnect',
  workerId: 'worker-reconnect',
});
const limits = Object.freeze({
  maxActiveAttempts: 2,
  maxAttemptBytes: 4096,
  maxAttemptChunks: 20,
  maxChunkBytes: 1024,
  maxDeadlineMs: 30_000,
  maxQueueBytes: 2048,
});
const initialView = {
  actions: {},
  checkpoint: 0,
  generation: 0,
  planVersion: 1,
  runId: binding.runId,
  spans: {
    [binding.spanId]: {
      dependencies: [],
      spanId: binding.spanId,
      state: 'ready',
    },
  },
};

afterEach(async () => {
  for (const pid of providerPids) {
    try {
      process.kill(pid, 'SIGUSR2');
    } catch {
      // The fixture process may already have exited.
    }
  }
  await Promise.all(
    [...capturePids].map(([pid, processStartIdentity]) =>
      stopOwnedFixtureCapture({ pid, processStartIdentity })
    )
  );
  const deadline = Date.now() + 1500;
  while (providerPids.size && Date.now() < deadline) {
    for (const pid of providerPids) {
      try {
        process.kill(pid, 0);
      } catch (error) {
        if (error.code === 'ESRCH') {
          providerPids.delete(pid);
        }
      }
    }
    if (providerPids.size) {
      // biome-ignore lint/performance/noAwaitInLoops: Do not remove fixture files while an owned provider is still exiting.
      await new Promise((resolveWait) => setTimeout(resolveWait, 25));
    }
  }
  if (providerPids.size > 0) {
    throw new Error('Owned fixture providers have not exited; files retained.');
  }
  providerPids.clear();
  capturePids.clear();
  await Promise.all([...adapters].map((adapter) => adapter.close()));
  adapters.clear();
  for (const root of [...roots.splice(0), ...tempRoots.splice(0)]) {
    rmSync(root, { force: true, recursive: true });
  }
});

function makePrivateRoot(prefix) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  chmodSync(root, 0o700);
  return root;
}

async function waitFor(check, label) {
  const end = Date.now() + 6000;
  while (Date.now() < end) {
    // biome-ignore lint/performance/noAwaitInLoops: Fixture readiness is checked serially until its bounded deadline.
    const result = await check();
    if (result) {
      return result;
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 20));
  }
  throw new Error(`timed out waiting for ${label}`);
}

function readCurrent(root) {
  const store = openSpansStore({ readonly: true, root });
  try {
    return store.readRun({ runId: binding.runId });
  } finally {
    store.close();
  }
}

function observeFixtureProcess(pid) {
  try {
    process.kill(pid, 0);
    return Promise.resolve({
      processId: pid,
      processStartIdentity: FIXTURE_START_ID,
      state: 'alive',
    });
  } catch (error) {
    return Promise.resolve({
      state: error.code === 'ESRCH' ? 'absent' : 'unknown',
    });
  }
}

async function makeFixture({ observeProcess = observeFixtureProcess } = {}) {
  const root = makePrivateRoot('setu-spans-reconnect-');
  const tempRoot = makePrivateRoot('setu-spans-capture-');
  roots.push(root);
  tempRoots.push(tempRoot);
  const marker = join(root, 'fixture');
  const psPath = join(root, 'ps');
  const psStatePath = join(root, 'ps-state');
  writeFileSync(`${psStatePath}.marker`, marker, { mode: 0o600 });
  writeFileSync(
    psPath,
    `#!/usr/bin/env node
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
const args = process.argv.slice(2);
const statePath = process.env.SETU_FAKE_PS_STATE;
const start = '${FIXTURE_START_ID}';
if (args[0] === '-p') {
  writeFileSync(statePath, args[1]);
  if (existsSync(readFileSync(statePath + '.marker', 'utf8') + '.exited')) process.exit(1);
  process.stdout.write(start + '\\n');
} else if (args[0] === '-axo') {
  const target = readFileSync(statePath + '.marker', 'utf8');
  const pid = Number(readFileSync(statePath, 'utf8'));
  try {
    process.kill(pid, 0);
  } catch (error) {
    if (error.code !== 'ESRCH') process.exit(1);
  }
  if (pid > 0 && !existsSync(target + '.exited')) {
    process.stdout.write(pid + ' 1 ' + pid + ' ' + start + '\\n');
  }
} else {
  process.exit(1);
}
`,
    { mode: 0o700 }
  );
  chmodSync(psPath, 0o700);
  let captureLaunches = 0;
  const spawnWithFixturePs = (command, args, options) => {
    if (
      command === process.execPath &&
      args[0] === join(OWN_TEST_DIR, 'spans-worker-child.js')
    ) {
      captureLaunches += 1;
    }
    return spawn(command, args, {
      ...options,
      env: {
        ...options.env,
        PATH: `${root}:${options.env.PATH ?? ''}`,
        SETU_FAKE_PS_STATE: psStatePath,
      },
    });
  };

  const store = openSpansStore({ root });
  expect(
    store.commitRun({
      events: [],
      expectedGeneration: 0,
      expectedRevision: 0,
      runId: binding.runId,
      view: initialView,
    })
  ).toMatchObject({ ok: true });
  const actions = createSpansActions({ now: () => Date.now(), store });
  expect(
    await actions.prepareAction({
      actionId: binding.actionId,
      attemptId: binding.attemptId,
      generation: binding.generation,
      inputDigest: 'a'.repeat(64),
      planVersion: 1,
      runId: binding.runId,
      spanId: binding.spanId,
      targetDigest: 'b'.repeat(64),
    })
  ).toMatchObject({ ok: true, status: 'intent' });
  store.close();

  const adapter = createSpansWorkerReconnect({
    authorize: ({ binding: candidate }) => {
      const current = JSON.stringify(candidate) === JSON.stringify(binding);
      return { currentAttempt: current, ok: current };
    },
    childPath: join(OWN_TEST_DIR, 'spans-worker-child.js'),
    observeProcess,
    root,
    spawn: spawnWithFixturePs,
    tempRoot,
    transportTimeoutMs: 3000,
  });
  adapters.add(adapter);
  const started = await adapter.start({
    binding,
    limits,
    source: {
      args: [join(OWN_TEST_DIR, 'spans-worker-process.fixture.js'), marker],
      command: process.execPath,
      cwd: resolve(OWN_TEST_DIR),
      env: {},
      stdin: 'Reconnect fixture input.\n',
    },
    start: { ...binding, deadlineMs: 20_000 },
  });
  if (started.captureProcess?.pid) {
    const observed = await observeProcessIdentity(started.captureProcess.pid);
    if (observed.state === 'alive') {
      capturePids.set(observed.processId, observed.processStartIdentity);
    } else if (observed.state !== 'absent') {
      throw new Error('Fixture capture ownership could not be recorded.');
    }
  }
  expect(started).toMatchObject({ ok: true });
  expect(started).not.toHaveProperty('descriptorPath');
  await waitFor(() => existsSync(`${marker}.ready`), 'fixture provider launch');
  const attempt = readCurrent(root).view.attempts[binding.attemptId];
  if (attempt?.processStart?.pid) {
    providerPids.add(attempt.processStart.pid);
  }
  const spool = createSpansWorkerSpool({ root });
  await waitFor(() => {
    const stat = spool.stat({ attemptDigest: attempt.attemptDigest });
    return stat.ok && stat.chunks > 0;
  }, 'first durable capture chunk');
  return {
    adapter,
    captureLaunches: () => captureLaunches,
    marker,
    root,
    started,
    tempRoot,
  };
}

function reconnectRequest() {
  return {
    attemptId: binding.attemptId,
    generation: binding.generation,
    runId: binding.runId,
  };
}

test('reconnect locates one retained descriptor, validates the exact process, and never relaunches', async () => {
  const fixture = await makeFixture();
  const archive = readCurrent(fixture.root);
  const attempt = archive.view.attempts[binding.attemptId];
  const directories = readdirSync(fixture.tempRoot).filter((name) =>
    name.startsWith('swp-')
  );
  expect(directories).toHaveLength(1);
  expect(directories[0]).toMatch(CAPTURE_NAME);
  expect(
    existsSync(
      join(fixture.root, 'worker-spool', attempt.attemptDigest, 'capture.json')
    )
  ).toBe(false);

  const reconnected = await fixture.adapter.reconnect(reconnectRequest());
  expect(reconnected).toMatchObject({
    binding,
    observation: {
      provider: { processStart: attempt.processStart, state: 'running' },
    },
    ok: true,
    spool: { chunks: 1, ok: true },
  });
  expect(reconnected).not.toHaveProperty('descriptorPath');
  expect(
    await fixture.adapter.start({
      binding,
      limits,
      source: {
        args: [
          join(OWN_TEST_DIR, 'spans-worker-process.fixture.js'),
          fixture.marker,
        ],
        command: process.execPath,
        cwd: resolve(OWN_TEST_DIR),
        env: {},
        stdin: 'Reconnect fixture input.\n',
      },
      start: { ...binding, deadlineMs: 20_000 },
    })
  ).toMatchObject({ code: 'ATTEMPT_ALREADY_STARTED', ok: false });
  expect(fixture.captureLaunches()).toBe(1);
  expect(readFileSync(`${fixture.marker}.pid`, 'utf8')).toBe(
    String(attempt.processStart.pid)
  );
  expect(
    readCurrent(fixture.root).view.attempts[binding.attemptId].status
  ).toBe('running');
});

test('unknown, absent, and changed process identities refuse without closing the attempt', async () => {
  let providerPid;
  let observation = 'unknown';
  const fixture = await makeFixture({
    observeProcess: (pid) => {
      if (pid === providerPid) {
        if (observation === 'unknown') {
          return { state: 'unknown' };
        }
        if (observation === 'absent') {
          return { state: 'absent' };
        }
        if (observation === 'changed') {
          return {
            processId: pid,
            processStartIdentity: 'different-start',
            state: 'alive',
          };
        }
      }
      return observeFixtureProcess(pid);
    },
  });
  const attempt = readCurrent(fixture.root).view.attempts[binding.attemptId];
  providerPid = attempt.processStart.pid;
  expect(await fixture.adapter.reconnect(reconnectRequest())).toMatchObject({
    code: 'RECONNECT_WORKER_UNKNOWN',
    ok: false,
    unknown: true,
  });
  observation = 'absent';
  expect(await fixture.adapter.reconnect(reconnectRequest())).toMatchObject({
    code: 'RECONNECT_WORKER_ABSENT',
    ok: false,
    unknown: true,
  });
  expect(
    readCurrent(fixture.root).view.attempts[binding.attemptId].status
  ).toBe('running');
  observation = 'changed';
  expect(await fixture.adapter.reconnect(reconnectRequest())).toMatchObject({
    code: 'RECONNECT_PROCESS_IDENTITY_MISMATCH',
    ok: false,
    unknown: true,
  });
  expect(
    readCurrent(fixture.root).view.attempts[binding.attemptId].status
  ).toBe('running');
});

test('malformed proxy and accessor reconnect requests fail closed without throwing', async () => {
  const fixture = await makeFixture();
  const accessorInput = Object.defineProperty({}, 'runId', {
    get() {
      throw new Error('malformed accessor');
    },
  });
  expect(await fixture.adapter.reconnect(accessorInput)).toMatchObject({
    code: 'RECONNECT_INPUT_INVALID',
    ok: false,
  });
  const revokedInput = Proxy.revocable({}, {});
  revokedInput.revoke();
  expect(await fixture.adapter.reconnect(revokedInput.proxy)).toMatchObject({
    code: 'RECONNECT_INPUT_INVALID',
    ok: false,
  });
});

test('reconnect rejects returning getters and supplied descriptor paths without invoking them', async () => {
  const fixture = await makeFixture();
  let reads = 0;
  const input = Object.defineProperty(reconnectRequest(), 'runId', {
    enumerable: true,
    get() {
      reads += 1;
      return binding.runId;
    },
  });
  expect(await fixture.adapter.reconnect(input)).toMatchObject({
    code: 'RECONNECT_INPUT_INVALID',
    ok: false,
  });
  expect(reads).toBe(0);
  expect(
    await fixture.adapter.reconnect({
      ...reconnectRequest(),
      descriptorPath: '/untrusted/capture.json',
    })
  ).toMatchObject({ code: 'RECONNECT_INPUT_INVALID', ok: false });
});

test('oversized descriptor reads fail closed', async () => {
  const fixture = await makeFixture();
  const captureDirectory = readdirSync(fixture.tempRoot).find((name) =>
    CAPTURE_NAME.test(name)
  );
  expect(captureDirectory).toBeString();
  writeFileSync(
    join(fixture.tempRoot, captureDirectory, 'capture.json'),
    Buffer.alloc(128 * 1024 + 1)
  );
  expect(await fixture.adapter.reconnect(reconnectRequest())).toMatchObject({
    code: 'CAPTURE_DESCRIPTOR_UNKNOWN',
    ok: false,
    unknown: true,
  });
  expect(
    readCurrent(fixture.root).view.attempts[binding.attemptId].status
  ).toBe('running');
});

test('new captures reconnect without scanning thousands of unrelated retained entries', async () => {
  const fixture = await makeFixture();
  for (let index = 0; index < MAX_CAPTURE_DIRECTORIES; index += 1) {
    mkdirSync(join(fixture.tempRoot, `ignored-${index}`));
  }
  expect(await fixture.adapter.reconnect(reconnectRequest())).toMatchObject({
    binding,
    ok: true,
  });
  expect(
    readCurrent(fixture.root).view.attempts[binding.attemptId].status
  ).toBe('running');
});

test('held attempts refuse reconnect and retain their archive receipt', async () => {
  const fixture = await makeFixture();
  const host = createSpansWorkerHost({
    clock: { now: () => Date.now() },
    launcher: {
      launch() {
        throw new Error('recovery must not launch');
      },
    },
    limits,
    observeProcess: async () => ({ state: 'absent' }),
    preflight: async () => ({ ok: true }),
    root: fixture.root,
    workerId: 'worker-recovery-fixture',
  });
  const held = await host.recover(reconnectRequest());
  expect(held).toMatchObject({ held: true, ok: true, status: 'held' });
  const refused = await fixture.adapter.reconnect(reconnectRequest());
  expect(refused).toMatchObject({
    code: 'RECONNECT_ATTEMPT_NOT_RUNNING',
    ok: false,
    unknown: true,
  });
  expect(
    readCurrent(fixture.root).view.attempts[binding.attemptId]
  ).toMatchObject({
    receipt: { ownershipReleased: false, status: 'held' },
    status: 'held',
  });
  expect(await host.close()).toEqual({ ok: true });
});
