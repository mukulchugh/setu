import { afterEach, expect, test } from 'bun:test';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createWorkspaceState,
  releaseHeldLocks,
  StateError,
} from './workspace-state.js';

test('filesystem causes preserve ENOSPC but exclude arbitrary exception data', () => {
  expect(
    new StateError('STATE_WRITE_FAILED', 'config', 'write', 'ENOSPC').causeCode
  ).toBe('ENOSPC');
  expect(
    new StateError(
      'STATE_WRITE_FAILED',
      'config',
      'write',
      'SECRET_ACCOUNT_VALUE'
    ).causeCode
  ).toBeUndefined();
});

const roots = [];
const children = [];
function fixture(overrides = {}) {
  const root = fs.mkdtempSync(join(tmpdir(), 'setu-state-test-'));
  roots.push(root);
  return {
    root,
    store: createWorkspaceState({
      configPath: join(root, 'config.json'),
      setuDir: root,
      workspaceRoot: root,
      ...overrides,
    }),
  };
}
afterEach(async () => {
  for (const { child, closed } of children.splice(0)) {
    if (child.exitCode === null) {
      child.kill();
    }
    await closed;
  }
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { force: true, recursive: true });
  }
});

test('construction performs no filesystem reads; only missing stores get defaults', () => {
  const noReads = new Proxy(
    {},
    {
      get() {
        throw new Error('unexpected filesystem access');
      },
    }
  );
  expect(() =>
    createWorkspaceState({ fs: noReads, workspaceRoot: '/not-read' })
  ).not.toThrow();
  const { root, store } = fixture();
  expect(store.read('config')).toEqual({});
  expect(store.read('sidecars')).toEqual({});
  expect(store.read('ports')).toEqual([]);
  fs.writeFileSync(join(root, 'config.json'), '[]');
  expect(() => store.read('config')).toThrow(
    expect.objectContaining({ code: 'STATE_CORRUPT' })
  );
});

test('malformed sidecars are never replaced by an edited project', async () => {
  const { root, store } = fixture();
  const path = join(root, 'sidecars.json');
  fs.writeFileSync(path, '{"secret":"fixture-only",broken');
  const before = fs.readFileSync(path);
  let error;
  try {
    await store.update('sidecars', (all) => ({ ...all, project: [] }));
  } catch (e) {
    error = e;
  }
  expect(error).toMatchObject({ code: 'STATE_CORRUPT', committed: false });
  expect(String(error)).not.toContain('fixture-only');
  expect(fs.readFileSync(path)).toEqual(before);
});

test('wrong nested shapes and unreadable files cannot become empty state', async () => {
  const { root } = fixture();
  fs.writeFileSync(join(root, 'sidecars.json'), '{"project":{}}');
  const store = createWorkspaceState({ workspaceRoot: root });
  expect(() => store.read('sidecars')).toThrow(
    expect.objectContaining({ code: 'STATE_CORRUPT' })
  );
  const denied = createWorkspaceState({
    fs: {
      ...fs,
      readFileSync(path, ...args) {
        if (String(path).endsWith('sidecars.json')) {
          throw Object.assign(new Error('fixture-only secret'), {
            code: 'EACCES',
          });
        }
        return fs.readFileSync(path, ...args);
      },
    },
    workspaceRoot: root,
  });
  expect(() => denied.read('sidecars')).toThrow(
    expect.objectContaining({ code: 'STATE_UNREADABLE' })
  );
  await expect(denied.update('sidecars', () => ({}))).rejects.toMatchObject({
    code: 'STATE_UNREADABLE',
    committed: false,
  });
});

