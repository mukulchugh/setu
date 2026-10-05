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
