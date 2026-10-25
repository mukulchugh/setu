// Volatile, process-local human confirmation for immutable execution reviews.
// Durable approval remains the responsibility of spans-execution-review.js.

import { createHash, randomBytes as cryptoRandomBytes } from 'node:crypto';
import { types } from 'node:util';
import { SPANS_EXECUTION_REVIEW_VERSION } from './spans-execution-review.js';

const SOURCE = 'portal-human-confirmation';
const REVOCATION_SOURCE = 'portal-human-revocation';
const INTENTS = Object.freeze(['approve', 'revoke']);
const RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const REVIEW_DIGEST = /^[a-f0-9]{64}$/;
const REFERENCE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const CHALLENGE_ID = /^[a-f0-9]{64}$/;
const CHALLENGE_TTL_MS = 5 * 60 * 1000;
const MAX_CHALLENGES = 64;
const MAX_BYTES = 65_536;
const MAX_DEPTH = 20;
const MAX_NODES = 1024;
const MAX_KEYS = 128;
const MAX_ARRAY = 128;
const MAX_STRING = 4096;
const ERRORS = Object.freeze({
  SPANS_EXECUTION_CONFIRMATION_CAPACITY:
    'No confirmation challenge is currently available.',
  SPANS_EXECUTION_CONFIRMATION_CLOSED: 'The confirmation service is closed.',
  SPANS_EXECUTION_CONFIRMATION_INVALID:
    'Execution confirmation could not be issued.',
  SPANS_EXECUTION_CONFIRMATION_UNAVAILABLE:
    'Execution confirmation could not be verified.',
});

const refusal = (code) => ({ code, error: ERRORS[code], ok: false });
const isRecord = (value) =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

function isProxy(value) {
  try {
    return types.isProxy(value);
  } catch {
    return true;
  }
}

function plainRecord(value) {
  if (isProxy(value) || !isRecord(value)) {
    return false;
  }
  try {
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
  } catch {
    return false;
  }
}

function dataProperty(value, key) {
  if (!plainRecord(value)) {
    return;
  }
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor?.enumerable && Object.hasOwn(descriptor, 'value')
      ? descriptor.value
      : undefined;
  } catch {
    // A hostile object is treated as a missing data property.
  }
}

function addBytes(state, value) {
  state.bytes += Buffer.byteLength(value, 'utf8');
  if (state.bytes > MAX_BYTES) {
    throw new TypeError('bounds');
  }
}

function cloneArray(value, depth, state, ancestors) {
  if (Object.getPrototypeOf(value) !== Array.prototype) {
    throw new TypeError('array');
  }
  const keys = Reflect.ownKeys(value);
  const length = Object.getOwnPropertyDescriptor(value, 'length')?.value;
  if (
    !Number.isSafeInteger(length) ||
    length > MAX_ARRAY ||
    keys.length !== length + 1
  ) {
    throw new TypeError('array');
  }
  const result = [];
  for (let index = 0; index < length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!(descriptor?.enumerable && Object.hasOwn(descriptor, 'value'))) {
      throw new TypeError('array');
    }
    result.push(cloneVisit(descriptor.value, depth + 1, state, ancestors));
  }
  return result;
}

function cloneObject(value, depth, state, ancestors) {
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError('object');
  }
  const keys = Reflect.ownKeys(value);
  if (keys.length > MAX_KEYS) {
    throw new TypeError('keys');
  }
  const result = {};
  for (const key of keys) {
    if (
      typeof key !== 'string' ||
      key.length > MAX_STRING ||
      key === '__proto__'
    ) {
      throw new TypeError('key');
    }
    addBytes(state, key);
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!(descriptor?.enumerable && Object.hasOwn(descriptor, 'value'))) {
      throw new TypeError('property');
    }
    result[key] = cloneVisit(descriptor.value, depth + 1, state, ancestors);
  }
  return result;
}

