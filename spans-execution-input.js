import { types } from 'node:util';
import { hashArtifact } from './spans-artifacts.js';
import { canonicalJson } from './spans-execution-core.js';
import { redactSpansValue } from './spans-redaction.js';

export const SPANS_EXECUTION_INPUT_VERSION = 1;
export const SPANS_EXECUTION_INPUT_MAX_BYTES = 65_536;
export const SPANS_EXECUTION_INPUT_MEDIA_TYPE = 'application/json';
export const SPANS_EXECUTION_INPUT_PREPARATION_REQUIREMENT =
  'Root must build the current per-span input and persist its {mediaType,text} with createSpansArtifacts.put under the archive write gate before preparing an execution review.';

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const MAX_SOURCE_BYTES = SPANS_EXECUTION_INPUT_MAX_BYTES * 16;
const MAX_SOURCE_NODES = 4096;
const MAX_SOURCE_DEPTH = 40;
const SPAN_CONTEXT_FIELDS = Object.freeze([
  'acceptance',
  'acceptanceCriteria',
  'instructions',
  'owner',
  'ownership',
]);

const ERRORS = Object.freeze({
  SPANS_EXECUTION_INPUT_INVALID:
    'The current run, selector, span, or dependency evidence is invalid.',
  SPANS_EXECUTION_INPUT_TOO_LARGE:
    'The redacted execution input exceeds its 65,536-byte limit.',
});

const refusal = (code) => ({ code, error: ERRORS[code], ok: false });
const isRecord = (value) =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const owns = (value, key) => Object.hasOwn(value, key);

function dataValue(record, key) {
  const descriptor = Object.getOwnPropertyDescriptor(record, key);
  if (!(descriptor?.enumerable && owns(descriptor, 'value'))) {
    throw new TypeError('invalid-data-property');
  }
  return descriptor.value;
}

function plainRecord(value) {
  return (
    isRecord(value) &&
    !types.isProxy(value) &&
    (Object.getPrototypeOf(value) === Object.prototype ||
      Object.getPrototypeOf(value) === null)
  );
}

function plainArray(value) {
  return (
    Array.isArray(value) &&
    !types.isProxy(value) &&
    Object.getPrototypeOf(value) === Array.prototype
  );
}

function copyArrayData(value) {
  if (!plainArray(value)) {
    throw new TypeError('invalid-array');
  }
  const keys = Reflect.ownKeys(value);
  const lengthDescriptor = Object.getOwnPropertyDescriptor(value, 'length');
  const length = lengthDescriptor?.value;
  if (
    !Number.isSafeInteger(length) ||
    length < 0 ||
    length > MAX_SOURCE_NODES ||
    keys.length !== length + 1
  ) {
    throw new TypeError('invalid-array');
  }
  const result = [];
  for (let index = 0; index < length; index += 1) {
    result.push(dataValue(value, String(index)));
  }
  return result;
}

function copyJsonArray(value, state, ancestors, depth) {
  const source = copyArrayData(value);
  const result = [];
  for (const child of source) {
    result.push(copyJsonValue(child, state, ancestors, depth + 1));
  }
  return result;
}

function copyJsonRecord(value, state, ancestors, depth) {
  if (!plainRecord(value)) {
    throw new TypeError('invalid-json-data');
  }
  const keys = Reflect.ownKeys(value);
  if (keys.length > 256) {
    throw new TypeError('invalid-bounds');
  }
  const result = {};
  for (const key of keys) {
    if (typeof key !== 'string') {
      throw new TypeError('invalid-json-data');
    }
    state.bytes += Buffer.byteLength(key, 'utf8');
    if (state.bytes > MAX_SOURCE_BYTES) {
      throw new TypeError('invalid-bounds');
    }
    Object.defineProperty(result, key, {
      configurable: true,
      enumerable: true,
      value: copyJsonValue(dataValue(value, key), state, ancestors, depth + 1),
      writable: true,
    });
  }
  return result;
}

function copyJsonValue(item, state, ancestors, depth) {
  state.nodes += 1;
  if (state.nodes > MAX_SOURCE_NODES || depth > MAX_SOURCE_DEPTH) {
    throw new TypeError('invalid-bounds');
  }
  if (item === null || typeof item === 'boolean') {
    return item;
  }
  if (typeof item === 'string') {
    state.bytes += Buffer.byteLength(item, 'utf8');
    if (state.bytes > MAX_SOURCE_BYTES) {
      throw new TypeError('invalid-bounds');
    }
    return item;
  }
  if (typeof item === 'number' && Number.isFinite(item)) {
    return item;
  }
  if (typeof item !== 'object' || types.isProxy(item) || ancestors.has(item)) {
    throw new TypeError('invalid-json-data');
  }
  ancestors.add(item);
  try {
    return Array.isArray(item)
      ? copyJsonArray(item, state, ancestors, depth)
      : copyJsonRecord(item, state, ancestors, depth);
  } finally {
    ancestors.delete(item);
  }
}