function fileFaults(failAt, observations = []) {
  const files = new Map();
  let renamed = false;
  const fail = () => {
    throw Object.assign(new Error('simulated fixture-only secret'), {
      code: 'EIO',
    });
  };
  return {
    ...fs,
    closeSync(fd) {
      const path = files.get(fd);
      files.delete(fd);
      fs.closeSync(fd);
      if (path?.includes('.setu-tmp-') && failAt === 'close') {
        fail();
      }
    },
    fchmodSync(fd, mode) {
      if (files.get(fd)?.includes('.setu-tmp-') && failAt === 'chmod') {
        fail();
      }
      fs.fchmodSync(fd, mode);
    },
    fsyncSync(fd) {
      if (files.get(fd)?.includes('.setu-tmp-') && failAt === 'sync') {
        fail();
      }
      if (fs.fstatSync(fd).isDirectory() && failAt === 'directory-sync') {
        fail();
      }
      fs.fsyncSync(fd);
    },
    openSync(path, flags, mode) {
      if (String(path).includes('.setu-tmp-') && failAt === 'open') {
        fail();
      }
      const fd = fs.openSync(path, flags, mode);
      files.set(fd, String(path));
      return fd;
    },
    readFileSync(path, ...args) {
      if (
        renamed &&
        failAt === 'readback' &&
        String(path).endsWith('config.json')
      ) {
        fail();
      }
      return fs.readFileSync(path, ...args);
    },
    renameSync(from, to) {
      if (failAt === 'rename') {
        fail();
      }
      fs.renameSync(from, to);
      renamed = true;
    },
    writeSync(fd, bytes, offset, length, position) {
      if (files.get(fd)?.includes('.setu-tmp-')) {
        if (failAt === 'write') {
          fs.writeSync(fd, bytes, offset, Math.min(2, length), position);
          fail();
        }
        if (failAt === 'short') {
          return fs.writeSync(fd, bytes, offset, Math.min(2, length), position);
        }
        observations.push('write');
      }
      return fs.writeSync(fd, bytes, offset, length, position);
    },
  };
}

test.each(['open', 'write', 'chmod', 'sync', 'close', 'rename'])(
  'failure at %s preserves the old complete file and cleans only its temp file',
  async (failAt) => {
    const { root, store } = fixture({ fs: fileFaults(failAt) });
    const path = join(root, 'config.json'),
      otherTemp = join(root, '.config.json.setu-tmp-other-owner');
    fs.writeFileSync(path, '{"old":true}\n');
    fs.writeFileSync(otherTemp, 'belongs to someone else');
    await expect(
      store.update('config', (value) => ({ ...value, added: true }))
    ).rejects.toMatchObject({
      code: 'STATE_WRITE_FAILED',
      committed: false,
      phase: failAt,
    });
    expect(fs.readFileSync(path, 'utf8')).toBe('{"old":true}\n');
    expect(fs.readFileSync(otherTemp, 'utf8')).toBe('belongs to someone else');
    expect(fs.readdirSync(root).sort()).toEqual([
      '.config.json.setu-tmp-other-owner',
      'config.json',
    ]);
  }
);

test('short writes publish a complete validated file with unknown fields and permissions preserved', async () => {
  const { root, store } = fixture({ fs: fileFaults('short') });
  const path = join(root, 'config.json');
  fs.writeFileSync(path, '{"extension":{"future":true}}\n', { mode: 0o640 });
  const before = fs.statSync(path);
  const result = await store.update('config', (current) => ({
    ...current,
    domain: 'example.local',
  }));
  expect(result).toMatchObject({
    committed: true,
    reconciled: true,
    status: 'committed',
    value: { domain: 'example.local', extension: { future: true } },
  });
  expect(JSON.parse(fs.readFileSync(path, 'utf8'))).toEqual(result.value);
  const after = fs.statSync(path);
  expect([after.mode & 0o777, after.uid, after.gid]).toEqual([
    0o640,
    before.uid,
    before.gid,
  ]);
});

