import { createHash } from 'node:crypto';
import { isAbsolute, relative, resolve, sep } from 'node:path';

const CLIENTS = new Set(['claude', 'codex', 'cursor']);
const DIGEST = /^sha256:[a-f0-9]{64}$/;
const MAX_HANDSHAKE_AGE_MS = 5 * 60 * 1000;
const MAX_ARRAY_ITEMS = 256;
const MAX_OBJECT_KEYS = 64;
const MAX_NODES = 4096;
const MAX_STRING_BYTES = 1024 * 1024;
const MAX_INPUT_BYTES = 4 * 1024 * 1024;

const fail = (code, message) => ({ code, error: message, ok: false });
const isRecord = (value) =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

function freezeDto(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) {
      freezeDto(child);
    }
    Object.freeze(value);
  }
  return value;
}

function checkSnapshotBudget(state) {
  state.nodes += 1;
  if (state.nodes > MAX_NODES) {
    throw new Error('too many input values');
  }
}

function snapshotString(value, state) {
  const size = Buffer.byteLength(value, 'utf8');
  if (size > MAX_STRING_BYTES) {
    throw new Error('bounded input');
  }
  state.bytes += size;
  if (state.bytes > MAX_INPUT_BYTES) {
    throw new Error('bounded input');
  }
  return value;
}

function snapshotScalar(value, state) {
  if (typeof value === 'number' && !Number.isFinite(value)) {
    throw new Error('invalid number');
  }
  state.bytes += 8;
  if (state.bytes > MAX_INPUT_BYTES) {
    throw new Error('bounded input');
  }
  return value;
}

function snapshotArray(value, state, ancestors) {
  if (
    Object.getPrototypeOf(value) !== Array.prototype ||
    value.length > MAX_ARRAY_ITEMS
  ) {
    throw new Error('invalid array');
  }
  const keys = Reflect.ownKeys(value);
  if (keys.length !== value.length + 1 || !keys.includes('length')) {
    throw new Error('invalid array keys');
  }
  const copy = [];
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!(descriptor && Object.hasOwn(descriptor, 'value'))) {
      throw new Error('invalid array item');
    }
    copy.push(snapshot(descriptor.value, state, ancestors));
  }
  return copy;
}

function snapshotRecord(value, state, ancestors) {
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) {
    throw new Error('invalid record');
  }
  const keys = Reflect.ownKeys(value);
  if (
    keys.length > MAX_OBJECT_KEYS ||
    keys.some((key) => typeof key !== 'string')
  ) {
    throw new Error('invalid key');
  }
  const copy = Object.create(null);
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!(descriptor && Object.hasOwn(descriptor, 'value'))) {
      throw new Error('invalid property');
    }
    state.bytes += Buffer.byteLength(key, 'utf8');
    if (state.bytes > MAX_INPUT_BYTES) {
      throw new Error('bounded input');
    }
    copy[key] = snapshot(descriptor.value, state, ancestors);
  }
  return copy;
}

function snapshot(value, state, ancestors = new Set()) {
  checkSnapshotBudget(state);
  if (typeof value === 'string') {
    return snapshotString(value, state);
  }
  if (
    value === null ||
    typeof value === 'boolean' ||
    typeof value === 'number'
  ) {
    return snapshotScalar(value, state);
  }
  if (typeof value !== 'object' || ancestors.has(value)) {
    throw new Error('invalid object graph');
  }
  if (ancestors.size > 8) {
    throw new Error('input too deep');
  }
  ancestors.add(value);
  const copy = Array.isArray(value)
    ? snapshotArray(value, state, ancestors)
    : snapshotRecord(value, state, ancestors);
  ancestors.delete(value);
  return copy;
}

function assertKeys(value, required, optional = []) {
  if (!isRecord(value)) {
    return false;
  }
  const allowed = new Set([...required, ...optional]);
  const keys = Object.keys(value);
  return (
    required.every((key) => Object.hasOwn(value, key)) &&
    keys.every((key) => allowed.has(key))
  );
}