function copyJsonData(value) {
  return copyJsonValue(value, { bytes: 0, nodes: 0 }, new Set(), 0);
}

function optionalDataValue(record, key) {
  return owns(record, key) ? dataValue(record, key) : undefined;
}

function validSelector(value) {
  try {
    if (
      !plainRecord(value) ||
      Reflect.ownKeys(value).length !== 6 ||
      ![
        'actionId',
        'attemptId',
        'generation',
        'planVersion',
        'runId',
        'spanId',
      ].every((key) => owns(value, key))
    ) {
      return false;
    }
    return (
      [
        dataValue(value, 'runId'),
        dataValue(value, 'spanId'),
        dataValue(value, 'actionId'),
        dataValue(value, 'attemptId'),
      ].every((item) => typeof item === 'string' && ID_PATTERN.test(item)) &&
      Number.isSafeInteger(dataValue(value, 'generation')) &&
      dataValue(value, 'generation') >= 0 &&
      Number.isSafeInteger(dataValue(value, 'planVersion')) &&
      dataValue(value, 'planVersion') >= 1
    );
  } catch {
    return false;
  }
}

function validId(value) {
  return typeof value === 'string' && ID_PATTERN.test(value);
}

function copyAcceptedEvidence(dependency, item) {
  const fields = [
    'acceptedActionId',
    'acceptedCheckpoint',
    'acceptedEvidenceId',
  ];
  const present = fields.filter((key) => owns(dependency, key));
  if (present.length === 0) {
    return { acceptedActionId: null, ok: true };
  }
  if (present.length !== fields.length) {
    return { ok: false };
  }
  const acceptedActionId = dataValue(dependency, 'acceptedActionId');
  const acceptedCheckpoint = dataValue(dependency, 'acceptedCheckpoint');
  const acceptedEvidenceId = dataValue(dependency, 'acceptedEvidenceId');
  const validAcceptance =
    validId(acceptedActionId) &&
    validId(acceptedEvidenceId) &&
    Number.isSafeInteger(acceptedCheckpoint) &&
    acceptedCheckpoint >= 1;
  if (!validAcceptance) {
    return { ok: false };
  }
  item.acceptedActionId = acceptedActionId;
  item.acceptedCheckpoint = acceptedCheckpoint;
  item.acceptedEvidenceId = acceptedEvidenceId;
  return { acceptedActionId, ok: true };
}

function copyAcceptedArtifacts(view, spanId, acceptedActionId) {
  if (!acceptedActionId) {
    return { ok: true };
  }
  const actions = optionalDataValue(view, 'actions');
  if (!plainRecord(actions)) {
    return { ok: false };
  }
  const action = dataValue(actions, acceptedActionId);
  if (
    !plainRecord(action) ||
    dataValue(action, 'actionId') !== acceptedActionId ||
    dataValue(action, 'spanId') !== spanId ||
    dataValue(action, 'state') !== 'completed'
  ) {
    return { ok: false };
  }
  if (!owns(action, 'outcomeArtifactIds')) {
    return { ok: true };
  }
  const artifactIds = copyArrayData(dataValue(action, 'outcomeArtifactIds'));
  if (artifactIds.some((artifactId) => !validId(artifactId))) {
    return { ok: false };
  }
  return { artifactIds, ok: true };
}

function copyDependencyEvidenceRecord(view, spanId) {
  const dependency = dataValue(dataValue(view, 'spans'), spanId);
  if (!plainRecord(dependency) || dataValue(dependency, 'spanId') !== spanId) {
    return null;
  }
  const item = { spanId };
  const title = dataValue(dependency, 'title');
  const state = dataValue(dependency, 'state');
  if (typeof title !== 'string' || typeof state !== 'string') {
    return null;
  }
  item.title = title;
  item.state = state;
  const accepted = copyAcceptedEvidence(dependency, item);
  if (!accepted.ok) {
    return null;
  }
  if (
    (state === 'completed' && !accepted.acceptedActionId) ||
    (accepted.acceptedActionId && state !== 'completed')
  ) {
    return null;
  }
  const artifacts = copyAcceptedArtifacts(
    view,
    spanId,
    accepted.acceptedActionId
  );
  if (!artifacts.ok) {
    return null;
  }
  if (owns(artifacts, 'artifactIds')) {
    item.artifactIds = artifacts.artifactIds;
  }
  return item;
}

