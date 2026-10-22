import { afterEach } from 'bun:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import {
  closeSync,
  mkdtempSync,
  openSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { readNativeProcessSnapshot } from './owned-process-group.js';
import { createSetupInstallProcesses } from './setup-install-process.js';

const START = 'Mon Oct 20 09:00:00 2026';
const nativeProcessTableAvailable = (() => {
  try {
    readNativeProcessSnapshot();
    return true;
  } catch {
    return false;
  }
})();

function harness({
  initial = 'owned',
  state = 'alive',
  termState = 'absent',
  killState = 'absent',
  waitForSettlement,
  deadlineMs = 15 * 60 * 1000,
} = {}) {
  const calls = {
    argv: null,
    childOptions: null,
    gate: [],
    signals: [],
    timers: [],
  };
  const child = new EventEmitter();
  child.pid = 43_123;
  child.stdin = {
    end(value) {
      calls.gate.push(value ?? null);
    },
  };
  let groupState = state;
  let time = 0;
  const processOwner = createSetupInstallProcesses({
    clearTimer(timer) {
      timer.cleared = true;
    },
    createProcessGroup() {
      return {
        observe() {
          return initial === 'owned'
            ? { state: 'owned' }
            : { state: 'unknown' };
        },
        settled() {
          return { state: groupState };
        },
        signalOwned(value) {
          calls.signals.push(value);
          if (value === 'SIGTERM') {
            groupState = termState;
          } else if (value === 'SIGKILL') {
            groupState = killState;
          }
          return groupState === 'unknown'
            ? { ok: false, unknown: true }
            : { ok: true };
        },
      };
    },
    now: () => time,
    pollMs: 1,
    readSnapshot: () =>
      initial === 'owned'
        ? [
            {
              groupId: child.pid,
              parentPid: 1,
              pid: child.pid,
              processStartIdentity: START,
            },
          ]
        : [],
    setTimer(callback, ms) {
      const timer = {
        callback,
        ms,
        unref() {
          // Fake timers have no event loop handle.
        },
      };
      calls.timers.push(timer);
      return timer;
    },
    settleMs: 5,
    signal() {
      // The fake group owns signal assertions in these tests.
    },
    sleep: async () => {
      time += 1;
      if (waitForSettlement) {
        await waitForSettlement();
      } else if (groupState === 'alive' && termState !== 'alive') {
        groupState = termState;
      }
    },
    spawnChild(command, args, options) {
      calls.argv = [command, ...args];
      calls.childOptions = options;
      return child;
    },
    termGraceMs: 5,
  });
  const proc = processOwner.spawn(
    ['bun', 'install', 'space " quote $ literal'],
    {
      cwd: '/tmp/setup cwd',
      env: { INSTALL_SENTINEL: 'private' },
      stderr: 18,
      stdout: 17,
      timeout: deadlineMs,
    }
  );
  return {
    calls,
    child,
    proc,
    processOwner,
    setGroupState(value) {
      groupState = value;
    },
  };
}

test('launcher holds the exact argv behind the ownership gate and preserves setup options', async () => {
  const h = harness();
  assert.deepEqual(h.calls.gate, ['setu-setup-owner-v1\n']);
  assert.deepEqual(h.calls.argv, [
    '/bin/zsh',
    '-f',
    '-c',
    'IFS= read -r gate || exit 125; [ "$gate" = "setu-setup-owner-v1" ] || exit 125; exec "$@"',
    'setu-setup',
    'bun',
    'install',
    'space " quote $ literal',
  ]);
  assert.equal(h.calls.childOptions.cwd, '/tmp/setup cwd');
  assert.equal(h.calls.childOptions.detached, true);
  assert.deepEqual(h.calls.childOptions.env, { INSTALL_SENTINEL: 'private' });
  assert.equal(h.calls.childOptions.stdio[1], 17);
  assert.equal(h.calls.childOptions.stdio[2], 18);
  assert.equal(h.calls.childOptions.stdio[0], 'pipe');
  assert.ok(h.proc.setupOwnerId);
  assert.equal(h.proc.pid, 43_123);
  assert.equal(h.proc.ownershipState, 'active');
  h.child.emit('close', 0, null);
  assert.equal(await h.proc.exited, 0);
  await h.processOwner.stopProcess({
    ownedGroup: true,
    pid: h.proc.pid,
    setupOwnerId: h.proc.setupOwnerId,
  });
  await h.processOwner.stopProcess({
    ownedGroup: true,
    pid: h.proc.pid,
    setupOwnerId: h.proc.setupOwnerId,
  });
  assert.deepEqual(h.calls.signals, ['SIGTERM']);
  assert.equal(h.proc.ownershipState, 'ended');
  h.processOwner.close();
});

