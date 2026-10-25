import { expect, test } from 'bun:test';
import {
  createSpansCmuxTransport,
  prepareSpansAssignment,
} from './spans-cmux.js';

const CHECKOUT = 'c'.repeat(64);
const OTHER_CHECKOUT = 'd'.repeat(64);
const SECRET = 'sk-seededSecretValue1234567890';
const PRINTED_ACK_PATTERN = /\| ack ([0-9a-f]{16})\]/;
const ACK_CODE_PATTERN = /^[0-9a-f]{16}$/;
const LIMITS = {
  adapterTimeoutMs: 50,
  maxContentBytes: 2048,
  maxContentLines: 20,
};
// What spans-store.js accepts for eventId, runId and type.
const STORE_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const EVENT_ID = /^spans\.cmux\.delivery:[0-9a-f]{64}$/;
const TARGET_FIELDS = [
  'checkoutDigest',
  'processStart',
  'sessionId',
  'surfaceId',
  'workspaceId',
];

const hang = () => new Promise(() => undefined);

const target = (overrides = {}) => ({
  checkoutDigest: CHECKOUT,
  processStart: 'proc-100',
  sessionId: 'session-1',
  surfaceId: 'surface-1',
  workspaceId: 'workspace-1',
  ...overrides,
});

const request = (overrides = {}) => ({
  attemptId: 'attempt-1',
  content: 'Implement the parser change.\nReport back when done.',
  generation: 1,
  planVersion: 1,
  runId: 'run-1',
  spanId: 'span-a',
  target: target(),
  ...overrides,
});

const DEFAULT = prepareSpansAssignment(request(), LIMITS);

// A world is the fake cmux surface plus a fake store that enforces the same
// compare-and-set the real event/model store gives the persist adapter. Every
// adapter delegates to world.impl so a test can replace one behavior.
//
// The default send and Enter adapters play the trusted adapter of the contract:
// at the moment of the effect they refuse (with proof of no effect) unless the
// binding they were handed names the run's current generation. `calls` lists
// surface reads, effects and store writes; `trace` also lists store reads.
function createWorld() {
  const world = {
    calls: [],
    clock: { value: 1000 },
    entered: [],
    impl: {},
    onRead: new Map(),
    phasesAtSend: null,
    reads: 0,
    sent: [],
    store: { fail: null, generation: 1, records: new Map(), writes: [] },
    surface: {
      checkoutDigest: CHECKOUT,
      processStart: 'proc-100',
      promptText: '',
      sessionId: 'session-1',
      state: 'idle',
      surfaceId: 'surface-1',
      workspaceId: 'workspace-1',
    },
    trace: [],
  };
  const note = (name) => {
    world.calls.push(name);
    world.trace.push(name);
  };
  world.impl.readTarget = async () => {
    world.reads += 1;
    note('read');
    // A hook may throw or hang to simulate an adapter fault on that read.
    await world.onRead.get(world.reads)?.(world.surface);
    return { ok: true, ...structuredClone(world.surface) };
  };
  world.impl.sendText = (args) => {
    note('send');
    if (args.generation !== world.store.generation) {
      return { notSent: true, ok: false };
    }
    world.phasesAtSend = [...world.store.records.values()].map(
      (record) => record.phase
    );
    world.sent.push(structuredClone(args));
    world.surface.promptText = args.text;
    return { ok: true };
  };
  world.impl.pressEnter = (args) => {
    note('enter');
    if (args.generation !== world.store.generation) {
      return { notPressed: true, ok: false };
    }
    world.entered.push(structuredClone(args));
    world.surface.promptText = '';
    world.surface.state = 'busy';
    return { ok: true };
  };
  world.impl.persist = (input) => {
    const { store } = world;
    const key = `${input.runId}/${input.assignmentId}`;
    if (input.op === 'read') {
      world.trace.push('load');
      const record = store.records.get(key);
      return {
        generation: store.generation,
        ok: true,
        record: record ? structuredClone(record) : null,
      };
    }
    note(`write:${input.record.phase}`);
    store.writes.push(structuredClone(input));
    const mode =
      store.fail?.phase === input.record.phase ? store.fail.mode : null;
    if (mode === 'reject') {
      return { code: 'DISK_FULL', ok: false };
    }
    if (mode === 'throw') {
      throw new Error(`disk failure ${SECRET}`);
    }
    if (input.generation !== store.generation) {
      return { code: 'STALE_GENERATION', ok: false };
    }
    const current = store.records.get(key);
    const matches = current
      ? input.expected?.phase === current.phase &&
        input.expected?.deliveryAttempt === current.deliveryAttempt
      : input.expected === null;
    if (!matches) {
      return { code: 'PHASE_CONFLICT', ok: false };
    }
    store.records.set(key, structuredClone(input.record));
    if (mode === 'throw-after-commit') {
      throw new Error('response lost');
    }
    return { ok: true };
  };
  return world;
}

function transportFor(world, overrides = {}) {
  return createSpansCmuxTransport({
    limits: LIMITS,
    now: () => world.clock.value,
    persist: (input) => world.impl.persist(input),
    pressEnter: (input) => world.impl.pressEnter(input),
    readTarget: (input) => world.impl.readTarget(input),
    sendText: (input) => world.impl.sendText(input),
    ...overrides,
  });
}

const stored = (world, assignmentId = DEFAULT.assignmentId) =>
  world.store.records.get(`run-1/${assignmentId}`);

test('an explicitly unknown persistence reply holds a committed intent without offering a safe retry', async () => {
  const world = createWorld();
  const { persist } = world.impl;
  world.impl.persist = (input) => {
    const result = persist(input);
    return input.op === 'write' && input.record.phase === 'intent'
      ? { ok: false, unknown: true }
      : result;
  };
  const reply = await transportFor(world).deliver(request());
  expect(reply).toMatchObject({
    held: true,
    ok: false,
    recordUncertain: true,
    retryAllowed: false,
  });
  expect(world.sent).toHaveLength(0);
  world.impl.persist = persist;
  expect(await transportFor(world).deliver(request())).toMatchObject({
    held: true,
    ok: false,
  });
  expect(world.sent).toHaveLength(0);
});

// What the agent's message carries.
const ackFor = (overrides = {}) => ({
  ackCode: DEFAULT.ackCode,
  assignmentId: DEFAULT.assignmentId,
  runId: 'run-1',
  ...overrides,
});

// What the receiving session's trusted front door supplies, separately.
const trusted = (overrides = {}) => ({
  generation: 1,
  sessionId: 'session-1',
  ...overrides,
});

const inspectInput = (overrides = {}) => ({
  assignmentId: DEFAULT.assignmentId,
  generation: 1,
  runId: 'run-1',
  ...overrides,
});

function setup(overrides) {
  const world = createWorld();
  return { transport: transportFor(world, overrides), world };
}

// ---------------------------------------------------------------------------
// Happy path and the receipt/acknowledgment split
// ---------------------------------------------------------------------------

test('delivers in order: intent persisted before send, identity re-read before Enter', async () => {
  const { transport, world } = setup();
  const result = await transport.deliver(request());

  expect(result).toMatchObject({
    acknowledged: false,
    assignmentId: DEFAULT.assignmentId,
    duplicate: false,
    effect: 'submitted',
    ok: true,
    phase: 'submitted',
    transportReceipt: true,
  });
  expect(world.calls).toEqual([
    'read',
    'write:intent',
    'read',
    'send',
    'write:text-sent',
    'read',
    'enter',
    'write:submitted',
  ]);
  // Durable state is re-read after each observation, before each effect.
  expect(world.trace).toEqual([
    'load',
    'read',
    'write:intent',
    'read',
    'load',
    'send',
    'write:text-sent',
    'read',
    'load',
    'enter',
    'write:submitted',
  ]);
  expect(world.phasesAtSend).toEqual(['intent']);
  expect(world.sent).toHaveLength(1);
  expect(world.entered).toHaveLength(1);
  expect(world.sent[0].text).toBe(DEFAULT.text);
  expect(world.sent[0].text).toContain(
    `[Spans assignment ${DEFAULT.assignmentId} | ack ${DEFAULT.ackCode}]`
  );
  expect(world.sent[0]).toMatchObject(target());
  expect(world.entered[0]).not.toHaveProperty('text');
  expect(stored(world)).toMatchObject({
    deliveryAttempt: 1,
    phase: 'submitted',
    transportReceipt: true,
  });
});

test('a transport receipt is not an acknowledgment; only the exact ack code from the bound session is', async () => {
  const { transport, world } = setup();
  await transport.deliver(request({ ackWithinMs: 5000 }));

  expect(await transport.inspect(inspectInput())).toMatchObject({
    ackDueAt: 6000,
    acknowledged: false,
    ackStatus: 'pending',
    phase: 'submitted',
    transportReceipt: true,
  });

  const ack = await transport.acknowledge(ackFor(), trusted());
  expect(ack).toMatchObject({
    acknowledged: true,
    duplicate: false,
    ok: true,
    transportReceipt: true,
  });
  expect(stored(world)).toMatchObject({ phase: 'acknowledged' });
  expect(await transport.inspect(inspectInput())).toMatchObject({
    acknowledged: true,
    ackStatus: 'received',
  });
  // The same acknowledgment again is a no-op duplicate.
  expect(await transport.acknowledge(ackFor(), trusted())).toMatchObject({
    duplicate: true,
    ok: true,
  });
  // Delivery after acknowledgment is a duplicate and sends nothing.
  expect(await transport.deliver(request())).toMatchObject({
    acknowledged: true,
    duplicate: true,
    ok: true,
  });
  expect(world.sent).toHaveLength(1);
  expect(world.entered).toHaveLength(1);
});

