// Hook ingress is explicit. This module never polls terminals or providers.

import { launchProofDigest } from './agent-sessions.js';

const DEFAULT_LIMIT = 100;
const DEFAULT_TTL_MS = 5 * 60 * 1000;
const launchTokenPattern = /^[A-Za-z0-9_-]{16,128}$/;

export const attentionHookEvents = {
  'claude-code': [
    'PermissionRequest',
    'Notification:agent_needs_input',
    'Stop',
  ],
  codex: ['PermissionRequest', 'Stop'],
};

export const terminalFocusRequirements = {
  capability: 'focus-existing-native-terminal-session',
  mustNot: 'launch, spawn, or create a terminal session',
  proof: ['sessionId', 'checkoutIdentity'],
  request: '{ sessionId, checkoutIdentity, checkoutPath, tool }',
  result: '{ ok: true, sessionId, checkoutIdentity }',
};

function validLaunchToken(value) {
  return typeof value === 'string' && launchTokenPattern.test(value);
}

function validSessionId(value) {
  return typeof value === 'string' && value.length > 0;
}

function canonicalProvider(value) {
  if (value === 'claude' || value === 'claude-code') {
    return 'claude-code';
  }
  return value === 'codex' ? 'codex' : null;
}

function hookSessionId(payload) {
  return typeof payload?.session_id === 'string' && payload.session_id
    ? payload.session_id
    : null;
}

function parsed(kind, payload) {
  const sessionId = hookSessionId(payload);
  return sessionId ? { kind, sessionId } : null;
}

export function parseClaudeCodeAttentionHook(payload) {
  if (payload?.hook_event_name === 'PermissionRequest') {
    return parsed('permission', payload);
  }
  if (
    payload?.hook_event_name === 'Notification' &&
    payload.notification_type === 'agent_needs_input'
  ) {
    return parsed('question', payload);
  }
  if (payload?.hook_event_name === 'Stop') {
    return parsed('between-turns', payload);
  }
  return null;
}

export function parseCodexAttentionHook(payload) {
  if (payload?.hook_event_name === 'PermissionRequest') {
    return parsed('permission', payload);
  }
  if (payload?.hook_event_name === 'Stop') {
    return parsed('between-turns', payload);
  }
  return null;
}

function validEvent(event) {
  return (
    event &&
    Number.isFinite(event.at) &&
    Number.isFinite(event.expiresAt) &&
    event.expiresAt >= event.at &&
    ['permission', 'question', 'between-turns', 'unknown'].includes(
      event.kind
    ) &&
    canonicalProvider(event.provider) === event.provider &&
    ['permission', 'question', 'between-turns', 'unknown'].includes(
      event.state
    ) &&
    (event.sessionId === undefined ||
      (typeof event.sessionId === 'string' && event.sessionId.length > 0))
  );
}

function attentionEvents(document) {
  if (!Object.hasOwn(document ?? {}, 'events')) {
    return { ok: true, value: [] };
  }
  const { events } = document;
  return Array.isArray(events) && events.every(validEvent)
    ? { ok: true, value: events }
    : { ok: false };
}

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

function validMapping(value) {
  return (
    value &&
    typeof value.sessionId === 'string' &&
    value.sessionId.length > 0 &&
    Object.hasOwn(value, 'checkoutIdentity')
  );
}

export function createTrustedHookIngress({ sessions } = {}) {
  const refused = (reason) => ({
    code: reason.startsWith('launch-proof')
      ? 'HOOK_BINDING_UNAUTHORIZED'
      : 'HOOK_BINDING_UNVERIFIED',
    error: 'The hook cannot prove its launch binding',
    ok: false,
    reason,
  });
  const proof = (launchToken) =>
    validLaunchToken(launchToken) ? launchProofDigest(launchToken) : null;

  async function bind({
    provider,
    launchToken,
    nativeSessionId,
    checkoutPath,
  }) {
    const canonical = canonicalProvider(provider);
    if (!(canonical && validSessionId(nativeSessionId))) {
      return {
        code: 'HOOK_BINDING_INVALID',
        error: 'The hook launch binding is invalid',
        ok: false,
      };
    }
    const digest = proof(launchToken);
    if (!digest) {
      return refused('launch-proof-missing');
    }
    let bound;
    try {
      bound = await sessions.bindNativeConversation({
        checkoutPath,
        launchProofDigest: digest,
        nativeId: nativeSessionId,
        provider: canonical,
      });
    } catch {
      return refused('binding-unavailable');
    }
    if (bound.ok) {
      return { ok: true, sessionId: bound.session.id };
    }
    return bound.reason ? refused(bound.reason) : bound;
  }

  async function resolveHookSession({
    provider,
    nativeSessionId,
    checkoutPath,
    launchToken,
  }) {
    const digest = proof(launchToken);
    if (!digest) {
      return { ok: false, reason: 'launch-proof-missing' };
    }
    const resolved = await sessions.resolveNativeConversation({
      checkoutPath,
      launchProofDigest: digest,
      nativeId: nativeSessionId,
      provider: canonicalProvider(provider),
    });
    return resolved.ok
      ? {
          boundAt: resolved.session.nativeConversation.boundAt,
          checkoutIdentity: resolved.session.checkoutIdentity,
          generation: resolved.session.bindingGeneration ?? 0,
          nativeId: resolved.session.nativeConversation.id,
          ok: true,
          resumedFrom: resolved.session.nativeConversation.resumedFrom ?? [],
          sessionId: resolved.session.id,
        }
      : resolved;
  }

  return { bind, resolveHookSession };
}

