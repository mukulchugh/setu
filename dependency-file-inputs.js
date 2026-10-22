import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { lstat, open, opendir, realpath, stat } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const GIT_OUTPUT_LIMIT = 32 * 1024 * 1024;
const MAX_DISCOVERED_PATHS = 200_000;
const MAX_JSON_INPUT_BYTES = 4 * 1024 * 1024;
const READ_CHUNK_BYTES = 256 * 1024;
// POSIX open flags are bit fields, not boolean operators.
// biome-ignore lint/suspicious/noBitwiseOperators: Required O_RDONLY and O_NOFOLLOW flag combination.
const NOFOLLOW_READ_FLAGS = fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW;
const JSONC_WHITESPACE = /\s/;
const SHA256 = /^[a-f0-9]{64}$/;
const HEAD_PATTERN = /^[a-f0-9]{40}([a-f0-9]{24})?$/;
const TOML_SECTION_PATTERN = /^\[([A-Za-z0-9_.-]+)\]$/;
const TOML_LINKER_ASSIGNMENT_PATTERN = /^linker\s*=/;
const TOML_LINKER_PATTERN = /^linker\s*=\s*(['"])(hoisted|isolated)\1\s*$/;
const TOML_LINKER_KEY_PATTERN = /(?:^|\.)linker\s*=/;
const TOML_LINES_PATTERN = /\r?\n/;
const SUPPORTED_LOCKFILE = 'bun.lock';
const OTHER_LOCKFILES = new Set([
  'bun.lockb',
  'package-lock.json',
  'npm-shrinkwrap.json',
  'pnpm-lock.yaml',
  'pnpm-lock.yml',
  'yarn.lock',
  'deno.lock',
]);
const UNREAD_CONFIG_FILES = new Set([
  '.npmrc',
  '.yarnrc',
  '.yarnrc.yml',
  '.pnpmfile.cjs',
]);
const FILE_IDENTITY_FIELDS = [
  'dev',
  'ino',
  'mode',
  'uid',
  'gid',
  'size',
  'mtimeNs',
  'ctimeNs',
];

function inputError(code, message, cause) {
  return Object.assign(new Error(message, cause ? { cause } : undefined), {
    code,
  });
}

function equalFileIdentity(left, right) {
  return FILE_IDENTITY_FIELDS.every((field) => left[field] === right[field]);
}

function toSafeInteger(value, code, message) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0) {
    throw inputError(code, message);
  }
  return number;
}

function stripOneLineEnding(text) {
  if (text.endsWith('\r\n')) {
    return text.slice(0, -2);
  }
  if (text.endsWith('\n') || text.endsWith('\r')) {
    return text.slice(0, -1);
  }
  return text;
}

async function runGit(checkout, args) {
  try {
    const { stdout } = await exec('git', ['-C', checkout, ...args], {
      encoding: 'buffer',
      env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
      maxBuffer: GIT_OUTPUT_LIMIT,
      timeout: 15_000,
    });
    return stdout;
  } catch (cause) {
    throw inputError(
      'DEPENDENCY_INPUT_GIT_FAILED',
      'Cannot establish a stable Git input snapshot',
      cause
    );
  }
}

function parseNulPaths(output) {
  if (output.length === 0) {
    return [];
  }
  if (output.at(-1) !== 0) {
    throw inputError(
      'DEPENDENCY_INPUT_GIT_OUTPUT_INVALID',
      'Git returned an incomplete path listing'
    );
  }

  const paths = [];
  let start = 0;
  for (let index = 0; index < output.length; index += 1) {
    if (output[index] !== 0) {
      continue;
    }
    const bytes = output.subarray(start, index);
    const path = bytes.toString('utf8');
    if (!Buffer.from(path, 'utf8').equals(bytes)) {
      throw inputError(
        'DEPENDENCY_INPUT_PATH_ENCODING_UNSUPPORTED',
        'A Git input path cannot be represented as UTF-8'
      );
    }
    if (!path || path.startsWith('/') || path.includes('\\')) {
      throw inputError(
        'DEPENDENCY_INPUT_PATH_INVALID',
        'Git returned an unsupported input path'
      );
    }
    const components = path.split('/');
    if (
      components.some(
        (component) => !component || component === '.' || component === '..'
      )
    ) {
      throw inputError(
        'DEPENDENCY_INPUT_PATH_INVALID',
        'Git returned a path outside the checkout'
      );
    }
    paths.push(path);
    start = index + 1;
  }
  if (paths.length > MAX_DISCOVERED_PATHS) {
    throw inputError(
      'DEPENDENCY_INPUT_TOO_MANY_PATHS',
      'The checkout contains too many dependency input paths to snapshot safely'
    );
  }
  return [...new Set(paths)].sort(comparePath);
}

