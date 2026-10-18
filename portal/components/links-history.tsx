// Links history panels for one Spans run: projected messages in the
// Conversation, and associations, delivery recovery and unassociated mail in
// Recovery. Everything is read-only until the user presses an explicit button,
// and a button only ever sends the reviewed token back. Peer text is shown as
// plain text in <pre>, never as markup or a link, and "Open message" shows the
// engine's own copy. Nothing here starts a projection or an index.
import type { ComponentChildren } from 'preact';
import { useState } from 'preact/hooks';
import {
  approveLinksAssociation,
  attachLinksEvidence,
  canAssociate,
  canRevoke,
  type LinksAnswer,
  type LinksAssociation,
  type LinksFailure,
  type LinksMessageRow,
  type LinksRecoveryItem,
  type LinksReview,
  type LinksStatusEntry,
  linksMayHaveExpired,
  linksProjectionSummary,
  linksRejectionCopy,
  linksStateTone,
  previewLinksAssociation,
  previewLinksEvidence,
  readLinksAssociations,
  readLinksProjection,
  readLinksRecovery,
  recoveryEmptyText,
  revokeLinksAssociation,
  type SpanChoice,
} from '../links-history';
import { inputCls, Section } from '../ui';
import { Badge } from '../ui/badge';
import { Button } from '../ui/button';
import { useVisiblePoll } from '../use-visible-poll';

const inputClass = `mt-1 block min-h-11 w-full ${inputCls}`;

const stateLabel = (state: string) => state.replace(/-/g, ' ');
const originLabel = (origin: string | null) => {
  if (origin === null) {
    return 'origin unknown';
  }
  return origin === 'local' ? 'this machine' : `peer ${origin}`;
};

function Failure({ failure }: { failure: LinksFailure }) {
  return (
    <p class="text-signal-red text-sm" role="alert">
      {failure.error} <span class="board-mono text-xs">({failure.code})</span>
    </p>
  );
}