test('a missing ack is reported overdue but never repaired, inferred or resent', async () => {
  const { transport, world } = setup();
  await transport.deliver(request({ ackWithinMs: 5000 }));
  world.clock.value = 6001;

  expect(await transport.inspect(inspectInput())).toMatchObject({
    acknowledged: false,
    ackStatus: 'overdue',
    held: false,
    phase: 'submitted',
    retryAllowed: false,
  });
  const writesBefore = world.store.writes.length;
  expect(await transport.deliver(request({ ackWithinMs: 5000 }))).toMatchObject(
    {
      acknowledged: false,
      duplicate: true,
      ok: true,
    }
  );
  expect(world.sent).toHaveLength(1);
  expect(world.entered).toHaveLength(1);
  expect(world.store.writes).toHaveLength(writesBefore);
});

test('without a deadline a missing ack stays pending and is not inferred from the surface', async () => {
  const { transport, world } = setup();
  await transport.deliver(request());
  world.clock.value = 999_999_999;
  world.surface.state = 'idle';
  world.surface.promptText = '';

  expect(await transport.inspect(inspectInput())).toMatchObject({
    ackDueAt: null,
    acknowledged: false,
    ackStatus: 'pending',
  });
});

test('mismatched acknowledgments are refused and change nothing', async () => {
  const { transport, world } = setup();
  await transport.deliver(request());
  const writes = world.store.writes.length;

  const cases = [
    [ackFor({ ackCode: 'f'.repeat(16) }), trusted(), 'ACK_MISMATCH'],
    [ackFor({ ackCode: 'short' }), trusted(), 'ACK_MISMATCH'],
    [
      ackFor({ ackCode: DEFAULT.ackCode.toUpperCase() }),
      trusted(),
      'ACK_MISMATCH',
    ],
    // The wrong session, even with the right code printed in the brief.
    [ackFor(), trusted({ sessionId: 'session-2' }), 'ACK_MISMATCH'],
    [
      ackFor({ assignmentId: 'assignment-unknown' }),
      trusted(),
      'ASSIGNMENT_NOT_FOUND',
    ],
    [ackFor({ runId: 'run-2' }), trusted(), 'ASSIGNMENT_NOT_FOUND'],
    // The wrong generation, older or newer than the run's current one.
    [ackFor(), trusted({ generation: 0 }), 'STALE_GENERATION'],
    [ackFor(), trusted({ generation: 2 }), 'STALE_GENERATION'],
    [ackFor(), trusted({ generation: -1 }), 'GENERATION_INVALID'],
    [ackFor(), trusted({ generation: '1' }), 'GENERATION_INVALID'],
    // Process exit and approvals are not acknowledgment fields.
    [{ ...ackFor(), exitCode: 0 }, trusted(), 'REQUEST_INVALID'],
    [{ ...ackFor(), processExited: true }, trusted(), 'REQUEST_INVALID'],
    [{ ...ackFor(), approved: true }, trusted(), 'REQUEST_INVALID'],
    [{ ackCode: DEFAULT.ackCode }, trusted(), 'REQUEST_INVALID'],
    // A message body cannot carry the session or generation that authorizes it.
    [{ ...ackFor(), sessionId: 'session-1' }, trusted(), 'REQUEST_INVALID'],
    [{ ...ackFor(), generation: 1 }, trusted(), 'REQUEST_INVALID'],
    // Without trusted context there is nothing to authorize against.
    [ackFor(), undefined, 'ACK_CONTEXT_REQUIRED'],
    [ackFor(), null, 'ACK_CONTEXT_REQUIRED'],
    [ackFor(), {}, 'ACK_CONTEXT_REQUIRED'],
    [ackFor(), { sessionId: 'session-1' }, 'ACK_CONTEXT_REQUIRED'],
    [ackFor(), { generation: 1 }, 'ACK_CONTEXT_REQUIRED'],
    [ackFor(), { ...trusted(), approved: true }, 'ACK_CONTEXT_REQUIRED'],
    [
      ackFor(),
      { ...trusted(), ackCode: DEFAULT.ackCode },
      'ACK_CONTEXT_REQUIRED',
    ],
    [ackFor(), trusted({ sessionId: '' }), 'ID_INVALID'],
  ];
  for (const [input, context, code] of cases) {
    // biome-ignore lint/performance/noAwaitInLoops: Sequential fixture checks must finish before the next mutation.
    const result = await transport.acknowledge(input, context);
    expect(result).toMatchObject({ code, ok: false });
    expect(typeof result.error).toBe('string');
  }
  expect(world.store.writes).toHaveLength(writes);
  expect(stored(world).phase).toBe('submitted');
});

test('a wrong session or generation cannot resolve a held delivery, and the printed code alone is not authority', async () => {
  const { transport, world } = setup();
  world.impl.pressEnter = () => {
    throw new Error('lost');
  };
  expect((await transport.deliver(request())).code).toBe('ENTER_UNCERTAIN');
  const writes = world.store.writes.length;

  // The code is read straight out of the text that was pasted into the prompt.
  const printed = PRINTED_ACK_PATTERN.exec(world.surface.promptText)?.[1];
  expect(printed).toBe(DEFAULT.ackCode);
  expect(
    await transport.acknowledge(
      ackFor({ ackCode: printed }),
      trusted({ sessionId: 'session-2' })
    )
  ).toMatchObject({ code: 'ACK_MISMATCH', ok: false });
  for (const generation of [0, 2]) {
    expect(
      // biome-ignore lint/performance/noAwaitInLoops: Sequential fixture checks must finish before the next mutation.
      await transport.acknowledge(ackFor(), trusted({ generation }))
    ).toMatchObject({ code: 'STALE_GENERATION', ok: false });
  }
  expect(world.store.writes).toHaveLength(writes);
  expect(stored(world)).toMatchObject({ phase: 'held' });
  expect(await transport.acknowledge(ackFor(), trusted())).toMatchObject({
    ok: true,
  });
});

test('an ack naming an assignment from a different delivery is not accepted', async () => {
  const { transport, world } = setup();
  await transport.deliver(request());
  const other = prepareSpansAssignment(
    request({ attemptId: 'attempt-2' }),
    LIMITS
  );
  // Another assignment's code against this assignment ID is a mismatch.
  expect(
    await transport.acknowledge(ackFor({ ackCode: other.ackCode }), trusted())
  ).toMatchObject({ code: 'ACK_MISMATCH', ok: false });
  expect(stored(world).phase).toBe('submitted');
});

test('an assignment proven unsent cannot be acknowledged', async () => {
  const { transport, world } = setup();
  world.impl.sendText = async () => ({ notSent: true, ok: false });
  expect(await transport.deliver(request())).toMatchObject({
    code: 'SEND_REFUSED',
    effect: 'none',
  });
  expect(await transport.acknowledge(ackFor(), trusted())).toMatchObject({
    code: 'ACK_NOT_ALLOWED',
    ok: false,
  });
  expect(stored(world).phase).toBe('unsent');
});

// ---------------------------------------------------------------------------
// Target and prompt checks before the intent
// ---------------------------------------------------------------------------

test('refuses a busy target and a non-empty prompt before persisting anything', async () => {
  const busy = setup();
  busy.world.surface.state = 'busy';
  expect(await busy.transport.deliver(request())).toMatchObject({
    code: 'TARGET_NOT_IDLE',
    effect: 'none',
    ok: false,
    retryAllowed: true,
  });

  const unknown = setup();
  unknown.world.surface.state = 'unknown';
  expect((await unknown.transport.deliver(request())).code).toBe(
    'TARGET_NOT_IDLE'
  );

  const typed = setup();
  typed.world.surface.promptText = 'half typed by a person';
  expect(await typed.transport.deliver(request())).toMatchObject({
    code: 'PROMPT_NOT_EMPTY',
    effect: 'none',
    ok: false,
  });

  for (const { world } of [busy, unknown, typed]) {
    expect(world.calls).toEqual(['read']);
    expect(world.store.writes).toHaveLength(0);
    expect(world.sent).toHaveLength(0);
  }
});

test("only a prompt of exactly zero characters is empty: whitespace is a person's input", async () => {
  const prompts = [' ', '  \r\n  ', '\n', '\r\n', '\t', ' ', '　'];
  for (const promptText of prompts) {
    const { transport, world } = setup();
    world.surface.promptText = promptText;
    // biome-ignore lint/performance/noAwaitInLoops: Sequential fixture checks must finish before the next mutation.
    expect(await transport.deliver(request())).toMatchObject({
      code: 'PROMPT_NOT_EMPTY',
      effect: 'none',
      ok: false,
    });
    expect(world.store.writes).toHaveLength(0);
    expect(world.sent).toHaveLength(0);
  }
  // The same holds for a prompt that changes after the intent was saved.
  const { transport, world } = setup();
  world.onRead.set(2, (surface) => {
    surface.promptText = ' ';
  });
  expect(await transport.deliver(request())).toMatchObject({
    code: 'PROMPT_NOT_EMPTY',
    phase: 'unsent',
  });
  expect(world.sent).toHaveLength(0);

  const empty = setup();
  expect((await empty.transport.deliver(request())).ok).toBe(true);
});

