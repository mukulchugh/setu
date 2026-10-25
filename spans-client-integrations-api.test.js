import { afterEach, expect, test } from 'bun:test';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCli } from './cli.js';
import { createSpansClientIntegrationsTransport } from './portal/spans-client-integrations';
import { createPortalRuntime } from './portal.js';
import { createWorkspaceState } from './workspace-state.js';

const roots = [];
const initialExitCode = process.exitCode ?? 0;
afterEach(() => {
  process.exitCode = initialExitCode;
  for (const root of roots.splice(0)) {
    rmSync(root, { force: true, recursive: true });
  }
});

async function fixture(work) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'spans-clients-api-')));
  roots.push(root);
  const home = join(root, 'home');
  mkdirSync(home, { mode: 0o700 });
  const archive = join(root, 'absent-archive');
  const receipts = join(root, 'integrations');
  const config = { tunnel: 'fixture', workspace: root };
  const state = createWorkspaceState({
    configPath: join(root, 'config.json'),
    setuDir: root,
    workspaceRoot: root,
  });
  await state.replace('config', config);
  const runtime = await createPortalRuntime({
    computeWorktrees: () => Promise.resolve([]),
    config,
    indexPage: new Response('fixture'),
    managedAgents: {
      dispose: () => Promise.resolve(),
      recover: () => Promise.resolve(),
    },
    observeProcess: () => Promise.resolve({ state: 'unknown' }),
    port: 43_210,
    projects: {},
    reconcileDevServers: () => Promise.resolve(),
    reconcileTriggerSidecars: () => Promise.resolve(),
    routing: { syncHosts: () => Promise.resolve() },
    seedSidecarApprovals: () => Promise.resolve(),
    serve: () => ({ stop: () => undefined }),
    spansIntegrationHome: home,
    spansIntegrationRoot: receipts,
    spansRoot: archive,
    state,
    timers: { clearInterval: () => undefined, setInterval: () => 1 },
  });
  await runtime.start();
  const request = (path, init) =>
    runtime.handle(new Request(`http://localhost:43210${path}`, init), {
      requestIP: () => ({ address: '127.0.0.1' }),
      timeout: () => undefined,
    });
  const post = (path, body) =>
    request(path, {
      body: JSON.stringify(body),
      headers: { 'content-type': 'application/json', 'x-setu-source': 'ui' },
      method: 'POST',
    });
  const transport = createSpansClientIntegrationsTransport(request);
  try {
    await work({ archive, home, post, receipts, request, state, transport });
  } finally {
    await runtime.dispose();
  }
}

async function mcp(request, method, params) {
  const response = await request('/mcp', {
    body: JSON.stringify({ id: 1, jsonrpc: '2.0', method, params }),
    headers: {
      accept: 'application/json, text/event-stream',
      'content-type': 'application/json',
      host: 'localhost:43210',
    },
    method: 'POST',
  });
  const text = await response.text();
  const raw = text.startsWith('event:')
    ? text
        .split('\n')
        .find((line) => line.startsWith('data: '))
        .slice(6)
    : text;
  return JSON.parse(raw);
}

async function cli(request, args) {
  const originalLog = console.log;
  const originalError = console.error;
  const output = [];
  console.log = (text) => output.push(String(text));
  console.error = () => undefined;
  try {
    const code = await runCli(['spans', 'integrations', ...args, '--json'], {
      request: async ({ path, method, body }) => {
        const response = await request(path, {
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          headers: {
            'content-type': 'application/json',
            'x-setu-source': 'cli',
          },
          method,
        });
        return response.json();
      },
    });
    return {
      code,
      output: output.length ? JSON.parse(output.join('\n')) : null,
    };
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }
}

const sharedPath = (home) => join(home, '.agents/skills/setu-spans/SKILL.md');

