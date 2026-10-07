// Worktree-scoped operational controls. Reads begin only after a user opens the
// relevant disclosure; mutations stay separate from their review state.
import { useRef, useState } from 'preact/hooks';
import { post } from '../api';
import { formatStorageBytes } from '../host-storage';
import { inputCls, Section } from '../ui';
import { Badge, StatusDot, type Tone } from '../ui/badge';
import { Button } from '../ui/button';
import { readJson, useVisiblePoll } from '../use-visible-poll';

export type ResourceResult = Record<string, unknown> & { ok: boolean };

export function resourceReadUrl(path: string, repo?: string, name?: string) {
  if (!(repo && name)) {
    return path;
  }
  const query = new URLSearchParams({ name, repo });
  return `${path}?${query}`;
}

const requiredLists: [string, string][] = [
  ['/api/workspace-storage', 'roots'],
  ['/api/workspace-storage', 'observations'],
  ['/api/shared-caches', 'stores'],
  ['/api/operations', 'events'],
  ['/api/resource-admission', 'leases'],
  ['/api/dependency-sharing', 'views'],
  ['/api/agent-sessions', 'sessions'],
  ['/api/setup-progress', 'records'],
  ['/api/attention', 'events'],
  ['/api/headless-runs', 'runs'],
  ['/api/github/workflows', 'workflows'],
  ['/api/github/runs', 'runs'],
  ['/api/mcp-actions', 'actions'],
];

const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);
const isRecordList = (value: unknown) =>
  Array.isArray(value) && value.every(isRecord);

export function attentionFocusBody(
  event: Record<string, unknown>,
  repo: string,
  name: string
) {
  const session = isRecord(event.session) ? event.session : null;
  const target = isRecord(event.target) ? event.target : null;
  const terminal = isRecord(session?.terminal) ? session.terminal : null;
  return event.state !== 'unknown' &&
    target?.repo === repo &&
    target.name === name &&
    session?.repo === repo &&
    session.name === name &&
    session.id === event.sessionId &&
    typeof session.id === 'string' &&
    session.ownership === 'owned' &&
    session.state === 'running' &&
    session.checkoutIdentity &&
    terminal?.kind === 'ghostty' &&
    typeof terminal.id === 'string'
    ? {
        checkoutIdentity: session.checkoutIdentity,
        name,
        repo,
        sessionId: session.id,
      }
    : null;
}

export function confirmationToken(value: unknown) {
  const confirmation = isRecord(value) ? value.confirmation : null;
  return isRecord(confirmation) && typeof confirmation.token === 'string'
    ? confirmation.token
    : null;
}

export function workflowValue(value: unknown) {
  return typeof value === 'string' || typeof value === 'number'
    ? String(value)
    : null;
}

export function storageBytes(value: unknown) {
  return typeof value === 'number' && Number.isFinite(value)
    ? new Intl.NumberFormat().format(value)
    : 'unknown';
}

export function dependencyRepairPlan(result: ResourceResult | undefined) {
  return result?.ok &&
    result.executed === false &&
    Array.isArray(result.command)
    ? { command: result.command, env: result.env, mode: result.mode }
    : null;
}

export function cleanupExecutionBody(manifestId: string, retryId?: string) {
  return retryId
    ? {
        confirmation: { manifestId, retryId },
        manifestId,
        retryId,
      }
    : { confirmation: manifestId, manifestId };
}

export function handoffFindings(value: string) {
  const context = value.trim();
  return context && context.length <= 800
    ? [{ context, id: 'selected-excerpt' }]
    : [];
}

const headlessLimits = {
  maxBudgetUsd: 2,
  outputBytes: 65_536,
  wallClockMs: 3_600_000,
};

export function createReviewGeneration() {
  let value = 0;
  return {
    begin: () => value,
    current: () => value,
    invalidate: () => ++value,
    isCurrent: (candidate: number) => candidate === value,
  };
}

export async function readResource(url: string, signal: AbortSignal) {
  const result = await readJson<unknown>(url, signal);
  if (!isRecord(result) || typeof result.ok !== 'boolean') {
    throw new Error('Malformed resource response');
  }
  if (result.ok) {
    for (const [path, field] of requiredLists) {
      if (url.includes(path) && !isRecordList(result[field])) {
        throw new Error(`Malformed resource response: ${field}`);
      }
    }
  }
  return result as ResourceResult;
}

export function resourceAction(path: string, body: unknown) {
  return post(path, body) as Promise<ResourceResult>;
}

const record = (value: unknown): Record<string, unknown> | null =>
  isRecord(value) ? value : null;
const array = (value: unknown): Record<string, unknown>[] =>
  Array.isArray(value)
    ? value.flatMap((entry) => {
        const item = record(entry);
        return item ? [item] : [];
      })
    : [];
const text = (value: unknown, fallback = 'unknown') =>
  (typeof value === 'string' || typeof value === 'number') && `${value}`
    ? `${value}`
    : fallback;
const arrayText = (value: unknown) =>
  Array.isArray(value)
    ? value
        .filter((item): item is string => typeof item === 'string')
        .join(', ')
    : '';

function stateTone(value: unknown): Tone {
  const state = text(value).toLowerCase();
  if (
    [
      'completed',
      'ready',
      'running',
      'enabled',
      'healthy',
      'shared and healthy',
      'confirmed',
    ].includes(state)
  ) {
    return 'emerald';
  }
  if (['failed', 'error', 'refused'].includes(state)) {
    return 'red';
  }
  return state === 'unknown' || state === 'partial' || state === 'queued'
    ? 'amber'
    : 'zinc';
}

function ResultState({ value }: { value: ResourceResult | undefined }) {
  if (!value) {
    return null;
  }
  if (!value.ok) {
    return (
      <p class="mt-2 text-signal-red text-xs" role="status">
        {text(value.error, 'The operation did not complete.')}{' '}
        {text(value.code, '')}
      </p>
    );
  }
  return null;
}

function DeferredDetails({
  children,
  label,
}: {
  children: (open: boolean) => preact.ComponentChildren;
  label: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <details onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary class="min-h-11 cursor-pointer py-2 font-medium text-sm text-zinc-700 dark:text-zinc-200">
        {label}
      </summary>
      <div class="border-zinc-200/60 border-t pt-3 pb-3 dark:border-white/10">
        {children(open)}
      </div>
    </details>
  );
}

