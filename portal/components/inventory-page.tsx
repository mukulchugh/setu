// Read-only inventory of every Git worktree Setu can find, including checkouts it
// does not manage. It helps reuse an existing checkout and review cleanup
// risks; it never creates, adopts, stops or removes anything.
import { useState } from 'preact/hooks';
import {
  type InventoryRow,
  readInventory,
  type WorkspaceInventory,
} from '../inventory-read';
import { inputCls, PageHeader, Section } from '../ui';
import { Badge } from '../ui/badge';
import { Button, type Tone } from '../ui/button';
import { useVisiblePoll } from '../use-visible-poll';
import { Pagination } from './pagination';

const PAGE_SIZE = 18;
const FILTERS = {
  all: 'All checkouts',
  missing: 'Missing or uninspected',
  registered: 'Registered with Setu',
  unregistered: 'Not registered',
} as const;
type Filter = keyof typeof FILTERS;

function matchesFilter(row: InventoryRow, filter: Filter) {
  if (filter === 'registered') {
    return row.registered;
  }
  if (filter === 'unregistered') {
    return !row.registered;
  }
  if (filter === 'missing') {
    return row.presence !== 'present' || row.discovery === 'unknown';
  }
  return true;
}

function runtimeLabel(row: InventoryRow): { text: string; tone: Tone } {
  if (row.operation) {
    return {
      text: `${row.operation.kind} ${row.operation.phase}`,
      tone: 'amber',
    };
  }
  if (row.active === true) {
    // Includes queued/unknown reservations and supporting processes, not proof of liveness.
    return { text: 'Active in Setu', tone: 'emerald' };
  }
  if (row.active === false) {
    return { text: 'Inactive in Setu', tone: 'zinc' };
  }
  return { text: 'Runtime unknown', tone: 'amber' };
}

function Counts({ inventory }: { inventory: WorkspaceInventory }) {
  const { counts } = inventory;
  const items: [string, number | null, string][] = [
    ['Registered in Setu', counts.registered, 'Setu registry rows'],
    [
      'Linked Git worktrees',
      counts.linked,
      counts.linked === null
        ? 'Unknown while any repository check fails'
        : 'Across registered repositories',
    ],
    [
      'Observed links',
      counts.observedLinked,
      'Seen in repositories that answered',
    ],
    ['Not registered', counts.unregistered, 'Existing checkouts outside Setu'],
    ['Missing directories', counts.missing, 'Confirmed absent on disk'],
  ];
  return (
    <dl class="glass-panel mb-6 grid grid-cols-2 gap-px text-sm sm:grid-cols-3 lg:grid-cols-5">
      {items.map(([label, value, hint]) => (
        <div class="min-w-0 px-4 py-3" key={label}>
          <dt class="text-zinc-600 dark:text-zinc-300">{label}</dt>
          <dd class="mt-1 font-mono font-semibold text-2xl text-zinc-900 tabular-nums dark:text-zinc-100">
            {value ?? 'Unknown'}
          </dd>
          <dd class="mt-1 text-xs text-zinc-600 dark:text-zinc-300">{hint}</dd>
        </div>
      ))}
    </dl>
  );
}