test('unproven launch closes the gate and refuses stop without signaling', async () => {
  const h = harness({ initial: 'missing' });
  assert.deepEqual(h.calls.gate, [null]);
  assert.equal(h.proc.ownershipState, 'unverified');
  h.child.emit('close', 125, null);
  await assert.rejects(
    h.processOwner.stopProcess({
      ownedGroup: true,
      pid: h.proc.pid,
      setupOwnerId: h.proc.setupOwnerId,
    }),
    { code: 'OPERATION_UNKNOWN' }
  );
  assert.deepEqual(h.calls.signals, []);
  assert.throws(() => h.processOwner.close(), { code: 'OPERATION_UNKNOWN' });
});

test('missing, stale, or mismatched owner nonce never signals a PID', async () => {
  const h = harness();
  const requests = [
    { ownedGroup: true, pid: h.proc.pid },
    { ownedGroup: true, pid: h.proc.pid, setupOwnerId: 'stale-owner' },
    {
      ownedGroup: true,
      pid: h.proc.pid + 1,
      setupOwnerId: h.proc.setupOwnerId,
    },
  ];
  const results = await Promise.allSettled(
    requests.map((request) => h.processOwner.stopProcess(request))
  );
  assert.ok(
    results.every(
      (result) =>
        result.status === 'rejected' &&
        result.reason.code === 'OPERATION_UNKNOWN'
    )
  );
  assert.deepEqual(h.calls.signals, []);
});

test('unknown PID reuse or foreign group proof holds ownership without a signal', async () => {
  const h = harness();
  // The generic group monitor converts any identity or ancestry mismatch to
  // unknown; the injected group models that conservative result.
  h.setGroupState('unknown');
  await assert.rejects(
    h.processOwner.stopProcess({
      ownedGroup: true,
      pid: h.proc.pid,
      setupOwnerId: h.proc.setupOwnerId,
    }),
    { code: 'OPERATION_UNKNOWN' }
  );
  assert.deepEqual(h.calls.signals, []);
  assert.throws(() => h.processOwner.close(), { code: 'OPERATION_UNKNOWN' });
});

test('leader exit does not settle until the owned descendant group is absent', async () => {
  let releaseSleep;
  const sleepGate = new Promise((resolve) => {
    releaseSleep = resolve;
  });
  const h = harness({
    state: 'alive',
    termState: 'alive',
    waitForSettlement: async () => sleepGate,
  });
  h.child.emit('close', 0, null);
  assert.equal(await h.proc.exited, 0);
  let stopped = false;
  const stopping = h.processOwner
    .stopProcess({
      ownedGroup: true,
      pid: h.proc.pid,
      setupOwnerId: h.proc.setupOwnerId,
    })
    .then(() => {
      stopped = true;
    });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(stopped, false);
  h.setGroupState('absent');
  releaseSleep();
  await stopping;
  assert.deepEqual(h.calls.signals, ['SIGTERM']);
  h.processOwner.close();
});

test('nonzero and signal outcomes remain failures after group settlement', async () => {
  const nonzero = harness();
  nonzero.child.emit('close', 7, null);
  assert.equal(await nonzero.proc.exited, 7);
  await nonzero.processOwner.stopProcess({
    ownedGroup: true,
    pid: nonzero.proc.pid,
    setupOwnerId: nonzero.proc.setupOwnerId,
  });
  nonzero.processOwner.close();

  const signaled = harness();
  signaled.child.emit('close', null, 'SIGTERM');
  assert.equal(await signaled.proc.exited, null);
  assert.equal(signaled.proc.signalCode, 'SIGTERM');
  await signaled.processOwner.stopProcess({
    ownedGroup: true,
    pid: signaled.proc.pid,
    setupOwnerId: signaled.proc.setupOwnerId,
  });
  signaled.processOwner.close();
});

test('deadline invokes only the nonce-bound owned stop path', async () => {
  const h = harness();
  const deadline = h.calls.timers.find((timer) => timer.ms === 15 * 60 * 1000);
  assert.ok(deadline);
  deadline.callback();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(h.calls.signals, ['SIGTERM']);
  assert.equal(h.calls.gate.length, 1);
  h.processOwner.close();
});

