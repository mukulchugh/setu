import { expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createSpansActions } from './spans-actions.js';
import { openSpansStore } from './spans-store.js';

const DIGEST = 'a'.repeat(64);
const OTHER_DIGEST = 'b'.repeat(64);
const TARGET = 'c'.repeat(64);
// What spans-store.js accepts for eventId, runId and type.
const STORE_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const INTENT_ID = /^spans\.action\.intent:[0-9a-f]{64}$/;
const OUTCOME_ID = /^spans\.action\.outcome:[0-9a-f]{64}$/;
const HISTORICAL_ID = /^spans\.action\.outcome\.historical:[0-9a-f]{64}$/;
const ACCEPTED_ID = /^spans\.completion\.accepted:[0-9a-f]{64}$/;
const ENVELOPE_KEYS = ['eventId', 'payload', 'runId', 'type'];
const COMMIT_KEYS = 'events,expectedGeneration,expectedRevision,runId,view';

function deepFreeze(value) {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value)) {
      deepFreeze(child);
    }
    Object.freeze(value);
  }
  return value;
}

// Runs work for each item strictly one after another and returns the results
// in order, for tests whose steps depend on the previous step's side effects.
function inSequence(items, work) {
  return items.reduce(
    (previous, item) =>
      previous.then(async (results) => [...results, await work(item)]),
    Promise.resolve([])
  );
}

function initialView(generation = 1) {
  return {
    actions: {},
    checkpoint: 0,
    generation,
    planVersion: 1,
    runId: 'run-1',
    spans: {
      a: { dependencies: [], spanId: 'a', state: 'ready' },
      b: { dependencies: [], spanId: 'b', state: 'ready' },
      c: { dependencies: ['p'], spanId: 'c', state: 'planned' },
      p: { dependencies: ['a', 'b'], spanId: 'p', state: 'planned' },
    },
  };
}

function isEnvelope(event) {
  if (event === null || typeof event !== 'object' || Array.isArray(event)) {
    return false;
  }
  return (
    Object.keys(event).sort().join() === ENVELOPE_KEYS.join() &&
    [event.eventId, event.runId, event.type].every(
      (value) => typeof value === 'string' && STORE_IDENTIFIER.test(value)
    ) &&
    event.payload !== null &&
    typeof event.payload === 'object'
  );
}

// Transactional fake that enforces the real store's exact interface: commitRun
// takes {events, expectedGeneration, expectedRevision, runId, view}, events and
// appendEvent take only {eventId, payload, runId, type} envelopes with valid,
// globally unique IDs, and refusals use the SPANS_MODEL_* codes. Reads return
// frozen clones so any in-place mutation by the service throws.
function fakeStore({ appendEvent = true, view = initialView() } = {}) {
  let current = structuredClone(view);
  let { generation } = current;
  let conflictNext = false;
  let throwOnCommit = false;
  const known = new Map();
  const classify = (event) => {
    const text = JSON.stringify(event);
    if (!known.has(event.eventId)) {
      return 'new';
    }
    return known.get(event.eventId) === text ? 'same' : 'conflict';
  };
  const store = {
    commitAttempts: 0,
    commitRun(request) {
      store.commitAttempts += 1;
      if (throwOnCommit) {
        throw new Error('disk detail that must not leak');
      }
      const valid =
        request !== null &&
        typeof request === 'object' &&
        Object.keys(request).sort().join() === COMMIT_KEYS &&
        Array.isArray(request.events) &&
        request.events.every(
          (event) => isEnvelope(event) && event.runId === request.runId
        ) &&
        Number.isSafeInteger(request.view?.generation);
      if (!valid) {
        return { code: 'SPANS_MODEL_INVALID', ok: false };
      }
      const { events, expectedGeneration, expectedRevision, runId } = request;
      const step = request.view.generation - expectedGeneration;
      if (step !== 0 && step !== 1) {
        return { code: 'SPANS_MODEL_GENERATION_INVALID', ok: false };
      }
      if (conflictNext) {
        conflictNext = false;
        store.revisionValue += 1;
        return { code: 'SPANS_MODEL_STALE_REVISION', ok: false };
      }
      if (runId !== current.runId || expectedRevision !== store.revisionValue) {
        return { code: 'SPANS_MODEL_STALE_REVISION', ok: false };
      }
      if (expectedGeneration !== generation) {
        return { code: 'SPANS_MODEL_STALE_GENERATION', ok: false };
      }
      if (events.some((event) => classify(event) === 'conflict')) {
        return {
          code: 'SPANS_MODEL_EVENT_REFUSED',
          eventCode: 'SPANS_EVENT_CONFLICT',
          ok: false,
        };
      }
      current = structuredClone(request.view);
      for (const event of events) {
        if (classify(event) === 'new') {
          known.set(event.eventId, JSON.stringify(event));
          store.events.push(structuredClone(event));
        }
      }
      store.revisionValue += 1;
      return {
        generation: current.generation,
        ok: true,
        revision: store.revisionValue,
      };
    },
    get conflictNext() {
      return conflictNext;
    },
    set conflictNext(value) {
      conflictNext = value;
    },
    events: [],
    get generation() {
      return generation;
    },
    readRun({ runId }) {
      if (runId !== current.runId) {
        return { code: 'SPANS_MODEL_NOT_FOUND', ok: false };
      }
      return {
        generation,
        ok: true,
        revision: store.revisionValue,
        view: deepFreeze(structuredClone(current)),
      };
    },
    get revision() {
      return store.revisionValue;
    },
    revisionValue: 1,
    setGeneration(next) {
      generation = next;
      current.generation = next;
      store.revisionValue += 1;
    },
    get throwOnCommit() {
      return throwOnCommit;
    },
    set throwOnCommit(value) {
      throwOnCommit = value;
    },
    get view() {
      return structuredClone(current);
    },
  };
  if (appendEvent) {
    store.appendEvent = (event) => {
      if (!isEnvelope(event)) {
        return { code: 'SPANS_EVENT_INVALID', ok: false };
      }
      const status = classify(event);
      if (status === 'conflict') {
        return { code: 'SPANS_EVENT_CONFLICT', ok: false };
      }
      if (status === 'new') {
        known.set(event.eventId, JSON.stringify(event));
        store.events.push(structuredClone(event));
      }
      return { event, ok: true };
    };
  }
  return store;
}

const verified = (evidenceId = 'evidence-1') => ({
  evidenceId,
  ok: true,
  verified: true,
});

function services(store, verifyEvidence) {
  return createSpansActions({ now: () => 1000, store, verifyEvidence });
}

const prepareInput = (overrides = {}) => ({
  actionId: 'action-a',
  attemptId: 'attempt-1',
  generation: 1,
  inputDigest: DIGEST,
  planVersion: 1,
  runId: 'run-1',
  spanId: 'a',
  targetDigest: TARGET,
  ...overrides,
});

const outcomeInput = (overrides = {}) => ({
  actionId: 'action-a',
  artifactIds: ['artifact-1'],
  generation: 1,
  outcome: 'completed',
  runId: 'run-1',
  ...overrides,
});

