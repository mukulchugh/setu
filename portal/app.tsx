// setu portal UI — Preact, bundled by Bun.serve at runtime (see portal.js)
import { render } from 'preact';
import { useState, useEffect, useRef, useCallback } from 'preact/hooks';
import {
  Badge, StatusDot, StatusFlap, IconButton, PrimaryButton, SecondaryButton,
  Modal, CloseBtn, CloseIcon, Menu, MenuItem, inputCls, type Tone, PageHeader, Section,
  ToastStack, type ToastItem,
} from './ui';
import { ToolIcon, SidecarIcon, MUKUL_LOGO_URI, VercelIcon, NetlifyIcon, ConvexIcon } from './components/icons';
import { TriviaCard } from './components/trivia-card';
import { LogModal, LiveLog } from './components/logs';
import { post, postOrToast } from './api';
import { PortsPage } from './components/ports-page';
import { DiffViewer } from './components/diff-viewer';
import { CommandBar } from './components/command-bar';
import { HelpPage } from './components/help-page';
import { RaycastSection, DiscoverProjectsSection, McpSection } from './components/settings-sections';
import { ArchivedPage } from './components/archived-page';
import { RepoPrsModal } from './components/repo-prs-modal';
import { Pagination } from './components/pagination';
import { relativeTime } from './components/relative-time';
import { type PrChecks, checksTone } from './components/pr-status';
import { getWs } from './ws';

// Shared shape for both deploy providers below (vercelDeploy/netlifyDeploy) --
// same fields either one's status Map on the server settles into.
export type DeployStatus = { deploying: boolean; url: string | null; error: string | null; target: string; startedAt: number } | null;
export type DeployProvider = 'vercel' | 'netlify';

// Convex's deploy state isn't shaped like DeployStatus above: a convex
// deploy never produces a clickable URL the way vercel/netlify do, so
// "succeeded" needs its own explicit signal (ok) rather than being inferred
// from a url field that would just always be null.
export type ConvexDeployStatus = { deploying: boolean; ok: boolean; error: string | null; target: 'preview' | 'production'; startedAt: number } | null;

export type Worktree = {
  key: string; repo: string; name: string; slug: string; port: number;
  domain: string; pubDomain: string; tunnelOn: boolean; active: boolean;
  container: string | null; nextStartMode: 'container' | 'bare'; needsMigrationPrompt: boolean;
  tunnelRunning: boolean; label: string; branch: string; branchUrl: string | null;
  pr: { url: string; number: number; title: string; state: PrState; checks: PrChecks } | null;
  vercelDeploy: DeployStatus;
  netlifyDeploy: DeployStatus;
  inngestActive: boolean; inngestPort: number; triggerActive: boolean;
  // convexConfigured gates whether any Convex UI renders at all -- unlike
  // Inngest/Trigger (assumed available everywhere), Convex only applies to
  // worktrees that actually have it set up.
  convexConfigured: boolean; convexActive: boolean; convexDeploy: ConvexDeployStatus;
  sidecars: { name: string; active: boolean }[];
  queued?: boolean; queuePosition?: number | null;
  lastCommitAt: number | null; ahead: number; behind: number; dirty: number; memMb: number | null;
  createdAt: number | null;
};
type PrState = 'open' | 'merged' | 'closed' | 'draft';
// One record per removed worktree, a history entry, not a live worktree.
// The directory itself is gone by the time this exists; branch is what
// Recreate re-checks-out, not something that can be restored to.
export type ArchivedWorktree = {
  repo: string; name: string; label: string; branch: string;
  prUrl: string | null; removedAt: number; reason: 'manual' | 'merged';
};
type Project = { name: string; label: string; github?: string | null };
// approved is server-computed (current command+args matched against the last
// approved value), not something a caller sets, present once fetched from GET.
type Sidecar = { name: string; enabled?: boolean; command: string; args?: string[]; env?: Record<string, string>; approved?: boolean };
type CustomAgent = { id: string; label: string; command: string };
type SettingsData = {
  maxConcurrentDevServers: number; containerMemoryLimit: string; containerCpuLimit: number;
  mac: { cpus: number | null; memMb: number | null }; docker: { cpus: number | null; memMb: number | null };
};
type Status = {
  concurrency: { active: number; max: number; queued: number };
  container: { engineAvailable: boolean; engine: string | null; memoryLimit: string; cpuLimit: number };
};

// Minimal router — one detail view alongside the existing list/grid doesn't
// justify a router dependency; history.pushState + popstate is the native
// platform feature that already does exactly this.
type Route = { page: 'list' } | { page: 'detail'; repo: string; name: string } | { page: 'settings' } | { page: 'help' } | { page: 'ports' } | { page: 'archived' };