function comparePath(left, right) {
  if (left < right) {
    return -1;
  }
  if (left > right) {
    return 1;
  }
  return 0;
}

function isRelevantPath(path) {
  const components = path.split('/');
  if (components.includes('.git') || components.includes('node_modules')) {
    return false;
  }
  const basename = components.at(-1);
  return (
    basename === 'package.json' ||
    basename === 'bunfig.toml' ||
    basename === SUPPORTED_LOCKFILE ||
    components.includes('patches')
  );
}

function rejectUnknownPackageInputs(paths) {
  for (const path of paths) {
    const basename = path.split('/').at(-1);
    if (OTHER_LOCKFILES.has(basename)) {
      throw inputError(
        'DEPENDENCY_INPUT_LOCK_UNSUPPORTED',
        'The checkout contains a lockfile format outside the supported Bun lock'
      );
    }
    if (UNREAD_CONFIG_FILES.has(basename)) {
      throw inputError(
        'DEPENDENCY_INPUT_CONFIG_UNSUPPORTED',
        'The checkout contains an external package-manager config whose values are not part of this snapshot'
      );
    }
    if (basename === SUPPORTED_LOCKFILE && path !== SUPPORTED_LOCKFILE) {
      throw inputError(
        'DEPENDENCY_INPUT_LOCK_UNSUPPORTED',
        'Only the checkout-root bun.lock is supported'
      );
    }
  }
}

async function assertNoSymlinkDirectory(checkout, relativeDirectory) {
  if (!relativeDirectory) {
    return;
  }
  let current = checkout;
  // Each ancestor must be checked before resolving the next component.
  for (const component of relativeDirectory.split('/')) {
    current = join(current, component);
    // This ancestor must be verified before the next component is joined.
    // biome-ignore lint/performance/noAwaitInLoops: Sequential no-follow validation prevents symlink traversal.
    const info = await lstat(current).catch((cause) => {
      throw inputError(
        'DEPENDENCY_INPUT_CHANGED',
        'A dependency input directory changed during discovery',
        cause
      );
    });
    if (info.isSymbolicLink()) {
      throw inputError(
        'DEPENDENCY_INPUT_SYMLINK',
        'Dependency inputs cannot traverse workspace symlinks'
      );
    }
    if (!info.isDirectory()) {
      throw inputError(
        'DEPENDENCY_INPUT_PATH_INVALID',
        'A dependency input ancestor is not a directory'
      );
    }
  }
}

function packageDirectoriesFrom(files) {
  return files
    .filter((file) => file.path.split('/').at(-1) === 'package.json')
    .map((file) => file.path.split('/').slice(0, -1).join('/'));
}

function collectCandidateDirectories(packageDirectories) {
  const candidateDirectories = new Set(['']);
  for (const packageDirectory of packageDirectories) {
    let current = packageDirectory;
    while (current) {
      candidateDirectories.add(current);
      current = current.split('/').slice(0, -1).join('/');
    }
  }
  return [...candidateDirectories].sort(comparePath);
}

async function inspectVisibleConfig(checkout, directory, basename, listed) {
  const relativePath = directory ? `${directory}/${basename}` : basename;
  let info;
  try {
    info = await lstat(join(checkout, ...relativePath.split('/')));
  } catch (error) {
    if (error.code === 'ENOENT') {
      return;
    }
    throw inputError(
      'DEPENDENCY_INPUT_CONFIG_UNKNOWN',
      'A package-manager config could not be inspected',
      error
    );
  }
  if (info.isSymbolicLink() || !info.isFile()) {
    throw inputError(
      'DEPENDENCY_INPUT_CONFIG_UNSUPPORTED',
      'Package-manager configs must be ordinary files'
    );
  }
  if (basename !== 'bunfig.toml') {
    throw inputError(
      'DEPENDENCY_INPUT_CONFIG_UNSUPPORTED',
      'The checkout contains an external package-manager config whose values are not part of this snapshot'
    );
  }
  if (!listed.has(relativePath)) {
    throw inputError(
      'DEPENDENCY_INPUT_CONFIG_IGNORED',
      'A Bun config is ignored by Git and cannot be included in a stable input snapshot'
    );
  }
}