function explicitPath(value) {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    !value.startsWith('~') &&
    !value.includes('\0') &&
    isAbsolute(value)
  );
}

function within(root, path) {
  const rel = relative(root, path);
  return (
    rel !== '' &&
    rel !== '..' &&
    !rel.startsWith(`..${sep}`) &&
    !isAbsolute(rel)
  );
}

function digest(content) {
  return `sha256:${createHash('sha256').update(content, 'utf8').digest('hex')}`;
}

function validateRoot(root) {
  if (
    !(
      assertKeys(root, ['client', 'path']) &&
      CLIENTS.has(root.client) &&
      explicitPath(root.path)
    )
  ) {
    return null;
  }
  const path = resolve(root.path);
  if (path !== root.path) {
    return null;
  }
  return { client: root.client, path };
}

function validateTargetPath(client, targetPath, roots, observations) {
  if (!explicitPath(targetPath)) {
    return { code: 'PATH_INVALID' };
  }
  const path = resolve(targetPath);
  if (path !== targetPath) {
    return { code: 'PATH_NOT_NORMALIZED' };
  }
  const root = roots.find(
    (candidate) => candidate.client === client && within(candidate.path, path)
  );
  if (!root) {
    return { code: 'PATH_OUTSIDE_ALLOWED_ROOT' };
  }
  const observation = observations.find((row) => row.path === path) ?? null;
  if (
    !observation ||
    resolve(observation.realPath) !== observation.realPath ||
    !within(root.path, observation.realPath) ||
    observation.symlink !== false ||
    observation.ancestorSymlink !== false ||
    !['missing', 'regular-file'].includes(observation.kind)
  ) {
    return { code: 'PATH_OBSERVATION_UNSAFE' };
  }
  if (
    (observation.kind === 'missing' && observation.digest !== null) ||
    (observation.kind === 'regular-file' &&
      !DIGEST.test(observation.digest ?? ''))
  ) {
    return { code: 'OBSERVATION_INVALID' };
  }
  return { code: null, observation, root };
}

function receiptValid(receipt) {
  return (
    assertKeys(receipt, [
      'appliedEvidence',
      'client',
      'content',
      'digest',
      'path',
      'version',
    ]) &&
    assertKeys(
      receipt.appliedEvidence,
      ['state'],
      ['observedAt', 'operationId']
    ) &&
    CLIENTS.has(receipt.client) &&
    explicitPath(receipt.path) &&
    receipt.path === resolve(receipt.path) &&
    typeof receipt.version === 'string' &&
    receipt.version.length > 0 &&
    typeof receipt.content === 'string' &&
    DIGEST.test(receipt.digest ?? '') &&
    digest(receipt.content) === receipt.digest &&
    ['observed', 'pending-reconciliation'].includes(
      receipt.appliedEvidence.state
    )
  );
}

function currentHandshake(row, now) {
  return Boolean(
    row?.connected === true &&
      row?.transport === 'mcp' &&
      Number.isSafeInteger(row.observedAt) &&
      row.observedAt <= now &&
      now - row.observedAt <= MAX_HANDSHAKE_AGE_MS
  );
}

function handshakeStatuses(handshakes, desired, conflicts, now) {
  const result = {};
  for (const client of CLIENTS) {
    const clientDesired = desired.filter((file) => file.client === client);
    if (clientDesired.length === 0) {
      continue;
    }
    const observed = handshakes.find((row) => row.client === client) ?? null;
    const connected = currentHandshake(observed, now);
    const fresh = hasFreshActivation(connected, observed, clientDesired);
    const installed = clientDesired.every(
      (file) => file.observedApplied === true
    );
    const ownershipClear = conflicts.every(
      (conflict) => conflict.client !== client
    );
    result[client] = {
      connected: connected ? 'connected' : 'unknown',
      installed: installed ? 'installed' : 'not-verified',
      verified:
        fresh && installed && ownershipClear ? 'verified' : 'unverified',
    };
  }
  return result;
}

