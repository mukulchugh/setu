// Three self-contained Settings sections — each owns its own state/fetch loop,
// documented as intentionally independent of SettingsPage's own state.
import { useRef, useState } from 'preact/hooks';
import { post, postOrToast } from '../api';
import { createMcpConfigWriter } from '../mcp-config';
import { CloseIcon, inputCls, Section } from '../ui';
import { Badge, StatusDot, type Tone } from '../ui/badge';
import { Button, IconButton } from '../ui/button';
import { readArray, readJson, useVisiblePoll } from '../use-visible-poll';
import { LogReadStatus, useLogPoll } from './logs';

interface SweepCandidate {
  conflictWith: string | null;
  dirty: boolean;
  name: string;
  path: string;
  remoteUrl: string | null;
  status: 'importable' | 'no-remote' | 'conflict';
}

// Raycast dev-mode control — status, start/stop, and a live log tail. Fully
// self-contained (owns its own polling loop) the same way LiveLog/PortsPage
// are, so SettingsPage doesn't need to know anything about Raycast beyond
// dropping this component in.
export function RaycastSection({
  toast,
}: {
  toast: (msg: string, tone?: Tone) => void;
}) {
  const {
    data: status,
    failed,
    refresh: loadStatus,
  } = useVisiblePoll('raycast-status', 3000, (signal) =>
    readJson<{ running: boolean; dirExists: boolean }>(
      '/api/raycast/status',
      signal
    )
  );
  const [busy, setBusy] = useState(false);

  // Only polls the log endpoint once dev mode is actually running, same as
  // the original combined fetch that skipped it while status.running was false.
  const logRead = useLogPoll(
    status?.running ? '/api/raycast/log?n=150' : null,
    3000
  );
  const { lines, preRef } = logRead;

  async function start() {
    if (busy) return;
    setBusy(true);
    await postOrToast('/api/raycast/start', {}, toast, 'start failed');
    setBusy(false);
    loadStatus();
  }

  async function stop() {
    if (busy) return;
    setBusy(true);
    await postOrToast('/api/raycast/stop', {}, toast, 'stop failed');
    setBusy(false);
    loadStatus();
  }

  return (
    <Section title="Raycast Extension">
      <p class="mb-2 text-xs">
        <a
          class="underline"
          href="/help#raycast"
          rel="noopener"
          target="_blank"
        >
          About Raycast dev mode
        </a>
      </p>
      {failed && (
        <p class="text-red-700 text-sm dark:text-red-300" role="status">
          Could not refresh Raycast status.{' '}
          {status ? 'Showing the last received status. ' : ''}
          <button class="underline" onClick={loadStatus} type="button">
            Retry
          </button>
        </p>
      )}
      {status ? (
        status.dirExists ? (
          status.running ? (
            <div class="flex flex-col gap-3">
              <div class="flex items-center gap-2">
                <StatusDot tone="emerald" />
                <span class="text-sm">Dev mode running</span>
                <Button disabled={busy} onClick={stop} variant="secondary">
                  {busy ? 'Stopping…' : 'Stop'}
                </Button>
              </div>
              <LogReadStatus read={logRead} />
              <section
                aria-label="Raycast development log output"
                class="max-h-64 overflow-auto whitespace-pre-wrap break-all font-mono text-[11px] text-zinc-600 leading-relaxed dark:text-zinc-400"
                onScroll={logRead.onScroll}
                ref={preRef}
                // biome-ignore lint/a11y/noNoninteractiveTabindex: The bounded log region needs keyboard scrolling.
                tabIndex={0}
              >
                <pre class="m-0 whitespace-pre-wrap break-all font-mono">
                  {lines?.join('\n') ?? ''}
                </pre>
              </section>
            </div>
          ) : (
            <div class="flex flex-col items-start gap-2">
              <Button disabled={busy} onClick={start}>
                {busy ? 'Starting…' : 'Start dev mode'}
              </Button>
              <p class="text-xs text-zinc-600 dark:text-zinc-300">
                Runs <span class="font-mono">bun install</span> when
                dependencies are missing, then{' '}
                <span class="font-mono">bunx ray develop</span> in the
                background to load Setu in Raycast.
              </p>
            </div>
          )
        ) : (
          <p class="text-sm text-zinc-400">
            raycast/ not found in the Setu repo
          </p>
        )
      ) : (
        !failed && <p class="text-sm text-zinc-400">Loading…</p>
      )}
    </Section>
  );
}