function parseRoute(pathname: string): Route {
  if (pathname === '/settings') return { page: 'settings' };
  if (pathname === '/help') return { page: 'help' };
  if (pathname === '/ports') return { page: 'ports' };
  if (pathname === '/archived') return { page: 'archived' };
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

// Shared status derivation for WorktreeCard and WorktreePage — same
// active/queued/stopped tone and label logic, previously copy-pasted in both.
function worktreeStatus(w: Worktree): { tone: Tone; text: string } {
  const tone: Tone = w.active ? 'emerald' : w.queued ? 'amber' : 'zinc';
  const text = w.active ? 'running' : w.queued ? `queued #${w.queuePosition}` : 'stopped';
  return { tone, text };
}

// Shared by WorktreeCard and WorktreePage, same deploying/error/url/idle
// tone and label logic, matching worktreeStatus's shape above. Provider-
// agnostic on purpose: vercelDeploy and netlifyDeploy are the same shape,
// so one function covers both instead of two copies that would only ever
// differ by which field they read.
function deployTone(d: DeployStatus): Tone {
  if (!d) return 'zinc';
  if (d.deploying) return 'amber';
  if (d.error) return 'red';
  if (d.url) return 'emerald';
  return 'zinc';
}
function deployStatusText(d: DeployStatus): string {
  if (!d) return 'Not deployed';
  if (d.deploying) return `Deploying (${d.target})…`;
  if (d.error) return 'Deploy failed';
  if (d.url) return `Deployed to ${d.target}`;
  return 'Not deployed';
}

// Shared by WorktreeCard and WorktreePage, same shape as deployTone/
// deployStatusText above. zinc for open matches every other "default,
// nothing to flag" state in this file (container, → mode, etc.), merged is
// the one state that's actually actionable, so it gets the loud color.
function prTone(state: PrState): Tone {
  if (state === 'merged') return 'emerald';
  if (state === 'closed') return 'red';
  if (state === 'draft') return 'amber';
  return 'zinc';
}
// Card-compact PR link recolors itself by state, same recipe as the vercel
// deploying/deployed/failed items in the same row (signal-* text classes),
// not a Badge pill: this row is plain clickable references (branch/PR/
// tunnel), Badge lives in the summary-chip row above instead.
function prLinkClass(state: PrState): string {
  if (state === 'merged') return 'text-signal-green hover:opacity-80';
  if (state === 'closed') return 'text-signal-red hover:opacity-80';
  if (state === 'draft') return 'text-signal-amber hover:opacity-80';
  return 'hover:text-zinc-600';
}

// 8192MB is the amber warning threshold shared by WorktreeCard's badge and
// WorktreePage's metric — one source of truth for the number.
function memTone(mb: number): Tone { return mb > 8192 ? 'amber' : 'zinc'; }

// short=true gives the compact card-badge form (g/m), the default gives the
// spelled-out detail-page form (GB/MB) — same threshold, different label
// length for two different amounts of surrounding space.
function formatMem(mb: number, short = false): string {
  return mb >= 1024 ? `${(mb / 1024).toFixed(1)}${short ? 'g' : 'GB'}` : `${Math.round(mb)}${short ? 'm' : 'MB'}`;
}

// Same "cd into this worktree" string used by both the card's copy button and
// the detail page's "Copy cd command" action.
function cdCommand(w: Worktree): string { return `cd ~/workspace/${w.repo}/${w.name}`; }

// initialRepo/initialName prefill the Recreate flow from an archived
// worktree's record (same repo+branch, a fresh checkout). The plain
// + Worktree button omits both and falls back to the first project / blank.
function CreateModal({ projects, initialRepo, initialName, onClose, onCreated }: {
  projects: Project[]; initialRepo?: string; initialName?: string; onClose: () => void; onCreated: () => void;
}) {
  const [repo, setRepo] = useState(initialRepo ?? projects[0]?.name ?? '');
  const [name, setName] = useState(initialName ?? '');
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
      <div class="bg-white/90 dark:bg-zinc-900/70 backdrop-blur-xl rounded-none border border-zinc-200 dark:border-zinc-800 shadow-2xl p-6 w-full max-w-sm mx-4">
        <div class="flex items-center justify-between mb-5">
          <h2 class="text-base font-semibold text-zinc-900 dark:text-zinc-100">New worktree</h2>
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

function AddProjectModal({ onClose, onAdded }: { onClose: () => void; onAdded: () => void }) {
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
    setStatus(tab === 'existing' ? 'Cloning repo…' : 'Initializing repo…');
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
      <div class="bg-white/90 dark:bg-zinc-900/70 backdrop-blur-xl rounded-none border border-zinc-200 dark:border-zinc-800 shadow-2xl p-6 w-full max-w-sm mx-4">
        <div class="flex items-center justify-between mb-5">
          <div>
            <h2 class="text-base font-semibold text-zinc-900 dark:text-zinc-100">Add project</h2>
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
        <svg class="w-4 h-4 spin" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" viewBox="0 0 24 24"><path d="M20 11a8.1 8.1 0 0 0 -15.5 -2m-.5 -4v4h4" /><path d="M4 13a8.1 8.1 0 0 0 15.5 2m.5 4v-4h-4" /></svg>
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
          <svg class="w-4 h-4" fill="currentColor" viewBox="0 0 24 24"><path d="M6 4v16a1 1 0 0 0 1.524 .852l13 -8a1 1 0 0 0 0 -1.704l-13 -8a1 1 0 0 0 -1.524 .852z" /></svg>
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
        <svg class="w-4 h-4" fill="currentColor" viewBox="0 0 24 24"><path d="M6 4v16a1 1 0 0 0 1.524 .852l13 -8a1 1 0 0 0 0 -1.704l-13 -8a1 1 0 0 0 -1.524 .852z" /></svg>
      </IconButton>
      <Menu trigger={toggle => (
        <button onClick={(e: any) => { e.stopPropagation(); toggle(); }} data-tip="Force a mode"
          class="tip w-4 h-6 flex items-center justify-center text-zinc-300 hover:text-zinc-500 transition-colors duration-150 -ml-1">
          <svg class="w-3 h-3" fill="currentColor" viewBox="0 0 24 24"><path d="M18 9c.852 0 1.297 .986 .783 1.623l-.076 .084l-6 6a1 1 0 0 1 -1.32 .083l-.094 -.083l-6 -6l-.083 -.094l-.054 -.077l-.054 -.096l-.017 -.036l-.027 -.067l-.032 -.108l-.01 -.053l-.01 -.06l-.004 -.057v-.118l.005 -.058l.009 -.06l.01 -.052l.032 -.108l.027 -.067l.07 -.132l.065 -.09l.073 -.081l.094 -.083l.077 -.054l.096 -.054l.036 -.017l.067 -.027l.108 -.032l.053 -.01l.06 -.01l.057 -.004l12.059 -.002z" /></svg>
        </button>
      )}>
        <MenuItem onClick={() => onStart(w, 'bare')}>Force bare (no cap)</MenuItem>
        <MenuItem onClick={() => onStart(w, 'container')}>Force container</MenuItem>
      </Menu>
    </div>
  );
}

// Per-provider bits DeployMenu/DeployStatusChips/DeploySection below all
// need: the label for tooltips/section titles, the real brand icon (see
// components/icons.tsx), and the custom-target prompt copy. Vercel's custom
// target is a named environment; netlify's is a branch name fed through
// --context branch:<name> server-side, different enough that one prompt
// string doesn't read right for both. Icon is a component reference, not a
// pre-built element -- reusing the same vnode instance across every
// worktree card on the page is exactly the kind of thing Preact expects a
// component (mounted fresh per call site) to handle instead.
const DEPLOY_PROVIDER: Record<DeployProvider, { label: string; Icon: (props: { class?: string }) => any; customPrompt: string }> = {
  vercel:  { label: 'Vercel',  Icon: VercelIcon,  customPrompt: 'Custom environment name (e.g. staging):' },
  netlify: { label: 'Netlify', Icon: NetlifyIcon, customPrompt: 'Branch name for the deploy context (e.g. staging):' },
};

// Same "icon button opens a picker" shape as StartControl's force-mode menu
// above, for the same reason: deploying needs a target choice (preview,
// production, or a named custom environment), not a bare click. A running
// deploy is one-shot and not cancellable from here, so it renders as a
// disabled pulsing indicator instead of a clickable trigger; clicking
// "deploy" again mid-deploy isn't a meaningful action. One component covers
// both Vercel and Netlify -- they differ only in which Worktree field holds
// the deploy state and the DEPLOY_PROVIDER lookup above, not in shape.
function DeployMenu({ w, provider, deploy, onDeploy }: {
  w: Worktree; provider: DeployProvider; deploy: DeployStatus;
  onDeploy: (w: Worktree, provider: DeployProvider, target: string) => void;
}) {
  const { label, Icon, customPrompt } = DEPLOY_PROVIDER[provider];
  if (deploy?.deploying) {
    return (
      <IconButton tone="amber" tip={`Deploying to ${label} (${deploy.target})…`} disabled>
        <svg class="w-4 h-4 spin" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" viewBox="0 0 24 24"><path d="M20 11a8.1 8.1 0 0 0 -15.5 -2m-.5 -4v4h4" /><path d="M4 13a8.1 8.1 0 0 0 15.5 2m.5 4v-4h-4" /></svg>
      </IconButton>
    );
  }
  return (
    <Menu trigger={toggle => (
      <IconButton tone="zinc" tip={`Deploy to ${label}`} onClick={(e: any) => { e.stopPropagation(); toggle(); }}>
        <Icon class="w-4 h-4" />
      </IconButton>
    )}>
      <MenuItem onClick={() => onDeploy(w, provider, 'preview')}>Deploy preview</MenuItem>
      <MenuItem onClick={() => onDeploy(w, provider, 'production')}>Deploy production</MenuItem>
      <MenuItem onClick={() => {
        const custom = window.prompt(customPrompt);
        if (custom && custom.trim()) onDeploy(w, provider, custom.trim());
      }}>Deploy custom…</MenuItem>
    </Menu>
  );
}

// WorktreeCard's compact inline status chips (deploying/deployed/failed) for
// one provider -- previously inlined once for vercel only, now shared the
// same way DeployMenu above is so adding netlify didn't mean pasting a
// second copy of this same three-branch block.
function DeployStatusChips({ w, provider, deploy, onOpenLogs }: {
  w: Worktree; provider: DeployProvider; deploy: DeployStatus; onOpenLogs: (repo: string, name: string, type: string) => void;
}) {
  const { label, Icon } = DEPLOY_PROVIDER[provider];
  return <>
    {deploy?.deploying && (
      <button onClick={() => onOpenLogs(w.repo, w.name, provider)}
        title={`Deploying to ${label} (${deploy.target}), click to view progress`}
        class="flex items-center gap-1.5 text-signal-amber hover:opacity-80 transition-opacity duration-150 shrink-0">
        <StatusDot tone="amber" pulse />deploying
      </button>
    )}
    {deploy?.url && !deploy.deploying && (
      <a href={deploy.url} target="_blank" title={`Deployed to ${deploy.target}`}
        class="flex items-center gap-1 text-signal-green hover:text-zinc-600 transition-colors duration-150 shrink-0">
        <Icon class="w-3 h-3" />deployed
      </a>
    )}
    {deploy?.error && !deploy.deploying && (
      <button onClick={() => onOpenLogs(w.repo, w.name, provider)} title={deploy.error}
        class="flex items-center gap-1 text-signal-red hover:opacity-80 transition-opacity duration-150 shrink-0">
        deploy failed
      </button>
    )}
  </>;
}

// Backend shape from GET /api/pr-review/status -- see pr-review.js's
// reviewRunStatus/findLatestArtifact for where each field comes from.
type PrReviewRun = {
  running: boolean; skill: string; startedAt: number;
  exitCode: 'success' | 'error' | 'timeout' | null; costUsd: number | null;
  error: string | null; dirtyAfter: boolean | null;
} | null;
type PrReviewArtifact = {
  snapshot: string; generatedAt: string; headSha: string;
  htmlFile: string | null; findings: number | null; stale: boolean;
} | null;
type PrReviewStatus = {
  pluginInstalled: boolean; pr: { number: number } | null; run: PrReviewRun;
  artifacts: Record<'pr-walkthrough' | 'pr-brief', PrReviewArtifact>;
};

const PR_REVIEW_SKILLS = ['pr-walkthrough', 'pr-brief'] as const;
const PR_REVIEW_LABEL: Record<typeof PR_REVIEW_SKILLS[number], string> = { 'pr-walkthrough': 'Deep review', 'pr-brief': 'Brief' };

// Tier 2 of PR review -- shells out to the installed pr-walkthrough/pr-brief
// Claude Code plugin (see pr-review.js). Self-contained, same "owns its own
// polling loop" convention as RaycastSection: WorktreePage doesn't need to
// know anything about this beyond dropping it in. Renders nothing when the
// worktree has no associated PR -- there's nothing to review.
function PrReviewSection({ w, toast, onOpenLogs }: {
  w: Worktree; toast: (msg: string, tone?: Tone) => void; onOpenLogs: (repo: string, name: string, type: string) => void;
}) {
  const [status, setStatus] = useState<PrReviewStatus | null>(null);

  const load = useCallback(async () => {
    setStatus(await fetch(`/api/pr-review/status?repo=${encodeURIComponent(w.repo)}&name=${encodeURIComponent(w.name)}`).then(r => r.json()).catch(() => null));
  }, [w.repo, w.name]);

  useEffect(() => {
    load();
    const t = setInterval(load, 3000);
    return () => clearInterval(t);
  }, [load]);

  async function run(skill: string) {
    const res = await postOrToast('/api/pr-review/run', { repo: w.repo, name: w.name, skill }, toast, 'pr-review failed to start');
    if (res?.ok) load();
  }

  if (!w.pr) return null;

  const running = status?.run?.running ?? false;

  return (
    <Section title="PR Review">
      {!status ? <p class="text-sm text-zinc-400">Loading…</p> : !status.pluginInstalled ? (
        <p class="text-xs text-zinc-400">
          The pr-walkthrough plugin isn't installed for this worktree. Install it with{' '}
          <code class="font-mono text-zinc-500">claude plugin install pr-walkthrough@mukulchugh-skills</code>.
        </p>
      ) : (
        <div class="flex flex-col gap-3">
          <div class="flex items-center gap-3 flex-wrap">
            {running ? (
              <button onClick={() => onOpenLogs(w.repo, w.name, 'pr-review')}
                title={`Running ${PR_REVIEW_LABEL[status!.run!.skill as typeof PR_REVIEW_SKILLS[number]]}, click to view progress`}
                class="flex items-center gap-1.5 text-xs text-signal-amber hover:opacity-80 transition-opacity duration-150">
                <StatusDot tone="amber" pulse />running {PR_REVIEW_LABEL[status!.run!.skill as typeof PR_REVIEW_SKILLS[number]]}…
              </button>
            ) : (
              PR_REVIEW_SKILLS.map(skill => (
                <SecondaryButton key={skill} compact onClick={() => run(skill)}>{PR_REVIEW_LABEL[skill]}</SecondaryButton>
              ))
            )}
            {status?.run && !running && status.run.exitCode !== 'success' && (
              <button onClick={() => onOpenLogs(w.repo, w.name, 'pr-review')}
                class="flex items-center gap-1 text-xs text-signal-red hover:opacity-80 transition-opacity duration-150">
                {status.run.exitCode === 'timeout' ? 'timed out' : 'failed'} — view log
              </button>
            )}
            {status?.run && !running && status.run.exitCode === 'success' && status.run.costUsd != null && (
              <span class="text-xs text-zinc-400">last run cost ${status.run.costUsd.toFixed(2)}</span>
            )}
            {status?.run?.dirtyAfter && (
              <span class="text-xs text-signal-red">warning: worktree changed during the run — check with git status</span>
            )}
          </div>

          {status && PR_REVIEW_SKILLS.map(skill => {
            const a = status.artifacts[skill];
            if (!a || !a.htmlFile) return null;
            return (
              <div key={skill} class="flex items-center gap-2 text-xs">
                <a href={`/api/pr-review/artifact?repo=${encodeURIComponent(w.repo)}&name=${encodeURIComponent(w.name)}&skill=${skill}`}
                  target="_blank" class="text-zinc-700 dark:text-zinc-300 hover:text-accent transition-colors">
                  Open {PR_REVIEW_LABEL[skill].toLowerCase()}
                </a>
                {a.findings != null && <Badge tone="zinc">{a.findings} finding{a.findings === 1 ? '' : 's'}</Badge>}
                {a.stale && <span class="text-signal-amber">stale — reviewed {a.headSha.slice(0, 7)}, head has moved on</span>}
              </div>
            );
          })}
        </div>
      )}
    </Section>
  );
}

// WorktreePage's "<Provider> deploy" Section -- previously written out once
// for Vercel only, now shared with Netlify the same way everything else on
// this page is (DeployMenu, DeployStatusChips above).
function DeploySection({ w, provider, deploy, onDeploy, onOpenLogs }: {
  w: Worktree; provider: DeployProvider; deploy: DeployStatus;
  onDeploy: (w: Worktree, provider: DeployProvider, target: string) => void;
  onOpenLogs: (repo: string, name: string, type: string) => void;
}) {
  const { label } = DEPLOY_PROVIDER[provider];
  return (
    <Section title={`${label} deploy`}>
      <div class="flex items-center justify-between flex-wrap gap-3 text-sm">
        <div class="flex items-center gap-2 min-w-0">
          <StatusDot tone={deployTone(deploy)} pulse={!!deploy?.deploying} />
          <span>{deployStatusText(deploy)}</span>
          {deploy?.url && !deploy.deploying && (
            <a href={deploy.url} target="_blank" class="text-xs text-emerald-600 hover:underline truncate max-w-xs">{deploy.url}</a>
          )}
          {deploy && (
            <button onClick={() => onOpenLogs(w.repo, w.name, provider)} class="text-xs text-zinc-500 hover:underline shrink-0">view log</button>
          )}
        </div>
        <DeployMenu w={w} provider={provider} deploy={deploy} onDeploy={onDeploy} />
      </div>
      {deploy?.error && !deploy.deploying && <p class="text-xs text-signal-red mt-2">{deploy.error}</p>}
    </Section>
  );
}

// Convex's own tone/text pair, same shape as deployTone/deployStatusText
// above but reading `ok` instead of `url` -- see ConvexDeployStatus's own
// comment for why a convex deploy needs an explicit success signal rather
// than inferring it from a url field that would just always be null.
function convexDeployTone(d: ConvexDeployStatus): Tone {
  if (!d) return 'zinc';
  if (d.deploying) return 'amber';
  if (d.error) return 'red';
  if (d.ok) return 'emerald';
  return 'zinc';
}
function convexDeployText(d: ConvexDeployStatus): string {
  if (!d) return 'Not deployed';
  if (d.deploying) return `Deploying (${d.target})…`;
  if (d.error) return 'Deploy failed';
  if (d.ok) return `Deployed (${d.target})`;
  return 'Not deployed';
}

// Same "icon button opens a picker" shape as DeployMenu above, but not built
// on the DEPLOY_PROVIDER record -- convex only ever has two targets (no
// named-custom-target option makes sense for it, see deployToConvex's own
// comment in portal.js), so a dedicated two-item menu reads more directly
// than forcing convex into a three-provider abstraction built for a third
// option it doesn't have.
function ConvexDeployMenu({ w, deploy, onConvexDeploy }: {
  w: Worktree; deploy: ConvexDeployStatus;
  onConvexDeploy: (w: Worktree, target: 'preview' | 'production') => void;
}) {
  if (deploy?.deploying) {
    return (
      <IconButton tone="amber" tip={`Deploying to Convex (${deploy.target})…`} disabled>
        <svg class="w-4 h-4 spin" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" viewBox="0 0 24 24"><path d="M20 11a8.1 8.1 0 0 0 -15.5 -2m-.5 -4v4h4" /><path d="M4 13a8.1 8.1 0 0 0 15.5 2m.5 4v-4h-4" /></svg>
      </IconButton>
    );
  }
  return (
    <Menu trigger={toggle => (
      <IconButton tone="zinc" tip="Deploy to Convex" onClick={(e: any) => { e.stopPropagation(); toggle(); }}>
        <ConvexIcon class="w-4 h-4" />
      </IconButton>
    )}>
      <MenuItem onClick={() => onConvexDeploy(w, 'preview')}>Deploy preview</MenuItem>
      <MenuItem onClick={() => onConvexDeploy(w, 'production')}>Deploy production</MenuItem>
    </Menu>
  );
}

// WorktreePage's "Convex" Section -- only ever rendered by its caller when
// w.convexConfigured is true (see WorktreePage below). Combines a sidecar-
// style start/stop row (mirroring the Inngest row in the Sidecars Section
// below exactly) with a small Deploy action (mirroring DeploySection above),
// since Convex genuinely has both shapes: a persistent dev process and a
// separate occasional deploy.
function ConvexSection({ w, onAct, onOpenLogs, onConvexDeploy }: {
  w: Worktree;
  onAct: (url: string, w: Worktree) => void; onOpenLogs: (repo: string, name: string, type: string) => void;
  onConvexDeploy: (w: Worktree, target: 'preview' | 'production') => void;
}) {
  const deploy = w.convexDeploy;
  return (
    <Section title="Convex">
      <div class="flex items-center justify-between flex-wrap gap-3 text-sm">
        <div class="flex items-center gap-2">
          <ConvexIcon class="w-4 h-4" />
          <StatusDot tone={w.convexActive ? 'emerald' : 'zinc'} />
          <span>{w.convexActive ? 'dev running' : 'dev stopped'}</span>
          {w.convexActive
            ? <button onClick={() => onAct('/api/convex/stop', w)} class="text-xs text-red-500 hover:underline">stop</button>
            : <button onClick={() => onAct('/api/convex/start', w)} class="text-xs text-zinc-500 hover:underline">start</button>}
          <button onClick={() => onOpenLogs(w.repo, w.name, 'convex')} class="text-xs text-zinc-500 hover:underline">view log</button>
        </div>
        <div class="flex items-center gap-2 min-w-0">
          <StatusDot tone={convexDeployTone(deploy)} pulse={!!deploy?.deploying} />
          <span class="text-xs text-zinc-500">{convexDeployText(deploy)}</span>
          <ConvexDeployMenu w={w} deploy={deploy} onConvexDeploy={onConvexDeploy} />
        </div>
      </div>
      {deploy?.error && !deploy.deploying && <p class="text-xs text-signal-red mt-2">{deploy.error}</p>}
    </Section>
  );
}

function WorktreeCard({ w, pending, agents, onAct, onStart, onDeploy, onOpenLogs, onOpenTool, onRemove, toast, gridMode }: {
  w: Worktree; pending: boolean; agents: { id: string; label: string }[];
  onAct: (url: string, w: Worktree) => void; onStart: (w: Worktree, force?: 'container' | 'bare') => void;
  onDeploy: (w: Worktree, provider: DeployProvider, target: string) => void;
  onOpenLogs: (repo: string, name: string, type: string) => void; onOpenTool: (w: Worktree, tool: string) => void;
  onRemove: (w: Worktree, reason?: 'manual' | 'merged') => void; toast: (msg: string, tone?: Tone) => void; gridMode: boolean;
}) {
  const [copied, setCopied] = useState(false);

  function copyCD() {
    navigator.clipboard.writeText(cdCommand(w))
      .then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); })
      .catch(() => toast(`✗ Couldn't copy to clipboard. Run it manually: ${cdCommand(w)}`, 'red'));
  }

  const { tone: statusTone, text: statusText } = worktreeStatus(w);
  const showInngestInline = w.inngestActive;
  const showTriggerInline = w.triggerActive;
  // Two-part gate, unlike the two above: Convex isn't assumed available on
  // every worktree, so the inline chip needs both "configured" and "active",
  // not just "active" alone.
  const showConvexInline = w.convexConfigured && w.convexActive;

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
            <StatusFlap text={statusText} tone={statusTone} />
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
            <Badge tone={memTone(w.memMb)} tip="Live memory footprint of this dev server">
              {formatMem(w.memMb, true)}
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
          {showConvexInline && (
            <button onClick={() => onOpenLogs(w.repo, w.name, 'convex')} title="Convex dev logs"
              class="flex items-center gap-1.5 hover:text-zinc-600 transition-colors duration-150 shrink-0">
              <ConvexIcon class="w-3 h-3" />convex
            </button>
          )}
          {w.sidecars.some(s => s.active) && (
            <span title={w.sidecars.filter(s => s.active).map(s => s.name).join(', ')}
              class="flex items-center gap-1.5 shrink-0">
              <StatusDot tone="emerald" />{w.sidecars.filter(s => s.active).length === 1 ? w.sidecars.find(s => s.active)!.name : `${w.sidecars.filter(s => s.active).length} sidecars`}
            </span>
          )}
          {w.branchUrl && (
            <a href={w.branchUrl} target="_blank" class="flex items-center gap-1 hover:text-zinc-600 transition-colors duration-150 shrink-0">
              <svg class="w-3 h-3" fill="currentColor" viewBox="0 0 16 16"><path d="M5 3.25a.75.75 0 1 1-1.5 0 .75.75 0 0 1 1.5 0zm0 2.122a2.25 2.25 0 1 0-1.5 0v.878A2.25 2.25 0 0 0 5.75 8.5h1.5v2.128a2.251 2.251 0 1 0 1.5 0V8.5h1.5a2.25 2.25 0 0 0 2.25-2.25v-.878a2.25 2.25 0 1 0-1.5 0v.878a.75.75 0 0 1-.75.75h-4.5A.75.75 0 0 1 5 6.25v-.878zm3.75 7.378a.75.75 0 1 1-1.5 0 .75.75 0 0 1 1.5 0zm3-8.75a.75.75 0 1 1-1.5 0 .75.75 0 0 1 1.5 0z" /></svg>branch
            </a>
          )}
          {w.pr && (
            <a href={w.pr.url} target="_blank" title={`${w.pr.state}: ${w.pr.title}`}
              class={`flex items-center gap-1 transition-colors duration-150 shrink-0 ${prLinkClass(w.pr.state)}`}>
              <svg class="w-3 h-3" fill="currentColor" viewBox="0 0 16 16"><path d="M1.5 3.25a2.25 2.25 0 1 1 3 2.122v5.256a2.251 2.251 0 1 1-1.5 0V5.372A2.25 2.25 0 0 1 1.5 3.25zm5.677-.177L9.573.677A.25.25 0 0 1 10 .854V2.5h1A2.5 2.5 0 0 1 13.5 5v5.628a2.251 2.251 0 1 1-1.5 0V5a1 1 0 0 0-1-1h-1v1.646a.25.25 0 0 1-.427.177L7.177 3.427a.25.25 0 0 1 0-.354zM3.75 2.5a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5zm0 9.5a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5zm8.25.75a.75.75 0 1 1 1.5 0 .75.75 0 0 1-1.5 0z" /></svg>
              PR #{w.pr.number}
              {w.pr.state === 'merged' && <span class="board-mono text-[8px] font-bold">MERGED</span>}
              {(w.pr.state === 'open' || w.pr.state === 'draft') && w.pr.checks !== 'none' && (
                <StatusDot tone={checksTone(w.pr.checks)} pulse={w.pr.checks === 'pending'} />
              )}
            </a>
          )}
          <DeployStatusChips w={w} provider="vercel" deploy={w.vercelDeploy} onOpenLogs={onOpenLogs} />
          <DeployStatusChips w={w} provider="netlify" deploy={w.netlifyDeploy} onOpenLogs={onOpenLogs} />
        </div>
      </div>

    <div class={gridMode ? 'flex items-center justify-between gap-2 -mx-5 -mb-5 mt-1 px-5 py-2.5 border-t border-zinc-100 dark:border-zinc-800 bg-zinc-100/70 dark:bg-black/20' : 'contents'}>
      {/* Hidden until hover — a clean card at rest, the tool-launch icons
          only when you're actually looking at this specific card. The
          Start/Stop/More row below stays always-visible; that's the one
          thing you came here to do, not a secondary action to reveal. */}
      <div class={`flex items-center gap-0.5 shrink-0 flex-wrap transition-opacity duration-150 ${
        gridMode ? '' : 'opacity-0 group-hover:opacity-100 focus-within:opacity-100'}`}>
        <IconButton tone="zinc" tip="Open in browser" disabled={!w.active} href={`http://${w.domain}`} target="_blank">
          <svg class="w-4 h-4" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" viewBox="0 0 24 24"><path d="M12 6h-6a2 2 0 0 0 -2 2v10a2 2 0 0 0 2 2h10a2 2 0 0 0 2 -2v-6" /><path d="M11 13l9 -9" /><path d="M15 4h5v5" /></svg>
        </IconButton>
        {agents.map((a: { id: string; label: string }) => (
          <IconButton key={a.id} tone="zinc" tip={`Open in ${a.label}`} onClick={() => onOpenTool(w, a.id)}>
            <ToolIcon id={a.id} label={a.label} />
          </IconButton>
        ))}
        <IconButton tone="zinc" tip="Copy cd command" onClick={copyCD}>
          {copied
            ? <svg class="w-3.5 h-3.5 text-emerald-500" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" viewBox="0 0 24 24"><path d="M5 12l5 5l10 -10" /></svg>
            : <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" viewBox="0 0 24 24"><path d="M7 9.667a2.667 2.667 0 0 1 2.667 -2.667h8.666a2.667 2.667 0 0 1 2.667 2.667v8.666a2.667 2.667 0 0 1 -2.667 2.667h-8.666a2.667 2.667 0 0 1 -2.667 -2.667l0 -8.666" /><path d="M4.012 16.737a2.005 2.005 0 0 1 -1.012 -1.737v-10c0 -1.1 .9 -2 2 -2h10c.75 0 1.158 .385 1.5 1" /></svg>}
        </IconButton>
        <IconButton tone={w.tunnelRunning ? 'emerald' : 'zinc'}
          tip={w.tunnelRunning ? 'Tunnel live — click to disable' : w.tunnelOn ? 'Tunnel configured, not running' : 'Enable tunnel'}
          onClick={() => onAct(w.tunnelOn ? '/api/tunnel/disable' : '/api/tunnel/enable', w)}>
          <svg class="w-4 h-4" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" viewBox="0 0 24 24"><path d="M3 12a9 9 0 1 0 18 0a9 9 0 0 0 -18 0" /><path d="M3.6 9h16.8" /><path d="M3.6 15h16.8" /><path d="M11.5 3a17 17 0 0 0 0 18" /><path d="M12.5 3a17 17 0 0 1 0 18" /></svg>
        </IconButton>
        <DeployMenu w={w} provider="vercel" deploy={w.vercelDeploy} onDeploy={onDeploy} />
        <DeployMenu w={w} provider="netlify" deploy={w.netlifyDeploy} onDeploy={onDeploy} />
        {/* Merged-PR shortcut straight to the same confirm()-gated remove
            flow the "Remove worktree" menu item below already uses, not a
            second removal pathway, just a faster route to the one that
            exists. Emerald (not the menu item's red) to read as "safe to do
            now" rather than "destructive", since the PR being merged is
            exactly what makes it safe. */}
        {w.pr?.state === 'merged' && (
          <IconButton tone="emerald" tip="PR merged, clean up worktree" onClick={() => onRemove(w, 'merged')}>
            <svg class="w-4 h-4" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" viewBox="0 0 24 24"><path d="M4 7l16 0" /><path d="M10 11l0 6" /><path d="M14 11l0 6" /><path d="M5 7l1 12a2 2 0 0 0 2 2h8a2 2 0 0 0 2 -2l1 -12" /><path d="M9 7v-3a1 1 0 0 1 1 -1h4a1 1 0 0 1 1 1v3" /></svg>
          </IconButton>
        )}
      </div>

      {/* Always visible: the one thing you came here to do, and the menu for everything else. */}
      <div class="flex items-center gap-1 shrink-0">
        {w.active ? (
          <IconButton tone="red" tip="Stop server" onClick={() => onAct('/api/stop', w)}>
            <svg class="w-4 h-4" fill="currentColor" viewBox="0 0 24 24"><path d="M17 4h-10a3 3 0 0 0 -3 3v10a3 3 0 0 0 3 3h10a3 3 0 0 0 3 -3v-10a3 3 0 0 0 -3 -3z" /></svg>
          </IconButton>
        ) : w.queued ? (
          <IconButton tone="amber" tip={`Queued #${w.queuePosition} — click to cancel`} onClick={() => onAct('/api/stop', w)}>
            <svg class="w-4 h-4" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" viewBox="0 0 24 24"><path d="M3 12a9 9 0 1 0 18 0a9 9 0 0 0 -18 0" /><path d="M12 7v5l3 3" /></svg>
          </IconButton>
        ) : (
          <StartControl w={w} pending={pending} onStart={onStart} />
        )}

        <Menu trigger={toggle => (
          <IconButton tone="zinc" tip="More actions" onClick={(e: any) => { e.stopPropagation(); toggle(); }}>
            <svg class="w-4 h-4" fill="currentColor" viewBox="0 0 24 24"><path d="M14 12a2 2 0 1 1 -4 0q 0 -.053 .005 -.102a1.996 1.996 0 0 1 1.995 -1.898a2 2 0 0 1 2 2" /><path d="M14 19a2 2 0 1 1 -4 0q 0 -.052 .005 -.102a1.996 1.996 0 0 1 1.995 -1.898a2 2 0 0 1 2 2" /><path d="M14 5a2 2 0 1 1 -4 0q 0 -.053 .005 -.102a1.996 1.996 0 0 1 1.995 -1.898a2 2 0 0 1 2 2" /></svg>
          </IconButton>
        )}>
          <MenuItem onClick={() => onOpenLogs(w.repo, w.name, 'dev')}
            icon={<svg class="w-3 h-3 shrink-0 text-zinc-400" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" viewBox="0 0 24 24"><path d="M14 3v4a1 1 0 0 0 1 1h4" /><path d="M17 21h-10a2 2 0 0 1 -2 -2v-14a2 2 0 0 1 2 -2h7l5 5v11a2 2 0 0 1 -2 2" /><path d="M9 9l1 0" /><path d="M9 13l6 0" /><path d="M9 17l6 0" /></svg>}>
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
          {w.convexConfigured && !w.convexActive && (
            <MenuItem onClick={() => onAct('/api/convex/start', w)} icon={<ConvexIcon class="w-3 h-3" />}>
              Start Convex dev
            </MenuItem>
          )}
          {w.convexConfigured && w.convexActive && (
            <MenuItem onClick={() => onAct('/api/convex/stop', w)} icon={<ConvexIcon class="w-3 h-3" />}>
              Stop Convex dev
            </MenuItem>
          )}
          <div class="my-1 border-t border-zinc-100" />
          <MenuItem onClick={() => onAct('/api/sync', w)}
            icon={<svg class="w-3 h-3 shrink-0 text-zinc-400" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" viewBox="0 0 24 24"><path d="M20 11a8.1 8.1 0 0 0 -15.5 -2m-.5 -4v4h4" /><path d="M4 13a8.1 8.1 0 0 0 15.5 2m.5 4v-4h-4" /></svg>}>
            Sync with staging
          </MenuItem>
          <div class="my-1 border-t border-zinc-100" />
          <MenuItem tone="red" onClick={() => onRemove(w)}
            icon={<svg class="w-3 h-3 shrink-0" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" viewBox="0 0 24 24"><path d="M4 7l16 0" /><path d="M10 11l0 6" /><path d="M14 11l0 6" /><path d="M5 7l1 12a2 2 0 0 0 2 2h8a2 2 0 0 0 2 -2l1 -12" /><path d="M9 7v-3a1 1 0 0 1 1 -1h4a1 1 0 0 1 1 1v3" /></svg>}>
            Remove worktree
          </MenuItem>
        </Menu>
      </div>
    </div>
    </div>
  );
}

// Same grid/flex wrapper and WorktreeCard mapping used for both the "Now
// running" section and the main paginated list — previously duplicated with
// identical prop-drilling. emptyMessage is only ever passed by the main list;
// "Now running" is only rendered when its items are non-empty, so its call
// never hits the empty branch and the paragraph never shows there.
function WorktreeList({ items, gridMode, onAct, onStart, onDeploy, onRemove, toast, onOpenLogs, onOpenTool, pendingStart, agents, emptyMessage }: {
  items: Worktree[]; gridMode: boolean;
  onAct: (url: string, w: Worktree) => void; onStart: (w: Worktree, force?: 'container' | 'bare') => void;
  onDeploy: (w: Worktree, provider: DeployProvider, target: string) => void;
  onRemove: (w: Worktree, reason?: 'manual' | 'merged') => void; toast: (msg: string, tone?: Tone) => void;
  onOpenLogs: (repo: string, name: string, type: string) => void; onOpenTool: (w: Worktree, tool: string) => void;
  pendingStart: Set<string>; agents: { id: string; label: string }[]; emptyMessage?: string;
}) {
  return (
    <div class={gridMode ? 'grid grid-cols-1 lg:grid-cols-2 gap-3 items-start' : 'flex flex-col gap-3'}>
      {!items.length
        ? <p class="text-zinc-400 text-sm py-10 text-center">{emptyMessage}</p>
        : items.map(w => (
          <WorktreeCard key={w.key} w={w} gridMode={gridMode} pending={pendingStart.has(w.key)} agents={agents}
            onAct={onAct} onStart={onStart} onDeploy={onDeploy} onRemove={onRemove} toast={toast}
            onOpenLogs={onOpenLogs} onOpenTool={onOpenTool} />
        ))}
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
      <span data-tip={`${concurrency.active} of ${concurrency.max} dev servers running`} class="tip flex items-center gap-1.5 px-2.5 py-1">
        <StatusDot tone={atCap ? 'amber' : 'emerald'} />
        {concurrency.active} running
        {concurrency.queued > 0 && <span class="text-signal-amber">·{concurrency.queued}q</span>}
      </span>
      <span data-tip={container.engineAvailable ? `Engine: ${container.engine}, ${container.memoryLimit} memory limit` : 'No container runtime reachable — setu start falls back to --bare'}
        class={`tip flex items-center gap-1.5 px-2.5 py-1 ${container.engineAvailable ? 'text-zinc-500' : 'text-signal-amber'}`}>
        <StatusDot tone={container.engineAvailable ? 'emerald' : 'amber'} />
        {container.cpuLimit} cpu
      </span>
    </div>
  );
}

function WorktreePage({ w, loaded, agents, onAct, onStart, onDeploy, onConvexDeploy, onOpenLogs, onOpenTool, onRemove, toast }: {
  w: Worktree | undefined; loaded: boolean; agents: { id: string; label: string }[];
  onAct: (url: string, w: Worktree) => void; onStart: (w: Worktree, force?: 'container' | 'bare') => void;
  onDeploy: (w: Worktree, provider: DeployProvider, target: string) => void;
  onConvexDeploy: (w: Worktree, target: 'preview' | 'production') => void;
  onOpenLogs: (repo: string, name: string, type: string) => void;
  onOpenTool: (w: Worktree, tool: string) => void; onRemove: (w: Worktree, reason?: 'manual' | 'merged') => void; toast: (msg: string, tone?: Tone) => void;
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

  const { tone: statusTone, text: statusText } = worktreeStatus(w);

  return (
    <div class="max-w-3xl mx-auto px-6 py-12">
      <PageHeader
        back={{ label: 'All worktrees', onClick: () => navigate('/') }}
        title={w.name}
        subtitle={
          <div class="flex items-center gap-2 flex-wrap">
            <span class="flex items-center gap-1.5">
              <StatusDot tone={statusTone} pulse={w.active} />
              <StatusFlap text={statusText} tone={statusTone} />
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

      {/* Distinct banner, not folded into the Overview grid below: this is
          the one PR state that asks for a decision (clean up or not), the
          others (open/closed/draft) are just informational. "Clean up
          worktree" calls the same onRemove as the Remove button at the
          bottom of this page, so it's still confirm()-gated and still
          leaves the branch alone, a shortcut to the existing flow, not a
          second one. */}
      {w.pr?.state === 'merged' && (
        <div class="flex items-center justify-between gap-3 mb-6 px-4 py-3 border border-signal-green/30 bg-signal-green/5 rounded-none text-sm">
          <span class="flex items-center gap-2 text-zinc-700 dark:text-zinc-300">
            <StatusDot tone="emerald" />
            PR #{w.pr.number} merged, ready to clean up
          </span>
          <SecondaryButton compact onClick={() => onRemove(w, 'merged')}>Clean up worktree</SecondaryButton>
        </div>
      )}

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
            <div class="min-w-0">
              <div class="text-zinc-400 text-xs mb-0.5">Pull request</div>
              <div class="flex items-center gap-2 min-w-0">
                <a href={w.pr.url} target="_blank" class="text-zinc-700 dark:text-zinc-300 hover:text-accent transition-colors truncate">PR #{w.pr.number} — {w.pr.title}</a>
                <Badge tone={prTone(w.pr.state)}>{w.pr.state}</Badge>
                {(w.pr.state === 'open' || w.pr.state === 'draft') && w.pr.checks !== 'none' && (
                  <span class="tip shrink-0" data-tip={`checks: ${w.pr.checks}`}>
                    <StatusDot tone={checksTone(w.pr.checks)} pulse={w.pr.checks === 'pending'} />
                  </span>
                )}
              </div>
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
              <div class={memTone(w.memMb) === 'amber' ? 'text-signal-amber' : ''}>{formatMem(w.memMb)}</div>
            </div>
          )}
        </div>
      </Section>

      {/* Natural expansion of Metrics' ahead/behind/dirty counts above: this
          is the actual content behind those numbers, not a separate concern.
          Labeled "Local diff", not "PR diff" or "Diff review" — this is the
          worktree branch diffed against a locally-resolved base ref, not the
          actual GitHub PR diff (they usually coincide but aren't guaranteed
          to: the PR's real base can differ from baseBranchRef(), or local
          HEAD can diverge from what's pushed). DiffViewer's own body already
          names the resolved base per group ("since branching from <base>"),
          so this title doesn't repeat it. */}
      <Section title="Local diff">
        <DiffViewer repo={w.repo} name={w.name} dirty={w.dirty} />
      </Section>

      <PrReviewSection w={w} toast={toast} onOpenLogs={onOpenLogs} />

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
          {/* Custom sidecars (sidecars.json) don't have their own start/stop
              route -- they're bundled into the worktree's own start/stop, so
              this is status-only, same as it actually is on the backend. */}
          {w.sidecars.map(s => (
            <div key={s.name} class="flex items-center gap-2">
              <StatusDot tone={s.active ? 'emerald' : 'zinc'} />
              <span>{s.name}</span>
              {s.active && <button onClick={() => onOpenLogs(w.repo, w.name, `sidecar-${s.name}`)} class="text-xs text-zinc-500 hover:underline">log</button>}
            </div>
          ))}
        </div>
      </Section>

      {/* Only rendered when this worktree actually has Convex configured --
          unlike the Sidecars Section above (Inngest/Trigger/Tunnel, assumed
          relevant everywhere), an empty Convex section on every worktree
          that doesn't use it would just be noise. */}
      {w.convexConfigured && (
        <ConvexSection w={w} onAct={onAct} onOpenLogs={onOpenLogs} onConvexDeploy={onConvexDeploy} />
      )}

      <DeploySection w={w} provider="vercel" deploy={w.vercelDeploy} onDeploy={onDeploy} onOpenLogs={onOpenLogs} />
      <DeploySection w={w} provider="netlify" deploy={w.netlifyDeploy} onDeploy={onDeploy} onOpenLogs={onOpenLogs} />

      <Section title="Open in">
        <div class="flex items-center gap-2 flex-wrap">
          {agents.map(a => (
            <button key={a.id} onClick={() => onOpenTool(w, a.id)}
              class="flex items-center gap-1.5 text-xs px-2.5 py-1.5 rounded-none border border-zinc-200 dark:border-zinc-700 bg-zinc-50 dark:bg-zinc-800 hover:bg-zinc-100 dark:hover:bg-zinc-700 text-zinc-600 dark:text-zinc-300 transition-colors duration-150">
              <ToolIcon id={a.id} label={a.label} />{a.label}
            </button>
          ))}
          <button onClick={() => navigator.clipboard.writeText(cdCommand(w)).then(() => toast('Copied', 'emerald')).catch(() => toast(`✗ Couldn't copy to clipboard. Run it manually: ${cdCommand(w)}`, 'red'))}
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
function SidecarRow({ s, onChange, onRemove, onApprove }: { s: Sidecar; onChange: (s: Sidecar) => void; onRemove: () => void; onApprove: () => void }) {
  // approved is only meaningful for a row that's actually been saved and
  // fetched back (a brand-new unsaved row has approved === undefined, not
  // false, so it never shows the badge before there's anything to approve).
  const needsApproval = s.approved === false && s.enabled !== false && !!s.command;
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
      {needsApproval && (
        <>
          <Badge tone="amber" tip="Command changed or never approved, will be skipped on Start until approved">needs approval</Badge>
          <button onClick={onApprove} class="text-xs text-emerald-600 hover:underline">Approve</button>
        </>
      )}
      <IconButton tone="red" tip="Remove sidecar" onClick={onRemove}>
        <CloseIcon class="w-3.5 h-3.5" />
      </IconButton>
    </div>
  );
}

// One custom-agent row — label/command edited in place. Same controlled-row
// shape as SidecarRow above: the parent owns the array and re-saves the
// whole list on "Save custom agents", this is purely a controlled row.
// `id` is intentionally not editable here — it's either the backend-assigned
// slug for an existing row (must round-trip unchanged on edit) or '' for a
// brand-new row (the backend assigns a slug on save).
function CustomAgentRow({ a, onChange, onRemove }: { a: CustomAgent; onChange: (a: CustomAgent) => void; onRemove: () => void }) {
  return (
    <div class="flex items-center gap-2 py-2 border-b border-zinc-100 dark:border-zinc-800 last:border-0">
      <input value={a.label} onInput={(e: any) => onChange({ ...a, label: e.target.value })} placeholder="label"
        class={`${inputCls} w-28 text-xs py-1`} />
      <input value={a.command} onInput={(e: any) => onChange({ ...a, command: e.target.value })} placeholder="mytool --flag"
        class={`${inputCls} flex-1 text-xs py-1 font-mono`} />
      <IconButton tone="red" tip="Remove custom agent" onClick={onRemove}>
        <CloseIcon class="w-3.5 h-3.5" />
      </IconButton>
    </div>
  );
}

function SettingsPage({ toast }: { toast: (msg: string, tone?: Tone) => void }) {
  const [settings, setSettings] = useState<SettingsData | null>(null);
  const [saving, setSaving] = useState(false);
  const [projects, setProjects] = useState<Project[]>([]);
  const [addProjectOpen, setAddProjectOpen] = useState(false);
  const [sidecarRepo, setSidecarRepo] = useState('');
  const [sidecars, setSidecars] = useState<Sidecar[]>([]);
  const [sidecarsSaving, setSidecarsSaving] = useState(false);
  const [fileSyncRepo, setFileSyncRepo] = useState('');
  const [fileSyncText, setFileSyncText] = useState('');
  const [fileSyncSaving, setFileSyncSaving] = useState(false);
  const [customAgents, setCustomAgents] = useState<CustomAgent[]>([]);
  const [customAgentsSaving, setCustomAgentsSaving] = useState(false);

  const loadProjects = useCallback(async () => {
    const ps = await fetch('/api/projects').then(r => r.json()).catch(() => []);
    setProjects(ps);
    if (!sidecarRepo && ps.length) setSidecarRepo(ps[0].name);
    if (!fileSyncRepo && ps.length) setFileSyncRepo(ps[0].name);
  }, [sidecarRepo, fileSyncRepo]);

  const loadCustomAgents = useCallback(async () => {
    setCustomAgents(await fetch('/api/custom-agents').then(r => r.json()).catch(() => []));
  }, []);

  useEffect(() => {
    fetch('/api/settings').then(r => r.json()).then(setSettings).catch(() => {});
    loadProjects();
    loadCustomAgents();
  }, []);

  // Pulled out of the effect below so saveSidecarsList/approveSidecarRow can
  // re-fetch too, refreshing each row's approved badge after either action.
  const loadSidecarsList = useCallback(async () => {
    if (!sidecarRepo) { setSidecars([]); return; }
    setSidecars(await fetch(`/api/sidecars?repo=${encodeURIComponent(sidecarRepo)}`).then(r => r.json()).catch(() => []));
  }, [sidecarRepo]);

  useEffect(() => { loadSidecarsList(); }, [loadSidecarsList]);

  useEffect(() => {
    if (!fileSyncRepo) return;
    fetch(`/api/file-sync-globs?repo=${encodeURIComponent(fileSyncRepo)}`).then(r => r.json())
      .then((globs: string[]) => setFileSyncText((Array.isArray(globs) ? globs : []).join('\n')))
      .catch(() => setFileSyncText(''));
  }, [fileSyncRepo]);

  async function saveSettings(patch: Partial<SettingsData>) {
    if (!settings) return;
    const next = { ...settings, ...patch };
    setSettings(next);
    setSaving(true);
    await postOrToast('/api/settings', patch, toast, 'settings save failed');
    setSaving(false);
  }

  async function removeProject(name: string) {
    if (!confirm(`Remove project "${name}"? Existing worktrees keep working — this only drops it from the registry.`)) return;
    await postOrToast('/api/project/remove', { name }, toast, 'remove failed');
    loadProjects();
  }

  async function saveSidecarsList(next: Sidecar[]) {
    setSidecars(next);
    setSidecarsSaving(true);
    await postOrToast('/api/sidecars', { repo: sidecarRepo, sidecars: next }, toast, 'save failed');
    setSidecarsSaving(false);
    loadSidecarsList(); // re-fetch so a just-edited command's approved badge updates
  }

  async function approveSidecarRow(name: string) {
    await postOrToast('/api/sidecar-approvals/approve', { repo: sidecarRepo, name }, toast, 'approve failed');
    loadSidecarsList();
  }

  // Splits on comma or newline so either style of pasting a glob list works,
  // matching the "comma-or-newline-separated" input the settings field asks for.
  async function saveFileSyncGlobsList() {
    const globs = fileSyncText.split(/[,\n]/).map(g => g.trim()).filter(Boolean);
    setFileSyncSaving(true);
    await postOrToast('/api/file-sync-globs', { repo: fileSyncRepo, globs }, toast, 'save failed');
    setFileSyncSaving(false);
  }

  async function saveCustomAgentsList(next: CustomAgent[]) {
    setCustomAgents(next);
    setCustomAgentsSaving(true);
    await postOrToast('/api/custom-agents', { agents: next }, toast, 'save failed');
    setCustomAgentsSaving(false);
    loadCustomAgents(); // re-fetch so backend-assigned ids populate into state
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
        {!projects.length ? <p class="text-sm text-zinc-400">No projects registered yet. Click + Project to add one.</p> : (
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

      <DiscoverProjectsSection toast={toast} onImported={loadProjects} />

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
                onRemove={() => saveSidecarsList(sidecars.filter((_, j) => j !== i))}
                onApprove={() => approveSidecarRow(s.name)} />
            ))}
            <div class="flex items-center gap-3 pt-2">
              <SecondaryButton onClick={() => setSidecars(list => [...list, { name: '', command: '', args: [], enabled: true }])}>+ Add sidecar</SecondaryButton>
              <PrimaryButton onClick={() => saveSidecarsList(sidecars)} disabled={sidecarsSaving}>{sidecarsSaving ? 'Saving…' : 'Save sidecars'}</PrimaryButton>
            </div>
            <p class="text-[11px] text-zinc-400 mt-1">Runs alongside the dev server on Start — for anything that isn't Inngest/trigger.dev/tunnel, which already have first-class controls on each worktree's page.</p>
          </div>
        )}
      </Section>

      <Section title="File Sync" actions={
        projects.length > 1 && (
          <select value={fileSyncRepo} onChange={(e: any) => setFileSyncRepo(e.target.value)} class={`${inputCls} text-xs py-1`}>
            {projects.map(p => <option key={p.name} value={p.name}>{p.label}</option>)}
          </select>
        )
      }>
        {!projects.length ? <p class="text-sm text-zinc-400">Add a project first.</p> : (
          <div class="flex flex-col gap-2">
            <textarea value={fileSyncText} onInput={(e: any) => setFileSyncText(e.target.value)}
              placeholder="*.local.json&#10;config/local.json" rows={3}
              class={`${inputCls} w-full text-xs py-1 font-mono`} />
            <div class="flex items-center gap-3 pt-2">
              <PrimaryButton onClick={saveFileSyncGlobsList} disabled={fileSyncSaving}>{fileSyncSaving ? 'Saving…' : 'Save file sync'}</PrimaryButton>
            </div>
            <p class="text-[11px] text-zinc-400 mt-1">Comma or newline separated glob patterns. Matching gitignored files are copied (not symlinked, unlike .env.local) from the main worktree into every newly created worktree, so each one gets its own editable copy. Patterns resolve against the main worktree's root, not an app subdir — for quivly-app include the subdir, e.g. apps/quivly-app/.env.development.local.</p>
          </div>
        )}
      </Section>

      <Section title="Custom Agents">
        <div class="flex flex-col gap-2">
          {customAgents.map((a, i) => (
            <CustomAgentRow key={i} a={a}
              onChange={next => setCustomAgents(list => list.map((x, j) => j === i ? next : x))}
              onRemove={() => saveCustomAgentsList(customAgents.filter((_, j) => j !== i))} />
          ))}
          <div class="flex items-center gap-3 pt-2">
            <SecondaryButton onClick={() => setCustomAgents(list => [...list, { id: '', label: '', command: '' }])}>+ Add custom agent</SecondaryButton>
            <PrimaryButton onClick={() => saveCustomAgentsList(customAgents)} disabled={customAgentsSaving}>{customAgentsSaving ? 'Saving…' : 'Save custom agents'}</PrimaryButton>
          </div>
          <p class="text-[11px] text-zinc-400 mt-1">Shows up in every worktree's "Open in" row alongside Claude/Cursor/etc. Not <span class="font-mono">which</span>-checked — make sure the command actually runs.</p>
        </div>
      </Section>

      <McpSection toast={toast} />

      <RaycastSection toast={toast} />

      {addProjectOpen && <AddProjectModal onClose={() => setAddProjectOpen(false)} onAdded={loadProjects} />}
    </div>
  );
}

