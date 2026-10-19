import { useEffect, useRef, useState } from 'preact/hooks';
import { post } from '../api';
import {
  type AttentionReview,
  type DirectoryEntry,
  type LinksMessage,
  type LinksResult,
  type LinksTarget,
  linksTarget,
  type ManagedSession,
  matchesRedelivery,
  attentionReview as parseAttentionReview,
  type RedeliveryReview,
  readCapabilities,
  readDirectory,
  readInbox,
  readManagedSessions,
  readMessage,
  readShareStatus,
  redeliveryReview,
  type ShareReview,
  sendFingerprint,
  shareReview,
  targetKey,
} from '../links-read';
import { inputCls, PageHeader } from '../ui';
import { Badge, type Tone } from '../ui/badge';
import { Button } from '../ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../ui/dialog';
import { useVisiblePoll } from '../use-visible-poll';

const POLL_MS = 15_000;
const PENDING_SEND_STORAGE_KEY = 'setu-links-pending-send/v1';
interface PendingSend {
  body: string;
  fingerprint: string;
  key: string;
  replyTo: string;
  target: LinksTarget;
}

function isPendingSend(value: unknown): value is PendingSend {
  if (!(value && typeof value === 'object')) {
    return false;
  }
  const candidate = value as Partial<PendingSend>;
  return Boolean(
    candidate.target &&
      typeof candidate.target.name === 'string' &&
      typeof candidate.target.repo === 'string' &&
      typeof candidate.target.sessionId === 'string' &&
      typeof candidate.body === 'string' &&
      candidate.body.length > 0 &&
      candidate.body.length <= 65_536 &&
      typeof candidate.replyTo === 'string' &&
      candidate.replyTo.length <= 128 &&
      typeof candidate.key === 'string' &&
      candidate.key.length > 0 &&
      candidate.key.length <= 128 &&
      typeof candidate.fingerprint === 'string' &&
      candidate.fingerprint ===
        sendFingerprint(candidate.target, candidate.body, candidate.replyTo)
  );
}
function samePending(left: PendingSend | null, right: PendingSend) {
  return Boolean(
    left && left.key === right.key && left.fingerprint === right.fingerprint
  );
}
function readPendingSend(): {
  pending: PendingSend | null;
  storageFailed: boolean;
} {
  try {
    const value = window.sessionStorage.getItem(PENDING_SEND_STORAGE_KEY);
    if (!value) {
      return { pending: null, storageFailed: false };
    }
    const parsed: unknown = JSON.parse(value);
    return isPendingSend(parsed)
      ? { pending: parsed, storageFailed: false }
      : { pending: null, storageFailed: true };
  } catch {
    return { pending: null, storageFailed: true };
  }
}
function toneFor(state: string): Tone {
  if (
    state === 'acknowledged' ||
    state === 'enabled' ||
    state === 'queued' ||
    state === 'reachable' ||
    state === 'running'
  ) {
    return 'emerald';
  }
  if (
    state === 'held' ||
    state === 'invalid' ||
    state === 'stale' ||
    state === 'unreachable' ||
    state === 'unknown'
  ) {
    return 'amber';
  }
  if (state === 'cancelled' || state === 'expired' || state === 'rejected') {
    return 'red';
  }
  return 'zinc';
}
const stamp = (at: number | undefined | null) =>
  at ? new Date(at).toLocaleString() : 'Unknown';
const actionError = (value: unknown) =>
  value &&
  typeof value === 'object' &&
  'ok' in value &&
  value.ok === false &&
  'error' in value &&
  typeof value.error === 'string'
    ? `${'code' in value && typeof value.code === 'string' ? `${value.code}: ` : ''}${value.error}`
    : 'The action was not confirmed.';

const sameTarget = (left: LinksTarget | null, right: LinksTarget | null) =>
  targetKey(left) === targetKey(right);
async function available<T>(
  read: (signal: AbortSignal) => Promise<LinksResult<T>>,
  signal: AbortSignal
): Promise<{ ok: true } & T> {
  const result = await read(signal);
  if (!result.ok) {
    throw new Error(`${result.code}: ${result.error}`);
  }
  return result;
}
function deliveryLabel(session: ManagedSession) {
  if (
    session.tool === 'claude-code' &&
    session.nativeConversation.provider === 'claude-code' &&
    session.nativeConversation.state === 'bound' &&
    session.ownership === 'owned' &&
    session.state === 'running'
  ) {
    return 'Claude delivery verified';
  }
  if (
    session.tool === 'codex' ||
    session.nativeConversation.provider === 'codex'
  ) {
    return 'Codex delivery is unverified';
  }
  return session.nativeConversation.reason ?? 'Delivery is not verified';
}

function SessionLabel({ target }: { target: LinksTarget }) {
  return (
    <>
      {target.repo}/{target.name} · {target.sessionId}
    </>
  );
}