function hasFreshActivation(connected, observed, clientDesired) {
  return Boolean(
    connected &&
      observed.freshSession === true &&
      typeof observed.sessionId === 'string' &&
      observed.sessionId.length > 0 &&
      observed.sessionId !== observed.previousSessionId &&
      Array.isArray(observed.activatedDigests) &&
      clientDesired.every((file) =>
        observed.activatedDigests.includes(file.digest)
      )
  );
}

function validInputShape(input) {
  const lists = [
    'allowedRoots',
    'desiredFiles',
    'handshakes',
    'observations',
    'previousReceipts',
  ];
  return (
    assertKeys(input, [...lists, 'now']) &&
    lists.every((key) => Array.isArray(input[key]))
  );
}

function validateInput(input) {
  snapshot(input, { bytes: 0, nodes: 0 });
  const copied = structuredClone(input);
  const safe = snapshot(copied, { bytes: 0, nodes: 0 });
  if (
    !(validInputShape(safe) && Number.isSafeInteger(safe.now) && safe.now >= 0)
  ) {
    return {
      error: fail(
        'INPUT_INVALID',
        'Integration update inputs are incomplete or exceed supported bounds.'
      ),
    };
  }
  return { error: null, safe };
}

function validateRoots(allowedRoots) {
  const roots = allowedRoots.map(validateRoot);
  if (roots.length === 0 || roots.some((root) => root === null)) {
    return {
      error: fail(
        'ROOT_INVALID',
        'Candidate roots must be explicit normalized paths for supported clients.'
      ),
    };
  }
  return { error: null, roots };
}

function validateObservations(observations) {
  const paths = new Set();
  for (const observation of observations) {
    if (!isObservationValid(observation)) {
      return fail(
        'OBSERVATION_INVALID',
        'A filesystem observation is malformed.'
      );
    }
    if (paths.has(observation.path)) {
      return fail(
        'OBSERVATION_DUPLICATE',
        'An observed path appears more than once.'
      );
    }
    paths.add(observation.path);
  }
  return null;
}

function isObservationValid(observation) {
  return (
    assertKeys(observation, [
      'ancestorSymlink',
      'digest',
      'kind',
      'path',
      'realPath',
      'symlink',
    ]) &&
    explicitPath(observation.path) &&
    explicitPath(observation.realPath) &&
    ['missing', 'regular-file'].includes(observation.kind) &&
    typeof observation.symlink === 'boolean' &&
    typeof observation.ancestorSymlink === 'boolean' &&
    (observation.digest === null ||
      (typeof observation.digest === 'string' &&
        DIGEST.test(observation.digest)))
  );
}

function validateHandshakes(handshakes) {
  const clients = new Set();
  for (const row of handshakes) {
    if (
      !(
        assertKeys(
          row,
          ['client'],
          [
            'activatedDigests',
            'connected',
            'freshSession',
            'observedAt',
            'previousSessionId',
            'sessionId',
            'transport',
          ]
        ) && CLIENTS.has(row.client)
      )
    ) {
      return fail('HANDSHAKE_INVALID', 'A client handshake is malformed.');
    }
    if (clients.has(row.client)) {
      return fail(
        'HANDSHAKE_DUPLICATE',
        'A client has multiple handshake observations.'
      );
    }
    clients.add(row.client);
  }
  return null;
}

function validateReceipts(previousReceipts) {
  const receiptIds = new Set();
  const receiptPaths = new Map();
  for (const receipt of previousReceipts) {
    if (!receiptValid(receipt)) {
      return fail(
        'RECEIPT_INVALID',
        'A previous ownership receipt is malformed.'
      );
    }
    const key = `${receipt.client}\n${receipt.path}`;
    if (receiptIds.has(key)) {
      return fail(
        'RECEIPT_DUPLICATE',
        'An owned client path has multiple receipts.'
      );
    }
    const priorOwner = receiptPaths.get(receipt.path);
    if (priorOwner && priorOwner !== receipt.client) {
      return fail(
        'RECEIPT_CONFLICT',
        'A managed path has receipts for multiple clients.'
      );
    }
    receiptIds.add(key);
    receiptPaths.set(receipt.path, receipt.client);
  }
  return null;
}