const acceptInput = (overrides = {}) => ({
  actionId: 'action-a',
  evidence: { tree: 'tree-1' },
  generation: 1,
  runId: 'run-1',
  spanId: 'a',
  ...overrides,
});

async function completedAction(actions, spanId, actionId, runId = 'run-1') {
  expect(
    (
      await actions.prepareAction(
        prepareInput({
          actionId,
          attemptId: `attempt-${actionId}`,
          runId,
          spanId,
        })
      )
    ).ok
  ).toBe(true);
  expect(
    (
      await actions.recordOutcome(
        outcomeInput({ actionId, artifactIds: [`artifact-${actionId}`], runId })
      )
    ).ok
  ).toBe(true);
}

test('prepares an intent with a store-valid event and commits view and event together', async () => {
  const store = fakeStore();
  const actions = services(store, () =>
    Promise.reject(new Error('prepare must not verify or dispatch'))
  );

  const result = await actions.prepareAction(prepareInput());

  expect(result).toEqual({
    actionId: 'action-a',
    created: true,
    ok: true,
    status: 'intent',
  });
  expect(store.view.actions['action-a']).toEqual({
    actionId: 'action-a',
    attemptId: 'attempt-1',
    inputDigest: DIGEST,
    outcomeArtifactIds: [],
    planVersion: 1,
    spanId: 'a',
    state: 'intent',
    targetDigest: TARGET,
  });
  expect(store.view.checkpoint).toBe(0);
  expect(store.view.spans.a.state).toBe('ready');
  expect(store.events).toHaveLength(1);
  const [event] = store.events;
  expect(Object.keys(event).sort()).toEqual(ENVELOPE_KEYS);
  expect(event.eventId).toMatch(INTENT_ID);
  expect(event.runId).toBe('run-1');
  expect(event.type).toBe('spans.action.intent');
  expect(event.payload).toEqual({
    actionId: 'action-a',
    at: 1000,
    attemptId: 'attempt-1',
    generation: 1,
    inputDigest: DIGEST,
    planVersion: 1,
    spanId: 'a',
    targetDigest: TARGET,
  });
});

test('same action ID with identical bound fields returns its status without a new event', async () => {
  const store = fakeStore();
  const actions = services(store);
  await actions.prepareAction(prepareInput());
  const { revision } = store;

  const repeat = await actions.prepareAction(prepareInput());
  const prefixed = await actions.prepareAction(
    prepareInput({
      inputDigest: `sha256:${DIGEST}`,
      targetDigest: `sha256:${TARGET}`,
    })
  );

  for (const result of [repeat, prefixed]) {
    expect(result).toEqual({
      actionId: 'action-a',
      created: false,
      ok: true,
      status: 'intent',
    });
  }
  expect(store.events).toHaveLength(1);
  expect(store.revision).toBe(revision);
});

test('same action ID with different input, target or attempt conflicts', async () => {
  const store = fakeStore();
  const actions = services(store);
  await actions.prepareAction(prepareInput());
  const { revision } = store;

  const results = await inSequence(
    [
      { inputDigest: OTHER_DIGEST },
      { targetDigest: OTHER_DIGEST },
      { attemptId: 'attempt-2' },
      { spanId: 'b' },
    ],
    (changed) => actions.prepareAction(prepareInput(changed))
  );
  for (const result of results) {
    expect(result.ok).toBe(false);
    expect(result.code).toBe('ACTION_CONFLICT');
  }
  expect(store.events).toHaveLength(1);
  expect(store.revision).toBe(revision);
});

test('refuses a changed plan version and malformed input before any commit', async () => {
  const store = fakeStore();
  const actions = services(store);

  expect(
    (await actions.prepareAction(prepareInput({ planVersion: 2 }))).code
  ).toBe('PLAN_CHANGED');
  expect(
    (await actions.prepareAction(prepareInput({ inputDigest: 'short' }))).code
  ).toBe('DIGEST_INVALID');
  expect(
    (await actions.prepareAction(prepareInput({ targetDigest: 'short' }))).code
  ).toBe('TARGET_DIGEST_INVALID');
  expect(
    (await actions.prepareAction(prepareInput({ targetDigest: undefined })))
      .code
  ).toBe('TARGET_DIGEST_INVALID');
  expect(
    (await actions.prepareAction(prepareInput({ actionId: '' }))).code
  ).toBe('ID_INVALID');
  expect(
    (await actions.prepareAction(prepareInput({ actionId: '__proto__' }))).code
  ).toBe('ID_INVALID');
  expect(
    (await actions.prepareAction(prepareInput({ generation: -1 }))).code
  ).toBe('GENERATION_INVALID');
  expect(
    (await actions.prepareAction(prepareInput({ spanId: 'missing' }))).code
  ).toBe('SPAN_NOT_FOUND');
  expect(
    (await actions.prepareAction(prepareInput({ runId: 'other-run' }))).code
  ).toBe('RUN_READ_FAILED');
  expect(store.commitAttempts).toBe(0);
  expect(store.events).toHaveLength(0);
});

test('refuses identifiers that redaction would change instead of storing a rewritten ID', async () => {
  const store = fakeStore();
  const actions = services(store, async () =>
    verified('ghp_abcdefghijklmnopqrstuvwx')
  );

  const attempt = await actions.prepareAction(
    prepareInput({ attemptId: 'sk-ant-api03-abcdefghijklmnopqrstuvwx' })
  );
  expect(attempt.code).toBe('SENSITIVE_VALUE');
  expect(JSON.stringify(attempt)).not.toContain('sk-ant');
  expect(
    (
      await actions.prepareAction(
        prepareInput({ actionId: 'token=abcdefghij' })
      )
    ).code
  ).toBe('SENSITIVE_VALUE');

  await actions.prepareAction(prepareInput());
  expect(
    (
      await actions.recordOutcome(
        outcomeInput({ artifactIds: ['password=hunter2hunter2'] })
      )
    ).code
  ).toBe('SENSITIVE_VALUE');
  expect(store.events).toHaveLength(1);
});

test('refuses a stale coordinator generation for a new intent', async () => {
  const store = fakeStore();
  store.setGeneration(2);

  const result = await services(store).prepareAction(prepareInput());

  expect(result.code).toBe('STALE_GENERATION');
  expect(store.commitAttempts).toBe(0);
  expect(store.view.actions).toEqual({});
});

test('requires every dependency to be accepted complete before an intent', async () => {
  const store = fakeStore();
  const actions = services(store, async () => verified());

  const early = await actions.prepareAction(
    prepareInput({ actionId: 'action-p', spanId: 'p' })
  );
  expect(early.code).toBe('DEPENDENCIES_INCOMPLETE');
  expect(early.waitingFor).toEqual(['a', 'b']);

  // A completed outcome is only a report; the span is not accepted yet.
  await completedAction(actions, 'a', 'action-a');
  await completedAction(actions, 'b', 'action-b');
  const reported = await actions.prepareAction(
    prepareInput({ actionId: 'action-p', spanId: 'p' })
  );
  expect(reported.code).toBe('DEPENDENCIES_INCOMPLETE');
  expect(store.view.actions['action-p']).toBeUndefined();

  await actions.acceptCompletion(acceptInput());
  await actions.acceptCompletion(
    acceptInput({ actionId: 'action-b', spanId: 'b' })
  );
  const accepted = await actions.prepareAction(
    prepareInput({ actionId: 'action-p', spanId: 'p' })
  );
  expect(accepted.status).toBe('intent');
});