function cloneVisit(value, depth, state, ancestors) {
  state.nodes += 1;
  if (state.nodes > MAX_NODES || depth > MAX_DEPTH) {
    throw new TypeError('bounds');
  }
  if (value === null || typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new TypeError('number');
    }
    return value;
  }
  if (typeof value === 'string') {
    if (value.length > MAX_STRING) {
      throw new TypeError('string');
    }
    addBytes(state, value);
    return value;
  }
  if (typeof value !== 'object' || isProxy(value) || ancestors.has(value)) {
    throw new TypeError('value');
  }

  ancestors.add(value);
  const result = Array.isArray(value)
    ? cloneArray(value, depth, state, ancestors)
    : cloneObject(value, depth, state, ancestors);
  ancestors.delete(value);
  return result;
}

function cloneBounded(value) {
  const copy = cloneVisit(value, 0, { bytes: 0, nodes: 0 }, new Set());
  if (Buffer.byteLength(JSON.stringify(copy), 'utf8') > MAX_BYTES) {
    throw new TypeError('bounds');
  }
  return copy;
}

function exactKeys(value, keys, optional = []) {
  const allowed = new Set([...keys, ...optional]);
  return (
    plainRecord(value) &&
    Reflect.ownKeys(value).every(
      (key) => typeof key === 'string' && allowed.has(key)
    ) &&
    [...keys, ...optional.filter((key) => Object.hasOwn(value, key))].every(
      (key) => {
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        return descriptor?.enumerable && Object.hasOwn(descriptor, 'value');
      }
    )
  );
}

function snapshotExact(raw, keys, optional = []) {
  const copy = cloneBounded(raw);
  return exactKeys(copy, keys, optional) ? copy : null;
}

function snapshotOptions(raw) {
  if (!plainRecord(raw)) {
    return null;
  }
  try {
    const keys = Reflect.ownKeys(raw);
    const allowed = new Set(['now', 'randomBytes', 'readReview', 'store']);
    if (
      keys.some(
        (key) =>
          typeof key !== 'string' ||
          !allowed.has(key) ||
          !Object.getOwnPropertyDescriptor(raw, key)?.enumerable ||
          !Object.hasOwn(Object.getOwnPropertyDescriptor(raw, key), 'value')
      )
    ) {
      return null;
    }
    return Object.fromEntries(
      keys.map((key) => [key, Object.getOwnPropertyDescriptor(raw, key).value])
    );
  } catch {
    return null;
  }
}

function getMethod(value, key) {
  const method = dataProperty(value, key);
  return typeof method === 'function' ? method : null;
}

function exactConfirmation(value) {
  if (
    !exactKeys(value, ['confirmedAt', 'reference', 'source']) ||
    typeof value.source !== 'string' ||
    value.source !== SOURCE ||
    typeof value.reference !== 'string' ||
    !CHALLENGE_ID.test(value.reference) ||
    typeof value.confirmedAt !== 'string' ||
    value.confirmedAt.length > 64 ||
    Number.isNaN(Date.parse(value.confirmedAt))
  ) {
    return null;
  }
  return {
    confirmedAt: value.confirmedAt,
    reference: value.reference,
    source: value.source,
  };
}

function validReceiptConfirmation(value) {
  if (
    !exactKeys(value, ['confirmedAt', 'reference', 'source']) ||
    typeof value.source !== 'string' ||
    value.source.length < 1 ||
    value.source.length > 128 ||
    typeof value.reference !== 'string' ||
    !REFERENCE.test(value.reference) ||
    typeof value.confirmedAt !== 'string' ||
    value.confirmedAt.length > 64 ||
    Number.isNaN(Date.parse(value.confirmedAt))
  ) {
    return false;
  }
  return true;
}

function validRevocation(value) {
  return (
    exactKeys(value, ['at', 'reference', 'source', 'version']) &&
    value.version === SPANS_EXECUTION_REVIEW_VERSION &&
    typeof value.source === 'string' &&
    value.source.length > 0 &&
    value.source.length <= 128 &&
    typeof value.reference === 'string' &&
    REFERENCE.test(value.reference) &&
    typeof value.at === 'string' &&
    value.at.length <= 64 &&
    !Number.isNaN(Date.parse(value.at))
  );
}

