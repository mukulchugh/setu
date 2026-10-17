import { afterEach, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  commandHandlers,
  mcpInstallCodex,
  mcpInstallCursor,
  parseArgs,
  runCli,
} from './cli.js';
import { createCliApi } from './cli-api.js';
import { createWorkspaceState } from './workspace-state.js';

const initialExitCode = process.exitCode ?? 0;
const roots = [];
afterEach(() => {
  process.exitCode = initialExitCode;
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { force: true, recursive: true });
  }
});

test('every command advertised by help has a dispatch handler', () => {
  for (const command of [
    'setup',
    'doctor',
    'init',
    'sweep',
    'new',
    'rm',
    'cd',
    'ls',
    'status',
    'start',
    'stop',
    'prune',
    'fetch',
    'tunnel',
    'sync',
    'trigger',
    'portal',
    'claim',
    'release',
    'claims',
    'claim-check',
    'mcp',
    'update',
    'version',
    'help',
    'logs',
    'diff',
    'ports',
    'pr',
    'storage',
    'operations',
    'sessions',
    'caches',
    'admission',
    'setup-progress',
    'attention',
    'headless',
    'dependencies',
    'shared-caches',
    'workflows',
    'actions',
    'adopt',
    'review',
  ]) {
    expect(
      command === 'claim' ||
        command === 'release' ||
        command === 'claims' ||
        command === 'claim-check' ||
        commandHandlers[command]
    ).toBeTruthy();
  }
});

test('unknown commands report stderr and exit one without importing dispatch side effects', async () => {
  const original = console.error;
  const errors = [];
  console.error = (text) => errors.push(String(text));
  try {
    expect(await runCli(['not-a-command'])).toBe(1);
  } finally {
    console.error = original;
  }
  expect(process.exitCode).toBe(1);
  expect(errors.join('\n')).toContain("Unknown command 'not-a-command'");
});

test('new, start, rm, and mcp install flags parse as documented', () => {
  expect(
    parseArgs([
      'repo',
      'branch',
      '--tunnel',
      '--start',
      '--container',
      '--json',
    ])
  ).toEqual({
    args: ['repo', 'branch'],
    flags: { container: true, json: true, start: true, tunnel: true },
  });
  expect(parseArgs(['repo', 'branch', '--bare'])).toEqual({
    args: ['repo', 'branch'],
    flags: { bare: true },
  });
  expect(
    parseArgs([
      'repo',
      'branch',
      '--force',
      '--operation-id',
      'remove-1',
      '--json',
    ])
  ).toEqual({
    args: ['repo', 'branch'],
    flags: { force: true, json: true, 'operation-id': 'remove-1' },
  });
  expect(parseArgs(['install', '--all'])).toEqual({
    args: ['install'],
    flags: { all: true },
  });
});

test('lifecycle command overrides isolate start, stop, and removal then restore defaults', async () => {
  const calls = [];
  const originalFetch = globalThis.fetch;
  const originalLog = console.log;
  globalThis.fetch = (url) => {
    calls.push(['fetch', String(url)]);
    return Promise.resolve(Response.json({ ok: true }));
  };
  console.log = () => undefined;
  const lifecycleCommand = {
    cfg: () => {
      calls.push(['cfg']);
      return { workspace: '/isolated' };
    },
    ensurePortal: (config) => {
      calls.push(['ensurePortal', config]);
      return Promise.resolve();
    },
    getPort: (...input) => {
      calls.push(['getPort', ...input]);
      return 43_210;
    },
    portalPid: () => {
      calls.push(['portalPid']);
      return 123;
    },
    requestRemoval: (body, options) => {
      calls.push(['requestRemoval', body, options]);
      return Promise.resolve({ ok: true });
    },
  };
  const request = ({ body, path }) => {
    calls.push(['request', path, body]);
    return Promise.resolve({ container: false, ok: true });
  };

  try {
    expect(
      await runCli(['start', 'repo', 'topic', '--bare'], {
        lifecycleCommand,
        request,
      })
    ).toBe(0);
    expect(
      await runCli(['stop', 'repo', 'topic'], { lifecycleCommand, request })
    ).toBe(0);
    expect(
      await runCli(['rm', 'repo', 'topic', '--force', '--json'], {
        lifecycleCommand,
      })
    ).toBe(0);
    expect(await runCli(['rm', 'repo', 'topic', '--json'])).toBe(0);
    await runCli(['help']);
  } finally {
    console.log = originalLog;
    globalThis.fetch = originalFetch;
  }

  expect(calls).toEqual([
    ['cfg'],
    ['getPort', '/isolated', 'repo', 'topic'],
    ['ensurePortal', { workspace: '/isolated' }],
    [
      'request',
      '/api/start',
      { container: false, name: 'topic', repo: 'repo' },
    ],
    ['portalPid'],
    ['request', '/api/stop', { name: 'topic', repo: 'repo' }],
    [
      'requestRemoval',
      { force: true, name: 'topic', repo: 'repo' },
      { url: 'http://127.0.0.1:2999/api/remove' },
    ],
    ['fetch', 'http://127.0.0.1:2999/api/remove'],
  ]);
});