test('records observed outcomes without accepting the span', async () => {
  const store = fakeStore();
  const actions = services(store);
  await actions.prepareAction(prepareInput());

  const result = await actions.recordOutcome(outcomeInput());

  expect(result).toEqual({
    accepted: false,
    actionId: 'action-a',
    created: true,
    ok: true,
    status: 'completed',
  });
  const { view } = store;
  expect(view.actions['action-a'].state).toBe('completed');
  expect(view.actions['action-a'].outcomeArtifactIds).toEqual(['artifact-1']);
  expect(view.spans.a.state).toBe('ready');
  expect(view.checkpoint).toBe(0);
  const event = store.events.at(-1);
  expect(event.eventId).toMatch(OUTCOME_ID);
  expect(event.type).toBe('spans.action.outcome');
  expect(event.payload).toEqual({
    actionId: 'action-a',
    artifactIds: ['artifact-1'],
    at: 1000,
    attemptId: 'attempt-1',
    generation: 1,
    outcome: 'completed',
    previousState: 'intent',
    spanId: 'a',
  });
});

test('same terminal outcome is idempotent and contradictory reports refuse', async () => {
  const store = fakeStore();
  const actions = services(store);
  await actions.prepareAction(prepareInput());
  await actions.recordOutcome(outcomeInput());
  const { revision } = store;

  const repeat = await actions.recordOutcome(outcomeInput());
  expect(repeat).toMatchObject({
    created: false,
    ok: true,
    status: 'completed',
  });

  const failed = await actions.recordOutcome(
    outcomeInput({ outcome: 'failed' })
  );
  expect(failed.code).toBe('OUTCOME_CONFLICT');
  const unknown = await actions.recordOutcome(
    outcomeInput({ outcome: 'unknown' })
  );
  expect(unknown.code).toBe('OUTCOME_CONFLICT');
  const otherArtifacts = await actions.recordOutcome(
    outcomeInput({ artifactIds: ['artifact-2'] })
  );
  expect(otherArtifacts.code).toBe('OUTCOME_CONFLICT');

  expect(store.revision).toBe(revision);
  expect(store.view.actions['action-a'].state).toBe('completed');
  expect(store.view.actions['action-a'].outcomeArtifactIds).toEqual([
    'artifact-1',
  ]);
});

test('rejects outcomes other than completed, failed or unknown and bad artifact IDs', async () => {
  const store = fakeStore();
  const actions = services(store);
  await actions.prepareAction(prepareInput());

  expect(
    (await actions.recordOutcome(outcomeInput({ outcome: 'intent' }))).code
  ).toBe('OUTCOME_INVALID');
  expect(
    (await actions.recordOutcome(outcomeInput({ artifactIds: 'artifact-1' })))
      .code
  ).toBe('ARTIFACT_IDS_INVALID');
  expect(
    (await actions.recordOutcome(outcomeInput({ artifactIds: ['x', 'x'] })))
      .code
  ).toBe('ARTIFACT_IDS_INVALID');
  expect(
    (await actions.recordOutcome(outcomeInput({ actionId: 'missing' }))).code
  ).toBe('ACTION_NOT_FOUND');
  expect(store.view.actions['action-a'].state).toBe('intent');
});

test('unknown outcome never becomes a fresh intent or allows another action on the span', async () => {
  const store = fakeStore();
  const actions = services(store);
  await actions.prepareAction(prepareInput());
  await actions.recordOutcome(
    outcomeInput({ artifactIds: [], outcome: 'unknown' })
  );
  const { revision } = store;

  const repeat = await actions.prepareAction(prepareInput());
  expect(repeat).toEqual({
    actionId: 'action-a',
    created: false,
    ok: true,
    retryAllowed: false,
    status: 'unknown',
  });

  const replacement = await actions.prepareAction(
    prepareInput({ actionId: 'action-a2', attemptId: 'attempt-2' })
  );
  expect(replacement.code).toBe('SPAN_ACTION_OPEN');

  expect(store.revision).toBe(revision);
  expect(store.view.actions['action-a'].state).toBe('unknown');
  expect(
    store.events.filter((event) => event.type === 'spans.action.intent')
  ).toHaveLength(1);
});

test('plain verified:true never resolves an unknown outcome and default denies', async () => {
  const store = fakeStore();
  const actions = services(store);
  await actions.prepareAction(prepareInput());
  await actions.recordOutcome(
    outcomeInput({ artifactIds: [], outcome: 'unknown' })
  );
  const { revision } = store;

  const requested = await actions.recordOutcome(
    outcomeInput({ evidence: { verified: true }, verified: true })
  );
  expect(requested.code).toBe('EVIDENCE_NOT_VERIFIED');
  expect(store.revision).toBe(revision);
  expect(store.view.actions['action-a'].state).toBe('unknown');

  const receipts = [
    undefined,
    { evidenceId: 'e', ok: true, verified: false },
    { ok: true, verified: true },
    { evidenceId: 'e', ok: false, verified: true },
    { evidenceId: 'e', ok: true, verified: 'true' },
    { evidenceId: 'ghp_abcdefghijklmnopqrstuvwx', ok: true, verified: true },
  ];
  const denials = await inSequence(receipts, (receipt) =>
    services(store, () => Promise.resolve(receipt)).recordOutcome(
      outcomeInput()
    )
  );
  for (const denied of denials) {
    expect(denied.code).toBe('EVIDENCE_NOT_VERIFIED');
  }
  const thrown = await services(store, () =>
    Promise.reject(new Error('verifier detail'))
  ).recordOutcome(outcomeInput());
  expect(thrown.code).toBe('EVIDENCE_NOT_VERIFIED');
  expect(JSON.stringify(thrown)).not.toContain('verifier detail');
  expect(store.revision).toBe(revision);
});

test('resolves an unknown outcome only after verifyEvidence confirms exact references', async () => {
  const store = fakeStore();
  const calls = [];
  const actions = services(store, (references) => {
    calls.push(references);
    return Promise.resolve(verified('evidence-resolve'));
  });
  await actions.prepareAction(prepareInput());
  await actions.recordOutcome(
    outcomeInput({ artifactIds: [], outcome: 'unknown' })
  );

  const result = await actions.recordOutcome(
    outcomeInput({ artifactIds: ['artifact-9'], outcome: 'failed' })
  );

  expect(result).toMatchObject({ ok: true, status: 'failed' });
  expect(calls).toEqual([
    {
      actionId: 'action-a',
      attemptId: 'attempt-1',
      evidence: null,
      generation: 1,
      inputDigest: DIGEST,
      outcome: 'failed',
      outcomeArtifactIds: ['artifact-9'],
      planVersion: 1,
      purpose: 'resolve-unknown',
      runId: 'run-1',
      spanId: 'a',
      targetDigest: TARGET,
    },
  ]);
  expect(store.view.actions['action-a'].state).toBe('failed');
  expect(store.events.at(-1).payload).toMatchObject({
    previousState: 'unknown',
    resolvedEvidenceId: 'evidence-resolve',
  });
  // A failed action may be replaced by a new explicit action ID.
  const replacement = await actions.prepareAction(
    prepareInput({ actionId: 'action-a2', attemptId: 'attempt-2' })
  );
  expect(replacement.status).toBe('intent');
});

