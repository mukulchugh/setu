// Local writer coordination. Kept independent of lib.js so a hook never
// probes Homebrew, loads Setu config, contacts the portal, or fetches updates.
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  closeSync,
  lstatSync,
  openSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';

export const WRITER_STALE_MS = 2 * 60 * 60 * 1000;
export const WRITER_HEARTBEAT_REFRESH_MS = 5 * 60 * 1000;
export const WRITER_AGENT_NAME = /^[a-z0-9-]{1,40}$/;
const trailingNewlinePattern = /\r?\n$/;
const claimHeadPattern = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const sha256Pattern = /^[a-f0-9]{64}$/;
const lockOwnerPattern = /^[1-9][0-9]*\n?$/;

function hasAsciiControlCharacter(value) {
  return [...value].some((character) => {
    const code = character.codePointAt(0);
    return code <= 0x1f || code === 0x7f;
  });
}

function gitRead(dir, args, timeout = 5000) {
  // Inherited Git variables must not redirect metadata reads to another
  // index/repository. Optional locks off also keeps status read-only.
  const env = { ...process.env };
  for (const key of [
    'GIT_DIR',
    'GIT_WORK_TREE',
    'GIT_COMMON_DIR',
    'GIT_INDEX_FILE',
  ]) {
    delete env[key];
  }
  return execFileSync('git', ['--no-optional-locks', '-C', dir, ...args], {
    encoding: 'utf8',
    env,
    maxBuffer: 16 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout,
  });
}

// Files, directories, and not-yet-created files all resolve to their own
// worktree. Following existing ancestors handles symlinked project paths.
function existingWriterDirectory(path) {
  let dir = resolve(path);
  let links = 0;
  for (;;) {
    try {
      dir = realpathSync(dir);
      if (!statSync(dir).isDirectory()) {
        dir = dirname(dir);
      }
      return dir;
    } catch (e) {
      if (e.code !== 'ENOENT' && e.code !== 'ENOTDIR') {
        throw e;
      }
      // A dangling file/directory link may still point into a claimed
      // worktree. Check that target before falling back to an ancestor.
      if (isWriterPathLink(dir)) {
        links += 1;
        if (links > 40) {
          // biome-ignore lint/style/useErrorCause: Keep this existing path-only error free of underlying filesystem details.
          throw new Error(`Too many symlinks at ${path}`);
        }
        dir = resolve(dirname(dir), readlinkSync(dir));
        continue;
      }
      const parent = dirname(dir);
      if (parent === dir) {
        // biome-ignore lint/style/useErrorCause: Keep this existing path-only error free of underlying filesystem details.
        throw new Error(`No git worktree for ${path}`);
      }
      dir = parent;
    }
  }
}

function isWriterPathLink(path) {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch (error) {
    if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') {
      throw error;
    }
    return false;
  }
}

export function writerWorktree(path = process.cwd()) {
  let dir = existingWriterDirectory(path);
  // Read Git's own worktree marker instead of spawning git on every tool
  // call. A cold Git executable can use most of the hook's 200 ms budget.
  for (;;) {
    const marker = join(dir, '.git');
    let stat;
    try {
      stat = statSync(marker);
    } catch (e) {
      if (e.code !== 'ENOENT') {
        throw e;
      }
    }
    if (stat) {
      return writerMarkerLocation(dir, marker, stat);
    }

    // A bare repository has HEAD and objects directly in its root, not a
    // worktree marker. Hooks should leave paths there alone.
    try {
      if (
        statSync(join(dir, 'HEAD')).isFile() &&
        statSync(join(dir, 'objects')).isDirectory()
      ) {
        return null;
      }
    } catch (e) {
      if (e.code !== 'ENOENT' && e.code !== 'ENOTDIR') {
        throw e;
      }
    }
    const parent = dirname(dir);
    if (parent === dir) {
      return null;
    }
    dir = parent;
  }
}

function writerMarkerLocation(dir, marker, stat) {
  let gitDir = marker;
  if (!stat.isDirectory()) {
    const reference = readFileSync(marker, 'utf8').replace(
      trailingNewlinePattern,
      ''
    );
    if (!reference.startsWith('gitdir: ')) {
      throw new Error(`Invalid git worktree marker at ${marker}`);
    }
    gitDir = resolve(dir, reference.slice(8));
  }
  gitDir = realpathSync(gitDir);
  if (!statSync(join(gitDir, 'HEAD')).isFile()) {
    throw new Error(`Invalid git directory at ${gitDir}`);
  }
  return {
    claimPath: join(gitDir, 'setu-writer.json'),
    gitDir,
    wtDir: dir,
  };
}