test('cmdNew refuses admission and preserves unknown setup outcomes without portal effects', async () => {
  const root = fs.mkdtempSync(join(tmpdir(), 'setu-cli-new-'));
  roots.push(root);
  const state = createWorkspaceState({
    configPath: join(root, 'config.json'),
    setuDir: root,
    workspaceRoot: root,
  });
  const output = [],
    errors = [];
  const originalLog = console.log,
    originalError = console.error;
  console.log = (value) => output.push(value);
  console.error = (value) => errors.push(value);
  try {
    let portalChecks = 0,
      starts = 0;
    const refusal = {
      code: 'ADMISSION_REFUSED',
      error: 'No install capacity is available.',
      ok: false,
      position: 2,
      recovery: { retryAfterMs: 5000 },
    };
    expect(
      await runCli(['new', 'repo', 'topic', '--start', '--json'], {
        newCommand: {
          config: () => ({ workspace: root }),
          createResourceAdmission: () => ({ admit: async () => refusal }),
          createWorktree: () =>
            Promise.reject(
              new Error('must not create after admission refusal')
            ),
          ensurePortal: () => {
            portalChecks += 1;
            return Promise.resolve();
          },
          operationId: () => 'setup-refusal',
          workspaceState: () => state,
        },
        request: () => {
          starts += 1;
          return Promise.resolve({ ok: true });
        },
      })
    ).toBe(1);
    expect(portalChecks).toBe(0);
    expect(starts).toBe(0);
    expect(JSON.parse(output[0])).toEqual({
      ...refusal,
      operationId: 'setup-refusal',
    });
    expect(state.read('operationEvents').events).toEqual([
      expect.objectContaining({
        code: 'ADMISSION_REFUSED',
        id: 'setup-refusal',
        source: 'cli',
        state: 'failed',
        target: { name: 'topic', repo: 'repo' },
      }),
    ]);

    output.length = 0;
    expect(
      await runCli(['new', 'repo', 'unknown', '--start', '--json'], {
        newCommand: {
          config: () => ({ workspace: root }),
          createAndInstallWorktree: () =>
            Promise.reject(
              Object.assign(
                new Error('Setup completion could not be confirmed.'),
                {
                  code: 'OPERATION_UNKNOWN',
                  recovery: {
                    progress: { code: 'SETUP_PROGRESS_UNAVAILABLE' },
                  },
                }
              )
            ),
          createOperationEvents: () => ({
            record: async () => ({
              code: 'OPERATION_EVENT_UNAVAILABLE',
              ok: false,
            }),
          }),
          ensurePortal: () => {
            portalChecks += 1;
            return Promise.resolve();
          },
          operationId: () => 'setup-unknown',
          workspaceState: () => state,
        },
        request: () => {
          starts += 1;
          return Promise.resolve({ ok: true });
        },
      })
    ).toBe(1);
    expect(portalChecks).toBe(0);
    expect(starts).toBe(0);
    expect(JSON.parse(output[0])).toMatchObject({
      code: 'OPERATION_UNKNOWN',
      ok: false,
      operationId: 'setup-unknown',
      outcomeRecorded: false,
      recovery: { progress: { code: 'SETUP_PROGRESS_UNAVAILABLE' } },
    });

    output.length = 0;
    expect(
      await runCli(['new', 'repo', 'completed', '--json'], {
        newCommand: {
          config: () => ({ workspace: root }),
          createAndInstallWorktree: async () => ({
            localDom: 'completed.setu.local',
            port: 3101,
            wtDir: join(root, 'repo', 'completed'),
          }),
          operationId: () => 'setup-completed',
          workspaceState: () => state,
        },
      })
    ).toBe(0);
    expect(JSON.parse(output[0])).toMatchObject({
      operationId: 'setup-completed',
      started: false,
      wtDir: join(root, 'repo', 'completed'),
    });
    expect(state.read('operationEvents').events).toContainEqual(
      expect.objectContaining({
        id: 'setup-completed',
        source: 'cli',
        state: 'completed',
        target: { name: 'completed', repo: 'repo' },
      })
    );
  } finally {
    console.error = originalError;
    console.log = originalLog;
  }
});

