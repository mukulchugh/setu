import { setImmediate as yieldToEventLoop } from 'node:timers/promises';
import { parseSpansCmuxRecord, spansCmuxDeliveryEvent } from './spans-cmux.js';
import {
  canonicalJson,
  exactRequest,
  isExplicitId,
} from './spans-execution-core.js';

const PAGE_SIZE = 200;
const MAX_PROJECTIONS = 64;
const EVENT_TYPE = 'spans.cmux.delivery';
const failed = (code = 'PERSIST_FAILED') => ({ code, ok: false });
const count = (value) => Number.isSafeInteger(value) && value >= 0;

function parseInput(raw) {
  const operation = exactRequest(
    raw,
    ['assignmentId', 'op', 'runId'],
    ['event', 'expected', 'generation', 'record']
  );
  if (
    !(
      operation &&
      isExplicitId(operation.runId) &&
      isExplicitId(operation.assignmentId)
    )
  ) {
    return null;
  }
  if (operation.op === 'read') {
    return exactRequest(raw, ['assignmentId', 'op', 'runId']);
  }
  if (operation.op !== 'write') {
    return null;
  }
  const input = exactRequest(raw, [
    'assignmentId',
    'event',
    'expected',
    'generation',
    'op',
    'record',
    'runId',
  ]);
  if (!(input && count(input.generation))) {
    return null;
  }
  const record = parseSpansCmuxRecord(
    input.record,
    input.runId,
    input.assignmentId
  );
  const expected =
    input.expected === null
      ? null
      : exactRequest(input.expected, ['deliveryAttempt', 'phase']);
  if (
    !record ||
    record.generation !== input.generation ||
    (input.expected !== null &&
      !(
        expected &&
        count(expected.deliveryAttempt) &&
        typeof expected.phase === 'string'
      ))
  ) {
    return null;
  }
  const supplied = exactRequest(input.event, [
    'eventId',
    'payload',
    'runId',
    'type',
  ]);
  const payload =
    supplied &&
    parseSpansCmuxRecord(supplied.payload, input.runId, input.assignmentId);
  const event = spansCmuxDeliveryEvent(record);
  if (
    !payload ||
    canonicalJson({ ...supplied, payload }) !== canonicalJson(event)
  ) {
    return null;
  }
  return { ...input, event, expected, record };
}

function currentRun(store, runId) {
  const result = store.readRun({ runId });
  if (
    !(
      result?.ok === true &&
      count(result.generation) &&
      count(result.revision) &&
      result.view?.generation === result.generation
    )
  ) {
    return null;
  }
  return result;
}

function recordFromEvent(event, runId, assignmentId) {
  const record = parseSpansCmuxRecord(event.payload, runId, assignmentId);
  if (!record || spansCmuxDeliveryEvent(record).eventId !== event.eventId) {
    throw new Error('Invalid retained cmux delivery');
  }
  return record;
}

function expectedMatches(record, expected) {
  return record
    ? expected?.phase === record.phase &&
        expected.deliveryAttempt === record.deliveryAttempt
    : expected === null;
}

function projectPage(page, { assignmentId, cursor, record, runId }) {
  if (
    !(
      page?.ok === true &&
      Array.isArray(page.events) &&
      page.events.length <= PAGE_SIZE &&
      typeof page.hasMore === 'boolean' &&
      count(page.nextSequence)
    )
  ) {
    throw new Error('Delivery history unavailable');
  }
  for (const event of page.events) {
    if (
      !(
        count(event.sequence) &&
        event.sequence > cursor &&
        event.runId === runId
      )
    ) {
      throw new Error('Delivery history cursor invalid');
    }
    cursor = event.sequence;
    if (event.type !== EVENT_TYPE) {
      continue;
    }
    if (!isExplicitId(event.payload?.assignmentId)) {
      throw new Error('Delivery history has no assignment identity');
    }
    if (event.payload.assignmentId === assignmentId) {
      record = recordFromEvent(event, runId, assignmentId);
    }
  }
  if (
    cursor !== page.nextSequence ||
    (page.hasMore && page.events.length === 0)
  ) {
    throw new Error('Delivery history did not advance');
  }
  return { cursor, record };
}

