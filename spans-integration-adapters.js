import { createHash } from 'node:crypto';
import { lstat, open, realpath } from 'node:fs/promises';
import { basename, dirname, isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { planSpansIntegrationUpdate } from './spans-integrations.js';

const MAX_SKILL_BYTES = 1024 * 1024;
const MAX_HANDSHAKE_AGE_MS = 5 * 60 * 1000;
const CLIENT_LAYOUTS = Object.freeze({
  claude: Object.freeze({
    directory: '.claude/skills',
    version: 'claude-skills-v1',
  }),
  codex: Object.freeze({
    directory: '.agents/skills',
    version: 'codex-skills-v1',
  }),
  cursor: Object.freeze({
    directory: '.agents/skills',
    owner: 'codex',
    version: 'codex-skills-v1',
  }),
});
const CURSOR_DISCOVERY_LAYOUTS = Object.freeze([
  '.agents/skills',
  '.claude/skills',
  '.codex/skills',
  '.cursor/skills',
]);

const fail = (code, error, extra = {}) => ({
  code,
  error,
  ok: false,
  ...extra,
});
const hash = (bytes) =>
  `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
const isClient = (client) =>
  typeof client === 'string' && Object.hasOwn(CLIENT_LAYOUTS, client);
function validAbsolute(path) {
  return (
    typeof path === 'string' &&
    path.length > 0 &&
    !path.includes('\0') &&
    isAbsolute(path) &&
    resolve(path) === path
  );
}

function artifactPath(home, skillsDirectory) {
  return resolve(home, skillsDirectory, 'setu-spans', 'SKILL.md');
}

async function inspectPath(
  path,
  { maxBytes = MAX_SKILL_BYTES, expected = 'file' } = {}
) {
  if (!validInspectRequest(path, maxBytes)) {
    return fail('PATH_INVALID', 'The observed path or byte limit is invalid.');
  }
  const ancestorCheck = await inspectAncestors(path);
  if (!ancestorCheck.ok) {
    return ancestorCheck.result;
  }
  if (ancestorCheck.missing) {
    return missingObservation(path);
  }
  let info;
  try {
    info = await lstat(path);
  } catch {
    return fail(
      'PATH_OBSERVATION_FAILED',
      'The requested path changed during inspection.'
    );
  }
  if (expected === 'directory') {
    return inspectDirectory(path, info);
  }
  if (!info.isFile()) {
    return fail(
      'ARTIFACT_NOT_REGULAR_FILE',
      'The exact artifact path is not a regular file.'
    );
  }
  if (info.size > maxBytes) {
    return fail(
      'ARTIFACT_TOO_LARGE',
      'The exact artifact exceeds the bounded read limit.'
    );
  }
  return inspectRegularFile(path, info, maxBytes);
}

function validInspectRequest(path, maxBytes) {
  return (
    validAbsolute(path) &&
    Number.isSafeInteger(maxBytes) &&
    maxBytes >= 1 &&
    maxBytes <= MAX_SKILL_BYTES
  );
}

function pathComponents(path) {
  const components = [];
  let current = path;
  while (resolve(current, '..') !== current) {
    components.push(current);
    current = resolve(current, '..');
  }
  components.push(current);
  return components.reverse();
}

async function inspectAncestors(path) {
  const results = await Promise.all(
    pathComponents(path).map(async (component) => {
      try {
        return { info: await lstat(component) };
      } catch (error) {
        return { errorCode: error?.code };
      }
    })
  );
  if (results.some((result) => result.info?.isSymbolicLink())) {
    return {
      ok: false,
      result: fail(
        'PATH_SYMLINK',
        'A path component is a symlink; the artifact is not safe to manage.'
      ),
    };
  }
  if (
    results.some((result) => result.errorCode && result.errorCode !== 'ENOENT')
  ) {
    return {
      ok: false,
      result: fail(
        'PATH_OBSERVATION_FAILED',
        'The requested path could not be inspected.'
      ),
    };
  }
  return {
    missing: results.some((result) => result.errorCode === 'ENOENT'),
    ok: true,
  };
}

function missingObservation(path) {
  return {
    observation: {
      ancestorSymlink: false,
      digest: null,
      kind: 'missing',
      path,
      realPath: path,
      symlink: false,
    },
    ok: true,
  };
}

async function inspectDirectory(path, info) {
  if (!info.isDirectory()) {
    return fail(
      'ROOT_NOT_DIRECTORY',
      'The exact skill root is not a directory.'
    );
  }
  try {
    if ((await realpath(path)) !== path) {
      return fail(
        'PATH_ESCAPE',
        'The exact skill root resolves outside its reviewed path.'
      );
    }
  } catch {
    return fail(
      'PATH_OBSERVATION_FAILED',
      'The exact skill root could not be resolved safely.'
    );
  }
  return {
    observation: { kind: 'directory', path, realPath: path, symlink: false },
    ok: true,
  };
}

function readBoundedBytes(handle, maxBytes) {
  return readBoundedChunk(handle, maxBytes, [], 0);
}

async function readBoundedChunk(handle, maxBytes, chunks, total) {
  if (total > maxBytes) {
    return null;
  }
  const chunk = Buffer.alloc(Math.min(64 * 1024, maxBytes + 1 - total));
  const { bytesRead } = await handle.read(chunk, 0, chunk.length, total);
  if (bytesRead === 0) {
    return Buffer.concat(chunks, total);
  }
  chunks.push(Buffer.from(chunk.subarray(0, bytesRead)));
  return readBoundedChunk(handle, maxBytes, chunks, total + bytesRead);
}

async function inspectRegularFile(path, info, maxBytes) {
  let handle;
  try {
    handle = await open(path, 'r');
    const opened = await handle.stat({ bigint: true });
    if (
      !opened.isFile() ||
      opened.dev !== BigInt(info.dev) ||
      opened.ino !== BigInt(info.ino) ||
      opened.size > BigInt(maxBytes)
    ) {
      return fail(
        'PATH_CHANGED',
        'The exact artifact changed during inspection.'
      );
    }
    const bytes = await readBoundedBytes(handle, maxBytes);
    if (bytes === null) {
      return fail(
        'ARTIFACT_TOO_LARGE',
        'The exact artifact exceeds the bounded read limit.'
      );
    }
    const after = await lstat(path, { bigint: true });
    const afterFd = await handle.stat({ bigint: true });
    if (
      !after.isFile() ||
      after.dev !== BigInt(info.dev) ||
      after.ino !== BigInt(info.ino) ||
      after.size !== BigInt(bytes.length) ||
      afterFd.dev !== opened.dev ||
      afterFd.ino !== opened.ino ||
      afterFd.size !== opened.size ||
      afterFd.mtimeNs !== opened.mtimeNs ||
      afterFd.ctimeNs !== opened.ctimeNs
    ) {
      return fail(
        'PATH_CHANGED',
        'The exact artifact changed during inspection.'
      );
    }
    const content = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    const canonicalPath = await realpath(path);
    if (canonicalPath !== path) {
      return fail(
        'PATH_ESCAPE',
        'The exact artifact resolves outside its reviewed path.'
      );
    }
    return {
      content,
      observation: {
        ancestorSymlink: false,
        digest: hash(bytes),
        kind: 'regular-file',
        path,
        realPath: canonicalPath,
        symlink: false,
      },
      ok: true,
    };
  } catch (error) {
    if (error instanceof TypeError) {
      return fail(
        'ARTIFACT_ENCODING_INVALID',
        'The exact artifact is not valid UTF-8 text.'
      );
    }
    return fail(
      'PATH_OBSERVATION_FAILED',
      'The exact artifact could not be read safely.'
    );
  } finally {
    await handle?.close().catch(() => {
      // Closing an invalidated read handle has no further recovery action.
    });
  }
}

/** Read one explicit canonical bundled skill file with a strict byte bound. */
export async function readBundledSpansSkill(sourcePath) {
  if (!validAbsolute(sourcePath)) {
    return fail(
      'SKILL_SOURCE_INVALID',
      'The bundled skill source must be an explicit normalized path.'
    );
  }
  const result = await inspectPath(sourcePath);
  if (!result.ok) {
    return { ...result, code: `SKILL_${result.code}` };
  }
  if (result.observation.kind !== 'regular-file') {
    return fail(
      'SKILL_SOURCE_MISSING',
      'The canonical bundled skill file is missing.'
    );
  }
  return {
    content: result.content,
    digest: result.observation.digest,
    ok: true,
  };
}

async function inspectBundledClaudePlugin(sourcePath, skillDigest) {
  const skillDirectory = dirname(sourcePath);
  const pluginRoot = resolve(skillDirectory, '../..');
  const manifestPath = resolve(pluginRoot, '.claude-plugin/plugin.json');
  if (
    basename(skillDirectory) !== 'setu-spans' ||
    basename(dirname(skillDirectory)) !== 'skills' ||
    basename(pluginRoot) !== 'claude-plugin'
  ) {
    return fail(
      'CLAUDE_PLUGIN_LAYOUT_INVALID',
      'The bundled skill is not at the canonical Claude plugin path.',
      { path: sourcePath }
    );
  }

  const manifest = await inspectPath(manifestPath, { maxBytes: 64 * 1024 });
  if (!manifest.ok) {
    return { ...manifest, code: `CLAUDE_PLUGIN_${manifest.code}` };
  }
  if (manifest.observation.kind !== 'regular-file') {
    return fail(
      'CLAUDE_PLUGIN_MANIFEST_MISSING',
      'The packaged Claude plugin manifest is missing.',
      { path: manifestPath }
    );
  }
  let metadata;
  try {
    metadata = JSON.parse(manifest.content);
  } catch {
    return fail(
      'CLAUDE_PLUGIN_MANIFEST_INVALID',
      'The packaged Claude plugin manifest is not valid JSON.',
      { path: manifestPath }
    );
  }
  if (metadata?.name !== 'setu') {
    return fail(
      'CLAUDE_PLUGIN_MANIFEST_INVALID',
      'The packaged Claude plugin manifest does not identify Setu.',
      { path: manifestPath }
    );
  }
  return {
    activation: {
      enabled: 'unverified',
      launch: 'unverified',
      registration: 'unverified',
    },
    available: true,
    launchPreview: {
      args: ['--plugin-dir', pluginRoot],
      executable: 'claude',
    },
    mcpConnection: 'unknown',
    ok: true,
    pluginName: metadata.name,
    pluginRoot,
    skillDigest,
    skillPath: sourcePath,
    source: 'packaged-plugin',
  };
}

function discoveryFor(client) {
  if (client === 'cursor') {
    return 'cursor-compatible-user-skill-roots';
  }
  if (client === 'claude') {
    return 'claude-standalone-compatibility-root';
  }
  return 'client-user-skill-root';
}

async function observeLayout(home, directory) {
  const root = resolve(home, directory);
  const path = artifactPath(home, directory);
  const rootResult = await inspectPath(root, { expected: 'directory' });
  if (!rootResult.ok) {
    return { ok: false, path: root, result: rootResult };
  }
  const artifactResult = await inspectPath(path);
  if (!artifactResult.ok) {
    return { ok: false, path, result: artifactResult };
  }
  return {
    artifactObservation: artifactResult.observation,
    directory,
    ok: true,
    rootObservation: rootResult.observation,
  };
}

/** Observe only exact candidate roots and the exact setu-spans artifact paths. */
export async function observeSpansClientAdapter({ client, home }) {
  if (!isClient(client)) {
    return fail(
      'CLIENT_INVALID',
      'The client must be codex, claude, or cursor.'
    );
  }
  const layout = CLIENT_LAYOUTS[client];
  if (!validAbsolute(home)) {
    return fail(
      'HOME_INVALID',
      'An explicit normalized home path is required.'
    );
  }
  try {
    if ((await realpath(home)) !== home) {
      return fail(
        'HOME_PATH_UNSAFE',
        'The explicit home path is symlinked or non-canonical.'
      );
    }
  } catch (error) {
    if (error.code !== 'ENOENT') {
      return fail(
        'HOME_OBSERVATION_FAILED',
        'The explicit home could not be inspected.'
      );
    }
  }

  const discoveryLayouts =
    client === 'cursor' ? CURSOR_DISCOVERY_LAYOUTS : [layout.directory];
  const observedLayouts = await Promise.all(
    discoveryLayouts.map((directory) => observeLayout(home, directory))
  );
  const failure = observedLayouts.find((result) => !result.ok);
  if (failure) {
    return { ...failure.result, client, path: failure.path };
  }
  const roots = observedLayouts.map(({ directory, rootObservation }) => ({
    directory,
    kind: rootObservation.kind,
    path: resolve(home, directory),
  }));
  const observations = observedLayouts.map(
    ({ artifactObservation }) => artifactObservation
  );
  const candidates = observedLayouts.map(
    ({ directory, artifactObservation }) => ({
      directory,
      ...artifactObservation,
    })
  );

  return {
    candidates,
    client,
    discovery: discoveryFor(client),
    observations,
    ok: true,
    roots,
    targetPath: artifactPath(home, layout.directory),
    targetRoot: resolve(home, layout.directory),
  };
}

function validClientSelection(clients) {
  return (
    Array.isArray(clients) &&
    clients.length > 0 &&
    clients.length <= SPANS_CLIENT_ADAPTERS.length &&
    new Set(clients).size === clients.length &&
    clients.every(isClient)
  );
}

function isCurrentHandshake(handshake, now) {
  return Boolean(
    handshake?.connected === true &&
      handshake.transport === 'mcp' &&
      Number.isSafeInteger(handshake.observedAt) &&
      handshake.observedAt <= now &&
      now - handshake.observedAt <= MAX_HANDSHAKE_AGE_MS
  );
}

function cursorStatus({
  bundledDigest,
  canonicalObservation,
  conflicts,
  handshakes,
  now,
  ownerConflicts,
}) {
  const handshake = handshakes.find((row) => row.client === 'cursor') ?? null;
  const connected = isCurrentHandshake(handshake, now);
  const duplicate = conflicts.some((row) => row.client === 'cursor');
  const ownedAndCurrent =
    !ownerConflicts &&
    canonicalObservation?.kind === 'regular-file' &&
    canonicalObservation.digest === bundledDigest;
  const fresh = Boolean(
    connected &&
      handshake.freshSession === true &&
      typeof handshake.sessionId === 'string' &&
      handshake.sessionId.length > 0 &&
      handshake.sessionId !== handshake.previousSessionId &&
      Array.isArray(handshake.activatedDigests) &&
      handshake.activatedDigests.includes(bundledDigest)
  );
  return {
    connected: connected ? 'connected' : 'unknown',
    installed: ownedAndCurrent && !duplicate ? 'installed' : 'not-verified',
    verified:
      ownedAndCurrent && fresh && !duplicate ? 'verified' : 'unverified',
  };
}

function cursorDuplicatePaths({
  clients,
  cursorObservation,
  home,
  removeClient,
}) {
  if (
    (!clients.includes('cursor') && removeClient !== 'cursor') ||
    !cursorObservation
  ) {
    return [];
  }
  const canonicalPath = artifactPath(home, CLIENT_LAYOUTS.codex.directory);
  const paths = new Set(
    cursorObservation.candidates
      .filter(
        (candidate) =>
          candidate.path !== canonicalPath && candidate.kind === 'regular-file'
      )
      .map((candidate) => candidate.path)
  );
  const canonicalCandidate = cursorObservation.candidates.find(
    ({ path }) => path === canonicalPath
  );
  if (
    removeClient === 'cursor' &&
    canonicalCandidate?.kind === 'regular-file'
  ) {
    paths.add(canonicalPath);
  }
  return [...paths].sort();
}

function conflictReviewFor({
  duplicatePaths,
  removeClient,
  standaloneConflict,
}) {
  const affectedPaths = [
    ...new Set([
      ...duplicatePaths,
      ...(standaloneConflict ? [standaloneConflict.path] : []),
    ]),
  ].sort();
  if (affectedPaths.length === 0) {
    return null;
  }
  const clients = [
    ...(standaloneConflict ? ['claude'] : []),
    ...(duplicatePaths.length > 0 ? ['cursor'] : []),
  ];
  const reasons = [];
  if (standaloneConflict) {
    reasons.push(
      'An existing standalone Claude skill is outside this preview’s ownership; inspect it separately before proceeding.'
    );
  }
  if (duplicatePaths.length > 0) {
    reasons.push(
      'Cursor documents these skill roots but no per-source precedence or exclusion. No native setting change is proposed.'
    );
  }
  return {
    clients,
    ...(removeClient === 'cursor'
      ? { disposition: 'cursor-access-cannot-be-revoked-by-this-preview' }
      : {}),
    affectedPaths,
    reason: reasons.join(' '),
    status: 'requires-separate-review',
  };
}

function standaloneClaudeConflict(claudeObservation, clients) {
  if (!(clients.includes('claude') && claudeObservation)) {
    return null;
  }
  const candidate = claudeObservation.candidates.find(
    ({ path }) => path === claudeObservation.targetPath
  );
  return candidate?.kind === 'regular-file'
    ? {
        client: 'claude',
        code: 'STANDALONE_CLAUDE_COPY_REQUIRES_REVIEW',
        path: candidate.path,
      }
    : null;
}

function observationClientsFor(effectiveClients, removeClient) {
  return [
    ...(effectiveClients.includes('codex') ||
    effectiveClients.includes('cursor')
      ? ['codex']
      : []),
    ...(effectiveClients.includes('claude') ? ['claude'] : []),
    ...(effectiveClients.includes('cursor') || removeClient === 'cursor'
      ? ['cursor']
      : []),
  ];
}

async function observeClients(clients, home) {
  const rows = await Promise.all(
    clients.map(async (client) => ({
      client,
      observed: await observeSpansClientAdapter({ client, home }),
    }))
  );
  const failure = rows.find((row) => !row.observed.ok);
  if (failure) {
    return { error: failure.observed };
  }
  return {
    error: null,
    observations: Object.fromEntries(
      rows.map(({ client, observed }) => [client, observed])
    ),
  };
}

function ownerClientsFor(effectiveClients) {
  return [
    ...(effectiveClients.includes('codex') ||
    effectiveClients.includes('cursor')
      ? ['codex']
      : []),
  ];
}

function previewOwnedArtifacts({
  bundled,
  handshakes,
  now,
  observations,
  ownerClients,
  previousReceipts,
}) {
  const desiredFiles = ownerClients.map((client) => {
    const { targetPath } = observations[client];
    return {
      client,
      content: bundled.content,
      path: targetPath,
      version: CLIENT_LAYOUTS[client].version,
    };
  });
  const plannerObservations = ownerClients.flatMap((client) => {
    const observed = observations[client];
    return observed.observations.filter(
      ({ path }) => path === observed.targetPath
    );
  });
  const allowedRoots = ownerClients.length
    ? ownerClients.map((client) => ({
        client,
        path: observations[client].targetRoot,
      }))
    : [{ client: 'claude', path: observations.claude.targetRoot }];
  return planSpansIntegrationUpdate({
    allowedRoots,
    desiredFiles,
    handshakes,
    now,
    observations: plannerObservations,
    previousReceipts,
  });
}

function uniqueConflicts(conflicts) {
  return [
    ...new Map(
      conflicts.map((conflict) => [
        `${conflict.client}\n${conflict.code}\n${conflict.path}`,
        conflict,
      ])
    ).values(),
  ];
}

function cursorConflictsFor(duplicatePaths, canonicalPath, removeClient) {
  return duplicatePaths.map((path) => ({
    client: 'cursor',
    code:
      removeClient === 'cursor' && path === canonicalPath
        ? 'CURSOR_ACCESS_REQUIRES_SEPARATE_REVIEW'
        : 'DISCOVERY_COLLISION',
    path,
  }));
}

function artifactPlansFor(ownerClients, effectiveClients, observations) {
  return ownerClients.map((client) => ({
    client,
    consumers: artifactConsumersFor(effectiveClients),
    path: observations[client].targetPath,
  }));
}

function artifactConsumersFor(effectiveClients) {
  return ['codex', 'cursor'].filter((consumer) =>
    effectiveClients.includes(consumer)
  );
}

function cursorSharedOwnerConflict(effectiveClients, preview, canonicalPath) {
  if (
    !effectiveClients.includes('cursor') ||
    effectiveClients.includes('codex')
  ) {
    return null;
  }
  const ownerOperation = preview.operations?.find(
    (operation) =>
      operation.client === 'codex' &&
      operation.path === canonicalPath &&
      operation.kind === 'no-op'
  );
  const ownerConflict = preview.conflicts.some(
    (conflict) => conflict.path === canonicalPath
  );
  return ownerOperation && !ownerConflict
    ? null
    : {
        client: 'cursor',
        code: 'SHARED_ARTIFACT_REUSE_REQUIRES_VERIFIED_CODEX_OWNER',
        path: canonicalPath,
      };
}

function augmentGroupPreview({
  bundled,
  clients,
  cursorObservation,
  effectiveClients,
  handshakes,
  home,
  now,
  preview,
  removeClient,
  standaloneConflict,
}) {
  const canonicalPath = artifactPath(home, CLIENT_LAYOUTS.codex.directory);
  const sharedOwnerConflict = cursorSharedOwnerConflict(
    effectiveClients,
    preview,
    canonicalPath
  );
  const duplicatePaths = cursorDuplicatePaths({
    clients: effectiveClients,
    cursorObservation,
    home,
    removeClient,
  });
  const conflicts = uniqueConflicts([
    ...preview.conflicts,
    ...(standaloneConflict ? [standaloneConflict] : []),
    ...(sharedOwnerConflict ? [sharedOwnerConflict] : []),
    ...cursorConflictsFor(duplicatePaths, canonicalPath, removeClient),
  ]);
  const statuses = { ...preview.statuses };
  for (const client of Object.keys(statuses)) {
    if (!effectiveClients.includes(client)) {
      delete statuses[client];
    }
  }
  if (effectiveClients.includes('cursor')) {
    const canonicalObservation =
      cursorObservation.candidates.find(
        (candidate) => candidate.path === canonicalPath
      ) ?? null;
    statuses.cursor = cursorStatus({
      bundledDigest: bundled.digest,
      canonicalObservation,
      conflicts,
      handshakes,
      now,
      ownerConflicts: preview.conflicts.some(
        (conflict) => conflict.path === canonicalPath
      ),
    });
  }
  const conflictReview = conflictReviewFor({
    duplicatePaths,
    removeClient,
    standaloneConflict,
  });
  const retainedArtifacts =
    removeClient === 'cursor' && clients.includes('codex')
      ? [{ owner: 'codex', path: canonicalPath, retainedFor: ['codex'] }]
      : [];
  const verificationSteps = [...(preview.verificationSteps ?? [])];
  if (effectiveClients.includes('cursor')) {
    verificationSteps.push({
      client: 'cursor',
      digest: bundled.digest,
      path: canonicalPath,
      required: [
        'use the verified Codex-owned artifact discovered under .agents/skills',
        'start a new Cursor session and confirm that exact digest activates',
      ],
      version: CLIENT_LAYOUTS.codex.version,
    });
  }
  const finalPreview = {
    ...preview,
    conflicts,
    ok: conflicts.length === 0,
    operations: conflicts.length === 0 ? preview.operations : [],
    statuses,
    verificationSteps,
  };
  return { conflictReview, finalPreview, retainedArtifacts };
}

function groupDigestFor({
  artifactPlans,
  clients,
  clientSources,
  cursorObservation,
  preview,
  removeClient,
  conflictReview,
  sourceDigest,
}) {
  return hash(
    Buffer.from(
      JSON.stringify({
        artifactPlans,
        clientSources,
        clients,
        conflictReview,
        conflicts: preview.conflicts,
        cursorCandidates: (cursorObservation?.candidates ?? []).map(
          ({ digest: candidateDigest, kind, path }) => ({
            digest: candidateDigest ?? null,
            kind,
            path,
          })
        ),
        previewDigest: preview.previewDigest ?? null,
        removeClient,
        sourceDigest,
      }),
      'utf8'
    )
  );
}

/** Preview physical artifacts for a client group once, without writing. */
export async function previewSpansClientGroup({
  clients = SPANS_CLIENT_ADAPTERS,
  home,
  skillSourcePath = fileURLToPath(
    new URL('./claude-plugin/skills/setu-spans/SKILL.md', import.meta.url)
  ),
  previousReceipts = [],
  handshakes = [],
  now = Date.now(),
  removeClient = null,
}) {
  if (!validClientSelection(clients)) {
    return fail(
      'CLIENTS_INVALID',
      'Clients must be a non-empty unique selection of codex, claude, and cursor.'
    );
  }
  if (removeClient !== null && !isSupportedRemoval(clients, removeClient)) {
    return fail(
      'CLIENT_REMOVAL_UNSUPPORTED',
      'Only a requested Cursor consumer can be reviewed for removal.'
    );
  }
  const effectiveClients = clients.filter((client) => client !== removeClient);
  if (effectiveClients.length === 0) {
    return fail(
      'CLIENTS_INVALID',
      'A client group must retain at least one consumer.'
    );
  }

  const { error: observationError, observations } = await observeClients(
    observationClientsFor(effectiveClients, removeClient),
    home
  );
  if (observationError) {
    return observationError;
  }
  const bundled = await readBundledSpansSkill(skillSourcePath);
  if (!bundled.ok) {
    return bundled;
  }
  const ownerClients = ownerClientsFor(effectiveClients);
  const preview = previewOwnedArtifacts({
    bundled,
    handshakes,
    now,
    observations,
    ownerClients,
    previousReceipts,
  });
  if (!(preview && Array.isArray(preview.conflicts))) {
    return {
      clients: effectiveClients,
      observations,
      ok: false,
      preview,
      previewOnly: true,
      sourceDigest: bundled.digest,
    };
  }

  const clientSources = {};
  if (effectiveClients.includes('claude')) {
    const claudePlugin = await inspectBundledClaudePlugin(
      skillSourcePath,
      bundled.digest
    );
    if (!claudePlugin.ok) {
      return claudePlugin;
    }
    clientSources.claude = {
      ...claudePlugin,
      mcpConnection: 'unknown',
    };
  }

  const cursorObservation = observations.cursor ?? null;
  const standaloneConflict = standaloneClaudeConflict(
    observations.claude,
    effectiveClients
  );
  const { conflictReview, finalPreview, retainedArtifacts } =
    augmentGroupPreview({
      bundled,
      clients,
      cursorObservation,
      effectiveClients,
      handshakes,
      home,
      now,
      preview,
      removeClient,
      standaloneConflict,
    });
  const artifactPlans = artifactPlansFor(
    ownerClients,
    effectiveClients,
    observations
  );
  const groupDigest = groupDigestFor({
    artifactPlans,
    clientSources,
    clients: effectiveClients,
    conflictReview,
    cursorObservation,
    preview: finalPreview,
    removeClient,
    sourceDigest: bundled.digest,
  });
  return {
    artifactPlans,
    clientSources,
    clients: effectiveClients,
    conflictReview,
    discovery: cursorObservation?.discovery ?? null,
    groupDigest,
    observations,
    ok: finalPreview.ok,
    preview: finalPreview,
    previewOnly: true,
    removeClient,
    retainedArtifacts,
    settingsPlan: null,
    sourceDigest: bundled.digest,
  };
}

function isSupportedRemoval(clients, removeClient) {
  return removeClient === 'cursor' && clients.includes(removeClient);
}

/** Preview one client while sharing its canonical physical artifact when possible. */
export async function previewSpansClientAdapter({ client, ...options }) {
  if (!isClient(client)) {
    return fail(
      'CLIENT_INVALID',
      'The client must be codex, claude, or cursor.'
    );
  }
  const result = await previewSpansClientGroup({
    ...options,
    clients: [client],
  });
  if (!(result.ok || result.preview)) {
    return result;
  }
  const observation = result.observations[client] ?? result.observations.codex;
  const clientSource = result.clientSources?.[client] ?? null;
  return {
    artifactPlans: result.artifactPlans,
    client,
    clientSource,
    conflictReview: result.conflictReview,
    discovery: result.discovery ?? observation.discovery,
    groupDigest: result.groupDigest,
    layout: clientSource ? null : observation.targetPath,
    observation,
    ok: result.ok,
    preview: result.preview,
    previewOnly: true,
    retainedArtifacts: result.retainedArtifacts,
    settingsPlan: result.settingsPlan,
    sourceDigest: result.sourceDigest,
  };
}

export const SPANS_CLIENT_ADAPTERS = Object.freeze(Object.keys(CLIENT_LAYOUTS));
