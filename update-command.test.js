import { afterEach, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createUpdateCommand, runUpdateCli } from './update-command.js';

test('the CLI entrypoint updates the checkout containing its script, including custom install paths', async () => {
  let selected, requested;
  const lines = [];
  const code = await runUpdateCli({
    args: ['--restart'],
    createCommand: (options) => {
      selected = options;
      return {
        update: async (options) => {
          requested = options;
          return { ok: true };
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
    assertStorage: async () => {},
    configPath: join(root, 'config.json'),
    fetchImpl: async (url, request) => {
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
    },
    now: () => elapsed,
    observeProcess: async (processId) => {
      calls.push(`observe-process ${processId}`);
      if (processUnknown) {
        return { state: 'unknown' };
      }
      if (stopping && !started && !processRemains) {
        return { state: 'absent' };
      }
      return { processId, processStartIdentity: identity, state: 'alive' };
    },
    repoDir,
    run: async (command, args) => {
      const action = command === 'git' ? args.slice(2) : args;
      calls.push(action.join(' '));
      if (action[0] === 'rev-parse') {
        return action[1] === '--git-path'
          ? join(repoDir, '.git', action[2])
          : action[1] === '--abbrev-ref'
            ? 'main'
            : head;
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
    },
    sleep: async (ms) => {
      elapsed += ms;
    },
    startPortal: async () => {
      calls.push('start-portal');
      started = true;
    },
  };
  return { calls, options };
}

test('low or unknown storage refuses update before any Git, portal, or install effect', async () => {
  for (const code of ['STORAGE_LOW', 'STORAGE_UNKNOWN']) {
    const { options, calls } = adapters(fixture());
    options.assertStorage = async () => {
      throw Object.assign(new Error('Storage unavailable'), { code });
    };
    expect(
      await createUpdateCommand(options).update({ restartAuthorized: true })
    ).toMatchObject({ ok: false, code, stage: 'preflight' });
    expect(calls).toEqual([]);
    expect(fs.existsSync(`${options.repoDir}.setu-update.lock`)).toBe(false);
  }
});

test('update rechecks storage before installation and does not stop the old portal when it runs low', async () => {
  const { options, calls } = adapters(fixture());
  options.assertStorage = async () => {
    if (calls.includes('rebase origin/main'))
      throw Object.assign(new Error('Storage ran low'), {
        code: 'STORAGE_LOW',
      });
  };
  expect(
    await createUpdateCommand(options).update({ restartAuthorized: true })
  ).toMatchObject({
    ok: false,
    code: 'STORAGE_LOW',
    stage: 'install',
    admissionClosed: true,
    dependenciesChanged: false,
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

test('missing or uncertain process identity blocks source and dependency changes', async () => {
  for (const missing of [false, true]) {
    const { options, calls } = adapters(fixture(), {
      processUnknown: !missing,
    });
    if (missing) {
      options.fetchImpl = async () =>
        Response.json({ instanceId: 'old', protocol: 1 });
    }
    const result = await createUpdateCommand(options).update({
      restartAuthorized: true,
    });
    expect(result).toMatchObject({ ok: false, stage: 'portal' });
    expect(calls).not.toContain('fetch origin --quiet');
    expect(calls).not.toContain('install');
    expect(calls).not.toContain('start-portal');
  }
});

test('PID reuse is accepted only with a different known start identity and an absent listener', async () => {
  const { options, calls } = adapters(fixture());
  const observe = options.observeProcess;
  options.observeProcess = async (processId) =>
    calls.includes('/api/update/stop') && !calls.includes('start-portal')
      ? {
          processId,
          processStartIdentity: 'Mon Sep 21 10:22:33 2026',
          state: 'alive',
        }
      : observe(processId);
  expect(
    (await createUpdateCommand(options).update({ restartAuthorized: true })).ok
  ).toBe(true);
  expect(calls).toContain('start-portal');
});

test('uncertain old-process observation after stop cannot be replaced by listener absence', async () => {
  const { options, calls } = adapters(fixture());
  const observe = options.observeProcess;
  options.observeProcess = async (processId) =>
    calls.includes('/api/update/stop')
      ? { state: 'unknown' }
      : observe(processId);
  expect(
    await createUpdateCommand(options).update({ restartAuthorized: true })
  ).toMatchObject({ ok: false, stage: 'restart' });
  expect(calls).not.toContain('start-portal');
});

test('legacy capability and lost quiescence response do not permit source or dependency mutation', async () => {
  for (const values of [{ legacy: true }, { uncertainQuiesce: true }]) {
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
});

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
      fetchImpl: async () => {
        throw Object.assign(new Error('refused'), { code });
      },
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
    '#!/bin/sh\nprintf "guarded updater: %s\\n" "$*"\nexit 42\n',
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

test('installer refuses an older checkout before invoking a mutating updater', () => {
  const root = fixture(),
    repo = join(root, 'repo');
  fs.mkdirSync(repo);
  const result = spawnSync(
    'bash',
    [new URL('./install.sh', import.meta.url).pathname],
    { encoding: 'utf8', env: { ...process.env, SETU_INSTALL_DIR: repo } }
  );
  expect(result.status).toBe(1);
  expect(result.stdout).toContain('no guarded updater');
  expect(fs.readdirSync(repo)).toEqual([]);
});
