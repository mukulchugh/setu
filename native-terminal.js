const ghosttyId =
  /^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}$/i;
const ghosttyLaunchResponsePattern = /^SETU:LAUNCHED:(.+)$/;
const safeLaunchTokenPattern = /^[A-Za-z0-9_-]{16,128}$/;
const unsafeTextPattern = /[\0\r\n]/;

function validText(value) {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    !unsafeTextPattern.test(value)
  );
}

function validTerminalId(value) {
  return typeof value === 'string' && ghosttyId.test(value);
}

function sameIdentity(a, b) {
  if (a === b) {
    return true;
  }
  if (!(a && b && typeof a === 'object' && typeof b === 'object')) {
    return false;
  }
  const aKeys = Object.keys(a).sort(),
    bKeys = Object.keys(b).sort();
  return (
    aKeys.length === bKeys.length &&
    aKeys.every(
      (key, index) => key === bKeys[index] && sameIdentity(a[key], b[key])
    )
  );
}

function command(script, values) {
  return { args: ['osascript', '-e', script, '--', ...values], script };
}

const checkTerminal = `
set terminalID to item 1 of argv
set expectedCheckout to item 2 of argv
if application "Ghostty" is not running then return "SETU:MISSING"
tell application "Ghostty"
  set terminalIDs to id of every terminal
  if "" is in terminalIDs then return "SETU:SCRIPTING_DISABLED"
  set matches to every terminal whose id is terminalID
  if (count of matches) is not 1 then return "SETU:MISSING"
  set terminalRef to item 1 of matches
  if (working directory of terminalRef) is not expectedCheckout then return "SETU:CHECKOUT_MISMATCH"
`;
const closeTerminal = `
  return "SETU:OK:" & (id of terminalRef)
end tell
end run
`;

export function buildGhosttyFocusCommand({ terminalId, checkoutPath } = {}) {
  if (!(validTerminalId(terminalId) && validText(checkoutPath))) {
    throw new TypeError(
      'Ghostty focus needs a terminal UUID and checkout path'
    );
  }
  return command(
    `on run argv
${checkTerminal}  focus terminalRef
${closeTerminal}`,
    [terminalId, checkoutPath]
  );
}

export function buildGhosttyPasteCommand({
  terminalId,
  checkoutPath,
  text,
} = {}) {
  if (
    !(
      validTerminalId(terminalId) &&
      validText(checkoutPath) &&
      typeof text === 'string'
    )
  ) {
    throw new TypeError(
      'Ghostty paste needs a terminal UUID, checkout path and text'
    );
  }
  return command(
    `on run argv
${checkTerminal}  input text (item 3 of argv) to terminalRef
${closeTerminal}`,
    [terminalId, checkoutPath, text]
  );
}

export function buildGhosttyScriptLaunch({
  launcherPath,
  checkoutPath,
  launchToken,
} = {}) {
  if (
    !(
      validText(launcherPath) &&
      validText(checkoutPath) &&
      typeof launchToken === 'string' &&
      safeLaunchTokenPattern.test(launchToken)
    )
  ) {
    throw new TypeError(
      'Ghostty scripted launch needs safe paths and a private token'
    );
  }
  const script = `on run argv
set launchCommand to item 1 of argv
set checkoutPath to item 2 of argv
set launchToken to item 3 of argv
tell application "Ghostty"
  set config to new surface configuration from {command:launchCommand, initial working directory:checkoutPath, environment variables:{"SETU_SESSION_TOKEN=" & launchToken}}
  set launchedWindow to new window with configuration config
  set launchedTerminal to focused terminal of selected tab of launchedWindow
  set terminalID to id of launchedTerminal
  if terminalID is "" then return "SETU:SCRIPTING_DISABLED"
  return "SETU:LAUNCHED:" & terminalID
end tell
end run
`;
  return command(script, [launcherPath, checkoutPath, launchToken]);
}

