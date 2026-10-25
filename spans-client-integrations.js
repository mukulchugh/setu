import { randomBytes as nodeRandomBytes } from 'node:crypto';
import { isAbsolute, resolve } from 'node:path';
import { types as utilTypes } from 'node:util';
import { createSpansIntegrationRuntime } from './spans-integration-runtime.js';

const CLIENTS = Object.freeze(['codex', 'claude', 'cursor']);
const CLIENT_SET = new Set(CLIENTS);
const DIGEST = /^sha256:[a-f0-9]{64}$/;
const REVIEW_ID = /^[a-f0-9]{64}$/;
const SAFE_CODE = /^[A-Z][A-Z0-9_]{0,63}$/;
const SAFE_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
const MAX_REVIEWS = 64;
const REVIEW_TTL_MS = 5 * 60 * 1000;
const MAX_INPUT_BYTES = 16 * 1024;
const MAX_TEXT_BYTES = 4096;

const ERROR_MESSAGES = Object.freeze({
  CLIENT_INTEGRATION_APPLY_FAILED:
    'The client integration could not be applied.',
  CLIENT_INTEGRATION_CLOSED: 'The client integration service is closed.',
  CLIENT_INTEGRATION_CONFIRMATION_REQUIRED:
    'The confirmation did not match this review.',
  CLIENT_INTEGRATION_CONFLICT:
    'The native client files changed or conflict with this review.',
  CLIENT_INTEGRATION_ENTROPY_UNAVAILABLE:
    'A secure client integration review could not be issued.',
  CLIENT_INTEGRATION_INPUT_INVALID: 'Invalid client integration request.',
  CLIENT_INTEGRATION_RECONCILIATION_FAILED:
    'Client integration receipts could not be reconciled.',
  CLIENT_INTEGRATION_RECONCILIATION_REQUIRED:
    'A pending client integration needs receipt reconciliation before a new review.',
  CLIENT_INTEGRATION_REMOVAL_UNSUPPORTED:
    'This client removal is not supported by the shared artifact owner.',
  CLIENT_INTEGRATION_REVIEW_CAPACITY:
    'Too many client integration reviews are active.',
  CLIENT_INTEGRATION_REVIEW_EXPIRED:
    'This client integration review expired. Review the current files again.',
  CLIENT_INTEGRATION_REVIEW_INVALID:
    'This client integration review is unavailable. Review the current files again.',
  CLIENT_INTEGRATION_REVIEW_USED:
    'This client integration review was already used. Review the current files again.',
  CLIENT_INTEGRATION_RUNTIME_FAILED:
    'The client integration preview could not be read.',
  CLIENT_INTEGRATION_RUNTIME_INVALID:
    'The client integration preview could not be summarized safely.',
  CLIENT_INTEGRATION_SELECTION_INVALID: 'Choose one or more supported clients.',
  CLIENT_INTEGRATION_STALE:
    'The native client files no longer match this review.',
});

const UNKNOWN_RUNTIME_CODES = new Set([
  'INTEGRATION_EFFECT_UNKNOWN',
  'INTEGRATION_EFFECT_NOT_CONFIRMED',
  'INTEGRATION_RECEIPT_NOT_CONFIRMED',
  'INTEGRATION_RECONCILIATION_REQUIRED',
  'INTEGRATION_STATE_WRITE_UNKNOWN',
  'INTEGRATION_TARGET_UNREADABLE',
]);
const PUBLIC_RUNTIME_CODES = new Map([
  ['INTEGRATION_INPUT_INVALID', 'CLIENT_INTEGRATION_INPUT_INVALID'],
  ['INTEGRATION_PREVIEW_CONFLICT', 'CLIENT_INTEGRATION_CONFLICT'],
  ['INTEGRATION_PREVIEW_STALE', 'CLIENT_INTEGRATION_STALE'],
  [
    'INTEGRATION_RECONCILIATION_REQUIRED',
    'CLIENT_INTEGRATION_RECONCILIATION_REQUIRED',
  ],
  ['INTEGRATION_REMOVAL_UNSUPPORTED', 'CLIENT_INTEGRATION_REMOVAL_UNSUPPORTED'],
  ['INTEGRATION_RUNTIME_CLOSED', 'CLIENT_INTEGRATION_CLOSED'],
]);

function plainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function accountBytes(state, bytes) {
  state.bytes += bytes;
  if (state.bytes > MAX_INPUT_BYTES) {
    throw new Error('invalid input');
  }
}

function copyArray(value, state, ancestors, depth) {
  const keys = Reflect.ownKeys(value);
  if (
    Object.getPrototypeOf(value) !== Array.prototype ||
    value.length > CLIENTS.length ||
    keys.length !== value.length + 1 ||
    !keys.includes('length')
  ) {
    throw new Error('invalid input');
  }
  const result = [];
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!(descriptor && Object.hasOwn(descriptor, 'value'))) {
      throw new Error('invalid input');
    }
    result.push(copyValue(descriptor.value, state, ancestors, depth + 1));
  }
  return result;
}

function copyObject(value, state, ancestors, depth) {
  if (!plainObject(value)) {
    throw new Error('invalid input');
  }
  const keys = Reflect.ownKeys(value);
  if (keys.length > 8 || keys.some((key) => typeof key !== 'string')) {
    throw new Error('invalid input');
  }
  const result = Object.create(null);
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!(descriptor && Object.hasOwn(descriptor, 'value'))) {
      throw new Error('invalid input');
    }
    accountBytes(state, Buffer.byteLength(key, 'utf8'));
    result[key] = copyValue(descriptor.value, state, ancestors, depth + 1);
  }
  return result;
}

function copyValue(value, state, ancestors = new Set(), depth = 0) {
  state.nodes += 1;
  if (state.nodes > 256 || depth > 5) {
    throw new Error('invalid input');
  }
  if (typeof value === 'string') {
    const bytes = Buffer.byteLength(value, 'utf8');
    if (value.includes('\0') || bytes > MAX_TEXT_BYTES) {
      throw new Error('invalid input');
    }
    accountBytes(state, bytes);
    return value;
  }
  if (value === null || typeof value === 'boolean') {
    accountBytes(state, 8);
    return value;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new Error('invalid input');
    }
    accountBytes(state, 8);
    return value;
  }
  if (
    typeof value !== 'object' ||
    utilTypes.isProxy(value) ||
    ancestors.has(value)
  ) {
    throw new Error('invalid input');
  }
  ancestors.add(value);
  const result = Array.isArray(value)
    ? copyArray(value, state, ancestors, depth)
    : copyObject(value, state, ancestors, depth);
  ancestors.delete(value);
  return result;
}

function snapshot(value) {
  return copyValue(value, { bytes: 0, nodes: 0 });
}

function exactKeys(value, required, optional = []) {
  if (!plainObject(value)) {
    return false;
  }
  const keys = Reflect.ownKeys(value);
  const allowed = new Set([...required, ...optional]);
  return (
    required.every((key) => Object.hasOwn(value, key)) &&
    keys.every((key) => typeof key === 'string' && allowed.has(key))
  );
}

function validPath(value) {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    !value.includes('\0') &&
    isAbsolute(value) &&
    resolve(value) === value
  );
}

function readFactoryOptions(input) {
  if (utilTypes.isProxy(input) || !plainObject(input)) {
    throw Object.assign(new Error('Invalid factory configuration.'), {
      code: 'CLIENT_INTEGRATION_CONFIG_INVALID',
    });
  }
  const allowed = [
    'home',
    'integrationRoot',
    'now',
    'randomBytes',
    'readHandshakes',
    'skillSourcePath',
  ];
  const keys = Reflect.ownKeys(input);
  if (
    keys.some((key) => typeof key !== 'string' || !allowed.includes(key)) ||
    !['home', 'integrationRoot', 'skillSourcePath'].every((key) =>
      keys.includes(key)
    )
  ) {
    throw Object.assign(new Error('Invalid factory configuration.'), {
      code: 'CLIENT_INTEGRATION_CONFIG_INVALID',
    });
  }
  const options = Object.create(null);
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(input, key);
    if (!(descriptor && Object.hasOwn(descriptor, 'value'))) {
      throw Object.assign(new Error('Invalid factory configuration.'), {
        code: 'CLIENT_INTEGRATION_CONFIG_INVALID',
      });
    }
    options[key] = descriptor.value;
  }
  const validPaths = [
    options.home,
    options.integrationRoot,
    options.skillSourcePath,
  ].every(validPath);
  const validCallbacks = ['now', 'randomBytes', 'readHandshakes'].every(
    (key) =>
      options[key] === undefined ||
      (typeof options[key] === 'function' && !utilTypes.isProxy(options[key]))
  );
  if (!validPaths || options.home === resolve('/') || !validCallbacks) {
    throw Object.assign(new Error('Invalid factory configuration.'), {
      code: 'CLIENT_INTEGRATION_CONFIG_INVALID',
    });
  }
  return options;
}

