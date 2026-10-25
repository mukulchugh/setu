import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { types as utilTypes } from 'node:util';
import {
  previewSpansClientGroup,
  readBundledSpansSkill,
  SPANS_CLIENT_ADAPTERS,
} from './spans-integration-adapters.js';
import { createSpansIntegrationState } from './spans-integration-state.js';
import { createWorkspaceState } from './workspace-state.js';

const CLIENT_SET = new Set(SPANS_CLIENT_ADAPTERS);
const MAX_PREVIEWS = 64;
const MAX_CONFIRMATION_BYTES = 64 * 1024;
const MAX_SKILL_BYTES = 1024 * 1024;
const LOCK_TIMEOUT_MS = 5000;
const DIGEST = /^sha256:[a-f0-9]{64}$/;
const fail = (code, error = code, extra = {}) => ({
  code,
  error,
  ok: false,
  ...extra,
});
const integrationError = (code, options) =>
  Object.assign(new Error(code, options), { code });
const hash = (bytes) =>
  `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
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

function exactKeys(value, required, optional = []) {
  if (!plain(value)) {
    return false;
  }
  const accepted = new Set([...required, ...optional]);
  const keys = Object.keys(value);
  return (
    required.every((key) => Object.hasOwn(value, key)) &&
    keys.every((key) => accepted.has(key))
  );
}

function addSnapshotBytes(state, bytes, maxBytes) {
  state.bytes += bytes;
  if (state.bytes > maxBytes) {
    throw new Error('bounded input');
  }
}

function snapshotArray(input, state, ancestors, depth, maxBytes) {
  const keys = Reflect.ownKeys(input);
  if (
    Object.getPrototypeOf(input) !== Array.prototype ||
    input.length > 256 ||
    keys.length !== input.length + 1 ||
    !keys.includes('length')
  ) {
    throw new Error('invalid input');
  }
  const result = [];
  for (let index = 0; index < input.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(input, String(index));
    if (!(descriptor && Object.hasOwn(descriptor, 'value'))) {
      throw new Error('invalid input');
    }
    result.push(
      snapshotValue(descriptor.value, state, ancestors, depth + 1, maxBytes)
    );
  }
  return result;
}

function snapshotRecord(input, state, ancestors, depth, maxBytes) {
  const keys = Reflect.ownKeys(input);
  const prototype = Object.getPrototypeOf(input);
  if (
    (prototype !== Object.prototype && prototype !== null) ||
    keys.length > 64 ||
    keys.some((key) => typeof key !== 'string')
  ) {
    throw new Error('invalid input');
  }
  const result = Object.create(null);
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(input, key);
    if (!(descriptor && Object.hasOwn(descriptor, 'value'))) {
      throw new Error('invalid input');
    }
    addSnapshotBytes(state, Buffer.byteLength(key, 'utf8'), maxBytes);
    result[key] = snapshotValue(
      descriptor.value,
      state,
      ancestors,
      depth + 1,
      maxBytes
    );
  }
  return result;
}

function snapshotValue(input, state, ancestors, depth, maxBytes) {
  state.nodes += 1;
  if (state.nodes > 4096 || depth > 8) {
    throw new Error('bounded input');
  }
  if (typeof input === 'string') {
    if (input.includes('\0')) {
      throw new Error('invalid input');
    }
    addSnapshotBytes(state, Buffer.byteLength(input, 'utf8'), maxBytes);
    return input;
  }
  if (input === null || typeof input === 'boolean') {
    addSnapshotBytes(state, 8, maxBytes);
    return input;
  }
  if (typeof input === 'number') {
    if (!Number.isFinite(input)) {
      throw new Error('invalid input');
    }
    addSnapshotBytes(state, 8, maxBytes);
    return input;
  }
  if (
    typeof input !== 'object' ||
    utilTypes.isProxy(input) ||
    ancestors.has(input)
  ) {
    throw new Error('invalid input');
  }
  ancestors.add(input);
  const result = Array.isArray(input)
    ? snapshotArray(input, state, ancestors, depth, maxBytes)
    : snapshotRecord(input, state, ancestors, depth, maxBytes);
  ancestors.delete(input);
  return result;
}

function safeSnapshot(value, maxBytes = MAX_CONFIRMATION_BYTES) {
  return snapshotValue(value, { bytes: 0, nodes: 0 }, new Set(), 0, maxBytes);
}

function freezeTree(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) {
      freezeTree(child);
    }
    Object.freeze(value);
  }
  return value;
}

function validPath(path) {
  return (
    typeof path === 'string' &&
    path.length > 0 &&
    !path.includes('\0') &&
    isAbsolute(path) &&
    resolve(path) === path
  );
}

function pathParts(path) {
  const parts = [];
  let current = path;
  while (resolve(current, '..') !== current) {
    parts.push(current);
    current = resolve(current, '..');
  }
  parts.push(current);
  return parts.reverse();
}

function assertNoSymlink(path, boundary = sep, fileSystem = fs) {
  if (!inside(boundary, path) && boundary !== path) {
    throw integrationError('INTEGRATION_PATH_OUTSIDE_HOME');
  }
  let current = boundary;
  const parts = path.slice(boundary.length).split(sep).filter(Boolean);
  for (const part of parts) {
    current = resolve(current, part);
    let stat;
    try {
      stat = fileSystem.lstatSync(current);
    } catch (error) {
      if (error.code === 'ENOENT') {
        continue;
      }
      throw integrationError('INTEGRATION_PATH_UNSAFE');
    }
    if (stat.isSymbolicLink()) {
      throw integrationError('INTEGRATION_PATH_SYMLINK');
    }
  }
}

function assertSafeHome(fileSystem, home) {
  assertNoSymlink(home, sep, fileSystem);
  try {
    const info = fileSystem.lstatSync(home);
    if (
      info.isSymbolicLink() ||
      !info.isDirectory() ||
      fileSystem.realpathSync(home) !== home
    ) {
      throw integrationError('INTEGRATION_HOME_UNSAFE');
    }
  } catch (error) {
    if (error.code?.startsWith('INTEGRATION_')) {
      throw error;
    }
    throw integrationError('INTEGRATION_HOME_UNSAFE');
  }
}

function missingPath(path, fileSystem = fs) {
  for (const part of pathParts(path)) {
    try {
      const stat = fileSystem.lstatSync(part);
      if (stat.isSymbolicLink()) {
        return false;
      }
      if (part !== path && !stat.isDirectory()) {
        return false;
      }
    } catch (error) {
      if (error.code === 'ENOENT') {
        return true;
      }
      return false;
    }
  }
  return false;
}

function sameIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

function readTargetFile(fileSystem, target, info) {
  let fd;
  try {
    const noFollow = fileSystem.constants?.O_NOFOLLOW ?? 0;
    fd = fileSystem.openSync(target, fileSystem.constants.O_RDONLY + noFollow);
    const opened = fileSystem.fstatSync(fd, { bigint: true });
    if (
      !opened.isFile() ||
      opened.dev !== info.dev ||
      opened.ino !== info.ino ||
      opened.size > BigInt(MAX_SKILL_BYTES)
    ) {
      throw integrationError('INTEGRATION_TARGET_CHANGED');
    }
    const bytes = fileSystem.readFileSync(fd);
    const afterFd = fileSystem.fstatSync(fd, { bigint: true });
    const afterPath = fileSystem.lstatSync(target, { bigint: true });
    if (
      !(sameIdentity(opened, afterFd) && sameIdentity(opened, afterPath)) ||
      opened.size !== afterFd.size ||
      opened.mtimeNs !== afterFd.mtimeNs ||
      opened.ctimeNs !== afterFd.ctimeNs ||
      afterFd.size !== BigInt(bytes.length)
    ) {
      throw integrationError('INTEGRATION_TARGET_CHANGED');
    }
    new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    return {
      bytes,
      digest: hash(bytes),
      kind: 'regular-file',
    };
  } catch (error) {
    if (error.code?.startsWith('INTEGRATION_')) {
      throw error;
    }
    throw integrationError(
      error instanceof TypeError
        ? 'INTEGRATION_TARGET_ENCODING_INVALID'
        : 'INTEGRATION_TARGET_UNREADABLE'
    );
  } finally {
    if (fd !== undefined) {
      try {
        fileSystem.closeSync(fd);
      } catch {
        // The observation is already complete; closing is best effort.
      }
    }
  }
}

function observeTarget(fileSystem, home, target) {
  if (!inside(home, target)) {
    throw integrationError('INTEGRATION_TARGET_UNSAFE');
  }
  assertNoSymlink(target, home, fileSystem);
  let info;
  try {
    info = fileSystem.lstatSync(target, { bigint: true });
  } catch (error) {
    if (error.code === 'ENOENT') {
      return { digest: null, kind: 'missing' };
    }
    throw integrationError('INTEGRATION_TARGET_UNREADABLE');
  }
  if (!info.isFile()) {
    throw integrationError(
      info.isSymbolicLink()
        ? 'INTEGRATION_TARGET_SYMLINK'
        : 'INTEGRATION_TARGET_NOT_FILE'
    );
  }
  return readTargetFile(fileSystem, target, info);
}

function ensureOneArtifactParent(fileSystem, home, parent, segment) {
  const next = resolve(parent, segment);
  let info;
  try {
    info = fileSystem.lstatSync(next);
  } catch (error) {
    if (error.code !== 'ENOENT') {
      throw integrationError('INTEGRATION_TARGET_PARENT_UNSAFE');
    }
    assertNoSymlink(parent, home, fileSystem);
    try {
      fileSystem.mkdirSync(next, { mode: 0o755 });
    } catch (mkdirError) {
      if (mkdirError.code !== 'EEXIST') {
        throw integrationError('INTEGRATION_TARGET_PARENT_CREATE_FAILED');
      }
    }
    info = fileSystem.lstatSync(next);
  }
  if (info.isSymbolicLink() || !info.isDirectory()) {
    throw integrationError('INTEGRATION_TARGET_SYMLINK');
  }
  return next;
}

function ensureArtifactParents(fileSystem, home, target) {
  if (target !== resolve(home, '.agents/skills/setu-spans/SKILL.md')) {
    throw integrationError('INTEGRATION_TARGET_UNSUPPORTED');
  }
  assertSafeHome(fileSystem, home);
  let parent = home;
  for (const segment of ['.agents', 'skills', 'setu-spans']) {
    parent = ensureOneArtifactParent(fileSystem, home, parent, segment);
  }
  if (fileSystem.realpathSync(parent) !== parent) {
    throw integrationError('INTEGRATION_TARGET_SYMLINK');
  }
}

function ensureIntegrationStateParent(fileSystem, home, integrationRoot) {
  const parent = dirname(integrationRoot);
  try {
    const existing = fileSystem.lstatSync(parent);
    if (
      existing.isSymbolicLink() ||
      !existing.isDirectory() ||
      fileSystem.realpathSync(parent) !== parent
    ) {
      throw integrationError('INTEGRATION_ROOT_PARENT_UNSAFE');
    }
    return;
  } catch (error) {
    if (error.code !== 'ENOENT') {
      throw error;
    }
  }

  const reviewedParent = resolve(home, '.local/share/setu');
  const expectedRoot = resolve(reviewedParent, 'integrations');
  if (integrationRoot !== expectedRoot || parent !== reviewedParent) {
    throw integrationError('INTEGRATION_ROOT_PARENT_UNSAFE');
  }
  assertSafeHome(fileSystem, home);
  const share = dirname(reviewedParent);
  assertNoSymlink(share, home, fileSystem);
  let shareStat;
  try {
    shareStat = fileSystem.lstatSync(share);
  } catch (error) {
    throw integrationError('INTEGRATION_ROOT_PARENT_UNSAFE', { cause: error });
  }
  const shareMode = shareStat.mode % 0o1000;
  if (
    shareStat.isSymbolicLink() ||
    !shareStat.isDirectory() ||
    fileSystem.realpathSync(share) !== share ||
    (shareStat.uid !== 0 && shareStat.uid !== process.getuid?.()) ||
    Math.floor(shareMode / 0o020) % 2 === 1 ||
    Math.floor(shareMode / 0o002) % 2 === 1
  ) {
    throw integrationError('INTEGRATION_ROOT_PARENT_UNSAFE');
  }
  try {
    fileSystem.mkdirSync(reviewedParent, { mode: 0o700 });
  } catch (error) {
    if (error.code !== 'EEXIST') {
      throw integrationError('INTEGRATION_ROOT_PARENT_UNSAFE', {
        cause: error,
      });
    }
  }
  const created = fileSystem.lstatSync(reviewedParent);
  if (
    created.isSymbolicLink() ||
    !created.isDirectory() ||
    fileSystem.realpathSync(reviewedParent) !== reviewedParent
  ) {
    throw integrationError('INTEGRATION_ROOT_PARENT_UNSAFE');
  }
}

function ownFactoryOptions(options) {
  if (!plain(options) || utilTypes.isProxy(options)) {
    throw integrationError('INTEGRATION_RUNTIME_CONFIG_INVALID');
  }
  const allowed = [
    'integrationRoot',
    'home',
    'skillSourcePath',
    'verifyConfirmation',
    'readHandshakes',
    'now',
    'fs',
    'lockTimeoutMs',
  ];
  const keys = Reflect.ownKeys(options);
  if (
    keys.some((key) => typeof key !== 'string' || !allowed.includes(key)) ||
    !['integrationRoot', 'home', 'skillSourcePath', 'verifyConfirmation'].every(
      (key) => keys.includes(key)
    )
  ) {
    throw integrationError('INTEGRATION_RUNTIME_CONFIG_INVALID');
  }
  const config = Object.create(null);
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(options, key);
    if (!(descriptor && Object.hasOwn(descriptor, 'value'))) {
      throw integrationError('INTEGRATION_RUNTIME_CONFIG_INVALID');
    }
    config[key] = descriptor.value;
  }
  return config;
}

function validateFactoryPaths(config) {
  const { integrationRoot, home, skillSourcePath } = config;
  if (
    ![integrationRoot, home, skillSourcePath].every(validPath) ||
    home === sep ||
    integrationRoot === sep ||
    integrationRoot === home
  ) {
    throw Object.assign(
      new Error('runtime paths must be explicit normalized paths'),
      {
        code: 'INTEGRATION_RUNTIME_CONFIG_INVALID',
      }
    );
  }
}

function validateFactoryCallbacks(config) {
  const callbacks = ['verifyConfirmation', 'readHandshakes', 'now'];
  for (const callback of callbacks) {
    if (
      Object.hasOwn(config, callback) &&
      typeof config[callback] !== 'function'
    ) {
      throw integrationError('INTEGRATION_RUNTIME_CONFIG_INVALID');
    }
  }
  if (typeof config.verifyConfirmation !== 'function') {
    throw Object.assign(
      new Error('trusted confirmation verifier is required'),
      {
        code: 'INTEGRATION_CONFIRMATION_VERIFIER_REQUIRED',
      }
    );
  }
}

function validateFactory(options) {
  const config = ownFactoryOptions(options);
  validateFactoryPaths(config);
  validateFactoryCallbacks(config);
  if (config.fs !== undefined && typeof config.fs !== 'object') {
    throw integrationError('INTEGRATION_RUNTIME_CONFIG_INVALID');
  }
  const lockTimeoutMs = config.lockTimeoutMs ?? LOCK_TIMEOUT_MS;
  if (
    !Number.isSafeInteger(lockTimeoutMs) ||
    lockTimeoutMs < 1 ||
    lockTimeoutMs > 60_000
  ) {
    throw integrationError('INTEGRATION_RUNTIME_CONFIG_INVALID');
  }
  return {
    fileSystem: config.fs ?? fs,
    home: config.home,
    integrationRoot: config.integrationRoot,
    lockTimeoutMs,
    now: config.now ?? Date.now,
    readHandshakes: config.readHandshakes ?? (() => []),
    skillSourcePath: config.skillSourcePath,
    verifyConfirmation: config.verifyConfirmation,
  };
}

function operationRows(preview) {
  if (!(preview?.artifactPlans && Array.isArray(preview.preview?.operations))) {
    return [];
  }
  return preview.preview.operations;
}

function safeError(error, fallback = 'INTEGRATION_RUNTIME_FAILED') {
  const code =
    typeof error?.code === 'string' && error.code.startsWith('INTEGRATION_')
      ? error.code
      : fallback;
  return fail(code, code);
}

/** Compose read-only previews, confirmed artifact writes, and receipt recovery. */
export function createSpansIntegrationRuntime(options) {
  const {
    fileSystem,
    home,
    integrationRoot,
    lockTimeoutMs,
    now,
    readHandshakes,
    skillSourcePath,
    verifyConfirmation: checkConfirmation,
  } = validateFactory(options);
  const workspaceState = createWorkspaceState({
    fs: fileSystem,
    integrationRoot,
    lockTimeoutMs,
    workspaceRoot: home,
  });
  const receipts = createSpansIntegrationState({
    integrationRoot,
    now,
    state: workspaceState,
  });
  const issuedPreviews = new Map();
  const inFlight = new Set();
  let closed = false;
  let closePromise = null;
  let applyTail = Promise.resolve();

  function track(work) {
    if (closed) {
      return Promise.resolve(fail('INTEGRATION_RUNTIME_CLOSED'));
    }
    const promise = Promise.resolve().then(work);
    inFlight.add(promise);
    promise.finally(() => inFlight.delete(promise)).catch(() => undefined);
    return promise;
  }

  function readReceiptDocument() {
    if (missingPath(integrationRoot, fileSystem)) {
      return { records: [], version: 1 };
    }
    return receipts.read();
  }

  function latestReceipts(document) {
    const latest = new Map();
    for (const row of document.records) {
      if (row.status === 'applied') {
        if (row.operation === 'remove') {
          latest.delete(row.target);
        } else if (row.receipt) {
          latest.set(row.target, row.receipt);
        }
      }
    }
    return [...latest.values()];
  }

  function readNow() {
    let value;
    try {
      value = now();
    } catch (cause) {
      throw integrationError('INTEGRATION_CLOCK_INVALID', { cause });
    }
    if (!Number.isSafeInteger(value) || value < 0) {
      throw integrationError('INTEGRATION_CLOCK_INVALID');
    }
    return value;
  }

  async function readTrustedHandshakes() {
    let value;
    try {
      value = await readHandshakes();
      return safeSnapshot(value, 256 * 1024);
    } catch (cause) {
      throw Object.assign(
        new Error('trusted handshake observation unavailable', { cause }),
        {
          code: 'INTEGRATION_HANDSHAKE_OBSERVATION_FAILED',
        }
      );
    }
  }

  async function makePreview(selection) {
    const document = readReceiptDocument();
    const handshakes = await readTrustedHandshakes();
    const result = await previewSpansClientGroup({
      clients: selection.clients,
      handshakes,
      home,
      now: readNow(),
      previousReceipts: latestReceipts(document),
      ...(selection.removeClient
        ? { removeClient: selection.removeClient }
        : {}),
      skillSourcePath,
    });
    if (!selection.removeSharedArtifact) {
      return result;
    }
    if (!(result.ok && result.preview?.ok)) {
      return result;
    }
    const target = resolve(home, '.agents/skills/setu-spans/SKILL.md');
    const plan = result.artifactPlans.find(
      (row) =>
        row.client === 'codex' &&
        row.path === target &&
        JSON.stringify(row.consumers) === JSON.stringify(['codex', 'cursor'])
    );
    const observation = result.observations.codex.observations.find(
      (row) => row.path === target
    );
    const receipt = latestReceipts(document).find(
      (row) => row.client === 'codex' && row.path === target
    );
    if (
      !plan ||
      observation?.kind !== 'regular-file' ||
      !receipt ||
      receipt.version !== 'codex-skills-v1' ||
      receipt.digest !== observation.digest ||
      hash(Buffer.from(receipt.content, 'utf8')) !== receipt.digest ||
      receipt.appliedEvidence?.state !== 'observed'
    ) {
      return fail(
        'INTEGRATION_SHARED_ARTIFACT_NOT_OWNED',
        'Removal requires the exact current Codex-owned shared skill and its applied receipt.'
      );
    }
    const affectedClients = ['codex', 'cursor'];
    const previewDigest = hash(
      Buffer.from(
        JSON.stringify({
          action: 'remove-shared-codex-cursor-skill',
          basePreviewDigest: result.preview.previewDigest,
          digest: receipt.digest,
          path: target,
          version: receipt.version,
        }),
        'utf8'
      )
    );
    const groupDigest = hash(
      Buffer.from(
        JSON.stringify({
          action: 'remove-shared-codex-cursor-skill',
          affectedClients,
          baseGroupDigest: result.groupDigest,
          path: target,
          previewDigest,
        }),
        'utf8'
      )
    );
    return {
      ...result,
      groupDigest,
      preview: {
        ...result.preview,
        operations: [
          {
            client: 'codex',
            digest: receipt.digest,
            kind: 'remove',
            path: target,
            version: receipt.version,
          },
        ],
        previewDigest,
      },
      removeSharedArtifact: true,
      sharedArtifactRemoval: {
        affectedClients,
        disposition: 'remove-exact-owned-shared-artifact',
        path: target,
      },
    };
  }

  function hasValidSharedRemovalSelection(selection, clients) {
    return (
      selection.removeSharedArtifact === undefined ||
      (selection.removeSharedArtifact === true &&
        selection.removeClient === undefined &&
        clients.length === 2 &&
        clients.includes('codex') &&
        clients.includes('cursor'))
    );
  }

  function parseSelection(input) {
    let selection;
    try {
      selection = safeSnapshot(input ?? {}, 16 * 1024);
    } catch {
      return { error: fail('INTEGRATION_INPUT_INVALID') };
    }
    if (
      !exactKeys(
        selection,
        [],
        ['clients', 'removeClient', 'removeSharedArtifact']
      )
    ) {
      return { error: fail('INTEGRATION_INPUT_INVALID') };
    }
    const clients = selection.clients ?? [...SPANS_CLIENT_ADAPTERS];
    if (
      !Array.isArray(clients) ||
      clients.length < 1 ||
      clients.length > SPANS_CLIENT_ADAPTERS.length ||
      new Set(clients).size !== clients.length ||
      !clients.every((client) => CLIENT_SET.has(client))
    ) {
      return { error: fail('INTEGRATION_CLIENT_SELECTION_INVALID') };
    }
    if (
      selection.removeClient !== undefined &&
      (typeof selection.removeClient !== 'string' ||
        !CLIENT_SET.has(selection.removeClient) ||
        !clients.includes(selection.removeClient))
    ) {
      return { error: fail('INTEGRATION_REMOVAL_UNSUPPORTED') };
    }
    if (!hasValidSharedRemovalSelection(selection, clients)) {
      return { error: fail('INTEGRATION_REMOVAL_UNSUPPORTED') };
    }
    return {
      selection: {
        clients,
        ...(selection.removeClient
          ? { removeClient: selection.removeClient }
          : {}),
        ...(selection.removeSharedArtifact
          ? { removeSharedArtifact: true }
          : {}),
      },
    };
  }

  function preview(input = {}) {
    const parsed = parseSelection(input);
    if ('error' in parsed) {
      return Promise.resolve(parsed.error);
    }
    return track(async () => {
      try {
        const result = await makePreview(parsed.selection);
        if (!(result.ok || result.preview)) {
          return result;
        }
        const copied = freezeTree(structuredClone(result));
        const key = copied.groupDigest;
        if (typeof key === 'string') {
          issuedPreviews.set(key, {
            json: JSON.stringify(copied),
            selection: parsed.selection,
          });
          while (issuedPreviews.size > MAX_PREVIEWS) {
            issuedPreviews.delete(issuedPreviews.keys().next().value);
          }
        }
        return copied;
      } catch (error) {
        return safeError(error, 'INTEGRATION_PREVIEW_FAILED');
      }
    });
  }

  function readApplyInput(input) {
    let value;
    try {
      value = safeSnapshot(input, 2 * 1024 * 1024);
    } catch {
      return { error: fail('INTEGRATION_INPUT_INVALID') };
    }
    if (!exactKeys(value, ['confirmation', 'groupDigest', 'preview'])) {
      return { error: fail('INTEGRATION_INPUT_INVALID') };
    }
    if (
      typeof value.groupDigest !== 'string' ||
      !DIGEST.test(value.groupDigest) ||
      value.preview?.groupDigest !== value.groupDigest
    ) {
      return { error: fail('INTEGRATION_PREVIEW_INVALID') };
    }
    const issued = issuedPreviews.get(value.groupDigest);
    if (!issued || JSON.stringify(value.preview) !== issued.json) {
      return { error: fail('INTEGRATION_PREVIEW_UNKNOWN') };
    }
    return { issued, value };
  }

  async function verifyConfirmation(value, issued) {
    if (issued.selection.removeClient) {
      return fail(
        'INTEGRATION_REMOVAL_UNSUPPORTED',
        'Removing one client requires a native client setting and cannot detach a shared artifact.'
      );
    }
    const removal = issued.selection.removeSharedArtifact === true;
    if (
      removal !== (value.preview.removeSharedArtifact === true) ||
      (removal &&
        (value.preview.sharedArtifactRemoval?.path !==
          resolve(home, '.agents/skills/setu-spans/SKILL.md') ||
          JSON.stringify(
            value.preview.sharedArtifactRemoval.affectedClients
          ) !== JSON.stringify(['codex', 'cursor']) ||
          operationRows(value.preview).length !== 1 ||
          operationRows(value.preview)[0].kind !== 'remove'))
    ) {
      return fail('INTEGRATION_PREVIEW_INVALID');
    }
    if (
      !(issued.json && value.preview.ok) ||
      value.preview.preview?.ok !== true
    ) {
      return fail('INTEGRATION_PREVIEW_CONFLICT');
    }
    let result;
    try {
      result = await checkConfirmation({
        clients: issued.selection.clients,
        confirmation: value.confirmation,
        groupDigest: value.groupDigest,
        previewDigest: value.preview.preview.previewDigest,
      });
    } catch {
      return fail('INTEGRATION_CONFIRMATION_REJECTED');
    }
    if (
      !plain(result) ||
      result.verified !== true ||
      result.groupDigest !== value.groupDigest ||
      result.previewDigest !== value.preview.preview.previewDigest
    ) {
      return fail('INTEGRATION_CONFIRMATION_REJECTED');
    }
    return { ok: true };
  }

  function targetForOperation(groupPreview, operation) {
    const target = resolve(home, '.agents/skills/setu-spans/SKILL.md');
    const plan = groupPreview.artifactPlans.find(
      (row) => row.client === 'codex' && row.path === target
    );
    if (
      !plan ||
      operation.client !== 'codex' ||
      operation.path !== target ||
      (operation.kind === 'remove'
        ? !(
            groupPreview.removeSharedArtifact === true &&
            groupPreview.sharedArtifactRemoval?.path === target &&
            JSON.stringify(
              groupPreview.sharedArtifactRemoval.affectedClients
            ) === JSON.stringify(['codex', 'cursor'])
          )
        : !['create', 'update', 'no-op'].includes(operation.kind))
    ) {
      throw integrationError('INTEGRATION_ARTIFACT_PLAN_UNSUPPORTED');
    }
    return target;
  }

  function withArtifactTarget(target, work) {
    const expected = resolve(home, '.agents/skills/setu-spans/SKILL.md');
    if (target !== expected) {
      return Promise.reject(integrationError('INTEGRATION_TARGET_UNSUPPORTED'));
    }
    return workspaceState.withTargets(
      [{ name: 'skills/setu-spans', repo: '.agents' }],
      work
    );
  }

  function supportedPendingRow(row, target) {
    return (
      row.client === 'codex' &&
      row.target === target &&
      (['install', 'update'].includes(row.operation)
        ? row.desiredAfter !== null && row.disposition === 'retain'
        : row.operation === 'remove' &&
          row.desiredAfter === null &&
          row.disposition === 'remove')
    );
  }

  async function settleUnobservablePending(row) {
    await receipts.reconcileEvidence({
      evidenceKnown: false,
      observedDigest: null,
      operationId: row.operationId,
    });
    return { operationId: row.operationId, status: 'unknown' };
  }

  function recoveredReceipt(row, target, observed) {
    if (
      observed.kind !== 'regular-file' ||
      observed.digest !== row.desiredAfter
    ) {
      return null;
    }
    return {
      appliedEvidence: {
        observedAt: readNow(),
        operationId: row.operationId,
        state: 'observed',
      },
      client: 'codex',
      content: new TextDecoder('utf-8', { fatal: true }).decode(observed.bytes),
      digest: observed.digest,
      path: target,
      version: 'codex-skills-v1',
    };
  }

  async function settleObservedPending(row, target, observed) {
    const receipt = recoveredReceipt(row, target, observed);
    const result = await receipts.reconcileEvidence({
      observedDigest: observed.digest,
      operationId: row.operationId,
      ...(receipt ? { receipt } : {}),
    });
    if (result.status === 'unknown') {
      return { operationId: row.operationId, status: 'unknown' };
    }
    let status = 'conflict';
    if (receipt) {
      status = 'applied';
    } else if (row.operation === 'remove' && observed.kind === 'missing') {
      status = 'removed';
    }
    return {
      operationId: row.operationId,
      status,
    };
  }

  async function reconcileLockedRow(row, target) {
    const currentDocument = readReceiptDocument();
    const currentRow = currentDocument.records.find(
      (entry) => entry.operationId === row.operationId
    );
    if (!(currentRow && ['pending', 'unknown'].includes(currentRow.status))) {
      return { operationId: row.operationId, status: 'already-settled' };
    }
    let observed;
    try {
      observed = observeTarget(fileSystem, home, target);
    } catch {
      return await settleUnobservablePending(row);
    }
    return await settleObservedPending(currentRow, target, observed);
  }

  async function reconcileOne(row) {
    const target = resolve(home, '.agents/skills/setu-spans/SKILL.md');
    if (!supportedPendingRow(row, target)) {
      return fail(
        'INTEGRATION_RECONCILIATION_UNSUPPORTED',
        'A pending receipt does not match the supported Codex-owned artifact.'
      );
    }
    return await withArtifactTarget(target, () =>
      reconcileLockedRow(row, target)
    );
  }

  async function reconcileInternal() {
    const document = readReceiptDocument();
    const pending = document.records.filter((row) =>
      ['pending', 'unknown'].includes(row.status)
    );
    const results = await Promise.all(pending.map(reconcileOne));
    const error = results.find((result) => result.ok === false);
    if (error) {
      return error;
    }
    if (results.length > 0) {
      issuedPreviews.clear();
    }
    return { ok: true, reconciled: results };
  }

  function reconcile() {
    return track(async () => {
      try {
        return await reconcileInternal();
      } catch (error) {
        return safeError(error, 'INTEGRATION_RECONCILIATION_FAILED');
      }
    });
  }

  async function settleConflict(operationId, observedDigest) {
    try {
      const result = await receipts.settleEvidence({
        observedDigest,
        operationId,
      });
      return result.status === 'unknown'
        ? fail('INTEGRATION_STATE_WRITE_UNKNOWN')
        : null;
    } catch (error) {
      return safeError(error, 'INTEGRATION_STATE_WRITE_UNKNOWN');
    }
  }

  async function beginOperationIntent(
    previewResult,
    operation,
    target,
    observation
  ) {
    const operationId = randomUUID();
    const removing = operation.kind === 'remove';
    let operationType = 'update';
    if (removing) {
      operationType = 'remove';
    } else if (observation.kind === 'missing') {
      operationType = 'install';
    }
    const begun = await receipts.beginIntent({
      allowedRoot: resolve(home, '.agents/skills'),
      client: 'codex',
      desiredAfter: removing ? null : operation.digest,
      disposition: removing ? 'remove' : 'retain',
      expectedBefore: observation.digest,
      operation: operationType,
      operationId,
      previewDigest: previewResult.preview.previewDigest,
      target,
    });
    return begun.status === 'committed'
      ? { operationId }
      : { error: fail('INTEGRATION_STATE_WRITE_UNKNOWN') };
  }

  async function readMatchingBundle(operation) {
    const result = await readBundledSpansSkill(skillSourcePath);
    return result.ok && result.digest === operation.digest ? result : null;
  }

  async function readMatchingPackage(previewResult) {
    const result = await readBundledSpansSkill(skillSourcePath);
    return result.ok && result.digest === previewResult.sourceDigest
      ? result
      : null;
  }

  async function failUnobservableWrite(operationId, code) {
    const result = await receipts.settleEvidence({
      evidenceKnown: false,
      observedDigest: null,
      operationId,
    });
    return result.status === 'unknown'
      ? fail('INTEGRATION_STATE_WRITE_UNKNOWN')
      : fail(code);
  }

  async function settleCurrentTargetConflict(operationId, code) {
    let current;
    try {
      current = observeTarget(
        fileSystem,
        home,
        resolve(home, '.agents/skills/setu-spans/SKILL.md')
      );
    } catch {
      return await failUnobservableWrite(
        operationId,
        'INTEGRATION_TARGET_UNREADABLE'
      );
    }
    const settled = await settleConflict(operationId, current.digest);
    return settled ?? fail(code);
  }

  function sameFreshPlan(fresh, previewResult) {
    return Boolean(
      fresh.ok &&
        fresh.preview?.ok &&
        fresh.groupDigest === previewResult.groupDigest &&
        JSON.stringify(operationRows(fresh)) ===
          JSON.stringify(operationRows(previewResult))
    );
  }

  function writerFailureCode(error, committedFailureCode) {
    if (error.code === 'STATE_PRECONDITION_FAILED') {
      return 'INTEGRATION_PREVIEW_STALE';
    }
    if (error.committed === false) {
      return committedFailureCode;
    }
    return null;
  }

  async function runTextWriter(operationId, committedFailureCode, write) {
    let result;
    try {
      result = await write();
    } catch (error) {
      const code = writerFailureCode(error, committedFailureCode);
      return {
        error: code
          ? await settleCurrentTargetConflict(operationId, code)
          : await failUnobservableWrite(
              operationId,
              'INTEGRATION_EFFECT_UNKNOWN'
            ),
      };
    }
    if (
      !result.committed ||
      result.warning ||
      !result.reconciled ||
      result.status !== 'committed'
    ) {
      return {
        error: await failUnobservableWrite(
          operationId,
          'INTEGRATION_EFFECT_UNKNOWN'
        ),
      };
    }
    return { result };
  }

  function receiptMatchesRemoval(target, current, operation) {
    const receipt = latestReceipts(readReceiptDocument()).find(
      (row) => row.client === 'codex' && row.path === target
    );
    return Boolean(
      receipt &&
        receipt.digest === current.digest &&
        hash(Buffer.from(receipt.content, 'utf8')) === current.digest &&
        receipt.version === operation.version
    );
  }

  async function prepareReviewedTarget(
    selection,
    previewResult,
    operation,
    target,
    observation,
    operationId
  ) {
    const fresh = await makePreview(selection);
    if (!sameFreshPlan(fresh, previewResult)) {
      return {
        error: await settleCurrentTargetConflict(
          operationId,
          'INTEGRATION_PREVIEW_STALE'
        ),
      };
    }
    const bundle =
      operation.kind === 'remove'
        ? await readMatchingPackage(previewResult)
        : await readMatchingBundle(operation);
    if (!bundle) {
      return {
        error: await settleCurrentTargetConflict(
          operationId,
          'INTEGRATION_PACKAGE_CHANGED'
        ),
      };
    }
    let current;
    try {
      current = observeTarget(fileSystem, home, target);
    } catch {
      return {
        error: await failUnobservableWrite(
          operationId,
          'INTEGRATION_TARGET_UNREADABLE'
        ),
      };
    }
    if (
      current.digest !== observation.digest ||
      (operation.kind === 'remove'
        ? current.kind !== 'regular-file' || current.digest !== operation.digest
        : current.kind !== observation.kind)
    ) {
      const settled = await settleConflict(operationId, current.digest);
      return { error: settled ?? fail('INTEGRATION_PREVIEW_STALE') };
    }
    if (
      operation.kind === 'remove' &&
      !receiptMatchesRemoval(target, current, operation)
    ) {
      const settled = await settleConflict(operationId, current.digest);
      return { error: settled ?? fail('INTEGRATION_PREVIEW_STALE') };
    }
    return { bundle, current };
  }

  async function applyReviewedTarget(
    selection,
    previewResult,
    operation,
    target,
    observation,
    operationId
  ) {
    const removing = operation.kind === 'remove';
    if (!removing) {
      try {
        ensureArtifactParents(fileSystem, home, target);
      } catch (error) {
        const settled = await settleConflict(operationId, observation.digest);
        return (
          settled ?? safeError(error, 'INTEGRATION_TARGET_PARENT_CREATE_FAILED')
        );
      }
    }
    const prepared = await prepareReviewedTarget(
      selection,
      previewResult,
      operation,
      target,
      observation,
      operationId
    );
    if ('error' in prepared) {
      return prepared.error;
    }
    const expectedText =
      prepared.current.kind === 'missing'
        ? null
        : new TextDecoder('utf-8', { fatal: true }).decode(
            prepared.current.bytes
          );
    const write = await runTextWriter(
      operationId,
      removing
        ? 'INTEGRATION_TARGET_REMOVE_FAILED'
        : 'INTEGRATION_TARGET_WRITE_FAILED',
      () =>
        removing
          ? workspaceState.removeText(target, { expectedText })
          : workspaceState.replaceText(target, prepared.bundle.content, {
              expectedText,
              mode: null,
            })
    );
    if ('error' in write) {
      return write.error;
    }
    if (removing) {
      return await settleRemovedTarget(target, operationId, operation);
    }
    let after;
    try {
      after = observeTarget(fileSystem, home, target);
    } catch {
      return await failUnobservableWrite(
        operationId,
        'INTEGRATION_EFFECT_UNKNOWN'
      );
    }
    return await settleAppliedTarget(
      operation,
      target,
      operationId,
      prepared.bundle.content,
      after
    );
  }

  async function settleRemovedTarget(target, operationId, operation) {
    let after;
    try {
      after = observeTarget(fileSystem, home, target);
    } catch {
      return await failUnobservableWrite(
        operationId,
        'INTEGRATION_EFFECT_UNKNOWN'
      );
    }
    if (after.kind !== 'missing') {
      const settled = await settleConflict(operationId, after.digest);
      return settled ?? fail('INTEGRATION_EFFECT_NOT_CONFIRMED');
    }
    const settled = await receipts.settleEvidence({
      observedDigest: null,
      operationId,
    });
    if (settled.status !== 'committed') {
      return fail('INTEGRATION_STATE_WRITE_UNKNOWN');
    }
    const saved = settled.document.records.find(
      (row) => row.operationId === operationId
    );
    if (
      saved?.status !== 'applied' ||
      saved.after !== null ||
      saved.receipt !== null
    ) {
      return fail('INTEGRATION_RECEIPT_NOT_CONFIRMED');
    }
    return {
      client: 'codex',
      digest: operation.digest,
      operationId,
      path: target,
      status: 'removed',
    };
  }

  async function settleAppliedTarget(
    operation,
    target,
    operationId,
    content,
    after
  ) {
    if (
      after.kind !== 'regular-file' ||
      after.digest !== operation.digest ||
      !after.bytes.equals(Buffer.from(content, 'utf8'))
    ) {
      const settled = await settleConflict(operationId, after.digest ?? null);
      return settled ?? fail('INTEGRATION_EFFECT_NOT_CONFIRMED');
    }
    const receipt = {
      appliedEvidence: {
        observedAt: readNow(),
        operationId,
        state: 'observed',
      },
      client: 'codex',
      content,
      digest: operation.digest,
      path: target,
      version: operation.version,
    };
    const settled = await receipts.settleEvidence({
      observedDigest: after.digest,
      operationId,
      receipt,
    });
    if (settled.status !== 'committed') {
      return fail('INTEGRATION_STATE_WRITE_UNKNOWN');
    }
    const saved = settled.document.records.find(
      (row) => row.operationId === operationId
    );
    if (
      saved?.status !== 'applied' ||
      saved.after !== operation.digest ||
      saved.receipt?.digest !== operation.digest ||
      saved.receipt?.content !== content
    ) {
      return fail('INTEGRATION_RECEIPT_NOT_CONFIRMED');
    }
    return {
      client: 'codex',
      digest: operation.digest,
      operationId,
      path: target,
      status: 'applied',
    };
  }

  async function applyOne(previewResult, operation) {
    const target = targetForOperation(previewResult, operation);
    const observation = previewResult.observations.codex.observations.find(
      (row) => row.path === target
    );
    if (
      !(observation && ['missing', 'regular-file'].includes(observation.kind))
    ) {
      return fail('INTEGRATION_OBSERVATION_INVALID');
    }
    try {
      ensureIntegrationStateParent(fileSystem, home, integrationRoot);
    } catch (error) {
      return safeError(error, 'INTEGRATION_ROOT_PARENT_UNSAFE');
    }
    const intent = await beginOperationIntent(
      previewResult,
      operation,
      target,
      observation
    );
    if ('error' in intent) {
      return intent.error;
    }
    const selection = {
      clients: previewResult.clients,
      ...(previewResult.removeSharedArtifact
        ? { removeSharedArtifact: true }
        : {}),
    };
    return await applyReviewedTarget(
      selection,
      previewResult,
      operation,
      target,
      observation,
      intent.operationId
    );
  }

  async function applyFreshPreview(issued, value, planned) {
    const fresh = await makePreview(issued.selection);
    if (!(fresh.ok && fresh.preview?.ok)) {
      return fail(
        'INTEGRATION_PREVIEW_CONFLICT',
        'The fresh integration observation contains a conflict.',
        { conflicts: fresh.preview?.conflicts ?? [] }
      );
    }
    if (
      fresh.groupDigest !== value.groupDigest ||
      JSON.stringify(operationRows(fresh)) !== JSON.stringify(planned)
    ) {
      return fail('INTEGRATION_PREVIEW_STALE');
    }
    return await applyFreshOperations(fresh);
  }

  async function applyFreshOperations(fresh) {
    const operations = operationRows(fresh).filter(
      (row) => row.kind !== 'no-op'
    );
    if (operations.length > 1) {
      return fail('INTEGRATION_ARTIFACT_PLAN_UNSUPPORTED');
    }
    const [operation] = operations;
    const applied = operation ? [await applyOne(fresh, operation)] : [];
    const error = applied.find((result) => result.ok === false);
    if (error) {
      return error;
    }
    return {
      applied,
      clientSources: fresh.clientSources,
      groupDigest: fresh.groupDigest,
      idempotent: applied.length === 0,
      ok: true,
      previewOnly: false,
      statuses: fresh.preview.statuses,
    };
  }

  async function applyInternal(parsed) {
    const { issued, value } = parsed;
    const confirmation = await verifyConfirmation(value, issued);
    if (!confirmation.ok) {
      return confirmation;
    }
    const reconciliation = await reconcileInternal();
    if (!reconciliation.ok) {
      return reconciliation;
    }
    if (reconciliation.reconciled.length > 0) {
      return fail(
        'INTEGRATION_RECONCILIATION_REQUIRED',
        'A pending integration operation was reconciled; create a fresh preview and confirmation before applying.'
      );
    }
    const planned = operationRows(value.preview);
    const targets = planned
      .filter((operation) => operation.kind !== 'no-op')
      .map((operation) => targetForOperation(value.preview, operation));
    if (targets.length > 1) {
      return fail('INTEGRATION_ARTIFACT_PLAN_UNSUPPORTED');
    }
    const effect = () => applyFreshPreview(issued, value, planned);
    return targets.length
      ? await withArtifactTarget(targets[0], effect)
      : await effect();
  }

  function apply(input) {
    const parsed = readApplyInput(input);
    if ('error' in parsed) {
      return Promise.resolve(parsed.error);
    }
    return track(() => {
      const next = applyTail.then(() => applyInternal(parsed));
      applyTail = next.catch(() => undefined);
      return next.catch((error) =>
        safeError(error, 'INTEGRATION_APPLY_FAILED')
      );
    });
  }

  function close() {
    if (closePromise) {
      return closePromise;
    }
    closed = true;
    closePromise = Promise.allSettled([...inFlight]).then(() => ({
      closed: true,
      ok: true,
    }));
    return closePromise;
  }

  return Object.freeze({ apply, close, preview, reconcile });
}
