import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createTerminalAttention,
  createTrustedHookIngress,
  parseClaudeCodeAttentionHook,
  parseCodexAttentionHook,
} from './terminal-attention.js';
import { createWorkspaceState } from './workspace-state.js';

const roots = [];
afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { force: true, recursive: true });
  }
});

function stateFixture() {
  const root = mkdtempSync(join(tmpdir(), 'setu-attention-test-'));
  roots.push(root);
  const state = createWorkspaceState({
    configPath: join(root, 'config.json'),
    setuDir: root,
    workspaceRoot: root,
  });
  return { configPath: join(root, 'config.json'), root, state };
}

test('documented hook payloads normalize only attention events without retaining prompt or command content', () => {
  expect(
    parseClaudeCodeAttentionHook({
      hook_event_name: 'PermissionRequest',
      session_id: 'claude-1',
      tool_input: { command: 'contains-a-secret' },
    })
  ).toEqual({ kind: 'permission', sessionId: 'claude-1' });
  expect(
    parseClaudeCodeAttentionHook({
      hook_event_name: 'Notification',
      message: 'contains-a-question',
      notification_type: 'agent_needs_input',
      session_id: 'claude-1',
    })
  ).toEqual({ kind: 'question', sessionId: 'claude-1' });
  expect(
    parseClaudeCodeAttentionHook({
      hook_event_name: 'Stop',
      last_assistant_message: 'claims completion',
      session_id: 'claude-1',
    })
  ).toEqual({ kind: 'between-turns', sessionId: 'claude-1' });
  expect(
    parseCodexAttentionHook({
      hook_event_name: 'PermissionRequest',
      session_id: 'codex-1',
      tool_input: { command: 'contains-a-secret' },
    })
  ).toEqual({ kind: 'permission', sessionId: 'codex-1' });
  expect(
    parseCodexAttentionHook({
      hook_event_name: 'Stop',
      last_assistant_message: 'claims completion',
      session_id: 'codex-1',
    })
  ).toEqual({ kind: 'between-turns', sessionId: 'codex-1' });
  expect(parseCodexAttentionHook({ hook_event_name: 'UserPromptSubmit' })).toBe(
    null
  );
});

test('attention is explicitly received, expires to unknown, and never treats Stop as completion', async () => {
  const fixture = stateFixture();
  writeFileSync(fixture.configPath, '{\n  "manualSetting": true\n}\n');
  const configBefore = readFileSync(fixture.configPath, 'utf8');
  let time = 100;
  const sessions = {
    get(id) {
      return id === 'setu-known'
        ? {
            checkoutIdentity: 'checkout-a',
            checkoutPath: '/worktree',
            id,
            ownership: 'owned',
            state: 'running',
            tool: 'codex',
          }
        : null;
    },
    list: () => [],
  };
  const attention = createTerminalAttention({
    now: () => time,
    resolveHookSession: ({ nativeSessionId, provider }) =>
      nativeSessionId === 'native-known' && provider === 'codex'
        ? { checkoutIdentity: 'checkout-a', sessionId: 'setu-known' }
        : null,
    sessions,
    state: fixture.state,
    ttlMs: 20,
  });

  await expect(
    attention.receive({
      payload: {
        cwd: '/worktree',
        hook_event_name: 'Stop',
        session_id: 'native-known',
      },
      provider: 'codex',
    })
  ).resolves.toMatchObject({
    attention: { kind: 'between-turns', state: 'between-turns' },
    ok: true,
  });
  expect(readFileSync(fixture.configPath, 'utf8')).toBe(configBefore);
  expect(fixture.state.read('attention').events[0]).toEqual({
    at: 100,
    expiresAt: 120,
    kind: 'between-turns',
    provider: 'codex',
    sessionId: 'setu-known',
    state: 'between-turns',
  });
  time = 121;
  expect(attention.list().events[0]).toMatchObject({
    kind: 'between-turns',
    state: 'unknown',
  });
  await expect(
    attention.receive({
      payload: {
        cwd: '/worktree',
        hook_event_name: 'Stop',
        session_id: 'missing',
      },
      provider: 'claude-code',
    })
  ).resolves.toMatchObject({ attention: { state: 'unknown' }, ok: true });
  await expect(
    attention.receive({
      payload: {
        cwd: '/worktree',
        hook_event_name: 'Stop',
        session_id: 'native-known',
      },
      provider: 'claude-code',
    })
  ).resolves.toMatchObject({ attention: { state: 'unknown' }, ok: true });
});

