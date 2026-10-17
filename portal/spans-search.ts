export interface SpansSearchCoverage {
  complete: boolean;
  generation: number;
  indexedSequence: number;
  latestSequence: number;
  stale: boolean;
}

export interface SpansSearchHit {
  eventId: string;
  historical: true;
  runId: string;
  sequence: number;
  snippet: string;
}

export interface SpansSearchResult {
  coverage: SpansSearchCoverage;
  generation: number;
  hasMore: boolean;
  hits: SpansSearchHit[];
  nextSequence: number;
  ok: true;
  throughSequence: number;
}

export interface SpansSearchRequest {
  afterSequence?: number;
  expectedGeneration?: number;
  limit?: number;
  query: string;
  runId?: string;
  throughSequence?: number;
}

const MAX_QUERY_LENGTH = 512;
const MAX_PAGE_LIMIT = 100;
const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export class SpansSearchReadError extends Error {
  readonly code: string;

  constructor(code: string) {
    super(
      code === 'SPANS_SERVICE_STALE'
        ? 'Search results changed. Restart from the first page.'
        : 'History search is unavailable. Try again.'
    );
    this.name = 'SpansSearchReadError';
    this.code = code;
  }
}

const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const count = (value: unknown): value is number =>
  Number.isSafeInteger(value) && Number(value) >= 0;
const identifier = (value: unknown): value is string =>
  typeof value === 'string' && IDENTIFIER_PATTERN.test(value);
const unavailable = (cause?: unknown) =>
  new Error(
    'History search response is unavailable.',
    cause === undefined ? undefined : { cause }
  );

export function canAcceptSpansSearchResponse(
  responseKey: string,
  currentKey: string,
  signal: AbortSignal
): boolean {
  return responseKey === currentKey && !signal.aborted;
}

function validateRequest(request: SpansSearchRequest) {
  const limit = request.limit ?? 50;
  const afterSequence = request.afterSequence ?? 0;
  if (
    typeof request.query !== 'string' ||
    request.query.length < 1 ||
    request.query.length > MAX_QUERY_LENGTH ||
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > MAX_PAGE_LIMIT ||
    !count(afterSequence) ||
    (request.runId !== undefined && !identifier(request.runId)) ||
    (request.throughSequence !== undefined &&
      !count(request.throughSequence)) ||
    (request.expectedGeneration !== undefined &&
      !count(request.expectedGeneration)) ||
    (afterSequence > 0 && request.expectedGeneration === undefined) ||
    (afterSequence > 0 && request.throughSequence === undefined)
  ) {
    throw new Error('Invalid history search request.');
  }
  return { afterSequence, limit };
}

