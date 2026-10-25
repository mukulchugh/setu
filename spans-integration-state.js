import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { types as utilTypes } from 'node:util';
import { createWorkspaceState } from './workspace-state.js';

const VERSION = 1;
const CLIENTS = new Set(['claude', 'codex', 'cursor']);
const DIGEST = /^sha256:[a-f0-9]{64}$/;
const OPERATIONS = new Set(['install', 'update', 'remove']);
const STATUSES = new Set(['pending', 'applied', 'conflict', 'unknown']);
const OPERATION_ID = /^[A-Za-z0-9_-]{1,128}$/;
const MAX_RECORDS = 4096;
const MAX_DEPTH = 8;
const MAX_NODES = 4096;
const MAX_TEXT = 1024 * 1024;
const MAX_BYTES = 4 * 1024 * 1024;
const fail = (code, options) =>
  Object.assign(new Error(code, options), { code });
const digest = (value) =>
  `sha256:${createHash('sha256').update(value, 'utf8').digest('hex')}`;
const inside = (root, path) => {
  const rel = relative(root, path);
  return (
    rel !== '' &&
    rel !== '..' &&
    !rel.startsWith(`..${sep}`) &&
    !isAbsolute(rel)
  );
};
const plain = (value) =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

// Snapshot own data properties before any async lock wait. Accessors, proxies,
// class instances, symbols, cycles and unbounded payloads are rejected.
function snapshot(
  value,
  budget = { bytes: 0, nodes: 0 },
  ancestors = new Set()
) {
  budget.nodes += 1;
  if (budget.nodes > MAX_NODES) {
    throw fail('INTEGRATION_INPUT_INVALID');
  }
  if (typeof value === 'string') {
    if (value.includes('\0') || Buffer.byteLength(value, 'utf8') > MAX_TEXT) {
      throw fail('INTEGRATION_INPUT_INVALID');
    }
    budget.bytes += Buffer.byteLength(value, 'utf8');
    if (budget.bytes > MAX_BYTES) {
      throw fail('INTEGRATION_INPUT_INVALID');
    }
    return value;
  }
  if (value === null || typeof value === 'boolean') {
    budget.bytes += 8;
    return value;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw fail('INTEGRATION_INPUT_INVALID');
    }
    budget.bytes += 8;
    return value;
  }
  if (
    typeof value !== 'object' ||
    utilTypes.isProxy(value) ||
    ancestors.has(value) ||
    ancestors.size >= MAX_DEPTH
  ) {
    throw fail('INTEGRATION_INPUT_INVALID');
  }
  ancestors.add(value);
  const copy = Array.isArray(value)
    ? snapshotArray(value, budget, ancestors)
    : snapshotObject(value, budget, ancestors);
  ancestors.delete(value);
  return copy;
}

function snapshotArray(value, budget, ancestors) {
  const keys = Reflect.ownKeys(value);
  if (
    Object.getPrototypeOf(value) !== Array.prototype ||
    value.length > MAX_RECORDS ||
    keys.length !== value.length + 1 ||
    !keys.includes('length')
  ) {
    throw fail('INTEGRATION_INPUT_INVALID');
  }
  const copy = [];
  for (let i = 0; i < value.length; i += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(i));
    if (!(descriptor && Object.hasOwn(descriptor, 'value'))) {
      throw fail('INTEGRATION_INPUT_INVALID');
    }
    copy.push(snapshot(descriptor.value, budget, ancestors));
  }
  return copy;
}

function snapshotObject(value, budget, ancestors) {
  const proto = Object.getPrototypeOf(value);
  const keys = Reflect.ownKeys(value);
  if (
    (proto !== Object.prototype && proto !== null) ||
    keys.length > 64 ||
    keys.some((key) => typeof key !== 'string')
  ) {
    throw fail('INTEGRATION_INPUT_INVALID');
  }
  const copy = Object.create(null);
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!(descriptor && Object.hasOwn(descriptor, 'value'))) {
      throw fail('INTEGRATION_INPUT_INVALID');
    }
    budget.bytes += Buffer.byteLength(key, 'utf8');
    if (budget.bytes > MAX_BYTES) {
      throw fail('INTEGRATION_INPUT_INVALID');
    }
    copy[key] = snapshot(descriptor.value, budget, ancestors);
  }
  return copy;
}

