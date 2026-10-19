import { readJson } from './use-visible-poll';

type RecordValue = Record<string, unknown>;
const record = (value: unknown): value is RecordValue =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const text = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0;
const time = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

export interface LinksTarget {
  name: string;
  repo: string;
  sessionId: string;
}

// A managed-session record carries display and delivery metadata. Links mutations carry only its address.
export function linksTarget({
  name,
  repo,
  sessionId,
}: LinksTarget): LinksTarget {
  return { name, repo, sessionId };
}

export interface ManagedSession extends LinksTarget {
  lastHookAt?: number;
  nativeConversation: { provider: string; reason?: string; state: string };
  ownership: string;
  state: string;
  tool: string;
}

export interface LinksMessage {
  attemptId: string | null;
  attempts: number;
  body?: string;
  createdAt: number;
  expiresAt: number;
  messageId: string;
  reason: string | null;
  recipient: { provider: string; sessionId: string };
  redeliveries: number;
  replyTo: string | null;
  runHint: string | null;
  sender: { id?: string; kind: string };
  size: number;
  state: string;
  storedState: string;
  updatedAt: number;
}

export interface DirectoryEntry {
  activityAt?: number;
  observedAt: number;
  owner: string;
  project: string;
  reachability: { reason?: string; state: string };
  sessionId: string;
  stale: boolean;
  task: string | null;
  taskAt: number | null;
  taskStale: boolean;
}

export interface LinksFailure {
  code: string;
  error: string;
  ok: false;
}
export type LinksResult<T> = ({ ok: true } & T) | LinksFailure;

type LinksSuccess = RecordValue & { ok: true };
function outcome(value: unknown): LinksSuccess | LinksFailure {
  if (!record(value) || typeof value.ok !== 'boolean') {
    throw new Error('Links returned an unusable response.');
  }
  if (value.ok === false) {
    if (!(text(value.code) && text(value.error))) {
      throw new Error('Links returned an unusable response.');
    }
    return { code: value.code, error: value.error, ok: false };
  }
  return value as LinksSuccess;
}

function parseTarget(value: unknown): LinksTarget | null {
  return record(value) && text(value.name) && text(value.repo) && text(value.id)
    ? { name: value.name, repo: value.repo, sessionId: value.id }
    : null;
}

function session(value: unknown): ManagedSession | null {
  const source = record(value) ? value : null;
  const base = parseTarget(source);
  const native =
    source && record(source.nativeConversation)
      ? source.nativeConversation
      : null;
  if (
    !(
      base &&
      native &&
      text(native.provider) &&
      text(native.state) &&
      source &&
      text(source.ownership) &&
      text(source.state) &&
      text(source.tool)
    )
  ) {
    return null;
  }
  return {
    ...base,
    ...(time(source.lastHookAt) ? { lastHookAt: source.lastHookAt } : {}),
    nativeConversation: {
      provider: native.provider,
      ...(text(native.reason) ? { reason: native.reason } : {}),
      state: native.state,
    },
    ownership: source.ownership,
    state: source.state,
    tool: source.tool,
  };
}

function message(value: unknown, body = false): LinksMessage | null {
  if (!(record(value) && record(value.recipient) && record(value.sender))) {
    return null;
  }
  const { recipient, sender } = value;
  if (
    !(
      text(value.messageId) &&
      text(value.state) &&
      text(value.storedState) &&
      text(recipient.provider) &&
      text(recipient.sessionId) &&
      text(sender.kind) &&
      time(value.createdAt) &&
      time(value.updatedAt) &&
      time(value.expiresAt) &&
      Number.isSafeInteger(value.attempts) &&
      Number.isSafeInteger(value.redeliveries) &&
      Number.isSafeInteger(value.size) &&
      (value.attemptId === null || text(value.attemptId)) &&
      (value.replyTo === null || text(value.replyTo)) &&
      (value.reason === null || text(value.reason)) &&
      (value.runHint === undefined ||
        value.runHint === null ||
        text(value.runHint)) &&
      (!body || typeof value.body === 'string')
    )
  ) {
    return null;
  }
  return {
    attemptId: value.attemptId,
    attempts: value.attempts as number,
    ...(body ? { body: value.body as string } : {}),
    createdAt: value.createdAt,
    expiresAt: value.expiresAt,
    messageId: value.messageId,
    reason: value.reason,
    recipient: { provider: recipient.provider, sessionId: recipient.sessionId },
    redeliveries: value.redeliveries as number,
    replyTo: value.replyTo,
    runHint: text(value.runHint) ? value.runHint : null,
    sender: {
      ...(text(sender.id) ? { id: sender.id } : {}),
      kind: sender.kind,
    },
    size: value.size as number,
    state: value.state,
    storedState: value.storedState,
    updatedAt: value.updatedAt,
  };
}