test('local workspace mutations record outcomes without making read-only sweep write', async () => {
  const root = fs.mkdtempSync(join(tmpdir(), 'setu-cli-local-'));
  roots.push(root);
  const state = createWorkspaceState({
    configPath: join(root, 'config.json'),
    setuDir: root,
    workspaceRoot: root,
  });
  const originalLog = console.log,
    originalError = console.error;
  console.log = () => {
    /* Output is deliberately suppressed for this fixture. */
  };
  console.error = () => {
    /* Output is deliberately suppressed for this fixture. */
  };
  let nextId = 0;
  const local = (overrides = {}) => ({
    config: () => ({ workspace: root }),
    operationId: (kind) => {
      const id = `${kind}-${nextId}`;
      nextId += 1;
      return id;
    },
    workspaceState: () => state,
    ...overrides,
  });
  try {
    expect(
      await runCli(['sweep'], {
        localCommand: local({ discoverRepos: () => [] }),
        request: async () => ({ ok: true }),
      })
    ).toBe(0);
    expect(fs.existsSync(join(root, '.setu-operation-events.json'))).toBe(
      false
    );

    expect(
      await runCli(['init', 'org/refused'], {
        localCommand: local({
          importRepo: () =>
            Promise.reject(
              Object.assign(new Error('Storage is too low.'), {
                code: 'STORAGE_LOW',
              })
            ),
        }),
        request: async () => ({ ok: true }),
      })
    ).toBe(1);

    expect(
      await runCli(['init', 'org/initialized'], {
        localCommand: local({
          importRepo: async () => ({
            wtDir: join(root, 'initialized', 'main'),
          }),
        }),
        newCommand: {
          config: () => ({ workspace: root }),
          createAndInstallWorktree: async () => ({
            localDom: 'initialized.setu.local',
            port: 3102,
            wtDir: join(root, 'initialized', 'main'),
          }),
          operationId: () => 'setup-initialized',
          workspaceState: () => state,
        },
        request: async () => ({ ok: true }),
      })
    ).toBe(0);

    expect(
      await runCli(['sweep', '--import', 'swept'], {
        localCommand: local({
          discoverRepos: () => [
            {
              name: 'swept',
              remoteUrl: 'git@example.test:swept.git',
              status: 'importable',
            },
          ],
          importRepo: async () => ({ wtDir: join(root, 'swept', 'main') }),
        }),
        request: async () => ({ ok: true }),
      })
    ).toBe(0);

    expect(
      await runCli(['sweep', '--import', 'uncertain'], {
        localCommand: local({
          discoverRepos: () => [
            {
              name: 'uncertain',
              remoteUrl: 'git@example.test:uncertain.git',
              status: 'importable',
            },
          ],
          importRepo: () =>
            Promise.reject(new Error('Clone state could not be confirmed.')),
        }),
        request: async () => ({ ok: true }),
      })
    ).toBe(1);

    const fetches = [];
    expect(
      await runCli(['fetch', 'repo'], {
        localCommand: local({
          execFileSync: (...input) => {
            fetches.push(input);
          },
        }),
        request: async () => ({ ok: true }),
      })
    ).toBe(0);
    expect(fetches[0]).toEqual([
      'git',
      ['-C', join(root, 'repo.git'), 'fetch', '--all', '--prune'],
      { stdio: 'inherit' },
    ]);

    let kills = 0;
    expect(
      await runCli(['prune', '--force'], {
        localCommand: local({
          execFileSync: () => {
            kills += 1;
            if (kills === 2) {
              throw new Error('process vanished');
            }
          },
          listActivePorts: () => [],
          portEntries: () => [],
          pruneCandidates: () => [
            { cmd: 'dev one', pid: 101, port: 3101 },
            { cmd: 'dev two', pid: 102, port: 3102 },
          ],
        }),
        request: async () => ({ ok: true }),
      })
    ).toBe(1);

    expect(
      await runCli(['fetch', 'recording-failed'], {
        localCommand: local({
          createOperationEvents: () => ({
            record: async () => ({
              code: 'OPERATION_EVENT_UNAVAILABLE',
              ok: false,
            }),
          }),
          execFileSync: () => {
            /* The operation outcome recorder is the subject of this fixture. */
          },
        }),
        request: async () => ({ ok: true }),
      })
    ).toBe(0);

    expect(state.read('operationEvents').events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'IMPORT_FAILED',
          kind: 'import',
          source: 'cli',
          state: 'failed',
          target: { name: 'main', repo: 'refused' },
        }),
        expect.objectContaining({
          kind: 'import',
          source: 'cli',
          state: 'completed',
          target: { name: 'main', repo: 'initialized' },
        }),
        expect.objectContaining({
          kind: 'import',
          source: 'cli',
          state: 'completed',
          target: { name: 'main', repo: 'swept' },
        }),
        expect.objectContaining({
          code: 'IMPORT_UNKNOWN',
          kind: 'import',
          source: 'cli',
          state: 'unknown',
          target: { name: 'main', repo: 'uncertain' },
        }),
        expect.objectContaining({
          kind: 'fetch',
          source: 'cli',
          state: 'completed',
          target: null,
        }),
        expect.objectContaining({
          code: 'PRUNE_PARTIAL',
          kind: 'prune',
          source: 'cli',
          state: 'failed',
          target: null,
        }),
      ])
    );
  } finally {
    console.error = originalError;
    console.log = originalLog;
  }
});