function exactKeys(value, required, optional = []) {
  if (!plain(value)) {
    return false;
  }
  const keys = Object.keys(value);
  const accepted = new Set([...required, ...optional]);
  return (
    required.every((key) => Object.hasOwn(value, key)) &&
    keys.every((key) => accepted.has(key))
  );
}

function validRootString(path) {
  return (
    typeof path === 'string' &&
    path.length > 0 &&
    !path.includes('\0') &&
    isAbsolute(path) &&
    resolve(path) === path
  );
}

function validateDocument(document) {
  if (
    !exactKeys(document, ['records', 'version']) ||
    document.version !== VERSION ||
    !Array.isArray(document.records) ||
    document.records.length > MAX_RECORDS
  ) {
    return false;
  }
  const ids = new Set();
  if (Buffer.byteLength(JSON.stringify(document), 'utf8') > MAX_BYTES) {
    return false;
  }
  return document.records.every((row) => {
    if (
      !exactKeys(row, [
        'operationId',
        'client',
        'target',
        'previewDigest',
        'expectedBefore',
        'desiredAfter',
        'operation',
        'status',
        'createdAt',
        'before',
        'after',
        'disposition',
        'receipt',
      ]) ||
      typeof row.operationId !== 'string' ||
      !OPERATION_ID.test(row.operationId) ||
      ids.has(row.operationId) ||
      !CLIENTS.has(row.client) ||
      !validRootString(row.target) ||
      !DIGEST.test(row.previewDigest) ||
      !(row.expectedBefore === null || DIGEST.test(row.expectedBefore)) ||
      !(row.desiredAfter === null || DIGEST.test(row.desiredAfter)) ||
      !OPERATIONS.has(row.operation) ||
      !STATUSES.has(row.status) ||
      !Number.isSafeInteger(row.createdAt) ||
      row.createdAt < 0 ||
      !(row.before === null || DIGEST.test(row.before)) ||
      !(row.after === null || DIGEST.test(row.after)) ||
      !(
        row.disposition === null ||
        row.disposition === 'retain' ||
        row.disposition === 'remove'
      ) ||
      !operationShape(row) ||
      !(row.receipt === null || receiptShape(row.receipt, row)) ||
      (row.status === 'applied' &&
        (row.operation === 'remove'
          ? row.after !== null || row.receipt !== null
          : row.after !== row.desiredAfter || row.receipt === null))
    ) {
      return false;
    }
    ids.add(row.operationId);
    return true;
  });
}

function operationShape(row) {
  if (row.operation === 'install') {
    return (
      row.expectedBefore === null &&
      row.desiredAfter !== null &&
      row.disposition === 'retain'
    );
  }
  if (row.operation === 'update') {
    return (
      row.expectedBefore !== null &&
      row.desiredAfter !== null &&
      row.disposition === 'retain'
    );
  }
  return (
    row.expectedBefore !== null &&
    row.desiredAfter === null &&
    row.disposition === 'remove'
  );
}

function receiptShape(receipt, row) {
  const evidence = receipt.appliedEvidence;
  return (
    row.operation !== 'remove' &&
    exactKeys(receipt, [
      'appliedEvidence',
      'client',
      'content',
      'digest',
      'path',
      'version',
    ]) &&
    exactKeys(evidence, ['state', 'operationId'], ['observedAt']) &&
    receipt.client === row.client &&
    receipt.path === row.target &&
    typeof receipt.version === 'string' &&
    receipt.version.length > 0 &&
    typeof receipt.content === 'string' &&
    !receipt.content.includes('\0') &&
    Buffer.byteLength(receipt.content, 'utf8') <= MAX_TEXT &&
    DIGEST.test(receipt.digest) &&
    receipt.digest === row.desiredAfter &&
    digest(receipt.content) === receipt.digest &&
    receipt.digest === row.after &&
    evidence.state === 'observed' &&
    evidence.operationId === row.operationId &&
    (evidence.observedAt === undefined ||
      (Number.isSafeInteger(evidence.observedAt) && evidence.observedAt >= 0))
  );
}

