import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { execFileSync, spawnSync } from 'child_process';
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync,
  renameSync, statSync, symlinkSync, readdirSync, openSync, closeSync,
} from 'fs';
import { join, relative } from 'path';
import { createHash } from 'crypto';
import {
  claimWriter, releaseWriter, checkWriter, writerWorktree, writerBaseline,
  listWriterClaims, writerClaimChecks, writerClaimStale, discoverWriterWorktrees,
  WRITER_STALE_MS,
} from './writer-claims.js';

// Everything, including HOME, Git objects, subprocess logs and temp files,
// stays under this checkout. No real Setu config, worktrees or services.
const cache = join(import.meta.dir, 'node_modules/.cache');
mkdirSync(cache, { recursive: true });
const root = mkdtempSync(join(cache, 'writer-claims-test-'));
const cli = join(import.meta.dir, 'cli.js');
const realGit = Bun.which('git');
const originalEnv = { ...process.env };
const home = join(root, 'home');
const bin = join(root, 'bin');
const commandLog = join(root, 'commands');
let deadPid;
let fixtureNumber = 0;

function shellQuote(value) { return "'" + value.replaceAll("'", "'\\''") + "'"; }
function git(dir, args, input) {
  return execFileSync(realGit, ['-C', dir, ...args], { encoding: 'utf8', input, stdio: ['pipe', 'pipe', 'pipe'] }).trimEnd();
}

