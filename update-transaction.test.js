import { expect, test } from 'bun:test';
import { runUpdateTransaction } from './update-transaction.js';

function scenario({
  dirty = false,
  untracked = [],
  failAt,
  portal = 'absent',
  busy = false,
} = {}) {
  const calls = [],
    original = 'a'.repeat(40),
    updated = 'b'.repeat(40),
    stash = 'c'.repeat(40),
    older = 'd'.repeat(40);
  let head = original,
    stashMade = false,
    marker = '';
  const deps = {
    // biome-ignore lint/suspicious/useAwait: Git command failures must reject through the transaction's async adapter.
    git: async (args) => {
      calls.push(args.join(' '));
      if (args[0] === 'rev-parse') {
        return args[1] === '--abbrev-ref' ? 'main' : head;
      }
      if (args[0] === 'diff') {
        return '';
      }
      if (args[0] === 'ls-files') {
        return untracked.join('\0') + (untracked.length ? '\0' : '');
      }
      if (args[0] === 'status') {
        return !stashMade && (dirty || untracked.length)
          ? ' M source.js\0'
          : '';
      }
      if (args[0] === 'fetch') {
        if (failAt === 'fetch') {
          throw new Error('network');
        }
        return '';
      }
      if (args[0] === 'rebase') {
        if (failAt === 'rebase') {
          throw new Error('conflict');
        }
        head = updated;
        return '';
      }
      if (args[0] === 'reset') {
        head = original;
        return '';
      }
      if (args[0] === 'stash' && args[1] === 'list') {
        return `${stashMade ? `${stash}\0On main: ${marker}\n` : ''}${older}\0On main: unrelated\n`;
      }
      if (args[0] === 'stash' && args[1] === 'push') {
        if (failAt === 'stash') {
          throw new Error('disk');
        }
        marker = args.at(-1);
        stashMade = true;
        return '';
      }
      if (args[0] === 'stash' && args[1] === 'apply') {
        if (failAt === 'restore') {
          throw new Error('conflict');
        }
        return '';
      }
      if (args[0] === 'cat-file') {
        return '';
      }
      throw new Error(`Unexpected command ${args.join(' ')}`);
    },
    inProgress: () => Promise.resolve(false),
    inspectPortal: () => {
      if (portal === 'absent') {
        return Promise.resolve({ state: 'absent' });
      }
      if (portal === 'legacy') {
        return Promise.resolve({ state: 'unknown' });
      }
      return Promise.resolve({
        instanceId: 'old',
        protocol: 1,
        state: 'ready',
      });
    },
    // biome-ignore lint/suspicious/useAwait: The injected install failure must remain a rejected promise.
    install: async () => {
      calls.push('install');
      if (failAt === 'install') {
        throw new Error('failed');
      }
    },
    // biome-ignore lint/suspicious/useAwait: The injected link failure must remain a rejected promise.
    link: async () => {
      calls.push('link');
      if (failAt === 'link') {
        throw new Error('failed');
      }
    },
    operationId: () => 'fixture-operation',
    quiesce: () => {
      calls.push('quiesce');
      return Promise.resolve({
        code: busy ? 'OWNED_WORK_ACTIVE' : undefined,
        instanceId: 'old',
        ok: !busy,
        protocol: 1,
        token: 'owner',
      });
    },
    reopen: () => {
      calls.push('reopen');
      return Promise.resolve({ ok: true });
    },
    // biome-ignore lint/suspicious/useAwait: The injected restart failure must remain a rejected promise.
    restart: async () => {
      calls.push('restart');
      if (failAt === 'restart') {
        throw new Error('failed');
      }
    },
    writeCheck: () => {
      calls.push('settings');
      return Promise.resolve({
        committed: true,
        reconciled: true,
        ...(failAt === 'warning'
          ? { warning: { code: 'STATE_DURABILITY_UNCONFIRMED' } }
          : {}),
      });
    },
  };
  return { calls, deps, older, original, stash };
}