test('old-generation results are kept as inert history without replacing the view', async () => {
  const store = fakeStore();
  const clock = { value: 1000 };
  const actions = createSpansActions({ now: () => clock.value, store });
  await actions.prepareAction(prepareInput());
  store.setGeneration(2);
  const before = store.view;
  const { revision } = store;

  const result = await actions.recordOutcome(outcomeInput({ generation: 1 }));

  expect(result.ok).toBe(false);
  expect(result.code).toBe('STALE_GENERATION');
  expect(result.historical).toBe(true);
  const history = store.events.filter(
    (event) => event.type === 'spans.action.outcome.historical'
  );
  expect(history).toHaveLength(1);
  expect(history[0].eventId).toMatch(HISTORICAL_ID);
  expect(Object.keys(history[0]).sort()).toEqual(ENVELOPE_KEYS);
  expect(history[0].payload).toEqual({
    actionId: 'action-a',
    artifactIds: ['artifact-1'],
    historical: true,
    outcome: 'completed',
    reportedGeneration: 1,
    spanId: 'a',
  });
  expect(store.commitAttempts).toBe(1);
  expect(store.view).toEqual(before);
  expect(store.revision).toBe(revision);
  expect(store.view.actions['action-a'].state).toBe('intent');

  // A retry after the clock moved is the same record, not a new or failing one.
  clock.value = 9999;
  const retry = await actions.recordOutcome(outcomeInput({ generation: 1 }));
  expect(retry).toMatchObject({ code: 'STALE_GENERATION', historical: true });
  expect(
    store.events.filter(
      (event) => event.type === 'spans.action.outcome.historical'
    )
  ).toHaveLength(1);
});

test('old-generation results report no history when the store cannot append, the action is unknown or the report is from the future', async () => {
  const store = fakeStore({ appendEvent: false });
  const actions = services(store);
  await actions.prepareAction(prepareInput());
  store.setGeneration(2);

  const noAppend = await actions.recordOutcome(outcomeInput({ generation: 1 }));
  expect(noAppend).toMatchObject({
    code: 'STALE_GENERATION',
    historical: false,
  });

  const withAppend = fakeStore();
  const other = services(withAppend);
  withAppend.setGeneration(2);
  const missing = await other.recordOutcome(
    outcomeInput({ actionId: 'never-prepared', generation: 1 })
  );
  expect(missing).toMatchObject({
    code: 'STALE_GENERATION',
    historical: false,
  });
  expect(withAppend.events).toHaveLength(0);

  const ahead = fakeStore();
  const aheadActions = services(ahead);
  await aheadActions.prepareAction(prepareInput());
  const future = await aheadActions.recordOutcome(
    outcomeInput({ generation: 2 })
  );
  expect(future).toMatchObject({ code: 'STALE_GENERATION', historical: false });
  expect(ahead.events).toHaveLength(1);
});

test('acceptCompletion records evidence, completes the span and advances the checkpoint once', async () => {
  const store = fakeStore();
  const calls = [];
  const actions = services(store, (references) => {
    calls.push(references);
    return Promise.resolve(verified('evidence-a'));
  });
  await completedAction(actions, 'a', 'action-a');

  const result = await actions.acceptCompletion(acceptInput());

  expect(result).toEqual({
    actionId: 'action-a',
    checkpoint: 1,
    duplicate: false,
    evidenceId: 'evidence-a',
    ok: true,
    readySpanIds: [],
    spanId: 'a',
  });
  expect(calls).toEqual([
    {
      actionId: 'action-a',
      attemptId: 'attempt-action-a',
      evidence: { tree: 'tree-1' },
      generation: 1,
      inputDigest: DIGEST,
      outcomeArtifactIds: ['artifact-action-a'],
      planVersion: 1,
      purpose: 'accept-completion',
      runId: 'run-1',
      spanId: 'a',
      targetDigest: TARGET,
      tree: 'tree-1',
    },
  ]);
  const { view } = store;
  expect(view.spans.a).toMatchObject({
    acceptedActionId: 'action-a',
    acceptedEvidenceId: 'evidence-a',
    state: 'completed',
  });
  expect(view.checkpoint).toBe(1);
  const event = store.events.at(-1);
  expect(event.eventId).toMatch(ACCEPTED_ID);
  expect(event.type).toBe('spans.completion.accepted');
  expect(event.payload).toEqual({
    actionId: 'action-a',
    at: 1000,
    checkpoint: 1,
    evidenceId: 'evidence-a',
    generation: 1,
    readySpanIds: [],
    spanId: 'a',
  });
});

test('acceptCompletion requires a positive verifier receipt, never request-supplied proof', async () => {
  const store = fakeStore();
  const actions = services(store);
  await completedAction(actions, 'a', 'action-a');
  const { revision } = store;

  const plain = await actions.acceptCompletion(
    acceptInput({
      evidence: { evidenceId: 'forged', tree: 't', verified: true },
      verified: true,
    })
  );
  expect(plain.code).toBe('EVIDENCE_NOT_VERIFIED');

  const missing = await actions.acceptCompletion(
    acceptInput({ evidence: undefined })
  );
  expect(missing.code).toBe('EVIDENCE_REQUIRED');
  const list = await actions.acceptCompletion(acceptInput({ evidence: [] }));
  expect(list.code).toBe('EVIDENCE_REQUIRED');

  const negative = await services(store, async () => ({
    evidenceId: 'e',
    ok: true,
    verified: false,
  })).acceptCompletion(acceptInput());
  expect(negative.code).toBe('EVIDENCE_NOT_VERIFIED');

  expect(store.revision).toBe(revision);
  expect(store.view.spans.a.state).toBe('ready');
  expect(store.view.checkpoint).toBe(0);
});

test('only a completed action is eligible and the span must match the action', async () => {
  const store = fakeStore();
  const verify = [];
  const actions = services(store, (references) => {
    verify.push(references);
    return Promise.resolve(verified());
  });
  await actions.prepareAction(prepareInput());
  expect((await actions.acceptCompletion(acceptInput())).code).toBe(
    'ACTION_NOT_COMPLETED'
  );

  await actions.recordOutcome(
    outcomeInput({ artifactIds: [], outcome: 'unknown' })
  );
  expect((await actions.acceptCompletion(acceptInput())).code).toBe(
    'ACTION_NOT_COMPLETED'
  );

  const failedStore = fakeStore();
  const failedActions = services(failedStore, (references) => {
    verify.push(references);
    return Promise.resolve(verified());
  });
  await failedActions.prepareAction(prepareInput());
  await failedActions.recordOutcome(outcomeInput({ outcome: 'failed' }));
  expect((await failedActions.acceptCompletion(acceptInput())).code).toBe(
    'ACTION_NOT_COMPLETED'
  );

  expect(
    (await actions.acceptCompletion(acceptInput({ spanId: 'b' }))).code
  ).toBe('ACTION_SPAN_MISMATCH');
  expect(
    (await actions.acceptCompletion(acceptInput({ actionId: 'nope' }))).code
  ).toBe('ACTION_NOT_FOUND');
  expect(verify).toHaveLength(0);
  expect(store.view.checkpoint).toBe(0);
});

