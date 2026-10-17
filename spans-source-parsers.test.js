import { expect, test } from 'bun:test';
import { parseSpansSourceRecord } from './spans-source-parsers.js';

const source = {
  parserVersion: 'a5-parser-1',
  sourceGeneration: 3,
  sourceId: 'source-a5',
};

const codexUser = {
  payload: {
    content: [{ text: 'Add a parser.', type: 'input_text' }],
    id: 'codex-msg-1',
    role: 'user',
    type: 'message',
  },
  type: 'response_item',
};

const claudeAssistant = {
  message: {
    content: [
      { text: 'Running the check.', type: 'text' },
      {
        id: 'toolu_1',
        input: { command: 'bun test spans-source-parsers.test.js' },
        name: 'Bash',
        type: 'tool_use',
      },
      { content: 'ok 3 pass', tool_use_id: 'toolu_1', type: 'tool_result' },
    ],
    role: 'assistant',
  },
  type: 'assistant',
  uuid: 'claude-uuid-1',
};

test('parses the documented Codex message shape with native ID and complete coverage', () => {
  const result = parseSpansSourceRecord({
    provider: 'codex',
    record: codexUser,
    ...source,
  });
  expect(result).toEqual({
    event: {
      contentBlocks: [{ kind: 'text', text: 'Add a parser.' }],
      coverage: { reason: null, state: 'complete' },
      kind: 'message',
      nativeId: 'codex-msg-1',
      parserVersion: 'a5-parser-1',
      provider: 'codex',
      role: 'user',
      sourceGeneration: 3,
      sourceId: 'source-a5',
      text: 'Add a parser.',
      toolBlocks: [],
    },
    ok: true,
  });
});

test('joins Codex input and output text items in order', () => {
  const result = parseSpansSourceRecord({
    provider: 'codex',
    record: {
      payload: {
        content: [
          { text: 'First.', type: 'output_text' },
          { text: 'Second.', type: 'output_text' },
        ],
        id: 'codex-msg-2',
        role: 'assistant',
        type: 'message',
      },
      type: 'response_item',
    },
    ...source,
  });
  expect(result.ok).toBe(true);
  expect(result.event.role).toBe('assistant');
  expect(result.event.text).toBe('First.\nSecond.');
});

test('parses Claude string content and list text content', () => {
  const stringResult = parseSpansSourceRecord({
    provider: 'claude',
    record: {
      message: { content: 'Plain prompt.', role: 'user' },
      type: 'user',
      uuid: 'claude-uuid-2',
    },
    ...source,
  });
  expect(stringResult.ok).toBe(true);
  expect(stringResult.event.text).toBe('Plain prompt.');
  expect(stringResult.event.nativeId).toBe('claude-uuid-2');
  expect(stringResult.event.coverage).toEqual({
    reason: null,
    state: 'complete',
  });

  const listResult = parseSpansSourceRecord({
    provider: 'claude',
    record: {
      message: {
        content: [
          { text: 'Part one.', type: 'text' },
          { text: 'Part two.', type: 'text' },
        ],
        role: 'assistant',
      },
      type: 'assistant',
      uuid: 'claude-uuid-3',
    },
    ...source,
  });
  expect(listResult.ok).toBe(true);
  expect(listResult.event.text).toBe('Part one.\nPart two.');
  expect(listResult.event.toolBlocks).toEqual([]);
});

test('keeps mixed tool blocks as JSON data and out of prose', () => {
  const result = parseSpansSourceRecord({
    provider: 'claude',
    record: claudeAssistant,
    ...source,
  });
  expect(result.ok).toBe(true);
  expect(result.event.text).toBe('Running the check.');
  expect(result.event.toolBlocks).toEqual([
    claudeAssistant.message.content[1],
    claudeAssistant.message.content[2],
  ]);
  expect(result.event.coverage).toEqual({ reason: null, state: 'complete' });
});

test('leaves native ID null when the source omits it', () => {
  const codexWithoutId = {
    payload: {
      content: [{ text: 'No ID here.', type: 'input_text' }],
      role: 'user',
      type: 'message',
    },
    type: 'response_item',
  };
  const claudeWithoutUuid = {
    message: { content: 'No uuid here.', role: 'user' },
    type: 'user',
  };
  const codexResult = parseSpansSourceRecord({
    provider: 'codex',
    record: codexWithoutId,
    ...source,
  });
  const claudeResult = parseSpansSourceRecord({
    provider: 'claude',
    record: claudeWithoutUuid,
    ...source,
  });
  expect(codexResult.ok).toBe(true);
  expect(codexResult.event.nativeId).toBeNull();
  expect(claudeResult.ok).toBe(true);
  expect(claudeResult.event.nativeId).toBeNull();
});