test('Settings transport reviews and applies exact shared bytes, then reconciles via the same portal owner', async () => {
  await fixture(async ({ archive, home, receipts, transport }) => {
    const status = await transport.getStatus();
    expect(status.ok).toBe(true);
    expect(status.summary.clients).toContain('claude');
    expect(status.summary.operations[0]).toMatchObject({ kind: 'install' });
    expect(existsSync(receipts)).toBe(false);
    expect(existsSync(sharedPath(home))).toBe(false);
    const review = await transport.review();
    expect(review.ok).toBe(true);
    expect(review.reviewId).toBeString();
    expect(review.phrase).toBeString();
    expect(existsSync(sharedPath(home))).toBe(false);
    const applied = await transport.apply({
      response: review.phrase,
      reviewId: review.reviewId,
    });
    expect(applied.ok).toBe(true);
    expect(readFileSync(sharedPath(home), 'utf8')).toContain(
      'name: setu-spans'
    );
    const after = await transport.reconcile();
    expect(after.ok).toBe(true);
    expect(after.summary.operations[0].kind).toBe('no-op');
    const codex = after.summary.statuses.find((row) => row.client === 'codex');
    expect(codex).toMatchObject({
      connected: 'unknown',
      freshSession: 'unknown',
      installed: true,
      skillActivated: 'unknown',
    });
    const replay = await transport.apply({
      response: review.phrase,
      reviewId: review.reviewId,
    });
    expect(replay.ok).toBe(false);
    const removal = await transport.review({
      clients: ['codex', 'cursor'],
      removeSharedArtifact: true,
    });
    expect(removal.ok).toBe(true);
    expect(removal.phrase).toStartWith('Remove');
    expect(removal.summary.sharedArtifactRemoval.affectedClients).toEqual([
      'codex',
      'cursor',
    ]);
    expect(
      await transport.apply({
        response: removal.phrase,
        reviewId: removal.reviewId,
      })
    ).toMatchObject({ ok: true });
    expect(existsSync(sharedPath(home))).toBe(false);
    expect(
      existsSync(
        new URL('./claude-plugin/skills/setu-spans/SKILL.md', import.meta.url)
      )
    ).toBe(true);
    expect(existsSync(archive)).toBe(false);
  });
});

test('CLI shares the portal service and preserves user edits during a stale review', async () => {
  await fixture(async ({ home, request }) => {
    const review = await cli(request, ['review']);
    expect(review.code).toBe(0);
    expect(review.output.reviewId).toBeString();
    const path = sharedPath(home);
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, 'user-owned content\n');
    const result = await cli(request, [
      'apply',
      '--input',
      JSON.stringify({
        response: review.output.phrase,
        reviewId: review.output.reviewId,
      }),
    ]);
    expect(result.code).toBe(1);
    expect(result.output.ok).toBe(false);
    expect(readFileSync(path, 'utf8')).toBe('user-owned content\n');
    const status = await cli(request, ['status']);
    expect(status.code).toBe(0);
    expect(status.output.summary.ready).toBe(false);
  });
});

test('MCP exposes only preview, and cannot issue challenges or mutate client artifacts', async () => {
  await fixture(async ({ home, receipts, request }) => {
    const listed = await mcp(request, 'tools/list', {});
    const names = listed.result.tools.map((tool) => tool.name);
    expect(names).toContain('get_spans_integrations');
    expect(names.filter((name) => name.includes('spans_integrations'))).toEqual(
      ['get_spans_integrations']
    );
    const result = await mcp(request, 'tools/call', {
      arguments: {},
      name: 'get_spans_integrations',
    });
    expect(result.result.isError).toBe(false);
    expect(result.result.structuredContent.ok).toBe(true);
    expect(result.result.structuredContent).not.toHaveProperty('reviewId');
    const refused = await mcp(request, 'tools/call', {
      arguments: {},
      name: 'apply_spans_integrations',
    });
    expect(refused.error ?? refused.result?.isError).toBeTruthy();
    expect(existsSync(sharedPath(home))).toBe(false);
    expect(existsSync(receipts)).toBe(false);
  });
});

test('update cutover blocks review/apply/reconcile before receipt or client-file effects', async () => {
  await fixture(async ({ home, post, receipts, request }) => {
    const capabilities = await (
      await request('/api/update/capabilities')
    ).json();
    const owner = await (
      await post('/api/update/quiesce', capabilities)
    ).json();
    expect(owner.token).toBeString();
    const results = await Promise.all(
      ['review', 'apply', 'reconcile'].map(async (action) =>
        (await post(`/api/spans/integrations/${action}`, {})).json()
      )
    );
    for (const result of results) {
      expect(result).toMatchObject({ code: 'ADMISSION_CLOSED', ok: false });
    }
    expect(existsSync(sharedPath(home))).toBe(false);
    expect(existsSync(receipts)).toBe(false);
  });
});
