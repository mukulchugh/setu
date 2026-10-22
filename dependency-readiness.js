import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import {
  lstat,
  readdir,
  readlink,
  realpath,
  rememberDependencyFile,
  rememberDependencyGuard,
  withDependencyCheckpoint,
} from './dependency-readiness-checkpoint.js';
import { inspectDependencyView } from './dependency-sharing.js';

const RECEIPT_VERSION = 1;
const INPUT_VERSION = 1;
const MAX_ATTEMPT_ID = 512;
const MAX_MANIFEST_BYTES = 1024 * 1024;
const MAX_CONFIG_BYTES = 256 * 1024;
const MAX_LOCK_BYTES = 64 * 1024 * 1024;
const MAX_WORKSPACES = 128;
const MAX_DEPENDENCIES = 2048;
const MAX_FILES = 2048;
const MAX_SYMLINKS = 16;
const LOCK_FILES = [
  'bun.lock',
  'bun.lockb',
  'package-lock.json',
  'npm-shrinkwrap.json',
  'pnpm-lock.yaml',
  'yarn.lock',
];
const CONFIG_FILES = ['bunfig.toml', '.npmrc'];
const DEPENDENCY_SECTIONS = [
  'dependencies',
  'devDependencies',
  'optionalDependencies',
  'peerDependencies',
];
const SHA256 = /^[a-f0-9]{64}$/;
const SAFE_CODE = /^[A-Z0-9_]{1,64}$/;
const DECIMAL = /^(0|[1-9][0-9]*)$/;
const PACKAGE_SCOPE = /^@[a-zA-Z0-9._~-]+$/;
const PACKAGE_NAME_PART = /^[a-zA-Z0-9._~-]+$/;
const WORKSPACE_RANGE = /^(?:\*|\^|~|[0-9])/;
const WORKSPACE_REGEX_SPECIAL = /[|\\{}()[\]^$+?.]/g;
const BUNFIG_SECTION = /^\[.+\]$/;
const BUNFIG_INSTALL_SECTION = /^\[install\]$/;
const BUNFIG_LINKER = /^linker\s*=/;
const BUNFIG_LINKER_VALUE = /^linker\s*=\s*["'](hoisted|isolated)["']\s*$/;
const NEWLINE = /\r?\n/;
const BUNFIG_COMMENT = /\s+#.*$/;
const WHITESPACE = /\s/;

const ERRORS = {
  CHECKOUT_CHANGED: 'The checkout incarnation changed during inspection',
  CHECKOUT_IDENTITY_INVALID:
    'The linked checkout identity is missing or malformed',
  DEPENDENCY_INPUTS_CHANGED:
    'Dependency manifests, configuration, locks, or installed view changed',
  DEPENDENCY_INPUTS_UNKNOWN:
    'Dependency inputs or installed package view could not be established',
  DEPENDENCY_LOCK_MISSING:
    'A Bun lock input is required when package dependencies are declared',
  DEPENDENCY_MANAGER_UNSUPPORTED:
    'This checkout uses an unsupported dependency manager or install layout',
  DEPENDENCY_MANIFEST_INVALID:
    'A package manifest is malformed or uses an unsupported workspace form',
  DEPENDENCY_OPTIONAL_UNKNOWN:
    'An optional package has an unproven platform or installed state',
  DEPENDENCY_PACKAGE_MISSING:
    'A required direct or workspace package is missing from the installed view',
  DEPENDENCY_PACKAGE_UNSAFE:
    'A package path, package link, or installed view is unsafe or unowned',
  DEPENDENCY_READINESS_UNVERIFIED:
    'This completed setup has no dependency receipt and remains unverified',
  DEPENDENCY_RECEIPT_INVALID: 'The dependency receipt is malformed or altered',
  DEPENDENCY_VIEW_UNKNOWN:
    'The shared dependency view or its consumer ownership is unknown',
  SETUP_ATTEMPT_MISMATCH:
    'The completed setup attempt does not match the dependency receipt',
  SETUP_NOT_COMPLETED:
    'Dependency readiness requires a completed successful setup record',
  WORKSPACE_INVALID: 'The workspace declaration or package layout is invalid',
};

class ReadinessError extends Error {
  constructor(code) {
    super(ERRORS[code] ?? ERRORS.DEPENDENCY_INPUTS_UNKNOWN);
    this.code = code;
  }
}

function fail(code) {
  throw new ReadinessError(code);
}

function refusal(error) {
  const code = Object.hasOwn(ERRORS, error?.code)
    ? error.code
    : 'DEPENDENCY_INPUTS_UNKNOWN';
  return { code, error: ERRORS[code], ok: false };
}

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function exactKeys(value, keys) {
  if (!isPlainObject(value)) {
    return false;
  }
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return (
    actual.length === expected.length &&
    actual.every((key, index) => key === expected[index])
  );
}

function canonicalValue(value, depth = 0, budget = { count: 0 }) {
  budget.count += 1;
  if (budget.count > 20_000 || depth > 32) {
    throw new TypeError('JSON value exceeds readiness bounds');
  }
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'boolean'
  ) {
    return value;
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (Array.isArray(value)) {
    if (value.length > 10_000) {
      throw new TypeError('JSON array exceeds readiness bounds');
    }
    return value.map((entry) => canonicalValue(entry, depth + 1, budget));
  }
  if (!isPlainObject(value)) {
    throw new TypeError('JSON object is not plain');
  }
  const keys = Object.keys(value).sort();
  if (keys.length > 10_000) {
    throw new TypeError('JSON object exceeds readiness bounds');
  }
  return Object.fromEntries(
    keys.map((key) => [key, canonicalValue(value[key], depth + 1, budget)])
  );
}

function stableJson(value) {
  return JSON.stringify(canonicalValue(value));
}

function digest(value) {
  return createHash('sha256').update(value).digest('hex');
}

function digestJson(value) {
  return digest(stableJson(value));
}

function isWithin(root, candidate) {
  const rel = relative(root, candidate);
  return (
    rel === '' ||
    (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`))
  );
}

function pathKey(path) {
  return digest(path.replaceAll('\\', '/'));
}

function statIdentity(info) {
  if (
    typeof info.birthtimeNs !== 'bigint' ||
    info.birthtimeNs <= 0n ||
    info.ino <= 0n
  ) {
    fail('DEPENDENCY_INPUTS_UNKNOWN');
  }
  return {
    birthtimeNs: String(info.birthtimeNs),
    dev: String(info.dev),
    ino: String(info.ino),
  };
}

function checkoutStatIdentity(info) {
  try {
    return statIdentity(info);
  } catch {
    fail('CHECKOUT_CHANGED');
  }
}

function sameFileState(a, b) {
  return (
    same(statIdentity(a), statIdentity(b)) &&
    a.size === b.size &&
    a.mtimeNs === b.mtimeNs &&
    a.ctimeNs === b.ctimeNs
  );
}

function validStatIdentity(value) {
  return (
    isPlainObject(value) &&
    typeof value.birthtimeNs === 'string' &&
    typeof value.dev === 'string' &&
    typeof value.ino === 'string' &&
    value.birthtimeNs.length <= 32 &&
    value.dev.length <= 32 &&
    value.ino.length <= 32 &&
    DECIMAL.test(value.birthtimeNs) &&
    DECIMAL.test(value.dev) &&
    DECIMAL.test(value.ino) &&
    value.birthtimeNs !== '0' &&
    value.ino !== '0'
  );
}

function validCheckoutIdentity(value) {
  return (
    exactKeys(value, [
      'admin',
      'adminPath',
      'checkout',
      'checkoutPath',
      'known',
      'repository',
      'repositoryPath',
    ]) &&
    value.known === true &&
    typeof value.checkoutPath === 'string' &&
    value.checkoutPath.length <= 4096 &&
    isAbsolute(value.checkoutPath) &&
    typeof value.repositoryPath === 'string' &&
    value.repositoryPath.length <= 4096 &&
    isAbsolute(value.repositoryPath) &&
    typeof value.adminPath === 'string' &&
    value.adminPath.length <= 4096 &&
    isAbsolute(value.adminPath) &&
    validStatIdentity(value.checkout) &&
    validStatIdentity(value.repository) &&
    validStatIdentity(value.admin)
  );
}

function same(a, b) {
  try {
    return stableJson(a) === stableJson(b);
  } catch {
    return false;
  }
}

async function currentCheckout(wtDir, checkoutIdentity) {
  if (!validCheckoutIdentity(checkoutIdentity) || typeof wtDir !== 'string') {
    fail('CHECKOUT_IDENTITY_INVALID');
  }
  const absolute = resolve(wtDir);
  let info;
  try {
    info = await lstat(absolute, { bigint: true });
  } catch {
    fail('CHECKOUT_CHANGED');
  }
  if (!info.isDirectory() || info.isSymbolicLink()) {
    fail('DEPENDENCY_PACKAGE_UNSAFE');
  }
  let canonical;
  try {
    canonical = await realpath(absolute);
  } catch {
    fail('DEPENDENCY_PACKAGE_UNSAFE');
  }
  if (
    canonical !== absolute ||
    canonical !== checkoutIdentity.checkoutPath ||
    !same(checkoutStatIdentity(info), checkoutIdentity.checkout)
  ) {
    fail('CHECKOUT_CHANGED');
  }
  return canonical;
}

function fileErrorCode(role) {
  return role === 'manifest'
    ? 'DEPENDENCY_MANIFEST_INVALID'
    : 'DEPENDENCY_PACKAGE_UNSAFE';
}

function validateFileStat(info, maxBytes, role) {
  if (!info.isFile() || info.isSymbolicLink() || info.size > BigInt(maxBytes)) {
    fail(fileErrorCode(role));
  }
}

async function readBoundedChunks(handle, maxBytes, role) {
  const chunks = [];
  const chunk = Buffer.alloc(Math.min(64 * 1024, maxBytes + 1));
  let total = 0;
  for (;;) {
    // biome-ignore lint/performance/noAwaitInLoops: Sequential reads preserve file order and stop at the byte ceiling.
    const { bytesRead } = await handle.read(
      chunk,
      0,
      Math.min(chunk.length, maxBytes + 1 - total),
      null
    );
    total += bytesRead;
    if (total > maxBytes) {
      fail(fileErrorCode(role));
    }
    if (bytesRead === 0) {
      break;
    }
    chunks.push(Buffer.from(chunk.subarray(0, bytesRead)));
  }
  return Buffer.concat(chunks, total);
}

async function readRegularFile(path, maxBytes, role) {
  let before;
  try {
    before = await lstat(path, { bigint: true });
  } catch (error) {
    if (error.code === 'ENOENT') {
      return { present: false };
    }
    fail(fileErrorCode(role));
  }
  if (
    !before.isFile() ||
    before.isSymbolicLink() ||
    before.size > BigInt(maxBytes)
  ) {
    fail(fileErrorCode(role));
  }
  let handle;
  try {
    // biome-ignore lint/suspicious/noBitwiseOperators: O_NOFOLLOW must be combined with O_RDONLY as an OS open flag.
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const opened = await handle.stat({ bigint: true });
    validateFileStat(opened, maxBytes, role);
    if (!sameFileState(opened, before)) {
      fail(fileErrorCode(role));
    }
    const buffer = await readBoundedChunks(handle, maxBytes, role);
    const after = await handle.stat({ bigint: true });
    const pathAfter = await lstat(path, { bigint: true });
    if (
      buffer.length > maxBytes ||
      !sameFileState(after, opened) ||
      !sameFileState(pathAfter, opened) ||
      after.size !== BigInt(buffer.length)
    ) {
      fail(fileErrorCode(role));
    }
    rememberDependencyFile(path, buffer);
    return { bytes: buffer, present: true };
  } catch (error) {
    if (error instanceof ReadinessError) {
      throw error;
    }
    fail(fileErrorCode(role));
  } finally {
    await handle?.close().catch(() => {
      // Closing an invalidated file descriptor is best effort.
    });
  }
}

function manifestFromBytes(bytes) {
  let manifest;
  try {
    manifest = JSON.parse(bytes.toString('utf8'));
  } catch {
    fail('DEPENDENCY_MANIFEST_INVALID');
  }
  if (!isPlainObject(manifest)) {
    fail('DEPENDENCY_MANIFEST_INVALID');
  }
  return manifest;
}

function validPackageName(name) {
  if (typeof name !== 'string' || !name || name.length > 214) {
    return false;
  }
  if (name.startsWith('@')) {
    const [scope, packageName, ...extra] = name.split('/');
    return (
      extra.length === 0 &&
      PACKAGE_SCOPE.test(scope) &&
      Boolean(packageName) &&
      packageName !== '.' &&
      packageName !== '..' &&
      PACKAGE_NAME_PART.test(packageName)
    );
  }
  return name !== '.' && name !== '..' && PACKAGE_NAME_PART.test(name);
}

function validDependencyMap(value) {
  return value === undefined || isPlainObject(value);
}

function peerIsOptional(manifest, name) {
  const metadata = manifest.peerDependenciesMeta;
  if (metadata !== undefined && !isPlainObject(metadata)) {
    fail('DEPENDENCY_MANIFEST_INVALID');
  }
  for (const peerMetadata of Object.values(metadata ?? {})) {
    if (
      !isPlainObject(peerMetadata) ||
      (peerMetadata.optional !== undefined &&
        typeof peerMetadata.optional !== 'boolean')
    ) {
      fail('DEPENDENCY_MANIFEST_INVALID');
    }
  }
  return metadata?.[name]?.optional === true;
}

function dependencyEntry(manifest, section, name, specification) {
  if (
    !validPackageName(name) ||
    typeof specification !== 'string' ||
    !specification.trim() ||
    specification.length > 4096
  ) {
    fail('DEPENDENCY_MANIFEST_INVALID');
  }
  const optional =
    section === 'optionalDependencies' ||
    (section === 'peerDependencies' && peerIsOptional(manifest, name));
  return { name, optional, section, specification };
}

function dependencyEntries(manifest) {
  const rows = [];
  const seen = new Set();
  for (const section of DEPENDENCY_SECTIONS) {
    const map = manifest[section];
    if (!validDependencyMap(map)) {
      fail('DEPENDENCY_MANIFEST_INVALID');
    }
    for (const [name, specification] of Object.entries(map ?? {})) {
      if (seen.has(name)) {
        fail('DEPENDENCY_MANIFEST_INVALID');
      }
      seen.add(name);
      rows.push(dependencyEntry(manifest, section, name, specification));
      if (rows.length > MAX_DEPENDENCIES) {
        fail('DEPENDENCY_MANIFEST_INVALID');
      }
    }
  }
  return rows;
}

function validWorkspacePattern(pattern) {
  return (
    typeof pattern === 'string' &&
    pattern.length > 0 &&
    pattern.length <= 512 &&
    !isAbsolute(pattern) &&
    !pattern.includes('\\') &&
    !pattern
      .split('/')
      .some((part) => !part || part === '.' || part === '..') &&
    !hasWorkspaceMeta(pattern) &&
    !pattern.includes('**')
  );
}

function hasWorkspaceMeta(pattern) {
  return ['?', '[', ']', '{', '}', '!'].some((character) =>
    pattern.includes(character)
  );
}

function workspaceSegmentMatcher(pattern) {
  const escaped = pattern.replace(WORKSPACE_REGEX_SPECIAL, '\\$&');
  return new RegExp(`^${escaped.replaceAll('*', '[^/]*')}$`);
}

async function childDirectories(path, root) {
  let entries;
  try {
    entries = await readdir(path, { withFileTypes: true });
  } catch {
    fail('WORKSPACE_INVALID');
  }
  if (entries.length > 4096) {
    fail('WORKSPACE_INVALID');
  }
  const result = [];
  for (const entry of entries) {
    if (entry.isSymbolicLink()) {
      fail('DEPENDENCY_PACKAGE_UNSAFE');
    }
    if (entry.isDirectory()) {
      const child = join(path, entry.name);
      if (!isWithin(root, child)) {
        fail('DEPENDENCY_PACKAGE_UNSAFE');
      }
      result.push(child);
    }
  }
  return result.sort();
}

async function literalWorkspaceChild(root, base, part) {
  const child = join(base, part);
  if (!isWithin(root, child)) {
    fail('DEPENDENCY_PACKAGE_UNSAFE');
  }
  let info;
  try {
    info = await lstat(child, { bigint: true });
  } catch (error) {
    if (error.code === 'ENOENT') {
      fail('WORKSPACE_INVALID');
    }
    fail('DEPENDENCY_PACKAGE_UNSAFE');
  }
  if (info.isSymbolicLink() || !info.isDirectory()) {
    fail('DEPENDENCY_PACKAGE_UNSAFE');
  }
  return child;
}

async function expandWorkspacePart(root, candidates, part) {
  const next = [];
  if (!part.includes('*')) {
    for (const base of candidates) {
      // biome-ignore lint/performance/noAwaitInLoops: Literal workspace segments are resolved in declaration order.
      next.push(await literalWorkspaceChild(root, base, part));
    }
    return next;
  }
  const matcher = workspaceSegmentMatcher(part);
  for (const base of candidates) {
    for (const child of await childDirectories(base, root)) {
      if (matcher.test(child.slice(base.length + 1))) {
        next.push(child);
      }
    }
  }
  return next;
}

function workspacePatterns(manifest) {
  let patterns = manifest.workspaces;
  if (patterns === undefined) {
    return [];
  }
  if (isPlainObject(patterns)) {
    if (Object.keys(patterns).some((key) => key !== 'packages')) {
      fail('WORKSPACE_INVALID');
    }
    patterns = patterns.packages;
  }
  if (
    !Array.isArray(patterns) ||
    patterns.length > MAX_WORKSPACES ||
    !patterns.every(validWorkspacePattern)
  ) {
    fail('WORKSPACE_INVALID');
  }
  return patterns;
}

async function expandWorkspacePattern(root, pattern) {
  let candidates = [root];
  for (const part of pattern.split('/')) {
    // biome-ignore lint/performance/noAwaitInLoops: Each segment depends on the prior segment's discovered directories.
    candidates = await expandWorkspacePart(root, candidates, part);
  }
  if (candidates.length === 0 || candidates.includes(root)) {
    fail('WORKSPACE_INVALID');
  }
  return candidates;
}

async function workspaceDirectories(root, manifest) {
  const patterns = workspacePatterns(manifest);
  const found = new Set();
  for (const pattern of patterns) {
    // biome-ignore lint/performance/noAwaitInLoops: Workspace patterns are expanded in manifest order.
    const candidates = await expandWorkspacePattern(root, pattern);
    for (const candidate of candidates) {
      found.add(candidate);
      if (found.size > MAX_WORKSPACES) {
        fail('WORKSPACE_INVALID');
      }
    }
  }
  return [...found].sort();
}

async function followSafeLink(candidate, info, pending, allowedRoots, state) {
  state.hops += 1;
  if (state.hops > MAX_SYMLINKS) {
    fail('DEPENDENCY_PACKAGE_UNSAFE');
  }
  let target;
  try {
    target = await readlink(candidate);
  } catch {
    fail('DEPENDENCY_PACKAGE_UNSAFE');
  }
  const targetPath = isAbsolute(target)
    ? resolve(target)
    : resolve(dirname(candidate), target);
  if (!allowedRoots.some((root) => isWithin(root, targetPath))) {
    fail('DEPENDENCY_PACKAGE_UNSAFE');
  }
  state.links.push({
    identity: statIdentity(info),
    key: pathKey(candidate),
    path: candidate,
    target: pathKey(targetPath),
    targetPath,
  });
  return [...targetPath.slice(1).split(sep).filter(Boolean), ...pending];
}

async function verifyResolvedLinks(links) {
  for (const link of links) {
    let currentInfo;
    let currentTarget;
    try {
      // biome-ignore lint/performance/noAwaitInLoops: Captured links are rechecked sequentially before resolution returns.
      currentInfo = await lstat(link.path, { bigint: true });
      currentTarget = await readlink(link.path);
    } catch {
      fail('DEPENDENCY_PACKAGE_UNSAFE');
    }
    const targetPath = isAbsolute(currentTarget)
      ? resolve(currentTarget)
      : resolve(dirname(link.path), currentTarget);
    if (
      !(
        currentInfo.isSymbolicLink() &&
        same(statIdentity(currentInfo), link.identity)
      ) ||
      pathKey(targetPath) !== link.target
    ) {
      fail('DEPENDENCY_PACKAGE_UNSAFE');
    }
  }
}

async function safeResolvePath(path, allowedRoots) {
  let pending = resolve(path).slice(1).split(sep).filter(Boolean);
  let current = sep;
  const state = { hops: 0, links: [] };
  while (pending.length) {
    const part = pending.shift();
    if (part === '.') {
      continue;
    }
    if (part === '..') {
      current = dirname(current);
      continue;
    }
    const candidate = join(current, part);
    let info;
    try {
      // biome-ignore lint/performance/noAwaitInLoops: Path components are resolved in order to preserve symlink semantics.
      info = await lstat(candidate, { bigint: true });
    } catch (error) {
      if (error.code === 'ENOENT') {
        return { links: state.links, missing: true };
      }
      fail('DEPENDENCY_PACKAGE_UNSAFE');
    }
    if (info.isSymbolicLink()) {
      pending = await followSafeLink(
        candidate,
        info,
        pending,
        allowedRoots,
        state
      );
      current = sep;
      continue;
    }
    current = candidate;
    if (pending.length && !info.isDirectory()) {
      fail('DEPENDENCY_PACKAGE_UNSAFE');
    }
  }
  if (!allowedRoots.some((root) => isWithin(root, current))) {
    fail('DEPENDENCY_PACKAGE_UNSAFE');
  }
  let finalInfo;
  try {
    finalInfo = await lstat(current, { bigint: true });
  } catch {
    return { links: state.links, missing: true };
  }
  if (finalInfo.isSymbolicLink()) {
    fail('DEPENDENCY_PACKAGE_UNSAFE');
  }
  await verifyResolvedLinks(state.links);
  return {
    identity: statIdentity(finalInfo),
    links: state.links,
    missing: false,
    path: current,
  };
}

function parseAliasedName(specification) {
  if (!specification.startsWith('npm:')) {
    return null;
  }
  const alias = specification.slice(4);
  let name;
  if (alias.startsWith('@')) {
    const slash = alias.indexOf('/');
    if (slash < 2) {
      fail('DEPENDENCY_MANIFEST_INVALID');
    }
    const rangeStart = alias.indexOf('@', slash + 1);
    name = rangeStart < 0 ? alias : alias.slice(0, rangeStart);
  } else {
    const rangeStart = alias.indexOf('@');
    name = rangeStart < 0 ? alias : alias.slice(0, rangeStart);
  }
  if (!validPackageName(name)) {
    fail('DEPENDENCY_MANIFEST_INVALID');
  }
  return name;
}

function platformCompatible(manifest) {
  const matches = (field, value) => {
    if (manifest[field] === undefined) {
      return true;
    }
    if (
      !(
        Array.isArray(manifest[field]) &&
        manifest[field].every((item) => typeof item === 'string')
      )
    ) {
      fail('DEPENDENCY_MANIFEST_INVALID');
    }
    const values = manifest[field];
    const excluded = values
      .filter((item) => item.startsWith('!'))
      .map((item) => item.slice(1));
    const included = values.filter((item) => !item.startsWith('!'));
    return (
      !excluded.includes(value) &&
      (!included.length || included.includes(value))
    );
  };
  return matches('os', process.platform) && matches('cpu', process.arch);
}

function bunfigLinker(text) {
  let inInstall = false;
  let linker = null;
  for (const raw of text.split(NEWLINE)) {
    const line = raw.replace(BUNFIG_COMMENT, '').trim();
    if (BUNFIG_INSTALL_SECTION.test(line)) {
      inInstall = true;
      continue;
    }
    if (BUNFIG_SECTION.test(line)) {
      inInstall = false;
      continue;
    }
    if (inInstall && BUNFIG_LINKER.test(line)) {
      const [, foundLinker] = BUNFIG_LINKER_VALUE.exec(line) ?? [];
      if (!foundLinker || (linker && linker !== foundLinker)) {
        fail('DEPENDENCY_MANAGER_UNSUPPORTED');
      }
      linker = foundLinker;
    }
  }
  return linker;
}

async function fingerprintFile(path, checkout, role, maxBytes) {
  const read = await readRegularFile(path, maxBytes, role);
  return fingerprintRead(path, checkout, role, read);
}

function fingerprintRead(path, checkout, role, read) {
  const rel = relative(checkout, path);
  if (isAbsolute(rel) || rel === '..' || rel.startsWith(`..${sep}`)) {
    fail('DEPENDENCY_PACKAGE_UNSAFE');
  }
  if (!read.present) {
    return {
      bytes: 0,
      key: pathKey(rel),
      present: false,
      role,
      sha256: null,
    };
  }
  return {
    bytes: read.bytes.length,
    key: pathKey(rel),
    present: true,
    role,
    sha256: digest(read.bytes),
  };
}

function manifestId(checkout, path) {
  return pathKey(relative(checkout, path));
}

async function readManifest(checkout, directory) {
  const path = join(directory, 'package.json');
  const read = await readRegularFile(path, MAX_MANIFEST_BYTES, 'manifest');
  const fingerprint = fingerprintRead(path, checkout, 'manifest', read);
  if (!fingerprint.present) {
    return { fingerprint, manifest: null };
  }
  return { fingerprint, manifest: manifestFromBytes(read.bytes) };
}

async function readWorkspacePackage(checkout, directory) {
  const resolved = await safeResolvePath(directory, [checkout]);
  if (resolved.missing || resolved.path !== directory) {
    fail('DEPENDENCY_PACKAGE_UNSAFE');
  }
  const { fingerprint, manifest } = await readManifest(checkout, directory);
  if (
    !manifest ||
    typeof manifest.name !== 'string' ||
    !validPackageName(manifest.name)
  ) {
    fail('WORKSPACE_INVALID');
  }
  return {
    directory,
    directoryIdentity: resolved.identity,
    fingerprint,
    id: manifestId(checkout, directory),
    manifest,
    name: manifest.name,
  };
}

async function discoverManifests(checkout) {
  const root = await readManifest(checkout, checkout);
  if (!root.manifest) {
    const unsupportedMarkers = [
      'pyproject.toml',
      'requirements.txt',
      'requirements-dev.txt',
      'Pipfile',
      'Pipfile.lock',
      'uv.lock',
      'setup.py',
      'environment.yml',
      'Cargo.toml',
      'Cargo.lock',
      'go.mod',
      'go.sum',
      'Gemfile',
      'Gemfile.lock',
      'pom.xml',
      'build.gradle',
      'build.gradle.kts',
      'composer.json',
      'bun.lock',
      'bun.lockb',
      'package-lock.json',
      'npm-shrinkwrap.json',
      'pnpm-lock.yaml',
      'yarn.lock',
    ];
    await rejectUnsupportedMarkers(checkout, unsupportedMarkers);
    return { packages: [] };
  }
  const directories = await workspaceDirectories(checkout, root.manifest);
  const workspacePackages = [];
  for (const directory of directories) {
    // biome-ignore lint/performance/noAwaitInLoops: Workspace manifests are read in sorted directory order.
    workspacePackages.push(await readWorkspacePackage(checkout, directory));
  }
  const rootPackage = {
    directory: checkout,
    directoryIdentity: statIdentity(await lstat(checkout, { bigint: true })),
    fingerprint: root.fingerprint,
    id: manifestId(checkout, checkout),
    manifest: root.manifest,
    name: typeof root.manifest.name === 'string' ? root.manifest.name : null,
  };
  const all = [rootPackage, ...workspacePackages];
  const names = new Set();
  for (const pkg of all) {
    if (pkg.name && names.has(pkg.name)) {
      fail('WORKSPACE_INVALID');
    }
    if (pkg.name) {
      names.add(pkg.name);
    }
  }
  return { packages: all };
}

async function rejectUnsupportedMarkers(checkout, unsupportedMarkers) {
  for (const name of unsupportedMarkers) {
    // biome-ignore lint/performance/noAwaitInLoops: Marker checks preserve the declared conservative protocol order.
    const marker = await lstat(join(checkout, name)).catch((error) => {
      if (error.code === 'ENOENT') {
        return null;
      }
      fail('DEPENDENCY_PACKAGE_UNSAFE');
    });
    if (marker) {
      fail('DEPENDENCY_MANAGER_UNSUPPORTED');
    }
  }
}

async function collectDirectoryInputs(checkout, directory) {
  const files = [];
  let rootLinker = null;
  for (const configName of CONFIG_FILES) {
    const path = join(directory, configName);
    // biome-ignore lint/performance/noAwaitInLoops: Configuration evidence is read in fixed order for each manifest directory.
    const read = await readRegularFile(path, MAX_CONFIG_BYTES, 'config');
    const entry = fingerprintRead(path, checkout, 'config', read);
    files.push(entry);
    if (configName === 'bunfig.toml' && entry.present) {
      const linker = bunfigLinker(read.bytes.toString('utf8'));
      if (linker) {
        if (directory !== checkout) {
          fail('DEPENDENCY_MANAGER_UNSUPPORTED');
        }
        rootLinker = linker;
      }
    }
  }
  for (const lockName of LOCK_FILES) {
    files.push(
      // biome-ignore lint/performance/noAwaitInLoops: Lock files are fingerprinted in fixed order.
      await fingerprintFile(
        join(directory, lockName),
        checkout,
        'lock',
        MAX_LOCK_BYTES
      )
    );
  }
  return { files, rootLinker };
}

async function gatherInputFiles(
  checkout,
  packages,
  { allowMissingRootBunLock = false } = {}
) {
  const files = packages.map((pkg) => pkg.fingerprint);
  let rootLinker = null;
  const dirs = packages.length
    ? packages.map((pkg) => pkg.directory)
    : [checkout];
  if (!packages.length) {
    files.push(
      await fingerprintFile(
        join(checkout, 'package.json'),
        checkout,
        'manifest',
        MAX_MANIFEST_BYTES
      )
    );
  }
  for (const directory of dirs) {
    // biome-ignore lint/performance/noAwaitInLoops: Input directories are observed in manifest order to keep the snapshot deterministic.
    const observed = await collectDirectoryInputs(checkout, directory);
    const { files: observedFiles, rootLinker: observedRootLinker } = observed;
    files.push(...observedFiles);
    if (observedRootLinker) {
      rootLinker = observedRootLinker;
    }
  }
  files.sort(
    (a, b) => a.key.localeCompare(b.key) || a.role.localeCompare(b.role)
  );
  if (files.length > MAX_FILES) {
    fail('DEPENDENCY_MANAGER_UNSUPPORTED');
  }
  const rootLocks = LOCK_FILES.slice(0, 2).filter((name) =>
    files.some((entry) => entry.key === pathKey(name) && entry.present)
  );
  const hasRootBunLock = rootLocks.length > 0;
  const dependencyRows = packages.flatMap((pkg) =>
    dependencyEntries(pkg.manifest)
  );
  if (dependencyRows.length && !hasRootBunLock && !allowMissingRootBunLock) {
    fail('DEPENDENCY_LOCK_MISSING');
  }
  return { files, linkerMode: rootLinker ?? 'unspecified' };
}

async function nodeModulesDirectory(checkout, directory) {
  let current = directory;
  while (isWithin(checkout, current)) {
    const candidate = join(current, 'node_modules');
    let info;
    try {
      // biome-ignore lint/performance/noAwaitInLoops: Search upward one parent at a time for the nearest installed view.
      info = await lstat(candidate, { bigint: true });
    } catch (error) {
      if (error.code === 'ENOENT') {
        if (current === checkout) {
          return null;
        }
        const parent = dirname(current);
        if (parent === current) {
          break;
        }
        current = parent;
        continue;
      }
      fail('DEPENDENCY_PACKAGE_UNSAFE');
    }
    if (info.isSymbolicLink() || !info.isDirectory()) {
      fail('DEPENDENCY_PACKAGE_UNSAFE');
    }
    return { identity: statIdentity(info), path: candidate };
  }
  return null;
}

function dependencyPath(nodeModules, name) {
  const parts = name.split('/');
  return join(nodeModules, ...parts);
}

async function inspectInstalledPackage({
  allowedRoots,
  checkout,
  dependency,
  directory,
  linkerMode,
  manifestId: sourceId,
  shared,
  workspaceByName,
}) {
  const key = digest(`${sourceId}\0${dependency.section}\0${dependency.name}`);
  const alias = parseAliasedName(dependency.specification);
  const expectedName = alias ?? dependency.name;
  validateWorkspaceDependency(dependency, workspaceByName);
  const prepared = await locateInstalledPackage({
    allowedRoots,
    checkout,
    dependency,
    directory,
    expectedName,
    key,
  });
  if (prepared.omitted) {
    return { key, result: prepared.optionalResult };
  }
  const { candidate, compatible, nodeModules, packageInfo, read, resolved } =
    prepared;
  const expectedWorkspace = workspaceByName.get(dependency.name);
  const localPrefix = ['file:', 'link:'].find((prefix) =>
    dependency.specification.startsWith(prefix)
  );
  await validatePackageTarget({
    candidate,
    checkout,
    dependency,
    directory,
    expectedWorkspace,
    localPrefix,
    resolved,
    shared,
  });
  validateSharedPackageLocation(shared, checkout, resolved.path);
  await verifyInstalledPackageIdentity(nodeModules, packageInfo, resolved.path);
  validateIsolatedPackagePath({
    candidate,
    checkout,
    dependency,
    linkerMode,
    localPrefix,
    resolved,
    shared,
  });
  const result = {
    key,
    links: resolved.links.map(({ identity, key: linkKey, target }) => ({
      identity,
      key: linkKey,
      target,
    })),
    nodeModules: {
      identity: nodeModules.identity,
      key: pathKey(nodeModules.path),
    },
    package: {
      identity: statIdentity(packageInfo),
      key: pathKey(resolved.path),
      metadataDigest: digest(read.bytes),
    },
    status: compatible ? 'installed' : 'platform-skipped',
  };
  return { key, result };
}

async function locateInstalledPackage({
  allowedRoots,
  checkout,
  dependency,
  directory,
  expectedName,
  key,
}) {
  const nodeModules = await nodeModulesDirectory(checkout, directory);
  if (!nodeModules) {
    if (dependency.optional) {
      return {
        omitted: true,
        optionalResult: { key, status: 'optional-omitted' },
      };
    }
    fail('DEPENDENCY_PACKAGE_MISSING');
  }
  const logicalPath = dependencyPath(nodeModules.path, dependency.name);
  let candidate;
  try {
    candidate = await lstat(logicalPath, { bigint: true });
  } catch (error) {
    if (error.code !== 'ENOENT') {
      fail('DEPENDENCY_PACKAGE_UNSAFE');
    }
    if (dependency.optional) {
      return {
        omitted: true,
        optionalResult: {
          key,
          nodeModules: {
            identity: nodeModules.identity,
            key: pathKey(nodeModules.path),
          },
          status: 'optional-omitted',
        },
      };
    }
    fail('DEPENDENCY_PACKAGE_MISSING');
  }
  const resolved = await safeResolvePath(logicalPath, allowedRoots);
  if (resolved.missing || !resolved.path) {
    fail('DEPENDENCY_PACKAGE_UNSAFE');
  }
  if (!(candidate.isSymbolicLink() || candidate.isDirectory())) {
    fail('DEPENDENCY_PACKAGE_UNSAFE');
  }
  const packageInfo = await lstat(resolved.path, { bigint: true }).catch(
    () => null
  );
  if (!packageInfo?.isDirectory() || packageInfo.isSymbolicLink()) {
    fail('DEPENDENCY_PACKAGE_UNSAFE');
  }
  const packageManifestPath = join(resolved.path, 'package.json');
  const read = await readRegularFile(
    packageManifestPath,
    MAX_MANIFEST_BYTES,
    'manifest'
  );
  if (!read.present) {
    fail('DEPENDENCY_PACKAGE_UNSAFE');
  }
  const installedManifest = manifestFromBytes(read.bytes);
  if (installedManifest.name !== expectedName) {
    fail('DEPENDENCY_PACKAGE_UNSAFE');
  }
  validateInstalledPackageVersion(installedManifest);
  const compatible = platformCompatible(installedManifest);
  if (!(compatible || dependency.optional)) {
    fail('DEPENDENCY_PACKAGE_UNSAFE');
  }
  return {
    candidate,
    compatible,
    nodeModules,
    omitted: false,
    packageInfo,
    read,
    resolved,
  };
}

function validateSharedPackageLocation(shared, checkout, packagePath) {
  if (
    shared &&
    !isWithin(shared.storeRoot, packagePath) &&
    !isWithin(checkout, packagePath)
  ) {
    fail('DEPENDENCY_PACKAGE_UNSAFE');
  }
}

async function verifyInstalledPackageIdentity(nodeModules, packageInfo, path) {
  const nodeModulesAfter = await lstat(nodeModules.path, {
    bigint: true,
  }).catch(() => null);
  const packageAfter = await lstat(path, { bigint: true }).catch(() => null);
  if (
    !nodeModulesAfter?.isDirectory() ||
    nodeModulesAfter.isSymbolicLink() ||
    !same(statIdentity(nodeModulesAfter), nodeModules.identity) ||
    !packageAfter?.isDirectory() ||
    packageAfter.isSymbolicLink() ||
    !same(statIdentity(packageAfter), statIdentity(packageInfo))
  ) {
    fail('DEPENDENCY_PACKAGE_UNSAFE');
  }
}

function validateWorkspaceDependency(dependency, workspaceByName) {
  if (!dependency.specification.startsWith('workspace:')) {
    return;
  }
  const workspaceRange = dependency.specification.slice('workspace:'.length);
  if (
    !(
      workspaceByName.has(dependency.name) &&
      WORKSPACE_RANGE.test(workspaceRange)
    ) ||
    WHITESPACE.test(workspaceRange)
  ) {
    fail('WORKSPACE_INVALID');
  }
}

function validateInstalledPackageVersion(manifest) {
  if (
    typeof manifest.version !== 'string' ||
    !manifest.version ||
    manifest.version.length > 256
  ) {
    fail('DEPENDENCY_PACKAGE_UNSAFE');
  }
}

async function validatePackageTarget({
  candidate,
  checkout,
  dependency,
  directory,
  expectedWorkspace,
  localPrefix,
  resolved,
  shared,
}) {
  if (
    dependency.specification.startsWith('workspace:') &&
    (!expectedWorkspace || resolved.path !== expectedWorkspace.directory)
  ) {
    fail('DEPENDENCY_PACKAGE_UNSAFE');
  }
  if (localPrefix) {
    const localPath = resolve(
      directory,
      dependency.specification.slice(localPrefix.length)
    );
    if (!isWithin(checkout, localPath)) {
      fail('DEPENDENCY_PACKAGE_UNSAFE');
    }
    const localTarget = await safeResolvePath(localPath, [checkout]);
    if (localTarget.missing || localTarget.path !== resolved.path) {
      fail('DEPENDENCY_PACKAGE_UNSAFE');
    }
  }
  if (candidate.isSymbolicLink()) {
    const localDependency =
      (expectedWorkspace && resolved.path === expectedWorkspace.directory) ||
      Boolean(localPrefix);
    const virtualStorePath = join(checkout, 'node_modules', '.bun');
    const ownedVirtualLinks = resolved.links.every(
      (link) =>
        isWithin(virtualStorePath, link.targetPath) ||
        (shared && isWithin(shared.storeRoot, link.targetPath))
    );
    if (!(localDependency || ownedVirtualLinks)) {
      fail('DEPENDENCY_PACKAGE_UNSAFE');
    }
  }
}

function validateIsolatedPackagePath({
  candidate,
  checkout,
  dependency,
  linkerMode,
  localPrefix,
  resolved,
  shared,
}) {
  if (
    !(
      localPrefix ||
      dependency.specification.startsWith('workspace:') ||
      candidate.isSymbolicLink()
    ) &&
    linkerMode === 'isolated' &&
    !isWithin(join(checkout, 'node_modules', '.bun'), resolved.path) &&
    !(shared && isWithin(shared.storeRoot, resolved.path))
  ) {
    fail('DEPENDENCY_PACKAGE_UNSAFE');
  }
}

async function inspectPackageRows({
  allowedRoots,
  checkout,
  dependencies,
  linkerMode,
  shared,
  workspaceByName,
}) {
  const rows = [];
  for (const row of dependencies) {
    // biome-ignore lint/performance/noAwaitInLoops: Package validations remain sequential so the first refusal stays deterministic.
    const inspected = await inspectInstalledPackage({
      allowedRoots,
      checkout,
      dependency: row.dependency,
      directory: row.directory,
      linkerMode,
      manifestId: row.id,
      shared,
      workspaceByName,
    });
    rows.push(inspected.result);
  }
  return rows.sort((a, b) => a.key.localeCompare(b.key));
}

function validateSharingOptions(sharing, bunVersion) {
  if (
    sharing.enabled !== true ||
    sharing.version !== '1.3.14' ||
    bunVersion !== '1.3.14' ||
    process.platform !== 'darwin' ||
    process.arch !== 'arm64' ||
    typeof sharing.executable !== 'string' ||
    !isAbsolute(sharing.executable) ||
    typeof sharing.storeRoot !== 'string' ||
    !isAbsolute(sharing.storeRoot) ||
    typeof sharing.workspaceRoot !== 'string' ||
    !isAbsolute(sharing.workspaceRoot)
  ) {
    fail('DEPENDENCY_VIEW_UNKNOWN');
  }
}

function validateConsumerDocument(document) {
  if (
    !isPlainObject(document) ||
    (document.consumers !== undefined && !isPlainObject(document.consumers))
  ) {
    fail('DEPENDENCY_VIEW_UNKNOWN');
  }
  const consumers = document.consumers ?? {};
  for (const [path, consumer] of Object.entries(consumers)) {
    if (
      !isPlainObject(consumer) ||
      consumer.checkout !== path ||
      typeof consumer.bunVersion !== 'string' ||
      typeof consumer.linkerMode !== 'string' ||
      typeof consumer.lockfileHash !== 'string' ||
      typeof consumer.platformNamespace !== 'string'
    ) {
      fail('DEPENDENCY_VIEW_UNKNOWN');
    }
  }
  return consumers;
}

async function sharedContext(checkout, sharing, state, bunVersion) {
  if (!sharing?.enabled) {
    return null;
  }
  validateSharingOptions(sharing, bunVersion);
  if (typeof state?.read !== 'function') {
    fail('DEPENDENCY_VIEW_UNKNOWN');
  }
  let document;
  try {
    document = state.read('dependencyViews');
  } catch {
    fail('DEPENDENCY_VIEW_UNKNOWN');
  }
  const consumers = validateConsumerDocument(document);
  let canonical;
  try {
    canonical = await realpath(checkout);
  } catch {
    fail('DEPENDENCY_VIEW_UNKNOWN');
  }
  const consumer = consumers[canonical];
  if (!consumer || consumer.bunVersion !== bunVersion) {
    fail('DEPENDENCY_VIEW_UNKNOWN');
  }
  rememberDependencyGuard(`consumer:${canonical}`, () => {
    try {
      const current = state.read('dependencyViews');
      if (
        !isPlainObject(current) ||
        (current.consumers !== undefined && !isPlainObject(current.consumers))
      ) {
        return false;
      }
      return same(current.consumers?.[canonical], consumer);
    } catch {
      return false;
    }
  });
  const view = await inspectDependencyView(checkout, {
    ...sharing,
    consumers,
  });
  if (!(view.ok === true && view.state === 'shared and healthy')) {
    fail('DEPENDENCY_VIEW_UNKNOWN');
  }
  let storeRoot;
  try {
    storeRoot = await realpath(sharing.storeRoot);
  } catch {
    fail('DEPENDENCY_VIEW_UNKNOWN');
  }
  let workspaceRoot;
  try {
    workspaceRoot = await realpath(sharing.workspaceRoot);
  } catch {
    fail('DEPENDENCY_VIEW_UNKNOWN');
  }
  if (
    !isWithin(workspaceRoot, canonical) ||
    canonical === workspaceRoot ||
    isWithin(workspaceRoot, storeRoot) ||
    isWithin(storeRoot, workspaceRoot)
  ) {
    fail('DEPENDENCY_VIEW_UNKNOWN');
  }
  return {
    consumerKey: digestJson(consumer),
    storeRoot,
  };
}

function validateObservationOptions({ bunVersion, wtDir, sharing }) {
  if (typeof bunVersion !== 'string' || !bunVersion || bunVersion.length > 64) {
    fail('DEPENDENCY_INPUTS_UNKNOWN');
  }
  if (typeof wtDir !== 'string' || wtDir.length > 4096) {
    fail('DEPENDENCY_INPUTS_UNKNOWN');
  }
  if (
    sharing !== undefined &&
    sharing !== null &&
    (!isPlainObject(sharing) || typeof sharing.enabled !== 'boolean')
  ) {
    fail('DEPENDENCY_VIEW_UNKNOWN');
  }
}

async function resolveObservationCheckout(wtDir) {
  const checkout = resolve(wtDir);
  let rootInfo;
  try {
    rootInfo = await lstat(checkout, { bigint: true });
  } catch {
    fail('DEPENDENCY_PACKAGE_UNSAFE');
  }
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) {
    fail('DEPENDENCY_PACKAGE_UNSAFE');
  }
  let canonical;
  try {
    canonical = await realpath(checkout);
  } catch {
    fail('DEPENDENCY_PACKAGE_UNSAFE');
  }
  if (canonical !== checkout) {
    fail('DEPENDENCY_PACKAGE_UNSAFE');
  }
  return { canonical, checkout, rootInfo };
}

function collectDependencyRows(packages) {
  const workspaceByName = new Map();
  for (const pkg of packages.slice(1)) {
    workspaceByName.set(pkg.name, pkg);
  }
  const dependencies = packages.flatMap((pkg) =>
    dependencyEntries(pkg.manifest).map((dependency) => ({
      dependency,
      directory: pkg.directory,
      id: pkg.id,
    }))
  );
  if (dependencies.length > MAX_DEPENDENCIES) {
    fail('DEPENDENCY_MANIFEST_INVALID');
  }
  return { dependencies, workspaceByName };
}

async function verifyObservationSnapshot({
  canonical,
  checkout,
  dependencies,
  discovered,
  gathered,
  rootInfo,
  sharing,
  state,
  bunVersion,
  shared,
  viewRows,
  allowedRoots,
  workspaceByName,
}) {
  const endDiscovered = await discoverManifests(checkout);
  const endGathered = await gatherInputFiles(checkout, endDiscovered.packages);
  if (
    !same(gathered.files, endGathered.files) ||
    gathered.linkerMode !== endGathered.linkerMode ||
    !same(
      discovered.packages.map((pkg) => [pkg.id, pkg.directoryIdentity]),
      endDiscovered.packages.map((pkg) => [pkg.id, pkg.directoryIdentity])
    )
  ) {
    fail('DEPENDENCY_INPUTS_CHANGED');
  }
  const endShared =
    dependencies.length > 0
      ? await sharedContext(checkout, sharing, state, bunVersion)
      : null;
  if (
    !same(
      shared && [shared.consumerKey, shared.storeRoot],
      endShared && [endShared.consumerKey, endShared.storeRoot]
    )
  ) {
    fail('DEPENDENCY_VIEW_UNKNOWN');
  }
  const endViewRows = await inspectPackageRows({
    allowedRoots,
    checkout,
    dependencies,
    linkerMode: gathered.linkerMode,
    shared,
    workspaceByName,
  });
  if (!same(viewRows, endViewRows)) {
    fail('DEPENDENCY_INPUTS_CHANGED');
  }
  const rootAfter = await lstat(checkout, { bigint: true }).catch(() => null);
  if (
    !rootAfter?.isDirectory() ||
    rootAfter.isSymbolicLink() ||
    !same(checkoutStatIdentity(rootInfo), checkoutStatIdentity(rootAfter)) ||
    (await realpath(checkout).catch(() => null)) !== canonical
  ) {
    fail('CHECKOUT_CHANGED');
  }
}

function createObservedInputs({
  bunVersion,
  dependencies,
  discovered,
  gathered,
  shared,
  viewRows,
}) {
  const noDependencies = dependencies.length === 0;
  let installMode = 'private';
  if (noDependencies) {
    installMode = 'none';
  } else if (shared) {
    installMode = 'shared';
  }
  const inputs = {
    bunVersion,
    dependencyCount: dependencies.length,
    files: gathered.files,
    installMode,
    linkerMode: gathered.linkerMode,
    noDependencies,
    platform: { arch: process.arch, platform: process.platform },
    sharedConsumerDigest: shared?.consumerKey ?? null,
    sharedView: shared ? 'shared and healthy' : null,
    version: INPUT_VERSION,
    view: viewRows,
    workspaceCount: Math.max(0, discovered.packages.length - 1),
  };
  inputs.digest = digestJson(inputs);
  return inputs;
}

async function observeInputs({
  wtDir,
  bunVersion = Bun.version,
  sharing,
  state,
} = {}) {
  validateObservationOptions({ bunVersion, sharing, wtDir });
  const { canonical, checkout, rootInfo } =
    await resolveObservationCheckout(wtDir);
  const discovered = await discoverManifests(checkout);
  const gathered = await gatherInputFiles(checkout, discovered.packages);
  const { dependencies, workspaceByName } = collectDependencyRows(
    discovered.packages
  );
  if (dependencies.length === 0) {
    const nodeModules = await lstat(join(checkout, 'node_modules')).catch(
      (error) => {
        if (error?.code === 'ENOENT') {
          return null;
        }
        fail('DEPENDENCY_PACKAGE_UNSAFE');
      }
    );
    if (
      nodeModules &&
      (nodeModules.isSymbolicLink() || !nodeModules.isDirectory())
    ) {
      fail('DEPENDENCY_PACKAGE_UNSAFE');
    }
  }
  const shared =
    dependencies.length > 0
      ? await sharedContext(checkout, sharing, state, bunVersion)
      : null;
  const allowedRoots = [checkout, ...(shared ? [shared.storeRoot] : [])];
  const viewRows = await inspectPackageRows({
    allowedRoots,
    checkout,
    dependencies,
    linkerMode: gathered.linkerMode,
    shared,
    workspaceByName,
  });
  await verifyObservationSnapshot({
    allowedRoots,
    bunVersion,
    canonical,
    checkout,
    dependencies,
    discovered,
    gathered,
    rootInfo,
    shared,
    sharing,
    state,
    viewRows,
    workspaceByName,
  });
  return createObservedInputs({
    bunVersion,
    dependencies,
    discovered,
    gathered,
    shared,
    viewRows,
  });
}

async function observeInstallInputs({ wtDir, bunVersion = Bun.version } = {}) {
  if (typeof bunVersion !== 'string' || !bunVersion || bunVersion.length > 64) {
    fail('DEPENDENCY_INPUTS_UNKNOWN');
  }
  if (typeof wtDir !== 'string' || wtDir.length > 4096) {
    fail('DEPENDENCY_INPUTS_UNKNOWN');
  }
  const checkout = resolve(wtDir);
  let rootInfo;
  try {
    rootInfo = await lstat(checkout, { bigint: true });
  } catch {
    fail('DEPENDENCY_PACKAGE_UNSAFE');
  }
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) {
    fail('DEPENDENCY_PACKAGE_UNSAFE');
  }
  let canonical;
  try {
    canonical = await realpath(checkout);
  } catch {
    fail('DEPENDENCY_PACKAGE_UNSAFE');
  }
  if (canonical !== checkout) {
    fail('DEPENDENCY_PACKAGE_UNSAFE');
  }
  const discovered = await discoverManifests(checkout);
  const gathered = await gatherInputFiles(checkout, discovered.packages, {
    allowMissingRootBunLock: true,
  });
  const dependencyCount = discovered.packages.reduce(
    (count, pkg) => count + dependencyEntries(pkg.manifest).length,
    0
  );
  if (dependencyCount > MAX_DEPENDENCIES) {
    fail('DEPENDENCY_MANIFEST_INVALID');
  }
  const endDiscovered = await discoverManifests(checkout);
  const endGathered = await gatherInputFiles(checkout, endDiscovered.packages, {
    allowMissingRootBunLock: true,
  });
  if (
    !same(gathered.files, endGathered.files) ||
    gathered.linkerMode !== endGathered.linkerMode ||
    !same(
      discovered.packages.map((pkg) => [pkg.id, pkg.directoryIdentity]),
      endDiscovered.packages.map((pkg) => [pkg.id, pkg.directoryIdentity])
    )
  ) {
    fail('DEPENDENCY_INPUTS_CHANGED');
  }
  const rootAfter = await lstat(checkout, { bigint: true }).catch(() => null);
  if (
    !rootAfter?.isDirectory() ||
    rootAfter.isSymbolicLink() ||
    !same(checkoutStatIdentity(rootInfo), checkoutStatIdentity(rootAfter)) ||
    (await realpath(checkout).catch(() => null)) !== canonical
  ) {
    fail('CHECKOUT_CHANGED');
  }
  const inputs = {
    bunVersion,
    dependencyCount,
    files: gathered.files,
    linkerMode: gathered.linkerMode,
    platform: { arch: process.arch, platform: process.platform },
    version: INPUT_VERSION,
    workspaceCount: Math.max(0, discovered.packages.length - 1),
  };
  inputs.digest = digestJson(inputs);
  if (!validInstallInputs(inputs)) {
    fail('DEPENDENCY_INPUTS_UNKNOWN');
  }
  return inputs;
}

function validFingerprint(value) {
  return (
    exactKeys(value, ['bytes', 'key', 'present', 'role', 'sha256']) &&
    Number.isSafeInteger(value.bytes) &&
    value.bytes >= 0 &&
    value.bytes <= MAX_LOCK_BYTES &&
    SHA256.test(value.key) &&
    typeof value.present === 'boolean' &&
    ['config', 'lock', 'manifest'].includes(value.role) &&
    (value.present ? SHA256.test(value.sha256) : value.sha256 === null)
  );
}

function validViewRow(value) {
  if (!(isPlainObject(value) && SHA256.test(value.key))) {
    return false;
  }
  if (value.status === 'optional-omitted') {
    return (
      (exactKeys(value, ['key', 'status']) ||
        exactKeys(value, ['key', 'nodeModules', 'status'])) &&
      (value.nodeModules === undefined ||
        validNodeModulesEvidence(value.nodeModules))
    );
  }
  return (
    exactKeys(value, ['key', 'links', 'nodeModules', 'package', 'status']) &&
    ['installed', 'platform-skipped'].includes(value.status) &&
    validNodeModulesEvidence(value.nodeModules) &&
    validPackageEvidence(value.package) &&
    Array.isArray(value.links) &&
    value.links.length <= MAX_SYMLINKS &&
    value.links.every(validLinkEvidence)
  );
}

function validNodeModulesEvidence(value) {
  return (
    exactKeys(value, ['identity', 'key']) &&
    SHA256.test(value.key) &&
    validStatIdentity(value.identity)
  );
}

function validPackageEvidence(value) {
  return (
    exactKeys(value, ['identity', 'key', 'metadataDigest']) &&
    SHA256.test(value.key) &&
    validStatIdentity(value.identity) &&
    SHA256.test(value.metadataDigest)
  );
}

function validLinkEvidence(value) {
  return (
    exactKeys(value, ['identity', 'key', 'target']) &&
    SHA256.test(value.key) &&
    SHA256.test(value.target) &&
    validStatIdentity(value.identity)
  );
}

function validInputs(inputs) {
  if (
    !exactKeys(inputs, [
      'bunVersion',
      'dependencyCount',
      'digest',
      'files',
      'installMode',
      'linkerMode',
      'noDependencies',
      'platform',
      'sharedConsumerDigest',
      'sharedView',
      'version',
      'view',
      'workspaceCount',
    ]) ||
    inputs.version !== INPUT_VERSION ||
    typeof inputs.bunVersion !== 'string' ||
    inputs.bunVersion.length < 1 ||
    inputs.bunVersion.length > 64 ||
    !Number.isSafeInteger(inputs.dependencyCount) ||
    inputs.dependencyCount < 0 ||
    inputs.dependencyCount > MAX_DEPENDENCIES ||
    !Number.isSafeInteger(inputs.workspaceCount) ||
    inputs.workspaceCount < 0 ||
    inputs.workspaceCount > MAX_WORKSPACES ||
    !Array.isArray(inputs.files) ||
    inputs.files.length > MAX_FILES ||
    !inputs.files.every(validFingerprint) ||
    !['none', 'private', 'shared'].includes(inputs.installMode) ||
    !['isolated', 'hoisted', 'unspecified'].includes(inputs.linkerMode) ||
    !exactKeys(inputs.platform, ['arch', 'platform']) ||
    typeof inputs.platform.platform !== 'string' ||
    inputs.platform.platform.length > 64 ||
    typeof inputs.platform.arch !== 'string' ||
    inputs.platform.arch.length > 64 ||
    typeof inputs.noDependencies !== 'boolean' ||
    inputs.noDependencies !== (inputs.dependencyCount === 0) ||
    !Array.isArray(inputs.view) ||
    inputs.view.length !== inputs.dependencyCount ||
    inputs.view.length > MAX_DEPENDENCIES ||
    !inputs.view.every(validViewRow) ||
    (inputs.installMode === 'private' &&
      (inputs.sharedView !== null || inputs.sharedConsumerDigest !== null)) ||
    (inputs.installMode === 'none' &&
      (inputs.dependencyCount !== 0 ||
        inputs.sharedView !== null ||
        inputs.sharedConsumerDigest !== null)) ||
    (inputs.installMode === 'shared' &&
      (inputs.dependencyCount === 0 ||
        inputs.sharedView !== 'shared and healthy' ||
        !SHA256.test(inputs.sharedConsumerDigest))) ||
    !SHA256.test(inputs.digest)
  ) {
    return false;
  }
  const { digest: storedDigest, ...rest } = inputs;
  return digestJson(rest) === storedDigest;
}

function validInstallInputs(inputs) {
  if (
    !exactKeys(inputs, [
      'bunVersion',
      'dependencyCount',
      'digest',
      'files',
      'linkerMode',
      'platform',
      'version',
      'workspaceCount',
    ]) ||
    inputs.version !== INPUT_VERSION ||
    typeof inputs.bunVersion !== 'string' ||
    inputs.bunVersion.length < 1 ||
    inputs.bunVersion.length > 64 ||
    !Number.isSafeInteger(inputs.dependencyCount) ||
    inputs.dependencyCount < 0 ||
    inputs.dependencyCount > MAX_DEPENDENCIES ||
    !Number.isSafeInteger(inputs.workspaceCount) ||
    inputs.workspaceCount < 0 ||
    inputs.workspaceCount > MAX_WORKSPACES ||
    !Array.isArray(inputs.files) ||
    inputs.files.length > MAX_FILES ||
    !inputs.files.every(
      (file) => validFingerprint(file) && (file.present || file.bytes === 0)
    ) ||
    new Set(inputs.files.map((file) => `${file.role}:${file.key}`)).size !==
      inputs.files.length ||
    !['isolated', 'hoisted', 'unspecified'].includes(inputs.linkerMode) ||
    !exactKeys(inputs.platform, ['arch', 'platform']) ||
    typeof inputs.platform.platform !== 'string' ||
    inputs.platform.platform.length > 64 ||
    typeof inputs.platform.arch !== 'string' ||
    inputs.platform.arch.length > 64 ||
    !SHA256.test(inputs.digest)
  ) {
    return false;
  }
  const { digest: storedDigest, ...rest } = inputs;
  return digestJson(rest) === storedDigest;
}

export function validateDependencyInstallInputs(inputs) {
  try {
    return validInstallInputs(inputs);
  } catch {
    return false;
  }
}

function dependencyInputsFilesMatch(beforeFiles, afterFiles, dependencyCount) {
  const fileKey = (file) => `${file.role}:${file.key}`;
  if (
    new Set(beforeFiles.map(fileKey)).size !== beforeFiles.length ||
    new Set(afterFiles.map(fileKey)).size !== afterFiles.length
  ) {
    return false;
  }
  const beforeByKey = new Map(beforeFiles.map((file) => [fileKey(file), file]));
  const afterByKey = new Map(afterFiles.map((file) => [fileKey(file), file]));
  const rootBunLockKeys = new Set([pathKey('bun.lock'), pathKey('bun.lockb')]);
  const hadRootBunLock = beforeFiles.some(
    (file) =>
      file.role === 'lock' && rootBunLockKeys.has(file.key) && file.present
  );
  let generatedRootLock = 0;
  for (const [key, before] of beforeByKey) {
    const after = afterByKey.get(key);
    if (!after) {
      return false;
    }
    if (same(before, after)) {
      continue;
    }
    if (
      hadRootBunLock ||
      before.role !== 'lock' ||
      !rootBunLockKeys.has(before.key) ||
      before.present ||
      !after.present ||
      generatedRootLock !== 0
    ) {
      return false;
    }
    generatedRootLock += 1;
  }
  for (const key of afterByKey.keys()) {
    if (!beforeByKey.has(key)) {
      return false;
    }
  }
  if (dependencyCount > 0 && !hadRootBunLock && generatedRootLock !== 1) {
    return false;
  }
  return true;
}

export function dependencyInstallInputsMatch(before, after) {
  try {
    if (!(validInstallInputs(before) && validInputs(after))) {
      return false;
    }
    return (
      before.bunVersion === after.bunVersion &&
      before.dependencyCount === after.dependencyCount &&
      before.linkerMode === after.linkerMode &&
      same(before.platform, after.platform) &&
      before.version === after.version &&
      before.workspaceCount === after.workspaceCount &&
      dependencyInputsFilesMatch(
        before.files,
        after.files,
        before.dependencyCount
      )
    );
  } catch {
    return false;
  }
}

function validDependencyReceipt(receipt) {
  const receiptKeys = [
    'attemptId',
    'bunVersion',
    'checkoutIdentity',
    'inputDigest',
    'inputs',
    'outcome',
    'receiptDigest',
    'version',
  ];
  if (isPlainObject(receipt) && Object.hasOwn(receipt, 'dependencyFiles')) {
    receiptKeys.push('dependencyFiles');
  }
  if (
    !exactKeys(receipt, receiptKeys) ||
    receipt.version !== RECEIPT_VERSION ||
    !validCheckoutIdentity(receipt.checkoutIdentity) ||
    typeof receipt.attemptId !== 'string' ||
    receipt.attemptId.length < 1 ||
    receipt.attemptId.length > MAX_ATTEMPT_ID ||
    typeof receipt.bunVersion !== 'string' ||
    receipt.bunVersion.length < 1 ||
    receipt.bunVersion.length > 64 ||
    receipt.outcome !== 'completed' ||
    !validInputs(receipt.inputs) ||
    receipt.inputs.bunVersion !== receipt.bunVersion ||
    receipt.inputDigest !== receipt.inputs.digest ||
    (Object.hasOwn(receipt, 'dependencyFiles') &&
      !validDependencyFilesReceipt(
        receipt.dependencyFiles,
        receipt.checkoutIdentity
      )) ||
    !SHA256.test(receipt.inputDigest) ||
    !SHA256.test(receipt.receiptDigest)
  ) {
    return false;
  }
  const { receiptDigest, ...body } = receipt;
  return digestJson(body) === receiptDigest;
}

function validDependencyFilesReceipt(summary, checkoutIdentity) {
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
  if (!isPlainObject(summary)) {
    return false;
  }
  const keys = Object.keys(summary).sort();
  const expected = [
    ...required,
    ...(Object.hasOwn(summary, 'code') ? ['code'] : []),
  ].sort();
  const store = summary.storeIdentity;
  return (
    keys.length === expected.length &&
    keys.every((key, index) => key === expected[index]) &&
    summary.version === 1 &&
    SHA256.test(summary.id) &&
    summary.id === summary.planId &&
    summary.mode === 'hoisted-cow' &&
    typeof summary.repo === 'string' &&
    summary.repo.length > 0 &&
    typeof summary.name === 'string' &&
    summary.name.length > 0 &&
    same(summary.checkoutIdentity, checkoutIdentity) &&
    validCheckoutIdentity(summary.checkoutIdentity) &&
    SHA256.test(summary.inputDigest) &&
    isPlainObject(store) &&
    typeof store.root === 'string' &&
    isAbsolute(store.root) &&
    DECIMAL.test(store.device) &&
    typeof store.mountPath === 'string' &&
    isAbsolute(store.mountPath) &&
    typeof store.executable === 'string' &&
    isAbsolute(store.executable) &&
    store.version === '1.3.14' &&
    store.namespace === 'hoisted/darwin-arm64-bun-1.3.14' &&
    ['completed', 'released'].includes(summary.state) &&
    Number.isSafeInteger(summary.totalFiles) &&
    summary.totalFiles >= 0 &&
    Number.isSafeInteger(summary.completedFiles) &&
    summary.completedFiles === summary.totalFiles &&
    Number.isSafeInteger(summary.retainedOriginalFiles) &&
    summary.retainedOriginalFiles >= 0 &&
    summary.retainedOriginalFiles <= summary.totalFiles &&
    (summary.state !== 'completed' ||
      summary.retainedOriginalFiles === summary.totalFiles) &&
    (summary.state !== 'released' || summary.retainedOriginalFiles === 0) &&
    !Object.hasOwn(summary, 'code') &&
    Number.isSafeInteger(summary.logicalCloneBytes) &&
    summary.logicalCloneBytes >= 0 &&
    summary.physicalSavingsBytes === null &&
    Number.isSafeInteger(summary.createdAt) &&
    summary.createdAt >= 0 &&
    Number.isSafeInteger(summary.updatedAt) &&
    summary.updatedAt >= summary.createdAt &&
    (!Object.hasOwn(summary, 'code') ||
      (typeof summary.code === 'string' && SAFE_CODE.test(summary.code)))
  );
}

function makeReceipt({
  attemptId,
  bunVersion,
  checkoutIdentity,
  inputs,
  dependencyFiles,
}) {
  const receipt = {
    attemptId,
    bunVersion,
    checkoutIdentity: canonicalValue(checkoutIdentity),
    inputDigest: inputs.digest,
    inputs: canonicalValue(inputs),
    outcome: 'completed',
    version: RECEIPT_VERSION,
    ...(dependencyFiles === undefined ? {} : { dependencyFiles }),
  };
  receipt.receiptDigest = digestJson(receipt);
  return receipt;
}

const IMMUTABLE_ENROLLMENT_FIELDS = [
  'version',
  'id',
  'planId',
  'mode',
  'repo',
  'name',
  'checkoutIdentity',
  'inputDigest',
  'storeIdentity',
  'totalFiles',
  'logicalCloneBytes',
  'physicalSavingsBytes',
  'createdAt',
];

function sameImmutableEnrollment(receiptSummary, currentSummary) {
  return IMMUTABLE_ENROLLMENT_FIELDS.every((field) =>
    same(receiptSummary[field], currentSummary[field])
  );
}

function receiptMatchesCurrentEnrollment(
  receipt,
  currentSummary,
  checkoutIdentity
) {
  if (!Object.hasOwn(receipt, 'dependencyFiles')) {
    return true;
  }
  const receiptSummary = receipt.dependencyFiles;
  if (
    !(
      validDependencyFilesReceipt(receiptSummary, checkoutIdentity) &&
      validDependencyFilesReceipt(currentSummary, checkoutIdentity)
    )
  ) {
    return false;
  }
  if (same(currentSummary, receiptSummary)) {
    return true;
  }
  return (
    receiptSummary.state === 'completed' &&
    currentSummary.state === 'released' &&
    currentSummary.updatedAt >= receiptSummary.updatedAt &&
    sameImmutableEnrollment(receiptSummary, currentSummary)
  );
}

function dependencyFilesViewIsCurrent(state, summary) {
  try {
    if (typeof state?.read !== 'function') {
      return false;
    }
    const document = state.read('dependencyFiles');
    const current =
      isPlainObject(document) &&
      document.version === 1 &&
      isPlainObject(document.operations) &&
      isPlainObject(document.views) &&
      same(document.views[`${summary.repo}/${summary.name}`], summary) &&
      same(document.operations[summary.id], summary);
    if (current) {
      rememberDependencyGuard(
        `dependency-files-view:${summary.repo}/${summary.name}`,
        () => {
          try {
            const latest = state.read('dependencyFiles');
            return (
              isPlainObject(latest) &&
              latest.version === 1 &&
              isPlainObject(latest.operations) &&
              isPlainObject(latest.views) &&
              same(latest.views[`${summary.repo}/${summary.name}`], summary) &&
              same(latest.operations[summary.id], summary)
            );
          } catch {
            return false;
          }
        }
      );
    }
    return current;
  } catch {
    return false;
  }
}

function dependencyFilesReceiptIsCurrent(state, summary, checkoutIdentity) {
  return (
    validDependencyFilesReceipt(summary, checkoutIdentity) &&
    dependencyFilesViewIsCurrent(state, summary)
  );
}

function readinessEnrollmentMatches(
  receipt,
  dependencyFiles,
  checkoutIdentity,
  state
) {
  return (
    receiptMatchesCurrentEnrollment(
      receipt,
      dependencyFiles,
      checkoutIdentity
    ) &&
    (!Object.hasOwn(receipt, 'dependencyFiles') ||
      dependencyFilesViewIsCurrent(state, dependencyFiles))
  );
}

function freezeJson(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) {
      freezeJson(child);
    }
    Object.freeze(value);
  }
  return value;
}

export async function observeDependencyInputs({
  wtDir,
  bunVersion = Bun.version,
  sharing,
  state,
} = {}) {
  try {
    return {
      inputs: await observeInputs({ bunVersion, sharing, state, wtDir }),
      ok: true,
    };
  } catch (error) {
    return refusal(error);
  }
}

export async function observeDependencyInstallInputs({
  wtDir,
  bunVersion = Bun.version,
} = {}) {
  try {
    return {
      inputs: await observeInstallInputs({ bunVersion, wtDir }),
      ok: true,
    };
  } catch (error) {
    return refusal(error);
  }
}

export async function createDependencyReceipt({
  wtDir,
  checkoutIdentity,
  attemptId,
  bunVersion = Bun.version,
  sharing,
  state,
  inputs,
  installInputs,
  dependencyFiles,
} = {}) {
  try {
    if (
      typeof attemptId !== 'string' ||
      attemptId.length < 1 ||
      attemptId.length > MAX_ATTEMPT_ID ||
      !validCheckoutIdentity(checkoutIdentity)
    ) {
      fail('CHECKOUT_IDENTITY_INVALID');
    }
    const checkout = await currentCheckout(wtDir, checkoutIdentity);
    const fresh = await observeInputs({
      bunVersion,
      sharing,
      state,
      wtDir: checkout,
    });
    if (inputs !== undefined && !(validInputs(inputs) && same(inputs, fresh))) {
      fail('DEPENDENCY_INPUTS_CHANGED');
    }
    if (
      installInputs !== undefined &&
      !dependencyInstallInputsMatch(installInputs, fresh)
    ) {
      fail('DEPENDENCY_INPUTS_CHANGED');
    }
    if (
      dependencyFiles !== undefined &&
      !dependencyFilesReceiptIsCurrent(state, dependencyFiles, checkoutIdentity)
    ) {
      fail('DEPENDENCY_VIEW_UNKNOWN');
    }
    const receipt = makeReceipt({
      attemptId,
      bunVersion,
      checkoutIdentity,
      inputs: fresh,
      ...(dependencyFiles === undefined
        ? {}
        : { dependencyFiles: canonicalValue(dependencyFiles) }),
    });
    if (!validDependencyReceipt(receipt)) {
      fail('DEPENDENCY_RECEIPT_INVALID');
    }
    return { ok: true, receipt: freezeJson(receipt) };
  } catch (error) {
    return refusal(error);
  }
}

export function inspectDependencyReadiness({
  wtDir,
  checkoutIdentity,
  record,
  bunVersion = Bun.version,
  sharing,
  state,
  dependencyFiles,
} = {}) {
  return withDependencyCheckpoint(async () => {
    try {
      if (!isPlainObject(record)) {
        fail('SETUP_NOT_COMPLETED');
      }
      if (record.state !== 'completed' || record.outcome !== 'completed') {
        fail('SETUP_NOT_COMPLETED');
      }
      const receipt = record.dependencyReceipt;
      if (receipt === undefined) {
        fail('DEPENDENCY_READINESS_UNVERIFIED');
      }
      if (!validDependencyReceipt(receipt)) {
        fail('DEPENDENCY_RECEIPT_INVALID');
      }
      if (
        !readinessEnrollmentMatches(
          receipt,
          dependencyFiles,
          checkoutIdentity,
          state
        )
      ) {
        fail('DEPENDENCY_VIEW_UNKNOWN');
      }
      if (
        !(
          validCheckoutIdentity(checkoutIdentity) &&
          same(checkoutIdentity, record.checkoutIdentity) &&
          same(checkoutIdentity, receipt.checkoutIdentity)
        ) ||
        typeof record.attemptId !== 'string' ||
        record.attemptId !== receipt.attemptId
      ) {
        fail('SETUP_ATTEMPT_MISMATCH');
      }
      await currentCheckout(wtDir, checkoutIdentity);
      const observed = await observeInputs({
        bunVersion,
        sharing,
        state,
        wtDir,
      });
      if (
        bunVersion !== receipt.bunVersion ||
        !same(observed, receipt.inputs) ||
        observed.digest !== receipt.inputDigest
      ) {
        fail('DEPENDENCY_INPUTS_CHANGED');
      }
      return {
        identity: {
          inputDigest: receipt.inputDigest,
          receiptDigest: receipt.receiptDigest,
          version: RECEIPT_VERSION,
        },
        ok: true,
        state: 'ready',
      };
    } catch (error) {
      return refusal(error);
    }
  });
}

export function validateDependencyReceipt(receipt) {
  try {
    return validDependencyReceipt(receipt);
  } catch {
    return false;
  }
}
