import { afterEach, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createUpdateCommand, runUpdateCli } from './update-command.js';

function promiseResult(operation) {
  try {
    return Promise.resolve(operation());
  } catch (error) {
    return Promise.reject(error);
  }
}

test('the CLI entrypoint updates the checkout containing its script, including custom install paths', async () => {
  let selected, requested;
  const lines = [];
  const code = await runUpdateCli({
    args: ['--restart'],
    createCommand: (commandOptions) => {
      selected = commandOptions;
      return {
        update: (updateOptions) => {
          requested = updateOptions;
          return Promise.resolve({ ok: true });
        },
      };
    },
    errorOutput: (line) => lines.push(line),
    home: '/isolated/home',
    moduleUrl: 'file:///isolated/custom%20install/update-command.js',
    output: (line) => lines.push(line),
  });
  expect(selected).toEqual({
    configPath: '/isolated/home/.setu.json',
    repoDir: '/isolated/custom install',
  });
  expect(requested).toEqual({
    includeUntracked: false,
    restartAuthorized: true,
  });
  expect(code).toBe(0);
  expect(lines).toEqual(['Setu updated.']);
});

const roots = [];
function fixture() {
  const root = fs.mkdtempSync(join(tmpdir(), 'setu-update-command-'));
  roots.push(root);
  return root;
}
afterEach(() => {
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { force: true, recursive: true });
  }
});

function adapters(
  root,
  {
    legacy = false,
    uncertainQuiesce = false,
    processRemains = false,
    processUnknown = false,
  } = {}
) {
  const calls = [];
  let head = 'a'.repeat(40),
    stopping = false,
    started = false,
    elapsed = 0;
  const identity = 'Mon Sep 21 10:11:12 2026';
  const repoDir = join(root, 'repo');
  fs.mkdirSync(join(repoDir, '.git'), { recursive: true });
  const options = {
    assertStorage: () => {
      /* No side effect is needed in this fixture. */
      return Promise.resolve();
    },
    configPath: join(root, 'config.json'),
    fetchImpl: (url, request) =>
      promiseResult(() => {
        const path = new URL(url).pathname;
        calls.push(path);
        if (path.endsWith('/capabilities')) {
          if (legacy) {
            return Response.json({ ok: true });
          }
          if (stopping && !started) {
            throw Object.assign(new Error('refused'), { code: 'ECONNREFUSED' });
          }
          return Response.json({
            instanceId: started ? 'new' : 'old',
            processId: started ? 456 : 123,
            processStartIdentity: identity,
            protocol: 1,
          });
        }
        const body = JSON.parse(request.body);
        expect(body.instanceId).toBe('old');
        if (path.endsWith('/quiesce')) {
          if (uncertainQuiesce) {
            throw new Error('response lost');
          }
          return Response.json({
            instanceId: 'old',
            ok: true,
            protocol: 1,
            token: 'owner',
          });
        }
        expect(body.token).toBe('owner');
        if (path.endsWith('/stop')) {
          stopping = true;
          return Response.json({ instanceId: 'old', ok: true });
        }
        if (path.endsWith('/reopen')) {
          return Response.json({ instanceId: 'old', ok: true, protocol: 1 });
        }
        throw new Error('Unexpected test request');
      }),
    now: () => elapsed,
    observeProcess: (processId) => {
      calls.push(`observe-process ${processId}`);
      if (processUnknown) {
        return Promise.resolve({ state: 'unknown' });
      }
      if (stopping && !started && !processRemains) {
        return Promise.resolve({ state: 'absent' });
      }
      return Promise.resolve({
        processId,
        processStartIdentity: identity,
        state: 'alive',
      });
    },
    repoDir,
    run: (command, args) =>
      promiseResult(() => {
        const action = command === 'git' ? args.slice(2) : args;
        calls.push(action.join(' '));
        if (action[0] === 'rev-parse') {
          if (action[1] === '--git-path') {
            return join(repoDir, '.git', action[2]);
          }
          return action[1] === '--abbrev-ref' ? 'main' : head;
        }
        if (
          ['diff', 'ls-files', 'status', 'fetch', 'install', 'link'].includes(
            action[0]
          )
        ) {
          return '';
        }
        if (action[0] === 'rebase') {
          head = 'b'.repeat(40);
          return '';
        }
        throw new Error('Unexpected test command');
      }),
    sleep: (ms) => {
      elapsed += ms;
      return Promise.resolve();
    },
    startPortal: () => {
      calls.push('start-portal');
      started = true;
      return Promise.resolve();
    },
  };
  return { calls, options };
}

test.each(['STORAGE_LOW', 'STORAGE_UNKNOWN'])(
  'low or unknown storage refuses update before any Git, portal, or install effect: %s',
  async (code) => {
    const { options, calls } = adapters(fixture());
    options.assertStorage = () =>
      Promise.reject(Object.assign(new Error('Storage unavailable'), { code }));
    expect(
      await createUpdateCommand(options).update({ restartAuthorized: true })
    ).toMatchObject({ code, ok: false, stage: 'preflight' });
    expect(calls).toEqual([]);
    expect(fs.existsSync(`${options.repoDir}.setu-update.lock`)).toBe(false);
  }
);