async function commitRecord(store, writeArchive, current, input) {
  let invoked = false;
  let duplicate = false;
  let settled = false;
  let completed;
  let result;
  try {
    result = await writeArchive(() => {
      if (invoked || settled) {
        duplicate = true;
        return { ok: false, unknown: true };
      }
      invoked = true;
      completed = store.commitRun({
        events: [input.event],
        expectedGeneration: current.generation,
        expectedRevision: current.revision,
        runId: input.runId,
        view: current.view,
      });
      return completed;
    });
  } catch {
    result = undefined;
  } finally {
    settled = true;
  }
  if (!invoked) {
    return failed();
  }
  if (duplicate || result !== completed) {
    return { ok: false, unknown: true };
  }
  if (result?.ok === true) {
    return { ok: true };
  }
  if (result?.code === 'SPANS_MODEL_STALE_GENERATION') {
    return failed('STALE_GENERATION');
  }
  if (result?.code === 'SPANS_MODEL_STALE_REVISION') {
    return failed('PHASE_CONFLICT');
  }
  return { ok: false, unknown: true };
}

// The event log is authoritative. These bounded read projections only skip
// already-read immutable events; every access still reads the committed tail.
// Writes append the transport's existing event and CAS the unchanged run view,
// so no supplemental schema, mutation cache or second persistence owner exists.
export function createSpansCmuxPersistence({ store, writeArchive } = {}) {
  if (
    !(
      store &&
      ['commitRun', 'readEvents', 'readRun'].every(
        (key) => typeof store[key] === 'function'
      )
    ) ||
    typeof writeArchive !== 'function'
  ) {
    throw new TypeError(
      'Cmux persistence requires the run store and admitted archive writer.'
    );
  }
  const projections = new Map();

  async function readRecord(runId, assignmentId) {
    const key = JSON.stringify([runId, assignmentId]);
    let projection = projections.get(key) ?? { cursor: 0, record: null };
    let more;
    do {
      const page = store.readEvents({
        afterSequence: projection.cursor,
        limit: PAGE_SIZE,
        runId,
      });
      projection = projectPage(page, { ...projection, assignmentId, runId });
      more = page.hasMore;
      if (more) {
        // biome-ignore lint/performance/noAwaitInLoops: Cold history projection yields between bounded pages so the portal can serve other requests.
        await yieldToEventLoop();
      }
    } while (more);
    projections.delete(key);
    projections.set(key, projection);
    if (projections.size > MAX_PROJECTIONS) {
      projections.delete(projections.keys().next().value);
    }
    return projection.record;
  }

  async function persist(raw) {
    const input = parseInput(raw);
    if (!input) {
      return failed('REQUEST_INVALID');
    }
    const current = currentRun(store, input.runId);
    if (!current) {
      return failed('RECORD_READ_FAILED');
    }
    const previous = await readRecord(input.runId, input.assignmentId);
    if (input.op === 'read') {
      return {
        generation: current.generation,
        ok: true,
        record: previous ? structuredClone(previous) : null,
      };
    }
    if (current.generation !== input.generation) {
      return failed('STALE_GENERATION');
    }
    if (current.view.readOnly === true || current.view.kind === 'imported') {
      return failed('RUN_READ_ONLY');
    }
    if (
      current.view.planVersion !== input.record.planVersion ||
      !Object.hasOwn(current.view.spans ?? {}, input.record.spanId) ||
      !expectedMatches(previous, input.expected)
    ) {
      return failed('PHASE_CONFLICT');
    }

    return commitRecord(store, writeArchive, current, input);
  }

  return async (input) => {
    try {
      return await persist(input);
    } catch {
      return failed();
    }
  };
}