test('private creation and token replacement apply 0600 before rename', async () => {
  const seen = [];
  const { root, store } = fixture({
    fs: {
      ...fs,
      renameSync(from, to) {
        seen.push(fs.statSync(from).mode & 0o777);
        fs.renameSync(from, to);
      },
    },
  });
  await store.update('config', () => ({ domain: 'example.local' }));
  fs.writeFileSync(join(root, 'mcp-tokens.json'), '{}', { mode: 0o644 });
  await store.update('mcpTokens', () => ({
    issuer: { tokens: { access_token: 'fixture-only' } },
  }));
  expect(seen).toEqual([0o600, 0o600]);
});

test('directory-sync failure reports committed installed state, never a retryable pre-commit error', async () => {
  const { root, store } = fixture({ fs: fileFaults('directory-sync') });
  const result = await store.update('config', () => ({
    maxConcurrentDevServers: 2,
  }));
  expect(result).toMatchObject({
    committed: true,
    reconciled: true,
    status: 'committed-with-durability-warning',
    value: { maxConcurrentDevServers: 2 },
    warning: { code: 'STATE_DURABILITY_UNCONFIRMED' },
  });
  expect(
    JSON.parse(fs.readFileSync(join(root, 'config.json'), 'utf8'))
  ).toEqual(result.value);
});

test('failed post-rename readback is committed but cannot reconcile policy', async () => {
  const { root, store } = fixture({ fs: fileFaults('readback') });
  const result = await store.update('config', () => ({
    maxConcurrentDevServers: 1,
  }));
  expect(result).toMatchObject({
    committed: true,
    reconciled: false,
    status: 'committed-with-durability-warning',
  });
  expect(result.value).toBeUndefined();
  expect(
    JSON.parse(fs.readFileSync(join(root, 'config.json'), 'utf8'))
  ).toEqual({ maxConcurrentDevServers: 1 });
});

test('managed symlinks preserve their link and canonical file; dangling links never initialize', async () => {
  const { root, store } = fixture();
  const real = join(root, 'actual-config.json'),
    alias = join(root, 'config.json');
  fs.writeFileSync(real, '{"old":true}');
  fs.symlinkSync('actual-config.json', alias);
  await store.update('config', (value) => ({ ...value, added: true }));
  expect(fs.lstatSync(alias).isSymbolicLink()).toBe(true);
  expect(JSON.parse(fs.readFileSync(real, 'utf8'))).toEqual({
    added: true,
    old: true,
  });
  fs.unlinkSync(alias);
  fs.symlinkSync('absent-config.json', alias);
  expect(() => store.read('config')).toThrow(
    expect.objectContaining({ code: 'STATE_UNREADABLE' })
  );
  await expect(store.replace('config', {})).rejects.toMatchObject({
    code: 'STATE_UNREADABLE',
  });
  expect(fs.existsSync(join(root, 'absent-config.json'))).toBe(false);
});

test('whole-workspace aliases use one identity; partial sharing of coupled registries is rejected before write', async () => {
  const { root, store } = fixture();
  const alias = join(root, 'alias');
  fs.symlinkSync(root, alias);
  const linked = createWorkspaceState({ workspaceRoot: alias });
  await linked.update('sidecars', (all) => ({ ...all, one: [] }));
  expect(store.read('sidecars')).toEqual({ one: [] });
  const other = fixture();
  fs.writeFileSync(join(root, '.ports'), 'repo/main:3000\n');
  fs.symlinkSync(join(root, '.ports'), join(other.root, '.ports'));
  await expect(
    other.store.update('sidecars', () => ({ two: [] }))
  ).rejects.toMatchObject({
    code: 'STATE_UNREADABLE',
    phase: 'partial-workspace-alias',
  });
  expect(fs.existsSync(join(other.root, 'sidecars.json'))).toBe(false);
});

test('generated output rejects symlinks and never changes shared input', async () => {
  const { root, store } = fixture();
  const secret = join(root, '.env.local'),
    generated = join(root, '.envrc');
  fs.writeFileSync(secret, 'fixture-only');
  fs.symlinkSync(secret, generated);
  await expect(
    store.replaceText(generated, 'export PORT=3000\n')
  ).rejects.toMatchObject({
    code: 'STATE_UNREADABLE',
    phase: 'symlink-rejected',
  });
  expect(fs.readFileSync(secret, 'utf8')).toBe('fixture-only');
});

