// Reads and shapes for the Links history panels. Everything here is passive:
// it decodes what the portal answered and arranges archived events for
// display. A malformed answer throws and is shown as "could not be read", never
// as an empty list; a malformed archived event falls back to a plain event.
import { post } from './api';
import type { SpansEvent, SpansJson } from './spans-types';

export interface LinksFailure {
  code: string;
  error: string;
  ok: false;
}

export interface LinksStatusEntry {
  at: number;
  attempts: number;
  backfill: boolean;
  cancel: string;
  expiresAt: number;
  reason: string | null;
  redeliveries: number;
  remoteState: string | null;
  seq: number;
  stage: string | null;
  state: string;
}

export interface LinksMessageRow {
  createdAt: number;
  eventId: string;
  hint: string | null;
  history: LinksStatusEntry[];
  historyBeforeUnknown: boolean;
  kind: string;
  messageId: string;
  origin: string;
  replyTo: string | null;
  sequence: number;
  sessionId: string;
  size: number;
  spanHint: string | null;
  status: LinksStatusEntry | null;
  /** True when the page ends before the history does: a later status event may exist. */
  statusMayBeNewer: boolean;
  text: string;
  truncated: boolean;
}

export type ConversationItem =
  | { event: SpansEvent; kind: 'event' }
  | { kind: 'links-message'; row: LinksMessageRow }
  | {
      entry: LinksStatusEntry;
      event: SpansEvent;
      kind: 'links-status-only';
      messageId: string;
    };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const isText = (value: unknown): value is string => typeof value === 'string';
const isCount = (value: unknown): value is number =>
  Number.isSafeInteger(value) && Number(value) >= 0;
const maybeText = (value: unknown): value is string | null =>
  value === null || isText(value);

function statusEntry(payload: unknown): LinksStatusEntry | null {
  if (
    !(
      isRecord(payload) &&
      isCount(payload.at) &&
      isCount(payload.attempts) &&
      isCount(payload.expiresAt) &&
      isCount(payload.redeliveries) &&
      isCount(payload.seq) &&
      isText(payload.state) &&
      maybeText(payload.reason)
    )
  ) {
    return null;
  }
  return {
    at: payload.at,
    attempts: payload.attempts,
    backfill: payload.backfill === true,
    cancel: isText(payload.cancel) ? payload.cancel : 'none',
    expiresAt: payload.expiresAt,
    reason: payload.reason,
    redeliveries: payload.redeliveries,
    remoteState: isText(payload.remoteState) ? payload.remoteState : null,
    seq: payload.seq,
    stage: isText(payload.stage) ? payload.stage : null,
    state: payload.state,
  };
}

function messageRow(event: SpansEvent): LinksMessageRow | null {
  const p: unknown = event.payload;
  if (
    !(
      isRecord(p) &&
      isText(p.messageId) &&
      isText(p.text) &&
      isText(p.origin) &&
      isText(p.kind) &&
      isCount(p.createdAt) &&
      isCount(p.size) &&
      isRecord(p.recipient) &&
      isText(p.recipient.sessionId) &&
      maybeText(p.replyTo ?? null) &&
      maybeText(p.runHint ?? null) &&
      maybeText(p.spanHint ?? null)
    )
  ) {
    return null;
  }
  return {
    createdAt: p.createdAt,
    eventId: event.eventId,
    hint: isText(p.runHint) ? p.runHint : null,
    history: [],
    historyBeforeUnknown: false,
    kind: p.kind,
    messageId: p.messageId,
    origin: p.origin,
    replyTo: isText(p.replyTo) ? p.replyTo : null,
    sequence: event.sequence,
    sessionId: p.recipient.sessionId,
    size: p.size,
    spanHint: isText(p.spanHint) ? p.spanHint : null,
    status: null,
    statusMayBeNewer: false,
    text: p.text,
    truncated: p.truncated === true,
  };
}

