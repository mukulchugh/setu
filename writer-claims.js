// Local writer coordination. Kept independent of lib.js so a hook never
// probes Homebrew, loads Setu config, contacts the portal, or fetches updates.
import { execFileSync } from 'child_process';
import {
  statSync, lstatSync, realpathSync, readlinkSync, readFileSync, writeFileSync, openSync, closeSync,
  unlinkSync, renameSync,
} from 'fs';
import { dirname, join, resolve } from 'path';
import { createHash, randomUUID } from 'crypto';

export const WRITER_AGENTS = ['claude-code', 'codex', 'cursor', 'human'];
export const WRITER_STALE_MS = 2 * 60 * 60 * 1000;

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
    const parent = dirname(dir);
    if (parent === dir) throw new Error(`Cannot resolve git worktree for ${path}`);
    dir = parent;
  }
}

function shortText(value, label, max) {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\x00-\x1f\x7f]/.test(value)) {
    throw new Error(`${label} must be nonempty text of at most ${max} characters on one line`);
  }
}

function validateOwner({ agent, session, task, pid }) {
  if (!WRITER_AGENTS.includes(agent)) throw new Error(`agent must be one of: ${WRITER_AGENTS.join(', ')}`);
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

function withClaimLock(claimPath, fn) {
  const lockPath = `${claimPath}.lock`;
  let fd;
  try { fd = openSync(lockPath, 'wx', 0o600); }
  catch (e) {
    if (e.code !== 'EEXIST') throw e;
    const claim = readClaim(claimPath);
    throw new Error(claim ? heldMessage(claim) : `Writer claim operation in progress at ${lockPath}; retry, or use \`setu new <repo> <branch>\` for a separate worktree.`);
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
  const { wtDir, claimPath } = writerWorktree(path);
  return withClaimLock(claimPath, () => {
    const previous = readClaim(claimPath);
    const sameSession = previous?.session === owner.session;
    if (previous && !sameSession && !writerClaimStale(previous)) throw new Error(heldMessage(previous));
    const now = new Date().toISOString();
    const initial = sameSession ? previous : {
      started_at: now,
      branch: optionalGitRef(wtDir, ['symbolic-ref', '--quiet', '--short', 'HEAD']),
      head: optionalGitRef(wtDir, ['rev-parse', '--verify', '--quiet', 'HEAD']),
      baseline: writerBaseline(wtDir),
    };
    const { agent, session, task, pid } = owner;
    const claim = { ...initial, agent, session, task, pid, heartbeat: now };
    writeClaim(claimPath, claim);
    return { ok: true, wtDir, claim };
  });
}

export function releaseWriter(path, session) {
  shortText(session, 'session', 200);
  const { wtDir, claimPath } = writerWorktree(path);
  return withClaimLock(claimPath, () => {
    const claim = readClaim(claimPath);
    if (claim && claim.session !== session) throw new Error(heldMessage(claim));
    if (claim) unlinkSync(claimPath);
    return { ok: true, wtDir, released: !!claim };
  });
}

export function checkWriter(path, session) {
  shortText(session, 'session', 200);
  const { wtDir, claimPath } = writerWorktree(path);
  const claim = readClaim(claimPath);
  const ok = !claim || claim.session === session;
  return { ok, wtDir, claim, ...(ok ? {} : { error: heldMessage(claim) }) };
}

export function listWriterClaims(paths, { includeStale = false } = {}) {
  const rows = [];
  const seen = new Set();
  for (const path of paths) {
    const { wtDir, claimPath } = writerWorktree(path);
    if (seen.has(claimPath)) continue;
    seen.add(claimPath);
    const claim = readClaim(claimPath);
    if (!claim) continue;
    const stale = writerClaimStale(claim);
    if (includeStale || !stale) rows.push({ wtDir, ...claim, stale });
  }
  return rows;
}

export function writerClaimChecks(paths) {
  const stale = [], changed = [], unreadable = [];
  for (const path of paths) {
    try {
      const [claim] = listWriterClaims([path], { includeStale: true });
      if (!claim) continue;
      if (claim.stale) stale.push(`${claim.wtDir} (${claim.agent}, session ${claim.session})`);
      const baseline = writerBaseline(claim.wtDir);
      if (baseline.count !== claim.baseline.count || baseline.hash !== claim.baseline.hash) changed.push(claim.wtDir);
    } catch (e) { unreadable.push(e.message); }
  }
  return [
    { name: 'writer claims readable', ok: !unreadable.length, fix: unreadable.join('; ') || undefined },
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