async function inspectVisibleLockfile(checkout, directory, basename) {
  const relativePath = directory ? `${directory}/${basename}` : basename;
  try {
    await lstat(join(checkout, ...relativePath.split('/')));
  } catch (error) {
    if (error.code === 'ENOENT') {
      return;
    }
    throw inputError(
      'DEPENDENCY_INPUT_LOCK_UNSUPPORTED',
      'An unsupported package-manager lockfile could not be inspected',
      error
    );
  }
  throw inputError(
    'DEPENDENCY_INPUT_LOCK_UNSUPPORTED',
    'The checkout contains a lockfile format outside the supported Bun lock'
  );
}

async function validateVisibleInputsForDirectory(checkout, directory, listed) {
  await assertNoSymlinkDirectory(checkout, directory);
  await Promise.all(
    ['bunfig.toml', '.npmrc', '.yarnrc', '.yarnrc.yml', '.pnpmfile.cjs'].map(
      (basename) => inspectVisibleConfig(checkout, directory, basename, listed)
    )
  );
  await Promise.all(
    [...OTHER_LOCKFILES].map((basename) =>
      inspectVisibleLockfile(checkout, directory, basename)
    )
  );
}

async function assertKnownVisibleInputs(checkout, files, allPaths) {
  const listed = new Set(allPaths);
  const packageDirectories = packageDirectoriesFrom(files);
  for (const directory of collectCandidateDirectories(packageDirectories)) {
    // Candidate directories are bounded and deterministic for stable refusal details.
    // biome-ignore lint/performance/noAwaitInLoops: Ordered validation bounds simultaneous filesystem probes.
    await validateVisibleInputsForDirectory(checkout, directory, listed);
  }

  const patchDirectories = new Set();
  let inspectedPatchEntries = 0;
  for (const packageDirectory of packageDirectories) {
    let current = packageDirectory;
    while (current) {
      patchDirectories.add(`${current}/patches`);
      current = current.split('/').slice(0, -1).join('/');
    }
    patchDirectories.add('patches');
  }
  // Patch tree traversal verifies every entry and retains deterministic order.
  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Nested symlink, type, depth, and tracked-path checks form one fail-closed safety protocol.
  async function walkPatchDirectory(relativeDirectory, depth = 0) {
    if (depth > 32) {
      throw inputError(
        'DEPENDENCY_INPUT_PATCH_TREE_TOO_DEEP',
        'A Bun patch directory exceeds the supported depth'
      );
    }
    const absoluteDirectory = join(checkout, ...relativeDirectory.split('/'));
    const directory = await opendir(absoluteDirectory).catch((cause) => {
      throw inputError(
        'DEPENDENCY_INPUT_PATCH_UNKNOWN',
        'A Bun patch directory could not be inspected',
        cause
      );
    });
    try {
      for await (const entry of directory) {
        inspectedPatchEntries += 1;
        if (inspectedPatchEntries > MAX_DISCOVERED_PATHS) {
          throw inputError(
            'DEPENDENCY_INPUT_TOO_MANY_PATHS',
            'The checkout contains too many Bun patch entries to snapshot safely'
          );
        }
        if (entry.name === '.git' || entry.name === 'node_modules') {
          continue;
        }
        const relativePath = `${relativeDirectory}/${entry.name}`;
        if (entry.isSymbolicLink()) {
          throw inputError(
            'DEPENDENCY_INPUT_SYMLINK',
            'Bun patch inputs cannot traverse symlinks'
          );
        }
        if (entry.isDirectory()) {
          await walkPatchDirectory(relativePath, depth + 1);
          continue;
        }
        if (!entry.isFile()) {
          throw inputError(
            'DEPENDENCY_INPUT_PATCH_UNKNOWN',
            'Bun patch inputs must be ordinary files'
          );
        }
        if (!listed.has(relativePath)) {
          throw inputError(
            'DEPENDENCY_INPUT_PATCH_IGNORED',
            'A Bun patch file is ignored by Git and cannot be included in a stable input snapshot'
          );
        }
      }
    } catch (cause) {
      if (cause.code?.startsWith('DEPENDENCY_INPUT_')) {
        throw cause;
      }
      throw inputError(
        'DEPENDENCY_INPUT_PATCH_UNKNOWN',
        'A Bun patch directory changed during discovery',
        cause
      );
    }
  }
  for (const relativeDirectory of [...patchDirectories].sort(comparePath)) {
    // Check each patch root's ancestors before walking its entries.
    // biome-ignore lint/performance/noAwaitInLoops: Sequential checks prevent walking through changed ancestors.
    await assertNoSymlinkDirectory(
      checkout,
      relativeDirectory.split('/').slice(0, -1).join('/')
    );
    let info;
    try {
      info = await lstat(join(checkout, ...relativeDirectory.split('/')));
    } catch (error) {
      if (error.code === 'ENOENT') {
        continue;
      }
      throw inputError(
        'DEPENDENCY_INPUT_PATCH_UNKNOWN',
        'A Bun patch directory could not be inspected',
        error
      );
    }
    if (info.isSymbolicLink()) {
      throw inputError(
        'DEPENDENCY_INPUT_SYMLINK',
        'Bun patch inputs cannot traverse symlinks'
      );
    }
    if (!info.isDirectory()) {
      throw inputError(
        'DEPENDENCY_INPUT_PATCH_UNKNOWN',
        'Bun patch inputs must be contained in ordinary directories'
      );
    }
    await walkPatchDirectory(relativeDirectory);
  }
}