function isClientList(value) {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.length <= CLIENTS.length &&
    new Set(value).size === value.length &&
    value.every((client) => CLIENT_SET.has(client))
  );
}

function parseSelection(input) {
  let value;
  try {
    value = snapshot(input);
  } catch {
    return { error: 'CLIENT_INTEGRATION_INPUT_INVALID' };
  }
  if (
    !exactKeys(value, [], ['clients', 'removeClient', 'removeSharedArtifact'])
  ) {
    return { error: 'CLIENT_INTEGRATION_INPUT_INVALID' };
  }
  const clients = value.clients ?? [...CLIENTS];
  if (!isClientList(clients)) {
    return { error: 'CLIENT_INTEGRATION_SELECTION_INVALID' };
  }
  if (
    value.removeClient !== undefined &&
    (typeof value.removeClient !== 'string' ||
      !CLIENT_SET.has(value.removeClient) ||
      !clients.includes(value.removeClient))
  ) {
    return { error: 'CLIENT_INTEGRATION_SELECTION_INVALID' };
  }
  if (
    value.removeSharedArtifact !== undefined &&
    value.removeSharedArtifact !== true
  ) {
    return { error: 'CLIENT_INTEGRATION_SELECTION_INVALID' };
  }
  if (
    value.removeSharedArtifact === true &&
    (value.removeClient !== undefined ||
      clients.length !== 2 ||
      !clients.includes('codex') ||
      !clients.includes('cursor'))
  ) {
    return { error: 'CLIENT_INTEGRATION_SELECTION_INVALID' };
  }
  return {
    selection: {
      clients: [...clients],
      ...(value.removeClient ? { removeClient: value.removeClient } : {}),
      ...(value.removeSharedArtifact ? { removeSharedArtifact: true } : {}),
    },
  };
}

function fixedFailure(code, { unknown = false } = {}) {
  const normalized = Object.hasOwn(ERROR_MESSAGES, code)
    ? code
    : 'CLIENT_INTEGRATION_RUNTIME_FAILED';
  return {
    code: normalized,
    error: ERROR_MESSAGES[normalized],
    ok: false,
    ...(unknown ? { unknown: true } : {}),
  };
}

function runtimeFailure(
  result,
  fallback = 'CLIENT_INTEGRATION_RUNTIME_FAILED'
) {
  const code =
    typeof result?.code === 'string' && SAFE_CODE.test(result.code)
      ? result.code
      : fallback;
  const unknown = UNKNOWN_RUNTIME_CODES.has(code) || result?.unknown === true;
  const publicCode = PUBLIC_RUNTIME_CODES.get(code) ?? fallback;
  return fixedFailure(publicCode, { unknown });
}

function safeIdentifier(value) {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= MAX_TEXT_BYTES &&
    !value.includes('\0') &&
    SAFE_IDENTIFIER.test(value)
  );
}

function projectConflict(value) {
  if (!plainObject(value)) {
    return null;
  }
  if (!safeIdentifier(value.code)) {
    return null;
  }
  const conflict = { code: value.code };
  if (CLIENT_SET.has(value.client)) {
    conflict.client = value.client;
  }
  if (
    validPath(value.path) &&
    Buffer.byteLength(value.path, 'utf8') <= MAX_TEXT_BYTES
  ) {
    conflict.path = value.path;
  }
  return conflict;
}