// Local to App only — collapses the sidebar's repeated button-chrome shell
// (dirty/ahead toggles, dark mode, ports/settings/raycast links). Each
// button's active-state coloring differs (amber/green/accent/none), so it's
// passed in per call site rather than baked into one scheme. `right` covers
// Raycast's trailing status text, the one button here with extra content.
function SidebarButton({ icon, label, active = false, activeClass, tip, onClick, right }: {
  icon: any; label: any; active?: boolean; activeClass?: string; tip?: string; onClick: () => void; right?: any;
}) {
  const cls = `flex items-center gap-2.5 h-9 px-2 rounded-none border transition-all duration-150 ${
    active ? activeClass : 'bg-white/70 dark:bg-white/5 border-transparent text-zinc-500 dark:text-zinc-400 hover:bg-white dark:hover:bg-white/10'}`;
  return (
    <button onClick={onClick} {...(tip ? { 'data-tip': tip } : {})} class={tip ? `tip ${cls}` : cls}>
      {icon}
      <span class={right ? 'text-xs text-left flex-1' : 'text-xs text-left'}>{label}</span>
      {right}
    </button>
  );
}

// Human phrasing for each endpoint act() posts to, only used to name what
// failed in the toast (postOrToast still appends the server's own reason).
// Matches the wording already used for the same action elsewhere (menu
// items, section buttons) instead of echoing the raw url path fragment.
const ACT_LABEL: Record<string, string> = {
  '/api/stop': 'Stop server',
  '/api/sync': 'Sync with staging',
  '/api/inngest/start': 'Start Inngest',
  '/api/inngest/stop': 'Stop Inngest',
  '/api/trigger/start': 'Start trigger.dev',
  '/api/trigger/stop': 'Stop trigger.dev',
  '/api/convex/start': 'Start Convex dev',
  '/api/convex/stop': 'Stop Convex dev',
  '/api/tunnel/enable': 'Enable tunnel',
  '/api/tunnel/disable': 'Disable tunnel',
};

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
  const [search, setSearch] = useState('');
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
  useEffect(() => { setPage(0); }, [search]);
  useEffect(() => { localStorage.setItem('setu-view', view); }, [view]);
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const toastId = useRef(0);
  const [createOpen, setCreateOpen] = useState(false);
  // Set by the Archived view's Recreate button: carries the repo+branch to
  // prefill CreateModal with, distinct from createOpen (which opens it blank
  // via + Worktree) so both flows can share the one modal.
  const [recreatePrefill, setRecreatePrefill] = useState<{ repo: string; name: string } | null>(null);
  const [addProjectOpen, setAddProjectOpen] = useState(false);
  const [logView, setLogView] = useState<{ repo: string; name: string; type: string } | null>(null);
  const [commandOpen, setCommandOpen] = useState(false);
  // Repo the "Browse PRs" sidebar button opened, or null when closed. Set
  // from the sidebar filter's currently-selected repo, not a separate
  // picker -- this view is always scoped to whichever repo is filtered to.
  const [prsRepo, setPrsRepo] = useState<string | null>(null);
  const pendingStart = useRef(new Set<string>());

  // Same one-handler-sets-both-states shape as ArchivedPage's onRecreate
  // below: closing RepoPrsModal and setting recreatePrefill happen in the
  // same synchronous click handler, so Preact batches them into one commit
  // and there's never a frame with both modals mounted.
  const onCreateFromPr = (repo: string, branch: string) => {
    setPrsRepo(null);
    setRecreatePrefill({ repo, name: branch });
  };

  // Lightweight — just a status dot for the sidebar's quick-access entry
  // point. The actual controls (start/stop, live log) live in Settings'
  // RaycastSection; duplicating that whole surface into a w-52 sidebar
  // isn't proportionate, a status-aware link to it is.
  const [raycastRunning, setRaycastRunning] = useState(false);
  useEffect(() => {
    let alive = true;
    const check = () => fetch('/api/raycast/status').then(r => r.json())
      .then(s => { if (alive) setRaycastRunning(!!s?.running); }).catch(() => {});
    check();
    const t = setInterval(check, 10000);
    return () => { alive = false; clearInterval(t); };
  }, []);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); setCommandOpen(true); }
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  // Auto-tones off the '✗ ' prefix every failure call site already uses —
  // callers that want a specific tone (success, a heads-up) pass one explicitly.
  function toast(msg: string, tone: Tone = msg.startsWith('✗') ? 'red' : 'zinc') {
    const id = ++toastId.current;
    setToasts(ts => [...ts, { id, msg, tone }]);
    setTimeout(() => setToasts(ts => ts.filter(t => t.id !== id)), 5000);
  }
  const dismissToast = (id: number) => setToasts(ts => ts.filter(t => t.id !== id));

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

  useEffect(() => {
    loadProjects();
    loadAgents();
    refresh(); // initial hydration -- fills the page before the WS handshake completes
  }, [refresh, loadProjects, loadAgents]);

  // Live worktree list + status, pushed by the server over WS -- replaces
  // the old poll loop. The server auto-subscribes every connection to
  // 'worktrees' the moment it opens, so this just registers the handler.
  useEffect(() => {
    const ws = getWs();
    const onMessage = (data: { worktrees: Worktree[]; status: Status | null }) => {
      const wts = data.worktrees ?? [];
      for (const w of wts) if (w.active) pendingStart.current.delete(w.key);
      setWorktrees(wts);
      setStatus(data.status ?? null);
      setLoaded(true);
    };
    ws.subscribe('worktrees', onMessage);
    return () => ws.unsubscribe('worktrees', onMessage);
  }, []);

  async function act(url: string, w: Worktree) {
    await postOrToast(url, { repo: w.repo, name: w.name }, toast, `${ACT_LABEL[url] ?? url.replace('/api/', '')} failed`);
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
    await postOrToast('/api/open', { repo: w.repo, name: w.name, tool }, toast, 'open failed');
  }

  async function start(w: Worktree, force?: 'container' | 'bare') {
    pendingStart.current.add(w.key);
    setWorktrees([...worktrees]);
    const body: any = { repo: w.repo, name: w.name };
    if (force) body.container = force === 'container';
    const res = await postOrToast('/api/start', body, toast, 'start failed');
    if (!res?.ok) pendingStart.current.delete(w.key);
    // Dev server (and every already-approved sidecar) still started fine,
    // this is just telling the user one sidecar sat out and why.
    for (const name of res?.skippedSidecars ?? []) {
      toast(`✗ sidecar '${name}' needs approval before it will run. Approve it in Settings.`, 'amber');
    }
    refresh();
  }

  async function remove(w: Worktree, reason: 'manual' | 'merged' = 'manual') {
    if (!confirm(`Remove worktree "${w.name}"? The branch will not be deleted.`)) return;
    await postOrToast('/api/remove', { repo: w.repo, name: w.name, reason }, toast, 'remove failed');
    refresh();
  }

  // Fire-and-forget like start() above, minus the pendingStart bookkeeping:
  // a deploy doesn't gate the concurrency queue that pendingStart exists for.
  // The deploy's own deploying/url/error state comes back on the next
  // /api/worktrees poll (vercelDeploy/netlifyDeploy field), same as every
  // other ephemeral per-worktree field already surfaced that way. One
  // handler for both providers, posting to /api/<provider>/deploy, since
  // deployToVercel and deployToNetlify on the server take the same
  // (repo, name, target) shape.
  async function deploy(w: Worktree, provider: DeployProvider, target: string) {
    await postOrToast(`/api/${provider}/deploy`, { repo: w.repo, name: w.name, target }, toast, 'deploy failed');
    refresh();
  }

  // Same fire-and-forget shape as deploy() above -- convexDeploy's own
  // deploying/ok/error state comes back on the next /api/worktrees poll
  // (convexDeploy field), not a separate handler. Kept as its own function
  // rather than folded into deploy() above: convex's target is a fixed
  // 'preview' | 'production' union, not the free-text string vercel/netlify
  // accept for a custom target, so sharing one function would just widen the
  // type back out for no real benefit.
  async function convexDeploy(w: Worktree, target: 'preview' | 'production') {
    await postOrToast('/api/convex/deploy', { repo: w.repo, name: w.name, target }, toast, 'convex deploy failed');
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
  const needle = search.trim().toLowerCase();
  const sorted = (filter === 'all' ? worktrees : worktrees.filter(w => w.repo === filter))
    .filter(w => !onlyDirty || w.dirty > 0)
    .filter(w => !onlyAhead || w.ahead > 0)
    .filter(w => !needle || `${w.name} ${w.repo} ${w.label} ${w.domain}`.toLowerCase().includes(needle))
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
      <WorktreePage w={w} loaded={loaded} agents={agents} onAct={act} onStart={start} onDeploy={deploy} onConvexDeploy={convexDeploy}
        onOpenLogs={(repo, name, type) => setLogView({ repo, name, type })} onOpenTool={openTool} onRemove={remove} toast={toast} />
      {logView && <LogModal repo={logView.repo} name={logView.name} initialType={logView.type}
        extraTabs={worktrees.find(x => x.repo === logView.repo && x.name === logView.name)?.sidecars.map(s => s.name)}
        onClose={() => setLogView(null)} />}
      {commandOpen && <CommandBar worktrees={worktrees} onSelect={(w) => navigate(`/worktree/${w.repo}/${encodeURIComponent(w.name)}`)} onClose={() => setCommandOpen(false)} />}
      <ToastStack toasts={toasts} onDismiss={dismissToast} />
    </>;
  }

  if (route.page === 'settings') {
    return <>
      <SettingsPage toast={toast} />
      {commandOpen && <CommandBar worktrees={worktrees} onSelect={(w) => navigate(`/worktree/${w.repo}/${encodeURIComponent(w.name)}`)} onClose={() => setCommandOpen(false)} />}
      <ToastStack toasts={toasts} onDismiss={dismissToast} />
    </>;
  }

  if (route.page === 'help') {
    return <>
      <HelpPage onBack={() => navigate('/')} />
      {commandOpen && <CommandBar worktrees={worktrees} onSelect={(w) => navigate(`/worktree/${w.repo}/${encodeURIComponent(w.name)}`)} onClose={() => setCommandOpen(false)} />}
      <ToastStack toasts={toasts} onDismiss={dismissToast} />
    </>;
  }

  if (route.page === 'ports') {
    return <>
      <PortsPage onBack={() => navigate('/')} />
      {commandOpen && <CommandBar worktrees={worktrees} onSelect={(w) => navigate(`/worktree/${w.repo}/${encodeURIComponent(w.name)}`)} onClose={() => setCommandOpen(false)} />}
      <ToastStack toasts={toasts} onDismiss={dismissToast} />
    </>;
  }

  if (route.page === 'archived') {
    // Recreate hands off to the list page's own CreateModal (prefilled)
    // rather than duplicating the create flow here, so navigate there first
    // to make sure it's actually visible.
    const onRecreate = (a: ArchivedWorktree) => {
      setRecreatePrefill({ repo: a.repo, name: a.branch || a.name });
      navigate('/');
    };
    return <>
      <ArchivedPage onBack={() => navigate('/')} onRecreate={onRecreate} />
      {commandOpen && <CommandBar worktrees={worktrees} onSelect={(w) => navigate(`/worktree/${w.repo}/${encodeURIComponent(w.name)}`)} onClose={() => setCommandOpen(false)} />}
      <ToastStack toasts={toasts} onDismiss={dismissToast} />
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
        } subtitle={
          <p class="text-xs text-zinc-400 dark:text-zinc-500 max-w-xl">
            Parallel branches, dedicated dev servers, sidecars, and synced environments. One bridge for every feature an agent is building at once.
          </p>
        } actions={<>
          <SecondaryButton compact onClick={() => setAddProjectOpen(true)}>+ Project</SecondaryButton>
          <PrimaryButton compact onClick={() => setCreateOpen(true)}>+ Worktree</PrimaryButton>
        </>} />

      <div class="rail-divider mb-8" />

      {running.length > 0 && (
        <div class="mb-8">
          <h2 class="board-mono text-[11px] font-bold text-zinc-400 mb-3">
            Now running <span class="text-zinc-300">({running.length})</span>
          </h2>
          <WorktreeList items={running} gridMode={view === 'grid'} onAct={act} onStart={start} onDeploy={deploy} onRemove={remove}
            toast={toast} onOpenLogs={(repo, name, type) => setLogView({ repo, name, type })}
            onOpenTool={openTool} pendingStart={pendingStart.current} agents={agents} />
          <div class="rail-divider mt-8 mb-8" />
        </div>
      )}

      {running.length > 0 && rest.length > 0 && (
        <h2 class="board-mono text-[11px] font-bold text-zinc-400 mb-3">All worktrees</h2>
      )}
      {/* Live substring filter over the currently visible/paginated list
          (name/repo/label/domain) — narrows what's already on this page.
          CommandBar (still reachable via Cmd K, no header button anymore) is
          a different tool: it searches every registered worktree, including
          ones on other pages, and jumps straight to one. Two different jobs,
          not a duplicate of each other. */}
      <div class="relative mb-4">
        <svg class="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-zinc-300 dark:text-zinc-600 pointer-events-none" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" viewBox="0 0 24 24"><path d="M3 10a7 7 0 1 0 14 0a7 7 0 1 0 -14 0" /><path d="M21 21l-6 -6" /></svg>
        <input value={search} onInput={(e: any) => setSearch(e.target.value)}
          placeholder="Search worktrees by name, repo, or label…" autocomplete="off"
          class="w-full text-sm bg-white/60 dark:bg-white/5 backdrop-blur-md border border-white/75 dark:border-white/10 shadow-sm rounded-none pl-9 pr-3 py-2.5 text-zinc-800 dark:text-zinc-100 placeholder-zinc-400 focus:outline-none focus:border-zinc-400 dark:focus:border-zinc-500 transition-colors duration-150" />
      </div>
      <WorktreeList items={filtered} gridMode={view === 'grid'} onAct={act} onStart={start} onDeploy={deploy} onRemove={remove}
        toast={toast} onOpenLogs={(repo, name, type) => setLogView({ repo, name, type })}
        onOpenTool={openTool} pendingStart={pendingStart.current} agents={agents}
        emptyMessage={rest.length ? 'No worktrees on this page.' :
          (onlyDirty || onlyAhead || needle) ? 'No worktrees match the active filters.' :
          running.length ? '' :
          `No worktrees${filter !== 'all' ? ' for this project' : ''}. Click + Worktree to create one.`} />

      <Pagination page={page} pageCount={pageCount} onPage={setPage} />

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

      <div class="w-52 shrink-0 sticky top-28 z-20 flex flex-col gap-4">
      <div class="flex flex-col gap-1 backdrop-blur-md bg-white/70 dark:bg-white/10 border border-white/75 dark:border-white/10 shadow-lg rounded-none p-2">
        <select value={filter} onChange={(e: any) => setFilter(e.target.value)}
          class="bg-white/70 dark:bg-white/5 border border-zinc-200 dark:border-white/10 text-zinc-700 dark:text-zinc-300 text-xs rounded-none px-2 py-2 mb-1 focus:outline-none focus:border-zinc-400 transition-colors duration-150">
          <option value="all">All projects</option>
          {projects.map(p => <option key={p.name} value={p.name}>{p.label}</option>)}
        </select>
        {filter !== 'all' && projects.find(p => p.name === filter)?.github && (
          <SidebarButton onClick={() => setPrsRepo(filter)}
            icon={<svg class="w-4 h-4 shrink-0" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" viewBox="0 0 24 24">
              <circle cx="6" cy="6" r="2.5" /><circle cx="18" cy="6" r="2.5" /><circle cx="6" cy="18" r="2.5" />
              <path d="M6 8.5v7" /><path d="M18 8.5a8 8 0 0 1 -8 8" />
            </svg>}
            label="Browse PRs" />
        )}
        <select value={sortKey} onChange={(e: any) => setSortKey(e.target.value)}
          class="bg-white/70 dark:bg-white/5 border border-zinc-200 dark:border-white/10 text-zinc-700 dark:text-zinc-300 text-xs rounded-none px-2 py-2 mb-1 focus:outline-none focus:border-zinc-400 transition-colors duration-150">
          <option value="recent">Recently active</option>
          <option value="name">Name</option>
          <option value="created">Created</option>
        </select>
        <div class="h-px bg-zinc-200 dark:bg-white/10 my-1" />
        <SidebarButton onClick={() => setOnlyDirty(!onlyDirty)} active={onlyDirty} activeClass="bg-signal-amber border-signal-amber text-white"
          icon={<svg class="w-4 h-4 shrink-0" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" viewBox="0 0 24 24"><path d="M3 12a9 9 0 1 0 18 0a9 9 0 1 0 -18 0" /></svg>}
          label="Uncommitted changes" />
        <SidebarButton onClick={() => setOnlyAhead(!onlyAhead)} active={onlyAhead} activeClass="bg-signal-green border-signal-green text-white"
          icon={<svg class="w-4 h-4 shrink-0" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" viewBox="0 0 24 24"><path d="M12 5l0 14" /><path d="M18 11l-6 -6" /><path d="M6 11l6 -6" /></svg>}
          label="Ahead of base" />
        <div class="h-px bg-zinc-200 dark:bg-white/10 my-1" />
        {(['list', 'grid'] as const).map(v => (
          <button key={v} onClick={() => setView(v)}
            class={`flex items-center gap-2.5 h-9 px-2 rounded-none border transition-all duration-150 ${
              view === v ? 'bg-accent border-accent text-white' : 'bg-white/70 dark:bg-white/5 border-transparent text-zinc-500 dark:text-zinc-400 hover:bg-white dark:hover:bg-white/10'}`}>
            {v === 'list'
              ? <svg class="w-4 h-4 shrink-0" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" viewBox="0 0 24 24"><path d="M4 6l16 0" /><path d="M4 12l16 0" /><path d="M4 18l16 0" /></svg>
              : <svg class="w-4 h-4 shrink-0" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" viewBox="0 0 24 24"><path d="M4 5a1 1 0 0 1 1 -1h4a1 1 0 0 1 1 1v4a1 1 0 0 1 -1 1h-4a1 1 0 0 1 -1 -1l0 -4" /><path d="M14 5a1 1 0 0 1 1 -1h4a1 1 0 0 1 1 1v4a1 1 0 0 1 -1 1h-4a1 1 0 0 1 -1 -1l0 -4" /><path d="M4 15a1 1 0 0 1 1 -1h4a1 1 0 0 1 1 1v4a1 1 0 0 1 -1 1h-4a1 1 0 0 1 -1 -1l0 -4" /><path d="M14 15a1 1 0 0 1 1 -1h4a1 1 0 0 1 1 1v4a1 1 0 0 1 -1 1h-4a1 1 0 0 1 -1 -1l0 -4" /></svg>}
            <span class="text-xs text-left">{v === 'list' ? 'List view' : 'Grid view'}</span>
          </button>
        ))}
        <div class="h-px bg-zinc-200 dark:bg-white/10 my-1" />
        <SidebarButton onClick={() => setDark(!dark)} label={dark ? 'Light mode' : 'Dark mode'}
          icon={dark
            ? <svg class="w-4 h-4 shrink-0" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" viewBox="0 0 24 24"><path d="M8 12a4 4 0 1 0 8 0a4 4 0 1 0 -8 0" /><path d="M3 12h1m8 -9v1m8 8h1m-9 8v1m-6.4 -15.4l.7 .7m12.1 -.7l-.7 .7m0 11.4l.7 .7m-12.1 -.7l-.7 .7" /></svg>
            : <svg class="w-4 h-4 shrink-0" fill="currentColor" viewBox="0 0 24 24"><path d="M12 1.992a10 10 0 1 0 9.236 13.838c.341 -.82 -.476 -1.644 -1.298 -1.31a6.5 6.5 0 0 1 -6.864 -10.787l.077 -.08c.551 -.63 .113 -1.653 -.758 -1.653h-.266l-.068 -.006l-.06 -.002z" /></svg>} />
        <SidebarButton onClick={() => navigate('/ports')} label="Active ports"
          icon={<svg class="w-4 h-4 shrink-0" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" viewBox="0 0 24 24"><path d="M9.785 6l8.215 8.215l-2.054 2.054a5.81 5.81 0 1 1 -8.215 -8.215l2.054 -2.054" /><path d="M4 20l3.5 -3.5" /><path d="M15 4l-3.5 3.5" /><path d="M20 9l-3.5 3.5" /></svg>} />
        <SidebarButton onClick={() => navigate('/archived')} label="Archived"
          icon={<svg class="w-4 h-4 shrink-0" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" viewBox="0 0 24 24"><path d="M3 6a2 2 0 0 1 2 -2h14a2 2 0 0 1 2 2a2 2 0 0 1 -2 2h-14a2 2 0 0 1 -2 -2" /><path d="M5 8v10a2 2 0 0 0 2 2h10a2 2 0 0 0 2 -2v-10" /><path d="M10 12l4 0" /></svg>} />
        <SidebarButton onClick={() => navigate('/settings')} label="Settings"
          icon={<svg class="w-4 h-4 shrink-0" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" viewBox="0 0 24 24"><path d="M10.325 4.317c.426 -1.756 2.924 -1.756 3.35 0a1.724 1.724 0 0 0 2.573 1.066c1.543 -.94 3.31 .826 2.37 2.37a1.724 1.724 0 0 0 1.065 2.572c1.756 .426 1.756 2.924 0 3.35a1.724 1.724 0 0 0 -1.066 2.573c.94 1.543 -.826 3.31 -2.37 2.37a1.724 1.724 0 0 0 -2.572 1.065c-.426 1.756 -2.924 1.756 -3.35 0a1.724 1.724 0 0 0 -2.573 -1.066c-1.543 .94 -3.31 -.826 -2.37 -2.37a1.724 1.724 0 0 0 -1.065 -2.572c-1.756 -.426 -1.756 -2.924 0 -3.35a1.724 1.724 0 0 0 1.066 -2.573c-.94 -1.543 .826 -3.31 2.37 -2.37c1 .608 2.296 .07 2.572 -1.065" /><path d="M9 12a3 3 0 1 0 6 0a3 3 0 0 0 -6 0" /></svg>} />
        <SidebarButton onClick={() => navigate('/settings')} label="Raycast"
          tip={raycastRunning ? 'Raycast dev mode is running' : 'Set up the Raycast extension'}
          icon={<StatusDot tone={raycastRunning ? 'emerald' : 'zinc'} />}
          right={<span class="text-[10px] text-zinc-400">{raycastRunning ? 'running' : 'set up'}</span>} />
      </div>

      <TriviaCard />
      </div>

      {(createOpen || recreatePrefill) && (
        <CreateModal projects={projects} initialRepo={recreatePrefill?.repo} initialName={recreatePrefill?.name}
          onClose={() => { setCreateOpen(false); setRecreatePrefill(null); }} onCreated={refresh} />
      )}
      {addProjectOpen && <AddProjectModal onClose={() => setAddProjectOpen(false)} onAdded={loadProjects} />}
      {logView && <LogModal repo={logView.repo} name={logView.name} initialType={logView.type}
        extraTabs={worktrees.find(x => x.repo === logView.repo && x.name === logView.name)?.sidecars.map(s => s.name)}
        onClose={() => setLogView(null)} />}
      {commandOpen && <CommandBar worktrees={worktrees} onSelect={(w) => navigate(`/worktree/${w.repo}/${encodeURIComponent(w.name)}`)} onClose={() => setCommandOpen(false)} />}
      {prsRepo && (
        <RepoPrsModal repo={prsRepo} label={projects.find(p => p.name === prsRepo)?.label ?? prsRepo}
          worktrees={worktrees} loaded={loaded} onClose={() => setPrsRepo(null)}
          onOpenWorktree={(name) => { setPrsRepo(null); navigate(`/worktree/${prsRepo}/${encodeURIComponent(name)}`); }}
          onCreateFromPr={onCreateFromPr} />
      )}
      <ToastStack toasts={toasts} onDismiss={dismissToast} />
    </div>
  );
}

render(<App />, document.getElementById('root')!);