test('an unreadable or malformed target is never assumed to be fine', async () => {
  const behaviors = {
    hang: () => hang(),
    malformedState: async () => ({
      ok: true,
      ...target(),
      promptText: '',
      state: 'exited',
    }),
    nothing: async () => undefined,
    notOk: async () => ({ ok: false }),
    oversizeDigest: async () => ({
      ok: true,
      ...target({ checkoutDigest: 'xyz' }),
      promptText: '',
      state: 'idle',
    }),
    throws: () => {
      throw new Error(`cmux said ${SECRET}`);
    },
  };
  for (const [_name, readTarget] of Object.entries(behaviors)) {
    const { transport, world } = setup();
    world.impl.readTarget = readTarget;
    // biome-ignore lint/performance/noAwaitInLoops: Sequential fixture checks must finish before the next mutation.
    const result = await transport.deliver(request());
    expect(result).toMatchObject({
      code: 'TARGET_UNREADABLE',
      effect: 'none',
      ok: false,
    });
    expect(JSON.stringify(result)).not.toContain(SECRET);
    expect(world.store.writes).toHaveLength(0);
    expect(world.sent).toHaveLength(0);
  }
});

test('refuses a surface whose identity differs in any bound field', async () => {
  for (const field of TARGET_FIELDS) {
    const { transport, world } = setup();
    world.surface[field] =
      field === 'checkoutDigest' ? OTHER_CHECKOUT : 'other';
    // biome-ignore lint/performance/noAwaitInLoops: Sequential fixture checks must finish before the next mutation.
    const result = await transport.deliver(request());
    expect(result).toMatchObject({
      code: 'TARGET_MISMATCH',
      effect: 'none',
      ok: false,
    });
    expect(world.store.writes).toHaveLength(0);
    expect(world.sent).toHaveLength(0);
  }
});

// ---------------------------------------------------------------------------
// Races between the checks
// ---------------------------------------------------------------------------

test('a target change after the intent is persisted but before send records unsent and sends nothing', async () => {
  const races = {
    busy: [
      (surface) => {
        surface.state = 'busy';
      },
      'TARGET_NOT_IDLE',
    ],
    process: [
      (surface) => {
        surface.processStart = 'proc-200';
      },
      'TARGET_MISMATCH',
    ],
    typed: [
      (surface) => {
        surface.promptText = 'someone typed';
      },
      'PROMPT_NOT_EMPTY',
    ],
    unreadable: [
      () => {
        throw new Error('gone');
      },
      'TARGET_UNREADABLE',
    ],
  };
  for (const [_name, [mutate, code]] of Object.entries(races)) {
    const { transport, world } = setup();
    world.onRead.set(2, mutate);
    // biome-ignore lint/performance/noAwaitInLoops: Sequential fixture checks must finish before the next mutation.
    const result = await transport.deliver(request());
    expect(result).toMatchObject({
      code,
      effect: 'none',
      held: false,
      ok: false,
      phase: 'unsent',
      retryAllowed: true,
    });
    expect(world.calls).toEqual([
      'read',
      'write:intent',
      'read',
      'write:unsent',
    ]);
    expect(world.sent).toHaveLength(0);
    expect(stored(world)).toMatchObject({ phase: 'unsent', reason: code });
  }
});

test('a proven-unsent delivery may be retried by a fresh call as a numbered attempt', async () => {
  const { transport, world } = setup();
  world.onRead.set(2, (surface) => {
    surface.state = 'busy';
  });
  expect((await transport.deliver(request())).code).toBe('TARGET_NOT_IDLE');
  world.surface.state = 'idle';

  const retry = await transport.deliver(request());
  expect(retry).toMatchObject({
    duplicate: false,
    ok: true,
    phase: 'submitted',
  });
  expect(stored(world).deliveryAttempt).toBe(2);
  expect(world.sent).toHaveLength(1);
});

test('if the unsent record cannot be saved the saved intent holds the assignment', async () => {
  const { transport, world } = setup();
  world.store.fail = { mode: 'reject', phase: 'unsent' };
  world.onRead.set(2, (surface) => {
    surface.state = 'busy';
  });
  expect(await transport.deliver(request())).toMatchObject({
    code: 'TARGET_NOT_IDLE',
    held: true,
    phase: 'intent',
    retryAllowed: false,
  });
  world.surface.state = 'idle';
  expect(await transport.deliver(request())).toMatchObject({
    code: 'DELIVERY_UNCERTAIN',
    held: true,
    retryAllowed: false,
  });
  expect(world.sent).toHaveLength(0);
});

test('identity drift between paste and Enter refuses Enter, holds, and is not resent', async () => {
  for (const field of TARGET_FIELDS) {
    const { transport, world } = setup();
    world.onRead.set(3, (surface) => {
      surface[field] = field === 'checkoutDigest' ? OTHER_CHECKOUT : 'other';
    });
    // biome-ignore lint/performance/noAwaitInLoops: Sequential fixture checks must finish before the next mutation.
    const result = await transport.deliver(request());
    expect(result).toMatchObject({
      code: 'TARGET_DRIFT',
      effect: 'pasted',
      held: true,
      holdRecorded: true,
      ok: false,
      retryAllowed: false,
    });
    expect(world.entered).toHaveLength(0);
    expect(stored(world)).toMatchObject({
      phase: 'held',
      reason: 'TARGET_DRIFT',
    });

    // Restoring the surface does not reopen delivery.
    world.surface[field] =
      field === 'checkoutDigest' ? CHECKOUT : target()[field];
    world.surface.promptText = '';
    expect((await transport.deliver(request())).code).toBe(
      'DELIVERY_UNCERTAIN'
    );
    expect(world.sent).toHaveLength(1);
    expect(world.entered).toHaveLength(0);
  }
});

test('a prompt that is not exactly the sent text refuses Enter', async () => {
  const changes = {
    appended: (surface) => {
      surface.promptText += ' and also rm -rf';
    },
    busy: (surface) => {
      surface.state = 'busy';
    },
    cleared: (surface) => {
      surface.promptText = '';
    },
    edited: (surface) => {
      surface.promptText = surface.promptText.replace('parser', 'wrong');
    },
    unknown: (surface) => {
      surface.state = 'unknown';
    },
  };
  for (const [_name, mutate] of Object.entries(changes)) {
    const { transport, world } = setup();
    world.onRead.set(3, mutate);
    // biome-ignore lint/performance/noAwaitInLoops: Sequential fixture checks must finish before the next mutation.
    const result = await transport.deliver(request());
    expect(result).toMatchObject({
      code: 'PROMPT_CHANGED',
      effect: 'pasted',
      held: true,
      ok: false,
    });
    expect(world.entered).toHaveLength(0);
    expect(stored(world)).toMatchObject({
      phase: 'held',
      reason: 'PROMPT_CHANGED',
    });
  }
});

test('a generation that advances during a read before the intent, the send or Enter leads to no further effect', async () => {
  const advance = (world) => () => {
    world.store.generation = 2;
  };

  // During the first read: the fenced intent write loses and nothing is stored.
  const early = setup();
  early.world.onRead.set(1, advance(early.world));
  expect(await early.transport.deliver(request())).toMatchObject({
    code: 'STALE_GENERATION',
    effect: 'none',
    ok: false,
    retryAllowed: true,
  });
  expect(early.world.store.records.size).toBe(0);
  expect(early.world.sent).toHaveLength(0);

  // During the read before the send: the intent stands, nothing is sent.
  const preSend = setup();
  preSend.world.onRead.set(2, advance(preSend.world));
  expect(await preSend.transport.deliver(request())).toMatchObject({
    code: 'STALE_GENERATION',
    effect: 'none',
    held: true,
    ok: false,
    phase: 'intent',
    retryAllowed: false,
  });
  expect(preSend.world.calls).toEqual(['read', 'write:intent', 'read']);
  expect(preSend.world.sent).toHaveLength(0);
  expect(stored(preSend.world).phase).toBe('intent');
  // The new generation cannot replay it: the intent is unresolved.
  expect(
    await preSend.transport.deliver(request({ generation: 2 }))
  ).toMatchObject({ code: 'DELIVERY_UNCERTAIN', held: true });
  expect(preSend.world.sent).toHaveLength(0);

  // During the read before Enter: the text stays pasted, Enter is not pressed.
  const preEnter = setup();
  preEnter.world.onRead.set(3, advance(preEnter.world));
  expect(await preEnter.transport.deliver(request())).toMatchObject({
    code: 'STALE_GENERATION',
    effect: 'pasted',
    held: true,
    ok: false,
    phase: 'text-sent',
    retryAllowed: false,
  });
  expect(preEnter.world.calls).not.toContain('enter');
  expect(preEnter.world.sent).toHaveLength(1);
  expect(preEnter.world.entered).toHaveLength(0);
  expect(stored(preEnter.world).phase).toBe('text-sent');
  expect(
    await preEnter.transport.deliver(request({ generation: 2 }))
  ).toMatchObject({ code: 'DELIVERY_UNCERTAIN', held: true });
  expect(preEnter.world.sent).toHaveLength(1);
  expect(preEnter.world.entered).toHaveLength(0);
});

test('the durable record is re-read after the last screen read, which stays the last observation before Enter', async () => {
  const { transport, world } = setup();
  await transport.deliver(request());
  expect(world.trace.slice(-4)).toEqual([
    'read',
    'load',
    'enter',
    'write:submitted',
  ]);
  expect(world.reads).toBe(3);
});

