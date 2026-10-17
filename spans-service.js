// Shared READ-ONLY Spans service for the portal, CLI and MCP front doors.
// Import and construction perform no I/O: the caller injects an already opened
// store and artifact reader, and there is no default root. The service never
// imports, mutates, approves or dispatches, and it offers no search until an
// index exists. Every outbound value passes through the seeded redactor, and
// every failure is a fixed { ok: false, code, error } that never carries an
// adapter's message, path or cause.

import { redactSpansValue } from './spans-redaction.js';

export const SPANS_SERVICE_LIMITS = Object.freeze({ pageLimit: 200 });

const DEFAULT_PAGE_LIMIT = 50;
const identifierPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const artifactIdPattern = /^sha256:[a-f0-9]{64}$/;
// List rows carry only these view fields, and only scalar values, so a page
// never ships a run's actions, history or checkpoint bodies.
const summaryFields = [
  'goal',
  'owner',
  'state',
  'project',
  'worktree',
  'planVersion',
  'checkpoint',
];
// HTML and every other active type are absent on purpose: artifacts the seeded
// writer accepts are text/plain or JSON, and anything else is refused here too.
const inertMediaTypes = new Set(['text/plain', 'application/json']);
const optionKeys = new Set(['artifacts', 'getArtifactReference', 'store']);
const listKeys = new Set(['afterRunId', 'limit', 'phase', 'query']);
const listPhases = new Set(['all', 'past', 'live', 'planned']);
const eventKeys = new Set(['afterSequence', 'limit', 'runId']);
const artifactKeys = new Set(['artifactId', 'runId']);
const runKeys = new Set(['runId']);

const messages = Object.freeze({
  SPANS_SERVICE_BUSY: 'Spans history is busy; try again.',
  SPANS_SERVICE_CORRUPT: 'Spans history failed an integrity check.',
  SPANS_SERVICE_INVALID: 'Invalid spans request.',
  SPANS_SERVICE_NOT_FOUND: 'Spans record was not found.',
  SPANS_SERVICE_UNAVAILABLE: 'Spans history is unavailable.',
});

// Store and model-store codes are mapped, never forwarded.
const storeCodes = new Map([
  ['SPANS_MODEL_BUSY', 'SPANS_SERVICE_BUSY'],
  ['SPANS_MODEL_CORRUPT', 'SPANS_SERVICE_CORRUPT'],
  ['SPANS_MODEL_INVALID', 'SPANS_SERVICE_INVALID'],
  ['SPANS_MODEL_NOT_FOUND', 'SPANS_SERVICE_NOT_FOUND'],
  ['SPANS_QUERY_INVALID', 'SPANS_SERVICE_INVALID'],
  ['SPANS_STORE_BUSY', 'SPANS_SERVICE_BUSY'],
  ['SPANS_STORE_CORRUPT', 'SPANS_SERVICE_CORRUPT'],
]);
const artifactCodes = new Map([
  ['ARTIFACT_CORRUPT', 'SPANS_SERVICE_CORRUPT'],
  ['ARTIFACT_DIRECTORY_MISSING', 'SPANS_SERVICE_NOT_FOUND'],
  ['ARTIFACT_ID_INVALID', 'SPANS_SERVICE_INVALID'],
  ['ARTIFACT_INVALID', 'SPANS_SERVICE_CORRUPT'],
  ['ARTIFACT_NOT_FOUND', 'SPANS_SERVICE_NOT_FOUND'],
]);

// Internal control flow only; it carries a code and nothing else.
class Refusal extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}

const refuse = (code) => {
  throw new Refusal(code);
};

const failure = (code) => ({ code, error: messages[code], ok: false });

async function guarded(work) {
  try {
    return await work();
  } catch (error) {
    return failure(
      error instanceof Refusal ? error.code : 'SPANS_SERVICE_UNAVAILABLE'
    );
  }
}

const isIdentifier = (value) =>
  typeof value === 'string' && identifierPattern.test(value);
