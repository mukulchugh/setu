// Small-file persistence for Setu. Import and construction perform no I/O.

import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash, randomUUID } from 'node:crypto';
import nativeFs from 'node:fs';
import { basename, dirname, isAbsolute, join, relative } from 'node:path';

// One async chain must never invert the documented routing -> workspace -> document order.
const lockContext = new AsyncLocalStorage();

const stateCauseCodes = new Set([
  'ENOSPC',
  'EDQUOT',
  'EACCES',
  'EPERM',
  'EIO',
  'EROFS',
  'EMFILE',
  'ENFILE',
  'ENOENT',
  'ENOTDIR',
  'EISDIR',
  'ELOOP',
  'EBUSY',
  'EEXIST',
  'EXDEV',
  'EINVAL',
  'EBADF',
]);
export const safeStateCauseCode = (value) =>
  stateCauseCodes.has(value) ? value : undefined;

export class StateError extends Error {
  constructor(code, store, phase, causeCode) {
    super(`${code}: ${store} (${phase})`);
    this.name = 'StateError';
    this.code = code;
    this.store = store;
    this.phase = phase;
    this.committed = false;
    // Never copy exception messages: parsers, paths and tokens may contain secrets.
    if (safeStateCauseCode(causeCode)) {
      this.causeCode = causeCode;
    }
  }
}

const object = (value) =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const strings = (value) =>
  Array.isArray(value) && value.every((v) => typeof v === 'string');
const stringMap = (value) =>
  object(value) && Object.values(value).every((v) => typeof v === 'string');
const repoName = (value) =>
  typeof value === 'string' &&
  /^[^/\\\s:\x00-\x20]+$/.test(value) &&
  !['.', '..'].includes(value) &&
  !value.startsWith('-');
const branchName = (value) =>
  typeof value === 'string' && value.split('/').every(repoName);
const portNumber = (value) =>
  Number.isInteger(value) && value > 0 && value <= 65_535;
const sidecar = (value) =>
  object(value) &&
  ['name', 'command'].every(
    (key) => value[key] === undefined || typeof value[key] === 'string'
  ) &&
  (value.enabled === undefined || typeof value.enabled === 'boolean') &&
  (value.args === undefined || strings(value.args)) &&
  (value.env === undefined || stringMap(value.env));
const perRepo = (value, validate) =>
  object(value) &&
  Object.entries(value).every(([repo, row]) => repoName(repo) && validate(row));

export function parsePorts(text) {
  const seenKeys = new Set(),
    seenPorts = new Set();
  return text
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => {
      const colon = line.lastIndexOf(':'),
        key = line.slice(0, colon),
        slash = key.indexOf('/');
      const repo = key.slice(0, slash),
        name = key.slice(slash + 1),
        raw = line.slice(colon + 1);
      const port = Number(raw);
      if (
        colon < 0 ||
        slash < 0 ||
        !repoName(repo) ||
        !branchName(name) ||
        !/^\d+$/.test(raw) ||
        !portNumber(port) ||
        seenKeys.has(key) ||
        seenPorts.has(port)
      ) {
        throw new StateError('STATE_CORRUPT', 'ports', 'validate');
      }
      seenKeys.add(key);
      seenPorts.add(port);
      return { key, name, port, repo };
    });
}

export function parseProjects(text) {
  const entries = [],
    seenNames = new Set(),
    seenBases = new Set();
  for (const line of text
    .split('\n')
    .filter((row) => row.trim() && !row.startsWith('#'))) {
    const [name, raw, slug = '', label = '', ...extra] = line.split(':');
    const base = Number(raw);
    if (
      !(repoName(name) && /^\d+$/.test(raw ?? '') && portNumber(base)) ||
      extra.length ||
      seenNames.has(name) ||
      seenBases.has(base)
    ) {
      throw new StateError('STATE_CORRUPT', 'projects', 'validate');
    }
    seenNames.add(name);
    seenBases.add(base);
    entries.push([
      name,
      {
        base,
        github: slug ? `https://github.com/${slug}` : null,
        label: label.trim() || name,
        slug: slug || null,
      },
    ]);
  }
  return Object.fromEntries(entries);
}

