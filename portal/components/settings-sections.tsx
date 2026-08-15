// Three self-contained Settings sections — each owns its own state/fetch loop,
// documented as intentionally independent of SettingsPage's own state.
import { useState, useEffect, useCallback } from 'preact/hooks';
import { Section, CloseIcon, inputCls } from '../ui';
import { Button, IconButton } from '../ui/button';
import { Badge, StatusDot, type Tone } from '../ui/badge';
import { post, postOrToast } from '../api';
import { useLogPoll } from './logs';

type SweepCandidate = {
  path: string; name: string; remoteUrl: string | null; dirty: boolean;
  status: 'importable' | 'no-remote' | 'conflict'; conflictWith: string | null;
};

// Raycast dev-mode control — status, start/stop, and a live log tail. Fully
// self-contained (owns its own polling loop) the same way LiveLog/PortsPage
// are, so SettingsPage doesn't need to know anything about Raycast beyond
// dropping this component in.
export function RaycastSection({ toast }: { toast: (msg: string, tone?: Tone) => void }) {
  const [status, setStatus] = useState<{ running: boolean; dirExists: boolean } | null>(null);
  const [busy, setBusy] = useState(false);

  const loadStatus = useCallback(async () => {
    setStatus(await fetch('/api/raycast/status').then(r => r.json()).catch(() => null));
  }, []);

  useEffect(() => {
    loadStatus();
    const t = setInterval(loadStatus, 3000);
    return () => clearInterval(t);
  }, [loadStatus]);

  // Only polls the log endpoint once dev mode is actually running, same as
  // the original combined fetch that skipped it while status.running was false.
  const { lines, preRef } = useLogPoll(status?.running ? '/api/raycast/log?n=150' : null, 3000);
  const log = lines ?? [];

  async function start() {
    setBusy(true);
    await postOrToast('/api/raycast/start', {}, toast, 'start failed');
    setBusy(false);
    loadStatus();
  }

  async function stop() {
    await post('/api/raycast/stop', {});
    loadStatus();
  }

  return (
    <Section title="Raycast Extension">
      {!status ? <p class="text-sm text-zinc-400">Loading…</p>
        : !status.dirExists ? <p class="text-sm text-zinc-400">raycast/ not found in the Setu repo</p>
        : !status.running ? (
          <div class="flex flex-col items-start gap-2">
            <Button onClick={start} disabled={busy}>{busy ? 'Starting…' : 'Start dev mode'}</Button>
            <p class="text-[11px] text-zinc-400">Runs <span class="font-mono">npm install</span> (first time only) and <span class="font-mono">ray develop</span> in the background — this is what makes Setu show up in Raycast.</p>
          </div>
        ) : (
          <div class="flex flex-col gap-3">
            <div class="flex items-center gap-2">
              <StatusDot tone="emerald" />
              <span class="text-sm">Dev mode running</span>
              <Button variant="secondary" onClick={stop}>Stop</Button>
            </div>
            <pre ref={preRef} class="max-h-64 overflow-auto text-[11px] leading-relaxed font-mono text-zinc-600 dark:text-zinc-400 whitespace-pre-wrap break-all">{log.length ? log.join('\n') : '(no log yet)'}</pre>
          </div>
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
export function DiscoverProjectsSection({ toast, onImported }: { toast: (msg: string, tone?: Tone) => void; onImported: () => void }) {
  const [candidates, setCandidates] = useState<SweepCandidate[] | null>(null);
  const [scanning, setScanning] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [results, setResults] = useState<Record<string, { ok: boolean; error?: string }>>({});
  const [importingPath, setImportingPath] = useState<string | null>(null);
  const importing = importingPath !== null;

  async function scan() {
    setScanning(true);
    setResults({});
    try {
      const data: SweepCandidate[] = await fetch('/api/sweep').then(r => r.json());
      setCandidates(data);
      setSelected(new Set(data.filter(c => c.status === 'importable').map(c => c.path)));
    } catch (e) {
      toast('✗ scan failed: ' + String(e));
      setCandidates([]);
    }
    setScanning(false);
  }

  function toggle(path: string) {
    setSelected(s => {
      const next = new Set(s);
      if (next.has(path)) next.delete(path); else next.add(path);
      return next;
    });
  }

  async function importSelected() {
    if (!candidates) return;
    const queue = candidates.filter(c => selected.has(c.path) && c.status === 'importable');
    if (!queue.length) return;
    let ok = 0;
    for (const c of queue) {
      setImportingPath(c.path);
      const res = await post('/api/sweep/import', { path: c.path, name: c.name, remoteUrl: c.remoteUrl });
      setResults(r => ({ ...r, [c.path]: res?.ok ? { ok: true } : { ok: false, error: res?.error ?? 'unknown error' } }));
      if (res?.ok) ok++;
    }
    setImportingPath(null);
    onImported();
    toast(`Imported ${ok} of ${queue.length}`, ok === queue.length ? 'emerald' : 'amber');
  }

  return (
    <Section title="Discover Projects" actions={
      <Button onClick={scan} disabled={scanning}>{scanning ? 'Scanning…' : 'Scan'}</Button>
    }>
      {candidates === null ? (
        <p class="text-sm text-zinc-400">Finds git repos on this Mac that aren't registered with Setu yet. A full home directory scan, so it can take a few seconds.</p>
      ) : !candidates.length ? (
        <p class="text-sm text-zinc-400">No unregistered repos found.</p>
      ) : (
        <div class="flex flex-col gap-2">
          <div class="flex flex-col divide-y divide-zinc-100 dark:divide-zinc-800">
            {candidates.map(c => {
              const disabled = c.status !== 'importable';
              const result = results[c.path];
              return (
                <div key={c.path} class="flex items-start gap-3 py-2.5 text-sm">
                  <input type="checkbox" checked={selected.has(c.path)} disabled={disabled || importing || !!result}
                    onChange={() => toggle(c.path)} class="mt-1 accent-current shrink-0" style={{ accentColor: 'var(--color-accent)' }} />
                  <div class="flex-1 min-w-0">
                    <div class="flex items-center gap-2 flex-wrap">
                      <span class="font-medium text-zinc-900 dark:text-zinc-100 truncate">{c.name}</span>
                      {c.dirty && <Badge tone="amber" tip="Has uncommitted changes">dirty</Badge>}
                      {importingPath === c.path && <Badge tone="zinc">importing…</Badge>}
                      {result && (result.ok
                        ? <Badge tone="emerald">✓ imported</Badge>
                        : <span class="text-xs text-signal-red">✗ {result.error}</span>)}
                    </div>
                    <div class="text-xs text-zinc-400 truncate">{c.path}</div>
                    {c.remoteUrl
                      ? <div class="text-xs text-zinc-400 truncate">{c.remoteUrl}</div>
                      : <div class="text-xs text-signal-amber">no remote to clone from</div>}
                    {c.status === 'conflict' && (
                      <div class="text-xs text-signal-amber">name already used by {c.conflictWith}</div>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
          <div class="flex items-center gap-3 pt-2">
            <Button onClick={importSelected} disabled={!selected.size || importing}>
              {importing ? 'Importing…' : `Import selected (${selected.size})`}
            </Button>
          </div>
          <p class="text-[11px] text-zinc-400 mt-1">Imports run one at a time, cloning each repo's origin remote into Setu's bare-repo layout. The original directory on disk is left untouched either way.</p>
        </div>
      )}
    </Section>
  );
}

type McpTool = { name: string; description?: string };
type McpServer = {
  id: string; name: string; transport: 'stdio' | 'http';
  command?: string; args?: string[]; env?: Record<string, string>;
  url?: string; httpAuthMode?: 'headers' | 'oauth'; headers?: Record<string, string>;
  // Computed fields the GET response joins on from mcp.js's live status —
  // stripped back off before POSTing the list back (see saveList below),
  // same convention /api/sidecars uses for its own computed `approved` field.
  status: 'disconnected' | 'connecting' | 'awaiting-auth' | 'connected' | 'error';
  tools: McpTool[]; stderrTail: string[]; error: string | null;
};

const MCP_TONE: Record<McpServer['status'], Tone> = {
  disconnected: 'zinc', connecting: 'amber', 'awaiting-auth': 'amber', connected: 'emerald', error: 'red',
};
const MCP_LABEL: Record<McpServer['status'], string> = {
  disconnected: 'Disconnected', connecting: 'Connecting…', 'awaiting-auth': 'Waiting for authorization in your browser…', connected: 'Connected', error: 'Error',
};

// One "key: value" line -> a single-entry headers object. Deliberately just
// one header (a bearer token is the overwhelming common case for the static
// 'headers' auth mode) rather than a full multi-row header editor — if a
// server needs more than that, its httpAuthMode is almost certainly 'oauth'
// instead.
function parseHeaderLine(line: string): Record<string, string> | undefined {
  const i = line.indexOf(':');
  if (i < 0) return undefined;
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
export function McpSection({ toast }: { toast: (msg: string, tone?: Tone) => void }) {
  const [servers, setServers] = useState<McpServer[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState({
    name: '', transport: 'stdio' as 'stdio' | 'http',
    command: '', args: '',
    url: '', httpAuthMode: 'headers' as 'headers' | 'oauth', headerLine: '',
  });

  const load = useCallback(async () => {
    setServers(await fetch('/api/mcp-servers').then(r => r.json()).catch(() => []));
    setLoaded(true);
  }, []);

  useEffect(() => {
    load();
    const t = setInterval(load, 2000);
    return () => clearInterval(t);
  }, [load]);

  // Strips the computed status/tools/stderrTail/error fields the GET
  // response joins on before sending the list back — mcp-servers.json only
  // ever owns configuration, connection state lives in mcp.js's own memory.
  async function saveList(next: (Omit<McpServer, 'status' | 'tools' | 'stderrTail' | 'error'>)[]) {
    await postOrToast('/api/mcp-servers', { servers: next }, toast, 'save failed');
    load();
  }

  function addServer() {
    if (!form.name.trim()) return;
    const base = { id: '', name: form.name.trim(), transport: form.transport };
    const entry = form.transport === 'stdio'
      ? { ...base, command: form.command.trim(), args: form.args.trim() ? form.args.trim().split(/\s+/) : undefined }
      : {
        ...base, url: form.url.trim(), httpAuthMode: form.httpAuthMode,
        headers: form.httpAuthMode === 'headers' ? parseHeaderLine(form.headerLine) : undefined,
      };
    saveList([...servers.map(({ status, tools, stderrTail, error, ...s }) => s), entry]);
    setForm({ name: '', transport: 'stdio', command: '', args: '', url: '', httpAuthMode: 'headers', headerLine: '' });
    setAdding(false);
  }

  async function connect(id: string) {
    await postOrToast('/api/mcp/connect', { id }, toast, 'connect failed');
    load();
  }
  async function disconnect(id: string) {
    await postOrToast('/api/mcp/disconnect', { id }, toast, 'disconnect failed');
    load();
  }
  async function remove(s: McpServer) {
    if (s.status !== 'disconnected') await disconnect(s.id); // avoid leaving an orphaned live connection with no config entry
    saveList(servers.filter(x => x.id !== s.id).map(({ status, tools, stderrTail, error, ...x }) => x));
  }
  function toggleExpanded(id: string) {
    setExpanded(s => { const next = new Set(s); if (next.has(id)) next.delete(id); else next.add(id); return next; });
  }

  return (
    <Section title="MCP Servers" actions={
      <Button variant="secondary" onClick={() => setAdding(a => !a)} compact>{adding ? 'Cancel' : '+ Add server'}</Button>
    }>
      <div class="flex flex-col gap-3">
        {adding && (
          <div class="flex flex-col gap-2 p-3 border border-zinc-200 dark:border-zinc-800 rounded-lg">
            <input value={form.name} onInput={(e: any) => setForm(f => ({ ...f, name: e.target.value }))}
              placeholder="Name" class={`${inputCls} text-xs py-1.5`} />
            <div class="flex gap-4 text-xs text-zinc-600 dark:text-zinc-400">
              <label class="flex items-center gap-1.5"><input type="radio" checked={form.transport === 'stdio'} onChange={() => setForm(f => ({ ...f, transport: 'stdio' }))} /> Local command</label>
              <label class="flex items-center gap-1.5"><input type="radio" checked={form.transport === 'http'} onChange={() => setForm(f => ({ ...f, transport: 'http' }))} /> Remote URL</label>
            </div>
            {form.transport === 'stdio' ? (
              <>
                <input value={form.command} onInput={(e: any) => setForm(f => ({ ...f, command: e.target.value }))}
                  placeholder="Command" class={`${inputCls} text-xs py-1.5 font-mono`} />
                <input value={form.args} onInput={(e: any) => setForm(f => ({ ...f, args: e.target.value }))}
                  placeholder="Args (space-separated)" class={`${inputCls} text-xs py-1.5 font-mono`} />
              </>
            ) : (
              <>
                <input value={form.url} onInput={(e: any) => setForm(f => ({ ...f, url: e.target.value }))}
                  placeholder="https://…" class={`${inputCls} text-xs py-1.5 font-mono`} />
                <div class="flex gap-4 text-xs text-zinc-600 dark:text-zinc-400">
                  <label class="flex items-center gap-1.5"><input type="radio" checked={form.httpAuthMode === 'headers'} onChange={() => setForm(f => ({ ...f, httpAuthMode: 'headers' }))} /> Static header</label>
                  <label class="flex items-center gap-1.5"><input type="radio" checked={form.httpAuthMode === 'oauth'} onChange={() => setForm(f => ({ ...f, httpAuthMode: 'oauth' }))} /> OAuth</label>
                </div>
                {form.httpAuthMode === 'headers' && (
                  <input value={form.headerLine} onInput={(e: any) => setForm(f => ({ ...f, headerLine: e.target.value }))}
                    placeholder="Authorization: Bearer …" class={`${inputCls} text-xs py-1.5 font-mono`} />
                )}
              </>
            )}
            <div class="pt-1">
              <Button onClick={addServer} compact>Add</Button>
            </div>
          </div>
        )}

        {!loaded ? <p class="text-sm text-zinc-400">Loading…</p>
          : !servers.length ? <p class="text-sm text-zinc-400">No MCP servers configured.</p>
          : (
            <div class="flex flex-col divide-y divide-zinc-100 dark:divide-zinc-800">
              {servers.map(s => (
                <div key={s.id} class="py-2.5 flex flex-col gap-1.5">
                  <div class="flex items-center gap-2">
                    <StatusDot tone={MCP_TONE[s.status]} pulse={s.status === 'connecting' || s.status === 'awaiting-auth'} />
                    <span class="text-sm font-medium text-zinc-900 dark:text-zinc-100">{s.name}</span>
                    <Badge tone="zinc">{s.transport}</Badge>
                    <span class="text-xs text-zinc-400 flex-1">{MCP_LABEL[s.status]}</span>
                    {s.status === 'disconnected' || s.status === 'error'
                      ? <Button variant="secondary" compact onClick={() => connect(s.id)}>Connect</Button>
                      : <Button variant="secondary" compact onClick={() => disconnect(s.id)}>Disconnect</Button>}
                    <IconButton tone="red" tip="Remove server" onClick={() => remove(s)}>
                      <CloseIcon class="w-3.5 h-3.5" />
                    </IconButton>
                  </div>
                  {s.error && <p class="text-xs text-signal-red">{s.error}</p>}
                  {s.status === 'error' && s.stderrTail?.length > 0 && (
                    <pre class="text-[11px] text-zinc-400 bg-zinc-50 dark:bg-black/20 p-2 rounded max-h-24 overflow-auto whitespace-pre-wrap break-all">{s.stderrTail.join('\n')}</pre>
                  )}
                  {s.status === 'connected' && s.tools.length > 0 && (
                    <div>
                      <button onClick={() => toggleExpanded(s.id)} class="text-xs text-zinc-400 underline underline-offset-2">
                        {expanded.has(s.id) ? 'Hide' : 'Show'} {s.tools.length} tool{s.tools.length === 1 ? '' : 's'}
                      </button>
                      {expanded.has(s.id) && (
                        <ul class="mt-1.5 flex flex-col gap-1">
                          {s.tools.map(t => (
                            <li key={t.name} class="text-xs">
                              <span class="font-mono text-zinc-700 dark:text-zinc-300">{t.name}</span>
                              {t.description && <span class="text-zinc-400"> — {t.description}</span>}
                            </li>
                          ))}
                        </ul>
                      )}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
      </div>
    </Section>
  );
}