test('five-second lock deadline is monotonic for unreadable locks and dead owners are reclaimed', async () => {
  let elapsed = 0;
  const { root, store } = fixture({
    now: () => elapsed,
    sleep: async (ms) => {
      elapsed += ms;
    },
  });
  const lock = join(root, 'config.json.setu-lock');
  fs.writeFileSync(lock, '');
  await expect(store.update('config', () => ({}))).rejects.toMatchObject({
    code: 'STATE_BUSY',
    committed: false,
  });
  expect(elapsed).toBe(5000);
  expect(fs.readFileSync(lock, 'utf8')).toBe('');
  fs.writeFileSync(lock, '{"pid":99999999,"nonce":"abandoned"}');
  elapsed = 0;
  await expect(store.update('config', () => ({}))).resolves.toMatchObject({
    committed: true,
  });
  expect(elapsed).toBe(0);
  expect(fs.existsSync(lock)).toBe(false);
});

test('a SIGKILLed real lock holder is reclaimed, while a live holder remains busy', async () => {
  const { root, store } = fixture({ lockTimeoutMs: 40 });
  const dead = writer(root, 'first');
  await dead.wait('held');
  dead.child.kill('SIGKILL');
  await dead.closed;
  await expect(
    store.update('config', () => ({ reclaimed: true }))
  ).resolves.toMatchObject({
    committed: true,
  });

  const live = writer(root, 'first');
  await live.wait('held');
  await expect(
    store.update('config', () => ({ blocked: true }))
  ).rejects.toMatchObject({
    code: 'STATE_BUSY',
  });
  live.release();
  await live.closed;
});

test('a deliberately retained target lease is never reclaimed and inspection reports it', async () => {
  const { root, store } = fixture({ lockTimeoutMs: 20 });
  const path = join(
    fs.realpathSync(root),
    `.setu-target-${createHash('sha256')
      .update(join(fs.realpathSync(root), 'repo', 'topic'))
      .digest('hex')}.lock`
  );
  fs.writeFileSync(
    path,
    JSON.stringify({ nonce: 'retained', pid: 99999999, retained: true })
  );
  const sameTarget = { name: 'topic', repo: 'repo' };
  await expect(store.withTargets([sameTarget], () => {})).rejects.toMatchObject(
    {
      code: 'STATE_BUSY',
    }
  );
  expect(store.inspectLocks()).toContainEqual({
    alive: false,
    kind: 'target',
    path: path.replace(fs.realpathSync(root), root),
    pid: 99999999,
    retained: true,
  });
  releaseHeldLocks();
  expect(fs.existsSync(path)).toBe(true);
});

test('release preserves a replacement lock even when it has the same nonce', async () => {
  const { root, store } = fixture({ nonce: () => 'known-nonce' });
  const lock = join(root, 'config.json.setu-lock');
  await expect(
    store.update('config', (current) => {
      const metadata = fs.readFileSync(lock);
      fs.renameSync(lock, join(root, 'old-lock'));
      fs.writeFileSync(lock, metadata);
      return { ...current, ok: true };
    })
  ).rejects.toMatchObject({
    code: 'STATE_BUSY',
    phase: 'lock-ownership-changed',
  });
  expect(fs.existsSync(lock)).toBe(true);
});

test('failed lock owner metadata write removes only the acquired lock inode', async () => {
  const files = new Map();
  const { root, store } = fixture({
    fs: {
      ...fs,
      openSync(path, ...args) {
        const fd = fs.openSync(path, ...args);
        files.set(fd, String(path));
        return fd;
      },
      writeSync(fd, ...args) {
        if (files.get(fd)?.endsWith('.setu-lock')) {
          throw Object.assign(new Error('fixture'), { code: 'EIO' });
        }
        return fs.writeSync(fd, ...args);
      },
    },
  });
  await expect(store.update('config', () => ({}))).rejects.toMatchObject({
    code: 'STATE_WRITE_FAILED',
    phase: 'lock-owner',
  });
  expect(fs.readdirSync(root)).toEqual([]);
});

