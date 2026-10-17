const providers = new Set(['codex', 'claude']);
const codexRoles = new Set(['user', 'assistant', 'system', 'developer']);
const codexTextTypes = new Set(['input_text', 'output_text']);
const codexToolTypes = new Set(['function_call', 'function_call_output']);
const claudeToolTypes = new Set(['tool_use', 'tool_result']);
const claudeReasoningTypes = new Set(['thinking', 'redacted_thinking']);
const claudeAttachmentTypes = new Set(['image', 'document']);
const claudeTextMetadataFields = new Set(['citations']);
const codexTextMetadataFields = new Set(['annotations']);
// Hidden reasoning and signature fields are never copied, at any depth.
const hiddenBlockFields = new Set([
  'signature',
  'thinking',
  'reasoning',
  'encrypted_content',
]);
const attachmentGap = 'attachment content not retained';
const hiddenFieldGap = 'hidden block fields not retained';
const unknownTextFieldGap = 'unrecognized text block metadata not retained';
const dataUrlMediaTypePattern = /^data:([^;,]+)/;
const maxJsonDepth = 128;

// Error text is fixed wording and never echoes record values, so nothing
// unredacted reaches coverage reasons or error messages.
function invalid(error) {
  return {
    code: 'SOURCE_RECORD_INVALID',
    coverage: { reason: error, state: 'partial' },
    error,
    ok: false,
  };
}

function unsupported(error) {
  return {
    code: 'SOURCE_RECORD_UNSUPPORTED',
    coverage: { reason: error, state: 'unsupported' },
    error,
    ok: false,
  };
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.length > 0;
}

// Reads an own data property without running accessors. Getters and inherited
// fields read as absent, so they cannot inject values into the parser.
function readDataField(object, key) {
  const descriptor = Reflect.getOwnPropertyDescriptor(object, key);
  return descriptor !== undefined && 'value' in descriptor
    ? descriptor.value
    : undefined;
}

// A missing native ID stays null so the importer can bind source generation
// and byte offset. A present non-string ID is malformed and yields undefined.
function readNativeId(value) {
  if (value === undefined || value === null || value === '') {
    return null;
  }
  return typeof value === 'string' ? value : undefined;
}

// Copies JSON-compatible data without running accessors. Holes, NaN, infinity,
// functions, symbols, undefined, cycles, non-plain objects and deep nesting are
// refused rather than coerced, so the copy is exactly what the source holds.
function snapshotJson(value, depth = 0, ancestors = new Set()) {
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'boolean'
  ) {
    return value;
  }
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : undefined;
  }
  if (
    typeof value !== 'object' ||
    depth > maxJsonDepth ||
    ancestors.has(value)
  ) {
    return;
  }
  const prototype = Object.getPrototypeOf(value);
  if (Array.isArray(value)) {
    if (prototype !== Array.prototype) {
      return;
    }
  } else if (prototype !== Object.prototype && prototype !== null) {
    return;
  }
  ancestors.add(value);
  try {
    return copyJsonEntries(value, depth, ancestors);
  } finally {
    ancestors.delete(value);
  }
}

function copyJsonEntries(value, depth, ancestors) {
  const isArray = Array.isArray(value);
  const keys = Reflect.ownKeys(value);
  if (keys.some((key) => typeof key !== 'string')) {
    return;
  }
  // Every index plus the array's own length key must be present, so a hole
  // cannot be hidden by an extra property.
  if (isArray && keys.length !== value.length + 1) {
    return;
  }
  const names = isArray
    ? Array.from({ length: value.length }, (_, index) => String(index))
    : keys;
  const copy = isArray ? [] : {};
  for (const name of names) {
    const descriptor = Reflect.getOwnPropertyDescriptor(value, name);
    if (
      descriptor === undefined ||
      !('value' in descriptor) ||
      !descriptor.enumerable
    ) {
      return;
    }
    const child = snapshotJson(descriptor.value, depth + 1, ancestors);
    if (child === undefined) {
      return;
    }
    Object.defineProperty(copy, name, {
      configurable: true,
      enumerable: true,
      value: child,
      writable: true,
    });
  }
  return copy;
}