test('duplicate acceptance returns the existing result without verifying or advancing again', async () => {
  const store = fakeStore();
  let verifications = 0;
  const actions = services(store, () => {
    verifications += 1;
    return Promise.resolve(verified(`evidence-${verifications}`));
  });
  await completedAction(actions, 'a', 'action-a');
  const first = await actions.acceptCompletion(acceptInput());
  const { revision } = store;
  const eventCount = store.events.length;

  const duplicate = await actions.acceptCompletion(acceptInput());

  const existing = {
    actionId: 'action-a',
    checkpoint: 1,
    duplicate: true,
    evidenceId: 'evidence-1',
    ok: true,
    spanId: 'a',
  };
  expect(first).toMatchObject({ checkpoint: 1, evidenceId: 'evidence-1' });
  expect(duplicate).toEqual(existing);
  expect(verifications).toBe(1);
  expect(store.revision).toBe(revision);
  expect(store.events).toHaveLength(eventCount);
  expect(store.view.checkpoint).toBe(1);

  // A second instance sharing the store sees the same committed result.
  const other = services(store, async () => verified('evidence-other'));
  expect(await other.acceptCompletion(acceptInput())).toEqual(existing);

  await actions
    .prepareAction(
      prepareInput({ actionId: 'action-a-2', attemptId: 'attempt-2' })
    )
    .then((result) => expect(result.code).toBe('SPAN_COMPLETED'));
});

test('accepting the span from a different action after acceptance conflicts', async () => {
  const store = fakeStore();
  const actions = services(store, async () => verified());
  await completedAction(actions, 'a', 'action-a');
  await actions.acceptCompletion(acceptInput());
  const { view } = store;
  view.actions['action-other'] = {
    ...view.actions['action-a'],
    actionId: 'action-other',
  };
  const seeded = fakeStore({ view });
  const other = services(seeded, async () => verified());

  const result = await other.acceptCompletion(
    acceptInput({ actionId: 'action-other' })
  );

  expect(result.code).toBe('ACCEPTANCE_CONFLICT');
  expect(seeded.view.checkpoint).toBe(1);
});

test('accepting a stale generation or changed plan refuses without verifying', async () => {
  const store = fakeStore();
  let verifications = 0;
  const actions = services(store, () => {
    verifications += 1;
    return Promise.resolve(verified());
  });
  await completedAction(actions, 'a', 'action-a');

  expect(
    (await actions.acceptCompletion(acceptInput({ generation: 0 }))).code
  ).toBe('STALE_GENERATION');

  const { view } = store;
  view.planVersion = 2;
  const replanned = fakeStore({ view });
  const result = await services(replanned, () => {
    verifications += 1;
    return Promise.resolve(verified());
  }).acceptCompletion(acceptInput());
  expect(result.code).toBe('PLAN_CHANGED');
  expect(verifications).toBe(0);
});

test('accepting a dependent span promotes it only after every dependency is accepted', async () => {
  const store = fakeStore();
  const actions = services(store, async (references) =>
    verified(`evidence-${references.spanId}`)
  );
  await completedAction(actions, 'a', 'action-a');
  await completedAction(actions, 'b', 'action-b');

  const first = await actions.acceptCompletion(acceptInput());
  expect(first.readySpanIds).toEqual([]);
  expect(store.view.spans.p.state).toBe('planned');

  const second = await actions.acceptCompletion(
    acceptInput({ actionId: 'action-b', spanId: 'b' })
  );
  expect(second.readySpanIds).toEqual(['p']);
  expect(store.view.spans.p.state).toBe('ready');
  expect(store.view.spans.c.state).toBe('planned');
  expect(store.view.checkpoint).toBe(2);
});

test('a CAS conflict refuses without losing state and the caller retries explicitly', async () => {
  const store = fakeStore();
  const actions = services(store, async () => verified('evidence-a'));
  await completedAction(actions, 'a', 'action-a');
  store.conflictNext = true;

  const refused = await actions.acceptCompletion(acceptInput());
  expect(refused.code).toBe('STALE_REVISION');
  expect(store.view.spans.a.state).toBe('ready');
  expect(store.view.checkpoint).toBe(0);

  const retried = await actions.acceptCompletion(acceptInput());
  expect(retried).toMatchObject({ checkpoint: 1, duplicate: false, ok: true });
  expect(store.view.checkpoint).toBe(1);
  expect(
    store.events.filter((event) => event.type === 'spans.completion.accepted')
  ).toHaveLength(1);
});

test('commit refusals map the store codes, including the conflict aliases, to fixed outcomes', async () => {
  const base = fakeStore();
  const cases = [
    ['SPANS_MODEL_STALE_REVISION', 'STALE_REVISION'],
    ['SPANS_MODEL_REVISION_CONFLICT', 'STALE_REVISION'],
    ['SPANS_MODEL_STALE_GENERATION', 'STALE_GENERATION'],
    ['SPANS_MODEL_GENERATION_CONFLICT', 'STALE_GENERATION'],
    ['SPANS_MODEL_EVENT_REFUSED', 'COMMIT_FAILED'],
    ['SPANS_MODEL_BUSY', 'COMMIT_FAILED'],
    ['SPANS_MODEL_INVALID', 'COMMIT_FAILED'],
  ];
  const results = await inSequence(cases, ([storeCode]) => {
    const stub = {
      commitRun: () => ({ code: storeCode, error: 'detail', ok: false }),
      readRun: base.readRun,
    };
    return createSpansActions({
      now: () => 1000,
      store: stub,
    }).prepareAction(prepareInput());
  });
  for (const [index, result] of results.entries()) {
    expect(result.code).toBe(cases[index][1]);
    expect(JSON.stringify(result)).not.toContain('detail');
  }
});