async function assertNoSymlinkPath(checkout, relativePath, expectedLeaf) {
  const components = relativePath.split('/');
  let current = checkout;
  for (let index = 0; index < components.length; index += 1) {
    current = join(current, components[index]);
    let info;
    try {
      // Resolve and verify each ancestor before touching the child path.
      // biome-ignore lint/performance/noAwaitInLoops: Sequential no-follow checks prevent symlink traversal.
      info = await lstat(current, { bigint: true });
    } catch (cause) {
      throw inputError(
        'DEPENDENCY_INPUT_CHANGED',
        'A dependency input disappeared during snapshot',
        cause
      );
    }
    if (info.isSymbolicLink()) {
      throw inputError(
        'DEPENDENCY_INPUT_SYMLINK',
        'Dependency inputs cannot traverse symlinks'
      );
    }
    const isLeaf = index === components.length - 1;
    if (!(isLeaf || info.isDirectory())) {
      throw inputError(
        'DEPENDENCY_INPUT_PATH_INVALID',
        'A dependency input path has a non-directory ancestor'
      );
    }
    if (isLeaf && !info.isFile()) {
      throw inputError(
        'DEPENDENCY_INPUT_FILE_INVALID',
        'Dependency inputs must be regular files'
      );
    }
    if (expectedLeaf && isLeaf && !expectedLeaf(info)) {
      throw inputError(
        'DEPENDENCY_INPUT_FILE_INVALID',
        'A dependency input is not owned by the current user or has multiple links'
      );
    }
  }
  return current;
}

function statSnapshot(info) {
  return Object.fromEntries(
    FILE_IDENTITY_FIELDS.map((field) => [field, info[field]])
  );
}

function isRegularFileMode(mode) {
  // POSIX mode type bits distinguish regular files from directories and links.
  // biome-ignore lint/suspicious/noBitwiseOperators: Required POSIX stat mode mask.
  return (mode & 0o170000n) === 0o100000n;
}

