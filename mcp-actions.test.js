import { expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { createMcpActions } from './mcp-actions.js';
import { createWorkspaceState } from './workspace-state.js';

async function fixture(overrides = {}) {
  const inputSchema = {
    additionalProperties: false,
    properties: {
      code: { pattern: '^[A-Z]+$', type: 'string' },
      nested: {
        properties: {
          count: { minimum: 2, type: 'number' },
          mode: { enum: ['safe'], type: 'string' },
        },
        required: ['count', 'mode'],
        type: 'object',
      },
    },
    type: 'object',
  };
  const server = new McpServer({ name: 'test', version: '1.0.0' });
  server.tool('echo', () => ({
    content: [{ text: 'x'.repeat(200), type: 'text' }],
  }));
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client(
    { name: 'test', version: '1.0.0' },
    { capabilities: {} }
  );
  await client.connect(clientTransport);
  const root = mkdtempSync(join(tmpdir(), 'setu-mcp-actions-'));
  const configPath = join(root, 'config.json');
  writeFileSync(configPath, '{"setting":true}\n');
  const events = [];
  let listedTools = [{ inputSchema, name: 'echo' }];
  const actions = createMcpActions({
    callTool: async (serverId, tool, input) => ({
      ok: true,
      result: await client.callTool({ arguments: input, name: tool }),
    }),
    eventRecorder: {
      record: async (event) => {
        events.push(event);
        return { ok: true };
      },
    },
    id: (() => {
      let n = 0;
      return () => `id-${++n}`;
    })(),
    maxResultBytes: 80,
    now: () => 10,
    state: createWorkspaceState({ configPath, workspaceRoot: root }),
    tools: () => listedTools,
    ...overrides,
  });
  return {
    actions,
    client,
    configPath,
    events,
    inputSchema,
    server,
    setSchema: (schema) => {
      listedTools = [{ inputSchema: schema, name: 'echo' }];
    },
  };
}

test('an MCP tool must be saved as a reviewed action before a bounded invocation', async () => {
  const { actions, client, configPath, events, inputSchema, server } =
    await fixture();
  const configBefore = readFileSync(configPath, 'utf8');
  expect(await actions.invoke('missing', {}, undefined)).toMatchObject({
    code: 'MCP_ACTION_NOT_FOUND',
    ok: false,
  });
  const saved = await actions.save({
    inputSchema,
    mutates: true,
    serverId: 'local',
    title: 'Echo report',
    tool: 'echo',
  });
  expect(saved).toMatchObject({ action: { id: 'id-1' }, ok: true });
  expect(readFileSync(configPath, 'utf8')).toBe(configBefore);
  expect(await actions.invoke('id-1', {}, undefined)).toMatchObject({
    code: 'MCP_ACTION_CONFIRMATION_REQUIRED',
    ok: false,
  });
  expect(
    await actions.invoke(
      'id-1',
      { nested: { count: 1, mode: 'safe' } },
      undefined
    )
  ).toMatchObject({ code: 'MCP_ACTION_INPUT_INVALID', ok: false });
  const confirmation = actions.preflight('id-1', {}).confirmation.token;
  expect(
    await actions.invoke(
      'id-1',
      { nested: { count: 2, mode: 'safe' } },
      confirmation
    )
  ).toMatchObject({ code: 'MCP_ACTION_CONFIRMATION_REQUIRED', ok: false });
  expect(
    await actions.invoke('id-1', {}, confirmation, { source: 'mcp' })
  ).toMatchObject({
    ok: true,
    operationId: 'id-2',
    truncated: true,
  });
  expect(events.map((event) => event.state)).toEqual(['accepted', 'completed']);
  expect(events.every((event) => event.source === 'mcp')).toBe(true);
  await client.close();
  await server.close();
});

test('MCP action confirmation is invalidated by mapping or current-schema changes', async () => {
  const { actions, client, inputSchema, server, setSchema } = await fixture();
  const saved = await actions.save({
    inputSchema,
    mutates: true,
    serverId: 'local',
    title: 'Echo',
    tool: 'echo',
  });
  const oldConfirmation = actions.preflight(saved.action.id, {}).confirmation
    .token;
  const changed = await actions.save({
    id: saved.action.id,
    inputSchema,
    mutates: true,
    serverId: 'local',
    title: 'Renamed echo',
    tool: 'echo',
  });
  expect(changed.action.revision).not.toBe(saved.action.revision);
  expect(
    await actions.invoke(saved.action.id, {}, oldConfirmation)
  ).toMatchObject({ code: 'MCP_ACTION_CONFIRMATION_REQUIRED', ok: false });
  const changedConfirmation = actions.preflight(saved.action.id, {})
    .confirmation.token;
  setSchema({ properties: { changed: { type: 'string' } }, type: 'object' });
  expect(
    await actions.invoke(saved.action.id, {}, changedConfirmation)
  ).toMatchObject({ code: 'MCP_TOOL_UNAVAILABLE', ok: false });
  await client.close();
  await server.close();
});

test('MCP action persistence whitelists mappings and treats a thrown call outcome as unknown', async () => {
  const { inputSchema } = await fixture();
  const root = mkdtempSync(join(tmpdir(), 'setu-mcp-actions-'));
  const events = [];
  const actions = createMcpActions({
    callTool: async () => {
      throw new Error('lost transport');
    },
    eventRecorder: {
      record: async (event) => {
        events.push(event);
        return { ok: true };
      },
    },
    id: (() => {
      let n = 0;
      return () => `event-${++n}`;
    })(),
    state: createWorkspaceState({
      configPath: join(root, 'config.json'),
      workspaceRoot: root,
    }),
    tools: () => [{ inputSchema, name: 'echo' }],
  });
  const saved = await actions.save({
    ignored: 'never-store-me',
    inputSchema,
    mutates: false,
    serverId: 'local',
    title: 'Echo',
    tool: 'echo',
  });
  expect(saved.action.ignored).toBeUndefined();
  expect(
    await actions.invoke(
      saved.action.id,
      {},
      actions.preflight(saved.action.id, {}).confirmation.token
    )
  ).toMatchObject({ code: 'MCP_TOOL_CALL_UNKNOWN', ok: false });
  expect(events.map((event) => event.state)).toEqual(['accepted', 'unknown']);
});

test('a recorder refusal prevents an MCP action call', async () => {
  const { inputSchema } = await fixture();
  const root = mkdtempSync(join(tmpdir(), 'setu-mcp-actions-'));
  let calls = 0;
  const actions = createMcpActions({
    callTool: async () => {
      calls += 1;
      return { ok: true, result: {} };
    },
    eventRecorder: { record: async () => ({ ok: false }) },
    id: (() => {
      let n = 0;
      return () => `event-${++n}`;
    })(),
    state: createWorkspaceState({
      configPath: join(root, 'config.json'),
      workspaceRoot: root,
    }),
    tools: () => [{ inputSchema, name: 'echo' }],
  });
  const saved = await actions.save({
    inputSchema,
    mutates: false,
    serverId: 'local',
    title: 'Echo',
    tool: 'echo',
  });
  expect(
    await actions.invoke(
      saved.action.id,
      {},
      actions.preflight(saved.action.id, {}).confirmation.token
    )
  ).toMatchObject({ code: 'MCP_ACTION_EVENT_FAILED', ok: false });
  expect(calls).toBe(0);
});

async function boundedInvocation(maxResultBytes, result) {
  const inputSchema = { type: 'object' };
  let document = {};
  const actions = createMcpActions({
    callTool: async () => ({ ok: true, result }),
    eventRecorder: { record: async () => ({ ok: true }) },
    id: (() => {
      let n = 0;
      return () => `bounded-${++n}`;
    })(),
    maxResultBytes,
    state: {
      read: () => document,
      update: async (_name, update) => {
        document = update(document);
      },
    },
    tools: () => [{ inputSchema, name: 'echo' }],
  });
  const saved = await actions.save({
    inputSchema,
    mutates: false,
    serverId: 'local',
    title: 'Echo',
    tool: 'echo',
  });
  const confirmation = actions.preflight(saved.action.id, {}).confirmation
    .token;
  return actions.invoke(saved.action.id, {}, confirmation);
}

test('MCP result bounds terminate at UTF-8 boundaries for small and large emoji output', async () => {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  const emojiPayload = { text: '😀'.repeat(32) };
  // The serialized source has nine ASCII bytes before its first four-byte emoji.
  for (const ceiling of [20, 21, 22, 23, 24]) {
    const response = await boundedInvocation(ceiling, emojiPayload);
    expect(response).toMatchObject({ ok: true, truncated: true });
    expect(
      encoder.encode(JSON.stringify(response.result)).byteLength
    ).toBeLessThanOrEqual(ceiling);
    expect(() =>
      decoder.decode(encoder.encode(response.result.text))
    ).not.toThrow();
  }
  const response = await boundedInvocation(64 * 1024, {
    text: '😀'.repeat(40_000),
  });
  expect(response).toMatchObject({ ok: true, truncated: true });
  expect(
    encoder.encode(JSON.stringify(response.result)).byteLength
  ).toBeLessThanOrEqual(64 * 1024);
  expect(() =>
    decoder.decode(encoder.encode(response.result.text))
  ).not.toThrow();
});

test('missing acknowledgments prevent invocation or preserve its known outcome', async () => {
  for (const outcome of ['not-started', 'completed', 'failed', 'unknown']) {
    let writes = 0,
      calls = 0;
    const fx = await fixture({
      callTool: async () => {
        calls += 1;
        if (outcome === 'unknown') {
          throw new Error('lost response');
        }
        return outcome === 'failed'
          ? { code: 'TOOL_REFUSED', ok: false }
          : { ok: true, result: {} };
      },
      eventRecorder: {
        record: async () => {
          writes += 1;
          return outcome !== 'not-started' && writes === 1
            ? { ok: true }
            : undefined;
        },
      },
    });
    try {
      const saved = await fx.actions.save({
        inputSchema: fx.inputSchema,
        mutates: true,
        serverId: 'local',
        title: 'Echo',
        tool: 'echo',
      });
      const result = await fx.actions.invoke(
        saved.action.id,
        {},
        fx.actions.preflight(saved.action.id, {}).confirmation.token,
        { source: 'cli' }
      );
      expect(result.outcomeRecorded).toBe(false);
      expect(result.operationId).toBe('id-2');
      expect(calls).toBe(outcome === 'not-started' ? 0 : 1);
      if (outcome === 'completed') {
        expect(result.ok).toBe(true);
      }
      if (outcome === 'failed') {
        expect(result).toMatchObject({
          code: 'TOOL_REFUSED',
          ok: false,
          state: 'failed',
        });
      }
      if (outcome === 'unknown') {
        expect(result).toMatchObject({
          code: 'MCP_TOOL_CALL_UNKNOWN',
          ok: false,
          state: 'unknown',
        });
      }
    } finally {
      await fx.client.close();
      await fx.server.close();
    }
  }
});

test('save rechecks a journal changed under its update lock and leaves it unchanged', async () => {
  const corrupt = { actions: null, unrelated: true };
  let document = {},
    attempted = 0;
  const fx = await fixture({
    state: {
      read: () => document,
      update: async (_name, update) => {
        attempted += 1;
        document = corrupt;
        document = update(document);
      },
    },
  });
  try {
    expect(
      await fx.actions.save({
        inputSchema: fx.inputSchema,
        mutates: true,
        serverId: 'local',
        title: 'Echo',
        tool: 'echo',
      })
    ).toMatchObject({ code: 'MCP_ACTION_STATE_FAILED', ok: false });
    expect(attempted).toBe(1);
    expect(document).toBe(corrupt);
  } finally {
    await fx.client.close();
    await fx.server.close();
  }
});