function canonical(value) {
  if (Array.isArray(value)) {
    return `[${value.map(canonical).join(',')}]`;
  }
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function isReviewRecord(value, runId, reviewDigest) {
  if (
    !exactKeys(value, ['binding', 'executionVersion', 'reviewDigest']) ||
    value.executionVersion !== SPANS_EXECUTION_REVIEW_VERSION ||
    value.reviewDigest !== reviewDigest ||
    !REVIEW_DIGEST.test(reviewDigest) ||
    !plainRecord(value.binding) ||
    dataProperty(value.binding, 'runId') !== runId
  ) {
    return false;
  }
  try {
    const encoded = canonical(value.binding);
    return (
      createHash('sha256').update(encoded, 'utf8').digest('hex') ===
      reviewDigest
    );
  } catch {
    return false;
  }
}

function confirmationMatches(left, right) {
  return (
    left.confirmedAt === right.confirmedAt &&
    left.reference === right.reference &&
    left.source === right.source
  );
}

function readStoreRun(readRun, store, runId) {
  try {
    return readRun.call(store, { runId });
  } catch {
    return null;
  }
}

function snapshotReceipt(runResult, runId, reviewDigest) {
  try {
    if (!plainRecord(runResult) || dataProperty(runResult, 'ok') !== true) {
      return null;
    }
    const view = dataProperty(runResult, 'view');
    const execution = dataProperty(view, 'execution');
    if (
      !plainRecord(execution) ||
      dataProperty(execution, 'version') !== SPANS_EXECUTION_REVIEW_VERSION
    ) {
      return null;
    }
    const reviews = dataProperty(execution, 'reviews');
    const receipts = dataProperty(execution, 'receipts');
    if (!(plainRecord(reviews) && plainRecord(receipts))) {
      return null;
    }
    const reviewDescriptor = Object.getOwnPropertyDescriptor(
      reviews,
      reviewDigest
    );
    if (
      !(
        reviewDescriptor?.enumerable &&
        Object.hasOwn(reviewDescriptor, 'value') &&
        isReviewRecord(
          cloneBounded(reviewDescriptor.value),
          runId,
          reviewDigest
        )
      )
    ) {
      return null;
    }
    const descriptor = Object.getOwnPropertyDescriptor(receipts, reviewDigest);
    if (!descriptor) {
      return { approvals: [], revocations: [] };
    }
    if (!(descriptor.enumerable && Object.hasOwn(descriptor, 'value'))) {
      return null;
    }
    const receipt = cloneBounded(descriptor.value);
    if (
      !exactKeys(receipt, ['approvals', 'revocations', 'version']) ||
      receipt.version !== SPANS_EXECUTION_REVIEW_VERSION ||
      !Array.isArray(receipt.approvals) ||
      receipt.approvals.length > 64 ||
      !Array.isArray(receipt.revocations) ||
      receipt.revocations.length > 64
    ) {
      return null;
    }
    const approvalsValid = receipt.approvals.every(
      (entry) =>
        exactKeys(entry, ['confirmation', 'version']) &&
        entry.version === SPANS_EXECUTION_REVIEW_VERSION &&
        validReceiptConfirmation(entry.confirmation)
    );
    const revocationsValid = receipt.revocations.every(validRevocation);
    if (!(approvalsValid && revocationsValid)) {
      return null;
    }
    return {
      approvals: receipt.approvals,
      revocations: receipt.revocations,
    };
  } catch {
    return null;
  }
}

function trustedDate(now) {
  try {
    const value = now();
    const time =
      value instanceof Date ? Date.prototype.getTime.call(value) : value;
    if (typeof time !== 'number' || !Number.isFinite(time)) {
      return null;
    }
    const date = new Date(time);
    return Number.isNaN(date.getTime()) ? null : date;
  } catch {
    return null;
  }
}

function challengeIdFrom(randomBytes) {
  try {
    const bytes = randomBytes(32);
    if (
      isProxy(bytes) ||
      !(Buffer.isBuffer(bytes) || bytes instanceof Uint8Array) ||
      bytes.byteLength !== 32
    ) {
      return null;
    }
    return Buffer.from(bytes).toString('hex');
  } catch {
    return null;
  }
}

/**
 * Create a volatile confirmation adapter. Construction performs no store or
 * review reads; callers provide the existing durable store and review reader.
 */
export function createSpansExecutionConfirmation(rawOptions = {}) {
  const options = snapshotOptions(rawOptions);
  const store = options?.store;
  const readRun = getMethod(store, 'readRun');
  const readReview = options?.readReview;
  const now = options?.now ?? (() => new Date());
  const randomBytes = options?.randomBytes ?? cryptoRandomBytes;
  const configured =
    Boolean(options) &&
    typeof readRun === 'function' &&
    typeof readReview === 'function' &&
    typeof now === 'function' &&
    typeof randomBytes === 'function';
  const challenges = new Map();
  let closed = false;

  async function currentReview(runId, reviewDigest) {
    try {
      const result = await readReview({ reviewDigest, runId });
      const snapshot = cloneBounded(result);
      if (
        !exactKeys(snapshot, ['ok', 'review']) ||
        snapshot.ok !== true ||
        !isReviewRecord(snapshot.review, runId, reviewDigest)
      ) {
        return null;
      }
      return snapshot.review;
    } catch {
      return null;
    }
  }

  async function currentReceipt(runId, reviewDigest) {
    try {
      const result = await readStoreRun(readRun, store, runId);
      return snapshotReceipt(result, runId, reviewDigest);
    } catch {
      return null;
    }
  }

  function purgeExpired(nowMs) {
    for (const [id, challenge] of challenges) {
      if (challenge.expiresAt <= nowMs) {
        challenges.delete(id);
      }
    }
  }

  function issueRequest(raw) {
    let request;
    try {
      request = snapshotExact(raw, ['reviewDigest', 'runId'], ['intent']);
    } catch {
      request = null;
    }
    if (
      !request ||
      typeof request.runId !== 'string' ||
      !RUN_ID.test(request.runId) ||
      typeof request.reviewDigest !== 'string' ||
      !REVIEW_DIGEST.test(request.reviewDigest) ||
      (request.intent !== undefined && !INTENTS.includes(request.intent))
    ) {
      return null;
    }
    return { ...request, intent: request.intent ?? 'approve' };
  }

  function phraseFor(intent, reviewDigest) {
    const verb = intent === 'revoke' ? 'Revoke' : 'Approve';
    return `${verb} ${reviewDigest.slice(0, 12)}`;
  }

  function sourceFor(intent) {
    return intent === 'revoke' ? REVOCATION_SOURCE : SOURCE;
  }

  async function issueValidated(request) {
    if (!(await currentReview(request.runId, request.reviewDigest)) || closed) {
      return refusal('SPANS_EXECUTION_CONFIRMATION_INVALID');
    }
    const receipt = await currentReceipt(request.runId, request.reviewDigest);
    if (
      !receipt ||
      receipt.revocations.length > 0 ||
      (request.intent === 'revoke' && receipt.approvals.length === 0) ||
      closed
    ) {
      return refusal('SPANS_EXECUTION_CONFIRMATION_UNAVAILABLE');
    }
    const issuedAt = trustedDate(now);
    if (!issuedAt) {
      return refusal('SPANS_EXECUTION_CONFIRMATION_UNAVAILABLE');
    }
    purgeExpired(issuedAt.getTime());
    if (challenges.size >= MAX_CHALLENGES) {
      return refusal('SPANS_EXECUTION_CONFIRMATION_CAPACITY');
    }
    let id;
    for (let attempt = 0; attempt < 4; attempt += 1) {
      id = challengeIdFrom(randomBytes);
      if (id && !challenges.has(id)) {
        break;
      }
      id = null;
    }
    if (!id || closed) {
      return refusal('SPANS_EXECUTION_CONFIRMATION_UNAVAILABLE');
    }
    const expiresAt = issuedAt.getTime() + CHALLENGE_TTL_MS;
    const phrase = phraseFor(request.intent, request.reviewDigest);
    challenges.set(id, {
      expiresAt,
      intent: request.intent,
      phrase,
      reviewDigest: request.reviewDigest,
      runId: request.runId,
    });
    return {
      challengeId: id,
      expiresAt: new Date(expiresAt).toISOString(),
      intent: request.intent,
      ok: true,
      phrase,
      reviewDigest: request.reviewDigest,
    };
  }

  async function issue(raw) {
    if (closed) {
      return refusal('SPANS_EXECUTION_CONFIRMATION_CLOSED');
    }
    if (!configured) {
      return refusal('SPANS_EXECUTION_CONFIRMATION_UNAVAILABLE');
    }
    const request = issueRequest(raw);
    if (!request) {
      return refusal('SPANS_EXECUTION_CONFIRMATION_INVALID');
    }
    return await issueValidated(request);
  }

  function verifyRequest(raw) {
    let request;
    try {
      request = snapshotExact(
        raw,
        ['confirmation', 'reviewDigest', 'runId'],
        ['intent']
      );
    } catch {
      request = null;
    }
    if (
      !request ||
      typeof request.runId !== 'string' ||
      !RUN_ID.test(request.runId) ||
      typeof request.reviewDigest !== 'string' ||
      !REVIEW_DIGEST.test(request.reviewDigest) ||
      (request.intent !== undefined && !INTENTS.includes(request.intent))
    ) {
      return null;
    }
    return { ...request, intent: request.intent ?? 'approve' };
  }

  function humanProofFor(confirmation) {
    let humanProof;
    try {
      humanProof = snapshotExact(confirmation, ['challengeId', 'response']);
    } catch {
      humanProof = null;
    }
    return humanProof;
  }

  function durableProofFor(confirmation) {
    let durableConfirmation;
    try {
      durableConfirmation = exactConfirmation(confirmation);
    } catch {
      durableConfirmation = null;
    }
    return durableConfirmation;
  }

  async function verifyHuman(request, humanProof) {
    const challenge = challenges.get(humanProof.challengeId);
    // Consume before review/store I/O so concurrent calls cannot reuse it.
    challenges.delete(humanProof.challengeId);
    const confirmedAt = trustedDate(now);
    if (
      !(challenge && confirmedAt) ||
      challenge.expiresAt <= confirmedAt.getTime() ||
      challenge.intent !== request.intent ||
      challenge.runId !== request.runId ||
      challenge.reviewDigest !== request.reviewDigest ||
      humanProof.response !== challenge.phrase
    ) {
      return null;
    }
    if (!(await currentReview(request.runId, request.reviewDigest)) || closed) {
      return null;
    }
    const receipt = await currentReceipt(request.runId, request.reviewDigest);
    if (
      !receipt ||
      receipt.revocations.length > 0 ||
      (request.intent === 'revoke' && receipt.approvals.length === 0) ||
      closed
    ) {
      return null;
    }
    return {
      confirmedAt: confirmedAt.toISOString(),
      reference: humanProof.challengeId,
      source: sourceFor(request.intent),
    };
  }

  async function verifyDurable(request, durableConfirmation) {
    if (!(await currentReview(request.runId, request.reviewDigest)) || closed) {
      return null;
    }
    const receipt = await currentReceipt(request.runId, request.reviewDigest);
    if (!receipt || receipt.revocations.length > 0 || closed) {
      return null;
    }
    const persisted = receipt.approvals.some((entry) =>
      confirmationMatches(entry.confirmation, durableConfirmation)
    );
    return persisted ? durableConfirmation : null;
  }

  async function verify(raw) {
    if (closed || !configured) {
      return null;
    }
    const request = verifyRequest(raw);
    if (!request) {
      return null;
    }
    const humanProof = humanProofFor(request.confirmation);
    if (humanProof) {
      return await verifyHuman(request, humanProof);
    }
    if (request.intent !== 'approve') {
      return null;
    }
    const durableConfirmation = durableProofFor(request.confirmation);
    if (!durableConfirmation) {
      return null;
    }
    return await verifyDurable(request, durableConfirmation);
  }

  async function verifyRevocation(raw) {
    if (closed || !configured) {
      return null;
    }
    const request = verifyRequest(raw);
    if (request?.intent !== 'revoke') {
      return null;
    }
    const humanProof = humanProofFor(request.confirmation);
    return humanProof ? await verifyHuman(request, humanProof) : null;
  }

  function close() {
    closed = true;
    challenges.clear();
  }

  return Object.freeze({ close, issue, verify, verifyRevocation });
}