beforeAll(async () => {
  for (const dir of [home, bin, join(root, 'tmp')]) mkdirSync(dir);
  // Stop both Git and the hook's filesystem walk at the fixture boundary.
  writeFileSync(join(root, '.git'), 'Not a git worktree\n');
  Object.assign(process.env, {
    HOME: home, TMPDIR: join(root, 'tmp'), PATH: `${bin}:${originalEnv.PATH}`,
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: join(home, 'gitconfig'),
    GIT_CEILING_DIRECTORIES: root,
  });
  for (const key of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_INDEX_FILE']) delete process.env[key];
  writeFileSync(join(bin, 'git'), `#!/bin/sh\nprintf 'git %s\\n' "$*" >> ${shellQuote(commandLog)}\nexec ${shellQuote(realGit)} "$@"\n`, { mode: 0o755 });
  writeFileSync(join(bin, 'brew'), `#!/bin/sh\nprintf 'brew\\n' >> ${shellQuote(commandLog)}\nprintf '/test/brew\\n'\n`, { mode: 0o755 });
  const child = Bun.spawn([process.execPath, '-e', 'process.exit(0)'], { stdout: 'ignore', stderr: 'ignore' });
  deadPid = child.pid;
  await child.exited;
});

afterAll(() => {
  for (const key of Object.keys(process.env)) if (!(key in originalEnv)) delete process.env[key];
  Object.assign(process.env, originalEnv);
  rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const repo = join(root, `folder-${++fixtureNumber}`);
  mkdirSync(repo);
  git(repo, ['init', '--initial-branch=actual/branch']);
  // Seed a tiny tracked file using plumbing, without git add or git commit.
  const blob = git(repo, ['hash-object', '-w', '--stdin'], 'original\n');
  const tree = git(repo, ['mktree'], `100644 blob ${blob}\ttracked.txt\n`);
  const head = git(repo, ['hash-object', '-t', 'commit', '-w', '--stdin'],
    `tree ${tree}\nauthor Fixture <fixture@example.invalid> 1 +0000\ncommitter Fixture <fixture@example.invalid> 1 +0000\n\nfixture\n`);
  git(repo, ['update-ref', 'refs/heads/actual/branch', head]);
  git(repo, ['read-tree', 'HEAD']);
  git(repo, ['checkout-index', '--all']);
  return { repo, head, claimPath: join(repo, '.git', 'setu-writer.json') };
}

function owner(overrides = {}) {
  return { agent: 'codex', session: 'session-a', task: 'Fix redirect', pid: process.pid, ...overrides };
}

function ageClaim(claimPath, overrides = {}) {
  const claim = JSON.parse(readFileSync(claimPath, 'utf8'));
  Object.assign(claim, { heartbeat: new Date(Date.now() - WRITER_STALE_MS - 1000).toISOString() }, overrides);
  writeFileSync(claimPath, JSON.stringify(claim));
  return claim;
}

function run(cwd, ...args) {
  const result = spawnSync(process.execPath, [cli, ...args], { cwd, encoding: 'utf8', env: process.env });
  return { code: result.status, stdout: result.stdout, stderr: result.stderr };
}

describe('writer claim ownership', () => {
  test('records real branch, HEAD, PID, timestamps and exact dirty baseline in the git dir', () => {
    const { repo, head, claimPath } = fixture();
    writeFileSync(join(repo, 'tracked.txt'), 'edited\n');
    writeFileSync(join(repo, 'new.txt'), 'new\n');
    const status = execFileSync(realGit, ['-C', repo, '--no-optional-locks', 'status', '--porcelain'], { encoding: 'utf8' });
    const { ok, claim } = claimWriter(repo, owner());
    expect(ok).toBe(true);
    expect(claim).toMatchObject({ ...owner(), branch: 'actual/branch', head,
      baseline: { count: 2, hash: createHash('sha256').update(status).digest('hex') } });
    expect(Number.isFinite(Date.parse(claim.started_at))).toBe(true);
    expect(claim.heartbeat).toBe(claim.started_at);
    expect(JSON.parse(readFileSync(claimPath, 'utf8'))).toEqual(claim);
    expect(statSync(claimPath).mode & 0o777).toBe(0o600);
    expect(existsSync(join(repo, 'setu-writer.json'))).toBe(false);
  });

  test('same session refreshes heartbeat and PID without resetting the starting baseline', () => {
    const { repo, claimPath } = fixture();
    const first = claimWriter(repo, owner()).claim;
    ageClaim(claimPath, { pid: deadPid });
    writeFileSync(join(repo, 'extra.txt'), 'another edit');
    git(repo, ['symbolic-ref', 'HEAD', 'refs/heads/renamed']);
    const next = claimWriter(repo, owner({ task: 'Still fixing' })).claim;
    expect(next.started_at).toBe(first.started_at);
    expect(next.baseline).toEqual(first.baseline);
    expect(next.branch).toBe(first.branch);
    expect(next.head).toBe(first.head);
    expect(next.pid).toBe(process.pid);
    expect(next.task).toBe('Still fixing');
    expect(Date.now() - Date.parse(next.heartbeat)).toBeLessThan(1000);
  });

  test('another session cannot claim or release, and the owner can release idempotently', () => {
    const { repo, claimPath } = fixture();
    claimWriter(repo, owner());
    const before = readFileSync(claimPath, 'utf8');
    expect(() => claimWriter(repo, owner({ agent: 'claude-code', session: 'b' }))).toThrow('codex (session session-a');
    expect(() => releaseWriter(repo, 'b')).toThrow('setu new');
    expect(readFileSync(claimPath, 'utf8')).toBe(before);
    expect(releaseWriter(repo, 'session-a').released).toBe(true);
    expect(existsSync(claimPath)).toBe(false);
    expect(releaseWriter(repo, 'session-a').released).toBe(false);
  });

  test('stale takeover requires both an old heartbeat and a dead PID, and takes a fresh baseline', () => {
    const { repo, claimPath } = fixture();
    claimWriter(repo, owner({ pid: deadPid }));
    expect(() => claimWriter(repo, owner({ session: 'b' }))).toThrow('held by');
    ageClaim(claimPath, { pid: process.pid });
    expect(() => claimWriter(repo, owner({ session: 'b' }))).toThrow('held by');
    const old = ageClaim(claimPath, { pid: deadPid, started_at: '2020-01-01T00:00:00.000Z' });
    expect(writerClaimStale(old, Date.parse(old.heartbeat) + WRITER_STALE_MS - 1)).toBe(false);
    expect(writerClaimStale(old, Date.parse(old.heartbeat) + WRITER_STALE_MS)).toBe(true);
    writeFileSync(join(repo, 'new.txt'), 'new work');
    expect(checkWriter(repo, 'b').ok).toBe(false);
    expect(() => releaseWriter(repo, 'b')).toThrow('held by');
    const takeover = claimWriter(repo, owner({ agent: 'claude-code', session: 'b' }));
    expect(takeover.claim.session).toBe('b');
    expect(takeover.claim.started_at).not.toBe(old.started_at);
    expect(takeover.claim.baseline.count).toBe(1);
    expect(takeover.tookOverFrom).toEqual({ agent: old.agent, session: old.session, task: old.task, heartbeat: old.heartbeat });
  });

  test('malformed claims and abandoned operation locks fail closed', () => {
    const { repo, claimPath } = fixture();
    writeFileSync(claimPath, '{broken');
    expect(() => claimWriter(repo, owner())).toThrow('Invalid writer claim');
    expect(() => releaseWriter(repo, 'session-a')).toThrow('Invalid writer claim');
    expect(() => checkWriter(repo, 'session-a')).toThrow('Invalid writer claim');
    expect(readFileSync(claimPath, 'utf8')).toBe('{broken');
    rmSync(claimPath);
    writeFileSync(`${claimPath}.lock`, `${deadPid}\n`);
    expect(claimWriter(repo, owner()).ok).toBe(true);
    expect(existsSync(`${claimPath}.lock`)).toBe(false);
  });

  test('accepts validated free-form agent names and rejects invalid ones', () => {
    const { repo, claimPath } = fixture();
    expect(claimWriter(repo, owner({ agent: 'antigravity-2' })).claim.agent).toBe('antigravity-2');
    releaseWriter(repo, 'session-a');
    for (const invalid of [{ agent: 'Uppercase' }, { agent: 'has space' }, { agent: 'x'.repeat(41) }, { pid: 0 }, { pid: -1 }, { session: '' }, { task: '' }, { task: 'x'.repeat(301) }]) {
      expect(() => claimWriter(repo, owner(invalid))).toThrow();
    }
    expect(existsSync(claimPath)).toBe(false);
  });

  test('linked worktrees, nested files, new paths and symlinks resolve to independent claims', () => {
    const { repo } = fixture();
    const linked = join(root, `linked with spaces-${fixtureNumber}`);
    git(repo, ['worktree', 'add', '-b', 'other/branch', linked]);
    mkdirSync(join(linked, 'nested'));
    const alias = join(root, `alias-${fixtureNumber}`);
    symlinkSync(linked, alias);
    claimWriter(repo, owner());
    const claim = claimWriter(join(alias, 'nested', 'new', 'file.js'), owner({ session: 'b' })).claim;
    expect(claim.branch).toBe('other/branch');
    const location = writerWorktree(linked);
    expect(location.gitDir).toContain('/.git/worktrees/');
    expect(existsSync(location.claimPath)).toBe(true);
    writeFileSync(join(linked, '.git'), `gitdir: ${relative(linked, location.gitDir)}\n`);
    expect(checkWriter(join(alias, 'tracked.txt'), 'b').ok).toBe(true);
    expect(checkWriter(repo, 'b').ok).toBe(false);
    expect(listWriterClaims([repo, linked, alias])).toHaveLength(2);
    expect(discoverWriterWorktrees([linked, repo])).toEqual([linked, repo].sort());
  });

  test('detached and unborn HEAD come from git, not directory names', () => {
    const { repo, head } = fixture();
    git(repo, ['checkout', '--detach', head]);
    const detached = claimWriter(repo, owner()).claim;
    expect(detached.branch).toBeNull();
    expect(detached.head).toBe(head);
    releaseWriter(repo, 'session-a');
    git(repo, ['symbolic-ref', 'HEAD', 'refs/heads/unborn']);
    const unborn = claimWriter(repo, owner()).claim;
    expect(unborn.branch).toBe('unborn');
    expect(unborn.head).toBeNull();
  });

  test('file symlinks, including dangling links, check the target worktree owner', () => {
    const a = fixture(), b = fixture();
    claimWriter(a.repo, owner());
    claimWriter(b.repo, owner({ session: 'b' }));
    for (const target of ['tracked.txt', 'new-file.txt', 'new-directory/file.txt']) {
      const link = join(a.repo, target.replaceAll('/', '-'));
      if (existsSync(link)) rmSync(link);
      symlinkSync(join(b.repo, target), link);
      expect(checkWriter(link, 'session-a').ok).toBe(false);
      expect(checkWriter(link, 'b').ok).toBe(true);
      expect(run(a.repo, 'claim-check', link, '--session', 'session-a').code).toBe(2);
    }
  });

  test('simultaneous processes cannot both acquire an unclaimed or stale worktree', async () => {
    for (const stale of [false, true]) {
      const { repo, claimPath } = fixture();
      if (stale) {
        claimWriter(repo, owner({ pid: deadPid }));
        ageClaim(claimPath);
      }
      const attempts = Array.from({ length: 6 }, (_, i) => Bun.spawn([
        process.execPath, cli, 'claim', repo, '--agent', 'codex', '--session', `racer-${i}`,
        '--task', 'Race', '--pid', String(process.pid), '--json',
      ], { cwd: repo, env: process.env, stdout: 'pipe', stderr: 'pipe' }));
      const results = await Promise.all(attempts.map(async child => ({
        code: await child.exited,
        result: JSON.parse(await new Response(child.stdout).text()),
        stderr: await new Response(child.stderr).text(),
      })));
      expect(results.filter(r => r.code === 0)).toHaveLength(1);
      for (const failure of results.filter(r => r.code !== 0)) expect(failure.stderr).toContain('setu new');
      expect(JSON.parse(readFileSync(claimPath, 'utf8')).session).toBe(results.find(r => r.code === 0).result.claim.session);
      expect(existsSync(`${claimPath}.lock`)).toBe(false);
    }
  });

  test('recovers a lock left by a killed process and doctor names it', async () => {
    const { repo, claimPath } = fixture();
    const lockPath = `${claimPath}.lock`;
    const child = Bun.spawn([process.execPath, '-e', `
      const fs = require('fs');
      const fd = fs.openSync(process.argv[1], 'wx', 0o600);
      fs.writeSync(fd, String(process.pid) + '\\n');
      setInterval(() => {}, 1000);
    `, lockPath], { stdout: 'ignore', stderr: 'ignore' });
    for (let i = 0; i < 50 && !existsSync(lockPath); i++) await Bun.sleep(10);
    expect(existsSync(lockPath)).toBe(true);
    child.kill('SIGKILL');
    await child.exited;
    const checks = writerClaimChecks([repo]);
    expect(checks.find(check => check.name === 'no stale writer claim locks')).toMatchObject({ ok: false });
    expect(checks.find(check => check.name === 'no stale writer claim locks').fix).toContain(lockPath);
    expect(claimWriter(repo, owner()).ok).toBe(true);
    expect(existsSync(lockPath)).toBe(false);
  });
});

describe('CLI and hook contract', () => {
  test('claim, refresh, conflict, release and list emit valid JSON with correct exit codes', () => {
    const { repo } = fixture();
    const args = ['claim', '--json', '--agent', 'codex', '--session', 'cli-a', '--task', 'CLI test'];
    const claimed = run(repo, ...args);
    expect(claimed.code).toBe(0);
    expect(JSON.parse(claimed.stdout).claim.pid).toBe(process.pid);
    expect(claimed.stderr).toBe('');
    expect(run(repo, ...args).code).toBe(0);
    const conflict = run(repo, 'claim', repo, '--agent', 'cursor', '--session', 'other', '--task', 'Conflict', '--json');
    expect(conflict.code).toBe(1);
    expect(JSON.parse(conflict.stdout).ok).toBe(false);
    expect(conflict.stderr).toContain('codex (session cli-a');
    const list = run(repo, 'claims', '--json');
    expect(list.code).toBe(0);
    expect(JSON.parse(list.stdout)).toEqual([expect.objectContaining({ session: 'cli-a', wtDir: repo, stale: false })]);
    const denied = run(repo, 'release', '--session', 'other', '--json');
    expect(denied.code).toBe(1);
    expect(JSON.parse(denied.stdout).ok).toBe(false);
    const released = run(repo, 'release', '--session', 'cli-a', '--json');
    expect(released.code).toBe(0);
    expect(JSON.parse(released.stdout).released).toBe(true);
    expect(JSON.parse(run(repo, 'claims', '--json').stdout)).toEqual([]);
  });

  test('plain output names owner and gives a separate-worktree suggestion', () => {
    const { repo } = fixture();
    expect(run(repo, 'claim', '--agent', 'human', '--session', 'human-a', '--task', 'Review').stdout).toContain('Claimed');
    expect(run(repo, 'claims').stdout).toContain('human (session human-a');
    const other = run(repo, 'claim', '--agent', 'cursor', '--session', 'other', '--task', 'Oops');
    expect(other.code).toBe(1);
    expect(other.stderr).toContain('setu new');
    expect(run(repo, 'release', '--session', 'human-a').stdout).toContain('Released');
  });

  test('a stale takeover identifies the previous owner and warns in the CLI', () => {
    const { repo, claimPath } = fixture();
    claimWriter(repo, owner({ pid: deadPid, task: 'Previous work' }));
    ageClaim(claimPath);
    const result = run(repo, 'claim', '--agent', 'antigravity', '--session', 'next', '--task', 'Continue');
    expect(result.code).toBe(0);
    expect(result.stderr).toContain("tree may hold that owner's uncommitted work");
    expect(claimWriter(repo, owner({ agent: 'antigravity', session: 'next' })).tookOverFrom).toBeUndefined();
  });

  test('claim-check allows unclaimed and same session; blocks other sessions, including stale ones', () => {
    const { repo, claimPath } = fixture();
    const check = (session, json = false) => run(repo, 'claim-check', join(repo, 'new', 'file.js'), '--session', session, ...(json ? ['--json'] : []));
    expect(check('a')).toEqual({ code: 0, stdout: '', stderr: '' });
    claimWriter(repo, owner());
    expect(check('session-a').code).toBe(0);
    const blocked = check('b', true);
    expect(blocked.code).toBe(2);
    expect(JSON.parse(blocked.stdout).ok).toBe(false);
    expect(blocked.stderr).toContain('session-a');
    expect(JSON.parse(check('session-a', true).stdout).ok).toBe(true);
    ageClaim(claimPath, { pid: deadPid });
    expect(check('b').code).toBe(2);
    writeFileSync(claimPath, '{}');
    expect(check('session-a').code).toBe(2);
    expect(run(root, 'claim-check', root, '--session', 'a').code).toBe(2);
    expect(run(repo, 'claim-check', repo).code).toBe(2);
  });

  test('claim-check allows paths outside worktrees and bare repositories', () => {
    const outside = mkdtempSync('/private/tmp/writer-claims-outside-');
    try {
      expect(JSON.parse(run(outside, 'claim-check', join(outside, 'notes.txt'), '--session', 'a', '--json').stdout)).toEqual({ ok: true, wtDir: null, claim: null });
    } finally { rmSync(outside, { recursive: true, force: true }); }
    const { repo } = fixture();
    const bare = join(root, `bare-${fixtureNumber}.git`);
    git(root, ['clone', '--bare', repo, bare]);
    expect(JSON.parse(run(bare, 'claim-check', join(bare, 'objects', 'new'), '--session', 'a', '--json').stdout)).toEqual({ ok: true, wtDir: null, claim: null });
  });

  test('claim-check refreshes only an old owner heartbeat and skips a busy lock', () => {
    const { repo, claimPath } = fixture();
    claimWriter(repo, owner());
    const old = ageClaim(claimPath, { heartbeat: new Date(Date.now() - 6 * 60 * 1000).toISOString() });
    expect(checkWriter(repo, 'session-a').ok).toBe(true);
    expect(Date.parse(JSON.parse(readFileSync(claimPath, 'utf8')).heartbeat)).toBeGreaterThan(Date.parse(old.heartbeat));
    const beforeBusy = ageClaim(claimPath, { heartbeat: new Date(Date.now() - 6 * 60 * 1000).toISOString() });
    const lock = openSync(`${claimPath}.lock`, 'wx');
    writeFileSync(lock, `${process.pid}\n`);
    closeSync(lock);
    expect(checkWriter(repo, 'session-a').ok).toBe(true);
    expect(Date.parse(JSON.parse(readFileSync(claimPath, 'utf8')).heartbeat)).toBe(Date.parse(beforeBusy.heartbeat));
    rmSync(`${claimPath}.lock`);
  });

  test('claim-check performs no git probes or writes while the heartbeat is fresh', () => {
    const { repo, claimPath } = fixture();
    claimWriter(repo, owner());
    const index = join(repo, '.git', 'index');
    const before = [claimPath, index].map(path => ({ content: readFileSync(path), mtime: statSync(path).mtimeMs }));
    const files = readdirSync(join(repo, '.git')).sort();
    writeFileSync(commandLog, '');
    for (const session of ['session-a', 'other', 'session-a', 'other', 'session-a']) {
      const result = run(repo, 'claim-check', join(repo, 'tracked.txt'), '--session', session);
      expect(result.code).toBe(session === 'session-a' ? 0 : 2);
    }
    expect(readFileSync(commandLog, 'utf8')).toBe('');
    expect(readdirSync(join(repo, '.git')).sort()).toEqual(files);
    for (const [i, path] of [claimPath, index].entries()) {
      expect(readFileSync(path)).toEqual(before[i].content);
      expect(statSync(path).mtimeMs).toBe(before[i].mtime);
    }
    expect(existsSync(join(home, '.setu.json'))).toBe(false);
  });

  test('claim-check honors its path even when inherited Git variables point elsewhere', () => {
    const a = fixture(), b = fixture();
    claimWriter(a.repo, owner());
    const result = spawnSync(process.execPath, [cli, 'claim-check', a.repo, '--session', 'other'], {
      cwd: b.repo, encoding: 'utf8', env: { ...process.env, GIT_DIR: join(b.repo, '.git'), GIT_WORK_TREE: b.repo },
    });
    expect(result.status).toBe(2);
  });

  test('missing or unknown options return JSON errors without creating claims', () => {
    const { repo, claimPath } = fixture();
    for (const args of [
      ['claim', '--agent', 'codex', '--session', 'a', '--task'],
      ['claim', '--agent', 'codex', '--session', 'a', '--task', 'Test', '--pid', 'nope'],
      ['release', '--session'], ['claims', '--agent', 'codex'],
    ]) {
      const result = run(repo, ...args, '--json');
      expect(result.code).toBe(1);
      expect(JSON.parse(result.stdout).ok).toBe(false);
    }
    expect(existsSync(claimPath)).toBe(false);
  });
});

describe('discovery and doctor checks', () => {
  test('doctor reports stale claims and status-hash changes even with the same change count', () => {
    const { repo, claimPath } = fixture();
    writeFileSync(join(repo, 'first.txt'), 'first');
    claimWriter(repo, owner({ pid: deadPid }));
    expect(writerClaimChecks([repo]).every(c => c.ok)).toBe(true);
    renameSync(join(repo, 'first.txt'), join(repo, 'second.txt'));
    expect(writerBaseline(repo).count).toBe(1);
    ageClaim(claimPath);
    const checks = writerClaimChecks([repo]);
    expect(checks.find(c => c.name === 'no stale writer claims')).toMatchObject({ ok: false });
    expect(checks.find(c => c.name === 'writer claim baselines match')).toMatchObject({ ok: false });
    expect(checks.filter(c => !c.ok).every(c => c.fix.includes(repo))).toBe(true);
    expect(listWriterClaims([repo])).toEqual([]);
    expect(listWriterClaims([repo], { includeStale: true })[0].stale).toBe(true);
  });

  test('doctor reports corrupt claims and still checks other worktrees', () => {
    const a = fixture(), b = fixture();
    writeFileSync(a.claimPath, '{}');
    claimWriter(b.repo, owner({ pid: deadPid }));
    ageClaim(b.claimPath);
    const checks = writerClaimChecks([a.repo, b.repo]);
    expect(checks.find(c => c.name === 'writer claims readable').ok).toBe(false);
    expect(checks.find(c => c.name === 'no stale writer claims').ok).toBe(false);
  });

  test('listing returns unreadable rows and force release removes only unreadable claims', () => {
    const { repo, claimPath } = fixture();
    writeFileSync(claimPath, '{}');
    expect(listWriterClaims([repo])).toEqual([expect.objectContaining({ unreadable: true, path: repo, error: expect.any(String) })]);
    expect(() => releaseWriter(repo, 'session-a')).toThrow('Invalid writer claim');
    expect(releaseWriter(repo, 'session-a', { force: true })).toMatchObject({ released: true, forced: true });
    writeFileSync(claimPath, '{}');
    expect(run(repo, 'release', '--session', 'session-a', '--force').code).toBe(0);
  });

  test('claims discovers registered repositories and sibling worktrees from an unrelated cwd', () => {
    const { repo } = fixture();
    const workspace = join(root, 'workspace');
    mkdirSync(workspace);
    const bare = join(workspace, 'project.git');
    git(workspace, ['clone', '--bare', repo, bare]);
    const linked = join(workspace, 'project', 'wrong-folder-name');
    git(bare, ['worktree', 'add', linked, 'actual/branch']);
    claimWriter(linked, owner());
    writeFileSync(join(workspace, '.projects'), 'project:3000::Project\n');
    writeFileSync(join(workspace, '.ports'), `project/wrong-folder-name:3000\nproject/missing:3001\n`);
    writeFileSync(join(home, '.setu.json'), JSON.stringify({ workspace }));
    try {
      const result = run(root, 'claims', '--json');
      expect(result.code).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual([expect.objectContaining({ wtDir: linked, branch: 'actual/branch' })]);
    } finally { rmSync(join(home, '.setu.json')); }
  });
});

test('MCP registers claim, release and list with the existing JSON response and error shapes', async () => {
  const { initMcpServer, handleMcpRequest } = await import('./mcp-server.js');
  const { repo } = fixture();
  initMcpServer({
    claimWriter: (_repo, _name, identity) => claimWriter(repo, identity),
    releaseWriter: (_repo, _name, session) => releaseWriter(repo, session),
    listWriterClaims: () => listWriterClaims([repo]),
  });
  let id = 0;
  async function rpc(method, params = {}) {
    const response = await handleMcpRequest(new Request('http://localhost:2999/mcp', {
      method: 'POST', headers: { host: 'localhost:2999', 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }),
    }));
    const raw = await response.text();
    const data = raw.startsWith('event:') ? JSON.parse(raw.split('\n').find(line => line.startsWith('data:')).slice(5)) : JSON.parse(raw);
    expect(data.error).toBeUndefined();
    return data.result;
  }
  const tools = (await rpc('tools/list')).tools;
  expect(tools).toHaveLength(18);
  expect(tools.map(t => t.name)).toEqual(expect.arrayContaining(['claim_worktree', 'release_worktree', 'list_claims']));
  expect(tools.find(t => t.name === 'claim_worktree').inputSchema.required).toContain('pid');
  const call = (name, args) => rpc('tools/call', { name, arguments: args });
  const args = { repo: 'fixture', name: 'wrong-folder-name', ...owner() };
  const claim = await call('claim_worktree', args);
  expect(JSON.parse(claim.content[0].text).ok).toBe(true);
  expect((await call('claim_worktree', { ...args, session: 'other' })).isError).toBe(true);
  const list = await call('list_claims', {});
  expect(JSON.parse(list.content[0].text)[0].session).toBe('session-a');
  expect((await call('release_worktree', { repo: 'fixture', name: 'wrong-folder-name', session: 'other' })).isError).toBe(true);
  const release = await call('release_worktree', { repo: 'fixture', name: 'wrong-folder-name', session: 'session-a' });
  expect(JSON.parse(release.content[0].text).released).toBe(true);
});