test('concurrent sibling completion across two service instances keeps both and advances the parent once', async () => {
  const store = fakeStore();
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  let entered;
  const enteredVerification = new Promise((resolve) => {
    entered = resolve;
  });
  const slow = services(store, async () => {
    entered();
    await gate;
    return verified('evidence-a');
  });
  const fast = services(store, async () => verified('evidence-b'));
  await completedAction(fast, 'a', 'action-a');
  await completedAction(fast, 'b', 'action-b');

  const stale = slow.acceptCompletion(acceptInput());
  await enteredVerification;
  const sibling = await fast.acceptCompletion(
    acceptInput({ actionId: 'action-b', spanId: 'b' })
  );
  expect(sibling).toMatchObject({ checkpoint: 1, ok: true, readySpanIds: [] });
  release();

  const refused = await stale;
  expect(refused.ok).toBe(false);
  expect(refused.code).toBe('STALE_REVISION');
  expect(store.view.spans.b.state).toBe('completed');
  expect(store.view.spans.a.state).toBe('ready');
  expect(store.view.spans.p.state).toBe('planned');

  const retried = await slow.acceptCompletion(acceptInput());
  expect(retried).toMatchObject({
    checkpoint: 2,
    duplicate: false,
    ok: true,
    readySpanIds: ['p'],
  });
  const retriedAgain = await slow.acceptCompletion(acceptInput());
  expect(retriedAgain).toMatchObject({ checkpoint: 2, duplicate: true });

  const { view } = store;
  expect(view.spans.a).toMatchObject({
    acceptedEvidenceId: 'evidence-a',
    state: 'completed',
  });
  expect(view.spans.b).toMatchObject({
    acceptedEvidenceId: 'evidence-b',
    state: 'completed',
  });
  expect(view.spans.p.state).toBe('ready');
  expect(view.checkpoint).toBe(2);
  const accepted = store.events.filter(
    (event) => event.type === 'spans.completion.accepted'
  );
  expect(
    accepted.map((event) => [event.payload.spanId, event.payload.checkpoint])
  ).toEqual([
    ['b', 1],
    ['a', 2],
  ]);
  expect(accepted.flatMap((event) => event.payload.readySpanIds)).toEqual([
    'p',
  ]);
});

test('a throwing commit is reported with fixed text and leaves the committed state alone', async () => {
  const store = fakeStore();
  const actions = services(store);
  store.throwOnCommit = true;

  const result = await actions.prepareAction(prepareInput());

  expect(result.code).toBe('COMMIT_FAILED');
  expect(JSON.stringify(result)).not.toContain('disk detail');
  expect(store.view.actions).toEqual({});
});

test('an unusable clock refuses before any commit', async () => {
  const clocks = [
    () => Number.NaN,
    () => -1,
    () => 1.5,
    () => {
      throw new Error('clock detail');
    },
  ];
  await inSequence(clocks, async (now) => {
    const store = fakeStore();
    const result = await createSpansActions({ now, store }).prepareAction(
      prepareInput()
    );
    expect(result.code).toBe('CLOCK_INVALID');
    expect(JSON.stringify(result)).not.toContain('clock detail');
    expect(store.commitAttempts).toBe(0);
  });
});

test('rejects stores that cannot read and commit, and non-function callbacks', () => {
  expect(() => createSpansActions({ store: {} })).toThrow(TypeError);
  expect(() => createSpansActions()).toThrow(TypeError);
  expect(() =>
    createSpansActions({ store: fakeStore(), verifyEvidence: 'yes' })
  ).toThrow(TypeError);
  expect(() => createSpansActions({ now: 5, store: fakeStore() })).toThrow(
    TypeError
  );
});

// ---------------------------------------------------------------------------
// Real store integration: spans-store.js and spans-model-store.js on a
// temporary private root created and removed by each test. No mocks of the
// store; nothing outside the temp root is touched.
// ---------------------------------------------------------------------------

async function withRealStore(work) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'spans-actions-test-'));
  let store;
  try {
    store = openSpansStore({ root });
    return await work(store);
  } finally {
    store?.close();
    fs.rmSync(root, { force: true, recursive: true });
  }
}

function seedRun(store, runId, view = initialView()) {
  const seeded = store.commitRun({
    events: [],
    expectedGeneration: 0,
    expectedRevision: 0,
    runId,
    view: { ...view, runId },
  });
  expect(seeded).toEqual({
    generation: view.generation,
    ok: true,
    revision: 1,
  });
}

function readState(store, runId) {
  const state = store.readRun({ runId });
  expect(state.ok).toBe(true);
  return state;
}

function eventsOf(store, runId) {
  const page = store.readEvents({ limit: 200, runId });
  expect(page.ok).toBe(true);
  expect(page.hasMore).toBe(false);
  return page.events;
}

const realActions = (store, verifyEvidence, now = () => 1000) =>
  createSpansActions({ now, store, verifyEvidence });

test('real store: prepare commits the view and a store-valid intent event, and a retry is inert', async () => {
  await withRealStore(async (store) => {
    seedRun(store, 'run-1');
    const actions = realActions(store);

    expect(await actions.prepareAction(prepareInput())).toEqual({
      actionId: 'action-a',
      created: true,
      ok: true,
      status: 'intent',
    });

    const state = readState(store, 'run-1');
    expect(state.revision).toBe(2);
    expect(state.generation).toBe(1);
    expect(state.view.actions['action-a']).toEqual({
      actionId: 'action-a',
      attemptId: 'attempt-1',
      inputDigest: DIGEST,
      outcomeArtifactIds: [],
      planVersion: 1,
      spanId: 'a',
      state: 'intent',
      targetDigest: TARGET,
    });
    const events = eventsOf(store, 'run-1');
    expect(events).toHaveLength(1);
    expect(events[0].eventId).toMatch(INTENT_ID);
    expect(events[0].runId).toBe('run-1');
    expect(events[0].type).toBe('spans.action.intent');
    expect(events[0].payload).toEqual({
      actionId: 'action-a',
      at: 1000,
      attemptId: 'attempt-1',
      generation: 1,
      inputDigest: DIGEST,
      planVersion: 1,
      spanId: 'a',
      targetDigest: TARGET,
    });

    const repeat = await actions.prepareAction(prepareInput());
    expect(repeat).toMatchObject({
      created: false,
      ok: true,
      status: 'intent',
    });
    expect(readState(store, 'run-1').revision).toBe(2);
    expect(eventsOf(store, 'run-1')).toHaveLength(1);
  });
});

test('real store: the same action with a different target, input or attempt conflicts', async () => {
  await withRealStore(async (store) => {
    seedRun(store, 'run-1');
    const actions = realActions(store);
    await actions.prepareAction(prepareInput());

    const results = await inSequence(
      [
        { targetDigest: OTHER_DIGEST },
        { inputDigest: OTHER_DIGEST },
        { attemptId: 'attempt-2' },
      ],
      (changed) => actions.prepareAction(prepareInput(changed))
    );
    for (const result of results) {
      expect(result).toMatchObject({ code: 'ACTION_CONFLICT', ok: false });
    }
    expect(readState(store, 'run-1').revision).toBe(2);
    expect(eventsOf(store, 'run-1')).toHaveLength(1);
  });
});

