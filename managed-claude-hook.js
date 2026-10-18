// The per-launch Claude hook: the settings that register it and the program Claude runs for each event.
// Generated for one managed session; it never touches user-level settings.

// Budget for the prompt hook. Claude is told to stop it after `providerTimeoutSeconds`. The program
// enforces its own, shorter overall deadline so it has finished, with start-up and exit overhead to spare,
// before Claude would. Only the claim request has a fixed share; the report gets what remains, up to its cap.
//
// `maxTextBytes` is the provider's own documented cap on a hook's plain output (10000 characters, measured
// here in UTF-8 bytes, which is never smaller). Past it Claude replaces the text with a file path and a short
// preview, so a longer text is never written: the engine keeps every turn within it, and this is the
// defence if it ever did not. It must equal `MAX_FRAME_BYTES` in `engines/links/src/frame.rs`, which a
// test enforces.
export const PROMPT_HOOK_BUDGET = Object.freeze({
  claimMs: 3000,
  maxTextBytes: 10_000,
  overallMs: 6000,
  providerTimeoutSeconds: 10,
  reportMs: 2000,
});

const shellQuote = (value) => `'${value.replaceAll("'", "'\"'\"'")}'`;

export function claudeSettings({ hookPath }) {
  const command = (event) => `${shellQuote(hookPath)} ${shellQuote(event)}`;
  const hooks = (event, { matcher, timeout } = {}) => [
    {
      ...(matcher ? { matcher } : {}),
      hooks: [
        {
          command: command(event),
          ...(timeout ? { timeout } : {}),
          type: 'command',
        },
      ],
    },
  ];
  return JSON.stringify({
    hooks: {
      Notification: hooks('Notification', { matcher: 'agent_needs_input' }),
      PermissionRequest: hooks('PermissionRequest'),
      SessionStart: hooks('SessionStart'),
      Stop: hooks('Stop'),
      UserPromptSubmit: hooks('UserPromptSubmit', {
        timeout: PROMPT_HOOK_BUDGET.providerTimeoutSeconds,
      }),
    },
  });
}

export function claudeHookProgram(ingressUrl) {
  const budget = PROMPT_HOOK_BUDGET;
  return `#!/usr/bin/env bun
const event = process.argv[2];
const token = process.env.SETU_SESSION_TOKEN;
if (!/^[A-Za-z0-9_-]{16,128}$/.test(token ?? '')) process.exit(0);
let input = '';
let bytes = 0;
for await (const part of process.stdin) {
  bytes += Buffer.byteLength(part);
  if (bytes > 131072) process.exit(0);
  input += part;
}
let payload;
try { payload = JSON.parse(input); } catch { process.exit(0); }
if (payload?.hook_event_name !== event) process.exit(0);
const post = (body, ms) => fetch(${JSON.stringify(ingressUrl)}, {
  method: 'POST', headers: {'content-type':'application/json'},
  body: JSON.stringify(body),
  signal: AbortSignal.timeout(ms),
});
if (event !== 'UserPromptSubmit') {
  try {
    await post({provider:'claude-code', launchToken:token, payload}, 1000);
  } catch {}
  process.exit(0);
}
// A turn never waits on this program past its own deadline, and it never fails the turn.
const started = Date.now();
const left = () => Math.max(1, ${budget.overallMs} - (Date.now() - started));
setTimeout(() => process.exit(0), ${budget.overallMs});
// Identity fields only: the user's prompt is never sent to the portal.
const identity = { cwd: payload.cwd, hook_event_name: event, session_id: payload.session_id };
try {
  const answer = await post({provider:'claude-code', launchToken:token, payload:identity}, Math.min(${budget.claimMs}, left()));
  const mail = JSON.parse(await answer.text());
  if (mail?.ok === true && typeof mail.attemptId === 'string' && typeof mail.text === 'string' && mail.text.length > 0 && Buffer.byteLength(mail.text) <= ${budget.maxTextBytes}) {
    await new Promise((resolve, reject) => process.stdout.write(mail.text, (error) => error ? reject(error) : resolve()));
    // The context is written. Only now is that reported, so a lost report leaves the mail unknown, never queued.
    await post({provider:'claude-code', launchToken:token, payload:identity, report:{attemptId:mail.attemptId}}, Math.min(${budget.reportMs}, left()));
  }
} catch {}
process.exit(0);
`;
}