// Loading, unreadable, refused and stale are all different answers.
function Answer<T>({
  answer,
  children,
  failed,
  label,
}: {
  answer: LinksAnswer<T> | undefined;
  children: (value: T) => ComponentChildren;
  failed: boolean;
  label: string;
}) {
  if (!answer) {
    return failed ? (
      <p class="text-signal-red text-sm" role="alert">
        {label} could not be read. Select Refresh to try again.
      </p>
    ) : (
      <p class="text-sm text-zinc-600 dark:text-zinc-300" role="status">
        Loading {label.toLowerCase()}…
      </p>
    );
  }
  return (
    <>
      {failed && (
        <p class="mb-2 text-signal-amber text-sm" role="status">
          Showing the last answer; {label.toLowerCase()} could not be refreshed.
        </p>
      )}
      {'failure' in answer ? (
        <Failure failure={answer.failure} />
      ) : (
        children(answer.value)
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// Conversation
// ---------------------------------------------------------------------------

function StatusLine({ entry }: { entry: LinksStatusEntry }) {
  const extra = [
    entry.stage ? `outbox ${entry.stage}` : null,
    entry.remoteState ? `recipient ${entry.remoteState}` : null,
    entry.cancel === 'none' ? null : `cancel ${entry.cancel}`,
    entry.attempts > 0 ? `${entry.attempts} attempt(s)` : null,
    entry.reason,
  ].filter(Boolean);
  return (
    <span class="text-xs text-zinc-600 dark:text-zinc-300">
      {extra.join(' · ')}
    </span>
  );
}

function EvidenceAction({
  choices,
  messageId,
  onChanged,
  runId,
}: {
  choices: SpanChoice[];
  messageId: string;
  onChanged: () => void;
  runId: string;
}) {
  // The target is the user's choice among the run's own spans, defaulting to
  // the run itself. What a peer's message names is never a default.
  const [target, setTarget] = useState<string>('');
  const [review, setReview] = useState<LinksReview | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const spanId = target === '' ? undefined : target;
  const selectId = `links-evidence-target-${messageId}`;

  async function open() {
    setBusy(true);
    setMessage(null);
    try {
      const answer = await previewLinksEvidence({ messageId, runId, spanId });
      if ('failure' in answer) {
        setMessage(answer.failure.error);
      } else {
        setReview(answer.value);
      }
    } catch {
      setMessage('The evidence preview could not be read.');
    } finally {
      setBusy(false);
    }
  }

  async function attach() {
    if (!review) {
      return;
    }
    setBusy(true);
    const result = await attachLinksEvidence({
      confirmation: review.token,
      messageId,
      runId,
      spanId: review.spanId ?? undefined,
    });
    setBusy(false);
    if (result.ok) {
      setReview(null);
      setMessage('Attached as evidence. This does not accept the span.');
      onChanged();
    } else {
      setMessage(result.error);
    }
  }

  return (
    <div class="mt-2 min-w-0">
      {!review && (
        <div class="flex flex-wrap items-end gap-2">
          <label class="text-xs" htmlFor={selectId}>
            Evidence for
            <select
              class={`${inputClass} mt-1 min-h-11`}
              id={selectId}
              onChange={(event) => setTarget(event.currentTarget.value)}
              value={target}
            >
              {choices.map((choice, index) => (
                <option
                  disabled={choice.disabled === true}
                  key={`${index}:${choice.id ?? ''}`}
                  value={choice.id ?? ''}
                >
                  {choice.label}
                </option>
              ))}
            </select>
          </label>
          <Button compact disabled={busy} onClick={open} variant="secondary">
            Review as evidence
          </Button>
        </div>
      )}
      {review && (
        <div class="min-w-0 border border-zinc-300 p-3 dark:border-white/20">
          <p class="text-sm">
            Attach this message as evidence for{' '}
            <strong>
              {review.spanId ? `span ${review.spanId}` : 'the run as a whole'}
            </strong>
            , plan generation {review.generation}. The stored copy is redacted
            and bounded. Evidence is a reference for you to judge; it does not
            accept the span or complete anything.
          </p>
          {review.record && (
            <pre class="mt-2 max-h-48 overflow-auto whitespace-pre-wrap break-words text-xs">
              {String(review.record.text ?? '')}
            </pre>
          )}
          <div class="mt-2 flex flex-wrap gap-2">
            <Button compact disabled={busy} onClick={attach}>
              Attach evidence
            </Button>
            <Button
              compact
              disabled={busy}
              onClick={() => setReview(null)}
              variant="secondary"
            >
              Cancel
            </Button>
          </div>
        </div>
      )}
      {message && (
        <p class="mt-2 text-sm" role="status">
          {message}
        </p>
      )}
    </div>
  );
}

export function LinksMessageItem({
  choices,
  now,
  onChanged,
  row,
  runId,
}: {
  choices: SpanChoice[];
  now: number;
  onChanged: () => void;
  row: LinksMessageRow;
  runId: string;
}) {
  const { status } = row;
  const mayHaveExpired = linksMayHaveExpired(row, now);
  return (
    <li class="min-w-0 py-3 first:pt-0 last:pb-0">
      <div class="flex min-w-0 flex-wrap items-center gap-2">
        <Badge tone="emerald">Linked message</Badge>
        {status ? (
          <Badge tone={linksStateTone(status.state)}>
            {stateLabel(status.state)}
          </Badge>
        ) : (
          <Badge tone="zinc">
            {row.statusMayBeNewer
              ? 'status not on this page'
              : 'status pending'}
          </Badge>
        )}
        <span class="board-mono text-xs text-zinc-600 dark:text-zinc-300">
          From {row.origin === 'local' ? 'this machine' : `peer ${row.origin}`}{' '}
          · to session {row.sessionId} · Sequence {row.sequence}
        </span>
      </div>
      <pre class="mt-2 max-h-96 max-w-full overflow-auto whitespace-pre-wrap break-words text-sm text-zinc-800 dark:text-zinc-200">
        {row.text}
      </pre>
      {row.truncated && (
        <p class="mt-1 text-signal-amber text-xs">
          Only the first part of this message is kept here ({row.size} bytes
          sent). It is not the full text.
        </p>
      )}
      {row.replyTo && (
        <p class="mt-1 break-all text-xs text-zinc-600 dark:text-zinc-300">
          In reply to {row.replyTo}
        </p>
      )}
      {status && <StatusLine entry={status} />}
      {row.statusMayBeNewer && (
        <p class="mt-1 text-signal-amber text-xs">
          More history follows this page, so this may not be the latest status.
          Load the next history page to see newer changes.
        </p>
      )}
      {mayHaveExpired && (
        <p class="mt-1 text-signal-amber text-xs">
          Its time to live has passed; the engine records the expiry the next
          time it sweeps, so this may already have expired.
        </p>
      )}
      {row.historyBeforeUnknown && (
        <p class="mt-1 text-xs text-zinc-600 dark:text-zinc-300">
          History before this point is unknown: it predates the engine’s event
          log.
        </p>
      )}
      {row.history.length > 1 && (
        <details class="mt-1 text-sm">
          <summary class="min-h-11 cursor-pointer py-2">
            Status history ({row.history.length})
          </summary>
          <ol class="ml-4 list-decimal text-xs">
            {row.history.map((entry) => (
              <li key={entry.seq}>
                {stateLabel(entry.state)}
                {entry.reason ? ` — ${entry.reason}` : ''}
              </li>
            ))}
          </ol>
        </details>
      )}
      <EvidenceAction
        choices={choices}
        messageId={row.messageId}
        onChanged={onChanged}
        runId={runId}
      />
    </li>
  );
}

export function LinksStatusOnlyItem({
  entry,
  messageId,
}: {
  entry: LinksStatusEntry;
  messageId: string;
}) {
  return (
    <li class="min-w-0 py-3 first:pt-0 last:pb-0">
      <div class="flex flex-wrap items-center gap-2">
        <Badge tone={linksStateTone(entry.state)}>
          {stateLabel(entry.state)}
        </Badge>
        <span class="text-xs text-zinc-600 dark:text-zinc-300">
          Status change for message {messageId}; the message itself is on
          another page of history.
        </span>
      </div>
    </li>
  );
}

/** What can truthfully be said about whether this run’s linked history is current. */
export function LinksProjectionNotice({
  quiet = false,
  runId,
}: {
  quiet?: boolean;
  runId: string;
}) {
  const poll = useVisiblePoll(`links-projection:${runId}`, 15_000, (signal) =>
    readLinksProjection(runId, signal)
  );
  const hint = (
    <>
      Run <code>setu links project</code> to update it; nothing here starts it.
    </>
  );
  // A portal without Links history, or a run with no approval, says nothing
  // in the Conversation: Spans works the same without Links.
  if (
    quiet &&
    poll.data &&
    'failure' in poll.data &&
    poll.data.failure.code === 'LINKS_UNAVAILABLE'
  ) {
    return null;
  }
  return (
    <div aria-live="polite" class="mb-3 text-sm" role="status">
      <Answer answer={poll.data} failed={poll.failed} label="Projection status">
        {(projection) => {
          const summary = linksProjectionSummary(projection);
          switch (summary.kind) {
            case 'pending':
              return (
                <p class="text-signal-amber">
                  Linked messages are waiting to be added to this history (
                  {summary.pending} association
                  {summary.pending === 1 ? '' : 's'}). They are pending, not
                  lost. {hint}
                </p>
              );
            case 'engine-absent':
              return (
                <p class="text-zinc-600 dark:text-zinc-300">
                  No Links mailbox exists yet, so there is nothing to add.
                </p>
              );
            case 'engine-unavailable':
              return (
                <p class="text-signal-amber">
                  The Links engine is unavailable, so whether messages are
                  waiting is not known.
                </p>
              );
            case 'current':
              return (
                <p class="text-zinc-600 dark:text-zinc-300">
                  Linked history is up to date as of the last check.
                </p>
              );
            default:
              return quiet ? null : (
                <p class="text-zinc-600 dark:text-zinc-300">
                  No message source is approved for this run. Approve one below
                  to see linked messages in its Conversation.
                </p>
              );
          }
        }}
      </Answer>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Recovery
// ---------------------------------------------------------------------------

function AssociationReview({
  initial,
  onDone,
  runId,
}: {
  initial?: { hint: string; origin: string };
  onDone: () => void;
  runId: string;
}) {
  const start = initial ?? { hint: '', origin: 'local' };
  const [origin, setOrigin] = useState(start.origin);
  const [hint, setHint] = useState(start.hint);
  const [review, setReview] = useState<LinksReview | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function preview() {
    setBusy(true);
    setMessage(null);
    try {
      const answer = await previewLinksAssociation({ hint, origin, runId });
      if ('failure' in answer) {
        setReview(null);
        setMessage(answer.failure.error);
      } else {
        setReview(answer.value);
      }
    } catch {
      setMessage('The preview could not be read.');
    } finally {
      setBusy(false);
    }
  }

  async function approve() {
    if (!review) {
      return;
    }
    setBusy(true);
    const result = await approveLinksAssociation({
      confirmation: review.token,
      hint: review.hint,
      origin: review.origin,
      runId,
    });
    setBusy(false);
    if (result.ok) {
      setReview(null);
      setMessage('Approved. Linked messages appear after the next projection.');
      onDone();
    } else {
      setMessage(result.error);
    }
  }

  return (
    <div class="min-w-0">
      {initial && (
        <p class="mb-2 text-sm" role="status">
          Filled in from a message or an earlier approval. Review it, then
          approve.
        </p>
      )}
      <div class="grid gap-3 sm:grid-cols-2">
        <label class="text-sm" htmlFor={`links-origin-${runId}`}>
          Origin (this machine is “local”; otherwise the peer’s key)
          <input
            class={inputClass}
            id={`links-origin-${runId}`}
            maxLength={128}
            onInput={(event) => {
              setOrigin(event.currentTarget.value);
              setReview(null);
            }}
            value={origin}
          />
        </label>
        <label class="text-sm" htmlFor={`links-hint-${runId}`}>
          Run hint the sender used
          <input
            class={inputClass}
            id={`links-hint-${runId}`}
            maxLength={128}
            onInput={(event) => {
              setHint(event.currentTarget.value);
              setReview(null);
            }}
            value={hint}
          />
        </label>
      </div>
      <div class="mt-3">
        <Button
          disabled={busy || !(origin && hint)}
          onClick={preview}
          variant="secondary"
        >
          Review association
        </Button>
      </div>
      {review && (
        <div class="mt-3 min-w-0 border border-zinc-300 p-3 dark:border-white/20">
          <p class="break-words text-sm">
            Treat messages from <strong>{review.origin}</strong> that name{' '}
            <strong>{review.hint}</strong> as belonging to run{' '}
            <strong>{review.runId}</strong>, plan generation{' '}
            <strong>{review.generation}</strong>. This only decides where
            messages are shown. It never accepts a span, changes the plan or
            runs anything, and it ends if the plan is revised.
          </p>
          <div class="mt-2">
            <Button compact disabled={busy} onClick={approve}>
              Approve association
            </Button>
          </div>
        </div>
      )}
      {message && (
        <p class="mt-2 text-sm" role="status">
          {message}
        </p>
      )}
    </div>
  );
}

function AssociationRow({
  association,
  onChanged,
  onReview,
}: {
  association: LinksAssociation;
  onChanged: () => void;
  onReview: (association: LinksAssociation) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  async function revoke() {
    setBusy(true);
    const result = await revokeLinksAssociation({
      hint: association.hint,
      origin: association.origin,
      runId: association.runId,
    });
    setBusy(false);
    if (result.ok) {
      onChanged();
    } else {
      setMessage(result.error);
    }
  }
  return (
    <li class="min-w-0 py-2">
      <div class="flex flex-wrap items-center gap-2">
        <Badge tone={association.status === 'approved' ? 'emerald' : 'amber'}>
          {association.status}
        </Badge>
        <span class="break-words text-sm">
          {association.origin === 'local'
            ? 'This machine'
            : `Peer ${association.origin}`}{' '}
          · hint {association.hint} · generation {association.generation}
        </span>
        {canRevoke(association) && (
          <Button compact disabled={busy} onClick={revoke} variant="secondary">
            Revoke
          </Button>
        )}
        {association.status !== 'approved' && (
          <Button
            compact
            onClick={() => onReview(association)}
            variant="secondary"
          >
            Approve again…
          </Button>
        )}
      </div>
      {association.status === 'stale' && (
        <p class="mt-1 text-signal-amber text-xs">
          The plan changed after this was approved, so nothing new is attached.
          Review it again below to approve it for the current plan.
        </p>
      )}
      {message && <p class="mt-1 text-sm">{message}</p>}
    </li>
  );
}

function RecoveryList({
  kind,
  prefill,
  runId,
}: {
  kind: 'delivery' | 'unassociated';
  prefill: (item: LinksRecoveryItem) => void;
  runId?: string;
}) {
  const [cursors, setCursors] = useState<string[]>(['']);
  const after = cursors.at(-1) ?? '';
  const poll = useVisiblePoll(
    `links-recovery:${kind}:${runId ?? ''}:${after}`,
    30_000,
    (signal) =>
      readLinksRecovery({ afterId: after || undefined, kind, runId }, signal)
  );
  return (
    <Answer answer={poll.data} failed={poll.failed} label="Messages">
      {(page) => (
        <>
          {page.items.length === 0 ? (
            <p class="text-sm text-zinc-600 dark:text-zinc-300">
              {recoveryEmptyText(kind, page.moreAfter)}
            </p>
          ) : (
            <ul class="min-w-0 divide-y divide-zinc-200 dark:divide-white/10">
              {page.items.map((item) => (
                <RecoveryRow
                  item={item}
                  key={item.messageId}
                  prefill={prefill}
                />
              ))}
            </ul>
          )}
          <div class="mt-3 flex flex-wrap gap-2">
            <Button
              compact
              disabled={cursors.length < 2}
              onClick={() => setCursors(cursors.slice(0, -1))}
              variant="secondary"
            >
              Previous page
            </Button>
            <Button
              compact
              disabled={!page.moreAfter}
              onClick={() => setCursors([...cursors, page.moreAfter ?? ''])}
              variant="secondary"
            >
              Next page
            </Button>
            <Button compact onClick={poll.refresh} variant="secondary">
              Refresh
            </Button>
          </div>
        </>
      )}
    </Answer>
  );
}

function RecoveryRow({
  item,
  prefill,
}: {
  item: LinksRecoveryItem;
  prefill: (item: LinksRecoveryItem) => void;
}) {
  const [opened, setOpened] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  async function open() {
    setError(null);
    try {
      const response = await fetch(item.openPath);
      const body: unknown = await response.json();
      const text =
        body && typeof body === 'object' && 'body' in body
          ? String((body as { body: unknown }).body)
          : null;
      if (text === null) {
        setError('The message could not be opened.');
      } else {
        setOpened(text);
      }
    } catch {
      setError('The message could not be opened.');
    }
  }
  return (
    <li class="min-w-0 py-3">
      <div class="flex min-w-0 flex-wrap items-center gap-2">
        <Badge tone={linksStateTone(item.state)}>
          {stateLabel(item.state)}
        </Badge>
        <span class="break-all text-xs">{item.messageId}</span>
        <span class="text-xs text-zinc-600 dark:text-zinc-300">
          {originLabel(item.origin)}
          {item.hint ? ` · hint ${item.hint}` : ''}
        </span>
      </div>
      {item.reason && (
        <p class="mt-1 text-xs text-zinc-600 dark:text-zinc-300">
          {item.reason}
        </p>
      )}
      {item.rejection && (
        <p class="mt-1 text-xs text-zinc-600 dark:text-zinc-300">
          Not attached to a run: {linksRejectionCopy(item.rejection)}
        </p>
      )}
      <div class="mt-2 flex flex-wrap gap-2">
        <Button compact onClick={open} variant="secondary">
          Open message
        </Button>
        {canAssociate(item) && (
          <Button compact onClick={() => prefill(item)} variant="secondary">
            Associate with this run…
          </Button>
        )}
      </div>
      {opened !== null && (
        <pre class="mt-2 max-h-64 overflow-auto whitespace-pre-wrap break-words text-sm">
          {opened}
        </pre>
      )}
      {error && <p class="mt-1 text-signal-red text-xs">{error}</p>}
      <p class="mt-1 text-xs text-zinc-600 dark:text-zinc-300">
        Resolving a delivery here or in the inbox never changes a span or
        accepts completion.
      </p>
    </li>
  );
}

export function LinksRecoveryPanel({
  onChanged,
  runId,
}: {
  onChanged: () => void;
  runId: string;
}) {
  const associations = useVisiblePoll(
    `links-associations:${runId}`,
    30_000,
    (signal) => readLinksAssociations(runId, signal)
  );
  const [form, setForm] = useState<
    { hint: string; origin: string } | undefined
  >();
  const [formKey, setFormKey] = useState(0);
  const changed = () => {
    associations.refresh();
    onChanged();
  };
  // Filling the form is not an approval: the user still reviews and approves.
  const startReview = (origin: string, hint: string) => {
    setForm({ hint, origin });
    setFormKey(formKey + 1);
  };
  return (
    <div class="space-y-5">
      <Section title="Linked messages: projection">
        <LinksProjectionNotice runId={runId} />
      </Section>
      <Section title="Message sources approved for this run">
        <Answer
          answer={associations.data}
          failed={associations.failed}
          label="Associations"
        >
          {(list) =>
            list.length === 0 ? (
              <p class="text-sm text-zinc-600 dark:text-zinc-300">
                Nothing is approved. A peer’s run reference is only a hint until
                you approve it here.
              </p>
            ) : (
              <ul class="divide-y divide-zinc-200 dark:divide-white/10">
                {list.map((association) => (
                  <AssociationRow
                    association={association}
                    key={association.associationId}
                    onChanged={changed}
                    onReview={(row) => startReview(row.origin, row.hint)}
                  />
                ))}
              </ul>
            )
          }
        </Answer>
        <div class="mt-4" id={`links-association-form-${runId}`}>
          <AssociationReview
            initial={form}
            key={formKey}
            onDone={changed}
            runId={runId}
          />
        </div>
      </Section>
      <Section title="Held and uncertain deliveries for this run">
        <RecoveryList
          kind="delivery"
          prefill={(item) =>
            startReview(item.origin ?? 'local', item.hint ?? '')
          }
          runId={runId}
        />
      </Section>
      <Section title="Messages naming a run that nothing approves">
        <p class="mb-2 text-sm text-zinc-600 dark:text-zinc-300">
          These stay in the Links inbox. Approving one’s origin and hint for
          this run is the only way they appear in its history.
        </p>
        <RecoveryList
          kind="unassociated"
          prefill={(item) =>
            startReview(item.origin ?? 'local', item.hint ?? '')
          }
        />
      </Section>
    </div>
  );
}