const isCount = (value) => Number.isSafeInteger(value) && value >= 0;

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

// Copies own enumerable data properties only, so a getter or proxy can neither
// answer twice nor run code. Anything odd is simply an invalid request.
function readInput(input, allowed) {
  try {
    if (!isPlainObject(input)) {
      return refuse('SPANS_SERVICE_INVALID');
    }
    const values = {};
    for (const key of Reflect.ownKeys(input)) {
      const descriptor = Object.getOwnPropertyDescriptor(input, key);
      if (
        !(
          typeof key === 'string' &&
          allowed.has(key) &&
          descriptor?.enumerable &&
          'value' in descriptor
        )
      ) {
        return refuse('SPANS_SERVICE_INVALID');
      }
      values[key] = descriptor.value;
    }
    return values;
  } catch {
    return refuse('SPANS_SERVICE_INVALID');
  }
}

function pageLimit(limit) {
  if (limit === undefined) {
    return DEFAULT_PAGE_LIMIT;
  }
  if (
    !(
      Number.isInteger(limit) &&
      limit >= 1 &&
      limit <= SPANS_SERVICE_LIMITS.pageLimit
    )
  ) {
    return refuse('SPANS_SERVICE_INVALID');
  }
  return limit;
}

function requireRunId(runId) {
  return isIdentifier(runId) ? runId : refuse('SPANS_SERVICE_INVALID');
}

function normalizeList(input = {}) {
  const { afterRunId, limit, phase, query } = readInput(input, listKeys);
  if (
    (phase !== undefined && !listPhases.has(phase)) ||
    (query !== undefined && !(typeof query === 'string' && query.length <= 256))
  ) {
    refuse('SPANS_SERVICE_INVALID');
  }
  // null is what a JSON client sends for "first page".
  if (afterRunId !== undefined && afterRunId !== null) {
    requireRunId(afterRunId);
  }
  return {
    afterRunId: afterRunId ?? undefined,
    limit: pageLimit(limit),
    ...(phase === undefined ? {} : { phase }),
    ...(query === undefined ? {} : { query }),
  };
}

function normalizeRunRef(input) {
  return { runId: requireRunId(readInput(input, runKeys).runId) };
}

function normalizeEvents(input) {
  const { afterSequence = 0, limit, runId } = readInput(input, eventKeys);
  if (!isCount(afterSequence)) {
    refuse('SPANS_SERVICE_INVALID');
  }
  return {
    afterSequence,
    limit: pageLimit(limit),
    runId: requireRunId(runId),
  };
}

function normalizeArtifactRef(input) {
  const { artifactId, runId } = readInput(input, artifactKeys);
  if (!(typeof artifactId === 'string' && artifactIdPattern.test(artifactId))) {
    refuse('SPANS_SERVICE_INVALID');
  }
  return { artifactId, runId: requireRunId(runId) };
}

// Adapter results: a refusal maps to a fixed code, and anything that is not a
// recognizable result at all is treated as damaged history.
function unwrap(result, codes) {
  if (result === null || typeof result !== 'object') {
    return refuse('SPANS_SERVICE_CORRUPT');
  }
  if (result.ok === true) {
    return result;
  }
  if (result.ok === false) {
    const code = typeof result.code === 'string' ? result.code : '';
    return refuse(codes.get(code) ?? 'SPANS_SERVICE_UNAVAILABLE');
  }
  return refuse('SPANS_SERVICE_CORRUPT');
}

function redact(value) {
  try {
    return redactSpansValue(value);
  } catch {
    return refuse('SPANS_SERVICE_CORRUPT');
  }
}

const isScalar = (value) =>
  value === null || ['string', 'number', 'boolean'].includes(typeof value);

// Own data properties only, present fields only: nothing is defaulted or derived.
function summarizeView(view) {
  const summary = {};
  for (const field of summaryFields) {
    const descriptor = Object.getOwnPropertyDescriptor(view, field);
    if (descriptor && 'value' in descriptor && isScalar(descriptor.value)) {
      summary[field] = descriptor.value;
    }
  }
  return summary;
}

