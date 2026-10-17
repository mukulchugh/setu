import type {
  SpansArtifactResult,
  SpansEvent,
  SpansPhase,
  SpansRecord,
} from './spans-types';

export interface SpansPageResult {
  hasMore: boolean;
  nextRunId: string | null;
  ok: true;
  records: SpansRecord[];
}
export interface SpansEventsResult {
  events: SpansEvent[];
  hasMore: boolean;
  nextSequence: number;
  ok: true;
}
const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const count = (value: unknown): value is number =>
  Number.isSafeInteger(value) && Number(value) >= 0;
function isRun(value: unknown): value is SpansRecord {
  return (
    object(value) &&
    typeof value.runId === 'string' &&
    count(value.revision) &&
    count(value.generation) &&
    object(value.view)
  );
}
function isEvent(value: unknown): value is SpansEvent {
  return (
    object(value) &&
    typeof value.eventId === 'string' &&
    typeof value.runId === 'string' &&
    typeof value.type === 'string' &&
    count(value.sequence) &&
    'payload' in value
  );
}
export function decodeSpansPage(value: unknown): SpansPageResult {
  if (
    !(
      object(value) &&
      value.ok === true &&
      Array.isArray(value.records) &&
      value.records.length <= 200 &&
      value.records.every(isRun) &&
      typeof value.hasMore === 'boolean' &&
      (value.nextRunId === null || typeof value.nextRunId === 'string')
    )
  ) {
    throw new Error('Spans run summaries are unavailable.');
  }
  let previous = '';
  for (const record of value.records) {
    if (record.runId <= previous) {
      throw new Error('Spans run summaries are unavailable.');
    }
    previous = record.runId;
  }
  if (
    (value.hasMore && value.records.length === 0) ||
    (value.records.length > 0 && value.nextRunId !== previous)
  ) {
    throw new Error('Spans run summaries are unavailable.');
  }
  return value as unknown as SpansPageResult;
}
export function decodeSpansEvents(
  value: unknown,
  runId: string,
  afterSequence = 0
): SpansEventsResult {
  if (
    !(
      object(value) &&
      value.ok === true &&
      Array.isArray(value.events) &&
      value.events.length <= 200 &&
      value.events.every((event) => isEvent(event) && event.runId === runId) &&
      typeof value.hasMore === 'boolean' &&
      count(value.nextSequence)
    )
  ) {
    throw new Error('Spans history is unavailable.');
  }
  let previous = afterSequence;
  const ids = new Set<string>();
  for (const event of value.events) {
    if (event.sequence <= previous || ids.has(event.eventId)) {
      throw new Error('Spans history is unavailable.');
    }
    previous = event.sequence;
    ids.add(event.eventId);
  }
  if (
    value.nextSequence !== previous ||
    (value.hasMore && value.events.length === 0)
  ) {
    throw new Error('Spans history is unavailable.');
  }
  return value as unknown as SpansEventsResult;
}
async function read(
  path: string,
  query: Record<string, string>,
  signal?: AbortSignal
): Promise<unknown> {
  const response = await fetch(`${path}?${new URLSearchParams(query)}`, {
    signal,
  });
  if (!response.ok) {
    throw new Error('Spans read failed.');
  }
  return response.json();
}
export async function readSpansRuns(
  phase: SpansPhase,
  query: string,
  afterRunId: string,
  signal: AbortSignal
) {
  return decodeSpansPage(
    await read(
      '/api/spans/runs',
      { ...(afterRunId ? { afterRunId } : {}), limit: '50', phase, query },
      signal
    )
  );
}
export async function readSpansRun(
  runId: string,
  signal: AbortSignal
): Promise<SpansRecord> {
  const value = await read('/api/spans/run', { runId }, signal);
  if (
    !(
      object(value) &&
      value.ok === true &&
      isRun(value.record) &&
      value.record.runId === runId
    )
  ) {
    throw new Error('This run is unavailable.');
  }
  return value.record;
}
export async function readSpansEvents(
  runId: string,
  afterSequence: number,
  signal: AbortSignal
) {
  return decodeSpansEvents(
    await read(
      '/api/spans/events',
      { afterSequence: String(afterSequence), limit: '100', runId },
      signal
    ),
    runId,
    afterSequence
  );
}
export async function readSpansArtifact(input: {
  artifactId: string;
  runId: string;
}): Promise<SpansArtifactResult> {
  try {
    const value = await read('/api/spans/artifact', input);
    if (
      object(value) &&
      value.ok === true &&
      value.artifactId === input.artifactId &&
      value.runId === input.runId &&
      typeof value.text === 'string' &&
      (value.mediaType === 'text/plain' ||
        value.mediaType === 'application/json')
    ) {
      return value as unknown as SpansArtifactResult;
    }
  } catch {
    /* A fixed failure avoids exposing transport details. */
  }
  return {
    code: 'SPANS_ARTIFACT_UNAVAILABLE',
    error: 'The saved artifact could not be read. Try again.',
    ok: false,
  };
}