test('a phase conflict found while observing stops without a resend', async () => {
  const asHeld = (record) => {
    Object.assign(record, {
      heldAt: 1000,
      phase: 'held',
      reason: 'SEND_UNCERTAIN',
    });
  };
  const bumped = (record) => {
    record.deliveryAttempt = 2;
  };
  const cases = {
    afterIntentBumped: [2, bumped, 'none'],
    afterIntentHeld: [2, asHeld, 'none'],
    afterPasteBumped: [3, bumped, 'pasted'],
    afterPasteHeld: [3, asHeld, 'pasted'],
  };
  for (const [_name, [read, change, effect]] of Object.entries(cases)) {
    const { transport, world } = setup();
    world.onRead.set(read, () => change(stored(world)));
    // biome-ignore lint/performance/noAwaitInLoops: Sequential fixture checks must finish before the next mutation.
    const result = await transport.deliver(request());
    expect(result).toMatchObject({
      code: 'PHASE_CONFLICT',
      effect,
      held: true,
      ok: false,
      retryAllowed: false,
    });
    expect(world.entered).toHaveLength(0);
    expect(world.sent).toHaveLength(effect === 'pasted' ? 1 : 0);
  }

  // A record that vanished is also a conflict, never a reason to proceed.
  for (const read of [2, 3]) {
    const { transport, world } = setup();
    world.onRead.set(read, () => {
      world.store.records.clear();
    });
    // biome-ignore lint/performance/noAwaitInLoops: Sequential fixture checks must finish before the next mutation.
    expect(await transport.deliver(request())).toMatchObject({
      code: 'PHASE_CONFLICT',
      held: true,
    });
    expect(world.entered).toHaveLength(0);
  }
});

test('a phase conflict on the paste record stops before Enter and later calls never resend', async () => {
  const { transport, world } = setup();
  const send = world.impl.sendText;
  world.impl.sendText = async (args) => {
    const result = await send(args);
    // Another writer takes the record between the paste and its receipt.
    Object.assign(stored(world), {
      heldAt: 1000,
      phase: 'held',
      reason: 'SEND_UNCERTAIN',
    });
    return result;
  };
  expect(await transport.deliver(request())).toMatchObject({
    code: 'SEND_NOT_RECORDED',
    effect: 'pasted',
    held: true,
  });
  expect(world.entered).toHaveLength(0);
  expect((await transport.deliver(request())).code).toBe('DELIVERY_UNCERTAIN');
  expect(world.sent).toHaveLength(1);
  expect(world.entered).toHaveLength(0);
});

test('send and Enter receive the exact run, span, attempt, generation and assignment binding', async () => {
  const { transport, world } = setup();
  await transport.deliver(request());
  const binding = {
    assignmentDigest: DEFAULT.assignmentDigest,
    assignmentId: DEFAULT.assignmentId,
    attemptId: 'attempt-1',
    checkoutDigest: CHECKOUT,
    generation: 1,
    planVersion: 1,
    processStart: 'proc-100',
    runId: 'run-1',
    sessionId: 'session-1',
    spanId: 'span-a',
    surfaceId: 'surface-1',
    textDigest: DEFAULT.textDigest,
    workspaceId: 'workspace-1',
  };
  expect(world.entered[0]).toEqual(binding);
  expect(world.sent[0]).toEqual({ ...binding, text: DEFAULT.text });
});

test('the trusted adapter fences at the effect boundary: a generation that moves after the transport check still stops the send', async () => {
  const { transport, world } = setup();
  const send = world.impl.sendText;
  world.impl.sendText = (args) => {
    // After the transport's own check and before the effect.
    world.store.generation = 2;
    return send(args);
  };
  expect(await transport.deliver(request())).toMatchObject({
    code: 'SEND_REFUSED',
    effect: 'none',
    held: true,
    ok: false,
    phase: 'intent',
    retryAllowed: false,
  });
  expect(world.sent).toHaveLength(0);
  expect(world.surface.promptText).toBe('');
  expect(world.entered).toHaveLength(0);
});

test('the trusted adapter fences at the effect boundary: a generation that moves after the transport check still stops Enter', async () => {
  const { transport, world } = setup();
  const enter = world.impl.pressEnter;
  world.impl.pressEnter = (args) => {
    world.store.generation = 2;
    return enter(args);
  };
  expect(await transport.deliver(request())).toMatchObject({
    code: 'ENTER_REFUSED',
    effect: 'pasted',
    held: true,
    holdRecorded: false,
    ok: false,
  });
  expect(world.entered).toHaveLength(0);
  expect(stored(world).phase).toBe('text-sent');
});

test('a send that times out and completes late is held and never followed by Enter', async () => {
  const { transport, world } = setup();
  const send = world.impl.sendText;
  let finish = () => undefined;
  world.impl.sendText = (args) =>
    new Promise((resolve) => {
      finish = () => resolve(send(args));
    });
  expect(await transport.deliver(request())).toMatchObject({
    code: 'SEND_UNCERTAIN',
    effect: 'unknown',
    held: true,
    holdRecorded: true,
  });
  // The paste lands only after the timeout already produced the hold.
  finish();
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(world.sent).toHaveLength(1);
  expect(world.entered).toHaveLength(0);
  expect(stored(world)).toMatchObject({
    phase: 'held',
    reason: 'SEND_UNCERTAIN',
  });

  expect((await transport.deliver(request())).code).toBe('DELIVERY_UNCERTAIN');
  expect(world.sent).toHaveLength(1);
  expect(world.entered).toHaveLength(0);
});

test('an Enter that times out and completes late is held and never repeated', async () => {
  const { transport, world } = setup();
  const enter = world.impl.pressEnter;
  let finish = () => undefined;
  world.impl.pressEnter = (args) =>
    new Promise((resolve) => {
      finish = () => resolve(enter(args));
    });
  expect(await transport.deliver(request())).toMatchObject({
    code: 'ENTER_UNCERTAIN',
    effect: 'unknown',
    held: true,
  });
  finish();
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(world.entered).toHaveLength(1);
  expect(stored(world).phase).toBe('held');

  expect((await transport.deliver(request())).code).toBe('DELIVERY_UNCERTAIN');
  expect(world.sent).toHaveLength(1);
  expect(world.entered).toHaveLength(1);
});

test('the prompt is compared byte for byte before Enter: whitespace and Unicode form drift is a user edit', async () => {
  const content = 'Fix café now.\nThen report.';
  const drifts = {
    collapsedBlankLine: (text) => text.replace('\n\n[Spans', '\n[Spans'),
    cr: (text) => text.replaceAll('\n', '\r'),
    crlf: (text) => text.replaceAll('\n', '\r\n'),
    leadingSpace: (text) => ` ${text}`,
    nfd: (text) => text.normalize('NFD'),
    tabForSpace: (text) => text.replace(' ', '\t'),
    trailingNewline: (text) => `${text}\n`,
    trailingSpace: (text) => `${text} `,
    zeroWidth: (text) => `${text}​`,
  };
  for (const [_name, drift] of Object.entries(drifts)) {
    const { transport, world } = setup();
    world.onRead.set(3, (surface) => {
      const changed = drift(surface.promptText);
      expect(changed).not.toBe(surface.promptText);
      surface.promptText = changed;
    });
    // biome-ignore lint/performance/noAwaitInLoops: Sequential fixture checks must finish before the next mutation.
    const result = await transport.deliver(request({ content }));
    expect(result).toMatchObject({
      code: 'PROMPT_CHANGED',
      effect: 'pasted',
      held: true,
      ok: false,
    });
    expect(world.entered).toHaveLength(0);
    expect(stored(world)).toMatchObject({
      phase: 'held',
      reason: 'PROMPT_CHANGED',
    });
  }

  // Input is normalized once, when the text is built; a surface that shows
  // exactly that text passes, whatever the original spelling was.
  const { transport, world } = setup();
  const result = await transport.deliver(
    request({ content: ' Fix café now.\r\nThen report. \n' })
  );
  expect(result.ok).toBe(true);
  expect(world.sent[0].text.startsWith('Fix café now.\nThen report.\n\n')).toBe(
    true
  );
  expect(world.sent[0].text).not.toContain('\r');
});

test('only the explicitly bound newline convention is accepted, exactly', async () => {
  const showing = (fixtureWorld, convert) => {
    fixtureWorld.impl.sendText = (args) => {
      fixtureWorld.sent.push(structuredClone(args));
      fixtureWorld.surface.promptText = convert(args.text);
      return { ok: true };
    };
  };
  const crlf = (text) => text.replaceAll('\n', '\r\n');
  const cases = [
    // [promptNewline, how the surface renders the pasted text, ok]
    ['crlf', crlf, true],
    ['cr', (text) => text.replaceAll('\n', '\r'), true],
    ['lf', (text) => text, true],
    [undefined, (text) => text, true],
    // A convention that was not bound is drift, not something to normalize.
    ['lf', crlf, false],
    [undefined, crlf, false],
    ['crlf', (text) => text, false],
    ['crlf', (text) => text.replace('\n', '\r\n'), false],
    ['cr', crlf, false],
  ];
  for (const [promptNewline, convert, ok] of cases) {
    const world = createWorld();
    showing(world, convert);
    const transport = transportFor(world, { promptNewline });
    // biome-ignore lint/performance/noAwaitInLoops: Sequential fixture checks must finish before the next mutation.
    const result = await transport.deliver(request());
    expect(result.ok).toBe(ok);
    if (!ok) {
      expect(result.code).toBe('PROMPT_CHANGED');
      expect(world.entered).toHaveLength(0);
    }
  }

  const world = createWorld();
  for (const promptNewline of [
    'CRLF',
    '',
    'lf ',
    5,
    null,
    '__proto__',
    'toString',
  ]) {
    expect(() => transportFor(world, { promptNewline })).toThrow(TypeError);
  }
});

test('an unreadable target before Enter holds without pressing Enter', async () => {
  for (const mutate of [
    () => {
      throw new Error('socket closed');
    },
    () => hang(),
  ]) {
    const { transport, world } = setup();
    world.onRead.set(3, mutate);
    // biome-ignore lint/performance/noAwaitInLoops: Sequential fixture checks must finish before the next mutation.
    expect(await transport.deliver(request())).toMatchObject({
      code: 'TARGET_UNREADABLE',
      effect: 'pasted',
      held: true,
    });
    expect(world.entered).toHaveLength(0);
  }
});

