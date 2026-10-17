import { expect, test } from 'bun:test';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createOperationEvents } from './operation-events.js';
import { createWorkspaceState } from './workspace-state.js';

function state() {
  const root = fs.mkdtempSync(join(tmpdir(), 'setu-operation-events-test-'));
  const configPath = join(root, 'config.json');
  const config = '{\n  "customSetting": true\n}\n';
  fs.writeFileSync(configPath, config);
  return {
    config,
    configPath,
    root,
    state: createWorkspaceState({
      configPath,
      setuDir: root,
      workspaceRoot: root,
    }),
  };
}

test('persists bounded, target-filterable operation events through workspace state', async () => {
  const fixture = state();
  try {
    const events = createOperationEvents({
      limit: 2,
      now: () => 100,
      state: fixture.state,
    });
    await events.record({
      argv: ['private'],
      at: 1,
      env: { TOKEN: 'private' },
      id: 'one',
      kind: 'start',
      prompt: 'private',
      source: 'cli',
      state: 'accepted',
      summary: 'Started',
      target: { name: 'main', repo: 'r' },
    });
    await events.record({
      at: 2,
      id: 'two',
      kind: 'start',
      operationId: 'op-2',
      source: 'mcp',
      state: 'completed',
      target: { name: 'topic', repo: 'r' },
    });
    await events.record({
      at: 3,
      code: 'STOP_FAILED',
      id: 'three',
      kind: 'stop',
      source: 'portal',
      state: 'failed',
      target: null,
    });

    expect(events.list({ target: { name: 'topic', repo: 'r' } })).toEqual({
      events: [expect.objectContaining({ id: 'two', operationId: 'op-2' })],
      ok: true,
    });
    expect(events.list({ since: 2 })).toEqual({
      events: [
        expect.objectContaining({ id: 'two' }),
        expect.objectContaining({ id: 'three' }),
      ],
      ok: true,
    });
    expect(fixture.state.read('operationEvents').events).toHaveLength(2);
    expect(fixture.state.read('operationEvents').events[0]).not.toHaveProperty(
      'argv'
    );
    expect(fixture.state.read('operationEvents').events[0]).not.toHaveProperty(
      'env'
    );
    expect(fixture.state.read('operationEvents').events[0]).not.toHaveProperty(
      'prompt'
    );
    expect(fs.readFileSync(fixture.configPath, 'utf8')).toBe(fixture.config);
  } finally {
    fs.rmSync(fixture.root, { force: true, recursive: true });
  }
});

test('does not replace a completed event with a later failed event', async () => {
  const fixture = state();
  try {
    const events = createOperationEvents({
      now: () => 100,
      state: fixture.state,
    });
    await events.record({
      at: 1,
      id: 'same',
      kind: 'setup',
      source: 'ui',
      state: 'completed',
      target: null,
    });
    await events.record({
      at: 2,
      id: 'same',
      kind: 'setup',
      source: 'ui',
      state: 'running',
      target: null,
    });
    await events.record({
      at: 3,
      id: 'same',
      kind: 'setup',
      source: 'ui',
      state: 'accepted',
      target: null,
    });
    await events.record({
      at: 4,
      id: 'same',
      kind: 'setup',
      source: 'ui',
      state: 'unknown',
      target: null,
    });
    await events.record({
      at: 2,
      code: 'LATE_FAILURE',
      id: 'same',
      kind: 'setup',
      source: 'ui',
      state: 'failed',
      target: null,
    });
    await events.record({
      at: 5,
      id: 'separate',
      kind: 'setup',
      source: 'ui',
      state: 'running',
      target: null,
    });
    expect(events.list({}).events).toEqual([
      expect.objectContaining({ at: 1, id: 'same', state: 'completed' }),
      expect.objectContaining({ at: 5, id: 'separate', state: 'running' }),
    ]);
  } finally {
    fs.rmSync(fixture.root, { force: true, recursive: true });
  }
});

test('records only allowed fields and recording failure remains an operation result', async () => {
  const events = createOperationEvents({
    now: () => 100,
    state: {
      read: () => ({}),
      // biome-ignore lint/suspicious/useAwait: The journal fixture must reject persistence failures.
      update: async () => {
        throw new Error('storage unavailable');
      },
    },
  });
  const result = await events.record({
    argv: ['secret'],
    at: 1,
    env: { TOKEN: 'secret' },
    id: 'safe',
    kind: 'setup',
    prompt: 'secret',
    source: 'raycast',
    state: 'running',
    target: null,
  });

  expect(result).toMatchObject({
    code: 'OPERATION_EVENT_UNAVAILABLE',
    ok: false,
  });
});

test('late startup recording cannot replace failure or uncertainty, but reconciliation can finish', async () => {
  const fixture = state();
  try {
    const events = createOperationEvents({ state: fixture.state });
    for (const terminal of ['failed', 'unknown']) {
      const entry = {
        at: 1,
        id: terminal,
        kind: 'deploy',
        source: 'portal',
        target: null,
      };
      // biome-ignore lint/performance/noAwaitInLoops: Persist the terminal state before testing later stale states in the same journal.
      await events.record({ ...entry, state: terminal });
      for (const pending of ['accepted', 'queued', 'running']) {
        expect(
          // biome-ignore lint/performance/noAwaitInLoops: Each attempted stale transition must settle before the next observation of this shared event.
          await events.record({ ...entry, at: 2, state: pending })
        ).toMatchObject({
          event: { state: terminal },
          ok: true,
          preserved: true,
        });
      }
    }
    await events.record({
      at: 3,
      id: 'unknown',
      kind: 'deploy',
      source: 'portal',
      state: 'completed',
      target: null,
    });
    expect(events.list({}).events.map((item) => item.state)).toEqual([
      'failed',
      'completed',
    ]);
  } finally {
    fs.rmSync(fixture.root, { force: true, recursive: true });
  }
});