test('CLI API requests retain the route, target, method, and CLI attribution', async () => {
  const calls = [];
  const api = createCliApi({
    request: (request) => {
      calls.push(request);
      return Promise.resolve({ ok: true });
    },
  });
  await api.get('/api/operations', { limit: 10, name: 'topic', repo: 'repo' });
  await api.post('/api/worktree-cache/execute', {
    confirmation: 'review-token',
    manifestId: 'manifest-1',
    name: 'topic',
    repo: 'repo',
  });
  expect(calls).toEqual([
    {
      body: undefined,
      headers: { 'x-setu-source': 'cli' },
      method: 'GET',
      path: '/api/operations?limit=10&name=topic&repo=repo',
    },
    {
      body: {
        confirmation: 'review-token',
        manifestId: 'manifest-1',
        name: 'topic',
        repo: 'repo',
      },
      headers: { 'content-type': 'application/json', 'x-setu-source': 'cli' },
      method: 'POST',
      path: '/api/worktree-cache/execute',
    },
  ]);
});

test('new capability commands dispatch to their reviewed portal route and preserve confirmation identities', async () => {
  const root = fs.mkdtempSync(join(tmpdir(), 'setu-cli-routes-'));
  roots.push(root);
  const prompt = join(root, 'prompt.txt');
  const input = join(root, 'input.json');
  const identity = join(root, 'identity.json');
  const artifact = join(root, 'artifact.json');
  const findings = join(root, 'findings.json');
  const checkoutIdentity = {
    admin: { birthtimeNs: '3', dev: '1', ino: '4' },
    checkout: { birthtimeNs: '1', dev: '1', ino: '2' },
    checkoutPath: '/workspace/repo/topic',
    known: true,
    repository: { birthtimeNs: '5', dev: '1', ino: '6' },
    repositoryPath: '/workspace/repo.git',
  };
  fs.writeFileSync(prompt, 'review this');
  fs.writeFileSync(input, JSON.stringify({ value: 'reviewed' }));
  fs.writeFileSync(identity, JSON.stringify(checkoutIdentity));
  fs.writeFileSync(
    artifact,
    JSON.stringify({
      checkoutIdentity,
      headSha: 'abcdef123456',
      prNumber: 42,
      stale: false,
    })
  );
  fs.writeFileSync(
    findings,
    JSON.stringify([
      { context: 'current state', id: 'finding-1', outcome: 'fix it' },
    ])
  );
  const calls = [],
    original = console.log;
  console.log = () => {
    /* Output is deliberately suppressed for this fixture. */
  };
  try {
    const request = (call) => {
      calls.push(call);
      return Promise.resolve({ ok: true });
    };
    for (const argv of [
      ['storage'],
      ['storage', 'inspect', 'repo', 'topic'],
      ['operations', 'repo', 'topic', '--limit', '5'],
      ['sessions', 'list', 'repo', 'topic'],
      [
        'sessions',
        'end',
        'repo',
        'topic',
        '--session',
        's1',
        '--checkout',
        identity,
      ],
      ['caches', 'prepare', 'repo', 'topic'],
      [
        'caches',
        'execute',
        'repo',
        'topic',
        '--manifest',
        'm1',
        '--confirmation',
        'confirm-1',
      ],
      ['admission'],
      ['setup-progress', 'list', 'repo', 'topic'],
      [
        'setup-progress',
        'retry',
        'repo',
        'topic',
        '--checkout',
        identity,
        '--attempt',
        'a1',
      ],
      ['attention', 'list', 'repo', 'topic'],
      [
        'attention',
        'focus',
        'repo',
        'topic',
        '--session',
        's1',
        '--checkout',
        identity,
      ],
      ['headless', 'list', 'repo', 'topic'],
      [
        'headless',
        'start',
        'repo',
        'topic',
        '--prompt-file',
        prompt,
        '--budget',
        '2',
        '--wall-clock-ms',
        '60000',
        '--output-bytes',
        '1024',
      ],
      [
        'headless',
        'cancel',
        'repo',
        'topic',
        '--run',
        'r1',
        '--checkout',
        identity,
      ],
      [
        'headless',
        'resume',
        'repo',
        'topic',
        '--run',
        'r1',
        '--prompt-file',
        prompt,
      ],
      ['dependencies'],
      ['dependencies', 'verify', 'repo', 'topic'],
      ['dependencies', 'repair', 'repo', 'topic'],
      ['shared-caches'],
      ['workflows', 'list', 'repo', 'topic'],
      ['workflows', 'runs', 'repo', 'topic'],
      [
        'workflows',
        'dispatch',
        'repo',
        'topic',
        '--workflow',
        'wf',
        '--ref',
        'main',
        '--inputs',
        input,
        '--confirmation',
        'confirm-2',
      ],
      ['actions', 'list'],
      ['actions', 'save', '--input', input],
      ['actions', 'preflight', '--action', 'action-1', '--input', input],
      [
        'actions',
        'invoke',
        '--action',
        'action-1',
        '--input',
        input,
        '--confirmation',
        'confirm-3',
      ],
      ['adopt', 'repo', 'topic', '--path', '/linked/topic'],
      [
        'review',
        'handoff',
        'repo',
        'topic',
        '--session',
        's1',
        '--checkout',
        identity,
        '--artifact',
        artifact,
        '--findings',
        findings,
      ],
    ]) {
      // biome-ignore lint/performance/noAwaitInLoops: Commands share module-level CLI state and the test asserts their recorded request order.
      expect(await runCli(argv, { request })).toBe(0);
    }
  } finally {
    console.log = original;
  }
  expect(calls.map(({ method, path }) => `${method} ${path}`)).toEqual([
    'GET /api/workspace-storage',
    'POST /api/workspace-storage/inspect',
    'GET /api/operations?limit=5&name=topic&repo=repo',
    'GET /api/agent-sessions?name=topic&repo=repo',
    'POST /api/agent-sessions/end',
    'POST /api/worktree-cache/prepare',
    'POST /api/worktree-cache/execute',
    'GET /api/resource-admission',
    'GET /api/setup-progress?name=topic&repo=repo',
    'POST /api/setup-progress/retry',
    'GET /api/attention?name=topic&repo=repo',
    'POST /api/attention/focus',
    'GET /api/headless-runs?name=topic&repo=repo',
    'POST /api/headless-runs/start',
    'POST /api/headless-runs/cancel',
    'POST /api/headless-runs/resume',
    'GET /api/dependency-sharing',
    'POST /api/dependency-sharing/verify',
    'POST /api/dependency-sharing/repair',
    'GET /api/shared-caches',
    'GET /api/github/workflows?name=topic&repo=repo',
    'GET /api/github/runs?name=topic&repo=repo',
    'POST /api/github/dispatch',
    'GET /api/mcp-actions',
    'POST /api/mcp-actions/save',
    'POST /api/mcp-actions/preflight',
    'POST /api/mcp-actions/invoke',
    'POST /api/worktrees/adopt',
    'POST /api/pr-review/handoff',
  ]);
  expect(
    calls.find((call) => call.path === '/api/worktree-cache/execute').body
  ).toMatchObject({ confirmation: 'confirm-1', manifestId: 'm1' });
  expect(
    calls.find((call) => call.path === '/api/headless-runs/cancel').body
  ).toMatchObject({ checkoutIdentity, runId: 'r1' });
  expect(
    calls.find((call) => call.path === '/api/headless-runs/start').body
  ).toMatchObject({ maxBudgetUsd: 2, outputBytes: 1024, wallClockMs: 60_000 });
  expect(
    calls.find((call) => call.path === '/api/pr-review/handoff').body
  ).toMatchObject({
    artifact: { headSha: 'abcdef123456', prNumber: 42 },
    checkoutIdentity,
    findings: [{ id: 'finding-1' }],
  });
  expect(
    calls.find((call) => call.path === '/api/mcp-actions/invoke').body
  ).toMatchObject({ confirmation: 'confirm-3', input: { value: 'reviewed' } });
});