async function readStableInput(
  checkout,
  relativePath,
  { captureText = false } = {}
) {
  const filePath = await assertNoSymlinkPath(
    checkout,
    relativePath,
    (info) =>
      info.uid === BigInt(process.getuid()) &&
      info.nlink === 1n &&
      isRegularFileMode(info.mode)
  );
  const beforePath = await realpath(filePath).catch((cause) => {
    throw inputError(
      'DEPENDENCY_INPUT_CHANGED',
      'A dependency input path changed during snapshot',
      cause
    );
  });
  const expectedPath = resolve(checkout, ...relativePath.split('/'));
  if (beforePath !== expectedPath) {
    throw inputError(
      'DEPENDENCY_INPUT_SYMLINK',
      'Dependency inputs must remain inside the canonical checkout'
    );
  }

  let handle;
  const noFollow = fsConstants.O_NOFOLLOW;
  if (!Number.isInteger(noFollow)) {
    throw inputError(
      'DEPENDENCY_INPUT_NOFOLLOW_UNAVAILABLE',
      'This platform cannot safely open dependency inputs without following symlinks'
    );
  }
  try {
    // O_NOFOLLOW is an OS flag combined with O_RDONLY in NOFOLLOW_READ_FLAGS.
    handle = await open(filePath, NOFOLLOW_READ_FLAGS);
    const before = await handle.stat({ bigint: true });
    const pathInfo = await lstat(filePath, { bigint: true });
    if (
      !(
        before.isFile() &&
        equalFileIdentity(statSnapshot(before), statSnapshot(pathInfo))
      ) ||
      before.uid !== BigInt(process.getuid()) ||
      before.nlink !== 1n ||
      before.size > BigInt(Number.MAX_SAFE_INTEGER)
    ) {
      throw inputError(
        'DEPENDENCY_INPUT_CHANGED',
        'A dependency input changed before it could be read'
      );
    }
    if (captureText && before.size > BigInt(MAX_JSON_INPUT_BYTES)) {
      throw inputError(
        'DEPENDENCY_INPUT_TOO_LARGE',
        'A package manifest or Bun config exceeds the supported size limit'
      );
    }

    const digest = createHash('sha256');
    const captured = captureText ? [] : null;
    const chunk = Buffer.allocUnsafe(READ_CHUNK_BYTES);
    let position = 0;
    while (position < Number(before.size)) {
      const length = Math.min(READ_CHUNK_BYTES, Number(before.size) - position);
      // Positional reads must preserve the byte sequence.
      // biome-ignore lint/performance/noAwaitInLoops: Sequential bounded hashing reads preserve content and race detection.
      const { bytesRead } = await handle.read(chunk, 0, length, position);
      if (bytesRead !== length) {
        throw inputError(
          'DEPENDENCY_INPUT_CHANGED',
          'A dependency input changed while it was being read'
        );
      }
      const bytes = chunk.subarray(0, bytesRead);
      digest.update(bytes);
      captured?.push(Buffer.from(bytes));
      position += bytesRead;
    }

    const after = await handle.stat({ bigint: true });
    const afterPathInfo = await lstat(filePath, { bigint: true });
    const afterPath = await realpath(filePath).catch(() => null);
    if (
      !(
        equalFileIdentity(statSnapshot(before), statSnapshot(after)) &&
        equalFileIdentity(statSnapshot(before), statSnapshot(afterPathInfo))
      ) ||
      afterPath !== expectedPath
    ) {
      throw inputError(
        'DEPENDENCY_INPUT_CHANGED',
        'A dependency input changed during snapshot'
      );
    }

    return {
      hash: digest.digest('hex'),
      path: relativePath,
      size: Number(before.size),
      ...(captured ? { text: decodeUtf8(Buffer.concat(captured)) } : {}),
    };
  } catch (error) {
    if (error.code?.startsWith('DEPENDENCY_INPUT_')) {
      throw error;
    }
    throw inputError(
      'DEPENDENCY_INPUT_READ_FAILED',
      'A dependency input could not be read consistently',
      error
    );
  } finally {
    await handle?.close().catch(() => {
      // A close failure cannot change the completed read result.
    });
  }
}

function decodeUtf8(bytes) {
  const text = bytes.toString('utf8');
  if (!Buffer.from(text, 'utf8').equals(bytes)) {
    throw inputError(
      'DEPENDENCY_INPUT_TEXT_ENCODING_UNSUPPORTED',
      'A package manifest, Bun lock, or Bun config is not valid UTF-8'
    );
  }
  return text;
}

function parseJsonInput(snapshot, label) {
  try {
    const value = JSON.parse(snapshot.text);
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error('expected an object');
    }
    return value;
  } catch (cause) {
    throw inputError(
      'DEPENDENCY_INPUT_JSON_INVALID',
      `The ${label} is not a supported JSON object`,
      cause
    );
  }
}

function copyJsonString(text, start) {
  let escaped = false;
  for (let index = start + 1; index < text.length; index += 1) {
    const char = text[index];
    if (escaped) {
      escaped = false;
    } else if (char === '\\') {
      escaped = true;
    } else if (char === '"') {
      return { end: index, text: text.slice(start, index + 1) };
    }
  }
  throw new SyntaxError('unterminated JSONC string');
}

function stripJsoncComments(text) {
  let output = '';
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (char === '"') {
      const string = copyJsonString(text, index);
      output += string.text;
      index = string.end;
    } else if (char === '/' && text[index + 1] === '/') {
      index += 2;
      while (
        index < text.length &&
        text[index] !== '\n' &&
        text[index] !== '\r'
      ) {
        index += 1;
      }
      output += '\n';
    } else if (char === '/' && text[index + 1] === '*') {
      const end = text.indexOf('*/', index + 2);
      if (end < 0) {
        throw new SyntaxError('unterminated JSONC comment');
      }
      output += ' ';
      index = end + 1;
    } else {
      output += char;
    }
  }
  return output;
}

function removeTrailingJsonCommas(text) {
  let output = '';
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (char === '"') {
      const string = copyJsonString(text, index);
      output += string.text;
      index = string.end;
      continue;
    }
    if (char !== ',') {
      output += char;
      continue;
    }
    let next = index + 1;
    while (JSONC_WHITESPACE.test(text[next] ?? '')) {
      next += 1;
    }
    if (text[next] !== '}' && text[next] !== ']') {
      output += char;
    }
  }
  return output;
}