function SessionPicker({
  busy,
  failed,
  onRetry,
  selected,
  sessions,
  onSelect,
}: {
  busy: boolean;
  failed: boolean;
  onRetry: () => void;
  selected: LinksTarget | null;
  sessions: { sessions: ManagedSession[] } | undefined;
  onSelect: (target: LinksTarget) => void;
}) {
  const list = sessions ? sessions.sessions : [];
  return (
    <section aria-labelledby="links-sessions" class="glass-panel p-4">
      <h2 class="font-semibold text-sm" id="links-sessions">
        Managed sessions
      </h2>
      <p class="mt-1 text-xs text-zinc-600 dark:text-zinc-300">
        Choose the exact managed session. Same-branch sessions remain separate.
      </p>
      {!(sessions || failed) && (
        <p class="empty-state">Loading managed sessions…</p>
      )}
      {failed && (
        <p class="read-notice mt-3" role="alert">
          Managed sessions are unavailable.{' '}
          <button class="underline" onClick={onRetry} type="button">
            Retry
          </button>
        </p>
      )}
      {failed && sessions && (
        <p class="read-notice mt-2" role="status">
          Showing the last managed-session list. It may be stale.
        </p>
      )}
      {!list.length && sessions && (
        <p class="empty-state">No managed sessions are available.</p>
      )}
      <div class="mt-3 flex max-h-64 flex-col gap-2 overflow-y-auto">
        {list.map((session) => {
          const active = selected?.sessionId === session.sessionId;
          const delivery = deliveryLabel(session);
          return (
            <button
              aria-pressed={active}
              class={`shrink-0 border p-3 text-left text-xs ${active ? 'border-accent bg-emerald-50/50 dark:bg-emerald-950/20' : 'border-zinc-200 dark:border-zinc-700'}`}
              disabled={busy}
              key={session.sessionId}
              onClick={() => onSelect(linksTarget(session))}
              type="button"
            >
              <span class="block break-all font-medium text-zinc-900 dark:text-zinc-100">
                <SessionLabel target={session} />
              </span>
              <span class="mt-1 flex flex-wrap gap-2 text-zinc-600 dark:text-zinc-300">
                <Badge tone={toneFor(session.state)}>{session.state}</Badge>
                <span>{delivery}</span>
                <span>Last managed activity {stamp(session.lastHookAt)}</span>
              </span>
            </button>
          );
        })}
      </div>
      {selected &&
        !list.some((session) => session.sessionId === selected.sessionId) && (
          <p class="read-notice mt-3" role="alert">
            Selected session {selected.sessionId} is no longer listed. It has
            not been retargeted.
          </p>
        )}
    </section>
  );
}

function Directory({
  directory,
  failed,
  onRetry,
  sessions,
  onSelect,
}: {
  directory: {
    checkedAt?: number;
    data?: {
      entries: DirectoryEntry[];
      problems: { project: string; reason: string }[];
      staleAfterMs: number;
    };
  };
  failed: boolean;
  onRetry: () => void;
  sessions: ManagedSession[];
  onSelect: (target: LinksTarget) => void;
}) {
  const { data } = directory;
  const entries = data ? data.entries : [];
  return (
    <section aria-labelledby="links-directory" class="glass-panel p-4">
      <div class="flex flex-wrap items-center justify-between gap-2">
        <h2 class="font-semibold text-sm" id="links-directory">
          Shared directory
        </h2>
        {directory.checkedAt && (
          <span class="text-xs text-zinc-500">
            Read {stamp(directory.checkedAt)}
          </span>
        )}
      </div>
      {failed && (
        <p class="read-notice mt-3" role="alert">
          Directory is unavailable.{' '}
          <button class="underline" onClick={onRetry} type="button">
            Retry
          </button>
        </p>
      )}
      {failed && entries.length > 0 && (
        <p class="read-notice mt-2" role="status">
          Directory data may be stale.
        </p>
      )}
      {!(data || failed) && (
        <p class="empty-state">Loading shared directory…</p>
      )}
      {data && !entries.length && (
        <p class="empty-state">No shared sessions are visible.</p>
      )}
      <ul
        aria-busy={!(data || failed)}
        class="mt-3 divide-y divide-zinc-200 dark:divide-zinc-700"
      >
        {entries.map((entry) => {
          const local = sessions.find(
            (session) => session.sessionId === entry.sessionId
          );
          return (
            <li class="py-3" key={`${entry.project}:${entry.sessionId}`}>
              <div class="flex flex-wrap items-center gap-2">
                <span class="font-medium text-sm">{entry.owner}</span>
                <Badge tone={toneFor(entry.reachability.state)}>
                  {entry.reachability.state}
                </Badge>
                {entry.stale && <Badge tone="amber">Stale</Badge>}
              </div>
              <p class="mt-1 break-words text-xs text-zinc-600 dark:text-zinc-300">
                {entry.project} · {entry.task ?? 'No task label'} · Session{' '}
                {entry.sessionId}
              </p>
              <p class="mt-1 text-xs text-zinc-500">
                Observed {stamp(entry.observedAt)}
                {entry.activityAt
                  ? ` · activity ${stamp(entry.activityAt)}`
                  : ''}
                {entry.taskStale ? ' · task may be stale' : ''}
                {entry.reachability.reason
                  ? ` · ${entry.reachability.reason}`
                  : ''}
              </p>
              <p class="mt-1 text-xs text-zinc-500">
                {local ? deliveryLabel(local) : 'Provider delivery unverified'}
              </p>
              {local && (
                <Button
                  compact
                  onClick={() => onSelect(linksTarget(local))}
                  variant="secondary"
                >
                  Open local inbox
                </Button>
              )}
            </li>
          );
        })}
      </ul>
      {data
        ? data.problems.map((problem) => (
            <p class="read-notice mt-2" role="alert">
              {problem.project}: {problem.reason}
            </p>
          ))
        : null}
    </section>
  );
}