function statusFor(client, rawStatus, source, operations, conflicts) {
  const hasOwnershipConflict = conflicts.some(
    (conflict) => conflict.client === client
  );
  if (client === 'claude') {
    return {
      client,
      connected: source?.mcpConnection === 'connected' ? true : 'unknown',
      freshSession: 'unknown',
      installed: 'unknown',
      ownership: 'bundled-plugin',
      skillActivated: 'unknown',
    };
  }
  const verified = rawStatus?.verified === 'verified';
  const operationForClient = operations.find(
    (row) => row.client === (client === 'cursor' ? 'codex' : client)
  );
  let ownership = 'unverified';
  if (hasOwnershipConflict) {
    ownership = 'conflict';
  } else if (['no-op', 'remove'].includes(operationForClient?.kind)) {
    ownership = 'verified';
  }
  return {
    client,
    connected: rawStatus?.connected === 'connected' ? true : 'unknown',
    freshSession: verified ? true : 'unknown',
    installed: rawStatus?.installed === 'installed' ? true : 'unknown',
    ownership,
    skillActivated: verified ? true : 'unknown',
  };
}

function validRuntimePreview(raw, expectedClients) {
  if (
    !(
      plainObject(raw) &&
      plainObject(raw.preview) &&
      Array.isArray(raw.clients)
    ) ||
    raw.clients.length < 1 ||
    raw.clients.length > CLIENTS.length ||
    !raw.clients.every((client) => CLIENT_SET.has(client)) ||
    JSON.stringify(raw.clients) !== JSON.stringify(expectedClients) ||
    !DIGEST.test(raw.groupDigest ?? '') ||
    !DIGEST.test(raw.preview.previewDigest ?? '') ||
    !DIGEST.test(raw.sourceDigest ?? '') ||
    !Array.isArray(raw.preview.operations) ||
    raw.preview.operations.length > 16
  ) {
    return false;
  }
  return true;
}

function projectConflicts(rawConflicts) {
  if (!Array.isArray(rawConflicts)) {
    return [];
  }
  return rawConflicts.slice(0, 64).map(projectConflict).filter(Boolean);
}

function projectOperations(raw) {
  const operations = [];
  for (const operation of raw.preview.operations) {
    if (
      !(
        plainObject(operation) &&
        CLIENT_SET.has(operation.client) &&
        ['create', 'update', 'no-op', 'remove'].includes(operation.kind) &&
        validPath(operation.path)
      ) ||
      Buffer.byteLength(operation.path, 'utf8') > MAX_TEXT_BYTES ||
      !DIGEST.test(operation.digest ?? '') ||
      !safeIdentifier(operation.version)
    ) {
      return null;
    }
    const row = {
      client: operation.client,
      digest: operation.digest,
      kind: operation.kind === 'create' ? 'install' : operation.kind,
      path: operation.path,
      version: operation.version,
    };
    const artifact = Array.isArray(raw.artifactPlans)
      ? raw.artifactPlans.find(
          (plan) =>
            plainObject(plan) &&
            plan.client === operation.client &&
            plan.path === operation.path
        )
      : null;
    if (Array.isArray(artifact?.consumers)) {
      row.consumers = artifact.consumers.filter((client) =>
        CLIENT_SET.has(client)
      );
    }
    operations.push(row);
  }
  return operations;
}

function projectRemoval(raw, selection, summary) {
  if (raw.removeSharedArtifact === true) {
    const removal = raw.sharedArtifactRemoval;
    if (
      !(
        plainObject(removal) &&
        validPath(removal.path) &&
        Array.isArray(removal.affectedClients) &&
        removal.affectedClients.length === 2 &&
        removal.affectedClients.includes('codex') &&
        removal.affectedClients.includes('cursor')
      )
    ) {
      return false;
    }
    summary.sharedArtifactRemoval = {
      affectedClients: ['codex', 'cursor'],
      path: removal.path,
    };
  }
  return (
    !selection.removeSharedArtifact || Boolean(summary.sharedArtifactRemoval)
  );
}

function projectSummary(raw, selection) {
  const expectedClients = selection.clients.filter(
    (client) => client !== selection.removeClient
  );
  if (!validRuntimePreview(raw, expectedClients)) {
    return null;
  }
  const conflicts = projectConflicts(raw.preview.conflicts);
  const operations = projectOperations(raw);
  if (!operations) {
    return null;
  }
  const statuses = raw.clients.map((client) =>
    statusFor(
      client,
      raw.preview.statuses?.[client],
      raw.clientSources?.[client],
      operations,
      conflicts
    )
  );
  const summary = {
    clients: [...raw.clients],
    conflicts,
    groupDigest: raw.groupDigest,
    operations,
    previewDigest: raw.preview.previewDigest,
    ready: raw.ok === true && raw.preview.ok === true && conflicts.length === 0,
    sourceDigest: raw.sourceDigest,
    statuses,
  };
  if (!projectRemoval(raw, selection, summary)) {
    return null;
  }
  return summary;
}