function ReadProblem({
  failed,
  onRetry,
  value,
}: {
  failed: boolean;
  onRetry: () => void;
  value?: ResourceResult;
}) {
  if (failed) {
    return (
      <p class="text-signal-red text-xs" role="status">
        Could not refresh this status.{' '}
        {value ? 'Showing stale last response. ' : ''}
        <button class="underline" onClick={onRetry} type="button">
          Retry
        </button>
      </p>
    );
  }
  if (value && !value.ok) {
    return <ResultState value={value} />;
  }
  if (!value) {
    return <p class="text-xs text-zinc-500">Loading…</p>;
  }
  return null;
}

function StorageControls({ repo, name, toast }: TargetProps) {
  const [inspectBusy, setInspectBusy] = useState<string | null>(null);
  const storageUrl = '/api/workspace-storage';
  const cachesUrl = '/api/shared-caches';
  const storage = useVisiblePoll('storage', null, (signal) =>
    readResource(storageUrl, signal)
  );
  const caches = useVisiblePoll('shared-caches', null, (signal) =>
    readResource(cachesUrl, signal)
  );
  async function inspect(storeId?: string) {
    const key = storeId ?? `${repo}/${name}`;
    if (inspectBusy) {
      return;
    }
    setInspectBusy(key);
    const result = await resourceAction(
      '/api/workspace-storage/inspect',
      storeId ? { storeId } : { name, repo }
    );
    setInspectBusy(null);
    if (result.ok) {
      toast(
        'Inspection finished. Measurements are observations, not a cleanup estimate.',
        'emerald'
      );
      storage.refresh();
      caches.refresh();
    } else {
      toast(`✗ Inspect failed: ${text(result.error)}`, 'red');
    }
  }
  const roots = storage.data?.ok ? array(storage.data.roots) : [];
  const observations = storage.data?.ok ? array(storage.data.observations) : [];
  const stores = caches.data?.ok ? array(caches.data.stores) : [];
  return (
    <Section title="Storage & shared caches">
      <p class="mb-3 text-xs text-zinc-600 dark:text-zinc-300">
        Measurements are cached observations. Inspect is the only action here
        that scans; byte counts do not promise reclaimable space.
      </p>
      <div class="mb-3">
        <Button
          compact
          disabled={inspectBusy !== null}
          onClick={() => inspect()}
          variant="secondary"
        >
          {inspectBusy === `${repo}/${name}`
            ? 'Inspecting…'
            : 'Inspect this worktree'}
        </Button>
      </div>
      <ReadProblem
        failed={storage.failed}
        onRetry={storage.refresh}
        value={storage.data}
      />
      <ReadProblem
        failed={caches.failed}
        onRetry={caches.refresh}
        value={caches.data}
      />
      {(roots.length > 0 || observations.length > 0) && (
        <div class="overflow-x-auto">
          <table class="w-full min-w-[34rem] text-left text-xs">
            <thead class="text-zinc-500">
              <tr>
                <th class="pr-3 pb-2">Root</th>
                <th class="pr-3 pb-2">Observation</th>
                <th class="pr-3 pb-2">State</th>
              </tr>
            </thead>
            <tbody>
              {roots.map((root) => {
                const id = text(root.id);
                const observation = observations.find(
                  (item) => item.rootId === root.id || item.id === root.id
                );
                const state = observation?.state ?? 'unknown';
                const observedAt =
                  typeof observation?.observedAt === 'number'
                    ? new Date(observation.observedAt)
                    : null;
                return (
                  <tr
                    class="border-zinc-200/60 border-t dark:border-white/10"
                    key={id}
                  >
                    <td class="py-2 pr-3">
                      <span>
                        {array(root.consumers)
                          .map(
                            (consumer) =>
                              `${text(consumer.repo)}/${text(consumer.name)}`
                          )
                          .join(', ') || 'Shared store'}
                      </span>
                      <div class="text-zinc-500">{text(root.category, '')}</div>
                    </td>
                    <td class="py-2 pr-3">
                      {observation ? (
                        <>
                          <span>
                            Logical bytes:{' '}
                            {storageBytes(observation.logicalBytes)}
                          </span>
                          <span class="ml-2 text-zinc-500">
                            Allocated bytes:{' '}
                            {storageBytes(observation.allocatedBytes)}
                          </span>
                          <div class="text-zinc-500">
                            {observedAt && Number.isFinite(observedAt.getTime())
                              ? observedAt.toLocaleString()
                              : 'Unknown time'}
                          </div>
                        </>
                      ) : (
                        'Not inspected'
                      )}
                    </td>
                    <td class="py-2 pr-3">
                      <Badge tone={stateTone(state)}>{text(state)}</Badge>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {storage.data?.ok && roots.length === 0 && (
        <p class="text-xs text-zinc-500">
          No storage roots are currently known.
        </p>
      )}
      <div class="mt-4">
        <h3 class="mb-2 font-medium text-sm">Shared cache catalog</h3>
        {stores.length ? (
          <ul class="divide-y divide-zinc-200/60 text-xs dark:divide-white/10">
            {stores.map((store) => {
              const id = text(store.id);
              return (
                <li
                  class="flex flex-wrap items-center justify-between gap-2 py-2"
                  key={id}
                >
                  <span>
                    <span class="font-mono">{text(store.path, id)}</span> ·{' '}
                    {text(store.kind)} ·{' '}
                    {arrayText(store.consumers) || 'consumers unknown'}
                  </span>
                  <span class="flex items-center gap-2">
                    <Badge tone={store.incomplete === true ? 'amber' : 'zinc'}>
                      {store.incomplete === true ? 'partial' : 'cataloged'}
                    </Badge>
                    <Button
                      compact
                      disabled={inspectBusy !== null}
                      onClick={() => inspect(id)}
                      variant="secondary"
                    >
                      {inspectBusy === id ? 'Inspecting…' : 'Inspect'}
                    </Button>
                  </span>
                </li>
              );
            })}
          </ul>
        ) : (
          caches.data?.ok && (
            <p class="text-xs text-zinc-500">
              No shared cache stores are cataloged.
            </p>
          )
        )}
      </div>
      <ResultState value={storage.data} />
    </Section>
  );
}

function DependencyControls({ repo, name, toast }: TargetProps) {
  const url = resourceReadUrl('/api/dependency-sharing', repo, name);
  const read = useVisiblePoll(`dependencies:${repo}/${name}`, null, (signal) =>
    readResource(url, signal)
  );
  const [busy, setBusy] = useState<'verify' | 'repair' | null>(null);
  const [result, setResult] = useState<ResourceResult>();
  const view = read.data?.ok ? array(read.data.views)[0] : undefined;
  const repairPlan = dependencyRepairPlan(result);
  async function act(kind: 'verify' | 'repair') {
    if (busy) {
      return;
    }
    setBusy(kind);
    const response = await resourceAction(`/api/dependency-sharing/${kind}`, {
      name,
      repo,
    });
    setResult(response);
    setBusy(null);
    if (response.ok) {
      toast(
        kind === 'verify'
          ? `Dependency view: ${text(record(response.view)?.state)}`
          : 'Repair plan prepared. Nothing was changed.',
        kind === 'verify' ? stateTone(record(response.view)?.state) : 'emerald'
      );
      read.refresh();
    }
  }
  return (
    <Section title="Dependency sharing">
      <ReadProblem
        failed={read.failed}
        onRetry={read.refresh}
        value={read.data}
      />
      {view && (
        <div class="flex flex-wrap items-center gap-2 text-xs">
          <StatusDot tone={stateTone(view.state)} />
          <span>{text(view.state)}</span>
          <Badge tone={view.enabled === true ? 'emerald' : 'zinc'}>
            {view.enabled === true ? 'enabled' : 'not enabled'}
          </Badge>
          {view.reason && (
            <span class="text-zinc-500">{text(view.reason)}</span>
          )}
        </div>
      )}
      {read.data?.ok && !view && (
        <p class="text-xs text-zinc-500">
          No dependency view is recorded for this worktree.
        </p>
      )}
      <div class="mt-3 flex flex-wrap gap-2">
        <Button
          compact
          disabled={busy !== null}
          onClick={() => act('verify')}
          variant="secondary"
        >
          {busy === 'verify' ? 'Verifying…' : 'Verify'}
        </Button>
        <Button
          compact
          disabled={busy !== null}
          onClick={() => act('repair')}
          variant="secondary"
        >
          {busy === 'repair' ? 'Preparing…' : 'Prepare repair plan'}
        </Button>
      </div>
      {repairPlan && busy !== 'repair' && (
        <pre class="mt-3 max-h-48 overflow-auto whitespace-pre-wrap border border-zinc-200 p-2 font-mono text-[11px] dark:border-zinc-800">
          {JSON.stringify(repairPlan, null, 2)}
        </pre>
      )}
      <ResultState value={result} />
    </Section>
  );
}

type TargetProps = {
  repo: string;
  name: string;
  toast: (message: string, tone?: Tone) => void;
};

function OperationsControls({ repo, name }: TargetProps) {
  const operations = useVisiblePoll(
    `operations:${repo}/${name}`,
    10_000,
    (signal) =>
      readResource(resourceReadUrl('/api/operations', repo, name), signal)
  );
  const admission = useVisiblePoll('resource-admission', 10_000, (signal) =>
    readResource('/api/resource-admission', signal)
  );
  const events = operations.data?.ok ? array(operations.data.events) : [];
  const leases = admission.data?.ok ? array(admission.data.leases) : [];
  const limits = record(admission.data?.limits);
  return (
    <Section title="Operations & admission">
      <ReadProblem
        failed={operations.failed}
        onRetry={operations.refresh}
        value={operations.data}
      />
      <ReadProblem
        failed={admission.failed}
        onRetry={admission.refresh}
        value={admission.data}
      />
      <div class="grid gap-4 sm:grid-cols-2">
        <div>
          <h3 class="mb-2 font-medium text-sm">Recent operations</h3>
          {events.length ? (
            <ul class="space-y-2 text-xs">
              {events.map((event) => (
                <li class="flex items-center gap-2" key={text(event.id)}>
                  <Badge tone={stateTone(event.state)}>
                    {text(event.state)}
                  </Badge>
                  <span>{text(event.kind)}</span>
                  <span class="text-zinc-500">{text(event.summary, '')}</span>
                </li>
              ))}
            </ul>
          ) : (
            operations.data?.ok && (
              <p class="text-xs text-zinc-500">
                No operation events are recorded.
              </p>
            )
          )}
        </div>
        <div class="min-w-0">
          <h3 class="mb-2 font-medium text-sm">Admission</h3>
          {admission.data?.ok && (
            <div class="mb-2 text-xs text-zinc-500">
              <p>Managed session limit: {text(limits?.maxManagedSessions)}</p>
              <p>
                Free-space reserve:{' '}
                {typeof limits?.lowStorageFloorBytes === 'number' &&
                Number.isFinite(limits.lowStorageFloorBytes)
                  ? formatStorageBytes(limits.lowStorageFloorBytes)
                  : 'unknown'}
              </p>
            </div>
          )}
          {leases.length ? (
            <ul class="space-y-2 text-xs">
              {leases.map((lease) => (
                <li key={text(lease.operationId, text(lease.id))}>
                  <Badge tone={stateTone(lease.ownership)}>
                    {text(lease.ownership)}
                  </Badge>
                  <span class="ml-1">
                    {text(lease.kind)} · ownership{' '}
                    {text(lease.ownership, 'unknown')}
                  </span>
                </li>
              ))}
            </ul>
          ) : admission.data?.ok ? (
            <p class="text-xs text-zinc-500">No active admission leases.</p>
          ) : null}
        </div>
      </div>
    </Section>
  );
}

function SessionControls({ repo, name, toast }: TargetProps) {
  const read = useVisiblePoll(`sessions:${repo}/${name}`, 5000, (signal) =>
    readResource(resourceReadUrl('/api/agent-sessions', repo, name), signal)
  );
  const [ending, setEnding] = useState<string | null>(null);
  const [endReview, setEndReview] = useState<string | null>(null);
  const sessions = read.data?.ok ? array(read.data.sessions) : [];
  async function end(session: Record<string, unknown>) {
    const id = text(session.id, '');
    const checkoutIdentity = session.checkoutIdentity;
    if (!(id && checkoutIdentity) || ending) {
      return;
    }
    setEnding(id);
    const response = await resourceAction('/api/agent-sessions/end', {
      checkoutIdentity,
      name,
      repo,
      sessionId: id,
    });
    setEnding(null);
    if (response.ok) {
      toast('End request sent to the owned session.', 'emerald');
      read.refresh();
    } else {
      toast(`✗ Session could not be ended: ${text(response.error)}`, 'red');
    }
  }
  return (
    <Section title="Owned sessions">
      <ReadProblem
        failed={read.failed}
        onRetry={read.refresh}
        value={read.data}
      />
      {sessions.length ? (
        <ul class="divide-y divide-zinc-200/60 text-xs dark:divide-white/10">
          {sessions.map((session) => {
            const id = text(session.id);
            const canEnd =
              session.ownership === 'owned' &&
              session.state === 'running' &&
              !!session.checkoutIdentity;
            return (
              <li
                class="flex flex-wrap items-center justify-between gap-2 py-2"
                key={id}
              >
                <span>
                  <span class="font-mono">{text(session.tool)}</span> ·{' '}
                  {text(session.state)} · {id}
                </span>
                {canEnd ? (
                  endReview === id ? (
                    <span class="flex items-center gap-2">
                      <Badge tone="amber">End this session?</Badge>
                      <Button
                        compact
                        disabled={ending !== null}
                        onClick={() => end(session)}
                      >
                        {ending === id ? 'Ending…' : 'Confirm end'}
                      </Button>
                      <Button
                        compact
                        disabled={ending !== null}
                        onClick={() => setEndReview(null)}
                        variant="secondary"
                      >
                        Cancel
                      </Button>
                    </span>
                  ) : (
                    <Button
                      compact
                      disabled={ending !== null}
                      onClick={() => setEndReview(id)}
                      variant="secondary"
                    >
                      End
                    </Button>
                  )
                ) : (
                  <Badge tone="amber">
                    {session.ownership === 'owned'
                      ? session.state === 'running'
                        ? 'cannot end'
                        : 'not running'
                      : 'ownership unknown'}
                  </Badge>
                )}
              </li>
            );
          })}
        </ul>
      ) : (
        read.data?.ok && (
          <p class="text-xs text-zinc-500">
            No sessions are registered for this worktree.
          </p>
        )
      )}
    </Section>
  );
}

function CleanupControls({ repo, name, toast }: TargetProps) {
  const [manifest, setManifest] = useState<Record<string, unknown> | null>(
    null
  );
  const [retry, setRetry] = useState<{
    manifestId: string;
    removedPaths: string[];
    retryId: string;
  } | null>(null);
  const [retryReviewed, setRetryReviewed] = useState(false);
  const [result, setResult] = useState<ResourceResult>();
  const [busy, setBusy] = useState<'prepare' | 'execute' | null>(null);
  async function prepare() {
    if (busy) {
      return;
    }
    setBusy('prepare');
    const response = await resourceAction('/api/worktree-cache/prepare', {
      name,
      repo,
    });
    setBusy(null);
    setResult(response);
    if (response.ok && record(response.manifest)) {
      setManifest(record(response.manifest));
      setRetry(null);
      setRetryReviewed(false);
    } else if (!response.ok) {
      toast(`✗ Cleanup preparation failed: ${text(response.error)}`, 'red');
    }
  }
  async function execute() {
    const manifestId = text(manifest?.id, '');
    if (!(manifestId && busy === null && (!retry || retryReviewed))) {
      return;
    }
    setBusy('execute');
    const response = await resourceAction('/api/worktree-cache/execute', {
      ...cleanupExecutionBody(manifestId, retry?.retryId),
      name,
      repo,
    });
    setBusy(null);
    setResult(response);
    if (response.ok) {
      toast('Approved generated-cache cleanup completed.', 'emerald');
      setManifest(null);
      setRetry(null);
    } else if (
      response.code === 'CLEANUP_PARTIAL' &&
      typeof response.retryId === 'string'
    ) {
      setRetry({
        manifestId,
        removedPaths: Array.isArray(response.removedPaths)
          ? response.removedPaths.filter(
              (path): path is string => typeof path === 'string'
            )
          : [],
        retryId: response.retryId,
      });
      setRetryReviewed(false);
      toast(
        'Cleanup partly completed. Review remaining entries before retrying.',
        'amber'
      );
    }
  }
  const entries = array(manifest?.entries);
  const removed = new Set(retry?.removedPaths ?? []);
  const remaining = entries.filter(
    (entry) => !removed.has(text(entry.path, ''))
  );
  return (
    <Section title="Generated cache cleanup">
      <p class="mb-3 text-xs text-zinc-600 dark:text-zinc-300">
        Prepare reads an exact server manifest. It does not delete anything.
        Review it, then execute as a separate action.
      </p>
      {manifest ? (
        <>
          <ul class="mb-3 max-h-48 overflow-auto border border-zinc-200 p-2 font-mono text-[11px] dark:border-zinc-800">
            {(retry ? remaining : entries).length ? (
              (retry ? remaining : entries).map((entry, index) => (
                <li key={`${index}-${text(entry.path)}`}>{text(entry.path)}</li>
              ))
            ) : (
              <li>Manifest {text(manifest.id)} has no remaining entries.</li>
            )}
          </ul>
          {retry && (
            <p class="mb-2 text-signal-amber text-xs" role="status">
              Removed paths: {retry.removedPaths.join(', ') || 'none reported'}.
              Review the remaining manifest entries before retrying.
            </p>
          )}
          <div class="flex flex-wrap gap-2">
            {retry && !retryReviewed ? (
              <Button
                compact
                disabled={busy !== null}
                onClick={() => setRetryReviewed(true)}
                variant="secondary"
              >
                Review retry
              </Button>
            ) : (
              <Button compact disabled={busy !== null} onClick={execute}>
                {busy === 'execute'
                  ? 'Executing…'
                  : retry
                    ? 'Confirm retry'
                    : 'Execute approved cleanup'}
              </Button>
            )}
            <Button
              compact
              disabled={busy !== null}
              onClick={() => {
                setManifest(null);
                setRetry(null);
              }}
              variant="secondary"
            >
              Discard review
            </Button>
          </div>
        </>
      ) : (
        <Button
          compact
          disabled={busy !== null}
          onClick={prepare}
          variant="secondary"
        >
          {busy === 'prepare' ? 'Preparing…' : 'Prepare cleanup review'}
        </Button>
      )}
      <ResultState value={result} />
    </Section>
  );
}

function SetupAttentionControls({ repo, name, toast }: TargetProps) {
  const setup = useVisiblePoll(`setup:${repo}/${name}`, 5000, (signal) =>
    readResource(resourceReadUrl('/api/setup-progress', repo, name), signal)
  );
  const attention = useVisiblePoll(
    `attention:${repo}/${name}`,
    5000,
    (signal) =>
      readResource(resourceReadUrl('/api/attention', repo, name), signal)
  );
  const [busy, setBusy] = useState<string | null>(null);
  const records = setup.data?.ok ? array(setup.data.records) : [];
  const events = attention.data?.ok ? array(attention.data.events) : [];
  async function retry(entry: Record<string, unknown>) {
    const attemptId = entry.attemptId;
    const checkoutIdentity = entry.checkoutIdentity;
    if (!(typeof attemptId === 'string' && checkoutIdentity) || busy) {
      return;
    }
    setBusy(attemptId);
    const response = await resourceAction('/api/setup-progress/retry', {
      attemptId,
      checkoutIdentity,
      name,
      repo,
    });
    setBusy(null);
    if (response.ok) {
      toast('Setup retry accepted.', 'emerald');
      setup.refresh();
    } else {
      toast(`✗ Setup retry failed: ${text(response.error)}`, 'red');
    }
  }
  async function focus(event: Record<string, unknown>) {
    const body = attentionFocusBody(event, repo, name);
    if (!body || busy) {
      return;
    }
    setBusy(body.sessionId);
    const response = await resourceAction('/api/attention/focus', body);
    setBusy(null);
    if (response.ok) {
      toast('Requested focus for the existing terminal.', 'emerald');
    } else {
      toast(`✗ Could not focus the terminal: ${text(response.error)}`, 'red');
    }
  }
  return (
    <Section title="Setup & attention">
      <ReadProblem
        failed={setup.failed}
        onRetry={setup.refresh}
        value={setup.data}
      />
      <ReadProblem
        failed={attention.failed}
        onRetry={attention.refresh}
        value={attention.data}
      />
      <div class="grid gap-4 sm:grid-cols-2">
        <div>
          <h3 class="mb-2 font-medium text-sm">Setup progress</h3>
          {records.length ? (
            <ul class="space-y-2 text-xs">
              {records.map((entry) => {
                const id = text(entry.attemptId, text(entry.id));
                const retryable =
                  !!entry.checkoutIdentity &&
                  typeof entry.attemptId === 'string';
                return (
                  <li class="flex flex-wrap items-center gap-2" key={id}>
                    <Badge tone={stateTone(entry.state ?? entry.stage)}>
                      {text(entry.stage ?? entry.state)}
                    </Badge>
                    <span>{text(entry.error, '')}</span>
                    {retryable && (
                      <Button
                        compact
                        disabled={busy !== null}
                        onClick={() => retry(entry)}
                        variant="secondary"
                      >
                        {busy === id ? 'Retrying…' : 'Retry'}
                      </Button>
                    )}
                  </li>
                );
              })}
            </ul>
          ) : (
            setup.data?.ok && (
              <p class="text-xs text-zinc-500">No durable setup records.</p>
            )
          )}
        </div>
        <div>
          <h3 class="mb-2 font-medium text-sm">Needs attention</h3>
          {events.length ? (
            <ul class="space-y-2 text-xs">
              {events.map((event, index) => (
                <li
                  class="flex flex-wrap items-center gap-2"
                  key={text(event.id, String(index))}
                >
                  <Badge tone={stateTone(event.state)}>
                    {text(event.kind ?? event.state)}
                  </Badge>
                  <span>{text(event.summary ?? event.message, '')}</span>
                  {attentionFocusBody(event, repo, name) && (
                    <Button
                      compact
                      disabled={busy !== null}
                      onClick={() => focus(event)}
                      variant="secondary"
                    >
                      {busy === event.sessionId
                        ? 'Focusing…'
                        : 'Focus terminal'}
                    </Button>
                  )}
                </li>
              ))}
            </ul>
          ) : (
            attention.data?.ok && (
              <p class="text-xs text-zinc-500">No attention events.</p>
            )
          )}
        </div>
      </div>
    </Section>
  );
}

function HeadlessControls({ repo, name, toast }: TargetProps) {
  const read = useVisiblePoll(`headless:${repo}/${name}`, 5000, (signal) =>
    readResource(resourceReadUrl('/api/headless-runs', repo, name), signal)
  );
  const [prompt, setPrompt] = useState('');
  const [review, setReview] = useState(false);
  const [resumeReview, setResumeReview] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const runs = read.data?.ok ? array(read.data.runs) : [];
  async function start() {
    if (!(prompt.trim() && review) || busy) {
      return;
    }
    setBusy('start');
    const response = await resourceAction('/api/headless-runs/start', {
      ...headlessLimits,
      name,
      prompt: prompt.trim(),
      repo,
    });
    setBusy(null);
    if (response.ok) {
      toast('Headless run accepted. Check its status below.', 'emerald');
      setReview(false);
      read.refresh();
    } else {
      toast(`✗ Headless run did not start: ${text(response.error)}`, 'red');
    }
  }
  async function action(
    kind: 'cancel' | 'resume',
    run: Record<string, unknown>
  ) {
    const runId = run.id ?? run.runId;
    if (!(typeof runId === 'string') || busy) {
      return;
    }
    if (kind === 'resume' && (resumeReview !== runId || !prompt.trim())) {
      return;
    }
    setBusy(`${kind}:${runId}`);
    const response = await resourceAction(
      `/api/headless-runs/${kind}`,
      kind === 'resume'
        ? { ...headlessLimits, name, prompt: prompt.trim(), repo, runId }
        : { checkoutIdentity: run.checkoutIdentity, name, repo, runId }
    );
    setBusy(null);
    if (response.ok) {
      toast(`Headless run ${kind} accepted.`, 'emerald');
      setResumeReview(null);
      read.refresh();
    } else {
      toast(`✗ Could not ${kind}: ${text(response.error)}`, 'red');
    }
  }
  return (
    <Section title="Headless runs">
      <p class="mb-3 text-xs text-zinc-600 dark:text-zinc-300">
        Start or resume a Claude Code run with a $2 budget, a 60-minute limit,
        and 64 KiB of retained output.
      </p>
      <ReadProblem
        failed={read.failed}
        onRetry={read.refresh}
        value={read.data}
      />
      <label class="mb-2 flex flex-col gap-1 text-xs">
        Prompt
        <textarea
          class={`${inputCls} min-h-20`}
          onInput={(event) => {
            setPrompt(event.currentTarget.value);
            setReview(false);
            setResumeReview(null);
          }}
          placeholder="Describe the bounded work to run…"
          value={prompt}
        />
      </label>
      {review ? (
        <div class="flex flex-wrap items-center gap-2">
          <Badge tone="amber">Ready to start with this prompt</Badge>
          <Button compact disabled={busy !== null} onClick={start}>
            {busy === 'start' ? 'Starting…' : 'Confirm start'}
          </Button>
          <Button compact onClick={() => setReview(false)} variant="secondary">
            Edit prompt
          </Button>
        </div>
      ) : (
        <Button
          compact
          disabled={!prompt.trim()}
          onClick={() => setReview(true)}
          variant="secondary"
        >
          Review headless start
        </Button>
      )}
      {runs.length ? (
        <ul class="mt-3 divide-y divide-zinc-200/60 text-xs dark:divide-white/10">
          {runs.map((run) => {
            const id = text(run.id ?? run.runId);
            return (
              <li
                class="flex flex-wrap items-center justify-between gap-2 py-2"
                key={id}
              >
                <span>
                  <Badge tone={stateTone(run.state)}>{text(run.state)}</Badge>{' '}
                  <span class="ml-1 font-mono">{id}</span>
                </span>
                <span class="flex gap-2">
                  <Button
                    compact
                    disabled={busy !== null || !run.checkoutIdentity}
                    onClick={() => action('cancel', run)}
                    variant="secondary"
                  >
                    {busy === `cancel:${id}` ? 'Cancelling…' : 'Cancel'}
                  </Button>
                  {resumeReview === id ? (
                    <>
                      <Button
                        compact
                        disabled={busy !== null}
                        onClick={() => action('resume', run)}
                      >
                        {busy === `resume:${id}`
                          ? 'Resuming…'
                          : 'Confirm resume'}
                      </Button>
                      <Button
                        compact
                        disabled={busy !== null}
                        onClick={() => setResumeReview(null)}
                        variant="secondary"
                      >
                        Edit
                      </Button>
                    </>
                  ) : (
                    <Button
                      compact
                      disabled={busy !== null || !prompt.trim()}
                      onClick={() => setResumeReview(id)}
                      variant="secondary"
                    >
                      Review resume
                    </Button>
                  )}
                </span>
              </li>
            );
          })}
        </ul>
      ) : (
        read.data?.ok && (
          <p class="mt-3 text-xs text-zinc-500">
            No headless runs for this worktree.
          </p>
        )
      )}
    </Section>
  );
}

function McpActionsControls({ toast }: { toast: TargetProps['toast'] }) {
  const read = useVisiblePoll('mcp-actions', null, (signal) =>
    readResource('/api/mcp-actions', signal)
  );
  const [actionId, setActionId] = useState('');
  const [input, setInput] = useState('{}');
  const [confirmation, setConfirmation] = useState<string | null>(null);
  const [busy, setBusy] = useState<'preflight' | 'invoke' | null>(null);
  const reviewGate = useRef(createReviewGeneration()).current;
  const actions = read.data?.ok ? array(read.data.actions) : [];
  function invalidate() {
    reviewGate.invalidate();
    setConfirmation(null);
  }
  async function preflight() {
    if (!(actionId && !busy)) {
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(input);
    } catch {
      toast('✗ MCP input must be valid JSON.', 'red');
      return;
    }
    const requestRevision = reviewGate.begin();
    setBusy('preflight');
    const response = await resourceAction('/api/mcp-actions/preflight', {
      actionId,
      input: parsed,
    });
    if (!reviewGate.isCurrent(requestRevision)) {
      setBusy(null);
      return;
    }
    setBusy(null);
    const token = confirmationToken(response);
    if (response.ok && token) {
      setConfirmation(token);
      toast('MCP action reviewed. Confirm to invoke.', 'emerald');
    } else {
      toast(`✗ MCP preflight failed: ${text(response.error)}`, 'red');
    }
  }
  async function invoke() {
    if (!(confirmation && actionId && !busy)) {
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(input);
    } catch {
      return;
    }
    const requestRevision = reviewGate.begin();
    setBusy('invoke');
    const response = await resourceAction('/api/mcp-actions/invoke', {
      actionId,
      confirmation,
      input: parsed,
    });
    if (!reviewGate.isCurrent(requestRevision)) {
      setBusy(null);
      return;
    }
    setBusy(null);
    if (response.ok) {
      toast('MCP action invoked.', 'emerald');
      setConfirmation(null);
    } else {
      toast(`✗ MCP invocation failed: ${text(response.error)}`, 'red');
    }
  }
  return (
    <Section title="MCP actions">
      <ReadProblem
        failed={read.failed}
        onRetry={read.refresh}
        value={read.data}
      />
      {actions.length ? (
        <>
          <label class="flex flex-col gap-1 text-xs">
            Connected action
            <select
              class={inputCls}
              onChange={(event) => {
                setActionId(event.currentTarget.value);
                invalidate();
              }}
              value={actionId}
            >
              <option value="">Select an action</option>
              {actions.map((action) => (
                <option key={text(action.id)} value={text(action.id)}>
                  {text(action.title ?? action.id)}
                </option>
              ))}
            </select>
          </label>
          <label class="mt-2 flex flex-col gap-1 text-xs">
            Reviewed JSON input
            <textarea
              class={`${inputCls} min-h-20 font-mono`}
              onInput={(event) => {
                setInput(event.currentTarget.value);
                invalidate();
              }}
              value={input}
            />
          </label>
          <div class="mt-3 flex flex-wrap gap-2">
            {confirmation ? (
              <>
                <Badge tone="amber">Reviewed input ready</Badge>
                <Button compact disabled={busy !== null} onClick={invoke}>
                  {busy === 'invoke' ? 'Invoking…' : 'Confirm invoke'}
                </Button>
              </>
            ) : (
              <Button
                compact
                disabled={busy !== null || !actionId}
                onClick={preflight}
                variant="secondary"
              >
                {busy === 'preflight' ? 'Reviewing…' : 'Preflight action'}
              </Button>
            )}
          </div>
        </>
      ) : (
        read.data?.ok && (
          <p class="text-xs text-zinc-500">
            No reviewed MCP actions are saved.
          </p>
        )
      )}
    </Section>
  );
}

export function WorktreeResourceControls(props: TargetProps) {
  return (
    <>
      <DeferredDetails label="Storage, sessions & operations">
        {(open) =>
          open ? (
            <div key={`${props.repo}/${props.name}`}>
              <StorageControls {...props} />
              <DependencyControls {...props} />
              <OperationsControls {...props} />
              <SessionControls {...props} />
              <CleanupControls {...props} />
              <SetupAttentionControls {...props} />
              <HeadlessControls {...props} />
              <McpActionsControls toast={props.toast} />
            </div>
          ) : (
            <p class="text-xs text-zinc-500">
              Open to load worktree resource status. No storage scan runs until
              you choose Inspect.
            </p>
          )
        }
      </DeferredDetails>
    </>
  );
}

export function GithubWorkflowControls(props: TargetProps) {
  return (
    <DeferredDetails label="Workflows & dispatch">
      {(open) =>
        open ? (
          <GithubWorkflowContents
            key={`${props.repo}/${props.name}`}
            {...props}
          />
        ) : (
          <p class="text-xs text-zinc-500">
            Open to load workflows and recent runs.
          </p>
        )
      }
    </DeferredDetails>
  );
}

export function PrReviewHandoff({
  artifacts,
  name,
  repo,
  toast,
}: TargetProps & {
  artifacts: {
    checkoutIdentity?: unknown;
    findingRecords?: Record<string, unknown>[];
    headSha: string;
    prNumber: number;
    skill: string;
    snapshot: string;
    stale: boolean;
  }[];
}) {
  if (!artifacts.length) {
    return null;
  }
  return (
    <DeferredDetails label="Hand selected review findings to a session">
      {(open) =>
        open ? (
          <PrReviewHandoffContents
            artifacts={artifacts}
            key={`${repo}/${name}:${JSON.stringify(artifacts)}`}
            name={name}
            repo={repo}
            toast={toast}
          />
        ) : (
          <p class="text-xs text-zinc-500">
            Choose an existing owned session and edit the handoff before
            sending. Nothing is submitted automatically.
          </p>
        )
      }
    </DeferredDetails>
  );
}

function PrReviewHandoffContents({
  artifacts,
  name,
  repo,
  toast,
}: TargetProps & {
  artifacts: {
    checkoutIdentity?: unknown;
    findingRecords?: Record<string, unknown>[];
    headSha: string;
    prNumber: number;
    skill: string;
    snapshot: string;
    stale: boolean;
  }[];
}) {
  const sessions = useVisiblePoll(
    `handoff-sessions:${repo}/${name}`,
    null,
    (signal) =>
      readResource(resourceReadUrl('/api/agent-sessions', repo, name), signal)
  );
  const [artifactSkill, setArtifactSkill] = useState(artifacts[0]?.skill ?? '');
  const [sessionId, setSessionId] = useState('');
  const [findings, setFindings] = useState('');
  const [review, setReview] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const owned = sessions.data?.ok
    ? array(sessions.data.sessions).filter((session) => {
        const terminal = record(session.terminal);
        return (
          session.ownership === 'owned' &&
          session.state === 'running' &&
          !!session.checkoutIdentity &&
          terminal?.kind === 'ghostty' &&
          typeof terminal.id === 'string'
        );
      })
    : [];
  const selectedArtifact = artifacts.find(
    (artifact) => artifact.skill === artifactSkill
  );
  const selectedSession = owned.find((session) => session.id === sessionId);
  // ponytail: manual excerpt until review artifacts expose structured findings.
  const selectedFindings = handoffFindings(findings);
  const reviewKey = JSON.stringify({
    artifact: selectedArtifact,
    checkoutIdentity: selectedSession?.checkoutIdentity,
    findings: selectedFindings,
    sessionId,
    terminal: selectedSession?.terminal,
  });
  async function handoff() {
    if (
      !(
        review === reviewKey &&
        selectedArtifact &&
        selectedSession?.checkoutIdentity &&
        selectedFindings.length
      ) ||
      busy
    ) {
      return;
    }
    setBusy(true);
    const result = await resourceAction('/api/pr-review/handoff', {
      artifact: {
        checkoutIdentity: selectedArtifact.checkoutIdentity,
        headSha: selectedArtifact.headSha,
        prNumber: selectedArtifact.prNumber,
        skill: selectedArtifact.skill,
        snapshot: selectedArtifact.snapshot,
        stale: selectedArtifact.stale,
      },
      checkoutIdentity: selectedSession.checkoutIdentity,
      findings: selectedFindings,
      name,
      repo,
      sessionId,
    });
    setBusy(false);
    if (result.ok) {
      toast(
        'Review handoff was sent to the selected existing session.',
        'emerald'
      );
      setReview(null);
    } else {
      toast(`✗ Handoff was not confirmed: ${text(result.error)}`, 'red');
    }
  }
  return (
    <Section title="Review handoff">
      <ReadProblem
        failed={sessions.failed}
        onRetry={sessions.refresh}
        value={sessions.data}
      />
      <div class="grid gap-2 sm:grid-cols-2">
        <label class="flex flex-col gap-1 text-xs">
          Artifact
          <select
            class={inputCls}
            onChange={(event) => {
              setArtifactSkill(event.currentTarget.value);
              setFindings('');
              setReview(null);
            }}
            value={artifactSkill}
          >
            {artifacts.map((artifact) => (
              <option key={artifact.skill} value={artifact.skill}>
                {artifact.skill} · PR {artifact.prNumber}
              </option>
            ))}
          </select>
        </label>
        <label class="flex flex-col gap-1 text-xs">
          Existing owned running session
          <select
            class={inputCls}
            onChange={(event) => {
              setSessionId(event.currentTarget.value);
              setReview(null);
            }}
            value={sessionId}
          >
            <option value="">Select a session</option>
            {owned.map((session) => (
              <option key={text(session.id)} value={text(session.id)}>
                {text(session.tool)} · {text(session.id)}
              </option>
            ))}
          </select>
        </label>
      </div>
      <label class="mt-2 flex flex-col gap-1 text-xs">
        Selected findings (up to 800 characters)
        <textarea
          class={`${inputCls} min-h-20`}
          maxLength={800}
          onInput={(event) => {
            setFindings(event.currentTarget.value);
            setReview(null);
          }}
          placeholder="Paste the findings to hand off, then edit the requested change…"
          value={findings}
        />
      </label>
      {review === reviewKey ? (
        <div class="mt-2 flex flex-wrap items-center gap-2">
          <Badge tone="amber">Ready for selected session</Badge>
          <Button compact disabled={busy} onClick={handoff}>
            {busy ? 'Sending…' : 'Confirm handoff'}
          </Button>
          <Button
            compact
            disabled={busy}
            onClick={() => setReview(null)}
            variant="secondary"
          >
            Edit
          </Button>
        </div>
      ) : (
        <Button
          compact
          disabled={
            !(selectedArtifact && selectedSession && selectedFindings.length)
          }
          onClick={() => setReview(reviewKey)}
          variant="secondary"
        >
          Review handoff
        </Button>
      )}
      {sessions.data?.ok && !owned.length && (
        <p class="mt-2 text-xs text-zinc-500">
          No owned running session with a verified native-terminal transport is
          available. The server will return the exact adapter refusal; Setu will
          not launch another terminal.
        </p>
      )}
    </Section>
  );
}

function GithubWorkflowContents({ repo, name, toast }: TargetProps) {
  const workflows = useVisiblePoll(
    `workflows:${repo}/${name}`,
    null,
    (signal) =>
      readResource(resourceReadUrl('/api/github/workflows', repo, name), signal)
  );
  const runs = useVisiblePoll(`workflow-runs:${repo}/${name}`, null, (signal) =>
    readResource(resourceReadUrl('/api/github/runs', repo, name), signal)
  );
  const [workflow, setWorkflow] = useState('');
  const [ref, setRef] = useState(name);
  const [inputs, setInputs] = useState('{}');
  const [confirmation, setConfirmation] = useState<string | null>(null);
  const [busy, setBusy] = useState<'review' | 'dispatch' | null>(null);
  const reviewGate = useRef(createReviewGeneration()).current;
  const items = workflows.data?.ok ? array(workflows.data.workflows) : [];
  const recent = runs.data?.ok ? array(runs.data.runs) : [];
  function invalidate() {
    reviewGate.invalidate();
    setConfirmation(null);
  }
  async function dispatch() {
    let parsed: unknown;
    try {
      parsed = JSON.parse(inputs);
    } catch {
      toast('✗ Workflow inputs must be valid JSON.', 'red');
      return;
    }
    if (!(workflow && ref.trim()) || busy) {
      return;
    }
    const requestRevision = reviewGate.begin();
    setBusy(confirmation ? 'dispatch' : 'review');
    const response = await resourceAction('/api/github/dispatch', {
      ...(confirmation ? { confirmation } : {}),
      inputs: parsed,
      name,
      ref: ref.trim(),
      repo,
      workflow,
    });
    if (!reviewGate.isCurrent(requestRevision)) {
      setBusy(null);
      return;
    }
    setBusy(null);
    const token = confirmationToken(response);
    if (
      !confirmation &&
      response.code === 'GITHUB_DISPATCH_CONFIRMATION_REQUIRED' &&
      token
    ) {
      setConfirmation(token);
      toast('Workflow dispatch reviewed. Confirm to send it.', 'emerald');
    } else if (response.ok) {
      toast('Workflow dispatch accepted.', 'emerald');
      setConfirmation(null);
      runs.refresh();
    } else {
      toast(`✗ Workflow dispatch failed: ${text(response.error)}`, 'red');
    }
  }
  return (
    <Section title="GitHub workflows">
      <ReadProblem
        failed={workflows.failed}
        onRetry={workflows.refresh}
        value={workflows.data}
      />
      <ReadProblem
        failed={runs.failed}
        onRetry={runs.refresh}
        value={runs.data}
      />
      {items.length ? (
        <label class="flex flex-col gap-1 text-xs">
          Workflow
          <select
            class={inputCls}
            onChange={(event) => {
              setWorkflow(event.currentTarget.value);
              invalidate();
            }}
            value={workflow}
          >
            <option value="">Select workflow</option>
            {items.map((item) => {
              const value = workflowValue(item.id ?? item.path);
              return value ? (
                <option key={value} value={value}>
                  {text(item.name ?? item.path)}
                </option>
              ) : null;
            })}
          </select>
        </label>
      ) : (
        workflows.data?.ok && (
          <p class="text-xs text-zinc-500">No workflows were returned.</p>
        )
      )}
      <div class="mt-2 grid gap-2 sm:grid-cols-2">
        <label class="flex flex-col gap-1 text-xs">
          Ref
          <input
            class={inputCls}
            onInput={(event) => {
              setRef(event.currentTarget.value);
              invalidate();
            }}
            value={ref}
          />
        </label>
        <label class="flex flex-col gap-1 text-xs">
          Inputs (JSON)
          <input
            class={`${inputCls} font-mono`}
            onInput={(event) => {
              setInputs(event.currentTarget.value);
              invalidate();
            }}
            value={inputs}
          />
        </label>
      </div>
      <div class="mt-3 flex flex-wrap items-center gap-2">
        {confirmation && <Badge tone="amber">Review token ready</Badge>}
        <Button
          compact
          disabled={busy !== null || !workflow}
          onClick={dispatch}
          variant={confirmation ? 'primary' : 'secondary'}
        >
          {busy === 'review'
            ? 'Reviewing…'
            : busy === 'dispatch'
              ? 'Dispatching…'
              : confirmation
                ? 'Confirm dispatch'
                : 'Review dispatch'}
        </Button>
      </div>
      {recent.length ? (
        <ul class="mt-3 divide-y divide-zinc-200/60 text-xs dark:divide-white/10">
          {recent.slice(0, 8).map((run) => (
            <li class="flex flex-wrap gap-2 py-2" key={text(run.databaseId)}>
              <Badge tone={stateTone(run.status ?? run.conclusion)}>
                {text(run.status ?? run.conclusion)}
              </Badge>
              <span>{text(run.workflowName)}</span>
              <span class="text-zinc-500">{text(run.headBranch, '')}</span>
            </li>
          ))}
        </ul>
      ) : (
        runs.data?.ok && (
          <p class="mt-3 text-xs text-zinc-500">No recent workflow runs.</p>
        )
      )}
    </Section>
  );
}