test('refuses malformed records with invalid coverage and no event', () => {
  const cases = {
    'claude content a number': {
      provider: 'claude',
      record: {
        message: { content: 42, role: 'user' },
        type: 'user',
      },
    },
    'claude message missing': {
      provider: 'claude',
      record: { type: 'user', uuid: 'x' },
    },
    'claude role mismatch': {
      provider: 'claude',
      record: {
        message: { content: 'mismatch', role: 'assistant' },
        type: 'user',
      },
    },
    'claude text block without text': {
      provider: 'claude',
      record: {
        message: { content: [{ type: 'text' }], role: 'user' },
        type: 'user',
      },
    },
    'claude tool block with a function': {
      provider: 'claude',
      record: {
        message: {
          content: [
            {
              id: 't',
              input: {
                run() {
                  return 'ran';
                },
              },
              type: 'tool_use',
            },
          ],
          role: 'assistant',
        },
        type: 'assistant',
      },
    },
    'claude tool block with non-finite number': {
      provider: 'claude',
      record: {
        message: {
          content: [{ id: 't', input: { n: Number.NaN }, type: 'tool_use' }],
          role: 'assistant',
        },
        type: 'assistant',
      },
    },
    'codex content not a list': {
      provider: 'codex',
      record: {
        payload: { content: 'hi', role: 'user', type: 'message' },
        type: 'response_item',
      },
    },
    'codex function call without call_id': {
      provider: 'codex',
      record: {
        payload: { arguments: '{}', name: 'shell', type: 'function_call' },
        type: 'response_item',
      },
    },
    'codex function output without output': {
      provider: 'codex',
      record: {
        payload: { call_id: 'call_1', type: 'function_call_output' },
        type: 'response_item',
      },
    },
    'codex numeric id': {
      provider: 'codex',
      record: {
        payload: {
          content: [],
          id: 7,
          role: 'user',
          type: 'message',
        },
        type: 'response_item',
      },
    },
    'codex payload missing': {
      provider: 'codex',
      record: { type: 'response_item' },
    },
    'codex text item without text': {
      provider: 'codex',
      record: {
        payload: {
          content: [{ type: 'input_text' }],
          role: 'user',
          type: 'message',
        },
        type: 'response_item',
      },
    },
    'record is an array': { provider: 'claude', record: [] },
    'record is null': { provider: 'codex', record: null },
  };
  const outcomes = Object.entries(cases).map(([name, input]) => {
    const result = parseSpansSourceRecord({ ...input, ...source });
    return {
      code: result.code,
      hasEvent: 'event' in result,
      name,
      ok: result.ok,
      state: result.coverage.state,
    };
  });
  expect(outcomes).toEqual(
    Object.keys(cases).map((name) => ({
      code: 'SOURCE_RECORD_INVALID',
      hasEvent: false,
      name,
      ok: false,
      state: 'partial',
    }))
  );
});

test('refuses unsupported providers and record variants without inventing messages', () => {
  const cases = {
    'claude summary record': {
      provider: 'claude',
      record: { summary: 'Compacted.', type: 'summary' },
    },
    'codex custom tool call': {
      provider: 'codex',
      record: {
        payload: {
          call_id: 'call_1',
          input: '*** Begin Patch',
          name: 'apply_patch',
          type: 'custom_tool_call',
        },
        type: 'response_item',
      },
    },
    'codex event record': {
      provider: 'codex',
      record: { payload: {}, type: 'event_msg' },
    },
    'codex hidden reasoning': {
      provider: 'codex',
      record: {
        payload: { summary: [], type: 'reasoning' },
        type: 'response_item',
      },
    },
    'codex unknown message role': {
      provider: 'codex',
      record: {
        payload: {
          content: [{ text: 'Unlisted role.', type: 'input_text' }],
          role: 'moderator',
          type: 'message',
        },
        type: 'response_item',
      },
    },
    'unknown provider': { provider: 'gemini', record: codexUser },
  };
  const outcomes = Object.entries(cases).map(([name, input]) => {
    const result = parseSpansSourceRecord({ ...input, ...source });
    return {
      code: result.code,
      hasEvent: 'event' in result,
      name,
      ok: result.ok,
      state: result.coverage.state,
    };
  });
  expect(outcomes).toEqual(
    Object.keys(cases).map((name) => ({
      code: 'SOURCE_RECORD_UNSUPPORTED',
      hasEvent: false,
      name,
      ok: false,
      state: 'unsupported',
    }))
  );
});