function parseJsoncFallback(text) {
  return JSON.parse(removeTrailingJsonCommas(stripJsoncComments(text)));
}

function parseBunLock(snapshot) {
  try {
    const value =
      typeof Bun.JSONC?.parse === 'function'
        ? Bun.JSONC.parse(snapshot.text)
        : parseJsoncFallback(snapshot.text);
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error('expected an object');
    }
    return value;
  } catch (cause) {
    throw inputError(
      'DEPENDENCY_INPUT_JSON_INVALID',
      'The Bun lock is not a supported JSONC object',
      cause
    );
  }
}

function stripTomlComment(line) {
  let quote = null;
  let escaped = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (quote === '"' && char === '\\') {
      escaped = true;
      continue;
    }
    if (quote) {
      if (char === quote) {
        quote = null;
      }
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
    } else if (char === '#') {
      return line.slice(0, index);
    }
  }
  return line;
}

function parseBunfigLinker(text) {
  let section = '';
  let linker;
  let found = false;
  for (const rawLine of text.split(TOML_LINES_PATTERN)) {
    const line = stripTomlComment(rawLine).trim();
    if (!line) {
      continue;
    }
    const sectionMatch = TOML_SECTION_PATTERN.exec(line);
    if (sectionMatch) {
      const [, sectionValue] = sectionMatch;
      section = sectionValue;
      continue;
    }
    const hasLinkerKey = TOML_LINKER_KEY_PATTERN.test(line);
    if (!hasLinkerKey) {
      continue;
    }
    if (section !== 'install' || !TOML_LINKER_ASSIGNMENT_PATTERN.test(line)) {
      throw inputError(
        'DEPENDENCY_INPUT_LINKER_UNKNOWN',
        'A Bun config contains a linker declaration in an unsupported form'
      );
    }
    const value = TOML_LINKER_PATTERN.exec(line);
    if (!value || found) {
      throw inputError(
        'DEPENDENCY_INPUT_LINKER_UNKNOWN',
        'A Bun config contains an ambiguous linker declaration'
      );
    }
    const [, , linkerValue] = value;
    linker = linkerValue;
    found = true;
  }
  if (found) {
    return linker;
  }
  return null;
}

function inputKind(basename, path) {
  if (basename === 'package.json') {
    return 'manifest';
  }
  if (basename === 'bunfig.toml') {
    return 'bunfig';
  }
  return path === SUPPORTED_LOCKFILE ? 'lock' : 'patch';
}

function resolveLinker(rootConfig, configs) {
  const rootDeclaration = rootConfig
    ? parseBunfigLinker(rootConfig.text)
    : null;
  const nestedDeclarations = configs
    .filter((snapshot) => snapshot.path !== 'bunfig.toml')
    .map((snapshot) => parseBunfigLinker(snapshot.text))
    .filter(Boolean);
  const declarations = [rootDeclaration, ...nestedDeclarations].filter(Boolean);
  if (declarations.some((value) => value !== 'hoisted')) {
    throw inputError(
      'DEPENDENCY_INPUT_LINKER_UNSUPPORTED',
      'Only hoisted Bun installs are supported by this dependency store'
    );
  }
  if (!rootDeclaration) {
    throw inputError(
      'DEPENDENCY_INPUT_LINKER_UNKNOWN',
      'The root Bun config must explicitly select the hoisted linker'
    );
  }
  return rootDeclaration;
}

