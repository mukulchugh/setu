// setu portal UI — Preact, bundled by Bun.serve at runtime (see portal.js)
import { render } from 'preact';
import { useState, useEffect, useRef, useCallback } from 'preact/hooks';

type Worktree = {
  key: string; repo: string; name: string; slug: string; port: number;
  domain: string; pubDomain: string; tunnelOn: boolean; active: boolean;
  container: string | null;
  tunnelRunning: boolean; label: string; branchUrl: string | null;
  pr: { url: string; number: number; title: string } | null;
  inngestActive: boolean; inngestPort: number; triggerActive: boolean;
};
type Project = { name: string; label: string };
type PortInfo = { port: number; pid: string; cmd: string; worktree: string | null };

async function post(url: string, body: any) {
  try {
    const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    return await r.json();
  } catch (e) { return { ok: false, error: String(e) }; }
}

const BADGE_COLORS: Record<string, string> = {
  App: 'bg-violet-50 text-violet-600 border border-violet-200',
  Landing: 'bg-sky-50 text-sky-600 border border-sky-200',
};

// Best-effort favicon domain per known tool id — anything not listed here (a
// future addition to lib.js's AGENT_CLIS) still renders fine via the label
// fallback in ToolIcon, it just won't have a nice logo.
const AGENT_ICON_DOMAIN: Record<string, string> = {
  claude: 'claude.ai', codex: 'openai.com', cursor: 'cursor.com', aider: 'aider.chat',
  opencode: 'opencode.ai', amp: 'ampcode.com', antigravity: 'antigravity.google', grok: 'x.ai',
};

function ToolIcon({ domain, fallback }: { domain: string; fallback: string }) {
  const [failed, setFailed] = useState(false);
  if (failed || !domain) return <span class="text-[10px] font-bold">{fallback}</span>;
  return <img src={`https://www.google.com/s2/favicons?domain=${domain}&sz=64`}
    class="w-4 h-4 rounded-sm" alt={fallback} onError={() => setFailed(true)} />;
}

function Modal({ onClose, children, position = 'center' }: any) {
  return (
    <div class={`fixed inset-0 bg-black/40 backdrop-blur-sm z-50 flex ${position === 'bottom' ? 'items-end justify-stretch' : 'items-center justify-center'}`}
      onClick={(e: any) => { if (e.target === e.currentTarget) onClose(); }}>
      {children}
    </div>
  );
}

function CloseBtn({ onClick }: { onClick: () => void }) {
  return (
    <button onClick={onClick} class="w-7 h-7 flex items-center justify-center rounded-lg text-zinc-400 hover:text-zinc-600 hover:bg-zinc-100 transition-colors">
      <svg class="w-4 h-4" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12" /></svg>
    </button>
  );
}

const inputCls = 'bg-white border border-zinc-200 text-zinc-800 text-sm rounded-lg px-3 py-2 focus:outline-none focus:border-zinc-400 placeholder-zinc-400';

function CreateModal({ projects, onClose, onCreated, toast }: any) {
  const [repo, setRepo] = useState(projects[0]?.name ?? '');
  const [name, setName] = useState('');
  const [tunnel, setTunnel] = useState(false);
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);

  async function create() {
    if (!name.trim()) return;
    setBusy(true);
    setStatus('Setting up worktree and running bun install in background…');
    const res = await post('/api/create', { repo, name: name.trim(), tunnel });
    if (res.ok) {
      setStatus(`✓ Created on port ${res.port}`);
      onCreated();
      setTimeout(onClose, 1200);
    } else {
      setStatus('✗ ' + (res.error ?? 'failed'));
      setBusy(false);
    }
  }

  return (
    <Modal onClose={onClose}>
      <div class="bg-white rounded-2xl border border-zinc-200 shadow-2xl p-6 w-full max-w-sm mx-4">
        <div class="flex items-center justify-between mb-5">
          <h2 class="text-base font-semibold text-zinc-900">New worktree</h2>
          <CloseBtn onClick={onClose} />
        </div>
        <div class="flex flex-col gap-4">
          <div class="flex flex-col gap-1.5">
            <label class="text-xs text-zinc-500">Repo</label>
            <select value={repo} onChange={(e: any) => setRepo(e.target.value)} class={inputCls}>
              {projects.map((p: Project) => <option key={p.name} value={p.name}>{p.label}</option>)}
            </select>
          </div>
          <div class="flex flex-col gap-1.5">
            <label class="text-xs text-zinc-500">Branch name</label>
            <input value={name} onInput={(e: any) => setName(e.target.value)} placeholder="feat-my-feature"
              autocomplete="off" autoFocus class={inputCls}
              onKeyDown={(e: any) => { if (e.key === 'Enter') create(); }} />
          </div>
          <div class="flex items-center gap-2">
            <input type="checkbox" id="create-tunnel" checked={tunnel} onChange={(e: any) => setTunnel(e.target.checked)} class="accent-sky-500" />
            <label for="create-tunnel" class="text-xs text-zinc-500">Enable tunnel</label>
          </div>
          {status && <p class="text-xs text-zinc-500">{status}</p>}
          <div class="flex gap-3 pt-1">
            <button onClick={onClose} class="flex-1 text-sm font-medium px-4 py-2 rounded-lg border border-zinc-200 text-zinc-600 hover:bg-zinc-50 transition-colors">Cancel</button>
            <button onClick={create} disabled={busy} class="flex-1 text-sm font-medium px-4 py-2 rounded-lg bg-zinc-900 text-white hover:bg-zinc-700 transition-colors disabled:opacity-60">
              {busy ? 'Creating…' : 'Create'}
            </button>
          </div>
        </div>
      </div>
    </Modal>
  );
}