function copyDependencyEvidence(view, span) {
  const dependencies = dataValue(span, 'dependencies');
  const dependencyIds = copyArrayData(dependencies);
  if (
    dependencyIds.some((dependencyId) => !validId(dependencyId)) ||
    new Set(dependencyIds).size !== dependencyIds.length
  ) {
    return null;
  }
  const evidence = [];
  for (const spanId of dependencyIds) {
    const record = copyDependencyEvidenceRecord(view, spanId);
    if (!record) {
      return null;
    }
    evidence.push(record);
  }
  return evidence;
}

/** Build the exact redacted input for one selector from one current store read. */
export function buildSpansExecutionInput(args) {
  try {
    if (
      !plainRecord(args) ||
      Reflect.ownKeys(args).length !== 2 ||
      !owns(args, 'run') ||
      !owns(args, 'selector')
    ) {
      return refusal('SPANS_EXECUTION_INPUT_INVALID');
    }
    const run = dataValue(args, 'run');
    const selector = dataValue(args, 'selector');
    if (!(plainRecord(run) && validSelector(selector))) {
      return refusal('SPANS_EXECUTION_INPUT_INVALID');
    }
    const generation = dataValue(run, 'generation');
    const ok = dataValue(run, 'ok');
    const view = dataValue(run, 'view');
    if (
      !(ok === true && Number.isSafeInteger(generation) && plainRecord(view))
    ) {
      return refusal('SPANS_EXECUTION_INPUT_INVALID');
    }
    const sourceId = optionalDataValue(view, 'sourceId');
    const spans = dataValue(view, 'spans');
    if (
      dataValue(view, 'runId') !== selector.runId ||
      generation !== selector.generation ||
      dataValue(view, 'generation') !== selector.generation ||
      dataValue(view, 'planVersion') !== selector.planVersion ||
      optionalDataValue(view, 'readOnly') === true ||
      optionalDataValue(view, 'imported') === true ||
      optionalDataValue(view, 'kind') === 'imported' ||
      optionalDataValue(view, 'state') === 'imported' ||
      sourceId !== undefined ||
      typeof dataValue(view, 'goal') !== 'string' ||
      !plainRecord(spans)
    ) {
      return refusal('SPANS_EXECUTION_INPUT_INVALID');
    }
    const span = dataValue(spans, selector.spanId);
    if (
      !plainRecord(span) ||
      dataValue(span, 'spanId') !== selector.spanId ||
      typeof dataValue(span, 'title') !== 'string' ||
      !plainArray(dataValue(span, 'dependencies'))
    ) {
      return refusal('SPANS_EXECUTION_INPUT_INVALID');
    }
    const dependencyEvidence = copyDependencyEvidence(view, span);
    if (!dependencyEvidence) {
      return refusal('SPANS_EXECUTION_INPUT_INVALID');
    }

    const selectedSpan = {
      dependencies: copyArrayData(dataValue(span, 'dependencies')),
      spanId: selector.spanId,
      title: dataValue(span, 'title'),
    };
    for (const key of SPAN_CONTEXT_FIELDS) {
      if (owns(span, key)) {
        selectedSpan[key] = dataValue(span, key);
      }
    }

    const contextInput = {
      dependencyEvidence,
      goal: dataValue(view, 'goal'),
      plan: {
        ...(owns(view, 'owner') ? { owner: dataValue(view, 'owner') } : {}),
        ...(owns(view, 'project')
          ? { project: dataValue(view, 'project') }
          : {}),
        ...(owns(view, 'worktree')
          ? { worktree: dataValue(view, 'worktree') }
          : {}),
      },
      runId: selector.runId,
      span: selectedSpan,
      version: SPANS_EXECUTION_INPUT_VERSION,
    };
    const redacted = redactSpansValue(copyJsonData(contextInput));
    const text = canonicalJson(redacted);
    const bytes = Buffer.byteLength(text, 'utf8');
    if (bytes > SPANS_EXECUTION_INPUT_MAX_BYTES) {
      return refusal('SPANS_EXECUTION_INPUT_TOO_LARGE');
    }
    const mediaType = SPANS_EXECUTION_INPUT_MEDIA_TYPE;
    const artifactId = `sha256:${hashArtifact(mediaType, text)}`;
    return {
      artifactId,
      bytes,
      mediaType,
      ok: true,
      planVersion: selector.planVersion,
      text,
    };
  } catch {
    return refusal('SPANS_EXECUTION_INPUT_INVALID');
  }
}