test('cache partial retry, headless stdin limits, and a later success reset the imported exit code', async () => {
  const root = fs.mkdtempSync(join(tmpdir(), 'setu-cli-review-'));
  roots.push(root);
  const identity = join(root, 'identity.json');
  const retry = join(root, 'retry.json');
  fs.writeFileSync(
    identity,
    JSON.stringify({
      checkout: { dev: '1', ino: '2' },
      checkoutPath: '/workspace/repo/topic',
      known: true,
    })
  );
  fs.writeFileSync(
    retry,
    JSON.stringify({ manifestId: 'manifest-1', retryId: 'retry-1' })
  );
  const original = console.error;
  console.error = () => {
    /* Output is deliberately suppressed for this fixture. */
  };
  try {
    expect(
      await runCli(
        [
          'caches',
          'execute',
          'repo',
          'topic',
          '--manifest',
          'manifest-1',
          '--confirmation',
          'initial',
        ],
        {
          request: async () => ({
            ok: false,
            removedPaths: ['.next/cache/a'],
            retryId: 'retry-1',
          }),
        }
      )
    ).toBe(1);
    const calls = [];
    expect(
      await runCli(['caches', 'execute', 'repo', 'topic', '--retry', retry], {
        request: (call) => {
          calls.push(call);
          return Promise.resolve({
            ok: true,
            removedPaths: ['.next/cache/a'],
            retryId: 'retry-1',
          });
        },
      })
    ).toBe(0);
    expect(calls[0].body).toMatchObject({
      confirmation: { manifestId: 'manifest-1', retryId: 'retry-1' },
      manifestId: 'manifest-1',
    });
    let stdin;
    expect(
      await runCli(
        [
          'headless',
          'resume',
          'repo',
          'topic',
          '--run',
          'r1',
          '--prompt-file',
          '-',
          '--budget',
          '1',
          '--wall-clock-ms',
          '1000',
          '--output-bytes',
          '512',
        ],
        {
          readFile: (path) =>
            path === 0 ? 'stdin prompt' : fs.readFileSync(path, 'utf8'),
          request: (call) => {
            stdin = call.body;
            return Promise.resolve({ ok: true });
          },
        }
      )
    ).toBe(0);
    expect(stdin).toMatchObject({
      maxBudgetUsd: 1,
      outputBytes: 512,
      prompt: 'stdin prompt',
      wallClockMs: 1000,
    });
  } finally {
    console.error = original;
  }
});

