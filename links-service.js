// The one Links service every front door calls. Local identity stays with the managed session service:
// this module reads a session's verified native conversation binding and hands the engine a recipient.
// The engine, not this module, keeps every message and every delivery state.

import { createHash } from 'node:crypto';
import { isSafeLabel, MAX_LABEL_CHARS, screenLabel } from './links-labels.js';
import { isRepositoryName } from './workspace-state.js';

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

// What a shared project publishes, field by field, exactly as a directory entry carries it. The review shows
// this list and the token covers it, so what the user confirms is what the engine's directory returns.
const SHARED_FIELDS = Object.freeze([
  {
    field: 'owner',
    keys: ['owner'],
    meaning:
      'The owner label shown here (your account name unless you pass another with --owner), shown for every shared session',
  },
  {
    field: 'task',
    keys: ['task'],
    meaning: `A short label (at most ${MAX_LABEL_CHARS} characters) taken from the task text the session wrote in its worktree's writer claim, with file paths, environment references and recognizable secrets replaced by markers and dropped entirely if nothing useful is left; empty when the session has none`,
  },
  {
    field: 'reachability',
    keys: ['reachability'],
    meaning:
      'Whether the session can receive messages now, and if not, a fixed reason such as not-running or no-native-binding',
  },
  {
    field: 'freshness',
    keys: ['observedAt', 'taskAt', 'taskStale', 'activityAt', 'stale'],
    meaning:
      'When Setu last observed the session and whether that is stale; when the session last refreshed the claim its task came from, and whether that is old; and when its last trusted managed-session hook event arrived (unknown when none has)',
  },
  {
    field: 'session',
    keys: ['sessionId'],
    meaning:
      'The managed session ID that a message is addressed with; not a path, process or conversation ID',
  },
]);
const NEVER_SHARED = Object.freeze([
  'transcripts',
  'paths',
  'environment',
  'provider context',
]);
// Visibility and receiving are what this version grants. Interrupting an agent and raising attention are
// separate permissions and stay off; so does everything about waking.
const PERMISSIONS = Object.freeze({
  attention: false,
  interrupt: false,
  receive: true,
  visibility: true,
});
const CONTROL_CHARACTER = /\p{Cc}/gu;
const WHITESPACE_RUN = /\s+/u;
const MAX_OWNER_CHARS = 64;
// The engine stores a project name in at most this many bytes.
const MAX_PROJECT_BYTES = 128;
// A session that ended longer ago than the engine keeps presence for is history, not presence.
const PRESENCE_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
// One engine call takes at most this many sessions (the engine enforces it); more go in further calls.
const PUBLISH_BATCH = 256;
const POLICY_RECOVERY =
  'Run `setu links share disable <repo>` to clear the policy, then enable sharing again.';

// The owner label is one printable line, exactly as the engine stores it.
function isOwnerLabel(owner) {
  const flat = owner
    .replace(CONTROL_CHARACTER, ' ')
    .split(WHITESPACE_RUN)
    .filter(Boolean)
    .join(' ');
  return (
    flat === owner && owner.length > 0 && [...owner].length <= MAX_OWNER_CHARS
  );
}

// A project is named by the registry's own rule, so every registered project can be shared and withdrawn.
// The engine keeps a name only as one printable line, so a name with any control character (the registry
// allows DEL and the C1 range) is left out here and never reaches it.
const isRepoName = (repo) =>
  isRepositoryName(repo) &&
  Buffer.byteLength(repo) <= MAX_PROJECT_BYTES &&
  repo.replace(CONTROL_CHARACTER, '') === repo;

const publicPolicy = (policy) => ({
  attention: policy.attention,
  interrupt: policy.interrupt,
  owner: policy.owner,
  receive: policy.receive,
  visibility: policy.visibility,
});