// Validated data is plain JSON, so a JSON round trip yields detached output.
function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function coverageFor(gaps) {
  return gaps.size === 0
    ? { reason: null, state: 'complete' }
    : { reason: [...gaps].join('; '), state: 'partial' };
}

// Attachments keep a descriptor only. Inline bytes are never decoded and
// references are never read or fetched; the descriptor is all that is kept.
function attachmentBlock(attachmentType, source, mediaType, reference) {
  return {
    attachmentType,
    kind: 'attachment',
    source,
    ...(mediaType === undefined ? {} : { mediaType }),
    ...(reference === undefined ? {} : { reference }),
  };
}

function codexImageBlock(item) {
  if (typeof item.image_url === 'string') {
    if (item.image_url.startsWith('data:')) {
      const mediaType = dataUrlMediaTypePattern.exec(item.image_url)?.[1];
      return attachmentBlock('input_image', 'inline', mediaType);
    }
    return attachmentBlock(
      'input_image',
      'reference',
      undefined,
      item.image_url
    );
  }
  if (typeof item.file_id === 'string') {
    return attachmentBlock('input_image', 'reference', undefined, item.file_id);
  }
  return null;
}

function claudeAttachmentBlock(block) {
  const { source } = block;
  if (!isObject(source) || typeof source.type !== 'string') {
    return null;
  }
  if (source.type === 'base64') {
    const mediaType =
      typeof source.media_type === 'string' ? source.media_type : undefined;
    return attachmentBlock(block.type, 'inline', mediaType);
  }
  if (source.type === 'url' && typeof source.url === 'string') {
    return attachmentBlock(block.type, 'reference', undefined, source.url);
  }
  if (source.type === 'file' && typeof source.file_id === 'string') {
    return attachmentBlock(block.type, 'reference', undefined, source.file_id);
  }
  return null;
}

// Copies metadata without hidden fields at any depth. Each removal is recorded
// as a gap so coverage reports it instead of hiding it.
function withoutHiddenFields(value, gaps) {
  if (Array.isArray(value)) {
    return value.map((item) => withoutHiddenFields(item, gaps));
  }
  if (!isObject(value)) {
    return value;
  }
  const entries = Object.entries(value).filter(([key]) => {
    if (hiddenBlockFields.has(key)) {
      gaps.add(hiddenFieldGap);
      return false;
    }
    return true;
  });
  return Object.fromEntries(
    entries.map(([key, child]) => [key, withoutHiddenFields(child, gaps)])
  );
}

// Text keeps only its allowlisted citation or annotation metadata, and only
// when some is present. Any other field is dropped and reported as a gap.
function textBlock(block, metadataFields, gaps) {
  const metadata = {};
  let hasMetadata = false;
  for (const key of Object.keys(block)) {
    if (key === 'type' || key === 'text') {
      continue;
    }
    if (hiddenBlockFields.has(key)) {
      gaps.add(hiddenFieldGap);
    } else if (metadataFields.has(key)) {
      metadata[key] = withoutHiddenFields(block[key], gaps);
      hasMetadata = true;
    } else {
      gaps.add(unknownTextFieldGap);
    }
  }
  return hasMetadata
    ? { kind: 'text', metadata, text: block.text }
    : { kind: 'text', text: block.text };
}

function parseCodexContentItem(item) {
  if (!isObject(item) || typeof item.type !== 'string') {
    return invalid('Codex content item must be an object with a type');
  }
  if (codexTextTypes.has(item.type)) {
    if (typeof item.text !== 'string') {
      return invalid('Codex text item must have string text');
    }
    const gaps = new Set();
    return {
      contentBlock: textBlock(item, codexTextMetadataFields, gaps),
      gaps,
      text: item.text,
    };
  }
  const attachment = item.type === 'input_image' ? codexImageBlock(item) : null;
  if (attachment) {
    return {
      contentBlock: attachment,
      gaps: new Set([attachmentGap]),
      text: null,
    };
  }
  return {
    contentBlock: { data: item, kind: 'opaque' },
    gaps: new Set(['unsupported Codex content item']),
    text: null,
  };
}