// ---------------------------------------------------------------------------
// Ambiguous delivery and adapter failures
// ---------------------------------------------------------------------------

test('an adapter exception on send is not failure and not success: it holds and never resends', async () => {
  const { transport, world } = setup();
  world.impl.sendText = (args) => {
    world.sent.push(args);
    throw new Error(`pasted but then token=${SECRET}`);
  };
  const result = await transport.deliver(request());
  expect(result).toMatchObject({
    code: 'SEND_UNCERTAIN',
    effect: 'unknown',
    held: true,
    holdRecorded: true,
    ok: false,
    phase: 'held',
    retryAllowed: false,
  });
  expect(world.entered).toHaveLength(0);
  expect(stored(world)).toMatchObject({
    phase: 'held',
    reason: 'SEND_UNCERTAIN',
  });

  for (let call = 0; call < 3; call += 1) {
    // biome-ignore lint/performance/noAwaitInLoops: Sequential fixture checks must finish before the next mutation.
    expect(await transport.deliver(request())).toMatchObject({
      code: 'DELIVERY_UNCERTAIN',
      held: true,
      ok: false,
      retryAllowed: false,
    });
  }
  expect(world.sent).toHaveLength(1);
  expect(await transport.inspect(inspectInput())).toMatchObject({
    held: true,
    phase: 'held',
    retryAllowed: false,
  });
});

test('every non-explicit send answer is unknown, never success or proven failure', async () => {
  const answers = [
    undefined,
    null,
    'sent',
    {},
    { ok: 'yes' },
    { ok: false },
    { notSent: true },
    { notSent: 'true', ok: false },
    { notSent: 1, ok: false },
  ];
  for (const answer of answers) {
    const { transport, world } = setup();
    world.impl.sendText = async () => answer;
    // biome-ignore lint/performance/noAwaitInLoops: Sequential fixture checks must finish before the next mutation.
    const result = await transport.deliver(request());
    expect(result).toMatchObject({
      code: 'SEND_UNCERTAIN',
      held: true,
      retryAllowed: false,
    });
    expect(world.entered).toHaveLength(0);
  }
});

test('a hung send times out as unknown and holds', async () => {
  const { transport, world } = setup();
  world.impl.sendText = hang;
  expect(await transport.deliver(request())).toMatchObject({
    code: 'SEND_UNCERTAIN',
    effect: 'unknown',
    held: true,
  });
  expect(world.entered).toHaveLength(0);
});

test('an adapter that proves the text was not sent records unsent', async () => {
  const { transport, world } = setup();
  world.impl.sendText = async () => ({ notSent: true, ok: false });
  expect(await transport.deliver(request())).toMatchObject({
    code: 'SEND_REFUSED',
    effect: 'none',
    held: false,
    retryAllowed: true,
  });
  expect(stored(world)).toMatchObject({
    phase: 'unsent',
    reason: 'SEND_REFUSED',
  });
});

test('an ambiguous Enter holds, is not repeated, and an exact ack resolves it without a receipt', async () => {
  const { transport, world } = setup();
  world.impl.pressEnter = (args) => {
    world.entered.push(args);
    throw new Error('timeout talking to cmux');
  };
  expect(await transport.deliver(request())).toMatchObject({
    code: 'ENTER_UNCERTAIN',
    effect: 'unknown',
    held: true,
    ok: false,
  });
  expect(stored(world)).toMatchObject({
    phase: 'held',
    reason: 'ENTER_UNCERTAIN',
  });
  expect((await transport.deliver(request())).code).toBe('DELIVERY_UNCERTAIN');
  expect(world.entered).toHaveLength(1);
  expect(world.sent).toHaveLength(1);

  const ack = await transport.acknowledge(ackFor(), trusted());
  expect(ack).toMatchObject({
    acknowledged: true,
    ok: true,
    transportReceipt: false,
  });
  expect(stored(world)).toMatchObject({ phase: 'acknowledged', reason: null });
});

test('a refused Enter keeps the text in the prompt, holds, and blocks later deliveries to that surface', async () => {
  const { transport, world } = setup();
  world.impl.pressEnter = async () => ({ notPressed: true, ok: false });
  expect(await transport.deliver(request())).toMatchObject({
    code: 'ENTER_REFUSED',
    effect: 'pasted',
    held: true,
  });
  // A different assignment must not stack on the pasted text.
  const other = await transport.deliver(request({ attemptId: 'attempt-2' }));
  expect(other).toMatchObject({ code: 'PROMPT_NOT_EMPTY', ok: false });
  expect(world.sent).toHaveLength(1);
});

test('a hung Enter holds as unknown', async () => {
  const { transport, world } = setup();
  world.impl.pressEnter = hang;
  expect(await transport.deliver(request())).toMatchObject({
    code: 'ENTER_UNCERTAIN',
    held: true,
  });
  expect(world.sent).toHaveLength(1);
});

test('a hold that cannot be saved is reported and the saved phase keeps the assignment held', async () => {
  const { transport, world } = setup();
  world.store.fail = { mode: 'reject', phase: 'held' };
  world.impl.sendText = () => {
    throw new Error('boom');
  };
  expect(await transport.deliver(request())).toMatchObject({
    code: 'SEND_UNCERTAIN',
    held: true,
    holdRecorded: false,
    phase: 'intent',
  });
  expect((await transport.deliver(request())).code).toBe('DELIVERY_UNCERTAIN');
  expect(world.sent).toHaveLength(0);
});

// ---------------------------------------------------------------------------
// Persistence failures
// ---------------------------------------------------------------------------

test('if the intent is not saved nothing is sent', async () => {
  const rejected = setup();
  rejected.world.store.fail = { mode: 'reject', phase: 'intent' };
  expect(await rejected.transport.deliver(request())).toMatchObject({
    code: 'INTENT_NOT_RECORDED',
    effect: 'none',
    held: false,
    retryAllowed: true,
  });

  const thrown = setup();
  thrown.world.store.fail = { mode: 'throw', phase: 'intent' };
  const result = await thrown.transport.deliver(request());
  expect(result).toMatchObject({
    code: 'INTENT_NOT_RECORDED',
    effect: 'none',
    held: true,
    recordUncertain: true,
    retryAllowed: false,
  });
  expect(JSON.stringify(result)).not.toContain(SECRET);

  for (const { world } of [rejected, thrown]) {
    expect(world.sent).toHaveLength(0);
    expect(world.entered).toHaveLength(0);
  }
});

test('an intent that committed before its response was lost blocks a send on retry', async () => {
  const { transport, world } = setup();
  world.store.fail = { mode: 'throw-after-commit', phase: 'intent' };
  expect((await transport.deliver(request())).code).toBe('INTENT_NOT_RECORDED');
  world.store.fail = null;
  expect(await transport.deliver(request())).toMatchObject({
    code: 'DELIVERY_UNCERTAIN',
    held: true,
  });
  expect(world.sent).toHaveLength(0);
});

test('if the paste cannot be recorded, Enter is not pressed', async () => {
  const { transport, world } = setup();
  world.store.fail = { mode: 'reject', phase: 'text-sent' };
  expect(await transport.deliver(request())).toMatchObject({
    code: 'SEND_NOT_RECORDED',
    effect: 'pasted',
    held: true,
    retryAllowed: false,
  });
  expect(world.entered).toHaveLength(0);
  expect((await transport.deliver(request())).code).toBe('DELIVERY_UNCERTAIN');
  expect(world.sent).toHaveLength(1);
});

test('if the receipt cannot be recorded after Enter the assignment is held, not resent', async () => {
  const { transport, world } = setup();
  world.store.fail = { mode: 'throw', phase: 'submitted' };
  expect(await transport.deliver(request())).toMatchObject({
    code: 'RECEIPT_NOT_RECORDED',
    effect: 'submitted',
    held: true,
    ok: false,
    retryAllowed: false,
  });
  world.store.fail = null;
  expect((await transport.deliver(request())).code).toBe('DELIVERY_UNCERTAIN');
  expect(world.sent).toHaveLength(1);
  expect(world.entered).toHaveLength(1);
  expect(stored(world).phase).toBe('text-sent');
  expect(await transport.acknowledge(ackFor(), trusted())).toMatchObject({
    ok: true,
    transportReceipt: false,
  });
});

test('an ack that cannot be saved is reported and leaves the record unchanged', async () => {
  const { transport, world } = setup();
  await transport.deliver(request());
  world.store.fail = { mode: 'throw', phase: 'acknowledged' };
  const result = await transport.acknowledge(ackFor(), trusted());
  expect(result).toMatchObject({ code: 'ACK_NOT_RECORDED', ok: false });
  expect(JSON.stringify(result)).not.toContain(SECRET);
  expect(stored(world).phase).toBe('submitted');
});

// ---------------------------------------------------------------------------
// Duplicates, restarts and changed input
// ---------------------------------------------------------------------------

test('a repeated call returns the existing delivery without touching the surface again', async () => {
  const { transport, world } = setup();
  const first = await transport.deliver(request());
  const readsAfterFirst = world.reads;
  const second = await transport.deliver(request());

  expect(second).toMatchObject({
    assignmentDigest: first.assignmentDigest,
    duplicate: true,
    ok: true,
    phase: 'submitted',
  });
  expect(world.reads).toBe(readsAfterFirst);
  expect(world.sent).toHaveLength(1);
  expect(world.entered).toHaveLength(1);
});

test('concurrent calls on one transport deliver once', async () => {
  const { transport, world } = setup();
  const results = await Promise.all([
    transport.deliver(request()),
    transport.deliver(request()),
  ]);
  expect(
    results.filter((result) => result.ok && !result.duplicate)
  ).toHaveLength(1);
  expect(results.map((result) => result.code).filter(Boolean)).toEqual([
    'DELIVERY_IN_PROGRESS',
  ]);
  expect(world.sent).toHaveLength(1);
  expect(world.entered).toHaveLength(1);
});

