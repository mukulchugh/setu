// Exact-target cmux transport for Setu Spans. It never runs cmux: every effect
// goes through four injected adapters, and every durable fact goes through the
// caller's persist adapter, which sits on the existing event/model store (the
// single owner of persistence and compare-and-set). This module adds no
// scheduler, coordinator or second store.
//
// Adapter contract (full text in REPORT.md):
//   readTarget({ workspaceId, surfaceId })
//     -> { ok: true, workspaceId, surfaceId, processStart, checkoutDigest,
//          sessionId, state: 'idle'|'busy'|'unknown', promptText }
//        promptText is compared byte for byte; see promptNewline below.
//   sendText({ ...effectBinding, text })
//     -> { ok: true } | { ok: false, notSent: true }; anything else, a throw or
//        a timeout is an UNKNOWN outcome and is held, never retried.
//   pressEnter({ ...effectBinding })
//     -> { ok: true } | { ok: false, notPressed: true }; anything else is held.
//   effectBinding = the five target fields plus runId, spanId, attemptId,
//     planVersion, generation, assignmentId, assignmentDigest and textDigest.
//     The transport re-reads the durable generation and record after each
//     observation, but that is a best-effort pre-check. Only the trusted
//     adapter, which must verify current ownership and generation at the
//     moment of the effect, can fence atomically. This module claims no
//     atomicity across the adapter boundary beyond that contract.
//   persist({ op: 'read', runId, assignmentId })
//     -> { ok: true, generation, record: null | record }
//   persist({ op: 'write', runId, assignmentId, generation, expected, record,
//             event })
//     -> { ok: true } | { ok: false, code: 'PHASE_CONFLICT'|'STALE_GENERATION' }
//        | { ok: false, unknown: true } when the write may have committed.
//
// promptNewline ('lf' by default, or 'crlf' / 'cr') is the one explicitly bound
// newline convention the prompt may use. The sent text is converted to it and
// compared exactly; no trimming, NFC or other normalization is applied to what
// the adapter reports, and only a prompt of exactly '' is empty.
//
// A transport receipt (Enter accepted by the adapter) is not an acknowledgment.
// acknowledge(body, context) marks an assignment acknowledged only when the
// body holds the exact ack code from the delivered brief AND the separate
// context carries the session and generation the front door authenticated. The
// ack code is printed in the brief, so it is a binding check and never
// authentication: a caller body must never be the source of the context.
// Process exit, pane closure and imported or historical approvals are never
// inputs here.

import { createHash } from 'node:crypto';
import { types } from 'node:util';
import { redactSpansValue as redactValue } from './spans-redaction.js';

const MAX_ID_LENGTH = 128;
const ACK_WINDOW_CEILING_MS = 86_400_000;
// Room for the fixed footer when sizing the prompt the adapter may report.
const FOOTER_ALLOWANCE = 1024;
const DIGEST_PATTERN = /^(?:sha256:)?[0-9a-f]{64}$/;
const HEX_DIGEST_PATTERN = /^[0-9a-f]{64}$/;
const ACK_CODE_PATTERN = /^[0-9a-f]{16}$/;
const DIGEST_PREFIX = 'sha256:';
const EVENT_TYPE = 'spans.cmux.delivery';
const RECORD_VERSION = 1;
const COMMAND_PREFIXES = ['/', '!'];
const NEWLINES = Object.freeze({ cr: '\r', crlf: '\r\n', lf: '\n' });
const TIMED_OUT = Symbol('timed-out');

// Ceilings are upper bounds on caller-supplied limits. They are not defaults.
const LIMIT_CEILINGS = Object.freeze({
  adapterTimeoutMs: 300_000,
  maxContentBytes: 65_536,
  maxContentLines: 1000,
});

const PHASES = new Set([
  'acknowledged',
  'held',
  'intent',
  'submitted',
  'text-sent',
  'unsent',
]);
// Phases that keep ownership of an unresolved effect: never resent.
const HELD_PHASES = new Set(['held', 'intent', 'text-sent']);
const HOLD_REASONS = new Set([
  'ENTER_REFUSED',
  'ENTER_UNCERTAIN',
  'PROMPT_CHANGED',
  'SEND_UNCERTAIN',
  'TARGET_DRIFT',
  'TARGET_UNREADABLE',
]);
const UNSENT_REASONS = new Set([
  'PROMPT_NOT_EMPTY',
  'SEND_REFUSED',
  'TARGET_MISMATCH',
  'TARGET_NOT_IDLE',
  'TARGET_UNREADABLE',
]);
const OBSERVED_STATES = new Set(['busy', 'idle', 'unknown']);

const DELIVER_KEYS = [
  'ackWithinMs',
  'assignmentId',
  'attemptId',
  'content',
  'generation',
  'planVersion',
  'runId',
  'spanId',
  'target',
];
const TARGET_KEYS = [
  'checkoutDigest',
  'processStart',
  'sessionId',
  'surfaceId',
  'workspaceId',
];
// The body is what the agent's message can carry. The context is what the
// receiving session's trusted front door supplies; neither may stand in for
// the other.
const ACK_BODY_KEYS = ['ackCode', 'assignmentId', 'runId'];
const ACK_CONTEXT_KEYS = ['generation', 'sessionId'];
const INSPECT_KEYS = ['assignmentId', 'generation', 'runId'];
const RECORD_KEYS = [
  'ackCode',
  'ackDueAt',
  'acknowledgedAt',
  'assignmentDigest',
  'assignmentId',
  'attemptId',
  'binding',
  'contentDigest',
  'deliveryAttempt',
  'generation',
  'heldAt',
  'intentAt',
  'phase',
  'planVersion',
  'reason',
  'runId',
  'spanId',
  'submittedAt',
  'textDigest',
  'textSentAt',
  'transportReceipt',
  'version',
];

