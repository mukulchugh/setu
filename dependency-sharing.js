import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  lstat,
  mkdir,
  readdir,
  readFile,
  realpath,
  stat,
} from 'node:fs/promises';
import { isAbsolute, join, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import { assertStorageHeadroom } from './host-health.js';

const exec = promisify(execFile);
const VERSION = '1.3.14';
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
    rootInfo.dev !== identity.device ||
    !(canonicalRoot === mountPath || canonicalRoot.startsWith(mountPath + sep))
  ) {
    throw new Error('Dependency store is not on its configured volume');
  }
  return { canonicalRoot, rootInfo };
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
  if (
    canonicalRoot === workspace ||
    canonicalRoot.startsWith(workspace + sep) ||
    workspace.startsWith(canonicalRoot + sep)
  ) {
    throw new Error(
      'Dependency store must be outside checkouts and outside the managed workspace'
    );
  }
  async function privateDirectory(path) {
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
  }
  await privateDirectory(root);
  const linker = await configuredLinker(checkout);
  if (linker !== 'isolated') {
    throw linkerIncompatibility(linker);
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
  const store = join(root, namespaceFor(runtime));
  if (createStore) {
    await mkdir(store, { mode: 0o700 }).catch((error) => {
      if (error.code !== 'EEXIST') {
        throw error;
      }
    });
    await privateDirectory(store);
    await assertStoreStorage(store);
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
    command,
    env: {
      ...process.env,
      BUN_INSTALL_CACHE_DIR: store,
      ...(linker === 'isolated' ? { BUN_INSTALL_GLOBAL_STORE: '1' } : {}),
    },
    linker: linker ?? 'project-default',
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
  if (!Object.hasOwn(targets, key)) {
    return;
  }
  const opt = targets[key];
  if (opt === false) {
    return;
  }
  if (opt !== true) {
    throw new Error(
      `Per-target dependency-sharing overrides are not supported for "${key}"; ` +
        `storeRoot/executable/version are central-only. Set targets["${key}"] to true to opt in.`
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

// Experimental host-only opt-in. A store is live dependency data, never a
// disposable package cache. Provision its private root outside worktrees.
export function sharedDependencyInstall(
  wtDir,
  sharing,
  assertStoreStorage = assertStorageHeadroom
) {
  if (!sharing?.enabled) {
    return null;
  }
  return dependencyInstallPlan(wtDir, sharing, { assertStoreStorage });
}

async function inspectIsolatedView(virtualStore, expected, consumer) {
  let entries;
  try {
    entries = await readdir(virtualStore, { withFileTypes: true });
  } catch (error) {
    if (error.code === 'ENOENT') {
      return consumer
        ? 'shared but replaced by an ordinary install'
        : 'ordinary';
    }
    throw error;
  }
  const links = entries.filter((entry) => entry.isSymbolicLink());
  if (!links.length) {
    return consumer ? 'shared but replaced by an ordinary install' : 'ordinary';
  }
  const targets = await Promise.all(
    links.map(async (link) =>
      realpath(join(virtualStore, link.name)).catch(() => null)
    )
  );
  if (targets.some((target) => target === null)) {
    return 'dangling';
  }
  return targets.every((target) => target.startsWith(expected + sep))
    ? 'shared and healthy'
    : 'unknown';
}

export async function inspectDependencyView(checkout, sharing) {
  let canonical;
  try {
    canonical = await realpath(checkout);
    const { canonicalRoot } = await inspectStoreRoot(
      resolve(sharing.storeRoot),
      sharing
    );
    const consumer = consumerFor(canonical, sharing);
    const linker = await configuredLinker(canonical);
    if (
      linker !== 'isolated' ||
      !(await consumerMatches(canonical, consumer, linker))
    ) {
      return { ok: true, state: 'unknown' };
    }
    const nodeModules = join(canonical, 'node_modules');
    const view = await lstat(nodeModules);
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
    const state = await inspectIsolatedView(
      join(nodeModules, '.bun'),
      expected,
      consumer
    );
    return {
      ...(state === 'shared and healthy' ? { mode: 'isolated' } : {}),
      ok: true,
      state,
    };
  } catch (error) {
    if (error.code === 'ENOENT') {
      return { ok: true, state: 'absent' };
    }
    return { ok: true, state: 'unknown' };
  }
}

export async function repairDependencyView(checkout, sharing) {
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

export async function recordDependencyConsumer(
  state,
  checkout,
  _sharing,
  plan
) {
  if (!(state && typeof state.update === 'function')) {
    throw new Error('Dependency consumer recording requires workspace-state');
  }
  const canonical = await realpath(checkout);
  const lockHash = await lockfileHash(canonical);
  const record = {
    bunVersion: VERSION,
    checkout: canonical,
    linkerMode: plan.linker,
    lockfileHash: lockHash,
    platformNamespace: plan.namespace,
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