export function parseGhosttyLaunchResponse(text) {
  const match =
    typeof text === 'string' && text.trim().match(ghosttyLaunchResponsePattern);
  return match && validTerminalId(match[1]) ? match[1] : null;
}

function matchesRequest(session, request) {
  return (
    session?.id === request.sessionId &&
    session.ownership === 'owned' &&
    session.state === 'running' &&
    (!request.tool || session.tool === request.tool) &&
    sameIdentity(session.checkoutIdentity, request.checkoutIdentity) &&
    validText(session.checkoutPath)
  );
}
function failure(code, error) {
  return { code, error, ok: false };
}
function automationFailure(result) {
  if (result?.availability === 'unavailable') {
    return failure(
      'GHOSTTY_AUTOMATION_UNAVAILABLE',
      'Ghostty automation is unavailable'
    );
  }
  if (
    result?.availability === 'disabled' ||
    result?.stdout?.trim() === 'SETU:SCRIPTING_DISABLED'
  ) {
    return failure(
      'GHOSTTY_AUTOMATION_DISABLED',
      'Ghostty scripting is disabled'
    );
  }
  if (result?.stdout?.trim() === 'SETU:MISSING') {
    return failure(
      'GHOSTTY_TERMINAL_MISSING',
      'The registered Ghostty terminal is unavailable'
    );
  }
  if (result?.stdout?.trim() === 'SETU:CHECKOUT_MISMATCH') {
    return failure(
      'GHOSTTY_CHECKOUT_CHANGED',
      'The Ghostty terminal checkout changed'
    );
  }
  return failure(
    'GHOSTTY_AUTOMATION_UNKNOWN',
    'Ghostty automation could not be confirmed'
  );
}

export function createGhosttyTerminalAdapter({
  runAppleScript,
  verifySession,
} = {}) {
  async function verified(request) {
    if (typeof verifySession !== 'function') {
      return failure(
        'SESSION_VERIFICATION_UNAVAILABLE',
        'The terminal session cannot be reconciled before delivery'
      );
    }
    let outcome;
    try {
      outcome = await verifySession({
        checkoutIdentity: request.checkoutIdentity,
        sessionId: request.sessionId,
      });
    } catch {
      outcome = null;
    }
    return outcome?.ok && matchesRequest(outcome.session, request)
      ? outcome.session
      : failure(
          'SESSION_OWNERSHIP_UNKNOWN',
          'Terminal session ownership could not be verified'
        );
  }
  async function invoke(request, build) {
    const session = await verified(request);
    if (session?.ok === false) {
      return session;
    }
    if (
      !(
        session.terminal?.kind === 'ghostty' &&
        validTerminalId(session.terminal.id)
      )
    ) {
      return failure(
        'GHOSTTY_TERMINAL_UNAVAILABLE',
        'No stable Ghostty terminal mapping exists for this session'
      );
    }
    if (typeof runAppleScript !== 'function') {
      return failure(
        'GHOSTTY_AUTOMATION_UNAVAILABLE',
        'Ghostty automation is unavailable'
      );
    }
    let result;
    try {
      result = await runAppleScript(build(session));
    } catch {
      result = null;
    }
    if (
      result?.availability === 'available' &&
      result.stdout?.trim() === `SETU:OK:${session.terminal.id}`
    ) {
      return {
        checkoutIdentity: session.checkoutIdentity,
        ok: true,
        sessionId: session.id,
      };
    }
    return automationFailure(result);
  }
  return {
    deliver: (request) =>
      invoke(request, (session) =>
        buildGhosttyPasteCommand({
          checkoutPath: session.checkoutPath,
          terminalId: session.terminal.id,
          text: request.text,
        })
      ),
    focus: (request) =>
      invoke(request, (session) =>
        buildGhosttyFocusCommand({
          checkoutPath: session.checkoutPath,
          terminalId: session.terminal.id,
        })
      ),
  };
}