// This discovery protocol validates root, Git state, required inputs, and paths
// as one ordered snapshot; splitting it could accept a mixed checkout state.
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Ordered snapshot validation rejects inconsistent Git and filesystem inputs.
async function discoverCheckout(checkout) {
  let canonical;
  try {
    canonical = await realpath(checkout);
  } catch (cause) {
    throw inputError(
      'DEPENDENCY_INPUT_CHECKOUT_INVALID',
      'The checkout path is missing or unavailable',
      cause
    );
  }
  const checkoutInfo = await stat(canonical, { bigint: true }).catch(
    (cause) => {
      throw inputError(
        'DEPENDENCY_INPUT_CHECKOUT_INVALID',
        'The checkout is not a readable directory',
        cause
      );
    }
  );
  if (!checkoutInfo.isDirectory()) {
    throw inputError(
      'DEPENDENCY_INPUT_CHECKOUT_INVALID',
      'The checkout is not a directory'
    );
  }

  const topLevelOutput = await runGit(canonical, [
    'rev-parse',
    '--show-toplevel',
  ]);
  const topLevel = stripOneLineEnding(topLevelOutput.toString('utf8'));
  if (topLevel !== canonical) {
    throw inputError(
      'DEPENDENCY_INPUT_CHECKOUT_NOT_ROOT',
      'Dependency inputs must be captured from the Git checkout root'
    );
  }
  const headOutput = await runGit(canonical, ['rev-parse', '--verify', 'HEAD']);
  const head = stripOneLineEnding(headOutput.toString('utf8'));
  if (!HEAD_PATTERN.test(head)) {
    throw inputError(
      'DEPENDENCY_INPUT_HEAD_INVALID',
      'Git did not return a supported checkout revision'
    );
  }
  const allPaths = parseNulPaths(
    await runGit(canonical, [
      'ls-files',
      '--cached',
      '--others',
      '--exclude-standard',
      '-z',
    ])
  );
  rejectUnknownPackageInputs(allPaths);
  const relevant = allPaths.filter(isRelevantPath);
  if (!relevant.includes('package.json')) {
    throw inputError(
      'DEPENDENCY_INPUT_ROOT_MANIFEST_MISSING',
      'The checkout-root package manifest is missing or ignored'
    );
  }
  if (!relevant.includes(SUPPORTED_LOCKFILE)) {
    throw inputError(
      'DEPENDENCY_INPUT_LOCK_MISSING',
      'The checkout-root Bun lock is missing or ignored'
    );
  }
  for (const [path, missingCode, missingMessage] of [
    [
      'package.json',
      'DEPENDENCY_INPUT_ROOT_MANIFEST_MISSING',
      'The checkout-root package manifest is missing',
    ],
    [
      SUPPORTED_LOCKFILE,
      'DEPENDENCY_INPUT_LOCK_MISSING',
      'The checkout-root Bun lock is missing',
    ],
  ]) {
    try {
      // Verify required root paths in sequence to stop at the first invalid input.
      // biome-ignore lint/performance/noAwaitInLoops: Ordered checks preserve deterministic refusal and validate required files before reads.
      const info = await lstat(join(canonical, path));
      if (info.isSymbolicLink() || !info.isFile()) {
        throw inputError(
          path === SUPPORTED_LOCKFILE
            ? 'DEPENDENCY_INPUT_LOCK_INVALID'
            : 'DEPENDENCY_INPUT_FILE_INVALID',
          'Required root dependency inputs must be regular files'
        );
      }
    } catch (cause) {
      if (cause.code?.startsWith('DEPENDENCY_INPUT_')) {
        throw cause;
      }
      if (cause.code === 'ENOENT') {
        throw inputError(missingCode, missingMessage, cause);
      }
      throw inputError(
        'DEPENDENCY_INPUT_FILE_INVALID',
        'A required root dependency input could not be inspected',
        cause
      );
    }
  }
  const files = [];
  for (const path of relevant) {
    const basename = path.split('/').at(-1);
    files.push({ kind: inputKind(basename, path), path });
  }
  await assertKnownVisibleInputs(canonical, files, allPaths);
  return {
    allPaths,
    canonical,
    checkoutInfo,
    files,
    head,
  };
}

function isWithin(root, path) {
  return path === root || path.startsWith(`${root}${sep}`);
}

async function discoverRoots(checkout, device, files) {
  const packageDirectories = files
    .filter((file) => file.kind === 'manifest')
    .map((file) => {
      const parts = file.path.split('/');
      parts.pop();
      return parts.join('/');
    });
  const roots = new Set();
  for (const packageDirectory of packageDirectories) {
    const relativeRoot = packageDirectory
      ? `${packageDirectory}/node_modules`
      : 'node_modules';
    let info;
    try {
      // Each installed root is checked before its canonical path is trusted.
      // biome-ignore lint/performance/noAwaitInLoops: Sequential root validation bounds filesystem probes.
      info = await lstat(join(checkout, ...relativeRoot.split('/')), {
        bigint: true,
      });
    } catch (error) {
      if (error.code === 'ENOENT') {
        continue;
      }
      throw inputError(
        'DEPENDENCY_INPUT_ROOT_INVALID',
        'An installed dependency root could not be inspected',
        error
      );
    }
    if (info.isSymbolicLink()) {
      throw inputError(
        'DEPENDENCY_INPUT_SYMLINK',
        'Installed dependency roots cannot be symlinks'
      );
    }
    if (!info.isDirectory() || info.dev !== device) {
      throw inputError(
        'DEPENDENCY_INPUT_ROOT_INVALID',
        'Installed dependency roots must be directories on the checkout volume'
      );
    }
    const absoluteRoot = join(checkout, ...relativeRoot.split('/'));
    const canonicalRoot = await realpath(absoluteRoot).catch((cause) => {
      throw inputError(
        'DEPENDENCY_INPUT_ROOT_INVALID',
        'An installed dependency root changed during discovery',
        cause
      );
    });
    if (canonicalRoot !== absoluteRoot || !isWithin(checkout, canonicalRoot)) {
      throw inputError(
        'DEPENDENCY_INPUT_SYMLINK',
        'Installed dependency roots must remain inside the checkout'
      );
    }
    roots.add(relativeRoot);
  }
  return [...roots].sort(comparePath);
}

