import { execFile } from 'node:child_process';
import { lstat, mkdir, realpath } from 'node:fs/promises';
import { isAbsolute, join, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import { assertStorageHeadroom } from './host-health.js';

const exec = promisify(execFile);
const VERSION = '1.3.14';
const DISPOSABLE_PATH =
  /(?:^|\/)(?:node_modules|\.git|\.bun-cache|cache|caches|tmp|temp)(?:\/|$)/i;

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
  };
  assertValidSharingFields(resolved);
  return resolved;
}

// Experimental host-only opt-in. A store is live dependency data, never a
// disposable package cache. Provision its private root outside worktrees.
export async function sharedDependencyInstall(
  wtDir,
  sharing,
  assertStoreStorage = assertStorageHeadroom
) {
  if (!sharing?.enabled) {
    return null;
  }
  assertValidSharingFields(sharing);
  const checkout = await realpath(wtDir);
  const root = resolve(sharing.storeRoot);
  if (DISPOSABLE_PATH.test(root)) {
    throw new Error(
      'Dependency store must be outside checkouts and disposable cache/temp directories'
    );
  }
  const workspace = await realpath(sharing.workspaceRoot);
  const canonicalRoot = await realpath(root);
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
  const store = join(root, `darwin-arm64-bun-${VERSION}`);
  await mkdir(store, { mode: 0o700 }).catch((error) => {
    if (error.code !== 'EEXIST') {
      throw error;
    }
  });
  await privateDirectory(store);
  await assertStoreStorage(store);
  return {
    command: [
      executable,
      [
        'install',
        '--frozen-lockfile',
        '--linker',
        'isolated',
        '--backend',
        'copyfile',
        '--cache-dir',
        store,
      ],
    ],
    env: {
      ...process.env,
      BUN_INSTALL_CACHE_DIR: store,
      BUN_INSTALL_GLOBAL_STORE: '1',
    },
  };
}