test('invalid new-command flags refuse before a portal request', async () => {
  const original = console.error;
  console.error = () => {
    /* Output is deliberately suppressed for this fixture. */
  };
  try {
    let calls = 0;
    expect(
      await runCli(
        [
          'headless',
          'start',
          'repo',
          'topic',
          '--prompt-file',
          'missing',
          '--output-bytes',
          '1.5',
        ],
        {
          request: () => {
            calls += 1;
            return Promise.resolve({ ok: true });
          },
        }
      )
    ).toBe(1);
    expect(calls).toBe(0);
  } finally {
    console.error = original;
  }
});

test('unsupported subcommands and extra positionals refuse before a portal request', async () => {
  const original = console.error;
  console.error = () => {
    /* Output is deliberately suppressed for this fixture. */
  };
  try {
    let calls = 0;
    const request = () => {
      calls += 1;
      return Promise.resolve({ ok: true });
    };
    expect(await runCli(['actions', 'unknown'], { request })).toBe(1);
    expect(
      await runCli(['storage', 'inspect', 'repo', 'topic', 'extra'], {
        request,
      })
    ).toBe(1);
    expect(
      await runCli(
        [
          'headless',
          'start',
          'repo',
          'topic',
          '--prompt-file',
          '-',
          '--run',
          'unexpected',
        ],
        {
          readFile: () => 'prompt',
          request,
        }
      )
    ).toBe(1);
    expect(calls).toBe(0);
  } finally {
    console.error = original;
  }
});

