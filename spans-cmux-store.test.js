import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLinksAssociations } from './links-associations.js';
import { createResourceAdmission } from './resource-admission.js';
import {
  createSpansCmuxTransport,
  prepareSpansAssignment,
} from './spans-cmux.js';
import { createSpansCmuxPersistence } from './spans-cmux-store.js';
import { openSpansStore } from './spans-store.js';
import { createWorkspaceState } from './workspace-state.js';

const LIMITS = {
  adapterTimeoutMs: 1000,
  maxContentBytes: 2048,
  maxContentLines: 20,
};
const target = {
  checkoutDigest: 'a'.repeat(64),
  processStart: 'fixture-process-start',
  sessionId: 'session-1',
  surfaceId: 'surface-1',
  workspaceId: 'workspace-1',
};
const assignment = {
  attemptId: 'attempt-1',
  content: 'Implement the bounded parser change.',
  generation: 1,
  planVersion: 1,
  runId: 'run-1',
  spanId: 'span-a',
  target,
};
const inspection = {
  assignmentId: prepareSpansAssignment(assignment, LIMITS).assignmentId,
  generation: 1,
  runId: 'run-1',
};
const fixtures = [];
afterEach(() => {
  for (const f of fixtures.splice(0)) {
    for (const handle of f.handles) {
      handle.close();
    }
    rmSync(f.root, { force: true, recursive: true });
  }
});

function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'setu-cmux-store-')));
  const archive = join(root, 'archive');
  const store = openSpansStore({ root: archive });
  expect(
    store.commitRun({
      events: [],
      expectedGeneration: 0,
      expectedRevision: 0,
      runId: 'run-1',
      view: {
        generation: 1,
        goal: 'Fixture workflow',
        planVersion: 1,
        spans: {
          'span-a': { dependencies: [], spanId: 'span-a', state: 'planned' },
        },
      },
    })
  ).toMatchObject({ ok: true });
  const f = {
    archive,
    handles: [store],
    native: { ...target, promptText: '', state: 'idle' },
    root,
    sends: [],
    submits: [],
    write: (effect) => effect(),
  };
  f.transport = (handle = store, overrides = {}) => {
    const persist = createSpansCmuxPersistence({
      store: handle,
      writeArchive: (effect) => f.write(effect),
    });
    return createSpansCmuxTransport({
      limits: LIMITS,
      now: () => 1000,
      persist,
      pressEnter: (input) => {
        f.submits.push(input);
        f.native.promptText = '';
        f.native.state = 'busy';
        return { ok: true };
      },
      readTarget: () => ({ ok: true, ...f.native }),
      sendText: (input) => {
        f.sends.push(input);
        f.native.promptText = input.text;
        return { ok: true };
      },
      ...overrides,
    });
  };
  f.reopen = () => {
    const handle = openSpansStore({ root: archive });
    f.handles.push(handle);
    return handle;
  };
  f.store = store;
  fixtures.push(f);
  return f;
}

test('delivery and authenticated acknowledgment survive actual archive reopen without changing the run model', async () => {
  const f = fixture();
  const before = f.store.readRun({ runId: 'run-1' }).view;
  const transport = f.transport();
  const delivered = await transport.deliver(assignment);
  expect(delivered).toMatchObject({ acknowledged: false, ok: true });
  expect(f.sends).toHaveLength(1);
  expect(f.submits).toHaveLength(1);
  expect(f.store.readRun({ runId: 'run-1' }).view).toEqual(before);
  const { events } = f.store.readEvents({ runId: 'run-1' });
  expect(events.map((event) => event.payload.phase)).toEqual([
    'intent',
    'text-sent',
    'submitted',
  ]);

  const restarted = f.transport(f.reopen());
  expect(await restarted.inspect(inspection)).toMatchObject({
    found: true,
    ok: true,
    phase: 'submitted',
    transportReceipt: true,
  });
  const prepared = prepareSpansAssignment(assignment, LIMITS);
  expect(
    await restarted.acknowledge(
      {
        ackCode: prepared.ackCode,
        assignmentId: prepared.assignmentId,
        runId: 'run-1',
      },
      { generation: 1, sessionId: target.sessionId }
    )
  ).toMatchObject({
    acknowledged: true,
    ok: true,
  });
  expect(await f.transport(f.reopen()).inspect(inspection)).toMatchObject({
    acknowledged: true,
    ok: true,
    phase: 'acknowledged',
  });
  expect(f.sends).toHaveLength(1);
  expect(f.submits).toHaveLength(1);
  expect(f.store.readRun({ runId: 'run-1' }).view).toEqual(before);
});

