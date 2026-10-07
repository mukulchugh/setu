// Local writer coordination. Kept independent of lib.js so a hook never
// probes Homebrew, loads Setu config, contacts the portal, or fetches updates.
import { execFileSync } from 'child_process';
import {
  statSync, lstatSync, realpathSync, readlinkSync, readFileSync, writeFileSync, openSync, closeSync,
  unlinkSync, renameSync,
} from 'fs';
import { dirname, join, resolve } from 'path';
import { createHash, randomUUID } from 'crypto';

export const WRITER_STALE_MS = 2 * 60 * 60 * 1000;
export const WRITER_HEARTBEAT_REFRESH_MS = 5 * 60 * 1000;
export const WRITER_AGENT_NAME = /^[a-z0-9-]{1,40}$/;

function gitRead(dir, args, timeout = 5000) {
  // Inherited Git variables must not redirect metadata reads to another
  // index/repository. Optional locks off also keeps status read-only.
  const env = { ...process.env };
  for (const key of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_INDEX_FILE']) delete env[key];
  return execFileSync('git', ['--no-optional-locks', '-C', dir, ...args], {
    env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout,
    maxBuffer: 16 * 1024 * 1024,
  });
}

// Files, directories, and not-yet-created files all resolve to their own
// worktree. Following existing ancestors handles symlinked project paths.
export function writerWorktree(path = process.cwd()) {
  let dir = resolve(path);
  let links = 0;
  while (true) {
    try {
      dir = realpathSync(dir);
      if (!statSync(dir).isDirectory()) dir = dirname(dir);
      break;
    } catch (e) {
      if (e.code !== 'ENOENT' && e.code !== 'ENOTDIR') throw e;
      // A dangling file/directory link may still point into a claimed
      // worktree. Check that target before falling back to an ancestor.
      let isLink = false;
      try { isLink = lstatSync(dir).isSymbolicLink(); }
      catch (error) { if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') throw error; }
      if (isLink) {
        if (++links > 40) throw new Error(`Too many symlinks at ${path}`);
        dir = resolve(dirname(dir), readlinkSync(dir));
        continue;
      }
      const parent = dirname(dir);
      if (parent === dir) throw new Error(`No git worktree for ${path}`);
      dir = parent;
    }
  }
  // Read Git's own worktree marker instead of spawning git on every tool
  // call. A cold Git executable can use most of the hook's 200 ms budget.
  while (true) {
    const marker = join(dir, '.git');
    let stat;
    try { stat = statSync(marker); }
    catch (e) { if (e.code !== 'ENOENT') throw e; }
    if (stat) {
      let gitDir = marker;
      if (!stat.isDirectory()) {
        const reference = readFileSync(marker, 'utf8').replace(/\r?\n$/, '');
        if (!reference.startsWith('gitdir: ')) throw new Error(`Invalid git worktree marker at ${marker}`);
        gitDir = resolve(dir, reference.slice(8));
      }
      gitDir = realpathSync(gitDir);
      if (!statSync(join(gitDir, 'HEAD')).isFile()) throw new Error(`Invalid git directory at ${gitDir}`);
      return { wtDir: dir, gitDir, claimPath: join(gitDir, 'setu-writer.json') };
    }
    // A bare repository has HEAD and objects directly in its root, not a
    // worktree marker. Hooks should leave paths there alone.
    try {
      if (statSync(join(dir, 'HEAD')).isFile() && statSync(join(dir, 'objects')).isDirectory()) return null;
    } catch (e) { if (e.code !== 'ENOENT' && e.code !== 'ENOTDIR') throw e; }
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

function shortText(value, label, max) {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\x00-\x1f\x7f]/.test(value)) {
    throw new Error(`${label} must be nonempty text of at most ${max} characters on one line`);
  }
}

function validateOwner({ agent, session, task, pid }) {
  if (typeof agent !== 'string' || !WRITER_AGENT_NAME.test(agent)) {
    throw new Error('agent must be 1 to 40 lowercase letters, digits, or dashes');
  }
  shortText(session, 'session', 200);
  shortText(task, 'task', 300);
  if (!Number.isInteger(pid) || pid <= 0 || pid > 2147483647) throw new Error('pid must be a positive process ID');
}

function readClaim(claimPath) {
  let raw;
  try { raw = readFileSync(claimPath, 'utf8'); }
  catch (e) { if (e.code === 'ENOENT') return null; throw e; }
  try {
    const claim = JSON.parse(raw);
    validateOwner(claim);
    if (typeof claim.started_at !== 'string' || !Number.isFinite(Date.parse(claim.started_at)) ||
        typeof claim.heartbeat !== 'string' || !Number.isFinite(Date.parse(claim.heartbeat)) ||
        !(claim.branch === null || typeof claim.branch === 'string') ||
        !(claim.head === null || /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(claim.head)) ||
        !Number.isInteger(claim.baseline?.count) || claim.baseline.count < 0 ||
        !/^[a-f0-9]{64}$/.test(claim.baseline?.hash)) throw new Error('invalid claim');
    return claim;
  } catch {
    // Corrupt or partially hand-written ownership is never "unclaimed".
    throw new Error(`Invalid writer claim at ${claimPath}; inspect it before editing`);
  }
}

export function writerClaimStale(claim, now = Date.now()) {
  if (now - Date.parse(claim.heartbeat) < WRITER_STALE_MS) return false;
  try { process.kill(claim.pid, 0); return false; }
  catch (e) { return e.code === 'ESRCH'; } // EPERM and unknown errors are not proof of death.
}

function heldMessage(claim) {
  return `Worktree held by ${claim.agent} (session ${claim.session}, pid ${claim.pid}): ${claim.task}. Use \`setu new <repo> <branch>\` for a separate worktree.`;
}

// Returns the lock's content when its recorded owner no longer exists.
function deadLockContent(lockPath) {
  let raw;
  try { raw = readFileSync(lockPath, 'utf8'); }
  catch { return null; }
  if (!/^[1-9][0-9]*\n?$/.test(raw)) return null;
  try { process.kill(Number(raw.trim()), 0); return null; }
  catch (e) { return e.code === 'ESRCH' ? raw : null; }
}

function lockOwnerIsDead(lockPath) {
  return deadLockContent(lockPath) !== null;
}

function withClaimLock(claimPath, fn, { skipIfBusy = false } = {}) {
  const lockPath = `${claimPath}.lock`;
  let fd;
  for (let attempt = 0; attempt < 2; attempt++) {
    try { fd = openSync(lockPath, 'wx', 0o600); break; }
    catch (e) {
      if (e.code !== 'EEXIST') throw e;
      const dead = attempt === 0 ? deadLockContent(lockPath) : null;
      if (dead !== null) {
        // Another process may have broken this lock and taken a fresh one
        // since we looked. Remove it only if it is still the dead owner's.
        if (deadLockContent(lockPath) === dead) {
          try { unlinkSync(lockPath); } catch (error) { if (error.code !== 'ENOENT') throw error; }
        }
        continue;
      }
      if (skipIfBusy) return undefined;
      const claim = readClaim(claimPath);
      throw new Error(claim ? heldMessage(claim) : `Writer claim operation in progress at ${lockPath}; retry, or use \`setu new <repo> <branch>\` for a separate worktree.`);
    }
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
    writeFileSync(temp, JSON.stringify(claim, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    // Readers see one complete snapshot, including during heartbeat refresh.
    renameSync(temp, claimPath);
  } finally {
    try { unlinkSync(temp); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  }
}

export function writerBaseline(wtDir) {
  const status = gitRead(wtDir, ['-c', 'core.fsmonitor=false', 'status', '--porcelain']);
  return {
    count: status.split('\n').filter(Boolean).length,
    hash: createHash('sha256').update(status).digest('hex'),
  };
}

function optionalGitRef(wtDir, args) {
  try { return gitRead(wtDir, args).trim() || null; }
  catch (e) { if (e.status === 1) return null; throw e; }
}

export function claimWriter(path, owner) {
  validateOwner(owner);
  const location = writerWorktree(path);
  if (!location) throw new Error(`Cannot resolve git worktree for ${path}`);
  const { wtDir, claimPath } = location;
  const initial = {
    branch: optionalGitRef(wtDir, ['symbolic-ref', '--quiet', '--short', 'HEAD']),
    head: optionalGitRef(wtDir, ['rev-parse', '--verify', '--quiet', 'HEAD']),
    baseline: writerBaseline(wtDir),
  };
  return withClaimLock(claimPath, () => {
    const previous = readClaim(claimPath);
    const sameSession = previous?.session === owner.session;
    if (previous && !sameSession && !writerClaimStale(previous)) throw new Error(heldMessage(previous));
    const now = new Date().toISOString();
    const tookOverFrom = previous && !sameSession ? {
      agent: previous.agent, session: previous.session, task: previous.task, heartbeat: previous.heartbeat,
    } : undefined;
    const record = sameSession ? previous : { started_at: now, ...initial };
    const { agent, session, task, pid } = owner;
    const claim = { ...record, agent, session, task, pid, heartbeat: now };
    writeClaim(claimPath, claim);
    return { ok: true, wtDir, claim, ...(tookOverFrom ? { tookOverFrom } : {}) };
  });
}

export function releaseWriter(path, session, { force = false } = {}) {
  shortText(session, 'session', 200);
  const location = writerWorktree(path);
  if (!location) throw new Error(`Cannot resolve git worktree for ${path}`);
  const { wtDir, claimPath } = location;
  return withClaimLock(claimPath, () => {
    let claim;
    try { claim = readClaim(claimPath); }
    catch (e) {
      if (!force) throw e;
      unlinkSync(claimPath);
      return { ok: true, wtDir, released: true, forced: true };
    }
    if (claim && claim.session !== session) throw new Error(heldMessage(claim));
    if (claim) unlinkSync(claimPath);
    return { ok: true, wtDir, released: !!claim };
  });
}

export function checkWriter(path, session) {
  shortText(session, 'session', 200);
  const location = writerWorktree(path);
  if (!location) return { ok: true, wtDir: null, claim: null };
  const { wtDir, claimPath } = location;
  const claim = readClaim(claimPath);
  const ok = !claim || claim.session === session;
  if (claim?.session === session && Date.now() - Date.parse(claim.heartbeat) >= WRITER_HEARTBEAT_REFRESH_MS) {
    withClaimLock(claimPath, () => {
      const current = readClaim(claimPath);
      if (current?.session === session && Date.now() - Date.parse(current.heartbeat) >= WRITER_HEARTBEAT_REFRESH_MS) {
        writeClaim(claimPath, { ...current, heartbeat: new Date().toISOString() });
      }
    }, { skipIfBusy: true });
  }
  return { ok, wtDir, claim, ...(ok ? {} : { error: heldMessage(claim) }) };
}

export function listWriterClaims(paths, { includeStale = false } = {}) {
  const rows = [];
  const seen = new Set();
  for (const path of paths) {
    try {
      const location = writerWorktree(path);
      if (!location) continue;
      const { wtDir, claimPath } = location;
      if (seen.has(claimPath)) continue;
      seen.add(claimPath);
      const claim = readClaim(claimPath);
      if (!claim) continue;
      const stale = writerClaimStale(claim);
      if (includeStale || !stale) rows.push({ wtDir, ...claim, stale });
    } catch (e) { rows.push({ path, unreadable: true, error: e.message }); }
  }
  return rows;
}

export function writerClaimChecks(paths) {
  const stale = [], changed = [], unreadable = [], staleLocks = [];
  for (const path of paths) {
    try {
      const location = writerWorktree(path);
      if (!location) continue;
      const { claimPath } = location;
      const lockPath = `${claimPath}.lock`;
      if (lockOwnerIsDead(lockPath)) staleLocks.push(lockPath);
      const claim = readClaim(claimPath);
      if (!claim) continue;
      if (writerClaimStale(claim)) stale.push(`${location.wtDir} (${claim.agent}, session ${claim.session})`);
      const baseline = writerBaseline(location.wtDir);
      if (baseline.count !== claim.baseline.count || baseline.hash !== claim.baseline.hash) changed.push(location.wtDir);
    } catch (e) { unreadable.push(e.message); }
  }
  return [
    { name: 'writer claims readable', ok: !unreadable.length, fix: unreadable.join('; ') || undefined },
    { name: 'no stale writer claim locks', ok: !staleLocks.length, fix: staleLocks.length ? `Remove stale writer claim locks after confirming their owners are gone: ${staleLocks.join(', ')}` : undefined },
    { name: 'no stale writer claims', ok: !stale.length, fix: stale.length ? `Reclaim with setu claim, or release with the recorded session: ${stale.join(', ')}` : undefined },
    { name: 'writer claim baselines match', ok: !changed.length, fix: changed.length ? `Review changes since claim (the owner's own edits also change this baseline): ${changed.join(', ')}` : undefined },
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
      if (visited.has(canonical)) continue;
      visited.add(canonical);
      const raw = gitRead(dir, ['worktree', 'list', '--porcelain', '-z']);
      for (const record of raw.split('\0\0')) {
        const fields = record.split('\0');
        const path = fields.find(f => f.startsWith('worktree '))?.slice(9);
        if (path) {
          try {
            const canonical = realpathSync(path);
            visited.add(canonical);
            if (!fields.includes('bare') && statSync(canonical).isDirectory()) paths.add(canonical);
          } catch (e) { if (e.code !== 'ENOENT') throw e; }
        }
      }
    } catch { /* Missing registry entries and a cwd outside git are normal. */ }
  }
  return [...paths].sort();
}