// Fixed text only. Adapter, store and request strings are never reflected.
const REFUSALS = {
  ACK_CONTEXT_REQUIRED:
    'An acknowledgment needs the trusted receiving-session context.',
  ACK_MISMATCH: 'The acknowledgment does not match the delivered assignment.',
  ACK_NOT_ALLOWED: 'An assignment proven unsent cannot be acknowledged.',
  ACK_NOT_RECORDED:
    'The acknowledgment was not confirmed as saved; reread before retrying.',
  ACK_WINDOW_INVALID: 'ackWithinMs must be a bounded positive integer.',
  ASSIGNMENT_CONFLICT:
    'The assignment ID is already bound to different content or target.',
  ASSIGNMENT_NOT_FOUND: 'The assignment has no recorded delivery.',
  CLOCK_INVALID: 'The clock did not return a nonnegative safe integer.',
  CONTENT_INVALID: 'content must be a non-empty string.',
  CONTENT_TOO_LARGE: 'content exceeds the configured size bounds.',
  CONTENT_UNSAFE:
    'content holds control or invisible characters, or starts with a command prefix.',
  DELIVERY_IN_PROGRESS: 'Another delivery of this assignment is in progress.',
  DELIVERY_UNCERTAIN:
    'An earlier delivery of this assignment is unresolved and will not be resent.',
  DELIVERY_UNKNOWN: 'The delivery outcome is unknown and is held.',
  DIGEST_INVALID: 'checkoutDigest must be a SHA-256 hex digest.',
  ENTER_REFUSED:
    'Enter was refused; the text remains in the prompt and delivery is held.',
  ENTER_UNCERTAIN: 'Enter may have been pressed; delivery is held.',
  GENERATION_INVALID:
    'Coordinator generations must be nonnegative safe integers.',
  ID_INVALID: 'IDs must be explicit non-empty strings without control text.',
  INTENT_NOT_RECORDED:
    'The delivery intent was not confirmed as saved; nothing was sent.',
  LIMITS_INVALID:
    'limits must set bounded positive maxContentBytes, maxContentLines and adapterTimeoutMs.',
  PHASE_CONFLICT:
    'The stored delivery changed during this call; nothing further was sent.',
  PLAN_VERSION_INVALID: 'planVersion must be an integer or explicit string.',
  PROMPT_CHANGED:
    'The prompt no longer holds exactly the sent text; Enter was not pressed.',
  PROMPT_NOT_EMPTY: 'The target prompt is not empty.',
  RECEIPT_NOT_RECORDED:
    'Enter was accepted but the receipt was not confirmed as saved; delivery is held.',
  RECORD_INVALID:
    'The stored delivery record does not use the expected format.',
  RECORD_READ_FAILED: 'The delivery record could not be read.',
  REQUEST_INVALID: 'The request does not use the expected format.',
  SEND_NOT_RECORDED:
    'The text was sent but not confirmed as saved; delivery is held.',
  SEND_REFUSED: 'The adapter reported the text was not sent.',
  SEND_UNCERTAIN: 'The text may have been sent; delivery is held.',
  SENSITIVE_VALUE: 'A value that looks like a secret was not sent or stored.',
  STALE_GENERATION: 'The coordinator generation is stale.',
  TARGET_DRIFT:
    'The target identity changed before Enter; Enter was not pressed.',
  TARGET_MISMATCH: 'The target does not match the bound identity.',
  TARGET_NOT_IDLE: 'The target is not idle.',
  TARGET_UNREADABLE: 'The target could not be read as an exact identity.',
};

const isRecord = (value) =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

function refuse(code, extra = {}) {
  return { code, error: REFUSALS[code], ok: false, ...extra };
}

const holdsSecret = (value) =>
  typeof value === 'string' && redactValue(value) !== value;

const sha256Parts = (parts) =>
  createHash('sha256').update(JSON.stringify(parts)).digest('hex');

const sha256Text = (text) =>
  createHash('sha256').update(text, 'utf8').digest('hex');

// ---------------------------------------------------------------------------
// Text and request validation
// ---------------------------------------------------------------------------

// Controls (CR would submit, ESC starts sequences), lone surrogates, bidi and
// zero-width characters, and tag characters. Tab and newline are allowed.
function isUnsafeCodePoint(codePoint) {
  if (codePoint === 0x09 || codePoint === 0x0a) {
    return false;
  }
  return (
    codePoint < 0x20 ||
    (codePoint >= 0x7f && codePoint <= 0x9f) ||
    (codePoint >= 0xd8_00 && codePoint <= 0xdf_ff) ||
    (codePoint >= 0x20_0b && codePoint <= 0x20_0f) ||
    (codePoint >= 0x20_28 && codePoint <= 0x20_2e) ||
    (codePoint >= 0x20_60 && codePoint <= 0x20_69) ||
    codePoint === 0xfe_ff ||
    (codePoint >= 0xff_f9 && codePoint <= 0xff_fb) ||
    codePoint === 0xff_fe ||
    codePoint === 0xff_ff ||
    (codePoint >= 0xe_00_00 && codePoint <= 0xe_00_7f)
  );
}

function hasUnsafeText(text) {
  for (const character of text) {
    if (isUnsafeCodePoint(character.codePointAt(0))) {
      return true;
    }
  }
  return false;
}

function isExplicitId(value) {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= MAX_ID_LENGTH &&
    value.trim() === value &&
    value !== '__proto__' &&
    !value.includes('\n') &&
    !value.includes('\t') &&
    !hasUnsafeText(value)
  );
}

const isGeneration = (value) => Number.isSafeInteger(value) && value >= 0;
const isTime = (value) => Number.isSafeInteger(value) && value >= 0;

const isPlanVersion = (value) =>
  (Number.isSafeInteger(value) && value >= 0) || isExplicitId(value);