test('two archive connections race the same assignment and only the committed intent reaches the terminal', async () => {
  const f = fixture();
  let arrived = 0;
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  f.write = async (effect) => {
    arrived += 1;
    if (arrived <= 2) {
      if (arrived === 2) {
        release();
      }
      await gate;
    }
    return effect();
  };
  const replies = await Promise.all([
    f.transport().deliver(assignment),
    f.transport(f.reopen()).deliver(assignment),
  ]);
  expect(replies.filter((reply) => reply.ok)).toHaveLength(1);
  expect(f.sends).toHaveLength(1);
  expect(f.submits).toHaveLength(1);
  expect(f.store.readEvents({ runId: 'run-1' }).events).toHaveLength(3);
});

test('a lost intent commit reply retains the recorded intent and never resends on restart', async () => {
  const f = fixture();
  f.write = (effect) => {
    effect();
    throw new Error('fixture lost durable-write reply');
  };
  expect(await f.transport().deliver(assignment)).toMatchObject({
    held: true,
    ok: false,
  });
  expect(f.sends).toHaveLength(0);
  f.write = (effect) => effect();
  const restarted = f.transport(f.reopen());
  expect(await restarted.inspect(inspection)).toMatchObject({
    found: true,
    held: true,
    ok: true,
    phase: 'intent',
  });
  expect(await restarted.deliver(assignment)).toMatchObject({
    held: true,
    ok: false,
  });
  expect(f.sends).toHaveLength(0);
  expect(f.submits).toHaveLength(0);
});

test('a generation change while archive admission waits refuses the old intent without overwriting current state', async () => {
  const f = fixture();
  f.write = (effect) => {
    const current = f.store.readRun({ runId: 'run-1' });
    expect(
      f.store.commitRun({
        events: [],
        expectedGeneration: current.generation,
        expectedRevision: current.revision,
        runId: 'run-1',
        view: { ...current.view, generation: 2, goal: 'New owner' },
      })
    ).toMatchObject({ ok: true });
    return effect();
  };
  expect(await f.transport().deliver(assignment)).toMatchObject({ ok: false });
  expect(f.store.readRun({ runId: 'run-1' }).view).toMatchObject({
    generation: 2,
    goal: 'New owner',
  });
  expect(f.store.readEvents({ runId: 'run-1' }).events).toEqual([]);
  expect(f.sends).toHaveLength(0);
});

test('a changed assignment and an imported run cannot mint another delivery', async () => {
  const f = fixture();
  const transport = f.transport();
  expect(await transport.deliver(assignment)).toMatchObject({ ok: true });
  expect(
    await transport.deliver({ ...assignment, content: 'Different work' })
  ).toMatchObject({ ok: false });
  const current = f.store.readRun({ runId: 'run-1' });
  expect(
    f.store.commitRun({
      events: [],
      expectedGeneration: current.generation,
      expectedRevision: current.revision,
      runId: 'run-1',
      view: { ...current.view, kind: 'imported', readOnly: true },
    })
  ).toMatchObject({ ok: true });
  f.native.state = 'idle';
  expect(
    await f.transport().deliver({ ...assignment, assignmentId: 'another' })
  ).toMatchObject({ ok: false });
  expect(f.sends).toHaveLength(1);
});

test('bounded history projection reads committed tails and preserves malformed delivery evidence', async () => {
  const f = fixture();
  for (let batch = 0; batch < 5; batch += 1) {
    const current = f.store.readRun({ runId: 'run-1' });
    expect(
      f.store.commitRun({
        events: Array.from({ length: 200 }, (_, index) => ({
          eventId: `fixture-${batch}-${index}`,
          payload: { text: 'Historical conversation' },
          runId: 'run-1',
          type: 'conversation.message',
        })),
        expectedGeneration: current.generation,
        expectedRevision: current.revision,
        runId: 'run-1',
        view: current.view,
      })
    ).toMatchObject({ ok: true });
  }
  let pages = 0;
  const persist = createSpansCmuxPersistence({
    store: {
      ...f.store,
      readEvents: (query) => {
        pages += 1;
        return f.store.readEvents(query);
      },
    },
    writeArchive: (effect) => effect(),
  });
  expect(
    await persist({ ...inspection, generation: undefined, op: 'read' })
  ).toMatchObject({ ok: false });
  const read = {
    assignmentId: inspection.assignmentId,
    op: 'read',
    runId: 'run-1',
  };
  expect(await persist(read)).toMatchObject({ ok: true, record: null });
  expect(pages).toBe(5);
  expect(await persist(read)).toMatchObject({ ok: true, record: null });
  expect(pages).toBe(6);
  expect(
    f.store.appendEvent({
      eventId: 'malformed-delivery',
      payload: { assignmentId: inspection.assignmentId },
      runId: 'run-1',
      type: 'spans.cmux.delivery',
    })
  ).toMatchObject({ ok: true });
  expect(await persist(read)).toMatchObject({ ok: false });
});

