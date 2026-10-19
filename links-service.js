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

// The checkout text the engine stores and compares, for callers that hold an identity object.
export const canonicalCheckout = canonical;

// The most earlier records one resume names. The record authority (`maxReplacedHistory`) and the engine
// (`MAX_RESUME_FROM`) hold the same bound; this module cannot import either, so the value is stated here.
const MAX_RESUMED_FROM = 8;

// How long the engine may rely on a published snapshot without hearing again. The announcer republishes every
// minute and on each authenticated turn, so three minutes means only that the portal stopped telling it.
export const SNAPSHOT_TTL_MS = 180_000;
// The reasons the managed authority gives for ending a binding, exactly the ones the engine accepts.
const INVALIDATION_REASONS = new Set([
  'ended',
  'ownership-unknown',
  'checkout-changed',
  'replaced',
  'disabled',
]);
// A generation is a whole number the record authority persists; the engine bounds it to what JSON carries exactly.
const isGeneration = (value) =>
  Number.isSafeInteger(value) && value >= 0 && value <= 2 ** 53;

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
    currentSessionId: row.locator,
    nativeId: row.recipient.native_id,
    provider: row.recipient.provider,
    sessionId: row.recipient.session_hint,
  },
  redeliveries: row.redeliveries,
  replyTo: row.reply_to ?? null,
  runHint: row.run_hint ?? null,
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

// ── attention and wake ──────────────────────────────────────────────────────────────────────────────────
// What enabling attention for a project means. It is shown before the person confirms, and the token covers
// it, so what they confirm is what the engine then admits.
const ATTENTION_EFFECT =
  'Sessions in this project may add items to your attention list that name the sending session and carry a short message (at most 1 KiB). An item never wakes an agent, answers a permission request, grants permission or runs work, and it is not delivered to any agent. If you withdraw the share and share the project again, requests from the last 15 minutes that are still retained may notify again once you opt in; older ones never do.';
const ATTENTION_TERMS = Object.freeze({
  effect: ATTENTION_EFFECT,
  limits: { bodyBytes: 1024 },
  never: ['wake', 'permission', 'work', 'agent delivery'],
});
// Wake is unavailable until a mechanism is shown, with evidence, to start a turn in an idle session exactly.
// Until then every caller gets this one answer, whether or not the engine can be reached.
const WAKE_UNAVAILABLE = Object.freeze({
  code: 'LINKS_WAKE_UNAVAILABLE',
  error:
    'Send now is unavailable: no supported mechanism has been shown to start a turn in an idle session. The message stays queued and is handed over at the session’s next normal turn.',
  reason: 'no-verified-mechanism',
});
const MAX_ATTENTION_REQUEST_CHARS = 4096;
const MAX_ATTENTION_PAGE = 100;
// The engine refuses a request larger than this (its protocol bound), so a worktree view that would need more
// to name its sessions is said to be too large, never cut to the first few.
const MAX_ENGINE_REQUEST_BYTES = 1024 * 1024;

// Strict input with a few non-string fields. Anything outside the lists is refused.
function strictFields(
  input,
  { strings = [], optional = [], booleans = [], numbers = [] }
) {
  if (!(input && typeof input === 'object' && !Array.isArray(input))) {
    return null;
  }
  const allowed = new Set([
    ...strings,
    ...optional,
    ...booleans,
    ...numbers,
    'source',
  ]);
  if (Object.keys(input).some((key) => !allowed.has(key))) {
    return null;
  }
  const good =
    strings.every(
      (key) => typeof input[key] === 'string' && input[key].length > 0
    ) &&
    optional.every(
      (key) => input[key] === undefined || typeof input[key] === 'string'
    ) &&
    booleans.every((key) => typeof input[key] === 'boolean') &&
    numbers.every(
      (key) => input[key] === undefined || Number.isSafeInteger(input[key])
    );
  return good ? input : null;
}

const ATTENTION_QUERY_KEYS = new Set([
  'before',
  'limit',
  'name',
  'repo',
  'source',
  'withMessage',
]);
const isNamed = (value) =>
  value === undefined || (typeof value === 'string' && value.length > 0);

