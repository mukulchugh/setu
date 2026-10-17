// setu portal UI — Preact, bundled by Bun.serve at runtime (see portal.js)

import { Menu as MenuPrimitive } from '@base-ui/react/menu';
import { type JSX, render } from 'preact';
import { memo } from 'preact/compat';
import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from 'preact/hooks';
import { post, postOrToast } from './api';
import { ArchivedPage } from './components/archived-page';
import { CommandBar } from './components/command-bar';
import { CostsPage } from './components/costs-page';
import { DiffViewer } from './components/diff-viewer';
import { HelpPage } from './components/help-page';
import {
  ConvexIcon,
  MUKUL_LOGO_URI,
  NetlifyIcon,
  SidecarIcon,
  ToolIcon,
  tablerAlertTriangle,
  tablerClock,
  tablerDotsVerticalFilled,
  tablerExternalLink,
  tablerPlayerPlayFilled,
  tablerPlayerStopFilled,
  tablerRefresh,
  tablerSearch,
  VercelIcon,
} from './components/icons';
import { InventoryPage } from './components/inventory-page';
import { LiveLog, LogModal } from './components/logs';
import { Pagination } from './components/pagination';
import { PortsPage } from './components/ports-page';
import { checksTone, type PrChecks } from './components/pr-status';
import { RelativeTime, relativeTime } from './components/relative-time';
import {
  GithubWorkflowControls,
  PrReviewHandoff,
  WorktreeResourceControls,
} from './components/resource-controls';
import {
  DiscoverProjectsSection,
  McpSection,
  RaycastSection,
} from './components/settings-sections';
import { SpansPage } from './components/spans-page';
import { TriviaCard } from './components/trivia-card';
import { WorkspaceSidebar } from './components/workspace-sidebar';
import {
  createDeploymentIntent,
  type DeploymentIntent,
  type DeploymentIntentState,
  type DeploymentPreflight,
} from './deploy-intent';
import {
  acceptHostStorage,
  formatStorageBytes,
  type HostHealthObservation,
  hostStorageView,
  initialHostStorageRead,
} from './host-storage';
import {
  createResourceDraft,
  type ResourceDraft,
  type ResourceField,
} from './settings-draft';
import type { ConnectionState } from './socket-client';
import { inputCls, PageHeader, Section } from './ui';
// PageHeader/Section/inputCls stay on the old hand-rolled kit -- no shadcn
// equivalent needed, ui.tsx keeps exporting them untouched. Everything else
// below now comes from portal/ui/* (Base UI-backed): Badge/StatusDot/
// StatusFlap keep their exact old names and prop shapes (only the import
// path moved); PrimaryButton/SecondaryButton collapse into one Button with a
// variant prop; Modal/CloseBtn become a Dialog composition; Menu/MenuItem
// become a DropdownMenu composition (see the per-call-site conversions
// below for both). CloseIcon has no new-kit export -- it's a bare two-stroke
// X glyph, not a "primitive" with a shadcn equivalent -- so it's declared
// locally in this file instead of imported (matches how portal/ui/dialog.tsx
// inlines its own copy of the same glyph rather than importing ui.tsx's).
import { Badge, StatusDot, StatusFlap, type Tone } from './ui/badge';
import { Button, IconButton } from './ui/button';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from './ui/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from './ui/dropdown-menu';
import { type ToastItem, ToastStack } from './ui/toast';
import {
  fileSyncPatterns,
  quoteShellPath,
  sidecarArguments,
  sidecarNameError,
} from './ui-helpers';
import { useSavedDraft } from './use-saved-draft';
import { readArray, readJson, useVisiblePoll } from './use-visible-poll';
import {
  lifecycleControl,
  projectWorktrees,
  reuseWorktreeRows,
  STOPPED_PAGE_SIZE,
  type WorktreeListRow,
  worktreeIssue,
  worktreeState,
} from './worktree-list';
import { getWs } from './ws';

// Same X-mark path as the old ui.tsx's CloseIcon (and portal/ui/dialog.tsx's
// own inlined copy of it) -- a plain two-stroke glyph, not a sourced brand
// mark, so there's no reason to import it from the file this migration is
// replacing. Used by CreateModal/AddProjectModal's DialogClose button and by
// SidecarRow/CustomAgentRow's "remove" IconButton.
function CloseIcon({ class: cls = 'w-4 h-4' }: { class?: string }) {
  return (
    <svg
      aria-hidden="true"
      class={cls}
      fill="none"
      stroke="currentColor"
      stroke-linecap="round"
      stroke-linejoin="round"
      stroke-width="2"
      viewBox="0 0 24 24"
    >
      <path d="M18 6l-12 12" />
      <path d="M6 6l12 12" />
    </svg>
  );
}

// Shared shape for both deploy providers below (vercelDeploy/netlifyDeploy) --
// same fields either one's status Map on the server settles into.
export type DeployStatus = {
  deploying: boolean;
  phase?: string;
  url: string | null;
  error: string | null;
  target: string;
  startedAt: number;
} | null;
export type DeployProvider = 'vercel' | 'netlify';

// Convex's deploy state isn't shaped like DeployStatus above: a convex
// deploy never produces a clickable URL the way vercel/netlify do, so
// "succeeded" needs its own explicit signal (ok) rather than being inferred
// from a url field that would just always be null.
export type ConvexDeployStatus = {
  deploying: boolean;
  phase?: string;
  ok: boolean;
  error: string | null;
  target: string;
  startedAt: number;
} | null;

// A live agent run in this worktree. phase 'done'/'failed' persists after the
// run ends so the row still says what happened -- it clears when a new run
// starts, or when the portal restarts (these records aren't durable yet).
export interface AgentRun {
  agentId: string;
  error: string | null;
  iteration: number;
  maxIterations: number;
  phase: 'running' | 'done' | 'failed';
  startedAt: number;
  tool: string | null;
}
export type AgentRunStatus = AgentRun | null;

function agentTone(a: AgentRun): Tone {
  if (a.phase === 'failed') {
    return 'red';
  }
  if (a.phase === 'running') {
    return 'emerald';
  }
  return 'zinc';
}

// Says what the agent is doing *right now* rather than restating the badge --
// the badge is the glance, the tip is the answer to "and then what".
function agentTip(a: AgentRun): string {
  if (a.error) {
    return `Agent run failed: ${a.error}`;
  }
  if (a.phase === 'running') {
    return a.tool
      ? `${a.agentId} is running — currently ${a.tool}. Open the worktree for the live transcript.`
      : `${a.agentId} is running. Open the worktree for the live transcript.`;
  }
  return `${a.agentId} finished. Check the diff for what changed.`;
}

// Precomputed so the JSX stays a flat list of expressions -- a chained
// `a && b && string` reads as a logic bug to both linters and humans.
function agentChipText(a: AgentRun): string {
  const spin = a.phase === 'running' ? '⚙ ' : '';
  const iter = a.maxIterations > 1 ? ` ${a.iteration}/${a.maxIterations}` : '';
  const tool = a.phase === 'running' && a.tool ? ` · ${a.tool}` : '';
  return `${spin}${a.agentId}${iter}${tool}`;
}

export interface Worktree {
  active: boolean;
  agent: AgentRunStatus;
  ahead: number;
  behind: number;
  branch: string;
  branchUrl: string | null;
  container: string | null;
  convexActive: boolean;
  // convexConfigured gates whether any Convex UI renders at all -- unlike
  // Inngest/Trigger (assumed available everywhere), Convex only applies to
  // worktrees that actually have it set up.
  convexConfigured: boolean;
  convexDeploy: ConvexDeployStatus;
  createdAt: number | null;
  dirty: number | null;
  domain: string;
  inngestActive: boolean;
  inngestPort: number;
  key: string;
  label: string;
  lastCommitAt: number | null;
  lifecycleError?: WorktreeListRow['lifecycleError'];
  memMb: number | null | undefined;
  name: string;
  needsMigrationPrompt: boolean;
  netlifyDeploy: DeployStatus;
  nextStartMode: 'container' | 'bare';
  operation?: WorktreeListRow['operation'];
  phase?: WorktreeListRow['phase'];
  port: number;
  pr: {
    url: string;
    number: number;
    title: string;
    state: PrState;
    checks: PrChecks;
  } | null;
  pubDomain: string;
  queued?: boolean;
  queuePosition?: number | null;
  queueReason?: 'concurrency' | 'container-capacity' | null;
  repo: string;
  sidecars: { name: string; active: boolean }[];
  slug: string;
  starting?: boolean;
  stopping?: boolean;
  triggerActive: boolean;
  tunnelOn: boolean;
  tunnelRunning: boolean;
  vercelDeploy: DeployStatus;
  wtDir?: string;
}
type PrState = 'open' | 'merged' | 'closed' | 'draft';
// One record per removed worktree, a history entry, not a live worktree.
// The directory itself is gone by the time this exists; branch is what
// Recreate re-checks-out, not something that can be restored to.
export interface ArchivedWorktree {
  branch: string;
  label: string;
  name: string;
  prUrl: string | null;
  reason: 'manual' | 'merged';
  removedAt: number;
  repo: string;
}
interface Project {
  github?: string | null;
  label: string;
  name: string;
}
// approved is server-computed (current command+args matched against the last
// approved value), not something a caller sets, present once fetched from GET.
interface Sidecar {
  approved?: boolean;
  args?: string[];
  argsText?: string;
  command: string;
  enabled?: boolean;
  env?: Record<string, string>;
  name: string;
}
interface CustomAgent {
  command: string;
  id: string;
  label: string;
}
interface SettingsData {
  containerCpuLimit: number;
  containerMemoryLimit: string;
  docker: { cpus: number | null; memMb: number | null | undefined };
  mac: { cpus: number | null; memMb: number | null | undefined };
  maxConcurrentDevServers: number;
}
interface Status {
  concurrency: { active: number; max: number; queued: number };
  container: {
    engineAvailable: boolean;
    engine: string | null;
    memoryLimit: string;
    cpuLimit: number;
    maxConcurrent: number;
  };
  hostHealth?: HostHealthObservation;
  pendingRemovals?: PendingRemoval[];
}
interface PendingRemoval {
  error?: string;
  name: string;
  operationId: string;
  pendingSteps: string[];
  removed: boolean;
  repo: string;
}

// Minimal router — one detail view alongside the existing list/grid doesn't
// justify a router dependency; history.pushState + popstate is the native
// platform feature that already does exactly this.
type Route =
  | { page: 'list' }
  | { page: 'detail'; repo: string; name: string }
  | { page: 'repo'; repo: string }
  | { page: 'settings' }
  | { page: 'help' }
  | { page: 'ports' }
  | { page: 'archived' }
  | { page: 'inventory' }
  | { page: 'costs' }
  | { page: 'spans'; runId?: string };

const WORKTREE_ROUTE_PATTERN = /^\/worktree\/([^/]+)\/(.+)$/;
const REPOSITORY_ROUTE_PATTERN = /^\/repo\/([^/]+)$/;
const BRANCH_TREE_PATH_PATTERN = /\/tree\/.*$/;

function parseRoute(pathname: string): Route {
  if (pathname === '/spans') {
    return { page: 'spans' };
  }
  if (pathname.startsWith('/spans/')) {
    try {
      return { page: 'spans', runId: decodeURIComponent(pathname.slice(7)) };
    } catch {
      return { page: 'spans' };
    }
  }
  if (pathname === '/settings') {
    return { page: 'settings' };
  }
  if (pathname === '/help') {
    return { page: 'help' };
  }
  if (pathname === '/ports') {
    return { page: 'ports' };
  }
  if (pathname === '/archived') {
    return { page: 'archived' };
  }
  if (pathname === '/costs') {
    return { page: 'costs' };
  }
  if (pathname === '/inventory') {
    return { page: 'inventory' };
  }
  const wt = pathname.match(WORKTREE_ROUTE_PATTERN);
  if (wt) {
    return {
      name: decodeURIComponent(wt[2]),
      page: 'detail',
      repo: decodeURIComponent(wt[1]),
    };
  }
  const repo = pathname.match(REPOSITORY_ROUTE_PATTERN);
  if (repo) {
    return { page: 'repo', repo: decodeURIComponent(repo[1]) };
  }
  return { page: 'list' };
}

function followRoute(e: MouseEvent, path: string) {
  if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) {
    return;
  }
  e.preventDefault();
  navigate(path);
}

let navigationGuard: ((proceed: () => void) => boolean) | null = null;
let routeIndex = Number(history.state?.setuIndex ?? 0);
history.replaceState(
  { ...history.state, setuIndex: routeIndex },
  '',
  location.href
);
function navigate(path: string) {
  const proceed = () => {
    routeIndex += 1;
    history.pushState({ setuIndex: routeIndex }, '', path);
    window.dispatchEvent(
      new PopStateEvent('popstate', { state: history.state })
    );
  };
  if (!navigationGuard?.(proceed)) {
    proceed();
  }
}

function useRoute(): Route {
  const [route, setRoute] = useState<Route>(() =>
    parseRoute(location.pathname)
  );
  useEffect(() => {
    let restoring: (() => void) | null = null,
      allowNext = false;
    const onNav = () => {
      if (restoring) {
        const restored = restoring;
        restoring = null;
        restored();
        return;
      }
      const nextIndex = Number(history.state?.setuIndex ?? routeIndex);
      const delta = nextIndex - routeIndex;
      if (!allowNext && delta && navigationGuard) {
        const guard = navigationGuard;
        let resume: (() => void) | null = null;
        const intercepted = guard(() => {
          const go = () => {
            allowNext = true;
            history.go(delta);
          };
          if (restoring) {
            resume = go;
          } else {
            go();
          }
        });
        if (intercepted) {
          restoring = () => resume?.();
          history.go(-delta);
          return;
        }
      }
      allowNext = false;
      routeIndex = nextIndex;
      setRoute(parseRoute(location.pathname));
    };
    window.addEventListener('popstate', onNav);
    return () => window.removeEventListener('popstate', onNav);
  }, []);
  return route;
}

// Shared status derivation for WorktreeCard and WorktreePage — same
// active/queued/stopped tone and label logic, previously copy-pasted in both.
function worktreeStatus(w: Worktree): { tone: Tone; text: string } {
  const state = worktreeState(w);
  let text: string = state;
  if (state === 'attention') {
    text = 'needs attention';
  } else if (
    state === 'queued' &&
    w.queuePosition !== null &&
    w.queuePosition !== undefined
  ) {
    text = `queued #${w.queuePosition}`;
  }

  let tone: Tone = 'amber';
  if (state === 'attention') {
    tone = 'red';
  } else if (state === 'running') {
    tone = 'emerald';
  } else if (state === 'stopped') {
    tone = 'zinc';
  }
  return {
    text,
    tone,
  };
}

function queueWaitReason(w: Worktree): string | null {
  if (!w.queued) {
    return null;
  }
  if (w.queueReason === 'container-capacity') {
    return 'waiting for container capacity';
  }
  return 'waiting for a free server slot';
}

// Shared by WorktreeCard and WorktreePage, same deploying/error/url/idle
// tone and label logic, matching worktreeStatus's shape above. Provider-
// agnostic on purpose: vercelDeploy and netlifyDeploy are the same shape,
// so one function covers both instead of two copies that would only ever
// differ by which field they read.
function deployTone(d: DeployStatus): Tone {
  if (!d) {
    return 'zinc';
  }
  if (d.phase === 'unknown') {
    return 'red';
  }
  if (d.deploying) {
    return 'amber';
  }
  if (d.error) {
    return 'red';
  }
  if (d.url) {
    return 'emerald';
  }
  return 'zinc';
}
function deployStatusText(d: DeployStatus): string {
  if (!d) {
    return 'Not deployed';
  }
  if (d.phase === 'unknown') {
    return 'Deployment outcome not confirmed';
  }
  if (d.deploying) {
    return `Deploying (${d.target})…`;
  }
  if (d.error) {
    return 'Deploy failed';
  }
  if (d.url) {
    return `Deployed to ${d.target}`;
  }
  return 'Not deployed';
}

// Shared by WorktreeCard and WorktreePage, same shape as deployTone/
// deployStatusText above. zinc for open matches every other "default,
// nothing to flag" state in this file (container, → mode, etc.), merged is
// the one state that's actually actionable, so it gets the loud color.
function prTone(state: PrState): Tone {
  if (state === 'merged') {
    return 'emerald';
  }
  if (state === 'closed') {
    return 'red';
  }
  if (state === 'draft') {
    return 'amber';
  }
  return 'zinc';
}
// Card-compact PR link recolors itself by state, same recipe as the vercel
// deploying/deployed/failed items in the same row (signal-* text classes),
// not a Badge pill: this row is plain clickable references (branch/PR/
// tunnel), Badge lives in the summary-chip row above instead.
function prLinkClass(state: PrState): string {
  if (state === 'merged') {
    return 'text-signal-green hover:opacity-80';
  }
  if (state === 'closed') {
    return 'text-signal-red hover:opacity-80';
  }
  if (state === 'draft') {
    return 'text-signal-amber hover:opacity-80';
  }
  return 'hover:text-zinc-600';
}

// 8192MB is the amber warning threshold shared by WorktreeCard's badge and
// WorktreePage's metric — one source of truth for the number.
function memTone(mb: number): Tone {
  return mb > 8192 ? 'amber' : 'zinc';
}

// short=true gives the compact card-badge form (g/m), the default gives the
// spelled-out detail-page form (GB/MB) — same threshold, different label
// length for two different amounts of surrounding space.
function formatMem(mb: number, short = false): string {
  return mb >= 1024
    ? `${(mb / 1024).toFixed(1)}${short ? 'g' : 'GB'}`
    : `${Math.round(mb)}${short ? 'm' : 'MB'}`;
}

function dirtyStatus(dirty: number | null | undefined) {
  if (dirty === null || dirty === undefined) {
    return 'unknown';
  }
  if (dirty > 0) {
    return <span class="text-signal-amber">{dirty} files</span>;
  }
  return 'clean';
}

function repoActiveEmptyMessage(loaded: boolean) {
  return loaded ? 'No active worktrees in this project.' : 'Loading worktrees…';
}

function repoStoppedEmptyMessage(loaded: boolean, search: string) {
  if (!loaded) {
    return 'Loading worktrees…';
  }
  if (search) {
    return 'No stopped worktrees match this search.';
  }
  return 'No stopped worktrees in this project.';
}

function filteredStoppedEmptyMessage(loaded: boolean, hasFilters: boolean) {
  if (!loaded) {
    return 'Loading worktrees…';
  }
  if (hasFilters) {
    return 'No stopped worktrees match these filters.';
  }
  return 'No stopped worktrees. Create a worktree to begin.';
}

function deploymentDialogTitle(phase: string, production: boolean) {
  if (phase === 'reading') {
    return 'Checking deployment target…';
  }
  if (production) {
    return 'Deploy to production?';
  }
  return 'Review deployment target';
}

function deploymentRefreshLabel(phase: string) {
  return phase === 'uncertain'
    ? 'Refresh deployment status'
    : 'Refresh target context';
}

function prReadyActionLabel(busy: 'create' | 'ready' | null, state: string) {
  if (busy === 'ready') {
    return 'Updating…';
  }
  return state === 'draft' ? 'Mark ready for review' : 'Convert to draft';
}

function projectSubmitValues(
  tab: 'existing' | 'new',
  github: string,
  name: string
) {
  if (tab === 'new') {
    const trimmedName = name.trim();
    return { github: '', invalid: !trimmedName, name: trimmedName };
  }
  const trimmedGithub = github.trim();
  return { github: trimmedGithub, invalid: !trimmedGithub, name: '' };
}

function projectInputError(tab: 'existing' | 'new') {
  return tab === 'existing'
    ? 'Enter a GitHub URL or organization/repository.'
    : 'Enter a repo name.';
}

function projectSubmittingStatus(tab: 'existing' | 'new') {
  return tab === 'existing' ? 'Cloning repo…' : 'Initializing repo…';
}

function deploymentActionLabel(
  phase: string,
  production: boolean | undefined,
  context: DeploymentIntentState['context'],
  intent: DeploymentIntent
) {
  if (phase === 'submitting') {
    return 'Submitting…';
  }
  if (production) {
    return 'Deploy to production';
  }
  return `Deploy ${context?.destination.environment ?? intent.target}`;
}

// Same "cd into this worktree" string used by both the card's copy button and
// the detail page's "Copy cd command" action.
function cdCommand(w: Worktree): string {
  // A quoted tilde is not expanded by the shell, so quote only what follows it.
  return w.wtDir
    ? `cd ${quoteShellPath(w.wtDir)}`
    : `cd ~/workspace/${quoteShellPath(`${w.repo}/${w.name}`)}`;
}