// Same record shape for lists and details; a list carries the view summary and
// a detail carries the full view.
function toRecord(runId, result, summary = false) {
  if (
    !(
      isCount(result.revision) &&
      isCount(result.generation) &&
      isPlainObject(result.view)
    )
  ) {
    return refuse('SPANS_SERVICE_CORRUPT');
  }
  return {
    generation: result.generation,
    revision: result.revision,
    runId,
    view: redact(summary ? summarizeView(result.view) : result.view),
  };
}

function validatedSummaries(result, request) {
  const { runs, hasMore } = result;
  if (!(Array.isArray(runs) && typeof hasMore === 'boolean')) {
    return refuse('SPANS_SERVICE_CORRUPT');
  }
  if (runs.length > request.limit) {
    return refuse('SPANS_SERVICE_CORRUPT');
  }
  let previous = request.afterRunId;
  // Ids are cursors and opaque keys, so one that redaction would rewrite is
  // refused rather than silently renamed.
  const ids = runs.map((run) => {
    const runId = run?.runId;
    if (
      !isIdentifier(runId) ||
      (previous !== undefined && runId <= previous) ||
      redact(runId) !== runId
    ) {
      return refuse('SPANS_SERVICE_CORRUPT');
    }
    previous = runId;
    return runId;
  });
  return { hasMore, ids };
}

function validatedEvents(result, request) {
  const { events, hasMore } = result;
  if (
    !(
      Array.isArray(events) &&
      typeof hasMore === 'boolean' &&
      events.length <= request.limit
    )
  ) {
    return refuse('SPANS_SERVICE_CORRUPT');
  }
  let previous = request.afterSequence;
  for (const event of events) {
    if (
      !(
        isPlainObject(event) &&
        isCount(event.sequence) &&
        event.sequence > previous &&
        event.runId === request.runId &&
        isIdentifier(event.eventId) &&
        isIdentifier(event.type) &&
        'payload' in event
      )
    ) {
      return refuse('SPANS_SERVICE_CORRUPT');
    }
    previous = event.sequence;
  }
  return { events, hasMore };
}

// Only an explicit { ok: true, found: boolean } from the injected index
// authorizes a read; every other outcome is "cannot tell", never "allowed".
function referenceOutcome(outcome) {
  if (
    outcome === null ||
    typeof outcome !== 'object' ||
    outcome.ok !== true ||
    typeof outcome.found !== 'boolean'
  ) {
    return refuse('SPANS_SERVICE_UNAVAILABLE');
  }
  return outcome.found;
}

// Artifacts are re-redacted on the way out. JSON is re-serialized from its
// parsed, redacted value so the text stays valid JSON.
function inertText(artifact) {
  const { mediaType, text } = artifact;
  if (!(inertMediaTypes.has(mediaType) && typeof text === 'string')) {
    return refuse('SPANS_SERVICE_CORRUPT');
  }
  if (mediaType === 'text/plain') {
    return redact(text);
  }
  try {
    return JSON.stringify(redact(JSON.parse(text)));
  } catch {
    return refuse('SPANS_SERVICE_CORRUPT');
  }
}

function validatedOptions(options) {
  const keys = isPlainObject(options) ? Reflect.ownKeys(options) : [];
  if (!(keys.length > 0 && keys.every((key) => optionKeys.has(key)))) {
    throw new TypeError('createSpansService requires { store, artifacts }.');
  }
  const { artifacts, getArtifactReference, store } = options;
  if (
    !(
      typeof store?.listRuns === 'function' &&
      typeof store.readRun === 'function' &&
      typeof store.readEvents === 'function' &&
      typeof artifacts?.read === 'function'
    )
  ) {
    throw new TypeError(
      'createSpansService requires an opened spans store and artifact reader.'
    );
  }
  if (
    getArtifactReference !== undefined &&
    getArtifactReference !== null &&
    typeof getArtifactReference !== 'function'
  ) {
    throw new TypeError('getArtifactReference must be a function.');
  }
  return { artifacts, getArtifactReference, store };
}