const isDigest = (value) =>
  typeof value === 'string' && DIGEST_PATTERN.test(value);

const bareDigest = (value) =>
  value.startsWith(DIGEST_PREFIX) ? value.slice(DIGEST_PREFIX.length) : value;

// A plain object whose own keys are all in `allowed`, read once as data
// properties. Accessors, symbols and exotic prototypes are rejected, so a
// getter cannot answer twice and nothing the caller holds is shared.
function plainCopy(input, allowed) {
  if (!isRecord(input) || types.isProxy(input)) {
    return null;
  }
  const prototype = Object.getPrototypeOf(input);
  if (prototype !== Object.prototype && prototype !== null) {
    return null;
  }
  const copy = {};
  for (const key of Reflect.ownKeys(input)) {
    if (typeof key !== 'string' || !allowed.includes(key)) {
      return null;
    }
    const descriptor = Object.getOwnPropertyDescriptor(input, key);
    if (!(descriptor.enumerable && 'value' in descriptor)) {
      return null;
    }
    copy[key] = descriptor.value;
  }
  return copy;
}

const hasAll = (copy, keys) => keys.every((key) => Object.hasOwn(copy, key));

function parseLimits(limits) {
  try {
    if (!isRecord(limits)) {
      return null;
    }
    const parsed = {};
    for (const [name, ceiling] of Object.entries(LIMIT_CEILINGS)) {
      const value = limits[name];
      if (!(Number.isSafeInteger(value) && value >= 1 && value <= ceiling)) {
        return null;
      }
      parsed[name] = value;
    }
    return Object.freeze(parsed);
  } catch {
    return null;
  }
}

function normalizeContent(raw, limits) {
  if (typeof raw !== 'string' || raw.length === 0) {
    return refuse('CONTENT_INVALID');
  }
  // UTF-16 length never exceeds the UTF-8 byte length, so this cheap test is
  // safe before any scan of an oversized string.
  if (raw.length > limits.maxContentBytes) {
    return refuse('CONTENT_TOO_LARGE');
  }
  const text = raw.replace(/\r\n?/g, '\n').normalize('NFC').trim();
  if (text.length === 0) {
    return refuse('CONTENT_INVALID');
  }
  if (
    hasUnsafeText(text) ||
    COMMAND_PREFIXES.some((prefix) => text.startsWith(prefix))
  ) {
    return refuse('CONTENT_UNSAFE');
  }
  if (
    Buffer.byteLength(text, 'utf8') > limits.maxContentBytes ||
    text.split('\n').length > limits.maxContentLines
  ) {
    return refuse('CONTENT_TOO_LARGE');
  }
  if (holdsSecret(text)) {
    return refuse('SENSITIVE_VALUE');
  }
  return { ok: true, text };
}

function parseBinding(target) {
  if (!TARGET_KEYS.every((key) => Object.hasOwn(target, key))) {
    return refuse('REQUEST_INVALID');
  }
  const ids = ['processStart', 'sessionId', 'surfaceId', 'workspaceId'];
  if (!ids.every((key) => isExplicitId(target[key]))) {
    return refuse('ID_INVALID');
  }
  if (!isDigest(target.checkoutDigest)) {
    return refuse('DIGEST_INVALID');
  }
  if (ids.some((key) => holdsSecret(target[key]))) {
    return refuse('SENSITIVE_VALUE');
  }
  return {
    binding: {
      checkoutDigest: bareDigest(target.checkoutDigest),
      processStart: target.processStart,
      sessionId: target.sessionId,
      surfaceId: target.surfaceId,
      workspaceId: target.workspaceId,
    },
    ok: true,
  };
}

function assignmentDigestOf(fields) {
  const { binding } = fields;
  return sha256Parts([
    'spans.cmux.assignment.v1',
    fields.assignmentId,
    fields.runId,
    fields.spanId,
    fields.attemptId,
    fields.planVersion,
    fields.contentDigest,
    binding.workspaceId,
    binding.surfaceId,
    binding.processStart,
    binding.checkoutDigest,
    binding.sessionId,
  ]);
}

const ackCodeOf = (assignmentDigest) =>
  sha256Parts(['spans.cmux.ack.v1', assignmentDigest]).slice(0, 16);

// Stable without the content, so the ID can be quoted before a brief exists.
const deriveAssignmentId = ({ attemptId, planVersion, runId, spanId }) =>
  `spans-assignment-${sha256Parts([
    'spans.cmux.assignment-id.v1',
    runId,
    spanId,
    attemptId,
    planVersion,
  ]).slice(0, 40)}`;

function footerOf(assignmentId, ackCode) {
  return `\n\n[Spans assignment ${assignmentId} | ack ${ackCode}]`;
}

function parseAckWindow(value) {
  if (value === undefined) {
    return { ok: true, value: null };
  }
  if (
    !(
      Number.isSafeInteger(value) &&
      value >= 1 &&
      value <= ACK_WINDOW_CEILING_MS
    )
  ) {
    return refuse('ACK_WINDOW_INVALID');
  }
  return { ok: true, value };
}

function parseIdentity(input) {
  const names = ['runId', 'spanId', 'attemptId'];
  if (!names.every((name) => isExplicitId(input[name]))) {
    return refuse('ID_INVALID');
  }
  if (input.assignmentId !== undefined && !isExplicitId(input.assignmentId)) {
    return refuse('ID_INVALID');
  }
  if (!isGeneration(input.generation)) {
    return refuse('GENERATION_INVALID');
  }
  if (!isPlanVersion(input.planVersion)) {
    return refuse('PLAN_VERSION_INVALID');
  }
  const strings = [...names, 'assignmentId', 'planVersion'].map(
    (name) => input[name]
  );
  if (strings.some(holdsSecret)) {
    return refuse('SENSITIVE_VALUE');
  }
  return null;
}