function publicStanding(standing) {
  if (standing.state === 'enabled') {
    return {
      policy: publicPolicy(standing.policy),
      project: standing.project,
      shared: true,
      state: 'enabled',
      updatedAt: standing.updated_at,
    };
  }
  if (standing.state === 'invalid') {
    return {
      code: 'LINKS_POLICY_INVALID',
      error:
        'The sharing policy for this project cannot be read, so nothing from other sessions is delivered to it.',
      project: standing.project,
      reason: standing.error.reason,
      recovery: POLICY_RECOVERY,
      shared: false,
      state: 'invalid',
    };
  }
  return { project: standing.project, shared: false, state: 'disabled' };
}

const publicEntry = (entry) => ({
  activityAt: entry.activity_at,
  observedAt: entry.observed_at,
  owner: entry.owner,
  project: entry.project,
  reachability: {
    reason: entry.reachability.reason,
    state: entry.reachability.state,
  },
  sessionId: entry.session_id,
  stale: entry.stale,
  task: entry.task,
  taskAt: entry.task_at,
  taskStale: entry.task_stale,
});

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
  sender: { ...row.sender },
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

export function createLinksService({
  client,
  defaultOwner = () => undefined,
  isProject = () => false,
  resolveTarget,
  sessions,
  // (record) => { at, text } | null: the task the session wrote and when it last refreshed it.
  taskLabel = () => null,
} = {}) {
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
      project: input.repo,
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
    const viewed = await client.call('status', { message_id: input.messageId });
    if (!viewed.ok) {
      return viewed;
    }
    const message = viewed.result;
    // The engine identifies a recipient by provider, native conversation and checkout alone, and the
    // review must too: a different managed record (or an old locator) for the same conversation is still
    // that recipient. The engine is asked to redeliver only after the exact token has been matched.
    const identity = (recipient) =>
      canonical([recipient.provider, recipient.native_id, recipient.checkout]);
    if (identity(message.recipient) !== identity(resolved.recipient)) {
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

  // ── sharing ────────────────────────────────────────────────────────────────────────────────────────
  // The engine keeps the policy and the presence. This service only reads the managed records, asks the
  // user's confirmation to be returned as a token, and hands the engine what it observed.

  // What the user reviews before sharing: the project, the owner label and every public field. The token
  // changes with any of them, so a confirmation for other terms is void.
  function shareReview(repo, owner) {
    const terms = {
      fields: SHARED_FIELDS,
      never: NEVER_SHARED,
      permissions: PERMISSIONS,
    };
    const digest = createHash('sha256').update(canonical(terms)).digest('hex');
    return {
      fields: SHARED_FIELDS.map((entry) => ({
        ...entry,
        keys: [...entry.keys],
      })),
      never: [...NEVER_SHARED],
      owner,
      permissions: { ...PERMISSIONS },
      project: repo,
      token: `share:${repo};owner:${owner};terms:${digest}`,
    };
  }

  async function shareEnable(raw) {
    const input = strictInput(raw, ['repo'], ['owner', 'confirmation']);
    const owner = input?.owner ?? defaultOwner();
    if (
      !(
        input &&
        isRepoName(input.repo) &&
        typeof owner === 'string' &&
        isOwnerLabel(owner)
      )
    ) {
      return invalid();
    }
    if (!isSafeLabel(owner)) {
      return failure(
        'LINKS_UNSAFE_LABEL',
        'The owner label is shown to everyone the project is shared with, so it cannot contain a path, an environment reference or a secret. Choose a short name.'
      );
    }
    if (!isProject(input.repo)) {
      return failure(
        'LINKS_PROJECT_NOT_FOUND',
        'No registered Setu project has this name'
      );
    }
    const review = shareReview(input.repo, owner);
    if (input.confirmation !== review.token) {
      return {
        ...failure(
          'LINKS_CONFIRMATION_REQUIRED',
          'Nothing has been shared. Review the fields below; only the user may confirm, and an agent must not.'
        ),
        confirmation: review,
      };
    }
    const outcome = await client.call('share_enable', {
      owner,
      project: input.repo,
    });
    if (!outcome.ok) {
      return outcome;
    }
    // The directory is filled by presence rounds; the first one does not wait for the next interval.
    const presence = await publishPresence();
    return {
      changed: outcome.result.changed,
      ok: true,
      policy: publicPolicy(outcome.result.policy),
      presence: presence.ok
        ? { published: presence.published }
        : { code: presence.code },
      project: input.repo,
    };
  }

  async function shareDisable(raw) {
    const input = strictInput(raw, ['repo']);
    if (!(input && isRepoName(input.repo))) {
      return invalid();
    }
    const outcome = await client.call('share_disable', {
      project: input.repo,
    });
    return outcome.ok
      ? {
          held: outcome.result.held.length,
          ok: true,
          project: input.repo,
          removed: outcome.result.removed,
        }
      : outcome;
  }

  // Part of removing a project: its sharing ends before the name leaves the registry. A name the registry
  // cannot hold has no sharing to end.
  function withdrawSharing(name) {
    return isRepoName(name)
      ? shareDisable({ repo: name })
      : Promise.resolve({ ok: true, removed: false });
  }

  async function shareStatus(raw) {
    const input = strictInput(raw, [], ['repo']);
    if (!(input && (input.repo === undefined || isRepoName(input.repo)))) {
      return invalid();
    }
    const outcome = await client.call('share_status', {
      ...(input.repo === undefined ? {} : { project: input.repo }),
    });
    if (!outcome.ok) {
      return outcome;
    }
    const standings = outcome.result.projects.map((standing) => ({
      ...publicStanding(standing),
      // A policy for a name the registry no longer holds is reported, but publishes and lists nothing.
      registered: Boolean(isProject(standing.project)),
    }));
    if (input.repo === undefined) {
      return { ok: true, projects: standings };
    }
    const [only] = standings;
    return only.state === 'invalid'
      ? { ...only, ok: false }
      : { ...only, ok: true };
  }

  async function directory(raw) {
    const input = strictInput(raw, [], ['repo']);
    if (!(input && (input.repo === undefined || isRepoName(input.repo)))) {
      return invalid();
    }
    const outcome = await client.call('directory', {
      ...(input.repo === undefined ? {} : { project: input.repo }),
    });
    if (!outcome.ok) {
      return outcome;
    }
    // Only registered projects are listed, whatever the engine still holds for a name that was removed.
    const registered = new Map();
    const isRegistered = (project) => {
      if (!registered.has(project)) {
        registered.set(project, Boolean(isProject(project)));
      }
      return registered.get(project);
    };
    return {
      entries: outcome.result.entries
        .filter((entry) => isRegistered(entry.project))
        .map(publicEntry),
      ok: true,
      problems: outcome.result.problems
        .filter((problem) => isRegistered(problem.project))
        .map((problem) => ({
          code: 'LINKS_POLICY_INVALID',
          project: problem.project,
          reason: problem.reason,
          recovery: POLICY_RECOVERY,
        })),
      staleAfterMs: outcome.result.stale_after_ms,
    };
  }

  // Why a managed session can or cannot receive mail now, from the same evidence a send uses. The reason
  // comes from a fixed vocabulary; presence never carries free text about the session.
  function reachabilityOf(record, target) {
    if (record.state === 'ended') {
      return { reason: 'ended', state: 'unreachable' };
    }
    if (record.state !== 'running' || record.ownership !== 'owned') {
      return { reason: 'not-running', state: 'unreachable' };
    }
    const binding = bindingOf(record);
    if (!binding.ok) {
      return {
        reason:
          binding.code === 'LINKS_PROVIDER_UNVERIFIED'
            ? 'provider-unverified'
            : 'no-native-binding',
        state: 'unreachable',
      };
    }
    return target &&
      target.ok !== false &&
      canonical(record.checkoutIdentity) === canonical(target.checkoutIdentity)
      ? { state: 'reachable' }
      : { reason: 'checkout-changed', state: 'unreachable' };
  }

  // A time the service can vouch for: a whole number of milliseconds that is not in the future.
  const trustedTime = (value) =>
    Number.isSafeInteger(value) && value > 0 && value <= Date.now()
      ? value
      : null;

  async function observe(record) {
    if (record.state === 'ended') {
      // An end needs no checkout or claim, and there is no current task to show.
      return {
        ...(trustedTime(record.lastHookAt) === null
          ? {}
          : { activity_at: record.lastHookAt }),
        reachability: { reason: 'ended', state: 'unreachable' },
        session_id: record.id,
      };
    }
    let target = null;
    try {
      target = await resolveTarget({ name: record.name, repo: record.repo });
    } catch {
      // An unreadable checkout is reported as changed, never as reachable.
    }
    let claimed = null;
    try {
      claimed = taskLabel(record) ?? null;
    } catch {
      // A task is optional; its absence is not an error.
    }
    const task = screenLabel(claimed?.text);
    const taskAt = task === null ? null : trustedTime(claimed.at);
    return {
      // Only a trusted hook event is activity; polling and process liveness are not.
      ...(trustedTime(record.lastHookAt) === null
        ? {}
        : { activity_at: record.lastHookAt }),
      reachability: reachabilityOf(record, target),
      session_id: record.id,
      task,
      ...(taskAt === null ? {} : { task_at: taskAt }),
    };
  }

  // The managed sessions a round reports for one project: those still alive, and those that ended recently
  // enough for the end itself to be worth showing.
  const publishable = (record, project) =>
    record.repo === project &&
    ['owned', 'unknown'].includes(record.ownership) &&
    (record.state !== 'ended' ||
      (Number.isSafeInteger(record.endedAt) &&
        Date.now() - record.endedAt < PRESENCE_RETENTION_MS));

  // One presence round. It writes only for registered projects the engine says are shared, from the managed
  // records and the engine's own policy, and does nothing at all when nothing is shared. Reads never call it.
  async function publishPresence() {
    const standing = await client.call('share_status', {});
    if (!standing.ok) {
      return standing;
    }
    const shared = standing.result.projects.filter(
      (entry) =>
        entry.state === 'enabled' &&
        entry.policy.visibility &&
        isProject(entry.project)
    );
    if (shared.length === 0) {
      return { ok: true, published: 0 };
    }
    const listed = await sessions.list();
    if (!(listed?.ok && Array.isArray(listed.sessions))) {
      return listed?.ok === false
        ? listed
        : failure(
            'LINKS_SESSIONS_UNAVAILABLE',
            'The managed sessions could not be read'
          );
    }
    let published = 0;
    let failed = null;
    for (const { project } of shared) {
      // biome-ignore lint/performance/noAwaitInLoops: Projects are published one after another.
      const outcome = await publishProject(project, listed.sessions);
      published += outcome.published;
      failed ??= outcome.failed;
    }
    return failed ?? { ok: true, published };
  }

  // One project's sessions, in batches the engine accepts, so none is silently left out.
  async function publishProject(project, records) {
    const observed = await Promise.all(
      records.filter((record) => publishable(record, project)).map(observe)
    );
    let published = 0;
    let failed = null;
    for (let start = 0; start < observed.length; start += PUBLISH_BATCH) {
      // biome-ignore lint/performance/noAwaitInLoops: Batches are published one after another.
      const outcome = await client.call('presence_publish', {
        project,
        sessions: observed.slice(start, start + PUBLISH_BATCH),
      });
      if (outcome.ok) {
        published += outcome.result.published;
      } else {
        failed ??= outcome;
      }
    }
    return { failed, published };
  }

  return Object.freeze({
    ack,
    cancel,
    claim,
    confirm,
    directory,
    inbox,
    publishPresence,
    redeliver,
    send,
    shareDisable,
    shareEnable,
    shareStatus,
    show: (input) => read('show', input),
    status: (input) => read('status', input),
    withdrawSharing,
  });
}
