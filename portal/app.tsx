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
  container: string | null; nextStartMode: 'container' | 'bare'; needsMigrationPrompt: boolean;
  tunnelRunning: boolean; label: string; branchUrl: string | null;
  pr: { url: string; number: number; title: string } | null;
  inngestActive: boolean; inngestPort: number; triggerActive: boolean;
  queued?: boolean; queuePosition?: number | null;
  lastCommitAt: number | null; ahead: number; behind: number; dirty: number; memMb: number | null;
  createdAt: number | null;
};
type Project = { name: string; label: string; github?: string | null };
type Sidecar = { name: string; enabled?: boolean; command: string; args?: string[]; env?: Record<string, string> };
type SettingsData = {
  maxConcurrentDevServers: number; containerMemoryLimit: string; containerCpuLimit: number;
  mac: { cpus: number | null; memMb: number | null }; docker: { cpus: number | null; memMb: number | null };
};
type PortInfo = { port: number; pid: string; cmd: string; worktree: string | null };
type Status = {
  concurrency: { active: number; max: number; queued: number };
  container: { engineAvailable: boolean; engine: string | null; memoryLimit: string; cpuLimit: number };
};

// Minimal router — one detail view alongside the existing list/grid doesn't
// justify a router dependency; history.pushState + popstate is the native
// platform feature that already does exactly this.
type Route = { page: 'list' } | { page: 'detail'; repo: string; name: string } | { page: 'settings' } | { page: 'help' } | { page: 'ports' };