// Only documented Codex response_item messages and function items are parsed.
// Hidden reasoning is reported as unavailable and never inferred or synthesized.
function parseCodex(record) {
  if (typeof record.type !== 'string') {
    return invalid('Codex record type must be a string');
  }
  if (record.type !== 'response_item') {
    return unsupported('unsupported Codex record type');
  }
  const { payload } = record;
  if (!isObject(payload) || typeof payload.type !== 'string') {
    return invalid('Codex payload must be an object with a type');
  }
  if (payload.type === 'reasoning') {
    return unsupported('reasoning unavailable');
  }
  if (payload.type === 'message') {
    return parseCodexMessage(payload);
  }
  if (codexToolTypes.has(payload.type)) {
    return parseCodexToolItem(payload);
  }
  return unsupported('unsupported Codex payload type');
}

function parseCodexMessage(payload) {
  const nativeId = readNativeId(payload.id);
  if (nativeId === undefined) {
    return invalid('Codex payload id must be a string when present');
  }
  if (typeof payload.role !== 'string') {
    return invalid('Codex message role must be a string');
  }
  if (!codexRoles.has(payload.role)) {
    return unsupported('unsupported Codex message role');
  }
  if (!Array.isArray(payload.content)) {
    return invalid('Codex message content must be a list');
  }
  const contentBlocks = [];
  const texts = [];
  const gaps = new Set();
  for (const item of payload.content) {
    const parsed = parseCodexContentItem(item);
    if (parsed.ok === false) {
      return parsed;
    }
    contentBlocks.push(parsed.contentBlock);
    if (parsed.text !== null) {
      texts.push(parsed.text);
    }
    for (const gap of parsed.gaps) {
      gaps.add(gap);
    }
  }
  return {
    contentBlocks,
    gaps,
    nativeId,
    role: payload.role,
    text: texts.join('\n'),
    toolBlocks: [],
  };
}

// Function calls and outputs are tool content, never prose. The native ID
// carries the item kind so a call and its output sharing a call_id cannot collide.
function parseCodexToolItem(payload) {
  const itemId = readNativeId(payload.id);
  if (itemId === undefined) {
    return invalid('Codex payload id must be a string when present');
  }
  if (!isNonEmptyString(payload.call_id)) {
    return invalid('Codex tool item must have a string call_id');
  }
  if (payload.type === 'function_call') {
    if (
      typeof payload.name !== 'string' ||
      typeof payload.arguments !== 'string'
    ) {
      return invalid('Codex function call must have string name and arguments');
    }
  } else if (payload.output === undefined) {
    return invalid('Codex function call output must have an output');
  }
  return {
    contentBlocks: [{ data: payload, kind: 'tool' }],
    gaps: new Set(),
    nativeId: `${payload.type}:${itemId ?? payload.call_id}`,
    role: payload.type === 'function_call' ? 'assistant' : 'tool',
    text: '',
    toolBlocks: [payload],
  };
}

function parseClaudeContentBlock(block) {
  if (!isObject(block) || typeof block.type !== 'string') {
    return invalid('Claude content block must be an object with a type');
  }
  if (block.type === 'text') {
    if (typeof block.text !== 'string') {
      return invalid('Claude text block must have string text');
    }
    const gaps = new Set();
    return {
      contentBlock: textBlock(block, claudeTextMetadataFields, gaps),
      gaps,
      text: block.text,
      toolBlock: null,
    };
  }
  if (claudeToolTypes.has(block.type)) {
    return {
      contentBlock: { data: block, kind: 'tool' },
      gaps: new Set(),
      text: null,
      toolBlock: block,
    };
  }
  if (claudeReasoningTypes.has(block.type)) {
    return {
      contentBlock: null,
      gaps: new Set(['reasoning unavailable']),
      text: null,
      toolBlock: null,
    };
  }
  const attachment = claudeAttachmentTypes.has(block.type)
    ? claudeAttachmentBlock(block)
    : null;
  if (attachment) {
    return {
      contentBlock: attachment,
      gaps: new Set([attachmentGap]),
      text: null,
      toolBlock: null,
    };
  }
  return {
    contentBlock: { data: block, kind: 'opaque' },
    gaps: new Set(['unsupported Claude content block']),
    text: null,
    toolBlock: null,
  };
}