test('native hook ids require a trusted mapping and never trust wrong checkout or unavailable sessions', async () => {
  const fixture = stateFixture();
  const sessions = {
    get(id) {
      if (id === 'running') {
        return {
          checkoutIdentity: 'checkout-a',
          checkoutPath: '/worktree',
          id,
          ownership: 'owned',
          state: 'running',
          tool: 'claude',
        };
      }
      if (id === 'ended') {
        return {
          checkoutIdentity: 'checkout-a',
          checkoutPath: '/worktree',
          id,
          ownership: 'owned',
          state: 'ended',
          tool: 'claude',
        };
      }
      return {
        checkoutIdentity: 'checkout-a',
        checkoutPath: '/worktree',
        id,
        ownership: 'unknown',
        state: 'unknown',
        tool: 'claude',
      };
    },
    list: () => [],
  };
  const attention = createTerminalAttention({
    now: () => 1,
    resolveHookSession: ({ nativeSessionId }) =>
      ({
        ended: { checkoutIdentity: 'checkout-a', sessionId: 'ended' },
        native: { checkoutIdentity: 'checkout-a', sessionId: 'running' },
        unknown: { checkoutIdentity: 'checkout-a', sessionId: 'unknown' },
      })[nativeSessionId] ?? null,
    sessions,
    state: fixture.state,
  });
  await expect(
    attention.receive({
      payload: {
        cwd: '/worktree',
        hook_event_name: 'Stop',
        session_id: 'native',
      },
      provider: 'claude',
    })
  ).resolves.toMatchObject({
    attention: {
      provider: 'claude-code',
      sessionId: 'running',
      state: 'between-turns',
    },
    ok: true,
  });
  for (const [sessionId, cwd] of [
    ['native', '/spoofed'],
    ['ended', '/worktree'],
    ['unknown', '/worktree'],
  ]) {
    await expect(
      attention.receive({
        payload: { cwd, hook_event_name: 'Stop', session_id: sessionId },
        provider: 'claude',
      })
    ).resolves.toMatchObject({ attention: { state: 'unknown' }, ok: true });
  }
  const unmapped = createTerminalAttention({
    now: () => 1,
    sessions,
    state: fixture.state,
  });
  await expect(
    unmapped.receive({
      payload: {
        cwd: '/worktree',
        hook_event_name: 'Stop',
        session_id: 'native',
      },
      provider: 'claude',
    })
  ).resolves.toMatchObject({ attention: { state: 'unknown' }, ok: true });
});

test('private launch bindings connect hook session ids without persisting a raw hook payload', async () => {
  const fixture = stateFixture();
  const session = {
    checkoutIdentity: 'checkout-a',
    checkoutPath: '/worktree',
    id: 'setu-1',
    ownership: 'owned',
    state: 'running',
    tool: 'claude',
  };
  const sessions = {
    get: (id) => (id === 'setu-1' ? session : null),
    list: () => [],
  };
  const ingress = createTrustedHookIngress({ sessions });
  expect(
    ingress.registerLaunch({
      checkoutIdentity: 'checkout-a',
      checkoutPath: '/worktree',
      launchToken: 'token_1234567890123456',
      provider: 'claude-code',
      sessionId: 'setu-1',
    })
  ).toEqual({ ok: true, sessionId: 'setu-1' });
  expect(
    ingress.bind({
      checkoutPath: '/worktree',
      launchToken: 'wrong_1234567890123456',
      nativeSessionId: 'native-1',
      provider: 'claude-code',
    })
  ).toMatchObject({ code: 'HOOK_BINDING_UNAUTHORIZED', ok: false });
  expect(
    ingress.bind({
      checkoutPath: '/worktree',
      launchToken: 'token_1234567890123456',
      nativeSessionId: 'native-1',
      provider: 'claude-code',
    })
  ).toEqual({ ok: true, sessionId: 'setu-1' });
  const attention = createTerminalAttention({
    now: () => 1,
    resolveHookSession: ingress.resolveHookSession,
    sessions,
    state: fixture.state,
  });
  await expect(
    attention.receive({
      payload: {
        cwd: '/worktree',
        hook_event_name: 'Stop',
        session_id: 'native-1',
      },
      provider: 'claude-code',
    })
  ).resolves.toMatchObject({ attention: { sessionId: 'setu-1' }, ok: true });
  expect(JSON.stringify(fixture.state.read('attention'))).not.toContain(
    'native-1'
  );
});

test('malformed attention events are refused without changing journal bytes', async () => {
  const fixture = stateFixture();
  const documentPath = join(fixture.root, '.setu-attention.json');
  writeFileSync(documentPath, '{\n  "events": {}\n}\n');
  const before = readFileSync(documentPath, 'utf8');
  const attention = createTerminalAttention({
    now: () => 1,
    resolveHookSession: () => null,
    sessions: { get: () => null, list: () => [] },
    state: fixture.state,
  });
  await expect(
    attention.receive({
      payload: {
        cwd: '/worktree',
        hook_event_name: 'Stop',
        session_id: 'native',
      },
      provider: 'codex',
    })
  ).resolves.toMatchObject({ code: 'ATTENTION_CORRUPT', ok: false });
  expect(readFileSync(documentPath, 'utf8')).toBe(before);
});

test('return to terminal focuses a proven running session once and never launches a second terminal', async () => {
  const fixture = stateFixture();
  const focused = [];
  const attention = createTerminalAttention({
    launcher: {
      focus: async ({ checkoutIdentity, sessionId }) => {
        focused.push(sessionId);
        return { checkoutIdentity, ok: true, sessionId };
      },
    },
    now: () => 1,
    sessions: {
      get: (id) =>
        id === 'active'
          ? {
              checkoutIdentity: 'checkout-1',
              id,
              ownership: 'owned',
              state: 'running',
            }
          : id === 'unknown'
            ? { id, ownership: 'unknown', state: 'unknown' }
            : null,
      list: () => [],
    },
    state: fixture.state,
  });

  await expect(attention.returnToTerminal('active')).resolves.toEqual({
    action: 'focus',
    ok: true,
    sessionId: 'active',
  });
  expect(focused).toEqual(['active']);
  await expect(attention.returnToTerminal('unknown')).resolves.toMatchObject({
    code: 'SESSION_NOT_OWNED',
    ok: false,
  });
  await expect(attention.returnToTerminal('missing')).resolves.toMatchObject({
    code: 'SESSION_NOT_FOUND',
    ok: false,
  });
  const unsupported = createTerminalAttention({
    now: () => 1,
    sessions: {
      get: () => ({
        checkoutIdentity: 'checkout-1',
        id: 'active',
        ownership: 'owned',
        state: 'running',
      }),
      list: () => [],
    },
    state: fixture.state,
  });
  await expect(unsupported.returnToTerminal('active')).resolves.toMatchObject({
    code: 'TERMINAL_FOCUS_UNAVAILABLE',
    ok: false,
  });
});