// Status events are a second pass so their position on the page never matters.
function foldStatuses(
  events: SpansEvent[],
  rows: Map<string, LinksMessageRow>
) {
  const consumed = new Set<SpansEvent>();
  const orphans = new Map<SpansEvent, ConversationItem>();
  for (const event of events) {
    if (event.type !== 'links.status') {
      continue;
    }
    const payload: unknown = event.payload;
    const entry = statusEntry(payload);
    const messageId =
      isRecord(payload) && isText(payload.messageId) ? payload.messageId : null;
    if (!(entry && messageId)) {
      continue;
    }
    const row = rows.get(messageId);
    if (row) {
      row.history.push(entry);
      consumed.add(event);
    } else {
      orphans.set(event, {
        entry,
        event,
        kind: 'links-status-only',
        messageId,
      });
    }
  }
  for (const row of rows.values()) {
    row.history.sort((a, b) => a.seq - b.seq);
    row.status = row.history.at(-1) ?? null;
    row.historyBeforeUnknown = row.history.some((entry) => entry.backfill);
  }
  return { consumed, orphans };
}

/**
 * Arranges one page of a run's events for the Conversation. A projected
 * message is one row; its status events are folded into it (the highest
 * engine sequence is the current status, the others are its history). Events
 * that are not projected messages pass through untouched, in order.
 */
export function groupLinksMessages(
  events: SpansEvent[],
  { more = false }: { more?: boolean } = {}
): ConversationItem[] {
  const rows = new Map<string, LinksMessageRow>();
  const items: ConversationItem[] = [];
  for (const event of events) {
    if (event.type === 'links.message') {
      const row = messageRow(event);
      if (row && !rows.has(row.messageId)) {
        rows.set(row.messageId, row);
        items.push({ kind: 'links-message', row });
        continue;
      }
    }
    items.push({ event, kind: 'event' });
  }
  const { consumed, orphans } = foldStatuses(events, rows);
  // History is paged by sequence: when more pages exist, what a row shows is
  // only what this page saw.
  for (const row of rows.values()) {
    row.statusMayBeNewer = more;
  }
  return items.flatMap((item) => {
    if (item.kind !== 'event' || item.event.type !== 'links.status') {
      return [item];
    }
    if (consumed.has(item.event)) {
      return [];
    }
    return [orphans.get(item.event) ?? item];
  });
}

/** Queued or held mail past its expiry may have expired: the engine records expiry only when it is swept. */
export function linksMayHaveExpired(row: LinksMessageRow, now: number) {
  return (
    row.status !== null &&
    (row.status.state === 'queued' || row.status.state === 'held') &&
    now >= row.status.expiresAt
  );
}

// ---------------------------------------------------------------------------
// Portal answers
// ---------------------------------------------------------------------------

export function decodeLinksFailure(value: unknown): LinksFailure | null {
  return isRecord(value) &&
    value.ok === false &&
    isText(value.code) &&
    isText(value.error)
    ? { code: value.code, error: value.error, ok: false }
    : null;
}

export interface LinksAssociation {
  associationId: string;
  epoch: number;
  generation: number;
  hint: string;
  origin: string;
  runId: string;
  status: 'approved' | 'revoked' | 'stale';
}

const ASSOCIATION_STATUSES = new Set(['approved', 'revoked', 'stale']);
const unreadable = () => new Error('Links answer is unreadable.');

export function decodeLinksAssociations(value: unknown): LinksAssociation[] {
  if (
    !(isRecord(value) && value.ok === true && Array.isArray(value.associations))
  ) {
    throw unreadable();
  }
  return value.associations.map((row): LinksAssociation => {
    if (
      !(
        isRecord(row) &&
        isText(row.associationId) &&
        isCount(row.epoch) &&
        isCount(row.generation) &&
        isText(row.hint) &&
        isText(row.origin) &&
        isText(row.runId) &&
        isText(row.status) &&
        ASSOCIATION_STATUSES.has(row.status)
      )
    ) {
      throw unreadable();
    }
    return {
      associationId: row.associationId,
      epoch: row.epoch,
      generation: row.generation,
      hint: row.hint,
      origin: row.origin,
      runId: row.runId,
      status: row.status as LinksAssociation['status'],
    };
  });
}

