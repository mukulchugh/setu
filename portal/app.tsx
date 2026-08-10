// setu portal UI — Preact, bundled by Bun.serve at runtime (see portal.js)
import { render } from 'preact';
import { useState, useEffect, useRef, useCallback } from 'preact/hooks';
import {
  Badge, StatusDot, StatusFlap, IconButton, PrimaryButton, SecondaryButton,
  Modal, CloseBtn, Menu, MenuItem, inputCls, type Tone, PageHeader, Section,
} from './ui';
import { siClaude, siCursor, siOpencode, siAmp, siGoogle, siX } from 'simple-icons';

type Worktree = {
  key: string; repo: string; name: string; slug: string; port: number;
  domain: string; pubDomain: string; tunnelOn: boolean; active: boolean;
  container: string | null; nextStartMode: 'container' | 'bare';
  tunnelRunning: boolean; label: string; branchUrl: string | null;
  pr: { url: string; number: number; title: string } | null;
  inngestActive: boolean; inngestPort: number; triggerActive: boolean;
  queued?: boolean; queuePosition?: number | null;
  lastCommitAt: number | null; ahead: number; behind: number; dirty: number; memMb: number | null;
  createdAt: number | null;
};
type Project = { name: string; label: string };
type PortInfo = { port: number; pid: string; cmd: string; worktree: string | null };
type Status = {
  concurrency: { active: number; max: number; queued: number };
  container: { engineAvailable: boolean; engine: string | null; memoryLimit: string; cpuLimit: number };
};

// Minimal router — one detail view alongside the existing list/grid doesn't
// justify a router dependency; history.pushState + popstate is the native
// platform feature that already does exactly this.
type Route = { page: 'list' } | { page: 'detail'; repo: string; name: string };

function parseRoute(pathname: string): Route {
  const m = pathname.match(/^\/worktree\/([^/]+)\/(.+)$/);
  return m ? { page: 'detail', repo: decodeURIComponent(m[1]), name: decodeURIComponent(m[2]) } : { page: 'list' };
}

function navigate(path: string) {
  history.pushState(null, '', path);
  window.dispatchEvent(new PopStateEvent('popstate'));
}

function useRoute(): Route {
  const [route, setRoute] = useState<Route>(() => parseRoute(location.pathname));
  useEffect(() => {
    const onNav = () => setRoute(parseRoute(location.pathname));
    window.addEventListener('popstate', onNav);
    return () => window.removeEventListener('popstate', onNav);
  }, []);
  return route;
}

async function post(url: string, body: any) {
  try {
    const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    return await r.json();
  } catch (e) { return { ok: false, error: String(e) }; }
}

// "3h ago" style — lastCommitAt is a unix-seconds timestamp from the batched
// git for-each-ref call (see repoGitMeta in portal.js), null if a branch's
// commit data wasn't resolvable (e.g. a worktree whose branch got renamed
// out from under the registry).
function relativeTime(unixSeconds: number | null): string {
  if (!unixSeconds) return '';
  const s = Date.now() / 1000 - unixSeconds;
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  if (s < 2592000) return `${Math.floor(s / 86400)}d ago`;
  return `${Math.floor(s / 2592000)}mo ago`;
}

// Real brand marks, SVG path data bundled at build time — not fetched at
// runtime (a live per-icon image request is a fragile dependency; confirmed
// twice tonight when chatgpt.com/favicon.ico and openai.com/favicon.ico both
// returned an HTML challenge page instead of image bytes). Verified directly
// against the installed simple-icons package (v16.28.0, latest as of this
// check; scanned all 3453 entries) — it carries no OpenAI/Codex mark at all,
// a deliberate licensing exclusion rather than a missing slug. The actual
// OpenAI mark below is sourced once from lobehub/lobe-icons (MIT-licensed,
// github.com/lobehub/lobe-icons/packages/static-svg — an icon set built
// specifically for AI-provider brand marks, unlike simple-icons which
// excludes them) and hardcoded here the same way the simple-icons ones are.
// Antigravity and Grok get real marks even though neither is "in" either
// library under its own name: Antigravity is Google's own coding tool (built
// by the ex-Windsurf team after the acquisition), and Grok is xAI's product,
// shipped inside and inseparable from the X app — both a legitimate,
// correct parent-brand icon rather than a fabricated one.
const siOpenai = {
  hex: '000000',
  path: 'M9.205 8.658v-2.26c0-.19.072-.333.238-.428l4.543-2.616c.619-.357 1.356-.523 2.117-.523 2.854 0 4.662 2.212 4.662 4.566 0 .167 0 .357-.024.547l-4.71-2.759a.797.797 0 00-.856 0l-5.97 3.473zm10.609 8.8V12.06c0-.333-.143-.57-.429-.737l-5.97-3.473 1.95-1.118a.433.433 0 01.476 0l4.543 2.617c1.309.76 2.189 2.378 2.189 3.948 0 1.808-1.07 3.473-2.76 4.163zM7.802 12.703l-1.95-1.142c-.167-.095-.239-.238-.239-.428V5.899c0-2.545 1.95-4.472 4.591-4.472 1 0 1.927.333 2.712.928L8.23 5.067c-.285.166-.428.404-.428.737v6.898zM12 15.128l-2.795-1.57v-3.33L12 8.658l2.795 1.57v3.33L12 15.128zm1.796 7.23c-1 0-1.927-.332-2.712-.927l4.686-2.712c.285-.166.428-.404.428-.737v-6.898l1.974 1.142c.167.095.238.238.238.428v5.233c0 2.545-1.974 4.472-4.614 4.472zm-5.637-5.303l-4.544-2.617c-1.308-.761-2.188-2.378-2.188-3.948A4.482 4.482 0 014.21 6.327v5.423c0 .333.143.571.428.738l5.947 3.449-1.95 1.118a.432.432 0 01-.476 0zm-.262 3.9c-2.688 0-4.662-2.021-4.662-4.519 0-.19.024-.38.047-.57l4.686 2.71c.286.167.571.167.856 0l5.97-3.448v2.26c0 .19-.07.333-.237.428l-4.543 2.616c-.619.357-1.356.523-2.117.523zm5.899 2.83a5.947 5.947 0 005.827-4.756C22.287 18.339 24 15.84 24 13.296c0-1.665-.713-3.282-1.998-4.448.119-.5.19-.999.19-1.498 0-3.401-2.759-5.947-5.946-5.947-.642 0-1.26.095-1.88.31A5.962 5.962 0 0010.205 0a5.947 5.947 0 00-5.827 4.757C1.713 5.447 0 7.945 0 10.49c0 1.666.713 3.283 1.998 4.448-.119.5-.19 1-.19 1.499 0 3.401 2.759 5.946 5.946 5.946.642 0 1.26-.095 1.88-.309a5.96 5.96 0 004.162 1.713z',
};

