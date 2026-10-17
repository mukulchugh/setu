import { API_KEY_VARS } from './cli-helpers.js';

const startIdentity =
  /^(Mon|Tue|Wed|Thu|Fri|Sat|Sun) [A-Z][a-z]{2} \d{1,2} \d{2}:\d{2}:\d{2} \d{4}$/;

function shellQuote(value) {
  return `'${value.replaceAll("'", "'\"'\"'")}'`;
}

function requiredString(value) {
  return (
    typeof value === 'string' && value.length > 0 && !/[\0\r\n]/.test(value)
  );
}

function validLaunchToken(value) {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{16,128}$/.test(value);
}

// This module builds data only. The portal writes the script with restrictive
// permissions, invokes these arguments, then consumes the registration file.
export function buildAgentSessionLaunch({
  checkoutPath,
  command,
  launcherPath,
  registrationPath,
  sessionId,
  launchToken,
} = {}) {
  if (
    ![checkoutPath, command, launcherPath, registrationPath, sessionId].every(
      requiredString
    )
  ) {
    throw new TypeError('A session launch needs safe non-empty strings');
  }
  if (launchToken !== undefined && !validLaunchToken(launchToken)) {
    throw new TypeError('A session launch token is invalid');
  }
  const id = JSON.stringify(sessionId);
  const registration = shellQuote(registrationPath);
  return {
    args: [
      'open',
      '-na',
      'Ghostty',
      '--args',
      `--working-directory=${checkoutPath}`,
      `--command=${launcherPath}`,
    ],
    registration: { path: registrationPath, sessionId },
    script: `#!/bin/zsh -i
source "$HOME/.zshrc"
unset ${API_KEY_VARS.join(' ')}
cd -- ${shellQuote(checkoutPath)} || exit
foreground_job=0
if [[ -t 0 ]] && setopt monitor 2>/dev/null; then
  foreground_job=1
fi
${command} <&0 &
agent_pid=$!
agent_start="$(LC_ALL=C ps -p "$agent_pid" -o lstart= 2>/dev/null | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]][[:space:]]*/ /g')"
if [ -n "$agent_start" ]; then
  registration_tmp=${registration}.$$
  token_suffix=''
  if [[ "\${SETU_SESSION_TOKEN:-}" =~ ^[A-Za-z0-9_-]{16,128}$ ]]; then
    token_suffix=",\\"launchToken\\":\\"$SETU_SESSION_TOKEN\\""
  fi
  (umask 077; printf '{"id":${id},"pid":%s,"processStart":"%s"%s}\\n' "$agent_pid" "$agent_start" "$token_suffix" > "$registration_tmp") && mv -f "$registration_tmp" ${registration}
fi
if [[ "$foreground_job" -eq 1 ]]; then
  fg %+ || wait "$agent_pid"
else
  wait "$agent_pid"
fi
exec zsh -l
`,
  };
}

export function parseSessionRegistration(text, expected) {
  const expectation =
    typeof expected === 'string'
      ? { sessionId: expected }
      : expected && typeof expected === 'object'
        ? expected
        : null;
  if (!(typeof text === 'string' && requiredString(expectation?.sessionId))) {
    return null;
  }
  try {
    const value = JSON.parse(text);
    if (
      value?.id !== expectation.sessionId ||
      !Number.isSafeInteger(value.pid) ||
      value.pid <= 0 ||
      typeof value.processStart !== 'string' ||
      !startIdentity.test(value.processStart) ||
      (expectation.launchToken !== undefined &&
        value.launchToken !== expectation.launchToken)
    ) {
      return null;
    }
    return {
      id: value.id,
      pid: value.pid,
      processStart: value.processStart,
    };
  } catch {
    return null;
  }
}