// Tool blocks keep their JSON data in toolBlocks and never become prose.
// Reasoning blocks are excluded and marked unavailable rather than recovered.
function parseClaudeMessage(nativeId, role, content) {
  if (typeof content === 'string') {
    return {
      contentBlocks: [{ kind: 'text', text: content }],
      gaps: new Set(),
      nativeId,
      role,
      text: content,
      toolBlocks: [],
    };
  }
  if (!Array.isArray(content)) {
    return invalid('Claude message content must be a string or list');
  }
  const texts = [];
  const toolBlocks = [];
  const contentBlocks = [];
  const gaps = new Set();
  for (const block of content) {
    const parsed = parseClaudeContentBlock(block);
    if (parsed.ok === false) {
      return parsed;
    }
    if (parsed.text !== null) {
      texts.push(parsed.text);
    }
    if (parsed.toolBlock !== null) {
      toolBlocks.push(parsed.toolBlock);
    }
    if (parsed.contentBlock !== null) {
      contentBlocks.push(parsed.contentBlock);
    }
    for (const gap of parsed.gaps) {
      gaps.add(gap);
    }
  }
  return {
    contentBlocks,
    gaps,
    nativeId,
    role,
    text: texts.join('\n'),
    toolBlocks,
  };
}

function parseClaude(record) {
  if (typeof record.type !== 'string') {
    return invalid('Claude record type must be a string');
  }
  if (record.type !== 'user' && record.type !== 'assistant') {
    return unsupported('unsupported Claude record type');
  }
  const nativeId = readNativeId(record.uuid);
  if (nativeId === undefined) {
    return invalid('Claude uuid must be a string when present');
  }
  const { message } = record;
  if (!isObject(message) || message.role !== record.type) {
    return invalid('Claude message must match the record role');
  }
  return parseClaudeMessage(nativeId, record.type, message.content);
}

// Pure and synchronous: no input mutation, no filesystem or network access.
// Output is intermediate; the importer must redact it before persisting.
export function parseSpansSourceRecord(input) {
  if (!isObject(input)) {
    return invalid('input must be an object');
  }
  const provider = readDataField(input, 'provider');
  const sourceId = readDataField(input, 'sourceId');
  const sourceGeneration = readDataField(input, 'sourceGeneration');
  const parserVersion = readDataField(input, 'parserVersion');
  if (typeof provider !== 'string') {
    return invalid('provider must be a string');
  }
  if (!providers.has(provider)) {
    return unsupported('unsupported source provider');
  }
  if (!isNonEmptyString(sourceId)) {
    return invalid('sourceId must be a non-empty string');
  }
  if (!Number.isSafeInteger(sourceGeneration) || sourceGeneration < 0) {
    return invalid('sourceGeneration must be a non-negative integer');
  }
  if (!isNonEmptyString(parserVersion)) {
    return invalid('parserVersion must be a non-empty string');
  }
  const record = snapshotJson(readDataField(input, 'record'));
  if (!isObject(record)) {
    return invalid('record must be a JSON object');
  }
  const parsed =
    provider === 'codex' ? parseCodex(record) : parseClaude(record);
  if (parsed.ok === false) {
    return parsed;
  }
  return {
    event: cloneJson({
      contentBlocks: parsed.contentBlocks,
      coverage: coverageFor(parsed.gaps),
      kind: 'message',
      nativeId: parsed.nativeId,
      parserVersion,
      provider,
      role: parsed.role,
      sourceGeneration,
      sourceId,
      text: parsed.text,
      toolBlocks: parsed.toolBlocks,
    }),
    ok: true,
  };
}