function unknownAttention(provider, at) {
  return { at, expiresAt: at, kind: 'unknown', provider, state: 'unknown' };
}

function visible(event, now) {
  if (event.state === 'unknown' || now < event.expiresAt) {
    return event;
  }
  return { ...event, state: 'unknown' };
}

export function createTerminalAttention({
  state,
  sessions,
  now,
  launcher,
  resolveHookSession,
  limit = DEFAULT_LIMIT,
  ttlMs = DEFAULT_TTL_MS,
}) {
  const clock = now ?? (() => Date.now());
  const maxEvents =
    Number.isInteger(limit) && limit > 0 ? limit : DEFAULT_LIMIT;
  const expiry = Number.isFinite(ttlMs) && ttlMs > 0 ? ttlMs : DEFAULT_TTL_MS;
  const parse = (provider, payload) => {
    if (provider === 'claude-code') {
      return parseClaudeCodeAttentionHook(payload);
    }
    if (provider === 'codex') {
      return parseCodexAttentionHook(payload);
    }
    return null;
  };

  // Only an event this module has just authenticated counts as the session's activity. It is bookkeeping:
  // the attention event is recorded whether or not this succeeds.
  async function noteActivity(id, at) {
    try {
      await sessions.recordHookActivity?.({ at, id });
    } catch {
      // The next authenticated event records it again.
    }
  }

  async function receive({ provider, payload, launchToken }) {
    const at = clock();
    const source = canonicalProvider(provider);
    const initial = attentionEvents(state.read('attention'));
    if (!initial.ok) {
      return {
        code: 'ATTENTION_CORRUPT',
        error: 'The attention journal is invalid',
        ok: false,
      };
    }
    const normalized = parse(source, payload);
    if (!normalized) {
      return {
        attention: unknownAttention(source ?? provider, at),
        code: 'ATTENTION_EVENT_UNSUPPORTED',
        error: 'The hook payload is not a supported attention event',
        ok: false,
      };
    }
    let mapping = null;
    try {
      mapping = await resolveHookSession?.({
        checkoutPath: payload?.cwd,
        launchToken,
        nativeSessionId: normalized.sessionId,
        provider: source,
      });
    } catch {
      mapping = null;
    }
    const session = validMapping(mapping)
      ? sessions.get(mapping.sessionId)
      : null;
    const reason = mapping?.ok === false ? mapping.reason : undefined;
    const verified =
      session &&
      session.ownership === 'owned' &&
      session.state === 'running' &&
      canonicalProvider(session.tool) === source &&
      sameIdentity(mapping.checkoutIdentity, session.checkoutIdentity) &&
      typeof payload?.cwd === 'string' &&
      payload.cwd === session.checkoutPath;
    const event = verified
      ? {
          at,
          expiresAt: at + expiry,
          kind: normalized.kind,
          provider: source,
          sessionId: mapping.sessionId,
          state: normalized.kind,
        }
      : unknownAttention(source, at);
    if (verified) {
      await noteActivity(mapping.sessionId, at);
    }
    await state.update('attention', (document) => {
      const current = attentionEvents(document);
      if (!current.ok) {
        throw Object.assign(new Error('attention journal is invalid'), {
          code: 'ATTENTION_CORRUPT',
        });
      }
      const prior = current.value;
      return {
        ...document,
        events: [...prior, event].slice(-maxEvents),
      };
    });
    return { attention: event, ok: true, ...(reason ? { reason } : {}) };
  }

  function list() {
    const at = clock();
    const current = attentionEvents(state.read('attention'));
    if (!current.ok) {
      return {
        code: 'ATTENTION_CORRUPT',
        error: 'The attention journal is invalid',
        events: [],
        ok: false,
      };
    }
    return {
      events: current.value.map((event) => visible(event, at)),
      ok: true,
    };
  }

  async function returnToTerminal(sessionId) {
    const session = sessions.get(sessionId);
    if (!session) {
      return {
        code: 'SESSION_NOT_FOUND',
        error: 'No managed terminal session exists for this id',
        ok: false,
      };
    }
    if (session.ownership !== 'owned') {
      return {
        code: 'SESSION_NOT_OWNED',
        error: 'The terminal session ownership is unknown',
        ok: false,
      };
    }
    if (session.state !== 'running') {
      return {
        code: 'SESSION_UNAVAILABLE',
        error: 'The terminal session is not running',
        ok: false,
      };
    }
    if (typeof launcher?.focus !== 'function') {
      return {
        code: 'TERMINAL_FOCUS_UNAVAILABLE',
        error: 'This terminal cannot focus the existing session',
        ok: false,
      };
    }
    try {
      const focused = await launcher.focus({
        checkoutIdentity: session.checkoutIdentity,
        checkoutPath: session.checkoutPath,
        sessionId: session.id,
        tool: session.tool,
      });
      if (
        !(
          focused?.ok === true &&
          focused.sessionId === session.id &&
          sameIdentity(focused.checkoutIdentity, session.checkoutIdentity)
        )
      ) {
        return {
          code: 'TERMINAL_FOCUS_UNCONFIRMED',
          error: 'The terminal cannot prove it focused this existing session',
          ok: false,
        };
      }
    } catch {
      return {
        code: 'TERMINAL_FOCUS_FAILED',
        error: 'The existing terminal session could not be focused',
        ok: false,
      };
    }
    return { action: 'focus', ok: true, sessionId: session.id };
  }

  return { list, receive, returnToTerminal };
}