test('ordered multi-document scope exposes fresh snapshots without nested locking; reverse order refuses', async () => {
  const { root, store } = fixture();
  const result = await store.withRouting(() =>
    store.withWorkspace(['projects', 'ports'], (scope) => {
      expect(scope.read('ports')).toEqual([]);
      const one = scope.replace('projects', {
        r: { base: 3000, label: 'R', slug: null },
      });
      const two = scope.replace('ports', [
        { key: 'r/main', name: 'main', port: 3000, repo: 'r' },
      ]);
      return [one, two];
    })
  );
  expect(result.every((row) => row.committed)).toBe(true);
  await expect(
    store.withWorkspace(['ports'], () =>
      store.withRouting(() => {
        /* No side effect is needed in this fixture. */
      })
    )
  ).rejects.toMatchObject({ code: 'STATE_BUSY', phase: 'lock-order' });
  expect(fs.readdirSync(root).sort()).toEqual(['.ports', '.projects']);
});

function writer(root, role, storeName) {
  const child = spawn(
    process.execPath,
    [
      new URL('./workspace-state.process-fixture.js', import.meta.url).pathname,
      root,
      role,
      storeName ?? 'config',
    ],
    { stdio: ['pipe', 'pipe', 'pipe'] }
  );
  const lines = [],
    waiters = [];
  let pending = '',
    stderr = '',
    done = false;
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (text) => {
    stderr += text;
  });
  child.stdout.on('data', (text) => {
    pending += text;
    for (;;) {
      const end = pending.indexOf('\n');
      if (end < 0) {
        break;
      }
      const line = pending.slice(0, end);
      pending = pending.slice(end + 1);
      lines.push(line);
      for (const waiter of waiters) {
        if (line.startsWith(waiter.prefix)) {
          waiter.resolve(line);
        }
      }
    }
  });
  const closed = new Promise((resolve) =>
    child.on('close', (code) => {
      done = true;
      resolve({ code, stderr });
      for (const waiter of waiters) {
        if (!lines.some((line) => line.startsWith(waiter.prefix))) {
          waiter.reject(
            new Error(`Fixture exited before ${waiter.prefix}: ${stderr}`)
          );
        }
      }
    })
  );
  children.push({ child, closed });
  return {
    child,
    closed,
    release: () => child.stdin.write('release\n'),
    wait(prefix) {
      const existing = lines.find((line) => line.startsWith(prefix));
      if (existing) {
        return Promise.resolve(existing);
      }
      if (done) {
        return Promise.reject(new Error(`Fixture already exited: ${stderr}`));
      }
      return new Promise((resolve, reject) =>
        waiters.push({ prefix, reject, resolve })
      );
    },
  };
}