export interface LinksReview {
  associationId: string;
  generation: number;
  hint: string;
  messageId?: string;
  origin: string;
  record?: Record<string, SpansJson>;
  revision: number;
  runId: string;
  spanId?: string | null;
  status?: string;
  token: string;
}

export function decodeLinksReview(value: unknown): LinksReview {
  const review = isRecord(value) && value.ok === true ? value.review : null;
  if (
    !(
      isRecord(review) &&
      isText(review.associationId) &&
      isCount(review.generation) &&
      isText(review.hint) &&
      isText(review.origin) &&
      isCount(review.revision) &&
      isText(review.runId) &&
      isText(review.token)
    )
  ) {
    throw unreadable();
  }
  return review as unknown as LinksReview;
}

export interface LinksRecoveryItem {
  disposition: 'attached' | 'unassociated';
  hint: string | null;
  messageId: string;
  openPath: string;
  origin: string | null;
  reason: string | null;
  rejection?: string;
  runIds: string[];
  spanHint: string | null;
  state: string;
}

export interface LinksRecovery {
  items: LinksRecoveryItem[];
  kind: 'delivery' | 'unassociated';
  moreAfter: string | null;
}

export function decodeLinksRecovery(value: unknown): LinksRecovery {
  if (
    !(
      isRecord(value) &&
      value.ok === true &&
      Array.isArray(value.items) &&
      (value.kind === 'delivery' || value.kind === 'unassociated')
    )
  ) {
    throw unreadable();
  }
  const items = value.items.map((item): LinksRecoveryItem => {
    if (
      !(
        isRecord(item) &&
        (item.disposition === 'attached' ||
          item.disposition === 'unassociated') &&
        isText(item.messageId) &&
        isText(item.openPath) &&
        isText(item.state) &&
        maybeText(item.hint) &&
        maybeText(item.origin) &&
        maybeText(item.reason) &&
        maybeText(item.spanHint) &&
        Array.isArray(item.runIds) &&
        item.runIds.every(isText)
      )
    ) {
      throw unreadable();
    }
    return item as unknown as LinksRecoveryItem;
  });
  const moreAfter = value.moreAfter ?? null;
  if (!maybeText(moreAfter)) {
    throw unreadable();
  }
  return { items, kind: value.kind, moreAfter };
}

export interface LinksProjectionRow {
  associationId: string;
  engineHead: number;
  generation: number;
  hint: string;
  origin: string;
  pending: boolean;
  projectedThrough: number;
  status: string;
}

export interface LinksProjection {
  associations: LinksProjectionRow[];
  engine: 'absent' | 'ok' | 'unavailable' | 'unchecked';
}

export function decodeLinksProjection(value: unknown): LinksProjection {
  if (
    !(
      isRecord(value) &&
      value.ok === true &&
      (value.engine === 'ok' ||
        value.engine === 'unchecked' ||
        value.engine === 'absent' ||
        value.engine === 'unavailable') &&
      Array.isArray(value.associations)
    )
  ) {
    throw unreadable();
  }
  const associations = value.associations.map((row): LinksProjectionRow => {
    if (
      !(
        isRecord(row) &&
        isText(row.associationId) &&
        isCount(row.engineHead) &&
        isCount(row.generation) &&
        isText(row.hint) &&
        isText(row.origin) &&
        typeof row.pending === 'boolean' &&
        isCount(row.projectedThrough) &&
        isText(row.status)
      )
    ) {
      throw unreadable();
    }
    return row as unknown as LinksProjectionRow;
  });
  return { associations, engine: value.engine };
}