function validateOperation(input) {
  if (
    !exactKeys(input, [
      'allowedRoot',
      'client',
      'desiredAfter',
      'disposition',
      'expectedBefore',
      'operation',
      'operationId',
      'previewDigest',
      'target',
    ])
  ) {
    throw fail('INTEGRATION_INTENT_INVALID');
  }
  if (!CLIENTS.has(input.client)) {
    throw fail('INTEGRATION_INTENT_INVALID');
  }
  if (!validRootString(input.allowedRoot)) {
    throw fail('INTEGRATION_INTENT_INVALID');
  }
  if (!validRootString(input.target)) {
    throw fail('INTEGRATION_INTENT_INVALID');
  }
  if (!OPERATION_ID.test(input.operationId)) {
    throw fail('INTEGRATION_INTENT_INVALID');
  }
  if (!DIGEST.test(input.previewDigest)) {
    throw fail('INTEGRATION_INTENT_INVALID');
  }
  if (!(input.expectedBefore === null || DIGEST.test(input.expectedBefore))) {
    throw fail('INTEGRATION_INTENT_INVALID');
  }
  if (!(input.desiredAfter === null || DIGEST.test(input.desiredAfter))) {
    throw fail('INTEGRATION_INTENT_INVALID');
  }
  if (!OPERATIONS.has(input.operation)) {
    throw fail('INTEGRATION_INTENT_INVALID');
  }
  if (!(input.disposition === 'retain' || input.disposition === 'remove')) {
    throw fail('INTEGRATION_INTENT_INVALID');
  }
  if (!operationShape(input)) {
    throw fail('INTEGRATION_INTENT_INVALID');
  }
}

function secureRoot(path, provision) {
  if (!validRootString(path) || path === sep) {
    throw fail('INTEGRATION_ROOT_INVALID');
  }
  const parent = dirname(path);
  validateRootParent(parent);
  const rootStat = findOrProvisionRoot(path, provision);
  if (!rootStat) {
    return null;
  }
  validatePrivateRoot(path, rootStat);
  return path;
}

function validateRootParent(parent) {
  let parentReal;
  try {
    parentReal = fs.realpathSync(parent);
  } catch (error) {
    throw fail('INTEGRATION_ROOT_PARENT_UNSAFE', { cause: error });
  }
  if (parentReal !== parent) {
    throw fail('INTEGRATION_ROOT_PARENT_UNSAFE');
  }
  const ancestry = [];
  let cursor = parent;
  while (cursor !== dirname(cursor)) {
    ancestry.push(cursor);
    cursor = dirname(cursor);
  }
  ancestry.push(cursor);
  for (const item of ancestry) {
    let stat;
    try {
      stat = fs.lstatSync(item);
    } catch (error) {
      throw fail('INTEGRATION_ROOT_PARENT_UNSAFE', { cause: error });
    }
    if (
      stat.isSymbolicLink() ||
      !stat.isDirectory() ||
      (stat.uid !== 0 && stat.uid !== process.getuid?.())
    ) {
      throw fail('INTEGRATION_ROOT_PARENT_UNSAFE');
    }
    const mode = stat.mode % 0o1_0000;
    // System /tmp is accepted only as its root-owned sticky directory.
    const sticky = Math.floor(mode / 0o1000) % 2 === 1;
    const groupWritable = Math.floor(mode / 0o020) % 2 === 1;
    const worldWritable = Math.floor(mode / 0o002) % 2 === 1;
    const tmpException = item === tmpdirPath() && stat.uid === 0 && sticky;
    if ((groupWritable || worldWritable) && !tmpException) {
      throw fail('INTEGRATION_ROOT_PARENT_UNSAFE');
    }
  }
}

function findOrProvisionRoot(path, provision) {
  let rootStat;
  try {
    rootStat = fs.lstatSync(path);
  } catch (error) {
    if (error.code !== 'ENOENT' || !provision) {
      return null;
    }
    try {
      fs.mkdirSync(path, { mode: 0o700 });
    } catch (mkdirError) {
      if (mkdirError.code !== 'EEXIST') {
        throw fail('INTEGRATION_ROOT_UNSAFE');
      }
    }
    try {
      rootStat = fs.lstatSync(path);
    } catch (rootStatError) {
      throw fail('INTEGRATION_ROOT_UNSAFE', { cause: rootStatError });
    }
  }
  return rootStat;
}

function validatePrivateRoot(path, rootStat) {
  if (
    rootStat.isSymbolicLink() ||
    !rootStat.isDirectory() ||
    rootStat.uid !== process.getuid?.() ||
    rootStat.mode % 0o1000 !== 0o700 ||
    fs.realpathSync(path) !== path
  ) {
    throw fail('INTEGRATION_ROOT_PERMISSIONS');
  }
}

function tmpdirPath() {
  return resolve(tmpdir());
}

