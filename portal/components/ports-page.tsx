import type { ComponentChildren } from 'preact';
import { useRef, useState } from 'preact/hooks';
import { post } from '../api';
import { inputCls, PageHeader } from '../ui';
import { Badge } from '../ui/badge';
import { Button } from '../ui/button';
import { readArray, useVisiblePoll } from '../use-visible-poll';

interface PortInfo {
  cmd: string;
  pid: string;
  port: number;
  worktree: string | null;
}

export function PortsPage({ onBack }: { onBack: () => void }) {
  const {
    data,
    failed,
    refresh: load,
  } = useVisiblePoll('ports', 3000, (signal) =>
    readArray<PortInfo>('/api/ports', signal)
  );
  const ports = data ?? [];
  const loaded = data !== undefined;
  const [search, setSearch] = useState('');
  const [actionError, setActionError] = useState<string | null>(null);
  const pending = useRef(new Set<number>());
  const [busy, setBusy] = useState(new Set<number>());
  const matches = ports.filter((p) =>
    `${p.port} ${p.pid} ${p.cmd} ${p.worktree ?? ''}`
      .toLowerCase()
      .includes(search.trim().toLowerCase())
  );

  async function stop(port: PortInfo) {
    if (pending.current.has(port.port)) {
      return;
    }
    const owner = port.worktree
      ? `Setu worktree ${port.worktree}`
      : `${port.cmd}, PID ${port.pid}`;
    if (
      // biome-ignore lint/suspicious/noAlert: Existing confirmation gates the only /api/ports/kill mutation after its owner warning.
      !confirm(
        `Stop ${owner} on port ${port.port}? Setu will resolve the current listener before stopping it. An unregistered process may belong to another application.`
      )
    ) {
      return;
    }
    pending.current.add(port.port);
    setBusy(new Set(pending.current));
    try {
      const result = await post('/api/ports/kill', {
        pid: Number(port.pid),
        port: port.port,
      });
      setActionError(
        result.ok
          ? null
          : result.error ||
              'Could not stop this process. Refresh ports before trying again.'
      );
      load();
    } finally {
      pending.current.delete(port.port);
      setBusy(new Set(pending.current));
    }
  }

  let portContent: ComponentChildren;
  if (loaded) {
    if (matches.length) {
      portContent = matches.map((p) => (
        <div
          class="flex min-w-0 flex-wrap items-center gap-4 border-zinc-200/60 border-b px-4 py-4 last:border-0 dark:border-white/10"
          key={`${p.port}:${p.pid}`}
        >
          <span class="min-w-16 font-mono font-semibold text-lg tabular-nums">
            {p.port}
          </span>
          <div class="min-w-0 flex-1 basis-40">
            <p class="break-words font-medium">{p.cmd}</p>
            <p class="mt-1 break-all text-xs text-zinc-600 dark:text-zinc-300">
              PID {p.pid}
              {p.worktree ? ` · ${p.worktree}` : ''}
            </p>
          </div>
          <Badge tone={p.worktree ? 'emerald' : 'amber'}>
            {p.worktree ? 'Setu worktree' : 'Unregistered'}
          </Badge>
          <Button
            aria-label={`Stop listener on port ${p.port}`}
            class="text-red-700 dark:text-red-300"
            compact
            disabled={busy.has(p.port)}
            onClick={() => stop(p)}
            variant="secondary"
          >
            {busy.has(p.port) ? 'Stopping…' : 'Stop'}
          </Button>
        </div>
      ));
    } else {
      portContent = (
        <p class="empty-state">
          {search
            ? 'No listeners match this search.'
            : 'No listeners on ports 3000–3999.'}
        </p>
      );
    }
  } else if (!failed) {
    portContent = <p class="empty-state">Loading active ports…</p>;
  }

  return (
    <div class="portal-page mx-auto max-w-4xl px-4 py-6 sm:px-6">
      <PageHeader
        actions={
          <Button compact onClick={load} variant="secondary">
            Refresh ports
          </Button>
        }
        back={{ label: 'All worktrees', onClick: onBack }}
        subtitle={
          <p class="max-w-xl text-sm text-zinc-600 dark:text-zinc-300">
            Listeners on ports 3000–3999, including applications outside Setu.
            Review the process and owner before stopping one.
          </p>
        }
        title="Active ports"
      />
      <div class="page-toolbar">
        <label htmlFor="port-search">
          Find a listener
          <input
            class={inputCls}
            id="port-search"
            onInput={(e) => setSearch(e.currentTarget.value)}
            placeholder="Port, process, PID or worktree…"
            value={search}
          />
        </label>
        {loaded && (
          <p class="pb-2 text-sm text-zinc-600 dark:text-zinc-300">
            {matches.length} of {ports.length} listeners
          </p>
        )}
      </div>
      {failed && (
        <p class="read-notice" role="status">
          Could not refresh ports.{' '}
          {loaded ? 'Showing the last received list. ' : ''}
          <button class="underline" onClick={load} type="button">
            Retry
          </button>
        </p>
      )}
      {actionError && (
        <p class="read-notice" role="alert">
          {actionError}
        </p>
      )}
      <div class="glass-panel text-sm">{portContent}</div>
    </div>
  );
}
