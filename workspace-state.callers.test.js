import { afterEach, expect, test } from 'bun:test';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  appendArchivedWorktree,
  approveSidecar,
  assignPort,
  composeProjectName,
  loadAllSidecars,
  loadArchivedWorktrees,
  loadConfig,
  loadCustomAgents,
  loadFileSyncGlobs,
  loadMcpServers,
  loadProjects,
  loadSidecarApprovals,
  registerProject,
  releasePort,
  reloadCaddy,
  saveConfig,
  saveCustomAgents,
  saveFileSyncGlobs,
  saveMcpServers,
  saveSidecars,
  seedSidecarApprovalsIfMissing,
  syncHosts,
  workspaceState,
  writeCaddy,
  writeDockerCompose,
} from './lib.js';
import { SetuOAuthProvider } from './mcp.js';

const roots = [];
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'setu-state-callers-'));
  roots.push(root);
  return root;
}
afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { force: true, recursive: true });
  }
});

test('actual config patch caller preserves sibling settings and refuses corrupt data', async () => {
  const root = fixture(),
    options = { configPath: join(root, 'config.json') };
  await Promise.all([
    saveConfig({ extension: { future: true } }, options),
    saveConfig({ lastUpdateCheck: 123 }, options),
  ]);
  expect(loadConfig(options)).toEqual({
    extension: { future: true },
    lastUpdateCheck: 123,
  });
  writeFileSync(options.configPath, '{broken');
  await expect(
    saveConfig({ domain: 'changed' }, options)
  ).rejects.toMatchObject({ code: 'STATE_CORRUPT' });
  expect(readFileSync(options.configPath, 'utf8')).toBe('{broken');
});

test('actual sidecar writer fails closed and independent project changes retain siblings', async () => {
  const root = fixture();
  writeFileSync(join(root, 'sidecars.json'), '{broken');
  await expect(saveSidecars(root, 'a', [])).rejects.toMatchObject({
    code: 'STATE_CORRUPT',
  });
  expect(readFileSync(join(root, 'sidecars.json'), 'utf8')).toBe('{broken');
  writeFileSync(join(root, 'sidecars.json'), '{}');
  await Promise.all([
    saveSidecars(root, 'a', [{ command: 'first', name: 'one' }]),
    saveSidecars(root, 'b', []),
  ]);
  expect(loadAllSidecars(root, 'a')).toEqual([
    { command: 'first', name: 'one' },
  ]);
  expect(loadAllSidecars(root, 'b')).toEqual([]);
});

test('approval initialization is missing-only, validates both stores, and explicit approval checks current commands', async () => {
  const root = fixture();
  await saveSidecars(root, 'a', [{ args: [], command: 'old', name: 'worker' }]);
  await seedSidecarApprovalsIfMissing(root);
  expect(loadSidecarApprovals(root, 'a')).toEqual({ worker: 'old' });
  await saveSidecars(root, 'a', [{ args: [], command: 'new', name: 'worker' }]);
  await expect(approveSidecar(root, 'a', 'worker', 'old', [])).rejects.toThrow(
    'changed'
  );
  await approveSidecar(root, 'a', 'worker', 'new', []);
  expect(loadSidecarApprovals(root, 'a')).toEqual({ worker: 'new' });
  writeFileSync(join(root, 'sidecar-approvals.json'), '{broken');
  await expect(seedSidecarApprovalsIfMissing(root)).rejects.toMatchObject({
    code: 'STATE_CORRUPT',
  });
});

test('actual allocation reserves distinct ports and project bases without lost writes or treating unknown listeners as free', async () => {
  const root = fixture();
  await Promise.all([
    registerProject(root, { name: 'a' }),
    registerProject(root, { name: 'b' }),
  ]);
  expect(
    Object.values(loadProjects(root))
      .map((row) => row.base)
      .sort()
  ).toEqual([3000, 3100]);
  const probe = async () => new Set([3000]);
  const ports = await Promise.all([
    assignPort(root, 'a', 'one', { probe }),
    assignPort(root, 'a', 'two', { probe }),
  ]);
  expect(ports.sort()).toEqual([3001, 3002]);
  await expect(
    assignPort(root, 'a', 'unknown', { probe: () => Promise.resolve(null) })
  ).rejects.toMatchObject({ code: 'STATE_UNREADABLE' });
  await releasePort(root, 'a', 'one');
  expect(await assignPort(root, 'a', 'three', { probe })).toBe(3001);
});