test('real store: outcomes are recorded as observations and unknown is resolved only with a verified receipt', async () => {
  await withRealStore(async (store) => {
    seedRun(store, 'run-1');
    const actions = realActions(store, async () =>
      verified('evidence-resolve')
    );
    await actions.prepareAction(prepareInput());

    const reported = await actions.recordOutcome(outcomeInput());
    expect(reported).toEqual({
      accepted: false,
      actionId: 'action-a',
      created: true,
      ok: true,
      status: 'completed',
    });
    let state = readState(store, 'run-1');
    expect(state.revision).toBe(3);
    expect(state.view.actions['action-a'].state).toBe('completed');
    expect(state.view.actions['action-a'].outcomeArtifactIds).toEqual([
      'artifact-1',
    ]);
    expect(state.view.spans.a.state).toBe('ready');
    expect(state.view.checkpoint).toBe(0);
    let events = eventsOf(store, 'run-1');
    expect(events.map((event) => event.type)).toEqual([
      'spans.action.intent',
      'spans.action.outcome',
    ]);
    expect(events[1].eventId).toMatch(OUTCOME_ID);
    expect(events[1].payload).toMatchObject({
      outcome: 'completed',
      previousState: 'intent',
    });

    // A second action on another span goes unknown, then resolves.
    await actions.prepareAction(
      prepareInput({
        actionId: 'action-b',
        attemptId: 'attempt-b',
        spanId: 'b',
      })
    );
    await actions.recordOutcome(
      outcomeInput({
        actionId: 'action-b',
        artifactIds: [],
        outcome: 'unknown',
      })
    );
    const noVerifier = await realActions(store).recordOutcome(
      outcomeInput({ actionId: 'action-b', outcome: 'failed' })
    );
    expect(noVerifier.code).toBe('EVIDENCE_NOT_VERIFIED');
    const resolved = await actions.recordOutcome(
      outcomeInput({ actionId: 'action-b', outcome: 'failed' })
    );
    expect(resolved).toMatchObject({ ok: true, status: 'failed' });
    state = readState(store, 'run-1');
    expect(state.view.actions['action-b'].state).toBe('failed');
    events = eventsOf(store, 'run-1');
    expect(events.at(-1).payload).toMatchObject({
      previousState: 'unknown',
      resolvedEvidenceId: 'evidence-resolve',
    });
    expect(new Set(events.map((event) => event.eventId)).size).toBe(
      events.length
    );
  });
});

test('real store: verified acceptance completes spans, advances checkpoints and promotes the parent atomically', async () => {
  await withRealStore(async (store) => {
    seedRun(store, 'run-1');
    const references = [];
    const actions = realActions(store, (reference) => {
      references.push(reference);
      return Promise.resolve(verified(`evidence-${reference.spanId}`));
    });
    await completedAction(actions, 'a', 'action-a');
    await completedAction(actions, 'b', 'action-b');

    const first = await actions.acceptCompletion(acceptInput());
    expect(first).toEqual({
      actionId: 'action-a',
      checkpoint: 1,
      duplicate: false,
      evidenceId: 'evidence-a',
      ok: true,
      readySpanIds: [],
      spanId: 'a',
    });
    const second = await actions.acceptCompletion(
      acceptInput({ actionId: 'action-b', spanId: 'b' })
    );
    expect(second).toMatchObject({
      checkpoint: 2,
      duplicate: false,
      readySpanIds: ['p'],
    });
    expect(references[0]).toMatchObject({
      purpose: 'accept-completion',
      targetDigest: TARGET,
    });

    const state = readState(store, 'run-1');
    expect(state.view.checkpoint).toBe(2);
    expect(state.view.spans.a).toMatchObject({
      acceptedActionId: 'action-a',
      acceptedCheckpoint: 1,
      acceptedEvidenceId: 'evidence-a',
      state: 'completed',
    });
    expect(state.view.spans.p.state).toBe('ready');
    expect(state.view.spans.c.state).toBe('planned');
    const accepted = eventsOf(store, 'run-1').filter(
      (event) => event.type === 'spans.completion.accepted'
    );
    expect(accepted).toHaveLength(2);
    for (const event of accepted) {
      expect(event.eventId).toMatch(ACCEPTED_ID);
    }
    expect(accepted[1].payload).toMatchObject({
      checkpoint: 2,
      evidenceId: 'evidence-b',
      readySpanIds: ['p'],
      spanId: 'b',
    });

    const { revision } = state;
    const duplicate = await actions.acceptCompletion(acceptInput());
    expect(duplicate).toMatchObject({
      checkpoint: 1,
      duplicate: true,
      ok: true,
    });
    expect(readState(store, 'run-1').revision).toBe(revision);

    const unverified = await realActions(store).acceptCompletion(
      acceptInput({ actionId: 'action-b', spanId: 'b' })
    );
    expect(unverified).toMatchObject({ duplicate: true, ok: true });
  });
});

test('real store: the same action IDs in different runs never collide on event IDs', async () => {
  await withRealStore(async (store) => {
    const runs = ['run-1', 'run-2'];
    for (const runId of runs) {
      seedRun(store, runId);
    }
    const actions = realActions(store, async (reference) =>
      verified(`evidence-${reference.runId}`)
    );

    await inSequence(runs, async (runId) => {
      await completedAction(actions, 'a', 'action-a', runId);
      const accepted = await actions.acceptCompletion(acceptInput({ runId }));
      expect(accepted).toMatchObject({
        checkpoint: 1,
        evidenceId: `evidence-${runId}`,
        ok: true,
      });
    });

    const ids = [];
    for (const runId of runs) {
      const events = eventsOf(store, runId);
      expect(events.map((event) => event.type)).toEqual([
        'spans.action.intent',
        'spans.action.outcome',
        'spans.completion.accepted',
      ]);
      for (const event of events) {
        expect(event.runId).toBe(runId);
        expect(STORE_IDENTIFIER.test(event.eventId)).toBe(true);
        ids.push(event.eventId);
      }
      expect(readState(store, runId).view.checkpoint).toBe(1);
    }
    expect(ids).toHaveLength(6);
    expect(new Set(ids).size).toBe(6);
  });
});

test('real store: a late historical outcome is inert, immutable and retry-safe', async () => {
  await withRealStore(async (store) => {
    seedRun(store, 'run-1');
    const clock = { value: 1000 };
    const actions = realActions(store, undefined, () => clock.value);
    await actions.prepareAction(prepareInput());

    // A newer coordinator takes over: generation 1 -> 2.
    const current = readState(store, 'run-1');
    const takeover = store.commitRun({
      events: [],
      expectedGeneration: 1,
      expectedRevision: current.revision,
      runId: 'run-1',
      view: { ...current.view, generation: 2 },
    });
    expect(takeover.ok).toBe(true);
    const before = readState(store, 'run-1');
    const eventsBefore = eventsOf(store, 'run-1').length;

    const late = await actions.recordOutcome(outcomeInput({ generation: 1 }));
    expect(late).toMatchObject({
      code: 'STALE_GENERATION',
      historical: true,
      ok: false,
    });
    clock.value = 9999;
    const retry = await actions.recordOutcome(outcomeInput({ generation: 1 }));
    expect(retry).toMatchObject({ code: 'STALE_GENERATION', historical: true });

    const history = eventsOf(store, 'run-1').filter(
      (event) => event.type === 'spans.action.outcome.historical'
    );
    expect(history).toHaveLength(1);
    expect(history[0].eventId).toMatch(HISTORICAL_ID);
    expect(history[0].payload).toEqual({
      actionId: 'action-a',
      artifactIds: ['artifact-1'],
      historical: true,
      outcome: 'completed',
      reportedGeneration: 1,
      spanId: 'a',
    });
    expect(eventsOf(store, 'run-1')).toHaveLength(eventsBefore + 1);
    expect(readState(store, 'run-1')).toEqual(before);
    expect(before.view.actions['action-a'].state).toBe('intent');

    // A different late report is its own record; a future-generation or
    // unknown-action report is not history at all.
    const other = await actions.recordOutcome(
      outcomeInput({ generation: 1, outcome: 'failed' })
    );
    expect(other.historical).toBe(true);
    const future = await actions.recordOutcome(outcomeInput({ generation: 3 }));
    expect(future).toMatchObject({
      code: 'STALE_GENERATION',
      historical: false,
    });
    const missing = await actions.recordOutcome(
      outcomeInput({ actionId: 'never-prepared', generation: 1 })
    );
    expect(missing).toMatchObject({
      code: 'STALE_GENERATION',
      historical: false,
    });
    expect(
      eventsOf(store, 'run-1').filter(
        (event) => event.type === 'spans.action.outcome.historical'
      )
    ).toHaveLength(2);
    expect(readState(store, 'run-1')).toEqual(before);

    // The current coordinator still records its own outcome normally.
    const current2 = await actions.recordOutcome(
      outcomeInput({ generation: 2 })
    );
    expect(current2).toMatchObject({ ok: true, status: 'completed' });
  });
});

