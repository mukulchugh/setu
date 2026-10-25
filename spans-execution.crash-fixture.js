#!/usr/bin/env bun
// Runs a Spans execution service in its own process and freezes it at one
// named boundary, so a test can kill the whole process and restart. It is test
// infrastructure; the capture controller is real and the provider is the
// local process fixture.
//
//   bun spans-execution.crash-fixture.js '<json {root, boundary, input}>'

import { spawn as spawnProcess } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  attachExecutionFixture,
  PROVIDER_FIXTURE,
} from './spans-execution.test-support.js';
import { createSpansWorkerProcess } from './spans-worker-process.js';

const { boundary, input, providerDelayMs, root } = JSON.parse(process.argv[2]);
const fixture = attachExecutionFixture(root);

// These events are committed by the parent. The detached capture process has
// its own store connection, so its writes must be observed at the real process
// seam or through the parent's later captured event.
const BOUNDARY_EVENTS = {
  captured: 'spans.execution.captured',
  intent: 'spans.action.intent',
  outcome: 'spans.action.outcome',
  reservation: 'spans.usage.reserve',
};

function freeze() {
  // The marker is the synchronization signal. Once present, only the test's
  // Bun.spawn-owned handle is allowed to signal this supervised parent.
  writeFileSync(join(root, 'boundary'), boundary);
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10 * 60 * 1000);
}

const hitsBoundary = (events = []) =>
  events.some((event) => event.type === BOUNDARY_EVENTS[boundary]);

const afterWrite = (result, events) => {
  if (result.ok && hitsBoundary(events)) {
    freeze();
  }
  return result;
};

const store = {
  ...fixture.store,
  appendEvent(event) {
    const result = fixture.store.appendEvent(event);
    return afterWrite(result, [event]);
  },
  commitRun(request) {
    const result = fixture.store.commitRun(request);
    return afterWrite(result, request.events);
  },
};

// Decorate the production native capture factory. Its Node-signature spawn
// option still launches the real detached controller; the launch barrier is
// immediately after that exact spawn succeeds, before start can acknowledge
// its identity to the parent coordinator.
function createCaptureProcess(options) {
  const native = createSpansWorkerProcess({
    ...options,
    spawn(...args) {
      const child = spawnProcess(...args);
      if (boundary === 'launch') {
        child.once('spawn', freeze);
      }
      return child;
    },
  });
  if (boundary !== 'start') {
    return native;
  }
  return {
    ...native,
    async start(request) {
      const result = await native.start(request);
      if (result?.ok === true) {
        // The controller has written its actual running attempt and answered
        // ready. Freeze before the parent capture adapter receives that ack.
        freeze();
      }
      return result;
    },
  };
}

const provider =
  Number.isSafeInteger(providerDelayMs) && providerDelayMs > 0
    ? {
        command: [process.execPath, PROVIDER_FIXTURE],
        env: {
          SETU_FIXTURE_DELAY_MS: String(providerDelayMs),
          SETU_FIXTURE_NO_EFFORT: '1',
          SETU_FIXTURE_PIDFILE: join(root, 'provider-pids'),
        },
      }
    : undefined;
const service = fixture.createService({
  archive: { store },
  createCaptureProcess,
  ...(provider ? { provider } : {}),
});
const dispatched = await service.dispatch(input);
if (boundary === 'acceptance') {
  await service.idle();
  freeze();
}
await service.idle();
if (!existsSync(join(root, 'boundary'))) {
  const eventTypes = fixture.store
    .readEvents({ limit: 200, runId: input.runId })
    .events.map((event) => event.type);
  writeFileSync(
    join(root, 'fixture-result.json'),
    JSON.stringify({
      code: typeof dispatched?.code === 'string' ? dispatched.code : null,
      eventTypes,
      ok: dispatched?.ok === true,
      status: typeof dispatched?.status === 'string' ? dispatched.status : null,
    })
  );
}
