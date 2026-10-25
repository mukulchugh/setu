import { afterEach, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runCli } from './cli.js';
import { handleMcpRequest, initMcpServer } from './mcp-server.js';
import { dispatchPortalResourceRoute } from './portal-resource-services.js';
import { PORTAL_API_ROUTES } from './portal-routes.js';
import { createResourceAdmission } from './resource-admission.js';
import { createSpansDrafts } from './spans-drafts.js';
import { openSpansStore } from './spans-store.js';
import { createWorkspaceState } from './workspace-state.js';

// Synthetic fixtures only: temporary roots, fake services, fake stores. No
// portal, provider or listening server is ever started, and no real archive
// is read or indexed.

const initialExitCode = process.exitCode ?? 0;
const roots = [];
afterEach(() => {
  process.exitCode = initialExitCode;
  initMcpServer({});
  for (const root of roots.splice(0)) {
    rmSync(root, { force: true, recursive: true });
  }
});

function tempRoot(prefix) {
  const root = mkdtempSync(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

const CLI_PATH = fileURLToPath(new URL('./cli.js', import.meta.url));

const searchPage = {
  coverage: {
    complete: true,
    generation: 3,
    indexedSequence: 9,
    latestSequence: 9,
    stale: false,
  },
  generation: 3,
  hasMore: false,
  hits: [
    {
      eventId: 'event-1',
      historical: true,
      runId: 'run-1',
      sequence: 4,
      snippet: 'alpha result',
    },
  ],
  nextSequence: 4,
  ok: true,
  throughSequence: 9,
};

const statusPage = {
  coverage: searchPage.coverage,
  generation: 3,
  ok: true,
};

const failureBody = (code) => ({ code, error: `fixed ${code}`, ok: false });

// ── HTTP routes ───────────────────────────────────────────────────────────────

async function get(services, path, init = {}) {
  const response = await dispatchPortalResourceRoute(
    services,
    new Request(`http://portal.test${path}`, init)
  );
  return response
    ? { body: JSON.parse(await response.text()), status: response.status }
    : null;
}

function recordingServices(result) {
  const calls = { search: [], status: [] };
  return {
    calls,
    services: {
      spansSearch: (input) => {
        calls.search.push(input);
        return typeof result === 'function' ? result(input) : result;
      },
      spansSearchStatus: (input) => {
        calls.status.push(input);
        return statusPage;
      },
    },
  };
}

test('the route manifest lists exactly the two read-only GET search routes', () => {
  const routes = PORTAL_API_ROUTES.filter((route) =>
    route.path.startsWith('/api/spans/search')
  );
  expect(routes).toEqual([
    { methods: ['GET'], path: '/api/spans/search' },
    { methods: ['GET'], path: '/api/spans/search/status' },
  ]);
});

test('GET /api/spans/search converts exact counts and returns the service page with 200', async () => {
  const { calls, services } = recordingServices(searchPage);
  const reply = await get(
    services,
    '/api/spans/search?query=alpha%20beta&limit=10&runId=run-1&afterSequence=5&throughSequence=9&expectedGeneration=3'
  );
  expect(reply.status).toBe(200);
  expect(reply.body).toEqual(searchPage);
  expect(calls.search).toEqual([
    {
      afterSequence: 5,
      expectedGeneration: 3,
      limit: 10,
      query: 'alpha beta',
      runId: 'run-1',
      throughSequence: 9,
    },
  ]);
});

test('the first page needs only a query, and afterSequence 0 needs no generation', async () => {
  const { calls, services } = recordingServices(searchPage);
  expect((await get(services, '/api/spans/search?query=alpha')).status).toBe(
    200
  );
  expect(
    (await get(services, '/api/spans/search?query=alpha&afterSequence=0'))
      .status
  ).toBe(200);
  expect(calls.search).toEqual([
    { query: 'alpha' },
    { afterSequence: 0, query: 'alpha' },
  ]);
});

test('GET /api/spans/search/status reads without parameters and returns 200', async () => {
  const { calls, services } = recordingServices(searchPage);
  const reply = await get(services, '/api/spans/search/status');
  expect(reply).toEqual({ body: statusPage, status: 200 });
  expect(calls.status).toEqual([{}]);
});

test('malformed search requests answer 400 without calling the service', async () => {
  const { calls, services } = recordingServices(searchPage);
  for (const path of [
    '/api/spans/search',
    '/api/spans/search?query=',
    '/api/spans/search?limit=5',
    '/api/spans/search?query=a&query=b',
    '/api/spans/search?query=a&limit=abc',
    '/api/spans/search?query=a&limit=-1',
    '/api/spans/search?query=a&limit=1.5',
    '/api/spans/search?query=a&limit=01',
    '/api/spans/search?query=a&limit=1e3',
    '/api/spans/search?query=a&limit=',
    '/api/spans/search?query=a&limit=9007199254740993',
    '/api/spans/search?query=a&throughSequence=-1',
    '/api/spans/search?query=a&expectedGeneration=x',
    '/api/spans/search?query=a&afterSequence=1',
    '/api/spans/search?query=a&afterSequence=7&throughSequence=9',
    '/api/spans/search?query=a&surprise=1',
    '/api/spans/search?query=a&__proto__=1',
    '/api/spans/search?query=a&phase=all',
    `/api/spans/search?query=${'q'.repeat(513)}`,
    '/api/spans/search?query=a&limit=101',
  ]) {
    // biome-ignore lint/performance/noAwaitInLoops: Each invalid query is paired with its own synchronous dispatch assertion.
    const reply = await get(services, path);
    expect(`${path} ${reply.status}`).toBe(`${path} 400`);
    expect(reply.body).toEqual({
      code: 'SPANS_SERVICE_INVALID',
      error: 'Invalid spans request.',
      ok: false,
    });
  }
  expect(calls.search).toEqual([]);
});

test('the status route rejects any parameter with 400 and does not call the service', async () => {
  const { calls, services } = recordingServices(searchPage);
  for (const path of [
    '/api/spans/search/status?query=a',
    '/api/spans/search/status?x=1',
  ]) {
    // biome-ignore lint/performance/noAwaitInLoops: Each status request is checked against its own supplied query string.
    const reply = await get(services, path);
    expect(reply.status).toBe(400);
    expect(reply.body.code).toBe('SPANS_SERVICE_INVALID');
  }
  expect(calls.status).toEqual([]);
});

test('service failures use fixed messages and map to 409, 400, 503 and 500', async () => {
  for (const [code, status] of [
    ['SPANS_SERVICE_STALE', 409],
    ['SPANS_SERVICE_INVALID', 400],
    ['SPANS_SERVICE_UNAVAILABLE', 503],
    ['SPANS_SERVICE_BUSY', 503],
    ['SPANS_SERVICE_CORRUPT', 500],
    ['SOMETHING_ELSE', 500],
    ['constructor', 500],
    ['__proto__', 500],
  ]) {
    const { services } = recordingServices(failureBody(code));
    // biome-ignore lint/performance/noAwaitInLoops: Keep each response paired with the failure code under test.
    const reply = await get(services, '/api/spans/search?query=alpha');
    expect(`${code} ${reply.status}`).toBe(`${code} ${status}`);
    const normalizedCode = [
      'SPANS_SERVICE_STALE',
      'SPANS_SERVICE_INVALID',
      'SPANS_SERVICE_UNAVAILABLE',
      'SPANS_SERVICE_BUSY',
      'SPANS_SERVICE_CORRUPT',
    ].includes(code)
      ? code
      : 'SPANS_SERVICE_CORRUPT';
    expect(reply.body.code).toBe(normalizedCode);
    expect(reply.body.ok).toBe(false);
    expect(reply.body.error).not.toBe(`fixed ${code}`);
  }
});

test('an unknown service code and message are replaced with a fixed corrupt response', async () => {
  const { services } = recordingServices({
    code: 'PRIVATE_INTERNAL_CODE',
    error: '/private/archive/home secret-token',
    ok: false,
  });
  const reply = await get(services, '/api/spans/search?query=alpha');
  expect(reply).toEqual({
    body: {
      code: 'SPANS_SERVICE_CORRUPT',
      error: 'Spans history failed an integrity check.',
      ok: false,
    },
    status: 500,
  });
});

test('a missing index is a 503 unavailable failure and never an empty successful page', async () => {
  const unavailable = {
    code: 'SPANS_SERVICE_UNAVAILABLE',
    error: 'Spans history is unavailable.',
    ok: false,
  };
  const { services } = recordingServices(unavailable);
  const reply = await get(services, '/api/spans/search?query=alpha');
  expect(reply.status).toBe(503);
  expect(reply.body.ok).toBe(false);
  expect(reply.body.hits).toBeUndefined();
  const status = await get(
    { spansSearchStatus: () => unavailable },
    '/api/spans/search/status'
  );
  expect(status.status).toBe(503);
  expect(status.body).toEqual(unavailable);
});

test('a throwing or malformed service never leaks and never looks like success', async () => {
  const throwing = await get(
    {
      spansSearch: () => {
        throw new Error('/Users/someone/private/path secret-token');
      },
    },
    '/api/spans/search?query=alpha'
  );
  expect(throwing.status).toBe(503);
  expect(throwing.body).toEqual({
    code: 'SPANS_SERVICE_UNAVAILABLE',
    error: 'Spans history is unavailable.',
    ok: false,
  });
  for (const malformed of [null, undefined, 'ok', { hits: [] }]) {
    // biome-ignore lint/performance/noAwaitInLoops: Each malformed service result is dispatched and asserted separately.
    const reply = await get(
      { spansSearch: () => malformed },
      '/api/spans/search?query=alpha'
    );
    expect(reply.status).toBe(500);
    expect(reply.body.code).toBe('SPANS_SERVICE_CORRUPT');
    expect(reply.body.ok).toBe(false);
  }
});

test('registered search routes report missing services as unavailable', async () => {
  const { calls, services } = recordingServices(searchPage);
  for (const method of ['POST', 'PUT', 'DELETE']) {
    expect(
      // biome-ignore lint/performance/noAwaitInLoops: These methods are checked in order against one read-only fixture.
      await get(services, '/api/spans/search?query=alpha', { method })
    ).toBeNull();
  }
  for (const path of [
    '/api/spans/search?query=alpha',
    '/api/spans/search/status',
  ]) {
    // biome-ignore lint/performance/noAwaitInLoops: Search and status each need a distinct missing-service dispatch.
    expect(await get({}, path)).toEqual({
      body: {
        code: 'SPANS_SERVICE_UNAVAILABLE',
        error: 'Spans history is unavailable.',
        ok: false,
      },
      status: 503,
    });
  }
  expect(calls.search).toEqual([]);
});

test('existing Spans routes keep their 200 envelope and conversions', async () => {
  const seen = [];
  const services = {
    spansEvents: (input) => {
      seen.push(input);
      return failureBody('SPANS_SERVICE_NOT_FOUND');
    },
    spansRuns: (input) => {
      seen.push(input);
      return failureBody('SPANS_SERVICE_UNAVAILABLE');
    },
  };
  const runs = await get(services, '/api/spans/runs?limit=3');
  expect(runs.status).toBe(200);
  expect(runs.body.code).toBe('SPANS_SERVICE_UNAVAILABLE');
  const events = await get(
    services,
    '/api/spans/events?runId=run-1&afterSequence=2&limit=4'
  );
  expect(events.status).toBe(200);
  expect(seen).toEqual([
    { limit: 3 },
    { afterSequence: 2, limit: 4, runId: 'run-1' },
  ]);
});

// ── MCP ───────────────────────────────────────────────────────────────────────

async function requestMcp(method, params = {}) {
  const response = await handleMcpRequest(
    new Request('http://localhost:2999/mcp', {
      body: JSON.stringify({ id: 1, jsonrpc: '2.0', method, params }),
      headers: {
        accept: 'application/json, text/event-stream',
        'content-type': 'application/json',
        host: 'localhost:2999',
      },
      method: 'POST',
    })
  );
  const body = await response.text();
  return JSON.parse(
    body.startsWith('event:')
      ? body
          .split('\n')
          .find((line) => line.startsWith('data: '))
          .slice(6)
      : body
  );
}

const callTool = (name, args = {}) =>
  requestMcp('tools/call', { arguments: args, name });

test('MCP exposes the two search tools as read-only with a bounded schema', async () => {
  initMcpServer({});
  const { tools } = (await requestMcp('tools/list')).result;
  const byName = Object.fromEntries(tools.map((tool) => [tool.name, tool]));
  for (const name of ['search_spans', 'get_spans_search_status']) {
    expect(byName[name].annotations.readOnlyHint).toBe(true);
    expect(byName[name].annotations.destructiveHint).toBeUndefined();
  }
  const { properties, required } = byName.search_spans.inputSchema;
  expect(required).toEqual(['query']);
  expect(Object.keys(properties).sort()).toEqual([
    'afterSequence',
    'expectedGeneration',
    'limit',
    'query',
    'runId',
    'throughSequence',
  ]);
  expect(properties.limit.maximum).toBe(100);
  expect(properties.limit.minimum).toBe(1);
  expect(properties.afterSequence.minimum).toBeGreaterThanOrEqual(0);
  expect(properties.query.minLength).toBe(1);
  expect(properties.query.maxLength).toBe(512);
  expect(
    Object.keys(byName.get_spans_search_status.inputSchema.properties ?? {})
  ).toEqual([]);
});

test('MCP search returns the shared page unchanged and does not flag success as an error', async () => {
  const calls = [];
  initMcpServer({
    spansSearch: (input) => {
      calls.push(input);
      return searchPage;
    },
    spansSearchStatus: () => statusPage,
  });
  const search = await callTool('search_spans', {
    expectedGeneration: 3,
    limit: 10,
    query: 'alpha',
    runId: 'run-1',
    throughSequence: 9,
  });
  expect(search.result.isError).toBe(false);
  expect(search.result.structuredContent).toEqual(searchPage);
  expect(calls).toEqual([
    {
      expectedGeneration: 3,
      limit: 10,
      query: 'alpha',
      runId: 'run-1',
      throughSequence: 9,
    },
  ]);
  const status = await callTool('get_spans_search_status');
  expect(status.result.isError).toBe(false);
  expect(status.result.structuredContent).toEqual(statusPage);
});

test('MCP sets the error bit for stale, invalid and unavailable search results', async () => {
  for (const code of [
    'SPANS_SERVICE_STALE',
    'SPANS_SERVICE_INVALID',
    'SPANS_SERVICE_UNAVAILABLE',
  ]) {
    initMcpServer({
      spansSearch: () => failureBody(code),
      spansSearchStatus: () => failureBody(code),
    });
    // biome-ignore lint/performance/noAwaitInLoops: Re-register the MCP adapter before each result is requested.
    const search = await callTool('search_spans', { query: 'alpha' });
    expect(search.result.isError).toBe(true);
    expect(search.result.structuredContent).toEqual(failureBody(code));
    const status = await callTool('get_spans_search_status');
    expect(status.result.isError).toBe(true);
    expect(status.result.structuredContent.code).toBe(code);
  }
});

test('MCP reports unavailable, not empty, when the search service is not wired', async () => {
  initMcpServer({});
  for (const [tool, args] of [
    ['search_spans', { query: 'alpha' }],
    ['get_spans_search_status', {}],
  ]) {
    // biome-ignore lint/performance/noAwaitInLoops: Check each unavailable tool by name in the registered server.
    const reply = await callTool(tool, args);
    expect(reply.result.isError).toBe(true);
    expect(reply.result.structuredContent).toEqual({
      code: 'SPANS_SERVICE_UNAVAILABLE',
      error: 'Spans history is unavailable.',
      ok: false,
    });
  }
});

test('MCP rejects malformed search input before reaching the service', async () => {
  const calls = [];
  initMcpServer({
    spansSearch: (input) => {
      calls.push(input);
      return searchPage;
    },
  });
  for (const args of [
    {},
    { limit: 5 },
    { query: '' },
    { query: 'x'.repeat(513) },
    { limit: 0, query: 'alpha' },
    { limit: 101, query: 'alpha' },
    { limit: 1.5, query: 'alpha' },
    { afterSequence: -1, query: 'alpha' },
    { query: 'alpha', throughSequence: -1 },
    { expectedGeneration: 1.5, query: 'alpha' },
    { query: 'alpha', runId: '' },
    { query: 'alpha', runId: 'r'.repeat(129) },
  ]) {
    // biome-ignore lint/performance/noAwaitInLoops: Check malformed inputs one at a time against the shared call recorder.
    const reply = await callTool('search_spans', args);
    const refused = reply.error !== undefined || reply.result?.isError === true;
    expect(`${JSON.stringify(args)} ${refused}`).toBe(
      `${JSON.stringify(args)} true`
    );
  }
  expect(calls).toEqual([]);
});

// ── CLI, in process ───────────────────────────────────────────────────────────

async function cli(argv, { reply = searchPage, extra = {} } = {}) {
  const originalError = console.error;
  const originalLog = console.log;
  const errors = [];
  const output = [];
  const requests = [];
  console.error = (value) => errors.push(String(value));
  console.log = (value) => output.push(String(value));
  try {
    const status = await runCli(argv, {
      request: (request) => {
        requests.push(request);
        return Promise.resolve(reply);
      },
      ...extra,
    });
    return { errors, output, requests, status };
  } finally {
    console.error = originalError;
    console.log = originalLog;
  }
}

const requestUrl = (request) => new URL(`http://portal.test${request.path}`);

test('spans search sends one GET with every provided filter and prints the page', async () => {
  const run = await cli([
    'spans',
    'search',
    'alpha "beta" & more',
    '--run',
    'run-1',
    '--since',
    '5',
    '--through',
    '9',
    '--generation',
    '3',
    '--limit',
    '10',
    '--json',
  ]);
  expect(run.status).toBe(0);
  expect(run.requests).toHaveLength(1);
  const [request] = run.requests;
  expect(request.method).toBe('GET');
  expect(request.body).toBeUndefined();
  const url = requestUrl(request);
  expect(url.pathname).toBe('/api/spans/search');
  expect(Object.fromEntries(url.searchParams)).toEqual({
    afterSequence: '5',
    expectedGeneration: '3',
    limit: '10',
    query: 'alpha "beta" & more',
    runId: 'run-1',
    throughSequence: '9',
  });
  expect(JSON.parse(run.output.join('\n'))).toEqual(searchPage);
});

test('spans search with only a query sends no other filter, and --since 0 needs no generation', async () => {
  const first = await cli(['spans', 'search', 'alpha']);
  expect(first.status).toBe(0);
  expect(
    Object.fromEntries(requestUrl(first.requests[0]).searchParams)
  ).toEqual({ query: 'alpha' });
  const zero = await cli(['spans', 'search', 'alpha', '--since', '0']);
  expect(zero.status).toBe(0);
  expect(Object.fromEntries(requestUrl(zero.requests[0]).searchParams)).toEqual(
    {
      afterSequence: '0',
      query: 'alpha',
    }
  );
});

test('spans search-status sends one parameterless GET', async () => {
  const run = await cli(['spans', 'search-status', '--json'], {
    reply: statusPage,
  });
  expect(run.status).toBe(0);
  expect(run.requests).toHaveLength(1);
  expect(run.requests[0].method).toBe('GET');
  expect(run.requests[0].path).toBe('/api/spans/search/status');
  expect(JSON.parse(run.output.join('\n'))).toEqual(statusPage);
});

test('invalid search flags and positionals fail before any request', async () => {
  for (const argv of [
    ['spans', 'search'],
    ['spans', 'search', ''],
    ['spans', 'search', '   '],
    ['spans', 'search', 'a', 'b'],
    ['spans', 'search', 'x'.repeat(513)],
    ['spans', 'search', 'a', '--limit', '0'],
    ['spans', 'search', 'a', '--limit', '101'],
    ['spans', 'search', 'a', '--limit', '1.5'],
    ['spans', 'search', 'a', '--limit', 'abc'],
    ['spans', 'search', 'a', '--limit', '1e2'],
    ['spans', 'search', 'a', '--limit', '-5'],
    ['spans', 'search', 'a', '--limit'],
    ['spans', 'search', 'a', '--since', '-1'],
    ['spans', 'search', 'a', '--since', '1.5'],
    ['spans', 'search', 'a', '--since', 'abc'],
    ['spans', 'search', 'a', '--since', '0x10'],
    ['spans', 'search', 'a', '--since', '1e3'],
    ['spans', 'search', 'a', '--since', '007'],
    ['spans', 'search', 'a', '--since', '5'],
    ['spans', 'search', 'a', '--since', '5', '--through', '9'],
    ['spans', 'search', 'a', '--through', '-2'],
    ['spans', 'search', 'a', '--generation', 'x'],
    ['spans', 'search', 'a', '--generation', '-1'],
    ['spans', 'search', 'a', '--run', 'bad id'],
    ['spans', 'search', 'a', '--run', '../x'],
    ['spans', 'search', 'a', '--run'],
    ['spans', 'search', 'a', '--root', '/tmp'],
    ['spans', 'search', 'a', '--phase', 'all'],
    ['spans', 'search', 'a', '--surprise', '1'],
    ['spans', 'search-status', 'extra'],
    ['spans', 'search-status', '--limit', '5'],
    ['spans', 'search-status', '--since', '1'],
    ['spans', 'list', '--run', 'run-1'],
    ['spans', 'list', '--generation', '1'],
    ['spans', 'show', 'run-1', '--through', '1'],
  ]) {
    // biome-ignore lint/performance/noAwaitInLoops: Each command verifies that its own malformed input exits before requesting.
    const run = await cli(argv);
    expect(`${argv.join(' ')} ${run.status}`).toBe(`${argv.join(' ')} 1`);
    expect(`${argv.join(' ')} ${run.requests.length}`).toBe(
      `${argv.join(' ')} 0`
    );
    expect(run.output).toEqual([]);
    expect(run.errors.join('\n')).not.toContain('PORTAL_UNAVAILABLE');
  }
});

test('a stale page exits 1 with the restart message instead of looking successful', async () => {
  const stale = failureBody('SPANS_SERVICE_STALE');
  const plain = await cli(
    ['spans', 'search', 'alpha', '--since', '5', '--generation', '2'],
    { reply: stale }
  );
  expect(plain.status).toBe(1);
  expect(plain.output).toEqual([]);
  expect(JSON.parse(plain.errors.join('\n'))).toEqual(stale);
  const json = await cli(
    ['spans', 'search', 'alpha', '--since', '5', '--generation', '2', '--json'],
    { reply: stale }
  );
  expect(json.status).toBe(1);
  expect(JSON.parse(json.output.join('\n'))).toEqual(stale);
});

test('an unavailable index and a dead portal both fail with exit 1 and no results', async () => {
  const unavailable = failureBody('SPANS_SERVICE_UNAVAILABLE');
  for (const argv of [
    ['spans', 'search', 'alpha', '--json'],
    ['spans', 'search-status', '--json'],
  ]) {
    // biome-ignore lint/performance/noAwaitInLoops: The search and status commands are checked independently with the same fixed failure.
    const run = await cli(argv, { reply: unavailable });
    expect(run.status).toBe(1);
    expect(JSON.parse(run.output.join('\n'))).toEqual(unavailable);
  }
  const originalError = console.error;
  const errors = [];
  console.error = (value) => errors.push(String(value));
  try {
    const status = await runCli(['spans', 'search', 'alpha'], {
      request: () => Promise.reject(new Error('connect refused')),
    });
    expect(status).toBe(1);
    expect(errors.join('\n')).toContain('PORTAL_UNAVAILABLE');
  } finally {
    console.error = originalError;
  }
});

test('spans list, show, events and artifact keep their requests', async () => {
  const seen = [];
  for (const [argv, path, params] of [
    [['spans'], '/api/spans/runs', {}],
    [
      ['spans', 'list', '--limit', '2', '--phase', 'past'],
      '/api/spans/runs',
      { limit: '2', phase: 'past' },
    ],
    [['spans', 'show', 'run-1'], '/api/spans/run', { runId: 'run-1' }],
    [
      ['spans', 'events', 'run-1', '--since', '3', '--limit', '5'],
      '/api/spans/events',
      { afterSequence: '3', limit: '5', runId: 'run-1' },
    ],
    [
      ['spans', 'artifact', 'run-1', 'sha256:abc'],
      '/api/spans/artifact',
      { artifactId: 'sha256:abc', runId: 'run-1' },
    ],
  ]) {
    // biome-ignore lint/performance/noAwaitInLoops: Each legacy command is checked against its corresponding route and parameters.
    const run = await cli(argv, { reply: { ok: true } });
    expect(`${argv.join(' ')} ${run.status}`).toBe(`${argv.join(' ')} 0`);
    const url = requestUrl(run.requests[0]);
    seen.push(url.pathname);
    expect(url.pathname).toBe(path);
    expect(Object.fromEntries(url.searchParams)).toEqual(params);
  }
  expect(seen).toHaveLength(5);
});

// ── CLI: offline index command (fake store module) ────────────────────────────

function archiveRoot() {
  const root = tempRoot('spans-index-cli-');
  writeFileSync(join(root, 'spans.sqlite3'), 'placeholder');
  return root;
}

// Records every call so a test can prove order, bounds and that close ran.
function fakeSpansStoreModule({
  closeResult = { ok: true },
  initialize = { ok: true, version: 1 },
  open,
  pages,
}) {
  const log = [];
  let index = 0;
  return {
    log,
    module: () =>
      Promise.resolve({
        openSpansStore: (options) => {
          log.push(['open', options]);
          if (open) {
            return open(options);
          }
          return {
            close: () => {
              log.push(['close']);
              if (closeResult instanceof Error) {
                throw closeResult;
              }
              return closeResult;
            },
            indexSearchPage: (input) => {
              log.push(['page', input]);
              const next = pages[Math.min(index, pages.length - 1)];
              index += 1;
              if (next instanceof Error) {
                throw next;
              }
              return next;
            },
            initializeSearch: () => {
              log.push(['initialize']);
              return initialize;
            },
          };
        },
        SPANS_STORE_DATABASE_FILE: 'spans.sqlite3',
      }),
  };
}

const coverage = (indexedSequence, latestSequence = 30) => ({
  complete: indexedSequence === latestSequence,
  generation: 1,
  indexedSequence,
  latestSequence,
  stale: indexedSequence !== latestSequence,
});

const indexPage = (indexed, indexedSequence, hasMore) => ({
  coverage: coverage(indexedSequence),
  generation: 1,
  hasMore,
  indexed,
  nextSequence: indexedSequence,
  ok: true,
});

async function indexCli(
  argv,
  store,
  archiveWrite = async (_request, effect) => ({
    ok: true,
    value: await effect(),
  })
) {
  const run = await cli(argv, {
    extra: {
      localCommand: {
        loadSpansStore: store.module,
        spansArchiveWrite: archiveWrite,
      },
    },
  });
  const printed = run.output.length ? run.output : run.errors;
  return { ...run, result: JSON.parse(printed.join('\n')) };
}

test('index runs initialize, bounded pages and close once, then reports full coverage', async () => {
  const root = archiveRoot();
  const store = fakeSpansStoreModule({
    pages: [
      indexPage(10, 10, true),
      indexPage(10, 20, true),
      indexPage(10, 30, false),
    ],
  });
  const run = await indexCli(['spans', 'index', '--root', root], store);
  expect(run.status).toBe(0);
  expect(run.requests).toEqual([]);
  expect(store.log).toEqual([
    ['open', { create: false, root }],
    ['initialize'],
    ['page', { limit: 50 }],
    ['page', { limit: 50 }],
    ['page', { limit: 50 }],
    ['close'],
  ]);
  expect(run.result).toMatchObject({
    complete: true,
    coverage: coverage(30),
    generation: 1,
    indexed: 30,
    nextSequence: 30,
    ok: true,
    pages: 3,
    resumable: false,
  });
});

test('index stops at the page budget and says the work is resumable, not complete', async () => {
  const root = archiveRoot();
  const store = fakeSpansStoreModule({
    pages: [
      indexPage(5, 5, true),
      indexPage(5, 10, true),
      indexPage(5, 15, true),
    ],
  });
  const run = await indexCli(
    ['spans', 'index', '--root', root, '--pages', '2', '--limit', '5'],
    store
  );
  expect(run.status).toBe(0);
  expect(store.log.filter(([name]) => name === 'page')).toEqual([
    ['page', { limit: 5 }],
    ['page', { limit: 5 }],
  ]);
  expect(store.log.at(-1)).toEqual(['close']);
  expect(run.result).toMatchObject({
    complete: false,
    coverage: coverage(10),
    indexed: 10,
    nextSequence: 10,
    ok: true,
    pages: 2,
    resumable: true,
  });
  expect(run.result.note).toContain('rerun');
});

test('index does not call a finished index complete when the store says coverage is not', async () => {
  const root = archiveRoot();
  const store = fakeSpansStoreModule({
    pages: [{ ...indexPage(3, 3, false), coverage: coverage(3, 8) }],
  });
  const run = await indexCli(['spans', 'index', '--root', root], store);
  expect(run.result.complete).toBe(false);
  expect(run.result.resumable).toBe(false);
  expect(run.result.coverage).toEqual(coverage(3, 8));
});

test('index failures report a bounded code with progress and still close', async () => {
  const root = archiveRoot();
  const failedPage = fakeSpansStoreModule({
    pages: [
      indexPage(10, 10, true),
      {
        code: 'SPANS_SEARCH_SOURCE_FAILED',
        error: '/private/path leaked',
        ok: false,
      },
    ],
  });
  const first = await indexCli(['spans', 'index', '--root', root], failedPage);
  expect(first.status).toBe(1);
  expect(first.result).toEqual({
    code: 'SPANS_SEARCH_SOURCE_FAILED',
    error: 'Spans search indexing did not complete.',
    indexed: 10,
    ok: false,
    pages: 1,
  });
  expect(failedPage.log.at(-1)).toEqual(['close']);

  const readOnly = fakeSpansStoreModule({
    initialize: { code: 'SPANS_SEARCH_READONLY', error: 'nope', ok: false },
    pages: [],
  });
  const second = await indexCli(['spans', 'index', '--root', root], readOnly);
  expect(second.status).toBe(1);
  expect(second.result.code).toBe('SPANS_SEARCH_READONLY');
  expect(readOnly.log.filter(([name]) => name === 'page')).toEqual([]);
  expect(readOnly.log.at(-1)).toEqual(['close']);
});

test('index refuses a stalled page, a throwing store and a failed close without leaking', async () => {
  const root = archiveRoot();
  const stalled = fakeSpansStoreModule({ pages: [indexPage(0, 0, true)] });
  const stall = await indexCli(['spans', 'index', '--root', root], stalled);
  expect(stall.status).toBe(1);
  expect(stall.result.code).toBe('SPANS_INDEX_STALLED');
  expect(stalled.log.filter(([name]) => name === 'page')).toHaveLength(1);
  expect(stalled.log.at(-1)).toEqual(['close']);

  const throwing = fakeSpansStoreModule({
    pages: [new Error('/Users/someone/private secret-token')],
  });
  const thrown = await indexCli(['spans', 'index', '--root', root], throwing);
  expect(thrown.status).toBe(1);
  expect(thrown.result.code).toBe('SPANS_INDEX_FAILED');
  expect(JSON.stringify(thrown.result)).not.toContain('secret-token');
  expect(throwing.log.at(-1)).toEqual(['close']);

  for (const closeResult of [
    { code: 'SPANS_STORE_UNAVAILABLE', ok: false },
    new Error('close exploded'),
  ]) {
    const closing = fakeSpansStoreModule({
      closeResult,
      pages: [indexPage(30, 30, false)],
    });
    // biome-ignore lint/performance/noAwaitInLoops: Each close outcome is installed and checked in sequence.
    const closed = await indexCli(['spans', 'index', '--root', root], closing);
    expect(closed.status).toBe(1);
    expect(closed.result.ok).toBe(false);
    expect(closed.result.code).toBe('SPANS_INDEX_CLOSE_FAILED');
    expect(closed.result.indexed).toBe(30);
  }
});

test('index surfaces only the code of a store that cannot open and has nothing to close', async () => {
  const root = archiveRoot();
  const store = fakeSpansStoreModule({
    open: () => {
      throw Object.assign(new Error('/private/path'), {
        code: 'SPANS_STORE_SCHEMA_NEWER',
      });
    },
    pages: [],
  });
  const run = await indexCli(['spans', 'index', '--root', root], store);
  expect(run.status).toBe(1);
  expect(run.result.code).toBe('SPANS_STORE_SCHEMA_NEWER');
  expect(JSON.stringify(run.result)).not.toContain('/private');
  expect(store.log.map(([name]) => name)).toEqual(['open']);
});

test('index never creates an archive: a missing, empty or non-file database is refused unopened', async () => {
  const parent = tempRoot('spans-index-missing-');
  const absent = join(parent, 'absent');
  const empty = join(parent, 'empty');
  const hollow = join(parent, 'hollow');
  mkdirSync(empty);
  mkdirSync(hollow);
  writeFileSync(join(hollow, 'spans.sqlite3'), '');
  mkdirSync(join(parent, 'dir-db'));
  mkdirSync(join(parent, 'dir-db', 'spans.sqlite3'));
  for (const root of [absent, empty, hollow, join(parent, 'dir-db')]) {
    const store = fakeSpansStoreModule({ pages: [] });
    // biome-ignore lint/performance/noAwaitInLoops: Each root is verified unopened before checking the next fixture.
    const run = await indexCli(['spans', 'index', '--root', root], store);
    expect(run.status).toBe(1);
    expect(run.result.code).toBe('SPANS_INDEX_NO_ARCHIVE');
    expect(store.log).toEqual([]);
  }
  expect(existsSync(absent)).toBe(false);
  expect(readdirSync(empty)).toEqual([]);
});

test('index validates every argument before it loads the store module', async () => {
  const root = archiveRoot();
  let loads = 0;
  const loadSpansStore = () => {
    loads += 1;
    return Promise.reject(new Error('must not load'));
  };
  for (const argv of [
    ['spans', 'index'],
    ['spans', 'index', '--root'],
    ['spans', 'index', '--root', 'relative/archive'],
    ['spans', 'index', '--root', '~/archive'],
    ['spans', 'index', '--root', `${root}/../escape`],
    ['spans', 'index', '--root', root, '--limit', '0'],
    ['spans', 'index', '--root', root, '--limit', '201'],
    ['spans', 'index', '--root', root, '--limit', '1.5'],
    ['spans', 'index', '--root', root, '--pages', '0'],
    ['spans', 'index', '--root', root, '--pages', '10001'],
    ['spans', 'index', '--root', root, '--run', 'run-1'],
    ['spans', 'index', '--root', root, '--since', '1'],
    ['spans', 'index', '--root', root, '--surprise', '1'],
    ['spans', 'index', 'extra', '--root', root],
  ]) {
    // biome-ignore lint/performance/noAwaitInLoops: Each invalid command must be rejected before the loader runs.
    const run = await cli(argv, {
      extra: { localCommand: { loadSpansStore } },
    });
    expect(`${argv.join(' ')} ${run.status}`).toBe(`${argv.join(' ')} 1`);
    expect(run.requests).toEqual([]);
  }
  expect(loads).toBe(0);
  const search = await cli(['spans', 'search', 'alpha'], {
    extra: { localCommand: { loadSpansStore } },
  });
  expect(search.status).toBe(0);
  expect(loads).toBe(0);
});

test('index reports a bounded code when the store module cannot load', async () => {
  const root = archiveRoot();
  const run = await cli(['spans', 'index', '--root', root], {
    extra: {
      localCommand: {
        loadSpansStore: () => Promise.reject(new Error('/private/path boom')),
      },
    },
  });
  expect(run.status).toBe(1);
  expect(run.requests).toEqual([]);
  expect(run.errors.join('\n')).toContain('SPANS_INDEX_FAILED');
  expect(run.errors.join('\n')).not.toContain('/private');
});

// ── CLI, real subprocess, fixtures only ───────────────────────────────────────

function cliHome() {
  const home = tempRoot('spans-search-cli-home-');
  // A recent check time keeps the optional update nudge from starting a fetch.
  writeFileSync(
    join(home, '.setu.json'),
    JSON.stringify({
      lastUpdateCheck: Date.now(),
      workspace: tempRoot('spans-index-workspace-'),
    })
  );
  return home;
}

function runCliProcess(home, argv) {
  return spawnSync(process.execPath, [CLI_PATH, ...argv], {
    encoding: 'utf8',
    env: {
      ...process.env,
      // Isolate Setu writes from Bun's platform transpiler cache in fixture HOME.
      BUN_RUNTIME_TRANSPILER_CACHE_PATH: '0',
      HOME: home,
      PATH: `${dirname(process.execPath)}:/usr/bin:/bin`,
    },
    timeout: 30_000,
  });
}

test('subprocess: invalid search and index input exits 1 before any portal or archive access', () => {
  const home = cliHome();
  const parent = tempRoot('spans-search-cli-parent-');
  const absent = join(parent, 'absent');
  const before = readFileSync(join(home, '.setu.json'), 'utf8');
  for (const argv of [
    ['spans', 'search'],
    ['spans', 'search', 'a', '--limit', '201'],
    ['spans', 'search', 'a', '--since', '5'],
    ['spans', 'search', 'a', '--since', '-1'],
    ['spans', 'search', 'a', '--run', '../x'],
    ['spans', 'search-status', 'extra'],
    ['spans', 'index'],
    ['spans', 'index', '--root', 'relative'],
    ['spans', 'index', '--root', absent, '--limit', '0'],
  ]) {
    const run = runCliProcess(home, argv);
    expect(`${argv.join(' ')}: ${run.status}`).toBe(`${argv.join(' ')}: 1`);
    expect(run.stderr).toContain('error:');
    expect(run.stderr).not.toContain('PORTAL_UNAVAILABLE');
    expect(run.stdout).toBe('');
  }
  // An absent archive is reported, never created, and nothing else is touched.
  const listing = readdirSync(home).sort();
  const missing = runCliProcess(home, ['spans', 'index', '--root', absent]);
  expect(missing.status).toBe(1);
  expect(JSON.parse(missing.stderr).code).toBe('SPANS_INDEX_NO_ARCHIVE');
  expect(existsSync(absent)).toBe(false);
  expect(readFileSync(join(home, '.setu.json'), 'utf8')).toBe(before);
  expect(readdirSync(home).sort()).toEqual(listing);
});

test('subprocess: index builds the derived search on an explicit fixture archive and is resumable', () => {
  const home = cliHome();
  const root = join(tempRoot('spans-search-cli-archive-'), 'archive');
  mkdirSync(root, { mode: 0o700 });
  const writer = openSpansStore({ root });
  try {
    expect(
      createSpansDrafts({ store: writer }).createRun({
        goal: 'zebrafixture search target',
        owner: 'fixture',
        runId: 'run-1',
        spans: [],
      }).ok
    ).toBe(true);
  } finally {
    writer.close();
  }
  const beforeIndex = openSpansStore({ readonly: true, root });
  try {
    // No index exists yet: that is unavailable, not an empty result.
    expect(beforeIndex.searchStatus().ok).toBe(false);
    expect(beforeIndex.search({ query: 'zebrafixture' }).ok).toBe(false);
  } finally {
    beforeIndex.close();
  }

  const listing = readdirSync(home).sort();
  const first = runCliProcess(home, [
    'spans',
    'index',
    '--root',
    root,
    '--json',
  ]);
  expect(first.status).toBe(0);
  const built = JSON.parse(first.stdout);
  expect(built.ok).toBe(true);
  expect(built.complete).toBe(true);
  expect(built.resumable).toBe(false);
  expect(built.coverage.complete).toBe(true);
  expect(built.indexed).toBeGreaterThan(0);

  const again = JSON.parse(
    runCliProcess(home, ['spans', 'index', '--root', root, '--json']).stdout
  );
  expect(again.ok).toBe(true);
  expect(again.complete).toBe(true);
  expect(again.indexed).toBe(0);

  const reader = openSpansStore({ readonly: true, root });
  try {
    const status = reader.searchStatus();
    expect(status.ok).toBe(true);
    expect(status.coverage.complete).toBe(true);
    const found = reader.search({ limit: 10, query: 'zebrafixture' });
    expect(found.ok).toBe(true);
    expect(found.hits.length).toBeGreaterThan(0);
    for (const hit of found.hits) {
      expect(hit.historical).toBe(true);
    }
  } finally {
    reader.close();
  }
  expect(readdirSync(home).sort()).toEqual(listing);
}, 60_000);

test('index admission refusal never opens the archive or advances a page', async () => {
  const root = archiveRoot();
  const store = fakeSpansStoreModule({ pages: [indexPage(1, 1, false)] });
  const run = await indexCli(
    ['spans', 'index', '--root', root],
    store,
    async () => ({ code: 'SPANS_ARCHIVE_CAPACITY_REACHED', ok: false })
  );
  expect(run.status).toBe(1);
  expect(run.result.code).toBe('SPANS_ARCHIVE_CAPACITY_REACHED');
  expect(store.log).toEqual([]);
});

test('index checks capacity again before each page and preserves completed progress', async () => {
  const root = archiveRoot();
  const store = fakeSpansStoreModule({ pages: [indexPage(1, 1, true)] });
  let calls = 0;
  const run = await indexCli(
    ['spans', 'index', '--root', root],
    store,
    async (request, effect) => {
      expect(request.root).toBe(root);
      expect(request.maxBytes).toBeGreaterThan(0);
      calls += 1;
      return calls === 3
        ? { code: 'SPANS_ARCHIVE_CAPACITY_REACHED', ok: false }
        : { ok: true, value: await effect() };
    }
  );
  expect(run.status).toBe(1);
  expect(run.result).toMatchObject({
    code: 'SPANS_ARCHIVE_CAPACITY_REACHED',
    indexed: 1,
    pages: 1,
  });
  expect(store.log.filter(([name]) => name === 'page')).toHaveLength(1);
  expect(store.log.at(-1)).toEqual(['close']);
});

test('subprocess: index honors another process archive reservation without opening SQLite', async () => {
  const home = cliHome();
  const configPath = join(home, '.setu.json');
  const { workspace } = JSON.parse(readFileSync(configPath, 'utf8'));
  const root = archiveRoot();
  const state = createWorkspaceState({
    configPath,
    setuDir: join(home, '.setu'),
    workspaceRoot: workspace,
  });
  const admission = createResourceAdmission({
    hostHealth: async () => ({
      availableBytes: 30 * 1024 ** 3,
      state: 'ready',
    }),
    state,
  });
  const target = { name: 'fixture', repo: 'fixture' };
  const reserved = await admission.admit({
    kind: 'headless-run',
    operationId: 'index-reservation',
    spansArchiveReservation: {
      budgetBytes: 5 * 1024 ** 3,
      reservedBytes: 5 * 1024 ** 3 - 1024 * 1024,
      root,
    },
    spansBinding: {
      actionId: 'action',
      attemptId: 'attempt',
      generation: 0,
      runId: 'run',
      spanId: 'span',
      target,
    },
    target,
  });
  expect(reserved.ok).toBe(true);
  const before = readFileSync(join(root, 'spans.sqlite3'));
  const run = runCliProcess(home, ['spans', 'index', '--root', root, '--json']);
  expect(run.status).toBe(1);
  expect(JSON.parse(run.stdout || run.stderr).code).toBe(
    'SPANS_ARCHIVE_CAPACITY_REACHED'
  );
  expect(readFileSync(join(root, 'spans.sqlite3'))).toEqual(before);
  expect(readdirSync(root)).toEqual(['spans.sqlite3']);
  expect((await admission.status()).leases).toHaveLength(1);
});