// initialRepo/initialName prefill the Recreate flow from an archived
// worktree's record (same repo+branch, a fresh checkout). The plain
// + Worktree button omits both and falls back to the first project / blank.
function CreateModal({
  projects,
  worktrees,
  initialRepo,
  initialName,
  onClose,
  onCreated,
}: {
  projects: Project[];
  worktrees: Worktree[];
  initialRepo?: string;
  initialName?: string;
  onClose: () => void;
  onCreated: () => void;
}) {
  // biome-ignore lint/suspicious/noUnnecessaryConditions: Project transport data can be empty or omit the first name; retain the empty-string fallback.
  const [repo, setRepo] = useState(initialRepo ?? projects[0]?.name ?? '');
  const [name, setName] = useState(initialName ?? '');
  const [tunnel, setTunnel] = useState(false);
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);
  const [uncertain, setUncertain] = useState(false);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (closeTimer.current !== null) {
        clearTimeout(closeTimer.current);
      }
    },
    []
  );
  // Real regression, not a style nicety: DialogContent's Popup moves focus
  // to the first tabbable element on open (Base UI's own default), and the
  // header row's DialogClose renders before this input in DOM order -- so
  // without this, focus silently lands on the close X instead (Enter/Space
  // there closes the dialog instead of submitting). The old bare `autoFocus`
  // attribute on the input no longer wins against Base UI's own focus
  // management; `initialFocus` (a DialogPopup prop, threaded through
  // DialogContent's ...props) is the real replacement.
  const nameInputRef = useRef<HTMLInputElement>(null);

  async function create() {
    if (busy || uncertain) {
      return;
    }
    if (!(projects.length && repo)) {
      setStatus('Add a project before creating a worktree.');
      return;
    }
    if (!name.trim()) {
      setStatus('Enter a branch name.');
      nameInputRef.current?.focus();
      return;
    }
    const owner = tunnel ? worktrees.find((w) => w.tunnelOn) : undefined;
    if (
      owner &&
      // biome-ignore lint/suspicious/noAlert: This confirmation gates the tunnel-moving create request below.
      !confirm(
        `Move the public tunnel from ${owner.repo}/${owner.name} to this new worktree? Both dev servers will restart.`
      )
    ) {
      return;
    }
    setBusy(true);
    setStatus('Setting up worktree and running bun install in background…');
    const res = await post('/api/create', { name: name.trim(), repo, tunnel });
    if (res.ok) {
      setStatus(`✓ Created on port ${res.port}`);
      onCreated();
      closeTimer.current = setTimeout(onClose, 1200);
    } else {
      setStatus(`✗ ${res.error ?? 'failed'}`);
      setUncertain(!!res.networkUncertain || !!res.committed);
      setBusy(false);
    }
  }

  return (
    // Root's `open` stays a literal `true` -- this component is only ever
    // mounted while open (App's `{(createOpen || recreatePrefill) &&
    // <CreateModal .../>}`), same conditional-mount pattern the old Modal
    // used, so there's no separate "closed but still mounted" state to
    // control here. onOpenChange fires for every Root-owned close path
    // (Escape, outside-press, DialogClose below) and just delegates to the
    // same onClose the old backdrop-click handler used to call directly.
    <Dialog
      onOpenChange={(o: boolean) => {
        if (!(o || busy)) {
          onClose();
        }
      }}
      open
    >
      {/* DialogContent already carries the old wrapper div's exact panel
          skin (bg-white/90 dark:bg-zinc-900/70 backdrop-blur-xl rounded-none
          border-zinc-200 dark:border-zinc-800 shadow-2xl p-6, max-w-sm) --
          see portal/ui/dialog.tsx's panelBase/panelPosition.center -- so
          that wrapper div itself is gone, not just its Modal parent. */}
      <DialogContent initialFocus={nameInputRef}>
        <div class="mb-5 flex items-center justify-between">
          <DialogTitle class="font-semibold text-base text-zinc-900 dark:text-zinc-100">
            New worktree
          </DialogTitle>
          <DialogClose
            aria-label="Close dialog"
            class="flex h-7 w-7 items-center justify-center rounded-lg text-zinc-400 transition-colors duration-200 hover:bg-zinc-100 hover:text-zinc-600"
            disabled={busy}
          >
            <CloseIcon />
          </DialogClose>
        </div>
        <div class="flex flex-col gap-4">
          {!projects.length && (
            <p class="text-sm">
              Add a project in{' '}
              <a
                class="underline"
                href="/settings"
                onClick={(e) => {
                  followRoute(e, '/settings');
                  onClose();
                }}
              >
                Settings
              </a>{' '}
              before creating a worktree.
            </p>
          )}
          <div class="flex flex-col gap-1.5">
            <label class="text-xs text-zinc-500" for="create-repo">
              Repo
            </label>
            <select
              class={inputCls}
              disabled={busy || uncertain}
              id="create-repo"
              onChange={(e) => setRepo(e.currentTarget.value)}
              value={repo}
            >
              {projects.map((p: Project) => (
                <option key={p.name} value={p.name}>
                  {p.label}
                </option>
              ))}
            </select>
          </div>
          <div class="flex flex-col gap-1.5">
            <label class="text-xs text-zinc-500" for="create-name">
              Branch name
            </label>
            <input
              autocomplete="off"
              class={inputCls}
              disabled={busy || uncertain}
              id="create-name"
              onInput={(e) => setName(e.currentTarget.value)}
              onKeyDown={(e: KeyboardEvent) => {
                if (e.key === 'Enter' && !e.isComposing) {
                  e.preventDefault();
                  create();
                }
              }}
              placeholder="feat-my-feature"
              ref={nameInputRef}
              value={name}
            />
          </div>
          <div class="flex items-center gap-2">
            <input
              checked={tunnel}
              class="accent-sky-500"
              disabled={busy || uncertain}
              id="create-tunnel"
              onChange={(e) => setTunnel(e.currentTarget.checked)}
              type="checkbox"
            />
            <label class="text-xs text-zinc-500" for="create-tunnel">
              Enable public tunnel
            </label>
            <a
              class="text-xs underline"
              href="/help#tunnel"
              rel="noopener"
              target="_blank"
            >
              About sharing
            </a>
          </div>
          {status && (
            <p class="text-xs text-zinc-500" role="status">
              {status}
            </p>
          )}
          {uncertain && (
            <Button
              onClick={() => {
                onCreated();
                onClose();
              }}
              variant="secondary"
            >
              Refresh and review worktrees
            </Button>
          )}
          <div class="flex gap-3 pt-1">
            <Button
              class="flex-1"
              disabled={busy}
              onClick={onClose}
              variant="secondary"
            >
              Cancel
            </Button>
            <Button
              class="flex-1"
              disabled={busy || uncertain || !projects.length}
              onClick={create}
              variant="primary"
            >
              {busy ? 'Creating…' : 'Create'}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function AddProjectModal({
  onClose,
  onAdded,
}: {
  onClose: () => void;
  onAdded: () => void;
}) {
  const [tab, setTab] = useState<'existing' | 'new'>('existing');
  const [github, setGithub] = useState('');
  const [newName, setNewName] = useState('');
  const [label, setLabel] = useState('');
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);
  const [uncertain, setUncertain] = useState(false);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (closeTimer.current !== null) {
        clearTimeout(closeTimer.current);
      }
    },
    []
  );
  // Same real regression as CreateModal's nameInputRef above -- see its
  // comment. One shared ref (not one per tab) because only one of the two
  // tab inputs below is ever actually mounted at a time (the tab === 'new'
  // ? ... : ... ternary), so there's never a collision; whichever one is
  // showing when the dialog opens is the one Base UI focuses.
  const tabInputRef = useRef<HTMLInputElement>(null);

  async function submit() {
    if (busy || uncertain) {
      return;
    }
    const {
      github: gh,
      invalid,
      name,
    } = projectSubmitValues(tab, github, newName);
    if (invalid) {
      setStatus(projectInputError(tab));
      tabInputRef.current?.focus();
      return;
    }
    setBusy(true);
    setStatus(projectSubmittingStatus(tab));
    const res = await post('/api/project/add', {
      github: gh,
      label: label.trim(),
      name,
    });
    if (res.ok) {
      setStatus(`✓ Added ${res.name} (port band ${res.base}–${res.base + 99})`);
      onAdded();
      closeTimer.current = setTimeout(onClose, 1800);
    } else {
      setStatus(`✗ ${res.error ?? 'failed'}`);
      setUncertain(!!res.networkUncertain || !!res.committed);
      setBusy(false);
    }
  }

  const tabCls = (t: string) =>
    `flex-1 text-xs font-medium py-1.5 rounded-none transition-colors duration-150 ${tab === t ? 'bg-white text-zinc-900 shadow-sm' : 'text-zinc-500'}`;

  return (
    // Same conditional-mount/controlled-open shape as CreateModal above --
    // see its own comment for why `open` is a literal `true` here.
    <Dialog
      onOpenChange={(o: boolean) => {
        if (!(o || busy)) {
          onClose();
        }
      }}
      open
    >
      <DialogContent initialFocus={tabInputRef}>
        <div class="mb-5 flex items-center justify-between">
          <div>
            <DialogTitle class="font-semibold text-base text-zinc-900 dark:text-zinc-100">
              Add project
            </DialogTitle>
            <DialogDescription class="mt-0.5 text-zinc-400">
              Register a new or existing repo
            </DialogDescription>
          </div>
          <DialogClose
            aria-label="Close dialog"
            class="flex h-7 w-7 items-center justify-center rounded-lg text-zinc-400 transition-colors duration-200 hover:bg-zinc-100 hover:text-zinc-600"
            disabled={busy}
          >
            <CloseIcon />
          </DialogClose>
        </div>
        <div class="flex flex-col gap-4">
          <fieldset
            aria-label="Project source"
            class="mb-1 flex min-w-0 gap-1 rounded-none bg-zinc-100 p-0.5 dark:bg-zinc-800"
            disabled={busy || uncertain}
          >
            <button
              aria-pressed={tab === 'existing'}
              class={tabCls('existing')}
              onClick={() => setTab('existing')}
              type="button"
            >
              Existing repo
            </button>
            <button
              aria-pressed={tab === 'new'}
              class={tabCls('new')}
              onClick={() => setTab('new')}
              type="button"
            >
              New repo
            </button>
          </fieldset>

          {tab === 'existing' ? (
            <div class="flex flex-col gap-1.5">
              <label class="text-xs text-zinc-500" htmlFor="add-project-github">
                GitHub URL or slug
              </label>
              <input
                autocomplete="off"
                class={inputCls}
                disabled={busy || uncertain}
                id="add-project-github"
                onInput={(e) => setGithub(e.currentTarget.value)}
                placeholder="org/repo or https://github.com/org/repo"
                ref={tabInputRef}
                value={github}
              />
            </div>
          ) : (
            <div class="flex flex-col gap-1.5">
              <label class="text-xs text-zinc-500" htmlFor="add-project-name">
                Repo name
              </label>
              <input
                autocomplete="off"
                class={inputCls}
                disabled={busy || uncertain}
                id="add-project-name"
                onInput={(e) => setNewName(e.currentTarget.value)}
                placeholder="my-new-project"
                ref={tabInputRef}
                value={newName}
              />
              <p class="text-[11px] text-zinc-400">
                Creates a bare local repo at ~/workspace/&lt;name&gt;.git — push
                a remote later.
              </p>
            </div>
          )}

          <div class="flex flex-col gap-1.5">
            <label class="text-xs text-zinc-500" htmlFor="add-project-label">
              Label <span class="text-zinc-500">(optional)</span>
            </label>
            <input
              autocomplete="off"
              class={inputCls}
              disabled={busy || uncertain}
              id="add-project-label"
              onInput={(e) => setLabel(e.currentTarget.value)}
              placeholder="My App"
              value={label}
            />
          </div>

          {status && (
            <p class="text-xs text-zinc-500" role="status">
              {status}
            </p>
          )}

          {uncertain && (
            <Button
              onClick={() => {
                onAdded();
                onClose();
              }}
              variant="secondary"
            >
              Refresh and review projects
            </Button>
          )}
          <div class="flex gap-3 pt-1">
            <Button
              class="flex-1"
              disabled={busy}
              onClick={onClose}
              variant="secondary"
            >
              Cancel
            </Button>
            <Button
              class="flex-1"
              disabled={busy || uncertain}
              onClick={submit}
              variant="primary"
            >
              {busy ? 'Adding…' : 'Add'}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

// Start is a split action: the primary click uses the sticky per-worktree
// default (mode omitted from the request entirely — see lib.js's
// defaultContainerMode), the caret forces a specific mode. Showing
// nextStartMode *before* the click, not after, is the actual point: a silent
// mode switch is what caused a real incident (an established, always-bare
// worktree got switched to a container mid-restart with no explicit choice
// from anyone) — surfacing the resolved mode up front removes the blind spot.
function StartControl({
  w,
  pending,
  onStart,
}: {
  w: Worktree;
  pending: boolean;
  onStart: (w: Worktree, force?: 'container' | 'bare') => void;
}) {
  if (pending) {
    return (
      <IconButton
        disabled
        label={`Starting ${w.name}`}
        tip="Starting…"
        tone="emerald"
      >
        <ActionIcon path={tablerRefresh.path} spin />
      </IconButton>
    );
  }
  if (w.needsMigrationPrompt) {
    return (
      <DropdownMenu>
        <DropdownMenuTrigger
          aria-label={`Choose start mode for ${w.name}`}
          class="tip icon-btn text-signal-green transition-colors duration-150 hover:bg-current/10"
          data-tip="This worktree has always run bare. Choose a start mode."
        >
          <ActionIcon filled path={tablerPlayerPlayFilled.path} />
        </DropdownMenuTrigger>
        <DropdownMenuContent>
          <p class="menu-help">
            This worktree has always run bare. Choose its next start mode.
          </p>
          <DropdownMenuItem onClick={() => onStart(w, 'container')}>
            Migrate to container
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => onStart(w, 'bare')}>
            Keep bare, start now
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    );
  }
  return (
    <IconButton
      label={`Start ${w.name} (${w.nextStartMode})`}
      onClick={() => onStart(w)}
      tip={`Start — will run ${w.nextStartMode}`}
      tone="emerald"
    >
      <ActionIcon filled path={tablerPlayerPlayFilled.path} />
    </IconButton>
  );
}

// Tabler glyphs at the card's icon-button size (a4f500c's action icons).
function ActionIcon({
  path,
  filled = false,
  spin = false,
}: {
  path: string;
  filled?: boolean;
  spin?: boolean;
}) {
  return (
    <svg
      aria-hidden="true"
      class={spin ? 'spin h-4 w-4' : 'h-4 w-4'}
      fill={filled ? 'currentColor' : 'none'}
      stroke={filled ? undefined : 'currentColor'}
      stroke-linecap="round"
      stroke-linejoin="round"
      stroke-width={filled ? undefined : 2}
      viewBox="0 0 24 24"
    >
      <path d={path} />
    </svg>
  );
}

const LIFECYCLE_TIP: Record<string, string> = { Stop: 'Stop server' };
const LIFECYCLE_ICON: Record<
  string,
  { path: string; tone: Tone; filled?: boolean; spin?: boolean }
> = {
  'Cancel queue': { path: tablerClock.path, tone: 'amber' },
  'Needs attention': { path: tablerAlertTriangle.path, tone: 'red' },
  'Retry Stop': {
    filled: true,
    path: tablerPlayerStopFilled.path,
    tone: 'red',
  },
  Stop: { filled: true, path: tablerPlayerStopFilled.path, tone: 'red' },
  'Stopping…': { path: tablerRefresh.path, spin: true, tone: 'zinc' },
};

