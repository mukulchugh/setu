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

export interface SpansSearchCacheSource {
  corpusGeneration: string | null;
  corpusHash: string | null;
  parserVersion: string | null;
  toolVersion: string | null;
}

export type SpansSearchCacheEvidence =
  | { kind: 'unavailable' }
  | {
      ageMs: number | null;
      createdAt: number | null;
      hit: boolean;
      key: string | null;
      kind: 'available';
      missReason: string | null;
      persisted: boolean | 'unknown';
      persistenceReason: string | null;
      source: SpansSearchCacheSource | null;
    };

export interface SpansSearchResult {
  cache?: SpansSearchCacheEvidence;
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
const CACHE_KEY_PATTERN = /^sha256:[a-f0-9]{64}$/;
const CACHE_REASON_PATTERN = /^[A-Z][A-Z0-9_]{0,63}$/;
const CACHE_TEXT_LIMIT = 160;
const CACHE_DEPENDENCY_LIMIT = 64;
const MAX_DATE_MILLISECONDS = 8_640_000_000_000_000;
const hasNoControlCharacters = (value: string): boolean => {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 31 || code === 127) {
      return false;
    }
  }
  return true;
};

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
const milliseconds = (value: unknown): value is number =>
  typeof value === 'number' &&
  Number.isFinite(value) &&
  value >= 0 &&
  value <= Number.MAX_SAFE_INTEGER;
const identifier = (value: unknown): value is string =>
  typeof value === 'string' && IDENTIFIER_PATTERN.test(value);
const cacheCode = (value: unknown): string | null =>
  typeof value === 'string' && CACHE_REASON_PATTERN.test(value) ? value : null;
const cacheText = (value: unknown): string | null =>
  typeof value === 'string' &&
  value.length > 0 &&
  value.length <= CACHE_TEXT_LIMIT &&
  hasNoControlCharacters(value)
    ? value
    : null;
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

function decodeCacheSource(value: unknown): SpansSearchCacheSource | null {
  if (!object(value)) {
    return null;
  }
  const versions = object(value.versions) ? value.versions : null;
  let corpus: Record<string, unknown> | null = null;
  if (
    Array.isArray(value.dependencies) &&
    value.dependencies.length <= CACHE_DEPENDENCY_LIMIT
  ) {
    for (const dependency of value.dependencies) {
      if (object(dependency) && dependency.kind === 'corpus') {
        corpus = dependency;
        break;
      }
    }
  }
  const source = {
    corpusGeneration: cacheText(corpus?.generation),
    corpusHash:
      typeof corpus?.digest === 'string' &&
      CACHE_KEY_PATTERN.test(corpus.digest)
        ? corpus.digest
        : null,
    parserVersion: cacheText(versions?.parser),
    toolVersion: cacheText(versions?.tool),
  };
  return Object.values(source).some((field) => field !== null) ? source : null;
}

/** Decode optional cache evidence without making it part of search validity. */
function decodeSpansSearchCacheEvidence(
  value: unknown,
  corpusGeneration: string
): SpansSearchCacheEvidence {
  try {
    if (!object(value)) {
      return { kind: 'unavailable' };
    }
    const metadata = value;
    if (typeof metadata.hit !== 'boolean') {
      return { kind: 'unavailable' };
    }
    const ageValue = metadata.ageMs;
    const persistedValue = metadata.persisted;
    const createdAt =
      milliseconds(metadata.createdAt) &&
      metadata.createdAt <= MAX_DATE_MILLISECONDS
        ? metadata.createdAt
        : null;
    const source = decodeCacheSource(metadata.manifest);
    const key =
      typeof metadata.key === 'string' && CACHE_KEY_PATTERN.test(metadata.key)
        ? metadata.key
        : null;
    const complete = Boolean(
      key &&
        source?.corpusHash &&
        source?.parserVersion &&
        source?.toolVersion &&
        source.corpusGeneration === corpusGeneration
    );
    if (metadata.hit && (!complete || persistedValue !== true)) {
      return { kind: 'unavailable' };
    }
    return {
      ageMs: milliseconds(ageValue) ? ageValue : null,
      createdAt,
      hit: metadata.hit,
      key,
      kind: 'available',
      missReason: cacheCode(metadata.missReason),
      persisted:
        persistedValue === false || (persistedValue === true && complete)
          ? persistedValue
          : 'unknown',
      persistenceReason: cacheCode(metadata.persistenceReason),
      source: source?.corpusGeneration === corpusGeneration ? source : null,
    };
  } catch {
    return { kind: 'unavailable' };
  }
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
    ...(Object.hasOwn(value, 'cache')
      ? {
          cache: decodeSpansSearchCacheEvidence(
            value.cache,
            `${coverageGeneration}:${indexedSequence}:${latestSequence}`
          ),
        }
      : {}),
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