const AGENT_ICON: Record<string, { path: string; hex: string }> = {
  claude: siClaude, cursor: siCursor, opencode: siOpencode, amp: siAmp,
  antigravity: siGoogle, grok: siX, codex: siOpenai,
};

// Bundled SVG path data, not a fetched favicon — an external image request
// per icon (google's favicon service) is a real network dependency for a
// purely cosmetic detail, and it failed/hung often enough in practice to
// leave broken-image placeholders instead of the intended fallback
// (confirmed live: every agent icon rendered broken, not text, meaning the
// onError handler never reliably fired). Bundled path data has no such
// failure mode — it's not a request.
function ToolIcon({ id, label }: { id?: string; label: string }) {
  const icon = id && AGENT_ICON[id];
  if (icon) return (
    <svg viewBox="0 0 24 24" class="w-3.5 h-3.5" fill={`#${icon.hex}`}><path d={icon.path} /></svg>
  );
  return <span class="text-[9px] font-bold tracking-tight">{label.slice(0, 2).toUpperCase()}</span>;
}

function CreateModal({ projects, onClose, onCreated }: any) {
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
      <div class="bg-white rounded-none border border-zinc-200 shadow-2xl p-6 w-full max-w-sm mx-4">
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
            <SecondaryButton onClick={onClose}>Cancel</SecondaryButton>
            <PrimaryButton onClick={create} disabled={busy}>{busy ? 'Creating…' : 'Create'}</PrimaryButton>
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

  const tabCls = (t: string) => `flex-1 text-xs font-medium py-1.5 rounded-none transition-all duration-150 ${tab === t ? 'bg-white text-zinc-900 shadow-sm' : 'text-zinc-500'}`;

  return (
    <Modal onClose={onClose}>
      <div class="bg-white rounded-none border border-zinc-200 shadow-2xl p-6 w-full max-w-sm mx-4">
        <div class="flex items-center justify-between mb-5">
          <div>
            <h2 class="text-base font-semibold text-zinc-900">Add project</h2>
            <p class="text-xs text-zinc-400 mt-0.5">Register a new or existing repo</p>
          </div>
          <CloseBtn onClick={onClose} />
        </div>
        <div class="flex flex-col gap-4">
          <div class="flex gap-1 bg-zinc-100 rounded-none p-0.5 mb-1">
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
            <SecondaryButton onClick={onClose}>Cancel</SecondaryButton>
            <PrimaryButton onClick={submit} disabled={busy}>{busy ? 'Adding…' : 'Add'}</PrimaryButton>
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
          <div class="flex gap-1 bg-zinc-100 rounded-none p-0.5">
            {LOG_TABS.map(t => (
              <button key={t} onClick={() => setType(t)}
                class={`text-xs font-medium px-3 py-1 rounded-none transition-all duration-150 ${type === t ? 'bg-white text-zinc-900 shadow-sm' : 'text-zinc-500 hover:text-zinc-700'}`}>
                {t === 'dev' ? 'Dev server' : t[0].toUpperCase() + t.slice(1)}
              </button>
            ))}
          </div>
          <span class="text-xs text-zinc-400 flex-1">{repo}/{name} • {type}.log</span>
          <IconButton tip="Copy all" onClick={() => navigator.clipboard.writeText(text).catch(() => {})}>
            <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><rect x="9" y="9" width="13" height="13" rx="2" /><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" /></svg>
          </IconButton>
          <CloseBtn onClick={onClose} />
        </div>
        <pre ref={preRef} class="flex-1 overflow-auto text-[11px] leading-relaxed font-mono text-zinc-600 bg-zinc-50 px-5 py-4 whitespace-pre-wrap break-all">{text}</pre>
      </div>
    </Modal>
  );
}

// Start is a split action: the primary click uses the sticky per-worktree
// default (mode omitted from the request entirely — see lib.js's
// defaultContainerMode), the caret forces a specific mode. Showing
// nextStartMode *before* the click, not after, is the actual point: a silent
// mode switch is what caused a real incident (an established, always-bare
// worktree got switched to a container mid-restart with no explicit choice
// from anyone) — surfacing the resolved mode up front removes the blind spot.
function StartControl({ w, pending, onStart }: { w: Worktree; pending: boolean; onStart: (w: Worktree, force?: 'container' | 'bare') => void }) {
  if (pending) {
    return (
      <IconButton tone="emerald" tip="Starting…" disabled>
        <svg class="w-4 h-4 spin" fill="none" stroke="currentColor" stroke-width="2.5" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" /></svg>
      </IconButton>
    );
  }
  return (
    <div class="flex items-center">
      <IconButton tone="emerald" tip={`Start — will run ${w.nextStartMode}`} onClick={() => onStart(w)}>
        <svg class="w-4 h-4" fill="currentColor" viewBox="0 0 24 24"><path d="M8 5v14l11-7z" /></svg>
      </IconButton>
      <Menu trigger={toggle => (
        <button onClick={(e: any) => { e.stopPropagation(); toggle(); }} data-tip="Force a mode"
          class="tip w-4 h-6 flex items-center justify-center text-zinc-300 hover:text-zinc-500 transition-colors duration-150 -ml-1">
          <svg class="w-3 h-3" fill="currentColor" viewBox="0 0 24 24"><path d="M7 10l5 5 5-5z" /></svg>
        </button>
      )}>
        <MenuItem onClick={() => onStart(w, 'bare')}>Force bare (no cap)</MenuItem>
        <MenuItem onClick={() => onStart(w, 'container')}>Force container</MenuItem>
      </Menu>
    </div>
  );
}