function InventoryItem({
  row,
  gates,
  onCopyPath,
  onOpenWorktree,
}: {
  row: InventoryRow;
  gates: Map<string, string>;
  onCopyPath: (path: string) => void;
  onOpenWorktree: (repo: string, name: string) => void;
}) {
  const runtime = runtimeLabel(row);
  const { name } = row;
  const title = name ?? row.branch ?? 'Detached HEAD';
  return (
    <li class="flex min-w-0 flex-col gap-2 border-zinc-200/60 border-b px-4 py-4 last:border-0 dark:border-white/10">
      <div class="flex min-w-0 flex-wrap items-baseline gap-2">
        <span class="worktree-name font-semibold text-zinc-900 dark:text-zinc-100">
          {title}
        </span>
        <span class="board-mono font-bold text-[10px] text-zinc-600 dark:text-zinc-300">
          {row.repo}
        </span>
        <Badge tone={row.registered ? 'emerald' : 'amber'}>
          {row.registered ? 'Registered' : 'Not registered'}
        </Badge>
        <Badge tone={runtime.tone}>{runtime.text}</Badge>
        {row.presence !== 'present' && (
          <Badge tone={row.presence === 'missing' ? 'red' : 'amber'}>
            {row.presence === 'missing' ? 'Directory missing' : 'Not inspected'}
          </Badge>
        )}
        {row.discovery === 'unknown' && (
          <Badge tone="amber">Git discovery unknown</Badge>
        )}
        {row.linked === false && <Badge tone="red">Not in Git list</Badge>}
        {row.detached && <Badge tone="amber">Detached HEAD</Badge>}
        {row.locked && <Badge tone="amber">Locked</Badge>}
        {row.prunable && <Badge tone="amber">Git prunable</Badge>}
      </div>
      <p class="break-all font-mono text-xs text-zinc-700 dark:text-zinc-300">
        {row.path}
      </p>
      <p class="flex flex-wrap gap-x-4 gap-y-1 text-xs text-zinc-600 dark:text-zinc-300">
        {row.branch && row.name !== row.branch && (
          <span class="break-all">Branch {row.branch}</span>
        )}
        {row.head && (
          <span class="font-mono">HEAD {row.head.slice(0, 12)}</span>
        )}
        {row.port !== null && <span>Port {row.port}</span>}
        <span>Owner unknown</span>
        <span>Last use unknown</span>
        <span>
          Last portal activity (not last use):{' '}
          {row.lastPortalActivityAt === null
            ? 'none recorded'
            : new Date(row.lastPortalActivityAt).toLocaleString()}
        </span>
      </p>
      <div class="flex flex-wrap items-center gap-2">
        <Button
          aria-label={`Copy path for ${title}`}
          compact
          onClick={() => onCopyPath(row.path)}
          variant="secondary"
        >
          Copy path
        </Button>
        {row.registered && name && (
          <Button
            compact
            onClick={() => onOpenWorktree(row.repo, name)}
            variant="secondary"
          >
            Open in Setu
          </Button>
        )}
      </div>
      <details class="text-sm">
        <summary class="min-h-11 cursor-pointer py-2 text-zinc-700 dark:text-zinc-200">
          Review before cleanup ({row.review.reasons.length} reasons,{' '}
          {row.review.requiredGates.length} gates)
        </summary>
        <ul class="list-disc py-1 pl-5 text-zinc-700 dark:text-zinc-300">
          {row.review.reasons.map((reason) => (
            <li key={reason}>{reason}</li>
          ))}
          {row.review.requiredGates.map((id) => (
            <li key={id}>{gates.get(id) ?? id}</li>
          ))}
        </ul>
      </details>
    </li>
  );
}