function projectApplied(raw) {
  if (!Array.isArray(raw.applied) || raw.applied.length > 1) {
    return null;
  }
  const applied = [];
  for (const row of raw.applied) {
    if (
      !(
        plainObject(row) &&
        CLIENT_SET.has(row.client) &&
        validPath(row.path)
      ) ||
      Buffer.byteLength(row.path, 'utf8') > MAX_TEXT_BYTES ||
      !['applied', 'removed'].includes(row.status)
    ) {
      return null;
    }
    const output = {
      client: row.client,
      path: row.path,
      status: row.status,
    };
    if (row.digest !== undefined) {
      if (!DIGEST.test(row.digest)) {
        return null;
      }
      output.digest = row.digest;
    }
    if (row.operationId !== undefined) {
      if (!safeIdentifier(row.operationId)) {
        return null;
      }
      output.operationId = row.operationId;
    }
    applied.push(output);
  }
  return {
    applied,
    idempotent: raw.idempotent === true,
    ok: true,
  };
}

function normalizeRandomBytes(callback, length) {
  const value = callback(length);
  if (!(Buffer.isBuffer(value) && value.length === length)) {
    throw new Error('secure random source unavailable');
  }
  return value.toString('hex');
}

function issuePhrase(selection, nonce) {
  if (selection.removeSharedArtifact) {
    return `Remove shared Setu skill for Codex and Cursor (${nonce})`;
  }
  const names = selection.clients
    .map(
      (client) =>
        ({
          claude: 'Claude Code',
          codex: 'Codex',
          cursor: 'Cursor',
        })[client]
    )
    .join(', ');
  return `Install Setu integration for ${names} (${nonce})`;
}