function AddProjectModal({ onClose, onAdded }: any) {
  const [tab, setTab] = useState<'existing' | 'new'>('existing');
  const [github, setGithub] = useState('');
  const [newName, setNewName] = useState('');
  const [label, setLabel] = useState('');
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit() {
    const name = tab === 'new' ? newName.trim() : '';
    const gh = tab === 'existing' ? github.trim() : '';
    if (tab === 'existing' ? !gh : !name) return;
    setBusy(true);
    setStatus(tab === 'existing' ? 'Cloning repo…' : 'Initialising repo…');
    const res = await post('/api/project/add', { github: gh, name, label: label.trim() });
    if (res.ok) {
      setStatus(`✓ Added ${res.name} (port band ${res.base}–${res.base + 99})`);
      onAdded();
      setTimeout(onClose, 1800);
    } else {
      setStatus('✗ ' + (res.error ?? 'failed'));
      setBusy(false);
    }
  }

  const tabCls = (t: string) => `flex-1 text-xs font-medium py-1.5 rounded-md transition-colors ${tab === t ? 'bg-white text-zinc-900 shadow-sm' : 'text-zinc-500'}`;

  return (
    <Modal onClose={onClose}>
      <div class="bg-white rounded-2xl border border-zinc-200 shadow-2xl p-6 w-full max-w-sm mx-4">
        <div class="flex items-center justify-between mb-5">
          <div>
            <h2 class="text-base font-semibold text-zinc-900">Add project</h2>
            <p class="text-xs text-zinc-400 mt-0.5">Register a new or existing repo</p>
          </div>
          <CloseBtn onClick={onClose} />
        </div>
        <div class="flex flex-col gap-4">
          <div class="flex gap-1 bg-zinc-100 rounded-lg p-0.5 mb-1">
            <button class={tabCls('existing')} onClick={() => setTab('existing')}>Existing repo</button>
            <button class={tabCls('new')} onClick={() => setTab('new')}>New repo</button>
          </div>

          {tab === 'existing' ? (
            <div class="flex flex-col gap-1.5">
              <label class="text-xs text-zinc-500">GitHub URL or slug</label>
              <input value={github} onInput={(e: any) => setGithub(e.target.value)}
                placeholder="org/repo or https://github.com/org/repo" autocomplete="off" autoFocus class={inputCls} />
            </div>
          ) : (
            <div class="flex flex-col gap-1.5">
              <label class="text-xs text-zinc-500">Repo name</label>
              <input value={newName} onInput={(e: any) => setNewName(e.target.value)}
                placeholder="my-new-project" autocomplete="off" autoFocus class={inputCls} />
              <p class="text-[11px] text-zinc-400">Creates a bare local repo at ~/workspace/&lt;name&gt;.git — push a remote later.</p>
            </div>
          )}

          <div class="flex flex-col gap-1.5">
            <label class="text-xs text-zinc-500">Label <span class="text-zinc-300">(optional)</span></label>
            <input value={label} onInput={(e: any) => setLabel(e.target.value)} placeholder="My App" autocomplete="off" class={inputCls} />
          </div>

          {status && <p class="text-xs text-zinc-500">{status}</p>}

          <div class="flex gap-3 pt-1">
            <button onClick={onClose} class="flex-1 text-sm font-medium px-4 py-2 rounded-lg border border-zinc-200 text-zinc-600 hover:bg-zinc-50 transition-colors">Cancel</button>
            <button onClick={submit} disabled={busy} class="flex-1 text-sm font-medium px-4 py-2 rounded-lg bg-zinc-900 text-white hover:bg-zinc-700 transition-colors disabled:opacity-60">
              {busy ? 'Adding…' : 'Add'}
            </button>
          </div>
        </div>
      </div>
    </Modal>
  );
}