test('known portal refusals and unknown outcomes fail without turning a review token into an invocation', async () => {
  const originalError = console.error,
    originalLog = console.log;
  const errors = [],
    output = [];
  console.error = (value) => errors.push(value);
  console.log = (value) => output.push(value);
  try {
    expect(
      await runCli(
        [
          'caches',
          'execute',
          'repo',
          'topic',
          '--manifest',
          'm1',
          '--confirmation',
          'confirm-1',
        ],
        {
          request: async () => ({
            code: 'CLEANUP_PARTIAL',
            error: 'refused',
            ok: false,
            removedPaths: ['.next/cache'],
            retryId: 'retry-1',
          }),
        }
      )
    ).toBe(1);
    expect(JSON.parse(errors[0])).toMatchObject({
      removedPaths: ['.next/cache'],
      retryId: 'retry-1',
    });
    expect(
      await runCli(['admission'], {
        request: async () => ({
          code: 'OUTCOME_UNKNOWN',
          ok: true,
          state: 'unknown',
        }),
      })
    ).toBe(1);
    expect(
      await runCli(
        [
          'workflows',
          'dispatch',
          'repo',
          'topic',
          '--workflow',
          'wf',
          '--ref',
          'main',
          '--inputs',
          '-',
          '--json',
        ],
        {
          readFile: () => '{}',
          request: async () => ({
            code: 'CONFIRMATION_REQUIRED',
            confirmation: { token: 'review-1' },
            ok: false,
          }),
        }
      )
    ).toBe(1);
    expect(JSON.parse(output[0])).toMatchObject({
      confirmation: { token: 'review-1' },
    });
  } finally {
    console.error = originalError;
    console.log = originalLog;
  }
});