const definitions = {
  approvals: {
    coupled: true,
    file: 'sidecar-approvals.json',
    initial: () => ({}),
    validate: (value) => perRepo(value, stringMap),
  },
  archive: {
    coupled: true,
    file: 'archived-worktrees.json',
    initial: () => [],
    validate: (value) => Array.isArray(value) && value.every(object),
  },
  config: { initial: () => ({}), private: true, validate: object },
  customAgents: {
    file: 'custom-agents.json',
    initial: () => [],
    validate: (value) =>
      Array.isArray(value) &&
      value.every(
        (row) =>
          object(row) &&
          ['id', 'label', 'command'].every(
            (key) => typeof row[key] === 'string'
          )
      ),
  },
  fileSync: {
    file: 'file-sync.json',
    initial: () => ({}),
    validate: (value) => perRepo(value, strings),
  },
  mcpServers: {
    file: 'mcp-servers.json',
    initial: () => [],
    validate: (value) =>
      Array.isArray(value) &&
      value.every(
        (row) =>
          object(row) &&
          typeof row.id === 'string' &&
          typeof row.name === 'string' &&
          ['stdio', 'http'].includes(row.transport)
      ),
  },
  mcpTokens: {
    file: 'mcp-tokens.json',
    forceMode: 0o600,
    initial: () => ({}),
    private: true,
    validate: (value) => object(value) && Object.values(value).every(object),
  },
  ports: {
    coupled: true,
    encode: (rows) => rows.map((row) => `${row.key}:${row.port}\n`).join(''),
    file: '.ports',
    initial: () => [],
    parse: parsePorts,
    validate: (rows) =>
      Array.isArray(rows) &&
      rows.every(
        (row) =>
          object(row) &&
          repoName(row.repo) &&
          branchName(row.name) &&
          row.key === `${row.repo}/${row.name}` &&
          portNumber(row.port)
      ),
  },
  projects: {
    coupled: true,
    encode: (rows) =>
      Object.entries(rows)
        .map(
          ([name, row]) =>
            `${name}:${row.base}:${row.slug || ''}:${row.label || name}\n`
        )
        .join(''),
    file: '.projects',
    initial: () => ({}),
    parse: parseProjects,
    validate: (rows) =>
      perRepo(
        rows,
        (row) =>
          object(row) &&
          portNumber(row.base) &&
          (row.slug == null ||
            (typeof row.slug === 'string' && !/[\r\n:]/.test(row.slug))) &&
          (row.label === undefined ||
            (typeof row.label === 'string' && !/[\r\n:]/.test(row.label)))
      ),
  },
  // Ticket 06 validates the versioned recovery records; this layer preserves the envelope.
  removals: {
    coupled: true,
    file: '.setu-removals.json',
    forceMode: 0o600,
    initial: () => ({}),
    private: true,
    validate: object,
  },
  sidecars: {
    coupled: true,
    file: 'sidecars.json',
    initial: () => ({}),
    validate: (value) =>
      perRepo(value, (rows) => Array.isArray(rows) && rows.every(sidecar)),
  },
};