function parseRoute(pathname: string): Route {
  if (pathname === '/settings') return { page: 'settings' };
  if (pathname === '/help') return { page: 'help' };
  if (pathname === '/ports') return { page: 'ports' };
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

// Neither Trigger.dev nor Inngest is a vector mark anywhere (not in
// simple-icons, not in lobehub/lobe-icons) — their real favicons are small
// raster PNGs, sourced once (trigger.dev/favicon.ico, inngest.com/favicon.ico)
// and inlined as data URIs so they're bundled the same as every other icon
// here: no runtime request, no failure mode to reproduce.
const TRIGGER_ICON_URI = 'data:image/png;base64,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';
const INNGEST_ICON_URI = 'data:image/png;base64,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';
function SidecarIcon({ tool }: { tool: 'trigger' | 'inngest' }) {
  return <img src={tool === 'trigger' ? TRIGGER_ICON_URI : INNGEST_ICON_URI} class="w-3.5 h-3.5 rounded-none" alt="" />;
}

const MUKUL_LOGO_URI = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAADAAAAAwCAYAAABXAvmHAAAAAXNSR0IArs4c6QAAAERlWElmTU0AKgAAAAgAAYdpAAQAAAABAAAAGgAAAAAAA6ABAAMAAAABAAEAAKACAAQAAAABAAAAMKADAAQAAAABAAAAMAAAAADbN2wMAAAFM0lEQVRoBd1ZSUtsRxQ+2s7THzDoi0F9KGpQQReujJsQJRFEXAny3LkV4vADEhcS4kIi4oCCuMnGlYqggggiJuHxVDRq8GmMGsF5Hjrnq3CLe693qO42dncOnL41n++rOnXqVl+iMJcIB/xRXPeGtZD1M9Y41teUKzb2O+uvrB9ZH1mVJY9b9rCi4z2rN0h6x3a3WH9kzWJ1lUhuUcu6wRos0HZ2PzCmryJY+GkrAP83q90gwS7/k7F9aYcebgOfCzZIN/u/MUbsSYN4OPcTq1vnUKn/3oCeM9gg22FEYIWxprISNi3kc1ZRIHKh//MpQ8wFTI1ABqfhRuEiOJPSAFYj4HpIZWZmUlqa6BMqJBP0BFxBFRUVUUtLC8XGxrq2fYkGsOMS8sXkayvgajM5OZnq6+uppqbGtW2gDTIyMqipqYni4lwdQ7qQq83ExESCtra2UnZ2tmt7fxsAfE9PD1VWVioN4dMKYMTc3Fxqa2ujhAThgkpGVBtlZWVRb28vVVRU0NPTE3m9OHacRZlAUlKSHKm2tpbq6upk/iUSOTk51NfXR+Xl5WI4FfBoqEwgJSVF4oRvYkPn5eHtI3ApKCig/v5+Kisr83kwJQKIBvoVgBWE1fb29mflviIoLi4W4EtKSgxdsQIqq6BEwOPxWAKtqqqi0tJSg2FfMgANtyksxJ3JKCrg0QO3LleJioqy3LSRkZEEhcTExFBDQwOlp6fT2dkZXV5eSr26uqLr62vCc3V1lY6Pj0WfxsZGys/PF2l/f5QJmF0IBu/u7uj09FTYRhqz1tzcTNHR0RIPosnj46OIKltbW1RdXS0J3N/jsmct6KciSi4EQFZh8+bmhi4uLqSd0dFRGh8fl3kksELoj5N1bGyM1tfXZf3JyYlMmxOqLqREAMatTkW4BVxFE7hOZ2cnHR0daUXyidkfGBgwbEwnArKjSyIgAgAPv9bL3NwcDQ0N6YtEGmVra2uGcicCWAGVVVAigNmPj483GEfm/Pycbm9vDeXw9+7ublpZwZ3jX8HGHR4e1rLyif1j5+sq4DGQEgGA129MDYEVAdRtbm5SV1cXYZMCyODgIMGFzAKXc9rI5vZWeSUCeIlDmDQLZtAOADb09PQ0LS8v08jIiLmryDsRUF0BpTCKCISzwCzwYbiMlYBcR0cHpaam0u7urlUTEcEQfq0EBFRIPEdlMRpWwI6ARXNZNDMzIw86WahLaAecrsjnpBIBHGLaiau3oJ2o+jJ9GhvUbpOinRMBldnHGEp7ALcxfwjAgJOYzxF92xclYPUagZl1iuN6MHZp+D8iWSCivAJmIw8PD/8pAUyQyir4TQDhE2EwEEEEsxtDBTxsKxGwciG8yAW6/CBg54Yuf6nIeXONQti8dgT0b6JyRB8T2uu41g2uube3R0tLS44RTGvvSgDxXyOAGTs8PBSn68TEBO3v72vj+P0EAYDe2Nig+fl5mpqaooWFBdrZ2XkZAlhKvMfg747Z2VkxM9vb2+KG5TdqXcfJyUkxIYuLi3RwcGB7suu6aEnDjedbLrX8758JePllzsuuZFlv1+8Vyt+BieZCm5x+0OVRJwTRAAdOiAkA4XuGjEL4lLmDgjARTPgysGph9A9Oj6EgTORnxvmXGetbLsA1KtR83YxnkTHafqj4hisRG82dQiUPv/+C1VYiuOZr1lBciV8YV4UtclMFvlr+wIrvxri1B2sFbtj2Kut3rG9Ynwlm3E48XIEvl/jv7xNW/N0GIq8hwIW75kfW96zYsIaDi/P/D/kHGNOpOz6fLmoAAAAASUVORK5CYII=';

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
            <SecondaryButton class="flex-1" onClick={onClose}>Cancel</SecondaryButton>
            <PrimaryButton class="flex-1" onClick={create} disabled={busy}>{busy ? 'Creating…' : 'Create'}</PrimaryButton>
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
            <SecondaryButton class="flex-1" onClick={onClose}>Cancel</SecondaryButton>
            <PrimaryButton class="flex-1" onClick={submit} disabled={busy}>{busy ? 'Adding…' : 'Add'}</PrimaryButton>
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
  // First Start for a worktree that's only ever run bare and has never been
  // asked — same silent-switch concern as above, but for the one-time
  // migration to container rather than a single start's mode. Asked once
  // (lib.js marks it answered on either choice via markMigrationPrompted),
  // never nagged again — see task/memory on why this isn't fully automatic.
  if (w.needsMigrationPrompt) {
    return (
      <Menu trigger={toggle => (
        <IconButton tone="emerald" tip="This worktree has always run bare — migrate to a container?" onClick={toggle}>
          <svg class="w-4 h-4" fill="currentColor" viewBox="0 0 24 24"><path d="M8 5v14l11-7z" /></svg>
        </IconButton>
      )}>
        <MenuItem onClick={() => onStart(w, 'container')}>Migrate to container</MenuItem>
        <MenuItem onClick={() => onStart(w, 'bare')}>Keep bare, start now</MenuItem>
      </Menu>
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
            class="text-zinc-900 dark:text-zinc-100 font-medium text-[15px] truncate hover:text-accent transition-colors duration-150 text-left">
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
              class="flex items-center gap-1.5 hover:text-zinc-600 transition-colors duration-150 shrink-0">
              <SidecarIcon tool="inngest" />inngest
            </a>
          )}
          {showTriggerInline && (
            <button onClick={() => onOpenLogs(w.repo, w.name, 'trigger')} title="trigger.dev logs"
              class="flex items-center gap-1.5 hover:text-zinc-600 transition-colors duration-150 shrink-0">
              <SidecarIcon tool="trigger" />trigger
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
      {/* Hidden until hover — a clean card at rest, the tool-launch icons
          only when you're actually looking at this specific card. The
          Start/Stop/More row below stays always-visible; that's the one
          thing you came here to do, not a secondary action to reveal. */}
      <div class={`flex items-center gap-0.5 shrink-0 flex-wrap transition-opacity duration-150 ${
        gridMode ? '' : 'opacity-0 group-hover:opacity-100 focus-within:opacity-100'}`}>
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
          <MenuItem onClick={() => onAct('/api/sync', w)}
            icon={<svg class="w-3 h-3 shrink-0 text-zinc-400" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" /></svg>}>
            Sync with staging
          </MenuItem>
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
          ) : w.needsMigrationPrompt ? (
            <Menu align="right" trigger={toggle => <PrimaryButton onClick={toggle}>Start — choose mode</PrimaryButton>}>
              <MenuItem onClick={() => onStart(w, 'container')}>Migrate to container</MenuItem>
              <MenuItem onClick={() => onStart(w, 'bare')}>Keep bare, start now</MenuItem>
            </Menu>
          ) : (
            <PrimaryButton onClick={() => onStart(w)}>Start ({w.nextStartMode})</PrimaryButton>
          )
        }
      />

      <Section title="Overview" actions={<SecondaryButton onClick={() => onAct('/api/sync', w)}>Sync with staging</SecondaryButton>}>
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
            <SidecarIcon tool="inngest" />
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
            <SidecarIcon tool="trigger" />
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

function fmtGb(mb: number | null) { return mb == null ? '?' : `${(mb / 1024).toFixed(mb % 1024 ? 1 : 0)}GB`; }

// One sidecar row — name/command/args/enabled, edited in place. The parent
// owns the array and re-saves the whole thing on "Save sidecars"; this is
// purely a controlled row, no independent state or its own save action.
function SidecarRow({ s, onChange, onRemove }: { s: Sidecar; onChange: (s: Sidecar) => void; onRemove: () => void }) {
  return (
    <div class="flex items-center gap-2 py-2 border-b border-zinc-100 dark:border-zinc-800 last:border-0">
      <input type="checkbox" checked={s.enabled !== false} onChange={(e: any) => onChange({ ...s, enabled: e.target.checked })}
        class="accent-current" style={{ accentColor: 'var(--color-accent)' }} />
      <input value={s.name} onInput={(e: any) => onChange({ ...s, name: e.target.value })} placeholder="name"
        class={`${inputCls} w-28 text-xs py-1`} />
      <input value={s.command} onInput={(e: any) => onChange({ ...s, command: e.target.value })} placeholder="command"
        class={`${inputCls} flex-1 text-xs py-1 font-mono`} />
      <input value={(s.args ?? []).join(' ')} onInput={(e: any) => onChange({ ...s, args: e.target.value.split(' ').filter(Boolean) })}
        placeholder="args (space-separated)" class={`${inputCls} flex-1 text-xs py-1 font-mono`} />
      <IconButton tone="red" tip="Remove sidecar" onClick={onRemove}>
        <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12" /></svg>
      </IconButton>
    </div>
  );
}

function SettingsPage({ toast }: { toast: (msg: string) => void }) {
  const [settings, setSettings] = useState<SettingsData | null>(null);
  const [saving, setSaving] = useState(false);
  const [projects, setProjects] = useState<Project[]>([]);
  const [addProjectOpen, setAddProjectOpen] = useState(false);
  const [sidecarRepo, setSidecarRepo] = useState('');
  const [sidecars, setSidecars] = useState<Sidecar[]>([]);
  const [sidecarsSaving, setSidecarsSaving] = useState(false);

  const loadProjects = useCallback(async () => {
    const ps = await fetch('/api/projects').then(r => r.json()).catch(() => []);
    setProjects(ps);
    if (!sidecarRepo && ps.length) setSidecarRepo(ps[0].name);
  }, [sidecarRepo]);

  useEffect(() => {
    fetch('/api/settings').then(r => r.json()).then(setSettings).catch(() => {});
    loadProjects();
  }, []);

  useEffect(() => {
    if (!sidecarRepo) return;
    fetch(`/api/sidecars?repo=${encodeURIComponent(sidecarRepo)}`).then(r => r.json()).then(setSidecars).catch(() => setSidecars([]));
  }, [sidecarRepo]);

  async function saveSettings(patch: Partial<SettingsData>) {
    if (!settings) return;
    const next = { ...settings, ...patch };
    setSettings(next);
    setSaving(true);
    const res = await post('/api/settings', patch);
    setSaving(false);
    if (res?.ok === false) toast(`✗ save failed: ${res.error ?? 'unknown error'}`);
  }

  async function removeProject(name: string) {
    if (!confirm(`Remove project "${name}"? Existing worktrees keep working — this only drops it from the registry.`)) return;
    const res = await post('/api/project/remove', { name });
    if (res?.ok === false) toast(`✗ remove failed: ${res.error ?? 'unknown error'}`);
    loadProjects();
  }

  async function saveSidecarsList(next: Sidecar[]) {
    setSidecars(next);
    setSidecarsSaving(true);
    const res = await post('/api/sidecars', { repo: sidecarRepo, sidecars: next });
    setSidecarsSaving(false);
    if (res?.ok === false) toast(`✗ save failed: ${res.error ?? 'unknown error'}`);
  }

  return (
    <div class="max-w-3xl mx-auto px-6 py-12">
      <PageHeader back={{ label: 'All worktrees', onClick: () => navigate('/') }} title="Settings" />

      <Section title="Concurrency & container limits">
        {!settings ? <p class="text-sm text-zinc-400">Loading…</p> : (
          <div class="flex flex-col gap-5 text-sm">
            <div>
              <label class="text-xs text-zinc-500 flex items-center justify-between mb-1">
                <span>Max concurrent dev servers</span>
                <span class="text-zinc-400">Mac: {settings.mac.cpus ?? '?'} cores, {fmtGb(settings.mac.memMb)} RAM</span>
              </label>
              <input type="number" min={1} max={Math.max(20, (settings.mac.cpus ?? 10) * 2)} value={settings.maxConcurrentDevServers}
                onChange={(e: any) => saveSettings({ maxConcurrentDevServers: Number(e.target.value) || 1 })}
                class={`${inputCls} w-24`} />
            </div>
            <div>
              <label class="text-xs text-zinc-500 flex items-center justify-between mb-1">
                <span>Container memory limit</span>
                <span class="text-zinc-400">Docker engine: {settings.docker.cpus ?? '?'} cores, {fmtGb(settings.docker.memMb)} available</span>
              </label>
              <input value={settings.containerMemoryLimit} placeholder="4g"
                onBlur={(e: any) => saveSettings({ containerMemoryLimit: e.target.value })}
                onInput={(e: any) => setSettings(s => s && { ...s, containerMemoryLimit: e.target.value })}
                class={`${inputCls} w-24`} />
              <p class="text-[11px] text-zinc-400 mt-1">A limit above what Docker's engine actually has gets silently clamped when a container starts.</p>
            </div>
            <div>
              <label class="text-xs text-zinc-500 mb-1 block">Container CPU limit</label>
              <input type="number" min={1} max={settings.docker.cpus ?? 16} value={settings.containerCpuLimit}
                onChange={(e: any) => saveSettings({ containerCpuLimit: Number(e.target.value) || 1 })}
                class={`${inputCls} w-24`} />
            </div>
            {saving && <p class="text-xs text-zinc-400">Saving…</p>}
          </div>
        )}
      </Section>

      <Section title="Projects" actions={<SecondaryButton onClick={() => setAddProjectOpen(true)}>+ Project</SecondaryButton>}>
        {!projects.length ? <p class="text-sm text-zinc-400">No projects registered.</p> : (
          <div class="flex flex-col divide-y divide-zinc-100 dark:divide-zinc-800">
            {projects.map(p => (
              <div key={p.name} class="flex items-center gap-3 py-2 text-sm">
                <span class="font-medium text-zinc-900 dark:text-zinc-100 flex-1">{p.label}</span>
                {p.github && <a href={p.github} target="_blank" class="text-xs text-zinc-400 hover:text-accent truncate max-w-[240px]">{p.github}</a>}
                <button onClick={() => removeProject(p.name)} class="text-xs text-red-500 hover:text-red-700 transition-colors duration-150">Remove</button>
              </div>
            ))}
          </div>
        )}
      </Section>

      <Section title="Sidecars" actions={
        projects.length > 1 && (
          <select value={sidecarRepo} onChange={(e: any) => setSidecarRepo(e.target.value)} class={`${inputCls} text-xs py-1`}>
            {projects.map(p => <option key={p.name} value={p.name}>{p.label}</option>)}
          </select>
        )
      }>
        {!projects.length ? <p class="text-sm text-zinc-400">Add a project first.</p> : (
          <div class="flex flex-col gap-2">
            {sidecars.map((s, i) => (
              <SidecarRow key={i} s={s}
                onChange={next => setSidecars(list => list.map((x, j) => j === i ? next : x))}
                onRemove={() => saveSidecarsList(sidecars.filter((_, j) => j !== i))} />
            ))}
            <div class="flex items-center gap-3 pt-2">
              <SecondaryButton onClick={() => setSidecars(list => [...list, { name: '', command: '', args: [], enabled: true }])}>+ Add sidecar</SecondaryButton>
              <PrimaryButton onClick={() => saveSidecarsList(sidecars)} disabled={sidecarsSaving}>{sidecarsSaving ? 'Saving…' : 'Save sidecars'}</PrimaryButton>
            </div>
            <p class="text-[11px] text-zinc-400 mt-1">Runs alongside the dev server on Start — for anything that isn't Inngest/trigger.dev/tunnel, which already have first-class controls on each worktree's page.</p>
          </div>
        )}
      </Section>

      {addProjectOpen && <AddProjectModal onClose={() => setAddProjectOpen(false)} onAdded={loadProjects} />}
    </div>
  );
}

function HelpTopic({ title, children }: { title: string; children: any }) {
  return (
    <div class="mb-5 last:mb-0">
      <h3 class="text-sm font-semibold text-zinc-900 dark:text-zinc-100 mb-1">{title}</h3>
      <div class="text-sm text-zinc-600 dark:text-zinc-400 leading-relaxed">{children}</div>
    </div>
  );
}

function HelpPage() {
  return (
    <div class="max-w-3xl mx-auto px-6 py-12">
      <PageHeader back={{ label: 'All worktrees', onClick: () => navigate('/') }} title="Help & guide" />

      <Section title="Worktrees">
        <HelpTopic title="What's a worktree, here?">
          A separate checkout of one branch from a shared bare repo — its own directory, own dev server, own port and local domain (<span class="font-mono text-xs">*.quivly.local</span>), so you can run several branches of the same project side by side without switching branches in one folder.
        </HelpTopic>
        <HelpTopic title="Bare vs container mode">
          <strong>Bare</strong> runs the dev server as a plain process on your Mac — fast to start, no memory/CPU cap. <strong>Container</strong> runs it in Docker with a real memory/CPU ceiling, isolated from the host. A worktree's mode is <em>sticky</em>: whichever it last ran as, it keeps running as, until you explicitly force the other mode (the caret next to Start, or the migration prompt on a worktree's first Start after this feature shipped). This is deliberate — an earlier version silently switched an established worktree into a container on restart with nobody asking for it.
        </HelpTopic>
        <HelpTopic title="Sync with staging">
          Merges the worktree's resolved base branch (staging if the repo has one, otherwise its default branch) into the worktree's own branch. Only proceeds if the merge is clean — if it would conflict, Setu aborts automatically and tells you which files, rather than leaving the worktree half-merged. Resolve conflicts yourself in your editor, then try again.
        </HelpTopic>
      </Section>

      <Section title="Sidecars, ports & domains">
        <HelpTopic title="Sidecars">
          Anything a project needs alongside its dev server that isn't Inngest, trigger.dev, or a tunnel (which already have first-class controls) — a plain process Setu starts and stops with the worktree. Configure them per-project in Settings.
        </HelpTopic>
        <HelpTopic title="Ports & local domains">
          Each registered project owns a 100-port band; each worktree gets one port from it plus a local domain that Caddy reverse-proxies to that port. See every process currently bound in 3000–3999 under Active ports.
        </HelpTopic>
      </Section>

      <Section title="Performance">
        <HelpTopic title="Concurrency cap">
          The max number of dev servers running at once — starting one more queues it instead of over-committing your Mac. Adjust it in Settings; it's clamped to what's actually reasonable for your hardware, not an arbitrary number.
        </HelpTopic>
        <HelpTopic title="Container limits">
          Memory/CPU ceiling for container-mode worktrees. A limit above what your Docker engine actually has allocated (visible in Settings) gets silently clamped when the container starts — Docker itself refuses higher.
        </HelpTopic>
      </Section>

      <Section title="Keyboard shortcuts">
        <div class="flex items-center gap-3 text-sm">
          <span class="board-mono text-[10px] font-bold text-zinc-500 border border-zinc-300 dark:border-zinc-700 px-1.5 py-0.5">⌘K</span>
          <span class="text-zinc-600 dark:text-zinc-400">Jump to any registered worktree by name, repo, or branch — bypasses filtering and pagination entirely.</span>
        </div>
      </Section>

      <Section title="Contributing">
        <p class="text-sm text-zinc-600 dark:text-zinc-400 leading-relaxed mb-3">
          Setu is open source. Issues, ideas, and pull requests are welcome.
        </p>
        <SecondaryButton onClick={() => window.open('https://github.com/quivly/setu', '_blank')}>Open github.com/quivly/setu</SecondaryButton>
      </Section>
    </div>
  );
}

function PortsPage() {
  const [ports, setPorts] = useState<PortInfo[]>([]);
  const [loaded, setLoaded] = useState(false);

  const load = useCallback(async () => {
    setPorts(await fetch('/api/ports').then(r => r.json()).catch(() => []));
    setLoaded(true);
  }, []);

  useEffect(() => {
    load();
    const t = setInterval(load, 3000);
    return () => clearInterval(t);
  }, [load]);

  async function kill(port: number) {
    await post('/api/ports/kill', { port });
    load();
  }

  return (
    <div class="max-w-3xl mx-auto px-6 py-12">
      <PageHeader back={{ label: 'All worktrees', onClick: () => navigate('/') }} title="Active ports"
        subtitle={<span class="text-xs text-zinc-400">Every process bound in 3000–3999, worktree-registered or not</span>} />

      <div class="backdrop-blur-md bg-white/70 dark:bg-white/5 border border-white/75 dark:border-white/10 shadow-sm rounded-none overflow-hidden text-sm">
        {!loaded
          ? <p class="text-zinc-400 px-4 py-6 text-center">Loading…</p>
          : !ports.length
          ? <p class="text-zinc-400 px-4 py-6 text-center">No processes on ports 3000–3999</p>
          : ports.map(p => (
            <div key={p.port} class="flex items-center gap-4 px-4 py-3 border-b border-zinc-100 dark:border-white/5 last:border-0 hover:bg-white/50 dark:hover:bg-white/5 transition-colors duration-150">
              <span class="font-mono font-medium text-zinc-900 dark:text-zinc-100 w-14">{p.port}</span>
              <span class="text-zinc-400 w-20">PID {p.pid}</span>
              <span class="text-zinc-500 dark:text-zinc-400 flex-1 truncate">{p.cmd}{p.worktree && <span class="text-zinc-400"> · {p.worktree}</span>}</span>
              <button onClick={() => kill(p.port)}
                class="text-red-500 hover:text-white hover:bg-red-500 transition-colors duration-150 px-3 py-1.5 rounded-none font-medium border border-red-200 dark:border-red-900">Kill</button>
            </div>
          ))}
      </div>
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
  const [filter, setFilter] = useState(() => localStorage.getItem('setu-filter') || 'all');
  const [view, setView] = useState<'list' | 'grid'>(() => (localStorage.getItem('setu-view') as any) || 'grid');
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
  useEffect(() => { localStorage.setItem('setu-filter', filter); setPage(0); }, [filter]);
  useEffect(() => { localStorage.setItem('setu-view', view); }, [view]);
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

  if (route.page === 'settings') {
    return <>
      <SettingsPage toast={toast} />
      {commandOpen && <CommandBar worktrees={worktrees} onClose={() => setCommandOpen(false)} />}
    </>;
  }

  if (route.page === 'help') {
    return <>
      <HelpPage />
      {commandOpen && <CommandBar worktrees={worktrees} onClose={() => setCommandOpen(false)} />}
    </>;
  }

  if (route.page === 'ports') {
    return <>
      <PortsPage />
      {commandOpen && <CommandBar worktrees={worktrees} onClose={() => setCommandOpen(false)} />}
    </>;
  }

  return (
    <div class="max-w-6xl mx-auto px-6 py-12 flex items-start gap-6">
      <div class="flex-1 min-w-0">
      <PageHeader title={
          <span class="inline-flex items-center gap-3">
            <span class="wordmark">setu</span>
            <StatusStrip status={status} />
          </span>
        } actions={<>
          <SecondaryButton onClick={() => setAddProjectOpen(true)}>+ Project</SecondaryButton>
          <PrimaryButton onClick={() => setCreateOpen(true)}>+ Worktree</PrimaryButton>
          <button onClick={() => setCommandOpen(true)} data-tip="Jump to a worktree"
            class="tip flex items-center gap-1.5 h-9 w-32 px-2.5 rounded-none backdrop-blur-md bg-white/60 dark:bg-white/5 border border-white/75 dark:border-white/10 shadow-sm text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-200 transition-colors duration-150">
            <svg class="w-3.5 h-3.5 shrink-0" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><circle cx="11" cy="11" r="7" /><path stroke-linecap="round" d="M21 21l-4.3-4.3" /></svg>
            <span class="text-xs flex-1 text-left">Search</span>
            <span class="board-mono text-[9px] font-bold shrink-0">⌘K</span>
          </button>
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

      <div class="rail-divider mt-10 mb-4" />
      <div class="flex items-center justify-between flex-wrap gap-3 text-xs text-zinc-400">
        <a href="https://mukulchugh.com" target="_blank"
          class="flex items-center gap-2 hover:text-zinc-600 dark:hover:text-zinc-300 transition-colors duration-150 w-fit">
          <img src={MUKUL_LOGO_URI} class="w-4 h-4 rounded-none" alt="" />
          Created by Mukul Chugh
        </a>
        <div class="flex items-center gap-4">
          <a href="/help" onClick={(e: any) => { e.preventDefault(); navigate('/help'); }}
            class="hover:text-zinc-600 dark:hover:text-zinc-300 transition-colors duration-150">Help &amp; guide</a>
          <a href="https://github.com/quivly/setu" target="_blank"
            class="hover:text-zinc-600 dark:hover:text-zinc-300 transition-colors duration-150">Contribute on GitHub</a>
        </div>
      </div>
      </div>

      <div class="w-52 shrink-0 sticky top-28 z-20 flex flex-col gap-1 backdrop-blur-md bg-white/70 dark:bg-white/10 border border-white/75 dark:border-white/10 shadow-lg rounded-none p-2">
        <select value={filter} onChange={(e: any) => setFilter(e.target.value)}
          class="bg-white/70 dark:bg-white/5 border border-zinc-200 dark:border-white/10 text-zinc-700 dark:text-zinc-300 text-xs rounded-none px-2 py-2 mb-1 focus:outline-none focus:border-zinc-400 transition-colors duration-150">
          <option value="all">All projects</option>
          {projects.map(p => <option key={p.name} value={p.name}>{p.label}</option>)}
        </select>
        <select value={sortKey} onChange={(e: any) => setSortKey(e.target.value)}
          class="bg-white/70 dark:bg-white/5 border border-zinc-200 dark:border-white/10 text-zinc-700 dark:text-zinc-300 text-xs rounded-none px-2 py-2 mb-1 focus:outline-none focus:border-zinc-400 transition-colors duration-150">
          <option value="recent">Recently active</option>
          <option value="name">Name</option>
          <option value="created">Created</option>
        </select>
        <div class="h-px bg-zinc-200 dark:bg-white/10 my-1" />
        <button onClick={() => setOnlyDirty(!onlyDirty)}
          class={`flex items-center gap-2.5 h-9 px-2 rounded-none border transition-all duration-150 ${
            onlyDirty ? 'bg-signal-amber border-signal-amber text-white' : 'bg-white/70 dark:bg-white/5 border-transparent text-zinc-500 dark:text-zinc-400 hover:bg-white dark:hover:bg-white/10'}`}>
          <svg class="w-4 h-4 shrink-0" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><circle cx="12" cy="12" r="8" /></svg>
          <span class="text-xs text-left">Uncommitted changes</span>
        </button>
        <button onClick={() => setOnlyAhead(!onlyAhead)}
          class={`flex items-center gap-2.5 h-9 px-2 rounded-none border transition-all duration-150 ${
            onlyAhead ? 'bg-signal-green border-signal-green text-white' : 'bg-white/70 dark:bg-white/5 border-transparent text-zinc-500 dark:text-zinc-400 hover:bg-white dark:hover:bg-white/10'}`}>
          <svg class="w-4 h-4 shrink-0" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M12 19V5m0 0l-6 6m6-6l6 6" /></svg>
          <span class="text-xs text-left">Ahead of base</span>
        </button>
        <div class="h-px bg-zinc-200 dark:bg-white/10 my-1" />
        {(['list', 'grid'] as const).map(v => (
          <button key={v} onClick={() => setView(v)}
            class={`flex items-center gap-2.5 h-9 px-2 rounded-none border transition-all duration-150 ${
              view === v ? 'bg-accent border-accent text-white' : 'bg-white/70 dark:bg-white/5 border-transparent text-zinc-500 dark:text-zinc-400 hover:bg-white dark:hover:bg-white/10'}`}>
            {v === 'list'
              ? <svg class="w-4 h-4 shrink-0" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path stroke-linecap="round" d="M4 6h16M4 12h16M4 18h16" /></svg>
              : <svg class="w-4 h-4 shrink-0" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><rect x="4" y="4" width="7" height="7" rx="1" /><rect x="13" y="4" width="7" height="7" rx="1" /><rect x="4" y="13" width="7" height="7" rx="1" /><rect x="13" y="13" width="7" height="7" rx="1" /></svg>}
            <span class="text-xs text-left">{v === 'list' ? 'List view' : 'Grid view'}</span>
          </button>
        ))}
        <div class="h-px bg-zinc-200 dark:bg-white/10 my-1" />
        <button onClick={() => setDark(!dark)}
          class="flex items-center gap-2.5 h-9 px-2 rounded-none border border-transparent bg-white/70 dark:bg-white/5 text-zinc-500 dark:text-zinc-400 hover:bg-white dark:hover:bg-white/10 transition-all duration-150">
          {dark
            ? <svg class="w-4 h-4 shrink-0" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><circle cx="12" cy="12" r="4" /><path stroke-linecap="round" d="M12 2v2m0 16v2M4.93 4.93l1.41 1.41m11.32 11.32l1.41 1.41M2 12h2m16 0h2M4.93 19.07l1.41-1.41m11.32-11.32l1.41-1.41" /></svg>
            : <svg class="w-4 h-4 shrink-0" fill="currentColor" viewBox="0 0 24 24"><path d="M21 12.79A9 9 0 1111.21 3 7 7 0 0021 12.79z" /></svg>}
          <span class="text-xs text-left">{dark ? 'Light mode' : 'Dark mode'}</span>
        </button>
        <button onClick={() => navigate('/ports')}
          class="flex items-center gap-2.5 h-9 px-2 rounded-none border border-transparent bg-white/70 dark:bg-white/5 text-zinc-500 dark:text-zinc-400 hover:bg-white dark:hover:bg-white/10 transition-all duration-150">
          <svg class="w-4 h-4 shrink-0" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M9 15v3m6-3v3M5 9h14M6 9V6a2 2 0 012-2h8a2 2 0 012 2v3m-14 0v6a2 2 0 002 2h10a2 2 0 002-2V9" /></svg>
          <span class="text-xs text-left">Active ports</span>
        </button>
        <button onClick={() => navigate('/settings')}
          class="flex items-center gap-2.5 h-9 px-2 rounded-none border border-transparent bg-white/70 dark:bg-white/5 text-zinc-500 dark:text-zinc-400 hover:bg-white dark:hover:bg-white/10 transition-all duration-150">
          <svg class="w-4 h-4 shrink-0" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><circle cx="12" cy="12" r="3" /><path stroke-linecap="round" stroke-linejoin="round" d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 11-2.83 2.83l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-4 0v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 11-2.83-2.83l.06-.06a1.65 1.65 0 00.33-1.82 1.65 1.65 0 00-1.51-1H3a2 2 0 010-4h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 112.83-2.83l.06.06a1.65 1.65 0 001.82.33H9a1.65 1.65 0 001-1.51V3a2 2 0 014 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 112.83 2.83l-.06.06a1.65 1.65 0 00-.33 1.82V9a1.65 1.65 0 001.51 1H21a2 2 0 010 4h-.09a1.65 1.65 0 00-1.51 1z" /></svg>
          <span class="text-xs text-left">Settings</span>
        </button>
      </div>

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
