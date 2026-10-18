#!/usr/bin/env bun
// Runs a Spans execution service in its own process and freezes it at one
// named boundary, so a test can kill the whole process there and restart. It
// is test infrastructure for the crash tests, not part of the product.
//
//   bun spans-execution.crash-fixture.js '<json {root, boundary, input}>'

import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { attachExecutionFixture } from './spans-execution.test-support.js';

const { boundary, input, root } = JSON.parse(process.argv[2]);
const fixture = attachExecutionFixture(root);

// The boundary event is durable before the process stops, exactly as it would
// be if the machine lost power right after the commit.
const BOUNDARY_EVENTS = {
  exit: 'spans.worker.exited',
  intent: 'spans.action.intent',
  outcome: 'spans.action.outcome',
  reservation: 'spans.usage.reserve',
  run: 'spans.worker.launched',
};

function freeze() {
  writeFileSync(join(root, 'boundary'), boundary);
  // Block this thread until the test kills the process.
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10 * 60 * 1000);
}

const hitsBoundary = (events = []) =>
  events.some((event) => event.type === BOUNDARY_EVENTS[boundary]);

const store = {
  ...fixture.store,
  commitRun(request) {
    const result = fixture.store.commitRun(request);
    if (result.ok && hitsBoundary(request.events)) {
      freeze();
    }
    return result;
  },
};

// Mid-launch: the process exists, nothing about it has been recorded yet.
const spawn =
  boundary === 'launch'
    ? (argv, options) => {
        const child = Bun.spawn(argv, options);
        freeze();
        return child;
      }
    : undefined;

const service = fixture.createService({ archive: { store }, spawn });
await service.dispatch(input);
if (boundary === 'acceptance') {
  await service.idle();
  freeze();
}
await service.idle();