function parseDeliverInput(raw) {
  let input = null;
  let target = null;
  try {
    input = plainCopy(raw, DELIVER_KEYS);
    target = input ? plainCopy(input.target, TARGET_KEYS) : null;
  } catch {
    return refuse('REQUEST_INVALID');
  }
  const required = [
    'attemptId',
    'content',
    'generation',
    'planVersion',
    'runId',
    'spanId',
    'target',
  ];
  if (!(input && target && hasAll(input, required))) {
    return refuse('REQUEST_INVALID');
  }
  return { input, ok: true, target };
}

/**
 * Pure validation and normalization of one assignment. Returns the stable
 * assignment ID, digests and ack code a dispatcher needs, or a bounded failure.
 * Nothing here touches an adapter or the store.
 */
export function prepareSpansAssignment(raw, limitsInput) {
  const limits = parseLimits(limitsInput);
  if (!limits) {
    return refuse('LIMITS_INVALID');
  }
  const parsed = parseDeliverInput(raw);
  if (!parsed.ok) {
    return parsed;
  }
  const { input, target } = parsed;
  const identity = parseIdentity(input);
  if (identity) {
    return identity;
  }
  const bound = parseBinding(target);
  if (!bound.ok) {
    return bound;
  }
  const window = parseAckWindow(input.ackWithinMs);
  if (!window.ok) {
    return window;
  }
  const content = normalizeContent(input.content, limits);
  if (!content.ok) {
    return content;
  }
  const assignmentId = input.assignmentId ?? deriveAssignmentId(input);
  const contentDigest = sha256Text(content.text);
  const fields = {
    assignmentId,
    attemptId: input.attemptId,
    binding: bound.binding,
    contentDigest,
    planVersion: input.planVersion,
    runId: input.runId,
    spanId: input.spanId,
  };
  const assignmentDigest = assignmentDigestOf(fields);
  const ackCode = ackCodeOf(assignmentDigest);
  const text = `${content.text}${footerOf(assignmentId, ackCode)}`;
  return {
    ackCode,
    ackWithinMs: window.value,
    assignmentDigest,
    assignmentId,
    attemptId: input.attemptId,
    binding: bound.binding,
    contentDigest,
    generation: input.generation,
    ok: true,
    planVersion: input.planVersion,
    runId: input.runId,
    spanId: input.spanId,
    text,
    textDigest: sha256Text(text),
  };
}

function parseAckInput(raw, rawContext) {
  let input = null;
  let context = null;
  try {
    input = plainCopy(raw, ACK_BODY_KEYS);
    context = plainCopy(rawContext, ACK_CONTEXT_KEYS);
  } catch {
    return refuse('REQUEST_INVALID');
  }
  if (!(input && hasAll(input, ACK_BODY_KEYS))) {
    return refuse('REQUEST_INVALID');
  }
  if (!(context && hasAll(context, ACK_CONTEXT_KEYS))) {
    return refuse('ACK_CONTEXT_REQUIRED');
  }
  if (
    !(
      isExplicitId(input.runId) &&
      isExplicitId(input.assignmentId) &&
      isExplicitId(context.sessionId)
    )
  ) {
    return refuse('ID_INVALID');
  }
  if (!isGeneration(context.generation)) {
    return refuse('GENERATION_INVALID');
  }
  if ([input.runId, input.assignmentId, context.sessionId].some(holdsSecret)) {
    return refuse('SENSITIVE_VALUE');
  }
  if (
    !(typeof input.ackCode === 'string' && ACK_CODE_PATTERN.test(input.ackCode))
  ) {
    return refuse('ACK_MISMATCH');
  }
  return {
    ackCode: input.ackCode,
    assignmentId: input.assignmentId,
    generation: context.generation,
    ok: true,
    runId: input.runId,
    sessionId: context.sessionId,
  };
}

function parseInspectInput(raw) {
  let input = null;
  try {
    input = plainCopy(raw, INSPECT_KEYS);
  } catch {
    return refuse('REQUEST_INVALID');
  }
  if (!(input && hasAll(input, INSPECT_KEYS))) {
    return refuse('REQUEST_INVALID');
  }
  if (!(isExplicitId(input.runId) && isExplicitId(input.assignmentId))) {
    return refuse('ID_INVALID');
  }
  if (!isGeneration(input.generation)) {
    return refuse('GENERATION_INVALID');
  }
  return { ...input, ok: true };
}

// ---------------------------------------------------------------------------
// Stored record validation. The stored record is untrusted input: every field
// is checked and both digests are recomputed from the fields they cover.
// ---------------------------------------------------------------------------

function parseRecord(raw, runId, assignmentId) {
  try {
    const record = plainCopy(raw, RECORD_KEYS);
    if (!(record && hasAll(record, RECORD_KEYS))) {
      return null;
    }
    const binding = plainCopy(record.binding, TARGET_KEYS);
    if (!(binding && parseBinding(binding).ok)) {
      return null;
    }
    const nullableTimes = [
      'ackDueAt',
      'acknowledgedAt',
      'heldAt',
      'submittedAt',
      'textSentAt',
    ];
    const valid =
      record.version === RECORD_VERSION &&
      record.runId === runId &&
      record.assignmentId === assignmentId &&
      isExplicitId(record.spanId) &&
      isExplicitId(record.attemptId) &&
      isPlanVersion(record.planVersion) &&
      isGeneration(record.generation) &&
      Number.isSafeInteger(record.deliveryAttempt) &&
      record.deliveryAttempt >= 1 &&
      isTime(record.intentAt) &&
      nullableTimes.every(
        (name) => record[name] === null || isTime(record[name])
      ) &&
      PHASES.has(record.phase) &&
      typeof record.transportReceipt === 'boolean' &&
      HEX_DIGEST_PATTERN.test(String(record.contentDigest)) &&
      HEX_DIGEST_PATTERN.test(String(record.textDigest)) &&
      HEX_DIGEST_PATTERN.test(String(record.assignmentDigest)) &&
      ACK_CODE_PATTERN.test(String(record.ackCode));
    if (!valid) {
      return null;
    }
    const expectedReason = {
      held: HOLD_REASONS,
      unsent: UNSENT_REASONS,
    }[record.phase];
    const reasonOk = expectedReason
      ? expectedReason.has(record.reason)
      : record.reason === null;
    if (
      !reasonOk ||
      (record.phase === 'submitted' && !record.transportReceipt) ||
      (record.phase === 'acknowledged' && record.acknowledgedAt === null)
    ) {
      return null;
    }
    const copy = { ...record, binding: { ...binding } };
    const digest = assignmentDigestOf(copy);
    if (
      digest !== copy.assignmentDigest ||
      ackCodeOf(digest) !== copy.ackCode
    ) {
      return null;
    }
    return copy;
  } catch {
    return null;
  }
}

