import { expect, test } from 'bun:test';
import {
  createSpansSearchText,
  SPANS_SEARCH_TEXT_LIMITS,
  SpansSearchTextError,
} from './spans-search-text.js';

const artifactId = `sha256:${'a'.repeat(64)}`;
const identity = {
  nativeId: 'native-1',
  parserVersion: 'parser-1',
  provider: 'codex',
  sourceGeneration: 0,
  sourceId: 'source-1',
};

function artifactResult(overrides = {}, result = {}) {
  return {
    mediaType: 'application/json',
    ok: true,
    text: JSON.stringify({
      ...identity,
      contentBlocks: [{ kind: 'text', text: 'block copy only' }],
      kind: 'message',
      role: 'assistant',
      text: 'artifact words',
      toolBlocks: [{ input: 'tool input words' }],
      ...overrides,
    }),
    ...result,
  };
}

function messageEvent(payload = {}) {
  return {
    eventId: 'event-1',
    payload: {
      ...identity,
      artifactId,
      summary: 'summary words',
      ...payload,
    },
    runId: 'run-a',
    sequence: 1,
    type: 'source.message',
  };
}

function withoutArtifactReference(event) {
  const payload = Object.fromEntries(
    Object.entries(event.payload).filter(([key]) => key !== 'artifactId')
  );
  return { ...event, payload };
}

function selector(result = artifactResult()) {
  const calls = [];
  const textForEvent = createSpansSearchText({
    readArtifact: (request) => {
      calls.push(request);
      return typeof result === 'function' ? result(request) : result;
    },
  });
  return { calls, textForEvent };
}

function codeOf(work) {
  try {
    work();
  } catch (error) {
    expect(error).toBeInstanceOf(SpansSearchTextError);
    expect(JSON.stringify(error)).not.toContain('/');
    return error.code;
  }
  throw new Error('expected a refusal');
}

test('construction requires a reader and performs no read', () => {
  expect(() => createSpansSearchText()).toThrow(TypeError);
  expect(() => createSpansSearchText({ readArtifact: 'no' })).toThrow(
    TypeError
  );
  const { calls } = selector();
  expect(calls).toEqual([]);
});

test('only explicit top-level prose is selected, in a fixed order', () => {
  const { calls, textForEvent } = selector();
  expect(
    textForEvent({
      eventId: 'event-1',
      payload: {
        artifactId,
        goal: 'goal words',
        nested: { summary: 'nested summary' },
        path: '/Users/example/private/session.jsonl',
        rawTranscript: 'raw transcript words',
        sourcePath: '/Users/example/private/session.jsonl',
        summary: 'summary words',
        text: 'text words',
        title: 'title words',
        toolInput: { command: 'tool input words' },
      },
      runId: 'run-a',
      sequence: 1,
      type: 'run.note',
    })
  ).toBe('goal words\ntitle words\nsummary words\ntext words');
  // artifactId on any other event type is never followed.
  expect(calls).toEqual([]);
  expect(
    textForEvent({
      eventId: 'e',
      payload: { summary: 3, text: null },
      runId: 'r',
    })
  ).toBe('');
  expect(textForEvent({ eventId: 'e', payload: [], runId: 'r' })).toBe('');
  expect(textForEvent(undefined)).toBe('');
});

test('prose is read from own data properties only', () => {
  const { textForEvent } = selector();
  const payload = {};
  Object.defineProperty(payload, 'summary', {
    enumerable: true,
    get() {
      throw new Error('getter must not run');
    },
  });
  expect(textForEvent({ eventId: 'e', payload, runId: 'r' })).toBe('');
  expect(
    textForEvent({
      eventId: 'e',
      payload: Object.create({ summary: 'inherited words' }),
      runId: 'r',
    })
  ).toBe('');
});

test('a source.message is indexed from its own artifact text instead of the summary', () => {
  const { calls, textForEvent } = selector();
  const text = textForEvent(messageEvent({ title: 'title words' }));
  expect(text).toBe('title words\nartifact words');
  expect(calls).toEqual([{ artifactId }]);
  // Content blocks, tool blocks and the summary copy are never selected.
  expect(text).not.toContain('block copy only');
  expect(text).not.toContain('tool input words');
  expect(text).not.toContain('summary words');
});

test('a source.message without an artifact reference uses its summary', () => {
  const { calls, textForEvent } = selector();
  const event = withoutArtifactReference(messageEvent());
  expect(textForEvent(event)).toBe('summary words');
  expect(calls).toEqual([]);
});

test('an artifact with empty text still indexes the explicit prose', () => {
  const { textForEvent } = selector(artifactResult({ text: '' }));
  expect(textForEvent(messageEvent({ title: 'title words' }))).toBe(
    'title words'
  );
  expect(textForEvent(messageEvent())).toBe('');
});

test('missing, failing, corrupt or mismatched artifacts are refusals, never empty text', () => {
  const cases = [
    [{ code: 'ARTIFACT_NOT_FOUND', ok: false }, 'artifact-unavailable'],
    [artifactResult({}, { mediaType: 'text/plain' }), 'artifact-unavailable'],
    [artifactResult({}, { text: undefined }), 'artifact-corrupt'],
    [artifactResult({}, { text: '{not json' }), 'artifact-corrupt'],
    [artifactResult({}, { text: '[]' }), 'artifact-corrupt'],
    [artifactResult({ kind: 'tool' }), 'artifact-corrupt'],
    [artifactResult({ text: 12 }), 'artifact-corrupt'],
    [artifactResult({ sourceId: 'other-source' }), 'artifact-mismatch'],
    [artifactResult({ nativeId: 'other-native' }), 'artifact-mismatch'],
    [artifactResult({ provider: 'claude' }), 'artifact-mismatch'],
    [
      artifactResult({
        text: 'x'.repeat(SPANS_SEARCH_TEXT_LIMITS.textBytes + 1),
      }),
      'artifact-too-large',
    ],
    [null, 'artifact-unavailable'],
  ];
  for (const [result, code] of cases) {
    const { textForEvent } = selector(result);
    expect(codeOf(() => textForEvent(messageEvent()))).toBe(code);
  }
  const throwing = selector(() => {
    throw new Error('/private/path secret=do-not-return');
  });
  expect(codeOf(() => throwing.textForEvent(messageEvent()))).toBe(
    'artifact-unavailable'
  );
});

test('a malformed artifact reference is refused before any read', () => {
  for (const bad of ['sha256:short', 7, null, `SHA256:${'a'.repeat(64)}`, '']) {
    const { calls, textForEvent } = selector();
    expect(codeOf(() => textForEvent(messageEvent({ artifactId: bad })))).toBe(
      'artifact-reference'
    );
    expect(calls).toEqual([]);
  }
});

test('text at the document bound is accepted', () => {
  const { textForEvent } = selector(
    artifactResult({ text: 'y'.repeat(SPANS_SEARCH_TEXT_LIMITS.textBytes) })
  );
  expect(textForEvent(messageEvent())).toHaveLength(
    SPANS_SEARCH_TEXT_LIMITS.textBytes
  );
});

test('artifact text uses actual UTF-8 encoded bytes for lone surrogates', () => {
  const text = `${'y'.repeat(SPANS_SEARCH_TEXT_LIMITS.textBytes - 2)}\ud800`;
  const { textForEvent } = selector(artifactResult({ text }));
  expect(codeOf(() => textForEvent(messageEvent()))).toBe('artifact-too-large');
});