export function createWorkspaceState({
  workspaceRoot,
  configPath,
  setuDir,
  fs = nativeFs,
  now = () => performance.now(),
  sleep = (ms) => new Promise((done) => setTimeout(done, ms)),
  pid = process.pid,
  nonce = randomUUID,
  lockTimeoutMs = 5000,
} = {}) {
  function descriptor(name) {
    const def = definitions[name];
    if (!def) {
      throw new StateError('STATE_CORRUPT', 'store', 'unknown-store');
    }
    const path =
      name === 'config'
        ? configPath
        : workspaceRoot && join(workspaceRoot, def.file);
    if (!(path && isAbsolute(path))) {
      throw new StateError('STATE_UNREADABLE', name, 'explicit-path-required');
    }
    return { ...def, name, path };
  }
  function decode(def, text) {
    let value;
    try {
      value = def.parse ? def.parse(text) : JSON.parse(text);
    } catch {
      throw new StateError('STATE_CORRUPT', def.name, 'parse');
    }
    if (!def.validate(value)) {
      throw new StateError('STATE_CORRUPT', def.name, 'validate');
    }
    return value;
  }
  function destination(def) {
    try {
      const parent = fs.realpathSync(dirname(def.path));
      const path = join(parent, basename(def.path));
      let stat;
      try {
        stat = fs.lstatSync(path);
      } catch (error) {
        if (error.code !== 'ENOENT') {
          throw error;
        }
      }
      if (stat?.isSymbolicLink() && def.symlinks === 'reject') {
        throw new StateError('STATE_UNREADABLE', def.name, 'symlink-rejected');
      }
      const canonical = stat ? fs.realpathSync(path) : path;
      if (stat && !fs.statSync(canonical).isFile()) {
        throw new StateError('STATE_UNREADABLE', def.name, 'not-a-file');
      }
      return canonical;
    } catch (error) {
      if (error instanceof StateError) {
        throw error;
      }
      throw new StateError('STATE_UNREADABLE', def.name, 'resolve', error.code);
    }
  }
  function readAt(def, canonical, allowMissing = true) {
    let text;
    try {
      text = fs.readFileSync(canonical, 'utf8');
    } catch (error) {
      if (error.code === 'ENOENT' && allowMissing) {
        return def.initial();
      }
      throw new StateError('STATE_UNREADABLE', def.name, 'read', error.code);
    }
    return decode(def, text);
  }
  function read(name) {
    const def = descriptor(name);
    return readAt(def, destination(def));
  }
  function sameFile(a, b) {
    return a.dev === b.dev && a.ino === b.ino;
  }
  function unlinkOwned(path, identity) {
    try {
      if (sameFile(fs.lstatSync(path), identity)) {
        fs.unlinkSync(path);
      }
    } catch {
      /* A missing/replaced/unreadable file is never ours to remove. */
    }
  }
  function writeAll(fd, text) {
    const bytes = Buffer.from(text);
    let offset = 0;
    while (offset < bytes.length) {
      const written = fs.writeSync(
        fd,
        bytes,
        offset,
        bytes.length - offset,
        null
      );
      if (!(written > 0 && written <= bytes.length - offset)) {
        throw new Error('incomplete write');
      }
      offset += written;
    }
  }
  function token() {
    const value = nonce();
    if (typeof value !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(value)) {
      throw new StateError('STATE_WRITE_FAILED', 'lock', 'nonce');
    }
    return value;
  }
  async function acquire(path, name) {
    const deadline = now() + lockTimeoutMs;
    const owner = token();
    let fd, identity;
    for (;;) {
      try {
        fd = fs.openSync(path, 'wx', 0o600);
        break;
      } catch (error) {
        if (error.code !== 'EEXIST') {
          throw new StateError(
            'STATE_WRITE_FAILED',
            name,
            'lock-open',
            error.code
          );
        }
        const remaining = deadline - now();
        if (remaining <= 0) {
          throw new StateError('STATE_BUSY', name, 'lock-timeout');
        }
        await sleep(Math.min(25, remaining));
      }
    }
    try {
      identity = fs.fstatSync(fd);
      writeAll(fd, `${JSON.stringify({ nonce: owner, pid })}\n`);
      fs.closeSync(fd);
      fd = undefined;
    } catch (error) {
      if (fd !== undefined) {
        try {
          fs.closeSync(fd);
        } catch {
          /* Keep the first failure. */
        }
      }
      if (identity) {
        unlinkOwned(path, identity);
      }
      throw new StateError(
        'STATE_WRITE_FAILED',
        name,
        'lock-owner',
        error.code
      );
    }
    const owned = () => {
      try {
        return (
          sameFile(fs.lstatSync(path), identity) &&
          JSON.parse(fs.readFileSync(path, 'utf8')).nonce === owner
        );
      } catch {
        return false;
      }
    };
    return {
      owned,
      release() {
        if (owned()) {
          unlinkOwned(path, identity);
        }
      },
    };
  }
  async function withLock(path, rank, name, work, orderKey = path) {
    const held = lockContext.getStore() ?? [];
    const previous = held.at(-1);
    if (
      previous &&
      (previous.rank > rank ||
        (previous.rank === rank && previous.orderKey >= orderKey))
    ) {
      throw new StateError('STATE_BUSY', name, 'lock-order');
    }
    const lock = await acquire(path, name);
    let retain = false;
    try {
      return await lockContext.run(
        [...held, { orderKey, path, rank, ...lock }],
        work
      );
    } catch (error) {
      // A CLI may return an unknown child outcome and exit before the child does.
      // Keep only its target lease for diagnosed recovery; short metadata locks
      // still release. A dead owner PID is deliberately not permission to steal.
      retain = rank === 10 && error?.code === 'OPERATION_UNKNOWN';
      throw error;
    } finally {
      if (!retain) {
        lock.release();
      }
    }
  }
  function assertOwned() {
    if ((lockContext.getStore() ?? []).some((lock) => !lock.owned())) {
      throw new StateError('STATE_BUSY', 'store', 'lock-ownership-changed');
    }
  }
  function canonicalRoot(path, name) {
    try {
      if (!(path && isAbsolute(path))) {
        throw new Error('explicit path required');
      }
      const root = fs.realpathSync(path);
      if (!fs.statSync(root).isDirectory()) {
        throw new Error('not a directory');
      }
      return root;
    } catch {
      throw new StateError('STATE_UNREADABLE', name, 'root');
    }
  }
  function validateWorkspace(root) {
    const paths = new Set();
    for (const [name, def] of Object.entries(definitions)) {
      if (!def.coupled) {
        continue;
      }
      const canonical = destination(descriptor(name));
      const rel = relative(root, canonical);
      if (
        rel === '..' ||
        rel.startsWith('../') ||
        isAbsolute(rel) ||
        paths.has(canonical)
      ) {
        throw new StateError(
          'STATE_UNREADABLE',
          name,
          'partial-workspace-alias'
        );
      }
      paths.add(canonical);
      try {
        if (fs.statSync(canonical).nlink > 1) {
          throw new StateError(
            'STATE_UNREADABLE',
            name,
            'partial-workspace-alias'
          );
        }
      } catch (error) {
        if (error instanceof StateError) {
          throw error;
        }
        if (error.code !== 'ENOENT') {
          throw new StateError(
            'STATE_UNREADABLE',
            name,
            'alias-check',
            error.code
          );
        }
      }
    }
  }
  function replaceAt(def, canonical, value) {
    let encoded;
    try {
      if (!def.validate(value)) {
        throw new Error('invalid');
      }
      encoded = def.encode
        ? def.encode(value)
        : `${JSON.stringify(value, null, 2)}\n`;
      decode(def, encoded); // Validate the actual persisted representation, including text registries.
    } catch {
      throw new StateError('STATE_CORRUPT', def.name, 'validate');
    }
    const temp = join(
      dirname(canonical),
      `.${basename(canonical)}.setu-tmp-${token()}`
    );
    let fd,
      identity,
      phase = 'read-metadata';
    try {
      let previous;
      try {
        previous = fs.statSync(canonical);
      } catch (error) {
        if (error.code !== 'ENOENT') {
          throw error;
        }
      }
      if (destination(def) !== canonical) {
        throw new StateError('STATE_UNREADABLE', def.name, 'target-changed');
      }
      assertOwned();
      phase = 'open';
      fd = fs.openSync(temp, 'wx', 0o600);
      identity = fs.fstatSync(fd);
      phase = 'write';
      writeAll(fd, encoded);
      phase = 'ownership';
      if (
        previous &&
        (identity.uid !== previous.uid || identity.gid !== previous.gid)
      ) {
        fs.fchownSync(fd, previous.uid, previous.gid);
        const owned = fs.fstatSync(fd);
        if (owned.uid !== previous.uid || owned.gid !== previous.gid) {
          throw new Error('ownership mismatch');
        }
      }
      phase = 'chmod';
      fs.fchmodSync(
        fd,
        def.forceMode ??
          (previous ? previous.mode & 0o7777 : def.private ? 0o600 : 0o644)
      );
      phase = 'sync';
      fs.fsyncSync(fd);
      phase = 'close';
      fs.closeSync(fd);
      fd = undefined;
      if (destination(def) !== canonical) {
        throw new StateError('STATE_UNREADABLE', def.name, 'target-changed');
      }
      assertOwned();
      phase = 'rename';
      fs.renameSync(temp, canonical);
    } catch (error) {
      if (fd !== undefined) {
        try {
          fs.closeSync(fd);
        } catch {
          /* Preserve the first failure. */
        }
      }
      if (identity) {
        unlinkOwned(temp, identity);
      }
      if (error instanceof StateError) {
        throw error;
      }
      throw new StateError('STATE_WRITE_FAILED', def.name, phase, error.code);
    }
    // Rename is the commit point. Nothing below may report a retryable failed write.
    const result = { committed: true, reconciled: true, status: 'committed' };
    let directoryFd;
    try {
      directoryFd = fs.openSync(dirname(canonical), 'r');
      fs.fsyncSync(directoryFd);
    } catch {
      result.warning = {
        code: 'STATE_DURABILITY_UNCONFIRMED',
        phase: 'directory-sync',
      };
    } finally {
      if (directoryFd !== undefined) {
        try {
          fs.closeSync(directoryFd);
        } catch {
          result.warning = {
            code: 'STATE_DURABILITY_UNCONFIRMED',
            phase: 'directory-close',
          };
        }
      }
    }
    try {
      if (destination(def) !== canonical) {
        throw new Error('target changed');
      }
      result.value = readAt(def, canonical, false);
    } catch {
      result.reconciled = false;
      result.warning = {
        code: 'STATE_DURABILITY_UNCONFIRMED',
        phase: 'readback',
      };
    }
    if (result.warning) {
      result.status = 'committed-with-durability-warning';
    }
    return result;
  }
  async function withDocuments(defs, work) {
    const entries = defs
      .map((def) => ({ canonical: destination(def), def }))
      .sort((a, b) =>
        a.canonical < b.canonical ? -1 : a.canonical > b.canonical ? 1 : 0
      );
    if (new Set(entries.map((row) => row.canonical)).size !== entries.length) {
      throw new StateError('STATE_UNREADABLE', 'store', 'conflicting-alias');
    }
    async function enter(index) {
      if (index < entries.length) {
        const { def, canonical } = entries[index];
        return withLock(`${canonical}.setu-lock`, 40, def.name, () =>
          enter(index + 1)
        );
      }
      for (const { def, canonical } of entries) {
        if (destination(def) !== canonical) {
          throw new StateError('STATE_UNREADABLE', def.name, 'target-changed');
        }
      }
      let active = true;
      function entry(name) {
        if (!active) {
          throw new StateError('STATE_BUSY', name, 'scope-closed');
        }
        const found = entries.find((row) => row.def.name === name);
        if (!found) {
          throw new StateError('STATE_BUSY', 'store', 'document-not-locked');
        }
        assertOwned();
        if (destination(found.def) !== found.canonical) {
          throw new StateError('STATE_UNREADABLE', name, 'target-changed');
        }
        return found;
      }
      const scope = {
        exists(name) {
          const { def, canonical } = entry(name);
          readAt(def, canonical); // Existing corrupt state is not an initialization opportunity.
          try {
            fs.statSync(canonical);
            return true;
          } catch (error) {
            if (error.code === 'ENOENT') {
              return false;
            }
            throw new StateError('STATE_UNREADABLE', name, 'read', error.code);
          }
        },
        read(name) {
          const { def, canonical } = entry(name);
          return readAt(def, canonical);
        },
        replace(name, value) {
          const { def, canonical } = entry(name);
          readAt(def, canonical); // Explicit replacement cannot silently repair corrupt old bytes.
          return replaceAt(def, canonical, value);
        },
        async update(name, mutate) {
          const next = await mutate(scope.read(name));
          return scope.replace(name, next);
        },
      };
      try {
        return await work(scope);
      } finally {
        active = false;
      }
    }
    return enter(0);
  }
  async function withWorkspace(names, work) {
    const root = canonicalRoot(workspaceRoot, 'workspace');
    validateWorkspace(root);
    return withLock(join(root, '.setu-state.lock'), 30, 'workspace', () => {
      if (canonicalRoot(workspaceRoot, 'workspace') !== root) {
        throw new StateError('STATE_UNREADABLE', 'workspace', 'target-changed');
      }
      validateWorkspace(root);
      return withDocuments([...new Set(names)].map(descriptor), work);
    });
  }
  function withStores(names, work) {
    const defs = [...new Set(names)].map(descriptor);
    return defs.some((def) => def.coupled)
      ? withWorkspace(names, work)
      : withDocuments(defs, work);
  }
  function update(name, mutate) {
    return withStores([name], (scope) => scope.update(name, mutate));
  }
  function withRouting(work) {
    const root = canonicalRoot(setuDir, 'routing');
    const path = join(root, '.setu-routing.lock');
    const current = lockContext.getStore()?.at(-1);
    // Public routing adapters can compose only while no short metadata lock is held.
    if (current?.path === path && current.rank === 20) {
      assertOwned();
      return work();
    }
    return withLock(path, 20, 'routing', work);
  }
  function withUpdate(work) {
    const root = canonicalRoot(setuDir, 'update');
    // Outside the checkout: git stash --include-untracked must not stash its owner lock.
    return withLock(`${root}.setu-update.lock`, 0, 'update', work);
  }
  function targetKey(root, target) {
    if (!(repoName(target.repo) && branchName(target.name))) {
      throw new StateError('STATE_CORRUPT', 'target', 'validate');
    }
    const parts = [target.repo, ...target.name.split('/')];
    let current = root;
    for (const part of parts) {
      current = join(current, part);
      try {
        const stat = fs.lstatSync(current);
        if (stat.isSymbolicLink()) {
          throw new StateError(
            'STATE_UNREADABLE',
            'target',
            'conflicting-target-alias'
          );
        }
        if (!stat.isDirectory()) {
          throw new StateError('STATE_UNREADABLE', 'target', 'not-a-directory');
        }
      } catch (error) {
        if (error instanceof StateError) {
          throw error;
        }
        if (error.code !== 'ENOENT') {
          throw new StateError(
            'STATE_UNREADABLE',
            'target',
            'resolve',
            error.code
          );
        }
        // Absent descendants have the same expected canonical path before/after creation.
      }
    }
    return current;
  }
  async function withTargets(targets, work) {
    const root = canonicalRoot(workspaceRoot, 'workspace');
    validateWorkspace(root);
    const keys = [
      ...new Set(targets.map((target) => targetKey(root, target))),
    ].sort();
    const held = lockContext.getStore() ?? [];
    if (
      held.at(-1)?.rank === 10 &&
      keys.every((key) =>
        held.some((lock) => lock.rank === 10 && lock.orderKey === key)
      )
    ) {
      assertOwned();
      for (const target of targets) {
        targetKey(root, target);
      }
      return work(keys);
    }
    async function enter(index) {
      if (index < keys.length) {
        const key = keys[index],
          id = createHash('sha256').update(key).digest('hex');
        return withLock(
          join(root, `.setu-target-${id}.lock`),
          10,
          'target',
          () => enter(index + 1),
          key
        );
      }
      if (canonicalRoot(workspaceRoot, 'workspace') !== root) {
        throw new StateError('STATE_UNREADABLE', 'target', 'target-changed');
      }
      for (const target of targets) {
        targetKey(root, target);
      }
      return work(keys);
    }
    return enter(0);
  }
  function replaceText(path, text, { mode } = {}) {
    if (!isAbsolute(path) || typeof text !== 'string') {
      throw new StateError('STATE_CORRUPT', 'generated', 'validate');
    }
    const def = {
      encode: (value) => value,
      forceMode: mode,
      initial: () => '',
      name: 'generated',
      parse: (value) => value,
      path,
      symlinks: 'reject',
      validate: (value) => typeof value === 'string',
    };
    return withDocuments([def], (scope) => scope.replace('generated', text));
  }
  return {
    read,
    replace: (name, value) => update(name, () => value),
    replaceText,
    snapshot: (names) =>
      withStores(names, (scope) =>
        Object.fromEntries(names.map((name) => [name, scope.read(name)]))
      ),
    update,
    withRouting,
    withTargets,
    withUpdate,
    withWorkspace,
  };
}
