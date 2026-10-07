export interface WorktreeListRow {
  active: boolean;
  ahead: number;
  createdAt: number | null;
  dirty: number | null;
  domain: string;
  key: string;
  label: string;
  lastCommitAt: number | null;
  lifecycleError?: { code?: string; error?: string } | null;
  name: string;
  operation?: { kind: string; phase: string; error?: string } | null;
  phase?: string;
  queued?: boolean;
  queuePosition?: number | null;
  repo: string;
  starting?: boolean;
  stopping?: boolean;
}
export type WorktreeState =
  | 'attention'
  | 'stopping'
  | 'starting'
  | 'running'
  | 'queued'
  | 'stopped';
export type WorktreeSort = 'recent' | 'name' | 'created';
export const STOPPED_PAGE_SIZE = 18;

type LifecycleRow = Pick<
  WorktreeListRow,
  | 'active'
  | 'starting'
  | 'stopping'
  | 'queued'
  | 'phase'
  | 'operation'
  | 'lifecycleError'
>;
export function worktreeState(w: LifecycleRow): WorktreeState {
  if (w.phase === 'unknown' || w.operation?.phase === 'unknown') {
    return 'attention';
  }
  if (w.stopping) {
    return 'stopping';
  }
  if (w.starting) {
    return 'starting';
  }
  if (w.active) {
    return 'running';
  }
  return w.queued ? 'queued' : 'stopped';
}

export function projectWorktrees<T extends WorktreeListRow>(
  rows: T[],
  options: {
    project: string;
    search: string;
    dirty: boolean;
    ahead: boolean;
    sort: WorktreeSort;
    page: number;
  }
) {
  const needle = options.search.trim().toLowerCase();
  const all = [...new Map(rows.map((w) => [w.key, w])).values()];
  const order: Record<WorktreeState, number> = {
    attention: -1,
    queued: 3,
    running: 0,
    starting: 1,
    stopped: 4,
    stopping: 2,
  };
  const byIdentity = (a: T, b: T) =>
    a.repo.localeCompare(b.repo) || a.name.localeCompare(b.name);
  const active = all
    .filter((w) => worktreeState(w) !== 'stopped')
    .sort((a, b) => {
      const group = order[worktreeState(a)] - order[worktreeState(b)];
      const queue =
        worktreeState(a) === 'queued' && worktreeState(b) === 'queued'
          ? (a.queuePosition ?? Number.POSITIVE_INFINITY) -
            (b.queuePosition ?? Number.POSITIVE_INFINITY)
          : 0;
      return group || queue || byIdentity(a, b);
    });
  const allStopped = all.filter((w) => worktreeState(w) === 'stopped');
  const stopped = allStopped
    .filter((w) => options.project === 'all' || w.repo === options.project)
    .filter((w) => !options.dirty || w.dirty === null || w.dirty > 0)
    .filter((w) => !options.ahead || w.ahead > 0)
    .filter(
      (w) =>
        !needle ||
        `${w.name} ${w.repo} ${w.label} ${w.domain}`
          .toLowerCase()
          .includes(needle)
    )
    .sort((a, b) => {
      const selected =
        options.sort === 'recent'
          ? (b.lastCommitAt ?? 0) - (a.lastCommitAt ?? 0)
          : options.sort === 'created'
            ? (b.createdAt ?? 0) - (a.createdAt ?? 0)
            : a.name.localeCompare(b.name);
      return selected || byIdentity(a, b);
    });
  const pageCount = Math.max(1, Math.ceil(stopped.length / STOPPED_PAGE_SIZE));
  const page = Math.max(0, Math.min(options.page, pageCount - 1));
  return {
    active,
    page,
    pageCount,
    pageRows: stopped.slice(
      page * STOPPED_PAGE_SIZE,
      (page + 1) * STOPPED_PAGE_SIZE
    ),
    stopped,
    stoppedTotal: allStopped.length,
  };
}

// Both card and detail invoke this decision; labels never choose an endpoint.
export function lifecycleControl(w: LifecycleRow, pendingStart = false) {
  const state = worktreeState(w);
  if (w.operation?.phase === 'unknown') {
    return { action: null, label: 'Needs attention' } as const;
  }
  if (w.phase === 'unknown') {
    return { action: 'stop', label: 'Retry Stop' } as const;
  }
  if (state === 'stopping') {
    return { action: null, label: 'Stopping…' } as const;
  }
  if (state === 'queued') {
    return { action: 'stop', label: 'Cancel queue' } as const;
  }
  if (state === 'running' || state === 'starting') {
    return { action: 'stop', label: 'Stop' } as const;
  }
  if (pendingStart) {
    return { action: null, label: 'Starting…' } as const;
  }
  return { action: 'start', label: 'Start' } as const;
}

export function worktreeIssue(w: LifecycleRow): string | null {
  if (w.operation?.phase === 'unknown') {
    return `${w.operation.kind} completion is unconfirmed. The worktree remains reserved; inspect its status and logs before taking another action.`;
  }
  if (w.phase === 'unknown') {
    return (
      w.lifecycleError?.error ||
      'Runtime state is unknown. Retry Stop to reconcile the owned process before starting again.'
    );
  }
  return (
    w.lifecycleError?.error ||
    (w.operation?.phase === 'failed' ? (w.operation.error ?? null) : null)
  );
}

export function commandSelection<
  T extends WorktreeListRow & { branch?: string },
>(rows: T[], query: string, selectedKey: string | null) {
  const needle = query.trim().toLowerCase();
  const matches = needle
    ? rows.filter((w) =>
        `${w.name} ${w.repo} ${w.label} ${w.domain} ${w.branch ?? ''}`
          .toLowerCase()
          .includes(needle)
      )
    : rows;
  const results = matches.slice(0, 8);
  const selectedIndex = Math.max(
    0,
    results.findIndex((w) => w.key === selectedKey)
  );
  return {
    matchCount: matches.length,
    results,
    selected: results[selectedIndex],
    selectedIndex,
  };
}

// Full snapshots also carry capacity and active-process metrics. Preserve unchanged
// rows so those updates do not redraw every stopped worktree's menus and metadata.
export function reuseWorktreeRows<T extends { key: string }>(
  previous: T[],
  incoming: T[]
): T[] {
  const byKey = new Map(previous.map((row) => [row.key, row]));
  const next = incoming.map((row) => {
    const old = byKey.get(row.key);
    return old && JSON.stringify(old) === JSON.stringify(row) ? old : row;
  });
  return next.length === previous.length &&
    next.every((row, index) => row === previous[index])
    ? previous
    : next;
}
