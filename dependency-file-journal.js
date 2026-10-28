// Durable, private records for the hoisted dependency-file workflow.
// Construction and reads are passive; only explicit journal mutations create files.

import { createHash, randomUUID } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import fs from 'node:fs/promises';
import { isAbsolute, join, posix } from 'node:path';
import { dependencyObjectKey } from './dependency-file-object.js';

const SHA256 = /^[a-f0-9]{64}$/;
const DECIMAL = /^(0|[1-9][0-9]*)$/;
const HEAD = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const REPOSITORY_PART_INVALID = /[/\\\s:\p{Cc}]/u;
const CONTROL_CHARACTER = /\p{Cc}/u;
const OPERATION_CODE = /^[A-Z0-9_]{1,64}$/;
const DIRECTORY_NAME = /^[a-z0-9-]{1,96}$/;
const CHECKPOINT_NAME = /^(0|[1-9][0-9]*)\.json$/;
const STATES = new Set([
  'prepared',
  'running',
  'partial',
  'completed',
  'unknown',
  'conflict',
  'released',
]);
const PHASES = ['prepared', 'staged', 'swapped', 'verified', 'released'];
const PHASE_SET = new Set([...PHASES, 'unknown', 'conflict']);
const SAFE_IO_CODES = new Set([
  'EACCES',
  'EDQUOT',
  'EEXIST',
  'EIO',
  'EISDIR',
  'ELOOP',
  'EMFILE',
  'ENFILE',
  'ENOSPC',
  'ENOTDIR',
  'ENOENT',
  'EPERM',
  'EROFS',
]);
const JOURNAL_DIRECTORY = 'dependency-files';
const DIRECTORY_MODE = 0o700;
const RECORD_MODE = 0o600;
const MAX_RECORD_BYTES = 2 * 1024 * 1024;
// ~1 KB per planned file (5 digests + 3 paths); quivly-app's 272k files make a
// 278 MB plan, so size this for MAX_MANIFEST_ENTRIES.
const MAX_MANIFEST_BYTES = 1024 * 1024 * 1024;
// Matches MAX_SCAN_ENTRIES in dependency-file-sharing.js: a hoisted monorepo
// node_modules (quivly-app: ~272k files) must fit in one plan.
const MAX_MANIFEST_ENTRIES = 1_000_000;
// Keep every individually accepted manifest cacheable. The same hard byte
// limit bounds total cached serialized plans, while the manifest entry limit
// bounds the parsed object graph.
const PLAN_CACHE_BYTES_LIMIT = MAX_MANIFEST_BYTES;
const RECORD_NAME_PATTERN = /^[a-z0-9-]{1,96}(?:\.json)?$/;

const isObject = (value) =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

function error(code, phase, { operationId, causeCode } = {}) {
  const result = new Error(`Dependency file journal ${code} (${phase})`);
  result.name = 'DependencyFileJournalError';
  result.code = code;
  result.phase = phase;
  if (SHA256.test(operationId ?? '')) {
    result.operationId = operationId;
  }
  if (SAFE_IO_CODES.has(causeCode)) {
    result.causeCode = causeCode;
  }
  return result;
}

function fail(code, phase, details) {
  throw error(code, phase, details);
}

function hash(text) {
  return createHash('sha256').update(text).digest('hex');
}

function canonicalJson(value) {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(',')}]`;
  }
  if (isObject(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(',')}}`;
  }
  const encoded = JSON.stringify(value);
  if (encoded === undefined) {
    fail('DEPENDENCY_FILE_JOURNAL_INVALID', 'canonicalize');
  }
  return encoded;
}

function freezeJson(value) {
  if (Array.isArray(value)) {
    for (const entry of value) {
      freezeJson(entry);
    }
  } else if (isObject(value)) {
    for (const entry of Object.values(value)) {
      freezeJson(entry);
    }
  }
  return Object.freeze(value);
}

function stableReviewValue(value) {
  if (Array.isArray(value)) {
    return value.map(stableReviewValue);
  }
  if (isObject(value)) {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([key]) => key !== 'atimeNs')
        .map(([key, entry]) => [key, stableReviewValue(entry)])
    );
  }
  return value;
}

function stableReviewJson(value) {
  return canonicalJson(stableReviewValue(value));
}

function exactKeys(value, required, optional = []) {
  if (!isObject(value)) {
    return false;
  }
  const actual = Object.keys(value).sort();
  const allowed = [...required, ...optional].sort();
  if (
    actual.some((key) => !allowed.includes(key)) ||
    required.some((key) => !Object.hasOwn(value, key))
  ) {
    return false;
  }
  return true;
}