/**
 * Read-only service over an injected store and artifact reader. There is no
 * default root and nothing is opened here. `getArtifactReference` is the only
 * authority for "this artifact belongs to this run"; without it artifact reads
 * are unavailable rather than globally authorized.
 */
export function createSpansService(options) {
  const { artifacts, getArtifactReference, store } = validatedOptions(options);
  const storeListRuns = store.listRuns.bind(store);
  const storeReadRun = store.readRun.bind(store);
  const storeReadEvents = store.readEvents.bind(store);
  const readArtifact = artifacts.read.bind(artifacts);
  const referenceOf = getArtifactReference ?? undefined;

  const readRecord = async (
    runId,
    { notFound = 'SPANS_SERVICE_NOT_FOUND', summary = false } = {}
  ) => {
    let result;
    try {
      result = unwrap(await storeReadRun({ runId }), storeCodes);
    } catch (error) {
      if (
        error instanceof Refusal &&
        error.code === 'SPANS_SERVICE_NOT_FOUND'
      ) {
        return refuse(notFound);
      }
      throw error;
    }
    return toRecord(runId, result, summary);
  };

  return Object.freeze({
    getArtifact: (input) =>
      guarded(async () => {
        const request = normalizeArtifactRef(input);
        if (!referenceOf) {
          return refuse('SPANS_SERVICE_UNAVAILABLE');
        }
        const referenced = referenceOutcome(
          await referenceOf({
            artifactId: request.artifactId,
            runId: request.runId,
          })
        );
        // Denial and absence answer identically so callers cannot probe which
        // artifacts exist in other runs.
        if (!referenced) {
          return refuse('SPANS_SERVICE_NOT_FOUND');
        }
        const artifact = unwrap(
          await readArtifact({ artifactId: request.artifactId }),
          artifactCodes
        );
        return {
          artifactId: request.artifactId,
          mediaType: artifact.mediaType,
          ok: true,
          runId: request.runId,
          text: inertText(artifact),
        };
      }),

    getEvents: (input) =>
      guarded(async () => {
        const request = normalizeEvents(input);
        const result = unwrap(
          await storeReadEvents({
            afterSequence: request.afterSequence,
            limit: request.limit,
            runId: request.runId,
          }),
          storeCodes
        );
        const { events, hasMore } = validatedEvents(result, request);
        return {
          events: events.map(redact),
          hasMore,
          nextSequence: events.at(-1)?.sequence ?? request.afterSequence,
          ok: true,
        };
      }),

    getRun: (input) =>
      guarded(async () => {
        const { runId } = normalizeRunRef(input);
        return { ok: true, record: await readRecord(runId) };
      }),

    listRuns: (input) =>
      guarded(async () => {
        const request = normalizeList(input);
        const page = unwrap(
          await storeListRuns({
            ...(request.afterRunId === undefined
              ? {}
              : { afterRunId: request.afterRunId }),
            limit: request.limit,
            ...(request.phase === undefined ? {} : { phase: request.phase }),
            ...(request.query === undefined ? {} : { query: request.query }),
          }),
          storeCodes
        );
        const { hasMore, ids } = validatedSummaries(page, request);
        // Only this page is hydrated. A listed run that cannot be read means
        // the archive disagrees with itself, so the whole page fails closed.
        const records = await Promise.all(
          ids.map((runId) =>
            readRecord(runId, {
              notFound: 'SPANS_SERVICE_CORRUPT',
              summary: true,
            })
          )
        );
        return {
          hasMore,
          nextRunId: ids.at(-1) ?? request.afterRunId ?? null,
          ok: true,
          records,
        };
      }),
  });
}
