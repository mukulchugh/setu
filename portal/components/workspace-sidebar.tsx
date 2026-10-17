// The home page's 208px glass sidebar, restored from a4f500c: icon-and-label
// controls for stopped-worktree filters, layout, theme and workspace pages.
// Page entries are real links so new-tab and the Settings leave guard work.
import type { ComponentChildren, JSX } from 'preact';
import {
  tablerArchive,
  tablerArrowUp,
  tablerCircle,
  tablerCurrencyDollar,
  tablerHelpCircle,
  tablerLayoutGrid,
  tablerMenu2,
  tablerMoonFilled,
  tablerPlug,
  tablerSearch,
  tablerSettings,
  tablerStack2,
  tablerSun,
} from './icons';

type Follow = (e: MouseEvent, href: string) => void;
const MAC = /mac/i;
type Sort = 'recent' | 'name' | 'created';

const SIDEBAR_ITEM =
  'flex min-w-0 items-center gap-2.5 h-9 px-2 rounded-none border text-xs text-left transition-colors duration-150';
const SIDEBAR_IDLE =
  'bg-white/70 dark:bg-white/5 border-transparent text-zinc-600 dark:text-zinc-300 hover:bg-white dark:hover:bg-white/10';
const SIDEBAR_SELECT =
  'w-full bg-white/70 dark:bg-white/5 border border-zinc-200 dark:border-white/10 text-zinc-700 dark:text-zinc-300 text-xs rounded-none px-2 py-2 focus:border-zinc-400';

function Icon({ path, filled = false }: { path: string; filled?: boolean }) {
  return filled ? (
    <svg
      aria-hidden="true"
      class="h-4 w-4 shrink-0"
      fill="currentColor"
      viewBox="0 0 24 24"
    >
      <path d={path} />
    </svg>
  ) : (
    <svg
      aria-hidden="true"
      class="h-4 w-4 shrink-0"
      fill="none"
      stroke="currentColor"
      stroke-linecap="round"
      stroke-linejoin="round"
      stroke-width="2"
      viewBox="0 0 24 24"
    >
      <path d={path} />
    </svg>
  );
}

function SidebarToggle({
  active,
  activeClass,
  icon,
  label,
  onClick,
}: {
  active: boolean;
  activeClass: string;
  icon: ComponentChildren;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      aria-pressed={active}
      class={`${SIDEBAR_ITEM} ${active ? activeClass : SIDEBAR_IDLE}`}
      onClick={onClick}
      type="button"
    >
      {icon}
      <span>{label}</span>
    </button>
  );
}

function SidebarLink({
  href,
  icon,
  label,
  onFollow,
  right,
}: {
  href: string;
  icon: ComponentChildren;
  label: string;
  onFollow: Follow;
  right?: ComponentChildren;
}) {
  return (
    <a
      class={`${SIDEBAR_ITEM} ${SIDEBAR_IDLE}`}
      href={href}
      onClick={(e) => onFollow(e, href)}
    >
      {icon}
      <span class="flex-1">{label}</span>
      {right}
    </a>
  );
}

const PAGES: [string, string, string][] = [
  ['/inventory', 'Inventory', tablerStack2.path],
  ['/spans', 'Spans', tablerStack2.path],
  ['/ports', 'Active ports', tablerPlug.path],
  ['/costs', 'Costs', tablerCurrencyDollar.path],
  ['/archived', 'Archived', tablerArchive.path],
  ['/settings', 'Settings', tablerSettings.path],
  ['/help', 'Help & guide', tablerHelpCircle.path],
];