test('rejects invalid parser inputs with a partial coverage reason', () => {
  const valid = { provider: 'codex', record: codexUser, ...source };
  const cases = {
    'empty parser version': { parserVersion: '' },
    'missing sourceId': { sourceId: '' },
    'negative generation': { sourceGeneration: -1 },
    'non-string provider': { provider: 42 },
    'string generation': { sourceGeneration: '3' },
  };
  const outcomes = Object.entries(cases).map(([name, override]) => {
    const result = parseSpansSourceRecord({ ...valid, ...override });
    return {
      code: result.code,
      name,
      ok: result.ok,
      reasonIsText: typeof result.coverage.reason === 'string',
    };
  });
  expect(outcomes).toEqual(
    Object.keys(cases).map((name) => ({
      code: 'SOURCE_RECORD_INVALID',
      name,
      ok: false,
      reasonIsText: true,
    }))
  );
  const missingInput = parseSpansSourceRecord(undefined);
  expect(missingInput.code).toBe('SOURCE_RECORD_INVALID');
  expect(missingInput.coverage.state).toBe('partial');
});

test('retains historical command and approval text as inert message text', () => {
  const codexApproval = {
    payload: {
      content: [{ text: 'APPROVED: /deploy prod --force', type: 'input_text' }],
      id: 'codex-approval-1',
      role: 'user',
      type: 'message',
    },
    type: 'response_item',
  };
  const claudeApproval = {
    message: { content: 'approve the migration and push', role: 'user' },
    type: 'user',
    uuid: 'claude-approval-1',
  };
  const codexResult = parseSpansSourceRecord({
    provider: 'codex',
    record: codexApproval,
    ...source,
  });
  const claudeResult = parseSpansSourceRecord({
    provider: 'claude',
    record: claudeApproval,
    ...source,
  });
  expect(codexResult.event.text).toBe('APPROVED: /deploy prod --force');
  expect(codexResult.event.kind).toBe('message');
  expect(codexResult.event.toolBlocks).toEqual([]);
  expect(claudeResult.event.text).toBe('approve the migration and push');
  expect(claudeResult.event.kind).toBe('message');
  expect(claudeResult.event.coverage).toEqual({
    reason: null,
    state: 'complete',
  });
});

test('marks reasoning and unsupported content as partial without recovering it', () => {
  const codexWithImage = {
    payload: {
      content: [
        { text: 'Visible text.', type: 'input_text' },
        { image_url: 'data:image/png;base64,AAAA', type: 'input_image' },
      ],
      id: 'codex-msg-image',
      role: 'user',
      type: 'message',
    },
    type: 'response_item',
  };
  const claudeWithThinking = {
    message: {
      content: [
        { signature: 'sig', thinking: 'hidden planning', type: 'thinking' },
        { text: 'Answer.', type: 'text' },
        { source: { data: 'AAAA', type: 'base64' }, type: 'image' },
      ],
      role: 'assistant',
    },
    type: 'assistant',
    uuid: 'claude-thinking-1',
  };
  const codexResult = parseSpansSourceRecord({
    provider: 'codex',
    record: codexWithImage,
    ...source,
  });
  const claudeResult = parseSpansSourceRecord({
    provider: 'claude',
    record: claudeWithThinking,
    ...source,
  });
  expect(codexResult.ok).toBe(true);
  expect(codexResult.event.text).toBe('Visible text.');
  expect(codexResult.event.coverage).toEqual({
    reason: 'attachment content not retained',
    state: 'partial',
  });
  expect(claudeResult.ok).toBe(true);
  expect(claudeResult.event.text).toBe('Answer.');
  expect(claudeResult.event.coverage).toEqual({
    reason: 'reasoning unavailable; attachment content not retained',
    state: 'partial',
  });
  expect(JSON.stringify(claudeResult)).not.toContain('hidden planning');
});

test('does not mutate the input record and returns detached tool data', () => {
  const record = structuredClone(claudeAssistant);
  const snapshot = JSON.stringify(record);
  const result = parseSpansSourceRecord({
    provider: 'claude',
    record,
    ...source,
  });
  expect(JSON.stringify(record)).toBe(snapshot);
  result.event.toolBlocks[0].name = 'Changed';
  expect(record.message.content[1].name).toBe('Bash');
});