test('pending reservations participate in allocation before the active registry is released', async () => {
  const root = fixture(),
    state = workspaceState(root);
  await state.replace('removals', { operation: { key: 'a/old', port: 3200 } });
  expect(
    await assignPort(root, 'a', 'new', { probe: async () => new Set() })
  ).toBe(3201);
  await expect(
    assignPort(root, 'a', 'old', { probe: async () => new Set() })
  ).rejects.toThrow('pending removal');
});

test('archive deduplicates operation IDs, preserves unknown legacy fields and caps at 500', async () => {
  const root = fixture();
  await workspaceState(root).replace('archive', [
    { legacy: true },
    ...Array.from({ length: 497 }, (_, i) => ({ name: String(i) })),
  ]);
  await Promise.all([
    appendArchivedWorktree(root, { name: 'first', operationId: 'one' }),
    appendArchivedWorktree(root, { name: 'second', operationId: 'two' }),
  ]);
  await appendArchivedWorktree(root, { completed: true, operationId: 'one' });
  const records = loadArchivedWorktrees(root);
  expect(records).toHaveLength(500);
  expect(records[0]).toEqual({ legacy: true });
  expect(records.find((row) => row.operationId === 'one')).toEqual({
    completed: true,
    name: 'first',
    operationId: 'one',
  });
});

test('file-sync patches preserve unrelated projects', async () => {
  const root = fixture();
  await Promise.all([
    saveFileSyncGlobs(root, 'a', ['.env.test']),
    saveFileSyncGlobs(root, 'b', ['config/*']),
  ]);
  expect(loadFileSyncGlobs(root, 'a')).toEqual(['.env.test']);
  expect(loadFileSyncGlobs(root, 'b')).toEqual(['config/*']);
});

test('valid repository names matching object properties remain ordinary per-project keys', async () => {
  const root = fixture();
  expect(loadAllSidecars(root, 'constructor')).toEqual([]);
  expect(loadSidecarApprovals(root, '__proto__')).toEqual({});
  await saveSidecars(root, '__proto__', [
    { command: 'fixture-only', name: 'worker' },
  ]);
  await seedSidecarApprovalsIfMissing(root);
  expect(loadAllSidecars(root, '__proto__')).toEqual([
    { command: 'fixture-only', name: 'worker' },
  ]);
  expect(loadSidecarApprovals(root, '__proto__')).toEqual({
    worker: 'fixture-only',
  });
});

test('actual OAuth Promise saves preserve another issuer and both fields of one issuer without provider calls', async () => {
  const root = fixture();
  const first = new SetuOAuthProvider(root, 'first', 'https://first.invalid');
  const sameIssuer = new SetuOAuthProvider(
    root,
    'same',
    'https://first.invalid'
  );
  const second = new SetuOAuthProvider(
    root,
    'second',
    'https://second.invalid'
  );
  await Promise.all([
    first.saveClientInformation({ client_id: 'fixture-client' }),
    sameIssuer.saveTokens({ access_token: 'fixture-first' }),
    second.saveTokens({ access_token: 'fixture-second' }),
  ]);
  expect(first.clientInformation()).toEqual({ client_id: 'fixture-client' });
  expect(first.tokens()).toEqual({ access_token: 'fixture-first' });
  expect(second.tokens()).toEqual({ access_token: 'fixture-second' });
  expect(statSync(join(root, 'mcp-tokens.json')).mode % 0o1000).toBe(0o600);
  writeFileSync(join(root, 'mcp-tokens.json'), '{broken');
  await expect(
    first.saveTokens({ access_token: 'replacement' })
  ).rejects.toMatchObject({ code: 'STATE_CORRUPT' });
  expect(readFileSync(join(root, 'mcp-tokens.json'), 'utf8')).toBe('{broken');
});