test.each([
  'config',
  'sidecars',
  'archive',
  'mcpTokens',
  'projects',
  'ports',
  'routing',
])(
  'two independent processes preserve sibling %s updates after observed contention',
  async (storeName) => {
    const { root, store } = fixture();
    if (storeName === 'routing') {
      await store.replace('ports', [
        { key: 'r/main', name: 'main', port: 3200, repo: 'r' },
      ]);
      fs.writeFileSync(join(root, 'hosts'), '127.0.0.1 localhost\n');
    }
    const first = writer(root, 'first', storeName);
    await first.wait('held');
    const second = writer(root, 'second', storeName);
    await second.wait('contended');
    first.release();
    expect(await first.closed).toEqual({ code: 0, stderr: '' });
    expect(await second.closed).toEqual({ code: 0, stderr: '' });
    if (storeName === 'routing') {
      expect(fs.readFileSync(join(root, 'hosts'), 'utf8')).not.toContain(
        'r.quivly.local'
      );
    } else if (storeName === 'ports') {
      expect(store.read('ports').map((row) => row.port)).toEqual([3200, 3201]);
    } else if (storeName === 'projects') {
      expect(
        Object.values(store.read('projects')).map((row) => row.base)
      ).toEqual([3000, 3100]);
    } else if (storeName === 'archive') {
      expect(store.read('archive')).toEqual([
        { operationId: 'first' },
        { operationId: 'second' },
      ]);
    } else if (storeName === 'mcpTokens') {
      expect(store.read('mcpTokens')).toEqual({
        issuer: { first: { fixture: true }, second: { fixture: true } },
      });
    } else {
      expect(store.read(storeName)).toEqual(
        storeName === 'sidecars'
          ? { first: [], second: [] }
          : { first: true, second: true }
      );
    }
  }
);

test('an independent reader sees complete old or new content during repeated publication', async () => {
  const { root, store } = fixture();
  await store.replace('config', { version: 'old' });
  const reader = writer(root, 'reader');
  await reader.wait('ready');
  for (let i = 0; i < 12; i += 1) {
    await store.replace('config', { version: 'old' });
  }
  await store.replace('config', {
    payload: 'x'.repeat(32_768),
    version: 'new',
  });
  const observed = JSON.parse(
    (await reader.wait('observed ')).slice('observed '.length)
  );
  expect(observed.oldSeen).toBe(true);
  expect(observed.newSeen).toBe(true);
  expect(observed.count).toBeGreaterThan(1);
  expect(await reader.closed).toEqual({ code: 0, stderr: '' });
});

test('a symlink changed while waiting for its destination lock is rejected after acquisition', async () => {
  const { root } = fixture();
  const old = join(root, 'old.json'),
    other = join(root, 'other.json'),
    alias = join(root, 'config.json');
  fs.writeFileSync(old, '{"old":true}');
  fs.writeFileSync(other, '{"other":true}');
  fs.symlinkSync(old, alias);
  const lock = `${old}.setu-lock`;
  fs.writeFileSync(lock, 'another writer');
  const store = createWorkspaceState({
    configPath: alias,
    sleep: async () => {
      fs.unlinkSync(alias);
      fs.symlinkSync(other, alias);
      fs.unlinkSync(lock);
    },
  });
  await expect(store.update('config', () => ({}))).rejects.toMatchObject({
    code: 'STATE_UNREADABLE',
    phase: 'target-changed',
  });
  expect(fs.readFileSync(old, 'utf8')).toBe('{"old":true}');
  expect(fs.readFileSync(other, 'utf8')).toBe('{"other":true}');
});

test('unsupported ownership transfer refuses publication without loosening destination mode', async () => {
  const { root, store } = fixture({
    fs: {
      ...fs,
      fchownSync() {
        throw Object.assign(new Error('fixture'), { code: 'EPERM' });
      },
      statSync(path, ...args) {
        const stat = fs.statSync(path, ...args);
        if (String(path).endsWith('config.json')) {
          stat.uid += 1;
        }
        return stat;
      },
    },
  });
  fs.writeFileSync(join(root, 'config.json'), '{}', { mode: 0o600 });
  await expect(
    store.update('config', () => ({ change: true }))
  ).rejects.toMatchObject({ code: 'STATE_WRITE_FAILED', phase: 'ownership' });
  expect(fs.readFileSync(join(root, 'config.json'), 'utf8')).toBe('{}');
  expect(fs.statSync(join(root, 'config.json')).mode & 0o777).toBe(0o600);
});