test('keeps text and tool content in source order as detached blocks', () => {
  const record = {
    message: {
      content: [
        { text: 'Before.', type: 'text' },
        {
          id: 'toolu_2',
          input: { path: 'a.txt' },
          name: 'Read',
          type: 'tool_use',
        },
        { text: 'Between.', type: 'text' },
        { content: 'contents', tool_use_id: 'toolu_2', type: 'tool_result' },
        { text: 'After.', type: 'text' },
      ],
      role: 'assistant',
    },
    type: 'assistant',
    uuid: 'claude-order-1',
  };
  const result = parseSpansSourceRecord({
    provider: 'claude',
    record,
    ...source,
  });
  expect(result.ok).toBe(true);
  expect(result.event.text).toBe('Before.\nBetween.\nAfter.');
  expect(result.event.contentBlocks).toEqual([
    { kind: 'text', text: 'Before.' },
    { data: record.message.content[1], kind: 'tool' },
    { kind: 'text', text: 'Between.' },
    { data: record.message.content[3], kind: 'tool' },
    { kind: 'text', text: 'After.' },
  ]);
  expect(result.event.toolBlocks).toEqual([
    record.message.content[1],
    record.message.content[3],
  ]);
  expect(result.event.coverage).toEqual({ reason: null, state: 'complete' });

  result.event.contentBlocks[1].data.input.path = 'changed';
  result.event.toolBlocks[1].content = 'changed';
  expect(record.message.content[1].input.path).toBe('a.txt');
  expect(record.message.content[3].content).toBe('contents');
  expect(result.event.toolBlocks[0].input.path).toBe('a.txt');
  expect(result.event.contentBlocks[3].data.content).toBe('contents');
});