test('MCP config installers are idempotent and retain unrelated temp configuration', () => {
  const home = fs.mkdtempSync(join(tmpdir(), 'setu-cli-mcp-'));
  roots.push(home);
  const codex = join(home, 'codex');
  fs.mkdirSync(codex, { recursive: true });
  fs.writeFileSync(join(codex, 'config.toml'), 'model = "test"\n');
  mcpInstallCodex({ codexHome: codex });
  mcpInstallCodex({ codexHome: codex });
  const codexText = fs.readFileSync(join(codex, 'config.toml'), 'utf8');
  expect(codexText).toContain('model = "test"');
  expect(codexText.match(/\[mcp_servers\.setu\]/g)).toHaveLength(1);

  const cursor = join(home, '.cursor');
  fs.mkdirSync(cursor, { recursive: true });
  fs.writeFileSync(
    join(cursor, 'mcp.json'),
    JSON.stringify({
      mcpServers: { other: { url: 'http://example.test/mcp' } },
    })
  );
  mcpInstallCursor({ home });
  mcpInstallCursor({ home });
  const cursorConfig = JSON.parse(
    fs.readFileSync(join(cursor, 'mcp.json'), 'utf8')
  );
  expect(cursorConfig.mcpServers.other.url).toBe('http://example.test/mcp');
  expect(cursorConfig.mcpServers.setu.url).toBe('http://localhost:2999/mcp');
});

test('the entry point is the last statement, so no command runs before the module is initialised', () => {
  const source = fs.readFileSync(new URL('./cli.js', import.meta.url), 'utf8');
  const entry = source.lastIndexOf('if (import.meta.main) {');
  expect(entry).toBeGreaterThan(-1);
  const after = source.slice(entry);
  // Nothing but the entry block follows it: one closing brace at column 0, at the very end.
  expect(after.trimEnd().endsWith('}')).toBe(true);
  expect(after.match(/^}/gm)?.length).toBe(1);
  expect(source.slice(0, entry)).not.toContain('await runCli()');
});

test('real entry points handle help and invalid input without touching an uninitialised constant', () => {
  const home = fs.mkdtempSync(join(tmpdir(), 'setu-cli-entry-'));
  // A recent check time keeps the optional update nudge from starting a fetch.
  fs.writeFileSync(
    join(home, '.setu.json'),
    JSON.stringify({ lastUpdateCheck: Date.now() })
  );
  try {
    for (const [argv, expectedStatus] of [
      [['help'], 0],
      [['version'], 0],
      [['mcp', 'status'], 0],
      [['mcp', 'install'], 1],
      [['logs'], 1],
      [['pr'], 1],
      [['nonsense'], 1],
      [['headless', 'start', 'repo', 'topic', '--output-bytes', '1.5'], 1],
    ]) {
      const run = spawnSync(
        process.execPath,
        [fileURLToPath(new URL('./cli.js', import.meta.url)), ...argv],
        {
          encoding: 'utf8',
          // A bare PATH keeps `mcp status` from starting any real agent client.
          env: {
            ...process.env,
            HOME: home,
            PATH: `${dirname(process.execPath)}:/usr/bin:/bin`,
          },
          timeout: 20_000,
        }
      );
      expect(`${argv.join(' ')}: ${run.stderr}`).not.toContain(
        'ReferenceError'
      );
      expect(`${argv.join(' ')}: ${run.stderr}`).not.toContain(
        'before initialization'
      );
      expect(run.status).toBe(expectedStatus);
    }
  } finally {
    fs.rmSync(home, { force: true, recursive: true });
  }
}, 60_000);