// A list request is a few optional, bounded fields and nothing else.
function validAttentionQuery(input) {
  return (
    typeof input === 'object' &&
    !Array.isArray(input) &&
    Object.keys(input).every((key) => ATTENTION_QUERY_KEYS.has(key)) &&
    ['before', 'name', 'repo'].every((key) => isNamed(input[key])) &&
    (input.withMessage === undefined ||
      typeof input.withMessage === 'boolean') &&
    (input.limit === undefined ||
      (Number.isSafeInteger(input.limit) &&
        input.limit >= 1 &&
        input.limit <= MAX_ATTENTION_PAGE))
  );
}

// The worktree an entry belongs under: where its conversation runs now, else where its session was.
function homeOf(where) {
  const home = where.ok ? where.session : where.home;
  return home ? { name: home.name, repo: home.repo } : null;
}

// The sessions a worktree filter names, or null for no filter.
function worktreeSessions(input, records) {
  if (input.repo === undefined && input.name === undefined) {
    return null;
  }
  return records
    .filter(
      (record) =>
        (input.repo === undefined || record.repo === input.repo) &&
        (input.name === undefined || record.name === input.name)
    )
    .map((record) => record.id);
}

const emptyAttention = () => ({
  entries: [],
  hasMore: false,
  next: null,
  notifications: { groups: [], suppressed: 0 },
  ok: true,
});