function secureTarget(root, target) {
  if (!inside(root, target)) {
    throw fail('INTEGRATION_TARGET_INVALID');
  }
  assertNoSymlinkAncestors(root);
  try {
    if (fs.realpathSync(root) !== root || !fs.statSync(root).isDirectory()) {
      throw fail('INTEGRATION_TARGET_INVALID');
    }
  } catch (error) {
    if (error.code !== 'ENOENT') {
      throw error;
    }
  }
  assertNoSymlinkAncestors(target, root);
  return target;
}

function assertNoSymlinkAncestors(path, boundary = sep) {
  let current = boundary;
  for (const part of path.slice(boundary.length).split(sep).filter(Boolean)) {
    current = resolve(current, part);
    try {
      if (fs.lstatSync(current).isSymbolicLink()) {
        throw fail('INTEGRATION_TARGET_SYMLINK');
      }
    } catch (error) {
      if (error.code !== 'ENOENT') {
        if (error.code?.startsWith('INTEGRATION_')) {
          throw error;
        }
        throw fail('INTEGRATION_TARGET_UNREADABLE', { cause: error });
      }
    }
  }
}

function validEvidence(input) {
  if (
    !exactKeys(
      input,
      ['operationId', 'observedDigest'],
      ['evidenceKnown', 'receipt']
    )
  ) {
    throw fail('INTEGRATION_EVIDENCE_INVALID');
  }
  if (!OPERATION_ID.test(input.operationId)) {
    throw fail('INTEGRATION_EVIDENCE_INVALID');
  }
  if (!(input.observedDigest === null || DIGEST.test(input.observedDigest))) {
    throw fail('INTEGRATION_EVIDENCE_INVALID');
  }
  if (
    input.evidenceKnown !== undefined &&
    typeof input.evidenceKnown !== 'boolean'
  ) {
    throw fail('INTEGRATION_EVIDENCE_INVALID');
  }
  return {
    ...input,
    evidenceKnown: input.evidenceKnown ?? true,
    receipt: input.receipt ?? null,
  };
}

function applyEvidence(document, evidence) {
  const row = document.records.find(
    (entry) => entry.operationId === evidence.operationId
  );
  if (!row) {
    throw fail('INTEGRATION_OPERATION_NOT_FOUND');
  }
  const { evidenceKnown, observedDigest, receipt } = evidence;
  let outcome = 'unknown';
  let acceptedReceipt = null;
  if (evidenceKnown) {
    const applied = evidenceApplies(row, evidence);
    outcome = applied ? 'applied' : 'conflict';
    if (applied && receipt !== null) {
      acceptedReceipt = structuredClone(receipt);
    }
  }
  if (row.status !== 'pending' && row.status !== 'unknown') {
    if (
      row.status === outcome &&
      row.after === (evidenceKnown ? observedDigest : null) &&
      JSON.stringify(row.receipt) === JSON.stringify(acceptedReceipt)
    ) {
      return document;
    }
    throw fail('INTEGRATION_OPERATION_SETTLED');
  }
  row.status = outcome;
  row.after = evidenceKnown ? observedDigest : null;
  row.receipt = acceptedReceipt;
  return document;
}

function evidenceApplies(row, evidence) {
  const { observedDigest, receipt } = evidence;
  if (observedDigest !== row.desiredAfter) {
    return false;
  }
  if (row.operation === 'remove') {
    return (
      observedDigest === null &&
      row.disposition === 'remove' &&
      row.desiredAfter === null &&
      receipt === null
    );
  }
  return (
    row.desiredAfter !== null &&
    receipt !== null &&
    receiptShape(receipt, { ...row, after: observedDigest })
  );
}