// Manifests are intentionally larger than journal summaries. Their byte count
// is checked before parsing, and this walk bounds nesting, fanout and total
// nodes without applying the small-record 20k-node limit.
function validManifestJson(value, depth = 0, budget = { nodes: 0 }) {
  budget.nodes += 1;
  if (budget.nodes > MAX_MANIFEST_ENTRIES * 32 || depth > 16) {
    return false;
  }
  if (
    value === null ||
    typeof value === 'boolean' ||
    (typeof value === 'number' && Number.isSafeInteger(value))
  ) {
    return true;
  }
  if (typeof value === 'string') {
    if (value.length > 16_384) {
      return false;
    }
    for (const character of value) {
      const code = character.codePointAt(0);
      if (code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d) {
        return false;
      }
    }
    return true;
  }
  if (Array.isArray(value)) {
    return (
      value.length <= MAX_MANIFEST_ENTRIES &&
      value.every((entry) => validManifestJson(entry, depth + 1, budget))
    );
  }
  if (!isObject(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return (
    (prototype === Object.prototype || prototype === null) &&
    Object.entries(value).every(
      ([key, entry]) =>
        key.length > 0 &&
        key.length <= 128 &&
        !['__proto__', 'prototype', 'constructor'].includes(key) &&
        validManifestJson(entry, depth + 1, budget)
    )
  );
}

function recordIdentity(info) {
  return [
    String(info.dev),
    String(info.ino),
    String(info.size),
    String(info.mtimeNs),
    String(info.ctimeNs),
  ].join(':');
}

async function readBoundedRecordText(handle, maxBytes) {
  const chunks = [];
  const chunkSize = 64 * 1024;
  let totalBytes = 0;
  while (totalBytes <= maxBytes) {
    const remaining = maxBytes + 1 - totalBytes;
    const chunk = Buffer.allocUnsafe(Math.min(chunkSize, remaining));
    // biome-ignore lint/performance/noAwaitInLoops: sequential descriptor reads cap memory at the record limit.
    const { bytesRead } = await handle.read(chunk, 0, chunk.length, null);
    if (bytesRead === 0) {
      break;
    }
    chunks.push(chunk.subarray(0, bytesRead));
    totalBytes += bytesRead;
  }
  if (totalBytes > maxBytes) {
    fail('DEPENDENCY_FILE_JOURNAL_CORRUPT', 'record-size');
  }
  return Buffer.concat(chunks, totalBytes).toString('utf8');
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function omitKeys(value, excluded) {
  return Object.fromEntries(
    Object.entries(value).filter(([key]) => !excluded.includes(key))
  );
}

function encodeRecord(value, maxBytes) {
  const encoded = `${canonicalJson(value)}\n`;
  if (Buffer.byteLength(encoded) > maxBytes) {
    fail('DEPENDENCY_FILE_JOURNAL_INVALID', 'record-size');
  }
  return encoded;
}

function validRepositoryPart(value) {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    !['.', '..'].includes(value) &&
    !value.startsWith('-') &&
    !REPOSITORY_PART_INVALID.test(value)
  );
}

function validTarget(repo, name) {
  return (
    validRepositoryPart(repo) &&
    typeof name === 'string' &&
    name.length > 0 &&
    name.split('/').every(validRepositoryPart)
  );
}

function validRelativePath(value) {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > 4096 ||
    value.includes('\0') ||
    value.includes('\\') ||
    value.startsWith('/') ||
    posix.normalize(value) !== value
  ) {
    return false;
  }
  const parts = value.split('/');
  return parts.every(
    (part) =>
      part.length > 0 &&
      part !== '.' &&
      part !== '..' &&
      part !== '.git' &&
      !CONTROL_CHARACTER.test(part)
  );
}

function validDigest(value) {
  return typeof value === 'string' && SHA256.test(value);
}

function validDecimalString(value) {
  return typeof value === 'string' && DECIMAL.test(value);
}

function validTimestamp(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function validIdentity(value) {
  const canonicalPath = (path) =>
    typeof path === 'string' &&
    isAbsolute(path) &&
    posix.normalize(path) === path &&
    !path.split('/').includes('..');
  const incarnation = (evidence) =>
    exactKeys(evidence, ['birthtimeNs', 'dev', 'ino']) &&
    validDecimalString(evidence.birthtimeNs) &&
    validDecimalString(evidence.dev) &&
    validDecimalString(evidence.ino) &&
    evidence.birthtimeNs !== '0' &&
    evidence.ino !== '0';
  return (
    exactKeys(value, [
      'known',
      'checkoutPath',
      'repositoryPath',
      'adminPath',
      'checkout',
      'repository',
      'admin',
    ]) &&
    value.known === true &&
    canonicalPath(value.checkoutPath) &&
    canonicalPath(value.repositoryPath) &&
    canonicalPath(value.adminPath) &&
    incarnation(value.checkout) &&
    incarnation(value.repository) &&
    incarnation(value.admin)
  );
}

function validStoreIdentity(value) {
  const canonicalPath = (path) =>
    typeof path === 'string' &&
    isAbsolute(path) &&
    posix.normalize(path) === path &&
    !path.split('/').includes('..');
  return (
    exactKeys(value, [
      'root',
      'device',
      'mountPath',
      'executable',
      'version',
      'namespace',
    ]) &&
    canonicalPath(value.root) &&
    validDecimalString(value.device) &&
    canonicalPath(value.mountPath) &&
    // Device identity is checked by the store; macOS firmlinks defeat text ancestry.
    value.root !== value.mountPath &&
    canonicalPath(value.executable) &&
    value.version === '1.3.14' &&
    value.namespace === 'hoisted/darwin-arm64-bun-1.3.14'
  );
}

const fingerprintKeys = [
  'relativePath',
  'device',
  'inode',
  'size',
  'mode',
  'uid',
  'gid',
  'mtimeNs',
  'ctimeNs',
  'atimeNs',
  'contentHash',
  'metadataHash',
  'identityHash',
  'attributes',
];

function validFingerprint(value) {
  if (!exactKeys(value, fingerprintKeys)) {
    return false;
  }
  if (
    !(
      validRelativePath(value.relativePath) &&
      validDecimalString(value.device) &&
      validDecimalString(value.inode)
    ) ||
    value.inode === '0' ||
    !Number.isSafeInteger(value.size) ||
    value.size < 0 ||
    !Number.isSafeInteger(value.mode) ||
    value.mode < 0 ||
    !Number.isSafeInteger(value.uid) ||
    value.uid < 0 ||
    !Number.isSafeInteger(value.gid) ||
    value.gid < 0 ||
    !validDecimalString(value.mtimeNs) ||
    !validDecimalString(value.ctimeNs) ||
    !validDecimalString(value.atimeNs) ||
    !validDigest(value.contentHash) ||
    !validDigest(value.metadataHash) ||
    !validDigest(value.identityHash) ||
    !Array.isArray(value.attributes)
  ) {
    return false;
  }
  let previousName = null;
  return value.attributes.every((attribute) => {
    if (
      !exactKeys(attribute, ['name', 'digest']) ||
      typeof attribute.name !== 'string' ||
      attribute.name.length === 0 ||
      attribute.name.length > 255 ||
      CONTROL_CHARACTER.test(attribute.name) ||
      !validDigest(attribute.digest) ||
      (previousName !== null && attribute.name <= previousName)
    ) {
      return false;
    }
    previousName = attribute.name;
    return true;
  });
}

function sameFingerprint(left, right) {
  return canonicalJson(left) === canonicalJson(right);
}

function sameCloneData(left, right) {
  return (
    left.device === right.device &&
    left.size === right.size &&
    left.mode === right.mode &&
    left.uid === right.uid &&
    left.gid === right.gid &&
    left.mtimeNs === right.mtimeNs &&
    left.contentHash === right.contentHash &&
    left.metadataHash === right.metadataHash &&
    canonicalJson(left.attributes) === canonicalJson(right.attributes)
  );
}

function samePhysicalFile(left, right) {
  return (
    left.device === right.device &&
    left.inode === right.inode &&
    left.contentHash === right.contentHash &&
    left.metadataHash === right.metadataHash &&
    (left.relativePath !== right.relativePath ||
      (left.ctimeNs === right.ctimeNs &&
        left.identityHash === right.identityHash))
  );
}

function sameFingerprintExceptAtime(left, right) {
  if (!(left && right)) {
    return false;
  }
  return stableReviewJson(left) === stableReviewJson(right);
}

function validPlan(plan) {
  const required = [
    'version',
    'id',
    'mode',
    'repo',
    'name',
    'checkoutIdentity',
    'inputDigest',
    'head',
    'lockfileHash',
    'storeIdentity',
    'createdAt',
    'files',
    'skipped',
    'logicalCloneBytes',
    'physicalSavingsBytes',
  ];
  if (
    !exactKeys(plan, required) ||
    (plan.version !== 1 && plan.version !== 2) ||
    !validDigest(plan.id) ||
    plan.mode !== 'hoisted-cow' ||
    !validTarget(plan.repo, plan.name) ||
    !validIdentity(plan.checkoutIdentity) ||
    !validDigest(plan.inputDigest) ||
    !(
      plan.head === null ||
      (typeof plan.head === 'string' && HEAD.test(plan.head))
    ) ||
    !validDigest(plan.lockfileHash) ||
    !validStoreIdentity(plan.storeIdentity) ||
    !validTimestamp(plan.createdAt) ||
    !Array.isArray(plan.files) ||
    plan.files.length > MAX_MANIFEST_ENTRIES ||
    !Array.isArray(plan.skipped) ||
    plan.files.length + plan.skipped.length > MAX_MANIFEST_ENTRIES ||
    !Number.isSafeInteger(plan.logicalCloneBytes) ||
    plan.logicalCloneBytes < 0 ||
    plan.physicalSavingsBytes !== null
  ) {
    return false;
  }
  const paths = new Set();
  const temporaryPaths = new Set();
  let logicalBytes = 0;
  for (let index = 0; index < plan.files.length; index += 1) {
    const file = plan.files[index];
    if (
      !exactKeys(file, [
        'index',
        'relativePath',
        'objectKey',
        'fingerprint',
        'temporaryRelativePath',
      ]) ||
      file.index !== index ||
      !validRelativePath(file.relativePath) ||
      !validDigest(file.objectKey) ||
      !validFingerprint(file.fingerprint) ||
      file.objectKey !== dependencyObjectKey(file.fingerprint, plan.version) ||
      file.fingerprint.relativePath !== file.relativePath ||
      !validRelativePath(file.temporaryRelativePath) ||
      file.temporaryRelativePath === file.relativePath ||
      posix.dirname(file.temporaryRelativePath) !==
        posix.dirname(file.relativePath) ||
      paths.has(file.relativePath) ||
      temporaryPaths.has(file.temporaryRelativePath)
    ) {
      return false;
    }
    paths.add(file.relativePath);
    temporaryPaths.add(file.temporaryRelativePath);
    logicalBytes += file.fingerprint.size;
    if (!Number.isSafeInteger(logicalBytes)) {
      return false;
    }
  }
  for (const file of plan.skipped) {
    if (
      !(
        exactKeys(file, ['relativePath', 'reason']) &&
        validRelativePath(file.relativePath)
      ) ||
      typeof file.reason !== 'string' ||
      file.reason.length === 0 ||
      file.reason.length > 256 ||
      CONTROL_CHARACTER.test(file.reason) ||
      paths.has(file.relativePath) ||
      temporaryPaths.has(file.relativePath)
    ) {
      return false;
    }
    paths.add(file.relativePath);
  }
  if (
    plan.files.some((file) => paths.has(file.temporaryRelativePath)) ||
    logicalBytes !== plan.logicalCloneBytes
  ) {
    return false;
  }
  const payload = omitKeys(plan, ['id', 'createdAt']);
  return hash(stableReviewJson(payload)) === plan.id;
}

function validSummary(summary) {
  const required = [
    'version',
    'id',
    'planId',
    'mode',
    'repo',
    'name',
    'checkoutIdentity',
    'inputDigest',
    'storeIdentity',
    'state',
    'completedFiles',
    'retainedOriginalFiles',
    'totalFiles',
    'logicalCloneBytes',
    'physicalSavingsBytes',
    'createdAt',
    'updatedAt',
  ];
  return (
    exactKeys(summary, required, ['code']) &&
    summary.version === 1 &&
    validDigest(summary.id) &&
    summary.id === summary.planId &&
    summary.mode === 'hoisted-cow' &&
    validTarget(summary.repo, summary.name) &&
    validIdentity(summary.checkoutIdentity) &&
    validDigest(summary.inputDigest) &&
    validStoreIdentity(summary.storeIdentity) &&
    STATES.has(summary.state) &&
    Number.isSafeInteger(summary.completedFiles) &&
    summary.completedFiles >= 0 &&
    Number.isSafeInteger(summary.retainedOriginalFiles) &&
    summary.retainedOriginalFiles >= 0 &&
    Number.isSafeInteger(summary.totalFiles) &&
    summary.totalFiles >= 0 &&
    summary.completedFiles <= summary.totalFiles &&
    summary.retainedOriginalFiles <= summary.totalFiles &&
    (summary.state !== 'prepared' ||
      (summary.completedFiles === 0 && summary.retainedOriginalFiles === 0)) &&
    (summary.state !== 'completed' ||
      summary.completedFiles === summary.totalFiles) &&
    (summary.state !== 'released' ||
      (summary.completedFiles === summary.totalFiles &&
        summary.retainedOriginalFiles === 0)) &&
    Number.isSafeInteger(summary.logicalCloneBytes) &&
    summary.logicalCloneBytes >= 0 &&
    summary.physicalSavingsBytes === null &&
    validTimestamp(summary.createdAt) &&
    validTimestamp(summary.updatedAt) &&
    summary.updatedAt >= summary.createdAt &&
    (!Object.hasOwn(summary, 'code') ||
      (typeof summary.code === 'string' && OPERATION_CODE.test(summary.code)))
  );
}

function sameBinding(summary, plan) {
  return (
    summary.id === plan.id &&
    summary.planId === plan.id &&
    summary.mode === plan.mode &&
    summary.repo === plan.repo &&
    summary.name === plan.name &&
    canonicalJson(summary.checkoutIdentity) ===
      canonicalJson(plan.checkoutIdentity) &&
    summary.inputDigest === plan.inputDigest &&
    canonicalJson(summary.storeIdentity) ===
      canonicalJson(plan.storeIdentity) &&
    summary.totalFiles === plan.files.length &&
    summary.logicalCloneBytes === plan.logicalCloneBytes
  );
}

function planContent(plan) {
  const value = omitKeys(plan, ['id', 'createdAt']);
  return stableReviewJson(value);
}

function validOperationEnvelope(envelope, id) {
  return (
    exactKeys(envelope, [
      'version',
      'manifestDigest',
      'checkpointRevision',
      'summary',
    ]) &&
    envelope.version === 1 &&
    validDigest(envelope.manifestDigest) &&
    Number.isSafeInteger(envelope.checkpointRevision) &&
    envelope.checkpointRevision >= 0 &&
    validSummary(envelope.summary) &&
    envelope.summary.id === id
  );
}

function validCheckpointRecordHeader(record, planFile) {
  const required = [
    'version',
    'operationId',
    'index',
    'relativePath',
    'temporaryRelativePath',
    'phase',
    'originalFingerprint',
    'stagedFingerprint',
    'retainedFingerprint',
    'updatedAt',
  ];
  if (
    !exactKeys(record, required, ['releasePlanId']) ||
    record.version !== 1 ||
    !validDigest(record.operationId) ||
    record.index !== planFile.index ||
    record.relativePath !== planFile.relativePath ||
    record.temporaryRelativePath !== planFile.temporaryRelativePath ||
    !PHASE_SET.has(record.phase) ||
    !validFingerprint(record.originalFingerprint) ||
    !sameFingerprint(record.originalFingerprint, planFile.fingerprint) ||
    !(
      record.stagedFingerprint === null ||
      validFingerprint(record.stagedFingerprint)
    ) ||
    !(
      record.retainedFingerprint === null ||
      validFingerprint(record.retainedFingerprint)
    ) ||
    !validTimestamp(record.updatedAt)
  ) {
    return false;
  }
  return !(
    Object.hasOwn(record, 'releasePlanId') &&
    !(
      validDigest(record.releasePlanId) &&
      ['verified', 'released', 'unknown', 'conflict'].includes(record.phase)
    )
  );
}

function validCheckpointRecordFiles(record, planFile) {
  const stagedPhases = ['staged', 'swapped', 'verified', 'released'];
  const installedPhases = ['swapped', 'verified', 'released'];
  return (
    (!record.stagedFingerprint ||
      ([record.relativePath, record.temporaryRelativePath].includes(
        record.stagedFingerprint.relativePath
      ) &&
        sameCloneData(record.stagedFingerprint, planFile.fingerprint))) &&
    (!record.retainedFingerprint ||
      record.retainedFingerprint.relativePath ===
        record.temporaryRelativePath) &&
    (!(record.retainedFingerprint && installedPhases.includes(record.phase)) ||
      samePhysicalFile(record.retainedFingerprint, planFile.fingerprint)) &&
    (!stagedPhases.includes(record.phase) ||
      Boolean(record.stagedFingerprint)) &&
    (!installedPhases.includes(record.phase) ||
      Boolean(record.retainedFingerprint)) &&
    (record.phase !== 'prepared' ||
      !(record.stagedFingerprint || record.retainedFingerprint)) &&
    (record.phase !== 'staged' || !record.retainedFingerprint) &&
    (record.phase !== 'staged' ||
      record.stagedFingerprint?.relativePath ===
        planFile.temporaryRelativePath) &&
    (!installedPhases.includes(record.phase) ||
      record.stagedFingerprint?.relativePath === planFile.relativePath)
  );
}

function validCheckpointRecord(record, planFile) {
  return (
    validCheckpointRecordHeader(record, planFile) &&
    validCheckpointRecordFiles(record, planFile)
  );
}

function validCheckpointEnvelope(envelope, operation, planFile, index) {
  return (
    exactKeys(envelope, [
      'version',
      'operationId',
      'planId',
      'manifestDigest',
      'index',
      'revision',
      'previousPhase',
      'record',
    ]) &&
    envelope.version === 1 &&
    envelope.operationId === operation.summary.id &&
    envelope.planId === operation.summary.planId &&
    envelope.manifestDigest === operation.manifestDigest &&
    envelope.index === index &&
    Number.isSafeInteger(envelope.revision) &&
    envelope.revision > 0 &&
    (envelope.previousPhase === null ||
      PHASE_SET.has(envelope.previousPhase)) &&
    validCheckpointRecord(envelope.record, planFile) &&
    envelope.record.operationId === envelope.operationId
  );
}

function isCompletedPhase(phase) {
  return phase === 'verified' || phase === 'released';
}

function isRetainedCheckpoint(record) {
  return Boolean(record.retainedFingerprint && record.phase !== 'released');
}

function nextStateForCheckpoint(phase, currentState) {
  if (phase === 'unknown') {
    return 'unknown';
  }
  if (phase === 'conflict') {
    return 'conflict';
  }
  if (
    currentState === 'prepared' &&
    ['staged', 'swapped', 'verified'].includes(phase)
  ) {
    return 'running';
  }
  return currentState;
}

function checkpointStateCode(state) {
  if (state === 'unknown') {
    return 'DEPENDENCY_FILE_CHECKPOINT_UNKNOWN';
  }
  if (state === 'conflict') {
    return 'DEPENDENCY_FILE_CHECKPOINT_CONFLICT';
  }
  return null;
}

function validReleasePlan(plan) {
  const required = [
    'version',
    'id',
    'operationId',
    'planId',
    'mode',
    'repo',
    'name',
    'checkoutIdentity',
    'inputDigest',
    'storeIdentity',
    'manifestDigest',
    'createdAt',
    'files',
  ];
  if (
    !exactKeys(plan, required) ||
    plan.version !== 1 ||
    !validDigest(plan.id) ||
    !validDigest(plan.operationId) ||
    !validDigest(plan.planId) ||
    plan.operationId !== plan.planId ||
    plan.mode !== 'hoisted-cow' ||
    !validTarget(plan.repo, plan.name) ||
    !validIdentity(plan.checkoutIdentity) ||
    !validDigest(plan.inputDigest) ||
    !validStoreIdentity(plan.storeIdentity) ||
    !validDigest(plan.manifestDigest) ||
    !validTimestamp(plan.createdAt) ||
    !Array.isArray(plan.files)
  ) {
    return false;
  }
  const indices = new Set();
  const paths = new Set();
  const temporaryPaths = new Set();
  for (const file of plan.files) {
    if (
      !(
        exactKeys(file, [
          'index',
          'relativePath',
          'temporaryRelativePath',
          'originalFingerprint',
          'installedFingerprint',
        ]) && Number.isSafeInteger(file.index)
      ) ||
      file.index < 0 ||
      indices.has(file.index) ||
      !validRelativePath(file.relativePath) ||
      paths.has(file.relativePath) ||
      !validRelativePath(file.temporaryRelativePath) ||
      file.temporaryRelativePath === file.relativePath ||
      posix.dirname(file.temporaryRelativePath) !==
        posix.dirname(file.relativePath) ||
      temporaryPaths.has(file.temporaryRelativePath) ||
      !validFingerprint(file.originalFingerprint) ||
      !validFingerprint(file.installedFingerprint) ||
      file.originalFingerprint.relativePath !== file.temporaryRelativePath ||
      file.installedFingerprint.relativePath !== file.relativePath
    ) {
      return false;
    }
    indices.add(file.index);
    paths.add(file.relativePath);
    temporaryPaths.add(file.temporaryRelativePath);
  }
  if ([...temporaryPaths].some((path) => paths.has(path))) {
    return false;
  }
  const payload = omitKeys(plan, ['id', 'createdAt']);
  return hash(stableReviewJson(payload)) === plan.id;
}

function releaseContent(plan) {
  const value = omitKeys(plan, ['id', 'createdAt']);
  return stableReviewJson(value);
}

function sameReleaseBinding(summary, plan) {
  return (
    summary.id === plan.operationId &&
    summary.planId === plan.planId &&
    summary.mode === plan.mode &&
    summary.repo === plan.repo &&
    summary.name === plan.name &&
    canonicalJson(summary.checkoutIdentity) ===
      canonicalJson(plan.checkoutIdentity) &&
    summary.inputDigest === plan.inputDigest &&
    canonicalJson(summary.storeIdentity) === canonicalJson(plan.storeIdentity)
  );
}

function releaseFilesMatch(checkpoints, releasePlan) {
  const eligible = checkpoints
    .filter(
      (row) =>
        row.retainedFingerprint &&
        row.stagedFingerprint &&
        ['verified', 'released', 'unknown', 'conflict'].includes(row.phase)
    )
    .sort((left, right) => left.index - right.index);
  return (
    eligible.length === releasePlan.files.length &&
    eligible.every((checkpoint, position) => {
      const file = releasePlan.files[position];
      return (
        file.index === checkpoint.index &&
        file.relativePath === checkpoint.relativePath &&
        file.temporaryRelativePath === checkpoint.temporaryRelativePath &&
        sameFingerprintExceptAtime(
          file.originalFingerprint,
          checkpoint.retainedFingerprint
        ) &&
        sameFingerprintExceptAtime(
          file.installedFingerprint,
          checkpoint.stagedFingerprint
        )
      );
    })
  );
}

export function createDependencyFileJournal({
  state,
  storeRoot,
  now = Date.now,
  randomId = randomUUID,
} = {}) {
  // Stable public ids are content digests; randomId remains a compatible input.
  const validatedPlans = new Map();
  const pendingPlanLoads = new Map();
  let validatedPlansBytes = 0;

  function forgetCachedPlan(id) {
    const existing = validatedPlans.get(id);
    if (existing) {
      validatedPlansBytes -= existing.bytes;
      validatedPlans.delete(id);
    }
  }

  function cachePlan(id, plan, identity) {
    const serialized = canonicalJson(plan);
    const bytes = Buffer.byteLength(serialized);
    forgetCachedPlan(id);
    if (bytes > PLAN_CACHE_BYTES_LIMIT) {
      return null;
    }
    const entry = {
      bytes,
      digest: hash(serialized),
      identity,
      plan,
    };
    validatedPlans.set(id, entry);
    validatedPlansBytes += bytes;
    while (validatedPlansBytes > PLAN_CACHE_BYTES_LIMIT) {
      forgetCachedPlan(validatedPlans.keys().next().value);
    }
    return entry;
  }

  function cachedPlanDigest(id, plan) {
    const entry = validatedPlans.get(id);
    if (entry?.plan === plan) {
      validatedPlans.delete(id);
      validatedPlans.set(id, entry);
      return entry.digest;
    }
    return hash(canonicalJson(plan));
  }

  function validateDependencies() {
    if (
      !(
        state &&
        typeof state.read === 'function' &&
        typeof state.update === 'function' &&
        typeof state.withTargets === 'function' &&
        typeof state.replaceText === 'function'
      ) ||
      typeof randomId !== 'function' ||
      typeof storeRoot !== 'string' ||
      !isAbsolute(storeRoot)
    ) {
      fail('DEPENDENCY_FILE_JOURNAL_INVALID', 'configuration');
    }
  }

  function currentTime() {
    let value;
    try {
      value = now();
    } catch {
      fail('DEPENDENCY_FILE_JOURNAL_INVALID', 'clock');
    }
    if (!validTimestamp(value)) {
      fail('DEPENDENCY_FILE_JOURNAL_INVALID', 'clock');
    }
    return value;
  }

  async function checkStoreRoot() {
    validateDependencies();
    if (typeof process.getuid !== 'function') {
      fail('DEPENDENCY_FILE_JOURNAL_STORE_REFUSED', 'owner');
    }
    let info, canonical;
    try {
      info = await fs.lstat(storeRoot);
      canonical = await fs.realpath(storeRoot);
    } catch (cause) {
      fail('DEPENDENCY_FILE_JOURNAL_STORE_REFUSED', 'root', {
        causeCode: cause.code,
      });
    }
    if (
      info.isSymbolicLink() ||
      !info.isDirectory() ||
      info.uid !== process.getuid() ||
      Number(info.mode) % 4096 !== DIRECTORY_MODE ||
      canonical !== storeRoot
    ) {
      fail('DEPENDENCY_FILE_JOURNAL_STORE_REFUSED', 'root');
    }
    return canonical;
  }

  function assertStoreBinding(value, phase, operationId) {
    if (!validStoreIdentity(value) || value.root !== storeRoot) {
      fail('DEPENDENCY_FILE_JOURNAL_STORE_REFUSED', phase, { operationId });
    }
  }

  async function checkPrivateDirectory(path) {
    let info, canonical;
    try {
      info = await fs.lstat(path);
      canonical = await fs.realpath(path);
    } catch (cause) {
      if (cause.code === 'ENOENT') {
        return false;
      }
      fail('DEPENDENCY_FILE_JOURNAL_IO', 'directory-read', {
        causeCode: cause.code,
      });
    }
    if (
      info.isSymbolicLink() ||
      !info.isDirectory() ||
      info.uid !== process.getuid() ||
      Number(info.mode) % 4096 !== DIRECTORY_MODE ||
      canonical !== path
    ) {
      fail('DEPENDENCY_FILE_JOURNAL_STORE_REFUSED', 'directory');
    }
    return true;
  }

  async function ensureDirectoryPart(parent, part, create) {
    if (typeof part !== 'string' || !DIRECTORY_NAME.test(part)) {
      fail('DEPENDENCY_FILE_JOURNAL_INVALID', 'directory-name');
    }
    const path = join(parent, part);
    let exists = await checkPrivateDirectory(path);
    if (!exists && create) {
      try {
        await fs.mkdir(path, { mode: DIRECTORY_MODE });
      } catch (cause) {
        if (cause.code !== 'EEXIST') {
          fail('DEPENDENCY_FILE_JOURNAL_IO', 'directory-create', {
            causeCode: cause.code,
          });
        }
      }
      exists = await checkPrivateDirectory(path);
      if (!exists) {
        fail('DEPENDENCY_FILE_JOURNAL_STORE_REFUSED', 'directory-create');
      }
    }
    return exists ? path : null;
  }

  async function directory(parts, { create = false } = {}) {
    let current = await checkStoreRoot();
    // Validate each parent before descending so no later segment can escape.
    for (const part of parts) {
      // biome-ignore lint/performance/noAwaitInLoops: validate each ancestor before descending.
      current = await ensureDirectoryPart(current, part, create);
      if (!current) {
        return null;
      }
    }
    return current;
  }

  async function readStableRecordText(path, maxBytes) {
    let before,
      handle,
      entryObserved = false;
    try {
      before = await fs.lstat(path, { bigint: true });
      entryObserved = true;
      await verifyRecordPath(path, before);
      if (before.size > BigInt(maxBytes)) {
        fail('DEPENDENCY_FILE_JOURNAL_CORRUPT', 'record-size');
      }
      handle = await fs.open(path, fsConstants.O_NOFOLLOW);
      const opened = await handle.stat({ bigint: true });
      if (recordIdentity(opened) !== recordIdentity(before)) {
        fail('DEPENDENCY_FILE_JOURNAL_STORE_REFUSED', 'record-changed');
      }
      const text = await readBoundedRecordText(handle, maxBytes);
      const after = await handle.stat({ bigint: true });
      const pathAfter = await fs.lstat(path, { bigint: true });
      await verifyRecordAfterRead(path, before, after, pathAfter);
      await handle.close();
      return { identity: recordIdentity(before), text };
    } catch (cause) {
      if (handle) {
        // Preserve the original read failure if closing its descriptor also fails.
        await handle.close().catch(() => undefined);
      }
      if (cause.code === 'ENOENT' && !entryObserved) {
        return null;
      }
      if (cause.code === 'ENOENT') {
        fail('DEPENDENCY_FILE_JOURNAL_OUTCOME_UNKNOWN', 'record-changed');
      }
      if (cause.code?.startsWith('DEPENDENCY_FILE_JOURNAL_')) {
        throw cause;
      }
      fail('DEPENDENCY_FILE_JOURNAL_IO', 'record-read', {
        causeCode: cause.code,
      });
    }
  }

  async function readRecord(
    parts,
    name,
    validate,
    { missing = null, maxBytes = MAX_RECORD_BYTES } = {}
  ) {
    if (!RECORD_NAME_PATTERN.test(name)) {
      fail('DEPENDENCY_FILE_JOURNAL_INVALID', 'record-name');
    }
    const parent = await directory(parts);
    if (!parent) {
      return missing;
    }
    const result = await readStableRecordText(join(parent, name), maxBytes);
    if (!result) {
      return missing;
    }
    const { identity, text } = result;
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      fail('DEPENDENCY_FILE_JOURNAL_CORRUPT', 'record-parse');
    }
    if (!validate(parsed)) {
      fail('DEPENDENCY_FILE_JOURNAL_CORRUPT', 'record-validate');
    }
    return { identity, parsed, text };
  }

  async function commitRecordText(
    parts,
    name,
    path,
    encoded,
    value,
    expectedText,
    validate,
    maxBytes
  ) {
    let result;
    try {
      result = await state.replaceText(path, encoded, { mode: RECORD_MODE });
    } catch (cause) {
      const operationId = value.operationId ?? value.summary?.id ?? value.id;
      if (cause.committed === false) {
        fail('DEPENDENCY_FILE_JOURNAL_WRITE_FAILED', 'record-write', {
          causeCode: cause.causeCode ?? cause.code,
          operationId,
        });
      }
      const reconciled = await reconcileUnknownWrite(
        parts,
        name,
        encoded,
        expectedText,
        validate,
        maxBytes
      );
      fail(
        'DEPENDENCY_FILE_JOURNAL_OUTCOME_UNKNOWN',
        reconciled ? 'record-write-reconciled' : 'record-write',
        {
          causeCode: cause.causeCode ?? cause.code,
          operationId,
        }
      );
    }
    if (
      result.committed !== true ||
      result.reconciled !== true ||
      result.warning !== undefined ||
      result.status !== 'committed'
    ) {
      const reconciled = await reconcileUnknownWrite(
        parts,
        name,
        encoded,
        expectedText,
        validate,
        maxBytes
      );
      fail(
        'DEPENDENCY_FILE_JOURNAL_OUTCOME_UNKNOWN',
        reconciled ? 'record-durability-reconciled' : 'record-durability',
        { operationId: value.operationId ?? value.summary?.id ?? value.id }
      );
    }
  }

  async function writeRecord(
    parts,
    name,
    value,
    {
      expectedText,
      validate = validateAnyRecord,
      maxBytes = MAX_RECORD_BYTES,
    } = {}
  ) {
    const parent = await directory(parts, { create: true });
    if (!parent) {
      fail('DEPENDENCY_FILE_JOURNAL_STORE_REFUSED', 'record-parent');
    }
    const path = join(parent, name);
    const encoded = encodeRecord(value, maxBytes);
    const existing = await readRecord(parts, name, validate, { maxBytes });
    if (
      expectedText !== undefined &&
      (existing?.text ?? null) !== expectedText
    ) {
      fail('DEPENDENCY_FILE_JOURNAL_CONFLICT', 'record-precondition', {
        operationId: value.operationId ?? value.summary?.id ?? value.id,
      });
    }
    await commitRecordText(
      parts,
      name,
      path,
      encoded,
      value,
      expectedText,
      validate,
      maxBytes
    );
    const committed = await readRecord(parts, name, validate, { maxBytes });
    if (committed?.text !== encoded) {
      fail('DEPENDENCY_FILE_JOURNAL_OUTCOME_UNKNOWN', 'record-readback', {
        operationId: value.operationId ?? value.summary?.id ?? value.id,
      });
    }
    return cloneJson(committed.parsed);
  }

  function validateAnyRecord(value) {
    return isObject(value) && validManifestJson(value);
  }

  async function reconcileUnknownWrite(
    parts,
    name,
    expectedText,
    previousText,
    validate = validateAnyRecord,
    maxBytes = MAX_RECORD_BYTES
  ) {
    try {
      const current = await readRecord(parts, name, validate, { maxBytes });
      return (
        current?.text === expectedText ||
        (current?.text ?? null) === previousText
      );
    } catch {
      // The uncertainty remains attached to the operation; never overwrite a
      // state that could not be read back safely.
      return false;
    }
  }

  function privateRecordMetadataValid(info) {
    return (
      !info.isSymbolicLink() &&
      info.isFile() &&
      info.uid === BigInt(process.getuid()) &&
      Number(info.mode) % 4096 === RECORD_MODE &&
      info.nlink === 1n
    );
  }

  async function verifyRecordPath(path, info, expectedIdentity) {
    if (!privateRecordMetadataValid(info)) {
      fail('DEPENDENCY_FILE_JOURNAL_STORE_REFUSED', 'record-metadata');
    }
    if (expectedIdentity && recordIdentity(info) !== expectedIdentity) {
      fail('DEPENDENCY_FILE_JOURNAL_STORE_REFUSED', 'record-changed');
    }
    if ((await fs.realpath(path)) !== path) {
      fail('DEPENDENCY_FILE_JOURNAL_STORE_REFUSED', 'record-path');
    }
  }

  async function verifyRecordAfterRead(path, before, after, pathAfter) {
    const identity = recordIdentity(before);
    await verifyRecordPath(path, after, identity);
    await verifyRecordPath(path, pathAfter, identity);
  }

  function matchesCachedPlanIdentity(info, identity) {
    return (
      recordIdentity(info) === identity &&
      !info.isSymbolicLink() &&
      info.isFile() &&
      info.uid === BigInt(process.getuid()) &&
      info.nlink === 1n &&
      Number(info.mode) % 4096 === RECORD_MODE
    );
  }

  async function planFileInfo(path) {
    let info;
    try {
      info = await fs.lstat(path, { bigint: true });
    } catch (cause) {
      if (cause.code === 'ENOENT') {
        return null;
      }
      fail('DEPENDENCY_FILE_JOURNAL_IO', 'record-read', {
        causeCode: cause.code,
      });
    }
    if (!privateRecordMetadataValid(info)) {
      fail('DEPENDENCY_FILE_JOURNAL_STORE_REFUSED', 'record-metadata');
    }
    if (info.size > BigInt(MAX_MANIFEST_BYTES)) {
      fail('DEPENDENCY_FILE_JOURNAL_CORRUPT', 'record-size');
    }
    return info;
  }

  async function verifyCachedPlanFile(path, identity) {
    let handle;
    try {
      handle = await fs.open(path, fsConstants.O_NOFOLLOW);
      const confirmed = await handle.stat({ bigint: true });
      const pathInfo = await fs.lstat(path, { bigint: true });
      if (
        !(
          matchesCachedPlanIdentity(confirmed, identity) &&
          matchesCachedPlanIdentity(pathInfo, identity)
        ) ||
        (await fs.realpath(path)) !== path
      ) {
        fail('DEPENDENCY_FILE_JOURNAL_STORE_REFUSED', 'record-changed');
      }
    } catch (cause) {
      if (cause.code?.startsWith('DEPENDENCY_FILE_JOURNAL_')) {
        throw cause;
      }
      fail('DEPENDENCY_FILE_JOURNAL_IO', 'record-read', {
        causeCode: cause.code,
      });
    } finally {
      await handle?.close().catch(() => undefined);
    }
  }

  async function loadPlan(id) {
    if (!validDigest(id)) {
      fail('DEPENDENCY_FILE_JOURNAL_INVALID', 'plan-id');
    }
    const pending = pendingPlanLoads.get(id);
    if (pending) {
      await pending;
      return loadPlan(id);
    }
    const loading = loadPlanFromDisk(id);
    pendingPlanLoads.set(id, loading);
    try {
      return await loading;
    } finally {
      if (pendingPlanLoads.get(id) === loading) {
        pendingPlanLoads.delete(id);
      }
    }
  }

  async function loadPlanFromDisk(id) {
    const parts = [JOURNAL_DIRECTORY, 'plans'];
    const parent = await directory(parts);
    if (!parent) {
      return null;
    }
    const path = join(parent, `${id}.json`);
    const info = await planFileInfo(path);
    if (!info) {
      return null;
    }
    const identity = recordIdentity(info);
    const cached = validatedPlans.get(id);
    if (cached && cached.identity !== identity) {
      fail('DEPENDENCY_FILE_JOURNAL_CORRUPT', 'plan-identity-changed');
    }
    if (cached && cached.identity === identity) {
      await verifyCachedPlanFile(path, identity);
      validatedPlans.delete(id);
      validatedPlans.set(id, cached);
      assertStoreBinding(cached.plan.storeIdentity, 'plan-store-binding', id);
      return cached.plan;
    }
    const record = await readRecord(parts, `${id}.json`, validPlan, {
      maxBytes: MAX_MANIFEST_BYTES,
    });
    if (!record) {
      return null;
    }
    assertStoreBinding(record.parsed.storeIdentity, 'plan-store-binding', id);
    await verifyCachedPlanFile(path, record.identity);
    const plan = freezeJson(record.parsed);
    cachePlan(id, plan, record.identity);
    return plan;
  }

  async function savePlanUnlocked(plan) {
    assertStoreBinding(plan.storeIdentity, 'plan-store-binding', plan.id);
    const pathParts = [JOURNAL_DIRECTORY, 'plans'];
    const existing = await readRecord(pathParts, `${plan.id}.json`, validPlan, {
      maxBytes: MAX_MANIFEST_BYTES,
    });
    if (existing) {
      if (planContent(existing.parsed) !== planContent(plan)) {
        fail('DEPENDENCY_FILE_JOURNAL_CONFLICT', 'plan-id-reused', {
          operationId: plan.id,
        });
      }
      return cloneJson(existing.parsed);
    }
    const saved = await writeRecord(pathParts, `${plan.id}.json`, plan, {
      maxBytes: MAX_MANIFEST_BYTES,
      validate: validPlan,
    });
    if (planContent(saved) !== planContent(plan)) {
      fail('DEPENDENCY_FILE_JOURNAL_OUTCOME_UNKNOWN', 'plan-readback', {
        operationId: plan.id,
      });
    }
    return saved;
  }

  async function readOperationEnvelope(id, { requirePlan = true } = {}) {
    if (!validDigest(id)) {
      fail('DEPENDENCY_FILE_JOURNAL_INVALID', 'operation-id');
    }
    const record = await readRecord(
      [JOURNAL_DIRECTORY, 'operations'],
      `${id}.json`,
      (value) => validOperationEnvelope(value, id)
    );
    if (!record) {
      return null;
    }
    const envelope = record.parsed;
    if (requirePlan) {
      const plan = await loadPlan(envelope.summary.planId);
      if (
        !plan ||
        cachedPlanDigest(envelope.summary.planId, plan) !==
          envelope.manifestDigest ||
        !sameBinding(envelope.summary, plan)
      ) {
        fail('DEPENDENCY_FILE_JOURNAL_CORRUPT', 'operation-manifest-binding', {
          operationId: id,
        });
      }
    }
    const copy = cloneJson(envelope);
    return { ...copy, envelope: copy, text: record.text };
  }

  function writeOperationEnvelope(envelope, expectedText) {
    return writeRecord(
      [JOURNAL_DIRECTORY, 'operations'],
      `${envelope.summary.id}.json`,
      envelope,
      { expectedText }
    );
  }

  async function updateWorkspaceSummary(summary) {
    let result;
    try {
      result = await state.update('dependencyFiles', (current) => ({
        ...current,
        operations: {
          ...current.operations,
          [summary.id]: cloneJson(summary),
        },
      }));
    } catch (cause) {
      if (cause.committed === false) {
        fail('DEPENDENCY_FILE_JOURNAL_WRITE_FAILED', 'workspace-summary', {
          causeCode: cause.causeCode ?? cause.code,
          operationId: summary.id,
        });
      }
      fail('DEPENDENCY_FILE_JOURNAL_OUTCOME_UNKNOWN', 'workspace-summary', {
        causeCode: cause.causeCode ?? cause.code,
        operationId: summary.id,
      });
    }
    if (
      result.committed !== true ||
      result.reconciled !== true ||
      result.warning !== undefined ||
      result.status !== 'committed' ||
      canonicalJson(result.value?.operations?.[summary.id]) !==
        canonicalJson(summary)
    ) {
      fail('DEPENDENCY_FILE_JOURNAL_OUTCOME_UNKNOWN', 'workspace-summary', {
        operationId: summary.id,
      });
    }
    return cloneJson(summary);
  }

  async function updateOperation(summary, envelope, expectedText) {
    const nextEnvelope = {
      ...envelope,
      summary: cloneJson(summary),
    };
    const saved = await writeOperationEnvelope(nextEnvelope, expectedText);
    try {
      await updateWorkspaceSummary(saved.summary);
    } catch (cause) {
      fail('DEPENDENCY_FILE_JOURNAL_OUTCOME_UNKNOWN', 'operation-summary', {
        causeCode: cause.causeCode ?? cause.code,
        operationId: saved.summary.id,
      });
    }
    return saved;
  }

  async function loadCheckpoint(operation, plan, index) {
    const planFile = plan.files[index];
    if (!planFile) {
      fail('DEPENDENCY_FILE_JOURNAL_INVALID', 'checkpoint-index', {
        operationId: operation.summary.id,
      });
    }
    const record = await readRecord(
      [JOURNAL_DIRECTORY, 'checkpoints', operation.summary.id],
      `${index}.json`,
      (value) => validCheckpointEnvelope(value, operation, planFile, index)
    );
    return record ? { envelope: record.parsed, text: record.text } : null;
  }

  async function scanCheckpoints(operation, plan) {
    const directoryPath = await directory([
      JOURNAL_DIRECTORY,
      'checkpoints',
      operation.summary.id,
    ]);
    if (!directoryPath) {
      return [];
    }
    let names;
    try {
      names = await fs.readdir(directoryPath);
    } catch (cause) {
      fail('DEPENDENCY_FILE_JOURNAL_IO', 'checkpoint-list', {
        causeCode: cause.code,
        operationId: operation.summary.id,
      });
    }
    const indices = names.map((name) => {
      const match = CHECKPOINT_NAME.exec(name);
      if (!match) {
        fail('DEPENDENCY_FILE_JOURNAL_CORRUPT', 'checkpoint-name', {
          operationId: operation.summary.id,
        });
      }
      const index = Number(match[1]);
      if (!Number.isSafeInteger(index) || index >= plan.files.length) {
        fail('DEPENDENCY_FILE_JOURNAL_CORRUPT', 'checkpoint-index', {
          operationId: operation.summary.id,
        });
      }
      return index;
    });
    if (new Set(indices).size !== indices.length) {
      fail('DEPENDENCY_FILE_JOURNAL_CORRUPT', 'checkpoint-duplicate', {
        operationId: operation.summary.id,
      });
    }
    indices.sort((left, right) => left - right);
    const checkpoints = [];
    // Bound open descriptors while validating every checkpoint before returning.
    for (const index of indices) {
      // biome-ignore lint/performance/noAwaitInLoops: checkpoint reads are deliberately serial.
      const checkpoint = await loadCheckpoint(operation, plan, index);
      if (!checkpoint) {
        fail('DEPENDENCY_FILE_JOURNAL_CORRUPT', 'checkpoint-missing', {
          operationId: operation.summary.id,
        });
      }
      checkpoints.push(cloneJson(checkpoint.envelope.record));
    }
    return checkpoints;
  }

  async function stateDocument() {
    await checkStoreRoot();
    let value;
    try {
      value = state.read('dependencyFiles');
    } catch (cause) {
      if (cause.committed === false) {
        fail('DEPENDENCY_FILE_JOURNAL_CORRUPT', 'workspace-state-read', {
          causeCode: cause.causeCode ?? cause.code,
        });
      }
      throw cause;
    }
    if (
      !isObject(value) ||
      value.version !== 1 ||
      !isObject(value.operations) ||
      !isObject(value.views)
    ) {
      fail('DEPENDENCY_FILE_JOURNAL_CORRUPT', 'workspace-state-shape');
    }
    for (const summary of [
      ...Object.values(value.operations),
      ...Object.values(value.views),
    ]) {
      assertStoreBinding(
        summary?.storeIdentity,
        'workspace-summary-store-binding',
        summary?.id
      );
    }
    return value;
  }

  async function ensureSummaryMatches(summary) {
    const document = await stateDocument();
    const current = document.operations[summary.id];
    if (canonicalJson(current ?? null) !== canonicalJson(summary)) {
      if (
        (current?.state === 'unknown' && summary.state !== 'unknown') ||
        ((summary.state === 'completed' || summary.state === 'released') &&
          current?.state !== summary.state)
      ) {
        fail(
          'DEPENDENCY_FILE_JOURNAL_OUTCOME_UNKNOWN',
          'summary-reconciliation',
          {
            operationId: summary.id,
          }
        );
      }
      await updateWorkspaceSummary(summary);
    }
  }

  async function assertSummaryMatches(summary, phase) {
    const document = await stateDocument();
    if (
      canonicalJson(document.operations[summary.id] ?? null) !==
      canonicalJson(summary)
    ) {
      fail('DEPENDENCY_FILE_JOURNAL_OUTCOME_UNKNOWN', phase, {
        operationId: summary.id,
      });
    }
  }

  function withTarget(target, work) {
    if (!validTarget(target?.repo, target?.name)) {
      fail('DEPENDENCY_FILE_JOURNAL_INVALID', 'target');
    }
    return state.withTargets([{ name: target.name, repo: target.repo }], work);
  }

  function initialSummary(plan, timestamp) {
    return {
      checkoutIdentity: cloneJson(plan.checkoutIdentity),
      completedFiles: 0,
      createdAt: timestamp,
      id: plan.id,
      inputDigest: plan.inputDigest,
      logicalCloneBytes: plan.logicalCloneBytes,
      mode: plan.mode,
      name: plan.name,
      physicalSavingsBytes: null,
      planId: plan.id,
      repo: plan.repo,
      retainedOriginalFiles: 0,
      state: 'prepared',
      storeIdentity: cloneJson(plan.storeIdentity),
      totalFiles: plan.files.length,
      updatedAt: timestamp,
      version: 1,
    };
  }

  function monotonicUpdate(summary, changes) {
    const updatedAt = Math.max(currentTime(), summary.updatedAt);
    return { ...summary, ...changes, updatedAt };
  }

  function validateCheckpointInput(plan, index, previous, input) {
    const planFile = plan.files[index];
    if (!(planFile && isObject(input))) {
      fail('DEPENDENCY_FILE_JOURNAL_INVALID', 'checkpoint-record', {
        operationId: plan.id,
      });
    }
    const allowed = [
      'phase',
      'index',
      'relativePath',
      'temporaryRelativePath',
      'originalFingerprint',
      'stagedFingerprint',
      'retainedFingerprint',
      'releasePlanId',
      'updatedAt',
    ];
    const old = previous?.envelope?.record ?? null;
    const { phase } = input;
    if (Object.keys(input).some((key) => !allowed.includes(key))) {
      fail('DEPENDENCY_FILE_JOURNAL_INVALID', 'checkpoint-fields', {
        operationId: plan.id,
      });
    }
    if (input.index !== undefined && input.index !== index) {
      fail('DEPENDENCY_FILE_JOURNAL_CONFLICT', 'checkpoint-index', {
        operationId: plan.id,
      });
    }
    if (!PHASE_SET.has(phase)) {
      fail('DEPENDENCY_FILE_JOURNAL_INVALID', 'checkpoint-phase', {
        operationId: plan.id,
      });
    }
    if (
      (input.relativePath !== undefined &&
        input.relativePath !== planFile.relativePath) ||
      (input.temporaryRelativePath !== undefined &&
        input.temporaryRelativePath !== planFile.temporaryRelativePath)
    ) {
      fail('DEPENDENCY_FILE_JOURNAL_CONFLICT', 'checkpoint-path', {
        operationId: plan.id,
      });
    }
    if (
      old &&
      !['unknown', 'conflict'].includes(old.phase) &&
      !['unknown', 'conflict'].includes(phase) &&
      (PHASES.indexOf(phase) < PHASES.indexOf(old.phase) ||
        PHASES.indexOf(phase) > PHASES.indexOf(old.phase) + 1)
    ) {
      fail('DEPENDENCY_FILE_JOURNAL_CONFLICT', 'checkpoint-regression', {
        operationId: plan.id,
      });
    }
    return { old, phase, planFile };
  }

  function checkpointFingerprintField(
    key,
    initial,
    { input, old, plan, operationId }
  ) {
    const value = input[key];
    if (value === undefined) {
      return old ? cloneJson(old[key]) : initial;
    }
    if (value === null) {
      if (old?.[key]) {
        fail('DEPENDENCY_FILE_JOURNAL_CONFLICT', 'checkpoint-data-drop', {
          operationId,
        });
      }
      return null;
    }
    if (!validFingerprint(value)) {
      fail('DEPENDENCY_FILE_JOURNAL_INVALID', 'checkpoint-fingerprint', {
        operationId,
      });
    }
    const reobservedPath =
      key === 'stagedFingerprint'
        ? [plan.relativePath, plan.temporaryRelativePath].includes(
            value.relativePath
          )
        : value.relativePath === plan.temporaryRelativePath;
    const mayReobserve =
      old?.[key] &&
      ['stagedFingerprint', 'retainedFingerprint'].includes(key) &&
      samePhysicalFile(old?.[key], value) &&
      reobservedPath;
    if (old?.[key] && !sameFingerprint(old[key], value) && !mayReobserve) {
      fail(
        'DEPENDENCY_FILE_JOURNAL_CONFLICT',
        'checkpoint-fingerprint-change',
        { operationId }
      );
    }
    return cloneJson(value);
  }

  function validateCheckpointTransition(old, phase, record, planFile, planId) {
    if (
      old &&
      old.phase === 'released' &&
      !['released', 'conflict', 'unknown'].includes(phase)
    ) {
      fail('DEPENDENCY_FILE_JOURNAL_CONFLICT', 'checkpoint-regression', {
        operationId: planId,
      });
    }
    if (
      old &&
      !['unknown', 'conflict'].includes(old.phase) &&
      !['unknown', 'conflict'].includes(phase)
    ) {
      const oldRank = PHASES.indexOf(old.phase);
      const nextRank = PHASES.indexOf(phase);
      if (nextRank !== oldRank && nextRank !== oldRank + 1) {
        fail('DEPENDENCY_FILE_JOURNAL_CONFLICT', 'checkpoint-regression', {
          operationId: planId,
        });
      }
    } else if (!(old || ['prepared', 'unknown', 'conflict'].includes(phase))) {
      fail('DEPENDENCY_FILE_JOURNAL_CONFLICT', 'checkpoint-initial-phase', {
        operationId: planId,
      });
    }
    if (
      ['swapped', 'verified', 'released'].includes(phase) &&
      record.retainedFingerprint &&
      record.retainedFingerprint.relativePath !== planFile.temporaryRelativePath
    ) {
      fail('DEPENDENCY_FILE_JOURNAL_CONFLICT', 'checkpoint-retained-path', {
        operationId: planId,
      });
    }
    if (
      old?.originalFingerprint &&
      !sameFingerprint(old.originalFingerprint, record.originalFingerprint)
    ) {
      fail('DEPENDENCY_FILE_JOURNAL_CONFLICT', 'checkpoint-original-change', {
        operationId: planId,
      });
    }
  }

  function normalizedCheckpoint(plan, index, previous, input) {
    const { old, phase, planFile } = validateCheckpointInput(
      plan,
      index,
      previous,
      input
    );
    const context = {
      input,
      old,
      operationId: plan.id,
      plan: planFile,
    };
    const releasePlanFields = {};
    if (input.releasePlanId !== undefined) {
      releasePlanFields.releasePlanId = input.releasePlanId;
    } else if (old?.releasePlanId) {
      releasePlanFields.releasePlanId = old.releasePlanId;
    }
    const record = {
      index,
      operationId: plan.id,
      originalFingerprint: checkpointFingerprintField(
        'originalFingerprint',
        cloneJson(planFile.fingerprint),
        context
      ),
      phase,
      relativePath: planFile.relativePath,
      retainedFingerprint: checkpointFingerprintField(
        'retainedFingerprint',
        null,
        context
      ),
      stagedFingerprint: checkpointFingerprintField(
        'stagedFingerprint',
        null,
        context
      ),
      temporaryRelativePath: planFile.temporaryRelativePath,
      updatedAt: currentTime(),
      version: 1,
      ...releasePlanFields,
    };
    if (
      Object.hasOwn(input, 'releasePlanId') &&
      (!validDigest(input.releasePlanId) ||
        (old?.releasePlanId && old.releasePlanId !== input.releasePlanId))
    ) {
      fail('DEPENDENCY_FILE_JOURNAL_CONFLICT', 'checkpoint-release-binding', {
        operationId: plan.id,
      });
    }
    if (!validCheckpointRecord(record, planFile)) {
      fail('DEPENDENCY_FILE_JOURNAL_INVALID', 'checkpoint-shape', {
        operationId: plan.id,
      });
    }
    validateCheckpointTransition(old, phase, record, planFile, plan.id);
    return record;
  }

  async function synchronizeOperation(operation, plan) {
    const checkpoints = await scanCheckpoints(operation, plan);
    const completedFiles = checkpoints.filter((row) =>
      isCompletedPhase(row.phase)
    ).length;
    const retainedOriginalFiles =
      checkpoints.filter(isRetainedCheckpoint).length;
    const summary = {
      ...operation.summary,
      completedFiles,
      retainedOriginalFiles,
    };
    return { checkpoints, summary };
  }

  async function bestEffortUnknown(operationId) {
    try {
      const loaded = await readOperationEnvelope(operationId);
      if (!loaded) {
        return;
      }
      const unknown = monotonicUpdate(loaded.envelope.summary, {
        code: 'JOURNAL_OUTCOME_UNCONFIRMED',
        state: 'unknown',
      });
      const next = { ...loaded.envelope, summary: unknown };
      const saved = await writeOperationEnvelope(next, loaded.text);
      await updateWorkspaceSummary(saved.summary);
    } catch {
      // Preserve the original operation and let its owner reconcile by identity.
    }
  }

  function validateFinishPatchFields(operation, patch) {
    if (!isObject(patch)) {
      fail('DEPENDENCY_FILE_JOURNAL_INVALID', 'finish-patch', {
        operationId: operation.summary.id,
      });
    }
    const allowedFields = new Set([
      'state',
      'code',
      'operationId',
      'mode',
      'completedFiles',
      'retainedOriginalFiles',
      'totalFiles',
      'logicalCloneBytes',
      'physicalSavingsBytes',
      'updatedAt',
    ]);
    if (
      Object.keys(patch).some((key) => !allowedFields.has(key)) ||
      !STATES.has(patch.state)
    ) {
      fail('DEPENDENCY_FILE_JOURNAL_INVALID', 'finish-fields', {
        operationId: operation.summary.id,
      });
    }
  }

  function validateFinishProgress(
    operation,
    plan,
    patch,
    synchronizedSummary,
    checkpoints
  ) {
    const operationId = operation.summary.id;
    const expectedProgress = {
      completedFiles: synchronizedSummary.completedFiles,
      logicalCloneBytes: plan.logicalCloneBytes,
      mode: plan.mode,
      operationId,
      physicalSavingsBytes: null,
      retainedOriginalFiles: synchronizedSummary.retainedOriginalFiles,
      totalFiles: plan.files.length,
    };
    for (const [key, expected] of Object.entries(expectedProgress)) {
      if (Object.hasOwn(patch, key) && patch[key] !== expected) {
        fail('DEPENDENCY_FILE_JOURNAL_CONFLICT', 'finish-progress-mismatch', {
          operationId,
        });
      }
    }
    if (
      Object.hasOwn(patch, 'updatedAt') &&
      (!validTimestamp(patch.updatedAt) ||
        patch.updatedAt < operation.summary.updatedAt)
    ) {
      fail('DEPENDENCY_FILE_JOURNAL_INVALID', 'finish-timestamp', {
        operationId,
      });
    }
    if (
      Object.hasOwn(patch, 'code') &&
      !(typeof patch.code === 'string' && OPERATION_CODE.test(patch.code))
    ) {
      fail('DEPENDENCY_FILE_JOURNAL_INVALID', 'finish-code', { operationId });
    }
    if (
      patch.state === 'completed' &&
      synchronizedSummary.completedFiles !== plan.files.length
    ) {
      fail('DEPENDENCY_FILE_JOURNAL_CONFLICT', 'finish-incomplete', {
        operationId,
      });
    }
    if (
      patch.state === 'released' &&
      checkpoints.filter((row) => row.phase === 'released').length !==
        plan.files.length
    ) {
      fail('DEPENDENCY_FILE_JOURNAL_CONFLICT', 'finish-unreleased', {
        operationId,
      });
    }
  }

  function validateFinishTransition(operation, patch, checkpoints) {
    const current = operation.envelope.summary;
    const operationId = operation.summary.id;
    if (current.state === 'released' && patch.state !== 'released') {
      fail('DEPENDENCY_FILE_JOURNAL_CONFLICT', 'finish-terminal', {
        operationId,
      });
    }
    const hasReleaseIntent = checkpoints.some((row) => row.releasePlanId);
    const allowedTransitions = {
      completed: new Set([
        'completed',
        'unknown',
        'conflict',
        'released',
        ...(hasReleaseIntent ? ['running'] : []),
      ]),
      conflict: new Set([
        'conflict',
        'unknown',
        'running',
        'partial',
        'completed',
        'released',
      ]),
      partial: new Set([
        'partial',
        'running',
        'completed',
        'unknown',
        'conflict',
        'released',
      ]),
      prepared: new Set([
        'prepared',
        'running',
        'partial',
        'completed',
        'unknown',
        'conflict',
      ]),
      released: new Set(['released']),
      running: new Set([
        'running',
        'partial',
        'completed',
        'unknown',
        'conflict',
      ]),
      unknown: new Set([
        'unknown',
        'running',
        'partial',
        'completed',
        'conflict',
        'released',
      ]),
    };
    if (!allowedTransitions[current.state]?.has(patch.state)) {
      fail('DEPENDENCY_FILE_JOURNAL_CONFLICT', 'finish-regression', {
        operationId,
      });
    }
    if (
      current.state === 'completed' &&
      patch.state === 'running' &&
      (!hasReleaseIntent ||
        checkpoints.every((row) => row.phase === 'released'))
    ) {
      fail('DEPENDENCY_FILE_JOURNAL_CONFLICT', 'finish-release-not-pending', {
        operationId,
      });
    }
  }

  async function finishSnapshot(operation, plan, patch) {
    const needsCheckpointScan =
      ['completed', 'released'].includes(patch.state) ||
      (operation.envelope.summary.state === 'completed' &&
        patch.state === 'running');
    const scanned = needsCheckpointScan
      ? await synchronizeOperation(operation, plan)
      : null;
    if (
      scanned &&
      (scanned.summary.completedFiles !==
        operation.envelope.summary.completedFiles ||
        scanned.summary.retainedOriginalFiles !==
          operation.envelope.summary.retainedOriginalFiles)
    ) {
      fail(
        'DEPENDENCY_FILE_JOURNAL_OUTCOME_UNKNOWN',
        'finish-checkpoint-reconciliation',
        { operationId: operation.summary.id }
      );
    }
    return {
      checkpoints: scanned ? scanned.checkpoints : [],
      summary: scanned ? scanned.summary : operation.envelope.summary,
    };
  }

  async function finishUnlocked(operation, plan, patch) {
    validateFinishPatchFields(operation, patch);
    const { checkpoints, summary: synchronizedSummary } = await finishSnapshot(
      operation,
      plan,
      patch
    );
    validateFinishProgress(
      operation,
      plan,
      patch,
      synchronizedSummary,
      checkpoints
    );
    validateFinishTransition(operation, patch, checkpoints);
    const nextSummary = monotonicUpdate(
      omitKeys(synchronizedSummary, ['code']),
      {
        state: patch.state,
        ...(Object.hasOwn(patch, 'code') ? { code: patch.code } : {}),
      }
    );
    const nextEnvelope = {
      ...operation.envelope,
      checkpointRevision: operation.envelope.checkpointRevision,
      summary: nextSummary,
    };
    try {
      const saved = await writeOperationEnvelope(nextEnvelope, operation.text);
      try {
        await updateWorkspaceSummary(saved.summary);
      } catch (cause) {
        fail('DEPENDENCY_FILE_JOURNAL_OUTCOME_UNKNOWN', 'finish-summary', {
          causeCode: cause.causeCode ?? cause.code,
          operationId: operation.summary.id,
        });
      }
      return cloneJson(saved.summary);
    } catch (cause) {
      if (
        cause.code === 'DEPENDENCY_FILE_JOURNAL_OUTCOME_UNKNOWN' ||
        cause.code === 'DEPENDENCY_FILE_JOURNAL_WRITE_FAILED'
      ) {
        await bestEffortUnknown(operation.summary.id);
      }
      throw cause;
    }
  }

  function validateReleaseCheckpointBindings(releasePlan, checkpoints) {
    const eligible = checkpoints
      .filter((row) => row.phase === 'verified' && row.retainedFingerprint)
      .sort((left, right) => left.index - right.index);
    if (eligible.length !== releasePlan.files.length) {
      fail('DEPENDENCY_FILE_JOURNAL_CONFLICT', 'release-files', {
        operationId: releasePlan.operationId,
      });
    }
    for (let position = 0; position < eligible.length; position += 1) {
      const checkpoint = eligible[position];
      const file = releasePlan.files[position];
      if (
        file.index !== checkpoint.index ||
        file.relativePath !== checkpoint.relativePath ||
        file.temporaryRelativePath !== checkpoint.temporaryRelativePath ||
        !sameFingerprintExceptAtime(
          file.originalFingerprint,
          checkpoint.retainedFingerprint
        ) ||
        !sameFingerprintExceptAtime(
          file.installedFingerprint,
          checkpoint.stagedFingerprint
        )
      ) {
        fail('DEPENDENCY_FILE_JOURNAL_CONFLICT', 'release-checkpoint-binding', {
          operationId: releasePlan.operationId,
        });
      }
    }
  }

  async function loadExistingRelease(pathParts, releasePlan) {
    const existing = await readRecord(
      pathParts,
      `${releasePlan.id}.json`,
      validReleasePlan
    );
    if (!existing) {
      return null;
    }
    if (releaseContent(existing.parsed) !== releaseContent(releasePlan)) {
      fail('DEPENDENCY_FILE_JOURNAL_CONFLICT', 'release-id-reused', {
        operationId: releasePlan.operationId,
      });
    }
    return cloneJson(existing.parsed);
  }

  async function resumeExistingOperation(existing, plan, operationId) {
    if (!existing) {
      return null;
    }
    if (
      existing.envelope.manifestDigest !== hash(canonicalJson(plan)) ||
      !sameBinding(existing.envelope.summary, plan)
    ) {
      fail('DEPENDENCY_FILE_JOURNAL_CONFLICT', 'begin-reused', {
        operationId,
      });
    }
    await ensureSummaryMatches(existing.envelope.summary);
    return cloneJson(existing.envelope.summary);
  }

  async function checkpointOperation(operationId) {
    const operation = await readOperationEnvelope(operationId);
    if (!operation) {
      fail('DEPENDENCY_FILE_JOURNAL_CONFLICT', 'checkpoint-operation-missing', {
        operationId,
      });
    }
    const plan = await loadPlan(operationId);
    if (
      !plan ||
      cachedPlanDigest(operationId, plan) !== operation.envelope.manifestDigest
    ) {
      fail('DEPENDENCY_FILE_JOURNAL_CORRUPT', 'checkpoint-manifest-binding', {
        operationId,
      });
    }
    await ensureSummaryMatches(operation.envelope.summary);
    return { operation, plan };
  }

  async function repairCheckpointRevision(
    operationId,
    operation,
    plan,
    previous
  ) {
    if (previous.envelope.revision > operation.envelope.checkpointRevision) {
      const synchronized = await synchronizeOperation(operation, plan);
      const repaired = monotonicUpdate(synchronized.summary, {});
      const nextOperation = {
        ...operation.envelope,
        checkpointRevision: previous.envelope.revision,
        summary: repaired,
      };
      try {
        await updateOperation(repaired, nextOperation, operation.text);
      } catch (cause) {
        if (cause.code === 'DEPENDENCY_FILE_JOURNAL_OUTCOME_UNKNOWN') {
          await bestEffortUnknown(operationId);
        }
        throw cause;
      }
    }
    return cloneJson(previous.envelope.record);
  }

  async function writeCheckpoint(
    operationId,
    index,
    operation,
    previous,
    record
  ) {
    if (operation.envelope.summary.state === 'released') {
      fail(
        'DEPENDENCY_FILE_JOURNAL_CONFLICT',
        'checkpoint-operation-released',
        { operationId }
      );
    }
    const nextRevision = operation.envelope.checkpointRevision + 1;
    const checkpointEnvelope = {
      index,
      manifestDigest: operation.envelope.manifestDigest,
      operationId,
      planId: operation.envelope.summary.planId,
      previousPhase: previous?.envelope.record.phase ?? null,
      record,
      revision: nextRevision,
      version: 1,
    };
    const checkpointParts = [JOURNAL_DIRECTORY, 'checkpoints', operationId];
    const checkpointText = previous?.text ?? null;
    try {
      const savedCheckpoint = await writeRecord(
        checkpointParts,
        `${index}.json`,
        checkpointEnvelope,
        { expectedText: checkpointText }
      );
      const completedDelta =
        Number(isCompletedPhase(record.phase)) -
        Number(
          previous ? isCompletedPhase(previous.envelope.record.phase) : false
        );
      const retainedDelta =
        Number(isRetainedCheckpoint(record)) -
        Number(
          previous ? isRetainedCheckpoint(previous.envelope.record) : false
        );
      const forcedState = nextStateForCheckpoint(
        record.phase,
        operation.envelope.summary.state
      );
      const forcedCode = checkpointStateCode(forcedState);
      const changes = {
        completedFiles:
          operation.envelope.summary.completedFiles + completedDelta,
        retainedOriginalFiles:
          operation.envelope.summary.retainedOriginalFiles + retainedDelta,
      };
      if (forcedState !== operation.envelope.summary.state) {
        changes.state = forcedState;
        if (forcedCode) {
          changes.code = forcedCode;
        }
      }
      const updated = monotonicUpdate(operation.envelope.summary, changes);
      const nextOperation = {
        ...operation.envelope,
        checkpointRevision: nextRevision,
        summary: updated,
      };
      await updateOperation(updated, nextOperation, operation.text);
      return cloneJson(savedCheckpoint.record);
    } catch (cause) {
      if (cause.code === 'DEPENDENCY_FILE_JOURNAL_OUTCOME_UNKNOWN') {
        await bestEffortUnknown(operationId);
      }
      throw cause;
    }
  }

  async function checkpointUnlocked(operationId, index, input) {
    const { operation, plan } = await checkpointOperation(operationId);
    const previous = await loadCheckpoint(operation, plan, index);
    const record = normalizedCheckpoint(plan, index, previous, input);
    if (
      previous &&
      canonicalJson({ ...previous.envelope.record, updatedAt: 0 }) ===
        canonicalJson({ ...record, updatedAt: 0 })
    ) {
      return repairCheckpointRevision(operationId, operation, plan, previous);
    }
    return writeCheckpoint(operationId, index, operation, previous, record);
  }

  async function loadReleaseBinding(releasePlan) {
    const op = await readOperationEnvelope(releasePlan.operationId);
    if (!op) {
      fail('DEPENDENCY_FILE_JOURNAL_CONFLICT', 'release-operation-missing', {
        operationId: releasePlan.operationId,
      });
    }
    const plan = await loadPlan(releasePlan.planId);
    if (
      !plan ||
      cachedPlanDigest(releasePlan.planId, plan) !== op.envelope.manifestDigest
    ) {
      fail('DEPENDENCY_FILE_JOURNAL_CORRUPT', 'release-plan-binding', {
        operationId: releasePlan.operationId,
      });
    }
    const { summary } = op.envelope;
    if (
      !sameReleaseBinding(summary, releasePlan) ||
      releasePlan.manifestDigest !== op.envelope.manifestDigest
    ) {
      fail('DEPENDENCY_FILE_JOURNAL_CONFLICT', 'release-binding', {
        operationId: releasePlan.operationId,
      });
    }
    return { op, plan, summary };
  }

  async function saveReleaseUnlocked(releasePlan) {
    const { op, plan, summary } = await loadReleaseBinding(releasePlan);
    const pathParts = [JOURNAL_DIRECTORY, 'releases'];
    const existing = await loadExistingRelease(pathParts, releasePlan);
    if (existing) {
      return existing;
    }
    if (summary.state !== 'completed') {
      fail('DEPENDENCY_FILE_JOURNAL_CONFLICT', 'release-binding', {
        operationId: releasePlan.operationId,
      });
    }
    const checkpoints = await scanCheckpoints(op, plan);
    validateReleaseCheckpointBindings(releasePlan, checkpoints);
    const saved = await writeRecord(
      pathParts,
      `${releasePlan.id}.json`,
      releasePlan
    );
    if (releaseContent(saved) !== releaseContent(releasePlan)) {
      fail('DEPENDENCY_FILE_JOURNAL_OUTCOME_UNKNOWN', 'release-readback', {
        operationId: releasePlan.operationId,
      });
    }
    return saved;
  }

  return {
    async begin(plan) {
      if (!validPlan(plan)) {
        fail('DEPENDENCY_FILE_JOURNAL_INVALID', 'plan');
      }
      const input = cloneJson(plan);
      await checkStoreRoot();
      return withTarget(input, async () => {
        const persistedPlan = await savePlanUnlocked(input);
        const operationId = persistedPlan.id;
        const operationParts = [JOURNAL_DIRECTORY, 'operations'];
        const existing = await resumeExistingOperation(
          await readOperationEnvelope(operationId),
          persistedPlan,
          operationId
        );
        if (existing) {
          return existing;
        }
        const document = await stateDocument();
        if (document.operations[operationId]) {
          fail(
            'DEPENDENCY_FILE_JOURNAL_OUTCOME_UNKNOWN',
            'begin-summary-without-manifest',
            {
              operationId,
            }
          );
        }
        const timestamp = currentTime();
        const summary = initialSummary(persistedPlan, timestamp);
        const envelope = {
          checkpointRevision: 0,
          manifestDigest: hash(canonicalJson(persistedPlan)),
          summary,
          version: 1,
        };
        try {
          const saved = await writeRecord(
            operationParts,
            `${operationId}.json`,
            envelope
          );
          try {
            await updateWorkspaceSummary(saved.summary);
          } catch (cause) {
            fail('DEPENDENCY_FILE_JOURNAL_OUTCOME_UNKNOWN', 'begin-summary', {
              causeCode: cause.causeCode ?? cause.code,
              operationId,
            });
          }
          return cloneJson(saved.summary);
        } catch (cause) {
          if (cause.code === 'DEPENDENCY_FILE_JOURNAL_OUTCOME_UNKNOWN') {
            await bestEffortUnknown(operationId);
          }
          throw cause;
        }
      });
    },
    async checkpoint(operationId, index, record) {
      if (
        !(validDigest(operationId) && Number.isSafeInteger(index)) ||
        index < 0
      ) {
        fail('DEPENDENCY_FILE_JOURNAL_INVALID', 'checkpoint-key');
      }
      await checkStoreRoot();
      const first = await readOperationEnvelope(operationId);
      if (!first) {
        fail(
          'DEPENDENCY_FILE_JOURNAL_CONFLICT',
          'checkpoint-operation-missing',
          {
            operationId,
          }
        );
      }
      return withTarget(first.envelope.summary, () =>
        checkpointUnlocked(operationId, index, record)
      );
    },
    async checkpoints(operationId) {
      if (!validDigest(operationId)) {
        fail('DEPENDENCY_FILE_JOURNAL_INVALID', 'operation-id');
      }
      await checkStoreRoot();
      const operation = await readOperationEnvelope(operationId);
      if (!operation) {
        return [];
      }
      const plan = await loadPlan(operationId);
      if (
        !plan ||
        cachedPlanDigest(operationId, plan) !==
          operation.envelope.manifestDigest
      ) {
        fail('DEPENDENCY_FILE_JOURNAL_CORRUPT', 'checkpoint-manifest-binding', {
          operationId,
        });
      }
      await assertSummaryMatches(
        operation.envelope.summary,
        'checkpoint-summary-mismatch'
      );
      return scanCheckpoints(operation, plan);
    },
    async finish(operationId, patch) {
      if (!validDigest(operationId)) {
        fail('DEPENDENCY_FILE_JOURNAL_INVALID', 'operation-id');
      }
      await checkStoreRoot();
      const first = await readOperationEnvelope(operationId);
      if (!first) {
        fail('DEPENDENCY_FILE_JOURNAL_CONFLICT', 'finish-operation-missing', {
          operationId,
        });
      }
      return withTarget(first.envelope.summary, async () => {
        const operation = await readOperationEnvelope(operationId);
        if (!operation) {
          fail('DEPENDENCY_FILE_JOURNAL_CONFLICT', 'finish-operation-missing', {
            operationId,
          });
        }
        const plan = await loadPlan(operationId);
        if (
          !plan ||
          cachedPlanDigest(operationId, plan) !==
            operation.envelope.manifestDigest
        ) {
          fail('DEPENDENCY_FILE_JOURNAL_CORRUPT', 'finish-manifest-binding', {
            operationId,
          });
        }
        await ensureSummaryMatches(operation.envelope.summary);
        return finishUnlocked(operation, plan, patch);
      });
    },
    async getOperation(operationId) {
      if (!validDigest(operationId)) {
        fail('DEPENDENCY_FILE_JOURNAL_INVALID', 'operation-id');
      }
      await checkStoreRoot();
      const operation = await readOperationEnvelope(operationId);
      if (!operation) {
        return null;
      }
      await assertSummaryMatches(
        operation.envelope.summary,
        'operation-summary-mismatch'
      );
      return cloneJson(operation.envelope.summary);
    },
    async getPlan(planId) {
      if (!validDigest(planId)) {
        fail('DEPENDENCY_FILE_JOURNAL_INVALID', 'plan-id');
      }
      await checkStoreRoot();
      const plan = await loadPlan(planId);
      return plan;
    },
    async getReleasePlan(releaseId) {
      if (!validDigest(releaseId)) {
        fail('DEPENDENCY_FILE_JOURNAL_INVALID', 'release-id');
      }
      await checkStoreRoot();
      const record = await readRecord(
        [JOURNAL_DIRECTORY, 'releases'],
        `${releaseId}.json`,
        validReleasePlan
      );
      if (!record) {
        return null;
      }
      const operation = await readOperationEnvelope(record.parsed.operationId);
      if (
        !operation ||
        operation.envelope.manifestDigest !== record.parsed.manifestDigest ||
        !sameReleaseBinding(operation.envelope.summary, record.parsed)
      ) {
        fail('DEPENDENCY_FILE_JOURNAL_CORRUPT', 'release-record-binding', {
          operationId: record.parsed.operationId,
        });
      }
      await assertSummaryMatches(
        operation.envelope.summary,
        'release-summary-mismatch'
      );
      const plan = await loadPlan(record.parsed.planId);
      if (
        !(
          plan &&
          releaseFilesMatch(
            await scanCheckpoints(operation, plan),
            record.parsed
          )
        )
      ) {
        fail('DEPENDENCY_FILE_JOURNAL_CORRUPT', 'release-checkpoint-binding', {
          operationId: record.parsed.operationId,
        });
      }
      return cloneJson(record.parsed);
    },
    async list(filters = {}) {
      if (
        !isObject(filters) ||
        Object.keys(filters).some((key) => !['repo', 'name'].includes(key))
      ) {
        fail('DEPENDENCY_FILE_JOURNAL_INVALID', 'list-filter');
      }
      const { repo, name } = filters;
      if (
        (repo !== undefined && !validRepositoryPart(repo)) ||
        (name !== undefined &&
          !(
            typeof name === 'string' &&
            name.split('/').every(validRepositoryPart)
          ))
      ) {
        fail('DEPENDENCY_FILE_JOURNAL_INVALID', 'list-filter');
      }
      const document = await stateDocument();
      const matches = (summary) =>
        (repo === undefined || summary.repo === repo) &&
        (name === undefined || summary.name === name);
      const operations = Object.values(document.operations)
        .filter(matches)
        .map(cloneJson)
        .sort(
          (left, right) =>
            left.createdAt - right.createdAt || left.id.localeCompare(right.id)
        );
      const views = Object.values(document.views)
        .filter(matches)
        .map(cloneJson)
        .sort(
          (left, right) =>
            left.repo.localeCompare(right.repo) ||
            left.name.localeCompare(right.name)
        );
      return { operations, views };
    },
    async savePlan(plan) {
      if (!validPlan(plan)) {
        fail('DEPENDENCY_FILE_JOURNAL_INVALID', 'plan');
      }
      const input = cloneJson(plan);
      await checkStoreRoot();
      assertStoreBinding(input.storeIdentity, 'plan-store-binding', input.id);
      return withTarget(input, async () =>
        cloneJson(await savePlanUnlocked(input))
      );
    },
    async saveReleasePlan(plan) {
      if (!validReleasePlan(plan)) {
        fail('DEPENDENCY_FILE_JOURNAL_INVALID', 'release-plan');
      }
      const input = cloneJson(plan);
      await checkStoreRoot();
      return withTarget(input, async () =>
        cloneJson(await saveReleaseUnlocked(input))
      );
    },
    async setView(target, summary) {
      if (
        !(validTarget(target?.repo, target?.name) && validSummary(summary)) ||
        summary.repo !== target.repo ||
        summary.name !== target.name
      ) {
        fail('DEPENDENCY_FILE_JOURNAL_INVALID', 'view');
      }
      await checkStoreRoot();
      return withTarget(target, async () => {
        const operation = await readOperationEnvelope(summary.id);
        if (
          !operation ||
          canonicalJson(operation.envelope.summary) !== canonicalJson(summary)
        ) {
          fail('DEPENDENCY_FILE_JOURNAL_CONFLICT', 'view-operation-binding', {
            operationId: summary.id,
          });
        }
        let result;
        try {
          result = await state.update('dependencyFiles', (current) => ({
            ...current,
            views: {
              ...current.views,
              [`${target.repo}/${target.name}`]: cloneJson(summary),
            },
          }));
        } catch (cause) {
          fail(
            cause.committed === false
              ? 'DEPENDENCY_FILE_JOURNAL_WRITE_FAILED'
              : 'DEPENDENCY_FILE_JOURNAL_OUTCOME_UNKNOWN',
            'workspace-view',
            {
              causeCode: cause.causeCode ?? cause.code,
              operationId: summary.id,
            }
          );
        }
        if (
          result.committed !== true ||
          result.reconciled !== true ||
          result.warning !== undefined ||
          result.status !== 'committed' ||
          canonicalJson(
            result.value?.views?.[`${target.repo}/${target.name}`]
          ) !== canonicalJson(summary)
        ) {
          fail('DEPENDENCY_FILE_JOURNAL_OUTCOME_UNKNOWN', 'workspace-view', {
            operationId: summary.id,
          });
        }
        return cloneJson(summary);
      });
    },
  };
}