function directoryEntry(value: unknown): DirectoryEntry | null {
  if (!(record(value) && record(value.reachability))) {
    return null;
  }
  const { reachability } = value;
  if (
    !(
      text(value.owner) &&
      text(value.project) &&
      text(value.sessionId) &&
      text(reachability.state) &&
      time(value.observedAt) &&
      typeof value.stale === 'boolean' &&
      typeof value.taskStale === 'boolean' &&
      (value.task === null || text(value.task)) &&
      (value.taskAt === null || time(value.taskAt))
    )
  ) {
    return null;
  }
  return {
    ...(time(value.activityAt) ? { activityAt: value.activityAt } : {}),
    observedAt: value.observedAt,
    owner: value.owner,
    project: value.project,
    reachability: {
      ...(text(reachability.reason) ? { reason: reachability.reason } : {}),
      state: reachability.state,
    },
    sessionId: value.sessionId,
    stale: value.stale,
    task: value.task,
    taskAt: value.taskAt,
    taskStale: value.taskStale,
  };
}

async function read(path: string, signal: AbortSignal) {
  return outcome(await readJson<unknown>(path, signal));
}

export async function readManagedSessions(
  signal: AbortSignal
): Promise<LinksResult<{ sessions: ManagedSession[] }>> {
  const value = await read('/api/agent-sessions', signal);
  if (!value.ok) {
    return value;
  }
  if (!Array.isArray(value.sessions)) {
    throw new Error('Managed sessions are unavailable.');
  }
  const sessions = value.sessions.map(session);
  if (sessions.some((entry) => entry === null)) {
    throw new Error('Managed sessions are unavailable.');
  }
  return { ok: true, sessions: sessions as ManagedSession[] };
}

export async function readDirectory(signal: AbortSignal): Promise<
  LinksResult<{
    entries: DirectoryEntry[];
    problems: { project: string; reason: string }[];
    staleAfterMs: number;
  }>
> {
  const value = await read('/api/links/directory', signal);
  if (!value.ok) {
    return value;
  }
  if (
    !(
      Array.isArray(value.entries) &&
      Array.isArray(value.problems) &&
      time(value.staleAfterMs)
    )
  ) {
    throw new Error('Links directory is unavailable.');
  }
  const entries = value.entries.map(directoryEntry);
  if (
    entries.some((entry) => entry === null) ||
    !value.problems.every(
      (problem) =>
        record(problem) && text(problem.project) && text(problem.reason)
    )
  ) {
    throw new Error('Links directory is unavailable.');
  }
  return {
    entries: entries as DirectoryEntry[],
    ok: true,
    problems: value.problems as { project: string; reason: string }[],
    staleAfterMs: value.staleAfterMs,
  };
}

export async function readInbox(
  recipientTarget: LinksTarget,
  signal: AbortSignal
): Promise<LinksResult<{ messages: LinksMessage[] }>> {
  const value = await read(
    `/api/links/inbox?${new URLSearchParams({ name: recipientTarget.name, repo: recipientTarget.repo, sessionId: recipientTarget.sessionId })}`,
    signal
  );
  if (!value.ok) {
    return value;
  }
  if (!Array.isArray(value.messages)) {
    throw new Error('Links inbox is unavailable.');
  }
  const messages = value.messages.map((entry) => message(entry));
  if (messages.some((entry) => entry === null)) {
    throw new Error('Links inbox is unavailable.');
  }
  return { messages: messages as LinksMessage[], ok: true };
}

export async function readMessage(
  messageId: string,
  signal: AbortSignal
): Promise<LinksResult<{ message: LinksMessage }>> {
  const value = await read(
    `/api/links/message?${new URLSearchParams({ messageId })}`,
    signal
  );
  if (!value.ok) {
    return value;
  }
  const parsed = message(value, true);
  if (!(parsed && parsed.messageId === messageId)) {
    throw new Error('This Links message is unavailable.');
  }
  return { message: parsed, ok: true };
}

export async function readCapabilities(signal: AbortSignal): Promise<
  LinksResult<{
    wake: { available: boolean; code: string; error: string; reason: string };
  }>
> {
  const value = await read('/api/links/capabilities', signal);
  if (!value.ok) {
    return value;
  }
  if (
    !(
      record(value.wake) &&
      typeof value.wake.available === 'boolean' &&
      text(value.wake.code) &&
      text(value.wake.error) &&
      text(value.wake.reason)
    )
  ) {
    throw new Error('Links capabilities are unavailable.');
  }
  return {
    ok: true,
    wake: value.wake as {
      available: boolean;
      code: string;
      error: string;
      reason: string;
    },
  };
}