function WorktreeActions({
  w,
  pending = false,
  agents,
  onAct,
  onStart,
  onOpenTool,
  onOpenLogs,
  onRemove,
  toast,
}: {
  w: Worktree;
  pending?: boolean;
  agents: { id: string; label: string }[];
  onAct: (url: string, w: Worktree) => void;
  onStart: (w: Worktree, force?: 'container' | 'bare') => void;
  onOpenTool: (w: Worktree, tool: string) => void;
  onOpenLogs: (
    repo: string,
    name: string,
    type: string,
    returnFocus?: HTMLElement | null
  ) => void;
  onRemove: (w: Worktree, reason?: 'manual' | 'merged') => void;
  toast: (msg: string, tone?: Tone) => void;
}) {
  const control = lifecycleControl(w, pending);
  const browserReasonId = useId();
  const moreTrigger = useRef<HTMLButtonElement>(null);
  const leavingMenu = useRef(false);
  const detailPath = `/worktree/${encodeURIComponent(w.repo)}/${encodeURIComponent(w.name)}`;
  function goTo(section: string) {
    leavingMenu.current = true;
    navigate(`${detailPath}#${section}`);
  }
  // navigator.clipboard is undefined on non-secure origins such as http://quivly.local.
  async function copyCD() {
    try {
      await navigator.clipboard.writeText(cdCommand(w));
      toast('Copied cd command', 'emerald');
    } catch {
      toast(
        `✗ Couldn't copy to clipboard. Run it manually: ${cdCommand(w)}`,
        'red'
      );
    }
  }
  return (
    <fieldset
      aria-label={`Actions for ${w.name}`}
      class="worktree-actions flex min-w-0 flex-wrap items-center gap-1"
      data-worktree-key={w.key}
    >
      <DropdownMenu>
        <DropdownMenuTrigger
          aria-label={`Open ${w.name}`}
          class="tip icon-btn text-zinc-500 transition-colors duration-150 hover:bg-current/10 dark:text-zinc-300"
          data-tip="Open in browser or tool"
        >
          <ActionIcon path={tablerExternalLink.path} />
        </DropdownMenuTrigger>
        <DropdownMenuContent>
          <DropdownMenuItem
            aria-describedby={w.active ? undefined : browserReasonId}
            disabled={!w.active}
            onClick={() => {
              if (w.active) {
                window.open(
                  `http://${w.domain}`,
                  '_blank',
                  'noopener,noreferrer'
                );
              }
            }}
          >
            Open in browser
          </DropdownMenuItem>
          {!w.active && (
            <p class="menu-help" id={browserReasonId}>
              Start this worktree to open its local site.
            </p>
          )}
          <DropdownMenuSeparator />
          <MenuPrimitive.Group>
            <MenuPrimitive.GroupLabel className="menu-group-label">
              Coding tools
            </MenuPrimitive.GroupLabel>
            {agents.map((a) => (
              <DropdownMenuItem
                icon={<ToolIcon id={a.id} label={a.label} />}
                key={a.id}
                onClick={() => onOpenTool(w, a.id)}
              >
                {a.label}
              </DropdownMenuItem>
            ))}
            {!agents.length && (
              <p class="menu-help">No coding tools detected.</p>
            )}
          </MenuPrimitive.Group>
        </DropdownMenuContent>
      </DropdownMenu>
      {control.action === 'start' ? (
        <StartControl onStart={onStart} pending={false} w={w} />
      ) : (
        <IconButton
          disabled={control.action === null}
          label={`${control.label} for ${w.name}`}
          onClick={() => {
            if (control.action === 'stop') {
              onAct('/api/stop', w);
            }
          }}
          tip={
            control.label === 'Cancel queue'
              ? `Queued #${w.queuePosition ?? '?'}, click to cancel`
              : (LIFECYCLE_TIP[control.label] ?? control.label)
          }
          tone={LIFECYCLE_ICON[control.label]?.tone ?? 'zinc'}
        >
          <ActionIcon
            filled={LIFECYCLE_ICON[control.label]?.filled}
            path={LIFECYCLE_ICON[control.label]?.path ?? tablerRefresh.path}
            spin={LIFECYCLE_ICON[control.label]?.spin}
          />
        </IconButton>
      )}
      <DropdownMenu
        onOpenChange={(open: boolean) => {
          if (open) {
            leavingMenu.current = false;
          }
        }}
      >
        <DropdownMenuTrigger
          aria-label={`More actions for ${w.name}`}
          class="tip icon-btn text-zinc-500 transition-colors duration-150 hover:bg-current/10 dark:text-zinc-300"
          data-tip="More actions"
          ref={moreTrigger}
        >
          <ActionIcon filled path={tablerDotsVerticalFilled.path} />
        </DropdownMenuTrigger>
        <DropdownMenuContent finalFocus={() => !leavingMenu.current}>
          <MenuPrimitive.Group>
            <MenuPrimitive.GroupLabel className="menu-group-label">
              Worktree
            </MenuPrimitive.GroupLabel>
            <DropdownMenuItem
              onClick={() => {
                leavingMenu.current = true;
                onOpenLogs(w.repo, w.name, 'dev', moreTrigger.current);
              }}
            >
              View logs
            </DropdownMenuItem>
            <DropdownMenuItem onClick={copyCD}>
              Copy cd command
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => goTo('sidecars')}>
              Sidecars…
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => goTo('deployments')}>
              Deploy…
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => onAct('/api/sync', w)}>
              Sync with base
            </DropdownMenuItem>
          </MenuPrimitive.Group>
          <DropdownMenuSeparator />
          <MenuPrimitive.Group>
            <MenuPrimitive.GroupLabel className="menu-group-label">
              Run mode for next start
            </MenuPrimitive.GroupLabel>
            <DropdownMenuItem
              disabled={control.action !== 'start'}
              onClick={() => onStart(w, 'bare')}
            >
              Start bare
            </DropdownMenuItem>
            <DropdownMenuItem
              disabled={control.action !== 'start'}
              onClick={() => onStart(w, 'container')}
            >
              Start in container
            </DropdownMenuItem>
            <DropdownMenuItem
              onClick={() => {
                leavingMenu.current = true;
                navigate('/help#mode');
              }}
            >
              About run modes
            </DropdownMenuItem>
          </MenuPrimitive.Group>
          <DropdownMenuItem
            onClick={() => {
              leavingMenu.current = true;
              navigate('/help#sync');
            }}
          >
            About syncing with base
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            disabled={w.name === 'main'}
            onClick={() => onRemove(w)}
            tone="red"
          >
            Remove worktree
          </DropdownMenuItem>
          {w.name === 'main' && (
            <p class="menu-help">
              The main worktree holds shared local files such as .env.local.
              Remove the project instead.
            </p>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
    </fieldset>
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
const DEPLOY_PROVIDER: Record<
  DeployProvider,
  {
    label: string;
    Icon: (props: { class?: string }) => JSX.Element;
    customPrompt: string;
  }
> = {
  netlify: {
    customPrompt: 'Branch name for the deploy context (e.g. staging):',
    Icon: NetlifyIcon,
    label: 'Netlify',
  },
  vercel: {
    customPrompt: 'Custom environment name (e.g. staging):',
    Icon: VercelIcon,
    label: 'Vercel',
  },
};

// Same "icon button opens a picker" shape as StartControl's force-mode menu
// above, for the same reason: deploying needs a target choice (preview,
// production, or a named custom environment), not a bare click. A running
// deploy is one-shot and not cancellable from here, so it renders as a
// disabled pulsing indicator instead of a clickable trigger; clicking
// "deploy" again mid-deploy isn't a meaningful action. One component covers
// both Vercel and Netlify -- they differ only in which Worktree field holds
// the deploy state and the DEPLOY_PROVIDER lookup above, not in shape.
function DeployMenu({
  w,
  provider,
  deploy,
  onDeploy,
}: {
  w: Worktree;
  provider: DeployProvider;
  deploy: DeployStatus;
  onDeploy: (w: Worktree, provider: DeployProvider, target: string) => void;
}) {
  const { label, Icon, customPrompt } = DEPLOY_PROVIDER[provider];
  const openingDialog = useRef(false);
  function choose(target: string) {
    openingDialog.current = true;
    onDeploy(w, provider, target);
  }
  if (deploy?.phase === 'unknown') {
    return (
      <Button compact disabled variant="secondary">
        Outcome not confirmed
      </Button>
    );
  }
  if (deploy?.deploying) {
    return (
      <IconButton
        disabled
        tip={`Deploying to ${label} (${deploy.target})…`}
        tone="amber"
      >
        <svg
          aria-hidden="true"
          class="spin h-4 w-4"
          fill="none"
          stroke="currentColor"
          stroke-linecap="round"
          stroke-linejoin="round"
          stroke-width="2.5"
          viewBox="0 0 24 24"
        >
          <path d={tablerRefresh.path} />
        </svg>
      </IconButton>
    );
  }
  return (
    // tone="zinc" IconButton chrome reproduced on the trigger directly --
    // see StartControl's needsMigrationPrompt branch above for why.
    <DropdownMenu
      onOpenChange={(open) => {
        if (open) {
          openingDialog.current = false;
        }
      }}
    >
      <DropdownMenuTrigger
        aria-label={`Deploy ${w.name} to ${label}`}
        class="tip icon-btn text-zinc-400 transition-colors duration-200 ease-out hover:bg-current/10"
        data-deploy-trigger={`${w.key}:${provider}`}
        data-tip={`Deploy to ${label}`}
        onClick={(e: MouseEvent) => {
          openingDialog.current = false;
          e.stopPropagation();
        }}
      >
        <Icon class="h-4 w-4" />
      </DropdownMenuTrigger>
      <DropdownMenuContent finalFocus={() => !openingDialog.current}>
        <DropdownMenuItem onClick={() => choose('preview')}>
          Deploy preview
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => choose('production')}>
          Deploy production
        </DropdownMenuItem>
        <DropdownMenuItem
          onClick={() => {
            // biome-ignore lint/suspicious/noAlert: Existing prompt is the custom deployment target entry gate; cancellation and blank input leave the request untouched.
            const custom = window.prompt(customPrompt);
            if (custom?.trim()) {
              choose(custom.trim());
            }
          }}
        >
          Deploy custom…
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

// WorktreeCard's compact inline status chips (deploying/deployed/failed) for
// one provider -- previously inlined once for vercel only, now shared the
// same way DeployMenu above is so adding netlify didn't mean pasting a
// second copy of this same three-branch block.
function DeployStatusChips({
  w,
  provider,
  deploy,
  onOpenLogs,
}: {
  w: Worktree;
  provider: DeployProvider;
  deploy: DeployStatus;
  onOpenLogs: (
    repo: string,
    name: string,
    type: string,
    returnFocus?: HTMLElement | null
  ) => void;
}) {
  const { label, Icon } = DEPLOY_PROVIDER[provider];
  return (
    <>
      {deploy?.deploying && deploy.phase !== 'unknown' && (
        <button
          class="flex shrink-0 items-center gap-1.5 text-signal-amber transition-opacity duration-150 hover:opacity-80"
          onClick={() => onOpenLogs(w.repo, w.name, provider)}
          title={`Deploying to ${label} (${deploy.target}), click to view progress`}
          type="button"
        >
          <StatusDot pulse tone="amber" />
          deploying
        </button>
      )}
      {deploy?.url && !deploy.deploying && (
        <a
          class="flex shrink-0 items-center gap-1 text-signal-green transition-colors duration-150 hover:text-zinc-600"
          href={deploy.url}
          rel="noopener"
          target="_blank"
          title={`Deployed to ${deploy.target}`}
        >
          <Icon class="h-3 w-3" />
          deployed
        </a>
      )}
      {deploy?.phase === 'unknown' && (
        <button
          class="text-signal-red underline"
          onClick={() => onOpenLogs(w.repo, w.name, provider)}
          title={deploy.error ?? 'Inspect provider status before retrying'}
          type="button"
        >
          deployment outcome not confirmed
        </button>
      )}
      {deploy?.error && !deploy.deploying && deploy.phase !== 'unknown' && (
        <button
          class="flex shrink-0 items-center gap-1 text-signal-red transition-opacity duration-150 hover:opacity-80"
          onClick={() => onOpenLogs(w.repo, w.name, provider)}
          title={deploy.error}
          type="button"
        >
          deploy failed
        </button>
      )}
    </>
  );
}

// Backend shape from GET /api/pr-review/status -- see pr-review.js's
// reviewRunStatus/findLatestArtifact for where each field comes from.
type PrReviewRun = {
  running: boolean;
  skill: string;
  startedAt: number;
  exitCode: 'success' | 'error' | 'timeout' | null;
  costUsd: number | null | undefined;
  error: string | null;
  dirtyAfter: boolean | null;
} | null;
type PrReviewArtifact = {
  checkoutIdentity?: unknown;
  findingRecords?: Record<string, unknown>[];
  snapshot: string;
  generatedAt: string;
  headSha: string;
  htmlFile: string | null;
  findings: number | null | undefined;
  stale: boolean;
} | null;
interface PrReviewStatus {
  artifacts: Record<'pr-walkthrough' | 'pr-brief', PrReviewArtifact>;
  pluginInstalled: boolean;
  pr: { number: number } | null;
  run: PrReviewRun;
}

const PR_REVIEW_SKILLS = ['pr-walkthrough', 'pr-brief'] as const;
const PR_REVIEW_LABEL: Record<(typeof PR_REVIEW_SKILLS)[number], string> = {
  'pr-brief': 'Brief',
  'pr-walkthrough': 'Deep review',
};

// Tier 2 of PR review -- shells out to the installed pr-walkthrough/pr-brief
// Claude Code plugin (see pr-review.js). Self-contained, same "owns its own
// polling loop" convention as RaycastSection: WorktreePage doesn't need to
// know anything about this beyond dropping it in. Renders nothing when the
// worktree has no associated PR -- there's nothing to review.
function PrReviewSection({
  w,
  toast,
  onOpenLogs,
}: {
  w: Worktree;
  toast: (msg: string, tone?: Tone) => void;
  onOpenLogs: (
    repo: string,
    name: string,
    type: string,
    returnFocus?: HTMLElement | null
  ) => void;
}) {
  const url = `/api/pr-review/status?repo=${encodeURIComponent(w.repo)}&name=${encodeURIComponent(w.name)}`;
  const {
    data: status,
    failed,
    refresh: load,
  } = useVisiblePoll(w.pr ? `${url}#${w.pr.number}` : null, 3000, (signal) =>
    readJson<PrReviewStatus>(url, signal)
  );

  async function run(skill: string) {
    const res = await postOrToast(
      '/api/pr-review/run',
      { name: w.name, repo: w.repo, skill },
      toast,
      'pr-review failed to start'
    );
    if (res?.ok) {
      load();
    }
  }

  if (!w.pr) {
    return null;
  }

  const reviewRun = status?.run;
  const running = reviewRun?.running ?? false;
  const runningSkill = reviewRun
    ? PR_REVIEW_LABEL[reviewRun.skill as (typeof PR_REVIEW_SKILLS)[number]]
    : undefined;

  return (
    <Section title="PR Review">
      {failed && (
        <p class="text-red-700 text-sm dark:text-red-300" role="status">
          Could not refresh PR review status.{' '}
          {status ? 'Showing the last received status. ' : ''}
          <button class="underline" onClick={load} type="button">
            Retry
          </button>
        </p>
      )}
      {(function renderPrReviewContent() {
        if (!status) {
          return !failed && <p class="text-sm text-zinc-400">Loading…</p>;
        }
        if (!status.pluginInstalled) {
          return (
            <p class="text-xs text-zinc-400">
              The pr-walkthrough plugin isn't installed for this worktree.
              Install it with{' '}
              <code class="font-mono text-zinc-500">
                claude plugin install pr-walkthrough@mukulchugh-skills
              </code>
              .
            </p>
          );
        }
        return (
          <div class="flex flex-col gap-3">
            <div class="flex flex-wrap items-center gap-3">
              {running ? (
                <button
                  class="flex items-center gap-1.5 text-signal-amber text-xs transition-opacity duration-150 hover:opacity-80"
                  onClick={() => onOpenLogs(w.repo, w.name, 'pr-review')}
                  title={`Running ${runningSkill}, click to view progress`}
                  type="button"
                >
                  <StatusDot pulse tone="amber" />
                  running {runningSkill}…
                </button>
              ) : (
                PR_REVIEW_SKILLS.map((skill) => (
                  <Button
                    compact
                    key={skill}
                    onClick={() => run(skill)}
                    variant="secondary"
                  >
                    {PR_REVIEW_LABEL[skill]}
                  </Button>
                ))
              )}
              {status?.run && !running && status.run.exitCode !== 'success' && (
                <button
                  class="flex items-center gap-1 text-signal-red text-xs transition-opacity duration-150 hover:opacity-80"
                  onClick={() => onOpenLogs(w.repo, w.name, 'pr-review')}
                  type="button"
                >
                  {status.run.exitCode === 'timeout' ? 'timed out' : 'failed'} —
                  view log
                </button>
              )}
              {status?.run &&
                !running &&
                status.run.exitCode === 'success' &&
                status.run.costUsd !== null &&
                status.run.costUsd !== undefined && (
                  <span class="text-xs text-zinc-400">
                    last run cost ${status.run.costUsd.toFixed(2)}
                  </span>
                )}
              {status?.run?.dirtyAfter && (
                <span class="text-signal-red text-xs">
                  warning: worktree changed during the run — check with git
                  status
                </span>
              )}
            </div>

            {status &&
              PR_REVIEW_SKILLS.map((skill) => {
                const a = status.artifacts[skill];
                if (!a?.htmlFile) {
                  return null;
                }
                return (
                  <div class="flex items-center gap-2 text-xs" key={skill}>
                    <a
                      class="text-zinc-700 transition-colors hover:text-accent dark:text-zinc-300"
                      href={`/api/pr-review/artifact?repo=${encodeURIComponent(w.repo)}&name=${encodeURIComponent(w.name)}&skill=${skill}`}
                      rel="noopener"
                      target="_blank"
                    >
                      Open {PR_REVIEW_LABEL[skill].toLowerCase()}
                    </a>
                    {a.findings !== null && a.findings !== undefined && (
                      <Badge tone="zinc">
                        {a.findings} finding{a.findings === 1 ? '' : 's'}
                      </Badge>
                    )}
                    {a.stale && (
                      <span class="text-signal-amber">
                        stale — reviewed {a.headSha.slice(0, 7)}, head has moved
                        on
                      </span>
                    )}
                  </div>
                );
              })}
            <PrReviewHandoff
              artifacts={PR_REVIEW_SKILLS.flatMap((skill) => {
                const artifact = status.artifacts[skill];
                return artifact?.htmlFile
                  ? [
                      {
                        checkoutIdentity: artifact.checkoutIdentity,
                        findingRecords: artifact.findingRecords,
                        headSha: artifact.headSha,
                        prNumber: status.pr?.number ?? 0,
                        skill,
                        snapshot: artifact.snapshot,
                        stale: artifact.stale,
                      },
                    ]
                  : [];
              })}
              name={w.name}
              repo={w.repo}
              toast={toast}
            />
          </div>
        );
      })()}
    </Section>
  );
}

// One-click GitHub actions for a worktree's branch/PR: create a PR when
// there isn't one yet, flip draft<->ready when there is, and a plain link
// to the branch's CI checks either way. Hidden entirely for a repo with no
// GitHub remote configured (branchUrl is null in that case, same gate the
// Overview section's own Branch row already uses) -- there's nothing
// GitHub-shaped to do for a purely local project.
function GithubActionsSection({
  w,
  toast,
  onRefresh,
}: {
  w: Worktree;
  toast: (msg: string, tone?: Tone) => void;
  onRefresh: () => void;
}) {
  const [busy, setBusy] = useState<'create' | 'ready' | null>(null);
  const { pr } = w;

  async function createPr() {
    setBusy('create');
    const res = await postOrToast(
      '/api/pr/create',
      { name: w.name, repo: w.repo },
      toast,
      'create PR failed'
    );
    setBusy(null);
    if (res?.ok) {
      toast('PR created', 'emerald');
      onRefresh();
    }
  }

  async function toggleReady(ready: boolean) {
    setBusy('ready');
    const res = await postOrToast(
      '/api/pr/ready',
      { name: w.name, ready, repo: w.repo },
      toast,
      `mark ${ready ? 'ready' : 'draft'} failed`
    );
    setBusy(null);
    if (res?.ok) {
      onRefresh();
    }
  }

  if (!(w.pr || w.branchUrl)) {
    return null;
  }

  // A PR's own /checks path is the direct checks tab; without a PR yet,
  // fall back to the repo's Actions list filtered to this branch --
  // branchUrl is `${github}/tree/${name}`, strip the /tree/... suffix to
  // get back to the bare repo URL.
  let ciUrl: string | null = null;
  if (w.pr) {
    ciUrl = `${w.pr.url}/checks`;
  } else if (w.branchUrl) {
    ciUrl = `${w.branchUrl.replace(BRANCH_TREE_PATH_PATTERN, '')}/actions?query=${encodeURIComponent(`branch:${w.name}`)}`;
  }

  return (
    <Section title="GitHub">
      <div class="flex flex-wrap items-center gap-4 text-sm">
        {/* w.name !== 'main': mirrors getWorktrees()'s own fetchPR gate
            (portal.js) -- 'main' is Setu's fixed slot name for a project's
            primary worktree, never itself a PR candidate, so w.pr is always
            null there regardless of GitHub state. Without this check the
            button would offer to PR main against itself. */}
        {!w.pr && w.name !== 'main' && (
          <Button
            compact
            disabled={busy === 'create'}
            onClick={createPr}
            variant="secondary"
          >
            {busy === 'create' ? 'Creating…' : 'Create PR'}
          </Button>
        )}
        {pr && (pr.state === 'open' || pr.state === 'draft') && (
          <Button
            compact
            disabled={busy === 'ready'}
            onClick={() => toggleReady(pr.state === 'draft')}
            variant="secondary"
          >
            {prReadyActionLabel(busy, pr.state)}
          </Button>
        )}
        {ciUrl && (
          <a
            class="text-xs text-zinc-500 transition-colors duration-150 hover:text-accent dark:text-zinc-400"
            href={ciUrl}
            rel="noopener"
            target="_blank"
          >
            View CI runs →
          </a>
        )}
      </div>
    </Section>
  );
}

// WorktreePage's "<Provider> deploy" Section -- previously written out once
// for Vercel only, now shared with Netlify the same way everything else on
// this page is (DeployMenu, DeployStatusChips above).
function DeploySection({
  w,
  provider,
  deploy,
  onDeploy,
  onOpenLogs,
}: {
  w: Worktree;
  provider: DeployProvider;
  deploy: DeployStatus;
  onDeploy: (w: Worktree, provider: DeployProvider, target: string) => void;
  onOpenLogs: (
    repo: string,
    name: string,
    type: string,
    returnFocus?: HTMLElement | null
  ) => void;
}) {
  const { label } = DEPLOY_PROVIDER[provider];
  return (
    <Section title={`${label} deploy`}>
      <div class="flex flex-wrap items-center justify-between gap-3 text-sm">
        <div class="flex min-w-0 items-center gap-2">
          <StatusDot
            pulse={!!deploy?.deploying && deploy.phase !== 'unknown'}
            tone={deployTone(deploy)}
          />
          <span>{deployStatusText(deploy)}</span>
          {deploy?.url && !deploy.deploying && (
            <a
              class="max-w-xs truncate text-emerald-600 text-xs hover:underline"
              href={deploy.url}
              rel="noopener"
              target="_blank"
            >
              {deploy.url}
            </a>
          )}
          {deploy && (
            <button
              class="shrink-0 text-xs text-zinc-500 hover:underline"
              onClick={() => onOpenLogs(w.repo, w.name, provider)}
              type="button"
            >
              view log
            </button>
          )}
        </div>
        <DeployMenu
          deploy={deploy}
          onDeploy={onDeploy}
          provider={provider}
          w={w}
        />
      </div>
      {deploy?.error && (!deploy.deploying || deploy.phase === 'unknown') && (
        <p class="mt-2 text-signal-red text-xs" role="status">
          {deploy.error}
        </p>
      )}
    </Section>
  );
}

// Convex's own tone/text pair, same shape as deployTone/deployStatusText
// above but reading `ok` instead of `url` -- see ConvexDeployStatus's own
// comment for why a convex deploy needs an explicit success signal rather
// than inferring it from a url field that would just always be null.
function convexDeployTone(d: ConvexDeployStatus): Tone {
  if (!d) {
    return 'zinc';
  }
  if (d.phase === 'unknown') {
    return 'red';
  }
  if (d.deploying) {
    return 'amber';
  }
  if (d.error) {
    return 'red';
  }
  if (d.ok) {
    return 'emerald';
  }
  return 'zinc';
}
function convexDeployText(d: ConvexDeployStatus): string {
  if (!d) {
    return 'Not deployed';
  }
  if (d.phase === 'unknown') {
    return 'Deployment outcome not confirmed';
  }
  if (d.deploying) {
    return `Deploying (${d.target})…`;
  }
  if (d.error) {
    return 'Deploy failed';
  }
  if (d.ok) {
    return `Deployed (${d.target})`;
  }
  return 'Not deployed';
}

// Convex production is explicit, while preview deployments require a named
// preview target. The deployment preflight remains the authority for key and
// destination binding before the existing confirmation dialog can submit.
function ConvexDeployMenu({
  w,
  deploy,
  onConvexDeploy,
}: {
  w: Worktree;
  deploy: ConvexDeployStatus;
  onConvexDeploy: (w: Worktree, target: string) => void;
}) {
  const openingDialog = useRef(false);
  function choose(target: string) {
    openingDialog.current = true;
    onConvexDeploy(w, target);
  }
  if (deploy?.phase === 'unknown') {
    return (
      <Button compact disabled variant="secondary">
        Outcome not confirmed
      </Button>
    );
  }
  if (deploy?.deploying) {
    return (
      <IconButton
        disabled
        tip={`Deploying to Convex (${deploy.target})…`}
        tone="amber"
      >
        <svg
          aria-hidden="true"
          class="spin h-4 w-4"
          fill="none"
          stroke="currentColor"
          stroke-linecap="round"
          stroke-linejoin="round"
          stroke-width="2.5"
          viewBox="0 0 24 24"
        >
          <path d={tablerRefresh.path} />
        </svg>
      </IconButton>
    );
  }
  return (
    <DropdownMenu
      onOpenChange={(open) => {
        if (open) {
          openingDialog.current = false;
        }
      }}
    >
      <DropdownMenuTrigger
        aria-label={`Deploy Convex for ${w.name}`}
        class="tip icon-btn text-zinc-400 transition-colors duration-200 ease-out hover:bg-current/10"
        data-deploy-trigger={`${w.key}:convex`}
        data-tip="Deploy to Convex"
        onClick={(e: MouseEvent) => {
          openingDialog.current = false;
          e.stopPropagation();
        }}
      >
        <ConvexIcon class="h-4 w-4" />
      </DropdownMenuTrigger>
      <DropdownMenuContent finalFocus={() => !openingDialog.current}>
        <DropdownMenuItem
          onClick={() => {
            // biome-ignore lint/suspicious/noAlert: Existing prompt is the named preview target entry gate; cancellation and blank input leave the request untouched.
            const target = window.prompt('Named Convex preview target:');
            if (target?.trim()) {
              choose(target.trim());
            }
          }}
        >
          Deploy named preview…
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => choose('production')}>
          Deploy production
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

// WorktreePage's "Convex" Section -- only ever rendered by its caller when
// w.convexConfigured is true (see WorktreePage below). Combines a sidecar-
// style start/stop row (mirroring the Inngest row in the Sidecars Section
// below exactly) with a small Deploy action (mirroring DeploySection above),
// since Convex genuinely has both shapes: a persistent dev process and a
// separate occasional deploy.
function ConvexSection({
  w,
  onAct,
  onOpenLogs,
  onConvexDeploy,
}: {
  w: Worktree;
  onAct: (url: string, w: Worktree) => void;
  onOpenLogs: (
    repo: string,
    name: string,
    type: string,
    returnFocus?: HTMLElement | null
  ) => void;
  onConvexDeploy: (w: Worktree, target: string) => void;
}) {
  const deploy = w.convexDeploy;
  return (
    <Section title="Convex">
      <div class="flex flex-wrap items-center justify-between gap-3 text-sm">
        <div class="flex items-center gap-2">
          <ConvexIcon class="h-4 w-4" />
          <StatusDot tone={w.convexActive ? 'emerald' : 'zinc'} />
          <span>{w.convexActive ? 'dev running' : 'dev stopped'}</span>
          {w.convexActive ? (
            <button
              aria-label={`Stop Convex for ${w.repo}/${w.name}`}
              class="text-red-500 text-xs hover:underline"
              onClick={() => onAct('/api/convex/stop', w)}
              type="button"
            >
              stop
            </button>
          ) : (
            <button
              aria-label={`Start Convex for ${w.repo}/${w.name}`}
              class="text-xs text-zinc-500 hover:underline"
              onClick={() => onAct('/api/convex/start', w)}
              type="button"
            >
              start
            </button>
          )}
          <button
            aria-label={`View Convex log for ${w.repo}/${w.name}`}
            class="text-xs text-zinc-500 hover:underline"
            onClick={() => onOpenLogs(w.repo, w.name, 'convex')}
            type="button"
          >
            view log
          </button>
        </div>
        <div class="flex min-w-0 items-center gap-2">
          <StatusDot
            pulse={!!deploy?.deploying && deploy.phase !== 'unknown'}
            tone={convexDeployTone(deploy)}
          />
          <span class="text-xs text-zinc-500">{convexDeployText(deploy)}</span>
          <ConvexDeployMenu
            deploy={deploy}
            onConvexDeploy={onConvexDeploy}
            w={w}
          />
        </div>
      </div>
      {deploy?.error && (!deploy.deploying || deploy.phase === 'unknown') && (
        <p class="mt-2 text-signal-red text-xs" role="status">
          {deploy.error}
        </p>
      )}
    </Section>
  );
}

function WorktreeCard({
  w,
  pending,
  agents,
  onAct,
  onStart,
  onOpenLogs,
  onOpenTool,
  onRemove,
  toast,
  gridMode,
}: {
  w: Worktree;
  pending: boolean;
  agents: { id: string; label: string }[];
  onAct: (url: string, w: Worktree) => void;
  onStart: (w: Worktree, force?: 'container' | 'bare') => void;
  onOpenLogs: (
    repo: string,
    name: string,
    type: string,
    returnFocus?: HTMLElement | null
  ) => void;
  onOpenTool: (w: Worktree, tool: string) => void;
  onRemove: (w: Worktree, reason?: 'manual' | 'merged') => void;
  toast: (msg: string, tone?: Tone) => void;
  gridMode: boolean;
}) {
  return (
    <div
      class={`wt-card group rounded-none border bg-white/85 backdrop-blur-md transition-colors duration-150 hover:border-zinc-300 hover:bg-white/95 dark:bg-zinc-900/55 dark:hover:border-zinc-700 dark:hover:bg-zinc-900/75 ${
        gridMode
          ? 'flex flex-col gap-3 px-5 py-5'
          : 'flex flex-col gap-3 px-4 py-4 sm:flex-row sm:items-center sm:gap-4 sm:px-6'
      } ${
        w.active
          ? 'border-zinc-200 border-l-[3px] border-l-signal-green dark:border-zinc-800'
          : 'border-zinc-200 dark:border-zinc-800'
      }`}
    >
      <div class="min-w-0 flex-1">
        {(function renderCardHeader() {
          const { tone: statusTone, text: statusText } = worktreeStatus(w);
          return (
            <>
              {worktreeIssue(w) && (
                <p
                  class="mb-2 break-words text-signal-red text-xs"
                  role="status"
                >
                  {worktreeIssue(w)}
                </p>
              )}
              <div class={'mb-1 flex flex-wrap items-baseline gap-2.5'}>
                <a
                  class="worktree-name min-w-0 max-w-full text-left font-medium text-[15px] text-zinc-900 transition-colors duration-150 hover:text-accent dark:text-zinc-100"
                  href={`/worktree/${encodeURIComponent(w.repo)}/${encodeURIComponent(w.name)}`}
                  onClick={(e) =>
                    followRoute(
                      e,
                      `/worktree/${encodeURIComponent(w.repo)}/${encodeURIComponent(w.name)}`
                    )
                  }
                >
                  {w.name}
                </a>
                <a
                  aria-label={`Open ${w.label} repository`}
                  class="tip board-mono min-w-0 max-w-full break-words font-bold text-[10px] text-zinc-600 transition-colors duration-150 hover:text-accent dark:text-zinc-300"
                  href={`/repo/${encodeURIComponent(w.repo)}`}
                  onClick={(e) =>
                    followRoute(e, `/repo/${encodeURIComponent(w.repo)}`)
                  }
                >
                  {w.label}
                </a>
                <span class="flex shrink-0 items-center gap-1.5">
                  <StatusDot pulse={w.active} tone={statusTone} />
                  <StatusFlap text={statusText} tone={statusTone} />
                </span>
                {queueWaitReason(w) && (
                  <span class="text-xs text-zinc-500">
                    {queueWaitReason(w)}
                  </span>
                )}
                {w.container && (w.active || w.starting) && (
                  <Badge
                    tip="Running in a container — real memory/CPU cap"
                    tone="zinc"
                  >
                    container
                  </Badge>
                )}
                {w.agent && (
                  <Badge tip={agentTip(w.agent)} tone={agentTone(w.agent)}>
                    {agentChipText(w.agent)}
                  </Badge>
                )}
                {!(w.active || w.queued) && (
                  <Badge
                    tip={
                      w.nextStartMode === 'container'
                        ? 'Next Start will use a container (real memory/CPU cap)'
                        : 'Next Start will run bare — this worktree has bare-only history'
                    }
                    tone="zinc"
                  >
                    → {w.nextStartMode}
                  </Badge>
                )}
                {w.active && w.memMb !== null && w.memMb !== undefined && (
                  <Badge
                    tip="Resident memory of this dev server and its child processes"
                    tone={memTone(w.memMb)}
                  >
                    {formatMem(w.memMb, true)}
                  </Badge>
                )}
                {w.dirty === null ? (
                  <Badge
                    tip="The working tree status could not be checked"
                    tone="amber"
                  >
                    changes unknown
                  </Badge>
                ) : (
                  w.dirty > 0 && (
                    <Badge
                      tip={`${w.dirty} uncommitted change${(w.dirty ?? 0) > 1 ? 's' : ''}`}
                      tone="amber"
                    >
                      {w.dirty} dirty
                    </Badge>
                  )
                )}
              </div>
            </>
          );
        })()}
        {(function renderCardMetadata() {
          const activeSidecars = w.sidecars.filter((sidecar) => sidecar.active);
          const activeSidecarLabel =
            activeSidecars.length === 1
              ? activeSidecars[0]?.name
              : `${activeSidecars.length} sidecars`;
          const showInngestInline = w.inngestActive;
          const showTriggerInline = w.triggerActive;
          // Two-part gate, unlike the two above: Convex isn't assumed available on
          // every worktree, so the inline chip needs both "configured" and "active",
          // not just "active" alone.
          const showConvexInline = w.convexConfigured && w.convexActive;
          function renderActiveSidecars() {
            return (
              activeSidecars.length > 0 && (
                <span
                  class="flex shrink-0 items-center gap-1.5"
                  title={activeSidecars
                    .map((sidecar) => sidecar.name)
                    .join(', ')}
                >
                  <StatusDot tone="emerald" />
                  {activeSidecarLabel}
                </span>
              )
            );
          }
          return (
            <div
              class={`flex min-w-0 items-center gap-3 text-xs text-zinc-600 dark:text-zinc-400 ${gridMode ? 'flex-wrap' : 'flex-wrap'}`}
            >
              <span class="max-w-full truncate font-mono">{w.domain}</span>
              {w.tunnelOn && (
                <span class="truncate font-mono text-zinc-500">
                  {w.pubDomain}
                </span>
              )}
              {w.lastCommitAt && (
                <span class="shrink-0" title="Last commit on this branch">
                  <RelativeTime value={w.lastCommitAt} />
                </span>
              )}
              {(w.ahead > 0 || w.behind > 0) && (
                <span
                  class="shrink-0 font-mono"
                  title={`${w.ahead} ahead, ${w.behind} behind its base branch`}
                >
                  {w.ahead > 0 && `↑${w.ahead}`}
                  {w.ahead > 0 && w.behind > 0 && ' '}
                  {w.behind > 0 && `↓${w.behind}`}
                </span>
              )}
              {showInngestInline && (
                <a
                  class="flex shrink-0 items-center gap-1.5 transition-colors duration-150 hover:text-zinc-600"
                  href={`http://localhost:${w.inngestPort}`}
                  rel="noopener"
                  target="_blank"
                  title="Inngest dashboard"
                >
                  <SidecarIcon tool="inngest" />
                  inngest
                </a>
              )}
              {showTriggerInline && (
                <button
                  class="flex shrink-0 items-center gap-1.5 transition-colors duration-150 hover:text-zinc-600"
                  onClick={() => onOpenLogs(w.repo, w.name, 'trigger')}
                  title="trigger.dev logs"
                  type="button"
                >
                  <SidecarIcon tool="trigger" />
                  trigger
                </button>
              )}
              {showConvexInline && (
                <button
                  class="flex shrink-0 items-center gap-1.5 transition-colors duration-150 hover:text-zinc-600"
                  onClick={() => onOpenLogs(w.repo, w.name, 'convex')}
                  title="Convex dev logs"
                  type="button"
                >
                  <ConvexIcon class="h-3 w-3" />
                  convex
                </button>
              )}
              {renderActiveSidecars()}
              {w.branchUrl && (
                <a
                  class="flex shrink-0 items-center gap-1 transition-colors duration-150 hover:text-zinc-600"
                  href={w.branchUrl}
                  rel="noopener"
                  target="_blank"
                >
                  <svg
                    aria-hidden="true"
                    class="h-3 w-3"
                    fill="currentColor"
                    viewBox="0 0 16 16"
                  >
                    <path d="M5 3.25a.75.75 0 1 1-1.5 0 .75.75 0 0 1 1.5 0zm0 2.122a2.25 2.25 0 1 0-1.5 0v.878A2.25 2.25 0 0 0 5.75 8.5h1.5v2.128a2.251 2.251 0 1 0 1.5 0V8.5h1.5a2.25 2.25 0 0 0 2.25-2.25v-.878a2.25 2.25 0 1 0-1.5 0v.878a.75.75 0 0 1-.75.75h-4.5A.75.75 0 0 1 5 6.25v-.878zm3.75 7.378a.75.75 0 1 1-1.5 0 .75.75 0 0 1 1.5 0zm3-8.75a.75.75 0 1 1-1.5 0 .75.75 0 0 1 1.5 0z" />
                  </svg>
                  branch
                </a>
              )}
              {w.pr && (
                <a
                  class={`flex shrink-0 items-center gap-1 transition-colors duration-150 ${prLinkClass(w.pr.state)}`}
                  href={w.pr.url}
                  rel="noopener"
                  target="_blank"
                  title={`${w.pr.state}: ${w.pr.title}`}
                >
                  <svg
                    aria-hidden="true"
                    class="h-3 w-3"
                    fill="currentColor"
                    viewBox="0 0 16 16"
                  >
                    <path d="M1.5 3.25a2.25 2.25 0 1 1 3 2.122v5.256a2.251 2.251 0 1 1-1.5 0V5.372A2.25 2.25 0 0 1 1.5 3.25zm5.677-.177L9.573.677A.25.25 0 0 1 10 .854V2.5h1A2.5 2.5 0 0 1 13.5 5v5.628a2.251 2.251 0 1 1-1.5 0V5a1 1 0 0 0-1-1h-1v1.646a.25.25 0 0 1-.427.177L7.177 3.427a.25.25 0 0 1 0-.354zM3.75 2.5a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5zm0 9.5a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5zm8.25.75a.75.75 0 1 1 1.5 0 .75.75 0 0 1-1.5 0z" />
                  </svg>
                  PR #{w.pr.number}
                  {w.pr.state === 'merged' && (
                    <span class="board-mono font-bold text-[8px]">MERGED</span>
                  )}
                  {(w.pr.state === 'open' || w.pr.state === 'draft') &&
                    w.pr.checks !== 'none' && (
                      <StatusDot
                        pulse={w.pr.checks === 'pending'}
                        tone={checksTone(w.pr.checks)}
                      />
                    )}
                </a>
              )}
              <DeployStatusChips
                deploy={w.vercelDeploy}
                onOpenLogs={onOpenLogs}
                provider="vercel"
                w={w}
              />
              <DeployStatusChips
                deploy={w.netlifyDeploy}
                onOpenLogs={onOpenLogs}
                provider="netlify"
                w={w}
              />
            </div>
          );
        })()}
      </div>

      <div
        class={
          gridMode
            ? '-mx-5 mt-1 -mb-5 border-zinc-100 border-t bg-zinc-100/70 px-5 py-3 dark:border-zinc-800 dark:bg-black/20'
            : 'sm:w-auto sm:shrink-0'
        }
      >
        <WorktreeActions
          agents={agents}
          onAct={onAct}
          onOpenLogs={onOpenLogs}
          onOpenTool={onOpenTool}
          onRemove={onRemove}
          onStart={onStart}
          pending={pending}
          toast={toast}
          w={w}
        />
      </div>
    </div>
  );
}

const MemoWorktreeCard = memo(WorktreeCard);
// A fresh [] per render would defeat MemoWorktreeCard while agents load or fail.
const NO_AGENTS: { id: string; label: string }[] = [];

// Same grid/flex wrapper and WorktreeCard mapping used for both the "Now
// running" section and the main paginated list — previously duplicated with
// identical prop-drilling. emptyMessage is only ever passed by the main list;
// "Now running" is only rendered when its items are non-empty, so its call
// never hits the empty branch and the paragraph never shows there.
function WorktreeList({
  items,
  gridMode,
  onAct,
  onStart,
  onRemove,
  toast,
  onOpenLogs,
  onOpenTool,
  pendingStart,
  agents,
  emptyMessage,
}: {
  items: Worktree[];
  gridMode: boolean;
  onAct: (url: string, w: Worktree) => void;
  onStart: (w: Worktree, force?: 'container' | 'bare') => void;
  onDeploy: (w: Worktree, provider: DeployProvider, target: string) => void;
  onRemove: (w: Worktree, reason?: 'manual' | 'merged') => void;
  toast: (msg: string, tone?: Tone) => void;
  onOpenLogs: (
    repo: string,
    name: string,
    type: string,
    returnFocus?: HTMLElement | null
  ) => void;
  onOpenTool: (w: Worktree, tool: string) => void;
  pendingStart: Set<string>;
  agents: { id: string; label: string }[];
  emptyMessage?: string;
}) {
  return (
    <div
      class={
        gridMode
          ? 'grid grid-cols-1 items-start gap-3 lg:grid-cols-2'
          : 'flex flex-col gap-3'
      }
    >
      {items.length ? (
        items.map((w) => (
          <MemoWorktreeCard
            agents={agents}
            gridMode={gridMode}
            key={w.key}
            onAct={onAct}
            onOpenLogs={onOpenLogs}
            onOpenTool={onOpenTool}
            onRemove={onRemove}
            onStart={onStart}
            pending={pendingStart.has(w.key)}
            toast={toast}
            w={w}
          />
        ))
      ) : (
        <p class="py-10 text-center text-sm text-zinc-400">{emptyMessage}</p>
      )}
    </div>
  );
}

// Compact, glanceable — how many concurrency slots are used and what a
// container is capped at, without turning the header into a metrics wall.
// Only renders once /api/status has actually returned something.
// A plaque, not inline text — the board-mono treatment (uppercase, tracked,
// bordered) reads as a fixed label you'd find bolted to a real dispatch
// board, not a passing status line.
function StatusStrip({
  status,
  loaded,
}: {
  status: Status | null;
  loaded: boolean;
}) {
  if (!status) {
    return (
      <span class="text-xs text-zinc-600 dark:text-zinc-300">
        {loaded ? 'Capacity unavailable' : 'Loading capacity…'}
      </span>
    );
  }
  const { concurrency, container } = status;
  return (
    <section
      aria-label="Server capacity"
      class="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-zinc-700 dark:text-zinc-200"
    >
      <span class="board-mono inline-flex items-stretch divide-x divide-zinc-300 border border-zinc-300 text-[11px] dark:divide-zinc-700 dark:border-zinc-700">
        <span
          class="tip flex items-center gap-1.5 px-2.5 py-1"
          data-tip={`${concurrency.active} of ${concurrency.max} dev server slots in use`}
        >
          <StatusDot
            tone={concurrency.active >= concurrency.max ? 'amber' : 'emerald'}
          />
          {concurrency.active} / {concurrency.max} running
          {concurrency.queued > 0 && (
            <span class="text-signal-amber">
              {' '}
              · {concurrency.queued} queued
            </span>
          )}
        </span>
        <span
          class={`tip flex items-center gap-1.5 px-2.5 py-1 ${container.engineAvailable ? '' : 'text-signal-amber'}`}
          data-tip={`${container.engineAvailable ? 'Effective' : 'Requested'} container limit`}
        >
          <StatusDot tone={container.engineAvailable ? 'emerald' : 'amber'} />
          {container.cpuLimit} cpu · {container.memoryLimit}
          {!container.engineAvailable && ' · engine unavailable'}
        </span>
      </span>
      <HostHealth initial={status.hostHealth} />
    </section>
  );
}

function HostHealth({ initial }: { initial: Status['hostHealth'] }) {
  const [read, setRead] = useState(() =>
    acceptHostStorage(initialHostStorageRead, initial)
  );
  const [reading, setReading] = useState(false);
  const request = useRef<AbortController | null>(null);
  useEffect(() => {
    if (initial) {
      setRead((previous) => acceptHostStorage(previous, initial));
    }
  }, [initial]);
  useEffect(() => () => request.current?.abort(), []);
  async function retry() {
    if (request.current) {
      return;
    }
    const controller = new AbortController();
    request.current = controller;
    setReading(true);
    try {
      const result = await readJson<Status>(
        '/api/status?refresh=1',
        controller.signal
      );
      if (!controller.signal.aborted) {
        setRead((previous) => acceptHostStorage(previous, result.hostHealth));
      }
    } catch {
      if (!controller.signal.aborted) {
        setRead((previous) => acceptHostStorage(previous));
      }
    } finally {
      if (!controller.signal.aborted) {
        setReading(false);
      }
      request.current = null;
    }
  }
  const view = hostStorageView(read);
  const { observation } = read;
  const filesystem =
    observation?.workspacePath ?? read.lastReady?.workspacePath;
  const volume = observation?.volumeId ?? read.lastReady?.volumeId;
  return (
    <div class="flex max-w-full flex-wrap items-center gap-x-4 gap-y-1">
      {view.tone && (
        <div
          class={`flex basis-full flex-wrap items-center gap-x-4 gap-y-1 border px-3 py-2 text-sm ${view.tone === 'red' ? 'border-red-300 bg-red-50/70 text-red-950 dark:border-red-800 dark:bg-red-950/40 dark:text-red-100' : 'border-amber-300 bg-amber-50/70 text-amber-950 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-100'}`}
          role="status"
        >
          <div class="min-w-0 grow basis-64">
            <strong>{view.title}</strong>
            <p>{view.detail}</p>
            {/* biome-ignore lint/suspicious/noUnnecessaryConditions: hostStorageView retains lastChecked as optional for unknown host observations even when the rendered tone is non-null. */}
            {view.lastChecked !== undefined && (
              <p class="text-xs">
                {view.summary}. Last successful check:{' '}
                {new Date(view.lastChecked).toLocaleTimeString()}.
              </p>
            )}
          </div>
          <button
            class="min-h-11 px-2 underline underline-offset-2"
            disabled={reading}
            onClick={retry}
            type="button"
          >
            {reading ? 'Checking…' : 'Check storage'}
          </button>
        </div>
      )}
      <details class="max-w-full">
        <summary class="cursor-pointer">Workspace disk: {view.summary}</summary>
        <div class="flex max-w-lg flex-col gap-1 break-words py-2">
          {filesystem && <span>Workspace filesystem: {filesystem}</span>}
          {volume && <span>Volume: {volume}</span>}
          {observation && (
            <span>
              Checked {new Date(observation.observedAt).toLocaleTimeString()}
              {observation.code ? ` · ${observation.code}` : ''}
            </span>
          )}
          <span>
            Docker VM storage: unknown. Engine availability is checked
            separately.
          </span>
          {observation?.lowThresholdBytes !== undefined && (
            <span>
              Warning below {formatStorageBytes(observation.lowThresholdBytes)}{' '}
              free.
            </span>
          )}
          {observation?.minimumAvailableBytes !== undefined && (
            <span>
              New disk-heavy work requires at least{' '}
              {formatStorageBytes(observation.minimumAvailableBytes)} free. This
              check does not reserve space or guarantee that a write will
              succeed.
            </span>
          )}
          {read.refreshFailed && (
            <span>
              Could not refresh workspace storage. The last successful
              measurement is retained; current space is unknown.
            </span>
          )}
          <div class="flex flex-wrap gap-3">
            {!view.tone && (
              <button
                class="min-h-11 px-2 underline"
                disabled={reading}
                onClick={retry}
                type="button"
              >
                {reading ? 'Checking…' : 'Check storage'}
              </button>
            )}
            {/* biome-ignore lint/a11y/useValidAnchor: Biome 2.5.6 rejects fragment hrefs with onClick; /help#storage is a real section and followRoute preserves modified-click navigation. */}
            <a
              class="inline-flex min-h-11 items-center px-2 underline"
              href="/help#storage"
              onClick={(e) => followRoute(e, '/help#storage')}
            >
              Storage help
            </a>
          </div>
        </div>
      </details>
    </div>
  );
}

function PendingCleanup({
  entries,
  busy,
  onRetry,
  onCancel,
}: {
  entries: PendingRemoval[];
  busy: Set<string>;
  onRetry: (entry: PendingRemoval) => void;
  onCancel: (entry: PendingRemoval) => void;
}) {
  if (!entries.length) {
    return null;
  }
  return (
    <Section id="pending-cleanup" title={`Cleanup pending (${entries.length})`}>
      <p class="mb-3 text-xs text-zinc-600 dark:text-zinc-300">
        All pending cleanup, across every project. These records are separate
        from active work and stopped-worktree filters.
      </p>
      <div class="flex flex-col gap-3">
        {entries.map((entry) => (
          <div
            class="flex flex-col gap-2 border border-amber-400/50 bg-amber-100/50 p-3 text-sm dark:bg-amber-900/20"
            key={entry.operationId}
          >
            <strong class="break-words">
              {entry.repo}/{entry.name}
            </strong>
            <p>
              {entry.removed
                ? 'Worktree was removed; remaining cleanup is pending.'
                : 'Removal needs attention; cleanup is pending.'}
            </p>
            <p class="break-words text-xs">Operation: {entry.operationId}</p>
            <p class="text-xs">Pending: {entry.pendingSteps.join(', ')}</p>
            {entry.error && (
              <p class="text-red-700 text-xs dark:text-red-300">
                {entry.error}
              </p>
            )}
            <Button
              class="self-start"
              disabled={busy.has(entry.operationId)}
              onClick={() => onRetry(entry)}
              variant="secondary"
            >
              {busy.has(entry.operationId)
                ? 'Retrying cleanup…'
                : 'Retry cleanup'}
            </Button>
            {!entry.removed && (
              <Button
                class="self-start"
                disabled={busy.has(entry.operationId)}
                onClick={() => onCancel(entry)}
                variant="secondary"
              >
                Cancel removal
              </Button>
            )}
          </div>
        ))}
      </div>
    </Section>
  );
}

// Home renders nothing below its header until the first snapshot, so the
// loaded layout appears at once instead of growing under the reader. Later
// refreshes and reconnects keep the last loaded UI (loaded never resets).
function InitialLoad() {
  const [connection, setConnection] = useState<ConnectionState>(() =>
    getWs().getState()
  );
  useEffect(() => getWs().onState(setConnection), []);
  if (connection.error) {
    return (
      <div class="read-notice" role="alert">
        {connection.error}{' '}
        <button
          class="underline"
          onClick={() => getWs().refresh()}
          type="button"
        >
          Retry
        </button>
      </div>
    );
  }
  return (
    <p class="empty-state" role="status">
      {connection.phase === 'reconnecting'
        ? 'Connecting to the portal…'
        : 'Loading worktrees…'}
    </p>
  );
}

function ConnectionIndicator() {
  const [connection, setConnection] = useState<ConnectionState>(() =>
    getWs().getState()
  );
  useEffect(() => getWs().onState(setConnection), []);
  const labels: Record<ConnectionState['phase'], string> = {
    current: 'Current',
    'last-received': 'Last received',
    paused: 'Updates paused',
    reconnecting: 'Reconnecting…',
    refreshing: 'Refreshing…',
    stale: 'Updates stale',
  };
  const retry =
    connection.phase === 'stale' ||
    connection.phase === 'reconnecting' ||
    !!connection.error;
  return (
    <div class="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-zinc-600 sm:ml-auto dark:text-zinc-300">
      <span role="status">
        {connection.error && connection.phase === 'current'
          ? 'Check failed'
          : labels[connection.phase]}
        {connection.error ? ` · ${connection.error}` : ''}
      </span>
      {connection.checkedAt !== undefined && (
        <span>
          {connection.listenerObservation?.state === 'unknown'
            ? 'Attempted'
            : 'Checked'}{' '}
          {new Date(connection.checkedAt).toLocaleTimeString()}
        </span>
      )}
      {connection.phase === 'last-received' && (
        <span title="This portal version does not report successful check times.">
          Check time unavailable
        </span>
      )}
      {retry && (
        <button
          class="underline underline-offset-2"
          onClick={() => getWs().refresh()}
          type="button"
        >
          Retry updates
        </button>
      )}
    </div>
  );
}

function PortalStatus({
  status,
  activeCount,
  loaded,
}: {
  status: Status | null;
  activeCount: number;
  loaded: boolean;
}) {
  return (
    <div class="portal-status flex flex-wrap items-center gap-x-4 gap-y-1 text-xs">
      {/* biome-ignore lint/a11y/useValidAnchor: Biome 2.5.6 rejects fragment hrefs with onClick; /#active-work is a real section and followRoute preserves modified-click navigation. */}
      <a
        class="font-semibold text-accent dark:text-emerald-300"
        href="/#active-work"
        onClick={(e) => followRoute(e, '/#active-work')}
      >
        Active work{loaded ? ` (${activeCount})` : ''}
      </a>
      <StatusStrip loaded={loaded} status={status} />
      {!!status?.pendingRemovals?.length && (
        // biome-ignore lint/a11y/useValidAnchor: Biome 2.5.6 rejects fragment hrefs with onClick; /#pending-cleanup is a real section and followRoute preserves modified-click navigation.
        <a
          class="text-amber-900 underline dark:text-amber-200"
          href="/#pending-cleanup"
          onClick={(e) => followRoute(e, '/#pending-cleanup')}
        >
          Cleanup pending ({status.pendingRemovals.length})
        </a>
      )}
      <ConnectionIndicator />
    </div>
  );
}

// Match the existing button treatment on Base UI menu triggers.
const TRIGGER_BUTTON_CLS = {
  primary:
    'inline-flex items-center justify-center gap-2 whitespace-normal text-center text-sm font-semibold rounded-none transition-colors duration-150 disabled:opacity-50 disabled:pointer-events-none px-4 py-2.5 bg-accent text-white border border-accent shadow-sm hover:bg-emerald-900 active:bg-emerald-950',
  secondaryCompact:
    'inline-flex items-center justify-center gap-2 whitespace-normal text-center text-sm font-semibold rounded-none transition-colors duration-150 disabled:opacity-50 disabled:pointer-events-none px-3 py-1.5 bg-white/55 dark:bg-white/5 border border-white/75 dark:border-white/10 text-ink dark:text-ink-dark shadow-sm hover:bg-white/85 dark:hover:bg-white/10 data-popup-open:bg-white/85',
};

function WorktreePage({
  w,
  loaded,
  pending,
  agents,
  onAct,
  onStart,
  onDeploy,
  onConvexDeploy,
  onOpenLogs,
  onOpenTool,
  onRemove,
  onRefresh,
  toast,
  tunnelBusy,
}: {
  w: Worktree | undefined;
  loaded: boolean;
  pending: boolean;
  agents: { id: string; label: string }[];
  onAct: (url: string, w: Worktree) => void;
  onStart: (w: Worktree, force?: 'container' | 'bare') => void;
  onDeploy: (w: Worktree, provider: DeployProvider, target: string) => void;
  onConvexDeploy: (w: Worktree, target: string) => void;
  onOpenLogs: (
    repo: string,
    name: string,
    type: string,
    returnFocus?: HTMLElement | null
  ) => void;
  onOpenTool: (w: Worktree, tool: string) => void;
  onRemove: (w: Worktree, reason?: 'manual' | 'merged') => void;
  onRefresh: () => void;
  toast: (msg: string, tone?: Tone) => void;
  tunnelBusy: boolean;
}) {
  // Distinguish "the initial /api/worktrees fetch hasn't resolved yet" (a
  // direct link or hard refresh always starts with an empty worktrees array)
  // from "this genuinely doesn't exist" — otherwise every fresh page load
  // flashes an incorrect "Not found" before the poll loop's first fetch lands.
  if (!w) {
    return (
      <div class="portal-page mx-auto max-w-4xl px-4 py-6 sm:px-6">
        <PageHeader
          back={{ label: 'All worktrees', onClick: () => navigate('/') }}
          title={loaded ? 'Not found' : 'Loading…'}
        />
        {loaded && (
          <p class="text-sm text-zinc-400">
            No worktree matches this URL — it may have been removed.
          </p>
        )}
      </div>
    );
  }

  const { tone: statusTone, text: statusText } = worktreeStatus(w);

  return (
    <div class="portal-page mx-auto max-w-4xl px-4 py-6 sm:px-6">
      {(function renderWorktreeHeader() {
        return (
          <>
            <PageHeader
              actions={
                <WorktreeActions
                  agents={agents}
                  onAct={onAct}
                  onOpenLogs={onOpenLogs}
                  onOpenTool={onOpenTool}
                  onRemove={onRemove}
                  onStart={onStart}
                  pending={pending}
                  toast={toast}
                  w={w}
                />
              }
              back={{ label: 'All worktrees', onClick: () => navigate('/') }}
              subtitle={
                <div class="flex flex-wrap items-center gap-2">
                  <span class="flex items-center gap-1.5">
                    <StatusDot pulse={w.active} tone={statusTone} />
                    <StatusFlap text={statusText} tone={statusTone} />
                  </span>
                  {queueWaitReason(w) && (
                    <span class="text-xs text-zinc-500">
                      {queueWaitReason(w)}
                    </span>
                  )}
                  <Badge tone="zinc">{w.label}</Badge>
                  {w.container && (w.active || w.starting) && (
                    <Badge tip="Real memory/CPU cap enforced" tone="zinc">
                      container
                    </Badge>
                  )}
                  {!(w.active || w.queued) && (
                    <Badge tone="zinc">→ {w.nextStartMode}</Badge>
                  )}
                </div>
              }
              title={w.name}
            />
            {worktreeIssue(w) && (
              <p class="mb-6 break-words text-signal-red text-sm" role="status">
                {worktreeIssue(w)}{' '}
                <button class="underline" onClick={onRefresh} type="button">
                  Refresh status
                </button>
              </p>
            )}

            {/* Distinct banner, not folded into the Overview grid below: this is
          the one PR state that asks for a decision (clean up or not), the
          others (open/closed/draft) are just informational. "Clean up
          worktree" calls the same onRemove as the Remove button at the
          bottom of this page, so it's still confirm()-gated and still
          leaves the branch alone, a shortcut to the existing flow, not a
          second one. */}
            {w.pr?.state === 'merged' && (
              <div class="mb-6 flex flex-wrap items-center justify-between gap-3 rounded-none border border-signal-green/30 bg-signal-green/5 px-4 py-3 text-sm">
                <span class="flex items-center gap-2 text-zinc-700 dark:text-zinc-300">
                  <StatusDot tone="emerald" />
                  PR #{w.pr.number} merged. Remove this checkout when its work
                  is finished.
                </span>
                <Button
                  compact
                  disabled={w.name === 'main'}
                  onClick={() => onRemove(w, 'merged')}
                  variant="secondary"
                >
                  Clean up worktree
                </Button>
              </div>
            )}
          </>
        );
      })()}

      {(function renderWorktreeOverview() {
        return (
          <>
            <Section
              actions={
                <Button
                  onClick={() => onAct('/api/sync', w)}
                  variant="secondary"
                >
                  Sync with base
                </Button>
              }
              title="Overview"
            >
              <div class="grid grid-cols-1 gap-4 text-sm sm:grid-cols-2 [&>*]:min-w-0 [&_a]:break-all [&_span]:break-words">
                <div>
                  <div class="mb-0.5 text-xs text-zinc-400">Local domain</div>
                  <a
                    class="font-mono text-zinc-700 transition-colors hover:text-accent dark:text-zinc-300"
                    href={`http://${w.domain}`}
                    rel="noopener"
                    target="_blank"
                  >
                    {w.domain}
                  </a>
                </div>
                {w.tunnelOn && (
                  <div>
                    <div class="mb-0.5 text-xs text-zinc-400">
                      Public tunnel
                    </div>
                    <span class="font-mono text-zinc-700 dark:text-zinc-300">
                      {w.pubDomain}
                    </span>
                  </div>
                )}
                {w.branchUrl && (
                  <div>
                    <div class="mb-0.5 text-xs text-zinc-400">Branch</div>
                    <a
                      class="text-zinc-700 transition-colors hover:text-accent dark:text-zinc-300"
                      href={w.branchUrl}
                      rel="noopener"
                      target="_blank"
                    >
                      {w.repo}/{w.name}
                    </a>
                  </div>
                )}
                {w.pr && (
                  <div class="min-w-0">
                    <div class="mb-0.5 text-xs text-zinc-400">Pull request</div>
                    <div class="flex min-w-0 items-center gap-2">
                      <a
                        class="truncate text-zinc-700 transition-colors hover:text-accent dark:text-zinc-300"
                        href={w.pr.url}
                        rel="noopener"
                        target="_blank"
                      >
                        PR #{w.pr.number} — {w.pr.title}
                      </a>
                      <Badge tone={prTone(w.pr.state)}>{w.pr.state}</Badge>
                      {(w.pr.state === 'open' || w.pr.state === 'draft') &&
                        w.pr.checks !== 'none' && (
                          <span
                            class="tip shrink-0"
                            data-tip={`checks: ${w.pr.checks}`}
                          >
                            <StatusDot
                              pulse={w.pr.checks === 'pending'}
                              tone={checksTone(w.pr.checks)}
                            />
                          </span>
                        )}
                    </div>
                  </div>
                )}
              </div>
            </Section>

            <Section title="Metrics">
              <div class="grid grid-cols-2 gap-4 text-sm">
                <div>
                  <div class="mb-0.5 text-xs text-zinc-400">Last commit</div>
                  <div>
                    {w.lastCommitAt ? relativeTime(w.lastCommitAt) : '—'}
                  </div>
                </div>
                <div>
                  <div class="mb-0.5 text-xs text-zinc-400">Created</div>
                  <div>{w.createdAt ? relativeTime(w.createdAt) : '—'}</div>
                </div>
                <div>
                  <div class="mb-0.5 text-xs text-zinc-400">
                    Ahead / behind base
                  </div>
                  <div class="font-mono">
                    ↑{w.ahead} ↓{w.behind}
                  </div>
                </div>
                <div>
                  <div class="mb-0.5 text-xs text-zinc-400">
                    Uncommitted changes
                  </div>
                  <div>{dirtyStatus(w.dirty)}</div>
                </div>
                {w.active && w.memMb !== null && w.memMb !== undefined && (
                  <div>
                    <div class="mb-0.5 text-xs text-zinc-400">
                      Resident memory
                    </div>
                    <div
                      class={
                        memTone(w.memMb) === 'amber' ? 'text-signal-amber' : ''
                      }
                    >
                      {formatMem(w.memMb)}
                    </div>
                  </div>
                )}
              </div>
            </Section>
          </>
        );
      })()}

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
        <DiffViewer dirty={w.dirty} name={w.name} repo={w.repo} />
      </Section>

      <PrReviewSection onOpenLogs={onOpenLogs} toast={toast} w={w} />

      <GithubActionsSection onRefresh={onRefresh} toast={toast} w={w} />

      <GithubWorkflowControls name={w.name} repo={w.repo} toast={toast} />

      <WorktreeResourceControls name={w.name} repo={w.repo} toast={toast} />

      {(function renderWorktreeSidecars() {
        return (
          <Section id="sidecars" title="Sidecars">
            <p class="mb-3 text-xs text-zinc-600 dark:text-zinc-300">
              {/* biome-ignore lint/a11y/useValidAnchor: Biome 2.5.6 rejects fragment hrefs with onClick; /help#sidecar-approval is a real section and followRoute preserves modified-click navigation. */}
              <a
                class="underline"
                href="/help#sidecar-approval"
                onClick={(e) => followRoute(e, '/help#sidecar-approval')}
              >
                Why a sidecar needs command approval
              </a>{' '}
              ·{' '}
              {/* biome-ignore lint/a11y/useValidAnchor: Biome 2.5.6 rejects fragment hrefs with onClick; /help#tunnel is a real section and followRoute preserves modified-click navigation. */}
              <a
                class="underline"
                href="/help#tunnel"
                onClick={(e) => followRoute(e, '/help#tunnel')}
              >
                Public tunnel help
              </a>
            </p>
            <div class="sidecar-controls flex flex-wrap items-center gap-4 text-sm">
              <div class="flex items-center gap-2">
                <SidecarIcon tool="inngest" />
                <StatusDot tone={w.inngestActive ? 'emerald' : 'zinc'} />
                <span>Inngest</span>
                {w.inngestActive ? (
                  <>
                    <a
                      class="text-emerald-600 text-xs hover:underline"
                      href={`http://localhost:${w.inngestPort}`}
                      rel="noopener"
                      target="_blank"
                    >
                      dashboard
                    </a>
                    <button
                      aria-label={`Stop Inngest for ${w.repo}/${w.name}`}
                      class="text-red-500 text-xs hover:underline"
                      onClick={() => onAct('/api/inngest/stop', w)}
                      type="button"
                    >
                      stop
                    </button>
                  </>
                ) : (
                  <button
                    aria-label={`Start Inngest for ${w.repo}/${w.name}`}
                    class="text-xs text-zinc-500 hover:underline"
                    onClick={() => onAct('/api/inngest/start', w)}
                    type="button"
                  >
                    start
                  </button>
                )}
              </div>
              <div class="flex items-center gap-2">
                <SidecarIcon tool="trigger" />
                <StatusDot tone={w.triggerActive ? 'emerald' : 'zinc'} />
                <span>trigger.dev</span>
                {w.triggerActive ? (
                  <button
                    aria-label={`Stop trigger.dev for ${w.repo}/${w.name}`}
                    class="text-red-500 text-xs hover:underline"
                    onClick={() => onAct('/api/trigger/stop', w)}
                    type="button"
                  >
                    stop
                  </button>
                ) : (
                  <button
                    aria-label={`Start trigger.dev for ${w.repo}/${w.name}`}
                    class="text-xs text-zinc-500 hover:underline"
                    onClick={() => onAct('/api/trigger/start', w)}
                    type="button"
                  >
                    start
                  </button>
                )}
              </div>
              <div class="flex items-center gap-2">
                <StatusDot tone={w.tunnelRunning ? 'emerald' : 'zinc'} />
                <span>Tunnel</span>
                <button
                  aria-label={`${w.tunnelOn ? 'Disable' : 'Enable'} tunnel for ${w.repo}/${w.name}`}
                  class="text-xs text-zinc-500 hover:underline"
                  disabled={tunnelBusy}
                  onClick={() =>
                    onAct(
                      w.tunnelOn ? '/api/tunnel/disable' : '/api/tunnel/enable',
                      w
                    )
                  }
                  type="button"
                >
                  {w.tunnelOn ? 'disable' : 'enable'}
                </button>
              </div>
              {/* Custom sidecars (sidecars.json) don't have their own start/stop
              route -- they're bundled into the worktree's own start/stop, so
              this is status-only, same as it actually is on the backend. */}
              {w.sidecars.map((s) => (
                <div class="flex items-center gap-2" key={s.name}>
                  <StatusDot tone={s.active ? 'emerald' : 'zinc'} />
                  <span>{s.name}</span>
                  {s.active && (
                    <button
                      aria-label={`View ${s.name} log for ${w.repo}/${w.name}`}
                      class="text-xs text-zinc-500 hover:underline"
                      onClick={() =>
                        onOpenLogs(w.repo, w.name, `sidecar-${s.name}`)
                      }
                      type="button"
                    >
                      log
                    </button>
                  )}
                </div>
              ))}
            </div>
          </Section>
        );
      })()}

      {/* Only rendered when this worktree actually has Convex configured --
          unlike the Sidecars Section above (Inngest/Trigger/Tunnel, assumed
          relevant everywhere), an empty Convex section on every worktree
          that doesn't use it would just be noise. */}
      <h2
        class="section-anchor mb-4 font-semibold text-base text-ink dark:text-ink-dark"
        id="deployments"
        tabIndex={-1}
      >
        Deployments
      </h2>
      {w.convexConfigured && (
        <ConvexSection
          onAct={onAct}
          onConvexDeploy={onConvexDeploy}
          onOpenLogs={onOpenLogs}
          w={w}
        />
      )}

      <DeploySection
        deploy={w.vercelDeploy}
        onDeploy={onDeploy}
        onOpenLogs={onOpenLogs}
        provider="vercel"
        w={w}
      />
      <DeploySection
        deploy={w.netlifyDeploy}
        onDeploy={onDeploy}
        onOpenLogs={onOpenLogs}
        provider="netlify"
        w={w}
      />

      <Section title="Dev server log">
        <LiveLog name={w.name} repo={w.repo} type="dev" />
      </Section>

      <button
        class="text-red-500 text-xs transition-colors duration-150 hover:text-red-700"
        disabled={w.name === 'main'}
        onClick={() => onRemove(w)}
        type="button"
      >
        {w.name === 'main' ? 'Remove unavailable for main' : 'Remove worktree'}
      </button>
      {w.name === 'main' && (
        <p class="mt-1 text-xs text-zinc-500">
          The main worktree holds shared local files such as .env.local. Remove
          the project instead.
        </p>
      )}
    </div>
  );
}

function fmtGb(mb: number | null | undefined) {
  return mb === null || mb === undefined
    ? '?'
    : `${(mb / 1024).toFixed(mb % 1024 ? 1 : 0)}GB`;
}

// One sidecar row — name/command/args/enabled, edited in place. The parent
// owns the array and re-saves the whole thing on "Save sidecars"; this is
// purely a controlled row, no independent state or its own save action.
function SidecarRow({
  s,
  index,
  onChange,
  onRemove,
  onApprove,
  disabled = false,
}: {
  s: Sidecar;
  index: number;
  disabled?: boolean;
  onChange: (s: Sidecar) => void;
  onRemove: () => void;
  onApprove: () => void;
}) {
  // approved is only meaningful for a row that's actually been saved and
  // fetched back (a brand-new unsaved row has approved === undefined, not
  // false, so it never shows the badge before there's anything to approve).
  const needsApproval =
    s.approved === false && s.enabled !== false && !!s.command;
  return (
    <fieldset class="flex min-w-0 flex-wrap items-end gap-2 border-zinc-100 border-b py-2 last:border-0 dark:border-zinc-800">
      <legend class="font-medium text-xs">Sidecar {s.name || index + 1}</legend>
      <label class="flex items-center gap-2 text-xs">
        <input
          checked={s.enabled !== false}
          class="accent-current"
          disabled={disabled}
          onChange={(e) => onChange({ ...s, enabled: e.currentTarget.checked })}
          style={{ accentColor: 'var(--color-accent)' }}
          type="checkbox"
        />
        Enabled
      </label>
      <label class="flex flex-col gap-1 text-xs">
        Name
        <input
          class={`${inputCls} w-28 py-1 text-xs`}
          disabled={disabled}
          onInput={(e) => onChange({ ...s, name: e.currentTarget.value })}
          value={s.name}
        />
      </label>
      <label class="flex min-w-40 flex-1 flex-col gap-1 text-xs">
        Command
        <input
          class={`${inputCls} w-full py-1 font-mono text-xs`}
          disabled={disabled}
          onInput={(e) => onChange({ ...s, command: e.currentTarget.value })}
          value={s.command}
        />
      </label>
      <label class="flex min-w-40 flex-1 flex-col gap-1 text-xs">
        Arguments (space-separated)
        <input
          class={`${inputCls} w-full py-1 font-mono text-xs`}
          disabled={disabled}
          onInput={(e) =>
            onChange({
              ...s,
              argsText: e.currentTarget.value,
            })
          }
          value={s.argsText ?? (s.args ?? []).join(' ')}
        />
      </label>
      {needsApproval && (
        <>
          <Badge
            tip="Command changed or never approved, will be skipped on Start until approved"
            tone="amber"
          >
            needs approval
          </Badge>
          <button
            class="text-emerald-600 text-xs hover:underline"
            disabled={disabled}
            onClick={onApprove}
            type="button"
          >
            Approve
          </button>
        </>
      )}
      <IconButton
        disabled={disabled}
        onClick={onRemove}
        tip={`Remove sidecar ${s.name || index + 1}`}
        tone="red"
      >
        <CloseIcon class="h-3.5 w-3.5" />
      </IconButton>
    </fieldset>
  );
}

// One custom-agent row — label/command edited in place. Same controlled-row
// shape as SidecarRow above: the parent owns the array and re-saves the
// whole list on "Save custom agents", this is purely a controlled row.
// `id` is intentionally not editable here — it's either the backend-assigned
// slug for an existing row (must round-trip unchanged on edit) or '' for a
// brand-new row (the backend assigns a slug on save).
function CustomAgentRow({
  a,
  index,
  onChange,
  onRemove,
  disabled = false,
}: {
  a: CustomAgent;
  index: number;
  disabled?: boolean;
  onChange: (a: CustomAgent) => void;
  onRemove: () => void;
}) {
  return (
    <fieldset class="flex min-w-0 flex-wrap items-end gap-2 border-zinc-100 border-b py-2 last:border-0 dark:border-zinc-800">
      <legend class="font-medium text-xs">
        Custom agent {a.label || index + 1}
      </legend>
      <label class="flex flex-col gap-1 text-xs">
        Label
        <input
          class={`${inputCls} w-28 py-1 text-xs`}
          disabled={disabled}
          onInput={(e) => onChange({ ...a, label: e.currentTarget.value })}
          value={a.label}
        />
      </label>
      <label class="flex min-w-40 flex-1 flex-col gap-1 text-xs">
        Command
        <input
          class={`${inputCls} w-full py-1 font-mono text-xs`}
          disabled={disabled}
          onInput={(e) => onChange({ ...a, command: e.currentTarget.value })}
          placeholder="mytool --flag"
          value={a.command}
        />
      </label>
      <IconButton
        disabled={disabled}
        onClick={onRemove}
        tip={`Remove custom agent ${a.label || index + 1}`}
        tone="red"
      >
        <CloseIcon class="h-3.5 w-3.5" />
      </IconButton>
    </fieldset>
  );
}

interface RepoPr {
  author: string | null;
  branch: string;
  checks: PrChecks;
  isDraft: boolean;
  number: number;
  title: string;
  updatedAt: string;
  url: string;
}
interface RepoPrsResponse {
  error: string | null;
  prs: RepoPr[];
}

// Repo-level overview: this repo's own worktrees, its open PRs (replacing
// the old RepoPrsModal bottom-sheet -- same fetch, page chrome instead of
// modal chrome), and a read-only summary of its sidecar/file-sync config.
// Editing that config still happens in Settings (loadSidecarsList/
// saveFileSyncGlobsList there own the actual save logic) rather than
// duplicating it here -- this page links out instead.
function RepoPage({
  repo,
  label,
  github,
  worktrees,
  loaded,
  agents,
  pendingStart,
  onAct,
  onStart,
  onDeploy,
  onOpenLogs,
  onOpenTool,
  onRemove,
  toast,
  onBack,
  onCreateWorktree,
  onCreateFromPr,
}: {
  repo: string;
  label: string;
  github?: string | null;
  worktrees: Worktree[];
  loaded: boolean;
  agents: { id: string; label: string }[];
  pendingStart: Set<string>;
  onAct: (url: string, w: Worktree) => void;
  onStart: (w: Worktree, force?: 'container' | 'bare') => void;
  onDeploy: (w: Worktree, provider: DeployProvider, target: string) => void;
  onOpenLogs: (
    repo: string,
    name: string,
    type: string,
    returnFocus?: HTMLElement | null
  ) => void;
  onOpenTool: (w: Worktree, tool: string) => void;
  onRemove: (w: Worktree, reason?: 'manual' | 'merged') => void;
  toast: (msg: string, tone?: Tone) => void;
  onBack: () => void;
  onCreateWorktree: () => void;
  onCreateFromPr: (repo: string, branch: string) => void;
}) {
  const [stoppedSearch, setStoppedSearch] = useState('');
  const [stoppedPage, setStoppedPage] = useState(0);
  const sidecarUrl = `/api/sidecars?repo=${encodeURIComponent(repo)}`;
  const fileSyncUrl = `/api/file-sync-globs?repo=${encodeURIComponent(repo)}`;
  const {
    data: sidecars,
    failed: sidecarsFailed,
    refresh: refreshSidecars,
  } = useVisiblePoll(sidecarUrl, null, (signal) =>
    readArray<Sidecar>(sidecarUrl, signal)
  );
  const {
    data: fileSyncGlobs,
    failed: fileSyncFailed,
    refresh: refreshFileSync,
  } = useVisiblePoll(fileSyncUrl, null, (signal) =>
    readArray<string>(fileSyncUrl, signal)
  );

  const prUrl = `/api/repo-prs?repo=${encodeURIComponent(repo)}`;
  const {
    data: prs,
    failed: prsFailed,
    refresh: loadPrs,
  } = useVisiblePoll(prUrl, null, async (signal) => {
    const result = await readJson<RepoPrsResponse>(prUrl, signal);
    if (!(result && Array.isArray(result.prs))) {
      throw new Error('Invalid PR response');
    }
    return result;
  });
  const repoWorktrees = worktrees.filter((w) => w.repo === repo);
  const list = projectWorktrees(repoWorktrees, {
    ahead: false,
    dirty: false,
    page: stoppedPage,
    project: 'all',
    search: stoppedSearch,
    sort: 'recent',
  });

  return (
    <div class="portal-page mx-auto max-w-4xl px-4 py-6 sm:px-6">
      <PageHeader
        actions={
          <Button compact onClick={onCreateWorktree} variant="primary">
            + Worktree
          </Button>
        }
        back={{ label: 'All worktrees', onClick: onBack }}
        subtitle={
          github ? (
            <a
              class="text-xs text-zinc-400 transition-colors duration-150 hover:text-accent"
              href={github}
              rel="noopener"
              target="_blank"
            >
              {github}
            </a>
          ) : undefined
        }
        title={label}
      />

      <section aria-labelledby="repo-active-title">
        <h2 class="mb-1 font-semibold" id="repo-active-title">
          Active in {label} ({list.active.length})
        </h2>
        <p class="mb-4 text-sm text-zinc-600 dark:text-zinc-300">
          Running, starting, stopping and queued work in this project.{' '}
          {/* biome-ignore lint/a11y/useValidAnchor: Biome 2.5.6 rejects fragment hrefs with onClick; /#active-work is a real section and followRoute preserves modified-click navigation. */}
          <a
            class="underline"
            href="/#active-work"
            onClick={(e) => followRoute(e, '/#active-work')}
          >
            View all active work
          </a>
        </p>
        <WorktreeList
          agents={agents}
          emptyMessage={repoActiveEmptyMessage(loaded)}
          gridMode={false}
          items={list.active}
          onAct={onAct}
          onDeploy={onDeploy}
          onOpenLogs={onOpenLogs}
          onOpenTool={onOpenTool}
          onRemove={onRemove}
          onStart={onStart}
          pendingStart={pendingStart}
          toast={toast}
        />
      </section>
      <section aria-labelledby="repo-stopped-title" class="mt-8">
        <h2 class="mb-3 font-semibold" id="repo-stopped-title">
          Stopped worktrees ({list.stoppedTotal})
        </h2>
        <label class="mb-4 block text-sm" htmlFor="repo-stopped-search">
          Search stopped worktrees
          <input
            class={`${inputCls} mt-2 block w-full`}
            id="repo-stopped-search"
            onInput={(e) => {
              setStoppedSearch(e.currentTarget.value);
              setStoppedPage(0);
            }}
            placeholder="Find a branch or domain…"
            value={stoppedSearch}
          />
        </label>
        <WorktreeList
          agents={agents}
          emptyMessage={repoStoppedEmptyMessage(loaded, stoppedSearch)}
          gridMode={false}
          items={list.pageRows}
          onAct={onAct}
          onDeploy={onDeploy}
          onOpenLogs={onOpenLogs}
          onOpenTool={onOpenTool}
          onRemove={onRemove}
          onStart={onStart}
          pendingStart={pendingStart}
          toast={toast}
        />
        <Pagination
          onPage={setStoppedPage}
          page={list.page}
          pageCount={list.pageCount}
        />
      </section>

      <div class="rail-divider my-8" />

      <Section
        actions={
          <Button compact onClick={loadPrs} variant="secondary">
            Refresh PRs
          </Button>
        }
        title="Pull requests"
      >
        {prsFailed && (
          <p class="read-notice" role="status">
            Could not refresh pull requests.{' '}
            {prs
              ? 'Showing the last received list.'
              : 'Use Refresh PRs to try again.'}
          </p>
        )}
        {(function renderPullRequestContent() {
          if (!prs) {
            return (
              !prsFailed && <p class="empty-state">Loading pull requests…</p>
            );
          }
          if (prs.error) {
            return (
              <p class="py-6 text-center text-signal-red text-sm">
                {prs.error}
              </p>
            );
          }
          if (prs.prs.length) {
            return prs.prs.map((pr) => {
              const match = repoWorktrees.find((w) => w.branch === pr.branch);
              return (
                <div
                  class="flex flex-wrap items-center gap-4 border-zinc-100 border-b py-3 last:border-0 dark:border-white/5"
                  key={pr.number}
                >
                  <div class="min-w-0 flex-1">
                    <div class="flex min-w-0 flex-wrap items-baseline gap-2">
                      <a
                        class="truncate font-medium text-zinc-900 transition-colors hover:text-accent dark:text-zinc-100"
                        href={pr.url}
                        rel="noopener"
                        target="_blank"
                      >
                        #{pr.number} — {pr.title}
                      </a>
                      {pr.isDraft && <Badge tone="amber">draft</Badge>}
                      {pr.checks !== 'none' && (
                        <span
                          class="tip shrink-0"
                          data-tip={`checks: ${pr.checks}`}
                        >
                          <StatusDot
                            pulse={pr.checks === 'pending'}
                            tone={checksTone(pr.checks)}
                          />
                        </span>
                      )}
                    </div>
                    <div class="mt-0.5 flex min-w-0 flex-wrap items-center gap-3 text-xs text-zinc-400">
                      <span class="truncate font-mono">{pr.branch}</span>
                      {pr.author && <span class="shrink-0">{pr.author}</span>}
                      {/* gh returns ISO8601; relativeTime takes unix seconds, not ms */}
                      <span class="shrink-0">
                        Updated{' '}
                        {relativeTime(new Date(pr.updatedAt).getTime() / 1000)}
                      </span>
                    </div>
                  </div>
                  {match ? (
                    <Button
                      compact
                      onClick={() =>
                        navigate(
                          `/worktree/${repo}/${encodeURIComponent(match.name)}`
                        )
                      }
                      variant="secondary"
                    >
                      Open
                    </Button>
                  ) : (
                    <Button
                      compact
                      onClick={() => onCreateFromPr(repo, pr.branch)}
                      variant="secondary"
                    >
                      Create worktree
                    </Button>
                  )}
                </div>
              );
            });
          }
          return (
            <p class="py-6 text-center text-sm text-zinc-400">
              No open PRs on this repo
            </p>
          );
        })()}
      </Section>

      <div class="rail-divider my-8" />

      <Section
        actions={
          <a
            class="text-accent text-xs transition-opacity duration-150 hover:opacity-80"
            href="/settings"
            onClick={(e: MouseEvent) => {
              e.preventDefault();
              navigate('/settings');
            }}
          >
            Edit in Settings →
          </a>
        }
        title="Sidecars & file sync"
      >
        <div class="flex flex-col gap-4 text-sm">
          <div>
            <div class="mb-1.5 text-xs text-zinc-400">Sidecars</div>
            {sidecarsFailed && (
              <p class="text-signal-red text-xs" role="status">
                Could not load sidecars.{' '}
                {sidecars ? 'Showing the last successful read. ' : ''}
                <button
                  class="underline"
                  onClick={refreshSidecars}
                  type="button"
                >
                  Retry
                </button>
              </p>
            )}
            {(function renderSidecarList() {
              if (!sidecars) {
                return (
                  !sidecarsFailed && (
                    <p class="text-xs text-zinc-400">Loading sidecars…</p>
                  )
                );
              }
              // A blank name/command row is an in-progress edit from the
              // Settings form (its own +Add sidecar default), not a real
              // sidecar -- startSidecars() (portal.js) applies the same
              // s.name-truthy filter when deciding what actually runs.
              const named = sidecars.filter((s) => s.name);
              return named.length ? (
                <div class="flex flex-wrap gap-1.5">
                  {named.map((s) => (
                    <Badge key={s.name} tone={s.approved ? 'emerald' : 'amber'}>
                      {s.name}
                      {s.approved ? '' : ' — needs approval'}
                    </Badge>
                  ))}
                </div>
              ) : (
                <p class="text-xs text-zinc-400">None configured</p>
              );
            })()}
          </div>
          <div>
            <div class="mb-1.5 text-xs text-zinc-400">File sync globs</div>
            {fileSyncFailed && (
              <p class="text-signal-red text-xs" role="status">
                Could not load file sync configuration.{' '}
                {fileSyncGlobs ? 'Showing the last successful read. ' : ''}
                <button
                  class="underline"
                  onClick={refreshFileSync}
                  type="button"
                >
                  Retry
                </button>
              </p>
            )}
            {(function renderFileSyncGlobs() {
              if (!fileSyncGlobs) {
                return (
                  !fileSyncFailed && (
                    <p class="text-xs text-zinc-400">
                      Loading file sync configuration…
                    </p>
                  )
                );
              }
              if (!fileSyncGlobs.length) {
                return <p class="text-xs text-zinc-400">None configured</p>;
              }
              return (
                <ul class="flex flex-col gap-0.5 font-mono text-xs text-zinc-600 dark:text-zinc-400">
                  {fileSyncGlobs.map((g) => (
                    <li key={g}>{g}</li>
                  ))}
                </ul>
              );
            })()}
          </div>
        </div>
      </Section>
    </div>
  );
}

function SettingsPage({
  toast,
}: {
  toast: (msg: string, tone?: Tone) => void;
}) {
  const [settings, setSettings] = useState<SettingsData | null>(null);
  const [resourceDraft, setResourceDraft] = useState<ResourceDraft | null>(
    null
  );
  const resource = useRef<ReturnType<typeof createResourceDraft> | null>(null);
  const [settingsError, setSettingsError] = useState<string | null>(null);
  const settingsRead = useRef<AbortController | null>(null);
  const [projects, setProjects] = useState<Project[]>([]);
  const [projectsLoaded, setProjectsLoaded] = useState(false);
  const [projectsError, setProjectsError] = useState<string | null>(null);
  const projectRead = useRef<AbortController | null>(null);
  const [addProjectOpen, setAddProjectOpen] = useState(false);
  const [sidecarRepo, setSidecarRepo] = useState('');
  const [fileSyncRepo, setFileSyncRepo] = useState('');
  const [pendingNavigation, setPendingNavigation] = useState<
    (() => void) | null
  >(null);
  const [leaving, setLeaving] = useState(false);
  const mounted = useRef(true);

  const sidecarDraft = useSavedDraft<Sidecar[]>(
    sidecarRepo,
    [],
    (signal) =>
      sidecarRepo
        ? readArray<Sidecar>(
            `/api/sidecars?repo=${encodeURIComponent(sidecarRepo)}`,
            signal
          )
        : Promise.resolve([]),
    '/api/sidecars',
    (rows) => ({
      repo: sidecarRepo,
      sidecars: rows.map(({ argsText, ...row }) => ({
        ...row,
        args: sidecarArguments(argsText ?? (row.args ?? []).join(' ')),
        name: row.name.trim(),
      })),
    }),
    (rows) =>
      rows.some((s) => !(s.name.trim() && s.command.trim()))
        ? 'Each sidecar needs a name and command.'
        : (rows.map((s) => sidecarNameError(s.name)).find(Boolean) ??
          (new Set(rows.map((s) => s.name.trim())).size === rows.length
            ? null
            : 'Sidecar names must be unique.')),
    (rows) =>
      JSON.stringify(
        rows.map(({ approved, argsText, ...row }) => ({
          ...row,
          args: sidecarArguments(argsText ?? (row.args ?? []).join(' ')),
          name: row.name.trim(),
        }))
      )
  );
  const fileDraft = useSavedDraft<string>(
    fileSyncRepo,
    '',
    async (signal) =>
      fileSyncRepo
        ? (
            await readArray<string>(
              `/api/file-sync-globs?repo=${encodeURIComponent(fileSyncRepo)}`,
              signal
            )
          ).join('\n')
        : '',
    '/api/file-sync-globs',
    (text) => ({
      globs: fileSyncPatterns(text),
      repo: fileSyncRepo,
    })
  );
  const agentDraft = useSavedDraft<CustomAgent[]>(
    'custom-agents',
    [],
    (signal) => readArray<CustomAgent>('/api/custom-agents', signal),
    '/api/custom-agents',
    (agents) => ({ agents }),
    (rows) =>
      rows.some((a) => !(a.label.trim() && a.command.trim()))
        ? 'Each custom agent needs a label and command.'
        : null
  );
  const sidecars = sidecarDraft.draft,
    setSidecars = sidecarDraft.update,
    sidecarsSaving = sidecarDraft.saving;
  const fileSyncText = fileDraft.draft,
    setFileSyncText = fileDraft.update,
    fileSyncSaving = fileDraft.saving;
  const customAgents = agentDraft.draft,
    setCustomAgents = agentDraft.update,
    customAgentsSaving = agentDraft.saving;
  const saving = Object.values(resourceDraft ?? {}).some(
    (row) => row.state === 'saving'
  );

  const loadProjects = useCallback(async () => {
    if (projectRead.current) {
      return;
    }
    const controller = new AbortController();
    projectRead.current = controller;
    try {
      const ps = await readArray<Project>('/api/projects', controller.signal);
      if (!mounted.current) {
        return;
      }
      setProjects(ps);
      setProjectsLoaded(true);
      setProjectsError(null);
      setSidecarRepo((repo) => repo || ps[0]?.name || '');
      setFileSyncRepo((repo) => repo || ps[0]?.name || '');
    } catch {
      if (mounted.current) {
        setProjectsError('Could not load registered projects.');
      }
    } finally {
      projectRead.current = null;
    }
  }, []);

  const loadSettings = useCallback(async () => {
    if (settingsRead.current) {
      return;
    }
    const controller = new AbortController();
    settingsRead.current = controller;
    try {
      const value = await readJson<SettingsData>(
        '/api/settings',
        controller.signal
      );
      if (!mounted.current) {
        return;
      }
      setSettings(value);
      setSettingsError(null);
      if (!resource.current) {
        resource.current = createResourceDraft(value, {
          publish: (draft) => {
            if (mounted.current) {
              setResourceDraft(draft);
            }
          },
          read: async () => {
            const readback = await readJson<SettingsData>(
              '/api/settings',
              new AbortController().signal
            );
            if (mounted.current) {
              setSettings(readback);
            }
            return readback;
          },
          write: (patch) => post('/api/settings', patch),
        });
        setResourceDraft(resource.current.get());
      }
    } catch {
      if (mounted.current) {
        setSettingsError('Could not load settings.');
      }
    } finally {
      settingsRead.current = null;
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    loadSettings();
    loadProjects();
    return () => {
      mounted.current = false;
      settingsRead.current?.abort();
      projectRead.current?.abort();
      resource.current?.stop();
    };
  }, []);

  const hasDrafts = () =>
    sidecarDraft.isDirty() ||
    fileDraft.isDirty() ||
    agentDraft.isDirty() ||
    Object.values(resource.current?.get() ?? {}).some(
      (row) => row.state !== 'saved'
    );
  function requestNavigation(proceed: () => void) {
    if (!hasDrafts()) {
      return false;
    }
    setPendingNavigation(() => proceed);
    return true;
  }
  useEffect(() => {
    navigationGuard = requestNavigation;
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if (hasDrafts()) {
        event.preventDefault();
        event.returnValue = '';
      }
    };
    window.addEventListener('beforeunload', beforeUnload);
    return () => {
      if (navigationGuard === requestNavigation) {
        navigationGuard = null;
      }
      window.removeEventListener('beforeunload', beforeUnload);
    };
  });
  function switchRepo(setRepo: (repo: string) => void, next: string) {
    const proceed = () => setRepo(next);
    if (!requestNavigation(proceed)) {
      proceed();
    }
  }
  async function saveAndLeave() {
    if (leaving || saving) {
      return;
    }
    setLeaving(true);
    const okay =
      (resource.current ? await resource.current.saveAll() : true) &&
      (!sidecarDraft.isDirty() || (await sidecarDraft.save())) &&
      (!fileDraft.isDirty() || (await fileDraft.save())) &&
      (!agentDraft.isDirty() || (await agentDraft.save()));
    setLeaving(false);
    if (!okay || hasDrafts()) {
      return;
    }
    const proceed = pendingNavigation;
    setPendingNavigation(null);
    proceed?.();
  }
  function discardAndLeave() {
    sidecarDraft.discard();
    fileDraft.discard();
    agentDraft.discard();
    resource.current?.discard();
    const proceed = pendingNavigation;
    setPendingNavigation(null);
    proceed?.();
  }
  async function removeProject(name: string) {
    if (
      // biome-ignore lint/suspicious/noAlert: This confirmation gates removal from the project registry below.
      !confirm(
        `Remove project "${name}"? Existing worktrees keep working. This only drops it from the registry.`
      )
    ) {
      return;
    }
    await postOrToast('/api/project/remove', { name }, toast, 'remove failed');
    loadProjects();
  }
  const saveSidecarsList = () => sidecarDraft.save();
  const saveFileSyncGlobsList = () => fileDraft.save();
  const saveCustomAgentsList = () => agentDraft.save();
  async function approveSidecarRow(sidecar: Sidecar) {
    if (sidecarDraft.dirty) {
      toast(
        'Save sidecar changes before approving the saved command.',
        'amber'
      );
      return;
    }
    const result = await postOrToast(
      '/api/sidecar-approvals/approve',
      {
        args: sidecarArguments(
          sidecar.argsText ?? (sidecar.args ?? []).join(' ')
        ),
        command: sidecar.command,
        name: sidecar.name,
        repo: sidecarRepo,
      },
      toast,
      'approve failed'
    );
    if (result.ok) {
      sidecarDraft.reload();
    }
  }
  function resourceInput(field: ResourceField) {
    const row = (resourceDraft as ResourceDraft)[field];
    return {
      'aria-describedby': `${field}-status resource-autosave-help`,
      'aria-invalid': row.state === 'error',
      onBlur: () => resource.current?.save(field),
      onInput: (event: JSX.TargetedEvent<HTMLInputElement>) =>
        resource.current?.edit(field, event.currentTarget.value),
      onKeyDown: (event: KeyboardEvent) => {
        if (event.key === 'Enter' && !event.isComposing) {
          event.preventDefault();
          resource.current?.save(field);
        }
      },
      value: row.text,
    };
  }
  function resourceStatus(field: ResourceField) {
    const row = (resourceDraft as ResourceDraft)[field];
    let status = 'Could not save';
    if (row.state === 'saved') {
      status = 'Saved';
    }
    if (row.state === 'dirty') {
      status = 'Unsaved changes';
    }
    if (row.state === 'saving') {
      status = 'Saving…';
    }
    return (
      <p
        class={`mt-1 text-xs ${row.state === 'error' ? 'text-red-700 dark:text-red-300' : 'text-zinc-600 dark:text-zinc-300'}`}
        id={`${field}-status`}
        role="status"
      >
        {row.message ?? status}
        {row.state === 'error' && (
          <button
            class="ml-2 underline"
            onClick={() => resource.current?.save(field)}
            type="button"
          >
            Retry
          </button>
        )}
        {settings && row.state !== 'saved' && (
          <span> · Saved value: {String(settings[field])}</span>
        )}
      </p>
    );
  }
  function draftStatus(draft: {
    loaded: boolean;
    dirty: boolean;
    error: string | null;
    message: string | null;
    reload: () => Promise<boolean>;
  }) {
    let status = draft.message ?? (draft.loaded ? '' : 'Loading…');
    if (draft.dirty) {
      status = 'Unsaved changes';
    }
    if (draft.error) {
      status = `${draft.message ? `${draft.message} ` : ''}${draft.error}`;
    }
    return (
      <p
        class={`text-xs ${draft.error ? 'text-red-700 dark:text-red-300' : 'text-zinc-600 dark:text-zinc-300'}`}
        role="status"
      >
        {status}
        {draft.error && (
          <button
            class="ml-2 underline"
            onClick={() => draft.reload()}
            type="button"
          >
            Refresh saved values
          </button>
        )}
      </p>
    );
  }

  return (
    <div class="portal-page mx-auto max-w-4xl px-4 py-6 sm:px-6">
      <PageHeader
        back={{ label: 'All worktrees', onClick: () => navigate('/') }}
        title="Settings"
      />

      <nav aria-label="Settings sections" class="section-navigation">
        {[
          ['resource-settings', 'Resources'],
          ['project-settings', 'Projects'],
          ['sidecar-settings', 'Sidecars'],
          ['file-sync-settings', 'File sync'],
          ['agent-settings', 'Coding agents'],
          ['mcp-settings', 'MCP'],
          ['raycast-settings', 'Raycast'],
        ].map(([id, label]) => (
          <a href={`#${id}`} key={id}>
            {label}
          </a>
        ))}
      </nav>
      <Section id="resource-settings" title="Concurrency & container limits">
        {settingsError && (
          <p class="text-red-700 text-sm dark:text-red-300" role="status">
            {settingsError}{' '}
            <button class="underline" onClick={loadSettings} type="button">
              Retry
            </button>
          </p>
        )}
        {settings && resourceDraft ? (
          <div class="flex flex-col gap-5 text-sm">
            <div>
              <label
                class="mb-2 flex flex-wrap items-center justify-between gap-2 text-sm text-zinc-600 dark:text-zinc-300"
                htmlFor="max-dev-servers"
              >
                <span>Max concurrent dev servers</span>
                <span class="text-zinc-400">
                  Mac: {settings.mac.cpus ?? '?'} cores,{' '}
                  {fmtGb(settings.mac.memMb)} RAM
                </span>
              </label>
              <input
                id="max-dev-servers"
                max={64}
                min={1}
                type="number"
                {...resourceInput('maxConcurrentDevServers')}
                class={`${inputCls} w-24`}
              />
              {resourceStatus('maxConcurrentDevServers')}
            </div>
            <div>
              <label
                class="mb-2 flex flex-wrap items-center justify-between gap-2 text-sm text-zinc-600 dark:text-zinc-300"
                htmlFor="container-memory"
              >
                <span>Requested container memory limit</span>
                <span class="text-zinc-400">
                  Docker engine: {settings.docker.cpus ?? '?'} cores,{' '}
                  {fmtGb(settings.docker.memMb)} available
                </span>
              </label>
              <input
                id="container-memory"
                placeholder="4g"
                {...resourceInput('containerMemoryLimit')}
                class={`${inputCls} w-24`}
              />
              {resourceStatus('containerMemoryLimit')}
              <p class="mt-1 text-[11px] text-zinc-400">
                Setu queues starts to fit the engine CPU budget and 90% of its
                memory. Limits apply to new starts.
              </p>
            </div>
            <div>
              <label
                class="mb-1 block text-xs text-zinc-500"
                htmlFor="container-cpu"
              >
                Requested container CPU limit
              </label>
              <input
                id="container-cpu"
                max={1024}
                min={0.01}
                step="any"
                type="number"
                {...resourceInput('containerCpuLimit')}
                class={`${inputCls} w-24`}
              />
              {resourceStatus('containerCpuLimit')}
            </div>
            <p
              class="text-xs text-zinc-600 dark:text-zinc-300"
              id="resource-autosave-help"
            >
              Changes save when you leave a field or press Enter. Limits apply
              to new starts.{' '}
              {/* biome-ignore lint/a11y/useValidAnchor: Biome 2.5.6 rejects fragment hrefs with onClick; /help#capacity is a real section and followRoute preserves modified-click navigation. */}
              <a
                class="underline"
                href="/help#capacity"
                onClick={(e) => followRoute(e, '/help#capacity')}
              >
                How capacity works
              </a>
            </p>
          </div>
        ) : (
          !settingsError && <p class="text-sm text-zinc-400">Loading…</p>
        )}
      </Section>

      <Section
        actions={
          <Button onClick={() => setAddProjectOpen(true)} variant="secondary">
            + Project
          </Button>
        }
        id="project-settings"
        title="Projects"
      >
        {projectsError && (
          <p class="text-red-700 text-sm dark:text-red-300" role="status">
            {projectsError}{' '}
            <button class="underline" onClick={loadProjects} type="button">
              Retry
            </button>
          </p>
        )}
        {(function renderProjects() {
          if (!projectsLoaded) {
            return !projectsError && <p>Loading projects…</p>;
          }
          if (!projects.length) {
            return (
              <p class="text-sm text-zinc-400">
                No projects registered yet. Click + Project to add one.
              </p>
            );
          }
          return (
            <div class="flex flex-col divide-y divide-zinc-100 dark:divide-zinc-800">
              {projects.map((p) => (
                <div
                  class="flex min-w-0 flex-wrap items-center gap-3 py-3 text-sm"
                  key={p.name}
                >
                  <span class="flex-1 font-medium text-zinc-900 dark:text-zinc-100">
                    {p.label}
                  </span>
                  {p.github && (
                    <a
                      class="max-w-[240px] truncate text-xs text-zinc-400 hover:text-accent"
                      href={p.github}
                      rel="noopener"
                      target="_blank"
                    >
                      {p.github}
                    </a>
                  )}
                  <button
                    class="text-red-500 text-xs transition-colors duration-150 hover:text-red-700"
                    onClick={() => removeProject(p.name)}
                    type="button"
                  >
                    Remove
                  </button>
                </div>
              ))}
            </div>
          );
        })()}
      </Section>

      <DiscoverProjectsSection onImported={loadProjects} toast={toast} />

      <Section
        actions={
          projects.length > 1 && (
            <select
              aria-label="Project for sidecars"
              class={`${inputCls} py-1 text-xs`}
              onChange={(e) =>
                switchRepo(setSidecarRepo, e.currentTarget.value)
              }
              value={sidecarRepo}
            >
              {projects.map((p) => (
                <option key={p.name} value={p.name}>
                  {p.label}
                </option>
              ))}
            </select>
          )
        }
        id="sidecar-settings"
        title="Sidecars"
      >
        {(function renderSidecarSettings() {
          if (!projectsLoaded) {
            return (
              <p class="text-sm text-zinc-600 dark:text-zinc-300">
                {projectsError
                  ? 'Project list unavailable. Retry the Projects section above.'
                  : 'Loading projects…'}
              </p>
            );
          }
          if (!projects.length) {
            return <p class="text-sm text-zinc-400">Add a project first.</p>;
          }
          return (
            <div class="flex flex-col gap-2">
              {draftStatus(sidecarDraft)}
              {sidecars.map((s, i) => (
                <SidecarRow
                  disabled={!sidecarDraft.loaded}
                  index={i}
                  key={i}
                  onApprove={() => approveSidecarRow(s)}
                  onChange={(next) =>
                    setSidecars((list) =>
                      list.map((x, j) =>
                        j === i ? { ...next, approved: false } : x
                      )
                    )
                  }
                  onRemove={() =>
                    setSidecars(sidecars.filter((_, j) => j !== i))
                  }
                  s={s}
                />
              ))}
              <div class="flex flex-wrap items-center gap-3 pt-2">
                <Button
                  disabled={!sidecarDraft.loaded}
                  onClick={() =>
                    setSidecars((list) => [
                      ...list,
                      { args: [], command: '', enabled: true, name: '' },
                    ])
                  }
                  variant="secondary"
                >
                  + Add sidecar
                </Button>
                <Button
                  disabled={
                    sidecarsSaving ||
                    !sidecarDraft.loaded ||
                    !sidecarDraft.dirty
                  }
                  onClick={saveSidecarsList}
                  variant="primary"
                >
                  {sidecarsSaving ? 'Saving…' : 'Save sidecars'}
                </Button>
              </div>
              <p class="mt-1 text-[11px] text-zinc-400">
                Runs alongside the dev server on Start — for anything that isn't
                Inngest/trigger.dev/tunnel, which already have first-class
                controls on each worktree's page.
              </p>
            </div>
          );
        })()}
      </Section>

      <Section
        actions={
          projects.length > 1 && (
            <select
              aria-label="Project for file sync"
              class={`${inputCls} py-1 text-xs`}
              onChange={(e) =>
                switchRepo(setFileSyncRepo, e.currentTarget.value)
              }
              value={fileSyncRepo}
            >
              {projects.map((p) => (
                <option key={p.name} value={p.name}>
                  {p.label}
                </option>
              ))}
            </select>
          )
        }
        id="file-sync-settings"
        title="File Sync"
      >
        {(function renderFileSyncSettings() {
          if (!projectsLoaded) {
            return (
              <p class="text-sm text-zinc-600 dark:text-zinc-300">
                {projectsError
                  ? 'Project list unavailable. Retry the Projects section above.'
                  : 'Loading projects…'}
              </p>
            );
          }
          if (!projects.length) {
            return <p class="text-sm text-zinc-400">Add a project first.</p>;
          }
          return (
            <div class="flex flex-col gap-2">
              {draftStatus(fileDraft)}
              <label
                class="text-xs text-zinc-600 dark:text-zinc-300"
                htmlFor="file-sync-patterns"
              >
                Files to copy into new worktrees for {fileSyncRepo}
              </label>
              <textarea
                class={`${inputCls} w-full py-1 font-mono text-xs`}
                disabled={!fileDraft.loaded}
                id="file-sync-patterns"
                onInput={(e) => setFileSyncText(e.currentTarget.value)}
                placeholder="*.local.json&#10;config/local.json"
                rows={3}
                value={fileSyncText}
              />
              <div class="flex flex-wrap items-center gap-3 pt-2">
                <Button
                  disabled={
                    fileSyncSaving || !fileDraft.loaded || !fileDraft.dirty
                  }
                  onClick={saveFileSyncGlobsList}
                  variant="primary"
                >
                  {fileSyncSaving ? 'Saving…' : 'Save file sync'}
                </Button>
              </div>
              <p class="mt-1 text-[11px] text-zinc-400">
                Newline-separated glob patterns. Matching gitignored files are
                copied (not symlinked, unlike .env.local) from the main worktree
                into every newly created worktree, so each one gets its own
                editable copy. Patterns resolve against the main worktree's
                root, not an app subdir — for quivly-app include the subdir,
                e.g. apps/quivly-app/.env.development.local.
              </p>
            </div>
          );
        })()}
      </Section>

      <Section id="agent-settings" title="Custom Agents">
        <div class="flex flex-col gap-2">
          {draftStatus(agentDraft)}
          {customAgents.map((a, i) => (
            <CustomAgentRow
              a={a}
              disabled={!agentDraft.loaded}
              index={i}
              key={i}
              onChange={(next) =>
                setCustomAgents((list) =>
                  list.map((x, j) => (j === i ? next : x))
                )
              }
              onRemove={() =>
                setCustomAgents(customAgents.filter((_, j) => j !== i))
              }
            />
          ))}
          <div class="flex flex-wrap items-center gap-3 pt-2">
            <Button
              disabled={!agentDraft.loaded}
              onClick={() =>
                setCustomAgents((list) => [
                  ...list,
                  { command: '', id: '', label: '' },
                ])
              }
              variant="secondary"
            >
              + Add custom agent
            </Button>
            <Button
              disabled={
                customAgentsSaving || !agentDraft.loaded || !agentDraft.dirty
              }
              onClick={saveCustomAgentsList}
              variant="primary"
            >
              {customAgentsSaving ? 'Saving…' : 'Save custom agents'}
            </Button>
          </div>
          <p class="mt-1 text-[11px] text-zinc-400">
            Shows up in every worktree's "Open in" row alongside
            Claude/Cursor/etc. Not <span class="font-mono">which</span>-checked
            — make sure the command actually runs.
          </p>
        </div>
      </Section>

      <div class="section-anchor" id="mcp-settings" tabIndex={-1}>
        <McpSection toast={toast} />
      </div>

      <div class="section-anchor" id="raycast-settings" tabIndex={-1}>
        <RaycastSection toast={toast} />
      </div>

      {addProjectOpen && (
        <AddProjectModal
          onAdded={loadProjects}
          onClose={() => setAddProjectOpen(false)}
        />
      )}
      {pendingNavigation && (
        <Dialog
          onOpenChange={(open) => {
            if (!(open || leaving)) {
              setPendingNavigation(null);
            }
          }}
          open
        >
          <DialogContent>
            <DialogTitle class="font-semibold text-base">
              Save your settings changes?
            </DialogTitle>
            <DialogDescription class="mt-2 text-sm text-zinc-600 dark:text-zinc-300">
              You have unsaved changes. Save them before leaving, discard the
              draft, or stay here to continue editing.
            </DialogDescription>
            <div class="mt-5 flex flex-wrap gap-2">
              <Button disabled={leaving || saving} onClick={saveAndLeave}>
                {leaving || saving ? 'Saving…' : 'Save and continue'}
              </Button>
              <Button
                disabled={
                  leaving ||
                  saving ||
                  sidecarsSaving ||
                  fileSyncSaving ||
                  customAgentsSaving
                }
                onClick={discardAndLeave}
                variant="secondary"
              >
                Discard changes
              </Button>
              <Button
                disabled={leaving}
                onClick={() => setPendingNavigation(null)}
                variant="secondary"
              >
                Stay here
              </Button>
            </div>
          </DialogContent>
        </Dialog>
      )}
    </div>
  );
}

// Human phrasing for each endpoint act() posts to, only used to name what
// failed in the toast (postOrToast still appends the server's own reason).
// Matches the wording already used for the same action elsewhere (menu
// items, section buttons) instead of echoing the raw url path fragment.
const ACT_LABEL: Record<string, string> = {
  '/api/convex/start': 'Start Convex dev',
  '/api/convex/stop': 'Stop Convex dev',
  '/api/inngest/start': 'Start Inngest',
  '/api/inngest/stop': 'Stop Inngest',
  '/api/stop': 'Stop server',
  '/api/sync': 'Sync with base',
  '/api/trigger/start': 'Start trigger.dev',
  '/api/trigger/stop': 'Stop trigger.dev',
  '/api/tunnel/disable': 'Disable tunnel',
  '/api/tunnel/enable': 'Enable tunnel',
};

function DeploymentDialog({
  state,
  onClose,
  onConfirm,
  onRefresh,
  returnFocus,
}: {
  state: DeploymentIntentState;
  onClose: () => void;
  onConfirm: () => void;
  onRefresh: () => void;
  returnFocus: { current: HTMLElement | null };
}) {
  const cancel = useRef<HTMLButtonElement>(null);
  const { intent, context, phase } = state;
  if (!intent || phase === 'idle') {
    return null;
  }
  const production =
    state.requiresConfirmation ||
    (context ? context.destination.environment === 'production' : false) ||
    intent.target === 'production';
  const labels = { convex: 'Convex', netlify: 'Netlify', vercel: 'Vercel' };
  return (
    <Dialog
      onOpenChange={(open) => {
        if (!open) {
          onClose();
        }
      }}
      open
    >
      <DialogContent
        class="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-lg"
        finalFocus={() =>
          phase !== 'submitting' && returnFocus.current?.isConnected
            ? returnFocus.current
            : (document.getElementById('page-title') ??
              document.getElementById('jump-to-worktree') ??
              true)
        }
        initialFocus={cancel}
      >
        <DialogTitle class="font-semibold text-base">
          {deploymentDialogTitle(phase, production)}
        </DialogTitle>
        <DialogDescription class="mt-2 text-sm text-zinc-600 dark:text-zinc-300">
          {phase === 'submitting'
            ? 'The request is being submitted. Closing this dialog does not cancel deployment.'
            : 'The portal checks the exact destination again before dispatch. This confirmation does not freeze the files in your checkout.'}
        </DialogDescription>
        <dl class="my-5 grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-2 text-sm">
          <dt class="text-zinc-600 dark:text-zinc-300">Provider</dt>
          <dd>{labels[intent.provider]}</dd>
          <dt class="text-zinc-600 dark:text-zinc-300">Worktree</dt>
          <dd class="break-words">
            {intent.repo}/{intent.name}
          </dd>
          <dt class="text-zinc-600 dark:text-zinc-300">Requested target</dt>
          <dd class="break-words">{intent.target}</dd>
          {context && (
            <>
              <dt class="text-zinc-600 dark:text-zinc-300">Actual branch</dt>
              <dd class="break-words">{context.branch}</dd>
              <dt class="text-zinc-600 dark:text-zinc-300">Destination</dt>
              <dd class="break-words">
                {context.destination.label}
                <span class="mt-1 block text-xs">{context.destination.id}</span>
              </dd>
              <dt class="text-zinc-600 dark:text-zinc-300">Environment</dt>
              <dd class="break-words">{context.destination.environment}</dd>
              {context.destination.projectId && (
                <>
                  <dt class="text-zinc-600 dark:text-zinc-300">Project</dt>
                  <dd class="break-words">{context.destination.projectId}</dd>
                </>
              )}
              {context.destination.orgId && (
                <>
                  <dt class="text-zinc-600 dark:text-zinc-300">Organization</dt>
                  <dd class="break-words">{context.destination.orgId}</dd>
                </>
              )}
            </>
          )}
        </dl>
        {state.message && (
          <p
            class={`mb-4 text-sm ${phase === 'ready' || phase === 'reading' ? 'text-amber-900 dark:text-amber-200' : 'text-red-700 dark:text-red-300'}`}
            role="status"
          >
            {state.message}
          </p>
        )}
        {context && (
          <p class="mb-4 text-xs text-zinc-600 dark:text-zinc-300">
            Checkout identity and current deployment state were verified by the
            portal. Provider approval rules still apply.
          </p>
        )}
        <div class="flex flex-wrap gap-2">
          <button
            class={TRIGGER_BUTTON_CLS.secondaryCompact}
            onClick={onClose}
            ref={cancel}
            type="button"
          >
            {phase === 'submitting' || phase === 'uncertain'
              ? 'Close'
              : 'Cancel'}
          </button>
          {(phase === 'error' || phase === 'uncertain') && (
            <Button onClick={onRefresh} variant="secondary">
              {deploymentRefreshLabel(phase)}
            </Button>
          )}
          <Button disabled={phase !== 'ready'} onClick={onConfirm}>
            {deploymentActionLabel(phase, production, context, intent)}
          </Button>
        </div>
        <a
          class="mt-4 inline-block text-xs text-zinc-600 underline dark:text-zinc-300"
          href="/help#production"
          rel="noopener"
          target="_blank"
        >
          Deployment confirmation help
        </a>
      </DialogContent>
    </Dialog>
  );
}

function App() {
  const route = useRoute();
  const [worktrees, setWorktrees] = useState<Worktree[]>([]);
  const [loaded, setLoaded] = useState(false);
  const {
    data: projectData,
    failed: projectReadFailed,
    refresh: loadProjects,
  } = useVisiblePoll('projects', null, (signal) =>
    readArray<Project>('/api/projects', signal)
  );
  const projects = projectData ?? [];
  const {
    data: agentData,
    failed: agentReadFailed,
    refresh: loadAgents,
  } = useVisiblePoll('agents', null, (signal) =>
    readArray<{ id: string; label: string }>('/api/agents', signal)
  );
  const agents = agentData ?? NO_AGENTS;
  const registryRoute = useRef(route.page);
  useEffect(() => {
    if (registryRoute.current === 'settings' && route.page !== 'settings') {
      loadProjects();
      loadAgents();
    }
    registryRoute.current = route.page;
  }, [route.page, loadProjects, loadAgents]);
  const [status, setStatus] = useState<Status | null>(null);
  const [filter, setFilter] = useState(
    () => localStorage.getItem('setu-filter') || 'all'
  );
  const [view, setView] = useState<'list' | 'grid'>(
    () =>
      (localStorage.getItem('setu-view') as 'list' | 'grid' | null) || 'grid'
  );
  const [dark, setDark] = useState(
    () => localStorage.getItem('setu-theme') === 'dark'
  );

  // View preferences — localStorage, not a client-side database. The actual
  // worktree data always comes fresh from the server on every poll; the only
  // things that need to persist here are a handful of small preference
  // values (sort key, quick-filters, page). A "Dexie-like" local DB would add
  // a real client-vs-server staleness problem for zero benefit over this.
  const [sortKey, setSortKey] = useState<'recent' | 'name' | 'created'>(
    () =>
      (localStorage.getItem('setu-sort') as
        | 'recent'
        | 'name'
        | 'created'
        | null) || 'recent'
  );
  const [search, setSearch] = useState('');
  const [onlyDirty, setOnlyDirty] = useState(
    () => localStorage.getItem('setu-filter-dirty') === '1'
  );
  const [onlyAhead, setOnlyAhead] = useState(
    () => localStorage.getItem('setu-filter-ahead') === '1'
  );
  const [page, setPage] = useState(0);
  const PAGE_SIZE = STOPPED_PAGE_SIZE;

  useEffect(() => {
    document.documentElement.classList.toggle('dark', dark);
    localStorage.setItem('setu-theme', dark ? 'dark' : 'light');
  }, [dark]);
  useEffect(() => {
    localStorage.setItem('setu-sort', sortKey);
    setPage(0);
  }, [sortKey]);
  useEffect(() => {
    localStorage.setItem('setu-filter-dirty', onlyDirty ? '1' : '0');
    setPage(0);
  }, [onlyDirty]);
  useEffect(() => {
    localStorage.setItem('setu-filter-ahead', onlyAhead ? '1' : '0');
    setPage(0);
  }, [onlyAhead]);
  useEffect(() => {
    localStorage.setItem('setu-filter', filter);
    setPage(0);
  }, [filter]);
  useEffect(() => {
    setPage(0);
  }, [search]);
  useEffect(() => {
    localStorage.setItem('setu-view', view);
  }, [view]);
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const [operationErrors, setOperationErrors] = useState<
    {
      key: string;
      title: string;
      message: string;
      code?: string;
      causeCode?: string;
    }[]
  >([]);
  const cleanupBusy = useRef(new Set<string>());
  const [cleanupRunning, setCleanupRunning] = useState(new Set<string>());
  const [deploymentIntent, setDeploymentIntent] =
    useState<DeploymentIntentState>({ phase: 'idle' });
  const deploymentOpener = useRef<HTMLElement | null>(null);
  const deploymentController = useRef<ReturnType<
    typeof createDeploymentIntent
  > | null>(null);
  if (!deploymentController.current) {
    deploymentController.current = createDeploymentIntent({
      dispatch: (context) =>
        post(`/api/${context.provider}/deploy`, {
          expectedContext: context,
          name: context.name,
          repo: context.repo,
          target: context.target,
        }),
      async preflight(intent, signal) {
        const query = new URLSearchParams({ ...intent });
        const response = await fetch(`/api/deploy/preflight?${query}`, {
          signal,
        });
        const result = await response.json().catch(() => null);
        return result && typeof result.ok === 'boolean'
          ? (result as DeploymentPreflight)
          : {
              error:
                'Deployment preflight is unavailable. Update the portal before deploying.',
              ok: false,
            };
      },
      publish: setDeploymentIntent,
      result: (intent, result) => {
        recordOutcome(
          `${intent.repo}/${intent.name}:deploy:${intent.provider}`,
          `${intent.repo}/${intent.name}: ${intent.provider} deployment`,
          result
        );
        refresh();
      },
    });
  }
  const controller = deploymentController.current;
  useEffect(() => () => deploymentController.current?.stop(), []);
  const toastId = useRef(0);
  const [createOpen, setCreateOpen] = useState(false);
  // Set by the Archived view's Recreate button and RepoPage's PR/+Worktree
  // actions: carries the repo (and branch, when known) to prefill
  // CreateModal with, distinct from createOpen (which opens it blank via
  // + Worktree on the list page) so all these flows share the one modal.
  // name is optional -- RepoPage's own "+ Worktree" button has a repo but
  // no branch yet, unlike a PR-driven or Recreate-driven prefill.
  const [recreatePrefill, setRecreatePrefill] = useState<{
    repo: string;
    name?: string;
  } | null>(null);
  const [addProjectOpen, setAddProjectOpen] = useState(false);
  const [logView, setLogView] = useState<{
    repo: string;
    name: string;
    type: string;
    returnFocus: HTMLElement | null;
  } | null>(null);
  const openLogs = useCallback(
    (
      repo: string,
      name: string,
      type: string,
      returnFocus?: HTMLElement | null
    ) =>
      setLogView({
        name,
        repo,
        returnFocus:
          returnFocus ??
          (document.activeElement instanceof HTMLElement
            ? document.activeElement
            : null),
        type,
      }),
    []
  );
  const [commandOpen, setCommandOpen] = useState(false);
  const pendingStart = useRef(new Set<string>());
  const startResponses = useRef(new Set<string>());
  const [tunnelBusy, setTunnelBusy] = useState(false);
  const lifecycleFocus = useRef<{ key: string; label: string | null } | null>(
    null
  );
  const commandOpener = useRef<HTMLElement | null>(null);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const previousRoute = useRef(route);
  function rememberWorktreeFocus() {
    const element =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    const key = element?.closest<HTMLElement>('[data-worktree-key]')?.dataset
      .worktreeKey;
    lifecycleFocus.current = key
      ? { key, label: element?.getAttribute('aria-label') ?? null }
      : null;
  }
  function openCommand() {
    if (
      document.querySelector(
        '[role="dialog"][aria-modal="true"], [role="alertdialog"][aria-modal="true"]'
      )
    ) {
      return;
    }
    commandOpener.current =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    setCommandOpen(true);
  }
  useLayoutEffect(() => {
    const changed = previousRoute.current !== route;
    previousRoute.current = route;
    const id = location.hash.slice(1);
    if (!(id || changed)) {
      return;
    }
    const heading = document.getElementById(id || 'page-title');
    heading?.focus();
    heading?.scrollIntoView({ block: 'start' });
  }, [route, loaded]);
  useLayoutEffect(() => {
    const previous = lifecycleFocus.current;
    lifecycleFocus.current = null;
    if (
      !previous ||
      (document.activeElement !== document.body &&
        document.activeElement !== null)
    ) {
      return;
    }
    const row = Array.from(
      document.querySelectorAll<HTMLElement>('[data-worktree-key]')
    ).find((el) => el.dataset.worktreeKey === previous.key);
    const candidates = Array.from(
      row?.querySelectorAll<HTMLElement>('button:not(:disabled), a[href]') ?? []
    );
    const target =
      candidates.find(
        (el) =>
          previous.label && el.getAttribute('aria-label') === previous.label
      ) ??
      candidates[0] ??
      document.getElementById('active-work');
    target?.focus();
  }, [worktrees]);

  // RepoPage isn't rendered on the same branch as CreateModal (see the
  // route.page === 'repo' dispatch below), so both callbacks navigate to
  // the list page first, same as ArchivedPage's onRecreate does.
  const onCreateFromPr = (repo: string, branch: string) => {
    setRecreatePrefill({ name: branch, repo });
    navigate('/');
  };

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (
        !(e.defaultPrevented || e.isComposing || e.repeat || e.altKey) &&
        (e.metaKey || e.ctrlKey) &&
        e.key.toLowerCase() === 'k' &&
        !document.querySelector(
          '[role="dialog"][aria-modal="true"], [role="alertdialog"][aria-modal="true"]'
        )
      ) {
        e.preventDefault();
        openCommand();
      }
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  // Auto-tones off the '✗ ' prefix every failure call site already uses —
  // callers that want a specific tone (success, a heads-up) pass one explicitly.
  const toast = useCallback(
    (msg: string, tone: Tone = msg.startsWith('✗') ? 'red' : 'zinc') => {
      toastId.current += 1;
      const id = toastId.current;
      setToasts((ts) => [...ts, { id, msg, tone }].slice(-20));
    },
    []
  );
  const dismissToast = (id: number) =>
    setToasts((ts) => ts.filter((t) => t.id !== id));

  const recordOutcome = useCallback(
    (
      key: string,
      title: string,
      result: {
        ok: boolean;
        error?: string;
        code?: string;
        causeCode?: string;
        networkUncertain?: boolean;
      }
    ) => {
      setOperationErrors((previous) => {
        const remaining = previous.filter((error) => error.key !== key);
        if (result.ok) {
          return remaining;
        }
        return [
          ...remaining,
          {
            causeCode: result.causeCode,
            code: result.code,
            key,
            message: result.networkUncertain
              ? 'Outcome not confirmed. Refresh status before trying again.'
              : result.error || 'The action could not be completed.',
            title,
          },
        ].slice(-10);
      });
      if (!result.ok) {
        toast(
          `✗ ${title}: ${result.error || 'The action could not be completed.'}`,
          'red'
        );
      }
    },
    [toast]
  );

  const refresh = useCallback(() => getWs().refresh(), []);

  // Live worktree list + status, pushed by the server over WS -- replaces
  // the old poll loop. The server auto-subscribes every connection to
  // 'worktrees' the moment it opens, so this just registers the handler.
  useEffect(() => {
    const ws = getWs();
    const onMessage = (
      data: { worktrees: Worktree[]; status: Status | null } | Worktree[]
    ) => {
      const wts = Array.isArray(data) ? data : data.worktrees;
      if (!Array.isArray(wts)) {
        return;
      }
      let pendingChanged = false;
      for (const key of pendingStart.current) {
        const worktree = wts.find((w) => w.key === key);
        if (
          startResponses.current.has(key) ||
          worktree?.active ||
          worktree?.queued ||
          worktree?.starting ||
          worktree?.stopping
        ) {
          pendingStart.current.delete(key);
          startResponses.current.delete(key);
          pendingChanged = true;
        }
      }
      rememberWorktreeFocus();
      setWorktrees((previous) => {
        const next = reuseWorktreeRows(previous, wts);
        // Legacy array snapshots may contain unchanged rows while settling a
        // local request. Deliver that pending-state change to memoized cards.
        return pendingChanged && next === previous ? [...next] : next;
      });
      if (!Array.isArray(data) && data.status) {
        // Status content is usually unchanged when only an active row's metrics move.
        setStatus((previous) =>
          JSON.stringify(previous) === JSON.stringify(data.status)
            ? previous
            : data.status
        );
      }
      setLoaded(true);
    };
    ws.subscribe('worktrees', onMessage);
    return () => ws.unsubscribe('worktrees', onMessage);
  }, []);

  const act = useCallback(
    async (url: string, w: Worktree) => {
      const enablingTunnel = url === '/api/tunnel/enable';
      if (enablingTunnel) {
        if (tunnelBusy) {
          return;
        }
        const owner = worktrees.find(
          (row) => row.tunnelOn && row.key !== w.key
        );
        if (
          owner &&
          // biome-ignore lint/suspicious/noAlert: This confirmation gates moving the shared tunnel in the request below.
          !confirm(
            `Move the public tunnel from ${owner.repo}/${owner.name} to ${w.repo}/${w.name}? Both dev servers will restart.`
          )
        ) {
          return;
        }
        setTunnelBusy(true);
      }
      const result = await post(url, { name: w.name, repo: w.repo });
      recordOutcome(
        `${w.key}:${url}`,
        `${w.repo}/${w.name}: ${ACT_LABEL[url] ?? url.replace('/api/', '')}`,
        result
      );
      for (const warning of result.warnings ?? []) {
        toast(`⚠ ${warning}`, 'amber');
      }
      if (enablingTunnel) {
        setTunnelBusy(false);
      }
      refresh();
    },
    [recordOutcome, refresh, toast, tunnelBusy, worktrees]
  );

  // Used to be fire-and-forget — `{ok:true}` from /api/open only ever meant
  // "Bun.spawn didn't throw synchronously," not "a window actually opened."
  // That's exactly how the ghostty launch bug stayed invisible: the endpoint
  // always reported success even when the spawned process silently did
  // nothing. Checking res.ok doesn't fully close that gap (a successful spawn
  // still isn't proof of a visible window), but it at least surfaces the
  // failure mode this endpoint CAN detect, matching how act()/start() already behave.
  const openTool = useCallback(
    async (w: Worktree, tool: string) => {
      const result = await post('/api/open', {
        name: w.name,
        repo: w.repo,
        tool,
      });
      recordOutcome(
        `${w.key}:open:${tool}`,
        `${w.repo}/${w.name}: open ${tool}`,
        result
      );
    },
    [recordOutcome]
  );

  const start = useCallback(
    async (w: Worktree, force?: 'container' | 'bare') => {
      if (pendingStart.current.has(w.key)) {
        return;
      }
      rememberWorktreeFocus();
      pendingStart.current.add(w.key);
      setWorktrees((previous) => [...previous]);
      const body: { repo: string; name: string; container?: boolean } = {
        name: w.name,
        repo: w.repo,
      };
      if (force) {
        body.container = force === 'container';
      }
      const res = await post('/api/start', body);
      recordOutcome(`${w.key}:start`, `${w.repo}/${w.name}: start`, res);
      if (res?.ok && pendingStart.current.has(w.key)) {
        startResponses.current.add(w.key);
      } else {
        pendingStart.current.delete(w.key);
        startResponses.current.delete(w.key);
      }
      // Dev server (and every already-approved sidecar) still started fine,
      // this is just telling the user one sidecar sat out and why.
      for (const name of res?.skippedSidecars ?? []) {
        toast(
          `✗ sidecar '${name}' needs approval before it will run. Approve it in Settings.`,
          'amber'
        );
      }
      refresh();
      startResponses.current.delete(w.key);
    },
    [recordOutcome, refresh, toast]
  );

  const remove = useCallback(
    async (w: Worktree, reason: 'manual' | 'merged' = 'manual') => {
      if (w.name === 'main') {
        toast(
          '✗ The main worktree holds shared local files such as .env.local. Remove the project instead.',
          'red'
        );
        return;
      }
      if (
        // biome-ignore lint/suspicious/noAlert: This confirmation gates the destructive worktree removal request below.
        !confirm(
          `Remove worktree "${w.name}"? The branch is kept. Tracked, untracked, and ignored local files such as a real .env.local block removal. node_modules and build output are deleted.`
        )
      ) {
        return;
      }
      const result = await post('/api/remove', {
        name: w.name,
        reason,
        repo: w.repo,
      });
      recordOutcome(`${w.key}:remove`, `${w.repo}/${w.name}: remove`, result);
      if (!result.ok && result.removed && result.operationId) {
        setStatus(
          (previous) =>
            previous && {
              ...previous,
              pendingRemovals: [
                ...(previous.pendingRemovals ?? []).filter(
                  (entry) => entry.operationId !== result.operationId
                ),
                {
                  error: result.error,
                  name: w.name,
                  operationId: result.operationId,
                  pendingSteps: result.pendingSteps ?? [],
                  removed: true,
                  repo: w.repo,
                },
              ],
            }
        );
      }
      refresh();
    },
    [recordOutcome, refresh, toast]
  );

  async function retryCleanup(entry: PendingRemoval) {
    if (cleanupBusy.current.has(entry.operationId)) {
      return;
    }
    if (
      !(
        entry.removed ||
        // biome-ignore lint/suspicious/noAlert: This confirmation gates retrying the checkout removal stage below.
        confirm(
          `Retry removal of "${entry.name}"? Its checkout still exists, so this reruns the git removal stage.`
        )
      )
    ) {
      return;
    }
    cleanupBusy.current.add(entry.operationId);
    setCleanupRunning(new Set(cleanupBusy.current));
    try {
      const result = await post('/api/remove', {
        name: entry.name,
        operationId: entry.operationId,
        repo: entry.repo,
      });
      recordOutcome(
        `cleanup:${entry.operationId}`,
        `${entry.repo}/${entry.name}: cleanup`,
        result
      );
      if (!result.ok) {
        setStatus(
          (previous) =>
            previous && {
              ...previous,
              pendingRemovals: previous.pendingRemovals?.map((row) =>
                row.operationId === entry.operationId
                  ? {
                      ...row,
                      error: result.error || 'Cleanup could not be confirmed.',
                      pendingSteps: result.pendingSteps ?? row.pendingSteps,
                    }
                  : row
              ),
            }
        );
      }
      refresh();
    } finally {
      cleanupBusy.current.delete(entry.operationId);
      setCleanupRunning(new Set(cleanupBusy.current));
    }
  }

  async function cancelRemoval(entry: PendingRemoval) {
    if (cleanupBusy.current.has(entry.operationId)) {
      return;
    }
    cleanupBusy.current.add(entry.operationId);
    setCleanupRunning(new Set(cleanupBusy.current));
    try {
      const result = await post('/api/remove/cancel', {
        operationId: entry.operationId,
      });
      recordOutcome(
        `cleanup:${entry.operationId}:cancel`,
        `${entry.repo}/${entry.name}: cancel removal`,
        result
      );
      refresh();
    } finally {
      cleanupBusy.current.delete(entry.operationId);
      setCleanupRunning(new Set(cleanupBusy.current));
    }
  }

  function beginDeployment(
    w: Worktree,
    provider: DeploymentIntent['provider'],
    target: string
  ) {
    deploymentOpener.current =
      Array.from(
        document.querySelectorAll<HTMLElement>('[data-deploy-trigger]')
      ).find(
        (element) => element.dataset.deployTrigger === `${w.key}:${provider}`
      ) ?? null;
    if (
      !controller.begin({
        name: w.name,
        provider,
        repo: w.repo,
        target,
      }) &&
      controller.getState().phase === 'submitting'
    ) {
      toast(
        'A deployment request is already being submitted. Refresh status before trying again.',
        'amber'
      );
    }
  }
  function deploy(w: Worktree, provider: DeployProvider, target: string) {
    beginDeployment(w, provider, target);
  }
  function convexDeploy(w: Worktree, target: string) {
    beginDeployment(w, 'convex', target);
  }

  const {
    active: running,
    stopped: rest,
    stoppedTotal,
    page: currentPage,
    pageCount,
    pageRows: filtered,
  } = projectWorktrees(worktrees, {
    ahead: onlyAhead,
    dirty: onlyDirty,
    page,
    project: filter,
    search,
    sort: sortKey,
  });
  const hasFilters =
    filter !== 'all' || onlyDirty || onlyAhead || search.trim() !== '';
  function clearFilters() {
    setFilter('all');
    setOnlyDirty(false);
    setOnlyAhead(false);
    setSearch('');
    setPage(0);
  }

  const pageContent = (() => {
    if (route.page === 'spans') {
      return (
        <SpansPage
          onBack={() => navigate(route.runId ? '/spans' : '/')}
          onSelect={(runId) => navigate(`/spans/${encodeURIComponent(runId)}`)}
          runId={route.runId}
        />
      );
    }
    if (route.page === 'detail') {
      const w = worktrees.find(
        (x) => x.repo === route.repo && x.name === route.name
      );
      const renderDetailRoute = () => (
        <>
          <WorktreePage
            agents={agents}
            loaded={loaded}
            onAct={act}
            onConvexDeploy={convexDeploy}
            onDeploy={deploy}
            onOpenLogs={openLogs}
            onOpenTool={openTool}
            onRefresh={refresh}
            onRemove={remove}
            onStart={start}
            pending={w ? pendingStart.current.has(w.key) : false}
            toast={toast}
            tunnelBusy={tunnelBusy}
            w={w}
          />
          {logView && (
            <LogModal
              extraTabs={worktrees
                .find((x) => x.repo === logView.repo && x.name === logView.name)
                ?.sidecars.map((s) => s.name)}
              initialType={logView.type}
              name={logView.name}
              onClose={() => setLogView(null)}
              repo={logView.repo}
              returnFocus={logView.returnFocus}
            />
          )}
          {commandOpen && (
            <CommandBar
              onClose={() => setCommandOpen(false)}
              onSelect={(selectedWorktree) =>
                navigate(
                  `/worktree/${selectedWorktree.repo}/${encodeURIComponent(selectedWorktree.name)}`
                )
              }
              returnFocus={commandOpener}
              worktrees={worktrees}
            />
          )}
        </>
      );
      return renderDetailRoute();
    }

    if (route.page === 'settings') {
      const renderSettingsRoute = () => (
        <>
          <SettingsPage toast={toast} />
          {commandOpen && (
            <CommandBar
              onClose={() => setCommandOpen(false)}
              onSelect={(w) =>
                navigate(`/worktree/${w.repo}/${encodeURIComponent(w.name)}`)
              }
              returnFocus={commandOpener}
              worktrees={worktrees}
            />
          )}
        </>
      );
      return renderSettingsRoute();
    }

    if (route.page === 'help') {
      const renderHelpRoute = () => (
        <>
          <HelpPage onBack={() => navigate('/')} />
          {commandOpen && (
            <CommandBar
              onClose={() => setCommandOpen(false)}
              onSelect={(w) =>
                navigate(`/worktree/${w.repo}/${encodeURIComponent(w.name)}`)
              }
              returnFocus={commandOpener}
              worktrees={worktrees}
            />
          )}
        </>
      );
      return renderHelpRoute();
    }

    if (route.page === 'ports') {
      const renderPortsRoute = () => (
        <>
          <PortsPage onBack={() => navigate('/')} />
          {commandOpen && (
            <CommandBar
              onClose={() => setCommandOpen(false)}
              onSelect={(w) =>
                navigate(`/worktree/${w.repo}/${encodeURIComponent(w.name)}`)
              }
              returnFocus={commandOpener}
              worktrees={worktrees}
            />
          )}
        </>
      );
      return renderPortsRoute();
    }

    if (route.page === 'inventory') {
      const renderInventoryRoute = () => (
        <>
          <InventoryPage
            onBack={() => navigate('/')}
            onOpenWorktree={(repo, name) =>
              navigate(
                `/worktree/${encodeURIComponent(repo)}/${encodeURIComponent(name)}`
              )
            }
            toast={toast}
          />
          {commandOpen && (
            <CommandBar
              onClose={() => setCommandOpen(false)}
              onSelect={(w) =>
                navigate(`/worktree/${w.repo}/${encodeURIComponent(w.name)}`)
              }
              returnFocus={commandOpener}
              worktrees={worktrees}
            />
          )}
        </>
      );
      return renderInventoryRoute();
    }

    if (route.page === 'costs') {
      const renderCostsRoute = () => (
        <>
          <CostsPage onBack={() => navigate('/')} />
          {commandOpen && (
            <CommandBar
              onClose={() => setCommandOpen(false)}
              onSelect={(w) =>
                navigate(`/worktree/${w.repo}/${encodeURIComponent(w.name)}`)
              }
              returnFocus={commandOpener}
              worktrees={worktrees}
            />
          )}
        </>
      );
      return renderCostsRoute();
    }

    if (route.page === 'repo') {
      const proj = projects.find((p) => p.name === route.repo);
      const renderRepoRoute = () => (
        <>
          <RepoPage
            agents={agents}
            github={proj?.github}
            key={route.repo}
            label={proj?.label ?? route.repo}
            loaded={loaded}
            onAct={act}
            onBack={() => navigate('/')}
            onCreateFromPr={onCreateFromPr}
            onCreateWorktree={() => {
              setRecreatePrefill({ repo: route.repo });
              navigate('/');
            }}
            onDeploy={deploy}
            onOpenLogs={openLogs}
            onOpenTool={openTool}
            onRemove={remove}
            onStart={start}
            pendingStart={pendingStart.current}
            repo={route.repo}
            toast={toast}
            worktrees={worktrees}
          />
          {logView && (
            <LogModal
              extraTabs={worktrees
                .find((x) => x.repo === logView.repo && x.name === logView.name)
                ?.sidecars.map((s) => s.name)}
              initialType={logView.type}
              name={logView.name}
              onClose={() => setLogView(null)}
              repo={logView.repo}
              returnFocus={logView.returnFocus}
            />
          )}
          {commandOpen && (
            <CommandBar
              onClose={() => setCommandOpen(false)}
              onSelect={(w) =>
                navigate(`/worktree/${w.repo}/${encodeURIComponent(w.name)}`)
              }
              returnFocus={commandOpener}
              worktrees={worktrees}
            />
          )}
        </>
      );
      return renderRepoRoute();
    }

    if (route.page === 'archived') {
      // Recreate hands off to the list page's own CreateModal (prefilled)
      // rather than duplicating the create flow here, so navigate there first
      // to make sure it's actually visible.
      const onRecreate = (a: ArchivedWorktree) => {
        setRecreatePrefill({ name: a.branch || a.name, repo: a.repo });
        navigate('/');
      };
      const renderArchivedRoute = () => (
        <>
          <ArchivedPage onBack={() => navigate('/')} onRecreate={onRecreate} />
          {commandOpen && (
            <CommandBar
              onClose={() => setCommandOpen(false)}
              onSelect={(w) =>
                navigate(`/worktree/${w.repo}/${encodeURIComponent(w.name)}`)
              }
              returnFocus={commandOpener}
              worktrees={worktrees}
            />
          )}
        </>
      );
      return renderArchivedRoute();
    }

    const renderWorkspaceRoute = () => {
      function renderCreateModal() {
        return (
          (createOpen || recreatePrefill) && (
            <CreateModal
              initialName={recreatePrefill?.name}
              initialRepo={recreatePrefill?.repo}
              onClose={() => {
                setCreateOpen(false);
                setRecreatePrefill(null);
              }}
              onCreated={refresh}
              projects={projects}
              worktrees={worktrees}
            />
          )
        );
      }
      function renderAddProjectModal() {
        return (
          addProjectOpen && (
            <AddProjectModal
              onAdded={loadProjects}
              onClose={() => setAddProjectOpen(false)}
            />
          )
        );
      }
      function renderLogModal() {
        return (
          logView && (
            <LogModal
              extraTabs={worktrees
                .find((x) => x.repo === logView.repo && x.name === logView.name)
                ?.sidecars.map((s) => s.name)}
              initialType={logView.type}
              name={logView.name}
              onClose={() => setLogView(null)}
              repo={logView.repo}
              returnFocus={logView.returnFocus}
            />
          )
        );
      }
      function renderCommandBar() {
        return (
          commandOpen && (
            <CommandBar
              onClose={() => setCommandOpen(false)}
              onSelect={(w) =>
                navigate(`/worktree/${w.repo}/${encodeURIComponent(w.name)}`)
              }
              returnFocus={commandOpener}
              worktrees={worktrees}
            />
          )
        );
      }
      return (
        <div class="portal-workspace mx-auto max-w-6xl px-4 py-6 sm:px-6 lg:py-12">
          <PageHeader
            actions={
              <>
                <Button
                  compact
                  onClick={() => setAddProjectOpen(true)}
                  variant="secondary"
                >
                  + Project
                </Button>
                <Button
                  compact
                  onClick={() => setCreateOpen(true)}
                  variant="primary"
                >
                  + Worktree
                </Button>
              </>
            }
            subtitle={
              loaded && (
                <div class="flex flex-col gap-3">
                  <PortalStatus
                    activeCount={running.length}
                    loaded={loaded}
                    status={status}
                  />
                  <p class="max-w-xl text-xs text-zinc-400 dark:text-zinc-500">
                    Parallel branches, dedicated dev servers, sidecars, and
                    synced environments. One bridge for every feature an agent
                    is building at once.
                  </p>
                </div>
              )
            }
            title={<span class="wordmark">setu</span>}
          />

          {!loaded && <InitialLoad />}
          {loaded && (
            <>
              <div class="rail-divider mb-8" />
              <div class="flex flex-col items-start gap-6 lg:flex-row">
                <WorkspaceSidebar
                  dark={dark}
                  filter={filter}
                  onAhead={setOnlyAhead}
                  onDirty={setOnlyDirty}
                  onFilter={setFilter}
                  onFollow={followRoute}
                  onJump={openCommand}
                  onlyAhead={onlyAhead}
                  onlyDirty={onlyDirty}
                  onSort={setSortKey}
                  onTheme={() => setDark(!dark)}
                  onToggle={() => setFiltersOpen(!filtersOpen)}
                  onView={setView}
                  open={filtersOpen}
                  projects={projects}
                  sortKey={sortKey}
                  view={view}
                >
                  <div class="hidden lg:block">
                    <TriviaCard />
                  </div>
                </WorkspaceSidebar>
                <div class="w-full min-w-0 flex-1">
                  <section aria-labelledby="active-work" class="mb-8">
                    <div class="mb-4">
                      <h2
                        class="section-anchor board-mono font-bold text-[11px] text-zinc-400"
                        id="active-work"
                        tabIndex={-1}
                      >
                        Active work{loaded ? ` (${running.length})` : ''}
                      </h2>
                      <p class="mt-1 text-xs text-zinc-600 dark:text-zinc-300">
                        All projects · always shown
                        {loaded && running.length > 0 && (
                          <span>
                            {' · '}
                            {(
                              [
                                'running',
                                'starting',
                                'stopping',
                                'queued',
                                'attention',
                              ] as const
                            )
                              .map((state) => {
                                const count = running.filter(
                                  (w) => worktreeState(w) === state
                                ).length;
                                return count
                                  ? `${count} ${state === 'attention' ? 'need attention' : state}`
                                  : '';
                              })
                              .filter(Boolean)
                              .join(' · ')}
                          </span>
                        )}
                      </p>
                    </div>
                    <WorktreeList
                      agents={agents}
                      emptyMessage={
                        loaded
                          ? 'No active or queued worktrees'
                          : 'Loading worktrees…'
                      }
                      gridMode={view === 'grid'}
                      items={running}
                      onAct={act}
                      onDeploy={deploy}
                      onOpenLogs={openLogs}
                      onOpenTool={openTool}
                      onRemove={remove}
                      onStart={start}
                      pendingStart={pendingStart.current}
                      toast={toast}
                    />
                  </section>

                  <PendingCleanup
                    busy={cleanupRunning}
                    entries={status?.pendingRemovals ?? []}
                    onCancel={cancelRemoval}
                    onRetry={retryCleanup}
                  />
                  <div class="rail-divider mb-8" />
                  <section aria-labelledby="stopped-worktrees">
                    <div class="mb-4">
                      <h2
                        class="board-mono font-bold text-[11px] text-zinc-400"
                        id="stopped-worktrees"
                      >
                        Stopped worktrees
                      </h2>
                      <p
                        class="mt-1 text-xs text-zinc-600 dark:text-zinc-300"
                        id="filter-scope"
                      >
                        {loaded && `${rest.length} of ${stoppedTotal} shown. `}
                        Filters apply to stopped worktrees. Active work above
                        always includes all projects.
                      </p>
                    </div>
                    <div class="relative mb-3">
                      <label class="sr-only" htmlFor="stopped-search">
                        Search stopped worktrees
                      </label>
                      <svg
                        aria-hidden="true"
                        class="pointer-events-none absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2 text-zinc-500 dark:text-zinc-400"
                        fill="none"
                        stroke="currentColor"
                        stroke-linecap="round"
                        stroke-linejoin="round"
                        stroke-width="2.25"
                        viewBox="0 0 24 24"
                      >
                        <path d={tablerSearch.path} />
                      </svg>
                      <input
                        aria-describedby="filter-scope"
                        autoComplete="off"
                        class="w-full rounded-none border border-white/75 bg-white/60 py-2.5 pr-3 pl-9 text-sm text-zinc-800 placeholder-zinc-600 shadow-sm backdrop-blur-md dark:border-white/10 dark:bg-white/5 dark:text-zinc-100 dark:placeholder-zinc-400"
                        id="stopped-search"
                        onInput={(e) => setSearch(e.currentTarget.value)}
                        placeholder="Search stopped worktrees by name, repo, or label…"
                        value={search}
                      />
                    </div>
                    {hasFilters && (
                      <fieldset
                        aria-label="Active stopped-worktree filters"
                        class="mb-3 flex min-w-0 flex-wrap items-center gap-2"
                      >
                        {filter !== 'all' && (
                          <button
                            aria-label={`Clear project filter ${filter}`}
                            class="filter-chip"
                            onClick={() => setFilter('all')}
                            type="button"
                          >
                            Project:{' '}
                            {projects.find((p) => p.name === filter)?.label ??
                              filter}{' '}
                            <span aria-hidden="true">×</span>
                          </button>
                        )}
                        {onlyDirty && (
                          <button
                            aria-label="Clear uncommitted changes filter"
                            class="filter-chip"
                            onClick={() => setOnlyDirty(false)}
                            type="button"
                          >
                            Uncommitted changes{' '}
                            <span aria-hidden="true">×</span>
                          </button>
                        )}
                        {onlyAhead && (
                          <button
                            aria-label="Clear ahead of base filter"
                            class="filter-chip"
                            onClick={() => setOnlyAhead(false)}
                            type="button"
                          >
                            Ahead of base <span aria-hidden="true">×</span>
                          </button>
                        )}
                        {search.trim() && (
                          <button
                            aria-label="Clear search filter"
                            class="filter-chip max-w-full break-words"
                            onClick={() => setSearch('')}
                            type="button"
                          >
                            Search: {search} <span aria-hidden="true">×</span>
                          </button>
                        )}
                        <Button
                          compact
                          onClick={clearFilters}
                          variant="secondary"
                        >
                          Clear filters
                        </Button>
                      </fieldset>
                    )}
                    <WorktreeList
                      agents={agents}
                      emptyMessage={filteredStoppedEmptyMessage(
                        loaded,
                        hasFilters
                      )}
                      gridMode={view === 'grid'}
                      items={filtered}
                      onAct={act}
                      onDeploy={deploy}
                      onOpenLogs={openLogs}
                      onOpenTool={openTool}
                      onRemove={remove}
                      onStart={start}
                      pendingStart={pendingStart.current}
                      toast={toast}
                    />
                    {loaded && rest.length > 0 && (
                      <p class="mt-4 text-xs text-zinc-600 dark:text-zinc-300">
                        Showing {currentPage * PAGE_SIZE + 1} to{' '}
                        {Math.min((currentPage + 1) * PAGE_SIZE, rest.length)}{' '}
                        of {rest.length} matching stopped worktrees
                      </p>
                    )}
                    <Pagination
                      onPage={setPage}
                      page={currentPage}
                      pageCount={pageCount}
                    />
                  </section>

                  <div class="rail-divider mt-10 mb-4" />
                  <div class="flex flex-wrap items-center justify-between gap-3 text-xs text-zinc-400">
                    <a
                      class="flex w-fit items-center gap-2 transition-colors duration-150 hover:text-zinc-600 dark:hover:text-zinc-300"
                      href="https://mukulchugh.com"
                      rel="noopener"
                      target="_blank"
                    >
                      <img
                        alt=""
                        class="h-4 w-4 rounded-none"
                        height={16}
                        src={MUKUL_LOGO_URI}
                        width={16}
                      />
                      Created by Mukul Chugh
                    </a>
                    <div class="flex items-center gap-4">
                      <a
                        class="transition-colors duration-150 hover:text-zinc-600 dark:hover:text-zinc-300"
                        href="/help"
                        onClick={(e: MouseEvent) => {
                          e.preventDefault();
                          navigate('/help');
                        }}
                      >
                        Help &amp; guide
                      </a>
                      <a
                        class="transition-colors duration-150 hover:text-zinc-600 dark:hover:text-zinc-300"
                        href="https://github.com/mukulchugh/setu"
                        rel="noopener"
                        target="_blank"
                      >
                        Contribute on GitHub
                      </a>
                    </div>
                  </div>
                </div>
              </div>
            </>
          )}

          {renderCreateModal()}
          {renderAddProjectModal()}
          {renderLogModal()}
          {renderCommandBar()}
        </div>
      );
    };
    return renderWorkspaceRoute();
  })();
  return (
    <>
      <a class="skip-link" href="#main-content">
        Skip to content
      </a>
      {route.page !== 'list' && (
        <div class="mx-auto max-w-6xl px-4 pt-4 sm:px-6">
          <PortalStatus
            activeCount={running.length}
            loaded={loaded}
            status={status}
          />
        </div>
      )}
      {projectReadFailed && (
        <p
          class="mx-auto max-w-7xl px-4 pt-4 text-signal-red text-sm sm:px-6"
          role="status"
        >
          Could not load registered projects.{' '}
          {projectData ? 'Showing the last successful read. ' : ''}
          <button class="underline" onClick={loadProjects} type="button">
            Retry
          </button>
        </p>
      )}
      {agentReadFailed && (
        <p
          class="mx-auto max-w-7xl px-4 pt-4 text-signal-red text-sm sm:px-6"
          role="status"
        >
          Could not load available agents and editors.{' '}
          {agentData ? 'Showing the last successful read. ' : ''}
          <button class="underline" onClick={loadAgents} type="button">
            Retry
          </button>
        </p>
      )}
      {!!operationErrors.length && (
        <section
          aria-label="Actions needing attention"
          class="mx-auto flex max-w-7xl flex-col gap-2 px-4 pt-4 sm:px-6"
        >
          {operationErrors.map((error) => (
            <div
              class="border border-red-300 bg-red-50/70 p-3 text-sm dark:border-red-800 dark:bg-red-950/40"
              key={error.key}
            >
              <strong>{error.title}</strong>
              <p class="break-words">{error.message}</p>
              {(error.code || error.causeCode) && (
                <p class="text-xs">
                  {[error.code, error.causeCode].filter(Boolean).join(' · ')}
                  {error.code === 'ENOSPC' || error.causeCode === 'ENOSPC'
                    ? ' · This operation ran out of writable storage; host and Docker VM observations are separate.'
                    : ''}
                </p>
              )}
              <div class="mt-2 flex gap-3">
                <button class="underline" onClick={refresh} type="button">
                  Refresh status
                </button>
                <button
                  class="underline"
                  onClick={() =>
                    setOperationErrors((previous) =>
                      previous.filter((item) => item.key !== error.key)
                    )
                  }
                  type="button"
                >
                  Dismiss
                </button>
              </div>
            </div>
          ))}
        </section>
      )}
      <main id="main-content" tabIndex={-1}>
        {pageContent}
      </main>
      <DeploymentDialog
        onClose={() => controller.close()}
        onConfirm={() => controller.confirm()}
        onRefresh={() => controller.refresh()}
        returnFocus={deploymentOpener}
        state={deploymentIntent}
      />
      <ToastStack onDismiss={dismissToast} toasts={toasts} />
    </>
  );
}

render(<App />, document.getElementById('root') as HTMLElement);
