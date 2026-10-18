// The one Links service every front door calls. Local identity stays with the managed session service:
// this module reads a session's verified native conversation binding and hands the engine a recipient.
// The engine, not this module, keeps every message and every delivery state.

import { createHash } from 'node:crypto';

const failure = (code, error, extra = {}) => ({
  code,
  error,
  ok: false,
  ...extra,
});

// Stable identity text for a checkout: the same identity object always yields the same string.
function canonical(value) {
  if (Array.isArray(value)) {
    return `[${value.map(canonical).join(',')}]`;
  }
  if (value && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

const invalid = () => failure('LINKS_INVALID', 'Invalid Links request.');
const idPattern = /^[A-Za-z0-9_-]{1,128}$/;
const nameFields = ['name', 'repo', 'sessionId'];

// Exactly the fields a request may carry (plus the dispatcher's own `source`), each a bounded string.
function strictInput(input, required, optional = []) {
  if (!(input && typeof input === 'object' && !Array.isArray(input))) {
    return null;
  }
  const allowed = new Set([...required, ...optional, 'source']);
  if (Object.keys(input).some((key) => !allowed.has(key))) {
    return null;
  }
  for (const key of required) {
    if (typeof input[key] !== 'string' || input[key].length === 0) {
      return null;
    }
  }
  for (const key of optional) {
    if (input[key] !== undefined && typeof input[key] !== 'string') {
      return null;
    }
  }
  return input;
}

const publicMessage = (row) => ({
  attemptId: row.attempt_id ?? null,
  attempts: row.attempts,
  createdAt: row.created_at,
  expiresAt: row.expires_at,
  messageId: row.message_id,
  reason: row.reason ?? null,
  recipient: {
    nativeId: row.recipient.native_id,
    provider: row.recipient.provider,
    sessionId: row.recipient.session_hint,
  },
  redeliveries: row.redeliveries,
  replyTo: row.reply_to ?? null,
  size: row.size,
  state: row.state,
  storedState: row.stored_state,
  updatedAt: row.updated_at,
  ...(row.body === undefined ? {} : { body: row.body }),
});

// What the user reviews before a redelivery: the message, its current unknown attempt and its recipient.
// The token changes with any of them, so a token for an earlier attempt or another conversation is void.
function redeliveryReview(message) {
  const recipient = {
    nativeId: message.recipient.native_id,
    provider: message.recipient.provider,
    sessionId: message.recipient.session_hint,
  };
  const digest = createHash('sha256')
    .update(canonical(message.recipient))
    .digest('hex');
  return {
    attemptId: message.attempt_id,
    attempts: message.attempts,
    messageId: message.message_id,
    recipient,
    token: `redeliver:${message.message_id};attempt:${message.attempt_id};recipient:${digest}`,
  };
}

export function createLinksService({ client, resolveTarget, sessions } = {}) {
  if (
    !(
      client?.call &&
      typeof resolveTarget === 'function' &&
      typeof sessions?.list === 'function'
    )
  ) {
    throw new TypeError(
      'The Links service needs a client, target resolver and sessions'
    );
  }

  // The recipient is only what the managed record says: its verified native conversation, in its checkout.
  function bindingOf(session) {
    if (session.tool !== 'claude-code') {
      return failure(
        'LINKS_PROVIDER_UNVERIFIED',
        'Delivery to this provider is not verified'
      );
    }
    const binding = session.nativeConversation;
    if (
      binding?.state !== 'bound' ||
      binding.provider !== 'claude-code' ||
      !binding.id
    ) {
      return failure(
        'LINKS_NO_NATIVE_BINDING',
        'The session has no verified native conversation'
      );
    }
    return {
      ok: true,
      recipient: {
        checkout: canonical(session.checkoutIdentity),
        native_id: binding.id,
        provider: binding.provider,
        session_hint: session.id,
      },
    };
  }

  // An explicit send or claim tells the engine which conversation the managed record says a session runs
  // now, and the engine persists the hold or restore. Reads never do this.
  async function reconcile(recipient) {
    const outcome = await client.call('reconcile', { recipient });
    return outcome.ok ? { ok: true } : outcome;
  }

  // What a read may compare stored mail against: the verified conversation of a session that is verifiably
  // running, in the checkout as just observed. Anything less is not an observation; the read then shows
  // the stored state and says so. The engine projects the effective state from it and writes nothing.
  function observationOf(session, target) {
    const resolved = bindingOf(session);
    if (
      !(
        resolved.ok &&
        session.state === 'running' &&
        session.ownership === 'owned' &&
        target &&
        target.ok !== false
      )
    ) {
      return null;
    }
    return {
      ...resolved.recipient,
      checkout: canonical(target.checkoutIdentity),
    };
  }

  async function observationById(sessionId) {
    try {
      const listed = await sessions.list();
      const session = listed?.ok
        ? listed.sessions.find((record) => record.id === sessionId)
        : undefined;
      return session
        ? observationOf(
            session,
            await resolveTarget({ name: session.name, repo: session.repo })
          )
        : null;
    } catch {
      return null;
    }
  }

  async function find({ repo, name, sessionId }) {
    const target = await resolveTarget({ name, repo });
    if (!target || target.ok === false) {
      return target?.ok === false
        ? target
        : failure(
            'WORKTREE_NOT_FOUND',
            'No registered worktree matches this request'
          );
    }
    const listed = await sessions.list();
    if (listed?.ok === false) {
      return listed;
    }
    const session = listed?.ok
      ? listed.sessions.find(
          (record) =>
            record.id === sessionId &&
            record.repo === repo &&
            record.name === name
        )
      : null;
    return session
      ? { ok: true, session, target }
      : failure(
          'LINKS_SESSION_NOT_FOUND',
          'No managed session matches this request'
        );
  }

  // The recipient of mail for a session is its verified native conversation. `strict` also requires the
  // session to be running in the checkout it was launched in, as sending and delivery do.
  async function recipientOf(input, { strict }) {
    const found = await find(input);
    if (!found.ok) {
      return found;
    }
    const { session, target } = found;
    if (strict) {
      if (session.state === 'ended') {
        return failure('LINKS_SESSION_ENDED', 'The session has ended');
      }
      if (session.state !== 'running' || session.ownership !== 'owned') {
        return failure(
          'LINKS_SESSION_NOT_RUNNING',
          'The session is not verifiably running'
        );
      }
      if (
        canonical(session.checkoutIdentity) !==
        canonical(target.checkoutIdentity)
      ) {
        return failure(
          'LINKS_CHECKOUT_CHANGED',
          'The session belongs to a replaced checkout'
        );
      }
    }
    return bindingOf(session);
  }

  async function send(raw) {
    const input = strictInput(
      raw,
      [...nameFields, 'body', 'idempotencyKey'],
      ['replyTo']
    );
    if (
      !(
        input &&
        input.idempotencyKey.length <= 128 &&
        (input.replyTo === undefined || input.replyTo.length <= 128)
      )
    ) {
      return invalid();
    }
    const resolved = await recipientOf(input, { strict: true });
    if (!resolved.ok) {
      return resolved;
    }
    // An unconfirmed step names the key, so the caller can repeat the send without duplicating it.
    const withKey = (refusal) =>
      refusal.code === 'LINKS_OUTCOME_UNKNOWN'
        ? { ...refusal, idempotencyKey: input.idempotencyKey }
        : refusal;
    const reported = await reconcile(resolved.recipient);
    if (!reported.ok) {
      return withKey(reported);
    }
    const outcome = await client.call('send', {
      body: input.body,
      idempotency_key: input.idempotencyKey,
      ...(input.replyTo === undefined ? {} : { reply_to: input.replyTo }),
      recipient: resolved.recipient,
      sender: { kind: 'user' },
    });
    return outcome.ok
      ? {
          idempotencyKey: input.idempotencyKey,
          messageId: outcome.result.message_id,
          ok: true,
          replayed: outcome.result.replayed,
          state: outcome.result.state,
        }
      : withKey(outcome);
  }

  async function inbox(raw) {
    const input = strictInput(raw, nameFields, ['state']);
    if (!input) {
      return invalid();
    }
    const found = await find(input);
    if (!found.ok) {
      return found;
    }
    const observed = observationOf(found.session, found.target);
    const outcome = await client.call('list', {
      session_hint: input.sessionId,
      ...(input.state === undefined ? {} : { state: input.state }),
      ...(observed ? { observed } : {}),
    });
    return outcome.ok
      ? {
          messages: outcome.result.messages.map(publicMessage),
          observed: Boolean(observed),
          ok: true,
        }
      : outcome;
  }

  async function read(op, raw) {
    const input = strictInput(raw, ['messageId']);
    if (!(input && idPattern.test(input.messageId))) {
      return invalid();
    }
    const args = { message_id: input.messageId };
    const stored = await client.call(op, args);
    if (!stored.ok) {
      return stored;
    }
    // The stored message says which session to observe; the second read is the same read plus that
    // observation, and falls back to the stored one if it cannot be had.
    const observed = await observationById(
      stored.result.recipient.session_hint
    );
    const looked = observed
      ? await client.call(op, { ...args, observed })
      : null;
    return {
      ok: true,
      ...publicMessage(looked?.ok ? looked.result : stored.result),
      observed: Boolean(looked?.ok),
    };
  }

  async function cancel(raw) {
    const input = strictInput(raw, ['messageId']);
    if (!(input && idPattern.test(input.messageId))) {
      return invalid();
    }
    const outcome = await client.call('cancel', {
      message_id: input.messageId,
      sender: { kind: 'user' },
    });
    return outcome.ok
      ? {
          messageId: outcome.result.message_id,
          ok: true,
          state: outcome.result.state,
        }
      : outcome;
  }

  // Claim and confirm are driven by the provider hook (a later ticket), which supplies the session it
  // authenticated. They have no HTTP route here: an unauthenticated route would let any local caller
  // take another conversation's mail.
  async function claim(raw) {
    const input = strictInput(raw, nameFields);
    if (!input) {
      return invalid();
    }
    const resolved = await recipientOf(input, { strict: true });
    if (!resolved.ok) {
      return resolved;
    }
    const reported = await reconcile(resolved.recipient);
    if (!reported.ok) {
      return reported;
    }
    const outcome = await client.call('claim', {
      recipient: resolved.recipient,
    });
    return outcome.ok
      ? {
          attemptId: outcome.result.attempt_id,
          messages: outcome.result.messages.map((message) => ({
            attempt: message.attempt,
            body: message.body,
            createdAt: message.created_at,
            messageId: message.message_id,
            replyTo: message.reply_to,
          })),
          ok: true,
          text: outcome.result.text,
        }
      : outcome;
  }

  async function confirm(raw) {
    const input = strictInput(raw, [...nameFields, 'attemptId']);
    if (!(input && idPattern.test(input.attemptId))) {
      return invalid();
    }
    const resolved = await recipientOf(input, { strict: false });
    if (!resolved.ok) {
      return resolved;
    }
    const outcome = await client.call('confirm', {
      attempt_id: input.attemptId,
      recipient: resolved.recipient,
    });
    return outcome.ok
      ? {
          confirmed: outcome.result.confirmed,
          ok: true,
          superseded: outcome.result.superseded,
        }
      : outcome;
  }

  async function ack(raw) {
    const input = strictInput(raw, [...nameFields, 'messageId']);
    if (!(input && idPattern.test(input.messageId))) {
      return invalid();
    }
    const resolved = await recipientOf(input, { strict: false });
    if (!resolved.ok) {
      return resolved;
    }
    const outcome = await client.call('acknowledge', {
      message_id: input.messageId,
      recipient: resolved.recipient,
    });
    return outcome.ok
      ? {
          messageId: outcome.result.message_id,
          ok: true,
          state: outcome.result.state,
        }
      : outcome;
  }

  // Redelivery accepts a possible duplicate, so it is the receiving user's choice and never an inference:
  // the first request reviews the exact message, its current unknown attempt and its recipient and returns
  // a token for them; only that exact token, submitted after the user's own confirmation, redelivers. Any
  // other field a caller supplies about itself is not permission.
  async function redeliver(raw) {
    const input = strictInput(
      raw,
      [...nameFields, 'messageId', 'attemptId'],
      ['confirmation']
    );
    if (
      !(
        input &&
        idPattern.test(input.messageId) &&
        idPattern.test(input.attemptId)
      )
    ) {
      return invalid();
    }
    const resolved = await recipientOf(input, { strict: false });
    if (!resolved.ok) {
      return resolved;
    }
    const viewed = await client.call('status', {
      message_id: input.messageId,
      observed: resolved.recipient,
    });
    if (!viewed.ok) {
      return viewed;
    }
    const message = viewed.result;
    // The engine identifies a recipient by provider, native conversation and checkout alone, and the
    // review must too: a different managed record (or an old locator) for the same conversation is still
    // that recipient. Mail from a peer is stored under an opaque address, so the engine answers whether the
    // message is addressed to this conversation (`observed_match`); this module keeps no copy of that rule.
    // The engine is asked to redeliver only after the exact token has been matched.
    const identity = (recipient) =>
      canonical([recipient.provider, recipient.native_id, recipient.checkout]);
    const addressedHere =
      message.observed_match ??
      identity(message.recipient) === identity(resolved.recipient);
    if (!addressedHere) {
      return failure(
        'LINKS_RECIPIENT_MISMATCH',
        'This message is addressed to a different conversation'
      );
    }
    if (message.state !== 'handoff-unknown') {
      return failure(
        'LINKS_INVALID_STATE',
        'Only a message with an unknown handoff can be redelivered'
      );
    }
    if (message.attempt_id !== input.attemptId) {
      return failure(
        'LINKS_ATTEMPT_MISMATCH',
        'That is not the current unknown attempt'
      );
    }
    const confirmation = redeliveryReview(message);
    if (input.confirmation !== confirmation.token) {
      return {
        ...failure(
          'LINKS_CONFIRMATION_REQUIRED',
          'Review this message, attempt and recipient. The earlier handoff may have succeeded, so redelivering can duplicate it. Only the receiving user may confirm; an agent must not.'
        ),
        confirmation,
      };
    }
    const outcome = await client.call('redeliver', {
      attempt_id: input.attemptId,
      message_id: input.messageId,
      recipient: resolved.recipient,
    });
    return outcome.ok
      ? {
          messageId: outcome.result.message_id,
          ok: true,
          state: outcome.result.state,
        }
      : outcome;
  }

  return Object.freeze({
    ack,
    cancel,
    claim,
    confirm,
    inbox,
    redeliver,
    send,
    show: (input) => read('show', input),
    status: (input) => read('status', input),
  });
}