test('two transports over one store deliver once, decided by compare-and-set', async () => {
  const world = createWorld();
  const first = transportFor(world);
  const second = transportFor(world);
  const results = await Promise.all([
    first.deliver(request()),
    second.deliver(request()),
  ]);
  expect(
    results.filter((result) => result.ok && !result.duplicate)
  ).toHaveLength(1);
  expect(world.sent).toHaveLength(1);
  expect(world.entered).toHaveLength(1);
});

test('a restarted transport sees the stored phase: delivered stays delivered, held stays held', async () => {
  const delivered = createWorld();
  await transportFor(delivered).deliver(request());
  expect(await transportFor(delivered).deliver(request())).toMatchObject({
    duplicate: true,
    ok: true,
  });
  expect(delivered.sent).toHaveLength(1);

  const held = createWorld();
  held.impl.sendText = () => {
    throw new Error('lost');
  };
  await transportFor(held).deliver(request());
  held.impl.sendText = (args) => {
    held.sent.push(args);
    return { ok: true };
  };
  expect((await transportFor(held).deliver(request())).code).toBe(
    'DELIVERY_UNCERTAIN'
  );
  expect(held.sent).toHaveLength(0);
});

test('the same assignment ID with different content or target is a conflict and sends nothing', async () => {
  const { transport, world } = setup();
  await transport.deliver(request({ assignmentId: 'assignment-fixed' }));
  const changes = [
    request({
      assignmentId: 'assignment-fixed',
      content: 'A different brief.',
    }),
    request({
      assignmentId: 'assignment-fixed',
      target: target({ surfaceId: 'surface-2' }),
    }),
    request({
      assignmentId: 'assignment-fixed',
      target: target({ sessionId: 'session-2' }),
    }),
    request({
      assignmentId: 'assignment-fixed',
      target: target({ checkoutDigest: OTHER_CHECKOUT }),
    }),
    request({ assignmentId: 'assignment-fixed', attemptId: 'attempt-9' }),
    request({ assignmentId: 'assignment-fixed', planVersion: 2 }),
  ];
  for (const change of changes) {
    // biome-ignore lint/performance/noAwaitInLoops: Sequential fixture checks must finish before the next mutation.
    expect(await transport.deliver(change)).toMatchObject({
      code: 'ASSIGNMENT_CONFLICT',
      ok: false,
    });
  }
  expect(world.sent).toHaveLength(1);

  // The derived ID has the same property: same attempt, different content.
  // The first delivery left the surface busy; free it for the next assignment.
  world.surface.state = 'idle';
  world.surface.promptText = '';
  expect(
    await transport.deliver(
      request({ content: 'Changed brief for attempt-1.' })
    )
  ).toMatchObject({ ok: true });
  expect(
    await transport.deliver(
      request({ content: 'Another change to attempt-1.' })
    )
  ).toMatchObject({ code: 'ASSIGNMENT_CONFLICT' });
});

// ---------------------------------------------------------------------------
// Generations
// ---------------------------------------------------------------------------

test('a stale generation is refused before any adapter touches the surface', async () => {
  const { transport, world } = setup();
  world.store.generation = 2;
  expect(await transport.deliver(request({ generation: 1 }))).toMatchObject({
    code: 'STALE_GENERATION',
    ok: false,
  });
  expect(
    await transport.acknowledge(ackFor(), trusted({ generation: 1 }))
  ).toMatchObject({
    code: 'STALE_GENERATION',
  });
  expect(
    await transport.inspect(inspectInput({ generation: 3 }))
  ).toMatchObject({
    code: 'STALE_GENERATION',
  });
  expect(world.calls).toEqual([]);
});

test('a generation fenced out mid-delivery stops before Enter', async () => {
  const { transport, world } = setup();
  const send = world.impl.sendText;
  world.impl.sendText = async (args) => {
    const result = await send(args);
    world.store.generation = 2;
    return result;
  };
  expect(await transport.deliver(request())).toMatchObject({
    code: 'SEND_NOT_RECORDED',
    effect: 'pasted',
    held: true,
  });
  expect(world.entered).toHaveLength(0);
});

test('a new coordinator generation cannot acknowledge an earlier unresolved delivery', async () => {
  const { transport, world } = setup();
  world.impl.sendText = () => {
    throw new Error('lost');
  };
  await transport.deliver(request());
  world.store.generation = 2;
  world.impl.sendText = (args) => {
    world.sent.push(args);
    return { ok: true };
  };
  expect(await transport.deliver(request({ generation: 2 }))).toMatchObject({
    code: 'DELIVERY_UNCERTAIN',
    held: true,
  });
  expect(world.sent).toHaveLength(0);
  const writesBeforeAck = world.store.writes.length;
  expect(
    await transport.acknowledge(ackFor(), trusted({ generation: 2 }))
  ).toMatchObject({ code: 'STALE_GENERATION', ok: false });
  expect(world.store.writes).toHaveLength(writesBeforeAck);
  expect(stored(world)).toMatchObject({ generation: 1, phase: 'held' });
  expect(
    await transport.inspect(inspectInput({ generation: 2 }))
  ).toMatchObject({
    found: true,
    held: true,
    ok: true,
    phase: 'held',
  });
  expect(world.store.writes).toHaveLength(writesBeforeAck);
});

test('a new coordinator generation rejects stale submitted and duplicate acknowledged records', async () => {
  const submitted = setup();
  await submitted.transport.deliver(request());
  submitted.world.store.generation = 2;
  const submittedWrites = submitted.world.store.writes.length;
  expect(
    await submitted.transport.acknowledge(ackFor(), trusted({ generation: 2 }))
  ).toMatchObject({ code: 'STALE_GENERATION', ok: false });
  expect(submitted.world.store.writes).toHaveLength(submittedWrites);
  expect(stored(submitted.world)).toMatchObject({
    generation: 1,
    phase: 'submitted',
  });

  const acknowledged = setup();
  await acknowledged.transport.deliver(request());
  await acknowledged.transport.acknowledge(ackFor(), trusted());
  acknowledged.world.store.generation = 2;
  const acknowledgedWrites = acknowledged.world.store.writes.length;
  expect(
    await acknowledged.transport.acknowledge(
      ackFor(),
      trusted({ generation: 2 })
    )
  ).toMatchObject({ code: 'STALE_GENERATION', ok: false });
  expect(acknowledged.world.store.writes).toHaveLength(acknowledgedWrites);
  expect(stored(acknowledged.world)).toMatchObject({
    generation: 1,
    phase: 'acknowledged',
  });
});

test('a stored record newer than the request generation is stale', async () => {
  const { transport, world } = setup();
  await transport.deliver(request());
  world.store.records.get(`run-1/${DEFAULT.assignmentId}`).generation = 5;
  expect(await transport.deliver(request())).toMatchObject({
    code: 'STALE_GENERATION',
  });
});

// ---------------------------------------------------------------------------
// Stored record and persist adapter validation
// ---------------------------------------------------------------------------

test('a tampered or malformed stored record is refused and nothing is sent', async () => {
  const tampers = {
    badDigest: (record) => {
      record.assignmentDigest = 'e'.repeat(64);
    },
    badPhase: (record) => {
      record.phase = 'approved';
    },
    extraField: (record) => {
      record.approved = true;
    },
    foreignRun: (record) => {
      record.runId = 'run-2';
    },
    heldWithoutReason: (record) => {
      record.phase = 'held';
      record.reason = null;
    },
    reboundSession: (record) => {
      record.binding.sessionId = 'session-9';
    },
    submittedWithoutReceipt: (record) => {
      record.phase = 'submitted';
      record.transportReceipt = false;
    },
    zeroAttempt: (record) => {
      record.deliveryAttempt = 0;
    },
  };
  for (const [_name, tamper] of Object.entries(tampers)) {
    const { transport, world } = setup();
    world.impl.sendText = () => {
      throw new Error('lost');
    };
    // biome-ignore lint/performance/noAwaitInLoops: Sequential fixture checks must finish before the next mutation.
    await transport.deliver(request());
    tamper(stored(world));
    world.impl.sendText = (args) => {
      world.sent.push(args);
      return { ok: true };
    };
    expect(await transport.deliver(request())).toMatchObject({
      code: 'RECORD_INVALID',
      ok: false,
    });
    expect(await transport.acknowledge(ackFor(), trusted())).toMatchObject({
      code: 'RECORD_INVALID',
    });
    expect(world.sent).toHaveLength(0);
  }
});

test('an unusable persist read blocks delivery', async () => {
  const answers = {
    missingGeneration: async () => ({ ok: true, record: null }),
    notOk: async () => ({ ok: false }),
    throws: () => {
      throw new Error(`db ${SECRET}`);
    },
    undefinedRecord: async () => ({
      generation: 1,
      ok: true,
      record: undefined,
    }),
  };
  for (const [_name, read] of Object.entries(answers)) {
    const { transport, world } = setup();
    world.impl.persist = read;
    // biome-ignore lint/performance/noAwaitInLoops: Sequential fixture checks must finish before the next mutation.
    const result = await transport.deliver(request());
    expect(result.ok).toBe(false);
    expect(['RECORD_INVALID', 'RECORD_READ_FAILED']).toContain(result.code);
    expect(JSON.stringify(result)).not.toContain(SECRET);
    expect(world.calls).toEqual([]);
  }
  const { transport, world } = setup();
  world.impl.persist = hang;
  expect((await transport.deliver(request())).code).toBe('RECORD_READ_FAILED');
  expect(world.sent).toHaveLength(0);
});