export function decodeSpansSearch(
  value: unknown,
  request: SpansSearchRequest
): SpansSearchResult {
  const { afterSequence, limit } = validateRequest(request);
  if (object(value) && value.ok === false) {
    throw new SpansSearchReadError(
      typeof value.code === 'string' ? value.code : 'SPANS_SERVICE_UNAVAILABLE'
    );
  }
  if (
    !object(value) ||
    value.ok !== true ||
    !Array.isArray(value.hits) ||
    value.hits.length > limit ||
    typeof value.hasMore !== 'boolean' ||
    !count(value.nextSequence) ||
    !count(value.throughSequence) ||
    !count(value.generation) ||
    !object(value.coverage)
  ) {
    throw unavailable();
  }
  const { coverage } = value;
  const {
    complete,
    generation: coverageGeneration,
    indexedSequence,
    latestSequence,
    stale,
  } = coverage;
  if (
    typeof complete !== 'boolean' ||
    typeof stale !== 'boolean' ||
    !count(coverageGeneration) ||
    coverageGeneration !== value.generation ||
    !count(indexedSequence) ||
    !count(latestSequence) ||
    indexedSequence > latestSequence ||
    complete !== (indexedSequence === latestSequence) ||
    stale !== indexedSequence < latestSequence ||
    value.throughSequence > indexedSequence ||
    (request.expectedGeneration !== undefined &&
      value.generation !== request.expectedGeneration) ||
    (request.throughSequence !== undefined &&
      value.throughSequence !== request.throughSequence) ||
    value.throughSequence < afterSequence
  ) {
    throw unavailable();
  }
  const { throughSequence } = value;
  let previous = afterSequence;
  const hits = value.hits.map((hit): SpansSearchHit => {
    if (
      !(object(hit) && identifier(hit.eventId) && identifier(hit.runId)) ||
      (request.runId !== undefined && hit.runId !== request.runId) ||
      !count(hit.sequence) ||
      hit.sequence <= previous ||
      hit.sequence > throughSequence ||
      hit.historical !== true ||
      typeof hit.snippet !== 'string' ||
      hit.snippet.length > 8192
    ) {
      throw unavailable();
    }
    previous = hit.sequence;
    return {
      eventId: hit.eventId,
      historical: true,
      runId: hit.runId,
      sequence: hit.sequence,
      // This stays a string and is rendered as text by the Preact component.
      snippet: hit.snippet,
    };
  });
  if (
    value.nextSequence !== (hits.at(-1)?.sequence ?? afterSequence) ||
    (value.hasMore && hits.length === 0)
  ) {
    throw unavailable();
  }
  return {
    coverage: {
      complete,
      generation: coverageGeneration,
      indexedSequence,
      latestSequence,
      stale,
    },
    generation: value.generation,
    hasMore: value.hasMore,
    hits,
    nextSequence: value.nextSequence,
    ok: true,
    throughSequence: value.throughSequence,
  };
}

export async function readSpansSearch(
  request: SpansSearchRequest,
  signal: AbortSignal
): Promise<SpansSearchResult> {
  validateRequest(request);
  const params = new URLSearchParams({
    limit: String(request.limit ?? 50),
    query: request.query,
    ...(request.afterSequence === undefined
      ? {}
      : { afterSequence: String(request.afterSequence) }),
    ...(request.expectedGeneration === undefined
      ? {}
      : { expectedGeneration: String(request.expectedGeneration) }),
    ...(request.runId ? { runId: request.runId } : {}),
    ...(request.throughSequence === undefined
      ? {}
      : { throughSequence: String(request.throughSequence) }),
  });
  const response = await fetch(`/api/spans/search?${params}`, { signal });
  let value: unknown;
  try {
    value = await response.json();
  } catch (error) {
    throw unavailable(error);
  }
  if (!(response.ok || (object(value) && value.ok === false))) {
    throw unavailable();
  }
  return decodeSpansSearch(value, request);
}

export interface SpansSearchStatus {
  coverage: SpansSearchCoverage;
  generation: number;
  ok: true;
}

export function decodeSpansSearchStatus(value: unknown): SpansSearchStatus {
  if (object(value) && value.ok === false) {
    throw new SpansSearchReadError(
      typeof value.code === 'string' ? value.code : 'SPANS_SERVICE_UNAVAILABLE'
    );
  }
  if (
    !object(value) ||
    value.ok !== true ||
    !count(value.generation) ||
    !object(value.coverage)
  ) {
    throw unavailable();
  }
  const { complete, generation, indexedSequence, latestSequence, stale } =
    value.coverage;
  if (
    typeof complete !== 'boolean' ||
    typeof stale !== 'boolean' ||
    generation !== value.generation ||
    !count(indexedSequence) ||
    !count(latestSequence) ||
    indexedSequence > latestSequence ||
    complete !== (indexedSequence === latestSequence) ||
    stale !== indexedSequence < latestSequence
  ) {
    throw unavailable();
  }
  return {
    coverage: { complete, generation, indexedSequence, latestSequence, stale },
    generation: value.generation,
    ok: true,
  };
}

export async function readSpansSearchStatus(
  signal: AbortSignal
): Promise<SpansSearchStatus> {
  const response = await fetch('/api/spans/search/status', { signal });
  let value: unknown;
  try {
    value = await response.json();
  } catch (error) {
    throw unavailable(error);
  }
  if (!(response.ok || (object(value) && value.ok === false))) {
    throw unavailable();
  }
  return decodeSpansSearchStatus(value);
}