/** Build a private, bounded review/apply wrapper for the native integration runtime. */
export function createSpansClientIntegrations(factoryOptions) {
  const options = readFactoryOptions(factoryOptions);
  const reviews = new Map();
  const proofs = new Map();
  const inFlight = new Set();
  let closed = false;
  let closePromise = null;
  const clock = options.now ?? Date.now;
  const entropy = options.randomBytes ?? nodeRandomBytes;

  function readNow() {
    let value;
    try {
      value = clock();
    } catch (cause) {
      throw new Error('clock unavailable', { cause });
    }
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new Error('clock unavailable');
    }
    return value;
  }

  function forgetReview(reviewId) {
    const record = reviews.get(reviewId);
    if (record) {
      proofs.delete(record.proof);
      reviews.delete(reviewId);
    }
  }

  function prune(at) {
    for (const [reviewId, record] of reviews) {
      if (record.state !== 'applying' && at >= record.expiresAt) {
        forgetReview(reviewId);
      }
    }
  }

  function addReview(record) {
    while (reviews.size >= MAX_REVIEWS) {
      const oldest = [...reviews.entries()].find(
        ([, current]) => current.state !== 'applying'
      );
      if (!oldest) {
        return false;
      }
      forgetReview(oldest[0]);
    }
    reviews.set(record.reviewId, record);
    proofs.set(record.proof, record.reviewId);
    return true;
  }

  function consumeIssuedProof(request) {
    if (!plainObject(request)) {
      return { verified: false };
    }
    const reviewId = proofs.get(request.confirmation);
    const record = reviewId ? reviews.get(reviewId) : null;
    if (
      record?.state !== 'applying' ||
      request.groupDigest !== record.summary.groupDigest ||
      request.previewDigest !== record.summary.previewDigest ||
      !Array.isArray(request.clients) ||
      JSON.stringify(request.clients) !==
        JSON.stringify(record.selection.clients)
    ) {
      return { verified: false };
    }
    try {
      if (readNow() >= record.expiresAt) {
        forgetReview(reviewId);
        return { verified: false };
      }
    } catch {
      forgetReview(reviewId);
      return { verified: false };
    }
    // Delete before returning verified: the runtime awaits this callback before
    // reconciliation, receipt writes, or any native artifact effect.
    proofs.delete(record.proof);
    record.proofConsumed = true;
    return {
      groupDigest: record.summary.groupDigest,
      previewDigest: record.summary.previewDigest,
      verified: true,
    };
  }

  const runtime = createSpansIntegrationRuntime({
    home: options.home,
    integrationRoot: options.integrationRoot,
    skillSourcePath: options.skillSourcePath,
    verifyConfirmation: consumeIssuedProof,
    ...(options.readHandshakes
      ? { readHandshakes: options.readHandshakes }
      : {}),
    ...(options.now ? { now: options.now } : {}),
  });

  function track(work) {
    if (closed) {
      return Promise.resolve(fixedFailure('CLIENT_INTEGRATION_CLOSED'));
    }
    const promise = Promise.resolve().then(work);
    inFlight.add(promise);
    promise.finally(() => inFlight.delete(promise)).catch(() => undefined);
    return promise;
  }

  async function readPreview(selection) {
    let raw;
    try {
      raw = await runtime.preview(selection);
    } catch {
      return { error: fixedFailure('CLIENT_INTEGRATION_RUNTIME_FAILED') };
    }
    if (raw?.ok === false && !raw.preview) {
      return { error: runtimeFailure(raw) };
    }
    const summary = projectSummary(raw, selection);
    if (!summary) {
      return { error: fixedFailure('CLIENT_INTEGRATION_RUNTIME_INVALID') };
    }
    return { raw, summary };
  }

  function preview(selection = {}) {
    const parsed = parseSelection(selection);
    if ('error' in parsed) {
      return Promise.resolve(fixedFailure(parsed.error));
    }
    return track(async () => {
      const result = await readPreview(parsed.selection);
      if ('error' in result) {
        return result.error;
      }
      return { ok: true, summary: result.summary };
    });
  }

  function buildIssuedReview(selection, result, now) {
    if (now > Number.MAX_SAFE_INTEGER - REVIEW_TTL_MS) {
      return { error: fixedFailure('CLIENT_INTEGRATION_RUNTIME_FAILED') };
    }
    let reviewId;
    let proof;
    let nonce;
    try {
      for (let attempt = 0; attempt < 8; attempt += 1) {
        reviewId = normalizeRandomBytes(entropy, 32);
        if (!reviews.has(reviewId)) {
          break;
        }
        reviewId = undefined;
      }
      if (!reviewId) {
        throw new Error('review id collision');
      }
      proof = normalizeRandomBytes(entropy, 32);
      nonce = normalizeRandomBytes(entropy, 4);
    } catch {
      return {
        error: fixedFailure('CLIENT_INTEGRATION_ENTROPY_UNAVAILABLE'),
      };
    }
    const phrase = issuePhrase(selection, nonce);
    const expiresAt = now + REVIEW_TTL_MS;
    const record = {
      expiresAt,
      phrase,
      proof,
      proofConsumed: false,
      raw: result.raw,
      reviewId,
      selection,
      state: 'issued',
      summary: result.summary,
    };
    return {
      record,
      response: {
        expiresAt: new Date(expiresAt).toISOString(),
        ok: true,
        phrase,
        reviewId,
        summary: result.summary,
      },
    };
  }

  async function runReview(selection) {
    let now;
    try {
      now = readNow();
    } catch {
      return fixedFailure('CLIENT_INTEGRATION_RUNTIME_FAILED');
    }
    prune(now);
    const result = await readPreview(selection);
    if ('error' in result) {
      return result.error;
    }
    if (!result.summary.ready) {
      return { ok: true, summary: result.summary };
    }
    const issued = buildIssuedReview(selection, result, now);
    if ('error' in issued) {
      return issued.error;
    }
    if (!addReview(issued.record)) {
      return fixedFailure('CLIENT_INTEGRATION_REVIEW_CAPACITY');
    }
    return issued.response;
  }

  function review(selection = {}) {
    const parsed = parseSelection(selection);
    if ('error' in parsed) {
      return Promise.resolve(fixedFailure(parsed.error));
    }
    return track(() => runReview(parsed.selection));
  }

  function readApplyInput(input) {
    let value;
    try {
      value = snapshot(input);
    } catch {
      return { error: fixedFailure('CLIENT_INTEGRATION_INPUT_INVALID') };
    }
    if (!exactKeys(value, ['reviewId', 'response'])) {
      return { error: fixedFailure('CLIENT_INTEGRATION_INPUT_INVALID') };
    }
    if (
      typeof value.reviewId !== 'string' ||
      !REVIEW_ID.test(value.reviewId) ||
      typeof value.response !== 'string' ||
      value.response.length === 0
    ) {
      return { error: fixedFailure('CLIENT_INTEGRATION_INPUT_INVALID') };
    }
    return { value };
  }

  async function executeApply(record) {
    // A proof attempt is one-use, including a mismatch. A new attempt needs a
    // new filesystem review and phrase.
    record.state = 'applying';
    if (record.response !== record.phrase) {
      forgetReview(record.reviewId);
      return fixedFailure('CLIENT_INTEGRATION_CONFIRMATION_REQUIRED');
    }
    let raw;
    try {
      raw = await runtime.apply({
        confirmation: record.proof,
        groupDigest: record.summary.groupDigest,
        preview: record.raw,
      });
    } catch {
      forgetReview(record.reviewId);
      return fixedFailure('CLIENT_INTEGRATION_APPLY_FAILED', {
        unknown: true,
      });
    }
    const consumed = record.proofConsumed;
    forgetReview(record.reviewId);
    if (!consumed && raw?.ok === true) {
      return fixedFailure('CLIENT_INTEGRATION_APPLY_FAILED', {
        unknown: true,
      });
    }
    if (raw?.ok !== true) {
      return runtimeFailure(raw, 'CLIENT_INTEGRATION_APPLY_FAILED');
    }
    const result = projectApplied(raw);
    return (
      result ??
      fixedFailure('CLIENT_INTEGRATION_RUNTIME_INVALID', { unknown: true })
    );
  }

  function runApply(value) {
    let now;
    try {
      now = readNow();
    } catch {
      return fixedFailure('CLIENT_INTEGRATION_RUNTIME_FAILED');
    }
    let record = reviews.get(value.reviewId);
    if (record && now >= record.expiresAt) {
      forgetReview(record.reviewId);
      return fixedFailure('CLIENT_INTEGRATION_REVIEW_EXPIRED');
    }
    prune(now);
    record = reviews.get(value.reviewId);
    if (!record) {
      return fixedFailure('CLIENT_INTEGRATION_REVIEW_INVALID');
    }
    if (record.state !== 'issued') {
      return fixedFailure('CLIENT_INTEGRATION_REVIEW_USED');
    }
    record.response = value.response;
    return executeApply(record);
  }

  function apply(input) {
    const parsed = readApplyInput(input);
    if ('error' in parsed) {
      return Promise.resolve(parsed.error);
    }
    return track(() => runApply(parsed.value));
  }

  function reconcile(input = {}) {
    let value;
    try {
      value = snapshot(input);
    } catch {
      return Promise.resolve(fixedFailure('CLIENT_INTEGRATION_INPUT_INVALID'));
    }
    if (!exactKeys(value, [])) {
      return Promise.resolve(fixedFailure('CLIENT_INTEGRATION_INPUT_INVALID'));
    }
    return track(async () => {
      let raw;
      try {
        raw = await runtime.reconcile();
      } catch {
        return fixedFailure('CLIENT_INTEGRATION_RECONCILIATION_FAILED');
      }
      if (raw?.ok !== true || !Array.isArray(raw.reconciled)) {
        return runtimeFailure(raw, 'CLIENT_INTEGRATION_RECONCILIATION_FAILED');
      }
      const reconciled = raw.reconciled
        .slice(0, 4096)
        .filter(
          (row) =>
            plainObject(row) &&
            safeIdentifier(row.operationId) &&
            [
              'applied',
              'removed',
              'conflict',
              'unknown',
              'already-settled',
            ].includes(row.status)
        )
        .map((row) => ({
          operationId: row.operationId,
          status: row.status,
        }));
      const unknown = reconciled.some((row) => row.status === 'unknown');
      return {
        ok: true,
        reconciled,
        ...(unknown ? { unknown: true } : {}),
      };
    });
  }

  function close() {
    if (closePromise) {
      return closePromise;
    }
    closed = true;
    closePromise = Promise.allSettled([...inFlight])
      .then(() => runtime.close())
      .then((result) => {
        reviews.clear();
        proofs.clear();
        return result?.ok === true
          ? { closed: true, ok: true }
          : fixedFailure('CLIENT_INTEGRATION_RUNTIME_FAILED');
      });
    return closePromise;
  }

  return Object.freeze({ apply, close, preview, reconcile, review });
}