const expectedOf = (record) => ({
  deliveryAttempt: record.deliveryAttempt,
  phase: record.phase,
});

function deliveryEvent(record) {
  const digest = sha256Parts([
    EVENT_TYPE,
    record.runId,
    record.assignmentId,
    record.deliveryAttempt,
    record.phase,
  ]);
  return {
    eventId: `${EVENT_TYPE}:${digest}`,
    payload: record,
    runId: record.runId,
    type: EVENT_TYPE,
  };
}

function baseRecord(assignment, attempt, at) {
  return {
    ackCode: assignment.ackCode,
    ackDueAt:
      assignment.ackWithinMs === null ? null : at + assignment.ackWithinMs,
    acknowledgedAt: null,
    assignmentDigest: assignment.assignmentDigest,
    assignmentId: assignment.assignmentId,
    attemptId: assignment.attemptId,
    binding: { ...assignment.binding },
    contentDigest: assignment.contentDigest,
    deliveryAttempt: attempt,
    generation: assignment.generation,
    heldAt: null,
    intentAt: at,
    phase: 'intent',
    planVersion: assignment.planVersion,
    reason: null,
    runId: assignment.runId,
    spanId: assignment.spanId,
    submittedAt: null,
    textDigest: assignment.textDigest,
    textSentAt: null,
    transportReceipt: false,
    version: RECORD_VERSION,
  };
}

// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------

function statusOf(record, now) {
  let ackStatus = 'unknown';
  if (record.phase === 'acknowledged') {
    ackStatus = 'received';
  } else if (record.phase === 'submitted') {
    ackStatus =
      record.ackDueAt !== null && now > record.ackDueAt ? 'overdue' : 'pending';
  } else if (record.phase === 'unsent') {
    ackStatus = 'none';
  }
  return ackStatus;
}

function existingResult(record, assignment) {
  if (record.assignmentDigest !== assignment.assignmentDigest) {
    return refuse('ASSIGNMENT_CONFLICT');
  }
  if (record.phase === 'unsent') {
    return null;
  }
  if (record.phase === 'submitted' || record.phase === 'acknowledged') {
    return {
      ackCode: record.ackCode,
      acknowledged: record.phase === 'acknowledged',
      assignmentDigest: record.assignmentDigest,
      assignmentId: record.assignmentId,
      duplicate: true,
      effect: 'submitted',
      ok: true,
      phase: record.phase,
      transportReceipt: record.transportReceipt,
    };
  }
  return refuse('DELIVERY_UNCERTAIN', {
    assignmentId: record.assignmentId,
    effect: 'unknown',
    held: true,
    phase: record.phase,
    retryAllowed: false,
  });
}

// ---------------------------------------------------------------------------
// Adapter calls
// ---------------------------------------------------------------------------

async function callAdapter(adapter, args, timeoutMs) {
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve(TIMED_OUT), timeoutMs);
  });
  try {
    const value = await Promise.race([
      Promise.resolve().then(() => adapter(args)),
      timeout,
    ]);
    return value === TIMED_OUT ? { ok: false } : { ok: true, value };
  } catch {
    return { ok: false };
  } finally {
    clearTimeout(timer);
  }
}

// 'ok' only for an explicit success, 'refused' only for the adapter's explicit
// proof that the effect did not happen; everything else is unknown.
function verdictOf(call, provenNot) {
  if (!call.ok) {
    return 'unknown';
  }
  try {
    const { value } = call;
    if (isRecord(value) && value.ok === true) {
      return 'ok';
    }
    if (isRecord(value) && value.ok === false && value[provenNot] === true) {
      return 'refused';
    }
  } catch {
    // A hostile result is simply unknown.
  }
  return 'unknown';
}

function parseObservation(value, maxPromptChars) {
  try {
    if (!(isRecord(value) && value.ok === true)) {
      return null;
    }
    const {
      checkoutDigest,
      processStart,
      promptText,
      sessionId,
      state,
      surfaceId,
      workspaceId,
    } = value;
    if (
      !(
        [processStart, sessionId, surfaceId, workspaceId].every(isExplicitId) &&
        isDigest(checkoutDigest) &&
        OBSERVED_STATES.has(state) &&
        typeof promptText === 'string'
      )
    ) {
      return null;
    }
    // Kept byte for byte: a user's edit may be only a space, a newline or a
    // different Unicode form, and that must stay visible to the comparison. An
    // oversized prompt is never empty and never equal to the sent text.
    const prompt = promptText.length > maxPromptChars ? null : promptText;
    return {
      binding: {
        checkoutDigest: bareDigest(checkoutDigest),
        processStart,
        sessionId,
        surfaceId,
        workspaceId,
      },
      prompt,
      state,
    };
  } catch {
    return null;
  }
}