/** State-only owner receipts. Construction and reads never provision the root. */
export function createSpansIntegrationState({
  integrationRoot,
  state,
  now = Date.now,
} = {}) {
  if (!validRootString(integrationRoot)) {
    throw fail('INTEGRATION_ROOT_INVALID');
  }
  const store = state ?? createWorkspaceState({ integrationRoot });
  const file = join(integrationRoot, 'receipts.json');
  function inspectStateFile() {
    try {
      const stat = fs.lstatSync(file);
      if (stat.isSymbolicLink() || !stat.isFile() || stat.size > MAX_BYTES) {
        throw fail('INTEGRATION_STATE_CORRUPT');
      }
      return true;
    } catch (error) {
      if (error.code === 'ENOENT') {
        return false;
      }
      if (error.code === 'INTEGRATION_STATE_CORRUPT') {
        throw error;
      }
      throw fail('INTEGRATION_STATE_UNREADABLE');
    }
  }
  function read() {
    secureRoot(integrationRoot, false);
    if (!inspectStateFile()) {
      return { records: [], version: VERSION };
    }
    let result;
    try {
      result = store.read('integrationReceipts');
    } catch (error) {
      if (error.code === 'STATE_CORRUPT') {
        throw fail('INTEGRATION_STATE_CORRUPT');
      }
      throw fail('INTEGRATION_STATE_UNREADABLE');
    }
    if (!validateDocument(result)) {
      throw fail('INTEGRATION_STATE_CORRUPT');
    }
    return structuredClone(result);
  }
  async function update(mutator) {
    secureRoot(integrationRoot, true);
    inspectStateFile();
    const initialIdentity = fs.lstatSync(integrationRoot);
    try {
      const result = await store.update('integrationReceipts', (current) => {
        secureRoot(integrationRoot, false); // Recheck after acquiring the actual document lock.
        const currentIdentity = fs.lstatSync(integrationRoot);
        if (
          currentIdentity.dev !== initialIdentity.dev ||
          currentIdentity.ino !== initialIdentity.ino
        ) {
          throw fail('INTEGRATION_ROOT_REPLACED');
        }
        if (!validateDocument(current)) {
          throw fail('INTEGRATION_STATE_CORRUPT');
        }
        const next = mutator(structuredClone(current));
        if (!validateDocument(next)) {
          throw fail('INTEGRATION_STATE_INVALID');
        }
        return next;
      });
      if (!result.committed || result.warning || !result.reconciled) {
        return { code: 'INTEGRATION_STATE_WRITE_UNKNOWN', status: 'unknown' };
      }
      return { document: result.value, status: 'committed' };
    } catch (error) {
      if (error.code?.startsWith('INTEGRATION_')) {
        throw error;
      }
      if (error.code === 'STATE_CORRUPT') {
        throw fail('INTEGRATION_STATE_CORRUPT');
      }
      if (error.code === 'STATE_UNREADABLE') {
        throw fail('INTEGRATION_STATE_UNREADABLE');
      }
      if (error.code === 'STATE_WRITE_FAILED' && error.committed === false) {
        throw fail('INTEGRATION_STATE_WRITE_FAILED');
      }
      throw fail('INTEGRATION_STATE_WRITE_UNKNOWN');
    }
  }
  async function beginIntent(request) {
    const input = snapshot(request);
    validateOperation(input);
    const target = secureTarget(input.allowedRoot, input.target);
    const createdAt = now();
    if (!Number.isSafeInteger(createdAt) || createdAt < 0) {
      throw fail('INTEGRATION_INTENT_INVALID');
    }
    const record = {
      after: null,
      before: input.expectedBefore,
      client: input.client,
      createdAt,
      desiredAfter: input.desiredAfter,
      disposition: input.disposition,
      expectedBefore: input.expectedBefore,
      operation: input.operation,
      operationId: input.operationId,
      previewDigest: input.previewDigest,
      receipt: null,
      status: 'pending',
      target,
    };
    return await update((document) => {
      const existing = document.records.find(
        (entry) => entry.operationId === record.operationId
      );
      if (existing) {
        const same = [
          'client',
          'target',
          'previewDigest',
          'expectedBefore',
          'desiredAfter',
          'operation',
          'disposition',
        ].every((key) => existing[key] === record[key]);
        if (same) {
          return document;
        }
        throw fail('INTEGRATION_OPERATION_ID_CONFLICT');
      }
      if (
        document.records.some(
          (entry) =>
            entry.target === target &&
            ['pending', 'unknown'].includes(entry.status)
        )
      ) {
        throw fail('INTEGRATION_RECONCILIATION_REQUIRED');
      }
      if (document.records.length >= MAX_RECORDS) {
        throw fail('INTEGRATION_HISTORY_FULL');
      }
      document.records.push(record);
      return document;
    });
  }
  async function settleEvidence(request) {
    const evidence = validEvidence(snapshot(request));
    return await update((document) => applyEvidence(document, evidence));
  }
  return Object.freeze({
    beginIntent,
    read,
    reconcileEvidence: settleEvidence,
    settleEvidence,
  });
}