export function MessageDetail({
  loading,
  message,
  target,
  stale = false,
  busy,
  onAck,
  onCancel,
  onRedeliver,
}: {
  loading: boolean;
  message: LinksMessage | undefined;
  target: LinksTarget | null;
  stale?: boolean;
  busy: string | null;
  onAck: () => void;
  onCancel: () => void;
  onRedeliver: () => void;
}) {
  if (!message) {
    return (
      <section class="glass-panel p-4">
        <h2 class="font-semibold text-sm">Message detail</h2>
        <p class="empty-state">
          {loading ? 'Loading message detail…' : 'Choose a message to read it.'}
        </p>
      </section>
    );
  }
  const acknowledges =
    message.state === 'handed-off' || message.state === 'acknowledged';
  const canAcknowledge =
    Boolean(target) &&
    target?.sessionId === message.recipient.sessionId &&
    acknowledges;
  const canCancel = message.state === 'queued' || message.state === 'held';
  return (
    <section aria-labelledby="links-message" class="glass-panel p-4">
      <div class="flex flex-wrap items-center gap-2">
        <h2 class="font-semibold text-sm" id="links-message">
          Message detail
        </h2>
        <Badge tone={toneFor(message.state)}>{message.state}</Badge>
      </div>
      <p class="mt-2 break-all font-mono text-xs">{message.messageId}</p>
      <pre class="mt-3 whitespace-pre-wrap break-words border-accent border-l-2 pl-3 text-sm">
        {message.body ?? 'Message body is unavailable.'}
      </pre>
      <dl class="mt-4 grid grid-cols-1 gap-2 text-xs sm:grid-cols-2">
        <div>
          <dt class="text-zinc-500">Reply to</dt>
          <dd class="break-all">{message.replyTo ?? 'None'}</dd>
        </div>
        <div>
          <dt class="text-zinc-500">Recipient</dt>
          <dd>
            {message.recipient.provider} · session {message.recipient.sessionId}
          </dd>
        </div>
        <div>
          <dt class="text-zinc-500">Attempts</dt>
          <dd>
            {message.attempts}, {message.redeliveries} redeliveries
          </dd>
        </div>
        <div>
          <dt class="text-zinc-500">Updated</dt>
          <dd>{stamp(message.updatedAt)}</dd>
        </div>
        {message.runHint && (
          <div>
            <dt class="text-zinc-500">Run hint/reference</dt>
            <dd class="break-all">{message.runHint}</dd>
          </div>
        )}
      </dl>
      {message.reason && (
        <p class="read-notice mt-3" role="status">
          {message.reason}
        </p>
      )}
      <div class="mt-4 flex flex-wrap gap-2">
        <Button
          compact
          disabled={stale || !canAcknowledge || busy !== null}
          onClick={onAck}
          variant="secondary"
        >
          {busy === 'Acknowledge' ? 'Acknowledging…' : 'Acknowledge'}
        </Button>
        <Button
          compact
          disabled={stale || !canCancel || busy !== null}
          onClick={onCancel}
          variant="secondary"
        >
          {busy === 'Cancel' ? 'Cancelling…' : 'Cancel message'}
        </Button>
        {message.state === 'handoff-unknown' && message.attemptId && (
          <Button
            compact
            disabled={stale || !target || busy !== null}
            onClick={onRedeliver}
            variant="secondary"
          >
            Review redelivery
          </Button>
        )}
      </div>
    </section>
  );
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: One small form owns its exact review state and confirmation actions.
function PolicySettings({
  projects,
  refresh,
  report,
}: {
  projects: { name: string; label: string }[];
  refresh: () => void;
  report: (message: string) => void;
}) {
  const [project, setProject] = useState('');
  const [review, setReview] = useState<ShareReview | null>(null);
  const [attentionReview, setAttentionReview] =
    useState<AttentionReview | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const projectRef = useRef(project);
  projectRef.current = project;
  const status = useVisiblePoll('links-share-status', POLL_MS, (signal) =>
    available(readShareStatus, signal)
  );
  const current = status.data?.projects.find(
    (entry) => entry.project === project
  );
  const run = async (
    kind: string,
    path: string,
    body: object,
    reviewed?: (result: unknown) => void
  ) => {
    const reviewedProject = project;
    setBusy(kind);
    const result = await post(path, body);
    setBusy(null);
    if (projectRef.current !== reviewedProject) {
      report(
        `${kind} response was for ${reviewedProject}; its review was discarded.`
      );
      return result;
    }
    if (result?.ok) {
      report(`${kind} confirmed.`);
      status.refresh();
      refresh();
      return result;
    }
    if (result?.code === 'LINKS_CONFIRMATION_REQUIRED') {
      reviewed?.(result.confirmation);
      return result;
    }
    report(actionError(result));
    return result;
  };
  const reviewCurrent = review?.project === project;
  const attentionCurrent = attentionReview?.project === project;
  let attentionState = status.failed ? 'status stale' : 'status unavailable';
  if (status.data && !status.failed) {
    attentionState = current?.attention ? 'enabled' : 'disabled';
  }
  let statusTone: Tone = 'zinc';
  if (status.failed) {
    statusTone = 'amber';
  } else if (current?.shared) {
    statusTone = 'emerald';
  }
  return (
    <section aria-labelledby="links-sharing" class="glass-panel p-4">
      <h2 class="font-semibold text-sm" id="links-sharing">
        Project sharing
      </h2>
      <p class="mt-1 text-xs text-zinc-600 dark:text-zinc-300">
        Sharing is explicit. Reading this page never changes policy or publishes
        presence.
      </p>
      <label class="mt-3 block text-xs" htmlFor="links-project">
        Project
        <select
          class={`${inputCls} mt-1`}
          id="links-project"
          onChange={(event) => {
            setProject(event.currentTarget.value);
            setReview(null);
            setAttentionReview(null);
          }}
          value={project}
        >
          <option value="">Choose a registered project</option>
          {projects.map((entry) => (
            <option key={entry.name} value={entry.name}>
              {entry.label}
            </option>
          ))}
        </select>
      </label>
      {project && (
        <div class="mt-3 flex flex-wrap items-center gap-2 text-xs">
          <Badge tone={statusTone}>
            {status.failed ? 'Status stale' : (current?.state ?? 'Unknown')}
          </Badge>
          {current?.owner && <span>Owner {current.owner}</span>}
          <span>Attention {attentionState}</span>
        </div>
      )}
      {status.failed && (
        <p class="read-notice mt-3" role="alert">
          Could not refresh sharing status. Existing status may be stale.
        </p>
      )}
      <div class="mt-4 flex flex-wrap gap-2">
        <Button
          compact
          disabled={!project || busy !== null}
          onClick={() =>
            run(
              'Share enable',
              '/api/links/share/enable',
              { repo: project },
              (confirmation) => {
                const parsed = shareReview(confirmation);
                if (parsed) {
                  setReview(parsed);
                } else {
                  report('Links returned an unusable sharing review.');
                }
              }
            )
          }
        >
          {busy === 'Share enable' ? 'Reviewing…' : 'Enable sharing'}
        </Button>
        <Button
          compact
          disabled={
            !project ||
            busy !== null ||
            status.failed ||
            !status.data ||
            !current?.shared
          }
          onClick={() =>
            run('Share disable', '/api/links/share/disable', { repo: project })
          }
          variant="secondary"
        >
          {busy === 'Share disable' ? 'Disabling…' : 'Disable sharing'}
        </Button>
        <Button
          compact
          disabled={
            !project ||
            busy !== null ||
            status.failed ||
            !status.data ||
            !current?.shared
          }
          onClick={() =>
            current?.attention
              ? run('Attention disable', '/api/links/share/attention', {
                  enabled: false,
                  repo: project,
                })
              : run(
                  'Attention enable',
                  '/api/links/share/attention',
                  { enabled: true, repo: project },
                  (confirmation) => {
                    const parsed = parseAttentionReview(confirmation);
                    if (parsed) {
                      setAttentionReview(parsed);
                    } else {
                      report('Links returned an unusable attention review.');
                    }
                  }
                )
          }
          variant="secondary"
        >
          {current?.attention ? 'Disable attention' : 'Enable attention'}
        </Button>
      </div>
      <Dialog onOpenChange={(open) => !open && setReview(null)} open={!!review}>
        <DialogContent showCloseButton>
          <DialogHeader>
            <DialogTitle>Review sharing</DialogTitle>
            <DialogDescription>
              Confirm only the fields shown. Changing the project invalidates
              this review.
            </DialogDescription>
          </DialogHeader>
          {review && (
            <div class="space-y-2 text-xs">
              <p>
                Project {review.project} · owner {review.owner}
              </p>
              <dl class="space-y-2">
                {review.fields.map((field) => (
                  <div key={field.field}>
                    <dt class="font-medium">
                      {field.field}: {field.keys.join(', ')}
                    </dt>
                    <dd>{field.meaning}</dd>
                  </div>
                ))}
                <div>
                  <dt class="font-medium">Never shared</dt>
                  <dd>{review.never.join(', ')}</dd>
                </div>
                <div>
                  <dt class="font-medium">Permissions</dt>
                  <dd>
                    visibility {String(review.permissions.visibility)}, receive{' '}
                    {String(review.permissions.receive)}, interrupt{' '}
                    {String(review.permissions.interrupt)}, attention{' '}
                    {String(review.permissions.attention)}
                  </dd>
                </div>
              </dl>
            </div>
          )}
          {!reviewCurrent && (
            <p class="read-notice" role="alert">
              The selected project changed. This consent is no longer valid.
            </p>
          )}
          <DialogFooter>
            <Button onClick={() => setReview(null)} variant="secondary">
              Cancel
            </Button>
            <Button
              disabled={!reviewCurrent || busy !== null}
              onClick={() => {
                if (!review) {
                  return;
                }
                run(
                  'Share enable',
                  '/api/links/share/enable',
                  {
                    confirmation: review.token,
                    owner: review.owner,
                    repo: review.project,
                  },
                  () => undefined
                ).then((result) => result?.ok && setReview(null));
              }}
            >
              Confirm sharing
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog
        onOpenChange={(open) => !open && setAttentionReview(null)}
        open={!!attentionReview}
      >
        <DialogContent showCloseButton>
          <DialogHeader>
            <DialogTitle>Review attention requests</DialogTitle>
            <DialogDescription>
              Attention stays in the existing attention list. It never wakes an
              agent.
            </DialogDescription>
          </DialogHeader>
          {attentionReview && (
            <div class="space-y-2 text-xs">
              <p>Project {attentionReview.project}</p>
              <p>{attentionReview.effect}</p>
              <p>Never: {attentionReview.never.join(', ')}</p>
            </div>
          )}
          {!attentionCurrent && (
            <p class="read-notice" role="alert">
              The selected project changed. This consent is no longer valid.
            </p>
          )}
          <DialogFooter>
            <Button
              onClick={() => setAttentionReview(null)}
              variant="secondary"
            >
              Cancel
            </Button>
            <Button
              disabled={!attentionCurrent || busy !== null}
              onClick={() => {
                if (!attentionReview) {
                  return;
                }
                run(
                  'Attention enable',
                  '/api/links/share/attention',
                  {
                    confirmation: attentionReview.token,
                    enabled: true,
                    repo: attentionReview.project,
                  },
                  () => undefined
                ).then((result) => result?.ok && setAttentionReview(null));
              }}
            >
              Confirm attention
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: This page keeps each local Links action adjacent to its exact review state.
export function LinksPage({
  onBack,
  projects,
}: {
  onBack: () => void;
  projects: { name: string; label: string }[];
}) {
  const sessions = useVisiblePoll('links-managed-sessions', POLL_MS, (signal) =>
    available(readManagedSessions, signal)
  );
  const directory = useVisiblePoll('links-directory', POLL_MS, (signal) =>
    available(readDirectory, signal)
  );
  const capabilities = useVisiblePoll('links-capabilities', POLL_MS, (signal) =>
    available(readCapabilities, signal)
  );
  const [initialPending] = useState(readPendingSend);
  const [target, setTarget] = useState<LinksTarget | null>(null);
  const [messageId, setMessageId] = useState<string | null>(null);
  const [body, setBody] = useState('');
  const [replyTo, setReplyTo] = useState('');
  const [pendingSend, setPendingSend] = useState<PendingSend | null>(
    initialPending.pending
  );
  const [pendingStorageFailed, setPendingStorageFailed] = useState(
    initialPending.storageFailed
  );
  const [busy, setBusy] = useState<string | null>(null);
  const [report, setReport] = useState('');
  const [review, setReview] = useState<RedeliveryReview | null>(null);
  const targetRef = useRef(target);
  const bodyRef = useRef(body);
  const replyToRef = useRef(replyTo);
  const messageIdRef = useRef(messageId);
  const pendingSendRef = useRef(pendingSend);
  const action = useRef(0);
  targetRef.current = target;
  bodyRef.current = body;
  replyToRef.current = replyTo;
  messageIdRef.current = messageId;
  pendingSendRef.current = pendingSend;
  const key = targetKey(target);
  const inbox = useVisiblePoll(
    key ? `links-inbox:${key}` : null,
    POLL_MS,
    (signal) =>
      available((inner) => readInbox(target as LinksTarget, inner), signal)
  );
  const detail = useVisiblePoll(
    messageId ? `links-message:${messageId}` : null,
    POLL_MS,
    (signal) =>
      available((inner) => readMessage(messageId as string, inner), signal)
  );
  const selectedMessage = detail.data?.message;
  useEffect(() => setReview(null), [key, messageId]);
  useEffect(() => {
    if (!(pendingSend && pendingStorageFailed)) {
      return;
    }
    const beforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', beforeUnload);
    return () => window.removeEventListener('beforeunload', beforeUnload);
  }, [pendingSend, pendingStorageFailed]);
  const savePendingSend = (next: PendingSend) => {
    try {
      window.sessionStorage.setItem(
        PENDING_SEND_STORAGE_KEY,
        JSON.stringify(next)
      );
    } catch {
      setPendingStorageFailed(true);
      return false;
    }
    pendingSendRef.current = next;
    setPendingSend(next);
    setPendingStorageFailed(false);
    return true;
  };
  const clearPendingSend = (sent: PendingSend) => {
    if (!samePending(pendingSendRef.current, sent)) {
      return true;
    }
    try {
      const stored = window.sessionStorage.getItem(PENDING_SEND_STORAGE_KEY);
      const saved = stored ? (JSON.parse(stored) as unknown) : null;
      if (isPendingSend(saved) && samePending(saved, sent)) {
        window.sessionStorage.removeItem(PENDING_SEND_STORAGE_KEY);
      }
    } catch {
      setPendingStorageFailed(true);
      return false;
    }
    pendingSendRef.current = null;
    setPendingSend(null);
    setPendingStorageFailed(false);
    return true;
  };
  const selectTarget = (next: LinksTarget) => {
    setTarget(linksTarget(next));
    setMessageId(null);
    setReview(null);
  };
  const refresh = () => {
    sessions.refresh();
    directory.refresh();
    capabilities.refresh();
    inbox.refresh();
    detail.refresh();
  };
  const mutate = async (
    kind: string,
    path: string,
    payload: object,
    current: () => boolean
  ) => {
    action.current += 1;
    const own = action.current;
    setBusy(kind);
    const result = await post(path, payload);
    if (action.current === own) {
      setBusy(null);
    }
    if (!current()) {
      setReport(`${kind} response cannot update a changed selection or draft.`);
      return result;
    }
    if (result?.ok) {
      setReport(`${kind} confirmed.`);
      inbox.refresh();
      detail.refresh();
      return result;
    }
    setReport(actionError(result));
    return result;
  };
  const send = async () => {
    if (!(target && body.trim())) {
      return;
    }
    const cleanBody = body.trim();
    const cleanReply = replyTo.trim();
    const fingerprint = sendFingerprint(target, cleanBody, cleanReply);
    const previous = pendingSendRef.current;
    if (previous && previous.fingerprint !== fingerprint) {
      setReport('Restore the exact unresolved draft before retrying it.');
      return;
    }
    const recovery = previous?.fingerprint === fingerprint ? previous : null;
    const idempotencyKey = recovery?.key ?? crypto.randomUUID();
    const intent = {
      body: cleanBody,
      fingerprint,
      key: idempotencyKey,
      replyTo: cleanReply,
      target: linksTarget(target),
    };
    // Store the exact key before posting: a navigation during an unknown outcome must not lose it.
    if (!savePendingSend(intent)) {
      setReport(
        'Browser storage is unavailable. This send was not started; keep the draft and retry once storage is available.'
      );
      return;
    }
    const result = await mutate(
      'Send',
      '/api/links/send',
      {
        ...linksTarget(intent.target),
        body: cleanBody,
        idempotencyKey,
        ...(cleanReply ? { replyTo: cleanReply } : {}),
      },
      () =>
        sameTarget(targetRef.current, intent.target) &&
        sendFingerprint(
          targetRef.current as LinksTarget,
          bodyRef.current.trim(),
          replyToRef.current.trim()
        ) === intent.fingerprint
    );
    if (result?.code === 'LINKS_OUTCOME_UNKNOWN' || result?.networkUncertain) {
      setReport(
        `Send outcome is unknown for ${intent.target.repo}/${intent.target.name} session ${intent.target.sessionId}. Reconcile the inbox, then retry only with key ${intent.key}.`
      );
      return;
    }
    const cleared = clearPendingSend(intent);
    if (!cleared) {
      setReport(
        'Send completed, but its recovery key could not be cleared. Keep the exact draft and retry only with that key if needed.'
      );
      return;
    }
    if (
      result?.ok &&
      targetRef.current &&
      sendFingerprint(
        targetRef.current,
        bodyRef.current.trim(),
        replyToRef.current.trim()
      ) === intent.fingerprint
    ) {
      setBody('');
      setReplyTo('');
    }
  };
  const startRedelivery = async () => {
    if (!(target && selectedMessage?.attemptId)) {
      return;
    }
    const expectedTarget = target;
    const expectedMessage = selectedMessage;
    const result = await mutate(
      'Redelivery review',
      '/api/links/redeliver',
      {
        ...linksTarget(expectedTarget),
        attemptId: selectedMessage.attemptId,
        messageId: selectedMessage.messageId,
      },
      () =>
        sameTarget(targetRef.current, expectedTarget) &&
        messageIdRef.current === expectedMessage.messageId &&
        detail.data?.message?.attemptId === expectedMessage.attemptId
    );
    if (result?.code === 'LINKS_CONFIRMATION_REQUIRED') {
      const next = redeliveryReview(result.confirmation);
      if (
        next &&
        sameTarget(targetRef.current, expectedTarget) &&
        messageIdRef.current === expectedMessage.messageId &&
        detail.data?.message?.attemptId === expectedMessage.attemptId
      ) {
        setReview(next);
      } else {
        setReport('Links returned an unusable redelivery review.');
      }
    }
  };
  const localSessions = sessions.data?.sessions ?? [];
  const reviewCurrent = review
    ? matchesRedelivery(review, target, selectedMessage)
    : false;
  const currentFingerprint = target
    ? sendFingerprint(target, body.trim(), replyTo.trim())
    : null;
  const retryingSend = pendingSend?.fingerprint === currentFingerprint;
  let sendLabel = 'Send message';
  if (pendingSend) {
    sendLabel = retryingSend
      ? 'Retry exact send with same key'
      : 'Restore exact draft to retry';
  }
  if (busy === 'Send') {
    sendLabel = 'Sending…';
  }
  return (
    <div class="portal-page mx-auto max-w-6xl px-4 py-6 sm:px-6">
      <PageHeader
        actions={
          <Button compact onClick={refresh} variant="secondary">
            Refresh Links
          </Button>
        }
        back={{
          label: 'All worktrees',
          onClick: () => {
            if (pendingSend && pendingStorageFailed) {
              setReport(
                'Browser storage is unavailable. Reconcile or retry the unresolved send before leaving this page.'
              );
              return;
            }
            onBack();
          },
        }}
        subtitle={
          <span class="max-w-2xl text-xs text-zinc-600 dark:text-zinc-300">
            Local Links mail and shared presence. Routine messages do not create
            attention items or wake sessions.
          </span>
        }
        title="Links"
      />
      {report && (
        <p class="read-notice mb-4" role="status">
          {report}
        </p>
      )}
      {pendingSend && pendingStorageFailed && (
        <p class="read-notice mb-4" role="alert">
          Browser storage could not confirm this recovery key was cleared. Keep
          the exact draft and reconcile or retry before leaving.
        </p>
      )}
      {capabilities.data && !capabilities.data.wake.available && (
        <p class="read-notice mb-4" role="status">
          <strong>Send now unavailable.</strong> {capabilities.data.wake.error}{' '}
          ({capabilities.data.wake.code})
        </p>
      )}
      {!(capabilities.data || capabilities.failed) && (
        <p class="read-notice mb-4" role="status">
          Checking whether Send now is available…
        </p>
      )}
      {capabilities.failed && (
        <p class="read-notice mb-4" role="alert">
          Send now capability is unavailable.{' '}
          <button
            class="underline"
            onClick={capabilities.refresh}
            type="button"
          >
            Retry
          </button>
        </p>
      )}
      <div class="grid gap-4 lg:grid-cols-[minmax(18rem,0.8fr)_minmax(0,1.2fr)]">
        <div class="space-y-4">
          <SessionPicker
            busy={busy !== null}
            failed={sessions.failed}
            onRetry={sessions.refresh}
            onSelect={selectTarget}
            selected={target}
            sessions={sessions.data}
          />
          <PolicySettings
            projects={projects}
            refresh={refresh}
            report={setReport}
          />
        </div>
        <div class="space-y-4">
          <section aria-labelledby="links-inbox" class="glass-panel p-4">
            <h2 class="font-semibold text-sm" id="links-inbox">
              Inbox
            </h2>
            {!target && (
              <p class="empty-state">
                Choose a managed session to load its inbox.
              </p>
            )}
            {target && !inbox.data && !inbox.failed && (
              <p class="empty-state">Loading this inbox…</p>
            )}
            {inbox.failed && (
              <p class="read-notice mt-3" role="alert">
                Inbox is unavailable.{' '}
                <button class="underline" onClick={inbox.refresh} type="button">
                  Retry
                </button>
              </p>
            )}
            {inbox.failed && inbox.data && (
              <p class="read-notice mt-2" role="status">
                Inbox data may be stale.
              </p>
            )}
            {target && inbox.data && !inbox.data.messages.length && (
              <p class="empty-state">No messages for this session.</p>
            )}
            <ul
              aria-busy={!!target && !inbox.data && !inbox.failed}
              class="mt-3 divide-y divide-zinc-200 dark:divide-zinc-700"
            >
              {inbox.data?.messages.map((message) => (
                <li key={message.messageId}>
                  <button
                    class={`w-full p-3 text-left text-xs ${messageId === message.messageId ? 'bg-zinc-100 dark:bg-zinc-800' : ''}`}
                    onClick={() => setMessageId(message.messageId)}
                    type="button"
                  >
                    <span class="flex flex-wrap items-center gap-2">
                      <Badge tone={toneFor(message.state)}>
                        {message.state}
                      </Badge>
                      <span>{stamp(message.updatedAt)}</span>
                    </span>
                    <span class="mt-1 block break-all font-mono">
                      {message.messageId}
                    </span>
                    {message.replyTo && (
                      <span class="mt-1 block text-zinc-500">
                        Reply to {message.replyTo}
                      </span>
                    )}
                  </button>
                </li>
              ))}
            </ul>
          </section>
          <MessageDetail
            busy={busy}
            loading={Boolean(messageId && !detail.data && !detail.failed)}
            message={selectedMessage}
            onAck={() => {
              if (target && selectedMessage) {
                const expectedTarget = target;
                const expectedMessageId = selectedMessage.messageId;
                mutate(
                  'Acknowledge',
                  '/api/links/ack',
                  {
                    ...linksTarget(expectedTarget),
                    messageId: selectedMessage.messageId,
                  },
                  () =>
                    sameTarget(targetRef.current, expectedTarget) &&
                    messageIdRef.current === expectedMessageId
                );
              }
            }}
            onCancel={() => {
              if (selectedMessage) {
                const expectedMessageId = selectedMessage.messageId;
                mutate(
                  'Cancel',
                  '/api/links/cancel',
                  {
                    messageId: selectedMessage.messageId,
                  },
                  () => messageIdRef.current === expectedMessageId
                );
              }
            }}
            onRedeliver={() => {
              startRedelivery();
            }}
            stale={detail.failed}
            target={target}
          />
          {detail.failed && (
            <p class="read-notice" role="alert">
              Message detail is unavailable.{' '}
              <button class="underline" onClick={detail.refresh} type="button">
                Retry
              </button>
            </p>
          )}
          <section aria-labelledby="links-send" class="glass-panel p-4">
            <h2 class="font-semibold text-sm" id="links-send">
              Send a message
            </h2>
            <p class="mt-1 text-xs text-zinc-600 dark:text-zinc-300">
              Messages stay queued until the selected session reaches its next
              normal turn.
            </p>
            <label class="mt-3 block text-xs" htmlFor="links-message-body">
              Message
              <textarea
                class={`${inputCls} mt-1 min-h-24`}
                disabled={busy !== null}
                id="links-message-body"
                maxLength={65_536}
                onInput={(event) => setBody(event.currentTarget.value)}
                value={body}
              />
            </label>
            <label class="mt-3 block text-xs" htmlFor="links-reply-to">
              Reply to message ID (optional)
              <input
                class={`${inputCls} mt-1`}
                disabled={busy !== null}
                id="links-reply-to"
                maxLength={128}
                onInput={(event) => setReplyTo(event.currentTarget.value)}
                value={replyTo}
              />
            </label>
            <div class="mt-4 flex flex-wrap items-center gap-2">
              <Button
                disabled={
                  !(target && body.trim()) ||
                  busy !== null ||
                  Boolean(pendingSend && !retryingSend)
                }
                onClick={() => {
                  send();
                }}
              >
                {sendLabel}
              </Button>
              {pendingSend && (
                <>
                  {!retryingSend && (
                    <Button
                      compact
                      disabled={busy !== null}
                      onClick={() => {
                        selectTarget(pendingSend.target);
                        setBody(pendingSend.body);
                        setReplyTo(pendingSend.replyTo);
                      }}
                      variant="secondary"
                    >
                      Restore original draft
                    </Button>
                  )}
                  <span class="text-xs text-zinc-500">
                    A possibly committed send remains unresolved for{' '}
                    {pendingSend.target.repo}/{pendingSend.target.name} session{' '}
                    {pendingSend.target.sessionId}, key {pendingSend.key}.{' '}
                    {retryingSend
                      ? 'This exact draft can retry with that key.'
                      : 'Restore the original draft before retrying. A different draft cannot discard this uncertain send.'}
                  </span>
                </>
              )}
            </div>
          </section>
          <Directory
            directory={directory}
            failed={directory.failed}
            onRetry={directory.refresh}
            onSelect={selectTarget}
            sessions={localSessions}
          />
        </div>
      </div>
      <Dialog onOpenChange={(open) => !open && setReview(null)} open={!!review}>
        <DialogContent showCloseButton>
          <DialogHeader>
            <DialogTitle>Review redelivery</DialogTitle>
            <DialogDescription>
              Redelivery can duplicate a message if the earlier handoff
              succeeded.
            </DialogDescription>
          </DialogHeader>
          {review && (
            <div class="space-y-2 text-xs">
              <p>Message {review.messageId}</p>
              <p>Current unknown attempt {review.attemptId}</p>
              <p>
                Target {review.recipient.provider} session{' '}
                {review.recipient.sessionId}
              </p>
            </div>
          )}
          {!reviewCurrent && (
            <p class="read-notice" role="alert">
              The target, message, or current attempt changed. This consent is
              no longer valid.
            </p>
          )}
          <DialogFooter>
            <Button onClick={() => setReview(null)} variant="secondary">
              Cancel
            </Button>
            <Button
              disabled={!reviewCurrent || busy !== null}
              onClick={() => {
                if (review && target) {
                  const expectedReview = review;
                  const expectedTarget = target;
                  mutate(
                    'Redelivery',
                    '/api/links/redeliver',
                    {
                      ...linksTarget(expectedTarget),
                      attemptId: review.attemptId,
                      confirmation: review.token,
                      messageId: review.messageId,
                    },
                    () =>
                      sameTarget(targetRef.current, expectedTarget) &&
                      messageIdRef.current === expectedReview.messageId &&
                      detail.data?.message?.attemptId ===
                        expectedReview.attemptId
                  ).then((result) => result?.ok && setReview(null));
                }
              }}
            >
              Confirm redelivery
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