test('real store: a stale revision is refused without losing the sibling and retries explicitly', async () => {
  await withRealStore(async (store) => {
    seedRun(store, 'run-1');
    const fast = realActions(store, async () => verified('evidence-b'));
    // While the slow acceptance verifies, a sibling commits through the store.
    const slow = realActions(store, async () => {
      const sibling = await fast.acceptCompletion(
        acceptInput({ actionId: 'action-b', spanId: 'b' })
      );
      expect(sibling.ok).toBe(true);
      return verified('evidence-a');
    });
    await completedAction(fast, 'a', 'action-a');
    await completedAction(fast, 'b', 'action-b');

    const refused = await slow.acceptCompletion(acceptInput());
    expect(refused).toMatchObject({ code: 'STALE_REVISION', ok: false });
    let state = readState(store, 'run-1');
    expect(state.view.spans.b.state).toBe('completed');
    expect(state.view.spans.a.state).toBe('ready');
    expect(state.view.spans.p.state).toBe('planned');
    expect(state.view.checkpoint).toBe(1);
    expect(
      eventsOf(store, 'run-1').filter(
        (event) => event.type === 'spans.completion.accepted'
      )
    ).toHaveLength(1);

    const retried = await slow.acceptCompletion(acceptInput());
    expect(retried).toMatchObject({
      checkpoint: 2,
      duplicate: false,
      ok: true,
      readySpanIds: ['p'],
    });
    state = readState(store, 'run-1');
    expect(state.view.spans.p.state).toBe('ready');
    expect(state.view.checkpoint).toBe(2);
    expect(
      eventsOf(store, 'run-1').filter(
        (event) => event.type === 'spans.completion.accepted'
      )
    ).toHaveLength(2);
  });
});

test('real store: an event that already exists with different content refuses the whole commit, an identical one is inert', async () => {
  await withRealStore(async (store) => {
    seedRun(store, 'run-1');
    const clock = { value: 1000 };
    const actions = realActions(store, undefined, () => clock.value);
    await actions.prepareAction(prepareInput());

    // Test-only rewind of the view so the identical intent is prepared again.
    const stored = readState(store, 'run-1');
    const rewound = structuredClone(stored.view);
    rewound.actions = {};
    expect(
      store.commitRun({
        events: [],
        expectedGeneration: 1,
        expectedRevision: stored.revision,
        runId: 'run-1',
        view: rewound,
      }).ok
    ).toBe(true);
    const before = readState(store, 'run-1');

    clock.value = 2000;
    const conflicting = await actions.prepareAction(prepareInput());
    expect(conflicting).toMatchObject({ code: 'COMMIT_FAILED', ok: false });
    expect(readState(store, 'run-1')).toEqual(before);
    expect(eventsOf(store, 'run-1')).toHaveLength(1);

    clock.value = 1000;
    const identical = await actions.prepareAction(prepareInput());
    expect(identical).toMatchObject({ created: true, ok: true });
    expect(eventsOf(store, 'run-1')).toHaveLength(1);
    expect(readState(store, 'run-1').view.actions['action-a'].state).toBe(
      'intent'
    );
  });
});

test('real store: secrets are redacted from persisted views and events and never stored in IDs', async () => {
  await withRealStore(async (store) => {
    const view = initialView();
    view.spans.a.note =
      'api_key=abcdefgh12345678 and Bearer abcdefghijklmnop1234';
    seedRun(store, 'run-1', view);
    const actions = realActions(store, async () =>
      verified('ghp_abcdefghijklmnopqrstuvwx')
    );
    const { revision } = readState(store, 'run-1');

    const sensitive = await actions.prepareAction(
      prepareInput({ attemptId: 'sk-ant-api03-abcdefghijklmnopqrstuvwx' })
    );
    expect(sensitive).toMatchObject({ code: 'SENSITIVE_VALUE', ok: false });
    expect(readState(store, 'run-1').revision).toBe(revision);

    await actions.prepareAction(prepareInput());
    await actions.recordOutcome(
      outcomeInput({ artifactIds: [], outcome: 'unknown' })
    );
    const forged = await actions.recordOutcome(
      outcomeInput({ outcome: 'failed' })
    );
    expect(forged.code).toBe('EVIDENCE_NOT_VERIFIED');

    const state = readState(store, 'run-1');
    expect(state.view.spans.a.note).toBe(
      'api_key=[REDACTED] and Bearer [REDACTED]'
    );
    const persisted = JSON.stringify([state.view, eventsOf(store, 'run-1')]);
    for (const secret of [
      'abcdefgh12345678',
      'abcdefghijklmnop1234',
      'sk-ant-api03',
      'ghp_abcdefghijklmnopqrstuvwx',
    ]) {
      expect(persisted).not.toContain(secret);
    }
  });
});

test('real store: secret-field-like action keys refuse before revisions or events change', async () => {
  await withRealStore(async (store) => {
    seedRun(store, 'run-1');
    const actions = realActions(store);
    const before = readState(store, 'run-1');
    const beforeEvents = eventsOf(store, 'run-1');

    const unsafeIds = ['api_key', 'Password', 'access-token'];
    const refusals = await Promise.all(
      unsafeIds.flatMap((unsafe) => [
        actions.prepareAction(prepareInput({ actionId: unsafe })),
        actions.prepareAction(prepareInput({ spanId: unsafe })),
      ])
    );
    for (const refusal of refusals) {
      expect(refusal).toMatchObject({ code: 'SENSITIVE_VALUE', ok: false });
    }

    expect(readState(store, 'run-1')).toEqual(before);
    expect(eventsOf(store, 'run-1')).toEqual(beforeEvents);

    expect(await actions.prepareAction(prepareInput())).toMatchObject({
      actionId: 'action-a',
      created: true,
      ok: true,
    });
    expect(readState(store, 'run-1').view.actions['action-a'].state).toBe(
      'intent'
    );
    expect(eventsOf(store, 'run-1')).toHaveLength(1);
  });
});
