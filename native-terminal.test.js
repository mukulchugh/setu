import { expect, test } from 'bun:test';
import {
  buildGhosttyFocusCommand,
  buildGhosttyPasteCommand,
  buildGhosttyScriptLaunch,
  createGhosttyTerminalAdapter,
  parseGhosttyLaunchResponse,
} from './native-terminal.js';

const terminalId = 'A1B2C3D4-E5F6-4A1B-8C2D-1234567890AB';
const session = {
  checkoutIdentity: { ino: '2', known: true },
  checkoutPath: '/work/repo/topic',
  id: 'session-1',
  name: 'topic',
  ownership: 'owned',
  repo: 'repo',
  state: 'running',
  terminal: { id: terminalId, kind: 'ghostty' },
  tool: 'codex',
};

test('Ghostty script launch captures only its documented terminal UUID response', () => {
  const launch = buildGhosttyScriptLaunch({
    checkoutPath: '/work/repo/topic',
    launcherPath: '/tmp/setu-launch.zsh',
    launchToken: 'token_1234567890123456',
  });
  expect(launch.args.slice(0, 3)).toEqual(['osascript', '-e', launch.script]);
  expect(launch.args.slice(-4)).toEqual([
    '--',
    '/tmp/setu-launch.zsh',
    '/work/repo/topic',
    'token_1234567890123456',
  ]);
  expect(launch.script).toContain('new window with configuration');
  expect(launch.script).toContain('focused terminal of selected tab');
  expect(launch.script).toContain('id of launchedTerminal');
  expect(parseGhosttyLaunchResponse(`SETU:LAUNCHED:${terminalId}\n`)).toBe(
    terminalId
  );
  expect(parseGhosttyLaunchResponse('SETU:LAUNCHED:7')).toBeNull();
});

test('Ghostty focus and paste transports target the UUID and never send Enter', () => {
  const focus = buildGhosttyFocusCommand({
    checkoutPath: '/work/repo/topic',
    terminalId,
  });
  const paste = buildGhosttyPasteCommand({
    checkoutPath: '/work/repo/topic',
    terminalId,
    text: 'Editable handoff\nDo not submit',
  });
  expect(focus.args).toEqual([
    'osascript',
    '-e',
    focus.script,
    '--',
    terminalId,
    '/work/repo/topic',
  ]);
  expect(focus.script).toContain('focus terminalRef');
  expect(paste.args.at(-1)).toBe('Editable handoff\nDo not submit');
  expect(paste.script).toContain('input text (item 3 of argv) to terminalRef');
  expect(paste.script).not.toContain('send key');
  expect(paste.script).not.toContain('focus terminalRef');
  for (const transport of [focus, paste]) {
    const runningCheck = transport.script.indexOf(
      'if application "Ghostty" is not running then return "SETU:MISSING"'
    );
    expect(runningCheck).toBeGreaterThan(-1);
    expect(runningCheck).toBeLessThan(
      transport.script.indexOf('tell application "Ghostty"')
    );
  }
});

test('Ghostty adapter revalidates the owned session and confirms the exact UUID', async () => {
  const calls = [];
  const adapter = createGhosttyTerminalAdapter({
    // biome-ignore lint/suspicious/useAwait: Native terminal command fixtures preserve the asynchronous adapter contract.
    runAppleScript: async (request) => {
      calls.push(request);
      return { availability: 'available', stdout: `SETU:OK:${terminalId}` };
    },
    verifySession: async ({ sessionId }) => ({
      ok: true,
      session: sessionId === session.id ? session : null,
    }),
  });
  await expect(
    adapter.focus({
      checkoutIdentity: session.checkoutIdentity,
      checkoutPath: session.checkoutPath,
      sessionId: session.id,
      tool: 'codex',
    })
  ).resolves.toEqual({
    checkoutIdentity: session.checkoutIdentity,
    ok: true,
    sessionId: session.id,
  });
  await expect(
    adapter.deliver({
      checkoutIdentity: session.checkoutIdentity,
      sessionId: session.id,
      text: 'Editable handoff',
    })
  ).resolves.toEqual({
    checkoutIdentity: session.checkoutIdentity,
    ok: true,
    sessionId: session.id,
  });
  expect(calls.map((call) => call.args[0])).toEqual(['osascript', 'osascript']);
});

test('Ghostty adapter refuses unavailable scripting, missing UUID mappings and checkout changes', async () => {
  const unavailable = createGhosttyTerminalAdapter({
    runAppleScript: async () => ({ availability: 'disabled' }),
    verifySession: async () => ({ ok: true, session }),
  });
  await expect(
    unavailable.focus({
      checkoutIdentity: session.checkoutIdentity,
      checkoutPath: session.checkoutPath,
      sessionId: session.id,
      tool: 'codex',
    })
  ).resolves.toMatchObject({ code: 'GHOSTTY_AUTOMATION_DISABLED', ok: false });
  const noTerminal = createGhosttyTerminalAdapter({
    runAppleScript: async () => ({ availability: 'available', stdout: '' }),
    verifySession: async () => ({
      ok: true,
      session: { ...session, terminal: null },
    }),
  });
  await expect(
    noTerminal.focus({
      checkoutIdentity: session.checkoutIdentity,
      checkoutPath: session.checkoutPath,
      sessionId: session.id,
      tool: 'codex',
    })
  ).resolves.toMatchObject({ code: 'GHOSTTY_TERMINAL_UNAVAILABLE', ok: false });
  const changed = createGhosttyTerminalAdapter({
    runAppleScript: async () => ({
      availability: 'available',
      stdout: 'SETU:CHECKOUT_MISMATCH',
    }),
    verifySession: async () => ({ ok: true, session }),
  });
  await expect(
    changed.focus({
      checkoutIdentity: session.checkoutIdentity,
      checkoutPath: session.checkoutPath,
      sessionId: session.id,
      tool: 'codex',
    })
  ).resolves.toMatchObject({ code: 'GHOSTTY_CHECKOUT_CHANGED', ok: false });
});