export function WorkspaceSidebar({
  projects,
  filter,
  onFilter,
  sortKey,
  onSort,
  onlyDirty,
  onDirty,
  onlyAhead,
  onAhead,
  view,
  onView,
  dark,
  onTheme,
  onJump,
  onFollow,
  open,
  onToggle,
  children,
}: {
  projects: { name: string; label: string }[];
  filter: string;
  onFilter: (value: string) => void;
  sortKey: Sort;
  onSort: (value: Sort) => void;
  onlyDirty: boolean;
  onDirty: (value: boolean) => void;
  onlyAhead: boolean;
  onAhead: (value: boolean) => void;
  view: 'list' | 'grid';
  onView: (value: 'list' | 'grid') => void;
  dark: boolean;
  onTheme: () => void;
  onJump: () => void;
  onFollow: Follow;
  open: boolean;
  onToggle: () => void;
  children?: ComponentChildren;
}) {
  const shortcut = MAC.test(navigator.platform) ? '⌘K' : 'Ctrl K';
  return (
    <aside class="workspace-rail z-20 flex w-full shrink-0 flex-col gap-4 lg:sticky lg:top-6 lg:order-last lg:w-52">
      <button
        aria-controls="workspace-sidebar"
        aria-expanded={open}
        class={`${SIDEBAR_ITEM} ${SIDEBAR_IDLE} justify-center lg:hidden`}
        onClick={onToggle}
        type="button"
      >
        <Icon path={tablerMenu2.path} />
        Filters and workspace
      </button>
      <div
        class={`${open ? 'flex' : 'hidden'} flex-col gap-1 rounded-none border border-white/75 bg-white/70 p-2 shadow-lg backdrop-blur-md lg:flex dark:border-white/10 dark:bg-white/10`}
        id="workspace-sidebar"
      >
        <select
          aria-label="Project for stopped worktrees"
          class={SIDEBAR_SELECT}
          onChange={(e: JSX.TargetedEvent<HTMLSelectElement>) =>
            onFilter(e.currentTarget.value)
          }
          value={filter}
        >
          <option value="all">All projects</option>
          {filter !== 'all' && !projects.some((p) => p.name === filter) && (
            <option value={filter}>{filter}</option>
          )}
          {projects.map((p) => (
            <option key={p.name} value={p.name}>
              {p.label}
            </option>
          ))}
        </select>
        {filter !== 'all' && (
          <SidebarLink
            href={`/repo/${encodeURIComponent(filter)}`}
            icon={<Icon path={tablerStack2.path} />}
            label="Repo overview"
            onFollow={onFollow}
          />
        )}
        <select
          aria-label="Sort stopped worktrees"
          class={`${SIDEBAR_SELECT} mt-1`}
          onChange={(e: JSX.TargetedEvent<HTMLSelectElement>) =>
            onSort(e.currentTarget.value as Sort)
          }
          value={sortKey}
        >
          <option value="recent">Last commit</option>
          <option value="name">Name</option>
          <option value="created">Created</option>
        </select>
        <div class="my-1 h-px bg-zinc-200 dark:bg-white/10" />
        <SidebarToggle
          active={onlyDirty}
          activeClass="bg-signal-amber border-signal-amber text-white dark:text-zinc-950"
          icon={<Icon path={tablerCircle.path} />}
          label="Uncommitted changes"
          onClick={() => onDirty(!onlyDirty)}
        />
        <SidebarToggle
          active={onlyAhead}
          activeClass="bg-signal-green border-signal-green text-white dark:text-zinc-950"
          icon={<Icon path={tablerArrowUp.path} />}
          label="Ahead of base"
          onClick={() => onAhead(!onlyAhead)}
        />
        <div class="my-1 h-px bg-zinc-200 dark:bg-white/10" />
        <fieldset class="flex min-w-0 flex-col gap-1">
          <legend class="sr-only">Layout for all worktrees</legend>
          {(['list', 'grid'] as const).map((v) => (
            <label
              class={`${SIDEBAR_ITEM} cursor-pointer has-[input:focus-visible]:outline-2 has-[input:focus-visible]:outline-accent ${
                view === v ? 'border-accent bg-accent text-white' : SIDEBAR_IDLE
              }`}
              key={v}
            >
              <input
                checked={view === v}
                class="sr-only"
                name="worktree-layout"
                onChange={() => onView(v)}
                type="radio"
                value={v}
              />
              <Icon
                path={v === 'list' ? tablerMenu2.path : tablerLayoutGrid.path}
              />
              <span>{v === 'list' ? 'List' : 'Grid'}</span>
            </label>
          ))}
        </fieldset>
        <div class="my-1 h-px bg-zinc-200 dark:bg-white/10" />
        <button
          aria-label={dark ? 'Use light theme' : 'Use dark theme'}
          class={`${SIDEBAR_ITEM} ${SIDEBAR_IDLE}`}
          onClick={onTheme}
          type="button"
        >
          {dark ? (
            <Icon path={tablerSun.path} />
          ) : (
            <Icon filled path={tablerMoonFilled.path} />
          )}
          <span>{dark ? 'Light mode' : 'Dark mode'}</span>
        </button>
        <button
          class={`${SIDEBAR_ITEM} ${SIDEBAR_IDLE}`}
          id="jump-to-worktree"
          onClick={onJump}
          type="button"
        >
          <Icon path={tablerSearch.path} />
          <span class="flex-1">Jump to worktree</span>
          <kbd class="font-sans text-[10px] text-zinc-500 dark:text-zinc-400">
            {shortcut}
          </kbd>
        </button>
        <nav aria-label="Workspace" class="flex flex-col gap-1">
          {PAGES.map(([href, label, path]) => (
            <SidebarLink
              href={href}
              icon={<Icon path={path} />}
              key={href}
              label={label}
              onFollow={onFollow}
            />
          ))}
        </nav>
      </div>
      {children}
    </aside>
  );
}
