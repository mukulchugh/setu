// Offline Spans plan drafts. This service uses the caller-owned archive only;
// it never inspects Git, resolves paths, starts agents, or grants approvals.

import { createHash } from 'node:crypto';
import { redactSpansValue } from './spans-redaction.js';
import { validateSpanDependencies } from './spans-transitions.js';

const identifierPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const actionHistoryPattern = /action[._-](?:intent|outcome)/i;
const owns = (object, key) => Object.hasOwn(object, key);
const isRecord = (value) =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const errors = Object.freeze({
  SPANS_DRAFT_ACTIONS_EXIST:
    'A plan with action history cannot be revised yet.',
  SPANS_DRAFT_CONFLICT: 'A different draft already uses this run ID.',
  SPANS_DRAFT_DEPENDENCY_CYCLE: 'Span dependencies contain a cycle.',
  SPANS_DRAFT_DEPENDENCY_MISSING:
    'Every dependency must name an existing span.',
  SPANS_DRAFT_DEPENDENCY_SELF: 'A span cannot depend on itself.',
  SPANS_DRAFT_INVALID: 'Invalid Spans draft request.',
  SPANS_DRAFT_STALE: 'Spans draft revision or generation is stale.',
  SPANS_DRAFT_STORAGE: 'Spans draft could not be stored or read.',
});

const refusal = (code) => ({ code, error: errors[code], ok: false });
const isIdentifier = (value) =>
  typeof value === 'string' && identifierPattern.test(value);

