import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { isAbsolute, join, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import {
  lstat,
  readdir,
  readFile,
  realpath,
  stat,
} from './dependency-readiness-checkpoint.js';
import { assertStorageHeadroom } from './host-health.js';

const exec = promisify(execFile);
const VERSION = '1.3.14';
const SHA256 = /^[a-f0-9]{64}$/;
const DISPOSABLE_PATH =
  /(?:^|\/)(?:node_modules|\.git|\.bun-cache|cache|caches|tmp|temp)(?:\/|$)/i;
const BUNFIG_COMMENT = /\s+#.*$/;
const BUNFIG_INSTALL_SECTION = /^\[install\]$/;
const BUNFIG_LINES = /\r?\n/;
const BUNFIG_LINKER = /^linker\s*=\s*["'](hoisted|isolated)["']\s*$/;
const BUNFIG_SECTION = /^\[.+\]$/;

const CENTRAL_SHAPE_KEYS = [
  'enabled',
  'storeRoot',
  'executable',
  'version',
  'targets',
];

// Shared by selection and install time so the rules live in one place.
function assertValidSharingFields(sharing) {
  if (
    sharing.enabled !== true ||
    sharing.version !== VERSION ||
    typeof sharing.executable !== 'string' ||
    !isAbsolute(sharing.executable) ||
    typeof sharing.storeRoot !== 'string' ||
    !isAbsolute(sharing.storeRoot) ||
    typeof sharing.workspaceRoot !== 'string' ||
    !isAbsolute(sharing.workspaceRoot)
  ) {
    throw new Error(
      'Dependency sharing requires explicit Bun 1.3.14 and absolute executable/storeRoot/workspaceRoot paths'
    );
  }
}

function namespaceFor(runtime) {
  return `${runtime[1]}-${runtime[2]}-bun-${runtime[0]}`;
}

function configuredVolumeIdentity(sharing) {
  const identity = sharing.storeIdentity;
  if (
    !(identity && Number.isSafeInteger(identity.device)) ||
    identity.device < 0 ||
    typeof identity.mountPath !== 'string' ||
    !isAbsolute(identity.mountPath)
  ) {
    throw new Error(
      'Dependency sharing requires a configured volume identity with device and canonical mountPath'
    );
  }
  return identity;
}

async function inspectStoreRoot(root, sharing) {
  const identity = configuredVolumeIdentity(sharing);
  let rootInfo, canonicalRoot;
  try {
    rootInfo = await lstat(root);
    canonicalRoot = await realpath(root);
  } catch (cause) {
    throw new Error(
      'Dependency store root is missing or unavailable; no fallback store was created',
      { cause }
    );
  }
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) {
    throw new Error(
      'Dependency store must be a private, owned directory without symlinks'
    );
  }
  let mountPath, mountInfo;
  try {
    mountPath = await realpath(identity.mountPath);
    mountInfo = await stat(mountPath);
  } catch (cause) {
    throw new Error(
      'Dependency store configured volume is missing or unavailable',
      {
        cause,
      }
    );
  }
  if (
    mountPath !== identity.mountPath ||
    mountInfo.dev !== identity.device ||
    rootInfo.dev !== identity.device
  ) {
    throw new Error('Dependency store is not on its configured volume');
  }
  return { canonicalRoot, rootInfo };
}

async function assertPrivateDirectory(path) {
  const info = await lstat(path);
  if (
    !info.isDirectory() ||
    info.uid !== process.getuid() ||
    info.mode % 0o1000 !== 0o700 ||
    (await realpath(path)) !== path
  ) {
    throw new Error(
      'Dependency store must be a private, owned directory without symlinks'
    );
  }
  return info;
}

function assertStoreOutsideWorkspace(canonicalRoot, workspace) {
  if (
    DISPOSABLE_PATH.test(canonicalRoot) ||
    canonicalRoot === workspace ||
    canonicalRoot.startsWith(workspace + sep) ||
    workspace.startsWith(canonicalRoot + sep)
  ) {
    throw new Error(
      'Dependency store must be outside checkouts and outside the managed workspace'
    );
  }
}

async function configuredLinker(checkout) {
  let text;
  try {
    text = await readFile(join(checkout, 'bunfig.toml'), 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') {
      return null;
    }
    throw error;
  }
  let install = false;
  for (const raw of text.split(BUNFIG_LINES)) {
    const line = raw.replace(BUNFIG_COMMENT, '').trim();
    if (BUNFIG_INSTALL_SECTION.test(line)) {
      install = true;
      continue;
    }
    if (BUNFIG_SECTION.test(line)) {
      install = false;
      continue;
    }
    if (install) {
      const match = BUNFIG_LINKER.exec(line);
      if (match) {
        return match[1];
      }
    }
  }
  return null;
}

function consumerFor(checkout, sharing) {
  const consumers = sharing?.consumers;
  if (Array.isArray(consumers)) {
    return consumers.find((row) => row?.checkout === checkout) ?? null;
  }
  return consumers?.[checkout] ?? null;
}

function linkerIncompatibility(linker) {
  const setting = linker ? `linker = "${linker}"` : 'no explicit linker';
  return Object.assign(
    new Error(
      `Installed-package sharing requires [install] linker = "isolated". This project has ${setting}; Bun's global virtual store only supports isolated linking. Keep this checkout on an ordinary install by setting its dependencySharing target to false, or complete an approved isolated-linker compatibility pilot.`
    ),
    { code: 'DEPENDENCY_LINKER_INCOMPATIBLE' }
  );
}

async function lockfileHash(checkout) {
  return createHash('sha256')
    .update(await readFile(join(checkout, 'bun.lock')))
    .digest('hex');
}

async function consumerMatches(checkout, consumer, linker) {
  return (
    consumer &&
    consumer.bunVersion === VERSION &&
    consumer.checkout === checkout &&
    consumer.linkerMode === linker &&
    consumer.platformNamespace === `darwin-arm64-bun-${VERSION}` &&
    consumer.lockfileHash === (await lockfileHash(checkout))
  );
}

function hoistedInstallEnvironment() {
  const { BUN_INSTALL_GLOBAL_STORE: _globalStore, ...env } = process.env;
  return env;
}

async function dependencyInstallPlan(
  wtDir,
  sharing,
  {
    allowExistingView = false,
    assertStoreStorage = assertStorageHeadroom,
    createStore = true,
  } = {}
) {
  assertValidSharingFields(sharing);
  const checkout = await realpath(wtDir);
  const root = resolve(sharing.storeRoot);
  if (DISPOSABLE_PATH.test(root)) {
    throw new Error(
      'Dependency store must be outside checkouts and disposable cache/temp directories'
    );
  }
  const workspace = await realpath(sharing.workspaceRoot);
  const { canonicalRoot } = await inspectStoreRoot(root, sharing);
  if (!checkout.startsWith(workspace + sep)) {
    throw new Error('Checkout must belong to the configured managed workspace');
  }
  assertStoreOutsideWorkspace(canonicalRoot, workspace);
  await assertPrivateDirectory(root);
  const linker = await configuredLinker(checkout);
  const hoisted = linker === 'hoisted';
  if (linker !== 'isolated' && !hoisted) {
    throw linkerIncompatibility(linker);
  }
  if (hoisted && allowExistingView) {
    throw Object.assign(
      new Error(
        'An existing hoisted dependency view requires a separately reviewed conversion; setup never adopts it'
      ),
      { code: 'DEPENDENCY_VIEW_NOT_MANAGED' }
    );
  }
  if (!allowExistingView) {
    // lstat also rejects dangling dependency-view symlinks; never convert a view.
    const view = await lstat(join(checkout, 'node_modules')).catch((error) => {
      if (error.code === 'ENOENT') {
        return null;
      }
      throw error;
    });
    if (view) {
      throw new Error(
        'Dependency sharing requires a fresh checkout without node_modules; migration is not automatic'
      );
    }
  }
  const lock = await lstat(join(checkout, 'bun.lock'));
  if (!lock.isFile() || lock.isSymbolicLink()) {
    throw new Error('Dependency sharing requires a regular bun.lock file');
  }
  const lockHash = await lockfileHash(checkout);
  const executable = await realpath(sharing.executable);
  const { stdout } = await exec(
    executable,
    [
      '-e',
      'console.log(JSON.stringify([Bun.version, process.platform, process.arch]))',
    ],
    { cwd: root, maxBuffer: 4096, timeout: 5000 }
  );
  const runtime = JSON.parse(stdout.trim());
  if (
    JSON.stringify(runtime) !== JSON.stringify([VERSION, 'darwin', 'arm64'])
  ) {
    throw new Error(
      'Dependency sharing is tested only with Bun 1.3.14 on darwin-arm64'
    );
  }
  await assertStoreStorage(root);
  const platformNamespace = namespaceFor(runtime);
  const store = join(root, platformNamespace);
  if (!hoisted && createStore) {
    await mkdir(store, { mode: 0o700 }).catch((error) => {
      if (error.code !== 'EEXIST') {
        throw error;
      }
    });
    await assertPrivateDirectory(store);
    await assertStoreStorage(store);
  }
  if (hoisted) {
    return {
      bunVersion: runtime[0],
      command: [
        executable,
        ['install', '--frozen-lockfile', '--linker', 'hoisted'],
      ],
      env: hoistedInstallEnvironment(),
      linker,
      lockfileHash: lockHash,
      mode: 'hoisted-cow',
      namespace: `hoisted/${platformNamespace}`,
      strategy: 'hoisted-cow',
    };
  }
  const installArgs = [
    'install',
    '--frozen-lockfile',
    ...(linker ? ['--linker', linker] : []),
    '--backend',
    'copyfile',
    '--cache-dir',
    store,
  ];
  const command = [executable, installArgs];
  return {
    bunVersion: runtime[0],
    command,
    env: {
      ...process.env,
      BUN_INSTALL_CACHE_DIR: store,
      ...(linker === 'isolated' ? { BUN_INSTALL_GLOBAL_STORE: '1' } : {}),
    },
    linker: linker ?? 'project-default',
    lockfileHash: lockHash,
    mode: 'isolated',
    namespace: namespaceFor(runtime),
  };
}

// Targets select participation; store and installer settings are central.
export function dependencySharingForTarget(config, repo, name) {
  const key = `${repo}/${name}`;
  const central = config?.dependencySharing;
  if (central === undefined) {
    return;
  }
  if (!central || typeof central !== 'object' || Array.isArray(central)) {
    throw new Error('dependencySharing config must be an object');
  }
  if (Object.hasOwn(central, key)) {
    throw new Error(
      `Legacy per-target dependencySharing policy for "${key}" is no longer supported. ` +
        'Move storeRoot/executable/version to one central config and opt the target in, e.g. ' +
        `{ dependencySharing: { enabled: true, storeRoot, executable, version, targets: { "${key}": true } } }.`
    );
  }
  if (!CENTRAL_SHAPE_KEYS.some((k) => Object.hasOwn(central, k))) {
    return;
  }
  const enabled = Object.hasOwn(central, 'enabled')
    ? central.enabled
    : undefined;
  if (enabled === false) {
    return;
  }
  if (enabled !== true) {
    throw new Error('dependencySharing.enabled must be true or false');
  }
  if (!Object.hasOwn(central, 'targets')) {
    throw new Error(
      'dependencySharing.targets is required when enabled is true'
    );
  }
  const { targets } = central;
  if (!targets || typeof targets !== 'object' || Array.isArray(targets)) {
    throw new Error(
      'dependencySharing.targets must be an object mapping "repo/name" to true'
    );
  }
  // "<repo>/*" opts in every worktree of a repo, including ones created later;
  // an exact "<repo>/<name>" entry still wins, so false opts one out.
  const wildcard = `${repo}/*`;
  const matched = Object.hasOwn(targets, key)
    ? key
    : Object.hasOwn(targets, wildcard) && wildcard;
  if (!matched) {
    return;
  }
  const opt = targets[matched];
  if (opt === false) {
    return;
  }
  if (opt !== true) {
    throw new Error(
      `Per-target dependency-sharing overrides are not supported for "${matched}"; ` +
        `storeRoot/executable/version are central-only. Set targets["${matched}"] to true to opt in.`
    );
  }
  const resolved = {
    enabled: true,
    executable: central.executable,
    storeRoot: central.storeRoot,
    version: central.version,
    workspaceRoot: config.workspace,
    ...(Object.hasOwn(central, 'storeIdentity')
      ? { storeIdentity: central.storeIdentity }
      : {}),
  };
  assertValidSharingFields(resolved);
  return resolved;
}

function disabledReasonForTarget(config, repo, name) {
  const sharing = config?.dependencySharing;
  if (sharing === undefined) {
    return 'Setu has no dependencySharing configuration; sharing is not configured.';
  }
  if (Object.hasOwn(sharing, 'enabled') && sharing.enabled === false) {
    return 'Dependency sharing is explicitly disabled in Setu configuration.';
  }
  if (
    Object.hasOwn(sharing, 'enabled') &&
    sharing.enabled === true &&
    Object.hasOwn(sharing, 'targets') &&
    sharing.targets &&
    typeof sharing.targets === 'object' &&
    !Array.isArray(sharing.targets) &&
    (Object.hasOwn(sharing.targets, `${repo}/${name}`)
      ? sharing.targets[`${repo}/${name}`] === false
      : sharing.targets[`${repo}/*`] === false)
  ) {
    return 'This worktree is explicitly opted out of dependency sharing.';
  }
  return 'This worktree has no enabled dependency-sharing target.';
}

// Explain a disabled status without changing the checkout or treating the
// existence of node_modules as evidence that its layout is share-compatible.
export async function dependencySharingDisabledReason(
  config,
  repo,
  name,
  checkout
) {
  const sharing = dependencySharingForTarget(config, repo, name);
  if (sharing?.enabled) {
    return;
  }

  let reason = disabledReasonForTarget(config, repo, name);
  let linker;
  try {
    linker = await configuredLinker(checkout);
  } catch {
    linker = undefined;
  }
  if (linker === 'hoisted') {
    reason +=
      ' Its bunfig.toml explicitly selects linker = "hoisted". Fresh Setu setup can enroll this linker after its ordinary frozen install; an existing node_modules view is not adopted automatically.';
  } else if (linker === 'isolated') {
    reason +=
      ' Its bunfig.toml selects linker = "isolated", but that does not enable sharing or verify the installed view.';
  } else if (linker === null) {
    reason +=
      ' No explicit Bun linker was observed, so sharing compatibility remains unknown.';
  } else {
    reason +=
      ' The project linker setting could not be read, so sharing compatibility remains unknown.';
  }

  try {
    await lstat(join(checkout, 'node_modules'));
    reason +=
      ' An existing node_modules entry is present and will be left unchanged; its presence alone does not establish shared-store compatibility.';
  } catch (error) {
    if (error.code !== 'ENOENT') {
      reason +=
        ' The existing dependency view could not be inspected, so its state remains unknown.';
    }
  }
  return reason;
}

// Experimental host-only opt-in. A store is live dependency data, never a
// disposable package cache. Provision its private root outside worktrees.
async function refreshDependencyInstallPlan(
  wtDir,
  sharing,
  assertStoreStorage
) {
  assertValidSharingFields(sharing);
  const view = await inspectDependencyView(wtDir, sharing);
  if (!(view.ok === true && view.state === 'shared and healthy')) {
    throw Object.assign(
      new Error(
        'Dependency refresh requires a healthy Setu-owned shared view; unmanaged or replaced views are never converted'
      ),
      { code: 'DEPENDENCY_VIEW_UNSAFE' }
    );
  }
  return dependencyInstallPlan(wtDir, sharing, {
    allowExistingView: true,
    assertStoreStorage,
    createStore: false,
  });
}

export function sharedDependencyInstall(
  wtDir,
  sharing,
  assertStoreStorage = assertStorageHeadroom,
  { refreshOwnedView = false } = {}
) {
  if (!sharing?.enabled) {
    return null;
  }
  if (refreshOwnedView === true) {
    return refreshDependencyInstallPlan(wtDir, sharing, assertStoreStorage);
  }
  return dependencyInstallPlan(wtDir, sharing, { assertStoreStorage });
}

async function inspectIsolatedView(virtualStore, expected, consumer) {
  let directory;
  try {
    directory = await lstat(virtualStore);
  } catch (error) {
    if (error.code === 'ENOENT') {
      return {
        state: consumer
          ? 'shared but replaced by an ordinary install'
          : 'ordinary',
      };
    }
    throw error;
  }
  if (!directory.isDirectory() || directory.isSymbolicLink()) {
    return { state: 'unknown' };
  }
  const entries = await readdir(virtualStore, { withFileTypes: true });
  const links = entries.filter((entry) => entry.isSymbolicLink());
  if (!links.length) {
    return {
      state: consumer
        ? 'shared but replaced by an ordinary install'
        : 'ordinary',
    };
  }
  const targets = await Promise.all(
    links.map(async (link) => {
      try {
        const target = await realpath(join(virtualStore, link.name));
        return (await stat(target)).isDirectory() ? target : false;
      } catch (error) {
        if (error.code === 'ENOENT' || error.code === 'ENOTDIR') {
          return null;
        }
        throw error;
      }
    })
  );
  if (targets.some((target) => target === null)) {
    return { state: 'dangling' };
  }
  if (
    !targets.every(
      (target) =>
        typeof target === 'string' && target.startsWith(expected + sep)
    )
  ) {
    return { state: 'unknown' };
  }
  const hasLocalData = entries.some(
    (entry) => entry.name !== 'node_modules' && !entry.isSymbolicLink()
  );
  return {
    reason: hasLocalData
      ? 'Observed top-level virtual-store links resolve beneath the configured store namespace, and some dependency data remains local. Package contents and complete dependency closure are not verified. Disk savings are not measured by this check.'
      : 'Observed top-level virtual-store links resolve beneath the configured store namespace. Package contents and complete dependency closure are not verified. Disk savings are not measured by this check.',
    state: 'shared and healthy',
  };
}

export async function inspectDependencyView(checkout, sharing) {
  let canonical;
  try {
    assertValidSharingFields(sharing);
    canonical = await realpath(checkout);
  } catch (error) {
    return {
      ok: true,
      state: error.code === 'ENOENT' ? 'absent' : 'unknown',
    };
  }
  try {
    const workspace = await realpath(sharing.workspaceRoot);
    if (!canonical.startsWith(workspace + sep)) {
      return { ok: true, state: 'unknown' };
    }
    const { canonicalRoot } = await inspectStoreRoot(
      resolve(sharing.storeRoot),
      sharing
    );
    assertStoreOutsideWorkspace(canonicalRoot, workspace);
    await assertPrivateDirectory(resolve(sharing.storeRoot));
    const consumer = consumerFor(canonical, sharing);
    const linker = await configuredLinker(canonical);
    if (linker === 'hoisted') {
      return await inspectHoistedView(canonical);
    }
    if (linker !== 'isolated') {
      return {
        ok: true,
        reason: linkerIncompatibility(linker).message,
        state: 'unknown',
      };
    }
    return await inspectIsolatedDependencyView(
      canonical,
      canonicalRoot,
      consumer
    );
  } catch {
    return { ok: true, state: 'unknown' };
  }
}

async function inspectHoistedView(checkout) {
  try {
    await lstat(join(checkout, 'node_modules'));
    return {
      ok: true,
      reason:
        'Hoisted dependency files are enrolled only after a fresh guarded setup; this existing view remains ordinary until separately reviewed.',
      state: 'ordinary',
    };
  } catch (error) {
    if (error.code === 'ENOENT') {
      return { ok: true, state: 'absent' };
    }
    throw error;
  }
}

async function inspectIsolatedDependencyView(
  checkout,
  canonicalRoot,
  consumer
) {
  if (!(await consumerMatches(checkout, consumer, 'isolated'))) {
    return { ok: true, state: 'unknown' };
  }
  const nodeModules = join(checkout, 'node_modules');
  let view;
  try {
    view = await lstat(nodeModules);
  } catch (error) {
    if (error.code === 'ENOENT') {
      return { ok: true, state: 'absent' };
    }
    throw error;
  }
  if (view.isSymbolicLink()) {
    try {
      await realpath(nodeModules);
    } catch {
      return { ok: true, state: 'dangling' };
    }
    return { ok: true, state: 'ordinary' };
  }
  if (!view.isDirectory()) {
    return { ok: true, state: 'ordinary' };
  }
  const expected = join(canonicalRoot, consumer.platformNamespace, 'links');
  const inspection = await inspectIsolatedView(
    join(nodeModules, '.bun'),
    expected,
    consumer
  );
  return {
    ...inspection,
    ...(inspection.state === 'shared and healthy' ? { mode: 'isolated' } : {}),
    ok: true,
  };
}

export async function repairDependencyView(
  checkout,
  sharing,
  assertStoreStorage = assertStorageHeadroom
) {
  const view = await inspectDependencyView(checkout, sharing);
  if (view.state !== 'shared but replaced by an ordinary install') {
    return {
      code: 'DEPENDENCY_VIEW_NOT_MANAGED',
      error:
        'Repair only returns a command for an ordinary view recorded as Setu-managed.',
      ok: false,
      state: view.state,
    };
  }
  const plan = await dependencyInstallPlan(checkout, sharing, {
    allowExistingView: true,
    assertStoreStorage,
    createStore: false,
  });
  return {
    command: plan.command,
    env: {
      BUN_INSTALL_CACHE_DIR: plan.env.BUN_INSTALL_CACHE_DIR,
      BUN_INSTALL_GLOBAL_STORE: plan.env.BUN_INSTALL_GLOBAL_STORE,
    },
    mode: plan.mode,
    ok: true,
  };
}

export async function recordDependencyConsumer(state, checkout, sharing, plan) {
  if (!(state && typeof state.update === 'function')) {
    throw new Error('Dependency consumer recording requires workspace-state');
  }
  assertValidSharingFields(sharing);
  const canonical = await realpath(checkout);
  const workspace = await realpath(sharing.workspaceRoot);
  if (!canonical.startsWith(workspace + sep)) {
    throw Object.assign(
      new Error(
        'Dependency consumer checkout is outside the configured workspace'
      ),
      { code: 'DEPENDENCY_VIEW_CHECKOUT_INVALID' }
    );
  }
  const { canonicalRoot } = await inspectStoreRoot(
    resolve(sharing.storeRoot),
    sharing
  );
  assertStoreOutsideWorkspace(canonicalRoot, workspace);
  await assertPrivateDirectory(resolve(sharing.storeRoot));
  const expectedNamespace = `darwin-arm64-bun-${VERSION}`;
  const expectedStore = join(canonicalRoot, expectedNamespace);
  const executable = await realpath(sharing.executable);
  const expectedCommand = [
    executable,
    [
      'install',
      '--frozen-lockfile',
      '--linker',
      'isolated',
      '--backend',
      'copyfile',
      '--cache-dir',
      expectedStore,
    ],
  ];
  if (
    plan?.mode !== 'isolated' ||
    plan.linker !== 'isolated' ||
    plan.namespace !== expectedNamespace ||
    JSON.stringify(plan.command) !== JSON.stringify(expectedCommand) ||
    plan.env?.BUN_INSTALL_CACHE_DIR !== expectedStore ||
    plan.env?.BUN_INSTALL_GLOBAL_STORE !== '1' ||
    typeof plan.lockfileHash !== 'string' ||
    !SHA256.test(plan.lockfileHash)
  ) {
    throw Object.assign(
      new Error(
        'Dependency consumer requires the matching isolated install plan'
      ),
      { code: 'DEPENDENCY_VIEW_PLAN_INVALID' }
    );
  }
  const linker = await configuredLinker(canonical);
  if (linker !== 'isolated') {
    throw Object.assign(linkerIncompatibility(linker), {
      code: 'DEPENDENCY_VIEW_PLAN_INVALID',
    });
  }
  const lockInfo = await lstat(join(canonical, 'bun.lock'));
  if (!lockInfo.isFile() || lockInfo.isSymbolicLink()) {
    throw Object.assign(
      new Error('Dependency sharing requires a regular bun.lock file'),
      { code: 'DEPENDENCY_VIEW_PLAN_INVALID' }
    );
  }
  const lockHash = await lockfileHash(canonical);
  if (plan.lockfileHash !== lockHash) {
    throw Object.assign(
      new Error('bun.lock changed after the shared install plan was prepared'),
      { code: 'DEPENDENCY_VIEW_LOCK_CHANGED' }
    );
  }
  const record = {
    bunVersion: VERSION,
    checkout: canonical,
    linkerMode: 'isolated',
    lockfileHash: lockHash,
    platformNamespace: expectedNamespace,
  };
  await state.update('dependencyViews', (current) => {
    const consumers = Object.hasOwn(current ?? {}, 'consumers')
      ? current.consumers
      : {};
    if (
      !current ||
      typeof current !== 'object' ||
      Array.isArray(current) ||
      !consumers ||
      typeof consumers !== 'object' ||
      Array.isArray(consumers) ||
      Object.entries(consumers).some(
        ([path, value]) =>
          !value ||
          typeof value !== 'object' ||
          Array.isArray(value) ||
          value.checkout !== path ||
          [
            'bunVersion',
            'linkerMode',
            'lockfileHash',
            'platformNamespace',
          ].some((key) => typeof value[key] !== 'string')
      )
    ) {
      throw Object.assign(
        new Error('Dependency consumer records are malformed'),
        { code: 'DEPENDENCY_VIEW_STATE_CORRUPT' }
      );
    }
    return {
      ...current,
      consumers: { ...consumers, [canonical]: record },
    };
  });
  return { consumer: record, ok: true };
}