const sameBinding = (left, right) =>
  TARGET_KEYS.every((key) => left[key] === right[key]);

function preSendRefusal(observation, assignment) {
  if (!observation) {
    return 'TARGET_UNREADABLE';
  }
  if (!sameBinding(observation.binding, assignment.binding)) {
    return 'TARGET_MISMATCH';
  }
  if (observation.state !== 'idle') {
    return 'TARGET_NOT_IDLE';
  }
  return observation.prompt === '' ? null : 'PROMPT_NOT_EMPTY';
}

function preEnterRefusal(observation, assignment, expectedPrompt) {
  if (!observation) {
    return 'TARGET_UNREADABLE';
  }
  if (!sameBinding(observation.binding, assignment.binding)) {
    return 'TARGET_DRIFT';
  }
  return observation.state === 'idle' && observation.prompt === expectedPrompt
    ? null
    : 'PROMPT_CHANGED';
}

// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------

export function createSpansCmuxTransport({
  limits: limitsInput,
  now = Date.now,
  persist,
  pressEnter,
  promptNewline = 'lf',
  readTarget,
  sendText,
} = {}) {
  const adapters = { persist, pressEnter, readTarget, sendText };
  for (const [name, adapter] of Object.entries(adapters)) {
    if (typeof adapter !== 'function') {
      throw new TypeError(`${name} adapter must be a function.`);
    }
  }
  if (typeof now !== 'function') {
    throw new TypeError('now must be a function.');
  }
  const limits = parseLimits(limitsInput);
  if (!limits) {
    throw new TypeError(REFUSALS.LIMITS_INVALID);
  }
  if (!Object.hasOwn(NEWLINES, promptNewline)) {
    throw new TypeError("promptNewline must be 'lf', 'crlf' or 'cr'.");
  }
  const newline = NEWLINES[promptNewline];
  // A longer newline can add one character per line.
  const maxPromptChars =
    limits.maxContentBytes + FOOTER_ALLOWANCE + limits.maxContentLines;
  const inflight = new Set();

  // The prompt an Enter would submit, in the one bound newline convention.
  const expectedPromptOf = (assignment) =>
    assignment.text.replaceAll('\n', newline);

  const call = (adapter, args) =>
    callAdapter(adapter, args, limits.adapterTimeoutMs);

  function stamp() {
    try {
      const at = now();
      return isTime(at) ? at : null;
    } catch {
      return null;
    }
  }

  async function observe(assignment) {
    const result = await call(readTarget, {
      surfaceId: assignment.binding.surfaceId,
      workspaceId: assignment.binding.workspaceId,
    });
    return result.ok ? parseObservation(result.value, maxPromptChars) : null;
  }

  async function load(runId, assignmentId, generation) {
    const result = await call(persist, { assignmentId, op: 'read', runId });
    if (!result.ok) {
      return refuse('RECORD_READ_FAILED');
    }
    try {
      const read = result.value;
      if (
        !(isRecord(read) && read.ok === true && isGeneration(read.generation))
      ) {
        return refuse('RECORD_READ_FAILED');
      }
      if (read.generation !== generation) {
        return refuse('STALE_GENERATION');
      }
      if (read.record === null) {
        return { ok: true, record: null };
      }
      const record = parseRecord(read.record, runId, assignmentId);
      if (!record) {
        return refuse('RECORD_INVALID');
      }
      return record.generation > generation
        ? refuse('STALE_GENERATION')
        : { ok: true, record };
    } catch {
      return refuse('RECORD_READ_FAILED');
    }
  }

  // Redaction happens here, at the last step before the store sees anything.
  // A record that changes under redaction is refused whole, not stored altered.
  async function write(record, expected) {
    let safe = null;
    try {
      safe = redactValue(record);
    } catch {
      return { code: 'PERSIST_FAILED', ok: false };
    }
    if (JSON.stringify(safe) !== JSON.stringify(record)) {
      return { code: 'SENSITIVE_VALUE', ok: false };
    }
    const result = await call(persist, {
      assignmentId: safe.assignmentId,
      event: deliveryEvent(structuredClone(safe)),
      expected,
      generation: safe.generation,
      op: 'write',
      record: safe,
      runId: safe.runId,
    });
    if (!result.ok) {
      return { code: 'PERSIST_UNKNOWN', ok: false };
    }
    try {
      const { value } = result;
      if (isRecord(value) && value.ok === true) {
        return { ok: true };
      }
      if (isRecord(value) && value.unknown === true) {
        return { code: 'PERSIST_UNKNOWN', ok: false };
      }
      if (isRecord(value) && value.code === 'STALE_GENERATION') {
        return { code: 'STALE_GENERATION', ok: false };
      }
      if (isRecord(value) && value.code === 'PHASE_CONFLICT') {
        return { code: 'PHASE_CONFLICT', ok: false };
      }
    } catch {
      return { code: 'PERSIST_UNKNOWN', ok: false };
    }
    return { code: 'PERSIST_FAILED', ok: false };
  }

  const noEffect = (assignment) => ({
    assignmentId: assignment.assignmentId,
    effect: 'none',
    held: false,
    retryAllowed: true,
  });

  // Proven unsent: the caller may retry with a fresh call. If the unsent
  // record cannot be saved, the saved intent stands and it is a hold instead.
  async function markUnsent(record, reason, assignment) {
    const unsent = { ...record, heldAt: null, phase: 'unsent', reason };
    const written = await write(unsent, expectedOf(record));
    return refuse(reason, {
      assignmentId: assignment.assignmentId,
      effect: 'none',
      held: !written.ok,
      phase: written.ok ? 'unsent' : record.phase,
      retryAllowed: written.ok,
    });
  }

  async function hold(record, reason, assignment, effect) {
    const held = {
      ...record,
      heldAt: stampOr(record),
      phase: 'held',
      reason,
    };
    const written = await write(held, expectedOf(record));
    return refuse(reason, {
      assignmentId: assignment.assignmentId,
      effect,
      held: true,
      holdRecorded: written.ok,
      phase: written.ok ? 'held' : record.phase,
      retryAllowed: false,
    });
  }

  const stampOr = (record) => stamp() ?? record.textSentAt ?? record.intentAt;

  async function intentFailure(written, assignment) {
    if (written.code === 'PHASE_CONFLICT') {
      const again = await load(
        assignment.runId,
        assignment.assignmentId,
        assignment.generation
      );
      if (!again.ok) {
        return again;
      }
      const existing = again.record
        ? existingResult(again.record, assignment)
        : null;
      return existing ?? refuse('DELIVERY_IN_PROGRESS');
    }
    if (written.code === 'STALE_GENERATION') {
      return refuse('STALE_GENERATION', noEffect(assignment));
    }
    if (written.code === 'SENSITIVE_VALUE') {
      return refuse('SENSITIVE_VALUE', noEffect(assignment));
    }
    const unknown = written.code === 'PERSIST_UNKNOWN';
    return refuse('INTENT_NOT_RECORDED', {
      assignmentId: assignment.assignmentId,
      effect: 'none',
      held: unknown,
      recordUncertain: unknown,
      retryAllowed: !unknown,
    });
  }

  // Everything a trusted effect adapter needs to check, atomically with the
  // effect, that this exact assignment still owns this exact target.
  const effectArgs = (assignment) => ({
    assignmentDigest: assignment.assignmentDigest,
    assignmentId: assignment.assignmentId,
    attemptId: assignment.attemptId,
    checkoutDigest: assignment.binding.checkoutDigest,
    generation: assignment.generation,
    planVersion: assignment.planVersion,
    processStart: assignment.binding.processStart,
    runId: assignment.runId,
    sessionId: assignment.binding.sessionId,
    spanId: assignment.spanId,
    surfaceId: assignment.binding.surfaceId,
    textDigest: assignment.textDigest,
    workspaceId: assignment.binding.workspaceId,
  });

  // Re-reads the durable generation and record after an awaited observation.
  // The generation can move, or another writer can change the phase, while the
  // surface is being read. This is a pre-check only: the effect adapter owns the
  // atomic check at the effect boundary. It writes nothing; the record already
  // saved keeps the assignment held.
  async function recheck(assignment, record) {
    const loaded = await load(
      assignment.runId,
      assignment.assignmentId,
      assignment.generation
    );
    if (!loaded.ok) {
      return loaded;
    }
    const current = loaded.record;
    const same =
      current !== null &&
      current.phase === record.phase &&
      current.deliveryAttempt === record.deliveryAttempt &&
      current.assignmentDigest === record.assignmentDigest;
    return same ? { ok: true } : refuse('PHASE_CONFLICT');
  }

  async function beginDelivery(assignment, startedAt, previous) {
    const early = preSendRefusal(await observe(assignment), assignment);
    if (early) {
      return refuse(early, noEffect(assignment));
    }

    const intent = baseRecord(
      assignment,
      previous ? previous.deliveryAttempt + 1 : 1,
      startedAt
    );
    const intentWrite = await write(
      intent,
      previous ? expectedOf(previous) : null
    );
    if (!intentWrite.ok) {
      return intentFailure(intentWrite, assignment);
    }

    // Persisting can take time; nothing is sent against a target that moved.
    const late = preSendRefusal(await observe(assignment), assignment);
    if (late) {
      return markUnsent(intent, late, assignment);
    }
    // The generation may have moved while the surface was read. Nothing was
    // sent, but the saved intent stands: whoever owns the run now decides.
    const beforeSend = await recheck(assignment, intent);
    if (!beforeSend.ok) {
      return refuse(beforeSend.code, {
        assignmentId: assignment.assignmentId,
        effect: 'none',
        held: true,
        phase: intent.phase,
        retryAllowed: false,
      });
    }
    return { intent, ok: true };
  }

  async function pasteForDelivery(assignment, intent) {
    const sent = verdictOf(
      await call(sendText, {
        ...effectArgs(assignment),
        text: assignment.text,
      }),
      'notSent'
    );
    if (sent === 'refused') {
      return markUnsent(intent, 'SEND_REFUSED', assignment);
    }
    if (sent !== 'ok') {
      return hold(intent, 'SEND_UNCERTAIN', assignment, 'unknown');
    }

    const pasted = {
      ...intent,
      phase: 'text-sent',
      textSentAt: stampOr(intent),
    };
    if (!(await write(pasted, expectedOf(intent))).ok) {
      return refuse('SEND_NOT_RECORDED', {
        assignmentId: assignment.assignmentId,
        effect: 'pasted',
        held: true,
        retryAllowed: false,
      });
    }

    // The screen reread is the last observation before Enter. Only a durable
    // read, no write and no other observation, separates it from the effect.
    const beforeEnter = preEnterRefusal(
      await observe(assignment),
      assignment,
      expectedPromptOf(assignment)
    );
    if (beforeEnter) {
      return hold(pasted, beforeEnter, assignment, 'pasted');
    }
    const enterFence = await recheck(assignment, pasted);
    if (!enterFence.ok) {
      return refuse(enterFence.code, {
        assignmentId: assignment.assignmentId,
        effect: 'pasted',
        held: true,
        phase: pasted.phase,
        retryAllowed: false,
      });
    }
    return { ok: true, pasted };
  }

  async function submitDelivery(assignment, pasted) {
    const entered = verdictOf(
      await call(pressEnter, effectArgs(assignment)),
      'notPressed'
    );
    if (entered === 'refused') {
      return hold(pasted, 'ENTER_REFUSED', assignment, 'pasted');
    }
    if (entered !== 'ok') {
      return hold(pasted, 'ENTER_UNCERTAIN', assignment, 'unknown');
    }

    const submitted = {
      ...pasted,
      phase: 'submitted',
      submittedAt: stampOr(pasted),
      transportReceipt: true,
    };
    if (!(await write(submitted, expectedOf(pasted))).ok) {
      return refuse('RECEIPT_NOT_RECORDED', {
        assignmentId: assignment.assignmentId,
        effect: 'submitted',
        held: true,
        retryAllowed: false,
      });
    }
    return {
      ackCode: submitted.ackCode,
      ackDueAt: submitted.ackDueAt,
      acknowledged: false,
      assignmentDigest: submitted.assignmentDigest,
      assignmentId: submitted.assignmentId,
      duplicate: false,
      effect: 'submitted',
      ok: true,
      phase: 'submitted',
      transportReceipt: true,
    };
  }

  async function runDelivery(assignment) {
    const startedAt = stamp();
    if (startedAt === null) {
      return refuse('CLOCK_INVALID');
    }
    const loaded = await load(
      assignment.runId,
      assignment.assignmentId,
      assignment.generation
    );
    if (!loaded.ok) {
      return loaded;
    }
    // A stored record never causes a send by itself: only a proven-unsent
    // record lets this fresh call proceed, as a new numbered attempt.
    const existing = loaded.record
      ? existingResult(loaded.record, assignment)
      : null;
    if (existing) {
      return existing;
    }
    const begun = await beginDelivery(assignment, startedAt, loaded.record);
    if (!begun.ok) {
      return begun;
    }
    const pasted = await pasteForDelivery(assignment, begun.intent);
    if (!pasted.ok) {
      return pasted;
    }
    return submitDelivery(assignment, pasted.pasted);
  }

  async function deliver(input) {
    const assignment = prepareSpansAssignment(input, limits);
    if (!assignment.ok) {
      return assignment;
    }
    const key = `${assignment.runId}\u0000${assignment.assignmentId}`;
    if (inflight.has(key)) {
      return refuse('DELIVERY_IN_PROGRESS');
    }
    inflight.add(key);
    try {
      return await runDelivery(assignment);
    } catch {
      return refuse('DELIVERY_UNKNOWN', {
        assignmentId: assignment.assignmentId,
        effect: 'unknown',
        held: true,
        retryAllowed: false,
      });
    } finally {
      inflight.delete(key);
    }
  }

  async function resolveAcknowledgment(request) {
    const loaded = await load(
      request.runId,
      request.assignmentId,
      request.generation
    );
    if (!loaded.ok) {
      return loaded;
    }
    const { record } = loaded;
    if (!record) {
      return refuse('ASSIGNMENT_NOT_FOUND');
    }
    if (record.generation !== request.generation) {
      return refuse('STALE_GENERATION');
    }
    if (
      record.binding.sessionId !== request.sessionId ||
      record.ackCode !== request.ackCode
    ) {
      return refuse('ACK_MISMATCH');
    }
    if (record.phase === 'acknowledged') {
      return { ok: true, response: acknowledgmentResponse(record, true) };
    }
    if (record.phase === 'unsent') {
      return refuse('ACK_NOT_ALLOWED');
    }
    return { ok: true, record, response: null };
  }

  function acknowledgmentResponse(record, duplicate) {
    return {
      acknowledged: true,
      assignmentId: record.assignmentId,
      duplicate,
      ok: true,
      transportReceipt: record.transportReceipt,
    };
  }

  // `input` is what the agent's message carries. `context` must come from the
  // front door's own authenticated view of the receiving session and the run's
  // current generation, never from the message.
  async function acknowledge(input, context) {
    const request = parseAckInput(input, context);
    if (!request.ok) {
      return request;
    }
    const resolved = await resolveAcknowledgment(request);
    if (!resolved.ok || resolved.response) {
      return resolved.response ?? resolved;
    }
    const { record } = resolved;
    // Acknowledgment from an unresolved hold proves the agent has the exact
    // brief, but it does not manufacture a transport receipt.
    const at = stamp();
    if (at === null) {
      return refuse('CLOCK_INVALID');
    }
    const acknowledged = {
      ...record,
      acknowledgedAt: at,
      generation: request.generation,
      phase: 'acknowledged',
      reason: null,
    };
    const written = await write(acknowledged, expectedOf(record));
    if (!written.ok) {
      return written.code === 'STALE_GENERATION'
        ? refuse('STALE_GENERATION')
        : refuse('ACK_NOT_RECORDED');
    }
    return acknowledgmentResponse(record, false);
  }

  // Read-only. A missing acknowledgment is reported, never repaired or resent.
  async function inspect(input) {
    const request = parseInspectInput(input);
    if (!request.ok) {
      return request;
    }
    const loaded = await load(
      request.runId,
      request.assignmentId,
      request.generation
    );
    if (!loaded.ok) {
      return loaded;
    }
    const { record } = loaded;
    if (!record) {
      return { assignmentId: request.assignmentId, found: false, ok: true };
    }
    const at = stamp();
    if (at === null) {
      return refuse('CLOCK_INVALID');
    }
    return {
      ackDueAt: record.ackDueAt,
      acknowledged: record.phase === 'acknowledged',
      ackStatus: statusOf(record, at),
      assignmentDigest: record.assignmentDigest,
      assignmentId: record.assignmentId,
      deliveryAttempt: record.deliveryAttempt,
      found: true,
      held: HELD_PHASES.has(record.phase),
      ok: true,
      phase: record.phase,
      reason: record.reason,
      retryAllowed: record.phase === 'unsent',
      transportReceipt: record.transportReceipt,
    };
  }

  return Object.freeze({ acknowledge, deliver, inspect });
}

export {
  deliveryEvent as spansCmuxDeliveryEvent,
  parseRecord as parseSpansCmuxRecord,
};