test('persist writes carry store-valid event envelopes and only digests of the content', async () => {
  const { transport, world } = setup();
  await transport.deliver(request());

  const phases = world.store.writes.map((write) => write.record.phase);
  expect(phases).toEqual(['intent', 'text-sent', 'submitted']);
  const ids = new Set();
  for (const write of world.store.writes) {
    expect(Object.keys(write.event).sort()).toEqual([
      'eventId',
      'payload',
      'runId',
      'type',
    ]);
    expect(write.event.eventId).toMatch(EVENT_ID);
    expect(write.event.eventId).toMatch(STORE_IDENTIFIER);
    expect(write.event.type).toBe('spans.cmux.delivery');
    expect(write.event.runId).toBe('run-1');
    expect(write.event.payload).toEqual(write.record);
    expect(write.generation).toBe(1);
    ids.add(write.event.eventId);
  }
  expect(ids.size).toBe(3);
  expect(world.store.writes[0].expected).toBeNull();
  expect(world.store.writes[1].expected).toEqual({
    deliveryAttempt: 1,
    phase: 'intent',
  });
  expect(world.store.writes[2].expected).toEqual({
    deliveryAttempt: 1,
    phase: 'text-sent',
  });

  const persisted = JSON.stringify(world.store.writes);
  expect(persisted).not.toContain('Implement the parser');
  expect(persisted).not.toContain('Report back');
  expect(stored(world)).toMatchObject({
    contentDigest: DEFAULT.contentDigest,
    textDigest: DEFAULT.textDigest,
  });
});

// ---------------------------------------------------------------------------
// Secrets
// ---------------------------------------------------------------------------

test('content that looks like a credential is refused before any adapter or store is touched', async () => {
  const contents = [
    `Use key ${SECRET} to call the API.`,
    'Set password: hunter2hunter2 and continue.',
    'Authorization: Bearer abcdefghijklmnop1234',
    '-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkq\n-----END PRIVATE KEY-----',
    'api_key = "abc123def456"',
  ];
  for (const content of contents) {
    const { transport, world } = setup();
    // biome-ignore lint/performance/noAwaitInLoops: Sequential fixture checks must finish before the next mutation.
    const result = await transport.deliver(request({ content }));
    expect(result).toMatchObject({ code: 'SENSITIVE_VALUE', ok: false });
    expect(JSON.stringify(result)).not.toContain('hunter2');
    expect(world.calls).toEqual([]);
    expect(world.store.writes).toHaveLength(0);
  }
});

test('identifiers that look like credentials are refused everywhere they are accepted', async () => {
  const { transport, world } = setup();
  const cases = [
    request({ attemptId: `token=${SECRET}` }),
    request({ runId: SECRET }),
    request({ spanId: SECRET }),
    request({ assignmentId: SECRET }),
    request({ planVersion: SECRET }),
    request({ target: target({ sessionId: SECRET }) }),
    request({ target: target({ processStart: `password: ${SECRET}` }) }),
  ];
  for (const input of cases) {
    // biome-ignore lint/performance/noAwaitInLoops: Sequential fixture checks must finish before the next mutation.
    const result = await transport.deliver(input);
    expect(result.code).toBe('SENSITIVE_VALUE');
    expect(JSON.stringify(result)).not.toContain(SECRET);
  }
  expect(
    await transport.acknowledge(ackFor(), trusted({ sessionId: SECRET }))
  ).toMatchObject({
    code: 'SENSITIVE_VALUE',
  });
  expect(world.calls).toEqual([]);
});

const leaked = (world, result) =>
  JSON.stringify([result, world.store.writes, [...world.store.records]]);

test('a throwing Enter holds as uncertain, and its error text never reaches results or the store', async () => {
  const { transport, world } = setup();
  // A faithful surface: it reports exactly the text that was pasted, plus an
  // extra field that must be ignored, never copied.
  world.surface.screen = `secret screen ${SECRET}`;
  world.impl.pressEnter = () => {
    throw new Error(`enter failed with ${SECRET}`);
  };
  const result = await transport.deliver(request());
  expect(result).toMatchObject({
    code: 'ENTER_UNCERTAIN',
    effect: 'unknown',
    held: true,
    holdRecorded: true,
    retryAllowed: false,
  });
  expect(world.sent).toHaveLength(1);
  expect(leaked(world, result)).not.toContain(SECRET);
  expect(leaked(world, result)).not.toContain('secret screen');
});

test('a prompt that does not show the sent text refuses Enter, and screen contents never reach results or the store', async () => {
  // The surface keeps reporting an empty prompt even after the paste: the
  // guard must refuse Enter (PROMPT_CHANGED), not wave it through.
  const stale = setup();
  stale.world.impl.readTarget = async () => ({
    ok: true,
    ...target(),
    promptText: '',
    screen: `secret screen ${SECRET}`,
    state: 'idle',
  });
  let enterCalls = 0;
  stale.world.impl.pressEnter = () => {
    enterCalls += 1;
    throw new Error(`must not be reached ${SECRET}`);
  };
  const staleResult = await stale.transport.deliver(request());
  expect(staleResult).toMatchObject({
    code: 'PROMPT_CHANGED',
    effect: 'pasted',
    held: true,
    holdRecorded: true,
    retryAllowed: false,
  });
  expect(enterCalls).toBe(0);
  expect(leaked(stale.world, staleResult)).not.toContain(SECRET);
  expect(leaked(stale.world, staleResult)).not.toContain('secret screen');

  // A prompt that gained a secret is refused and the secret is not copied.
  const typed = setup();
  typed.world.onRead.set(3, (surface) => {
    surface.promptText += ` ${SECRET}`;
  });
  const typedResult = await typed.transport.deliver(request());
  expect(typedResult).toMatchObject({ code: 'PROMPT_CHANGED', held: true });
  expect(typed.world.entered).toHaveLength(0);
  expect(leaked(typed.world, typedResult)).not.toContain(SECRET);
});

// ---------------------------------------------------------------------------
// Text normalization and bounds
// ---------------------------------------------------------------------------

test('content that could drive the terminal is refused', async () => {
  const unsafe = {
    bell: 'a\u0007b',
    bidi: 'a‮b',
    bom: 'a﻿b',
    c1: 'a\u0085b',
    del: 'a\u007fb',
    escape: '\u001b[31mred',
    lineSeparator: 'a\u2028b',
    loneSurrogate: 'a\ud800b',
    nul: 'a\u0000b',
    shellPrefix: '!rm -rf .',
    slashPrefix: '/clear',
    slashPrefixAfterSpace: '   \n /logout',
    tag: 'a\u{e0041}b',
    zeroWidth: 'a​b',
  };
  const { transport, world } = setup();
  for (const [_name, content] of Object.entries(unsafe)) {
    // biome-ignore lint/performance/noAwaitInLoops: Sequential fixture checks must finish before the next mutation.
    const result = await transport.deliver(request({ content }));
    expect(result).toMatchObject({ code: 'CONTENT_UNSAFE', ok: false });
  }
  expect(world.calls).toEqual([]);
});

test('content is normalized deterministically and bounded', () => {
  const base = prepareSpansAssignment(
    request({ content: 'line one\nline two' }),
    LIMITS
  );
  for (const content of [
    'line one\r\nline two',
    'line one\rline two',
    '\n line one\nline two \n\n',
  ]) {
    const variant = prepareSpansAssignment(request({ content }), LIMITS);
    expect(variant.contentDigest).toBe(base.contentDigest);
    expect(variant.text).not.toContain('\r');
  }
  expect(base.text.startsWith('line one\nline two\n\n[Spans assignment ')).toBe(
    true
  );
  expect(
    prepareSpansAssignment(request({ content: 'Fix café' }), LIMITS)
      .contentDigest
  ).toBe(
    prepareSpansAssignment(request({ content: 'Fix café' }), LIMITS)
      .contentDigest
  );

  const invalid = [
    ['', 'CONTENT_INVALID'],
    ['   \n\t ', 'CONTENT_INVALID'],
    [null, 'CONTENT_INVALID'],
    [5, 'CONTENT_INVALID'],
    ['a'.repeat(2049), 'CONTENT_TOO_LARGE'],
    ['é'.repeat(1025), 'CONTENT_TOO_LARGE'],
    [`${'x\n'.repeat(20)}x`, 'CONTENT_TOO_LARGE'],
  ];
  for (const [content, code] of invalid) {
    expect(prepareSpansAssignment(request({ content }), LIMITS).code).toBe(
      code
    );
  }
  expect(
    prepareSpansAssignment(request({ content: 'a'.repeat(2048) }), LIMITS).ok
  ).toBe(true);
  expect(
    prepareSpansAssignment(request({ content: `${'x\n'.repeat(19)}x` }), LIMITS)
      .ok
  ).toBe(true);
});

// ---------------------------------------------------------------------------
// Stable identity
// ---------------------------------------------------------------------------