export type LinksProjectionSummary =
  | { kind: 'current' }
  | { kind: 'engine-absent' }
  | { kind: 'engine-unavailable' }
  | { kind: 'none' }
  | { kind: 'pending'; pending: number };

/** What the Conversation can truthfully say about whether history is up to date. */
export function linksProjectionSummary(
  projection: LinksProjection
): LinksProjectionSummary {
  if (projection.engine === 'unchecked') {
    return { kind: 'none' };
  }
  if (projection.engine === 'unavailable') {
    return { kind: 'engine-unavailable' };
  }
  if (projection.engine === 'absent') {
    return { kind: 'engine-absent' };
  }
  const approved = projection.associations.filter(
    (a) => a.status === 'approved'
  );
  if (approved.length === 0) {
    return { kind: 'none' };
  }
  const pending = approved.filter((a) => a.pending).length;
  return pending > 0 ? { kind: 'pending', pending } : { kind: 'current' };
}

// ---------------------------------------------------------------------------
// Reads and writes. A read never starts anything; a write is one explicit act.
// ---------------------------------------------------------------------------

async function readLinks(
  path: string,
  query: Record<string, string | undefined>,
  signal?: AbortSignal
): Promise<unknown> {
  const params = new URLSearchParams(
    Object.entries(query).filter(
      (entry): entry is [string, string] => entry[1] !== undefined
    )
  );
  const response = await fetch(`${path}?${params}`, { signal });
  if (response.status === 404) {
    // A portal without Links history simply does not serve these.
    return {
      code: 'LINKS_UNAVAILABLE',
      error: 'Links history is not available in this portal.',
      ok: false,
    };
  }
  return response.json();
}

export type LinksAnswer<T> = { failure: LinksFailure } | { value: T };

async function decoded<T>(
  answer: Promise<unknown>,
  decode: (value: unknown) => T
): Promise<LinksAnswer<T>> {
  const value = await answer;
  const failure = decodeLinksFailure(value);
  return failure ? { failure } : { value: decode(value) };
}

export const readLinksAssociations = (runId: string, signal?: AbortSignal) =>
  decoded(
    readLinks('/api/links/associations', { runId }, signal),
    decodeLinksAssociations
  );

export const readLinksProjection = (runId: string, signal?: AbortSignal) =>
  decoded(
    readLinks('/api/links/projection/status', { runId }, signal),
    decodeLinksProjection
  );

export const readLinksRecovery = (
  query: {
    afterId?: string;
    kind: 'delivery' | 'unassociated';
    runId?: string;
  },
  signal?: AbortSignal
) =>
  decoded(
    readLinks('/api/links/recovery', { ...query }, signal),
    decodeLinksRecovery
  );

export const previewLinksAssociation = (
  target: { hint: string; origin: string; runId: string },
  signal?: AbortSignal
) =>
  decoded(
    readLinks('/api/links/associations/preview', target, signal),
    decodeLinksReview
  );

export const previewLinksEvidence = (
  target: { messageId: string; runId: string; spanId?: string },
  signal?: AbortSignal
) =>
  decoded(
    readLinks('/api/links/evidence/preview', target, signal),
    decodeLinksReview
  );

/** A write returns the portal's own answer; an uncertain network outcome is never shown as done. */
export type LinksWrite =
  | { ok: true }
  | { error: string; networkUncertain?: boolean; ok: false };

async function write(path: string, body: unknown): Promise<LinksWrite> {
  const result: unknown = await post(path, body);
  if (isRecord(result) && result.ok === true) {
    return { ok: true };
  }
  return {
    error:
      isRecord(result) && isText(result.error)
        ? result.error
        : 'The portal did not confirm this change.',
    networkUncertain: isRecord(result) && result.networkUncertain === true,
    ok: false,
  };
}

export const approveLinksAssociation = (body: {
  confirmation: string;
  hint: string;
  origin: string;
  runId: string;
}) => write('/api/links/associations/approve', body);

