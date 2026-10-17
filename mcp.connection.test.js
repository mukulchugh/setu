import { expect, test } from 'bun:test';
import { connectMcpServer, mcpHasOwnedWork, mcpStatus } from './mcp.js';

test('a failed stdio connection does not retain MCP ownership', async () => {
  await connectMcpServer(
    {
      args: [],
      command: 'setu-command-that-does-not-exist',
      id: 'failed-stdio',
      transport: 'stdio',
    },
    '/tmp'
  );
  expect(mcpStatus('failed-stdio').status).toBe('error');
  expect(mcpHasOwnedWork()).toBe(false);
});

const outcomeFixture = `
import { mock } from 'bun:test';
const scenario = process.env.SETU_MCP_SCENARIO;
let calls = 0;
mock.module('@modelcontextprotocol/sdk/client', () => ({
  Client: class {
    async connect() {}
    async listTools() {
      return { tools: [{ name: 'probe', inputSchema: { type: 'object' } }] };
    }
    async callTool() {
      calls += 1;
      if (scenario === 'unknown') throw new Error('lost response after effect');
      return {
        content: [{ type: 'text', text: 'x'.repeat(400) }],
        isError: scenario === 'failed',
      };
    }
  },
}));
mock.module('@modelcontextprotocol/sdk/client/stdio.js', () => ({
  StdioClientTransport: class {
    async close() { this.onclose?.(); }
  },
}));
const { connectMcpServer, disconnectMcpServer } = await import('./mcp.js');
const { createMcpActions } = await import('./mcp-actions.js');
await connectMcpServer({ id: 'probe', transport: 'stdio', command: 'unused' }, '/tmp');
let document = {};
let sequence = 0;
const events = [];
const actions = createMcpActions({
  state: {
    read: () => document,
    update: async (_name, update) => { document = update(document); },
  },
  id: () => 'probe-' + ++sequence,
  maxResultBytes: 80,
  eventRecorder: { record: async (event) => {
    events.push(event);
    return { ok: true };
  } },
});
const saved = await actions.save({
  serverId: 'probe', tool: 'probe', title: 'Probe', mutates: true,
  inputSchema: { type: 'object' },
});
if (!saved.ok) throw new Error(JSON.stringify(saved));
const confirmation = actions.preflight(saved.action.id, {}).confirmation.token;
if (scenario === 'disconnected') await disconnectMcpServer('probe');
const input = scenario === 'invalid' ? 'invalid' : {};
const result = await actions.invoke(saved.action.id, input, confirmation);
await disconnectMcpServer('probe');
console.log(JSON.stringify({ calls, events, result }));
`;

test.each(['completed', 'failed', 'unknown', 'disconnected', 'invalid'])(
  'connected MCP adapter and action journal preserve outcome: %s',
  (scenario) => {
    // Isolate SDK mocks so other tests keep their real protocol clients.
    const child = Bun.spawnSync({
      cmd: [process.execPath, '--eval', outcomeFixture],
      cwd: import.meta.dir,
      env: { ...process.env, SETU_MCP_SCENARIO: scenario },
    });
    expect(child.stderr.toString()).toBe('');
    expect(child.exitCode).toBe(0);
    const { calls, events, result } = JSON.parse(child.stdout.toString());
    if (scenario === 'disconnected' || scenario === 'invalid') {
      expect(calls).toBe(0);
      expect(events).toEqual([]);
      expect(result.ok).toBe(false);
      return;
    }
    expect(calls).toBe(1);
    expect(events.map((event) => event.state)).toEqual(['accepted', scenario]);
    expect(result.ok).toBe(scenario === 'completed');
    if (scenario === 'failed') {
      expect(result).toMatchObject({
        code: 'MCP_TOOL_ERROR',
        state: 'failed',
        truncated: true,
      });
      expect(
        Buffer.byteLength(JSON.stringify(result.result))
      ).toBeLessThanOrEqual(80);
    }
    if (scenario === 'unknown') {
      expect(result).toMatchObject({
        code: 'MCP_TOOL_CALL_UNKNOWN',
        state: 'unknown',
      });
    }
  }
);