test('invalid or duplicate registries fail closed and slash branches round-trip', async () => {
  const { root, store } = fixture();
  for (const malformed of [
    'repo/main:nope\n',
    'repo/main:3000\nrepo/main:3001\n',
    'repo/main:3000\nrepo/other:3000\n',
    're\0po/main:3000\n',
  ]) {
    fs.writeFileSync(join(root, '.ports'), malformed);
    expect(() => store.read('ports')).toThrow(
      expect.objectContaining({ code: 'STATE_CORRUPT' })
    );
    await expect(store.replace('ports', [])).rejects.toMatchObject({
      code: 'STATE_CORRUPT',
    });
    expect(fs.readFileSync(join(root, '.ports'), 'utf8')).toBe(malformed);
  }
  fs.writeFileSync(join(root, '.ports'), 'repo/feat/branch:3001\n');
  const parsed = store.read('ports');
  await store.replace('ports', parsed);
  expect(store.read('ports')).toEqual([
    { key: 'repo/feat/branch', name: 'feat/branch', port: 3001, repo: 'repo' },
  ]);
  fs.writeFileSync(join(root, '.projects'), 'repo:not-a-base::Label\n');
  expect(() => store.read('projects')).toThrow(
    expect.objectContaining({ code: 'STATE_CORRUPT' })
  );
});

test('target scopes canonicalize whole-root aliases, reject checkout aliases and enforce target-before-routing order', async () => {
  const { root, store } = fixture();
  const alias = join(root, 'alias');
  fs.symlinkSync(root, alias);
  const linked = createWorkspaceState({ setuDir: root, workspaceRoot: alias });
  let key;
  await store.withTargets([{ name: 'feat/a', repo: 'r' }], async (targets) => {
    key = targets[0];
    await store.withTargets([{ name: 'feat/a', repo: 'r' }], (same) => {
      expect(same).toEqual(targets);
    });
    await store.withRouting(() =>
      store.withWorkspace(['ports'], (scope) => scope.replace('ports', []))
    );
  });
  await linked.withTargets([{ name: 'feat/a', repo: 'r' }], (targets) => {
    expect(targets[0]).toBe(key);
  });
  await expect(
    store.withRouting(() =>
      store.withTargets([{ name: 'feat/a', repo: 'r' }], () => {
        /* No side effect is needed in this fixture. */
      })
    )
  ).rejects.toMatchObject({ code: 'STATE_BUSY', phase: 'lock-order' });
  fs.mkdirSync(join(root, 'actual'));
  fs.symlinkSync(join(root, 'actual'), join(root, 'r'));
  await expect(
    store.withTargets([{ name: 'main', repo: 'r' }], () => {
      /* No side effect is needed in this fixture. */
    })
  ).rejects.toMatchObject({
    code: 'STATE_UNREADABLE',
    phase: 'conflicting-target-alias',
  });
});

test('unknown child completion retains target leases while short routing and metadata locks release', async () => {
  let time = 0;
  const { root, store } = fixture({
    now: () => time,
    sleep: async (ms) => {
      time += ms;
    },
  });
  const target = { name: 'branch', repo: 'repo' };
  await expect(
    store.withTargets([target], () =>
      store.withRouting(() =>
        store.withWorkspace(['ports'], () => {
          throw Object.assign(new Error('exit observation lost'), {
            code: 'OPERATION_UNKNOWN',
          });
        })
      )
    )
  ).rejects.toMatchObject({ code: 'OPERATION_UNKNOWN' });
  const locks = fs
    .readdirSync(root)
    .filter((name) => name.endsWith('.lock') || name.endsWith('.setu-lock'));
  expect(locks.length).toBe(1);
  expect(locks[0]).toMatch(/^\.setu-target-/);
  expect(JSON.parse(fs.readFileSync(join(root, locks[0]), 'utf8')).pid).toBe(
    process.pid
  );
  await expect(
    store.withTargets([target], () => 'unsafe reentry')
  ).rejects.toMatchObject({ code: 'STATE_BUSY' });
  expect(
    (await store.update('sidecars', () => ({ separate: [] }))).reconciled
  ).toBe(true);
});
