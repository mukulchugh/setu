import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, readlink } from 'node:fs/promises';
import { isAbsolute, join, normalize } from 'node:path';
import { promisify } from 'node:util';
import { sha256, toMicro } from './spans-execution-core.js';
import { summarizeProviderOutput } from './spans-execution-provider.js';

// Completion evidence. Two things are checked here and nothing else counts:
// what the process durably did (its recorded exit and its captured output),
// and the exact tree it left behind. A process exiting, or a model saying it
// is done, is only text in the captured output; it never decides a result.

const execFileAsync = promisify(execFile);
const GIT_ENV_KEYS = [
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_COMMON_DIR',
  'GIT_INDEX_FILE',
];
const MAX_TREE_FILES = 50_000;
const MAX_TREE_BYTES = 512 * 1024 * 1024;

async function git(dir, args) {
  const env = { ...process.env };
  for (const key of GIT_ENV_KEYS) {
    delete env[key];
  }
  const { stdout } = await execFileAsync(
    'git',
    ['--no-optional-locks', '-C', dir, ...args],
    { encoding: 'utf8', env, maxBuffer: 64 * 1024 * 1024, timeout: 30_000 }
  );
  return stdout;
}

function hashFile(path) {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    const stream = createReadStream(path);
    stream.on('error', reject);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

const safeRelative = (path) =>
  path.length > 0 &&
  !isAbsolute(path) &&
  !normalize(path).split('/').includes('..');

// One line of the tree digest for one path, or null when the path is of a kind
// whose content cannot be read exactly.
async function describeEntry(wtDir, path) {
  const full = join(wtDir, path);
  let stat;
  try {
    stat = await lstat(full);
  } catch (error) {
    if (error.code === 'ENOENT') {
      return { line: `${path}\0deleted`, size: 0 };
    }
    throw error;
  }
  if (stat.isSymbolicLink()) {
    return { line: `${path}\0link\0${sha256(await readlink(full))}`, size: 0 };
  }
  if (stat.isFile()) {
    // biome-ignore lint/suspicious/noBitwiseOperators: File mode bits are a mask; only the executable bits matter.
    const mode = stat.mode & 0o111 ? 'x' : '-';
    return {
      line: `${path}\0file\0${mode}\0${await hashFile(full)}`,
      size: stat.size,
    };
  }
  return stat.isDirectory() ? { line: `${path}\0directory`, size: 0 } : null;
}

// The content of every tracked and non-ignored file under the checkout, as one
// digest. Unlike a status listing it changes when a file already modified is
// modified again. A tree too large or odd to read exactly is unknown, never a
// digest of part of it.
export async function observeTree(wtDir) {
  const unreadable = { code: 'TREE_UNREADABLE', ok: false };
  try {
    const listing = await git(wtDir, [
      'ls-files',
      '-z',
      '--cached',
      '--others',
      '--exclude-standard',
    ]);
    const paths = [...new Set(listing.split('\0').filter(Boolean))].sort();
    if (paths.length > MAX_TREE_FILES || !paths.every(safeRelative)) {
      return unreadable;
    }
    const lines = [];
    let bytes = 0;
    for (const path of paths) {
      // biome-ignore lint/performance/noAwaitInLoops: Files are read one at a time to keep memory and descriptors bounded.
      const entry = await describeEntry(wtDir, path);
      bytes += entry?.size ?? 0;
      if (!entry || bytes > MAX_TREE_BYTES) {
        return unreadable;
      }
      lines.push(entry.line);
    }
    const head = (await git(wtDir, ['rev-parse', '--verify', 'HEAD'])).trim();
    return {
      bytes,
      digest: sha256(lines.join('\n')),
      files: paths.length,
      head,
      ok: true,
    };
  } catch {
    return unreadable;
  }
}

// What a finished attempt durably shows. `completed` needs a clean exit and a
// provider result that says it succeeded; every other terminal state is
// `failed`. An attempt that is not a clean, fully captured exit has no verdict.
export function classifyTerminal({ attempt, text }) {
  const receipt = attempt?.receipt;
  if (
    !(
      attempt?.status === 'exited' &&
      receipt?.outcome === 'process-exited' &&
      attempt.capture?.complete === true &&
      attempt.capture.artifactId &&
      attempt.exit &&
      typeof text === 'string'
    )
  ) {
    return { verdict: false };
  }
  const { cost, costCheck, init, result, tokens } =
    summarizeProviderOutput(text);
  const clean = attempt.exit.code === 0 && attempt.exit.signal === null;
  // Any cancel request on the attempt means Setu itself asked it to stop. What
  // it printed before exiting is then not a finished job, delivered or not.
  const cancelled = Boolean(attempt.cancel);
  const succeeded =
    clean &&
    !cancelled &&
    result?.isError === false &&
    result.subtype === 'success';
  return {
    cancelled,
    clean,
    costCheck,
    costMicro: cost === null ? null : toMicro(cost),
    init,
    outcome: succeeded ? 'completed' : 'failed',
    // What the provider's own result line said. It is a report, not a check.
    providerResult: result ? (result.subtype ?? 'unspecified') : 'none',
    tokens,
    verdict: true,
  };
}

const MAX_CHANGED_PATHS = 50;

// Paths whose content differs from the commit the work was reviewed against:
// committed changes since that commit, uncommitted edits, and new untracked
// files. Anything that was already dirty before the run appears here too, so
// this is a pointer for the reviewer, not a count of what the worker did.
export async function changedPathsSince(wtDir, baselineHead) {
  try {
    const tracked = await git(wtDir, [
      'diff',
      '--name-only',
      '-z',
      baselineHead,
      '--',
    ]);
    const untracked = await git(wtDir, [
      'ls-files',
      '-z',
      '--others',
      '--exclude-standard',
    ]);
    const all = [...new Set([...tracked.split('\0'), ...untracked.split('\0')])]
      .filter(Boolean)
      .sort();
    return {
      paths: all.slice(0, MAX_CHANGED_PATHS),
      total: all.length,
      truncated: all.length > MAX_CHANGED_PATHS,
    };
  } catch {
    return null;
  }
}

// What the worker's run did to the tree, from two exact observations.
export function describeChange(before, after) {
  return {
    headMoved: before.head !== after.head,
    treeChanged: before.digest !== after.digest,
  };
}