export interface ShareStatus {
  attention: boolean;
  owner: string;
  project: string;
  shared: boolean;
  state: string;
}
export async function readShareStatus(
  signal: AbortSignal
): Promise<LinksResult<{ projects: ShareStatus[] }>> {
  const value = await read('/api/links/share/status', signal);
  if (!value.ok) {
    return value;
  }
  if (!Array.isArray(value.projects)) {
    throw new Error('Links sharing status is unavailable.');
  }
  const projects = value.projects.map((project) => {
    if (
      !(
        record(project) &&
        text(project.project) &&
        typeof project.shared === 'boolean' &&
        text(project.state)
      )
    ) {
      return null;
    }
    const policy = record(project.policy) ? project.policy : null;
    return {
      attention: policy?.attention === true,
      owner: text(policy?.owner) ? policy.owner : '',
      project: project.project,
      shared: project.shared,
      state: project.state,
    };
  });
  if (projects.some((project) => project === null)) {
    throw new Error('Links sharing status is unavailable.');
  }
  return { ok: true, projects: projects as ShareStatus[] };
}

export function targetKey(recipientTarget: LinksTarget | null) {
  return recipientTarget
    ? `${recipientTarget.repo}/${recipientTarget.name}/${recipientTarget.sessionId}`
    : null;
}

export function sendFingerprint(
  recipientTarget: LinksTarget,
  body: string,
  replyTo: string
) {
  return JSON.stringify([recipientTarget, body, replyTo]);
}

export interface RedeliveryReview {
  attemptId: string;
  messageId: string;
  recipient: { provider: string; sessionId: string };
  token: string;
}

export interface ShareReview {
  fields: { field: string; keys: string[]; meaning: string }[];
  never: string[];
  owner: string;
  permissions: {
    attention: boolean;
    interrupt: boolean;
    receive: boolean;
    visibility: boolean;
  };
  project: string;
  token: string;
}

export function shareReview(value: unknown): ShareReview | null {
  if (
    !(
      record(value) &&
      Array.isArray(value.fields) &&
      Array.isArray(value.never)
    )
  ) {
    return null;
  }
  const permissions = record(value.permissions) ? value.permissions : null;
  if (
    !(
      permissions &&
      text(value.owner) &&
      text(value.project) &&
      text(value.token) &&
      typeof permissions.attention === 'boolean' &&
      typeof permissions.interrupt === 'boolean' &&
      typeof permissions.receive === 'boolean' &&
      typeof permissions.visibility === 'boolean' &&
      value.never.every(text)
    )
  ) {
    return null;
  }
  const fields = value.fields.map((field) => {
    if (
      !(
        record(field) &&
        text(field.field) &&
        text(field.meaning) &&
        Array.isArray(field.keys) &&
        field.keys.every(text)
      )
    ) {
      return null;
    }
    return { field: field.field, keys: field.keys, meaning: field.meaning };
  });
  if (fields.some((field) => field === null)) {
    return null;
  }
  return {
    fields: fields as ShareReview['fields'],
    never: value.never,
    owner: value.owner,
    permissions: {
      attention: permissions.attention,
      interrupt: permissions.interrupt,
      receive: permissions.receive,
      visibility: permissions.visibility,
    },
    project: value.project,
    token: value.token,
  };
}

export interface AttentionReview {
  effect: string;
  never: string[];
  project: string;
  token: string;
}

export function attentionReview(value: unknown): AttentionReview | null {
  if (
    !(
      record(value) &&
      text(value.effect) &&
      text(value.project) &&
      text(value.token) &&
      Array.isArray(value.never) &&
      value.never.every(text)
    )
  ) {
    return null;
  }
  return {
    effect: value.effect,
    never: value.never,
    project: value.project,
    token: value.token,
  };
}
export function redeliveryReview(value: unknown): RedeliveryReview | null {
  if (
    !(
      record(value) &&
      record(value.recipient) &&
      text(value.token) &&
      text(value.messageId) &&
      text(value.attemptId) &&
      text(value.recipient.provider) &&
      text(value.recipient.sessionId)
    )
  ) {
    return null;
  }
  return {
    attemptId: value.attemptId,
    messageId: value.messageId,
    recipient: {
      provider: value.recipient.provider,
      sessionId: value.recipient.sessionId,
    },
    token: value.token,
  };
}

export function matchesRedelivery(
  review: RedeliveryReview,
  recipientTarget: LinksTarget | null,
  selectedMessage: LinksMessage | undefined
) {
  return Boolean(
    recipientTarget &&
      selectedMessage &&
      review.messageId === selectedMessage.messageId &&
      review.attemptId === selectedMessage.attemptId &&
      review.recipient.sessionId === recipientTarget.sessionId
  );
}