export const revokeLinksAssociation = (body: {
  hint: string;
  origin: string;
  runId: string;
}) => write('/api/links/associations/revoke', body);

export const attachLinksEvidence = (body: {
  confirmation: string;
  messageId: string;
  runId: string;
  spanId?: string;
}) => write('/api/links/evidence/attach', body);

// ---------------------------------------------------------------------------
// Choices and wording
// ---------------------------------------------------------------------------

const SPAN_CHOICE_LIMIT = 100;

/**
 * Where evidence may point: the run as a whole (the default) or one of the
 * spans the run really has. A peer's span hint is never a choice.
 */
export interface SpanChoice {
  /** An unselectable note, such as how many spans the list leaves out. */
  disabled?: boolean;
  id: string | null;
  label: string;
}

/** The default target, and what a caller with no list of its own gets. */
export const WHOLE_RUN_CHOICES: SpanChoice[] = [
  { id: null, label: 'The run as a whole' },
];

export function evidenceSpanChoices(
  view: Record<string, SpansJson>
): SpanChoice[] {
  const choices: SpanChoice[] = [...WHOLE_RUN_CHOICES];
  const spans: unknown = view.spans;
  if (!isRecord(spans)) {
    return choices;
  }
  const entries = Object.entries(spans);
  for (const [id, span] of entries.slice(0, SPAN_CHOICE_LIMIT)) {
    const title = isRecord(span) && isText(span.title) ? span.title : null;
    choices.push({ id, label: title ? `${id} — ${title}` : id });
  }
  // The bound stays, and the list says it was cut rather than look complete.
  const omitted = entries.length - SPAN_CHOICE_LIMIT;
  if (omitted > 0) {
    choices.push({
      disabled: true,
      id: null,
      label: `${omitted} more span${omitted === 1 ? ' is' : 's are'} not listed here. Evidence for those cannot be chosen in this panel.`,
    });
  }
  return choices;
}

export function recoveryEmptyText(
  kind: 'delivery' | 'unassociated',
  moreAfter: string | null
): string {
  if (moreAfter !== null) {
    return 'None on this page. More messages remain to check: use Next page.';
  }
  return kind === 'delivery'
    ? 'No held or uncertain deliveries.'
    : 'No messages are waiting for an approval.';
}

/** Anything not attached can be approved; stale and revoked ones can be approved again. */
export function canAssociate(item: LinksRecoveryItem): boolean {
  return (
    item.disposition !== 'attached' &&
    item.origin !== null &&
    item.hint !== null
  );
}

export function canRevoke(association: { status: string }): boolean {
  return association.status === 'approved' || association.status === 'stale';
}

const REJECTION_COPY: Record<string, string> = {
  'index-incomplete':
    'Whether a run approved this origin and hint cannot be said: more runs may have than the lookup keeps, or a run could not be read. Run setu links project to rebuild it.',
  'origin-unknown': 'The engine did not say where this message came from.',
  revoked: 'An approval for this origin and hint was revoked.',
  'stale-generation':
    'The run’s plan changed after this was approved. Approve it again to attach it.',
  unapproved: 'No approval is recorded for this origin and hint.',
  'unknown-run': 'The run this hint was approved for is not in the archive.',
};

export function linksRejectionCopy(rejection: string): string {
  return REJECTION_COPY[rejection] ?? `Not attached (${rejection}).`;
}

const STATE_TONES: Record<string, 'amber' | 'emerald' | 'red' | 'zinc'> = {
  acknowledged: 'emerald',
  cancelled: 'zinc',
  expired: 'zinc',
  'handed-off': 'emerald',
  'handoff-unknown': 'amber',
  held: 'amber',
  queued: 'zinc',
  // The sender's outbox could not hand it over: a failure, not a delivery.
  rejected: 'red',
};

export function linksStateTone(
  state: string
): 'amber' | 'emerald' | 'red' | 'zinc' {
  return STATE_TONES[state] ?? 'zinc';
}