const LOG_TABS = ['dev', 'tunnel', 'inngest', 'trigger', 'setup'] as const;

function LogModal({ repo, name, initialType, onClose }: any) {
  const [type, setType] = useState(initialType ?? 'dev');
  const [text, setText] = useState('Loading…');
  const preRef = useRef<HTMLPreElement>(null);

  useEffect(() => {
    let alive = true;
    async function load() {
      const data = await fetch(`/api/logs?repo=${repo}&name=${encodeURIComponent(name)}&type=${type}`)
        .then(r => r.json()).catch(() => ({ lines: [] }));
      if (!alive) return;
      setText(data.lines.length ? data.lines.join('\n') : '(no log yet — start the dev server first)');
      requestAnimationFrame(() => { if (preRef.current) preRef.current.scrollTop = preRef.current.scrollHeight; });
    }
    load();
    const t = setInterval(load, 2000);
    return () => { alive = false; clearInterval(t); };
  }, [repo, name, type]);

  return (
    <Modal onClose={onClose} position="bottom">
      <div class="bg-white border-t border-zinc-200 shadow-2xl w-full" style="height:60vh; display:flex; flex-direction:column;">
        <div class="flex items-center gap-3 px-5 py-3 border-b border-zinc-100 shrink-0">
          <div class="flex gap-1 bg-zinc-100 rounded-lg p-0.5">
            {LOG_TABS.map(t => (
              <button key={t} onClick={() => setType(t)}
                class={`text-xs font-medium px-3 py-1 rounded-md transition-colors ${type === t ? 'bg-white text-zinc-900 shadow-sm' : 'text-zinc-500 hover:text-zinc-700'}`}>
                {t === 'dev' ? 'Dev server' : t[0].toUpperCase() + t.slice(1)}
              </button>
            ))}
          </div>
          <span class="text-xs text-zinc-400 flex-1">{repo}/{name} • {type}.log</span>
          <button onClick={() => navigator.clipboard.writeText(text).catch(() => {})} data-tip="Copy all"
            class="tip icon-btn text-zinc-400 hover:text-zinc-600 hover:bg-zinc-100">
            <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><rect x="9" y="9" width="13" height="13" rx="2" /><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" /></svg>
          </button>
          <CloseBtn onClick={onClose} />
        </div>
        <pre ref={preRef} class="flex-1 overflow-auto text-[11px] leading-relaxed font-mono text-zinc-600 bg-zinc-50 px-5 py-4 whitespace-pre-wrap break-all">{text}</pre>
      </div>
    </Modal>
  );
}