export async function dependencyFileInputs(checkout) {
  if (typeof checkout !== 'string' || !checkout) {
    throw inputError(
      'DEPENDENCY_INPUT_CHECKOUT_INVALID',
      'A checkout path is required'
    );
  }
  if (typeof process.getuid !== 'function') {
    throw inputError(
      'DEPENDENCY_INPUT_PLATFORM_UNSUPPORTED',
      'The current platform cannot verify dependency input ownership'
    );
  }
  const discovered = await discoverCheckout(checkout);
  const checkoutPath = discovered.canonical;
  const device = toSafeInteger(
    discovered.checkoutInfo.dev,
    'DEPENDENCY_INPUT_DEVICE_INVALID',
    'The checkout volume identity is not representable'
  );
  const inputFiles = [];
  for (const file of discovered.files) {
    // Sequential snapshots cap descriptors and expose drift before the next input.
    // biome-ignore lint/performance/noAwaitInLoops: Ordered bounded snapshots preserve stable input validation.
    const snapshot = await readStableInput(checkoutPath, file.path, {
      captureText:
        file.kind === 'manifest' ||
        file.kind === 'bunfig' ||
        file.kind === 'lock',
    });
    if (
      BigInt(device) !==
      (
        await lstat(join(checkoutPath, ...file.path.split('/')), {
          bigint: true,
        })
      ).dev
    ) {
      throw inputError(
        'DEPENDENCY_INPUT_VOLUME_MISMATCH',
        'Dependency inputs must reside on the checkout volume'
      );
    }
    inputFiles.push({ ...file, ...snapshot });
  }

  const manifestFile = inputFiles.find((file) => file.path === 'package.json');
  const lockFile = inputFiles.find((file) => file.path === SUPPORTED_LOCKFILE);
  if (!(manifestFile && lockFile)) {
    throw inputError(
      'DEPENDENCY_INPUT_CHANGED',
      'A required root dependency input disappeared during snapshot'
    );
  }
  parseBunLock(lockFile);
  for (const file of inputFiles.filter((entry) => entry.kind === 'manifest')) {
    parseJsonInput(file, 'package manifest');
  }
  const configs = inputFiles.filter((file) => file.kind === 'bunfig');
  const rootConfig = configs.find((file) => file.path === 'bunfig.toml');
  const linker = resolveLinker(rootConfig, configs);
  const roots = await discoverRoots(
    checkoutPath,
    discovered.checkoutInfo.dev,
    inputFiles
  );

  const finalDiscovery = await discoverCheckout(checkoutPath);
  if (
    finalDiscovery.head !== discovered.head ||
    finalDiscovery.allPaths.length !== discovered.allPaths.length ||
    finalDiscovery.allPaths.some(
      (path, index) => path !== discovered.allPaths[index]
    )
  ) {
    throw inputError(
      'DEPENDENCY_INPUT_CHANGED',
      'The checkout inputs changed while their snapshot was being captured'
    );
  }

  const lockfileHash = lockFile.hash;
  const digestPayload = {
    files: inputFiles
      .map(({ kind, path, size, hash }) => [kind, path, size, hash])
      .sort((left, right) => comparePath(left[1], right[1])),
    head: discovered.head,
    linker,
    version: 1,
  };
  const inputDigest = createHash('sha256')
    .update(JSON.stringify(digestPayload))
    .digest('hex');
  if (!(SHA256.test(lockfileHash) && SHA256.test(inputDigest))) {
    throw inputError(
      'DEPENDENCY_INPUT_DIGEST_INVALID',
      'Dependency input digests could not be established'
    );
  }
  return {
    checkout: checkoutPath,
    device,
    head: discovered.head,
    inputDigest,
    linker,
    lockfileHash,
    roots,
  };
}