test('KILL follows TERM grace only after another owned group proof', async () => {
  const h = harness({ killState: 'absent', termState: 'alive' });
  await h.processOwner.stopProcess({
    ownedGroup: true,
    pid: h.proc.pid,
    setupOwnerId: h.proc.setupOwnerId,
  });
  assert.deepEqual(h.calls.signals, ['SIGTERM', 'SIGKILL']);
  h.processOwner.close();
});

test('close refuses active setup ownership', () => {
  const h = harness();
  assert.throws(() => h.processOwner.close(), { code: 'OPERATION_UNKNOWN' });
});

test('real group manager with an explicit process-table OS seam proves launch and settlement', async () => {
  const child = new EventEmitter();
  child.pid = 43_124;
  const gateWrites = [];
  child.stdin = {
    end(value) {
      gateWrites.push(value ?? null);
    },
    on() {
      // The deterministic child does not emit stream errors.
    },
  };
  let rows = [
    {
      groupId: child.pid,
      parentPid: 1,
      pid: child.pid,
      processStartIdentity: START,
    },
  ];
  const processOwner = createSetupInstallProcesses({
    clearTimer() {
      // Fake monitor handles have no event loop resource.
    },
    readSnapshot: () => rows,
    setTimer: (callback, ms) => ({
      callback,
      ms,
      unref() {
        // Fake monitor handles have no event loop resource.
      },
    }),
    signal: () => {
      throw new Error('the already-settled fixture must not be signaled');
    },
    spawnChild: () => child,
  });
  const proc = processOwner.spawn(['fixture-command', 'literal $ argument'], {
    cwd: '/tmp/setup-owner-os-seam',
  });
  assert.deepEqual(gateWrites, ['setu-setup-owner-v1\n']);
  assert.equal(proc.ownershipState, 'active');
  child.emit('close', 0, null);
  assert.equal(await proc.exited, 0);

  rows = [];
  assert.deepEqual(
    await processOwner.stopProcess({
      ownedGroup: true,
      pid: proc.pid,
      setupOwnerId: proc.setupOwnerId,
    }),
    { ok: true, state: 'absent' }
  );
  processOwner.close();
});

const nativeFixtures = [];
afterEach(async () => {
  for (const fixture of nativeFixtures.splice(0)) {
    // biome-ignore lint/performance/noAwaitInLoops: Each owned fixture must settle before its files are removed.
    await fixture.owner.stopProcess({
      ownedGroup: true,
      pid: fixture.proc.pid,
      setupOwnerId: fixture.proc.setupOwnerId,
    });
    fixture.owner.close();
    rmSync(fixture.root, { force: true, recursive: true });
  }
});

if (nativeProcessTableAvailable) {
  test('native setup gate preserves exact argv and log descriptors through complete owned exit', async () => {
    const root = realpathSync(
      mkdtempSync(join(tmpdir(), 'setu-setup-owner-native-'))
    );
    const script = join(root, 'fixture.js');
    const log = join(root, 'setup.log');
    writeFileSync(
      script,
      'process.stdout.write(JSON.stringify(process.argv.slice(2)));process.stderr.write("\\nfixture-stderr");setTimeout(() => {}, 150);'
    );
    const fd = openSync(log, 'a', 0o600);
    const owner = createSetupInstallProcesses();
    const argument = 'space and "quotes" $HOME $(never-run)';
    let proc;
    try {
      proc = owner.spawn([process.execPath, script, argument], {
        cwd: root,
        stderr: fd,
        stdout: fd,
        timeout: 3000,
      });
      nativeFixtures.push({ owner, proc, root });
    } finally {
      closeSync(fd);
    }
    assert.equal(await proc.exited, 0);
    const deadline = Date.now() + 1000;
    while (proc.ownershipState === 'active' && Date.now() < deadline) {
      // biome-ignore lint/performance/noAwaitInLoops: Poll the actual owner transition within the bounded deadline.
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(proc.ownershipState, 'ended');
    await owner.stopProcess({
      ownedGroup: true,
      pid: proc.pid,
      setupOwnerId: proc.setupOwnerId,
    });
    const output = readFileSync(log, 'utf8');
    assert.equal(output, `${JSON.stringify([argument])}\nfixture-stderr`);
  });
} else {
  test.skip('native setup process settlement requires ps, denied by this OS sandbox', () => {
    // The capability probe refused before the process launcher was exercised.
  });
}