function WorktreeCard({ w, pending, agents, onAct, onStart, onOpenLogs, onOpenTool, onRemove, toast }: any) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!menuOpen) return;
    const close = () => setMenuOpen(false);
    document.addEventListener('click', close);
    return () => document.removeEventListener('click', close);
  }, [menuOpen]);

  function copyCD() {
    navigator.clipboard.writeText(`cd ~/workspace/${w.repo}/${w.name}`)
      .then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); })
      .catch(() => toast('clipboard unavailable'));
  }

  const badge = BADGE_COLORS[w.label] ?? 'bg-zinc-100 text-zinc-500';

  return (
    <div class={`rounded-xl border ${w.active ? 'border-l-[3px] border-l-emerald-400 border-zinc-200 bg-white' : 'border-zinc-200 bg-white'} px-5 py-4 flex items-center gap-4 shadow-sm hover:shadow transition-shadow`}>
      <div class="flex-1 min-w-0">
        <div class="flex items-center gap-2 mb-1">
          <span class={`text-[11px] font-semibold px-2 py-0.5 rounded-full ${badge} shrink-0`}>{w.label}</span>
          <span class="text-zinc-900 font-semibold text-sm truncate">{w.name}</span>
          <span class={`flex items-center gap-1 text-xs ${w.active ? 'text-emerald-600' : w.queued ? 'text-amber-600' : 'text-zinc-400'} shrink-0 ml-1`}>
            <span class={`w-1.5 h-1.5 rounded-full ${w.active ? 'bg-emerald-500' : w.queued ? 'bg-amber-400' : 'bg-zinc-300'}`} />
            {w.active ? 'running' : w.queued ? `queued #${w.queuePosition}` : 'stopped'}
          </span>
          {w.container && (
            <span data-tip="Running in a container — real memory/CPU cap" class="tip text-[10px] font-medium px-1.5 py-0.5 rounded bg-sky-50 text-sky-600 shrink-0">
              container
            </span>
          )}
        </div>
        <div class="flex items-center gap-2 flex-wrap">
          <span class="font-mono text-xs text-zinc-400">{w.domain}</span>
          {w.tunnelOn && <span class="font-mono text-xs text-sky-500">{w.pubDomain}</span>}
          {w.inngestActive && (
            <a href={`http://localhost:${w.inngestPort}`} target="_blank" title="Inngest dashboard"
              class="flex items-center gap-1 text-xs text-orange-500 hover:text-orange-600 transition-colors shrink-0">
              <span class="w-1.5 h-1.5 rounded-full bg-orange-400" />inngest:{w.inngestPort}
            </a>
          )}
          {w.triggerActive && (
            <button onClick={() => onOpenLogs(w.repo, w.name, 'trigger')} title="trigger.dev logs"
              class="flex items-center gap-1 text-xs text-emerald-600 hover:text-emerald-700 transition-colors shrink-0">
              <span class="w-1.5 h-1.5 rounded-full bg-emerald-500" />trigger
            </button>
          )}
          {w.branchUrl && (
            <a href={w.branchUrl} target="_blank" class="flex items-center gap-1 text-xs text-zinc-400 hover:text-zinc-700 transition-colors shrink-0">
              <svg class="w-3 h-3" fill="currentColor" viewBox="0 0 16 16"><path d="M5 3.25a.75.75 0 1 1-1.5 0 .75.75 0 0 1 1.5 0zm0 2.122a2.25 2.25 0 1 0-1.5 0v.878A2.25 2.25 0 0 0 5.75 8.5h1.5v2.128a2.251 2.251 0 1 0 1.5 0V8.5h1.5a2.25 2.25 0 0 0 2.25-2.25v-.878a2.25 2.25 0 1 0-1.5 0v.878a.75.75 0 0 1-.75.75h-4.5A.75.75 0 0 1 5 6.25v-.878zm3.75 7.378a.75.75 0 1 1-1.5 0 .75.75 0 0 1 1.5 0zm3-8.75a.75.75 0 1 1-1.5 0 .75.75 0 0 1 1.5 0z" /></svg>branch
            </a>
          )}
          {w.pr && (
            <a href={w.pr.url} target="_blank" class="flex items-center gap-1 text-xs text-emerald-600 hover:text-emerald-700 transition-colors shrink-0">
              <svg class="w-3 h-3" fill="currentColor" viewBox="0 0 16 16"><path d="M1.5 3.25a2.25 2.25 0 1 1 3 2.122v5.256a2.251 2.251 0 1 1-1.5 0V5.372A2.25 2.25 0 0 1 1.5 3.25zm5.677-.177L9.573.677A.25.25 0 0 1 10 .854V2.5h1A2.5 2.5 0 0 1 13.5 5v5.628a2.251 2.251 0 1 1-1.5 0V5a1 1 0 0 0-1-1h-1v1.646a.25.25 0 0 1-.427.177L7.177 3.427a.25.25 0 0 1 0-.354zM3.75 2.5a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5zm0 9.5a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5zm8.25.75a.75.75 0 1 1 1.5 0 .75.75 0 0 1-1.5 0z" /></svg>PR #{w.pr.number}
            </a>
          )}
        </div>
      </div>

      <div class="flex items-center gap-1 shrink-0">
        <a href={`http://${w.domain}`} target="_blank" data-tip="Open in browser"
          class={`tip icon-btn ${w.active ? 'text-zinc-600 hover:text-zinc-900 hover:bg-zinc-100' : 'text-zinc-300 pointer-events-none'}`}>
          <svg class="w-4 h-4" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" /></svg>
        </a>

        {w.active ? (
          <button onClick={() => onAct('/api/stop', w)} data-tip="Stop server" class="tip icon-btn text-red-500 hover:bg-red-50">
            <svg class="w-4 h-4" fill="currentColor" viewBox="0 0 24 24"><rect x="6" y="6" width="12" height="12" rx="2" /></svg>
          </button>
        ) : w.queued ? (
          <button onClick={() => onAct('/api/stop', w)} data-tip={`Queued #${w.queuePosition} — click to cancel`} class="tip icon-btn text-amber-500 hover:bg-amber-50">
            <svg class="w-4 h-4" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10" /><path stroke-linecap="round" d="M12 6v6l4 2" /></svg>
          </button>
        ) : pending ? (
          <button disabled data-tip="Starting…" class="tip icon-btn text-emerald-400 cursor-not-allowed opacity-70">
            <svg class="w-4 h-4 spin" fill="none" stroke="currentColor" stroke-width="2.5" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" /></svg>
          </button>
        ) : (
          <button onClick={() => onStart(w)} data-tip="Start server" class="tip icon-btn text-emerald-600 hover:bg-emerald-50">
            <svg class="w-4 h-4" fill="currentColor" viewBox="0 0 24 24"><path d="M8 5v14l11-7z" /></svg>
          </button>
        )}

        <div class="w-px h-4 bg-zinc-200 mx-1" />

        {agents.map((a: { id: string; label: string }) => (
          <button key={a.id} onClick={() => onOpenTool(w, a.id)} data-tip={`Open in ${a.label}`} class="tip icon-btn text-zinc-500 hover:bg-zinc-100">
            <ToolIcon domain={AGENT_ICON_DOMAIN[a.id] ?? ''} fallback={a.label.slice(0, 2).toUpperCase()} />
          </button>
        ))}

        <button onClick={copyCD} data-tip="Copy cd command" class="tip icon-btn text-zinc-400 hover:text-zinc-600 hover:bg-zinc-100">
          {copied
            ? <svg class="w-3.5 h-3.5 text-emerald-500" fill="none" stroke="currentColor" stroke-width="2.5" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M5 13l4 4L19 7" /></svg>
            : <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><rect x="9" y="9" width="13" height="13" rx="2" /><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" /></svg>}
        </button>

        <div class="w-px h-4 bg-zinc-200 mx-1" />

        <button onClick={() => onAct(w.tunnelOn ? '/api/tunnel/disable' : '/api/tunnel/enable', w)}
          data-tip={w.tunnelRunning ? 'Tunnel live — click to disable' : w.tunnelOn ? 'Tunnel configured, not running' : 'Enable tunnel'}
          class={`tip icon-btn ${w.tunnelRunning ? 'text-sky-500 hover:bg-sky-50' : w.tunnelOn ? 'text-sky-300 hover:bg-sky-50' : 'text-zinc-400 hover:text-zinc-600 hover:bg-zinc-100'}`}>
          <svg class="w-4 h-4" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10" /><path d="M2 12h20M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" /></svg>
        </button>

        <button onClick={() => onAct(w.inngestActive ? '/api/inngest/stop' : '/api/inngest/start', w)}
          data-tip={w.inngestActive ? 'Stop Inngest' : 'Start Inngest'}
          class={`tip icon-btn ${w.inngestActive ? 'text-orange-500 hover:bg-orange-50' : 'text-zinc-400 hover:text-zinc-600 hover:bg-zinc-100'}`}>
          <ToolIcon domain="inngest.com" fallback="IN" />
        </button>

        <button onClick={() => onAct(w.triggerActive ? '/api/trigger/stop' : '/api/trigger/start', w)}
          data-tip={w.triggerActive ? 'Stop trigger.dev' : 'Start trigger.dev'}
          class={`tip icon-btn ${w.triggerActive ? 'text-emerald-500 hover:bg-emerald-50' : 'text-zinc-400 hover:text-zinc-600 hover:bg-zinc-100'}`}>
          <ToolIcon domain="trigger.dev" fallback="T" />
        </button>

        <div class="relative">
          <button onClick={(e: any) => { e.stopPropagation(); setMenuOpen(!menuOpen); }} data-tip="More"
            class="tip icon-btn text-zinc-400 hover:text-zinc-600 hover:bg-zinc-100">
            <svg class="w-4 h-4" fill="currentColor" viewBox="0 0 24 24"><circle cx="12" cy="5" r="1.5" /><circle cx="12" cy="12" r="1.5" /><circle cx="12" cy="19" r="1.5" /></svg>
          </button>
          {menuOpen && (
            <div class="absolute right-0 top-8 bg-white border border-zinc-200 rounded-xl shadow-lg z-10 py-1 min-w-[180px]">
              <button onClick={() => { setMenuOpen(false); onOpenLogs(w.repo, w.name, 'dev'); }}
                class="w-full text-left px-3 py-1.5 text-xs text-zinc-700 hover:bg-zinc-50 flex items-center gap-2 transition-colors whitespace-nowrap">
                <svg class="w-3 h-3 shrink-0 text-zinc-400" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" /></svg>
                View logs
              </button>
              <div class="my-1 border-t border-zinc-100" />
              <button onClick={() => { setMenuOpen(false); onRemove(w); }}
                class="w-full text-left px-3 py-1.5 text-xs text-red-600 hover:bg-red-50 flex items-center gap-2 transition-colors whitespace-nowrap">
                <svg class="w-3 h-3 shrink-0" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" /></svg>
                Remove worktree
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function PortsPanel() {
  const [open, setOpen] = useState(false);
  const [ports, setPorts] = useState<PortInfo[]>([]);

  const load = useCallback(async () => {
    setPorts(await fetch('/api/ports').then(r => r.json()).catch(() => []));
  }, []);

  useEffect(() => {
    if (!open) return;
    load();
    const t = setInterval(load, 3000);
    return () => clearInterval(t);
  }, [open, load]);

  async function kill(port: number) {
    await post('/api/ports/kill', { port });
    load();
  }

  return (
    <div class="mt-8">
      <button onClick={() => setOpen(!open)} class="flex items-center gap-2 text-xs font-medium text-zinc-400 hover:text-zinc-600 transition-colors mb-3">
        <svg class="w-3.5 h-3.5 transition-transform" style={{ transform: open ? 'rotate(90deg)' : '' }}
          fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M9 5l7 7-7 7" /></svg>
        Active ports (3000–3999)
      </button>
      {open && (
        <div class="bg-white border border-zinc-200 rounded-xl overflow-hidden text-xs">
          {!ports.length
            ? <p class="text-zinc-400 px-4 py-3">No processes on ports 3000–3999</p>
            : ports.map(p => (
              <div key={p.port} class="flex items-center gap-3 px-4 py-2.5 border-b border-zinc-100 last:border-0">
                <span class="font-mono font-medium text-zinc-900 w-12">{p.port}</span>
                <span class="text-zinc-400 w-10">PID {p.pid}</span>
                <span class="text-zinc-500 flex-1 truncate">{p.cmd}{p.worktree && <span class="text-zinc-400"> · {p.worktree}</span>}</span>
                <button onClick={() => kill(p.port)} class="text-red-400 hover:text-red-600 transition-colors px-2 py-0.5 rounded hover:bg-red-50 font-medium">kill</button>
              </div>
            ))}
        </div>
      )}
    </div>
  );
}

function App() {
  const [worktrees, setWorktrees] = useState<Worktree[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [agents, setAgents] = useState<{ id: string; label: string }[]>([]);
  const [filter, setFilter] = useState('all');
  const [toastMsg, setToastMsg] = useState('');
  const [createOpen, setCreateOpen] = useState(false);
  const [addProjectOpen, setAddProjectOpen] = useState(false);
  const [logView, setLogView] = useState<{ repo: string; name: string; type: string } | null>(null);
  const pendingStart = useRef(new Set<string>());
  const toastTimer = useRef<any>(null);

  function toast(msg: string) {
    setToastMsg(msg);
    clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToastMsg(''), 5000);
  }

  const refresh = useCallback(async () => {
    const wts: Worktree[] = await fetch('/api/worktrees').then(r => r.json()).catch(() => []);
    for (const w of wts) if (w.active) pendingStart.current.delete(w.key);
    setWorktrees(wts);
  }, []);

  const loadProjects = useCallback(async () => {
    setProjects(await fetch('/api/projects').then(r => r.json()).catch(() => []));
  }, []);

  // Which "open in <tool>" buttons to show isn't fixed to one project's usual
  // 4 tools — fetched once from whatever's actually installed on this machine.
  const loadAgents = useCallback(async () => {
    setAgents(await fetch('/api/agents').then(r => r.json()).catch(() => []));
  }, []);

  // poll — fast while a start is pending
  useEffect(() => {
    loadProjects();
    loadAgents();
    let alive = true;
    (async function loop() {
      while (alive) {
        await refresh();
        await new Promise(r => setTimeout(r, pendingStart.current.size ? 800 : 3000));
      }
    })();
    return () => { alive = false; };
  }, [refresh, loadProjects, loadAgents]);

  async function act(url: string, w: Worktree) {
    const res = await post(url, { repo: w.repo, name: w.name });
    if (res && res.ok === false) toast(`✗ ${url.replace('/api/', '')} failed: ${res.error ?? 'unknown error'}`);
    refresh();
  }

  async function start(w: Worktree) {
    pendingStart.current.add(w.key);
    setWorktrees([...worktrees]);
    const res = await post('/api/start', { repo: w.repo, name: w.name });
    if (res && res.ok === false) { toast(`✗ start failed: ${res.error ?? 'unknown error'}`); pendingStart.current.delete(w.key); }
    refresh();
  }

  async function remove(w: Worktree) {
    if (!confirm(`Remove worktree "${w.name}"? The branch will not be deleted.`)) return;
    const res = await post('/api/remove', { repo: w.repo, name: w.name });
    if (!res.ok) toast(`✗ remove failed: ${res.error ?? 'unknown error'}`);
    refresh();
  }

  const filtered = filter === 'all' ? worktrees : worktrees.filter(w => w.repo === filter);

  return (
    <div class="max-w-5xl mx-auto px-6 py-12">
      <div class="flex items-center justify-between mb-6">
        <div>
          <h1 class="text-xl font-semibold text-zinc-900 tracking-tight">setu</h1>
          <p class="text-sm text-zinc-400 mt-0.5 flex items-center gap-1.5">
            <span class="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse inline-block" />dev portal
          </p>
        </div>
        <div class="flex items-center gap-3">
          <select value={filter} onChange={(e: any) => setFilter(e.target.value)}
            class="bg-white border border-zinc-200 text-zinc-700 text-sm rounded-lg px-3 py-1.5 focus:outline-none focus:border-zinc-400">
            <option value="all">All</option>
            {projects.map(p => <option key={p.name} value={p.name}>{p.label}</option>)}
          </select>
          <button onClick={() => setAddProjectOpen(true)}
            class="text-sm font-medium px-4 py-1.5 rounded-lg border border-zinc-200 text-zinc-600 hover:bg-zinc-50 transition-colors">
            + Project
          </button>
          <button onClick={() => setCreateOpen(true)}
            class="text-sm font-medium px-4 py-1.5 rounded-lg bg-zinc-900 text-white hover:bg-zinc-700 transition-colors">
            + Worktree
          </button>
        </div>
      </div>

      <div class="flex flex-col gap-2.5">
        {!filtered.length
          ? <p class="text-zinc-400 text-sm py-10 text-center">No worktrees{filter !== 'all' ? ' for this project' : ''} — click + Worktree to create one.</p>
          : filtered.map(w => (
            <WorktreeCard key={w.key} w={w} pending={pendingStart.current.has(w.key)} agents={agents}
              onAct={act} onStart={start} onRemove={remove} toast={toast}
              onOpenLogs={(repo: string, name: string, type: string) => setLogView({ repo, name, type })}
              onOpenTool={(w: Worktree, tool: string) => post('/api/open', { repo: w.repo, name: w.name, tool })} />
          ))}
      </div>

      <PortsPanel />

      {createOpen && <CreateModal projects={projects} onClose={() => setCreateOpen(false)} onCreated={refresh} toast={toast} />}
      {addProjectOpen && <AddProjectModal onClose={() => setAddProjectOpen(false)} onAdded={loadProjects} />}
      {logView && <LogModal repo={logView.repo} name={logView.name} initialType={logView.type} onClose={() => setLogView(null)} />}
      {toastMsg && <div class="fixed bottom-5 left-1/2 -translate-x-1/2 bg-zinc-900 text-white text-xs px-4 py-2.5 rounded-lg shadow-lg z-[60] max-w-md">{toastMsg}</div>}
    </div>
  );
}

render(<App />, document.getElementById('root')!);