test('update rechecks storage before installation and does not stop the old portal when it runs low', async () => {
  const { options, calls } = adapters(fixture());
  options.assertStorage = () => {
    if (calls.includes('rebase origin/main')) {
      return Promise.reject(
        Object.assign(new Error('Storage ran low'), {
          code: 'STORAGE_LOW',
        })
      );
    }
    return Promise.resolve();
  };
  expect(
    await createUpdateCommand(options).update({ restartAuthorized: true })
  ).toMatchObject({
    admissionClosed: true,
    code: 'STORAGE_LOW',
    dependenciesChanged: false,
    ok: false,
    stage: 'install',
  });
  expect(calls).not.toContain('install');
  expect(calls).not.toContain('/api/update/stop');
  expect(calls).not.toContain('start-portal');
});

test('real update command boundary obtains owner handshake before mutations and confirms old exit before new readiness', async () => {
  const root = fixture(),
    { options, calls } = adapters(root);
  const result = await createUpdateCommand(options).update({
    restartAuthorized: true,
  });
  expect(result).toMatchObject({ admissionClosed: false, ok: true });
  expect(calls.indexOf('/api/update/quiesce')).toBeLessThan(
    calls.indexOf('fetch origin --quiet')
  );
  expect(calls.indexOf('/api/update/stop')).toBeGreaterThan(
    calls.indexOf('link')
  );
  expect(calls.indexOf('start-portal')).toBeGreaterThan(
    calls.indexOf('/api/update/stop')
  );
  expect(calls.some((call) => call.startsWith('kill'))).toBe(false);
  expect(
    JSON.parse(fs.readFileSync(options.configPath, 'utf8')).lastUpdateCheck
  ).toBeGreaterThan(0);
  expect(fs.existsSync(`${options.repoDir}.setu-update.lock`)).toBe(false);
});

test('a refused listener with a still-alive old process never starts a replacement portal', async () => {
  const { options, calls } = adapters(fixture(), { processRemains: true });
  const result = await createUpdateCommand(options).update({
    restartAuthorized: true,
  });
  expect(result).toMatchObject({
    admissionClosed: null,
    ok: false,
    stage: 'restart',
  });
  expect(calls).not.toContain('start-portal');
});

test.each([false, true])(
  'missing or uncertain process identity blocks source and dependency changes: %s',
  async (missing) => {
    const { options, calls } = adapters(fixture(), {
      processUnknown: !missing,
    });
    if (missing) {
      options.fetchImpl = () =>
        Promise.resolve(Response.json({ instanceId: 'old', protocol: 1 }));
    }
    const result = await createUpdateCommand(options).update({
      restartAuthorized: true,
    });
    expect(result).toMatchObject({ ok: false, stage: 'portal' });
    expect(calls).not.toContain('fetch origin --quiet');
    expect(calls).not.toContain('install');
    expect(calls).not.toContain('start-portal');
  }
);

test('PID reuse is accepted only with a different known start identity and an absent listener', async () => {
  const { options, calls } = adapters(fixture());
  const observe = options.observeProcess;
  options.observeProcess = (processId) =>
    calls.includes('/api/update/stop') && !calls.includes('start-portal')
      ? Promise.resolve({
          processId,
          processStartIdentity: 'Mon Sep 21 10:22:33 2026',
          state: 'alive',
        })
      : observe(processId);
  expect(
    (await createUpdateCommand(options).update({ restartAuthorized: true })).ok
  ).toBe(true);
  expect(calls).toContain('start-portal');
});

test('uncertain old-process observation after stop cannot be replaced by listener absence', async () => {
  const { options, calls } = adapters(fixture());
  const observe = options.observeProcess;
  options.observeProcess = (processId) =>
    calls.includes('/api/update/stop')
      ? Promise.resolve({ state: 'unknown' })
      : observe(processId);
  expect(
    await createUpdateCommand(options).update({ restartAuthorized: true })
  ).toMatchObject({ ok: false, stage: 'restart' });
  expect(calls).not.toContain('start-portal');
});

test.each([{ legacy: true }, { uncertainQuiesce: true }])(
  'legacy capability and lost quiescence response do not permit source or dependency mutation: %s',
  async (values) => {
    const root = fixture(),
      { options, calls } = adapters(root, values);
    const result = await createUpdateCommand(options).update({
      restartAuthorized: true,
    });
    expect(result.ok).toBe(false);
    expect(calls).not.toContain('fetch origin --quiet');
    expect(calls).not.toContain('install');
    expect(calls).not.toContain('start-portal');
    if (values.uncertainQuiesce) {
      expect(result.admissionClosed).toBe(null);
    }
  }
);

