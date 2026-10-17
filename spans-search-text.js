// Selects the searchable prose for one canonical Spans event. Pure: it never
// opens a path or a database, and only calls the injected artifact reader for a
// source.message artifact. Only explicit event prose (goal, title, summary,
// text) and the decoded text of the event's own artifact are returned. Source
// paths, raw unknown payloads, content blocks, tool input and attachment
// metadata are never read. Failures throw a fixed error; the search module
// turns any throw into a page that is not committed.

export const SPANS_SEARCH_TEXT_LIMITS = Object.freeze({
  artifactBytes: 4_194_304,
  textBytes: 4_194_304,
});

const utf8ByteLength = (text) => Buffer.from(text, 'utf8').byteLength;

const proseFields = ['goal', 'title', 'summary', 'text'];
const artifactIdPattern = /^sha256:[a-f0-9]{64}$/;
// An artifact must describe the same source record as the event that cites it.
const artifactIdentityFields = [
  'nativeId',
  'parserVersion',
  'provider',
  'sourceGeneration',
  'sourceId',
];

/** Fixed, path-free refusal. The code is for tests; callers never see it. */
export class SpansSearchTextError extends Error {
  constructor(code) {
    super(code);
    this.name = 'SpansSearchTextError';
    this.code = code;
  }
}

const refuse = (code) => {
  throw new SpansSearchTextError(code);
};

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function ownString(object, key) {
  const descriptor = Object.getOwnPropertyDescriptor(object, key);
  return descriptor &&
    'value' in descriptor &&
    typeof descriptor.value === 'string'
    ? descriptor.value
    : undefined;
}

function ownValue(object, key) {
  const descriptor = Object.getOwnPropertyDescriptor(object, key);
  return descriptor && 'value' in descriptor ? descriptor.value : undefined;
}

// The artifact is the redacted parsed record. Only its top-level `text` is
// used; contentBlocks and toolBlocks are deliberately left unread.
function decodeArtifactText(artifact, payload) {
  if (artifact?.ok !== true || artifact.mediaType !== 'application/json') {
    return refuse('artifact-unavailable');
  }
  if (typeof artifact.text !== 'string') {
    return refuse('artifact-corrupt');
  }
  let record;
  try {
    record = JSON.parse(artifact.text);
  } catch {
    return refuse('artifact-corrupt');
  }
  if (!isPlainObject(record) || ownValue(record, 'kind') !== 'message') {
    return refuse('artifact-corrupt');
  }
  for (const field of artifactIdentityFields) {
    if (ownValue(record, field) !== ownValue(payload, field)) {
      return refuse('artifact-mismatch');
    }
  }
  const text = ownString(record, 'text');
  if (text === undefined) {
    return refuse('artifact-corrupt');
  }
  if (utf8ByteLength(text) > SPANS_SEARCH_TEXT_LIMITS.textBytes) {
    return refuse('artifact-too-large');
  }
  return text;
}

function artifactTextFor(event, payload, readArtifact) {
  if (event.type !== 'source.message') {
    return;
  }
  const artifactId = ownValue(payload, 'artifactId');
  if (artifactId === undefined) {
    return;
  }
  if (typeof artifactId !== 'string' || !artifactIdPattern.test(artifactId)) {
    return refuse('artifact-reference');
  }
  let artifact;
  try {
    artifact = readArtifact({ artifactId });
  } catch {
    return refuse('artifact-unavailable');
  }
  return decodeArtifactText(artifact, payload);
}

/**
 * Build the `textForEvent` callback for createSpansSearch. `readArtifact` is a
 * synchronous reader with the createSpansArtifacts().read contract; it is
 * called at most once per source.message event, for that event's own artifactId.
 * A source.message that cites an artifact is indexed from the artifact text (it
 * contains the summary), and a missing, corrupt, mismatched or oversized
 * artifact throws instead of yielding empty text.
 */
export function createSpansSearchText({ readArtifact } = {}) {
  if (typeof readArtifact !== 'function') {
    throw new TypeError(
      'createSpansSearchText requires a readArtifact function.'
    );
  }
  return function textForEvent(event) {
    const payload = event?.payload;
    if (!isPlainObject(payload)) {
      return '';
    }
    const artifactText = artifactTextFor(event, payload, readArtifact);
    const parts = [];
    for (const field of proseFields) {
      if (field === 'summary' && artifactText !== undefined) {
        continue;
      }
      const value = ownString(payload, field);
      if (value !== undefined && value.length > 0) {
        parts.push(value);
      }
    }
    if (artifactText !== undefined && artifactText.length > 0) {
      parts.push(artifactText);
    }
    return parts.join('\n');
  };
}