test('preserves attachment descriptors without fetching or decoding blobs', () => {
  const fetchCalls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (...args) => {
    fetchCalls.push(args);
    throw new Error('fetch must not run');
  };
  let claudeResult;
  let codexResult;
  try {
    claudeResult = parseSpansSourceRecord({
      provider: 'claude',
      record: {
        message: {
          content: [
            { text: 'See attached.', type: 'text' },
            {
              source: {
                data: 'iVBORw0KGgo=',
                media_type: 'image/png',
                type: 'base64',
              },
              type: 'image',
            },
            {
              source: { type: 'url', url: 'https://example.test/spec.pdf' },
              type: 'document',
            },
          ],
          role: 'user',
        },
        type: 'user',
        uuid: 'claude-attachment-1',
      },
      ...source,
    });
    codexResult = parseSpansSourceRecord({
      provider: 'codex',
      record: {
        payload: {
          content: [
            {
              image_url: 'data:image/jpeg;base64,/9j/AAAA',
              type: 'input_image',
            },
            { image_url: 'synthetic/shot.png', type: 'input_image' },
          ],
          id: 'codex-attachment-1',
          role: 'user',
          type: 'message',
        },
        type: 'response_item',
      },
      ...source,
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
  expect(fetchCalls).toEqual([]);
  expect(claudeResult.event.contentBlocks).toEqual([
    { kind: 'text', text: 'See attached.' },
    {
      attachmentType: 'image',
      kind: 'attachment',
      mediaType: 'image/png',
      source: 'inline',
    },
    {
      attachmentType: 'document',
      kind: 'attachment',
      reference: 'https://example.test/spec.pdf',
      source: 'reference',
    },
  ]);
  expect(claudeResult.event.coverage).toEqual({
    reason: 'attachment content not retained',
    state: 'partial',
  });
  expect(codexResult.event.contentBlocks).toEqual([
    {
      attachmentType: 'input_image',
      kind: 'attachment',
      mediaType: 'image/jpeg',
      source: 'inline',
    },
    {
      attachmentType: 'input_image',
      kind: 'attachment',
      reference: 'synthetic/shot.png',
      source: 'reference',
    },
  ]);
  const serialized = JSON.stringify([claudeResult, codexResult]);
  expect(serialized).not.toContain('iVBORw0KGgo=');
  expect(serialized).not.toContain('/9j/AAAA');
});

test('retains unsupported block kinds as opaque source data with partial coverage', () => {
  const serverTool = {
    id: 'srv_1',
    input: { query: 'spans' },
    name: 'web_search',
    type: 'server_tool_use',
  };
  const claudeResult = parseSpansSourceRecord({
    provider: 'claude',
    record: {
      message: {
        content: [{ text: 'Searching.', type: 'text' }, serverTool],
        role: 'assistant',
      },
      type: 'assistant',
      uuid: 'claude-opaque-1',
    },
    ...source,
  });
  const codexFile = { file_id: 'file-1', type: 'input_file' };
  const codexResult = parseSpansSourceRecord({
    provider: 'codex',
    record: {
      payload: {
        content: [codexFile],
        id: 'codex-opaque-1',
        role: 'user',
        type: 'message',
      },
      type: 'response_item',
    },
    ...source,
  });
  expect(claudeResult.ok).toBe(true);
  expect(claudeResult.event.contentBlocks).toEqual([
    { kind: 'text', text: 'Searching.' },
    { data: serverTool, kind: 'opaque' },
  ]);
  expect(claudeResult.event.toolBlocks).toEqual([]);
  expect(claudeResult.event.coverage).toEqual({
    reason: 'unsupported Claude content block',
    state: 'partial',
  });
  expect(codexResult.ok).toBe(true);
  expect(codexResult.event.contentBlocks).toEqual([
    { data: codexFile, kind: 'opaque' },
  ]);
  expect(codexResult.event.coverage).toEqual({
    reason: 'unsupported Codex content item',
    state: 'partial',
  });
});

test('pairs Codex function calls and outputs by call_id with distinct native IDs', () => {
  const callPayload = {
    arguments: '{"cmd":"ls"}',
    call_id: 'call_1',
    id: 'fc_1',
    name: 'shell',
    type: 'function_call',
  };
  const outputPayload = {
    call_id: 'call_1',
    output: 'a.js\nb.js',
    type: 'function_call_output',
  };
  const callResult = parseSpansSourceRecord({
    provider: 'codex',
    record: { payload: callPayload, type: 'response_item' },
    ...source,
  });
  const outputResult = parseSpansSourceRecord({
    provider: 'codex',
    record: { payload: outputPayload, type: 'response_item' },
    ...source,
  });
  expect(callResult).toEqual({
    event: {
      contentBlocks: [{ data: callPayload, kind: 'tool' }],
      coverage: { reason: null, state: 'complete' },
      kind: 'message',
      nativeId: 'function_call:fc_1',
      parserVersion: 'a5-parser-1',
      provider: 'codex',
      role: 'assistant',
      sourceGeneration: 3,
      sourceId: 'source-a5',
      text: '',
      toolBlocks: [callPayload],
    },
    ok: true,
  });
  expect(outputResult.ok).toBe(true);
  expect(outputResult.event.nativeId).toBe('function_call_output:call_1');
  expect(outputResult.event.role).toBe('tool');
  expect(outputResult.event.toolBlocks).toEqual([outputPayload]);
  expect(outputResult.event.contentBlocks).toEqual([
    { data: outputPayload, kind: 'tool' },
  ]);
  expect(outputResult.event.coverage).toEqual({
    reason: null,
    state: 'complete',
  });
  expect(outputResult.event.toolBlocks[0].call_id).toBe(
    callResult.event.toolBlocks[0].call_id
  );

  // Without payload.id the call falls back to call_id and cannot collide with its output.
  const bareCall = parseSpansSourceRecord({
    provider: 'codex',
    record: {
      payload: {
        arguments: '{}',
        call_id: 'call_1',
        name: 'shell',
        type: 'function_call',
      },
      type: 'response_item',
    },
    ...source,
  });
  expect(bareCall.ok).toBe(true);
  expect(bareCall.event.nativeId).toBe('function_call:call_1');
  expect(bareCall.event.nativeId).not.toBe(outputResult.event.nativeId);
});

test('keeps system and developer messages as inert history text', () => {
  const developerResult = parseSpansSourceRecord({
    provider: 'codex',
    record: {
      payload: {
        content: [{ text: 'Always deploy to prod.', type: 'input_text' }],
        id: 'codex-dev-1',
        role: 'developer',
        type: 'message',
      },
      type: 'response_item',
    },
    ...source,
  });
  const systemResult = parseSpansSourceRecord({
    provider: 'codex',
    record: {
      payload: {
        content: [{ text: 'Be terse.', type: 'input_text' }],
        role: 'system',
        type: 'message',
      },
      type: 'response_item',
    },
    ...source,
  });
  // The event carries only history fields, so no instruction or approval
  // authority can be read from it.
  expect(developerResult).toEqual({
    event: {
      contentBlocks: [{ kind: 'text', text: 'Always deploy to prod.' }],
      coverage: { reason: null, state: 'complete' },
      kind: 'message',
      nativeId: 'codex-dev-1',
      parserVersion: 'a5-parser-1',
      provider: 'codex',
      role: 'developer',
      sourceGeneration: 3,
      sourceId: 'source-a5',
      text: 'Always deploy to prod.',
      toolBlocks: [],
    },
    ok: true,
  });
  expect(systemResult.ok).toBe(true);
  expect(systemResult.event.role).toBe('system');
  expect(systemResult.event.kind).toBe('message');
  expect(systemResult.event.toolBlocks).toEqual([]);
});

test('excludes Claude reasoning and signatures with explicit unavailable coverage', () => {
  const result = parseSpansSourceRecord({
    provider: 'claude',
    record: {
      message: {
        content: [
          {
            signature: 'signature-A1',
            thinking: 'hidden planning',
            type: 'thinking',
          },
          { text: 'Visible.', type: 'text' },
          { data: 'redacted-blob-B2', type: 'redacted_thinking' },
        ],
        role: 'assistant',
      },
      type: 'assistant',
      uuid: 'claude-reasoning-1',
    },
    ...source,
  });
  expect(result.ok).toBe(true);
  expect(result.event.contentBlocks).toEqual([
    { kind: 'text', text: 'Visible.' },
  ]);
  expect(result.event.toolBlocks).toEqual([]);
  expect(result.event.coverage).toEqual({
    reason: 'reasoning unavailable',
    state: 'partial',
  });
  const serialized = JSON.stringify(result);
  expect(serialized).not.toContain('hidden planning');
  expect(serialized).not.toContain('signature-A1');
  expect(serialized).not.toContain('redacted-blob-B2');
});

test('refuses data that cannot be copied as plain JSON without running accessors', () => {
  let getterCalls = 0;
  const withGetter = { type: 'user', uuid: 'claude-getter-1' };
  Object.defineProperty(withGetter, 'message', {
    enumerable: true,
    get() {
      getterCalls += 1;
      return { content: 'Hidden getter.', role: 'user' };
    },
  });
  const holey = [{ text: 'One.', type: 'text' }];
  holey.length = 2;
  const cyclicMessage = { content: 'Cycle.', role: 'user' };
  cyclicMessage.self = cyclicMessage;
  class RecordInstance {
    constructor() {
      this.type = 'user';
      this.message = { content: 'Class.', role: 'user' };
    }
  }
  const deepRoot = {};
  let deepNode = deepRoot;
  for (let depth = 0; depth < 200; depth += 1) {
    deepNode.child = {};
    deepNode = deepNode.child;
  }
  const cases = {
    'class instance record': new RecordInstance(),
    'cycle in message': { message: cyclicMessage, type: 'user' },
    'getter on record field': withGetter,
    'hole in content list': {
      message: { content: holey, role: 'user' },
      type: 'user',
    },
    'symbol key': {
      message: { content: 'x', role: 'user' },
      type: 'user',
      [Symbol('extra')]: 'y',
    },
    'too deep tool input': {
      message: {
        content: [{ id: 't', input: deepRoot, type: 'tool_use' }],
        role: 'assistant',
      },
      type: 'assistant',
    },
    'undefined field': {
      message: { content: 'x', role: 'user' },
      type: 'user',
      uuid: undefined,
    },
  };
  const outcomes = Object.entries(cases).map(([name, record]) => {
    const result = parseSpansSourceRecord({
      provider: 'claude',
      record,
      ...source,
    });
    return {
      code: result.code,
      hasEvent: 'event' in result,
      name,
      ok: result.ok,
      state: result.coverage.state,
    };
  });
  expect(outcomes).toEqual(
    Object.keys(cases).map((name) => ({
      code: 'SOURCE_RECORD_INVALID',
      hasEvent: false,
      name,
      ok: false,
      state: 'partial',
    }))
  );

  const inputWithGetter = {
    parserVersion: 'a5-parser-1',
    record: codexUser,
    sourceGeneration: 3,
    sourceId: 'source-a5',
  };
  Object.defineProperty(inputWithGetter, 'provider', {
    enumerable: true,
    get() {
      getterCalls += 1;
      return 'codex';
    },
  });
  expect(parseSpansSourceRecord(inputWithGetter).code).toBe(
    'SOURCE_RECORD_INVALID'
  );
  expect(getterCalls).toBe(0);
});

test('keeps record values out of errors and coverage reasons', () => {
  const secret = 'sk-SECRET-VALUE-42';
  const results = [
    parseSpansSourceRecord({
      provider: 'codex',
      record: {
        payload: { content: [], role: secret, type: 'message' },
        type: 'response_item',
      },
      ...source,
    }),
    parseSpansSourceRecord({
      provider: 'codex',
      record: {
        payload: {
          content: [{ note: secret, text: 42, type: 'input_text' }],
          role: 'user',
          type: 'message',
        },
        type: 'response_item',
      },
      ...source,
    }),
    parseSpansSourceRecord({
      provider: 'claude',
      record: { type: secret },
      ...source,
    }),
    parseSpansSourceRecord({
      provider: 'codex',
      record: {
        payload: {
          arguments: { secret },
          call_id: 'call_1',
          name: secret,
          type: 'function_call',
        },
        type: 'response_item',
      },
      ...source,
    }),
    parseSpansSourceRecord({
      provider: 'claude',
      record: {
        message: { content: 'x', role: 'user' },
        type: 'user',
        uuid: { secret },
      },
      ...source,
    }),
  ];
  for (const result of results) {
    expect(result.ok).toBe(false);
    expect(
      JSON.stringify([result.code, result.error, result.coverage])
    ).not.toContain(secret);
  }
});

test('accepts source generations only as non-negative safe integers', () => {
  const base = {
    parserVersion: 'a5-parser-1',
    provider: 'codex',
    record: codexUser,
    sourceId: 'source-a5',
  };
  expect(
    parseSpansSourceRecord({
      ...base,
      sourceGeneration: Number.MAX_SAFE_INTEGER,
    }).ok
  ).toBe(true);
  const refused = [
    Number.MAX_SAFE_INTEGER + 1,
    1.5,
    Number.NaN,
    Number.POSITIVE_INFINITY,
  ].map(
    (sourceGeneration) =>
      parseSpansSourceRecord({ ...base, sourceGeneration }).code
  );
  expect(refused).toEqual([
    'SOURCE_RECORD_INVALID',
    'SOURCE_RECORD_INVALID',
    'SOURCE_RECORD_INVALID',
    'SOURCE_RECORD_INVALID',
  ]);
});

test('keeps Claude citation metadata on text blocks in source order', () => {
  const firstCitation = {
    cited_text: 'Synthetic cited passage.',
    document_index: 0,
    document_title: 'Synthetic Spec',
    end_char_index: 24,
    start_char_index: 0,
    type: 'char_location',
  };
  const secondCitation = {
    cited_text: 'Synthetic search result.',
    title: 'Synthetic Page',
    type: 'web_search_result_location',
    url: 'https://example.test/synthetic-page',
  };
  const toolUse = {
    id: 'toolu_cite',
    input: { path: 'synthetic.txt' },
    name: 'Read',
    type: 'tool_use',
  };
  const toolResult = {
    content: 'synthetic contents',
    tool_use_id: 'toolu_cite',
    type: 'tool_result',
  };
  const record = {
    message: {
      content: [
        {
          citations: [firstCitation],
          text: 'Cited answer.',
          type: 'text',
        },
        toolUse,
        { text: 'Plain follow-up.', type: 'text' },
        toolResult,
        {
          citations: [secondCitation],
          text: 'Second citation.',
          type: 'text',
        },
      ],
      role: 'assistant',
    },
    type: 'assistant',
    uuid: 'claude-cite-1',
  };
  const result = parseSpansSourceRecord({
    provider: 'claude',
    record,
    ...source,
  });
  expect(result.ok).toBe(true);
  expect(result.event.text).toBe(
    'Cited answer.\nPlain follow-up.\nSecond citation.'
  );
  expect(result.event.contentBlocks).toEqual([
    {
      kind: 'text',
      metadata: { citations: [firstCitation] },
      text: 'Cited answer.',
    },
    { data: toolUse, kind: 'tool' },
    { kind: 'text', text: 'Plain follow-up.' },
    { data: toolResult, kind: 'tool' },
    {
      kind: 'text',
      metadata: { citations: [secondCitation] },
      text: 'Second citation.',
    },
  ]);
  expect('metadata' in result.event.contentBlocks[2]).toBe(false);
  expect(result.event.coverage).toEqual({ reason: null, state: 'complete' });

  result.event.contentBlocks[0].metadata.citations[0].cited_text = 'changed';
  expect(record.message.content[0].citations[0].cited_text).toBe(
    'Synthetic cited passage.'
  );
});

test('keeps Codex output annotations as metadata on output text', () => {
  const annotation = {
    end_index: 17,
    start_index: 0,
    title: 'Synthetic Page',
    type: 'url_citation',
    url: 'https://example.test/synthetic',
  };
  const result = parseSpansSourceRecord({
    provider: 'codex',
    record: {
      payload: {
        content: [
          {
            annotations: [annotation],
            text: 'Synthetic answer.',
            type: 'output_text',
          },
          { text: 'No notes.', type: 'output_text' },
        ],
        id: 'codex-annot-1',
        role: 'assistant',
        type: 'message',
      },
      type: 'response_item',
    },
    ...source,
  });
  expect(result).toEqual({
    event: {
      contentBlocks: [
        {
          kind: 'text',
          metadata: { annotations: [annotation] },
          text: 'Synthetic answer.',
        },
        { kind: 'text', text: 'No notes.' },
      ],
      coverage: { reason: null, state: 'complete' },
      kind: 'message',
      nativeId: 'codex-annot-1',
      parserVersion: 'a5-parser-1',
      provider: 'codex',
      role: 'assistant',
      sourceGeneration: 3,
      sourceId: 'source-a5',
      text: 'Synthetic answer.\nNo notes.',
      toolBlocks: [],
    },
    ok: true,
  });
});

test('keeps unknown nested objects inside citations verbatim with complete coverage', () => {
  const futureCitation = {
    span: { end: 9, labels: ['synthetic', 'nested'], start: 1 },
    type: 'future_location',
  };
  const result = parseSpansSourceRecord({
    provider: 'claude',
    record: {
      message: {
        content: [
          {
            citations: [futureCitation],
            text: 'Nested citation.',
            type: 'text',
          },
        ],
        role: 'assistant',
      },
      type: 'assistant',
      uuid: 'claude-nested-1',
    },
    ...source,
  });
  expect(result.ok).toBe(true);
  expect(result.event.contentBlocks).toEqual([
    {
      kind: 'text',
      metadata: { citations: [futureCitation] },
      text: 'Nested citation.',
    },
  ]);
  expect(result.event.coverage).toEqual({ reason: null, state: 'complete' });
});

test('drops unrecognized text block fields and marks coverage partial', () => {
  const claudeResult = parseSpansSourceRecord({
    provider: 'claude',
    record: {
      message: {
        content: [{ experimental_score: 0.5, text: 'Visible.', type: 'text' }],
        role: 'assistant',
      },
      type: 'assistant',
      uuid: 'claude-extra-1',
    },
    ...source,
  });
  const codexResult = parseSpansSourceRecord({
    provider: 'codex',
    record: {
      payload: {
        content: [
          {
            logprobs: [{ logprob: -0.1, token: 'Sco' }],
            text: 'Scored.',
            type: 'output_text',
          },
        ],
        id: 'codex-extra-1',
        role: 'assistant',
        type: 'message',
      },
      type: 'response_item',
    },
    ...source,
  });
  expect(claudeResult.ok).toBe(true);
  expect(claudeResult.event.contentBlocks).toEqual([
    { kind: 'text', text: 'Visible.' },
  ]);
  expect(claudeResult.event.coverage).toEqual({
    reason: 'unrecognized text block metadata not retained',
    state: 'partial',
  });
  expect(codexResult.ok).toBe(true);
  expect(codexResult.event.contentBlocks).toEqual([
    { kind: 'text', text: 'Scored.' },
  ]);
  expect(codexResult.event.coverage).toEqual({
    reason: 'unrecognized text block metadata not retained',
    state: 'partial',
  });
  expect(JSON.stringify([claudeResult, codexResult])).not.toContain('-0.1');
});

test('strips hidden signature fields from text metadata with partial coverage', () => {
  const result = parseSpansSourceRecord({
    provider: 'claude',
    record: {
      message: {
        content: [
          {
            citations: [
              {
                cited_text: 'Synthetic.',
                signature: 'signature-D4',
                type: 'char_location',
              },
            ],
            signature: 'signature-C3',
            text: 'Answer.',
            type: 'text',
          },
        ],
        role: 'assistant',
      },
      type: 'assistant',
      uuid: 'claude-signed-1',
    },
    ...source,
  });
  expect(result.ok).toBe(true);
  expect(result.event.contentBlocks).toEqual([
    {
      kind: 'text',
      metadata: {
        citations: [{ cited_text: 'Synthetic.', type: 'char_location' }],
      },
      text: 'Answer.',
    },
  ]);
  expect(result.event.coverage).toEqual({
    reason: 'hidden block fields not retained',
    state: 'partial',
  });
  const serialized = JSON.stringify(result);
  expect(serialized).not.toContain('signature-C3');
  expect(serialized).not.toContain('signature-D4');
});