function shortText(value, label, max) {
  if (
    typeof value !== 'string' ||
    !value.trim() ||
    value.length > max ||
    hasAsciiControlCharacter(value)
  ) {
    throw new Error(
      `${label} must be nonempty text of at most ${max} characters on one line`
    );
  }
}

function validateOwner({ agent, session, task, pid }) {
  if (typeof agent !== 'string' || !WRITER_AGENT_NAME.test(agent)) {
    throw new Error(
      'agent must be 1 to 40 lowercase letters, digits, or dashes'
    );
  }
  shortText(session, 'session', 200);
  shortText(task, 'task', 300);
  if (!Number.isInteger(pid) || pid <= 0 || pid > 2_147_483_647) {
    throw new Error('pid must be a positive process ID');
  }
}

function readClaim(claimPath) {
  let raw;
  try {
    raw = readFileSync(claimPath, 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') {
      return null;
    }
    throw e;
  }
  try {
    const claim = JSON.parse(raw);
    validateOwner(claim);
    if (
      typeof claim.started_at !== 'string' ||
      !Number.isFinite(Date.parse(claim.started_at)) ||
      typeof claim.heartbeat !== 'string' ||
      !Number.isFinite(Date.parse(claim.heartbeat)) ||
      !(claim.branch === null || typeof claim.branch === 'string') ||
      !(claim.head === null || claimHeadPattern.test(claim.head)) ||
      !Number.isInteger(claim.baseline?.count) ||
      claim.baseline.count < 0 ||
      !sha256Pattern.test(claim.baseline?.hash)
    ) {
      throw new Error('invalid claim');
    }
    return claim;
  } catch {
    // Corrupt or partially hand-written ownership is never "unclaimed".
    // biome-ignore lint/style/useErrorCause: Claim parsing exposes only this fixed public error, not raw JSON or validation details.
    throw new Error(
      `Invalid writer claim at ${claimPath}; inspect it before editing`
    );
  }
}

export function writerClaimStale(claim, now = Date.now()) {
  if (now - Date.parse(claim.heartbeat) < WRITER_STALE_MS) {
    return false;
  }
  try {
    process.kill(claim.pid, 0);
    return false;
  } catch (e) {
    return e.code === 'ESRCH';
  } // EPERM and unknown errors are not proof of death.
}

function heldMessage(claim) {
  return `Worktree held by ${claim.agent} (session ${claim.session}, pid ${claim.pid}): ${claim.task}. Use \`setu new <repo> <branch>\` for a separate worktree.`;
}

// Returns the lock's content when its recorded owner no longer exists.
function deadLockContent(lockPath) {
  let raw;
  try {
    raw = readFileSync(lockPath, 'utf8');
  } catch {
    return null;
  }
  if (!lockOwnerPattern.test(raw)) {
    return null;
  }
  try {
    process.kill(Number(raw.trim()), 0);
    return null;
  } catch (e) {
    return e.code === 'ESRCH' ? raw : null;
  }
}

function lockOwnerIsDead(lockPath) {
  return deadLockContent(lockPath) !== null;
}

function removeClaimTemporary(path) {
  try {
    unlinkSync(path);
  } catch (error) {
    if (error.code !== 'ENOENT') {
      throw error;
    }
  }
}

function removeDeadClaimLock(lockPath, dead) {
  // Remove only the same dead owner observed before the retry.
  if (deadLockContent(lockPath) === dead) {
    removeClaimTemporary(lockPath);
  }
}

function acquireClaimLock(claimPath, lockPath, skipIfBusy) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      return openSync(lockPath, 'wx', 0o600);
    } catch (e) {
      if (e.code !== 'EEXIST') {
        throw e;
      }
      const dead = attempt === 0 ? deadLockContent(lockPath) : null;
      if (dead !== null) {
        removeDeadClaimLock(lockPath, dead);
        continue;
      }
      if (skipIfBusy) {
        return;
      }
      const claim = readClaim(claimPath);
      // biome-ignore lint/style/useErrorCause: Busy ownership exposes the claim message, not the raw lock-open error.
      throw new Error(
        claim
          ? heldMessage(claim)
          : `Writer claim operation in progress at ${lockPath}; retry, or use \`setu new <repo> <branch>\` for a separate worktree.`
      );
    }
  }
}