// One retained request in the shape the existing attention list shows. It has no session id of its own, so
// the session-keyed focus can never be taken for it.
function attentionEntry(item, { group, target, where, withMessage }) {
  return {
    admitted: item.admitted,
    at: item.created_at,
    // Which counted chain this request is in (none when it is older than the window) and whether that chain is
    // shown as notifying; the count is the chain's, present while the chain is among the groups shown.
    group: {
      key: item.group_key,
      notifying: item.notifying,
      ...(group
        ? { count: group.count, countComplete: group.count_complete }
        : {}),
    },
    id: item.attention_id,
    kind: 'links-attention',
    ...(withMessage ? { message: item.body } : {}),
    open: where.ok
      ? { available: true }
      : { available: false, code: where.code, reason: where.error },
    project: item.project,
    provider: item.recipient.provider,
    sender: item.sender,
    session: null,
    source: 'links',
    state: 'links-attention',
    // A request no managed session can be tied to is kept and listed, but has no target to guess at.
    target,
    ...(target ? {} : { unresolved: true }),
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
      resumedFrom: binding.resumedFrom ?? [],
    };
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
    const observed = await observationById(stored.result.locator);
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

  // ── attention ──────────────────────────────────────────────────────────────────────────────────────

  // Turning attention on is the person's reviewed choice; turning it off is immediate. The engine keeps the
  // policy; this only asks for the confirmation and hands the engine what was confirmed.
  async function shareAttention(raw) {
    const input = strictFields(raw, {
      booleans: ['enabled'],
      optional: ['confirmation'],
      strings: ['repo'],
    });
    if (!(input && isRepoName(input.repo))) {
      return invalid();
    }
    if (!input.enabled) {
      const off = await client.call('share_attention', {
        enabled: false,
        project: input.repo,
      });
      return off.ok
        ? {
            changed: off.result.changed,
            ok: true,
            policy: publicPolicy(off.result.policy),
            project: input.repo,
          }
        : off;
    }
    const standing = await client.call('share_status', { project: input.repo });
    if (!standing.ok) {
      return standing;
    }
    const [current] = standing.result.projects;
    if (current.state === 'invalid') {
      return { ...publicStanding(current), ok: false };
    }
    if (current.state !== 'enabled') {
      return failure(
        'LINKS_NOT_SHARED',
        'Share the project first; attention requests are only for a shared project.'
      );
    }
    if (current.policy.attention) {
      return {
        changed: false,
        ok: true,
        policy: publicPolicy(current.policy),
        project: input.repo,
      };
    }
    const digest = createHash('sha256')
      .update(canonical(ATTENTION_TERMS))
      .digest('hex');
    const confirmation = {
      effect: ATTENTION_EFFECT,
      never: [...ATTENTION_TERMS.never],
      project: input.repo,
      token: `attention:${input.repo};scope:${current.policy.scope};terms:${digest}`,
    };
    if (input.confirmation !== confirmation.token) {
      return {
        ...failure(
          'LINKS_CONFIRMATION_REQUIRED',
          'Nothing has changed. Review what attention requests can do; only the user may confirm, and an agent must not.'
        ),
        confirmation,
      };
    }
    const on = await client.call('share_attention', {
      enabled: true,
      project: input.repo,
      // What was reviewed: the engine refuses it if the sharing was withdrawn and made again meanwhile.
      scope: current.policy.scope,
    });
    return on.ok
      ? {
          changed: on.result.changed,
          ok: true,
          policy: publicPolicy(on.result.policy),
          project: input.repo,
        }
      : on;
  }

  // Where an attention item's conversation is now, from the managed records alone: the record whose current
  // verified binding is exactly that conversation in that checkout. A record that replaced it, ended, or sits
  // in another checkout is a reason, never a fallback target.
  async function locate(item, records, targetOf) {
    const { recipient } = item;
    // An ended record keeps the binding it had, and an exact resume binds the same conversation to a new
    // record; the live holder is the one that counts, and an ended one only explains a refusal.
    const holders = records.filter(
      (record) =>
        record.nativeConversation?.state === 'bound' &&
        record.nativeConversation.provider === recipient.provider &&
        record.nativeConversation.id === recipient.native_id
    );
    const holder =
      holders.find((record) => record.state !== 'ended') ?? holders[0];
    const hinted = records.find(
      (record) => record.id === recipient.session_hint
    );
    const home = holder ?? hinted ?? null;
    const refuse = (code, error) => ({ code, error, home, ok: false });
    if (!holder) {
      if (!hinted) {
        return refuse(
          'LINKS_SESSION_NOT_FOUND',
          'No managed session holds this conversation'
        );
      }
      return hinted.state === 'ended'
        ? refuse('LINKS_SESSION_ENDED', 'The session has ended')
        : refuse(
            'LINKS_CONVERSATION_REPLACED',
            'The session now runs a different conversation'
          );
    }
    if (holder.state === 'ended') {
      return refuse('LINKS_SESSION_ENDED', 'The session has ended');
    }
    if (holder.state !== 'running' || holder.ownership !== 'owned') {
      return refuse(
        'LINKS_SESSION_NOT_RUNNING',
        'The session is not verifiably running'
      );
    }
    const target = await targetOf(holder);
    if (
      !target ||
      target.ok === false ||
      canonical(target.checkoutIdentity) !== recipient.checkout ||
      canonical(holder.checkoutIdentity) !== recipient.checkout
    ) {
      return refuse(
        'LINKS_CHECKOUT_CHANGED',
        'The session belongs to a replaced checkout'
      );
    }
    return { home, ok: true, session: holder };
  }

  const targetCache = () => {
    const known = new Map();
    return (record) => {
      const key = `${record.repo}\u0000${record.name}`;
      if (!known.has(key)) {
        known.set(
          key,
          Promise.resolve(
            resolveTarget({ name: record.name, repo: record.repo })
          ).catch(() => null)
        );
      }
      return known.get(key);
    };
  };

  async function managedRecords() {
    const listed = await sessions.list();
    return listed?.ok === true && Array.isArray(listed.sessions)
      ? { ok: true, records: listed.sessions }
      : failure(
          'LINKS_SESSIONS_UNAVAILABLE',
          'The managed sessions could not be read'
        );
  }

  const publicGroup = (group) => ({
    count: group.count,
    countComplete: group.count_complete,
    firstAt: group.first_at,
    itemIds: group.item_ids,
    key: group.group_key,
    lastAt: group.last_at,
    latestId: group.latest_attention_id,
    project: group.project,
    recipientSessionId: group.recipient_session_hint,
    sender: group.sender,
  });

  // The attention list's Links entries, in the shape the existing attention list shows. Passive: it reads
  // the engine and the managed records and writes nothing, so a GET can never notify anyone.
  async function attentionList(raw = {}) {
    const input = raw ?? {};
    if (!validAttentionQuery(input)) {
      return invalid();
    }
    // The message is the person's: a reader that is not the person's own view must ask for it by name.
    const withMessage = input.withMessage === true;
    const managed = await managedRecords();
    if (!managed.ok) {
      return managed;
    }
    // A worktree's view is the requests addressed to the sessions that worktree has had, asked of the engine
    // so a page is that worktree's page; it is not a page of everything filtered afterwards.
    const hints = worktreeSessions(input, managed.records);
    if (hints?.length === 0) {
      return emptyAttention();
    }
    if (
      hints &&
      JSON.stringify(hints).length > MAX_ENGINE_REQUEST_BYTES - 4096
    ) {
      return failure(
        'LINKS_SCOPE_TOO_LARGE',
        'This worktree has had too many sessions to list its requests at once. List them without a worktree (setu attention list), where nothing is left out.'
      );
    }
    const outcome = await client.call('attention_list', {
      limit: input.limit ?? MAX_ATTENTION_PAGE,
      ...(input.before === undefined ? {} : { before_id: input.before }),
      ...(hints ? { session_hints: hints } : {}),
    });
    if (!outcome.ok) {
      return outcome;
    }
    const targetOf = targetCache();
    const byKey = new Map(
      outcome.result.notifications.groups.map((group) => [
        group.group_key,
        group,
      ])
    );
    const entries = [];
    for (const item of outcome.result.items) {
      // biome-ignore lint/performance/noAwaitInLoops: Each entry resolves its target with a per-read cache.
      const where = await locate(item, managed.records, targetOf);
      entries.push(
        attentionEntry(item, {
          group: byKey.get(item.group_key),
          target: homeOf(where),
          where,
          withMessage,
        })
      );
    }
    return {
      entries,
      hasMore: outcome.result.has_more,
      next: outcome.result.next_before,
      notifications: {
        groups: outcome.result.notifications.groups.map(publicGroup),
        suppressed: outcome.result.notifications.suppressed,
      },
      ok: true,
      // A worktree with more sessions than one read can name is shown for the newest-listed ones only.
    };
  }

  // The focus request for one item, only if its exact conversation is the one a managed session runs now.
  // The caller still hands it to the existing focus action, which verifies again at the effect.
  async function attentionTarget(raw) {
    const input = strictInput(raw, ['attentionId']);
    if (!(input && idPattern.test(input.attentionId))) {
      return invalid();
    }
    const shown = await client.call('attention_show', {
      attention_id: input.attentionId,
    });
    if (!shown.ok) {
      return shown;
    }
    const managed = await managedRecords();
    if (!managed.ok) {
      return managed;
    }
    const where = await locate(shown.result, managed.records, targetCache());
    if (!where.ok) {
      return failure(where.code, where.error);
    }
    const { session } = where;
    return {
      focus: {
        checkoutIdentity: session.checkoutIdentity,
        expectConversation: {
          nativeId: shown.result.recipient.native_id,
          provider: shown.result.recipient.provider,
        },
        name: session.name,
        repo: session.repo,
        sessionId: session.id,
      },
      ok: true,
    };
  }

  // The ingress the session tools will call after they authenticate the caller. It has no route, tool or
  // command: it trusts the caller identity it is given, so nothing unauthenticated may reach it.
  async function attentionSendExact(raw) {
    const input = raw;
    const caller = input?.caller;
    if (
      !(
        input &&
        typeof input === 'object' &&
        Object.keys(input).sort().join() === 'body,caller,idempotencyKey,to' &&
        typeof input.body === 'string' &&
        input.body.length > 0 &&
        typeof input.idempotencyKey === 'string' &&
        input.idempotencyKey.length > 0 &&
        input.idempotencyKey.length <= 128 &&
        typeof input.to === 'string' &&
        idPattern.test(input.to) &&
        caller &&
        typeof caller === 'object' &&
        Object.keys(caller).join() === 'sessionId' &&
        typeof caller.sessionId === 'string' &&
        idPattern.test(caller.sessionId)
      )
    ) {
      return invalid();
    }
    if (input.body.length > MAX_ATTENTION_REQUEST_CHARS) {
      return failure(
        'LINKS_ATTENTION_TOO_LARGE',
        'An attention request is a short note'
      );
    }
    const managed = await managedRecords();
    if (!managed.ok) {
      return managed;
    }
    const from = managed.records.find(
      (record) => record.id === caller.sessionId
    );
    const to = managed.records.find((record) => record.id === input.to);
    if (!(from && to)) {
      return failure(
        'LINKS_SESSION_NOT_FOUND',
        'No managed session matches this request'
      );
    }
    const resolved = await recipientOf(
      { name: to.name, repo: to.repo, sessionId: to.id },
      { strict: true }
    );
    if (!resolved.ok) {
      return resolved;
    }
    if (from.repo !== to.repo) {
      return failure(
        'LINKS_PROJECT_MISMATCH',
        'Attention requests stay inside one shared project'
      );
    }
    const outcome = await client.call('attention_send', {
      body: input.body,
      idempotency_key: input.idempotencyKey,
      project: to.repo,
      recipient: resolved.recipient,
      sender: { id: caller.sessionId, kind: 'session' },
    });
    if (outcome.ok) {
      return {
        attentionId: outcome.result.attention_id,
        ok: true,
        replayed: outcome.result.replayed,
      };
    }
    return outcome.code === 'LINKS_OUTCOME_UNKNOWN'
      ? { ...outcome, idempotencyKey: input.idempotencyKey }
      : outcome;
  }

  // ── Send now ───────────────────────────────────────────────────────────────────────────────────────
  // The receiving user's choice, as the engine's gate sees it. The principal is never taken from the caller:
  // this service is the local user's front door, and nothing here can name another principal.
  async function sendNow(raw) {
    const input = strictInput(raw, [...nameFields, 'messageId']);
    if (!(input && idPattern.test(input.messageId))) {
      return invalid();
    }
    const outcome = await client.call('wake', {
      message_id: input.messageId,
      principal: { kind: 'user' },
    });
    // Whatever the engine said (including nothing at all), no wake happened and none is possible now.
    return outcome.code === 'LINKS_WAKE_NOT_AUTHORIZED'
      ? outcome
      : { ...WAKE_UNAVAILABLE, ok: false };
  }

  function capabilities() {
    return {
      attention: { notification: 'in-app' },
      ok: true,
      wake: {
        available: false,
        code: WAKE_UNAVAILABLE.code,
        error: WAKE_UNAVAILABLE.error,
        reason: WAKE_UNAVAILABLE.reason,
      },
    };
  }

  // Operations for the authenticated provider hook only. The caller has already proved which exact
  // conversation it speaks for and passes that tuple; nothing here looks a session up by its ID, so a
  // conversation bound after authentication can neither receive nor confirm this one's mail. They have no
  // route, tool or command: an unauthenticated entry would let any local caller take another's mail.
  function exactRecipient(raw) {
    const resumedFrom = raw?.resumedFrom ?? [];
    if (
      !(
        raw &&
        typeof raw === 'object' &&
        raw.provider === 'claude-code' &&
        typeof raw.nativeId === 'string' &&
        raw.nativeId.length > 0 &&
        typeof raw.sessionId === 'string' &&
        idPattern.test(raw.sessionId) &&
        raw.checkoutIdentity !== undefined &&
        Array.isArray(resumedFrom) &&
        resumedFrom.length <= MAX_RESUMED_FROM &&
        resumedFrom.every((id) => typeof id === 'string' && idPattern.test(id))
      )
    ) {
      return null;
    }
    return {
      recipient: {
        checkout: canonical(raw.checkoutIdentity),
        native_id: raw.nativeId,
        provider: raw.provider,
        session_hint: raw.sessionId,
      },
      resumedFrom,
    };
  }

  // The hook's claim is fenced by the generation the managed authority gave it when it authenticated. The engine
  // checks that generation against the session's published snapshot inside the claim's own transaction, before
  // anything is expired, held or attempted. A snapshot that is absent, lapsed, invalid, for another conversation
  // or at another generation refuses the claim and leaves every message and attempt exactly as they were: the
  // mail stays queued, and nothing here falls back to a claim that is not fenced.
  async function claimExact(raw) {
    const exact = exactRecipient(raw?.recipient);
    if (!(exact && isGeneration(raw.expectedGeneration))) {
      return invalid();
    }
    const outcome = await client.call('claim', {
      expected_generation: raw.expectedGeneration,
      recipient: exact.recipient,
    });
    return outcome.ok
      ? {
          attemptId: outcome.result.attempt_id,
          messages: outcome.result.messages.map((message) => ({
            messageId: message.message_id,
          })),
          ok: true,
          text: outcome.result.text,
        }
      : outcome;
  }

  // The lifecycle seam. The managed session record is the only authority for a binding and its generation; these
  // two operations are how it tells the engine, and they are the only way a snapshot is ever written. They have
  // no route, tool or command, and the generation is never in anything a caller can read. Neither creates a
  // mailbox. With none yet there is nothing durable to write, and each then says so in the one way a publisher
  // understands (not told): a publish is tried again on the next turn, and an invalidation is tried again until a
  // mailbox exists and the fence really lands.
  async function publishBinding(raw) {
    const exact = exactRecipient(
      raw?.recipient && { ...raw.recipient, resumedFrom: raw.resumedFrom }
    );
    if (
      !(
        exact &&
        isGeneration(raw.generation) &&
        typeof raw.project === 'string' &&
        raw.project.length > 0 &&
        raw.project.length <= 128
      )
    ) {
      return invalid();
    }
    const outcome = await client.call('binding_publish', {
      existing_store_only: true,
      generation: raw.generation,
      project: raw.project,
      recipient: exact.recipient,
      ...(exact.resumedFrom.length === 0
        ? {}
        : { resumed_from: exact.resumedFrom }),
      valid_for_ms: SNAPSHOT_TTL_MS,
    });
    if (!outcome.ok) {
      return outcome;
    }
    return outcome.result.stored
      ? { ok: true }
      : failure('LINKS_STORE_ABSENT', 'No mailbox exists to publish into yet.');
  }

  async function invalidateBinding(raw) {
    if (
      !(
        raw &&
        typeof raw.sessionId === 'string' &&
        idPattern.test(raw.sessionId) &&
        isGeneration(raw.generation) &&
        INVALIDATION_REASONS.has(raw.reason)
      )
    ) {
      return invalid();
    }
    const outcome = await client.call('binding_invalidate', {
      existing_store_only: true,
      generation: raw.generation,
      reason: raw.reason,
      session_hint: raw.sessionId,
    });
    if (!outcome.ok) {
      return outcome;
    }
    // With no mailbox there is no durable fence, so this is not told: the publisher tries again until a mailbox
    // exists and the fence has really landed. The runtime starts no publication either while the mailbox file is
    // absent, so none can be held up outside the engine across the first send (links-lifecycle-race.test.js races
    // real engine processes to show it).
    return outcome.result.stored
      ? { ok: true }
      : failure('LINKS_STORE_ABSENT', 'No mailbox exists to fence yet.');
  }

  async function confirmExact(raw) {
    const exact = exactRecipient(raw?.recipient);
    if (
      !(
        exact &&
        typeof raw.attemptId === 'string' &&
        idPattern.test(raw.attemptId)
      )
    ) {
      return invalid();
    }
    const outcome = await client.call('confirm', {
      attempt_id: raw.attemptId,
      recipient: exact.recipient,
    });
    return outcome.ok
      ? {
          confirmed: outcome.result.confirmed,
          ok: true,
          superseded: outcome.result.superseded,
        }
      : outcome;
  }

  return Object.freeze({
    ack,
    attentionList,
    attentionSendExact,
    attentionTarget,
    cancel,
    capabilities,
    claimExact,
    confirmExact,
    directory,
    inbox,
    invalidateBinding,
    publishBinding,
    publishPresence,
    redeliver,
    send,
    sendNow,
    shareAttention,
    shareDisable,
    shareEnable,
    shareStatus,
    show: (input) => read('show', input),
    status: (input) => read('status', input),
    withdrawSharing,
  });
}