test('restore conflict preserves exact recovery identity and stops before install/link/restart', async () => {
  const s = scenario({ dirty: true, failAt: 'restore', portal: 'ready' });
  const result = await runUpdateTransaction(s.deps, {
    restartAuthorized: true,
  });
  expect(result).toMatchObject({
    admissionClosed: false,
    before: s.original,
    ok: false,
    stage: 'restore',
    stashId: s.stash,
  });
  expect(s.calls).toContain(`stash apply --index ${s.stash}`);
  expect(
    s.calls.some((call) =>
      ['install', 'link', 'restart', 'settings'].includes(call)
    )
  ).toBe(false);
  expect(
    s.calls.some(
      (call) => call.startsWith('stash pop') || call.startsWith('stash drop')
    )
  ).toBe(false);
});

test('low storage after rebase never prevents restoring the exact recovery stash', async () => {
  const s = scenario({ dirty: true, portal: 'ready' });
  // biome-ignore lint/suspicious/useAwait: Storage refusal must reject at the transaction's awaited preflight boundary.
  s.deps.checkStorage = async () => {
    if (s.calls.includes('rebase origin/main')) {
      throw Object.assign(new Error('Storage ran low'), {
        code: 'STORAGE_LOW',
      });
    }
  };
  const result = await runUpdateTransaction(s.deps, {
    restartAuthorized: true,
  });
  expect(s.calls).toContain(`stash apply --index ${s.stash}`);
  expect(result).toMatchObject({
    admissionClosed: false,
    code: 'STORAGE_LOW',
    dependenciesChanged: false,
    ok: false,
    stage: 'install',
    stashId: s.stash,
  });
  expect(s.calls).not.toContain('install');
  expect(s.calls).not.toContain('restart');
});

test('update installation explicitly requires the frozen lockfile', async () => {
  const s = scenario();
  let installOptions;
  s.deps.install = (options) => {
    installOptions = options;
    return Promise.resolve();
  };
  await expect(runUpdateTransaction(s.deps)).resolves.toMatchObject({
    ok: true,
  });
  expect(installOptions).toEqual({ frozenLockfile: true });
});

test('unreviewed untracked work refuses before quiescence or source mutation', async () => {
  const s = scenario({ dirty: true, untracked: ['agent.js'] });
  expect(await runUpdateTransaction(s.deps)).toMatchObject({
    code: 'UNTRACKED_REVIEW_REQUIRED',
    ok: false,
  });
  expect(
    s.calls.some(
      (call) =>
        ['quiesce', 'install', 'link', 'restart'].includes(call) ||
        call.startsWith('stash push') ||
        call.startsWith('fetch')
    )
  ).toBe(false);
});

test('explicitly reviewed untracked files use include-untracked and exact stash apply, retaining previous stashes', async () => {
  const s = scenario({ dirty: true, untracked: ['agent.js'] });
  const result = await runUpdateTransaction(s.deps, { includeUntracked: true });
  expect(result).toMatchObject({ ok: true, stashId: s.stash });
  expect(
    s.calls.some((call) => call.startsWith('stash push --include-untracked'))
  ).toBe(true);
  expect(s.calls).toContain(`stash apply --index ${s.stash}`);
  expect(s.calls).not.toContain('restart');
  expect(s.calls.some((call) => call.startsWith('stash drop'))).toBe(false);
});

test.each(['fetch', 'stash', 'rebase', 'install', 'link'])(
  '%s failure has a distinct unsuccessful stage and no downstream work',
  async (failAt) => {
    const s = scenario({ dirty: true, failAt, portal: 'ready' });
    const result = await runUpdateTransaction(s.deps, {
      restartAuthorized: true,
    });
    expect(result).toMatchObject({
      ok: false,
      stage: failAt === 'stash' ? 'stash-create' : failAt,
    });
    expect(s.calls).not.toContain('restart');
    expect(s.calls).not.toContain('settings');
    if (['fetch', 'stash', 'rebase'].includes(failAt)) {
      expect(s.calls).not.toContain('install');
      expect(s.calls).not.toContain('link');
    }
    if (failAt === 'install') {
      expect(s.calls).not.toContain('link');
    }
    if (['fetch', 'stash', 'rebase', 'install', 'link'].includes(failAt)) {
      expect(s.calls).toContain('reopen');
    }
  }
);