function withClaimLock(claimPath, fn, { skipIfBusy = false } = {}) {
  const lockPath = `${claimPath}.lock`;
  const fd = acquireClaimLock(claimPath, lockPath, skipIfBusy);
  if (fd === undefined) {
    return;
  }
  try {
    writeFileSync(fd, `${process.pid}\n`);
    return fn();
  } finally {
    closeSync(fd);
    unlinkSync(lockPath);
  }
}

function writeClaim(claimPath, claim) {
  const temp = `${claimPath}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temp, `${JSON.stringify(claim, null, 2)}\n`, {
      flag: 'wx',
      mode: 0o600,
    });
    // Readers see one complete snapshot, including during heartbeat refresh.
    renameSync(temp, claimPath);
  } finally {
    try {
      unlinkSync(temp);
    } catch (e) {
      if (e.code !== 'ENOENT') {
        // biome-ignore lint/correctness/noUnsafeFinally: Preserve the existing cleanup failure precedence; swallowing this error would report a clean publication despite an unremoved temporary.
        throw e;
      }
    }
  }
}

export function writerBaseline(wtDir) {
  const status = gitRead(wtDir, [
    '-c',
    'core.fsmonitor=false',
    'status',
    '--porcelain',
  ]);
  return {
    count: status.split('\n').filter(Boolean).length,
    hash: createHash('sha256').update(status).digest('hex'),
  };
}

function optionalGitRef(wtDir, args) {
  try {
    return gitRead(wtDir, args).trim() || null;
  } catch (e) {
    if (e.status === 1) {
      return null;
    }
    throw e;
  }
}

export function claimWriter(path, owner) {
  validateOwner(owner);
  const location = writerWorktree(path);
  if (!location) {
    throw new Error(`Cannot resolve git worktree for ${path}`);
  }
  const { wtDir, claimPath } = location;
  // biome-ignore assist/source/useSortedKeys: Preserve branch, HEAD, then baseline Git observation order and the existing persisted claim layout.
  const initial = {
    branch: optionalGitRef(wtDir, [
      'symbolic-ref',
      '--quiet',
      '--short',
      'HEAD',
    ]),
    head: optionalGitRef(wtDir, ['rev-parse', '--verify', '--quiet', 'HEAD']),
    baseline: writerBaseline(wtDir),
  };
  return withClaimLock(claimPath, () => {
    const previous = readClaim(claimPath);
    const sameSession = previous?.session === owner.session;
    if (previous && !sameSession && !writerClaimStale(previous)) {
      throw new Error(heldMessage(previous));
    }
    const now = new Date().toISOString();
    const tookOverFrom =
      previous && !sameSession
        ? {
            agent: previous.agent,
            heartbeat: previous.heartbeat,
            session: previous.session,
            task: previous.task,
          }
        : undefined;
    const record = sameSession ? previous : { started_at: now, ...initial };
    const { agent, session, task, pid } = owner;
    // biome-ignore assist/source/useSortedKeys: Preserve the existing serialized writer-claim field order across heartbeat refreshes.
    const claim = { ...record, agent, session, task, pid, heartbeat: now };
    writeClaim(claimPath, claim);
    return {
      claim,
      ok: true,
      wtDir,
      ...(tookOverFrom ? { tookOverFrom } : {}),
    };
  });
}

export function releaseWriter(path, session, { force = false } = {}) {
  shortText(session, 'session', 200);
  const location = writerWorktree(path);
  if (!location) {
    throw new Error(`Cannot resolve git worktree for ${path}`);
  }
  const { wtDir, claimPath } = location;
  return withClaimLock(claimPath, () => {
    let claim;
    try {
      claim = readClaim(claimPath);
    } catch (e) {
      if (!force) {
        throw e;
      }
      unlinkSync(claimPath);
      return { forced: true, ok: true, released: true, wtDir };
    }
    if (claim && claim.session !== session) {
      throw new Error(heldMessage(claim));
    }
    if (claim) {
      unlinkSync(claimPath);
    }
    return { ok: true, released: !!claim, wtDir };
  });
}

export function checkWriter(path, session) {
  shortText(session, 'session', 200);
  const location = writerWorktree(path);
  if (!location) {
    return { claim: null, ok: true, wtDir: null };
  }
  const { wtDir, claimPath } = location;
  const claim = readClaim(claimPath);
  const ok = !claim || claim.session === session;
  if (
    claim?.session === session &&
    Date.now() - Date.parse(claim.heartbeat) >= WRITER_HEARTBEAT_REFRESH_MS
  ) {
    withClaimLock(
      claimPath,
      () => {
        const current = readClaim(claimPath);
        if (
          current?.session === session &&
          Date.now() - Date.parse(current.heartbeat) >=
            WRITER_HEARTBEAT_REFRESH_MS
        ) {
          writeClaim(claimPath, {
            ...current,
            heartbeat: new Date().toISOString(),
          });
        }
      },
      {
        skipIfBusy: true,
      }
    );
  }
  return { claim, ok, wtDir, ...(ok ? {} : { error: heldMessage(claim) }) };
}

export function listWriterClaims(paths, { includeStale = false } = {}) {
  const rows = [];
  const seen = new Set();
  for (const path of paths) {
    try {
      const location = writerWorktree(path);
      if (!location) {
        continue;
      }
      const { wtDir, claimPath } = location;
      if (seen.has(claimPath)) {
        continue;
      }
      seen.add(claimPath);
      const claim = readClaim(claimPath);
      if (!claim) {
        continue;
      }
      const stale = writerClaimStale(claim);
      if (includeStale || !stale) {
        rows.push({ wtDir, ...claim, stale });
      }
    } catch (e) {
      rows.push({ error: e.message, path, unreadable: true });
    }
  }
  return rows;
}

export function writerClaimChecks(paths) {
  const stale = [],
    changed = [],
    unreadable = [],
    staleLocks = [];
  for (const path of paths) {
    try {
      const location = writerWorktree(path);
      if (!location) {
        continue;
      }
      const { claimPath } = location;
      const lockPath = `${claimPath}.lock`;
      if (lockOwnerIsDead(lockPath)) {
        staleLocks.push(lockPath);
      }
      const claim = readClaim(claimPath);
      if (!claim) {
        continue;
      }
      if (writerClaimStale(claim)) {
        stale.push(
          `${location.wtDir} (${claim.agent}, session ${claim.session})`
        );
      }
      const baseline = writerBaseline(location.wtDir);
      if (
        baseline.count !== claim.baseline.count ||
        baseline.hash !== claim.baseline.hash
      ) {
        changed.push(location.wtDir);
      }
    } catch (e) {
      unreadable.push(e.message);
    }
  }
  return [
    {
      fix: unreadable.join('; ') || undefined,
      name: 'writer claims readable',
      ok: !unreadable.length,
    },
    {
      fix: staleLocks.length
        ? `Remove stale writer claim locks after confirming their owners are gone: ${staleLocks.join(', ')}`
        : undefined,
      name: 'no stale writer claim locks',
      ok: !staleLocks.length,
    },
    {
      fix: stale.length
        ? `Reclaim with setu claim, or release with the recorded session: ${stale.join(', ')}`
        : undefined,
      name: 'no stale writer claims',
      ok: !stale.length,
    },
    {
      fix: changed.length
        ? `Review changes since claim (the owner's own edits also change this baseline): ${changed.join(', ')}`
        : undefined,
      name: 'writer claim baselines match',
      ok: !changed.length,
    },
  ];
}

// Includes the current repository's sibling worktrees, even without Setu
// registration. The caller adds registered paths/bare repos from lib.js.
export function discoverWriterWorktrees(candidates) {
  const paths = new Set();
  const visited = new Set();
  for (const dir of new Set(candidates)) {
    try {
      const canonical = realpathSync(dir);
      if (visited.has(canonical)) {
        continue;
      }
      visited.add(canonical);
      const raw = gitRead(dir, ['worktree', 'list', '--porcelain', '-z']);
      for (const record of raw.split('\0\0')) {
        addWriterWorktree(record, visited, paths);
      }
    } catch {
      /* Missing registry entries and a cwd outside git are normal. */
    }
  }
  return [...paths].sort();
}

function addWriterWorktree(record, visited, paths) {
  const fields = record.split('\0');
  const path = fields.find((f) => f.startsWith('worktree '))?.slice(9);
  if (path) {
    try {
      const worktreePath = realpathSync(path);
      visited.add(worktreePath);
      if (!fields.includes('bare') && statSync(worktreePath).isDirectory()) {
        paths.add(worktreePath);
      }
    } catch (e) {
      if (e.code !== 'ENOENT') {
        throw e;
      }
    }
  }
}