function WorktreeCard({ w, pending, agents, onAct, onStart, onOpenLogs, onOpenTool, onRemove, toast, gridMode }: any) {
  const [copied, setCopied] = useState(false);

  function copyCD() {
    navigator.clipboard.writeText(`cd ~/workspace/${w.repo}/${w.name}`)
      .then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); })
      .catch(() => toast('clipboard unavailable'));
  }

  const statusTone: Tone = w.active ? 'emerald' : w.queued ? 'amber' : 'zinc';
  const showInngestInline = w.inngestActive;
  const showTriggerInline = w.triggerActive;

  return (
    <div class={`wt-card group rounded-none border bg-white/85 dark:bg-zinc-900/55 backdrop-blur-md transition-all duration-200 ease-out hover:border-zinc-300 dark:hover:border-zinc-700 hover:bg-white/95 dark:hover:bg-zinc-900/75 ${
      gridMode ? 'flex flex-col gap-3 px-5 py-5' : 'flex items-center gap-4 px-6 py-4'} ${
      w.active ? 'border-l-[3px] border-l-signal-green border-zinc-200 dark:border-zinc-800' : 'border-zinc-200 dark:border-zinc-800'}`}>
      <div class="flex-1 min-w-0">
        <div class={`flex items-baseline gap-2.5 mb-1 ${gridMode ? 'flex-wrap' : ''}`}>
          <button onClick={() => navigate(`/worktree/${w.repo}/${encodeURIComponent(w.name)}`)}
            class="text-zinc-900 font-medium text-[15px] truncate hover:text-accent transition-colors duration-150 text-left">
            {w.name}
          </button>
          <span class="board-mono text-[10px] text-zinc-300 font-bold shrink-0">{w.label}</span>
          <span class="flex items-center gap-1.5 shrink-0">
            <StatusDot tone={statusTone} pulse={w.active} />
            <StatusFlap text={w.active ? 'running' : w.queued ? `queued #${w.queuePosition}` : 'stopped'} tone={statusTone} />
          </span>
          {w.container && <Badge tone="zinc" tip="Running in a container — real memory/CPU cap">container</Badge>}
          {!w.active && !w.queued && (
            <Badge tone="zinc" tip={w.nextStartMode === 'container'
              ? 'Next Start will use a container (real memory/CPU cap)'
              : 'Next Start will run bare — this worktree has bare-only history'}>
              → {w.nextStartMode}
            </Badge>
          )}
          {w.active && w.memMb != null && (
            <Badge tone={w.memMb > 8192 ? 'amber' : 'zinc'} tip="Live memory footprint of this dev server">
              {w.memMb >= 1024 ? `${(w.memMb / 1024).toFixed(1)}g` : `${Math.round(w.memMb)}m`}
            </Badge>
          )}
          {w.dirty > 0 && (
            <Badge tone="amber" tip={`${w.dirty} uncommitted change${w.dirty > 1 ? 's' : ''}`}>
              {w.dirty} dirty
            </Badge>
          )}
        </div>
        <div class={`flex items-center gap-3 text-xs text-zinc-400 min-w-0 ${gridMode ? 'flex-wrap' : 'flex-wrap'}`}>
          <span class="font-mono truncate max-w-full">{w.domain}</span>
          {w.tunnelOn && <span class="font-mono text-zinc-500 truncate">{w.pubDomain}</span>}
          {w.lastCommitAt && <span class="shrink-0" title="Last commit on this branch">{relativeTime(w.lastCommitAt)}</span>}
          {(w.ahead > 0 || w.behind > 0) && (
            <span class="shrink-0 font-mono" title={`${w.ahead} ahead, ${w.behind} behind its base branch`}>
              {w.ahead > 0 && `↑${w.ahead}`}{w.ahead > 0 && w.behind > 0 && ' '}{w.behind > 0 && `↓${w.behind}`}
            </span>
          )}
          {showInngestInline && (
            <a href={`http://localhost:${w.inngestPort}`} target="_blank" title="Inngest dashboard"
              class="flex items-center gap-1 hover:text-zinc-600 transition-colors duration-150 shrink-0">
              <StatusDot tone="amber" />inngest
            </a>
          )}
          {showTriggerInline && (
            <button onClick={() => onOpenLogs(w.repo, w.name, 'trigger')} title="trigger.dev logs"
              class="flex items-center gap-1 hover:text-zinc-600 transition-colors duration-150 shrink-0">
              <StatusDot tone="emerald" />trigger
            </button>
          )}
          {w.branchUrl && (
            <a href={w.branchUrl} target="_blank" class="flex items-center gap-1 hover:text-zinc-600 transition-colors duration-150 shrink-0">
              <svg class="w-3 h-3" fill="currentColor" viewBox="0 0 16 16"><path d="M5 3.25a.75.75 0 1 1-1.5 0 .75.75 0 0 1 1.5 0zm0 2.122a2.25 2.25 0 1 0-1.5 0v.878A2.25 2.25 0 0 0 5.75 8.5h1.5v2.128a2.251 2.251 0 1 0 1.5 0V8.5h1.5a2.25 2.25 0 0 0 2.25-2.25v-.878a2.25 2.25 0 1 0-1.5 0v.878a.75.75 0 0 1-.75.75h-4.5A.75.75 0 0 1 5 6.25v-.878zm3.75 7.378a.75.75 0 1 1-1.5 0 .75.75 0 0 1 1.5 0zm3-8.75a.75.75 0 1 1-1.5 0 .75.75 0 0 1 1.5 0z" /></svg>branch
            </a>
          )}
          {w.pr && (
            <a href={w.pr.url} target="_blank" class="flex items-center gap-1 hover:text-zinc-600 transition-colors duration-150 shrink-0">
              <svg class="w-3 h-3" fill="currentColor" viewBox="0 0 16 16"><path d="M1.5 3.25a2.25 2.25 0 1 1 3 2.122v5.256a2.251 2.251 0 1 1-1.5 0V5.372A2.25 2.25 0 0 1 1.5 3.25zm5.677-.177L9.573.677A.25.25 0 0 1 10 .854V2.5h1A2.5 2.5 0 0 1 13.5 5v5.628a2.251 2.251 0 1 1-1.5 0V5a1 1 0 0 0-1-1h-1v1.646a.25.25 0 0 1-.427.177L7.177 3.427a.25.25 0 0 1 0-.354zM3.75 2.5a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5zm0 9.5a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5zm8.25.75a.75.75 0 1 1 1.5 0 .75.75 0 0 1-1.5 0z" /></svg>PR #{w.pr.number}
            </a>
          )}
        </div>
      </div>

    <div class={gridMode ? 'flex items-center justify-between gap-2 pt-1 border-t border-zinc-100 dark:border-zinc-800' : 'contents'}>
      <div class="flex items-center gap-0.5 shrink-0 flex-wrap">
        <IconButton tone="zinc" tip="Open in browser" disabled={!w.active} href={`http://${w.domain}`} target="_blank">
          <svg class="w-4 h-4" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" /></svg>
        </IconButton>
        {agents.map((a: { id: string; label: string }) => (
          <IconButton key={a.id} tone="zinc" tip={`Open in ${a.label}`} onClick={() => onOpenTool(w, a.id)}>
            <ToolIcon id={a.id} label={a.label} />
          </IconButton>
        ))}
        <IconButton tone="zinc" tip="Copy cd command" onClick={copyCD}>
          {copied
            ? <svg class="w-3.5 h-3.5 text-emerald-500" fill="none" stroke="currentColor" stroke-width="2.5" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M5 13l4 4L19 7" /></svg>
            : <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><rect x="9" y="9" width="13" height="13" rx="2" /><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" /></svg>}
        </IconButton>
        <IconButton tone={w.tunnelRunning ? 'emerald' : 'zinc'}
          tip={w.tunnelRunning ? 'Tunnel live — click to disable' : w.tunnelOn ? 'Tunnel configured, not running' : 'Enable tunnel'}
          onClick={() => onAct(w.tunnelOn ? '/api/tunnel/disable' : '/api/tunnel/enable', w)}>
          <svg class="w-4 h-4" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10" /><path d="M2 12h20M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" /></svg>
        </IconButton>
      </div>

      {/* Always visible: the one thing you came here to do, and the menu for everything else. */}
      <div class="flex items-center gap-1 shrink-0">
        {w.active ? (
          <IconButton tone="red" tip="Stop server" onClick={() => onAct('/api/stop', w)}>
            <svg class="w-4 h-4" fill="currentColor" viewBox="0 0 24 24"><rect x="6" y="6" width="12" height="12" rx="2" /></svg>
          </IconButton>
        ) : w.queued ? (
          <IconButton tone="amber" tip={`Queued #${w.queuePosition} — click to cancel`} onClick={() => onAct('/api/stop', w)}>
            <svg class="w-4 h-4" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10" /><path stroke-linecap="round" d="M12 6v6l4 2" /></svg>
          </IconButton>
        ) : (
          <StartControl w={w} pending={pending} onStart={onStart} />
        )}

        <Menu trigger={toggle => (
          <IconButton tone="zinc" tip="More" onClick={(e: any) => { e.stopPropagation(); toggle(); }}>
            <svg class="w-4 h-4" fill="currentColor" viewBox="0 0 24 24"><circle cx="12" cy="5" r="1.5" /><circle cx="12" cy="12" r="1.5" /><circle cx="12" cy="19" r="1.5" /></svg>
          </IconButton>
        )}>
          <MenuItem onClick={() => onOpenLogs(w.repo, w.name, 'dev')}
            icon={<svg class="w-3 h-3 shrink-0 text-zinc-400" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" /></svg>}>
            View logs
          </MenuItem>
          {!showInngestInline && (
            <MenuItem onClick={() => onAct('/api/inngest/start', w)} icon={<ToolIcon label="Inngest" />}>
              Start Inngest
            </MenuItem>
          )}
          {showInngestInline && (
            <MenuItem onClick={() => onAct('/api/inngest/stop', w)} icon={<ToolIcon label="Inngest" />}>
              Stop Inngest
            </MenuItem>
          )}
          {!showTriggerInline && (
            <MenuItem onClick={() => onAct('/api/trigger/start', w)} icon={<ToolIcon label="Trigger" />}>
              Start trigger.dev
            </MenuItem>
          )}
          {showTriggerInline && (
            <MenuItem onClick={() => onAct('/api/trigger/stop', w)} icon={<ToolIcon label="Trigger" />}>
              Stop trigger.dev
            </MenuItem>
          )}
          <div class="my-1 border-t border-zinc-100" />
          <MenuItem tone="red" onClick={() => onRemove(w)}
            icon={<svg class="w-3 h-3 shrink-0" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" /></svg>}>
            Remove worktree
          </MenuItem>
        </Menu>
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
    <div class="mt-10">
      <button onClick={() => setOpen(!open)} class="flex items-center gap-2 text-xs font-medium text-zinc-400 hover:text-zinc-600 transition-colors duration-150 mb-3">
        <svg class="w-3.5 h-3.5 transition-transform duration-200" style={{ transform: open ? 'rotate(90deg)' : '' }}
          fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M9 5l7 7-7 7" /></svg>
        Active ports (3000–3999)
      </button>
      <div class={`grid transition-all duration-200 ease-out ${open ? 'grid-rows-[1fr] opacity-100' : 'grid-rows-[0fr] opacity-0'}`}>
        <div class="overflow-hidden">
          <div class="bg-white border border-zinc-200 rounded-none overflow-hidden text-xs">
            {!ports.length
              ? <p class="text-zinc-400 px-4 py-3">No processes on ports 3000–3999</p>
              : ports.map(p => (
                <div key={p.port} class="flex items-center gap-3 px-4 py-2.5 border-b border-zinc-100 last:border-0">
                  <span class="font-mono font-medium text-zinc-900 w-12">{p.port}</span>
                  <span class="text-zinc-400 w-10">PID {p.pid}</span>
                  <span class="text-zinc-500 flex-1 truncate">{p.cmd}{p.worktree && <span class="text-zinc-400"> · {p.worktree}</span>}</span>
                  <button onClick={() => kill(p.port)} class="text-red-400 hover:text-red-600 transition-colors duration-150 px-2 py-0.5 rounded hover:bg-red-50 font-medium">kill</button>
                </div>
              ))}
          </div>
        </div>
      </div>
    </div>
  );
}

// Compact, glanceable — how many concurrency slots are used and what a
// container is capped at, without turning the header into a metrics wall.
// Only renders once /api/status has actually returned something.
// A plaque, not inline text — the board-mono treatment (uppercase, tracked,
// bordered) reads as a fixed label you'd find bolted to a real dispatch
// board, not a passing status line.
function StatusStrip({ status }: { status: Status | null }) {
  if (!status) return null;
  const { concurrency, container } = status;
  const atCap = concurrency.active >= concurrency.max;
  return (
    <div class="inline-flex items-stretch text-[11px] board-mono border border-zinc-300 dark:border-zinc-700 divide-x divide-zinc-300 dark:divide-zinc-700">
      <span data-tip="Dev servers running vs. maxConcurrentDevServers" class="tip flex items-center gap-1.5 px-2.5 py-1">
        <StatusDot tone={atCap ? 'amber' : 'emerald'} />
        {concurrency.active}/{concurrency.max} running
        {concurrency.queued > 0 && <span class="text-signal-amber">·{concurrency.queued}q</span>}
      </span>
      <span data-tip={container.engineAvailable ? `Engine: ${container.engine}` : 'No container runtime reachable — setu start falls back to --bare'}
        class={`tip flex items-center gap-1.5 px-2.5 py-1 ${container.engineAvailable ? 'text-zinc-500' : 'text-signal-amber'}`}>
        <StatusDot tone={container.engineAvailable ? 'emerald' : 'amber'} />
        {container.memoryLimit}/{container.cpuLimit}cpu
      </span>
    </div>
  );
}

// Live-updating log tail — same polling fetch LogModal already does, without
// the modal chrome (this renders inline in a Section, not an overlay).
function LiveLog({ repo, name, type }: { repo: string; name: string; type: string }) {
  const [text, setText] = useState('Loading…');
  const preRef = useRef<HTMLPreElement>(null);
  useEffect(() => {
    let alive = true;
    async function load() {
      const data = await fetch(`/api/logs?repo=${repo}&name=${encodeURIComponent(name)}&type=${type}`)
        .then(r => r.json()).catch(() => ({ lines: [] }));
      if (!alive) return;
      setText(data.lines.length ? data.lines.join('\n') : '(no log yet)');
      requestAnimationFrame(() => { if (preRef.current) preRef.current.scrollTop = preRef.current.scrollHeight; });
    }
    load();
    const t = setInterval(load, 2000);
    return () => { alive = false; clearInterval(t); };
  }, [repo, name, type]);
  return <pre ref={preRef} class="max-h-64 overflow-auto text-[11px] leading-relaxed font-mono text-zinc-600 dark:text-zinc-400 whitespace-pre-wrap break-all">{text}</pre>;
}

function WorktreePage({ w, loaded, agents, onAct, onStart, onOpenTool, onRemove, toast }: {
  w: Worktree | undefined; loaded: boolean; agents: { id: string; label: string }[];
  onAct: (url: string, w: Worktree) => void; onStart: (w: Worktree, force?: 'container' | 'bare') => void;
  onOpenTool: (w: Worktree, tool: string) => void; onRemove: (w: Worktree) => void; toast: (msg: string) => void;
}) {
  // Distinguish "the initial /api/worktrees fetch hasn't resolved yet" (a
  // direct link or hard refresh always starts with an empty worktrees array)
  // from "this genuinely doesn't exist" — otherwise every fresh page load
  // flashes an incorrect "Not found" before the poll loop's first fetch lands.
  if (!w) {
    return (
      <div class="max-w-3xl mx-auto px-6 py-12">
        <PageHeader back={{ label: 'All worktrees', onClick: () => navigate('/') }} title={loaded ? 'Not found' : 'Loading…'} />
        {loaded && <p class="text-sm text-zinc-400">No worktree matches this URL — it may have been removed.</p>}
      </div>
    );
  }

  const statusTone: Tone = w.active ? 'emerald' : w.queued ? 'amber' : 'zinc';

  return (
    <div class="max-w-3xl mx-auto px-6 py-12">
      <PageHeader
        back={{ label: 'All worktrees', onClick: () => navigate('/') }}
        title={w.name}
        subtitle={
          <div class="flex items-center gap-2 flex-wrap">
            <span class="flex items-center gap-1.5">
              <StatusDot tone={statusTone} pulse={w.active} />
              <StatusFlap text={w.active ? 'running' : w.queued ? `queued #${w.queuePosition}` : 'stopped'} tone={statusTone} />
            </span>
            <Badge tone="zinc">{w.label}</Badge>
            {w.container && <Badge tone="zinc" tip="Real memory/CPU cap enforced">container</Badge>}
            {!w.active && !w.queued && <Badge tone="zinc">→ {w.nextStartMode}</Badge>}
          </div>
        }
        actions={
          w.active ? (
            <PrimaryButton onClick={() => onAct('/api/stop', w)}>Stop</PrimaryButton>
          ) : (
            <PrimaryButton onClick={() => onStart(w)}>Start ({w.nextStartMode})</PrimaryButton>
          )
        }
      />

      <Section title="Overview">
        <div class="grid grid-cols-2 gap-4 text-sm">
          <div>
            <div class="text-zinc-400 text-xs mb-0.5">Local domain</div>
            <a href={`http://${w.domain}`} target="_blank" class="font-mono text-zinc-700 dark:text-zinc-300 hover:text-accent transition-colors">{w.domain}</a>
          </div>
          {w.tunnelOn && (
            <div>
              <div class="text-zinc-400 text-xs mb-0.5">Public tunnel</div>
              <span class="font-mono text-zinc-700 dark:text-zinc-300">{w.pubDomain}</span>
            </div>
          )}
          {w.branchUrl && (
            <div>
              <div class="text-zinc-400 text-xs mb-0.5">Branch</div>
              <a href={w.branchUrl} target="_blank" class="text-zinc-700 dark:text-zinc-300 hover:text-accent transition-colors">{w.repo}/{w.name}</a>
            </div>
          )}
          {w.pr && (
            <div>
              <div class="text-zinc-400 text-xs mb-0.5">Pull request</div>
              <a href={w.pr.url} target="_blank" class="text-zinc-700 dark:text-zinc-300 hover:text-accent transition-colors truncate block">PR #{w.pr.number} — {w.pr.title}</a>
            </div>
          )}
        </div>
      </Section>

      <Section title="Metrics">
        <div class="grid grid-cols-2 gap-4 text-sm">
          <div><div class="text-zinc-400 text-xs mb-0.5">Last commit</div><div>{w.lastCommitAt ? relativeTime(w.lastCommitAt) : '—'}</div></div>
          <div><div class="text-zinc-400 text-xs mb-0.5">Created</div><div>{w.createdAt ? relativeTime(w.createdAt) : '—'}</div></div>
          <div><div class="text-zinc-400 text-xs mb-0.5">Ahead / behind base</div><div class="font-mono">↑{w.ahead} ↓{w.behind}</div></div>
          <div><div class="text-zinc-400 text-xs mb-0.5">Uncommitted changes</div><div>{w.dirty > 0 ? <span class="text-signal-amber">{w.dirty} files</span> : 'clean'}</div></div>
          {w.active && w.memMb != null && (
            <div><div class="text-zinc-400 text-xs mb-0.5">Memory footprint</div>
              <div class={w.memMb > 8192 ? 'text-signal-amber' : ''}>{w.memMb >= 1024 ? `${(w.memMb / 1024).toFixed(1)}GB` : `${Math.round(w.memMb)}MB`}</div>
            </div>
          )}
        </div>
      </Section>

      <Section title="Sidecars">
        <div class="flex items-center gap-6 text-sm">
          <div class="flex items-center gap-2">
            <StatusDot tone={w.inngestActive ? 'emerald' : 'zinc'} />
            <span>Inngest</span>
            {w.inngestActive
              ? <>
                  <a href={`http://localhost:${w.inngestPort}`} target="_blank" class="text-xs text-emerald-600 hover:underline">dashboard</a>
                  <button onClick={() => onAct('/api/inngest/stop', w)} class="text-xs text-red-500 hover:underline">stop</button>
                </>
              : <button onClick={() => onAct('/api/inngest/start', w)} class="text-xs text-zinc-500 hover:underline">start</button>}
          </div>
          <div class="flex items-center gap-2">
            <StatusDot tone={w.triggerActive ? 'emerald' : 'zinc'} />
            <span>trigger.dev</span>
            {w.triggerActive
              ? <button onClick={() => onAct('/api/trigger/stop', w)} class="text-xs text-red-500 hover:underline">stop</button>
              : <button onClick={() => onAct('/api/trigger/start', w)} class="text-xs text-zinc-500 hover:underline">start</button>}
          </div>
          <div class="flex items-center gap-2">
            <StatusDot tone={w.tunnelRunning ? 'emerald' : 'zinc'} />
            <span>Tunnel</span>
            <button onClick={() => onAct(w.tunnelOn ? '/api/tunnel/disable' : '/api/tunnel/enable', w)} class="text-xs text-zinc-500 hover:underline">
              {w.tunnelOn ? 'disable' : 'enable'}
            </button>
          </div>
        </div>
      </Section>

      <Section title="Open in">
        <div class="flex items-center gap-2 flex-wrap">
          {agents.map(a => (
            <button key={a.id} onClick={() => onOpenTool(w, a.id)}
              class="flex items-center gap-1.5 text-xs px-2.5 py-1.5 rounded-none border border-zinc-200 dark:border-zinc-700 bg-zinc-50 dark:bg-zinc-800 hover:bg-zinc-100 dark:hover:bg-zinc-700 text-zinc-600 dark:text-zinc-300 transition-colors duration-150">
              <ToolIcon id={a.id} label={a.label} />{a.label}
            </button>
          ))}
          <button onClick={() => navigator.clipboard.writeText(`cd ~/workspace/${w.repo}/${w.name}`).then(() => toast('Copied')).catch(() => toast('clipboard unavailable'))}
            class="text-xs px-2.5 py-1.5 rounded-none border border-zinc-200 dark:border-zinc-700 bg-zinc-50 dark:bg-zinc-800 hover:bg-zinc-100 dark:hover:bg-zinc-700 text-zinc-600 dark:text-zinc-300 transition-colors duration-150">
            Copy cd command
          </button>
        </div>
      </Section>

      <Section title="Dev server log">
        <LiveLog repo={w.repo} name={w.name} type="dev" />
      </Section>

      <button onClick={() => onRemove(w)} class="text-xs text-red-500 hover:text-red-700 transition-colors duration-150">
        Remove worktree
      </button>
    </div>
  );
}

// Jump-to-worktree, not a task runner — the one thing 45+ registered
// worktrees actually need is "find the one I'm thinking of" faster than
// scrolling three paginated grid pages. No fuzzy-match library: a plain
// substring filter over name/repo/branch/domain is enough at this scale and
// keeps this framework-agnostic (cmdk itself is a React library; this is
// Preact, so a ~40-line native implementation beats wiring a compat shim
// for one modal).
function CommandBar({ worktrees, onClose }: { worktrees: Worktree[]; onClose: () => void }) {
  const [q, setQ] = useState('');
  const [sel, setSel] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => { inputRef.current?.focus(); }, []);

  const needle = q.trim().toLowerCase();
  const results = (needle
    ? worktrees.filter(w => `${w.name} ${w.repo} ${w.label} ${w.domain}`.toLowerCase().includes(needle))
    : worktrees
  ).slice(0, 8);

  function go(w: Worktree) {
    navigate(`/worktree/${w.repo}/${encodeURIComponent(w.name)}`);
    onClose();
  }

  function onKeyDown(e: any) {
    if (e.key === 'Escape') onClose();
    else if (e.key === 'ArrowDown') { e.preventDefault(); setSel(s => Math.min(s + 1, results.length - 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setSel(s => Math.max(s - 1, 0)); }
    else if (e.key === 'Enter' && results[sel]) go(results[sel]);
  }

  return (
    <Modal onClose={onClose}>
      <div class="bg-white dark:bg-zinc-900 rounded-none border border-zinc-200 dark:border-zinc-800 shadow-2xl w-full max-w-md mx-4" onKeyDown={onKeyDown}>
        <div class="flex items-center gap-2.5 px-4 py-3 border-b border-zinc-100 dark:border-zinc-800">
          <svg class="w-4 h-4 text-zinc-300 shrink-0" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><circle cx="11" cy="11" r="7" /><path stroke-linecap="round" d="M21 21l-4.3-4.3" /></svg>
          <input ref={inputRef} value={q} onInput={(e: any) => { setQ(e.target.value); setSel(0); }}
            placeholder="Jump to a worktree…" autocomplete="off"
            class="flex-1 text-sm bg-transparent outline-none placeholder-zinc-400 text-zinc-900 dark:text-zinc-100" />
          <span class="board-mono text-[10px] text-zinc-300 shrink-0">ESC</span>
        </div>
        <div class="max-h-80 overflow-auto py-1">
          {!results.length && <p class="text-xs text-zinc-400 px-4 py-6 text-center">No worktrees match "{q}"</p>}
          {results.map((w, i) => (
            <button key={w.key} onClick={() => go(w)} onMouseEnter={() => setSel(i)}
              class={`w-full flex items-center gap-2.5 px-4 py-2 text-left transition-colors duration-100 ${i === sel ? 'bg-zinc-100 dark:bg-zinc-800' : ''}`}>
              <StatusDot tone={w.active ? 'emerald' : w.queued ? 'amber' : 'zinc'} />
              <span class="text-sm text-zinc-900 dark:text-zinc-100 truncate">{w.name}</span>
              <span class="board-mono text-[9px] text-zinc-300 font-bold shrink-0 ml-auto">{w.label}</span>
            </button>
          ))}
        </div>
      </div>
    </Modal>
  );
}

function App() {
  const route = useRoute();
  const [worktrees, setWorktrees] = useState<Worktree[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [projects, setProjects] = useState<Project[]>([]);
  const [agents, setAgents] = useState<{ id: string; label: string }[]>([]);
  const [status, setStatus] = useState<Status | null>(null);
  const [filter, setFilter] = useState('all');
  const [view, setView] = useState<'list' | 'grid'>('grid');
  const [dark, setDark] = useState(() => localStorage.getItem('setu-theme') === 'dark');

  // View preferences — localStorage, not a client-side database. The actual
  // worktree data always comes fresh from the server on every poll; the only
  // things that need to persist here are a handful of small preference
  // values (sort key, quick-filters, page). A "Dexie-like" local DB would add
  // a real client-vs-server staleness problem for zero benefit over this.
  const [sortKey, setSortKey] = useState<'recent' | 'name' | 'created'>(
    () => (localStorage.getItem('setu-sort') as any) || 'recent');
  const [onlyDirty, setOnlyDirty] = useState(() => localStorage.getItem('setu-filter-dirty') === '1');
  const [onlyAhead, setOnlyAhead] = useState(() => localStorage.getItem('setu-filter-ahead') === '1');
  const [page, setPage] = useState(0);
  const PAGE_SIZE = 18;

  useEffect(() => {
    document.documentElement.classList.toggle('dark', dark);
    localStorage.setItem('setu-theme', dark ? 'dark' : 'light');
  }, [dark]);
  useEffect(() => { localStorage.setItem('setu-sort', sortKey); setPage(0); }, [sortKey]);
  useEffect(() => { localStorage.setItem('setu-filter-dirty', onlyDirty ? '1' : '0'); setPage(0); }, [onlyDirty]);
  useEffect(() => { localStorage.setItem('setu-filter-ahead', onlyAhead ? '1' : '0'); setPage(0); }, [onlyAhead]);
  useEffect(() => { setPage(0); }, [filter]);
  const [toastMsg, setToastMsg] = useState('');
  const [createOpen, setCreateOpen] = useState(false);
  const [addProjectOpen, setAddProjectOpen] = useState(false);
  const [logView, setLogView] = useState<{ repo: string; name: string; type: string } | null>(null);
  const [commandOpen, setCommandOpen] = useState(false);
  const pendingStart = useRef(new Set<string>());
  const toastTimer = useRef<any>(null);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); setCommandOpen(true); }
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  function toast(msg: string) {
    setToastMsg(msg);
    clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToastMsg(''), 5000);
  }

  const refresh = useCallback(async () => {
    const wts: Worktree[] = await fetch('/api/worktrees').then(r => r.json()).catch(() => []);
    for (const w of wts) if (w.active) pendingStart.current.delete(w.key);
    setWorktrees(wts);
    setLoaded(true);
    setStatus(await fetch('/api/status').then(r => r.json()).catch(() => null));
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

  // Used to be fire-and-forget — `{ok:true}` from /api/open only ever meant
  // "Bun.spawn didn't throw synchronously," not "a window actually opened."
  // That's exactly how the ghostty launch bug stayed invisible: the endpoint
  // always reported success even when the spawned process silently did
  // nothing. Checking res.ok doesn't fully close that gap (a successful spawn
  // still isn't proof of a visible window), but it at least surfaces the
  // failure mode this endpoint CAN detect, matching how act()/start() already behave.
  async function openTool(w: Worktree, tool: string) {
    const res = await post('/api/open', { repo: w.repo, name: w.name, tool });
    if (res && res.ok === false) toast(`✗ open failed: ${res.error ?? 'unknown error'}`);
  }

  async function start(w: Worktree, force?: 'container' | 'bare') {
    pendingStart.current.add(w.key);
    setWorktrees([...worktrees]);
    const body: any = { repo: w.repo, name: w.name };
    if (force) body.container = force === 'container';
    const res = await post('/api/start', body);
    if (res && res.ok === false) { toast(`✗ start failed: ${res.error ?? 'unknown error'}`); pendingStart.current.delete(w.key); }
    refresh();
  }

  async function remove(w: Worktree) {
    if (!confirm(`Remove worktree "${w.name}"? The branch will not be deleted.`)) return;
    const res = await post('/api/remove', { repo: w.repo, name: w.name });
    if (!res.ok) toast(`✗ remove failed: ${res.error ?? 'unknown error'}`);
    refresh();
  }

  const SORTERS: Record<typeof sortKey, (a: Worktree, b: Worktree) => number> = {
    recent:  (a, b) => (b.lastCommitAt ?? 0) - (a.lastCommitAt ?? 0),
    name:    (a, b) => a.name.localeCompare(b.name),
    created: (a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0),
  };

  // Running (and queued) worktrees float to the top regardless of sort key or
  // view — with 45+ worktrees registered, the 1-2 that are actually live are
  // otherwise buried wherever the chosen sort happens to put them.
  const sorted = (filter === 'all' ? worktrees : worktrees.filter(w => w.repo === filter))
    .filter(w => !onlyDirty || w.dirty > 0)
    .filter(w => !onlyAhead || w.ahead > 0)
    .slice()
    .sort((a, b) => Number(b.active) - Number(a.active) || Number(b.queued) - Number(a.queued) || SORTERS[sortKey](a, b));

  // Running/queued worktrees get their own always-visible section, pulled
  // from the full sorted list rather than the paginated slice — with a page
  // size of 18, a live worktree could otherwise land on page 2+ and be
  // invisible on the page you land on by default.
  const running = sorted.filter(w => w.active || w.queued);
  const rest = sorted.filter(w => !w.active && !w.queued);

  const pageCount = Math.max(1, Math.ceil(rest.length / PAGE_SIZE));
  const filtered = rest.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);

  if (route.page === 'detail') {
    const w = worktrees.find(x => x.repo === route.repo && x.name === route.name);
    return <>
      <WorktreePage w={w} loaded={loaded} agents={agents} onAct={act} onStart={start} onOpenTool={openTool} onRemove={remove} toast={toast} />
      {commandOpen && <CommandBar worktrees={worktrees} onClose={() => setCommandOpen(false)} />}
    </>;
  }

  return (
    <div class="max-w-5xl mx-auto px-6 py-12">
      <PageHeader title={
          <span class="inline-flex items-center gap-3">
            <span class="wordmark">setu</span>
            <button onClick={() => setCommandOpen(true)} data-tip="Jump to a worktree"
              class="tip flex items-center gap-1.5 h-7 px-2.5 rounded-none backdrop-blur-md bg-white/60 dark:bg-white/5 border border-white/75 dark:border-white/10 shadow-sm text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-200 transition-colors duration-150">
              <svg class="w-3 h-3" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><circle cx="11" cy="11" r="7" /><path stroke-linecap="round" d="M21 21l-4.3-4.3" /></svg>
              <span class="board-mono text-[9px] font-bold">⌘K</span>
            </button>
          </span>
        } subtitle={<StatusStrip status={status} />} actions={<>
          <select value={filter} onChange={(e: any) => setFilter(e.target.value)}
            class="backdrop-blur-md bg-white/60 dark:bg-white/5 border border-white/75 dark:border-white/10 shadow-sm text-zinc-700 dark:text-zinc-300 text-sm rounded-none px-3 py-1.5 focus:outline-none focus:border-zinc-400 transition-colors duration-150">
            <option value="all">All</option>
            {projects.map(p => <option key={p.name} value={p.name}>{p.label}</option>)}
          </select>
          <select value={sortKey} onChange={(e: any) => setSortKey(e.target.value)}
            data-tip="Sort" class="tip backdrop-blur-md bg-white/60 dark:bg-white/5 border border-white/75 dark:border-white/10 shadow-sm text-zinc-700 dark:text-zinc-300 text-sm rounded-none px-3 py-1.5 focus:outline-none focus:border-zinc-400 transition-colors duration-150">
            <option value="recent">Recently active</option>
            <option value="name">Name</option>
            <option value="created">Created</option>
          </select>
          <button onClick={() => setOnlyDirty(!onlyDirty)} data-tip="Only worktrees with uncommitted changes"
            class={`tip w-9 h-9 flex items-center justify-center rounded-none backdrop-blur-md border shadow-sm transition-all duration-150 ${
              onlyDirty ? 'bg-signal-amber border-signal-amber text-white' : 'bg-white/60 dark:bg-white/5 border-white/75 dark:border-white/10 text-zinc-400 hover:text-zinc-600'}`}>
            <svg class="w-4 h-4" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><circle cx="12" cy="12" r="8" /></svg>
          </button>
          <button onClick={() => setOnlyAhead(!onlyAhead)} data-tip="Only worktrees ahead of their base branch"
            class={`tip w-9 h-9 flex items-center justify-center rounded-none backdrop-blur-md border shadow-sm transition-all duration-150 ${
              onlyAhead ? 'bg-signal-green border-signal-green text-white' : 'bg-white/60 dark:bg-white/5 border-white/75 dark:border-white/10 text-zinc-400 hover:text-zinc-600'}`}>
            <svg class="w-4 h-4" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M12 19V5m0 0l-6 6m6-6l6 6" /></svg>
          </button>
          <div class="flex backdrop-blur-md bg-white/60 dark:bg-white/5 border border-white/75 dark:border-white/10 shadow-sm rounded-none p-0.5">
            {(['list', 'grid'] as const).map(v => (
              <button key={v} onClick={() => setView(v)} data-tip={v === 'list' ? 'List view' : 'Grid view'}
                class={`tip w-7 h-7 flex items-center justify-center rounded-none transition-all duration-150 ${
                  view === v ? 'bg-accent text-white' : 'text-zinc-400 hover:text-zinc-600'}`}>
                {v === 'list'
                  ? <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path stroke-linecap="round" d="M4 6h16M4 12h16M4 18h16" /></svg>
                  : <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><rect x="4" y="4" width="7" height="7" rx="1" /><rect x="13" y="4" width="7" height="7" rx="1" /><rect x="4" y="13" width="7" height="7" rx="1" /><rect x="13" y="13" width="7" height="7" rx="1" /></svg>}
              </button>
            ))}
          </div>
          <button onClick={() => setDark(!dark)} data-tip={dark ? 'Light mode' : 'Dark mode'}
            class="tip w-9 h-9 flex items-center justify-center rounded-none backdrop-blur-md bg-white/60 dark:bg-white/5 border border-white/75 dark:border-white/10 shadow-sm text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-200 transition-all duration-150">
            {dark
              ? <svg class="w-4 h-4" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><circle cx="12" cy="12" r="4" /><path stroke-linecap="round" d="M12 2v2m0 16v2M4.93 4.93l1.41 1.41m11.32 11.32l1.41 1.41M2 12h2m16 0h2M4.93 19.07l1.41-1.41m11.32-11.32l1.41-1.41" /></svg>
              : <svg class="w-4 h-4" fill="currentColor" viewBox="0 0 24 24"><path d="M21 12.79A9 9 0 1111.21 3 7 7 0 0021 12.79z" /></svg>}
          </button>
          <SecondaryButton onClick={() => setAddProjectOpen(true)}>+ Project</SecondaryButton>
          <PrimaryButton onClick={() => setCreateOpen(true)}>+ Worktree</PrimaryButton>
        </>} />

      <div class="rail-divider mb-8" />

      {running.length > 0 && (
        <div class="mb-8">
          <h2 class="board-mono text-[11px] font-bold text-zinc-400 mb-3">
            Now running <span class="text-zinc-300">({running.length})</span>
          </h2>
          <div class={view === 'grid' ? 'grid grid-cols-1 lg:grid-cols-2 gap-3 items-start' : 'flex flex-col gap-3'}>
            {running.map(w => (
              <WorktreeCard key={w.key} w={w} gridMode={view === 'grid'} pending={pendingStart.current.has(w.key)} agents={agents}
                onAct={act} onStart={start} onRemove={remove} toast={toast}
                onOpenLogs={(repo: string, name: string, type: string) => setLogView({ repo, name, type })}
                onOpenTool={openTool} />
            ))}
          </div>
          <div class="rail-divider mt-8 mb-8" />
        </div>
      )}

      {running.length > 0 && rest.length > 0 && (
        <h2 class="board-mono text-[11px] font-bold text-zinc-400 mb-3">All worktrees</h2>
      )}
      <div class={view === 'grid' ? 'grid grid-cols-1 lg:grid-cols-2 gap-3 items-start' : 'flex flex-col gap-3'}>
        {!filtered.length
          ? <p class="text-zinc-400 text-sm py-10 text-center">
              {rest.length ? 'No worktrees on this page.' :
               (onlyDirty || onlyAhead) ? 'No worktrees match the active filters.' :
               running.length ? '' :
               `No worktrees${filter !== 'all' ? ' for this project' : ''} — click + Worktree to create one.`}
            </p>
          : filtered.map(w => (
            <WorktreeCard key={w.key} w={w} gridMode={view === 'grid'} pending={pendingStart.current.has(w.key)} agents={agents}
              onAct={act} onStart={start} onRemove={remove} toast={toast}
              onOpenLogs={(repo: string, name: string, type: string) => setLogView({ repo, name, type })}
              onOpenTool={openTool} />
          ))}
      </div>

      {pageCount > 1 && (
        <div class="flex items-center justify-center gap-3 mt-6 text-sm text-zinc-500">
          <button onClick={() => setPage(p => Math.max(0, p - 1))} disabled={page === 0}
            class="w-8 h-8 flex items-center justify-center rounded-none backdrop-blur-md bg-white/60 dark:bg-white/5 border border-white/75 dark:border-white/10 shadow-sm disabled:opacity-40 transition-all duration-150 hover:text-zinc-800 dark:hover:text-zinc-200">‹</button>
          <span>{page + 1} / {pageCount}</span>
          <button onClick={() => setPage(p => Math.min(pageCount - 1, p + 1))} disabled={page >= pageCount - 1}
            class="w-8 h-8 flex items-center justify-center rounded-none backdrop-blur-md bg-white/60 dark:bg-white/5 border border-white/75 dark:border-white/10 shadow-sm disabled:opacity-40 transition-all duration-150 hover:text-zinc-800 dark:hover:text-zinc-200">›</button>
        </div>
      )}

      <PortsPanel />

      {createOpen && <CreateModal projects={projects} onClose={() => setCreateOpen(false)} onCreated={refresh} />}
      {addProjectOpen && <AddProjectModal onClose={() => setAddProjectOpen(false)} onAdded={loadProjects} />}
      {logView && <LogModal repo={logView.repo} name={logView.name} initialType={logView.type} onClose={() => setLogView(null)} />}
      {commandOpen && <CommandBar worktrees={worktrees} onClose={() => setCommandOpen(false)} />}
      {toastMsg && (
        <div class="fixed bottom-5 left-1/2 -translate-x-1/2 bg-zinc-900 text-white text-xs px-4 py-2.5 rounded-none shadow-lg z-[60] max-w-md
          transition-all duration-200 ease-out animate-[fadeUp_0.2s_ease-out]">
          {toastMsg}
        </div>
      )}
    </div>
  );
}

render(<App />, document.getElementById('root')!);