export function InventoryPage({
  onBack,
  onOpenWorktree,
  toast,
}: {
  onBack: () => void;
  onOpenWorktree: (repo: string, name: string) => void;
  toast: (msg: string, tone?: Tone) => void;
}) {
  // The backend caches discovery for 30 seconds; a slow visible poll is enough.
  const { data, failed, refresh } = useVisiblePoll(
    'workspace-inventory',
    60_000,
    readInventory
  );
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState<Filter>('all');
  const [page, setPage] = useState(0);
  const inventory = data?.kind === 'ready' ? data.inventory : null;
  const needle = search.trim().toLowerCase();
  const matches = (inventory?.rows ?? []).filter(
    (row) =>
      matchesFilter(row, filter) &&
      `${row.repo} ${row.name ?? ''} ${row.path} ${row.branch ?? ''}`
        .toLowerCase()
        .includes(needle)
  );
  const pageCount = Math.max(1, Math.ceil(matches.length / PAGE_SIZE));
  const currentPage = Math.min(page, pageCount - 1);
  const gates = new Map(
    (inventory?.reviewGates ?? []).map((gate) => [gate.id, gate.label])
  );
  const failedRepos = (inventory?.repositories ?? []).filter(
    (repo) => repo.state !== 'ready'
  );

  // navigator.clipboard is undefined on non-secure origins such as http://quivly.local.
  async function copyPath(path: string) {
    try {
      await navigator.clipboard.writeText(path);
      toast('Copied checkout path', 'emerald');
    } catch {
      toast(`✗ Couldn't copy. Path: ${path}`, 'red');
    }
  }

  return (
    <div class="portal-page mx-auto max-w-5xl px-4 py-6 sm:px-6">
      <PageHeader
        actions={
          <Button compact onClick={refresh} variant="secondary">
            Refresh inventory
          </Button>
        }
        back={{ label: 'All worktrees', onClick: onBack }}
        subtitle={
          <span class="block max-w-2xl text-sm text-zinc-600 dark:text-zinc-300">
            Every Git worktree Setu can find, including checkouts it does not
            manage. Reuse an existing checkout before creating another. This
            view is read-only: it never creates, adopts or removes a checkout.
          </span>
        }
        title="Worktree inventory"
      />

      {data?.kind === 'unavailable' && (
        <p class="read-notice" role="status">
          The running portal does not include the inventory yet. It appears
          after the portal is restarted with the current Setu source.
        </p>
      )}
      {failed && (
        <p class="read-notice" role="status">
          Could not read the inventory.{' '}
          {inventory ? 'Showing the last successful read. ' : ''}
          <button class="underline" onClick={refresh} type="button">
            Retry
          </button>
        </p>
      )}
      {data === undefined && !failed && (
        <p class="empty-state">Checking repositories…</p>
      )}

      {inventory && (
        <>
          <p class="mb-3 text-xs text-zinc-600 dark:text-zinc-300">
            Checked {new Date(inventory.checkedAt).toLocaleTimeString()}.
            Ownership and last use are not tracked, so both show as unknown.
          </p>
          {inventory.state === 'partial' && (
            <div class="read-notice" role="status">
              <p>
                Some repositories could not be checked. Their checkouts may be
                missing from this list, and the linked total is unknown.
              </p>
              <ul class="mt-1 list-disc pl-5">
                {failedRepos.map((repo) => (
                  <li key={repo.repo}>
                    {repo.repo}: {repo.error ?? 'discovery state unknown'}
                  </li>
                ))}
              </ul>
            </div>
          )}
          <Counts inventory={inventory} />

          {!!inventory.reviewGates.length && (
            <Section title="Before removing any checkout">
              <ul class="list-disc pl-5 text-sm text-zinc-700 leading-relaxed dark:text-zinc-300">
                {inventory.reviewGates.map((gate) => (
                  <li key={gate.id}>{gate.label}</li>
                ))}
              </ul>
            </Section>
          )}

          <div class="page-toolbar">
            <label htmlFor="inventory-search">
              Search checkouts
              <input
                class={inputCls}
                id="inventory-search"
                onInput={(e) => {
                  setSearch(e.currentTarget.value);
                  setPage(0);
                }}
                placeholder="Project, name, path or branch…"
                value={search}
              />
            </label>
            <label htmlFor="inventory-filter">
              Show
              <select
                class={inputCls}
                id="inventory-filter"
                onChange={(e) => {
                  setFilter(e.currentTarget.value as Filter);
                  setPage(0);
                }}
                value={filter}
              >
                {Object.entries(FILTERS).map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <p class="mb-3 text-sm text-zinc-600 dark:text-zinc-300">
            {matches.length} of {inventory.rows.length} checkouts
          </p>
          {matches.length ? (
            <ul class="glass-panel text-sm">
              {matches
                .slice(currentPage * PAGE_SIZE, (currentPage + 1) * PAGE_SIZE)
                .map((row) => (
                  <InventoryItem
                    gates={gates}
                    key={row.id}
                    onCopyPath={copyPath}
                    onOpenWorktree={onOpenWorktree}
                    row={row}
                  />
                ))}
            </ul>
          ) : (
            <p class="empty-state">
              {needle || filter !== 'all'
                ? 'No checkouts match this search.'
                : 'No linked worktrees were found.'}
            </p>
          )}
          <Pagination
            onPage={setPage}
            page={currentPage}
            pageCount={pageCount}
          />
        </>
      )}
    </div>
  );
}