function prepareDesired(desiredFiles, roots, observations) {
  const desired = [];
  const seen = new Set();
  const actualTargets = new Map();
  for (const file of desiredFiles) {
    if (
      !(
        assertKeys(file, ['client', 'content', 'path', 'version']) &&
        CLIENTS.has(file.client)
      ) ||
      typeof file.version !== 'string' ||
      file.version.length === 0 ||
      typeof file.content !== 'string'
    ) {
      return {
        error: fail(
          'DESIRED_FILE_INVALID',
          'Desired integration files must include client, version, and text content.'
        ),
      };
    }
    const target = validateTargetPath(
      file.client,
      file.path,
      roots,
      observations
    );
    if (target.code) {
      return {
        error: fail(
          target.code,
          'A desired integration path failed boundary verification.'
        ),
      };
    }
    const ownKey = `${file.client}\n${file.path}`;
    if (seen.has(ownKey)) {
      return {
        error: fail(
          'DESIRED_FILE_DUPLICATE',
          'A client path appears more than once.'
        ),
      };
    }
    seen.add(ownKey);
    const identityError = registerTargetIdentities(actualTargets, ownKey, [
      file.path,
      target.observation.realPath,
    ]);
    if (identityError) {
      return { error: identityError };
    }
    desired.push(makeDesiredFile(file, target.observation));
  }
  return { desired };
}

function registerTargetIdentities(actualTargets, ownKey, paths) {
  for (const path of paths) {
    const priorEntry = actualTargets.get(path);
    if (priorEntry && priorEntry !== ownKey) {
      return fail(
        'TARGET_IDENTITY_CONFLICT',
        'Distinct desired paths resolve to the same managed target.'
      );
    }
    actualTargets.set(path, ownKey);
  }
  return null;
}

function makeDesiredFile(file, observation) {
  const fileDigest = digest(file.content);
  return {
    client: file.client,
    content: file.content,
    digest: fileDigest,
    observedApplied:
      observation.kind === 'regular-file' && observation.digest === fileDigest,
    path: file.path,
    version: file.version,
  };
}

function prepareOperations(desired, observations, previousReceipts) {
  const operations = [];
  const conflicts = [];
  for (const file of desired) {
    const observation = observations.find((row) => row.path === file.path);
    const receipt =
      previousReceipts.find(
        (row) => row.client === file.client && row.path === file.path
      ) ?? null;
    const conflict = receiptConflict(
      file,
      observation,
      receipt,
      previousReceipts
    );
    if (conflict) {
      conflicts.push(conflict);
      continue;
    }
    operations.push(planFileOperation(file, receipt));
  }
  return { conflicts, operations };
}

function receiptConflict(file, observation, receipt, previousReceipts) {
  const wrongOwner = previousReceipts.some(
    (row) => row.path === file.path && row.client !== file.client
  );
  if (wrongOwner) {
    return {
      client: file.client,
      code: 'WRONG_CLIENT_RECEIPT',
      path: file.path,
    };
  }
  if (receipt?.appliedEvidence.state === 'pending-reconciliation') {
    return {
      client: file.client,
      code: 'RECONCILIATION_REQUIRED',
      path: file.path,
    };
  }
  if (!receipt && observation.kind === 'regular-file') {
    return { client: file.client, code: 'UNOWNED_COLLISION', path: file.path };
  }
  if (receipt && observation.kind !== 'regular-file') {
    return { client: file.client, code: 'OWNED_FILE_MISSING', path: file.path };
  }
  if (receipt && observation.digest !== receipt.digest) {
    return { client: file.client, code: 'OWNED_FILE_EDITED', path: file.path };
  }
  return null;
}

