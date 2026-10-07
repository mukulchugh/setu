const DEFAULT_MAX_CHARS = 4000;

export const terminalHandoffRequirements = {
  capability: 'deliver-to-existing-native-terminal-session',
  mustNot: 'launch, spawn, or create a terminal session',
  proof: ['sessionId', 'checkoutIdentity'],
  request: '{ sessionId, checkoutIdentity, text }',
  result: '{ ok: true, sessionId, checkoutIdentity }',
};

function sameIdentity(a, b) {
  if (a === b) {
    return true;
  }
  if (!(a && b && typeof a === 'object' && typeof b === 'object')) {
    return false;
  }
  const aKeys = Object.keys(a).sort();
  const bKeys = Object.keys(b).sort();
  return (
    aKeys.length === bKeys.length &&
    aKeys.every(
      (key, index) => key === bKeys[index] && sameIdentity(a[key], b[key])
    )
  );
}

function text(value, maximum) {
  if (typeof value !== 'string') {
    return '';
  }
  return value.length <= maximum ? value : `${value.slice(0, maximum - 1)}…`;
}

function matchesSession(session, sessionId, target, checkoutIdentity) {
  return (
    session?.id === sessionId &&
    session.repo === target.repo &&
    session.name === target.name &&
    session.state === 'running' &&
    session.ownership === 'owned' &&
    sameIdentity(session.checkoutIdentity, checkoutIdentity)
  );
}

function renderFinding(finding) {
  const parts = [`Finding ${text(finding.id, 120) || 'selected'}`];
  if (finding.file) {
    parts.push(`File: ${text(finding.file, 240)}`);
  }
  if (finding.context) {
    parts.push(`Context: ${text(finding.context, 800)}`);
  }
  if (finding.outcome) {
    parts.push(`Intended outcome: ${text(finding.outcome, 500)}`);
  }
  if (finding.constraints) {
    parts.push(`Constraints: ${text(finding.constraints, 500)}`);
  }
  return parts.join('\n');
}

function boundedPayload({ artifact, findings, target }, maxChars) {
  const header = [
    'Editable review handoff. Do not commit, push, or deploy.',
    `Worktree: ${text(target.repo, 120)}/${text(target.name, 160)}`,
    `Review: PR ${text(String(artifact.prNumber ?? 'unknown'), 80)}, HEAD ${text(artifact.headSha, 160) || 'unknown'}`,
    artifact.stale
      ? 'Review artifact is stale. Verify the current checkout before acting.'
      : '',
  ]
    .filter(Boolean)
    .join('\n');
  const boundedHeader = text(header, maxChars);
  const room = Math.max(0, maxChars - boundedHeader.length - 2);
  const body = findings.slice(0, 20).map(renderFinding).join('\n\n');
  if (!room) {
    return boundedHeader;
  }
  return body.length <= room
    ? `${boundedHeader}\n\n${body}`
    : `${boundedHeader}\n\n${text(body, room)}`;
}

export function createReviewHandoff({
  sessions,
  deliver,
  verifySession,
  maxChars = DEFAULT_MAX_CHARS,
}) {
  const maximum =
    Number.isInteger(maxChars) && maxChars >= 120
      ? maxChars
      : DEFAULT_MAX_CHARS;

  async function send({
    target,
    checkoutIdentity,
    artifact,
    findings,
    sessionId,
  }) {
    if (
      !(
        target?.repo &&
        target?.name &&
        checkoutIdentity &&
        artifact &&
        Array.isArray(findings)
      ) ||
      findings.length === 0 ||
      findings.some((finding) => !finding || typeof finding !== 'object')
    ) {
      return {
        code: 'HANDOFF_INVALID',
        error:
          'A target, checkout identity, artifact and selected finding are required',
        ok: false,
      };
    }
    if (!(typeof sessionId === 'string' && sessionId)) {
      return {
        code: 'SESSION_SELECTION_REQUIRED',
        error: 'Select the exact terminal session for this handoff',
        ok: false,
      };
    }
    if (
      artifact.checkoutIdentity !== undefined &&
      !sameIdentity(artifact.checkoutIdentity, checkoutIdentity)
    ) {
      return {
        code: 'CHECKOUT_IDENTITY_MISMATCH',
        error: 'The review artifact does not match this checkout',
        ok: false,
      };
    }
    const session = sessions.get(sessionId);
    if (!session) {
      return {
        code: 'SESSION_NOT_FOUND',
        error: 'The selected terminal session does not exist',
        ok: false,
      };
    }
    if (!matchesSession(session, sessionId, target, checkoutIdentity)) {
      return {
        code: 'NO_OWNED_SESSION',
        error:
          'The selected terminal session is not an owned running session for this worktree',
        ok: false,
      };
    }
    if (typeof verifySession !== 'function') {
      return {
        code: 'SESSION_VERIFICATION_UNAVAILABLE',
        error: 'The terminal session cannot be reconciled before delivery',
        ok: false,
      };
    }
    let verified;
    try {
      verified = await verifySession({ checkoutIdentity, sessionId });
    } catch {
      verified = null;
    }
    if (
      !(
        verified?.ok &&
        matchesSession(verified.session, sessionId, target, checkoutIdentity)
      )
    ) {
      return {
        code: 'SESSION_OWNERSHIP_UNKNOWN',
        error:
          'Terminal session ownership could not be verified before delivery',
        ok: false,
      };
    }
    if (typeof deliver !== 'function') {
      return {
        code: 'HANDOFF_DELIVERY_UNAVAILABLE',
        error: 'This session cannot receive a review handoff',
        ok: false,
      };
    }
    const handoff = {
      checkoutIdentity,
      sessionId,
      text: boundedPayload({ artifact, findings, target }, maximum),
    };
    try {
      const delivered = await deliver(handoff);
      if (
        !(
          delivered?.ok === true &&
          delivered.sessionId === sessionId &&
          sameIdentity(delivered.checkoutIdentity, checkoutIdentity)
        )
      ) {
        return {
          code: 'HANDOFF_DELIVERY_UNCONFIRMED',
          error:
            'The terminal cannot prove it delivered to this existing session',
          ok: false,
        };
      }
    } catch {
      return {
        code: 'HANDOFF_DELIVERY_FAILED',
        error:
          'The review handoff could not be delivered to the terminal session',
        ok: false,
      };
    }
    return { handoff, ok: true };
  }

  return { deliver: send };
}