function isPlainRecord(value) {
  if (!isRecord(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function readOwnData(record, key) {
  const descriptor = Object.getOwnPropertyDescriptor(record, key);
  if (!(descriptor?.enumerable && owns(descriptor, 'value'))) {
    throw new TypeError('invalid draft input');
  }
  return descriptor.value;
}

function pick(input, required, optional = []) {
  if (!isPlainRecord(input)) {
    return;
  }
  const keys = Reflect.ownKeys(input);
  const allowed = new Set([...required, ...optional]);
  if (
    keys.some((key) => typeof key !== 'string' || !allowed.has(key)) ||
    required.some((key) => !keys.includes(key))
  ) {
    return;
  }
  const copy = {};
  for (const key of keys) {
    Object.defineProperty(copy, key, {
      configurable: true,
      enumerable: true,
      value: readOwnData(input, key),
      writable: true,
    });
  }
  return copy;
}

function normalizeSpans(value) {
  if (!Array.isArray(value) || value.length > 200) {
    return;
  }
  const spans = [];
  const identifiers = new Set();
  for (const rawSpan of value) {
    const span = pick(rawSpan, ['dependencies', 'spanId', 'title']);
    if (!isValidSpanInput(span, identifiers)) {
      return;
    }
    const redactedIdentifiers = redactPlan({
      dependencies: span.dependencies,
      spanId: span.spanId,
    });
    if (
      !redactedIdentifiers ||
      redactedIdentifiers.spanId !== span.spanId ||
      redactedIdentifiers.dependencies.some(
        (dependency, index) => dependency !== span.dependencies[index]
      )
    ) {
      return;
    }
    identifiers.add(span.spanId);
    spans.push({
      dependencies: [...span.dependencies],
      spanId: span.spanId,
      title: span.title,
    });
  }

  const graphError = validateNormalizedGraph(spans);
  if (graphError) {
    return { code: graphError };
  }
  return { spans };
}

function isValidSpanInput(span, identifiers) {
  return Boolean(
    span &&
      isIdentifier(span.spanId) &&
      typeof span.title === 'string' &&
      span.title.length > 0 &&
      span.title.length <= 16_000 &&
      Array.isArray(span.dependencies) &&
      span.dependencies.length <= 200 &&
      span.dependencies.every(isIdentifier) &&
      new Set(span.dependencies).size === span.dependencies.length &&
      !identifiers.has(span.spanId)
  );
}

function validateNormalizedGraph(spans) {
  for (const candidate of spans) {
    const others = spans.filter((span) => span.spanId !== candidate.spanId);
    const result = validateSpanDependencies({
      dependencies: candidate.dependencies,
      spanId: candidate.spanId,
      spans: others,
    });
    if (!result.ok) {
      return (
        {
          DEPENDENCY_CYCLE: 'SPANS_DRAFT_DEPENDENCY_CYCLE',
          DEPENDENCY_MISSING: 'SPANS_DRAFT_DEPENDENCY_MISSING',
          DEPENDENCY_SELF: 'SPANS_DRAFT_DEPENDENCY_SELF',
        }[result.code] ?? 'SPANS_DRAFT_INVALID'
      );
    }
  }
}

function redactPlan(plan) {
  try {
    return redactSpansValue(plan);
  } catch {
    // Undefined signals a redaction failure to the caller.
  }
}

function stableEventId(runId, planVersion, eventKind) {
  return createHash('sha256')
    .update(JSON.stringify([runId, planVersion, eventKind]))
    .digest('hex');
}

function planEvent(runId, planVersion, payload, type) {
  return {
    eventId: stableEventId(runId, planVersion, type),
    payload,
    runId,
    type,
  };
}

function compareJson(left, right) {
  try {
    const canonical = (value) => {
      if (Array.isArray(value)) {
        return `[${value.map(canonical).join(',')}]`;
      }
      if (isPlainRecord(value)) {
        return `{${Object.keys(value)
          .sort()
          .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
          .join(',')}}`;
      }
      return JSON.stringify(value);
    };
    return canonical(left) === canonical(right);
  } catch {
    return false;
  }
}

function planPayload({ goal, owner, project, spans, worktree }, planVersion) {
  return {
    goal,
    owner,
    planVersion,
    project,
    spans: Object.fromEntries(
      spans.map((span) => [
        span.spanId,
        {
          dependencies: [...span.dependencies],
          spanId: span.spanId,
          title: span.title,
        },
      ])
    ),
    worktree,
  };
}

function plannedSpans(spans) {
  return Object.fromEntries(
    spans.map((span) => [
      span.spanId,
      {
        dependencies: [...span.dependencies],
        spanId: span.spanId,
        state: 'planned',
        title: span.title,
      },
    ])
  );
}

function isStore(store) {
  return (
    isPlainRecord(store) &&
    typeof store.commitRun === 'function' &&
    typeof store.readRun === 'function' &&
    typeof store.readEvents === 'function'
  );
}

function existingInitialDraft(store, runId, candidate) {
  let afterSequence = 0;
  let created;
  while (!created) {
    let read;
    try {
      read = store.readEvents({ afterSequence, limit: 200, runId });
    } catch {
      return refusal('SPANS_DRAFT_STORAGE');
    }
    if (read?.ok !== true || !Array.isArray(read.events)) {
      return refusal('SPANS_DRAFT_STORAGE');
    }
    created = read.events.find((event) => event.type === 'spans.plan.created');
    if (created || !read.hasMore) {
      break;
    }
    if (read.nextSequence <= afterSequence) {
      return refusal('SPANS_DRAFT_STORAGE');
    }
    afterSequence = read.nextSequence;
  }
  if (!created) {
    return refusal('SPANS_DRAFT_CONFLICT');
  }
  return compareJson(created.payload, candidate)
    ? { ok: true, replayed: true, revision: undefined }
    : refusal('SPANS_DRAFT_CONFLICT');
}

function readStoreRun(store, runId) {
  let result;
  try {
    result = store.readRun({ runId });
  } catch {
    return refusal('SPANS_DRAFT_STORAGE');
  }
  if (result?.ok === true) {
    return result;
  }
  if (result?.code === 'SPANS_MODEL_NOT_FOUND') {
    return null;
  }
  return refusal('SPANS_DRAFT_STORAGE');
}

function hasActionHistory(store, runId) {
  let afterSequence = 0;
  for (;;) {
    let result;
    try {
      result = store.readEvents({ afterSequence, limit: 200, runId });
    } catch {
      return { error: true };
    }
    if (result?.ok !== true || !Array.isArray(result.events)) {
      return { error: true };
    }
    const found = result.events.some(
      (event) =>
        typeof event.type === 'string' && actionHistoryPattern.test(event.type)
    );
    if (found) {
      return { found: true };
    }
    if (!result.hasMore) {
      return { found: false };
    }
    if (result.nextSequence <= afterSequence) {
      return { error: true };
    }
    afterSequence = result.nextSequence;
  }
}

function commitFailure(store, runId, candidate) {
  const current = readStoreRun(store, runId);
  if (current === null || current?.ok === false) {
    return refusal('SPANS_DRAFT_STORAGE');
  }
  if (candidate && current.revision >= 1) {
    const replay = existingInitialDraft(store, runId, candidate);
    if (replay.ok) {
      return { ...replay, revision: current.revision, run: current.view };
    }
    if (replay.code !== 'SPANS_DRAFT_CONFLICT') {
      return replay;
    }
  }
  return refusal('SPANS_DRAFT_STALE');
}

function parseCreateRequest(raw) {
  let request;
  try {
    request = pick(
      raw,
      ['goal', 'owner', 'runId', 'spans'],
      ['project', 'worktree']
    );
  } catch {
    return refusal('SPANS_DRAFT_INVALID');
  }
  if (!isValidCreateRequest(request)) {
    return refusal('SPANS_DRAFT_INVALID');
  }
  const redactedRunId = redactPlan({ runId: request.runId });
  if (!redactedRunId || redactedRunId.runId !== request.runId) {
    return refusal('SPANS_DRAFT_INVALID');
  }
  let normalized;
  try {
    normalized = normalizeSpans(request.spans);
  } catch {
    return refusal('SPANS_DRAFT_INVALID');
  }
  if (!normalized) {
    return refusal('SPANS_DRAFT_INVALID');
  }
  if (normalized.code) {
    return refusal(normalized.code);
  }
  const plan = redactPlan({
    goal: request.goal,
    owner: request.owner,
    project: request.project ?? null,
    spans: normalized.spans,
    worktree: request.worktree ?? null,
  });
  return plan ? { plan, request } : refusal('SPANS_DRAFT_INVALID');
}

function isValidCreateRequest(request) {
  return Boolean(
    request &&
      isIdentifier(request.runId) &&
      typeof request.goal === 'string' &&
      request.goal.length > 0 &&
      request.goal.length <= 16_000 &&
      typeof request.owner === 'string' &&
      request.owner.length <= 256 &&
      (!owns(request, 'project') ||
        request.project === null ||
        typeof request.project === 'string') &&
      (!owns(request, 'worktree') ||
        request.worktree === null ||
        typeof request.worktree === 'string')
  );
}

function createView(request, plan) {
  return {
    actions: {},
    checkpoint: 0,
    generation: 0,
    goal: plan.goal,
    owner: plan.owner,
    planVersion: 1,
    project: plan.project,
    runId: request.runId,
    spans: plannedSpans(plan.spans),
    state: 'planned',
    worktree: plan.worktree,
  };
}

function storeInitialDraft(store, request, plan, view) {
  const payload = planPayload(plan, 1);
  const current = readStoreRun(store, request.runId);
  if (current?.ok === false) {
    return current;
  }
  if (current) {
    const replay = existingInitialDraft(store, request.runId, payload);
    return replay.ok
      ? { ...replay, revision: current.revision, run: current.view }
      : replay;
  }
  let result;
  try {
    result = store.commitRun({
      events: [planEvent(request.runId, 1, payload, 'spans.plan.created')],
      expectedGeneration: 0,
      expectedRevision: 0,
      runId: request.runId,
      view,
    });
  } catch {
    return commitFailure(store, request.runId, payload);
  }
  if (result?.ok !== true) {
    return commitFailure(store, request.runId, payload);
  }
  return {
    generation: 0,
    ok: true,
    replayed: false,
    revision: result.revision,
    run: view,
  };
}

function parseRevisionRequest(raw) {
  let request;
  try {
    request = pick(raw, [
      'expectedGeneration',
      'expectedRevision',
      'goal',
      'runId',
      'spans',
    ]);
  } catch {
    return refusal('SPANS_DRAFT_INVALID');
  }
  if (!isValidRevisionRequest(request)) {
    return refusal('SPANS_DRAFT_INVALID');
  }
  let normalized;
  try {
    normalized = normalizeSpans(request.spans);
  } catch {
    return refusal('SPANS_DRAFT_INVALID');
  }
  if (!normalized) {
    return refusal('SPANS_DRAFT_INVALID');
  }
  if (normalized.code) {
    return refusal(normalized.code);
  }
  return { request, spans: normalized.spans };
}

function isValidRevisionRequest(request) {
  return Boolean(
    request &&
      isIdentifier(request.runId) &&
      Number.isSafeInteger(request.expectedRevision) &&
      request.expectedRevision >= 1 &&
      Number.isSafeInteger(request.expectedGeneration) &&
      request.expectedGeneration >= 0 &&
      typeof request.goal === 'string' &&
      request.goal.length > 0 &&
      request.goal.length <= 16_000
  );
}

function checkRevisionEligibility(store, request) {
  const current = readStoreRun(store, request.runId);
  if (current?.ok === false || current === null) {
    return refusal('SPANS_DRAFT_STORAGE');
  }
  if (
    current.revision !== request.expectedRevision ||
    current.generation !== request.expectedGeneration
  ) {
    return refusal('SPANS_DRAFT_STALE');
  }
  if (
    !isPlainRecord(current.view.actions) ||
    Object.keys(current.view.actions).length > 0
  ) {
    return refusal('SPANS_DRAFT_ACTIONS_EXIST');
  }
  const history = hasActionHistory(store, request.runId);
  if ('error' in history) {
    return refusal('SPANS_DRAFT_STORAGE');
  }
  if (history.found) {
    return refusal('SPANS_DRAFT_ACTIONS_EXIST');
  }
  return { current, ok: true };
}

function commitRevision(
  store,
  request,
  current,
  plan,
  planVersion,
  generation
) {
  const payload = planPayload(plan, planVersion);
  const view = {
    ...current.view,
    generation,
    goal: plan.goal,
    planVersion,
    spans: plannedSpans(plan.spans),
  };
  let result;
  try {
    result = store.commitRun({
      events: [
        planEvent(request.runId, planVersion, payload, 'spans.plan.revised'),
      ],
      expectedGeneration: request.expectedGeneration,
      expectedRevision: request.expectedRevision,
      runId: request.runId,
      view,
    });
  } catch {
    return refusal('SPANS_DRAFT_STALE');
  }
  if (result?.ok !== true) {
    return refusal('SPANS_DRAFT_STALE');
  }
  return {
    generation,
    ok: true,
    planVersion,
    revision: result.revision,
    run: view,
  };
}

export function createSpansDrafts(options) {
  const input = pick(options, ['store']);
  if (!(input && isStore(input.store))) {
    throw new TypeError('Invalid Spans draft store.');
  }
  const { store } = input;

  function createRun(raw) {
    const parsed = parseCreateRequest(raw);
    if (parsed.ok === false) {
      return parsed;
    }
    const { plan, request } = parsed;
    return storeInitialDraft(store, request, plan, createView(request, plan));
  }

  function revisePlan(raw) {
    const parsed = parseRevisionRequest(raw);
    if (parsed.ok === false) {
      return parsed;
    }
    const { request, spans } = parsed;
    const eligible = checkRevisionEligibility(store, request);
    if (eligible.ok !== true) {
      return eligible;
    }
    const { current } = eligible;
    const plan = redactPlan({
      goal: request.goal,
      owner: current.view.owner,
      project: current.view.project,
      spans,
      worktree: current.view.worktree,
    });
    if (!plan) {
      return refusal('SPANS_DRAFT_INVALID');
    }
    const planVersion = current.view.planVersion + 1;
    const generation = current.generation + 1;
    if (
      !(Number.isSafeInteger(planVersion) && Number.isSafeInteger(generation))
    ) {
      return refusal('SPANS_DRAFT_INVALID');
    }
    return commitRevision(
      store,
      request,
      current,
      plan,
      planVersion,
      generation
    );
  }

  return Object.freeze({ createRun, revisePlan });
}