test('whole-list agent and MCP saves preserve existing stable IDs while rejecting damaged previous stores', async () => {
  const root = fixture();
  await saveCustomAgents(root, [
    { command: 'test-only', id: 'my-agent', label: 'Renamed' },
  ]);
  await saveMcpServers(root, [
    {
      httpAuthMode: 'oauth',
      id: 'oauth-id',
      name: 'Renamed',
      transport: 'http',
      url: 'https://example.invalid',
    },
  ]);
  expect(loadCustomAgents(root)[0].id).toBe('my-agent');
  expect(loadMcpServers(root)[0].id).toBe('oauth-id');
  writeFileSync(join(root, 'mcp-servers.json'), '[] broken');
  await expect(saveMcpServers(root, [])).rejects.toMatchObject({
    code: 'STATE_CORRUPT',
  });
});

test('actual Compose writer uses exact admitted limits and never rewrites shared env input', async () => {
  const root = fixture(),
    wt = join(root, 'r', 'main');
  mkdirSync(wt, { recursive: true });
  writeFileSync(join(wt, '.envrc'), 'export PORT=3200\n');
  const shared = join(root, 'shared.env');
  writeFileSync(shared, 'fixture-only');
  symlinkSync(shared, join(wt, '.env.local'));
  const spec = {
    container: true,
    limits: { cpus: 0.5, memMb: 256 },
    port: 3200,
    project: composeProjectName('r', 'main'),
  };
  const path = await writeDockerCompose(
    { containerCpuLimit: 99, containerMemoryLimit: '99g', workspace: root },
    'r',
    'main',
    3200,
    undefined,
    spec
  );
  const yaml = readFileSync(path, 'utf8');
  expect(yaml).toContain('cpus: "0.5"');
  expect(yaml).toContain('mem_limit: "256m"');
  expect(readFileSync(shared, 'utf8')).toBe('fixture-only');
});

test('actual routing wrappers stage fresh registry values inside shared routing scope with no privileged calls', async () => {
  const root = fixture(),
    state = workspaceState(root, { setuDir: root });
  mkdirSync(join(root, 'caddy.d'));
  await state.replace('ports', [
    { key: 'r/main', name: 'main', port: 3200, repo: 'r' },
  ]);
  const hostsPath = join(root, 'hosts'),
    stagingPath = join(root, 'hosts.tmp');
  writeFileSync(hostsPath, '127.0.0.1 localhost\n');
  const run = (_command, args) => {
    expect(existsSync(join(root, '.setu-routing.lock'))).toBe(true);
    expect(existsSync(join(root, '.setu-state.lock'))).toBe(false);
    if (args[1] === '/bin/cp') {
      copyFileSync(args[2], args[3]);
    }
  };
  await state.withRouting(async () => {
    await writeCaddy({ workspace: root }, 'r', 'main', 3200, false, { state });
    expect(await syncHosts(root, { hostsPath, run, stagingPath, state })).toBe(
      true
    );
    expect(await reloadCaddy(root, { run, state })).toBe(true);
  });
  expect(readFileSync(hostsPath, 'utf8')).toContain('r.quivly.local');
  await state.replace('ports', []);
  await expect(
    writeCaddy({ workspace: root }, 'r', 'main', 3200, false, { state })
  ).rejects.toThrow('registration changed');
});

test('Caddy replacement refuses unreconciled committed output before a caller can reload or restart', async () => {
  let reconciled = false,
    subsequentApply = false;
  const state = {
    replaceText: async () => ({
      committed: true,
      reconciled,
      status: 'committed-with-durability-warning',
      value: 'installed routing',
      warning: { code: 'STATE_DURABILITY_UNCONFIRMED' },
    }),
    snapshot: () => Promise.resolve({ ports: [{ key: 'r/main', port: 3200 }] }),
    withRouting: (task) => task(),
  };
  await expect(
    writeCaddy({ workspace: '/isolated' }, 'r', 'main', 3200, false, {
      state,
    }).then(() => {
      subsequentApply = true;
    })
  ).rejects.toMatchObject({
    code: 'STATE_RECONCILIATION_REQUIRED',
    committed: true,
  });
  expect(subsequentApply).toBe(false);
  reconciled = true;
  expect(
    await writeCaddy({ workspace: '/isolated' }, 'r', 'main', 3200, false, {
      state,
    })
  ).toMatchObject({ committed: true, reconciled: true });
});