function planFileOperation(file, receipt) {
  let kind = 'create';
  if (receipt) {
    kind = 'update';
    if (receipt.digest === file.digest && receipt.version === file.version) {
      kind = 'no-op';
    }
  }
  return {
    client: file.client,
    digest: file.digest,
    kind,
    path: file.path,
    version: file.version,
  };
}

function buildPreviewBinding(file, observations, previousReceipts) {
  const { observation, receipt } = findPriorState(
    file,
    observations,
    previousReceipts
  );
  return {
    canonicalPath: observation.realPath,
    client: file.client,
    content: file.content,
    expectedPrevious: {
      observedDigest: observation.digest,
      observedKind: observation.kind,
      receipt: receipt ? receiptBinding(receipt) : null,
    },
    path: file.path,
    version: file.version,
  };
}

function findPriorState(file, observations, previousReceipts) {
  return {
    observation: observations.find((row) => row.path === file.path),
    receipt: previousReceipts.find(
      (row) => row.client === file.client && row.path === file.path
    ),
  };
}

function receiptBinding(receipt) {
  return {
    appliedEvidence: {
      operationId: receipt.appliedEvidence.operationId ?? null,
      state: receipt.appliedEvidence.state,
    },
    client: receipt.client,
    digest: receipt.digest,
    path: receipt.path,
    version: receipt.version,
  };
}

function comparePreviewBindings(left, right) {
  const leftKey = `${left.client}\n${left.path}`;
  const rightKey = `${right.client}\n${right.path}`;
  if (leftKey < rightKey) {
    return -1;
  }
  if (leftKey > rightKey) {
    return 1;
  }
  return 0;
}

function verificationStepsFor(desired) {
  return desired.map((file) => ({
    client: file.client,
    digest: file.digest,
    path: file.path,
    required: [
      'apply only after separate approval',
      'observe the exact installed file digest and record applied evidence',
      'start a new client session and confirm the exact integration activates',
    ],
    version: file.version,
  }));
}

function createPreview(safe) {
  const {
    allowedRoots,
    desiredFiles,
    handshakes,
    now,
    observations,
    previousReceipts,
  } = safe;
  const rootResult = validateRoots(allowedRoots);
  if (rootResult.error) {
    return rootResult.error;
  }
  const observationError = validateObservations(observations);
  if (observationError) {
    return observationError;
  }
  const handshakeError = validateHandshakes(handshakes);
  if (handshakeError) {
    return handshakeError;
  }
  const receiptError = validateReceipts(previousReceipts);
  if (receiptError) {
    return receiptError;
  }
  const desiredResult = prepareDesired(
    desiredFiles,
    rootResult.roots,
    observations
  );
  if (desiredResult.error) {
    return desiredResult.error;
  }
  const { desired } = desiredResult;
  const { conflicts, operations } = prepareOperations(
    desired,
    observations,
    previousReceipts
  );
  const previewBinding = desired
    .map((file) => buildPreviewBinding(file, observations, previousReceipts))
    .sort(comparePreviewBindings);
  const previewDigest = digest(JSON.stringify(previewBinding));
  const statuses = handshakeStatuses(handshakes, desired, conflicts, now);
  return freezeDto({
    conflicts,
    ok: conflicts.length === 0,
    operations: conflicts.length === 0 ? operations : [],
    previewDigest,
    previewOnly: true,
    statuses,
    verificationSteps: verificationStepsFor(desired),
  });
}

/** Build a bounded, read-only integration preview. No filesystem calls occur. */
export function planSpansIntegrationUpdate(input) {
  try {
    // structuredClone rejects Proxy objects; the descriptor walk first rejects accessors without invoking them.
    const validation = validateInput(input);
    if (validation.error) {
      return validation.error;
    }
    return createPreview(validation.safe);
  } catch {
    return fail(
      'INPUT_INVALID',
      'Integration update input could not be safely inspected.'
    );
  }
}