test('unreadable policy storage is refused before Git mutation or quiescence', async () => {
  const root = fixture(),
    { options, calls } = adapters(root);
  fs.writeFileSync(options.configPath, '{broken');
  await expect(
    createUpdateCommand(options).update({ restartAuthorized: true })
  ).rejects.toMatchObject({ code: 'STATE_CORRUPT' });
  expect(calls).toEqual([]);
});

test('a real refused loopback fetch is classified as an absent portal', async () => {
  const server = net.createServer();
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
  } catch (error) {
    if (['EACCES', 'EPERM'].includes(error?.code)) {
      return; // This sandbox denies loopback listeners; CI exercises the fetch below.
    }
    throw error;
  }
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  const root = fixture();
  const command = createUpdateCommand({
    configPath: join(root, 'config.json'),
    portalUrl: `http://127.0.0.1:${port}`,
    repoDir: root,
  });
  await expect(command.inspectPortal()).resolves.toEqual({ state: 'absent' });
});

test.each(['ECONNREFUSED', 'ConnectionRefused'])(
  'both refused error spellings classify the update portal as absent: %s',
  async (code) => {
    const root = fixture();
    const command = createUpdateCommand({
      configPath: join(root, 'config.json'),
      fetchImpl: () =>
        Promise.reject(Object.assign(new Error('refused'), { code })),
      repoDir: root,
    });
    await expect(command.inspectPortal()).resolves.toEqual({ state: 'absent' });
  }
);

test('installer delegates existing checkout to guarded updater and preserves nonzero failure without downstream install', () => {
  const root = fixture(),
    repo = join(root, 'repo'),
    bin = join(root, 'bin');
  fs.mkdirSync(repo);
  fs.mkdirSync(bin);
  fs.writeFileSync(join(repo, 'update-command.js'), '// fixture entrypoint');
  fs.writeFileSync(
    join(bin, 'bun'),
    '#!/bin/sh\nif [ "$1" = "--version" ]; then printf "1.3.14\\n"; exit 0; fi\nprintf "guarded updater: %s\\n" "$*"\nexit 42\n',
    { mode: 0o755 }
  );
  const result = spawnSync(
    'bash',
    [new URL('./install.sh', import.meta.url).pathname, '--restart'],
    {
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        SETU_INSTALL_DIR: repo,
      },
    }
  );
  expect(result.status).toBe(42);
  expect(result.stdout).toContain(
    `guarded updater: ${repo}/update-command.js --restart`
  );
  expect(result.stdout).not.toContain('setu ready');
  expect(result.stdout).not.toContain('Installing bun');
});

test.each([
  ['install', 42],
  ['link', 43],
  ['', 0],
])(
  'fresh installer preserves %s failure and reports readiness only after linking',
  (failure, status) => {
    const root = fixture(),
      repo = join(root, 'repo'),
      bin = join(root, 'bin'),
      calls = join(root, 'calls');
    fs.mkdirSync(bin);
    fs.writeFileSync(
      join(bin, 'gh'),
      '#!/bin/sh\nif [ "$1" = "auth" ]; then exit 0; fi\nmkdir -p "$4"\n',
      { mode: 0o755 }
    );
    fs.writeFileSync(
      join(bin, 'bun'),
      '#!/bin/sh\nif [ "$1" = "--version" ]; then printf "1.3.14\\n"; exit 0; fi\nprintf "%s\\n" "$1" >> "$SETU_TEST_CALLS"\nif [ "$1" = "$SETU_TEST_FAILURE" ]; then exit "$SETU_TEST_STATUS"; fi\n',
      { mode: 0o755 }
    );
    const result = spawnSync(
      'bash',
      [new URL('./install.sh', import.meta.url).pathname],
      {
        encoding: 'utf8',
        env: {
          ...process.env,
          PATH: `${bin}:${process.env.PATH}`,
          SETU_INSTALL_DIR: repo,
          SETU_TEST_CALLS: calls,
          SETU_TEST_FAILURE: failure,
          SETU_TEST_STATUS: String(status),
        },
      }
    );
    expect(result.status).toBe(status);
    expect(fs.readFileSync(calls, 'utf8').trim().split('\n')).toEqual(
      failure === 'install' ? ['install'] : ['install', 'link']
    );
    expect(result.stdout.includes('setu ready')).toBe(status === 0);
  }
);

test('installer refuses an older checkout before invoking a mutating updater', () => {
  const root = fixture(),
    repo = join(root, 'repo'),
    bin = join(root, 'bin');
  fs.mkdirSync(repo);
  fs.mkdirSync(bin);
  fs.writeFileSync(join(bin, 'bun'), '#!/bin/sh\nprintf "1.3.14\\n"\n', {
    mode: 0o755,
  });
  const result = spawnSync(
    'bash',
    [new URL('./install.sh', import.meta.url).pathname],
    {
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        SETU_INSTALL_DIR: repo,
      },
    }
  );
  expect(result.status).toBe(1);
  expect(result.stdout).toContain('no guarded updater');
  expect(fs.readdirSync(repo)).toEqual([]);
});