test.each(['legacy', 'ready'])(
  'portal %s refuses before loaded source changes without compatible restart approval',
  async (portal) => {
    const s = scenario({ portal });
    const result = await runUpdateTransaction(s.deps);
    expect(result.ok).toBe(false);
    expect(
      s.calls.some(
        (call) =>
          call.startsWith('fetch') || call === 'install' || call === 'quiesce'
      )
    ).toBe(false);
  }
);

test('busy quiescence reopens only unchanged source and does no update work', async () => {
  const s = scenario({ busy: true, portal: 'ready' });
  const result = await runUpdateTransaction(s.deps, {
    restartAuthorized: true,
  });
  expect(result).toMatchObject({
    admissionClosed: false,
    ok: false,
    stage: 'quiesce',
  });
  expect(s.calls).toContain('reopen');
  expect(s.calls.some((call) => call.startsWith('fetch'))).toBe(false);
});

test('a lost reopen response reports unknown admission instead of claiming it stayed closed', async () => {
  const s = scenario({ busy: true, portal: 'ready' });
  s.deps.reopen = () => Promise.reject(new Error('response lost'));
  expect(
    await runUpdateTransaction(s.deps, { restartAuthorized: true })
  ).toMatchObject({ admissionClosed: null, ok: false });
});

test('clean update holds admission through installation and authorized restart; committed setting warning survives', async () => {
  const s = scenario({ failAt: 'warning', portal: 'ready' });
  const result = await runUpdateTransaction(s.deps, {
    restartAuthorized: true,
  });
  expect(result).toMatchObject({
    ok: true,
    warning: { code: 'STATE_DURABILITY_UNCONFIRMED' },
  });
  expect(s.calls.indexOf('quiesce')).toBeLessThan(
    s.calls.findIndex((call) => call.startsWith('fetch'))
  );
  expect(s.calls.slice(-4)).toEqual(['install', 'link', 'settings', 'restart']);
  expect(s.calls).not.toContain('reopen');
});

test('existing Git operation refuses before attempting quiescence or changing any source', async () => {
  const s = scenario({ portal: 'ready' });
  s.deps.inProgress = () => Promise.resolve(true);
  expect(
    await runUpdateTransaction(s.deps, { restartAuthorized: true })
  ).toMatchObject({
    code: 'GIT_OPERATION_PENDING',
    ok: false,
    stage: 'preflight',
  });
  expect(s.calls).not.toContain('quiesce');
  expect(s.calls.some((call) => call.startsWith('fetch'))).toBe(false);
});

test('failed settings reconciliation blocks restart after install and reports unresolved closure', async () => {
  const s = scenario({ portal: 'ready' });
  s.deps.writeCheck = () =>
    Promise.resolve({ committed: true, reconciled: false });
  expect(
    await runUpdateTransaction(s.deps, { restartAuthorized: true })
  ).toMatchObject({
    admissionClosed: false,
    code: 'STATE_RECONCILIATION_REQUIRED',
    dependenciesChanged: true,
    ok: false,
    stage: 'settings',
  });
  expect(s.calls).not.toContain('restart');
  expect(s.calls).toContain('reopen');
});

test('failed restart reports admission state as unknown instead of claiming old closure still holds', async () => {
  const s = scenario({ failAt: 'restart', portal: 'ready' });
  expect(
    await runUpdateTransaction(s.deps, { restartAuthorized: true })
  ).toMatchObject({ admissionClosed: null, ok: false, stage: 'restart' });
});