// Home-directory sweep for repos that exist on disk but aren't registered
// with Setu yet. Fully self-contained (owns its own scan/import state) the
// same way RaycastSection above is, so SettingsPage doesn't need to co-own
// any of this state. Import runs the checked rows one at a time, not in
// parallel, since it's a sequence of git clones competing for the same
// disk/bandwidth. `onImported` lets the parent refresh its own Projects list.
export function DiscoverProjectsSection({
  toast,
  onImported,
}: {
  toast: (msg: string, tone?: Tone) => void;
  onImported: () => void;
}) {
  const [candidates, setCandidates] = useState<SweepCandidate[] | null>(null);
  const [scanning, setScanning] = useState(false);
  const [scanError, setScanError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [results, setResults] = useState<
    Record<string, { ok: boolean; error?: string }>
  >({});
  const [importingPath, setImportingPath] = useState<string | null>(null);
  const importing = importingPath !== null;

  async function scan() {
    if (scanning || importing) return;
    setScanning(true);
    setScanError(null);
    setResults({});
    try {
      const data = await readArray<SweepCandidate>(
        '/api/sweep',
        new AbortController().signal
      );
      setCandidates(data);
      setSelected(
        new Set(
          data.filter((c) => c.status === 'importable').map((c) => c.path)
        )
      );
    } catch (e) {
      toast(`✗ scan failed: ${String(e)}`);
      setScanError('Could not scan for projects. Try Scan again.');
    }
    setScanning(false);
  }

  function toggle(path: string) {
    setSelected((s) => {
      const next = new Set(s);
      if (next.has(path)) {
        next.delete(path);
      } else {
        next.add(path);
      }
      return next;
    });
  }

  async function importSelected() {
    if (!candidates || importing || scanning) {
      return;
    }
    const queue = candidates.filter(
      (c) =>
        selected.has(c.path) && c.status === 'importable' && !results[c.path]
    );
    if (!queue.length) {
      return;
    }
    let ok = 0;
    for (const c of queue) {
      setImportingPath(c.path);
      // biome-ignore lint/performance/noAwaitInLoops: Each import owns workspace setup; finish it before admitting the next selected repository.
      const res = await post('/api/sweep/import', {
        name: c.name,
        path: c.path,
        remoteUrl: c.remoteUrl,
      });
      setResults((r) => ({
        ...r,
        [c.path]: res?.ok
          ? { ok: true }
          : { error: res?.error ?? 'unknown error', ok: false },
      }));
      if (res?.ok) {
        ok += 1;
      }
    }
    setImportingPath(null);
    onImported();
    toast(
      `Imported ${ok} of ${queue.length}`,
      ok === queue.length ? 'emerald' : 'amber'
    );
  }

  return (
    <Section
      actions={
        <Button disabled={scanning || importing} onClick={scan}>
          {scanning ? 'Scanning…' : 'Scan'}
        </Button>
      }
      title="Discover Projects"
    >
      {scanError && (
        <p class="read-notice" role="status">
          {scanError}
        </p>
      )}
      {candidates === null ? (
        <p class="text-sm text-zinc-400">
          Finds git repos on this Mac that aren't registered with Setu yet. A
          full home directory scan, so it can take a few seconds.
        </p>
      ) : candidates.length ? (
        <div class="flex flex-col gap-2">
          <div class="flex flex-col divide-y divide-zinc-100 dark:divide-zinc-800">
            {candidates.map((c) => {
              const disabled = c.status !== 'importable';
              const result = results[c.path];
              return (
                <div class="flex items-start gap-3 py-2.5 text-sm" key={c.path}>
                  <input
                    aria-label={`Import ${c.name} from ${c.path}`}
                    checked={selected.has(c.path)}
                    class="mt-1 shrink-0 accent-current"
                    disabled={disabled || importing || !!result}
                    onChange={() => toggle(c.path)}
                    style={{ accentColor: 'var(--color-accent)' }}
                    type="checkbox"
                  />
                  <div class="min-w-0 flex-1">
                    <div class="flex flex-wrap items-center gap-2">
                      <span class="truncate font-medium text-zinc-900 dark:text-zinc-100">
                        {c.name}
                      </span>
                      {c.dirty && (
                        <Badge tip="Has uncommitted changes" tone="amber">
                          dirty
                        </Badge>
                      )}
                      {importingPath === c.path && (
                        <Badge tone="zinc">importing…</Badge>
                      )}
                      {result &&
                        (result.ok ? (
                          <Badge tone="emerald">✓ imported</Badge>
                        ) : (
                          <span class="text-signal-red text-xs">
                            ✗ {result.error}
                          </span>
                        ))}
                    </div>
                    <div class="truncate text-xs text-zinc-400">{c.path}</div>
                    {c.remoteUrl ? (
                      <div class="truncate text-xs text-zinc-400">
                        {c.remoteUrl}
                      </div>
                    ) : (
                      <div class="text-signal-amber text-xs">
                        no remote to clone from
                      </div>
                    )}
                    {c.status === 'conflict' && (
                      <div class="text-signal-amber text-xs">
                        name already used by {c.conflictWith}
                      </div>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
          <div class="flex items-center gap-3 pt-2">
            <Button
              disabled={
                scanning ||
                importing ||
                !candidates.some(
                  (c) =>
                    selected.has(c.path) &&
                    c.status === 'importable' &&
                    !results[c.path]
                )
              }
              onClick={importSelected}
            >
              {importing ? 'Importing…' : `Import selected (${selected.size})`}
            </Button>
          </div>
          <p class="mt-1 text-[11px] text-zinc-400">
            Imports run one at a time, cloning each repo's origin remote into
            Setu's bare-repo layout. The original directory on disk is left
            untouched either way.
          </p>
        </div>
      ) : (
        <p class="text-sm text-zinc-400">No unregistered repos found.</p>
      )}
    </Section>
  );
}

interface McpTool {
  description?: string;
  name: string;
}
interface McpServer {
  args?: string[];
  command?: string;
  env?: Record<string, string>;
  error: string | null;
  headers?: Record<string, string>;
  httpAuthMode?: 'headers' | 'oauth';
  id: string;
  name: string;
  // Computed fields the GET response joins on from mcp.js's live status —
  // stripped back off before POSTing the list back (see saveList below),
  // same convention /api/sidecars uses for its own computed `approved` field.
  status:
    | 'disconnected'
    | 'connecting'
    | 'awaiting-auth'
    | 'connected'
    | 'error';
  stderrTail: string[];
  tools: McpTool[];
  transport: 'stdio' | 'http';
  url?: string;
}

const MCP_TONE: Record<McpServer['status'], Tone> = {
  'awaiting-auth': 'amber',
  connected: 'emerald',
  connecting: 'amber',
  disconnected: 'zinc',
  error: 'red',
};
const MCP_LABEL: Record<McpServer['status'], string> = {
  'awaiting-auth': 'Waiting for authorization in your browser…',
  connected: 'Connected',
  connecting: 'Connecting…',
  disconnected: 'Disconnected',
  error: 'Error',
};

// One "key: value" line -> a single-entry headers object. Deliberately just
// one header (a bearer token is the overwhelming common case for the static
// 'headers' auth mode) rather than a full multi-row header editor — if a
// server needs more than that, its httpAuthMode is almost certainly 'oauth'
// instead.
function parseHeaderLine(line: string): Record<string, string> | undefined {
  const i = line.indexOf(':');
  if (i < 0) {
    return;
  }
  const key = line.slice(0, i).trim();
  const value = line.slice(i + 1).trim();
  return key && value ? { [key]: value } : undefined;
}

// MCP server connections — configure, connect (spawning a stdio process or
// starting an HTTP session, with either a static header or a full OAuth 2.1
// redirect), and see what tools each one exposes. No call-a-tool UI here on
// purpose: this section only proves configure -> connect -> authorize ->
// list tools works; wiring tools into real actions is a separate, later
// feature built on top of this. Polls /api/mcp-servers on a plain interval
// like RaycastSection above, not WS — connect/authorize is either a fast
// local spawn or a real browser OAuth round-trip the user is already
// watching, not something that needs sub-second push.
export function McpSection({
  toast,
}: {
  toast: (msg: string, tone?: Tone) => void;
}) {
  const {
    data: serversData,
    failed,
    refresh: load,
  } = useVisiblePoll('mcp-servers', 2000, (signal) =>
    readArray<McpServer>('/api/mcp-servers', signal)
  );
  const servers = serversData ?? [];
  const loaded = serversData !== undefined;
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [adding, setAdding] = useState(false);
  const [saving, setSaving] = useState(false);
  const [serverBusy, setServerBusy] = useState<Set<string>>(new Set());
  const [saveError, setSaveError] = useState<string | null>(null);
  const savePending = useRef(false);
  const writer = useRef<ReturnType<
    typeof createMcpConfigWriter<McpServer>
  > | null>(null);
  if (!writer.current) {
    writer.current = createMcpConfigWriter({
      read: () =>
        readArray<McpServer>('/api/mcp-servers', new AbortController().signal),
      write: (rows) =>
        post('/api/mcp-servers', {
          servers: rows.map(
            ({ status, tools, stderrTail, error, ...row }) => row
          ),
        }),
    });
  }
  const [form, setForm] = useState({
    args: '',
    command: '',
    headerLine: '',
    httpAuthMode: 'headers' as 'headers' | 'oauth',
    name: '',
    transport: 'stdio' as 'stdio' | 'http',
    url: '',
  });

  // Strips the computed status/tools/stderrTail/error fields the GET
  // response joins on before sending the list back — mcp-servers.json only
  // ever owns configuration, connection state lives in mcp.js's own memory.
  async function saveList(
    change: (rows: McpServer[]) => McpServer[] | Promise<McpServer[]>
  ) {
    if (savePending.current) {
      return false;
    }
    savePending.current = true;
    setSaving(true);
    try {
      const result = await writer.current!.save(
        failed ? undefined : serversData,
        change
      );
      const okay = result.ok && result.reconciled !== false;
      const error = okay
        ? null
        : result.networkUncertain || result.committed
          ? 'Outcome not confirmed. Refresh saved values before trying again.'
          : result.error || 'Could not save MCP configuration.';
      setSaveError(error);
      if (error) {
        toast(`✗ ${error}`, 'red');
      }
      load();
      return okay;
    } finally {
      savePending.current = false;
      setSaving(false);
    }
  }

  async function addServer() {
    if (
      !form.name.trim() ||
      (form.transport === 'stdio'
        ? !form.command.trim()
        : !/^https?:\/\//i.test(form.url.trim()))
    ) {
      setSaveError(
        'Enter a server name and a command, or a complete HTTP(S) URL.'
      );
      return;
    }
    const base = { id: '', name: form.name.trim(), transport: form.transport };
    const entry =
      form.transport === 'stdio'
        ? {
            ...base,
            args: form.args.trim() ? form.args.trim().split(/\s+/) : undefined,
            command: form.command.trim(),
          }
        : {
            ...base,
            headers:
              form.httpAuthMode === 'headers'
                ? parseHeaderLine(form.headerLine)
                : undefined,
            httpAuthMode: form.httpAuthMode,
            url: form.url.trim(),
          };
    if (
      await saveList((rows) => [
        ...rows,
        {
          ...entry,
          error: null,
          status: 'disconnected',
          stderrTail: [],
          tools: [],
        },
      ])
    ) {
      setForm({
        args: '',
        command: '',
        headerLine: '',
        httpAuthMode: 'headers',
        name: '',
        transport: 'stdio',
        url: '',
      });
      setAdding(false);
    }
  }

  async function connect(id: string) {
    if (serverBusy.has(id)) return;
    setServerBusy((busy) => new Set(busy).add(id));
    try {
      await postOrToast('/api/mcp/connect', { id }, toast, 'connect failed');
      load();
    } finally {
      setServerBusy((busy) => {
        const next = new Set(busy);
        next.delete(id);
        return next;
      });
    }
  }
  async function disconnect(id: string, preserveBusy = false) {
    if (serverBusy.has(id) && !preserveBusy) return { ok: false };
    if (!preserveBusy) {
      setServerBusy((busy) => new Set(busy).add(id));
    }
    try {
      const result = await postOrToast(
        '/api/mcp/disconnect',
        { id },
        toast,
        'disconnect failed'
      );
      load();
      return result;
    } finally {
      if (!preserveBusy) {
        setServerBusy((busy) => {
          const next = new Set(busy);
          next.delete(id);
          return next;
        });
      }
    }
  }
  async function remove(s: McpServer) {
    if (
      serverBusy.has(s.id) ||
      !confirm(
        `Remove MCP server "${s.name}"? Its saved configuration, including any static header, will be removed.`
      )
    ) {
      return;
    }
    setServerBusy((busy) => new Set(busy).add(s.id));
    try {
      await saveList(async (rows) => {
        const current = rows.find((row) => row.id === s.id);
        if (current && current.status !== 'disconnected') {
          const result = await disconnect(s.id, true);
          if (!result.ok) {
            throw new Error(
              result.error ||
                'Disconnect could not be confirmed; the saved server is kept.'
            );
          }
        }
        return rows.filter((row) => row.id !== s.id);
      });
    } finally {
      setServerBusy((busy) => {
        const next = new Set(busy);
        next.delete(s.id);
        return next;
      });
    }
  }
  function toggleExpanded(id: string) {
    setExpanded((s) => {
      const next = new Set(s);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  }

  return (
    <Section
      actions={
        <Button
          compact
          disabled={saving}
          onClick={() => setAdding((a) => !a)}
          variant="secondary"
        >
          {adding ? 'Cancel' : '+ Add server'}
        </Button>
      }
      title="MCP Servers"
    >
      <div class="flex flex-col gap-3">
        {adding && (
          <fieldset
            class="flex flex-col gap-2 rounded-lg border border-zinc-200 p-3 dark:border-zinc-800"
            disabled={saving}
          >
            <input
              aria-label="MCP server name"
              class={`${inputCls} py-1.5 text-xs`}
              onInput={(e) =>
                setForm((f) => ({ ...f, name: e.currentTarget.value }))
              }
              placeholder="Name"
              value={form.name}
            />
            <div class="flex gap-4 text-xs text-zinc-600 dark:text-zinc-400">
              <label class="flex items-center gap-1.5">
                <input
                  checked={form.transport === 'stdio'}
                  name="mcp-transport"
                  onChange={() =>
                    setForm((f) => ({ ...f, transport: 'stdio' }))
                  }
                  type="radio"
                />{' '}
                Local command
              </label>
              <label class="flex items-center gap-1.5">
                <input
                  checked={form.transport === 'http'}
                  name="mcp-transport"
                  onChange={() => setForm((f) => ({ ...f, transport: 'http' }))}
                  type="radio"
                />{' '}
                Remote URL
              </label>
            </div>
            {form.transport === 'stdio' ? (
              <>
                <input
                  aria-label="MCP server command"
                  class={`${inputCls} py-1.5 font-mono text-xs`}
                  onInput={(e) =>
                    setForm((f) => ({ ...f, command: e.currentTarget.value }))
                  }
                  placeholder="Command"
                  value={form.command}
                />
                <input
                  aria-label="MCP server arguments, space-separated"
                  class={`${inputCls} py-1.5 font-mono text-xs`}
                  onInput={(e) =>
                    setForm((f) => ({ ...f, args: e.currentTarget.value }))
                  }
                  placeholder="Args (space-separated)"
                  value={form.args}
                />
              </>
            ) : (
              <>
                <input
                  aria-label="MCP server URL"
                  class={`${inputCls} py-1.5 font-mono text-xs`}
                  onInput={(e) =>
                    setForm((f) => ({ ...f, url: e.currentTarget.value }))
                  }
                  placeholder="https://…"
                  value={form.url}
                />
                <div class="flex gap-4 text-xs text-zinc-600 dark:text-zinc-400">
                  <label class="flex items-center gap-1.5">
                    <input
                      checked={form.httpAuthMode === 'headers'}
                      name="mcp-http-auth"
                      onChange={() =>
                        setForm((f) => ({ ...f, httpAuthMode: 'headers' }))
                      }
                      type="radio"
                    />{' '}
                    Static header
                  </label>
                  <label class="flex items-center gap-1.5">
                    <input
                      checked={form.httpAuthMode === 'oauth'}
                      name="mcp-http-auth"
                      onChange={() =>
                        setForm((f) => ({ ...f, httpAuthMode: 'oauth' }))
                      }
                      type="radio"
                    />{' '}
                    OAuth
                  </label>
                </div>
                {form.httpAuthMode === 'headers' && (
                  <input
                    aria-label="MCP authorization header"
                    class={`${inputCls} py-1.5 font-mono text-xs`}
                    onInput={(e) =>
                      setForm((f) => ({
                        ...f,
                        headerLine: e.currentTarget.value,
                      }))
                    }
                    placeholder="Authorization: Bearer …"
                    value={form.headerLine}
                  />
                )}
              </>
            )}
            <div class="pt-1">
              <Button
                compact
                disabled={!loaded || failed || saving}
                onClick={addServer}
              >
                {saving ? 'Saving…' : 'Add'}
              </Button>
            </div>
          </fieldset>
        )}

        {failed && (
          <p class="text-red-700 text-sm dark:text-red-300" role="status">
            Could not refresh MCP servers.{' '}
            {loaded ? 'Showing the last received list. ' : ''}
            <button class="underline" onClick={load} type="button">
              Retry
            </button>
          </p>
        )}
        {saveError && (
          <p class="text-signal-red text-sm" role="status">
            {saveError}{' '}
            <button class="underline" onClick={load} type="button">
              Refresh saved values
            </button>
          </p>
        )}
        {loaded ? (
          servers.length ? (
            <div class="flex flex-col divide-y divide-zinc-100 dark:divide-zinc-800">
              {servers.map((s) => (
                <div class="flex flex-col gap-1.5 py-2.5" key={s.id}>
                  <div class="flex min-w-0 flex-wrap items-center gap-2">
                    <StatusDot
                      pulse={
                        s.status === 'connecting' ||
                        s.status === 'awaiting-auth'
                      }
                      tone={MCP_TONE[s.status]}
                    />
                    <span class="min-w-0 break-words font-medium text-sm text-zinc-900 dark:text-zinc-100">
                      {s.name}
                    </span>
                    <Badge tone="zinc">{s.transport}</Badge>
                    <span class="flex-1 text-xs text-zinc-400">
                      {MCP_LABEL[s.status]}
                    </span>
                    {s.status === 'disconnected' || s.status === 'error' ? (
                      <Button
                        compact
                        disabled={serverBusy.has(s.id)}
                        onClick={() => connect(s.id)}
                        variant="secondary"
                      >
                        Connect
                      </Button>
                    ) : (
                      <Button
                        compact
                        disabled={serverBusy.has(s.id)}
                        onClick={() => disconnect(s.id)}
                        variant="secondary"
                      >
                        Disconnect
                      </Button>
                    )}
                    <IconButton
                      disabled={saving || failed || serverBusy.has(s.id)}
                      label={`Remove MCP server ${s.name}`}
                      onClick={() => remove(s)}
                      tip="Remove server"
                      tone="red"
                    >
                      <CloseIcon class="h-3.5 w-3.5" />
                    </IconButton>
                  </div>
                  {s.error && <p class="text-signal-red text-xs">{s.error}</p>}
                  {s.status === 'error' && s.stderrTail?.length > 0 && (
                    <pre class="max-h-24 overflow-auto whitespace-pre-wrap break-all rounded bg-zinc-50 p-2 text-[11px] text-zinc-400 dark:bg-black/20">
                      {s.stderrTail.join('\n')}
                    </pre>
                  )}
                  {s.status === 'connected' && s.tools.length > 0 && (
                    <div>
                      <button
                        aria-controls={`mcp-tools-${s.id}`}
                        aria-expanded={expanded.has(s.id)}
                        class="text-xs text-zinc-400 underline underline-offset-2"
                        onClick={() => toggleExpanded(s.id)}
                        type="button"
                      >
                        {expanded.has(s.id) ? 'Hide' : 'Show'} {s.tools.length}{' '}
                        tool{s.tools.length === 1 ? '' : 's'}
                      </button>
                      {expanded.has(s.id) && (
                        <ul
                          class="mt-1.5 flex flex-col gap-1"
                          id={`mcp-tools-${s.id}`}
                        >
                          {s.tools.map((t) => (
                            <li class="text-xs" key={t.name}>
                              <span class="font-mono text-zinc-700 dark:text-zinc-300">
                                {t.name}
                              </span>
                              {t.description && (
                                <span class="text-zinc-400">
                                  {' '}
                                  — {t.description}
                                </span>
                              )}
                            </li>
                          ))}
                        </ul>
                      )}
                    </div>
                  )}
                </div>
              ))}
            </div>
          ) : (
            <p class="text-sm text-zinc-400">No MCP servers configured.</p>
          )
        ) : (
          !failed && <p class="text-sm text-zinc-400">Loading…</p>
        )}
      </div>
    </Section>
  );
}