test('assignment IDs and digests are stable and bind every input', () => {
  const again = prepareSpansAssignment(request(), LIMITS);
  expect(again).toMatchObject({
    ackCode: DEFAULT.ackCode,
    assignmentDigest: DEFAULT.assignmentDigest,
    assignmentId: DEFAULT.assignmentId,
    textDigest: DEFAULT.textDigest,
  });
  expect(DEFAULT.ackCode).toMatch(ACK_CODE_PATTERN);
  expect(DEFAULT.assignmentId).toMatch(STORE_IDENTIFIER);

  // The derived ID is quotable before the brief exists: it ignores content and target.
  expect(
    prepareSpansAssignment(request({ content: 'Other.' }), LIMITS).assignmentId
  ).toBe(DEFAULT.assignmentId);
  expect(
    prepareSpansAssignment(
      request({ target: target({ surfaceId: 'surface-2' }) }),
      LIMITS
    ).assignmentId
  ).toBe(DEFAULT.assignmentId);
  for (const change of [
    { attemptId: 'attempt-2' },
    { spanId: 'span-b' },
    { runId: 'run-2' },
    { planVersion: 2 },
  ]) {
    expect(
      prepareSpansAssignment(request(change), LIMITS).assignmentId
    ).not.toBe(DEFAULT.assignmentId);
  }

  // The digest binds content and every target field.
  const digests = new Set([DEFAULT.assignmentDigest]);
  for (const changed of [
    request({ content: 'Other.' }),
    ...TARGET_FIELDS.map((field) =>
      request({
        target: target({
          [field]: field === 'checkoutDigest' ? OTHER_CHECKOUT : 'other',
        }),
      })
    ),
  ]) {
    digests.add(prepareSpansAssignment(changed, LIMITS).assignmentDigest);
  }
  expect(digests.size).toBe(7);
  expect(
    prepareSpansAssignment(request({ assignmentId: 'assign-explicit' }), LIMITS)
      .assignmentId
  ).toBe('assign-explicit');
  // Generation fences a call; it is not part of the assignment's identity.
  expect(
    prepareSpansAssignment(request({ generation: 9 }), LIMITS).assignmentDigest
  ).toBe(DEFAULT.assignmentDigest);
  // The sha256: spelling of a digest is the same digest.
  expect(
    prepareSpansAssignment(
      request({ target: target({ checkoutDigest: `sha256:${CHECKOUT}` }) }),
      LIMITS
    ).assignmentDigest
  ).toBe(DEFAULT.assignmentDigest);
});

// ---------------------------------------------------------------------------
// Hostile input and construction
// ---------------------------------------------------------------------------

test('malformed and malicious requests are refused before any adapter call', async () => {
  const { transport, world } = setup();
  const getter = request();
  Object.defineProperty(getter, 'content', {
    enumerable: true,
    get() {
      throw new Error('getter');
    },
  });
  const symbolKey = request();
  symbolKey[Symbol('x')] = 1;
  class Request {}
  const instance = Object.assign(new Request(), request());
  const proxy = new Proxy(request(), {
    ownKeys() {
      throw new Error('trap');
    },
  });
  const cases = [
    [null, 'REQUEST_INVALID'],
    [undefined, 'REQUEST_INVALID'],
    [[], 'REQUEST_INVALID'],
    ['text', 'REQUEST_INVALID'],
    [getter, 'REQUEST_INVALID'],
    [symbolKey, 'REQUEST_INVALID'],
    [instance, 'REQUEST_INVALID'],
    [proxy, 'REQUEST_INVALID'],
    [JSON.parse('{"__proto__":{"polluted":true}}'), 'REQUEST_INVALID'],
    [request({ target: undefined }), 'REQUEST_INVALID'],
    [request({ target: [] }), 'REQUEST_INVALID'],
    [request({ target: { ...target(), extra: 1 } }), 'REQUEST_INVALID'],
    [{ ...request(), approved: true }, 'REQUEST_INVALID'],
    [{ ...request(), approval: { by: 'user' } }, 'REQUEST_INVALID'],
    [{ ...request(), imported: true }, 'REQUEST_INVALID'],
    [{ ...request(), historical: true }, 'REQUEST_INVALID'],
    [{ ...request(), force: true }, 'REQUEST_INVALID'],
    [{ ...request(), spanId: undefined }, 'ID_INVALID'],
    [request({ runId: '' }), 'ID_INVALID'],
    [request({ runId: ' padded ' }), 'ID_INVALID'],
    [request({ runId: 'a\nb' }), 'ID_INVALID'],
    [request({ runId: 'a\tb' }), 'ID_INVALID'],
    [request({ runId: 'run‮1' }), 'ID_INVALID'],
    [request({ runId: 'x'.repeat(129) }), 'ID_INVALID'],
    [request({ runId: 5 }), 'ID_INVALID'],
    [request({ attemptId: '__proto__' }), 'ID_INVALID'],
    [request({ assignmentId: '' }), 'ID_INVALID'],
    [request({ target: target({ surfaceId: '' }) }), 'ID_INVALID'],
    [request({ target: target({ workspaceId: 7 }) }), 'ID_INVALID'],
    [request({ generation: -1 }), 'GENERATION_INVALID'],
    [request({ generation: 1.5 }), 'GENERATION_INVALID'],
    [request({ generation: '1' }), 'GENERATION_INVALID'],
    [request({ generation: Number.NaN }), 'GENERATION_INVALID'],
    [
      request({ generation: Number.MAX_SAFE_INTEGER + 1 }),
      'GENERATION_INVALID',
    ],
    [request({ planVersion: -1 }), 'PLAN_VERSION_INVALID'],
    [request({ planVersion: 1.5 }), 'PLAN_VERSION_INVALID'],
    [request({ planVersion: {} }), 'PLAN_VERSION_INVALID'],
    [request({ target: target({ checkoutDigest: 'xyz' }) }), 'DIGEST_INVALID'],
    [
      request({ target: target({ checkoutDigest: 'C'.repeat(64) }) }),
      'DIGEST_INVALID',
    ],
    [request({ ackWithinMs: 0 }), 'ACK_WINDOW_INVALID'],
    [request({ ackWithinMs: -5 }), 'ACK_WINDOW_INVALID'],
    [request({ ackWithinMs: 1.5 }), 'ACK_WINDOW_INVALID'],
    [request({ ackWithinMs: 86_400_001 }), 'ACK_WINDOW_INVALID'],
    [request({ ackWithinMs: '5000' }), 'ACK_WINDOW_INVALID'],
  ];
  for (const [input, code] of cases) {
    // biome-ignore lint/performance/noAwaitInLoops: Sequential fixture checks must finish before the next mutation.
    const result = await transport.deliver(input);
    expect(result).toMatchObject({ code, ok: false });
    expect(typeof result.error).toBe('string');
  }
  expect({}.polluted).toBeUndefined();
  expect(world.calls).toEqual([]);
  expect(world.store.writes).toHaveLength(0);
});

test('malformed inspect requests are refused', async () => {
  const { transport, world } = setup();
  for (const input of [
    null,
    {},
    { ...inspectInput(), extra: 1 },
    inspectInput({ runId: '' }),
    inspectInput({ generation: -1 }),
  ]) {
    // biome-ignore lint/performance/noAwaitInLoops: Sequential fixture checks must finish before the next mutation.
    expect((await transport.inspect(input)).ok).toBe(false);
  }
  expect(await transport.inspect(inspectInput())).toEqual({
    assignmentId: DEFAULT.assignmentId,
    found: false,
    ok: true,
  });
  expect(world.calls).toEqual([]);
});

test('an unusable clock refuses before any adapter call', async () => {
  for (const now of [
    () => -1,
    () => Number.NaN,
    () => '1',
    () => {
      throw new Error('clock');
    },
  ]) {
    const { transport, world } = setup({ now });
    // biome-ignore lint/performance/noAwaitInLoops: Sequential fixture checks must finish before the next mutation.
    expect(await transport.deliver(request())).toMatchObject({
      code: 'CLOCK_INVALID',
      ok: false,
    });
    expect(world.calls).toEqual([]);
  }
});

test('construction requires every adapter and explicit bounded limits, with no defaults', () => {
  const world = createWorld();
  const adapters = {
    persist: world.impl.persist,
    pressEnter: world.impl.pressEnter,
    readTarget: world.impl.readTarget,
    sendText: world.impl.sendText,
  };
  expect(() => createSpansCmuxTransport()).toThrow(TypeError);
  expect(() => createSpansCmuxTransport({ ...adapters })).toThrow(TypeError);
  for (const name of Object.keys(adapters)) {
    expect(() =>
      createSpansCmuxTransport({
        ...adapters,
        [name]: undefined,
        limits: LIMITS,
      })
    ).toThrow(TypeError);
  }
  expect(() =>
    createSpansCmuxTransport({ ...adapters, limits: LIMITS, now: 'now' })
  ).toThrow(TypeError);
  for (const name of Object.keys(LIMITS)) {
    for (const bad of [
      undefined,
      0,
      -1,
      1.5,
      '10',
      Number.POSITIVE_INFINITY,
      10_000_000,
    ]) {
      expect(() =>
        createSpansCmuxTransport({
          ...adapters,
          limits: { ...LIMITS, [name]: bad },
        })
      ).toThrow(TypeError);
    }
  }
  expect(() =>
    createSpansCmuxTransport({ ...adapters, limits: LIMITS })
  ).not.toThrow();
  expect(prepareSpansAssignment(request(), undefined)).toMatchObject({
    code: 'LIMITS_INVALID',
    ok: false,
  });
});

test('the transport exposes only deliver, acknowledge and inspect, so stored state can never trigger a send by itself', () => {
  const { transport } = setup();
  expect(Object.keys(transport).sort()).toEqual([
    'acknowledge',
    'deliver',
    'inspect',
  ]);
  expect(Object.isFrozen(transport)).toBe(true);
});

test('inspect reads only the store: it never touches the surface or writes', async () => {
  const { transport, world } = setup();
  world.impl.sendText = () => {
    throw new Error('lost');
  };
  await transport.deliver(request());
  const calls = world.calls.length;
  const writes = world.store.writes.length;
  expect(await transport.inspect(inspectInput())).toMatchObject({
    ackStatus: 'unknown',
    held: true,
    phase: 'held',
    reason: 'SEND_UNCERTAIN',
    retryAllowed: false,
  });
  expect(world.calls).toHaveLength(calls);
  expect(world.store.writes).toHaveLength(writes);
});
