// Tripwires for the wake boundary. The behavioral proof that Send now starts nothing is in
// links-attention.test.js and links-api.test.js; these only fail if someone adds a way in: a keystroke,
// a second caller of the terminal paste, a Links module that can reach a terminal or start a process, or
// an ingress that became a route. They read source and the public tables, nothing else.
import { expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createLinksRuntime } from './links-runtime.js';
import { handleMcpRequest, initMcpServer } from './mcp-server.js';
import { PORTAL_API_ROUTES } from './portal-routes.js';

const root = import.meta.dir;
const TEST_FILE = /\.test\.(js|ts|tsx)$/;
const KEYSTROKE = /keystroke|key code|System Events|CGEvent|osascript.*return/i;
const PASTE_CALLER = /terminal\.deliver\b/;
const TERMINAL_REACH =
  /native-terminal|review-handoff|terminal-attention|runAppleScript/;
const STARTS_PROCESS = /child_process|Bun\.spawn|execFile|spawnSync/;
const INGRESS_NAME = /attentionSend|raise|wake/i;
const INGRESS_ROUTE = /attention\/(send|raise|new)|wake/i;
const MCP_OFFER =
  /wake|send.?now|open.?(attention|request)|raise.?attention|attention.?(send|request)/i;
const SELF = 'links-wake.callers.test.js';
// The engine client and the lifecycle-owned transport run the engine; the build script runs cargo; the naming check lists files with git.
const MAY_START_PROCESSES = new Set([
  'links-client.js',
  'links-engine.js',
  'links-naming-check.js',
  'links-transport.js',
]);

const sources = readdirSync(root)
  .filter((file) => file.endsWith('.js') && !TEST_FILE.test(file))
  .filter(
    (file) => !(file.includes('fixture') || file.includes('test-support'))
  )
  .map((file) => [file, readFileSync(join(root, file), 'utf8')]);
const linksModules = sources.filter(([file]) => file.startsWith('links-'));
const sourceOf = (name) => sources.find(([file]) => file === name)[1];

test('no shipped source types a key, presses Return or drives System Events', () => {
  const offenders = sources
    .filter(([file, text]) => file !== SELF && KEYSTROKE.test(text))
    .map(([file]) => file);
  expect(offenders).toEqual([]);
});

test('terminal text input has one definition and one production caller: the review handoff', () => {
  const definers = sources
    .filter(([, text]) => text.includes('buildGhosttyPasteCommand'))
    .map(([file]) => file);
  expect(definers).toEqual(['native-terminal.js']);
  const adapters = sources
    .filter(([, text]) => PASTE_CALLER.test(text))
    .map(([file]) => file);
  expect(adapters).toEqual(['managed-agent-services.js']);
  // Inside it, the adapter is handed to the review handoff and nowhere else.
  const services = sourceOf('managed-agent-services.js');
  expect(services.match(/terminal\.deliver\b/g)).toHaveLength(1);
  expect(services).toContain('deliver: terminal.deliver');
});

test('no Links module can reach a terminal, and only the engine client starts a process', () => {
  for (const [file, text] of linksModules) {
    expect(text, file).not.toMatch(TERMINAL_REACH);
    if (!MAY_START_PROCESSES.has(file)) {
      expect(text, file).not.toMatch(STARTS_PROCESS);
    }
  }
});

test('the attention ingress that trusts its caller is not exported to the portal, a route or a tool', () => {
  const runtime = createLinksRuntime({
    isProject: () => false,
    resolveTarget: () => null,
    sessions: { list: () => ({ ok: true, sessions: [] }) },
  });
  expect(Object.keys(runtime).filter((key) => INGRESS_NAME.test(key))).toEqual(
    []
  );
  expect(Object.keys(runtime.delivery).sort()).toEqual([
    'claimExact',
    'confirmExact',
  ]);
  for (const route of PORTAL_API_ROUTES) {
    expect(route.path, route.path).not.toMatch(INGRESS_ROUTE);
  }
  // The only attention routes are the existing list, focus and hook, the exact open and the opt-in.
  expect(
    PORTAL_API_ROUTES.filter((route) => route.path.includes('attention'))
      .map((route) => route.path)
      .sort()
  ).toEqual([
    '/api/attention',
    '/api/attention/focus',
    '/api/attention/hook',
    '/api/links/attention/open',
    '/api/links/share/attention',
  ]);
});

test('the generic MCP endpoint offers no way to wake, send now, open a request or raise one', async () => {
  initMcpServer({});
  const response = await handleMcpRequest(
    new Request('http://localhost:2999/mcp', {
      body: JSON.stringify({
        id: 1,
        jsonrpc: '2.0',
        method: 'tools/list',
        params: {},
      }),
      headers: {
        accept: 'application/json, text/event-stream',
        'content-type': 'application/json',
        host: 'localhost:2999',
      },
      method: 'POST',
    })
  );
  const body = await response.text();
  const { tools } = JSON.parse(
    body.startsWith('event:')
      ? body
          .split('\n')
          .find((line) => line.startsWith('data: '))
          .slice(6)
      : body
  ).result;
  expect(tools.length).toBeGreaterThan(10);
  const offenders = tools.filter((tool) =>
    MCP_OFFER.test(`${tool.name} ${tool.description}`)
  );
  expect(offenders).toEqual([]);
});