test('a delivery event with a missing assignment identity is damaged history, never proof of an unsent assignment', async () => {
  const f = fixture();
  expect(
    f.store.appendEvent({
      eventId: 'missing-assignment-identity',
      payload: {},
      runId: 'run-1',
      type: 'spans.cmux.delivery',
    })
  ).toMatchObject({ ok: true });
  expect(await f.transport().deliver(assignment)).toMatchObject({ ok: false });
  expect(f.sends).toHaveLength(0);
});

test('the shared archive admission gate refuses a full archive before delivery and permits the same intent once capacity is available', async () => {
  const f = fixture();
  let totalBytes = 5 * 1024 ** 3;
  const state = createWorkspaceState({
    configPath: join(f.root, 'config.json'),
    setuDir: f.root,
    workspaceRoot: f.root,
  });
  const admission = createResourceAdmission({
    archiveCapacity: () =>
      Promise.resolve({ ok: true, state: 'known', totalBytes }),
    hostHealth: () =>
      Promise.resolve({ availableBytes: 30 * 1024 ** 3, state: 'ready' }),
    state,
  });
  f.write = async (effect) => {
    const admitted = await admission.withSpansArchiveWrite(
      { maxBytes: 65_536, root: f.archive },
      effect
    );
    return admitted.ok ? admitted.value : admitted;
  };
  const transport = f.transport();
  expect(await transport.deliver(assignment)).toMatchObject({
    held: false,
    ok: false,
    retryAllowed: true,
  });
  expect(f.store.readEvents({ runId: 'run-1' }).events).toEqual([]);
  expect(f.sends).toHaveLength(0);
  totalBytes = 1;
  expect(await transport.deliver(assignment)).toMatchObject({ ok: true });
  expect(f.sends).toHaveLength(1);
  expect(f.submits).toHaveLength(1);
  expect(f.store.readEvents({ runId: 'run-1' }).events).toHaveLength(3);
});

test('late archive callbacks cannot commit and duplicate callbacks leave one unresolved intent', async () => {
  const late = fixture();
  let callback;
  late.write = (effect) => {
    callback = effect;
    return { ok: false };
  };
  expect(await late.transport().deliver(assignment)).toMatchObject({
    ok: false,
  });
  expect(callback()).toMatchObject({ ok: false });
  expect(late.store.readEvents({ runId: 'run-1' }).events).toEqual([]);
  expect(late.sends).toHaveLength(0);

  const duplicate = fixture();
  duplicate.write = (effect) => {
    const result = effect();
    effect();
    return result;
  };
  expect(await duplicate.transport().deliver(assignment)).toMatchObject({
    held: true,
    ok: false,
    retryAllowed: false,
  });
  expect(duplicate.store.readEvents({ runId: 'run-1' }).events).toHaveLength(1);
  expect(duplicate.sends).toHaveLength(0);
});

test('a proxy request is refused without invoking its traps or touching the archive', async () => {
  const f = fixture();
  let traps = 0;
  const proxy = new Proxy(
    {},
    {
      get() {
        traps += 1;
        throw new Error('unexpected get');
      },
      getPrototypeOf() {
        traps += 1;
        throw new Error('unexpected prototype');
      },
      ownKeys() {
        traps += 1;
        throw new Error('unexpected keys');
      },
    }
  );
  const persist = createSpansCmuxPersistence({
    store: f.store,
    writeArchive: (effect) => effect(),
  });
  expect(await persist(proxy)).toEqual({ code: 'REQUEST_INVALID', ok: false });
  expect(traps).toBe(0);
  expect(f.store.readEvents({ runId: 'run-1' }).events).toEqual([]);
});

test('delivery commits preserve an actual retained Links approval byte for byte', async () => {
  const f = fixture();
  const links = createLinksAssociations({
    isKnownOrigin: () => true,
    store: f.store,
  });
  const selected = { hint: 'run-1', origin: 'peer-A', runId: 'run-1' };
  const preview = links.preview(selected);
  expect(preview.ok).toBe(true);
  expect(
    links.approve({ ...selected, confirmation: preview.review.token }).ok
  ).toBe(true);
  const before = f.store.readRun({ runId: 'run-1' }).view.linksAssociations;
  expect(await f.transport().deliver(assignment)).toMatchObject({ ok: true });
  expect(f.store.readRun({ runId: 'run-1' }).view.linksAssociations).toEqual(
    before
  );
});
